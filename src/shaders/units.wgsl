// ---- agents: the units (round 52, docs/AGENTS.md) ------------------------------
// One thread a unit (appended to agents.wgsl, whose surfaces, fields and
// params it reads). Per tick a unit:
//  * takes the game's hits (a circle or a cone: damage, a push along a
//    direction or outward, maybe set alight), reporting hurt and death; a
//    push past TUMBLE_PUSH throws it: it tumbles;
//  * feels the world's wind (windAt: storms, gusts, blows and blasts,
//    wakes, cyclones) past a calm, ÷ its mass: on the ground it drifts, and
//    past its feet's grip it's thrown; in the air it's carried along;
//    sheltered under a roof, nothing;
//  * held (the game carries it: a lich, a gorilla) sits where the game puts
//    it; let go, or launched, it tumbles with the velocity given;
//  * tumbling, flies and falls, bounces off the ground and the walls (a hard
//    landing or a slam hurts), knocks over the units it runs into (sharing
//    its momentum by mass: per-column shoves), and gets up once it settles;
//  * burns (damage over time, running about) once alight: from the game's
//    hits, the fire field, lava or hot ground, an ember landing on it, or a
//    burning unit next to it; water puts it out; lava hurts besides;
//  * wades, slowed by the water's depth, and drowns in water over its height;
//  * behaves as its kind says: a worker (notice 0) follows its group's field;
//    a hostile kind wanders until its field says a target is within notice,
//    closes in down the field, and swings when one is in reach (a swing event
//    the game turns into damage on its unit);
//  * walking, is pushed apart by the crowd, never crosses a missing link or
//    leaves its field's place, rides its surface's height.
// unitDraw then writes each unit's voxels: its kind's model, or the default
// figure (legs, torso, head), facing its way, rolled along its throw while
// tumbling; alight it flickers and a hit flashes it (the physics voxel's
// heat glow, render.wgsl fsBody).
//
// A unit, five vec4<f32> (UNIT_V; agents.ts UNIT_V, src/traits/prelude.wgsl mirror it):
//   a: x, y, z (its feet), info (u32 bits): group 0-7 | alive 8 | kind 9-11 |
//      state 12-14 | alight 15 | generation 16-31 (its id: gen * 8192 + slot)
//   b: vx, vy, vz, stride phase (tumbling: its stun, s: how much longer
//      than GETUP it stays down once settled)
//   c: hp, swing cooldown (s), fire left (s), heading (rad)
//   d: hurt flash (s), state time (s), time under water (s), wander heading
//      (rad; tumbling: how far it has rolled)
//   e: (LW1, the trait system's words — 0 without it) CAPS, the verbs the step
//      honours (u32 bits: CAP_*); LOOK, what the draw shows (u32: LOOK_*); the
//      max hp it was spawned with; (round 128i) the road ride's steer
//      (roadride.wgsl: 0 none, -1 stand, -2 on a trip, else heading + STEER_BIAS — read by
//      the walking step below). The step only reads them: the trait
//      modules derive them from the traits each tick (src/traits).
//   f: (round 128o, DA-B2a) x the arrival latch (u32 bits: the field it has arrived on + 1; 0 none: `arrived`
//      events), (round 128p, notice.wgsl) y its target (u32 bits: a target code), z how near the nearest hostile
//      hunting it is (inf: none — the hunt's candidates), w its side of the wall + 1 (0: not told; notice.wgsl)
@group(0) @binding(7) var<storage, read_write> units: array<vec4<f32>>;
const UNIT_V: u32 = 6u;
// CAPS (src/traits/prelude.wgsl, contracts/traits.ts): never set alight (nor
// hurt by lava); never drowns; rooted (no walking, pushes, throws: a statue);
// flees its field (walks up it, not down)
const CAP_NO_BURN: u32 = 1u;
const CAP_NO_DROWN: u32 = 2u;
const CAP_ROOTED: u32 = 4u;
const CAP_FLEE: u32 = 8u;
// LOOK: bits 0-7 the torso's material (0: as its kind), 8-15 the head's, 16-23
// a halo's material, then a halo over its head (glowing), sparks about it, and
// (not alive) its body lying where it fell
const LOOK_HALO: u32 = 0x1000000u;
const LOOK_SPARKS: u32 = 0x2000000u;
const LOOK_CORPSE: u32 = 0x4000000u;
// units per column, two halves: the tick writes one (tick % 2) and reads the
// other, the last tick's count
@group(0) @binding(8) var<storage, read_write> occ: array<atomic<u32>>;
// events out: [0] the count (may pass the capacity: the CPU reports what
// didn't fit), then 8 u32 each from index 4: kind, unit id, other (a target,
// a hit id), amount (f32 bits), x, y, z (f32 bits), 0
@group(0) @binding(13) var<storage, read_write> events: array<atomic<u32>>;
@group(0) @binding(14) var<storage, read> fire: array<f32>;
// lava (sim/lava.ts): x depth, y temperature, z the ground's heat (°C)
// (binding 15 is the wind texture: common.wgsl windTex, read by windAt)
@group(0) @binding(25) var<storage, read> lava: array<vec4<f32>>;
// shoves per column, two halves as occ: what tumbling units carried through
// it (x, y momentum and mass, ×SHOVE_FIX) and how many burning units (w)
// (FC12 stage 2: the shoves live in `occ`'s words now — five a column a half: the count, then the shove's four, i32
// as u32 bits — so the step's eighth storage binding is free for `mail`)
fn occAt(hc: u32) -> u32 { return hc * 5u; }
fn shoveAt(hc: u32, k: u32) -> u32 { return hc * 5u + 1u + k; }
fn shoveLoad(hc: u32, k: u32) -> f32 { return f32(bitcast<i32>(atomicLoad(&occ[shoveAt(hc, k)]))); }
fn shoveAdd(hc: u32, k: u32, v: i32) { atomicAdd(&occ[shoveAt(hc, k)], bitcast<u32>(v)); }
fn occClearAt(hc: u32) { for (var k = 0u; k < 5u; k++) { atomicStore(&occ[hc * 5u + k], 0u); } }
// embers landed (particles.wgsl): x the tick it landed
@group(0) @binding(19) var sparkTex: texture_2d<f32>;
// (unitDraw; bindings past common.wgsl's) the draw: voxels in the body
// format, two vec4<u32> each; their count (indirect args, [1] instances);
// the kinds' models: per voxel x, y, z (cells from the feet, f32) and the
// material (u32 bits)
@group(0) @binding(9) var<storage, read_write> inst: array<vec4<u32>>;
@group(0) @binding(22) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(23) var<storage, read> models: array<vec4<f32>>;
// per kind (8): x first voxel in `models`, y its count (0: the default
// figure), z the voxel's edge (sixteenths of a cell), w unused
@group(0) @binding(24) var<uniform> kindModels: array<vec4<u32>, 8>;
// what each unit carries (round 63; agents.ts carry), by slot: x its
// material (0: nothing), y its edge (cells). Held over its head, dropped
// (the CPU's doing) when it's knocked down.
@group(0) @binding(26) var<storage, read> carried: array<vec4<f32>>;
// items in flight (agents.ts throwItem), two vec4 each: where (w its
// material, 0: none), then x its edge, y its spin (rad), zw the axis it spins
// about (level)
@group(0) @binding(27) var<storage, read> flying: array<vec4<f32>>;
const MAX_FLY: u32 = 128u;

const ST_WANDER: u32 = 0u;
const ST_CHASE: u32 = 1u;
const ST_SWING: u32 = 2u;
const ST_TUMBLE: u32 = 3u;
const ST_HELD: u32 = 4u;
const EV_SWING: u32 = 1u;
const EV_HURT: u32 = 2u;
const EV_DEATH: u32 = 3u;
const EV_ALIGHT: u32 = 4u;
// a swing begins: the target, and how long (s) until the blow lands (a parry's window)
const EV_WINDUP: u32 = 5u;
// (round 128o, DA-B2a) it came within its field's arrival radius (AgentParams.arrive): other the field, amount the
// field's distance at its feet; once until it's past the leaving radius or on another field (unit word f.x)
const EV_ARRIVED: u32 = 8u;
// (round 128o, DA-A6) an arrival at a ride's goal: its `other` is RIDE_ARRIVED + the unit's group (agents.ts)
const RIDE_ARRIVED: u32 = 256u;
const BY_FIRE: u32 = 0xffffffffu;
const BY_WATER: u32 = 0xfffffffeu;
const BY_IMPACT: u32 = 0xfffffffdu;
const BY_LAVA: u32 = 0xfffffffcu;
const MAX_SLOTS: u32 = 8192u;
// a swing: the blow lands this far in (s), the swing ends at SWING_END
const SWING_HIT: f32 = 0.3;
const SWING_END: f32 = 0.6;
const BURN_TIME: f32 = 6.0;
const BURN_DPS: f32 = 2.0;
const LAVA_DPS: f32 = 8.0;
// lava this hot sets alight, and ground this hot (°C)
const LAVA_LIGHT: f32 = 750.0;
const HOT_GROUND: f32 = 300.0;
const DROWN_TIME: f32 = 3.0;
// a push past this (cells/s, after the mass) throws it
const TUMBLE_PUSH: f32 = 5.0;
// (solver step 1, AR9) GRAVITY (was 20.0): the world's × the tuning's units.gravity (agents/agents.ts unitsG())
fn unitsG() -> f32 { return worldG() * G.tune.unitsGravity; }
// tumbling: what's left of a landing's speed, a slam's; the ground's grip
const BOUNCE: f32 = 0.35;
const SLAM_BOUNCE: f32 = 0.35;
// (round 128o, DA-B22) the most a unit moves in one sub-move (cells): the walk's links and the tumble's walls are
// checked a column at a time, so a move is taken in as many sub-moves as keep each within half a cell — the step's dt
// spans several ticks at fast-forward (agents.ts stepPlan). The forces and the mind run once a step.
const SUB_MOVE: f32 = 0.5;
fn subMoves(d: f32) -> u32 { return max(1u, u32(ceil(d / SUB_MOVE))); }
// (and the most a tumbling unit falls in one: under floorUnder's reach above the body, 0.3, so a landing is found)
const SUB_FALL: f32 = 0.25;
const ROLL_GRIP: f32 = 3.0;
const LAND_SKID: f32 = 0.6;
// a landing (falling speed) or slam (into a wall) harder than this hurts, per cell/s past it
const HURT_SPEED: f32 = 10.0;
const HURT_PER: f32 = 1.0;
// the wind (round 57): calmer than WIND_CALM (cells/s) it does nothing; past
// it, a force of WIND_K × the excess² ÷ mass (cells/s²) along it. On the
// ground the feet hold up to WIND_GRIP of it (it drifts), past that it's
// thrown (hopping by WIND_HOP of the excess); in the air the force carries it
// until it moves as fast as the wind. A worker (mass 1) is thrown past 14
// cells/s, an ogre (3) past ~18.4.
const WIND_CALM: f32 = 8.0;
const WIND_K: f32 = 0.5;
const WIND_GRIP: f32 = 18.0;
const WIND_HOP: f32 = 0.35;
// settled this long (s), it gets up
const GETUP: f32 = 0.6;
// a shove: the momentum carried through a column, fixed point
const SHOVE_FIX: f32 = 100.0;
// knocked over when what runs into it would move it this fast (cells/s)
const KNOCK_SPEED: f32 = 2.5;
const MAX_INST: u32 = 65536u;
/** (round 128i) roadride.wgsl STEER_BIAS; (round 128o) RIDE_TRIP: on a trip, placed by the ride */
const STEER_BIAS: f32 = 10.0;
const RIDE_TRIP: f32 = -2.0;

