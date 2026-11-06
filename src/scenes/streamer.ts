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
// (Round 100, `regionstore`: docs/ARCHITECTURE.md "Region storage".) The storage tiers: a region leaving is copied
// GPU to GPU into a slot of the region pool (region-pool.ts, LRU, `?pool=` slots) and comes back the same way, so a
// slide never waits on a readback; its CPU parts (what's outside the window, the surface, the ground, the relief)
// go with it. Each region frozen (and each of the window's, one every SWEEP_MS) is also read back, off the frame, and
// its columns hashed (world/region-record.ts columnsHash): one changed since it was made or last saved is written
// whole to the store (world/region-store.ts: IndexedDB, compressed in a worker; `?worldsave=0` the session's memory
// only). A region evicted from the pool is then on disk if it changed, made again if it didn't. Land is asked for
// AHEAD strips along the camera's motion and uploaded into the pool when ready, so a slide only copies. On load,
// the window's regions with a record are restored (Streamer.restore).

import { record, timed } from '../gpu/cpustat';
import { RegionPool, type PoolSlot } from './region-pool';
import { RegionCopier } from './region-copy';
import { RegionStore } from '../world/region-store';
import { keepAllows, keepHeld, type KeepRect } from './streamer/keep';
import { GEN_VERSION, columnsHash, regionLayout, type RegionLayout } from '../world/region-record';
import { CHUNK, K_HEADROOM, PHYS_COL_WORDS, SLOT_WORDS, WORLD_FLOOR, joinColumn, readSlot, type Interval } from '../world/layout';
import { PROJ_K } from '../grids/structures';
import { type RegionLand } from '../world/streamgen';
import type { WorldCore } from './world-core';
import { settleLand } from '../sim/sleep';
import { MATERIALS, MatState } from '../world/materials';
import { type FinishTarget } from '../atlas/finish';
import type { TileLandSource } from '../render/tileland';
import { bootMark } from '../perf/boot-marks';
import { enteringFor, inWindow, nearFirst, regionOutside, regionSlots } from './streamer/regions';
import { copyOut, toBody } from './streamer/freeze';
import { flushFills, restore, sweep } from './streamer/store';
import { bring, startJob } from './streamer/jobs';
import { slideNow, update } from './streamer/slide';
import { compareGen, cutRegion, genHash } from './streamer/generate';
import { editLive, setRelief } from './streamer/write';
import { slideZNow, warp } from './streamer/warp';
import { REGION, param, POOL_CAP, WARP_RING, TIER, TILE_BORDER, LandSource, WorldSave, RegionThings, noiseLand, ColBuf, ColTex, Frozen, RegionInfo, SaveItem, SlideTrace, GenTrace, SlideStats } from './streamer/defs';
export { REGION, STREAM_OLD, POOL_CAP, SESSION, TIER, TILE_BORDER, applyChange, noiseLand, boxOf } from './streamer/defs';
export type { LandSource, WorldSave, RegionThings, LandChange, SlideTrace, GenTrace, SlideStats } from './streamer/defs';

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

