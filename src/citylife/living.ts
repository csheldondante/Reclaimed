// (living town, docs/design/LIVING_TOWN.md) A citygen town's people on the GPU: the route graph from its road raster,
// the hubs' fields relaxed with no readback, cached routes in a points pool, riders on kinematic trips with their jobs'
// state machine, drawn as voxel figures (routes.wgsl); the quarry and the clearing as world operations (works.wgsl).
// The CPU writes the parameters' uniform (counts, rates, the works' numbers, the grid's place in the window).
//
// Two parts (phone-idle, 2026-11-15: an indirect dispatch costs ~0.1 ms on the phone whether it does work or not):
// - every frame, one pass of direct dispatches: the gate's watch, the pool's switch, the trace of the route keys the
//   riders asked (over the queue's room, early-out), the riders, the works' stages, the figures — the city stays alive;
// - the graph (build, relax, connectivity check, wall work: indirect dispatches sized by the gate from the phase word)
//   only while awake: from a CPU-known event (made, `rebuild`, `wake`: the town's mesh run) until a small read of the
//   state words (gpu/settled.ts) says it is settled (`graphSettled`). Asleep, none of it is encoded.
// Wakes only the GPU knows (the works dig out a walked column, the clearing's camp is placed, a wall piece rises with
// the clock, the pool's halves switch under a wall's routes): the gate's watch says so in a state word and the same
// read, taken every WATCH_EVERY frames while such a wake can happen, hears it.
// Nothing else is read back but the debug panel's counters (`counters`, only while someone looks).
import routesWgsl from './routes.wgsl?raw';
import { figureWgsl } from '../render/palette';
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import { SettledRead } from '../gpu/settled';
import { LIVING_TUNING, type LivingValues } from './params';

/** routes.wgsl's LT layout: its words (to the wall's block's end: L_WALL + WL_WORDS), the counters' first word, the
 *  quarry's, the clearing's */
export const LT_WORDS = 53032 + 416;
export const L_C = 48;
export const L_Q = 96;
export const L_F = 128;
/** the head of LT the panel reads (the state words, the picks, the counters, the works' state) */
export const HEAD_WORDS = 160;
/** routes.wgsl counters (L_C + …) */
export const C = {
  dug: 0, face: 1, cartStone: 2, inbox: 3, deposited: 4, felled: 5, logCamp: 6, logCart: 7, logStores: 8, produce: 9,
  arrivals: 10, miss: 11, traced: 12, poolFull: 13, idle: 14, buildWork: 15, digBudget: 16, riding: 17, trees: 18,
  treeCur: 19, sites: 20, working: 21, logsCut: 22, regrown: 23,
  orphans: 24, passages: 25, rounds: 26, doorsCut: 27, cutLeft: 28, switches: 29, stale: 30,
} as const;
/** the points pool (vec4 a point) and the riders' room */
const PTS_ROOM = 262_144;
/** routes.wgsl ROUTES (ids, both halves) and routeread.wgsl's header words (the wall's table in them: the wall-walk
 *  entries at 16, routes.wgsl WW_ROOM of them; the gate entries after, GATE_SLOTS of them) */
const ROUTE_IDS = 8192;
export const ROUTE_HEAD_WORDS = 128;
const WW_AT = 16;
const WW_ROOM = 36;
const GATE_AT = WW_AT + 2 * WW_ROOM;
const GATE_SLOTS = 10;
/** the wall's state words (routes.wgsl L_WALL: … the reached pieces at + 5) */
const L_WALL = 53032;
export const MAX_RIDERS = 4096;
/** routes.wgsl RELAX_INNER: sweeps a relax dispatch makes */
const RELAX_INNER = 4;
/** routes.wgsl HASH / 64 and TQ_ROOM / 64: the hash's clearing's and the trace's direct dispatches (early-out) */
const HASH_GROUPS = 8192 / 64;
const TRACE_GROUPS = 2048 / 64;
/** routes.wgsl F_SOLVE: the graph's kernels are encoded this frame */
const F_SOLVE = 64;
/** the state words the settled read takes (the first SETTLED_WORDS of LT) and the ones it looks at (routes.wgsl L_*) */
const SETTLED_WORDS = 48;
const L_PHASE = 0;
const L_RELAXING = 8;
const L_GPH = 10;
const L_SWITCH = 14;
const L_WAKE = 40;
const L_WANT = 41;
/** asleep, frames between the reads that listen for a wake only the GPU knows (three a second at 60 fps) */
export const WATCH_EVERY = 20;