fn unitInfo(a: vec4<f32>) -> u32 { return bitcast<u32>(a.w); }
fn unitId(u: u32, info: u32) -> u32 { return (info >> 16u) * MAX_SLOTS + u; }

fn emit(kind: u32, id: u32, other: u32, amount: f32, p: vec3<f32>) {
  // (round 128o, DA-B2: a ring — [0] events made, [2] how far the CPU has read (agents.ts sync); an event the ring
  // has no room for is not written: its slot keeps another's tag, and the CPU counts it lost)
  let e = atomicAdd(&events[0], 1u);
  if (e - atomicLoad(&events[2]) >= AP.n2.z) { return; }
  let o = 4u + (e % AP.n2.z) * 8u;
  atomicStore(&events[o + 7u], e);
  atomicStore(&events[o], kind);
  atomicStore(&events[o + 1u], id);
  atomicStore(&events[o + 2u], other);
  atomicStore(&events[o + 3u], bitcast<u32>(amount));
  atomicStore(&events[o + 4u], bitcast<u32>(p.x));
  atomicStore(&events[o + 5u], bitcast<u32>(p.y));
  atomicStore(&events[o + 6u], bitcast<u32>(p.z));
}

// ---- (round 104, simscale — agents.ts scope) -------------------------------------------------------------------
// The fields, the surfaces and the occupancy are kept only over the columns round the units and their seeds. A column
// come into that scope starts over: every field's page there let go (U2 round 7: the pool's), its chunk marked for the
// fields round it, nobody there (what it held from before is stale).
@compute @workgroup_size(8, 8)
fn scopeIn(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let cols = G.mapW * G.mapH;
  // (a chunk's pages, once: its first column's thread)
  if ((id.x % COLS_PAGE) == 0u && (id.y % COLS_PAGE) == 0u) {
    let slot = chunkOfCol(id.x, id.y);
    ppDropSlot(slot);
    ppMarkSlot(slot);
  }
  // (?jfa=1: the obstacles JFA made again — a chunk came in)
  atomicStore(&jfa[2], 1u);
  for (var h = 0u; h < 2u; h++) { occClearAt(h * cols + i); }
}

/** occClear over the scope's columns (8 x 8 a workgroup: the tile list's shape) */
@compute @workgroup_size(8, 8)
fn occClearCols(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let c = colIdx(id.x, id.y);
  let cols = G.mapW * G.mapH;
  let wr = AP.n.w % 2u;
  occClearAt(wr * cols + c);
}

// the live units' box (columns: min x, min y, max x, max y), read back now and then
@group(0) @binding(28) var<storage, read_write> ubox: array<atomic<u32>, 4>;
@compute @workgroup_size(64)
fn unitBox(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  let a = units[u * UNIT_V];
  if (((unitInfo(a) >> 8u) & 1u) == 0u) { return; }
  let c = cellAt(a.xy);
  let x = u32(clamp(c.x, 0, i32(G.mapW) - 1));
  let y = u32(clamp(c.y, 0, i32(G.mapH) - 1));
  atomicMin(&ubox[0], x);
  atomicMin(&ubox[1], y);
  atomicMax(&ubox[2], x);
  atomicMax(&ubox[3], y);
}

@compute @workgroup_size(64)
fn occClear(@builtin(global_invocation_id) id: vec3<u32>) {
  let cols = G.mapW * G.mapH;
  if (id.x >= cols) { return; }
  let wr = AP.n.w % 2u;
  occClearAt(wr * cols + id.x);
}

/** The way down field `fld` from surface s of cell c, at pos (0 at a seed, or none). */
fn downField(fld: u32, s: u32, c: vec2<i32>, pos: vec2<f32>, here: f32) -> vec2<f32> {
  var g = vec2<f32>(0.0);
  var bestD = here;
  var bestDir = vec2<f32>(0.0);
  for (var d = 0u; d < NDIR; d++) {
    let l = navLink(s, d);
    if (l == 0u) { continue; }
    let t = colIdxI(nbr(c, d)) * NAV_K + l - 1u;
    // (round 128d, FT-20: not into deep water from out of it — agents.wgsl DEEP; the relax reads it the same way)
    if (navWater(t) > DEEP && navWater(s) <= DEEP) { continue; }
    let dn = fieldDist(fld, t);
    if (dn >= FAR) { continue; }
    let toward = normalize(cellPos(nbr(c, d)) - pos);
    g += toward * max(here - dn, 0.0);
    if (dn < bestD) { bestD = dn; bestDir = toward; }
  }
  // (the gradient, unless it points nowhere useful: then the best step)
  return select(bestDir, normalize(g), length(g) > 0.2 && dot(normalize(g), bestDir) > 0.3);
}

/**
 * Open air at height z in column i: within a surface's headroom (the air
 * over it), or above the top one. Below the lowest surface, or in a gap too
 * low to be a surface, it's solid. A column with no surfaces is all air.
 */
fn airAt(i: u32, z: f32) -> bool {
  for (var k = 0u; k < NAV_K; k++) {
    let s = i * NAV_K + k;
    let zk = navZ(s);
    if (zk < 0.0) { return k == 0u; }
    if (z < zk - 0.05) { return false; }
    let h = navHead(s);
    // (headroom is capped at 31: the top surface's sky, or a tall hall)
    let last = k + 1u >= NAV_K || navZ(s + 1u) < 0.0;
    if (z <= zk + h || (h >= 30.9 && (last || z < navZ(s + 1u)))) { return true; }
  }
  return false;
}

/** Nothing solid between a and b: open air at points every half cell along it (the ends excluded). */
fn sightClear(a: vec3<f32>, b: vec3<f32>) -> bool {
  let n = u32(clamp(ceil(length(b - a) / 0.5), 1.0, 16.0));
  for (var j = 1u; j < n; j++) {
    let q = mix(a, b, f32(j) / f32(n));
    if (!airAt(colIdxI(clampCell(cellAt(q.xy))), q.z)) { return false; }
  }
  return true;
}

/**
 * How far target t is from a unit's body (at pos, `height` tall): between
 * two vertical capsules, the target's from its feet up its height, radius
 * its radius; and the nearest point of the target, for sight. (round 59: no
 * height band. Reach is the arms' reach in 3D, sight is the geometry's.)
 */
fn targetGap(t: u32, pos: vec3<f32>, height: f32) -> vec4<f32> {
  let tp = AP.targets[t];
  let th = AP.targetH[t / 4u][t % 4u];
  let off = tp.xy - pos.xy;
  let hd = max(length(off) - tp.w, 0.0);
  // the agent's body, feet to a little over its head
  let lo = pos.z;
  let hi = pos.z + height + 0.3;
  let vg = max(max(tp.z - hi, lo - (tp.z + th)), 0.0);
  // the target's nearest point: its edge toward the agent, at the height nearest the chest
  let chest = pos.z + height * 0.6;
  let toward = select(vec2<f32>(0.0), off / max(length(off), 1e-3) * min(tp.w, length(off)), length(off) > 1e-3);
  // (at least half a cell up it: one standing a step higher isn't hidden by the step's edge)
  let near = vec3<f32>(tp.xy - toward, clamp(chest, tp.z + min(0.5, th * 0.5), tp.z + th));
  return vec4<f32>(near, sqrt(hd * hd + vg * vg));
}

/** The floor under a body at height z in column i, or -FAR where z is inside the ground there (a wall). */
fn floorUnder(i: u32, z: f32) -> f32 {
  let k = surfaceAt(i, z + 0.3);
  if (k >= NAV_K) { return -FAR; }
  let s = i * NAV_K + k;
  // (under an overhang: above the air over that surface is solid again)
  if (k > 0u && z > navZ(s) + navHead(s)) { return -FAR; }
  return navZ(s);
}

