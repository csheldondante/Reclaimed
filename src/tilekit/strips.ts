// (tilekit step 2, docs/design/TILEKIT.md §13) The grid's own coordinates, locally: grid lines (edge chains that run
// straight on through 4-valent vertices), strips (i × j patches of cells in the grid's two local directions, bent by
// the grid) and the decomposition of a set of cells into strips. Pure: no GPU, no theme.
//
// A cell's frame: its edge k is the bottom (corner k → k + 1), k + 1 the right, k + 2 the top, k + 3 the left (cells
// are CCW). Stepping right across edge k + 1 lands in a cell whose bottom is found by the shared corner; so is up.

import { cornerAngle, cornerOf, P, type GridMesh } from './grid';

/** a cell with a frame: its bottom edge index */
export interface Framed {
  c: number;
  k: number;
}

/** every vertex's valence (cells round it) and whether its ring is closed (interior) */
export interface Rings {
  valence: Int32Array;
  interior: Uint8Array;
}

export function rings(m: GridMesh): Rings {
  const valence = new Int32Array(m.nv);
  const open = new Uint8Array(m.nv);
  for (let c = 0; c < m.nc; c++) {
    for (let k = 0; k < 4; k++) {
      valence[m.cells[c * 4 + k]]++;
      if (m.across[c * 4 + k] < 0) {
        open[m.cells[c * 4 + k]] = 1;
        open[m.cells[c * 4 + ((k + 1) % 4)]] = 1;
      }
    }
  }
  const interior = new Uint8Array(m.nv);
  for (let v = 0; v < m.nv; v++) interior[v] = open[v] ? 0 : 1;
  return { valence, interior };
}

/** the cell right of f (across its right edge), framed so its left edge is the shared one; null at the grid's edge */
export function right(m: GridMesh, f: Framed): Framed | null {
  const o = m.across[f.c * 4 + ((f.k + 1) % 4)];
  if (o < 0) return null;
  // the right neighbour's bottom-left corner is f's bottom-right corner
  const v = m.cells[f.c * 4 + ((f.k + 1) % 4)];
  return { c: o, k: cornerOf(m, o, v) };
}

/** the cell above f (across its top edge), framed so its bottom edge is the shared one */
export function up(m: GridMesh, f: Framed): Framed | null {
  const o = m.across[f.c * 4 + ((f.k + 2) % 4)];
  if (o < 0) return null;
  // the upper neighbour's bottom-left corner is f's top-left corner
  const v = m.cells[f.c * 4 + ((f.k + 3) % 4)];
  return { c: o, k: cornerOf(m, o, v) };
}

/** a framed cell's corner: 0 bottom-left, 1 bottom-right, 2 top-right, 3 top-left */
export const corner = (m: GridMesh, f: Framed, i: number): number => m.cells[f.c * 4 + ((f.k + i) % 4)];

/** an a × b strip: `at[j][i]` the cell i along (right) and j across (up), framed alike */
export interface Strip {
  a: number;
  b: number;
  at: Framed[][];
}

/** the a × b patch from `f` going right a cells and up b cells, if the cells make one (each cell's right neighbour is
 *  the next along, its upper neighbour the next across — so every interior vertex is 4-valent), all distinct and, if
 *  given, all allowed; else null */
export function patch(m: GridMesh, f: Framed, a: number, b: number, allowed?: (c: number) => boolean): Strip | null {
  const at: Framed[][] = [];
  const seen = new Set<number>();
  for (let j = 0; j < b; j++) {
    const row: Framed[] = [];
    for (let i = 0; i < a; i++) {
      let g: Framed | null;
      if (i === 0 && j === 0) g = f;
      else if (i === 0) g = up(m, at[j - 1][0]);
      else g = right(m, row[i - 1]);
      if (!g || seen.has(g.c) || (allowed && !allowed(g.c))) return null;
      // consistency: the cell below must lead up to it, with the same frame
      if (j > 0) {
        const u = up(m, at[j - 1][i]);
        if (!u || u.c !== g.c || u.k !== g.k) return null;
      }
      seen.add(g.c);
      row.push(g);
    }
    at.push(row);
  }
  return { a, b, at };
}

