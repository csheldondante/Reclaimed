// Traits and effects (Living World slice 1, BACKLOG LW1; docs/design/LIVING_WORLD_v3.md §1, §4, §5; DECISIONS round 120).
// The user, verbatim: "I think that the systems that process traits for things like combat and other interactions are
// essentially game specific logic but we want it GPU bound and cheap so we can use it on our agents. Modular
// architecture here is key."
//
// Three things, each its own concern:
//   1. TRAITS — what a thing is (intrinsic: living, undead, fire_immune …) and what is happening to it (statuses with
//      a timer: burning, frightened, healing, raised, petrified …). One id space for agents, bodies, structures and
//      materials. A recipe Kind's tags (recipe.ts) seed them: a tag named as a trait is that trait (`traitsOfTags`).
//   2. EFFECTS — operations put into the world: a healing field (an area, a strength a second, a duration), a raise,
//      damage typed fire / life / necrotic / physical, a status laid on (fear, petrify). Fields last; bursts are one
//      tick. They act on agents through the trait modules, and on fields and geometry through the existing systems'
//      own channels (vegetation: the Grow event; structures: the Mend event).
//   3. MODULES — the interaction rules: small GPU kernels the GAME registers ("healing on undead harms", "fire on
//      fire_immune does nothing", "raise turns a dead living agent into undead with its role"), each parameterised by
//      a data table. The engine knows only the trait buffers and this interface; adding a module touches no other.
//
// Why statuses are verbs (§4 "statuses are verbs on the simulation"): a module never edits the agents' step. What the
// step must honour (can't burn, can't drown, rooted, flees its field) it reads from one engine word per unit, CAPS,
// which modules derive from traits each tick (round 85: "derived capabilities as separate rules"). What the draw shows
// (a tint, a halo, sparks, a body lying) is a second word, LOOK, derived the same way. Traits are the game's data;
// caps and look are the engine's — converted at that boundary, never shared.

import type { Tag } from './recipe';

// ---- 1. traits ------------------------------------------------------------------------------------------------

/** Intrinsic traits (bits 0..15 of an entity's trait word). Names, not schema: a game may add its own in the free bits. */
export const INTRINSIC = ['living', 'undead', 'flying', 'construct', 'fire_immune', 'regenerating', 'invisible', 'incorporeal'] as const;
/** Statuses (bits 16..23): each has an expiry (a tick, or for ever). `burning` mirrors the agents' own fire; `corpse` is
 *  a fallen agent's body, kept for a while so it can be raised (then it decays and its slot is freed). */
export const STATUSES = ['burning', 'frightened', 'healing', 'raised', 'petrified', 'corpse', 'harmed', 'blessed'] as const;
export type IntrinsicName = (typeof INTRINSIC)[number];
export type StatusName = (typeof STATUSES)[number];
export type TraitName = IntrinsicName | StatusName;
/** the first status bit */
export const STATUS_BIT = 16;
export const MAX_STATUSES = 8;

/** A trait's bit index. Throws on a name that isn't one. */
export function traitBit(t: TraitName): number {
  const i = (INTRINSIC as readonly string[]).indexOf(t);
  if (i >= 0) return i;
  const s = (STATUSES as readonly string[]).indexOf(t);
  if (s >= 0) return STATUS_BIT + s;
  throw new Error(`traits: no trait "${t}"`);
}
/** A status's index (its timer slot). */
export function statusIndex(s: StatusName): number {
  const i = (STATUSES as readonly string[]).indexOf(s);
  if (i < 0) throw new Error(`traits: no status "${s}"`);
  return i;
}
/** The bit mask of a set of traits. */
export function traitMask(ts: readonly TraitName[]): number {
  let m = 0;
  for (const t of ts) m |= 1 << traitBit(t);
  return m >>> 0;
}
/** The names in a mask (bits that aren't named are left out). */
export function traitNames(mask: number): TraitName[] {
  const out: TraitName[] = [];
  INTRINSIC.forEach((t, i) => (mask >>> i) & 1 && out.push(t));
  STATUSES.forEach((t, i) => (mask >>> (STATUS_BIT + i)) & 1 && out.push(t));
  return out;
}
/** A kind's tags seed its traits (round 85's Kind tags): a tag named as an intrinsic trait is that trait. Statuses
 *  aren't seeded — they happen to a thing. */
export function traitsOfTags(tags: Iterable<Tag>): IntrinsicName[] {
  const out = new Set<IntrinsicName>();
  for (const t of tags) if ((INTRINSIC as readonly string[]).includes(t)) out.add(t as IntrinsicName);
  return [...out];
}