@compute @workgroup_size(64)
fn unitStep(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  var a = units[u * UNIT_V];
  var b = units[u * UNIT_V + 1u];
  var cc = units[u * UNIT_V + 2u];
  var dd = units[u * UNIT_V + 3u];
  let caps = bitcast<u32>(units[u * UNIT_V + 4u].x);
  var latch = bitcast<u32>(units[u * UNIT_V + 5u].x);
  // (round 128i, V128-14) the road ride's steer (roadride.wgsl, written after the last tick's step): 0 its field, < 0
  // stand, else a heading + STEER_BIAS
  var steer = units[u * UNIT_V + 4u].w;
  let noBurn = (caps & CAP_NO_BURN) != 0u;
  let rooted = (caps & CAP_ROOTED) != 0u;
  var info = unitInfo(a);
  if (((info >> 8u) & 1u) == 0u) { return; }
  let uid = unitId(u, info);
  var grp = info & 0xffu;
  // (moved to another group by the game: agents.regroup)
  for (var e = 0u; e < AP.n3.z; e++) {
    let rg = AP.regroups[e / 4u][e % 4u];
    if ((rg & 0xffffu) == u) { grp = rg >> 16u; }
  }
  // (round 128p, DA-B22 (c)(4): made another kind where it stands — agents.ts rekind; its hp below)
  var rekindHp = -1.0;
  for (var e = 0u; e < u32(AP.step.y); e++) {
    let rk = AP.rekinds[e];
    if (rk.x != u) { continue; }
    info = (info & ~(7u << 9u)) | ((rk.y & 7u) << 9u);
    if (rk.w == 1u) { rekindHp = bitcast<f32>(rk.z); }
  }
  // (round 128o, DA-B22: a steer is its group's ride's — a unit moved to another group lets it go, here and in its
  // record, so no step before the ride's next run reads the old group's: a STAND there told an arrival at the old
  // goal for the new group, once the ride ran once a frame — fortressallbuilt's builders "working" at the stores)
  if (grp != (info & 0xffu) && steer != 0.0) {
    steer = 0.0;
    var e4 = units[u * UNIT_V + 4u];
    e4.w = 0.0;
    units[u * UNIT_V + 4u] = e4;
  }
  let kind = AP.kinds[(info >> 9u) & 7u];
  var state = (info >> 12u) & 7u;
  var alight = ((info >> 15u) & 1u) != 0u;
  let height = kind.a.x;
  let mass = max(kind.a.y, 0.1);
  var fld = AP.groupField[grp / 4u][grp % 4u];
  // (U2 round 6, §9c/§9d) in an order group with a formation: its rank's entry (orders.wgsl formSlots, before the step)
  // — steer straight to a target (its slot, its post, a waypoint on its route), or follow a field of the group's (a
  // man order's run), or the group's own as ever
  let ogw = atomicLoad(&mail[MAIL_AIM + u * AIM_W + 11u]);
  var rankMode = 0u;
  var rankAt = vec3<f32>(0.0);
  var rankLeave = false;
  // (U2 round 7: a member walks its order's field — the order record's word 6, FIELD_NONE when it stands; man walks
  // its rank's run fields)
  let og = ogGroup(ogw);
  if (og != 0u && og <= ORDER_GROUPS) {
    let gk = atomicLoad(&mail[MAIL_GRP + (og - 1u) * GROUP_W]);
    fld = select(atomicLoad(&mail[MAIL_GRP + (og - 1u) * GROUP_W + 6u]), FIELD_NONE, gk < 2u || gk == 6u);
  }
  if (og != 0u && og <= ORDER_GROUPS && ogRank(ogw) < RANKS) {
    let ro = rankO(og - 1u, ogRank(ogw));
    let m = atomicLoad(&mail[ro + 3u]);
    rankMode = m & 0xffu;
    rankLeave = (m & RANK_LEAVE) != 0u;
    if (rankMode == RANK_FIELD) { fld = atomicLoad(&mail[ro + 7u]); }
    rankAt = mailV3(ro);
  }
  // (a march that leaves: past the window's edge it drops out — no death; the CPU frees the slot on EV_LEFT)
  if (rankLeave) {
    let ec = cellAt(a.xy);
    if (ec.x < 2 || ec.y < 2 || ec.x >= i32(G.mapW) - 2 || ec.y >= i32(G.mapH) - 2) {
      emit(EV_LEFT, uid, og - 1u, 0.0, a.xyz);
      units[u * UNIT_V] = vec4<f32>(a.xyz, bitcast<f32>(info & ~(1u << 8u)));
      return;
    }
  }
  let N = ns();
  // (round 128o, DA-B22: the step's own dt — a tick's, or at fast-forward the ticks since the last step: agents.ts)
  let dt = AP.step.x;
  let cols = G.mapW * G.mapH;
  let rd = ((AP.n.w + 1u) % 2u) * cols;
  let wr = (AP.n.w % 2u) * cols;
  var pos = a.xyz;
  var vel = b.xyz;
  var hp = select(cc.x, rekindHp, rekindHp >= 0.0);
  var cool = max(cc.y - dt, 0.0);
  var burn = cc.z;
  var heading = cc.w;
  var flash = max(dd.x - dt, 0.0);
  var stT = dd.y + dt;
  var under = dd.z;
  var wanderH = dd.w;
  var push = vec2<f32>(0.0);
  // the hits' lift (cells/s, after the mass) and stun (s); 1: a hit gave a lift
  var lift = 0.0;
  var lifted = false;
  var stun = select(0.0, b.w, state == ST_TUMBLE);
  var stunHit = 0.0;
  var killedBy = 0u;
  var dead = false;
  if (noBurn) { alight = false; burn = 0.0; }

  // the game's hits
  for (var h = 0u; h < AP.n2.x; h++) {
    let hit = AP.hits[h];
    var off = pos + vec3<f32>(0.0, 0.0, height * 0.5) - hit.a.xyz;
    var r = length(off.xy);
    if (hit.a.w < 0.0) {
      // (round 128p, DA-B22 (c)(4): a hit on one unit, wherever it stands — its id in x's bits, radius −1: a blow
      // struck at a unit the CPU doesn't read the position of; pushed along its direction)
      if (bitcast<u32>(hit.a.x) != uid) { continue; }
      off = vec3<f32>(0.0);
      r = 0.0;
    } else {
      // (z below -1e8: any height)
      if (r > hit.a.w + 0.3 || (hit.a.z > -1e8 && abs(off.z) > hit.a.w + height)) { continue; }
      if (hit.b.z > -1.5 && r > 0.3 && dot(off.xy / r, hit.d.xy) < hit.b.z) { continue; }
    }
    // (c.z: bit 0 fire, bits 1-16 the groups it spares)
    let hz = u32(hit.c.z + 0.5);
    if (((hz >> (1u + grp)) & 1u) != 0u) { continue; }
    let hid = u32(hit.c.w);
    if (hit.b.w > 0.0) {
      hp -= hit.b.w;
      flash = 0.15;
      emit(EV_HURT, uid, hid, hit.b.w, pos);
      if (hp <= 0.0 && !dead) { dead = true; killedBy = hid; }
    }
    let away = select(hit.b.xy, off.xy / max(r, 0.01), hit.c.y > 0.5);
    push += away * hit.c.x / mass;
    if (hit.d.z != 0.0) { lift += hit.d.z / mass; lifted = true; }
    stunHit = max(stunHit, hit.d.w);
    if ((hz & 1u) != 0u && !alight && !noBurn) { alight = true; burn = BURN_TIME; emit(EV_ALIGHT, uid, hid, 0.0, pos); }
  }

  // (FC12 stage 2) the arrows landed on it since its last step (arrowStep's sum: two in one tick both count), taken and
  // cleared by its own thread — no other unit's thread writes its hp
  let accO = MAIL_ACC + u * 2u;
  let landed = atomicExchange(&mail[accO], 0u);
  if (landed > 0u) {
    let shot = atomicExchange(&mail[accO + 1u], 0u);
    let dmg = f32(landed) / 256.0;
    hp -= dmg;
    flash = 0.15;
    emit(EV_HURT, uid, BY_UNIT | (shot - 1u), dmg, pos);
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_UNIT | (shot - 1u); }
    // (U2 DA-B32: struck with no target of its own, a unit that can fight turns on who struck it — its own row's word,
    // told as notice tells it; was the CPU's notice.aim)
    let fights = AP.kinds[(info >> 9u) & 7u].b.x > 0.0 || bitcast<f32>(AP.kinds[(info >> 9u) & 7u].c.w) > 0.0;
    var r5 = units[u * UNIT_V + 5u];
    if (fights && bitcast<u32>(r5.y) == 0u && shot != 0u) {
      r5.y = bitcast<f32>(shot);
      units[u * UNIT_V + 5u] = r5;
      emit(EV_NOTICED_U, uid, shot, 0.0, pos);
      // (it knows who struck it: told, not only noticed — hunted where it is, seen or not)
      atomicStore(&mail[MAIL_AIM + u * AIM_W + 3u], shot);
      atomicStore(&mail[MAIL_AIM + u * AIM_W + 7u], AIM_TOLD);
    }
  }

  // held by the game, or launched: holds and launches name its slot
  var held = false;
  for (var e = 0u; e < AP.n3.x; e++) {
    let hd = AP.holds[e];
    if (u32(hd.w) != u) { continue; }
    held = true;
    vel = (hd.xyz - pos) / max(dt, 1e-3);
    pos = hd.xyz;
  }
  if (held) { state = ST_HELD; stT = 0.0; } else if (state == ST_HELD) { state = ST_TUMBLE; stT = 0.0; }
  for (var e = 0u; e < AP.n3.y; e++) {
    let ln = AP.launches[e];
    // (w: its slot | its stun in hundredths of a second << 13)
    let lw = u32(ln.w);
    if ((lw & 8191u) != u) { continue; }
    vel = ln.xyz;
    if (state != ST_TUMBLE) { stun = 0.0; }
    stun = max(stun, f32(lw >> 13u) / 100.0);
    state = ST_TUMBLE;
    stT = 0.0;
  }
  // (rooted — petrified: a statue — nothing moves it but the game's hand)
  if (rooted) { push = vec2<f32>(0.0); lift = 0.0; lifted = false; stunHit = 0.0; }
  // thrown by a hit: pushed past TUMBLE_PUSH, or lifted (then the lift is
  // its upward speed; else it hops by a share of the push)
  if ((length(push) > TUMBLE_PUSH || lift > 0.0) && state != ST_HELD) {
    if (state != ST_TUMBLE) { stun = 0.0; }
    vel = vec3<f32>(vel.xy + push, max(vel.z, 0.0) + select(length(push) * 0.35, lift, lifted));
    push = vec2<f32>(0.0);
    state = ST_TUMBLE;
    stT = 0.0;
  }
  // stunned: down for that much longer once it settles (not thrown: where it
  // stands, upright)
  if (stunHit > 0.0 && state != ST_HELD) {
    if (state != ST_TUMBLE) { stun = 0.0; wanderH = 0.0; vel = vec3<f32>(0.0); push = vec2<f32>(0.0); state = ST_TUMBLE; stT = 0.0; }
    stun = max(stun, stunHit);
  }

  let c = clampCell(cellAt(pos.xy));
  let i = colIdxI(c);
  let k = surfaceAt(i, pos.z + 0.5);
  var floorZ = select(pos.z, navZ(i * NAV_K + min(k, NAV_K - 1u)), k < NAV_K);
  // the wind (not under a roof: the top surface, or in the open air above it)
  if (state != ST_HELD && !rooted && (k == 0u || k >= NAV_K)) {
    let wv = windAt(pos + vec3<f32>(0.0, 0.0, height * 0.5));
    let ws = length(wv);
    let ex = ws - WIND_CALM;
    if (ex > 0.0) {
      let wd = wv / ws;
      let f = WIND_K * ex * ex / mass;
      if (state == ST_TUMBLE) {
        // (carried, never past the wind's own speed; lying on the ground, the
        // grip holds as much as on its feet, so a wind short of throwing it
        // lets it settle and get up)
        let lying = k < NAV_K && pos.z - floorZ < 0.1;
        let fa = select(f, max(f - WIND_GRIP, 0.0), lying);
        let along = dot(vel.xy, wd);
        if (along < ws) { vel = vec3<f32>(vel.xy + wd * min(fa * dt, ws - along), vel.z); }
      } else if (f > WIND_GRIP) {
        vel = vec3<f32>(vel.xy + wd * ex * 0.5, max(vel.z, 0.0) + ex * WIND_HOP);
        state = ST_TUMBLE;
        stT = 0.0;
        stun = 0.0;
      } else {
        push += wd * f * dt;
      }
    }
  }
  // knocked over by what tumbled through here last tick (not itself: it
  // was tumbling then, and a tumbling unit doesn't take shoves)
  if (state != ST_TUMBLE && state != ST_HELD && !rooted) {
    let sm = shoveLoad(rd + i, 2u) / SHOVE_FIX;
    if (sm > 0.0) {
      let p = vec2<f32>(shoveLoad(rd + i, 0u), shoveLoad(rd + i, 1u)) / SHOVE_FIX;
      let v = p / (sm + mass);
      if (length(v) > KNOCK_SPEED) { vel = vec3<f32>(v, length(v) * 0.3); state = ST_TUMBLE; stT = 0.0; stun = 0.0; }
    }
  }
  let onGround = k < NAV_K && state != ST_HELD && pos.z - floorZ < 0.5;
  // water: wading slows, over its head it drowns (and it puts out fire)
  let depth = select(0.0, navWater(i * NAV_K), k == 0u && onGround);
  if (depth > height && (caps & CAP_NO_DROWN) == 0u) { under += dt; } else { under = 0.0; }
  if (depth > height * 0.5) { alight = false; burn = 0.0; }
  if (under > DROWN_TIME && !dead) { dead = true; killedBy = BY_WATER; }
  // fire: where the ground burns, lava, hot ground, an ember just landed, a burning unit by it
  let lv = lava[i];
  let onTop = onGround && k == 0u;
  if (onTop && lv.x > 0.05 && lv.y > LAVA_LIGHT && !noBurn) {
    hp -= LAVA_DPS * dt;
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_LAVA; }
  }
  if (!alight && !noBurn && depth < height * 0.5) {
    var lit = onTop && (fire[i] > 0.3 || (lv.x > 0.05 && lv.y > LAVA_LIGHT) || lv.z > HOT_GROUND);
    let sk = textureLoad(sparkTex, texCol(vec2<i32>(c)), 0).x;
    if (sk > 0.0 && f32(G.tick) - sk < 2.5) { lit = true; }
    // (a burning unit here or next door: a chance a second)
    var near = shoveLoad(rd + i, 3u);
    for (var d = 0u; d < NDIR; d++) {
      let q = nbr(c, d);
      if (inMap(q)) { near += 0.5 * shoveLoad(rd + colIdxI(q), 3u); }
    }
    if (near > 0.0 && rand3(u, G.tick, 12u) < near * dt * 1.5) { lit = true; }
    if (lit) { alight = true; burn = BURN_TIME; emit(EV_ALIGHT, uid, BY_FIRE, 0.0, pos); }
  }
  if (alight) {
    hp -= BURN_DPS * dt;
    burn -= dt;
    if (burn <= 0.0) { alight = false; }
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_FIRE; }
  }

  var np = pos;
  if (state == ST_HELD) {
    // (where the game holds it: nothing else moves it)
  } else if (state == ST_TUMBLE) {
    // flying, falling, bouncing: free of the links
    // (round 128o, DA-B22: in sub-moves of at most half a cell across — a wall a column thick is met, not jumped — and
    // less than the floor's reach (floorUnder: 0.3) down; gravity, the walls and the ground a sub-move at a time, as a
    // tick at a time before the step's dt spanned several)
    let g = unitsG();
    let m = max(subMoves(length(vel.xy) * dt), u32(ceil((abs(vel.z) + g * dt) * dt / SUB_FALL)));
    let sdt = dt / f32(m);
    var ni = i;
    // (lying still on the ground through the whole step: its time down counts toward getting up)
    var still = true;
    for (var s = 0u; s < m; s++) {
      let was = np;
      let fi = ni;
      vel.z -= g * sdt;
      np = was + vel * sdt;
      ni = colIdxI(clampCell(cellAt(np.xy)));
      var fz = floorUnder(ni, np.z);
      if (fz <= -FAR) {
        // a wall: back off it, the way it came, slammed
        let sp = length(vel.xy);
        if (sp > HURT_SPEED) {
          let dmg = (sp - HURT_SPEED) * HURT_PER;
          hp -= dmg;
          flash = 0.15;
          emit(EV_HURT, uid, BY_IMPACT, dmg, was);
        }
        vel = vec3<f32>(-vel.xy * SLAM_BOUNCE, vel.z);
        np = vec3<f32>(was.xy, np.z);
        ni = fi;
        fz = floorUnder(fi, np.z);
      }
      if (fz > -FAR && np.z <= fz + 0.05) {
        // the ground: a landing, bounced, gripped
        let impact = -vel.z;
        if (impact > HURT_SPEED) {
          let dmg = (impact - HURT_SPEED) * HURT_PER;
          hp -= dmg;
          flash = 0.15;
          emit(EV_HURT, uid, BY_IMPACT, dmg, was);
        }
        np.z = fz;
        vel.z = select(0.0, impact * BOUNCE, impact > 2.0);
        // (a landing takes some of its speed along the ground too, as a skid)
        vel = vec3<f32>(vel.xy * max(1.0 - ROLL_GRIP * sdt, 0.0) * select(1.0, LAND_SKID, impact > 2.0), vel.z);
        if (length(vel) > 0.6) { still = false; }
      } else {
        still = false;
      }
    }
    if (!still) {
      stT = 0.0;
    } else if (stT > GETUP + stun) {
      // settled long enough: up again
      state = select(ST_WANDER, ST_CHASE, kind.b.w <= 0.0);
      stT = 0.0;
      vel = vec3<f32>(0.0);
      wanderH = heading;
      stun = 0.0;
    }
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_IMPACT; }
    if (state == ST_TUMBLE) {
      // rolling along its throw (the draw turns it about the axis across it)
      wanderH += length(vel) * dt / max(height * 0.5, 0.2);
      if (length(vel.xy) > 0.3) { heading = atan2(vel.y, vel.x); }
    }
    // what it carries knocks over the units in its way
    if (length(vel.xy) > KNOCK_SPEED) {
      shoveAdd(wr + ni, 0u, i32(vel.x * mass * SHOVE_FIX));
      shoveAdd(wr + ni, 1u, i32(vel.y * mass * SHOVE_FIX));
      shoveAdd(wr + ni, 2u, i32(mass * SHOVE_FIX));
    }
  } else if (kind.b.w <= 0.0 && steer < RIDE_TRIP + 0.5) {
    // (round 128o, DA-A7: on a trip — placed by the ride, roadride.wgsl, after the last step: its x, y and velocity are
    // the trip's; its height rides the surface under it nearest its last, so a step on the route is taken, not a wall)
    let kk = surfaceNear(i, pos.z);
    let fz = select(pos.z, navZ(i * NAV_K + min(kk, NAV_K - 1u)), kk < NAV_K);
    // (round 128o, DA-A6: up a step at once — never under its floor —, down one eased)
    np = vec3<f32>(pos.xy, select(pos.z + (fz - pos.z) * min(dt * 10.0, 1.0), fz, fz > pos.z));
    if (length(vel.xy) > 0.05) { heading = atan2(vel.y, vel.x); }
  } else {
    // walking: what it wants to do
    var want = vec2<f32>(0.0);
    var speed = kind.a.w;
    if (k < NAV_K) {
      let s = i * NAV_K + k;
      let here = fieldDist(fld, s);
      // (round 128o, DA-A6) a rider standing at its ride's goal (the ride's steer STAND, set for this group: not one it
      // was moved to this tick): arrived on its group's ride, told once — `other` RIDE_ARRIVED + its group
      let atRide = kind.b.w <= 0.0 && steer < 0.0 && steer > RIDE_TRIP + 0.5 && grp == (info & 0xffu);
      if (atRide) {
        let key = RIDE_ARRIVED + grp + 1u;
        if (latch != key) {
          latch = key;
          emit(EV_ARRIVED, uid, RIDE_ARRIVED + grp, 0.0, pos);
        }
      } else if (fieldOk(fld)) {
        // (round 128o, DA-B2a) arrived: within its field's radius, told once (the latch, word f.x)
        let ar = arriveR(fld);
        if (latch != 0u && latch != fld + 1u) { latch = 0u; }
        if (ar.x > 0.0 && latch == 0u && here <= ar.x) {
          latch = fld + 1u;
          emit(EV_ARRIVED, uid, fld, here, pos);
        } else if (latch == fld + 1u && here > ar.y) {
          latch = 0u;
        }
      }
      let worker = kind.b.w <= 0.0;
      // the nearest target, as the crow flies over the ground (whatever its
      // height: one overhead is chased, and waited for underneath)
      var tgt = -1;
      var td = FAR;
      for (var t = 0u; t < AP.n2.y; t++) {
        let tp = AP.targets[t];
        let dd2 = length(tp.xy - pos.xy) - tp.w;
        if (dd2 < td) { td = dd2; tgt = i32(t); }
      }
      // in reach: within the arms' reach of the target's body, and nothing
      // solid between its chest and the target (a floor, a deck, a wall)
      var reachD = FAR;
      var seen = false;
      if (tgt >= 0 && td < kind.b.x * 1.3) {
        let g = targetGap(u32(tgt), pos, height);
        reachD = g.w;
        if (reachD < kind.b.x * 1.3) { seen = sightClear(pos + vec3<f32>(0.0, 0.0, height * 0.6), g.xyz); }
      }
      // (FC12 stage 2: its target as the last frame left it — mail's aim — in sight or not; a ranged kind's range)
      let aimO = MAIL_AIM + u * AIM_W;
      let aimCode = atomicLoad(&mail[aimO + 3u]);
      let aimFlags = atomicLoad(&mail[aimO + 7u]);
      // (U2 DA-B32: whoever can fight — a reach or a range — and has a unit target fights on the GPU, hostile or not:
      // the defenders' CPU strikes are gone)
      let canFight = kind.b.x > 0.0 || bitcast<f32>(kind.c.w) > 0.0;
      let aimOk = canFight && aimCode != 0u && aimCode == bitcast<u32>(units[u * UNIT_V + 5u].y);
      let aimSeen = aimOk && (aimFlags & AIM_SEEN) != 0u;
      let aimAt = mailV3(aimO);
      let range = bitcast<f32>(kind.c.w);
      let ranged = range > 0.0;
      let aimD = length(aimAt.xy - pos.xy);
      // (U2 round 5: in an ordered group — mail's aim word 11, orders.wgsl — it walks its order's field, never wanders)
      let ordered = atomicLoad(&mail[aimO + 11u]) != 0u;
      // (a unit target: reach and sight to it — the aim's place, as the last frame left it — not the CPU's 8 targets)
      if (aimOk && !ranged) {
        let hd = max(aimD - 0.4, 0.0);
        let vd = max(max(aimAt.z - (pos.z + height + 0.3), pos.z - (aimAt.z + 1.6)), 0.0);
        reachD = sqrt(hd * hd + vd * vd);
        seen = reachD < kind.b.x * 1.3 && sightClear(pos + vec3<f32>(0.0, 0.0, height * 0.6), aimAt + vec3<f32>(0.0, 0.0, 0.8));
      }
      if (!worker || aimOk) {
        // (in sight: closing in at once, the field not waited for)
        if (state == ST_WANDER && aimSeen) { state = ST_CHASE; stT = 0.0; }
        if (state == ST_WANDER && here < kind.b.w) { state = ST_CHASE; stT = 0.0; }
        if (state == ST_CHASE && here > kind.b.w * 1.5 && !aimSeen) { state = ST_WANDER; stT = 0.0; }
        if (state == ST_CHASE && reachD < kind.b.x && seen && cool <= 0.0) {
          state = ST_SWING;
          stT = 0.0;
          emit(EV_WINDUP, uid, select(u32(tgt), aimCode, aimOk), SWING_HIT, pos);
        }
      }
      if (state == ST_SWING) {
        speed = 0.0;
        if (aimOk) { heading = atan2(aimAt.y - pos.y, aimAt.x - pos.x); } else if (tgt >= 0) { heading = atan2(AP.targets[tgt].y - pos.y, AP.targets[tgt].x - pos.x); }
        // (the blow lands once, partway into the swing, if it's still in reach. U2 DA-B32: on a unit it lands in its
        // accumulator — the target's own thread applies it, naming the striker, as an arrow; on an actor (the hero:
        // the CPU's) it's told as a swing)
        if (stT >= SWING_HIT && stT - dt < SWING_HIT && reachD < kind.b.x * 1.3 && seen) {
          if (aimOk) {
            let t = (aimCode - 1u) % MAX_SLOTS;
            atomicAdd(&mail[MAIL_ACC + t * 2u], u32(max(kind.b.y, 0.0) * 256.0));
            atomicMax(&mail[MAIL_ACC + t * 2u + 1u], uid + 1u);
          } else {
            emit(EV_SWING, uid, u32(tgt), kind.b.y, pos);
          }
        }
        if (stT > SWING_END) { state = ST_CHASE; stT = 0.0; cool = kind.b.z; }
      } else if (state == ST_WANDER && !worker && !ordered) {
        // (a new heading now and then; slower than closing in)
        if (rand3(u, G.tick, 7u) < dt * 0.4) { wanderH = rand3(u, G.tick, 8u) * 6.2832; }
        want = vec2<f32>(cos(wanderH), sin(wanderH)) * 0.4;
      } else if (ranged && aimSeen && aimD <= range) {
        // (a ranged kind in range and in sight: it stands — backs off inside its standoff — and shoots on its cooldown)
        want = select(vec2<f32>(0.0), -(aimAt.xy - pos.xy) / max(aimD, 1e-3), aimD < range * 0.4);
        heading = atan2(aimAt.y - pos.y, aimAt.x - pos.x);
        // (time to act counts from the first tick in range and in sight: its own slot's words, the step's)
        var fl = aimFlags;
        if ((fl & AIM_INRANGE) == 0u) {
          fl |= AIM_INRANGE;
          atomicStore(&mail[aimO + 10u], AP.n.w);
        }
        if (cool <= 0.0) {
          fireArrow(uid, aimCode, kind.b.y, pos, aimAt);
          cool = kind.b.z;
          if ((fl & AIM_SHOT) == 0u) {
            fl |= AIM_SHOT;
            atomicAdd(&mail[1], AP.n.w - atomicLoad(&mail[aimO + 10u]));
            atomicAdd(&mail[2], 1u);
          }
        }
        atomicStore(&mail[aimO + 7u], fl);
      } else if (aimSeen && state == ST_CHASE && aimD > 0.6) {
        // (melee in sight: straight at it, the field not waited for)
        want = (aimAt.xy - pos.xy) / aimD;
        atomicAdd(&mail[6], 1u);
      } else if (rankMode == RANK_STEER) {
        // (U2 round 6: its formation slot, post or waypoint — straight at it, slowing in its last cell)
        let d = length(rankAt.xy - pos.xy);
        want = select(vec2<f32>(0.0), (rankAt.xy - pos.xy) / max(d, 1e-3) * min(d / 0.8, 1.0), d > 0.15);
      } else if (worker && steer != 0.0) {
        // (round 128i, V128-14: riding the roads — shaders/roadride.wgsl steers it: a heading, or stand at its goal)
        want = select(vec2<f32>(cos(steer - STEER_BIAS), sin(steer - STEER_BIAS)), vec2<f32>(0.0), steer < 0.0);
      } else if (here < FAR && here > 0.6) {
        want = downField(fld, s, c, pos.xy, here);
        // (frightened: away up its field, from what it would have gone to)
        if ((caps & CAP_FLEE) != 0u) { want = -want; }
      }
      if (alight) {
        // burning: running about, faster
        want = normalize(want + (vec2<f32>(rand3(u, G.tick / 20u, 9u), rand3(u, G.tick / 20u, 10u)) - 0.5) * 2.5 + vec2<f32>(1e-4, 0.0));
        speed *= 1.5;
      }
      // apart from the crowd: away from the busier neighbours
      let mine = f32(atomicLoad(&occ[occAt(rd + i)]));
      var crowd = vec2<f32>(0.0);
      for (var d = 0u; d < NDIR; d++) {
        let q = nbr(c, d);
        if (!inMap(q) || navLink(s, d) == 0u) { continue; }
        crowd -= DIRV[d] * f32(atomicLoad(&occ[occAt(rd + colIdxI(q))]));
      }
      let jit = vec2<f32>(rand3(u, G.tick, 1u), rand3(u, G.tick, 2u)) - 0.5;
      // (in formation the slots keep them apart: the crowd's push a third as strong, or ranks fray)
      let crowdK = select(0.25, 0.08, rankMode == RANK_STEER);
      want += crowd * crowdK + jit * 0.2 * max(mine - 1.0, 0.0);
    }
    // wading: slower the deeper
    speed *= 1.0 - 0.6 * clamp(depth / max(height, 0.1), 0.0, 1.0);
    if (rooted) { speed = 0.0; want = vec2<f32>(0.0); push = vec2<f32>(0.0); }
    let goalV = select(want, normalize(want), length(want) > 1.0) * speed;
    var v2 = vel.xy + (goalV - vel.xy) * min(dt * 6.0, 1.0) + push;
    // never step where there's no link, nor off the place its field is
    // confined to: it stops there instead. (Round 128o, DA-B22: in sub-moves of at most half a cell, each into the
    // column next to the last by a link — the step's dt may span several ticks)
    let fp = fieldPlace(fld);
    let mv = v2 * dt;
    let m = subMoves(length(mv));
    var p2 = pos.xy;
    var cc = c;
    var ci = i;
    var ck = k;
    for (var s = 0u; s < m; s++) {
      let q = p2 + mv / f32(m);
      let nc = clampCell(cellAt(q));
      if (any(nc != cc)) {
        if (ck < NAV_K) {
          var ok = false;
          var nk = NAV_K;
          for (var d = 0u; d < NDIR; d++) {
            let l = navLink(ci * NAV_K + ck, d);
            if (!all(nbr(cc, d) == nc) || l == 0u) { continue; }
            let t = colIdxI(nc) * NAV_K + l - 1u;
            ok = fp == 0u || onPlace(t, fp);
            nk = l - 1u;
          }
          if (!ok) {
            v2 *= 0.3;
            break;
          }
          ck = nk;
        } else {
          ck = surfaceAt(colIdxI(nc), pos.z + 0.5);
        }
        cc = nc;
        ci = colIdxI(nc);
      }
      p2 = q;
    }
    // ride the surface: step up and drop down smoothly
    let ni = colIdxI(clampCell(cellAt(p2)));
    let k2 = surfaceAt(ni, pos.z + 0.5);
    if (k2 < NAV_K) { floorZ = navZ(ni * NAV_K + k2); }
    var z = pos.z + (floorZ - pos.z) * min(dt * 10.0, 1.0);
    // (just placed, from above: straight onto it)
    if (pos.z - floorZ > DROP * 2.0) { z = floorZ; } else if (pos.z - floorZ > DROP) {
      // (walked off an edge higher than a drop: it falls)
      state = ST_TUMBLE;
      stT = 0.0;
      stun = 0.0;
      z = pos.z;
    }
    np = vec3<f32>(p2, z);
    vel = vec3<f32>(v2, 0.0);
    if (length(v2) > 0.05 && state != ST_SWING) { heading = atan2(v2.y, v2.x); }
  }
  if (dead) {
    emit(EV_DEATH, uid, killedBy, 0.0, pos);
    units[u * UNIT_V] = vec4<f32>(pos, bitcast<f32>(info & ~(1u << 8u)));
    return;
  }
  let fi = colIdxI(clampCell(cellAt(np.xy)));
  if (alight) { shoveAdd(wr + fi, 3u, 1); }
  let phase = fract(b.w + dt * length(vel.xy) * 0.9);
  info = (info & ~((7u << 12u) | (1u << 15u) | 0xffu)) | (state << 12u) | (select(0u, 1u, alight) << 15u) | grp;
  units[u * UNIT_V] = vec4<f32>(np, bitcast<f32>(info));
  units[u * UNIT_V + 1u] = vec4<f32>(vel, select(phase, stun, state == ST_TUMBLE));
  units[u * UNIT_V + 2u] = vec4<f32>(hp, cool, burn, heading);
  units[u * UNIT_V + 3u] = vec4<f32>(flash, stT, under, wanderH);
  units[u * UNIT_V + 5u].x = bitcast<f32>(latch);
  atomicAdd(&occ[occAt(wr + fi)], 1u);
}

