// (round 128r, Track A "Next season") A flood standing in the live window: one height flood fill (FloodGpu.run, the
// terrain track's flood.wgsl — the one source of which cells a flood covers) over the window's own columns, and still
// water written over its mark at a level as held water (riverFlow's depth, no flow: riverheld.wgsl holds it, nothing
// simulates it while its chunk sleeps). The user: "We don't need the actual water simulation to flood an area just an
// actual elevation difference and a single flood fill to see what gets submerged." basin.wgsl says how.
//
// Data movement: the heights are made on the GPU from the columns (no upload of the land); the mark stays on the GPU;
// back come the fill's 4-byte "changed" words a batch (FloodGpu.run), the level (4 bytes, when the spill height is
// asked) and the structures under water (a word a structure asked about). Nothing a frame: a fill, then a pass a level
// written.
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import basinWgsl from './basin.wgsl?raw';
import type { WorldGpu } from '../sim/world-gpu';
import { cellAt } from '../world/lattice';
import { FloodGpu } from './flood';

/** the side of the grid a flood is found in (columns): a basin wider than this spills at its edge (a lower level) */
export const BASIN_GRID = 128;

type BasinWorld = Pick<WorldGpu, 'w' | 'h' | 'globals' | 'materials' | 'chunks' | 'surface' | 'water' | 'driftView' | 'riverFlowView'>;

interface Kernels {
  extract: ComputeKernel;
  write: ComputeKernel;
  query: ComputeKernel;
}

/** A flood found in the window: its level and its mark (on the GPU). Raise or lower the water over it; ask what it covers. */
export class Basin {
  private alive = true;
  constructor(
    private owner: LiveFlood,
    /** the level found (window z): the given one, or the basin's spill height */
    readonly level: number,
    /** the ground at the seed (window z): where a rising flood starts */
    readonly floor: number,
    /** the grid's first column and its side */
    readonly origin: [number, number],
    readonly m: number,
    private mark: GPUBuffer,
    private free: () => void,
  ) {}

  /** The water over the mark at least `level` deep (window z), held: a step of the flood rising. */
  raise(level: number): void {
    this.check();
    this.owner.write(this, this.mark, 0, level);
  }

  /** The water over the mark at most `level` deep (−Infinity: dry), held: a step of the flood going down. */
  lower(level: number): void {
    this.check();
    this.owner.write(this, this.mark, 1, Number.isFinite(level) ? level : -1e9);
  }

  /** Which of `entries`' structures the flood covers (a column of theirs in the mark, or beside it). */
  submerged(entries: readonly { col: readonly [number, number]; structure: number }[]): Promise<Set<number>> {
    this.check();
    return this.owner.query(this, this.mark, entries);
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    this.free();
  }

  private check(): void {
    if (!this.alive) throw new Error('basin: used after destroy');
  }
}

/** The live window's floods: found by one fill, written as held still water. */
export class LiveFlood {
  private k: Kernels;
  private params: GPUBuffer;
  private gpu: FloodGpu;

