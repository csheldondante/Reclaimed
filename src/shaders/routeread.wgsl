// ---- routeread.wgsl: reading a living town's cached routes (contract: src/api/contracts/routes.ts) ----------------
// For any system that rides the town's routes (Track B's units marching, …) without knowing how the routes are made
// (citylife/routes.wgsl). One read-only storage binding, ROUTE_BINDING, holding the whole route buffer:
//
//   the header:   0, 1  each pool half's generation (u32)
//                 2     route ids a half (R: ids 0..R-1 are half 0, R..2R-1 half 1)
//                 3     where the points start (a word offset)
//                 4–6   the grid's place in the window (f32: x, y, z added to a point to put it in the window)
//                 7     the points' room (points)
//                 8     where the heads start (a word offset)
//                 9     the wall-walk routes (their count)
//                 10    the gate slots (their count: the arterials' room, then the filler gates')
//                 11    the table's version (moves on each time the GPU writes the wall's table)
//                 12    where the wall-walk entries start: 2 words each, the route id, then its segments
//                 13    where the gate entries start: 2 words each, the route id, then its status | segment << 8
//   heads         at header[8] + id·4: its first point, its point count, its length (f32 m), the generation it was
//                 traced in
//   points        at word header[3] + i·5 (ROUTE_POINT_WORDS): x, y, z (f32, the town grid's frame and world z: a bridge
//                 deck's points at the deck's height), the distance along the route to that point (f32 m), the free width
//                 there (f32 m: across the way, to buildings, a wall, water, drops and climbs; at most 12; a quarry ramp's
//                 its own 2; a wall-walk's the walk's 2, its stairs' 1.1)
//
// The wall's table (written on the GPU when the town wall's ring is made, a piece of it finishes rising, the graph
// settles or the pool's halves move on — nothing asked by the CPU):
//   - the wall-walk routes, one a run of wall between two gaps (a gate, or water): from the foot of the stair at the
//     run's start, up it, along the wall's top, down the stair at its end to its foot. Listed round the ring from the
//     first gate; an entry's id is ROUTE_NONE until its whole run has risen.
//   - the gates' march routes, indexed by the arterial (the order of the atlas roads the town was given): from the gate
//     out along that arterial to the town's box edge. Slots past the arterials' room are the filler gates (added only
//     to make two), in ring order. An entry is ROUTE_NONE with its status saying why: no gate there, the wall not risen
//     there, the gate over water, or no route.
//
// A route id handed out to a rider is packed `id | generation << 16` (id < 65536, the generation's low 16 bits). The
// pool is recycled in two halves: when a half is reused its generation moves on, so an id from before is stale and
// `routeValid` says so — a rider holding it ends its leg and asks again. The layout behind these functions may change;
// read routes only through them.

const ROUTE_BINDING: u32 = 56u;
const ROUTE_POINT_WORDS: u32 = 5u;
/** no route: what an empty table entry holds (fails routeValid) */
const ROUTE_NONE: u32 = 0xffffffffu;
/** a gate entry's status: a march route; no gate on that arterial (or no wall); the wall not risen there; the gate
 *  over water; no route (the graph not settled, the pool full, nothing to trace) */
const GATE_OK: u32 = 0u;
const GATE_NONE: u32 = 1u;
const GATE_RISING: u32 = 2u;
const GATE_WATER: u32 = 3u;
const GATE_FAILED: u32 = 4u;
@group(0) @binding(56) var<storage, read> routeBuf: array<u32>;

struct RouteHead { first: u32, count: u32, length: f32, gen: u32 }

