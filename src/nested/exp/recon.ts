// Nested scales lab, round 30: a CPU-only numbers experiment (docs/design/NESTED_SCALES.md "As built (round 30)").
// When a shape is stored at one level and no finer data exists, how close is the 8x finer child level to the true shape,
// depending on what each parent column stores? Heights only (today's limited PPM, oracle.ts ppm2), heights plus one edge
// line (edge.ts quantisation), heights plus a gradient (cubic Hermite), a line plus a normal, and half the columns.
// Nothing here is used by the game; test/unit/nested-recon.test.ts runs it and prints the table.
import { ppm2, ppmSub, bump } from '../oracle';
import { EDGE_RANGE, edgeDec, edgeEnc } from '../edge';

/** flat ground height, metres */
export const G0 = 100;
/** child column width, metres */
export const CW = 2;
/** supersamples per child axis (a child's truth is the mean of SS x SS point samples) */
export const SS = 8;
/** the window: NP16 parent columns of 16 m a side */
export const NP16 = 64;
export const NC = NP16 * 8;
export const WIN = NC * CW;
/** the shapes' centre: off the column lattice at every level */
export const CX = 517.3;
export const CY = 509.7;
/** variant C's gradient clamp: |grad| <= tan 70 deg */
export const MAX_SLOPE = Math.tan((70 * Math.PI) / 180);
/** variant D: the stored tilt's quantisation (8 bits over 0..90 deg) and the tilt from which the wall counts as vertical */
export const TILT_STEPS = 255;
export const VERTICAL_DEG = 85;

/** one crease (a break of slope) near a point: the line { p : dot(n, p - point) = d } in metres, n out of the brush (the
 *  carved or sloped region), d > 0 when the point lies inside; tilt = the brush side's slope at the crossing (tan of its
 *  angle from horizontal; Infinity = vertical wall) */
export interface Crease {
  nx: number;
  ny: number;
  d: number;
  tilt: number;
}
export interface Shape {
  name: string;
  h(x: number, y: number): number;
  /** the nearest crease to (x, y), or null (no crease on this shape) */
  crease(x: number, y: number): Crease | null;
  /** the feature's region (the error band is the region grown by 32 m) */
  region(x: number, y: number): boolean;
}

const A27 = (27 * Math.PI) / 180;
const NNX = -Math.sin(A27);
const NNY = Math.cos(A27);
const across = (x: number, y: number) => (x - CX) * NNX + (y - CY) * NNY;

export function bowl(R: number): Shape {
  return {
    name: `sphere bowl r ${R}`,
    h: (x, y) => {
      const r2 = (x - CX) ** 2 + (y - CY) ** 2;
      return r2 < R * R ? G0 - Math.sqrt(R * R - r2) : G0;
    },
    crease: (x, y) => {
      const r = Math.hypot(x - CX, y - CY);
      if (r < 1e-9) return null;
      return { nx: (x - CX) / r, ny: (y - CY) / r, d: R - r, tilt: Infinity };
    },
    region: (x, y) => (x - CX) ** 2 + (y - CY) ** 2 < R * R,
  };
}
export const trench: Shape = {
  name: 'trench 48 w 40 d, 27 deg',
  h: (x, y) => (Math.abs(across(x, y)) < 24 ? G0 - 40 : G0),
  crease: (x, y) => {
    const s = across(x, y);
    return s >= 0 ? { nx: NNX, ny: NNY, d: 24 - s, tilt: Infinity } : { nx: -NNX, ny: -NNY, d: 24 + s, tilt: Infinity };
  },
  region: (x, y) => Math.abs(across(x, y)) < 24,
};
const T60 = Math.tan(Math.PI / 3);
const CLIFF_W = 80 / T60;
export const cliff: Shape = {
  name: 'cliff 60 deg 80 m, 27 deg',
  h: (x, y) => {
    const s = across(x, y);
    return s < 0 ? G0 : s > CLIFF_W ? G0 - 80 : G0 - s * T60;
  },
  // the brush is the slope band 0 <= s <= W: the top rim's line and the foot's, the nearer one
  crease: (x, y) => {
    const s = across(x, y);
    return Math.abs(s) <= Math.abs(CLIFF_W - s) ? { nx: -NNX, ny: -NNY, d: s, tilt: T60 } : { nx: NNX, ny: NNY, d: CLIFF_W - s, tilt: T60 };
  },
  region: (x, y) => {
    const s = across(x, y);
    return s >= 0 && s <= CLIFF_W;
  },
};
export const hill: Shape = {
  name: 'control: gaussian hill 60 m, sigma 120',
  h: (x, y) => G0 + 60 * Math.exp(-((x - CX) ** 2 + (y - CY) ** 2) / (2 * 120 * 120)),
  crease: () => null,
  region: (x, y) => 60 * Math.exp(-((x - CX) ** 2 + (y - CY) ** 2) / (2 * 120 * 120)) > 0.5,
};
export const SHAPES: Shape[] = [bowl(40), bowl(166), trench, cliff, hill];

