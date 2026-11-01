// (round 121, herolab; BACKLOG HL1, CAM1) The hero lab's land: `?skipmenu=1&level=herolab`. Six test terrains one tap
// apart (play/lab/terrains.ts, pure — the Node metrics ride the same columns): the foot of a tall cliff with a turn
// that leads on and a notch that's a dead end, a canyon, a dense forest, a city street, a cave mouth and open hills.
// The lab itself (heroes, camera modes, the autopilot, the stations) is play/lab/herolab.ts, loaded by the level.

import { ColumnGrid, type WorldDims } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { cellPos } from '../world/lattice';
import { LAB_TERRAINS, labColumn, labLayers } from '../play/lab/terrains';

export function generateHeroLab(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  const surface = new Float32Array(N);
  const vegetation = new Float32Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [wx, wy] = cellPos(x, y);
      const c = labColumn(wx, wy);
      for (const iv of labLayers(c)) grid.push(x, y, iv.z0, iv.z1, iv.mat);
      surface[y * w + x] = grid.top(x, y);
      vegetation[y * w + x] = c.veg ?? 0;
    }
  const z = (n: number) => new Float32Array(n);
  const mid = (i: number): [number, number] => {
    const r = LAB_TERRAINS[i].rect;
    return [Math.floor((r[0] + r[2]) / 2), Math.floor((r[1] + r[3]) / 2 / 0.866)];
  };
  return {
    grid,
    water: z(N),
    contam: z(N * 2),
    moisture: z(N).fill(0.35),
    vegetation,
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface,
    poi: { healthy: mid(5), dam: mid(0), pool: mid(0), tutorial: mid(0), heap: mid(0), rock: mid(0), river: mid(5) },
  };
}