export class Streamer {
  readonly W: number;
  readonly H: number;
  readonly R = REGION;
  /** the world cell of window column 0, row 0 */
  readonly origin: [number, number] = [0, 0];
  /**
   * Regions out of the window on the GPU ("rx,ry" in regions; round 100: the pool's, LRU order — oldest first): as
   * they were left, or made or loaded ahead of the slide that brings them in
   */
  readonly frozen = new Map<string, Frozen>();
  /** (round 100) the GPU region pool, the layout of a region's bytes (slot, staging, record body) */
  readonly pool: RegionPool;
  readonly layout: RegionLayout;
  /** (round 100) the store (null till it's open; the streamer doesn't slide before) */
  store: RegionStore | null = null;
  /** (round 100) what's saved, and how the store went (the failure, when it couldn't open) */
  readonly save: WorldSave;
  storeError: string | null = null;
  /** (round 100) the window's regions: what's known of their columns, by key */
  winInfo = new Map<string, RegionInfo>();
  /** (round 100) a region's readback and save under way (a region evicted before it's done is loaded after it) */
  checks = new Map<string, Promise<void>>();
  /** (round 100) the coarse world's snapshot of regions evicted this session (LandSource.changes, when they come back) */
  snaps = new Map<string, unknown>();
  /** (round 100) what owns things in the regions (meshes with transforms) */
  readonly things: RegionThings[] = [];
  /** (round 100) false while what's in the window shouldn't be saved (something falling: it would be saved mid-air) */
  canSave: (() => boolean)[] = [];
  /** (round 100) GPU pool uploads waiting for a frame */
  uploads: { f: Frozen; slot: PoolSlot; res: () => void; body?: Uint8Array; at?: number }[] = [];
  uploadHost?: Uint8Array;
  sweepAt = 0;
  sweepT = 0;
  sweeping = false;
  /** (round 100) timings (ms): freeze (the slide's copies), thaw (a region's write), check (hash), encode, load */
  readonly times = { freeze: [] as number[], thaw: [] as number[], hash: [] as number[], encode: [] as number[], load: [] as number[] };
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
  busyNow = false;
  /** (round 114, framepace) what made it busy last: restore, slide, warp, slideZ (the sim's held frames, counted by why) */
  busyWhy = '';
  /** slide on its own as the camera nears the edge (tests turn it off to slide by hand) */
  auto = true;
  readonly stats: SlideStats = { slides: 0, frozen: 0, generated: 0, thawed: 0, prefetched: 0, lastMs: 0, tiers: 0, resliced: 0, fitted: 0, changed: 0, settled: 0, evicted: 0, touched: 0, checked: 0, saved: 0, loaded: 0, restored: 0, mismatched: 0, loadFailed: 0, storeMiss: 0, uploads: 0, gpuMade: 0, precached: 0, warpReady: 0 };
  /** called after each slide with the shift in columns (the window moved by dx, dy: content moved by −dx, −dy), and in z */
  readonly onSlide: ((dx: number, dy: number, dz: number) => void)[] = [];
  /**
   * (round 92) called with (dx, dy, dz) before a slide, a slide in z or a warp (0, 0, 0) touches the window's
   * columns: what's mid-change in them is finished first (Integrity: a piece falling in a region leaving lands — one
   * frozen mid-air, read back for a cut in z, or written on at its old place after the land moved under it, stayed
   * in the air)
   */
  readonly onBeforeSlide: ((dx: number, dy: number, dz: number) => void)[] = [];
  /**
   * (round 92) a slide in z or a warp under way: the window's columns are read back and all written again, so nothing
   * else may write them meanwhile (a slide along x or y moves them in one synchronous step: nothing to hold)
   */
  get columnsHeld(): boolean {
    return this.heldNow;
  }
  heldNow = false;
  /** the world height of the window's z = 0 */
  oz = 0;
  /** (round 105, ringwin) window column i (y * W + x)'s place in `outside` (on the ring) */
  oi(i: number): number {
    return this.core.ring.of(i);
  }
  /**
   * (round 106, frameprobe) window column (x, y)'s index in the streamer's per-column CPU arrays — `outside`, `ground`,
   * `relief`, `gapTop`, `colTop` and core.map.surface, all on the ring (sim/ring.ts): a slide moves none of them
   */
  colIdx(x: number, y: number): number {
    return this.core.ring.i(x, y);
  }
  /** per window column: its intervals above and below the window (world z) — (round 105) on the ring: Streamer.oi */
  outside: Interval[][];
  /** what a column may hold (the chunks' K less their headroom) */
  colK: number;
  /** per window column: the ground's own top (window z; round 75: a slide in z goes by it, not by what
   *  stands on it — a giant's point under the camera isn't where the land is) */
  readonly ground: Float32Array;
  /**
   * (round 128m, quarry) the ground's top now under the camera (window z): a slide in z down follows the lower of it and
   * `ground` — a deep pit looked into (dug since the land came in) slides the window down to it, never under the
   * world's floor (layout.ts WORLD_FLOOR). Null: `ground` alone.
   */
  groundNow: ((x: number, y: number) => number) | null = null;
  /**
   * (hybrid) what the hybrid renderer asks of each window column (scenes/hybrid.ts): `relief` 1 where something
   * stands on the ground or is cut into it (a form: the top off the ground's own by more than RELIEF_FORM);
   * `gapTop` the highest roof over a gap between its runs (world z; -Infinity: none — a cave, an overhang, a
   * bridge's underside, a tunnel: open to the air where a neighbour's top is under it); `colTop` its top (world
   * z, the runs above the window too). Made as land comes in (and as an event in sight changes it), moved with
   * the window.
   */
  readonly relief: Uint8Array;
  readonly gapTop: Float32Array;
  readonly colTop: Float32Array;
  /** called after land is written into the window (or changed in it): the box (window cells, exclusive) whose relief is new */
  readonly onRelief: ((x0: number, y0: number, x1: number, y1: number) => void)[] = [];
  /**
   * (round 128j, claims at load) called right after a region's land is written to the GPU, in the same frame and before
   * anything reads it: window rectangle (lx, ly, w, h) — the static grids' claims written there (sim/static-claims.ts)
   */
  readonly onWritten: ((lx: number, ly: number, w: number, h: number) => void)[] = [];
  /**
   * (round 128j) what must be ready before a region's land can be written (a slide waits for it as for the land made
   * ahead): world region corner (wx, wy), side R — the static grids' plans over it (a settlement's, settle/settlements.ts
   * ready); null: nothing to wait for
   */
  readonly readyFor: ((wx: number, wy: number, R: number) => Promise<unknown> | null)[] = [];
  /** called when land comes into the window that the structural system should judge: the box (window cells) round it */
  readonly onArrive: ((x0: number, y0: number, x1: number, y1: number) => void)[] = [];
  /** the window was moved somewhere else entirely (warp): its new origin and oz — what the game keeps in window coordinates is void */
  readonly onWarp: ((ox: number, oy: number, oz: number) => void)[] = [];
  bufs: ColBuf[];
  texs: ColTex[];
  /** (round 104) a region's buffers to and from a pool slot, a dispatch a buffer */
  copier: RegionCopier;
  /** slots a chunk page holds (every chunk has the same K) */
  pageSlots: number;
  K: number;