// ---- grids ------------------------------------------------------------------------------------------------------------

/** a square grid of column means, n a side, column width w metres */
export interface Grid {
  n: number;
  w: number;
  v: Float64Array;
}
export const at = (g: Grid, x: number, y: number) => g.v[Math.min(g.n - 1, Math.max(0, y)) * g.n + Math.min(g.n - 1, Math.max(0, x))];

/** the child truth: the mean of SS x SS point samples per 2 m column */
export function childTruth(s: Shape): Grid {
  const v = new Float64Array(NC * NC);
  for (let j = 0; j < NC; j++)
    for (let i = 0; i < NC; i++) {
      let sum = 0;
      for (let b = 0; b < SS; b++) for (let a = 0; a < SS; a++) sum += s.h((i + (a + 0.5) / SS) * CW, (j + (b + 0.5) / SS) * CW);
      v[j * NC + i] = sum / (SS * SS);
    }
  return { n: NC, w: CW, v };
}
/** parents of k x k children: exactly their mean (so the 16 m parent is the mean of 64 x 64 point samples) */
export function restrictGrid(c: Grid, k: number): Grid {
  const n = c.n / k;
  const v = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) sum += c.v[(j * k + b) * c.n + i * k + a];
      v[j * n + i] = sum / (k * k);
    }
  return { n, w: c.w * k, v };
}

// ---- variant A: the limited PPM (oracle.ts ppm2, the real function) ---------------------------------------------------

export function reconA(P: Grid, k: number): Grid {
  const n = P.n * k;
  const v = new Float64Array(n * n);
  const S = (x: number, y: number) => at(P, x, y);
  for (let py = 0; py < P.n; py++)
    for (let px = 0; px < P.n; px++) {
      const ref = at(P, px, py);
      for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) v[(py * k + b) * n + px * k + a] = ref + ppm2(S, px, py, a, b, k);
    }
  return { n, w: P.w / k, v };
}

// ---- the cheap flag and the stored lines ------------------------------------------------------------------------------

/** a parent column is flagged where its height differs from any of its 4 neighbours by more than thr metres */
export function flags(P: Grid, thr: number): Uint8Array {
  const f = new Uint8Array(P.n * P.n);
  for (let y = 0; y < P.n; y++)
    for (let x = 0; x < P.n; x++) {
      const c = P.v[y * P.n + x];
      let on = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const qx = x + dx;
        const qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= P.n || qy >= P.n) continue;
        if (Math.abs(P.v[qy * P.n + qx] - c) > thr) on = true;
      }
      f[y * P.n + x] = on ? 1 : 0;
    }
  return f;
}

/** a stored line: as edge.ts decodes it (parent units), plus variant D's quantised tilt (radians) */
export interface Line {
  nx: number;
  ny: number;
  d: number;
  tiltA: number;
}
/** each flagged column's line: the nearest crease to its centre, quantised exactly as edge.ts (edgeEnc / edgeDec); none
 *  where the crease is past EDGE_RANGE columns (edgeEnc's own rule) */
export function lines(P: Grid, f: Uint8Array, s: Shape): (Line | null)[] {
  const out: (Line | null)[] = new Array(P.n * P.n).fill(null);
  for (let y = 0; y < P.n; y++)
    for (let x = 0; x < P.n; x++) {
      if (!f[y * P.n + x]) continue;
      const c = s.crease((x + 0.5) * P.w, (y + 0.5) * P.w);
      if (!c) continue;
      const e = edgeDec(edgeEnc(c.nx, c.ny, c.d / P.w));
      if (!e || Math.abs(c.d / P.w) > EDGE_RANGE) continue;
      const step = Math.PI / 2 / TILT_STEPS;
      const tiltA = Math.round(Math.atan(c.tilt) / step) * step;
      out[y * P.n + x] = { nx: e.nx, ny: e.ny, d: e.d, tiltA };
    }
  return out;
}

// ---- variants B and D: the line splits the block; each side from the nearest unflagged neighbours on that side ---------

