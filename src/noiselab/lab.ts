// (round 111, BACKLOG TG1) The noise lab's GPU runner: a recipe (params.ts) evaluated over a w × h map of columns
// (lab.wgsl), read back as one record a column — height, cave, materials. It owns its buffers and knows nothing of
// the world: what the record becomes (columns, water, the preview) is columns.ts's and the level's.
//
// A run: the layers in segments split at each field layer (slope, JFA), the field made between (a JFA: seeds on the
// source's contour, log2 passes, one more at step 1), then the finish. One run at a time; a run asked for while one
// is in flight waits, and only the latest asked-for values run (a slider dragged doesn't queue up runs).

import noiseW from '../atlas/noise.wgsl?raw';
import labW from './lab.wgsl?raw';
import { makeLayout, makeModule } from '../gpu/pipeline';
import { FIELD_GENS, GEN, LAYERS, LAYER_FLOATS, labValues, layerWgsl, matOf, packLayers, type LabValues } from './params';
import { MAT } from '../world/materials';
import { bootMark } from '../perf/boot-marks';

/** a column's record: height, its gaps (floor, roof; 0, 0: none), materials (top + rock·64 + cliff·4096, joined·8192
 *  when a column had more gaps than it keeps and some joined, cut·16384 when a carve opened it down to a floor) */
export interface LabResult {
  w: number;
  h: number;
  /** COL_FLOATS a column, row-major (y · w + x): height, gap 0 floor, roof, materials, gap 1 floor, roof, gap 2 floor, roof */
  cols: Float32Array;
  /** (round 112) each layer's output at every THUMB-th column: LAYERS × tw × th × (value, mask weight) */
  thumbs: Float32Array;
  tw: number;
  th: number;
  /** the run's time from submit to the record read (ms) */
  ms: number;
  passes: number;
}

/** floats a column's record */
export const COL_FLOATS = 8;
/** the stack's thumbnails sample every THUMB-th column */
export const THUMB = 4;
const SLOT = 256;
const MAX_PASSES = 160;
const KERNELS = ['labEval', 'labSlope', 'labSeed', 'labJfa', 'labJfaDone', 'labFinish'] as const;
type Kernel = (typeof KERNELS)[number];

interface Pass {
  k: Kernel;
  l0?: number;
  l1?: number;
  layer?: number;
  step?: number;
  flip?: number;
  src?: number;
  level?: number;
}

export class NoiseLabGpu {
  private pipes!: Record<Kernel, GPUComputePipeline>;
  private groups: GPUBindGroup[] = [];
  private uni: GPUBuffer;
  private lp: GPUBuffer;
  private bufs: GPUBuffer[];
  private out: GPUBuffer;
  private read: GPUBuffer;
  private thumbs: GPUBuffer;
  private thumbRead: GPUBuffer;
  readonly tw: number;
  readonly th: number;
  private busy = false;
  private want?: { v: LabValues; res: ((r: LabResult) => void)[]; rej: ((e: unknown) => void)[] };
  private dead = false;
  readonly ready: Promise<void>;

