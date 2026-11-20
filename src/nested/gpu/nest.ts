// Nested scales lab: the GPU column store and its passes (docs/design/NESTED_SCALES.md "Storage"; WGSL in store.wgsl
// and nest.wgsl). The CPU says what (promote a window, slide it, demote, edit at the pointer) and the GPU does it: pages
// are handed out and let go by the kernels, an edit's regions on every level are planned on the GPU from the hit. The
// CPU reads back only the pool's header (64 bytes, asynchronously, never awaited) to grow the pool in time, and, in the
// self-test only, everything (readAll).
import storeWgsl from './store.wgsl?raw';
import nestWgsl from './nest.wgsl?raw';
import fieldWgsl from './field.wgsl?raw';
import { DETAIL_AMP, EDGE_PAD } from '../oracle';
import { EDGE_MASK } from '../edge';

/** table entries (a power of two; NS-3) */
export const TCAP = 1 << 15;
/** words a page: 256 counts + 256 columns x K x 3 (solid pages: residuals, TMP) = 256 + 256 x KR x 2 (column pages:
 *  the partition, a record (top, material)) */
export const PW = 12544;
export const K = 16;
export const KR = 24;
export const RES_ID = 8;
/** level ids (store.wgsl): baked faces, a stroke's snapshot, a pass's scratch */
export const FACE_ID = 16;
export const SNAP_ID = 32;
export const TMP_ID = 40;
/** a face page's triangles (store.wgsl TPP) */
export const TPP = 3135;
/** the material table (store.wgsl matSolid): air is a material, the default above every column */
export const MAT_AIR = 0;
export const MAX_LEVELS = 8;
/** the draw's directory (nest.wgsl dirBuild): 16 counts, the face page lists (a level a cap of 2-word entries), then
 *  (nest.wgsl sheetDir) the sheet counts (8) and lists (EX_PB = 48 words a page a level) */
const dirWords = (cap: number) => 16 + MAX_LEVELS * cap * 2 + 8 + MAX_LEVELS * 48 * cap;
const UB = 256;
const USLOTS = 256;
/** reg: 16 header words, 64 slots of 12 (0-31 the plan's, 32-39 the CPU's, 40-63 the bakes') */
const SLOTS = 64;
const REG_WORDS = 16 + SLOTS * 12;
const CPU_SLOT = 32;
const BAKE_SLOT = 40;
const CTL_STACK = 16;
/** a brush's radius at most, in the edited level's columns (nest.wgsl MAX_R; the melt scratch is sized by it: NS-9) */
const MAX_BRUSH = 76;
/** u.r.z flag: a stroke is on (nest.wgsl STROKE) */
const STROKE = 2;
/** the first binding of the page segments (compute and draw) */
export const SEG_BASE = 10;
/** the pool grows in steps of this many pages beyond what is needed */
const GROW_SLACK = 64;
/** a shrink step lowers the cap by at most this many pages (the most pages it copies: ~12 MB) */
const SHRINK_STEP = 256;

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
  /** (round 19, NS-141) the page: no pipeline made in the constructor; makePipes makes them asynchronously in stages */
  asyncPipes?: boolean;
}

