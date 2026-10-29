// Traversal fields (round 112, herosandbox; the user: "Don't we have pathfinding? Can't we build a traversal field
// for the hero agent and use that instead of input? Or steer along that?"). The contract every pathing caller codes
// against: a field of the cost to reach a goal over the ground, for a body that moves as `Mobility` says — the hero's
// own step, drop and wade, not the agents' fixed ones — and the way down it from any point.
// - Implementations: src/hero/traversal.ts `CpuTraversal` (a Dijkstra over the window's cells from the world API's
//   heights and water, bounded by a radius) first; the GPU agents' distance and flow fields (agents.wgsl navCost)
//   to implement it next (BACKLOG HS10).
// - Users: src/hero/pilot.ts `Pilot` (a HeroController that steers along a field: the sandbox's 🧭 autopilot, the
//   headless test); a course generator's check that a given hero can get from its start to its goal (GE3).
// - Coordinates: the level's window (x cells, y world units), as the world API's.
//
//   const f = traversal.field(goal, hero.mobility ?? WALKER_MOBILITY)
//   f.reachable(hero.position())  ·  f.cost(p)  ·  f.dir(p)  (unit vector down the field, null: no way from there)

import type { V2 } from './units';

/** How a body gets over the ground (cells): what a field's cost is reckoned by. */
export interface Mobility {
  /** the highest step up it takes in a stride */
  step: number;
  /** the deepest drop it takes (default: any) */
  drop?: number;
  /** water deeper than this it won't go into (default: any) */
  deep?: number;
  /**
   * a climb is measured from the lowest ground within a cell of where it stands (path.ts canStep: the soft rim a build
   * leaves at a wall's foot is no stair onto the wall) — the Walker's rule (default false: from where it stands)
   */
  fromLow?: boolean;
  /** a jump: a step up to this height more, at `jumpCost` (default none) */
  jump?: number;
  /** what a jump costs, in cells of walking (default 4) */
  jumpCost?: number;
  /** cost a cell of height climbed, in cells of walking (default 0.5): it goes round a hill when that's shorter */
  climbCost?: number;
  /** cost a cell of water waded, per cell of depth (default 1) */
  wadeCost?: number;
  /** cost of a cell beside a face it can't climb (a wall's foot), in cells of walking (default 3): a body has width, a route keeps a cell off walls where it can */
  hugCost?: number;
}

/** The cost to reach one goal, from everywhere within its radius. */
export interface TraversalField {
  readonly goal: V2;
  readonly mobility: Mobility;
  /** cells it covers (its radius, in cells round the goal) */
  readonly radius: number;
  /** the cost (cells of walking) from (x, y) to the goal; null: no way (or outside the field) */
  cost(at: V2): number | null;
  reachable(at: V2): boolean;
  /** the way to go from (x, y): a unit vector toward the next cell down the field (at the goal: to the goal point); null: no way */
  dir(at: V2): V2 | null;
  /** the way from (x, y) to the goal as points (cell centres), for drawing or checking; null: no way */
  route(at: V2, max?: number): V2[] | null;
  /** ms it took to make */
  readonly ms: number;
}

/** Makes fields over a world. */
export interface Traversal {
  field(goal: V2, mobility: Mobility, opts?: { radius?: number }): TraversalField;
}
