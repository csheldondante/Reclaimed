// (round 128p, DA-B22 (c)(3); DESIGN §11, §19) Combat targeting on the GPU: who fights whom, once a frame after the
// units' last step (agents/notice.ts, an agents stage). The CPU no longer reads every unit to choose: each fighter's
// target lives in its record (unit word f.y), a new one is told as a `noticed` event, and the game's rules over who
// may take on whom are data (the units' combat words, a per-column side map, a few flags), uploaded when they change.
//
// Three kernels:
//   bucketClear  every bucket's list emptied
//   bucketFill   every live unit pushed onto its bucket's list (BUCKET × BUCKET columns): head[b] → next[u] → …
//   notice       each fighter (hostile, guard, or one given a target) keeps its target while the rules allow, else
//                takes the nearest it may fight within its sight: the buckets in rings out from its own, stopping
//                once a ring lies farther than the best found (or its sight). A hostile with a target marks the hunt's
//                candidates (`hunted`): its target, and everyone it may fight within its sight (its whole disk)
//   huntWrite    each unit's `hunted` into its record (f.z), for the CPU's choice of the hunt's targets
//
// A target code (word f.y, u32): 0 none; a unit's id + 1 (generation × MAX_SLOTS + slot: a slot taken again isn't
// the same target); ACTOR | i the i-th actor of the frame (NP.actors: the game's own, e.g. the hero).

@group(0) @binding(7) var<storage, read_write> units: array<vec4<f32>>;
@group(0) @binding(13) var<storage, read_write> events: array<atomic<u32>>;
// per slot: x the combat flags (CW_*; bits 0-7 the faction, 255 none), y its sight (f32 bits), z w its home (a guard's
// post: f32 bits, CW_HOME set)
@group(0) @binding(41) var<storage, read> combat: array<vec4<u32>>;
// per window column (window order: y * W + x): its side of the wall (SIDE_*)
@group(0) @binding(42) var<storage, read> sides: array<u32>;
@group(0) @binding(43) var<storage, read_write> head: array<atomic<u32>>;
@group(0) @binding(44) var<storage, read_write> next: array<u32>;
// per slot: how near the nearest hostile hunting it is (f32 bits, atomicMin: positive floats order as their bits) —
// the hunt's candidates (a hunter's target, and whoever it may fight within its sight), copied to unit word f.z
@group(0) @binding(46) var<storage, read_write> hunted: array<atomic<u32>>;

struct NoticeParams {
  // x unit slots, y actors, z targets set this frame, w rule flags (NR_*)
  n: vec4<u32>,
  // x y the buckets across and down, z the events' capacity, w unused
  dims: vec4<u32>,
  // x the most two may differ in height and still fight (rules on), y the leash (cells), zw unused
  f: vec4<f32>,
  // the actors: x y z, w 1 alive
  actors: array<vec4<f32>, 8>,
  // the actors' factions (255 none), four a vec4
  actorFac: array<vec4<u32>, 2>,
  // targets set by the game this frame (an order, a unit struck turning on who struck it): slot, code — two a vec4
  sets: array<vec4<u32>, 32>,
};
@group(0) @binding(45) var<uniform> NP: NoticeParams;

const UNIT_V: u32 = 6u;
const MAX_SLOTS: u32 = 8192u;
const NONE: u32 = 0xffffffffu;
const ACTOR: u32 = 0x80000000u;
const BUCKET: i32 = 16;
const EV_NOTICED: u32 = 9u;
const NO_FACTION: u32 = 255u;
const INF_BITS: u32 = 0x7f800000u;

// combat flags (agents/notice.ts CW mirrors them)
const CW_HOSTILE: u32 = 0x100u;
const CW_GUARD: u32 = 0x200u;
// neither fights nor is fought while the rules are on (in at home, a cart)
const CW_NOFIGHT: u32 = 0x400u;
// holds its post: never takes anyone on (an archer on the wall)
const CW_POSTED: u32 = 0x800u;
// a raider: the rules over sides and height apply where one is involved
const CW_RAIDER: u32 = 0x1000u;
// raised by another (bound): out of the fighting here, either way
const CW_BOUND: u32 = 0x2000u;
const CW_HOME: u32 = 0x4000u;
// the game's rule flags
const NR_RULES: u32 = 1u;
const NR_OPEN: u32 = 2u;

