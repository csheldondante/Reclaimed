// ---- the fortress's reach on the GPU (round 128l, m4; fortress/reachgpu.ts) ----------------------------------------
// Which places the stores reach, as connected components of the walkable surfaces over the fortress's box — the user:
// "I would probably do connected components of reachable things on the GPU myself but only because I find CPU round
// trips are stupidly expensive on mobile". It replaces the CPU flood (fortress/reach.ts) over columns read back.
//
//  - peel: each box column's solid runs (solid or granular matter, as agents.wgsl surfaces) with the plan's solid as if
//    built merged in (planSpans: up to two spans a column, from fortress/solid.ts), peeled into up to NAV_K surfaces with
//    AGENT_H of room over them, highest first; the top one deep when the water over it is past DEEP;
//  - components: two surfaces of neighbouring columns are joined when a walker steps either way between them (a rise
//    within STEP, AGENT_H of room over the step, both deep or both not: the agents never lead a walker into deep water,
//    so dry to deep is one way, no join). Labels hooked to the least root round them and pointer-jumped (the atlas's
//    GPU flood fill, atlas/build.wgsl ccHook / ccJump) until nothing changes: a few rounds after an edit;
//  - answers: per query (a planned block's stands: up to four columns, each with its floor) whether one stand's surface
//    nearest its floor has the stores' label (round 128o: was the top surface — the roof over a passage's arch), OR-ed into its word at bit RP.mode.y; the columns under a drop up to the stores' component (a rise of STEP
//    to DROP: where a ramp would join them); the wet columns (for the lanes).
// Why a place isn't reached is the same solve with a rule lifted (RP.mode.x: 1 deep water no bar, 2 the plan's solid
// left out): reached then, that rule is why. The rules are the agents' (agents.wgsl: keep the constants in step). A drop
// walked down but not up (STEP to DROP) joins nothing: a component is where a walker gets to AND back from.

struct ReachParams {
  /** the box's first window column (x, y), its size (w, h) */
  box: vec4<i32>,
  /** the stores' column in the box (x, y; -1 none), the queries, 1 when the wet columns are asked for */
  stores: vec4<i32>,
  /** x the rules lifted (1 deep water, 2 the plan's solid), y the bit the queries' answers go to, z the stores' floor
   *  (window z, f32 bits) */
  mode: vec4<u32>,
};
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
/** per box column two spans of the plan's solid as if built: z0 eighths (low 16 bits) | z1 eighths (high); 0 none */
@group(0) @binding(5) var<storage, read> planSpans: array<vec2<u32>>;
/** per box column and slot (b * NAV_K + k): x the surface's height (< 0 none), y the room over it */
@group(0) @binding(6) var<storage, read_write> surf: array<vec2<f32>>;
/** per box column: 1 when its top surface is under deep water */
@group(0) @binding(7) var<storage, read_write> deepTop: array<u32>;
@group(0) @binding(8) var<storage, read_write> label: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> flag: array<atomic<u32>, 4>;
/** per query four stands: box column + 1 (0: none), then its floor (window z, f32 bits) */
@group(0) @binding(10) var<storage, read> query: array<u32>;
/** [0] ramp spots found, [1 ..] RAMP_CAP pairs (box column, direction), then a word a query, then the wet bits */
@group(0) @binding(11) var<storage, read_write> answer: array<atomic<u32>>;
@group(0) @binding(12) var<uniform> RP: ReachParams;
/** (round 128o, B) per box column: 1 when the fix peel left its plan solid out (it may be cut: a passage, a gate) */
@group(0) @binding(13) var<storage, read_write> cutCol: array<u32>;
/** (B) per surface the fix field's cost from the stores (FIX_FAR: none) */
@group(0) @binding(14) var<storage, read_write> fixDist: array<atomic<u32>>;
/** (B) [0] fixes found, then FIX_CAP triples (query, box column, kind (0 cut, 1 ramp) | direction << 8) */
@group(0) @binding(15) var<storage, read_write> fixes: array<atomic<u32>>;

