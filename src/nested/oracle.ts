// Nested scales lab: the TypeScript ORACLE of the column maths (docs/design/NESTED_SCALES.md "Storage" → "The column
// maths"). The page runs the same maths as WGSL compute passes on pages (src/nested/gpu/*); this file is the reference
// the Node unit tests check the invariants on and the page self-test compares the GPU against. It is not on any
// interactive path. Square lattice, k x k blocks, f64.
//
// A column is STORED as a full partition of height (Part: records bottom up, air included, shared boundaries; see
// Level). The maths reads its SOLID VIEW (Col: the non-air intervals [z0, z1) with a material; interval 0 open
// downward; air between and above) and, inside enhance and restrict, its layer form: S (the top surface) and, for each
// interval i >= 1, gap_i (air below it) and th_i (its thickness). Level.set converts back at the boundary.

import { EDGE_MASK, RES_EDGE, edgeEnc, edgeFromChildren, edgeToChild } from './edge';

export const OPEN_BOTTOM = -1e30;
/** detail amplitude per wavelength (child columns) */
export const DETAIL_AMP = 0.08;

export interface Col {
  mat: number[];
  z0: number[];
  z1: number[];
  /** (round 22) per interval, the edge sample of its top (edge.ts; 0 or missing: none) */
  edge?: number[];
}
/** layer form: v[0] = S, v[2i-1] = gap_i, v[2i] = th_i for i >= 1 (length 2n - 1) */
export interface Layers {
  mat: number[];
  v: number[];
  edge?: number[];
}
/** (round 22) interval (or record) i's edge field */
export const edgeAt = (c: { edge?: number[] }, i: number): number => c.edge?.[i] ?? 0;

export function toLayers(c: Col): Layers {
  const n = c.mat.length;
  const v = new Array<number>(2 * n - 1);
  v[0] = c.z1[n - 1];
  for (let i = 1; i < n; i++) {
    v[2 * i - 1] = c.z0[i] - c.z1[i - 1];
    v[2 * i] = c.z1[i] - c.z0[i];
  }
  return { mat: c.mat.slice(), v, edge: c.mat.map((_m, i) => edgeAt(c, i)) };
}

export function fromLayers(l: Layers): Col {
  const n = l.mat.length;
  const z0 = new Array<number>(n);
  const z1 = new Array<number>(n);
  let z = l.v[0];
  for (let i = n - 1; i >= 1; i--) {
    z1[i] = z;
    z0[i] = z - l.v[2 * i];
    z = z0[i] - l.v[2 * i - 1];
  }
  z1[0] = z;
  z0[0] = OPEN_BOTTOM;
  return { mat: l.mat.slice(), z0, z1, edge: l.mat.map((_m, i) => edgeAt(l, i)) };
}

export const sameStructure = (a: { mat: number[] }, b: { mat: number[] }) => a.mat.length === b.mat.length && a.mat.every((m, i) => m === b.mat[i]);

// ---- hashing and detail (mirrored in WGSL: gpu/kernels.wgsl hash3 / valueNoise / detail) -----------------------------

