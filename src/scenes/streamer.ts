// The streamed world (round 66, BACKLOG Q28): the live world is a window of
// W × H columns onto land without an edge. When the camera nears the
// window's edge the window slides a region (REGION columns) that way:
//  - the regions leaving it are frozen: everything the world keeps per column
//    (the layers' chunk pages and every field that isn't derived each tick)
//    is copied out to a staging buffer and read back into `frozen`;
//  - everything per column on the GPU moves a region over (copies through a
//    scratch buffer; the textures through a scratch texture), and so does
//    what the CPU keeps in window coordinates (the camera, the weather, the
//    map's surface heights; the level shifts its own through onSlide);
//  - the layers don't move: every chunk has the same depth K, so the chunk
//    table is a page table — the chunks that left give their pages to the
//    ones coming in;
//  - the regions coming in are thawed from `frozen` exactly as they were
//    left, or generated the first time they're seen, by the level's
//    LandSource (world/streamgen.ts's noise, or the atlas: round 67), all of
//    a slide's asked for at once.
// The window slides in z too (round 69, when the land is taller than it —
// the atlas's): it holds world heights oz .. oz + zMax, and every column keeps
// what's above and below that (`outside`, world z) on the CPU. When the ground
// under the camera nears the window's top or bottom, the whole window is read
// back, each column joined with what's outside it and cut again a step higher
// or lower (layout.ts splitColumn / joinColumn); a frozen region keeps the oz
// it was left at, and is cut again the same way if it comes back at another.
// Frozen regions don't tick (deferred or coarse ticks are the next step).
// The sim waits while a slide is `busy` (only when a region coming in is
// still being read back from its last visit).

import { record, timed } from '../gpu/cpustat';
import { CHUNK, K_HEADROOM, SLOT_WORDS, addTop, fitColumn, joinColumn, lowerTop, packColumn, readSlot, splitColumn, type Interval } from '../world/layout';
import { ROW_H, cellAt } from '../world/lattice';
import { PROJ_K } from '../grids/structures';
import { generateRegion, type RegionLand } from '../world/streamgen';
import type { WorldCore } from './world-core';
import { SETTLE } from '../sim/sleep';
import { MATERIALS, MatState } from '../world/materials';

/**
 * (perfopt, ?settle=0 — DECISIONS round 83: land comes in settled, "fixed in the cheap generator") A column's loose
 * intervals with air under them dropped onto what's under them (touching the same material, joined), as the sediment
 * pass would have let them fall had the land woken to settle. Solids stay where they are (overhangs, arches).
 */
export function settleLoose(col: Interval[]): number {
  let moved = 0;
  let support = -Infinity;
  for (let k = 0; k < col.length; k++) {
    const iv = col[k];
    if (MATERIALS[iv.mat]?.state === MatState.Granular && k > 0 && iv.z0 > support + 1e-3) {
      const drop = iv.z0 - support;
      iv.z0 -= drop;
      iv.z1 -= drop;
      moved++;
      const below = col[k - 1];
      if (below.mat === iv.mat && Math.abs(below.z1 - iv.z0) < 1e-3) {
        below.z1 = iv.z1;
        col.splice(k, 1);
        k--;
        support = below.z1;
        continue;
      }
    }
    support = iv.z1;
  }
  return moved;
}

/** columns a side of a region: what the window slides by (whole chunks, an even number of rows) */
export const REGION = 64;
/** ?slideskip=freeze,bufs,texs,mesh (round 80, measuring a slide's GPU burst only: what's left out is wrong) */
const SLIDE_SKIP = new Set((typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('slideskip') ?? '').split(',').filter(Boolean));
/** cells the window slides by in z */
export const TIER = 32;
/** the field mesh's chunks: cells across and rows down (fieldmesh.ts CHUNK) — a slide is whole ones */
const MESH_CHUNK = 32;

/** Where new land comes from: a region of w × h world cells from (x0, y0), y0 even, in world z. */
export interface LandSource {
  region(x0: number, y0: number, w: number, h: number, zMax: number): Promise<RegionLand>;
  /** the world's size in cells when it wraps (a torus: frozen regions are kept by where they are on it) */
  wrap?: [number, number];
  /** the land's height when it's taller than the window: the window slides in z (round 69) */
  height?: number;
  /** (round 71: a coarse world that changes while a region is away) what it is round a region now, and what has
   *  changed at a world cell since then — rock taken (−) or added, loose ground and its material, water */
  snapshot?(x0: number, y0: number, w: number, h: number): Promise<unknown>;
  changes?(snap: unknown, x0: number, y0: number, w: number, h: number): Promise<((x: number, y: number) => LandChange) | null>;
}

/** what changed at a world cell while its region was away (LandSource.changes) */
export interface LandChange {
  dr: number;
  /** rock added is this (0: stone) */
  cap: number;
  dl: number;
  lmat: number;
  dw: number;
}

/** a column's top changed by `d` (world z): rock off or on, loose ground on (layout.ts lowerTop / addTop) */
export function applyChange(col: Interval[], d: { dr: number; cap?: number; dl: number; lmat: number }): void {
  if (d.dr < -0.05) lowerTop(col, -d.dr);
  else if (d.dr > 0.05) addTop(col, d.dr, d.cap || 1);
  if (d.dl > 0.05 && d.lmat) addTop(col, d.dl, d.lmat);
}

/** round 66's land: noise of world position (world/streamgen.ts), without an edge */
export const noiseLand = (seed = 1): LandSource => ({
  region: async (x0, y0, w, h, zMax) => generateRegion(x0, y0, w, h, zMax, seed),
});

/** a per-column buffer: `stride` bytes a column, in `planes` w × h arrays; kept = frozen with its region */
interface ColBuf {
  name: string;
  buf: GPUBuffer;
  stride: number;
  planes: number;
  keep: boolean;
}

/** a per-column texture: `per` texels across a column (proj), or one texel per `div` × `div` columns (the wind) */
interface ColTex {
  name: string;
  tex: GPUTexture;
  per: number;
  div: number;
  keep: boolean;
  /** what a column coming in starts with (default 0) */
  fill?: [number, number, number, number];
}

