// The world-anchored tile cache (round 103, ?tiles=1; DECISIONS round 103 — the user: "the tiles are isometric so
// why not load and render them once then tile them so the view covers the screen but cost is cheap?").
//
// A tile is a region's terrain (64 x 64 cells, the streamer's region) as the view sees it: drawn once through a
// camera of its own (the view's rotation; its own scale, at most the view's; placed on the region) into a
// G-buffer, and baked (tiles.wgsl fsTileBake) into a slot of an atlas — the look before it's lit (albedo, the
// water film, the normal it's lit by, gem or not) and the depth along the view from the region's anchor. Past the
// window every frame the tiles are drawn as quads (vsTile/fsTile) where their regions are, lit then (sun, time of
// day, clouds, the shadow map where it reaches, the haze), their depth the frame's; the rings and the far land
// don't draw where a tile does (far.wgsl tiled, the mask). Inside the window the window's own land draws live, as
// before, and the tiles of its regions are baked again now and then (its plants, stains and water change), so
// when a region leaves the window its tile keeps it — frozen, in full detail, its last image — while the region's
// columns go (the pool, the store). Tiles are keyed by region and the view's turn (azimuth): a turn draws none
// till it's back, the window's baked again at the new one. The atlas is a fixed budget of slots, least recently
// used out.
//
// Not yet: regions never in the window (render them once as they arrive in the rings — needs the mesher and the
// look to read a region's own columns, not the window's: BACKLOG TC2).

import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import type { Camera } from './camera';
import { CAMERA_CUT_BYTES, CAMERA_CUT_OFFSET, CAMERA_POS_OFFSET } from './camera';
import type { FieldMesh } from './fieldmesh';
import { ROW_H } from '../world/lattice';
import type { LandTimes } from './tileland';

/** (round 105) what makes the render-only land: tileland.ts (the playable path, ?tilegpu=0) or tilelandgpu.ts */
export interface LandMaker {
  step(enc: GPUCommandEncoder, cam: Camera, B: Basis, rp: number): boolean;
  afterSubmit(): void;
  invalidate?(): void;
  readonly stats: Record<string, number>;
  readonly latencies: LandTimes[];
  /** (round 112, tilefast: the bench's why) region "rx,ry"'s land: being made, made and waiting for its bake, wanted
   *  and not started, or none of these */
  stateOf?(key: string): 'making' | 'made' | 'queued' | null;
}

/** the streamer's region (cells; rows the same count) */
const R = 64;
/** the mask's side (regions): tiles within half of it of the camera are drawn */
const MASK_N = 64;
/** frames between a window region's bakes, at least (its look changes slowly: plants, stains, water) */
const REBAKE = Number(new URLSearchParams(location.search).get('tilerebake') ?? 600);
/** bakes a frame */
const PER_FRAME = Math.max(1, Number(new URLSearchParams(location.search).get('tilesper') ?? 1) | 0);
/** the atlas's budget (MB) and a slot's size (texels). (Round 112, `tilefix`: by the screen — 24 MB is the phone's
 *  (411 x 785 css px, the pan bench's), the screen's ground at a zoom grows with its css area, so a desktop's
 *  1600 x 900 at a wide zoom wanted 4.5 times the tiles: the atlas full of the screen's own and the rest the far land's
 *  flat colour. Up to TILE_MB_MAX; ?tilemb= sets it.) */
const PHONE_CSS = 411 * 785;
const TILE_MB_MAX = 128;
const BUDGET_MB = Number(new URLSearchParams(location.search).get('tilemb') ?? Math.min(TILE_MB_MAX, 24 * Math.max(1, (innerWidth * innerHeight) / PHONE_CSS)));
const [SW, SH] = (new URLSearchParams(location.search).get('tilepx') ?? '128x192').split('x').map(Number);
/** bytes a texel: rgba8 (albedo, film) + rg32uint (normal and flags, depth) — the slots' count is these planes' budget —
 *  and (round 108, TC20) rgba8 (the held river under it — how far under its level at the reference wetness, its depth
 *  at its line — and its own snow, and the weather's cover's there, as baked: tiles.wgsl BakeOut.c) */
const TEXEL_BYTES = 12;
const LIVE_BYTES = 4;
/** how far past its region a tile draws (cells; the bake takes the chunks round it in) */
const OVERLAP = 1;
/** ?tileland=0: no render-only land past the window (TC2) — only what the window baked */
const NO_LAND = new URLSearchParams(location.search).get('tileland') === '0';
/** (round 105, tileahead) seconds of the camera's motion the land is made ahead of the screen, and the motion
 *  (world units a second) under which the camera's at rest */
const PREFETCH_S = Number(new URLSearchParams(location.search).get('tileahead') ?? 1);
const MOVING = 2;
/** (round 106, tilephone) the look-ahead's least reach (world units: a region and a half), and the margin round the
 *  screen asked for next (the screen's size times this) */
const AHEAD_CELLS = 96;
const MARGIN = 1.35;
/** (round 112, TC21; ?tilefit=) a tile's part of a slot is the least that holds it at this share of the view's scale
 *  (texels a unit): 1, the screen's own */
/** (round 112) the height a render-only tile's land is taken to span (tilelandgpu.ts QUARTER_Z) */
const REMAKE_Z = 48;
const PART_FIT = Number(new URLSearchParams(location.search).get('tilefit') ?? 1);
/**
 * (round 112, tilefast, TC21) The part of a slot a tile takes: -1 the whole (SW x SH), 0-3 a quarter (x, y halves),
 * 4 the top half, 5 the bottom (SW x SH/2). Indexed by part + 1: the slot's quarters it covers (bits), its corner and
 * size (px), its first quarter (where TP keeps what it was baked at).
 */
export type Part = -1 | 0 | 1 | 2 | 3 | 4 | 5;
const PART_MASK = [15, 1, 2, 4, 8, 3, 12];
const PART_FIRST = [0, 0, 1, 2, 3, 0, 2];
const PART_PX: [number, number, number, number][] = [
  [0, 0, SW, SH],
  [0, 0, SW >> 1, SH >> 1],
  [SW >> 1, 0, SW >> 1, SH >> 1],
  [0, SH >> 1, SW >> 1, SH >> 1],
  [SW >> 1, SH >> 1, SW >> 1, SH >> 1],
  [0, 0, SW, SH >> 1],
  [0, SH >> 1, SW, SH >> 1],
];
/** (round 112) a tile's size: 0 a whole slot, 1 a half, 2 a quarter — the parts of each, and each part's */
export type Size = 0 | 1 | 2;
const SIZE_PARTS: Part[][] = [[-1], [4, 5], [0, 1, 2, 3]];
const PART_SIZE: Size[] = [0, 2, 2, 2, 2, 1, 1];
/** the least size whose texels hold a box of this many texels (w x h) */
function sizeOf(w: number, h: number): Size {
  const fw = Math.ceil(w) + 1;
  const fh = Math.ceil(h) + 1;
  if (fh > SH >> 1 || fw > SW) return 0;
  return fw <= SW >> 1 ? 2 : 1;
}
/** (round 112, `tilefix3`) the zoom floor (TileCache.zoomFloor): the share of the atlas's slots a screenful may take, the
 *  frames a screenful's land may take to make from nothing, the land's rate a frame (tiles: measured by the gate —
 *  scripts/tilegate.mjs fillFrames — a phone's path ~0.3 (the gate's phone-path fill: z1.3, ~81 tiles in 270 frames), a desktop's ~2; ?tilerate= sets it); ?zoomfloor=0 none */
