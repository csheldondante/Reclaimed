// Things made of things: recipes, instances, derived capabilities, civilizations (round 85, docs/SYSTEMS.md
// systems 6, 7 and 12). The user: "units, items, vehicles, buildings, and even civilizations are compositions
// of reusable ingredients, defined through a shared, data-driven recipe system" — a knight is a person +
// training + armour + a mount, and the mount can be a horse or a hoverbike; a furnace, a reactor or a magic
// stone can each satisfy "power"; a primitive people can turn a ruined megastructure into apartments.
// "Possessing technology and knowing how to reproduce it are distinct."
//
// Five layers, kept apart:
//   1. Kinds and recipes — what things are (tags) and what can be combined (slots that accept tags).
//   2. Instances — actual things: their parts, material, condition, owner, where they are, their history.
//   3. Derived capabilities — rules over a composition's tags give its stats and abilities (compose.ts).
//   4. Civilization profiles — what a people knows, can make, prefers and how it builds.
//   5. Presentation — a look derived from the same data, later (Look, below, is only the hook).
// One model for units, items, vehicles and buildings: a hoverbike is the same kind of record in a garage, under
// a knight, or buried in a ruin for a later people to dig up. Nothing here lists every combination: content is
// kinds, recipes and rules as data (data/recipes/), and anything whose tags fit a slot can go in it.

import type { FactionId, RegionId } from './world';

export type Tag = string;
export type KindId = string;
export type RecipeId = string;
export type InstanceId = string;
export type MaterialId = string;

/** Which tags a thing must have (all), may have one of (any), mustn't have (none). An empty query takes anything. */
export interface TagQuery {
  all?: Tag[];
  any?: Tag[];
  none?: Tag[];
}

/** A material: what it's like, how it ages, how it looks. Copper greens; iron rusts; stone weathers. */
export interface Material {
  id: MaterialId;
  name: string;
  /** e.g. metal, copper, stone, wood, fibre, ceramic, crystal, flesh, alloy, arcane */
  tags: Tag[];
  /** 0..1 each, the capability rules read them: hardness, weight, conductivity, heat, flammability, arcane … */
  props: Record<string, number>;
  /** what it turns into with time and weather (copper → verdigris), and how fast (condition lost a year) */
  ages?: { into: MaterialId; rate: number; when?: 'wet' | 'buried' | 'always' }[];
  /** for presentation: a base colour (sRGB) and a voxel material in the world's table, if it has one */
  tint: [number, number, number];
  voxel?: number;
}

/** A kind of thing: a person, a horse, a hoverbike, a sword, a furnace, a wall, a commune. */
export interface Kind {
  id: KindId;
  name: string;
  /** what it is, for slots and rules: person, living, mount, vehicle, powered, weapon, ranged, structure, facility … */
  tags: Tag[];
  /** what it's made of when nothing says otherwise (a recipe's material slot overrides) */
  material?: MaterialId;
  /** its own stats before parts (a person's strength, a mech's frame), read by the capability rules */
  base?: Record<string, number>;
  /** the slots it has for parts, whether or not a recipe made it (a mech has hands; a building has rooms) */
  slots?: Slot[];
  /** the bounding size in cells (presentation, placement, carrying) */
  size?: [number, number, number];
}

/** A place in a composition: what it takes and how many. */
export interface Slot {
  /** its name in the composition: rider, mount, armour, weapon, power, controls, room, roof, frame … */
  id: string;
  accepts: TagQuery;
  /** how many it takes (default 1); `optional` slots may stay empty */
  count?: number;
  optional?: boolean;
}

/**
 * How things are combined.
 * - assemble: parts are kept and can come apart again (a knight: person + training + armour + mount).
 * - craft: inputs are used up into something new (steel and leather into armour).
 * - train: a person gains a skill (a tag on them, kept with its source).
 * - adapt: a thing keeps its identity and gains parts or a new function (a ruined tower into apartments; a
 *   bow fitted to a mech's hand) — the original stays in the provenance.
 * - salvage: a thing is taken apart into parts and materials (the reverse of assemble or craft, lossy).
 */
export interface Recipe {
  id: RecipeId;
  name: string;
  how: 'assemble' | 'craft' | 'train' | 'adapt' | 'salvage';
  /** what it makes: a kind (craft, assemble), or for adapt/train the tags the result gains */
  makes?: KindId;
  gains?: Tag[];
  /** for adapt, train and salvage: the thing worked on */
  subject?: TagQuery;
  /** the ingredients: slots any thing whose tags fit can fill (a mount slot takes a horse or a hoverbike) */
  slots: Slot[];
  /** what must be at hand: facility tags (forge, workshop, reactor), what the maker must know (its knowledge
   *  keys, CivProfile.knowledge), and work (person-hours) */
  needs?: { facilities?: TagQuery[]; knowledge?: string[]; work?: number };
  /** what knowing this recipe is filed under in a civilization's knowledge (default: the recipe's id) */
  knowledge?: string;
}

