// Nested scales lab, round 32 step A (docs/design/NESTED_SCALES.md "As built (round 32, step A)"): THE cliff rule. A pure
// CPU definition of the stone columns on steep ground, written to be ported line by line to WGSL for both the pixel ray
// march and the real level's derive. Nothing in the game uses it yet; test/unit/nested-cliffrule.test.ts tests it and
// src/nested/exp/cliffview.ts draws it.
//
// Everything that decides geometry is integer maths: heights in 1/64 m ("units"), integer hashes (the u32 multiply /
// xorshift mix of shade.wgsl shHash2). Every intermediate stays inside +-2^31, so i32/u32 in WGSL gives the same values.
// PORT NOTE: `fdiv` / `fmod` are FLOOR division / modulo; WGSL `/` and `%` on i32 truncate toward zero, so the port needs
// the same helpers wherever an operand can be negative. Hash words are u32 (`>>> 0` here).
//
// The rule, per coarse cell (16 m) of a height grid (the cell's stored height h = the mean of its children):
//  1. STEEP when max - min over itself and its 4 neighbours > T coarse cell widths.
//  2. A steep cell strictly between its lowest (lo) and highest (hi) 4-neighbour is SPLIT. Every fine column in it (16 m
//     / 2^Lf) stands UP at level H or DOWN at level L. H = hi's height if hi is a sheet cell (it meets that sheet), else
//     the midpoint (h + hi) / 2 (the tread a split neighbour shares); L likewise from lo. Share up F/4096 = (h-L)/(H-L).
//     Every other cell is a SHEET: smooth heights (bilinear quadrants through the centre, edge midpoints and corners,
//     joined only to sheet neighbours within T widths; round 31's scTops rule) - this includes the fallbacks: a steep
//     cell that is itself the highest of its neighbourhood (ridge crest, plateau rim) or the lowest (pit, cliff foot).
//  3. Which columns are up: w = a*px + b*py (px, py = the centre of the column's level-wLevel block (2 m) in fine
//     half-cells from the cell centre, so an oblique wall steps in 2 m blocks, not a fine staircase; (a, b) an integer
//     direction toward hi, |a|,|b| <= 4) plus one hashed offset per level 1..Lf (8 m, 4 m, ... 0.25 m), amplitude
//     ampL[l]/256 of that level's cell width (big at 8/4/2 m: whole blocks stand forward or back; small at 1 m and finer,
//     and scaled by the mask: they only chip corners). The 4 siblings of a parent get zero-sum offsets (+u, -u, +v, -v in
//     a hashed pairing). Up when (w + offsets) * TIE + tie >= theta * TIE + dTheta; theta from F in closed form (the
//     area of the square on the high side of a line), dTheta the stored per-cell residual when `exact`.
//  4. A conservative bound of any cell's descendants' tops at any level: from the cell's w range, its ancestors' known
//     offsets and the remaining levels' largest amplitude.
//  6. Notches at every level 1..fineLevel (8 m .. 0.25 m): local air(column, z) = the union over levels of that level's
//     notch, each in its own cells and keyed on its own cell: z segments of notchSeg cells, a hashed share notchPctL[l],
//     height 1..notchHMax cells, depth 1..notchDepthL[l] cells in from a lower column toward lo. Finer levels only add
//     air (a union), tops are never cut (each level's top cell stays solid), so the top bound is unchanged.
//  7. A slow mask (value noise on a lattice of maskP coarse cells) scales levels >= maskFrom and the notch share.
//  8. Erosion (default off): up columns within 2 units of a lower column drop a hashed 0..erodeSteps half-units,
//     keyed on the unit block.

/** height units per metre */
export const UPM = 64;
/** coarse cell width, metres and units */
export const COARSE_M = 16;
export const COARSE_U = COARSE_M * UPM;

export const KIND_SHEET = 0; // not steep: plain heightmap
export const KIND_TOP = 1; // steep, the cell is the highest of itself and its 4 neighbours (ridge crest, rim): sheet
export const KIND_BOTTOM = 2; // steep, the cell is the lowest (pit, foot): sheet
export const KIND_SPLIT = 3; // steep, strictly between: up / down columns

/** neighbour order: E (+x), W (-x), N (+y), S (-y) */
export const NBX = [1, -1, 0, 0];
export const NBY = [0, 0, 1, -1];

