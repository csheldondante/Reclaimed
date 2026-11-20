// Nested scales lab, round 26 (docs/design/NESTED_SCALES.md "Round 26 plan", step A): the field mesh's sparse cell
// selection (src/nested/fieldsel.ts) against a brute walk of every cube. On random column stacks (air gaps, a tall
// cliff, a one-column spike, columns that are air all the way down), with and without the warp, and on a child level
// fading into its parent, every crossed cell must be selected; the extra cells are reported.
import { describe, expect, it } from 'vitest';
import { FAR, candidates, crossed, runsOf, solidInside, support, type FieldLevel, type FieldSpec, type PCol, type Runs } from '../../src/nested/fieldsel';
import { edgeEncA } from '../../src/nested/edge';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
/** a level over an n x n window at (gx, gy) whose columns come from `col` */
function level(gx: number, gy: number, n: number, col: (X: number, Y: number) => PCol | null): FieldLevel {
  const cache = new Map<number, Runs>();
  return {
    gx,
    gy,
    n,
    runs(X, Y) {
      const key = (Y - gy) * n + (X - gx);
      let r = cache.get(key);
      if (!r) cache.set(key, (r = runsOf(col(X, Y), solidInside)));
      return r;
    },
  };
}
/** a random partition: stone up to a ground height, optional air gaps (caves) and floating layers, sometimes soil */
function randomCol(r: () => number, ground: number): PCol {
  const top: number[] = [];
  const mat: number[] = [];
  let z = ground - 2 - r() * 6;
  top.push(z);
  mat.push(1);
  const gaps = r() < 0.35 ? 1 + Math.floor(r() * 3) : 0;
  for (let g = 0; g < gaps; g++) {
    z += 0.2 + r() * 3;
    top.push(z);
    mat.push(0);
    z += 0.1 + r() * 4;
    top.push(z);
    mat.push(r() < 0.5 ? 1 : 2);
  }
  if (r() < 0.5) {
    z += 0.3 + r() * 1.5;
    top.push(z);
    mat.push(2);
  }
  return { top, mat };
}

interface Tally {
  cols: number;
  selected: number;
  crossed: number;
  missing: number;
}
/** every cell column in [x0, x1) x [y0, y1): the selection against the brute walk */
function compare(s: FieldSpec, x0: number, y0: number, x1: number, y1: number, margin: number): Tally {
  const t: Tally = { cols: 0, selected: 0, crossed: 0, missing: 0 };
  for (let Y = y0; Y < y1; Y++)
    for (let X = x0; X < x1; X++) {
      t.cols++;
      const sel = candidates(s, X, Y, margin);
      const inSel = (K: number) => sel.some(([a, b]) => K >= a && K <= b);
      for (const [a, b] of sel) t.selected += b - a + 1;
      // (the brute walk's range: from the selection's own cut under the support's lowest boundary to well over the top)
      const sp = support(s, X, Y);
      const rs: Runs[] = sp.own.map(([x, y]) => s.own.runs(x, y));
      if (s.parent) for (const [x, y] of sp.parent) rs.push({ ...s.parent.lv.runs(x, y), b: s.parent.lv.runs(x, y).b.map((z) => (z - s.parent!.zo) * s.parent!.k) });
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of rs)
        for (const z of r.b) {
          lo = Math.min(lo, z);
          hi = Math.max(hi, z);
        }
      if (lo === Infinity) continue;
      for (let K = Math.ceil(lo - FAR - 1); K <= Math.ceil(hi) + 4; K++) {
        if (!crossed(s, X, Y, K)) continue;
        t.crossed++;
        if (!inSel(K)) t.missing++;
      }
    }
  return t;
}
const say = (name: string, t: Tally) =>
  console.log(`[field] ${name}: ${t.cols} cell columns, crossed ${t.crossed}, selected ${t.selected} (${(t.selected / t.cols).toFixed(2)} a column, ${(t.crossed / t.cols).toFixed(2)} crossed), extra ${t.selected - t.crossed}, missing ${t.missing}`);

/** (round 29) random edge samples on a column's records: each with probability p, any angle, d over the whole range */
function withEdges(c: PCol | null, r: () => number, p = 0.5): PCol | null {
  if (!c) return c;
  return { ...c, edge: Array.from(c.mat, () => (r() < p ? edgeEncA(r() * 2 * Math.PI, (r() - 0.5) * 4) : 0)) };
}
/** the scenes: random stacks over rolling ground, with a tall cliff, a one-column spike and air-all-the-way columns;
 *  (round 29) `edges`: random edge samples on the records */
