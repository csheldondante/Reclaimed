// (street lab, milestone 2: option B) The street lab's GPU runner: the window's ground heights and water read from the
// world's own buffers (height.wgsl, at load), then the streets, blocks, lots and their mesh (streets.wgsl) — every pass
// on the GPU; the CPU writes the passes' numbers and encodes the dispatches. A run starts at the first stage a change
// needs (fields → traces → lots → mesh); what the stages before it made stays in their buffers. The one read back is
// the run's timestamps and two counts (104 bytes, after a run — never a frame's). It owns its buffers; it knows the
// world only through StreetWorld.
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import heightWgsl from './height.wgsl?raw';
import streetsWgsl from './streets.wgsl?raw';
import { makeBindGroup, makeCompute, makeLayout, makeModule, type ComputeKernel } from '../gpu/pipeline';
import { ROW_H } from '../world/lattice';

/** what the major lines are: the distance to water and cliffs' contours, rings and spokes, or both */
export const MAJORS = ['distance contours', 'radial (rings, spokes)', 'both'] as const;
const FAMILIES = [1, 2 | 4, 1 | 2 | 4];

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
}

/** the stages a run can start at: a change reruns its stage and the ones after */
export const STAGES = ['field', 'trace', 'lots', 'mesh'] as const;
export type Stage = (typeof STAGES)[number];

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
  height: number | null;
  stage: Record<Stage, number | null>;
  total: number | null;
  lots: number;
  verts: number;
}

const SLOT = 256;
const MAX_PASSES = 256;
const UNI_BYTES = 96;
const KERNELS = ['fill', 'blur', 'feat', 'jfa', 'jdist', 'fdpack', 'tensor', 'trace', 'mis', 'blocks', 'lots', 'roadMajor', 'roadMinor', 'lotMesh', 'meshCap'] as const;
type Kernel = (typeof KERNELS)[number];
/** streets.wgsl TRW, BQW, LW (words a trace, a block, a lot) */
const TRW = 144;
const BQW = 12;
const LW = 10;
/** the shortest block length the buffers have room for (the seed lattice half of it) */
export const MIN_BLOCK = 8;
/** room: lots, vertices (32 bytes each) */
const LOT_ROOM = 32768;
const VERT_ROOM = 1_200_000;
/** conflict rounds between the traces (a greedy independent set: even, so the kept end in AL0) */
const MIS_ROUNDS = 4;
const ALL = ['height', ...STAGES] as const;

interface Uni {
  k?: number;
  mode?: number;
  count?: number;
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
    for (const n of ['H', 'M', 'HS', 'TB', 'T0', 'FDB', 'FD', 'S0', 'S1', 'BLK', 'TX', 'TY']) this.B[n] = buf(n, N * 4);
    const [mx, my] = this.lattice(MIN_BLOCK);
    const T = mx * my;
    this.B.TR = buf('traces', T * TRW * 4);
    this.B.AL0 = buf('kept a', T * 4);
    this.B.AL1 = buf('kept b', T * 4);
    this.B.BQ = buf('blocks', 3 * T * BQW * 4);
    this.B.LOTS = buf('lots', LOT_ROOM * LW * 4);
    this.B.CNT = buf('lot count', 16);
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
    // (the stamps, then the lots' count and the vertices')
    this.qRead = buf('stamps read', n * 8 + 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  }

  /** the seed lattice for a block length: spacing half of it, across and down the window */
  private lattice(blockLen: number): [number, number] {
    const sp = blockLen / 2;
    return [Math.ceil((this.world.w + 0.5) / sp), Math.ceil((this.world.h * ROW_H) / sp)];
  }

  dispose(): void {
    this.dead = true;
    this.qs?.destroy();
    for (const b of this.all) b.destroy();
  }