  constructor(
    private device: GPUDevice,
    private world: BasinWorld,
  ) {
    const parts = [commonWgsl, layersWgsl, materialsWgsl, basinWgsl];
    const base: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 9: 'uniform' };
    this.k = {
      extract: makeCompute(device, 'basin-extract', parts, { ...base, 3: 'rw', 4: 'rw', 5: 'rw', 6: 'read', 7: 'rw', 17: 'tex', 22: 'tex' }, 'basinExtract'),
      write: makeCompute(device, 'basin-write', parts, { ...base, 6: 'read', 7: 'rw', 10: 'read', 17: 'tex', 23: 'stex' }, 'basinWrite'),
      query: makeCompute(device, 'basin-query', parts, { ...base, 10: 'read', 11: 'read', 12: 'rw' }, 'basinQuery'),
    };
    this.params = device.createBuffer({ label: 'basin params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.gpu = new FloodGpu(device);
  }

  private setParams(origin: readonly [number, number], m: number, mode: number, level: number, entries: number): void {
    const ab = new ArrayBuffer(32);
    new Int32Array(ab, 0, 2).set(origin);
    new Uint32Array(ab, 8, 2).set([m, mode]);
    new Float32Array(ab, 16, 1)[0] = level;
    new Uint32Array(ab, 20, 1)[0] = entries;
    this.device.queue.writeBuffer(this.params, 0, ab);
  }

  /**
   * The flood of the basin at window world (x, y): to `level` (window z), or to its spill height (the level water would
   * rise to before it ran out — it stands there by construction). Writes nothing: raise() puts the water in.
   */
  async basin(x: number, y: number, opts: { level?: number; side?: number } = {}): Promise<Basin> {
    const dev = this.device;
    const W = this.world;
    const m = Math.min(opts.side ?? BASIN_GRID, W.w, W.h);
    const [cx, cy] = cellAt(x, y);
    if (cx < 0 || cy < 0 || cx >= W.w || cy >= W.h) throw new Error(`basin: (${x.toFixed(1)}, ${y.toFixed(1)}) is off the window`);
    const ox = Math.max(0, Math.min(W.w - m, cx - (m >> 1)));
    const oy = Math.max(0, Math.min(W.h - m, cy - (m >> 1)));
    const N = m * m;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const h = dev.createBuffer({ label: 'basin h', size: N * 4, usage: S });
    const hm = dev.createBuffer({ label: 'basin hm', size: N * 4, usage: S });
    const w0 = dev.createBuffer({ label: 'basin w0', size: N * 4, usage: S });
    this.setParams([ox, oy], m, 0, 0, 0);
    const enc = dev.createCommandEncoder({ label: 'basin extract' });
    const cp = enc.beginComputePass({ label: 'basin-extract' });
    cp.setPipeline(this.k.extract.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'basin-extract', this.k.extract.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 9: this.params, 3: h, 4: hm, 5: w0, 6: W.surface, 7: W.water, 17: W.driftView, 22: W.riverFlowView }));
    cp.dispatchWorkgroups(Math.ceil(m / 8), Math.ceil(m / 8));
    cp.end();
    dev.queue.submit([enc.finish()]);
    try {
      const seed = (cy - oy) * m + (cx - ox);
      const r = await this.gpu.run({ m, seed, h, hm, w0 }, opts.level);
      r.filled?.destroy();
      const floor = await this.read4(h, seed);
      return new Basin(this, r.level, floor, [ox, oy], m, r.mark, () => r.mark.destroy());
    } finally {
      for (const b of [h, hm, w0]) b.destroy();
    }
  }

  /** a float of a buffer (4 B back) */
  private async read4(b: GPUBuffer, at: number): Promise<number> {
    const dev = this.device;
    const rb = dev.createBuffer({ label: 'basin read4', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const enc = dev.createCommandEncoder({ label: 'basin read4' });
      enc.copyBufferToBuffer(b, at * 4, rb, 0, 4);
      dev.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      return new Float32Array(rb.getMappedRange().slice(0))[0];
    } finally {
      rb.destroy();
    }
  }

  /** (Basin.raise / lower) one pass over the mark */
  write(b: Basin, mark: GPUBuffer, mode: 0 | 1, level: number): void {
    const dev = this.device;
    const W = this.world;
    this.setParams(b.origin, b.m, mode, level, 0);
    const enc = dev.createCommandEncoder({ label: 'basin write' });
    const cp = enc.beginComputePass({ label: 'basin-write' });
    cp.setPipeline(this.k.write.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'basin-write', this.k.write.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 9: this.params, 6: W.surface, 7: W.water, 10: mark, 17: W.driftView, 23: W.riverFlowView }));
    cp.dispatchWorkgroups(Math.ceil(b.m / 8), Math.ceil(b.m / 8));
    cp.end();
    dev.queue.submit([enc.finish()]);
  }

  /** (Basin.submerged) a pass over the entries, a word a structure back */
  async query(b: Basin, mark: GPUBuffer, entries: readonly { col: readonly [number, number]; structure: number }[]): Promise<Set<number>> {
    const out = new Set<number>();
    if (!entries.length) return out;
    const dev = this.device;
    const W = this.world;
    const ids = [...new Set(entries.map((e) => e.structure))];
    const slot = new Map(ids.map((id, k) => [id, k]));
    const words = new Uint32Array(entries.length * 2);
    entries.forEach((e, k) => {
      words[k * 2] = (e.col[0] & 0xffff) | ((e.col[1] & 0xffff) << 16);
      words[k * 2 + 1] = slot.get(e.structure)!;
    });
    const eb = dev.createBuffer({ label: 'basin entries', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const fb = dev.createBuffer({ label: 'basin flags', size: ids.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const rb = dev.createBuffer({ label: 'basin flags read', size: ids.length * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      dev.queue.writeBuffer(eb, 0, words);
      dev.queue.writeBuffer(fb, 0, new Uint32Array(ids.length));
      this.setParams(b.origin, b.m, 0, 0, entries.length);
      const enc = dev.createCommandEncoder({ label: 'basin query' });
      const cp = enc.beginComputePass({ label: 'basin-query' });
      cp.setPipeline(this.k.query.pipeline);
      cp.setBindGroup(0, makeBindGroup(dev, 'basin-query', this.k.query.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 9: this.params, 10: mark, 11: eb, 12: fb }));
      cp.dispatchWorkgroups(Math.ceil(entries.length / 64));
      cp.end();
      enc.copyBufferToBuffer(fb, 0, rb, 0, ids.length * 4);
      dev.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const f = new Uint32Array(rb.getMappedRange().slice(0));
      rb.unmap();
      ids.forEach((id, k) => f[k] && out.add(id));
      return out;
    } finally {
      for (const x of [eb, fb, rb]) x.destroy();
    }
  }

  destroy(): void {
    this.params.destroy();
  }
}
