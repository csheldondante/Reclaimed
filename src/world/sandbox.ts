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
    return Math.round(z);
  };

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const top = height(x, y);
      grid.push(x, y, 0, top - 3, MAT.Stone);
      // broad sand and soil patches (round 13: small ones made the land busy)
      const sandy = fbm(x / 55, y / 55, 2, 3) > 0.2;
      grid.push(x, y, top - 3, top, sandy ? MAT.Sand : MAT.Soil);
      moisture[i] = 0.25;
      contam[i * 2] = 0.05;
      // a few dunes in one corner
      const dune = fbm(x / 10, y / 7, 2, 11) * 0.5 + 0.5;
      if (x > w * 0.6 && y < h * 0.45) drift[i] = Math.max(0, (dune - 0.45) * 5);
    }

  // the pond
  for (let y = POND[1] - 16; y <= POND[1] + 16; y++)
    for (let x = POND[0] - 16; x <= POND[0] + 16; x++) {
      const i = y * w + x;
      const g = grid.top(x, y);
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
    surface,
    poi: { healthy: GREEN, dam: POND, site: RUIN, landfill: HEAP, reservoir: POND, tutorial: GREEN, heap: HEAP },
  };
}
