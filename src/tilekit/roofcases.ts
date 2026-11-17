// (tilekit step 3) The roof union's test cases as geometry: strip roofs as district.ts makes them (a sampled top over
// the strip's rectangle — the house below — grown by an overhang ring, a fascia round it), used by the unit tests and
// shown in the lab (?mode=roofs) with the house walls under them, union on or off.

import type { Lid, RoofSolidIn, V3 } from './roofunion';

const ROOF = 3;
const TRIM = 1;
const WALL = 0;
export const CASE_THICK = 0.2;
type RGB = [number, number, number];

export interface CaseRoof extends RoofSolidIn {
  /** the house under it: four walls from the ground to the eave (the lab draws them; not part of the union) */
  walls: number[];
}

function push(v: number[], p: V3, n: V3, col: RGB, mat: number) {
  v.push(p[0], p[1], p[2], 4, n[0], n[1], n[2], 1, col[0], col[1], col[2], mat);
}
function tri(v: number[], a: V3, b: V3, c: V3, col: RGB, mat: number) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const l = Math.hypot(...n) || 1;
  n = [n[0] / l, n[1] / l, n[2] / l];
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  for (const p of [a, b, c]) push(v, p, n, col, mat);
}

/** a roof: top z = eave + thickness + f(x, y) over core = [x0, y0, x1, y1] grown by ring = [−x, +x, −y, +y] */
export function caseRoof(core: [number, number, number, number], ring: [number, number, number, number], eave: number, f: (x: number, y: number) => number, col: RGB = [0.8, 0.42, 0.25], n = 8): CaseRoof {
  const [x0, y0, x1, y1] = core;
  const X0 = x0 - ring[0];
  const X1 = x1 + ring[1];
  const Y0 = y0 - ring[2];
  const Y1 = y1 + ring[3];
  // sample lines: the core's sides are lines of the grid, so a triangle is wholly core or wholly ring
  const xs = [...new Set([X0, ...Array.from({ length: n + 1 }, (_, i) => x0 + ((x1 - x0) * i) / n), X1])].sort((a, b) => a - b);
  const ys = [...new Set([Y0, ...Array.from({ length: n + 1 }, (_, i) => y0 + ((y1 - y0) * i) / n), Y1])].sort((a, b) => a - b);
  const v: number[] = [];
  const lids: Lid[] = [];
  const P = (x: number, y: number): V3 => [x, y, eave + CASE_THICK + f(x, y)];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const a = P(xs[i], ys[j]);
      const b = P(xs[i + 1], ys[j]);
      const c = P(xs[i + 1], ys[j + 1]);
      const d = P(xs[i], ys[j + 1]);
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      const inCore = cx > x0 && cx < x1 && cy > y0 && cy < y1;
      // (the diagonal whose ends average higher: a min-of-planes roof is concave, so that one follows its hips)
      const split = a[2] + c[2] >= b[2] + d[2] ? [[a, b, c], [a, c, d]] : [[b, c, d], [b, d, a]];
      for (const t of split as [V3, V3, V3][]) {
        if (Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0])) < 1e-9) continue;
        tri(v, t[0], t[1], t[2], col, ROOF);
        lids.push({ t, depth: inCore ? Infinity : CASE_THICK });
      }
    }
  }
  const rim: V3[] = [];
  for (const x of xs.slice(0, -1)) rim.push(P(x, Y0));
  for (const y of ys.slice(0, -1)) rim.push(P(X1, y));
  for (const x of xs.slice(1).reverse()) rim.push(P(x, Y1));
  for (const y of ys.slice(1).reverse()) rim.push(P(X0, y));
  const fascia: RGB = [0.92, 0.88, 0.8];
  for (let k = 0; k < rim.length; k++) {
    const a = rim[k];
    const b = rim[(k + 1) % rim.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    const nn: V3 = [(b[1] - a[1]) / l, -(b[0] - a[0]) / l, 0];
    const a2: V3 = [a[0], a[1], a[2] - CASE_THICK];
    const b2: V3 = [b[0], b[1], b[2] - CASE_THICK];
    for (const p of [a, b, b2, a, b2, a2]) push(v, p, nn, fascia, TRIM);
  }
  // the house: walls up to the eave, filled up to the roof on its four sides (the gable ends)
  const walls: number[] = [];
  const wallCol: RGB = [0.9, 0.86, 0.78];
  const side = (p: [number, number], q: [number, number]) => {
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const nn: V3 = [(q[1] - p[1]) / l, -(q[0] - p[0]) / l, 0];
    const N = 8;
    for (let s = 0; s < N; s++) {
      const u0 = s / N;
      const u1 = (s + 1) / N;
      const A: [number, number] = [p[0] + (q[0] - p[0]) * u0, p[1] + (q[1] - p[1]) * u0];
      const B: [number, number] = [p[0] + (q[0] - p[0]) * u1, p[1] + (q[1] - p[1]) * u1];
      const za = eave + f(A[0], A[1]);
      const zb = eave + f(B[0], B[1]);
      for (const r of [[A[0], A[1], 0], [B[0], B[1], 0], [B[0], B[1], zb], [A[0], A[1], 0], [B[0], B[1], zb], [A[0], A[1], za]] as V3[]) push(walls, r, nn, wallCol, WALL);
    }
  };
  side([x0, y0], [x1, y0]);
  side([x1, y0], [x1, y1]);
  side([x1, y1], [x0, y1]);
  side([x0, y1], [x0, y0]);
  return { verts: v, lids, walls };
}
export const gableX = (y0: number, y1: number, pitch: number) => (_x: number, y: number) => pitch * Math.min(y - y0, y1 - y);
export const gableY = (x0: number, x1: number, pitch: number) => (x: number) => pitch * Math.min(x - x0, x1 - x);
export const pyramid = (x0: number, y0: number, x1: number, y1: number, pitch: number) => (x: number, y: number) => pitch * Math.min(x - x0, x1 - x, y - y0, y1 - y);