/** a region as it was left */
interface Frozen {
  /** (generated only) the box (region cells) round what the structural system should judge */
  judge?: [number, number, number, number];
  /** the window's oz its layers are cut at, and each column's intervals outside that (world z) */
  oz: number;
  outside: Interval[][];
  /** the land source's snapshot when it was made or left (LandSource.snapshot) */
  snap?: unknown;
  /** the ground's own top a column (window z at oz: under what stands on it), when the source says */
  ground?: Float32Array;
  /** its chunks' pages, chunk by chunk (row-major in the region) */
  layers: Uint32Array;
  /** each kept buffer's columns: per plane, REGION rows of REGION × stride bytes */
  bufs: Record<string, Uint8Array>;
  /** each kept texture's texels, rows of the region's width (rgba32float) */
  texs: Record<string, Float32Array>;
  surface: Float32Array;
}

export interface SlideStats {
  slides: number;
  frozen: number;
  generated: number;
  thawed: number;
  /** of those generated, how many were ready before the slide (prefetch) */
  prefetched: number;
  /** slides in z, and regions cut again at another oz when they came in */
  tiers: number;
  resliced: number;
  /** columns with more intervals than the window holds (their closest made one: layout.ts fitColumn) */
  fitted: number;
  /** regions that came back changed (the coarse world: LandSource.changes) */
  changed: number;
  /** (perfopt, settle=0) columns come in with loose ground dropped onto its support (settleLoose) */
  settled: number;
  /** the last slide: ms from start to the regions coming in written */
  lastMs: number;
}

export class Streamer {
  readonly W: number;
  readonly H: number;
  readonly R = REGION;
  /** the world cell of window column 0, row 0 */
  readonly origin: [number, number] = [0, 0];
  /** regions out of the window, as they were left ("rx,ry" in regions) */
  readonly frozen = new Map<string, Frozen | Promise<Frozen>>();
  /**
   * A slide (or a warp, a cut in z) under way. (Round 83: while it is, the meshes aren't made — a chunk made
   * from land still being written came out half made, a hole till it was made again; the rings show the land
   * not made yet: Renderer.holdMesh.)
   */
  get busy(): boolean {
    return this.busyNow;
  }
  set busy(v: boolean) {
    this.busyNow = v;
    this.core.renderer.holdMesh = v;
  }
  private busyNow = false;
  /** slide on its own as the camera nears the edge (tests turn it off to slide by hand) */
  auto = true;
  readonly stats: SlideStats = { slides: 0, frozen: 0, generated: 0, thawed: 0, prefetched: 0, lastMs: 0, tiers: 0, resliced: 0, fitted: 0, changed: 0, settled: 0 };
  /** called after each slide with the shift in columns (the window moved by dx, dy: content moved by −dx, −dy), and in z */
  readonly onSlide: ((dx: number, dy: number, dz: number) => void)[] = [];
  /** the world height of the window's z = 0 */
  oz = 0;
  /** per window column: its intervals above and below the window (world z) */
  outside: Interval[][];
  /** what a column may hold (the chunks' K less their headroom) */
  private colK: number;
  /** per window column: the ground's own top (window z; round 75: a slide in z goes by it, not by what
   *  stands on it — a giant's point under the camera isn't where the land is) */
  readonly ground: Float32Array;
  /** called when land comes into the window that the structural system should judge: the box (window cells) round it */
  readonly onArrive: ((x0: number, y0: number, x1: number, y1: number) => void)[] = [];
  /** the window was moved somewhere else entirely (warp): its new origin and oz — what the game keeps in window coordinates is void */
  readonly onWarp: ((ox: number, oy: number, oz: number) => void)[] = [];
  private bufs: ColBuf[];
  private texs: ColTex[];
  private scratch: GPUBuffer;
  private scratchTex = new Map<string, GPUTexture>();
  /** slots a chunk page holds (every chunk has the same K) */
  private pageSlots: number;
  private K: number;

