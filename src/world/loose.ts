// Loose ground lives in the layers (round 22, branch strata): the soft
// ground a map lays (soil, sand, ash, silt cells) is simply granular
// intervals, and the loose stacks a map may carry besides (map.drift with
// driftTop/driftMat/strata — saved maps from before, dust a generator
// scatters) are added on top of each column as intervals of their
// materials, with fractional heights. (Rounds 16–21 kept them in a separate
// four-layer texture stack; the seam between the two was where the bugs were.)

import type { MapData } from './mapgen';
import { MAT } from './materials';

export function looseIntoGrid(map: MapData): void {
  const { grid } = map;
  const N = grid.cols.length;
  for (let i = 0; i < N; i++) {
    const total = map.drift[i];
    if (!(total > 0.001)) continue;
    // the stack, bottom first: the layers beneath the top, then the top
    const stack: { d: number; m: number }[] = [];
    let below = 0;
    if (map.driftTop && map.strata) {
      for (let k = 0; k < 3; k++) {
        const v = map.strata[i * 4 + k];
        if (v > 0) {
          const m = Math.floor(v / 1000);
          stack.push({ d: v - m * 1000, m });
          below += v - m * 1000;
        }
      }
    }
    stack.push({ d: Math.max(0, total - below), m: map.driftMat?.[i] || MAT.Drift });
    const col = grid.col(i % grid.dims.w, Math.floor(i / grid.dims.w));
    let z = col.length ? col[col.length - 1].z1 : 0;
    for (const l of stack) {
      if (l.d <= 0.001) continue;
      const last = col[col.length - 1];
      if (last && last.mat === l.m && last.z1 === z) last.z1 = z + l.d;
      else col.push({ z0: z, z1: z + l.d, mat: l.m });
      z += l.d;
    }
  }
  map.drift = new Float32Array(N);
  map.driftTop = undefined;
  map.driftMat = undefined;
  map.strata = undefined;
}
