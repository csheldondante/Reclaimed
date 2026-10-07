// Procedural first-prototype map (design doc §26): sloped valley, a dammed
// reservoir (future leverage), a river, a polluted industrial site with ruins,
// a toxic pond, and one small healthy patch that can seed recovery.
//
// Orientation: the camera looks from +x+y, so low x+y is "far" (top of screen).
// Terrain rises toward the back so mountains never hide the play area.

import { ColumnGrid, type WorldDims } from './layout';
import { MAT } from './materials';
import { fbm, hash2, rng, smoothstep } from './noise';

export interface MapData {
  grid: ColumnGrid;
  /** Initial water depth per column (cells). */
  water: Float32Array;
  /** Per column: [soil contamination, dissolved contamination] interleaved. */
  contam: Float32Array;
  moisture: Float32Array;
  vegetation: Float32Array;
  /** Water added per sim tick per column (springs). */
  waterSource: Float32Array;
  /** Initial surface height for CPU-side queries (storm steering, camera). */
  surface: Float32Array;
  /** Notable locations for camera framing / debugging. */
  poi: Record<string, [number, number]>;
}

type P = [number, number];

const RIVER: P[] = [
  [0, 8],
  [20, 28],
  [58, 62],
  [92, 94],
  [118, 140],
  [150, 176],
  [192, 202],
  [255, 236],
];
const RESERVOIR: P = [58, 62];
const DAM: P = [94, 96];
const SITE = { x0: 138, y0: 70, x1: 214, y1: 136 };
const POND: P = [150, 124];
const HEALTHY: P = [44, 198];
/** Old landfill on the river's floodplain: too heavy for rain, scoured by a flood. */
const LANDFILL: P = [120, 114];

