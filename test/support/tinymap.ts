// A tiny world's map for tests (docs/TESTING.md): W × H columns (whole chunks), every per-column array the level's
// maps carry, all zero; the columns as `col(x, y)` says (default: bare stone to z 10).
import { CHUNK, ColumnGrid, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import type { MapData } from '../../src/world/mapgen';

export function tinyMap(w: number, h: number, zMax = 32, col: (x: number, y: number) => Interval[] = () => [{ z0: 0, z1: 10, mat: MAT.Stone }]): MapData {
  if (w % CHUNK || h % CHUNK) throw new Error(`tinyMap: ${w}×${h} isn't whole chunks of ${CHUNK}`);
  const n = w * h;
  const grid = new ColumnGrid({ w, h, zMax });
  const surface = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = col(x, y).map((iv) => ({ ...iv }));
      grid.cols[y * w + x] = c;
      surface[y * w + x] = c.length ? c[c.length - 1].z1 : 0;
    }
  return {
    grid,
    water: new Float32Array(n),
    contam: new Float32Array(n * 2),
    moisture: new Float32Array(n),
    vegetation: new Float32Array(n),
    oil: new Float32Array(n),
    drift: new Float32Array(n),
    oilStored: new Float32Array(n * 2),
    waterSource: new Float32Array(n),
    surface,
    poi: { healthy: [w >> 1, h >> 1] },
  };
}
