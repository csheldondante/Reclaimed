// ---- living/attachment.ts -----------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F16) What the PLAYER cares about, for the dealer. The user (round 125): "choosing world
// changes based on things the player (not just the character) is likely to care about. A town the player built or a
// diplomatic relationship they created being threatened is far more compelling then a random named settlement. I think
// we will want to grow our focus out from a single locus and cast of characters and places we establish to the world at
// large."
//
// Two score parts, both read off the fact layer's history (provenance: what was done by the player):
//   stakes  how much of the card's subjects the player made or chose: entities and relations made by the outcomes of
//           cards they committed to ('player-made' events), the places they committed at, the people they answered
//           (owes_favor_to / grievance_against the player). 0..1, saturating.
//   locus   how near the card is to the run's locus and its cast: relation hops from the locus (and from every
//           entity the player has a stake in) over the fact graph; 1 at the locus, falling by a quarter a hop.
// A threat to a player-made town or relation therefore outranks the same threat to a random place.

import type { EntityId } from '../api/contracts/facts';
import type { FactWorld } from './world';

/** the player's stake in each entity, from the history (what they made, chose and answered) */
export function stakes(w: FactWorld): Map<EntityId, number> {
  const s = new Map<EntityId, number>();
  const add = (id: EntityId, n: number) => s.set(id, (s.get(id) ?? 0) + n);
  for (const e of w.facts.events()) {
    if (!e.by.includes('player')) continue;
    const n = e.kind === 'player-made' ? 1 : e.kind === 'committed' ? 0.5 : e.kind === 'kept-faith' || e.kind === 'refused' || e.kind === 'ignored' || e.kind === 'met' ? 0.5 : 0;
    if (n) for (const id of e.to) if (id !== 'player') add(id, n);
  }
  for (const r of w.facts.relations({ to: 'player' })) add(r.from, r.strength ?? 0.5);
  return s;
}

/** relation hops from the locus and the staked entities (undirected, the stored and derived relations), up to `max` */
export function hops(w: FactWorld, locus: EntityId, staked: Iterable<EntityId>, max = 4): Map<EntityId, number> {
  const d = new Map<EntityId, number>();
  let frontier = [locus, ...staked].filter((id) => w.facts.entity(id));
  for (const id of frontier) d.set(id, 0);
  for (let k = 1; k <= max && frontier.length; k++) {
    const next: EntityId[] = [];
    for (const id of frontier)
      for (const r of w.relations({ from: id }).concat(w.relations({ to: id }))) {
        const o = r.from === id ? r.to : r.from;
        if (o === 'player' || d.has(o)) continue;
        d.set(o, k);
        next.push(o);
      }
    frontier = next;
  }
  return d;
}

/** a card's two parts from its bound entities */
export function attachment(subjects: EntityId[], st: Map<EntityId, number>, dist: Map<EntityId, number>, max = 4): { stakes: number; locus: number } {
  const s = Math.max(0, ...subjects.map((id) => st.get(id) ?? 0));
  const h = Math.min(...subjects.map((id) => dist.get(id) ?? max + 1));
  return { stakes: Math.min(1, s / 2), locus: Math.max(0, 1 - h / max) };
}
