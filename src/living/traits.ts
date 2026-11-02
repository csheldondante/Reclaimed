// ---- living/traits.ts ---------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F7) Traits at the opportunity scale — one vocabulary with the agents' trait system
// (api/contracts/traits.ts: living, undead, flying, regenerating, fire_immune …). The user (round 125): "this should
// probably interact with our unit traits and modular units. Undead may work tirelessly with no sleep. Gnoll knights may
// regenerate etc".
//
// Where a pawn's traits come from (each a list of tags, made traits by traits.ts `traitsOfTags`, the same function a
// recipe Kind's tags seed the GPU trait bits with):
//   - its species ('species:gnoll' → SPECIES_TRAITS.gnoll),
//   - its own tags (a trait named outright: 'undead'),
//   - its parts: the creature generator's body parts and, later, its gear (Agent.parts).
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

import { traitsOfTags, type IntrinsicName } from '../api/contracts/traits';
import type { Agent } from '../api/contracts/opportunity';
import type { EntityId, FactStore } from '../api/contracts/facts';

/** a species' intrinsic traits (the creature generator's species; a new species is a row) */
export const SPECIES_TRAITS: Record<string, IntrinsicName[]> = {
  human: ['living'],
  gnoll: ['living', 'regenerating'],
  skeleton: ['undead'],
  ghoul: ['undead'],
  griffin: ['living', 'flying'],
  golem: ['construct'],
};

/** tags → the tags they stand for ('species:gnoll' → living, regenerating) */
function expand(tags: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of tags) {
    out.push(t);
    if (t.startsWith('species:')) out.push(...(SPECIES_TRAITS[t.slice(8)] ?? []));
  }
  return out;
}

/** a pawn's traits: its tags, its species', its body's and gear's */
export function pawnTraits(a: Pick<Agent, 'tags' | 'parts'>): IntrinsicName[] {
  return traitsOfTags(expand([...a.tags, ...(a.parts?.body ?? []), ...(a.parts?.gear ?? [])]));
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
