// Inhabitants — creatures and people with bodies, procedural animation and wilderness behaviour (round 117,
// docs/INHABITANTS.md). The user's design, verbatim (round 117):
//   "lively animated agents inhabiting our world"
//   "For units I want rain world style procedural animation with secondary features like capes or fur. I want
//    hunanoid an non. It doesn't have to be high fidelity it does have to be readable and look cool."
//   "Fill the wilderness with boids of various animals. Herds, predators that stalk."
//   (round 116) "A dragon can already have fire breath that melts stone and generating wind with wings will already
//    kick up dust and knock over agents."
//
// What this contract is for: other tracks give species and paths as DATA, spawn and drive groups, and read where
// creatures are and how dangerous a region is. How bodies are built, animated and drawn (src/inhabitants: a GPU
// population, its rigs and its mesh) is the implementation's business.
// - Coordinates: the level's window, as the world API's and units.ts's (x, y world units, z the ground's height).
// - Hostile creatures are soft barriers for runs (r117 "transient soft barriers like hostile agents"): `presence`
//   gives density and threat per region for the run planner and the terrain track.
//
//   const life = reclaimed.inhabitants                     // the level's (?life=1), or installInhabitants(core, host)
//   const deer = life.define(SPECIES.deer)                  // or a spec of your own (a body plan + parameters)
//   const herd = life.spawnGroup(deer, [x, y], 12)
//   life.drive(herd, { kind: 'roam', around: [x, y], radius: 30 })
//   const wolf = life.spawnGroup(life.define(SPECIES.wolf), [x + 60, y], 3)
//   life.presence({ x0, y0, x1, y1 }, 32)                   // { density, threat } a region

import type { V2, V3 } from './units';

/** A body plan: what the body generator (inhabitants/rig.ts) builds the skeleton from. */
export type BodyPlan =
  /** upright on two legs, arms that swing (people, goblins, knights) */
  | 'biped'
  /** four legs, a spine that bends, a neck and tail (deer, wolves, horses) */
  | 'quadruped'
  /** two legs, two wings that flap; flies in flocks */
  | 'bird'
  /** a long spine that follows its head, no legs (snakes, wyrms) */
  | 'serpent'
  /** six legs, segmented body, antennae (beetles, ants) */
  | 'insect'
  /** heavy quadruped: big forequarters, low head, a mane (bears, ogre-beasts) */
  | 'beast'
  /** a quadruped with wings and a long neck and tail (dragons) */
  | 'winged';

export const BODY_PLANS: readonly BodyPlan[] = ['biped', 'quadruped', 'bird', 'serpent', 'insect', 'beast', 'winged'];

/** Proportions, each a multiplier of the plan's default (1 = the plan's own). */
export interface Proportions {
  /** overall size: the root's height above the ground scales with it (cells) — absolute, not a multiplier */
  size?: number;
  /** leg length */
  legs?: number;
  /** body length (spine) */
  body?: number;
  /** girth (radius of the body) */
  girth?: number;
  neck?: number;
  head?: number;
  tail?: number;
  /** wing span */
  wings?: number;
  /** serpents and insects: spine segments (absolute count) */
  segments?: number;
}

/** Colours, '#rrggbb'. */
export interface Palette {
  body: string;
  /** belly, inner limbs, muzzle */
  belly?: string;
  /** horns, beak, claws, stripes */
  accent?: string;
  /** eyes (bright reads at a distance) */
  eye?: string;
}

/** Secondary motion: soft parts simulated as verlet chains, driven by the body and the world's wind. */
export interface Secondary {
  /** a ridge of tufts along the back that sway (0 none, 1 a full mane) */
  fur?: number;
  fur_colour?: string;
  /** tail flexibility 0 (stiff) .. 1 (whippy) */
  tailFlex?: number;
}

/** Gear slots: things worn or carried that the body draws (a recipe's `armour`, `weapon`; compose.ts later). */
export type GearSlot = 'cape' | 'hood' | 'pack' | 'weapon' | 'shield' | 'saddle';
export interface Gear {
  slot: GearSlot;
  colour: string;
  /** cape length, weapon length (cells; default by slot) */
  size?: number;
}

/**
 * An ability: something a creature does to the world through the world's own systems (no effects of its own: the
 * effects library is deferred). The implementation calls an `AbilityHost` the level gives it.
 */
export type Ability =
  /** breath: fire where it lands, heat that melts stone (the lava system's beam) */
  | { kind: 'fireBreath'; range: number; every: number; radius?: number }
  /** wing beats: a wind blow under it (the wind API) that lifts dust and knocks agents over */
  | { kind: 'wingGust'; strength: number; radius: number; every: number };