export function generateMap(dims: WorldDims, seed = 1): MapData {
  const { w, h } = dims;
  const N = w * h;
  const r = rng(seed);
  const height = new Float32Array(N);

  const baseAt = (x: number, y: number) => {
    const t = (x + y) / (w + h - 2);
    return 6 + 32 * Math.pow(1 - t, 1.25) + fbm(x / 52, y / 52, 3, seed) * 9;
  };

  // River bed profile: walk the polyline, take a running minimum so the bed always descends.
  const riverPts: { x: number; y: number; z: number }[] = [];
  let bed = Infinity;
  for (let i = 0; i < RIVER.length - 1; i++) {
    const a = RIVER[i];
    const b = RIVER[i + 1];
    const len = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    for (let s = 0; s < len; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / len;
      const y = a[1] + ((b[1] - a[1]) * s) / len;
      bed = Math.min(bed - 0.03, baseAt(x, y) - 6);
      riverPts.push({ x, y, z: Math.max(1.5, bed) });
    }
  }
  const nearestRiver = (x: number, y: number) => {
    let best = Infinity;
    let z = 0;
    // coarse-to-fine is unnecessary at this map size; brute force over ~400 points
    for (const p of riverPts) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < best) {
        best = d;
        z = p.z;
      }
    }
    return { d: Math.sqrt(best), z };
  };

  const damDir: P = [RIVER[3][0] - RIVER[1][0], RIVER[3][1] - RIVER[1][1]];
  const dl = Math.hypot(damDir[0], damDir[1]);
  damDir[0] /= dl;
  damDir[1] /= dl;
  const damBed = nearestRiver(DAM[0], DAM[1]).z;
  const damTop = Math.round(damBed + 13);
  // the reservoir starts at the spillway level: inflow and spill balance (equilibrium)
  const SPILL_DEPTH = 3;
  const waterLevel = damTop - SPILL_DEPTH + 0.15;
  const resFloor = nearestRiver(RESERVOIR[0], RESERVOIR[1]).z - 7;

  const padZ = Math.round(baseAt((SITE.x0 + SITE.x1) / 2, (SITE.y0 + SITE.y1) / 2));
  const resDirL = Math.hypot(DAM[0] - RESERVOIR[0], DAM[1] - RESERVOIR[1]);
  const resDir: P = [(DAM[0] - RESERVOIR[0]) / resDirL, (DAM[1] - RESERVOIR[1]) / resDirL];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let z = baseAt(x, y);
      const rv = nearestRiver(x, y);
      // valley walls ease toward the bed, channel cuts into it
      z = z + (rv.z + 5 - z) * smoothstep(34, 8, rv.d) * 0.7;
      z = z + (rv.z - z) * smoothstep(5, 1.5, rv.d);
      // reservoir bowl
      const dr = Math.hypot(x - RESERVOIR[0], y - RESERVOIR[1]);
      const bowl = resFloor + Math.pow(dr / 38, 2) * 22;
      z = Math.min(z, bowl + fbm(x / 9, y / 9, 2, seed + 3) * 1.2);
      // dam shoulders: keep the banks beside the dam above the water line
      const along = (x - DAM[0]) * damDir[0] + (y - DAM[1]) * damDir[1];
      const across = (x - DAM[0]) * -damDir[1] + (y - DAM[1]) * damDir[0];
      if (Math.abs(along) < 10 && Math.abs(across) > 6 && Math.abs(across) < 34) {
        z = Math.max(z, damTop + 1 - smoothstep(22, 34, Math.abs(across)) * 1.5);
      }
      // basin rim: the reservoir may only leave through the dam valley
      const toDam = ((x - RESERVOIR[0]) * resDir[0] + (y - RESERVOIR[1]) * resDir[1]);
      const damValley = rv.d < 8 && toDam > 0;
      if (!damValley) {
        const rimW = smoothstep(26, 33, dr) * (1 - smoothstep(46, 56, dr));
        z = Math.max(z, z + (waterLevel + 2.5 - z) * rimW);
      }
      // industrial pad: flatten
      const padW = Math.min(x - SITE.x0, SITE.x1 - x, y - SITE.y0, SITE.y1 - y);
      // the pad only partly levels the land: ruins sit on varied ground with foundations
      const padK = smoothstep(-10, 2, padW);
      z = z + (padZ - z) * padK * 0.45 + fbm(x / 15, y / 15, 2, seed + 51) * 4.5 * padK;
      // landfill: a low bench on the floodplain, gently draining to the river
      const dlf = Math.hypot(x - LANDFILL[0], y - LANDFILL[1]);
      z = z + (rv.z + 2.5 + rv.d * 0.04 - z) * smoothstep(20, 9, dlf);
      // toxic pond depression
      const dp = Math.hypot(x - POND[0], y - POND[1]);
      z -= 3 * smoothstep(8, 3, dp);
      height[y * w + x] = Math.max(1, Math.min(dims.zMax - 20, z));
    }
  }

  const grid = new ColumnGrid(dims);
  const water = new Float32Array(N);
  const contam = new Float32Array(N * 2);
  const moisture = new Float32Array(N);
  const vegetation = new Float32Array(N);
  const waterSource = new Float32Array(N);

  // Terrain columns
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const top = Math.round(height[i]);
      const gx = (height[Math.min(w - 1, x + 1) + y * w] - height[Math.max(0, x - 1) + y * w]) / 2;
      const gy = (height[x + Math.min(h - 1, y + 1) * w] - height[x + Math.max(0, y - 1) * w]) / 2;
      const slope = Math.hypot(gx, gy);
      const rv = nearestRiver(x, y);
      let soil = Math.round(Math.max(0, 3.2 + fbm(x / 11, y / 11, 2, seed + 11) * 2 - slope * 1.6));
      const inPad = x >= SITE.x0 && x < SITE.x1 && y >= SITE.y0 && y < SITE.y1;
      const dh = Math.hypot(x - HEALTHY[0], y - HEALTHY[1]);
      // bare rock outcrops break up the open ground
      if (fbm(x / 16, y / 16, 3, seed + 13) > 0.3 + smoothstep(30, 10, dh)) soil = 0;
      if (dh < 16) soil = Math.max(soil, 4);
      if (inPad) soil = Math.max(soil, 2); // room for the asphalt cap
      soil = Math.min(soil, top - 1);
      const stoneTop = top - soil;
      grid.push(x, y, 0, stoneTop, MAT.Stone);
      if (inPad) {
        grid.push(x, y, stoneTop, top - 1, MAT.Soil);
        grid.push(x, y, top - 1, top, MAT.Asphalt);
      } else {
        const sandy = rv.d < 4 + hash2(x, y, 5) * 2 && soil > 0;
        grid.push(x, y, stoneTop, top, sandy ? MAT.Sand : MAT.Soil);
      }
    }
  }

  // Dam: concrete wall across the valley with a spillway notch
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const along = (x - DAM[0]) * damDir[0] + (y - DAM[1]) * damDir[1];
      const across = (x - DAM[0]) * -damDir[1] + (y - DAM[1]) * damDir[0];
      if (Math.abs(along) <= 1.6 && Math.abs(across) <= 19) {
        const g = grid.top(x, y);
        const notch = Math.abs(across) < 3.5 ? SPILL_DEPTH : 0;
        if (g < damTop - notch) grid.push(x, y, g, damTop - notch, MAT.Concrete);
      }
    }
  }

  // Reservoir fill: flood from the reservoir centre below the water line, bounded radius.
  {
    const seen = new Uint8Array(N);
    const stack: number[] = [RESERVOIR[1] * w + RESERVOIR[0]];
    while (stack.length) {
      const i = stack.pop()!;
      if (seen[i]) continue;
      seen[i] = 1;
      const x = i % w;
      const y = (i / w) | 0;
      if (Math.hypot(x - RESERVOIR[0], y - RESERVOIR[1]) > 40) continue;
      const g = grid.top(x, y);
      if (g >= waterLevel) continue;
      water[i] = waterLevel - g;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - w);
      if (y < h - 1) stack.push(i + w);
    }
  }

  // River inflow: water enters continuously at the far map edge (as if the
  // river continues off-map), fills the reservoir to its spillway and leaves
  // through the near edge. A few cells in from the edge so most of it heads
  // downstream rather than straight back out.
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = 2; dx <= 4; dx++) waterSource[(RIVER[0][1] + dy + 2) * w + RIVER[0][0] + dx] = 0.01;

  // Industrial ruins on the pad
  const ruinRand = rng(seed * 31 + 7);
  buildRuin(grid, 146, 78, 172, 100, 3, 5, MAT.Concrete, ruinRand, 0.35);
  buildRuin(grid, 180, 80, 194, 94, 5, 4, MAT.Concrete, ruinRand, 0.5);
  buildRuin(grid, 150, 104, 162, 114, 2, 4, MAT.Brick, ruinRand, 0.3);
  buildTank(grid, 186, 116, 6, 9);
  buildTank(grid, 200, 104, 5, 7);
  buildTank(grid, 202, 122, 4, 6);
  // rubble mounds and wrecks
  for (let k = 0; k < 14; k++) {
    const cx = SITE.x0 + 4 + Math.floor(r() * (SITE.x1 - SITE.x0 - 8));
    const cy = SITE.y0 + 4 + Math.floor(r() * (SITE.y1 - SITE.y0 - 8));
    const rad = 2 + r() * 3;
    for (let y = cy - 5; y <= cy + 5; y++)
      for (let x = cx - 5; x <= cx + 5; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > rad) continue;
        const g = grid.top(x, y);
        if (grid.topMat(x, y) !== MAT.Asphalt) continue;
        grid.push(x, y, g, g + Math.max(1, Math.round((1 - d / rad) * 3)), MAT.Rubble);
      }
  }
  for (let k = 0; k < 10; k++) {
    // car-sized rusting wrecks along a road
    const x0 = 214 + k * 4 + Math.floor(r() * 2);
    const y0 = 104 + Math.floor(r() * 3);
    if (x0 + 2 >= w) break;
    for (let y = y0; y < y0 + 4; y++)
      for (let x = x0; x < x0 + 2; x++) {
        const g = grid.top(x, y);
        grid.push(x, y, g, g + 1 + (y > y0 && y < y0 + 3 ? 1 : 0), MAT.Rust);
      }
  }
  // Road heading off the right side of the map
  for (let x = SITE.x1; x < w; x++)
    for (let y = 100; y < 112; y++) {
      const c = grid.col(x, y);
      const t = c[c.length - 1];
      if (t.mat !== MAT.Rust && hash2(x, y, 9) > 0.12 && t.mat !== MAT.Asphalt) {
        if (t.z1 - t.z0 > 1) {
          t.z1 -= 1;
          grid.push(x, y, t.z1, t.z1 + 1, MAT.Asphalt);
        } else t.mat = MAT.Asphalt;
      }
    }

  // Scattered remains of the old world: concrete chunks, rusted scrap, rubble
  // heaps. Denser toward the industrial site and the road, sparse elsewhere.
  {
    const d = rng(seed * 97 + 3);
    const siteC: P = [(SITE.x0 + SITE.x1) / 2, (SITE.y0 + SITE.y1) / 2];
    for (let k = 0; k < 2600; k++) {
      const x = 2 + Math.floor(d() * (w - 4));
      const y = 2 + Math.floor(d() * (h - 4));
      const near = Math.exp(-((Math.hypot(x - siteC[0], y - siteC[1]) / 70) ** 2));
      if (d() > 0.18 + 0.8 * near) continue;
      if (Math.hypot(x - HEALTHY[0], y - HEALTHY[1]) < 14) continue;
      if (x >= SITE.x0 && x < SITE.x1 && y >= SITE.y0 && y < SITE.y1) continue;
      if (water[y * w + x] > 0 || nearestRiver(x, y).d < 4) continue;
      const roll = d();
      const mat = roll < 0.45 ? MAT.Rubble : roll < 0.75 ? MAT.Concrete : roll < 0.95 ? MAT.Rust : MAT.Brick;
      const sx = 1 + (d() < 0.35 ? 1 : 0);
      const sy = 1 + (d() < 0.35 ? 1 : 0);
      const hgt = mat === MAT.Rubble ? 1 + (d() < 0.3 ? 1 : 0) : 1;
      for (let yy = y; yy < y + sy; yy++)
        for (let xx = x; xx < x + sx; xx++) {
          const g = grid.top(xx, yy);
          if (grid.topMat(xx, yy) === MAT.Concrete) continue; // don't stack on the dam
          grid.push(xx, yy, g, g + hgt, mat);
        }
    }
  }

  // Landfill: heaps of waste with rusting drums
  {
    const d = rng(seed * 131 + 5);
    for (let y = LANDFILL[1] - 18; y <= LANDFILL[1] + 18; y++)
      for (let x = LANDFILL[0] - 18; x <= LANDFILL[0] + 18; x++) {
        const dl = Math.hypot(x - LANDFILL[0], y - LANDFILL[1]);
        const n = fbm(x / 6, y / 6, 2, seed + 41) * 0.5 + 0.5;
        const hgt = Math.round((1 - dl / 13) * 3.5 * n + (n > 0.55 ? 1 : 0));
        if (dl > 13 || hgt <= 0 || nearestRiver(x, y).d < 3) continue;
        const g = grid.top(x, y);
        grid.push(x, y, g, g + hgt, MAT.Trash);
        if (d() < 0.04) grid.push(x, y, g + hgt, g + hgt + 1, MAT.Rust);
      }
  }

  // Fields
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ds = Math.hypot(x - (SITE.x0 + SITE.x1) / 2, y - (SITE.y0 + SITE.y1) / 2);
      const dh = Math.hypot(x - HEALTHY[0], y - HEALTHY[1]);
      let c = 0.24 + fbm(x / 20, y / 20, 3, seed + 21) * 0.12;
      c += 1.3 * Math.exp(-((ds / 38) ** 2)) * (0.8 + 0.4 * hash2(x >> 2, y >> 2, 3));
      c *= smoothstep(6, 22, dh);
      c += 1.8 * smoothstep(16, 6, Math.hypot(x - LANDFILL[0], y - LANDFILL[1]));
      contam[i * 2] = Math.max(0, c);
      moisture[i] = 0.06 + 0.4 * smoothstep(18, 4, dh);
      const dp = Math.hypot(x - POND[0], y - POND[1]);
      if (dp < 7.5) {
        const g = grid.top(x, y);
        const lvl = padZ - 0.6;
        if (g < lvl) {
          water[i] = lvl - g;
          contam[i * 2 + 1] = water[i] * 2.5;
        }
      }
      if (dh < 9 && hash2(x, y, 77) > 0.35) vegetation[i] = 0.5 + (1 - dh / 9) * 2.6 * hash2(x, y, 78);
    }
  }

  const surface = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = grid.cols[i];
    surface[i] = c[c.length - 1].z1;
  }

  return {
    grid,
    water,
    contam,
    moisture,
    vegetation,
    waterSource,
    surface,
    poi: {
      reservoir: RESERVOIR,
      dam: DAM,
      site: [(SITE.x0 + SITE.x1) / 2, (SITE.y0 + SITE.y1) / 2],
      healthy: HEALTHY,
      landfill: LANDFILL,
    },
  };
}

