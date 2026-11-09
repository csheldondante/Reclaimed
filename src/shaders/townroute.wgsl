// ---- the town's route network on the GPU (DA-A22, docs/design/ROUTES_ON_GPU.md; build/routegpu.ts) -----------------
// One graph: the town grid's vertices and edges (static per grid); each structure an end at its doors. Every judgement that
// reads the land reads it through rgValid / rgTop / rgWater (routeground-live.wgsl: the world's live columns in play;
// routeground-raw.wgsl: the raw ground the GPU made of a box, at generation) — no CPU copy of the land.
//  - routeCut (per edge): the ground at its two ends and its middle; deep water at any of the three cuts it (unless the
//    plan spans it: a road's bridge), the drop (highest sample less lowest) over its length past SLOPE cuts it (a
//    cliff), past the road grade it's stairs (steep). The plan's bits (a wall across it, a block's inside) ORed in.
//  - the layout (the drawn paths; edgenet.ts's walks before): field 0 from the middle and the main roads' uncut verge
//    edges (main streets), relaxed to the end; each gate's far corner traced down it — main streets. Field 1 from every
//    main street; each structure's door (of its free doors at grade the nearest the network, onto open ground first)
//    traced down it — its lane. The paths' kinds a byte an edge.
//  - reach (routeHook / routeJump): connected components by hook-and-jump over the edges a walker takes — uncut, not a
//    block's inside, and drawn or with no structure either side (no walk along a building's wall). A structure is one
//    node, a route's end and never a way through (RouteNet's rule): reached when a door at grade has an end in the
//    stores' component. Five solves at once (z of the dispatch): the rules, then with a wall, water, a cliff, every
//    perimeter edge a door lifted, so a refusal says why.
//  - routeStruct (per structure): its answer; with no door at grade, the ground of its walkable side nearest its floor
//    (a terrace's level). routeGates: the wall cells with a corner in the stores' component and one in an unreached
//    structure's — where a gate joins them.
// The riders' fields (2 and up) walk the same edges by the same rule (`walks`), so reach and routes can't differ.
struct RouteParams {
  /** the box's column (0, 0) on the ground (dx, dy); the stores' vertex; the middle's */
  place: vec4<i32>,
  /** vertices, edges, structures, door candidates */
  counts: vec4<u32>,
  /** the ground's oz (world z = its z + oz), SLOPE, the road grade, the wading limit (DEEP) */
  rules: vec4<f32>,
  /** STEP (a door's floor to the ground), spare */
  rules2: vec4<f32>,
  /** the raw ground's size (generation: the box's w, h), the main streets' targets, the wall cells */
  dims: vec4<u32>,
};
struct FieldParams {
  /** x the field, y its costs (0 the layout's, 1 the routes'), z the layout's seed (0 the verge, 1 the main streets) */
  f: vec4<u32>,
};
@group(0) @binding(5) var<storage, read> colOf: array<u32>;
/** per edge: x, y its vertices, z its length (f32 bits), w the plan's bits (RB_*) */
@group(0) @binding(6) var<storage, read> edges: array<vec4<u32>>;
/** per edge: x its cut bits (RC_*), y the ground at its middle, z, w at its ends (world z, f32 bits) */
@group(0) @binding(7) var<storage, read_write> cut: array<vec4<u32>>;
/** per door candidate (a structure's perimeter edge): x the edge, y the structure's index, z its floor (world z, f32
 *  bits; NaN: a yard, no floor), w bit 0: onto open ground (no other structure either side) */