/** What it does left to itself. */
export type Behaviour =
  /** grazes near its group, walks on, bolts from predators (boids: separation, alignment, cohesion) */
  | { kind: 'herd' }
  /** flies in a flock round its group's home (3D boids) */
  | { kind: 'flock' }
  /** stalks the nearest herd of its prey low and slow, then sprints, then rests */
  | { kind: 'stalker'; prey: string[] }
  /** walks the paths it's given (structures' baked paths: stairs, ramparts, elevators) */
  | { kind: 'townsfolk' }
  /** wanders alone near its group's home */
  | { kind: 'wander' };

export interface SpeciesSpec {
  /** a name others refer to it by ('deer'; a stalker's `prey` lists these) */
  id: string;
  plan: BodyPlan;
  /** body variation is deterministic from it */
  seed?: number;
  proportions?: Proportions;
  palette: Palette;
  secondary?: Secondary;
  gear?: Gear[];
  behaviour: Behaviour;
  abilities?: Ability[];
  /** cells/s walking (default by plan) */
  walk?: number;
  /** cells/s running or fleeing (default by plan) */
  run?: number;
  /** cells it notices a threat or prey within (default 14) */
  sight?: number;
  /** 0 harmless .. 1 deadly: what `presence` sums (default: stalkers 0.8, others 0) */
  threat?: number;
  /** how hard the wind must blow to knock it over goes with it (default by size) */
  mass?: number;
}

export type SpeciesId = number;
export type GroupId = number;

/** Orders for a group (all its members). */
export type GroupOrder =
  /** stay round a point (the default: round where it was spawned) */
  | { kind: 'roam'; around: V2; radius: number }
  /** all go to a point, then roam there */
  | { kind: 'go'; to: V2 }
  /** run from a point (a hero's charge, a storm) for `seconds` */
  | { kind: 'flee'; from: V2; seconds?: number }
  /** walk the given paths (townsfolk) */
  | { kind: 'paths' }
  /** a director's order: circle a point at a gait, whatever the behaviour (the viewer; a cutscene) */
  | { kind: 'pace'; gait: 'idle' | 'walk' | 'run' | 'fly'; around: V2; radius: number };

/**
 * Walkable paths baked into structures (r117: "bake paths into the tiles we generate so agents can interact with
 * them. Taking elevators, stairs, walking on ramparts"). The STRUCTURES track's to give; `standInPaths()` in
 * src/inhabitants/paths.ts stands in until it does. Nodes in window coordinates; z null: on the ground there.
 */
export interface WalkPaths {
  nodes: { at: [number, number, number | null] }[];
  edges: { a: number; b: number; kind: 'walk' | 'stairs' | 'rampart' | 'elevator' | 'ladder' }[];
}

/** Density and threat over a rectangle in `cell`-sized regions (row-major, x fastest). */
export interface Presence {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  /** creatures a region */
  density: Float32Array;
  /** the sum of their species' threat a region (soft barriers: a pack of wolves ~2.4) */
  threat: Float32Array;
}

export interface GroupView {
  id: GroupId;
  species: string;
  /** members alive */
  count: number;
  /** the members' mean position (last read from the GPU, ~0.5 s old) */
  centre: V3;
  order: GroupOrder;
}

/** What the level gives so abilities act through the world's systems (stand-ins for the effects library). */
export interface AbilityHost {
  ignite(x: number, y: number, radius: number, intensity: number): void;
  /** heat that melts the ground (°C-ish power; the lava system's beam), for `seconds` */
  heat(at: V3, radius: number, power: number, seconds: number): void;
  /** a wind blow from (x, y): strength cells/s outward, for `seconds` */
  blow(x: number, y: number, radius: number, strength: number, seconds: number): void;
}

/** The inhabitants system as other tracks use it. */
export interface Inhabitants {
  /** register a species (same id again: the same SpeciesId, its spec replaced) */
  define(spec: SpeciesSpec): SpeciesId;
  species(id: SpeciesId): SpeciesSpec;
  /** n members round `at` (spread: cells, default by size); returns the group */
  spawnGroup(species: SpeciesId, at: V2, n: number, opts?: { spread?: number; seed?: number }): GroupId;
  drive(group: GroupId, order: GroupOrder): void;
  remove(group: GroupId): void;
  groups(): readonly GroupView[];
  /** the paths townsfolk walk (replaces the last set) */
  setPaths(paths: WalkPaths): void;
  /** the level's hooks for abilities (fire, heat, wind) */
  setAbilityHost(host: AbilityHost | null): void;
  /** density and threat over a rectangle, from the groups' last-read centres (cheap; any scale) */
  presence(rect: { x0: number; y0: number; x1: number; y1: number }, cell: number): Presence;
  /** creatures alive */
  readonly count: number;
  /** the window slid by (dx, dy, dz) (streamed worlds; WorldCore.onShift's sense): what's in it moves by minus that */
  shift(dx: number, dy: number, dz: number): void;
  /** each frame (orders, reads, abilities) */
  update(dt: number): void;
}
