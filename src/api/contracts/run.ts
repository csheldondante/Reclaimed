// A run — from setting out to its end, and what's left of it (round 83, docs/SYSTEMS.md system 11).

import type { AtlasEvent, FactionId, Mark, RegionId, RegionState } from './world';
import type { Outcome, SessionStory } from './story';
import type { AtlasRegionEdge, AtlasRegionNode, BarrierKind, FloodRequest } from './terrain';

export interface RunRecord {
  run: number;
  hero: string;
  story: string;
  /** how it ended ((round 117, runplan) 'captured' and 'late' — the user: "failure conditions like death or capture
   *  or just failure to meet a timeline"; 'lost' stays death or defeat) */
  end: 'won' | 'lost' | 'fled' | 'abandoned' | 'captured' | 'late';
  /** (round 117, runplan) the plan it followed (RunPlan.id) and the stages played, in order, with their outcomes */
  plan?: string;
  path?: { stage: string; outcome: string }[];
  /** what the player did that the world remembers (objectives done and failed, who they spared or killed) */
  deeds: string[];
  /** what it changed */
  events: AtlasEvent[];
}

/** Who's playing, as the GM reads them: the hero and what their past runs left (the GM's brief). */
export interface PlayerRecord {
  hero: string;
  /** past runs, newest last */
  runs: RunRecord[];
  /** standing with each faction (−1..1), from what they did */
  standing: Record<string, number>;
}

/** The run as the game drives it. */
export interface Run {
  readonly story: SessionStory;
  /** objectives shown, done, failed */
  objectives(): { id: string; state: 'hidden' | 'shown' | 'done' | 'failed' }[];
  /** something happened (a sim or unit event, a dialog choice, an item picked up): conditions checked */
  note(fact: import('./story').Condition): void;
  flag(name: string): boolean;
  /** does a condition hold now (the dialog asks it of a choice's `requires`) */
  holds(c: import('./story').Condition): boolean;
  /** the run's clock: `time` conditions, happenings (seconds) */
  update(dt: number): void;
  end(how: RunRecord['end']): RunRecord;
  onObjective: ((id: string, state: 'shown' | 'done' | 'failed') => void)[];
}

// =====================================================================================================================
// (round 117, runplan) Planned runs: a branching run on the region graph, fitted to the hero, travelled on the atlas
// map, and what its outcomes do to the world for the next run. docs/RUNPLAN.md; src/runplan/ implements it.
// The user (round 117, part 2): runs of "15-50 minutes with branching. Decisions should impact the world for the next
// run." Part 3: "the run manager should be able to get. The graph and request obstacles or otherwise request a
// certain number of exits"; "A fast bike need races and chases. A combat soldier needs fun fights. A force of nature
// needs spectacle and power fantasy."
// Why plain data: the planner is pure CPU logic over a few hundred regions (sub-millisecond to a few ms; measured in
// scripts/perf/runplan.mjs), deterministic from the seed, so a plan can be made in Node by the GM, saved, diffed and
// unit-tested; the GPU only sees its results (terrain requests, sections to keep resident).
// =====================================================================================================================

// (runplay, round 119 — the consolidation) What stands between two regions is terrain's BarrierKind (contracts/terrain.ts:
// cliff, steep, ravine, ridge, river, lake, sea, lava, vegetation, tar; the soft hostile, storm, distance), read off
// Terrain.atlasGraph(); runplan's own names (mountain, water, thicket, ice, dunes, hostiles) are gone.

/** What a stage of a run is about: the kinds of fun the planner fits to a hero. */
export type EncounterKind = 'race' | 'chase' | 'fight' | 'horde' | 'spectacle' | 'destruction' | 'delve' | 'talk' | 'explore' | 'rescue';

/**
 * The planner's view of a hero: per barrier between regions, what crossing it costs. DERIVED, never written by hand:
 * src/runplan/play-adapter.ts `capsFromProfile` reads play's ControllerProfile (contracts/play.ts, the one controller
 * description) through play's crossCost (runplay, round 119: the HEROES stand-in table is gone). Why a view of its own:
 * the planner reasons in barriers between atlas regions (a ravine, a cliff band, the sea) whose sizes the atlas graph
 * doesn't carry; play reasons in crossings of ground (so many cells of gap, of step, of water) — the adapter is the one
 * place the two meet.
 */
export interface HeroCapabilities {
  role: string;
  /** cruising speed, world units a second (the travel and stage-length estimates) */
  speed: number;
  /** what it gets past: 1 easily, >1 with effort (a cost multiplier on a crossing), 0 not at all */
  passes: Partial<Record<BarrierKind, number>>;
  /** what's fun for it (0..1 each; absent 0): the planner scores regions by these */
  likes: Partial<Record<EncounterKind, number>>;
  /** obstacles that are fun for it to cross (a ramp jump for a bike, a wall to smash for the lich) */
  funCrossings?: Partial<Record<BarrierKind, string>>;
}

