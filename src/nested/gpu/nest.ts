// Nested scales lab: the GPU column store and its passes (docs/design/NESTED_SCALES.md "Storage"; WGSL in store.wgsl
// and nest.wgsl). The CPU says what (promote a window, slide it, demote, edit at the pointer) and the GPU does it: pages
// are handed out and let go by the kernels, an edit's regions on every level are planned on the GPU from the hit. The
// CPU reads back only the pool's header (64 bytes, asynchronously, never awaited) to grow the pool in time, and, in the
// self-test only, everything (readAll).
import storeWgsl from './store.wgsl?raw';
import nestWgsl from './nest.wgsl?raw';
import { DETAIL_AMP } from '../oracle';

/** table entries (a power of two; NS-3) */
export const TCAP = 1 << 15;
/** words a record (z0, z1, material, footprints: store.wgsl RW) and a page: 256 counts + 256 columns x K x RW */
export const RW = 4;
export const PW = 16640;
export const K = 16;
export const RES_ID = 8;
export const MAX_LEVELS = 8;
const UB = 256;
const USLOTS = 256;
/** reg: 16 header words, 64 slots of 12 (0-31 the plan's, 32-39 the CPU's, 40-63 the bakes') */
const SLOTS = 64;
const REG_WORDS = 16 + SLOTS * 12;
const CPU_SLOT = 32;
const BAKE_SLOT = 40;
/** level ids of the baked draw (store.wgsl GAP_ID, MESH_ID) and a mesh page's item slots (IPP) */
export const GAP_ID = 16;
export const MESH_ID = 24;
export const IPP = 573;
const CTL_STACK = 16;
/** a brush's radius at most, in the edited level's columns (nest.wgsl MAX_R; the melt scratch is sized by it: NS-9) */
const MAX_BRUSH = 76;
/** u.r.z flag: a stroke is on (nest.wgsl STROKE) */
const STROKE = 2;
/** the first binding of the page segments (compute and draw) */
export const SEG_BASE = 10;
/** the pool grows in steps of this many pages beyond what is needed */
const GROW_SLACK = 64;

/** the page segments' declarations and accessors (WGSL), for S segments of segP pages each: page p lives in segment
 *  p / segP. One buffer per segment; only the last one in use grows (by a copy), full ones never move. */
export function segWgsl(S: number, segP: number, readOnly: boolean): string {
  const acc = readOnly ? 'read' : 'read_write';
  const decl = Array.from({ length: S }, (_, j) => `@group(0) @binding(${SEG_BASE + j}) var<storage, ${acc}> pg${j}: array<u32>;`).join('\n');
  const cases = (body: (j: number) => string) =>
    Array.from({ length: S }, (_, j) => (j === S - 1 ? `    default: { ${body(j)} }` : `    case ${j}u: { ${body(j)} }`)).join('\n');
  let out = `${decl}\nconst SEGW: u32 = ${segP * PW}u;\nfn pgLoad(i: u32) -> u32 {\n  let s = i / SEGW;\n  let o = i - s * SEGW;\n  switch (s) {\n${cases((j) => `return pg${j}[o];`)}\n  }\n}\n`;
  if (!readOnly) out += `fn pgStore(i: u32, v: u32) {\n  let s = i / SEGW;\n  let o = i - s * SEGW;\n  switch (s) {\n${cases((j) => `pg${j}[o] = v;`)}\n  }\n}\n`;
  return out;
}
export interface PoolOpts {
  /** pages a segment holds at most (default: the device's largest buffer / binding; the self-test sets it small) */
  segPages?: number;
  /** segment bindings (default: as many as the device's storage-buffer limit allows, up to 4) */
  segments?: number;
  /** grow at once when an op does not fit (the self-test); otherwise the op is refused and the pool grows ahead */
  syncGrow?: boolean;
}

export interface Win {
  gx: number;
  gy: number;
  n: number;
}
export type Op = 'raise' | 'dig' | 'melt' | 'carve' | 'add';
export interface PoolStats {
  cap: number;
  used: number;
  free: number;
  refused: number;
  mismatch: number;
  tableFull: number;
  maxCz: number;
  grows: number;
  /** ops refused whole because the pool could not hold their worst case yet (it grows ahead; the op retries) */
  waits: number;
  /** segments in use, pages a segment, segment bindings, pages the device can hold at most */
  segs: number;
  segPages: number;
  segSlots: number;
  maxPages: number;
  /** MB reserved (the pool's buffers) */
  mb: number;
  /** a plain sentence when the device refused memory or the pool is at the device's limit ('' otherwise) */
  error: string;
}
export interface EditSpec {
  op: Op;
  /** world units */
  radius: number;
  amount: number;
  /** a forced hit (window columns of `level`); absent: the pick pass's (the pointer) */
  at?: { level: number; x: number; y: number; z?: number };
  /** melt rate a step (0..0.12) */
  rate?: number;
}