fn putVoxel(o: u32, c: vec3<f32>, word: u32, q: vec4<f32>) {
  if (o >= MAX_INST) { return; }
  inst[o * 2u] = vec4<u32>(bitcast<u32>(c.x), bitcast<u32>(c.y), bitcast<u32>(c.z), word);
  inst[o * 2u + 1u] = bitcast<vec4<u32>>(q);
}
fn qmul(p: vec4<f32>, q: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(p.w * q.xyz + q.w * p.xyz + cross(p.xyz, q.xyz), p.w * q.w - dot(p.xyz, q.xyz));
}
fn qrotv(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// the default figure's legs (dark: asphalt) and head (pale: canvas)
const MAT_LEGS: u32 = 6u;
const MAT_HEAD: u32 = 21u;
const PHYS_BIT: u32 = 0x40000000u;

/** Each live unit's voxels (after unitStep), appended. */
@compute @workgroup_size(64)
fn unitDraw(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  let a = units[u * UNIT_V];
  let info = unitInfo(a);
  // (LW1) the trait modules' look; a fallen unit is drawn only while it lies as a corpse (the trait system's)
  let look = bitcast<u32>(units[u * UNIT_V + 4u].y);
  let corpse = ((info >> 8u) & 1u) == 0u;
  if (corpse && (look & LOOK_CORPSE) == 0u) { return; }
  let b = units[u * UNIT_V + 1u];
  let cc = units[u * UNIT_V + 2u];
  let dd = units[u * UNIT_V + 3u];
  let kn = (info >> 9u) & 7u;
  let kind = AP.kinds[kn];
  let km = kindModels[kn];
  let grp = info & 0xffu;
  let state = select((info >> 12u) & 7u, ST_TUMBLE, corpse);
  let h = kind.a.x;
  let yaw = cc.w;
  var q = vec4<f32>(0.0, 0.0, sin(yaw * 0.5), cos(yaw * 0.5));
  // tumbling: rolled along its throw, about the axis across it, round its middle
  let mid = vec3<f32>(0.0, 0.0, h * 0.5);
  if (corpse) {
    // a body: flat on its back where it fell
    let ax = vec3<f32>(-sin(yaw), cos(yaw), 0.0);
    q = qmul(vec4<f32>(ax * sin(-0.785398), cos(-0.785398)), q);
  } else if (state == ST_TUMBLE) {
    let ax = vec3<f32>(-sin(yaw), cos(yaw), 0.0);
    q = qmul(vec4<f32>(ax * sin(dd.w * 0.5), cos(dd.w * 0.5)), q);
  }
  // (round 88) at work (its group's pose bit) or swinging: bent forward to a tool in its hands, rocking
  let gm = AP.groupMat[grp / 4u][grp % 4u];
  let swinging = state == ST_SWING;
  let working = ((((gm >> 8u) & 1u) != 0u && state < ST_TUMBLE) || swinging) && !corpse;
  if (working) {
    let ph = f32(G.tick) * 0.13 + f32(u) * 1.7;
    let bend = select(0.2 + 0.3 * max(sin(ph), -0.3), 0.55 * sin(min(dd.y / 0.6, 1.0) * 3.1416), swinging);
    let ax = vec3<f32>(-sin(yaw), cos(yaw), 0.0);
    q = qmul(vec4<f32>(ax * sin(bend * 0.5), cos(bend * 0.5)), q);
  }
  let sp = length(b.xy);
  let bob = select(abs(sin(b.w * 6.2832)) * 0.05 * h * min(sp, 1.0), 0.0, state >= ST_TUMBLE);
  // alight: a flicker of heat; hurt: a white flash (fsBody's physics-voxel glow, bits 16-23)
  let alight = ((info >> 15u) & 1u) != 0u;
  var heat = 0.0;
  if (alight && !corpse) { heat = 0.45 + 0.25 * rand3(u, G.tick / 3u, 11u); }
  if (dd.x > 0.0 && !corpse) { heat = 1.0; }
  let glow = select(0u, PHYS_BIT | (u32(heat * 255.0) << 16u), heat > 0.0);
  let n = select(3u, km.y, km.y > 0u);
  let cv = carried[u];
  let holds = cv.x > 0.5 && state < ST_TUMBLE;
  // (LW1) a halo (healing), two sparks (harmed)
  let halo = (look & LOOK_HALO) != 0u && !corpse;
  let sparks = (look & LOOK_SPARKS) != 0u && !corpse;
  let extra = select(0u, 1u, holds) + select(0u, 1u, working);
  let base = atomicAdd(&drawArgs[1], n + extra + select(0u, 1u, halo) + select(0u, 2u, sparks));
  let centre = select(a.xyz + mid + vec3<f32>(0.0, 0.0, bob), a.xyz + vec3<f32>(0.0, 0.0, h * 0.14), corpse);
  if (halo) {
    // a small glowing light over its head (a share of its melting point: the heat glow's white end)
    let hm = (look >> 16u) & 0xffu;
    let bobH = 0.06 * sin(f32(G.tick) * 0.12 + f32(u));
    putVoxel(base + n + extra, a.xyz + vec3<f32>(0.0, 0.0, h + 0.28 + bobH), select(15u, hm, hm != 0u) | (3u << 24u) | PHYS_BIT | (230u << 16u), vec4<f32>(0.0, 0.0, 0.0, 1.0));
  }
  if (sparks) {
    // bright motes jumping about its body, new places every few ticks
    let o = base + n + extra + select(0u, 1u, halo);
    for (var j = 0u; j < 2u; j++) {
      let t = G.tick / 3u;
      let r = vec3<f32>(rand3(u, t, 30u + j) - 0.5, rand3(u, t, 40u + j) - 0.5, rand3(u, t, 50u + j));
      putVoxel(o + j, a.xyz + vec3<f32>(r.xy * 0.9, 0.2 + r.z * h), 15u | (2u << 24u) | PHYS_BIT | (250u << 16u), vec4<f32>(0.0, 0.0, 0.0, 1.0));
    }
  }
  if (holds) {
    // its load, held up over its head
    let e = cv.y;
    putVoxel(base + n, centre + qrotv(q, vec3<f32>(0.0, 0.0, h + e * 0.5 + 0.05) - mid), u32(cv.x) | (min(u32(e * 16.0 + 0.5), 63u) << 24u) | glow, q);
  }
  if (working) {
    // the tool (a pick, an axe, a blade): out in front at the hands, steel
    let tp = vec3<f32>(0.36 * h, 0.1 * h, h * 0.55) - mid;
    putVoxel(base + n + select(0u, 1u, holds), centre + qrotv(q, tp), 20u | (4u << 24u) | glow, q);
  }
  if (km.y > 0u) {
    // the kind's model: voxels round its feet, turned its way
    let code = km.z;
    let tint = look & 0xffu;
    for (var v = 0u; v < km.y; v++) {
      let m = models[km.x + v];
      // (a tint mottles a model: a voxel in three of its colour)
      let mat = select(bitcast<u32>(m.w), tint, tint != 0u && (v * 7u + u) % 3u == 0u);
      let w = mat | (code << 24u) | glow;
      putVoxel(base + v, centre + qrotv(q, m.xyz - mid), w, q);
    }
    return;
  }
  // the default figure: legs, torso (its kind's colour, else its group's), head
  var torso = kind.c.z;
  if (torso == 0u) { torso = gm & 0xffu; }
  if ((look & 0xffu) != 0u) { torso = look & 0xffu; }
  let headMat = select(select(MAT_HEAD, kind.c.y, kind.c.y != 0u), (look >> 8u) & 0xffu, ((look >> 8u) & 0xffu) != 0u);
  let lg = h * 0.27;
  let ts = h * 0.4;
  let code = vec3<u32>(vec3<f32>(lg, ts, lg) * 16.0 + 0.5);
  putVoxel(base, centre + qrotv(q, vec3<f32>(0.0, 0.0, lg * 0.5) - mid), select(MAT_LEGS, kind.c.x, kind.c.x != 0u) | (min(code.x, 63u) << 24u) | glow, q);
  putVoxel(base + 1u, centre + qrotv(q, vec3<f32>(0.0, 0.0, lg + ts * 0.5) - mid), torso | (min(code.y, 63u) << 24u) | glow, q);
  putVoxel(base + 2u, centre + qrotv(q, vec3<f32>(0.03 * h, 0.0, lg + ts + lg * 0.5) - mid), headMat | (min(code.z, 63u) << 24u) | glow, q);
}

/** Items in flight (round 63): a voxel of the material each, tumbling about its axis. */
@compute @workgroup_size(64)
fn itemDraw(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= MAX_FLY) { return; }
  let a = flying[i * 2u];
  if (a.w < 0.5) { return; }
  let b = flying[i * 2u + 1u];
  let k = atomicAdd(&drawArgs[1], 1u);
  let ax = vec3<f32>(b.zw, 0.0);
  let q = select(vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(normalize(ax) * sin(b.y * 0.5), cos(b.y * 0.5)), length(ax) > 1e-3);
  putVoxel(k, a.xyz, u32(a.w) | (min(u32(b.x * 16.0 + 0.5), 63u) << 24u), q);
}