@group(0) @binding(8) var<storage, read> doors: array<vec4<u32>>;
/** per solve, per node (vertices then structures): its parent */
@group(0) @binding(9) var<storage, read_write> label: array<atomic<u32>>;
/** [0] something moved; [1] gates found, then GATE_CAP cells; then per structure ANSWER_W words (routegpu.ts) */
@group(0) @binding(10) var<storage, read_write> answer: array<atomic<u32>>;
@group(0) @binding(11) var<uniform> RP: RouteParams;
/** per vertex its first edge (nv + 1 words), then the edges */
@group(0) @binding(12) var<storage, read> csr: array<u32>;
/** per field, per node: its cost to the field's sources (f32 bits: non-negative floats order as their bits) */
@group(0) @binding(13) var<storage, read_write> dist: array<atomic<u32>>;
/** per edge its drawn kind (1 a lane, 2 a main street; 3 both: a main street), a byte an edge */
@group(0) @binding(14) var<storage, read_write> kind: array<atomic<u32>>;
/** the main streets' targets (a vertex each, RP.dims.z), then the wall cells (RP.dims.w: the cell, its four corners) */
@group(0) @binding(15) var<storage, read> jobs: array<u32>;
/** per structure: x its first door candidate, y how many, z bit 0 far (a road grown to it, no lane), bit 1 solid (a
 *  block or a keep: a terrace when no door is at grade), w its floor (world z, f32 bits) */
@group(0) @binding(16) var<storage, read> structInfo: array<vec4<u32>>;
@group(0) @binding(17) var<uniform> FP: FieldParams;
/** per node (the rules' solve): 1 when it's the root of an unreached structure's component */
@group(0) @binding(18) var<storage, read_write> mark: array<atomic<u32>>;

/** the plan's bits (routegraph.ts PLAN_*) */
const RB_WALL: u32 = 1u;
const RB_INNER: u32 = 2u;
const RB_SPAN: u32 = 4u;
const RB_BUILT: u32 = 8u;
/** the cut's bits (routegpu.ts RC: edgenet.ts's CUT_WALL, CUT_WATER, CUT_CLIFF; then steep, inner, off the ground) */
const RC_WALL: u32 = 1u;
const RC_WATER: u32 = 2u;
const RC_CLIFF: u32 = 4u;
const RC_CUTS: u32 = 7u;
const RC_STEEP: u32 = 16u;
const RC_INNER: u32 = 32u;
const RC_OFF: u32 = 64u;
const KIND_LANE: u32 = 1u;
const KIND_MAIN: u32 = 2u;
/** the lift of solve m: none, a wall, water, a cliff, every perimeter edge a door */
const LIFTS: array<u32, 5> = array<u32, 5>(0u, 1u, 2u, 4u, 8u);
const NONE: u32 = 0xffffffffu;
/** +inf's bits: past every cost */
const FAR: u32 = 0x7f800000u;
/** routegpu.ts GATE_CAP, ANSWER_W */
const GATE_CAP: u32 = 64u;
const ANSWER_W: u32 = 4u;

/** the graph's nodes: its vertices (a structure is a route's end at its doors, not a node of its own) */
fn nodes() -> u32 { return RP.counts.x; }
fn structAt(s: u32) -> u32 { return 2u + GATE_CAP + s * ANSWER_W; }

/** a box column ((k + 32768) | (r + 32768) << 16: routegraph.ts packCol) → the ground's column; (-1, -1) off it */
fn groundCol(packed: u32) -> vec2<i32> {
  let p = vec2<i32>(i32(packed & 0xffffu) - 32768, i32(packed >> 16u) - 32768) + RP.place.xy;
  if (!rgValid(p)) { return vec2<i32>(-1, -1); }
  return p;
}

fn kindOf(e: u32) -> u32 { return (atomicLoad(&kind[e >> 2u]) >> ((e & 3u) * 8u)) & 0xffu; }
fn setKind(e: u32, k: u32) { atomicOr(&kind[e >> 2u], k << ((e & 3u) * 8u)); }

