// ---- the agents ride the roads (round 128i, V128-14) --------------------------------------------------------------
// The user: "Can agents transfer from flow field onto paths on the GPU? That seems cheaper and also reliable for moving
// goods around. We only need the flow fields where they go off tracks or where the destinations switch".
// An owner's roads as a graph in its own grid's frame (agents/roadgraph.ts: nodes, both-ways adjacency with costs),
// uploaded once a change; the frame's place in the window is RR.off (a slide moves it, nothing remade).
//  * rideHops (when the graph or the destinations change): one workgroup a destination slot; Bellman-Ford over the
//    nodes in workgroup memory, two copies swapped each round; the table per slot and node: the cost to the slot's
//    destination node and the next node on the way. Mirrored on the CPU by roadgraph.ts hopsCpu.
//  * ride (every tick, after the units' step: an agents stage): one thread a unit. A unit of a group that rides
//      - off the network, follows its field as ever (the shared field onto the roads: agents.wgsl, seeded on the
//        network's columns — rideNetStamp, below); standing on one, it joins at the node within JOIN_R that is cheapest to its
//        nearest destination (or, nearer its goal as the crow flies than by the roads, makes straight for it);
//      - on the network, heads for its node; there, on to the next one the table names for whichever of its group's
//        destinations is cheapest from it; at a destination node it gets off;
//      - off at the end, makes straight for its goal (the last leg: a door, the stores' heap) and stands there.
//    Its heading goes to the step through the unit's fifth word's w (units.wgsl reads it: 0 its field, < 0 stand,
//    else the heading + STEER_BIAS); a unit not riding gets 0.
// Self-contained (no common.wgsl): the units' record layout and the window's cells are mirrored here.

const RR_ROW_H: f32 = 0.8660254;
const RR_FAR: f32 = 1e9;
/** nodes the table holds (roadgraph.ts MAX_NODES) */
const MAX_NODES: u32 = 1024u;
const HOP_THREADS: u32 = 64u;
/** a unit's record: UNIT_V vec4s (units.wgsl, agents.ts UNIT_V) */
const RR_UNIT_V: u32 = 5u;
/** joins at a node this near (m) */
const JOIN_R: f32 = 4.5;
/** there: at a node, at its goal (m) */
const AT_NODE: f32 = 0.9;
const AT_GOAL: f32 = 0.6;
/** pushed this far off its way (tumbled, shoved), it starts over from its field: farther than this from the node it
 *  heads for than the longest edge into that node (round 128l, m4fix: it was 8 m from the node itself, so a rider that
 *  turned onto an edge longer than 8 m was "lost" at once — the lanes have 8.2 m edges on open ground — got off, joined
 *  again at the node behind and turned back: the farms' carts never left the stores, BACKLOG M4-14) */
const LOST: f32 = 3.0;
/** on the last leg (off the roads, to its goal): this far past NEAR_GOAL and it starts over */
const LAST_LOST: f32 = 8.0;
/** joins standing on an edge's band: this near its line (m; a lane's half width and a pad) */
const ON_EDGE: f32 = 1.6;
/** riding but slower than this (m/s) for STUCK_TICKS ticks, it gets off and waits COOL_TICKS before joining again */
const STUCK_SPEED: f32 = 0.25;
const STUCK_TICKS: u32 = 90u;
const COOL_TICKS: u32 = 120u;
/** a goal this near as the crow flies (m) it makes straight for, off the roads */
const NEAR_GOAL: f32 = 6.0;
/** units.wgsl steer: a heading rides as heading + STEER_BIAS (> 0); STAND < 0 */
const STEER_BIAS: f32 = 10.0;
const STAND: f32 = -1.0;
const M_OFF: u32 = 0u;
const M_ON: u32 = 1u;
const M_LAST: u32 = 2u;

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
};

@group(0) @binding(44) var<storage, read_write> rideUnits: array<vec4<f32>>;
/** per unit slot: x mode, y the node it heads for (off the network: ticks before it may join again), z its destination
 *  slot (bits 0-7) and the ticks it has made no way (8-31), w its group + 1 when that was set */
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

/** the longest edge at node v (m): how far a rider on its way to v can be from it */
fn longestEdge(v: u32) -> f32 {
  let g = graph[v];
  let a = nodeXY(v);
  var m = 0.0;
  for (var k = g.z; k < g.z + g.w; k++) { m = max(m, length(nodeXY(graphAdj[k].x) - a)); }
  return m;
}

fn hopCost(slot: u32, v: u32) -> f32 { return bitcast<f32>(hops[slot * MAX_NODES + v].x); }