/**
 * Whether the graph has nothing more to do, from the state words' head as a frame left them: the phase is settled (4)
 * and was at the frame's gate (its snapshot), nothing relaxed this frame, no wake word waits (works.wgsl: a walked
 * column dug out), no pool switch is asked (the wall's routes follow one), and the gate found no work (L_WANT: the
 * wall's table, or — watching — anything at all).
 */
export function graphSettled(w: Uint32Array): boolean {
  return w[L_PHASE] === 4 && w[L_GPH] === 4 && w[L_RELAXING] === 0 && w[L_SWITCH] === 0 && w[L_WAKE] === 0 && w[L_WANT] === 0;
}

/** voxels a rider at most (figures: legs, torso, head, a cart and its load, a falling trunk) */
const VOX_PER = 14;
const NONE = 0xffffffff;

/** what the living town takes of a citygen town (its GPU buffers; nothing is copied) */
export interface LivingInput {
  /** the box: columns, rows */
  w: number;
  h: number;
  /** citygen's road raster (streets.wgsl markRoad), heights (world z), wet mask, population field, arterials */
  roads: GPUBuffer;
  heights: GPUBuffer;
  wet: GPUBuffer;
  /** (season life) the town wall's words (citygen streets.wgsl WALL; SL19's post check) */
  wall?: GPUBuffer;
  pop: GPUBuffer;
  art: GPUBuffer;
  /** the contract's lot records, counts and progress (api/contracts/citygen.ts; progress read only: the time-lapse's) */
  records: GPUBuffer;
  counts: GPUBuffer;
  progress: GPUBuffer;
  /** the lot room (citygen REC_LM) */
  lotRoom: number;
  /** the town's centre (the grid's world units) and radius */
  centre: readonly [number, number];
  radius: number;
}

/** where the grid is in the window this frame */
export interface LivingPlace {
  /** the grid's first column in the window (columns, rows: dy even) and window z less world z */
  dx: number;
  dy: number;
  dz: number;
  /** the window's columns and rows */
  winW: number;
  winH: number;
}

type K =
  | 'gate' | 'walkInit' | 'doors' | 'pads' | 'lotMask' | 'hubPick' | 'quarryPick' | 'siteFix' | 'sitePads' | 'hubSeed'
  | 'checkClear' | 'checkCols' | 'checkPick' | 'checkLay' | 'checkDoors' | 'checkStep'
  | 'hubSeed1' | 'hashScrub' | 'relax' | 'relaxMark' | 'relaxCheck' | 'trace' | 'traceDone' | 'rampRoute' | 'riders'
  | 'sites' | 'sitesClear' | 'figuresClear' | 'figures' | 'overlay' | 'poolSwitch' | 'hashClear' | 'passMeshClear' | 'passMesh'
  | 'seaSeed' | 'seaRelax' | 'ships' | 'wallWork';