  /** run from `from` (runs queue: one at a time) */
  run(p: StreetParams, from: Stage): Promise<StreetTimes> {
    const r = this.busy.then(() => this.once(p, from));
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
    [w, h, u.k ?? 0, u.mode ?? 0, u.count ?? 0, VERT_ROOM, FAMILIES[p.majors], this.seeds[0]].forEach((v, j) => dv.setUint32(j * 4, v >>> 0, true));
    const f = [
      p.majorSpacing, p.ringSpacing, spokes, p.blockLen,
      p.majorWidth, p.minorWidth, p.setback, p.height,
      p.maxLot, p.minLot, p.cliff, this.seeds[1],
      centre[0], centre[1], p.townR, p.stairs,
    ];
    f.forEach((v, j) => dv.setFloat32(32 + j * 4, v, true));
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
  /** one thread a column */
  private k2(name: Kernel, u: Uni, bufs: Bufs, args = false): void {
    this.k(name, u, bufs, Math.ceil(this.world.w / 8), Math.ceil(this.world.h / 8), args);
  }
  /** one thread a seed (its trace, its block) */
  private kT(name: Kernel, u: Uni, bufs: Bufs, args = false): void {
    this.k(name, u, bufs, Math.ceil((this.seeds[0] * this.seeds[1]) / 64), 1, args);
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

  private async once(p: StreetParams, from0: Stage): Promise<StreetTimes> {
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
    this.seeds = this.lattice(Math.max(MIN_BLOCK, p.blockLen));
    const runs = (s: Stage) => STAGES.indexOf(s) >= STAGES.indexOf(from);
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
      this.blur(B.H, B.HS, 2, 2);
      this.k2('feat', {}, { 1: B.HS, 2: B.M, 5: B.S0, 7: B.BLK });
      const fr = this.jfa(B.S0, B.S1);
      this.k2('jdist', {}, { 1: fr, 5: B.T0 });
      this.blur(B.T0, B.FDB, 5, 3);
      // (the blocked mask packed in: the distance negative there)
      this.k2('fdpack', {}, { 1: B.FDB, 2: B.BLK, 5: B.FD });
      // (the tensor field the traces follow: it reads the families' fields, so it's made with them)
      this.k2('tensor', {}, { 4: B.FD, 5: B.TX, 7: B.TY });
      this.cp.end();
    }
    // medium: the traces, their conflicts, the blocks
    if (runs('trace')) {
      this.cp = enc.beginComputePass(this.pass('trace'));
      this.kT('trace', {}, { 1: B.TX, 2: B.TY, 4: B.FD, 5: B.TR, 7: B.AL0 });
      for (let r = 0; r < MIS_ROUNDS; r++) {
        const [a, b] = r % 2 ? [B.AL1, B.AL0] : [B.AL0, B.AL1];
        this.kT('mis', {}, { 1: B.TR, 2: a, 5: b });
      }
      this.kT('blocks', {}, { 1: B.TR, 2: B.AL0, 4: B.FD, 5: B.BQ });
      this.cp.end();
    }
    // fine: the lots
    if (runs('lots')) {
      this.cp = enc.beginComputePass(this.pass('lots'));
      this.k('fill', { count: 4, k: 0 }, { 5: B.CNT }, 1);
      this.k('lots', { count: LOT_ROOM }, { 1: B.BQ, 5: B.LOTS, 6: B.CNT }, Math.ceil((3 * this.seeds[0] * this.seeds[1]) / 64));
      this.cp.end();
    }
    // the mesh: roads and lots
    enc.clearBuffer(this.args, 0, 4);
    this.cp = enc.beginComputePass(this.pass('mesh'));
    this.k2('roadMajor', {}, { 3: B.H, 4: B.FD, 7: this.verts }, true);
    // (one thread a trace's segment: TP a trace)
    this.k('roadMinor', {}, { 1: B.TR, 2: B.AL0, 3: B.H, 7: this.verts }, this.seeds[0] * this.seeds[1], 1, true);
    this.k('lotMesh', { count: LOT_ROOM }, { 1: B.LOTS, 2: B.CNT, 3: B.H, 4: B.FD, 7: this.verts }, Math.ceil(LOT_ROOM / 64), 1, true);
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
    device.queue.submit([enc.finish()]);
    await this.qRead.mapAsync(GPUMapMode.READ);
    const raw = this.qRead.getMappedRange().slice(0);
    this.qRead.unmap();
    const t = new BigUint64Array(raw, 0, n);
    const c = new Uint32Array(raw, n * 8, 2);
    const ms = (s: number) => Number(t[s * 2 + 1] - t[s * 2]) / 1e6;
    // (which of height, field, trace, lots, mesh ran: the mesh always)
    const ran = (i: number) => (i === 0 ? firstHeights : i === ALL.length - 1 || runs(ALL[i] as Stage));
    const stage = Object.fromEntries(STAGES.map((s, j) => [s, this.qs && ran(j + 1) ? ms(j + 1) : null])) as Record<Stage, number | null>;
    const first = ALL.findIndex((_, i) => ran(i));
    return {
      from,
      height: this.qs && firstHeights ? ms(0) : null,
      stage,
      total: this.qs ? Number(t[n - 1] - t[first * 2]) / 1e6 : null,
      lots: Math.min(c[0], LOT_ROOM),
      verts: c[1],
    };
  }
}
