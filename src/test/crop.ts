// (round 112, testspeed) A map's rectangle as a map of its own: a contract test's tiny world cut from a level's.
// Whole chunks and an even first row (the lattice's offset rows keep their parity: a cell's world position is the
// same less the corner's). Per-column arrays of any stride are cut alike; a river graph has no meaning cut and is left out.

import { CHUNK, ColumnGrid } from '../world/layout';
import type { MapData } from '../world/mapgen';

export function cropMap(src: MapData, x0: number, y0: number, w: number, h: number): MapData {
  const { w: SW, h: SH, zMax } = src.grid.dims;
  if ([x0, y0, w, h].some((v) => v % CHUNK !== 0)) throw new Error(`cropMap: ${x0},${y0} ${w}×${h} isn't whole chunks`);
  if (x0 < 0 || y0 < 0 || x0 + w > SW || y0 + h > SH) throw new Error(`cropMap: ${x0},${y0} ${w}×${h} is outside the ${SW}×${SH} map`);
  const N = SW * SH;
  const grid = new ColumnGrid({ w, h, zMax });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid.cols[y * w + x] = src.grid.col(x0 + x, y0 + y).map((iv) => ({ ...iv }));
  const cut = <T extends Float32Array | Uint8Array>(a: T | undefined): T | undefined => {
    if (!a) return undefined;
    const stride = a.length / N;
    if (!Number.isInteger(stride)) throw new Error(`cropMap: an array of ${a.length} over ${N} columns`);
    const out = new (a.constructor as new (n: number) => T)(w * h * stride);
    for (let y = 0; y < h; y++) out.set(a.subarray(((y0 + y) * SW + x0) * stride, ((y0 + y) * SW + x0 + w) * stride), y * w * stride);
    return out;
  };
  const poi: Record<string, [number, number]> = {};
  for (const [k, [px, py]] of Object.entries(src.poi)) poi[k] = [Math.max(0, Math.min(w - 1, px - x0)), Math.max(0, Math.min(h - 1, py - y0))];
  if (!poi.healthy) poi.healthy = [w >> 1, h >> 1];
  return {
    grid,
    water: cut(src.water)!,
    contam: cut(src.contam)!,
    moisture: cut(src.moisture)!,
    vegetation: cut(src.vegetation)!,
    oil: cut(src.oil)!,
    drift: cut(src.drift)!,
    driftMat: cut(src.driftMat),
    driftTop: cut(src.driftTop),
    strata: cut(src.strata),
    oilStored: cut(src.oilStored)!,
    waterSource: cut(src.waterSource)!,
    lava: cut(src.lava),
    lavaSpring: cut(src.lavaSpring),
    riverFlow: cut(src.riverFlow),
    structural: cut(src.structural),
    surface: cut(src.surface)!,
    poi,
  };
}