export interface LineOpts {
  /** D: below the line the brush side follows the stored tilt from the line's height */
  normal: boolean;
  /** restore the block's mean (parent = mean of its 64 children) with oracle.ts's sin^2 bump over the whole block */
  mean: boolean;
  /** fill each side from ANY cell on that side (round 24's actual rule, flagged cells included) instead of the brief's
   *  unflagged cells first */
  anyCell?: boolean;
}

/** children of a parent with a line; null when no side surface can be formed (the caller keeps A) */
function lineBlock(P: Grid, fl: Uint8Array, ln: (Line | null)[], px: number, py: number, k: number, o: LineOpts): number[] {
  const L = ln[py * P.n + px]!;
  const pref = at(P, px, py);
  const top: number[] = [];
  const side: boolean[] = [];
  const good: boolean[] = [];
  let wMin = Infinity;
  let wMax = -Infinity;
  for (let j = -2; j <= 2; j++)
    for (let i = -2; i <= 2; i++) {
      const qx = Math.min(P.n - 1, Math.max(0, px + i));
      const qy = Math.min(P.n - 1, Math.max(0, py + j));
      const t = at(P, qx, qy);
      top.push(t);
      wMin = Math.min(wMin, t);
      wMax = Math.max(wMax, t);
      // a cell's side: its own line's sign where it keeps one (round 24's rule), else this parent's line at its centre
      const e = ln[qy * P.n + qx];
      side.push(e ? e.d > 0 : L.d - (L.nx * (qx - px) + L.ny * (qy - py)) > 0);
      good.push(!fl[qy * P.n + qx]);
    }
  // round 24's fill (exp/nested-edge-enhance oracle.ts enhanceTops fillOf): a cell not usable for side s takes the mean
  // of the nearest usable cells of side s, each carried on linearly where the next cell back is usable too, never past
  // the cell's own top. Usable: on side s AND unflagged (this round's brief); where the 5 x 5 has none, any cell on side s.
  const fillOf = (s: boolean): number[] | null => {
    let use = top.map((_t, c) => side[c] === s && (o.anyCell || good[c]));
    if (!use.some((u) => u)) use = top.map((_t, c) => side[c] === s);
    if (!use.some((u) => u)) return null;
    return top.map((t, c) => {
      if (use[c]) return t;
      let best = 99;
      let sum = 0;
      let cnt = 0;
      const cx = c % 5;
      const cy = Math.floor(c / 5);
      for (let q = 0; q < 25; q++) {
        if (!use[q]) continue;
        const qx = q % 5;
        const qy = Math.floor(q / 5);
        const d = (qx - cx) ** 2 + (qy - cy) ** 2;
        if (d > best) continue;
        if (d < best) {
          best = d;
          sum = 0;
          cnt = 0;
        }
        const rx = qx - Math.sign(cx - qx);
        const ry = qy - Math.sign(cy - qy);
        const lin = rx >= 0 && rx < 5 && ry >= 0 && ry < 5 && use[ry * 5 + rx];
        const ext = lin ? top[q] + (top[q] - top[ry * 5 + rx]) * Math.max(Math.abs(cx - qx), Math.abs(cy - qy)) : top[q];
        sum += Math.min(Math.max(ext, Math.min(top[q], t)), Math.max(top[q], t));
        cnt++;
      }
      return sum / cnt;
    });
  };
  const fills = [fillOf(false), fillOf(true)];
  const ppmOf = (V: number[], a: number, b: number) => {
    const rows: number[] = [];
    for (let j = 0; j < 5; j++) rows.push(ppmSub(V.slice(j * 5, j * 5 + 5).map((v) => v - pref), a, k));
    return pref + ppmSub(rows, b, k);
  };
  const out: number[] = [];
  const vertical = L.tiltA >= (VERTICAL_DEG * Math.PI) / 180;
  for (let b = 0; b < k; b++)
    for (let a = 0; a < k; a++) {
      const ox = (a + 0.5) / k - 0.5;
      const oy = (b + 0.5) / k - 0.5;
      const dc = L.d - (L.nx * ox + L.ny * oy);
      const sd = dc > 0;
      const V = fills[sd ? 1 : 0] ?? top;
      let h = ppmOf(V, a, b);
      if (o.normal && sd && !vertical && fills[0]) {
        // the brush side: a plane from the line at the outside surface's height (the outside continued to this child),
        // falling (or rising) toward the inside's fill at the stored tilt; within the 5 x 5's range
        const hLine = ppmOf(fills[0], a, b);
        const sgn = Math.sign(h - hLine);
        h = Math.min(wMax, Math.max(wMin, hLine + sgn * Math.tan(L.tiltA) * dc * P.w));
      }
      out.push(h);
    }
  if (o.mean) {
    let D = 0;
    for (const h of out) D += pref - h;
    const W = (k * k) / 4;
    for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) out[b * k + a] += (D * bump(a, k) * bump(b, k)) / W;
  }
  return out;
}