export interface Win {
  gx: number;
  gy: number;
  n: number;
}
export type Op = 'raise' | 'dig' | 'melt' | 'carve' | 'add';
export interface PoolStats {
  /** (round 17, measurement) sheet-pass chunks that reached the hash, and those baked (running counts, ctl 12 / 13) */
  sheetSeen?: number;
  sheetBaked?: number;
  /** (round 26) the field mesh: the deepest quad or scratch page stack so far (ctl 11), quads left out because a cell
   *  round a crossed edge had no vertex (ctl 14: the selection missed it; 0 expected) */
  maxCzField?: number;
  fieldMiss?: number;
  /** (measurement) ctl 15: a counter for diagnoses */
  fieldDbg?: number;
  cap: number;
  used: number;
  free: number;
  refused: number;
  mismatch: number;
  tableFull: number;
  maxCz: number;
  /** the deepest TMP page stack (a pass's scratch: the solid view, 16 intervals a page) */
  maxCzTmp: number;
  /** the deepest face page stack */
  maxCzFace: number;
  grows: number;
  /** shrink steps (round 7, NS-67) */
  shrinks: number;
  /** pages the buffers hold (cap, the pages that may be handed out, is lower while a shrink is under way) */
  held: number;
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

/** (round 25) the generator field (src/nested/gen.ts NestGen): derive and rootGen read it at binding 7 */
export interface GenHook {
  /** header (8 vec4: per level metres a column, the slot's n, 1 filled) then per level an n x n slot of vec4 */
  readonly field: GPUBuffer;
  /** encode the field's fill of level L over a rect of its global columns, in the open compute pass */
  fill(pass: GPUComputePassEncoder, L: number, x0: number, y0: number, w: number, h: number): void;
  /** the submit that held the fills went (their uniform slots may be reused) */
  submitted(): void;
}
/** derive and rootGen (round 25): the entry points bound to the generator field */
// (round 27: restrictK too: it resolves a generated interval's material at the parent's column, nest.wgsl genMat)
const GEN_ENTRIES = ['derive', 'rootGen', 'restrictK'];
/** (round 25) residual pages a leaving root chunk may take for each column page in its stack (nest.wgsl rootGen mode 1:
 *  a residual page holds 16 records, two an interval; a column page up to 24 records) */
const KEEP_PAGES = 3;

let traceNew: ((nest: GpuNest, what: string) => void) | null = null;
/** (tests only) the trace given to pools made from now on (GpuNest.trace) */
export function setTraceNew(fn: ((nest: GpuNest, what: string) => void) | null): void {
  traceNew = fn;
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
  /** (round 25) derive and rootGen: the main layout and the generator field at binding 7 */
  private genLayout: GPUBindGroupLayout;
  private genBg!: GPUBindGroup;
  /** the generator (null: the toy root, the field a stand-in of zeros) */
  gen: GenHook | null = null;
  private genNone: GPUBuffer;
  readonly args: GPUBuffer;
  /** the draw's indirect arguments a level (written by dirFinish) and the list of face pages it instances over */
  readonly drawArgs: GPUBuffer;
  dir!: GPUBuffer;
  private bakeNext = BAKE_SLOT;
  /** (measurement only) skip the bakes: an op's cost without them */
  bakeOff = false;
  /** (measurement only, round 12) a mask of levels whose bakes are skipped: where a carve's bake time goes */
  bakeSkip = 0;
  /** (measurement only, round 12) false: round 11's one bake pipeline for every chunk (the split's A/B) */
  splitBake = true;
  /** (measurement only, round 12) compute dispatches and submits encoded so far */
  readonly counts = { dispatches: 0, submits: 0 };
  private bakeLog: { L: number; slot: number }[] = [];
  private lastBakes: { L: number; slot: number }[] = [];
  /** (measurement only, NS-42) an edit's passes left out: 'restrict', 'residual', 'derive' (the result is then wrong) */
  readonly skip = new Set<string>();
  /** (tests only, round 10) 1: derive's top surface interpolates every neighbour as round 9 did (the before stills) */
  oldTop = 0;
  /** (measurement only, round 11, NS-103) 1: the bake treats no line as a rim line (round 10's rims, the cost A/B) */
  rimOff = 0;
  /** (round 22, ?rimtop=1) the sheet pass gives a corner an edge crosses the height of its members outside the edge
   *  (set before the first bake: it changes baked heights) */
  rimTop = false;
  /** (round 23, ?rimsnap=1, the owner's snap; default off) a crossed corner goes to the least-squares point of its edge
   *  lines inside its own box at its outside members' height; each quad's diagonal from its slid corners; a slid vertex
   *  shades with its quad's own normal (set before the first bake) */
  rimSnap = false;
  private pipes: Record<string, GPUComputePipeline> = {};
  /** the smooth draw (setSmooth): every bake runs the sheet pass instead of the box faces (round 16) */
  smooth = false;
  private enc: GPUCommandEncoder | null = null;
  private pass: GPUComputePassEncoder | null = null;
  readonly stats: PoolStats;
  private reading = false;
  /** the device said no to more memory for pages: no grow is asked again */
  private memoryRefused = false;
  private pendingBound = 0;
  /** the camera's inputs for the pick pass (set by the page) */
  camIn = new Float32Array(12);
  epoch = performance.now();
  /** the seeded detail's amplitude per wavelength (oracle DETAIL_AMP) */
  detailAmp = DETAIL_AMP;
  /** (tests only) told after each op, grow and shrink step was submitted */
  trace: ((nest: GpuNest, what: string) => void) | null = traceNew;

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
    this.stats = { cap: 0, used: 0, free: 0, refused: 0, mismatch: 0, tableFull: 0, maxCz: 0, maxCzTmp: 0, maxCzFace: 0, grows: 0, shrinks: 0, held: 0, waits: 0, segs: 0, segPages: this.segP, segSlots: this.S, maxPages: this.S * this.segP, mb: 0, error: '' };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.tab = device.createBuffer({ label: 'nest table', size: TCAP * 16, usage: S });
    this.applyGrow(Math.min(pages, this.S * this.segP), null);
    this.scr = device.createBuffer({ label: 'nest scratch', size: Math.max(160 * 160 * 8, TCAP * 4) * 4, usage: S }); // (the melt's box; the table's compaction)
    this.reg = device.createBuffer({ label: 'nest regions', size: REG_WORDS * 4, usage: S });
    this.args = device.createBuffer({ label: 'nest dispatch args', size: SLOTS * 16, usage: S | GPUBufferUsage.INDIRECT });
    // (levels 0-7 the box faces, 8-15 the sheets; round 18: the round 14-15 template, wall and exception args are gone)
    this.drawArgs = device.createBuffer({ label: 'nest draw args', size: 2 * MAX_LEVELS * 16, usage: S | GPUBufferUsage.INDIRECT });
    device.queue.writeBuffer(this.drawArgs, 0, new Uint32Array(2 * MAX_LEVELS * 4));
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
    // (round 25) the generator field, read only, at 7 (no layout holds more than 6 storage buffers besides the segments)
    this.genLayout = device.createBindGroupLayout({ label: 'nest gen', entries: [uniE, ...sto([1, 2, 4, 5, 6]), { binding: 7, visibility: st, buffer: { type: 'read-only-storage' } }, ...sto(segB)] });
    this.genNone = device.createBuffer({ label: 'nest gen field (none)', size: 8 * 16, usage: GPUBufferUsage.STORAGE });
    const gpl = device.createPipelineLayout({ bindGroupLayouts: [this.genLayout] });
    // the draw's directory passes (the face page list and the draw's arguments): their own layout, so no layout holds more
    // than 6 storage buffers besides the segments
    this.dirLayout = device.createBindGroupLayout({ label: 'nest directory', entries: [uniE, ...sto([1, 8, 9, ...segB])] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.plMain = pl;
    const ppl = device.createPipelineLayout({ bindGroupLayouts: [this.planLayout] });
    const dpl = device.createPipelineLayout({ bindGroupLayouts: [this.dirLayout] });
    this.plDir = dpl;
    const spec = (name: string, layout: GPUPipelineLayout, entryPoint: string, constants?: Record<string, number>) => (this.specs[name] = { label: `nest ${name}`, layout, compute: { module, entryPoint, constants } });
    for (const e of ['derive', 'restrictK', 'rootGen', 'zPick', 'release', 'resClear', 'merge', 'edit', 'meltSnap', 'meltApply', 'camera', 'pick', 'ball', 'pack', 'faceBake', 'snap', 'tabOut', 'tabIn', 'shrinkFree', 'shrinkMove', 'shrinkCopy']) spec(e, GEN_ENTRIES.includes(e) ? gpl : pl, e);
    // (round 12, NS-103) the bake of chunks that touch a rim line: the rim rule's code compiled in (nest.wgsl BAKE_RIM)
    spec('faceBakeRim', pl, 'faceBake', { BAKE_RIM: 1 });
    for (const e of ['plan', 'dilate']) spec(e, ppl, e);
    for (const e of ['dirClear', 'dirBuild', 'dirFinish']) spec(e, dpl, e);
    // (made on first use, never in normal play: the measurement's one bake, splitBake false; and the sheet pass, made
    // asynchronously when the smooth draw is first wanted: smooth off compiles and runs nothing of it)
    spec('faceBakeOne', pl, 'faceBake', { BAKE_RIM: 1, BAKE_SPLIT: 0 });
    spec('sheetBake', pl, 'sheetBake', { BAKE_RIM: 1 });
    // (round 19, NS-141) tests make every pipeline now; the page makes them asynchronously in stages (makePipes)
    this.asyncPipes = opts.asyncPipes ?? false;
    if (!this.asyncPipes) for (const name of this.bootPipes()) this.pipes[name] = device.createComputePipeline(this.specs[name]!);
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
    // the draw's list of face pages: up to the pool's pages a level (rebuilt by every op, so a grow needs no copy)
    this.dir?.destroy();
    // (round 14: a second list per level, the smooth draw's cache pages)
    this.dir = this.device.createBuffer({ label: 'nest face directory', size: dirWords(cap) * 4, usage: U });
    this.cap = cap;
    Object.assign(this.stats, { cap, held: this.physical, segs: this.segCap.filter((c) => c > 0).length, mb: Math.round((this.physical * PW * 4) / 2 ** 20), free: cap - this.stats.used });
    if (old.cap > 0) this.stats.grows++;
    if (this.layout) {
      this.rebind();
      // the draw's page list again at once: its stride is the pool's pages, and the new list starts empty (an op
      // refused after this grow would otherwise leave the draw reading an empty list: missing faces)
      this.directory();
      this.submit();
    }
    this.trace?.(this,`grow ${old.cap} -> ${cap}${made ? ' (ahead)' : ''}`);
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
    this.genBg = this.device.createBindGroup({ label: 'nest gen', layout: this.genLayout, entries: [...entries, { binding: 7, resource: { buffer: this.gen?.field ?? this.genNone } }, ...segE] });
    // (round 26) the field's directory binds the segments too
    if (this.fieldArgs) this.ensureFieldDir(true);
    this.dirBg = this.device.createBindGroup({
      label: 'nest directory',
      layout: this.dirLayout,
      entries: [entries[0], entries[1], { binding: 8, resource: { buffer: this.dir } }, { binding: 9, resource: { buffer: this.drawArgs } }, ...segE],
    });
  }

  /** (tests) every buffer let go: a pool made for one test and dropped */
  destroy(): void {
    for (const b of [...this.segs, this.tab, this.ctl, this.scr, this.reg, this.args, this.drawArgs, this.dir, this.cam, this.ubuf, this.genNone, this.fieldDir, this.fieldArgs]) b?.destroy();
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
  // ---- (round 19, NS-141) pipelines made in stages -------------------------------------------------------------------
  /** every pipeline's description (by name) */
  private specs: Record<string, GPUComputePipelineDescriptor> = {};
  /** pipelines made only on first use (never in normal play) or by their own switch (the sheet pass) */
  private static readonly ON_USE = ['faceBakeOne', 'sheetBake'];
  // ---- (round 26) the field mesh, on trial behind ?field= (NESTED_SCALES.md "Round 26 plan"; gpu/field.wgsl) ----------
  /** the main and the directory pipeline layouts (the field's passes use them) */
  private plMain!: GPUPipelineLayout;
  private plDir!: GPUPipelineLayout;
  /** levels drawn by the field mesh (bit L); 0: none, and nothing of it is made */
  fieldMask = 0;
  /** the field's dials (set before the first field bake): warp and fade in columns, the selection's margin in cells, the
   *  skirt's depth in columns */
  readonly fieldOpt = { warp: 0.45, fade: 4, margin: 0, skirt: 3, cellNormals: false, stop: 0 };
  /** the field's page list (8 counts, then per level `cap` entries of 3 words) and its draw arguments (a level 16 bytes) */
  fieldDir: GPUBuffer | null = null;
  fieldArgs: GPUBuffer | null = null;
  private fieldDirBg: GPUBindGroup | null = null;
  private fieldDirCap = -1;
  static readonly FIELD_PIPES = ['fieldBake', 'fieldRelease', 'fieldDirClear', 'fieldDirBuild', 'fieldDirFinish', 'fieldFlip'];
  /** (round 26 B3) a field level opening or sliding: its chunks built a few a frame (nearest the eye first) into the bank
   *  not drawn, then flipped together (fieldFlip) with the op's deferred rest (`flip`: the parent's footprint bakes, the
   *  leaving chunks' quads let go). The level's old meshes (or, opening, the parent) are drawn meanwhile; levels and
   *  edits hold still (`switching`). */
  fieldJob: { L: number; queue: { x: number; y: number }[]; flip: () => void; flipPages: number; t0: number; frames: number; chunks: number } | null = null;
  /** (B3) a field job builds a fieldBudget x fieldBudget block of chunks a frame (?fbudget=) */
  fieldBudget = 2;
  /** (B3, measurement) each finished field job: level, kind, chunks, frames, ms */
  readonly fieldLog: { L: number; chunks: number; frames: number; ms: number }[] = [];
  private fieldDefer = false;
  private fieldFlipping = false;
  /** (B3) queue level L's chunks of these rects (clipped to its window) for the job, no repeats */
  private fieldQueue(L: number, rects: { x0: number; y0: number; x1: number; y1: number }[], flipPages: number, flip: () => void): void {
    const seen = new Set<string>();
    const queue: { x: number; y: number }[] = [];
    for (const r0 of rects) {
      const r = this.clipChunks(L, r0);
      for (let y = r.y0; y < r.y1; y++)
        for (let x = r.x0; x < r.x1; x++) {
          const key = `${x},${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({ x, y });
        }
    }
    this.fieldJob = { L, queue, flip, flipPages, t0: performance.now(), frames: 0, chunks: queue.length };
  }
  /** (round 28) pages the bakes of level L - 1 over these rects (its chunks, clipped) may take through the region rule:
   *  its own chunks and its parent's rim chunks over them (in the parent's units, grown by two columns, as dilate does).
   *  The child's ring is not baked (fieldFlipping; a demote has no child left). */
  private flipBound(L: number, rects: { x0: number; y0: number; x1: number; y1: number }[]): number {
    const P = L - 1;
    if (P < 0 || !this.wins[P]) return 0;
    let own = 0;
    let up = 0;
    const k = this.k;
    const S = this.bakeTarget ?? this.smooth;
    for (const r0 of rects) {
      const r = this.clipChunks(P, r0);
      own += GpuNest.area(r);
      if (P > 0 && this.wins[P - 1] && GpuNest.area(r)) {
        const g = { x0: Math.floor(((r.x0 * 16) / k - 2) / 16), y0: Math.floor(((r.y0 * 16) / k - 2) / 16), x1: Math.ceil(((r.x1 * 16) / k + 2) / 16), y1: Math.ceil(((r.y1 * 16) / k + 2) / 16) };
        up += GpuNest.area(this.clipChunks(P - 1, g));
      }
    }
    return this.bakeBound(own, S, P) + (P > 0 ? this.bakeBound(up, S, P - 1) : 0);
  }
  /** (B3) one frame of the field job: up to fieldBudget chunks nearest (ex, ey) (level L's global columns) built,
   *  deferred; the flip once none are left. Call between ops (the app: when no other op runs this frame). */
  stepField(ex: number, ey: number): void {
    const job = this.fieldJob;
    if (!job) return;
    job.frames++;
    const L = job.L;
    if (job.queue.length) {
      // (one dispatch a frame: the fieldBudget x fieldBudget block of chunks, aligned to the budget's grid, holding the
      // queued chunk nearest the eye; every queued chunk in it taken. A chunk of the block not queued is built too, into
      // its bank not drawn, and flips with the rest: work, not a fault)
      let best = 0;
      let bd = Infinity;
      job.queue.forEach((c, i) => {
        const d = Math.hypot(c.x * 16 + 8 - ex, c.y * 16 + 8 - ey);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      const B = this.fieldBudget;
      const c0 = job.queue[best];
      const r = this.clipChunks(L, { x0: Math.floor(c0.x / B) * B, y0: Math.floor(c0.y / B) * B, x1: Math.floor(c0.x / B) * B + B, y1: Math.floor(c0.y / B) * B + B });
      if (!this.reserve(this.bakeBound((r.x1 - r.x0) * (r.y1 - r.y0), this.bakeTarget ?? this.smooth, L))) return;
      job.queue = job.queue.filter((c) => c.x < r.x0 || c.y < r.y0 || c.x >= r.x1 || c.y >= r.y1);
      this.fieldDefer = true;
      const s = this.cpuSlot(0, r);
      this.bake(L, [s], false, [r.y1 - r.y0], 0, true, { per: r.y1 - r.y0, n: 1 });
      this.fieldDefer = false;
      this.mergeFrees();
      this.submit();
      return;
    }
    if (!this.reserve(job.flipPages)) return;
    job.flip();
    this.fieldJob = null;
    this.fieldLog.push({ L, chunks: job.chunks, frames: job.frames, ms: performance.now() - job.t0 });
    this.trace?.(this, `field flip ${L}`);
  }
  fieldOn(L: number): boolean {
    return ((this.fieldMask >> L) & 1) === 1;
  }
  /** (round 26) the levels the field mesh draws: its module and pipeline descriptions made (prepareField), then the mask
   *  set (setFieldMask: only while the root alone is live). Tests and ?field at load. */
  enableField(mask: number): void {
    this.prepareField();
    this.setFieldMask(mask);
  }
  /** (round 28) the field mesh's module, pipeline descriptions and buffers, made once (its pipelines by makePipes, the
   *  page in the background, or at once in tests); nothing is drawn or baked by it until a mask is set */
  prepareField(): void {
    if (this.fieldArgs) return;
    const module = this.device.createShaderModule({ label: 'nest field', code: `const TCAP: u32 = ${TCAP}u;\n${segWgsl(this.S, this.segP, false)}\n${storeWgsl}\n${nestWgsl}\n${fieldWgsl}` });
    for (const e of GpuNest.FIELD_PIPES) this.specs[e] = { label: `nest ${e}`, layout: e.startsWith('fieldDir') ? this.plDir : this.plMain, compute: { module, entryPoint: e } };
    if (!this.asyncPipes) for (const e of GpuNest.FIELD_PIPES) this.pipes[e] = this.device.createComputePipeline(this.specs[e]!);
    // (round 28: an indexed indirect draw a level, 8 words apart)
    this.fieldArgs = this.device.createBuffer({ label: 'nest field draw args', size: MAX_LEVELS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.fieldArgs, 0, new Uint32Array(MAX_LEVELS * 8));
    this.ensureFieldDir();
  }
  /** (round 28) which levels the field mesh draws (bit L, levels 1 and up). Changed only while the root alone is live and
   *  no op or field job is in flight (the caller demotes first): every finer level is then promoted, and baked, afresh in
   *  the new draw, so no level ever holds one draw's pages under the other's mask. */
  setFieldMask(mask: number): void {
    if (mask & 1) throw new Error('?field: the field mesh draws levels 1 and up (the root is baked in the first frame, before its pipelines exist)');
    if (mask === this.fieldMask) return;
    if (mask && !this.fieldArgs) throw new Error('setFieldMask: prepareField first');
    if (this.live > 1 || this.fieldJob || !this.settled) throw new Error('setFieldMask: only while the root alone is live and no op is in flight');
    this.fieldMask = mask;
  }
  /** whether the field's pipelines are made (prepareField'ed and every one made) */
  get fieldMade(): boolean {
    return !!this.fieldArgs && GpuNest.FIELD_PIPES.every((n) => this.pipes[n]);
  }
  /** whether the field's pipelines are made (always, with no field level) */
  get fieldReady(): boolean {
    return !this.fieldMask || this.fieldMade;
  }
  /** the field's page list sized to the pool (its stride is the pool's pages), its bind group with the segments */
  private ensureFieldDir(force = false): void {
    if (!this.fieldArgs) return;
    if (this.fieldDirCap !== this.cap) {
      this.fieldDir?.destroy();
      this.fieldDir = this.device.createBuffer({ label: 'nest field directory', size: (8 + MAX_LEVELS * this.cap * 3) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      this.fieldDirCap = this.cap;
      force = true;
    }
    if (!force && this.fieldDirBg) return;
    const segE = this.segBuffers().map((buffer, j) => ({ binding: SEG_BASE + j, resource: { buffer } }));
    this.fieldDirBg = this.device.createBindGroup({
      label: 'nest field directory',
      layout: this.dirLayout,
      entries: [{ binding: 0, resource: { buffer: this.ubuf, size: UB } }, { binding: 1, resource: { buffer: this.tab } }, { binding: 8, resource: { buffer: this.fieldDir! } }, { binding: 9, resource: { buffer: this.fieldArgs! } }, ...segE],
    });
  }
  /** the page's mode: every pipeline made asynchronously (makePipes) before the ops that use it can run */
  readonly asyncPipes: boolean;
  private making = new Map<string, Promise<void>>();
  /** (round 28, measurement) each pipeline made asynchronously: when (ms after the page opened) and its wait (ms) */
  readonly pipeMade: Record<string, { at: number; ms: number }> = {};
  /** the pipelines normal play makes (every one but ON_USE) */
  bootPipes(): string[] {
    // (round 26: the field's pipelines are the field's own stage, never in normal play's list)
    return Object.keys(this.specs).filter((n) => !GpuNest.ON_USE.includes(n) && !GpuNest.FIELD_PIPES.includes(n));
  }
  /** start making these pipelines asynchronously (those not made or being made), in order; resolves when all are made */
  makePipes(names: string[]): Promise<void> {
    return Promise.all(
      names.map((name) => {
        if (this.pipes[name]) return Promise.resolve();
        let m = this.making.get(name);
        if (!m) {
          const t0 = performance.now();
          m = this.device.createComputePipelineAsync(this.specs[name]!).then((p) => {
            this.pipes[name] = p;
            // (round 28, measurement: when each pipeline was made, ms after the page opened, and how long its own wait was)
            this.pipeMade[name] = { at: performance.now(), ms: performance.now() - t0 };
          });
          this.making.set(name, m);
        }
        return m;
      }),
    ).then(() => undefined);
  }
  /** the boot pipelines made so far, of how many, and those still compiling */
  get pipeStatus(): { made: number; total: number; pending: string[] } {
    const all = this.bootPipes();
    const pending = all.filter((n) => !this.pipes[n]);
    return { made: all.length - pending.length, total: all.length, pending };
  }
  /** a pipeline by name: ON_USE ones made on first use (measurement only); any other must have been made before (the
   *  page's stages; a miss is a boot-order fault, said in words) */
  /** (measurement) the pipelines in the order of their first use */
  readonly firstUse: string[] = [];
  private pipe(entry: string): GPUComputePipeline {
    const p = this.pipes[entry];
    if (!this.firstUse.includes(entry)) this.firstUse.push(entry);
    if (p) return p;
    if (entry === 'faceBakeOne') return (this.pipes[entry] = this.device.createComputePipeline(this.specs[entry]!));
    throw new Error(`nest: pipeline ${entry} used before it was made (NS-141 boot stages)`);
  }
  private run(entry: string, off: number, x: number, y = 1): void {
    if (x <= 0 || y <= 0) return;
    const p = this.begin();
    this.counts.dispatches++;
    p.setPipeline(this.pipe(entry));
    p.setBindGroup(0, entry === 'plan' || entry === 'dilate' ? this.planBg : entry.startsWith('dir') ? this.dirBg : entry.startsWith('fieldDir') ? this.fieldDirBg! : GEN_ENTRIES.includes(entry) ? this.genBg : this.bg, [off]);
    p.dispatchWorkgroups(x, y);
  }
  private runIndirect(entry: string, off: number, slot: number): void {
    const p = this.begin();
    this.counts.dispatches++;
    p.setPipeline(this.pipe(entry));
    p.setBindGroup(0, GEN_ENTRIES.includes(entry) ? this.genBg : this.bg, [off]);
    p.dispatchWorkgroupsIndirect(this.args, slot * 16);
  }
  /** the encoded passes submitted (the uniforms written first); `read` false: work that takes no pages (the camera), so
   *  no read of the pool's header is needed after it */
  submit(read = true): void {
    if (!this.pass) return;
    this.pass.end();
    this.device.queue.writeBuffer(this.ubuf, 0, this.ustage, 0, this.uUsed * UB);
    this.device.queue.submit([this.enc!.finish()]);
    this.pass = null;
    this.enc = null;
    this.uUsed = 0;
    this.gen?.submitted();
    this.bakeNext = BAKE_SLOT;
    this.counts.submits++;
    // (a frame's camera submit bakes nothing: the op's bakes stay readable)
    if (this.bakeLog.length) this.lastBakes = this.bakeLog;
    this.bakeLog = [];
    if (read) this.readStats();
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
        Object.assign(this.stats, { used: end - h[2], free: this.cap - end + h[2], refused: h[1], mismatch: h[4], tableFull: h[5], maxCz: h[7], maxCzTmp: h[8], maxCzFace: h[9], sheetSeen: h[12], sheetBaked: h[13], maxCzField: h[11], fieldMiss: h[14], fieldDbg: h[15] });
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
  /** (measurement) each grow requested: the target, pages in use, held for ops in flight, the last op's worst case */
  readonly growLog: { to: number; used: number; pending: number; last: number }[] = [];
  /** whether the pool's header read back after the last op (the next op's reserve then sees exact numbers) */
  settled = true;
  /** the last op's worst case (the ahead grow keeps room for one more) */
  private lastBound = 0;
  /** before an op that may take `pages` (worst case): true when it fits. A grow made ahead and confirmed by the device
   *  is applied first. When it does not fit the op is refused whole (it changed nothing) and a grow to what is needed
   *  is made ahead; the caller retries (a held brush: next frame). The self-test grows at once (syncGrow). */
  reserve(pages: number): boolean {
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
        // (not taken as the last op's size: the grow ahead would aim at the device's limit)
        return false;
      }
    }
    this.lastBound = Math.max(pages, this.lastBound * 0.9);
    if (need > this.cap) {
      if (this.syncGrow) {
        this.submit();
        this.applyGrow(Math.min(this.stats.maxPages, need + GROW_SLACK), null);
      } else {
        this.stats.waits++;
        // (sized only once the ops in flight have read back: their worst cases are then exact pages in use, not held
        // on top of it; until then the op waits)
        if (this.settled) this.requestGrow(need + GROW_SLACK);
        return false;
      }
    }
    // (an op too big for the device said so in words; the next op that fits clears it, unless the device refused memory)
    if (!this.memoryRefused) this.stats.error = '';
    this.pendingBound += pages;
    this.settled = false;
    return true;
  }
  /** keep room for one more op like the last: grow ahead when the pool's free pages fall under it */
  private growAhead(): void {
    if (this.syncGrow || !this.settled) return;
    const need = this.stats.used + this.pendingBound + this.lastBound;
    if (need > this.cap) this.requestGrow(need + GROW_SLACK);
  }
  /** buffers for a bigger pool made ahead; the device says asynchronously whether it had the memory. Applied (copied,
   *  rebound) at the next op's reserve, in queue order. */
  private requestGrow(target: number): void {
    const cap = Math.min(this.stats.maxPages, Math.ceil(target / GROW_SLACK) * GROW_SLACK);
    // (only the device's refusal stops grows; an op too big for the device is refused alone, round 9)
    if (cap <= this.cap || (this.ahead && this.ahead.cap >= cap) || this.memoryRefused) return;
    // (measurement: why the pool grew)
    this.growLog.push({ to: cap, used: this.stats.used, pending: this.pendingBound, last: Math.round(this.lastBound) });
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
        this.memoryRefused = true;
        this.stats.error = `The device refused ${Math.round(bytes / 2 ** 20)} MB more memory for pages (${this.stats.mb} MB held). Changes that need more were not made.`;
      } else a.ok = true;
    });
  }
  /** pages the pool's buffers hold (above `cap` while a shrink is under way) */
  get physical(): number {
    return this.segCap.reduce((a, b) => a + b, 0);
  }
  /** where a shrink aims: the pages in use and a quarter more, room for one more op like the last, rounded up */
  shrinkTarget(): number {
    return Math.ceil((this.stats.used * 1.25 + this.lastBound + GROW_SLACK) / GROW_SLACK) * GROW_SLACK;
  }
  /** (round 7, NS-67) give pages back, one step a call, only between ops (the caller: once the pool's header came back,
   *  no stroke, no level op this frame). A step lowers the cap by at most SHRINK_STEP pages: the pages in use at or above
   *  the new cap move under it on the GPU (nest.wgsl shrinkFree, shrinkMove, shrinkCopy; at most SHRINK_STEP pages copied).
   *  When the cap has reached the target the buffers are made again at the cap's size (a copy of the pages kept, as a
   *  grow does). true: a step was submitted. */
  shrink(): boolean {
    if (!this.settled || this.stroke || this.syncGrow || this.reading) return false;
    const target = this.shrinkTarget();
    if (this.cap > target) {
      const C = Math.max(target, this.cap - SHRINK_STEP);
      if (this.ahead) {
        for (const b of this.ahead.segs) b?.destroy();
        this.ahead = null;
      }
      this.submit();
      const from = this.cap;
      this.cap = C;
      this.run('shrinkFree', this.uni(), 1);
      this.run('shrinkMove', this.uni(), TCAP / 64);
      this.run('shrinkCopy', this.uni(), from - C);
      this.directory();
      this.mergeFrees();
      // (held unsettled until the pool's header after this step came back: the next op's reserve sees it)
      this.pendingBound += 1;
      this.settled = false;
      this.submit();
      this.stats.cap = C;
      this.stats.shrinks++;
      this.trace?.(this,`shrink ${from} -> ${C}`);
      return true;
    }
    if (this.physical > this.cap) {
      this.realloc();
      return true;
    }
    return false;
  }
  /** the page buffers and ctl made again at the cap's size (after shrink's moves: nothing in use above the cap) */
  private realloc(): void {
    const cap = this.cap;
    this.submit();
    const U = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const enc = this.device.createCommandEncoder({ label: 'nest shrink' });
    const drop: GPUBuffer[] = [];
    const segs = this.segs as (GPUBuffer | undefined)[];
    for (let j = 0; j < this.S; j++) {
      const want = Math.max(0, Math.min(this.segP, cap - j * this.segP));
      const have = this.segCap[j] ?? 0;
      if (want >= have) continue;
      if (segs[j]) drop.push(segs[j]!);
      if (want === 0) segs[j] = undefined;
      else {
        const b = this.device.createBuffer({ label: `nest pages ${j}`, size: want * PW * 4, usage: U });
        enc.copyBufferToBuffer(drop[drop.length - 1], 0, b, 0, want * PW * 4);
        segs[j] = b;
      }
      this.segCap[j] = want;
    }
    const ctl = this.device.createBuffer({ label: 'nest pool control', size: (CTL_STACK + 2 * cap) * 4, usage: U });
    // (the free stack holds only ids under the cap after shrinkFree; pending frees are empty between ops)
    enc.copyBufferToBuffer(this.ctl, 0, ctl, 0, (CTL_STACK + cap) * 4);
    drop.push(this.ctl);
    this.ctl = ctl;
    this.device.queue.submit([enc.finish()]);
    for (const b of drop) b.destroy();
    this.dir.destroy();
    this.dir = this.device.createBuffer({ label: 'nest face directory', size: dirWords(cap) * 4, usage: U });
    Object.assign(this.stats, { held: this.physical, segs: this.segCap.filter((c) => c > 0).length, mb: Math.round((this.physical * PW * 4) / 2 ** 20) });
    this.rebind();
    this.directory();
    this.submit();
    this.trace?.(this,`realloc to ${cap}`);
  }
  private overflowPages(): number {
    return 1 + this.stats.maxCz;
  }
  /** a chunk's TMP pages at most (a pass's scratch; let go by pack and merged at once, so passes reuse them) */
  private tmpPages(): number {
    return 1 + this.stats.maxCzTmp;
  }
  /** a chunk's face pages at most so far */
  private facePages(): number {
    return 1 + this.stats.maxCzFace;
  }

  // ---- the baked draw ---------------------------------------------------------------------------------------------------
  /** (round 17) THE bake region rule, the one function every op's bakes go through (NESTED_SCALES.md "As built (round
   *  17)"). `slots` hold the columns that changed on level M (their data or whether they are drawn). The bakes: (1) level
   *  M's chunks over those columns grown by two; (2) M's live child: its chunks over them in its units, grown by two, that
   *  touch a rim line (its window-edge lines see M's columns outside it); (3) M's parent: its chunks over them in its
   *  units, grown by two, that touch a rim line (its rim lines are the child's lines). `how`: 'edit' bakes a chunk of (1)
   *  only when its own columns' hash changed (any change of the other level's columns reaches it through (2) or (3)),
   *  'window' always (a window op changes what the hash does not hold: rims, owners outside, z origins). Box draw and
   *  sheet draw alike. */
  private bakeChanged(M: number, slots: number[], how: 'edit' | 'window', grow = true, rows?: number[], rowsPer?: { per: number; n: number }): void {
    this.bake(M, slots, grow, rows, 0, how === 'window', rowsPer);
    // (measurement only: skip 'partner' leaves parts 2 and 3 out, the result then wrong)
    if (this.skip.has('partner')) return;
    // (round 26 B3: a field job's flip bakes the parent's footprint through this rule but not the field child's ring,
    // which the job has just built)
    if (M + 1 < this.live && !this.fieldFlipping) this.bake(M + 1, slots, true, undefined, 1);
    if (M > 0) this.bake(M - 1, slots, true, undefined, 2);
  }
  /** bake level L's faces over region slots, their chunks grown by one (a column's walls depend on its neighbours).
   *  partner (round 16/17): the slots are another level's (1: the parent's, 2: the child's), carried into L's chunks by
   *  dilate and baked on rim chunks only. force: no hash skip (window ops). Callers go through bakeChanged. */
  private bake(L: number, slots: number[], grow = true, rows?: number[], partner = 0, force = false, rowsPer?: { per: number; n: number }): void {
    if (this.bakeOff || (this.bakeSkip >> L) & 1) return;
    // (round 17) the sheet pass's mode: 0 hash skip, 1 forced, 2 rim chunks only, forced
    const mode = partner ? 2 : force ? 1 : 0;
    // (round 12) two pipelines over the same slot: chunks that touch no rim line, and those that do (each skips the other's)
    const both = (s: number, nrows0: number) => {
      this.bakeLog.push({ L, slot: s });
      // (round 17) `per` region rows a band: nrows bands
      const per = Math.max(1, Math.min(nrows0, rowsPer?.per ?? 1));
      // (an edit: the bound's bands, the last taking every row after it; else the window's rows, a band each)
      const last = rowsPer ? Math.min(rowsPer.n, Math.ceil(nrows0 / per)) : 0;
      const nrows = last || Math.ceil(nrows0 / per);
      // (round 26) a field level: the field mesh's bake, in the sheets' bands (u.e as the sheet pass; e.w the field
      // levels and the margin; c the warp, fade and skirt)
      if (this.fieldOn(L)) {
        const fo = this.fieldOpt;
        for (let b = 0; b < nrows; b++) {
          const off = this.uni(({ a, r, c, e }) => {
            a[3] = L;
            r[0] = s;
            // (e.w bit 16, B3: a deferred build, flipped by the job's fieldFlip)
            e.set([mode, per | (last << 16), nrows > 1 ? b + 1 : 0, this.fieldMask | (fo.margin << 8) | (this.fieldDefer ? 1 << 16 : 0)]);
            c.set([fo.warp, fo.fade, fo.skirt, (fo.cellNormals ? 1 : 0) | fo.stop]);
          });
          this.runIndirect('fieldBake', off, s);
          if (nrows > 1) this.submit(false);
        }
        return;
      }
      // (round 18: during a switch, the draw being baked)
      if (this.bakeTarget ?? this.smooth) {
        this.smoothPipes();
        // (round 15, NS-116) bands of chunk rows a submit (u.e.z = band + 1; the kernel's other rows return at once): no
        // single submit is long enough for the driver's timeout, whatever the region. All in the same op, so no frame
        // draws between the bands (the draw is submitted after the op). nrows: the slot's rows when the CPU knows them,
        // else the level's window rows (a GPU region lies inside it).
        for (let b = 0; b < nrows; b++) {
          // (e.w bit 1, round 22: ?rimtop=1; bit 2, round 23: ?rimsnap=1)
          const off = this.uni(({ a, r, e }) => ((a[3] = L), (r[0] = s), (e[0] = mode), (e[1] = per | (last << 16)), (e[2] = nrows > 1 ? b + 1 : 0), (e[3] = +this.rimOff | (this.rimTop ? 2 : 0) | (this.rimSnap ? 4 : 0))));
          // (measurement only: skip 'sheet' leaves the sheet pass out, the result then wrong)
          if (!this.skip.has('sheet')) this.runIndirect('sheetBake', off, s);
          if (nrows > 1) this.submit(false);
        }
        return;
      }
      const off = this.uni(({ a, r, e }) => ((a[3] = L), (r[0] = s), (e[3] = this.rimOff)));
      if (!this.splitBake) return this.runIndirect('faceBakeOne', off, s);
      // (round 17) a partner bake: the rim chunks only (the box bake has no hash: every chunk of the region bakes)
      if (!partner) this.runIndirect('faceBake', off, s);
      this.runIndirect('faceBakeRim', off, s);
    };
    const winRows = this.wins[L] ? this.wins[L]!.n / 16 : 1;
    if (!grow) {
      slots.forEach((s, i) => both(s, rows?.[i] ?? winRows));
      return;
    }
    // (round 12, NS-103) one bake over the union of the slots' chunks (up to three a dilate): they mostly overlap, and
    // baked one by one their shared chunks were baked two or three times
    for (let i = 0; i < slots.length; i += 3) {
      if (this.bakeNext >= SLOTS) throw new Error('nest: more bake regions in one submit than slots');
      const t = this.bakeNext++;
      const g = slots.slice(i, i + 3);
      while (g.length < 3) g.push(255);
      this.run('dilate', this.uni(({ a, e }) => ((a[3] = L), e.set([g[0] | (g[1] << 8) | (g[2] << 16), t, partner, 0]))), 1);
      // (round 17) a partner bake in one band: it bakes rim chunks only, at most the level's ring
      both(t, partner ? 1 : winRows);
    }
  }
  /** bake level L's faces over chunk rects given by the CPU (a window's edge ring, a child's footprint grown by a
   *  column: exactly the columns whose neighbours changed between drawn and air), clipped to the window; CPU slots from
   *  `first` (8 a submit; each is written before the submit, so one submit cannot reuse one). `partners` (round 17):
   *  through the region rule (bakeChanged, 'window'): the rects are columns that changed on L; false: L's own bake only
   *  (setSmooth, whose every level's whole window is baked anyway) */
  private bakeRects(L: number, rects: { x0: number; y0: number; x1: number; y1: number }[], first: number, partners = true): void {
    if (first + rects.length > 8) throw new Error('nest: more than 8 CPU slots in one submit');
    const cl = rects.map((r) => this.clipChunks(L, r));
    const slots = cl.map((r, i) => this.cpuSlot(first + i, r));
    const rows = cl.map((r) => r.y1 - r.y0);
    if (partners) this.bakeChanged(L, slots, 'window', false, rows);
    else this.bake(L, slots, false, rows, 0, true);
  }
  /** a chunk rect clipped to level L's window (empty when outside) */
  private clipChunks(L: number, r: { x0: number; y0: number; x1: number; y1: number }): { x0: number; y0: number; x1: number; y1: number } {
    const w = this.wins[L]!;
    const x0 = Math.max(r.x0, w.gx / 16);
    const y0 = Math.max(r.y0, w.gy / 16);
    return { x0, y0, x1: Math.max(x0, Math.min(r.x1, (w.gx + w.n) / 16)), y1: Math.max(y0, Math.min(r.y1, (w.gy + w.n) / 16)) };
  }
  private static area(r: { x0: number; y0: number; x1: number; y1: number }): number {
    return (r.x1 - r.x0) * (r.y1 - r.y0);
  }
  /** the ring of chunks along a window's edge (re-baked after a slide: its walls now face the outside) */
  private ring(w: Win): { x0: number; y0: number; x1: number; y1: number }[] {
    const x0 = w.gx / 16;
    const y0 = w.gy / 16;
    const x1 = (w.gx + w.n) / 16;
    const y1 = (w.gy + w.n) / 16;
    return [
      { x0, y0, x1, y1: y0 + 1 },
      { x0, y0: y1 - 1, x1, y1 },
      { x0, y0, x1: x0 + 1, y1 },
      { x0: x1 - 1, y0, x1, y1 },
    ];
  }
  /** the chunk rect of level L-1 holding the footprint of child window w, grown by two columns (round 8: a column's
   *  bottom depends on its neighbours' depths, and the splits of its walls on the bottoms round its corner lines) */
  private footChunks(L: number, w: Win): { x0: number; y0: number; x1: number; y1: number } {
    const k = this.k;
    return { x0: Math.floor((w.gx / k - 2) / 16), y0: Math.floor((w.gy / k - 2) / 16), x1: Math.ceil(((w.gx + w.n) / k + 2) / 16), y1: Math.ceil(((w.gy + w.n) / k + 2) / 16) };
  }
  /** the draw's list of face pages, rebuilt from the table (after an op's bakes and releases) */
  private directory(): void {
    // (the table's tombstones cleared first: nest.wgsl tabOut / tabIn, NS-14)
    this.run('tabOut', this.uni(), TCAP / 64);
    this.run('tabIn', this.uni(), TCAP / 64);
    this.run('dirClear', this.uni(), 1);
    this.run('dirBuild', this.uni(), TCAP / 64);
    this.run('dirFinish', this.uni(), 1);
    // (round 26) the field's own page list and draw arguments (once its pipelines are made: no field level is live
    // before)
    if (this.fieldMask && this.fieldReady) {
      this.ensureFieldDir();
      this.run('fieldDirClear', this.uni(), 1);
      this.run('fieldDirBuild', this.uni(), TCAP / 64);
      this.run('fieldDirFinish', this.uni(), 1);
    }
  }
  /** a pass's TMP columns written back as the partition (pack) over a slot of level L */
  private pack(L: number, slot: number): void {
    if (this.skip.has('pack')) return;
    this.runIndirect('pack', this.uni(({ a, r }) => ((a[3] = L), (r[0] = slot))), slot);
  }
  /** pages a bake may take over `chunks` chunks that have none of the draw's pages yet. Boxes: face pages, stacked as
   *  deep as any so far. Sheets (round 18: the draw being baked, not both: a sheet bake makes no face pages; round 16-17
   *  asked for both, the face pages' stack on top of the sheets'): page 0, at least one sheet page, and as deep as any
   *  column page stack so far (maxCz). */
  private bakeBound(chunks: number, sheets = this.bakeTarget ?? this.smooth, L?: number): number {
    const per = sheets ? 2 + this.stats.maxCz : this.facePages();
    // (only while a field level is live or is the next one promoted: the others' ops reserve as before; round 28: given
    // the level baked, only when that level is a field level, so the root's and the sheet levels' bakes are not charged
    // the field's bound)
    if (L !== undefined ? !(L > 0 && this.fieldOn(L)) : !(this.fieldMask & ((2 << this.live) - 1))) return chunks * per;
    // (round 26) with field levels: a chunk's quad pages and its scratch (let go at the bake's end, but pending until the
    // next merge), each as deep as any so far, at least 3 until measured (NS-205: a first bake past it leaves a chunk
    // undrawn, as the sheets do)
    const f = 2 * (1 + Math.max(2, this.stats.maxCzField ?? 0)) + 2;
    return chunks * Math.max(per, f);
  }
  /** (round 18) the draw the bakes make while a switch is under way (null: the drawn one, `smooth`) */
  private bakeTarget: boolean | null = null;
  /** (round 18) the sheet pass's pipeline: made asynchronously the first time the smooth draw is wanted (boxes drawn
   *  meanwhile); compileMs its creation time */
  private sheetCompile: Promise<void> | null = null;
  compileMs = 0;
  private compileAt = 0;
  /** (round 18) whether the sheet pass is ready; starts its asynchronous creation when not */
  prepareSheets(): boolean {
    if (this.pipes.sheetBake) return true;
    if (!this.sheetCompile) {
      this.compileAt = performance.now();
      this.sheetCompile = this.makePipes(['sheetBake']).then(() => {
        this.compileMs = performance.now() - this.compileAt;
      });
    }
    return false;
  }
  /** ms since the sheet pass's creation started (while it compiles) */
  get compilingMs(): number {
    return this.sheetCompile && !this.pipes.sheetBake ? performance.now() - this.compileAt : 0;
  }
  /** (tests) the sheet pass made at once */
  private smoothPipes(): void {
    if (this.pipes.sheetBake) return;
    this.pipes.sheetBake = this.device.createComputePipeline(this.specs.sheetBake!);
  }
  /** (round 18) a switch of the drawn draw under way: every live window's chunk rows baked for the wanted draw, a few a
   *  frame; the drawn one flips when the last row is baked. Levels, edits and shrinks hold still meanwhile (the app
   *  checks `switching`), so the rows baked first are not stale at the flip. */
  private job: { on: boolean; rows: { m: number; y: number }[]; i: number; t0: number } | null = null;
  get switching(): boolean {
    return this.job !== null || this.fieldJob !== null;
  }
  /** (round 18) the switch's state in words, for the page ('' when the drawn draw is the wanted one) */
  smoothStatus = '';
  /** (round 18) the wanted draw that can never fit this device (no retry until the wish changes) */
  private cannot: boolean | null = null;
  /** (round 18, measurement) each switch: pages asked, wall time from its first row to the flip, frames, rows */
  readonly switchLog: { on: boolean; pages: number; ms: number; frames: number; rows: number }[] = [];
  private switchPages = 0;
  private switchFrames = 0;
  /** (round 18) one frame of the switch to `on`: compile (asynchronous), reserve, bake up to `rowsPerFrame` chunk rows
   *  of the wanted draw, flip when done. Call only between ops (settled). The old draw stays drawn throughout. */
  stepSmooth(on: boolean, rowsPerFrame: number): void {
    // (the wish changed mid-switch: the drawn draw was never touched; the pages baked so far are let go at the next
    // flip's release or stay as the drawn draw's own)
    if (this.job && this.job.on !== on) this.job = null;
    if (!this.job && on === this.smooth) {
      this.smoothStatus = '';
      this.cannot = null;
      return;
    }
    if (this.cannot === on) return;
    if (on && !this.prepareSheets()) {
      this.smoothStatus = `smooth: compiling the sheet pass (${this.compilingMs.toFixed(0)} ms so far)`;
      return;
    }
    if (!this.job) {
      const rows: { m: number; y: number }[] = [];
      for (let m = 0; m < this.live; m++) {
        const w = this.wins[m]!;
        for (let y = w.gy / 16; y < (w.gy + w.n) / 16; y++) rows.push({ m, y });
      }
      this.job = { on, rows, i: 0, t0: performance.now() };
      this.switchPages = 0;
      this.switchFrames = 0;
    }
    const job = this.job;
    this.switchFrames++;
    const batch = job.rows.slice(job.i, job.i + rowsPerFrame);
    let chunks = 0;
    for (const r of batch) chunks += this.wins[r.m]!.n / 16;
    const pages = this.bakeBound(chunks, on);
    if (!this.reserve(pages)) {
      const need = this.stats.used + pages;
      if (need > this.stats.maxPages) {
        this.cannot = on;
        this.job = null;
        this.smoothStatus = `smooth: cannot switch on this device: needs ${need} pages, the device can hold ${this.stats.maxPages}`;
      } else this.smoothStatus = `smooth: waiting for memory (need ${need} pages, the pool holds ${this.cap}, the device can hold ${this.stats.maxPages})`;
      return;
    }
    this.switchPages += pages;
    this.bakeTarget = on;
    if (on) this.smoothPipes();
    for (const r of batch) {
      const w = this.wins[r.m]!;
      this.bakeRects(r.m, [{ x0: w.gx / 16, y0: r.y, x1: (w.gx + w.n) / 16, y1: r.y + 1 }], 0, false);
      this.mergeFrees();
      this.submit(false);
      this.timeRow(r.m, r.y);
    }
    this.bakeTarget = null;
    job.i += batch.length;
    const last = batch[batch.length - 1];
    this.smoothStatus = `smooth: baking ${on ? 'sheets' : 'boxes'} (row ${job.i} of ${job.rows.length}, level ${last.m})`;
    if (job.i < job.rows.length) {
      // (every row was submitted already: the pool's header read back for this frame's reserve, so the next frame's
      // step sees the pool settled)
      this.readStats();
      return;
    }
    this.finishSwitch(on);
    this.switchLog.push({ on, pages: this.switchPages, ms: performance.now() - job.t0, frames: this.switchFrames, rows: job.rows.length });
    this.job = null;
    this.smoothStatus = '';
  }
  /** the flip: the old draw's pages let go (on: the face pages, which the sheet draw never reads and the switch back
   *  bakes again anyway; off: the sheet pass's cache and sheet pages), then the new draw's directory */
  private finishSwitch(on: boolean): void {
    this.smooth = on;
    for (let m = 0; m < this.live; m++) this.run('release', this.uni(({ a, e }) => ((a[2] = on ? 9 : 8), (a[3] = m), e.set([0, 0, 0, 0]))), TCAP / 64);
    this.mergeFrees();
    this.directory();
    this.mergeFrees();
    this.submit();
    this.trace?.(this, `smooth ${on}`);
  }
  /** the smooth draw switched at once (tests and the reference: the whole switch in one call). Refused (false) while
   *  the pool cannot hold it yet. */
  setSmooth(on: boolean): boolean {
    if (on === this.smooth && !this.job) return true;
    this.job = null;
    if (on) this.smoothPipes();
    let rows = 0;
    for (let m = 0; m < this.live; m++) rows += this.wins[m]!.n / 16;
    this.stepSmooth(on, rows);
    return this.smooth === on;
  }
  /** (measurement only, round 15, NS-116) each chunk row's GPU time of a whole-window bake (setSmooth), when set: the
   *  time from its submit (or the previous row's end) to its end */
  rowTimes: { L: number; y: number; x?: number; ms: number }[] | null = null;
  private lastDone = 0;
  private timeRow(L: number, y: number, x?: number): void {
    const rt = this.rowTimes;
    if (!rt) return;
    const ts = performance.now();
    void this.device.queue.onSubmittedWorkDone().then(() => {
      const now = performance.now();
      rt.push({ L, y, x, ms: now - Math.max(ts, this.lastDone) });
      this.lastDone = now;
    });
  }
  /** (measurement only, round 26) level L's whole window baked again, forced, a chunk row a submit (whichever draw the
   *  level has: sheets, boxes or the field mesh); false while the pool cannot hold it yet */
  rebakeLevel(L: number, oneSubmit = false, side = 0, at?: [number, number]): boolean {
    const w = this.wins[L];
    if (!w) return false;
    // (the bound of what is baked: a block's own, so back-to-back reps are not refused by the window's)
    if (!this.reserve(this.bakeBound(side > 0 ? side * side : (w.n / 16) ** 2))) return false;
    if (oneSubmit) {
      // (the whole window in one dispatch: the GPU's throughput rather than a row's latency; side > 0: only a side x side
      // block of chunks at the window's centre or round global column `at`, the cost of a frame's share)
      const c = at ? { x: Math.floor(at[0] / 16), y: Math.floor(at[1] / 16) } : { x: (w.gx + w.n / 2) / 16, y: (w.gy + w.n / 2) / 16 };
      const r = side > 0 ? { x0: c.x - Math.floor(side / 2), y0: c.y - Math.floor(side / 2), x1: c.x - Math.floor(side / 2) + side, y1: c.y - Math.floor(side / 2) + side } : { x0: w.gx / 16, y0: w.gy / 16, x1: (w.gx + w.n) / 16, y1: (w.gy + w.n) / 16 };
      const rows = r.y1 - r.y0;
      const s = this.cpuSlot(0, r);
      this.bake(L, [s], false, [rows], 0, true, { per: rows, n: 1 });
      this.mergeFrees();
      this.submit(false);
    } else for (let y = w.gy / 16; y < (w.gy + w.n) / 16; y++) {
      this.bakeRects(L, [{ x0: w.gx / 16, y0: y, x1: (w.gx + w.n) / 16, y1: y + 1 }], 0, false);
      this.mergeFrees();
      this.submit(false);
    }
    this.directory();
    this.mergeFrees();
    this.submit();
    return true;
  }
  /** (test only, round 17: the NS-127 / NS-128 discriminator) every live window baked again, forced, a chunk row a
   *  submit: a fault this removes was a missed bake region, one it leaves is the geometry */
  rebakeAll(): boolean {
    let chunks = 0;
    for (let m = 0; m < this.live; m++) chunks += (this.wins[m]!.n / 16) ** 2;
    if (!this.reserve(this.bakeBound(chunks))) return false;
    for (let m = 0; m < this.live; m++) {
      const w = this.wins[m]!;
      for (let y = w.gy / 16; y < (w.gy + w.n) / 16; y++) {
        this.bakeRects(m, [{ x0: w.gx / 16, y0: y, x1: (w.gx + w.n) / 16, y1: y + 1 }], 0, false);
        this.mergeFrees();
        this.submit(false);
      }
    }
    this.directory();
    this.mergeFrees();
    this.submit();
    return true;
  }

  // ---- operations -----------------------------------------------------------------------------------------------------
  /** the root: n x n columns (n a multiple of 16); a stripe column (self-test) of `stripe.count` intervals */
  root(n: number, stripe?: { x: number; y: number; count: number }, gx = 0, gy = 0): void {
    // (column pages, their TMP twins, face pages: the stripe column takes 2 + 3 more in its chunk; round 25: three
    // intervals a generated column, all in one page)
    if (!this.reserve((n / 16) ** 2 * 2 + (stripe ? 5 : 0) + this.bakeBound((n / 16) ** 2)))
      throw new Error(`The page pool cannot hold the root terrain on this device. ${this.stats.error}`);
    this.rootOp(n, stripe, gx, gy);
  }
  private rootOp(n: number, stripe: { x: number; y: number; count: number } | undefined, gx: number, gy: number): void {
    if (gx % 16 || gy % 16) throw new Error(`root: the window is whole chunks (${gx}, ${gy})`);
    this.wins[0] = { gx, gy, n };
    this.lastWin[0] = { gx, gy, n };
    const s = this.cpuSlot(0, { x0: gx / 16, y0: gy / 16, x1: (gx + n) / 16, y1: (gy + n) / 16 });
    // (round 25) the generator's field over the window first, in the same pass
    this.gen?.fill(this.begin(), 0, gx, gy, n, n);
    const off = this.uni(({ r, e }) => ((r[0] = s), e.set(stripe ? [stripe.x, stripe.y, stripe.count, 0] : [-1, -1, 0, 0])));
    this.runIndirect('rootGen', off, s);
    if (this.trace) {
      this.submit(false);
      this.trace(this, 'root: rootGen');
    }
    this.pack(0, s);
    if (this.trace) {
      this.submit(false);
      this.trace(this, 'root: pack');
    }
    this.bakeChanged(0, [s], 'window');
    this.directory();
    this.mergeFrees();
    this.submit();
    this.trace?.(this,'root');
  }
  /** (round 25) attach the generator: derive and rootGen read its field from now on (the caller then makes the root again) */
  setGen(g: GenHook | null): void {
    this.gen = g;
    this.rebind();
  }
  /** (round 25) the root made again over window (gx, gy) (the generator attached since): false when the pool cannot hold
   *  it yet (it grows ahead; the caller retries), as any op */
  remakeRoot(n: number, gx: number, gy: number): boolean {
    if (!this.reserve((n / 16) ** 2 * 2 + this.bakeBound((n / 16) ** 2))) return false;
    this.rootOp(n, undefined, gx, gy);
    return true;
  }
  private mergeFrees(): void {
    this.run('merge', this.uni(), 1);
  }
  /** a child level at depth L over window w (chunk aligned; inside its parent with room for the enhance support) */
  promote(L: number, w: Win): boolean {
    if (L !== this.live) throw new Error(`promote depth ${L}: ${this.live} levels live`);
    this.checkWin(L, w);
    const fc = this.footChunks(L, w);
    // (column pages and their TMP twins, the child's faces, the parent's faces round the footprint)
    // (round 28: a field level bakes nothing here: its chunks are built by the job, each block reserving its own, and the
    // parent's footprint at the flip, which reserves for it. Reserving the whole window's field bound here, at the deepest
    // field stack so far for every chunk, asked ~12,000 pages for a 2,600-page world and grew the pool to 714 MB)
    const fieldL = this.fieldOn(L);
    if (!this.reserve((w.n / 16) ** 2 * (this.overflowPages() + this.tmpPages()) + (fieldL ? 0 : this.bakeBound((w.n / 16) ** 2, this.bakeTarget ?? this.smooth, L) + this.flipBound(L, [fc])))) return false;
    this.wins[L] = { ...w };
    // the z origin is picked where a level is promoted somewhere new; a window overlapping the last one at this depth
    // keeps it, so demote then promote is bit-identical (NS-11: a long slide keeps it too)
    const lw = this.lastWin[L];
    const overlap = lw && lw.gx < w.gx + w.n && w.gx < lw.gx + lw.n && lw.gy < w.gy + w.n && w.gy < lw.gy + lw.n;
    if (!overlap) this.run('zPick', this.uni(({ a }) => (a[3] = L)), 1);
    this.lastWin[L] = { ...w };
    const s = this.cpuSlot(0, { x0: w.gx / 16, y0: w.gy / 16, x1: (w.gx + w.n) / 16, y1: (w.gy + w.n) / 16 });
    // (round 25) the generator's field over the child's window, before its derive reads it
    this.gen?.fill(this.begin(), L, w.gx, w.gy, w.n, w.n);
    this.runIndirect('derive', this.uni(({ a, r, e }) => ((a[2] = 0), (a[3] = L), (r[0] = s), (e[0] = this.oldTop))), s);
    this.pack(L, s);
    // the child's faces, and in the same submit the parent's round the footprint (it stops drawing there, its walls
    // face the child): the parent's surface is never missing for a frame. (Round 14: with the smooth draw on, the child's
    // window a row of chunks a submit: the whole window in one dispatch ran past the driver's timeout and lost the device
    // in a dug world. The op still runs in one frame, so no frame draws a part.)
    // (Round 26 B3) a field level: its chunks built a few a frame (stepField) into the bank not drawn; the level draws
    // nothing and the parent keeps its footprint until the flip, which makes them all drawn and bakes the parent's
    // footprint (its own chunks only: the child's ring was just built with the window) in the same submit
    if (fieldL) {
      const wr = { x0: w.gx / 16, y0: w.gy / 16, x1: (w.gx + w.n) / 16, y1: (w.gy + w.n) / 16 };
      this.directory();
      this.mergeFrees();
      this.submit();
      this.fieldQueue(L, [wr], this.flipBound(L, [fc]), () => {
        this.run('fieldFlip', this.uni(({ a }) => (a[3] = L)), TCAP / 64);
        this.mergeFrees();
        this.fieldFlipping = true;
        this.bakeRects(L - 1, [fc], 1, true);
        this.fieldFlipping = false;
        this.directory();
        this.mergeFrees();
        this.submit();
      });
      this.trace?.(this, `promote ${L} ${JSON.stringify(w)} (field: deferred)`);
      return true;
    }
    if (this.smooth) {
      this.submit(false);
      for (let y = w.gy / 16; y < (w.gy + w.n) / 16; y++) {
        this.bakeRects(L, [{ x0: w.gx / 16, y0: y, x1: (w.gx + w.n) / 16, y1: y + 1 }], 0);
        this.mergeFrees();
        this.submit(false);
      }
    } else this.bakeChanged(L, [s], 'window');
    // (the parent's columns over the footprint stop being drawn: a change of L - 1, through the same rule)
    this.bakeRects(L - 1, [fc], 1);
    this.directory();
    this.mergeFrees();
    this.submit();
    this.trace?.(this,`promote ${L} ${JSON.stringify(w)}`);
    return true;
  }
  /** drop the level at depth L and every deeper one; their residual pages stay */
  demote(L: number): void {
    const was = this.wins[L];
    for (let m = this.live - 1; m >= L; m--) {
      const off = this.uni(({ a, e }) => ((a[3] = m), e.set([0, 0, 0, 0])));
      this.run('release', off, TCAP / 64);
      // (round 26) a field level's quad and scratch pages
      if (this.fieldOn(m)) this.run('fieldRelease', off, TCAP / 64);
      this.wins[m] = null;
    }
    // the parent draws the footprint again, in the same submit; the released pages are merged first, so its new face
    // pages come from them (the child held more than the footprint's faces need)
    this.mergeFrees();
    if (was && L > 0) this.bakeRects(L - 1, [this.footChunks(L, was)], 0);
    this.directory();
    this.mergeFrees();
    this.submit();
    this.trace?.(this,`demote ${L}`);
  }
  /** move the level at depth L to window w (same size): only the table changes for chunks that stay; the leaving
   *  chunks' pages are let go and the entering chunks derived */
  slide(L: number, w: Win): boolean {
    const o = this.wins[L]!;
    if (w.n !== o.n) throw new Error('slide: a window keeps its size');
    // (round 25: the root slides too, generated where it enters; it has no parent to fit in)
    if (L > 0) this.checkWin(L, w);
    else if (w.gx % 16 || w.gy % 16 || w.gx < 0 || w.gy < 0) throw new Error(`root: a window is whole chunks at non-negative columns (${w.gx}, ${w.gy})`);
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
    // (round 25) the root's leaving chunks: their edited columns are kept as the root's residual (one page a chunk at
    // most: a generated column has three intervals, an edited one more, KEEP_PAGES covers 8 intervals a column)
    const leaving: (typeof nc)[] = [];
    if (L === 0) {
      if (ix0 >= ix1 || iy0 >= iy1) leaving.push(oc);
      else {
        if (oc.y0 < iy0) leaving.push({ ...oc, y1: iy0 });
        if (oc.y1 > iy1) leaving.push({ ...oc, y0: iy1 });
        if (oc.x0 < ix0) leaving.push({ x0: oc.x0, x1: ix0, y0: iy0, y1: iy1 });
        if (oc.x1 > ix1) leaving.push({ x0: ix1, x1: oc.x1, y0: iy0, y1: iy1 });
      }
    }
    const keepPages = leaving.reduce((s, p) => s + GpuNest.area(p) * KEEP_PAGES * (1 + this.stats.maxCz), 0);
    const ringN = (4 * w.n) / 16;
    const fp = L > 0 ? this.footChunks(L, o) : null;
    const fn = L > 0 ? this.footChunks(L, w) : null;
    // (round 9) the parent round the old and the new footprint, as two rects clipped to the parent's window: a long slide
    // of a deep level once took the box round both (up to 128 x 128 chunks of level 1's grid, or 1024 x 1024 at level 2)
    // as its worst case, past the device's limit, and the error that left stopped every later grow (NS-88); round 28:
    // counted by flipBound, which clips them the same way
    // (the entering chunks' column pages and TMP twins, their faces, the edge ring's and the parent's round the footprint)
    // (round 28: a field level's bakes reserve their own, in the job's blocks and at its flip; see promote)
    const fieldL = L > 0 && this.fieldOn(L);
    // (a child the new window would not hold is demoted below, which bakes this level over its footprint at once)
    const kid0 = this.wins[L + 1];
    const kidBound = fieldL && kid0 ? this.flipBound(L + 1, [this.footChunks(L + 1, kid0)]) : 0;
    // (round 28: each level's bakes at its own draw's bound: this level's entering chunks and ring, the parent round both
    // footprints and its parent's rim chunks (flipBound), the child's rim chunks (its ring at most))
    const S = this.bakeTarget ?? this.smooth;
    const ownBound = this.bakeBound(chunks + ringN, S, L) + (fp && fn ? this.flipBound(L, [fp, fn]) : 0) + (kid0 ? this.bakeBound((4 * kid0.n) / 16, S, L + 1) : 0);
    if (!this.reserve(chunks * (this.overflowPages() + this.tmpPages()) + (fieldL ? kidBound : ownBound) + keepPages)) return false;
    // (round 17, NS-128) a child the new window would not hold (inside it with the margin, checkWin) is demoted in the
    // same op, before the slide: else for a frame or more (the app runs one level op a frame) the child sits outside
    // its parent, its window-edge lines see no parent columns and its whole edge is open (the selftest's 1,024 open
    // edges), and its zippers keep the parent's old surfaces (the forced-bake diff of NS-127). The parent draws there
    // until the child is promoted again (the app's next frames).
    const kid = this.wins[L + 1];
    if (kid) {
      this.wins[L] = { ...w };
      const ok = this.fits(L + 1, kid);
      this.wins[L] = o;
      if (!ok) this.demote(L + 1);
    }
    // (round 25) the root's leaving columns kept where they differ from the generated ones, before they are let go and
    // before the entering strips' fill takes their slots of the field
    leaving.forEach((p, i) => {
      const s = this.cpuSlot(4 + i, p);
      this.runIndirect('rootGen', this.uni(({ a, r, e }) => ((a[2] = 1), (r[0] = s), e.set([-1, -1, 0, 0]))), s);
    });
    const relOff = this.uni(({ a, e }) => ((a[3] = L), e.set([nc.x0, nc.y0, nc.x1, nc.y1])));
    this.run('release', relOff, TCAP / 64);
    // (round 26 B3: a field level's leaving meshes stay drawn until the job's flip lets them go)
    this.mergeFrees();
    this.wins[L] = { ...w };
    this.lastWin[L] = { ...w };
    const slots = parts.map((p, i) => {
      const s = this.cpuSlot(i, p);
      // (round 25) the generator's field over the entering strip (the slot is toroidal: it replaces the leaving one)
      this.gen?.fill(this.begin(), L, p.x0 * 16, p.y0 * 16, (p.x1 - p.x0) * 16, (p.y1 - p.y0) * 16);
      if (L === 0) this.runIndirect('rootGen', this.uni(({ r, e }) => ((r[0] = s), e.set([-1, -1, 0, 0]))), s);
      else this.runIndirect('derive', this.uni(({ a, r, e }) => ((a[2] = 0), (a[3] = L), (r[0] = s), (e[0] = this.oldTop))), s);
      this.pack(L, s);
      return s;
    });
    // (round 26 B3) a field level: the entering chunks and the one-chunk band beside them (their quads reach in) and the
    // new edge ring built a few a frame into the bank not drawn; the old meshes (the leaving ones too) and the parent as
    // it was stay drawn until the flip, which lets the leaving meshes go and bakes the parent round both footprints
    if (fieldL) {
      this.directory();
      this.mergeFrees();
      this.submit();
      const grown = parts.map((p) => ({ x0: p.x0 - 1, y0: p.y0 - 1, x1: p.x1 + 1, y1: p.y1 + 1 }));
      this.fieldQueue(L, [...grown, ...this.ring(w)], fp && fn ? this.flipBound(L, [fp, fn]) : 0, () => {
        this.run('fieldFlip', this.uni(({ a }) => (a[3] = L)), TCAP / 64);
        this.run('fieldRelease', this.uni(({ a, e }) => ((a[3] = L), e.set([nc.x0, nc.y0, nc.x1, nc.y1]))), TCAP / 64);
        this.mergeFrees();
        // (the parent round both footprints through the region rule, as the sheets' slide does: its own chunks and its
        // parent's rim chunks; not this level's ring)
        this.fieldFlipping = true;
        if (fp && fn) this.bakeRects(L - 1, [fp, fn], 4, true);
        this.fieldFlipping = false;
        this.directory();
        this.mergeFrees();
        this.submit();
      });
      this.trace?.(this, `slide ${L} ${JSON.stringify(w)} (field: deferred)`);
      return true;
    }
    this.bakeChanged(L, slots, 'window');
    // (the CPU slots are taken by the entering parts: the edge ring and the parent's footprint in a second submit; the
    // pool's header is read after the second one only, so the read that settles this op sees all of it, round 9)
    this.directory();
    this.mergeFrees();
    this.submit(false);
    this.bakeRects(L, this.ring(w), 0);
    if (fp && fn) this.bakeRects(L - 1, [fp, fn], 4);
    // (round 16 re-baked the child's whole edge ring here, sheet draw only; round 17: the region rule's partner bakes
    // above carry the entering chunks' change into the child's rim chunks, for both draws)
    this.directory();
    this.mergeFrees();
    this.submit();
    this.trace?.(this,`slide ${L} ${JSON.stringify(w)}`);
    return true;
  }
  /** an edit: the hit (forced or picked), the regions planned on the GPU, the brush on the hit level, restrict up every
   *  ancestor, residuals and derives down every level */
  edit(spec: EditSpec): boolean {
    const live = this.live;
    // worst case on each level: the chunks round a brush of that level's radius (capped) and the enhance support
    // (clipped to the level's window)
    let bound = 0;
    let most = 0;
    const per: number[] = [];
    for (let m = 0; m < live; m++) {
      const r = Math.min(MAX_BRUSH, spec.radius * this.k ** m);
      // (round 22: + 2 EDGE_PAD, a ball's box grown for the edge samples round its outline)
      const c = Math.min(Math.ceil((2 * r + 4 * this.k + 4 + 2 * EDGE_PAD) / 16 + 2) ** 2, (this.wins[m]!.n / 16) ** 2);
      per.push(c);
      bound += c;
      most = Math.max(most, c);
    }
    const ball = spec.op === 'carve' || spec.op === 'add';
    const swept = ball && this.stroke;
    // What an edit can take: in each chunk it changes, one more column page (a column grown past its page stack), a
    // residual stack (a whole-column residual where there was none), one more face page (faces grown past a page), and
    // in a stroke the snapshot's copy of the column pages; and the TMP scratch of the largest pass only, since every
    // pass's TMP pages are let go and merged before the next pass takes any.
    // (round 28) a field level's chunks rebuilt by the edit: both banks and the scratch at the field's bound (the "one
    // more face page" above is a sheet's growth; a field chunk's new bank is written beside the drawn one)
    let fieldPages = 0;
    for (let m = 1; m < live; m++) if (this.fieldOn(m)) fieldPages += this.bakeBound(per[m], this.bakeTarget ?? this.smooth, m);
    if (!this.reserve(bound * (2 + this.overflowPages() + (swept ? this.overflowPages() : 0)) + most * this.tmpPages() + fieldPages)) return false;
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
      } else if (!this.skip.has('ball')) this.runIndirect(ball ? 'ball' : 'edit', this.uni((u) => (base(u), (u.a[3] = m))), slot);
      this.pack(m, slot);
      this.mergeFrees();
    }
    // (round 10) a carve or add clears the residuals every finer level kept under the columns its ball covers (live and
    // dropped levels), so they are enhance(parent) there again (nest.wgsl resClear; the owner's rule)
    if (ball && !this.skip.has('resClear')) {
      this.run('resClear', this.uni(base), TCAP / 64);
      this.mergeFrees();
    }
    for (let m = live - 1; m >= 1; m--) {
      if (this.skip.has('restrict')) continue;
      this.runIndirect('restrictK', this.uni(({ a, r }) => ((a[3] = m), (r[0] = m * 4))), m * 4);
      this.pack(m - 1, m * 4);
      this.mergeFrees();
    }
    for (let m = 1; m < live; m++) {
      if (!this.skip.has('residual')) this.runIndirect('derive', this.uni(({ a, r, e }) => ((a[2] = 1), (a[3] = m), (r[0] = m * 4 + 1), (e[0] = this.oldTop))), m * 4 + 1);
      if (this.skip.has('derive')) continue;
      this.runIndirect('derive', this.uni(({ a, r, e }) => ((a[2] = 0), (a[3] = m), (r[0] = m * 4 + 2), (e[0] = this.oldTop))), m * 4 + 2);
      this.pack(m, m * 4 + 2);
      this.mergeFrees();
    }
    // the baked draw where live columns changed: the edit on m, its derive, and the restrict into it from m + 1
    // (parents first: a child's items read its parent's table for the rim morph)
    // (round 17, the region rule: GpuNest.bakeChanged) the columns of m that changed: the edit on m, its derive, and the
    // restrict into it from m + 1; m's own chunks over them, and its child's and parent's rim chunks over them (round 16
    // did the partners for the sheet draw only, from chunk rects; NS-126, NS-119)
    // (round 17, NS-129) the submit bound: a submit bakes at most a window row's chunks. An edit's region on a level is
    // about sqrt(per[m]) chunks wide (the bound above), so a band takes as many region rows as fit in a window row (round
    // 15 banded every bake one row a submit: 16 submits a region whatever its size). The bands still cover every row of
    // the window (correctness never rests on the bound; only the time a submit takes does). Measurement: skip 'bands'.
    for (let m = 0; m < live; m++) {
      // (the region's side at most the bound's, plus the dilate's chunk each way)
      const side = Math.ceil(Math.sqrt(per[m])) + 2;
      const rp = Math.max(1, Math.floor(this.wins[m]!.n / 16 / side));
      const rowsPer = this.skip.has('bands') ? undefined : { per: rp, n: Math.ceil(side / rp) };
      this.bakeChanged(m, [m * 4 + 3, m * 4 + 2, ...(m + 1 < live ? [(m + 1) * 4] : [])], 'edit', true, undefined, rowsPer);
    }
    this.directory();
    this.mergeFrees();
    this.submit();
    this.trace?.(this,`edit ${spec.op}`);
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
    // (round 28: an idle frame runs no camera pass and reads nothing back. The pass is a function of camIn (less the
    // frame's dt, which only scales a move), the live windows and columns (any op submits) and the cruise; with all of
    // them as at the last pass, and that pass's report back, its result would be the same)
    const sig = `${Array.from(this.camIn.subarray(0, 11)).join(',')}|${this.counts.submits}|${this.camCruise}`;
    const still = this.camIn[0] === 0 && this.camIn[1] === 0 && this.camIn[2] === 0 && this.camIn[3] === 0 && !this.camCruise;
    if (still && sig === this.camSig && this.camGot === this.camSeq) {
      this.camSkips++;
      return;
    }
    this.run('camera', this.uni(), 1);
    this.submit(false);
    this.camSig = `${Array.from(this.camIn.subarray(0, 11)).join(',')}|${this.counts.submits}|${this.camCruise}`;
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
  /** cruise for the next camera passes: on, the speed (world units a second); `keep` true takes the eye's height over the
   *  ground now as the height to keep (the camera pass measures it) */
  cruise(on: boolean, speed: number, keep = false): void {
    this.device.queue.writeBuffer(this.cam, 260 * 4, new Float32Array(keep ? [on ? 1 : 0, speed, -1] : [on ? 1 : 0, speed]));
    this.camCruise = on;
  }
  private camCruise = false;
  /** (round 28) the inputs of the last camera pass run (camIn less dt, the submits since, the cruise), and passes skipped */
  private camSig = '';
  camSkips = 0;
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
  /** (diagnostics, round 12) the last submitted op's bakes: per level, the chunks its bake dispatches covered (read back
   *  from the dilated slots' dispatch sizes; a CPU slot's rect too) */
  async readBakes(): Promise<{ L: number; chunks: number }[] & { slots?: number[] }> {
    this.submit();
    const tmp = this.device.createBuffer({ size: this.args.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.args, 0, tmp, 0, this.args.size);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const a = new Uint32Array(tmp.getMappedRange().slice(0));
    tmp.destroy();
    const out: { L: number; chunks: number }[] & { slots?: number[] } = this.lastBakes.map((b) => ({ L: b.L, chunks: a[b.slot * 4] * a[b.slot * 4 + 1] }));
    // (every region slot's chunks: the plan's slot m * 4 + 0 restrict from m, + 1 residual, + 2 derive, + 3 edit)
    out.slots = Array.from({ length: 32 }, (_, s) => a[s * 4] * a[s * 4 + 1]);
    return out;
  }
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
    // (every copy in one submit, then awaited: the store as it stands now, even if an op, grow or shrink runs in a frame
    // while the maps are awaited; round 9: segment sizes read between awaits had changed under the reader)
    const enc = this.device.createCommandEncoder();
    const copy = (b: GPUBuffer, size = b.size) => {
      const tmp = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      enc.copyBufferToBuffer(b, 0, tmp, 0, size);
      return tmp;
    };
    const take = async (tmp: GPUBuffer) => {
      await tmp.mapAsync(GPUMapMode.READ);
      const out = new Uint32Array(tmp.getMappedRange().slice(0));
      tmp.destroy();
      return out;
    };
    // the segments end to end: page p at p * PW (segments fill in order, so the ids are contiguous)
    const segCap = this.segCap.slice();
    const pg = new Uint32Array(Math.max(this.cap, this.physical) * PW);
    const segT = segCap.map((c, j) => (c ? copy(this.segs[j], c * PW * 4) : null));
    const tT = copy(this.tab);
    const cT = copy(this.ctl);
    const rT = copy(this.reg);
    this.device.queue.submit([enc.finish()]);
    for (let j = 0; j < segT.length; j++) if (segT[j]) pg.set(await take(segT[j]!), j * this.segP * PW);
    return new Snapshot(await take(tT), await take(cT), pg, await take(rT));
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
  /** a column's records as stored (column pages: the partition bottom up, air included): top (f32) and material */
  records(lid: number, X: number, Y: number): { top: number[]; mat: number[]; edge: number[] } {
    const c = (Y & 15) * 16 + (X & 15);
    const out = { top: [] as number[], mat: [] as number[], edge: [] as number[] };
    for (let cz = 0; ; cz++) {
      const p = this.page(lid, X >> 4, Y >> 4, cz);
      if (p < 0 || p >= 0xfffffffe) break;
      const r = this.pg[p * PW + c] & 0xffff;
      for (let j = 0; j < r; j++) {
        const b = p * PW + 256 + (c * KR + j) * 2;
        out.top.push(this.f[b]);
        // (round 22: the material word's bits 0-7 the material, 8-29 the edge sample)
        out.mat.push(this.pg[b + 1] & 0xff);
        out.edge.push(this.pg[b + 1] & EDGE_MASK);
      }
      if (r < KR) break;
    }
    return out;
  }
  /** a column's intervals in the solid view (z0, z1 as f32, material): for column pages read from the partition (the
   *  non-air records, each from the top below it), for residual and TMP pages as stored */
  column(lid: number, X: number, Y: number): { mat: number[]; z0: number[]; z1: number[]; edge: number[] } {
    const out = { mat: [] as number[], z0: [] as number[], z1: [] as number[], edge: [] as number[] };
    if (lid < 8 || (lid >= SNAP_ID && lid < SNAP_ID + 8)) {
      const r = this.records(lid, X, Y);
      for (let j = 0; j < r.mat.length; j++) {
        if (r.mat[j] === MAT_AIR) continue;
        out.mat.push(r.mat[j]);
        out.z0.push(j === 0 ? -1e30 : r.top[j - 1]);
        out.z1.push(r.top[j]);
        out.edge.push(r.edge[j]);
      }
      return out;
    }
    const c = (Y & 15) * 16 + (X & 15);
    for (let cz = 0; ; cz++) {
      const p = this.page(lid, X >> 4, Y >> 4, cz);
      if (p < 0 || p >= 0xfffffffe) break;
      const m = this.pg[p * PW + c] & 0xffff;
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
  /** (tests, NS-86) the pool's books: every page id held by a live table entry is under the cap and held once, every
   *  id on the free stack is under the bump end, held by no entry and listed once, and no frees are pending */
  audit(cap: number): { held: number; free: number; overCap: number; shared: number; freeHeld: number; freeTwice: number; pending: number; where: string[] } {
    const owner = new Map<number, string>();
    const where: string[] = [];
    let overCap = 0;
    let shared = 0;
    for (let s = 0; s < TCAP; s++) {
      const k1 = this.tab[s * 4 + 1];
      if (k1 >= 0xfffffffc) continue;
      const p = this.tab[s * 4 + 2];
      if (p >= 0xfffffffe) continue;
      const name = `lid ${k1 & 0xff} cz ${k1 >>> 8} chunk ${this.tab[s * 4] & 0xffff},${this.tab[s * 4] >>> 16}`;
      if (p >= cap) {
        overCap++;
        if (where.length < 8) where.push(`page ${p} >= cap ${cap} (${name})`);
      }
      const o = owner.get(p);
      if (o !== undefined) {
        shared++;
        if (where.length < 8) where.push(`page ${p} held by ${o} and ${name}`);
      } else owner.set(p, name);
    }
    const n = this.ctl[2];
    const end = this.ctl[0];
    const seen = new Set<number>();
    let freeHeld = 0;
    let freeTwice = 0;
    for (let i = 0; i < n; i++) {
      const p = this.ctl[16 + i];
      if (seen.has(p)) freeTwice++;
      seen.add(p);
      if (owner.has(p) || p >= end) {
        freeHeld++;
        if (where.length < 8) where.push(`free page ${p} ${owner.has(p) ? `held by ${owner.get(p)}` : `at or past the bump end ${end}`}`);
      }
    }
    return { held: owner.size, free: n, overCap, shared, freeHeld, freeTwice, pending: this.ctl[3], where };
  }
}
