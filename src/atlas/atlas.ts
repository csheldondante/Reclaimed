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
import { ColumnGrid, addTop, fitColumn, lowerTop, splitColumn, type Interval, type WorldDims } from '../world/layout';
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
import { defineRegions, dryness, KIND_IDS, KINDS, REGION_WORDS, warmth, type RegionDef, type RegionStat } from './regions';
import { landformsOf, tiersOf, type Landform } from './landforms';
import { settle, type Settlement } from './sites';
import { buildWays, stampWays, type Ways } from './ways';
import { findRivers, NODE_WORDS } from './rivers';
import { Coarse, type CoarseSnap } from './coarse';
import type { LandChange } from '../scenes/streamer';

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
  /** the coarse world's cells a side (round 71: coarse.ts; a power of two dividing n) */
  coarseN: number;
  /** landforms (round 78, landforms.ts): the elevation noise's cells a turn (lower: bigger mesas and massifs) */
  formPer: number;
  /** the continent's slope (round 78): the land rises `lift` over this far from its coast (the coast's SDF) */
  liftReach: number;
  /** how much of each region's own noise and pattern shows on its landform (round 78: top-down wants less) */
  detail: number;
  /** impact craters in the macro height (round 78), at most MAX_CRATERS */
  craters: number;
  /** settlement sites (round 78, sites.ts), joined by roads */
  sites: number;
  /** atlas-scale oddities (round 78): clusters of faceted crystal mountains and bulbous domes */
  oddities: number;
}

