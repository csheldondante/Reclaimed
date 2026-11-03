// ---- play/lab/labworld.ts ---------------------------------------------------------------------------------------
// (round 121, herolab) The lab's land as the camera and a hero see it, in Node: the columns from terrains.ts at each
// hex cell (as the level builds them), the trees the draw would lay out on its succession field (api/plants.ts
// planTree — the same hash and thresholds as vegplan.wgsl). For the metrics and the tests; the browser asks the live
// world (play/camera/apply.ts).

import type { Prop, SightWorld } from '../../api/contracts/camera';
import { planTree } from '../../api/plants';
import { cellAt, cellPos, ROW_H } from '../../world/lattice';
import { BUILT, treeProps } from '../camera/props';
import { materialName } from '../../api/common';
import { labColumn, labLayers } from './terrains';

const W = 256;
const H = 256;

export function labSight(): SightWorld & { floor(x: number, y: number): number } {
  const cols = new Map<number, { z0: number; z1: number }[]>();
  const colAt = (cx: number, cy: number) => {
    const k = cy * W + cx;
    let c = cols.get(k);
    if (!c) {
      const [wx, wy] = cellPos(cx, cy);
      c = labLayers(labColumn(wx, wy));
      cols.set(k, c);
    }
    return c;
  };
  // (every tree once, in 8-cell buckets: a ray asks for those near it)
  let buckets: Map<number, Prop[]> | null = null;
  const B = 8;
  const bucketsOf = () => {
    if (buckets) return buckets;
    buckets = new Map();
    for (let cy = 2; cy < H - 3; cy++)
      for (let cx = 2; cx < W - 3; cx++) {
        const [wx, wy] = cellPos(cx, cy);
        const veg = labColumn(wx, wy).veg ?? 0;
        if (veg < 3.6) continue;
        const tr = planTree(cx, cy, veg, W, H, [0, 0]);
        if (!tr) continue;
        const c = colAt(cx, cy);
        const k = Math.floor(wy / B) * 1024 + Math.floor(wx / B);
        const list = buckets.get(k) ?? [];
        list.push(...treeProps(tr, c[c.length - 1].z1));
        buckets.set(k, list);
      }
    return buckets;
  };
  const top = (x: number, y: number) => {
    const [cx, cy] = cellAt(x, y);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return 0;
    const c = colAt(cx, cy);
    // (the sky floor: the top of what's highest)
    return c[c.length - 1].z1;
  };
  return {
    solid: (x, y) => {
      const [cx, cy] = cellAt(x, y);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
      return colAt(cx, cy);
    },
    top,
    floor: top,
    built: (x, y) => BUILT.has(materialName(labColumn(x, y).skin)),
    props: (x, y, r) => {
      const out: Prop[] = [];
      const b = bucketsOf();
      for (let by = Math.floor((y - r) / B); by <= Math.floor((y + r) / B); by++)
        for (let bx = Math.floor((x - r) / B); bx <= Math.floor((x + r) / B); bx++) {
          const l = b.get(by * 1024 + bx);
          if (l) for (const p of l) out.push(p);
        }
      return out;
    },
    ceiling: 96,
    bounds: [W, H * ROW_H],
  };
}
