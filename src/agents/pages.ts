// ---- agents/pages.ts: the paged field atlas (U2 round 7, UNIT_MINDS_U2.md §9b) — the riskiest part first, standalone ---
// Fields as pages (shaders/pages.wgsl): a page a field over a chunk, from one pool, found through the field's page
// table; the GPU claims a page as the field grows into a chunk. Built beside the planes first (the agents' `dist`), over
// the same surfaces (Agents.pageHost): relax over pages with block relaxation, measured against the planes' gates (the
// reaction, a CPU BFS, memory) before anything moves onto it. No fixed field count: `fields` rows of the page table and
// `pages` pages, both set from the memory given.
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import pagesWgsl from '../shaders/pages.wgsl?raw';
import type { Agents } from './agents';

const NAV_K = 4;
const PAGE_W = 256 * NAV_K;
const CTL_TABLE = 16;
const MAX_SEEDS = 256;

export interface FieldPagesOpts {
  /** the page table's rows: fields that may hold pages at once (ids recycled by the CPU) */
  fields: number;
  /** the pool's pages (PAGE_W distances, 4 KB each) */
  pages: number;
  /** the relax's inner passes a sweep (as RELAX_K) */
  k?: number;
  /** how far a field reaches (cost; none: the whole window) — its pages go no farther */
  reach?: number;
}

export class FieldPages {
  readonly pool: GPUBuffer;
  readonly ctl: GPUBuffer;
  private params: GPUBuffer;
  private seedBuf: GPUBuffer;
  private k: Record<'seed' | 'alloc' | 'reset' | 'front' | 'clear' | 'relax' | 'flip' | 'release', ComputeKernel>;
  private g: GPUBindGroup;
  private gR: GPUBindGroup;
  private args: GPUBuffer;
  private nSeeds = 0;
  readonly chunks: number;
  readonly ctlWords: number;

  constructor(
    private device: GPUDevice,
    agents: Agents,
    readonly o: FieldPagesOpts,
  ) {
    const host = agents.pageHost();
    const w = host.world;
    this.chunks = Math.ceil(w.w / 16) * Math.ceil(w.h / 16);
    const bits = Math.ceil((o.fields * this.chunks) / 32);
    this.ctlWords = CTL_TABLE + o.fields * this.chunks + 3 * bits + o.fields * this.chunks + o.pages;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.pool = device.createBuffer({ label: 'field pages', size: o.pages * PAGE_W * 4, usage: S });
    this.ctl = device.createBuffer({ label: 'field page tables', size: this.ctlWords * 4, usage: S });
    this.args = device.createBuffer({ label: 'field pages args', size: 16, usage: S | GPUBufferUsage.INDIRECT });
    this.params = device.createBuffer({ label: 'field pages params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.seedBuf = device.createBuffer({ label: 'field page seeds', size: MAX_SEEDS * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const specR: BindSpec = { 0: 'uniform', 2: 'uniform', 5: 'rw', 37: 'rw', 60: 'rw', 61: 'rw', 62: 'uniform', 63: 'read' };
    const spec: BindSpec = { ...specR, 64: 'rw' };
    const mk = (e: string, sp = spec) => makeCompute(device, `pages-${e}`, [...host.parts, pagesWgsl], sp, e);
    this.k = { seed: mk('pgSeed'), alloc: mk('pgAlloc'), reset: mk('pgReset'), front: mk('pgFront'), clear: mk('pgClear'), relax: mk('pgRelax', specR), flip: mk('pgFlip'), release: mk('pgRelease') };
    const res = { 0: w.globals, 2: w.materials, 5: host.nav, 37: host.navCost, 60: this.pool, 61: this.ctl, 62: this.params, 63: this.seedBuf };
    this.g = makeBindGroup(device, 'field pages', this.k.front.layout, { ...res, 64: this.args });
    this.gR = makeBindGroup(device, 'field pages relax', this.k.relax.layout, res);
    this.writeParams();
  }

  private writeParams(release = 0xffffffff): void {
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([this.o.fields, this.chunks, this.o.pages, release, this.nSeeds, this.o.k ?? 16, new Uint32Array(new Float32Array([this.o.reach ?? 0]).buffer)[0], 0]));
  }

  /** field f's pages let go (its seeds moved far: it refills from them; or its id recycled) — at once, its own submit */
  release(f: number): void {
    this.writeParams(f);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass({ label: 'field pages release' });
    pass.setBindGroup(0, this.g);
    pass.setPipeline(this.k.release.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.chunks / 64));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.writeParams();
  }

  /** the seeds now: (field, surface index) pairs — a field's distance 0 there */
  seed(seeds: readonly (readonly [number, number])[]): void {
    if (seeds.length > MAX_SEEDS) throw new Error(`field pages: ${seeds.length} seeds (${MAX_SEEDS} at most)`);
    this.nSeeds = seeds.length;
    if (seeds.length) this.device.queue.writeBuffer(this.seedBuf, 0, new Uint32Array(seeds.flat()));
    this.writeParams();
  }

  /** `sweeps` sweeps: the seeds marked, pages handed out, the front built, the pages on it relaxed */
  encode(enc: GPUCommandEncoder, sweeps = 2): void {
    const pass = enc.beginComputePass({ label: 'field pages' });
    pass.setBindGroup(0, this.g);
    const cells = Math.ceil((this.o.fields * this.chunks) / 64);
    pass.setPipeline(this.k.seed.pipeline);
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(this.nSeeds / 64)));
    for (let i = 0; i < sweeps; i++) {
      pass.setPipeline(this.k.alloc.pipeline);
      pass.dispatchWorkgroups(cells);
      pass.setPipeline(this.k.reset.pipeline);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(this.k.front.pipeline);
      pass.dispatchWorkgroups(cells);
      pass.setPipeline(this.k.clear.pipeline);
      pass.dispatchWorkgroups(Math.ceil(Math.ceil((this.o.fields * this.chunks) / 32) / 64));
      pass.setBindGroup(0, this.gR);
      pass.setPipeline(this.k.relax.pipeline);
      pass.dispatchWorkgroupsIndirect(this.args, 0);
      pass.setBindGroup(0, this.g);
      pass.setPipeline(this.k.flip.pipeline);
      pass.dispatchWorkgroups(1);
    }
    pass.end();
  }

  /** (tests, the bench) the pages read back: pages used, refused, and field f's distance at surface s */
  async read(): Promise<{ used: number; refused: number; front: number; dist: (f: number, s: number) => number }> {
    const rd = async (b: GPUBuffer, size: number) => {
      const tmp = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(b, 0, tmp, 0, size);
      this.device.queue.submit([enc.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const out = tmp.getMappedRange().slice(0);
      tmp.destroy();
      return out;
    };
    const ctl = new Uint32Array(await rd(this.ctl, this.ctlWords * 4));
    const pool = new Float32Array(await rd(this.pool, this.o.pages * PAGE_W * 4));
    const dist = (f: number, s: number) => {
      const pg = ctl[CTL_TABLE + f * this.chunks + Math.floor(s / PAGE_W)];
      return pg ? pool[(pg - 1) * PAGE_W + (s % PAGE_W)] : Infinity;
    };
    // (pages held: handed out less those let go)
    let held = 0;
    for (let i = 0; i < this.o.fields * this.chunks; i++) if (ctl[CTL_TABLE + i]) held++;
    return { used: held, refused: ctl[1], front: ctl[2], dist };
  }

  destroy(): void {
    this.pool.destroy();
    this.ctl.destroy();
    this.params.destroy();
    this.seedBuf.destroy();
    this.args.destroy();
  }
}