export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 2147483648 - 1;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export function valueNoise(x: number, y: number, layer: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash3(ix, iy, layer, seed);
  const b = hash3(ix + 1, iy, layer, seed);
  const c = hash3(ix, iy + 1, layer, seed);
  const d = hash3(ix + 1, iy + 1, layer, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** the seeded detail at a child column (global coordinates of its depth), in child units */
export function detail(gx: number, gy: number, depth: number, k: number, seed: number, amp = DETAIL_AMP): number {
  let v = 0;
  // wavelengths 2 .. k/2: a block holds two periods or more, so its mean is small and the block correction (a sin²
  // bump, 4x the mean at its peak) stays faint; with k as well it showed as a regular pitting (DEVLOG 2026-11-18)
  for (let lam = 2, o = 0; lam * 2 <= k; lam *= 2, o++) v += amp * lam * valueNoise((gx + 0.5) / lam, (gy + 0.5) / lam, depth * 16 + o, seed);
  return v;
}

// ---- weights --------------------------------------------------------------------------------------------------------

/** Catmull-Rom weights of the four samples base-1 .. base+2 at t in [0, 1) */
export function crWeights(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}
/** child column a of a block (0..k-1): the parent sample it starts from (-1 or 0, relative to the block's) and t */
export function blockPos(a: number, k: number): { off: number; t: number } {
  const u = (a + 0.5) / k - 0.5;
  const off = u < 0 ? -1 : 0;
  return { off, t: u - off };
}
/** PPM (Colella-Woodward): the edge value between cells c0 and c1, limited to lie between them */
function ppmEdge(m1: number, c0: number, c1: number, p2: number): number {
  const e = (7 / 12) * (c0 + c1) - (1 / 12) * (m1 + p2);
  return Math.min(Math.max(e, Math.min(c0, c1)), Math.max(c0, c1));
}
/** The average over sub-cell a (of k) of the middle cell's limited parabola, from five cell averages q (q[2] the cell).
 *  Parent values are cell averages: the k sub-averages sum to k q[2] (mean-preserving by construction). A monotone
 *  cell keeps its parabola inside its edges (no overshoot past its neighbours); at an extremum the curvature is kept
 *  only where the neighbours curve the same way (Colella-Sekora), so a smooth hilltop is not flattened. nest.wgsl
 *  ppmSub is the same maths. */
export function ppmSub(q: number[], a: number, k: number): number {
  const c = q[2];
  let aL = ppmEdge(q[0], q[1], q[2], q[3]);
  let aR = ppmEdge(q[1], q[2], q[3], q[4]);
  if ((aR - c) * (c - aL) <= 0) {
    const d2 = 6 * (aL - 2 * c + aR);
    const d2c = q[1] - 2 * c + q[3];
    const d2l = q[0] - 2 * q[1] + c;
    const d2r = c - 2 * q[3] + q[4];
    let lim = 0;
    const s = Math.sign(d2);
    if (s !== 0 && Math.sign(d2c) === s && Math.sign(d2l) === s && Math.sign(d2r) === s) lim = s * Math.min(Math.abs(d2), 1.25 * Math.abs(d2c), 1.25 * Math.abs(d2l), 1.25 * Math.abs(d2r));
    if (d2 !== 0) {
      aL = c + ((aL - c) * lim) / d2;
      aR = c + ((aR - c) * lim) / d2;
    } else {
      aL = c;
      aR = c;
    }
  } else {
    const da = aR - aL;
    const m = c - 0.5 * (aL + aR);
    if (da * m > (da * da) / 6) aL = 3 * c - 2 * aR;
    else if (-(da * da) / 6 > da * m) aR = 3 * c - 2 * aL;
  }
  const da = aR - aL;
  const a6 = 6 * (c - 0.5 * (aL + aR));
  const F = (x: number) => aL * x + (da * x * x) / 2 + a6 * ((x * x) / 2 - (x * x * x) / 3);
  return (F((a + 1) / k) - F(a / k)) * k;
}
/** the top surface of child (a, b) of the block of parent column (px, py), relative to S(px, py): PPM along x on the five
 *  rows round the block, then along y */
export function ppm2(S: (x: number, y: number) => number, px: number, py: number, a: number, b: number, k: number): number {
  const ref = S(px, py);
  const rows: number[] = [];
  for (let j = 0; j < 5; j++) {
    const q: number[] = [];
    for (let i = 0; i < 5; i++) q.push(S(px - 2 + i, py - 2 + j) - ref);
    rows.push(ppmSub(q, a, k));
  }
  return ppmSub(rows, b, k);
}
export function bump(a: number, k: number): number {
  const s = Math.sin((Math.PI * (a + 0.5)) / k);
  return s * s;
}

// ---- levels ---------------------------------------------------------------------------------------------------------

export interface Frame {
  depth: number;
  /** global column of local column 0 at this depth (a multiple of 16: chunk aligned) */
  gx: number;
  gy: number;
  /** columns a side */
  n: number;
  /** z origin in the parent's local units (0 for the root) */
  z0: number;
}

/** a stored column: the FULL PARTITION of height, bottom up, air included (gpu: store.wgsl column pages). Record j is
 *  (top[j], mat[j]); its bottom is top[j - 1] (record 0 is open below); above the last record is air. No two adjacent
 *  records share a material, no record is empty, the last is not air. */
export interface Part {
  top: number[];
  mat: number[];
  /** (round 22) per record, the edge sample of its top (edge.ts; the material word's bits 8-29 on the GPU) */
  edge?: number[];
}
export const AIR = 0;

/** the partition of a solid view (the pass boundary, gpu: nest.wgsl pack): air where an interval starts above the last
 *  top; empty intervals dropped; adjacent records of one material merged (round 22: a merged record keeps the edge of
 *  the interval whose top it keeps; air records have none) */
export function toPart(c: Col): Part {
  const out: Part = { top: [], mat: [], edge: [] };
  const push = (t: number, m: number, e: number) => {
    const n = out.mat.length;
    if (n && t <= out.top[n - 1]) return;
    if (n && out.mat[n - 1] === m) {
      out.top[n - 1] = t;
      out.edge![n - 1] = e;
    } else {
      out.top.push(t);
      out.mat.push(m);
      out.edge!.push(e);
    }
  };
  for (let i = 0; i < c.mat.length; i++) {
    if (i > 0 && !(c.z1[i] > c.z0[i])) continue;
    const n = out.mat.length;
    if (n && i > 0 && c.z0[i] > out.top[n - 1]) push(c.z0[i], AIR, 0);
    push(c.z1[i], c.mat[i], edgeAt(c, i));
  }
  return out;
}
/** the solid view of a partition: its non-air records, each from the top below it (gpu: store.wgsl ivlAt) */
export function fromPart(p: Part): Col {
  const out: Col = { mat: [], z0: [], z1: [], edge: [] };
  for (let j = 0; j < p.mat.length; j++) {
    if (p.mat[j] === AIR) continue;
    out.mat.push(p.mat[j]);
    out.z0.push(j === 0 ? OPEN_BOTTOM : p.top[j - 1]);
    out.z1.push(p.top[j]);
    out.edge!.push(edgeAt(p, j));
  }
  return out;
}

export class Level {
  /** the stored columns (partitions) */
  readonly parts: Part[];
  /** their solid views, kept with them (the maths reads these) */
  private views: Col[];
  constructor(readonly f: Frame) {
    this.parts = new Array(f.n * f.n);
    this.views = new Array(f.n * f.n);
  }
  /** every column's solid view, row by row */
  get cols(): Col[] {
    return this.views;
  }
  /** column at global (x, y) of this depth (solid view), or undefined outside */
  at(x: number, y: number): Col | undefined {
    const i = x - this.f.gx;
    const j = y - this.f.gy;
    if (i < 0 || j < 0 || i >= this.f.n || j >= this.f.n) return undefined;
    return this.views[j * this.f.n + i];
  }
  /** column at global (x, y), clamped to the window (the root's world edge) */
  clamped(x: number, y: number): Col {
    const i = Math.min(this.f.n - 1, Math.max(0, x - this.f.gx));
    const j = Math.min(this.f.n - 1, Math.max(0, y - this.f.gy));
    return this.views[j * this.f.n + i];
  }
  /** a column stored: converted to the partition (normalised), its solid view read back from it */
  set(x: number, y: number, c: Col): void {
    const i = (y - this.f.gy) * this.f.n + (x - this.f.gx);
    this.parts[i] = toPart(c);
    this.views[i] = fromPart(this.parts[i]);
  }
}

/** a rectangle of global columns at one depth, half-open */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const union = (a: Rect | null, b: Rect | null): Rect | null => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const clip = (r: Rect, f: Frame): Rect | null => {
  const c = { x0: Math.max(r.x0, f.gx), y0: Math.max(r.y0, f.gy), x1: Math.min(r.x1, f.gx + f.n), y1: Math.min(r.y1, f.gy + f.n) };
  return c.x0 < c.x1 && c.y0 < c.y1 ? c : null;
};

export type EditOp = 'raise' | 'dig' | 'carve' | 'add';
/** a column's residual: per bound (whole false) or the column itself relative to the enhanced surface (whole) */
export interface Res {
  whole: boolean;
  mat?: number[];
  r: number[];
  /** (round 22) per interval: a whole column's edge fields; a per-bound residual's overrides (RES_EDGE | the live
   *  field, where the live edge differs from the enhanced one; 0: the enhanced edge stands) */
  edge?: number[];
}

/** the chain of live levels over one root, with each depth's sparse residual (global column key -> residual) */
export class Nest {
  readonly levels: Level[];
  readonly res: Map<number, Res>[] = [];
  /** the seeded detail's amplitude per wavelength (0: none, the tests' no-overshoot check) */
  detailAmp = DETAIL_AMP;
  constructor(
    root: Level,
    readonly k: number,
    readonly seed: number,
  ) {
    this.levels = [root];
    for (let d = 0; d < 8; d++) this.res.push(new Map());
  }
  rowWidth(depth: number): number {
    return this.levels[0].f.n * this.k ** depth;
  }
  key(depth: number, x: number, y: number): number {
    return y * this.rowWidth(depth) + x;
  }

  /** enhance(parent) for the block of parent column (px, py) (global, parent depth) into child frame f: k² layer columns */
  enhanceBlock(parent: Level, f: Frame, px: number, py: number): Layers[] {
    const k = this.k;
    const own = toLayers(parent.clamped(px, py));
    const pref = own.v[0];
    // (round 10) between same-structure cells only, as the gaps and thicknesses: a neighbour of another structure counts
    // at the block's own top (else a cave's thin roof followed the top down to the floor where the ball broke through:
    // a staircase of floating roof pieces)
    const S = (x: number, y: number) => {
      const c = parent.clamped(x, y);
      return sameStructure(c, own) ? toLayers(c).v[0] : pref;
    };
    const out: Layers[] = [];
    let sum = 0;
    for (let b = 0; b < k; b++) {
      for (let a = 0; a < k; a++) {
        // the top surface: a limited, mean-preserving PPM of the parent's cell averages (NS-34; was Catmull-Rom with a
        // per-block bump restoring the mean, which made a spire per block at a step); the bump below now carries only
        // the detail's block mean and rounding
        const fsum = ppm2(S, px, py, a, b, k);
        const s = (pref - f.z0) * k + fsum * k + detail(px * k + a, py * k + b, f.depth, k, this.seed, this.detailAmp);
        sum += s;
        // (round 22) each interval's edge: the parent's line seen from this child (edge.ts edgeToChild; none past range)
        const ox = (a + 0.5) / k - 0.5;
        const oy = (b + 0.5) / k - 0.5;
        out.push({ mat: own.mat.slice(), v: [s], edge: own.mat.map((_m, i) => edgeToChild(edgeAt(own, i), ox, oy, k)) });
      }
    }
    const D = k * k * k * (pref - f.z0) - sum;
    for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) out[b * k + a].v[0] += (D * bump(a, k) * bump(b, k)) / ((k * k) / 4);
    // gaps and thicknesses: bilinear over compatible samples, then scaled to the parent's mean
    const n = own.mat.length;
    for (let li = 1; li < 2 * n - 1; li++) {
      const vals: number[] = [];
      let B = 0;
      for (let b = 0; b < k; b++) {
        const by = blockPos(b, k);
        for (let a = 0; a < k; a++) {
          const bx = blockPos(a, k);
          let v = 0;
          for (let jj = 0; jj < 2; jj++)
            for (let ii = 0; ii < 2; ii++) {
              const s = toLayers(parent.clamped(px + bx.off + ii, py + by.off + jj));
              const sv = sameStructure(s, own) ? s.v[li] : own.v[li];
              v += (ii ? bx.t : 1 - bx.t) * (jj ? by.t : 1 - by.t) * sv * k;
            }
          vals.push(v);
          B += v;
        }
      }
      const T = k * k * k * own.v[li];
      for (let q = 0; q < k * k; q++) out[q].v[li] = B > 0 ? (vals[q] * T) / B : T / (k * k);
    }
    return out;
  }

  /** restrict: the parent column over the block of child columns at parent (px, py). Children of one structure: the
   *  mean of each bound in layer form. Children of different structures (a carve or an add): the TEMPLATE (the child
   *  with the most intervals, the first on a tie) with its thicknesses scaled per material, and its gaps scaled, so
   *  that the parent holds the block's mean volume of each material and of enclosed air; the top is the block's mean
   *  surface. A material the template lacks cannot be placed: counted (mismatch). */
  restrictCell(child: Level, px: number, py: number): Col {
    const k = this.k;
    const kk = k * k;
    const cols: Col[] = [];
    for (let b = 0; b < k; b++)
      for (let a = 0; a < k; a++) {
        const c = child.at(px * k + a, py * k + b);
        if (!c) throw new Error('restrict outside the child');
        cols.push(c);
      }
    let t = cols[0];
    for (const c of cols) if (c.mat.length > t.mat.length) t = c;
    const z0 = child.f.z0;
    // (round 22) each interval's edge from the children of the template's interval count that keep one (edge.ts
    // edgeFromChildren: the mean normal, the mean line point), children in row order
    const offs: [number, number][] = [];
    for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) offs.push([(a + 0.5) / k - 0.5, (b + 0.5) / k - 0.5]);
    const edge = t.mat.map((_m, i) => edgeFromChildren(cols.map((c) => (c.mat.length === t.mat.length ? edgeAt(c, i) : 0)), offs, k));
    if (cols.every((c) => sameStructure(c, t))) {
      const acc = toLayers(t).v.map(() => 0);
      for (const c of cols) toLayers(c).v.forEach((v, i) => (acc[i] += v));
      return fromLayers({ mat: t.mat.slice(), v: acc.map((s, i) => (i === 0 ? z0 + s / kk / k : s / kk / k)), edge });
    }
    const vol = (c: Col) => {
      const m = new Map<number, number>();
      let air = 0;
      for (let i = 1; i < c.mat.length; i++) {
        m.set(c.mat[i], (m.get(c.mat[i]) ?? 0) + (c.z1[i] - c.z0[i]));
        air += c.z0[i] - c.z1[i - 1];
      }
      return { m, air };
    };
    const mean = new Map<number, number>();
    let air = 0;
    let S = 0;
    for (const c of cols) {
      const v = vol(c);
      for (const [m, x] of v.m) mean.set(m, (mean.get(m) ?? 0) + x / kk);
      air += v.air / kk;
      S += c.z1[c.mat.length - 1] / kk;
    }
    const tv = vol(t);
    const n = t.mat.length;
    const out: Col = { mat: t.mat.slice(), z0: new Array(n), z1: new Array(n), edge };
    let z = z0 + S / k;
    for (let i = n - 1; i >= 1; i--) {
      const m = t.mat[i];
      const tm = tv.m.get(m)!;
      const th = tm > 0 ? ((t.z1[i] - t.z0[i]) * (mean.get(m)! / tm)) / k : 0;
      out.z1[i] = z;
      out.z0[i] = z - th;
      z = out.z0[i] - (tv.air > 0 ? ((t.z0[i] - t.z1[i - 1]) * (air / tv.air)) / k : 0);
    }
    out.z1[0] = z;
    out.z0[0] = OPEN_BOTTOM;
    return out;
  }

  /** the window's parent cells: global parent columns the child level covers */
  private coverInParent(f: Frame): Rect {
    return { x0: f.gx / this.k, y0: f.gy / this.k, x1: (f.gx + f.n) / this.k, y1: (f.gy + f.n) / this.k };
  }

  /** derive the child over parent rect pr (global parent columns): enhance + residual */
  private derive(depth: number, pr: Rect): void {
    const child = this.levels[depth];
    const parent = this.levels[depth - 1];
    const k = this.k;
    const res = this.res[depth];
    for (let py = pr.y0; py < pr.y1; py++)
      for (let px = pr.x0; px < pr.x1; px++) {
        const E = this.enhanceBlock(parent, child.f, px, py);
        for (let b = 0; b < k; b++)
          for (let a = 0; a < k; a++) {
            const e = fromLayers(E[b * k + a]);
            const rr = res.get(this.key(depth, px * k + a, py * k + b));
            if (rr?.whole) {
              // a column whose structure differs from its enhanced parent: carried whole, its bounds relative to the
              // enhanced surface (so it rides on parent changes under it)
              const S = e.z1[e.mat.length - 1];
              const n = rr.mat!.length;
              const c: Col = { mat: rr.mat!.slice(), z0: new Array(n), z1: new Array(n), edge: rr.mat!.map((_m, i) => rr.edge?.[i] ?? 0) };
              for (let i = n - 1; i >= 0; i--) {
                const at = 4 * (n - 1 - i);
                c.z1[i] = S + rr.r[at] + rr.r[at + 1];
                c.z0[i] = i > 0 ? S + rr.r[at + 2] + rr.r[at + 3] : OPEN_BOTTOM;
              }
              child.set(px * k + a, py * k + b, c);
              continue;
            }
            // (a per-bound residual of another length: the structure changed under it; it no longer applies: NS-19)
            const r = rr && rr.r.length === 4 * e.mat.length - 2 ? rr.r : undefined;
            // the residual per bound; the bounds kept in order (a no-op when nothing changed under them)
            let prev = Infinity;
            const n = e.mat.length;
            const add = (v: number, at: number) => (r ? v + r[at] + r[at + 1] : v);
            for (let i = n - 1; i >= 0; i--) {
              e.z1[i] = Math.min(add(e.z1[i], 4 * (n - 1 - i)), prev);
              if (i > 0) e.z0[i] = Math.min(add(e.z0[i], 4 * (n - 1 - i) + 2), e.z1[i]);
              prev = e.z0[i];
              // (round 22) the residual's edge override where it applies
              const ov = r ? (rr!.edge?.[i] ?? 0) : 0;
              if (ov & RES_EDGE) e.edge![i] = ov & EDGE_MASK;
            }
            child.set(px * k + a, py * k + b, e);
          }
      }
  }

  /** residual = live - enhance(parent) over parent rect pr, kept only where non-zero */
  private residual(depth: number, pr: Rect): void {
    const child = this.levels[depth];
    const parent = this.levels[depth - 1];
    const k = this.k;
    const res = this.res[depth];
    for (let py = pr.y0; py < pr.y1; py++)
      for (let px = pr.x0; px < pr.x1; px++) {
        const E = this.enhanceBlock(parent, child.f, px, py);
        for (let b = 0; b < k; b++)
          for (let a = 0; a < k; a++) {
            const key = this.key(depth, px * k + a, py * k + b);
            const live = child.at(px * k + a, py * k + b)!;
            const e = fromLayers(E[b * k + a]);
            // per bound, top down, two floats each: z1 then z0 of each interval (interval 0: z1 only, its z0 is open).
            // A live column of another structure than its enhanced parent is kept whole, relative to the enhanced
            // surface.
            const whole = !sameStructure(live, e);
            const S = e.z1[e.mat.length - 1];
            const r: number[] = [];
            for (let i = live.mat.length - 1; i >= 0; i--) {
              r.push(...resPair(live.z1[i], whole ? S : e.z1[i]));
              if (i > 0) r.push(...resPair(live.z0[i], whole ? S : e.z0[i]));
            }
            // (round 22) edges: a whole column keeps its own; a per-bound residual overrides where live and enhanced differ
            const edge = live.mat.map((_m, i) => (whole ? edgeAt(live, i) : edgeAt(live, i) !== edgeAt(e, i) ? RES_EDGE | edgeAt(live, i) : 0));
            if (whole || r.some((x) => x !== 0) || edge.some((x) => x !== 0)) res.set(key, { whole, mat: whole ? live.mat.slice() : undefined, r, edge });
            else res.delete(key);
          }
      }
  }

  /** a child level at frame f (its depth = the chain's length): enhance(parent) + residual */
  promote(f: Frame): Level {
    if (f.depth !== this.levels.length) throw new Error(`promote depth ${f.depth}, chain ${this.levels.length}`);
    const lv = new Level(f);
    this.levels.push(lv);
    this.derive(f.depth, this.coverInParent(f));
    return lv;
  }
  /** drop the level at depth and every deeper one; their residuals stay */
  demote(depth: number): void {
    this.levels.length = depth;
  }
  /** move the level at depth to frame f (same depth, same z0): the chain below is dropped */
  slide(f: Frame): Level {
    this.demote(f.depth);
    return this.promote(f);
  }

  /** an edit at a depth: a brush over global columns of that depth, then restrict up every ancestor, residuals and
   *  derive down */
  /** cz: the ball's centre height (local units of that depth; carve and add) */
  edit(depth: number, op: EditOp, cx: number, cy: number, r: number, amount: number, cz = 0): void {
    const lv = this.levels[depth];
    const ballOp = op === 'carve' || op === 'add';
    // (round 22) a ball's box grows by EDGE_PAD: the columns round its outline get the edge sample too (nest.wgsl plan)
    const pad = ballOp ? EDGE_PAD : 0;
    const box = clip({ x0: Math.floor(cx - r) - pad, y0: Math.floor(cy - r) - pad, x1: Math.ceil(cx + r) + 1 + pad, y1: Math.ceil(cy + r) + 1 + pad }, lv.f);
    if (!box) return;
    for (let y = box.y0; y < box.y1; y++)
      for (let x = box.x0; x < box.x1; x++) {
        const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const d = dd / r;
        if (ballOp) {
          const c0 = lv.at(x, y)!;
          const c = d < 1 ? applyBall(c0, op, cz - Math.sqrt(r * r - dd * dd), cz + Math.sqrt(r * r - dd * dd)) : c0;
          lv.set(x, y, ballEdge(c, ballSample(x + 0.5 - cx, y + 0.5 - cy, c0.z1[c0.z1.length - 1] - cz, r)));
          continue;
        }
        if (d >= 1) continue;
        const p = (1 - d * d) * (1 - d * d);
        lv.set(x, y, applyOp(lv.at(x, y)!, op, amount * p));
      }
    // (round 10) a material write clears every finer depth's residual under the columns its ball covers, live or
    // dropped (the owner: "I expect boolean deletion to delete parents and all children in those sub cells"); there the
    // finer levels are enhance(parent) again (nest.wgsl resClear)
    if (op === 'carve' || op === 'add')
      for (let m = depth + 1; m < this.res.length; m++) {
        const s = this.k ** (m - depth);
        const w = this.rowWidth(m);
        for (const key of [...this.res[m].keys()]) {
          const ax = Math.floor((key % w) / s);
          const ay = Math.floor(Math.floor(key / w) / s);
          if (ax < box.x0 || ay < box.y0 || ax >= box.x1 || ay >= box.y1) continue;
          if (Math.hypot(ax + 0.5 - cx, ay + 0.5 - cy) < r) this.res[m].delete(key);
        }
      }
    this.propagate(depth, box);
  }

  /** set a column of the level at depth (tests: a hand-made column), then propagate */
  setColumn(depth: number, x: number, y: number, c: Col): void {
    this.levels[depth].set(x, y, c);
    this.propagate(depth, { x0: x, y0: y, x1: x + 1, y1: y + 1 });
  }

  propagate(depth: number, box: Rect): void {
    const k = this.k;
    const changed: (Rect | null)[] = this.levels.map(() => null);
    changed[depth] = box;
    for (let m = depth; m >= 1; m--) {
      const c = changed[m]!;
      const pr = { x0: Math.floor(c.x0 / k), y0: Math.floor(c.y0 / k), x1: Math.ceil(c.x1 / k), y1: Math.ceil(c.y1 / k) };
      for (let py = pr.y0; py < pr.y1; py++)
        for (let px = pr.x0; px < pr.x1; px++) this.levels[m - 1].set(px, py, this.restrictCell(this.levels[m], px, py));
      changed[m - 1] = union(changed[m - 1], pr);
    }
    // top down: each level's residual against its (final) parent, then derived again from it
    for (let m = 1; m < this.levels.length; m++) {
      const f = this.levels[m].f;
      const cover = this.coverInParent(f);
      const sup = changed[m - 1] ? { x0: changed[m - 1]!.x0 - 2, y0: changed[m - 1]!.y0 - 2, x1: changed[m - 1]!.x1 + 2, y1: changed[m - 1]!.y1 + 2 } : null;
      const own = changed[m] ? { x0: Math.floor(changed[m]!.x0 / k), y0: Math.floor(changed[m]!.y0 / k), x1: Math.ceil(changed[m]!.x1 / k), y1: Math.ceil(changed[m]!.y1 / k) } : null;
      const u = union(sup, own);
      if (!u) continue;
      const pr = { x0: Math.max(u.x0, cover.x0), y0: Math.max(u.y0, cover.y0), x1: Math.min(u.x1, cover.x1), y1: Math.min(u.y1, cover.y1) };
      if (pr.x0 >= pr.x1 || pr.y0 >= pr.y1) continue;
      // at and above the edit the live columns stay and the residual takes up the parent's change; below, the live
      // columns follow their parent
      if (m <= depth) this.residual(m, pr);
      else {
        this.derive(m, pr);
        changed[m] = { x0: pr.x0 * k, y0: pr.y0 * k, x1: pr.x1 * k, y1: pr.y1 * k };
      }
    }
  }

  /** world placement of a depth: world = origin + local / scale */
  origin(depth: number): { x: number; y: number; z: number; s: number } {
    let z = 0;
    for (let m = 1; m <= depth; m++) z += this.levels[m].f.z0 / this.k ** (m - 1);
    const s = this.k ** depth;
    return { x: this.levels[depth].f.gx / s, y: this.levels[depth].f.gy / s, z, s };
  }
}

