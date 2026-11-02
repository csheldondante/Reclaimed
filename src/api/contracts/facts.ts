// ---- api/contracts/facts.ts ---------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F1) The fact layer: the living world's entities, scoped tags, typed relations, claims
// and event history — the lightweight queryable layer the user's design asks for (docs/design/FACTIONS_WORLD_STATE.md
// §7: "Build a small fact layer over the existing simulation/ECS. No dedicated graph database, general rule engine, or
// full legal/sociological simulation"). Types and the pure rules here; the store is facts-store.ts (MemoryFacts).
//
// One source of truth for each fact:
//   - what another system already owns is never copied in: a settlement's holder, stores and people, a region's water,
//     a faction's power and attitudes, a character's region stay in WorldState (world.ts) and change only through
//     WorldState.apply. An entity carries a `ref` to that record; the fact world (src/living/world.ts) reads quantities
//     and derived relations (a settlement's holder as `controls`) through it.
//   - diplomacy is merged in: its agreements are relations here (war, alliance, trade, rights …) and its interactions
//     are events here. MemoryDiplomacy (diplomacy-memory.ts) is now a view over a FactStore: the Diplomacy API holds,
//     the records live once.
// Scopes are kept apart (the user's doc §3: "A polity's law is not automatically every faction's belief; a faction's
// custom is not every resident's custom; a species' physical abilities are not a political ideology"): a tag names its
// scope and each scope says which kinds of entity may carry it. Rules are booleans or enums, intensities bounded
// numbers 0..1, and quantities are never tags (they are read from their owner).

import type { RegionId } from './world';

// ---- entities --------------------------------------------------------------------------------------------------------

export type EntityKind = 'person' | 'faction' | 'cohort' | 'polity' | 'settlement' | 'site' | 'route' | 'army' | 'unit' | 'building' | 'relic' | 'deposit' | 'arc';
export const ENTITY_KINDS: readonly EntityKind[] = ['person', 'faction', 'cohort', 'polity', 'settlement', 'site', 'route', 'army', 'unit', 'building', 'relic', 'deposit', 'arc'];

/** an entity's id: the owning system's own id where there is one (a faction's, a settlement's, a character's) */
export type EntityId = string;

/** where an entity is: a region, a settlement in it, a site, a point (world cells); any may be absent */
export interface FactLocation {
  region?: RegionId;
  settlement?: EntityId;
  site?: EntityId;
  at?: [number, number];
}

/** the record another system owns for this entity (its name, place, holder and quantities are read from there) */
export type EntityRef =
  | { faction: string }
  | { settlement: string }
  | { character: string }
  /** a building placed in a settlement (Settlement.buildings: placed directly, no agents building it) */
  | { building: { settlement: string; id: string } }
  /** a cohort: the people of a role in a settlement (Settlement.people) */
  | { people: { settlement: string; role: string } };

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  name: string;
  /** where it is (a ref'd entity's place is its owner's; this is for the fact layer's own entities) */
  at: FactLocation;
  ref?: EntityRef;
  tags: ScopedTag[];
  /** small descriptive attributes that no system owns (a relic's age, an arc's stage) — never a quantity */
  attrs: Record<string, string | number | boolean>;
  since: number;
  cause?: string;
}

// ---- scoped tags -----------------------------------------------------------------------------------------------------

export type TagScope = 'biology' | 'custom' | 'economy' | 'government' | 'law' | 'culture' | 'capability' | 'condition';
export const TAG_SCOPES: readonly TagScope[] = ['biology', 'custom', 'economy', 'government', 'law', 'culture', 'capability', 'condition'];

/** Which kinds may carry a scope: law lives on a jurisdiction (a polity, or a settlement's local override), never on a
 *  cohort; customs on groups; biology on living things. */
export const SCOPE_KINDS: Record<TagScope, readonly EntityKind[]> = {
  biology: ['person', 'cohort', 'unit', 'army'],
  custom: ['cohort', 'faction', 'person'],
  economy: ['cohort', 'faction', 'polity', 'settlement', 'site', 'deposit', 'route', 'building'],
  government: ['polity', 'faction', 'settlement'],
  law: ['polity', 'settlement'],
  culture: ['cohort', 'faction', 'polity', 'person'],
  capability: ['person', 'faction', 'cohort', 'polity', 'settlement', 'army', 'unit'],
  condition: ENTITY_KINDS,
};

/** A tag: a rule (boolean or enum string) or an intensity (a number in 0..1). */
export interface ScopedTag {
  scope: TagScope;
  key: string;
  value: boolean | string | number;
  since: number;
  cause?: string;
}

/** The intensities (bounded 0..1): the few meters the doc allows ("Avoid inventing hundreds of independent meters"). */
export const INTENSITIES = ['support', 'unrest', 'enforcement', 'prosperity', 'piety', 'fear'] as const;

