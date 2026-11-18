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
/** words a page: 256 counts + 256 columns x K x 3 */
export const PW = 12544;
export const K = 16;
export const RES_ID = 8;
export const MAX_LEVELS = 8;
const UB = 256;
const USLOTS = 256;
/** reg: 16 header words, 40 slots of 12 (0-31 the plan's, 32-39 the CPU's) */
const REG_WORDS = 16 + 40 * 12;
const CPU_SLOT = 32;
const CTL_STACK = 16;
/** a brush's radius at most, in the edited level's columns (nest.wgsl MAX_R; the melt scratch is sized by it: NS-9) */
const MAX_BRUSH = 76;

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
  cap: number;
  tab!: GPUBuffer;
  ctl!: GPUBuffer;
  pg!: GPUBuffer;
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
  private pipes: Record<string, GPUComputePipeline> = {};
  private enc: GPUCommandEncoder | null = null;
  private pass: GPUComputePassEncoder | null = null;
  readonly stats: PoolStats;
  private reading = false;
  private pendingBound = 0;
  private maxBinding: number;
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
  ) {
    if (![2, 4, 8, 16].includes(k)) throw new Error(`k = ${k}: the lab nests at 2, 4, 8 or 16 (a chunk is 16 columns)`);
    this.cap = pages;
    this.maxBinding = device.limits.maxStorageBufferBindingSize;
    this.stats = { cap: pages, used: 0, free: pages, refused: 0, mismatch: 0, tableFull: 0, maxCz: 0, grows: 0 };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.tab = device.createBuffer({ label: 'nest table', size: TCAP * 16, usage: S });
    this.allocPool(pages);
    this.scr = device.createBuffer({ label: 'nest scratch', size: 160 * 160 * 8 * 4, usage: S });
    this.reg = device.createBuffer({ label: 'nest regions', size: REG_WORDS * 4, usage: S });
    this.args = device.createBuffer({ label: 'nest dispatch args', size: 40 * 16, usage: S | GPUBufferUsage.INDIRECT });
    this.cam = device.createBuffer({ label: 'nest camera', size: 1024 * 4, usage: S });
    this.ubuf = device.createBuffer({ label: 'nest uniforms', size: UB * USLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // the table starts empty (key1 = EMPTY)
    device.queue.writeBuffer(this.tab, 0, new Uint32Array(TCAP * 4).fill(0xffffffff));
    device.queue.writeBuffer(this.reg, 0, new Int32Array(REG_WORDS));
    const st = GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      label: 'nest',
      entries: [
        { binding: 0, visibility: st, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UB } },
        ...[1, 2, 3, 4, 5, 6].map((binding) => ({ binding, visibility: st, buffer: { type: 'storage' as const } })),
      ],
    });
    const module = device.createShaderModule({ label: 'nest', code: `const TCAP: u32 = ${TCAP}u;\n${storeWgsl}\n${nestWgsl}` });
    this.planLayout = device.createBindGroupLayout({
      label: 'nest plan',
      entries: [
        { binding: 0, visibility: st, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UB } },
        ...[1, 2, 3, 4, 5, 6, 7].map((binding) => ({ binding, visibility: st, buffer: { type: 'storage' as const } })),
      ],
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const ppl = device.createPipelineLayout({ bindGroupLayouts: [this.planLayout] });
    for (const e of ['derive', 'restrictK', 'rootGen', 'zPick', 'release', 'merge', 'edit', 'meltSnap', 'meltApply', 'camera', 'pick', 'ball'])
      this.pipes[e] = device.createComputePipeline({ label: `nest ${e}`, layout: pl, compute: { module, entryPoint: e } });
    this.pipes.plan = device.createComputePipeline({ label: 'nest plan', layout: ppl, compute: { module, entryPoint: 'plan' } });
    this.rebind();
  }

  private allocPool(pages: number): void {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    if (pages * PW * 4 > this.maxBinding) throw new Error(`the page pool would need ${((pages * PW * 4) / 2 ** 20).toFixed(0)} MB, past this device's largest storage binding (${(this.maxBinding / 2 ** 20).toFixed(0)} MB): NS-4`);
    this.pg = this.device.createBuffer({ label: 'nest pages', size: pages * PW * 4, usage: S });
    this.ctl = this.device.createBuffer({ label: 'nest pool control', size: (CTL_STACK + 2 * pages) * 4, usage: S });
  }
  private rebind(): void {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.ubuf, size: UB } },
      { binding: 1, resource: { buffer: this.tab } },
      { binding: 2, resource: { buffer: this.ctl } },
      { binding: 3, resource: { buffer: this.pg } },
      { binding: 4, resource: { buffer: this.scr } },
      { binding: 5, resource: { buffer: this.reg } },
      { binding: 6, resource: { buffer: this.cam } },
    ];
    this.bg = this.device.createBindGroup({ label: 'nest', layout: this.layout, entries });
    this.planBg = this.device.createBindGroup({ label: 'nest plan', layout: this.planLayout, entries: [...entries, { binding: 7, resource: { buffer: this.args } }] });
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
    p.setBindGroup(0, entry === 'plan' ? this.planBg : this.bg, [off]);
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
        const end = Math.min(h[0], this.cap);
        Object.assign(this.stats, { cap: this.cap, used: end - h[2], free: this.cap - end + h[2], refused: h[1], mismatch: h[4], tableFull: h[5], maxCz: h[7] });
        this.pendingBound = Math.max(0, this.pendingBound - bound);
        this.reading = false;
      },
      () => {
        this.reading = false;
      },
    );
  }
  /** before an op that may take `pages` (worst case): grow the pool when it would not fit (never awaited) */
  private reserve(pages: number): void {
    const need = this.stats.used + this.pendingBound + pages;
    this.pendingBound += pages;
    if (need <= this.cap * 0.9) return;
    let cap = this.cap;
    while (need > cap * 0.9) cap *= 2;
    this.grow(cap);
  }
  /** a bigger pool: the pages and the control words copied on the GPU (pending frees are empty: every op ends merged) */
  grow(cap: number): void {
    this.submit();
    const oldPg = this.pg;
    const oldCtl = this.ctl;
    const oldCap = this.cap;
    this.allocPool(cap);
    const enc = this.device.createCommandEncoder({ label: 'nest grow' });
    enc.copyBufferToBuffer(oldPg, 0, this.pg, 0, oldPg.size);
    enc.copyBufferToBuffer(oldCtl, 0, this.ctl, 0, (CTL_STACK + oldCap) * 4);
    this.device.queue.submit([enc.finish()]);
    oldPg.destroy();
    oldCtl.destroy();
    this.cap = cap;
    this.stats.cap = cap;
    this.stats.grows++;
    this.rebind();
  }
  private overflowPages(): number {
    return 1 + this.stats.maxCz;
  }

  // ---- operations -----------------------------------------------------------------------------------------------------
  /** the root: n x n columns (n a multiple of 16); a stripe column (self-test) of `stripe.count` intervals */
  root(n: number, stripe?: { x: number; y: number; count: number }): void {
    this.wins[0] = { gx: 0, gy: 0, n };
    this.reserve((n / 16) ** 2 * (stripe ? 4 : 1));
    const off = this.uni(({ e }) => e.set(stripe ? [stripe.x, stripe.y, stripe.count, 0] : [-1, -1, 0, 0]));
    this.run('rootGen', off, n / 16, n / 16);
    this.mergeFrees();
    this.submit();
  }
  private mergeFrees(): void {
    this.run('merge', this.uni(), 1);
  }
  /** a child level at depth L over window w (chunk aligned; inside its parent with room for the enhance support) */
  promote(L: number, w: Win): void {
    if (L !== this.live) throw new Error(`promote depth ${L}: ${this.live} levels live`);
    this.checkWin(L, w);
    this.wins[L] = { ...w };
    this.reserve((w.n / 16) ** 2 * this.overflowPages());
    // the z origin is picked where a level is promoted somewhere new; a window overlapping the last one at this depth
    // keeps it, so demote then promote is bit-identical (NS-11: a long slide keeps it too)
    const lw = this.lastWin[L];
    const overlap = lw && lw.gx < w.gx + w.n && w.gx < lw.gx + lw.n && lw.gy < w.gy + w.n && w.gy < lw.gy + lw.n;
    if (!overlap) this.run('zPick', this.uni(({ a }) => (a[3] = L)), 1);
    this.lastWin[L] = { ...w };
    const s = this.cpuSlot(0, { x0: w.gx / 16, y0: w.gy / 16, x1: (w.gx + w.n) / 16, y1: (w.gy + w.n) / 16 });
    this.runIndirect('derive', this.uni(({ a, r }) => ((a[2] = 0), (a[3] = L), (r[0] = s))), s);
    this.mergeFrees();
    this.submit();
  }
  /** drop the level at depth L and every deeper one; their residual pages stay */
  demote(L: number): void {
    for (let m = this.live - 1; m >= L; m--) {
      this.run('release', this.uni(({ a, e }) => ((a[3] = m), e.set([0, 0, 0, 0]))), TCAP / 64);
      this.wins[m] = null;
    }
    this.mergeFrees();
    this.submit();
  }
  /** move the level at depth L to window w (same size): only the table changes for chunks that stay; the leaving
   *  chunks' pages are let go and the entering chunks derived */
  slide(L: number, w: Win): void {
    const o = this.wins[L]!;
    if (w.n !== o.n) throw new Error('slide: a window keeps its size');
    this.checkWin(L, w);
    const nc = { x0: w.gx / 16, y0: w.gy / 16, x1: (w.gx + w.n) / 16, y1: (w.gy + w.n) / 16 };
    const oc = { x0: o.gx / 16, y0: o.gy / 16, x1: (o.gx + o.n) / 16, y1: (o.gy + o.n) / 16 };
    this.run('release', this.uni(({ a, e }) => ((a[3] = L), e.set([nc.x0, nc.y0, nc.x1, nc.y1]))), TCAP / 64);
    this.mergeFrees();
    this.wins[L] = { ...w };
    this.lastWin[L] = { ...w };
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
    this.reserve(parts.reduce((s, p) => s + (p.x1 - p.x0) * (p.y1 - p.y0), 0) * this.overflowPages());
    parts.forEach((p, i) => {
      const s = this.cpuSlot(i, p);
      this.runIndirect('derive', this.uni(({ a, r }) => ((a[2] = 0), (a[3] = L), (r[0] = s))), s);
    });
    this.mergeFrees();
    this.submit();
  }
  /** an edit: the hit (forced or picked), the regions planned on the GPU, the brush on the hit level, restrict up every
   *  ancestor, residuals and derives down every level */
  edit(spec: EditSpec): void {
    const live = this.live;
    // worst case on each level: the chunks round a brush of that level's radius (capped) and the enhance support
    let bound = 0;
    for (let m = 0; m < live; m++) {
      const r = Math.min(MAX_BRUSH, spec.radius * this.k ** m);
      bound += Math.ceil((2 * r + 4 * this.k + 4) / 16 + 2) ** 2;
    }
    // (carve and add can add intervals: one more overflow page; whole-column residuals take two records an interval)
    const ball = spec.op === 'carve' || spec.op === 'add';
    this.reserve(bound * (this.overflowPages() + (ball ? 1 : 0)));
    const opId = { raise: 1, dig: 2, melt: 3, carve: 4, add: 5 }[spec.op];
    const base = ({ a, r, c, d }: { a: Uint32Array; r: Uint32Array; c: Float32Array; d: Float32Array }) => {
      a[2] = opId;
      c.set([spec.at?.x ?? 0, spec.at?.y ?? 0, spec.radius, spec.amount]);
      // d.y: the melt's rate, or (carve, add) the forced hit's height
      d[1] = ball ? (spec.at?.z ?? 0) : Math.min(0.12, spec.rate ?? 0.1);
      d[2] = spec.at?.level ?? 0;
      r[2] = spec.at ? 1 : 0;
    };
    if (!spec.at) this.run('pick', this.uni(base), 1);
    this.run('plan', this.uni(base), 1);
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
    return new Snapshot(await read(this.tab), await read(this.ctl), await read(this.pg), await read(this.reg));
  }
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
  /** a column's intervals (z0, z1 as f32, material) */
  column(lid: number, X: number, Y: number): { mat: number[]; z0: number[]; z1: number[] } {
    const c = (Y & 15) * 16 + (X & 15);
    const out = { mat: [] as number[], z0: [] as number[], z1: [] as number[] };
    for (let cz = 0; ; cz++) {
      const p = this.page(lid, X >> 4, Y >> 4, cz);
      if (p < 0 || p >= 0xfffffffe) break;
      const m = this.pg[p * PW + c];
      for (let i = 0; i < m; i++) {
        const b = p * PW + 256 + (c * K + i) * 3;
        out.z0.push(this.f[b]);
        out.z1.push(this.f[b + 1]);
        out.mat.push(this.pg[b + 2]);
      }
      if (m < K) break;
    }
    return out;
  }
  zOrigin(L: number): number {
    return new Float32Array(this.reg.buffer, this.reg.byteOffset, 8)[L];
  }
}
