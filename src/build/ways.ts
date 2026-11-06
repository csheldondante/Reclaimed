// A town's ways that aren't its roads (round 128d; round 128p, DA-A13: the roads are the paths on the grid's edges and
// the main roads' curves — build/townroads.ts — and the old road tree over the free cells, its entrances and its nav
// graph, are gone). Baked from the plan by rules, pure (ways.test.ts):
//  - the doors: each structure's, where its lane leaves it (the roads' layout: `layout.roads.doors`) — the view's front
//    door, the keep's arch;
//  - the stairs onto the walls: each wall run one (another every STAIR_EVERY cells), up from free cells beside a straight
//    stretch of it — a straight flight across as many cells as its height needs (no steeper than SLOPE), from a foot cell
//    to the wall's top; a unit steps up it (the GPU surfaces: solid.ts claims its steps), its foot nearest the town's
//    middle;
//  - the squares: the courtyards (paved);
//  - the gates and the blocks' passages (ways through).
import type { V2 } from '../api/contracts/structures';
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import { LEVEL_H } from './town';
import { DEFS } from './types';
import type { TownPlan } from './plan';
import { WALL_HALF } from './solid';

export interface WaysGrid {
  readonly count: number;
  readonly nbr: Int32Array;
  centre(c: number): [number, number];
  corner(c: number, k: number): [number, number];
}

/** a cell's way: none, a square (a courtyard), a stair's flight */
export const WAY_NONE = 0;
export const WAY_SQUARE = 2;
export const WAY_STAIR = 3;
/** the steepest a stair rises (metres up a metre along: a hex column a metre apart, the agents' STEP 1.1) */
export const SLOPE = 0.75;
/**
 * (round 128o, DA-A10) The most a stair climbs over a run of `run` metres: no steeper than SLOPE, so each column's step
 * is within the walkers' STEP. A ramp across a cell (solid.ts rampRun), a road's steep stretch (grade.ts) alike.
 */
export function stairRise(run: number): number {
  return SLOPE * run;
}
/** another stair every this many wall cells of a run */
export const STAIR_EVERY = 16;
/** the longest flight (cells) */
const STAIR_MAX = 6;

/** a structure's door: the cell and the side its lane leaves it by */
export interface Door {
  structure: number;
  cell: number;
  side: number;
}

export interface Stair {
  /** the wall structure, the wall cell it climbs onto, the side it leaves the wall by */
  structure: number;
  wall: number;
  side: number;
  /** the free cells it crosses, from the wall out */
  cells: number[];
  /** the free cell its foot opens on */
  foot: number;
  /** its axis: the wall cell's middle, then the middle of each side it crosses (the last the foot's side) */
  axis: V2[];
}

export interface Ways {
  /** per cell its way (WAY_*) */
  way: Uint8Array;
  doors: Door[];
  stairs: Stair[];
  /** gate cells: a way through the wall */
  gates: number[];
  /** block cells with a passage (TownPlan.passage): a way through the ground floor */
  passages: number[];
}

/** no ways at all (tests of the shapes' own rules) */
export function noWays(count: number): Ways {
  return { way: new Uint8Array(count), doors: [], stairs: [], gates: [], passages: [] };
}