function scene(seed: number, n: number, edges = false): (X: number, Y: number) => PCol | null {
  const r = rng(seed);
  const inner = sceneCols(r, n);
  return edges ? (X, Y) => withEdges(inner(X, Y), mkRng(seed, X, Y)) : inner;
}
/** a per-column generator (so a column's edges do not depend on the order columns are asked in) */
function mkRng(seed: number, X: number, Y: number): () => number {
  return rng((X * 73856093) ^ (Y * 19349663) ^ Math.imul(seed, 0x5bd1e995));
}
function sceneCols(r: () => number, n: number): (X: number, Y: number) => PCol | null {
  const cols = new Map<string, PCol | null>();
  for (let Y = 0; Y < n; Y++)
    for (let X = 0; X < n; X++) {
      let ground = 6 + 3 * Math.sin(X * 0.4) + 2 * Math.cos(Y * 0.3) + r() * 1.5;
      // (a tall cliff: 30 units over a quarter of the window)
      if (X > n / 2 && Y > n / 2) ground += 30;
      let c: PCol | null = randomCol(r, ground);
      // (a one-column spike)
      if (X === 3 && Y === 4) c = { top: [45], mat: [1] };
      // (a column that is air all the way down: a bottomless hole)
      if (X === 9 && Y === 2) c = null;
      cols.set(`${X},${Y}`, c);
    }
  return (X, Y) => cols.get(`${X},${Y}`) ?? null;
}

describe('nested field mesh selection (round 26, step A)', () => {
  // (round 29) fedge: the same stacks with random edge samples on their records, the field reading them
  for (const fedge of [false, true])
  for (const warp of [0, 0.45])
    for (const margin of [0, 1])
      it(`one level, warp ${warp}, margin ${margin}${fedge ? ', edge lines read' : ''}: every crossed cell selected`, () => {
        const all: Tally = { cols: 0, selected: 0, crossed: 0, missing: 0 };
        for (const seed of [1, 2, 3, 4]) {
          const n = 16;
          const s: FieldSpec = { own: level(0, 0, n, scene(seed, n, fedge)), warp, fade: 4, fedge };
          const t = compare(s, 0, 0, n - 1, n - 1, margin);
          for (const k of Object.keys(all) as (keyof Tally)[]) all[k] += t[k];
        }
        say(`one level, warp ${warp}, margin ${margin}${fedge ? ', fedge' : ''}`, all);
        expect(all.missing).toBe(0);
        expect(all.crossed).toBeGreaterThan(0);
      });

  for (const fedge of [false, true])
  for (const warp of [0, 0.45])
    for (const margin of [0, 1])
      it(`a child fading into its parent (k 4), warp ${warp}, margin ${margin}${fedge ? ', edge lines read' : ''}: every crossed cell selected, past the window too`, () => {
        const all: Tally = { cols: 0, selected: 0, crossed: 0, missing: 0 };
        for (const seed of [11, 12, 13]) {
          const k = 4;
          // (the parent: 16 x 16 random stacks; the child over its middle 6 x 6 parent columns, its columns the parent's
          // own records scaled into the child's units with noise and a carved pocket, so they differ near the edge)
          const pn = 16;
          const pcol = scene(seed, pn, fedge);
          const P = level(0, 0, pn, pcol);
          const zo = 2;
          const r = rng(seed * 7);
          const kids = new Map<string, PCol | null>();
          const gx = 5 * k;
          const n = 6 * k;
          for (let Y = gx; Y < gx + n; Y++)
            for (let X = gx; X < gx + n; X++) {
              const p = pcol(Math.floor(X / k), Math.floor(Y / k));
              if (!p) {
                kids.set(`${X},${Y}`, null);
                continue;
              }
              const top = Array.from(p.top, (z) => (z - zo) * k + (r() - 0.5) * 3);
              for (let j = 1; j < top.length; j++) top[j] = Math.max(top[j], top[j - 1] + 0.1);
              let c: PCol = { top, mat: Array.from(p.mat) };
              // (a carved pocket near one edge)
              if (X < gx + 4 && Y > gx + 8 && Y < gx + 14) c = { top: [top[0] - 6, top[0] - 3, top[top.length - 1]], mat: [1, 0, 1] };
              kids.set(`${X},${Y}`, fedge ? withEdges(c, mkRng(seed + 100, X, Y)) : c);
            }
          const s: FieldSpec = { own: level(gx, gx, n, (X, Y) => kids.get(`${X},${Y}`) ?? null), parent: { lv: P, k, zo }, warp, fade: 4, fedge };
          // (the cells past the window edge, OVER = k / 2 + 2 columns, read the parent only)
          const over = k / 2 + 2;
          const t = compare(s, gx - 1 - over, gx - 1 - over, gx + n + over, gx + n + over, margin);
          for (const kk of Object.keys(all) as (keyof Tally)[]) all[kk] += t[kk];
        }
        say(`child in parent, warp ${warp}, margin ${margin}${fedge ? ', fedge' : ''}`, all);
        expect(all.missing).toBe(0);
        expect(all.crossed).toBeGreaterThan(0);
      });

  it('gentle ground costs about a cell a column (no warp, margin 0); the warp and the margin cost', () => {
    const n = 32;
    const cols = (X: number, Y: number): PCol => ({ top: [4 + 0.3 * Math.sin(X * 0.21) * X * 0.1 + 0.15 * Y, 5 + 0.15 * Y + 0.03 * X], mat: [1, 2] });
    for (const warp of [0, 0.45])
      for (const margin of [0, 1]) {
        const s: FieldSpec = { own: level(0, 0, n, cols), warp, fade: 4 };
        const t = compare(s, 0, 0, n - 1, n - 1, margin);
        say(`gentle ground, warp ${warp}, margin ${margin}`, t);
        expect(t.missing).toBe(0);
        if (warp === 0 && margin === 0) expect(t.selected / t.cols).toBeLessThan(2);
      }
  });
});