export class GpuNest {
  readonly wins: (Win | null)[] = new Array(MAX_LEVELS).fill(null);
  private lastWin: (Win | null)[] = new Array(MAX_LEVELS).fill(null);
  cap = 0;
  tab!: GPUBuffer;
  ctl!: GPUBuffer;
  /** the page segments (a binding each; unused ones bound to a stand-in) and the pages each holds */
  segs: GPUBuffer[] = [];
  private segCap: number[] = [];
  readonly segP: number;
  readonly S: number;
  private dirLayout: GPUBindGroupLayout;
  private dirBg!: GPUBindGroup;
  /** a grow made ahead (buffers created, waiting for the device's word on memory), applied at the next op */
  private ahead: { cap: number; segs: (GPUBuffer | null)[]; ok: boolean | null } | null = null;
  readonly syncGrow: boolean;
  readonly scr: GPUBuffer;
  readonly reg: GPUBuffer;
  readonly cam: GPUBuffer;
  private ubuf: GPUBuffer;
  private ustage = new ArrayBuffer(UB * USLOTS);
  private uUsed = 0;
  private layout: GPUBindGroupLayout;
  private bg!: GPUBindGroup;
  private planLayout: GPUBindGroupLayout;
  private planBg!: GPUBindGroup;
  readonly args: GPUBuffer;
  /** draw B's indirect arguments a level (written by dirFinish) and the list of mesh pages it instances over */
  readonly drawArgs: GPUBuffer;
  dir!: GPUBuffer;
  private bakeNext = BAKE_SLOT;
  /** (measurement only) skip the bakes: an op's cost without them */
  bakeOff: boolean | 'mesh' = false;
  private pipes: Record<string, GPUComputePipeline> = {};
  private enc: GPUCommandEncoder | null = null;
  private pass: GPUComputePassEncoder | null = null;
  readonly stats: PoolStats;
  private reading = false;
  private pendingBound = 0;
  /** the camera's inputs for the pick pass (set by the page) */
  camIn = new Float32Array(12);
  epoch = performance.now();
  /** the seeded detail's amplitude per wavelength (oracle DETAIL_AMP) */
  detailAmp = DETAIL_AMP;