/**
 * The region graph the run is planned on: terrain's (Terrain.atlasGraph(), contracts/terrain.ts AtlasRegionGraph —
 * runplay, round 119: runplan's guessed stand-in is gone) with what the run also needs of each region, joined at the
 * boundary (src/runplan/graph.ts runGraph): its name and settlements (the world wiki's), its stamps, and the road
 * crossings already on a border (the atlas's roads: a bridge, a pass).
 */
export interface RegionNode extends AtlasRegionNode {
  stamps: string[];
  /** settlement ids in it (settlement.ts) */
  settlements: string[];
  /** a name (the world wiki's) */
  name: string;
}

/** a border seen from region `a` (terrain's edges are unordered; these are turned to face out of the region asked) */
export interface RegionEdge extends AtlasRegionEdge {
  /** a crossing already there (a road's bridge, a pass): it makes the barrier easy for everyone */
  crossing: string | null;
}

export interface RegionGraph {
  readonly seed: number;
  /** world units (the torus) */
  readonly world: { w: number; h: number };
  node(id: RegionId): RegionNode | undefined;
  edges(id: RegionId): RegionEdge[];
  nodes(): Iterable<RegionNode>;
}

/**
 * What the run asks of terrain (the user's "request obstacles or otherwise request a certain number of exits"), in
 * the planner's terms: atlas regions. Terrain's own requests (contracts/terrain.ts TerrainRequest) are about the rooms
 * and borders of a stage's land (Terrain.graph(rect)), which only exist once the stage's rectangle is sampled — so the
 * plan keeps these, and src/runplan/requests.ts turns each into terrain's when a leg sets out for the stage (before its
 * land is made: the edits are stamped into it). Terrain may say no (TerrainResult.ok false); the run goes on.
 */
export type RunTerrainAsk =
  | { kind: 'obstacle'; a: RegionId; b: RegionId; barrier: BarrierKind; /** how this hero is meant to get past: a ramp, a cave, a bridge to build, a wall to smash */ passage: string; why: string }
  | { kind: 'exits'; region: RegionId; /** borders that must be passable for the hero, toward these neighbours */ toward: RegionId[]; /** the rest closed (a fully connected space with this many ways out) */ closeOthers: boolean };

/** A place the run stops to play (a story location's stand-in when no GM story is written for it). */
export interface RunStage {
  id: string;
  name: string;
  region: RegionId;
  /** world units */
  at: [number, number];
  encounter: EncounterKind;
  /** a line for the GM, the viewer and the region generator's brief */
  brief: string;
  /** minutes of play, estimated */
  minutes: number;
  /** the section kept resident on the GPU while the run can still come here (B-RC1): world units */
  section: { at: [number, number]; radius: number };
  /** what can come of it; the first is the hoped-for one */
  outcomes: StageOutcome[];
  /** legs out (RunPlan.legs ids): the player's choice of where next. None: a finale. */
  next: string[];
}

export interface StageOutcome {
  id: string;
  /** a line: what happened */
  text: string;
  /** how the run goes on: 'continue' (choose a leg out), or the run ends this way */
  ends: 'continue' | RunRecord['end'];
  /** what it changes in the world (story.ts Outcome: AtlasEvents, attitudes) and in characters */
  effects: Outcome & { characters?: CharacterChange[] };
}

/** Something on the road between stages: travel isn't dead time (the user: "events enroute and generate new poi
 *  along their path or fade between pretty views along the road and the map"). */
export interface EnRouteEvent {
  id: string;
  kind: 'vista' | 'poi' | 'ambush' | 'weather' | 'traveller';
  /** 0..1 along the leg */
  t: number;
  region: RegionId;
  /** world units */
  at: [number, number];
  text: string;
  /** a found place (poi): kept as a mark if the player stops (its effects) */
  effects?: Outcome & { characters?: CharacterChange[] };
}

export interface TravelLeg {
  id: string;
  from: string;
  to: string;
  /** the regions it passes through, in order (from's region first) */
  route: RegionId[];
  /** the line drawn on the map: world units */
  path: [number, number][];
  /** minutes of travel in the run's time (the clock), and the seconds the map animation takes at least */
  minutes: number;
  animSeconds: number;
  /** the borders crossed that need something of the hero */
  crossings: { a: RegionId; b: RegionId; barrier: BarrierKind; how: string }[];
  events: EnRouteEvent[];
}

/** What the GM decides happens when the run fails each way (the user: "Maybe the lich takes over the map"). */
export interface FailureRule {
  when: 'lost' | 'captured' | 'late';
  text: string;
  effects: Outcome & { characters?: CharacterChange[] };
}

export interface RunPlan {
  id: string;
  /** what it was planned from */
  from: { seed: number; worldVersion: number; run: number };
  hero: string;
  start: string;
  stages: RunStage[];
  legs: TravelLeg[];
  /** the run's clock: past this many minutes (the GM's timeline), 'late' fires */
  deadline: number;
  /** shortest and longest path from start to a finale, minutes (stages + travel) */
  minutes: { min: number; max: number };
  failures: FailureRule[];
  requests: RunTerrainAsk[];
  /** the planner's notes: why each choice (shown in the viewer, read by the GM) */
  notes: string[];
}