/** a bound's residual as two floats: (e + hi) + lo === live exactly, so deriving reproduces the live column (one float
 *  cannot when live's ulp is finer than e's; gpu: nest.wgsl putRes) */
export function resPair(live: number, e: number): [number, number] {
  const hi = live - e;
  return [hi, live - (e + hi)];
}

/** the camera's distance from local point p to column (i, j)'s solid boxes (the column's own square, as drawn; gpu:
 *  nest.wgsl colDist). Infinity: no solid. */
export function colDist(c: Col, i: number, j: number, p: [number, number, number]): number {
  const dx = Math.max(0, Math.abs(p[0] - (i + 0.5)) - 0.5);
  const dy = Math.max(0, Math.abs(p[1] - (j + 0.5)) - 0.5);
  let best = Infinity;
  for (let q = 0; q < c.z1.length; q++) {
    const z0 = q === 0 ? -Infinity : c.z0[q];
    best = Math.min(best, Math.max(0, z0 - p[2], p[2] - c.z1[q]));
  }
  return best === Infinity ? Infinity : Math.hypot(dx, dy, best);
}

/** fractal value noise, roughly [-1, 1] */
export function fbm(x: number, y: number, octaves: number, seed: number): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    v += amp * valueNoise(x * f, y * f, 100 + o, seed);
    f *= 2;
    amp *= 0.5;
  }
  return v;
}

