// (tilekit step 2, docs/design/TILEKIT.md §15) One roof a strip: a gable (or hipped at its free ends) with a single
// ridge along the strip's longer grid direction, a lean-to rising to a taller wall, or a pyramid on a tower — sampled
// on the strip's own half-cell grid (cell corners, edge midpoints, centres), so the ridge follows the grid's middle
// line and bends with it. The roof is chosen from how each side of the strip meets its neighbours:
//   eave  nothing as tall beyond it: the wall stands here, the roof overhangs it
//   join  a neighbour as tall (no wall between): the two roofs meet; a gable end runs on into a crossing roof
//   abut  a taller neighbour: its wall rises here; the roof must not slope down into it
// The rule "a slope never runs into a wall" holds by the choice (a gable's ridge never runs between two abutting long
// sides; a hip only on a free end; a long side against a taller wall makes a lean-to rising to it) and is checked on
// the result: along every abutting side the roof does not rise going away from the wall (`slopeIntoWall`).

import { corner, type Strip } from './strips';
import { centroid, P, type GridMesh } from './grid';
import type { V2 } from './facade';

export type SideClass = 'eave' | 'join' | 'abut';

/** the strip's sides in order bottom, right, top, left; each a list of its cell edges' classes (in walking order) */
export interface StripSides {
  cls: SideClass[][];
  /** each edge's offset of the wall line inwards from the cell edge (the wall's setback; an abutting edge negative:
   *  the roof runs on under the taller wall's setback) */
  off: number[][];
  /** the tallest abutting neighbour's eave above this strip's eave, per side (Infinity none) */
  headroom: number[];
  /** extend a joined gable end into the crossing roof by this much (metres), per side */
  extend: number[];
}

export type RoofKind = 'gable' | 'hip' | 'shed' | 'pyramid' | 'flat';

export interface RoofPlan {
  kind: RoofKind;
  /** the ridge runs along the strip's a direction (sides 1 and 3 are its ends) or its b direction */
  alongA: boolean;
  /** shed: the side it rises to (0..3) */
  high: number;
  /** hipped ends (sides) */
  hips: boolean[];
  pitch: number;
}

export interface RoofParams {
  pitch: number;
  /** a tower's (pyramid) pitch */
  towerPitch: number;
  overhang: number;
  thickness: number;
  /** hip free ends (else gable) */
  hip: boolean;
  /** a lean-to's top stays this far under a taller neighbour's eave */
  clearance: number;
}

/** the side polylines' lengths (metres): [bottom, right, top, left] */
export function sideLengths(m: GridMesh, s: Strip): number[] {
  const L = [0, 0, 0, 0];
  const add = (i: number, a: number, b: number) => {
    const [ax, ay] = P(m, a);
    const [bx, by] = P(m, b);
    L[i] += Math.hypot(bx - ax, by - ay);
  };
  for (let i = 0; i < s.a; i++) add(0, corner(m, s.at[0][i], 0), corner(m, s.at[0][i], 1));
  for (let j = 0; j < s.b; j++) add(1, corner(m, s.at[j][s.a - 1], 1), corner(m, s.at[j][s.a - 1], 2));
  for (let i = 0; i < s.a; i++) add(2, corner(m, s.at[s.b - 1][i], 2), corner(m, s.at[s.b - 1][i], 3));
  for (let j = 0; j < s.b; j++) add(3, corner(m, s.at[j][0], 3), corner(m, s.at[j][0], 0));
  return L;
}

/** each side's cell edges: [cell, edge index] in walking order (CCW round the strip) */
export function sideEdges(s: Strip): [number, number][][] {
  const e: [number, number][][] = [[], [], [], []];
  for (let i = 0; i < s.a; i++) e[0].push([s.at[0][i].c, s.at[0][i].k]);
  for (let j = 0; j < s.b; j++) e[1].push([s.at[j][s.a - 1].c, (s.at[j][s.a - 1].k + 1) % 4]);
  for (let i = s.a - 1; i >= 0; i--) e[2].push([s.at[s.b - 1][i].c, (s.at[s.b - 1][i].k + 2) % 4]);
  for (let j = s.b - 1; j >= 0; j--) e[3].push([s.at[j][0].c, (s.at[j][0].k + 3) % 4]);
  return e;
}

