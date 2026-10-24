// The atlas's regions (round 67): what each region of the partition is — its
// kind, its ground's parameters, its border's profile — from coarse rules
// over what the macro passes measured (land or water, a fault's strip, the
// size of its continent, its latitude) and a province's preference, so a
// province reads as one country with variety inside it. Rules only, on the
// CPU: the GPU reads the table (REGION_WORDS a region, compose.wgsl Region).

import { MAT } from '../world/materials';
import { rng } from '../world/noise';

/** u32 words a region (compose.wgsl `Region`) */
export const REGION_WORDS = 24;

export const PAT = {
  none: 0, p6m: 1, p4m: 2, p6: 3, p3: 4, weave: 5, truchet: 6, cracks: 7, craters: 8,
  dunes: 9, coral: 10, maze: 11, ca: 12, veins: 13, kifs: 14, basalt: 15,
} as const;

export const EDGE = { smooth: 0, cliff: 1, ravine: 2, wall: 3, terrace: 4, beach: 5, seacliff: 6 } as const;

type Range = [number, number];
type Pick<T> = [T, number][];

interface KindDef {
  name: string;
  /** the viewer's colour */
  colour: [number, number, number];
  land: boolean;
  base: Range;
  rough: Range;
  ridge: Range;
  scale: Range;
  patterns: Pick<{ id: number; amp: Range; scale: Range }>;
  terrace?: Range;
  cover: number;
  top: number;
  rock: number;
  edges: Pick<number>;
  coast: Pick<number>;
  edgeW: Range;
  edgeD: Range;
  moist: number;
  veg: number;
  cave: number;
  accent?: number;
  depth?: Range;
}

const P = (id: number, amp: Range, scale: Range, w: number): [{ id: number; amp: Range; scale: Range }, number] => [{ id, amp, scale }, w];
const none = P(PAT.none, [0, 0], [1, 1], 1);
const smoothCoast: Pick<number> = [[EDGE.beach, 3], [EDGE.seacliff, 1]];