fn alive(u: u32) -> bool { return ((bitcast<u32>(units[u * UNIT_V].w) >> 8u) & 1u) != 0u; }
fn idOf(u: u32) -> u32 { return (bitcast<u32>(units[u * UNIT_V].w) >> 16u) * MAX_SLOTS + u; }
fn posOf(u: u32) -> vec3<f32> { return units[u * UNIT_V].xyz; }
fn faction(w: u32) -> u32 { return w & 0xffu; }

fn bucketOf(p: vec2<f32>) -> vec2<i32> {
  let c = clamp(cellAt(p), vec2<i32>(0), vec2<i32>(i32(G.mapW) - 1, i32(G.mapH) - 1));
  return c / BUCKET;
}

fn sideOf(p: vec2<f32>) -> u32 {
  let c = clamp(cellAt(p), vec2<i32>(0), vec2<i32>(i32(G.mapW) - 1, i32(G.mapH) - 1));
  return sides[winIdx(c)];
}

/** whether `h` (slot, flags) may take on unit `x` (the game's rules: the fortress raid's mayFight, as data) */
fn mayFight(h: u32, hw: u32, x: u32) -> bool {
  if (x == h || !alive(x)) { return false; }
  let xw = combat[x].x;
  if ((xw & CW_BOUND) != 0u) { return false; }
  // (who's whose enemy: a hostile hunts the peaceful of another faction; the peaceful take on hostiles)
  if ((hw & CW_HOSTILE) != 0u) {
    if ((xw & CW_HOSTILE) != 0u || faction(xw) == faction(hw)) { return false; }
  } else if ((xw & CW_HOSTILE) == 0u) {
    return false;
  }
  if ((NP.n.w & NR_RULES) == 0u) { return true; }
  if ((hw & CW_POSTED) != 0u) { return false; }
  if (((hw | xw) & CW_RAIDER) == 0u) { return true; }
  if (((hw | xw) & CW_NOFIGHT) != 0u) { return false; }
  let a = posOf(h);
  let b = posOf(x);
  if (abs(a.z - b.z) > NP.f.x) { return false; }
  return (NP.n.w & NR_OPEN) != 0u || sideOf(a.xy) == sideOf(b.xy);
}

fn actorFaction(i: u32) -> u32 { return NP.actorFac[i / 4u][i % 4u]; }

@compute @workgroup_size(64)
fn bucketClear(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= NP.dims.x * NP.dims.y) { return; }
  atomicStore(&head[id.x], NONE);
}

@compute @workgroup_size(64)
fn bucketFill(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= NP.n.x || !alive(u)) { return; }
  let b = bucketOf(posOf(u).xy);
  next[u] = atomicExchange(&head[u32(b.y) * NP.dims.x + u32(b.x)], u);
}

/** (over every slot, before notice) nobody hunted yet this frame */
@compute @workgroup_size(64)
fn huntClear(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= NP.n.x) { return; }
  atomicStore(&hunted[id.x], INF_BITS);
}

@compute @workgroup_size(64)
fn huntWrite(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= NP.n.x || !alive(u)) { return; }
  var rec = units[u * UNIT_V + 5u];
  rec.z = bitcast<f32>(atomicLoad(&hunted[u]));
  units[u * UNIT_V + 5u] = rec;
}

fn emitNoticed(id: u32, code: u32, p: vec3<f32>) {
  let e = atomicAdd(&events[0], 1u);
  if (e - atomicLoad(&events[2]) >= NP.dims.z) { return; }
  let o = 4u + (e % NP.dims.z) * 8u;
  atomicStore(&events[o + 7u], e);
  atomicStore(&events[o], EV_NOTICED);
  atomicStore(&events[o + 1u], id);
  atomicStore(&events[o + 2u], code);
  atomicStore(&events[o + 3u], 0u);
  atomicStore(&events[o + 4u], bitcast<u32>(p.x));
  atomicStore(&events[o + 5u], bitcast<u32>(p.y));
  atomicStore(&events[o + 6u], bitcast<u32>(p.z));
}

/** where target `code` stands (w 0: gone) */
fn targetAt(code: u32) -> vec4<f32> {
  if (code == 0u) { return vec4<f32>(0.0); }
  if ((code & ACTOR) != 0u) {
    let i = code & ~ACTOR;
    if (i >= NP.n.y) { return vec4<f32>(0.0); }
    return NP.actors[i];
  }
  let s = (code - 1u) % MAX_SLOTS;
  if (s >= NP.n.x || !alive(s) || idOf(s) != code - 1u) { return vec4<f32>(0.0); }
  return vec4<f32>(posOf(s), 1.0);
}

