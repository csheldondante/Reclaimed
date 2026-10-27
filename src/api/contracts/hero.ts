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

import type { Actor, Units, V2, V3 } from './units';

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
}

/** Something a hero can do (a swing, a hookshot, a dash, a spell). */
export interface HeroAbility {
  id: string;
  name: string;
  /** seconds until it can be used again (0: ready) */
  cooldown(): number;
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
}

/** Turns the player's input into a HeroIntent each frame (touch: a stick and buttons; desktop: keys). */
export interface HeroController {
  intent(): HeroIntent;
  dispose(): void;
}