export interface CliffParams {
  /** steep threshold, coarse cell widths (rise over the 5-cell neighbourhood's range) */
  T: number;
  /** finest level: fine columns are 16 m / 2^fineLevel (6 = 0.25 m) */
  fineLevel: number;
  /** per level 0..fineLevel (index 0 unused), /256 of that level's cell width (along the dominant axis): the hashed
   *  offset's amplitude; all 0 = a straight boundary */
  ampL: number[];
  /** siblings' offsets sum to zero (default); false = one independent hash per cell (round 1) */
  zeroSum: boolean;
  /** the mask scales levels >= maskFrom */
  maskFrom: number;
  /** w is taken at the centre of the column's block at this level (3 = 2 m); fineLevel = per column */
  wLevel: number;
  /** mask lattice period in coarse cells; 0 = mask off (full everywhere) */
  maskP: number;
  /** per level 0..fineLevel (index 0 unused): percent of that level's notch z-segments that are air (times the mask);
   *  every level 1..fineLevel cuts its own notches in its own cells, keyed on its own cell */
  notchPctL: number[];
  /** per level: notch depth at most, in that level's cells (each 1..max) */
  notchDepthL: number[];
  /** notch z-segment length, in the level's cells (>= notchHMax + 1) */
  notchSeg: number;
  /** notch height at most, in the level's cells (each 1..notchHMax) */
  notchHMax: number;
  /** the erosion unit: a cell of this level (4 = 1 m) */
  erodeUnit: number;
  /** erosion on (drops only, up columns within 2 units of a lower column) */
  erode: boolean;
  /** erosion's largest drop, half-units (default 2: 0, 0.5 or 1 m) */
  erodeSteps: number;
  /** apply each split cell's stored dTheta (the residual) so the children's mean is h to within half a column step */
  exact: boolean;
  seed: number;
}

export function defaultParams(): CliffParams {
  return {
    T: 2,
    fineLevel: 6,
    ampL: [0, 256, 256, 256, 24, 16, 8],
    zeroSum: true,
    maskFrom: 4,
    wLevel: 3,
    maskP: 4,
    notchPctL: [0, 15, 15, 15, 15, 15, 15],
    notchDepthL: [0, 4, 4, 4, 4, 4, 4],
    notchSeg: 5,
    notchHMax: 3,
    erodeUnit: 4,
    erode: false,
    erodeSteps: 2,
    exact: true,
    seed: 1,
  };
}

/** a coarse height grid, units (1/64 m), row-major, y up */
export interface Field {
  nx: number;
  ny: number;
  h: Int32Array;
}

/** what the rule derives per coarse cell (O(1) from its 5 x 5 neighbourhood, except dTheta: the stored residual) */
export interface CellRule {
  kind: number;
  h: number;
  /** split: up and down levels, units */
  H: number;
  L: number;
  /** split: the direction toward hi (integers, |.| <= 4), A = max(|a|,|b|), B = min */
  a: number;
  b: number;
  A: number;
  B: number;
  /** split: the share up, /4096 */
  F: number;
  /** split: the closed-form threshold and the stored correction */
  theta: number;
  dTheta: number;
  /** split: the direction came from the hi/lo neighbours (a saddle: the 4-neighbour gradient is too small) */
  saddle: boolean;
  /** the neighbour index (NBX/NBY) that is hi / lo */
  hiN: number;
  loN: number;
  /** the mask's upper bound over the cell, /256 */
  maskMax: number;
  /** sheet: control heights [SW, S, SE, W, C, E, NW, N, NE] (corners, edge midpoints, centre) */
  ctrl: Int32Array;
}

// ---- integer helpers (the port needs these exactly) ----

export function fdiv(a: number, b: number): number {
  return Math.floor(a / b);
}
export function fmod(a: number, b: number): number {
  return a - Math.floor(a / b) * b;
}
export function isqrt(n: number): number {
  // floor(sqrt(n)) for 0 <= n < 2^31: a float guess corrected by integer checks (identical on both sides)
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}
export function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
/** u32 hash of two signed integers and a salt (shade.wgsl shHash2's mix with a third lane) */
export function hash3(x: number, y: number, salt: number): number {
  return mix(Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(salt, 0x9e3779b1) ^ 0x51ed270b);
}
/** integer smoothstep on 0..256 */
export function ism(t: number): number {
  return (t * t * (768 - 2 * t)) >> 16;
}

const SALT_LEVEL = 0x100; // + level
const SALT_MASK = 0x200;
const SALT_NOTCH_OFF = 0x300;
const SALT_NOTCH = 0x400;
const SALT_ERODE = 0x500;
function salt(p: CliffParams, s: number): number {
  return (s + Math.imul(p.seed, 0x10001)) | 0;
}

