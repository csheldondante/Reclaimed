// Nested scales lab: the TypeScript ORACLE of the column maths (docs/design/NESTED_SCALES.md "Storage" → "The column
// maths"). The page runs the same maths as WGSL compute passes on pages (src/nested/gpu/*); this file is the reference
// the Node unit tests check the invariants on and the page self-test compares the GPU against. It is not on any
// interactive path. Square lattice, k x k blocks, f64.
//
// A column is an ordered list of intervals [z0, z1) with a material. Interval 0 is open downward (OPEN_BOTTOM);
// above the last is air. In layer form: S (the top surface) and, for each interval i >= 1, gap_i (air below it) and
// th_i (its thickness).

export const OPEN_BOTTOM = -1e30;
/** detail amplitude per wavelength (child columns) */
export const DETAIL_AMP = 0.08;

// ---- footprints (docs/design/NESTED_SCALES.md "Footprints") ------------------------------------------------------------
// Every interval i carries two signed distances in plan, in its level's column units, positive inside: eS to the edge of
// its own footprint (where the solid exists) and eG to the edge of the gap below it (where the air between i - 1 and i
// exists). A negative one is a GHOST: the interval (gap) keeps its place in the column's structure with bounds where it
// would be, but it is not solid (not air). The GPU keeps both as f16 in the fourth word of the interval record.
/** "present, far from any edge": the value of a column no footprint has touched */
export const E_FAR = 1024;
/** the ring of ghosts a brush writes outside its footprint (columns): marching needs the neighbour across every edge,
 *  the diagonal one included (sqrt 2 < 1.5). (3 was tried, F4: no fewer open edges, more ghosts.) */
export const RING = 1.5;
/** restrict clamps child distances to +-E_SAT * k before the mean (a block's far values do not swamp a contour in it) */
export const E_SAT = 2;
/** a thin air gap (local units) is drawn and treated as solid (draw.wgsl GAP_MIN) */
export const GAP_MIN = 0.25;

export interface Col {
  mat: number[];
  z0: number[];
  z1: number[];
  /** footprint distances (absent: E_FAR, present everywhere); eG[0] is unused (interval 0 has no gap below) */
  eS?: number[];
  eG?: number[];
}
export const esOf = (c: Col, i: number) => c.eS?.[i] ?? E_FAR;
export const egOf = (c: Col, i: number) => (i === 0 ? E_FAR : c.eG?.[i] ?? E_FAR);
/** the one test for a ghost, every consumer (restrict's volumes, the camera, the pick, the brushes, melt, the draw) */
export const present = (e: number) => e > 0;
/** the column's interval i is solid (interval 0 always is) */
export const solidAt = (c: Col, i: number) => i === 0 || present(esOf(c, i));
/** the gap below interval i is air: present and not thinner than GAP_MIN */
export const airAt = (c: Col, i: number) => i > 0 && present(egOf(c, i)) && c.z0[i] - c.z1[i - 1] >= GAP_MIN;
/** the column's top present surface (the draw's top sheet; the layer form's S is the last interval's z1, ghost or not) */
export function topPresent(c: Col): number {
  for (let i = c.mat.length - 1; i > 0; i--) if (solidAt(c, i)) return c.z1[i];
  return c.z1[0];
}
const withE = (c: Col): Col => ({ ...c, eS: c.mat.map((_m, i) => esOf(c, i)), eG: c.mat.map((_m, i) => egOf(c, i)) });

/** layer form: v[0] = S, v[2i-1] = gap_i, v[2i] = th_i for i >= 1 (length 2n - 1); es, eg per interval */
export interface Layers {
  mat: number[];
  v: number[];
  es: number[];
  eg: number[];
}

