// ---- gpu/pagepool.ts: the shared GPU page pool (U2 round 7; docs/design/PAGEPOOL.md) ---------------------------------
// Chunk-keyed, page-sized GPU data from one pool (shaders/pagepool.wgsl): owners (rows of the page table) hold pages over
// the window's chunk slots — the terrain ring's slots, so a slide moves nothing: the slots coming in are released for
// every owner. The GPU hands pages out (asked for by the consumer's kernels: ppRequest), lists a front of changed
// (owner, slot)s for an indirect dispatch, and takes them back. One storage buffer holds the tables and the pages, so a
// consumer kernel binds the pool once (`wgsl('rw' | 'read')`). The CPU only hands out owner ids and asks for releases.
import { makeBindGroup, makeCompute, type ComputeKernel } from './pipeline';
import poolWgsl from '../shaders/pagepool.wgsl?raw';

export interface PagePoolOpts {
  label: string;
  /** owners: rows of the page table (ids the CPU hands out and recycles) */
  owners: number;
  /** the pool's pages (from memory: bytes / (pageWords * 4)) */
  pages: number;
  /** a page's payload in u32 words */
  pageWords: number;
  /** the window's chunk slots (the terrain ring's: chunks across x down) */
  slots: number;
  /** the binding consumers (and the pool's kernels) see it at */
  binding: number;
  /** WGSL the pool's kernels are built over: common.wgsl (Globals, pageIdx, slotChunk) */
  parts: string[];
  /** a handed-out page's words: below `split` fill[0], the rest fill[1] (u32 bits) */
  fill?: [number, number];
  split?: number;
  /** a mark lists the 8 slots round it too (a field grows into them, its halo reads them) */
  spread?: boolean;
}

/** the header's words (pagepool.wgsl) */
export const PP_HEADER = { end: 0, refused: 1, front: 2, parity: 3, free: 4, stamp: 5 } as const;

export interface PagePoolStats {
  /** pages held (handed out less those let go) */
  used: number;
  refused: number;
  /** the last sweep's front: entries listed */
  front: number;
  pages: number;
}

export class PagePool {
  readonly buffer: GPUBuffer;
  /** the relax's indirect args (x: the front's entries, a workgroup each) */
  readonly args: GPUBuffer;
  readonly ctlWords: number;
  readonly layout: { gen: number; table: number; dirty: number; sdirty: number; req: number; stamp: number; front: number; free: number; tbits: number; sbits: number };
  private params: GPUBuffer;
  private ops: GPUBuffer;
  private k: Record<'alloc' | 'reset' | 'front' | 'flip' | 'release', ComputeKernel>;
  private bg: GPUBindGroup;
  private freeOwners: number[] = [];
  private high = 0;
  private pending: number[] = [];
  private box: [number, number, number, number] = [0, 0, 0, 0];
  private opsCap = 256;

