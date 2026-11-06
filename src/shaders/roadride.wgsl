// ---- the agents ride the roads (round 128i, V128-14; round 128o, DA-A7: kinematic trips) ----------------------------
// The user: "if agents are on paths can't we essentially just interpolate their position from end to end at their travel
// speed?" (DESIGN.md section 12). An owner's roads as a graph in its own grid's frame (agents/roadgraph.ts: nodes,
// both-ways adjacency with costs), uploaded once a change; the frame's place in the window is RR.off (a slide moves it).
//  * rideHops (when the graph or the destinations change): one workgroup a destination slot; Bellman-Ford over the nodes
//    in workgroup memory; the table per slot and node: the cost to the slot's destination node and the next node on the
//    way (the cached routes, for now). Mirrored on the CPU by roadgraph.ts hopsCpu.
//  * ride (every tick, after the units' step: an agents stage): one thread a unit. A unit of a group that rides
//      - off the network, follows its field (the shared field onto the roads: agents.wgsl ROAD_FIELD, seeded on the
//        network's columns — rideNetStamp, below); standing on an edge's band it starts a trip there, toward the end of
//        the edge cheaper to its nearest destination;
//      - on a trip, is placed: along its edge at its kind's speed (G.dt), node to node as the table names them, then
//        from the destination's node to its goal; at its goal it stands. Its x, y and velocity are written here; its
//        steer word says RIDE_TRIP, so units.wgsl moves it no further (only its height rides the surface under it). No
//        steering, no shoving, no getting lost or stuck;
//      - knocked down, thrown, swinging (not walking): off the trip, back on its field, and it starts again.
// Includes common.wgsl (the Globals: dt; the lattice's cellAt).

const RR_ROW_H: f32 = 0.8660254;
const RR_FAR: f32 = 1e9;
/** nodes the table holds (roadgraph.ts MAX_NODES) */
const MAX_NODES: u32 = 1024u;
const HOP_THREADS: u32 = 64u;
/** a unit's record: UNIT_V vec4s (units.wgsl, agents.ts UNIT_V) */
const RR_UNIT_V: u32 = 6u;
/** a unit stands on an edge's band this near its line (m): a lane's half width and a pad */
const ON_EDGE: f32 = 1.6;
/** units.wgsl steer: STAND < 0 stands; RIDE_TRIP: placed by the ride (a heading + STEER_BIAS > 0: none since the trips) */
const STEER_BIAS: f32 = 10.0;
const STAND: f32 = -1.0;
const RIDE_TRIP: f32 = -2.0;
const M_OFF: u32 = 0u;
/** on a trip along edge y -> z */
const M_TRIP: u32 = 1u;
/** on the last stretch from its destination's node to the goal */
const M_LAST: u32 = 2u;
const M_AT: u32 = 3u;

struct RideParams {
  /** x nodes, y destination slots, z units (the slots' high-water mark), w the window's columns across */
  n: vec4<u32>,
  /** xy the graph's frame in the window (world: the frame's origin there), zw unused */
  off: vec4<f32>,
  /** per group (24: agents.ts MAX_GROUPS): x its first destination slot, y how many (0: it doesn't ride) */
  group: array<vec4<u32>, 24>,
  /** per destination slot (64): xy its goal (the graph's frame), zw unused */
  dest: array<vec4<f32>, 64>,
  /** per destination slot its node: slot s at [s / 4][s % 4] */
  destNode: array<vec4<u32>, 16>,
  /** (round 128o) per kind of unit its walking speed (m/s): kind k at [k / 4][k % 4] — agents.ts KindSpec.speed */
  kindSpeed: array<vec4<f32>, 2>,
};

@group(0) @binding(44) var<storage, read_write> rideUnits: array<vec4<f32>>;
/** per unit slot: x its mode (bits 0-7) and destination slot (8-15), y the node its edge starts at, z the node it heads
 *  for, w its group + 1 when that was set */
