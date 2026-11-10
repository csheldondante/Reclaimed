// The living town's cached routes, for systems that ride them (Track B's units marching: U2) — docs/design/LIVING_TOWN.md.
// One read-only storage buffer a town; read it only through src/shaders/routeread.wgsl (bound at its ROUTE_BINDING,
// 56): routeHead, routePoint (window x, y, z — a bridge deck's points at the deck's height), routeDist, routeAt,
// routeValid, routeWidth. The layout behind those functions is the living town's to change.
// The wall's table (the same buffer): wallWalkCount / wallWalkRoute(i) / wallWalkRun(i) — a run of wall's walk, stair to
// stair — and gateSlots / gateRoute(k) / gateStatus(k) / gateSegment(k) — each gate's march route by arterial index,
// filler gates after. Written on the GPU when the wall changes; an empty entry is ROUTE_NONE (fails routeValid).
//
// A route id as a rider holds it: `id | generation << 16`. The pool is recycled in two halves; a half reused moves its
// generation on, so an id from before fails routeValid (ride it no further; ask for the route again).

/** one town's routes (citylife/towns.ts LivingTowns.routeRead) */
export interface CityRouteRead {
  /** STORAGE, read: routeread.wgsl's buffer (header, heads, points) */
  readonly buffer: GPUBuffer;
}

/** routeread.wgsl's binding */
export const ROUTE_BINDING = 56;