/** the root's height (root units) at column centre (x, y) of an n-wide map: hills and a winding valley (mirrored in
 *  WGSL rootHeight) */
export function rootHeight(x: number, y: number, n: number, seed: number): number {
  const u = (x + 0.5) / n;
  const v = (y + 0.5) / n;
  const hills = 0.5 + 0.5 * fbm(u * 4, v * 4, 5, seed);
  const yv = 0.5 + 0.13 * Math.sin(u * 7.0 + seed * 0.37) + 0.05 * Math.sin(u * 17.0);
  const dv = Math.abs(v - yv);
  const valley = 0.15 + 0.85 * smooth(Math.min(1, dv / 0.2));
  return (n / 256) * (4 + 40 * hills * valley);
}

/** the root level: stone (open below) under a soil interval (mirrored by the GPU root pass) */
export function makeRoot(n: number, seed: number): Level {
  const lv = new Level({ depth: 0, gx: 0, gy: 0, n, z0: 0 });
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const s = rootHeight(x, y, n, seed);
      const soil = 0.25 + 0.15 * valueNoise(x / 6, y / 6, 7, seed);
      lv.set(x, y, { mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, s - soil], z1: [s - soil, s] });
    }
  return lv;
}

/** the lab's materials */
export const MAT = { stone: 1, soil: 2, sand: 3, clay: 4 } as const;