// ---- (U2, docs/design/UNIT_MINDS_U2.md §5) the hunt fields seeded on the GPU ---------------------------------------
// Each hostile fighter's target (unit word f.y, notice.wgsl) is a seed of the hunt field, and each peaceful fighter's
// (a guard's, a soldier's: DA-B32) of the foes' field — put once a frame before the relaxation (fieldseam.wgsl
// seedPut: the frame's seed list; a seed new marks its page, one gone is seedGone's). Actors' targets stay the CPU's
// seeds (their positions are the CPU's). The two field ids: seedList words SEED_HUNT, SEED_FOES (FIELD_NONE none).
const SEED_HUNT: u32 = 4u;
const SEED_FOES: u32 = 5u;
@compute @workgroup_size(64)
fn huntSet(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  let info = unitInfo(units[u * UNIT_V]);
  if (((info >> 8u) & 1u) == 0u) { return; }
  // (a hostile kind — one that notices, kind.b.w, as unitStep's `worker` — seeds the hunt's field; (U2 round 5) a
  // peaceful one that can fight — a reach or a range — the foes')
  let kd = AP.kinds[(info >> 9u) & 7u];
  let hostileKind = kd.b.w > 0.0;
  if (!hostileKind && kd.b.x <= 0.0 && bitcast<f32>(kd.c.w) <= 0.0) { return; }
  let f = atomicLoad(&seedList[select(SEED_FOES, SEED_HUNT, hostileKind)]);
  if (!fieldOk(f)) { return; }
  let code = bitcast<u32>(units[u * UNIT_V + 5u].y);
  if (code == 0u || (code & 0x80000000u) != 0u) { return; }
  let t = (code - 1u) % MAX_SLOTS;
  if (t >= AP.n.x) { return; }
  let ta = units[t * UNIT_V];
  let ti = unitInfo(ta);
  if (((ti >> 8u) & 1u) == 0u || unitId(t, ti) != code - 1u) { return; }
  // (?seenonly=1: the seed is where the target was last seen — none if never, or out of sight past SEEN_GIVEUP; the
  // aim is last frame's, for this target)
  var seedAt = ta.xyz;
  let ao0 = MAIL_AIM + u * AIM_W;
  let told = atomicLoad(&mail[ao0 + 3u]) == code && (atomicLoad(&mail[ao0 + 7u]) & AIM_TOLD) != 0u;
  if ((AP.u2.z & SEEN_ONLY) != 0u && !told) {
    let ao = MAIL_AIM + u * AIM_W;
    let fl = atomicLoad(&mail[ao + 7u]);
    let lostS = f32(AP.n.w - atomicLoad(&mail[ao + 8u])) * AIM_TICK_S;
    if (atomicLoad(&mail[ao + 3u]) != code || (fl & AIM_EVER) == 0u || lostS > SEEN_GIVEUP) { return; }
    seedAt = mailV3(ao + 4u);
  }
  let c = clampCell(cellAt(seedAt.xy));
  if (!inScope(c)) { return; }
  let i = colIdxI(c);
  let k = surfaceNear(i, seedAt.z);
  if (k >= NAV_K) { return; }
  let s = i * NAV_K + k;
  // (new here: the field falls round it — ?jfa=1: the targets JFA runs again this frame, the hunt's)
  if (seedPut(f, s) == SEED_NEW) {
    if (hostileKind) { atomicStore(&jfa[0], 1u); }
    if (AP.u2.w != 0u) { atomicAdd(&frontDbg[32], 1u); }
  }
}