/** each kernel's bindings (at most 8 storage buffers) */
const SPECS: Record<K, BindSpec> = {
  gate: { 0: 'uniform', 10: 'rw', 11: 'rw', 14: 'rw', 20: 'read' },
  walkInit: { 0: 'uniform', 1: 'read', 8: 'rw', 9: 'rw' },
  doors: { 0: 'uniform', 3: 'read', 4: 'read', 7: 'read', 8: 'rw' },
  pads: { 0: 'uniform', 3: 'read', 4: 'read', 7: 'read', 8: 'rw' },
  hubPick: { 0: 'uniform', 3: 'read', 4: 'read', 5: 'read', 7: 'read', 10: 'rw' },
  quarryPick: { 0: 'uniform', 1: 'read', 2: 'read', 8: 'rw', 10: 'rw', 15: 'read' },
  siteFix: { 0: 'uniform', 3: 'read', 4: 'read', 10: 'rw' },
  lotMask: { 0: 'uniform', 3: 'read', 4: 'read', 7: 'read', 8: 'rw' },
  sitePads: { 0: 'uniform', 8: 'rw', 10: 'rw', 15: 'read' },
  checkClear: { 0: 'uniform', 10: 'rw' },
  checkStep: { 0: 'uniform', 10: 'rw' },
  checkCols: { 0: 'uniform', 8: 'rw', 9: 'rw', 10: 'rw', 17: 'rw' },
  checkPick: { 0: 'uniform', 8: 'rw', 9: 'rw', 10: 'rw', 17: 'rw' },
  checkLay: { 0: 'uniform', 8: 'rw', 9: 'rw', 10: 'rw', 17: 'rw' },
  checkDoors: { 0: 'uniform', 3: 'read', 4: 'read', 7: 'read', 9: 'rw', 10: 'rw' },
  hubSeed: { 0: 'uniform', 3: 'read', 4: 'read', 5: 'read', 7: 'read', 9: 'rw', 10: 'rw' },
  hubSeed1: { 0: 'uniform', 6: 'read', 8: 'rw', 9: 'rw', 10: 'rw' },
  hashScrub: { 0: 'uniform', 10: 'rw' },
  relax: { 0: 'uniform', 2: 'read', 8: 'rw', 9: 'rw', 10: 'rw', 15: 'read' },
  relaxMark: { 0: 'uniform', 10: 'rw' },
  relaxCheck: { 0: 'uniform', 10: 'rw' },
  trace: { 0: 'uniform', 1: 'read', 2: 'read', 8: 'rw', 9: 'rw', 10: 'rw', 11: 'rw', 15: 'read' },
  traceDone: { 0: 'uniform', 10: 'rw' },
  poolSwitch: { 0: 'uniform', 10: 'rw', 11: 'rw' },
  passMeshClear: { 0: 'uniform', 19: 'rw' },
  passMesh: { 0: 'uniform', 2: 'read', 8: 'rw', 18: 'rw', 19: 'rw' },
  hashClear: { 0: 'uniform', 10: 'rw' },
  rampRoute: { 0: 'uniform', 2: 'read', 10: 'rw', 11: 'rw' },
  riders: { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 7: 'read', 10: 'rw', 11: 'rw', 12: 'rw' },
  sites: { 0: 'uniform', 3: 'read', 4: 'read', 7: 'read', 10: 'rw' },
  sitesClear: { 0: 'uniform', 10: 'rw' },
  figuresClear: { 0: 'uniform', 16: 'rw' },
  figures: { 0: 'uniform', 10: 'rw', 12: 'rw', 13: 'rw', 16: 'rw' },
  overlay: { 0: 'uniform', 1: 'read', 2: 'read', 8: 'rw', 9: 'rw', 11: 'rw', 13: 'rw', 16: 'rw' },
  // (season life: the sea field and the ships)
  seaSeed: { 0: 'uniform', 3: 'read', 4: 'read', 5: 'read', 7: 'read', 9: 'rw', 15: 'read' },
  seaRelax: { 0: 'uniform', 9: 'rw', 15: 'read' },
  ships: { 0: 'uniform', 2: 'read', 9: 'rw', 12: 'rw', 15: 'read' },
  // (the wall's routes and table: gate's watch dispatches it)
  wallWork: { 0: 'uniform', 1: 'read', 2: 'read', 6: 'read', 8: 'rw', 9: 'rw', 10: 'rw', 11: 'rw', 15: 'read' },
};
/** routes.wgsl struct P's bytes (12 vec4s) */
const P_BYTES = 192;