const FLOOR_ROOM = 0.8;
const FLOOR_FRAMES = Number(new URLSearchParams(location.search).get('floorframes') ?? 300);
const PHONE_UA = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const FILL_RATE_PHONE = Number(new URLSearchParams(location.search).get('tilerate') ?? 0.3);
const FILL_RATE = Number(new URLSearchParams(location.search).get('tilerate') ?? 2);
export const ZOOM_FLOOR = new URLSearchParams(location.search).get('zoomfloor') !== '0';
/** ?tiledebug=1: the tiles drawn tinted */
const DEBUG = new URLSearchParams(location.search).get('tiledebug') === '1';

/** the view's frame (TileCache.basis) */
export interface Basis {
  sx: number;
  sy: number;
  sz: number;
  r: number[];
  u: number[];
  f: number[];
}

export interface TileSrc {
  mesh: FieldMesh;
  chunks: GPUBuffer;
  layers: GPUBuffer;
}

/** what the renderer lends the cache */
export interface TileHost {
  device: GPUDevice;
  world: WorldGpu;
  profiler: Profiler;
  colorFormat: GPUTextureFormat;
  pickFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  /** the mesh's module with tiles.wgsl appended */
  module: GPUShaderModule;
  /** the mesh's resolve layout, and that with the tiles' bindings (42-45) */
  resolveLayout: GPUBindGroupLayout;
  drawLayout: GPUBindGroupLayout;
  camBytes: number;
  camBuf: GPUBuffer;
  /** the frame's camera data as written (render.wgsl Camera) */
  camData: () => ArrayBuffer;
  win: TileSrc;
  band: () => TileSrc | undefined;
  /** the mesh's G-buffer pipeline (no cut, no cull), the hybrid grid's; undefined till compiled */
  gPipe: () => GPURenderPipeline | undefined;
  gridPipe: () => GPURenderPipeline | undefined;
  /** (hybrid) the grid's chunks (chunkGrid order), and drawing a set of them (pipeline and group set) */
  gridOn: () => Uint8Array | null;
  /** (hybrid) every mesh chunk's lowest and highest column top (window z; scenes/hybrid.ts), or null */
  chunkBox: () => { lo: Float32Array; hi: Float32Array } | null;
  drawGrid: (pass: GPURenderPassEncoder, which: Uint8Array) => void;
  meshGroup: (cam: GPUBuffer, src: TileSrc) => GPUBindGroup;
  meshEntries: (src: TileSrc, cam: GPUBuffer) => GPUBindGroupEntry[];
}

interface Tile {
  rx: number;
  ry: number;
  az: number;
  slot: number;
  /** texels used (w, h), texels a unit, the view-plane coordinates of its left and top edges (from the anchor) */
  tw: number;
  th: number;
  dens: number;
  a0: number;
  b1: number;
  /** the highest point (world z) */
  top: number;
  bakedAt: number;
  usedAt: number;
  /** (round 105, tilelatency) baked by the GPU's own setup (tilelandgpu.ts): what it was baked at is only TP's */
  gpu?: boolean;
  /** (round 112, the bench's why) why prepare last left it out ('eye', 'off', 'far'), or '' */
  skip?: string;
  /** (round 112, tilefast, TC21) the part of its slot it's in (Part) */
  q: Part;
  /** (round 112, tilefix) a render-only tile's extent known on the CPU (TileLandGpu.boundOf: a0, b1, tw, th — conservative) */
  boxed?: boolean;
}

/** a bake slot: its camera and groups (made again when the mesh's buffers change) */
interface Baker {
  cam: GPUBuffer;
  gWin?: GPUBindGroup;
  gBand?: GPUBindGroup;
  rWin?: GPUBindGroup;
  rBand?: GPUBindGroup;
}

export class TileCache {
  /** counts (scripts read them): bakes (first, again), evictions, tiles drawn last frame, slots, in use, MB */
  /** ?tiledebug=1 (or set at run time — scripts/tileparity.mjs): the tiles drawn tinted */
  debug = DEBUG;
  readonly stats = { remade: 0, bakes: 0, first: 0, again: 0, evicted: 0, drawn: 0, slots: 0, used: 0, mb: 0, frozen: 0, skipEye: 0, skipOff: 0, skipFar: 0, zoomFloor: 0 };
  private tiles = new Map<string, Tile>();
  /** (round 112, TC21) the atlas's quarters (slot · 4 + q): a whole slot's tile in its four, a quarter's in its own */
  private cells: (Tile | null)[];
  private atlasA!: GPUTexture;
  private atlasB!: GPUTexture;
  /** (round 108, TC20) the live plane: what the draw brings up to now — the held river's pair (the rivers' wetness), the
   *  texel's own snow and the cover's as baked (the weather's cover) — tiles.wgsl BakeOut.c, fsTile */
  private atlasLive!: GPUTexture;
  private gb0!: GPUTexture;
  private gb1!: GPUTexture;
  private gbD!: GPUTexture;
  private cols: number;
  private bakers: Baker[] = [];
  private inst: GPUBuffer;
  private instData: Float32Array;
  private uni: GPUBuffer;
  /** (round 105, tilelatency) per slot what it was baked at (tiles.wgsl TP) */
  private tparams: GPUBuffer;
  /** the regions drawn (far.wgsl tiled): [0] on, [1] n, n x n words */
  readonly mask: GPUBuffer;
  private maskData = new Uint32Array(2 + MASK_N * MASK_N);
  private maskKey = '';
  private drawGroup?: GPUBindGroup;
  private pipes?: { bake: GPURenderPipeline; over: GPURenderPipeline; draw: GPURenderPipeline };
  /** the window's cell (0, 0) in the world (cells, rows) and its oz; null: not streamed — no tiles */
  private origin: [number, number, number] | null = null;
  private drawCount = 0;
  private frame = 0;