const RNAV_K: u32 = 4u;
const R_AGENT_H: f32 = 1.5;
const R_STEP: f32 = 1.1;
const R_DROP: f32 = 2.6;
const R_DEEP: f32 = 0.9;
/** fortress.ts LANE_WATER: no roads under water this deep */
const R_LANE_WATER: f32 = 0.8;
const RAMP_CAP: u32 = 64u;
/** (B) reach.ts FIX_COST, FIX_CAP */
const FIX_STEP: u32 = 1u;
const FIX_CUT: u32 = 4u;
const FIX_RAMP: u32 = 20u;
const FIX_CAP: u32 = 512u;
const FIX_FAR: u32 = 0xffffffffu;
const NODE_NONE: u32 = 0xffffffffu;

fn boxW() -> u32 { return u32(RP.box.z); }
fn boxH() -> u32 { return u32(RP.box.w); }
fn queryAt() -> u32 { return 1u + 2u * RAMP_CAP; }
fn wetAt() -> u32 { return queryAt() + u32(RP.stores.z); }
/** box column b's window column */
fn winOf(b: u32) -> vec2<i32> { return RP.box.xy + vec2<i32>(i32(b % boxW()), i32(b / boxW())); }
/** window column p's box column (NODE_NONE: outside the box) */
fn boxOf(p: vec2<i32>) -> u32 {
  let q = p - RP.box.xy;
  if (q.x < 0 || q.y < 0 || q.x >= RP.box.z || q.y >= RP.box.w) { return NODE_NONE; }
  return u32(q.y) * boxW() + u32(q.x);
}
fn rSolid(m: u32) -> bool {
  let st = matState(m);
  return st == ST_SOLID || st == ST_GRANULAR;
}
/** a surface walkers use */
fn live(n: u32) -> bool { return surf[n].x >= 0.0; }
/** under deep water (no bar when the solve lifts it) */
fn rDeep(n: u32) -> bool { return (RP.mode.x & 1u) == 0u && n % RNAV_K == 0u && deepTop[n / RNAV_K] == 1u; }
fn root(n: u32) -> u32 { return atomicLoad(&label[atomicLoad(&label[n])]); }

/** Peel a box column into surfaces, the plan's solid merged in (unless the solve leaves it out). */
@compute @workgroup_size(8, 8)
fn reachPeel(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let b = id.y * boxW() + id.x;
  for (var k = 0u; k < RNAV_K; k++) { surf[b * RNAV_K + k] = vec2<f32>(-1.0, 0.0); }
  deepTop[b] = 0u;
  cutCol[b] = 0u;
  let p = winOf(b);
  if (!inMap(p)) { return; }
  // the runs bottom up: the column's solid ones and the plan's spans, sorted by their floor, touching ones merged
  var z0s: array<f32, 18>;
  var z1s: array<f32, 18>;
  var n = 0u;
  let cs = colSlots(u32(p.x), u32(p.y));
  for (var k = 0u; k < cs.y && n < 16u; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v) || !rSolid(ivMat(v))) { continue; }
    z0s[n] = ivZ0(v);
    z1s[n] = ivZ1(v);
    n += 1u;
  }
  let ps = planSpans[b];
  for (var e = 0u; e < 2u; e++) {
    let w = select(ps.x, ps.y, e == 1u);
    if (w == 0u || (RP.mode.x & 2u) != 0u) { continue; }
    // (B: the fix peel leaves the plan's cuttable solid out — bit 31 — and marks the column)
    if ((RP.mode.x & 4u) != 0u && (w & 0x80000000u) != 0u) {
      cutCol[b] = 1u;
      continue;
    }
    let a = f32(w & 0xffffu) / 8.0;
    let c = f32((w >> 16u) & 0x7fffu) / 8.0;
    if (c <= a) { continue; }
    // (insertion by floor: the column's runs are bottom up already)
    var i = n;
    while (i > 0u && z0s[i - 1u] > a) {
      z0s[i] = z0s[i - 1u];
      z1s[i] = z1s[i - 1u];
      i -= 1u;
    }
    z0s[i] = a;
    z1s[i] = c;
    n += 1u;
  }
  var tops: array<f32, 18>;
  var bots: array<f32, 18>;
  var m = 0u;
  for (var i = 0u; i < n; i++) {
    if (m > 0u && z0s[i] - tops[m - 1u] < 1e-3) { tops[m - 1u] = max(tops[m - 1u], z1s[i]); continue; }
    bots[m] = z0s[i];
    tops[m] = z1s[i];
    m += 1u;
  }
  var out = 0u;
  var r = i32(m) - 1;
  while (r >= 0 && out < RNAV_K) {
    var head = 31.0;
    if (u32(r) + 1u < m) { head = bots[r + 1] - tops[r]; }
    if (head >= R_AGENT_H) {
      surf[b * RNAV_K + out] = vec2<f32>(tops[r], min(head, 31.0));
      out += 1u;
    }
    r -= 1;
  }
  // (the water sheet lies on the top surface only)
  if (out > 0u && water[colIdx(u32(p.x), u32(p.y))] > R_DEEP) { deepTop[b] = 1u; }
}

