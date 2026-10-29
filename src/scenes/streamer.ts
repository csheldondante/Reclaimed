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
import { columnsHash, columnsHashSteps, decodeRecord, encodeRecord, recordMismatch, regionLayout, type RegionLayout, type ThingRecord } from '../world/region-record';
import { CHUNK, K_HEADROOM, PHYS_COL_WORDS, SLOT_WORDS, addTop, fitColumn, joinColumn, lowerTop, packColumn, readSlot, splitColumn, waterInWindow, type Interval } from '../world/layout';
import { ROW_H, cellAt } from '../world/lattice';
import { PROJ_K } from '../grids/structures';
import { generateRegion, type RegionLand } from '../world/streamgen';
import type { WorldCore } from './world-core';
import { SETTLE } from '../sim/sleep';
import { MATERIALS, MatState } from '../world/materials';
import { GPUGEN, type FinishMeta, type FinishTarget } from '../atlas/finish';

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
/**
 * (round 91, ?lead=s) Seconds ahead the camera's motion is followed: the land where it will be then is asked for
 * ahead of the slides. 0: the camera's own place only, as before round 91.
 */
const LEAD = Number((typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('lead')) ?? 1);
/**
 * (round 98, ?streamold=1: the way before, to compare) A slide waits till the land it brings in is made — asked for
 * then if it wasn't ahead — and then moves the window and writes it all in one go: the window isn't `busy` (the sim
 * stopped, the meshes held) while the land is made, only for the frame it's written in.
 */
export const STREAM_OLD = typeof location !== 'undefined' && new URLSearchParams(location.search).get('streamold') === '1';
/**
 * (round 98, ?arrivemesh=0 off) The mesh chunks a slide brought land into are urgent for a few frames (fieldmesh.ts
 * urgent: looked at every frame, the urgent slots over the tier's): those near the view (the hybrid's voxels) are
 * built in a few frames, not one every other frame at the phone tier's one slot.
 */
const ARRIVE_URGENT = typeof location === 'undefined' || new URLSearchParams(location.search).get('arrivemesh') !== '0';
/**
 * (round 98, ?writems=) A slide's regions are written in one frame while they take under this many ms (CPU) — the
 * rest the next frames, the window held `busy` till they're in: a region is ~4 ms on the desktop, a strip five.
 */
const WRITE_MS = Number((typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('writems')) ?? 6);
const param = (k: string) => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(k));
/** (round 100, ?pool=N) regions kept on the GPU out of the window (LRU; ~1.6 MB a region at the atlas's K) */
export const POOL_CAP = Number(param('pool') ?? 32);
/** (round 100, ?ahead=N) strips asked for ahead along the camera's motion (round 102: at least; more as it moves faster) */
const AHEAD = Number(param('ahead') ?? 2);
/** (round 102, ?aheads=) seconds of the camera's motion asked for ahead: strips enough for that at its speed, up to AHEAD_MAX
 *  (0, the default: AHEAD strips — 3 s flooded the tiles with land the camera never reached and the slides waited) */
const AHEAD_S = Number(param('aheads') ?? 0);
const AHEAD_MAX = 4;
/** (round 102, ?warpring=N) regions round a warp's window asked for into the pool as it lands (and as its target is picked) */
const WARP_RING = Number(param('warpring') ?? 1);
/** (round 100) cells a second the camera's motion must pass to be followed ahead */
const MOVING = 6;
/** (round 100, ?sweepms=) the window's regions read back for the store, one every this many ms */
const SWEEP_MS = Number(param('sweepms') ?? 400);
/** (round 100) uploads of made land into the pool: this many ms of a frame at most (one at least) */
const UPLOAD_MS = 3;
/** (round 104) a readback's hashing and encoding for the store (Streamer.later): this many ms of a frame at most (one at least) */
const LATER_MS = 3;
/** (round 106, tilephone) a region's hash's time a turn of Streamer.later (ms): a few rows at a time */
const HASH_SLICE_MS = 0.4;
/** (round 104, ?uploadmb=) and at most this many MB uploaded into the pool a frame (one region at least): the phone's
 *  frame with a few regions' writeBuffers in it was gpu-busy */
const UPLOAD_BYTES = Number(param('uploadmb') ?? 2) * 1048576;
/** (round 100) a page load's id: a record says which session wrote it */
export const SESSION = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
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
  /**
   * (round 100) a region came in from the store, not made: what the source keeps of land it makes (the settlements'
   * plans, the run's stage pieces' bases) is told, as if it had made it — the land itself is the record's
   */
  restored?(x0: number, y0: number, w: number, h: number): Promise<void>;
  /**
   * (round 102, `gpugen`) the region made on the GPU straight into `target` (a pool slot, in the streamer's region
   * layout, cut at its oz): what the CPU keeps of it returned (atlas/finish.ts). With it (and without ?gpugen=0) the
   * streamer never sees the land's columns: arrival is a pool → window copy.
   */
  regionInto?(x0: number, y0: number, w: number, h: number, target: FinishTarget): Promise<FinishMeta>;
  /** (round 105, tilelatency) a render-only tile's land: regionInto's, nothing read back (Atlas.regionTile) */
  regionTile?(x0: number, y0: number, w: number, h: number, target: FinishTarget, meta: { buf: GPUBuffer; off: number }): Promise<void>;
}

/** (round 100) what the store saves for a world: its id (the atlas's seed, the run), whether it's kept on disk */
export interface WorldSave {
  world: string;
  /** false: ?worldsave=0 — the session's memory only */
  disk: boolean;
  /** ?world=new: this world's records cleared first */
  fresh: boolean;
}

/** (round 100) a region's things (meshes with transforms that own cells: sim/external.ts) — taken as it's frozen, given back as it's written */
export interface RegionThings {
  name: string;
  /** the things wholly inside window box x0..x1, y0..y1 (cells), out of play now, as records (cells from the box's
   *  corner); `keep`: as records only, still in play (the window saved as it is) */
  take(x0: number, y0: number, x1: number, y1: number, keep?: boolean): ThingRecord[];
  /** records of a region written at window cell (x0, y0): in play again */
  give(things: ThingRecord[], x0: number, y0: number): void;
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
  /** the land source's snapshot when it was made or left (LandSource.snapshot; round 100: a promise till it's read) */
  snap?: unknown;
  /** the ground's own top a column (window z at oz: under what stands on it), when the source says */
  ground?: Float32Array;
  /** its chunks' pages, chunk by chunk (row-major in the region) — (round 100) on the CPU: made, loaded, or read back to change */
  layers?: Uint32Array;
  /** (round 104) loaded from the store: the region's bytes in the pool's layout as they came (uploaded as they are,
   *  split into layers, bufs and texs only when the CPU needs them — Streamer.cpuNow) */
  body?: Uint8Array;
  /** each kept buffer's columns: per plane, REGION rows of REGION × stride bytes */
  bufs?: Record<string, Uint8Array>;
  /** each kept texture's texels, rows of the region's width (rgba32float) */
  texs?: Record<string, Float32Array>;
  surface: Float32Array;
  /** (round 98) its columns' relief (Streamer.relief, gapTop, colTop), made ahead of the slide when it was ready */
  relief?: { relief: Uint8Array; gapTop: Float32Array; colTop: Float32Array };
  /** (round 100) its land on the GPU: a slot of the region pool */
  slot?: PoolSlot;
  /** (round 100) its columns' hashes: as made, as last saved (shared with the window while it's in it) */
  info: RegionInfo;
  /** (round 100) where it came from */
  how: 'thawed' | 'loaded' | 'made';
  /** (round 100) its things (RegionThings), taken with it */
  things?: ThingRecord[];
  /** (round 106, frameprobe) frozen by a slide, its CPU parts not read yet: read them now (Streamer.fills) */
  fill?: () => void;
}

/** (round 100) what's known of a region's columns (world/region-record.ts columnsHash) */
interface RegionInfo {
  /**
   * changed by play — an edit (the world API's, the editor's, an agent's dig, a story's door), lightning, a meteor,
   * a fire lit, a tap to grow, what fell from them (Streamer.touch) — not by the sims' own drift: saved whenever
   * it's read back different from what's saved; a region never touched is made again when it's wanted
   */
  changed?: boolean;
  /** its columns' hash as last saved, and as last read back (a freeze's, a sweep's) */
  saved?: number;
  last?: number;
}

/** (round 100) a region read back for the store: its key, corner (world cells) and CPU parts as they were */
/** (round 106, frameprobe) a slide's freeze: planned in its frame, each region copied out just before its place is written (Streamer.freezeAt) */
interface Freeze {
  stage: GPUBuffer | null;
  items: SaveItem[];
  entries: [string, Frozen][];
  /** by the window index (y * W + x, the window after the slide) of the region coming in where it lay */
  pending: Map<number, { it: SaveItem; key: string; read: boolean; k: number; snap: unknown }>;
}

interface SaveItem {
  key: string;
  x0: number;
  y0: number;
  oz: number;
  outside: Interval[][];
  surface: Float32Array;
  ground: Float32Array;
  relief: { relief: Uint8Array; gapTop: Float32Array; colTop: Float32Array };
  info: RegionInfo;
  things?: ThingRecord[];
  /** (round 106, frameprobe) its CPU parts not read yet: read them now, where the region lay on the ring (Streamer.fills) */
  fill?: () => void;
}

/** (round 98) a slide's timeline (performance.now() ms): its start, its synchronous part's end, each region coming in
 *  (thawed, made ahead, or made now; when its land was ready and when written), its end */
export interface SlideTrace {
  dx: number;
  dy: number;
  t0: number;
  sync: number;
  regions: { how: 'thawed' | 'ahead' | 'made' | 'loaded'; ready: number; written: number }[];
  end: number;
}