  constructor(
    readonly device: GPUDevice,
    readonly k: number,
    readonly seed: number,
    pages: number,
    opts: PoolOpts = {},
  ) {
    if (![2, 4, 8, 16].includes(k)) throw new Error(`k = ${k}: the lab nests at 2, 4, 8 or 16 (a chunk is 16 columns)`);
    const lim = device.limits;
    this.segP = opts.segPages ?? Math.floor(Math.min(lim.maxStorageBufferBindingSize, lim.maxBufferSize) / (PW * 4));
    // bindings: the compute layouts use at most 6 other storage buffers (tab, ctl, scr, reg, cam, args), the draw 4
    this.S = opts.segments ?? Math.max(1, Math.min(4, lim.maxStorageBuffersPerShaderStage - 6));
    this.syncGrow = opts.syncGrow ?? false;
    this.stats = { cap: 0, used: 0, free: 0, refused: 0, mismatch: 0, tableFull: 0, maxCz: 0, grows: 0, waits: 0, segs: 0, segPages: this.segP, segSlots: this.S, maxPages: this.S * this.segP, mb: 0, error: '' };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.tab = device.createBuffer({ label: 'nest table', size: TCAP * 16, usage: S });
    this.applyGrow(Math.min(pages, this.S * this.segP), null);
    this.scr = device.createBuffer({ label: 'nest scratch', size: 160 * 160 * 8 * 4, usage: S });
    this.reg = device.createBuffer({ label: 'nest regions', size: REG_WORDS * 4, usage: S });
    this.args = device.createBuffer({ label: 'nest dispatch args', size: SLOTS * 16, usage: S | GPUBufferUsage.INDIRECT });
    this.drawArgs = device.createBuffer({ label: 'nest draw B args', size: MAX_LEVELS * 16, usage: S | GPUBufferUsage.INDIRECT });
    device.queue.writeBuffer(this.drawArgs, 0, new Uint32Array(MAX_LEVELS * 4));
    this.cam = device.createBuffer({ label: 'nest camera', size: 1024 * 4, usage: S });
    this.ubuf = device.createBuffer({ label: 'nest uniforms', size: UB * USLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // the table starts empty (key1 = EMPTY)
    device.queue.writeBuffer(this.tab, 0, new Uint32Array(TCAP * 4).fill(0xffffffff));
    device.queue.writeBuffer(this.reg, 0, new Int32Array(REG_WORDS));
    const st = GPUShaderStage.COMPUTE;
    const uniE = { binding: 0, visibility: st, buffer: { type: 'uniform' as const, hasDynamicOffset: true, minBindingSize: UB } };
    const sto = (bs: number[]) => bs.map((binding) => ({ binding, visibility: st, buffer: { type: 'storage' as const } }));
    const segB = Array.from({ length: this.S }, (_, j) => SEG_BASE + j);
    this.layout = device.createBindGroupLayout({ label: 'nest', entries: [uniE, ...sto([1, 2, 4, 5, 6, ...segB])] });
    const module = device.createShaderModule({ label: 'nest', code: `const TCAP: u32 = ${TCAP}u;\n${segWgsl(this.S, this.segP, false)}\n${storeWgsl}\n${nestWgsl}` });
    this.planLayout = device.createBindGroupLayout({ label: 'nest plan', entries: [uniE, ...sto([1, 2, 4, 5, 6, 7, ...segB])] });
    // the draw's directory passes (the mesh page list and draw B's arguments): their own layout, so no layout holds more
    // than 6 storage buffers besides the segments
    this.dirLayout = device.createBindGroupLayout({ label: 'nest directory', entries: [uniE, ...sto([1, 8, 9, ...segB])] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const ppl = device.createPipelineLayout({ bindGroupLayouts: [this.planLayout] });
    const dpl = device.createPipelineLayout({ bindGroupLayouts: [this.dirLayout] });
    for (const e of ['derive', 'restrictK', 'rootGen', 'zPick', 'release', 'merge', 'edit', 'meltSnap', 'meltApply', 'camera', 'pick', 'ball', 'gapsBake', 'meshBake', 'snap'])
      this.pipes[e] = device.createComputePipeline({ label: `nest ${e}`, layout: pl, compute: { module, entryPoint: e } });
    for (const e of ['plan', 'dilate']) this.pipes[e] = device.createComputePipeline({ label: `nest ${e}`, layout: ppl, compute: { module, entryPoint: e } });
    for (const e of ['dirClear', 'dirBuild', 'dirFinish']) this.pipes[e] = device.createComputePipeline({ label: `nest ${e}`, layout: dpl, compute: { module, entryPoint: e } });
    this.rebind();
  }

  /** the segment bindings' buffers (a stand-in for the unused ones) */
  segBuffers(): GPUBuffer[] {
    // (a stand-in each: two writable bindings may not share a buffer)
    return Array.from({ length: this.S }, (_, j) => (this.segs[j] ??= this.device.createBuffer({ label: 'nest page segment (unused)', size: 16, usage: GPUBufferUsage.STORAGE })));
  }
  /** the pool at `cap` pages: segments filled in order; only segments whose size changes get a new buffer (the one
   *  that held pages copied in on the GPU); ctl and the directory follow. `made`: buffers created ahead (grow). */
  private applyGrow(cap: number, made: (GPUBuffer | null)[] | null): void {
    const U = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const old = { segs: this.segs.slice(), ctl: this.ctl, cap: this.cap };
    const enc = this.device.createCommandEncoder({ label: 'nest grow' });
    const drop: GPUBuffer[] = [];
    for (let j = 0; j < this.S; j++) {
      const want = Math.max(0, Math.min(this.segP, cap - j * this.segP));
      const have = this.segCap[j] ?? 0;
      if (want <= have) continue;
      const b = made?.[j] ?? this.device.createBuffer({ label: `nest pages ${j}`, size: want * PW * 4, usage: U });
      if (have > 0) enc.copyBufferToBuffer(old.segs[j], 0, b, 0, have * PW * 4);
      if (old.segs[j]) drop.push(old.segs[j]);
      this.segs[j] = b;
      this.segCap[j] = want;
    }
    this.ctl = this.device.createBuffer({ label: 'nest pool control', size: (CTL_STACK + 2 * cap) * 4, usage: U });
    if (old.ctl) {
      // (pending frees are empty between ops: every op ends merged)
      enc.copyBufferToBuffer(old.ctl, 0, this.ctl, 0, (CTL_STACK + old.cap) * 4);
      drop.push(old.ctl);
    }
    this.device.queue.submit([enc.finish()]);
    for (const b of drop) b.destroy();
    // the draw's list of mesh pages: up to the pool's pages a level (rebuilt by every op, so a grow needs no copy)
    this.dir?.destroy();
    this.dir = this.device.createBuffer({ label: 'nest mesh directory', size: (16 + MAX_LEVELS * cap * 2) * 4, usage: U });
    this.cap = cap;
    Object.assign(this.stats, { cap, segs: this.segCap.filter((c) => c > 0).length, mb: Math.round((cap * PW * 4) / 2 ** 20), free: cap - this.stats.used });
    if (old.cap > 0) this.stats.grows++;
    if (this.layout) {
      this.rebind();
      // the draw's page list again at once: its stride is the pool's pages, and the new list starts empty (an op
      // refused after this grow would otherwise leave draw B reading an empty list: missing faces)
      this.directory();
      this.submit();
    }
  }
  private rebind(): void {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.ubuf, size: UB } },
      { binding: 1, resource: { buffer: this.tab } },
      { binding: 2, resource: { buffer: this.ctl } },
      { binding: 4, resource: { buffer: this.scr } },
      { binding: 5, resource: { buffer: this.reg } },
      { binding: 6, resource: { buffer: this.cam } },
    ];
    const segE = this.segBuffers().map((buffer, j) => ({ binding: SEG_BASE + j, resource: { buffer } }));
    this.bg = this.device.createBindGroup({ label: 'nest', layout: this.layout, entries: [...entries, ...segE] });
    this.planBg = this.device.createBindGroup({ label: 'nest plan', layout: this.planLayout, entries: [...entries, { binding: 7, resource: { buffer: this.args } }, ...segE] });
    this.dirBg = this.device.createBindGroup({
      label: 'nest directory',
      layout: this.dirLayout,
      entries: [entries[0], entries[1], { binding: 8, resource: { buffer: this.dir } }, { binding: 9, resource: { buffer: this.drawArgs } }, ...segE],
    });
  }

  /** live levels: the chain's length */
  get live(): number {
    let n = 0;
    while (n < MAX_LEVELS && this.wins[n]) n++;
    return n;
  }
  now(): number {
    return (performance.now() - this.epoch) / 1000;
  }

  // ---- encoding --------------------------------------------------------------------------------------------------------
  private begin(): GPUComputePassEncoder {
    if (!this.pass) {
      this.enc = this.device.createCommandEncoder({ label: 'nest' });
      this.pass = this.enc.beginComputePass({ label: 'nest' });
    }
    return this.pass;
  }
  /** a uniform slot filled with the common fields, then `fill` */
  private uni(fill?: (u: { a: Uint32Array; r: Uint32Array; c: Float32Array; d: Float32Array; e: Int32Array }) => void): number {
    if (this.uUsed >= USLOTS) throw new Error('nest: more passes in one submit than uniform slots');
    const off = this.uUsed++ * UB;
    const a = new Uint32Array(this.ustage, off, 4);
    const r = new Uint32Array(this.ustage, off + 16, 4);
    const c = new Float32Array(this.ustage, off + 32, 4);
    const d = new Float32Array(this.ustage, off + 48, 4);
    const e = new Int32Array(this.ustage, off + 64, 4);
    const lv = new Int32Array(this.ustage, off + 80, 32);
    const cam = new Float32Array(this.ustage, off + 208, 12);
    a.set([this.k, this.seed, 0, 0]);
    r.set([0, this.cap, 0, this.live]);
    c.fill(0);
    d.set([this.now(), 0, 0, this.detailAmp]);
    e.fill(0);
    for (let m = 0; m < MAX_LEVELS; m++) {
      const w = this.wins[m];
      lv.set(w ? [w.gx, w.gy, w.n, 1] : [0, 0, 0, 0], m * 4);
    }
    cam.set(this.camIn);
    fill?.({ a, r, c, d, e });
    return off;
  }
  private run(entry: string, off: number, x: number, y = 1): void {
    if (x <= 0 || y <= 0) return;
    const p = this.begin();
    p.setPipeline(this.pipes[entry]);
    p.setBindGroup(0, entry === 'plan' || entry === 'dilate' ? this.planBg : entry.startsWith('dir') ? this.dirBg : this.bg, [off]);
    p.dispatchWorkgroups(x, y);
  }
  private runIndirect(entry: string, off: number, slot: number): void {
    const p = this.begin();
    p.setPipeline(this.pipes[entry]);
    p.setBindGroup(0, this.bg, [off]);
    p.dispatchWorkgroupsIndirect(this.args, slot * 16);
  }
  /** the encoded passes submitted (the uniforms written first) */
  submit(): void {
    if (!this.pass) return;
    this.pass.end();
    this.device.queue.writeBuffer(this.ubuf, 0, this.ustage, 0, this.uUsed * UB);
    this.device.queue.submit([this.enc!.finish()]);
    this.pass = null;
    this.enc = null;
    this.uUsed = 0;
    this.bakeNext = BAKE_SLOT;
    this.readStats();
  }
  /** a CPU slot: a chunk rect to dispatch over (written before this op's submit) */
  private cpuSlot(i: number, chunks: { x0: number; y0: number; x1: number; y1: number }): number {
    const s = CPU_SLOT + i;
    // (the rect: every column of the dispatched chunks)
    this.device.queue.writeBuffer(this.reg, (16 + s * 12) * 4, new Int32Array([-(2 ** 30), -(2 ** 30), 2 ** 30, 2 ** 30, chunks.x0, chunks.y0]));
    this.device.queue.writeBuffer(this.args, s * 16, new Uint32Array([chunks.x1 - chunks.x0, chunks.y1 - chunks.y0, 1, 0]));
    return s;
  }

  // ---- pool -----------------------------------------------------------------------------------------------------------
  private readStats(): void {
    if (this.reading) return;
    this.reading = true;
    const tmp = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.ctl, 0, tmp, 0, 64);
    this.device.queue.submit([enc.finish()]);
    const bound = this.pendingBound;
    tmp.mapAsync(GPUMapMode.READ).then(
      () => {
        const h = new Uint32Array(tmp.getMappedRange().slice(0));
        tmp.destroy();
        // (the bump end passes the cap only by refused allocations; ctl's cap may be an older, smaller one)
        const end = Math.min(h[0], this.cap);
        Object.assign(this.stats, { used: end - h[2], free: this.cap - end + h[2], refused: h[1], mismatch: h[4], tableFull: h[5], maxCz: h[7] });
        this.pendingBound = Math.max(0, this.pendingBound - bound);
        this.reading = false;
        this.settled = this.pendingBound === 0;
        // (ops submitted while this read was in flight: read again, so their worst cases do not linger)
        if (!this.settled) this.readStats();
        this.growAhead();
      },
      () => {
        this.reading = false;
      },
    );
  }
  /** whether the pool's header read back after the last op (the next op's reserve then sees exact numbers) */
  settled = true;
  /** the last op's worst case (the ahead grow keeps room for one more) */
  private lastBound = 0;
  /** before an op that may take `pages` (worst case): true when it fits. A grow made ahead and confirmed by the device
   *  is applied first. When it does not fit the op is refused whole (it changed nothing) and a grow to what is needed
   *  is made ahead; the caller retries (a held brush: next frame). The self-test grows at once (syncGrow). */
  reserve(pages: number): boolean {
    this.lastBound = Math.max(pages, this.lastBound * 0.9);
    if (this.ahead?.ok) {
      this.submit();
      const a = this.ahead;
      this.ahead = null;
      this.applyGrow(a.cap, a.segs);
    }
    const need = this.stats.used + this.pendingBound + pages;
    if (need > this.cap) {
      if (need > this.stats.maxPages) {
        this.stats.error = `This device can hold ${this.stats.maxPages} pages (${this.S} buffers of ${Math.round((this.segP * PW * 4) / 2 ** 20)} MB); this change needs ${need} (${this.stats.used} in use, ${this.pendingBound} held for changes in flight, ${pages} for its worst case). It was not made.`;
        this.stats.waits++;
        return false;
      }
      if (this.syncGrow) {
        this.submit();
        this.applyGrow(Math.min(this.stats.maxPages, need + GROW_SLACK), null);
      } else {
        this.stats.waits++;
        this.requestGrow(need + GROW_SLACK);
        return false;
      }
    }
    this.pendingBound += pages;
    this.settled = false;
    return true;
  }
  /** keep room for one more op like the last: grow ahead when the pool's free pages fall under it */
  private growAhead(): void {
    if (this.syncGrow) return;
    const need = this.stats.used + this.pendingBound + this.lastBound;
    if (need > this.cap) this.requestGrow(need + GROW_SLACK);
  }
  /** buffers for a bigger pool made ahead; the device says asynchronously whether it had the memory. Applied (copied,
   *  rebound) at the next op's reserve, in queue order. */
  private requestGrow(target: number): void {
    const cap = Math.min(this.stats.maxPages, Math.ceil(target / GROW_SLACK) * GROW_SLACK);
    if (cap <= this.cap || (this.ahead && this.ahead.cap >= cap) || this.stats.error) return;
    if (this.ahead) {
      // (a smaller one still waiting: replaced)
      for (const b of this.ahead.segs) b?.destroy();
      this.ahead = null;
    }
    const U = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.device.pushErrorScope('out-of-memory');
    const segs: (GPUBuffer | null)[] = [];
    let bytes = 0;
    for (let j = 0; j < this.S; j++) {
      const want = Math.max(0, Math.min(this.segP, cap - j * this.segP));
      if (want <= (this.segCap[j] ?? 0)) {
        segs.push(null);
        continue;
      }
      segs.push(this.device.createBuffer({ label: `nest pages ${j}`, size: want * PW * 4, usage: U }));
      bytes += want * PW * 4;
    }
    const a = { cap, segs, ok: null as boolean | null };
    this.ahead = a;
    this.device.popErrorScope().then((e) => {
      if (this.ahead !== a) return;
      if (e) {
        for (const b of a.segs) b?.destroy();
        this.ahead = null;
        this.stats.error = `The device refused ${Math.round(bytes / 2 ** 20)} MB more memory for pages (${this.stats.mb} MB held). Changes that need more were not made.`;
      } else a.ok = true;
    });
  }
  private overflowPages(): number {
    return 1 + this.stats.maxCz;
  }