  constructor(private host: TileHost) {
    const dev = host.device;
    const slotBytes = SW * SH * TEXEL_BYTES;
    const lim = dev.limits.maxTextureDimension2D;
    this.cols = Math.max(1, Math.floor(lim / SW));
    const want = Math.max(4, Math.floor((BUDGET_MB * 2 ** 20) / slotBytes));
    this.cols = Math.min(this.cols, Math.ceil(Math.sqrt(want * (SH / SW))));
    const rows = Math.min(Math.floor(lim / SH), Math.ceil(want / this.cols));
    const slots = this.cols * rows;
    this.cells = new Array(slots * 4).fill(null);
    this.stats.slots = slots;
    this.stats.mb = +((slots * SW * SH * (TEXEL_BYTES + LIVE_BYTES)) / 2 ** 20).toFixed(1);
    // (round 105: the atlas and the bake's G-buffer made when a streamed window first gives the tiles a place — tiles on by
    // default, a level without one spends nothing: alloc)
    this.rows = rows;
    this.instData = new Float32Array(slots * 4 * 16);
    this.inst = dev.createBuffer({ label: 'tiles instances', size: this.instData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uni = dev.createBuffer({ label: 'tiles uniform', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.tparams = dev.createBuffer({ label: 'tiles params', size: slots * 4 * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.mask = dev.createBuffer({ label: 'tiles mask', size: this.maskData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    for (let k = 0; k < PER_FRAME; k++) this.bakers.push({ cam: dev.createBuffer({ label: `tiles bake camera ${k}`, size: host.camBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) });
    void this.makePipes();
  }

  private async makePipes(): Promise<void> {
    const h = this.host;
    const dev = h.device;
    const rl = dev.createPipelineLayout({ bindGroupLayouts: [h.resolveLayout] });
    const bakeT: GPUColorTargetState[] = [{ format: 'rgba8unorm' }, { format: 'rg32uint' }, { format: 'rgba8unorm' }];
    const [bake, over, draw] = await Promise.all([
      dev.createRenderPipelineAsync({ label: 'tiles-bake', layout: rl, vertex: { module: h.module, entryPoint: 'vsFull' }, fragment: { module: h.module, entryPoint: 'fsTileBake', targets: bakeT }, primitive: { topology: 'triangle-list' } }),
      dev.createRenderPipelineAsync({ label: 'tiles-bake-over', layout: rl, vertex: { module: h.module, entryPoint: 'vsFull' }, fragment: { module: h.module, entryPoint: 'fsTileBakeOver', targets: bakeT }, primitive: { topology: 'triangle-list' } }),
      dev.createRenderPipelineAsync({
        label: 'tiles-draw',
        layout: dev.createPipelineLayout({ bindGroupLayouts: [h.drawLayout] }),
        vertex: { module: h.module, entryPoint: 'vsTile' },
        fragment: { module: h.module, entryPoint: 'fsTile', targets: [{ format: h.colorFormat }, { format: h.pickFormat }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: h.depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
      }),
    ]);
    this.pipes = { bake, over, draw };
  }

  /** The streamed window's cell (0, 0) in the world (cells, rows) and its oz (level.ts, every frame). */
  setOrigin(ox: number, oy: number, oz: number): void {
    if (!this.atlasA) this.alloc();
    this.origin = [ox, oy, oz];
  }

  private rows: number;
  /** (round 105) the atlas (slots of SW x SH texels: rgba8 + rg32uint) and the bake's G-buffer */
  private alloc(): void {
    const dev = this.host.device;
    const RB = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.atlasA = dev.createTexture({ label: 'tiles A', size: [this.cols * SW, this.rows * SH], format: 'rgba8unorm', usage: RB });
    this.atlasB = dev.createTexture({ label: 'tiles B', size: [this.cols * SW, this.rows * SH], format: 'rg32uint', usage: RB });
    this.atlasLive = dev.createTexture({ label: 'tiles live', size: [this.cols * SW, this.rows * SH], format: 'rgba8unorm', usage: RB });
    this.gb0 = dev.createTexture({ label: 'tiles gbuf0', size: [SW, SH], format: 'rgba32uint', usage: RB });
    this.gb1 = dev.createTexture({ label: 'tiles gbuf1', size: [SW, SH], format: 'rg32uint', usage: RB });
    this.gbD = dev.createTexture({ label: 'tiles gdepth', size: [SW, SH], format: this.host.depthFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.host.profiler.trackMemory('tiles', this.cols * this.rows * SW * SH * (TEXEL_BYTES + LIVE_BYTES) + SW * SH * (16 + 8 + 4));
  }

  /** (Renderer.windowMoved) The window slid by −t (window units): the origin follows now, before the frame's draw
   *  (setOrigin comes in the world pass); a warp (dcx 1 << 12) leaves it unknown till then. */
  moved(dcx: number, t: [number, number, number]): void {
    if (!this.origin) return;
    if (dcx === 1 << 12) {
      this.origin = null;
      return;
    }
    this.origin = [this.origin[0] - Math.round(t[0]), this.origin[1] - Math.round(t[1] / ROW_H), this.origin[2] - Math.round(t[2])];
  }

  /** The mesh's buffers changed (its pool grew, the band came): the groups that bind them made again. */
  invalidate(): void {
    for (const b of this.bakers) b.gWin = b.gBand = b.rWin = b.rBand = undefined;
    this.drawGroup = undefined;
    this.land?.invalidate?.();
  }

  /** the view's right, up and along (unit) and its clip scales, from its matrix (orthographic) */
  basis(m: Float32Array): Basis {
    const sx = Math.hypot(m[0], m[4], m[8]);
    const sy = Math.hypot(m[1], m[5], m[9]);
    const sz = Math.hypot(m[2], m[6], m[10]);
    return { sx, sy, sz, r: [m[0] / sx, m[4] / sx, m[8] / sx], u: [m[1] / sy, m[5] / sy, m[9] / sy], f: [m[2] / sz, m[6] / sz, m[10] / sz] };
  }

  /** region (rx, ry)'s anchor (its corner, world z 0) in window units now */
  private anchorWin(rx: number, ry: number): [number, number, number] {
    const [ox, oy, oz] = this.origin!;
    return [rx * R - ox, (ry * R - oy) * ROW_H, -oz];
  }

  private on(cam: Camera): boolean {
    return !!this.origin && !cam.fly && !!this.pipes && !!this.host.gPipe();
  }

  /**
   * The frame's bakes (before the world pass): of the window's regions whose chunks are all built (or the grid's),
   * the one never baked at this turn (or at a scale a quarter off), else the longest since — at most PER_FRAME,
   * none sooner than REBAKE frames after the last.
   */
  encode(enc: GPUCommandEncoder, cam: Camera, renderW: number): void {
    this.frame++;
    this.track(cam);
    // (round 112, tilefix3: the device's zoom floor, now and then — the camera holds to it)
    if (ZOOM_FLOOR && this.frame % 30 === 1) {
      const f = this.zoomFloor(cam, renderW);
      if (f > 0) cam.zoomFloor = f;
      this.stats.zoomFloor = +f.toFixed(2);
    }
    if (!this.on(cam)) return;
    const h = this.host;
    // (round 104, TC2: the land past the window no tile draws yet, made, meshed and baked — the camera's way first;
    // round 105: a frame the land bakes, the window's trailing bakes wait: they never take the land ahead's turn)
    // (round 106, tilephone: but a window region never baked still is — it may leave before its turn comes back: the
    // pan bench's pop-in behind, the land then made again for it; a window bake is cheap, no land to make)
    let landBaked = false;
    if (this.land && !NO_LAND) {
      const B0 = this.basis(cam.viewProj);
      this.rpNow = (B0.sx * renderW) / 2;
      landBaked = this.land.step(enc, cam, B0, this.rpNow);
    }
    const fm = h.win.mesh;
    const [nx, ny] = fm.chunkGrid;
    if (fm.builtSlides !== fm.slides || fm.built.length !== nx * ny) return;
    const grid = h.gridOn();
    const az = cam.azimuth;
    const B = this.basis(cam.viewProj);
    // (render pixels a unit: the bake's scale at most)
    const rp = (B.sx * renderW) / 2;
    const [ox, oy] = this.origin!;
    const w = h.world.w;
    const hh = h.world.h;
    const cand: { rx: number; ry: number; i: number; j: number; score: number }[] = [];
    for (let j = 0; j * R < hh; j++)
      for (let i = 0; i * R < w; i++) {
        let ready = true;
        for (let k = 0; k < 4 && ready; k++) {
          const cx = 2 * i + (k & 1);
          const cy = 2 * j + (k >> 1);
          if (cx >= nx || cy >= ny) continue;
          const c = cy * nx + cx;
          if (!fm.built[c] && !(grid && grid[c])) ready = false;
        }
        if (!ready) continue;
        // (round 105: only the window's edge regions — a region leaves through the edge, a slide at a time, so its
        // tile is baked there; the inner ones would be baked again before they go)
        const edge = i === 0 || j === 0 || (i + 1) * R >= w || (j + 1) * R >= hh;
        if (!edge) continue;
        const rx = Math.floor(ox / R) + i;
        const ry = Math.floor(oy / R) + j;
        const t = this.tiles.get(this.key(rx, ry, az));
        let score: number;
        if (!t) score = 1e9;
        else if (Math.abs(Math.log(t.dens / Math.min(rp, this.fitDens(t)))) > 0.22) score = 1e8;
        else score = this.frame - t.bakedAt;
        if (score < REBAKE) continue;
        cand.push({ rx, ry, i, j, score });
      }
    cand.sort((a, b) => b.score - a.score);
    const go = landBaked ? cand.filter((c) => c.score >= 1e9) : cand;
    for (let k = 0; k < Math.min(PER_FRAME, go.length); k++) this.bake(enc, cam, B, rp, go[k], this.bakers[k]);
  }

  /**
   * (round 112, `tilefix3`) The widest zoom (screen px a cell) at which this device's tiles hold the screen: the regions
   * a zoom shows with the look-ahead's margin (the screen's ground, MARGIN² of it, a region's ring round it), each in the
   * part of a slot it takes there (sizeOf at that zoom's scale), within FLOOR_ROOM of the atlas's slots — and no more of
   * them than the land makes in FLOOR_FRAMES frames at its rate a frame (FILL_RATE: a phone's, a desktop's). Past the
   * window only; 0 before the window's placed. Every view inside it should be all detail: a miss there is a bug.
   */
  zoomFloor(cam: Camera, renderW: number): number {
    if (!this.origin || cam.fly) return 0;
    const z0 = cam.zoom;
    const B = this.basis(cam.viewProj);
    const rp0 = (B.sx * renderW) / 2;
    const [ax, ay] = cam.screenDeltaToWorld(cam.viewportW, 0);
    const [bx, by] = cam.screenDeltaToWorld(0, cam.viewportH);
    // (the screen's ground at z0, world units², and a region's)
    const area0 = Math.abs(ax * by - ay * bx);
    const region = R * R * ROW_H;
    const slots = this.cells.length >> 2;
    const rate = PHONE_UA ? FILL_RATE_PHONE : FILL_RATE;
    // (from close out, the first zoom that doesn't fit; the floor the one before it)
    let floor = 24;
    for (let z = 24; z >= 0.5; z /= 1.04) {
      const k = z0 / z;
      const side = Math.sqrt(area0 * k * k) * MARGIN;
      const n = (side / Math.sqrt(region) + 2) ** 2;
      const sz = this.partFor(B, rp0 / k, 48);
      const frac = sz === 0 ? 1 : sz === 1 ? 0.5 : 0.25;
      if (n * frac > slots * FLOOR_ROOM || n > rate * FLOOR_FRAMES) break;
      floor = z;
    }
    return floor;
  }

  /** (round 112) the renderer's frames so far (a frame's encode each) */
  get frameNo(): number {
    return this.frame;
  }

  private key(rx: number, ry: number, az: number): string {
    return `${rx},${ry},${Math.round(az * 1e4)}`;
  }

  /** the texels a unit a tile of this extent fits its slot at (round 112: its own slot's size, a quarter's or a whole's) */
  private fitDens(t: Tile): number {
    const [, , cw, ch] = this.slotPx(t);
    return Math.min((cw - 1) / (t.tw / t.dens), (ch - 1) / (t.th / t.dens));
  }

  /**
   * (round 112, tilefast, TC21) The part of a slot a region's tile takes at the view's scale (`rp`, texels a unit): a
   * quarter (64 x 96 texels), a half (128 x 96: a wide zoom's tiles are wider than tall) or the whole (128 x 192), the
   * least its box — the region and its overlap, `zSpan` world units of height — fits at that scale. At a wide zoom the
   * screen wants more tiles than the atlas has whole slots, each wanting a fraction of one's texels.
   */
  partFor(B: Basis, rp: number, zSpan: number): Size {
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? R + OVERLAP : -OVERLAP;
      const y = k & 2 ? R * ROW_H + OVERLAP : -OVERLAP;
      const z = k & 4 ? zSpan : 0;
      const a = B.r[0] * x + B.r[1] * y + B.r[2] * z;
      const b = B.u[0] * x + B.u[1] * y + B.u[2] * z;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    return sizeOf((a1 - a0) * rp * PART_FIT, (b1 - b0) * rp * PART_FIT);
  }

  /** the window region (c.i, c.j)'s bake: its box from its chunks, the window's mesh, band and grid drawn */
  private bake(enc: GPUCommandEncoder, cam: Camera, B: Basis, rp: number, c: { rx: number; ry: number; i: number; j: number }, bk: Baker): void {
    const h = this.host;
    const fm = h.win.mesh;
    const band = h.band();
    const [nx, ny] = fm.chunkGrid;
    // (the box: the region and a cell round it, from its chunks' lowest column top to their highest — the hybrid's
    // per-chunk box, the columns' tops and a cell past each edge; without it, the window's floor to the mesh's tops)
    let top = -Infinity;
    let zLo = Infinity;
    const zb = h.chunkBox();
    for (let k = 0; k < 4; k++) {
      const cx = 2 * c.i + (k & 1);
      const cy = 2 * c.j + (k >> 1);
      if (cx < nx && cy < ny) {
        const ci = cy * nx + cx;
        if (zb) {
          top = Math.max(top, zb.hi[ci] + 2);
          zLo = Math.min(zLo, zb.lo[ci] - 2);
        } else {
          top = Math.max(top, fm.topOf(ci) + 2);
          zLo = -1;
        }
        if (band) top = Math.max(top, band.mesh.topKnown(ci) + 2);
      }
    }
    // the groups (made again after an invalidate)
    bk.gWin ??= h.meshGroup(bk.cam, h.win);
    bk.rWin ??= this.resolveGroup(h.win, bk.cam);
    if (band) {
      bk.gBand ??= h.meshGroup(bk.cam, band);
      bk.rBand ??= this.resolveGroup(band, bk.cam);
    }
    // the chunks: the region's four and those round it (cut off at the box)
    const which = new Uint8Array(nx * ny);
    for (let cy = 2 * c.j - 1; cy <= 2 * c.j + 2; cy++)
      for (let cx = 2 * c.i - 1; cx <= 2 * c.i + 2; cx++) if (cx >= 0 && cy >= 0 && cx < nx && cy < ny) which[cy * nx + cx] = 1;
    this.bakeTile(enc, cam, B, rp, c.rx, c.ry, zLo, top, this.origin![2], this.anchorWin(c.rx, c.ry), bk.cam, (g) => {
      g.setPipeline(h.gPipe()!);
      g.setBindGroup(0, bk.gWin!);
      fm.drawMask(g, which);
      if (band) {
        g.setBindGroup(0, bk.gBand!);
        band.mesh.drawMask(g, which);
      }
      const grid = h.gridOn();
      const gp = h.gridPipe();
      if (grid && gp) {
        g.setPipeline(gp);
        g.setBindGroup(0, bk.gWin!);
        h.drawGrid(g, which.map((v, i) => (v && grid[i] ? 1 : 0)));
      }
    }, band ? [bk.rWin, bk.rBand!] : [bk.rWin]);
  }

  /**
   * A tile baked (window regions here; render-only ones from tileland.ts): region (rx, ry)'s box (zLo..top in its
   * source's z, the source's floor at world z oz), its anchor in the source's coordinates (aw), `cam` the bake
   * camera's buffer (written here), `drawG` its G-buffer draws (pipelines and groups set; through `cam`), `resolve`
   * the resolve groups (the first over the whole slot, the rest over it). Its slot: its own, a free one, or the
   * least recently used (never one this frame drew or baked). False: no slot.
   */
  bakeTile(enc: GPUCommandEncoder, cam: Camera, B: Basis, rp: number, rx: number, ry: number, zLo: number, top: number, oz: number, aw: [number, number, number], camBuf: GPUBuffer, drawG: (g: GPURenderPassEncoder) => void, resolve: GPUBindGroup[]): boolean {
    const h = this.host;
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? R + OVERLAP : -OVERLAP;
      const y = k & 2 ? R * ROW_H + OVERLAP : -OVERLAP;
      // (relative to the anchor: world z = the source's z + oz)
      const z = (k & 4 ? top : zLo) + oz;
      const a = B.r[0] * x + B.r[1] * y + B.r[2] * z;
      const b = B.u[0] * x + B.u[1] * y + B.u[2] * z;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    // (round 112, TC21: the least part of a slot the tile at the view's scale fits)
    const t = this.allocTile(rx, ry, cam.azimuth, sizeOf((a1 - a0) * rp * PART_FIT, (b1 - b0) * rp * PART_FIT));
    if (!t) return false;
    const [sx, sy, cw, ch] = this.slotPx(t);
    const dens = Math.min(rp, (cw - 1) / (a1 - a0), (ch - 1) / (b1 - b0));
    const tw = Math.min(cw, Math.ceil((a1 - a0) * dens) + 1);
    const th = Math.min(ch, Math.ceil((b1 - b0) * dens) + 1);
    Object.assign(t, { tw, th, dens, a0, b1, top: top + oz, gpu: false });
    // (round 105: what it's baked at, for the draw — tiles.wgsl TP)
    h.device.queue.writeBuffer(this.tparams, this.tpIndex(t) * 32, new Float32Array([a0, b1, dens, 0, tw, th, top + oz, 1]));
    // the bake's camera: the view's rotation, the tile's scale, the region's box on [0, tw) x [0, th)
    const kx = (2 * dens) / tw;
    const ky = (2 * dens) / th;
    const ra = B.r[0] * aw[0] + B.r[1] * aw[1] + B.r[2] * aw[2];
    const ua = B.u[0] * aw[0] + B.u[1] * aw[1] + B.u[2] * aw[2];
    const fa = B.f[0] * aw[0] + B.f[1] * aw[1] + B.f[2] * aw[2];
    const cd = new Float32Array(h.camData().slice(0));
    const m = new Float32Array(16);
    m.set([B.r[0] * kx, B.u[0] * ky, B.f[0] * B.sz, 0, B.r[1] * kx, B.u[1] * ky, B.f[1] * B.sz, 0, B.r[2] * kx, B.u[2] * ky, B.f[2] * B.sz, 0]);
    m.set([-(ra + a0) * kx - 1, 1 - (b1 + ua) * ky, 0.5 - fa * B.sz, 1], 12);
    cd.set(m, 0);
    cd.set([sx, sy, fa, 0], CAMERA_POS_OFFSET / 4);
    // (the bake's: world units a texel, for the painted trees' edges — tiles.wgsl tileTrees; no shadow lookups there)
    cd[23] = 1 / dens;
    cd.fill(0, CAMERA_CUT_OFFSET / 4, (CAMERA_CUT_OFFSET + CAMERA_CUT_BYTES) / 4);
    h.device.queue.writeBuffer(camBuf, 0, cd);
    this.encodeBake(enc, sx, sy, tw, th, drawG, resolve);
    return true;
  }

  /**
   * (round 105, tilelatency) Region (rx, ry)'s tile at this turn: its own, a free slot, or the least recently used's
   * (never one this frame drew or baked); its bake counted. null: no slot. (Round 112, TC21: in `part` of a slot — its
   * own of another part let go and placed again.)
   */
  allocTile(rx: number, ry: number, az: number, size: Size = 0): Tile | null {
    const key = this.key(rx, ry, az);
    let t = this.tiles.get(key);
    // (its own of another size: a smaller one goes where it was — freed first, so it always fits; a bigger one is
    // placed first, the old kept drawn when there's no room)
    const old = t && PART_SIZE[t.q + 1] !== size ? t : undefined;
    if (old) {
      if (size > PART_SIZE[old.q + 1]) this.freeTile(old);
      t = undefined;
    }
    if (!t) {
      const at = this.placeFor(size);
      if (at < 0) {
        this.starvedAt = this.frame;
        return null;
      }
      if (old && this.tiles.get(key) === old) this.freeTile(old);
      const slot = at >> 3;
      const part = ((at & 7) - 1) as Part;
      t = { rx, ry, az, slot, q: part, tw: 0, th: 0, dens: 1, a0: 0, b1: 0, top: 0, bakedAt: 0, usedAt: this.frame };
      this.tiles.set(key, t);
      const m = PART_MASK[part + 1];
      for (let k = 0; k < 4; k++) if (m & (1 << k)) this.cells[slot * 4 + k] = t;
      this.stats.first++;
    } else this.stats.again++;
    t.bakedAt = this.frame;
    t.usedAt = this.frame;
    this.stats.bakes++;
    return t;
  }

  /** (round 112, TC21) the frame the atlas last had no place for a tile, and the view's scale (texels a unit) now */
  private starvedAt = -1e9;
  private rpNow = 1;

  /** (round 112) a tile let go: its quarters free */
  private freeTile(t: Tile): void {
    this.tiles.delete(this.key(t.rx, t.ry, t.az));
    const m = PART_MASK[t.q + 1];
    for (let k = 0; k < 4; k++) if (m & (1 << k) && this.cells[t.slot * 4 + k] === t) this.cells[t.slot * 4 + k] = null;
  }

  /**
   * (round 112, TC21) A place for a tile of `size` (a slot and its part there: slot · 8 + part + 1), its quarters free: a
   * free one — a half's or a quarter's in a slot already split first (whole slots kept for whole tiles) — else the place
   * whose tiles were all used longest ago, let go
   * (round 108: never a tile the last frame drew — at a zoom where the screen wants about as many tiles as the atlas
   * holds, the look-ahead's margin evicted tiles on the screen, they were made again and evicted the margin's).
   * -1: none.
   */
  private placeFor(size: Size): number {
    const n = this.cells.length >> 2;
    let free = -1;
    let best = -1;
    let bestAt = Infinity;
    for (let s = 0; s < n; s++)
      for (const part of SIZE_PARTS[size]) {
        const m = PART_MASK[part + 1];
        const at = s * 8 + part + 1;
        let busy = false;
        let used = false;
        let last = -Infinity;
        for (let k = 0; k < 4; k++) {
          const o = this.cells[s * 4 + k];
          if (!o) continue;
          used = true;
          if (!(m & (1 << k))) continue;
          if (o.usedAt >= this.frame - 1) busy = true;
          last = Math.max(last, o.usedAt);
        }
        if (busy) continue;
        if (last === -Infinity) {
          if (size === 0 || used) return at;
          if (free < 0) free = at;
        } else if (last < bestAt) {
          bestAt = last;
          best = at;
        }
    }
    if (free >= 0) return free;
    if (best < 0) return -1;
    const bs = best >> 3;
    const bm = PART_MASK[best & 7];
    for (let k = 0; k < 4; k++) {
      const o = this.cells[bs * 4 + k];
      if (o && bm & (1 << k)) {
        this.freeTile(o);
        this.stats.evicted++;
      }
    }
    return best;
  }

  /** a slot's corner in the atlas (px) and its size (round 112, TC21: its part's) */
  slotPx(t: Tile): [number, number, number, number] {
    const x = (t.slot % this.cols) * SW;
    const y = Math.floor(t.slot / this.cols) * SH;
    const [px, py, w, h] = PART_PX[t.q + 1];
    return [x + px, y + py, w, h];
  }

  /** (round 112, TC21) where what a tile was baked at is (tiles.wgsl TP: 2 vec4 each) — a quarter's place each, a part's
   *  its first quarter's */
  tpIndex(t: Tile): number {
    return t.slot * 4 + PART_FIRST[t.q + 1];
  }

  /** (round 105) what each slot was baked at (tiles.wgsl TP: 2 vec4 a slot) — a render-only tile's written by the GPU */
  get params(): GPUBuffer {
    return this.tparams;
  }

  /**
   * A bake's passes: `drawG` into the bake G-buffer (its viewport the slot's used vw x vh from the top left; its
   * pipelines and groups set, through the bake's camera), then `resolve` into the atlas at the slot (the first group
   * over the whole of it, the rest over that).
   */
  encodeBake(enc: GPUCommandEncoder, sx: number, sy: number, vw: number, vh: number, drawG: (g: GPURenderPassEncoder) => void, resolve: GPUBindGroup[]): void {
    const h = this.host;
    const g = enc.beginRenderPass({
      label: 'tiles-g',
      colorAttachments: [
        { view: this.gb0.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.gb1.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: this.gbD.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: h.profiler.timestamps('tiles-g'),
    });
    g.setViewport(0, 0, vw, vh, 0, 1);
    g.setScissorRect(0, 0, vw, vh);
    drawG(g);
    g.end();
    const r = enc.beginRenderPass({
      label: 'tiles-bake',
      colorAttachments: [
        { view: this.atlasA.createView(), loadOp: 'load', storeOp: 'store' },
        { view: this.atlasB.createView(), loadOp: 'load', storeOp: 'store' },
        { view: this.atlasLive.createView(), loadOp: 'load', storeOp: 'store' },
      ],
      timestampWrites: h.profiler.timestamps('tiles-bake'),
    });
    r.setViewport(sx, sy, vw, vh, 0, 1);
    r.setScissorRect(sx, sy, vw, vh);
    resolve.forEach((grp, i) => {
      r.setPipeline(i === 0 ? this.pipes!.bake : this.pipes!.over);
      r.setBindGroup(0, grp);
      r.draw(3);
    });
    r.end();
  }

  /** (round 104) the render-only land (tileland.ts): regions past the window made, meshed and baked */
  land?: LandMaker;

  /**
   * (round 105, `tileahead`) The regions past the window a tile should draw and none does yet, the camera's way
   * first (the user: "they seem to load in the direction opposite the camera panning"). Sampled at a 16 x 16 grid of
   * screen points (the ground at the focus's height under each) and the same grid moved on by the camera's motion
   * over PREFETCH_S (what the screen will show then). Ordered by when the screen reaches it (on it now: 0; ahead of it:
   * its share of PREFETCH_S), then how far ahead along the motion it lies (ahead before behind), then how near the
   * middle — at rest, nearest the middle first, as before. At most `n`.
   */
  wanted(cam: Camera, skip: (key: string) => boolean, n: number): { rx: number; ry: number; remake?: boolean }[] {
    if (!this.origin || cam.fly) return [];
    const [ox, oy] = this.origin;
    const W = this.host.world.w;
    const H = this.host.world.h;
    // (round 112, tilefix: points enough that every region on the screen has two across — 16 a side missed whole
    // regions between them at a wide zoom on a desktop: never asked for, the far land's flat colour there)
    const [ex, ey] = cam.screenDeltaToWorld(cam.viewportW, 0);
    const [fx, fy] = cam.screenDeltaToWorld(0, cam.viewportH);
    const G = Math.min(64, Math.max(16, Math.ceil((2 * Math.max(Math.hypot(ex, ey), Math.hypot(fx, fy) / ROW_H) * MARGIN) / R)));
    const crx = Math.floor((cam.target[0] + ox) / R);
    const cry = Math.floor((cam.target[1] / ROW_H + oy) / R);
    const [vx, vy] = this.vel;
    const sp = Math.hypot(vx, vy);
    // (moving: the screen's points ahead too, where the screen will be in PREFETCH_S — and round 106, tilephone: at
    // least AHEAD_CELLS on, a row of regions past the screen's edge: at a slow pan a second is a fraction of a region,
    // so the next row was asked for only as it came on; then the screen and a margin round it, the next to come on
    // whichever way the camera goes)
    const shifts = sp > MOVING ? [0, 1, 2] : [0, 2];
    const ahead = sp > MOVING ? Math.max(PREFETCH_S, AHEAD_CELLS / sp) : 0;
    const best = new Map<string, { rx: number; ry: number; k: number }>();
    for (const sh of shifts)
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const grow = sh === 2 ? MARGIN : 1;
          const sx = ((i + 0.5) / G - 0.5) * grow;
          const sy = ((j + 0.5) / G - 0.5) * grow;
          const [dx, dy] = cam.screenDeltaToWorld(sx * cam.viewportW, sy * cam.viewportH);
          const px = dx + (sh === 1 ? vx * ahead : 0);
          const py = dy + (sh === 1 ? vy * ahead : 0);
          const x = cam.target[0] + px;
          const y = (cam.target[1] + py) / ROW_H;
          if (x >= 0 && x < W && y >= 0 && y < H) continue;
          const rx = Math.floor((x + ox) / R);
          const ry = Math.floor((y + oy) / R);
          if (Math.abs(rx - crx) >= MASK_N / 2 || Math.abs(ry - cry) >= MASK_N / 2) continue;
          const key = `${rx},${ry}`;
          if (this.tiles.has(this.key(rx, ry, cam.azimuth)) || skip(key)) continue;
          // when the screen has it (s), how far ahead along the motion (cells), how far from the middle (cells)
          const along = sp > MOVING ? (px * vx + py * vy) / sp : 0;
          const k = sh * 1e6 - along * 100 + Math.hypot(px, py);
          const o = best.get(key);
          if (!o || k < o.k) best.set(key, { rx, ry, k });
        }
    const out: { rx: number; ry: number; remake?: boolean }[] = [...best.values()].sort((a, b) => a.k - b.k).slice(0, n);
    // (round 112, TC21: the atlas full — every slot's tile drawn — and some drawn bigger than the view now needs, the
    // whole slots a closer zoom baked, nearest first: each made again at the view's size, into where it was — its
    // slot's rest free for the tiles wanted)
    if (this.frame - this.starvedAt < 60 && out.length < n) {
      const now = this.partFor(this.basis(cam.viewProj), this.rpNow, REMAKE_Z);
      const big: { rx: number; ry: number; d: number }[] = [];
      for (const t of this.tiles.values()) {
        if (!t.gpu || PART_SIZE[t.q + 1] >= now || Math.round(t.az * 1e4) !== Math.round(cam.azimuth * 1e4) || !this.drawnSet.has(`${t.rx},${t.ry}`) || skip(`${t.rx},${t.ry}`)) continue;
        big.push({ rx: t.rx, ry: t.ry, d: Math.hypot(t.rx - crx, t.ry - cry) });
      }
      big.sort((a, b) => a.d - b.d);
      for (const b of big.slice(0, n - out.length)) out.push({ rx: b.rx, ry: b.ry, remake: true });
    }
    return out;
  }

  /** a tile of region (rx, ry) at this turn? */
  hasTile(rx: number, ry: number, az: number): boolean {
    return this.tiles.has(this.key(rx, ry, az));
  }

  /** (round 105) the camera's motion over the ground (world units a second, smoothed), and where it was */
  private vel: [number, number] = [0, 0];
  private velAt: { x: number; y: number; t: number } | null = null;
  /** the camera's motion this frame (its target in world units: the window's place added, so a slide isn't motion) */
  private track(cam: Camera): void {
    if (!this.origin) return;
    const x = cam.target[0] + this.origin[0];
    const y = cam.target[1] + this.origin[1] * ROW_H;
    const t = performance.now() / 1000;
    const p = this.velAt;
    this.velAt = { x, y, t };
    if (!p || t - p.t <= 0 || t - p.t > 0.5) return;
    const k = Math.min(1, (t - p.t) / 0.25);
    this.vel = [this.vel[0] + ((x - p.x) / (t - p.t) - this.vel[0]) * k, this.vel[1] + ((y - p.y) / (t - p.t) - this.vel[1]) * k];
  }

  /** (round 105) the camera's smoothed motion (world units a second: x, y) — the probe's and the land's */
  get motion(): [number, number] {
    return [this.vel[0], this.vel[1]];
  }

  /**
   * (round 105) The share of the screen in detail (the window's land or a tile's) on its leading and trailing
   * halves — split across the camera's motion (or `dir`, world x y); a 24 x 24 grid of points as coverage.
   */
  coverageSplit(cam: Camera, dir?: [number, number]): { lead: number; trail: number } {
    if (!this.origin || cam.fly) return { lead: 0, trail: 0 };
    const [ox, oy] = this.origin;
    const W = this.host.world.w;
    const H = this.host.world.h;
    const d = dir ?? this.vel;
    const dl = Math.hypot(d[0], d[1]) || 1;
    const G = 24;
    const n = [0, 0];
    const got = [0, 0];
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const [dx, dy] = cam.screenDeltaToWorld(((i + 0.5) / G - 0.5) * cam.viewportW, ((j + 0.5) / G - 0.5) * cam.viewportH);
        const side = (dx * d[0] + dy * d[1]) / dl >= 0 ? 0 : 1;
        n[side]++;
        const x = cam.target[0] + dx;
        const y = (cam.target[1] + dy) / ROW_H;
        if ((x >= 0 && x < W && y >= 0 && y < H) || this.drawnSet.has(`${Math.floor((x + ox) / R)},${Math.floor((y + oy) / R)}`)) got[side]++;
      }
    return { lead: n[0] ? got[0] / n[0] : 0, trail: n[1] ? got[1] / n[1] : 0 };
  }

  afterSubmit(): void {
    this.land?.afterSubmit();
  }

  /** the bake G-buffer's views (a render-only source's resolve groups bind them) */
  get gbufViews(): [GPUTextureView, GPUTextureView] {
    return [this.gb0.createView(), this.gb1.createView()];
  }

  private resolveGroup(src: TileSrc, cam: GPUBuffer): GPUBindGroup {
    const h = this.host;
    return h.device.createBindGroup({
      label: 'tiles-resolve',
      layout: h.resolveLayout,
      entries: [...h.meshEntries(src, cam), { binding: 40, resource: this.gb0.createView() }, { binding: 41, resource: this.gb1.createView() }, { binding: 22, resource: h.world.riverFlowView }, { binding: 47, resource: h.world.coverView }, { binding: 62, resource: h.world.riverWetView }],
    });
  }

  /**
   * The tiles past the window this frame: their quads (clip), slots, anchors, written for the draw, and the mask
   * of their regions for the rings. Not a region in the window (it draws itself), nor one on the eye's side of
   * the focus that would rise into the line to it (far.wgsl underFocus: the rings press that land down).
   */
  prepare(cam: Camera): void {
    this.drawCount = 0;
    this.drawnSet.clear();
    const md = this.maskData;
    md.fill(0xffffffff, 2);
    md[0] = 0;
    md[1] = MASK_N;
    if (this.on(cam)) {
      const h = this.host;
      const B = this.basis(cam.viewProj);
      const m = cam.viewProj;
      const [ox, oy] = this.origin!;
      const w0 = Math.floor(ox / R);
      const h0 = Math.floor(oy / R);
      const wn = h.world.w / R;
      const hn = h.world.h / R;
      const crx = Math.floor((cam.target[0] + ox) / R);
      const cry = Math.floor((cam.target[1] / ROW_H + oy) / R);
      const azk = Math.round(cam.azimuth * 1e4);
      const d = this.instData;
      let n = 0;
      let frozen = 0;
      this.stats.skipEye = this.stats.skipOff = this.stats.skipFar = 0;
      for (const t of this.tiles.values()) {
        if (Math.round(t.az * 1e4) !== azk) continue;
        const inWin = t.rx >= w0 && t.rx < w0 + wn && t.ry >= h0 && t.ry < h0 + hn;
        // (round 104, no pop-in: a region come into the window whose chunks the window draws none of yet — not built,
        // not the grid's — keeps its tile, drawn inside the window too, till the window has it)
        let arriving = false;
        if (inWin) {
          // (round 112, tilefast: a window region's tile is kept — not the least recently used because the window draws its
          // land itself — so it's there the frame its region leaves; it was evicted for the look-ahead's, the pan's pop-in behind)
          t.usedAt = this.frame;
          if (!this.arriving(t.rx - w0, t.ry - h0)) continue;
          arriving = true;
        }
        frozen++;
        t.skip = '';
        if (Math.abs(t.rx - crx) >= MASK_N / 2 || Math.abs(t.ry - cry) >= MASK_N / 2) {
          this.stats.skipFar++;
          t.skip = 'far';
          continue;
        }
        const aw = this.anchorWin(t.rx, t.ry);
        // (the eye's side of the focus: none that would rise into the line from the eye to it — a GPU-baked tile's top
        // isn't known here: not held back)
        const ra = B.r[0] * aw[0] + B.r[1] * aw[1] + B.r[2] * aw[2];
        const ua = B.u[0] * aw[0] + B.u[1] * aw[1] + B.u[2] * aw[2];
        const x0 = (ra + t.a0) * B.sx + m[12];
        const x1 = (ra + t.a0 + t.tw / t.dens) * B.sx + m[12];
        const y1 = (ua + t.b1) * B.sy + m[13];
        const y0 = (ua + t.b1 - t.th / t.dens) * B.sy + m[13];
        // (round 112, `tilefix2`, TF5 — the user's option (a): no tile is left out on the eye's side any more — the draw
        // cuts what of it would rise into the line from the eye to the focus, the rings' rule (tiles.wgsl fsTile, far.wgsl
        // underFocus); the whole tile left out was the far land's flat colour there, the pan bench's pop-in "eye")
        // (round 112, tilefix: a render-only tile too once its box is known — drawn off the screen it was "used" every
        // frame and never evicted: the atlas full of tiles off the screen)
        if ((!t.gpu || t.boxed) && (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1)) {
          this.stats.skipOff++;
          t.skip = 'off';
          continue;
        }
        const fa = B.f[0] * aw[0] + B.f[1] * aw[1] + B.f[2] * aw[2];
        const [sx, sy] = this.slotPx(t);
        d.set([ra * B.sx + m[12], ua * B.sy + m[13], B.sx, B.sy, sx, sy, this.tpIndex(t), arriving ? 1 : 0, aw[0], aw[1], aw[2], fa * B.sz + m[14], 0, 0, 0, 0], n * 16);
        const s = ((t.ry % MASK_N) + MASK_N) % MASK_N;
        const q = ((t.rx % MASK_N) + MASK_N) % MASK_N;
        md[2 + s * MASK_N + q] = ((t.rx & 0xffff) | (t.ry << 16)) >>> 0;
        t.usedAt = this.frame;
        this.drawnSet.add(`${t.rx},${t.ry}`);
        n++;
      }
      this.stats.frozen = frozen;
      md[0] = n > 0 ? 1 : 0;
      this.drawCount = n;
      if (n > 0) {
        h.device.queue.writeBuffer(this.inst, 0, d, 0, n * 16);
        const W = h.world.w + 0.5;
        const H = h.world.h * ROW_H;
        // (round 112, TF5: the focus — the camera's target, window units — for the eye side's cut; w 0: none, flying)
        const fo = cam.fly ? [0, 0, 0, 0] : [cam.target[0], cam.target[1], cam.target[2], 1];
        h.device.queue.writeBuffer(this.uni, 0, new Float32Array([...B.r, this.debug ? 1 : 0, ...B.u, 0, ...B.f, B.sz, W, H, R, OVERLAP, ...fo]));
      }
    }
    this.stats.drawn = this.drawCount;
    this.stats.used = this.tiles.size;
    const mk = md[0] ? Array.from(md.subarray(0, 2)).join() + this.drawSig() : '0';
    if (mk !== this.maskKey) {
      this.maskKey = mk;
      this.host.device.queue.writeBuffer(this.mask, 0, md);
    }
  }

  /** window region (i, j): none of its four chunks drawn by the window yet (not built — FieldMesh.built, kept across
   *  slides — nor the hybrid grid's) */
  private arriving(i: number, j: number): boolean {
    const fm = this.host.win.mesh;
    const [nx, ny] = fm.chunkGrid;
    if (fm.builtSlides !== fm.slides || fm.built.length !== nx * ny) return false;
    const grid = this.host.gridOn();
    for (let k = 0; k < 4; k++) {
      const cx = 2 * i + (k & 1);
      const cy = 2 * j + (k >> 1);
      if (cx >= nx || cy >= ny) continue;
      const c = cy * nx + cx;
      if (fm.built[c] || (grid && grid[c])) return false;
    }
    return true;
  }

  /**
   * (round 108, TC8) The render-only tiles (made on the GPU) of the regions meeting a box of the world (cells; on its
   * torus, W x H) let go, to be made again: what's stamped there (a settlement's plan) has landed since their land
   * was made. The window's own bakes are its land as it stands: they stay.
   */
  forgetMade(x0: number, y0: number, w: number, h: number, W: number, H: number): void {
    const mod = (v: number, n: number) => ((v % n) + n) % n;
    let n = 0;
    for (const t of [...this.tiles.values()]) {
      if (!t.gpu) continue;
      const meets = (a: number, size: number, b: number, len: number, wrap: number) => mod(a - b, wrap) < len || mod(b - a, wrap) < size;
      if (!meets(t.rx * R, R, x0, w, W) || !meets(t.ry * R, R, y0, h, H)) continue;
      this.freeTile(t);
      n++;
    }
    this.stats.remade += n;
  }

  /** the regions drawn last frame ("rx,ry") */
  private drawnSet = new Set<string>();
  /** (round 105, tilelatency) Does a tile draw region (rx, ry) this frame? */
  drawsRegion(rx: number, ry: number): boolean {
    return this.drawnSet.has(`${rx},${ry}`);
  }
  /** Does a tile draw window point (x cells, y rows) this frame? (the bench's detail share) */
  drawsAt(x: number, y: number): boolean {
    if (!this.origin) return false;
    return this.drawnSet.has(`${Math.floor((x + this.origin[0]) / R)},${Math.floor((y + this.origin[1]) / R)}`);
  }

  /**
   * (round 112, tilefast: the pan bench's why) Window point (x cells, y rows) past the window, not drawn by a tile: why —
   * its tile there but left out (eye, off, far, or its turn: 'turn' — baked at another), its land being made, made and
   * waiting for a bake, wanted and not started, or not asked for ('none').
   */
  whyMissing(x: number, y: number, az: number): string {
    if (!this.origin) return 'none';
    const rx = Math.floor((x + this.origin[0]) / R);
    const ry = Math.floor((y + this.origin[1]) / R);
    const t = this.tiles.get(this.key(rx, ry, az));
    if (t) return t.skip || 'tile';
    for (const o of this.tiles.values()) if (o.rx === rx && o.ry === ry) return 'turn';
    return this.land?.stateOf?.(`${rx},${ry}`) ?? 'none';
  }

  /** what's in the mask (its regions), to write it only when it changes */
  private drawSig(): string {
    let s = '';
    const d = this.instData;
    for (let i = 0; i < this.drawCount; i++) s += `${d[i * 16 + 8]},${d[i * 16 + 9]};`;
    return s;
  }

  /** Draw the tiles (in the world pass, its depth tested and written). */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.drawCount || !this.pipes) return;
    const h = this.host;
    this.drawGroup ??= h.device.createBindGroup({
      label: 'tiles-draw',
      layout: h.drawLayout,
      entries: [
        ...h.meshEntries(h.win, h.camBuf),
        { binding: 40, resource: this.gb0.createView() },
        { binding: 41, resource: this.gb1.createView() },
        { binding: 42, resource: this.atlasA.createView() },
        { binding: 43, resource: this.atlasB.createView() },
        { binding: 44, resource: { buffer: this.inst } },
        { binding: 45, resource: { buffer: this.uni } },
        { binding: 46, resource: { buffer: this.tparams } },
        // (round 108, TC20: the weather's cover, read as the tiles are drawn)
        { binding: 47, resource: h.world.coverView },
        { binding: 48, resource: this.atlasLive.createView() },
        // (round 109, watershed: the rivers' wetness by place — riverheld.wgsl riverWetAt)
        { binding: 62, resource: h.world.riverWetView },
      ],
    });
    pass.setPipeline(this.pipes.draw);
    pass.setBindGroup(0, this.drawGroup);
    pass.draw(6, this.drawCount);
    h.profiler.draws++;
  }

  /**
   * The share of the screen (a 24 x 24 grid of points, the ground at the focus's height under each) whose land is
   * the window's, and that a tile draws past it (0..1 each).
   */
  coverage(cam: Camera): { window: number; tiles: number } {
    if (!this.origin || cam.fly) return { window: 0, tiles: 0 };
    const [ox, oy] = this.origin;
    const W = this.host.world.w;
    const H = this.host.world.h;
    const G = 24;
    let win = 0;
    let tl = 0;
    const drawn = new Set<string>();
    const d = this.instData;
    for (let i = 0; i < this.drawCount; i++) {
      const rx = Math.round((d[i * 16 + 8] + ox) / R);
      const ry = Math.round((d[i * 16 + 9] / ROW_H + oy) / R);
      drawn.add(`${rx},${ry}`);
    }
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const [dx, dy] = cam.screenDeltaToWorld(((i + 0.5) / G - 0.5) * cam.viewportW, ((j + 0.5) / G - 0.5) * cam.viewportH);
        const x = cam.target[0] + dx;
        const y = (cam.target[1] + dy) / ROW_H;
        if (x >= 0 && x < W && y >= 0 && y < H) {
          win++;
          continue;
        }
        if (drawn.has(`${Math.floor((x + ox) / R)},${Math.floor((y + oy) / R)}`)) tl++;
      }
    return { window: win / (G * G), tiles: tl / (G * G) };
  }
}