export const KINDS: Record<string, KindDef> = {
  ocean: { name: 'ocean', colour: [0.1, 0.22, 0.42], land: false, base: [-3, -2], rough: [2, 3], ridge: [0, 0], scale: [200, 320], patterns: [none], cover: 1.2, top: MAT.Sand, rock: MAT.Stone, edges: [[EDGE.smooth, 1]], coast: smoothCoast, edgeW: [30, 50], edgeD: [0, 0], moist: 0, veg: 0, cave: 0, depth: [14, 22] },
  lake: { name: 'lake', colour: [0.2, 0.42, 0.6], land: false, base: [-3, -1], rough: [1, 2], ridge: [0, 0], scale: [120, 200], patterns: [none], cover: 1.4, top: MAT.Silt, rock: MAT.Stone, edges: [[EDGE.smooth, 1]], coast: smoothCoast, edgeW: [20, 30], edgeD: [0, 0], moist: 0, veg: 0, cave: 0, depth: [4, 9] },
  plains: { name: 'plains', colour: [0.55, 0.7, 0.35], land: true, base: [3, 8], rough: [2, 4], ridge: [0, 0], scale: [140, 260], patterns: [[none[0], 4], P(PAT.craters, [3, 6], [40, 70], 0.4)], cover: 2.2, top: MAT.Soil, rock: MAT.Stone, edges: [[EDGE.smooth, 6], [EDGE.terrace, 0.8], [EDGE.cliff, 0.5]], coast: smoothCoast, edgeW: [24, 44], edgeD: [3, 6], moist: 0.05, veg: 1, cave: 0.4 },
  hills: { name: 'hills', colour: [0.42, 0.6, 0.3], land: true, base: [8, 16], rough: [7, 12], ridge: [0, 4], scale: [70, 130], patterns: [[none[0], 5], P(PAT.p6m, [4, 7], [30, 50], 0.5)], cover: 2, top: MAT.Soil, rock: MAT.Stone, edges: [[EDGE.smooth, 6], [EDGE.ravine, 0.6], [EDGE.terrace, 1]], coast: smoothCoast, edgeW: [20, 36], edgeD: [6, 12], moist: 0.05, veg: 1, cave: 0.7 },
  highlands: { name: 'highlands', colour: [0.5, 0.48, 0.4], land: true, base: [22, 34], rough: [6, 10], ridge: [16, 28], scale: [90, 150], patterns: [none], cover: 1.4, top: MAT.Soil, rock: MAT.Stone, edges: [[EDGE.cliff, 2], [EDGE.smooth, 2], [EDGE.ravine, 1]], coast: [[EDGE.seacliff, 3], [EDGE.beach, 1]], edgeW: [16, 28], edgeD: [8, 16], moist: 0, veg: 0.7, cave: 1 },
  range: { name: 'range', colour: [0.62, 0.6, 0.58], land: true, base: [30, 44], rough: [6, 10], ridge: [40, 64], scale: [80, 130], patterns: [none], cover: 1, top: MAT.Stone, rock: MAT.Stone, edges: [[EDGE.smooth, 3], [EDGE.wall, 1]], coast: [[EDGE.seacliff, 2], [EDGE.beach, 1]], edgeW: [40, 70], edgeD: [8, 14], moist: -0.05, veg: 0.4, cave: 1 },
  rift: { name: 'rift', colour: [0.35, 0.3, 0.32], land: true, base: [-6, -2], rough: [2, 4], ridge: [0, 0], scale: [100, 160], patterns: [[none[0], 3], P(PAT.cracks, [3, 5], [18, 30], 1)], cover: 1.2, top: MAT.Silt, rock: MAT.Basalt, edges: [[EDGE.cliff, 4], [EDGE.terrace, 1]], coast: [[EDGE.seacliff, 1]], edgeW: [8, 14], edgeD: [0, 0], moist: 0.15, veg: 0.6, cave: 0.5, accent: MAT.Crystal },
  mesa: { name: 'mesa', colour: [0.78, 0.5, 0.32], land: true, base: [14, 26], rough: [8, 14], ridge: [0, 10], scale: [60, 110], patterns: [[none[0], 2], P(PAT.p4m, [6, 12], [40, 70], 1)], terrace: [5, 8], cover: 0.6, top: MAT.Sand, rock: MAT.Sandstone, edges: [[EDGE.cliff, 3], [EDGE.terrace, 2]], coast: [[EDGE.seacliff, 3]], edgeW: [10, 18], edgeD: [0, 0], moist: -0.15, veg: 0.25, cave: 0.8 },
  badlands: { name: 'badlands', colour: [0.7, 0.45, 0.35], land: true, base: [8, 16], rough: [4, 7], ridge: [6, 14], scale: [50, 90], patterns: [P(PAT.cracks, [4, 8], [14, 26], 2), P(PAT.truchet, [3, 6], [20, 34], 1)], cover: 0.8, top: MAT.Sand, rock: MAT.Sandstone, edges: [[EDGE.ravine, 3], [EDGE.cliff, 1]], coast: [[EDGE.seacliff, 2]], edgeW: [12, 22], edgeD: [10, 18], moist: -0.2, veg: 0.2, cave: 0.6 },
  dunes: { name: 'dunes', colour: [0.86, 0.76, 0.5], land: true, base: [4, 10], rough: [2, 4], ridge: [0, 0], scale: [140, 220], patterns: [P(PAT.dunes, [5, 9], [26, 44], 1)], cover: 3, top: MAT.Sand, rock: MAT.Sandstone, edges: [[EDGE.smooth, 1]], coast: smoothCoast, edgeW: [30, 50], edgeD: [0, 0], moist: -0.3, veg: 0.05, cave: 0.2 },
  tundra: { name: 'tundra', colour: [0.75, 0.78, 0.74], land: true, base: [4, 12], rough: [3, 6], ridge: [0, 6], scale: [100, 180], patterns: [[none[0], 3], P(PAT.p6, [3, 5], [30, 50], 0.6)], cover: 1.6, top: MAT.Soil, rock: MAT.Stone, edges: [[EDGE.smooth, 3], [EDGE.cliff, 1]], coast: smoothCoast, edgeW: [20, 36], edgeD: [0, 0], moist: 0, veg: 0.3, cave: 0.4 },
  glacier: { name: 'glacier', colour: [0.88, 0.92, 0.98], land: true, base: [26, 40], rough: [4, 7], ridge: [8, 18], scale: [120, 200], patterns: [none], cover: 2, top: MAT.Snow, rock: MAT.Ice, edges: [[EDGE.cliff, 2], [EDGE.wall, 1]], coast: [[EDGE.seacliff, 3]], edgeW: [10, 18], edgeD: [6, 10], moist: 0, veg: 0, cave: 0.3 },
  marsh: { name: 'marsh', colour: [0.3, 0.5, 0.36], land: true, base: [0.4, 1.6], rough: [0.8, 1.6], ridge: [0, 0], scale: [60, 120], patterns: [[none[0], 2], P(PAT.veins, [-2, -1], [40, 70], 1)], cover: 2.4, top: MAT.Silt, rock: MAT.Stone, edges: [[EDGE.smooth, 1]], coast: smoothCoast, edgeW: [24, 40], edgeD: [0, 0], moist: 0.35, veg: 1.3, cave: 0 },
  karst: { name: 'karst', colour: [0.6, 0.66, 0.55], land: true, base: [8, 14], rough: [3, 5], ridge: [0, 0], scale: [80, 140], patterns: [P(PAT.p4m, [10, 18], [22, 34], 1), P(PAT.p6m, [10, 18], [22, 34], 1), P(PAT.ca, [8, 14], [80, 120], 1)], cover: 1, top: MAT.Soil, rock: MAT.Stone, edges: [[EDGE.cliff, 2], [EDGE.smooth, 1]], coast: [[EDGE.seacliff, 2]], edgeW: [12, 20], edgeD: [0, 0], moist: 0.1, veg: 1.2, cave: 1.6 },
  basalt: { name: 'basalt', colour: [0.25, 0.24, 0.26], land: true, base: [10, 18], rough: [2, 4], ridge: [0, 0], scale: [80, 140], patterns: [P(PAT.basalt, [6, 12], [6, 10], 1)], cover: 0.3, top: MAT.Basalt, rock: MAT.Basalt, edges: [[EDGE.cliff, 3]], coast: [[EDGE.seacliff, 3]], edgeW: [8, 14], edgeD: [0, 0], moist: 0, veg: 0.3, cave: 0.5 },
  craters: { name: 'craters', colour: [0.55, 0.53, 0.47], land: true, base: [8, 14], rough: [2, 4], ridge: [0, 4], scale: [100, 160], patterns: [P(PAT.craters, [10, 18], [40, 80], 1)], cover: 1.2, top: MAT.Rubble, rock: MAT.Stone, edges: [[EDGE.smooth, 2], [EDGE.wall, 1]], coast: smoothCoast, edgeW: [18, 30], edgeD: [4, 8], moist: -0.1, veg: 0.4, cave: 0.6, accent: MAT.Crystal },
  // the strange ones (more of them when AtlasParams.style is 1; flesh when 2)
  coral: { name: 'coral', colour: [0.85, 0.55, 0.6], land: true, base: [6, 12], rough: [2, 3], ridge: [0, 0], scale: [100, 160], patterns: [P(PAT.coral, [6, 10], [50, 80], 1), P(PAT.maze, [6, 10], [50, 80], 1)], cover: 0.8, top: MAT.Sand, rock: MAT.Sandstone, edges: [[EDGE.wall, 2], [EDGE.smooth, 1]], coast: smoothCoast, edgeW: [14, 24], edgeD: [5, 9], moist: 0.1, veg: 0.6, cave: 0.4, accent: MAT.Crystal },
  kaleido: { name: 'kaleido', colour: [0.6, 0.45, 0.8], land: true, base: [10, 18], rough: [2, 4], ridge: [0, 0], scale: [100, 160], patterns: [P(PAT.kifs, [10, 16], [60, 100], 1), P(PAT.p6m, [10, 16], [40, 70], 1), P(PAT.p3, [8, 14], [40, 60], 1), P(PAT.weave, [4, 8], [16, 28], 0.6)], cover: 0.6, top: MAT.Stone, rock: MAT.Stone, edges: [[EDGE.terrace, 2], [EDGE.wall, 1]], coast: [[EDGE.seacliff, 2]], edgeW: [16, 26], edgeD: [6, 10], moist: 0, veg: 0.5, cave: 0.6, accent: MAT.Crystal },
  // (flesh: stand-in materials until the user picks its own: tile's red for the flesh, bone for what shows through)
  flesh: { name: 'flesh', colour: [0.75, 0.32, 0.3], land: true, base: [6, 14], rough: [5, 8], ridge: [0, 0], scale: [60, 110], patterns: [P(PAT.maze, [5, 8], [40, 60], 1), P(PAT.coral, [5, 8], [40, 60], 1)], cover: 0.4, top: MAT.Tile, rock: MAT.Tile, edges: [[EDGE.ravine, 2], [EDGE.wall, 2]], coast: smoothCoast, edgeW: [14, 22], edgeD: [6, 10], moist: 0.3, veg: 0.2, cave: 1.4, accent: MAT.Bone },
  veins: { name: 'veins', colour: [0.6, 0.2, 0.25], land: true, base: [6, 12], rough: [3, 5], ridge: [0, 0], scale: [80, 140], patterns: [P(PAT.veins, [-7, -4], [70, 120], 1)], cover: 0.4, top: MAT.Tile, rock: MAT.Tile, edges: [[EDGE.ravine, 2], [EDGE.smooth, 1]], coast: smoothCoast, edgeW: [14, 22], edgeD: [8, 12], moist: 0.35, veg: 0.2, cave: 1, accent: MAT.Bone },
};