// ---- the field ----

export function hAt(f: Field, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= f.nx ? f.nx - 1 : x;
  const cy = y < 0 ? 0 : y >= f.ny ? f.ny - 1 : y;
  return f.h[cy * f.nx + cx];
}

/** the cell's kind and, for steep cells, its hi / lo neighbours (O(1): the cell and its 4 neighbours) */
export function kindOf(f: Field, cx: number, cy: number, p: CliffParams): { kind: number; hi: number; lo: number; hiN: number; loN: number } {
  const h = hAt(f, cx, cy);
  let hi = -2147483647;
  let lo = 2147483647;
  let hiN = 0;
  let loN = 0;
  for (let k = 0; k < 4; k++) {
    const v = hAt(f, cx + NBX[k], cy + NBY[k]);
    if (v > hi) {
      hi = v;
      hiN = k;
    }
    if (v < lo) {
      lo = v;
      loN = k;
    }
  }
  const range = Math.max(hi, h) - Math.min(lo, h);
  let kind = KIND_SHEET;
  if (range > p.T * COARSE_U) kind = h >= hi ? KIND_TOP : h <= lo ? KIND_BOTTOM : KIND_SPLIT;
  return { kind, hi, lo, hiN, loN };
}

function isSheet(f: Field, cx: number, cy: number, p: CliffParams): boolean {
  return kindOf(f, cx, cy, p).kind !== KIND_SPLIT;
}

/** two sheet cells are joined (one continuous surface) when both are sheets and their heights differ by <= T widths */
export function joined(f: Field, ax: number, ay: number, bx: number, by: number, p: CliffParams): boolean {
  if (!isSheet(f, ax, ay, p) || !isSheet(f, bx, by, p)) return false;
  return Math.abs(hAt(f, ax, ay) - hAt(f, bx, by)) <= p.T * COARSE_U;
}

/** a sheet's corner value toward (sx, sy): the mean of the cells joined to this one round that corner */
function cornerValue(f: Field, cx: number, cy: number, sx: number, sy: number, p: CliffParams): number {
  const jAX = joined(f, cx, cy, cx + sx, cy, p);
  const jAY = joined(f, cx, cy, cx, cy + sy, p);
  const jXD = joined(f, cx + sx, cy, cx + sx, cy + sy, p);
  const jYD = joined(f, cx, cy + sy, cx + sx, cy + sy, p);
  let inX = jAX;
  let inY = jAY;
  const inD = (inX && jXD) || (inY && jYD);
  inX = inX || (inD && jXD);
  inY = inY || (inD && jYD);
  let s = hAt(f, cx, cy);
  let n = 1;
  if (inX) {
    s += hAt(f, cx + sx, cy);
    n++;
  }
  if (inY) {
    s += hAt(f, cx, cy + sy);
    n++;
  }
  if (inD) {
    s += hAt(f, cx + sx, cy + sy);
    n++;
  }
  return fdiv(s, n);
}

// ---- the mask ----

/** the mask at a position in fine half-cells (global: 2 * fine index + 1 is a fine column's centre), /256 */
export function maskAt(qx: number, qy: number, p: CliffParams): number {
  if (p.maskP <= 0) return 256;
  const N = 1 << p.fineLevel;
  const Q = p.maskP * 2 * N;
  const ix = fdiv(qx, Q);
  const iy = fdiv(qy, Q);
  const tx = ism(fdiv((qx - ix * Q) * 256, Q));
  const ty = ism(fdiv((qy - iy * Q) * 256, Q));
  const s = salt(p, SALT_MASK);
  const v00 = hash3(ix, iy, s) & 255;
  const v10 = hash3(ix + 1, iy, s) & 255;
  const v01 = hash3(ix, iy + 1, s) & 255;
  const v11 = hash3(ix + 1, iy + 1, s) & 255;
  const v0 = v00 * (256 - tx) + v10 * tx;
  const v1 = v01 * (256 - tx) + v11 * tx;
  const v = (v0 * (256 - ty) + v1 * ty) >> 16;
  return maskRemap(v);
}
/** about a third of the wall 0, a third full (round 31's smoothstep(0.38, 0.62)) */
function maskRemap(v: number): number {
  const r = Math.max(0, Math.min(256, fdiv((v - 97) * 256, 61)));
  return ism(r);
}
/** an upper bound of the mask over a coarse cell (it lies inside one lattice cell; bilinear + monotone remap) */
function maskMaxOf(cx: number, cy: number, p: CliffParams): number {
  if (p.maskP <= 0) return 256;
  const ix = fdiv(cx, p.maskP);
  const iy = fdiv(cy, p.maskP);
  const s = salt(p, SALT_MASK);
  const m = Math.max(hash3(ix, iy, s) & 255, hash3(ix + 1, iy, s) & 255, hash3(ix, iy + 1, s) & 255, hash3(ix + 1, iy + 1, s) & 255);
  return maskRemap(m);
}

