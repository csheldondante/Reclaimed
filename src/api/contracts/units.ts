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
/** (U2 round 5) a group of units made or ordered together (spawnAt): a number, as inhabitants' groups */
import type { GroupId } from './inhabitants';

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
  /**
   * Where it stands: (round 128p, DA-B22 (c)(4)) read only for a unit observed (`Units.observe`) or a query's answer —
   * null otherwise: not read, never a stale value. The game reacts to events (arrived, hurt, died, noticed) and asks
   * where units are (`query`); it doesn't read every unit every frame (DESIGN §11).
   */
  at: V3 | null;
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

/**
 * (round 128p, U1) A unit with where it stands known: observed (`Units.observe`), a query's answer, or the place an
 * event told (a swing, a death).
 */
export type SeenUnit = UnitView & { at: V3 };

/** the view with where it stands, or null: gone, or its place not read (not observed, or observed since the last read) */
export function seen(v: UnitView | null): SeenUnit | null {
  const at = v?.at;
  return v && at ? { ...v, at } : null;
}

/** Something that isn't a unit but takes part (the hero): units notice it, chase it, hit it. */
export interface Actor {
  id: string;
  faction: FactionId | null;
  /** where it is now (null: not in play) */
  position(): V3 | null;
  alive(): boolean;
  /** a unit's blow landed (`by` where it struck from: the swing's event, or its observed place) */
  hurt(damage: number, by: SeenUnit): void;
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

/**
 * (U2 round 5, UNIT_MINDS_U2.md §9a) A place in a GPU town, by indices only — resolved on the GPU each frame through the
 * town contracts' place table (api/contracts/townplaces.ts; shaders/townplace.wgsl), never read back:
 * - `{ town, place }`: a named place (townplaces `PLACE.barracks`, `PLACE.muster`, `PLACE.gate0 + k` …)
 * - `{ town, district, kind, rank }`: the `rank`-th lot of a kind (townplace LOT_KIND — 1 a building, 2 a park, 3 a
 *   plaza, 4 a landmark, 5 a field) in district `district`, in the order the district fills in
 * `town` is the town's slot (TownContractsApi.townIndex).
 * (U2 round 5b, with Track A) `else`: a fallback, tried in order each time the order resolves (a settled choice holds
 * while it stays valid); `also`: a partner that must be valid with it (spawn point k also gate k). At most 3 deep
 * (the else chain); an `also` has neither. Deeper throws at the call. `orderFailed` only when the whole chain fails,
 * with the last ref's reason.
 */
export type PlaceRef = ({ town: number; place: number } | { town: number; district: number; kind: number; rank: number }) & { else?: PlaceRef; also?: PlaceRef };
/**
 * (U2 round 5) A group's order at a place: `go` walk there and stand; `guard` walk there and hold it (take on hostiles
 * in sight, back to it after); `attack` walk there hostile to anything on the way and there.
 */
export interface PlaceOrder {
  kind: 'guard' | 'go' | 'attack';
  at: PlaceRef;
}
/**
 * (U2 round 5) Why a group's order failed, from the place's status (townplaces PLACE_STATUS): 'none' no such place (no
 * card built, no lot there), 'rising' still being built, 'water' a gate over water, 'no-town' no live town in that slot;
 * or 'pool-full': no field free for another place at once (the order isn't sent); (round 6b) 'no-room': a drill's
 * yard has no ground for even one file.
 */
export type OrderFailure = 'none' | 'rising' | 'water' | 'no-town' | 'pool-full' | 'failed' | 'busy' | 'no-room';
/** (U2 round 6) a formation: a column (at most 3 abreast) or a line (at most 10), narrowing where the way does — (round
 *  6b) a chain of rows, each squeezing where the way narrows and dropping its outer soldiers into the rows behind past
 *  a threshold; or (round 6b) 'loose': no ranks, a crowd kept together (boids on the group's field — raiders' default) */
export type Formation = 'column' | 'line' | 'loose';
/** (round 6b) how drilled a formation looks: 1 (the default) every soldier on its slot; lower, each slot wanders
 *  smoothly round its place (up to orders.wgsl JITTER_AMP at 0), never off free ground. Looks only: the order logic is
 *  the same, the arrival a little more tolerant */
export interface Drill {
  discipline?: number;
}
/**
 * (U2 round 6, UNIT_MINDS_U2 §9c/§9d) A group's order. Every one resolved on the GPU from indices:
 * - go / guard / attack at a place (round 5), optionally in formation (its anchor walks the group's field; the width
 *   from the clearance left and right of it);
 * - `drill`: an anchor loops round the yard (a place), the soldiers holding their slots round it;
 * - `man`: the town's wall-walks manned, a post each at spacing along each run's top (routeread's wall table; `side`:
 *   one run, its index in the table), single file up the stairs;
 * - `march`: along gate slot `gate`'s route out of the town (gateRoute), the column narrowing to the route's width;
 *   an invalid gate fails with its status; `leave`: past the window's edge the units drop out and `left(g)` is told
 *   once. Back is a second order.
 * `orderFailed` reasons beyond a place's: 'failed' (the gate's route couldn't be traced), 'busy' (another town's routes
 * are in use: one town's man and march at a time).
 */
export type SquadOrder =
  | (PlaceOrder & { formation?: Formation } & Drill)
  | ({ kind: 'drill'; at: PlaceRef; formation: Formation } & Drill)
  | { kind: 'man'; town: number; side?: number }
  | ({ kind: 'march'; town: number; gate: number; leave?: boolean } & Drill);

/**
 * (U2 round 6, Track A's ask) What a spawn by place carries per unit: its sight (cells), its health (the contract's), its
 * damage (a blow at an actor: the hero — a unit's blows at units are its kind's, on the GPU). `speed` picks the kind's
 * pace class only (under 2.2: the slow kind): a pace is the kind's on the GPU (soldier 3.2, raider 3.4).
 */
export interface SpawnAtOpts {
  sight?: number;
  speed?: number;
  health?: number;
  damage?: number;
}

/** The units system as a game uses it. */
export interface Units {
  spawn(kind: string, at: V2, faction: FactionId | null, opts?: SpawnOpts): UnitId;
  get(id: UnitId): UnitView | null;
  /**
   * the units within `radius` of `near` (living ones unless `dead`), nearest first, with where they stand as the query
   * found them (round 128p: asked of the GPU — an answer a frame or two later)
   */
  query(near: V2, radius: number, opts?: { faction?: FactionId | null; hostile?: boolean; dead?: boolean }): Promise<SeenUnit[]>;
  /**
   * (round 128p, DA-B22 (c)(4)) Keep these units' positions read each frame (`get(id).at`) until the returned release
   * is called; counted — each observer releases its own. For the few the game follows: the selected, a held one, a
   * fleeing one. Everything else is events and queries.
   */
  observe(ids: UnitId | readonly UnitId[]): () => void;
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
  /**
   * (U2 round 5 — optional; AgentUnits implements it once the town contracts are in) `n` units of `kind` made at a town
   * place: at its approach point, spread round it, placed on the GPU. They stand there until ordered. The place not
   * valid: none is made, and `orderFailed(g, why)` is told.
   */
  spawnAt?(kind: string, faction: FactionId | null, at: PlaceRef, n: number, opts?: SpawnAtOpts): GroupId;
  /** (U2 round 5) a group's order (it replaces the last): `arrived(g)` once when every living member stands there */
  orderGroup?(g: GroupId, o: SquadOrder): void;
  /** (U2 round 5) a group's living members */
  members?(g: GroupId): UnitId[];
  /** (U2 round 5) every living member of the group stands at its order's place: once an order */
  readonly arrived?: ((g: GroupId) => void)[];
  /** (U2 round 5) the group's order (or its spawn) failed: the place isn't valid, or no field was free */
  readonly orderFailed?: ((g: GroupId, why: OrderFailure) => void)[];
  /** (U2 round 6) a march that leaves: its last living member left the window */
  readonly left?: ((g: GroupId) => void)[];
}
