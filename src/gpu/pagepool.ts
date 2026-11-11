// ---- gpu/pagepool.ts: the GPU page pool the agents' fields live in (U2 round 7; UNIT_MINDS_U2.md §9b) ---------------
// Chunk-keyed, page-sized GPU data from one pool (shaders/pagepool.wgsl): owners (rows of the page table: field ids)
// hold pages over the window's chunk slots — the terrain ring's slots (common.wgsl pageIdx / slotChunk), so a slide
// moves nothing. The GPU hands pages out (the consumer's kernels ask: ppRequest), lists a front of changed
// (owner, slot)s for an indirect dispatch, and takes them back (ppDrop, ppDropSlot, or the CPU's release of an owner).
// One storage buffer holds the tables and the pages, so a kernel binds the pool once (`wgsl()`). The CPU only says how
// many owners are in use, writes their records, and asks for an owner's pages to be let go.
import { makeBindGroup, makeCompute, type ComputeKernel } from './pipeline';
import poolWgsl from '../shaders/pagepool.wgsl?raw';

export interface PagePoolOpts {
  label: string;
  /** owners: rows of the page table */
  owners: number;
  /** the pool's pages */
  pages: number;
  /** a page's payload in u32 words (plain: written by one workgroup at a time) */
  pageWords: number;
  /** a page's control words (atomic: e.g. bits many threads set), zeroed when the page is handed out */
  pageCtl: number;
  /** an owner's record words (the CPU's) */
  ownerWords: number;
  /** the window's chunk slots (the terrain ring's: chunks across x down) */
  slots: number;
  /** the binding consumers (and the pool's kernels) see it at */
  binding: number;
  /** the front's entries at most (each a page, or a chunk round a marked page: 9 a page; default owners x slots) */
  front?: number;
  /** WGSL the pool's kernels are built over: common.wgsl (Globals, pageIdx, slotChunk) */
  parts: string[];
  /** a handed-out page's payload: words below `split` fill[0], the rest fill[1] (u32 bits) */
  fill: [number, number];
  split: number;
}

