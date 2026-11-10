// (street lab, milestones 2–3) The street lab's GPU runner: the window's ground heights and water read from the
// world's own buffers (height.wgsl, at load), then the streets, blocks, lots and their mesh (streets.wgsl) — every pass
// on the GPU; the CPU writes the passes' numbers, the points a tap places (an authored edit), and encodes the
// dispatches. A run starts at the first stage a change needs (field → phi → trace → lots → mesh); what the stages
// before it made stays in their buffers. A point's change reruns φ over its radius's box only. The one read back is the
// run's timestamps, two counts and the points (360 bytes, after a run — never a frame's). It owns its buffers; it knows
// the world only through StreetWorld.
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import heightWgsl from './height.wgsl?raw';
import streetsWgsl from './streets.wgsl?raw';
import { makeBindGroup, makeCompute, makeLayout, makeModule, type ComputeKernel } from '../gpu/pipeline';
import { ROW_H } from '../world/lattice';

/** what the major lines are: the distance to water and cliffs' contours, that distance bent round the points (m3a: a
 *  smooth min with a cone a point, or a bump taken off), or rings and spokes round the town's centre */
export const MAJORS = ['distance contours', 'smooth min (points)', 'additive bump (points)', 'radial (rings, spokes)'] as const;
/** φ's mode for each (streets.wgsl phi: 0 the distance alone) */
const PHI_MODE = [0, 1, 2, 0];
/** how the cross streets are made: m3b's vector jump floods between the lines' seeds, or m2's tensor traces */
export const CROSS = ['vector JFA (m3)', 'tensor trace (m2)'] as const;
/** the families of major lines drawn: φ's level sets (1), or rings (2) and — with the traces — spokes (4) */
const families = (majors: number, cross: number) => (majors < 3 ? 1 : cross === 1 ? 2 | 4 : 2);
/** the points (streets.wgsl NPTS, PW: words a point; AUTO slots the GPU may place) */
export const NPTS = 8;
export const PW = 8;
export const AUTO = 4;
/** a point as the last run left it */
export interface StreetPoint {
  slot: number;
  x: number;
  y: number;
  intensity: number;
  /** 0 placed by the GPU, 1 pinned (a tap placed or moved it, or set its intensity), 2 removed */
  flag: number;
  alive: boolean;
}

export interface StreetParams {
  /** index into MAJORS */
  majors: number;
  /** between the distance contours, between the rings (world units) */
  majorSpacing: number;
  ringSpacing: number;
  /** cross streets this far apart along a strip */
  blockLen: number;
  /** street widths (world units) */
  majorWidth: number;
  minorWidth: number;
  /** lots split until under maxLot (cells²); a split leaving one under minLot isn't made */
  maxLot: number;
  minLot: number;
  /** a building's setback from its street, its height in storeys (3 cells) */
  setback: number;
  height: number;
  /** a street rising more than this along itself is marked (rise / run) */
  stairs: number;
  /** smoothed ground steeper than this is a cliff (rise / run) */
  cliff: number;
  /** the town's radius (world units) round its centre */
  townR: number;
  /** (m3a) the smooth min's blend width, a point's radius and strength (each × its intensity), how many auto points */
  blend: number;
  pointR: number;
  strength: number;
  autoPts: number;
  /** (m3b) index into CROSS */
  cross: number;
  /** (m3c) index into SHAPES; the terraces' band height (cells); the carts' steepest grade (rise / run) */
  shape: number;
  band: number;
  grade: number;
  /** (m3d) bad cells: index into BAD */
  bad: number;
  /** (m3e) landmark sites at the busy junctions: their radius × (0 none), the cross streets that make a junction busy,
   *  index into LANDMARKS, the smallest and largest radius */
  lmMult: number;
  lmN: number;
  lmKind: number;
  lmRmin: number;
  lmRmax: number;
}
/** (m3e) what a landmark site holds */
export const LANDMARKS = ['plaza', 'big structure'] as const;
/** (m3d) what a bad cell (a sliver, a thin triangle) becomes: merged into its neighbour, or paved */
export const BAD = ['merge', 'plaza', 'leave (as m3)'] as const;
/** (m3c) shaping the steep ground — the lab's heights only: terraces, or a cart road (a spiral ramp, switchbacks) */
export const SHAPES = ['none', 'terraces', 'spiral ramp', 'switchbacks'] as const;

