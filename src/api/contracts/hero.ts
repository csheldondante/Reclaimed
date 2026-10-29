// Heroes — who the player is in a run (round 88, docs/SYSTEMS.md system 8; docs/HEROES.md for the hoverbike
// session). The user: "I would like to try spawning as a character like in hoverbike and talking to people or
// going places or fighting things for a run story."
// A hero is a body in the world plus what it can do; a controller turns the player's input (touch, keys) into
// an intent; the run reads the hero's position for `reached`, frames it with the chase camera, and hears
// when it's hurt or dies. Everything a hero does to the world goes through the world API, the units (Units)
// and items — never another system's insides.
// - Implementations: src/hero/walker.ts `Walker` (on foot, a sword); the hoverbike game's heroes (the
//   hoverbike knight, the lich, the tank, the mech, the hookshot knight) implement the same interface.
// - Coordinates: the level's window (x cells, y world units, z the ground), as the world API's.
//
//   const hero = new Walker({ ground: sim.terrain, units }, [x, y])
//   const pad = new TouchPad(ui, camera)                     // or the hero game's own controller
//   each frame: hero.update(dt, pad.intent())
//   camera: hero.camera (zoom, the preferred azimuth behind its heading, Orbit.prefer's dead zone)

import type { Mobility } from './traversal';
import type { Actor, Units, V2, V3 } from './units';

/**
 * (round 112, herosandbox) The contract's version, "major.minor": a hero module (docs/HEROES.md "Heroes from
 * another build") declares the version it was built against as `heroContract`; it loads when the majors match
 * and its minor is no newer than this. Additive changes bump the minor; a changed signature bumps the major.
 * - 1.0: round 97 (heroapi): Hero, HeroIntent (talk), RunController, claims, goesTo.
 * - 1.1: round 112: HeroIntent.input, Hero.tunables, Hero.ownCamera, Hero.dispose, Hero.mobility (contracts/traversal.ts), HeroAbility.duration, HeroWorld.solidAt /
 *   floorUnder, HeroModule / HeroHost / HeroEntry (the hero sandbox's registry).
 */
export const HERO_CONTRACT = '1.1';

/** What the player wants this frame (a controller's output). */
export interface HeroIntent {
  /** where to go: a world-space direction (x, y), length 0..1 (a stick's tilt) */
  move: V2;
  /** walk to this point on its own (a tap on the ground or a person) until it's there or `move` takes over */
  goTo?: V2 | null;
  /** the main ability this frame (a swing): held or tapped */
  attack?: boolean;
  /** (round 94) run: faster, for crossing open ground (the user: "the character is way too slow") */
  sprint?: boolean;
  /** other abilities, by id, used this frame */
  use?: string[];
  /** (round 97, heroapi) talk to whoever's near enough (the context button, E): talk as an intent the controller emits */
  talk?: boolean;
  /**
   * (1.1) A controller's own input for its own hero, passed through untouched (the hoverbike game's per-frame
   * Input: stick, gestures, drags, world taps). Opaque to the host: the sandbox's inspector shows that it's there
   * (and its keys), never reads it.
   */
  input?: unknown;
}

/** Something a hero can do (a swing, a hookshot, a dash, a spell). */
export interface HeroAbility {
  id: string;
  name: string;
  /** seconds until it can be used again (0: ready) */
  cooldown(): number;
  /** (1.1) its full cooldown, seconds (the inspector's bar; absent: unknown) */
  duration?: number;
}

/**
 * (1.1) A number of the hero's the player may tune live (the hero sandbox's tuning panel): a speed, a reach, a
 * cooldown. `get` reads it now; `set` takes a value already clamped to [min, max]. The sandbox turns these into a
 * tuning registry (src/tune/registry.ts) at the boundary: presets, export and the feedback note's values.
 */
export interface HeroTunable {
  label: string;
  /** cells/s, s, ×, … */
  units?: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  help?: string;
}

/** What the chase camera should do for this hero. */
export interface HeroCamera {
  /** screen px a world unit (the level's zoom) */
  zoom: number;
  /** radians either side of straight behind its heading the view may drift before it's drawn back (Orbit.prefer.dead) */
  behind: number;
  /** past this the pull is twice as firm (Orbit.prefer.firm) */
  firm?: number;
}

/** What a hero needs from the world: its ground, the units it fights and talks to. */
export interface HeroWorld {
  ground: { heightAt(x: number, y: number, opts?: { smooth?: boolean }): number | null };
  units: Units;
  /** water standing at (x, y) (cells): a hero on foot doesn't wade in over DEEP */
  water?: { depthAt(x: number, y: number): number | null };
  /** (1.1) is (x, y, z) inside the ground (a wall's face, a cave's roof): what rays and shells stop at */
  solidAt?(x: number, y: number, z: number): boolean;
  /** (1.1) the floor under feet that reach up to z: in a cave, under an overhang (null: none) */
  floorUnder?(x: number, y: number, z: number): number | null;
}

