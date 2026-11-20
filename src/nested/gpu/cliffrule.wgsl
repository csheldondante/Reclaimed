// ---- nested/gpu/cliffrule.wgsl: the cliff rule's geometry, ported from src/nested/exp/cliffrule.ts (round 32 step B1) --
// docs/design/NESTED_SCALES.md "As built (round 32, step A)" and its port notes; "As built (round 32, step B1)". The TS is
// the reference: every function here is the TS function of the same name with a `cr` prefix, integer for integer
// (test/gpu/nested-cliffrule-wgsl.test.ts checks them equal). Only the part that decides "is a fine column up or down,
// and what are H and L": hashes, floor div / mod, kinds, deriveCell, the mask, the level offsets, the w-blocks, the tie,
// theta and isUp. Not here: dTheta (the stored residual: taken as 0 until it is stored), notches, the bound, erosion and
// any march.
//
// The includer defines `fn crH(x: i32, y: i32) -> i32`: the coarse (16 m) cell's height in 1/64 m units, with the TS
// hAt's edge rule (a coordinate outside the field / window clamped to it, per axis). Parameters are defaultParams()'s,
// as constants (T 2, fineLevel 6, zeroSum, maskFrom 4, wLevel 3, maskP 4, seed 1); ampL is the includer's CR_AMPL
// (array<i32, 7>). Step B2 adds the bound (maskMaxOf, remAmp, cellBound's split branch) and isUpLod.

const CR_U: i32 = 1024; // COARSE_U: a coarse cell's width in units (16 m x 64)
// (the steep threshold T, cell widths, comes from the includer as `fn crT() -> i32` (step B2: ?cliffT=, a uniform of the
// table build, so a change rebuilds the table without a new pipeline). The rule tests the RANGE over a cell and its 4
// neighbours: a plane of slope s along an axis has range 2 s w, so T means s > T / 2 (T 2: 45 deg, 4: 63, 8: 76, 16: 83);
// along a diagonal the range is sqrt(2) s w, so s > T / sqrt(2) (T 2: 55 deg))
const CR_LF: u32 = 6u;
const CR_N: i32 = 64; // 1 << fineLevel
const CR_MASKFROM: u32 = 4u;
const CR_WSH: u32 = 3u; // wShift: fineLevel - min(wLevel, fineLevel)
const CR_BS: i32 = 8; // N >> min(wLevel, fineLevel)
const CR_MASKP: i32 = 4;
const CR_SEED: i32 = 1;
const CR_TIE: i32 = 4096;
const CR_SHEET: u32 = 0u;
const CR_TOP: u32 = 1u;
const CR_BOTTOM: u32 = 2u;
const CR_SPLIT: u32 = 3u;
const CR_NBX = array<i32, 4>(1, -1, 0, 0);
const CR_NBY = array<i32, 4>(0, 0, 1, -1);
// (CR_AMPL, the per-level amplitudes ampL /256, comes from the includer: step B2 makes the 8 m one a URL choice)
const CR_SALT_LEVEL: i32 = 0x100;
const CR_SALT_MASK: i32 = 0x200;
const CR_SALT_TIE: i32 = 0x600;