export const KIND_IDS = Object.keys(KINDS);

/** what the macro passes measured of a region (atlas.ts) */
export interface RegionStat {
  area: number;
  land: boolean;
  /** a fault's strip (the band between the two thresholds) */
  fault: boolean;
  prov: number;
  /** its continent or body of water, and that one's area (texels) */
  cont: number;
  contArea: number;
  /** its centre (torus units, 0..1) */
  cx: number;
  cy: number;
}

export interface RegionDef {
  kind: string;
  stat: RegionStat;
  words: Uint32Array;
}

const lerp = (r: Range, t: number) => r[0] + (r[1] - r[0]) * t;
function pick<T>(xs: Pick<T>, t: number): T {
  const sum = xs.reduce((s, [, w]) => s + w, 0);
  let a = t * sum;
  for (const [x, w] of xs) {
    a -= w;
    if (a <= 0) return x;
  }
  return xs[xs.length - 1][0];
}

/** 0 at the poles, 1 at the equator (compose.wgsl warmth) */
export const warmth = (cy: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * cy);

/** The kinds a province of this climate leans to (weights). */
function climateKinds(warm: number, dry: number, style: number): Pick<string> {
  const temp = warm * 32 - 6;
  let ks: Pick<string>;
  if (temp < 2) ks = [['tundra', 3], ['glacier', 2], ['highlands', 1], ['craters', 0.3]];
  else if (dry > 0.6 && temp > 13) ks = [['dunes', 3], ['mesa', 2], ['badlands', 2], ['craters', 0.5], ['basalt', 0.4]];
  else if (dry < 0.25 && temp > 15) ks = [['marsh', 2], ['hills', 2], ['karst', 1.2], ['plains', 1]];
  else ks = [['plains', 3], ['hills', 3], ['highlands', 1.5], ['karst', 0.6], ['craters', 0.3], ['basalt', 0.3], ['mesa', 0.4]];
  if (style === 1) ks = [...ks, ['kaleido', 2.5], ['coral', 1.2], ['basalt', 1], ['veins', 0.4]];
  if (style === 2) ks = [['flesh', 3], ['veins', 3], ['coral', 1.5], ...ks.map(([k, w]) => [k, w * 0.15] as [string, number])];
  return ks;
}

