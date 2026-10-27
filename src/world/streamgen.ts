// Streamed land (round 66, BACKLOG Q28): ground generated a region at a time
// from world coordinates alone, so a region can be made on demand anywhere
// and it meets its neighbours without a seam. Continents of low noise, hills,
// ridged ranges where a broad mask allows, lakes where the ground is below
// the sea level, soil and sand on what's not too steep, snow on the peaks,
// plants by moisture and height.
//
// What it doesn't do yet (it needs the coarse plan of Q28 step 3): rivers,
// caves, anything that needs to see past the region it is making.

import { ColumnGrid, type Interval, type WorldDims } from './layout';
import { cellPos, nbr, NDIR } from './lattice';
import { MAT } from './materials';
import type { MapData } from './mapgen';
import { fbm, hash2, smoothstep } from './noise';

/** the lakes' level (cells) */
export const SEA = 12;

function ridged(x: number, y: number, oct: number, seed: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  let w = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(fbm(x * f, y * f, 1, seed + i * 31));
    v *= v;
    s += v * a * w;
    w = Math.min(1, v * 1.6);
    n += a;
    a *= 0.5;
    f *= 2.1;
  }
  return s / n;
}

/** The ground's height at world position (px, py). */
export function streamHeight(px: number, py: number, zMax: number, seed = 1): number {
  const continent = fbm(px / 420, py / 420, 3, seed * 13 + 1);
  let z = 17 + continent * 12;
  z += fbm(px / 70, py / 70, 4, seed * 13 + 2) * 5;
  const mask = smoothstep(0.05, 0.4, fbm(px / 260, py / 260, 2, seed * 13 + 3));
  z += ridged(px / 95, py / 95, 4, seed * 13 + 4) * 48 * mask;
  return Math.max(2, Math.min(zMax - 12, z));
}

/** One region's land: its columns (row-major, local) and its fields. */
export interface RegionLand {
  x0: number;
  y0: number;
  w: number;
  h: number;
  cols: Interval[][];
  /** the top of each column */
  surface: Float32Array;
  water: Float32Array;
  moisture: Float32Array;
  vegetation: Float32Array;
  /** two per column: soil-bound, dissolved */
  contam: Float32Array;
  /** molten rock (world-gpu's lava, four per column), if any (round 69: the atlas's lava tubes) */
  lava?: Float32Array;
  /** lava springs (world-gpu's lavaSpring x), if any */
  lavaSpring?: Float32Array;
  /** water springs a tick (world-gpu's waterSource: the atlas's rivers), if any */
  waterSource?: Float32Array;
  /** (round 84) the atlas's rivers at their steady state (world-gpu's riverFlow, four per column), if any */
  riverFlow?: Float32Array;
  /** the ground's own top (world z), under what stands on it (the atlas's forms), if known */
  ground?: Float32Array;
  /** columns with something the structural system should judge (the atlas's forms of a weak material) */
  structural?: Uint8Array;
}

/**
 * The land of the w × h columns from world cell (x0, y0). y0 must be even
 * (odd rows are the shifted ones: a region's rows keep their parity).
 */
export function generateRegion(x0: number, y0: number, w: number, h: number, zMax: number, seed = 1): RegionLand {
  if (y0 & 1) throw new Error('a region starts on an even row');
  const N = w * h;
  // heights with a margin of one, for the slope
  const mw = w + 2;
  const hm = new Float32Array(mw * (h + 2));
  for (let y = -1; y <= h; y++)
    for (let x = -1; x <= w; x++) {
      const [px, py] = cellPos(x0 + x, y0 + y);
      hm[(y + 1) * mw + x + 1] = streamHeight(px, py, zMax, seed);
    }
  const H = (x: number, y: number) => hm[(y + 1) * mw + x + 1];
  const cols: Interval[][] = [];
  const surface = new Float32Array(N);
  const water = new Float32Array(N);
  const moisture = new Float32Array(N);
  const vegetation = new Float32Array(N);
  const contam = new Float32Array(N * 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const X = x0 + x;
      const Y = y0 + y;
      const [px, py] = cellPos(X, Y);
      const z = H(x, y);
      let slope = 0;
      for (let k = 0; k < NDIR; k++) {
        // (neighbours by world cell, back to local: the parity is the world's)
        const [nx, ny] = nbr(X, Y, k);
        slope = Math.max(slope, Math.abs(H(nx - x0, ny - y0) - z));
      }
      const col: Interval[] = [];
      const wet = z < SEA + 1.2;
      const snowy = z > 58 + fbm(px / 30, py / 30, 2, seed + 9) * 6;
      // loose cover only where it would lie (at its angle of repose)
      const cover = slope > 1.6 ? 0 : wet ? 1.5 : snowy ? 0.8 : 2.2 - slope;
      const rockTop = Math.max(1, Math.floor(z - cover));
      col.push({ z0: 0, z1: rockTop, mat: MAT.Stone });
      if (z > rockTop + 0.05) col.push({ z0: rockTop, z1: z, mat: wet ? MAT.Sand : snowy ? MAT.Snow : MAT.Soil });
      cols.push(col);
      const top = col[col.length - 1].z1;
      surface[i] = top;
      if (top < SEA) water[i] = SEA - top;
      const damp = 0.35 + 0.3 * fbm(px / 90, py / 90, 3, seed + 5) + 0.4 * smoothstep(SEA + 6, SEA, top);
      moisture[i] = Math.max(0.05, Math.min(1, damp));
      if (!water[i] && !snowy && cover > 0 && top < 52) {
        // woods in patches, meadow between, thin on the heights
        const wood = smoothstep(0.05, 0.35, fbm(px / 55, py / 55, 3, seed + 6)) * smoothstep(48, 30, top);
        vegetation[i] = Math.min(4.2, 1 + moisture[i] * 1.6 + wood * 2.2 + (hash2(X, Y, seed + 7) - 0.5) * 0.6);
      }
    }
  return { x0, y0, w, h, cols, surface, water, moisture, vegetation, contam };
}

/** The window from world cell (ox, oy) as a map (the level's first world). */
export function generateStreamWindow(dims: WorldDims, ox = 0, oy = 0, seed = 1): MapData {
  const { w, h } = dims;
  const N = w * h;
  const land = generateRegion(ox, oy, w, h, dims.zMax, seed);
  const grid = new ColumnGrid(dims);
  land.cols.forEach((c, i) => (grid.cols[i] = c));
  return {
    grid,
    water: land.water,
    contam: land.contam,
    moisture: land.moisture,
    vegetation: land.vegetation,
    oil: new Float32Array(N),
    drift: new Float32Array(N),
    oilStored: new Float32Array(N * 2),
    waterSource: new Float32Array(N),
    surface: land.surface,
    // (the level asks for these; the streamed land has no landmarks yet)
    poi: Object.fromEntries(['healthy', 'tutorial', 'dam', 'reservoir', 'site', 'landfill', 'heap'].map((k) => [k, [w / 2, h / 2]])) as Record<string, [number, number]>,
  };
}