  // ---- the baked draw ---------------------------------------------------------------------------------------------------
  /** bake level L's draw over region slots (their chunks grown by one: a column's normals and its quads reach its
   *  neighbours): every gap table first, then the mesh items, which read the neighbours' tables */
  private bake(L: number, slots: number[]): void {
    if (this.bakeOff === true) return;
    const dil = slots.map((s) => {
      if (this.bakeNext >= SLOTS) throw new Error('nest: more bake regions in one submit than slots');
      const t = this.bakeNext++;
      this.run('dilate', this.uni(({ a, e }) => ((a[3] = L), e.set([s, t, 0, 0]))), 1);
      return t;
    });
    for (const t of dil) this.runIndirect('gapsBake', this.uni(({ a, r }) => ((a[3] = L), (r[0] = t))), t);
    if (this.bakeOff === 'mesh') return;
    for (const t of dil) this.runIndirect('meshBake', this.uni(({ a, r }) => ((a[3] = L), (r[0] = t))), t);
  }
  /** the draw's list of mesh pages, rebuilt from the table (after an op's bakes and releases) */
  private directory(): void {
    this.run('dirClear', this.uni(), 1);
    this.run('dirBuild', this.uni(), TCAP / 64);
    this.run('dirFinish', this.uni(), 1);
  }
  /** pages a bake may take over `chunks` chunks: a gap page and a mesh page each, plus overflow */
  private bakeBound(chunks: number): number {
    return chunks * 2 * this.overflowPages();
  }

