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

/** what the town generator needs of the world: its grid — a box of the window, w columns by h rows from window column
 *  box[0], row box[1] (even: a row's hex offset is the window's) — and the world's buffers it reads there */
export interface StreetWorld {
  w: number;
  h: number;
  box: [number, number];
  globals: GPUBuffer;
  chunks: GPUBuffer;
  layers: GPUBuffer;
  water: GPUBuffer;
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

const SLOT = 256;
const MAX_PASSES = 256;
const UNI_BYTES = 256;
const KERNELS = [
  'fill', 'blur', 'feat', 'jfa', 'jdist', 'autoPts', 'phi', 'tensor', 'trace', 'mis', 'blocks',
  'vseed', 'vthin', 'vrast', 'vjfa', 'vseg', 'vblock', 'lots', 'roadMajor', 'roadMinor', 'vroad', 'lotRec', 'lotMesh', 'marks', 'meshCap',
  'shape', 'roadShape', 'ground', 'bqual', 'bclaim', 'bapply', 'vnext', 'jstat', 'lmlist', 'lmprune', 'vclip', 'lmMesh', 'gcov', 'gmask', 'glabel', 'gacc', 'gnode', 'gsplit', 'gleaf', 'groad', 'mseed', 'ginit', 'gmarch', 'gclaim', 'gkeep', 'sctab', 'bgrow', 'ctint',
  'artSpan', 'artMesh',
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
/** (M4a) streets.wgsl NART, AW, ART_PIECES: the arterials (approach roads) a town has room for, words each, pieces each */
export const NART = 8;
const AW = 16;
const ART_PIECES = 512;

interface Uni {
  k?: number;
  mode?: number;
  count?: number;
  /** a boxed pass's first column */
  box?: [number, number];
}
type Bufs = Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, GPUBuffer>>;

export class CityGen {
  readonly verts: GPUBuffer;
  readonly args: GPUBuffer;
  /** (M4a, the contract: api/contracts/citygen.ts) the lot records, their counts, each one's construction progress */
  readonly lotRecords: GPUBuffer;
  readonly lotCounts: GPUBuffer;
  readonly progress: GPUBuffer;
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
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (label: string, bytes: number, usage = S) => {
      const b = device.createBuffer({ label: `citygen ${label}`, size: Math.max(16, bytes), usage });
      this.all.push(b);
      return b;
    };
    this.uni = buf('passes', SLOT * MAX_PASSES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    for (const n of ['H', 'HT', 'M', 'HS', 'TB', 'T0', 'FDB', 'FD', 'S0', 'S1', 'BLK', 'TX', 'TY']) this.B[n] = buf(n, N * 4);
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
    this.B.SCT = buf('supercells', (4 + this.scCells(8) * 6) * 4);
    // (M4a: the arterials — a count, then each one's direction (the CPU's), length and bridge spans (the GPU's))
    this.B.ART = buf('arterials', (4 + NART * AW) * 4);
    this.boxUni = buf('box', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.boxUni, 0, new Uint32Array([world.box[0], world.box[1], w, h]));
    this.verts = buf('mesh', VERT_ROOM * 32, GPUBufferUsage.STORAGE);
    this.args = buf('mesh args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    device.queue.writeBuffer(this.args, 0, new Uint32Array([0, 1, 0, 0]));
    this.dummies = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => buf(`dummy ${k}`, 16));
    this.layout = makeLayout(device, 'citygen', { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' }, GPUShaderStage.COMPUTE);
    const module = makeModule(device, 'citygen', [streetsWgsl]);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipes = Object.fromEntries(KERNELS.map((k) => [k, device.createComputePipeline({ label: `citygen ${k}`, layout: pl, compute: { module, entryPoint: k } })])) as Record<Kernel, GPUComputePipeline>;
    if (world.box[1] % 2) throw new Error(`citygen: the box's first row (${world.box[1]}) must be even`);
    this.heightK = makeCompute(device, 'citygen height', [commonWgsl, layersWgsl, materialsWgsl, heightWgsl], { 0: 'uniform', 1: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'uniform' });
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
  /** (M4a, the town's input) its approach roads: the unit directions its atlas roads leave by (at most NART) — the
   *  arterials and their bridges are made from them on the GPU; the next run from 'field' */
  setArterials(dirs: readonly (readonly [number, number])[]): void {
    if (dirs.length > NART) throw new Error(`citygen: ${dirs.length} approach roads, room for ${NART}`);
    const a = new ArrayBuffer((4 + NART * AW) * 4);
    new Uint32Array(a)[0] = dirs.length;
    const f = new Float32Array(a);
    dirs.forEach(([x, y], k) => {
      f[4 + k * AW] = x;
      f[5 + k * AW] = y;
    });
    this.device.queue.writeBuffer(this.B.ART, 0, a);
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
    [w, h, u.k ?? 0, u.mode ?? 0, u.count ?? 0, VERT_ROOM, families(p.majors, p.cross), this.seeds[0]].forEach((v, j) => dv.setUint32(j * 4, v >>> 0, true));
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
        this.kS('gmarch', { k }, { 4: B.FD, 5: B.SD, 6: B.GCNT });
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
    if (this.cityOn()) this.k('sctab', {}, { 1: B.PTS, 2: B.LM, 3: B.HS, 4: B.FD, 5: B.SCT, 7: B.ART }, 1);
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
      const W = this.world;
      cp.setPipeline(this.heightK.pipeline);
      cp.setBindGroup(0, makeBindGroup(device, 'citygen height', this.heightK.layout, { 0: W.globals, 1: W.chunks, 3: W.layers, 4: W.water, 5: B.H, 6: B.M, 7: this.boxUni }));
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
      // (M4a: the arterials — their length and bridges)
      this.k('artSpan', {}, { 1: B.M, 3: B.H, 5: B.ART }, 1);
      const fr = this.jfa(B.S0, B.S1);
      this.k2('jdist', {}, { 1: fr, 5: p.field === 1 ? B.FDB : B.T0 });
      if (p.field === 0) this.blur(B.T0, B.FDB, 5, 3);
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
      // (M4a: new lots, built: each one's progress 1 — the construction's to set from here)
      this.fill(this.progress, LOT_ROOM + LM_ROOM, 0x3f800000);
      if (p.gap) this.gapFill();
      // (m3h) each block's supercell state and growth key, into its meta
      if (this.cityOn()) {
        this.k('bgrow', { count: 3 * this.nS() }, { 4: B.SCT, 5: B.BQ }, Math.ceil(this.nS() / 64));
        if (p.gap) this.k('bgrow', { count: 3 * GAP_ROOM }, { 4: B.SCT, 5: B.GB }, Math.ceil(GAP_ROOM / 64));
      }
      this.k('lots', { count: LOT_ROOM }, { 1: B.BQ, 2: B.ART, 4: B.SCT, 5: B.LOTS, 6: B.CNT }, Math.ceil((3 * this.nS()) / 64));
      if (p.gap) this.k('lots', { count: LOT_ROOM }, { 1: B.GB, 2: B.ART, 4: B.SCT, 5: B.LOTS, 6: B.CNT }, Math.ceil((3 * GAP_ROOM) / 64));
      this.cp.end();
    }
    // the mesh: roads, lots and the points' markers
    enc.clearBuffer(this.args, 0, 4);
    this.cp = enc.beginComputePass(this.pass('mesh'));
    this.k2('roadMajor', {}, { 1: B.LM, 2: B.SCT, 3: HH, 4: B.FD, 7: this.verts }, true);
    // (one thread a street's piece: eight a vector street, TP a trace)
    if (vector) this.k('vroad', {}, { 1: B.SD, 2: B.AL1, 3: HH, 4: B.SCT, 7: this.verts }, Math.ceil((this.nS() * 8) / 64), 1, true);
    else this.k('roadMinor', {}, { 1: B.TR, 2: B.AL0, 3: HH, 7: this.verts }, this.seeds[0] * this.seeds[1], 1, true);
    this.k('groad', {}, { 1: B.CNT, 2: B.SCT, 3: HH, 4: B.FD, 7: this.verts }, (ROAD_ROOM * 8) / 64, 1, true);
    if (this.cityOn() && p.tint === 1) this.k2('ctint', {}, { 2: B.SCT, 3: HH, 4: B.FD, 7: this.verts }, true);
    // (M4a: the lots' records — the contract — then the mesh from them; a landmark site's record too, its mesh lmMesh's)
    this.k('lotRec', { count: LOT_ROOM }, { 1: B.LOTS, 2: B.SCT, 3: HH, 4: B.FD, 5: B.LM, 6: B.CNT, 7: this.lotRecords }, Math.ceil(LOT_ROOM / 64));
    this.k('lotRec', { mode: 1 }, { 1: B.LOTS, 2: B.SCT, 3: HH, 4: B.FD, 5: B.LM, 6: B.CNT, 7: this.lotRecords }, 1);
    this.k('lotMesh', { count: LOT_ROOM }, { 1: this.lotRecords, 2: this.progress, 3: HH, 6: B.CNT, 7: this.verts }, Math.ceil(LOT_ROOM / 64), 1, true);
    this.k('artMesh', {}, { 1: B.ART, 3: HH, 7: this.verts }, (NART * ART_PIECES) / 64, 1, true);
    if (vector && p.lmMult > 0) this.k('lmMesh', {}, { 1: B.LM, 3: HH, 7: this.verts }, (64 * 48) / 64, 1, true);
    if (PHI_MODE[p.majors] !== 0) this.k('marks', { mode: this.sel + 1 }, { 1: B.PTS, 3: HH, 7: this.verts }, 1, 1, true);
    // (m3c: the shaped ground's skin, its bands tinted; the cart road)
    if (p.shape > 0) this.k2('ground', {}, { 1: B.H, 3: HH, 4: B.FD, 7: this.verts }, true);
    if (p.shape > 1) this.k2('roadShape', {}, { 1: B.HS, 2: B.PTS, 3: HH, 4: B.FD, 7: this.verts }, true);
    this.k('meshCap', {}, {}, 1, 1, true);
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