/** A partially collapsed multi-storey concrete shell: walls with windows, floor slabs with holes. */
function buildRuin(
  grid: ColumnGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  floors: number,
  floorH: number,
  mat: number,
  r: () => number,
  decay: number,
) {
  const cells: [number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells.push([x, y]);
  const base = foundation(grid, cells, 3);
  const seed = Math.floor(r() * 1e6);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
      const pillar = (x - x0) % 6 === 0 && (y - y0) % 6 === 0;
      // ruin height varies smoothly: upper storeys gone in patches
      const ruin = (fbm(x / 7, y / 7, 2, seed) * 0.5 + 0.5) * decay * floors * 1.6;
      const keepFloors = Math.max(1, Math.min(floors, Math.round(floors - ruin)));
      const wallTop = base + keepFloors * floorH - (hash2(x, y, seed) < 0.3 ? 1 : 0);
      const along = x === x0 || x === x1 - 1 ? y - y0 : x - x0;
      let z = base;
      for (let f = 0; f < keepFloors; f++) {
        const fz = base + f * floorH;
        if (edge || pillar) {
          const window = edge && !pillar && along % 4 >= 1 && along % 4 <= 2 && f % 2 === (floors > 3 ? 1 : f % 2);
          if (window) {
            grid.push(x, y, Math.max(z, fz), fz + 1, mat);
            z = fz + 3;
            grid.push(x, y, z, Math.min(wallTop, fz + floorH), mat);
            z = Math.min(wallTop, fz + floorH);
          } else {
            grid.push(x, y, Math.max(z, fz), Math.min(wallTop, fz + floorH), mat);
            z = Math.min(wallTop, fz + floorH);
          }
        } else {
          // interior slab; holes where the floor has fallen through
          const hole = f > 0 && fbm(x / 4, y / 4, 2, seed + f) > 0.15 - decay * 0.3;
          if (!hole && fz >= z) {
            grid.push(x, y, fz, fz + 1, mat);
            z = fz + 1;
          }
        }
      }
      // roof slab where storeys survived intact
      if (!edge && !pillar && keepFloors === floors && fbm(x / 5, y / 5, 2, seed + 99) > -0.1 + decay * 0.4) {
        const rz = base + floors * floorH - 1;
        if (rz >= z) grid.push(x, y, rz, rz + 1, mat);
      }
    }
  }
}