  // ---- operations -----------------------------------------------------------------------------------------------------
  /** the root: n x n columns (n a multiple of 16); a stripe column (self-test) of `stripe.count` intervals */
  root(n: number, stripe?: { x: number; y: number; count: number }): void {
    if (!this.reserve((n / 16) ** 2 * (stripe ? 4 : 1) + this.bakeBound((n / 16) ** 2)))
      throw new Error(`The page pool cannot hold the root terrain on this device. ${this.stats.error}`);
    this.wins[0] = { gx: 0, gy: 0, n };
    const off = this.uni(({ e }) => e.set(stripe ? [stripe.x, stripe.y, stripe.count, 0] : [-1, -1, 0, 0]));
    this.run('rootGen', off, n / 16, n / 16);
    this.bake(0, [this.cpuSlot(0, { x0: 0, y0: 0, x1: n / 16, y1: n / 16 })]);
    this.directory();
    this.mergeFrees();
    this.submit();
  }
  private mergeFrees(): void {
    this.run('merge', this.uni(), 1);
  }
  /** a child level at depth L over window w (chunk aligned; inside its parent with room for the enhance support) */
  promote(L: number, w: Win): boolean {
    if (L !== this.live) throw new Error(`promote depth ${L}: ${this.live} levels live`);
    this.checkWin(L, w);
    if (!this.reserve((w.n / 16) ** 2 * this.overflowPages() + this.bakeBound((w.n / 16) ** 2))) return false;
    this.wins[L] = { ...w };
    // the z origin is picked where a level is promoted somewhere new; a window overlapping the last one at this depth
    // keeps it, so demote then promote is bit-identical (NS-11: a long slide keeps it too)
    const lw = this.lastWin[L];
    const overlap = lw && lw.gx < w.gx + w.n && w.gx < lw.gx + lw.n && lw.gy < w.gy + w.n && w.gy < lw.gy + lw.n;
    if (!overlap) this.run('zPick', this.uni(({ a }) => (a[3] = L)), 1);
    this.lastWin[L] = { ...w };
    const s = this.cpuSlot(0, { x0: w.gx / 16, y0: w.gy / 16, x1: (w.gx + w.n) / 16, y1: (w.gy + w.n) / 16 });
    this.runIndirect('derive', this.uni(({ a, r }) => ((a[2] = 0), (a[3] = L), (r[0] = s))), s);
    this.bake(L, [s]);
    this.directory();
    this.mergeFrees();
    this.submit();
    return true;
  }
  /** drop the level at depth L and every deeper one; their residual pages stay */
  demote(L: number): void {
    for (let m = this.live - 1; m >= L; m--) {
      this.run('release', this.uni(({ a, e }) => ((a[3] = m), e.set([0, 0, 0, 0]))), TCAP / 64);
      this.wins[m] = null;
    }
    this.directory();
    this.mergeFrees();
    this.submit();
  }
  /** move the level at depth L to window w (same size): only the table changes for chunks that stay; the leaving
   *  chunks' pages are let go and the entering chunks derived */
  slide(L: number, w: Win): boolean {
    const o = this.wins[L]!;
    if (w.n !== o.n) throw new Error('slide: a window keeps its size');
    this.checkWin(L, w);
    const nc = { x0: w.gx / 16, y0: w.gy / 16, x1: (w.gx + w.n) / 16, y1: (w.gy + w.n) / 16 };
    const oc = { x0: o.gx / 16, y0: o.gy / 16, x1: (o.gx + o.n) / 16, y1: (o.gy + o.n) / 16 };
    // entering chunks: the new rect less the old, as up to two rects
    const parts: (typeof nc)[] = [];
    const ix0 = Math.max(nc.x0, oc.x0);
    const ix1 = Math.min(nc.x1, oc.x1);
    const iy0 = Math.max(nc.y0, oc.y0);
    const iy1 = Math.min(nc.y1, oc.y1);
    if (ix0 >= ix1 || iy0 >= iy1) parts.push(nc);
    else {
      if (nc.y0 < iy0) parts.push({ ...nc, y1: iy0 });
      if (nc.y1 > iy1) parts.push({ ...nc, y0: iy1 });
      if (nc.x0 < ix0) parts.push({ x0: nc.x0, x1: ix0, y0: iy0, y1: iy1 });
      if (nc.x1 > ix1) parts.push({ x0: ix1, x1: nc.x1, y0: iy0, y1: iy1 });
    }
    const chunks = parts.reduce((s, p) => s + (p.x1 - p.x0 + 2) * (p.y1 - p.y0 + 2), 0);
    if (!this.reserve(chunks * this.overflowPages() + this.bakeBound(chunks))) return false;
    this.run('release', this.uni(({ a, e }) => ((a[3] = L), e.set([nc.x0, nc.y0, nc.x1, nc.y1]))), TCAP / 64);
    this.mergeFrees();
    this.wins[L] = { ...w };
    this.lastWin[L] = { ...w };
    const slots = parts.map((p, i) => {
      const s = this.cpuSlot(i, p);
      this.runIndirect('derive', this.uni(({ a, r }) => ((a[2] = 0), (a[3] = L), (r[0] = s))), s);
      return s;
    });
    this.bake(L, slots);
    this.directory();
    this.mergeFrees();
    this.submit();
    return true;
  }
  /** an edit: the hit (forced or picked), the regions planned on the GPU, the brush on the hit level, restrict up every
   *  ancestor, residuals and derives down every level */
  edit(spec: EditSpec): boolean {
    const live = this.live;
    // worst case on each level: the chunks round a brush of that level's radius (capped) and the enhance support
    let bound = 0;
    for (let m = 0; m < live; m++) {
      const r = Math.min(MAX_BRUSH, spec.radius * this.k ** m);
      bound += Math.ceil((2 * r + 4 * this.k + 4) / 16 + 2) ** 2;
    }
    // (carve and add can add intervals: one more overflow page; whole-column residuals take two records an interval; a
    // stroke's snapshot copies the column pages of chunks it changes for the first time)
    const ball = spec.op === 'carve' || spec.op === 'add';
    const swept = ball && this.stroke;
    if (!this.reserve(bound * (this.overflowPages() * (swept ? 2 : 1) + (ball ? 1 : 0)) + this.bakeBound(bound))) return false;
    const opId = { raise: 1, dig: 2, melt: 3, carve: 4, add: 5 }[spec.op];
    const base = ({ a, r, c, d }: { a: Uint32Array; r: Uint32Array; c: Float32Array; d: Float32Array }) => {
      a[2] = opId;
      c.set([spec.at?.x ?? 0, spec.at?.y ?? 0, spec.radius, spec.amount]);
      // d.y: the melt's rate, or (carve, add) the forced hit's height
      d[1] = ball ? (spec.at?.z ?? 0) : Math.min(0.12, spec.rate ?? 0.1);
      d[2] = spec.at?.level ?? 0;
      r[2] = (spec.at ? 1 : 0) | (swept ? STROKE : 0);
    };
    if (!spec.at) this.run('pick', this.uni(base), 1);
    this.run('plan', this.uni(base), 1);
    // a stroke: the chunks this edit will change, copied first where the stroke has not changed them yet
    if (swept) for (let m = 0; m < live; m++) for (const s of [m * 4 + 3, m * 4 + 2, ...(m + 1 < live ? [(m + 1) * 4] : [])]) this.runIndirect('snap', this.uni((u) => (base(u), (u.a[3] = m), (u.r[0] = s))), s);
    for (let m = 0; m < live; m++) {
      const slot = m * 4 + 3;
      if (spec.op === 'melt') {
        this.runIndirect('meltSnap', this.uni((u) => (base(u), (u.a[3] = m))), slot);
        this.runIndirect('meltApply', this.uni((u) => (base(u), (u.a[3] = m))), slot);
      } else this.runIndirect(ball ? 'ball' : 'edit', this.uni((u) => (base(u), (u.a[3] = m))), slot);
    }
    for (let m = live - 1; m >= 1; m--) this.runIndirect('restrictK', this.uni(({ a, r }) => ((a[3] = m), (r[0] = m * 4))), m * 4);
    for (let m = 1; m < live; m++) {
      this.runIndirect('derive', this.uni(({ a, r }) => ((a[2] = 1), (a[3] = m), (r[0] = m * 4 + 1))), m * 4 + 1);
      this.runIndirect('derive', this.uni(({ a, r }) => ((a[2] = 0), (a[3] = m), (r[0] = m * 4 + 2))), m * 4 + 2);
    }
    // the baked draw where live columns changed: the edit on m, its derive, and the restrict into it from m + 1
    // (parents first: a child's items read its parent's table for the rim morph)
    for (let m = 0; m < live; m++) this.bake(m, [m * 4 + 3, m * 4 + 2, ...(m + 1 < live ? [(m + 1) * 4] : [])]);
    this.directory();
    this.mergeFrees();
    this.submit();
    return true;
  }

