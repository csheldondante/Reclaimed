// ---- traits: the prelude every trait kernel shares (LW1; src/api/contracts/traits.ts) ---------------------------------
// Appended after common.wgsl. Owns the bindings; a module (the game's rule) adds `fn module_main(u: u32)` and the
// system wraps it in a 64-wide entry, one thread an agent slot. Storage buffers: units, events, traits (3 of 8).
//
// A unit (units.wgsl, agents.ts UNIT_V = 5 vec4):
//   a: x, y, z (feet), info (u32: group 0-7 | alive 8 | kind 9-11 | state 12-14 | alight 15 | generation 16-31)
//   b: vx, vy, vz, stride phase / stun     c: hp, swing cooldown, fire left, heading
//   d: hurt flash, state time, time under water, wander heading
//   e: CAPS (u32: what the step honours), LOOK (u32: what the draw shows), max hp, 0
// Its trait record (here, TRAIT_V = 3 vec4<u32>):
//   r0: x the trait word (intrinsic bits 0-15, statuses 16-23), y source (the group that laid the last status),
//       z the occupant (generation + 1; 0 none), w 0
//   r1, r2: each status's expiry tick (statuses 0-3, 4-7); PERM: for ever
const UNIT_V: u32 = 5u;
const TRAIT_V: u32 = 3u;
const PERM: u32 = 0xffffffffu;
const STATUS_BIT: u32 = 16u;
// statuses (contracts/traits.ts STATUSES)
const S_BURNING: u32 = 0u;
const S_FRIGHTENED: u32 = 1u;
const S_HEALING: u32 = 2u;
const S_RAISED: u32 = 3u;
const S_PETRIFIED: u32 = 4u;
const S_CORPSE: u32 = 5u;
const S_HARMED: u32 = 6u;
// effect ops (system.ts packs them)
const OP_HEAL: u32 = 1u;
const OP_RAISE: u32 = 2u;
const OP_DAMAGE: u32 = 3u;
const OP_STATUS: u32 = 4u;
// the units' states (units.wgsl)
const UST_TUMBLE: u32 = 3u;
// events (agents.ts sync): the agents' own, and the trait system's
const TEV_DEATH: u32 = 3u;
const TEV_DECAYED: u32 = 6u;
const TEV_RAISED: u32 = 7u;
// a death by an effect (agents.ts: 'effect')
const BY_EFFECT: u32 = 0xfffffffbu;
// CAPS: the engine's verbs (units.wgsl reads them)
const CAP_NO_BURN: u32 = 1u;
const CAP_NO_DROWN: u32 = 2u;
const CAP_ROOTED: u32 = 4u;
const CAP_FLEE: u32 = 8u;

@group(0) @binding(7) var<storage, read_write> units: array<vec4<f32>>;
@group(0) @binding(13) var<storage, read_write> events: array<atomic<u32>>;
@group(0) @binding(40) var<storage, read_write> traits: array<vec4<u32>>;

/** An effect this tick: a (x, y, z or -1e9 any height, radius), b (amount, lasts s, 0, 1 a burst), c (op, group, type or status, id) */
struct Effect { a: vec4<f32>, b: vec4<f32>, c: vec4<u32> };
struct TraitParams {
  // x slots, y effects, z the events' capacity, w ticks a corpse lasts
  n: vec4<u32>,
  // x trait assignments this tick
  m: vec4<u32>,
  // per kind (8): the traits it starts with
  kindSeed: array<vec4<u32>, 2>,
  // the game's assignments (traits.assign): slot, generation, the intrinsic traits it carries from now on
  assigns: array<vec4<u32>, 64>,
  effects: array<Effect, 32>,
};
@group(0) @binding(41) var<uniform> TP: TraitParams;
// the module's own table (16 vec4; its rows as the module says)
@group(0) @binding(42) var<uniform> MT: array<vec4<u32>, 16>;

fn mtf(i: u32) -> vec4<f32> { return bitcast<vec4<f32>>(MT[i]); }