// ---- deriving a cell ----

/** theta for share F/4096 up: the line a*px + b*py = theta leaves area share F on its high side of the square
 *  |px|, |py| <= N (w's density is a trapezoid; closed-form inverse, integer sqrt in the two tails) */
export function thetaOf(F: number, A: number, B: number, N: number): number {
  if (B > 0 && F * A <= B * 2048) return (A + B) * N - isqrt(fdiv(A * B * F * N * N, 512));
  if (B > 0 && (4096 - F) * A <= B * 2048) return -(A + B) * N + isqrt(fdiv(A * B * (4096 - F) * N * N, 512));
  return A * N - fdiv(A * N * F, 2048);
}

export function deriveCell(f: Field, cx: number, cy: number, p: CliffParams): CellRule {
  const h = hAt(f, cx, cy);
  const k = kindOf(f, cx, cy, p);
  const r: CellRule = {
    kind: k.kind,
    h,
    H: h,
    L: h,
    a: 0,
    b: 0,
    A: 0,
    B: 0,
    F: 0,
    theta: 0,
    dTheta: 0,
    saddle: false,
    hiN: k.hiN,
    loN: k.loN,
    maskMax: maskMaxOf(cx, cy, p),
    ctrl: new Int32Array(9),
  };
  if (k.kind !== KIND_SPLIT) {
    r.ctrl[4] = h;
    for (let n = 0; n < 4; n++) {
      const nx = cx + NBX[n];
      const ny = cy + NBY[n];
      const e = joined(f, cx, cy, nx, ny, p) ? fdiv(h + hAt(f, nx, ny), 2) : h;
      r.ctrl[n === 0 ? 5 : n === 1 ? 3 : n === 2 ? 7 : 1] = e;
    }
    r.ctrl[0] = cornerValue(f, cx, cy, -1, -1, p);
    r.ctrl[2] = cornerValue(f, cx, cy, 1, -1, p);
    r.ctrl[6] = cornerValue(f, cx, cy, -1, 1, p);
    r.ctrl[8] = cornerValue(f, cx, cy, 1, 1, p);
    return r;
  }
  const hiX = cx + NBX[k.hiN];
  const hiY = cy + NBY[k.hiN];
  const loX = cx + NBX[k.loN];
  const loY = cy + NBY[k.loN];
  r.H = isSheet(f, hiX, hiY, p) ? k.hi : fdiv(h + k.hi, 2);
  r.L = isSheet(f, loX, loY, p) ? k.lo : fdiv(h + k.lo, 2);
  r.F = fdiv(4096 * (h - r.L), r.H - r.L);
  // direction: the 4-neighbour gradient, quantised so max(|a|,|b|) = 4; a saddle (gradient under a quarter of the
  // hi-lo range) takes the hi neighbour's direction minus the lo neighbour's instead
  const gx = hAt(f, cx + 1, cy) - hAt(f, cx - 1, cy);
  const gy = hAt(f, cx, cy + 1) - hAt(f, cx, cy - 1);
  const m = Math.max(Math.abs(gx), Math.abs(gy));
  if (4 * m < k.hi - k.lo) {
    r.saddle = true;
    r.a = 2 * (NBX[k.hiN] - NBX[k.loN]);
    r.b = 2 * (NBY[k.hiN] - NBY[k.loN]);
  } else {
    r.a = fdiv(8 * gx + m, 2 * m);
    r.b = fdiv(8 * gy + m, 2 * m);
  }
  r.A = Math.max(Math.abs(r.a), Math.abs(r.b));
  r.B = Math.min(Math.abs(r.a), Math.abs(r.b));
  r.theta = thetaOf(r.F, r.A, r.B, 1 << p.fineLevel);
  return r;
}

// ---- which columns are up ----

