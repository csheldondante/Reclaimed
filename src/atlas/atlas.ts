// The atlas (round 67, branch `atlas`): a finite world's coarse map, made on
// the GPU when the world is created, that the streamer's columns are drawn
// from. The world is a torus of `cols` × `rows` cells (it wraps); the macro
// grid is n × n texels over it.
//
// Passes (build.wgsl): continents (warped fbm above a threshold) → their
// connected components (GPU flood fill) → islands and lakes too small to
// keep flipped → the partition (Voronoi cells, split along the faults: the
// band between two thresholds of one noise is its own strip) → regions, the
// components of equal keys → (CPU) dense ids, tiny regions merged into a
// neighbour, each region's kind and parameters (regions.ts) → jump flooding
// from the regions' borders and the coast → the ground of every texel.
// The ground itself (compose.wgsl) is a function of world position over these
// maps: the viewer draws it per pixel and `columns` per cell, the same code.

import { makeBindGroup, makeCompute, makeComputeAsync, makeModule, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import { ColumnGrid, type Interval, type WorldDims } from '../world/layout';
import { MATERIALS, MatState } from '../world/materials';
import { ROW_H } from '../world/lattice';
import type { MapData } from '../world/mapgen';
import { rng } from '../world/noise';
import type { RegionLand } from '../world/streamgen';
import buildW from './build.wgsl?raw';
import columnsW from './columns.wgsl?raw';
import commonW from './common.wgsl?raw';
import composeW from './compose.wgsl?raw';
import formsW from './forms.wgsl?raw';
import noiseW from './noise.wgsl?raw';
import patsimW from './patsim.wgsl?raw';
import patternsW from './patterns.wgsl?raw';
import { defineRegions, KIND_IDS, KINDS, REGION_WORDS, warmth, type RegionDef, type RegionStat } from './regions';

export interface AtlasParams {
  /** macro texels a side */
  n: number;
  seed: number;
  /** 0 earth, 1 strange (more patterned regions), 2 flesh */
  style: number;
  /** the world in cells (it wraps): cols a multiple of 64, rows of 64 */
  cols: number;
  rows: number;
  sea: number;
  zTop: number;
  /** continents: noise cells a turn; land above this */
  landPer: number;
  landThresh: number;
  warp: number;
  /** the partition: Voronoi cells a turn, and their jitter */
  cellsPer: number;
  jitter: number;
  /** faults: noise cells a turn; the strip between lo and hi */
  faultPer: number;
  faultLo: number;
  faultHi: number;
  lift: number;
  /** texels: islands and lakes smaller go; regions smaller merge into a neighbour */
  minIsland: number;
  minLake: number;
  minRegion: number;
  warpCell: number;
  /** caves: rock kept over them, and their scale */
  caveDepth: number;
  caveScale: number;
}

export const DEFAULT_ATLAS: AtlasParams = {
  n: 2048,
  seed: 1,
  style: 0,
  cols: 16384,
  rows: 18944,
  sea: 28,
  zTop: 146,
  landPer: 3,
  landThresh: 0.06,
  warp: 0.05,
  cellsPer: 80,
  jitter: 0.85,
  faultPer: 5,
  faultLo: -0.035,
  faultHi: 0.035,
  lift: 14,
  minIsland: 30,
  minLake: 30,
  minRegion: 60,
  warpCell: 9,
  caveDepth: 7,
  caveScale: 40,
};

/** what `?a.<key>=` may set (the viewer's sliders write the same) */
export const ATLAS_KEYS = Object.keys(DEFAULT_ATLAS) as (keyof AtlasParams)[];

export function atlasParamsFrom(q: URLSearchParams, base: Partial<AtlasParams> = {}): AtlasParams {
  const p: AtlasParams = { ...DEFAULT_ATLAS, ...base };
  for (const k of ATLAS_KEYS) {
    const v = q.get(`a.${k}`);
    if (v !== null) {
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`a.${k}=${v} is not a number`);
      p[k] = x;
    }
  }
  if (p.cols % 64 || p.rows % 64) throw new Error('the atlas world must be whole regions of 64');
  if (p.n & (p.n - 1)) throw new Error('the atlas grid must be a power of two');
  return p;
}

/** what the viewer and the caller set on top of the parameters */
interface Extra {
  step?: number;
  x0?: number;
  y0?: number;
  w?: number;
  h?: number;
  vc?: [number, number];
  vscale?: number;
  mode?: number;
  vsize?: [number, number];
}

const PARAM_BYTES = 128;
/** forms.wgsl ColOut, and the runs a column holds (MR) */
const COL_WORDS = 12;
const COLG_BYTES = 32;
const MR = 24;
const INST_BYTES = 64;
const MAX_INST = 8192;
/** forms.wgsl MARGIN and its lattices' finest spacing */
const FORM_MARGIN = 48;
const FINEST = 4;