/** the strip's outline, CCW: its corner vertices and, between them, its side vertices (bottom, right, top, left) */
export function stripOutline(m: GridMesh, s: Strip): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.a; i++) out.push(corner(m, s.at[0][i], 0));
  for (let j = 0; j < s.b; j++) out.push(corner(m, s.at[j][s.a - 1], 1));
  for (let i = s.a - 1; i >= 0; i--) out.push(corner(m, s.at[s.b - 1][i], 2));
  for (let j = s.b - 1; j >= 0; j--) out.push(corner(m, s.at[j][0], 3));
  return out;
}

/** the turn (degrees, + left) of the polyline p → v → q */
export function turn(m: GridMesh, p: number, v: number, q: number): number {
  const [px, py] = P(m, p);
  const [vx, vy] = P(m, v);
  const [qx, qy] = P(m, q);
  const ax = vx - px;
  const ay = vy - py;
  const bx = qx - vx;
  const by = qy - vy;
  return (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI;
}

/** the largest |turn| along a strip's four sides (the corners excluded): how far its walls are from straight */
export function sideBend(m: GridMesh, s: Strip): number {
  const o = stripOutline(m, s);
  const n = o.length;
  const corners = new Set([0, s.a, s.a + s.b, 2 * s.a + s.b]);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    if (corners.has(i)) continue;
    worst = Math.max(worst, Math.abs(turn(m, o[(i + n - 1) % n], o[i], o[(i + 1) % n])));
  }
  return worst;
}

/** a grid line: the edges (vertex chain) from directed edge (cell c's edge k, c on its left) straight on through
 *  interior 4-valent vertices — at such a vertex the edge two cells round continues it — until a vertex that is not */
export function traceLine(m: GridMesh, r: Rings, c0: number, k0: number, max = 200): { verts: number[]; cells: number[]; stop: number } {
  const verts = [m.cells[c0 * 4 + k0]];
  const cells: number[] = [];
  let c = c0;
  let k = k0;
  for (let n = 0; n < max; n++) {
    const v = m.cells[c * 4 + ((k + 1) % 4)];
    verts.push(v);
    cells.push(c);
    if (!r.interior[v] || r.valence[v] !== 4) return { verts, cells, stop: v };
    const c2 = m.across[c * 4 + ((k + 1) % 4)];
    if (c2 < 0) return { verts, cells, stop: v };
    c = c2;
    k = cornerOf(m, c2, v);
    if (v === verts[0]) return { verts, cells, stop: -1 };
  }
  return { verts, cells, stop: -1 };
}

/** grid-line statistics: for every edge, the maximal line through it (through 4-valent vertices both ways): its length
 *  in edges and metres, and the turn at each 4-valent pass (how smooth a line is) and at the irregular vertices that end
 *  it (what a wall would bend by if it carried on: the side two cells round, either way) */