  constructor(
    private core: WorldCore,
    private source: LandSource = noiseLand(),
    origin: [number, number] = [0, 0],
    /** the first window's oz and what's outside it (the atlas's window), the ground's tops (window z) */
    tier?: { oz: number; outside: Interval[][]; ground?: Float32Array },
  ) {
    const { w, h } = core.dims;
    this.oz = tier?.oz ?? 0;
    if (this.oz % TIER) throw new Error(`the window's oz must be whole tiers of ${TIER}`);
    this.outside = tier?.outside ?? Array.from({ length: w * h }, () => []);
    this.ground = tier?.ground ? tier.ground.slice() : core.map.surface.slice();
    if (this.outside.length !== w * h) throw new Error('the window needs what lies outside every column');
    if (origin[0] % REGION || origin[1] % REGION) throw new Error(`the window's origin must be whole regions of ${REGION}`);
    this.origin[0] = origin[0];
    this.origin[1] = origin[1];
    core.globals.origin = [origin[0], origin[1]];
    const R = this.R;
    if (w % R || h % R) throw new Error(`the window (${w} × ${h}) must be whole regions of ${R}`);
    this.W = w;
    this.H = h;
    const t = core.packed.chunkTable;
    this.K = t[1];
    for (let c = 0; c < t.length / 2; c++) if (t[c * 2 + 1] !== this.K) throw new Error('a streamed world needs the same K in every chunk');
    this.pageSlots = this.K * CHUNK * CHUNK;
    this.colK = this.K - K_HEADROOM;
    const wg = core.world;
    const b = (name: keyof typeof wg, stride: number, keep: boolean, planes = 1): ColBuf => ({ name, buf: wg[name] as GPUBuffer, stride, planes, keep });
    this.bufs = [
      // the world's state: frozen with its region
      b('water', 4, true),
      b('waterSource', 4, true),
      b('oil', 4, true),
      b('oilStored', 8, true),
      b('lava', 16, true),
      b('contam', 8, true),
      b('moisture', 4, true),
      b('veg', 4, true),
      b('fire', 4, true),
      b('petals', 4, true),
      b('wilt', 16, true),
      b('bend', 16, true),
      // in flight or derived: moved with the window so nothing jumps for a tick
      b('surface', 4, false),
      b('waterNext', 4, false),
      b('waterPrev', 4, false),
      // (perfopt, ?settle=0: frozen with its region, so land that comes back in asleep is drawn flowing as it was)
      b('flux', 24, !SETTLE),
      b('oilNext', 4, false),
      b('oilFlux', 24, false),
      b('lavaNext', 16, false),
      b('lavaFlux', 24, false),
      b('contamNext', 8, false),
      b('moistureNext', 4, false),
      b('vegNext', 4, false),
      b('fireNext', 4, false),
      b('renderFields', 16, false),
      b('deposit', 16, false),
      b('contamDelta', 4, false, 2),
      b('physCols', 32, false),
      b('places', 4, false),
    ];
    const tx = (name: keyof typeof wg, keep: boolean, per = 1, div = 1, fill?: ColTex['fill']): ColTex => ({ name, tex: wg[name] as GPUTexture, per, div, keep, fill });
    const none: ColTex['fill'] = [-1, 0, 0, 0];
    this.texs = [
      tx('shake', true),
      tx('lavaSpring', true),
      // (round 84: the atlas's rivers at their steady state — frozen with its region, as what's held there)
      tx('riverFlow', true),
      tx('drift', false),
      tx('air', false),
      tx('strata', false),
      tx('levels', false),
      tx('bodyProj', false, 1, 1, none),
      tx('bodyCpu', false, 1, 1, none),
      tx('foreign', false),
      tx('proj', false, PROJ_K),
      tx('sparkTex', false),
      tx('editState', false),
      tx('editStateNext', false),
      tx('windField', false, 1, 2),
      tx('windFieldNext', false, 1, 2),
    ];
    for (const x of this.bufs) if (x.buf.size < w * h * x.stride * x.planes) throw new Error(`${x.name}: ${x.buf.size} bytes, not ${x.stride} a column`);
    const big = Math.max(...this.bufs.map((x) => x.buf.size));
    this.scratch = wg.buf('streamScratch', big, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  }

  /** The world cell under window cell (x, y). */
  toWorld(x: number, y: number): [number, number] {
    return [x + this.origin[0], y + this.origin[1]];
  }

  /** land asked for ahead of a slide, by region key */
  private pending = new Map<string, Promise<Frozen>>();

  /** Slide when the camera has come within 1¼ regions of the window's edge (one axis a call);
   *  ask for the land of the slide it's heading for once it's halfway there. */
  update(): Promise<void> | null {
    if (this.busy || !this.auto) return null;
    const [x, yw] = this.core.camera.target;
    const y = yw / ROW_H;
    const R = this.R;
    const reach = R * 0.75;
    const near = R * 0.4;
    if (x > this.W / 2 + near) this.prefetch(R, 0);
    if (x < this.W / 2 - near) this.prefetch(-R, 0);
    if (y > this.H / 2 + near) this.prefetch(0, R);
    if (y < this.H / 2 - near) this.prefetch(0, -R);
    // in z: the ground under the camera near the window's top or bottom
    const h = this.source.height;
    if (h) {
      const [cx, cy] = cellAt(x, yw);
      if (cx >= 0 && cy >= 0 && cx < this.W && cy < this.H) {
        const g = this.ground[cy * this.W + cx];
        const zMax = this.core.dims.zMax;
        if (g > zMax - 40 && this.oz + zMax < h) return this.slideZ(TIER);
        if (g < 24 && this.oz > 0) return this.slideZ(-TIER);
      }
    }
    if (x > this.W / 2 + reach) return this.slide(R, 0);
    if (x < this.W / 2 - reach) return this.slide(-R, 0);
    if (y > this.H / 2 + reach) return this.slide(0, R);
    if (y < this.H / 2 - reach) return this.slide(0, -R);
    return null;
  }

  /** Move the window by (dx, dy) columns (one of them ±REGION, the other 0). */
  async slide(dx: number, dy: number): Promise<void> {
    if ((dx !== 0) === (dy !== 0) || Math.abs(dx + dy) !== this.R) throw new Error('a slide is one region along one axis');
    this.busy = true;
    const t0 = performance.now();
    try {
      await this.slideNow(dx, dy);
    } finally {
      this.busy = false;
    }
    this.stats.slides++;
    this.stats.lastMs = +(performance.now() - t0).toFixed(1);
  }

  private key(rx: number, ry: number): string {
    const w = this.source.wrap;
    if (w) {
      const nx = w[0] / this.R;
      const ny = w[1] / this.R;
      rx = ((rx % nx) + nx) % nx;
      ry = ((ry % ny) + ny) % ny;
    }
    return `${rx},${ry}`;
  }

  /** the regions coming in with a slide of (dx, dy), as [local x, local y] corners in the window after it */
  private enteringFor(dx: number, dy: number): [number, number][] {
    const { W, H } = this;
    return dx > 0 ? this.strip(W - dx, W, 0, H) : dx < 0 ? this.strip(0, -dx, 0, H) : dy > 0 ? this.strip(0, W, H - dy, H) : this.strip(0, W, 0, -dy);
  }

  /** Start making the land a slide of (dx, dy) would bring in (what's frozen needs nothing). */
  prefetch(dx: number, dy: number): void {
    const R = this.R;
    for (const [lx, ly] of this.enteringFor(dx, dy)) {
      const wx = this.origin[0] + dx + lx;
      const wy = this.origin[1] + dy + ly;
      const key = this.key(wx / R, wy / R);
      if (this.frozen.has(key) || this.pending.has(key)) continue;
      const job = this.generate(wx, wy);
      job.catch(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
  }

  /** the regions of a strip of the window (local cells x0..x1, y0..y1), as [local x, local y] corners */
  private strip(x0: number, x1: number, y0: number, y1: number): [number, number][] {
    const out: [number, number][] = [];
    for (let y = y0; y < y1; y += this.R) for (let x = x0; x < x1; x += this.R) out.push([x, y]);
    return out;
  }

  private async slideNow(dx: number, dy: number): Promise<void> {
    const tSync = performance.now();
    // (a readback that straddles the slide is stale: round 80)
    this.core.windowEpoch++;
    const { core, W, H, R } = this;
    const dev = core.host.gpu.device;
    const wg = core.world;
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const cy = H / CHUNK;
    const rc = R / CHUNK;
    // what leaves (old window cells) and what comes in (new window cells)
    const leaving = dx > 0 ? this.strip(0, dx, 0, H) : dx < 0 ? this.strip(W + dx, W, 0, H) : dy > 0 ? this.strip(0, W, 0, dy) : this.strip(0, W, H + dy, H);
    const entering = this.enteringFor(dx, dy);

    // ---- 1. freeze what leaves: copies into one staging buffer ---------------
    const enc = dev.createCommandEncoder({ label: 'stream slide' });
    const kept = this.bufs.filter((b) => b.keep);
    const keptT = this.texs.filter((t) => t.keep);
    const pageBytes = this.pageSlots * SLOT_WORDS * 4;
    const regionBytes = rc * rc * pageBytes + kept.reduce((s, b) => s + R * R * b.stride * b.planes, 0) + keptT.reduce((s, t) => s + align256((R / t.div) * t.per * 16) * (R / t.div), 0);
    const staging = dev.createBuffer({ label: 'stream freeze', size: regionBytes * leaving.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let off = 0;
    for (const [lx, ly] of SLIDE_SKIP.has('freeze') ? [] : leaving) {
      for (let j = 0; j < rc; j++)
        for (let i = 0; i < rc; i++) {
          const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
          enc.copyBufferToBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, staging, off, pageBytes);
          off += pageBytes;
        }
      for (const b of kept)
        for (let p = 0; p < b.planes; p++)
          for (let r = 0; r < R; r++) {
            enc.copyBufferToBuffer(b.buf, p * W * H * b.stride + ((ly + r) * W + lx) * b.stride, staging, off, R * b.stride);
            off += R * b.stride;
          }
      for (const t of keptT) {
        const tw = (R / t.div) * t.per;
        const th = R / t.div;
        const row = align256(tw * 16);
        enc.copyTextureToBuffer({ texture: t.tex, origin: [(lx / t.div) * t.per, ly / t.div] }, { buffer: staging, offset: off, bytesPerRow: row }, [tw, th]);
        off += row * th;
      }
    }

    record('slide.freeze', performance.now() - tSync);
    // ---- 2. everything per column moves a region over ------------------------
    // (and the per-column buffers of what the game installed: the agents' fields — round 80)
    const mods = this.moduleBufs();
    if (!SLIDE_SKIP.has('bufs')) for (const b of [...this.bufs, ...mods]) this.shiftBuf(enc, b, dx, dy);
    if (!SLIDE_SKIP.has('texs')) for (const t of this.texs) this.shiftTex(enc, t, dx, dy);
    // (particles in the air: dropped — Q28 follow-up: move them with a kernel)
    enc.clearBuffer(wg.particles);
    // what comes in starts empty where nothing is frozen for it
    for (const [lx, ly] of entering)
      for (const b of [...this.bufs, ...mods]) {
        if (b.keep) continue;
        for (let p = 0; p < b.planes; p++) for (let r = 0; r < R; r++) enc.clearBuffer(b.buf, p * W * H * b.stride + ((ly + r) * W + lx) * b.stride, R * b.stride);
      }
    dev.queue.submit([enc.finish()]);
    const leftKeys = leaving.map(([lx, ly]) => this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R));
    const leftOut = leaving.map(([lx, ly]) => {
      const o: Interval[][] = [];
      for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) o.push(this.outside[(ly + r) * W + lx + c]);
      return o;
    });
    const oz = this.oz;
    const leftSnaps = leaving.map(([lx, ly]) => this.source.snapshot?.(this.origin[0] + lx, this.origin[1] + ly, R, R));
    const read = staging.mapAsync(GPUMapMode.READ).then(() => {
      const all = new Uint8Array(staging.getMappedRange()).slice();
      staging.unmap();
      staging.destroy();
      const out: Frozen[] = [];
      let o = 0;
      for (let k = 0; k < leaving.length; k++) {
        const f: Frozen = { layers: new Uint32Array(all.buffer, o, (rc * rc * pageBytes) / 4).slice(), bufs: {}, texs: {}, surface: new Float32Array(R * R), oz, outside: leftOut[k] };
        o += rc * rc * pageBytes;
        for (const b of kept) {
          const n = R * R * b.stride * b.planes;
          f.bufs[b.name] = all.slice(o, o + n);
          o += n;
        }
        for (const t of keptT) {
          const tw = (R / t.div) * t.per;
          const th = R / t.div;
          const row = align256(tw * 16);
          const d = new Float32Array(tw * th * 4);
          for (let r = 0; r < th; r++) d.set(new Float32Array(all.buffer, o + r * row, tw * 4), r * tw * 4);
          f.texs[t.name] = d;
          o += row * th;
        }
        out.push(f);
      }
      return out;
    });
    // the CPU's surface heights for what leaves (the weather's, the level's cache)
    const surf = core.map.surface;
    const leftSurf = leaving.map(([lx, ly]) => {
      const s = new Float32Array(R * R);
      for (let r = 0; r < R; r++) s.set(surf.subarray((ly + r) * W + lx, (ly + r) * W + lx + R), r * R);
      return s;
    });
    const leftGround = leaving.map(([lx, ly]) => {
      const s = new Float32Array(R * R);
      for (let r = 0; r < R; r++) s.set(this.ground.subarray((ly + r) * W + lx, (ly + r) * W + lx + R), r * R);
      return s;
    });
    leftKeys.forEach((k, i) =>
      this.frozen.set(
        k,
        Promise.all([read, leftSnaps[i]]).then(([fs, snap]) => {
          const f = fs[i];
          f.snap = snap;
          f.surface = leftSurf[i];
          f.ground = leftGround[i];
          this.frozen.set(k, f);
          return f;
        }),
      ),
    );
    this.stats.frozen += leaving.length;

    record('slide.move', performance.now() - tSync);
    // ---- 3. the chunk table: pages move, the leaving chunks' pages are reused --
    const old = table.slice();
    const dcx = dx / CHUNK;
    const dcy = dy / CHUNK;
    const free: number[] = [];
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const ni = i - dcx;
        const nj = j - dcy;
        if (ni < 0 || nj < 0 || ni >= cx || nj >= cy) free.push(old[(j * cx + i) * 2]);
      }
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const si = i + dcx;
        const sj = j + dcy;
        table[(j * cx + i) * 2] = si >= 0 && sj >= 0 && si < cx && sj < cy ? old[(sj * cx + si) * 2] : free.pop()!;
      }
    dev.queue.writeBuffer(wg.chunks, 0, table);

    record('slide.table', performance.now() - tSync);
    // ---- 4. the CPU's window coordinates move too ------------------------------
    this.origin[0] += dx;
    this.origin[1] += dy;
    core.globals.origin = [this.origin[0], this.origin[1]];
    shiftGrid(surf, W, H, 1, dx, dy);
    shiftGrid(this.outside, W, H, 1, dx, dy);
    shiftGrid(this.ground, W, H, 1, dx, dy);
    core.camera.shift(dx, dy * ROW_H, 0);
    // (what the game installed that lives in window coordinates: units, bodies — round 80)
    for (const f of core.onShift) f(dx, dy * ROW_H, 0);
    // (what's built moves with the land: round 73, nothing is built again but what came in fresh)
    core.renderer.windowMoved(dx / MESH_CHUNK, dy / MESH_CHUNK, [-dx, -dy * ROW_H, 0]);
    record('slide.grids', performance.now() - tSync);
    core.renderer.band?.shift(dx, dy);
    record('slide.band', performance.now() - tSync);
    core.weather.shift(dx, dy * ROW_H);
    record('slide.weather', performance.now() - tSync);
    core.clearUndo();
    record('slide.undo', performance.now() - tSync);
    this.onSlide.forEach((f, k) => {
      const t = performance.now();
      f(dx, dy, 0);
      record(`slide.cb${k}`, performance.now() - t);
    });

    record('slide', performance.now() - tSync);
    // ---- 5. what comes in: thawed, or generated (all of them asked for at once) ----
    const coming = entering.map(([lx, ly]) => {
      const key = this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R);
      const got = this.frozen.get(key);
      if (got) {
        this.frozen.delete(key);
        this.stats.thawed++;
        return got;
      }
      this.stats.generated++;
      const ahead = this.pending.get(key);
      if (ahead) {
        this.pending.delete(key);
        this.stats.prefetched++;
        return ahead;
      }
      return this.generate(this.origin[0] + lx, this.origin[1] + ly);
    });
    for (let k = 0; k < entering.length; k++) {
      const [lx, ly] = entering[k];
      this.write(await this.since(await coming[k], this.origin[0] + lx, this.origin[1] + ly), lx, ly);
    }
    // (round 80: the band's pages went with the land; only what came in is packed)
    timed('band', () => this.core.renderer.band?.packFresh(this.outside, this.core.dims.zMax));
    this.core.windowEpoch++;
  }

  /** What's outside the window, drawn (round 79: the renderer's band, when it has one). */
  refreshBand(): void {
    timed('band', () => this.core.renderer.band?.update(this.outside, this.oz, this.core.dims.zMax));
  }

  /** a region's land the first time it is seen, in the frozen form (cut at the window's oz now) */
  private async generate(x0: number, y0: number): Promise<Frozen> {
    const { R } = this;
    const zMax = this.core.dims.zMax;
    const [land, snap] = await Promise.all([this.source.region(x0, y0, R, R, zMax), this.source.snapshot?.(x0, y0, R, R)]);
    return timed('cut', () => this.cutRegion(land, snap));
  }

  private cutRegion(land: RegionLand, snap: Frozen['snap']): Frozen {
    const { R } = this;
    const zMax = this.core.dims.zMax;
    const oz = this.oz;
    const rc = R / CHUNK;
    const layers = new Uint32Array(rc * rc * this.pageSlots * SLOT_WORDS);
    const outside: Interval[][] = [];
    const surface = new Float32Array(R * R);
    for (let y = 0; y < R; y++)
      for (let x = 0; x < R; x++) {
        const i = y * R + x;
        // (perfopt, settle=0: nothing loose comes in floating — it won't wake to fall)
        if (!SETTLE && settleLoose(land.cols[i])) this.stats.settled++;
        const cut = splitColumn(land.cols[i], oz, zMax);
        outside.push(cut.outside);
        this.place(layers, x, y, cut.inside);
        surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        // (the ground's top out of the window: what lies on it isn't here)
        if (!topInside(cut, oz, zMax)) {
          land.water[i] = 0;
          if (land.waterSource) land.waterSource[i] = 0;
          if (land.riverFlow) land.riverFlow.fill(0, i * 4, i * 4 + 4);
          if (land.lava) land.lava.fill(0, i * 4, i * 4 + 4);
        } else if (land.lava && land.lava[i * 4] > 0) land.lava[i * 4 + 3] -= oz;
      }
    const bytes = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bufs: Record<string, Uint8Array> = {
      water: bytes(land.water),
      moisture: bytes(land.moisture),
      veg: bytes(land.vegetation),
      contam: bytes(land.contam),
      petals: bytes(new Float32Array(R * R).fill(1)),
    };
    if (land.lava) bufs.lava = bytes(land.lava);
    if (land.waterSource) bufs.waterSource = bytes(land.waterSource);
    const texs: Record<string, Float32Array> = {};
    const judge = land.structural ? boxOf(land.structural, R) : undefined;
    if (land.lavaSpring) {
      const t = new Float32Array(R * R * 4);
      for (let k = 0; k < R * R; k++) t[k * 4] = land.lavaSpring[k];
      texs.lavaSpring = t;
    }
    if (land.riverFlow) texs.riverFlow = land.riverFlow;
    const ground = land.ground ? land.ground.map((v) => v - oz) : undefined;
    return { layers, bufs, texs, surface, judge, oz, outside, snap, ground };
  }

  /** a region coming in with what changed while it was away (LandSource.changes since its snapshot) */
  private async since(f: Frozen, x0: number, y0: number): Promise<Frozen> {
    const { R } = this;
    if (!this.source.changes || f.snap === undefined) return f;
    const at = await this.source.changes(f.snap, x0, y0, R, R);
    if (!at) return f;
    const zMax = this.core.dims.zMax;
    const layers = f.layers.slice();
    const outside = f.outside.slice();
    const surface = f.surface.slice();
    const water = f.bufs.water ? new Float32Array(f.bufs.water.slice().buffer) : undefined;
    const veg = f.bufs.veg ? new Float32Array(f.bufs.veg.slice().buffer) : undefined;
    let n = 0;
    for (let y = 0; y < R; y++)
      for (let x = 0; x < R; x++) {
        const d = at(x0 + x, y0 + y);
        if (Math.abs(d.dr) < 0.05 && d.dl < 0.05 && d.dw < 0.02) continue;
        const i = y * R + x;
        const full = joinColumn(this.columnOf(f.layers, x, y), f.oz, f.outside[i]);
        applyChange(full, d);
        const cut = splitColumn(full, f.oz, zMax);
        outside[i] = cut.outside;
        this.place(layers, x, y, cut.inside);
        surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        if (water && d.dw > 0) water[i] += d.dw;
        if (veg && d.dl > 0.05) veg[i] *= Math.max(0, 1 - d.dl * 2);
        n++;
      }
    if (!n) return f;
    this.stats.changed++;
    const bufs = { ...f.bufs };
    if (water) bufs.water = new Uint8Array(water.buffer);
    if (veg) bufs.veg = new Uint8Array(veg.buffer);
    return { ...f, layers, outside, surface, bufs, snap: undefined };
  }

  /**
   * Change the live window's columns in the box (window cells x0..x1, y0..y1) by `at(x, y)` (window
   * cells; layout.ts lowerTop / addTop, world z): read back, changed, written — an event in sight.
   */
  async editLive(x0: number, y0: number, x1: number, y1: number, at: (x: number, y: number) => { dr: number; cap?: number; dl: number; lmat: number } | null): Promise<number> {
    const { core, W, H } = this;
    const dev = core.host.gpu.device;
    const wg = core.world;
    const zMax = core.dims.zMax;
    const [layersBuf, vegBuf] = await Promise.all([core.readBuffer('layers'), core.readBuffer('veg')]);
    const slots = new Uint32Array(layersBuf.buffer, layersBuf.byteOffset, layersBuf.byteLength / 4);
    const veg = new Float32Array(vegBuf.buffer, vegBuf.byteOffset, W * H);
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const K = this.K;
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const d = at(x, y);
        if (!d || (Math.abs(d.dr) < 0.05 && d.dl < 0.05)) continue;
        const i = y * W + x;
        const ci = Math.floor(y / CHUNK) * cx + Math.floor(x / CHUNK);
        const base = table[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
        const was: Interval[] = [];
        for (let s = 0; s < K; s++) {
          const iv = readSlot(slots, base + s);
          if (!iv) break;
          was.push(iv);
        }
        const full = joinColumn(was, this.oz, this.outside[i]);
        applyChange(full, d);
        const cut = splitColumn(full, this.oz, zMax);
        if (fitColumn(cut.inside, this.colK)) this.stats.fitted++;
        this.outside[i] = cut.outside;
        slots.set(packColumn(cut.inside, K), base * SLOT_WORDS);
        core.map.surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        this.ground[i] += d.dr + (d.dl > 0.05 ? d.dl : 0);
        if (d.dl > 0.05) veg[i] *= Math.max(0, 1 - d.dl * 2);
        n++;
      }
    if (n) {
      for (const b of [wg.layers, wg.layersNext]) dev.queue.writeBuffer(b, 0, slots);
      for (const b of [wg.veg, wg.vegNext]) dev.queue.writeBuffer(b, 0, veg);
      core.clearUndo();
    }
    return n;
  }

  /** column (x, y) of a region (window z) into its layers' pages, fitted to what a column may hold */
  private place(layers: Uint32Array, x: number, y: number, col: Interval[]): void {
    const { K } = this;
    if (fitColumn(col, this.colK)) this.stats.fitted++;
    const rc = this.R / CHUNK;
    const page = Math.floor(y / CHUNK) * rc + Math.floor(x / CHUNK);
    const slot = page * this.pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
    layers.set(packColumn(col, K), slot * SLOT_WORDS);
  }

  /** the intervals of column (x, y) of a region's pages (window z) */
  private columnOf(layers: Uint32Array, x: number, y: number): Interval[] {
    const { K } = this;
    const rc = this.R / CHUNK;
    const page = Math.floor(y / CHUNK) * rc + Math.floor(x / CHUNK);
    const slot = page * this.pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
    const out: Interval[] = [];
    for (let s = 0; s < K; s++) {
      const iv = readSlot(layers, slot + s);
      if (!iv) break;
      out.push(iv);
    }
    return out;
  }

  /** a frozen region cut again at the window's oz now (it was left at another) */
  private reslice(f: Frozen): Frozen {
    const { R } = this;
    const zMax = this.core.dims.zMax;
    const layers = new Uint32Array(f.layers.length);
    const outside: Interval[][] = [];
    const surface = new Float32Array(R * R);
    const water = f.bufs.water ? new Float32Array(f.bufs.water.buffer, f.bufs.water.byteOffset, R * R) : undefined;
    const lava = f.bufs.lava ? new Float32Array(f.bufs.lava.buffer, f.bufs.lava.byteOffset, R * R * 4) : undefined;
    for (let y = 0; y < R; y++)
      for (let x = 0; x < R; x++) {
        const i = y * R + x;
        const was = this.columnOf(f.layers, x, y);
        const full = joinColumn(was, f.oz, f.outside[i]);
        const wasTop = was.length > 0 && !f.outside[i].some((iv) => iv.z0 >= f.oz + zMax);
        const cut = splitColumn(full, this.oz, zMax);
        outside.push(cut.outside);
        this.place(layers, x, y, cut.inside);
        surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        if (!(wasTop && topInside(cut, this.oz, zMax))) {
          if (water) water[i] = 0;
          if (lava) lava.fill(0, i * 4, i * 4 + 4);
        } else if (lava && lava[i * 4] > 0) lava[i * 4 + 3] += f.oz - this.oz;
      }
    this.stats.resliced++;
    const ground = f.ground ? f.ground.map((v) => v + f.oz - this.oz) : undefined;
    return { ...f, layers, surface, oz: this.oz, outside, ground };
  }

  /** Move the window by dz cells in z (±TIER): every column read back, joined with what's outside it, cut again. */
  /**
   * Move the window somewhere else entirely (round 80, the user: "a way to access the atlas map so I can see
   * where I am or maybe warp"): its origin (world cells, whole regions) and oz (whole tiers). Every region
   * there is generated (or thawed) and written; what's derived per column is cleared, the meshes and the band
   * made again. What the window held is dropped, not frozen (a warp is a jump, not a ride). The sim waits.
   */
  async warp(ox: number, oy: number, oz: number): Promise<void> {
    if (ox % this.R || oy % this.R) throw new Error(`a warp's origin must be whole regions of ${this.R}`);
    if (oz % TIER || oz < 0) throw new Error(`a warp's oz must be whole tiers of ${TIER}`);
    while (this.busy) await new Promise((r) => setTimeout(r, 16));
    this.busy = true;
    const t0 = performance.now();
    const { core, W, H, R } = this;
    try {
      core.windowEpoch++;
      this.pending.clear();
      this.origin[0] = ox;
      this.origin[1] = oy;
      this.oz = oz;
      core.globals.origin = [ox, oy];
      const dev = core.host.gpu.device;
      const wg = core.world;
      const enc = dev.createCommandEncoder({ label: 'stream warp' });
      for (const b of [...this.bufs, ...this.moduleBufs()]) if (!b.keep) enc.clearBuffer(b.buf);
      enc.clearBuffer(wg.particles);
      dev.queue.submit([enc.finish()]);
      const spots: [number, number][] = [];
      for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) spots.push([lx, ly]);
      const lands = await Promise.all(
        spots.map(([lx, ly]) => {
          const key = this.key((ox + lx) / R, (oy + ly) / R);
          const got = this.frozen.get(key);
          if (got) {
            this.frozen.delete(key);
            this.stats.thawed++;
            return Promise.resolve(got).then((f) => this.since(f, ox + lx, oy + ly));
          }
          this.stats.generated++;
          return this.generate(ox + lx, oy + ly);
        }),
      );
      lands.forEach((f, k) => this.write(f, spots[k][0], spots[k][1]));
      // (everything built is made again where it is now)
      core.renderer.windowMoved(1 << 12, 0, [0, 0, 0]);
      this.refreshBand();
      core.clearUndo();
      core.windowEpoch++;
      for (const f of this.onWarp) f(ox, oy, oz);
    } finally {
      this.busy = false;
    }
    this.stats.lastMs = +(performance.now() - t0).toFixed(1);
  }

  async slideZ(dz: number): Promise<void> {
    if (Math.abs(dz) !== TIER) throw new Error(`a slide in z is one tier (${TIER})`);
    if (this.oz + dz < 0) throw new Error('the window is at the bottom of the world');
    this.busy = true;
    const t0 = performance.now();
    try {
      const tz = performance.now();
      this.core.windowEpoch++;
      await this.slideZNow(dz);
      record('slideZ', performance.now() - tz);
    } finally {
      this.busy = false;
    }
    this.stats.tiers++;
    this.stats.lastMs = +(performance.now() - t0).toFixed(1);
  }

  private async slideZNow(dz: number): Promise<void> {
    const { core, W, H, R } = this;
    const dev = core.host.gpu.device;
    const wg = core.world;
    const zMax = core.dims.zMax;
    const N = W * H;
    const [layersBuf, waterBuf, lavaBuf] = await Promise.all([core.readBuffer('layers'), core.readBuffer('water'), core.readBuffer('lava')]);
    const slots = new Uint32Array(layersBuf.buffer, layersBuf.byteOffset, layersBuf.byteLength / 4);
    const water = new Float32Array(waterBuf.buffer, waterBuf.byteOffset, N);
    const lava = new Float32Array(lavaBuf.buffer, lavaBuf.byteOffset, N * 4);
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const K = this.K;
    const out = slots.slice();
    const oz = this.oz + dz;
    const surf = core.map.surface;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const ci = Math.floor(y / CHUNK) * cx + Math.floor(x / CHUNK);
        const base = table[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
        const was: Interval[] = [];
        for (let s = 0; s < K; s++) {
          const iv = readSlot(slots, base + s);
          if (!iv) break;
          was.push(iv);
        }
        const wasTop = was.length > 0 && !this.outside[i].some((iv) => iv.z0 >= this.oz + zMax);
        const cut = splitColumn(joinColumn(was, this.oz, this.outside[i]), oz, zMax);
        if (fitColumn(cut.inside, this.colK)) this.stats.fitted++;
        this.outside[i] = cut.outside;
        out.set(packColumn(cut.inside, K), base * SLOT_WORDS);
        surf[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        if (!(wasTop && topInside(cut, oz, zMax))) {
          water[i] = 0;
          lava.fill(0, i * 4, i * 4 + 4);
        } else if (lava[i * 4] > 0) lava[i * 4 + 3] -= dz;
      }
    for (const b of [wg.layers, wg.layersNext]) dev.queue.writeBuffer(b, 0, out);
    for (const b of [wg.water, wg.waterNext, wg.waterPrev]) dev.queue.writeBuffer(b, 0, water);
    for (const b of [wg.lava, wg.lavaNext]) dev.queue.writeBuffer(b, 0, lava);
    // (particles in the air: dropped, as on a slide sideways)
    const enc = dev.createCommandEncoder({ label: 'stream slide z' });
    enc.clearBuffer(wg.particles);
    dev.queue.submit([enc.finish()]);
    this.oz = oz;
    for (let i = 0; i < N; i++) this.ground[i] -= dz;
    core.camera.shift(0, 0, dz);
    for (const f of core.onShift) f(0, 0, dz);
    core.windowEpoch++;
    core.renderer.windowMoved(0, 0, [0, 0, -dz]);
    this.refreshBand();
    core.clearUndo();
    void R;
    for (const f of this.onSlide) f(0, 0, dz);
  }

  /** write a region into the window at local cell (lx, ly) */
  private write(f: Frozen, lx: number, ly: number): void {
    timed('write', () => this.writeNow(f, lx, ly));
  }

  private writeNow(f: Frozen, lx: number, ly: number): void {
    if (f.oz !== this.oz) f = this.reslice(f);
    const { core, W, H, R } = this;
    for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) this.outside[(ly + r) * W + lx + c] = f.outside[r * R + c];
    const dev = core.host.gpu.device;
    const wg = core.world;
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const rc = R / CHUNK;
    const pageWords = this.pageSlots * SLOT_WORDS;
    for (let j = 0; j < rc; j++)
      for (let i = 0; i < rc; i++) {
        const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
        const page = f.layers.subarray((j * rc + i) * pageWords, (j * rc + i + 1) * pageWords);
        // (both: the passes that write layersNext copy all of it back over the layers)
        dev.queue.writeBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, page);
        dev.queue.writeBuffer(wg.layersNext, table[ci * 2] * SLOT_WORDS * 4, page);
      }
    for (const b of this.bufs) {
      if (!b.keep) continue;
      const d = f.bufs[b.name];
      for (let p = 0; p < b.planes; p++)
        for (let r = 0; r < R; r++) {
          const dst = p * W * H * b.stride + ((ly + r) * W + lx) * b.stride;
          if (d) dev.queue.writeBuffer(b.buf, dst, d, (p * R + r) * R * b.stride, R * b.stride);
          else dev.queue.writeBuffer(b.buf, dst, new Uint8Array(R * b.stride));
        }
    }
    for (const t of this.texs) {
      const tw = (R / t.div) * t.per;
      const th = R / t.div;
      let d = t.keep ? f.texs[t.name] : undefined;
      if (!d) {
        d = new Float32Array(tw * th * 4);
        if (t.fill) for (let k = 0; k < tw * th; k++) d.set(t.fill, k * 4);
      }
      dev.queue.writeTexture({ texture: t.tex, origin: [(lx / t.div) * t.per, ly / t.div] }, d, { bytesPerRow: tw * 16 }, [tw, th]);
    }
    const surf = core.map.surface;
    for (let r = 0; r < R; r++) surf.set(f.surface.subarray(r * R, (r + 1) * R), (ly + r) * W + lx);
    // (the ground: its own if the source said, else the surface)
    const gr = f.ground ?? f.surface;
    for (let r = 0; r < R; r++) this.ground.set(gr.subarray(r * R, (r + 1) * R), (ly + r) * W + lx);
    if (f.judge) for (const cb of this.onArrive) cb(lx + f.judge[0], ly + f.judge[1], lx + f.judge[2], ly + f.judge[3]);
  }

  /** new(x, y) = old(x + dx, y + dy), per plane */
  /** the installed modules' per-column buffers (WorldCore.columnBufs) as the streamer's own, the scratch grown to fit */
  private moduleBufs(): ColBuf[] {
    const out: ColBuf[] = this.core.columnBufs.map((m) => ({ name: m.name, buf: m.buf, stride: m.stride, planes: m.planes, keep: false }));
    const big = Math.max(0, ...out.map((b) => b.buf.size));
    if (big > this.scratch.size) this.scratch = this.core.world.buf('streamScratch', big, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    return out;
  }

  private shiftBuf(enc: GPUCommandEncoder, b: ColBuf, dx: number, dy: number): void {
    const { W, H } = this;
    const s = b.stride;
    enc.copyBufferToBuffer(b.buf, 0, this.scratch, 0, b.buf.size);
    const x0 = Math.max(0, -dx);
    const x1 = Math.min(W, W - dx);
    const y0 = Math.max(0, -dy);
    const y1 = Math.min(H, H - dy);
    const plane = W * H * s;
    for (let p = 0; p < b.planes; p++) {
      if (dx === 0) enc.copyBufferToBuffer(this.scratch, p * plane + (y0 + dy) * W * s, b.buf, p * plane + y0 * W * s, (y1 - y0) * W * s);
      else for (let y = y0; y < y1; y++) enc.copyBufferToBuffer(this.scratch, p * plane + ((y + dy) * W + x0 + dx) * s, b.buf, p * plane + (y * W + x0) * s, (x1 - x0) * s);
    }
  }

  private shiftTex(enc: GPUCommandEncoder, t: ColTex, dx: number, dy: number): void {
    const tex = t.tex;
    const k = `${tex.format}:${tex.width}x${tex.height}`;
    let tmp = this.scratchTex.get(k);
    if (!tmp) {
      tmp = this.core.world.texture(`streamScratch:${k}`, tex);
      this.scratchTex.set(k, tmp);
    }
    enc.copyTextureToTexture({ texture: tex }, { texture: tmp }, [tex.width, tex.height]);
    const sx = (dx / t.div) * t.per;
    const sy = dy / t.div;
    enc.copyTextureToTexture(
      { texture: tmp, origin: [Math.max(0, sx), Math.max(0, sy)] },
      { texture: tex, origin: [Math.max(0, -sx), Math.max(0, -sy)] },
      [tex.width - Math.abs(sx), tex.height - Math.abs(sy)],
    );
  }
}