// ---- (FC12 variant, ?jfa=1: the user's "an obstacle JFA, then a targets JFA, then a line check on the obstacle
// distance") ---------------------------------------------------------------------------------------------------------
// Over the window's columns, on their top surfaces (k 0: the open ground a fighter crosses):
//   * the obstacle JFA: each column's nearest obstacle column — a top surface missing a link in any direction (a wall,
//     a drop, a climb past STEP, the window's edge, no ground), wet, or with a neighbour more than LOS_DZ above or below
//     it. Its distance is the clearance (jfaClear, world cells): static, made again only when the links pass ran (the
//     columns changed) or a chunk came into the scope (jfa[2]). It is also the formations' width where a march has no
//     route (UNIT_MINDS_U2.md §9d): width = 2 × clearance.
//   * the targets JFA: each column's nearest hunt seed on a top surface, on frames the seeds change cell (jfa[0], set
//     by huntSet / huntGone).
//   * then each top surface checks the straight line to its seed on the clearance (?jfalos=trace: steps of the
//     clearance; bisect: halves, a half clear when its midpoint's clearance passes its half-length). Clear (clearance
//     ≥ LOS_CLEAR all along): it starts at hexDist × LOS_CMAX — the cost of a walk along the line, every step on flat dry
//     ground (≤ 1 + 1.5 × LOS_DZ), so never under what relax will find. Blocked: it keeps what it has (FAR or relax's).
//     The value takes the seed as its seed-id (§5b), so it empties with the seed.
// Lower surfaces (under a bridge, in a cave, a wall-walk) aren't seeded this way: relax fills them from their links.
// jfa (binding 55): [0] targets changed, [1] its pass, [2] obstacles changed, [3] its pass, [4] passes (CPU), [5]–[7]
// ?jfa=2's (below), then planes of a window column each (window order): targets A, B, obstacles A, B, the clearance
// (f32 bits), ?jfa=2's resolved value (f32 bits) and root
@group(0) @binding(55) var<storage, read_write> jfa: array<atomic<u32>>;
const JFA_HEAD: u32 = 8u;
const LOS_DZ: f32 = 0.25;
const LOS_CMAX: f32 = 1.375;
const LOS_CLEAR: f32 = 1.5;
/** 0 trace, 1 bisect (agents.ts sets it: ?jfalos) */
const JFA_LOS: u32 = 0u;
fn jfaPlane(k: u32) -> u32 { return JFA_HEAD + k * G.mapW * G.mapH; }
fn jfaXY(w: u32) -> vec2<i32> { return vec2<i32>(i32(w % G.mapW), i32(w / G.mapW)); }
/** the clearance at a window column (cells to the nearest obstacle column; FAR none) */
fn clearanceAt(p: vec2<i32>) -> f32 { return bitcast<f32>(atomicLoad(&jfa[jfaPlane(4u) + winIdx(clampCell(p))])); }
fn hexDist(a: vec2<i32>, b: vec2<i32>) -> f32 {
  let qa = a.x - (a.y - (a.y & 1)) / 2;
  let qb = b.x - (b.y - (b.y & 1)) / 2;
  let dq = qb - qa;
  let dr = b.y - a.y;
  return f32(abs(dq) + abs(dr) + abs(dq + dr)) / 2.0;
}
/** one JFA step over a pair of planes: the nearest of the 9 candidates `step` apart (in world distance) */
fn jfaStep(p: vec2<i32>, src: u32, dst: u32, step: i32) {
  let me = cellPos(p);
  var best = atomicLoad(&jfa[src + winIdx(p)]);
  var bd = FAR;
  if (best != 0u) { bd = length(cellPos(jfaXY((best - 1u) >> 2u)) - me); }
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = p + vec2<i32>(dx, dy) * step;
      if (!inMap(q) || (dx == 0 && dy == 0)) { continue; }
      let c = atomicLoad(&jfa[src + winIdx(q)]);
      if (c == 0u) { continue; }
      let d = length(cellPos(jfaXY((c - 1u) >> 2u)) - me);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
  }
  atomicStore(&jfa[dst + winIdx(p)], best);
}

