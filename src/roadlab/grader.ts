// (road lab, RD1) The road grader: road path records (api/contracts/roadpath.ts) on the GPU, and the kernel that lays a
// road into the columns once (shaders/roadgrade.wgsl roadLay: cut, fill, banks, the surface interval) and paves it
// later (roadPave: dirt → cobble). It owns its buffers; it writes only WorldGpu.layers (the contract buffer every
// column pass shares) through the chunk table, bumping the chunks' versions like any column writer, and clears the
// plants' field (veg, vegNext) under what it changed.
// Reads: the stats, 32 bytes, once after a lay (DESIGN §24: small, async, after an edit) — what the lab reports.
//
// (loop-streets) GradeLayer: the same lay for records someone else made on the GPU (a town's: citygen streets.wgsl
// gradeRecs, in its grid's frame), over a window rectangle at a time, the frame placed in the window — what the town's
// claims' `claimed` hook runs as land arrives (docs/design/CITYGEN.md "Streets as terrain"). Nothing read back.

import { makeBindGroup, makeCompute, whenPipelinesReady, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import roadpathWgsl from '../shaders/roadpath.wgsl?raw';
import roadgradeWgsl from '../shaders/roadgrade.wgsl?raw';
import { packRoads, roadColumnBox, type RoadRecord } from '../api/contracts/roadpath';
import type { WorldGpu } from '../sim/world-gpu';

/** what a lay changed (roadgrade.wgsl rstats) */
export interface GradeStats {
  touched: number;
  roadCols: number;
  shoulderCols: number;
  /** the most intervals a written column holds */
  maxIntervals: number;
  /** columns folded to fit their chunk's K */
  folded: number;
  /** columns left alone (a structure road's ground beyond maxDz) */
  left: number;
  /** the most K (slots a column) of the chunks it wrote */
  maxK: number;
  /** the most ground moved, cells */
  maxMove: number;
}

const STAT_WORDS = 8;
/** roadgrade.wgsl GradeParams: road, n, x0, y0, x1, y1, gx, gy (i32), gz (f32), 3 unused */
const PARAM_BYTES = 48;

/** the world buffers a lay binds */
export type GradeWorld = Pick<WorldGpu, 'globals' | 'chunks' | 'materials' | 'layers' | 'veg' | 'vegNext' | 'water'>;

const SPEC = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'rw', 4: 'read', 5: 'uniform', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'read' } as const;
const PARTS = [commonWgsl, layersWgsl, materialsWgsl, roadpathWgsl, roadgradeWgsl];

/** a lay's parameters (roadgrade.wgsl GradeParams) */
function gradeParams(road: number, n: number, box: readonly [number, number, number, number], gx = 0, gy = 0, gz = 0): ArrayBuffer {
  const a = new ArrayBuffer(PARAM_BYTES);
  new Uint32Array(a).set([road, n, box[0], box[1], box[2], box[3]]);
  new Int32Array(a).set([gx, gy], 6);
  new Float32Array(a)[8] = gz;
  return a;
}

function decodeStats(s: Uint32Array): GradeStats {
  return { touched: s[0], roadCols: s[1], shoulderCols: s[2], maxIntervals: s[3], folded: s[4], left: s[5], maxK: s[6], maxMove: s[7] / 16 };
}

export class RoadGrader {
  private readonly lay: ComputeKernel;
  private readonly pave: ComputeKernel;
  private roadsBuf: GPUBuffer | null = null;
  private params: GPUBuffer[] = [];
  private groups: { lay: GPUBindGroup; pave: GPUBindGroup }[] = [];
  private boxes: [number, number, number, number][] = [];
  readonly stats: GPUBuffer;
  private readonly statRead: GPUBuffer;
  private readonly qs: GPUQuerySet | null;
  private readonly qsRes: GPUBuffer | null;
  private readonly qsRead: GPUBuffer | null;
  private roads: RoadRecord[] = [];
  /** the kernels made (a level's pipelines are made in a batch: none till it ends) */
  private readonly ready: Promise<void>;