/** Quantities are the simulation's (population, food, water, ore …): never a tag. A tag with one of these keys is refused. */
export const QUANTITIES = ['population', 'people', 'food', 'grain', 'water', 'stone', 'timber', 'ore', 'coin', 'gold', 'distance', 'power', 'stock'] as const;

/** Law keys whose values are exclusive in one jurisdiction (an enum key holds one value by construction); and pairs of
 *  boolean tags that may not both hold in one jurisdiction (the doc's "mutually exclusive governing policies"). */
export const EXCLUSIVE: { scope: TagScope; keys: [string, string] }[] = [
  { scope: 'government', keys: ['authoritarian', 'elected_offices'] },
  { scope: 'government', keys: ['hereditary_nobility', 'abolished_nobility'] },
  { scope: 'economy', keys: ['state_planning', 'free_enterprise'] },
];

// ---- relations -------------------------------------------------------------------------------------------------------

export type RelationFamily = 'membership' | 'political' | 'control' | 'economic' | 'kinship';

/** The relation types and their family. Open in spirit (a new type is a row here), closed in code so a typo is an error. */
export const RELATION_TYPES = {
  // membership / jurisdiction
  member_of: 'membership',
  resident_at: 'membership',
  part_of_polity: 'membership',
  governs: 'membership',
  subject_to_law: 'membership',
  // political / personal (war and alliance are explicit facts, never read off a score)
  allied_with: 'political',
  at_war_with: 'political',
  at_peace_with: 'political',
  truce_with: 'political',
  vassal_of: 'political',
  loyal_to: 'political',
  rival_of: 'political',
  friend_of: 'political',
  owes_favor_to: 'political',
  grievance_against: 'political',
  // control / rights (a claim is not here: claims are their own records)
  controls: 'control',
  owns: 'control',
  occupies: 'control',
  has_access_to: 'control',
  has_rights: 'control',
  // economic / logistical
  trades_with: 'economic',
  supplies: 'economic',
  connected_by: 'economic',
  employs: 'economic',
  depends_on: 'economic',
  pays_tribute_to: 'economic',
  downstream_of: 'economic',
  // kinship / narrative (and the materialised history: former_*)
  parent_of: 'kinship',
  heir_to: 'kinship',
  former_ally_of: 'kinship',
  former_enemy_of: 'kinship',
  betrayed: 'kinship',
  rescued: 'kinship',
  exiled_by: 'kinship',
} as const satisfies Record<string, RelationFamily>;
export type RelationType = keyof typeof RELATION_TYPES;

/** When a relation of this type ends, the store keeps the history edge (cheap queries: "former friends turned rivals"). */
export const HISTORIC: Partial<Record<RelationType, RelationType>> = { allied_with: 'former_ally_of', at_war_with: 'former_enemy_of', friend_of: 'former_ally_of' };

/** Directed: `from` → `to` (asymmetric allowed). A symmetric one (war, alliance, peace, trade) holds both ways as one record. */
export interface Relation {
  id: string;
  type: RelationType;
  from: EntityId;
  to: EntityId;
  /** bounded 0..1 (a grievance's weight, a loyalty's); absent: just true */
  strength?: number;
  symmetric?: boolean;
  /** the agreement it is, when it came from diplomacy (its places, covers, flows, status — diplomacy.ts Agreement) */
  agreement?: import('./diplomacy').Agreement;
  /** for an agreement of more than two parties: the rest */
  also?: EntityId[];
  /** whatever else the relation says (what water a downstream town depends on) */
  meta?: Record<string, string | number | boolean>;
  since: number;
  cause?: string;
  /** computed from another system's record (a settlement's holder): never stored, read-only here */
  derived?: true;
}

// ---- claims ----------------------------------------------------------------------------------------------------------

export type ClaimBasis = 'ancestral' | 'treaty' | 'conquest' | 'religious' | 'debt' | 'discovery';
export const CLAIM_BASES: readonly ClaimBasis[] = ['ancestral', 'treaty', 'conquest', 'religious', 'debt', 'discovery'];

/** A claim: kept distinct from control (who controls a thing is a relation or its owner's record; a claim is who says
 *  it should be theirs, on what basis, and who agrees). */
export interface Claim {
  id: string;
  claimant: EntityId;
  target: EntityId;
  /** what of the target (an office, water access): absent, the target itself */
  what?: string;
  basis: ClaimBasis;
  /** 0..1 */
  strength: number;
  recognisedBy: EntityId[];
  /** the turn it lapses (absent: never) */
  expires?: number;
  since: number;
  cause?: string;
}

// ---- events ----------------------------------------------------------------------------------------------------------

/** One notable change, append-only: by turn, with real participants. Diplomacy's interactions are these (with a weight
 *  and a half-life); an opportunity's resolution, a law changed, a claim pressed, an arc's stage are too. */