@compute @workgroup_size(8, 8)
fn jfaObsInit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (atomicLoad(&jfa[2]) == 0u || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let s = colIdxI(p) * NAV_K;
  var obstacle = navZ(s) < 0.0 || costWet(s) || costDeep(s);
  if (!obstacle) {
    let z = costZ(s);
    for (var d = 0u; d < NDIR; d++) {
      let l = navLink(s, d);
      let q = nbr(p, d);
      if (l == 0u || !inMap(q)) { obstacle = true; break; }
      if (abs(costZ(colIdxI(q) * NAV_K + l - 1u) - z) > LOS_DZ) { obstacle = true; break; }
    }
  }
  atomicStore(&jfa[jfaPlane(2u) + winIdx(p)], select(0u, (winIdx(p) << 2u) + 1u, obstacle));
  if (all(id.xy == vec2<u32>(0u))) { atomicStore(&jfa[3], 0u); }
}
@compute @workgroup_size(8, 8)
fn jfaObsPass(@builtin(global_invocation_id) id: vec3<u32>) {
  if (atomicLoad(&jfa[2]) == 0u || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let k = atomicLoad(&jfa[3]);
  let n = atomicLoad(&jfa[4]);
  let a = select(3u, 2u, k % 2u == 0u);
  jfaStep(vec2<i32>(id.xy), jfaPlane(a), jfaPlane(5u - a), 1 << (n - 1u - k));
}
@compute @workgroup_size(1)
fn jfaObsNext() { atomicAdd(&jfa[3], 1u); }
@compute @workgroup_size(8, 8)
fn jfaObsClear(@builtin(global_invocation_id) id: vec3<u32>) {
  if (atomicLoad(&jfa[2]) == 0u || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let c = atomicLoad(&jfa[jfaPlane(select(3u, 2u, atomicLoad(&jfa[4]) % 2u == 0u)) + winIdx(p)]);
  let d = select(length(cellPos(jfaXY((c - 1u) >> 2u)) - cellPos(p)), FAR, c == 0u);
  atomicStore(&jfa[jfaPlane(4u) + winIdx(p)], bitcast<u32>(d));
  if (AP.u2.w != 0u && all(id.xy == vec2<u32>(0u))) { atomicAdd(&frontDbg[35], 1u); }
}
@compute @workgroup_size(1)
fn jfaObsEnd() { atomicStore(&jfa[2], 0u); }

@compute @workgroup_size(8, 8)
fn jfaInit(@builtin(global_invocation_id) id: vec3<u32>) {
  let f = AP.u2.x;
  if (atomicLoad(&jfa[0]) == 0u || !fieldOk(f) || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let s = colIdxI(p) * NAV_K;
  // (a seed on the top surface only: see the header)
  let seeded = inScope(p) && fieldIsSeed(f, s);
  atomicStore(&jfa[jfaPlane(0u) + winIdx(p)], select(0u, (winIdx(p) << 2u) + 1u, seeded));
  // (?jfa=2's planes: a seed resolved at 0, its own root; the rest not yet)
  atomicStore(&jfa[jfaPlane(5u) + winIdx(p)], bitcast<u32>(select(FAR, 0.0, seeded)));
  atomicStore(&jfa[jfaPlane(6u) + winIdx(p)], winIdx(p));
  if (AP.u2.w != 0u && inScope(p) && navZ(s) >= 0.0) { atomicAdd(&frontDbg[44], 1u); }
  if (all(id.xy == vec2<u32>(0u))) {
    atomicStore(&jfa[1], 0u);
    atomicStore(&jfa[5], 0u);
    atomicStore(&jfa[6], 0u);
    atomicStore(&jfa[7], 0u);
  }
}
@compute @workgroup_size(8, 8)
fn jfaPass(@builtin(global_invocation_id) id: vec3<u32>) {
  if (atomicLoad(&jfa[0]) == 0u || !fieldOk(AP.u2.x) || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let k = atomicLoad(&jfa[1]);
  let n = atomicLoad(&jfa[4]);
  let a = select(1u, 0u, k % 2u == 0u);
  jfaStep(vec2<i32>(id.xy), jfaPlane(a), jfaPlane(1u - a), 1 << (n - 1u - k));
}
@compute @workgroup_size(1)
fn jfaNext() { atomicAdd(&jfa[1], 1u); }

/** the straight line from a to b clear by LOS_CLEAR all along, on the clearance */
fn losClear(a: vec2<f32>, b: vec2<f32>) -> bool {
  let L = length(b - a);
  if (L < 1e-3) { return true; }
  let dir = (b - a) / L;
  if (JFA_LOS == 0u) {
    // (sphere tracing: each step as long as the clearance allows)
    var t = 0.0;
    for (var it = 0u; it < 256u; it++) {
      if (t >= L) { return true; }
      let c = clearanceAt(cellAt(a + dir * t));
      if (c < LOS_CLEAR) { return false; }
      t += max(c - LOS_CLEAR, 0.5);
    }
    return false;
  }
  // (bisection: a half clear when its midpoint's clearance covers its half-length)
  var stack: array<vec2<f32>, 24>;
  var top = 1u;
  stack[0] = vec2<f32>(0.0, L);
  for (var it = 0u; it < 256u && top > 0u; it++) {
    top -= 1u;
    let seg = stack[top];
    let h = (seg.y - seg.x) * 0.5;
    let c = clearanceAt(cellAt(a + dir * (seg.x + h)));
    if (c < LOS_CLEAR) { return false; }
    if (c >= h + LOS_CLEAR) { continue; }
    if (top + 2u > 24u) { return false; }
    stack[top] = vec2<f32>(seg.x, seg.x + h);
    stack[top + 1u] = vec2<f32>(seg.x + h, seg.y);
    top += 2u;
  }
  return top == 0u;
}

@compute @workgroup_size(8, 8)
fn jfaApply(@builtin(global_invocation_id) id: vec3<u32>) {
  let f = AP.u2.x;
  if (atomicLoad(&jfa[0]) == 0u || !fieldOk(f) || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  if (!inScope(p)) { return; }
  let c = atomicLoad(&jfa[jfaPlane(select(1u, 0u, atomicLoad(&jfa[4]) % 2u == 0u)) + winIdx(p)]);
  if (c == 0u) { return; }
  let sp = jfaXY((c - 1u) >> 2u);
  let s = colIdxI(p) * NAV_K;
  if (navZ(s) < 0.0 || all(sp == p)) { return; }
  if (!losClear(cellPos(p), cellPos(sp))) { return; }
  jfaResolve(p, s, hexDist(p, sp) * LOS_CMAX, winIdx(sp));
}

/** column p's top surface s resolved at v from the root seed at window column `root`: the value kept for ?jfa=2's rounds,
 *  and the field's value and seed-id written where it has none live or a higher one */
fn jfaResolve(p: vec2<i32>, s: u32, v: f32, root: u32) {
  let f = AP.u2.x;
  let w = winIdx(p);
  atomicStore(&jfa[jfaPlane(5u) + w], bitcast<u32>(v));
  atomicStore(&jfa[jfaPlane(6u) + w], root);
  atomicAdd(&jfa[5], 1u);
  if (AP.u2.w != 0u) { atomicAdd(&frontDbg[36u + min(atomicLoad(&jfa[7]), 7u)], 1u); }
  let seedS = colIdxI(jfaXY(root)) * NAV_K;
  // (through the field's page: none there — the relax asks for it as the field reaches it)
  let pg = fieldPage(f, s);
  if (pg == PP_NONE) { return; }
  let pw = s % FP_W;
  let od = ppF32(pg, pw);
  let os = ppWord(pg, FP_W + pw);
  let live = os != 0u && fieldDist(f, os - 1u) == 0.0;
  if (live && od <= v) { return; }
  ppSetF32(pg, pw, v);
  ppSetWord(pg, FP_W + pw, seedS + 1u);
  ppMark(f, s / FP_W);
}
@compute @workgroup_size(1)
fn jfaEnd() {
  if (AP.u2.w != 0u && atomicLoad(&jfa[0]) != 0u) { atomicAdd(&frontDbg[34], 1u); }
  atomicStore(&jfa[0], 0u);
}

// ---- (?jfa=2: the user's iterated JFA — "keep all the JFA to targets that don't hit an obstacle and then JFA to those
// pixels on the remaining ones. A few iterations and you can go around bends") ------------------------------------------
// Round 0 is ?jfa=1's (targets JFA, the line check). Each later round: the resolved columns on the edge of the resolved
// ground (one with an unresolved neighbour — the inside sees nothing the edge doesn't) are seeds weighted by their value;
// a JFA over all columns gives each its best by value + line cost (approximate: additive weights can pick a worse seed —
// still an achievable path, an overestimate relax polishes); an unresolved column with a clear line to it takes value +
// line cost, and the root seed's id. Stops after the rounds agents.ts dispatches, or at a round that resolves nothing.
// jfa words: [5] columns resolved in the last round, [6] stop, [7] the round; planes 5 the resolved value (f32 bits, FAR
// none), 6 its root seed's window column
@compute @workgroup_size(1)
fn jfaRBegin() {
  if (atomicLoad(&jfa[0]) == 0u) { return; }
  if (atomicLoad(&jfa[5]) == 0u) { atomicStore(&jfa[6], 1u); }
  atomicStore(&jfa[5], 0u);
  atomicStore(&jfa[1], 0u);
  atomicAdd(&jfa[7], 1u);
}
fn jfaRound() -> bool { return atomicLoad(&jfa[0]) != 0u && atomicLoad(&jfa[6]) == 0u && fieldOk(AP.u2.x); }
fn jfaVal(w: u32) -> f32 { return bitcast<f32>(atomicLoad(&jfa[jfaPlane(5u) + w])); }

@compute @workgroup_size(8, 8)
fn jfaRInit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!jfaRound() || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  var edge = false;
  if (jfaVal(winIdx(p)) < FAR) {
    for (var d = 0u; d < NDIR; d++) {
      let q = nbr(p, d);
      if (inMap(q) && inScope(q) && jfaVal(winIdx(q)) >= FAR) { edge = true; }
    }
  }
  atomicStore(&jfa[jfaPlane(0u) + winIdx(p)], select(0u, (winIdx(p) << 2u) + 1u, edge));
}
@compute @workgroup_size(8, 8)
fn jfaRPass(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!jfaRound() || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let k = atomicLoad(&jfa[1]);
  let n = atomicLoad(&jfa[4]);
  let src = jfaPlane(select(1u, 0u, k % 2u == 0u));
  let dst = jfaPlane(select(0u, 1u, k % 2u == 0u));
  let p = vec2<i32>(id.xy);
  let step = 1 << (n - 1u - k);
  var best = 0u;
  var bd = FAR;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = p + vec2<i32>(dx, dy) * step;
      if (!inMap(q)) { continue; }
      let c = atomicLoad(&jfa[src + winIdx(q)]);
      if (c == 0u) { continue; }
      let cw = (c - 1u) >> 2u;
      let d = jfaVal(cw) + hexDist(p, jfaXY(cw)) * LOS_CMAX;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
  }
  atomicStore(&jfa[dst + winIdx(p)], best);
}
@compute @workgroup_size(8, 8)
fn jfaRApply(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!jfaRound() || id.x >= G.mapW || id.y >= G.mapH) { return; }
  let f = AP.u2.x;
  let p = vec2<i32>(id.xy);
  let w = winIdx(p);
  if (!inScope(p) || jfaVal(w) < FAR) { return; }
  let c = atomicLoad(&jfa[jfaPlane(select(1u, 0u, atomicLoad(&jfa[4]) % 2u == 0u)) + w]);
  if (c == 0u) { return; }
  let cw = (c - 1u) >> 2u;
  let sp = jfaXY(cw);
  let s = colIdxI(p) * NAV_K;
  if (navZ(s) < 0.0 || !losClear(cellPos(p), cellPos(sp))) { return; }
  jfaResolve(p, s, jfaVal(cw) + hexDist(p, sp) * LOS_CMAX, atomicLoad(&jfa[jfaPlane(6u) + cw]));
}

// ---- (FC12 stage 2, UNIT_MINDS_U2.md §9f) line of sight, seen-only targets, ranged units --------------------------------
// mail (binding 16; agents.ts MAIL_*), u32 words:
//   head   [0] arrows fired (the ring's cursor), [1] frames from a target coming into sight to the first shot, summed,
//          [2] how many, [3] shots, [4] arrows landed on their target, [5] missed (the target gone), [6] direct steps
//   aim    12 a slot, written once a frame by aimTick (after notice) and read by the step — the target as the last frame
//          left it, so no unit reads another's row while that one's own thread writes it: 0-2 the target's feet, 3 its
//          code, 4-6 where it was last seen, 7 flags (AIM_SEEN now, AIM_EVER seen since taken, AIM_SHOT fired since it
//          came into sight, AIM_INRANGE in its range and sight — the step's), 8 the tick it was last seen, 9 the tick
//          it came into sight, 10 the tick it came into range and sight (the step's: time to act counts from it)
//   acc    2 a slot: damage landing on it (×256), and who (the highest shooter's id + 1) — added by arrowStep, taken and
//          cleared by the unit's own step
//   arrows MAIL_ARROWS of 12: 0 the target's code, 1 the shooter's id + 1, 2 damage, 3 seconds left, 4 seconds in all,
//          5-7 from, 8-10 to, 11 alive
@group(0) @binding(16) var<storage, read_write> mail: array<atomic<u32>>;
const MAIL_HEAD: u32 = 16u;
const MAIL_AIM: u32 = 16u;
const AIM_W: u32 = 12u;
const MAIL_ACC: u32 = MAIL_AIM + MAX_SLOTS * AIM_W;
const MAIL_ARR: u32 = MAIL_ACC + MAX_SLOTS * 2u;
const MAIL_ARROWS: u32 = 2048u;
const ARROW_W: u32 = 12u;
// (U2 round 5/6) the order groups' records, the join queue and the rank table (orders.wgsl writes them; the step reads a
// unit's rank entry). Layout: agents.ts mirrors it
/** (U2 round 7) the order groups: sized from memory (agents.ts orderGroups, substituted) */
const ORDER_GROUPS: u32 = 8u;
/** a unit's order word (mail aim word 11): its group + 1 (low 16 bits; 0 none) and its rank (high 16) */
fn ogPack(g: u32, rank: u32) -> u32 { return (g + 1u) | (rank << 16u); }
fn ogGroup(w: u32) -> u32 { return w & 0xffffu; }
fn ogRank(w: u32) -> u32 { return w >> 16u; }
const ALTS: u32 = 3u;
const REF_W: u32 = 6u;
const REF_AT: u32 = 20u;
/** (round 6) a group's formation words from here, its trail ring and its wall runs (orders.wgsl) */
const FORM_AT: u32 = REF_AT + ALTS * 2u * REF_W;
const TRAIL_N: u32 = 32u;
const TRAIL_AT: u32 = FORM_AT + 16u;
const RUNS: u32 = 8u;
const RUN_W: u32 = 8u;
const RUNS_AT: u32 = TRAIL_AT + TRAIL_N * 4u;
const GROUP_W: u32 = RUNS_AT + RUNS * RUN_W + 8u;
/** (U2 round 7) the man order's run fields, a word each (up to 4; FORM_AT + 15 their count) */
const RUNF_AT: u32 = RUNS_AT + RUNS * RUN_W;
const MAIL_GRP: u32 = MAIL_ARR + MAIL_ARROWS * ARROW_W;
const MAIL_Q: u32 = MAIL_GRP + ORDER_GROUPS * GROUP_W;
/** the joins a step at most: one a unit slot (agents.ts ORDER_Q) */
const ORDER_Q: u32 = MAX_SLOTS;
/** the rank table: RANKS a group, RANK_W words each — 0-2 its target, 3 its mode (RANK_*) | RANK_LEAVE, 4 its unit's
 *  slot + 1 (groupCount, last frame), 5 its distance to its target then (f32), 6 its row, 7 its field (RANK_FIELD) */
const RANKS: u32 = 64u;
const RANK_W: u32 = 8u;
const MAIL_RANKS: u32 = MAIL_Q + 1u + ORDER_Q * 3u;
const RANK_NONE: u32 = 0u;
const RANK_STEER: u32 = 1u;
const RANK_FIELD: u32 = 2u;
const RANK_LEAVE: u32 = 0x10000u;
/** a unit left the window on a march that leaves (U2 round 6): its slot free, no death */
const EV_LEFT: u32 = 22u;
fn rankO(g: u32, r: u32) -> u32 { return MAIL_RANKS + (g * RANKS + r) * RANK_W; }
const AIM_SEEN: u32 = 1u;
const AIM_EVER: u32 = 2u;
const AIM_SHOT: u32 = 4u;
const AIM_INRANGE: u32 = 8u;
/** (U2 round 5b, §9f) told of this target — an order (Agents.tell), or it struck this unit — not only noticed: hunted
 *  where it is even when never seen (seen-only hunts only the last-seen place of what was noticed) */
const AIM_TOLD: u32 = 16u;
/** notice.wgsl EV_NOTICED: a unit took a target (the step's own: struck, it turns on who struck it) */
const EV_NOTICED_U: u32 = 9u;
/** a hurt's or death's `other`: a unit's id (its arrow) — agents.ts BY_UNIT */
const BY_UNIT: u32 = 0x40000000u;
/** AP.u2.z: line of sight on (melee steers straight at a target in sight; ranged kinds shoot), seen-only targets */
const LOS_ON: u32 = 1u;
const SEEN_ONLY: u32 = 2u;
/** cells a second an arrow flies (its flight time: the distance over this) */
const ARROW_SPEED: f32 = 24.0;
/** seconds out of sight after which a seen-only target's last-seen place stops being chased */
const SEEN_GIVEUP: f32 = 4.0;
/** a tick's seconds (sim/flow.ts TICK_DT): AP.n.w counts ticks */
const AIM_TICK_S: f32 = 1.0 / 60.0;
fn mailF(i: u32) -> f32 { return bitcast<f32>(atomicLoad(&mail[i])); }
fn mailSetF(i: u32, v: f32) { atomicStore(&mail[i], bitcast<u32>(v)); }
fn mailV3(i: u32) -> vec3<f32> { return vec3<f32>(mailF(i), mailF(i + 1u), mailF(i + 2u)); }
fn mailSetV3(i: u32, v: vec3<f32>) { mailSetF(i, v.x); mailSetF(i + 1u, v.y); mailSetF(i + 2u, v.z); }

/**
 * REPLACE: GPU physics rigid bodies. fireArrow — fire(from, to, kind) → a hit lands in the target's accumulator: today an arrow is
 * a delayed hit (the flight time) with a drawn tracer, not a body. The interface — a shooter, a target code, a damage,
 * from, to — is what arrows as rigid bodies keep (BACKLOG U2-RANGED).
 */
fn fireArrow(shooter: u32, code: u32, damage: f32, at: vec3<f32>, to: vec3<f32>) {
  let k = atomicAdd(&mail[0], 1u) % MAIL_ARROWS;
  let o = MAIL_ARR + k * ARROW_W;
  let t = max(length(to.xy - at.xy) / ARROW_SPEED, 0.05);
  atomicStore(&mail[o], code);
  atomicStore(&mail[o + 1u], shooter + 1u);
  mailSetF(o + 2u, damage);
  mailSetF(o + 3u, t);
  mailSetF(o + 4u, t);
  mailSetV3(o + 5u, at);
  mailSetV3(o + 8u, to);
  atomicStore(&mail[o + 11u], 1u);
  atomicAdd(&mail[3], 1u);
}

/** (once a step, after it) the arrows in flight counted down; one landing adds to its target's accumulator */
@compute @workgroup_size(64)
fn arrowStep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= MAIL_ARROWS) { return; }
  let o = MAIL_ARR + id.x * ARROW_W;
  if (atomicLoad(&mail[o + 11u]) == 0u) { return; }
  let left = mailF(o + 3u) - AP.step.x;
  mailSetF(o + 3u, left);
  if (left > 0.0) { return; }
  atomicStore(&mail[o + 11u], 0u);
  let code = atomicLoad(&mail[o]);
  let t = (code - 1u) % MAX_SLOTS;
  let info = unitInfo(units[t * UNIT_V]);
  if (code == 0u || t >= AP.n.x || ((info >> 8u) & 1u) == 0u || unitId(t, info) != code - 1u) {
    atomicAdd(&mail[5], 1u);
    return;
  }
  atomicAdd(&mail[MAIL_ACC + t * 2u], u32(max(mailF(o + 2u), 0.0) * 256.0));
  atomicMax(&mail[MAIL_ACC + t * 2u + 1u], atomicLoad(&mail[o + 1u]));
  atomicAdd(&mail[4], 1u);
}

