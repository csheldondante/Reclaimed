// (street lab m2–m3; citygen M4a) The town generator — one pipeline, the street lab's and the game's: a town grid's
// ground heights and water read from the world's own buffers (height.wgsl: a box of the window), then the arterials and
// their bridges, the streets, blocks, lots and their mesh (streets.wgsl) — every pass on the GPU; the CPU writes the
// passes' numbers, the town's inputs (its centre, radius, seed, approach directions) and the points a tap places (an
// authored edit), and encodes the dispatches. The mesh is in the grid's own frame (its first column at 0, 0): the
// caller places it (Renderer.addMesh's transform). A run starts at the first stage a change needs (field → phi → trace → lots → mesh); what the stages
// before it made stays in their buffers. A point's change reruns φ over its radius's box only. The one read back is the
// run's timestamps, two counts and the points (360 bytes, after a run — never a frame's). It owns its buffers; it knows
// the world only through StreetWorld.
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import heightWgsl from './height.wgsl?raw';
import rawHeightWgsl from './rawheight.wgsl?raw';
import streetsWgsl from './streets.wgsl?raw';
import { makeBindGroup, makeCompute, makeLayout, makeModule, type ComputeKernel } from '../gpu/pipeline';
import { ROW_H } from '../world/lattice';

/** what the major lines are: the distance to water and cliffs' contours, that distance bent round the points (m3a: a
 *  smooth min with a cone a point, or a bump taken off), or rings and spokes round the town's centre */
export const MAJORS = ['distance contours', 'smooth min (points)', 'additive bump (points)', 'radial (rings, spokes)'] as const;
/** φ's mode for each (streets.wgsl phi: 0 the distance alone) */
const PHI_MODE = [0, 1, 2, 0];
/** how the cross streets are made: m3b's vector jump floods between the lines' seeds, or m2's tensor traces */
export const CROSS = ['vector JFA (m3)', 'tensor trace (m2)'] as const;
/** the families of major lines drawn: φ's level sets (1), or rings (2) and — with the traces — spokes (4) */
const families = (majors: number, cross: number) => (majors < 3 ? 1 : cross === 1 ? 2 | 4 : 2);
/** the points (streets.wgsl NPTS, PW: words a point; AUTO slots the GPU may place) */
export const NPTS = 8;
export const PW = 8;
export const AUTO = 4;
/** a point as the last run left it */
export interface StreetPoint {
  slot: number;
  x: number;
  y: number;
  intensity: number;
  /** 0 placed by the GPU, 1 pinned (a tap placed or moved it, or set its intensity), 2 removed */
  flag: number;
  alive: boolean;
}

export interface StreetParams {
  /** (citygen M4a) an arterial's width (cells); the height-to-plot ratio (a building no taller than this × its plot's
   *  shortest side; 0 the lab's storeys × 0.7–1.3); a bridge deck's height over its higher bank; the longest bridge */
  artWidth: number;
  hRatio: number;
  deckClear: number;
  maxSpan: number;
  /** the points' markers drawn (1: the lab's; 0: the game's) */
  marks: number;
  /** (M4b) the roads' tone: 0 the lab's white, 1 dirt, 2 stone (ROAD_TONES) */
  roadTone: number;
  /** index into MAJORS */
  majors: number;
  /** between the distance contours, between the rings (world units) */
  majorSpacing: number;
  ringSpacing: number;
  /** cross streets this far apart along a strip */
  blockLen: number;
  /** street widths (world units) */
  majorWidth: number;
  minorWidth: number;
  /** lots split until under maxLot (cells²); a split leaving one under minLot isn't made */
  maxLot: number;
  minLot: number;
  /** a building's setback from its street, its height in storeys (3 cells) */
  setback: number;
  height: number;
  /** a street rising more than this along itself is marked (rise / run) */
  stairs: number;
  /** smoothed ground steeper than this is a cliff (rise / run) */
  cliff: number;
  /** the town's radius (world units) round its centre */
  townR: number;
  /** (m3a) the smooth min's blend width, a point's radius and strength (each × its intensity), how many auto points */
  blend: number;
  pointR: number;
  strength: number;
  autoPts: number;
  /** (m3b) index into CROSS */
  cross: number;
  /** (m3c) index into SHAPES; the terraces' band height (cells); the carts' steepest grade (rise / run) */
  shape: number;
  band: number;
  grade: number;
  /** (m3d) bad cells: index into BAD */
  bad: number;
  /** (m3e) landmark sites at the busy junctions: their radius × (0 none), the cross streets that make a junction busy,
   *  index into LANDMARKS, the smallest and largest radius */
  lmMult: number;
  lmN: number;
  lmKind: number;
  lmRmin: number;
  lmRmax: number;
  /** (m3f) the town's empty land partitioned into blocks (1 on); a block this big (cells²) gets roads at its first
   *  two splits (0 none) */
  gap: number;
  bigBlock: number;
  /** (m3g) the field: index into FIELDS; the mask's smoothing radius (cells); grown streets (1) or paired (0); the
   *  landmark sites kept (the top K) */
  field: number;
  maskR: number;
  grown: number;
  lmTopK: number;
  /** (m3h) supercells: on (1); their size (block lengths); the limit (× the town's radius) and its noise
   *  (supercells); the empty fraction; the seed; the growth (0–1); the district tint (1) */
  city: number;
  scSize: number;
  limit: number;
  limitNoise: number;
  emptyFrac: number;
  citySeed: number;
  growth: number;
  tint: number;
}
/** (m3g) how the distance field is made smooth: the distance blurred (m2 to m3f: uneven contours at the creases), or
 *  the water/cliff mask blurred and thresholded first (a true distance) */
export const FIELDS = ['distance blurred (old)', 'mask blurred'] as const;
/** (m3e) what a landmark site holds */
export const LANDMARKS = ['plaza', 'big structure'] as const;
/** (m3d) what a bad cell (a sliver, a thin triangle) becomes: merged into its neighbour, or paved */
export const BAD = ['merge', 'plaza', 'leave (as m3)'] as const;
/** (m3c) shaping the steep ground — the lab's heights only: terraces, or a cart road (a spiral ramp, switchbacks) */
export const SHAPES = ['none', 'terraces', 'spiral ramp', 'switchbacks'] as const;

/** the stages a run can start at: a change reruns its stage and the ones after */
export const STAGES = ['field', 'phi', 'trace', 'lots', 'mesh'] as const;
export type Stage = (typeof STAGES)[number];
/** a column box [x0, y0, x1, y1) */
export type Box = [number, number, number, number];

/** (M4b) the roads' colours by tone (rgb 0–1): dirt and stone, a little lighter than the ground's (world/materials.ts
 *  soil 0.45 0.36 0.27, stone 0.4 0.39 0.37) — the sun lights them as it lights the ground */
const ROAD_TONES: Record<number, [number, number, number]> = { 1: [0.62, 0.53, 0.42], 2: [0.6, 0.58, 0.54] };

/** (M4b) the town's own inputs to its population field: its peak density (by its size; 0 the field off — the lab's
 *  default: 0.5 everywhere) and its purpose (POP_PURPOSE; −1 none) */
export interface TownInputs {
  density: number;
  purpose: number;
}
/** a settlement's purpose → the district purpose it weights (streets.wgsl P_*: 0 homes, 1 market, 2 harbour, 3
 *  workshops, 4 farms, 5 keep) */