  constructor(
    private readonly device: GPUDevice,
    private readonly world: GradeWorld,
    private readonly w: number,
    private readonly h: number,
  ) {
    this.lay = makeCompute(device, 'roadgrade-lay', PARTS, SPEC, 'roadLay');
    this.pave = makeCompute(device, 'roadgrade-pave', PARTS, SPEC, 'roadPave');
    this.ready = new Promise((res) => whenPipelinesReady(res));
    this.stats = device.createBuffer({ label: 'roadgrade-stats', size: STAT_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.statRead = device.createBuffer({ label: 'roadgrade-stats-read', size: STAT_WORDS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    if (device.features.has('timestamp-query')) {
      this.qs = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.qsRes = device.createBuffer({ label: 'roadgrade-ts', size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.qsRead = device.createBuffer({ label: 'roadgrade-ts-read', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    } else {
      this.qs = this.qsRes = this.qsRead = null;
    }
  }

  /** the records' buffer (STORAGE, read: roadpath.wgsl's layout) — what a draw pass reads (archgen's grow-in) */
  get buffer(): GPUBuffer {
    if (!this.roadsBuf) throw new Error('road grader: no roads uploaded');
    return this.roadsBuf;
  }

  /** the roads' records, uploaded once (an authored set: the lab's ladder) */
  upload(roads: RoadRecord[]): void {
    const bytes = packRoads(roads);
    this.roadsBuf?.destroy();
    for (const p of this.params) p.destroy();
    this.roads = roads;
    this.roadsBuf = this.device.createBuffer({ label: 'road-records', size: bytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.roadsBuf, 0, bytes);
    this.boxes = roads.map((r) => roadColumnBox(r, this.w, this.h));
    this.params = [];
    this.groups = [];
    roads.forEach((_, i) => {
      const p = this.device.createBuffer({ label: `roadgrade-params-${i}`, size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      // (one record a dispatch, its frame the window's)
      this.device.queue.writeBuffer(p, 0, gradeParams(i, 1, this.boxes[i]));
      this.params.push(p);
      const bound = { 0: this.world.globals, 1: this.world.chunks, 2: this.world.materials, 3: this.world.layers, 4: this.roadsBuf!, 5: p, 6: this.stats, 7: this.world.veg, 8: this.world.vegNext, 9: this.world.water };
      this.groups.push({ lay: makeBindGroup(this.device, 'roadgrade-lay', this.lay.layout, bound), pave: makeBindGroup(this.device, 'roadgrade-pave', this.pave.layout, bound) });
    });
  }

  /** a road's box in the window's columns [x0, y0, x1, y1) */
  box(i: number): [number, number, number, number] {
    return this.boxes[i];
  }

  /**
   * Lay roads `ids` (each its own dispatch, in order: a later road's shoulder sees the earlier's surface), or pave
   * them; resolves with the GPU ms of the whole run (timestamp-query; null without it) and the stats.
   */
  async run(ids: number[], mode: 'lay' | 'pave'): Promise<{ gpuMs: number | null; wallMs: number; stats: GradeStats }> {
    if (!this.roadsBuf) throw new Error('road grader: no roads uploaded');
    await this.ready;
    const t0 = performance.now();
    const enc = this.device.createCommandEncoder({ label: `roadgrade-${mode}` });
    enc.clearBuffer(this.stats);
    const k = mode === 'lay' ? this.lay : this.pave;
    ids.forEach((i, n) => {
      const [x0, y0, x1, y1] = this.boxes[i];
      if (x1 <= x0 || y1 <= y0) return;
      const tw = this.qs ? { querySet: this.qs, beginningOfPassWriteIndex: n === 0 ? 0 : undefined, endOfPassWriteIndex: n === ids.length - 1 ? 1 : undefined } : undefined;
      const pass = enc.beginComputePass({ label: `roadgrade-${mode}-${i}`, timestampWrites: tw && (tw.beginningOfPassWriteIndex !== undefined || tw.endOfPassWriteIndex !== undefined) ? tw : undefined });
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, mode === 'lay' ? this.groups[i].lay : this.groups[i].pave);
      pass.dispatchWorkgroups(Math.ceil((x1 - x0) / 8), Math.ceil((y1 - y0) / 8));
      pass.end();
    });
    if (this.qs) {
      enc.resolveQuerySet(this.qs, 0, 2, this.qsRes!, 0);
      enc.copyBufferToBuffer(this.qsRes!, 0, this.qsRead!, 0, 16);
    }
    enc.copyBufferToBuffer(this.stats, 0, this.statRead, 0, STAT_WORDS * 4);
    this.device.queue.submit([enc.finish()]);
    await this.statRead.mapAsync(GPUMapMode.READ);
    const s = new Uint32Array(this.statRead.getMappedRange().slice(0));
    this.statRead.unmap();
    let gpuMs: number | null = null;
    if (this.qsRead) {
      await this.qsRead.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(this.qsRead.getMappedRange().slice(0));
      this.qsRead.unmap();
      gpuMs = t[1] > t[0] ? Number(t[1] - t[0]) / 1e6 : null;
    }
    return { gpuMs, wallMs: performance.now() - t0, stats: decodeStats(s) };
  }

  /** the records as uploaded */
  get records(): readonly RoadRecord[] {
    return this.roads;
  }

  dispose(): void {
    this.roadsBuf?.destroy();
    for (const p of this.params) p.destroy();
    this.stats.destroy();
    this.statRead.destroy();
    this.qs?.destroy();
    this.qsRes?.destroy();
    this.qsRead?.destroy();
  }
}

/** where a frame lies in the window: its column (0, 0) at window column (dx, dy) — dy even — and window z = its z + dz
 *  (sim/static-claims.ts GridPlace) */
export interface GradePlace {
  dx: number;
  dy: number;
  dz: number;
}

/**
 * (loop-streets) A lay of GPU-made records — all `n` of them at once — over window rectangles, their frame placed in the
 * window. One dispatch and one submit a rectangle (its uniform written first: bare.wgsl's pattern); nothing read back
 * unless asked (`readStats`: tests and the probe, once, after an edit).
 */
export class GradeLayer {
  private readonly lay: ComputeKernel;
  private readonly param: GPUBuffer;
  readonly stats: GPUBuffer;
  private group: GPUBindGroup | null = null;
  private groupFor: GPUBuffer | null = null;
  /** dispatches made (the census) and columns' worth of threads */
  readonly count = { lays: 0, cols: 0 };

  constructor(
    private readonly device: GPUDevice,
    private readonly world: GradeWorld,
  ) {
    this.lay = makeCompute(device, 'roadgrade-lay (town)', PARTS, SPEC, 'roadLay');
    this.param = device.createBuffer({ label: 'roadgrade-layer-params', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.stats = device.createBuffer({ label: 'roadgrade-layer-stats', size: STAT_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }

  /**
   * Records [0, n) of `records` (roadpath layout, their frame placed at `place`) laid over window rectangles
   * [x0, y0, x1, y1) — each clipped to `clip` (the frame's box in the window, when given).
   */
  layRects(records: GPUBuffer, n: number, rects: readonly (readonly [number, number, number, number])[], place: GradePlace, clip?: readonly [number, number, number, number]): void {
    if (place.dy % 2) throw new Error(`grade layer: the frame's first row (${place.dy}) must be even (the rows' stagger)`);
    if (this.groupFor !== records) {
      this.group = makeBindGroup(this.device, 'roadgrade-lay (town)', this.lay.layout, {
        0: this.world.globals,
        1: this.world.chunks,
        2: this.world.materials,
        3: this.world.layers,
        4: records,
        5: this.param,
        6: this.stats,
        7: this.world.veg,
        8: this.world.vegNext,
        9: this.world.water,
      });
      this.groupFor = records;
    }
    for (const r of rects) {
      const x0 = Math.max(r[0], clip?.[0] ?? -Infinity, 0);
      const y0 = Math.max(r[1], clip?.[1] ?? -Infinity, 0);
      const x1 = Math.min(r[2], clip?.[2] ?? Infinity);
      const y1 = Math.min(r[3], clip?.[3] ?? Infinity);
      if (x1 <= x0 || y1 <= y0) continue;
      this.device.queue.writeBuffer(this.param, 0, gradeParams(0, n, [x0, y0, x1, y1], place.dx, place.dy, place.dz));
      const enc = this.device.createCommandEncoder({ label: 'roadgrade-lay (town)' });
      const pass = enc.beginComputePass({ label: 'roadgrade-lay (town)' });
      pass.setPipeline(this.lay.pipeline);
      pass.setBindGroup(0, this.group!);
      pass.dispatchWorkgroups(Math.ceil((x1 - x0) / 8), Math.ceil((y1 - y0) / 8));
      pass.end();
      this.device.queue.submit([enc.finish()]);
      this.count.lays++;
      this.count.cols += (x1 - x0) * (y1 - y0);
    }
  }

  /** the stats since the last read (cleared): one small read, for tests and the probe */
  async readStats(): Promise<GradeStats> {
    const rd = this.device.createBuffer({ label: 'roadgrade-layer-stats-read', size: STAT_WORDS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder({ label: 'roadgrade-layer-stats' });
    enc.copyBufferToBuffer(this.stats, 0, rd, 0, STAT_WORDS * 4);
    enc.clearBuffer(this.stats);
    this.device.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    const s = new Uint32Array(rd.getMappedRange().slice(0));
    rd.unmap();
    rd.destroy();
    return decodeStats(s);
  }

  dispose(): void {
    this.param.destroy();
    this.stats.destroy();
  }
}