/** Where a thing is: in a region at a place, inside another thing (a part, a pack, a building), or lost. */
export type Place =
  | { in: 'world'; region: RegionId; at: [number, number, number] }
  | { in: 'thing'; thing: InstanceId; slot?: string }
  /** buried or scattered in a region without a position yet: the region generator places it on arrival */
  | { in: 'region'; region: RegionId; how: 'buried' | 'scattered' | 'hoard' }
  | { in: 'gone' };

/** Something that happened to a thing: what the world remembers of it (and dialog can mention). */
export interface ThingEvent {
  what: 'made' | 'found' | 'dug-up' | 'salvaged' | 'repaired' | 'adapted' | 'given' | 'traded' | 'stolen'
    | 'looted' | 'lost' | 'buried' | 'broken' | 'named';
  run: number;
  /** who did it: a faction, a unit or character, the player */
  by?: { faction?: FactionId; who?: string; player?: boolean };
  /** a recipe, a deal (diplomacy.ts), a story's id */
  ref?: string;
  /** a line for the wiki and dialog: "taken from the drowned barracks at Kaudru" */
  note?: string;
}

/** An actual thing. Units, items, vehicles and buildings are all instances. */
export interface Instance {
  id: InstanceId;
  kind: KindId;
  /** a name if it has one (a named sword, a hero, a famous bridge) */
  name?: string;
  /** its parts by slot, in order (a knight: rider → person, mount → hoverbike) */
  parts: { slot: string; thing: InstanceId }[];
  /** the material it's made of, if not its kind's */
  material?: MaterialId;
  /** tags it gained (trained, adapted, cursed, blessed, patinated) beyond its kind's and its parts' */
  gained?: Tag[];
  /** 0 broken .. 1 new; and its material's ageing so far (0..1, presentation reads it: green copper) */
  condition: number;
  aged?: number;
  /** a stack (ore, grain, arrows): how many */
  count?: number;
  owner?: { faction?: FactionId; settlement?: string; who?: string } | null;
  place: Place;
  history: ThingEvent[];
}

/** What a composition can do: stats, abilities, the tags it ends up with. compose.ts derives it; nothing stores it. */
export interface Capabilities {
  tags: Tag[];
  stats: Record<string, number>;
  abilities: string[];
  /** requirements its parts left unmet (a hoverbike with no power source: it can't move) */
  unmet: string[];
}

/**
 * A rule that derives capabilities. It applies when the composition (the thing's tags and its parts' tags, a
 * part's as `slot:tag`) fits `when`. Rules are data: "anything with a mount part moves at the mount's speed",
 * "a powered thing with no power part is unmet", "ranged weapon + hands → ranged attack".
 */
export interface CapabilityRule {
  id: string;
  when: TagQuery;
  /** stats: added, then multiplied; `from` copies a part's stat (mount.speed → speed) */
  add?: Record<string, number>;
  mul?: Record<string, number>;
  from?: { slot: string; stat: string; as?: string }[];
  abilities?: string[];
  tags?: Tag[];
  /** what's missing when this rule applies (makes it a requirement rule) */
  unmet?: string;
}

/**
 * How well a people knows a thing. "Possessing technology and knowing how to reproduce it are distinct":
 * - uses: can operate what they have or find (knights on dug-up hoverbikes);
 * - repairs: can keep it working from parts;
 * - makes: can build new ones (with the facilities and materials);
 * - understands: can adapt and combine it into new recipes.
 */
export type Mastery = 'uses' | 'repairs' | 'makes' | 'understands';

/** A civilization's profile: what it knows, makes, likes and how it builds. A faction has one. */
export interface CivProfile {
  id: string;
  name: string;
  /** knowledge keys (recipe ids or what they're filed under, a technology's tag) → how well */
  knowledge: Record<string, Mastery>;
  /** what it can build with: facility tags it has (forge, kiln, foundry, reactor, shrine) */
  facilities: Tag[];
  /** tastes, −1 shuns .. 1 loves: materials (copper, red steel, cedar), tags (ornate, fortified, ranged, arcane) */
  prefers: { materials: Partial<Record<MaterialId, number>>; tags: Partial<Record<Tag, number>> };
  /** how it lays out and builds places (settlement.ts GridStyle; architecture tags: domes, stilts, terraces) */
  builds: { grids: import('./settlement').GridStyle[]; architecture: Tag[]; storeys: [number, number] };
  /** what it values, for the GM, dialog and diplomacy: trade, honour, faith, growth, secrecy … (0..1) */
  values: Record<string, number>;
  /** where it came from: a people it grew out of, or the run that founded it (legacy) */
  heritage?: { from?: string; run?: number };
}

/** Presentation, later: the procedural geometry, materials, attachments and animation read the same data. */
export interface Look {
  /** the composition (kind and parts' kinds, by slot), the materials and their ageing, the civ's taste */
  kind: KindId;
  parts: { slot: string; look: Look }[];
  material: MaterialId;
  aged: number;
  condition: number;
  style: Tag[];
}
