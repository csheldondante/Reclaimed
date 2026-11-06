// A settlement in play (round 88; DA-A6, round 128o: its people the one crowd's — town/life.ts TownLife, over
// settle/work.ts SettleWork, wired to the agents by settle/crowd.ts SettlementCrowd): the shapes the settlements hand
// it — its spots and the house going up, in the window's frame now — and what it asks of the world. Its trades: which
// of the crowd's rounds each walks.
import type { V2 } from '../api/contracts/units';
import type { AgentUnits } from '../units/agent-units';
import type { SiteSpec, Spot } from './plan';

export interface LiveSpot extends Spot {
  /** window coordinates */
  w: V2;
}

/** a house being built, in the window */
export interface LiveSite {
  spec: SiteSpec;
  door: V2;
}

export interface LifeIO {
  units: AgentUnits;
  /** the settlement's spots in window coordinates now */
  spots(): LiveSpot[];
  /** its houses to build, in window coordinates now */
  sites(): LiveSite[];
  /** the `n` nearest trees within reach (window coordinates), for the woodcutters, asked of the GPU; null: the window
   *  moved while they were asked */
  trees(at: V2, r: number, n: number): Promise<V2[] | null>;
  fell(at: V2): Promise<number>;
  /** the ground, exactly (world API terrain.take / put) */
  take(at: V2, amount: number): Promise<{ material: string; amount: number }>;
  put(at: V2, material: string, amount: number): Promise<number>;
  /** a site's storeys up so far (the settlement's view shows them, claims their columns; its roof when all are up) */
  raise(site: SiteSpec, storeys: number): void;
  dims: { w: number; h: number };
  epoch(): number;
  /** the ground's heights are in (a house is set on them) */
  ready(at: V2): boolean;
  /** goods brought in */
  deliver(good: string, amount: number): void;
  /** a house finished: its record */
  finished(site: SiteSpec): void;
  /** may it mine there (diplomacy's rights) */
  mayMine(at: V2): boolean;
  /** the settlement's field grows a step (as its food allows) and may open a lot to build on */
  grow(): void;
}

export type RaidOutcome = 'repelled' | 'looted';

/**
 * (round 120, purposes) Which round a trade walks in play: the purposes' people (contracts SettlementPurposeRec.trades)
 * on the four rounds a settlement's crowd has — the sawyers and raftsmen with the woodcutters, the carters with the
 * miners, the dockers, sailors, fishers, traders, millers and stablehands carrying goods from their work (the purpose's
 * spots: the piers, the stalls, the mill, the stables) to the store as the farmers do. The record keeps their own trades.
 */
export const ROUTINE: Record<string, 'farmer' | 'woodcutter' | 'miner' | 'builder' | 'guard'> = {
  farmer: 'farmer', woodcutter: 'woodcutter', miner: 'miner', builder: 'builder', guard: 'guard',
  sawyer: 'woodcutter', raftsman: 'woodcutter', carter: 'miner', smith: 'builder',
  miller: 'farmer', stablehand: 'farmer', docker: 'farmer', sailor: 'farmer', fisher: 'farmer', trader: 'farmer',
  // (merge124: the people a run moved here — led out of a town, sheltering — work the fields with the farmers)
  refugee: 'farmer',
};
export function routineOf(role: string): (typeof ROUTINE)[string] {
  const r = ROUTINE[role];
  if (!r) throw new Error(`settlements: no round for the trade "${role}" (live.ts ROUTINE)`);
  return r;
}
