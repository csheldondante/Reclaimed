// The atlas's buffer sizes, tile pacing flags and stamp kinds, its records (Geyser, AtlasStats, AtlasColumns, MakeHow)
// and landFrom (columns to intervals). Owns no state.
import { type Interval } from '../../world/layout';
import { MATERIALS, MatState } from '../../world/materials';
import type { RegionLand } from '../../world/streamgen';

/** what the viewer and the caller set on top of the parameters */
export interface Extra {
  step?: number;
  /** colFinish's tile (round 80) */
  tile?: [number, number];
  x0?: number;
  y0?: number;
  w?: number;
  h?: number;
  vc?: [number, number];
  vscale?: number;
  mode?: number;
  vsize?: [number, number];
  /** (round 117) the macro ground's pass (AtlasP.macroPass): the hydrology's ground, without the terrain's small cuts */
  macro?: boolean;
}

// (round 117, terrain: 160 — AtlasP.macroPass and its padding)
export const PARAM_BYTES = 160;
/** forms.wgsl ColOut, and the runs a column holds (MR) */
export const COL_WORDS = 16;
export const COLG_BYTES = 96;
export const MR = 24;
export const INST_BYTES = 64;
export const MAX_INST = 8192;
/** a streamed batch's columns are made a TILE² tile a frame (round 80) */
export const TILE = 32;
/** the side of a paced batch's tile: `tile` or a little over, so a batch a little over whole tiles takes no more turns */
export const paceTile = (n: number, tile: number) => Math.ceil(n / Math.max(1, Math.round(n / tile)));
export const Q98 = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
/** (round 98, ?streamold=1) one tile a frame over every batch, as before round 98 */
export const TILE_OLD = Q98.get('streamold') === '1';
/** (round 98, ?tilesfixed=N — round 105: it was ?tiles=N, which the tile cache's ?tiles=1 then also set, pinning the
 *  pacer to one tile a frame) N tiles a frame, fixed (else paced by the frame's time: TilePacer) */
export const TILES_FIXED = Number(Q98.get('tilesfixed')) || 0;
/** (round 98, ?tilemax=) the most tiles a frame the pacer gives */
export const TILE_MAX = Number(Q98.get('tilemax') ?? 4);
/** (round 112, tilefast; ?tilechain=0 for the A/B) a frame's unused turns go to a tile's chain asking again in its task */
export const CHAIN = Q98.get('tilechain') !== '0';
/** (round 112, `tilefix2`; ?tilemaxfill=) off a phone, the most turns a frame while the tiles' lane has FILL_AT or more
 *  waiting (TilePacer.frame) */
export const TILE_MAX_FILL = Number(Q98.get('tilemaxfill') ?? 16);
export const FILL_AT = 3;

/**
 * (round 102) A phone (its user agent): Mali's timestamps aren't to be trusted (passes overlap: bench v2) and the
 * user's Pixel had long hitches with the budget pacer — round 98's pacing by the frame's time there unless asked.
 */
export const MOBILE = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
/** (round 102, ?tilemaxfast=) the most tiles a frame while the camera moves fast (round 102 first had 8: the frames
 *  held for the GPU went up on the desktop — the default is TILE_MAX) */
export const TILE_MAX_FAST = Number(Q98.get('tilemaxfast') ?? TILE_MAX);
/** (round 102, ?tilepace=frame | budget: round 98's pacing by the frame's time alone (the default: round 102 (2) — with the
 *  profiler's timestamps the budget gave one tile a frame on the desktop, its passes summing past the frame), or the GPU budget's) */
export const PACE_FRAME = (Q98.get('tilepace') ?? 'frame') === 'frame';
/** (round 102 (2)) finish.wgsl's tile a pacer turn: a quarter region on a phone, the whole region elsewhere */
/**
 * (round 108, TC18) How a region is made (Atlas.regionInto) — the one path's options, said by whoever asks:
 *  - pace: 'none' all at once; 'stream' a tile a turn of the pacer's streamer lane; 'tile' the tiles' lane (first);
 *  - stamps: 'plan' every hook's, plans made and awaited (the window's); 'made' only what's planned already — no plan
 *    started, nothing read back, no worker (a render-only tile's: DECISIONS round 106b);
 *  - summary: where the per-column summary goes on the GPU (nothing read back); without it FinishMeta comes back.
 */
export interface MakeHow {
  pace: 'none' | 'stream' | 'tile';
  stamps: 'plan' | 'made';
  summary?: { buf: GPUBuffer; off: number };
  /** (round 112, tilefast) pace 'tile': its place in the tiles' lane (lower first — the asker's urgency) */
  order?: number;
}
/** the window's regions' (the streamer's) */
export const WINDOW_MAKE: MakeHow = { pace: 'stream', stamps: 'plan' };
export const FINISH_TILE = Number(Q98.get('finishtile') ?? (MOBILE ? 32 : 64));
/** (round 102) cells a second of the camera's motion at which the pacer gives tiles the most of the frame's room */
export const FAST_AT = 80;

/** a geyser (Atlas.geysersIn) */
export interface Geyser {
  x: number;
  y: number;
  period: number;
  last: number;
  phase: number;
}
/** world cells between the geysers' lattice points (a whole number of them round the world) */
export const GEYSER_SPACING = 64;
export const MAT_SINTER = 37;
/**
 * (round 102) The geysers' sinter round a vent (9 × 9 columns, row-major from (-4, -4)): kind (0 none, 1 the pit, 2 the
 * mound) | dz << 2, dz in 1/256ths — made once here, laid alike by the CPU's regionLand and finish.wgsl.
 */
export const GEYSER_STENCIL = (() => {
  const t = new Uint32Array(81);
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const r = Math.hypot(dx, dy * 0.866);
      if (r > 4) continue;
      t[(dy + 4) * 9 + dx + 4] = r < 0.9 ? 1 | (Math.round(0.6 * 256) << 2) : 2 | (Math.round(1.8 * (1 - r / 4) ** 1.5 * 256) << 2);
    }
  return t;
})();

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
export const CRATER_WORDS = 8;
export const MAX_CRATERS = 64;
export const CRATER_BLOCK = 4 + MAX_CRATERS * CRATER_WORDS;

/** floats a giant (Atlas.giants), and what they're made of (materials.ts quartz) */
export const GIANT_FLOATS = 8;
export const MAT_QUARTZ = 36;
/** forms.wgsl MARGIN and its lattices' finest spacing */
/** (round 117, terrain track) basins the flood tool may add to the lakes' table (Atlas.addBasin) */
export const FLOOD_SPARE = 64;
export const FORM_MARGIN = 48;
export const FINEST = 4;

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

/** what the structural system judges (integrity.ts, fracture.ts: solid and weaker than bedrock) */
export const WEAK = MATERIALS.map((m) => m.state === MatState.Solid && m.strength < 1);

/** lava as the tubes hold it (lava.wgsl: it sets below 750) */
export const LAVA_HOT = 1250;

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
  const riverFlow = new Float32Array(N * 4);
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
    // (round 84: a river's column — its flow and depth at the reference wetness: world-gpu riverFlow)
    if (f[o + 15] > 0) riverFlow.set([f[o + 13], f[o + 14], f[o + 3], f[o + 15]], i * 4);
    ground[i] = f[o + 11];
    const lv = f[o + 6];
    if (lv > 0) {
      lava.set([lv, LAVA_HOT, 0, surface[i] + lv], i * 4);
      lavaSpring[i] = lv;
    }
  }
  return { x0, y0, w, h, cols, surface, water, moisture, vegetation, contam, lava, lavaSpring, waterSource, riverFlow, structural, ground, gapsFilled };
}
