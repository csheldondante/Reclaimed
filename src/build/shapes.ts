// (round 128d) Painted shapes make landmarks, Townscaper's way: the player paints blocks, and some shapes become more
// than rooms by local rules read off the plan — no per-city picks, nothing random. The user, verbatim (DECISIONS round
// 128d): "Yes please add those rules and the courtyards since those add a lot of charm."
//  - tower: a lone block cell (no block or keep beside it) stacked three levels or more → a round tower with a spire;
//  - dome: a building of exactly four cells round one corner, all the same height → a drum, a dome and a lantern (the
//    towns' temple, structures/plan.ts);
//  - turret: a keep cell standing above every keep cell beside it → a round turret over the keep;
//  - courtyard: empty ground cells (a run of them, up to COURT_MAX) with blocks, walls or the keep on every side →
//    paving, a tree (one cell) or a fountain, arches in the ground floor's faces round it. (Partly enclosed: a garden,
//    later.)
// Pure: the plan and the grid in, the shapes out; pieces.ts draws them.
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import { DEFS } from './types';
import type { TownPlan } from './plan';

/** the most cells a courtyard has (a bigger enclosed space is a bailey, not a courtyard) */
export const COURT_MAX = 8;
/** the levels a lone cell stacks to before it is a tower */
export const TOWER_LEVELS = 3;

export interface ShapeGrid {
  readonly count: number;
  /** per cell its neighbour across edge e (corner e to e + 1), -1 none */
  readonly nbr: Int32Array;
  /** per cell its four corners (counter-clockwise) */
  readonly quads: ArrayLike<number>;
}

export interface Dome {
  /** the four cells round the corner */
  cells: number[];
  /** the corner they share */
  vertex: number;
}

export interface Courtyard {
  cells: number[];
  /** the ground-floor faces of the blocks round it: the block's cell and its side facing the courtyard */
  faces: { cell: number; side: number }[];
}

export interface Shapes {
  towers: Set<number>;
  domes: Dome[];
  turrets: Set<number>;
  courtyards: Courtyard[];
}

/**
 * The plan's shapes. `base`: a cell's ground floor (the Town's): a building is a structure's cells on one floor
 * (pieces.ts groups them so), and a dome's four cells must be one building.
 */
export function shapesOf(plan: TownPlan, grid: ShapeGrid, base: (c: number) => number, defs: Record<StructureType, StructureDef> = DEFS): Shapes {
  const form = (c: number) => {
    const t = plan.typeAt(c);
    return t ? defs[t].form : null;
  };
  const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];
  const towers = new Set<number>();
  const turrets = new Set<number>();
  const domes: Dome[] = [];
  const courtyards: Courtyard[] = [];

  // the cells round each corner
  const around = new Map<number, number[]>();
  for (let c = 0; c < grid.count; c++)
    for (let k = 0; k < 4; k++) {
      const v = grid.quads[c * 4 + k];
      const a = around.get(v);
      if (a) a.push(c);
      else around.set(v, [c]);
    }

  for (const s of plan.structures()) {
    const f = defs[s.type].form;
    if (f === 'block') {
      // a building: the structure's cells on one floor (as pieces.ts groups them)
      const groups = new Map<string, number[]>();
      for (const c of s.cells.keys()) {
        const key = defs[s.type].joins ? String(base(c)) : `c${c}`;
        const g = groups.get(key);
        if (g) g.push(c);
        else groups.set(key, [c]);
      }
      for (const g of groups.values()) {
        if (g.length === 1) {
          const c = g[0];
          let stacked = true;
          for (let L = 0; L < TOWER_LEVELS; L++) stacked &&= plan.has(c, L);
          let lone = true;
          for (let e = 0; e < 4; e++) {
            const fn = form(nbr(c, e));
            if (fn === 'block' || fn === 'keep') lone = false;
          }
          if (stacked && lone) towers.add(c);
        } else if (g.length === 4) {
          if (!g.every((c) => plan.levels.sameLevels(c, g[0]))) continue;
          const set = new Set(g);
          // the corner all four share, round which there are only these four
          for (let k = 0; k < 4; k++) {
            const v = grid.quads[g[0] * 4 + k];
            const a = around.get(v)!;
            if (a.length === 4 && a.every((c) => set.has(c))) {
              domes.push({ cells: g.slice(), vertex: v });
              break;
            }
          }
        }
      }
    } else if (f === 'keep') {
      for (const c of s.cells.keys()) {
        let n = 0;
        let above = true;
        for (let e = 0; e < 4; e++) {
          const o = nbr(c, e);
          if (o < 0 || plan.owner[o] !== s.id) continue;
          n++;
          if (plan.top(o) >= plan.top(c)) above = false;
        }
        if (n && above) turrets.add(c);
      }
    }
  }

  // courtyards: runs of empty cells shut in on every side by blocks, walls or the keep (at the ground)
  const seen = new Uint8Array(grid.count);
  const encloses = (c: number) => {
    const fc = form(c);
    return (fc === 'block' || fc === 'wall' || fc === 'keep') && plan.has(c, 0);
  };
  for (let c0 = 0; c0 < grid.count; c0++) {
    if (seen[c0] || plan.owner[c0] >= 0) continue;
    const cells = [c0];
    seen[c0] = 1;
    let shut = true;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      for (let e = 0; e < 4; e++) {
        const n = nbr(c, e);
        if (n < 0) shut = false;
        else if (plan.owner[n] < 0) {
          if (!seen[n]) {
            seen[n] = 1;
            cells.push(n);
          }
        } else if (!encloses(n)) shut = false;
      }
      // (a big open run: not a courtyard — stop early, the rest marked seen as it is walked)
      if (cells.length > COURT_MAX) shut = false;
    }
    if (!shut) continue;
    const faces: { cell: number; side: number }[] = [];
    for (const c of cells)
      for (let e = 0; e < 4; e++) {
        const n = nbr(c, e);
        if (form(n) !== 'block') continue;
        for (let s = 0; s < 4; s++) if (nbr(n, s) === c) faces.push({ cell: n, side: s });
      }
    courtyards.push({ cells, faces });
  }
  return { towers, domes, turrets, courtyards };
}