/** The run manager. */
export interface RunPlanner {
  plan(opts: { graph: RegionGraph; world: import('./world').WorldSnapshot; hero: HeroCapabilities; seed: number; from?: RegionId; minutes?: [number, number] }): RunPlan;
}

// ---- characters between runs (the user: "They should impact characters and their history, relationships and
// motivations. Potentially impact their gear or persistent statuses.") ---------------------------------------------

export interface CharacterRecord {
  id: string;
  name: string;
  role: string;
  faction: FactionId | null;
  /** true: a player hero (the roster); false: someone the world remembers */
  hero: boolean;
  alive: boolean;
  /** where they are now (their region) */
  region: RegionId | null;
  /** lines, newest last: what happened to them, run by run */
  history: { run: number; text: string }[];
  /** −1..1 toward other characters (and 'player' for an NPC's feeling toward the heroes) */
  relationships: Record<string, number>;
  motivation: string;
  gear: string[];
  /** lasting conditions: 'wounded', 'cursed', 'captive:f-hollow-court', 'famed' … */
  statuses: string[];
}

export type CharacterChange =
  | { kind: 'meet'; character: Omit<CharacterRecord, 'history' | 'relationships' | 'gear' | 'statuses'> & Partial<Pick<CharacterRecord, 'relationships' | 'gear' | 'statuses'>> }
  | { kind: 'history'; id: string; text: string }
  | { kind: 'relationship'; id: string; toward: string; delta: number }
  | { kind: 'motivation'; id: string; motivation: string }
  | { kind: 'gear'; id: string; add?: string[]; remove?: string[] }
  | { kind: 'status'; id: string; add?: string[]; remove?: string[] }
  | { kind: 'move'; id: string; region: RegionId | null }
  | { kind: 'die'; id: string; text: string };

// ---- consequences as the generators read them (the user: "Make it eternal night or flood a region and make a new
// shallow sea or bury a ruin under sand") ---------------------------------------------------------------------------

/**
 * A height-based flood fill is terrain's (Terrain.flood, contracts/terrain.ts FloodRequest: at, level, fluid) — the
 * user: "a GPU flood fill based on height would let us easily flood areas … We can flood with water, sand, magma etc."
 * A sunk region is a water fill (a new shallow sea), a buried one a sand or ash fill (a ruin under sand) — one tool for
 * all, which is why RegionState's sunk, buried and flooded all become this. The run adds which region asked and why.
 */
export type RegionFill = FloodRequest & { level: number; region: RegionId; why: string };

/**
 * RegionState converted at the boundary into what each generator needs (one concern each): terrain gets fills and
 * a freeze, structures get ruin and overgrowth, inhabitants get who lives there, flora and sky their own. The
 * generators' own contracts (terrain.ts, structures.ts, inhabitants.ts, flora.ts) take these when they land.
 */
export interface RegionRealisation {
  region: RegionId;
  terrain: { fills: RegionFill[]; frozen: number };
  structures: { ruin: number; overgrowth: number; /** cells of fill over the ground: what's half buried, drowned */ buriedBy: number; drowned: boolean; marks: Mark[] };
  inhabitants: { undead: number; presence: Partial<Record<FactionId, number>>; /** the player's welcome there: −1 hostile .. 1 */ welcome: number };
  flora: { overgrowth: number; frozen: number; shadow: number; wetness: number };
  sky: { shadow: number; storm: RegionState['storm'] };
}

// ---- (round 119, runplay) a stage played, not picked ----------------------------------------------------------------
// The user (round 119): "I need to actually play a generated run and try it out." The run (runplan/level-run.ts) hands
// each stage to a player (src/runplay/player.ts: play's hero in the level) and gets back which of the stage's planned
// outcomes the play picked. Why an interface here: the run manager decides what a stage means for the world; the
// player decides how it's played and won — neither reaches into the other.

/** a stage as it came out */
export interface PlayedStage {
  /** the planned outcome it picked (RunStage.outcomes id) */
  outcome: string;
  /** the run ends this way now (death, capture, a finale's end), or goes on (null) */
  runEnd: RunRecord['end'] | null;
  won: boolean;
  /** a line for the card: what the hero did */
  line: string;
  /** seconds played, and the par a good player takes (the run's clock) */
  seconds: number;
  par: number;
}

export interface StagePlayer {
  /** what the stage will be, for the card before it (its goal; a stand-in said so) */
  preview(stage: RunStage): { goal: string; note?: string };
  /** play it where the hero is */
  play(stage: RunStage): Promise<PlayedStage>;
  /** the hero waits (the run's card is up, the map is open) or plays on */
  hold(on: boolean): void;
  /** the hero set down where the camera is (after the map's warp) */
  arrived(): void;
}