/** how dry a latitude is (0 wet .. 1 dry), compose.wgsl moistureAt's latitude term */
const dryness = (cy: number) => {
  const lat = 1 - warmth(cy);
  return 0.5 - 0.5 * Math.cos(lat * 3 * Math.PI);
};

/** The table: each region's kind and parameters. */
export function defineRegions(stats: RegionStat[], seed: number, style: number, oceanArea: number): RegionDef[] {
  const provKind = new Map<number, string>();
  return stats.map((st, i) => {
    const r = rng(seed * 7919 + i * 104729 + 17);
    let kind: string;
    if (!st.land) kind = st.contArea >= oceanArea ? 'ocean' : 'lake';
    else if (st.fault) kind = rng(seed * 31 + st.prov * 7 + 3)() < 0.68 ? 'range' : 'rift';
    else {
      // the province's own kind most of the time; another of its climate otherwise
      const ks = climateKinds(warmth(st.cy), dryness(st.cy), style);
      let pk = provKind.get(st.prov);
      if (!pk) {
        pk = pick(ks, rng(seed * 131 + st.prov * 977 + 5)());
        provKind.set(st.prov, pk);
      }
      kind = r() < 0.85 ? pk : pick(ks, r());
      // small islands: no glaciers or ranges on a rock in the sea
      if (st.contArea < 400 && (kind === 'glacier' || kind === 'highlands')) kind = 'hills';
    }
    const k = KINDS[kind];
    const pat = pick(k.patterns, r());
    const w = new Uint32Array(REGION_WORDS);
    const f = new Float32Array(w.buffer);
    w[0] = KIND_IDS.indexOf(kind);
    w[1] = pat.id;
    w[2] = k.top;
    w[3] = k.rock;
    f[4] = lerp(k.base, r());
    f[5] = lerp(k.rough, r());
    f[6] = lerp(k.ridge, r());
    f[7] = lerp(k.scale, r());
    f[8] = lerp(pat.amp, r());
    f[9] = lerp(pat.scale, r());
    f[10] = k.terrace ? lerp(k.terrace, r()) : 0;
    f[11] = k.cover;
    w[12] = pick(k.edges, r());
    f[13] = lerp(k.edgeW, r());
    f[14] = lerp(k.edgeD, r());
    f[15] = r();
    w[16] = pick(k.coast, r());
    f[17] = k.moist;
    f[18] = k.veg;
    f[19] = k.cave;
    w[20] = (r() * 0xffffffff) >>> 0;
    w[21] = (k.land ? 1 : 0) | (st.fault ? 2 : 0);
    w[22] = k.accent ?? 0;
    f[23] = k.depth ? lerp(k.depth, r()) : 0;
    return { kind, stat: st, words: w };
  });
}
