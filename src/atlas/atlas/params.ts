// The atlas's parameters: AtlasParams, their defaults and keys, read from the URL (?a.<key>=). API: AtlasParams,
// DEFAULT_ATLAS, ATLAS_KEYS, atlasParamsFrom (re-exported by atlas.ts).


export interface AtlasParams {
  /** macro texels a side */
  n: number;
  seed: number;
  /** 0 earth, 1 strange (more patterned regions), 2 flesh */
  style: number;
  /** the world in cells (it wraps): cols a multiple of 64, rows of 64 */
  cols: number;
  rows: number;
  sea: number;
  zTop: number;
  /** continents: noise cells a turn; land above this */
  landPer: number;
  landThresh: number;
  warp: number;
  /** the partition: Voronoi cells a turn, and their jitter */
  cellsPer: number;
  jitter: number;
  /** faults: noise cells a turn; the strip between lo and hi */
  faultPer: number;
  faultLo: number;
  faultHi: number;
  lift: number;
  /** texels: islands and lakes smaller go; regions smaller merge into a neighbour */
  minIsland: number;
  minLake: number;
  minRegion: number;
  warpCell: number;
  /** caves: rock kept over them, and their scale */
  caveDepth: number;
  caveScale: number;
  /** the coarse world's cells a side (round 71: coarse.ts; a power of two dividing n) */
  coarseN: number;
  /** landforms (round 78, landforms.ts): the elevation noise's cells a turn (lower: bigger mesas and massifs) */
  formPer: number;
  /** the continent's slope (round 78): the land rises `lift` over this far from its coast (the coast's SDF) */
  liftReach: number;
  /** how much of each region's own noise and pattern shows on its landform (round 78: top-down wants less) */
  detail: number;
  /** impact craters in the macro height (round 78), at most MAX_CRATERS */
  craters: number;
  /** settlement sites (round 78, sites.ts), joined by roads */
  sites: number;
  /** atlas-scale oddities (round 78): clusters of faceted crystal mountains and bulbous domes */
  oddities: number;
}

export const DEFAULT_ATLAS: AtlasParams = {
  n: 2048,
  seed: 1,
  style: 0,
  cols: 16384,
  rows: 18944,
  // (round 79, the user: the coasts "should drop off more so the water is deeper" — at 28 the sea was 27 deep
  // at most over the world's floor)
  sea: 90,
  // (round 69: the world is taller than a window — the streamed window slides in z)
  zTop: 480,
  landPer: 3,
  landThresh: 0.06,
  warp: 0.05,
  cellsPer: 80,
  jitter: 0.85,
  faultPer: 5,
  faultLo: -0.035,
  faultHi: 0.035,
  lift: 36,
  minIsland: 30,
  minLake: 30,
  minRegion: 60,
  warpCell: 9,
  caveDepth: 7,
  // (round 79, the user: "I would try a 2-8x reduction in noise frequency to get bigger caves": 40 → 160; their
  // height scales with it, columns.wgsl caveZ)
  caveScale: 160,
  coarseN: 512,
  formPer: 3,
  liftReach: 2400,
  detail: 0.5,
  craters: 18,
  sites: 140,
  oddities: 16,
};

/** what `?a.<key>=` may set (the viewer's sliders write the same) */
export const ATLAS_KEYS = Object.keys(DEFAULT_ATLAS) as (keyof AtlasParams)[];

export function atlasParamsFrom(q: URLSearchParams, base: Partial<AtlasParams> = {}): AtlasParams {
  const p: AtlasParams = { ...DEFAULT_ATLAS, ...base };
  for (const k of ATLAS_KEYS) {
    const v = q.get(`a.${k}`);
    if (v !== null) {
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`a.${k}=${v} is not a number`);
      p[k] = x;
    }
  }
  if (p.cols % 64 || p.rows % 64) throw new Error('the atlas world must be whole regions of 64');
  if (p.n & (p.n - 1)) throw new Error('the atlas grid must be a power of two');
  return p;
}