@compute @workgroup_size(64)
fn routeCut(@builtin(global_invocation_id) id: vec3<u32>) {
  let e = id.x;
  if (e >= RP.counts.y) { return; }
  let ed = edges[e];
  let pa = groundCol(colOf[ed.x]);
  let pb = groundCol(colOf[ed.y]);
  let pm = groundCol(colOf[RP.counts.x + e]);
  var bits = 0u;
  if ((ed.w & RB_WALL) != 0u) { bits |= RC_WALL; }
  if ((ed.w & RB_INNER) != 0u) { bits |= RC_INNER; }
  if (pa.x < 0 || pb.x < 0 || pm.x < 0) {
    cut[e] = vec4<u32>(bits | RC_OFF, bitcast<u32>(-1e9), bitcast<u32>(-1e9), bitcast<u32>(-1e9));
    return;
  }
  let ga = rgTop(pa);
  let gb = rgTop(pb);
  let gm = rgTop(pm);
  let deep = RP.rules.w;
  let wet = rgWater(pa) > deep || rgWater(pb) > deep || rgWater(pm) > deep;
  if (wet && (ed.w & RB_SPAN) == 0u) { bits |= RC_WATER; }
  // (the drop along it: the highest of its three samples less the lowest, over its length — the stair pitch's rule)
  let rise = (max(max(ga, gb), gm) - min(min(ga, gb), gm)) / max(bitcast<f32>(ed.z), 1e-3);
  if (rise > RP.rules.y) { bits |= RC_CLIFF; }
  else if (rise > RP.rules.z) { bits |= RC_STEEP; }
  let oz = RP.rules.x;
  cut[e] = vec4<u32>(bits, bitcast<u32>(gm + oz), bitcast<u32>(ga + oz), bitcast<u32>(gb + oz));
}

// ---- the fields --------------------------------------------------------------------------------------------------

/** whether the layout walks edge e (edgenet.ts's walks: not cut, not inside a block) */
fn layoutWalks(e: u32) -> bool { return (cut[e].x & (RC_CUTS | RC_INNER | RC_OFF)) == 0u; }

/** whether a walker takes edge e with `lift` lifted: not cut, not a block's inside, and drawn or with no structure
 *  either side (never along a building's wall no path was drawn by) — the reach's and the routes' one rule */
fn walks(e: u32, lift: u32) -> bool {
  let c = cut[e].x;
  if ((c & (RC_INNER | RC_OFF)) != 0u) { return false; }
  if ((c & RC_CUTS & ~lift) != 0u) { return false; }
  return kindOf(e) != 0u || (edges[e].w & RB_BUILT) == 0u;
}

/** edge e's cost in costs `p`: the layout's (edgenet.ts: stairs three times, a drawn path half) or the routes'
 *  (routes.ts COST: a main street 0.5, a lane 0.7, open ground 1, stairs 1.6 times); < 0: not walked */
fn edgeCost(e: u32, p: u32) -> f32 {
  let len = bitcast<f32>(edges[e].z);
  let steep = (cut[e].x & RC_STEEP) != 0u;
  let k = kindOf(e);
  if (p == 0u) {
    if (!layoutWalks(e)) { return -1.0; }
    // (a drawn path half: field 0's the main roads' verge edges, field 1's the main streets — what stood when the field
    // was relaxed, so the traces laying more paths at once don't change the way down)
    var drawn = (k & KIND_MAIN) != 0u;
    if (FP.f.z == 0u) { drawn = (edges[e].w & RB_SPAN) != 0u; }
    return len * select(1.0, 3.0, steep) * select(1.0, 0.5, drawn);
  }
  if (!walks(e, 0u)) { return -1.0; }
  let per = select(select(1.0, 0.7, k == KIND_LANE), 0.5, (k & KIND_MAIN) != 0u);
  return len * per * select(1.0, 1.6, steep);
}

fn fbase() -> u32 { return FP.f.x * nodes(); }

@compute @workgroup_size(64)
fn fieldInit(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = id.x;
  if (n >= nodes()) { return; }
  // (the middle a source of the layout's fields)
  atomicStore(&dist[fbase() + n], select(FAR, 0u, FP.f.y == 0u && n == u32(RP.place.w)));
}