  /** a stroke (carve, add; pointer down to up): its edits sweep a capsule from the last centre, and their pick sees the
   *  surface as it was when the stroke began (nest.wgsl snap) */
  stroke = false;
  strokeBegin(): void {
    this.stroke = true;
    this.device.queue.writeBuffer(this.cam, 304 * 4, new Float32Array([0]));
  }
  /** the stroke's snapshot let go */
  strokeEnd(): void {
    if (!this.stroke) return;
    this.stroke = false;
    for (let m = 0; m < this.live; m++) this.run('release', this.uni(({ a, e }) => ((a[2] = 7), (a[3] = m), e.set([0, 0, 0, 0]))), TCAP / 64);
    this.mergeFrees();
    this.submit();
  }

  /** this frame's camera: the eye moved (limited by the nearest solid) and the per-level view-projections (cam buffer)
   *  from camIn; then its report (cam words 0-31) copied out and read when ready (never awaited) */
  camera(): void {
    this.run('camera', this.uni(), 1);
    this.submit();
    const buf = this.camRing.find((b) => !b.busy);
    if (!buf) return;
    buf.busy = true;
    const enc = this.device.createCommandEncoder({ label: 'nest camera report' });
    enc.copyBufferToBuffer(this.cam, 0, buf.b, 0, 128);
    this.device.queue.submit([enc.finish()]);
    const seq = ++this.camSeq;
    buf.b.mapAsync(GPUMapMode.READ).then(
      () => {
        if (seq > this.camGot) {
          this.camGot = seq;
          this.camOut.set(new Float32Array(buf.b.getMappedRange()));
        }
        buf.b.unmap();
        buf.busy = false;
      },
      () => (buf.busy = false),
    );
  }
  /** place the eye: back from the ground under (x, y) by distance d along the view (applied by the next camera pass
   *  whose camIn[3] is 1) */
  placeEye(x: number, y: number, d: number, z = 0): void {
    // (d < 0: the eye at (x, y, z) itself)
    this.device.queue.writeBuffer(this.cam, 256 * 4, new Float32Array([x, y, d, z]));
  }
  /** the camera's last report (cam words 0-31): 20-22 eye hi, 24-26 eye lo, 27 lifts, 28 nearest solid, 29 centre hit
   *  distance (-1 none), 30 the measuring level, 31 the margin */
  readonly camOut = new Float32Array(32);
  private camRingB: { b: GPUBuffer; busy: boolean }[] | null = null;
  private get camRing(): { b: GPUBuffer; busy: boolean }[] {
    this.camRingB ??= [0, 1, 2].map(() => ({ b: this.device.createBuffer({ label: 'nest camera report', size: 128, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }));
    return this.camRingB;
  }
  private camSeq = 0;
  private camGot = 0;

  /** whether window w can sit at depth L inside the current parent */
  fits(L: number, w: Win): boolean {
    try {
      this.checkWin(L, w);
      return true;
    } catch {
      return false;
    }
  }

  private checkWin(L: number, w: Win): void {
    if (w.gx % 16 || w.gy % 16 || w.n % 16) throw new Error(`level ${L}: a window is whole chunks (${w.gx}, ${w.gy}, ${w.n})`);
    const p = this.wins[L - 1];
    if (!p) throw new Error(`level ${L}: no parent`);
    const k = this.k;
    // the enhance support (2 parent cells) and the parent's own rim band (k of its columns, unless the root)
    const margin = L - 1 === 0 ? 0 : k + 2;
    const x0 = w.gx / k;
    const y0 = w.gy / k;
    const x1 = (w.gx + w.n) / k;
    const y1 = (w.gy + w.n) / k;
    if (x0 < p.gx + margin || y0 < p.gy + margin || x1 > p.gx + p.n - margin || y1 > p.gy + p.n - margin) throw new Error(`level ${L}: window ${JSON.stringify(w)} is not inside its parent ${JSON.stringify(p)} with ${margin} cells to spare`);
  }

  /** a window for depth L centred on a focus (global columns of its parent's depth), chunk aligned, inside its parent */
  windowAt(L: number, fx: number, fy: number, n: number): Win {
    const p = this.wins[L - 1]!;
    const k = this.k;
    const margin = L - 1 === 0 ? 0 : k + 2;
    const step = 16;
    const fit = (f: number, p0: number) => {
      let g = Math.round((f * k - n / 2) / step) * step;
      const lo = Math.ceil(((p0 + margin) * k) / step) * step;
      const hi = Math.floor(((p0 + p.n - margin) * k - n) / step) * step;
      return Math.min(hi, Math.max(lo, g));
    };
    return { gx: fit(fx, p.gx), gy: fit(fy, p.gy), n };
  }

  // ---- the self-test's readback (never on the interactive path) -------------------------------------------------------
  /** (diagnostics) the camera buffer */
  async readCam(): Promise<Float32Array> {
    this.submit();
    const tmp = this.device.createBuffer({ size: this.cam.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.cam, 0, tmp, 0, this.cam.size);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(tmp.getMappedRange().slice(0));
    tmp.destroy();
    return out;
  }
  async readAll(): Promise<Snapshot> {
    this.submit();
    const read = async (b: GPUBuffer, size = b.size) => {
      const tmp = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(b, 0, tmp, 0, size);
      this.device.queue.submit([enc.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const out = new Uint32Array(tmp.getMappedRange().slice(0));
      tmp.destroy();
      return out;
    };
    // the segments end to end: page p at p * PW (segments fill in order, so the ids are contiguous)
    const pg = new Uint32Array(this.cap * PW);
    for (let j = 0; j < this.S; j++) if (this.segCap[j]) pg.set(await read(this.segs[j], this.segCap[j] * PW * 4), j * this.segP * PW);
    return new Snapshot(await read(this.tab), await read(this.ctl), pg, await read(this.reg));
  }
}

/** an f16's bits as a number */
export function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 31;
  const m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** a read-back of the store: the WGSL readers on the CPU (tests) */
export class Snapshot {
  private f: Float32Array;
  constructor(
    readonly tab: Uint32Array,
    readonly ctl: Uint32Array,
    readonly pg: Uint32Array,
    readonly reg: Uint32Array,
  ) {
    this.f = new Float32Array(pg.buffer, pg.byteOffset, pg.length);
  }
  private hash(k0: number, k1: number): number {
    let h = (Math.imul(k0, 0x9e3779b1) ^ Math.imul(k1, 0x85ebca6b)) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return h & (TCAP - 1);
  }
  page(lid: number, cx: number, cy: number, cz: number): number {
    const k0 = (cx | (cy << 16)) >>> 0;
    const k1 = lid | (cz << 8);
    let s = this.hash(k0, k1);
    for (let p = 0; p < TCAP; p++) {
      const e1 = this.tab[s * 4 + 1];
      if (e1 === 0xffffffff) return -1;
      if (e1 === k1 && this.tab[s * 4] === k0) return this.tab[s * 4 + 2];
      s = (s + 1) & (TCAP - 1);
    }
    return -1;
  }
  /** pages held by a level id (its table entries) */
  pagesOf(lid: number): number {
    let n = 0;
    for (let s = 0; s < TCAP; s++) {
      const k1 = this.tab[s * 4 + 1];
      if (k1 < 0xfffffffc && (k1 & 0xff) === lid) n++;
    }
    return n;
  }
  /** the chunks ("cx,cy") a level id holds a cz 0 page over */
  chunksOf(lid: number): Set<string> {
    const out = new Set<string>();
    for (let s = 0; s < TCAP; s++) {
      const k1 = this.tab[s * 4 + 1];
      if (k1 < 0xfffffffc && k1 === lid) out.add(`${this.tab[s * 4] & 0xffff},${this.tab[s * 4] >>> 16}`);
    }
    return out;
  }
  /** a column's intervals (z0, z1 as f32, material, footprints eS / eG; for a residual id the fourth word as f32 in
   *  eS) */
  column(lid: number, X: number, Y: number): { mat: number[]; z0: number[]; z1: number[]; eS: number[]; eG: number[] } {
    const c = (Y & 15) * 16 + (X & 15);
    const out = { mat: [] as number[], z0: [] as number[], z1: [] as number[], eS: [] as number[], eG: [] as number[] };
    for (let cz = 0; ; cz++) {
      const p = this.page(lid, X >> 4, Y >> 4, cz);
      if (p < 0 || p >= 0xfffffffe) break;
      const m = this.pg[p * PW + c];
      for (let i = 0; i < m; i++) {
        const b = p * PW + 256 + (c * K + i) * RW;
        out.z0.push(this.f[b]);
        out.z1.push(this.f[b + 1]);
        out.mat.push(this.pg[b + 2]);
        out.eS.push(f16(this.pg[b + 3] & 0xffff));
        out.eG.push(f16(this.pg[b + 3] >>> 16));
      }
      if (m < K) break;
    }
    return out;
  }
  zOrigin(L: number): number {
    return new Float32Array(this.reg.buffer, this.reg.byteOffset, 8)[L];
  }
}