export interface AtlasStats {
  continents: number;
  islands: number;
  waters: number;
  regions: number;
  merged: number;
  ccIters: number[];
  kinds: Record<string, number>;
}

/** a batch of columns as `columns` returns it: forms.wgsl ColOut a column, and its runs (`run`) */
export interface AtlasColumns {
  w: number;
  h: number;
  f: Float32Array;
  u: Uint32Array;
  /** MR a column, two words each (forms.wgsl colRuns) */
  runsU: Uint32Array;
  /** column i's run k (form: a form's, not the ground's) */
  run(i: number, k: number): Interval & { form: boolean };
  /** lattice forms placed for the batch */
  forms: number;
}

export class Atlas {
  readonly worldW: number;
  readonly worldH: number;
  readonly timings: Record<string, number> = {};
  readonly stats: AtlasStats = { continents: 0, islands: 0, waters: 0, regions: 0, merged: 0, ccIters: [], kinds: {} };
  /** per texel: its region (dense id) */
  regionOf!: Uint32Array;
  /** per texel: the ground (compose.wgsl ground) */
  hmac!: Float32Array;
  defs!: RegionDef[];
  /** "a,b" (a < b) → texel edges shared */
  adjacency = new Map<number, number>();
  readonly paramBuf: GPUBuffer;
  readonly region: GPUBuffer;
  readonly dist: GPUBuffer;
  regs!: GPUBuffer;
  readonly pat: GPUBuffer;
  readonly kcol: GPUBuffer;
  private colH!: ComputeKernel;
  private colF!: ComputeKernel;
  private formSeed!: ComputeKernel;

