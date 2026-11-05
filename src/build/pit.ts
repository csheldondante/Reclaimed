// A quarry's pit as tiers and ramps down its footprint (round 128m, `quarry`, BACKLOG V128-11): the player paints the
// footprint at the surface, the miners grow it down tier by tier. The user: "make the quary area at the top and let the units just naturally grow it.
// Depth is capped by how many tiers of ramp down the side can be built with the tiles."
//
// The rule, on the plan's own cells (their four neighbours only: no geometry):
//  - rings: a footprint cell beside the outside (a side on no cell, or on a cell not in it) is ring 0; ring k the
//    cells k steps in. Tier k (k levels, k × LEVEL_H down) is every cell of ring k and further in: each ring a shelf a
//    tier above the next, the pit stepping in as it goes down;
//  - ramps: ramp k runs down from tier k-1 to tier k along `rampCells` consecutive cells of ring k-1 (the shelf it is
//    cut into), and ends on a cell of ring k, where ramp k+1 starts: one road spiralling down the sides. Ramp 1
//    starts at a ring-0 cell's outer side (the top: the roads join it there);
//  - depth: the most tiers whose ramps fit so (a search over the spirals, the deepest found; ties go to the start the
//    caller prefers — the one nearest the stores). A footprint too narrow for one ramp has no pit.
// In runs (build/runs.ts, negative levels): a cell of ring d holds levels -1 .. -min(d, tiers) (PIT_SHELF), and a
// ramp k cell the level -k as well (PIT_RAMP: dug as a slope). Pure: no GPU, no DOM (pit.test.ts).
import { CellRuns } from './runs';

/** a pit level's kind in its run (Run.type) */
export const PIT_SHELF = 0;
export const PIT_RAMP = 1;

/** what the pit needs of a grid: the cells' neighbours (and, for the ramps' slopes, their corners) */
export interface PitTopo {
  readonly count: number;
  /** per cell its neighbour across edge e (corner e to e + 1), -1 none */
  readonly nbr: Int32Array;
}

export interface PitGeo {
  corner(c: number, k: number): [number, number];
  centre(c: number): [number, number];
}

/** a ramp cell: where it comes in (its high side) and goes out (its low side), and the tiers it runs between */
export interface RampCell {
  cell: number;
  /** the side (0..3) its high end meets, and its low end's */
  inSide: number;
  outSide: number;
  /** its depth at the high side and the low side (tiers: k - 1 + i / n .. k - 1 + (i + 1) / n) */
  d0: number;
  d1: number;
}

export interface PitRamp {
  /** the tier it reaches */
  tier: number;
  /** high to low */
  cells: RampCell[];
}

export interface Pit {
  /** the footprint's cells, and each one's ring (steps in from the outside) */
  ring: Map<number, number>;
  /** the tiers dug at most (0: no pit) */
  tiers: number;
  ramps: PitRamp[];
  /** the ring-0 cell ramp 1 starts on, and its outer side (where the roads come in); -1: no pit */
  top: number;
  topSide: number;
}

export interface PitOpts {
  /** cells a ramp runs along (default 2) */
  rampCells?: number;
  /** the most tiers (default no cap: the world floor is far below — layout.ts WORLD_FLOOR) */
  maxTiers?: number;
  /** a start's preference: lower first (the ring-0 cells nearest the stores); default by cell index */
  prefer?: (cell: number) => number;
  /** search budget: paths tried at most (the deepest found by then) */
  budget?: number;
}

const sideTo = (g: PitTopo, c: number, m: number) => {
  for (let e = 0; e < 4; e++) if (g.nbr[c * 4 + e] === m) return e;
  return -1;
};

/** Rings: steps in from the footprint's outside (ring 0 has a side on no cell or a cell not in it). */
export function ringsOf(g: PitTopo, cells: Iterable<number>): Map<number, number> {
  const inSet = new Set(cells);
  const ring = new Map<number, number>();
  let front: number[] = [];
  for (const c of inSet)
    for (let e = 0; e < 4; e++) {
      const n = g.nbr[c * 4 + e];
      if (n < 0 || !inSet.has(n)) {
        ring.set(c, 0);
        front.push(c);
        break;
      }
    }
  for (let d = 1; front.length; d++) {
    const next: number[] = [];
    for (const c of front)
      for (let e = 0; e < 4; e++) {
        const n = g.nbr[c * 4 + e];
        if (n >= 0 && inSet.has(n) && !ring.has(n)) {
          ring.set(n, d);
          next.push(n);
        }
      }
    front = next;
  }
  return ring;
}