export interface Hero {
  /** its id as an actor (the units' targets, `hit` by) */
  readonly id: string;
  /** what kind of hero (the unit generator's role; RunRecord.hero) */
  readonly role: string;
  /** for the units: hostile ones notice, chase and hit it */
  readonly actor: Actor;
  readonly abilities: HeroAbility[];
  readonly camera: HeroCamera;
  position(): V3;
  /** radians, the way it faces (0: +x) */
  heading(): number;
  /** cells a second it's moving now (the chase camera draws round behind it only while it moves) */
  speed(): number;
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  /** each frame: the controller's intent */
  update(dt: number, intent: HeroIntent): void;
  /** put it down at (x, y) (a level's start, a warp) */
  place(at: V2): void;
  /** the window slid (streamed worlds) */
  shift(dx: number, dy: number, dz: number): void;
  readonly hurt: ((damage: number, by: string) => void)[];
  readonly died: (() => void)[];
  /**
   * (round 97, heroapi) Does the hero take this tap (CSS px) for its own mechanics — a lich floating what's
   * tapped, a mech's aim? Asked first: a claimed tap never walks the hero or opens a talk. Absent: never.
   */
  claims?(sx: number, sy: number): boolean;
  /** (round 97, heroapi) false: it doesn't walk itself to `intent.goTo` (a vehicle): a tap on someone far tells the player to go closer */
  readonly goesTo?: boolean;
  /** (1.1) its numbers to tune live, by key (a speed, a reach): the hero sandbox's tuning panel. Absent: none. */
  readonly tunables?: Record<string, HeroTunable>;
  /** (1.1) it drives the camera itself (the hoverbike's chase camera): the host neither follows nor zooms; `camera` is advisory */
  readonly ownCamera?: boolean;
  /**
   * (1.1) how it gets over the ground (contracts/traversal.ts Mobility: its step, drop, the water it won't wade, a
   * jump): a traversal field for it is reckoned by these — the sandbox's autopilot, a course's check that it can be
   * crossed (GE3). Absent: no field can be made for it (the autopilot says so).
   */
  readonly mobility?: Mobility;
  /** (1.1) it's done with (the sandbox's way back out, a run's end): what it draws and holds let go. Absent: nothing to let go. */
  dispose?(): void;
}

/** Turns the player's input into a HeroIntent each frame (touch: a stick and buttons; desktop: keys). */
export interface HeroController {
  intent(): HeroIntent;
  dispose(): void;
}

/**
 * (round 97, heroapi) A controller a run drives (HeroRunDeps.makeController): the hero game's own (the hoverbike
 * game's Controls) in place of the run's TouchPad. The run sets the hooks and calls the setters; each is optional.
 */
export interface RunController extends HeroController {
  /** a tap (CSS px) the hero didn't claim: the run's (a person: walk up and talk; the ground: walk there) */
  onTap?: ((sx: number, sy: number) => void) | null;
  /** the context button pressed (talk to whoever's near) */
  onAction?: (() => void) | null;
  /** what the context button says (null: hidden) */
  setAction?(label: string | null): void;
  setHealth?(health: number, max: number): void;
  /** hidden while a talk or the end card has the screen */
  hidden?: boolean;
}

// ---- (1.1, round 112) heroes from another build: the hero sandbox's registry (docs/HEROES.md) ----------------

/** A hero a game offers: made by role, with its own controller (and units) when it has them. */
export interface HeroEntry {
  /** its role (Hero.role): the registry's key */
  role: string;
  /** shown in the sandbox's hero list */
  name: string;
  /** an emoji for its button */
  icon?: string;
  makeHero(world: HeroWorld, at: V2): Hero;
  /** its own controller (absent: the host's TouchPad: a stick, ⚔, run, a context button) */
  makeController?(hero: Hero): RunController;
  /** its own units (absent: the host's, which the sandbox's spawn tool fills) */
  units?: Units;
}

/**
 * What a hero module gets from the host (1.1): named capabilities first, through Reclaimed's APIs; `raw` are the
 * handles a hero still needs that have no API yet (debt: each to be replaced by an API — docs/HEROES.md "What the
 * contract lacks").
 */
export interface HeroHost {
  /** the host's HERO_CONTRACT */
  readonly contract: string;
  /** the ground, the units, the water (what makeHero is given too) */
  readonly world: HeroWorld;
  /** the UI layer (a controller's buttons go here) */
  readonly ui: HTMLElement;
  /** a world point on the screen (CSS px) */
  project(x: number, y: number, z: number): [number, number];
  /** the ground seen under a screen point (CSS px): world x, y, z */
  groundAt(sx: number, sy: number): [number, number, number];
  /** the window's height in cells (rays, tap picking) */
  readonly zMax: number;
  /** wake the world round (x, y) for a while (a streamed world sleeps away from the camera) */
  wake(x: number, y: number, radius: number): void;
  /** a line into the sandbox's boundary log (and the feedback file) */
  log(line: string): void;
  /** debt: handles without an API yet (typed loosely on purpose: see docs/HEROES.md) */
  readonly raw: {
    /** the world API (src/api/world.ts Sim: terrain, water, fire, wind, fx, plants, agents) */
    sim: unknown;
    /** the world (src/scenes/world-core.ts WorldCore) */
    core: unknown;
    /** the camera (src/render/camera.ts Camera) */
    camera: unknown;
    /** the renderer (src/render/renderer.ts Renderer): a hero draws itself (addVoxels, addMesh) */
    renderer: unknown;
    device: GPUDevice;
  };
}

/** What `mount` hands back: the heroes the module offers. */
export interface HeroMount {
  heroes: HeroEntry[];
  dispose?(): void;
}

/**
 * A hero module, loaded at runtime (`?heroes=<url>`, or the sandbox's list): an ES module that exports these two.
 * Its imports of Reclaimed resolve through the page's import map (`reclaimed/<path>`, docs/HEROES.md) to the
 * host's own modules, so classes and constants are the host's by identity and nothing is copied.
 */
export interface HeroModule {
  /** the HERO_CONTRACT it was built against */
  heroContract: string;
  mount(host: HeroHost): HeroMount | Promise<HeroMount>;
}