/** the roof for a strip from its sides (the rule's choice) */
export function planRoof(m: GridMesh, s: Strip, sides: StripSides, rp: RoofParams, tower: boolean): RoofPlan {
  const L = sideLengths(m, s);
  const alongA = (L[0] + L[2]) >= (L[1] + L[3]);
  // long sides (the eaves of a gable) and ends
  const long = alongA ? [0, 2] : [1, 3];
  const ends = alongA ? [1, 3] : [0, 2];
  const abut = sides.cls.map((c) => c.includes('abut'));
  const free = sides.cls.map((c) => c.every((x) => x === 'eave'));
  const hips = [false, false, false, false];
  if (tower && !abut.some(Boolean)) return { kind: 'pyramid', alongA, high: -1, hips: [true, true, true, true], pitch: rp.towerPitch };
  if (!abut[long[0]] && !abut[long[1]]) {
    for (const e of ends) hips[e] = rp.hip && free[e];
    return { kind: hips.some(Boolean) ? 'hip' : 'gable', alongA, high: -1, hips, pitch: rp.pitch };
  }
  if (abut[long[0]] !== abut[long[1]]) return { kind: 'shed', alongA, high: abut[long[0]] ? long[0] : long[1], hips, pitch: rp.pitch };
  // both long sides against taller walls: a gable across (its ridge along the short way) if the ends are clear,
  // else a flat roof (a terrace)
  // (only on a squarish strip: across a long one the ridge would climb to half its length — the first look had a
  // giant gable there, DEVLOG)
  const longL = alongA ? L[0] + L[2] : L[1] + L[3];
  const shortL = alongA ? L[1] + L[3] : L[0] + L[2];
  if (!abut[ends[0]] && !abut[ends[1]] && longL < 1.5 * shortL) return { kind: 'gable', alongA: !alongA, high: -1, hips, pitch: rp.pitch };
  return { kind: 'flat', alongA, high: -1, hips, pitch: 0 };
}

/** the sampled roof: (I + 1) × (J + 1) points, i along the ridge, j across; the wall-line points (the boundary) and the
 *  roof's height there (above the eave, no thickness); the overhang ring outside */
export interface RoofGrid {
  I: number;
  J: number;
  /** wall-line positions and heights, index j * (I + 1) + i */
  p: V2[];
  h: number[];
  /** each boundary point's side (0..3, -1 inner) — in the strip's own side numbering */
  side: number[];
  plan: RoofPlan;
}