  private constructor(
    readonly device: GPUDevice,
    readonly p: AtlasParams,
  ) {
    this.worldW = p.cols;
    this.worldH = p.rows * ROW_H;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const N = p.n * p.n;
    this.paramBuf = device.createBuffer({ label: 'atlas params', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.region = device.createBuffer({ label: 'atlas region', size: N * 4, usage: S });
    this.dist = device.createBuffer({ label: 'atlas dist', size: N * 16, usage: S });
    this.pat = device.createBuffer({ label: 'atlas patterns', size: 3 * 256 * 256 * 4, usage: S });
    this.kcol = device.createBuffer({ label: 'atlas kind colours', size: KIND_IDS.length * 16, usage: S });
    device.queue.writeBuffer(this.kcol, 0, new Float32Array(KIND_IDS.flatMap((k) => [...KINDS[k].colour, 1])));
  }

  /** the WGSL every atlas kernel is built from, and its own */
  parts(...own: string[]): string[] {
    return [noiseW, commonW, patternsW, composeW, ...own];
  }

  writeParams(e: Extra = {}, into = this.paramBuf): void {
    const p = this.p;
    const ab = new ArrayBuffer(PARAM_BYTES);
    const u = new Uint32Array(ab);
    const f = new Float32Array(ab);
    const i = new Int32Array(ab);
    u[0] = p.n;
    u[1] = p.seed;
    u[2] = e.step ?? 0;
    u[3] = p.style;
    f[4] = this.worldW;
    f[5] = this.worldH;
    f[6] = p.sea;
    f[7] = p.zTop;
    f[8] = p.landPer;
    f[9] = p.landThresh;
    f[10] = p.warp;
    f[11] = p.cellsPer;
    f[12] = p.faultPer;
    f[13] = p.faultLo;
    f[14] = p.faultHi;
    f[15] = p.jitter;
    f[16] = p.lift;
    u[17] = p.minIsland;
    i[18] = e.x0 ?? 0;
    i[19] = e.y0 ?? 0;
    u[20] = e.w ?? 0;
    u[21] = e.h ?? 0;
    f[22] = p.warpCell;
    u[23] = p.minLake;
    f[24] = e.vc?.[0] ?? 0;
    f[25] = e.vc?.[1] ?? 0;
    f[26] = e.vscale ?? 1;
    u[27] = e.mode ?? 0;
    f[28] = e.vsize?.[0] ?? 1;
    f[29] = e.vsize?.[1] ?? 1;
    f[30] = p.caveDepth;
    f[31] = p.caveScale;
    this.device.queue.writeBuffer(into, 0, ab);
  }

  static async build(device: GPUDevice, p: AtlasParams): Promise<Atlas> {
    const a = new Atlas(device, p);
    await a.run();
    return a;
  }

  private async time<T>(name: string, f: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    const r = await f();
    await this.device.queue.onSubmittedWorkDone();
    this.timings[name] = +(performance.now() - t0).toFixed(1);
    return r;
  }

  private async read(buf: GPUBuffer, bytes = buf.size): Promise<ArrayBuffer> {
    const dev = this.device;
    const st = dev.createBuffer({ label: 'atlas readback', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, st, 0, bytes);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = st.getMappedRange().slice(0);
    st.unmap();
    st.destroy();
    return out;
  }

  private async run(): Promise<void> {
    const dev = this.device;
    const p = this.p;
    const n = p.n;
    const N = n * n;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const mk = (label: string, size: number) => dev.createBuffer({ label: `atlas ${label}`, size, usage: S });
    const fieldA = mk('fieldA', N * 16);
    const key = mk('key', N * 4);
    const label = mk('label', N * 4);
    const size = mk('size', N * 4);
    const flag = mk('flag', 4);
    const flagRead = dev.createBuffer({ label: 'atlas flag read', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const info = mk('info', N * 4);
    const cont = mk('cont', N * 4);
    const jfaA = mk('jfaA', N * 8);
    const jfaB = mk('jfaB', N * 8);
    const hmacB = mk('hmac', N * 4);
    // every pipeline at once, off the main thread (D3D compiles are the slow part of making the atlas)
    const bm = makeModule(dev, 'atlas build', this.parts(buildW));
    const cm = makeModule(dev, 'atlas columns', this.parts(columnsW, formsW));
    const K = (entry: string, spec: BindSpec, m = bm) => makeComputeAsync(dev, `atlas ${entry}`, m, { 0: 'uniform', ...spec }, entry);
    const [kBase, kInit, kHook, kJump, kCount, kClean, kKey, kSeedR, kSeedC, kStep, kOutR, kOutC, kMacro, colH, colF, fSeed] = await this.time('compile', () =>
      Promise.all([
        K('base', { 1: 'rw', 2: 'rw' }),
        K('ccInit', { 3: 'rw' }),
        K('ccHook', { 2: 'rw', 3: 'rw', 5: 'rw' }),
        K('ccJump', { 3: 'rw', 5: 'rw' }),
        K('ccCount', { 3: 'rw', 4: 'rw' }),
        K('clean', { 1: 'rw', 2: 'rw', 3: 'rw', 4: 'rw' }),
        K('regionKey', { 1: 'rw', 2: 'rw', 10: 'rw' }),
        K('jfaSeedR', { 6: 'rw', 7: 'rw' }),
        K('jfaSeedC', { 6: 'rw', 7: 'rw', 22: 'read' }),
        K('jfaStep', { 7: 'rw', 8: 'rw' }),
        K('jfaOutR', { 6: 'rw', 7: 'rw', 9: 'rw' }),
        K('jfaOutC', { 6: 'rw', 7: 'rw', 9: 'rw', 22: 'read' }),
        K('macroHeight', { 11: 'rw', 20: 'read', 21: 'read', 22: 'read', 23: 'read' }),
        K('colHeight', { 20: 'read', 21: 'read', 22: 'read', 23: 'read', 30: 'rw' }, cm),
        K('colFinish', { 22: 'read', 23: 'read', 30: 'rw', 31: 'rw', 32: 'rw', 33: 'rw', 34: 'rw' }, cm),
        K('formSeed', { 20: 'read', 21: 'read', 22: 'read', 23: 'read', 32: 'rw', 33: 'rw' }, cm),
      ]),
    );
    this.colH = colH;
    this.colF = colF;
    this.formSeed = fSeed;
    const bg = (k: ComputeKernel, res: Record<number, GPUBuffer>) => makeBindGroup(dev, 'atlas', k.layout, { 0: this.paramBuf, ...res });
    const groups = Math.ceil(n / 8);
    const pass = (enc: GPUCommandEncoder, k: ComputeKernel, g: GPUBindGroup) => {
      const cp = enc.beginComputePass();
      cp.setPipeline(k.pipeline);
      cp.setBindGroup(0, g);
      cp.dispatchWorkgroups(groups, groups);
      cp.end();
    };
    const one = async (k: ComputeKernel, g: GPUBindGroup) => {
      const enc = dev.createCommandEncoder();
      pass(enc, k, g);
      dev.queue.submit([enc.finish()]);
    };
    const gInit = bg(kInit, { 3: label });
    const gHook = bg(kHook, { 2: key, 3: label, 5: flag });
    const gJump = bg(kJump, { 3: label, 5: flag });
    // connected components of equal keys, to a fixed point
    const cc = async (): Promise<number> => {
      await one(kInit, gInit);
      const BATCH = 4;
      for (let it = 0; it < 4000; it += BATCH) {
        const enc = dev.createCommandEncoder();
        enc.clearBuffer(flag);
        for (let b = 0; b < BATCH; b++) {
          pass(enc, kHook, gHook);
          pass(enc, kJump, gJump);
          pass(enc, kJump, gJump);
        }
        enc.copyBufferToBuffer(flag, 0, flagRead, 0, 4);
        dev.queue.submit([enc.finish()]);
        await flagRead.mapAsync(GPUMapMode.READ);
        const changed = new Uint32Array(flagRead.getMappedRange())[0];
        flagRead.unmap();
        if (!changed) return it + BATCH;
      }
      throw new Error('atlas: connected components did not settle in 4000 iterations');
    };

    this.writeParams();
    await this.time('base', () => one(kBase, bg(kBase, { 1: fieldA, 2: key })));
    this.stats.ccIters.push(await this.time('cc land', cc));
    await this.time('clean', async () => {
      const enc = dev.createCommandEncoder();
      enc.clearBuffer(size);
      pass(enc, kCount, bg(kCount, { 3: label, 4: size }));
      pass(enc, kClean, bg(kClean, { 1: fieldA, 2: key, 3: label, 4: size }));
      dev.queue.submit([enc.finish()]);
    });
    this.stats.ccIters.push(await this.time('cc continents', cc));
    await this.time('keys', () => {
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(label, 0, cont, 0, N * 4);
      pass(enc, kKey, bg(kKey, { 1: fieldA, 2: key, 10: info }));
      dev.queue.submit([enc.finish()]);
    });
    this.stats.ccIters.push(await this.time('cc regions', cc));

    // ---- the CPU: dense ids, stats, tiny regions merged, the table -------------
    const [L, I, C] = await this.time('readback', async () => [new Uint32Array(await this.read(label)), new Uint32Array(await this.read(info)), new Uint32Array(await this.read(cont))]);
    await this.time('regions (cpu)', () => this.regionsCpu(L, I, C));
    dev.queue.writeBuffer(this.region, 0, this.regionOf);
    await this.time('patterns', () => this.patterns());

    // ---- jump flooding: the regions' borders, then the coast ---------------------
    const jfa = async (seed: ComputeKernel, seedRes: Record<number, GPUBuffer>, out: ComputeKernel, outRes: Record<number, GPUBuffer>) => {
      this.writeParams();
      await one(seed, bg(seed, { ...seedRes, 7: jfaA }));
      let src = jfaA;
      let dst = jfaB;
      const steps: number[] = [];
      for (let k = n / 2; k >= 1; k /= 2) steps.push(k);
      steps.push(1);
      for (const k of steps) {
        this.writeParams({ step: k });
        await one(kStep, bg(kStep, { 7: src, 8: dst }));
        [src, dst] = [dst, src];
      }
      this.writeParams();
      await one(out, bg(out, { ...outRes, 7: src }));
    };
    await this.time('jfa borders', () => jfa(kSeedR, { 6: this.region }, kOutR, { 6: this.region, 9: this.dist }));
    await this.time('jfa coast', () => jfa(kSeedC, { 6: this.region, 22: this.regs }, kOutC, { 6: this.region, 9: this.dist, 22: this.regs }));
    await this.time('ground', () => one(kMacro, bg(kMacro, { 11: hmacB, 20: this.region, 21: this.dist, 22: this.regs, 23: this.pat })));
    this.hmac = new Float32Array(await this.time('readback ground', () => this.read(hmacB)));
    for (const b of [fieldA, key, label, size, flag, flagRead, info, cont, jfaA, jfaB, hmacB]) b.destroy();
  }

  /** the simulated tiles: two reaction–diffusion patterns and a cellular-automaton cave map */
  private async patterns(): Promise<void> {
    const dev = this.device;
    const T = 256;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const a = dev.createBuffer({ label: 'rd a', size: T * T * 8, usage: S });
    const b = dev.createBuffer({ label: 'rd b', size: T * T * 8, usage: S });
    const u = dev.createBuffer({ label: 'rd params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const spec = { 0: 'uniform', 1: 'read', 2: 'rw', 3: 'rw' } as const;
    const step = makeCompute(dev, 'rd step', [patsimW], spec, 'rdMulti');
    const out = makeCompute(dev, 'rd out', [patsimW], spec, 'rdOut');
    const gAB = makeBindGroup(dev, 'rd ab', step.layout, { 0: u, 1: a, 2: b, 3: this.pat });
    const gBA = makeBindGroup(dev, 'rd ba', step.layout, { 0: u, 1: b, 2: a, 3: this.pat });
    const gOut = makeBindGroup(dev, 'rd out', out.layout, { 0: u, 1: a, 2: b, 3: this.pat });
    const variants = [
      { feed: 0.0545, kill: 0.062 },
      { feed: 0.029, kill: 0.057 },
    ];
    for (let vi = 0; vi < variants.length; vi++) {
      // (simulated only when some region's pattern samples it: PAT coral 10, maze 11)
      if (!this.defs.some((d) => d.words[1] === 10 + vi)) continue;
      const r = rng(this.p.seed * 97 + vi);
      const init = new Float32Array(T * T * 2);
      for (let i = 0; i < T * T; i++) init[i * 2] = 1;
      for (let s = 0; s < 60; s++) {
        const cx = Math.floor(r() * T);
        const cy = Math.floor(r() * T);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) init[(((cy + dy + T) % T) * T + ((cx + dx + T) % T)) * 2 + 1] = 1;
      }
      dev.queue.writeBuffer(a, 0, init);
      const pu = new ArrayBuffer(32);
      new Float32Array(pu).set([variants[vi].feed, variants[vi].kill, 1.0, 0.5]);
      new Uint32Array(pu).set([T, vi], 4);
      dev.queue.writeBuffer(u, 0, pu);
      // (6 steps a dispatch: rdMulti)
      const STEPS = 4800;
      for (let s = 0; s < STEPS; s += 1200) {
        const enc = dev.createCommandEncoder();
        const cp = enc.beginComputePass();
        cp.setPipeline(step.pipeline);
        for (let k = 0; k < 1200; k += 12) {
          for (const g of [gAB, gBA]) {
            cp.setBindGroup(0, g);
            cp.dispatchWorkgroups(T / 16, T / 16);
          }
        }
        cp.end();
        dev.queue.submit([enc.finish()]);
      }
      const enc = dev.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(out.pipeline);
      cp.setBindGroup(0, gOut);
      cp.dispatchWorkgroups(T / 8, T / 8);
      cp.end();
      dev.queue.submit([enc.finish()]);
      await dev.queue.onSubmittedWorkDone();
    }
    // the cave automaton (B5678/S45678 on a wrapping grid), smoothed: small, the CPU's
    const r = rng(this.p.seed * 101 + 9);
    let g = new Uint8Array(T * T).map(() => (r() < 0.47 ? 1 : 0));
    for (let it = 0; it < 6; it++) {
      const nx = new Uint8Array(T * T);
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[((y + dy + T) % T) * T + ((x + dx + T) % T)];
          nx[y * T + x] = s >= 5 ? 1 : 0;
        }
      g = nx;
    }
    let f = Float32Array.from(g);
    for (let pass = 0; pass < 2; pass++) {
      const o = new Float32Array(T * T);
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          let s = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += f[((y + dy + T) % T) * T + ((x + dx + T) % T)];
          o[y * T + x] = s / 25;
        }
      f = o;
    }
    dev.queue.writeBuffer(this.pat, 2 * T * T * 4, f);
    for (const x of [a, b, u]) x.destroy();
  }

  private regionsCpu(L: Uint32Array, I: Uint32Array, C: Uint32Array): void {
    const n = this.p.n;
    const N = n * n;
    // continents and waters: dense, with their areas
    const contArea = new Uint32Array(N);
    for (let i = 0; i < N; i++) contArea[C[i]]++;
    // regions: dense ids by root
    const id = new Int32Array(N).fill(-1);
    const stats: (RegionStat & { sx: number; sy: number; cx2: number; cy2: number; faults: number })[] = [];
    const reg = new Uint32Array(N);
    const TAU = 2 * Math.PI;
    const cs = Float64Array.from({ length: n }, (_, k) => Math.cos((TAU * (k + 0.5)) / n));
    const sn = Float64Array.from({ length: n }, (_, k) => Math.sin((TAU * (k + 0.5)) / n));
    for (let i = 0; i < N; i++) {
      const root = L[i];
      let r = id[root];
      if (r < 0) {
        r = id[root] = stats.length;
        stats.push({ area: 0, land: (I[i] & 1) === 1, fault: false, prov: I[i] >>> 3, cont: C[i], contArea: contArea[C[i]], cx: 0, cy: 0, sx: 0, sy: 0, cx2: 0, cy2: 0, faults: 0 });
      }
      reg[i] = r;
      const s = stats[r];
      s.area++;
      const x = i % n;
      const y = (i - x) / n;
      s.sx += cs[x];
      s.sy += sn[x];
      s.cx2 += cs[y];
      s.cy2 += sn[y];
      if (((I[i] >>> 1) & 3) === 1) s.faults++;
    }
    // shared edges between regions (right and down neighbours, wrapped)
    const adj = (rs: Uint32Array) => {
      const m = new Map<number, number>();
      const R = stats.length;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const a = rs[y * n + x];
          for (const j of [y * n + ((x + 1) % n), ((y + 1) % n) * n + x]) {
            const b = rs[j];
            if (a === b) continue;
            const k = Math.min(a, b) * R + Math.max(a, b);
            m.set(k, (m.get(k) ?? 0) + 1);
          }
        }
      return m;
    };
    // tiny regions join the neighbour they share most border with (the same land or water, when there is one)
    const parent = stats.map((_, i) => i);
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    const pairs = adj(reg);
    const nbrs = new Map<number, [number, number][]>();
    const R0 = stats.length;
    for (const [k, c] of pairs) {
      const a = Math.floor(k / R0);
      const b = k % R0;
      (nbrs.get(a) ?? nbrs.set(a, []).get(a)!).push([b, c]);
      (nbrs.get(b) ?? nbrs.set(b, []).get(b)!).push([a, c]);
    }
    const order = stats.map((_, i) => i).sort((a, b) => stats[a].area - stats[b].area);
    const area = stats.map((s) => s.area);
    let merged = 0;
    for (const r of order) {
      if (find(r) !== r || area[r] >= this.p.minRegion) continue;
      let best = -1;
      let bestScore = -1;
      for (const [b, c] of nbrs.get(r) ?? []) {
        const fb = find(b);
        if (fb === r) continue;
        const score = c + (stats[fb].land === stats[r].land ? 1e6 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = fb;
        }
      }
      if (best < 0) continue;
      parent[r] = best;
      area[best] += area[r];
      const s = stats[best];
      const t = stats[r];
      s.area += t.area;
      s.sx += t.sx;
      s.sy += t.sy;
      s.cx2 += t.cx2;
      s.cy2 += t.cy2;
      s.faults += t.faults;
      merged++;
    }
    const dense = new Int32Array(stats.length).fill(-1);
    const out: RegionStat[] = [];
    for (let r = 0; r < stats.length; r++) {
      if (find(r) !== r) continue;
      const s = stats[r];
      dense[r] = out.length;
      const ang = (a: number, b: number) => (((Math.atan2(b, a) / TAU) % 1) + 1) % 1;
      out.push({ area: s.area, land: s.land, fault: s.faults > s.area * 0.5, prov: s.prov, cont: s.cont, contArea: s.contArea, cx: ang(s.sx, s.sy), cy: ang(s.cx2, s.cy2) });
    }
    for (let i = 0; i < N; i++) reg[i] = dense[find(reg[i])];
    this.regionOf = reg;
    this.adjacency = adj(reg);
    let ocean = 0;
    for (const s of out) if (!s.land) ocean = Math.max(ocean, s.contArea);
    this.defs = defineRegions(out, this.p.seed, this.p.style, Math.min(ocean, N * 0.02));
    const words = new Uint32Array(this.defs.length * REGION_WORDS);
    this.defs.forEach((d, i) => words.set(d.words, i * REGION_WORDS));
    this.regs?.destroy();
    this.regs = this.device.createBuffer({ label: 'atlas regions', size: Math.max(words.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.regs, 0, words);
    // the stats
    const conts = new Set<number>();
    let islands = 0;
    const waters = new Set<number>();
    for (let root = 0; root < N; root++) {
      const a = contArea[root];
      if (!a) continue;
      const land = (I[root] & 1) === 1;
      if (land) {
        conts.add(root);
        if (a < N * 0.01) islands++;
      } else waters.add(root);
    }
    this.stats.continents = conts.size - islands;
    this.stats.islands = islands;
    this.stats.waters = waters.size;
    this.stats.regions = out.length;
    this.stats.merged = merged;
    this.stats.kinds = {};
    for (const d of this.defs) this.stats.kinds[d.kind] = (this.stats.kinds[d.kind] ?? 0) + 1;
  }

  /** The sim's climate for a window centred on world cell (cx, cy): the atlas's temperature
   *  (compose.wgsl temperature) as Globals.climate's (°C at height 0, °C less a cell up). */
  climateAt(cx: number, cy: number): { temp: number; lapse: number } {
    // (compose.wgsl temperature and LAPSE: keep the two the same)
    const lapse = 0.12;
    const warm = warmth(((cy + 0.5) / this.p.rows) % 1);
    return { temp: warm * 34 - 8 + this.p.sea * lapse, lapse };
  }

  /** the region (dense id) at world point (px, py) by its macro texel */
  regionAt(px: number, py: number): RegionDef {
    const n = this.p.n;
    const tx = ((Math.floor((px / this.worldW) * n) % n) + n) % n;
    const ty = ((Math.floor((py / this.worldH) * n) % n) + n) % n;
    return this.defs[this.regionOf[ty * n + tx]];
  }

  /** A batch of columns (w × h world cells from (x0, y0), wrapped): the ground and what lies on it.
   *  (Each batch has its own parameters: batches asked for together run together.) */
  async columns(x0: number, y0: number, w: number, h: number): Promise<AtlasColumns> {
    const dev = this.device;
    const pb = dev.createBuffer({ label: 'atlas col params', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const g = dev.createBuffer({ label: 'atlas colG', size: (w + 2) * (h + 2) * COLG_BYTES, usage: GPUBufferUsage.STORAGE });
    const o = dev.createBuffer({ label: 'atlas colOut', size: w * h * COL_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const runs = dev.createBuffer({ label: 'atlas colRuns', size: w * h * MR * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const inst = dev.createBuffer({ label: 'atlas forms', size: MAX_INST * INST_BYTES, usage: GPUBufferUsage.STORAGE });
    const instN = dev.createBuffer({ label: 'atlas forms n', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const st = dev.createBuffer({ label: 'atlas col read', size: o.size + runs.size + 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.writeParams({ x0, y0, w, h }, pb);
    const enc = dev.createCommandEncoder({ label: 'atlas columns' });
    let cp = enc.beginComputePass();
    cp.setPipeline(this.colH.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'colH', this.colH.layout, { 0: pb, 20: this.region, 21: this.dist, 22: this.regs, 23: this.pat, 30: g }));
    cp.dispatchWorkgroups(Math.ceil((w + 2) / 8), Math.ceil((h + 2) / 8));
    cp.end();
    // the lattice forms around the batch (every lattice: the finest's cells cover the most)
    cp = enc.beginComputePass();
    cp.setPipeline(this.formSeed.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'formSeed', this.formSeed.layout, { 0: pb, 20: this.region, 21: this.dist, 22: this.regs, 23: this.pat, 32: inst, 33: instN }));
    const cells = (n: number) => Math.ceil((n + 2 * FORM_MARGIN) / FINEST) + 3;
    cp.dispatchWorkgroups(Math.ceil(cells(w + 1) / 8), Math.ceil(cells(h * ROW_H) / 8), 7);
    cp.end();
    cp = enc.beginComputePass();
    cp.setPipeline(this.colF.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'colF', this.colF.layout, { 0: pb, 22: this.regs, 23: this.pat, 30: g, 31: o, 32: inst, 33: instN, 34: runs }));
    cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    cp.end();
    enc.copyBufferToBuffer(o, 0, st, 0, o.size);
    enc.copyBufferToBuffer(runs, 0, st, o.size, runs.size);
    enc.copyBufferToBuffer(instN, 0, st, o.size + runs.size, 16);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const buf = st.getMappedRange().slice(0);
    st.unmap();
    for (const b of [g, o, runs, inst, instN, st, pb]) b.destroy();
    const forms = new Uint32Array(buf, o.size + runs.size, 1)[0];
    if (forms > MAX_INST) throw new Error(`atlas: ${forms} forms around the batch at ${x0},${y0} (room for ${MAX_INST})`);
    const f = new Float32Array(buf, 0, o.size / 4);
    const u = new Uint32Array(buf, 0, o.size / 4);
    for (let i = 0; i < w * h; i++) {
      const fl = u[i * COL_WORDS + 10];
      if (fl) throw new Error(`atlas: column ${x0 + (i % w)},${y0 + Math.floor(i / w)} has ${fl & 1 ? 'more forms near it than it considers' : `more than ${MR} runs`}`);
    }
    const runsU = new Uint32Array(buf, o.size, runs.size / 4);
    const run = (i: number, k: number) => {
      const r = (i * MR + k) * 2;
      return { z0: (runsU[r] & 0x7fffffff) / 256, z1: (runsU[r + 1] & 0xffffff) / 256, mat: runsU[r + 1] >>> 24, form: runsU[r] >>> 31 === 1 };
    };
    return { w, h, f, u, runsU, run, forms };
  }

  /** columns that had more intervals than the window holds (their smallest gaps filled: landFrom) */
  gapsFilled = 0;

  /** A region's land for the streamer (world/streamgen.ts RegionLand), K intervals a column at most. */
  async regionLand(x0: number, y0: number, w: number, h: number, K = 14): Promise<RegionLand> {
    if (y0 & 1) throw new Error('a region starts on an even row');
    const c = await this.columns(x0, y0, w, h);
    const land = landFrom(c, x0, y0, K);
    this.gapsFilled += land.gapsFilled;
    return land;
  }

  /** The window from world cell (ox, oy) as a map (the level's first world). */
  async window(dims: WorldDims, ox: number, oy: number, K: number): Promise<MapData> {
    const { w, h } = dims;
    const N = w * h;
    // (in tiles of a region, as the streamer asks: one batch of the whole window is too much
    // work for one dispatch where forms stand thick — the GPU's watchdog resets the device)
    const T = 64;
    if (w % T || h % T) throw new Error(`the window (${w} × ${h}) must be whole tiles of ${T}`);
    const tiles: [number, number][] = [];
    for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty]);
    const lands = await Promise.all(tiles.map(([tx, ty]) => this.regionLand(ox + tx, oy + ty, T, T, K)));
    const grid = new ColumnGrid(dims);
    const land = { water: new Float32Array(N), moisture: new Float32Array(N), vegetation: new Float32Array(N), contam: new Float32Array(N * 2), lava: new Float32Array(N * 4), lavaSpring: new Float32Array(N), surface: new Float32Array(N), structural: new Uint8Array(N) };
    tiles.forEach(([tx, ty], k) => {
      const t = lands[k];
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const i = y * T + x;
          const j = (ty + y) * w + tx + x;
          grid.cols[j] = t.cols[i];
          land.water[j] = t.water[i];
          land.moisture[j] = t.moisture[i];
          land.vegetation[j] = t.vegetation[i];
          land.surface[j] = t.surface[i];
          land.contam[j * 2] = t.contam[i * 2];
          land.contam[j * 2 + 1] = t.contam[i * 2 + 1];
          if (t.lava) land.lava.set(t.lava.subarray(i * 4, i * 4 + 4), j * 4);
          if (t.lavaSpring) land.lavaSpring[j] = t.lavaSpring[i];
          if (t.structural) land.structural[j] = t.structural[i];
        }
    });
    return {
      grid,
      water: land.water,
      contam: land.contam,
      moisture: land.moisture,
      vegetation: land.vegetation,
      oil: new Float32Array(N),
      drift: new Float32Array(N),
      oilStored: new Float32Array(N * 2),
      waterSource: new Float32Array(N),
      lava: land.lava,
      lavaSpring: land.lavaSpring,
      structural: land.structural,
      surface: land.surface,
      poi: Object.fromEntries(['healthy', 'tutorial', 'dam', 'reservoir', 'site', 'landfill', 'heap'].map((k) => [k, [w / 2, h / 2]])) as Record<string, [number, number]>,
    };
  }

  /** A world cell to start at: on land, temperate, in a kind that's good to stand on. */
  spawn(): [number, number] {
    const n = this.p.n;
    const r = rng(this.p.seed * 613 + 1);
    // (temperate: the sim's climate is the level's, not the atlas's latitude — BACKLOG Q40)
    const good = new Set(['plains', 'hills', 'karst', 'craters', 'basalt', 'mesa', 'badlands', 'coral', 'kaleido', 'flesh', 'veins']);
    for (let t = 0; t < 20000; t++) {
      const tx = Math.floor(r() * n);
      const ty = Math.floor(r() * n);
      const d = this.defs[this.regionOf[ty * n + tx]];
      const h = this.hmac[ty * n + tx];
      const warm = warmth(d.stat.cy);
      if (!d.stat.land || !good.has(d.kind) || h < this.p.sea + 3 || h > this.p.sea + 40 || warm < 0.45 || warm > 0.85) continue;
      if (t < 15000 && d.stat.contArea < n * n * 0.01) continue;
      return [Math.floor(((tx + 0.5) / n) * this.p.cols), Math.floor(((ty + 0.5) / n) * this.p.rows)];
    }
    throw new Error('atlas: nowhere to start (no temperate land)');
  }

  dispose(): void {
    for (const b of [this.paramBuf, this.region, this.dist, this.regs, this.pat, this.kcol]) b?.destroy();
  }
}

/** what the structural system judges (integrity.ts, fracture.ts: solid and weaker than bedrock) */
const WEAK = MATERIALS.map((m) => m.state === MatState.Solid && m.strength < 1);

/** lava as the tubes hold it (lava.wgsl: it sets below 750) */
const LAVA_HOT = 1250;

/** columns → intervals: each column's runs (forms.wgsl colFinish), alike neighbours merged; a
 *  column with more than K (what the window's chunks hold) has its closest neighbours made one
 *  until it fits (counted: `gapsFilled`). */
export function landFrom(c: AtlasColumns, x0: number, y0: number, K: number): RegionLand & { gapsFilled: number } {
  const { w, h, f, u } = c;
  const N = w * h;
  const cols: Interval[][] = [];
  const surface = new Float32Array(N);
  const water = new Float32Array(N);
  const moisture = new Float32Array(N);
  const vegetation = new Float32Array(N);
  const lava = new Float32Array(N * 4);
  const lavaSpring = new Float32Array(N);
  const structural = new Uint8Array(N);
  const contam = new Float32Array(N * 2);
  let gapsFilled = 0;
  for (let i = 0; i < N; i++) {
    const o = i * COL_WORDS;
    const n = u[o + 9];
    const col: Interval[] = [];
    for (let k = 0; k < n; k++) {
      const { z0, z1, mat, form } = c.run(i, k);
      if (form && WEAK[mat]) structural[i] = 1;
      const last = col[col.length - 1];
      if (last && last.mat === mat && z0 <= last.z1) last.z1 = z1;
      else col.push({ z0, z1, mat });
    }
    if (!col.length) throw new Error(`atlas: column ${x0 + (i % w)},${y0 + Math.floor(i / w)} is empty`);
    if (col.length > K) gapsFilled++;
    // (each step: the neighbours closest to being one — the gap between them and the thinner's
    // thickness least — become one, of the thicker's material)
    const cost = (k: number) => col[k].z0 - col[k - 1].z1 + Math.min(col[k].z1 - col[k].z0, col[k - 1].z1 - col[k - 1].z0);
    while (col.length > K) {
      let best = 1;
      for (let k = 2; k < col.length; k++) if (cost(k) < cost(best)) best = k;
      const lo = col[best - 1];
      const hi = col[best];
      const mat = hi.z1 - hi.z0 > lo.z1 - lo.z0 ? hi.mat : lo.mat;
      col.splice(best - 1, 2, { z0: lo.z0, z1: hi.z1, mat });
    }
    cols.push(col);
    surface[i] = col[col.length - 1].z1;
    water[i] = f[o + 3];
    moisture[i] = f[o + 4];
    vegetation[i] = f[o + 5];
    const lv = f[o + 6];
    if (lv > 0) {
      lava.set([lv, LAVA_HOT, 0, surface[i] + lv], i * 4);
      lavaSpring[i] = lv;
    }
  }
  return { x0, y0, w, h, cols, surface, water, moisture, vegetation, contam, lava, lavaSpring, structural, gapsFilled };
}
