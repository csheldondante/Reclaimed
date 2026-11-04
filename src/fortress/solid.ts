// What of the fortress is solid to the world (round 128d; the user: "Does the flow field around the city path around
// structures?"). The fortress is drawn as pieces (pieces.ts), not column matter, so until now nothing of it was in the
// columns: the agents' surfaces, the water and the falling ground went through its walls. Its built blocks are claimed
// as External intervals (sim/external.ts, as the settlements' buildings are: settle/view.ts) — these are the spans:
//  - a block (houses, the warehouse, …) and the keep: the cell's own columns (TownGrid.columns), from under its floor
//    to a metre under its top (what grows or lands on it stays hidden in it, as the towns');
//  - a wall: the thin wall as drawn, not the cell — the band from the cell's middle to each side that meets a wall or
//    the keep, WALL_HALF either side, and the middle square; a gate's cell only its lintel (the passage open under it);
//    a wall's lowest level up off the ground (a bridge) from that level's floor. The rest of a wall cell is open ground;
//  - a yard (farms, the quarry): nothing.
// Only what's built: a planned block is no obstacle. Per structure, in the box's frame (box columns and rows; z the
// Town's — the window's).
import type { ColumnSpan, V2 } from '../api/contracts/structures';
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import { LEVEL_H, type Town } from '../build/town';
import type { TownGrid } from '../build/towngrid';
import { raster } from '../structures/columns';
import { DEFS } from './defs';
import type { FortressPlan } from './plan';

/** a thin wall's half width (pieces.ts WALL_HALF) and a gate's lintel (pieces.ts WALL_LINTEL) */
export const WALL_HALF = 1.1;
export const WALL_LINTEL = 1.6;
/** how far under its floor a block's solid starts (into the ground: the registry claims only what's free) */
const FOOT = 0.6;
/** how far under its top a block's solid stops (a roof's moss or snow stays inside it — structures/columns.ts) */
const UNDER_TOP = 1;

export interface SolidInputs {
  plan: FortressPlan;
  town: Town;
  grid: TownGrid;
  /**
   * the ground's top at a box column: a block's foot goes down to it (a cell's floor is its highest column's ground —
   * Town.base — so on a slope the lower columns' solid would stop short of the ground, a gap a unit walks under)
   */
  ground(col: number): number;
  defs?: Record<StructureType, StructureDef>;
}

/** a cell's built levels as runs [lo, hi] (inclusive), lowest first */
function builtRuns(town: Town, c: number): [number, number][] {
  const out: [number, number][] = [];
  for (const L of [...town.built.each(c)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === L - 1) last[1] = L;
    else out.push([L, L]);
  }
  return out;
}

/** a band from a to b, h either side (pieces.ts band) */
function band(a: V2, b: V2, h: number): V2[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * h;
  const ny = (dx / l) * h;
  return [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
}

function square(x: number, y: number, h: number): V2[] {
  return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
}

/** The built fortress's solid spans, per structure id (box columns x, rows y; Town z). */
export function solidSpans(inp: SolidInputs): Map<number, ColumnSpan[]> {
  const defs = inp.defs ?? DEFS;
  const { plan, town, grid } = inp;
  const out = new Map<number, ColumnSpan[]>();
  for (const s of plan.structures()) {
    const def = defs[s.type];
    if (def.form === 'yard') continue;
    const spans: ColumnSpan[] = [];
    for (const c of s.cells.keys()) {
      const runs = builtRuns(town, c);
      if (!runs.length) continue;
      if (def.form !== 'wall') {
        // a block or the keep: the cell's columns
        for (const [lo, hi] of runs) {
          const z1 = town.floorZ(c, hi) + LEVEL_H - UNDER_TOP;
          for (const col of grid.columns[c]) {
            const z0 = lo === 0 ? Math.min(town.base[c], inp.ground(col)) - FOOT : town.floorZ(c, lo);
            spans.push({ x: col % grid.w, y: Math.floor(col / grid.w), z0, z1, building: s.id });
          }
        }
        continue;
      }
      // a wall: the band as drawn (pieces.ts), each run of built levels
      const [x, y] = grid.centre(c);
      const joined: V2[] = [];
      for (let e = 0; e < 4; e++) {
        const n = grid.nbr[c * 4 + e];
        const t = n >= 0 ? plan.typeAt(n) : null;
        if (t !== 'wall' && t !== 'fortress') continue;
        const a = grid.corner(c, e);
        const b = grid.corner(c, e + 1);
        joined.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
      const frames: V2[][] = joined.map((m) => band([x, y], m, WALL_HALF));
      const gate = plan.gate[c];
      if (!gate || !joined.length) frames.push(square(x, y, WALL_HALF));
      for (const [lo, hi] of runs) {
        const top = town.floorZ(c, hi) + LEVEL_H;
        const z0 = gate && joined.length ? top - WALL_LINTEL : lo === 0 ? town.base[c] - FOOT : town.floorZ(c, lo);
        const seen = new Set<string>();
        const from = spans.length;
        for (const f of frames) raster(f, z0, top, s.id, seen, spans);
        // (on the ground: each column's foot down to its own ground)
        if (lo === 0 && !(gate && joined.length))
          for (let k = from; k < spans.length; k++) {
            const q = spans[k];
            if (q.x >= 0 && q.y >= 0 && q.x < grid.w && q.y < grid.h) q.z0 = Math.min(q.z0, inp.ground(q.y * grid.w + q.x) - FOOT);
          }
      }
    }
    if (spans.length) out.set(s.id, spans);
  }
  return out;
}