export const DEFAULT_ATLAS: AtlasParams = {
  n: 2048,
  seed: 1,
  style: 0,
  cols: 16384,
  rows: 18944,
  sea: 28,
  // (round 69: the world is taller than a window — the streamed window slides in z)
  zTop: 480,
  landPer: 3,
  landThresh: 0.06,
  warp: 0.05,
  cellsPer: 80,
  jitter: 0.85,
  faultPer: 5,
  faultLo: -0.035,
  faultHi: 0.035,
  lift: 36,
  minIsland: 30,
  minLake: 30,
  minRegion: 60,
  warpCell: 9,
  caveDepth: 7,
  // (round 79, the user: "I would try a 2-8x reduction in noise frequency to get bigger caves": 40 → 160; their
  // height scales with it, columns.wgsl caveZ)
  caveScale: 160,
  coarseN: 512,
  formPer: 3,
  liftReach: 2400,
  detail: 0.5,
  craters: 18,
  sites: 140,
  oddities: 16,
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

const PARAM_BYTES = 144;
/** forms.wgsl ColOut, and the runs a column holds (MR) */
const COL_WORDS = 16;
const COLG_BYTES = 76;
const MR = 24;
const INST_BYTES = 64;
const MAX_INST = 8192;
/** a geyser (Atlas.geysersIn) */
export interface Geyser {
  x: number;
  y: number;
  period: number;
  last: number;
  phase: number;
}
/** world cells between the geysers' lattice points (a whole number of them round the world) */
const GEYSER_SPACING = 64;
const MAT_SINTER = 37;

/**
 * The macro height's stamps (round 78): in the river buffer after its n² words of nearest nodes
 * (compose.wgsl stampsAt) — a count, then CRATER_WORDS each: x, y (world), radius, height, a, b, kind,
 * material. One shader is at its storage buffers' limit, so they share.
 *  crater (kind 0)  height: its depth; a: rim (0 worn flat .. 1 sharp); b: a central peak's height
 *  facet  (kind 1)  a faceted crystal mountain: height its point's; a: its turn; b: its faces
 *  bulb   (kind 2)  a bulbous dome: height its top's; a: how lobed
 * Craters go first (the continents' noise takes only them); oddities are placed on land after the regions.
 */
export const STAMP = { crater: 0, facet: 1, bulb: 2, field: 3 } as const;
const CRATER_WORDS = 8;
export const MAX_CRATERS = 64;
const CRATER_BLOCK = 4 + MAX_CRATERS * CRATER_WORDS;

/** floats a giant (Atlas.giants), and what they're made of (materials.ts quartz) */
export const GIANT_FLOATS = 8;
const MAT_QUARTZ = 36;
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
  giants?: number;
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
  /** a · regions + b (a < b, dense ids) → texel edges shared */
  adjacency = new Map<number, number>();
  /** the landforms (round 78, landforms.ts) and each region's (−1: water) */
  landforms: Landform[] = [];
  landformOf: Int32Array = new Int32Array(0);
  readonly paramBuf: GPUBuffer;
  readonly region: GPUBuffer;
  readonly dist: GPUBuffer;
  regs!: GPUBuffer;
  readonly pat: GPUBuffer;
  readonly kcol: GPUBuffer;
  /** the rivers (rivers.ts): per texel its nearest node + 1, the craters (CRATER_BLOCK), then the nodes
   *  (compose.wgsl riverBuf) */
  riverBuf: GPUBuffer;
  /** the impact craters (round 78): CRATER_WORDS floats each */
  craters = new Float32Array(0);
  /** the sites and the roads between them (round 78, sites.ts) */
  settlement: Settlement = { sites: [], roads: [], ms: 0 };
  /** the roads and their crossings, graded, to be built into the columns (round 79, ways.ts) */
  ways: Ways = { points: [], lifts: [], bins: new Map(), counts: [], ms: 0 };
  riverStats = { nodes: 0, lava: 0, waterfalls: 0, ms: 0 };
  /** the nodes (rivers.ts NODE_WORDS each), for tools */
  riverNodes: Uint32Array = new Uint32Array(0);
  /** the coarse world (round 71): what changes at the world's scale, out of sight */
  readonly coarse: Coarse;
  /** the giants (round 75): crystals the size of mountains, GIANT_FLOATS each — x, y (world), base, height,
   *  radius, lean (x, y: the offset a cell up), turn */
  giants = new Float32Array(0);
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
    // (none until they're found: the ground the rivers are found on is made without them)
    this.riverBuf = device.createBuffer({ label: 'atlas rivers', size: (N + CRATER_BLOCK + NODE_WORDS) * 4, usage: S });
    this.coarse = new Coarse(device, p.coarseN, this.worldW, this.worldH);
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
    f[32] = p.liftReach;
    f[33] = p.detail;
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
    const [kBase, kInit, kHook, kJump, kCount, kClean, kKey, kSeedR, kSeedC, kStep, kOutR, kOutC, kMacro, colH, colF, fSeed, kSeedV, kOutV, kSeedL, kOutL] = await this.time('compile', () =>
      Promise.all([
        K('base', { 1: 'rw', 2: 'rw', 25: 'read' }),
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
        K('macroHeight', { 11: 'rw', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read' }),
        K('colHeight', { 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 30: 'rw' }, cm),
        K('colFinish', { 22: 'read', 23: 'read', 30: 'rw', 31: 'rw', 32: 'rw', 33: 'rw', 34: 'rw' }, cm),
        K('formSeed', { 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 32: 'rw', 33: 'rw' }, cm),
        K('jfaSeedV', { 2: 'rw', 7: 'rw' }),
        K('jfaOutV', { 2: 'rw', 7: 'rw' }),
        K('jfaSeedL', { 6: 'rw', 7: 'rw', 22: 'read' }),
        K('jfaOutL', { 6: 'rw', 7: 'rw', 9: 'rw', 22: 'read' }),
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
    // the craters first (round 78): the continents' noise takes them
    this.makeCraters();
    const writeCraters = () => {
      const blk = new Float32Array(CRATER_BLOCK);
      new Uint32Array(blk.buffer)[0] = this.craters.length / CRATER_WORDS;
      blk.set(this.craters, 4);
      dev.queue.writeBuffer(this.riverBuf, N * 4, blk);
    };
    writeCraters();
    await this.time('base', () => one(kBase, bg(kBase, { 1: fieldA, 2: key, 25: this.riverBuf })));
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
    // the oddities (round 78): on land, now that the land's known; in the ground from here on
    this.makeOddities();
    writeCraters();
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
    await this.time('jfa landforms', () => jfa(kSeedL, { 6: this.region, 22: this.regs }, kOutL, { 6: this.region, 9: this.dist, 22: this.regs }));
    const macro = () => one(kMacro, bg(kMacro, { 11: hmacB, 20: this.region, 21: this.dist, 22: this.regs, 23: this.pat, 25: this.riverBuf, 26: this.coarse.cells }));
    await this.time('ground', macro);
    this.hmac = new Float32Array(await this.time('readback ground', () => this.read(hmacB)));

    // ---- the rivers: found on the ground, spread to every texel (JFA), the ground again with them ----
    const rv = await this.time('rivers (cpu)', () => {
      const water = new Uint8Array(N);
      const volcanic = new Uint8Array(N);
      const lavaKinds = new Set(['lavafield', 'basalt', 'rift']);
      for (let i = 0; i < N; i++) {
        const d = this.defs[this.regionOf[i]];
        water[i] = d.stat.land ? 0 : 1;
        volcanic[i] = lavaKinds.has(d.kind) ? 1 : 0;
      }
      // (no lava out of an oddity's top: a crystal on a lava field isn't a vent)
      const ku = new Uint32Array(this.craters.buffer);
      for (let o = 0; o < this.craters.length; o += CRATER_WORDS) {
        if (ku[o + 6] === 0) continue;
        const R = this.craters[o + 2] * 1.25;
        const tx = Math.floor((this.craters[o] / this.worldW) * n);
        const ty = Math.floor((this.craters[o + 1] / this.worldH) * n);
        const rt = Math.ceil((R / this.worldW) * n);
        for (let dy = -rt; dy <= rt; dy++)
          for (let dx = -rt; dx <= rt; dx++) if (dx * dx + dy * dy <= rt * rt) volcanic[(((ty + dy) % n) + n) % n * n + ((((tx + dx) % n) + n) % n)] = 0;
      }
      return findRivers({ n, hmac: this.hmac, water, volcanic, regionOf: this.regionOf, sea: p.sea, worldW: this.worldW, worldH: this.worldH });
    });
    this.riverStats = { nodes: rv.count, lava: rv.lava, waterfalls: rv.waterfalls, ms: rv.ms };
    this.riverNodes = rv.nodes;
    this.riverBuf.destroy();
    this.riverBuf = dev.createBuffer({ label: 'atlas rivers', size: (N + CRATER_BLOCK) * 4 + Math.max(rv.nodes.byteLength, NODE_WORDS * 4), usage: S });
    writeCraters();
    dev.queue.writeBuffer(this.riverBuf, (N + CRATER_BLOCK) * 4, rv.nodes);
    dev.queue.writeBuffer(key, 0, rv.nodeAt);
    await this.time('jfa rivers', async () => {
      await jfa(kSeedV, { 2: key }, kOutV, { 2: key });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(key, 0, this.riverBuf, 0, N * 4);
      dev.queue.submit([enc.finish()]);
    });
    await this.time('ground with rivers', macro);
    this.hmac = new Float32Array(await this.read(hmacB));
    // sites and roads (round 78): on the ground with its rivers
    await this.time('sites and roads (cpu)', () => {
      const contOf = new Int32Array(N);
      for (let i = 0; i < N; i++) {
        const d = this.defs[this.regionOf[i]];
        contOf[i] = d.stat.land ? d.stat.cont : -1;
      }
      const lfOf = new Int32Array(N);
      for (let i = 0; i < N; i++) lfOf[i] = this.landformOf[this.regionOf[i]];
      this.settlement = settle({ n, seed: p.seed, hmac: this.hmac, landformOf: lfOf, forms: this.landforms, contOf, river: rv.nodeAt, craters: this.craters, craterWords: CRATER_WORDS, worldW: this.worldW, worldH: this.worldH, sea: p.sea, count: p.sites });
    });
    await this.time('ways (cpu)', () => {
      this.ways = buildWays({ settlement: this.settlement, ground: (x, y) => this.macroAt(x, y), worldW: this.worldW, worldH: this.worldH, sea: p.sea });
    });
    await this.time('coarse world', () => this.coarse.init(this.hmac, n, (t) => !this.defs[this.regionOf[t]].stat.land));
    await this.time('giants (cpu)', () => this.makeGiants());
    for (const b of [fieldA, key, label, size, flag, flagRead, info, cont, jfaA, jfaB, hmacB]) b.destroy();
  }

  /**
   * Impact craters (round 78: "adding impact craters at large scale to the heightmap you initially
   * sample"): a few dozen over the world, most a few hundred cells across, some huge with a central peak;
   * the older the more worn (a lower rim, a shallower bowl). Land or sea alike: a crater by a coast is a bay.
   */
  private makeCraters(): void {
    const r = rng(this.p.seed * 6151 + 29);
    const k = Math.min(Math.max(0, Math.round(this.p.craters)), MAX_CRATERS);
    const out = new Float32Array(k * CRATER_WORDS);
    for (let i = 0; i < k; i++) {
      // (sizes: many small, a few huge)
      const R = 120 + 900 * r() ** 3;
      const age = r();
      out.set([r() * this.worldW, r() * this.worldH, R, Math.min(R * 0.07, 45) * (1 - 0.6 * age), 1 - age * 0.8, R > 450 ? Math.min(R * 0.05, 40) : 0, 0, 0], i * CRATER_WORDS);
      // (kind crater 0, material 0: the u32 words are zero either way)
    }
    this.craters = out;
  }

  /**
   * Atlas-scale oddities (round 78: "atlas scale weird features like faceted crystals or bulbous bumps in
   * the height map"): clusters on land regions' middles — faceted crystal mountains (a main one and smaller
   * ones round it, quartz) or bulbous domes (granite in the earth style, coral in the strange, flesh in
   * the flesh), appended to the craters (STAMP).
   */
  private makeOddities(): void {
    const r = rng(this.p.seed * 3571 + 41);
    const room = MAX_CRATERS - this.craters.length / CRATER_WORDS;
    const land = this.defs.filter((d) => d.stat.land && d.stat.contArea > 2000);
    const out: number[] = [];
    const style = this.p.style;
    const bulbMat = style === 2 ? 33 : style === 1 ? 34 : 1;
    for (let c = 0; c < Math.round(this.p.oddities) && land.length; c++) {
      const d = land[Math.floor(r() * land.length)];
      const cx = d.stat.cx * this.worldW;
      const cy = d.stat.cy * this.worldH;
      const facet = r() < (style === 2 ? 0.3 : 0.55);
      // (round 78: a crystal cluster is a field of facets (the user: "large voronoi facets raised slightly
      // deeper in rather than a single large crystal but both should be possible") — a field alone, a
      // field with crystals in it, or crystals alone)
      const fr = r();
      if (facet && fr < 0.7 && out.length / CRATER_WORDS < room) {
        const RF = 220 + 380 * r();
        // (x, y, R, H, its noise's seed, a facet's size)
        out.push(cx, cy, RF, 14 + 30 * r(), Math.floor(r() * 1e6), 18 + 26 * r(), STAMP.field, 36);
        if (fr < 0.4) continue;
      }
      const k = facet ? 1 + Math.floor(r() * 4) : 3 + Math.floor(r() * 6);
      const R0 = facet ? 140 + 260 * r() : 70 + 140 * r();
      for (let i = 0; i < k; i++) {
        if (out.length / CRATER_WORDS >= room) break;
        const R = i === 0 ? R0 : R0 * (0.3 + 0.5 * r());
        const a = r() * Math.PI * 2;
        const dd = i === 0 ? 0 : R0 * (0.6 + 0.9 * r());
        const x = cx + Math.cos(a) * dd;
        const y = cy + Math.sin(a) * dd;
        if (facet) out.push(x, y, R, R * (0.9 + 0.8 * r()), r() * Math.PI * 2, 5 + Math.floor(r() * 4), STAMP.facet, 36);
        else out.push(x, y, R, R * (0.45 + 0.35 * r()), r(), 0, STAMP.bulb, bulbMat);
      }
    }
    const all = new Float32Array(this.craters.length + out.length);
    all.set(this.craters);
    all.set(out, this.craters.length);
    // (the kind and material words are u32s)
    const u = new Uint32Array(all.buffer);
    for (let i = this.craters.length; i < all.length; i += CRATER_WORDS) {
      u[i + 6] = all[i + 6];
      u[i + 7] = all[i + 7];
    }
    this.craters = all;
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
    const adj = (rs: Uint32Array, R: number) => {
      const m = new Map<number, number>();
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
    const pairs = adj(reg, stats.length);
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
    // (keyed by the dense ids: a · regions + b)
    this.adjacency = adj(reg, out.length);
    let ocean = 0;
    for (const s of out) if (!s.land) ocean = Math.max(ocean, s.contArea);
    // the landforms: tiers from the elevation noise, adjacent regions of one tier one landform
    const { tier, rift } = tiersOf(out, this.p.seed, dryness, this.p.formPer);
    const lf = landformsOf(tier, this.adjacency, this.p.seed);
    this.landforms = lf.forms;
    this.landformOf = lf.of;
    this.defs = defineRegions(out, this.p.seed, this.p.style, Math.min(ocean, N * 0.02), { tier, rift, of: lf.of, forms: lf.forms });
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
  climateAt(cx: number, cy: number, oz = 0): { temp: number; lapse: number } {
    // (compose.wgsl temperature and LAPSE: keep the two the same)
    const lapse = 0.05;
    const warm = warmth(((cy + 0.5) / this.p.rows) % 1);
    // (the sim's z is the window's: its z = 0 is the world's oz)
    return { temp: warm * 34 - 8 + (this.p.sea - oz) * lapse, lapse };
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
    const inst = dev.createBuffer({ label: 'atlas forms', size: MAX_INST * INST_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const instN = dev.createBuffer({ label: 'atlas forms n', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const st = dev.createBuffer({ label: 'atlas col read', size: o.size + runs.size + 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.writeParams({ x0, y0, w, h }, pb);
    // the giants reaching into it go first (the lattice forms are counted on from them)
    const gi = this.giantsFor(x0, y0, w, h);
    if (gi.count) {
      dev.queue.writeBuffer(inst, 0, gi.data);
      dev.queue.writeBuffer(instN, 0, new Uint32Array([gi.count]));
    }
    const enc = dev.createCommandEncoder({ label: 'atlas columns' });
    let cp = enc.beginComputePass();
    cp.setPipeline(this.colH.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'colH', this.colH.layout, { 0: pb, 20: this.region, 21: this.dist, 22: this.regs, 23: this.pat, 25: this.riverBuf, 26: this.coarse.cells, 30: g }));
    cp.dispatchWorkgroups(Math.ceil((w + 2) / 8), Math.ceil((h + 2) / 8));
    cp.end();
    // the lattice forms around the batch (every lattice: the finest's cells cover the most)
    cp = enc.beginComputePass();
    cp.setPipeline(this.formSeed.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'formSeed', this.formSeed.layout, { 0: pb, 20: this.region, 21: this.dist, 22: this.regs, 23: this.pat, 25: this.riverBuf, 26: this.coarse.cells, 32: inst, 33: instN }));
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

  /**
   * The giants (round 75: "faceted crystals the size of mountains or columns of crystal extending into
   * the sky at angles"): in the crystal regions, a few each — quartz prisms to a point, 150–420 tall,
   * 16–46 across, leaning up to 35°. The columns have them as forms (forms.wgsl PROF_PRISM: they're
   * handed to each batch they reach into), the far land as meshes (far.ts).
   */
  private makeGiants(): void {
    const n = this.p.n;
    const kinds = new Set(['crystals', 'crystalfield']);
    const texels = new Map<number, number[]>();
    for (let i = 0; i < n * n; i++) {
      const r = this.regionOf[i];
      if (!kinds.has(this.defs[r].kind)) continue;
      (texels.get(r) ?? texels.set(r, []).get(r)!).push(i);
    }
    const out: number[] = [];
    for (const [reg, ts] of texels) {
      const r = rng(this.p.seed * 2741 + reg * 613 + 11);
      const count = Math.max(1, Math.min(10, Math.floor(ts.length / 180)));
      for (let k = 0; k < count; k++) {
        const t = ts[Math.floor(r() * ts.length)];
        const tx = t % n;
        const ty = (t - tx) / n;
        const x = ((tx + 0.2 + 0.6 * r()) / n) * this.worldW;
        const y = ((ty + 0.2 + 0.6 * r()) / n) * this.worldH;
        const H = 150 + 270 * r() * r();
        const rad = 16 + 30 * r();
        const tilt = ((r() * 35) / 180) * Math.PI;
        const dir = r() * 2 * Math.PI;
        const lean = Math.tan(tilt);
        out.push(x, y, this.hmac[t] - 6, H, rad, Math.cos(dir) * lean, Math.sin(dir) * lean, r() * Math.PI);
      }
    }
    this.giants = Float32Array.from(out);
    this.stats.giants = this.giants.length / GIANT_FLOATS;
  }

  /** the giants reaching into a batch of world cells, as forms.wgsl Insts in the batch's frame */
  private giantsFor(x0: number, y0: number, w: number, h: number): { data: ArrayBuffer; count: number } {
    const rowH = Math.sqrt(3) / 2;
    const cx = x0 + w / 2;
    const cy = (y0 + h / 2) * rowH;
    const hw = w / 2 + 2;
    const hh = (h / 2) * rowH + 2;
    const G = this.giants;
    const recs: number[] = [];
    for (let k = 0; k < G.length; k += GIANT_FLOATS) {
      // (the copy of it round the torus nearest the batch)
      const gx = G[k] + Math.round((cx - G[k]) / this.worldW) * this.worldW;
      const gy = G[k + 1] + Math.round((cy - G[k + 1]) / this.worldH) * this.worldH;
      const H = G[k + 3];
      const r = G[k + 4];
      const lx = G[k + 5] * H;
      const ly = G[k + 6] * H;
      // its box: from its foot to its point, the polygon's corners round both
      const R = r * 1.16 + 2;
      const bx0 = Math.min(gx, gx + lx) - R;
      const bx1 = Math.max(gx, gx + lx) + R;
      const by0 = Math.min(gy, gy + ly) - R;
      const by1 = Math.max(gy, gy + ly) + R;
      if (bx1 < cx - hw || bx0 > cx + hw || by1 < cy - hh || by0 > cy + hh) continue;
      recs.push(k / GIANT_FLOATS, gx, gy, Math.max(R + Math.hypot(lx, ly), 1));
    }
    const data = new ArrayBuffer(Math.max(recs.length / 4, 1) * INST_BYTES);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    for (let i = 0; i < recs.length / 4; i++) {
      const k = recs[i * 4] * GIANT_FLOATS;
      const o = i * 16;
      f[o] = recs[i * 4 + 1];
      f[o + 1] = recs[i * 4 + 2];
      f[o + 2] = G[k + 2];
      f[o + 3] = G[k + 3];
      f[o + 4] = G[k + 4];
      f[o + 5] = 0;
      f[o + 6] = G[k + 5];
      f[o + 7] = G[k + 6];
      u[o + 8] = 1; // FORM_SPIRE
      u[o + 9] = MAT_QUARTZ | (8 << 16) | (6 << 24); // a hexagonal prism to its point (PROF_PRISM)
      f[o + 10] = -1;
      f[o + 11] = 0;
      f[o + 12] = G[k + 7];
      f[o + 13] = recs[i * 4 + 3];
      f[o + 14] = G[k + 2] + G[k + 3];
      f[o + 15] = 0;
    }
    return { data, count: recs.length / 4 };
  }

  /** the coarse world round a region of world cells now (the streamer's LandSource.snapshot) */
  snapshot(x0: number, y0: number, w: number, h: number): Promise<CoarseSnap> {
    return this.coarse.snapshot(x0, y0, w, h);
  }

  /** what has changed at each world cell of a region since `snap` (the streamer's LandSource.changes) */
  async changes(snap: unknown, x0: number, y0: number, w: number, h: number): Promise<((x: number, y: number) => LandChange) | null> {
    const was = snap as CoarseSnap;
    const now = await this.coarse.snapshot(x0, y0, w, h);
    let any = false;
    for (let i = 0; i < now.cells.length; i++)
      if (Math.abs(now.cells[i] - was.cells[i]) > 1e-4) {
        any = true;
        break;
      }
    if (!any) return null;
    const rowH = Math.sqrt(3) / 2;
    return (x, y) => {
      const px = x + 0.5 + 0.5 * (((y % 2) + 2) % 2);
      const py = (y + 0.5) * rowH;
      const a = this.coarse.sample(now, px, py);
      const b = this.coarse.sample(was, px, py);
      return { dr: a.dr - b.dr, cap: a.cap, dl: a.loose - b.loose, lmat: a.lmat, dw: a.water - b.water };
    };
  }

  /**
   * The geysers in a box of world cells (round 75: "lava areas should have geysers that shoot out water
   * and steam"): on a lattice GEYSER_SPACING cells apart, in the volcanic regions' land, one cell in three
   * — where it is (world cells), how long between eruptions and how long each lasts (s), when it first
   * goes. A pure function of where: the generator lays their sinter, the level makes them go.
   */
  geysersIn(x0: number, y0: number, w: number, h: number): Geyser[] {
    const S = GEYSER_SPACING;
    const out: Geyser[] = [];
    const nx = this.p.cols / S;
    const ny = this.p.rows / S;
    const kinds = new Set(['lavafield', 'basalt', 'rift']);
    const rowH = Math.sqrt(3) / 2;
    for (let j = Math.floor(y0 / S) - 1; j <= Math.floor((y0 + h) / S) + 1; j++)
      for (let i = Math.floor(x0 / S) - 1; i <= Math.floor((x0 + w) / S) + 1; i++) {
        const wi = ((i % nx) + nx) % nx;
        const wj = ((j % ny) + ny) % ny;
        const r = rng(this.p.seed * 7907 + wj * 104729 + wi * 31 + 5);
        if (r() > 0.34) continue;
        const x = i * S + 8 + Math.floor(r() * (S - 16));
        let y = j * S + 8 + Math.floor(r() * (S - 16));
        y -= y & 1 ? 1 : 0;
        if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) continue;
        const px = x + 0.5;
        const py = (y + 0.5) * rowH;
        const d = this.regionAt(px, py);
        if (!d.stat.land || !kinds.has(d.kind)) continue;
        out.push({ x, y, period: 18 + r() * 40, last: 4 + r() * 5, phase: r() * 60 });
      }
    return out;
  }

  /** columns that had more intervals than the window holds (their smallest gaps filled: landFrom) */
  gapsFilled = 0;

  /** A region's land for the streamer (world/streamgen.ts RegionLand), in world z (the streamer cuts it at its window). */
  async regionLand(x0: number, y0: number, w: number, h: number, K = Infinity): Promise<RegionLand> {
    if (y0 & 1) throw new Error('a region starts on an even row');
    const c = await this.columns(x0, y0, w, h);
    const land = landFrom(c, x0, y0, K);
    this.gapsFilled += land.gapsFilled;
    // the geysers' sinter: a low mound round each vent, its pit at the middle
    for (const g of this.geysersIn(x0, y0, w, h))
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = g.x - x0 + dx;
          const y = g.y - y0 + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const r = Math.hypot(dx, dy * 0.866);
          if (r > 4) continue;
          const col = land.cols[y * w + x];
          if (!col.length) continue;
          if (r < 0.9) lowerTop(col, 0.6);
          else addTop(col, 1.8 * (1 - r / 4) ** 1.5, MAT_SINTER);
          land.vegetation[y * w + x] = 0;
          land.surface[y * w + x] = col[col.length - 1].z1;
        }
    // the roads, their crossings and the sites' plazas (round 79, ways.ts)
    this.waysStamped += stampWays(this.ways, land, x0, y0, w, h, (cx, cy) => [cx + 0.5 + 0.5 * (cy & 1), (cy + 0.5) * ROW_H], this.worldW, this.worldH);
    return land;
  }

  /** columns the ways have changed so far */
  waysStamped = 0;

  /** the macro ground at a world point: the texels' heights, bilinear, wrapping */
  macroAt(x: number, y: number): number {
    const n = this.p.n;
    const fx = (x / this.worldW) * n - 0.5;
    const fy = (y / this.worldH) * n - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const at = (i: number, j: number) => this.hmac[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
    return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
  }

  /** The window from world cell (ox, oy) as a map (the level's first world): its oz a whole number
   *  of tiers (the one holding the most of the ground's tops), K intervals a column at most, and
   *  what's outside it (world z). */
  async window(dims: WorldDims, ox: number, oy: number, K: number, tier: number, floor = 8): Promise<{ map: MapData; oz: number; outside: Interval[][]; ground: Float32Array }> {
    const { w, h, zMax } = dims;
    const N = w * h;
    // (in tiles of a region, as the streamer asks: one batch of the whole window is too much
    // work for one dispatch where forms stand thick — the GPU's watchdog resets the device)
    const T = 64;
    if (w % T || h % T) throw new Error(`the window (${w} × ${h}) must be whole tiles of ${T}`);
    const tiles: [number, number][] = [];
    for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty]);
    const lands = await Promise.all(tiles.map(([tx, ty]) => this.regionLand(ox + tx, oy + ty, T, T)));
    // the window's oz: the tier holding the most of the ground's tops (`floor` over its bottom, 24
    // under its top), the ground at its middle in it
    const mx = w >> 1;
    const my = h >> 1;
    const mid = lands[tiles.findIndex(([tx, ty]) => tx === Math.floor(mx / T) * T && ty === Math.floor(my / T) * T)];
    // (the ground's own top, not what stands on it: a giant's point isn't where the land is)
    const gMid = mid.ground![(my % T) * T + (mx % T)];
    let oz = 0;
    let most = -1;
    for (let c = 0; c + zMax <= this.p.zTop + tier; c += tier) {
      if (gMid < c + 8 || gMid > c + zMax - 40) continue;
      let n = 0;
      for (const t of lands) for (let i = 0; i < T * T; i += 7) if (t.ground![i] >= c + floor && t.ground![i] <= c + zMax - 24) n++;
      if (n > most) {
        most = n;
        oz = c;
      }
    }
    const outside: Interval[][] = new Array(N);
    const ground = new Float32Array(N);
    const grid = new ColumnGrid(dims);
    const land = { water: new Float32Array(N), moisture: new Float32Array(N), vegetation: new Float32Array(N), contam: new Float32Array(N * 2), lava: new Float32Array(N * 4), lavaSpring: new Float32Array(N), waterSource: new Float32Array(N), surface: new Float32Array(N), structural: new Uint8Array(N) };
    tiles.forEach(([tx, ty], k) => {
      const t = lands[k];
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const i = y * T + x;
          const j = (ty + y) * w + tx + x;
          const cut = splitColumn(t.cols[i], oz, zMax);
          if (fitColumn(cut.inside, K)) this.gapsFilled++;
          grid.cols[j] = cut.inside;
          outside[j] = cut.outside;
          const top = cut.inside.length > 0 && !cut.outside.some((iv) => iv.z0 >= oz + zMax - 1e-4);
          land.water[j] = top ? t.water[i] : 0;
          land.moisture[j] = t.moisture[i];
          land.vegetation[j] = t.vegetation[i];
          land.surface[j] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
          ground[j] = (t.ground ? t.ground[i] : land.surface[j] + oz) - oz;
          land.contam[j * 2] = t.contam[i * 2];
          land.contam[j * 2 + 1] = t.contam[i * 2 + 1];
          if (t.lava && top && t.lava[i * 4] > 0) land.lava.set([t.lava[i * 4], t.lava[i * 4 + 1], t.lava[i * 4 + 2], t.lava[i * 4 + 3] - oz], j * 4);
          if (t.lavaSpring) land.lavaSpring[j] = t.lavaSpring[i];
          if (t.structural) land.structural[j] = t.structural[i];
          if (t.waterSource && top) land.waterSource[j] = t.waterSource[i];
        }
    });
    const map: MapData = {
      grid,
      water: land.water,
      contam: land.contam,
      moisture: land.moisture,
      vegetation: land.vegetation,
      oil: new Float32Array(N),
      drift: new Float32Array(N),
      oilStored: new Float32Array(N * 2),
      waterSource: land.waterSource,
      lava: land.lava,
      lavaSpring: land.lavaSpring,
      structural: land.structural,
      surface: land.surface,
      poi: Object.fromEntries(['healthy', 'tutorial', 'dam', 'reservoir', 'site', 'landfill', 'heap'].map((k) => [k, [w / 2, h / 2]])) as Record<string, [number, number]>,
    };
    return { map, oz, outside, ground };
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
    for (const b of [this.paramBuf, this.region, this.dist, this.regs, this.pat, this.kcol, this.riverBuf]) b?.destroy();
    this.coarse.dispose();
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
  const waterSource = new Float32Array(N);
  const ground = new Float32Array(N);
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
    waterSource[i] = f[o + 12];
    ground[i] = f[o + 11];
    const lv = f[o + 6];
    if (lv > 0) {
      lava.set([lv, LAVA_HOT, 0, surface[i] + lv], i * 4);
      lavaSpring[i] = lv;
    }
  }
  return { x0, y0, w, h, cols, surface, water, moisture, vegetation, contam, lava, lavaSpring, waterSource, structural, ground, gapsFilled };
}
