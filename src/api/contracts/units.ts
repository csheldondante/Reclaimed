// Units — people and creatures in play (round 88, docs/SYSTEMS.md system 6). The contract every game codes
// against: the story's cast stand as units, a settlement's workers and a camp's raiders are units, the hero
// fights them. Small and general on purpose: a position, a faction, health, a hostile flag, a job and a role
// (the unit generator's: "smith", "walking dead"). How they walk (a CPU steer, the GPU agents' shared fields)
// is the implementation's business.
// - Implementations: src/units/simple.ts `SimpleUnits` (CPU, a few dozen units, steering over the world API's
//   ground) for now; the `settlements` branch's GPU agents (src/agents) to implement it next.
// - Coordinates: the level's window (x in cells, y in world units, z the ground), as the world API's.
// - Actors: things that aren't units but take part (the hero): hostile units notice and attack them, and
//   their hits come back through `Actor.hurt`. The hero is the first one.
//
//   const units = new SimpleUnits(sim.terrain)
//   const id = units.spawn('walking dead', [x, y], 'f-hollow-court', { hostile: true, health: 3 })
//   units.watch(hero.actor)                        // hostile units notice it within their sight, chase, swing
//   units.hit(id, 1, 'hero')                       // the hero's swing → `hit`, `died` events
//   units.died.push((u, by) => run.note({ kind: 'killed', character: u.character, unitKind: u.role }))
//   each frame: units.update(dt)

import type { FactionId } from './world';

export type UnitId = number;
export type V2 = [number, number];
export type V3 = [number, number, number];

/** What a unit is doing. Hostile units with nothing ordered `guard` where they stand and attack what comes near. */
export type UnitJob =
  | { kind: 'idle' }
  /** stand at a point (go back to it after a chase) */
  | { kind: 'guard'; at: V2; radius?: number }
  | { kind: 'go'; to: V2 }
  | { kind: 'patrol'; around: V2; radius: number }
  /** a unit (its id) or an actor (its id, a string) */
  | { kind: 'attack'; target: UnitId | string }
  | { kind: 'follow'; target: UnitId | string; distance?: number }
  | { kind: 'flee'; from: V2 }
  /** work at a place: dig, build, haul, fell, farm … (the implementation says which it does; others idle there) */
  | { kind: 'work'; at: V2; what: string };

export interface SpawnOpts {
  /** a shown name (a cast member's) */
  name?: string;
  /** the story's cast member it stands for (story.ts StoryCharacter id): `killed { character }` names it */
  character?: string;
  /** the settlement it belongs to (settlement.ts) */
  settlement?: string;
  /** the unit generator's role (default: the kind) */
  role?: string;
  /** attacks actors and units of other factions that come within `sight` (default false) */
  hostile?: boolean;
  /** hit points (default 3) */
  health?: number;
  /** cells it notices a target within (default 10) */
  sight?: number;
  /** cells a second (default 3) */
  speed?: number;
  /** what one of its blows takes off (default 1) */
  damage?: number;
  /** a colour for its figure and name ('#rrggbb'; default by faction) */
  colour?: string;
  /** what it does first (default: guard where it's put) */
  job?: UnitJob;
}

/** A unit as it is now (a copy: changing it changes nothing). */
export interface UnitView {
  id: UnitId;
  kind: string;
  role: string;
  name?: string;
  character?: string;
  settlement?: string;
  faction: FactionId | null;
  at: V3;
  /** radians, the way it faces (0: +x) */
  heading: number;
  health: number;
  maxHealth: number;
  hostile: boolean;
  alive: boolean;
  job: UnitJob;
  /** 'idle' | 'walk' | 'chase' | 'swing' | 'hurt' | 'dead': what a figure shows */
  state: 'idle' | 'walk' | 'chase' | 'swing' | 'hurt' | 'dead';
  colour: string;
}

/** Something that isn't a unit but takes part (the hero): units notice it, chase it, hit it. */
export interface Actor {
  id: string;
  faction: FactionId | null;
  /** where it is now (null: not in play) */
  position(): V3 | null;
  alive(): boolean;
  /** a unit's blow landed */
  hurt(damage: number, by: UnitView): void;
}

/**
 * (round 117, play) A blow over an area, as the play layer's heroes deal them: a bike's ram and slash, a lich's
 * force push and slam. Beyond `hit`'s damage it shoves (cells/s, the implementation divides by a unit's mass) and
 * throws (lift). Coordinates as the rest (window x, y; z the height of its centre, absent: any height).
 */
export interface AreaHit {
  at: V2;
  z?: number;
  radius: number;
  damage: number;
  /** a shove: along `dir`, or out from `at` without one */
  push?: number;
  dir?: V2;
  /** an upward throw on top of the shove (cells/s) */
  lift?: number;
  /** only within this angle (radians either side) of `axis` (default `dir`) */
  cone?: number;
  axis?: V2;
  /** seconds a unit it throws stays down */
  stun?: number;
  fire?: boolean;
}

/** The units system as a game uses it. */
export interface Units {
  spawn(kind: string, at: V2, faction: FactionId | null, opts?: SpawnOpts): UnitId;
  get(id: UnitId): UnitView | null;
  /** the units within `radius` of `near` (living ones unless `dead`), nearest first */
  query(near: V2, radius: number, opts?: { faction?: FactionId | null; hostile?: boolean; dead?: boolean }): UnitView[];
  /** (round 97, heroapi) every unit, living and dead (a run picks what's under a tap, draws figures) */
  all?(): readonly UnitView[];
  /** every unit standing for this story character */
  byCharacter(character: string): UnitView | null;
  /** give a unit (or several) a job */
  order(who: UnitId | UnitId[], job: UnitJob): void;
  /** turn a unit hostile or peaceful (a talk gone wrong) */
  setHostile(id: UnitId, hostile: boolean): void;
  /** a blow: `by` a unit, an actor's id, or null (the world: a fall, fire) */
  hit(id: UnitId, damage: number, by: UnitId | string | null): void;
  remove(id: UnitId): void;
  /**
   * (round 117, play — optional; main to consolidate) a blow over an area with a shove and a throw (AreaHit); `died`
   * and `hurt` name `by` as `hit` does. The play layer's heroes need it (src/play); AgentUnits implements it.
   */
  strike?(h: AreaHit, by: UnitId | string | null): void;
  /**
   * (round 117, play — optional) hold a unit with its feet at `at` (telekinesis: a lich floating it), each frame
   * while held; false: it's gone or can't be held. At most `maxHeld` at once.
   */
  hold?(id: UnitId, at: V3): boolean;
  /** (round 117, play — optional) let a held unit go (or throw any unit) at `vel` (cells/s); it tumbles and gets up */
  release?(id: UnitId, vel?: V3): void;
  /** (round 117, play) how many units `hold` keeps at once */
  readonly maxHeld?: number;
  /** actors hostile units may attack */
  watch(actor: Actor): void;
  /** the window slid (streamed worlds): positions shift with it */
  shift(dx: number, dy: number, dz: number): void;
  /** each frame */
  update(dt: number): void;
  readonly died: ((u: UnitView, by: UnitId | string | null) => void)[];
  readonly hurt: ((u: UnitView, damage: number, by: UnitId | string | null) => void)[];
  /** a hostile unit noticed a target (a unit's id or an actor's) */
  readonly noticed: ((u: UnitView, target: UnitId | string) => void)[];
}