@group(0) @binding(45) var<storage, read_write> rideState: array<vec4<u32>>;
/** the graph: per node (MAX_NODES) x, y (f32 bits), first edge, edges; then per edge the node and its cost (f32 bits) */
@group(0) @binding(46) var<storage, read> graph: array<vec4<u32>>;
@group(0) @binding(47) var<storage, read> graphAdj: array<vec2<u32>>;
/** per destination slot and node (slot * MAX_NODES + node): x the cost to the slot's node (f32 bits), y the next node */
@group(0) @binding(48) var<storage, read_write> hops: array<vec2<u32>>;
@group(0) @binding(49) var<uniform> RR: RideParams;
/** the agents' road bits (agents.wgsl `roads`): two planes of a bit a window column — the road shapes' (RoadStamp), then
 *  the network's (rideNetStamp: the edges that lead to a riding group's goal) — read by the ride */
@group(0) @binding(50) var<storage, read> rideRoads: array<u32>;
/** the same buffer, written by rideNetClear and rideNetStamp (the second plane) */
@group(0) @binding(51) var<storage, read_write> netBits: array<atomic<u32>>;

var<workgroup> dA: array<f32, MAX_NODES>;
var<workgroup> dB: array<f32, MAX_NODES>;
var<workgroup> moved: atomic<u32>;
var<workgroup> again: u32;

@compute @workgroup_size(64)
fn rideHops(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let slot = wg.x;
  let n = RR.n.x;
  let dst = RR.destNode[slot / 4u][slot % 4u];
  for (var v = lid.x; v < n; v += HOP_THREADS) {
    let d0 = select(RR_FAR, 0.0, v == dst);
    dA[v] = d0;
    hops[slot * MAX_NODES + v] = vec2<u32>(bitcast<u32>(d0), select(0xffffffffu, v, v == dst));
  }
  workgroupBarrier();
  for (var it = 0u; it < n; it++) {
    if (lid.x == 0u) { atomicStore(&moved, 0u); }
    workgroupBarrier();
    // (each round reads A, writes B: no node reads a value written this round)
    for (var v = lid.x; v < n; v += HOP_THREADS) {
      var best = dA[v];
      var nx = 0xffffffffu;
      let g = graph[v];
      for (var k = g.z; k < g.z + g.w; k++) {
        let e = graphAdj[k];
        let du = dA[e.x];
        if (du >= RR_FAR) { continue; }
        let c = du + bitcast<f32>(e.y);
        if (c < best - 1e-4) {
          best = c;
          nx = e.x;
        }
      }
      dB[v] = best;
      if (nx != 0xffffffffu) {
        hops[slot * MAX_NODES + v] = vec2<u32>(bitcast<u32>(best), nx);
        atomicStore(&moved, 1u);
      }
    }
    workgroupBarrier();
    for (var v = lid.x; v < n; v += HOP_THREADS) { dA[v] = dB[v]; }
    if (lid.x == 0u) { again = atomicLoad(&moved); }
    if (workgroupUniformLoad(&again) == 0u) { break; }
  }
}

fn nodeXY(v: u32) -> vec2<f32> {
  let g = graph[v];
  return vec2<f32>(bitcast<f32>(g.x), bitcast<f32>(g.y));
}

fn hopCost(slot: u32, v: u32) -> f32 { return bitcast<f32>(hops[slot * MAX_NODES + v].x); }

/** the window column under world point w (its window index; none: 0xffffffff) */
fn rrColumn(w: vec2<f32>) -> u32 {
  let cell = cellAt(w);
  let H = i32((arrayLength(&rideRoads) / 2u) * 32u / max(RR.n.w, 1u));
  if (cell.x < 0 || cell.y < 0 || cell.x >= i32(RR.n.w) || cell.y >= H) { return 0xffffffffu; }
  return u32(cell.y) * RR.n.w + u32(cell.x);
}

/** on the network: a column the network's plane marks (an edge that leads to a riding group's goal) */
fn rrOnNet(w: vec2<f32>) -> bool {
  let i = rrColumn(w);
  if (i == 0xffffffffu) { return false; }
  return ((rideRoads[arrayLength(&rideRoads) / 2u + (i >> 5u)] >> (i & 31u)) & 1u) != 0u;
}

