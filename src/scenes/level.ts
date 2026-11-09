// The playable valley: world + diegetic powers + HUD + level goal.
// (2026-11-04, the monolith split) LevelScene holds the level's state and its lifecycle (create, resize, frame,
// dispose, the test hooks scripts call); what it does lives in scenes/level/*.ts as functions over the scene (the map:
// docs/MODULES.md). Its fields are those modules' shared state: code outside scenes/level/ uses the lifecycle only.

import { TerrainSystem } from '../terrain/terrain';
import type { Ambience } from '../audio/ambience';
import { Nature } from '../game/nature';
import { ValleyReads } from './level/valley-reads';
import { CAP_FPS } from './frame-cap';
import { Powers } from '../game/powers';
import { Director } from '../game/director';
import { Reach } from '../game/reach';
import { levelById, type LevelDef, type LoadedLand } from '../game/levels';
import { windowHolding } from './streamer/keep';
import { DIFFICULTY_LEVEL, loadDifficulty, type Difficulty } from '../game/progress';
import { Editor } from '../ui/editor';
import { Controls } from '../input/controls';
import { ignoreTeardown } from '../gpu/pipeline';
import { Physics } from '../physics/physics';
import type { LavaSystem } from '../sim/lava';
import type { InhabitantsGpu } from '../inhabitants/system';
import { Settlements } from '../settle/settlements';
import { TownDebug } from '../settle/debug';
import type { RouteDebug } from '../fortress/routedebug';
import type { TownRoutes } from '../fortress/townroutes';
import { AgentUnits } from '../units/agent-units';
import type { TraitSystem } from '../traits/system';
import { TraitStation } from '../levels/traitstation';
import type { Agents } from '../agents/agents';
import { type Sim } from '../api/world';
import { type Block } from '../build/town';
import type { BuildCrew } from '../agents/buildcrew';
import { type Waker } from '../physics/wake';
import { Hud } from '../ui/hud';
import type { PerfOverlay } from '../ui/perf-overlay';
import { WorldCore, type Host, type Scene } from './world-core';
import { Streamer, REGION, TIER, type WorldSave } from './streamer';
import { Atlas, atlasParamsFrom, type AtlasParams } from '../atlas/atlas';
import { FarLand } from '../atlas/far';
import type { MapData } from '../world/mapgen';
import { Sleep } from '../sim/sleep';
import { RiverWet } from '../weather/riverwet';
import { CatchmentWet } from '../weather/catchwet';
import { RiverWetField } from '../weather/wetfield';
import { riverMode, useRivers } from '../sim/world-gpu';
import { installFlow, type FlowKit } from '../flow/install';
import { TunePanel } from '../ui/tunepanel';
import { BugReport } from '../ui/bugreport';
import { StationsBar } from '../ui/stations';
import { NoiseLabControl } from '../noiselab/control';
import { AtlasMap } from '../api/atlas-map';
import { Dither, Orbit, Slice } from '../api/cutaway';
import { Puck } from '../api/puck';
import { StoryPlay } from '../story/play';
import type { HeroRun } from '../story/hero-run';
import { cpuStats } from '../gpu/cpustat';
import { type Interval, CHUNK, windowZMax } from '../world/layout';
import { Integrity, type Grab } from '../game/integrity';
import { cellAt, cellPos, ROW_H } from '../world/lattice';
import { HybridChunks } from './hybrid';
import { atlasRange, atlasRows } from './range';
import { Turn } from '../render/turn';
import { Compass } from '../ui/compass';
import { bootMark } from '../perf/boot-marks';
import { beginPipelineBatch, endPipelineBatch } from '../gpu/pipeline';
import { captureWorld, loadSnapshot, saveSnapshot } from '../sim/snapshot';
import { loadWarm, saveWarm, warmKey } from '../sim/warm-cache';
import { StreamPlanner } from './planner';
import { SettlementsView } from '../settle/view';
import { ShipsView } from '../settle/shipsview';
import { Fortress } from '../fortress/fortress';
import { FortressBar } from '../fortress/ui';
import type { FortressFollow } from '../fortress/follow';
import { FortressCrowd } from '../fortress/crowd';
import type { FortressRaid } from '../fortress/raiders';
import { StaticClaims } from '../sim/static-claims';
import type { GridStyle } from '../api/contracts/settlement';
import type { CitySpec } from '../api/contracts/structures';
import { editTool } from './level/sandbox-tools';
import { NON_METAL, SANDBOX_K, ATLAS_COL_K, WARMUP_TICKS } from './level/flags';
import { attach } from './level/attach';
import { levelFrame } from './level/frame';
import { labStationKit } from './level/labs';
import type { StationKit } from '../levels/playground';
import type { Lab } from '../lab/lab';
import { urlFlags } from '../flags';

export interface LevelOptions {
  /** play this map instead of generating the level's (a loaded sandbox map) */
  map?: MapData;
  /** a story level played freely (the old rules: green grows anywhere, no reach) */
  free?: boolean;
  /** sandbox: restart with a loaded map, or a fresh one (undefined) */
  onLoadMap?: (map: MapData | undefined) => void;
  /** (create's: land the level loaded — LevelDef.load, the lab's town fixture) */
  made?: LoadedLand;
  /** (create's, for an atlas level: the atlas, the window it made, and where that window is) */
  atlas?: { atlas: Atlas; map: MapData; origin: [number, number]; oz: number; outside: Interval[][]; ground: Float32Array; settlements?: Settlements; startTown?: string };
}