@compute @workgroup_size(8, 8)
fn reachInit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let b = id.y * boxW() + id.x;
  for (var k = 0u; k < RNAV_K; k++) { atomicStore(&label[b * RNAV_K + k], b * RNAV_K + k); }
}

/** whether surfaces s and t (neighbouring columns) join: a step either way */
fn joins(s: u32, t: u32) -> bool {
  let a = surf[s];
  let c = surf[t];
  if (abs(c.x - a.x) > R_STEP) { return false; }
  if (min(a.x + a.y, c.x + c.y) - max(a.x, c.x) < R_AGENT_H) { return false; }
  return rDeep(s) == rDeep(t);
}

@compute @workgroup_size(8, 8)
fn reachHook(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let b = id.y * boxW() + id.x;
  let p = winOf(b);
  for (var k = 0u; k < RNAV_K; k++) {
    let s = b * RNAV_K + k;
    if (!live(s)) { continue; }
    let mine = root(s);
    var best = mine;
    for (var d = 0u; d < NDIR; d++) {
      let qb = boxOf(nbr(p, d));
      if (qb == NODE_NONE) { continue; }
      for (var j = 0u; j < RNAV_K; j++) {
        let t = qb * RNAV_K + j;
        if (!live(t) || !joins(s, t)) { continue; }
        best = min(best, root(t));
      }
    }
    if (best < mine) {
      // (parents only ever go down, within the component: always a forest)
      let old = atomicMin(&label[mine], best);
      if (old > best) { atomicStore(&flag[0], 1u); }
      atomicMin(&label[s], best);
    }
  }
}

@compute @workgroup_size(8, 8)
fn reachJump(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let b = id.y * boxW() + id.x;
  for (var k = 0u; k < RNAV_K; k++) {
    let s = b * RNAV_K + k;
    let pa = atomicLoad(&label[s]);
    let pp = atomicLoad(&label[pa]);
    if (pp < pa) {
      atomicStore(&label[s], pp);
      atomicStore(&flag[0], 1u);
    }
  }
}

