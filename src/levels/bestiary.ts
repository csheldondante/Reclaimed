// The bestiary (round 117, inhabitants): rolling grass hills, a rocky rise and a pond — ground to watch creatures
// walk on (`?skipmenu=1&level=bestiary&life=viewer`, the viewer's page; `&life=1` the wilderness scene). Slopes for
// the feet to plant on, a ledge to turn at, water to keep out of.

import { ColumnGrid, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import type { MapData } from '../world/mapgen';
import { cellPos } from '../world/lattice';

const BASE = 10;

/** a smooth value noise 0..1 (deterministic) */
function vnoise(x: number, y: number, seed: number): number {
  const h = (i: number, j: number) => {
    let n = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 982451653)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(i, j) + (h(i + 1, j) - h(i, j)) * sx;
  const b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * sx;
  return a + (b - a) * sy;
}

export function generateBestiary(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  const water = new Float32Array(N);
  const surface = new Float32Array(N);
  const veg = new Float32Array(N);
  const [mx, my] = [w * 0.5, h * 0.433];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [px, py] = cellPos(x, y);
      let z = BASE + 5 * vnoise(px / 28, py / 28, 3) + 2 * vnoise(px / 9, py / 9, 5);
      // a rocky rise north-east of the middle, a ledge on its side
      const dr = Math.hypot(px - mx - 26, py - my + 22);
      const rise = Math.max(0, 1 - dr / 18);
      z += rise * rise * 10 + (dr < 9 ? 2 : 0);
      // a pond south-west
      const dp = Math.hypot(px - mx + 24, py - my - 18);
      const bowl = Math.max(0, 1 - dp / 10);
      z -= bowl * 4;
      const zi = Math.max(3, Math.round(z * 2) / 2);
      const rock = rise > 0.35;
      grid.push(x, y, 0, zi - 2, MAT.Stone);
      grid.push(x, y, zi - 2, zi, rock ? MAT.Stone : MAT.Soil);
      surface[y * w + x] = zi;
      if (dp < 9) water[y * w + x] = Math.max(0, BASE + 3.2 - zi);
      // (grass mostly — the creatures must be seen; a copse here and there to walk round)
      const copse = vnoise(px / 14, py / 14, 9);
      veg[y * w + x] = rock ? 0 : copse > 0.78 ? 4 : copse > 0.6 ? 2 : 1;
    }
  const z = (n: number) => new Float32Array(n);
  const mid: [number, number] = [w / 2, h / 2];
  return {
    grid,
    water,
    contam: z(N * 2),
    moisture: z(N).fill(0.5),
    vegetation: veg,
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface,
    poi: { healthy: mid, dam: mid, pool: mid, tutorial: mid, heap: mid },
  };
}