/** the cheapest of group g's destinations from node v: its slot (x) and the cost (y as f32 bits) */
fn bestDest(g: vec4<u32>, v: u32) -> vec2<u32> {
  var bs = g.x;
  var bc = RR_FAR;
  for (var s = g.x; s < g.x + g.y; s++) {
    let c = hopCost(s, v);
    if (c < bc) {
      bc = c;
      bs = s;
    }
  }
  return vec2<u32>(bs, bitcast<u32>(bc));
}

fn destNodeOf(s: u32) -> u32 { return RR.destNode[s / 4u][s % 4u]; }

fn kindSpeedOf(k: u32) -> f32 { return RR.kindSpeed[k / 4u][k % 4u]; }

@compute @workgroup_size(64)
fn ride(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= RR.n.z) { return; }
  let a = rideUnits[u * RR_UNIT_V];
  let info = bitcast<u32>(a.w);
  let grp = info & 0xffu;
  let alive = ((info >> 8u) & 1u) != 0u;
  // (walking: its state wander or chase — not swinging, tumbling or held)
  let walking = ((info >> 12u) & 7u) <= 1u;
  var e = rideUnits[u * RR_UNIT_V + 4u];
  var st = rideState[u];
  if (!alive || grp >= 24u || RR.group[grp].y == 0u || RR.n.x == 0u) {
    if (e.w != 0.0) {
      e.w = 0.0;
      rideUnits[u * RR_UNIT_V + 4u] = e;
    }
    if (st.w != 0u) { rideState[u] = vec4<u32>(0u); }
    return;
  }
  let g = RR.group[grp];
  if (st.w != grp + 1u) { st = vec4<u32>(M_OFF, 0u, 0u, grp + 1u); }
  var mode = st.x & 0xffu;
  var slot = (st.x >> 8u) & 0xffu;
  // (a slot not its group's — the goals changed under it: it starts over)
  if (mode != M_OFF && (slot < g.x || slot >= g.x + g.y)) { mode = M_OFF; }
  let p = a.xy - RR.off.xy;
  var steer = 0.0;
  var q = p;
  var dir = vec2<f32>(0.0);
  if (!walking) {
    mode = M_OFF;
  } else {
    if (mode == M_OFF && rrOnNet(a.xy)) {
      // (on an edge's band: a trip from where it stands, toward the end cheaper to its nearest goal)
      var bc = RR_FAR;
      for (var v = 0u; v < RR.n.x; v++) {
        let gv = graph[v];
        for (var k = gv.z; k < gv.z + gv.w; k++) {
          let w2 = graphAdj[k].x;
          if (rrSegDist(p, nodeXY(v), nodeXY(w2)) > ON_EDGE) { continue; }
          let b = bestDest(g, w2);
          let c = length(nodeXY(w2) - p) + bitcast<f32>(b.y);
          if (c < bc) {
            bc = c;
            st.y = v;
            st.z = w2;
            slot = b.x;
          }
        }
      }
      if (bc < RR_FAR) {
        mode = M_TRIP;
        // (onto the edge's line where it stands)
        let s0 = nodeXY(st.y);
        let d = nodeXY(st.z) - s0;
        q = s0 + d * clamp(dot(p - s0, d) / max(dot(d, d), 1e-12), 0.0, 1.0);
      }
    }
    let speed = kindSpeedOf((info >> 9u) & 7u);
    var left = speed * G.dt;
    // (on its way: along edges, node to node, as far as its speed takes it this tick)
    for (var hop = 0u; hop < 8u && left > 0.0 && (mode == M_TRIP || mode == M_LAST); hop++) {
      let to = select(nodeXY(st.z), RR.dest[slot].xy, mode == M_LAST);
      let d = to - q;
      let L = length(d);
      if (L > left) {
        dir = d / L;
        q += dir * left;
        left = 0.0;
        break;
      }
      if (L > 1e-6) { dir = d / L; }
      q = to;
      left -= L;
      if (mode == M_LAST) {
        mode = M_AT;
        break;
      }
      // (at node st.z: on to the next its cheapest goal's table names, or the last stretch to the goal)
      let b = bestDest(g, st.z);
      slot = b.x;
      if (bitcast<f32>(b.y) >= RR_FAR) {
        mode = M_OFF;
        break;
      }
      if (st.z == destNodeOf(slot)) {
        mode = M_LAST;
        continue;
      }
      st.y = st.z;
      st.z = hops[slot * MAX_NODES + st.z].y;
    }
    if (mode == M_TRIP || mode == M_LAST || (mode == M_AT && any(q != p))) {
      // (placed: where its trip has it this tick, heading its way — units.wgsl rides its height)
      rideUnits[u * RR_UNIT_V] = vec4<f32>(q + RR.off.xy, a.z, a.w);
      let r1 = rideUnits[u * RR_UNIT_V + 1u];
      rideUnits[u * RR_UNIT_V + 1u] = vec4<f32>(dir * select(speed, 0.0, mode == M_AT), 0.0, r1.w);
    }
    if (mode == M_TRIP || mode == M_LAST) {
      steer = RIDE_TRIP;
    } else if (mode == M_AT) {
      // (at its goal: stands, until its routine gives it another; moved off it — its field, and it starts again)
      if (length(RR.dest[slot].xy - q) > ON_EDGE) { mode = M_OFF; } else { steer = STAND; }
    }
  }
  st.x = mode | (slot << 8u);
  rideState[u] = st;
  if (e.w != steer) {
    e.w = steer;
    rideUnits[u * RR_UNIT_V + 4u] = e;
  }
}