/** the layout's sources: (FP.f.z 0) the main roads' uncut verge edges, made main streets; (1) every main street */
@compute @workgroup_size(64)
fn fieldSeed(@builtin(global_invocation_id) id: vec3<u32>) {
  let e = id.x;
  if (e >= RP.counts.y) { return; }
  let ed = edges[e];
  if (FP.f.z == 0u) {
    if ((ed.w & RB_SPAN) == 0u || (cut[e].x & (RC_CUTS | RC_OFF)) != 0u) { return; }
    setKind(e, KIND_MAIN);
  } else if ((kindOf(e) & KIND_MAIN) == 0u) { return; }
  atomicStore(&dist[fbase() + ed.x], 0u);
  atomicStore(&dist[fbase() + ed.y], 0u);
}

/** one Bellman-Ford sweep, an edge a thread, both ways */
@compute @workgroup_size(64)
fn fieldRelax(@builtin(global_invocation_id) id: vec3<u32>) {
  let e = id.x;
  if (e >= RP.counts.y) { return; }
  let c = edgeCost(e, FP.f.y);
  if (c < 0.0) { return; }
  let b = fbase();
  let ed = edges[e];
  let da = atomicLoad(&dist[b + ed.x]);
  let db = atomicLoad(&dist[b + ed.y]);
  if (da != FAR) {
    let nb = bitcast<u32>(bitcast<f32>(da) + c);
    if (nb < db) {
      atomicMin(&dist[b + ed.y], nb);
      atomicStore(&answer[0], 1u);
    }
  }
  if (db != FAR) {
    let na = bitcast<u32>(bitcast<f32>(db) + c);
    if (na < da) {
      atomicMin(&dist[b + ed.x], na);
      atomicStore(&answer[0], 1u);
    }
  }
}

/** the edge from vertex v down the field: of those strictly nearer the sources, the least cost through it; NONE at a
 *  source or with no way down */
fn downhill(v: u32) -> u32 { return downhillIn(fbase(), FP.f.y, v); }

/** downhill in the field at `b` (its nodes' first) with costs `p` */
fn downhillIn(b: u32, p: u32, v: u32) -> u32 {
  let dv = bitcast<f32>(atomicLoad(&dist[b + v]));
  var best = NONE;
  var bd = 0.0;
  for (var i = csr[v]; i < csr[v + 1u]; i++) {
    let e = csr[RP.counts.x + 1u + i];
    let c = edgeCost(e, p);
    if (c < 0.0) { continue; }
    let ed = edges[e];
    let w = select(ed.x, ed.y, ed.x == v);
    let dw = atomicLoad(&dist[b + w]);
    if (dw == FAR) { continue; }
    let fw = bitcast<f32>(dw);
    if (fw >= dv) { continue; }
    if (best == NONE || fw + c < bd) {
      bd = fw + c;
      best = e;
    }
  }
  return best;
}

/** the walk from v down the field, each edge given `k` */
fn traceKind(v0: u32, k: u32) {
  var v = v0;
  for (var guard = 0u; guard < RP.counts.x; guard++) {
    if (atomicLoad(&dist[fbase() + v]) == 0u) { return; }
    let e = downhill(v);
    if (e == NONE) { return; }
    setKind(e, k);
    let ed = edges[e];
    v = select(ed.x, ed.y, ed.x == v);
  }
}

/** main streets: each gate's far corner traced down field 0 */
@compute @workgroup_size(64)
fn traceMains(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= RP.dims.z) { return; }
  let v = jobs[i];
  if (atomicLoad(&dist[fbase() + v]) == FAR) { return; }
  traceKind(v, KIND_MAIN);
}

fn atGrade(j: u32) -> bool {
  let d = doors[j];
  let floor = bitcast<f32>(d.z);
  return floor != floor || abs(floor - bitcast<f32>(cut[d.x].y)) <= RP.rules2.x;
}

/** lanes (field 1): each structure not far, of its free doors at grade (onto open ground first) the one nearest the
 *  network, traced down; the door chosen written to its answer */