/** a ball's z-span [lo, hi] on one column, in the solid view: carve leaves air there (an interval it lies inside splits
 *  in two; ones inside it go; interval 0 stays open below), add fills the air there with soil. Stored back as the
 *  partition (Level.set), soil touching soil is one record, so repeated adds cannot pile up intervals (gpu: nest.wgsl
 *  ball, then pack) */
export function applyBall(c: Col, op: 'carve' | 'add', lo: number, hi: number): Col {
  const out: Col = { mat: [], z0: [], z1: [], edge: [] };
  // (round 22) an interval whose top the ball leaves keeps its edge; a top the ball made has none (ballEdge sets the
  // column's topmost one)
  const push = (m: number, a: number, b: number, e = 0) => {
    out.mat.push(m);
    out.z0.push(a);
    out.z1.push(b);
    out.edge!.push(e);
  };
  const n = c.mat.length;
  for (let i = 0; i < n; i++) {
    if (op === 'add' && i > 0) {
      const a = Math.max(c.z1[i - 1], lo);
      const b = Math.min(c.z0[i], hi);
      if (a < b) push(MAT.soil, a, b);
    }
    if (op === 'carve' && c.z1[i] > lo && c.z0[i] < hi) {
      if (c.z0[i] < lo) push(c.mat[i], c.z0[i], lo);
      if (c.z1[i] > hi) push(c.mat[i], out.mat.length ? hi : OPEN_BOTTOM, c.z1[i], edgeAt(c, i));
    } else push(c.mat[i], c.z0[i], c.z1[i], edgeAt(c, i));
  }
  if (op === 'add') {
    const a = Math.max(c.z1[n - 1], lo);
    if (a < hi) push(MAT.soil, a, hi);
  }
  if (!out.mat.length) throw new Error('carve removed the whole column');
  out.z0[0] = OPEN_BOTTOM;
  return out;
}

