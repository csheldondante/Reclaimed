// Soft ground is loose (round 16, BACKLOG I1): "soft materials like dirt and
// dust and ash should be smooth and not have step drops; only stone or
// concrete or solid things should have steps". When a world is made, the soft
// cells on top of every column (soil, sand, ash, silt) become a stack of loose
// layers (drift.wgsl) on the solid ground beneath, together with whatever
// loose layer the map already laid on top. Up to four layers per column (the
// deepest merge if there are more).

import type { MapData } from './mapgen';
import { MAT } from './materials';

const SOFT = new Set<number>([MAT.Soil, MAT.Sand, MAT.Ash, MAT.Silt]);
const MAX_LAYERS = 4;

export function looseFromGrid(map: MapData): void {
  const { grid } = map;
  const N = grid.cols.length;
  const driftMat = map.driftMat ?? new Float32Array(N);
  const driftTop = map.driftTop ?? new Float32Array(N);
  const strata = map.strata ?? new Float32Array(N * 4);
  const hadTop = !!map.driftTop;
  for (let i = 0; i < N; i++) {
    const col = grid.cols[i];
    // soft cells off the top (always keep the bottom cell)
    const popped: { d: number; m: number }[] = [];
    while (col.length > 1 || (col.length === 1 && col[0].z1 > 1)) {
      const top = col[col.length - 1];
      if (!SOFT.has(top.mat)) break;
      if (col.length === 1) {
        popped.push({ d: top.z1 - 1, m: top.mat });
        top.z1 = 1;
        break;
      }
      popped.push({ d: top.z1 - top.z0, m: top.mat });
      col.pop();
    }
    if (!popped.length) {
      // loose ground on something solid (dust on concrete): one layer
      if (!hadTop) driftTop[i] = map.drift[i];
      continue;
    }
    // bottom first, then any loose ground the map already put on top
    const stack = popped.reverse();
    // (a map that set a stack already: keep its layers above; otherwise its
    // drift is one layer of its material)
    if (map.drift[i] > 0) {
      if (hadTop && map.strata) {
        for (let k = 0; k < 3; k++) {
          const v = map.strata[i * 4 + k];
          if (v > 0) {
            const m = Math.floor(v / 1000);
            stack.push({ d: v - m * 1000, m });
          }
        }
        stack.push({ d: driftTop[i], m: driftMat[i] || MAT.Drift });
      } else stack.push({ d: map.drift[i], m: driftMat[i] || MAT.Drift });
    }
    // merge neighbours of the same material; too many → the deepest merge
    const merged: { d: number; m: number }[] = [];
    for (const l of stack) {
      if (l.d <= 0) continue;
      const last = merged[merged.length - 1];
      if (last && last.m === l.m) last.d += l.d;
      else merged.push({ ...l });
    }
    while (merged.length > MAX_LAYERS) {
      merged[1].d += merged[0].d;
      merged.shift();
    }
    const top = merged[merged.length - 1];
    let total = 0;
    for (const l of merged) total += l.d;
    map.drift[i] = total;
    driftTop[i] = top.d;
    driftMat[i] = top.m;
    for (let k = 0; k < 4; k++) strata[i * 4 + k] = 0;
    merged.slice(0, -1).forEach((l, k) => (strata[i * 4 + k] = l.m * 1000 + Math.min(l.d, 999)));
    map.surface[i] = col[col.length - 1].z1 + total;
  }
  map.driftMat = driftMat;
  map.driftTop = driftTop;
  map.strata = strata;
}