  constructor(
    private device: GPUDevice,
    private globals: GPUBuffer,
    readonly o: PagePoolOpts,
  ) {
    if (o.slots >= 1 << 16 || o.owners >= 1 << 15) throw new Error(`${o.label}: a front entry packs owner << 16 | slot (${o.owners} owners, ${o.slots} slots)`);
    const n = o.owners * o.slots;
    const tbits = Math.ceil(n / 32);
    const sbits = Math.ceil(o.slots / 32);
    const gen = 16;
    const table = gen + o.pages;
    const dirty = table + n;
    const sdirty = dirty + 2 * tbits;
    const req = sdirty + 2 * sbits;
    const stamp = req + tbits;
    const front = stamp + n;
    const free = front + n;
    this.layout = { gen, table, dirty, sdirty, req, stamp, front, free, tbits, sbits };
    this.ctlWords = free + o.pages;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.buffer = device.createBuffer({ label: o.label, size: (this.ctlWords + o.pages * o.pageWords) * 4, usage: S });
    this.args = device.createBuffer({ label: `${o.label} args`, size: 16, usage: S | GPUBufferUsage.INDIRECT });
    this.params = device.createBuffer({ label: `${o.label} params`, size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.ops = device.createBuffer({ label: `${o.label} ops`, size: this.opsCap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const parts = [...o.parts, this.wgsl('rw', true)];
    const spec = { 0: 'uniform', [o.binding]: 'rw', 90: 'uniform', 91: 'rw', 92: 'read' } as const;
    const mk = (e: string) => makeCompute(device, `${o.label}-${e}`, parts, spec, e);
    this.k = { alloc: mk('ppAlloc'), reset: mk('ppReset'), front: mk('ppFront'), flip: mk('ppFlip'), release: mk('ppRelease') };
    this.bg = makeBindGroup(device, `${o.label} pool`, this.k.front.layout, { 0: globals, [o.binding]: this.buffer, 90: this.params, 91: this.args, 92: this.ops });
    this.writeParams();
  }

  /** the constants a module that binds the pool is built with */
  private consts(): string {
    const o = this.o;
    return `const PP_OWNERS: u32 = ${o.owners}u;\nconst PP_SLOTS: u32 = ${o.slots}u;\nconst PP_PAGES: u32 = ${o.pages}u;\nconst PP_PW: u32 = ${o.pageWords}u;\nconst PP_CTL: u32 = ${this.ctlWords}u;\n`;
  }

  /**
   * The WGSL a consumer appends to bind the pool at `binding`: 'rw' (control words atomic: marks, asks; the payload
   * written) or 'read' (plain loads only — a kernel that just reads its owners' pages). `kernels`: the pool's own.
   */
  wgsl(mode: 'rw' | 'read', kernels = false): string {
    const [, read, write, kern] = poolWgsl.split(/^\/\/#(?:read|write|kernels).*$/m);
    const b = this.o.binding;
    const decl =
      mode === 'rw'
        ? `struct PagePool { ctl: array<atomic<u32>, PP_CTL>, data: array<u32> };\n@group(0) @binding(${b}) var<storage, read_write> pp: PagePool;\nfn ppCtl(i: u32) -> u32 { return atomicLoad(&pp.ctl[i]); }\n`
        : `struct PagePool { ctl: array<u32, PP_CTL>, data: array<u32> };\n@group(0) @binding(${b}) var<storage, read> pp: PagePool;\nfn ppCtl(i: u32) -> u32 { return pp.ctl[i]; }\n`;
    return this.consts() + decl + read + (mode === 'rw' ? write : '') + (kernels ? kern : '');
  }

  private writeParams(): void {
    const o = this.o;
    const p = new Uint32Array(12);
    p.set([this.high, 0, o.spread ? 1 : 0, o.split ?? o.pageWords], 0);
    p.set(this.box, 4);
    p.set([o.fill?.[0] ?? 0, o.fill?.[1] ?? 0], 8);
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  /** an owner id (a row), recycled; null when every row is held */
  claim(): number | null {
    const o = this.freeOwners.pop() ?? (this.high < this.o.owners ? this.high++ : null);
    if (o !== null) this.writeParams();
    return o;
  }

  /** owner o lets go of every page it holds (at the next encode); `recycle`: its id handed out again later */
  release(o: number, recycle = true): void {
    this.pending.push(o);
    if (recycle) this.freeOwners.push(o);
  }

  /** chunk slots whose chunk changed (a slide: the slots of the chunks come in) — every owner's page there let go */
  releaseSlots(slots: Iterable<number>): void {
    for (const s of slots) this.pending.push((s | 0x80000000) >>> 0);
  }

  /** the front walks these window chunks only (x0, y0, x1, y1 exclusive); null: the whole window */
  setBox(b: readonly [number, number, number, number] | null): void {
    this.box = b ? [b[0], b[1], b[2], b[3]] : [0, 0, 0, 0];
    this.writeParams();
  }

  /** owners in use (the high-water of the ids handed out) */
  get ownersInUse(): number {
    return this.high;
  }

  /** the releases asked for since the last call, encoded (before anything that seeds or asks this frame) */
  encodeReleases(pass: GPUComputePassEncoder): void {
    if (!this.pending.length) return;
    const ops = this.pending.splice(0);
    if (ops.length + 1 > this.opsCap) {
      this.ops.destroy();
      this.opsCap = 1 << Math.ceil(Math.log2(ops.length + 1));
      this.ops = this.device.createBuffer({ label: `${this.o.label} ops`, size: this.opsCap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.bg = makeBindGroup(this.device, `${this.o.label} pool`, this.k.front.layout, { 0: this.globals, [this.o.binding]: this.buffer, 90: this.params, 91: this.args, 92: this.ops });
    }
    this.device.queue.writeBuffer(this.ops, 0, new Uint32Array([ops.length, ...ops]));
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.k.release.pipeline);
    pass.dispatchWorkgroups(Math.ceil(Math.max(this.o.slots, this.o.owners) / 64), ops.length);
    // (the count rides in the ops buffer, not the params: params may be written again before this submit)
  }

  /** a sweep's start: the asked-for pages handed out, the front built (then the consumer dispatches over `args`) */
  encodeFront(pass: GPUComputePassEncoder): void {
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.k.alloc.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.layout.tbits / 64));
    pass.setPipeline(this.k.reset.pipeline);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.k.front.pipeline);
    pass.dispatchWorkgroups(Math.ceil((this.layout.tbits + this.layout.sbits) / 64));
  }

  /** a sweep's end: the marks it made become the next front's */
  encodeFlip(pass: GPUComputePassEncoder): void {
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.k.flip.pipeline);
    pass.dispatchWorkgroups(1);
  }

  /** pages handed out by the last encodes (alloc only — no front), e.g. after seeding outside a sweep */
  encodeAlloc(pass: GPUComputePassEncoder): void {
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.k.alloc.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.layout.tbits / 64));
  }

  /** (tests, the bench card: 64 bytes, on demand) the header */
  async stats(): Promise<PagePoolStats> {
    const h = await this.readCtl(0, 16);
    return { used: h[PP_HEADER.end] - h[PP_HEADER.free], refused: h[PP_HEADER.refused], front: h[PP_HEADER.front], pages: this.o.pages };
  }

  /** (tests) ctl words [at, at + n) */
  async readCtl(at: number, n: number): Promise<Uint32Array> {
    return new Uint32Array(await this.read(at * 4, n * 4));
  }

  /** (tests) page pg's payload (pg the page, not + 1) */
  async readPage(pg: number): Promise<Uint32Array> {
    return new Uint32Array(await this.read((this.ctlWords + pg * this.o.pageWords) * 4, this.o.pageWords * 4));
  }

  /** (tests) the whole buffer: ctl and payload */
  async readAll(): Promise<{ ctl: Uint32Array; data: Uint32Array }> {
    const all = new Uint32Array(await this.read(0, this.buffer.size));
    return { ctl: all.subarray(0, this.ctlWords), data: all.subarray(this.ctlWords) };
  }

  private async read(off: number, size: number): Promise<ArrayBuffer> {
    const tmp = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.buffer, off, tmp, 0, size);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = tmp.getMappedRange().slice(0);
    tmp.destroy();
    return out;
  }

  destroy(): void {
    for (const b of [this.buffer, this.args, this.params, this.ops]) b.destroy();
  }
}
