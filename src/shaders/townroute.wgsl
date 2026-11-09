// ---- the town's route network on the GPU (DA-A22, docs/design/ROUTES_ON_GPU.md; build/routegpu.ts) -----------------
// One graph: the town grid's vertices and edges (static per grid), each structure one more node. Every judgement that
// reads the world reads the live columns (layers through the chunk table, the water sheet) — no CPU copy of the land:
//  - routeCut (per edge): the ground (the top of the highest solid or granular interval that isn't an External claim: a
//    structure's matter is the plan's, not the land's) at its two ends and its middle; deep water at any of the three
//    cuts it (unless the plan spans it: a road's bridge), a rise past SLOPE over either half cuts it (a cliff), past the
//    road grade it's stairs (steep). The plan's bits (a wall across it, inside a block) are ORed in as uploaded.
//  - routeHook / routeJump: connected components by hook-and-jump (the old fortreach / atlas ccHook pattern) over the
//    uncut edges, and each structure's node joined to its doors at grade (its floor within a step of the ground at the
//    edge's middle; a yard everywhere). Five solves at once (z of the dispatch, RP.counts.w of them): the rules as they
//    are, then with one cut lifted — a wall, water, a cliff, every perimeter edge a door — so a refusal says why.
//  - routeQuery (per structure): bit `mode` set when its node is in the stores' vertex's component.
struct RouteParams {
  /** the box's column (0, 0) in the window (dx, dy); the stores' vertex; spare */
  place: vec4<i32>,
  /** vertices, edges, structures, door candidates */
  counts: vec4<u32>,
  /** the window's oz (world z = window z + oz), SLOPE, the road grade, the wading limit (DEEP) */
  rules: vec4<f32>,
  /** STEP (a door's floor to the ground), solves (modes), spare */
  rules2: vec4<f32>,
};
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
/** per vertex its box column (packed: winCol); then per edge its middle's (ne more) */
@group(0) @binding(5) var<storage, read> colOf: array<u32>;
/** per edge: x, y its vertices, z its length (f32 bits), w the plan's bits (RB_WALL, RB_INNER, RB_SPAN) */
@group(0) @binding(6) var<storage, read> edges: array<vec4<u32>>;
/** per edge: x its cut bits (RC_*), y the ground at its middle, z, w at its ends (world z, f32 bits) */
@group(0) @binding(7) var<storage, read_write> cut: array<vec4<u32>>;
/** per door candidate (a structure's perimeter edge): x the edge, y the structure's index, z its floor (world z, f32
 *  bits; NaN: a yard, no floor) */
@group(0) @binding(8) var<storage, read> doors: array<vec4<u32>>;
/** per solve, per node (vertices then structures): its parent */
@group(0) @binding(9) var<storage, read_write> label: array<atomic<u32>>;
/** [0] something moved this iteration; then per structure its answer word */
@group(0) @binding(10) var<storage, read_write> answer: array<atomic<u32>>;
@group(0) @binding(11) var<uniform> RP: RouteParams;

/** the plan's bits (routegpu.ts PLAN_*) */
const RB_WALL: u32 = 1u;
const RB_INNER: u32 = 2u;
const RB_SPAN: u32 = 4u;
/** the cut's bits (routegpu.ts CUT_*: edgenet.ts's CUT_WALL, CUT_WATER, CUT_CLIFF; then steep, inner, off the window) */
const RC_WALL: u32 = 1u;
const RC_WATER: u32 = 2u;
const RC_CLIFF: u32 = 4u;
const RC_STEEP: u32 = 16u;
const RC_INNER: u32 = 32u;
const RC_OFF: u32 = 64u;
/** the lift of solve m: none, a wall, water, a cliff, every perimeter edge a door */
const LIFTS: array<u32, 5> = array<u32, 5>(0u, 1u, 2u, 4u, 8u);

fn nodes() -> u32 { return RP.counts.x + RP.counts.z; }

/** a box column ((k + 32768) | (r + 32768) << 16: routegraph.ts packCol) → its window column; (-1, -1) off the window */
fn winCol(packed: u32) -> vec2<i32> {
  let p = vec2<i32>(i32(packed & 0xffffu) - 32768, i32(packed >> 16u) - 32768) + RP.place.xy;
  if (!inMap(p)) { return vec2<i32>(-1, -1); }
  return p;
}

/** the land's top at a window column (window z): the highest solid or granular interval not an External claim */
fn landTop(p: vec2<i32>) -> f32 {
  let cs = colSlots(u32(p.x), u32(p.y));
  var top = -1e9;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    let m = ivMat(v);
    if (m == MAT_EXTERNAL) { continue; }
    let st = matState(m);
    if (st == ST_SOLID || st == ST_GRANULAR) { top = max(top, ivZ1(v)); }
  }
  return top;
}