/** a cell's side e: its middle */
function sideMid(g: WaysGrid, c: number, e: number): V2 {
  const a = g.corner(c, e);
  const b = g.corner(c, e + 1);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** the side of n that faces c (-1: none) */
function sideTo(g: WaysGrid, n: number, c: number): number {
  for (let e = 0; e < 4; e++) if (g.nbr[n * 4 + e] === c) return e;
  return -1;
}

export interface WaysOpts {
  /** the courtyards' cells (shapes.ts): squares */
  courtyards?: readonly number[];
  defs?: Record<StructureType, StructureDef>;
  /** a cell the stairs keep off (water) */
  blocked?: (c: number) => boolean;
}

export function waysOf(plan: TownPlan, g: WaysGrid, o: WaysOpts = {}): Ways {
  const courtyards = o.courtyards ?? [];
  const defs = o.defs ?? DEFS;
  const blocked = o.blocked ?? (() => false);
  const n = g.count;
  const way = new Uint8Array(n);
  const nb = (c: number, e: number) => g.nbr[c * 4 + (((e % 4) + 4) % 4)];
  const free = (c: number) => c >= 0 && plan.owner[c] < 0 && !blocked(c);
  const court = new Set(courtyards);
  const structures = plan.structures();
  const formOf = (c: number) => {
    const t = plan.typeAt(c);
    return t ? defs[t].form : null;
  };
  const mean = (cells: number[]): V2 | null => {
    if (!cells.length) return null;
    let x = 0;
    let y = 0;
    for (const c of cells) {
      const [cx, cy] = g.centre(c);
      x += cx / cells.length;
      y += cy / cells.length;
    }
    return [x, y];
  };
  const allCells = structures.flatMap((s) => [...s.cells.keys()]);
  const gates = allCells.filter((c) => formOf(c) === 'wall' && plan.gate[c] && plan.has(c, 0));
  const passages = allCells.filter((c) => plan.passage?.[c] && formOf(c) === 'block' && plan.has(c, 0));
  const keepCells = structures.filter((s) => defs[s.type].form === 'keep').flatMap((s) => [...s.cells.keys()]);
  const middle = mean(keepCells) ?? mean(allCells) ?? [0, 0];
  const d2 = (c: number, p: V2) => {
    const [x, y] = g.centre(c);
    return (x - p[0]) ** 2 + (y - p[1]) ** 2;
  };
  // ---- the doors: the roads' (layout.roads.doors)
  const doors: Door[] = [];
  const rd = plan.layout.roads?.doors ?? [];
  for (let i = 0; i + 2 < rd.length; i += 3) if (plan.structure(rd[i])) doors.push({ structure: rd[i], cell: rd[i + 1], side: rd[i + 2] });
  const taken = new Uint8Array(n);
  // ---- the stairs onto the walls
  const stairs: Stair[] = [];
  const flight = (c: number, e: number): { cells: number[]; foot: number; axis: V2[] } | null => {
    // straight on through each cell (in by one side, out by the opposite) until the flight is long enough
    const levels = plan.top(c) + 1;
    const need = (levels * LEVEL_H) / SLOPE + WALL_HALF;
    const axis: V2[] = [g.centre(c), sideMid(g, c, e)];
    let len = Math.hypot(axis[1][0] - axis[0][0], axis[1][1] - axis[0][1]);
    const cells: number[] = [];
    let prev = c;
    let cur = nb(c, e);
    while (cells.length < STAIR_MAX) {
      if (!free(cur) || court.has(cur) || taken[cur]) return null;
      const into = sideTo(g, cur, prev);
      const outSide = (into + 2) % 4;
      const m = sideMid(g, cur, outSide);
      const last = axis[axis.length - 1];
      len += Math.hypot(m[0] - last[0], m[1] - last[1]);
      axis.push(m);
      cells.push(cur);
      prev = cur;
      cur = nb(cur, outSide);
      if (len >= need) break;
    }
    if (len < need || !free(cur) || court.has(cur) || taken[cur]) return null;
    return { cells, foot: cur, axis };
  };
  // the wall runs (wall cells that touch, gates among them)
  const runOf = new Int32Array(n).fill(-1);
  const runs: number[][] = [];
  for (const c0 of allCells) {
    if (formOf(c0) !== 'wall' || runOf[c0] >= 0) continue;
    const run = [c0];
    runOf[c0] = runs.length;
    for (let i = 0; i < run.length; i++)
      for (let e = 0; e < 4; e++) {
        const m = nb(run[i], e);
        if (m >= 0 && runOf[m] < 0 && formOf(m) === 'wall') {
          runOf[m] = runs.length;
          run.push(m);
        }
      }
    runs.push(run);
  }
  // (a cell's size: stairs of one run kept a few cells apart)
  const cellSize = (() => {
    const c = allCells[0];
    if (c === undefined) return 5;
    const a = g.corner(c, 0);
    const b = g.corner(c, 1);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) || 5;
  })();
  for (const run of runs) {
    const cands: { wall: number; side: number; f: NonNullable<ReturnType<typeof flight>>; score: number }[] = [];
    for (const c of run) {
      // (a straight stretch on the ground, not a gate: the wall joins on two opposite sides and on neither other side)
      if (plan.gate[c] || plan.levels.bottom(c) !== 0) continue;
      const wallAt = (e: number) => {
        const m = nb(c, e);
        return m >= 0 && (formOf(m) === 'wall' || formOf(m) === 'keep');
      };
      for (let e = 0; e < 4; e++) {
        if (wallAt(e) || wallAt(e + 2) || !wallAt(e + 1) || !wallAt(e + 3)) continue;
        const f = flight(c, e);
        if (!f) continue;
        // (its foot nearest the town's middle: the inner side)
        cands.push({ wall: c, side: e, f, score: d2(f.foot, middle) });
      }
    }
    cands.sort((a, b) => a.score - b.score || a.wall - b.wall || a.side - b.side);
    const want = Math.max(1, Math.round(run.length / STAIR_EVERY));
    const chosen: Stair[] = [];
    while (chosen.length < want) {
      // the first the best; each next the one farthest from those chosen (along the run, by straight distance)
      let best: (typeof cands)[number] | null = null;
      let bd = -1;
      for (const k of cands) {
        if (k.f.cells.some((c) => taken[c]) || taken[k.f.foot]) continue;
        const d = chosen.length ? Math.min(...chosen.map((s) => d2(k.wall, g.centre(s.wall)))) : 0;
        if (!best || d > bd) {
          best = k;
          bd = d;
        }
        if (!chosen.length) break;
      }
      if (!best || (chosen.length && bd < ((cellSize * STAIR_EVERY) / 2) ** 2)) break;
      const s = plan.structureAt(best.wall)!;
      const st: Stair = { structure: s.id, wall: best.wall, side: best.side, cells: best.f.cells, foot: best.f.foot, axis: best.f.axis };
      chosen.push(st);
      for (const c of st.cells) taken[c] = 1;
    }
    stairs.push(...chosen);
  }
  for (const s of stairs) for (const c of s.cells) way[c] = WAY_STAIR;
  // ---- the squares: the courtyards
  for (const c of court) if (free(c)) way[c] = WAY_SQUARE;
  return { way, doors, stairs, gates, passages };
}