/** the id without its generation */
fn routeId(idWithGen: u32) -> u32 { return idWithGen & 0xffffu; }
/** a route's head (by id, with or without its generation) */
fn routeHead(id: u32) -> RouteHead {
  let o = routeBuf[8u] + routeId(id) * 4u;
  return RouteHead(routeBuf[o], routeBuf[o + 1u], bitcast<f32>(routeBuf[o + 2u]), routeBuf[o + 3u]);
}
/** the generation the id's pool half is in now */
fn routeHalfGen(id: u32) -> u32 { return routeBuf[select(0u, 1u, routeId(id) >= routeBuf[2u])] & 0xffffu; }
/** an id with its generation still names the route it was given for (its half not reused since), with points */
fn routeValid(idWithGen: u32) -> bool {
  let id = routeId(idWithGen);
  if (id >= 2u * routeBuf[2u]) { return false; }
  return (idWithGen >> 16u) == routeHalfGen(id) && routeHead(id).count >= 2u;
}
/** point i of a route (0 ≤ i < count) in the grid's frame, and the distance along to it */
fn routePointLocal(id: u32, i: u32) -> vec4<f32> {
  let o = routeBuf[3u] + (routeHead(id).first + i) * ROUTE_POINT_WORDS;
  return bitcast<vec4<f32>>(vec4<u32>(routeBuf[o], routeBuf[o + 1u], routeBuf[o + 2u], routeBuf[o + 3u]));
}
/** point i of a route in the window (x, y, z: decks at their height) */
fn routePoint(id: u32, i: u32) -> vec3<f32> {
  return routePointLocal(id, i).xyz + bitcast<vec3<f32>>(vec3<u32>(routeBuf[4u], routeBuf[5u], routeBuf[6u]));
}
/** the free width at point i (m) */
fn routeWidth(id: u32, i: u32) -> f32 { return bitcast<f32>(routeBuf[routeBuf[3u] + (routeHead(id).first + i) * ROUTE_POINT_WORDS + 4u]); }
/** the distance along the route to point i (m) */
fn routeDist(id: u32, i: u32) -> f32 { return routePointLocal(id, i).w; }
/** the position s metres along the route, in the window (clamped to its ends): what a rider's trip interpolates */
fn routeAt(id: u32, s: f32) -> vec3<f32> {
  let h = routeHead(id);
  if (h.count < 2u) { return routePoint(id, 0u); }
  var lo = 0u;
  var hi = h.count - 1u;
  while (hi - lo > 1u) {
    let m = (lo + hi) / 2u;
    if (routeDist(id, m) <= s) { lo = m; } else { hi = m; }
  }
  let a = routePointLocal(id, lo);
  let b = routePointLocal(id, hi);
  let t = clamp((s - a.w) / max(b.w - a.w, 1e-4), 0.0, 1.0);
  return mix(a.xyz, b.xyz, t) + bitcast<vec3<f32>>(vec3<u32>(routeBuf[4u], routeBuf[5u], routeBuf[6u]));
}

// ---- the wall's table ----
/** the wall-walk routes (0: no wall yet) */
fn wallWalkCount() -> u32 { return routeBuf[9u]; }
/** wall-walk route i (0 ≤ i < wallWalkCount(), round the ring from the first gate): its id with its generation, or
 *  ROUTE_NONE while its run is still rising */
fn wallWalkRoute(i: u32) -> u32 {
  if (i >= routeBuf[9u]) { return ROUTE_NONE; }
  return routeBuf[routeBuf[12u] + i * 2u];
}
/** wall-walk route i's run: its first and last segment of the ring (0..71), its walk reached from the town (a stair's
 *  foot on the town's graph joined to the stores: 1, else 0), its run risen (1, else 0) */
fn wallWalkRun(i: u32) -> vec4<u32> {
  let w = routeBuf[routeBuf[12u] + min(i, max(routeBuf[9u], 1u) - 1u) * 2u + 1u];
  return vec4<u32>(w & 0xffu, (w >> 8u) & 0xffu, (w >> 16u) & 1u, (w >> 17u) & 1u);
}
/** the gate slots: the arterials' room, then the filler gates' */
fn gateSlots() -> u32 { return routeBuf[10u]; }
/** the march route out of gate slot k (k: the arterial's index; past the arterials' room, a filler gate): its id with
 *  its generation, or ROUTE_NONE (gateStatus says why) */
fn gateRoute(k: u32) -> u32 {
  if (k >= routeBuf[10u]) { return ROUTE_NONE; }
  return routeBuf[routeBuf[13u] + k * 2u];
}
/** gate slot k's status (GATE_*) */
fn gateStatus(k: u32) -> u32 {
  if (k >= routeBuf[10u]) { return GATE_NONE; }
  return routeBuf[routeBuf[13u] + k * 2u + 1u] & 0xffu;
}
/** gate slot k's ring segment (0..71; meaningless when its status is GATE_NONE) */
fn gateSegment(k: u32) -> u32 {
  if (k >= routeBuf[10u]) { return 0u; }
  return routeBuf[routeBuf[13u] + k * 2u + 1u] >> 8u;
}
/** the table's version: moves on each time the wall's table is written (a held order may compare it) */
fn wallTableVersion() -> u32 { return routeBuf[11u]; }