/** the GPU's ms of each part of the frame (timestamps; null without them): the graph's pass (only while it solves) and
 *  the every-frame pass (trace, riders, works, figures) */
export type LivingTimes = Record<'graph' | 'people', number | null>;

/** an extra stage (the works: quarry and clearing) encoded in the frame after the riders, in their pass */
export interface LivingStage {
  encode(cp: GPUComputePassEncoder, frame: number): void;
}

export class LivingTown {
  readonly vox: GPUBuffer;
  readonly vargs: GPUBuffer;
  /** the state words (LT), the walk mask, the points pool, the riders, the parameters — the works bind them */
  readonly lt: GPUBuffer;
  readonly walk: GPUBuffer;
  /** the route buffer (api/contracts/routes.ts CityRouteRead; shaders/routeread.wgsl reads it): header, heads, points */
  readonly routes: GPUBuffer;
  readonly rid: GPUBuffer;
  readonly uni: GPUBuffer;
  readonly field: GPUBuffer;
  private pass: GPUBuffer;
  /** the passages drawn as dirt (citygen's mesh format: Renderer.addMesh with the town's place) */
  readonly pmesh: GPUBuffer;
  readonly pargs: GPUBuffer;
  private ind: GPUBuffer;
  private read: GPUBuffer;
  private reading = false;
  private k: Record<K, ComputeKernel>;
  private g: Record<K, GPUBindGroup>;
  private all: GPUBuffer[] = [];
  private frameNo = 0;
  private time = 0;
  private dealt = '';
  readonly stages: LivingStage[] = [];
  /** (?livingdebug=1) the graph drawn over the town: reached, cut off, doors, passages, decks */
  debugGraph = false;
  /** (the living bench, ?livingbench=1, only) the graph forced awake: its relax sweeps dispatched every frame even when
   *  settled — the toggle diff's "awake" side */
  debugAwake = false;
  /** (the living bench only) the graph's pass never encoded, whatever woke it — the toggle diff's other side (settled,
   *  the graph is asleep and this changes nothing). Never in play: the graph would never be made */
  debugSkipGraph = false;
  /** (tests only) the graph's pass encoded every frame, as before it slept: the run a sleeping town is compared with */
  debugNoSleep = false;
  /** the graph's sleep: awake from a wake till the state words read settled (gpu/settled.ts) */
  private sleep: SettledRead;
  private lastFlags = -1;
  /** (tests only) a rider forced overridden (its index + 1; 0 none): routes.wgsl's `overridden` stub */
  debugOverride = 0;
  /** the last counters read (the panel's) */
  head = new Uint32Array(HEAD_WORDS);
  /** (season life) the towns' clock (s: citygen's, FieldTowns.townTime) and a wall piece's span of it to rise
   *  (DISTRICT_SPAN): the wall's pieces rise on the GPU by it, as citygen draws them */
  wallClock = 0;
  wallSpan = 1;