/** level l's offset amplitude (w units) for a cell with mask value m (/256): ampL[l]/256 of the level's cell width */
export function ampOf(r: CellRule, l: number, m: number, p: CliffParams): number {
  const N = 1 << p.fineLevel;
  return (p.ampL[l] * r.A * 2 * (N >> l) * (l >= p.maskFrom ? m : 256)) >> 16;
}
/** the largest total amplitude of levels l+1..fineLevel (the mask at its bound) */
export function remAmp(r: CellRule, l: number, p: CliffParams): number {
  let s = 0;
  for (let k = l + 1; k <= p.fineLevel; k++) s += ampOf(r, k, r.maskMax, p);
  return s;
}
/** level l's hashed offset for the level-l cell (jx, jy) of coarse cell (cx, cy) (l >= 1). Zero-sum over the 4
 *  siblings: the parent's hash gives u, v and a pairing of the 4 children; one pair gets +u / -u, the other +v / -v
 *  (the mask is taken at the parent's centre, so it is the same for all 4) */
export function levelOff(r: CellRule, cx: number, cy: number, l: number, jx: number, jy: number, p: CliffParams): number {
  const N = 1 << p.fineLevel;
  const gx = (cx << l) + jx;
  const gy = (cy << l) + jy;
  const px = gx >> 1;
  const py = gy >> 1;
  const ps = N >> (l - 1); // the parent's width in fine cells
  const m = l >= p.maskFrom ? maskAt(px * 2 * ps + ps, py * 2 * ps + ps, p) : 256;
  const amp = ampOf(r, l, m, p);
  if (amp === 0) return 0;
  if (!p.zeroSum) return (hash3(gx, gy, salt(p, SALT_LEVEL + l)) % (2 * amp + 1)) - amp;
  const h = hash3(px, py, salt(p, SALT_LEVEL + l));
  const h2 = mix(h);
  const u = (h % (2 * amp + 1)) - amp;
  const v = (h2 % (2 * amp + 1)) - amp;
  const pairing = (h2 >>> 16) % 3; // first pair {0,1} / {0,2} / {0,3}
  const k = (gx & 1) + 2 * (gy & 1);
  const partner = pairing + 1;
  const inFirst = k === 0 || k === partner;
  const secondLow = pairing === 0 ? 2 : 1;
  const sign = k === 0 || k === secondLow ? 1 : -1;
  return sign * (inFirst ? u : v);
}
/** the w coordinate (fine half-cells from the cell centre) of the centre of level-wLevel block bj along one axis */
export function wCentre(bj: number, p: CliffParams): number {
  const N = 1 << p.fineLevel;
  const bs = N >> Math.min(p.wLevel, p.fineLevel);
  return 2 * bj * bs + bs - N;
}
function wShift(p: CliffParams): number {
  return p.fineLevel - Math.min(p.wLevel, p.fineLevel);
}
/** scores carry a per-column tie-break below the integer score: score * TIE + (column hash mod TIE). Integer w and level
 *  offsets tie in long runs (equal w along lines, shared offsets per block), and a threshold cannot split a tie, so
 *  without it the stored dTheta could not bring the up count to the exact target (it missed by up to ~50 columns). */
export const TIE = 4096;
const SALT_TIE = 0x600;
export function tieOf(gx: number, gy: number, p: CliffParams): number {
  return hash3(gx, gy, salt(p, SALT_TIE)) & (TIE - 1);
}
/** the threshold the scores (in TIE units) are compared with */
export function thetaUsed(r: CellRule, p: CliffParams): number {
  return r.theta * TIE + (p.exact ? r.dTheta : 0);
}

/** the score range of the descendants of level-l cell (jx, jy) given its ancestors' and its own known offset sum */
export function scoreRange(r: CellRule, l: number, jx: number, jy: number, known: number, p: CliffParams): { lo: number; hi: number } {
  const N = 1 << p.fineLevel;
  const s = N >> l;
  // the w-blocks inside this node: first and last block index per axis (one block when the node is inside a block)
  const sh = wShift(p);
  const p0 = wCentre((jx * s) >> sh, p);
  const p1 = wCentre((jx * s + s - 1) >> sh, p);
  const q0 = wCentre((jy * s) >> sh, p);
  const q1 = wCentre((jy * s + s - 1) >> sh, p);
  const wmax = (r.a > 0 ? r.a * p1 : r.a * p0) + (r.b > 0 ? r.b * q1 : r.b * q0);
  const wmin = (r.a > 0 ? r.a * p0 : r.a * p1) + (r.b > 0 ? r.b * q0 : r.b * q1);
  const ra = remAmp(r, l, p);
  return { lo: (wmin + known - ra) * TIE, hi: (wmax + known + ra) * TIE + TIE - 1 };
}