@compute @workgroup_size(64)
fn routeCut(@builtin(global_invocation_id) id: vec3<u32>) {
  let e = id.x;
  if (e >= RP.counts.y) { return; }
  let ed = edges[e];
  let pa = winCol(colOf[ed.x]);
  let pb = winCol(colOf[ed.y]);
  let pm = winCol(colOf[RP.counts.x + e]);
  var bits = 0u;
  if ((ed.w & RB_WALL) != 0u) { bits |= RC_WALL; }
  if ((ed.w & RB_INNER) != 0u) { bits |= RC_INNER; }
  if (pa.x < 0 || pb.x < 0 || pm.x < 0) {
    cut[e] = vec4<u32>(bits | RC_OFF, bitcast<u32>(-1e9), bitcast<u32>(-1e9), bitcast<u32>(-1e9));
    return;
  }
  let ga = landTop(pa);
  let gb = landTop(pb);
  let gm = landTop(pm);
  let deep = RP.rules.w;
  let wet = water[colIdxI(pa)] > deep || water[colIdxI(pb)] > deep || water[colIdxI(pm)] > deep;
  if (wet && (ed.w & RB_SPAN) == 0u) { bits |= RC_WATER; }
  // (the drop along it: the highest of its three samples less the lowest, over its length � the stair pitch's rule)
  let rise = (max(max(ga, gb), gm) - min(min(ga, gb), gm)) / max(bitcast<f32>(ed.z), 1e-3);
  if (rise > RP.rules.y) { bits |= RC_CLIFF; }
  else if (rise > RP.rules.z) { bits |= RC_STEEP; }
  let oz = RP.rules.x;
  cut[e] = vec4<u32>(bits, bitcast<u32>(gm + oz), bitcast<u32>(ga + oz), bitcast<u32>(gb + oz));
}

@compute @workgroup_size(64)
fn routeInit(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = id.x;
  if (n >= nodes()) { return; }
  atomicStore(&label[id.z * nodes() + n], n);
}

fn find(base: u32, n: u32) -> u32 {
  var r = atomicLoad(&label[base + n]);
  for (var i = 0u; i < 64u; i++) {
    let q = atomicLoad(&label[base + r]);
    if (q == r) { break; }
    r = q;
  }
  return r;
}

/** u and v (nodes) joined in solve `m`'s labels: the higher root hooked under the lower */
fn hook(base: u32, u: u32, v: u32) {
  let ru = find(base, u);
  let rv = find(base, v);
  if (ru == rv) { return; }
  let lo = min(ru, rv);
  let hi = max(ru, rv);
  let old = atomicMin(&label[base + hi], lo);
  if (old > lo) { atomicStore(&answer[0], 1u); }
}

/** whether edge e is walked in a solve that lifts `lift` */
fn walkable(e: u32, lift: u32) -> bool {
  let c = cut[e].x;
  if ((c & (RC_INNER | RC_OFF)) != 0u) { return false; }
  return (c & (RC_WALL | RC_WATER | RC_CLIFF) & ~lift) == 0u;
}

/** over the edges, then the door candidates (one thread each) */
@compute @workgroup_size(64)
fn routeHook(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let m = id.z;
  let base = m * nodes();
  let lift = LIFTS[m];
  let ne = RP.counts.y;
  if (i < ne) {
    if (walkable(i, lift)) { hook(base, edges[i].x, edges[i].y); }
    return;
  }
  let j = i - ne;
  if (j >= RP.counts.w) { return; }
  let d = doors[j];
  let c = cut[d.x];
  if ((c.x & (RC_INNER | RC_OFF)) != 0u) { return; }
  let floor = bitcast<f32>(d.z);
  // (a door at grade: its floor within a step of the ground at the edge's middle; a yard has no floor — any edge)
  let atGrade = floor != floor || abs(floor - bitcast<f32>(c.y)) <= RP.rules2.x;
  if (!atGrade && (lift & 8u) == 0u) { return; }
  let s = RP.counts.x + d.y;
  hook(base, s, edges[d.x].x);
  hook(base, s, edges[d.x].y);
}

@compute @workgroup_size(64)
fn routeJump(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = id.x;
  if (n >= nodes()) { return; }
  let base = id.z * nodes();
  let pa = atomicLoad(&label[base + n]);
  let pp = atomicLoad(&label[base + pa]);
  if (pp < pa) {
    atomicStore(&label[base + n], pp);
    atomicStore(&answer[0], 1u);
  }
}

@compute @workgroup_size(64)
fn routeQuery(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= RP.counts.z) { return; }
  let base = id.z * nodes();
  let sv = u32(RP.place.z);
  if (find(base, RP.counts.x + s) == find(base, sv)) { atomicOr(&answer[1u + s], 1u << id.z); }
}