/** the cases, each at its origin (the lab places them in a row) */
export function roofCases(): [string, CaseRoof[]][] {
  const B: RGB = [0.62, 0.36, 0.26];
  return [
    // a T: a long gable (ridge along x) and a crossing one (ridge along y) joined to its side, its end run 2 m on into it
    ['crossing gables', [caseRoof([0, 0, 10, 5], [0.5, 0.5, 0.5, 0.5], 6, gableX(0, 5, 0.8)), caseRoof([3, 5, 7, 12], [0.5, 0.5, 2, 0.5], 6, gableY(3, 7, 0.8), B)]],
    // a low tower's pyramid beside a gable, its overhang over the gable's roof — it used to poke through
    ['pyramid beside a gable', [caseRoof([0, 0, 10, 5], [0.5, 0, 0.5, 0.5], 6, gableX(0, 5, 0.8)), caseRoof([10, 1, 13, 4], [0.6, 0.6, 0.6, 0.6], 6.6, pyramid(10, 1, 13, 4, 1.4), B)]],
    // two strips joined end to end, the wider one's ridge higher: the narrower's ring runs into the wider house
    ['wide and narrow joined', [caseRoof([0, 0, 6, 6], [0.5, 0.5, 0.5, 0.5], 6, gableX(0, 6, 0.8)), caseRoof([6, 1, 12, 5], [0, 0.5, 0.5, 0.5], 6, gableX(1, 5, 0.8), B)]],
    // two gables end to end on one ridge line: a shared plane where they meet (overhangs at the corners overlap)
    ['shared plane', [caseRoof([0, 0, 6, 5], [0.5, 0.3, 0.5, 0.5], 6, gableX(0, 5, 0.8)), caseRoof([6, 0, 12, 5], [0.3, 0.5, 0.5, 0.5], 6, gableX(0, 5, 0.8), B)]],
  ];
}