/** the stages a run can start at: a change reruns its stage and the ones after */
export const STAGES = ['field', 'phi', 'trace', 'lots', 'mesh'] as const;
export type Stage = (typeof STAGES)[number];
/** a column box [x0, y0, x1, y1) */
export type Box = [number, number, number, number];

/** what the street lab needs of the world */
export interface StreetWorld {
  w: number;
  h: number;
  globals: GPUBuffer;
  chunks: GPUBuffer;
  layers: GPUBuffer;
  water: GPUBuffer;
  /** the town's centre (window world) */
  centre: [number, number];
}

/** a run: where it started, GPU ms of each stage it ran (null: not run, or no timestamp-query), the total, counts */
export interface StreetTimes {
  from: Stage;
  /** φ's box, when the run reran φ over one point's radius only */
  box: Box | null;
  height: number | null;
  stage: Record<Stage, number | null>;
  total: number | null;
  lots: number;
  verts: number;
}

const SLOT = 256;
const MAX_PASSES = 256;
const UNI_BYTES = 176;
const KERNELS = [
  'fill', 'blur', 'feat', 'jfa', 'jdist', 'autoPts', 'phi', 'tensor', 'trace', 'mis', 'blocks',
  'vseed', 'vthin', 'vrast', 'vjfa', 'vseg', 'vblock', 'lots', 'roadMajor', 'roadMinor', 'vroad', 'lotMesh', 'marks', 'meshCap',
  'shape', 'roadShape', 'ground', 'bqual', 'bclaim', 'bapply', 'vnext', 'jstat', 'lmlist', 'lmprune', 'vclip', 'lmMesh',
] as const;
type Kernel = (typeof KERNELS)[number];
/** streets.wgsl TRW, BQW, LW, SDW (words a trace, a block, a lot, a seed) */
const TRW = 144;
const BQW = 12;
const LW = 10;
const SDW = 12;
/** the shortest block length the buffers have room for (the seed lattice half of it) */
export const MIN_BLOCK = 8;
/** room: lots, vertices (32 bytes each) */
const LOT_ROOM = 32768;
const VERT_ROOM = 1_200_000;
/** conflict rounds between the traces (a greedy independent set: even, so the kept end in AL0) */
const MIS_ROUNDS = 4;
/** (m3d) merge rounds for the bad blocks */
const MERGE_ROUNDS = 3;
const NONE = 0xffffffff;
const ALL = ['height', ...STAGES] as const;

interface Uni {
  k?: number;
  mode?: number;
  count?: number;
  /** a boxed pass's first column */
  box?: [number, number];
}
type Bufs = Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, GPUBuffer>>;

export class StreetLabGpu {
  readonly verts: GPUBuffer;
  readonly args: GPUBuffer;
  private pipes: Record<Kernel, GPUComputePipeline>;
  private layout: GPUBindGroupLayout;
  private heightK: ComputeKernel;
  private uni: GPUBuffer;
  private uniData = new ArrayBuffer(SLOT * MAX_PASSES);
  private nPass = 0;
  /** (scripts: its buffers by name, to read back while debugging — never read by the game) */
  readonly B: Record<string, GPUBuffer> = {};
  private dummies: GPUBuffer[];
  private qs?: GPUQuerySet;
  private qRes?: GPUBuffer;
  private qRead: GPUBuffer;
  private haveHeights = false;
  private busy: Promise<unknown> = Promise.resolve();
  private dead = false;
  private all: GPUBuffer[] = [];
  private p!: StreetParams;
  private cp!: GPUComputePassEncoder;
  private seeds: [number, number] = [0, 0];
  private sel = -1;
  private placed = '';
  private resets = 0;
  /** the points as the last run left them */
  points: StreetPoint[] = [];
  /** the last run's dispatches */
  dispatches = 0;