  constructor(
    public core: WorldCore,
    public source: LandSource = noiseLand(),
    origin: [number, number] = [0, 0],
    /** the first window's oz and what's outside it (the atlas's window), the ground's tops (window z) */
    tier?: { oz: number; outside: Interval[][]; ground?: Float32Array },
    /** (round 100) the world the store keeps (default: a noise world, this session's memory only) */
    save: WorldSave = { world: 'noise', disk: false, fresh: false },
  ) {
    this.save = save;
    const { w, h } = core.dims;
    this.oz = tier?.oz ?? 0;
    if (this.oz % TIER) throw new Error(`the window's oz must be whole tiers of ${TIER}`);
    this.outside = tier?.outside ?? Array.from({ length: w * h }, () => []);
    // (round 105, ringwin: on the window's ring, as the GPU's per-column data — a slide moves none of it)
    {
      // (round 107, pages: the buffers' page-major order)
      const o = this.outside;
      this.outside = new Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.outside[core.ring.i(x, y)] = o[y * w + x];
    }
    // (round 106, frameprobe: the ground on the ring too, as `outside` and core.map.surface (world-core.ts) — a slide
    // moves none of them: read a column through colIdx)
    this.ground = tier?.ground ? core.ring.toStore(tier.ground.slice()) : core.map.surface.slice();
    this.relief = new Uint8Array(w * h);
    this.gapTop = new Float32Array(w * h).fill(-Infinity);
    this.colTop = new Float32Array(w * h);
    if (this.outside.length !== w * h) throw new Error('the window needs what lies outside every column');
    if (origin[0] % REGION || origin[1] % REGION) throw new Error(`the window's origin must be whole regions of ${REGION}`);
    this.origin[0] = origin[0];
    this.origin[1] = origin[1];
    core.globals.origin = [origin[0], origin[1]];
    const R = this.R;
    if (w % R || h % R) throw new Error(`the window (${w} × ${h}) must be whole regions of ${R}`);
    // (round 105, ringwin: a region is one rectangle where it lies only if the ring's offset is whole regions)
    if (core.ring.x % R || core.ring.y % R) throw new Error(`the window's ring offset (${core.ring.x}, ${core.ring.y}) must be whole regions of ${R}`);
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
      b('flux', 24, !settleLand()),
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
      b('physCols', PHYS_COL_WORDS * 4, false),
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
    this.copier = new RegionCopier(core.host.gpu.device);
    // (hybrid) the first window's relief, from the columns it was packed with
    const p = core.packed;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const ci = Math.floor(y / CHUNK) * (w / CHUNK) + Math.floor(x / CHUNK);
        const base = t[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * this.K;
        const col: Interval[] = [];
        for (let s = 0; s < this.K; s++) {
          const iv = readSlot(p.slots, base + s);
          if (!iv) break;
          col.push(iv);
        }
        const si = this.oi(i);
        setRelief(this, si, joinColumn(col, this.oz, this.outside[si]), core.map.surface[si], this.ground[si]);
      }
    // (round 100) the pool, in the layout every tier shares; the first window's columns hashed as made
    this.layout = regionLayout(
      R,
      this.K,
      this.bufs.filter((b) => b.keep),
      this.texs.filter((t) => t.keep),
      `z${core.dims.zMax}`,
    );
    // (round 102: STORAGE too — finish.wgsl writes a region made on the GPU straight into its slot)
    this.pool = new RegionPool((label, size) => wg.buf(label, size, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE), this.layout.bytes, POOL_CAP);
    const L = this.layout;
    const pageWords = L.pageBytes / 4;
    for (let ly = 0; ly < h; ly += R)
      for (let lx = 0; lx < w; lx += R) {
        const pages = new Uint32Array(L.rc * L.rc * pageWords);
        for (let j = 0; j < L.rc; j++)
          for (let i = 0; i < L.rc; i++) {
            const ci = (ly / CHUNK + j) * (w / CHUNK) + lx / CHUNK + i;
            pages.set(p.slots.subarray(t[ci * 2] * SLOT_WORDS, t[ci * 2] * SLOT_WORDS + pageWords), (j * L.rc + i) * pageWords);
          }
        const out = this.regionOutside(regionSlots(this, lx, ly));
        const last = columnsHash(pages, L, out, this.oz);
        this.winInfo.set(this.key((origin[0] + lx) / R, (origin[1] + ly) / R), { last });
      }
    // (round 100) the store: opened, cleared for a new world, the window's saved regions restored; till then the
    // window doesn't slide (a region made before the index is read might have had a record)
    // (round 114: records of another land generator — GEN_VERSION, a hash of its sources — and earlier runs' dropped as
    // it opens: reported once, never loaded, the store doesn't grow with them)
    const keep = { gen: GEN_VERSION, endedRuns: save.endedRuns };
    const fail = (e: unknown) => {
      this.storeError = String((e as Error)?.message ?? e);
      console.error(`[worldsave] ${this.storeError} — this session's changes are kept in memory only, not saved`);
      return RegionStore.open(save.world, true, keep);
    };
    void (save.disk ? RegionStore.open(save.world, false, keep).catch(fail) : RegionStore.open(save.world, true, keep))
      .then(async (s) => {
        if (save.fresh) await s.clear();
        await restore(this, s);
        this.store = s;
        bootMark('store');
      })
      .catch((e) => console.error(`[worldsave] the store failed: ${(e as Error)?.message ?? e}`));
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        // (a phone backgrounding the page: the whole window read back for the store now)
        if (document.visibilityState === 'hidden') sweep(this, true);
      });
  }

  /** (round 100) the window's outside intervals of the region in slots `sl` (regionSlots), row-major in the region */
  regionOutside(sl: Uint16Array): Interval[][] {
    return regionOutside(this, sl);
  }

  /** (round 106, frameprobe) the regions frozen whose CPU parts aren't read yet, and where they lie (round 107: their first slot) */
  fills: { at: number; it: SaveItem }[] = [];

  /** (round 100) Copy the window's region at (lx, ly) into `dst` at `off`, in the region layout. */
  copyOut(enc: GPUCommandEncoder, lx: number, ly: number, dst: GPUBuffer, off: number, kernel = true, flush = true): void {
    return copyOut(this, enc, lx, ly, dst, off, kernel, flush);
  }

  /** (round 100) a region's bytes (the layout's) from its CPU form, in a host buffer reused (valid till the next call) */
  toBody(f: Frozen): Uint8Array {
    return toBody(this, f);
  }

  laterQ: (() => void)[] = [];

  /**
   * (round 100, scripts/worldsavetest.mjs) Each region written into the window from the pool or the store read back at
   * once (before the sims' next tick) and its columns hashed against the hash it was frozen or saved with: `verified`.
   */
  verify = param('rsverify') === '1';
  readonly verified: { key: string; how: string; same: boolean; at: number }[] = [];

  /**
   * (round 100) Play changed the window's land in the box (window cells x0..x1, rows y0..y1): the regions under it are
   * kept (saved when they're read back different from what's saved), not made again.
   */
  touch(x0: number, y0: number, x1: number, y1: number): void {
    const { R, W, H } = this;
    for (let ry = Math.max(0, Math.floor(y0 / R)); ry <= Math.min(H / R - 1, Math.floor(y1 / R)); ry++)
      for (let rx = Math.max(0, Math.floor(x0 / R)); rx <= Math.min(W / R - 1, Math.floor(x1 / R)); rx++) {
        const key = this.key((this.origin[0] + rx * R) / R, (this.origin[1] + ry * R) / R);
        let info = this.winInfo.get(key);
        if (!info) this.winInfo.set(key, (info = {}));
        if (!info.changed) this.stats.touched++;
        info.changed = true;
      }
  }

  /** (round 100) A new world: saving stops, this world's records are cleared (the page is then loaded again). */
  async newWorld(): Promise<void> {
    this.halted = true;
    await this.store?.clear();
  }
  halted = false;

  /** (round 100) Every region of the window read back now and, where it changed, saved; resolves when it's on disk. */
  async saveAll(): Promise<void> {
    // (till a sweep of the whole window runs: not while a slide is under way or something falls)
    for (let t = 0; !sweep(this, true); t++) {
      if (t > 600) throw new Error('saveAll: the window never came still enough to save (10 s)');
      await new Promise((r) => setTimeout(r, 16));
    }
    await Promise.all([...this.checks.values()]);
    await this.store?.flush();
  }

  /** The world cell under window cell (x, y). */
  toWorld(x: number, y: number): [number, number] {
    return [x + this.origin[0], y + this.origin[1]];
  }

  /** (round 91) the regions a slide under way has moved the window over but not written yet (local corners):
   *  the window's land there is stale until they are (scripts/edgeprobe.mjs measures the view against it) */
  unwritten: [number, number][] = [];

  /** (round 100) land asked for (made, loaded or thawed, checked, cut, uploaded), by region key */
  jobs = new Map<string, Promise<Frozen>>();
  /** (round 100) jobs a slide or a warp took over (their land is theirs to write) */
  taken = new WeakSet<Promise<Frozen>>();
  /** (round 98) land ready to write (made ahead, or thawed and checked), by region key — round 100: in the pool */
  made = new Map<string, Frozen>();
  /**
   * (merge122) The window a travel precached (precache's window, not its ring), kept in the pool until the warp there:
   * never a victim of slotFor. Without it a full pool (POOL_CAP) evicted the far destination's regions as "outside
   * where the window is heading" while the hero waited, and `precached` never came true — runsit's journey hung on
   * "waiting" (merge122's gate, the atlas with every system on). One travel's window at a time (RP7's pinned sections
   * would generalise it).
   */
  pinned = new Set<string>();
  /** (round 98) frames a slide was due but its land wasn't ready (the camera went on, up to the edge's clamp) */
  waited = 0;

  /**
   * (round 98, scripts/speedsweep.mjs) The last slides' timelines and the last regions' builds (performance.now() ms):
   * what a slide waited for, and when each region it brought in was asked for, built and written.
   */
  readonly trace: SlideTrace[] = [];
  readonly gens: GenTrace[] = [];

  /**
   * (round 104, the pan bench's per-slide rows) ms from a submit to the queue's work done (onSubmittedWorkDone: the
   * one GPU time Mali reports sanely across passes) — after each slide's submit, and every half second without a
   * slide (the queue's usual lag, to compare). Each holds its last 64.
   */
  readonly slideDone: number[] = [];
  readonly baseDone: number[] = [];
  baseAt = 0;

  /** (round 113, tilesfirst) the last regions' land, asked to made (ms) */
  landMs: number[] = [];
  /** (round 113) the land's latency, asked to made: the 90th percentile of the last 24 (s), or null */
  landLatency(): number | null {
    if (this.landMs.length < 3) return null;
    const a = [...this.landMs].sort((x, y) => x - y);
    return a[Math.floor(a.length * 0.9)] / 1000;
  }
  /**
   * (round 113, tilesfirst — the planner's, scenes/planner.ts) How far ahead along the camera's motion the streamer
   * works (cells; 0 at rest): `land` the strips asked for ahead, `slide` how far on the slide judges where the camera
   * is (the window's latency at its speed: the strip comes in that much before the camera's there). Null: as before.
   */
  reach: { land: number; slide: number; dir: [number, number] } | null = null;

  /** (round 91) the camera's velocity (cells a second, world x and rows), smoothed; where it was, and when */
  readonly vel: [number, number] = [0, 0];
  last: [number, number, number] | null = null;

  /** Slide when the camera has come within 1¼ regions of the window's edge (one axis a call);
   *  ask for the land of the slide it's heading for once it's halfway there. (Round 91: or once where it will be
   *  `LEAD` seconds on is — and the land of two slides when that's past the next one's reach.) */
  update(): Promise<void> | null {
    return update(this);
  }

  /**
   * (round 105, tilelatency; round 108, TC18/TC19) The render-only tiles' land: the window's own generation
   * (LandSource.regionInto — the same columns, finish, ways and stamps), only without the simulation and with nothing
   * read back: the plans already made stamped, none started; the per-column summary left on the GPU. Each tile's land
   * is its region and TILE_BORDER cells round it (its neighbours'), in the corner of a slot of a wider layout (the
   * region's next whole pages): its edges are drawn as its neighbours' and the window's are (no seams).
   */
  tileLand(): TileLandSource {
    if (this.tileSrc) return this.tileSrc;
    const R = this.R;
    const b = TILE_BORDER;
    const side = Math.ceil((R + 2 * b) / CHUNK) * CHUNK;
    const layout = regionLayout(side, this.K, this.bufs.filter((x) => x.keep), this.texs.filter((x) => x.keep), `z${this.core.dims.zMax}`);
    this.tileSrc = {
      layout,
      border: b,
      oz: () => this.oz,
      zRange: (x0, y0) => this.source.zRange?.(x0, y0, R, R) ?? null,
      landTile: (x0, y0, buf, off, meta, order) => {
        if (!this.source.regionInto) return null;
        const target: FinishTarget = { buf, off, layout, oz: this.oz, zMax: this.core.dims.zMax, K: this.K, colK: this.colK, settle: !settleLand(), corner: true };
        return this.source.regionInto(x0 - b, y0 - b, R + 2 * b, R + 2 * b, target, { pace: 'tile', stamps: 'made', summary: meta, order }).then(() => undefined);
      },
    };
    return this.tileSrc;
  }
  tileSrc: TileLandSource | null = null;

  /**
   * (round 128m, townlab) The world columns every slide must leave in the window (the fortress's box and a margin:
   * scenes/streamer/keep.ts). The window doesn't slide off them; the camera may pan past, over the far land. Null: none.
   */
  keepRect: KeepRect | null = null;

  /** Keep `k` in the window from now on (null: let it go). Throws when the window doesn't hold it now. */
  keep(k: KeepRect | null): void {
    if (k && !keepHeld(this.origin, this.W, this.H, k)) throw new Error(`the window (${this.origin} + ${this.W} x ${this.H}) doesn't hold the rect it's asked to keep (${k.x0},${k.y0} - ${k.x1},${k.y1})`);
    this.keepRect = k;
  }

  /** whether a slide of (dx, dy) leaves what's kept in the window */
  slideKeeps(dx: number, dy: number): boolean {
    return keepAllows(this.origin, this.W, this.H, this.keepRect, dx, dy);
  }

  /** Start making the land a slide of (dx, dy) would bring in (round 100: into the pool — what's there needs nothing). */
  prefetch(dx: number, dy: number): void {
    // (round 128m: no slide that way while the window keeps a rect it would leave: nothing to make for it)
    if (!this.slideKeeps(dx, dy)) return;
    const R = this.R;
    for (const [lx, ly] of nearFirst(this, enteringFor(this, dx, dy), dx, dy)) {
      const wx = this.origin[0] + dx + lx;
      const wy = this.origin[1] + dy + ly;
      const key = this.key(wx / R, wy / R);
      if (this.jobs.has(key)) continue;
      const m = this.made.get(key);
      if (m) {
        // (used: the last to be evicted)
        if (m.slot && this.frozen.get(key) === m) {
          this.frozen.delete(key);
          this.frozen.set(key, m);
        }
        continue;
      }
      // (in the window already — a slide of two regions asks for the strip inside it too)
      if (this.winInfo.has(key) && inWindow(this, wx, wy)) continue;
      startJob(this, key, bring(this, key, wx, wy));
    }
  }

  /**
   * (round 102; the user: "precaching larger areas around atlas-map travel") The land of a window at origin (ox, oy)
   * (world cells, whole regions) and `ring` regions round it, asked for into the pool (made on the GPU, loaded or
   * thawed) — what's there, under way or in the window now needs nothing. A warp there then copies what's ready.
   * Nearest its middle first. Returns how many were asked for.
   */
  precache(ox: number, oy: number, ring = WARP_RING, skipWindow = false): number {
    if (!this.store) return 0;
    const { R, W, H } = this;
    // (merge122) a travel's destination window held in the pool until the warp (a ring after a warp pins nothing)
    if (!skipWindow) {
      this.pinned.clear();
      for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) this.pinned.add(this.key((ox + lx) / R, (oy + ly) / R));
    }
    const spots: [number, number, number][] = [];
    for (let ly = -ring * R; ly < H + ring * R; ly += R)
      for (let lx = -ring * R; lx < W + ring * R; lx += R) spots.push([ox + lx, oy + ly, Math.hypot(lx + R / 2 - W / 2, ly + R / 2 - H / 2)]);
    spots.sort((a, b) => a[2] - b[2]);
    let n = 0;
    for (const [wx, wy] of spots) {
      if (skipWindow && wx >= ox && wy >= oy && wx < ox + W && wy < oy + H) continue;
      const key = this.key(wx / R, wy / R);
      if (this.jobs.has(key) || this.made.has(key)) continue;
      if (this.winInfo.has(key) && inWindow(this, wx, wy)) continue;
      startJob(this, key, bring(this, key, wx, wy));
      n++;
    }
    this.stats.precached += n;
    return n;
  }

  /**
   * (round 117, runplan) Is the land of a window at origin (ox, oy) ready for a warp — every region of it made (in the
   * pool) or in the window now, none still under way? The run's travel on the atlas map waits on this before it
   * arrives (src/runplan/travel.ts Journey), so the travel covers the loading. Without a store nothing is precached:
   * the warp makes the land itself, so it's "ready" (the warp's own wait is the only one).
   */
  precached(ox: number, oy: number): boolean {
    if (!this.store) return true;
    const { R, W, H } = this;
    for (let ly = 0; ly < H; ly += R)
      for (let lx = 0; lx < W; lx += R) {
        const wx = ox + lx;
        const wy = oy + ly;
        const key = this.key(wx / R, wy / R);
        if (this.jobs.has(key)) return false;
        if (!this.made.has(key) && !(this.winInfo.has(key) && inWindow(this, wx, wy))) return false;
      }
    return true;
  }

  /** Move the window by (dx, dy) columns (one of them ±REGION, the other 0). */
  async slide(dx: number, dy: number): Promise<void> {
    if ((dx !== 0) === (dy !== 0) || Math.abs(dx + dy) !== this.R) throw new Error('a slide is one region along one axis');
    if (!this.slideKeeps(dx, dy)) throw new Error(`a slide of (${dx}, ${dy}) would leave the kept rect out of the window`);
    this.busyWhy = 'slide';
    this.busy = true;
    const t0 = performance.now();
    const tr: SlideTrace = { dx, dy, t0, sync: 0, regions: [], end: 0 };
    this.trace.push(tr);
    if (this.trace.length > 200) this.trace.shift();
    try {
      await slideNow(this, dx, dy, tr);
    } finally {
      this.busy = false;
    }
    tr.end = performance.now();
    this.stats.slides++;
    this.stats.lastMs = +(performance.now() - t0).toFixed(1);
  }

  key(rx: number, ry: number): string {
    const w = this.source.wrap;
    if (w) {
      const nx = w[0] / this.R;
      const ny = w[1] / this.R;
      rx = ((rx % nx) + nx) % nx;
      ry = ((ry % ny) + ny) % ny;
    }
    return `${rx},${ry}`;
  }

  /**
   * (round 87) Column (x, y)'s runs above the window that go on from its top (touching it and each other: a
   * spire taller than the window), taken out of what's outside it and returned in window z; the band redrawn there.
   * The integrity system's falling piece takes them with it (the user: a tower stayed standing — its top, above
   * the window, was the band's and never came down).
   */
  takeAbove(x: number, y: number): Interval[] {
    flushFills(this);
    const i = y * this.W + x;
    const top = this.oz + this.core.dims.zMax;
    const out = this.outside[this.oi(i)];
    const keep: Interval[] = [];
    const took: Interval[] = [];
    let at = top;
    for (const iv of [...out].sort((a, b) => a.z0 - b.z0)) {
      if (Math.abs(iv.z0 - at) < 1e-3 && iv.z0 >= top - 1e-3) {
        took.push({ z0: iv.z0 - this.oz, z1: iv.z1 - this.oz, mat: iv.mat });
        at = iv.z1;
      } else keep.push(iv);
    }
    if (!took.length) return took;
    this.outside[this.oi(i)] = keep;
    this.core.renderer.band?.packColumns(this.outside, this.oz, this.core.dims.zMax, [[x, y]]);
    return took;
  }

  /** (round 87) Runs (window z, over the window's top) back outside column (x, y): where a piece that took them landed. */
  putAbove(x: number, y: number, ivs: Interval[]): void {
    if (!ivs.length) return;
    flushFills(this);
    const i = y * this.W + x;
    const all = [...this.outside[this.oi(i)], ...ivs.map((iv) => ({ z0: iv.z0 + this.oz, z1: iv.z1 + this.oz, mat: iv.mat }))].sort((a, b) => a.z0 - b.z0);
    this.outside[this.oi(i)] = all;
    this.core.renderer.band?.packColumns(this.outside, this.oz, this.core.dims.zMax, [[x, y]]);
  }

  /** What's outside the window, drawn (round 79: the renderer's band, when it has one). */
  refreshBand(): void {
    timed('band', () => this.core.renderer.band?.update(this.outside, this.oz, this.core.dims.zMax));
  }

  /**
   * (round 114, scripts/gendeterm.mjs) A region (world corner x0, y0) made as the window makes one (regionInto,
   * WINDOW_MAKE) into a spare slot at the window's oz and hashed: its columns in world z (columnsHash: what a record
   * is checked by) and every byte of the slot. Nothing of the window changes. Made twice — in another order, after a
   * warp, on another page load — the same hashes say the generator is a function of the seed alone.
   */
  genHash(x0: number, y0: number): Promise<{ cols: number; bytes: number; ms: number }> {
    return genHash(this, x0, y0);
  }

  /**
   * (round 102, scripts/gpugentest.mjs) A region (world corner x0, y0) made both ways at the window's oz — the CPU's
   * (source.region, cutRegion, toBody: ?gpugen=0's) and the GPU's (regionInto) — and compared: the slot's bytes word
   * by word, by part (the pages, each kept buffer and texture), and what the CPU keeps (tops, ground, outside, relief,
   * the structural box). Nothing of the window changes.
   */
  compareGen(x0: number, y0: number): Promise<{ words: number; nonzero: number; diff: number; parts: Record<string, number>; first: unknown[]; meta: Record<string, number>; cpuMs: number; gpuMs: number }> {
    return compareGen(this, x0, y0);
  }

  cutRegion(land: RegionLand, snap: Frozen['snap']): Frozen {
    return cutRegion(this, land, snap);
  }

  /**
   * Change the live window's columns in the box (window cells x0..x1, y0..y1) by `at(x, y)` (window
   * cells; layout.ts lowerTop / addTop, world z): read back, changed, written — an event in sight.
   */
  editLive(x0: number, y0: number, x1: number, y1: number, at: (x: number, y: number) => { dr: number; cap?: number; dl: number; lmat: number } | null): Promise<number> {
    return editLive(this, x0, y0, x1, y1, at);
  }

  /** Move the window by dz cells in z (±TIER): every column read back, joined with what's outside it, cut again. */
  /**
   * Move the window somewhere else entirely (round 80, the user: "a way to access the atlas map so I can see
   * where I am or maybe warp"): its origin (world cells, whole regions) and oz (whole tiers). Every region
   * there is generated (or thawed) and written; what's derived per column is cleared, the meshes and the band
   * made again. (Round 100: what the window held is frozen into the pool first, as a slide's strip is — a warp away
   * and back finds it as it was; before, it was dropped.) `fresh` (the run's stage just laid: the window made
   * again with it): the window's regions made again, not thawed — only a record of an earlier session is used, this
   * session's are let go; the land made ahead (before the stage) dropped. The sim waits.
   */
  warp(ox: number, oy: number, oz: number, fresh = false): Promise<void> {
    if (this.keepRect && !keepHeld([ox, oy], this.W, this.H, this.keepRect)) throw new Error('a warp away from the rect the window keeps (let it go first: keep(null))');
    return warp(this, ox, oy, oz, fresh);
  }

  async slideZ(dz: number): Promise<void> {
    if (Math.abs(dz) !== TIER) throw new Error(`a slide in z is one tier (${TIER})`);
    // (round 128m: down to the world's floor, past z 0 — layout.ts WORLD_FLOOR)
    if (this.oz + dz < WORLD_FLOOR) throw new Error('the window is at the bottom of the world');
    this.busyWhy = 'slideZ';
    this.busy = true;
    const t0 = performance.now();
    try {
      const tz = performance.now();
      for (const f of this.onBeforeSlide) f(0, 0, dz);
      this.heldNow = true;
      this.core.windowEpoch++;
      await slideZNow(this, dz);
      record('slideZ', performance.now() - tz);
    } finally {
      this.busy = false;
      this.heldNow = false;
    }
    this.stats.tiers++;
    this.stats.lastMs = +(performance.now() - t0).toFixed(1);
  }

  blankGpu = new Map<string, { buf: GPUBuffer; rowBytes: number }>();

  zeroBuf?: GPUBuffer;
  /** (round 98) the kept buffers' upload (writeNow) */
  writeStage?: GPUBuffer;
  writeHost?: Uint8Array;

}