// ---- integer helpers ----
/** floor division (WGSL `/` truncates toward zero) */
fn crFdiv(a: i32, b: i32) -> i32 {
  let q = a / b;
  return select(q, q - 1, (a % b != 0) && ((a < 0) != (b < 0)));
}
fn crFmod(a: i32, b: i32) -> i32 { return a - crFdiv(a, b) * b; }
/** floor(sqrt(n)), 0 <= n < 2^31: an f32 guess corrected by bounded integer checks (u32 squares: no overflow) */
fn crIsqrt(n: i32) -> i32 {
  let un = u32(n);
  var r = u32(floor(sqrt(f32(n))));
  for (var i = 0; i < 4; i++) { if (r * r > un) { r--; } }
  for (var i = 0; i < 4; i++) { if ((r + 1u) * (r + 1u) <= un) { r++; } }
  return i32(r);
}
fn crMix(h0: u32) -> u32 {
  var h = (h0 ^ (h0 >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
fn crHash3(x: i32, y: i32, s: i32) -> u32 {
  return crMix((bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(y) * 0xd8163841u) ^ (bitcast<u32>(s) * 0x9e3779b1u) ^ 0x51ed270bu);
}
fn crIsm(t: i32) -> i32 { return (t * t * (768 - 2 * t)) >> 16u; }
fn crSalt(s: i32) -> i32 { return s + CR_SEED * 0x10001; }

/** metres-as-local-units to 1/64 m units: round half up (floor(v) + (fract >= 0.5)), v = z x unitsPerLocal exact */
fn crUnits(z: f32, upl: f32) -> i32 {
  let v = z * upl;
  let f = floor(v);
  return i32(f) + select(0, 1, v - f >= 0.5);
}

// ---- kinds ----
struct CrKind {
  kind: u32,
  hi: i32,
  lo: i32,
  hiN: i32,
  loN: i32,
  h: i32,
  /** the 4 neighbours' heights (E, W, N, S) */
  nb: vec4<i32>,
}
fn crKindOf(cx: i32, cy: i32) -> CrKind {
  let h = crH(cx, cy);
  var hi = -2147483647;
  var lo = 2147483647;
  var hiN = 0;
  var loN = 0;
  var nb = vec4<i32>(0);
  for (var k = 0; k < 4; k++) {
    let v = crH(cx + CR_NBX[k], cy + CR_NBY[k]);
    nb[k] = v;
    if (v > hi) {
      hi = v;
      hiN = k;
    }
    if (v < lo) {
      lo = v;
      loN = k;
    }
  }
  let range = max(hi, h) - min(lo, h);
  var kind = CR_SHEET;
  if (range > crT() * CR_U) { kind = select(select(CR_SPLIT, CR_BOTTOM, h <= lo), CR_TOP, h >= hi); }
  return CrKind(kind, hi, lo, hiN, loN, h, nb);
}
fn crIsSheet(cx: i32, cy: i32) -> bool { return crKindOf(cx, cy).kind != CR_SPLIT; }

// ---- the mask ----
fn crMaskRemap(v: i32) -> i32 { return crIsm(max(0, min(256, crFdiv((v - 97) * 256, 61)))); }
/** the mask at a position in fine half-cells (global), /256 */
fn crMaskAt(qx: i32, qy: i32) -> i32 {
  let Q = CR_MASKP * 2 * CR_N;
  let ix = crFdiv(qx, Q);
  let iy = crFdiv(qy, Q);
  let tx = crIsm(crFdiv((qx - ix * Q) * 256, Q));
  let ty = crIsm(crFdiv((qy - iy * Q) * 256, Q));
  let s = crSalt(CR_SALT_MASK);
  let v00 = i32(crHash3(ix, iy, s) & 255u);
  let v10 = i32(crHash3(ix + 1, iy, s) & 255u);
  let v01 = i32(crHash3(ix, iy + 1, s) & 255u);
  let v11 = i32(crHash3(ix + 1, iy + 1, s) & 255u);
  let v0 = v00 * (256 - tx) + v10 * tx;
  let v1 = v01 * (256 - tx) + v11 * tx;
  let v = (v0 * (256 - ty) + v1 * ty) >> 16u;
  return crMaskRemap(v);
}

// ---- deriving a cell ----
struct CrCell {
  kind: u32,
  h: i32,
  H: i32,
  L: i32,
  a: i32,
  b: i32,
  A: i32,
  B: i32,
  F: i32,
  theta: i32,
  /** the stored residual: 0 in B1 (not stored yet) */
  dTheta: i32,
  saddle: bool,
}
fn crThetaOf(F: i32, A: i32, B: i32, N: i32) -> i32 {
  if (B > 0 && F * A <= B * 2048) { return (A + B) * N - crIsqrt(crFdiv(A * B * F * N * N, 512)); }
  if (B > 0 && (4096 - F) * A <= B * 2048) { return -(A + B) * N + crIsqrt(crFdiv(A * B * (4096 - F) * N * N, 512)); }
  return A * N - crFdiv(A * N * F, 2048);
}
/** deriveCell without the sheet's control heights (a sheet keeps the draw's own surface in B1) */
fn crDerive(cx: i32, cy: i32) -> CrCell {
  let k = crKindOf(cx, cy);
  let h = k.h;
  var r = CrCell(k.kind, h, h, h, 0, 0, 0, 0, 0, 0, 0, false);
  if (k.kind != CR_SPLIT) { return r; }
  let hiS = crIsSheet(cx + CR_NBX[k.hiN], cy + CR_NBY[k.hiN]);
  let loS = crIsSheet(cx + CR_NBX[k.loN], cy + CR_NBY[k.loN]);
  r.H = select(crFdiv(h + k.hi, 2), k.hi, hiS);
  r.L = select(crFdiv(h + k.lo, 2), k.lo, loS);
  r.F = crFdiv(4096 * (h - r.L), r.H - r.L);
  let gx = k.nb.x - k.nb.y;
  let gy = k.nb.z - k.nb.w;
  let m = max(abs(gx), abs(gy));
  if (4 * m < k.hi - k.lo) {
    r.saddle = true;
    r.a = 2 * (CR_NBX[k.hiN] - CR_NBX[k.loN]);
    r.b = 2 * (CR_NBY[k.hiN] - CR_NBY[k.loN]);
  } else {
    r.a = crFdiv(8 * gx + m, 2 * m);
    r.b = crFdiv(8 * gy + m, 2 * m);
  }
  r.A = max(abs(r.a), abs(r.b));
  r.B = min(abs(r.a), abs(r.b));
  r.theta = crThetaOf(r.F, r.A, r.B, CR_N);
  return r;
}

// ---- which columns are up ----
fn crAmpOf(A: i32, l: u32, m: i32) -> i32 {
  return (CR_AMPL[l] * A * 2 * (CR_N >> l) * select(256, m, l >= CR_MASKFROM)) >> 16u;
}
fn crLevelOff(r: CrCell, cx: i32, cy: i32, l: u32, jx: i32, jy: i32) -> i32 {
  let gx = (cx << l) + jx;
  let gy = (cy << l) + jy;
  let px = gx >> 1u;
  let py = gy >> 1u;
  let ps = CR_N >> (l - 1u);
  var m = 256;
  if (l >= CR_MASKFROM) { m = crMaskAt(px * 2 * ps + ps, py * 2 * ps + ps); }
  let amp = crAmpOf(r.A, l, m);
  if (amp == 0) { return 0; }
  let h = crHash3(px, py, crSalt(CR_SALT_LEVEL + i32(l)));
  let h2 = crMix(h);
  let w = u32(2 * amp + 1);
  let u = i32(h % w) - amp;
  let v = i32(h2 % w) - amp;
  let pairing = i32((h2 >> 16u) % 3u);
  let k = (gx & 1) + 2 * (gy & 1);
  let inFirst = k == 0 || k == pairing + 1;
  let secondLow = select(1, 2, pairing == 0);
  let sgn = select(-1, 1, k == 0 || k == secondLow);
  return sgn * select(v, u, inFirst);
}
fn crWCentre(bj: i32) -> i32 { return 2 * bj * CR_BS + CR_BS - CR_N; }
fn crTieOf(gx: i32, gy: i32) -> i32 { return i32(crHash3(gx, gy, crSalt(CR_SALT_TIE)) & u32(CR_TIE - 1)); }
fn crThetaUsed(r: CrCell) -> i32 { return r.theta * CR_TIE + r.dTheta; }
/** a fine column's score less the threshold (TIE units): >= 0 up (local fine index ix, iy in 0..N) */
fn crMarginOf(r: CrCell, cx: i32, cy: i32, ix: i32, iy: i32) -> i32 {
  var s = r.a * crWCentre(ix >> CR_WSH) + r.b * crWCentre(iy >> CR_WSH);
  for (var l = 1u; l <= CR_LF; l++) { s += crLevelOff(r, cx, cy, l, ix >> (CR_LF - l), iy >> (CR_LF - l)); }
  return s * CR_TIE + crTieOf((cx << CR_LF) + ix, (cy << CR_LF) + iy) - crThetaUsed(r);
}
fn crIsUp(r: CrCell, cx: i32, cy: i32, ix: i32, iy: i32) -> bool { return crMarginOf(r, cx, cy, ix, iy) >= 0; }

// ---- (step B2) the bound and the LOD representative ----
/** words a cell in the per-cell table (cliffbuild.wgsl) */
const CR_REC: u32 = 12u;
/** an upper bound of the mask over a coarse cell, /256 */
fn crMaskMaxOf(cx: i32, cy: i32) -> i32 {
  let ix = crFdiv(cx, CR_MASKP);
  let iy = crFdiv(cy, CR_MASKP);
  let s = crSalt(CR_SALT_MASK);
  let m = max(max(crHash3(ix, iy, s) & 255u, crHash3(ix + 1, iy, s) & 255u), max(crHash3(ix, iy + 1, s) & 255u, crHash3(ix + 1, iy + 1, s) & 255u));
  return crMaskRemap(i32(m));
}
/** the largest total amplitude of levels l+1..fineLevel (the mask at its bound mm) */
fn crRemAmp(A: i32, l: u32, mm: i32) -> i32 {
  var s = 0;
  for (var k = l + 1u; k <= CR_LF; k++) { s += crAmpOf(A, k, mm); }
  return s;
}
/** cellBound's split branch from its parts: whether any / every descendant of level-l cell (jx, jy) can be up, given its
 *  ancestors' and its own offset sum `known` and ra = crRemAmp(A, l, maskMax). x: any up, y: all up */
fn crNodeUp(r: CrCell, l: u32, jx: i32, jy: i32, known: i32, ra: i32) -> vec2<bool> {
  let s = CR_N >> l;
  let p0 = crWCentre((jx * s) >> CR_WSH);
  let p1 = crWCentre((jx * s + s - 1) >> CR_WSH);
  let q0 = crWCentre((jy * s) >> CR_WSH);
  let q1 = crWCentre((jy * s + s - 1) >> CR_WSH);
  let wmax = select(r.a * p0, r.a * p1, r.a > 0) + select(r.b * q0, r.b * q1, r.b > 0);
  let wmin = select(r.a * p1, r.a * p0, r.a > 0) + select(r.b * q1, r.b * q0, r.b > 0);
  let th = crThetaUsed(r);
  return vec2<bool>((wmax + known + ra) * CR_TIE + CR_TIE - 1 >= th, (wmin + known - ra) * CR_TIE >= th);
}
/** isUpLod: level-l cell (jx, jy) up when its centre would be, the finer levels' offsets taken as zero */
fn crIsUpLod(r: CrCell, cx: i32, cy: i32, l: u32, jx: i32, jy: i32, known: i32) -> bool {
  let s = CR_N >> l;
  let inBlock = l >= CR_LF - CR_WSH;
  let pc = select(2 * jx * s + s - CR_N, crWCentre((jx * s) >> CR_WSH), inBlock);
  let qc = select(2 * jy * s + s - CR_N, crWCentre((jy * s) >> CR_WSH), inBlock);
  let tie = select(CR_TIE >> 1u, crTieOf((cx << CR_LF) + jx, (cy << CR_LF) + jy), s == 1);
  return (r.a * pc + r.b * qc + known) * CR_TIE + tie >= crThetaUsed(r);
}