/** sample the strip on its half-cell grid in (ridge, across) order and set the heights by the plan */
export function roofGrid(m: GridMesh, s: Strip, sides: StripSides, plan: RoofPlan, rp: RoofParams): RoofGrid {
  // the half-cell sample grid in strip coordinates (x along a: 0..2a, y along b: 0..2b)
  const A = 2 * s.a;
  const B = 2 * s.b;
  const g: V2[] = new Array((A + 1) * (B + 1));
  const gi = (x: number, y: number) => y * (A + 1) + x;
  const mid = (p: V2, q: V2): V2 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  for (let j = 0; j < s.b; j++) {
    for (let i = 0; i < s.a; i++) {
      const f = s.at[j][i];
      const c = [0, 1, 2, 3].map((k) => P(m, corner(m, f, k)) as V2);
      const x = 2 * i;
      const y = 2 * j;
      g[gi(x, y)] = c[0];
      g[gi(x + 2, y)] = c[1];
      g[gi(x + 2, y + 2)] = c[2];
      g[gi(x, y + 2)] = c[3];
      g[gi(x + 1, y)] = mid(c[0], c[1]);
      g[gi(x + 2, y + 1)] = mid(c[1], c[2]);
      g[gi(x + 1, y + 2)] = mid(c[2], c[3]);
      g[gi(x, y + 1)] = mid(c[3], c[0]);
      g[gi(x + 1, y + 1)] = centroid(m, f.c);
    }
  }
  // the boundary moved to the wall lines: a side's sample on edge e moves in by off[e] along the edge's normal; a
  // vertex between two edges of the strip outline by the two edges' offsets (their lines' crossing, or the mean when
  // nearly in line)
  const sideOf = (x: number, y: number): number[] => {
    const o: number[] = [];
    if (y === 0) o.push(0);
    if (x === A) o.push(1);
    if (y === B) o.push(2);
    if (x === 0) o.push(3);
    return o;
  };
  const nOf = (a: V2, b: V2): V2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
  };
  // an edge's endpoints in sample coords
  const edgePts = (sd: number, e: number): [V2, V2] => {
    if (sd === 0) return [g[gi(2 * e, 0)], g[gi(2 * e + 2, 0)]];
    if (sd === 1) return [g[gi(A, 2 * e)], g[gi(A, 2 * e + 2)]];
    if (sd === 2) return [g[gi(A - 2 * e, B)], g[gi(A - 2 * e - 2, B)]];
    return [g[gi(0, B - 2 * e)], g[gi(0, B - 2 * e - 2)]];
  };
  const wall: V2[] = g.slice();
  for (let y = 0; y <= B; y++) {
    for (let x = 0; x <= A; x++) {
      const sds = sideOf(x, y);
      if (!sds.length) continue;
      const v = g[gi(x, y)];
      // the edges meeting at this sample: on a side's interior even sample, the two consecutive edges of that side
      const lines: { n: V2; d: number }[] = [];
      for (const sd of sds) {
        const t = sd === 0 ? x : sd === 1 ? y : sd === 2 ? A - x : B - y;
        const n = sd === 0 || sd === 2 ? s.a : s.b;
        const es = t % 2 === 1 ? [Math.floor(t / 2)] : [t / 2 - 1, t / 2].filter((e) => e >= 0 && e < n);
        for (const e of es) {
          const [a, b] = edgePts(sd, e);
          lines.push({ n: nOf(a, b), d: sides.off[sd][e] });
        }
      }
      wall[gi(x, y)] = crossLines(v, lines);
    }
  }
  // (ridge i, across j) view of the sample grid
  const I = plan.alongA ? A : B;
  const J = plan.alongA ? B : A;
  // (ridge along b: i runs up y, j runs from x = A back to 0 — so j = 0 is side 1, keeping the frame's handedness)
  const at = (i: number, j: number) => (plan.alongA ? gi(i, j) : gi(A - j, i));
  // side numbering in (i, j): j = 0 is side sj0, j = J is sjJ, i = 0 is si0, i = I is siI
  const sj0 = plan.alongA ? 0 : 1;
  const sjJ = plan.alongA ? 2 : 3;
  const si0 = plan.alongA ? 3 : 0;
  const siI = plan.alongA ? 1 : 2;
  const p: V2[] = [];
  const side: number[] = [];
  for (let j = 0; j <= J; j++) {
    for (let i = 0; i <= I; i++) {
      p.push(wall[at(i, j)]);
      side.push(j === 0 ? sj0 : j === J ? sjJ : i === 0 ? si0 : i === I ? siI : -1);
    }
  }
  const idx = (i: number, j: number) => j * (I + 1) + i;
  const dist = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  // pitch caps: a lean-to and a gable end against a taller wall stay under its eave
  const head = Math.min(...sides.headroom) - rp.clearance;
  // (the profile is a function of j alone — the across distance averaged over the columns — and a hip's of i alone:
  // so along an end the roof is level going inwards, and the rule holds exactly in the strip's own coordinates; a
  // per-column width let a short end column with its corners pulled about by unequal offsets dip below its
  // neighbour, DEVLOG)
  const across = new Array(J + 1).fill(0);
  for (let i = 0; i <= I; i++) {
    let c = 0;
    for (let j = 1; j <= J; j++) {
      c += dist(p[idx(i, j - 1)], p[idx(i, j)]);
      across[j] += c / (I + 1);
    }
  }
  const h: number[] = new Array(p.length).fill(0);
  for (let i = 0; i <= I; i++) {
    const W = across[J];
    for (let j = 0; j <= J; j++) {
      const sAcross = across[j];
      let v = 0;
      if (plan.kind === 'gable' || plan.kind === 'hip' || plan.kind === 'pyramid') {
        const rise = Math.min(plan.pitch * W * 0.5, head);
        v = (rise / (W * 0.5)) * Math.min(sAcross, W - sAcross);
      } else if (plan.kind === 'shed') {
        // (a lean-to is shallower than the theme's pitch and never rises more than a storey's worth)
        const ps = Math.min(plan.pitch * 0.6, Math.max(0.08, Math.min(head, 2.4)) / W);
        v = ps * (plan.high === sjJ ? sAcross : W - sAcross);
      } else v = 0; // flat: a terrace
      h[idx(i, j)] = v;
    }
  }
  // hips: along each row the distance from a hipped end
  if (plan.kind === 'hip' || plan.kind === 'pyramid') {
    const cum = new Array(I + 1).fill(0);
    for (let j = 0; j <= J; j++) {
      let c = 0;
      for (let i = 1; i <= I; i++) {
        c += dist(p[idx(i - 1, j)], p[idx(i, j)]);
        cum[i] += c / (J + 1);
      }
    }
    const U = cum[I];
    for (let j = 0; j <= J; j++) {
      for (let i = 0; i <= I; i++) {
        if (plan.hips[si0]) h[idx(i, j)] = Math.min(h[idx(i, j)], plan.pitch * cum[i]);
        if (plan.hips[siI]) h[idx(i, j)] = Math.min(h[idx(i, j)], plan.pitch * (U - cum[i]));
      }
    }
  }
  return { I, J, p, h, side, plan };
}