/** a fine column of a split cell is up (local fine index ix, iy) */
export function isUp(r: CellRule, cx: number, cy: number, ix: number, iy: number, p: CliffParams): boolean {
  const Lf = p.fineLevel;
  const sh = wShift(p);
  let s = r.a * wCentre(ix >> sh, p) + r.b * wCentre(iy >> sh, p);
  for (let l = 1; l <= Lf; l++) s += levelOff(r, cx, cy, l, ix >> (Lf - l), iy >> (Lf - l), p);
  return s * TIE + tieOf((cx << Lf) + ix, (cy << Lf) + iy, p) >= thetaUsed(r, p);
}
/** level-l cell (jx, jy) at LOD: up when its centre would be, the finer levels' offsets taken as zero */
export function isUpLod(r: CellRule, cx: number, cy: number, l: number, jx: number, jy: number, known: number, p: CliffParams): boolean {
  const N = 1 << p.fineLevel;
  const s = N >> l;
  // the centre in half-cells (inside one w-block: that block's centre)
  const inBlock = l >= Math.min(p.wLevel, p.fineLevel);
  const sh = wShift(p);
  const pc = inBlock ? wCentre((jx * s) >> sh, p) : 2 * jx * s + s - N;
  const qc = inBlock ? wCentre((jy * s) >> sh, p) : 2 * jy * s + s - N;
  const tie = s === 1 ? tieOf((cx << p.fineLevel) + jx, (cy << p.fineLevel) + jy, p) : TIE >> 1;
  return (r.a * pc + r.b * qc + known) * TIE + tie >= thetaUsed(r, p);
}

/** a sheet cell's height at a point given in fine half-cells from its centre (|px|, |py| <= N), units */
export function sheetAt(r: CellRule, px: number, py: number, N: number): number {
  const c = r.ctrl;
  const ex = px >= 0 ? c[5] : c[3];
  const ey = py >= 0 ? c[7] : c[1];
  const k = c[(py >= 0 ? 6 : 0) + (px >= 0 ? 2 : 0)];
  const tx = Math.abs(px);
  const ty = Math.abs(py);
  return fdiv(c[4] * (N - tx) * (N - ty) + ex * tx * (N - ty) + ey * (N - tx) * ty + k * tx * ty, N * N);
}
/** the same surface in floating point (u, v in -1..1 across the cell), metres; the renderer's surface */
export function sheetAtF(r: CellRule, u: number, v: number): number {
  const c = r.ctrl;
  const ex = u >= 0 ? c[5] : c[3];
  const ey = v >= 0 ? c[7] : c[1];
  const k = c[(v >= 0 ? 6 : 0) + (u >= 0 ? 2 : 0)];
  const tx = Math.abs(u);
  const ty = Math.abs(v);
  return (c[4] * (1 - tx) * (1 - ty) + ex * tx * (1 - ty) + ey * (1 - tx) * ty + k * tx * ty) / UPM;
}

// ---- the whole map ----

export interface Rules {
  f: Field;
  p: CliffParams;
  cells: CellRule[];
}

export function deriveRules(f: Field, p: CliffParams): Rules {
  const cells: CellRule[] = [];
  for (let cy = 0; cy < f.ny; cy++) for (let cx = 0; cx < f.nx; cx++) cells.push(deriveCell(f, cx, cy, p));
  const R: Rules = { f, p, cells };
  for (let cy = 0; cy < f.ny; cy++)
    for (let cx = 0; cx < f.nx; cx++) {
      const r = cells[cy * f.nx + cx];
      if (r.kind === KIND_SPLIT) r.dTheta = bestDTheta(r, cx, cy, p);
    }
  return R;
}
export function cellOf(R: Rules, cx: number, cy: number): CellRule {
  const x = cx < 0 ? 0 : cx >= R.f.nx ? R.f.nx - 1 : cx;
  const y = cy < 0 ? 0 : cy >= R.f.ny ? R.f.ny - 1 : cy;
  return R.cells[y * R.f.nx + x];
}

