// The noise lab level (round 111, BACKLOG TG1; the user: "an experimental sandbox I can use to review new interesting
// noise combos or noise generators would be fun"): `?skipmenu=1&level=noiselab`, or "Noise lab" on the title screen.
// It opens on flat ground; the lab (noiselab/control.ts) runs its recipe on the GPU and writes the land the moment
// the level is up, and again at each change. A sandbox: the editor's tools and the weather work on what it makes
// (a flash flood down a mesa's ravines). It never touches the atlas's generation (src/atlas is unchanged).

import { ColumnGrid, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import type { MapData } from '../world/mapgen';

/** the ground the level opens on, before the lab's first recipe is written over it */
const BASE = 8;

export function generateNoiselab(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      grid.push(x, y, 0, BASE - 2, MAT.Stone);
      grid.push(x, y, BASE - 2, BASE, MAT.Soil);
    }
  const z = (n: number) => new Float32Array(n);
  const mid: [number, number] = [w / 2, h / 2];
  return {
    grid,
    water: z(N),
    contam: z(N * 2),
    moisture: z(N).fill(0.3),
    vegetation: z(N),
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface: z(N).fill(BASE),
    poi: { healthy: mid, dam: mid, pool: mid, tutorial: mid, heap: mid },
  };
}
