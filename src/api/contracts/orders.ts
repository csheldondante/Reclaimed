// Orders — the hero tells people what to do (round 120, `runsit`; BACKLOG FO1).
// The user (round 120): "ordering followers would be rad and is a natural way to enter a building mode and make your own
// settlements". So orders are general on purpose: today follow / hold / go (townsfolk led out of a town before the dead
// come); later work and build (the hero's own settlement) are more kinds of Order on the same call, not a new system.
// Why over Units: who follows is any unit (a townsman, a raised corpse, a hired guard); how a unit walks is the units
// system's business (contracts/units.ts UnitJob) — an Order is turned into a job at this boundary (src/runsit/
// followers.ts), and nothing here knows the GPU agents.

import type { UnitId, UnitView, V2 } from './units';

export type Order =
  /** walk after the leader, keeping about `distance` cells off */
  | { kind: 'follow'; distance?: number }
  /** stay at a point (the leader's spot when the order was given) */
  | { kind: 'hold'; at: V2 }
  /** walk to a point and stay there */
  | { kind: 'go'; to: V2 }
  /** go back to what they were doing (their settlement's routine) */
  | { kind: 'release' };

export interface Followers {
  /** the actor they follow (contracts/units.ts Actor id: 'hero') */
  readonly leader: string;
  /** take these units on (they keep doing what they did until ordered) */
  recruit(ids: UnitId[]): void;
  /** let them go (released to their routine) */
  dismiss(ids: UnitId[]): void;
  /** order every follower, or these */
  order(order: Order, who?: UnitId[]): void;
  /** the living followers, with the last order each was given */
  members(): { unit: UnitView; order: Order }[];
}