/** The pit a footprint holds (see the header). */
export function pitOf(g: PitTopo, cells: Iterable<number>, opts: PitOpts = {}): Pit {
  const R = Math.max(1, Math.round(opts.rampCells ?? 2));
  const maxTiers = opts.maxTiers ?? Infinity;
  const ring = ringsOf(g, cells);
  const outer = (c: number) => {
    for (let e = 0; e < 4; e++) {
      const n = g.nbr[c * 4 + e];
      if (n < 0 || !ring.has(n)) return e;
    }
    return -1;
  };
  const prefer = opts.prefer ?? ((c: number) => c);
  const starts = [...ring].filter(([, d]) => d === 0).map(([c]) => c).sort((a, b) => prefer(a) - prefer(b) || a - b);
  let budget = opts.budget ?? 20000;
  let best: { paths: number[][]; top: number } = { paths: [], top: -1 };
  // (the deepest spiral from cur, ring k-1: paths of R cells along the ring, each ending beside a cell of ring >= k)
  const path: number[] = [];
  const stack: number[][] = [];
  const deeper = (k: number, cur: number, top: number): void => {
    if (budget <= 0) return;
    if (stack.length > best.paths.length) best = { paths: stack.map((p) => p.slice()), top };
    if (k > maxTiers) return;
    const walk = (c: number): void => {
      if (budget-- <= 0) return;
      path.push(c);
      if (path.length === R) {
        for (let e = 0; e < 4 && budget > 0; e++) {
          const n = g.nbr[c * 4 + e];
          const d = n >= 0 ? ring.get(n) : undefined;
          if (d === undefined || d < k) continue;
          stack.push([...path, n]);
          const saved = path.splice(0);
          // (a landing further in than ring k ends the spiral there: the floor)
          if (d === k) deeper(k + 1, n, top);
          else if (stack.length > best.paths.length) best = { paths: stack.map((p) => p.slice()), top };
          path.push(...saved);
          stack.pop();
        }
      } else
        for (let e = 0; e < 4; e++) {
          const n = g.nbr[c * 4 + e];
          if (n >= 0 && ring.get(n) === k - 1 && !path.includes(n)) walk(n);
        }
      path.pop();
    };
    walk(cur);
  };
  for (const s of starts) {
    if (budget <= 0) break;
    deeper(1, s, s);
  }
  const tiers = best.paths.length;
  const ramps: PitRamp[] = best.paths.map((p, i) => {
    const k = i + 1;
    const cells: RampCell[] = [];
    for (let j = 0; j < R; j++) {
      const c = p[j];
      const prev = j > 0 ? p[j - 1] : k > 1 ? best.paths[i - 1][R - 1] : -1;
      const inSide = prev >= 0 ? sideTo(g, c, prev) : outer(c);
      cells.push({ cell: c, inSide, outSide: sideTo(g, c, p[j + 1]), d0: k - 1 + j / R, d1: k - 1 + (j + 1) / R });
    }
    return { tier: k, cells };
  });
  return { ring, tiers, ramps, top: tiers ? best.top : -1, topSide: tiers ? outer(best.top) : -1 };
}

/** A pit's levels as runs (negative levels: see the header), owned by `owner`. */
export function layPit(runs: CellRuns, pit: Pit, owner: number): void {
  for (const [c, d] of pit.ring) for (let L = 1; L <= Math.min(d, pit.tiers); L++) runs.set(c, -L, owner, PIT_SHELF);
  for (const r of pit.ramps) for (const rc of r.cells) runs.set(rc.cell, -r.tier, owner, PIT_RAMP);
}

/** The ramp cell a cell is (null: none). */
export function rampAt(pit: Pit, cell: number): RampCell | null {
  for (const r of pit.ramps) for (const rc of r.cells) if (rc.cell === cell) return rc;
  return null;
}

/**
 * How deep the pit is dug at (x, y) in `cell` once whole (tiers, fractional on a ramp): a shelf its ring's tier (the
 * pit's at most), a ramp cell from its high side's depth to its low side's along the line between those sides' middles.
 */
export function depthAt(pit: Pit, geo: PitGeo, cell: number, x: number, y: number): number {
  const d = pit.ring.get(cell);
  if (d === undefined) return 0;
  const rc = rampAt(pit, cell);
  if (!rc) return Math.min(d, pit.tiers);
  const mid = (e: number): [number, number] => {
    const a = geo.corner(cell, e);
    const b = geo.corner(cell, e + 1);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const [ax, ay] = mid(rc.inSide);
  const [bx, by] = mid(rc.outSide);
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
  return rc.d0 + (rc.d1 - rc.d0) * t;
}
