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
export const DETAIL_AMP = 0.06;

export interface Col {
  mat: number[];
  z0: number[];
  z1: number[];
}
/** layer form: v[0] = S, v[2i-1] = gap_i, v[2i] = th_i for i >= 1 (length 2n - 1) */
export interface Layers {
  mat: number[];
  v: number[];
}

export function toLayers(c: Col): Layers {
  const n = c.mat.length;
  const v = new Array<number>(2 * n - 1);
  v[0] = c.z1[n - 1];
  for (let i = 1; i < n; i++) {
    v[2 * i - 1] = c.z0[i] - c.z1[i - 1];
    v[2 * i] = c.z1[i] - c.z0[i];
  }
  return { mat: c.mat.slice(), v };
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
  return { mat: l.mat.slice(), z0, z1 };
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
export function detail(gx: number, gy: number, depth: number, k: number, seed: number): number {
  let v = 0;
  for (let lam = 2, o = 0; lam <= k; lam *= 2, o++) v += DETAIL_AMP * lam * valueNoise((gx + 0.5) / lam, (gy + 0.5) / lam, depth * 16 + o, seed);
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

export type EditOp = 'raise' | 'dig';

/** the chain of live levels over one root, with each depth's sparse residual (global column key -> layer vector) */
export class Nest {
  readonly levels: Level[];
  readonly res: Map<number, number[]>[] = [];
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
      const by = blockPos(b, k);
      const wy = crWeights(by.t);
      for (let a = 0; a < k; a++) {
        const bx = blockPos(a, k);
        const wx = crWeights(bx.t);
        let fsum = 0;
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) fsum += wx[i] * wy[j] * (S(px + bx.off - 1 + i, py + by.off - 1 + j) - pref);
        const s = (pref - f.z0) * k + fsum * k + detail(px * k + a, py * k + b, f.depth, k, this.seed);
        sum += s;
        out.push({ mat: own.mat.slice(), v: [s] });
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

  /** restrict: the parent column over the block of child columns at parent (px, py); null when they disagree */
  restrictCell(child: Level, px: number, py: number): Col | null {
    const k = this.k;
    let first: Layers | null = null;
    let acc: number[] = [];
    for (let b = 0; b < k; b++)
      for (let a = 0; a < k; a++) {
        const c = child.at(px * k + a, py * k + b);
        if (!c) throw new Error('restrict outside the child');
        const l = toLayers(c);
        if (!first) {
          first = l;
          acc = l.v.map(() => 0);
        } else if (!sameStructure(first, l)) return null;
        for (let i = 0; i < l.v.length; i++) acc[i] += l.v[i];
      }
    const kk = k * k;
    const v = acc.map((s, i) => (i === 0 ? child.f.z0 + s / kk / k : s / kk / k));
    return fromLayers({ mat: first!.mat, v });
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
            const e = E[b * k + a];
            const r = res.get(this.key(depth, px * k + a, py * k + b));
            const v = e.v.map((x, i) => (r ? x + r[i] : x));
            for (let i = 1; i < v.length; i++) v[i] = Math.max(0, v[i]);
            child.set(px * k + a, py * k + b, fromLayers({ mat: e.mat, v }));
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
            const live = toLayers(child.at(px * k + a, py * k + b)!);
            const e = E[b * k + a];
            const r = live.v.map((x, i) => x - e.v[i]);
            if (r.some((x) => x !== 0)) res.set(key, r);
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
  edit(depth: number, op: EditOp, cx: number, cy: number, r: number, amount: number): void {
    const lv = this.levels[depth];
    const box = clip({ x0: Math.floor(cx - r), y0: Math.floor(cy - r), x1: Math.ceil(cx + r) + 1, y1: Math.ceil(cy + r) + 1 }, lv.f);
    if (!box) return;
    for (let y = box.y0; y < box.y1; y++)
      for (let x = box.x0; x < box.x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
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
        for (let px = pr.x0; px < pr.x1; px++) {
          const col = this.restrictCell(this.levels[m], px, py);
          if (!col) throw new Error(`restrict: the block at ${px},${py} (depth ${m}) has columns of different structure`);
          this.levels[m - 1].set(px, py, col);
        }
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
      if (m <= depth) this.residual(m, pr);
      this.derive(m, pr);
      changed[m] = { x0: pr.x0 * k, y0: pr.y0 * k, x1: pr.x1 * k, y1: pr.y1 * k };
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
  return { mat: c.mat.slice(), z0, z1 };
}
