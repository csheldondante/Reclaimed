// The streamer's definitions: its URL flags and sizes (REGION, TIER ...), the public types (LandSource, WorldSave,
// SlideStats ...; re-exported by streamer.ts), its internal records (ColBuf, ColTex, Frozen, RegionInfo, Freeze,
// SaveItem) and the small column helpers its modules share (applyChange, setReliefIn, topInside, boxOf). Owns no state.
import { type PoolSlot } from '../region-pool';
import { type ThingRecord } from '../../world/region-record';
import { addTop, lowerTop, type Interval } from '../../world/layout';
import { generateRegion, type RegionLand } from '../../world/streamgen';
import { type FinishMeta, type FinishTarget } from '../../atlas/finish';
import { type MakeHow } from '../../atlas/atlas';

/** columns a side of a region: what the window slides by (whole chunks, an even number of rows) */
export const REGION = 64;
/** ?slideskip=freeze,bufs,texs,mesh (round 80, measuring a slide's GPU burst only: what's left out is wrong) */
export const SLIDE_SKIP = new Set((typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('slideskip') ?? '').split(',').filter(Boolean));
/**
 * (round 91, ?lead=s) Seconds ahead the camera's motion is followed: the land where it will be then is asked for
 * ahead of the slides. 0: the camera's own place only, as before round 91.
 */
export const LEAD = Number((typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('lead')) ?? 1);
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
export const ARRIVE_URGENT = typeof location === 'undefined' || new URLSearchParams(location.search).get('arrivemesh') !== '0';
/**
 * (round 98, ?writems=) A slide's regions are written in one frame while they take under this many ms (CPU) — the
 * rest the next frames, the window held `busy` till they're in: a region is ~4 ms on the desktop, a strip five.
 */
export const WRITE_MS = Number((typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('writems')) ?? 6);
export const param = (k: string) => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(k));
/** (round 100, ?pool=N) regions kept on the GPU out of the window (LRU; ~1.6 MB a region at the atlas's K) */
export const POOL_CAP = Number(param('pool') ?? 32);
/** (round 100, ?ahead=N) strips asked for ahead along the camera's motion (round 102: at least; more as it moves faster) */
export const AHEAD = Number(param('ahead') ?? 2);
/** (round 102, ?aheads=) seconds of the camera's motion asked for ahead: strips enough for that at its speed, up to AHEAD_MAX
 *  (0, the default: AHEAD strips — 3 s flooded the tiles with land the camera never reached and the slides waited) */
export const AHEAD_S = Number(param('aheads') ?? 0);
export const AHEAD_MAX = 4;
/** (round 102, ?warpring=N) regions round a warp's window asked for into the pool as it lands (and as its target is picked) */
export const WARP_RING = Number(param('warpring') ?? 1);
/** (round 100) cells a second the camera's motion must pass to be followed ahead */
export const MOVING = 6;
/** (round 100, ?sweepms=) the window's regions read back for the store, one every this many ms */
export const SWEEP_MS = Number(param('sweepms') ?? 400);
/** (round 100) uploads of made land into the pool: this many ms of a frame at most (one at least) */
export const UPLOAD_MS = 3;
/** (round 104) a readback's hashing and encoding for the store (Streamer.later): this many ms of a frame at most (one at least) */
export const LATER_MS = 3;
/** (round 106, tilephone) a region's hash's time a turn of Streamer.later (ms): a few rows at a time */
export const HASH_SLICE_MS = 0.4;
/** (round 112, tilefast) a phone (its user agent): a region's record (1.7 MB at window 256) over four frames — a frame
 *  with a whole one's writeBuffer was the pan bench's disk hitch there (gpu-held, gpu-busy at 10 cells/s) */
export const PHONE_UA = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
/** (round 104, ?uploadmb=) and at most this many MB uploaded into the pool a frame (one region at least): the phone's
 *  frame with a few regions' writeBuffers in it was gpu-busy */
export const UPLOAD_BYTES = Number(param('uploadmb') ?? (PHONE_UA ? 0.5 : 2)) * 1048576;
/** (round 112) the least of a region's bytes written in one go (a multiple of 4) */
export const UPLOAD_SLICE = 65536;
/** (round 100) a page load's id: a record says which session wrote it */
export const SESSION = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
/** cells the window slides by in z */
export const TIER = 32;
/** (round 108, TC19) cells of its neighbours' made round a render-only tile's region (even: a region's rows start even):
 *  the grid's lattice and the normals at its edge read a cell past it */