/** the header's words (pagepool.wgsl) */
export const PP_HEADER = { end: 0, refused: 1, front: 2, parity: 3, free: 4, stamp: 5, owners: 6 } as const;

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
  readonly layout: { gen: number; table: number; dirty: number; sdirty: number; req: number; stamp: number; front: number; free: number; pctl: number; orec: number; tbits: number; sbits: number };
  private params: GPUBuffer;
  private ops: GPUBuffer;
  private k: Record<'alloc' | 'reset' | 'front' | 'flip' | 'release', ComputeKernel>;
  private bg: GPUBindGroup;
  private pending: number[] = [];
  private box: [number, number, number, number] = [0, 0, 0, 0];
  private opsCap = 256;
  private owners = 0;
  readonly frontCap: number;

  constructor(
    private device: GPUDevice,
    private globals: GPUBuffer,
    readonly o: PagePoolOpts,
  ) {
    if (o.slots > 1 << 16 || o.owners > 1 << 15) throw new Error(`${o.label}: a front entry packs owner << 16 | slot (${o.owners} owners, ${o.slots} slots)`);
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
    this.frontCap = Math.min(n, o.front ?? n);
    const free = front + this.frontCap;
    const pctl = free + o.pages;
    const orec = pctl + o.pages * o.pageCtl;
    this.layout = { gen, table, dirty, sdirty, req, stamp, front, free, pctl, orec, tbits, sbits };
    this.ctlWords = orec + o.owners * o.ownerWords;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.buffer = device.createBuffer({ label: o.label, size: (this.ctlWords + o.pages * o.pageWords) * 4, usage: S });
    this.args = device.createBuffer({ label: `${o.label} args`, size: 16, usage: S | GPUBufferUsage.INDIRECT });
    this.params = device.createBuffer({ label: `${o.label} params`, size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.ops = device.createBuffer({ label: `${o.label} ops`, size: this.opsCap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const parts = [...o.parts, this.wgsl(true)];
    const spec = { 0: 'uniform', [o.binding]: 'rw', 90: 'uniform', 91: 'rw', 92: 'read' } as const;
    const mk = (e: string) => makeCompute(device, `${o.label}-${e}`, parts, spec, e);
    this.k = { alloc: mk('ppAlloc'), reset: mk('ppReset'), front: mk('ppFront'), flip: mk('ppFlip'), release: mk('ppRelease') };
    this.bg = this.group();
    this.writeParams();
  }

  private group(): GPUBindGroup {
    return makeBindGroup(this.device, `${this.o.label} pool`, this.k.front.layout, { 0: this.globals, [this.o.binding]: this.buffer, 90: this.params, 91: this.args, 92: this.ops });
  }

  /**
   * The WGSL a kernel appends to bind the pool at its binding: the control words atomic (marks, asks, page control),
   * the payload plain. `kernels`: the pool's own (its passes only).
   */
  wgsl(kernels = false): string {
    const o = this.o;
    const [, read, write, kern] = poolWgsl.split(/^\/\/#(?:read|write|kernels).*$/m);
    const consts = [`PP_OWNERS: u32 = ${o.owners}u`, `PP_SLOTS: u32 = ${o.slots}u`, `PP_PAGES: u32 = ${o.pages}u`, `PP_PW: u32 = ${o.pageWords}u`, `PP_PC: u32 = ${o.pageCtl}u`, `PP_OW: u32 = ${o.ownerWords}u`, `PP_CTL: u32 = ${this.ctlWords}u`, `PP_FRONT_CAP: u32 = ${this.frontCap}u`]
      .map((c) => `const ${c};\n`)
      .join('');
    const decl = `struct PagePool { ctl: array<atomic<u32>, PP_CTL>, data: array<u32> };\n@group(0) @binding(${o.binding}) var<storage, read_write> pp: PagePool;\nfn ppCtl(i: u32) -> u32 { return atomicLoad(&pp.ctl[i]); }\n`;
    return consts + decl + read + write + (kernels ? kern : '');
  }

  private writeParams(): void {
    const p = new Uint32Array(12);
    p.set([0, 0, 1, this.o.split], 0);
    p.set(this.box, 4);
    p.set(this.o.fill, 8);
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  /** owners in use: ids below `n` (the high-water of the ids handed out) */
  setOwners(n: number): void {
    if (n > this.o.owners) throw new Error(`${this.o.label}: ${n} owners (${this.o.owners} rows)`);
    if (n === this.owners) return;
    this.owners = n;
    this.device.queue.writeBuffer(this.buffer, PP_HEADER.owners * 4, new Uint32Array([n]));
  }

  /** owner o's record (ownerWords u32 words) */
  writeOwner(o: number, words: Uint32Array): void {
    if (words.length > this.o.ownerWords) throw new Error(`${this.o.label}: a record is ${this.o.ownerWords} words`);
    this.device.queue.writeBuffer(this.buffer, (this.layout.orec + o * this.o.ownerWords) * 4, words);
  }

  /** owner o lets go of every page it holds (at the next encodeReleases) */
  release(o: number): void {
    if (!this.pending.includes(o)) this.pending.push(o);
  }

  /** the front walks these window chunks only (x0, y0, x1, y1 exclusive); null: the whole window */
  setBox(b: readonly [number, number, number, number] | null): void {
    const nb: [number, number, number, number] = b ? [b[0], b[1], b[2], b[3]] : [0, 0, 0, 0];
    if (nb.every((v, i) => v === this.box[i])) return;
    this.box = nb;
    this.writeParams();
  }

  /** the releases asked for since the last call, encoded (before anything that seeds or asks this frame) */
  encodeReleases(pass: GPUComputePassEncoder): void {
    if (!this.pending.length) return;
    const ops = this.pending.splice(0);
    if (ops.length + 1 > this.opsCap) {
      this.ops.destroy();
      this.opsCap = 1 << Math.ceil(Math.log2(ops.length + 1));
      this.ops = this.device.createBuffer({ label: `${this.o.label} ops`, size: this.opsCap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.bg = this.group();
    }
    // (the count rides in the ops buffer, not the params: they may be written again before this submit)
    this.device.queue.writeBuffer(this.ops, 0, new Uint32Array([ops.length, ...ops]));
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.k.release.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.o.slots / 64), ops.length);
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

  /** the pages asked for handed out now (outside a sweep: e.g. after the seeds asked for theirs) */
  encodeAlloc(pass: GPUComputePassEncoder): void {
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.k.alloc.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.layout.tbits / 64));
  }

  /** a sweep's end: the marks it made become the next front's */
  encodeFlip(pass: GPUComputePassEncoder): void {
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.k.flip.pipeline);
    pass.dispatchWorkgroups(1);
  }

  /** (the bench card, tests: 64 bytes on demand) the header */
  async stats(): Promise<PagePoolStats> {
    const h = new Uint32Array(await this.read(0, 64));
    return { used: h[PP_HEADER.end] - h[PP_HEADER.free], refused: h[PP_HEADER.refused], front: h[PP_HEADER.front], pages: this.o.pages };
  }

  /** (tests) the whole buffer: the control words and the payload */
  async readAll(): Promise<{ ctl: Uint32Array; data: Uint32Array }> {
    const all = new Uint32Array(await this.read(0, this.buffer.size));
    return { ctl: all.subarray(0, this.ctlWords), data: all.subarray(this.ctlWords) };
  }

  /** (tests) owner o's page over `slot` (+ 1; 0 none) from a readAll */
  pageOf(ctl: Uint32Array, o: number, slot: number): number {
    return ctl[this.layout.table + o * this.o.slots + slot];
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
