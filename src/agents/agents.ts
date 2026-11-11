// Agents (round 52, docs/AGENTS.md): units that walk the world's surfaces by
// following shared fields, and fight. The GPU does the walking and the
// behaviour (agents.wgsl: the surfaces peeled from the intervals, a distance
// field per goal relaxed a few sweeps a tick; units.wgsl: every unit's tick
// and its voxels). This side defines kinds, places units, says which field
// each group follows and where its seeds and the targets are, sends the
// game's hits, and reads units and events back.

import { Translator } from '../sim/translate';
import { makeBindGroup, makeCompute, ignoreTeardown, whenPipelinesReady, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import agentsWgsl from '../shaders/agents.wgsl?raw';
import waterclassWgsl from '../shaders/waterclass.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import unitsWgsl from '../shaders/units.wgsl?raw';
import townplaceWgsl from '../shaders/townplace.wgsl?raw';
import ordersWgsl from '../shaders/orders.wgsl?raw';
import routereadWgsl from '../shaders/routeread.wgsl?raw';
import fieldseamWgsl from '../shaders/fieldseam.wgsl?raw';
import { PagePool, PP_HEADER } from '../gpu/pagepool';
import { showFatal, showWarning } from '../gpu/device';
import type { SimSystem } from '../sim/system';
import { TICK_DT } from '../sim/flow';
import { stepPlan } from './stepplan';
import { UnitNotice } from './notice';
import { UnitPick, type PickAsk } from './pick';
import { UnitReads, type UnitFound } from './reads';
import type { WorldGpu } from '../sim/world-gpu';
import { MAT } from '../world/materials';
import { materialId, materialName, materialState, type MaterialName } from '../api/common';
import type { Terrain } from '../api/terrain';
import { FieldReader } from './fieldreader';
import { AgentScope } from './scope';
import { RoadStamp } from './roads';
import { RoadRide } from './ride';
import type { RoadGraph } from './roadgraph';
import { CHUNK_CLASS, CHUNK_COLUMNS, CHUNK_DEPTH, CUSTOM, ChangedTiles, TILES_BINDING, cullKernel } from '../sim/cull';
import { ROW_H } from '../world/lattice';
import { TUNE, worldG } from '../tune/params';
import { urlFlags } from '../flags';

/** (round 104, simscale) the fields kept only round what the agents do and relaxed only where something changed
 *  (agents/scope.ts); ?agentscope=0: the whole window every tick, as before */
const SCOPE = typeof location === 'undefined' || urlFlags().get('agentscope') !== '0';
/** the scope's tile lists (sim/cull.ts CUSTOM): its chunks, and those new to it this tick */
const SCOPE_LIST = CUSTOM + 10;
const ENTER_LIST = CUSTOM + 11;
/** chunks marked changed by the CPU this tick (a seed placed or moved) */
const MARK_LIST = CUSTOM + 12;
/** (round 107, agentspike) ?agentprof=1: the agents' tick in one timed pass a stage (agents-in, -peel, -relax, -units),
 *  and a log a tick (window.__agentLog: the scope, what came in, the marks, the peel, each sweep's front) */
const PROF = typeof location !== 'undefined' && urlFlags().get('agentprof') === '1';
/** (FC12) the front relaxed a page at a time in workgroup memory, RELAX_K passes a sweep (fieldseam.wgsl fieldRelax);
 *  ?relaxk=N the passes */
const RELAX_K = Math.max(1, Math.round(Number((typeof location !== 'undefined' && urlFlags().get('relaxk')) || 16)));
/** (FC12 variant) ?jfa=1: the hunt field started each frame its seeds change cell from an obstacle JFA, a targets JFA
 *  and a line check on the clearance (units.wgsl jfa*); ?jfalos=bisect the line check by halves (default: traced) */
const JFA_MODE = Number((typeof location !== 'undefined' && urlFlags().get('jfa')) || 0);
const JFA = JFA_MODE >= 1;
/** (?jfa=2) the iterated rounds after the first (?jfar=R, default 2) */
const JFA_ROUNDS = JFA_MODE >= 2 ? Math.max(1, Math.round(Number((typeof location !== 'undefined' && urlFlags().get('jfar')) || 2))) : 0;
const JFA_LOS_BISECT = typeof location !== 'undefined' && urlFlags().get('jfalos') === 'bisect';
export interface AgentTickLog {
  frame: number;
  tick: number;
  scope: number;
  enter: number;
  marks: number;
  /** chunks peeled (0: none; the GPU's list — round 128o, DA-B26 — filled in when read back) */
  peel: number;
  units: number;
  fields: number;
  /** each sweep's front (pages relaxed: (field, chunk)s), filled in when read back */
  front: number[];
  /** the frame's seeds new and gone; the pool's pages in use and refused (filled in when read back) */
  seedsNew?: number;
  seedsGone?: number;
  pagesUsed?: number;
  pagesRefused?: number;
  /** (?jfa=1/2) the targets JFA ran this tick, the obstacles JFA ran; columns resolved by each round; scope's ground */
  jfaRuns?: number;
  obsRuns?: number;
  resolved?: number[];
  ground?: number;
}

/** ticks between reads of the units' box and of what moved */
const READ_EVERY = 8;

/** surfaces a column (agents.wgsl NAV_K) */
export const NAV_K = 4;
/** unit slots (units.wgsl MAX_SLOTS: an id is generation × MAX_UNITS + slot) */
export const MAX_UNITS = 8192;
/** (U2 round 7) the fields: rows of the page pool's table (field ids, Agents.newField), sized from memory like the pool:
 *  the table, its stamps and bits cost ~8.4 B a row a window chunk — FIELD_TABLE_BYTES of them (?fieldrows=N). Rows
 *  run out only when that memory does: newField returns null (orders fail 'pool-full', shown) */
const FIELD_TABLE_BYTES = 4 << 20;
const FIELD_ROWS_FLAG = Number((typeof location !== 'undefined' && urlFlags().get('fieldrows')) || 0);
/** ids below this are callers' own (the fixed fields of AgentUnits, the crews, the levels: 0-15); newField hands out
 *  the rest */
export const FIELD_OWN = 16;
/** (U2 round 7) a field page: 16 x 16 columns x NAV_K distances, then as many seed-ids (fieldseam.wgsl FP_W) */
const FIELD_PAGE_W = 256 * 4;
/** the pool's pages: ?fieldpages=N, else as many as FIELD_POOL_BYTES holds. (U2-FIELDCAP) Sized from memory as a
 *  whole, not per window chunk: the fields overlap where the armies are, so a small window held too few for many
 *  destinations at once (6 a chunk: 216 pages at 96 x 96, refused at 20 fields). The budget is round 7's at 320 x 320
 *  (2400 pages, 6 a chunk) — what a phone carries today; a field reaching the whole 320 window holds 400 */
const FIELD_POOL_BYTES = 20 * 1024 * 1024;
const FIELD_PAGES = Number((typeof location !== 'undefined' && urlFlags().get('fieldpages')) || 0);
/** a field with none (fieldseam.wgsl FIELD_NONE) */
const FIELD_NONE = 0xffffffff;
/** a field's record words (fieldseam.wgsl): place, arrival radius, leaving radius, reach, flags */
const FIELD_REC_W = 8;
const FO_ROAD = 1;
/** a field record's words */
const FR_PLACE = 0;
const FR_REACH = 3;
const FR_FLAGS = 4;
/** (fieldseam.wgsl seedList) a frame's seeds at most: a hunt seed a unit, the CPU's, an order group's place and runs */
const SEED_LIST = MAX_UNITS + 4096;
/** fieldseam.wgsl SEED_HEAD: the counts, the hunt's and the foes' fields, then per side its hunt and threat fields */
const SEED_HEAD = 16 + 2 * 256;
const SEED_SIDES = 16;
/** (FC12 stage 2) units.wgsl mail: the head, the aim (12 words a slot), the hits landing (2 a slot), the arrows (12 each) */
const MAIL_ARROWS = 2048;
/** (U2 round 5; round 7) orders.wgsl: the order groups — their records and rank tables in `mail`, sized from memory
 *  (ORDER_MAIL_BYTES, ?ordergroups=N): spawnAt and orderGroup fail 'pool-full' only past that. Their members are drawn
 *  in agents groups ORDER_GROUP_BASE + g % ORDER_COLOURS (the colour only: membership is mail's aim word 11) */
const ORDER_MAIL_BYTES = 1 << 20;
const ORDER_GROUPS_FLAG = Number((typeof location !== 'undefined' && urlFlags().get('ordergroups')) || 0);
export const ORDER_GROUP_BASE = 16;
export const ORDER_COLOURS = 8;
/** the agents group order group g's members are drawn in */
export const orderColourGroup = (g: number): number => ORDER_GROUP_BASE + (g % ORDER_COLOURS);
/** orders.wgsl ALTS, REF_W, REF_AT, GROUP_W */
export const ORDER_ALTS = 3;
const REF_W = 6;
const REF_AT = 20;
/** (round 6) units.wgsl FORM_AT, TRAIL_AT, RUNS_AT, GROUP_W, the rank table */
const FORM_AT = REF_AT + ORDER_ALTS * 2 * REF_W;
const TRAIL_AT = FORM_AT + 16;
const RUNS_AT = TRAIL_AT + 32 * 4;
const GROUP_W = RUNS_AT + 8 * 8 + 8 + 8;
/** (U2 round 7) the man order's run fields, a word each (units.wgsl RUNF_AT: the record's last 8 words) */
const RUNF_AT = RUNS_AT + 8 * 8;
/** ranks a group (units.wgsl RANKS): the most a formation places */
export const ORDER_RANKS = 64;
const RANK_W = 9;
/** the joins a step at most: one a unit slot (units.wgsl ORDER_Q) */
const ORDER_Q = MAX_UNITS;
const SPAWN_BIT = 0x80000000;
const MAIL_GRP = 16 + 8192 * 12 + 8192 * 2 + MAIL_ARROWS * 12;
/** mail's layout past the arrows, for `groups` order groups */
const mailLayoutFor = (groups: number) => {
  const q = MAIL_GRP + groups * GROUP_W;
  const ranks = q + 1 + ORDER_Q * 3;
  return { q, ranks, words: ranks + groups * ORDER_RANKS * RANK_W };
};
/** (round 6, tests and the lab: readRaw('mail')) where the order groups' records and the rank table lie (words) */

/** mail's aim words a slot (units.wgsl AIM_W): word 11 its order group + 1 */
const AIM_W = 12;
/** (U2 round 5) a town place by indices (orders.wgsl's ref): a named place (townplace PLACE_*) or a lot (district, lot
 *  kind, rank) */
export interface OrderPlace {
  town: number;
  place: { name: number } | { district: number; lotKind: number; rank: number };
}
/** (U2 round 5) an order group's record as the CPU writes it (orders.wgsl group words): indices only */
export interface OrderRecord {
  /** 0 none (let go), 1 stand (no walk: a spawn not yet ordered), 2 go, 3 guard, 4 attack, (round 6) 5 drill, 6 man,
   *  7 march */
  kind: number;
  /** (U2 round 5b) the places in order of preference (1..ORDER_ALTS: PlaceRef's `else` chain), each with an optional
   *  partner that must be valid with it (`also`); none for man and march (their routes are the town's) */
  alts: { at: OrderPlace; also?: OrderPlace }[];
  /** the field it walks (none: −1) */
  field: number;
  /** (round 6) a formation: 0 none, 1 column, 2 line; its spacing (cells) */
  formation?: number;
  spacing?: number;
  /** (round 6) march: the gate slot; man: the wall run (undefined: every run) */
  gate?: number;
  /** (round 6) march: past the window's edge the units drop out (EV_LEFT) */
  leave?: boolean;
  /** (round 6) man: a field per wall run (run i the (i mod n)-th) — `field` is ignored */
  runFields?: number[];
}
/** units.wgsl BY_UNIT: a hurt's or a death's `hit` / `by` with this bit is a unit's id (its arrow) */
export const BY_UNIT = 0x40000000;
/** (FC12 stage 2) ?los=1: line of sight on at the start (melee straight at a target in sight; ranged kinds shoot);
 *  ?seenonly=1 seen-only targets. The field bench builds what they need and toggles them (Agents.los) */
// (U2 round 5: line of sight and seen-only targets on by default — the user's ruling after the FC12 bench; ?los=0 and
// ?seenonly=0 turn them off for the benches. The kernels are always built: melee's aim (DA-B32) reads aimTick's words)
const LOS_FLAG = !(typeof location !== 'undefined' && urlFlags().get('los') === '0');
const SEEN_FLAG = !(typeof location !== 'undefined' && urlFlags().get('seenonly') === '0');
const LOS_BUILT = true;/** (round 128o, DA-A6) units.wgsl RIDE_ARRIVED: an arrival event's `other` at or over it is a ride's (minus it: the group) */
const RIDE_ARRIVED = 256;
/** (round 128l, m4; U2 round 7: 256 — a unit word's 8 bits, units.wgsl unitInfo) agents groups: what a unit follows
 *  and is drawn in when it isn't in an order group */
export const MAX_GROUPS = 256;
export const MAX_KINDS = 8;
const MAX_SEEDS = 48;
const MAX_HITS = 32;
const MAX_TARGETS = 8;
const MAX_HOLDS = 8;
const MAX_LAUNCHES = 32;
const EVENT_CAP = 2048;
/** (round 128o, DA-B2) the most events one sync reads (the rest wait for the next) */
const EVENT_WINDOW = 256;
/** (round 128p) the fewest events a sync reads (its window grows with what comes: Agents.sync) */
const EVENT_MIN = 16;
/** (round 128p) the hunt's candidates a sync reads (notice.wgsl huntTop: 8 × vec4) */
const HUNT_BYTES = 8 * 16;
/** voxels drawn in all (units.wgsl MAX_INST), and in all the kinds' models */
const MAX_INST = 65536;
const MAX_MODEL_VOXELS = 8192;
/** ticks between re-peeling the surfaces over the whole window (?agentscope=0 only: in the scope, round 128o DA-B26,
 *  the chunks whose columns or water changed are re-peeled, listed on the GPU — sim/cull.ts ChangedTiles) */
const PEEL_EVERY = 8;
/** the params uniform (agents.wgsl AgentParams), in u32s */
const P_SEEDS = 4;
const P_GFIELD = P_SEEDS + MAX_SEEDS * 4;
const P_GMAT = P_GFIELD + MAX_GROUPS;
const P_N2 = P_GMAT + MAX_GROUPS;
const P_KINDS = P_N2 + 4;
const P_HITS = P_KINDS + MAX_KINDS * 12;
const P_TARGETS = P_HITS + MAX_HITS * 16;
const P_N3 = P_TARGETS + MAX_TARGETS * 4;
const P_HOLDS = P_N3 + 4;
const P_LAUNCHES = P_HOLDS + MAX_HOLDS * 4;
const P_TARGET_H = P_LAUNCHES + MAX_LAUNCHES * 4;
/** units moved to another group a tick (agents.wgsl regroups) */
const MAX_REGROUPS = 64;
const P_REGROUPS = P_TARGET_H + MAX_TARGETS;
/** (round 128o, DA-B22) the step's dt (agents.wgsl AgentParams.step) */
const P_STEP = P_REGROUPS + MAX_REGROUPS;
/** (round 128p) units made another kind a step (agents.wgsl rekinds) */
const MAX_REKINDS = 8;
const P_REKINDS = P_STEP + 4;
const P_U2 = P_REKINDS + MAX_REKINDS * 4;
const PARAMS_BYTES = (P_U2 + 4) * 4;
/** the most a unit may move in a step (cells): the occupancy, the floor it rides and its links are per cell, so a
 *  step past half a cell could skip a column's checks — the units' step's stride is bound by it (stepPlan) */
const STEP_CELLS = 0.5;

/** what the tumbling units fall by (units.wgsl unitsG(), cells/s²): the world's gravity × the tuning's units.gravity
 *  (solver step 1, AR9: it was a 20 of its own; the default scale keeps that at world gravity × 1) */
export function unitsG(): number {
  return worldG() * TUNE.units.gravity;
}
/** bytes of a surface (agents.wgsl nav: vec4<u32>), and of a unit (UNIT_V vec4: units.wgsl; the fifth, LW1, the trait
 *  system's caps and look and the max hp) */
const NAV_BYTES = 16;
export const UNIT_V = 6;
const UNIT_BYTES = UNIT_V * 16;
/** floats a unit */
const UF = UNIT_V * 4;
/** each group's torso colour (the default figure), by material */
const GROUP_MATS = [MAT.Rust, MAT.Brick, MAT.Steel, MAT.Wood, MAT.Concrete, MAT.Grass, MAT.Basalt, MAT.Sand];
const STATES = ['wander', 'chase', 'swing', 'tumble', 'held'] as const;
export type AgentStateName = (typeof STATES)[number];

export interface Seed {
  x: number;
  y: number;
  /** height (world cells): which surface of the column; default the top */
  z?: number;
}

/** A kind of unit. A worker (notice 0) always follows its group's field; a hostile kind wanders until its field says a target is near. */
export interface KindSpec {
  name: string;
  /** cells tall (also how deep water drowns it), its mass (pushes divide by it), its hit points, walking speed (cells/s) */
  height: number;
  mass: number;
  hp: number;
  speed: number;
  /** how near (cells, to a target's edge) it swings, the damage a swing does, seconds between swings */
  reach?: number;
  damage?: number;
  swingPeriod?: number;
  /** how far along its field it notices a target (0: a worker) */
  notice?: number;
  /** (FC12 stage 2) a ranged kind: how far it shoots (cells; 0 melee). In range and in sight it stands and shoots
   *  (units.wgsl fire, the REPLACE placeholder), backing off inside 0.4 of it; out of sight it follows its field */
  range?: number;
  /** the default figure's materials (MAT ids); torso default: its group's colour */
  colours?: { legs?: number; head?: number; torso?: number };
  /** its own look: voxels [x, y, z, material] in voxel units round its feet (z from 0 up), `voxel` cells each */
  model?: { voxels: readonly (readonly [number, number, number, number])[]; voxel: number };
}

export interface HitSpec {
  /** (round 128p) one unit only (its id), wherever it stands: x, y, z and radius aren't looked at */
  unit?: number;
  x: number;
  y: number;
  /** height of its centre; default any height */
  z?: number;
  radius: number;
  damage?: number;
  /** a push (cells/s, divided by the unit's mass): along `dir`, or outward from the centre */
  push?: number;
  dir?: readonly [number, number];
  outward?: boolean;
  /** a cone instead of a circle: its full angle (degrees) round `axis` (default `dir`) */
  cone?: number;
  axis?: readonly [number, number];
  /** an upward speed (cells/s, divided by the unit's mass) on top of the push: it throws them (without it, a push past 5 cells/s after the mass hops them by a third of it) */
  lift?: number;
  /** seconds they stay down once settled, beyond the usual 0.6 s getting up; a hit that doesn't throw them holds them where they stand (up to 20) */
  stun?: number;
  /** sets them alight */
  fire?: boolean;
  /** only these groups' units feel it (round 63: a lich's fireball spares its raised dead) */
  groups?: readonly number[];
  /** these groups' units don't feel it */
  spare?: readonly number[];
}

/** A throw's options: `stun`, seconds it stays down once settled, beyond the usual getting up (up to 20). */
export interface LaunchOpts {
  stun?: number;
}

const MAX_STUN = 20;

export interface Target {
  x: number;
  y: number;
  z: number;
  /** its size: reach counts to its edge */
  radius?: number;
  /** how tall it stands from z (its feet), cells (default 1.5): reach counts to the nearest point of it */
  height?: number;
}

export type AgentEvent =
  /** a swing begins: the blow lands on `target` in `lands` seconds, if it's still in reach (a parry's window) */
  | { type: 'windup'; id: number; target: number; lands: number; x: number; y: number; z: number }
  | { type: 'swing'; id: number; target: number; damage: number; x: number; y: number; z: number }
  /** (round 128p, DA-B22 (c)(3)) a hunter took a new target (a target code: agents/notice.ts — unit id + 1, ACTOR | i) */
  | { type: 'noticed'; id: number; target: number; x: number; y: number; z: number }
  /** (round 128p, DA-B22 (c)(4)) it came to another side of the wall (the side map's number: notice.setSides) */
  | { type: 'side'; id: number; side: number; x: number; y: number; z: number }
  | { type: 'hurt'; id: number; hit: number | 'impact'; damage: number; x: number; y: number; z: number }
  | { type: 'death'; id: number; by: number | 'fire' | 'water' | 'impact' | 'lava' | 'effect'; x: number; y: number; z: number }
  /** (LW1, corpse mode) a corpse raised by an effect (`by`, its id) into `group`: the same id, alive again */
  | { type: 'raised'; id: number; by: number; group: number; x: number; y: number; z: number }
  /**
   * (round 128o, DA-B2a) it came within its field's arrival radius (`arrivals`): once, until it leaves the field's
   * leaving radius or follows another field. `dist` the field's distance at its feet then.
   */
  | { type: 'arrived'; id: number; field: number; dist: number; x: number; y: number; z: number; ride?: undefined }
  /**
   * (round 128o, DA-A6) it stands at its group's ride's goal (`ride`: the group; the ride's steer STAND): once, until it
   * leaves it (rides on, walks a field, another group's ride)
   */
  | { type: 'arrived'; id: number; ride: number; x: number; y: number; z: number; field?: undefined; dist?: undefined }
  /** (LW1, corpse mode) a corpse gone to dust: its slot is free */
  | { type: 'decayed'; id: number; x: number; y: number; z: number }
  /** (U2 round 5, orders.wgsl) every living member of order group `group` stands at its place: once an order (`serial`) */
  | { type: 'groupArrived'; group: number; serial: number; n: number; x: number; y: number; z: number; id?: undefined }
  /** (U2 round 5) order group `group`'s place isn't valid (`status`: townplace PLACE_*): once an order (`serial`) */
  | { type: 'orderFailed'; group: number; status: number; spawn: boolean; serial: number; x: number; y: number; z: number; id?: undefined }
  /** (U2 round 6) order group `group`'s spawn (its serial) made: its place resolved, its units placed */
  | { type: 'spawned'; group: number; serial: number; x: number; y: number; z: number; id?: undefined }
  /** (U2 round 6) it left the window on order group `group`'s march (leave): its slot is free, no death */
  | { type: 'left'; id: number; group: number; x: number; y: number; z: number }
  | { type: 'alight'; id: number; by: number | 'fire'; x: number; y: number; z: number }
  /** a thrown (or dropped) item came down: `amount` of it is ground there now (0: the column had no room) */
  | { type: 'landed'; item: number; material: MaterialName; amount: number; x: number; y: number; z: number };

/** What a unit carries: an amount (cellsÂ³) of a material, ground taken up or to be put down. */
export interface Item {
  material: MaterialName;
  amount: number;
}

/** units.wgsl MAX_FLY: items in flight at once */
const MAX_FLY = 128;

interface Flight {
  id: number;
  mat: number;
  amount: number;
  pos: [number, number, number];
  vel: [number, number, number];
  spin: number;
  hit?: ThrowHit;
}

/** What a thrown item does to the units where it lands (agents.hit). */
export interface ThrowHit {
  radius?: number;
  damage?: number;
  push?: number;
  lift?: number;
  stun?: number;
  /** only these groups feel it, or these are spared (HitSpec) */
  groups?: readonly number[];
  spare?: readonly number[];
}

/** (round 128p, DA-B22 (c)(4)) one of the hunt's nearest candidates (notice.wgsl huntTop): its id and where it stands */
export interface HuntCandidate {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface AgentState {
  id: number;
  x: number;
  y: number;
  z: number;
  /** facing (radians, from +x) */
  heading: number;
  /** its velocity (cells/s): walking, flying when tumbling, the hand's when held */
  vx: number;
  vy: number;
  vz: number;
  state: AgentStateName;
  alight: boolean;
  hp: number;
  kind: string;
  group: number;
  /** (round 128p, DA-B22 (c)(3)) its target code (agents/notice.ts: 0 none, a unit's id + 1, ACTOR | an actor's index) */
  target: number;
  /** (round 128p) how near the nearest hostile hunting it is (Infinity: none) — the hunt's candidates */
  hunted: number;
}

const DEFAULT_KINDS: KindSpec[] = [
  { name: 'worker', height: 1.0, mass: 1, hp: 10, speed: 2.4 },
  { name: 'raider', height: 1.2, mass: 1, hp: 10, speed: 3.2, reach: 1.2, damage: 2, swingPeriod: 1.0, notice: 30 },
  { name: 'ogre', height: 2, mass: 3, hp: 22, speed: 1.8, reach: 1.8, damage: 5, swingPeriod: 1.6, notice: 25 },
];

/**
 * (LW1) A stage run with the units each tick, after their step and before their draw (the trait system: its core and
 * the game's modules). It encodes into the agents' own compute pass.
 */
export interface AgentStage {
  encode(pass: GPUComputePassEncoder): void;
}

export class Agents implements SimSystem {
  readonly name = 'agents';
  readonly period = 1;
  /** per surface: height, headroom, wet, links, room, region (agents.wgsl) */
  readonly nav: GPUBuffer;
  /** (round 107) per surface: the height and wet the fields reckon its cost by (agents.wgsl navCost) */
  private navCost: GPUBuffer;
  /** (fortress milestone 3, FT-46) per window column a bit: a road (agents.wgsl roads) — setRoads */
  private roads: GPUBuffer;
  /** (round 128i, FT-58) the road bits stamped on the GPU from an owner's shapes (agents/roads.ts) */
  private roadStamp: RoadStamp;
  /** (round 128i, V128-14) the riding groups on an owner's road graph (agents/ride.ts) */
  private roadRide: RoadRide;
  readonly units: GPUBuffer;
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  private occ: GPUBuffer;
  /** (FC12 stage 2) units.wgsl mail: the aim, the hits landing, the arrows (MAIL_*) */
  private mail: GPUBuffer;
  private events: GPUBuffer;
  private models: GPUBuffer;
  private kindModelsBuf: GPUBuffer;
  private params: GPUBuffer;
  private fieldGroup!: GPUBindGroup;
  private k: Record<'surfaces' | 'links' | 'occClear' | 'unitStep' | 'unitDraw' | 'itemDraw' | 'arrowDraw', ComputeKernel>;
  /** what each unit carries (round 63): by slot, its material and edge; and items in flight */
  private carryBuf: GPUBuffer;
  private flyBuf: GPUBuffer;
  private carried = new Map<number, { mat: number; amount: number }>();
  private flights: Flight[] = [];
  private nextItem = 1;
  private landed: AgentEvent[] = [];
  private flyAt = 0;
  /** each live unit at the last sync, by slot: x, y, z, vx, vy, vz, state */
  private seen = new Map<number, AgentState>();
  private terrain?: Terrain;
  private flyDrawn = false;
  private peelGroup: GPUBindGroup;
  /** (U2 round 7) the fields: a page pool (gpu/pagepool.ts; fieldseam.wgsl), bound at 6 in every fields kernel */
  readonly fields: PagePool;
  /** the field kernels: the frame's seeds (fieldseam.wgsl seedReset .. seedFlip, cpuSeeds), the relax over pages */
  private fk2: { reset: ComputeKernel; unmark: ComputeKernel; land: ComputeKernel; gone: ComputeKernel; flip: ComputeKernel; cpu: ComputeKernel; relax: ComputeKernel; seedG: GPUBindGroup; relaxG: GPUBindGroup };
  /**
   * (U2-FIELDCAP) The fields' page pool refused a page: an error shown (once), and orders after it fail 'pool-full'.
   * Told by the scope's read of the pool's count, or by an order the GPU failed for it (orders.wgsl FAIL_POOL) —
   * whichever comes first: the count is read only with the scope's box, now and then.
   */
  fieldPoolFull(refused = 1): void {
    const first = this.fieldPagesRefused === 0;
    this.fieldPagesRefused = Math.max(this.fieldPagesRefused, refused);
    if (!first) return;
    // (not fatal: legitimate play can ask for more fields than the pool holds until U2-FIELDREACH bounds each field's
    // pages by its walkers; the orders that can't be served fail 'pool-full' through orderFailed, play goes on)
    showWarning(`Units: the movement-field pool is full (${this.fields.o.pages} pages) — some orders fail 'pool-full' (U2-FIELDREACH)`);
  }

  /** (U2-FIELDCAP) seeds the seed list had no room for (fieldseam.wgsl seedList[3], read with the scope's box) */
  seedsDropped = 0;
  /** (U2 round 7) field pages the pool refused so far (read with the scope's box): > 0, the pool is full */
  fieldPagesRefused = 0;
  /** the fields' rows (sized from memory) */
  readonly fieldRows: number;
  /** the field ids in use (Agents.newField, or a caller's own id): the pool's rows below the high-water */
  private fieldIds = new Set<number>();
  /** per field id: its record (fieldseam.wgsl: place, arrival radii, reach, flags), written when it changes */
  private fieldRec = new Map<number, Uint32Array>();
  /** (round 104, simscale) the scope's box (agents.wgsl AB) */
  private abBuf: GPUBuffer;
  /** (U2) fieldseam.wgsl seedList: the frame's seeds, two lists; the hunt's and the foes' field ids (gpuHunt, gpuFoes) */
  private seedList: GPUBuffer;
  /** (FC11, ?agentprof=1) agents.wgsl frontDbg: seeds new and gone */
  private frontDbg: GPUBuffer;
  /** (?jfa=1) units.wgsl jfa: the JFA planes and flags; its passes (log2 of the window) */
  private jfaBuf: GPUBuffer;
  private jfaPasses: number;
  private jk?: Record<'obsInit' | 'obsPass' | 'obsNext' | 'obsClear' | 'obsEnd' | 'init' | 'pass' | 'next' | 'apply' | 'end' | 'rBegin' | 'rInit' | 'rPass' | 'rApply', ComputeKernel> & { g: GPUBindGroup };
  private huntField: number | null = null;
  private benchListed = 0;
  private benchSweeps = 0;
  /** (the field bench) frontDbg counted without ?agentprof=1 (read by benchFront: the front's asks a sweep) */
  benchProbe = false;
  /** (the field bench) the per-unit GPU cost by toggles: the units not drawn; notice not dispatched; the step at half
   *  rate (every other tick skipped — its time lost) */
  benchNoDraw = false;
  benchNoNotice = false;
  benchStepHalf = false;
  private benchStepParity = 0;

  /** (the field bench) the voxel instances the units' draw made last frame (the indirect args' instance count) */
  async benchInstances(): Promise<number> {
    const tmp = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.indirect, 0, tmp, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const n = new Uint32Array(tmp.getMappedRange().slice(0))[1];
    tmp.destroy();
    return n;
  }

  /**
   * (the field bench) Since the last call: chunks that asked to be relaxed and sweeps run (agents.wgsl frontDbg 45, 46,
   * counted while benchProbe is on), and the arrows' and the aim's counters (units.wgsl mail head). Then both cleared.
   * The bench's own small reads, never in play.
   */
  async benchCounters(): Promise<{ asks: number; sweeps: number; shots: number; landed: number; missed: number; toActFrames: number; toActN: number; direct: number }> {
    const tmp = this.device.createBuffer({ size: 256 + 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.frontDbg, 0, tmp, 0, 256);
    enc.copyBufferToBuffer(this.mail, 0, tmp, 256, 64);
    enc.clearBuffer(this.frontDbg);
    enc.clearBuffer(this.mail, 4, 60);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(tmp.getMappedRange().slice(0));
    tmp.destroy();
    const m = 64;
    // (U2 round 7: the fields' front, from the pool's header — entries listed and sweeps run since the last call)
    const h = await this.fields.stats();
    const asks = h.listed - this.benchListed;
    const sweeps = h.sweeps - this.benchSweeps;
    this.benchListed = h.listed;
    this.benchSweeps = h.sweeps;
    return { asks, sweeps, shots: u[m + 3], landed: u[m + 4], missed: u[m + 5], toActFrames: u[m + 1], toActN: u[m + 2], direct: u[m + 6] };
  }

  /** (FC12 stage 2) line of sight (?los=1) and seen-only targets (?seenonly=1); the field bench toggles them */
  los = LOS_FLAG;
  seenOnly = SEEN_FLAG;
  private aim?: { k: ComputeKernel; g: GPUBindGroup };
  private arrows!: { k: ComputeKernel; g: GPUBindGroup };
  /** a kind with a range (ranged): the arrows' kernels run */
  private ranged = false;
  /** (the field bench, ?fieldbench=1) the GPU-seeded hunt field on (its seeds scattered) or off: the CPU's seeds then */
  huntOn = true;
  /** (the field bench) relax not dispatched at all: the fields frozen as they stand — the fields' cost by difference */
  benchFrozen = false;
  private hk: { set: ComputeKernel; g: GPUBindGroup };
  /** (U2 round 5, DA-B32) the field the peaceful fighters' targets seed on the GPU (huntSet: the defenders close in) */
  private foeField: number | null = null;
  /** (U2 round 5) the order kernels (orders.wgsl), made when the town contracts' place table is handed over */
  private ok: { apply: ComputeKernel; done: ComputeKernel; resolve: ComputeKernel; count: ComputeKernel; emit: ComputeKernel; g: GPUBindGroup } | null = null;
  private orderParts: string[] = [];
  /** the joins waiting for the next step: slot, group, rank | SPAWN_BIT */
  private orderQ: number[] = [];
  /** the fields the order groups seed on the GPU (each counts as seeded) */
  private orderFieldOf: number[][];
  /** (round 6) the formation kernels (orders.wgsl formAnchor / formSlots: routes, clearance, fields) and the routes
   *  bound (a town's: useRoutes; a cleared stand-in before) */
  private fk: { anchor: ComputeKernel; slots: ComputeKernel; g: GPUBindGroup | null } | null = null;
  private routesBuf: GPUBuffer | null = null;
  private routesNone: GPUBuffer | null = null;
  /** (round 6b, U2-FORMBITS) the order groups in a formation (the CPU's own orders: no readback) — a set, not a 32-bit
   *  mask: order groups are sized from memory */
  private formGroups = new Set<number>();
  private orderSerial: Uint32Array;
  /** (U2 round 7) the order groups (sized from memory) and mail's layout for them */
  readonly orderGroups: number;
  private mailAt: ReturnType<typeof mailLayoutFor>;
  private uboxBuf: GPUBuffer;
  private readBuf: GPUBuffer;
  private reading = false;
  private lastRead = 0;
  /** (simscale) where the fields are kept and which are frozen (agents/scope.ts); null: ?agentscope=0 */
  readonly scope: AgentScope | null;
  private sk?: {
    surfaces: ComputeKernel;
    links: ComputeKernel;
    occ: ComputeKernel;
    enter: ComputeKernel;
    box: ComputeKernel;
    mark: ComputeKernel;
    /** (round 128o, DA-B26) the scope's chunks whose columns or water class changed (peeled) and those round them (linked) */
    lists: ChangedTiles;
    /** (DA-B26) the scope's chunks whose water's depth moved (their top surfaces' water brought up to date) */
    depths: ChangedTiles;
    water: ComputeKernel;
    waterG: GPUBindGroup;
    occG: GPUBindGroup;
    boxG: GPUBindGroup;
    peelG: GPUBindGroup;
    linksG: GPUBindGroup;
    enterG: GPUBindGroup;
    markG: GPUBindGroup;
  };

  /** (round 107) the scope's box drew in at the last tick: every field starts over at the next */
  private shrunk = false;
  private lastBox: [number, number, number, number] | null = null;
  /** (simscale) a read in flight: the spawns' serial it sees */
  private readIssued: { serial: number } | null = null;
  /** (simscale) its scope's chunks at the last tick (the perf overlay, tests) */
  lastScopeChunks = 0;
  private unitGroup: GPUBindGroup;
  private drawGroup: GPUBindGroup;
  /** slots in use: the high-water mark; freed slots (deaths, removals) are reused first */
  private count = 0;
  private free: number[] = [];
  private gen = new Uint16Array(MAX_UNITS);
  private seeds: (Seed & { field: number })[] = [];
  private groupField = new Uint32Array(MAX_GROUPS).fill(0xffffffff);
  /** per group: drawn at work (round 88: bent to a tool, a tool in hand) */
  private groupPose = new Uint32Array(MAX_GROUPS);
  private kinds: (KindSpec | undefined)[] = [];
  /**
   * (round 128o, DA-B22) Where the tick lies in its frame: the simulation's (installAgents: Simulation.frameTicks,
   * tickOfFrame); a tick on its own is a frame of one. At fast-forward the units' step runs in strides (stepPlan) and
   * what needn't run each tick — the fields' relaxation, the surfaces' peel, the ride, the draw — once a frame.
   */
  frame: () => { n: number; i: number } = () => ({ n: 1, i: 0 });
  /** (DA-B22) this tick's step: whether it runs and its dt (s); read by the traits, which step with the units */
  stepNow = { step: true, dt: TICK_DT };
  /** (DA-B22) this tick is its frame's last: the once-a-frame stages run */
  private frameWork = true;
  /** the ticks a step may span: half a cell at the fastest kind's speed (STEP_CELLS) */
  strideMost(): number {
    let v = 0;
    for (const k of this.kinds) if (k) v = Math.max(v, k.speed);
    return v > 0 ? Math.max(1, Math.floor(STEP_CELLS / (v * TICK_DT))) : 1;
  }
  /**
   * (DA-B22) The fields' sweeps on the frame's last tick: a tick's sweeps for every tick of the frame. A sweep carries a
   * field's front a step on, so its reach in sim time is the sweeps a tick's — fewer at fast-forward and the raiders
   * waited for their way in (the walled raid's gates shut a minute late at 16x, DEVLOG round 128o). A converged field's
   * front is empty: its relax dispatches no workgroups (dispatched indirect), its build and clear stay.
   */
  private frameSweeps(): number {
    return this.sweeps * this.frame().n;
  }
  /** (DA-B22) this tick's plan, the same for every caller in the tick (the traits ask before the agents encode) */
  planTick(): { step: boolean; dt: number; last: boolean } {
    const { n, i } = this.frame();
    const p = stepPlan(n, i, this.strideMost());
    return { step: p.step, dt: p.ticks * TICK_DT, last: i >= n - 1 };
  }
  private kindModel = new Uint32Array(MAX_KINDS * 4);
  private modelVoxels = 0;
  private hits: (HitSpec & { id: number })[] = [];
  private nextHit = 1;
  private targets: Target[] = [];
  /** (round 128f) places a game keeps in the fields' scope (window world x, y) by key: keepInScope */
  private kept = new Map<string, readonly (readonly [number, number])[]>();
  private holds = new Map<number, [number, number, number]>();
  private launches: [number, number, number, number][] = [];
  private regroups: number[] = [];
  /** (round 128p) units to make another kind at the next step: slot, kind, hp (or none) */
  private rekinds: [number, number, number | null][] = [];
  private ticks = 0;
  /** the surfaces weren't peeled while idle (round 88): peel on the next tick that needs them */
  private navStale = true;
  /** events that didn't fit the buffer, all told (0 normally) */
  dropped = 0;

  /**
   * (round 128o, DA-B2a) Tell when a unit following `field` comes within `radius` of its seeds (the field's distance at
   * its feet): an `arrived` event, once — again only after it has been `leave` or more away, or followed another field.
   * The GPU decides (units.wgsl); the CPU needn't watch where its units are. radius 0: no arrivals for the field.
   */
  arrivals(field: number, radius: number, leave = radius): void {
    if (radius > 0 && leave < radius) throw new Error(`agents.arrivals: leave (${leave}) under the radius (${radius})`);
    const r = this.recOf(field);
    const f = new Float32Array(r.buffer);
    f[1] = radius;
    f[2] = leave;
    this.writeRec(field);
  }

  /** (round 128o, DA-B2) the events read so far (the ring's: units.wgsl emit), and the syncs' staging kept for reuse */
  private eventsRead = 0;
  private pool: GPUBuffer[] = [];

  /** a staging buffer of at least `size` bytes, kept between syncs (made bigger when the units outgrow it) */
  private staging(size: number): GPUBuffer {
    const i = this.pool.findIndex((b) => b.size >= size);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    // (too small for the units now: let go)
    this.pool.pop()?.destroy();
    return this.device.createBuffer({ label: 'agents sync', size: Math.ceil(size / 4096) * 4096, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }
  /**
   * (round 128p, DA-B22 (c)(3)) Who fights whom, on the GPU, once a frame after the units' last step: each unit's
   * combat word (`notice.set`), the game's rules (`setRules`, `setSides`), its actors (`setActors`), the targets it
   * gives (`aim`). A unit's target comes back in its state (`target`), a new one as a `noticed` event.
   */
  readonly notice: UnitNotice;
  private picker: UnitPick;
  private reads: UnitReads;

  /**
   * (round 128p, DA-B22 (c)(4)) The live units within `r` of (x, y), with where they stand — asked of the GPU (two
   * small reads), not from positions read every frame.
   */
  near(x: number, y: number, r: number, faction: number | null = null): Promise<UnitFound[]> {
    return this.reads.near(x, y, r, this.count, 1024, faction);
  }

  /**
   * (round 128p, DA-B22 (c)(2)) Of the units `ids`, the one whose figure is drawn nearest the tap (`ask`), or null —
   * found on the GPU, one small read back (agents/pick.ts).
   */
  async pick(ids: readonly number[], ask: PickAsk): Promise<number | null> {
    const live = ids.filter((id) => id % MAX_UNITS < this.count);
    const k = await this.picker.pick(live.map((id) => id % MAX_UNITS), ask);
    return k === null ? null : live[k];
  }
  /** (LW1) stages between the units' step and their draw (agents.addStage) */
  private stages: AgentStage[] = [];
  /**
   * (LW1) Corpse mode (the trait system turns it on): a fallen unit's slot isn't freed at its death — its body lies
   * there, a corpse to raise, until it decays (a 'decayed' event, or its record seen zeroed). Off: freed at death.
   */
  private keepCorpses = false;
  private corpses = new Set<number>();

  /** (LW1) corpse mode on or off (the trait system's); off clears the bodies lying now (their slots freed) */
  setKeepCorpses(on: boolean): void {
    this.keepCorpses = on;
    if (on) return;
    const z = new Float32Array(UF);
    for (const slot of this.corpses) {
      this.device.queue.writeBuffer(this.units, slot * UNIT_BYTES, z);
      this.free.push(slot);
    }
    this.corpses.clear();
  }

  /**
   * Relax sweeps a tick (quality's `agentSweeps`; default 8). The fields'
   * fixed cost is the map's size × this. A change spreads this many cells a
   * tick (2: 120 cells/s, enough to follow anything that moves; a first
   * fill across a 256 map takes ~2 s rather than ~0.5).
   */
  sweeps: number;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
    sweeps = 8,
    /** (tests) the field pool's pages, in place of FIELD_POOL_BYTES' (as ?fieldpages) */
    opts: { fieldPages?: number } = {},
  ) {
    this.sweeps = sweeps;
    const cols = world.w * world.h;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.nav = world.buf('agentNav', cols * NAV_K * NAV_BYTES, S);
    this.navCost = world.buf('agentNavCost', cols * NAV_K * 4, S);
    // (round 128i: two planes — the road shapes' bits, then the riding network's: agents/ride.ts)
    this.roads = world.buf('agentRoads', Math.ceil(cols / 32) * 8, S);
    this.roadStamp = new RoadStamp(device, this.roads, world.w, world.h);
    // (U2 round 7) the fields: a page a field over a chunk, from one pool sized from memory (FIELD_POOL_BYTES), found
    // through the field's row of the table; the GPU hands pages out as a field grows
    const slots = (world.w / 16) * (world.h / 16);
    // (a page's payload, its control words, its generation, its free-stack word and its 9 front entries)
    const pageBytes = (2 * FIELD_PAGE_W + 2 * (FIELD_PAGE_W / 32) + 2 + 9) * 4;
    const pages = opts.fieldPages || FIELD_PAGES || Math.floor(FIELD_POOL_BYTES / pageBytes);
    this.fieldRows = Math.min(1 << 15, Math.max(FIELD_OWN + 16, FIELD_ROWS_FLAG || Math.floor(FIELD_TABLE_BYTES / (slots * 8.4))));
    this.fields = new PagePool(device, world.globals, {
      label: 'agentFields',
      owners: this.fieldRows,
      front: 9 * pages,
      pages,
      pageWords: 2 * FIELD_PAGE_W,
      pageCtl: 2 * (FIELD_PAGE_W / 32),
      ownerWords: FIELD_REC_W,
      slots,
      binding: 6,
      parts: [commonWgsl],
      fill: [new Uint32Array(new Float32Array([1e9]).buffer)[0], 0],
      split: FIELD_PAGE_W,
    });
    this.units = world.buf('agentUnits', MAX_UNITS * UNIT_BYTES, S);
    // (FC12 stage 2: a column's count and its shove's four words together, two halves — units.wgsl occAt/shoveAt)
    this.occ = world.buf('agentOcc', 2 * cols * 20, S);
    // (FC12 stage 2, units.wgsl mail: the aim kernel's sight of each fighter's target, the hits landing on each unit,
    // the arrows in flight)
    this.orderGroups = Math.max(8, ORDER_GROUPS_FLAG || Math.floor(ORDER_MAIL_BYTES / ((GROUP_W + ORDER_RANKS * RANK_W) * 4)));
    this.mailAt = mailLayoutFor(this.orderGroups);
    this.orderFieldOf = Array.from({ length: this.orderGroups }, () => []);
    this.orderSerial = new Uint32Array(this.orderGroups);
    this.mail = world.buf('agentMail', this.mailAt.words * 4, S);
    this.events = world.buf('agentEvents', (4 + EVENT_CAP * 8) * 4, S);
    this.inst = world.buf('agentInst', MAX_INST * 32, GPUBufferUsage.STORAGE);
    this.indirect = world.buf('agentIndirect', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.models = world.buf('agentModels', MAX_MODEL_VOXELS * 16, S);
    this.kindModelsBuf = world.buf('agentKindModels', MAX_KINDS * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.params = world.buf('agentParams', PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.carryBuf = world.buf('agentCarry', MAX_UNITS * 16, S);
    this.roadRide = new RoadRide(device, world.globals, this.units, this.roads, world.w, MAX_UNITS);
    // (round 128p, DA-B22 (c)(3): combat targeting on the GPU — agents/notice.ts)
    this.notice = new UnitNotice(device, world, this.units, this.events, MAX_UNITS, EVENT_CAP);
    this.picker = new UnitPick(device, this.units);
    this.reads = new UnitReads(device, this.units, MAX_UNITS, this.notice.combat);
    this.flyBuf = world.buf('agentFly', MAX_FLY * 32, S);
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    device.queue.writeBuffer(this.kindModelsBuf, 0, this.kindModel);
    // (trackA-liquids, LQ4 — docs/ARCHITECTURE.md "The flow model") the water on a surface the peel makes: the liquid's
    // runs per gap (world.waterGaps, at the water's binding: the peel stays at 8 storage buffers)
    const surfaceDepth = `@group(0) @binding(4) var<storage, read> waterGaps: array<vec4<u32>>;
fn surfaceDepth(i: u32, z: f32, top: bool) -> f32 {
  let g = waterGaps[i];
  if (top) { return bitcast<f32>(g.x); }
  for (var k = 1u; k < 4u; k++) {
    if (g[k] == 0u) { continue; }
    let fd = unpack2x16float(g[k]);
    if (abs(fd.x - z) < 0.3) { return fd.y; }
  }
  return 0.0;
}
`;
    // (the measurement toggles' constants: ?frontcap, ?blockrelax, ?relaxk — and the field bench's variants, made at
    // its start: partsFor)
    if (!unitsWgsl.includes('const ORDER_GROUPS: u32 = 8u;')) throw new Error('agents: ORDER_GROUPS not found in units.wgsl');
    const unitsSrc = unitsWgsl.replace('const ORDER_GROUPS: u32 = 8u;', `const ORDER_GROUPS: u32 = ${this.orderGroups}u;`).replace('const JFA_LOS: u32 = 0u;', `const JFA_LOS: u32 = ${JFA_LOS_BISECT ? 1 : 0}u;`).replace('const AIM_TICK_S: f32 = 1.0 / 60.0;', `const AIM_TICK_S: f32 = ${TICK_DT};`);
    if (!unitsWgsl.includes('const AIM_TICK_S: f32 = 1.0 / 60.0;')) throw new Error('agents: AIM_TICK_S not found in units.wgsl');
    if (!unitsWgsl.includes('const JFA_LOS: u32 = 0u;')) throw new Error('agents: JFA_LOS not found in units.wgsl');
    if (!fieldseamWgsl.includes('const SEED_LIST: u32 = 16384u;')) throw new Error('agents: SEED_LIST not found in fieldseam.wgsl');
    const seamSrc = fieldseamWgsl.replace('const SEED_LIST: u32 = 16384u;', `const SEED_LIST: u32 = ${SEED_LIST}u;`);
    const fieldParts = (k: number): string[] => {
      const consts: [string, string][] = [['const RELAX_K: u32 = 16u;', `const RELAX_K: u32 = ${k}u;`]];
      let agentsSrc = agentsWgsl;
      for (const [a, b] of consts) {
        if (!agentsSrc.includes(a)) throw new Error(`agents: "${a}" not found in agents.wgsl`);
        agentsSrc = agentsSrc.replace(a, b);
      }
      return [commonWgsl, layersWgsl, materialsWgsl, waterclassWgsl, agentsSrc, surfaceDepth + unitsSrc, this.fields.wgsl(), seamSrc];
    };
    const parts = fieldParts(RELAX_K);
    // (round 6: the orders reach fields only through fieldseam.wgsl)
    this.orderParts = [...parts, townplaceWgsl, routereadWgsl, ordersWgsl];
    const mk = (e: string, sp: BindSpec) => makeCompute(device, `agents-${e}`, parts, sp, e);
    // four layouts, each within 8 storage buffers: the peel (it reads the
    // layers and the places), the fields, the units' tick, their draw. (U2 round 7) The fields are one binding: the page
    // pool at 6 (tables and pages)
    const peelSpec: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 11: 'read', 12: 'read', 37: 'rw' };
    const fieldSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 10: 'uniform', 37: 'rw', 38: 'uniform', 40: 'read', 55: 'rw' };
    // (?jfa=1: the obstacles and targets JFA's planes; the obstacles made at the first frame — jfa[2])
    const passes = Math.ceil(Math.log2(Math.max(world.w, world.h, 2)));
    this.jfaBuf = world.buf('agentJfa', (8 + 7 * cols) * 4, S);
    device.queue.writeBuffer(this.jfaBuf, 0, new Uint32Array([0, 0, 1, 0, passes, 0, 0, 0]));
    this.jfaPasses = passes;
    this.seedList = world.buf('agentSeedList', (SEED_HEAD + 4 * SEED_LIST) * 4, S);
    this.frontDbg = world.buf('agentFrontDbg', 64 * 4, S);
    device.queue.writeBuffer(this.seedList, 0, new Uint32Array(SEED_HEAD).fill(FIELD_NONE).fill(0, 0, 4));
    // (round 104, simscale: agents/scope.ts)
    this.abBuf = world.buf('agentScope', 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.abBuf, 0, new Uint32Array([0, 0, world.w, world.h, 0, 0, 0, 0]));
    this.uboxBuf = world.buf('agentUnitBox', 16, S);
    this.readBuf = world.buf('agentScopeRead', 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.scope = SCOPE && world.tiles ? new AgentScope(world.w / 16, world.h / 16) : null;
    const unitSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw', 10: 'uniform', 13: 'rw', 14: 'read', 15: 'tex', 16: 'rw', 19: 'tex', 25: 'read' };
    const drawSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 7: 'rw', 9: 'rw', 10: 'uniform', 16: 'rw', 22: 'rw', 23: 'read', 24: 'uniform', 26: 'read', 27: 'read' };
    this.k = {
      surfaces: mk('surfaces', peelSpec),
      links: mk('links', fieldSpec),
      occClear: mk('occClear', unitSpec),
      unitStep: mk('unitStep', unitSpec),
      unitDraw: mk('unitDraw', drawSpec),
      itemDraw: mk('itemDraw', drawSpec),
      arrowDraw: mk('arrowDraw', drawSpec),
    };
    const base = { 0: world.globals, 2: world.materials };
    this.peelGroup = makeBindGroup(device, 'agents-peel', this.k.surfaces.layout, {
      ...base,
      1: world.chunks,
      3: world.layers,
      4: world.waterGaps,
      5: this.nav,
      6: this.fields.buffer,
      11: world.places,
      12: world.placeTable,
      37: this.navCost,
    });
    this.fieldGroup = makeBindGroup(device, 'agents-fields', this.k.links.layout, { ...base, 5: this.nav, 6: this.fields.buffer, 10: this.params, 37: this.navCost, 38: this.abBuf, 40: this.roads, 55: this.jfaBuf });
    {
      // (U2 round 7) the frame's seeds (fieldseam.wgsl): last frame's moved aside, the CPU's, the hunt's and the orders'
      // put, those gone marked; then the relax over the pool's front
      const seedSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 10: 'uniform', 38: 'uniform', 53: 'rw', 54: 'rw' };
      const sm = (e: string) => mk(e, seedSpec);
      const relaxSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 10: 'uniform', 37: 'rw', 38: 'uniform', 40: 'read' };
      const relax = mk('fieldRelax', relaxSpec);
      const k = { reset: sm('seedReset'), unmark: sm('seedUnmark'), land: sm('seedLand'), gone: sm('seedGone'), flip: sm('seedFlip'), cpu: sm('cpuSeeds') };
      this.fk2 = {
        ...k,
        relax,
        seedG: makeBindGroup(device, 'agents-seeds', k.cpu.layout, { ...base, 5: this.nav, 6: this.fields.buffer, 10: this.params, 38: this.abBuf, 53: this.seedList, 54: this.frontDbg }),
        relaxG: makeBindGroup(device, 'agents-relax', relax.layout, { ...base, 5: this.nav, 6: this.fields.buffer, 10: this.params, 37: this.navCost, 38: this.abBuf, 40: this.roads }),
      };
      // (U2) the hunt's seeds on the GPU: once a frame before the relaxation
      const huntSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 7: 'rw', 10: 'uniform', 16: 'rw', 38: 'uniform', 41: 'read', 53: 'rw', 54: 'rw', 55: 'rw' };
      const set = mk('huntSet', huntSpec);
      this.hk = { set, g: makeBindGroup(device, 'agents-hunt', set.layout, { ...base, 5: this.nav, 6: this.fields.buffer, 7: this.units, 10: this.params, 16: this.mail, 38: this.abBuf, 41: this.notice.combat, 53: this.seedList, 54: this.frontDbg, 55: this.jfaBuf }) };
      if (JFA || LOS_BUILT) {
        const jSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 10: 'uniform', 37: 'rw', 38: 'uniform', 54: 'rw', 55: 'rw' };
        const jm = (e: string) => mk(e, jSpec);
        const j = { obsInit: jm('jfaObsInit'), obsPass: jm('jfaObsPass'), obsNext: jm('jfaObsNext'), obsClear: jm('jfaObsClear'), obsEnd: jm('jfaObsEnd'), init: jm('jfaInit'), pass: jm('jfaPass'), next: jm('jfaNext'), apply: jm('jfaApply'), end: jm('jfaEnd'), rBegin: jm('jfaRBegin'), rInit: jm('jfaRInit'), rPass: jm('jfaRPass'), rApply: jm('jfaRApply') };
        this.jk = { ...j, g: makeBindGroup(device, 'agents-jfa', j.init.layout, { ...base, 5: this.nav, 6: this.fields.buffer, 10: this.params, 37: this.navCost, 38: this.abBuf, 54: this.frontDbg, 55: this.jfaBuf }) };
        // (FC12 stage 2: each fighter's target and its sight once a frame, after notice — aimTick)
        const aim = mk('aimTick', { 0: 'uniform', 2: 'uniform', 7: 'rw', 10: 'uniform', 16: 'rw', 55: 'rw' });
        this.aim = { k: aim, g: makeBindGroup(device, 'agents-aim', aim.layout, { ...base, 7: this.units, 10: this.params, 16: this.mail, 55: this.jfaBuf }) };
      }
      {
        // (FC12 stage 2: the arrows in flight, after each step — arrowStep)
        const arrows = mk('arrowStep', { 0: 'uniform', 2: 'uniform', 7: 'rw', 10: 'uniform', 16: 'rw' });
        this.arrows = { k: arrows, g: makeBindGroup(device, 'agents-arrows', arrows.layout, { ...base, 7: this.units, 10: this.params, 16: this.mail }) };
      }
    }
    if (this.scope) {
      const t = world.tiles!;
      const src = parts.join('\n');
      const ck = (e: string, sp: BindSpec, n: number) => {
        const c = cullKernel(t, src, sp, e, n);
        return { k: makeCompute(device, `agents-${e} scoped`, [c.code], c.spec, e), buf: c.buf };
      };
      const occSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 8: 'rw', 10: 'uniform' };
      const enterSpec: BindSpec = { 0: 'uniform', 2: 'uniform', 6: 'rw', 8: 'rw', 55: 'rw' };
      // (round 128o, DA-B26: the peel and the links over the GPU's lists — what changed, and round it; bound below)
      const lists = new ChangedTiles(device, world, t, SCOPE_LIST, 'agents-peel', CHUNK_COLUMNS | CHUNK_CLASS);
      const depths = new ChangedTiles(device, world, t, SCOPE_LIST, 'agents-water', CHUNK_DEPTH, false);
      const water = ck('surfaceWater', { 0: 'uniform', 2: 'uniform', 4: 'read', 5: 'rw' }, SCOPE_LIST);
      const surfaces = ck('surfaces', peelSpec, SCOPE_LIST);
      const links = ck('links', fieldSpec, SCOPE_LIST);
      const occ = ck('occClearCols', occSpec, SCOPE_LIST);
      const enter = ck('scopeIn', enterSpec, ENTER_LIST);
      const mark = ck('markChunks', { 0: 'uniform', 2: 'uniform', 6: 'rw', 10: 'uniform', 40: 'read' }, MARK_LIST);
      const box = makeCompute(device, 'agents-unitBox', parts, { 0: 'uniform', 2: 'uniform', 7: 'rw', 10: 'uniform', 28: 'rw' }, 'unitBox');
      const L = t.list(SCOPE_LIST);
      this.sk = {
        surfaces: surfaces.k,
        links: links.k,
        occ: occ.k,
        enter: enter.k,
        box,
        mark: mark.k,
        lists,
        depths,
        water: water.k,
        waterG: makeBindGroup(device, 'agents-surfaceWater', water.k.layout, { ...base, 4: world.water, 5: this.nav, [TILES_BINDING]: depths.changed.uniform }),
        occG: makeBindGroup(device, 'agents-occ scoped', occ.k.layout, { ...base, 8: this.occ, 10: this.params, [TILES_BINDING]: L }),
        boxG: makeBindGroup(device, 'agents-unitBox', box.layout, { ...base, 7: this.units, 10: this.params, 28: this.uboxBuf }),
        peelG: makeBindGroup(device, 'agents-peel scoped', surfaces.k.layout, { ...base, 1: world.chunks, 3: world.layers, 4: world.waterGaps, 5: this.nav, 6: this.fields.buffer, 11: world.places, 12: world.placeTable, 37: this.navCost, [TILES_BINDING]: lists.changed.uniform }),
        linksG: makeBindGroup(device, 'agents-links scoped', links.k.layout, { ...base, 5: this.nav, 6: this.fields.buffer, 10: this.params, 37: this.navCost, 38: this.abBuf, 40: this.roads, 55: this.jfaBuf, [TILES_BINDING]: lists.around.uniform }),
        enterG: makeBindGroup(device, 'agents-enter', enter.k.layout, { ...base, 6: this.fields.buffer, 8: this.occ, 55: this.jfaBuf, [TILES_BINDING]: enter.buf }),
        markG: makeBindGroup(device, 'agents-mark', mark.k.layout, { ...base, 6: this.fields.buffer, 10: this.params, 40: this.roads, [TILES_BINDING]: mark.buf }),
      };
    }
    this.unitGroup = makeBindGroup(device, 'agents-units', this.k.unitStep.layout, {
      ...base,
      5: this.nav,
      6: this.fields.buffer,
      7: this.units,
      8: this.occ,
      10: this.params,
      13: this.events,
      14: world.fire,
      15: world.windFieldView,
      16: this.mail,
      19: world.sparkView,
      25: world.lava,
    });
    this.drawGroup = makeBindGroup(device, 'agents-draw', this.k.unitDraw.layout, {
      ...base,
      7: this.units,
      9: this.inst,
      10: this.params,
      22: this.indirect,
      23: this.models,
      24: this.kindModelsBuf,
      26: this.carryBuf,
      27: this.flyBuf,
      16: this.mail,
    });
    DEFAULT_KINDS.forEach((k, i) => this.defineKind(i, k));
    // the surfaces now, not at the first tick: a game reading them before
    // the world has ticked (a level installs agents after its warmup) finds them
    this.writeParams([]);
    // (round 128l: in a level's pipeline batch, once its pipelines are ready — gpu/pipeline.ts whenPipelinesReady)
    whenPipelinesReady(() => {
      const enc = device.createCommandEncoder({ label: 'agents-prime' });
      const pass = enc.beginComputePass({ label: 'agents-prime' });
      const [gx, gy] = world.groups;
      pass.setBindGroup(0, this.peelGroup);
      pass.setPipeline(this.k.surfaces.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      pass.setBindGroup(0, this.fieldGroup);
      pass.setPipeline(this.k.links.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      pass.end();
      device.queue.submit([enc.finish()]);
    });
  }

  /** (LW1) Add a stage between the units' step and their draw (the trait system). */
  addStage(s: AgentStage): void {
    this.stages.push(s);
  }

  /** (LW1) The events buffer (units.wgsl's layout: [0] the count, then 8 u32 each) and its capacity: stages append to it. */
  get eventsBuffer(): GPUBuffer {
    return this.events;
  }
  static readonly EVENT_CAP = EVENT_CAP;

  /** (LW1) Kind `i`'s spec (undefined: not defined). */
  kindSpec(i: number): KindSpec | undefined {
    return this.kinds[i];
  }

  /** (LW1) Bodies lying as corpses now (corpse mode). */
  get corpseCount(): number {
    return this.corpses.size;
  }

  /** Slots in use (the live and the freed below the high-water mark). */
  get size(): number {
    return this.count;
  }

  /** (round 128p) the window's columns across and down (the side map's: units/agent-units.ts) */
  get dims(): { w: number; h: number } {
    return { w: this.world.w, h: this.world.h };
  }

  /** Define (or redefine) kind `i` (0..7). Defaults: 0 worker, 1 raider, 2 ogre. */
  defineKind(i: number, spec: KindSpec): void {
    if (i < 0 || i >= MAX_KINDS) throw new Error(`agents: kind ${i} out of 0..${MAX_KINDS - 1}`);
    this.kinds[i] = spec;
    if ((spec.range ?? 0) > 0) this.ranged = true;
    // (round 128o: a rider's pace on its trip — roadride.wgsl)
    this.roadRide.setKindSpeed(i, spec.speed);
    if (spec.model) {
      const vs = spec.model.voxels;
      if (this.modelVoxels + vs.length > MAX_MODEL_VOXELS) throw new Error(`agents: kind models over ${MAX_MODEL_VOXELS} voxels`);
      const code = Math.round(spec.model.voxel * 16);
      if (code < 1 || code > 63) throw new Error(`agents: a model voxel of ${spec.model.voxel} cells is outside 1/16..63/16`);
      const s = spec.model.voxel;
      const d = new Float32Array(vs.length * 4);
      const u = new Uint32Array(d.buffer);
      vs.forEach(([x, y, z, m], j) => {
        // (voxel centres: x, y round the feet, z up from them)
        d[j * 4] = x * s;
        d[j * 4 + 1] = y * s;
        d[j * 4 + 2] = (z + 0.5) * s;
        u[j * 4 + 3] = m;
      });
      this.device.queue.writeBuffer(this.models, this.modelVoxels * 16, d);
      this.kindModel.set([this.modelVoxels, vs.length, code, 0], i * 4);
      this.modelVoxels += vs.length;
    } else this.kindModel.set([0, 0, 0, 0], i * 4);
    this.device.queue.writeBuffer(this.kindModelsBuf, 0, this.kindModel);
  }

  /** A kind's index by name. */
  kindId(name: string): number {
    const i = this.kinds.findIndex((k) => k?.name === name);
    if (i < 0) throw new Error(`agents: no kind "${name}"`);
    return i;
  }

  /**
   * `n` units of a kind (index or name; default the worker) in `group`,
   * scattered round world (x, y) within `spread` cells; they land on the top
   * surface there. Returns their ids (generation × MAX_UNITS + slot: an id
   * stays unique when its slot is reused).
   */
  spawn(n: number, x: number, y: number, opts: { group?: number; kind?: number | string; spread?: number; hp?: number; atPlace?: boolean } = {}): number[] {
    const g = opts.group ?? 0;
    if (g < 0 || g >= MAX_GROUPS) throw new Error(`agents: group ${g} out of 0..${MAX_GROUPS - 1}`);
    const kind = typeof opts.kind === 'string' ? this.kindId(opts.kind) : (opts.kind ?? 0);
    const spec = this.kinds[kind];
    if (!spec) throw new Error(`agents: kind ${kind} isn't defined`);
    if (this.free.length + (MAX_UNITS - this.count) < n) throw new Error(`agents: no room for ${n} more units (${MAX_UNITS} slots)`);
    const spread = opts.spread ?? Math.sqrt(n) * 0.6;
    const ids: number[] = [];
    const d = new Float32Array(UF);
    const u = new Uint32Array(d.buffer);
    for (let i = 0; i < n; i++) {
      const slot = this.free.length ? this.free.pop()! : this.count++;
      const gen = (this.gen[slot] = (this.gen[slot] + 1) & 0xffff);
      const r = spread * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      d.fill(0);
      d[0] = x + Math.cos(a) * r;
      d[1] = y + Math.sin(a) * r;
      if (!opts.atPlace) this.scope?.place(d[0], d[1] / ROW_H);
      // (from above: the first step drops it onto the top surface)
      d[2] = 1e4;
      u[3] = g | (1 << 8) | (kind << 9) | (gen << 16);
      d[7] = Math.random();
      d[8] = opts.hp ?? spec.hp;
      d[11] = a;
      d[15] = Math.random() * Math.PI * 2;
      // (e: caps and look 0 — the trait modules derive them; its max hp, what healing tops it up to)
      d[18] = d[8];
      this.device.queue.writeBuffer(this.units, slot * UNIT_BYTES, d);
      // (U2 round 5: in no order group — the slot's last unit may have been; spawnAt's join sets it at the next step)
      this.device.queue.writeBuffer(this.mail, (16 + slot * AIM_W + 11) * 4, new Uint32Array([0]));
      // (round 128p: out of the fighting until the game gives it a part — notice.ts)
      this.notice.out(slot);
      ids.push(gen * MAX_UNITS + slot);
    }
    return ids;
  }

  private translator?: Translator;

  /**
   * The streamed window slid (round 80): every unit and item in flight moves with the land (−d: dx cells,
   * dy world units, dz cells); the fields and surfaces per column go with the streamer's (installAgents
   * hands them to it).
   */
  shift(dx: number, dy: number, dz: number): void {
    this.translator ??= new Translator(this.device);
    this.translator.run(this.units, MAX_UNITS, UNIT_V, 0b1, [dx, dy, dz]);
    this.translator.run(this.flyBuf, MAX_FLY, 2, 0b1, [dx, dy, dz]);
    for (const f of this.flights) f.pos = [f.pos[0] - dx, f.pos[1] - dy, f.pos[2] - dz];
    // (round 104, simscale: the scope's box with the land; the strips come in start over)
    this.scope?.shift(dx, Math.round(dy / ROW_H));
    const b = this.lastBox;
    const dr = Math.round(dy / ROW_H);
    if (b) this.lastBox = [b[0] - dx, b[1] - dr, b[2] - dx, b[3] - dr];
    // (U2 round 7: the fields stay — the ring keeps every chunk where it lies; the chunks come in are new to the scope,
    // their pages let go there and the fields round them relaxed into them: units.wgsl scopeIn. The kept points
    // (keepInScope) move with the land)
    for (const [k, pts] of this.kept) this.kept.set(k, pts.map(([x, y]) => [x - dx, y - dy] as [number, number]));
  }

  /**
   * (U2 round 5b, §9f) Unit slot `slot` told of a target by the game (an order: a target code, notice.ts): hunted where
   * it is even when never seen — seen-only hunts only the last-seen place of what was noticed. Code 0 lets it go.
   */
  tell(slot: number, code: number): void {
    this.notice.aim(slot, code);
    this.device.queue.writeBuffer(this.mail, (16 + slot * AIM_W + 3) * 4, new Uint32Array([code >>> 0]));
    this.device.queue.writeBuffer(this.mail, (16 + slot * AIM_W + 7) * 4, new Uint32Array([code ? 16 : 0]));
  }

  /** the per-column buffers a slide moves (name, buffer, bytes a column, planes) */
  columnBuffers(): { name: string; buf: GPUBuffer; stride: number; planes: number }[] {
    return [
      { name: 'agentNav', buf: this.nav, stride: NAV_K * NAV_BYTES, planes: 1 },
      { name: 'agentNavCost', buf: this.navCost, stride: NAV_K * 4, planes: 1 },
      { name: 'agentOcc', buf: this.occ, stride: 20, planes: 2 },
    ];
  }

  /** Take units out at once (no death event). */
  remove(ids: readonly number[]): void {
    const z = new Float32Array(UF);
    for (const id of ids) {
      const slot = id % MAX_UNITS;
      if (Math.floor(id / MAX_UNITS) !== this.gen[slot]) continue;
      // (a corpse that decayed is free already: not twice)
      if (!this.corpses.delete(slot) && this.free.includes(slot)) continue;
      this.device.queue.writeBuffer(this.units, slot * UNIT_BYTES, z);
      this.free.push(slot);
      this.holds.delete(slot);
      // (its load falls where it was last seen: ground isn't lost with it)
      const it = this.carried.get(slot);
      if (it) {
        this.carried.delete(slot);
        this.writeCarry(slot, undefined);
        const u = this.seen.get(slot);
        if (u) this.toss(materialName(it.mat), it.amount, [u.x, u.y, u.z + 1], [0, 0, 0]);
      }
    }
  }

  /**
   * (U2 round 7) A field id: a row of the fields' page pool (sized from memory), the lowest free one past the callers'
   * own (FIELD_OWN). Null only when every row is held — the memory is used up (the order isn't sent: 'pool-full'). Its
   * pages come as it grows; `freeField` lets them go.
   */
  newField(): number | null {
    for (let f = FIELD_OWN; f < this.fieldRows; f++) if (!this.fieldIds.has(f)) return this.useField(f);
    return null;
  }

  /** (U2 round 7) field `f` let go: its pages back to the pool, its record cleared, its id free for newField */
  freeField(f: number): void {
    if (!this.fieldIds.delete(f)) return;
    this.fields.release(f);
    this.fieldRec.delete(f);
    this.fields.writeOwner(f, new Uint32Array(FIELD_REC_W));
    this.seeds = this.seeds.filter((s) => s.field !== f);
  }

  /** field `f` in use (a caller's own id, or newField's): the pool's rows below the high-water are live */
  private useField(f: number): number {
    if (!Number.isInteger(f) || f < 0 || f >= this.fieldRows) throw new Error(`agents: field ${f} out of 0..${this.fieldRows - 1}`);
    if (!this.fieldIds.has(f)) {
      this.fieldIds.add(f);
      this.fields.setOwners(Math.max(...this.fieldIds) + 1);
      this.writeRec(f);
    }
    return f;
  }

  private recOf(f: number): Uint32Array {
    this.useField(f);
    let r = this.fieldRec.get(f);
    if (!r) this.fieldRec.set(f, (r = new Uint32Array(FIELD_REC_W)));
    return r;
  }

  private writeRec(f: number): void {
    this.fields.writeOwner(f, this.fieldRec.get(f) ?? new Uint32Array(FIELD_REC_W));
  }

  /** (U2 round 7) how far field `f` reaches (its cost; 0: the scope's cap): it holds no pages past it */
  reach(f: number, cost: number): void {
    new Float32Array(this.recOf(f).buffer)[FR_REACH] = cost;
    this.writeRec(f);
  }

  /** Group `g` follows field `f`, or stands still (f < 0). */
  follow(g: number, f: number): void {
    if (f >= 0) this.useField(f);
    this.groupField[g] = f < 0 ? FIELD_NONE : f;
  }

  /** Group `g`'s units are drawn at work (round 88): bending to a tool in their hands, while they stand. */
  workPose(g: number, on: boolean): void {
    if (g < 0 || g >= MAX_GROUPS) throw new Error(`agents.workPose: group ${g} out of 0..${MAX_GROUPS - 1}`);
    this.groupPose[g] = on ? 1 : 0;
  }

  /**
   * (fortress milestone 3, FT-46: units prefer roads; round 128i, FT-58: from shapes, on the GPU) The road shapes
   * (agents/roads.ts packRoadShapes, in their owner's frame) and where that frame sits in the window (whole columns,
   * rows — even): a step along a road costs less in every field (agents.wgsl ROAD_COST). The bits are stamped on the GPU
   * (shaders/roadstamp.wgsl) when the shapes (a new array) or the offset change: call it every frame, a slide moves only
   * the offset. No shapes: no roads.
   */
  setRoads(shapes: Float32Array, ox = 0, oy = 0): void {
    // (the fields' costs changed everywhere a road came or went: every chunk of the scope relaxed again)
    if (this.roadStamp.set(shapes, ox, oy) && this.scope) this.scope.markAll = true;
  }

  /**
   * (round 128i, V128-14; the user: "Can agents transfer from flow field onto paths on the GPU?") The road graph the
   * groups that ride go by (agents/roadgraph.ts, in its owner's frame — the road shapes' — at window offset (ox, oy),
   * as setRoads): the same object again is no change, call it every frame. Its next-hop tables are made on the GPU.
   */
  setRoadGraph(g: RoadGraph, ox = 0, oy = 0): void {
    this.roadRide.setGraph(g, ox, oy);
  }

  /**
   * (round 128i, V128-14) Group `g` rides the roads to these goals (the road graph's frame), or stops riding (null):
   * it follows the shared field onto the roads (ROAD_FIELD), then the road graph to the node nearest the goal that's
   * cheapest from where it joined, then straight to that goal, where it stands. False (and it doesn't ride: follow its
   * own field) when there are no roads, or a goal is more than RIDE_NEAR from any node. The caller sets what it follows.
   */
  ride(g: number, goals: readonly (readonly [number, number])[] | null): boolean {
    const ok = this.roadRide.setGoals(g, goals);
    // (the goals kept in the fields' scope: the road field reaches them)
    const pts = this.roadRide.goalPoints().map((p) => this.roadRide.toWindow(p));
    this.keepInScope('ride', pts);
    return ok;
  }

  /**
   * (round 128i, V128-14; U2 round 7: a field id of its own, made the first time it's asked for) The shared field onto
   * the roads: every surface of the riding network's columns a seed while a group rides — the riding groups follow it
   * until they're on the network.
   */
  get roadField(): number {
    if (this.road === null) {
      const f = this.newField();
      if (f === null) throw new Error('agents.roadField: every field row is held');
      this.road = f;
      this.recOf(f)[FR_FLAGS] = FO_ROAD;
      this.writeRec(f);
    }
    return this.road;
  }
  private road: number | null = null;
  private wasRiding = false;

  /** (round 128i) the groups riding the roads now (a bit each), and the road graph's nodes */
  get rideInfo(): { riding: number; nodes: number } {
    return { riding: this.roadRide.riding, nodes: this.roadRide.nodes };
  }

  /** (round 128i) the next-hop tables on the GPU (tests) */
  get rideHops(): GPUBuffer {
    return this.roadRide.hopsBuffer;
  }

  /** Field `f`'s seeds (its distance is 0 there): a goal, a stockpile, a threat. Put every frame (fieldseam.wgsl
   *  cpuSeeds): one moved or gone empties the values it made (their seed-ids) and the field refills from the rest. */
  seed(f: number, seeds: readonly Seed[]): void {
    this.useField(f);
    const rest = this.seeds.filter((s) => s.field !== f);
    if (rest.length + seeds.length > MAX_SEEDS) throw new Error(`agents: more than ${MAX_SEEDS} seeds`);
    if (this.scope) for (const s of seeds) this.scope.mark(s.x, s.y / ROW_H);
    this.seeds = [...rest, ...seeds.map((s) => ({ ...s, field: f }))];
  }

  /**
   * (round 128f; the user: "agents seem to not be able to path through the city or farms to buildings at the
   * peripheral") Places (window world x, y) the fields must reach though nobody stands there and no field is seeded on
   * them yet — a routine's far destinations, read from a field before anyone walks there (the fortress's blocks still to
   * build, asked whether the stores' field reaches them). The scope (agents/scope.ts) is a box round what the agents
   * do: past it every field reads no way. Replaces what `key` kept before; [] lets go.
   */
  keepInScope(key: string, pts: readonly (readonly [number, number])[]): void {
    if (pts.length) this.kept.set(key, pts.slice());
    else this.kept.delete(key);
  }

  /**
   * (U2, UNIT_MINDS_U2.md §5) Field `f` seeded on the GPU by every hostile kind's target (its unit word f.y): each a
   * seed, scattered once a frame before the relaxation (units.wgsl huntSet) — beside its CPU seeds (actors'). Set once.
   * Each value keeps the seed it came from: a seed gone empties its values at once (no count-up; U2 §5b).
   */
  gpuHunt(f: number): void {
    this.useField(f);
    if (f === this.huntField) return;
    if (this.huntField !== null) throw new Error('agents.gpuHunt: one hunt field, set once');
    this.huntField = f;
    this.writeHuntFields();
  }

  /**
   * (U2 round 5, DA-B32) Field `f` seeded on the GPU by every peaceful fighting kind's target (a guard's, a soldier's:
   * a reach or a range, no notice) — the defenders close in on it, apart from the hunters' field. Set once.
   */
  gpuFoes(f: number): void {
    this.useField(f);
    if (f === this.foeField) return;
    if (this.foeField !== null) throw new Error('agents.gpuFoes: one foes field, set once');
    if (f === this.huntField) throw new Error('agents.gpuFoes: not the hunt field');
    this.foeField = f;
    this.writeHuntFields();
  }

  /**
   * (U2 round 7, §9e) Side `side`'s own fields (a faction's number, 0..254): its fighters' targets seed `hunt` (its
   * fighters close in down it — not the shared hunt or foes field), and its fighters seed `threat` where they stand (the
   * ground near them, for others to flee). Being paged, each covers only the ground round its own army. null: none.
   * Who's whose enemy is `notice.relations`.
   */
  sideFields(side: number, f: { hunt?: number; threat?: number } | null): void {
    if (!Number.isInteger(side) || side < 0 || side > 254) throw new Error(`agents.sideFields: side ${side} out of 0..254`);
    for (const id of [f?.hunt, f?.threat]) if (id !== undefined) this.useField(id);
    this.sides.set(side, f ?? {});
    this.device.queue.writeBuffer(this.seedList, (SEED_SIDES + side * 2) * 4, new Uint32Array([f?.hunt ?? FIELD_NONE, f?.threat ?? FIELD_NONE]));
  }
  private sides = new Map<number, { hunt?: number; threat?: number }>();

  private writeHuntFields(): void {
    // (the field bench's huntOn off: none — the seeds stop, the fields empty of them)
    const on = (f: number | null) => (this.huntOn && f !== null ? f : FIELD_NONE);
    this.device.queue.writeBuffer(this.seedList, 16, new Uint32Array([on(this.huntField), on(this.foeField)]));
  }

  // ---- (U2 round 5) place-based orders, resolved on the GPU (orders.wgsl) -------------------------------------------

  /**
   * The town contracts' place table (TownContractsApi.places, read through townplace.wgsl at binding 57): the order
   * kernels made over it. Before it, spawnAt and order throw.
   */
  usePlaces(places: GPUBuffer): void {
    // (round 6b: the live water (4) — a spawn is placed only on dry ground; the nav's copy of it is brought up to date
    // only where the agents' scope has been, so it can read none at a spawn point no one has been near)
    const sp: BindSpec = { 0: 'uniform', 2: 'uniform', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 10: 'uniform', 13: 'rw', 16: 'rw', 38: 'uniform', 53: 'rw', 57: 'read' };
    const mk = (e: string) => makeCompute(this.device, `agents-${e}`, this.orderParts, sp, e);
    const k = { apply: mk('orderApply'), done: mk('orderDone'), resolve: mk('orderResolve'), count: mk('groupCount'), emit: mk('groupEmit') };
    const g = makeBindGroup(this.device, 'agents-orders', k.apply.layout, { 0: this.world.globals, 2: this.world.materials, 4: this.world.water, 5: this.nav, 6: this.fields.buffer, 7: this.units, 10: this.params, 13: this.events, 16: this.mail, 38: this.abBuf, 53: this.seedList, 57: places });
    this.ok = { ...k, g };
    // (round 6: the formation kernels — routes (56), the clearance (55), the fields (6); no places, no seeds)
    const fsp: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 6: 'rw', 7: 'rw', 10: 'uniform', 13: 'rw', 16: 'rw', 55: 'rw', 56: 'read' };
    const fm = (e: string) => makeCompute(this.device, `agents-${e}`, this.orderParts, fsp, e);
    this.fk = { anchor: fm('formAnchor'), slots: fm('formSlots'), g: null };
    this.routesNone = this.world.buf('agentRoutesNone', 64 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.useRoutes(null);
  }

  /**
   * (round 6) The town whose routes man and march orders read (routeread.wgsl at 56: LivingTowns.routeRead(id).buffer),
   * or none (a cleared table: no wall, no gates — their orders fail). One town's at a time.
   */
  useRoutes(buf: GPUBuffer | null): void {
    if (!this.fk) throw new Error('agents.useRoutes: no place table (usePlaces)');
    const b = buf ?? this.routesNone!;
    if (this.fk.g && b === this.routesBuf) return;
    this.routesBuf = b;
    this.fk.g = makeBindGroup(this.device, 'agents-form', this.fk.anchor.layout, { 0: this.world.globals, 2: this.world.materials, 5: this.nav, 6: this.fields.buffer, 7: this.units, 10: this.params, 13: this.events, 16: this.mail, 55: this.jfaBuf, 56: b });
  }

  /** (round 6, tests and the lab) where the order groups and the rank table lie in `mail` (readRaw('mail')) */
  get mailLayout(): { groups: number; groupW: number; formAt: number; ranks: number; rankW: number; ranksPerGroup: number; orderGroups: number } {
    return { groups: MAIL_GRP, groupW: GROUP_W, formAt: FORM_AT, ranks: this.mailAt.ranks, rankW: RANK_W, ranksPerGroup: ORDER_RANKS, orderGroups: this.orderGroups };
  }

  /** (round 6) the routes bound now (useRoutes), or null for none */
  get routesBound(): GPUBuffer | null {
    return this.routesBuf === this.routesNone ? null : this.routesBuf;
  }

  /** (before each step) the formations' anchors and their ranks' targets */
  private encodeFormations(pass: GPUComputePassEncoder): void {
    if (!this.fk?.g || this.formGroups.size === 0 || this.count === 0) return;
    pass.setBindGroup(0, this.fk.g);
    pass.setPipeline(this.fk.anchor.pipeline);
    // (formAnchor: a thread a group, 8 a workgroup — every order group's; one workgroup anchored groups 0-7 only)
    pass.dispatchWorkgroups(Math.ceil(this.orderGroups / 8));
    pass.setPipeline(this.fk.slots.pipeline);
    pass.dispatchWorkgroups((this.orderGroups * ORDER_RANKS) / 64);
    this.prof.dispatches += 2;
  }

  /** whether the place table is in (usePlaces) */
  get placesIn(): boolean {
    return this.ok !== null;
  }

  /**
   * Order group `g` (0..orderGroups-1): where it goes, by indices only; the GPU resolves the place each frame, seeds
   * the order's field there, and tells `groupArrived` (all its living members there) or `orderFailed` (the place isn't
   * valid: its status) once an order. Returns the order's serial (the events carry it).
   */
  order(g: number, r: OrderRecord): number {
    if (!this.ok) throw new Error('agents.order: no place table (usePlaces)');
    if (g < 0 || g >= this.orderGroups) throw new Error(`agents.order: group ${g} out of 0..${this.orderGroups - 1}`);
    if (r.field >= 0) this.useField(r.field);
    const serial = (this.orderSerial[g] = (this.orderSerial[g] + 1) & 0xffff);
    const routed = r.kind === 6 || r.kind === 7;
    if ((r.alts.length < 1 && !routed) || r.alts.length > ORDER_ALTS) throw new Error(`agents.order: 1..${ORDER_ALTS} places (else), not ${r.alts.length}`);
    const ref = (q: OrderPlace | undefined): number[] => {
      if (!q) return [0, 0, 0, 0, 0, 0];
      const named = 'name' in q.place;
      const p = q.place as { name: number } & { district: number; lotKind: number; rank: number };
      return [1, q.town, named ? 0 : 1, named ? p.name : p.district, named ? 0 : p.lotKind, named ? 0 : p.rank];
    };
    const w = new Uint32Array(GROUP_W);
    // (words 0-7: the GPU's own 8-19 left as they are — a write of 0-7, then of the refs)
    const fields = r.kind === 6 ? (r.runFields ?? []) : r.field >= 0 ? [r.field] : [];
    if (fields.length > 8) throw new Error('agents.order: 1..8 run fields (one a wall run)');
    for (const f of fields) this.useField(f);
    const f32 = new Float32Array(w.buffer);
    w.set([r.kind, r.alts.length, 0, r.formation ?? 0, 0, 0, r.field < 0 ? FIELD_NONE : r.field, serial], 0);
    f32[4] = r.spacing ?? 1.2;
    r.alts.forEach((a, i) => w.set([...ref(a.at), ...ref(a.also)], REF_AT + i * 2 * REF_W));
    // (round 6: the formation's words — the gate or the run, leave; the GPU's anchor and trail start over: route none)
    w.set([r.gate ?? 0xffffffff, r.leave ? 1 : 0, 0xffffffff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, fields.length], FORM_AT);
    // (the man order's run fields: a word each, orders.wgsl RUNF_AT)
    w.set(fields, RUNF_AT);
    this.device.queue.writeBuffer(this.mail, (MAIL_GRP + g * GROUP_W) * 4, w, 0, 8);
    // (its status none until resolved again: the formations wait for it)
    this.device.queue.writeBuffer(this.mail, (MAIL_GRP + g * GROUP_W + 11) * 4, new Uint32Array([1]));
    this.device.queue.writeBuffer(this.mail, (MAIL_GRP + g * GROUP_W + REF_AT) * 4, w, REF_AT, FORM_AT + 16 - REF_AT);
    this.device.queue.writeBuffer(this.mail, (MAIL_GRP + g * GROUP_W + RUNF_AT) * 4, w, RUNF_AT, 8);
    this.orderFieldOf[g] = r.kind >= 2 ? fields : [];
    const formed = r.kind === 5 || r.kind === 6 || r.kind === 7 || ((r.kind >= 2 && r.kind <= 4) && (r.formation ?? 0) > 0);
    if (formed) this.formGroups.add(g);
    else this.formGroups.delete(g);
    // (a new place: its seed is put there from the next frame; the old one's values empty by their seed-ids)
    return serial;
  }

  /**
   * `n` units of a kind made at order group `g`'s place: its approach point, round it in a spiral — placed on the GPU
   * at the next step (the place is the GPU's to know). Order the group first (`order`, kind 1 to stand). Returns ids.
   */
  spawnAt(n: number, g: number, opts: { kind?: number | string; hp?: number } = {}): number[] {
    if (!this.ok) throw new Error('agents.spawnAt: no place table (usePlaces)');
    if (g < 0 || g >= this.orderGroups) throw new Error(`agents.spawnAt: group ${g} out of 0..${this.orderGroups - 1}`);
    if (this.orderQ.length / 3 + n > ORDER_Q) throw new Error(`agents.spawnAt: more than ${ORDER_Q} joins a step`);
    const ids = this.spawn(n, 0, 0, { group: orderColourGroup(g), kind: opts.kind, hp: opts.hp, spread: 0, atPlace: true });
    ids.forEach((id, k) => this.orderQ.push(id % MAX_UNITS, g, (k | SPAWN_BIT) >>> 0));
    return ids;
  }

  /** units joining order group `g` where they stand (at the next step), ranked in the order given (ORDER_RANKS place
   *  in a formation; the rest follow the group's field) */
  joinOrder(ids: readonly number[], g: number): void {
    if (g < 0 || g >= this.orderGroups) throw new Error(`agents.joinOrder: group ${g} out of 0..${this.orderGroups - 1}`);
    if (this.orderQ.length / 3 + ids.length > ORDER_Q) throw new Error(`agents.joinOrder: more than ${ORDER_Q} joins a step`);
    // (round 6: each its rank — its place in `ids`: a formation's slot k)
    ids.forEach((id, k) => {
      const slot = this.slotOf(id);
      if (slot >= 0) this.orderQ.push(slot, g, k);
    });
  }

  /** (before the step) the queued joins applied: spawned ones placed at their group's place */
  private encodeOrderJoins(pass: GPUComputePassEncoder): void {
    if (!this.ok || !this.orderQ.length) return;
    const n = this.orderQ.length / 3;
    this.device.queue.writeBuffer(this.mail, this.mailAt.q * 4, new Uint32Array([n, ...this.orderQ]));
    this.orderQ = [];
    pass.setBindGroup(0, this.ok.g);
    pass.setPipeline(this.ok.apply.pipeline);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.setPipeline(this.ok.done.pipeline);
    pass.dispatchWorkgroups(1);
    this.prof.dispatches += 2;
  }

  /** (before the relaxation, the frame's last tick) each group's place resolved, its field seeded there */
  private encodeOrderSeeds(pass: GPUComputePassEncoder): void {
    if (!this.ok) return;
    pass.setBindGroup(0, this.ok.g);
    pass.setPipeline(this.ok.resolve.pipeline);
    // (a thread a group, 8 a workgroup: every order group — one workgroup resolved groups 0-7 only)
    pass.dispatchWorkgroups(Math.ceil(this.orderGroups / 8));
    this.prof.dispatches++;
  }

  /** (after the frame's last step) each group's members counted, its arrival told */
  private encodeOrderArrivals(pass: GPUComputePassEncoder): void {
    if (!this.ok || this.count === 0) return;
    pass.setBindGroup(0, this.ok.g);
    pass.setPipeline(this.ok.count.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    pass.setPipeline(this.ok.emit.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.orderGroups / 8));
    this.prof.dispatches += 2;
  }

  /** (?jfa=1) the obstacles JFA (when the columns changed: the kernels return at once otherwise), then the targets JFA
   *  and the line check (when the hunt's seeds changed cell) — the flags are the GPU's, so both are dispatched each frame */
  private encodeJfa(pass: GPUComputePassEncoder, targets: boolean): void {
    const j = this.jk!;
    const [gx, gy] = this.world.groups;
    pass.setBindGroup(0, j.g);
    const run = (init: ComputeKernel, step: ComputeKernel, next: ComputeKernel, fin: ComputeKernel, end: ComputeKernel | null) => {
      pass.setPipeline(init.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      for (let i = 0; i < this.jfaPasses; i++) {
        pass.setPipeline(step.pipeline);
        pass.dispatchWorkgroups(gx, gy);
        pass.setPipeline(next.pipeline);
        pass.dispatchWorkgroups(1);
      }
      pass.setPipeline(fin.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      if (end) {
        pass.setPipeline(end.pipeline);
        pass.dispatchWorkgroups(1);
      }
      this.prof.dispatches += 3 + 2 * this.jfaPasses;
    };
    run(j.obsInit, j.obsPass, j.obsNext, j.obsClear, j.obsEnd);
    if (!targets) return;
    run(j.init, j.pass, j.next, j.apply, null);
    // (?jfa=2: the rounds round the bends)
    for (let r = 0; r < JFA_ROUNDS; r++) {
      pass.setPipeline(j.rBegin.pipeline);
      pass.dispatchWorkgroups(1);
      run(j.rInit, j.rPass, j.next, j.rApply, null);
    }
    pass.setPipeline(j.end.pipeline);
    pass.dispatchWorkgroups(1);
  }

  /** (U2 round 7) the frame's seeds (fieldseam.wgsl): last frame's moved aside; the CPU's, the hunt's and the orders'
   *  put; those not put again marked gone — before the relaxation */
  private encodeSeeds(pass: GPUComputePassEncoder): void {
    const k = this.fk2;
    pass.setBindGroup(0, k.seedG);
    pass.setPipeline(k.reset.pipeline);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(k.unmark.pipeline);
    pass.dispatchWorkgroups(Math.ceil(SEED_LIST / 64));
    if (this.seeds.length) {
      pass.setPipeline(k.cpu.pipeline);
      pass.dispatchWorkgroups(Math.ceil(this.seeds.length / 64));
    }
    if ((this.huntField !== null || this.foeField !== null || this.sides.size > 0) && this.count > 0 && this.huntOn) {
      pass.setBindGroup(0, this.hk.g);
      pass.setPipeline(this.hk.set.pipeline);
      pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    }
    this.encodeOrderSeeds(pass);
    // (the pages the new seeds asked for handed out, their bits set)
    this.fields.encodeAlloc(pass);
    pass.setBindGroup(0, k.seedG);
    pass.setPipeline(k.land.pipeline);
    pass.dispatchWorkgroups(Math.ceil(SEED_LIST / 64));
    pass.setPipeline(k.gone.pipeline);
    pass.dispatchWorkgroups(Math.ceil(SEED_LIST / 64));
    pass.setPipeline(k.flip.pipeline);
    pass.dispatchWorkgroups(1);
    this.prof.dispatches += 6;
  }

  /** (U2 round 7) `sweeps` sweeps over the fields' front: pages handed out, the front listed, relaxed, flipped */
  private encodeRelax(pass: GPUComputePassEncoder, sweeps: number): void {
    for (let i = 0; i < sweeps; i++) {
      this.fields.encodeFront(pass);
      pass.setBindGroup(0, this.fk2.relaxG);
      pass.setPipeline(this.fk2.relax.pipeline);
      pass.dispatchWorkgroupsIndirect(this.fields.args, 0);
      this.fields.encodeFlip(pass);
      this.prof.dispatches += 5;
    }
  }


  /**
   * What hostile kinds go for (the player's units, up to 8), each frame:
   * reach and swings count to these; `field` (default 3; < 0 none) is seeded
   * on them, for the groups that follow it to close in by.
   */
  setTargets(targets: readonly Target[], field = 3): void {
    if (targets.length > MAX_TARGETS) throw new Error(`agents: more than ${MAX_TARGETS} targets`);
    this.targets = targets.slice();
    if (field >= 0) this.seed(field, targets);
  }

  /**
   * A hit from the game: damage, a push, fire, over a circle or a cone. Up to
   * 32 go each tick; more wait for the next. Returns its id (death and hurt
   * events name it).
   */
  hit(h: HitSpec): number {
    if (h.cone !== undefined && !h.axis && !h.dir) throw new Error('agents: a cone hit needs a dir or an axis');
    const id = this.nextHit++;
    this.hits.push({ ...h, id });
    return id;
  }

  /** The slot of a live id, or -1 for an id whose unit is gone (its slot reused). */
  private slotOf(id: number): number {
    const slot = id % MAX_UNITS;
    return Math.floor(id / MAX_UNITS) === this.gen[slot] && slot < this.count ? slot : -1;
  }

  /**
   * Hold unit `id` at world (x, y, z) (its feet), each frame while held (a
   * lich, a gorilla carrying it): nothing else moves it. Up to 8 at once.
   * Returns false when the unit is gone.
   */
  hold(id: number, x: number, y: number, z: number): boolean {
    const slot = this.slotOf(id);
    if (slot < 0) return false;
    if (!this.holds.has(slot) && this.holds.size >= MAX_HOLDS) throw new Error(`agents: more than ${MAX_HOLDS} units held`);
    this.holds.set(slot, [x, y, z]);
    return true;
  }

  /** Let go of a held unit: it tumbles with `vel` (cells/s; default: as it was moving). */
  release(id: number, vel?: readonly [number, number, number]): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    this.holds.delete(slot);
    if (vel) this.launches.push([vel[0], vel[1], vel[2], slot]);
  }

  /**
   * Throw a unit (held or not) with a velocity: it tumbles, bounces, knocks
   * others over, gets up. A velocity, so whatever its mass (the thrower
   * decides it; a lob must land where it's aimed). For a force, a knock that
   * heavy kinds shrug off, use a `hit` with `push` and `lift`.
   */
  /**
   * (round 128o, DA-A6) Its arrival latch let go (units.wgsl word f.x): it's told again when it's within its field's
   * radius — or at its ride's goal — even if it was told there already and hasn't left (its leg's goals changed under it:
   * the routine asks where it is now).
   */
  rearm(id: number): void {
    const slot = id % MAX_UNITS;
    this.device.queue.writeBuffer(this.units, (slot * UNIT_V + 5) * 16, new Uint32Array([0]));
  }

  /**
   * Move unit `id` to group `g` (from the next tick): it follows that
   * group's field and is drawn in its colour (round 63: a worker off to its
   * job, then to the pile). Up to 64 a tick; the rest wait.
   */
  regroup(id: number, g: number): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    if (g < 0 || g >= MAX_GROUPS) throw new Error(`agents.regroup: group ${g} out of 0..${MAX_GROUPS - 1}`);
    this.regroups.push(slot | (g << 16));
    // (U2 round 5: its order word, mail's aim word 11, cleared — moved to a group, it no longer walks an order; joinOrder
    // puts a unit in one)
    this.device.queue.writeBuffer(this.mail, (16 + slot * AIM_W + 11) * 4, new Uint32Array([0]));
  }

  /**
   * (round 128p, DA-B22 (c)(4)) Make a unit another kind where it stands (a recruit drilled a soldier, a unit turned
   * hostile), its hp set when given — not removed and spawned again, which needed where it stood. At the next step.
   */
  rekind(id: number, kind: number | string, hp?: number): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    const k = typeof kind === 'string' ? this.kindId(kind) : kind;
    if (!this.kinds[k]) throw new Error(`agents: kind ${kind} isn't defined`);
    this.rekinds.push([slot, k, hp ?? null]);
  }

  launch(id: number, vel: readonly [number, number, number], opts: LaunchOpts = {}): void {
    const slot = this.slotOf(id);
    if (slot < 0) return;
    this.holds.delete(slot);
    // (the stun rides in the slot's word, in hundredths of a second: units.wgsl)
    const stun = Math.round(Math.min(Math.max(opts.stun ?? 0, 0), MAX_STUN) * 100);
    this.launches.push([vel[0], vel[1], vel[2], slot + stun * MAX_UNITS]);
  }

  /**
   * Lob a unit from (x, y, z) so it lands at `to`, in `time` seconds
   * (default: by distance, 0.5-1.5 s): the velocity it's launched with.
   */
  lob(id: number, from: readonly [number, number, number], to: readonly [number, number, number], time?: number, opts: LaunchOpts = {}): [number, number, number] {
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const t = time ?? Math.min(1.5, Math.max(0.5, d / 14));
    const v: [number, number, number] = [(to[0] - from[0]) / t, (to[1] - from[1]) / t, (to[2] - from[2] + 0.5 * unitsG() * t * t) / t];
    this.launch(id, v, opts);
    return v;
  }

  /**
   * Keep field `f` to one place (a room, or a region: all its rooms): its
   * distances live only on that place's surfaces, and a unit following it
   * never steps off it, so a horde stays in its room. `null`: anywhere again.
   */
  confine(f: number, place: { id: number; kind: 'room' | 'region' } | null): void {
    this.recOf(f)[FR_PLACE] = place ? (place.id | (place.kind === 'region' ? 0x80000000 : 0)) >>> 0 : 0;
    this.writeRec(f);
    // (the field starts over on its place: its pages let go, refilled from its seeds)
    this.fields.release(f);
  }

  /** A CPU copy of field `f` to sample (fieldreader.ts; refresh it every few hundred ms). */
  reader(f: number): FieldReader {
    this.useField(f);
    return new FieldReader(this, f, this.world.w, this.world.h, this.world.ring);
  }

  /** The surfaces and one field's distances, read back together (FieldReader): the field's row of the page table, then
   *  its pages, laid out as a whole-window plane (FAR where it has none) */
  async readField(f: number): Promise<{ nav: Uint32Array; dist: Float32Array }> {
    const N = this.world.w * this.world.h * NAV_K;
    const P = this.fields.o;
    const slots = P.slots;
    const read = async (copy: (enc: GPUCommandEncoder, dst: GPUBuffer) => void, size: number): Promise<ArrayBuffer | null> => {
      const tmp = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = this.device.createCommandEncoder();
      copy(enc, tmp);
      this.device.queue.submit([enc.finish()]);
      let out: ArrayBuffer | null = null;
      await tmp.mapAsync(GPUMapMode.READ).then(() => {
        out = tmp.getMappedRange().slice(0);
        tmp.unmap();
      }, ignoreTeardown);
      tmp.destroy();
      return out;
    };
    const tb = await read((enc, d) => {
      enc.copyBufferToBuffer(this.nav, 0, d, 0, N * NAV_BYTES);
      enc.copyBufferToBuffer(this.fields.buffer, (this.fields.layout.table + f * slots) * 4, d, N * NAV_BYTES, slots * 4);
    }, N * NAV_BYTES + slots * 4);
    if (!tb) return { nav: new Uint32Array(0), dist: new Float32Array(0) };
    const nav = new Uint32Array(tb.slice(0, N * NAV_BYTES));
    const table = new Uint32Array(tb.slice(N * NAV_BYTES));
    const dist = new Float32Array(N).fill(1e9);
    const held = [...table].map((pg, slot) => [pg, slot]).filter(([pg]) => pg > 0);
    if (held.length) {
      const pb = await read((enc, d) => {
        held.forEach(([pg], i) => enc.copyBufferToBuffer(this.fields.buffer, (this.fields.ctlWords + (pg - 1) * P.pageWords) * 4, d, i * FIELD_PAGE_W * 4, FIELD_PAGE_W * 4));
      }, held.length * FIELD_PAGE_W * 4);
      if (pb) {
        const pages = new Float32Array(pb);
        held.forEach(([, slot], i) => dist.set(pages.subarray(i * FIELD_PAGE_W, (i + 1) * FIELD_PAGE_W), slot * FIELD_PAGE_W));
      }
    }
    return { nav, dist };
  }

  /** Send group `g` to world (x, y): its own field (field g) seeded there. */
  goTo(g: number, x: number, y: number, z?: number): void {
    const f = g;
    this.seed(f, [{ x, y, z }]);
    this.follow(g, f);
  }

  /**
   * The live units and the events since the last sync, in one readback (call
   * it each frame or close to it; it resolves a frame or two later). Deaths
   * free their slots here, so a game spawning to keep a horde up must sync.
   */
  // ---- carrying (round 63, docs/AGENTS.md "Carrying") -------------------------

  /** The world's terrain, for what units pick up, put down and throw (the world API hands it over). */
  useTerrain(t: Terrain): void {
    this.terrain = t;
  }

  private needTerrain(what: string): Terrain {
    if (!this.terrain) throw new Error(`agents.${what}: needs the world's terrain (createSim / attachSim hands it over)`);
    return this.terrain;
  }

  /** Where unit `id` stood at the last sync, or a clear error. */
  private seenAt(id: number, what: string): AgentState {
    const slot = this.slotOf(id);
    const u = slot < 0 ? undefined : this.seen.get(slot);
    if (!u) throw new Error(`agents.${what}: unit ${id} is gone, or hasn't been seen by a sync() yet`);
    return u;
  }

  /** The edge of the cube an amount makes (cells; drawn at most 3.9). */
  private static edge(amount: number): number {
    return Math.min(Math.max(Math.cbrt(amount), 0.2), 3.9);
  }

  private writeCarry(slot: number, it: { mat: number; amount: number } | undefined): void {
    const v = it ? [it.mat, Agents.edge(it.amount), 0, 0] : [0, 0, 0, 0];
    this.device.queue.writeBuffer(this.carryBuf, slot * 16, new Float32Array(v));
  }

  /**
   * Unit `id` carries `amount` cells³ of `material` (held over its head).
   * More of what it already carries adds to it; something else is an error.
   */
  carry(id: number, material: MaterialName, amount: number): void {
    const slot = this.slotOf(id);
    if (slot < 0) throw new Error(`agents.carry: unit ${id} is gone`);
    const m = materialId(material);
    const st = materialState(m);
    if (st !== 'solid' && st !== 'loose') throw new Error(`agents.carry: "${material}" isn't ground (a solid or loose material)`);
    if (!(amount > 0)) throw new Error(`agents.carry: amount must be > 0 (got ${amount})`);
    const had = this.carried.get(slot);
    if (had && had.mat !== m) throw new Error(`agents.carry: unit ${id} already carries ${materialName(had.mat)}`);
    const it = { mat: m, amount: (had?.amount ?? 0) + amount };
    this.carried.set(slot, it);
    this.writeCarry(slot, it);
  }

  /** What unit `id` carries (null: nothing). */
  carrying(id: number): Item | null {
    const it = this.carried.get(this.slotOf(id));
    return it ? { material: materialName(it.mat), amount: it.amount } : null;
  }

  /** Take unit `id`'s load off it (it goes nowhere: the game has it now). */
  unload(id: number): Item | null {
    const slot = this.slotOf(id);
    const it = this.carried.get(slot);
    if (!it) return null;
    this.carried.delete(slot);
    this.writeCarry(slot, undefined);
    return { material: materialName(it.mat), amount: it.amount };
  }

  /**
   * Unit `id` picks up `amount` cells³ off the top of the ground where it
   * stood at the last sync (terrain.take: exact, one material). Resolves
   * with what it took (amount 0: nothing it could carry; what it can't hold
   * goes back where it came from).
   */
  async pickUp(id: number, amount = 0.5): Promise<Item> {
    const t = this.needTerrain('pickUp');
    const u = this.seenAt(id, 'pickUp');
    const got = await t.take(u.x, u.y, amount);
    if (got.amount <= 0) return got;
    const slot = this.slotOf(id);
    const had = slot < 0 ? undefined : this.carried.get(slot);
    const st = materialState(materialId(got.material));
    if (slot < 0 || (had && had.mat !== materialId(got.material)) || (st !== 'solid' && st !== 'loose')) {
      await t.put(u.x, u.y, got.material, got.amount);
      return { material: got.material, amount: 0 };
    }
    this.carry(id, got.material, got.amount);
    return got;
  }

  /**
   * Unit `id` sets its load down where it stood at the last sync
   * (terrain.put: exact). Resolves with the amount put; what didn't fit (a
   * full column, BACKLOG Q21) stays carried.
   */
  async putDown(id: number): Promise<number> {
    const t = this.needTerrain('putDown');
    const u = this.seenAt(id, 'putDown');
    const slot = this.slotOf(id);
    const it = this.carried.get(slot);
    if (!it) return 0;
    this.carried.delete(slot);
    this.writeCarry(slot, undefined);
    const put = await t.put(u.x, u.y, materialName(it.mat), it.amount);
    const rest = it.amount - put;
    if (rest > 1e-6) {
      if (this.slotOf(id) === slot) this.carry(id, materialName(it.mat), rest);
      else this.toss(materialName(it.mat), rest, [u.x, u.y, u.z + 1], [0, 0, 0]);
    }
    return put;
  }

  /**
   * Unit `id` throws its load at `to` (world xyz), landing in `time` s
   * (default by distance). It flies, tumbling, and comes down as ground
   * where it lands (a 'landed' event), hitting units there with `hit`.
   * Returns the item's id (null: it carried nothing).
   */
  throwItem(id: number, to: [number, number, number], opts: { time?: number; hit?: ThrowHit } = {}): number | null {
    const u = this.seenAt(id, 'throwItem');
    const it = this.unload(id);
    if (!it) return null;
    const h = this.kinds.find((k) => k?.name === u.kind)?.height ?? 1.2;
    const from: [number, number, number] = [u.x, u.y, u.z + h + Agents.edge(it.amount) * 0.5];
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const time = opts.time ?? Math.max(0.35, d / 12);
    const vel: [number, number, number] = [(to[0] - from[0]) / time, (to[1] - from[1]) / time, (to[2] - from[2]) / time + 0.5 * unitsG() * time];
    return this.toss(it.material, it.amount, from, vel, opts.hit);
  }

  /** An item flying free: `amount` of `material` from `from` at `vel` (a boulder a giant hurls, debris). It lands as ground. */
  toss(material: MaterialName, amount: number, from: [number, number, number], vel: [number, number, number], hit?: ThrowHit): number {
    const m = materialId(material);
    const st = materialState(m);
    if (st !== 'solid' && st !== 'loose') throw new Error(`agents.toss: "${material}" isn't ground (a solid or loose material)`);
    if (!(amount > 0)) throw new Error(`agents.toss: amount must be > 0 (got ${amount})`);
    if (this.flights.length >= MAX_FLY) throw new Error(`agents.toss: ${MAX_FLY} items in flight at most`);
    const id = this.nextItem++;
    this.flights.push({ id, mat: m, amount, pos: [from[0], from[1], from[2]], vel: [vel[0], vel[1], vel[2]], spin: 0, hit });
    if (!this.flyAt) this.flyAt = performance.now();
    return id;
  }

  /** Items in flight now. */
  get inFlight(): { id: number; material: MaterialName; amount: number; x: number; y: number; z: number }[] {
    return this.flights.map((f) => ({ id: f.id, material: materialName(f.mat), amount: f.amount, x: f.pos[0], y: f.pos[1], z: f.pos[2] }));
  }

  /** Moves what's in flight on (each sync), lands what came down, and draws them. */
  private fly(): void {
    if (!this.flights.length && !this.flyDrawn) return;
    const now = performance.now();
    const dt = Math.min((now - (this.flyAt || now)) / 1000, 0.1);
    this.flyAt = now;
    const keep: Flight[] = [];
    for (const f of this.flights) {
      f.vel[2] -= unitsG() * dt;
      for (let a = 0; a < 3; a++) f.pos[a] += f.vel[a] * dt;
      f.spin += 7 * dt;
      const [x, y, z] = f.pos;
      const t = this.needTerrain('toss');
      // (off the map: gone)
      if (!t.inWindow(x, y)) continue;
      // (round 128o: the ground there not read yet — api/mirror.ts reads its page now — it flies on: its load isn't lost)
      if (!t.isRead(x, y)) {
        keep.push(f);
        continue;
      }
      const ground = t.floorAt(x, y, z) ?? t.heightAt(x, y);
      if (ground === null || z > ground) {
        keep.push(f);
        continue;
      }
      const material = materialName(f.mat);
      void t.put(x, y, material, f.amount).then((amount) => this.landed.push({ type: 'landed', item: f.id, material, amount, x, y, z: ground }));
      if (f.hit) {
        const sp = Math.hypot(f.vel[0], f.vel[1]);
        this.hit({
          x,
          y,
          z: ground,
          radius: f.hit.radius ?? Math.max(0.8, Agents.edge(f.amount)),
          damage: f.hit.damage ?? 0,
          push: f.hit.push ?? 0,
          lift: f.hit.lift,
          stun: f.hit.stun,
          groups: f.hit.groups,
          spare: f.hit.spare,
          dir: sp > 1e-3 ? [f.vel[0] / sp, f.vel[1] / sp] : undefined,
        });
      }
    }
    this.flights = keep;
    if (!keep.length) this.flyAt = 0;
    const buf = new Float32Array(MAX_FLY * 8);
    keep.forEach((f, i) => {
      const sp = Math.hypot(f.vel[0], f.vel[1]);
      buf.set([f.pos[0], f.pos[1], f.pos[2], f.mat, Agents.edge(f.amount), f.spin, sp > 1e-3 ? -f.vel[1] / sp : 1, sp > 1e-3 ? f.vel[0] / sp : 0], i * 8);
    });
    this.device.queue.writeBuffer(this.flyBuf, 0, buf);
    this.flyDrawn = keep.length > 0;
  }

  /** What units carried when they went down: it falls off them (tumbling: flung with them; dead: where they fell). */
  private shed(units: AgentState[], events: AgentEvent[]): void {
    for (const e of events) {
      if (e.type !== 'death') continue;
      const slot = e.id % MAX_UNITS;
      const it = this.carried.get(slot);
      if (!it) continue;
      this.carried.delete(slot);
      this.writeCarry(slot, undefined);
      this.toss(materialName(it.mat), it.amount, [e.x, e.y, e.z + 1], [0, 0, 0]);
    }
    for (const u of units) {
      if (u.state !== 'tumble') continue;
      const slot = u.id % MAX_UNITS;
      const it = this.carried.get(slot);
      if (!it) continue;
      this.carried.delete(slot);
      this.writeCarry(slot, undefined);
      this.toss(materialName(it.mat), it.amount, [u.x, u.y, u.z + 1.2], [u.vx, u.vy, Math.max(u.vz, 2)]);
    }
  }

  /**
   * The events since the last sync, and the units: every live one (by default), or (round 128o, DA-B2b) with
   * `{ watch }` only those ids (the observed — gathered on the GPU, no cap but the device's; one gone or not alive is left out):
   * their records alone are read, not every unit's. A game built on events (arrived, hurt, death…) watches the few it
   * shows.
   */
  /** (sync) the units' records read back: all of them, or the watched (`slots`) */
  private readUnits(b: ArrayBuffer, at: number, n: number, slots: number[] | null, watch: readonly number[] | undefined, units: AgentState[]): void {
      if (n) {
        const uf = new Float32Array(b, at, n * UF);
        const uu = new Uint32Array(b, at, n * UF);
        for (let r = 0; r < n; r++) {
          // (record r: slot r of all, or the r-th watched)
          const s = slots ? slots[r] : r;
          const info = uu[r * UF + 3];
          // (corpse mode: a body that rose — its event lost to a full buffer — or went to dust, seen here)
          if (this.corpses.has(s) && (info === 0 || (info >>> 8) & 1)) {
            this.corpses.delete(s);
            if (info === 0) this.free.push(s);
          }
          if (!((info >>> 8) & 1)) continue;
          const id = (info >>> 16) * MAX_UNITS + s;
          // (a watched id whose slot another took since)
          if (watch && !watch.includes(id)) continue;
          units.push({
            id,
            x: uf[r * UF],
            y: uf[r * UF + 1],
            z: uf[r * UF + 2],
            heading: uf[r * UF + 11],
            vx: uf[r * UF + 4],
            vy: uf[r * UF + 5],
            vz: uf[r * UF + 6],
            state: STATES[(info >>> 12) & 7] ?? 'wander',
            alight: ((info >>> 15) & 1) === 1,
            hp: uf[r * UF + 8],
            kind: this.kinds[(info >>> 9) & 7]?.name ?? '?',
            group: info & 0xff,
            target: uu[r * UF + 21],
            hunted: uf[r * UF + 22],
          });
        }
      }
  }


  async sync(opts: { watch?: readonly number[] } = {}): Promise<{ units: AgentState[]; events: AgentEvent[]; dropped: number; hunt: HuntCandidate[] }> {
    const watch = opts.watch;
    const slots = watch ? watch.map((id) => id % MAX_UNITS).filter((s) => s < this.count) : null;
    const n = slots ? slots.length : this.count;
    // (round 128o, DA-B2: the events a ring — units.wgsl emit — read from where the last sync stopped, at most
    // EVENT_WINDOW of them: 16 B of head and 8 KB of events, not the whole 64 KB block every sync; the rest next sync)
    const C = EVENT_CAP;
    const from = this.eventsRead;
    const first = from % C;
    // (round 128p, DA-B22 (c)(1): a first window of EVENT_MIN with the head; the head's count says how many more there
    // are — up to EVENT_WINDOW a sync, as ever — and those are read at once, before the sync returns)
    const W = EVENT_MIN;
    const a = Math.min(W, C - first);
    // (round 128p: the hunt's 8 nearest candidates after the events, 128 B — notice.wgsl huntTop)
    const huntAt = 16 + W * 32;
    const evBytes = huntAt + HUNT_BYTES;
    const size = evBytes + Math.max(n, 1) * UNIT_BYTES;
    const tmp = this.staging(size);
    const enc = this.device.createCommandEncoder({ label: 'agents sync' });
    enc.copyBufferToBuffer(this.events, 0, tmp, 0, 16);
    enc.copyBufferToBuffer(this.events, 16 + first * 32, tmp, 16, a * 32);
    if (a < W) enc.copyBufferToBuffer(this.events, 16, tmp, 16 + a * 32, (W - a) * 32);
    enc.copyBufferToBuffer(this.notice.top, 0, tmp, huntAt, HUNT_BYTES);
    // (round 128p: the watched gathered on the GPU into one block, one copy — agents/reads.ts)
    if (slots) this.reads.gather(enc, slots, tmp, evBytes);
    else if (n) enc.copyBufferToBuffer(this.units, 0, tmp, evBytes, n * UNIT_BYTES);
    this.device.queue.submit([enc.finish()]);
    const units: AgentState[] = [];
    const events: AgentEvent[] = [];
    let dropped = 0;
    // (the events' records, 8 words each, as many as the head says to read)
    let rec = new Uint32Array(0);
    let need = 0;
    const hunt: HuntCandidate[] = [];
    await tmp.mapAsync(GPUMapMode.READ, 0, size).then(() => {
      const b = tmp.getMappedRange(0, size);
      const made = new Uint32Array(b, 0, 4)[0];
      need = Math.min((made - from) >>> 0, EVENT_WINDOW);
      rec = new Uint32Array(need * 8);
      rec.set(new Uint32Array(b, 16, Math.min(need, W) * 8));
      const hf = new Float32Array(b, huntAt, HUNT_BYTES / 4);
      const hu = new Uint32Array(b, huntAt, HUNT_BYTES / 4);
      for (let k = 0; k < HUNT_BYTES / 16; k++) {
        const code = hu[k * 4 + 3];
        if (!code) break;
        hunt.push({ id: code - 1, x: hf[k * 4], y: hf[k * 4 + 1], z: hf[k * 4 + 2] });
      }
      this.readUnits(b, evBytes, n, slots, watch, units);
      tmp.unmap();
    }, ignoreTeardown);
    this.pool.push(tmp);
    // (more than the first window: the rest the head counted, read now)
    if (need > W) {
      const more = need - W;
      const at = (from + W) % C;
      const a2 = Math.min(more, C - at);
      const t2 = this.staging(more * 32);
      const e2 = this.device.createCommandEncoder({ label: 'agents sync events' });
      e2.copyBufferToBuffer(this.events, 16 + at * 32, t2, 0, a2 * 32);
      if (a2 < more) e2.copyBufferToBuffer(this.events, 16, t2, a2 * 32, (more - a2) * 32);
      this.device.queue.submit([e2.finish()]);
      await t2.mapAsync(GPUMapMode.READ, 0, more * 32).then(() => {
        rec.set(new Uint32Array(t2.getMappedRange(0, more * 32)), W * 8);
        t2.unmap();
      }, ignoreTeardown);
      this.pool.push(t2);
    }
    this.eventsRead = (from + need) >>> 0;
    {
      const eu = rec;
      const ef = new Float32Array(rec.buffer);
      const m = need;
      const BY: Record<number, 'fire' | 'water' | 'impact' | 'lava' | 'effect'> = { 0xffffffff: 'fire', 0xfffffffe: 'water', 0xfffffffd: 'impact', 0xfffffffc: 'lava', 0xfffffffb: 'effect' };
      const by = (v: number) => BY[v] ?? v;
      for (let e = 0; e < m; e++) {
        const o = e * 8;
        // (the ring had no room for it: its slot holds another's)
        if (eu[o + 7] !== ((from + e) >>> 0)) {
          dropped++;
          continue;
        }
        const p = { x: ef[o + 4], y: ef[o + 5], z: ef[o + 6] };
        const id = eu[o + 1];
        const kind = eu[o];
        if (kind === 1) events.push({ type: 'swing', id, target: eu[o + 2], damage: ef[o + 3], ...p });
        else if (kind === 2) events.push({ type: 'hurt', id, hit: by(eu[o + 2]) as number | 'impact', damage: ef[o + 3], ...p });
        else if (kind === 3) {
          events.push({ type: 'death', id, by: by(eu[o + 2]), ...p });
          // (corpse mode: the body lies there until it decays or rises)
          if (this.keepCorpses) this.corpses.add(id % MAX_UNITS);
          else this.free.push(id % MAX_UNITS);
          this.holds.delete(id % MAX_UNITS);
        } else if (kind === 4) events.push({ type: 'alight', id, by: by(eu[o + 2]) as number | 'fire', ...p });
        else if (kind === 5) events.push({ type: 'windup', id, target: eu[o + 2], lands: ef[o + 3], ...p });
        else if (kind === 6) {
          events.push({ type: 'decayed', id, ...p });
          if (this.corpses.delete(id % MAX_UNITS)) this.free.push(id % MAX_UNITS);
        } else if (kind === 7) {
          events.push({ type: 'raised', id, by: eu[o + 2], group: Math.round(ef[o + 3]), ...p });
          this.corpses.delete(id % MAX_UNITS);
        } else if (kind === 9) {
          events.push({ type: 'noticed', id, target: eu[o + 2], ...p });
        } else if (kind === 10) {
          events.push({ type: 'side', id, side: eu[o + 2], ...p });
        } else if (kind === 20) {
          events.push({ type: 'groupArrived', group: id, serial: eu[o + 2], n: Math.round(ef[o + 3]), ...p });
        } else if (kind === 22) {
          // (round 6: it left the window on a march that leaves — its slot free, no death)
          events.push({ type: 'left', id, group: eu[o + 2], ...p });
          this.free.push(id % MAX_UNITS);
          this.holds.delete(id % MAX_UNITS);
        } else if (kind === 23) {
          events.push({ type: 'spawned', group: id, serial: Math.round(ef[o + 3]), ...p });
        } else if (kind === 21) {
          events.push({ type: 'orderFailed', group: id, status: eu[o + 2] & 0xff, spawn: (eu[o + 2] & 0x100) !== 0, serial: Math.round(ef[o + 3]), ...p });
        } else if (kind === 8) {
          const f = eu[o + 2];
          events.push(f >= RIDE_ARRIVED ? { type: 'arrived', id, ride: f - RIDE_ARRIVED, ...p } : { type: 'arrived', id, field: f, dist: ef[o + 3], ...p });
        }
      }
    }
    // (the ring read this far: the GPU writes over what's behind it)
    this.device.queue.writeBuffer(this.events, 8, new Uint32Array([this.eventsRead]));
    if (dropped) console.warn(`agents: ${dropped} events didn't fit (${EVENT_CAP} unread at once): sync more often`);
    this.dropped += dropped;
    // (carrying: where each stands, loads shed, items in flight moved on)
    // (watching: only the watched seen anew)
    if (!slots) this.seen.clear();
    for (const u of units) this.seen.set(u.id % MAX_UNITS, u);
    this.shed(units, events);
    this.fly();
    events.push(...this.landed);
    this.landed = [];
    return { units, events, dropped, hunt };
  }

  /** The live units now: [x, y, z, group] each. */
  async read(): Promise<Float32Array> {
    const { units } = await this.sync();
    const out = new Float32Array(units.length * 4);
    units.forEach((u, i) => out.set([u.x, u.y, u.z, u.group], i * 4));
    return out;
  }

  /** A raw readback of one of its buffers (tests). */
  async readRaw(which: 'nav' | 'fields' | 'units' | 'jfa' | 'mail'): Promise<ArrayBuffer> {
    // (tests: 'jfa' — units.wgsl's JFA planes, ?jfa=1/2; 'mail' — the aim, the hits landing, the arrows; 'fields' —
    // the fields' page pool)
    const src = which === 'jfa' ? this.jfaBuf : which === 'mail' ? this.mail : which === 'fields' ? this.fields.buffer : this[which];
    const tmp = this.device.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, tmp, 0, src.size);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = tmp.getMappedRange().slice(0);
    tmp.destroy();
    return out;
  }

  private writeParams(hits: (HitSpec & { id: number })[]): void {
    const b = new ArrayBuffer(PARAMS_BYTES);
    const u = new Uint32Array(b);
    const f = new Float32Array(b);
    u[0] = this.count;
    u[1] = this.seeds.length;
    u[2] = 0;
    u[3] = this.ticks;
    this.seeds.forEach((s, i) => f.set([s.x, s.y, s.z ?? 1e4, s.field], P_SEEDS + i * 4));
    for (let g = 0; g < MAX_GROUPS; g++) {
      // (a group following nothing: FIELD_NONE — it stands)
      u[P_GFIELD + g] = this.groupField[g];
      u[P_GMAT + g] = GROUP_MATS[g % GROUP_MATS.length] | (this.groupPose[g] << 8);
    }
    // (round 128i, V128-14: the road field is seeded on the network's columns while a group rides: the nodes' chunks
    // marked as riding starts — markChunks asks for their pages; the rest of the network as the field reaches it)
    const riding = this.roadRide.riding !== 0;
    if (this.frameWork && riding !== this.wasRiding) {
      this.wasRiding = riding;
      if (riding && this.scope) for (const [x, y] of this.roadRide.nodePoints()) this.scope.mark(x, y / ROW_H);
      if (!riding && this.road !== null) this.fields.release(this.road);
    }
    u.set([hits.length, this.targets.length, EVENT_CAP, 0], P_N2);
    // (round 107: the scope drew in at the last tick — a chunk let go — so what ran through what it let go of is gone
    // from every field: they all start over from their seeds (U2 round 7: their pages let go))
    if (this.frameWork && this.shrunk && this.scope) {
      this.shrunk = false;
      for (const f of this.fieldIds) this.fields.release(f);
      if (riding) for (const [x, y] of this.roadRide.nodePoints()) this.scope.mark(x, y / ROW_H);
    }
    this.kinds.forEach((k, i) => {
      if (!k) return;
      const o = P_KINDS + i * 12;
      f.set([k.height, k.mass, k.hp, k.speed, k.reach ?? 0, k.damage ?? 0, k.swingPeriod ?? 1, k.notice ?? 0], o);
      u.set([k.colours?.legs ?? 0, k.colours?.head ?? 0, k.colours?.torso ?? 0, 0], o + 8);
      // (FC12 stage 2: a ranged kind's range, units.wgsl kind.c.w as f32 bits)
      f[o + 11] = k.range ?? 0;
    });
    hits.forEach((h, i) => {
      const o = P_HITS + i * 16;
      const unit = (v?: readonly [number, number]): [number, number] => {
        const l = v ? Math.hypot(v[0], v[1]) : 0;
        return v && l > 0 ? [v[0] / l, v[1] / l] : [0, 0];
      };
      const dir = unit(h.dir);
      const axis = h.axis ? unit(h.axis) : dir;
      const cone = h.cone !== undefined ? Math.cos(((h.cone / 2) * Math.PI) / 180) : -2;
      // (the groups it spares ride with the fire flag: bit 0 fire, bits 1-16 a group each)
      let spare = 0;
      for (const g of h.spare ?? []) spare |= 1 << g;
      if (h.groups) {
        let only = 0;
        for (const g of h.groups) only |= 1 << g;
        spare |= ~only & 0xffff;
      }
      f.set([h.x, h.y, h.z ?? -1e9, h.radius, dir[0], dir[1], cone, h.damage ?? 0, h.push ?? 0, h.outward ? 1 : 0, (h.fire ? 1 : 0) + spare * 2, h.id, axis[0], axis[1], h.lift ?? 0, Math.min(Math.max(h.stun ?? 0, 0), MAX_STUN)], o);
      // (round 128p: a hit on one unit — its id in x's bits, radius −1: units.wgsl)
      if (h.unit !== undefined) {
        u[o] = h.unit >>> 0;
        f[o + 3] = -1;
      }
    });
    this.targets.forEach((t, i) => {
      f.set([t.x, t.y, t.z, t.radius ?? 0.5], P_TARGETS + i * 4);
      f[P_TARGET_H + i] = t.height ?? 1.5;
    });
    const holds = [...this.holds].slice(0, MAX_HOLDS);
    const launches = this.launches.splice(0, MAX_LAUNCHES);
    const regroups = this.regroups.splice(0, MAX_REGROUPS);
    u.set([holds.length, launches.length, regroups.length, 0], P_N3);
    u.set(regroups, P_REGROUPS);
    f[P_STEP] = this.stepNow.dt;
    const rekinds = this.rekinds.splice(0, MAX_REKINDS);
    f[P_STEP + 1] = rekinds.length;
    if ((this.los || this.seenOnly) && !this.aim) throw new Error('agents: line of sight wants ?los=1, ?seenonly=1 or ?fieldbench=1 at load (its kernels)');
    u.set([this.huntOn ? (this.huntField ?? FIELD_NONE) : FIELD_NONE, riding && this.road !== null ? this.road : FIELD_NONE, (this.los ? 1 : 0) | (this.seenOnly ? 2 : 0), PROF || this.benchProbe ? 1 : 0], P_U2);
    rekinds.forEach(([slot, kind, hp], i) => {
      u.set([slot, kind, 0, hp === null ? 0 : 1], P_REKINDS + i * 4);
      if (hp !== null) f[P_REKINDS + i * 4 + 2] = hp;
    });
    holds.forEach(([slot, p], i) => f.set([p[0], p[1], p[2], slot], P_HOLDS + i * 4));
    launches.forEach((l, i) => f.set(l, P_LAUNCHES + i * 4));
    this.device.queue.writeBuffer(this.params, 0, b);
  }

  encode(enc: GPUCommandEncoder): void {
    // (round 128o, DA-B22: fast-forward — a tick the units don't step is left alone, what it would have consumed (the
    // hits, holds, launches, regroups) waiting for the next step; the step's dt the ticks it spans)
    const plan = this.planTick();
    this.stepNow = { step: plan.step, dt: plan.dt };
    if (!plan.step) return;
    this.frameWork = plan.last;
    this.roadRide.elapsed = this.frame().n * TICK_DT;
    // (round 128i: the road bits made again if their shapes or offset changed)
    this.roadStamp.encode(enc);
    // (round 128i, V128-14: the riding groups' next-hop tables made again if the graph or their goals changed)
    if (this.roadRide.encodeHops(enc, this.count) && this.scope) this.scope.markAll = true;
    // (the tick number rides in the params: the occupancy halves swap on it)
    this.writeParams(this.hits.splice(0, MAX_HITS));
    this.writeHuntFields();
    const [gx, gy] = this.world.groups;
    // (round 88: no units, nothing in flight and no field seeded — nothing reads the surfaces or the fields, so
    // neither is made; the first tick that needs them peels at once)
    if (this.count - this.free.length === 0 && this.flights.length === 0 && this.seeds.length === 0) {
      this.navStale = true;
      this.ticks++;
      return;
    }
    if (this.scope && this.sk) {
      this.encodeScoped(enc, this.scope, this.sk);
      this.ticks++;
      return;
    }
    const pass = enc.beginComputePass({ label: 'agents', timestampWrites: this.prof.timestamps('agents') });
    if (this.frameWork && (this.ticks % PEEL_EVERY === 0 || this.navStale)) {
      this.navStale = false;
      pass.setBindGroup(0, this.peelGroup);
      pass.setPipeline(this.k.surfaces.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      pass.setBindGroup(0, this.fieldGroup);
      pass.setPipeline(this.k.links.pipeline);
      pass.dispatchWorkgroups(gx, gy);
      this.prof.dispatches += 2;
    }
    if (this.frameWork && this.fieldIds.size > 0 && !this.benchFrozen) {
      this.fields.setBox(null);
      this.fields.encodeReleases(pass);
      this.encodeSeeds(pass);
      this.encodeRelax(pass, this.frameSweeps());
    }
    if (this.count > 0 || this.flights.length > 0) {
      pass.setBindGroup(0, this.unitGroup);
      pass.setPipeline(this.k.occClear.pipeline);
      pass.dispatchWorkgroups(Math.ceil((this.world.w * this.world.h) / 64));
      this.encodeUnits(pass);
    }
    pass.end();
    this.ticks++;
  }

  /** the units' step and their draws (every tick there are any) */
  /** (round 128o, DA-B22: `stage`, under ?agentprof=1, ends the pass and starts the next one timed under a name — the
   *  units' step, the traits, the ride, the draw apart — and returns it; the pass the units ended in comes back) */
  private encodeUnits(pass: GPUComputePassEncoder, stage: (name: string) => GPUComputePassEncoder = () => pass): GPUComputePassEncoder {
    pass = stage('agents-step');
    // (U2 round 5: units joining order groups — spawned ones placed at their place — before they step; round 6: the
    // formations' anchors and their ranks' targets)
    this.encodeOrderJoins(pass);
    this.encodeFormations(pass);
    // (the field bench: the step at half rate — every other tick's skipped, its time lost: the units move at half speed)
    this.benchStepParity ^= 1;
    if (!(this.benchStepHalf && this.benchStepParity)) {
      pass.setBindGroup(0, this.unitGroup);
      pass.setPipeline(this.k.unitStep.pipeline);
      pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    }
    // (FC12 stage 2: the arrows counted down after the step; one landing goes to its target's next step)
    if (this.ranged) {
      pass.setBindGroup(0, this.arrows.g);
      pass.setPipeline(this.arrows.k.pipeline);
      pass.dispatchWorkgroups(MAIL_ARROWS / 64);
    }
    // (LW1: the trait system — its core and the game's rules — between the step and the draw)
    pass = stage('agents-traits');
    for (const s of this.stages) s.encode(pass);
    // (round 128o, DA-B22: the ride and the draw once a frame — a frame's trips advance by its elapsed time
    // (RoadRide.elapsed); what's drawn is the frame's last state)
    if (!this.frameWork) return pass;
    // (round 128p, DA-B22 (c)(3): who fights whom, on the frame's last state)
    pass = stage('agents-notice');
    // (the field bench: notice not dispatched — every unit keeps the target it had)
    if (!this.benchNoNotice) this.notice.encode(pass, this.count);
    // (U2 round 5: the order groups' members counted at the frame's last state; arrived told once an order)
    this.encodeOrderArrivals(pass);
    // (FC12 stage 2: each fighter's target and its sight, for the next frame's steps)
    if (this.aim) {
      pass.setBindGroup(0, this.aim.g);
      pass.setPipeline(this.aim.k.pipeline);
      pass.dispatchWorkgroups(Math.ceil(Math.max(this.count, 1) / 64));
    }
    // (round 128i, V128-14: the riding groups steered along the roads — their steer read by the next tick's step)
    pass = stage('agents-ride');
    this.roadRide.encode(pass, this.count);
    // the draw's instance count restarts each tick (written before this tick's submit)
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    pass = stage('agents-draw');
    // (the field bench: the units not drawn — no voxel instances made, so none drawn: the draw's cost by difference)
    if (this.benchNoDraw) return pass;
    pass.setBindGroup(0, this.drawGroup);
    pass.setPipeline(this.k.unitDraw.pipeline);
    pass.dispatchWorkgroups(Math.ceil(Math.max(this.count, 1) / 64));
    pass.setPipeline(this.k.itemDraw.pipeline);
    pass.dispatchWorkgroups(MAX_FLY / 64);
    // (FC12 stage 2: the arrows in flight drawn)
    if (this.ranged) {
      pass.setPipeline(this.k.arrowDraw.pipeline);
      pass.dispatchWorkgroups(MAIL_ARROWS / 64);
    }
    this.prof.dispatches += 3;
    return pass;
  }

  /**
   * (round 104, simscale — agents/scope.ts) The tick over the scope only: the chunks new to it started over, the
   * surfaces peeled there, each sweep relaxing only the front (the chunks where something changed in the last one,
   * and those next to them), the occupancy cleared there; the units as ever. Every READ_EVERY ticks the units' box is
   * read back.
   */
  private encodeScoped(enc: GPUCommandEncoder, sc: AgentScope, sk: NonNullable<Agents['sk']>): void {
    const t = this.world.tiles!;
    // (round 128o, DA-B22: a step before its frame's last — the units step over the fields and surfaces as they stand;
    // the scope, the peel and the relaxation, and what they consume (marks, chunks come in, fields started over), wait
    // for the frame's last tick)
    if (!this.frameWork) {
      let pass = enc.beginComputePass({ label: 'agents', timestampWrites: this.prof.timestamps(PROF ? 'agents-step' : 'agents') });
      if (this.count > 0 || this.flights.length > 0) {
        if (this.lastScopeChunks > 0) {
          pass.setBindGroup(0, sk.occG);
          pass.setPipeline(sk.occ.pipeline);
          pass.dispatchWorkgroups(t.groups(SCOPE_LIST));
          this.prof.dispatches++;
        }
        pass = this.encodeUnits(pass, PROF ? (name) => (pass.end(), (pass = enc.beginComputePass({ label: name, timestampWrites: this.prof.timestamps(name) }))) : undefined);
      }
      pass.end();
      return;
    }
    const pts: [number, number][] = [];
    for (const s of this.seeds) pts.push([s.x, s.y / ROW_H]);
    for (const g of this.targets) pts.push([g.x, g.y / ROW_H]);
    for (const k of this.kept.values()) for (const p of k) pts.push([p[0], p[1] / ROW_H]);
    for (const p of this.holds.values()) pts.push([p[0], p[1] / ROW_H]);
    for (const f of this.flights) pts.push([f.pos[0], f.pos[1] / ROW_H]);
    const { list, enter } = sc.update(pts, this.ticks);
    this.lastScopeChunks = list.length;
    // (round 107, agentspike: a side drawn in — the values that ran through the chunks let go would count up a step a
    // sweep over the whole of the fields (FRAMECOST FC4); they start over instead, at the next tick — writeParams)
    const ob = this.lastBox;
    const nb = sc.box;
    if (ob && (!nb || nb[0] > ob[0] || nb[1] > ob[1] || nb[2] < ob[2] || nb[3] < ob[3])) this.shrunk = true;
    this.lastBox = nb ? [nb[0], nb[1], nb[2], nb[3]] : null;
    if (list.length) t.setList(SCOPE_LIST, list);
    if (enter.length) t.setList(ENTER_LIST, enter);
    // (round 128o, DA-B26: the surfaces re-peeled where the columns or the water changed since they were last peeled,
    // and re-linked round them: lists made on the GPU from the chunks' versions (sim/cull.ts ChangedTiles) — not an
    // eighth of the scope a tick in turn, round 107, whatever changed. A chunk come into the scope is peeled if it
    // changed while out of it, or was never peeled; the whole scope after the agents sat idle — nothing peeled meanwhile)
    const force = this.navStale && list.length > 0;
    if (force) this.navStale = false;
    sk.lists.build(enc, this.prof, list.length, force);
    sk.depths.build(enc, this.prof, list.length, false);
    // (confined: every chunk of the scope relaxed again. Round 107: a field left without seeds no longer is — it's set
    // unreachable over the scope (clearFields) with no marks, and its next seeds mark where it refills from)
    const marks = sc.markAll ? list : [...sc.marks].filter((c) => sc.box && list.includes(c));
    sc.marks.clear();
    sc.markAll = false;
    if (marks.length) t.setList(MARK_LIST, marks);
    const b = sc.box ?? [0, 0, 0, 0];
    this.device.queue.writeBuffer(this.abBuf, 0, new Uint32Array([b[0], b[1], b[2], b[3], 0, 0, 0, 0]));
    const read = !this.reading && this.ticks - this.lastRead >= READ_EVERY;
    if (read) this.device.queue.writeBuffer(this.uboxBuf, 0, new Uint32Array([0xffffffff, 0xffffffff, 0, 0]));
    let pass = enc.beginComputePass({ label: 'agents', timestampWrites: this.prof.timestamps(PROF ? 'agents-in' : 'agents') });
    // (?agentprof=1: a timed pass a stage)
    const stage = (name: string) => {
      if (!PROF) return;
      pass.end();
      pass = enc.beginComputePass({ label: name, timestampWrites: this.prof.timestamps(name) });
    };
    const log: AgentTickLog | null = PROF ? { frame: this.prof.frameNo, tick: this.ticks, scope: list.length, enter: enter.length, marks: marks.length, peel: 0, units: this.count - this.free.length, fields: this.fieldIds.size, front: [] } : null;
    const n = list.length ? t.groups(SCOPE_LIST) : 0;
    // (U2 round 7: the fields' front walks the scope's chunks; owners let go since the last tick, theirs back)
    this.fields.setBox(b[2] > b[0] ? [b[0] / 16, b[1] / 16, b[2] / 16, b[3] / 16] : null);
    this.fields.encodeReleases(pass);
    if (enter.length) {
      pass.setBindGroup(0, sk.enterG);
      pass.setPipeline(sk.enter.pipeline);
      pass.dispatchWorkgroups(t.groups(ENTER_LIST));
      this.prof.dispatches++;
    }
    if (marks.length) {
      pass.setBindGroup(0, sk.markG);
      pass.setPipeline(sk.mark.pipeline);
      pass.dispatchWorkgroups(t.groups(MARK_LIST));
      this.prof.dispatches++;
    }
    if (n) {
      stage('agents-hunt');
      this.encodeSeeds(pass);
    }
    // (the obstacles JFA — the clearance line of sight reads — and, ?jfa=1/2, the targets JFA)
    if (n && this.jk && ((JFA && this.huntField !== null) || this.los || this.seenOnly)) {
      stage('agents-jfa');
      this.encodeJfa(pass, JFA && this.huntField !== null);
    }
    if (n) {
      // (the GPU's lists: nothing changed, no workgroups)
      stage('agents-peel');
      pass.setBindGroup(0, sk.peelG);
      pass.setPipeline(sk.surfaces.pipeline);
      sk.lists.changed.dispatch(pass);
      pass.setBindGroup(0, sk.linksG);
      pass.setPipeline(sk.links.pipeline);
      sk.lists.around.dispatch(pass);
      // (where only the water's depth moved: the top surfaces' water — after the peel, which writes it too)
      pass.setBindGroup(0, sk.waterG);
      pass.setPipeline(sk.water.pipeline);
      sk.depths.changed.dispatch(pass);
      this.prof.dispatches += 3;
      if (this.fieldIds.size > 0 && !this.benchFrozen) {
        stage('agents-relax');
        const sweeps = this.frameSweeps();
        for (let i = 0; i < sweeps; i++) {
          this.encodeRelax(pass, 1);
          if (log && i < 8) {
            pass.end();
            enc.copyBufferToBuffer(this.fields.args, 0, this.probe(), i * 4, 4);
            pass = enc.beginComputePass({ label: 'agents-relax', timestampWrites: this.prof.timestamps('agents-relax') });
          }
        }
      }
    }
    if (this.count > 0 || this.flights.length > 0) {
      stage('agents-units');
      if (n) {
        pass.setBindGroup(0, sk.occG);
        pass.setPipeline(sk.occ.pipeline);
        pass.dispatchWorkgroups(n);
        this.prof.dispatches++;
      }
      pass = this.encodeUnits(pass, PROF ? (name) => (stage(name), pass) : undefined);
      if (read && this.count > 0) {
        pass.setBindGroup(0, sk.boxG);
        pass.setPipeline(sk.box.pipeline);
        pass.dispatchWorkgroups(Math.ceil(this.count / 64));
        this.prof.dispatches++;
      }
    }
    pass.end();
    if (log) {
      // (the peel's list's count: its args' workgroups, 4 a chunk)
      if (n) enc.copyBufferToBuffer(sk.lists.changed.args, 0, this.probe(), 64, 4);
      this.probeLog(enc, log, this.fieldIds.size > 0 && n ? Math.min(this.frameSweeps(), 8) : 0, n > 0);
    }
    if (read) {
      enc.copyBufferToBuffer(this.uboxBuf, 0, this.readBuf, 0, 16);
      // (U2 round 7: the field pages refused, with it — the pool full is an error shown, and orders fail 'pool-full')
      enc.copyBufferToBuffer(this.fields.buffer, PP_HEADER.refused * 4, this.readBuf, 16, 4);
      // (U2-FIELDCAP: the seed list's puts it had no room for — SEED_LIST is sized to every seeder: one is a sizing bug)
      enc.copyBufferToBuffer(this.seedList, 12, this.readBuf, 20, 4);
      this.reading = true;
      this.readIssued = { serial: sc.serial };
      sc.serial++;
      this.lastRead = this.ticks;
    }
  }

  // ---- (round 107, agentspike) ?agentprof=1 ----
  private probeBuf?: GPUBuffer;
  private probeStage: GPUBuffer[] = [];
  private probePending: { buf: GPUBuffer; log: AgentTickLog; n: number; peeled: boolean }[] = [];
  private probe(): GPUBuffer {
    return (this.probeBuf ??= this.device.createBuffer({ label: 'agentProbe', size: 80, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }));
  }
  /** `n` sweeps' fronts to read, `peeled` the peel's count too (word 16) */
  private probeLog(enc: GPUCommandEncoder, log: AgentTickLog, n: number, peeled: boolean): void {
    const w = window as unknown as { __agentLog?: AgentTickLog[] };
    (w.__agentLog ??= []).push(log);
    if (w.__agentLog.length > 20000) w.__agentLog.splice(0, 10000);
    const buf = this.probeStage.pop() ?? this.device.createBuffer({ label: 'agentProbeRead', size: 80 + 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(this.probe(), 0, buf, 0, 80);
    // (FC11: what asked this tick, by field; the hunt's seeds new and gone — then cleared for the next)
    enc.copyBufferToBuffer(this.frontDbg, 0, buf, 80, 256);
    enc.clearBuffer(this.frontDbg);
    this.probePending.push({ buf, log, n, peeled });
  }

  /** (simscale) after the tick's submit: the read issued in it mapped */
  afterSubmit(): void {
    for (const q of this.probePending.splice(0))
      q.buf.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(q.buf.getMappedRange().slice(0));
        q.buf.unmap();
        for (let i = 0; i < q.n; i++) q.log.front.push(u[i]);
        if (q.peeled) q.log.peel = u[16] / 4;
        q.log.seedsNew = u[52];
        q.log.seedsGone = u[53];
        // (?jfa=1/2: the targets JFA ran, the obstacles JFA ran, the ground each round resolved, the ground in scope)
        q.log.jfaRuns = u[54];
        q.log.obsRuns = u[55];
        q.log.resolved = [...u.slice(56, 64)];
        q.log.ground = u[64];
        this.probeStage.push(q.buf);
      }, ignoreTeardown);
    const r = this.readIssued;
    if (!r || !this.scope) return;
    this.readIssued = null;
    const sc = this.scope;
    this.readBuf.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(this.readBuf.getMappedRange().slice(0));
      this.readBuf.unmap();
      this.reading = false;
      const box: [number, number, number, number] | null = u[0] <= u[2] && u[1] <= u[3] ? [u[0], u[1], u[2], u[3]] : null;
      sc.read(r.serial, box);
      if (u[4] > this.fieldPagesRefused) this.fieldPoolFull(u[4]);
      if (u[5] > this.seedsDropped) {
        const first = this.seedsDropped === 0;
        this.seedsDropped = u[5];
        const msg = `agents: the fields' seed list overflowed (${u[5]} puts past ${SEED_LIST}) — fields lose seeds; SEED_LIST is sized to every seeder, so this is a sizing bug`;
        if (first && typeof document !== 'undefined') showFatal(msg);
        else if (first) console.error(msg);
      }
    }, (e) => {
      this.reading = false;
      ignoreTeardown(e);
    });
  }
}