// ---- the unit ----
fn uInfo(u: u32) -> u32 { return bitcast<u32>(units[u * UNIT_V].w); }
fn uAlive(u: u32) -> bool { return ((uInfo(u) >> 8u) & 1u) != 0u; }
fn uKind(u: u32) -> u32 { return (uInfo(u) >> 9u) & 7u; }
fn uGroup(u: u32) -> u32 { return uInfo(u) & 0xffu; }
fn uGen(u: u32) -> u32 { return uInfo(u) >> 16u; }
fn uId(u: u32) -> u32 { return uGen(u) * 8192u + u; }
fn uPos(u: u32) -> vec3<f32> { return units[u * UNIT_V].xyz; }
fn uHp(u: u32) -> f32 { return units[u * UNIT_V + 2u].x; }
fn uMaxHp(u: u32) -> f32 { return units[u * UNIT_V + 4u].z; }
fn setHp(u: u32, hp: f32) {
  var c = units[u * UNIT_V + 2u];
  c.x = hp;
  units[u * UNIT_V + 2u] = c;
}
/** a hit's white flash (s) */
fn uFlash(u: u32, s: f32) {
  var d = units[u * UNIT_V + 3u];
  d.x = max(d.x, s);
  units[u * UNIT_V + 3u] = d;
}
fn setCaps(u: u32, caps: u32) {
  var e = units[u * UNIT_V + 4u];
  e.x = bitcast<f32>(caps);
  units[u * UNIT_V + 4u] = e;
}
fn setLook(u: u32, look: u32) {
  var e = units[u * UNIT_V + 4u];
  e.y = bitcast<f32>(look);
  units[u * UNIT_V + 4u] = e;
}

// ---- the traits ----
fn tWord(u: u32) -> u32 { return traits[u * TRAIT_V].x; }
fn tSetWord(u: u32, w: u32) {
  var r = traits[u * TRAIT_V];
  r.x = w;
  traits[u * TRAIT_V] = r;
}
fn hasAll(w: u32, mask: u32) -> bool { return (w & mask) == mask; }
fn hasAny(w: u32, mask: u32) -> bool { return (w & mask) != 0u; }
fn statusBit(s: u32) -> u32 { return 1u << (STATUS_BIT + s); }
/** the record's slot of status s's expiry */
fn expiryAt(u: u32, s: u32) -> u32 { return traits[u * TRAIT_V + 1u + s / 4u][s % 4u]; }
/** status s on for `secs` s from now (≤ 0: for ever), laid by `source`; a longer one already on is kept */
fn statusOn(u: u32, s: u32, secs: f32, source: u32) {
  var r = traits[u * TRAIT_V];
  let ex = select(G.tick + max(1u, u32(secs / max(G.dt, 1e-4))), PERM, secs <= 0.0);
  let i = u * TRAIT_V + 1u + s / 4u;
  var t = traits[i];
  let had = (r.x & statusBit(s)) != 0u;
  t[s % 4u] = select(ex, max(ex, t[s % 4u]), had);
  traits[i] = t;
  r.x = r.x | statusBit(s);
  r.y = source;
  traits[u * TRAIT_V] = r;
}
fn statusOff(u: u32, s: u32) { tSetWord(u, tWord(u) & ~statusBit(s)); }

// ---- the effects ----
fn effOp(e: u32) -> u32 { return TP.effects[e].c.x; }
/** effect e reaches a unit whose feet are at p (its body ~1.4 tall) */
fn effCovers(e: u32, p: vec3<f32>) -> bool {
  let a = TP.effects[e].a;
  if (length(p.xy - a.xy) > a.w) { return false; }
  return a.z < -1e8 || abs(p.z + 0.7 - a.z) <= a.w + 0.7;
}
/** what an effect gives this tick: its amount once (a burst), or its amount a second × dt (a field) */
fn effAmount(e: u32) -> f32 {
  let b = TP.effects[e].b;
  return select(b.x * G.dt, b.x, b.w > 0.5);
}

fn emit(kind: u32, id: u32, other: u32, amount: f32, p: vec3<f32>) {
  let e = atomicAdd(&events[0], 1u);
  if (e >= TP.n.z) { return; }
  let o = 4u + e * 8u;
  atomicStore(&events[o], kind);
  atomicStore(&events[o + 1u], id);
  atomicStore(&events[o + 2u], other);
  atomicStore(&events[o + 3u], bitcast<u32>(amount));
  atomicStore(&events[o + 4u], bitcast<u32>(p.x));
  atomicStore(&events[o + 5u], bitcast<u32>(p.y));
  atomicStore(&events[o + 6u], bitcast<u32>(p.z));
}