@compute @workgroup_size(64)
fn traceLanes(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= RP.counts.z) { return; }
  let si = structInfo[s];
  if ((si.z & 1u) != 0u) { return; }
  let b = fbase();
  var anyOut = false;
  for (var j = si.x; j < si.x + si.y; j++) {
    if (atGrade(j) && (cut[doors[j].x].x & (RC_CUTS | RC_INNER | RC_OFF)) == 0u && (doors[j].w & 1u) != 0u) { anyOut = true; }
  }
  var bestV = NONE;
  var bestE = NONE;
  var bd = FAR;
  for (var j = si.x; j < si.x + si.y; j++) {
    let d = doors[j];
    if (!atGrade(j) || (cut[d.x].x & (RC_CUTS | RC_INNER | RC_OFF)) != 0u) { continue; }
    if (anyOut && (d.w & 1u) == 0u) { continue; }
    let ed = edges[d.x];
    for (var k = 0u; k < 2u; k++) {
      let v = select(ed.x, ed.y, k == 1u);
      let dv = atomicLoad(&dist[b + v]);
      if (dv < bd) {
        bd = dv;
        bestV = v;
        bestE = d.x;
      }
    }
  }
  if (bestV == NONE) { return; }
  setKind(bestE, KIND_LANE);
  atomicStore(&answer[structAt(s) + 1u], bestE + 1u);
  traceKind(bestV, KIND_LANE);
}

// ---- reach -------------------------------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn routeInit(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = id.x;
  if (n >= nodes()) { return; }
  atomicStore(&label[id.z * nodes() + n], n);
  if (id.z == 0u) { atomicStore(&mark[n], 0u); }
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

/** u and v (nodes) joined in a solve's labels: the higher root hooked under the lower */
fn hook(base: u32, u: u32, v: u32) {
  let ru = find(base, u);
  let rv = find(base, v);
  if (ru == rv) { return; }
  let lo = min(ru, rv);
  let hi = max(ru, rv);
  let old = atomicMin(&label[base + hi], lo);
  if (old > lo) { atomicStore(&answer[0], 1u); }
}

/** over the edges a walker takes (one thread each) */
@compute @workgroup_size(64)
fn routeHook(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= RP.counts.y) { return; }
  let base = id.z * nodes();
  if (walks(i, LIFTS[id.z])) { hook(base, edges[i].x, edges[i].y); }
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

/** per structure, per solve: bit m when one of its doors at grade (with the terrace lifted: any perimeter edge) has an
 *  end in the stores' component — a structure is one node, a route's end, never a way through; (the rules' solve)
 *  whether a door is at grade, a terrace's level, its doors' components marked when unreached */
@compute @workgroup_size(64)
fn routeStruct(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= RP.counts.z) { return; }
  let base = id.z * nodes();
  let lift = LIFTS[id.z];
  let sr = find(base, u32(RP.place.z));
  let si = structInfo[s];
  var reached = false;
  var grade = false;
  var best = 1e30;
  let floor = bitcast<f32>(si.w);
  for (var j = si.x; j < si.x + si.y; j++) {
    let d = doors[j];
    let c = cut[d.x];
    if ((c.x & (RC_INNER | RC_OFF)) != 0u) { continue; }
    let g = atGrade(j);
    grade = grade || g;
    if ((g || (lift & 8u) != 0u) && (find(base, edges[d.x].x) == sr || find(base, edges[d.x].y) == sr)) { reached = true; }
    if ((c.x & RC_CUTS) != 0u) { continue; }
    let z = bitcast<f32>(c.y);
    if (abs(z - floor) < abs(best - floor)) { best = z; }
  }
  if (reached) { atomicOr(&answer[structAt(s)], 1u << id.z); }
  if (id.z != 0u) { return; }
  if (!reached) {
    for (var j = si.x; j < si.x + si.y; j++) {
      if (!atGrade(j)) { continue; }
      atomicStore(&mark[find(0u, edges[doors[j].x].x)], 1u);
      atomicStore(&mark[find(0u, edges[doors[j].x].y)], 1u);
    }
  }
  atomicStore(&answer[structAt(s) + 3u], select(0u, 1u, grade));
  let terrace = (si.z & 2u) != 0u && !grade && best < 1e29;
  atomicStore(&answer[structAt(s) + 2u], select(FAR, bitcast<u32>(best), terrace));
}