/** (round 98) a region's build: asked for, its land made (the source's), cut into the window's form */
export interface GenTrace {
  x0: number;
  y0: number;
  asked: number;
  land: number;
  done: number;
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
  /** (round 100) the pool and the store: regions evicted from the pool, read back and hashed, written to the store,
   *  loaded from it, restored into the window on load, records that couldn't be used (made again), uploads into the pool */
  evicted: number;
  /** regions play touched (Streamer.touch) */
  touched: number;
  checked: number;
  saved: number;
  loaded: number;
  restored: number;
  mismatched: number;
  loadFailed: number;
  uploads: number;
  /** (round 102) regions made on the GPU straight into the pool (atlas/finish.ts); asked for ahead of a warp (precache), and
   *  of a warp's regions, those made or under way before it */
  gpuMade: number;
  precached: number;
  warpReady: number;
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
  private winInfo = new Map<string, RegionInfo>();
  /** (round 100) a region's readback and save under way (a region evicted before it's done is loaded after it) */
  private checks = new Map<string, Promise<void>>();
  /** (round 100) the coarse world's snapshot of regions evicted this session (LandSource.changes, when they come back) */
  private snaps = new Map<string, unknown>();
  /** (round 100) what owns things in the regions (meshes with transforms) */
  readonly things: RegionThings[] = [];
  /** (round 100) false while what's in the window shouldn't be saved (something falling: it would be saved mid-air) */
  canSave: (() => boolean)[] = [];
  /** (round 100) GPU pool uploads waiting for a frame */
  private uploads: { f: Frozen; slot: PoolSlot; res: () => void }[] = [];
  private uploadHost?: Uint8Array;
  private sweepAt = 0;
  private sweepT = 0;
  private sweeping = false;
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
  private busyNow = false;
  /** slide on its own as the camera nears the edge (tests turn it off to slide by hand) */
  auto = true;
  readonly stats: SlideStats = { slides: 0, frozen: 0, generated: 0, thawed: 0, prefetched: 0, lastMs: 0, tiers: 0, resliced: 0, fitted: 0, changed: 0, settled: 0, evicted: 0, touched: 0, checked: 0, saved: 0, loaded: 0, restored: 0, mismatched: 0, loadFailed: 0, uploads: 0, gpuMade: 0, precached: 0, warpReady: 0 };
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
  private heldNow = false;
  /** the world height of the window's z = 0 */
  oz = 0;
  /** (round 105, ringwin) window column i (y * W + x)'s place in `outside` (on the ring) */
  private oi(i: number): number {
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
  private colK: number;
  /** per window column: the ground's own top (window z; round 75: a slide in z goes by it, not by what
   *  stands on it — a giant's point under the camera isn't where the land is) */
  readonly ground: Float32Array;
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
  /** called when land comes into the window that the structural system should judge: the box (window cells) round it */
  readonly onArrive: ((x0: number, y0: number, x1: number, y1: number) => void)[] = [];
  /** the window was moved somewhere else entirely (warp): its new origin and oz — what the game keeps in window coordinates is void */
  readonly onWarp: ((ox: number, oy: number, oz: number) => void)[] = [];
  private bufs: ColBuf[];
  private texs: ColTex[];
  /** (round 104) a region's buffers to and from a pool slot, a dispatch a buffer */
  private copier: RegionCopier;
  /** slots a chunk page holds (every chunk has the same K) */
  private pageSlots: number;
  private K: number;

  constructor(
    private core: WorldCore,
    private source: LandSource = noiseLand(),
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
    if (!core.ring.zero) {
      const o = this.outside;
      this.outside = new Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.outside[core.ring.idx(x, y)] = o[y * w + x];
    }
    // (round 106, frameprobe: the ground on the ring too, as `outside` and core.map.surface (world-core.ts) — a slide
    // moves none of them: read a column through colIdx)
    this.ground = tier?.ground ? core.ring.toRing(tier.ground.slice()) : core.map.surface.slice();
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
        this.setRelief(si, joinColumn(col, this.oz, this.outside[si]), core.map.surface[si], this.ground[si]);
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
        const out = this.regionOutside(this.core.ring.corner(lx, ly));
        const last = columnsHash(pages, L, out, this.oz);
        this.winInfo.set(this.key((origin[0] + lx) / R, (origin[1] + ly) / R), { last });
      }
    // (round 100) the store: opened, cleared for a new world, the window's saved regions restored; till then the
    // window doesn't slide (a region made before the index is read might have had a record)
    const fail = (e: unknown) => {
      this.storeError = String((e as Error)?.message ?? e);
      console.error(`[worldsave] ${this.storeError} — this session's changes are kept in memory only, not saved`);
      return RegionStore.open(save.world, true);
    };
    void (save.disk ? RegionStore.open(save.world).catch(fail) : RegionStore.open(save.world, true))
      .then(async (s) => {
        if (save.fresh) await s.clear();
        await this.restore(s);
        this.store = s;
      })
      .catch((e) => console.error(`[worldsave] the store failed: ${(e as Error)?.message ?? e}`));
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        // (a phone backgrounding the page: the whole window read back for the store now)
        if (document.visibilityState === 'hidden') this.sweep(true);
      });
  }

  /** (round 100) the window's outside intervals of the region at ring place `at` (Ring.corner), row-major in the region */
  private regionOutside(at: number): Interval[][] {
    const { R, W } = this;
    const o: Interval[][] = new Array(R * R);
    for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) o[r * R + c] = this.outside[at + r * W + c];
    return o;
  }

  /** (round 100) a w-wide CPU grid's region at ring place `o` (Ring.corner), copied (round 106: the grid on the ring — the region's rows where it lies) */
  private regionOf<T extends Float32Array | Uint8Array>(a: T, o: number): T {
    const { R, W } = this;
    const s = new (a.constructor as { new (n: number): T })(R * R);
    for (let r = 0; r < R; r++) s.set(a.subarray(o + r * W, o + r * W + R), r * R);
    return s;
  }

  /**
   * (round 100) the CPU parts of the window's region at (lx, ly), for the store. (Round 106, frameprobe: read later —
   * `fill` — from where the region lies on the ring: the CPU's per-column arrays are on the ring, so a slide leaves them
   * where they are until the region coming in is written there, and whatever writes there fills first (Streamer.fills).
   * The slide's own frame no longer copies a strip of them.)
   */
  private saveItem(lx: number, ly: number, key: string, now = false): SaveItem {
    let info = this.winInfo.get(key);
    if (!info) this.winInfo.set(key, (info = {}));
    const at = this.core.ring.corner(lx, ly);
    const it: SaveItem = { key, x0: this.origin[0] + lx, y0: this.origin[1] + ly, oz: this.oz, outside: [], surface: NO_F32, ground: NO_F32, relief: { relief: NO_U8, gapTop: NO_F32, colTop: NO_F32 }, info };
    it.fill = () => {
      it.fill = undefined;
      it.outside = this.regionOutside(at);
      it.surface = this.regionOf(this.core.map.surface, at);
      it.ground = this.regionOf(this.ground, at);
      it.relief = { relief: this.regionOf(this.relief, at), gapTop: this.regionOf(this.gapTop, at), colTop: this.regionOf(this.colTop, at) };
    };
    if (now) it.fill();
    else this.fills.push({ at, it });
    return it;
  }

  /** (round 106, frameprobe) the regions frozen whose CPU parts aren't read yet, and where they lie on the ring */
  private fills: { at: number; it: SaveItem }[] = [];

  /** (round 106) the frozen region at ring place `at` read before something writes there */
  private fillAt(at: number): void {
    if (!this.fills.length) return;
    const t0 = performance.now();
    for (const f of this.fills) if (f.at === at) f.it.fill?.();
    this.fills = this.fills.filter((f) => f.it.fill);
    record('fz.fill', performance.now() - t0);
  }

  /** (round 106) every frozen region's CPU parts read (before the window's columns are written other than a region at a time) */
  private flushFills(): void {
    if (!this.fills.length) return;
    const t0 = performance.now();
    for (const f of this.fills) f.it.fill?.();
    this.fills = [];
    record('fz.fill', performance.now() - t0);
  }

  /** (round 100) Copy the window's region at (lx, ly) into `dst` at `off`, in the region layout. */
  private copyOut(enc: GPUCommandEncoder, lx: number, ly: number, dst: GPUBuffer, off: number, kernel = true, flush = true): void {
    const { W, R } = this;
    // (round 105, ringwin: the region's place on the ring — whole regions, so one rectangle)
    const [px, py] = this.core.ring.at(lx, ly);
    const L = this.layout;
    const wg = this.core.world;
    const table = this.core.packed.chunkTable;
    const cx = W / CHUNK;
    for (let j = 0; j < L.rc; j++)
      for (let i = 0; i < L.rc; i++) {
        const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
        enc.copyBufferToBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, dst, off + (j * L.rc + i) * L.pageBytes, L.pageBytes);
      }
    const H = this.H;
    for (const lb of L.bufs) {
      const b = this.bufs.find((x) => x.name === lb.name)!;
      // (round 104: a dispatch a buffer — dst must be a storage buffer: a pool slot, not a readback's stage)
      if (kernel) {
        const s = b.stride / 4;
        this.copier.rect({ src: b.buf, srcOff: (py * W + px) * s, srcRow: W * s, srcPlane: W * H * s, dst, dstOff: (off + lb.off) / 4, dstRow: R * s, dstPlane: R * R * s, rowWords: R * s, rows: R, planes: b.planes });
        continue;
      }
      for (let p = 0; p < b.planes; p++)
        for (let r = 0; r < R; r++) enc.copyBufferToBuffer(b.buf, p * W * H * b.stride + ((py + r) * W + px) * b.stride, dst, off + lb.off + (p * R + r) * R * b.stride, R * b.stride);
    }
    // (round 106: a caller freezing several encodes their rectangles once, in one pass)
    if (flush) this.copier.encode(enc);
    for (const lt of L.texs) {
      const t = this.texs.find((x) => x.name === lt.name)!;
      enc.copyTextureToBuffer({ texture: t.tex, origin: [(px / t.div) * t.per, py / t.div] }, { buffer: dst, offset: off + lt.off, bytesPerRow: lt.rowBytes }, [lt.tw, lt.th]);
    }
  }

  /** (round 100) Copy a region's bytes (a pool slot) into the window at (lx, ly): its pages to the layers (and layersNext). */
  private copyIn(enc: GPUCommandEncoder, src: GPUBuffer, off: number, lx: number, ly: number, once = false): void {
    const { W, H, R } = this;
    const [px, py] = this.core.ring.at(lx, ly);
    const L = this.layout;
    const wg = this.core.world;
    const table = this.core.packed.chunkTable;
    const cx = W / CHUNK;
    for (let j = 0; j < L.rc; j++)
      for (let i = 0; i < L.rc; i++) {
        const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
        for (const b of [wg.layers, wg.layersNext]) enc.copyBufferToBuffer(src, off + (j * L.rc + i) * L.pageBytes, b, table[ci * 2] * SLOT_WORDS * 4, L.pageBytes);
      }
    for (const lb of L.bufs) {
      const b = this.bufs.find((x) => x.name === lb.name)!;
      const s = b.stride / 4;
      this.copier.rect({ src, srcOff: (off + lb.off) / 4, srcRow: R * s, srcPlane: R * R * s, dst: b.buf, dstOff: (py * W + px) * s, dstRow: W * s, dstPlane: W * H * s, rowWords: R * s, rows: R, planes: b.planes, once });
    }
    this.copier.encode(enc);
    for (const lt of L.texs) {
      const t = this.texs.find((x) => x.name === lt.name)!;
      enc.copyBufferToTexture({ buffer: src, offset: off + lt.off, bytesPerRow: lt.rowBytes }, { texture: t.tex, origin: [(px / t.div) * t.per, py / t.div] }, [lt.tw, lt.th]);
    }
  }

  /** (round 100) a region's bytes (the layout's) from its CPU form, in a host buffer reused (valid till the next call) */
  private toBody(f: Frozen): Uint8Array {
    const L = this.layout;
    const host = (this.uploadHost ??= new Uint8Array(L.bytes));
    host.fill(0);
    const ly = f.layers!;
    host.set(new Uint8Array(ly.buffer, ly.byteOffset, Math.min(ly.byteLength, L.rc * L.rc * L.pageBytes)), 0);
    for (const lb of L.bufs) {
      const d = f.bufs?.[lb.name];
      if (d) host.set(d.subarray(0, lb.bytes), lb.off);
    }
    for (const lt of L.texs) {
      const d = f.texs?.[lt.name];
      if (!d) continue;
      const row = lt.tw * 16;
      const u = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      for (let r = 0; r < lt.th; r++) host.set(u.subarray(r * row, (r + 1) * row), lt.off + r * lt.rowBytes);
    }
    return host;
  }

  /** (round 100) a region's CPU form (layers, kept buffers, kept textures) from its bytes */
  private fromBody(body: Uint8Array): Pick<Frozen, 'layers' | 'bufs' | 'texs'> {
    const L = this.layout;
    const layers = new Uint32Array(body.slice(0, L.rc * L.rc * L.pageBytes).buffer);
    const bufs: Record<string, Uint8Array> = {};
    for (const lb of L.bufs) bufs[lb.name] = body.slice(lb.off, lb.off + lb.bytes);
    const texs: Record<string, Float32Array> = {};
    for (const lt of L.texs) {
      const d = new Float32Array(lt.tw * lt.th * 4);
      const u = new Uint8Array(d.buffer);
      const row = lt.tw * 16;
      for (let r = 0; r < lt.th; r++) u.set(body.subarray(lt.off + r * lt.rowBytes, lt.off + r * lt.rowBytes + row), r * row);
      texs[lt.name] = d;
    }
    return { layers, bufs, texs };
  }

  /** (round 100) A pool slot: a free one, or the least recently used region's (evicted: on disk if it changed). */
  private slotFor(): PoolSlot | null {
    for (;;) {
      const s = this.pool.alloc();
      if (s) return s;
      // (round 104: the least recently used of those more than a region and a half outside where the window is
      // heading — the window's middle a second of the camera's motion on — else the farthest; never what a job is
      // working on. Round 102 evicted what was left behind before what was made ahead: a pan back and forth lost the
      // regions it was coming back to, loaded from disk or made again — BN28)
      const R = this.R;
      const lead = (v: number) => Math.max(-2 * R, Math.min(2 * R, v));
      const cx = (this.origin[0] + this.W / 2 + lead(this.vel[0])) / R - 0.5;
      const cy = (this.origin[1] + this.H / 2 + lead(this.vel[1])) / R - 0.5;
      const wrap = this.source.wrap;
      const d1 = (d: number, n?: number) => (n ? Math.min(Math.abs(d) % n, n - (Math.abs(d) % n)) : Math.abs(d));
      const nearX = this.W / R / 2 + 1.5;
      const nearY = this.H / R / 2 + 1.5;
      let victim: string | null = null;
      let far = -1;
      for (const k of this.frozen.keys()) {
        if (this.jobs.has(k)) continue;
        const [rx, ry] = k.split(',').map(Number);
        const ax = d1(rx - cx, wrap && wrap[0] / R);
        const ay = d1(ry - cy, wrap && wrap[1] / R);
        // (frozen is in LRU order: the first one outside is the oldest)
        if (ax > nearX || ay > nearY) {
          victim = k;
          break;
        }
        const d = Math.hypot(ax, ay);
        if (d > far) {
          far = d;
          victim = k;
        }
      }
      if (victim === null) return null;
      this.evict(victim);
    }
  }

  /** (round 100) A region out of the pool: its slot freed. If it changed it was (or is being) saved by its check. */
  private evict(key: string): void {
    const f = this.frozen.get(key);
    if (!f) return;
    this.frozen.delete(key);
    this.made.delete(key);
    if (f.slot) this.pool.release(f.slot);
    if (f.snap !== undefined) this.snaps.set(key, f.snap);
    this.stats.evicted++;
  }

  /** (round 104) a loaded region's bytes split into its CPU form (layers, bufs, texs) */
  private cpuNow(f: Frozen): Frozen {
    if (f.layers || !f.body) return f;
    return { ...f, ...this.fromBody(f.body), body: undefined };
  }

  /** (round 100) A region out of the pool (or the CPU form), on the CPU — read back from its slot when it isn't. */
  private async cpu(f: Frozen): Promise<Frozen> {
    if (f.layers || f.body) return this.cpuNow(f);
    if (!f.slot) throw new Error('a frozen region with neither its land on the CPU nor a slot');
    const dev = this.core.host.gpu.device;
    const st = dev.createBuffer({ label: 'region readback', size: this.layout.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'region readback' });
    enc.copyBufferToBuffer(f.slot.buf, f.slot.off, st, 0, this.layout.bytes);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const body = new Uint8Array(st.getMappedRange()).slice();
    st.unmap();
    st.destroy();
    return { ...f, ...this.fromBody(body) };
  }

  /**
   * (round 100) Regions read back (`stage`, one after another in the layout) and hashed: each that changed since it
   * was made or last saved is written to the store, whole. Nothing waits for it but a load of the same region.
   */
  private check(stage: GPUBuffer, items: SaveItem[]): void {
    // (round 104) each region's hash and record a task of its own, a few a frame (Streamer.later): the strip's eight in
    // one callback were a long task; the stage read in place, unmapped when the last is done (no 13 MB copy)
    const p = stage.mapAsync(GPUMapMode.READ).then(
      () =>
        new Promise<void>((res) => {
          const all = new Uint8Array(stage.getMappedRange());
          let left = items.length;
          const end = () => {
            if (--left > 0) return;
            stage.unmap();
            stage.destroy();
            for (const a of [this.times.hash, this.times.encode]) if (a.length > 400) a.splice(0, a.length - 400);
            res();
          };
          if (!left) {
            left = 1;
            end();
          }
          items.forEach((it, k) =>
            this.later(() => {
              try {
                this.checkOne(all, k, it, end);
              } catch (e) {
                end();
                throw e;
              }
            }),
          );
        }),
      () => stage.destroy(),
    );
    for (const it of items) {
      const was = this.checks.get(it.key);
      const q = was ? Promise.all([was, p]).then(() => {}) : p;
      this.checks.set(it.key, q);
      void q.then(() => this.checks.get(it.key) === q && this.checks.delete(it.key));
    }
  }

  /**
   * (round 104) one region of a readback hashed and, if play changed it since it was saved, written to the store;
   * `done` once it's through (the readback is let go then). (Round 106, tilephone: hashed a few rows a turn of
   * Streamer.later — HASH_SLICE_MS each — not whole inside one frame: the phone's rs.hash, 1.1-2.7 ms.)
   */
  private checkOne(all: Uint8Array, k: number, it: SaveItem, done: () => void): void {
    const L = this.layout;
    const body = all.subarray(k * L.bytes, (k + 1) * L.bytes);
    // (round 106: its CPU parts, if not read yet — still where it lay: whatever writes there reads them first)
    it.fill?.();
    // (not touched by play: nothing to keep — the source makes it again; hashed only for ?rsverify)
    if (!it.info.changed && !this.verify) {
      done();
      return;
    }
    const g = columnsHashSteps(new Uint32Array(all.buffer, k * L.bytes, (L.rc * L.rc * L.pageBytes) / 4), L, it.outside, it.oz, undefined, 4);
    let spent = 0;
    const step = () => {
      let ok = false;
      try {
        const t0 = performance.now();
        let r = g.next();
        while (!r.done && performance.now() - t0 < HASH_SLICE_MS) r = g.next();
        spent += performance.now() - t0;
        record('rs.hash', performance.now() - t0);
        if (!r.done) {
          ok = true;
          this.later(step);
          return;
        }
        this.hashed(body, it, r.value, spent);
        ok = true;
        done();
      } finally {
        if (!ok) done();
      }
    };
    step();
  }

  /** (round 106) a region's hash in: kept, and written to the store if play changed it since it was saved */
  private hashed(body: Uint8Array, it: SaveItem, h: number, spent: number): void {
    const L = this.layout;
    this.times.hash.push(spent);
    this.stats.checked++;
    it.info.last = h;
    if (!it.info.changed || h === it.info.saved || !this.store || this.halted) return;
    const t1 = performance.now();
    const [rx, ry] = it.key.split(',').map(Number);
    const rec = encodeRecord(
      { world: this.save.world, rx, ry, x0: it.x0, y0: it.y0, oz: it.oz, sig: L.sig, session: SESSION, savedAt: Date.now(), hash: h, things: it.things },
      body,
      { oz: it.oz, outside: it.outside, surface: it.surface, ground: it.ground, relief: it.relief },
    );
    this.times.encode.push(performance.now() - t1);
    record('rs.encode', performance.now() - t1);
    it.info.saved = h;
    this.stats.saved++;
    void this.store.put(it.key, rec, { session: SESSION, hash: h });
  }

  /**
   * (round 104) Main-thread work that isn't the frame's (a readback's hashing and encoding): run from update() while
   * it fits LATER_MS of the frame (one at least), at once while the page is hidden (no frames come then).
   */
  private later(f: () => void): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') f();
    else this.laterQ.push(f);
  }
  private laterQ: (() => void)[] = [];
  private drainLater(): void {
    const t0 = performance.now();
    for (let n = 0; this.laterQ.length && (n === 0 || performance.now() - t0 < LATER_MS); n++) this.laterQ.shift()!();
  }

  /**
   * (round 100) The window's regions read back for the store: the next one (every SWEEP_MS), or all of them (the
   * page hidden). Not while a slide or a warp is under way, a region not written yet, or something falling.
   */
  private sweep(all = false): boolean {
    if (!this.store || this.busy || this.heldNow || this.sweeping) return false;
    if (this.canSave.some((f) => !f())) return false;
    const now = performance.now();
    if (!all && now - this.sweepT < SWEEP_MS) return false;
    this.sweepT = now;
    const { W, H, R } = this;
    const spots: [number, number][] = [];
    for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) spots.push([lx, ly]);
    const pick = all ? spots : [spots[this.sweepAt++ % spots.length]];
    // (round 104: and only what play changed, or ?rsverify — the rest is made again when it's wanted: its readback
    // was for nothing)
    const go = pick.filter(([lx, ly]) => !this.unwritten.some(([x, y]) => x === lx && y === ly) && (this.verify || this.winInfo.get(this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R))?.changed));
    // (nothing changed: a whole sweep has nothing to save — done)
    if (!go.length) return all;
    const dev = this.core.host.gpu.device;
    const L = this.layout;
    const stage = dev.createBuffer({ label: 'region save', size: L.bytes * go.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'region save' });
    go.forEach(([lx, ly], k) => this.copyOut(enc, lx, ly, stage, k * L.bytes, false));
    dev.queue.submit([enc.finish()]);
    const items = go.map(([lx, ly]) => {
      // (a region staying in the window: its CPU parts read now, with its readback)
      const it = this.saveItem(lx, ly, this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R), true);
      const things = this.things.flatMap((t) => t.take(lx, ly, lx + R, ly + R, true));
      if (things.length) it.things = things;
      return it;
    });
    this.sweeping = true;
    this.check(stage, items);
    void Promise.all(items.map((it) => this.checks.get(it.key))).finally(() => (this.sweeping = false));
    return true;
  }

  /**
   * (round 100, scripts/worldsavetest.mjs) Each region written into the window from the pool or the store read back at
   * once (before the sims' next tick) and its columns hashed against the hash it was frozen or saved with: `verified`.
   */
  verify = param('rsverify') === '1';
  readonly verified: { key: string; how: string; same: boolean; at: number }[] = [];
  private verifyNow(lx: number, ly: number, key: string, how: string, want: number): void {
    const dev = this.core.host.gpu.device;
    const L = this.layout;
    const st = dev.createBuffer({ label: 'region verify', size: L.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'region verify' });
    this.copyOut(enc, lx, ly, st, 0, false);
    dev.queue.submit([enc.finish()]);
    const out = this.regionOutside(this.core.ring.corner(lx, ly)).map((c) => c.slice());
    const oz = this.oz;
    void st.mapAsync(GPUMapMode.READ).then(() => {
      const body = new Uint8Array(st.getMappedRange()).slice();
      st.unmap();
      st.destroy();
      const h = columnsHash(new Uint32Array(body.buffer, 0, (L.rc * L.rc * L.pageBytes) / 4), L, out, oz);
      this.verified.push({ key, how, same: h === want, at: performance.now() });
    });
  }

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
  private halted = false;

  /** (round 100) Every region of the window read back now and, where it changed, saved; resolves when it's on disk. */
  async saveAll(): Promise<void> {
    // (till a sweep of the whole window runs: not while a slide is under way or something falls)
    for (let t = 0; !this.sweep(true); t++) {
      if (t > 600) throw new Error('saveAll: the window never came still enough to save (10 s)');
      await new Promise((r) => setTimeout(r, 16));
    }
    await Promise.all([...this.checks.values()]);
    await this.store?.flush();
  }

  /** (round 100) A region's record from the store as a frozen region (null: none usable — why reported). */
  private async load(key: string): Promise<Frozen | null> {
    const s = this.store;
    if (!s?.has(key)) return null;
    const t0 = performance.now();
    let bytes: Uint8Array;
    try {
      bytes = await s.get(key);
    } catch (e) {
      this.stats.loadFailed++;
      console.error(`[worldsave] ${(e as Error).message} — the region is made again from the generator, its changes lost`);
      return null;
    }
    // (round 104: 'rs.load' the main thread's part only — the decode; the wait for the worker isn't the frame's, and
    // the recorder counted it as a step 30–77 ms long)
    const td = performance.now();
    const d = decodeRecord(bytes, this.R);
    record('rs.load', performance.now() - td);
    const why = recordMismatch(d.header, this.layout, this.save.world);
    if (why) {
      this.stats.mismatched++;
      console.warn(`[worldsave] region ${key}'s record can't be used: ${why} — the region is made again`);
      void s.delete(key);
      return null;
    }
    this.stats.loaded++;
    this.times.load.push(performance.now() - t0);
    const { meta, header } = d;
    return {
      body: d.body,
      oz: meta.oz,
      outside: meta.outside,
      surface: meta.surface,
      ground: meta.ground,
      relief: meta.relief,
      // (the coarse world's snapshot: this session's when it left the pool, else the coarse world now — another
      // session's coarse world started again)
      snap: this.snaps.get(key) ?? this.source.snapshot?.(header.x0, header.y0, this.R, this.R),
      info: { saved: header.hash, last: header.hash, changed: true },
      how: 'loaded',
      things: header.things,
    };
  }

  /**
   * (round 100) On load: the window's regions that have a record written in as they were saved (the window
   * otherwise is as the source made it). Busy meanwhile; what the game keeps in window coordinates told as by a warp.
   */
  private async restore(s: RegionStore): Promise<void> {
    const { W, H, R } = this;
    const spots: [number, number][] = [];
    for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) if (s.has(this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R))) spots.push([lx, ly]);
    if (!spots.length) return;
    while (this.busy) await new Promise((r) => setTimeout(r, 16));
    this.busy = true;
    this.heldNow = true;
    const t0 = performance.now();
    try {
      for (const f of this.onBeforeSlide) f(0, 0, 0);
      this.core.windowEpoch++;
      this.store = s;
      let n = 0;
      for (const [lx, ly] of spots) {
        const key = this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R);
        let f = await this.load(key);
        if (!f) continue;
        if (f.oz !== this.oz) f = this.reslice(f);
        this.write(f, lx, ly);
        void this.source.restored?.(this.origin[0] + lx, this.origin[1] + ly, R, R);
        n++;
      }
      this.store = null;
      this.core.renderer.windowMoved(1 << 12, 0, [0, 0, 0]);
      this.refreshBand();
      this.core.clearUndo();
      this.core.windowEpoch++;
      this.stats.restored += n;
      for (const f of this.onWarp) f(this.origin[0], this.origin[1], this.oz);
      console.log(`[worldsave] ${n} saved regions of ${this.save.world} restored into the window in ${(performance.now() - t0).toFixed(0)} ms`);
    } finally {
      this.busy = false;
      this.heldNow = false;
    }
  }

  /** (hybrid) column i's relief from its runs (world z, joined), its surface and its ground's own top (window z) */
  private setRelief(i: number, col: Interval[], surface: number, ground: number): void {
    setReliefIn(this, i, col, surface, ground);
  }

  /** (round 98) a region's relief, as writeNow would make it (the runs joined are world z: the same at any oz) */
  private reliefOf(f: Frozen): NonNullable<Frozen['relief']> {
    const R = this.R;
    const out = { relief: new Uint8Array(R * R), gapTop: new Float32Array(R * R), colTop: new Float32Array(R * R) };
    const gr = f.ground ?? f.surface;
    for (let r = 0; r < R; r++)
      for (let c = 0; c < R; c++) {
        const i = r * R + c;
        setReliefIn(out, i, joinColumn(this.columnOf(f.layers!, c, r), f.oz, f.outside[i]), f.surface[i], gr[i]);
      }
    return out;
  }

  /** The world cell under window cell (x, y). */
  toWorld(x: number, y: number): [number, number] {
    return [x + this.origin[0], y + this.origin[1]];
  }

  /** (round 91) the regions a slide under way has moved the window over but not written yet (local corners):
   *  the window's land there is stale until they are (scripts/edgeprobe.mjs measures the view against it) */
  unwritten: [number, number][] = [];

  /** (round 100) land asked for (made, loaded or thawed, checked, cut, uploaded), by region key */
  private jobs = new Map<string, Promise<Frozen>>();
  /** (round 100) jobs a slide or a warp took over (their land is theirs to write) */
  private taken = new WeakSet<Promise<Frozen>>();
  /** (round 98) land ready to write (made ahead, or thawed and checked), by region key — round 100: in the pool */
  private made = new Map<string, Frozen>();
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
  private baseAt = 0;
  private doneAfter(into: number[]): void {
    const t0 = performance.now();
    void this.core.host.gpu.device.queue.onSubmittedWorkDone().then(() => {
      into.push(+(performance.now() - t0).toFixed(1));
      if (into.length > 64) into.shift();
    });
  }

  /** (round 91) the camera's velocity (cells a second, world x and rows), smoothed; where it was, and when */
  readonly vel: [number, number] = [0, 0];
  private last: [number, number, number] | null = null;

  /** the camera's velocity, from its target's world cell frame to frame (a jump — a warp — isn't motion) */
  private track(): void {
    const t = performance.now() / 1000;
    const [x, yw] = this.core.camera.target;
    const wx = this.origin[0] + x;
    const wy = this.origin[1] + yw / ROW_H;
    const l = this.last;
    this.last = [wx, wy, t];
    if (!l) return;
    const dt = t - l[2];
    const dx = wx - l[0];
    const dy = wy - l[1];
    if (dt <= 0) return;
    if (dt > 0.5 || Math.hypot(dx, dy) > 2 * this.R) {
      this.vel[0] = this.vel[1] = 0;
      return;
    }
    // (over about a quarter of a second)
    const a = Math.min(1, dt / 0.25);
    this.vel[0] += (dx / dt - this.vel[0]) * a;
    this.vel[1] += (dy / dt - this.vel[1]) * a;
  }

  /** Slide when the camera has come within 1¼ regions of the window's edge (one axis a call);
   *  ask for the land of the slide it's heading for once it's halfway there. (Round 91: or once where it will be
   *  `LEAD` seconds on is — and the land of two slides when that's past the next one's reach.) */
  update(): Promise<void> | null {
    this.track();
    // (round 100: not before the store's index is read — a region made then might have had a record)
    if (!this.store) return null;
    this.pump();
    this.drainLater();
    if (!this.busy && performance.now() - this.baseAt > 500) {
      this.baseAt = performance.now();
      this.doneAfter(this.baseDone);
    }
    if (this.busy || !this.auto) return null;
    this.sweep();
    const [x, yw] = this.core.camera.target;
    const y = yw / ROW_H;
    const R = this.R;
    const reach = R * 0.75;
    const near = R * 0.4;
    const ahead = (v: number) => Math.max(-2 * R, Math.min(2 * R, v * LEAD));
    const px = x + ahead(this.vel[0]);
    const py = y + ahead(this.vel[1]);
    const hx = this.W / 2;
    const hy = this.H / 2;
    if (Math.max(x, px) > hx + near) this.prefetch(R, 0);
    if (Math.min(x, px) < hx - near) this.prefetch(-R, 0);
    if (Math.max(y, py) > hy + near) this.prefetch(0, R);
    if (Math.min(y, py) < hy - near) this.prefetch(0, -R);
    if (px > hx + reach + R) this.prefetch(2 * R, 0);
    if (px < hx - reach - R) this.prefetch(-2 * R, 0);
    if (py > hy + reach + R) this.prefetch(0, 2 * R);
    if (py < hy - reach - R) this.prefetch(0, -2 * R);
    // (round 100) along the camera's motion: AHEAD strips, into the pool before the slides that need them
    // (round 102: by its speed — AHEAD_S seconds of it, AHEAD strips at least, AHEAD_MAX at most; each strip between)
    // (and only while what's made ahead and under way leaves the pool room: the phone's ride made 6x the regions it
    // used with round 102's first ahead, the pool evicting land made ahead to make more)
    if (!STREAM_OLD && AHEAD > 0 && this.made.size + this.jobs.size < POOL_CAP / 2) {
      const strips = (v: number) => Math.max(AHEAD, Math.min(AHEAD_MAX, Math.ceil((Math.abs(v) * AHEAD_S) / R)));
      if (Math.abs(this.vel[0]) > MOVING) for (let k = 2, n = strips(this.vel[0]); k <= n; k++) this.prefetch(Math.sign(this.vel[0]) * k * R, 0);
      if (Math.abs(this.vel[1]) > MOVING) for (let k = 2, n = strips(this.vel[1]); k <= n; k++) this.prefetch(0, Math.sign(this.vel[1]) * k * R);
    }
    // in z: the ground under the camera near the window's top or bottom
    const h = this.source.height;
    if (h) {
      const [cx, cy] = cellAt(x, yw);
      if (cx >= 0 && cy >= 0 && cx < this.W && cy < this.H) {
        const g = this.ground[this.colIdx(cx, cy)];
        const zMax = this.core.dims.zMax;
        if (g > zMax - 40 && this.oz + zMax < h) return this.slideZ(TIER);
        if (g < 24 && this.oz > 0) return this.slideZ(-TIER);
      }
    }
    // (the slide itself where the camera is: sliding early for where it's heading slid twice as often on a
    // winding road — back again at each bend — for no nearer edge: DEVLOG round 91)
    if (x > hx + reach) return this.slideWhenReady(R, 0);
    if (x < hx - reach) return this.slideWhenReady(-R, 0);
    if (y > hy + reach) return this.slideWhenReady(0, R);
    if (y < hy - reach) return this.slideWhenReady(0, -R);
    return null;
  }

  /** (round 98) the slide once its land is ready (asked for now if it wasn't); before round 98, at once */
  private slideWhenReady(dx: number, dy: number): Promise<void> | null {
    if (STREAM_OLD) return this.slide(dx, dy);
    this.prefetch(dx, dy);
    const R = this.R;
    for (const [lx, ly] of this.enteringFor(dx, dy)) {
      const key = this.key((this.origin[0] + dx + lx) / R, (this.origin[1] + dy + ly) / R);
      const m = this.made.get(key);
      if (!m || m.oz !== this.oz) {
        // (round 100: made at another oz — the window slid in z since — cut again first)
        if (m) {
          this.made.delete(key);
          this.startJob(key, this.prepare(m));
        }
        this.waited++;
        return null;
      }
    }
    return this.slide(dx, dy);
  }

  /** (round 100) a region's land is ready: in the pool (the most recently used), ready to be copied into the window */
  private ready(key: string, f: Frozen): void {
    if (f.slot) {
      this.frozen.delete(key);
      this.frozen.set(key, f);
    }
    this.made.set(key, f);
  }

  /** (round 100) a job for a region's land under way: ready when done (unless dropped meanwhile — a warp) */
  private startJob(key: string, job: Promise<Frozen>): void {
    this.jobs.set(key, job);
    job.then(
      (f) => {
        if (this.taken.has(job)) return;
        if (this.jobs.get(key) === job) {
          this.jobs.delete(key);
          this.ready(key, f);
        } else if (f.slot && this.frozen.get(key) !== f && !this.slotHeld(f.slot)) this.pool.release(f.slot);
      },
      (e) => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        console.error(`[stream] region ${key}'s land failed: ${(e as Error)?.message ?? e}`);
      },
    );
  }

  /** (round 100) whether a slot is a region's in the pool still */
  private slotHeld(s: PoolSlot): boolean {
    for (const f of this.frozen.values()) if (f.slot === s) return true;
    return false;
  }

  /**
   * (round 100) A region's land, wherever it is: the pool's (as left, or made ahead), the store's (as saved), or
   * made by the source — checked for what changed while it was away, cut at the window's oz, its relief made, and
   * in the pool (uploaded) when it wasn't.
   */
  private async bring(key: string, wx: number, wy: number, fresh = false): Promise<Frozen> {
    // (a region leaving is saved, if it changed, before it's looked for in the store)
    await this.checks.get(key);
    let f = fresh ? undefined : this.frozen.get(key);
    f?.fill?.();
    // (its slot this job's now: nothing evicts it meanwhile; ready() puts it back)
    if (f) this.frozen.delete(key);
    if (!f && this.store?.has(key) && !(fresh && this.store.has(key)!.session === SESSION)) f = (await this.load(key)) ?? undefined;
    if (!f) f = await this.generate(wx, wy);
    f = await this.since(f, wx, wy);
    return this.prepare(f);
  }

  /** (round 100) cut at the window's oz, its relief made, uploaded into a pool slot (a CPU form is let go then) */
  private async prepare(f: Frozen): Promise<Frozen> {
    if (f.oz !== this.oz) f = this.reslice(await this.cpu(f));
    if (!f.relief) {
      const c = await this.cpu(f);
      f = { ...c, relief: timed('relief', () => this.reliefOf(c)) };
    }
    if (!f.layers && !f.body) return f;
    const slot = f.slot ?? this.slotFor();
    // (no room in the pool, every slot's region wanted: written from the CPU, as before round 100)
    if (!slot) return f;
    await new Promise<void>((res) => this.uploads.push({ f, slot, res }));
    return { ...f, slot, layers: undefined, bufs: undefined, texs: undefined, body: undefined };
  }

  /** (round 100) uploads of land into the pool, a few ms of the frame (one at least) */
  private pump(): void {
    const t0 = performance.now();
    let bytes = 0;
    for (let n = 0; this.uploads.length && (n === 0 || (performance.now() - t0 < UPLOAD_MS && bytes + this.layout.bytes <= UPLOAD_BYTES)); n++) {
      const u = this.uploads.shift()!;
      bytes += this.layout.bytes;
      // (round 104: a loaded region's bytes as they came — the layout's already)
      timed('pool.upload', () => this.core.host.gpu.device.queue.writeBuffer(u.slot.buf, u.slot.off, u.f.body ?? this.toBody(u.f)));
      this.stats.uploads++;
      u.res();
    }
  }

  /** (round 105, tilelatency) A render-only tile's land into `buf` at `off`, its per-column summary into `meta` (GPU, no readback). */
  landTile(x0: number, y0: number, buf: GPUBuffer, off: number, meta: { buf: GPUBuffer; off: number }): Promise<void> | null {
    if (!this.source.regionTile) return null;
    return this.source.regionTile(x0, y0, this.R, this.R, { buf, off, layout: this.layout, oz: this.oz, zMax: this.core.dims.zMax, K: this.K, colK: this.colK, settle: !SETTLE }, meta);
  }

  /** Start making the land a slide of (dx, dy) would bring in (round 100: into the pool — what's there needs nothing). */
  prefetch(dx: number, dy: number): void {
    const R = this.R;
    for (const [lx, ly] of this.nearFirst(this.enteringFor(dx, dy), dx, dy)) {
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
      if (this.winInfo.has(key) && this.inWindow(wx, wy)) continue;
      this.startJob(key, this.bring(key, wx, wy));
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
    const spots: [number, number, number][] = [];
    for (let ly = -ring * R; ly < H + ring * R; ly += R)
      for (let lx = -ring * R; lx < W + ring * R; lx += R) spots.push([ox + lx, oy + ly, Math.hypot(lx + R / 2 - W / 2, ly + R / 2 - H / 2)]);
    spots.sort((a, b) => a[2] - b[2]);
    let n = 0;
    for (const [wx, wy] of spots) {
      if (skipWindow && wx >= ox && wy >= oy && wx < ox + W && wy < oy + H) continue;
      const key = this.key(wx / R, wy / R);
      if (this.jobs.has(key) || this.made.has(key)) continue;
      if (this.winInfo.has(key) && this.inWindow(wx, wy)) continue;
      this.startJob(key, this.bring(key, wx, wy));
      n++;
    }
    this.stats.precached += n;
    return n;
  }

  /** (round 100) whether world cell (wx, wy) — a region's corner — is in the window now */
  private inWindow(wx: number, wy: number): boolean {
    const lx = wx - this.origin[0];
    const ly = wy - this.origin[1];
    return lx >= 0 && ly >= 0 && lx < this.W && ly < this.H;
  }

  /** Move the window by (dx, dy) columns (one of them ±REGION, the other 0). */
  async slide(dx: number, dy: number): Promise<void> {
    if ((dx !== 0) === (dy !== 0) || Math.abs(dx + dy) !== this.R) throw new Error('a slide is one region along one axis');
    this.busy = true;
    const t0 = performance.now();
    const tr: SlideTrace = { dx, dy, t0, sync: 0, regions: [], end: 0 };
    this.trace.push(tr);
    if (this.trace.length > 200) this.trace.shift();
    try {
      await this.slideNow(dx, dy, tr);
    } finally {
      this.busy = false;
    }
    tr.end = performance.now();
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

  /**
   * (round 90, the user: "prioritize tiles close to the center of the screen but load others late") Regions
   * (local corners in the window after a slide of (dx, dy)) nearest the camera's target first: the land is made a
   * tile a frame in the order it's asked for (atlas.ts tileGate), so what's under the middle of the screen comes in
   * first and the strip's far ends later.
   */
  private nearFirst(regions: [number, number][], dx: number, dy: number): [number, number][] {
    const [x, yw] = this.core.camera.target;
    const y = yw / ROW_H;
    const h = this.R / 2;
    const d = ([lx, ly]: [number, number]) => Math.hypot(lx + dx + h - x, ly + dy + h - y);
    return [...regions].sort((a, b) => d(a) - d(b));
  }

  /** the regions of a strip of the window (local cells x0..x1, y0..y1), as [local x, local y] corners */
  private strip(x0: number, x1: number, y0: number, y1: number): [number, number][] {
    const out: [number, number][] = [];
    for (let y = y0; y < y1; y += this.R) for (let x = x0; x < x1; x += this.R) out.push([x, y]);
    return out;
  }

  /**
   * (round 100) The window's regions leaving, at these local corners (the window before the slide): copied into pool
   * slots (and those play changed into one staging buffer, read back for the store), their CPU parts and things taken.
   * (Round 106, frameprobe: planned here, in the slide's frame — the things taken, the coarse world's snapshots asked,
   * the readback's stage made — and each region's copies made later, where it lies on the ring, just before the
   * region coming in is written there (freezeAt): the window's data is on the ring and the chunk table keeps a place's
   * pages, so what left stays where it lay, untouched, until then. frozeInto once all are done.)
   */
  private freezePlan(spots: [number, number][], dx: number, dy: number): Freeze {
    const { R, W, H } = this;
    const L = this.layout;
    const dev = this.core.host.gpu.device;
    // (round 104) read back only what play changed (or ?rsverify): a region never touched is made again when it's
    // wanted, its readback was 1.6 MB a region mapped for nothing — the whole strip, every slide
    const keys = spots.map(([lx, ly]) => this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R));
    const need = keys.filter((key) => this.verify || this.winInfo.get(key)?.changed).length;
    const stage = need ? dev.createBuffer({ label: 'stream freeze', size: L.bytes * need, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;
    const fz: Freeze = { stage, items: [], entries: [], pending: new Map() };
    // (round 106, frameprobe: the freeze's CPU by part)
    const tm = [0, 0, 0];
    let tq = performance.now();
    const lap = (k: number) => {
      const t = performance.now();
      tm[k] += t - tq;
      tq = t;
    };
    spots.forEach(([lx, ly], i) => {
      const key = keys[i];
      tq = performance.now();
      const it = this.saveItem(lx, ly, key);
      lap(0);
      const things = this.things.flatMap((t) => t.take(lx, ly, lx + R, ly + R));
      if (things.length) it.things = things;
      lap(1);
      const read = !!stage && (this.verify || !!it.info.changed);
      const k = fz.items.length;
      if (read) fz.items.push(it);
      // (the coarse world as the region leaves it: asked now — Coarse.snapshot copies a task's together)
      const snap = this.source.snapshot?.(it.x0, it.y0, R, R);
      lap(2);
      // (the same place on the ring, in the window after the slide: the region coming in there)
      const nx = (((lx - dx) % W) + W) % W;
      const ny = (((ly - dy) % H) + H) % H;
      fz.pending.set(ny * W + nx, { it, key, read, k, snap });
      this.winInfo.delete(key);
    });
    record('fz.saveItem', tm[0]);
    record('fz.things', tm[1]);
    record('fz.snapshot', tm[2]);
    return fz;
  }

  /**
   * (round 106, frameprobe) The region that left from where window region (lx, ly) — after the slide — lies on the ring
   * copied out (into a pool slot; to the stage if play changed it) and its band cleared there, before what comes in is
   * written: one region's copies a submit, in the frame that writes there.
   */
  private freezeAt(fz: Freeze, lx: number, ly: number): void {
    const p = fz.pending.get(ly * this.W + lx);
    if (!p) return;
    fz.pending.delete(ly * this.W + lx);
    const t0 = performance.now();
    const { R, W, H } = this;
    const L = this.layout;
    const dev = this.core.host.gpu.device;
    const enc = dev.createCommandEncoder({ label: 'stream freeze' });
    const { it, key, read, k, snap } = p;
    const slot = this.slotFor();
    const t1 = performance.now();
    if (slot) {
      this.copyOut(enc, lx, ly, slot.buf, slot.off);
      if (read) enc.copyBufferToBuffer(slot.buf, slot.off, fz.stage!, k * L.bytes, L.bytes);
      const fe: Frozen = { oz: it.oz, outside: it.outside, surface: it.surface, ground: it.ground, relief: it.relief, snap, slot, info: it.info, how: 'thawed', things: it.things };
      // (round 106: its CPU parts as the item's, when they're read)
      const readCpu = it.fill;
      if (readCpu)
        it.fill = fe.fill = () => {
          fe.fill = undefined;
          readCpu();
          fe.outside = it.outside;
          fe.surface = it.surface;
          fe.ground = it.ground;
          fe.relief = it.relief;
        };
      fz.entries.push([key, fe]);
    } else {
      // (no room in the pool: read back only — saved if it changed, made again if it didn't)
      if (read) this.copyOut(enc, lx, ly, fz.stage!, k * L.bytes, false);
      // (round 106: kept nowhere — its CPU parts never read)
      else it.fill = undefined;
      this.stats.evicted++;
    }
    // (what isn't kept for the region coming in starts empty there)
    const [px, py] = this.core.ring.at(lx, ly);
    for (const b of [...this.bufs, ...this.moduleBufs()]) {
      if (b.keep) continue;
      const s = b.stride / 4;
      if (b.buf.usage & GPUBufferUsage.STORAGE)
        this.copier.rect({ src: this.zeros(R * s), srcOff: 0, srcRow: 0, srcPlane: 0, dst: b.buf, dstOff: (py * W + px) * s, dstRow: W * s, dstPlane: W * H * s, rowWords: R * s, rows: R, planes: b.planes });
      else for (let q = 0; q < b.planes; q++) for (let r = 0; r < R; r++) enc.clearBuffer(b.buf, q * W * H * b.stride + ((py + r) * W + px) * b.stride, R * b.stride);
    }
    this.copier.encode(enc);
    dev.queue.submit([enc.finish()]);
    record('fz.slotFor', t1 - t0);
    record('fz.copyOut', performance.now() - t1);
  }

  /** (round 100) once every region that left is copied out: the regions in the pool, their readback under way */
  private frozeInto(fz: Freeze): void {
    for (const [ly, lx] of [...fz.pending.keys()].map((i) => [Math.floor(i / this.W), i % this.W])) this.freezeAt(fz, lx, ly);
    for (const [key, f] of fz.entries) {
      this.frozen.delete(key);
      this.frozen.set(key, f);
    }
    if (fz.stage) this.check(fz.stage, fz.items);
  }

  private async slideNow(dx: number, dy: number, tr: SlideTrace): Promise<void> {
    for (const f of this.onBeforeSlide) f(dx, dy, 0);
    const tSync = performance.now();
    // (a readback that straddles the slide is stale: round 80)
    this.core.windowEpoch++;
    const { core, W, H, R } = this;
    const dev = core.host.gpu.device;
    const wg = core.world;
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const cy = H / CHUNK;
    // what leaves (old window cells) and what comes in (new window cells)
    const leaving = dx > 0 ? this.strip(0, dx, 0, H) : dx < 0 ? this.strip(W + dx, W, 0, H) : dy > 0 ? this.strip(0, W, 0, dy) : this.strip(0, W, H + dy, H);
    // (round 90: nearest the camera first — what's written first, and what's made first when it wasn't asked ahead)
    const entering = this.nearFirst(this.enteringFor(dx, dy), dx, dy);

    // ---- 1. freeze what leaves: copies into the pool (round 100), read back for the store off the frame ----
    const enc = dev.createCommandEncoder({ label: 'stream slide' });
    // (round 104) the slide's GPU work timed (the profiler's 'slide' pass: an empty pass's start to another's end)
    const ts = core.host.profiler.timestamps('slide');
    if (ts) enc.beginComputePass({ label: 'slide t0', timestampWrites: { querySet: ts.querySet, beginningOfPassWriteIndex: ts.beginningOfPassWriteIndex } }).end();
    const tf = performance.now();
    const fz = SLIDE_SKIP.has('freeze') ? null : this.freezePlan(leaving, dx, dy);
    record('slide.freeze', performance.now() - tSync);
    // ---- 2. (round 105, ringwin) nothing moves: the window's columns stay where they lie on the ring ----------
    // (a world cell keeps its place mod the window's size: the strip coming in lies where the strip leaving lay —
    // what that held was frozen above; what isn't kept for it starts empty there, as a band of whole regions)
    const ring = core.ring;
    ring.slide(dx, dy);
    const mods = this.moduleBufs();
    // (particles in the air: dropped — Q28 follow-up: keep them, they're in window coordinates)
    enc.clearBuffer(wg.particles);
    // (round 106: each region's band is cleared as it's frozen — freezeAt; this, only when nothing is frozen: ?slideskip=freeze)
    if (!fz) {
      // (a band of whole rows or columns: all of them along the other axis, from the ring's 0)
      const [bx, by] = ring.at(dx > 0 ? W - dx : 0, dy > 0 ? H - dy : 0);
      const sx = dx ? bx : 0;
      const sy = dy ? by : 0;
      const sw = dx ? Math.abs(dx) : W;
      const sh = dy ? Math.abs(dy) : H;
      for (const b of [...this.bufs, ...mods]) {
        if (b.keep) continue;
        const s = b.stride / 4;
        if (dy) for (let p = 0; p < b.planes; p++) enc.clearBuffer(b.buf, p * W * H * b.stride + sy * W * b.stride, sh * W * b.stride);
        else if (b.buf.usage & GPUBufferUsage.STORAGE)
          this.copier.rect({ src: this.zeros(sw * s), srcOff: 0, srcRow: 0, srcPlane: 0, dst: b.buf, dstOff: (sy * W + sx) * s, dstRow: W * s, dstPlane: W * H * s, rowWords: sw * s, rows: sh, planes: b.planes });
        else for (let p = 0; p < b.planes; p++) for (let r = 0; r < sh; r++) enc.clearBuffer(b.buf, p * W * H * b.stride + ((sy + r) * W + sx) * b.stride, sw * b.stride);
      }
      this.copier.encode(enc);
    }
    if (ts) enc.beginComputePass({ label: 'slide t1', timestampWrites: { querySet: ts.querySet, endOfPassWriteIndex: ts.endOfPassWriteIndex } }).end();
    dev.queue.submit([enc.finish()]);
    this.doneAfter(this.slideDone);
    this.times.freeze.push(performance.now() - tf);
    record('rs.freeze', performance.now() - tf);
    if (this.times.freeze.length > 400) this.times.freeze.shift();
    const surf = core.map.surface;
    this.stats.frozen += leaving.length;

    record('slide.move', performance.now() - tSync);
    // ---- 3. the chunk table: pages move, the leaving chunks' pages are reused --
    // (round 106, frameprobe: a chunk coming in takes the pages of the one that left from the same place on the ring —
    // the table rotates with the ring — so what left lies untouched, pages and columns, until it's frozen: freezeAt)
    const old = table.slice();
    const dcx = dx / CHUNK;
    const dcy = dy / CHUNK;
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const si = (((i + dcx) % cx) + cx) % cx;
        const sj = (((j + dcy) % cy) + cy) % cy;
        table[(j * cx + i) * 2] = old[(sj * cx + si) * 2];
      }
    dev.queue.writeBuffer(wg.chunks, 0, table);

    record('slide.table', performance.now() - tSync);
    // ---- 4. the CPU's window coordinates move too ------------------------------
    this.origin[0] += dx;
    this.origin[1] += dy;
    core.globals.origin = [this.origin[0], this.origin[1]];
    let tg = performance.now();
    const lap = (label: string) => {
      const t = performance.now();
      record(label, t - tg);
      tg = t;
    };
    // (round 106, frameprobe: map.surface, the ground and the relief are on the ring — nothing moves)
    void surf;
    lap('sl.cpuGrids');
    core.camera.shift(dx, dy * ROW_H, 0);
    // (round 99, runstream) the world's queued events (edits past a tick's four wait for the next) are in window
    // coordinates too: they land where they were aimed, not a region off
    for (const ev of core.globals.events) {
      ev.x -= dx;
      ev.y -= dy * ROW_H;
    }
    // (what the game installed that lives in window coordinates: units, bodies — round 80)
    lap('sl.camEvents');
    core.onShift.forEach((f, k) => {
      f(dx, dy * ROW_H, 0);
      lap(`sl.onShift${k}`);
    });
    // (what's built moves with the land: round 73, nothing is built again but what came in fresh)
    core.renderer.windowMoved(dx / MESH_CHUNK, dy / MESH_CHUNK, [-dx, -dy * ROW_H, 0]);
    lap('sl.windowMoved');
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
    tr.sync = performance.now();
    // ---- 5. what comes in: from the pool (round 100: thawed, made or loaded ahead), or asked for now ----
    const coming = entering.map(([lx, ly]) => {
      const wx = this.origin[0] + lx;
      const wy = this.origin[1] + ly;
      const key = this.key(wx / R, wy / R);
      const done = this.made.get(key);
      const job = this.jobs.get(key);
      this.made.delete(key);
      this.jobs.delete(key);
      // (the slide's now: not to be evicted before it's written)
      if (done && this.frozen.get(key) === done) this.frozen.delete(key);
      if (job) this.taken.add(job);
      tr.regions.push({ how: done ? (done.how === 'made' ? 'ahead' : done.how) : job ? 'ahead' : 'made', ready: 0, written: 0 });
      const p = done ? Promise.resolve(done) : (job ?? this.bring(key, wx, wy));
      return p.then((f) => {
        if (f.how === 'thawed') this.stats.thawed++;
        else if (f.how === 'made') {
          this.stats.generated++;
          if (done || job) this.stats.prefetched++;
        }
        return { key, f };
      });
    });
    this.unwritten = entering.slice();
    let tw = performance.now();
    try {
    for (let k = 0; k < entering.length; k++) {
      const [lx, ly] = entering[k];
      if (!STREAM_OLD && k > 0 && performance.now() - tw > WRITE_MS) {
        await new Promise((r) => requestAnimationFrame(r));
        tw = performance.now();
      }
      const c = await coming[k];
      let f = c.f;
      if (f.oz !== this.oz) f = await this.prepare(f);
      if (this.frozen.get(c.key)?.slot === f.slot) this.frozen.delete(c.key);
      tr.regions[k].ready = performance.now();
      // (round 106: what left from where this lies, copied out first)
      if (fz) this.freezeAt(fz, lx, ly);
      this.write(f, lx, ly, c.key);
      tr.regions[k].written = performance.now();
      this.unwritten = this.unwritten.filter(([x, y]) => x !== lx || y !== ly);
      if (!STREAM_OLD && ARRIVE_URGENT) this.core.renderer.fieldMesh.urgent(lx, ly * ROW_H, lx + R, (ly + R) * ROW_H, 8);
    }
    } finally {
      // (round 106: the regions that left all frozen — any not written over yet too — and their readback asked)
      if (fz) this.frozeInto(fz);
    }
    // (round 106: whatever of the strip that left isn't read yet — nothing came in where it lay)
    this.flushFills();
    // (round 80: the band's pages went with the land; only what came in is packed)
    timed('band', () => this.core.renderer.band?.packFresh(this.outside, this.core.dims.zMax));
    this.core.windowEpoch++;
  }

  /**
   * (round 87) Column (x, y)'s runs above the window that go on from its top (touching it and each other: a
   * spire taller than the window), taken out of what's outside it and returned in window z; the band redrawn there.
   * The integrity system's falling piece takes them with it (the user: a tower stayed standing — its top, above
   * the window, was the band's and never came down).
   */
  takeAbove(x: number, y: number): Interval[] {
    this.flushFills();
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
    this.flushFills();
    const i = y * this.W + x;
    const all = [...this.outside[this.oi(i)], ...ivs.map((iv) => ({ z0: iv.z0 + this.oz, z1: iv.z1 + this.oz, mat: iv.mat }))].sort((a, b) => a.z0 - b.z0);
    this.outside[this.oi(i)] = all;
    this.core.renderer.band?.packColumns(this.outside, this.oz, this.core.dims.zMax, [[x, y]]);
  }

  /** What's outside the window, drawn (round 79: the renderer's band, when it has one). */
  refreshBand(): void {
    timed('band', () => this.core.renderer.band?.update(this.outside, this.oz, this.core.dims.zMax));
  }

  /** a region's land the first time it is seen, in the frozen form (cut at the window's oz now) */
  private async generate(x0: number, y0: number): Promise<Frozen> {
    if (GPUGEN && this.source.regionInto) return this.generateGpu(x0, y0);
    const { R } = this;
    const zMax = this.core.dims.zMax;
    const g: GenTrace = { x0, y0, asked: performance.now(), land: 0, done: 0 };
    this.gens.push(g);
    if (this.gens.length > 400) this.gens.shift();
    const [land, snap] = await Promise.all([this.source.region(x0, y0, R, R, zMax), this.source.snapshot?.(x0, y0, R, R)]);
    g.land = performance.now();
    const f = timed('cut', () => this.cutRegion(land, snap));
    g.done = performance.now();
    return f;
  }

  /**
   * (round 102, `gpugen`) A region's land made on the GPU straight into a pool slot (LandSource.regionInto: the cut,
   * the pack and every field there; nothing read back but what the CPU keeps — its tops, ground, relief, what's
   * outside the window). No hash of its columns as made: one is needed only to tell a region changed by play from its
   * save, and a made region is saved only once play has touched it.
   */
  private async generateGpu(x0: number, y0: number): Promise<Frozen> {
    const { R } = this;
    const zMax = this.core.dims.zMax;
    const g: GenTrace = { x0, y0, asked: performance.now(), land: 0, done: 0 };
    this.gens.push(g);
    if (this.gens.length > 400) this.gens.shift();
    const oz = this.oz;
    // (no slot free — every one a job's or a slide's: a slot of its own, let go once it's written)
    const slot = this.slotFor() ?? this.pool.temp();
    let m: FinishMeta;
    let snap: unknown;
    try {
      [m, snap] = await Promise.all([this.source.regionInto!(x0, y0, R, R, { buf: slot.buf, off: slot.off, layout: this.layout, oz, zMax, K: this.K, colK: this.colK, settle: !SETTLE }), this.source.snapshot?.(x0, y0, R, R)]);
    } catch (e) {
      this.pool.release(slot);
      throw e;
    }
    g.land = performance.now();
    this.stats.fitted += m.fitted;
    this.stats.settled += m.settled;
    const f = timed('gen.meta', (): Frozen => {
      const relief = new Uint8Array(R * R);
      for (let i = 0; i < R * R; i++) relief[i] = Math.abs(m.surface[i] - m.ground[i]) > RELIEF_FORM ? 1 : 0;
      const judge = boxOf(m.structural, R);
      return { slot, surface: m.surface, ground: m.ground, outside: m.outside, relief: { relief, gapTop: m.gapTop, colTop: m.colTop }, judge, oz, snap, info: {}, how: 'made' };
    });
    this.stats.gpuMade++;
    g.done = performance.now();
    return f;
  }

  /**
   * (round 102, scripts/gpugentest.mjs) A region (world corner x0, y0) made both ways at the window's oz — the CPU's
   * (source.region, cutRegion, toBody: ?gpugen=0's) and the GPU's (regionInto) — and compared: the slot's bytes word
   * by word, by part (the pages, each kept buffer and texture), and what the CPU keeps (tops, ground, outside, relief,
   * the structural box). Nothing of the window changes.
   */
  async compareGen(x0: number, y0: number): Promise<{ words: number; nonzero: number; diff: number; parts: Record<string, number>; first: unknown[]; meta: Record<string, number>; cpuMs: number; gpuMs: number }> {
    if (!this.source.regionInto) throw new Error('compareGen: the land source makes nothing on the GPU');
    const { R } = this;
    const L = this.layout;
    const zMax = this.core.dims.zMax;
    const dev = this.core.host.gpu.device;
    const t0 = performance.now();
    const land = await this.source.region(x0, y0, R, R, zMax);
    const fc = this.cutRegion(land, undefined);
    const cpu = new Uint32Array(this.toBody(fc).slice().buffer);
    const rc = this.reliefOf(fc);
    const t1 = performance.now();
    const slot = this.pool.temp();
    let m: FinishMeta;
    let gpu: Uint32Array;
    try {
      m = await this.source.regionInto(x0, y0, R, R, { buf: slot.buf, off: slot.off, layout: L, oz: this.oz, zMax, K: this.K, colK: this.colK, settle: !SETTLE });
      const st = dev.createBuffer({ label: 'compareGen read', size: L.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder({ label: 'compareGen read' });
      enc.copyBufferToBuffer(slot.buf, slot.off, st, 0, L.bytes);
      dev.queue.submit([enc.finish()]);
      await st.mapAsync(GPUMapMode.READ);
      gpu = new Uint32Array(st.getMappedRange().slice(0));
      st.unmap();
      st.destroy();
    } finally {
      this.pool.release(slot);
    }
    const t2 = performance.now();
    // the slot's parts, by word
    const parts: [string, number, number][] = [['pages', 0, L.rc * L.rc * L.pageBytes]];
    for (const b of L.bufs) parts.push([b.name, b.off, b.off + b.bytes]);
    for (const t of L.texs) parts.push([`tex:${t.name}`, t.off, t.off + t.bytes]);
    const count: Record<string, number> = {};
    const first: unknown[] = [];
    let diff = 0;
    const f32 = (u: number) => new Float32Array(new Uint32Array([u]).buffer)[0];
    for (const [name, a, b] of parts) {
      let n = 0;
      for (let w = a / 4; w < b / 4; w++) {
        if (cpu[w] === gpu[w]) continue;
        n++;
        if (first.length < 12) {
          const at: Record<string, unknown> = { part: name, word: w - a / 4, cpu: cpu[w], gpu: gpu[w], cpuF: f32(cpu[w]), gpuF: f32(gpu[w]) };
          if (name === 'pages') {
            const slotI = Math.floor((w - a / 4) / SLOT_WORDS);
            const page = Math.floor(slotI / this.pageSlots);
            const inPage = slotI % this.pageSlots;
            const c = Math.floor(inPage / this.K);
            at.col = [(page % L.rc) * CHUNK + (c % CHUNK), Math.floor(page / L.rc) * CHUNK + Math.floor(c / CHUNK)];
            at.slot = inPage % this.K;
          }
          first.push(at);
        }
      }
      if (n) count[name] = n;
      diff += n;
    }
    // what the CPU keeps
    const meta: Record<string, number> = {};
    const same = (name: string, p: ArrayLike<number>, q: ArrayLike<number>) => {
      let n = 0;
      for (let i = 0; i < R * R; i++) if (!Object.is(p[i], q[i])) {
        n++;
        if (first.length < 16) first.push({ part: name, i, cpu: p[i], gpu: q[i] });
      }
      if (n) meta[name] = n;
    };
    same('surface', fc.surface, m.surface);
    same('ground', fc.ground!, m.ground);
    same('relief', rc.relief, Uint8Array.from(m.surface, (s, i) => (Math.abs(s - m.ground[i]) > RELIEF_FORM ? 1 : 0)));
    same('gapTop', rc.gapTop, m.gapTop);
    same('colTop', rc.colTop, m.colTop);
    let no = 0;
    for (let i = 0; i < R * R; i++) if (JSON.stringify(fc.outside[i]) !== JSON.stringify(m.outside[i])) no++;
    if (no) meta.outside = no;
    if (JSON.stringify(fc.judge) !== JSON.stringify(boxOf(m.structural, R))) meta.judge = 1;
    // (that there was something to compare: the slot's words not zero)
    let nonzero = 0;
    for (let w = 0; w < gpu.length; w++) if (gpu[w]) nonzero++;
    return { words: cpu.length, nonzero, diff, parts: count, first, meta, cpuMs: +(t1 - t0).toFixed(1), gpuMs: +(t2 - t1).toFixed(1) };
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
        // (round 88: the water the window holds — over the floor where the ground is under it, the sea's)
        const col = land.cols[i];
        land.water[i] = col.length ? waterInWindow(cut, oz, zMax, col[col.length - 1].z1 + land.water[i]) : 0;
        // (the ground's top out of the window: what lies on it isn't here)
        if (!topInside(cut, oz, zMax)) {
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
    // (round 100) its columns as made: a region whose hash is this when it's read back hasn't changed
    const last = timed('rs.hash', () => columnsHash(layers, this.layout, outside, oz));
    return { layers, bufs, texs, surface, judge, oz, outside, snap, ground, info: { last }, how: 'made' };
  }

  /** a region coming in with what changed while it was away (LandSource.changes since its snapshot) */
  private async since(f: Frozen, x0: number, y0: number): Promise<Frozen> {
    const { R } = this;
    if (!this.source.changes || f.snap === undefined) return f;
    const at = await this.source.changes(await f.snap, x0, y0, R, R);
    if (!at) return f;
    // (round 100: changed — its land on the CPU to change, read back from its slot if it's in the pool)
    f = await this.cpu(f);
    if (!f.layers || !f.bufs) throw new Error('since: a region without its land on the CPU');
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
    f.info.last = undefined;
    const bufs = { ...f.bufs };
    if (water) bufs.water = new Uint8Array(water.buffer);
    if (veg) bufs.veg = new Uint8Array(veg.buffer);
    return { ...f, layers, outside, surface, bufs, snap: undefined, relief: undefined };
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
    this.flushFills();
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
        const full = joinColumn(was, this.oz, this.outside[this.oi(i)]);
        applyChange(full, d);
        const cut = splitColumn(full, this.oz, zMax);
        if (fitColumn(cut.inside, this.colK)) this.stats.fitted++;
        this.outside[this.oi(i)] = cut.outside;
        slots.set(packColumn(cut.inside, K), base * SLOT_WORDS);
        const si = this.oi(i);
        core.map.surface[si] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        this.ground[si] += d.dr + (d.dl > 0.05 ? d.dl : 0);
        this.setRelief(si, full, core.map.surface[si], this.ground[si]);
        if (d.dl > 0.05) veg[i] *= Math.max(0, 1 - d.dl * 2);
        n++;
      }
    if (n) {
      this.touch(x0, y0, x1, y1);
      for (const b of [wg.layers, wg.layersNext]) dev.queue.writeBuffer(b, 0, slots);
      // (ringwin: read in window order, written back in the ring's)
      const vegR = core.ring.toRing(veg);
      for (const b of [wg.veg, wg.vegNext]) dev.queue.writeBuffer(b, 0, vegR);
      core.clearUndo();
      for (const f of this.onRelief) f(Math.max(0, x0), Math.max(0, y0), Math.min(W, x1), Math.min(H, y1));
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
    if (!f.layers || !f.bufs) throw new Error('reslice: a region without its land on the CPU');
    const fl = f.layers;
    const fb = f.bufs;
    const zMax = this.core.dims.zMax;
    const layers = new Uint32Array(fl.length);
    const outside: Interval[][] = [];
    const surface = new Float32Array(R * R);
    const water = fb.water ? new Float32Array(fb.water.buffer, fb.water.byteOffset, R * R) : undefined;
    const lava = fb.lava ? new Float32Array(fb.lava.buffer, fb.lava.byteOffset, R * R * 4) : undefined;
    for (let y = 0; y < R; y++)
      for (let x = 0; x < R; x++) {
        const i = y * R + x;
        const was = this.columnOf(fl, x, y);
        const full = joinColumn(was, f.oz, f.outside[i]);
        const wasTop = was.length > 0 && !f.outside[i].some((iv) => iv.z0 >= f.oz + zMax);
        // (round 88) its water's level (world z): over its top in the window, or over the floor where its ground was
        // under it; none where its top was over the window
        const level = f.oz + (was.length ? was[was.length - 1].z1 : 0) + (water ? water[i] : 0);
        const overTop = f.outside[i].some((iv) => iv.z0 >= f.oz + zMax);
        const cut = splitColumn(full, this.oz, zMax);
        outside.push(cut.outside);
        this.place(layers, x, y, cut.inside);
        surface[i] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        if (water) water[i] = overTop ? 0 : waterInWindow(cut, this.oz, zMax, level);
        if (!(wasTop && topInside(cut, this.oz, zMax))) {
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
   * made again. (Round 100: what the window held is frozen into the pool first, as a slide's strip is — a warp away
   * and back finds it as it was; before, it was dropped.) `fresh` (the run's stage just laid: the window made
   * again with it): the window's regions made again, not thawed — only a record of an earlier session is used, this
   * session's are let go; the land made ahead (before the stage) dropped. The sim waits.
   */
  async warp(ox: number, oy: number, oz: number, fresh = false): Promise<void> {
    if (ox % this.R || oy % this.R) throw new Error(`a warp's origin must be whole regions of ${this.R}`);
    if (oz % TIER || oz < 0) throw new Error(`a warp's oz must be whole tiers of ${TIER}`);
    while (this.busy || !this.store) await new Promise((r) => setTimeout(r, 16));
    this.busy = true;
    this.flushFills();
    const t0 = performance.now();
    const { core, W, H, R } = this;
    try {
      for (const f of this.onBeforeSlide) f(0, 0, 0);
      this.heldNow = true;
      core.windowEpoch++;
      const dev = core.host.gpu.device;
      const wg = core.world;
      const spots: [number, number][] = [];
      for (let ly = 0; ly < H; ly += R) for (let lx = 0; lx < W; lx += R) spots.push([lx, ly]);
      // (round 100) what the window holds into the pool (a fresh warp makes it again: dropped)
      if (!fresh) {
        // (round 106: planned and every region copied out at once — frozeInto — and their CPU parts read)
        this.frozeInto(this.freezePlan(spots, 0, 0));
        this.flushFills();
        this.stats.frozen += spots.length;
      } else {
        for (const k of [...this.frozen.keys()]) if (this.frozen.get(k)!.how === 'made') this.evict(k);
        this.winInfo.clear();
      }
      // (round 102: what's made or under way for the land there — precache — is the warp's to use; a fresh warp's
      // the window made again: dropped)
      if (fresh) {
        this.jobs.clear();
        this.made.clear();
      }
      this.origin[0] = ox;
      this.origin[1] = oy;
      this.oz = oz;
      core.globals.origin = [ox, oy];
      const enc = dev.createCommandEncoder({ label: 'stream warp' });
      for (const b of [...this.bufs, ...this.moduleBufs()]) if (!b.keep) enc.clearBuffer(b.buf);
      enc.clearBuffer(wg.particles);
      dev.queue.submit([enc.finish()]);
      const landsP = Promise.all(
        spots.map(async ([lx, ly]) => {
          const key = this.key((ox + lx) / R, (oy + ly) / R);
          if (fresh) {
            const f = this.frozen.get(key);
            if (f) this.evict(key);
            if (this.store?.has(key)?.session === SESSION) await this.store.delete(key);
          }
          let f: Frozen;
          const done = this.made.get(key);
          const job = this.jobs.get(key);
          if (done) {
            this.made.delete(key);
            if (this.frozen.get(key) === done) this.frozen.delete(key);
            this.stats.warpReady++;
            f = done;
          } else if (job) {
            this.jobs.delete(key);
            this.taken.add(job);
            this.stats.warpReady++;
            f = await job;
          } else f = await this.bring(key, ox + lx, oy + ly, fresh);
          if (f.oz !== this.oz) f = await this.prepare(f);
          if (f.how === 'thawed') this.stats.thawed++;
          else if (f.how === 'made') this.stats.generated++;
          return { key, f };
        }),
      );
      // (round 102) the ring round it asked for now, after the window's own (the tiles go in the order asked): moving
      // off after landing finds it made
      if (WARP_RING > 0) this.precache(ox, oy, WARP_RING, true);
      const lands = await landsP;
      for (let k = 0; k < spots.length; k++) {
        const { key, f } = lands[k];
        if (this.frozen.get(key)?.slot === f.slot) this.frozen.delete(key);
        this.write(f, spots[k][0], spots[k][1], key);
      }
      // (everything built is made again where it is now)
      core.renderer.windowMoved(1 << 12, 0, [0, 0, 0]);
      this.refreshBand();
      core.clearUndo();
      core.windowEpoch++;
      for (const f of this.onWarp) f(ox, oy, oz);
    } finally {
      this.busy = false;
      this.heldNow = false;
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
      for (const f of this.onBeforeSlide) f(0, 0, dz);
      this.heldNow = true;
      this.core.windowEpoch++;
      await this.slideZNow(dz);
      record('slideZ', performance.now() - tz);
    } finally {
      this.busy = false;
      this.heldNow = false;
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
    this.flushFills();
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
        const wasTop = was.length > 0 && !this.outside[this.oi(i)].some((iv) => iv.z0 >= this.oz + zMax);
        // (round 88) its water's level (world z), as reslice's
        const level = this.oz + (was.length ? was[was.length - 1].z1 : 0) + water[i];
        const overTop = this.outside[this.oi(i)].some((iv) => iv.z0 >= this.oz + zMax);
        const cut = splitColumn(joinColumn(was, this.oz, this.outside[this.oi(i)]), oz, zMax);
        if (fitColumn(cut.inside, this.colK)) this.stats.fitted++;
        this.outside[this.oi(i)] = cut.outside;
        out.set(packColumn(cut.inside, K), base * SLOT_WORDS);
        surf[this.oi(i)] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        water[i] = overTop ? 0 : waterInWindow(cut, oz, zMax, level);
        if (!(wasTop && topInside(cut, oz, zMax))) {
          lava.fill(0, i * 4, i * 4 + 4);
        } else if (lava[i * 4] > 0) lava[i * 4 + 3] -= dz;
      }
    for (const b of [wg.layers, wg.layersNext]) dev.queue.writeBuffer(b, 0, out);
    // (ringwin: read in window order, written back in the ring's)
    const waterR = core.ring.toRing(water);
    const lavaR = core.ring.toRing(lava, 4);
    for (const b of [wg.water, wg.waterNext, wg.waterPrev]) dev.queue.writeBuffer(b, 0, waterR);
    for (const b of [wg.lava, wg.lavaNext]) dev.queue.writeBuffer(b, 0, lavaR);
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
  private write(f: Frozen, lx: number, ly: number, key = this.key((this.origin[0] + lx) / this.R, (this.origin[1] + ly) / this.R)): void {
    timed('write', () => this.writeNow(f, lx, ly, key));
  }

  /** (round 100) a texture region's blank (its fill), on the GPU once, copied in where nothing is kept */
  private blankBuf(tw: number, th: number, fill?: [number, number, number, number]): { buf: GPUBuffer; rowBytes: number } {
    const k = `${tw}x${th}:${fill ?? ''}`;
    let b = this.blankGpu.get(k);
    if (!b) {
      const rowBytes = align256(tw * 16);
      const d = new Float32Array((rowBytes / 4) * th);
      if (fill) for (let q = 0; q < d.length / 4; q++) d.set(fill, q * 4);
      const buf = this.core.world.buf(`streamBlank:${k}`, d.byteLength, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
      this.core.host.gpu.device.queue.writeBuffer(buf, 0, d);
      b = { buf, rowBytes };
      this.blankGpu.set(k, b);
    }
    return b;
  }
  private blankGpu = new Map<string, { buf: GPUBuffer; rowBytes: number }>();

  private writeNow(f: Frozen, lx: number, ly: number, key: string): void {
    // (round 98: a region cut again has its relief made again — its surface is the new cut's)
    // (round 104: a loaded region not in the pool — no room — split for the CPU's write)
    if (!f.slot) f = this.cpuNow(f);
    if (f.oz !== this.oz) {
      f = this.cpuNow(f);
      if (!f.layers) throw new Error('a region in the pool written at another oz (prepare it first)');
      f = { ...this.reslice(f), relief: undefined };
    }
    const { core, W, H, R } = this;
    const tl = performance.now();
    // (round 105, ringwin: where the region lies on the ring)
    const [px, py] = core.ring.at(lx, ly);
    // (round 106: what lay there before, frozen by the slide, read first)
    const at0 = core.ring.corner(lx, ly);
    this.fillAt(at0);
    for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) this.outside[at0 + r * W + c] = f.outside[r * R + c];
    const dev = core.host.gpu.device;
    const wg = core.world;
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const rc = R / CHUNK;
    const pageWords = this.pageSlots * SLOT_WORDS;
    const tb = performance.now();
    const slot = f.slot;
    if (slot && !f.layers) {
      // (round 100) from the pool: copies on the GPU only
      const enc = dev.createCommandEncoder({ label: 'stream thaw' });
      this.copyIn(enc, slot.buf, slot.off, lx, ly, slot.id < 0);
      for (const t of this.texs) {
        if (t.keep) continue;
        const tw = (R / t.div) * t.per;
        const th = R / t.div;
        const b = this.blankBuf(tw, th, t.fill);
        enc.copyBufferToTexture({ buffer: b.buf, bytesPerRow: b.rowBytes }, { texture: t.tex, origin: [(px / t.div) * t.per, py / t.div] }, [tw, th]);
      }
      dev.queue.submit([enc.finish()]);
      this.pool.release(slot);
      this.times.thaw.push(performance.now() - tl);
      record('rs.thaw', performance.now() - tl);
      if (this.times.thaw.length > 400) this.times.thaw.shift();
      record('write.pool', performance.now() - tl);
    } else {
      if (slot) this.pool.release(slot);
      const layers = f.layers!;
      let lenc: GPUCommandEncoder | undefined;
      for (let j = 0; j < rc; j++)
        for (let i = 0; i < rc; i++) {
          const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
          const page = layers.subarray((j * rc + i) * pageWords, (j * rc + i + 1) * pageWords);
          // (both: the passes that write layersNext copy all of it back over the layers; round 98: the second a GPU copy)
          dev.queue.writeBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, page);
          (lenc ??= dev.createCommandEncoder({ label: 'stream write layers' })).copyBufferToBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, wg.layersNext, table[ci * 2] * SLOT_WORDS * 4, page.byteLength);
        }
      if (lenc) dev.queue.submit([lenc.finish()]);
      record('write.layers', performance.now() - tl);
      // (round 98) the kept buffers' region in one upload, then a copy a row on the GPU: a row's writeBuffer each
      // (~800 a region) was most of a slide's frame
      const kept = this.bufs.filter((b) => b.keep);
      const size = kept.reduce((n, b) => n + R * R * b.stride * b.planes, 0);
      if (!this.writeStage || this.writeStage.size < size) {
        this.writeStage?.destroy();
        this.writeStage = wg.buf('streamWrite', size, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE);
        this.writeHost = new Uint8Array(size);
      }
      const host = this.writeHost!;
      const enc = dev.createCommandEncoder({ label: 'stream write' });
      let off = 0;
      for (const b of kept) {
        const d = f.bufs?.[b.name];
        const n = R * R * b.stride * b.planes;
        // (round 104: a dispatch a buffer, not a copy a row)
        const s = b.stride / 4;
        this.copier.rect(d ? { src: this.writeStage, srcOff: off / 4, srcRow: R * s, srcPlane: R * R * s, dst: b.buf, dstOff: (py * W + px) * s, dstRow: W * s, dstPlane: W * H * s, rowWords: R * s, rows: R, planes: b.planes } : { src: this.zeros(R * s), srcOff: 0, srcRow: 0, srcPlane: 0, dst: b.buf, dstOff: (py * W + px) * s, dstRow: W * s, dstPlane: W * H * s, rowWords: R * s, rows: R, planes: b.planes });
        if (d) host.set(d.subarray(0, n), off);
        off += n;
      }
      dev.queue.writeBuffer(this.writeStage, 0, host, 0, size);
      this.copier.encode(enc);
      record('write.bufs', performance.now() - tb);
      for (const t of this.texs) {
        const tw = (R / t.div) * t.per;
        const th = R / t.div;
        const d = t.keep ? f.texs?.[t.name] : undefined;
        if (d) dev.queue.writeTexture({ texture: t.tex, origin: [(px / t.div) * t.per, py / t.div] }, d, { bytesPerRow: tw * 16 }, [tw, th]);
        else {
          const b = this.blankBuf(tw, th, t.fill);
          enc.copyBufferToTexture({ buffer: b.buf, bytesPerRow: b.rowBytes }, { texture: t.tex, origin: [(px / t.div) * t.per, py / t.div] }, [tw, th]);
        }
      }
      dev.queue.submit([enc.finish()]);
    }
    this.winInfo.set(key, f.info);
    if (this.verify && f.info.last !== undefined) this.verifyNow(lx, ly, key, f.how, f.info.last);
    if (f.things?.length) for (const t of this.things) t.give(f.things, lx, ly);
    record('write.gpu', performance.now() - tb);
    const tc = performance.now();
    const surf = core.map.surface;
    // (round 106: the CPU's per-column arrays on the ring — the region's rows where it lies)
    const o = core.ring.corner(lx, ly);
    for (let r = 0; r < R; r++) surf.set(f.surface.subarray(r * R, (r + 1) * R), o + r * W);
    // (the ground: its own if the source said, else the surface)
    const gr = f.ground ?? f.surface;
    for (let r = 0; r < R; r++) this.ground.set(gr.subarray(r * R, (r + 1) * R), o + r * W);
    // (hybrid) the relief of what came in (round 98: made ahead when it was ready; the ground's offset to the surface,
    // and the runs in world z, are the same whatever oz it's cut at)
    const rf = f.relief;
    if (rf)
      for (let r = 0; r < R; r++) {
        const at = o + r * W;
        this.relief.set(rf.relief.subarray(r * R, (r + 1) * R), at);
        this.gapTop.set(rf.gapTop.subarray(r * R, (r + 1) * R), at);
        this.colTop.set(rf.colTop.subarray(r * R, (r + 1) * R), at);
      }
    else
    for (let r = 0; r < R; r++)
      for (let c = 0; c < R; c++) {
        const i = o + r * W + c;
        this.setRelief(i, joinColumn(this.columnOf(f.layers!, c, r), f.oz, f.outside[r * R + c]), surf[i], this.ground[i]);
      }
    record('write.cpu', performance.now() - tc);
    const tr = performance.now();
    for (const cb of this.onRelief) cb(lx, ly, lx + R, ly + R);
    record('write.onRelief', performance.now() - tr);
    const ta = performance.now();
    if (f.judge) for (const cb of this.onArrive) cb(lx + f.judge[0], ly + f.judge[1], lx + f.judge[2], ly + f.judge[3]);
    record('write.onArrive', performance.now() - ta);
  }
  /** (round 104) a row of zeros on the GPU, at least `words` long (what the kernel clears from) */
  private zeros(words: number): GPUBuffer {
    if (!this.zeroBuf || this.zeroBuf.size < words * 4) {
      // (an older one may be queued still: left to the world's dispose)
      this.zeroBuf = this.core.world.buf('streamZeros', Math.max(words * 4, 4096), GPUBufferUsage.STORAGE);
    }
    return this.zeroBuf;
  }
  private zeroBuf?: GPUBuffer;
  /** (round 98) the kept buffers' upload (writeNow) */
  private writeStage?: GPUBuffer;
  private writeHost?: Uint8Array;

  /** the installed modules' per-column buffers (WorldCore.columnBufs) as the streamer's own */
  private moduleBufs(): ColBuf[] {
    const out: ColBuf[] = this.core.columnBufs.map((m) => ({ name: m.name, buf: m.buf, stride: m.stride, planes: m.planes, keep: false }));
    return out;
  }

}

const align256 = (n: number) => Math.ceil(n / 256) * 256;

/** (hybrid) column i's relief into `to` from its runs (world z, joined), its surface and its ground's own top (window z) */
function setReliefIn(to: { relief: Uint8Array; gapTop: Float32Array; colTop: Float32Array }, i: number, col: Interval[], surface: number, ground: number): void {
  let g = -Infinity;
  for (let k = 1; k < col.length; k++) if (col[k].z0 - col[k - 1].z1 > RELIEF_GAP) g = col[k].z0;
  to.gapTop[i] = g;
  to.colTop[i] = col.length ? col[col.length - 1].z1 : 0;
  to.relief[i] = Math.abs(surface - ground) > RELIEF_FORM ? 1 : 0;
}

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

/** (hybrid) the top off the ground's own by more than this (cells): something stands on it or is cut into it */
const RELIEF_FORM = 0.75;
/** (hybrid) a gap between runs over this (cells): open — a cave, an overhang, a bridge's underside */
const RELIEF_GAP = 0.25;
/** (round 106) a frozen region's CPU parts before they're read (SaveItem.fill) */
const NO_F32 = new Float32Array(0);
const NO_U8 = new Uint8Array(0);
