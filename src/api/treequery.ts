// (round 128o, DA-B6; DESIGN.md §24 "world queries are GPU passes") The nearest trees to a point, answered by the GPU
// (shaders/treequery.wgsl: vegplan.wgsl's own layout over the asks' boxes) as a short list an ask: n trees, 8 bytes
// each — not the succession field read back for the CPU to lay the trees out again. Asks made in the same task go in
// one submit and one map; the buffers and the staging are kept and grow. An answer from before a slide is dropped
// (null: ask again). API: TreeQuery, TreeQueryIO, MAX_N.
import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import vegplanWgsl from '../shaders/vegplan.wgsl?raw';
import treequeryWgsl from '../shaders/treequery.wgsl?raw';
import { ignoreTeardown, makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import { cellAt, cellPos } from '../world/lattice';

/** the most trees one ask answers (treequery.wgsl MAX_N) */
export const MAX_N = 32;
/** treequery.wgsl NB */
const NB = 128;
const ASK_WORDS = 8;
const MAX_X = 65535;
const SPECIES = ['broadleaf', 'conifer', 'birch', 'giant'] as const;

export interface TreeQueryIO {
  device: GPUDevice;
  globals: () => GPUBuffer;
  materials: () => GPUBuffer;
  veg: () => GPUBuffer;
  dims: () => { w: number; h: number };
  /** slides and warps (WorldCore.windowEpoch): an answer read across one is dropped */
  epoch: () => number;
}

/** a tree found: its column, its centre (window world), its species and size */
export interface FoundTree {
  cx: number;
  cy: number;
  x: number;
  y: number;
  species: (typeof SPECIES)[number];
  trunk: number;
  crown: number;
}

interface Pending {
  at: [number, number];
  r: number;
  n: number;
  done: (t: FoundTree[] | null) => void;
}

export class TreeQuery {
  private k?: { hist: ComputeKernel; cut: ComputeKernel; gather: ComputeKernel };
  private queue: Pending[] = [];
  private flushing = false;
  private busy: Promise<void> = Promise.resolve();
  private bufs?: { cap: number; asks: GPUBuffer; hist: GPUBuffer; sel: GPUBuffer; found: GPUBuffer; params: GPUBuffer; staging: GPUBuffer };
  /** asks answered, reads made, bytes read back (scripts read them) */
  readonly stats = { asks: 0, reads: 0, bytes: 0, dropped: 0 };

  constructor(private io: TreeQueryIO) {}

  /**
   * The trees within `r` of window world (x, y), nearest first, at most `n` (≤ MAX_N): the woods as the GPU has them
   * when the asks are run. Null: the window slid while it was read (ask again).
   */
  nearest(x: number, y: number, r: number, n = MAX_N): Promise<FoundTree[] | null> {
    if (!(n >= 1 && n <= MAX_N)) throw new Error(`treequery: n ${n} (1..${MAX_N})`);
    if (!(r > 0)) throw new Error(`treequery: radius ${r}`);
    return new Promise((done) => {
      this.queue.push({ at: [x, y], r, n, done });
      if (!this.flushing) {
        this.flushing = true;
        // (every ask made in this task goes in one read)
        queueMicrotask(() => {
          this.flushing = false;
          const asks = this.queue;
          this.queue = [];
          this.busy = this.busy.then(() => this.run(asks));
        });
      }
    });
  }

  private kernels() {
    const dev = this.io.device;
    const parts = [commonWgsl, materialsWgsl, vegplanWgsl, treequeryWgsl];
    const spec = { 0: 'uniform', 2: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'uniform' } as const;
    return (this.k ??= {
      hist: makeCompute(dev, 'treequery hist', parts, spec, 'hist_'),
      cut: makeCompute(dev, 'treequery cut', parts, spec, 'cut'),
      gather: makeCompute(dev, 'treequery gather', parts, spec, 'gather'),
    });
  }

  /** the buffers for `n` asks (kept; made again bigger when outgrown) */
  private buffers(n: number) {
    if (this.bufs && this.bufs.cap >= n) return this.bufs;
    const cap = Math.max(n, 8);
    const dev = this.io.device;
    if (this.bufs) for (const b of [this.bufs.asks, this.bufs.hist, this.bufs.sel, this.bufs.found, this.bufs.params, this.bufs.staging]) b.destroy();
    const S = GPUBufferUsage.STORAGE;
    this.bufs = {
      cap,
      asks: dev.createBuffer({ label: 'treequery asks', size: cap * ASK_WORDS * 4, usage: S | GPUBufferUsage.COPY_DST }),
      hist: dev.createBuffer({ label: 'treequery hist', size: cap * NB * 4, usage: S | GPUBufferUsage.COPY_DST }),
      sel: dev.createBuffer({ label: 'treequery sel', size: cap * 16, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
      found: dev.createBuffer({ label: 'treequery found', size: cap * MAX_N * 8, usage: S | GPUBufferUsage.COPY_SRC }),
      params: dev.createBuffer({ label: 'treequery params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      staging: dev.createBuffer({ label: 'treequery read', size: cap * (16 + MAX_N * 8), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    };
    return this.bufs;
  }

  private async run(asks: Pending[]): Promise<void> {
    const dev = this.io.device;
    const { w, h } = this.io.dims();
    const k = this.kernels();
    const B = this.buffers(asks.length);
    // (each ask's box of columns: its point's cell ± the radius in cells, clamped to the window)
    const words = new ArrayBuffer(asks.length * ASK_WORDS * 4);
    const u = new Uint32Array(words);
    const f = new Float32Array(words);
    let threads = 0;
    asks.forEach((a, i) => {
      const [cx, cy] = cellAt(a.at[0], a.at[1]);
      const rx = Math.ceil(a.r) + 1;
      const ry = Math.ceil(a.r / 0.8660254) + 1;
      const x0 = Math.max(0, cx - rx);
      const x1 = Math.min(w - 1, cx + rx);
      const y0 = Math.max(0, cy - ry);
      const y1 = Math.min(h - 1, cy + ry);
      const bw = Math.max(0, x1 - x0 + 1);
      const bh = Math.max(0, y1 - y0 + 1);
      const o = i * ASK_WORDS;
      u[o] = x0;
      u[o + 1] = y0;
      u[o + 2] = Math.max(1, bw);
      u[o + 3] = threads;
      f[o + 4] = a.at[0];
      f[o + 5] = a.at[1];
      f[o + 6] = a.r;
      u[o + 7] = a.n;
      threads += bw * bh;
    });
    dev.queue.writeBuffer(B.asks, 0, words);
    dev.queue.writeBuffer(B.params, 0, new Uint32Array([asks.length, threads, 0, 0]));
    const enc = dev.createCommandEncoder({ label: 'treequery' });
    enc.clearBuffer(B.hist, 0, asks.length * NB * 4);
    enc.clearBuffer(B.sel, 0, asks.length * 16);
    const bg = (kk: ComputeKernel) =>
      makeBindGroup(dev, 'treequery', kk.layout, { 0: this.io.globals(), 2: this.io.materials(), 3: this.io.veg(), 4: B.asks, 5: B.hist, 6: B.sel, 7: B.found, 8: B.params });
    const groups = Math.ceil(threads / 64);
    const pass = enc.beginComputePass({ label: 'treequery' });
    if (threads > 0) {
      pass.setPipeline(k.hist.pipeline);
      pass.setBindGroup(0, bg(k.hist));
      pass.dispatchWorkgroups(Math.min(groups, MAX_X), Math.ceil(groups / MAX_X));
    }
    pass.setPipeline(k.cut.pipeline);
    pass.setBindGroup(0, bg(k.cut));
    pass.dispatchWorkgroups(Math.ceil(asks.length / 64));
    if (threads > 0) {
      pass.setPipeline(k.gather.pipeline);
      pass.setBindGroup(0, bg(k.gather));
      pass.dispatchWorkgroups(Math.min(groups, MAX_X), Math.ceil(groups / MAX_X));
    }
    pass.end();
    const selBytes = asks.length * 16;
    const foundBytes = asks.length * MAX_N * 8;
    enc.copyBufferToBuffer(B.sel, 0, B.staging, 0, selBytes);
    enc.copyBufferToBuffer(B.found, 0, B.staging, selBytes, foundBytes);
    const e0 = this.io.epoch();
    dev.queue.submit([enc.finish()]);
    try {
      await B.staging.mapAsync(GPUMapMode.READ, 0, selBytes + foundBytes);
    } catch (e) {
      ignoreTeardown(e);
      for (const a of asks) a.done(null);
      return;
    }
    const all = B.staging.getMappedRange(0, selBytes + foundBytes).slice(0);
    B.staging.unmap();
    this.stats.reads++;
    this.stats.bytes += selBytes + foundBytes;
    this.stats.asks += asks.length;
    if (this.io.epoch() !== e0) {
      this.stats.dropped++;
      for (const a of asks) a.done(null);
      return;
    }
    const sel = new Uint32Array(all, 0, asks.length * 4);
    const found = new Uint32Array(all, selBytes);
    asks.forEach((a, i) => {
      const [cutBin, below, low, inCut] = [sel[i * 4], sel[i * 4 + 1], sel[i * 4 + 2], sel[i * 4 + 3]];
      const count = cutBin >= NB ? low : below + Math.min(inCut, a.n - below);
      const out: (FoundTree & { d: number })[] = [];
      for (let j = 0; j < count; j++) {
        const p = found[(i * MAX_N + j) * 2];
        const s = found[(i * MAX_N + j) * 2 + 1];
        const cx = p & 0xffff;
        const cy = p >>> 16;
        const [x, y] = cellPos(cx, cy);
        out.push({ cx, cy, x, y, species: SPECIES[s & 0xff], trunk: (s >>> 8) & 0xff, crown: (s >>> 16) & 0xff, d: Math.hypot(x - a.at[0], y - a.at[1]) });
      }
      a.done(out.sort((p, q) => p.d - q.d).map(({ d: _d, ...t }) => t));
    });
  }

  destroy(): void {
    if (this.bufs) for (const b of [this.bufs.asks, this.bufs.hist, this.bufs.sel, this.bufs.found, this.bufs.params, this.bufs.staging]) b.destroy();
    this.bufs = undefined;
  }
}