export interface FactEvent {
  id: string;
  turn: number;
  /** the run it happened in (diplomacy fades by runs) and the seconds into it */
  run: number;
  t?: number;
  /** what happened: emancipation, treaty, betrayal, founding, gift, insult, killed … (open) */
  kind: string;
  /** who did it and to whom (real entity ids; 'player' is the player) */
  by: EntityId[];
  to: EntityId[];
  /** who saw it */
  witnesses?: EntityId[];
  where?: FactLocation;
  /** diplomacy's: how much it moves the receiver's opinion of the doer (−1..1), and runs for it to halve */
  weight?: number;
  halfLife?: number;
  /** what it was about: a thing, an agreement, an atlas event, an opportunity */
  about?: { thing?: string; agreement?: string; atlas?: string[]; opp?: string; claim?: string };
  note: string;
}

// ---- the store's API -------------------------------------------------------------------------------------------------

export interface FactQuery {
  kind?: EntityKind;
  /** carrying this tag (and value, when given) */
  tag?: { scope: TagScope; key: string; value?: ScopedTag['value'] };
  region?: RegionId;
  settlement?: EntityId;
}

export interface RelQuery {
  /** one relation by its id */
  id?: string;
  type?: RelationType;
  from?: EntityId;
  to?: EntityId;
  /** include the materialised history edges (former_*); default true */
  historic?: boolean;
}

export interface FactSnapshot {
  version: 1;
  turn: number;
  run: number;
  entities: Entity[];
  relations: Relation[];
  claims: Claim[];
  events: FactEvent[];
  seq: number;
}

/** A broken invariant: which, about whom, in a sentence. */
export interface Violation {
  rule: string;
  entity: EntityId;
  why: string;
}

/** The fact layer as systems use it: reads indexed, writes checked, changes tracked for evaluation. */
export interface FactStore {
  turn: number;
  run: number;
  entity(id: EntityId): Entity | undefined;
  find(q: FactQuery): Entity[];
  tag(id: EntityId, scope: TagScope, key: string): ScopedTag | undefined;
  relations(q: RelQuery): Relation[];
  claims(q?: { claimant?: EntityId; target?: EntityId }): Claim[];
  events(q?: { kind?: string; involving?: EntityId; since?: number }): FactEvent[];

  add(e: Omit<Entity, 'since' | 'tags' | 'attrs' | 'at'> & Partial<Pick<Entity, 'tags' | 'attrs' | 'at' | 'since'>>): Entity;
  remove(id: EntityId, cause?: string): void;
  setTag(id: EntityId, scope: TagScope, key: string, value: ScopedTag['value'], cause?: string): void;
  dropTag(id: EntityId, scope: TagScope, key: string): void;
  /** an intensity moved by `delta`, clamped to 0..1 (created at 0 when absent) */
  bump(id: EntityId, key: (typeof INTENSITIES)[number], delta: number, cause?: string): number;
  relate(r: Omit<Relation, 'id' | 'since' | 'derived'> & { since?: number }): Relation;
  /** end relations matching (their history edge kept); returns what ended */
  unrelate(q: RelQuery & { type: RelationType }, cause?: string): Relation[];
  claim(c: Omit<Claim, 'id' | 'since' | 'recognisedBy'> & { recognisedBy?: EntityId[] }): Claim;
  dropClaim(id: string): void;
  record(e: Omit<FactEvent, 'id' | 'turn' | 'run'> & { turn?: number; run?: number; id?: string }): FactEvent;

  /** the entities changed since the last drain (the engine evaluates templates on these) */
  drainChanged(): Set<EntityId>;
  snapshot(): FactSnapshot;
}

// ---- pure rules ------------------------------------------------------------------------------------------------------

/** the reason a tag can't be set on this entity, or null */
export function tagRefusal(e: Pick<Entity, 'id' | 'kind'>, scope: TagScope, key: string, value: ScopedTag['value']): string | null {
  if (!TAG_SCOPES.includes(scope)) return `no tag scope ${scope}`;
  if (!SCOPE_KINDS[scope].includes(e.kind)) return `${e.id} is a ${e.kind}: it can't carry a ${scope} tag (${key}) — ${scope} belongs on ${SCOPE_KINDS[scope].join(', ')}`;
  if ((QUANTITIES as readonly string[]).includes(key)) return `${key} is a quantity: read it from its owner, never copy it into a tag`;
  if (typeof value === 'number') {
    if (!(INTENSITIES as readonly string[]).includes(key)) return `${key}: a number is an intensity, and the intensities are ${INTENSITIES.join(', ')}`;
    if (!(value >= 0 && value <= 1)) return `${key}: an intensity is 0..1 (${value})`;
  }
  return null;
}

/** whether a relation holds from a to b (a symmetric one either way) */
export function holds(r: Relation, a: EntityId, b: EntityId): boolean {
  return (r.from === a && r.to === b) || (!!r.symmetric && r.from === b && r.to === a);
}