/** (the draw) an arrow in flight: three voxels along its way, on an arc */
@compute @workgroup_size(64)
fn arrowDraw(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= MAIL_ARROWS) { return; }
  let o = MAIL_ARR + id.x * ARROW_W;
  if (atomicLoad(&mail[o + 11u]) == 0u) { return; }
  let start = mailV3(o + 5u) + vec3<f32>(0.0, 0.0, 1.2);
  let to = mailV3(o + 8u) + vec3<f32>(0.0, 0.0, 0.9);
  let f = clamp(1.0 - mailF(o + 3u) / max(mailF(o + 4u), 1e-3), 0.0, 1.0);
  let L = length(to.xy - start.xy);
  let p = mix(start, to, f) + vec3<f32>(0.0, 0.0, 0.12 * L * 4.0 * f * (1.0 - f));
  let d = normalize(to - start + vec3<f32>(0.0, 0.0, 0.48 * L * (1.0 - 2.0 * f)) + vec3<f32>(1e-4, 0.0, 0.0));
  let k = atomicAdd(&drawArgs[1], 3u);
  for (var j = 0u; j < 3u; j++) { putVoxel(k + j, p - d * (f32(j) * 0.2), MAT_WOOD | (3u << 24u), vec4<f32>(0.0, 0.0, 0.0, 1.0)); }
}

/** (once a frame, after notice) each fighter's target as it stands now, and whether it's in sight (the clearance) */
@compute @workgroup_size(64)
fn aimTick(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  let o = MAIL_AIM + u * AIM_W;
  let a = units[u * UNIT_V];
  let info = unitInfo(a);
  let code = bitcast<u32>(units[u * UNIT_V + 5u].y);
  if (((info >> 8u) & 1u) == 0u || code == 0u || (code & 0x80000000u) != 0u) {
    atomicStore(&mail[o + 3u], 0u);
    atomicStore(&mail[o + 7u], 0u);
    return;
  }
  let t = (code - 1u) % MAX_SLOTS;
  let ta = units[t * UNIT_V];
  if (t >= AP.n.x || ((unitInfo(ta) >> 8u) & 1u) == 0u || unitId(t, unitInfo(ta)) != code - 1u) {
    atomicStore(&mail[o + 3u], 0u);
    atomicStore(&mail[o + 7u], 0u);
    return;
  }
  var flags = atomicLoad(&mail[o + 7u]);
  if (atomicLoad(&mail[o + 3u]) != code) { flags = 0u; }
  atomicStore(&mail[o + 3u], code);
  mailSetV3(o, ta.xyz);
  let seen = (AP.u2.z & LOS_ON) != 0u && losClear(cellPos(cellAt(a.xy)), cellPos(cellAt(ta.xy)));
  if (seen) {
    if ((flags & AIM_SEEN) == 0u) {
      atomicStore(&mail[o + 9u], AP.n.w);
      flags &= ~AIM_SHOT;
    }
    flags |= AIM_SEEN | AIM_EVER;
    mailSetV3(o + 4u, ta.xyz);
    atomicStore(&mail[o + 8u], AP.n.w);
  } else {
    flags &= ~(AIM_SEEN | AIM_INRANGE);
  }
  atomicStore(&mail[o + 7u], flags);
}
