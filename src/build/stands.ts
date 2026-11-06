// Where a builder stands to work on a cell (round 128f; round 128p: from build/sitereach.ts, the GPU reach gone): a
// little out from the middle of each side that opens on ground a walker stands on — free, a yard (walked across), a
// block's passage (an arch through it). Pure.
import type { TownPlan } from './plan';
import type { QuadGrid } from './quadgrid';
import { DOOR_STEP } from './edgenet';

/** whether a cell is ground a walker stands on outside a structure: free, a yard, a block's passage */
export function openCell(plan: TownPlan, c: number): boolean {
  if (c < 0) return false;
  const t = plan.typeAt(c);
  if (!t) return true;
  const f = plan.defs[t].form;
  return f === 'yard' || (f === 'block' && !!plan.passage[c]);
}

/**
 * A cell's stands (box frame): the middles of its open sides, a little out; and (round 128p) of each side a path is
 * drawn on though a block stands beyond it — the lane between them is ground (solid.ts leaves the inset open), the stand
 * DOOR_STEP out on it. `also`: a cell about to be planned.
 */
export function standsOfCell(plan: TownPlan, grid: QuadGrid, built: (c: number) => boolean, cell: number, also = -1): [number, number][] {
  const [cx, cy] = grid.centre(cell);
  const sides = plan.layout.roads?.sides;
  const out: [number, number][] = [];
  for (let e = 0; e < 4; e++) {
    const n = grid.nbr[cell * 4 + e];
    if (n < 0 || n === also) continue;
    const blocked = (plan.has(n, 0) || built(n)) && !openCell(plan, n);
    const lane = !!sides?.[cell * 4 + e];
    if (blocked && !lane) continue;
    const step = blocked ? DOOR_STEP : 1.4;
    const [ax, ay] = grid.corner(cell, e);
    const [bx, by] = grid.corner(cell, e + 1);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const d = Math.hypot(mx - cx, my - cy) || 1;
    out.push([mx + ((mx - cx) / d) * step, my + ((my - cy) / d) * step]);
  }
  return out;
}