  constructor(
    private device: GPUDevice,
    readonly input: LivingInput,
    readonly values: LivingValues = LIVING_TUNING.values,
    /** (tests) the points pool's size (default PTS_ROOM) */
    ptsRoom = PTS_ROOM,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (label: string, bytes: number, usage = S) => {
      const b = device.createBuffer({ label: `living ${label}`, size: Math.max(16, bytes), usage });
      this.all.push(b);
      return b;
    };
    const N = input.w * input.h;
    this.uni = buf('params', P_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.walk = buf('walk', N * 4);
    // (the 8 hubs' fields, then the open ground's distance and the cut-off labels: routes.wgsl PLANES)
    this.field = buf('fields', N * 11 * 4);
    this.pass = buf('passages', N * 8);
    // (the passages' dirt mesh: room for 6 000 columns, 18 vertices of 32 B each)
    this.pmesh = buf('passage mesh', 6000 * 18 * 32);
    this.pargs = buf('passage mesh args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.lt = buf('state', LT_WORDS * 4);
    // (the route buffer: the header with the wall's table, ROUTE_IDS heads of 4 words, then the points — routeread.wgsl's
    // layout; its fixed words written here once, the table's entries empty: no route, no gate)
    this.routes = buf('routes', (ROUTE_HEAD_WORDS + ROUTE_IDS * 4 + ptsRoom * 5) * 4);
    const head = new Uint32Array(ROUTE_HEAD_WORDS);
    head.set([0, 0, ROUTE_IDS / 2, ROUTE_HEAD_WORDS + ROUTE_IDS * 4, 0, 0, 0, ptsRoom, ROUTE_HEAD_WORDS, 0, GATE_SLOTS, 0, WW_AT, GATE_AT]);
    for (let i = 0; i < WW_ROOM; i++) head[WW_AT + 2 * i] = NONE;
    for (let k = 0; k < GATE_SLOTS; k++) head.set([NONE, 1], GATE_AT + 2 * k);
    device.queue.writeBuffer(this.routes, 0, head);
    this.rid = buf('riders', MAX_RIDERS * 64);
    // (room for the figures and, with ?livingdebug=1, a block a walkable column)
    this.vox = buf('voxels', (MAX_RIDERS * VOX_PER + input.w * input.h) * 32);
    this.vargs = buf('voxel args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.ind = buf('indirect', 36 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.read = buf('read', HEAD_WORDS * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.vargs, 0, new Uint32Array([36, 0, 0, 0]));
    const R: Record<number, GPUBuffer> = {
      1: input.roads, 2: input.heights, 3: input.records, 4: input.counts, 5: input.pop, 6: input.art, 7: input.progress,
      8: this.walk, 9: this.field, 17: this.pass, 20: input.wall ?? buf('no wall', 600 * 4), 18: this.pmesh, 19: this.pargs, 10: this.lt, 11: this.routes, 12: this.rid, 13: this.vox, 14: this.ind, 15: input.wet, 16: this.vargs,
    };
    R[0] = this.uni;
    this.k = {} as Record<K, ComputeKernel>;
    this.g = {} as Record<K, GPUBindGroup>;
    for (const [name, spec] of Object.entries(SPECS) as [K, BindSpec][]) {
      // (loop round 17: the figures' paints, render/palette.ts, in front)
      const k = makeCompute(device, `living ${name}`, [figureWgsl(), routesWgsl], spec, name);
      this.k[name] = k;
      this.g[name] = makeBindGroup(device, `living ${name}`, k.layout, Object.fromEntries(Object.keys(spec).map((b) => [Number(b), R[Number(b)]])));
    }
    // (awake to begin with: the graph is made. A read that says "not settled" while asleep is the watch's: a wake)
    this.sleep = new SettledRead(device, 'living graph', this.lt, 0, SETTLED_WORDS * 4, (w) => {
      const settled = graphSettled(w);
      if (!settled && !this.sleep.awake) this.sleep.wake();
      return settled;
    });
  }

  /** a CPU-known event that may have changed what the graph is made from (the town's mesh run: its roads, lots, wall):
   *  the graph's kernels are encoded again until the state words read settled */
  wake(): void {
    this.sleep.wake();
  }

  /** the graph's kernels are encoded this frame (awake) */
  get awake(): boolean {
    return this.sleep.awake;
  }

  /** (tests, the census) the sleep's wakes, reads and sleeps so far */
  get sleepStats(): Readonly<{ wakes: number; reads: number; slept: number }> {
    return this.sleep.gate.stats;
  }

  /** a wake only the GPU knows can happen: the works (a walked column dug out, the camp placed) or a wall (a piece
   *  rising with the clock, its routes after a pool switch) — asleep, the watch's read listens for it */
  private get watching(): boolean {
    return !!this.values.quarry.on || !!this.values.forest.on || !!this.input.wall;
  }

  /** how many riders: the counts' sum */
  get riders(): number {
    const p = this.values.people;
    return Math.min(MAX_RIDERS, p.commuters + p.farmers + p.quarrymen + p.stoneCarts + p.woodcutters + p.logCarts + p.builders + p.wagons + p.ships);
  }

  /** the parameters' uniform for this frame (routes.wgsl struct P) */
  private writeParams(dt: number, place: LivingPlace, solve: boolean): void {
    const v = this.values;
    const p = v.people;
    const a = new ArrayBuffer(P_BYTES);
    const U = new Uint32Array(a);
    const F = new Float32Array(a);
    const I = new Int32Array(a);
    const ends: number[] = [];
    let acc = 0;
    for (const n of [p.commuters, p.farmers, p.quarrymen, p.stoneCarts, p.woodcutters, p.logCarts, p.builders]) ends.push((acc = Math.min(MAX_RIDERS, acc + n)));
    const flags = this.flags() | (solve ? F_SOLVE : 0);
    U.set([this.input.w, this.input.h, this.riders, this.frameNo], 0);
    U.set([this.input.lotRoom, this.input.lotRoom, flags, v.graph.sweeps], 4);
    U.set([ends[0], ends[1], ends[2], ends[3]], 8);
    U.set([ends[4], ends[5], ends[6], acc], 12);
    F.set([dt, this.time, this.input.centre[0], this.input.centre[1]], 16);
    F.set([this.input.radius, p.walk, p.cart, p.work], 20);
    F.set([v.quarry.side, v.quarry.bench, v.quarry.depth, v.quarry.slope], 24);
    F.set([v.quarry.digRate, v.quarry.ledge, v.quarry.load, 2], 28);
    F.set([v.forest.radius, v.forest.cut, v.forest.replant, v.forest.regrow], 32);
    I.set([place.dx, place.dy, place.winW, place.winH], 36);
    F.set([place.dz, 0, p.spread, this.debugOverride], 40);
    // (season life: the wagons' and the ships' ends, after the builders')
    const wEnd = Math.min(MAX_RIDERS, acc + p.wagons);
    U.set([wEnd, Math.min(MAX_RIDERS, wEnd + p.ships)], 44);
    F.set([this.wallClock, this.wallSpan], 46);
    this.device.queue.writeBuffer(this.uni, 0, a);
    // (the route buffer's place: where the grid's frame is in the window — routeread.wgsl routePoint)
    this.device.queue.writeBuffer(this.routes, 16, new Float32Array([place.dx, place.dy * 0.8660254, place.dz]));
  }

  /** routes.wgsl F_*: the works on, the debug switches (F_SOLVE is the frame's own) */
  private flags(): number {
    const v = this.values;
    return 1 | (v.quarry.on ? 2 : 0) | (v.forest.on ? 4 : 0) | (v.forest.replant ? 8 : 0) | (this.debugGraph ? 16 : 0) | (this.debugAwake ? 32 : 0);
  }

  /** the jobs dealt again when the counts change (the riders' rows cleared: each is dealt at its next frame) */
  private redeal(enc: GPUCommandEncoder): void {
    const p = this.values.people;
    const key = [p.commuters, p.farmers, p.quarrymen, p.stoneCarts, p.woodcutters, p.logCarts, p.builders, p.wagons, p.ships].join(',');
    if (key === this.dealt) return;
    this.dealt = key;
    enc.clearBuffer(this.rid);
  }

  /**
   * The frame's GPU work, encoded into `enc` (which must be submitted in this task: the settled read maps after it).
   * While awake, the graph's pass: the build (when the state says so), the relax sweeps (while the fields settle), the
   * check, the wall's work — indirect, sized by the gate. Every frame, one pass of direct dispatches: the trace (new
   * route keys), the ramp, the riders, the works' stages, the figures. `ts` names a pass's timestamps (the profiler's).
   */
  frame(enc: GPUCommandEncoder, dt: number, place: LivingPlace, ts?: (name: string) => GPUComputePassTimestampWrites | undefined): void {
    const sdt = Math.min(dt, 0.1) * this.values.people.speed;
    this.time += sdt;
    // (the works switched on or off, a debug switch: a look at the graph — the build reads the flags)
    const flags = this.flags();
    if (flags !== this.lastFlags) {
      if (this.lastFlags !== -1) this.sleep.wake();
      this.lastFlags = flags;
    }
    const solve = !this.debugSkipGraph && (this.sleep.awake || this.debugAwake || this.debugNoSleep);
    this.writeParams(sdt, place, solve);
    this.redeal(enc);
    const run = (cp: GPUComputePassEncoder, k: K, x: number | [GPUBuffer, number]) => {
      cp.setPipeline(this.k[k].pipeline);
      cp.setBindGroup(0, this.g[k]);
      if (typeof x === 'number') cp.dispatchWorkgroups(x);
      else cp.dispatchWorkgroupsIndirect(x[0], x[1]);
    };
    const ind = (slot: number): [GPUBuffer, number] => [this.ind, slot * 4];
    const pass = (name: string, body: (cp: GPUComputePassEncoder) => void) => {
      const cp = enc.beginComputePass({ label: `living-${name}`, timestampWrites: ts?.(`living-${name}`) });
      body(cp);
      cp.end();
    };
    // (one pass for the graph, only while awake: the build, the relax sweeps, the connectivity check — each indirect,
    // sized by the gate from the phase word)
    if (solve) pass('graph', (cp) => {
      // (build)
      run(cp, 'gate', 1);
      // (season life: the wall's routes and table — 0 workgroups unless the wall changed)
      run(cp, 'wallWork', ind(30));
      run(cp, 'walkInit', ind(0));
      run(cp, 'doors', ind(3));
      run(cp, 'pads', ind(3));
      run(cp, 'lotMask', ind(3));
      run(cp, 'hubPick', ind(3));
      run(cp, 'quarryPick', ind(0));
      run(cp, 'siteFix', ind(6));
      run(cp, 'sitePads', ind(0));
      run(cp, 'hubSeed', ind(3));
      run(cp, 'hubSeed1', ind(6));
      run(cp, 'hashScrub', ind(15));
      // (the passages' dirt, made with the graph)
      run(cp, 'passMeshClear', ind(6));
      run(cp, 'passMesh', ind(0));
    // (relax)
      // (the frame's sweeps in turn, RELAX_INNER in place a dispatch: one after another is what carries a distance far;
      // not relaxing, each is 0 workgroups)
      const disp = Math.max(2, Math.ceil(this.values.graph.sweeps / RELAX_INNER));
      for (let k = 0; k < disp - 1; k++) run(cp, 'relax', ind(9));
      run(cp, 'relaxMark', 1);
      run(cp, 'relax', ind(9));
      run(cp, 'relaxCheck', 1);
    // (check)
      run(cp, 'checkClear', ind(24));
      run(cp, 'checkCols', ind(18));
      run(cp, 'checkDoors', ind(21));
      run(cp, 'checkPick', ind(18));
      run(cp, 'checkLay', ind(18));
      run(cp, 'checkStep', ind(24));
    });
    // (one pass for what runs every frame, all direct)
    pass('people', (cp) => {
      // (asleep: the gate's watch — the frame's counts, the phase's snapshot, whether there's work)
      if (!solve) run(cp, 'gate', 1);
      // (trace: the keys the riders queued, over the queue's room — its threads return at once past the queued keys,
      // the hash's unless the pool switched this frame)
      run(cp, 'poolSwitch', 1);
      run(cp, 'hashClear', HASH_GROUPS);
      run(cp, 'trace', TRACE_GROUPS);
      run(cp, 'traceDone', 1);
      if (this.frameNo % 30 === 0) {
        run(cp, 'sitesClear', 1);
        run(cp, 'sites', Math.ceil(this.input.lotRoom / 64));
      }
      run(cp, 'rampRoute', 1);
      run(cp, 'riders', Math.ceil(this.riders / 64) || 1);
      // (season life: the ships — their sea field seeded now and then and relaxed a few steps a frame)
      const ships = this.values.people.ships;
      if (ships > 0) {
        if (this.frameNo % 30 === 0) run(cp, 'seaSeed', Math.ceil(this.input.lotRoom / 64));
        for (let k = 0; k < 4; k++) run(cp, 'seaRelax', Math.ceil((this.input.w * this.input.h) / 64));
        run(cp, 'ships', Math.ceil(ships / 64));
      }
      // (the works: quarry and clearing)
      for (const s of this.stages) s.encode(cp, this.frameNo);
      run(cp, 'figuresClear', 1);
      // (and past the riders, a thread a wall segment: its red marks where the town doesn't reach its walk)
      run(cp, 'figures', Math.ceil((this.riders + 72) / 64));
      // (and the wall's table's routes with their widths: a thread a route past the columns)
      if (this.debugGraph) run(cp, 'overlay', Math.ceil((this.input.w * this.input.h + WW_ROOM + GATE_SLOTS) / 64));
    });
    // (the state words read, small and async: awake, until they say settled; asleep, now and then while a wake only
    // the GPU knows can happen — the read's "not settled" wakes it)
    if (this.sleep.awake) {
      if (solve) this.sleep.encode(enc);
    } else if (!this.debugSkipGraph && this.watching && this.frameNo % WATCH_EVERY === 0) this.sleep.encode(enc);
    this.frameNo++;
  }

  /**
   * (tests only) Which wall segments' walk the town reaches (routes.wgsl wallWork's reach bits: a piece risen in a run
   * of risen pieces with a stair whose foot is on the graph joined to the stores). In play the GPU draws the unreached
   * pieces red itself (wallMark) and Track B reads `wallWalkRun(i)`; nothing reads this but tests. Null: no wall input.
   */
  async debugWallReach(): Promise<boolean[] | null> {
    if (!this.input.wall) return null;
    const w = new Uint32Array(await this.debugRead(this.lt, (L_WALL + 8) * 4)).subarray(L_WALL + 5);
    return Array.from({ length: 72 }, (_, b) => ((w[b >> 5] >> (b & 31)) & 1) === 1);
  }

  /** the graph made again (the town's road raster was drawn again: a district's roads appeared): 4 bytes */
  rebuild(): void {
    this.device.queue.writeBuffer(this.lt, 0, new Uint32Array([0]));
    this.sleep.wake();
  }

  /** (debug: the panel, scripts) the head of the state words, read once (a few hundred bytes, async); null while one's
   *  in flight */
  async counters(): Promise<Uint32Array | null> {
    if (this.reading) return null;
    this.reading = true;
    const enc = this.device.createCommandEncoder({ label: 'living counters' });
    enc.copyBufferToBuffer(this.lt, 0, this.read, 0, HEAD_WORDS * 4);
    this.device.queue.submit([enc.finish()]);
    try {
      await this.read.mapAsync(GPUMapMode.READ);
      this.head = new Uint32Array(this.read.getMappedRange().slice(0));
      this.read.unmap();
      return this.head;
    } finally {
      this.reading = false;
    }
  }

  /** (tests, scripts) every rider's row and the points pool's head, read once */
  async debugRead(what: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const tmp = this.device.createBuffer({ label: 'living debug read', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(what, 0, tmp, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = tmp.getMappedRange().slice(0);
    tmp.destroy();
    return out;
  }

  /** the GPU bytes it holds */
  get bytes(): number {
    return this.all.reduce((s, b) => s + b.size, 0);
  }

  dispose(): void {
    this.sleep.destroy();
    for (const b of this.all) b.destroy();
  }
}

export { NONE as LIVING_NONE };