/** a point along a stair's axis at distance t from the wall's middle, and the axis's direction there */
export function alongAxis(axis: readonly V2[], t: number): { p: V2; d: V2 } {
  let left = t;
  for (let i = 0; i + 1 < axis.length; i++) {
    const a = axis[i];
    const b = axis[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: V2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    if (left <= l || i + 2 === axis.length) return { p: [a[0] + d[0] * left, a[1] + d[1] * left], d };
    left -= l;
  }
  return { p: axis[0], d: [1, 0] };
}

/** a stair's axis length */
export function axisLength(axis: readonly V2[]): number {
  let l = 0;
  for (let i = 0; i + 1 < axis.length; i++) l += Math.hypot(axis[i + 1][0] - axis[i][0], axis[i + 1][1] - axis[i][1]);
  return l;
}

/** where (x, y) lies along a stair's axis: t the distance along it, off the distance from it */
export function onAxis(axis: readonly V2[], x: number, y: number): { t: number; off: number } {
  let best = { t: 0, off: Infinity };
  let t0 = 0;
  for (let i = 0; i + 1 < axis.length; i++) {
    const a = axis[i];
    const b = axis[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const px = a[0] + dx * u;
    const py = a[1] + dy * u;
    const off = Math.hypot(x - px, y - py);
    if (off < best.off) best = { t: t0 + u * Math.sqrt(l2), off };
    t0 += Math.sqrt(l2);
  }
  return best;
}
