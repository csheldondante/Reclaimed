// Plan → columns: what the sims see of a city (contracts/structures.ts ColumnSpan): per hex column under a building
// or a rampart, one solid span — its foot to its roof's middle. These become External intervals (sim/external.ts):
// water runs round them and off their tops, sand piles on them, the rock judge counts them, the terrain's draws skip
// them because the pieces draw the building. Why solid and one a column: the sims need "is it solid here", not rooms;
// one span a column is what the External registry holds an instance to. Converted only here, at the boundary.
import type { CityPlan, ColumnSpan, V2 } from '../api/contracts/structures';
import { cellAt, cellPos, ROW_H } from '../world/lattice';
import { quadCorners } from './tiles/builder';

function inside(p: V2[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function columnsOf(plan: CityPlan): ColumnSpan[] {
  const t = plan.tiles;
  // per quad its solid range
  const lo = new Float64Array(t.use.length).fill(Infinity);
  const hi = new Float64Array(t.use.length).fill(-Infinity);
  const bld = new Int32Array(t.use.length).fill(-1);
  for (const s of plan.spans) {
    lo[s.quad] = Math.min(lo[s.quad], s.z0);
    hi[s.quad] = Math.max(hi[s.quad], s.z1);
    bld[s.quad] = s.building;
  }
  // (the solid stops a metre under the walls' tops, inside the top storey: what grows or lands on an External top —
  // moss, tufts, snow — stays hidden in the house instead of poking through its roof)
  for (const b of plan.buildings) for (const q of b.quads) hi[q] -= 1;
  const out: ColumnSpan[] = [];
  const seen = new Set<string>();
  for (let q = 0; q < t.use.length; q++) {
    if (!isFinite(lo[q])) continue;
    const p = quadCorners(t, q);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of p) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const [, r0] = cellAt(x0, y0);
    const [, r1] = cellAt(x1, y1);
    for (let r = r0 - 1; r <= r1 + 1; r++) {
      const [c0] = cellAt(x0, (r + 0.5) * ROW_H);
      const [c1] = cellAt(x1, (r + 0.5) * ROW_H);
      for (let c = c0 - 1; c <= c1 + 1; c++) {
        const [wx, wy] = cellPos(c, r);
        if (!inside(p, wx, wy)) continue;
        const k = `${c},${r}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ x: c, y: r, z0: lo[q], z1: hi[q], building: bld[q] });
      }
    }
  }
  return out;
}