export const POP_PURPOSE: Record<string, number> = { trading: 1, port: 2, mining: 3, lumber: 3, farming: 4, hold: 5 };

/** the window's columns: the grid's column (x, y) is window column (x + box[0], y + box[1]) — box[1] even; heights
 *  in window z */
export interface WindowGround {
  kind: 'window';
  box: [number, number];
  globals: GPUBuffer;
  chunks: GPUBuffer;
  layers: GPUBuffer;
  water: GPUBuffer;
}
/** (M4b) the atlas's raw ground over the grid (Atlas.rawGroundGpu's layout: 64 × 64 tiles), heights in world z; the
 *  sea's level (world z) */
export interface RawGround {
  kind: 'raw';
  raw: GPUBuffer;
  sea: number;
}

/** what the town generator needs of the world: its grid — a box of the window, w columns by h rows from window column
 *  box[0], row box[1] (even: a row's hex offset is the window's) — and the world's buffers it reads there */
export interface StreetWorld {
  w: number;
  h: number;
  /** where its ground comes from: a box of the window's columns (the lab's), or the atlas's raw ground over the whole
   *  grid (the game's: Atlas.rawGroundGpu — the box needn't be in the window) */
  ground: WindowGround | RawGround;
  /** (M4b) its population field's inputs; none: the field off */
  town?: TownInputs;
  /** (M4b) where its claim grid is written (a slot of the static claims' arena); none: its own buffer */
  claimInto?: GPUBufferBinding;
  /** (M4b) its mesh's room (vertices; VERT_ROOM by default) */
  vertRoom?: number;
  /** (time-lapse) its districts at the start: all built (the lab's, the default) or only the core (a game town's) */
  built?: 'all' | 'core';
  /** the town's centre (the grid's world units: its first column's corner at 0, 0) */
  centre: [number, number];
}

/** a run: where it started, GPU ms of each stage it ran (null: not run, or no timestamp-query), the total, counts */
export interface StreetTimes {
  from: Stage;
  /** φ's box, when the run reran φ over one point's radius only */
  box: Box | null;
  height: number | null;
  stage: Record<Stage, number | null>;
  total: number | null;
  lots: number;
  verts: number;
}

const SLOT = 512;
const MAX_PASSES = 256;
const UNI_BYTES = 304;
const KERNELS = [
  'fill', 'blur', 'feat', 'jfa', 'jdist', 'autoPts', 'phi', 'tensor', 'trace', 'mis', 'blocks',
  'vseed', 'vthin', 'vrast', 'vjfa', 'vseg', 'vblock', 'lots', 'roadMajor', 'roadMinor', 'vroad', 'lotRec', 'lotMesh', 'marks', 'meshCap',
  'shape', 'roadShape', 'ground', 'bqual', 'bclaim', 'bapply', 'vnext', 'jstat', 'lmlist', 'lmprune', 'vclip', 'lmMesh', 'gcov', 'gmask', 'glabel', 'gacc', 'gnode', 'gsplit', 'gleaf', 'groad', 'mseed', 'ginit', 'gmarch', 'gclaim', 'gkeep', 'gplace', 'sctab', 'bgrow', 'ctint',
  'artSpan', 'artRast', 'artEnd', 'artMesh', 'popField', 'townBridge', 'claimRoads', 'claimLots', 'lotReach', 'deckSpans',
  'clkInit', 'clkTimelapse', 'clkClaim', 'tlProgress', 'tlRise',
] as const;
type Kernel = (typeof KERNELS)[number];
/** streets.wgsl TRW, BQW, LW, SDW (words a trace, a block, a lot, a seed) */
const TRW = 144;
const BQW = 12;
const LW = 10;
const SDW = 12;
/** the shortest block length the buffers have room for (the seed lattice half of it) */
export const MIN_BLOCK = 8;
/** room: lots, vertices (32 bytes each) */
const LOT_ROOM = 32768;
/** (M4a) streets.wgsl RECW, REC_LM: a lot record's words; the landmark sites' records from this one (LOT_ROOM); the
 *  sites' room (LM_ROOM) — api/contracts/citygen.ts */
export const RECW = 24;
export const REC_LM = LOT_ROOM;
export const LM_ROOM = 64;
const VERT_ROOM = 1_200_000;
/** (M4b) a game town's mesh room (vertices): Muru makes ~31 000, a city more — the lab keeps VERT_ROOM for its sliders */
export const TOWN_VERT_ROOM = 160_000;
/** conflict rounds between the traces (a greedy independent set: even, so the kept end in AL0) */
const MIS_ROUNDS = 4;
/** (m3d) merge rounds for the bad blocks */
const MERGE_ROUNDS = 3;
const NONE = 0xffffffff;
/** (m3f) streets.wgsl TILE, NODEW, GAP_LEVELS, ROAD_ROOM, GAP_ROOM; rounds of the gap regions' labelling */
const TILE = 4;
const NODEW = 12;
const GAP_LEVELS = 3;
const ROAD_ROOM = 1024;
const GAP_ROOM = 512;
const LABEL_ROUNDS = 12;
/** (m3g) lines the grown streets climb (a step each: march, grid, keep) */
const GROW_LINES = 8;
/** (m3i) the town circle's reach with supercells (× its radius): past the largest limit (1.2) and its noise */
const CITY_REACH = 1.6;
const ALL = ['height', ...STAGES] as const;
/** (time-lapse) a lot's build time on the town's clock (s); each lot starts up to 3/4 of it after its district */
export const BUILD_S = 4;
/** (M4a) streets.wgsl NART, NAP, AP, AW: the arterials (approach roads) a town has room for, the points each, where
 *  its points start in its words, its words */
export const NART = 8;
export const NAP = 128;
const AP = 20;
const AW = AP + 2 * NAP;

interface Uni {
  k?: number;
  mode?: number;
  count?: number;
  /** a boxed pass's first column */
  box?: [number, number];
}
type Bufs = Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, GPUBuffer | GPUBufferBinding>>;

export class CityGen {
  readonly verts: GPUBuffer;
  readonly args: GPUBuffer;
  /** (M4a, the contract: api/contracts/citygen.ts) the lot records, their counts, each one's construction progress */
  readonly lotRecords: GPUBuffer;
  readonly lotCounts: GPUBuffer;
  readonly progress: GPUBuffer;
  /** (M4b) the town's claim grid (colapply claimGrid's layout, dense: w × h columns, a span each) and its columns;
   *  per lot record 1 when it's cut off from the town's reach (lotReach) */
  readonly claimGrid: GPUBuffer | GPUBufferBinding;
  readonly claimCols: number;
  readonly reachCut: GPUBuffer;
  private pipes: Record<Kernel, GPUComputePipeline>;
  private layout: GPUBindGroupLayout;
  private heightK: ComputeKernel;
  private boxUni: GPUBuffer;
  private uni: GPUBuffer;
  private uniData = new ArrayBuffer(SLOT * MAX_PASSES);
  private nPass = 0;
  /** (scripts: its buffers by name, to read back while debugging — never read by the game) */
  readonly B: Record<string, GPUBuffer> = {};
  private dummies: GPUBuffer[];
  private qs?: GPUQuerySet;
  private qRes?: GPUBuffer;
  private qRead: GPUBuffer;
  private haveHeights = false;
  private busy: Promise<unknown> = Promise.resolve();
  private dead = false;
  private all: GPUBuffer[] = [];
  private p!: StreetParams;
  private town: TownInputs;
  private builtMode = 0;
  private claimRead: GPUBuffer;
  /** (time-lapse) the town's clock (s) and the last time-lapse's start and spread */
  private tl = { now: 0, t0: 0, span: 0 };
  private vertRoom: number;
  /** (M4b) the bytes of its GPU buffers (a town's memory) */
  get bytes(): number {
    return this.all.reduce((s, b) => s + b.size, 0);
  }
  private cp!: GPUComputePassEncoder;
  private seeds: [number, number] = [0, 0];
  private sel = -1;
  private placed = '';
  private resets = 0;
  /** the points as the last run left them */
  points: StreetPoint[] = [];
  /** the last run's dispatches */
  dispatches = 0;

