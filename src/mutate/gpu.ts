// The mutators' GPU side (shaders/mutate/land.wgsl): an entry of the world modifier list written into a box of the
// window's columns, and into a town's lot conditions. A dispatch each; nothing read back (the timing a lab or a test
// asks for aside: 16 bytes, once, after the write — DESIGN §24).
// It writes the contract buffers every column pass shares: WorldGpu layers (through the chunk table, bumping versions),
// water, veg / vegNext and the lava contract's ground heat; and a town's condition buffer (CityLots.condition).
import { makeBindGroup, makeCompute, whenPipelinesReady, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import masksWgsl from '../shaders/mutate/masks.wgsl?raw';
import landWgsl from '../shaders/mutate/land.wgsl?raw';
import lotsWgsl from '../shaders/mutate/lots.wgsl?raw';
import floodWgsl from '../shaders/mutate/flood.wgsl?raw';
import floodScanWgsl from '../shaders/mutate/floodscan.wgsl?raw';
import riverSetWgsl from '../shaders/mutate/riverset.wgsl?raw';
import riverHeldWgsl from '../shaders/riverheld.wgsl?raw';
import { RIVER_DEPTH_EXP, RIVER_SPEED_EXP, RIVER_WET_CELLS, type WorldGpu } from '../sim/world-gpu';
import { ROW_H } from '../world/lattice';
import type { Mutation } from './index';
import { GPU_KIND, holderHue, landOp } from './list';

/** a town's lots as the mutators write them (api/contracts/citygen.ts CityLots, with its condition words) */
export interface MutLots {
  records: GPUBuffer;
  counts: GPUBuffer;
  condition: GPUBuffer;
  /** the frame's place in the window (UNIFORM vec4: xyz added to a record's position) */
  place: GPUBuffer;
  /** records the buffers hold */
  room: number;
}

/** the window's origin: world cells (x, row) and the window's oz */
export type Origin = readonly [number, number, number];

const SLOT = 256;
const SLOTS = 64;
const PARAM_BYTES = 96;
/** MutParams.p.x's place in a parameter slot (bytes): where a flood's level goes */
const P_X = 48;
/** flood levels chosen in one submit, at most (floodOut's slots) */
export const FLOOD_SLOTS = 16;
/** how far under the atlas's level a flood's histogram starts (cells): 64 cells of height from there */
const FLOOD_BELOW = 44;

export class MutateGpu {
  private readonly land: ComputeKernel;
  private readonly lots: ComputeKernel;
  private readonly flood: ComputeKernel;
  private readonly scan: ComputeKernel;
  private readonly pick: ComputeKernel;
  private readonly river: ComputeKernel;
  private readonly floodHist: GPUBuffer;
  private readonly floodOut: GPUBuffer;
  private readonly uni: GPUBuffer;
  private slot = 0;
  private readonly dummyPlace: GPUBuffer;
  private readonly dummy: GPUBuffer;
  private readonly qs: GPUQuerySet | null;
  private readonly qsRes: GPUBuffer | null;
  readonly ready: Promise<void>;
  /** dispatches made so far (a test's and the lab's count) */
  dispatches = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly world: Pick<WorldGpu, 'globals' | 'chunks' | 'materials' | 'layers' | 'water' | 'veg' | 'vegNext' | 'lava' | 'waterSource' | 'wilt' | 'contam' | 'contamNext' | 'riverFlowView' | 'riverWetView'>,
    private readonly w: number,
    private readonly h: number,
  ) {
    const parts = [commonWgsl, layersWgsl, materialsWgsl, masksWgsl, landWgsl];
    this.land = makeCompute(device, 'mutate-land', parts, { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'rw', 4: 'rw', 5: 'uniform', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 14: 'rw' }, 'mutLand');
    this.lots = makeCompute(device, 'mutate-lots', [commonWgsl, materialsWgsl, masksWgsl, lotsWgsl], { 0: 'uniform', 2: 'uniform', 5: 'uniform', 10: 'read', 11: 'read', 12: 'rw', 13: 'uniform' }, 'mutLots');
    this.flood = makeCompute(device, 'mutate-flood', [commonWgsl, layersWgsl, materialsWgsl, masksWgsl, floodWgsl], { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'rw', 5: 'uniform', 6: 'rw', 7: 'rw', 8: 'rw' }, 'mutFlood');
    const fb = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'uniform', 15: 'rw', 16: 'rw' } as const;
    const fparts = [commonWgsl, layersWgsl, materialsWgsl, masksWgsl, floodScanWgsl];
    this.scan = makeCompute(device, 'mutate-flood-scan', fparts, fb, 'mutFloodScan');
    this.pick = makeCompute(device, 'mutate-flood-pick', fparts, fb, 'mutFloodPick');
    // (the rivers' table as the held rivers read it — riverheld.wgsl, its table on: where the world has none the
    // texture is empty and nothing is written)
    const held = `const RIVER_TABLE: bool = true;
const RIVER_DEPTH_EXP: f32 = ${RIVER_DEPTH_EXP};
const RIVER_SPEED_EXP: f32 = ${RIVER_SPEED_EXP};
const RIVER_WET_CELLS: f32 = ${RIVER_WET_CELLS};
`;
    this.river = makeCompute(device, 'mutate-river', [commonWgsl, layersWgsl, materialsWgsl, masksWgsl, riverSetWgsl, held + riverHeldWgsl], { 0: 'uniform', 1: 'read', 2: 'uniform', 4: 'rw', 5: 'uniform', 9: 'read', 22: 'tex', 62: 'tex' }, 'mutRiverSet');
    this.floodHist = device.createBuffer({ label: 'mutate-flood-hist', size: 768 * 4, usage: GPUBufferUsage.STORAGE });
    this.floodOut = device.createBuffer({ label: 'mutate-flood-out', size: FLOOD_SLOTS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.ready = new Promise((res) => whenPipelinesReady(res));
    this.uni = device.createBuffer({ label: 'mutate-params', size: SLOT * SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dummyPlace = device.createBuffer({ label: 'mutate-place0', size: 16, usage: GPUBufferUsage.UNIFORM });
    this.dummy = device.createBuffer({ label: 'mutate-dummy', size: 16, usage: GPUBufferUsage.STORAGE });
    if (device.features.has('timestamp-query')) {
      this.qs = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.qsRes = device.createBuffer({ label: 'mutate-ts', size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    } else this.qs = this.qsRes = null;
  }

  /** an entry's numbers for the kernel, in the window as it is now */
  private params(m: Mutation, o: Origin, box: readonly [number, number, number, number], room = 0, strength = m.strength, floodSlot = -1): GPUBufferBinding {
    // (the entry's cell in the window: `o` is the origin it's nearest to — MutateEngine.originFor, the world wraps)
    const kind = landOp(m) ?? GPU_KIND[m.kind];
    if (kind === null) throw new Error(`mutators: ${m.kind} writes nothing on the GPU`);
    const buf = new ArrayBuffer(PARAM_BYTES);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    const [ox, oy, oz] = o;
    u.set(box, 0);
    f.set([m.cell[0] + 0.5 - ox, (m.cell[1] + 0.5 - oy) * ROW_H, m.radius, strength], 4);
    u.set([kind, m.seed, room, m.kind === 'flooded' ? Math.max(0, floodSlot) : m.by ? holderHue(m.by) : 0], 8);
    const p = m.params;
    // (p.y: for the scan, where the level's histogram starts — floodscan.wgsl; for the write, the standing water's level)
    if (m.kind === 'flooded') f.set([p[0] - oz - (1 - strength / Math.max(m.strength, 1e-6)) * 8, floodSlot >= 0 ? p[0] - oz - FLOOD_BELOW : (p[2] ?? -1e9) - oz, 0, 0], 12);
    else if (m.kind === 'melted') {
      f.set([p[0] - ox, p[1] - oy * ROW_H, p[2] - oz, p[3] * (strength / Math.max(m.strength, 1e-6)), 0, 0, 0, 0], 12);
      f.set([p[4], p[5]], 16);
    } else if (m.kind === 'dried') f.set([p[0], 0, 0, 0], 12);
    else if (m.kind === 'founded') {
      // (a mining place's workings: the pit and the heap in the window — list.ts workings)
      f.set([p[0] - ox, p[1] - oy * ROW_H, p[2], 0], 12);
      f.set([p[3] - ox, p[4] - oy * ROW_H, p[5], 0], 16);
    }
    else if (m.kind === 'buried') {
      f.set([p[0] * (strength / Math.max(m.strength, 1e-6)), p[1], 0, 0], 12);
      f.set([p[2], p[3]], 16);
    }
    // (noise positions are world positions: the window's origin as this entry sees it)
    f.set([ox, oy * ROW_H, oz, 0], 20);
    if (this.slot >= SLOTS) throw new Error('mutators: more dispatches in one submit than the parameter slots (flush first)');
    const off = this.slot++ * SLOT;
    this.device.queue.writeBuffer(this.uni, off, buf);
    return { buffer: this.uni, offset: off, size: PARAM_BYTES };
  }

  /**
   * Write entries (in order) into window box [x0, y0, x1, y1) and into the towns' lots: one submit. `lots` are written
   * for every entry whatever the box. With `time`, resolves with the GPU ms of the submit's passes (null without
   * timestamp queries); otherwise nothing is read.
   */
  write(ms: readonly Mutation[], o: Origin, box: readonly [number, number, number, number] | null, towns: readonly MutLots[] = [], time = false, strength?: number, level: ReadonlySet<Mutation> = new Set()): Promise<number | null> | null {
    const W = this.world;
    type Job = { k: ComputeKernel; g: GPUBindGroup; x: number; y: number } | { copy: number; to: number[] };
    const jobs: Job[] = [];
    const push = () => {
      if (!jobs.length) return;
      const enc = this.device.createCommandEncoder({ label: 'mutate' });
      const last = jobs.length - 1;
      jobs.forEach((j, n) => {
        if ('copy' in j) {
          // (the level just chosen, into the kernels' parameters that follow: GPU to GPU)
          for (const off of j.to) enc.copyBufferToBuffer(this.floodOut, j.copy * 16, this.uni, off + P_X, 8);
          return;
        }
        const tw = time && this.qs ? { querySet: this.qs, beginningOfPassWriteIndex: n === 0 ? 0 : undefined, endOfPassWriteIndex: n === last ? 1 : undefined } : undefined;
        const pass = enc.beginComputePass({ label: 'mutate', timestampWrites: tw && (tw.beginningOfPassWriteIndex !== undefined || tw.endOfPassWriteIndex !== undefined) ? tw : undefined });
        pass.setPipeline(j.k.pipeline);
        pass.setBindGroup(0, j.g);
        pass.dispatchWorkgroups(j.x, j.y);
        pass.end();
        this.dispatches++;
      });
      if (time && this.qs) enc.resolveQuerySet(this.qs, 0, 2, this.qsRes!, 0);
      this.device.queue.submit([enc.finish()]);
      jobs.length = 0;
      this.slot = 0;
    };
    let floodSlot = 0;
    for (const m of ms) {
      if (GPU_KIND[m.kind] === null && landOp(m) === null) continue;
      // (an entry's dispatches stay in one submit: the level's copy lands in parameter slots of the same encoder)
      if (this.slot + 4 + towns.length > SLOTS) push();
      const mine: Job[] = [];
      const levelTo: number[] = [];
      const pick = level.has(m) && m.kind === 'flooded' && box !== null && floodSlot < FLOOD_SLOTS;
      const fs = pick ? floodSlot++ : 0;
      if (box && landOp(m) !== null) {
        // (the entry's own box within the one asked)
        const cx = m.cell[0] - o[0];
        const cy = m.cell[1] - o[1];
        const ry = m.radius / ROW_H;
        const b: [number, number, number, number] = [Math.max(box[0], Math.floor(cx - m.radius - 1)), Math.max(box[1], Math.floor(cy - ry - 1)), Math.min(box[2], Math.ceil(cx + m.radius + 2)), Math.min(box[3], Math.ceil(cy + ry + 2))];
        if (b[2] > b[0] && b[3] > b[1]) {
          const gx = Math.ceil((b[2] - b[0]) / 8);
          const gy = Math.ceil((b[3] - b[1]) / 8);
          if (pick) {
            const fg = makeBindGroup(this.device, 'mutate-flood', this.scan.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 3: W.layers, 4: W.water, 5: this.params(m, o, b, 0, strength, fs), 15: this.floodHist, 16: this.floodOut });
            jobs.push({ k: this.scan, g: fg, x: gx, y: gy }, { k: this.pick, g: fg, x: 1, y: 1 });
          }
          const pb = this.params(m, o, b, 0, strength);
          levelTo.push(pb.offset!);
          const g = makeBindGroup(this.device, 'mutate-land', this.land.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 3: W.layers, 4: W.water, 5: pb, 6: W.veg, 7: W.vegNext, 8: W.lava, 9: W.waterSource, 14: W.wilt });
          mine.push({ k: this.land, g, x: gx, y: gy });
          if (m.kind === 'flooded') {
            // (the silt first — land.wgsl — then the water to the level over it: flood.wgsl)
            const pw = this.params(m, o, b, 0, strength);
            levelTo.push(pw.offset!);
            const gw = makeBindGroup(this.device, 'mutate-flood-write', this.flood.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 3: W.layers, 4: W.water, 5: pw, 6: W.contam, 7: W.contamNext, 8: W.waterSource });
            mine.push({ k: this.flood, g: gw, x: gx, y: gy });
          }
        }
      }
      // (these change no lot)
      if (!(m.kind === 'dried' || m.kind === 'withered' || m.kind === 'greened' || m.kind === 'founded'))
        for (const t of towns) {
          const pb = this.params(m, o, [0, 0, 0, 0], t.room, strength);
          levelTo.push(pb.offset!);
          const g = makeBindGroup(this.device, 'mutate-lots', this.lots.layout, { 0: W.globals, 2: W.materials, 5: pb, 10: t.records, 11: t.counts, 12: t.condition, 13: t.place });
          mine.push({ k: this.lots, g, x: Math.ceil(t.room / 64), y: 1 });
        }
      if (pick && mine.length) jobs.push({ copy: fs, to: levelTo });
      jobs.push(...mine);
    }
    const timed = time && this.qs && jobs.length > 0;
    push();
    if (!timed) return time ? Promise.resolve(null) : null;
    return this.readMs();
  }

  /** the levels the last submit's flood scans chose, a slot each: [level (window z), the standing
   *  water's level, dry columns, wet columns]. Sixteen bytes a slot read once, after the write (the engine keeps the level on the entry) */
  async readLevels(n: number): Promise<Float32Array> {
    const rd = this.device.createBuffer({ label: 'mutate-flood-read', size: FLOOD_SLOTS * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.floodOut, 0, rd, 0, Math.min(n, FLOOD_SLOTS) * 16);
    this.device.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rd.getMappedRange().slice(0));
    rd.unmap();
    rd.destroy();
    return out;
  }

  /** every lot of a town under a raw kind code (mutLots: the 'crime' sign's loot and its undoing): one dispatch */
  lotsOnly(kind: number, t: MutLots, strength: number, seed: number): void {
    const buf = new ArrayBuffer(PARAM_BYTES);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    // (no area: the centre the lots' own frame, the radius everything)
    f.set([0, 0, 1e9, strength], 4);
    u.set([kind, seed, t.room, 0], 8);
    this.slot = 0;
    this.device.queue.writeBuffer(this.uni, 0, buf);
    const W = this.world;
    const g = makeBindGroup(this.device, 'mutate-lots', this.lots.layout, { 0: W.globals, 2: W.materials, 5: { buffer: this.uni, offset: 0, size: PARAM_BYTES }, 10: t.records, 11: t.counts, 12: t.condition, 13: t.place });
    const enc = this.device.createCommandEncoder({ label: 'mutate-lots' });
    const pass = enc.beginComputePass({ label: 'mutate-lots' });
    pass.setPipeline(this.lots.pipeline);
    pass.setBindGroup(0, g);
    pass.dispatchWorkgroups(Math.ceil(t.room / 64), 1);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.dispatches++;
  }

  /** A mark of a raw land kind (masks.wgsl MUT_*) written round window point `at` (world units in the window): the
   *  'deadrise' sign's broken burial ground. One dispatch over its box; nothing read. Null: none of it is in the window. */
  landMark(kind: number, at: readonly [number, number], radius: number, seed: number, o: Origin): [number, number, number, number] | null {
    const ry = radius / ROW_H;
    const cy = at[1] / ROW_H;
    const b: [number, number, number, number] = [Math.max(0, Math.floor(at[0] - radius - 1)), Math.max(0, Math.floor(cy - ry - 1)), Math.min(this.w, Math.ceil(at[0] + radius + 2)), Math.min(this.h, Math.ceil(cy + ry + 2))];
    if (b[2] <= b[0] || b[3] <= b[1]) return null;
    const buf = new ArrayBuffer(PARAM_BYTES);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u.set(b, 0);
    f.set([at[0], at[1], radius, 1], 4);
    u.set([kind, seed >>> 0, 0, 0], 8);
    f.set([o[0], o[1] * ROW_H, o[2], 0], 20);
    this.slot = 0;
    this.device.queue.writeBuffer(this.uni, 0, buf);
    const W = this.world;
    const g = makeBindGroup(this.device, 'mutate-land', this.land.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 3: W.layers, 4: W.water, 5: { buffer: this.uni, offset: 0, size: PARAM_BYTES }, 6: W.veg, 7: W.vegNext, 8: W.lava, 9: W.waterSource, 14: W.wilt });
    const enc = this.device.createCommandEncoder({ label: 'mutate-mark' });
    const pass = enc.beginComputePass({ label: 'mutate-mark' });
    pass.setPipeline(this.land.pipeline);
    pass.setBindGroup(0, g);
    pass.dispatchWorkgroups(Math.ceil((b[2] - b[0]) / 8), Math.ceil((b[3] - b[1]) / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.dispatches++;
    return b;
  }

  /** The rivers of window box [x0, y0, x1, y1) settled to their cut (riverset.wgsl): a river column whose wetness is
   *  under the climate's holds no more than the table's depth at it. One dispatch; nothing read. */
  riverSettle(box: readonly [number, number, number, number]): void {
    const buf = new ArrayBuffer(PARAM_BYTES);
    new Uint32Array(buf).set(box, 0);
    this.slot = 0;
    this.device.queue.writeBuffer(this.uni, 0, buf);
    const W = this.world;
    const g = makeBindGroup(this.device, 'mutate-river', this.river.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 4: W.water, 5: { buffer: this.uni, offset: 0, size: PARAM_BYTES }, 9: W.waterSource, 22: W.riverFlowView, 62: W.riverWetView });
    const enc = this.device.createCommandEncoder({ label: 'mutate-river' });
    const pass = enc.beginComputePass({ label: 'mutate-river' });
    pass.setPipeline(this.river.pipeline);
    pass.setBindGroup(0, g);
    pass.dispatchWorkgroups(Math.ceil((box[2] - box[0]) / 8), Math.ceil((box[3] - box[1]) / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.dispatches++;
  }

  /** the last timed submit's GPU ms (16 bytes read, once) */
  private async readMs(): Promise<number | null> {
    const rd = this.device.createBuffer({ label: 'mutate-ts-read', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.qsRes!, 0, rd, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    const t = new BigUint64Array(rd.getMappedRange().slice(0));
    rd.unmap();
    rd.destroy();
    return t[1] > t[0] ? Number(t[1] - t[0]) / 1e6 : null;
  }

  /** the window's size (columns) */
  get dims(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  dispose(): void {
    this.uni.destroy();
    this.dummyPlace.destroy();
    this.dummy.destroy();
    this.floodHist.destroy();
    this.floodOut.destroy();
    this.qs?.destroy();
    this.qsRes?.destroy();
  }
}
