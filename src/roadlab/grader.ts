// (road lab, RD1) The road grader: road path records (api/contracts/roadpath.ts) on the GPU, and the kernel that lays a
// road into the columns once (shaders/roadgrade.wgsl roadLay: cut, fill, banks, the surface interval) and paves it
// later (roadPave: dirt → cobble). It owns its buffers; it writes only WorldGpu.layers (the contract buffer every
// column pass shares) through the chunk table, bumping the chunks' versions like any column writer, and clears the
// plants' field (veg, vegNext) under what it changed.
// Reads: the stats, 32 bytes, once after a lay (DESIGN §24: small, async, after an edit) — what the lab reports.

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
const PARAM_BYTES = 32;

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
    private readonly world: Pick<WorldGpu, 'globals' | 'chunks' | 'materials' | 'layers' | 'veg' | 'vegNext'>,
    private readonly w: number,
    private readonly h: number,
  ) {
    const parts = [commonWgsl, layersWgsl, materialsWgsl, roadpathWgsl, roadgradeWgsl];
    const spec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'rw', 4: 'read', 5: 'uniform', 6: 'rw', 7: 'rw', 8: 'rw' } as const;
    this.lay = makeCompute(device, 'roadgrade-lay', parts, spec, 'roadLay');
    this.pave = makeCompute(device, 'roadgrade-pave', parts, spec, 'roadPave');
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
      const [x0, y0, x1, y1] = this.boxes[i];
      this.device.queue.writeBuffer(p, 0, new Uint32Array([i, 0, x0, y0, x1, y1, 0, 0]));
      this.params.push(p);
      const bound = { 0: this.world.globals, 1: this.world.chunks, 2: this.world.materials, 3: this.world.layers, 4: this.roadsBuf!, 5: p, 6: this.stats, 7: this.world.veg, 8: this.world.vegNext };
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
    const stats: GradeStats = { touched: s[0], roadCols: s[1], shoulderCols: s[2], maxIntervals: s[3], folded: s[4], left: s[5], maxK: s[6], maxMove: s[7] / 16 };
    return { gpuMs, wallMs: performance.now() - t0, stats };
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