/** the scores of all fine columns of a split cell (without theta) */
export function scores(r: CellRule, cx: number, cy: number, p: CliffParams): Int32Array {
  const Lf = p.fineLevel;
  const N = 1 << Lf;
  const out = new Int32Array(N * N);
  for (let iy = 0; iy < N; iy++)
    for (let ix = 0; ix < N; ix++) {
      const sh = wShift(p);
      let s = r.a * wCentre(ix >> sh, p) + r.b * wCentre(iy >> sh, p);
      for (let l = 1; l <= Lf; l++) s += levelOff(r, cx, cy, l, ix >> (Lf - l), iy >> (Lf - l), p);
      out[iy * N + ix] = s * TIE + tieOf((cx << Lf) + ix, (cy << Lf) + iy, p);
    }
  return out;
}
/** the stored residual: the theta shift that brings the up count nearest to (h - L) N^2 / (H - L) */
function bestDTheta(r: CellRule, cx: number, cy: number, p: CliffParams): number {
  const N = 1 << p.fineLevel;
  const sc = Array.from(scores(r, cx, cy, p)).sort((x, y) => y - x); // descending
  const want = Math.round(((r.h - r.L) * N * N) / (r.H - r.L)); // the count that gives the mean nearest h
  // theta' = sc[want - 1] makes exactly the columns with score >= it up (ties may add more; take the nearest valid)
  let th: number;
  if (want <= 0) th = sc[0] + 1;
  else th = sc[want - 1];
  return th - r.theta * TIE;
}

/** a fine column's top before erosion (global fine indices), units */
export function preTop(R: Rules, gx: number, gy: number): number {
  const N = 1 << R.p.fineLevel;
  const cx = fdiv(gx, N);
  const cy = fdiv(gy, N);
  const r = cellOf(R, cx, cy);
  const ix = gx - cx * N;
  const iy = gy - cy * N;
  if (r.kind !== KIND_SPLIT) return sheetAt(r, 2 * ix + 1 - N, 2 * iy + 1 - N, N);
  return isUp(r, cx, cy, ix, iy, R.p) ? r.H : r.L;
}
/** the steps toward the lo side from a split cell's direction (-sign a, -sign b) */
export function loSteps(r: CellRule): [number, number] {
  return [-Math.sign(r.a), -Math.sign(r.b)];
}
/** the notch / erosion unit: in units (1/64 m) and in fine columns */
export function unitU(p: CliffParams): number {
  return COARSE_U >> p.erodeUnit;
}
export function unitCols(p: CliffParams): number {
  return 1 << (p.fineLevel - p.erodeUnit);
}
/** erosion's largest drop, units */
export function erodeMaxU(p: CliffParams): number {
  return p.erode ? (p.erodeSteps * unitU(p)) >> 1 : 0;
}
/** a fine column's erosion drop, units (0 unless erode, split, up and within 2 units of a lower column toward lo);
 *  the drop is hashed per unit block (0..erodeSteps half-units), so it is coherent over a 1 m block */
export function erosion(R: Rules, gx: number, gy: number): number {
  const p = R.p;
  if (!p.erode) return 0;
  const N = 1 << p.fineLevel;
  const r = cellOf(R, fdiv(gx, N), fdiv(gy, N));
  if (r.kind !== KIND_SPLIT) return 0;
  const t = preTop(R, gx, gy);
  if (t !== r.H) return 0;
  const [sx, sy] = loSteps(r);
  const reach = 2 * unitCols(p);
  let near = false;
  for (let k = 1; k <= reach && !near; k++) {
    if (sx !== 0 && preTop(R, gx + k * sx, gy) < t) near = true;
    if (sy !== 0 && preTop(R, gx, gy + k * sy) < t) near = true;
  }
  if (!near) return 0;
  const sh = p.fineLevel - p.erodeUnit;
  return ((hash3(gx >> sh, gy >> sh, salt(p, SALT_ERODE)) % (p.erodeSteps + 1)) * unitU(p)) >> 1;
}
export function fineTop(R: Rules, gx: number, gy: number): number {
  return preTop(R, gx, gy) - erosion(R, gx, gy);
}

/** level l's notch at z in fine column (gx, gy) of split cell r (already known up), or null. Units of level l: c =
 *  its cell height in units, keyed on the column's level-l cell. Open only when a column within the notch's depth toward
 *  lo has its top at or below the notch floor; the depth is sampled every half level-l cell (every column at s <= 1). */