// ---- the network's plane (round 128i): the columns of the edges that lead to a riding group's goal --------------------
// The shared field onto the roads (agents.wgsl ROAD_FIELD) is seeded on these columns, not on every road's: a walker is
// led onto a piece of the network its goals are on, never stranded on a lane cut off from them. Made again with the
// tables and whenever the graph's frame moves in the window (a slide).
/** a network edge's band (m): a lane's half width and the stamp's pad (lanes.ts LANE_WIDTH, ROAD_PAD) */
const NET_HALF: f32 = 1.2;

@compute @workgroup_size(64)
fn rideNetClear(@builtin(global_invocation_id) id: vec3<u32>) {
  let words = arrayLength(&netBits) / 2u;
  if (id.x < words) { atomicStore(&netBits[words + id.x], 0u); }
}

fn rrSegDist(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let d = b - a;
  let t = clamp(dot(p - a, d) / max(dot(d, d), 1e-12), 0.0, 1.0);
  return length(p - a - d * t);
}

@compute @workgroup_size(64)
fn rideNetStamp(@builtin(global_invocation_id) id: vec3<u32>) {
  let v = id.x;
  if (v >= RR.n.x) { return; }
  // (reached: some destination slot's cost from it is finite)
  var reached = false;
  for (var s = 0u; s < RR.n.y; s++) { reached = reached || hopCost(s, v) < RR_FAR; }
  if (!reached) { return; }
  let words = arrayLength(&netBits) / 2u;
  let W = i32(RR.n.w);
  let H = i32(words * 32u / max(RR.n.w, 1u));
  let a = nodeXY(v);
  let g = graph[v];
  for (var k = g.z; k < g.z + g.w; k++) {
    let u = graphAdj[k].x;
    if (u < v) { continue; }
    let b = nodeXY(u);
    let lo = min(a, b) - vec2<f32>(NET_HALF);
    let hi = max(a, b) + vec2<f32>(NET_HALF);
    let y0 = max(i32(floor((lo.y + RR.off.y) / RR_ROW_H - 0.5)), 0);
    let y1 = min(i32(ceil((hi.y + RR.off.y) / RR_ROW_H - 0.5)), H - 1);
    let x0 = max(i32(floor(lo.x + RR.off.x - 1.0)), 0);
    let x1 = min(i32(ceil(hi.x + RR.off.x)), W - 1);
    if (y1 - y0 > 64 || x1 - x0 > 64) { continue; }
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        let p = vec2<f32>(f32(x) + 0.5 + 0.5 * f32(y & 1), (f32(y) + 0.5) * RR_ROW_H) - RR.off.xy;
        if (rrSegDist(p, a, b) <= NET_HALF) {
          let w = u32(y) * RR.n.w + u32(x);
          atomicOr(&netBits[words + (w >> 5u)], 1u << (w & 31u));
        }
      }
    }
  }
}
