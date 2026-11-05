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
//  - answers: per query (a planned block's stands: up to four columns) whether one stand's top surface has the stores'
//    label, OR-ed into its word at bit RP.mode.y; the columns under a drop up to the stores' component (a rise of STEP
//    to DROP: where a ramp would join them); the wet columns (for the lanes).
// Why a place isn't reached is the same solve with a rule lifted (RP.mode.x: 1 deep water no bar, 2 the plan's solid
// left out): reached then, that rule is why. The rules are the agents' (agents.wgsl: keep the constants in step). A drop
// walked down but not up (STEP to DROP) joins nothing: a component is where a walker gets to AND back from.

struct ReachParams {
  /** the box's first window column (x, y), its size (w, h) */
  box: vec4<i32>,
  /** the stores' column in the box (x, y; -1 none), the queries, 1 when the wet columns are asked for */
  stores: vec4<i32>,
  /** x the rules lifted (1 deep water, 2 the plan's solid), y the bit the queries' answers go to */
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
/** per query four box columns + 1 (0: none) */
@group(0) @binding(10) var<storage, read> query: array<u32>;
/** [0] ramp spots found, [1 ..] RAMP_CAP pairs (box column, direction), then a word a query, then the wet bits */
@group(0) @binding(11) var<storage, read_write> answer: array<atomic<u32>>;
@group(0) @binding(12) var<uniform> RP: ReachParams;

const RNAV_K: u32 = 4u;
const R_AGENT_H: f32 = 1.5;
const R_STEP: f32 = 1.1;
const R_DROP: f32 = 2.6;
const R_DEEP: f32 = 0.9;
/** fortress.ts LANE_WATER: no roads under water this deep */
const R_LANE_WATER: f32 = 0.8;
const RAMP_CAP: u32 = 64u;
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
    let a = f32(w & 0xffffu) / 8.0;
    let c = f32(w >> 16u) / 8.0;
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

/** the stores' surface: the top one walkers use in its column (NODE_NONE: none) */
fn storesNode() -> u32 {
  if (RP.stores.x < 0) { return NODE_NONE; }
  let b = u32(RP.stores.y) * boxW() + u32(RP.stores.x);
  for (var k = 0u; k < RNAV_K; k++) {
    if (live(b * RNAV_K + k)) { return b * RNAV_K + k; }
  }
  return NODE_NONE;
}

/** per query: a stand's top surface in the stores' component → bit RP.mode.y; no stand in the box → bit 4 */
@compute @workgroup_size(64)
fn reachQuery(@builtin(global_invocation_id) id: vec3<u32>) {
  let qi = id.x;
  if (qi >= u32(RP.stores.z)) { return; }
  let sn = storesNode();
  let sr = select(NODE_NONE, root(sn), sn != NODE_NONE);
  var bits = 0u;
  var any = false;
  for (var t = 0u; t < 4u; t++) {
    let c = query[qi * 4u + t];
    if (c == 0u) { continue; }
    any = true;
    let s = (c - 1u) * RNAV_K;
    if (live(s) && sr != NODE_NONE && root(s) == sr) { bits |= 1u << RP.mode.y; }
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
