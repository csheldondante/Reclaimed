// (card-table, draft 7 → 8) Stances between the player, the raiders and the packs' factions, as relations of the fact
// world: hostile (`at_war_with`), truce (`truce_with`), allied (`allied_with`), or none. One module for the Realm's own
// raiders (season/realm.ts) and the packs' factions (packs/load.ts). Pure but for the fact world.
import type { EntityId } from '../api/contracts/facts';
import type { FactWorld } from './world';

export const STANCE_REL = { hostile: 'at_war_with', truce: 'truce_with', allied: 'allied_with' } as const;
export type Stance = keyof typeof STANCE_REL | 'none';

/** the stance between two (a faction, the player, another faction): hostile, truce, allied, or none */
export function stanceOf(w: FactWorld, a: EntityId, b: EntityId): Stance {
  for (const [s, type] of Object.entries(STANCE_REL)) if (w.facts.relations({ type, from: a, to: b, historic: false }).length || w.facts.relations({ type, from: b, to: a, historic: false }).length) return s as Stance;
  return 'none';
}

/** a stance set: the old one ends (its history edge kept) and the new one holds both ways; a `stance` event says so.
 *  False: it was that stance already */
export function setStance(w: FactWorld, x: EntityId, y: EntityId, to: Stance, cause: string): boolean {
  if (stanceOf(w, x, y) === to) return false;
  for (const type of Object.values(STANCE_REL)) for (const [p, q] of [[x, y], [y, x]]) if (w.facts.relations({ type, from: p, to: q, historic: false }).length) w.facts.unrelate({ type, from: p, to: q }, cause);
  if (to !== 'none') w.facts.relate({ type: STANCE_REL[to], from: x, to: y, symmetric: true, cause });
  w.facts.record({ kind: 'stance', by: [x], to: [y], about: { opp: cause }, note: `${w.name(x)} and ${y === 'player' ? 'you' : w.name(y)}: ${to === 'none' ? 'no longer bound' : to}` });
  return true;
}