  constructor(
    private device: GPUDevice,
    private world: StreetWorld,
  ) {
    const { w, h } = world;
    const N = w * h;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (label: string, bytes: number, usage = S) => {
      const b = device.createBuffer({ label: `streetlab ${label}`, size: Math.max(16, bytes), usage });
      this.all.push(b);
      return b;
    };
    this.uni = buf('passes', SLOT * MAX_PASSES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    for (const n of ['H', 'HT', 'M', 'HS', 'TB', 'T0', 'FDB', 'FD', 'S0', 'S1', 'BLK', 'TX', 'TY']) this.B[n] = buf(n, N * 4);
    const [mx, my] = this.lattice(MIN_BLOCK);
    const T = mx * my;
    this.B.TR = buf('traces', T * TRW * 4);
    this.B.AL0 = buf('kept a', T * 4);
    this.B.AL1 = buf('kept b', T * 4);
    this.B.BQ = buf('blocks', 3 * T * BQW * 4);
    this.B.LOTS = buf('lots', LOT_ROOM * LW * 4);
    this.B.CNT = buf('lot count', 16);
    // (m3: the points, the seeds, their occupancy grid, the two floods ping-ponged; AL1 the streets drawn)
    this.B.PTS = buf('points', NPTS * PW * 4);
    this.B.SD = buf('seeds', T * SDW * 4);
    this.B.OCC = buf('occupancy', this.occWords(MIN_BLOCK) * 4);
    for (const n of ['JE0', 'JE1', 'JO0', 'JO1']) this.B[n] = buf(n, N * 4);
    // (m3e: the cross streets ending at each seed and their smallest angle there; the landmark sites — a count, then
    // 64 of x, y, r, kind)
    this.B.JC = buf('junctions', 2 * T * 4);
    this.B.LM = buf('landmarks', (1 + 64 * 4) * 4);
    this.verts = buf('mesh', VERT_ROOM * 32, GPUBufferUsage.STORAGE);
    this.args = buf('mesh args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    device.queue.writeBuffer(this.args, 0, new Uint32Array([0, 1, 0, 0]));
    this.dummies = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => buf(`dummy ${k}`, 16));
    this.layout = makeLayout(device, 'streetlab', { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' }, GPUShaderStage.COMPUTE);
    const module = makeModule(device, 'streetlab', [streetsWgsl]);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipes = Object.fromEntries(KERNELS.map((k) => [k, device.createComputePipeline({ label: `streetlab ${k}`, layout: pl, compute: { module, entryPoint: k } })])) as Record<Kernel, GPUComputePipeline>;
    this.heightK = makeCompute(device, 'streetlab height', [commonWgsl, layersWgsl, materialsWgsl, heightWgsl], { 0: 'uniform', 1: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw' });
    const n = ALL.length * 2;
    if (device.features.has('timestamp-query')) {
      this.qs = device.createQuerySet({ type: 'timestamp', count: n });
      this.qRes = buf('stamps', n * 8, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
    }
    // (the stamps, then the lots' count and the vertices', then the points)
    this.qRead = buf('stamps read', n * 8 + 16 + NPTS * PW * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  }

  /** the seed lattice for a block length: spacing half of it, across and down the window */
  private lattice(blockLen: number): [number, number] {
    const sp = blockLen / 2;
    return [Math.ceil((this.world.w + 0.5) / sp), Math.ceil((this.world.h * ROW_H) / sp)];
  }
  /** the occupancy grid's words for a block length (streets.wgsl occDims, four line layers) */
  private occWords(bl: number): number {
    return (Math.floor(this.world.w / bl) + 2) * (Math.floor((this.world.h * ROW_H) / bl) + 2) * 4;
  }

  /** (m3a, a tap: an authored edit) a point's slot written — position, intensity, flag; the next run from 'phi' */
  setPoint(slot: number, x: number, y: number, intensity: number, flag: number): void {
    const a = new ArrayBuffer(PW * 4);
    const f = new Float32Array(a);
    f[0] = x;
    f[1] = y;
    f[2] = intensity;
    new Uint32Array(a)[4] = flag;
    this.device.queue.writeBuffer(this.B.PTS, slot * PW * 4, a);
  }
  /** every slot handed back to the GPU's placing (the user's emptied) */
  resetPoints(): void {
    this.device.queue.writeBuffer(this.B.PTS, 0, new Uint32Array(NPTS * PW));
    this.resets++;
  }
  /** the selected point's marker drawn gold (-1 none; the mesh's next run) */
  select(slot: number): void {
    this.sel = slot;
  }

  dispose(): void {
    this.dead = true;
    this.qs?.destroy();
    for (const b of this.all) b.destroy();
  }

  /** run from `from` (runs queue: one at a time); φ over `box` only when given (a point's change) */
  run(p: StreetParams, from: Stage, box?: Box): Promise<StreetTimes> {
    const r = this.busy.then(() => this.once(p, from, box));
    this.busy = r.catch(() => undefined);
    return r;
  }

  private slot(u: Uni): number {
    if (this.nPass >= MAX_PASSES) throw new Error(`streetlab: more than ${MAX_PASSES} passes in a run`);
    const i = this.nPass++;
    const dv = new DataView(this.uniData, i * SLOT, UNI_BYTES);
    const p = this.p;
    const { w, h, centre } = this.world;
    const spokes = Math.max(6, Math.round((Math.PI * p.townR) / (2 * p.ringSpacing)));
    [w, h, u.k ?? 0, u.mode ?? 0, u.count ?? 0, VERT_ROOM, families(p.majors, p.cross), this.seeds[0]].forEach((v, j) => dv.setUint32(j * 4, v >>> 0, true));
    const f = [
      p.majorSpacing, p.ringSpacing, spokes, p.blockLen,
      p.majorWidth, p.minorWidth, p.setback, p.height,
      p.maxLot, p.minLot, p.cliff, this.seeds[1],
      centre[0], centre[1], p.townR, p.stairs,
      p.blend, p.pointR, p.strength, p.autoPts,
    ];
    f.forEach((v, j) => dv.setFloat32(32 + j * 4, v, true));
    [u.box?.[0] ?? 0, u.box?.[1] ?? 0, PHI_MODE[p.majors], p.cross].forEach((v, j) => dv.setUint32(112 + j * 4, v >>> 0, true));
    [p.band, p.grade, p.shape, this.sel + 1].forEach((v, j) => dv.setFloat32(128 + j * 4, v, true));
    [p.bad, p.lmMult, p.lmN, p.lmKind].forEach((v, j) => dv.setFloat32(144 + j * 4, v, true));
    [p.lmRmin, p.lmRmax, 0, 0].forEach((v, j) => dv.setFloat32(160 + j * 4, v, true));
    return i;
  }

  private k(name: Kernel, u: Uni, bufs: Bufs, wx: number, wy = 1, args = false): void {
    const i = this.slot(u);
    const entries: Record<number, GPUBuffer | GPUBufferBinding> = { 0: { buffer: this.uni, offset: i * SLOT, size: UNI_BYTES }, 8: args ? this.args : this.dummies[7] };
    for (let b = 1; b <= 7; b++) entries[b] = bufs[b as 1] ?? this.dummies[b - 1];
    this.cp.setPipeline(this.pipes[name]);
    this.cp.setBindGroup(0, makeBindGroup(this.device, `streetlab ${name}`, this.layout, entries));
    this.cp.dispatchWorkgroups(Math.max(1, wx), Math.max(1, wy));
    this.dispatches++;
  }
  /** one thread a column (over `box` when given) */
  private k2(name: Kernel, u: Uni, bufs: Bufs, args = false, box?: Box): void {
    if (box) return this.k(name, { ...u, box: [box[0], box[1]] }, bufs, Math.ceil((box[2] - box[0]) / 8), Math.ceil((box[3] - box[1]) / 8), args);
    this.k(name, u, bufs, Math.ceil(this.world.w / 8), Math.ceil(this.world.h / 8), args);
  }
  /** one thread a seed (its trace, its block) */
  private kT(name: Kernel, u: Uni, bufs: Bufs, args = false): void {
    this.k(name, u, bufs, Math.ceil((this.seeds[0] * this.seeds[1]) / 64), 1, args);
  }
  private fill(dst: GPUBuffer, count: number, value: number, offset = 0): void {
    this.k('fill', { count, k: value, box: [offset, 0] }, { 5: dst }, Math.ceil(count / 64));
  }
  /** a jump flood of `src`'s seeds through `tmp`: the buffer that holds it */
  private jfa(src: GPUBuffer, tmp: GPUBuffer): GPUBuffer {
    let a = src;
    let b = tmp;
    let k = 1;
    while (k * 2 < Math.max(this.world.w, this.world.h)) k *= 2;
    for (; k >= 1; k >>= 1) {
      this.k2('jfa', { k }, { 1: a, 5: b });
      [a, b] = [b, a];
    }
    // (one more at step 1: JFA+1)
    this.k2('jfa', { k: 1 }, { 1: a, 5: b });
    return b;
  }
  private blur(src: GPUBuffer, dst: GPUBuffer, r: number, times: number): void {
    for (let t = 0; t < times; t++) {
      this.k2('blur', { k: r, mode: 0 }, { 1: t ? dst : src, 5: this.B.TB });
      this.k2('blur', { k: r, mode: 1 }, { 1: this.B.TB, 5: dst });
    }
  }
  private pass(stage: (typeof ALL)[number]): GPUComputePassDescriptor {
    const s = ALL.indexOf(stage) * 2;
    return { label: `streetlab ${stage}`, timestampWrites: this.qs ? { querySet: this.qs, beginningOfPassWriteIndex: s, endOfPassWriteIndex: s + 1 } : undefined };
  }
  /** (m3b) the vector jump floods: the seeds on the lines, thinned, flooded by line parity; each seed's cross street and
   *  the block to the next one along its line */
  private vectorCross(): void {
    const B = this.B;
    const N = this.world.w * this.world.h;
    const p = this.p;
    this.fill(B.OCC, this.occWords(Math.max(MIN_BLOCK, p.blockLen)), NONE);
    this.kT('vseed', {}, { 4: B.FD, 5: B.SD, 6: B.OCC });
    this.kT('vthin', {}, { 2: B.OCC, 5: B.SD });
    this.fill(B.JE0, N, NONE);
    this.fill(B.JO0, N, NONE);
    this.kT('vrast', {}, { 1: B.SD, 5: B.JE0, 7: B.JO0 });
    // (the floods only need to reach about a line spacing: the lookups are within that of a seed)
    const reach = p.majors < 3 ? p.majorSpacing : p.ringSpacing;
    let k = 1;
    while (k < reach) k *= 2;
    let [ea, oa, eb, ob] = [B.JE0, B.JO0, B.JE1, B.JO1];
    for (let s = k; s >= 1; s >>= 1) {
      this.k2('vjfa', { k: s }, { 1: ea, 2: oa, 3: B.SD, 5: eb, 7: ob });
      [ea, oa, eb, ob] = [eb, ob, ea, oa];
    }
    this.k2('vjfa', { k: 1 }, { 1: ea, 2: oa, 3: B.SD, 5: eb, 7: ob });
    this.kT('vseg', {}, { 2: eb, 3: ob, 4: B.FD, 5: B.SD });
    this.kT('vnext', {}, { 2: eb, 3: ob, 4: B.FD, 5: B.SD });
    // (m3e) the busy junctions: their streets counted and their smallest angle, a landmark site each (the bigger of
    // two that overlap kept), every cross street clipped at the sites
    const T = this.seeds[0] * this.seeds[1];
    if (p.lmMult > 0) {
      this.fill(B.JC, T, 0);
      // (the angles start at 10 rad, as f32 bits: more than any angle)
      this.fill(B.JC, T, 0x41200000, T);
      this.kT('jstat', {}, { 1: B.SD, 6: B.JC });
      this.kT('lmlist', {}, { 1: B.SD, 2: B.JC, 6: B.LM });
      this.k('lmprune', {}, { 5: B.LM }, 1);
      this.kT('vclip', {}, { 2: B.LM, 5: B.SD });
    }
    this.kT('vblock', {}, { 1: B.SD, 5: B.BQ, 7: B.AL1 });
    // (m3d) the bad blocks: found, then merged (a claim each on a good neighbour, the lowest seed wins) or paved
    // (MERGE_ROUNDS rounds — a fan's triangles merge in pairs, then the pairs — then what's still bad is paved)
    for (let r = 0; r <= MERGE_ROUNDS; r++) {
      this.kT('bqual', { mode: 0 }, { 1: B.SD, 5: B.BQ });
      this.kT('bqual', { mode: r === MERGE_ROUNDS ? 2 : 1 }, { 1: B.SD, 5: B.BQ });
      if (r === MERGE_ROUNDS || p.bad !== 0) break;
      this.fill(B.AL0, T, NONE);
      this.kT('bclaim', {}, { 1: B.SD, 5: B.BQ, 6: B.AL0 });
      this.kT('bapply', {}, { 1: B.SD, 2: B.AL0, 5: B.BQ, 7: B.AL1 });
    }
  }

  private async once(p: StreetParams, from0: Stage, box0?: Box): Promise<StreetTimes> {
    if (this.dead) throw new Error('streetlab: disposed');
    this.p = p;
    this.nPass = 0;
    this.dispatches = 0;
    const { device } = this;
    const { w, h } = this.world;
    const B = this.B;
    const enc = device.createCommandEncoder({ label: 'streetlab run' });
    const firstHeights = !this.haveHeights;
    // (the first run makes everything; a new block length a new seed lattice)
    const from: Stage = firstHeights ? 'field' : from0;
    const box = from === 'phi' && box0 ? clip(box0, w, h) : null;
    this.seeds = this.lattice(Math.max(MIN_BLOCK, p.blockLen));
    const runs = (s: Stage) => STAGES.indexOf(s) >= STAGES.indexOf(from);
    const vector = p.cross === 0;
    // (m3c: the heights the lab uses — terraced, or the ground's own)
    const HH = p.shape === 1 ? B.HT : B.H;
    // the ground's heights and the water, once (the land doesn't change yet: later, on dirty chunks only)
    if (firstHeights) {
      const cp = enc.beginComputePass(this.pass('height'));
      const W = this.world;
      cp.setPipeline(this.heightK.pipeline);
      cp.setBindGroup(0, makeBindGroup(device, 'streetlab height', this.heightK.layout, { 0: W.globals, 1: W.chunks, 3: W.layers, 4: W.water, 5: B.H, 6: B.M }));
      cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      cp.end();
      this.haveHeights = true;
    }
    // large: smoothed heights, the blocked mask, the smoothed distance to water and cliffs
    if (runs('field')) {
      this.cp = enc.beginComputePass(this.pass('field'));
      if (p.shape === 1) this.k2('shape', {}, { 1: B.H, 5: B.HT });
      this.blur(HH, B.HS, 2, 2);
      this.k2('feat', {}, { 1: B.HS, 2: B.M, 5: B.S0, 7: B.BLK });
      const fr = this.jfa(B.S0, B.S1);
      this.k2('jdist', {}, { 1: fr, 5: B.T0 });
      this.blur(B.T0, B.FDB, 5, 3);
      this.cp.end();
    }
    // (m3a) the points (placed, their offsets) and φ — over a changed point's box only, when that's all that changed
    if (runs('phi')) {
      this.cp = enc.beginComputePass(this.pass('phi'));
      // (the auto points placed again only when what they're placed from changed — the field, their radius, the town,
      // their count, a reset; otherwise they stay and only the offsets are made again)
      const key = `${p.pointR},${p.townR},${p.autoPts},${this.resets}`;
      const place = runs('field') || key !== this.placed;
      this.placed = key;
      this.k('autoPts', { mode: place ? 0 : 1 }, { 1: B.HS, 2: B.FDB, 3: B.BLK, 5: B.PTS }, 1);
      this.k2('phi', {}, { 1: B.FDB, 2: B.BLK, 3: B.PTS, 5: B.FD }, false, box ?? undefined);
      // (the tensor field the traces follow: its gradients a column either side, so one wider)
      if (!vector) this.k2('tensor', {}, { 4: B.FD, 5: B.TX, 7: B.TY }, false, box ? clip([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1], w, h) : undefined);
      this.cp.end();
    }
    // medium: the cross streets, the blocks
    if (runs('trace')) {
      this.cp = enc.beginComputePass(this.pass('trace'));
      this.fill(B.LM, 1, 0);
      if (vector) this.vectorCross();
      else {
        this.kT('trace', {}, { 1: B.TX, 2: B.TY, 4: B.FD, 5: B.TR, 7: B.AL0 });
        for (let r = 0; r < MIS_ROUNDS; r++) {
          const [a, b] = r % 2 ? [B.AL1, B.AL0] : [B.AL0, B.AL1];
          this.kT('mis', {}, { 1: B.TR, 2: a, 5: b });
        }
        this.kT('blocks', {}, { 1: B.TR, 2: B.AL0, 4: B.FD, 5: B.BQ });
      }
      this.cp.end();
    }
    // fine: the lots
    if (runs('lots')) {
      this.cp = enc.beginComputePass(this.pass('lots'));
      this.k('fill', { count: 4, k: 0 }, { 5: B.CNT }, 1);
      this.k('lots', { count: LOT_ROOM }, { 1: B.BQ, 5: B.LOTS, 6: B.CNT }, Math.ceil((3 * this.seeds[0] * this.seeds[1]) / 64));
      this.cp.end();
    }
    // the mesh: roads, lots and the points' markers
    enc.clearBuffer(this.args, 0, 4);
    this.cp = enc.beginComputePass(this.pass('mesh'));
    this.k2('roadMajor', {}, { 1: B.LM, 3: HH, 4: B.FD, 7: this.verts }, true);
    // (one thread a street's piece: eight a vector street, TP a trace)
    if (vector) this.k('vroad', {}, { 1: B.SD, 2: B.AL1, 3: HH, 7: this.verts }, Math.ceil((this.seeds[0] * this.seeds[1] * 8) / 64), 1, true);
    else this.k('roadMinor', {}, { 1: B.TR, 2: B.AL0, 3: HH, 7: this.verts }, this.seeds[0] * this.seeds[1], 1, true);
    this.k('lotMesh', { count: LOT_ROOM }, { 1: B.LOTS, 2: B.CNT, 3: HH, 4: B.FD, 5: B.LM, 7: this.verts }, Math.ceil(LOT_ROOM / 64), 1, true);
    if (vector && p.lmMult > 0) this.k('lmMesh', {}, { 1: B.LM, 3: HH, 7: this.verts }, (64 * 48) / 64, 1, true);
    if (PHI_MODE[p.majors] !== 0) this.k('marks', { mode: this.sel + 1 }, { 1: B.PTS, 3: HH, 7: this.verts }, 1, 1, true);
    // (m3c: the shaped ground's skin, its bands tinted; the cart road)
    if (p.shape > 0) this.k2('ground', {}, { 1: B.H, 3: HH, 4: B.FD, 7: this.verts }, true);
    if (p.shape > 1) this.k2('roadShape', {}, { 1: B.HS, 2: B.PTS, 3: HH, 4: B.FD, 7: this.verts }, true);
    this.k('meshCap', {}, {}, 1, 1, true);
    this.cp.end();
    device.queue.writeBuffer(this.uni, 0, this.uniData, 0, this.nPass * SLOT);
    const n = ALL.length * 2;
    if (this.qs) {
      enc.resolveQuerySet(this.qs, 0, n, this.qRes!, 0);
      enc.copyBufferToBuffer(this.qRes!, 0, this.qRead, 0, n * 8);
    }
    enc.copyBufferToBuffer(B.CNT, 0, this.qRead, n * 8, 4);
    enc.copyBufferToBuffer(this.args, 0, this.qRead, n * 8 + 4, 4);
    enc.copyBufferToBuffer(B.PTS, 0, this.qRead, n * 8 + 16, NPTS * PW * 4);
    device.queue.submit([enc.finish()]);
    await this.qRead.mapAsync(GPUMapMode.READ);
    const raw = this.qRead.getMappedRange().slice(0);
    this.qRead.unmap();
    const t = new BigUint64Array(raw, 0, n);
    const c = new Uint32Array(raw, n * 8, 2);
    const pf = new Float32Array(raw, n * 8 + 16, NPTS * PW);
    const pu = new Uint32Array(raw, n * 8 + 16, NPTS * PW);
    this.points = Array.from({ length: NPTS }, (_, i) => ({ slot: i, x: pf[i * PW], y: pf[i * PW + 1], intensity: pf[i * PW + 2], flag: pu[i * PW + 4], alive: pu[i * PW + 5] === 1 }));
    const ms = (s: number) => Number(t[s * 2 + 1] - t[s * 2]) / 1e6;
    // (which of height and the stages ran: the mesh always)
    const ran = (i: number) => (i === 0 ? firstHeights : i === ALL.length - 1 || runs(ALL[i] as Stage));
    const stage = Object.fromEntries(STAGES.map((s, j) => [s, this.qs && ran(j + 1) ? ms(j + 1) : null])) as Record<Stage, number | null>;
    const first = ALL.findIndex((_, i) => ran(i));
    return {
      from,
      box,
      height: this.qs && firstHeights ? ms(0) : null,
      stage,
      total: this.qs ? Number(t[n - 1] - t[first * 2]) / 1e6 : null,
      lots: Math.min(c[0], LOT_ROOM),
      verts: c[1],
    };
  }
}

/** a box clipped to the window's columns */
function clip(b: Box, w: number, h: number): Box {
  return [Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(w, Math.ceil(b[2])), Math.min(h, Math.ceil(b[3]))];
}