export function lineStats(m: GridMesh) {
  const r = rings(m);
  const done = new Set<string>();
  const lens: number[] = [];
  const metres: number[] = [];
  const passTurns: number[] = [];
  const key = (a: number, b: number) => (a < b ? a + ',' + b : b + ',' + a);
  for (let c = 0; c < m.nc; c++) {
    for (let k = 0; k < 4; k++) {
      const a = m.cells[c * 4 + k];
      const b = m.cells[c * 4 + ((k + 1) % 4)];
      if (done.has(key(a, b))) continue;
      const fw = traceLine(m, r, c, k);
      // backwards: the same edge from the other side, if any
      const o = m.across[c * 4 + k];
      let bw: number[] = [];
      if (o >= 0) bw = traceLine(m, r, o, cornerOf(m, o, b)).verts;
      const chain = [...bw.slice().reverse().slice(0, -2), ...fw.verts];
      for (let i = 0; i + 1 < chain.length; i++) done.add(key(chain[i], chain[i + 1]));
      if (!r.interior[a] || !r.interior[b]) continue;
      lens.push(chain.length - 1);
      let len = 0;
      for (let i = 0; i + 1 < chain.length; i++) {
        const [x0, y0] = P(m, chain[i]);
        const [x1, y1] = P(m, chain[i + 1]);
        len += Math.hypot(x1 - x0, y1 - y0);
      }
      metres.push(len);
      for (let i = 1; i + 1 < chain.length; i++) passTurns.push(Math.abs(turn(m, chain[i - 1], chain[i], chain[i + 1])));
    }
  }
  // the bend a wall makes carrying on through an irregular vertex: at each interior vertex of valence v ≠ 4, every pair
  // of edges two cells apart (the inside of a wall run then holds 2 cell corners)
  const irregularBend: Record<number, number[]> = {};
  for (let c = 0; c < m.nc; c++) {
    for (let k = 0; k < 4; k++) {
      const v = m.cells[c * 4 + k];
      if (!r.interior[v] || r.valence[v] === 4) continue;
      const nb = m.across[c * 4 + k];
      if (nb < 0) continue;
      // the two cells' corners at v, summed: the inside angle of a straight-through run
      const ang = cornerAngle(m, c, k) + cornerAngle(m, nb, cornerOf(m, nb, v));
      (irregularBend[r.valence[v]] ??= []).push(Math.abs(180 - ang));
    }
  }
  const q = (xs: number[], f: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2) : NaN;
  };
  return {
    lines: lens.length,
    edges: { median: q(lens, 0.5), p90: q(lens, 0.9), max: Math.max(...lens) },
    metres: { median: q(metres, 0.5), p90: q(metres, 0.9), max: q(metres, 1) },
    passTurn: { median: q(passTurns, 0.5), p90: q(passTurns, 0.9), max: q(passTurns, 1) },
    irregularBend: Object.fromEntries(Object.entries(irregularBend).map(([v, xs]) => [v, { median: q(xs, 0.5), p10: q(xs, 0.1), p90: q(xs, 0.9) }])),
  };
}

/** the strips seeded at framed cell f: for each width b up to `maxB`, the longest (up to `maxA`) — candidates for a
 *  greedy cover */
export function growStrip(m: GridMesh, f: Framed, allowed: (c: number) => boolean, maxA: number, maxB: number): Strip[] {
  const out: Strip[] = [];
  for (let b = 1; b <= maxB; b++) {
    let best: Strip | null = null;
    for (let a = 1; a <= maxA; a++) {
      const s = patch(m, f, a, b, allowed);
      if (!s) break;
      best = s;
    }
    if (!best) break;
    out.push(best);
  }
  return out;
}

/** the cells of a strip */
export const stripCells = (s: Strip): number[] => s.at.flat().map((f) => f.c);

/** a cover of `cells` by disjoint strips, greedily: the strip with the best score among every cell's maximal strips in
 *  every frame is taken, its cells removed, again until none is left (single cells are 1 × 1 strips). The score is
 *  the strip's cells minus `bendCost` per degree of its worst side bend (walls want straight sides) */
export function decompose(m: GridMesh, cells: Iterable<number>, o: { maxA?: number; maxB?: number; bendCost?: number } = {}): Strip[] {
  const left = new Set(cells);
  const maxA = o.maxA ?? 8;
  const maxB = o.maxB ?? 3;
  const bendCost = o.bendCost ?? 0.05;
  const out: Strip[] = [];
  while (left.size) {
    let best: Strip | null = null;
    let bestScore = -Infinity;
    for (const c of left) {
      for (let k = 0; k < 4; k++) {
        for (const s of growStrip(m, { c, k }, (x) => left.has(x), maxA, maxB)) {
          const score = s.a * s.b - bendCost * sideBend(m, s) + 0.01 * s.a;
          if (score > bestScore) {
            bestScore = score;
            best = s;
          }
        }
      }
    }
    if (!best) throw new Error('tilekit: no strip at all (unreachable: every cell is a 1 × 1 strip)');
    for (const c of stripCells(best)) left.delete(c);
    out.push(best);
  }
  return out;
}