/**
 * (round 100) The world the store keeps: the atlas's seed; `?world=new` clears it first, `?world=<name>` another of
 * the same seed; `?worldsave=0` keeps this session's changes in memory only.
 * (Round 114, `worldstore`.) And what else decides the land besides the generator's code (GEN_VERSION, in each
 * record): the atlas's other parameters (`?a.*`), the river mode and whether land comes in settled — `~<hash>`, so a
 * world made with other options is another world, not loaded into this one. A run (`?run=<story>`) is its own world,
 * one per run: `@<instance>` (`?runinst=` names one, else each page load starts a new run — a run can't be resumed
 * after a reload, its story starts again, so its places are made again from the seed the first time they're visited
 * and keep their changes for the rest of the run). Earlier runs' records on this seed are dropped when a run opens.
 */
export function worldSaveOf(params: URLSearchParams, p: AtlasParams, gen: { rivers: string; settle: boolean }): WorldSave {
  const w = params.get('world');
  const run = params.get('run');
  const name = w && w !== 'new' ? `:${w}` : '';
  const { seed, ...rest } = p;
  const opts = JSON.stringify([Object.keys(rest).sort().map((k) => [k, rest[k as keyof typeof rest]]), gen.rivers, gen.settle]);
  let h = 0x811c9dc5;
  for (let i = 0; i < opts.length; i++) h = Math.imul(h ^ opts.charCodeAt(i), 0x01000193) >>> 0;
  const base = `atlas:${seed}~${h.toString(16).padStart(8, '0')}`;
  const inst = params.get('runinst') ?? `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  return {
    world: `${base}${run ? `:run=${run}@${inst}` : ''}${name}`,
    disk: params.get('worldsave') !== '0',
    fresh: w === 'new',
    endedRuns: run ? `${base}:run=` : undefined,
  };
}

export class LevelScene implements Scene {
  readonly core: WorldCore;
  nature = new Nature();
  powers!: Powers;
  hud!: Hud;
  controls!: Controls;
  abort = new AbortController();
  keys = new Set<string>();
  lensOn = false;
  lensK = 0;
  hoverWorld: [number, number] | null = null;
  /** Town tool, plan mode: the building crew and its workers (sendBuilders) */
  buildCrew?: BuildCrew;
  /** Town tool: the plan's outlines (drawPlan) */
  planAdd?: SVGPathElement;
  planDel?: SVGPathElement;
  builders?: number[];
  /** Town tool: the block under the cursor (pickTown) */
  townHover?: Block;
  townPicking = false;
  renderW = 1;
  renderH = 1;
  initialContam = 0;
  lastCollapsed = -1;
  nextGroan = 20;
  life = 0;
  reclaimed = 0;
  /** (round 84) the rivers' wetness (weather/riverwet.ts) */
  riverWet = new RiverWet();
  /** (merge124) the regions' rivers' inflow factors the run's world set (a card's drought or diversion: WorldState's
   *  `river-inflow`), realised in the river-wetness field where the player looks */
  riverInflow = new Map<number, number>();
  /** (round 109) the atlas level's: each watershed's storm water (weather/catchwet.ts), its field over the window
   *  (weather/wetfield.ts), and the window's origin they were fitted to */
  catchWet?: CatchmentWet;
  wetField?: RiverWetField;
  catchAt = '';
  /** (round 84, ?settletol) when the water's change per chunk was last read, and whether a read is in flight */

  completed = false;
  saveTimer = 0;
  speed: number;
  fps = 60;
 /** sleep and wake (round 80, sim/sleep.ts): the atlas level's; ?sleep=0 off */
  sleep?: Sleep;
  /** (?flow=1, docs/ARCHITECTURE.md "The flow model") the flow model: liquids as runs, steady state freezing */
  flow?: FlowKit & { lab?: { breach: (spring?: number) => void } };
  /** (round 114, framepace) frames the sim was held, by why (stream-slide, stream-warp, …, skip) */
  readonly simHeld: Record<string, number> = {};
  noSim = (urlFlags().get('skip') ?? '').split(',').includes('sim');
  /** ?ceiling=1 (the perf ceiling, the atlas level): each frame only the camera (the drive) and the heightfield —
   *  far.ts's rings (?near=1: a ring a cell apart first, the default; 2: the usual four) and the far land; no sim,
   *  no streaming, no mesh, no prep, no shadow, no HUD or audio. The window is still built at the start. */
  ceiling = urlFlags().get('ceiling') === '1';
  /** ?hybrid=1 (the atlas level): voxels only where they're needed — the field mesh, the band and the sim's
   *  chunks where the land isn't a heightfield, near the focus, or edited; the LOD rings (a 1-cell ring first)
   *  draw the rest of the window's land (scenes/hybrid.ts). ?vradius= the focus's radius (world units; round 100: 0, none — 40 before). */
  hybridOn = urlFlags().get('hybrid') === '1';
  /** (round 113, tilesfirst) the streaming planner (scenes/planner.ts): made once the streamed window and its tiles are */
  planner?: StreamPlanner;

  hybrid?: HybridChunks;
  ticksAvg = 1;
  /** the last frames' times (ms) and every hitch (a frame over 50 ms) since the level began: the phone's profile (round 79) */
  frameMs: number[] = [];
  hitches = 0;
  /** the long frames and what ran in each (round 80) */
  longFrames: string[] = [];
  worstMs = 0;
  /** ?drive=speed (round 79): the camera drives itself along the atlas's nearest road at that many cells a
   *  second, zooming out with speed as the hoverbike's does — a stand-in for riding, to profile on a phone */
  drive?: { speed: number; path: [number, number][]; s: number; dir: number; zoom: number };
  /**
   * (round 98) ?pan=speed[,deg]: the camera pans itself in a straight line at that many cells a second — up the screen,
   * or `deg` (world, 0 along +x, 90 along +y) — at the view's own zoom; ?panturn=s,deg turns it by deg over a second
   * after s seconds. Like a held pan it waits at the window's edge clamp when the slides don't keep up
   * (scripts/speedsweep.mjs measures how far it got against how far it was asked to go). The phone's way to try a speed.
   */
  pan?: { speed: number; dir: [number, number]; t: number; turnAt: number; turnBy: number; turned: number; asked: number };
  /**
   * (round 128o, DA-B5) the sandbox valley's timed reads: the wind for its storms, the counters for its Nature, veg and
   * water for its ambience (level/valley-reads.ts). Null in fortress play: startFortress drops it.
   */
  valleyReads: ValleyReads | null;
  nextFlock = 12;
  director!: Director;
  /** the first-play intro is running (camera directed, weather held back) */
  intro = false;

  /** story rules (round 30): green spreads only by seeds; the player works within its reach */
  story = false;
  reach?: Reach;
  reachRefresh = 0;
  reachBusy = false;

  /** sandbox only */
  editor?: Editor;
  /** brush currently being dragged (sandbox) */
  brushAt?: [number, number];
  /** the next brush event starts a new press (layer tools: a fresh layer) */
  strokeStart = false;
  /** sandbox: physics voxels (docs/PHYSICS.md) */
  physics?: Physics;
  /** the agents layer (docs/AGENTS.md): units walking the surfaces by shared fields */
  agents!: Agents;
  /** (round 117, ?life=: src/inhabitants) creatures with bodies — the Inhabitants contract */
  inhabitants?: InhabitantsGpu;
  /** (LW1) the trait system on the agents, with the game's rules (src/game/traits) */
  traits!: TraitSystem;
  traitStation?: TraitStation;
  lifeSpawned = false;
  /**
   * (round 128o, DA-B19) The window's ground is read (the fortress's: read whole when it starts and after each slide —
   * scenes/level/fortress.ts): false between a slide and its read, when the fortress's people, raiders, pieces and taps
   * wait (they ask the ground anywhere in the window: scene.groundRead).
   */
  groundReady = true;
  /** (round 88, the atlas level) the settlements, and the units (the Units contract on the agents) */
  settlements?: Settlements;
  units?: AgentUnits;
  townDebug?: TownDebug;
  /** (?routedebug=1) the fortress town's edge network: what isn't walkable and why (fortress/routedebug.ts) */
  routeDebug?: RouteDebug;
  /** (DA-A22) the fortress town's route network on the GPU (fortress/townroutes.ts) */
  townRoutes?: TownRoutes;
  /** (fortress slice 1, ?fortress=1 with ?town=) the town held as the player's fortress, and its planning bar */
  fortress?: Fortress;
  fortressBar?: FortressBar;
  /** (fortress slice 1, milestone 2) its builders, from the first Build */
  fortressCrowd?: FortressCrowd;
  /** (round 128l, m4) the attack wave on the fortress (fortress/raiders.ts), from the first Build */
  fortressRaid?: FortressRaid;
  fortressBarAt = 0;
  /** (round 128e, FT-50) Skip to done running; how long (sim s) it has found the plan blocked; the speed to go back to */
  fortressSkip = false;
  fortressSkipBlocked = 0;
  fortressRunSpeed = 1;
  /** (round 128d) its built blocks claimed in the columns: the agents, the water and the ground go round them */
  /** (round 128j) the static grids' claims (the towns', the fortress's), written with the land (sim/static-claims.ts) */
  statics?: StaticClaims;
  /** (round 128f) read the window's columns again for the fortress's reach check (fortress/reach.ts) */
  fortressReadCols?: () => void;
  /** (round 128l, m4; V128-10) the person a tap picked, and whether the camera follows them (fortress/follow.ts) */
  fortressFollow?: FortressFollow;
  /** (round 128o, B) the town's places joined by the one reach when its land came in: still out, fixes made, asks */
  fortressJoined?: { out: number; fixes: number; asks: number };
  /** (round 128m, quarry) the near walls of a pit looked into dithered out round its floor (fortress.ts pitView) */
  fortressPitCut?: import('../api/cutaway').Dither;
  /** (round 128m) the pit's cut on (?pitcut=1; off by default — scripts toggle it to compare) */
  pitCut?: boolean;
  /** the world as modules (docs/WORLD_API.md), made on first use of reclaimed.world */
  worldApi?: Sim;
  /** round 83, V21: ?cutaway (api/puck.ts, api/cutaway.ts) */
  cutaway?: { puck: Puck; slice: Slice; orbit: Orbit; dither: Dither };
  /** a stand-in character's feet kept seen (Dither) for ?cutaway (scripts/cutshot.mjs); none when unset */
  cutFeet?: [number, number, number];
  /** round 83 (dialog): ?story=demo — a SessionStory played here (story/play.ts: the run, dialog, story cameras) */
  storyPlay?: StoryPlay;
  /** the story's own dither and slice when ?cutaway isn't on (speakers kept seen) */
  storyCut?: { dither: Dither; slice: Slice };
  /** round 88 (runstory): ?run=bell on the atlas level — a run story played as a hero (story/hero-run.ts) */
  heroRun?: HeroRun;
  /** round 117 (play): ?play=hoverbike|lich on the atlas level — the play layer's sandbox (src/play: heroes, controllers, controls) */
  play?: import('../play/sandbox/sandbox').PlaySandbox;
  /** the landform brush's stroke (range, mesa; round 64) */
  raising?: import('../api/terrain').RaiseStroke;
  /** molten rock: the beam melts the ground into it, vents pour it (sim/lava.ts) */
  lava?: LavaSystem;
  /** sandbox: the heat beam's pointer while held */
  beamAt?: [number, number];
  /** (round 120) the drag tool's hold: the body, the height it's held at, where the pointer is (CSS px) */
  dragHold?: { g: Grab; h: number; at: [number, number] };
  beamWoke = -Infinity;
  beamLine?: SVGLineElement;
  beamDot?: SVGCircleElement;
  beamPicking = false;
  /** sandbox: structural integrity and falling pieces (F7) */
  integrity?: Integrity;
  /** (round 117, structures: ?city=) the structures track's city on the window's ground */
  settlementsView?: SettlementsView;
  shipsView?: ShipsView;
  /** (round 108, AR5/AR8) the tuning panel, the bug report, the playground's stations */
  tunePanel?: TunePanel;
  bugReport?: BugReport;
  stationsBar?: StationsBar;
  /** (solver step 2, the experiment) the station and button last pressed: what "compare" plays again */
  lastRun: string | null = null;
  /** (round 111, TG1) the noise lab's recipe, its panel and its runs (level.noiseLab) */
  noiseLab?: NoiseLabControl;
  /** sandbox: a smash drag in progress */
  smashing = false;
  /** (round 83) flying: a drag turns the view — where the pointer was */
  flyDrag?: [number, number];
  /** sandbox: the brush's footprint drawn on the ground under the cursor */
  ring?: SVGPolylineElement;
  /** Break tool: the sphere's equator (the ring is its outline) */
  ring2?: SVGPolylineElement;
  /** Break tool: the voxel under the cursor (x, y, z: the sphere's centre, as smashAt aims) */
  smashHover?: [number, number, number];
  smashPicking = false;
  /** the streamed world (level.stream, round 66): the window slides with the camera */
  stream?: Streamer;
  /** meteors in flight (round 48): from the sky to where they'll hit, t seconds of dur */
  meteors: { from: [number, number, number]; to: [number, number, number]; t: number; dur: number }[] = [];

  private constructor(
    public host: Host,
    public audio: Ambience,
    public perf: PerfOverlay,
    readonly level: LevelDef,
    public onExit: () => void,
    public opts: LevelOptions,
  ) {
    const dims = { w: level.side ?? 256, h: level.side ?? 256, zMax: level.zMax ?? 64 };
    if (!level.generate) throw new Error(`level "${level.id}" is not built yet`);
    this.core = new WorldCore(host, opts.map ?? opts.atlas?.map ?? opts.made?.map ?? level.generate(dims), host.quality.particles, level.sandbox ? SANDBOX_K : undefined, true, level.meshRoom);
    // (?flow=1, docs/ARCHITECTURE.md "The flow model") liquids as runs in the columns, and what's near steady sleeps: before the warmup
    // (round 110: an opt-in for the flow model's own lab only — every other level runs the game's water)
    if (host.params.get('flow') === '1') {
      if (!level.flowSetup) throw new Error(`?flow=1: the flow model runs in its own lab only (level=flowlab), not "${level.id}"`);
      this.sleep = new Sleep(dims.w / CHUNK, dims.h / CHUNK, this.core.ring);
      this.sleep.settleAll(Sleep.SETTLE_S, performance.now() / 1000);
      this.core.sleep = this.sleep;
      const kit = installFlow(this.core, this.sleep);
      this.flow = { ...kit, lab: level.flowSetup?.(kit) };
    }
    // (grids, the rendering branch, opens in free play; ?mode=story for the story's rules)
    this.story = !!level.story && !opts.free && host.params.get('mode') === 'story';
    this.core.globals.story = this.story;
    // (round 79) the sea past a streamed window's edge, from the start (the warmup drained it otherwise)
    // (round 108, simtiers — DECISIONS round 108: in the legacy game's play rain and wind erosion and vegetation
    // growth are baked, run between runs or on a story event: core.tiers.bake; the game asks for them live: tiers.live)
    if (opts.atlas) this.core.tiers.playDefaults();
    if (opts.atlas) this.core.globals.seaZ = opts.atlas.atlas.p.sea - opts.atlas.oz;
    this.speed = Math.max(1, Number(host.params.get('speed') ?? 1));
    const dq = host.params.get('difficulty');
    const diff: Difficulty = dq === 'easy' || dq === 'medium' || dq === 'hard' ? dq : loadDifficulty();
    this.core.globals.difficulty = DIFFICULTY_LEVEL[diff];
    const p = host.params;
    if (p.get('day')) this.core.dayNight.dayLength = Math.max(10, Number(p.get('day')));
    if (p.get('tod')) this.core.dayNight.timeOfDay = Number(p.get('tod')) % 1;
    // the season (round 51): ?season=0..1 (0.5: autumn colours, 0.65: leaves falling), ?year=<s> to let it turn
    if (p.get('season')) this.core.globals.season = Number(p.get('season')) % 1;
    if (p.get('year')) this.core.yearLength = Math.max(10, Number(p.get('year')));
    this.core.camera.target = [dims.w * 0.55, dims.h * ROW_H * 0.5, 14];
    if (opts.atlas) {
      // (the atlas's land stands higher: look at the ground in the middle)
      const c = this.core.ring.i(dims.w / 2, dims.h / 2);
      this.core.camera.target = [dims.w / 2, dims.h * ROW_H * 0.5, this.core.map.surface[c]];
      // the atlas's climate before the world settles (warmed at the default, its snow melted and froze to sheets)
      this.core.globals.climate = opts.atlas.atlas.climateAt(opts.atlas.origin[0] + dims.w / 2, opts.atlas.origin[1] + dims.h / 2, opts.atlas.oz);
    }
    // (round 106, frameprobe: on the window's ring, as map.surface — column (x, y) at core.ring.i(x, y); a slide moves
    // nothing. So are the veg and water caches: read back in the ring's order, not rotated)
    this.valleyReads = new ValleyReads({
      core: this.core,
      smokeDispersed: (n) => this.nature.smokeDispersed(n),
      grimeWashed: (n) => {
        this.nature.grimeWashed(n);
        this.audio.wash(n);
      },
    });
  }

  worldEvents: Promise<void> = Promise.resolve();
  /** the geysers in the window (Atlas.geysersIn: found again when the window moves), the time, which are going */
  geysers: import('../atlas/atlas').Geyser[] = [];
  geysersAt = '';
  geyserT = 0;
  geyserOn = new Set<number>();

  atlasCtl?: HTMLDivElement;
  /** (round 91: scripts/mapnames.mjs reads its labelStats) */
  atlasMap?: AtlasMap;
  /** (round 117, runplan) ?runplan=<hero>: a planned run travelled on the atlas map */
  plannedRun?: import('../runplan/level-run').LevelRun;
  terrainSys?: TerrainSystem;
  /** (round 119, runplay) a planned run's hero and its stage player */
  runSession?: import('../play/session').PlaySession;
  runPlayer?: import('../runplay/player').RunPlayer;
  /** (round 120, runsit) ?runplan=<hero>: the situation run */
  situationRun?: import('../runsit/level-sit').LevelSit;
  far?: FarLand;

  /** (round 90) the player's turn of the view (render/turn.ts), when there is one: the atlas level's */
  turn?: Turn;
  turnCtl?: HTMLDivElement;
  /** (round 91) the compass over the turn buttons: the way the view faces; a tap faces north */
  compass?: Compass;

  coarseFrame = 0;

  /** (round 86) the last coarse event's window edit, read back, changed and written (ms): the latency probe reads it */
  editLiveMs = 0;
  /** (round 87) when the beam's bore was last judged (performance.now, ms) */
  beamCutAt = 0;

  /**
   * (round 128o, DA-B19) The ground's base at (x, y), which must have been read: what runs only once its ground is
   * (the fortress, read whole before it's ready; a structure placed once its footprint is). Not read is a bug there.
   */
  groundRead = (x: number, y: number): number => {
    const z = this.heightAt(x, y);
    if (z === null) throw new Error(`the ground at (${x.toFixed(1)}, ${y.toFixed(1)}) isn't read yet: its reader must wait for it (scene.heightAt)`);
    return z;
  };

  /** The free camera on (from where the fixed view looks from, the same way) or off (looking at the ground under the screen's middle). */
  toggleFly(): void {
    const { camera } = this.core;
    if (camera.fly) {
      const g = camera.groundAt(camera.viewportW / 2, camera.viewportH / 2, this.heightAt);
      // (round 128o: the ground there not read yet — its page asked: the toggle waits a frame)
      if (!g) return void requestAnimationFrame(() => this.toggleFly());
      // (round 90: the view turned the way the flyer looked, when the view turns — the atlas level's)
      if (this.turn) camera.azimuth = camera.fly.yaw + Math.PI;
      camera.fly = null;
      camera.target = [g[0], g[1], g[2]];
      this.editor?.setVisible(true);
      this.hud.say('Fixed view', 2);
      return;
    }
    const [tx, ty, tz] = camera.target;
    const e = camera.eye;
    const d = Math.max(40, camera.viewportH / camera.zoom);
    camera.fly = { pos: [tx + e[0] * d, ty + e[1] * d, tz + e[2] * d], yaw: Math.atan2(-e[1], -e[0]), pitch: -Math.asin(e[2]), fov: (60 * Math.PI) / 180 };
    this.editor?.setVisible(false);
    this.hud.say('Free camera — WASD or ⇧⇩▲▼ to fly (Q/E down/up, Shift faster), drag to turn, wheel or pinch to move along the view; F or ✈ back', 6);
  }

  /** forget the steps so far (driveprofile: from when riding starts) */
  cpuReset(): void {
    cpuStats.clear();
  }

  /** the main thread's worst steps (round 80, for driveprofile) */
  cpuWorst(): Record<string, { max: number; n: number }> {
    return Object.fromEntries([...cpuStats.entries()].map(([k, v]) => [k, { max: +v.max.toFixed(1), n: v.n, mean: +(v.sum / Math.max(1, v.n)).toFixed(2) }]));
  }

  /** Builds the level and settles it (rivers, slopes) before returning. */
  static async create(host: Host, audio: Ambience, perf: PerfOverlay, levelId: string, onExit: () => void, opts: LevelOptions = {}): Promise<LevelScene> {
    const level = levelById(levelId);
    // (round 110) how its rivers are kept, before its atlas and its world are made: the atlas's and an authored river
    // table's held (sim/world-gpu.ts useRivers; world/rivertable.ts)
    useRivers(level.rivers);
    if (level.atlas && !opts.map) {
      // the world's atlas first (atlas/atlas.ts), then the window onto it where we start (?at=x,y cells, or its own spawn)
      // (round 69: the atlas was taller than the window, which slid in z; round 100: the window holds its whole
      // height and never slides in z — ?zwin=248 the sliding window as before, to compare)
      // (round 104, the bench's watchdog: how far a page's load got — src/perf/bench.ts)
      (globalThis as { __benchStage?: string }).__benchStage = 'building the atlas';
      const atlas = await Atlas.build(host.gpu.device, atlasParamsFrom(host.params));
      bootMark('atlas');
      (globalThis as { __benchStage?: string }).__benchStage = 'making the first window';
      const zMax = windowZMax(atlas.p.zTop, Number(host.params.get('zwin') ?? 0));
      // (round 88) the settlements' records, and their hook on the land, before the first window is made
      const settlements = host.params.get('towns') === '0' ? undefined : new Settlements(atlas);
      const at = host.params.get('at');
      // (?town=s12: start at that settlement; ?town=1 the nearest to the spawn)
      const town = host.params.get('town');
      let startTown: string | undefined;
      let [cx, cy] = at ? (at.split(',').map(Number) as [number, number]) : atlas.spawn();
      if (town && settlements) {
        const sp = atlas.spawn();
        // (the nearest town or city with a camp by it: workers and a raid to see)
        const camped = new Set(settlements.seeds.filter((x) => x.campId).map((x) => x.rec.id));
        const s = town === '1' ? settlements.near([sp[0], sp[1] * ROW_H], 1e9).find((x) => (x.size === 'town' || x.size === 'city') && camped.has(x.id)) : settlements.settlement(town);
        if (!s) throw new Error(`?town=${town}: no such settlement`);
        cx = Math.round(s.at[0]);
        cy = Math.round(s.at[1] / ROW_H);
        startTown = s.id;
      }
      // (round 117/119, structures: ?city=<tile system>&cstyle=&cseed= — every settlement is planned by the structures
      // system now; this starts at the town or city nearest the start and plans its town with that tile system / style)
      if (host.params.get('city') && settlements && !at) {
        const near = settlements.near([cx, cy * ROW_H], 1e9).find((x) => x.size === 'town' || x.size === 'city');
        if (near) {
          cx = Math.round(near.at[0]);
          cy = Math.round(near.at[1] / ROW_H);
          const q = host.params;
          const ov: Partial<CitySpec> = { system: q.get('city') as GridStyle };
          if (!['irregular', 'contour-voronoi', 'radial', 'orthogonal'].includes(ov.system!)) throw new Error(`?city= must be irregular, contour-voronoi, radial or orthogonal`);
          if (q.has('cstyle')) ov.style = q.get('cstyle') as CitySpec['style'];
          if (q.has('cseed')) ov.seed = Number(q.get('cseed'));
          if (q.has('croads')) ov.roads = Number(q.get('croads'));
          if (q.get('cwalls') === '1') ov.walls = true;
          // (round 120: ?cpurpose= — its town planned for that purpose, whatever the land made it)
          if (q.has('cpurpose')) ov.purpose = q.get('cpurpose') as CitySpec['purpose'];
          settlements.override(near.id, ov);
        }
      }
      // (?win=: a wider window, whole regions — round 79, the user: "stream in a few more blocks out to see
      // more of the terrain at a time … nice for debugging even if too slow for mobile")
      // (round 90: or the viewer's range setting, the phone tier's default wider — scenes/range.ts)
      // (round 128m townlab C; onetown: the window holds the fortress's town's site box — its grid, its reach, its claims —
      // from the start, and keeps it: startFortress asks the Streamer to keep it, scenes/streamer/keep.ts)
      const keepBox = host.params.get('fortress') === '1' && startTown ? settlements!.seeds.find((x) => x.rec.id === startTown)!.box : null;
      const W = Math.max(keepBox?.w ?? 0, atlasRange(host.params));
      // (round 93, ?winh=: an experiment — rows other than the side)
      const Hr = Math.max(keepBox?.h ?? 0, atlasRows(host.params, W));
      const near: [number, number] = [Math.round((cx - W / 2) / REGION) * REGION, Math.round((cy - Hr / 2) / REGION) * REGION];
      const origin: [number, number] = keepBox ? windowHolding({ x0: keepBox.x0, y0: keepBox.y0, x1: keepBox.x0 + keepBox.w, y1: keepBox.y0 + keepBox.h }, W, Hr, near) : near;
      const { map, oz, outside, ground } = await atlas.window({ w: W, h: Hr, zMax }, origin[0], origin[1], ATLAS_COL_K, TIER);
      // (round 80: its column batches timed in the perf overlay)
      bootMark('window');
      // (round 112: when the GPU has done all that's queued so far — the window's making, the pipelines asked for)
      void host.gpu.device.queue.onSubmittedWorkDone().then(() => bootMark('window-gpu'));
      atlas.profiler = host.profiler;
      // (round 102: the tile pacer's GPU budget by the timestamps, when they're read)
      atlas.pacer.profiler = host.profiler;
      opts = { ...opts, atlas: { atlas, map, origin, oz, outside, ground, settlements, startTown } };
    }
    // (round 128m, townlab) land the level loads instead of making (the lab's `town` fixture)
    if (!opts.map && level.load) {
      const made = await level.load(host.params);
      if (made) opts = { ...opts, made };
    }
    (globalThis as { __benchStage?: string }).__benchStage = 'making the level';
    // (round 112, testspeed: the pipelines its making asks for, compiled together off the GPU's main thread)
    beginPipelineBatch();
    const s = new LevelScene(host, audio, perf, level, onExit, opts);
    bootMark('level');
    void host.gpu.device.queue.onSubmittedWorkDone().then(() => bootMark('level-gpu'));
    // ecology excluded so nothing grows during settling; ground debris (dust,
    // litter, fallen leaves) accumulates fast so the level opens with it lying about.
    // A saved map was settled when it was saved: a short prime only.
    // (a streamed world: none — the strips that come in later get no such start)
    s.core.globals.debrisBoost = opts.map || level.stream ? 1 : 10;
    // (round 84, ?rivers=table: a streamed world's water comes in at the atlas's steady state — not run in the warmup,
    // where nothing is asleep yet and its rivers would run unheld)
    // (round 110: a fixed map's authored river table too — its rivers come in at their table)
    const still = riverMode() === 'table';
    // (round 112: the level's pipelines, asked for together while it was made, ready before its first tick — gpu/pipeline.ts)
    await endPipelineBatch();
    bootMark('pipelines');
    // (round 112, testspeed: ?warmsnap=<key> — the warmed world from the test runner's cache when it has it, else the
    // warmup and the result saved under the key; sim/snapshot.ts. The runner makes the key from the build and the URL.
    // The player's own (?warmcache=0 off), kept in the browser by build and settings — sim/warm-cache.ts; the same snapshot)
    const snapKey = host.params.get('warmsnap');
    const warmK = !snapKey && host.params.get('warmcache') !== '0' ? warmKey(host.params) : null;
    const snap = snapKey ? await loadSnapshot(snapKey) : warmK ? await loadWarm(warmK) : null;
    if (snapKey || warmK) bootMark(snap ? 'snap-loaded' : 'snap-missing');
    if (snap) await s.core.warmFrom(snap);
    else {
      await s.core.warmup(opts.map ? 30 : level.warmupTicks ?? WARMUP_TICKS, (sys) => sys.name !== 'ecology' && !(still && sys.name === 'water'));
      if (snapKey) void saveSnapshot(snapKey, captureWorld(s.core));
      else if (warmK) void saveWarm(warmK, captureWorld(s.core));
    }
    // (?flow=1) everything awake a moment after the warmup: the steady state then lets what's near steady
    // sleep (the generator's steady land frozen at once) and keeps what still flows unsteadily awake
    if (s.flow) {
      s.sleep?.wakeAll(1, performance.now() / 1000);
      s.flow.steady.judgeAll = true;
    }
    s.core.globals.debrisBoost = 1;
    // (round 108, the playground) what a station's reset puts back: the world as it opens
    if (level.stations) s.core.keepPristine();
    // (round 128l, tooling: the pipelines attach asks for — the agents, physics, the structures draw, ~60 at a level's
    // start — made together too: one at a time, at their first use, they held the first frames for 10-18 s)
    beginPipelineBatch();
    attach(s);
    await endPipelineBatch();
    bootMark('attach-pipelines');
    return s;
  }

  /**
   * The ground's base at (x, y) as the GPU has it (round 128o, DA-B19): the world API's terrain from the column's page
   * (api/terrain.ts surfaceAt: read when asked, again only after its chunk ran), (x, y) clamped to the window. Null:
   * not read yet — its page is asked for now; the caller waits for it (a tap, a turn, a placement retry next frame),
   * never a stand-in. Before, a copy of the whole surface read back every second.
   */
  heightAt = (x: number, y: number): number | null => {
    // (the window's columns only: past its edge, its edge's)
    const { w, h } = this.core.dims;
    const [cx, cy] = cellAt(x, y);
    const [px, py] = cellPos(Math.max(0, Math.min(w - 1, cx)), Math.max(0, Math.min(h - 1, cy)));
    return this.worldApi?.terrain?.surfaceAt(px, py)?.z ?? null;
  };

  /**
   * The map as generated at (x, y) (the CPU's map, kept by the streamer for each region that comes in) — not the
   * ground as it is: what was dug or built isn't in it. Only for the two that ask every frame and need the lie of the
   * land: the far land's focus and the flyer's floor (test/unit/mapheight.test.ts holds it to them). Clamped.
   */
  mapHeightAt = (x: number, y: number): number => {
    const { w, h } = this.core.dims;
    const [cx, cy] = cellAt(x, y);
    const ix = Math.max(0, Math.min(w - 1, cx));
    const iy = Math.max(0, Math.min(h - 1, cy));
    return this.core.map.surface[this.core.ring.i(ix, iy)];
  };

  /**
   * (round 120, runsit) ?runplan=<hero>: the run as a situation on the live map (src/runsit/level-sit.ts) — the GM's for
   * this world or the template's; its areas played by play's hero (the same PlaySession as the sandbox), the atlas map
   * and the ways on at each area's edge, the finale at the town, what's left of it remembered.
   */
  playRaising = false;

  resize(renderW: number, renderH: number, cssW: number, cssH: number): void {
    this.renderW = renderW;
    this.renderH = renderH;
    const first = this.core.camera.viewportW <= 1;
    this.core.resize(renderW, renderH, cssW, cssH);
    // open framed on the valley; portrait phones get closer than the width
    // alone would allow (the map is a diamond, its middle is what matters)
    // (a story level opens close on its green)
    if (first) this.core.camera.zoom = this.story ? 7 : (this.level.zoom ?? Math.max(1.5, Math.min(cssW * 1.9, cssH * 1.6) / 300));
    // (fortress: close enough on the town to tap a cell)
    if (first && this.fortress) this.core.camera.zoom = Math.max(this.core.camera.zoom, 6);
  }

  /**
   * Sandbox: if an editor tool is active, handle the press — a brush starts
   * painting (or paints once for a tap), a spawn tool places its weather.
   * Returns false for the normal hands.
   */
  editTool(wx: number, wy: number, tap: boolean): boolean {
    return editTool(this, wx, wy, tap);
  }

  /**
   * Sandbox: stamp the chosen model into the live world. Reads the layers
   * back, merges the model's runs into the footprint's columns on the CPU
   * (models.ts mergeColumn: it replaces what it overlaps) and writes those
   * columns back. Refused (nothing changes) if a column would need more slots
   * than its chunk has.
   */
  /** wakes take turns: each reads the layers the one before wrote */
  waker?: Waker;

  /**
   * The map's structures near a point come alive as physics bodies
   * (docs/PHYSICS.md; round 44: ruins stay terrain until something touches
   * them). Every structure cell within r of (x, y) (and of z, if z ≥ 0)
   * seeds a flood through the cells it touches (the 26 around); what it finds
   * leaves the layers, one body per connected piece, its voxels starting
   * where the cells stood (the hex rows half a cell apart: rest positions are
   * world positions). A cell resting on the ground is a foundation, pinned
   * until its bonds break; so is a cell at the edge of a piece cut off at
   * WAKE_MAX (it holds on to the rest, which stays terrain).
   */
  wake(x: number, y: number, z: number, r: number): Promise<void> {
    if (!this.waker) return Promise.resolve();
    // (round 120: the map's tankers and cars wake into the picked solver variant — ?solver= — like the metal the judge
    // frees; the rest of the ruin, concrete and brick, as before)
    const ig = this.integrity;
    const waker = this.waker;
    // (round 120, JB6: the metal found where the columns are read — the copy, or fetched — so it answers later)
    return (ig?.rigid ? ig.wakeMetalNear(x, y, z, r) : Promise.resolve(false))
      .then((metal) => waker.wake(x, y, z, r, metal ? { materials: NON_METAL } : undefined))
      .then(({ full }) => {
        if (full) this.hud.say('No room for more bodies.', 2);
      }, ignoreTeardown);
  }

  /** (round 128o, DA-B5; DESIGN.md §24) 30 fps while the player plans the fortress or the game is paused */
  maxFps(): number | null {
    return this.speed === 0 || this.fortress?.mode === 'plan' ? CAP_FPS : null;
  }

  frame(now: number, dt: number, driven = false): void {
    levelFrame(this, now, dt, driven);
  }

  /** (round 128l, tooling) the behaviour lab (?level=lab: src/lab/) — its town, its still window, its pieces' draw */
  lab?: Lab;

  /** the playground stations' kit (labs.ts; scripts drive it through window.reclaimed.scene) */
  stationKit(): StationKit {
    return labStationKit(this);
  }

  dispose(): void {
    this.abort.abort();
    this.tunePanel?.dispose();
    this.fortressBar?.dispose();
    this.townRoutes?.dispose();
    this.fortressRaid?.dispose();
    this.fortressCrowd?.dispose();
    this.statics?.dispose();
    this.bugReport?.dispose();
    this.stationsBar?.dispose();
    this.noiseLab?.dispose();
    this.atlasCtl?.remove();
    this.turnCtl?.remove();
    this.compass?.remove();
    this.far?.dispose();
    this.storyPlay?.dispose();
    this.heroRun?.dispose();
    this.play?.dispose();
    this.plannedRun?.dispose();
    this.situationRun?.dispose();
    this.runPlayer?.dispose();
    this.runSession?.dispose();
    this.worldApi?.dispose();
    this.controls.dispose();
    this.editor?.dispose();
    this.ring?.parentElement?.remove();
    this.hud.dispose();
    this.core.destroy();
    for (const el of this.host.ui.querySelectorAll('.complete')) el.remove();
  }
}

