// (round 128b, `playmodes`) The hero course's land: `?skipmenu=1&level=herocourse`. One loop through hills, a forest,
// a canyon in switchbacks, a cliff with a cave mouth, a river and a lake shore, ruins with steel and a small town
// (play/course/course.ts, pure). The course itself (heroes, play modes, the settings drawer) is play/course/herocourse.ts.

import { ColumnGrid, type WorldDims } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { cellAt, cellPos } from '../world/lattice';
import { labLayers } from '../play/lab/terrains';
import { areaStart, courseColumn } from '../play/course/course';

export function generateHeroCourse(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  const surface = new Float32Array(N);
  const vegetation = new Float32Array(N);
  const water = new Float32Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [wx, wy] = cellPos(x, y);
      const c = courseColumn(wx, wy);
      for (const iv of labLayers(c)) grid.push(x, y, iv.z0, iv.z1, iv.mat);
      surface[y * w + x] = grid.top(x, y);
      vegetation[y * w + x] = c.veg ?? 0;
      water[y * w + x] = c.water ?? 0;
    }
  const z = (n: number) => new Float32Array(n);
  const cell = (a: [number, number]): [number, number] => {
    const [cx, cy] = cellAt(a[0], a[1]);
    return [cx, cy];
  };
  const hills = cell(areaStart('hills').at);
  const river = cell(areaStart('river').at);
  return {
    grid,
    water,
    contam: z(N * 2),
    moisture: z(N).fill(0.35),
    vegetation,
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface,
    poi: { healthy: hills, dam: river, pool: river, tutorial: hills, heap: hills, rock: hills, river },
  };
}