const align256 = (n: number) => Math.ceil(n / 256) * 256;

/** whether a column cut at the window has its top in the window (nothing of it above) */
const topInside = (cut: { inside: Interval[]; outside: Interval[] }, oz: number, zMax: number) => cut.inside.length > 0 && !cut.outside.some((iv) => iv.z0 >= oz + zMax - 1e-4);

/** the box (cells, x1 y1 past the end) round the set cells of a w-wide mask, with a margin of 2; none if none */
export function boxOf(mask: Uint8Array, w: number, x0 = 0, y0 = 0, bw = w, bh = mask.length / w): [number, number, number, number] | undefined {
  let lx = 1e9;
  let ly = 1e9;
  let hx = -1;
  let hy = -1;
  for (let y = y0; y < y0 + bh; y++)
    for (let x = x0; x < x0 + bw; x++)
      if (mask[y * w + x]) {
        lx = Math.min(lx, x);
        ly = Math.min(ly, y);
        hx = Math.max(hx, x);
        hy = Math.max(hy, y);
      }
  return hx < 0 ? undefined : [lx - 2, ly - 2, hx + 3, hy + 3];
}

/** new(x, y) = old(x + dx, y + dy) on a CPU w × h array with `per` values a cell (what comes in keeps the old values) */
export function shiftGrid(a: { copyWithin(t: number, s: number, e: number): unknown }, w: number, h: number, per: number, dx: number, dy: number): void {
  if (dy > 0) a.copyWithin(0, dy * w * per, h * w * per);
  else if (dy < 0) a.copyWithin(-dy * w * per, 0, (h + dy) * w * per);
  if (dx > 0) for (let y = 0; y < h; y++) a.copyWithin(y * w * per, (y * w + dx) * per, (y + 1) * w * per);
  else if (dx < 0) for (let y = 0; y < h; y++) a.copyWithin((y * w - dx) * per, y * w * per, (y * w + w + dx) * per);
}