/** box column b's surface nearest a floor z (NODE_NONE: none) — reach.ts nearestSurf */
fn nearSurf(b: u32, z: f32) -> u32 {
  var best = NODE_NONE;
  var bd = 1e9;
  for (var k = 0u; k < RNAV_K; k++) {
    let s = b * RNAV_K + k;
    if (!live(s)) { continue; }
    let d = abs(surf[s].x - z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** the stores' surface: its column's nearest the stores' floor (NODE_NONE: none) */
fn storesNode() -> u32 {
  if (RP.stores.x < 0) { return NODE_NONE; }
  return nearSurf(u32(RP.stores.y) * boxW() + u32(RP.stores.x), bitcast<f32>(RP.mode.z));
}

/** per query: a stand's surface nearest its floor in the stores' component → bit RP.mode.y; no stand in the box → bit 4 */
@compute @workgroup_size(64)
fn reachQuery(@builtin(global_invocation_id) id: vec3<u32>) {
  let qi = id.x;
  if (qi >= u32(RP.stores.z)) { return; }
  let sn = storesNode();
  let sr = select(NODE_NONE, root(sn), sn != NODE_NONE);
  var bits = 0u;
  var any = false;
  for (var t = 0u; t < 4u; t++) {
    let cw = query[qi * 8u + 2u * t];
    if (cw == 0u) { continue; }
    let c = cw & 0x7fffffffu;
    let mustOpen = (cw & 0x80000000u) != 0u;
    any = true;
    let fz = bitcast<f32>(query[qi * 8u + 2u * t + 1u]);
    let s = nearSurf(c - 1u, fz);
    // (round 128o, B: a stand is its floor's surface — a roof over it, DROP or more up, isn't where a builder stands)
    if (!mustOpen && s != NODE_NONE && sr != NODE_NONE && abs(surf[s].x - fz) <= R_DROP && root(s) == sr) { bits |= 1u << RP.mode.y; }
  }
  if (!any) { bits |= 16u; }
  atomicOr(&answer[queryAt() + qi], bits);
}

/** the columns under a drop up to the stores' component (a rise of STEP to DROP): where a ramp would join them */
@compute @workgroup_size(8, 8)
fn reachRamps(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let sn = storesNode();
  if (sn == NODE_NONE) { return; }
  let sr = root(sn);
  let b = id.y * boxW() + id.x;
  let s = b * RNAV_K;
  if (!live(s) || root(s) == sr || deepTop[b] == 1u) { return; }
  let p = winOf(b);
  for (var d = 0u; d < NDIR; d++) {
    let qb = boxOf(nbr(p, d));
    if (qb == NODE_NONE || !live(qb * RNAV_K) || root(qb * RNAV_K) != sr) { continue; }
    let rise = surf[qb * RNAV_K].x - surf[s].x;
    if (rise <= R_STEP || rise > R_DROP) { continue; }
    let i = atomicAdd(&answer[0], 1u);
    if (i < RAMP_CAP) {
      atomicStore(&answer[1u + 2u * i], b);
      atomicStore(&answer[2u + 2u * i], d);
    }
  }
}

/** the box columns with water over R_LANE_WATER: a bit each */
@compute @workgroup_size(8, 8)
fn reachWet(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let b = id.y * boxW() + id.x;
  let p = winOf(b);
  if (!inMap(p)) { return; }
  if (water[colIdx(u32(p.x), u32(p.y))] > R_LANE_WATER) { atomicOr(&answer[wetAt() + (b >> 5u)], 1u << (b & 31u)); }
}

// ---- (round 128o, B) the fix field: the passage chosen on the GPU ------------------------------------------------------
// Over the fix peel (the plan's cuttable solid left out), the cost from the stores' surface: a step FIX_STEP, entering a
// cut column FIX_CUT more, a drop a ramp would join (STEP to DROP, either way) FIX_RAMP more — relaxed (Bellman-Ford) to
// the end. Then from each query not reached, its stand's surface walked back to the stores: the cut columns entered and
// the ramps taken written down (reach.ts CpuReach: the same sweep order, the same first predecessor).

/** the cost of the move from surface t (column tb) to surface s (column b), FIX_FAR: no move */
fn fixMove(tb: u32, t: u32, b: u32, s: u32) -> u32 {
  let a = surf[t];
  let c = surf[s];
  let rise = abs(c.x - a.x);
  if (min(a.x + a.y, c.x + c.y) - max(a.x, c.x) < R_AGENT_H) { return FIX_FAR; }
  let dt = t % RNAV_K == 0u && deepTop[tb] == 1u;
  let ds = s % RNAV_K == 0u && deepTop[b] == 1u;
  if (dt != ds || rise > R_DROP) { return FIX_FAR; }
  return FIX_STEP + select(0u, FIX_CUT, cutCol[b] == 1u) + select(0u, FIX_RAMP, rise > R_STEP);
}

@compute @workgroup_size(8, 8)
fn fixInit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let b = id.y * boxW() + id.x;
  let sn = storesNode();
  for (var k = 0u; k < RNAV_K; k++) {
    let s = b * RNAV_K + k;
    atomicStore(&fixDist[s], select(FIX_FAR, 0u, s == sn));
  }
}

@compute @workgroup_size(8, 8)
fn fixRelax(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= boxW() || id.y >= boxH()) { return; }
  let b = id.y * boxW() + id.x;
  let p = winOf(b);
  for (var k = 0u; k < RNAV_K; k++) {
    let s = b * RNAV_K + k;
    if (!live(s)) { continue; }
    var best = atomicLoad(&fixDist[s]);
    for (var d = 0u; d < NDIR; d++) {
      let qb = boxOf(nbr(p, d));
      if (qb == NODE_NONE) { continue; }
      for (var j = 0u; j < RNAV_K; j++) {
        let t = qb * RNAV_K + j;
        if (!live(t)) { continue; }
        let dt = atomicLoad(&fixDist[t]);
        if (dt == FIX_FAR) { continue; }
        let c = fixMove(qb, t, b, s);
        if (c == FIX_FAR) { continue; }
        best = min(best, dt + c);
      }
    }
    let old = atomicMin(&fixDist[s], best);
    if (best < old) { atomicStore(&flag[0], 1u); }
  }
}

fn fixPush(q: u32, b: u32, word: u32) {
  let i = atomicAdd(&fixes[0], 1u);
  if (i < FIX_CAP) {
    atomicStore(&fixes[1u + 3u * i], q);
    atomicStore(&fixes[2u + 3u * i], b);
    atomicStore(&fixes[3u + 3u * i], word);
  }
}

/** per query not reached: its stand nearest the stores by the field, walked back; the fixes on the way */
@compute @workgroup_size(64)
fn fixTrace(@builtin(global_invocation_id) id: vec3<u32>) {
  let qi = id.x;
  if (qi >= u32(RP.stores.z)) { return; }
  if ((atomicLoad(&answer[queryAt() + qi]) & 1u) != 0u) { return; }
  var s = NODE_NONE;
  var sd = FIX_FAR;
  for (var t = 0u; t < 4u; t++) {
    let c = query[qi * 8u + 2u * t] & 0x7fffffffu;
    if (c == 0u) { continue; }
    let n = nearSurf(c - 1u, bitcast<f32>(query[qi * 8u + 2u * t + 1u]));
    if (n == NODE_NONE) { continue; }
    let dn = atomicLoad(&fixDist[n]);
    if (dn != FIX_FAR && (s == NODE_NONE || dn < sd)) {
      s = n;
      sd = dn;
    }
  }
  if (s == NODE_NONE) { return; }
  atomicOr(&answer[queryAt() + qi], 32u);
  for (var guard = 0u; guard < 4096u && atomicLoad(&fixDist[s]) > 0u; guard++) {
    let b = s / RNAV_K;
    let p = winOf(b);
    let ds = atomicLoad(&fixDist[s]);
    var prev = NODE_NONE;
    for (var d = 0u; d < NDIR && prev == NODE_NONE; d++) {
      let qb = boxOf(nbr(p, d));
      if (qb == NODE_NONE) { continue; }
      for (var j = 0u; j < RNAV_K; j++) {
        let t = qb * RNAV_K + j;
        if (!live(t)) { continue; }
        let dt = atomicLoad(&fixDist[t]);
        let c = fixMove(qb, t, b, s);
        if (dt == FIX_FAR || c == FIX_FAR || dt + c != ds) { continue; }
        prev = t;
        if (abs(surf[s].x - surf[t].x) > R_STEP) {
          // (the ramp from the lower column up the drop: its direction from the lower to the upper)
          if (surf[s].x < surf[t].x) { fixPush(qi, b, 1u | (d << 8u)); }
          else { fixPush(qi, qb, 1u | ((d ^ 1u) << 8u)); }
        }
        break;
      }
    }
    if (cutCol[b] == 1u) { fixPush(qi, b, 0u); }
    if (prev == NODE_NONE) { return; }
    s = prev;
  }
}