/** the window column under world point w (common.wgsl cellAt, mirrored), as its window index; none: 0xffffffff */
fn rrColumn(w: vec2<f32>) -> u32 {
  let r0 = (w.y - 0.5 * RR_ROW_H) / RR_ROW_H;
  let a = vec2<f32>(w.x - 0.5 - 0.5 * r0, r0);
  let c = vec3<f32>(a.x, a.y, -a.x - a.y);
  var r = round(c);
  let d = abs(r - c);
  if (d.x > d.y && d.x > d.z) { r.x = -r.y - r.z; } else if (d.y > d.z) { r.y = -r.x - r.z; }
  let ax = vec2<i32>(i32(r.x), i32(r.y));
  let cell = vec2<i32>(ax.x + (ax.y - (ax.y & 1)) / 2, ax.y);
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

/** on the network or a column from it: the road field stops a walker within a step of its seeds (a step along a road
 *  costs half: agents.wgsl ROAD_COST) */
fn rrNearNet(w: vec2<f32>) -> bool {
  if (rrOnNet(w)) { return true; }
  for (var d = 0u; d < 6u; d++) {
    let t = f32(d) * 1.0471976;
    if (rrOnNet(w + vec2<f32>(cos(t), sin(t)) * 1.1)) { return true; }
  }
  return false;
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

fn steerTo(p: vec2<f32>, q: vec2<f32>) -> f32 {
  let d = q - p;
  return atan2(d.y, d.x) + STEER_BIAS;
}

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
  if (st.w != grp + 1u) { st = vec4<u32>(M_OFF, 0u, g.x, grp + 1u); }
  let p = a.xy - RR.off.xy;
  var steer = 0.0;
  if (!walking) {
    st.x = M_OFF;
  } else {
    // (its nearest goal as the crow flies)
    var gs = g.x;
    var gd = RR_FAR;
    for (var s = g.x; s < g.x + g.y; s++) {
      let d = length(RR.dest[s].xy - p);
      if (d < gd) {
        gd = d;
        gs = s;
      }
    }
    if (st.x == M_OFF) {
      if (gd < NEAR_GOAL) {
        st.x = M_LAST;
        st.z = gs;
        st.y = 0u;
      } else if (st.y > 0u) {
        // (got off stuck: a while on its field before joining again)
        st.y -= 1u;
      } else if (rrNearNet(a.xy)) {
        // (it joins on the edge whose band it stands on — the lane under its feet, never a node across a wall — at the
        // end of it cheapest to its nearest destination)
        var bv = 0xffffffffu;
        var bc = RR_FAR;
        var bs = g.x;
        for (var v = 0u; v < RR.n.x; v++) {
          let xv = nodeXY(v);
          if (length(xv - p) > JOIN_R + 4.0) { continue; }
          let gv = graph[v];
          for (var k = gv.z; k < gv.z + gv.w; k++) {
            let w2 = graphAdj[k].x;
            if (rrSegDist(p, xv, nodeXY(w2)) > ON_EDGE) { continue; }
            let b = bestDest(g, v);
            let c = length(xv - p) + bitcast<f32>(b.y);
            if (c < bc) {
              bc = c;
              bv = v;
              bs = b.x;
            }
          }
        }
        if (bv != 0xffffffffu) {
          st.x = M_ON;
          st.y = bv;
          st.z = bs;
        }
      }
    }
    if (st.x == M_ON) {
      var v = st.y;
      if (length(nodeXY(v) - p) > longestEdge(v) + LOST) {
        st.x = M_OFF;
      } else {
        // (at a node: on to the next, or off at the destination's)
        for (var k = 0u; k < 4u && length(nodeXY(v) - p) < AT_NODE; k++) {
          let b = bestDest(g, v);
          let h = hops[b.x * MAX_NODES + v];
          st.z = (st.z & ~0xffu) | b.x;
          if (bitcast<f32>(h.x) >= RR_FAR) {
            st.x = M_OFF;
            break;
          }
          if (h.y == v) {
            st.x = M_LAST;
            break;
          }
          v = h.y;
        }
        st.y = v;
        if (st.x == M_ON) { steer = steerTo(p, nodeXY(v)); }
      }
    }
    if (st.x == M_LAST) {
      let q = RR.dest[st.z & 0xffu].xy;
      let d = length(q - p);
      if (d > LAST_LOST + NEAR_GOAL) {
        st.x = M_OFF;
      } else {
        steer = select(steerTo(p, q), STAND, d < AT_GOAL);
      }
    }
  }
  // (riding but making no way — shoved against something, a lane over ground it can't walk: off, and a while before it
  // joins again)
  if (st.x != M_OFF && steer > 0.0) {
    let speed = length(rideUnits[u * RR_UNIT_V + 1u].xy);
    let stuck = select(0u, (st.z >> 8u) + 1u, speed < STUCK_SPEED);
    st.z = (st.z & 0xffu) | (min(stuck, 0xffffffu) << 8u);
    if (stuck > STUCK_TICKS) {
      st = vec4<u32>(M_OFF, COOL_TICKS, 0u, st.w);
      steer = 0.0;
    }
  }
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