@compute @workgroup_size(64)
fn notice(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= NP.n.x || !alive(u)) { return; }
  let cw = combat[u];
  let hw = cw.x;
  if ((hw & CW_BOUND) != 0u) { return; }
  let hostile = (hw & CW_HOSTILE) != 0u;
  let sight = bitcast<f32>(cw.y);
  var rec = units[u * UNIT_V + 5u];
  let was = bitcast<u32>(rec.y);
  var t = was;
  // (the game's own this frame: an order, a strike answered)
  for (var k = 0u; k < NP.n.z; k++) {
    let s = NP.sets[k / 2u];
    let pair = select(s.zw, s.xy, k % 2u == 0u);
    if (pair.x == u) { t = pair.y; }
  }
  let me = posOf(u);
  // (kept while it lives, may be fought and is within the leash)
  if (t != 0u) {
    let p = targetAt(t);
    var keep = p.w > 0.0;
    if (keep && (t & ACTOR) == 0u) { keep = mayFight(u, hw, (t - 1u) % MAX_SLOTS); }
    if (keep && hostile) { keep = length(p.xy - me.xy) <= max(sight * 2.0, NP.f.y); }
    if (keep && !hostile && (hw & CW_HOME) != 0u) {
      keep = length(p.xy - vec2<f32>(bitcast<f32>(cw.z), bitcast<f32>(cw.w))) <= NP.f.y;
    }
    if (!keep) { t = 0u; }
  }
  // (none: the nearest it may fight within its sight — hostiles and guards look; the rest wait to be given one. A
  // hostile looks over its whole sight, marking the hunt's candidates; a guard stops once a ring lies past its best)
  let looks = sight > 0.0 && (hostile || (hw & CW_GUARD) != 0u);
  let seek = t == 0u && looks;
  if (looks && (seek || hostile)) {
    var best = sight;
    var found = 0u;
    if (hostile && seek) {
      for (var a = 0u; a < NP.n.y; a++) {
        let p = NP.actors[a];
        let f = actorFaction(a);
        if (p.w <= 0.0 || (f != NO_FACTION && f == faction(hw))) { continue; }
        let d = length(p.xy - me.xy);
        if (d < best) {
          best = d;
          found = ACTOR | a;
        }
      }
    }
    let hb = bucketOf(me.xy);
    let bw = i32(NP.dims.x);
    let bh = i32(NP.dims.y);
    // (a bucket's least extent: BUCKET rows of ROW_H)
    let ext = f32(BUCKET) * ROW_H;
    let rings = i32(ceil(sight / ext)) + 1;
    for (var k = 0; k <= rings; k++) {
      if (k >= 2 && f32(k - 1) * ext > select(best, sight, hostile)) { break; }
      for (var by = max(hb.y - k, 0); by <= min(hb.y + k, bh - 1); by++) {
        for (var bx = max(hb.x - k, 0); bx <= min(hb.x + k, bw - 1); bx++) {
          // (the ring: the buckets k from its own, Chebyshev)
          if (max(abs(bx - hb.x), abs(by - hb.y)) != k) { continue; }
          var x = atomicLoad(&head[u32(by) * NP.dims.x + u32(bx)]);
          loop {
            if (x == NONE) { break; }
            if (mayFight(u, hw, x)) {
              let d = length(posOf(x).xy - me.xy);
              if (hostile && d < sight) { atomicMin(&hunted[x], bitcast<u32>(d)); }
              if (seek && d < best) {
                best = d;
                found = idOf(x) + 1u;
              }
            }
            x = next[x];
          }
        }
      }
    }
    if (seek) { t = found; }
  }
  // (a hunter's own target is a candidate however far)
  if (hostile && t != 0u && (t & ACTOR) == 0u) {
    let s = (t - 1u) % MAX_SLOTS;
    atomicMin(&hunted[s], bitcast<u32>(length(posOf(s).xy - me.xy)));
  }
  if (t != was) {
    rec.y = bitcast<f32>(t);
    units[u * UNIT_V + 5u] = rec;
    if (t != 0u && hostile) { emitNoticed(idOf(u), t, me); }
  }
}
