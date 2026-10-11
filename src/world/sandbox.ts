// The sandbox map (BACKLOG B2): open rolling ground with a little of
// everything to play with — a pond, a ruin, a trash heap, an oil pool, a
// poisoned patch, dunes, a green patch — and room to build. The editor
// (ui/editor.ts) does the rest.

import { ColumnGrid, type WorldDims } from './layout';
import { MAT } from './materials';
import type { MapData } from './mapgen';
import { fbm, hash2, smoothstep } from './noise';

type P = [number, number];

export function generateSandbox(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  const water = new Float32Array(N);
  const contam = new Float32Array(N * 2);
  const moisture = new Float32Array(N);
  const vegetation = new Float32Array(N);
  const oil = new Float32Array(N);
  const drift = new Float32Array(N);
  const c: P = [w / 2, h / 2];
  const POND: P = [c[0] - 40, c[1] - 30];
  const RUIN: P = [c[0] + 35, c[1] - 35];
  const HEAP: P = [c[0] + 30, c[1] + 30];
  const OILP: P = [c[0] - 30, c[1] + 35];
  const GREEN: P = [c[0] - 5, c[1] + 5];
  const POISON: P = [c[0] + 50, c[1] + 5];

  const height = (x: number, y: number) => {
    let z = 12 + fbm(x / 40, y / 40, 3, 7) * 5;
    z -= 4 * smoothstep(14, 4, Math.hypot(x - POND[0], y - POND[1]));
    z -= 1.5 * smoothstep(9, 3, Math.hypot(x - OILP[0], y - OILP[1]));
    return z;
  };
  // the loose layer (round 15, H3): sand and dirt lie loose on top, so the
  // surface keeps its real height; the ground below is whole cells
  const driftMat = new Float32Array(N);

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hf = height(x, y);
      const top = Math.floor(hf - 0.5);
      grid.push(x, y, 0, top - 3, MAT.Stone);
      // broad sand and soil patches (round 13: small ones made the land busy)
      const sandy = fbm(x / 55, y / 55, 2, 3) > 0.2;
      grid.push(x, y, top - 3, top, sandy ? MAT.Sand : MAT.Soil);
      drift[i] = hf - top;
      driftMat[i] = sandy ? MAT.Sand : MAT.Soil;
      moisture[i] = 0.25;
      contam[i * 2] = 0.05;
      // a few dust dunes in one corner
      const dune = fbm(x / 10, y / 7, 2, 11) * 0.5 + 0.5;
      if (x > w * 0.6 && y < h * 0.45 && dune > 0.45) {
        drift[i] += (dune - 0.45) * 5;
        driftMat[i] = 0;
      }
    }

  // the pond
  for (let y = POND[1] - 16; y <= POND[1] + 16; y++)
    for (let x = POND[0] - 16; x <= POND[0] + 16; x++) {
      const i = y * w + x;
      const g = grid.top(x, y) + drift[i];
      const lvl = 10.5;
      if (g < lvl) water[i] = lvl - g;
    }
  // a ruined concrete building
  for (let y = RUIN[1] - 6; y <= RUIN[1] + 6; y++)
    for (let x = RUIN[0] - 8; x <= RUIN[0] + 8; x++) {
      const edge = Math.abs(x - RUIN[0]) === 8 || Math.abs(y - RUIN[1]) === 6;
      if (!edge || hash2(x, y, 9) < 0.15) continue;
      const g = grid.top(x, y);
      grid.push(x, y, g, g + 4 + Math.floor(hash2(x, y, 4) * 4), MAT.Concrete);
    }
  // a trash heap
  for (let y = HEAP[1] - 6; y <= HEAP[1] + 6; y++)
    for (let x = HEAP[0] - 6; x <= HEAP[0] + 6; x++) {
      const d = Math.hypot(x - HEAP[0], y - HEAP[1]) / 6;
      const hgt = Math.round((1 - d) * 4);
      if (hgt <= 0) continue;
      const g = grid.top(x, y);
      grid.push(x, y, g, g + hgt, MAT.Trash);
      contam[(y * w + x) * 2] = 1.2;
    }
  // an oil pool
  for (let y = OILP[1] - 7; y <= OILP[1] + 7; y++)
    for (let x = OILP[0] - 7; x <= OILP[0] + 7; x++) if (Math.hypot(x - OILP[0], y - OILP[1]) < 5) oil[y * w + x] = 0.6;
  // poisoned ground, scattered litter around it
  for (let y = POISON[1] - 12; y <= POISON[1] + 12; y++)
    for (let x = POISON[0] - 12; x <= POISON[0] + 12; x++) {
      const d = Math.hypot(x - POISON[0], y - POISON[1]);
      if (d > 12) continue;
      contam[(y * w + x) * 2] = 1.4 * smoothstep(12, 4, d);
      if (hash2(x, y, 21) > 0.6) grid.push(x, y, grid.top(x, y), grid.top(x, y) + 1, MAT.Litter);
    }
  // a green patch
  for (let y = GREEN[1] - 8; y <= GREEN[1] + 8; y++)
    for (let x = GREEN[0] - 8; x <= GREEN[0] + 8; x++) {
      const d = Math.hypot(x - GREEN[0], y - GREEN[1]);
      if (d > 8) continue;
      vegetation[y * w + x] = 1.5 + 2.5 * smoothstep(8, 0, d) * hash2(x, y, 6);
      moisture[y * w + x] = 0.45;
    }

  // the physics garden (round 14, F7/G5): things to break with 💥 and watch
  // fall — a tall tower, a brick chimney, a diving-board overhang and a
  // bridge on two pillars. Each stands on a stone plinth levelled to the
  // highest ground under it.
  const plinth = (x0: number, y0: number, w: number, d: number): number => {
    let top = 0;
    for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) top = Math.max(top, grid.top(x, y));
    for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) if (grid.top(x, y) < top) grid.push(x, y, grid.top(x, y), top, MAT.Stone);
    return top;
  };
  const block = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat: number) => {
    for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) grid.push(x, y, Math.max(z0, grid.top(x, y)), z0 + h, mat);
  };
  const GX = 56;
  const GY = 196;
  {
    // a tall thin tower: break its base and it topples
    const b = plinth(GX, GY, 5, 5);
    block(GX + 1, GY + 1, b, 3, 3, 24, MAT.Concrete);
    // a brick chimney
    const c = plinth(GX + 10, GY, 6, 6);
    block(GX + 11, GY + 1, c, 4, 4, 18, MAT.Brick);
    // a diving board: a pillar with a slab reaching out over the sand
    const p = plinth(GX + 20, GY, 4, 4);
    block(GX + 20, GY, p, 4, 4, 9, MAT.Concrete);
    block(GX + 24, GY + 1, p + 8, 6, 2, 1, MAT.Concrete);
    // a bridge: two pillars and a deck; break a pillar and the deck snaps
    const q = plinth(GX + 34, GY, 16, 4);
    block(GX + 34, GY, q, 3, 4, 7, MAT.Brick);
    block(GX + 47, GY, q, 3, 4, 7, MAT.Brick);
    block(GX + 34, GY, q + 7, 16, 4, 2, MAT.Concrete);
  }
  // a concrete basin full of sand (round 23): break a wall and the sand
  // should pour out of the gap down to its angle of repose
  const BX = GX - 16;
  const BY = GY + 10;
  const basin: number[] = [];
  {
    const S = 12;
    const b = plinth(BX, BY, S, S);
    block(BX, BY, b, S, S, 1, MAT.Concrete);
    for (let y = BY; y < BY + S; y++)
      for (let x = BX; x < BX + S; x++) {
        const wall = x === BX || y === BY || x === BX + S - 1 || y === BY + S - 1;
        grid.push(x, y, b + 1, b + 7, wall ? MAT.Concrete : MAT.Sand);
        if (!wall) basin.push(y * w + x);
      }
  }

  // where something stands on the ground (ruin, heap, litter, plinths), no
  // loose layer over it
  for (let i = 0; i < N; i++) {
    const col = grid.cols[i];
    const m = col[col.length - 1].mat;
    if (m !== MAT.Sand && m !== MAT.Soil) {
      drift[i] = 0;
      driftMat[i] = 0;
    }
  }
  for (const i of basin) drift[i] = 0;

  const surface = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const col = grid.cols[i];
    surface[i] = col[col.length - 1].z1;
  }
  return {
    grid,
    water,
    contam,
    moisture,
    vegetation,
    waterSource: new Float32Array(N),
    oil,
    oilStored: new Float32Array(N * 2),
    drift,
    driftMat,
    surface,
    poi: { garden: [GX + 25, GY + 2], healthy: GREEN, dam: POND, site: RUIN, landfill: HEAP, reservoir: POND, tutorial: GREEN, heap: HEAP },
  };
}