function buildTank(grid: ColumnGrid, cx: number, cy: number, rad: number, height: number) {
  const cells: [number, number][] = [];
  for (let y = cy - rad - 1; y <= cy + rad + 1; y++)
    for (let x = cx - rad - 1; x <= cx + rad + 1; x++) if (Math.hypot(x - cx, y - cy) <= rad + 1.3) cells.push([x, y]);
  const base = foundation(grid, cells, 2);
  for (const [x, y] of cells) {
    const d = Math.hypot(x - cx, y - cy);
    if (d > rad + 0.3) continue;
    const dome = Math.round(Math.sqrt(Math.max(0, 1 - (d / (rad + 0.3)) ** 2)) * 2);
    grid.push(x, y, base, base + height + dome, MAT.Rust);
  }
}

/**
 * Seat a structure into varied ground: base = mean ground height over the
 * footprint; higher ground is excavated, and every footprint column gets a
 * concrete substructure from `depth` below the base (deeper on the downhill
 * side, where it shows as an exposed plinth/basement wall).
 */
function foundation(grid: ColumnGrid, cells: [number, number][], depth: number): number {
  let sum = 0;
  for (const [x, y] of cells) sum += grid.top(x, y);
  const base = Math.round(sum / cells.length);
  for (const [x, y] of cells) {
    grid.cut(x, y, base - depth);
    grid.push(x, y, grid.top(x, y), base, MAT.Concrete);
  }
  return base;
}