  constructor(
    private device: GPUDevice,
    private world: StreetWorld,
  ) {
    const { w, h } = world;
    const N = w * h;
    this.town = world.town ?? { density: 0, purpose: -1 };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (label: string, bytes: number, usage = S) => {
      const b = device.createBuffer({ label: `citygen ${label}`, size: Math.max(16, bytes), usage });
      this.all.push(b);
      return b;
    };
    this.uni = buf('passes', SLOT * MAX_PASSES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    for (const n of ['H', 'HT', 'M', 'HS', 'TB', 'T0', 'FDB', 'FD', 'S0', 'S1', 'BLK', 'TX', 'TY', 'AD']) this.B[n] = buf(n, N * 4);
    const [mx, my] = this.lattice(MIN_BLOCK);
    const T = mx * my;
    this.B.TR = buf('traces', T * TRW * 4);
    // (seed-indexed: room for the grown streets' landings too — m3g, twice the lattice)
    this.B.AL0 = buf('kept a', 2 * T * 4);
    this.B.AL1 = buf('kept b', 2 * T * 4);
    this.B.BQ = buf('blocks', 3 * 2 * T * BQW * 4);
    this.B.LOTS = buf('lots', LOT_ROOM * LW * 4);
    // (M4a: the lot records and their construction progress (f32 0–1, 1 when the lots are made), the counts — lots,
    // sites, words a record, the sites' first record)
    this.lotRecords = buf('lot records', (LOT_ROOM + LM_ROOM) * RECW * 4);
    this.progress = buf('lot progress', (LOT_ROOM + LM_ROOM) * 4);
    this.lotCounts = buf('lot counts', 16);
    // (M4b: the roads' columns as drawn, the claim grid, the records cut off)
    this.B.ROADS = buf('road columns', N * 4);
    this.claimCols = N;
    // (the claim grid written where its owner says — a slot of the static claims' arena — or its own)
    this.claimGrid = world.claimInto ? { ...world.claimInto, size: N * 8 * 4 } : buf('claim grid', N * 8 * 4);
    if (world.claimInto && (world.claimInto.size ?? 0) < N * 8 * 4) throw new Error(`citygen: a ${w} x ${h} claim grid is past its slot`);
    this.reachCut = buf('reach cut', (LOT_ROOM + LM_ROOM) * 4);
    device.queue.writeBuffer(this.lotCounts, 0, new Uint32Array([0, 0, RECW, REC_LM]));
    // (the lots' count, the listed roads' and the gap blocks', then the roads: m3f)
    this.B.CNT = buf('counts and roads', (4 + ROAD_ROOM * 4) * 4);
    // (m3: the points, the seeds, their occupancy grid, the two floods ping-ponged; AL1 the streets drawn)
    this.B.PTS = buf('points', NPTS * PW * 4);
    this.B.SD = buf('seeds', 2 * T * SDW * 4);
    this.B.GG = buf('landing grid', this.ggWords(MIN_BLOCK) * 4);
    this.B.GCNT = buf('grown count', 16);
    this.B.OCC = buf('occupancy', this.occWords(MIN_BLOCK) * 4);
    for (const n of ['JE0', 'JE1', 'JO0', 'JO1']) this.B[n] = buf(n, N * 4);
    // (m3e: the cross streets ending at each seed and their smallest angle there; the landmark sites — a count, then
    // 64 of x, y, r, kind)
    this.B.JC = buf('junctions', 2 * 2 * T * 4);
    this.B.LM = buf('landmarks', (1 + 64 * 5) * 4);
    // (m3f: the gap fill's tiles — coverage, labels ping-ponged, heap indices — its region nodes and its blocks)
    const G = this.tiles();
    for (const n of ['GC', 'GL0', 'GL1', 'GS']) this.B[n] = buf(n, G * 4);
    this.B.NODE = buf('gap nodes', G * 16 * NODEW * 4);
    this.B.GB = buf('gap blocks', GAP_ROOM * 3 * BQW * 4);
    // (m3h: the supercells' table — at the smallest supercell, 8 cells)
    this.B.SCT = buf('supercells', (4 + this.scCells(8) * 9) * 4);
    // (time-lapse: a tag and the made z a vertex — tlRise moves the tagged ones; a claim's answer)
    this.B.VTAG = buf('vertex tags', (world.vertRoom ?? VERT_ROOM) * 8);
    this.B.CLAIM = buf('claim answer', 16);
    this.claimRead = buf('claim read', 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.builtMode = world.built === 'core' ? 1 : 0;
    // (M4b: the population field — density, wealth, purpose, the arterials' distance — 4 words a column)
    this.B.POP = buf('population', N * 16);
    // (M4a: the arterials — a count, then each one's direction (the CPU's), length and bridge spans (the GPU's))
    this.B.ART = buf('arterials', (4 + NART * AW) * 4);
    this.boxUni = buf('box', 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const gs = world.ground;
    if (gs.kind === 'window') device.queue.writeBuffer(this.boxUni, 0, new Uint32Array([gs.box[0], gs.box[1], w, h]));
    else {
      if (w % 64 || h % 64) throw new Error(`citygen: a raw-ground grid is whole 64-column tiles (${w} x ${h})`);
      const a = new ArrayBuffer(32);
      new Uint32Array(a).set([w, h, w / 64, 0]);
      new Float32Array(a)[4] = gs.sea;
      device.queue.writeBuffer(this.boxUni, 0, a);
    }
    this.vertRoom = world.vertRoom ?? VERT_ROOM;
    this.verts = buf('mesh', this.vertRoom * 32, GPUBufferUsage.STORAGE);
    this.args = buf('mesh args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    device.queue.writeBuffer(this.args, 0, new Uint32Array([0, 1, 0, 0]));
    this.dummies = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => buf(`dummy ${k}`, 16));
    this.layout = makeLayout(device, 'citygen', { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' }, GPUShaderStage.COMPUTE);
    const module = makeModule(device, 'citygen', [streetsWgsl]);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipes = Object.fromEntries(KERNELS.map((k) => [k, device.createComputePipeline({ label: `citygen ${k}`, layout: pl, compute: { module, entryPoint: k } })])) as Record<Kernel, GPUComputePipeline>;
    if (gs.kind === 'window' && gs.box[1] % 2) throw new Error(`citygen: the box's first row (${gs.box[1]}) must be even`);
    this.heightK =
      gs.kind === 'window'
        ? makeCompute(device, 'citygen height', [commonWgsl, layersWgsl, materialsWgsl, heightWgsl], { 0: 'uniform', 1: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'uniform' })
        : makeCompute(device, 'citygen raw height', [rawHeightWgsl], { 0: 'uniform', 1: 'read', 2: 'rw', 3: 'rw' });
    const n = ALL.length * 2;
    if (device.features.has('timestamp-query')) {
      this.qs = device.createQuerySet({ type: 'timestamp', count: n });
      this.qRes = buf('stamps', n * 8, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
    }
    // (the stamps, then the lots' count and the vertices', then the points)
    this.qRead = buf('stamps read', n * 8 + 16 + NPTS * PW * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  }

  /** the seed lattice for a block length: spacing half of it, across and down the window */
  private lattice(blockLen: number): [number, number] {
    const sp = blockLen / 2;
    return [Math.ceil((this.world.w + 0.5) / sp), Math.ceil((this.world.h * ROW_H) / sp)];
  }
  /** (m3f) the gap fill's tiles (streets.wgsl gDims, TILE) */
  private tiles(): number {
    return (Math.floor(this.world.w / TILE) + 1) * (Math.floor((this.world.h * ROW_H) / TILE) + 1);
  }
  /** the occupancy grid's words for a block length (streets.wgsl occDims, four line layers) */
  private occWords(bl: number): number {
    return (Math.floor(this.world.w / bl) + 2) * (Math.floor((this.world.h * ROW_H) / bl) + 2) * 4;
  }

  /** (m3a, a tap: an authored edit) a point's slot written — position, intensity, flag; the next run from 'phi' */
  setPoint(slot: number, x: number, y: number, intensity: number, flag: number): void {
    const a = new ArrayBuffer(PW * 4);
    const f = new Float32Array(a);
    f[0] = x;
    f[1] = y;
    f[2] = intensity;
    new Uint32Array(a)[4] = flag;
    this.device.queue.writeBuffer(this.B.PTS, slot * PW * 4, a);
  }
  /** (M4a, the town's input) its approach roads: each a polyline from the centre's end outward (the grid's world
   *  units; at most NART of NAP points) — the game's the atlas roads into the town, the lab's test spokes — and the core
   *  they're drawn to at least (the game's: where the atlas's stamps were cleared). Their length in the grid, bridges and
   *  end at the town's limit are made on the GPU; the next run from 'field' */
  setArterials(core: number, lines: readonly (readonly (readonly [number, number])[])[]): void {
    if (lines.length > NART) throw new Error(`citygen: ${lines.length} approach roads, room for ${NART}`);
    const a = new ArrayBuffer((4 + NART * AW) * 4);
    const u = new Uint32Array(a);
    const f = new Float32Array(a);
    u[0] = lines.length;
    // (drawn at least this far from the centre — past it the atlas's stamped road carries on; 0 none)
    f[1] = core;
    lines.forEach((pts, k) => {
      if (pts.length > NAP) throw new Error(`citygen: an approach road of ${pts.length} points, room for ${NAP}`);
      const o = 4 + k * AW;
      u[o] = pts.length;
      pts.forEach(([x, y], j) => {
        f[o + AP + 2 * j] = x;
        f[o + AP + 2 * j + 1] = y;
      });
    });
    this.device.queue.writeBuffer(this.B.ART, 0, a);
  }
  /**
   * (M4b) Which buildings the town's reach cuts off: the reach's marks over the window (FortressReachGpu.reachMark: a
   * word a window column, 2 a surface it didn't join), the grid's first column at window column (gx, gy) — into
   * reachCut, then the mesh again (a red line round each one's roof). Nothing read back.
   */
  markReach(marks: GPUBuffer, gx: number, gy: number, winW: number, winH: number): Promise<StreetTimes> {
    this.reachJob = { marks, gx, gy, winW, winH };
    return this.run(this.p, 'mesh');
  }
  private reachJob: { marks: GPUBuffer; gx: number; gy: number; winW: number; winH: number } | null = null;

  /**
   * (M4b) The town's decks as a reach's plan solid (FortressReachGpu.planSpans: two words a window column, cleared
   * first): the grid's first column at window column (gx, gy), window z = world z + gz. One submit, nothing read.
   */
  deckSpans(spans: GPUBuffer, gx: number, gy: number, gz: number, winW: number, winH: number): void {
    if (this.dead) return;
    this.nPass = 0;
    const enc = this.device.createCommandEncoder({ label: 'citygen deck spans' });
    enc.clearBuffer(spans);
    this.cp = enc.beginComputePass({ label: 'citygen deck spans' });
    const gzBits = new Uint32Array(new Float32Array([gz]).buffer)[0];
    this.k('deckSpans', { count: gzBits, k: winW, mode: winH, box: [gx >>> 0, gy >>> 0] }, { 1: this.B.ROADS, 5: spans }, Math.ceil(this.world.w / 8), Math.ceil(this.world.h / 8));
    this.cp.end();
    this.device.queue.writeBuffer(this.uni, 0, this.uniData, 0, this.nPass * SLOT);
    this.device.queue.submit([enc.finish()]);
  }
  /**
   * (time-lapse) The town's clock now (s): each lot's progress from its district's start, the buildings risen, the roads
   * and parks of districts begun shown — one submit, nothing read back, no mesh made again.
   */
  animate(now: number): void {
    if (this.dead || !this.p) return;
    this.tl.now = now;
    this.encodeOnly('citygen animate', () => {
      const B = this.B;
      this.k('tlProgress', {}, { 1: this.lotRecords, 4: B.SCT, 5: this.progress, 6: B.CNT }, Math.ceil((LOT_ROOM + LM_ROOM) / 64));
      this.k('tlRise', {}, { 1: this.lotRecords, 2: this.progress, 3: B.VTAG, 4: B.SCT, 7: this.verts }, Math.ceil(this.vertRoom / 64), 1, true);
    });
  }

  /** (time-lapse) every district not begun starts at t0 + its growth key × span (the centre first); then animate */
  timelapse(t0: number, span: number, now: number): void {
    if (this.dead || !this.p) return;
    this.tl = { now, t0, span };
    this.encodeOnly('citygen time-lapse', () => this.k('clkTimelapse', {}, { 5: this.B.SCT }, 1));
    this.animate(now);
  }

  private claimBusy: Promise<unknown> = Promise.resolve();
  /**
   * (M4d hook) An opportunity's district: the best one not begun for `purpose` (streets.wgsl P_*: 0 homes, 1 market, 2
   * harbour, 3 workshops, 4 farms, 5 keep) picked on the GPU and started now — its id read back (a word); −1 none left.
   */
  claimDistrict(purpose: number, now: number): Promise<number> {
    const r = this.claimBusy.then(async () => {
      if (this.dead || !this.p) return -1;
      this.tl.now = now;
      this.encodeOnly('citygen claim', () => this.k('clkClaim', { mode: purpose }, { 5: this.B.SCT, 7: this.B.CLAIM }, 1), (enc) =>
        enc.copyBufferToBuffer(this.B.CLAIM, 0, this.claimRead, 0, 4),
      );
      await this.claimRead.mapAsync(GPUMapMode.READ);
      const id = new Uint32Array(this.claimRead.getMappedRange().slice(0))[0] - 1;
      this.claimRead.unmap();
      this.animate(now);
      return id;
    });
    this.claimBusy = r.catch(() => undefined);
    return r;
  }

  /** one compute pass of `f`'s dispatches (their uniforms with the run's parameters) and `after` on the encoder */
  private encodeOnly(label: string, f: () => void, after?: (enc: GPUCommandEncoder) => void): void {
    this.nPass = 0;
    const enc = this.device.createCommandEncoder({ label });
    this.cp = enc.beginComputePass({ label });
    f();
    this.cp.end();
    after?.(enc);
    this.device.queue.writeBuffer(this.uni, 0, this.uniData, 0, this.nPass * SLOT);
    this.device.queue.submit([enc.finish()]);
  }

  /** every slot handed back to the GPU's placing (the user's emptied) */
  resetPoints(): void {
    this.device.queue.writeBuffer(this.B.PTS, 0, new Uint32Array(NPTS * PW));
    this.resets++;
  }
  /** the selected point's marker drawn gold (-1 none; the mesh's next run) */
  select(slot: number): void {
    this.sel = slot;
  }

  dispose(): void {
    this.dead = true;
    this.qs?.destroy();
    for (const b of this.all) b.destroy();
  }

  /** run from `from` (runs queue: one at a time); φ over `box` only when given (a point's change) */
  run(p: StreetParams, from: Stage, box?: Box): Promise<StreetTimes> {
    const r = this.busy.then(() => this.once(p, from, box));
    this.busy = r.catch(() => undefined);
    return r;
  }

  private slot(u: Uni): number {
    if (this.nPass >= MAX_PASSES) throw new Error(`citygen: more than ${MAX_PASSES} passes in a run`);
    const i = this.nPass++;
    const dv = new DataView(this.uniData, i * SLOT, UNI_BYTES);
    const p = this.p;
    const { w, h, centre } = this.world;
    const spokes = Math.max(6, Math.round((Math.PI * p.townR) / (2 * p.ringSpacing)));
    [w, h, u.k ?? 0, u.mode ?? 0, u.count ?? 0, this.vertRoom, families(p.majors, p.cross), this.seeds[0]].forEach((v, j) => dv.setUint32(j * 4, v >>> 0, true));
    const f = [
      p.majorSpacing, p.ringSpacing, spokes, p.blockLen,
      p.majorWidth, p.minorWidth, p.setback, p.height,
      p.maxLot, p.minLot, p.cliff, this.seeds[1],
      centre[0], centre[1], p.townR, p.stairs,
      p.blend, p.pointR, p.strength, p.autoPts,
    ];
    f.forEach((v, j) => dv.setFloat32(32 + j * 4, v, true));
    [u.box?.[0] ?? 0, u.box?.[1] ?? 0, PHI_MODE[p.majors], p.cross].forEach((v, j) => dv.setUint32(112 + j * 4, v >>> 0, true));
    [p.band, p.grade, p.shape, this.sel + 1].forEach((v, j) => dv.setFloat32(128 + j * 4, v, true));
    [p.bad, p.lmMult, p.lmN, p.lmKind].forEach((v, j) => dv.setFloat32(144 + j * 4, v, true));
    [p.lmRmin, p.lmRmax, p.bigBlock, p.gap].forEach((v, j) => dv.setFloat32(160 + j * 4, v, true));
    [p.field, p.maskR, p.cross === 0 && p.grown === 1 ? 1 : 0, p.lmTopK].forEach((v, j) => dv.setFloat32(176 + j * 4, v, true));
    [p.scSize, p.limitNoise, p.emptyFrac, p.citySeed].forEach((v, j) => dv.setFloat32(192 + j * 4, v, true));
    [p.growth, p.tint, this.cityOn() ? 1 : 0, p.limit].forEach((v, j) => dv.setFloat32(208 + j * 4, v, true));
    // (m3i: with supercells the town circle is only a bound, out past any limit)
    [this.cityOn() ? CITY_REACH : 1, 0, 0, 0].forEach((v, j) => dv.setFloat32(224 + j * 4, v, true));
    [p.artWidth, p.hRatio, p.deckClear, p.maxSpan].forEach((v, j) => dv.setFloat32(240 + j * 4, v, true));
    [...(ROAD_TONES[p.roadTone] ?? [0, 0, 0]), p.roadTone].forEach((v, j) => dv.setFloat32(256 + j * 4, v, true));
    [this.town.density, this.town.purpose, 0, 0].forEach((v, j) => dv.setFloat32(272 + j * 4, v, true));
    [this.tl.now, BUILD_S, this.tl.t0, this.tl.span].forEach((v, j) => dv.setFloat32(288 + j * 4, v, true));
    return i;
  }

  private k(name: Kernel, u: Uni, bufs: Bufs, wx: number, wy = 1, args = false): void {
    const i = this.slot(u);
    const entries: Record<number, GPUBuffer | GPUBufferBinding> = { 0: { buffer: this.uni, offset: i * SLOT, size: UNI_BYTES }, 8: args ? this.args : this.dummies[7] };
    for (let b = 1; b <= 7; b++) entries[b] = bufs[b as 1] ?? this.dummies[b - 1];
    this.cp.setPipeline(this.pipes[name]);
    this.cp.setBindGroup(0, makeBindGroup(this.device, `citygen ${name}`, this.layout, entries));
    this.cp.dispatchWorkgroups(Math.max(1, wx), Math.max(1, wy));
    this.dispatches++;
  }
  /** one thread a column (over `box` when given) */
  private k2(name: Kernel, u: Uni, bufs: Bufs, args = false, box?: Box): void {
    if (box) return this.k(name, { ...u, box: [box[0], box[1]] }, bufs, Math.ceil((box[2] - box[0]) / 8), Math.ceil((box[3] - box[1]) / 8), args);
    this.k(name, u, bufs, Math.ceil(this.world.w / 8), Math.ceil(this.world.h / 8), args);
  }
  /** one thread a seed (its trace, its block) */
  private kT(name: Kernel, u: Uni, bufs: Bufs, args = false): void {
    this.k(name, u, bufs, Math.ceil((this.seeds[0] * this.seeds[1]) / 64), 1, args);
  }
  private fill(dst: GPUBuffer, count: number, value: number, offset = 0): void {
    this.k('fill', { count, k: value, box: [offset, 0] }, { 5: dst }, Math.ceil(count / 64));
  }
  /** a jump flood of `src`'s seeds through `tmp`: the buffer that holds it */
  private jfa(src: GPUBuffer, tmp: GPUBuffer): GPUBuffer {
    let a = src;
    let b = tmp;
    let k = 1;
    while (k * 2 < Math.max(this.world.w, this.world.h)) k *= 2;
    for (; k >= 1; k >>= 1) {
      this.k2('jfa', { k }, { 1: a, 5: b });
      [a, b] = [b, a];
    }
    // (one more at step 1: JFA+1)
    this.k2('jfa', { k: 1 }, { 1: a, 5: b });
    return b;
  }
  private blur(src: GPUBuffer, dst: GPUBuffer, r: number, times: number): void {
    for (let t = 0; t < times; t++) {
      this.k2('blur', { k: r, mode: 0 }, { 1: t ? dst : src, 5: this.B.TB });
      this.k2('blur', { k: r, mode: 1 }, { 1: this.B.TB, 5: dst });
    }
  }
  private pass(stage: (typeof ALL)[number]): GPUComputePassDescriptor {
    const s = ALL.indexOf(stage) * 2;
    return { label: `citygen ${stage}`, timestampWrites: this.qs ? { querySet: this.qs, beginningOfPassWriteIndex: s, endOfPassWriteIndex: s + 1 } : undefined };
  }
  /** (m3b) the vector jump floods: the seeds on the lines, thinned, flooded by line parity; each seed's cross street and
   *  the block to the next one along its line. (m3g) Grown: the streets grown up from line 0 a line at a time instead
   *  of paired across each strip */
  private vectorCross(): void {
    const B = this.B;
    const N = this.world.w * this.world.h;
    const p = this.p;
    const grown = p.grown === 1;
    const S = this.nS();
    const bl = Math.max(MIN_BLOCK, p.blockLen);
    this.fill(B.OCC, this.occWords(bl), NONE);
    this.kT('vseed', {}, { 4: B.FD, 5: B.SD, 6: B.OCC });
    this.kT('vthin', {}, { 2: B.OCC, 5: B.SD });
    if (grown) {
      // (a line a step: its live seeds marched to the next line, the landings too near each other stopped, the dormant
      // seeds where none landed woken)
      this.kS('ginit', {}, { 5: B.SD });
      this.fill(B.GCNT, 4, 0);
      const gg = this.ggWords(bl);
      for (let k = 0; k < GROW_LINES; k++) {
        this.kS('gmarch', { k }, { 4: B.FD, 5: B.SD });
        this.k('gplace', { k }, { 5: B.SD, 6: B.GCNT }, 1);
        this.fill(B.GG, gg, NONE);
        this.kS('gclaim', { k: k + 1 }, { 1: B.SD, 6: B.GG });
        this.kS('gkeep', { k: k + 1 }, { 2: B.GG, 5: B.SD });
      }
    }
    this.fill(B.JE0, N, NONE);
    this.fill(B.JO0, N, NONE);
    this.kS('vrast', {}, { 1: B.SD, 5: B.JE0, 7: B.JO0 });
    // (the floods only need to reach about a line spacing: the lookups are within that of a seed)
    const reach = p.majors < 3 ? p.majorSpacing : p.ringSpacing;
    let k = 1;
    while (k < reach) k *= 2;
    let [ea, oa, eb, ob] = [B.JE0, B.JO0, B.JE1, B.JO1];
    for (let s = k; s >= 1; s >>= 1) {
      this.k2('vjfa', { k: s }, { 1: ea, 2: oa, 3: B.SD, 5: eb, 7: ob });
      [ea, oa, eb, ob] = [eb, ob, ea, oa];
    }
    this.k2('vjfa', { k: 1 }, { 1: ea, 2: oa, 3: B.SD, 5: eb, 7: ob });
    if (!grown) this.kS('vseg', {}, { 2: eb, 3: ob, 4: B.FD, 5: B.SD });
    this.kS('vnext', {}, { 2: eb, 3: ob, 4: B.FD, 5: B.SD });
    // (m3e) the busy junctions: their streets counted and their smallest angle, a landmark site each (the top K, the
    // higher-scoring of two that overlap), every cross street clipped at the sites
    if (p.lmMult > 0) {
      this.fill(B.JC, S, 0);
      // (the angles start at 10 rad, as f32 bits: more than any angle)
      this.fill(B.JC, S, 0x41200000, S);
      this.kS('jstat', {}, { 1: B.SD, 6: B.JC });
      this.kS('lmlist', {}, { 1: B.SD, 2: B.JC, 6: B.LM });
      this.k('lmprune', {}, { 5: B.LM }, 1);
      this.kS('vclip', {}, { 2: B.LM, 5: B.SD });
    }
    this.kS('vblock', {}, { 1: B.SD, 5: B.BQ, 7: B.AL1 });
    // (m3h) the supercells: their centres, states and growth starts
    // (m3i: one workgroup — the cost distance relaxed over the supercell graph in its shared memory)
    if (this.cityOn()) this.k('sctab', {}, { 1: B.PTS, 2: B.LM, 3: B.HS, 4: B.FD, 5: B.SCT, 7: B.POP }, 1);
    // (time-lapse: every district's start — all built, or the core only)
    if (this.cityOn()) this.k('clkInit', { mode: this.builtMode }, { 5: B.SCT }, 1);
    // (M4a: where each arterial leaves the town's limit — the supercells' out; without them, its length)
    this.k('artEnd', {}, { 4: B.SCT, 5: B.ART }, 1);
    // (M4b: the town's own bridge where water splits it and no arterial crosses — after the town's limit is known)
    this.k('townBridge', {}, { 1: B.M, 2: B.FDB, 3: B.H, 4: B.SCT, 5: B.ART, 7: B.POP }, 1);
    // (m3d) the bad blocks: found, then merged (a claim each on a good neighbour, the lowest seed wins) or paved
    // (MERGE_ROUNDS rounds — a fan's triangles merge in pairs, then the pairs — then what's still bad is paved)
    for (let r = 0; r <= MERGE_ROUNDS; r++) {
      this.kS('bqual', { mode: 0 }, { 1: B.SD, 5: B.BQ });
      this.kS('bqual', { mode: r === MERGE_ROUNDS ? 2 : 1 }, { 1: B.SD, 5: B.BQ });
      if (r === MERGE_ROUNDS || p.bad !== 0) break;
      this.fill(B.AL0, S, NONE);
      this.kS('bclaim', {}, { 1: B.SD, 5: B.BQ, 6: B.AL0 });
      this.kS('bapply', {}, { 1: B.SD, 2: B.AL0, 5: B.BQ, 7: B.AL1 });
    }
  }
  /** (m3h) supercells on: the vector streets only */
  private cityOn(): boolean {
    return this.p.city === 1 && this.p.cross === 0;
  }
  /** (m3h) the supercells for a size (streets.wgsl sctab) */
  private scCells(sc: number): number {
    return (Math.floor(this.world.w / sc) + 1) * (Math.floor((this.world.h * ROW_H) / sc) + 1);
  }
  /** the seed slots this run (streets.wgsl nSeeds): the lattice's, twice that grown */
  private nS(): number {
    return this.seeds[0] * this.seeds[1] * (this.p.cross === 0 && this.p.grown === 1 ? 2 : 1);
  }
  private kS(name: Kernel, u: Uni, bufs: Bufs, args = false): void {
    this.k(name, u, bufs, Math.ceil(this.nS() / 64), 1, args);
  }
  /** (m3g) the grown streets' landing grid (streets.wgsl ggDims: cells 0.8 block lengths) */
  private ggWords(bl: number): number {
    const cs = 0.8 * bl;
    return (Math.floor(this.world.w / cs) + 2) * (Math.floor((this.world.h * ROW_H) / cs) + 2);
  }

  /** (m3f) the gap fill: the empty tiles labelled into regions, split recursively, the leaves blocks (GB) */
  private gapFill(): void {
    const B = this.B;
    const G = this.tiles();
    const kG = (name: Kernel, u: Uni, bufs: Bufs) => this.k(name, u, bufs, Math.ceil(G / 64));
    const kN = (name: Kernel, u: Uni, bufs: Bufs) => this.k(name, u, bufs, Math.ceil((G * 16) / 64));
    this.fill(B.GC, G, 0);
    this.fill(B.GS, G, 1);
    this.fill(B.NODE, G * 16 * NODEW, 0);
    this.fill(B.GB, GAP_ROOM * 3 * BQW, 0);
    this.k('gcov', {}, { 1: B.BQ, 5: B.GC }, Math.ceil((3 * this.nS()) / 64));
    kG('gmask', {}, { 1: B.GC, 2: B.LM, 4: B.FD, 5: B.GL0 });
    let [a, b] = [B.GL0, B.GL1];
    for (let r = 0; r < LABEL_ROUNDS; r++) {
      kG('glabel', {}, { 1: a, 5: b });
      [a, b] = [b, a];
    }
    for (let lv = 0; lv <= GAP_LEVELS; lv++) {
      kG('gacc', {}, { 1: a, 2: B.GS, 6: B.NODE });
      if (lv === GAP_LEVELS) break;
      kN('gnode', { k: lv }, { 4: B.FD, 5: B.NODE, 6: B.CNT });
      kG('gsplit', {}, { 1: a, 2: B.NODE, 5: B.GS });
    }
    kN('gleaf', {}, { 1: B.GC, 4: B.FD, 5: B.NODE, 6: B.CNT, 7: B.GB });
  }

  private async once(p: StreetParams, from0: Stage, box0?: Box): Promise<StreetTimes> {
    if (this.dead) throw new Error('citygen: disposed');
    this.p = p;
    this.nPass = 0;
    this.dispatches = 0;
    const { device } = this;
    const { w, h } = this.world;
    const B = this.B;
    const enc = device.createCommandEncoder({ label: 'citygen run' });
    const firstHeights = !this.haveHeights;
    // (the first run makes everything; a new block length a new seed lattice)
    const from: Stage = firstHeights ? 'field' : from0;
    const box = from === 'phi' && box0 ? clip(box0, w, h) : null;
    this.seeds = this.lattice(Math.max(MIN_BLOCK, p.blockLen));
    const runs = (s: Stage) => STAGES.indexOf(s) >= STAGES.indexOf(from);
    const vector = p.cross === 0;
    // (m3c: the heights the lab uses — terraced, or the ground's own)
    const HH = p.shape === 1 ? B.HT : B.H;
    // the ground's heights and the water, once (the land doesn't change yet: later, on dirty chunks only)
    if (firstHeights) {
      const cp = enc.beginComputePass(this.pass('height'));
      const G = this.world.ground;
      cp.setPipeline(this.heightK.pipeline);
      cp.setBindGroup(
        0,
        G.kind === 'window'
          ? makeBindGroup(device, 'citygen height', this.heightK.layout, { 0: G.globals, 1: G.chunks, 3: G.layers, 4: G.water, 5: B.H, 6: B.M, 7: this.boxUni })
          : makeBindGroup(device, 'citygen raw height', this.heightK.layout, { 0: this.boxUni, 1: G.raw, 2: B.H, 3: B.M }),
      );
      cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      cp.end();
      this.haveHeights = true;
    }
    // large: smoothed heights, the blocked mask, the smoothed distance to water and cliffs
    if (runs('field')) {
      this.cp = enc.beginComputePass(this.pass('field'));
      if (p.shape === 1) this.k2('shape', {}, { 1: B.H, 5: B.HT });
      this.blur(HH, B.HS, 2, 2);
      this.k2('feat', {}, { 1: B.HS, 2: B.M, 5: B.S0, 7: B.BLK });
      // (m3g: the mask smoothed and thresholded — the flood's seeds — so the distance stays a distance)
      if (p.field === 1) {
        this.blur(B.BLK, B.T0, Math.max(1, Math.round(p.maskR)), 2);
        this.k2('mseed', {}, { 1: B.T0, 5: B.S0 });
      }
      const fr = this.jfa(B.S0, B.S1);
      this.k2('jdist', {}, { 1: fr, 5: p.field === 1 ? B.FDB : B.T0 });
      if (p.field === 0) this.blur(B.T0, B.FDB, 5, 3);
      // (M4a: the arterials — their length and bridges, then the distance to them: their columns flooded)
      this.k('artSpan', {}, { 1: B.M, 3: B.H, 5: B.ART }, 1);
      this.fill(B.S0, w * h, NONE);
      this.k('artRast', {}, { 1: B.ART, 5: B.S0 }, (NART * NAP) / 64);
      this.k2('jdist', {}, { 1: this.jfa(B.S0, B.S1), 5: B.AD });
      // (M4b: the population field over the grid)
      this.k2('popField', {}, { 1: B.HS, 2: B.FDB, 3: B.AD, 4: B.M, 5: B.POP });
      this.cp.end();
    }
    // (m3a) the points (placed, their offsets) and φ — over a changed point's box only, when that's all that changed
    if (runs('phi')) {
      this.cp = enc.beginComputePass(this.pass('phi'));
      // (the auto points placed again only when what they're placed from changed — the field, their radius, the town,
      // their count, a reset; otherwise they stay and only the offsets are made again)
      const key = `${p.pointR},${p.townR},${p.autoPts},${this.resets}`;
      const place = runs('field') || key !== this.placed;
      this.placed = key;
      this.k('autoPts', { mode: place ? 0 : 1 }, { 1: B.HS, 2: B.FDB, 3: B.BLK, 5: B.PTS }, 1);
      this.k2('phi', {}, { 1: B.FDB, 2: B.BLK, 3: B.PTS, 5: B.FD }, false, box ?? undefined);
      // (the tensor field the traces follow: its gradients a column either side, so one wider)
      if (!vector) this.k2('tensor', {}, { 4: B.FD, 5: B.TX, 7: B.TY }, false, box ? clip([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1], w, h) : undefined);
      this.cp.end();
    }
    // medium: the cross streets, the blocks
    if (runs('trace')) {
      this.cp = enc.beginComputePass(this.pass('trace'));
      this.fill(B.LM, 1, 0);
      if (vector) this.vectorCross();
      else {
        this.kT('trace', {}, { 1: B.TX, 2: B.TY, 4: B.FD, 5: B.TR, 7: B.AL0 });
        for (let r = 0; r < MIS_ROUNDS; r++) {
          const [a, b] = r % 2 ? [B.AL1, B.AL0] : [B.AL0, B.AL1];
          this.kT('mis', {}, { 1: B.TR, 2: a, 5: b });
        }
        this.kT('blocks', {}, { 1: B.TR, 2: B.AL0, 4: B.FD, 5: B.BQ });
      }
      this.cp.end();
    }
    // fine: the lots
    if (runs('lots')) {
      this.cp = enc.beginComputePass(this.pass('lots'));
      this.fill(B.CNT, 4, 0);
      if (p.gap) this.gapFill();
      // (m3h) each block's supercell state and growth key, into its meta
      if (this.cityOn()) {
        this.k('bgrow', { count: 3 * this.nS() }, { 4: B.SCT, 5: B.BQ }, Math.ceil(this.nS() / 64));
        if (p.gap) this.k('bgrow', { count: 3 * GAP_ROOM }, { 4: B.SCT, 5: B.GB }, Math.ceil(GAP_ROOM / 64));
      }
      this.k('lots', { count: LOT_ROOM }, { 1: B.BQ, 2: B.AD, 4: B.SCT, 5: B.LOTS, 6: B.CNT }, Math.ceil((3 * this.nS()) / 64));
      if (p.gap) this.k('lots', { count: LOT_ROOM, mode: 1 }, { 1: B.GB, 2: B.AD, 4: B.SCT, 5: B.LOTS, 6: B.CNT }, Math.ceil((3 * GAP_ROOM) / 64));
      this.cp.end();
    }
    // the mesh: roads, lots and the points' markers
    enc.clearBuffer(this.args, 0, 4);
    this.cp = enc.beginComputePass(this.pass('mesh'));
    // (M4b: the buildings cut off from the reach, when it's been asked: before the mesh that outlines them)
    const rj = this.reachJob;
    if (rj) this.k('lotReach', { count: LOT_ROOM, k: rj.winW, mode: rj.winH, box: [rj.gx >>> 0, rj.gy >>> 0] }, { 1: this.lotRecords, 2: B.CNT, 3: rj.marks, 5: this.reachCut }, Math.ceil(LOT_ROOM / 64));
    this.fill(B.ROADS, w * h, 0);
    this.k2('roadMajor', {}, { 5: B.VTAG, 1: B.LM, 2: B.SCT, 3: HH, 4: B.FD, 6: B.ROADS, 7: this.verts }, true);
    // (one thread a street's piece: eight a vector street, TP a trace)
    if (vector) this.k('vroad', {}, { 5: B.VTAG, 1: B.SD, 2: B.AL1, 3: HH, 4: B.SCT, 6: B.ROADS, 7: this.verts }, Math.ceil((this.nS() * 8) / 64), 1, true);
    else this.k('roadMinor', {}, { 5: B.VTAG, 1: B.TR, 2: B.AL0, 3: HH, 6: B.ROADS, 7: this.verts }, this.seeds[0] * this.seeds[1], 1, true);
    this.k('groad', {}, { 5: B.VTAG, 1: B.CNT, 2: B.SCT, 3: HH, 4: B.FD, 6: B.ROADS, 7: this.verts }, (ROAD_ROOM * 8) / 64, 1, true);
    if (this.cityOn() && p.tint === 1) this.k2('ctint', {}, { 5: B.VTAG, 2: B.SCT, 3: HH, 4: B.FD, 7: this.verts }, true);
    // (M4a: the lots' records — the contract — then the mesh from them; a landmark site's record too, its mesh lmMesh's)
    this.k('lotRec', { count: LOT_ROOM }, { 1: B.LOTS, 2: B.SCT, 3: HH, 4: B.FD, 5: B.LM, 6: B.CNT, 7: this.lotRecords }, Math.ceil(LOT_ROOM / 64));
    this.k('lotRec', { mode: 1 }, { 1: B.LOTS, 2: B.SCT, 3: HH, 4: B.FD, 5: B.LM, 6: B.CNT, 7: this.lotRecords }, 1);
    // (time-lapse: each record's progress now, before the mesh and the claims read it)
    this.k('tlProgress', {}, { 1: this.lotRecords, 4: B.SCT, 5: this.progress, 6: B.CNT }, Math.ceil((LOT_ROOM + LM_ROOM) / 64));
    this.k('lotMesh', { count: LOT_ROOM }, { 5: B.VTAG, 1: this.lotRecords, 2: this.progress, 3: HH, 4: this.reachCut, 6: B.CNT, 7: this.verts }, Math.ceil(LOT_ROOM / 64), 1, true);
    this.k('artMesh', {}, { 5: B.VTAG, 1: B.ART, 3: HH, 6: B.ROADS, 7: this.verts }, (NART * NAP) / 64, 1, true);
    if (vector && p.lmMult > 0) this.k('lmMesh', {}, { 5: B.VTAG, 1: B.LM, 3: HH, 6: B.ROADS, 7: this.verts }, (64 * 48) / 64, 1, true);
    if (PHI_MODE[p.majors] !== 0 && p.marks) this.k('marks', { mode: this.sel + 1 }, { 5: B.VTAG, 1: B.PTS, 3: HH, 7: this.verts }, 1, 1, true);
    // (m3c: the shaped ground's skin, its bands tinted; the cart road)
    if (p.shape > 0) this.k2('ground', {}, { 5: B.VTAG, 1: B.H, 3: HH, 4: B.FD, 7: this.verts }, true);
    if (p.shape > 1) this.k2('roadShape', {}, { 5: B.VTAG, 1: B.HS, 2: B.PTS, 3: HH, 4: B.FD, 6: B.ROADS, 7: this.verts }, true);
    this.k('meshCap', {}, {}, 1, 1, true);
    // (time-lapse: the tagged vertices where the clock puts them)
    this.k('tlRise', {}, { 1: this.lotRecords, 2: this.progress, 3: B.VTAG, 4: B.SCT, 7: this.verts }, Math.ceil(this.vertRoom / 64), 1, true);
    // (M4b: the claim grid — the roads' and decks' columns, then the buildings' over them)
    this.k2('claimRoads', {}, { 1: B.ROADS, 3: B.H, 7: this.claimGrid });
    this.k('claimLots', { count: LOT_ROOM }, { 1: this.lotRecords, 2: this.progress, 4: B.CNT, 7: this.claimGrid }, Math.ceil((LOT_ROOM + LM_ROOM) / 64));
    this.cp.end();
    device.queue.writeBuffer(this.uni, 0, this.uniData, 0, this.nPass * SLOT);
    // (M4a: the counts for the contract — the lots' (CNT word 0) and the sites' (LM word 0))
    enc.copyBufferToBuffer(B.CNT, 0, this.lotCounts, 0, 4);
    enc.copyBufferToBuffer(B.LM, 0, this.lotCounts, 4, 4);
    const n = ALL.length * 2;
    if (this.qs) {
      enc.resolveQuerySet(this.qs, 0, n, this.qRes!, 0);
      enc.copyBufferToBuffer(this.qRes!, 0, this.qRead, 0, n * 8);
    }
    enc.copyBufferToBuffer(B.CNT, 0, this.qRead, n * 8, 4);
    enc.copyBufferToBuffer(this.args, 0, this.qRead, n * 8 + 4, 4);
    enc.copyBufferToBuffer(B.PTS, 0, this.qRead, n * 8 + 16, NPTS * PW * 4);
    device.queue.submit([enc.finish()]);
    await this.qRead.mapAsync(GPUMapMode.READ);
    const raw = this.qRead.getMappedRange().slice(0);
    this.qRead.unmap();
    const t = new BigUint64Array(raw, 0, n);
    const c = new Uint32Array(raw, n * 8, 2);
    const pf = new Float32Array(raw, n * 8 + 16, NPTS * PW);
    const pu = new Uint32Array(raw, n * 8 + 16, NPTS * PW);
    this.points = Array.from({ length: NPTS }, (_, i) => ({ slot: i, x: pf[i * PW], y: pf[i * PW + 1], intensity: pf[i * PW + 2], flag: pu[i * PW + 4], alive: pu[i * PW + 5] === 1 }));
    const ms = (s: number) => Number(t[s * 2 + 1] - t[s * 2]) / 1e6;
    // (which of height and the stages ran: the mesh always)
    const ran = (i: number) => (i === 0 ? firstHeights : i === ALL.length - 1 || runs(ALL[i] as Stage));
    const stage = Object.fromEntries(STAGES.map((s, j) => [s, this.qs && ran(j + 1) ? ms(j + 1) : null])) as Record<Stage, number | null>;
    const first = ALL.findIndex((_, i) => ran(i));
    return {
      from,
      box,
      height: this.qs && firstHeights ? ms(0) : null,
      stage,
      total: this.qs ? Number(t[n - 1] - t[first * 2]) / 1e6 : null,
      lots: Math.min(c[0], LOT_ROOM),
      verts: c[1],
    };
  }
}

/** a box clipped to the window's columns */
function clip(b: Box, w: number, h: number): Box {
  return [Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(w, Math.ceil(b[2])), Math.min(h, Math.ceil(b[3]))];
}