export const TILE_BORDER = 2;
/** what the CPU keeps of a region made for the window (Atlas.regionInto returns it unless asked for a GPU summary) */
export const metaOf = (m: FinishMeta | null): FinishMeta => {
  if (!m) throw new Error('streamer: a window region made with nothing read back');
  return m;
};
/** the field mesh's chunks: cells across and rows down (fieldmesh.ts CHUNK) — a slide is whole ones */
export const MESH_CHUNK = 32;

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
  regionInto?(x0: number, y0: number, w: number, h: number, target: FinishTarget, how: MakeHow): Promise<FinishMeta | null>;
  /** (round 112, `tilefix`) what the source knows on the CPU of a box's heights, world z (Atlas.zRange) */
  zRange?(x0: number, y0: number, w: number, h: number): [number, number];
}

/** (round 100) what the store saves for a world: its id (the atlas's seed, the run), whether it's kept on disk */
export interface WorldSave {
  world: string;
  /** false: ?worldsave=0 — the session's memory only */
  disk: boolean;
  /** ?world=new: this world's records cleared first */
  fresh: boolean;
  /** (round 114) a run's world: the prefix of this seed's earlier runs' worlds, whose records are dropped (a run
   *  can't be resumed: level.ts worldSaveOf) */
  endedRuns?: string;
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
export interface ColBuf {
  name: string;
  buf: GPUBuffer;
  stride: number;
  planes: number;
  keep: boolean;
}

/** a per-column texture: `per` texels across a column (proj), or one texel per `div` × `div` columns (the wind) */
export interface ColTex {
  name: string;
  tex: GPUTexture;
  per: number;
  div: number;
  keep: boolean;
  /** what a column coming in starts with (default 0) */
  fill?: [number, number, number, number];
}

/** a region as it was left */
export interface Frozen {
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
export interface RegionInfo {
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
export interface Freeze {
  stage: GPUBuffer | null;
  items: SaveItem[];
  entries: [string, Frozen][];
  /** by the window index (y * W + x, the window after the slide) of the region coming in where it lay */
  pending: Map<number, { it: SaveItem; key: string; read: boolean; k: number; snap: unknown }>;
}

export interface SaveItem {
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
  /** (round 112) regions made by the source with a store there that had no record of them */
  storeMiss: number;
  uploads: number;
  /** (round 102) regions made on the GPU straight into the pool (atlas/finish.ts); asked for ahead of a warp (precache), and
   *  of a warp's regions, those made or under way before it */
  gpuMade: number;
  precached: number;
  warpReady: number;
}


export const align256 = (n: number) => Math.ceil(n / 256) * 256;

/** (hybrid) column i's relief into `to` from its runs (world z, joined), its surface and its ground's own top (window z) */
export function setReliefIn(to: { relief: Uint8Array; gapTop: Float32Array; colTop: Float32Array }, i: number, col: Interval[], surface: number, ground: number): void {
  let g = -Infinity;
  for (let k = 1; k < col.length; k++) if (col[k].z0 - col[k - 1].z1 > RELIEF_GAP) g = col[k].z0;
  to.gapTop[i] = g;
  to.colTop[i] = col.length ? col[col.length - 1].z1 : 0;
  to.relief[i] = Math.abs(surface - ground) > RELIEF_FORM ? 1 : 0;
}

/** whether a column cut at the window has its top in the window (nothing of it above) */
export const topInside = (cut: { inside: Interval[]; outside: Interval[] }, oz: number, zMax: number) => cut.inside.length > 0 && !cut.outside.some((iv) => iv.z0 >= oz + zMax - 1e-4);

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
export const RELIEF_FORM = 0.75;
/** (hybrid) a gap between runs over this (cells): open — a cave, an overhang, a bridge's underside */
export const RELIEF_GAP = 0.25;
/** (round 106) a frozen region's CPU parts before they're read (SaveItem.fill) */
export const NO_F32 = new Float32Array(0);
export const NO_U8 = new Uint8Array(0);