export function reconLine(P: Grid, k: number, fl: Uint8Array, ln: (Line | null)[], o: LineOpts): Grid {
  const g = reconA(P, k);
  for (let py = 0; py < P.n; py++)
    for (let px = 0; px < P.n; px++) {
      if (!ln[py * P.n + px]) continue;
      const blk = lineBlock(P, fl, ln, px, py, k, o);
      for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) g.v[(py * k + b) * g.n + px * k + a] = blk[b * k + a];
    }
  return g;
}

// ---- variant C: height + gradient, monotone-clamped cubic Hermite ----------------------------------------------------

/** each column's mean gradient from the truth: (the mean along its +x edge - along its -x edge) / w (the divergence
 *  theorem: exact for any surface, a vertical wall included), clamped to |grad| <= MAX_SLOPE */
export function gradients(s: Shape, n: number, w: number): { gx: Float64Array; gy: Float64Array } {
  const gx = new Float64Array(n * n);
  const gy = new Float64Array(n * n);
  const M = 64;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let ex = 0;
      let ey = 0;
      for (let m = 0; m < M; m++) {
        const u = (m + 0.5) / M;
        ex += s.h((x + 1) * w, (y + u) * w) - s.h(x * w, (y + u) * w);
        ey += s.h((x + u) * w, (y + 1) * w) - s.h((x + u) * w, y * w);
      }
      let ax = ex / M / w;
      let ay = ey / M / w;
      const l = Math.hypot(ax, ay);
      if (l > MAX_SLOPE) {
        ax *= MAX_SLOPE / l;
        ay *= MAX_SLOPE / l;
      }
      gx[y * n + x] = ax;
      gy[y * n + x] = ay;
    }
  return { gx, gy };
}

/** cubic Hermite between h0 and h1 (spacing w, slopes m0, m1) at t in [0, 1], the slopes limited per segment
 *  (Fritsch-Carlson: zero against the segment's direction, at most 3x its secant), so it stays within [h0, h1] */
export function hermite(h0: number, h1: number, m0: number, m1: number, w: number, t: number): number {
  const sec = (h1 - h0) / w;
  if (sec === 0) return h0;
  if (Math.sign(m0) !== Math.sign(sec)) m0 = 0;
  if (Math.sign(m1) !== Math.sign(sec)) m1 = 0;
  if (m0 / sec > 3) m0 = 3 * sec;
  if (m1 / sec > 3) m1 = 3 * sec;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * h0 + (t3 - 2 * t2 + t) * w * m0 + (-2 * t3 + 3 * t2) * h1 + (t3 - t2) * w * m1;
}

/** children (width cw, nOut a side) from heights at the parent centres and their gradients: Hermite along x on the two
 *  rows round the point, the y slopes linear along x, then Hermite along y; clamped to the four nodes' range. A child is
 *  the mean of 4 x 4 point evaluations. */
export function reconC(P: Grid, gx: Float64Array, gy: Float64Array, cw: number, nOut: number): Grid {
  const v = new Float64Array(nOut * nOut);
  const n = P.n;
  const w = P.w;
  const ev = (x: number, y: number) => {
    const fx = x / w - 0.5;
    const fy = y / w - 0.5;
    const i0 = Math.min(n - 2, Math.max(0, Math.floor(fx)));
    const j0 = Math.min(n - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - i0));
    const ty = Math.min(1, Math.max(0, fy - j0));
    const I = (i: number, j: number) => j * n + i;
    const a00 = I(i0, j0);
    const a10 = I(i0 + 1, j0);
    const a01 = I(i0, j0 + 1);
    const a11 = I(i0 + 1, j0 + 1);
    const r0 = hermite(P.v[a00], P.v[a10], gx[a00], gx[a10], w, tx);
    const r1 = hermite(P.v[a01], P.v[a11], gx[a01], gx[a11], w, tx);
    const s0 = gy[a00] + (gy[a10] - gy[a00]) * tx;
    const s1 = gy[a01] + (gy[a11] - gy[a01]) * tx;
    const h = hermite(r0, r1, s0, s1, w, ty);
    const lo = Math.min(P.v[a00], P.v[a10], P.v[a01], P.v[a11]);
    const hi = Math.max(P.v[a00], P.v[a10], P.v[a01], P.v[a11]);
    return Math.min(hi, Math.max(lo, h));
  };
  for (let j = 0; j < nOut; j++)
    for (let i = 0; i < nOut; i++) {
      let sum = 0;
      for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) sum += ev((i + (a + 0.5) / 4) * cw, (j + (b + 0.5) / 4) * cw);
      v[j * nOut + i] = sum / 16;
    }
  return { n: nOut, w: cw, v };
}