/** the wall cells (not gates) with a corner in the stores' component and one in an unreached structure's (routeStruct
 *  marked their roots): where a gate joins them */
@compute @workgroup_size(64)
fn routeGates(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= RP.dims.w) { return; }
  let sr = find(0u, u32(RP.place.z));
  var stores = false;
  var theirs = false;
  let at = RP.dims.z + i * 5u;
  for (var k = 0u; k < 4u; k++) {
    let r = find(0u, jobs[at + 1u + k]);
    if (r == sr) { stores = true; }
    else if (atomicLoad(&mark[r]) == 1u) { theirs = true; }
  }
  if (!stores || !theirs) { return; }
  let n = atomicAdd(&answer[1], 1u);
  if (n < GATE_CAP) { atomicStore(&answer[2u + n], jobs[at]); }
}

// ---- the riders' routes (agents/routeride.ts rides them: shaders/routes.wgsl) -----------------------------------------
// A group's field (2 + its group) over the same edges by the same rule as reach (`walks`, the routes' costs), from its
// goals' vertices; a route traced down it from a vertex into the shared route-points pool. Asked as events: a group's
// goals set (its field relaxed to the end), a rider joining at a vertex no route of its group starts from yet (a trace).
// Nothing read back: the points stay on the GPU for the riders.
struct RideParams {
  /** goals, requests, the pool's size (points), spare */
  n: vec4<u32>,
};
/** [0] the pool's points used, [1] traces the pool couldn't hold, [2..4) spare; then RIDE_GOALS goals (field, vertex,
 *  x, y as f32 bits); then the requests (route, field, vertex — NONE: the goal's point alone — goal) */
@group(0) @binding(19) var<storage, read_write> ride: array<atomic<u32>>;
/** per point: x, y (the box's frame), z (world), the length along its route to it (routes.wgsl rtPts) */
@group(0) @binding(20) var<storage, read_write> rpts: array<vec4<f32>>;
/** per route: its first point, its points, its group, its length (f32 bits) (routes.wgsl rtRoutes) */
@group(0) @binding(21) var<storage, read_write> rroutes: array<vec4<u32>>;
@group(0) @binding(22) var<uniform> RD: RideParams;

/** routegpu.ts RIDE_GOALS */
const RIDE_GOALS: u32 = 256u;
/** a route point's height over the ground (routes.ts townRouteNet's) */
const RIDE_LIFT: f32 = 0.05;

fn goalAt(i: u32) -> u32 { return 4u + i * 4u; }
fn requestAt(i: u32) -> u32 { return 4u + RIDE_GOALS * 4u + i * 4u; }
/** vertex v's box-local x, y (routegraph.ts: after the CSR) */
fn vertXY(v: u32) -> vec2<f32> {
  let at = RP.counts.x + 1u + 2u * RP.counts.y + 2u * v;
  return vec2<f32>(bitcast<f32>(csr[at]), bitcast<f32>(csr[at + 1u]));
}
/** vertex v's ground (world z) as edge e (one of its edges) read it */
fn vertZ(v: u32, e: u32) -> f32 { return bitcast<f32>(select(cut[e].w, cut[e].z, edges[e].x == v)) + RIDE_LIFT; }

/** a group's sources: its goals' vertices */
@compute @workgroup_size(64)
fn rideSeed(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= RD.n.x) { return; }
  let a = goalAt(i);
  if (atomicLoad(&ride[a]) != FP.f.x) { return; }
  atomicStore(&dist[fbase() + atomicLoad(&ride[a + 1u])], 0u);
}

/** the goal of field f at vertex v (its index; NONE: none) */
fn goalOf(f: u32, v: u32) -> u32 {
  for (var i = 0u; i < RD.n.x; i++) {
    let a = goalAt(i);
    if (atomicLoad(&ride[a]) == f && atomicLoad(&ride[a + 1u]) == v) { return i; }
  }
  return NONE;
}

fn putPoint(at: u32, p: vec3<f32>, len: f32) { rpts[at] = vec4<f32>(p, len); }