/** the point where lines {x : x·n = v·n − d} cross (two or more; nearly parallel ones averaged) */
function crossLines(v: V2, lines: { n: V2; d: number }[]): V2 {
  if (lines.length === 1) return [v[0] - lines[0].n[0] * lines[0].d, v[1] - lines[0].n[1] * lines[0].d];
  const [l1, l2] = [lines[0], lines[lines.length - 1]];
  const det = l1.n[0] * l2.n[1] - l1.n[1] * l2.n[0];
  if (Math.abs(det) < 0.34) {
    // in line (within ~20°): the mean of the two moved points
    return [v[0] - (l1.n[0] * l1.d + l2.n[0] * l2.d) / 2, v[1] - (l1.n[1] * l1.d + l2.n[1] * l2.d) / 2];
  }
  const c1 = v[0] * l1.n[0] + v[1] * l1.n[1] - l1.d;
  const c2 = v[0] * l2.n[0] + v[1] * l2.n[1] - l2.d;
  return [(c1 * l2.n[1] - c2 * l1.n[1]) / det, (l1.n[0] * c2 - l2.n[0] * c1) / det];
}

/** the rule: along every abutting side, the roof does not rise going inwards from the wall (a slope whose low side is
 *  a taller wall would run its water into it). Returns the worst rise (metres per metre) found, ≤ 0 when it holds. */
export function slopeIntoWall(r: RoofGrid, sides: StripSides): number {
  let worst = -Infinity;
  const idx = (i: number, j: number) => j * (r.I + 1) + i;
  const check = (b: number, inner: number) => {
    const d = Math.hypot(r.p[inner][0] - r.p[b][0], r.p[inner][1] - r.p[b][1]) || 1;
    worst = Math.max(worst, (r.h[inner] - r.h[b]) / d);
  };
  const abut = sides.cls.map((c) => c.includes('abut'));
  for (let i = 0; i <= r.I; i++) {
    for (let j = 0; j <= r.J; j++) {
      const sd = r.side[idx(i, j)];
      if (sd < 0 || !abut[sd]) continue;
      // the inward neighbour across that side
      if (j === 0 && r.J > 0) check(idx(i, 0), idx(i, 1));
      else if (j === r.J && r.J > 0) check(idx(i, r.J), idx(i, r.J - 1));
      else if (i === 0 && r.I > 0) check(idx(0, j), idx(1, j));
      else if (i === r.I && r.I > 0) check(idx(r.I, j), idx(r.I - 1, j));
    }
  }
  return worst === -Infinity ? 0 : worst;
}
