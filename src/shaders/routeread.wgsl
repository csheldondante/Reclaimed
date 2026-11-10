// ---- routeread.wgsl: reading a living town's cached routes (contract: src/api/contracts/routes.ts) ----------------
// For any system that rides the town's routes (Track B's units marching, …) without knowing how the routes are made
// (citylife/routes.wgsl). One read-only storage binding, ROUTE_BINDING, holding the whole route buffer:
//
//   words 0–7     the header:
//                   0, 1  each pool half's generation (u32)
//                   2     route ids a half (R: ids 0..R-1 are half 0, R..2R-1 half 1)
//                   3     where the points start (a word offset, a multiple of 4)
//                   4–6   the grid's place in the window (f32: x, y, z added to a point to put it in the window)
//                   7     the points' room (points)
//   words 8 + id·4  a route's head: its first point, its point count, its length (f32 m), the generation it was traced in
//   points        at word header[3] + i·5 (ROUTE_POINT_WORDS): x, y, z (f32, the town grid's frame and world z: a bridge
//                 deck's points at the deck's height), the distance along the route to that point (f32 m), the free width
//                 there (f32 m: across the way, to buildings, water, drops and climbs; at most 12; a generated route's
//                 — a quarry ramp, a march — its own, 2)
//
// A route id handed out to a rider is packed `id | generation << 16` (id < 65536, the generation's low 16 bits). The
// pool is recycled in two halves: when a half is reused its generation moves on, so an id from before is stale and
// `routeValid` says so — a rider holding it ends its leg and asks again. The layout behind these functions may change;
// read routes only through them.

const ROUTE_BINDING: u32 = 56u;
const ROUTE_POINT_WORDS: u32 = 5u;
@group(0) @binding(56) var<storage, read> routeBuf: array<u32>;

struct RouteHead { first: u32, count: u32, length: f32, gen: u32 }

/** the id without its generation */
fn routeId(idWithGen: u32) -> u32 { return idWithGen & 0xffffu; }
/** a route's head (by id, with or without its generation) */
fn routeHead(id: u32) -> RouteHead {
  let o = 8u + routeId(id) * 4u;
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
