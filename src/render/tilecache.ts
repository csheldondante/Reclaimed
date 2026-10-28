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
import type { TileLand } from './tileland';

/** the streamer's region (cells; rows the same count) */
const R = 64;
/** the mask's side (regions): tiles within half of it of the camera are drawn */
const MASK_N = 64;
/** frames between a window region's bakes, at least (its look changes slowly: plants, stains, water) */
const REBAKE = Number(new URLSearchParams(location.search).get('tilerebake') ?? 600);
/** bakes a frame */
const PER_FRAME = Math.max(1, Number(new URLSearchParams(location.search).get('tilesper') ?? 1) | 0);
/** the atlas's budget (MB) and a slot's size (texels) */
const BUDGET_MB = Number(new URLSearchParams(location.search).get('tilemb') ?? 24);
const [SW, SH] = (new URLSearchParams(location.search).get('tilepx') ?? '128x192').split('x').map(Number);
/** bytes a texel: rgba8 (albedo, film) + rg32uint (normal and flags, depth) */
const TEXEL_BYTES = 12;
/** how far past its region a tile draws (cells; the bake takes the chunks round it in) */
const OVERLAP = 1;
/** ?tileland=0: no render-only land past the window (TC2) — only what the window baked */
const NO_LAND = new URLSearchParams(location.search).get('tileland') === '0';
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
  readonly stats = { bakes: 0, first: 0, again: 0, evicted: 0, drawn: 0, slots: 0, used: 0, mb: 0, frozen: 0, skipEye: 0, skipOff: 0, skipFar: 0 };
  private tiles = new Map<string, Tile>();
  private bySlot: (Tile | null)[];
  private atlasA: GPUTexture;
  private atlasB: GPUTexture;
  private gb0: GPUTexture;
  private gb1: GPUTexture;
  private gbD: GPUTexture;
  private cols: number;
  private bakers: Baker[] = [];
  private inst: GPUBuffer;
  private instData: Float32Array;
  private uni: GPUBuffer;
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
    this.bySlot = new Array(slots).fill(null);
    this.stats.slots = slots;
    this.stats.mb = +((slots * slotBytes) / 2 ** 20).toFixed(1);
    const RB = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.atlasA = dev.createTexture({ label: 'tiles A', size: [this.cols * SW, rows * SH], format: 'rgba8unorm', usage: RB });
    this.atlasB = dev.createTexture({ label: 'tiles B', size: [this.cols * SW, rows * SH], format: 'rg32uint', usage: RB });
    this.gb0 = dev.createTexture({ label: 'tiles gbuf0', size: [SW, SH], format: 'rgba32uint', usage: RB });
    this.gb1 = dev.createTexture({ label: 'tiles gbuf1', size: [SW, SH], format: 'rg32uint', usage: RB });
    this.gbD = dev.createTexture({ label: 'tiles gdepth', size: [SW, SH], format: host.depthFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    host.profiler.trackMemory('tiles', slots * slotBytes + SW * SH * (16 + 8 + 4));
    this.instData = new Float32Array(slots * 16);
    this.inst = dev.createBuffer({ label: 'tiles instances', size: this.instData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uni = dev.createBuffer({ label: 'tiles uniform', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.mask = dev.createBuffer({ label: 'tiles mask', size: this.maskData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    for (let k = 0; k < PER_FRAME; k++) this.bakers.push({ cam: dev.createBuffer({ label: `tiles bake camera ${k}`, size: host.camBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) });
    void this.makePipes();
  }

  private async makePipes(): Promise<void> {
    const h = this.host;
    const dev = h.device;
    const rl = dev.createPipelineLayout({ bindGroupLayouts: [h.resolveLayout] });
    const bakeT: GPUColorTargetState[] = [{ format: 'rgba8unorm' }, { format: 'rg32uint' }];
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
    this.origin = [ox, oy, oz];
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
    if (!this.on(cam)) return;
    const h = this.host;
    // (round 104, TC2: the land past the window no tile draws yet, made, meshed and baked a region at a time)
    if (this.land && !NO_LAND) {
      const B0 = this.basis(cam.viewProj);
      this.land.step(enc, cam, B0, (B0.sx * renderW) / 2);
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
        const rx = Math.floor(ox / R) + i;
        const ry = Math.floor(oy / R) + j;
        const t = this.tiles.get(this.key(rx, ry, az));
        let score: number;
        if (!t) score = 1e9;
        else if (Math.abs(Math.log(t.dens / Math.min(rp, this.fitDens(t)))) > 0.22) score = 1e8;
        // (the regions at the window's edge first: they're the ones that leave)
        else score = (this.frame - t.bakedAt) * (i === 0 || j === 0 || (i + 1) * R >= w || (j + 1) * R >= hh ? 2 : 1);
        if (score < REBAKE) continue;
        cand.push({ rx, ry, i, j, score });
      }
    cand.sort((a, b) => b.score - a.score);
    for (let k = 0; k < Math.min(PER_FRAME, cand.length); k++) this.bake(enc, cam, B, rp, cand[k], this.bakers[k]);
  }

  private key(rx: number, ry: number, az: number): string {
    return `${rx},${ry},${Math.round(az * 1e4)}`;
  }

  /** the texels a unit a tile of this extent fits its slot at */
  private fitDens(t: { a0: number; b1: number; tw: number; th: number; dens: number }): number {
    return Math.min((SW - 1) / (t.tw / t.dens), (SH - 1) / (t.th / t.dens));
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
    const dens = Math.min(rp, (SW - 1) / (a1 - a0), (SH - 1) / (b1 - b0));
    const tw = Math.min(SW, Math.ceil((a1 - a0) * dens) + 1);
    const th = Math.min(SH, Math.ceil((b1 - b0) * dens) + 1);
    const key = this.key(rx, ry, cam.azimuth);
    let t = this.tiles.get(key);
    if (!t) {
      let slot = this.bySlot.indexOf(null);
      if (slot < 0) {
        let old: Tile | null = null;
        for (const o of this.bySlot) if (o && o.usedAt < this.frame && (!old || o.usedAt < old.usedAt)) old = o;
        if (!old) return false;
        this.tiles.delete(this.key(old.rx, old.ry, old.az));
        slot = old.slot;
        this.stats.evicted++;
      }
      t = { rx, ry, az: cam.azimuth, slot, tw, th, dens, a0, b1, top: top + oz, bakedAt: 0, usedAt: this.frame };
      this.tiles.set(key, t);
      this.bySlot[slot] = t;
      this.stats.first++;
    } else this.stats.again++;
    Object.assign(t, { tw, th, dens, a0, b1, top: top + oz, bakedAt: this.frame, usedAt: this.frame });
    this.stats.bakes++;
    const sx = (t.slot % this.cols) * SW;
    const sy = Math.floor(t.slot / this.cols) * SH;
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
    const g = enc.beginRenderPass({
      label: 'tiles-g',
      colorAttachments: [
        { view: this.gb0.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.gb1.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: this.gbD.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: h.profiler.timestamps('tiles-g'),
    });
    g.setViewport(0, 0, tw, th, 0, 1);
    g.setScissorRect(0, 0, tw, th);
    drawG(g);
    g.end();
    const r = enc.beginRenderPass({
      label: 'tiles-bake',
      colorAttachments: [
        { view: this.atlasA.createView(), loadOp: 'load', storeOp: 'store' },
        { view: this.atlasB.createView(), loadOp: 'load', storeOp: 'store' },
      ],
      timestampWrites: h.profiler.timestamps('tiles-bake'),
    });
    r.setViewport(sx, sy, tw, th, 0, 1);
    r.setScissorRect(sx, sy, tw, th);
    resolve.forEach((grp, i) => {
      r.setPipeline(i === 0 ? this.pipes!.bake : this.pipes!.over);
      r.setBindGroup(0, grp);
      r.draw(3);
    });
    r.end();
    return true;
  }

  /** (round 104) the render-only land (tileland.ts): regions past the window made, meshed and baked */
  land?: TileLand;

  /**
   * (round 104, TC2) The region past the window a tile should draw and none does yet, nearest the middle of the
   * screen first (a 16 x 16 grid of screen points, the ground at the focus's height under each); null: none.
   */
  wanted(cam: Camera, skip: (key: string) => boolean): { rx: number; ry: number } | null {
    if (!this.origin || cam.fly) return null;
    const [ox, oy] = this.origin;
    const W = this.host.world.w;
    const H = this.host.world.h;
    const G = 16;
    let best: { rx: number; ry: number } | null = null;
    let bd = Infinity;
    const crx = Math.floor((cam.target[0] + ox) / R);
    const cry = Math.floor((cam.target[1] / ROW_H + oy) / R);
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const sx = (i + 0.5) / G - 0.5;
        const sy = (j + 0.5) / G - 0.5;
        const d = sx * sx + sy * sy;
        if (d >= bd) continue;
        const [dx, dy] = cam.screenDeltaToWorld(sx * cam.viewportW, sy * cam.viewportH);
        const x = cam.target[0] + dx;
        const y = (cam.target[1] + dy) / ROW_H;
        if (x >= 0 && x < W && y >= 0 && y < H) continue;
        const rx = Math.floor((x + ox) / R);
        const ry = Math.floor((y + oy) / R);
        if (Math.abs(rx - crx) >= MASK_N / 2 || Math.abs(ry - cry) >= MASK_N / 2) continue;
        if (this.tiles.has(this.key(rx, ry, cam.azimuth)) || skip(`${rx},${ry}`)) continue;
        best = { rx, ry };
        bd = d;
      }
    return best;
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
      entries: [...h.meshEntries(src, cam), { binding: 40, resource: this.gb0.createView() }, { binding: 41, resource: this.gb1.createView() }],
    });
  }

  /**
   * The tiles past the window this frame: their quads (clip), slots, anchors, written for the draw, and the mask
   * of their regions for the rings. Not a region in the window (it draws itself), nor one on the eye's side of
   * the focus that would rise into the line to it (far.wgsl underFocus: the rings press that land down).
   */
  prepare(cam: Camera): void {
    this.drawCount = 0;
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
      const ex = cam.eye[0];
      const ey = cam.eye[1];
      const el = Math.hypot(ex, ey) || 1;
      const tz = cam.target[2];
      const d = this.instData;
      let n = 0;
      let frozen = 0;
      this.stats.skipEye = this.stats.skipOff = this.stats.skipFar = 0;
      for (const t of this.tiles.values()) {
        if (Math.round(t.az * 1e4) !== azk) continue;
        const inWin = t.rx >= w0 && t.rx < w0 + wn && t.ry >= h0 && t.ry < h0 + hn;
        if (inWin) continue;
        frozen++;
        if (Math.abs(t.rx - crx) >= MASK_N / 2 || Math.abs(t.ry - cry) >= MASK_N / 2) {
          this.stats.skipFar++;
          continue;
        }
        const aw = this.anchorWin(t.rx, t.ry);
        // (the eye's side of the focus: none that would rise into the line from the eye to it)
        const ah = ((aw[0] + R / 2 - cam.target[0]) * ex + (aw[1] + (R * ROW_H) / 2 - cam.target[1]) * ey) / el;
        if (ah > 24) {
          const cap = tz + (ah - R * 0.75) * (cam.eye[2] / el) * 0.85;
          if (t.top - this.origin![2] > cap) {
            this.stats.skipEye++;
            continue;
          }
        }
        const ra = B.r[0] * aw[0] + B.r[1] * aw[1] + B.r[2] * aw[2];
        const ua = B.u[0] * aw[0] + B.u[1] * aw[1] + B.u[2] * aw[2];
        const x0 = (ra + t.a0) * B.sx + m[12];
        const x1 = (ra + t.a0 + t.tw / t.dens) * B.sx + m[12];
        const y1 = (ua + t.b1) * B.sy + m[13];
        const y0 = (ua + t.b1 - t.th / t.dens) * B.sy + m[13];
        if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) {
          this.stats.skipOff++;
          continue;
        }
        const fa = B.f[0] * aw[0] + B.f[1] * aw[1] + B.f[2] * aw[2];
        const sx = (t.slot % this.cols) * SW;
        const sy = Math.floor(t.slot / this.cols) * SH;
        d.set([x0, y0, x1, y1, sx, sy, t.tw, t.th, aw[0], aw[1], aw[2], fa * B.sz + m[14], t.a0, t.b1, t.dens, 0], n * 16);
        const s = ((t.ry % MASK_N) + MASK_N) % MASK_N;
        const q = ((t.rx % MASK_N) + MASK_N) % MASK_N;
        md[2 + s * MASK_N + q] = ((t.rx & 0xffff) | (t.ry << 16)) >>> 0;
        t.usedAt = this.frame;
        n++;
      }
      this.stats.frozen = frozen;
      md[0] = n > 0 ? 1 : 0;
      this.drawCount = n;
      if (n > 0) {
        h.device.queue.writeBuffer(this.inst, 0, d, 0, n * 16);
        const W = h.world.w + 0.5;
        const H = h.world.h * ROW_H;
        h.device.queue.writeBuffer(this.uni, 0, new Float32Array([...B.r, DEBUG ? 1 : 0, ...B.u, 0, ...B.f, B.sz, W, H, R, OVERLAP]));
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
