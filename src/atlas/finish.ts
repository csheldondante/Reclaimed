// ---- atlas/finish.ts --------------------------------------------------------
// (round 102, `gpugen`; the user: "Aren't all of the methods used to generate land very GPU efficient? … I sort of
// expected this was done GPU side") A region's columns (forms.wgsl colFinish's colOut and colRuns, still on the GPU)
// made into the window's form by finish.wgsl and written straight into a region pool slot — the land's merge, the
// geysers' sinter, the ways, what's built (atlas/stamps.ts), the cut at the window's oz, the fit to its K, the pack
// into the slot's pages and every field the region keeps. The streamer's arrival is then a pool → window copy, as for
// a thawed region. What comes back is small (a column's top, ground, relief, flags, what's outside the window: ~100 KB a
// region, against the ~1 MB of columns and 1.7 MB upload the CPU's path moves). `raw`: the ground a settlement is
// planned on (16 bytes a column).
import { makeBindGroup, makeComputeAsync, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import { record, timed } from '../gpu/cpustat';
import type { RegionLayout } from '../world/region-record';
import { CHUNK, type Interval } from '../world/layout';
import { MATERIALS, MatState } from '../world/materials';
import type { RegionWays } from './ways';
import type { StampOps } from './stamps';
import finishW from './finish.wgsl?raw';

const PARAM_BYTES = 176;

/**
 * (round 102) ?gpugen=0: regions made the CPU's way, as before round 102 (the columns read back, landFrom, the ways,
 * the stamps, the cut and the pack on the CPU, uploaded into the pool; settlements planned on the main thread) — to
 * compare. The GPU's way by default.
 */
export const GPUGEN = typeof location === 'undefined' || new URLSearchParams(location.search).get('gpugen') !== '0';
/** what's outside the window that comes back at most a region (entries), and marks */
const OUT_CAP = 2048;
const MARK_CAP = 8192;

/** where a region goes: a slot (`off` bytes into `buf`, the layout's bytes) and the window it's cut for */
export interface FinishTarget {
  buf: GPUBuffer;
  off: number;
  layout: RegionLayout;
  /** the window's floor (world z, whole cells), its height, its chunks' K and what a column may hold */
  oz: number;
  zMax: number;
  K: number;
  colK: number;
  /** loose ground dropped onto its support (streamer.ts settleLoose: ?settle=0, the atlas's default) */
  settle: boolean;
  /** (round 108, TC19) the batch fills the slot's corner, not all of it: a render-only tile made with a border of its
   *  neighbours' cells, into a slot of a layout wider than the batch (the rest of it left empty) */
  corner?: boolean;
}

/** a region's columns on the GPU (Atlas.columnsGpu) */
export interface GpuColumns {
  w: number;
  h: number;
  o: GPUBuffer;
  runs: GPUBuffer;
  instN: GPUBuffer;
  /** runs a column (forms.wgsl MR) */
  mr: number;
}

/** what the CPU keeps of a region made on the GPU (streamer.ts Frozen's CPU parts) */
export interface FinishMeta {
  /** per column: its top (window z), its ground's own top (window z), its top and highest gap's roof (world z) */
  surface: Float32Array;
  ground: Float32Array;
  colTop: Float32Array;
  gapTop: Float32Array;
  /** per column: something the structural system should judge */
  structural: Uint8Array;
  outside: Interval[][];
  fitted: number;
  settled: number;
  /** the tops before the stamps' ADDs that asked (atlas/stamps.ts) */
  marks: Float32Array;
  /** lattice forms placed for the batch */
  forms: number;
}

/** the raw ground over a box (settle/plan.ts's input) */
export interface RawGround {
  ground: Float32Array;
  water: Float32Array;
  top: Uint8Array;
  veg: Float32Array;
}

export class RegionFinish {
  private constructor(
    private dev: GPUDevice,
    private k: ComputeKernel,
    private dummy: GPUBuffer,
    private dummyW: GPUBuffer,
    private mats: Uint32Array,
  ) {}

  /** (the bench) the last run's main-thread ms: encoding and submitting it, parsing what came back; its wait (wall) */
  readonly last = { encodeMs: 0, parseMs: 0, waitMs: 0, backBytes: 0 };

  static async create(dev: GPUDevice): Promise<RegionFinish> {
    const module = dev.createShaderModule({ label: 'atlas finish', code: finishW });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error');
    if (errs.length) throw new Error(`finish.wgsl: ${errs.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('; ')}`);
    const k = await makeComputeAsync(dev, 'atlas finish', module, { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw' }, 'finish');
    const dummy = dev.createBuffer({ label: 'finish dummy', size: 256, usage: GPUBufferUsage.STORAGE });
    const dummyW = dev.createBuffer({ label: 'finish dummy rw', size: 256, usage: GPUBufferUsage.STORAGE });
    // (bit 0 granular — settleLoose, fitColumn's cost; bit 1 weak — what the structural system judges: atlas.ts WEAK)
    const mats = new Uint32Array(256);
    MATERIALS.forEach((m, i) => (mats[i] = (m.state === MatState.Granular ? 1 : 0) | (m.state === MatState.Solid && m.strength < 1 ? 2 : 0)));
    return new RegionFinish(dev, k, dummy, dummyW, mats);
  }

  /**
   * The region's columns into `target` (or, `target` null, its raw ground). The passes are submitted; resolves with what
   * comes back once it has. `geysers`: their vents (region cells), `stencil` their sinter (9 × 9: kind | dz << 2).
   */
  async run(
    cols: GpuColumns,
    x0: number,
    y0: number,
    ways: RegionWays | null,
    geysers: [number, number][],
    stencil: Uint32Array,
    ops: StampOps | null,
    target: FinishTarget | null,
    profiler?: Profiler,
    /** (streaming) each tile's turn: the atlas's tile pacer */
    gate?: () => Promise<void>,
    /** the tile a gate's turn (the atlas's FINISH_TILE) */
    tile = 32,
    /** (round 105, tilelatency) the per-column summary (4 f32 a column: surface, ground, top, the highest gap's roof)
     *  copied here on the GPU, nothing read back (a render-only tile's: Atlas.regionInto with how.summary) */
    gpuMeta?: { buf: GPUBuffer; off: number },
  ): Promise<{ meta?: FinishMeta; raw?: RawGround }> {
    const dev = this.dev;
    let tE = performance.now();
    const { w, h } = cols;
    const N = w * h;
    const raw = !target;
    // the aux words: the materials, the stencil, the geysers, the rows, the ways
    const parts: [string, ArrayLike<number>][] = [['mats', this.mats], ['stencil', stencil], ['geysers', geysers.flat()]];
    if (ways) parts.push(['rows', ways.rows], ['pts', ways.pts], ['binStart', ways.binStart], ['binItems', ways.binItems], ['lifts', ways.lifts]);
    else parts.push(['rows', [0]]);
    const at: Record<string, number> = {};
    let n = 0;
    for (const [k, a] of parts) {
      at[k] = n;
      n += Math.max(a.length, 1);
    }
    const auxA = new Int32Array(n);
    for (const [k, a] of parts) auxA.set(a as ArrayLike<number>, at[k]);
    const mk = (label: string, size: number, usage: number) => dev.createBuffer({ label, size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const aux = mk('finish aux', auxA.byteLength, S);
    dev.queue.writeBuffer(aux, 0, auxA);
    let opsB: GPUBuffer | null = null;
    if (ops && !ops.empty && !raw) {
      const e = ops.encode();
      opsB = mk('finish ops', e.byteLength, S);
      dev.queue.writeBuffer(opsB, 0, e);
    }
    if (ops && ops.marks > MARK_CAP) throw new Error(`finish: ${ops.marks} marks in a region (room for ${MARK_CAP})`);
    // the words that come back: the summary, the flags, the marks, what's outside the window
    const mSum = 0;
    const mFlags = N * 4;
    const mMarks = mFlags + N;
    const mOut = mMarks + MARK_CAP;
    const mdWords = raw ? mFlags + N : mOut + OUT_CAP * 4;
    const md = mk('finish md', mdWords * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const outN = mk('finish outN', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const back = mk('finish read', mdWords * 4 + 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    // the params
    const pb = mk('finish params', PARAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const p = new Uint32Array(PARAM_BYTES / 4);
    const pi = new Int32Array(p.buffer);
    const L = target?.layout;
    const bo = (name: string) => {
      const b = L!.bufs.find((x) => x.name === name);
      if (!b) throw new Error(`finish: the region layout keeps no ${name}`);
      return b.off / 4;
    };
    const to = (name: string) => {
      const t = L!.texs.find((x) => x.name === name);
      if (!t) throw new Error(`finish: the region layout keeps no ${name} texture`);
      if (t.per !== 1 || t.div !== 1) throw new Error(`finish: ${name} isn't a texel a column`);
      return [t.off / 4, t.rowBytes / 4];
    };
    p.set([w, h, raw ? 1 : 0, target?.settle ? 1 : 0]);
    if (target) {
      const fits = target.corner ? w <= L!.R && h <= L!.R : L!.R === w && L!.R === h;
      if (!fits) throw new Error(`finish: a ${w} × ${h} batch into a ${L!.R}² region's slot${target.corner ? ' (its corner)' : ''}`);
      pi.set([Math.round(target.oz * 256), Math.round(target.zMax * 256)], 4);
      p.set([target.K, target.colK, L!.pageBytes / 16 / target.K === CHUNK * CHUNK ? CHUNK * CHUNK * target.K : 0, L!.rc], 6);
      if (!p[8]) throw new Error('finish: the layout\'s pages aren\'t K × CHUNK² slots');
      const [ls, lsRow] = to('lavaSpring');
      const [rf, rfRow] = to('riverFlow');
      p.set([bo('water'), bo('waterSource'), bo('lava'), bo('moisture'), bo('veg'), bo('petals'), ls, rf, lsRow, rfRow], 12);
    }
    p[10] = cols.mr;
    p[11] = opsB ? 1 : 0;
    p[22] = ways ? 1 : 0;
    p[23] = ways ? ways.lifts.length / 4 : 0;
    p.set([at.pts, at.binStart, at.binItems, at.lifts, at.rows, ways?.nb ?? 0, ways?.mb ?? 0, geysers.length, at.geysers, at.stencil, at.mats, OUT_CAP, mSum, mFlags, mMarks, mOut, MARK_CAP], 24);
    // (round 102: a TILE² tile of the region a dispatch, each the pacer's turn when streaming (`gate`) — the whole
    // region in one dispatch was a long GPU frame on a phone)
    const bg = makeBindGroup(dev, 'finish', this.k.layout, {
      0: pb,
      1: cols.o,
      2: cols.runs,
      3: aux,
      4: opsB ?? this.dummy,
      5: target ? { buffer: target.buf, offset: target.off, size: L!.bytes } : this.dummyW,
      6: md,
      7: outN,
    });
    const T = gate ? tile : Math.max(w, h);
    const tiles: [number, number][] = [];
    for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty]);
    let enc = dev.createCommandEncoder({ label: 'atlas finish' });
    if (target) enc.clearBuffer(target.buf, target.off, L!.bytes);
    this.last.encodeMs = 0;
    for (let k = 0; k < tiles.length; k++) {
      if (gate) {
        this.last.encodeMs += performance.now() - tE;
        dev.queue.submit([enc.finish()]);
        await gate();
        tE = performance.now();
        enc = dev.createCommandEncoder({ label: 'atlas finish tile' });
      }
      p.set([tiles[k][0], tiles[k][1], T], 41);
      dev.queue.writeBuffer(pb, 0, p);
      const cp = enc.beginComputePass({ label: 'atlas finish', timestampWrites: profiler?.timestamps(raw ? 'atlas-rawFinish' : 'atlas-regionFinish') });
      cp.setPipeline(this.k.pipeline);
      cp.setBindGroup(0, bg);
      cp.dispatchWorkgroups(Math.ceil(Math.min(T, w - tiles[k][0]) / 8), Math.ceil(Math.min(T, h - tiles[k][1]) / 8));
      cp.end();
    }
    if (gpuMeta) {
      enc.copyBufferToBuffer(md, 0, gpuMeta.buf, gpuMeta.off, N * 16);
      dev.queue.submit([enc.finish()]);
      this.last.encodeMs += performance.now() - tE;
      // (submitted: the buffers go once the GPU's done with what reads them)
      for (const b of [aux, opsB, md, outN, back, pb]) b?.destroy();
      return {};
    }
    enc.copyBufferToBuffer(md, 0, back, 0, mdWords * 4);
    enc.copyBufferToBuffer(outN, 0, back, mdWords * 4, 16);
    enc.copyBufferToBuffer(cols.instN, 0, back, mdWords * 4 + 16, 16);
    dev.queue.submit([enc.finish()]);
    const tW = performance.now();
    this.last.encodeMs += tW - tE;
    record('finish.encode', this.last.encodeMs);
    try {
      await back.mapAsync(GPUMapMode.READ);
      const tP = performance.now();
      this.last.waitMs = tP - tW;
      const u = new Uint32Array(back.getMappedRange().slice(0));
      back.unmap();
      this.last.backBytes = u.byteLength;
      const r = timed('finish.parse', () => this.parse(u, w, h, x0, y0, raw, mdWords, mSum, mFlags, mMarks, mOut, ops));
      this.last.parseMs = performance.now() - tP;
      return r;
    } finally {
      for (const b of [aux, opsB, md, outN, back, pb]) b?.destroy();
    }
  }

  private parse(u: Uint32Array, w: number, h: number, x0: number, y0: number, raw: boolean, mdWords: number, mSum: number, mFlags: number, mMarks: number, mOut: number, ops: StampOps | null): { meta?: FinishMeta; raw?: RawGround } {
    const N = w * h;
    const f = new Float32Array(u.buffer);
    const forms = u[mdWords + 4];
    const where = (i: number) => `${x0 + (i % w)},${y0 + Math.floor(i / w)}`;
    for (let i = 0; i < N; i++) {
      const e = u[mFlags + i] >>> 16;
      if (!e) continue;
      const why = e & 1 ? 'more forms near it than it considers' : e & 2 ? 'more runs than a column holds (forms.wgsl MR)' : e & 4 ? 'is empty' : e & 8 ? 'more intervals than finish.wgsl holds (MAXI)' : e & 16 ? 'more outside the window than finish.wgsl holds' : e & 32 ? 'more marks than room for' : 'an unknown stamp operation';
      throw new Error(`atlas finish: column ${where(i)}: ${why}`);
    }
    if (raw) {
      const ground = new Float32Array(N);
      const water = new Float32Array(N);
      const top = new Uint8Array(N);
      const veg = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        ground[i] = f[mSum + i * 4];
        water[i] = f[mSum + i * 4 + 1];
        top[i] = u[mSum + i * 4 + 2];
        veg[i] = f[mSum + i * 4 + 3];
      }
      return { raw: { ground, water, top, veg } };
    }
    const surface = new Float32Array(N);
    const ground = new Float32Array(N);
    const colTop = new Float32Array(N);
    const gapTop = new Float32Array(N);
    const structural = new Uint8Array(N);
    let fitted = 0;
    let settled = 0;
    for (let i = 0; i < N; i++) {
      surface[i] = f[mSum + i * 4];
      ground[i] = f[mSum + i * 4 + 1];
      colTop[i] = f[mSum + i * 4 + 2];
      gapTop[i] = f[mSum + i * 4 + 3];
      const fl = u[mFlags + i];
      structural[i] = fl & 1;
      if (fl & 2) fitted++;
      if (fl & 4) settled++;
    }
    const outside: Interval[][] = Array.from({ length: N }, () => []);
    const nOut = u[mdWords];
    if (nOut > OUT_CAP) throw new Error(`atlas finish: ${nOut} intervals outside the window in a region (room for ${OUT_CAP})`);
    const es: [number, number][] = [];
    for (let k = 0; k < nOut; k++) es.push([u[mOut + k * 4], mOut + k * 4]);
    es.sort((a, b) => a[0] - b[0]);
    for (const [key, o] of es) outside[key >>> 5].push({ z0: (u[o + 1] | 0) / 256, z1: (u[o + 2] | 0) / 256, mat: u[o + 3] });
    const marks = new Float32Array(ops?.marks ?? 0);
    for (let k = 0; k < marks.length; k++) marks[k] = f[mMarks + k];
    return { meta: { surface, ground, colTop, gapTop, structural, outside, fitted, settled, marks, forms } };
  }
}