/** a request a thread: the walk from its vertex down its field, the goal's point at the end, into the pool */
@compute @workgroup_size(64)
fn rideTrace(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= RD.n.y) { return; }
  let q = requestAt(i);
  let route = atomicLoad(&ride[q]);
  let f = atomicLoad(&ride[q + 1u]);
  let v0 = atomicLoad(&ride[q + 2u]);
  let gi = atomicLoad(&ride[q + 3u]);
  let b = f * nodes();
  let group = f - 2u;
  // (the goal's point alone: a rider on its last leg already)
  if (v0 == NONE) {
    let a = goalAt(gi);
    let at = atomicAdd(&ride[0], 1u);
    if (at >= RD.n.z) {
      atomicAdd(&ride[1], 1u);
      rroutes[route] = vec4<u32>(0u, 0u, group, 0u);
      return;
    }
    let gv = atomicLoad(&ride[a + 1u]);
    let e = csr[RP.counts.x + 1u + csr[gv]];
    putPoint(at, vec3<f32>(bitcast<f32>(atomicLoad(&ride[a + 2u])), bitcast<f32>(atomicLoad(&ride[a + 3u])), vertZ(gv, e)), 0.0);
    rroutes[route] = vec4<u32>(at, 1u, group, 0u);
    return;
  }
  // (how many points: the walk counted, then walked again and written)
  var n = 1u;
  var v = v0;
  for (var guard = 0u; guard < RP.counts.x; guard++) {
    if (atomicLoad(&dist[b + v]) == 0u) { break; }
    let e = downhillIn(b, 1u, v);
    if (e == NONE) { break; }
    n += 1u;
    v = select(edges[e].x, edges[e].y, edges[e].x == v);
  }
  let goal = goalOf(f, v);
  if (goal != NONE) { n += 1u; }
  let at = atomicAdd(&ride[0], n);
  if (at + n > RD.n.z) {
    atomicAdd(&ride[1], 1u);
    rroutes[route] = vec4<u32>(0u, 0u, group, 0u);
    return;
  }
  v = v0;
  var k = 0u;
  var len = 0.0;
  var prev = vertXY(v0);
  var lastZ = 0.0;
  for (var guard = 0u; guard < RP.counts.x; guard++) {
    let done = atomicLoad(&dist[b + v]) == 0u;
    var e = NONE;
    if (!done) { e = downhillIn(b, 1u, v); }
    // (its height as the edge it leaves by reads it; the last vertex's as the edge it came by)
    let xy = vertXY(v);
    len += distance(prev, xy);
    prev = xy;
    if (e != NONE) { lastZ = vertZ(v, e); }
    else if (k == 0u) { lastZ = vertZ(v, csr[RP.counts.x + 1u + csr[v]]); }
    putPoint(at + k, vec3<f32>(xy, lastZ), len);
    k += 1u;
    if (e == NONE) { break; }
    let w = select(edges[e].x, edges[e].y, edges[e].x == v);
    lastZ = vertZ(w, e);
    v = w;
  }
  if (goal != NONE) {
    let a = goalAt(goal);
    let gxy = vec2<f32>(bitcast<f32>(atomicLoad(&ride[a + 2u])), bitcast<f32>(atomicLoad(&ride[a + 3u])));
    len += distance(prev, gxy);
    putPoint(at + k, vec3<f32>(gxy, lastZ), len);
    k += 1u;
  }
  rroutes[route] = vec4<u32>(at, k, group, bitcast<u32>(len));
}

/** per vertex a bit: in the stores' component (the rules' solve) — what a rider joins and a goal stands by */
@group(0) @binding(23) var<storage, read_write> vbits: array<atomic<u32>>;

@compute @workgroup_size(64)
fn routeVerts(@builtin(global_invocation_id) id: vec3<u32>) {
  let v = id.x;
  if (v >= RP.counts.x) { return; }
  if (find(0u, v) == find(0u, u32(RP.place.z))) { atomicOr(&vbits[v >> 5u], 1u << (v & 31u)); }
}
