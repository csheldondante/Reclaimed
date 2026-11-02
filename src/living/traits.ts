// ---- living/traits.ts ---------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F7) Traits at the opportunity scale — one vocabulary with the agents' trait system
// (api/contracts/traits.ts: living, undead, flying, regenerating, fire_immune …). The user (round 125): "this should
// probably interact with our unit traits and modular units. Undead may work tirelessly with no sleep. Gnoll knights may
// regenerate etc".
//
// Where a pawn's traits come from — the seam for the unit builder (the user: "Eventually we want our unit builder to
// link traits and abilities and stats to the creature, training, gear and mount"): `unitTraits` of
//   - its creature: the species' traits from the creature generator's own species data (inhabitants/species.ts
//     SpeciesSpec.traits — one source with the agents' trait bits; 'species:gnoll' in its tags names it),
//   - its own tags (a trait named outright: 'undead'), its body parts and training,
//   - its gear (tags; later, the items' traits),
//   - its mount's movement traits (a griffin's flying).
// A cohort's come from its biology tags the same way (biology:species = gnoll; biology:undead = true).
//
// What traits do to an opportunity is one table (TRAIT_RULES), read by the template engine for every card — never a
// per-template special case:
//   undead       labour takes half the turns (tireless: no sleep), no food upkeep; living residents object (unrest)
//   regenerating losses recover between turns (the pawn comes back at full strength)
//   flying       travel takes half the turns (barriers on routes crossed)
// Where the player is looking, the same traits drive the simulated agents through the trait modules' CAPS word (an undead
// worker doesn't go home at night): a hook for the agents' track (docs/ARCHITECTURE.md "Traits at the opportunity
// scale"), not built here.

import { INTRINSIC, traitsOfTags, type IntrinsicName } from '../api/contracts/traits';
import type { Agent } from '../api/contracts/opportunity';
import type { EntityId, FactStore } from '../api/contracts/facts';
import { speciesTraits } from '../inhabitants/species';

/** the movement traits a mount lends its rider */
const MOUNT_LENDS: readonly IntrinsicName[] = ['flying'];

/** tags → the tags they stand for ('species:gnoll' → living, regenerating, from the creature generator) */
function expand(tags: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of tags) {
    out.push(t);
    if (t.startsWith('species:')) out.push(...speciesTraits(t.slice(8)));
  }
  return out;
}

/** A unit as the unit builder will compose it: creature, training, gear, mount (and its own tags). */
export interface UnitSpec {
  creature?: string;
  tags?: string[];
  body?: string[];
  training?: string[];
  gear?: string[];
  mount?: string;
}

/** a unit's traits, in the traits.ts order */
export function unitTraits(u: UnitSpec): IntrinsicName[] {
  const own = traitsOfTags(expand([...(u.creature ? [`species:${u.creature}`] : []), ...(u.tags ?? []), ...(u.body ?? []), ...(u.training ?? []), ...(u.gear ?? [])]));
  const lent = u.mount ? (speciesTraits(u.mount) as IntrinsicName[]).filter((t) => MOUNT_LENDS.includes(t)) : [];
  const all = new Set([...own, ...lent]);
  return INTRINSIC.filter((t) => all.has(t));
}

/** a pawn's traits: its tags, its species', its parts' (the contract's Agent as a UnitSpec) */
export function pawnTraits(a: Pick<Agent, 'tags' | 'parts'>): IntrinsicName[] {
  return unitTraits({ tags: a.tags, body: a.parts?.body, training: a.parts?.training, gear: a.parts?.gear, mount: a.parts?.mount });
}

/** an entity's traits from its biology tags (species, or a trait named outright) */
export function entityTraits(f: FactStore, id: EntityId): IntrinsicName[] {
  const e = f.entity(id);
  if (!e) return [];
  const tags = e.tags.filter((t) => t.scope === 'biology' && t.value !== false).map((t) => (t.key === 'species' ? `species:${t.value}` : t.key));
  return traitsOfTags(expand(tags));
}

/** what a card's work is: how its turns are spent (the trait rules shorten labour or travel) */
export type WorkKind = 'labour' | 'travel' | 'talk';

export interface TraitRule {
  /** this kind of work takes `factor` of the turns when every pawn doing it has the trait */
  faster?: { work: WorkKind; factor: number; why: string };
  /** upkeep (food carried for the work) is waived when every pawn has it */
  noUpkeep?: string;
  /** living cohorts where the pawns work take this much unrest */
  objection?: { unrest: number; why: string };
  /** losses come back between turns */
  recovers?: string;
}

export const TRAIT_RULES: Partial<Record<IntrinsicName, TraitRule>> = {
  undead: {
    faster: { work: 'labour', factor: 0.5, why: 'undead work through the night' },
    noUpkeep: 'the undead eat nothing',
    objection: { unrest: 0.1, why: 'the living object to the dead at work among them' },
  },
  regenerating: { recovers: 'regenerates: back at full strength by the next turn' },
  flying: { faster: { work: 'travel', factor: 0.5, why: 'flies over the barriers on the way' } },
};

/** The trait rules that hold for a set of committed pawns (a rule holds when every pawn has its trait). */
export function crewRules(pawns: Pick<Agent, 'tags' | 'parts'>[]): { trait: IntrinsicName; rule: TraitRule }[] {
  if (!pawns.length) return [];
  const sets = pawns.map((p) => new Set(pawnTraits(p)));
  return (Object.keys(TRAIT_RULES) as IntrinsicName[]).filter((t) => sets.every((s) => s.has(t))).map((t) => ({ trait: t, rule: TRAIT_RULES[t]! }));
}

/** a card's turns for this crew, and why */
export function crewTurns(turns: number, work: WorkKind, pawns: Pick<Agent, 'tags' | 'parts'>[]): { turns: number; why: string[] } {
  let t = turns;
  const why: string[] = [];
  for (const { rule } of crewRules(pawns))
    if (rule.faster && rule.faster.work === work) {
      t = Math.max(1, Math.ceil(t * rule.faster.factor));
      why.push(`${rule.faster.why}: ${turns} → ${t} turns`);
    }
  return { turns: t, why };
}