/**
 * Materials share the ids (one trait system across agents, bodies, structures and materials): what a material IS, for
 * the rules that reach it through the world's systems — the sanctuary mends `construct` ground and grows `living`
 * ground; fire passes `fire_immune` ground by. Keyed by material name (world/materials.ts).
 */
export const MATERIAL_TRAITS: Readonly<Record<string, readonly IntrinsicName[]>> = {
  stone: ['construct', 'fire_immune'],
  concrete: ['construct', 'fire_immune'],
  brick: ['construct', 'fire_immune'],
  steel: ['construct', 'fire_immune'],
  rust: ['construct', 'fire_immune'],
  plaster: ['construct', 'fire_immune'],
  tile: ['construct', 'fire_immune'],
  sandstone: ['construct', 'fire_immune'],
  basalt: ['fire_immune'],
  obsidian: ['fire_immune'],
  bedrock: ['fire_immune'],
  wood: ['living'],
  log: ['construct'],
  leaves: ['living'],
  grass: ['living'],
  flower: ['living'],
  soil: ['living'],
  bone: ['undead'],
  flesh: ['living'],
};

// ---- 2. effects ---------------------------------------------------------------------------------------------

/** What damage is: the resist table's columns (Master of Magic's lesson: the type decides who it reaches). */
export const DAMAGE_TYPES = ['fire', 'life', 'necrotic', 'physical'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** Where an effect reaches: a disc (world x, y; radius cells), any height unless `z` is given (then ± radius). */
export interface EffectArea {
  at: [number, number];
  z?: number;
  radius: number;
}

/** An effect put into the world. `seconds` 0 (the default for raise and burst damage): one tick, a burst. */
export type EffectSpec =
  /** restoration: hit points a second to whoever the game's rules let it heal (and whatever else they say it does to
   *  the rest: harm the undead). `world`: it also grows living ground and mends constructs there (the existing systems'
   *  Grow and Mend events, every `every` s) */
  | (EffectArea & { op: 'heal'; rate: number; seconds?: number; world?: { grow?: boolean; mend?: boolean; every?: number } })
  /** raise the fallen: corpses the rules allow rise into `group` (the raiser's), with `health` of their hit points;
   *  `bound` s until the binding fails (0 or omitted: for ever) */
  | (EffectArea & { op: 'raise'; group: number; health?: number; bound?: number; seconds?: number })
  /** damage of a type: `amount` once (a burst), or `amount` a second over `seconds` (a field) */
  | (EffectArea & { op: 'damage'; type: DamageType; amount: number; seconds?: number })
  /** a status laid on for `lasts` s (0: for ever), over `seconds` (0: once) */
  | (EffectArea & { op: 'status'; status: StatusName; lasts: number; seconds?: number });

export type EffectId = number;

// ---- 3. modules ---------------------------------------------------------------------------------------------

/**
 * An interaction rule, as the game registers it: a small GPU kernel run over every agent slot each tick, after the
 * agents' step and before their draw, in `order` (then registration order). It sees the trait prelude
 * (src/traits/prelude.wgsl: the units, their traits, the effects this tick, its own table, emit) and defines
 * `fn module_main(u: u32)`. One thread a slot; it may write only its own slot. It is parameterised by `table`: up to
 * 16 vec4 (256 bytes), its rows as the module documents them. A module knows no other module.
 */
export interface TraitModule {
  name: string;
  /** the WGSL: `fn module_main(u: u32) { … }` and whatever helpers it needs (names prefixed by the module's) */
  wgsl: string;
  /** its data table, ≤ 64 words (f32 or u32 bit patterns; packTable helps) */
  table?: ArrayBufferView;
  /** lower runs first (default 100). The core's bookkeeping runs before all and after all. */
  order?: number;
}

/** The trait system as a game uses it (src/traits/system.ts implements it on the GPU agents). */
export interface TraitsApi {
  /** a kind (the agents' kind index or name) starts with these traits (default: living) */
  kindTraits(kind: number | string, traits: readonly IntrinsicName[]): void;
  /** these agents (ids) carry these traits from now on (their statuses kept) — an agent spawned as a walking dead. 64
   *  are applied a tick; more wait their turn (a whole kind: kindTraits) */
  assign(ids: readonly number[], traits: readonly IntrinsicName[]): void;
  /** put an effect into the world; returns its id */
  apply(e: EffectSpec): EffectId;
  /** end a lasting effect now (a sanctuary torn down) */
  end(id: EffectId): void;
  /** register a game rule; replaces none (a name already registered is an error) */
  register(m: TraitModule): void;
  unregister(name: string): void;
  /** the registered rules, in the order they run */
  modules(): readonly string[];
  /** an agent's traits at the last read (`read()`), or null */
  traitsOf(id: number): TraitName[] | null;
  /** read every agent's trait word back (tests, the station's counts; not for each frame) */
  read(): Promise<void>;
}