/** (round 22) the columns round a ball's outline whose edge sample is written (nest.wgsl EDGE_PAD) */
export const EDGE_PAD = 3;
/** (round 22) a ball's edge sample for a column whose centre is (dx, dy) from the ball's centre, at height dz over the
 *  ball's centre (the column's ORIGINAL top: for a carve's rim the circle where the sphere cuts the original surface):
 *  the circle where the sphere cuts that height, as the column's tangent line (edge.ts; 0 where the sphere does not
 *  reach that height or the line is past the range) (gpu: nest.wgsl ballEdgeAt) */
export function ballSample(dx: number, dy: number, dz: number, r: number): number {
  if (!(Math.abs(dz) < r)) return 0;
  const R = Math.sqrt(r * r - dz * dz);
  const rho = Math.hypot(dx, dy);
  return rho > 0 ? edgeEnc(dx / rho, dy / rho, R - rho) : edgeEnc(1, 0, R);
}
/** (round 22) a ball's result column c (from c0) with its topmost interval's edge: the sample where there is one, else
 *  what applyBall left (none where the ball changed that top, the old one where it did not) */
export function ballEdge(c: Col, e: number): Col {
  const out: Col = { mat: c.mat.slice(), z0: c.z0.slice(), z1: c.z1.slice(), edge: c.mat.map((_m, i) => edgeAt(c, i)) };
  if (e) out.edge![out.mat.length - 1] = e;
  return out;
}

/** a brush step on one column: raise adds to the top interval; dig removes from the top down (emptied intervals stay,
 *  with zero thickness, at the new surface; interval 0 is open below and never runs out) */
export function applyOp(c: Col, op: EditOp, a: number): Col {
  const n = c.mat.length;
  const z0 = c.z0.slice();
  const z1 = c.z1.slice();
  // (round 22) a top this moves loses its edge sample (raise and dig make no sharp edge)
  const edge = c.mat.map((_m, i) => edgeAt(c, i));
  if (op === 'raise') {
    z1[n - 1] += a;
    edge[n - 1] = 0;
  } else {
    const top = z1[n - 1] - a;
    for (let i = n - 1; i >= 0; i--) {
      if (z1[i] > top) {
        z1[i] = top;
        edge[i] = 0;
      }
      if (i > 0 && z0[i] > top) z0[i] = top;
    }
  }
  return { mat: c.mat.slice(), z0, z1, edge };
}
