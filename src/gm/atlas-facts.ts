// The atlas's facts for the world wiki (GM, docs/GM.md): what a built Atlas knows about its regions,
// settlements and roads, as plain JSON. Run once in a page (scripts/worldwiki.mjs --pull does it on
// ?atlas=view) and cached to data/atlas/; the wiki (src/gm/wiki.ts) is made from the cache in Node, so the
// GM never needs the browser. Read-only: nothing here changes the atlas.

import type { Atlas } from '../atlas/atlas';
import { STAMP } from '../atlas/atlas';
import { dryness, warmth } from '../atlas/regions';
import { TIER_NAMES } from '../atlas/landforms';
import { CROSS_NAMES, SETTING_NAMES, SITE_NAMES } from '../atlas/sites';
import { RIVER_LAVA } from '../atlas/rivers';
import { cellAt, ROW_H } from '../world/lattice';

export const ATLAS_FACTS_VERSION = 1;

export interface RegionFacts {
  id: number;
  kind: string;
  land: boolean;
  /** texels of the macro map (n × n) */
  area: number;
  /** its continent or body of water, and that one's area (texels) */
  cont: number;
  contArea: number;
  prov: number;
  fault: boolean;
  /** its centre (world units) */
  centre: [number, number];
  /** 0 poles .. 1 equator; 0 wet .. 1 dry; °C at sea level */
  warmth: number;
  dryness: number;
  temp: number;
  /** its landform's tier (lowland, upland, plateau, massif) and landform id; water: null */
  tier: string | null;
  landform: number | null;
  neighbours: number[];
  /** river and lava nodes in it; waterfalls among them */
  rivers: number;
  lava: number;
  /** its macro ground (world z; the sea is params.sea): lowest, mean, highest */
  ground: { min: number; mean: number; max: number };
  /** atlas stamps whose centre is in it: impact craters, crystal facets, domes, facet fields */
  stamps: string[];
}

export interface SiteFacts {
  id: number;
  /** world units, and the level's cell (?at=x,y) */
  at: [number, number];
  cell: [number, number];
  size: string;
  setting: string;
  region: number;
  cont: number;
  ground: number;
}

export interface RoadFacts {
  a: number;
  b: number;
  length: number;
  /** the regions it passes through, in order */
  via: number[];
  crossings: { kind: string; region: number }[];
}

/** (round 90, atlas/rivers.ts AtlasLake) a lake: its level (world z), middle and outlet (world units), area (texels) */
export interface LakeFacts {
  id: number;
  level: number;
  at: [number, number];
  cell: [number, number];
  outlet: [number, number];
  area: number;
  depth: number;
  regions: number[];
  inflow: number;
  outflow: boolean;
}

export interface AtlasFacts {
  version: number;
  params: { seed: number; style: number; n: number; cols: number; rows: number; worldW: number; worldH: number; sea: number };
  /** Atlas.spawn(): the level's start cell, and its region */
  spawn: { cell: [number, number]; region: number };
  regions: RegionFacts[];
  sites: SiteFacts[];
  roads: RoadFacts[];
  /** (round 90; absent in caches pulled before lakes) */
  lakes?: LakeFacts[];
}

const STAMP_NAMES = Object.fromEntries(Object.entries(STAMP).map(([k, v]) => [v, k])) as Record<number, string>;

