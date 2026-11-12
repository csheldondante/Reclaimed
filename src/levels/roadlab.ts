// The road lab (?level=roadlab; RD1, the user 2026-11-12): a plain and a terrace behind a sheer rock step, its land
// from roadlab/ladder.ts landZ (soil over stone, grass on it), for the grade ladder's roads to climb. The roads, their
// cut and fill and the placeholder structures are roadlab/control.ts's, laid on the GPU once the level is up.

import { ColumnGrid, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import type { MapData } from '../world/mapgen';
import { cellPos } from '../world/lattice';
import { landZ } from '../roadlab/ladder';

export function generateRoadlab(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  const surface = new Float32Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [wx, wy] = cellPos(x, y);
      const top = landZ(wx, wy);
      grid.push(x, y, 0, top - 1.5, MAT.Stone);
      grid.push(x, y, top - 1.5, top, MAT.Soil);
      surface[y * w + x] = top;
    }
  const z = (n: number) => new Float32Array(n);
  const mid: [number, number] = [Math.round(w / 2), Math.round(h / 2)];
  return {
    grid,
    water: z(N),
    contam: z(N * 2),
    moisture: z(N).fill(0.3),
    vegetation: z(N).fill(1.6),
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface,
    poi: { healthy: mid, dam: mid, pool: mid, tutorial: mid, heap: mid },
  };
}