// ---- metrics --------------------------------------------------------------------------------------------------------

/** the band: children whose centre is within 32 m (2 parent columns, Chebyshev) of the feature's region, and at least
 *  48 m from the window's border (the clamped border distorts the straight features that run through it) */
export function band(s: Shape): Uint8Array {
  const reg = new Uint8Array(NC * NC);
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) reg[j * NC + i] = s.region((i + 0.5) * CW, (j + 0.5) * CW) ? 1 : 0;
  const R = 16;
  const rowD = new Uint8Array(NC * NC);
  for (let j = 0; j < NC; j++)
    for (let i = 0; i < NC; i++) {
      let on = 0;
      for (let d = -R; d <= R && !on; d++) {
        const q = i + d;
        if (q >= 0 && q < NC && reg[j * NC + q]) on = 1;
      }
      rowD[j * NC + i] = on;
    }
  const out = new Uint8Array(NC * NC);
  const M = 24;
  for (let j = M; j < NC - M; j++)
    for (let i = M; i < NC - M; i++) {
      let on = 0;
      for (let d = -R; d <= R && !on; d++) {
        const q = j + d;
        if (q >= 0 && q < NC && rowD[q * NC + i]) on = 1;
      }
      out[j * NC + i] = on;
    }
  return out;
}

export interface Err {
  rms: number;
  max: number;
  over2: number;
  n: number;
}
export function errOf(g: Grid, truth: Grid, mask: Uint8Array): Err {
  let s2 = 0;
  let mx = 0;
  let over = 0;
  let n = 0;
  for (let i = 0; i < truth.v.length; i++) {
    if (!mask[i]) continue;
    const e = Math.abs(g.v[i] - truth.v[i]);
    s2 += e * e;
    mx = Math.max(mx, e);
    if (e > 2) over++;
    n++;
  }
  return { rms: Math.sqrt(s2 / Math.max(1, n)), max: mx, over2: over, n };
}

// ---- fixed point ----------------------------------------------------------------------------------------------------

/** heights as integers of 1/scale m: a grid rounded */
export function quantGrid(g: Grid, scale: number): Grid {
  return { n: g.n, w: g.w, v: g.v.map((x) => Math.round(x * scale) / scale) };
}
/** children rounded to integers of 1/scale m with each block of k x k summing exactly to k^2 x its (integer) parent:
 *  the remainder r = k^2 P - sum(rounded children), in units, goes one unit each to the |r| children whose rounding moved
 *  them furthest the other way (largest remainder); |r| > k^2 (a block whose float children do not keep the parent's
 *  mean) spreads floor(|r| / k^2) units over every child first. Returns the grid and the largest |r| met. */
export function quantChildren(c: Grid, P: Grid, k: number, scale: number, enforce: boolean): { g: Grid; maxRem: number; meanRem: number } {
  const v = new Float64Array(c.v.length);
  let maxRem = 0;
  let sumRem = 0;
  const kk = k * k;
  for (let py = 0; py < P.n; py++)
    for (let px = 0; px < P.n; px++) {
      const idx: number[] = [];
      for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) idx.push((py * k + b) * c.n + px * k + a);
      const ints = idx.map((i) => Math.round(c.v[i] * scale));
      const target = kk * Math.round(P.v[py * P.n + px] * scale);
      let r = target - ints.reduce((s, x) => s + x, 0);
      maxRem = Math.max(maxRem, Math.abs(r));
      sumRem += Math.abs(r);
      if (enforce && r !== 0) {
        const sg = Math.sign(r);
        const all = Math.floor(Math.abs(r) / kk);
        for (let q = 0; q < kk; q++) ints[q] += sg * all;
        r -= sg * all * kk;
        // furthest the other way: the rounding residual (float - int) most in the direction of sg
        const order = idx.map((i, q) => ({ q, res: (c.v[i] * scale - ints[q]) * sg })).sort((x, y) => y.res - x.res || x.q - y.q);
        for (let m = 0; m < Math.abs(r); m++) ints[order[m].q] += sg;
      }
      idx.forEach((i, q) => (v[i] = ints[q] / scale));
    }
  return { g: { n: c.n, w: c.w, v }, maxRem, meanRem: sumRem / (P.n * P.n) };
}
