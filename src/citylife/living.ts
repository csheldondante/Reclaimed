// (living town, docs/design/LIVING_TOWN.md) A citygen town's people on the GPU: the route graph from its road raster,
// the hubs' fields relaxed with no readback, cached routes in a points pool, riders on kinematic trips with their jobs'
// state machine, drawn as voxel figures (routes.wgsl); the quarry and the clearing as world operations (works.wgsl).
// The CPU writes the parameters' uniform (counts, rates, the works' numbers, the grid's place in the window) and encodes
// a fixed list of dispatches a frame; what runs and how much is decided on the GPU (indirect dispatches from the state
// words). Nothing is read back but the debug panel's counters (`counters`, only while someone looks).
import routesWgsl from './routes.wgsl?raw';
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import { LIVING_TUNING, type LivingValues } from './params';

/** routes.wgsl's LT layout: its words (L_RH + ROUTES × 4), the counters' first word, the quarry's, the clearing's */
export const LT_WORDS = 52520 + 256 * 2;
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
export const MAX_RIDERS = 4096;
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
  | 'sites' | 'sitesClear' | 'figuresClear' | 'figures' | 'overlay' | 'poolSwitch' | 'hashClear';
/** each kernel's bindings (at most 8 storage buffers) */
const SPECS: Record<K, BindSpec> = {
  gate: { 0: 'uniform', 10: 'rw', 14: 'rw' },
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
  trace: { 0: 'uniform', 1: 'read', 2: 'read', 9: 'rw', 10: 'rw', 11: 'rw' },
  traceDone: { 0: 'uniform', 10: 'rw' },
  poolSwitch: { 0: 'uniform', 10: 'rw' },
  hashClear: { 0: 'uniform', 10: 'rw' },
  rampRoute: { 0: 'uniform', 2: 'read', 10: 'rw', 11: 'rw' },
  riders: { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 7: 'read', 10: 'rw', 11: 'rw', 12: 'rw' },
  sites: { 0: 'uniform', 3: 'read', 4: 'read', 7: 'read', 10: 'rw' },
  sitesClear: { 0: 'uniform', 10: 'rw' },
  figuresClear: { 0: 'uniform', 16: 'rw' },
  figures: { 0: 'uniform', 12: 'rw', 13: 'rw', 16: 'rw' },
  overlay: { 0: 'uniform', 1: 'read', 2: 'read', 8: 'rw', 9: 'rw', 13: 'rw', 16: 'rw' },
};

/** the GPU's ms of each part of the frame (timestamps; null without them) */
export type LivingTimes = Record<'graph' | 'riders' | 'figures' | 'works', number | null>;

/** an extra stage (the works: quarry and clearing) encoded in the frame after the riders */
export interface LivingStage {
  encode(cp: GPUComputePassEncoder, frame: number): void;
}