export function notchLevel(R: Rules, r: CellRule, gx: number, gy: number, z: number, l: number): [number, number] | null {
  const p = R.p;
  const pct = p.notchPctL[l] ?? 0;
  if (pct <= 0) return null;
  const c = COARSE_U >> l;
  const Sz = p.notchSeg * c;
  const ksh = p.fineLevel - l;
  const kx = gx >> ksh;
  const ky = gy >> ksh;
  const sl = salt(p, SALT_NOTCH + l);
  const o = hash3(kx, ky, sl ^ SALT_NOTCH_OFF) % Sz;
  const j = fdiv(z + o, Sz);
  const hn = hash3(kx, ky, sl ^ Math.imul(j, 0x27d4eb2d));
  const ks = 1 << ksh;
  const mk = maskAt(2 * kx * ks + ks, 2 * ky * ks + ks, p);
  if (hn % 25600 >= pct * mk) return null;
  const h2 = mix(hn);
  const len = 1 + (h2 % p.notchHMax);
  const start = (h2 >>> 8) % Math.max(1, p.notchSeg - len + 1);
  const lo = j * Sz - o + start * c;
  const hi = lo + len * c;
  if (z < lo || z >= hi) return null;
  // this level's top cell is never a notch (nor the erosion band under it)
  if (hi > r.H - c - erodeMaxU(p)) return null;
  const s = 1 << ksh; // the level's cell in fine columns
  const d = (1 + ((h2 >>> 16) % Math.max(1, p.notchDepthL[l] ?? 1))) * s;
  const step = Math.max(1, s >> 1);
  const [sx, sy] = loSteps(r);
  for (let k = step; k <= d; k += step) {
    if (sx !== 0 && preTop(R, gx + k * sx, gy) <= lo) return [lo, hi];
    if (sy !== 0 && preTop(R, gx, gy + k * sy) <= lo) return [lo, hi];
  }
  return null;
}

/** the notch air interval [lo, hi) containing z in fine column (gx, gy), or null (solid or above the top): the union of
 *  every level's notches 1..maxL (default fineLevel), merged with overlapping ones above and below. Local: the column's
 *  own cell rule, each level's key hashes, and the tops of the sampled columns toward the lo side. */
export function notchAt(R: Rules, gx: number, gy: number, z: number, maxL = R.p.fineLevel): [number, number] | null {
  const p = R.p;
  const N = 1 << p.fineLevel;
  const cx = fdiv(gx, N);
  const cy = fdiv(gy, N);
  const r = cellOf(R, cx, cy);
  if (r.kind !== KIND_SPLIT) return null;
  if (!isUp(r, cx, cy, gx - cx * N, gy - cy * N, p)) return null;
  const any = (zz: number): [number, number] | null => {
    for (let l = 1; l <= maxL; l++) {
      const n = notchLevel(R, r, gx, gy, zz, l);
      if (n) return n;
    }
    return null;
  };
  const first = any(z);
  if (!first) return null;
  let [lo, hi] = first;
  for (let i = 0; i < 8; i++) {
    const below = any(lo - 1);
    const above = any(hi);
    if (!below && !above) break;
    if (below) lo = Math.min(lo, below[0]);
    if (above) hi = Math.max(hi, above[1]);
  }
  return [lo, hi];
}

/** the conservative bound of a cell's descendants' tops at level l (0 = the coarse cell; fineLevel = one column), units.
 *  max never under-estimates (erosion only drops; the remaining offsets are taken at their largest), min never over. */
export function cellBound(R: Rules, cx: number, cy: number, l: number, jx: number, jy: number): { max: number; min: number; known: number } {
  const p = R.p;
  const r = cellOf(R, cx, cy);
  if (r.kind !== KIND_SPLIT) {
    if (l === 0) {
      let mx = -2147483647;
      let mn = 2147483647;
      for (let i = 0; i < 9; i++) {
        mx = Math.max(mx, r.ctrl[i]);
        mn = Math.min(mn, r.ctrl[i]);
      }
      return { max: mx, min: mn, known: 0 };
    }
    // a sheet's sub-cell: its corners' and centre's sheet heights bound the bilinear quadrants it overlaps... take
    // the whole cell's control range (simple and conservative)
    return cellBound(R, cx, cy, 0, 0, 0);
  }
  let known = 0;
  for (let k = 1; k <= l; k++) known += levelOff(r, cx, cy, k, jx >> (l - k), jy >> (l - k), p);
  const sr = scoreRange(r, l, jx, jy, known, p);
  const th = thetaUsed(r, p);
  const anyUp = sr.hi >= th;
  const allUp = sr.lo >= th;
  return { max: anyUp ? r.H : r.L, min: (allUp ? r.H : r.L) - erodeMaxU(p), known };
}