export function toLayers(c: Col): Layers {
  const n = c.mat.length;
  const v = new Array<number>(2 * n - 1);
  v[0] = c.z1[n - 1];
  for (let i = 1; i < n; i++) {
    v[2 * i - 1] = c.z0[i] - c.z1[i - 1];
    v[2 * i] = c.z1[i] - c.z0[i];
  }
  return { mat: c.mat.slice(), v, es: c.mat.map((_m, i) => esOf(c, i)), eg: c.mat.map((_m, i) => egOf(c, i)) };
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
  return { mat: l.mat.slice(), z0, z1, eS: l.es.slice(), eG: l.eg.slice() };
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
/** round to the nearest f16 (ties to even), as the GPU stores a footprint distance (pack2x16float) */
export function q16(x: number): number {
  // (no negative zero: a residual must give back the stored value itself)
  if (x === 0) return 0;
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  if (a >= 65520) return Math.sign(x) * Infinity;
  const e = Math.max(-14, Math.floor(Math.log2(a)));
  const ulp = 2 ** (e - 10);
  const m = a / ulp;
  let r = Math.round(m);
  if (Math.abs(m - Math.trunc(m) - 0.5) < 1e-12 && r % 2 === 1) r -= 1;
  return r === 0 ? 0 : Math.sign(x) * r * ulp;
}
/** a parent's distance in child columns: times k, kept within +-E_FAR, as stored */
export const eScale = (v: number, k: number) => q16(Math.min(E_FAR, Math.max(-E_FAR, v * k)));

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

export class Level {
  readonly cols: Col[];
  constructor(readonly f: Frame) {
    this.cols = new Array(f.n * f.n);
  }
  /** column at global (x, y) of this depth, or undefined outside */
  at(x: number, y: number): Col | undefined {
    const i = x - this.f.gx;
    const j = y - this.f.gy;
    if (i < 0 || j < 0 || i >= this.f.n || j >= this.f.n) return undefined;
    return this.cols[j * this.f.n + i];
  }
  /** column at global (x, y), clamped to the window (the root's world edge) */
  clamped(x: number, y: number): Col {
    const i = Math.min(this.f.n - 1, Math.max(0, x - this.f.gx));
    const j = Math.min(this.f.n - 1, Math.max(0, y - this.f.gy));
    return this.cols[j * this.f.n + i];
  }
  set(x: number, y: number, c: Col): void {
    this.cols[(y - this.f.gy) * this.f.n + (x - this.f.gx)] = c;
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
  /** footprints, two an interval (eS, eG): live minus the enhanced value as stored (exact: both are f16 values), or
   *  (whole) the live values themselves */
  e: number[];
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
    const S = (x: number, y: number) => toLayers(parent.clamped(x, y)).v[0];
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
        out.push({ mat: own.mat.slice(), v: [s], es: [], eg: [] });
      }
    }
    // footprints: the same bilinear stencil over compatible samples, times k (child columns are k times finer); no mean
    // correction (a distance, not an amount)
    for (let b = 0; b < k; b++) {
      const by = blockPos(b, k);
      for (let a = 0; a < k; a++) {
        const bx = blockPos(a, k);
        const q = out[b * k + a];
        for (let i = 0; i < own.mat.length; i++) {
          let vs = 0;
          let vg = 0;
          for (let jj = 0; jj < 2; jj++)
            for (let ii = 0; ii < 2; ii++) {
              const s = toLayers(parent.clamped(px + bx.off + ii, py + by.off + jj));
              const ok = sameStructure(s, own);
              const w = (ii ? bx.t : 1 - bx.t) * (jj ? by.t : 1 - by.t);
              vs += w * (ok ? s.es[i] : own.es[i]);
              vg += w * (ok ? s.eg[i] : own.eg[i]);
            }
          q.es.push(eScale(vs, k));
          q.eg.push(eScale(vg, k));
        }
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
    // footprints: the mean of the children's (clamped to +-E_SAT k, so a block's far values do not swamp a contour in it)
    // over the children of the template's interval count, in parent columns
    const sat = E_SAT * k;
    const es: number[] = [];
    const eg: number[] = [];
    for (let i = 0; i < t.mat.length; i++) {
      let s = 0;
      let g = 0;
      let c = 0;
      for (const ch of cols)
        if (ch.mat.length === t.mat.length) {
          s += Math.min(sat, Math.max(-sat, esOf(ch, i)));
          g += Math.min(sat, Math.max(-sat, egOf(ch, i)));
          c++;
        }
      // (a block saturated everywhere stays "far": restrict then gives back E_FAR from an unedited block)
      const back = (m: number) => (m >= sat ? E_FAR : m <= -sat ? -E_FAR : q16(m / k));
      es.push(back(s / c));
      eg.push(back(g / c));
    }
    if (cols.every((c) => sameStructure(c, t))) {
      const acc = toLayers(t).v.map(() => 0);
      for (const c of cols) toLayers(c).v.forEach((v, i) => (acc[i] += v));
      return fromLayers({ mat: t.mat.slice(), v: acc.map((s, i) => (i === 0 ? z0 + s / kk / k : s / kk / k)), es, eg });
    }
    // (a ghost's thickness is not solid: it counts as enclosed air)
    const vol = (c: Col) => {
      const m = new Map<number, number>();
      let air = 0;
      for (let i = 1; i < c.mat.length; i++) {
        const th = c.z1[i] - c.z0[i];
        const gap = c.z0[i] - c.z1[i - 1];
        if (solidAt(c, i)) m.set(c.mat[i], (m.get(c.mat[i]) ?? 0) + th);
        else air += th;
        if (present(egOf(c, i))) air += gap;
        else m.set(c.mat[i], (m.get(c.mat[i]) ?? 0) + gap);
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
    const out: Col = { mat: t.mat.slice(), z0: new Array(n), z1: new Array(n), eS: es, eG: eg };
    let z = z0 + S / k;
    // each part of the template scaled by its kind's ratio: a solid part by its material's, air (a gap, or a ghost
    // interval) by the enclosed air's
    const sc = (v: number, solid: boolean, m: number) => {
      const tm = solid ? tv.m.get(m) ?? 0 : tv.air;
      const mm = solid ? mean.get(m) ?? 0 : air;
      return tm > 0 ? (v * (mm / tm)) / k : 0;
    };
    for (let i = n - 1; i >= 1; i--) {
      const m = t.mat[i];
      const th = sc(t.z1[i] - t.z0[i], solidAt(t, i), m);
      out.z1[i] = z;
      out.z0[i] = z - th;
      z = out.z0[i] - sc(t.z0[i] - t.z1[i - 1], !present(egOf(t, i)), m);
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
              const c: Col = { mat: rr.mat!.slice(), z0: new Array(n), z1: new Array(n), eS: rr.mat!.map((_m, i) => rr.e[2 * i]), eG: rr.mat!.map((_m, i) => rr.e[2 * i + 1]) };
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
            if (r) for (let i = 0; i < e.mat.length; i++) {
              e.eS![i] = q16(e.eS![i] + rr!.e[2 * i]);
              e.eG![i] = q16(e.eG![i] + rr!.e[2 * i + 1]);
            }
            // the residual per bound; the bounds kept in order (a no-op when nothing changed under them)
            let prev = Infinity;
            const n = e.mat.length;
            const add = (v: number, at: number) => (r ? v + r[at] + r[at + 1] : v);
            for (let i = n - 1; i >= 0; i--) {
              e.z1[i] = Math.min(add(e.z1[i], 4 * (n - 1 - i)), prev);
              if (i > 0) e.z0[i] = Math.min(add(e.z0[i], 4 * (n - 1 - i) + 2), e.z1[i]);
              prev = e.z0[i];
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
            const re: number[] = [];
            for (let i = 0; i < live.mat.length; i++) re.push(esOf(live, i) - (whole ? 0 : e.eS![i]), egOf(live, i) - (whole ? 0 : e.eG![i]));
            if (whole || r.some((x) => x !== 0) || re.some((x) => x !== 0)) res.set(key, { whole, mat: whole ? live.mat.slice() : undefined, r, e: re });
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
    const ball = op === 'carve' || op === 'add';
    // a ball reaches its ring of ghosts past its radius
    const rr = ball ? r + RING : r;
    const box = clip({ x0: Math.floor(cx - rr), y0: Math.floor(cy - rr), x1: Math.ceil(cx + rr) + 1, y1: Math.ceil(cy + rr) + 1 }, lv.f);
    if (!box) return;
    // the brush's one decision, from the column under its centre as it was: where a new gap (carve) or interval (add)
    // goes, by index, in every column of the same interval count (so the structure stays constant across the footprint
    // and its ring: docs/design/NESTED_SCALES.md "Footprints", ghosts)
    const at = ball ? ballSite(lv.clamped(Math.floor(cx), Math.floor(cy)), op, cz, r) : null;
    for (let y = box.y0; y < box.y1; y++)
      for (let x = box.x0; x < box.x1; x++) {
        const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const d = dd / r;
        if (ball) {
          if (dd >= rr) continue;
          lv.set(x, y, applyBall(lv.at(x, y)!, op, cz, r, dd, at!));
          continue;
        }
        if (d >= 1) continue;
        const p = (1 - d * d) * (1 - d * d);
        lv.set(x, y, applyOp(lv.at(x, y)!, op, amount * p));
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

/** the camera's distance from local point p to column (i, j)'s solid (centre at i + 0.5), the column dilated to the
 *  2 x 2 columns between its neighbours' centres (gpu: nest.wgsl colDist). Infinity: no solid. */
export function colDist(c: Col, i: number, j: number, p: [number, number, number]): number {
  const dx = Math.max(0, Math.abs(p[0] - (i + 0.5)) - 1);
  const dy = Math.max(0, Math.abs(p[1] - (j + 0.5)) - 1);
  let best = Infinity;
  // solid: the present intervals, and the gaps that are not air (ghost gaps)
  for (let q = 0; q < c.z1.length; q++) {
    const z0 = q === 0 ? -Infinity : c.z0[q];
    if (solidAt(c, q)) best = Math.min(best, Math.max(0, z0 - p[2], p[2] - c.z1[q]));
    if (q > 0 && !present(egOf(c, q))) best = Math.min(best, Math.max(0, c.z1[q - 1] - p[2], p[2] - c.z0[q]));
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

/** where a ball makes structure, decided once a brush from the column under its centre (gpu: nest.wgsl ballSite):
 *  carve, the interval whose solid holds the centre (split there: a new gap); add, the air gap holding the centre (a new
 *  interval there; g = n: the sky) or the ghost interval holding it (revived); kind 0: neither (the centre in solid for
 *  add, in air for carve) */
export interface BallSite {
  kind: 0 | 1 | 2; // 0 none, 1 split interval / insert into gap, 2 revive a ghost interval (add)
  idx: number;
  n: number;
}
/** a gap a carve may reuse: real air (some thickness) or one a brush made (a ghost, or a footprint nearer than E_FAR);
 *  not the zero-thickness boundary between two materials */
export const reusableGap = (c: Col, i: number) => c.z0[i] > c.z1[i - 1] || egOf(c, i) < E_FAR;
/** the interval a carve splits: the highest solid one starting at or below the ball's centre (holding it, or the one
 *  under it: at a tunnel's mouth the top interval splits and its upper piece is a cut-away ghost, so the mouth keeps
 *  the hill's structure) */
export function splitIdx(c: Col, cz: number): number {
  let s = 0;
  for (let i = 1; i < c.mat.length; i++) if (solidAt(c, i) && c.z0[i] <= cz) s = i;
  return s;
}
/** the air run holding height z: the consecutive air slabs (present gaps, ghost intervals, the sky) round it, as slab
 *  indices [a, b] (interval i is slab 2i, the gap below it 2i - 1, the sky 2n - 1); null when z is in solid */
export function airRunAt(c: Col, z: number): [number, number] | null {
  const n = c.mat.length;
  const lo = (s: number) => (s === 0 ? -Infinity : s % 2 === 0 ? c.z0[s / 2] : c.z1[(s - 1) / 2]);
  const hi = (s: number) => (s === 2 * n - 1 ? Infinity : s % 2 === 0 ? c.z1[s / 2] : c.z0[(s + 1) / 2]);
  const air = (s: number) => (s === 2 * n - 1 ? true : s % 2 === 0 ? !solidAt(c, s / 2) : present(egOf(c, (s + 1) / 2)));
  let at = -1;
  for (let s = 0; s < 2 * n; s++) if (air(s) && lo(s) <= z && z <= hi(s)) at = s;
  if (at < 0) return null;
  // (a slab thinner than GAP_MIN does not break the run: the draw treats it as its surroundings)
  const thru = (s: number) => air(s) || hi(s) - lo(s) < GAP_MIN;
  let a = at;
  let b = at;
  while (a > 0 && thru(a - 1)) a--;
  while (b < 2 * n - 1 && thru(b + 1)) b++;
  return [a, b];
}
export function ballSite(c: Col, op: 'carve' | 'add', cz: number, r: number): BallSite {
  const n = c.mat.length;
  const run = airRunAt(c, cz);
  // reuse: a gap (carve) or an interval (add) a brush made, within the ball's reach in z or in the air run holding the
  // centre, makes no new structure (a stroke's balls reuse the first one's gap and ring instead of splitting again; a
  // ball in open air over earlier balls' gaps too)
  if (op === 'carve') {
    for (let i = 1; i < n; i++) if (reusableGap(c, i) && ((c.z0[i] >= cz - r && c.z1[i - 1] <= cz + r) || (run !== null && run[0] <= 2 * i - 1 && 2 * i - 1 <= run[1]))) return { kind: 0, idx: -1, n };
    return { kind: 1, idx: splitIdx(c, cz), n };
  }
  // add: a ghost interval a brush made in the air run holding the centre is revived (the nearest)
  if (run !== null) {
    let ghost = -1;
    let gd = Infinity;
    for (let i = 1; i < n; i++) {
      if (2 * i < run[0] || 2 * i > run[1] || esOf(c, i) >= E_FAR) continue;
      const dz = Math.max(c.z0[i] - cz, cz - c.z1[i], 0);
      if (dz < gd) {
        ghost = i;
        gd = dz;
      }
    }
    if (ghost > 0) return { kind: 2, idx: ghost, n };
  }
  // add: the nearest interval a brush made (a footprint nearer than E_FAR) within reach is reused (a stroke's balls grow
  // one interval); else a new interval goes into the air holding the centre, or the air just above the solid holding it
  let best = -1;
  let bd = Infinity;
  for (let i = 1; i < n; i++) {
    const dz = Math.max(c.z0[i] - cz, cz - c.z1[i], 0);
    if (esOf(c, i) < E_FAR && dz <= r && dz < bd) {
      best = i;
      bd = dz;
    }
  }
  if (best >= 0) return { kind: 2, idx: best, n };
  for (let i = 0; i < n; i++) if ((i === 0 || c.z0[i] <= cz) && cz <= c.z1[i]) return { kind: 1, idx: i + 1, n };
  for (let i = 1; i < n; i++) if (c.z1[i - 1] < cz && cz < c.z0[i]) return { kind: 1, idx: i, n };
  return { kind: 1, idx: n, n };
}

/** A ball of radius r at height cz on one column at plan distance dd from its centre (the oracle's brush; gpu: nest.wgsl
 *  ball). Inside the footprint (dd < r) the ball's z-span [cz - h, cz + h] is carved or filled; in the ring (r <= dd <
 *  r + RING) only ghosts are written. Nothing is ever removed: a cut-away interval keeps its place as a ghost (eS < 0),
 *  so the structure stays constant across the footprint. Footprints, analytic: the ball's air is present inside its
 *  plan disc (eG = r - dd); an interval's bound the ball reaches is cut away where it does (eS = min(eS, dd - r_slice(z)),
 *  r_slice the ball's radius at that height); an added interval is present inside the disc (eS = r - dd). */
export function applyBall(c0: Col, op: 'carve' | 'add', cz: number, r: number, dd: number, site: BallSite): Col {
  const c = withE(c0);
  const n0 = c.mat.length;
  const eBall = q16(r - dd);
  const inside = dd < r;
  const h = inside ? Math.sqrt(r * r - dd * dd) : 0;
  const lo = cz - h;
  const hi = cz + h;
  const rs = (z: number) => Math.sqrt(Math.max(0, r * r - (z - cz) * (z - cz)));
  const eCut = (z: number) => (Math.abs(z - cz) >= r ? E_FAR : q16(dd - rs(z)));
  const clampZ = (z: number, a: number, b: number) => Math.min(b, Math.max(a, z));
  const ins = (at: number, m: number, a: number, b: number, es: number, eg: number) => {
    c.mat.splice(at, 0, m);
    c.z0.splice(at, 0, a);
    c.z1.splice(at, 0, b);
    c.eS!.splice(at, 0, es);
    c.eG!.splice(at, 0, eg);
  };
  let made = -1; // the interval the site made (left alone by the trims below)
  if (op === 'carve') {
    let split = site.kind === 1 && n0 === site.n ? site.idx : -1;
    // (elsewhere: where no gap lies within the ball's reach, split the solid interval holding the span, or in the ring
    // the centre's height: the columns past a reused gap's ring get the same gap, at the same index)
    if (split < 0) {
      // the nearest reusable gap within the ball's radius of its centre in z (the same test inside and in the ring, so
      // the decision does not depend on the span's length)
      let near = -1;
      let nd = Infinity;
      const run = airRunAt(c, cz);
      for (let g = 1; g < n0; g++) {
        // (a gap in the air run holding the centre counts as at the centre)
        const dz = run !== null && run[0] <= 2 * g - 1 && 2 * g - 1 <= run[1] ? 0 : Math.max(c.z1[g - 1] - cz, cz - c.z0[g], 0);
        if (reusableGap(c, g) && dz <= r && dz < nd) {
          near = g;
          nd = dz;
        }
      }
      if (near < 0) split = splitIdx(c, cz);
      else if (inside) {
        // (a span that misses it: the gap grows to the span, as a swept capsule would)
        const g = near;
        if (lo < c.z1[g - 1]) c.z1[g - 1] = g - 1 === 0 ? lo : Math.max(lo, c.z0[g - 1]);
        if (hi > c.z0[g]) c.z0[g] = Math.min(hi, c.z1[g]);
      }
    }
    if (split >= 0) {
      const i = split;
      const zi0 = i === 0 ? -Infinity : c.z0[i];
      const zi1 = c.z1[i];
      const a = inside ? clampZ(lo, zi0, zi1) : clampZ(cz, zi0, zi1);
      const b = inside ? clampZ(hi, zi0, zi1) : a;
      const esI = c.eS![i];
      // the lower piece keeps index i (and the gap below it); the upper is new, over the ball's gap
      c.z1[i] = a;
      if (i > 0) c.eS![i] = Math.min(esI, eCut(zi0));
      ins(i + 1, c.mat[i], b, zi1, Math.min(esI, eCut(zi1)), eBall);
      made = i;
    }
    if (inside)
      for (let j = 0; j < c.mat.length; j++) {
        if (made >= 0 && (j === made || j === made + 1)) continue;
        const z0 = j === 0 ? -Infinity : c.z0[j];
        const z1 = c.z1[j];
        if (!(z1 > lo && z0 < hi)) continue;
        if (lo <= z0 && z1 <= hi) c.eS![j] = Math.min(c.eS![j], eCut(z0), eCut(z1));
        else if (z1 <= hi) c.z1[j] = lo;
        else if (lo <= z0) c.z0[j] = hi;
      }
    // the ball's air: every gap it opens or reaches (in the ring: within its radius in z)
    for (let g = 1; g < c.mat.length; g++) {
      const f = c.z1[g - 1];
      const cc = c.z0[g];
      const near = inside ? cc >= lo && f <= hi : Math.max(f - cz, cz - cc, 0) <= r;
      if (near) c.eG![g] = Math.max(c.eG![g], eBall);
    }
  } else {
    // (a column of another structure than the centre's decides alone, the same way)
    if (n0 !== site.n) site = ballSite(c, 'add', cz, r);
    if (site.kind === 1) {
      const g = site.idx;
      const f = c.z1[g - 1];
      const cc = g < n0 ? c.z0[g] : Infinity;
      const a = inside ? clampZ(lo, f, cc) : clampZ(cz, f, cc);
      const b = inside ? clampZ(hi, f, cc) : a;
      // the new interval takes index g; the gap below it keeps the old gap's footprint, as does the one above it
      ins(g, MAT.soil, a, b, eBall, g < n0 ? c.eG![g] : E_FAR);
      made = g;
    } else if (site.kind === 2) {
      // the reused interval takes the span: a present one grows to hold it (a swept capsule), a ghost one is laid there
      const j = site.idx;
      if (inside) {
        const f = c.z1[j - 1];
        const cc = j + 1 < n0 ? c.z0[j + 1] : Infinity;
        const a = Math.min(cc, Math.max(lo, f));
        const b = Math.max(f, Math.min(hi, cc));
        if (solidAt(c, j)) {
          c.z0[j] = Math.min(c.z0[j], a);
          c.z1[j] = Math.max(c.z1[j], b);
        } else {
          c.z0[j] = a;
          c.z1[j] = b;
        }
      }
      c.eS![j] = Math.max(c.eS![j], eBall);
      made = j;
    }
    if (inside) {
      // the other air pieces the span reaches are filled from the solid they touch (no new interval)
      const n = c.mat.length;
      for (let g = 1; g <= n; g++) {
        if (made >= 0 && (g === made || g === made + 1)) continue;
        const f = c.z1[g - 1];
        const cc = g < n ? c.z0[g] : Infinity;
        if (!(cc > lo && f < hi)) continue;
        if (lo <= f) {
          c.z1[g - 1] = Math.min(hi, cc);
          if (g - 1 > 0) c.eS![g - 1] = Math.max(c.eS![g - 1], eBall);
        } else if (hi >= cc && g < n) {
          c.z0[g] = Math.max(lo, f);
          c.eS![g] = Math.max(c.eS![g], eBall);
        }
      }
    }
  }
  c.z0[0] = OPEN_BOTTOM;
  return c;
}

/** a brush step on one column: raise adds to the top interval; dig removes from the top down (emptied intervals stay,
 *  with zero thickness, at the new surface; interval 0 is open below and never runs out) */
export function applyOp(c: Col, op: EditOp, a: number): Col {
  const n = c.mat.length;
  const z0 = c.z0.slice();
  const z1 = c.z1.slice();
  if (op === 'raise') {
    z1[n - 1] += a;
  } else {
    const top = z1[n - 1] - a;
    for (let i = n - 1; i >= 0; i--) {
      if (z1[i] > top) z1[i] = top;
      if (i > 0 && z0[i] > top) z0[i] = top;
    }
  }
  // (bounds move; footprints stay)
  return { ...withE(c), z0, z1 };
}