export class LivingTown {
  readonly vox: GPUBuffer;
  readonly vargs: GPUBuffer;
  /** the state words (LT), the walk mask, the points pool, the riders, the parameters — the works bind them */
  readonly lt: GPUBuffer;
  readonly walk: GPUBuffer;
  readonly pts: GPUBuffer;
  readonly rid: GPUBuffer;
  readonly uni: GPUBuffer;
  readonly field: GPUBuffer;
  private pass: GPUBuffer;
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
  /** (tests only) a rider forced overridden (its index + 1; 0 none): routes.wgsl's `overridden` stub */
  debugOverride = 0;
  /** the last counters read (the panel's) */
  head = new Uint32Array(HEAD_WORDS);

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
    this.uni = buf('params', 176, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.walk = buf('walk', N * 4);
    // (the 8 hubs' fields, then the open ground's distance and the cut-off labels: routes.wgsl PLANES)
    this.field = buf('fields', N * 10 * 4);
    this.pass = buf('passages', N * 8);
    this.lt = buf('state', LT_WORDS * 4);
    this.pts = buf('points', ptsRoom * 16);
    this.rid = buf('riders', MAX_RIDERS * 64);
    // (room for the figures and, with ?livingdebug=1, a block a walkable column)
    this.vox = buf('voxels', (MAX_RIDERS * VOX_PER + input.w * input.h) * 32);
    this.vargs = buf('voxel args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.ind = buf('indirect', 27 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.read = buf('read', HEAD_WORDS * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.vargs, 0, new Uint32Array([36, 0, 0, 0]));
    const R: Record<number, GPUBuffer> = {
      1: input.roads, 2: input.heights, 3: input.records, 4: input.counts, 5: input.pop, 6: input.art, 7: input.progress,
      8: this.walk, 9: this.field, 17: this.pass, 10: this.lt, 11: this.pts, 12: this.rid, 13: this.vox, 14: this.ind, 15: input.wet, 16: this.vargs,
    };
    R[0] = this.uni;
    this.k = {} as Record<K, ComputeKernel>;
    this.g = {} as Record<K, GPUBindGroup>;
    for (const [name, spec] of Object.entries(SPECS) as [K, BindSpec][]) {
      const k = makeCompute(device, `living ${name}`, [routesWgsl], spec, name);
      this.k[name] = k;
      this.g[name] = makeBindGroup(device, `living ${name}`, k.layout, Object.fromEntries(Object.keys(spec).map((b) => [Number(b), R[Number(b)]])));
    }
  }

  /** how many riders: the counts' sum */
  get riders(): number {
    const p = this.values.people;
    return Math.min(MAX_RIDERS, p.commuters + p.farmers + p.quarrymen + p.stoneCarts + p.woodcutters + p.logCarts + p.builders);
  }

  /** the parameters' uniform for this frame (routes.wgsl struct P) */
  private writeParams(dt: number, place: LivingPlace): void {
    const v = this.values;
    const p = v.people;
    const a = new ArrayBuffer(176);
    const U = new Uint32Array(a);
    const F = new Float32Array(a);
    const I = new Int32Array(a);
    const ends: number[] = [];
    let acc = 0;
    for (const n of [p.commuters, p.farmers, p.quarrymen, p.stoneCarts, p.woodcutters, p.logCarts, p.builders]) ends.push((acc = Math.min(MAX_RIDERS, acc + n)));
    const flags = 1 | (v.quarry.on ? 2 : 0) | (v.forest.on ? 4 : 0) | (v.forest.replant ? 8 : 0) | (this.debugGraph ? 16 : 0);
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
    this.device.queue.writeBuffer(this.uni, 0, a);
  }

  /** the jobs dealt again when the counts change (the riders' rows cleared: each is dealt at its next frame) */
  private redeal(enc: GPUCommandEncoder): void {
    const p = this.values.people;
    const key = [p.commuters, p.farmers, p.quarrymen, p.stoneCarts, p.woodcutters, p.logCarts, p.builders].join(',');
    if (key === this.dealt) return;
    this.dealt = key;
    enc.clearBuffer(this.rid);
  }

  /**
   * The frame's GPU work, encoded into `enc`: the build (when the state says so), the relax sweeps (while the fields
   * settle), the trace (new route keys), the ramp, the riders, the works' stages, the figures. `ts` names a pass's
   * timestamps (the profiler's).
   */
  frame(enc: GPUCommandEncoder, dt: number, place: LivingPlace, ts?: (name: string) => GPUComputePassTimestampWrites | undefined): void {
    const sdt = Math.min(dt, 0.1) * this.values.people.speed;
    this.time += sdt;
    this.writeParams(sdt, place);
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
    // (one pass for the graph: the build, the relax sweeps, the connectivity check, the trace — each indirect, sized by
    // the phase word: settled, they're dispatches of 0 workgroups)
    pass('graph', (cp) => {
      // (build)
      run(cp, 'gate', 1);
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
    // (relax)
      const n = Math.max(2, this.values.graph.sweeps);
      for (let s = 0; s < n - 1; s++) run(cp, 'relax', ind(9));
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
    // (trace)
      run(cp, 'poolSwitch', 1);
      run(cp, 'hashClear', 8192 / 64);
      run(cp, 'trace', ind(12));
      run(cp, 'traceDone', 1);
    });
    pass('riders', (cp) => {
      if (this.frameNo % 30 === 0) {
        run(cp, 'sitesClear', 1);
        run(cp, 'sites', Math.ceil(this.input.lotRoom / 64));
      }
      run(cp, 'rampRoute', 1);
      run(cp, 'riders', Math.ceil(this.riders / 64) || 1);
    });
    if (this.stages.length) pass('works', (cp) => this.stages.forEach((s) => s.encode(cp, this.frameNo)));
    pass('figures', (cp) => {
      run(cp, 'figuresClear', 1);
      run(cp, 'figures', Math.ceil(this.riders / 64) || 1);
      if (this.debugGraph) run(cp, 'overlay', Math.ceil((this.input.w * this.input.h) / 64));
    });
    this.frameNo++;
  }

  /** the graph made again (the town's road raster was drawn again: a district's roads appeared): 4 bytes */
  rebuild(): void {
    this.device.queue.writeBuffer(this.lt, 0, new Uint32Array([0]));
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
    for (const b of this.all) b.destroy();
  }
}

export { NONE as LIVING_NONE };