  constructor(
    private device: GPUDevice,
    readonly w: number,
    readonly h: number,
    readonly zMax: number,
  ) {
    const N = w * h;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.uni = device.createBuffer({ label: 'lab passes', size: SLOT * MAX_PASSES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lp = device.createBuffer({ label: 'lab layers', size: LAYERS * LAYER_FLOATS * 4, usage: S });
    const st = device.createBuffer({ label: 'lab state', size: N * 32, usage: S });
    const fields = device.createBuffer({ label: 'lab fields', size: N * 16 * LAYERS, usage: S });
    const jA = device.createBuffer({ label: 'lab jfa a', size: N * 16, usage: S });
    const jB = device.createBuffer({ label: 'lab jfa b', size: N * 16, usage: S });
    this.out = device.createBuffer({ label: 'lab columns', size: N * COL_FLOATS * 4, usage: S });
    this.read = device.createBuffer({ label: 'lab columns read', size: N * COL_FLOATS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const gaps = device.createBuffer({ label: 'lab gaps', size: N * 32, usage: S });
    this.tw = Math.ceil(w / THUMB);
    this.th = Math.ceil(h / THUMB);
    const tb = LAYERS * this.tw * this.th * 8;
    this.thumbs = device.createBuffer({ label: 'lab thumbs', size: tb, usage: S });
    this.thumbRead = device.createBuffer({ label: 'lab thumbs read', size: tb, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.bufs = [st, fields, jA, jB, this.out, gaps, this.thumbs];
    const layout = makeLayout(device, 'lab', { 0: 'uniform', 1: 'read', 2: 'rw', 3: 'rw', 4: 'rw', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' }, GPUShaderStage.COMPUTE);
    for (let i = 0; i < MAX_PASSES; i++) {
      this.groups.push(
        device.createBindGroup({
          label: `lab pass ${i}`,
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.uni, offset: i * SLOT, size: 112 } },
            { binding: 1, resource: { buffer: this.lp } },
            ...this.bufs.map((b, k) => ({ binding: k + 2, resource: { buffer: b } })),
          ],
        }),
      );
    }
    const module = makeModule(device, 'noise lab', [layerWgsl(), noiseW, labW]);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.ready = Promise.all(KERNELS.map((k) => device.createComputePipelineAsync({ label: `lab ${k}`, layout: pl, compute: { module, entryPoint: k } }))).then((ps) => {
      this.pipes = Object.fromEntries(KERNELS.map((k, i) => [k, ps[i]])) as Record<Kernel, GPUComputePipeline>;
      bootMark('lab-pipelines');
    });
  }

  /** run the recipe (the latest asked for wins while one runs) */
  run(v: LabValues = labValues()): Promise<LabResult> {
    const snap = JSON.parse(JSON.stringify(v)) as LabValues;
    return new Promise((res, rej) => {
      if (this.want) {
        this.want.v = snap;
        this.want.res.push(res);
        this.want.rej.push(rej);
      } else this.want = { v: snap, res: [res], rej: [rej] };
      void this.pump();
    });
  }

  dispose(): void {
    this.dead = true;
    for (const b of [this.uni, this.lp, this.read, this.thumbRead, ...this.bufs]) b.destroy();
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.want) return;
    this.busy = true;
    const job = this.want;
    this.want = undefined;
    try {
      await this.ready;
      const r = await this.once(job.v);
      job.res.forEach((f) => f(r));
    } catch (e) {
      job.rej.forEach((f) => f(e));
    } finally {
      this.busy = false;
      if (this.want && !this.dead) void this.pump();
    }
  }

  /** the passes a recipe needs */
  private plan(v: LabValues): Pass[] {
    const passes: Pass[] = [];
    let from = 0;
    const jfaSteps: number[] = [];
    for (let s = 1 << Math.ceil(Math.log2(Math.max(this.w, this.h))); s >= 1; s >>= 1) jfaSteps.push(s);
    jfaSteps.push(1);
    for (let l = 0; l < LAYERS; l++) {
      const L = v[`L${l + 1}`];
      if (!L.on || L.mute || !FIELD_GENS.includes(L.gen)) continue;
      // (the layers before it, then its field)
      passes.push({ k: 'labEval', l0: from, l1: l });
      from = l;
      if (L.gen === GEN.slope) passes.push({ k: 'labSlope', layer: l });
      else {
        const src = Math.round(L.src);
        passes.push({ k: 'labSeed', layer: l, src, level: L.level });
        jfaSteps.forEach((step, i) => passes.push({ k: 'labJfa', layer: l, step, flip: i & 1, src, level: L.level }));
        passes.push({ k: 'labJfaDone', layer: l, flip: jfaSteps.length & 1, src, level: L.level });
      }
    }
    passes.push({ k: 'labEval', l0: from, l1: LAYERS });
    passes.push({ k: 'labFinish' });
    // (an empty segment's eval still copies the state through: from 0 it starts the state)
    return passes;
  }

  private async once(v: LabValues): Promise<LabResult> {
    const { device, w, h } = this;
    const passes = this.plan(v);
    if (passes.length > MAX_PASSES) throw new Error(`noise lab: ${passes.length} passes (> ${MAX_PASSES})`);
    const lab = v.lab;
    const u = new ArrayBuffer(SLOT * passes.length);
    passes.forEach((p, i) => {
      const U = new Uint32Array(u, i * SLOT, 28);
      const F = new Float32Array(u, i * SLOT, 28);
      U[0] = w;
      U[1] = h;
      U[2] = p.l0 ?? 0;
      U[3] = p.l1 ?? 0;
      U[4] = p.layer ?? 0;
      new Int32Array(u, i * SLOT, 28)[5] = p.step ?? 0;
      U[6] = p.flip ?? 0;
      U[7] = p.src ?? 0;
      F[8] = p.level ?? 0;
      U[9] = Math.round(lab.seed);
      F[10] = lab.base;
      F[11] = lab.sea;
      F[12] = lab.view;
      F[13] = lab.cliffSlope;
      F[14] = lab.beachH;
      F[15] = lab.snowZ >= 128 ? 1e9 : lab.snowZ;
      F[16] = lab.caveRoof;
      F[17] = lab.caveMin;
      F[18] = this.zMax;
      U[19] = lab.paint ? 1 : 0;
      U[20] = matOf(lab.topMat);
      U[21] = matOf(lab.rockMat);
      U[22] = matOf(lab.cliffMat);
      U[23] = matOf(lab.beachMat);
      U[24] = matOf(lab.paintMat);
      U[25] = MAT.Snow;
      U[26] = THUMB;
      U[27] = this.tw;
    });
    device.queue.writeBuffer(this.uni, 0, u);
    device.queue.writeBuffer(this.lp, 0, packLayers(v));
    const enc = device.createCommandEncoder({ label: 'noise lab' });
    // (a layer that doesn't run leaves no thumbnail)
    enc.clearBuffer(this.thumbs);
    const gx = Math.ceil(w / 8);
    const gy = Math.ceil(h / 8);
    passes.forEach((p, i) => {
      const cp = enc.beginComputePass({ label: `lab ${p.k}` });
      cp.setPipeline(this.pipes[p.k]);
      cp.setBindGroup(0, this.groups[i]);
      cp.dispatchWorkgroups(gx, gy);
      cp.end();
    });
    enc.copyBufferToBuffer(this.out, 0, this.read, 0, w * h * COL_FLOATS * 4);
    enc.copyBufferToBuffer(this.thumbs, 0, this.thumbRead, 0, this.thumbs.size);
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await Promise.all([this.read.mapAsync(GPUMapMode.READ), this.thumbRead.mapAsync(GPUMapMode.READ)]);
    const cols = new Float32Array(this.read.getMappedRange().slice(0));
    this.read.unmap();
    const thumbs = new Float32Array(this.thumbRead.getMappedRange().slice(0));
    this.thumbRead.unmap();
    return { w, h, cols, thumbs, tw: this.tw, th: this.th, ms: performance.now() - t0, passes: passes.length };
  }
}
