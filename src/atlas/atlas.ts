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

import { type ComputeKernel } from '../gpu/pipeline';
import { type Interval, type WorldDims } from '../world/layout';
import { ROW_H } from '../world/lattice';
import type { MapData } from '../world/mapgen';
import { rng } from '../world/noise';
import type { RegionLand } from '../world/streamgen';
import commonW from './common.wgsl?raw';
import composeW from './compose.wgsl?raw';
import terrainRiverW from '../terrain/river.wgsl?raw';
import terrainCaveW from '../terrain/cave.wgsl?raw';
import terrainGorgeW from '../terrain/gorge.wgsl?raw';
import terrainSeaW from '../terrain/sea.wgsl?raw';
import noiseW from './noise.wgsl?raw';
import patternsW from './patterns.wgsl?raw';
import { KIND_IDS, KINDS, warmth, type RegionDef } from './regions';
import { type Landform } from './landforms';
import { type Settlement } from './sites';
import { type Ways } from './ways';
import { StampOps } from './stamps';
import { RegionFinish, type FinishMeta, type FinishTarget, type GpuColumns, type RawGround } from './finish';
import { LAKE_WORDS, NODE_WORDS, type AtlasLake, type Catchments } from './rivers';
import { riverMode } from '../sim/world-gpu';
import { RIVER_FALL, RIVER_LEVEE, RIVER_SHEET } from '../world/rivertable';
import { Coarse, type CoarseSnap } from './coarse';
import type { LandChange } from '../scenes/streamer';
import { run } from './atlas/build';
import { changes, columns, columnsGpu } from './atlas/columns';
import { rawGround, rawGroundGpu, regionInto, regionLand, stampsFor, tileGate } from './atlas/region-land';
import { window } from './atlas/window';
import { Extra, PARAM_BYTES, MakeHow, WINDOW_MAKE, Geyser, GEYSER_SPACING, CRATER_BLOCK, GIANT_FLOATS, FLOOD_SPARE, AtlasStats, AtlasColumns } from './atlas/defs';
import { AtlasParams } from './atlas/params';
import { TilePacer } from './atlas/tile-pacer';
export { WINDOW_MAKE, FINISH_TILE, GEYSER_STENCIL, STAMP, MAX_CRATERS, GIANT_FLOATS, FLOOD_SPARE, landFrom } from './atlas/defs';
export type { MakeHow, Geyser, AtlasStats, AtlasColumns } from './atlas/defs';
export { DEFAULT_ATLAS, ATLAS_KEYS, atlasParamsFrom } from './atlas/params';
export type { AtlasParams } from './atlas/params';
export { TilePacer } from './atlas/tile-pacer';

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
  riverStats = { nodes: 0, lava: 0, waterfalls: 0, lakes: 0, ms: 0, speed: [0, 0, 0] as [number, number, number], discharge: 0, pipeSlope: 0, shaped: { cascaded: 0, falls: 0, incision: 0 } };
  /** the nodes (rivers.ts NODE_WORDS each), for tools */
  riverNodes: Uint32Array = new Uint32Array(0);
  /** (round 117, terrain track) where the lakes' table and ids sit in riverBuf (words), rows used and room for more */
  basinTab = { tabOff: 0, idsOff: 0, used: 0, cap: 0, on: false };
  /** (round 109, rivers.ts) what drains into each node: weather/catchwet.ts's per-watershed wetness */
  riverCatchments?: Catchments;
  /** (round 90, rivers.ts) the lakes: each filled hollow kept as one, and per texel which (rivers.ts LAKE_IN: its
   *  id + 1, the bit set inside it, unset on its rim) */
  lakes: AtlasLake[] = [];
  lakeAt: Uint16Array = new Uint16Array(0);
  /** the coarse world (round 71): what changes at the world's scale, out of sight */
  readonly coarse: Coarse;
  /** the giants (round 75): crystals the size of mountains, GIANT_FLOATS each — x, y (world), base, height,
   *  radius, lean (x, y: the offset a cell up), turn */
  giants = new Float32Array(0);
  colH!: ComputeKernel;
  colF!: ComputeKernel;
  formSeed!: ComputeKernel;

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
    this.coarse.timer = () => this.profiler;
    device.queue.writeBuffer(this.kcol, 0, new Float32Array(KIND_IDS.flatMap((k) => [...KINDS[k].colour, 1])));
  }

  /** the WGSL every atlas kernel is built from, and its own */
  parts(...own: string[]): string[] {
    // (round 84: how the rivers are kept — sim/world-gpu.ts RIVERS; columns.wgsl, forms.wgsl)
    // (round 110: the fall, the sheet and the levee shared with an authored river table — world/rivertable.ts)
    const rivers = `const RIVER_TABLE: bool = ${riverMode() === 'table'};
const RIVER_HOLD: bool = ${riverMode() === 'hold'};
const RIVER_FALL: f32 = ${RIVER_FALL.toFixed(2)};
const RIVER_SHEET: f32 = ${RIVER_SHEET.toFixed(2)};
const RIVER_LEVEE: f32 = ${RIVER_LEVEE.toFixed(2)};
`;
    // (round 117: terrain/river.wgsl — the rivers' course and cross-section, the terrain track's)
    return [noiseW, commonW, patternsW, composeW, terrainRiverW, terrainCaveW, terrainGorgeW, terrainSeaW, rivers, ...own];
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
    f[34] = e.tile?.[0] ?? 0;
    f[35] = e.tile?.[1] ?? 0;
    u[36] = e.macro ? 1 : 0;
    this.device.queue.writeBuffer(into, 0, ab);
  }

  static async build(device: GPUDevice, p: AtlasParams): Promise<Atlas> {
    const a = new Atlas(device, p);
    await run(a);
    return a;
  }

  async time<T>(name: string, f: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    const r = await f();
    await this.device.queue.onSubmittedWorkDone();
    this.timings[name] = +(performance.now() - t0).toFixed(1);
    return r;
  }

  async read(buf: GPUBuffer, bytes = buf.size): Promise<ArrayBuffer> {
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
  columns(x0: number, y0: number, w: number, h: number, spread = false): Promise<AtlasColumns> {
    return columns(this, x0, y0, w, h, spread);
  }

  /**
   * (round 102) A batch's columns made on the GPU and left there (forms.wgsl colFinish's colOut and colRuns): the
   * passes submitted, `done` to let the buffers go once what reads them is submitted too (columns' readback, or
   * finish.wgsl: atlas/finish.ts). Streaming (`spread`): a tile a frame (the pacer's), as before.
   */
  columnsGpu(x0: number, y0: number, w: number, h: number, spread = false, gate: () => Promise<void> = () => tileGate(this)): Promise<GpuColumns & { done: () => void }> {
    return columnsGpu(this, x0, y0, w, h, spread, gate);
  }

  /** the coarse world round a region of world cells now (the streamer's LandSource.snapshot) */
  snapshot(x0: number, y0: number, w: number, h: number): Promise<CoarseSnap> {
    return this.coarse.snapshot(x0, y0, w, h);
  }

  /** what has changed at each world cell of a region since `snap` (the streamer's LandSource.changes) */
  changes(snap: unknown, x0: number, y0: number, w: number, h: number): Promise<((x: number, y: number) => LandChange) | null> {
    return changes(this, snap, x0, y0, w, h);
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

  /**
   * (round 88) What's built on land as it's made: called with each region's land after the ways and the stamps.
   * `raw` lands skip them (the ground a settlement is planned on). (Round 102: the settlements and a run's stage say
   * what they build as stamps instead — stampHooks — so the GPU can build it; nothing here uses this now.)
   */
  readonly landHooks: ((land: RegionLand, x0: number, y0: number, w: number, h: number, spread: boolean) => Promise<void>)[] = [];

  /**
   * (round 102) What's built into a region's land as it's made — the settlements' (settle/settlements.ts), a run's
   * stage's (story/stage-land.ts) — as stamp operations (atlas/stamps.ts), in order: the GPU's path (regionInto) and
   * the CPU's (regionLand) build the same from them. Not for raw land.
   */
  readonly stampHooks: ((ops: StampOps, x0: number, y0: number, w: number, h: number, spread: boolean, plan: boolean) => Promise<void>)[] = [];

  /** (round 102) the stamps for a region: every stamp hook's, in order. (Round 108, TC8: `plan` false — a render-only
   *  tile's — only what's planned already: no plan started, no ground read back, no worker; a plan that lands later
   *  says where through stampsChanged) */
  stampsFor(x0: number, y0: number, w: number, h: number, spread: boolean, plan = true): Promise<StampOps> {
    return stampsFor(this, x0, y0, w, h, spread, plan);
  }

  /** A region's land for the streamer (world/streamgen.ts RegionLand), in world z (the streamer cuts it at its window). */
  regionLand(x0: number, y0: number, w: number, h: number, K = Infinity, spread = false, raw = false): Promise<RegionLand> {
    return regionLand(this, x0, y0, w, h, K, spread, raw);
  }

  /** (round 102) the GPU's finishing (atlas/finish.ts) */
  finisher!: RegionFinish;
  /** (round 102) regions made on the GPU, and the raw tiles */
  gpuMade = 0;
  gpuRaw = 0;

  /**
   * (round 102) A region made on the GPU straight into `target` (a pool slot, in the region layout): its columns
   * (a tile a frame when paced), then finish.wgsl — the geysers, the ways, the stamps, the cut, the pack. The land
   * itself never leaves the GPU. (Round 108, TC18: the one way land is made — the window's regions and a render-only
   * tile's alike; what differs is `how`, said by whoever asks: its pacing, which stamps, what comes back.)
   * Returns what the CPU keeps of it (FinishMeta), or null when `how.summary` takes the per-column summary on the GPU
   * instead (nothing read back: it resolves once the last of it is submitted).
   */
  regionInto(x0: number, y0: number, w: number, h: number, target: FinishTarget, how: MakeHow = WINDOW_MAKE): Promise<FinishMeta | null> {
    return regionInto(this, x0, y0, w, h, target, how);
  }

  /** (round 108, TC8) a plan made since (a settlement's): the land over this box (world cells) made before it without
   *  its stamps is stale — a render-only tile there is made again (render/tilelandgpu.ts) */
  readonly stampsChanged: ((x0: number, y0: number, w: number, h: number) => void)[] = [];

  /**
   * (round 102) The raw ground over a box (world cells; y0 even) — what a settlement is planned on (regionLand's raw
   * land: the columns, the geysers' sinter, the ways; its top, its material, the water on it, the plants) — made on
   * the GPU a 64² tile at a time, 16 bytes a column read back.
   */
  rawGround(x0: number, y0: number, w: number, h: number, spread = false): Promise<RawGround> {
    return rawGround(this, x0, y0, w, h, spread);
  }

  /** (citygen M4b) the raw ground over a box into a GPU buffer, nothing read back (region-land.ts rawGroundGpu) */
  rawGroundGpu(x0: number, y0: number, w: number, h: number, out: GPUBuffer): Promise<void> {
    return rawGroundGpu(this, x0, y0, w, h, out);
  }

  /**
   * (round 98, scripts/speedsweep.mjs) The streamed batches' builds by their corner (performance.now() ms): asked for,
   * each tile's turn (tileGate), the columns read back, the ways stamped, the land hooks (the settlements) done.
   */
  readonly builds = new Map<string, { t0: number; tiles: number[]; mapped: number; ways: number; hooks: number }>();

  /** the game's GPU profiler, when the level lends it (round 80): the column batches' passes are timed */
  profiler?: import('../gpu/profiler').Profiler;

  /** one streamed batch's tile a frame, over all of them (round 80) */
  gate: Promise<void> = Promise.resolve();
  /** (round 98) the streamed batches' tiles, as many a frame as the frame has room for */
  readonly pacer = new TilePacer();

  /** columns the ways have changed so far */
  waysStamped = 0;

  /** the macro ground at a world point: the texels' heights, bilinear, wrapping */
  /**
   * (round 112, `tilefix`) What the CPU knows of a box's heights (world cells x0, y0 — rows —, w x h): the macro ground's
   * lowest and highest over it (9 x 9 points a 64² region), the sea's level, and the giants reaching into it (their
   * points) — world z. The columns' own detail lies round it (a render-only tile's bound pads it: TileCache).
   */
  zRange(x0: number, y0: number, w: number, h: number): [number, number] {
    const rowH = Math.sqrt(3) / 2;
    let lo = Infinity;
    let hi = this.p.sea;
    const n = Math.max(2, Math.ceil(Math.max(w, h) / 8) + 1);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const z = this.macroAt(x0 + (i / (n - 1)) * w, (y0 + (j / (n - 1)) * h) * rowH);
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
    const cx = x0 + w / 2;
    const cy = (y0 + h / 2) * rowH;
    const G = this.giants;
    for (let k = 0; k < G.length; k += GIANT_FLOATS) {
      const gx = G[k] + Math.round((cx - G[k]) / this.worldW) * this.worldW;
      const gy = G[k + 1] + Math.round((cy - G[k + 1]) / this.worldH) * this.worldH;
      const H = G[k + 3];
      const reach = G[k + 4] * 1.16 + 2 + Math.hypot(G[k + 5] * H, G[k + 6] * H);
      if (Math.abs(gx - cx) > w / 2 + reach || Math.abs(gy - cy) > (h / 2) * rowH + reach) continue;
      hi = Math.max(hi, G[k + 2] + H);
    }
    return [lo, hi];
  }

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
  window(dims: WorldDims, ox: number, oy: number, K: number, tier: number, floor = 8): Promise<{ map: MapData; oz: number; outside: Interval[][]; ground: Float32Array }> {
    return window(this, dims, ox, oy, K, tier, floor);
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

  /**
   * (round 117, terrain track — terrain/flood.ts) A basin filled to `level` with `fluid` (0 water, 1 sand, 2 magma,
   * 3 ash): a row of the lakes' table, its texels (`inside`, macro texel indices) marked as in it and `rim` as its
   * shore (compose.wgsl lakeAt: the bank raised over its level where the ground dips under it). Land made from now on
   * has it; the window's and the tiles' land made before don't (remade as they stream again). Returns its id.
   */
  addBasin(inside: ArrayLike<number>, rim: ArrayLike<number>, level: number, fluid: number): number {
    const T = this.basinTab;
    if (!T.on) throw new Error('atlas: the lakes are off (?lakes=0): no basin can be flooded');
    if (T.used >= T.cap) throw new Error(`atlas: no room for another basin (${T.cap - T.used} of FLOOD_SPARE ${FLOOD_SPARE} left)`);
    const id = T.used++;
    for (let k = 0; k < rim.length; k++) if (!(this.lakeAt[rim[k]] & 0x8000)) this.lakeAt[rim[k]] = id + 1;
    for (let k = 0; k < inside.length; k++) this.lakeAt[inside[k]] = (id + 1) | 0x8000;
    const row = new Float32Array([level, fluid]);
    this.device.queue.writeBuffer(this.riverBuf, (T.tabOff + id * LAKE_WORDS) * 4, row);
    this.device.queue.writeBuffer(this.riverBuf, T.idsOff * 4, this.lakeAt);
    return id;
  }

  dispose(): void {
    for (const b of [this.paramBuf, this.region, this.dist, this.regs, this.pat, this.kcol, this.riverBuf]) b?.destroy();
    this.coarse.dispose();
  }
}