export function atlasFacts(a: Atlas): AtlasFacts {
  const n = a.p.n;
  const regionAt = (x: number, y: number) => {
    const tx = ((Math.floor((x / a.worldW) * n) % n) + n) % n;
    const ty = ((Math.floor((y / a.worldH) * n) % n) + n) % n;
    return a.regionOf[ty * n + tx];
  };
  // neighbours: texels whose right or lower neighbour is another region
  const nb = a.defs.map(() => new Set<number>());
  const gMin = a.defs.map(() => Infinity);
  const gMax = a.defs.map(() => -Infinity);
  const gSum = a.defs.map(() => 0);
  const gN = a.defs.map(() => 0);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = a.regionOf[y * n + x];
      const h = a.hmac[y * n + x];
      if (h < gMin[r]) gMin[r] = h;
      if (h > gMax[r]) gMax[r] = h;
      gSum[r] += h;
      gN[r]++;
      const rr = a.regionOf[y * n + ((x + 1) % n)];
      const rd = a.regionOf[((y + 1) % n) * n + x];
      if (rr !== r) (nb[r].add(rr), nb[rr].add(r));
      if (rd !== r) (nb[r].add(rd), nb[rd].add(r));
    }
  const rivers = a.defs.map(() => 0);
  const lava = a.defs.map(() => 0);
  const nf = new Float32Array(a.riverNodes.buffer, a.riverNodes.byteOffset, a.riverNodes.length);
  for (let i = 0; i + 7 < a.riverNodes.length; i += 8) {
    const r = regionAt(nf[i], nf[i + 1]);
    if (a.riverNodes[i + 5] & RIVER_LAVA) lava[r]++;
    else rivers[r]++;
  }
  const stamps = a.defs.map(() => [] as string[]);
  const cu = new Uint32Array(a.craters.buffer, a.craters.byteOffset, a.craters.length);
  for (let i = 0; i + 7 < a.craters.length; i += 8) stamps[regionAt(a.craters[i], a.craters[i + 1])].push(STAMP_NAMES[cu[i + 6]] ?? `stamp ${cu[i + 6]}`);
  const regions: RegionFacts[] = a.defs.map((d, id) => {
    const lf = a.landformOf[id];
    const w = warmth(d.stat.cy);
    return {
      id,
      kind: d.kind,
      land: d.stat.land,
      area: d.stat.area,
      cont: d.stat.cont,
      contArea: d.stat.contArea,
      prov: d.stat.prov,
      fault: d.stat.fault,
      centre: [Math.round(d.stat.cx * a.worldW), Math.round(d.stat.cy * a.worldH)],
      warmth: +w.toFixed(3),
      dryness: +dryness(d.stat.cy).toFixed(3),
      temp: +(w * 34 - 8).toFixed(1),
      tier: d.stat.land && lf >= 0 && a.landforms[lf] ? TIER_NAMES[a.landforms[lf].tier] : null,
      landform: d.stat.land && lf >= 0 ? lf : null,
      neighbours: [...nb[id]].sort((x, y) => x - y),
      rivers: rivers[id],
      lava: lava[id],
      ground: { min: Math.round(gMin[id]), mean: Math.round(gSum[id] / Math.max(1, gN[id])), max: Math.round(gMax[id]) },
      stamps: stamps[id],
    };
  });
  const sites: SiteFacts[] = a.settlement.sites.map((s, id) => ({
    id,
    at: [Math.round(s.x), Math.round(s.y)],
    cell: cellAt(s.x, s.y),
    size: SITE_NAMES[s.size],
    setting: SETTING_NAMES[s.setting],
    region: regionAt(s.x, s.y),
    cont: s.cont,
    ground: Math.round(s.h),
  }));
  const roads: RoadFacts[] = a.settlement.roads.map((r) => {
    const via: number[] = [];
    for (let i = 0; i + 1 < r.path.length; i += 2) {
      const g = regionAt(r.path[i], r.path[i + 1]);
      if (via[via.length - 1] !== g) via.push(g);
    }
    return {
      a: r.a,
      b: r.b,
      length: Math.round(r.length),
      via,
      crossings: r.crossings.map((c) => ({ kind: CROSS_NAMES[c.kind], region: regionAt((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2) })),
    };
  });
  const spawn = a.spawn();
  return {
    version: ATLAS_FACTS_VERSION,
    params: { seed: a.p.seed, style: a.p.style, n, cols: a.p.cols, rows: a.p.rows, worldW: a.worldW, worldH: a.worldH, sea: a.p.sea },
    spawn: { cell: spawn, region: regionAt(spawn[0], spawn[1] * ROW_H) },
    regions,
    sites,
    roads,
    lakes: a.lakes.map((l) => ({ id: l.id, level: l.level, at: l.at, cell: cellAt(l.at[0], l.at[1]), outlet: l.outlet, area: l.texels, depth: l.depth, regions: l.regions, inflow: l.inflow, outflow: l.outflow >= 0 })),
  };
}
