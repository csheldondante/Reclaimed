// ---- nested/gpu/field.wgsl (round 26): the field mesh, on trial behind ?field= (docs/design/NESTED_SCALES.md "Round
// 26 plan"; the CPU reference is src/nested/fieldsel.ts). Appended to store.wgsl + nest.wgsl in a module of its own,
// made only when ?field is set, so with it off nothing here is compiled.
//
// The field (level-local units): a column's vertical signed distance to its inside runs (negative inside, clamped to
// +-FFAR), bilinear over the 4 nearest column centres at the warped lookup point; a child level fades to its parent's
// field near its window edge (applied here, when sampled; the stored columns are untouched). Samples at column
// centres, one unit apart in z; cell (X, Y, K) between sample columns X..X+1, Y..Y+1 and heights K..K+1.
//
// fieldBake (a workgroup a chunk of a field level, over a bake slot like sheetBake): per cell column the candidate cells
// from one merge sweep over its support columns' boundaries (the selection, exact: test/unit/nested-field.test.ts),
// counted and scanned; a vertex per crossed candidate (the mean of its edge crossings, the normal from the field's
// gradient) into scratch pages; the quads (two triangles a crossed sample edge, joining the four cells round it; a skirt
// or a corner triangle where the drawn region ends) counted, scanned and written into the chunk's quad pages. Points
// are carried as (global cell column, f32 offset) so every chunk computes a shared vertex bit for bit the same.

const FIELD_ID: u32 = 24u;
const FSCR_ID: u32 = 56u;
const FFAR: f32 = 3.0;
/** quad pages: a 16-word header (page 0's: the chunk's), then 783 quads of 4 vertices x 4 words. (B3) Two banks: page 0
 *  is the header only; bank b's quads are cz 1 + b x FBANK on. A build writes the bank not drawn, then flips at once or,
 *  deferred (a level opening or sliding, spread over frames), when fieldFlip flips the whole level together. Header:
 *  0-1 hash, 2 the drawn bank, 3 the chunk key, 4 candidates, 5 vertices, 6 a deferred build waits, 7-8 each bank's quads */
const FHW: u32 = 16u;
const FQPP: u32 = 783u;
const FBANK: u32 = 4096u;
var<workgroup> fTB: u32;
var<private> fTBP: u32;
/** scratch entries, one a candidate cell: K, offset in the cell (2 x unorm16), z, normal, corner mask (0: not crossed),
 *  its cell column's index in the computing area */
const FVW: u32 = 6u;
const FVPP: u32 = 2090u;
/** computing cell columns of a chunk at most (38 x 38: 16 + 1 + 2 x OVER + 1 with OVER <= k / 2 + 2 = 10 at k 16) */
const FA_N: u32 = 1444u;
/** support columns at most: 4 x 4 own + 3 x 3 parent */
const FCUR: u32 = 25u;

// u for the field passes: a.w the level; r.x the bake slot; e.x mode (0 hash skip, 1 forced, 2 ring chunks only), e.y
// rows a band | bands << 16, e.z band + 1 (0: one band), e.w field levels (bits 0-7) | margin << 8 | inside test << 12;
// c: warp (columns), fade (columns), skirt (columns), -
fn fOn(m: u32) -> bool { return ((u32(u.e.w) >> m) & 1u) == 1u; }
fn fMargin() -> i32 { return (u.e.w >> 8u) & 15; }
/** which records count as inside: 0 solid (matSolid); a water surface later is another test, same mesher */
fn fInside(m: u32) -> bool {
  let sel = (u32(u.e.w) >> 12u) & 15u;
  if (sel == 0u) { return matSolid(m); }
  return false;
}
/** cell columns a field level draws past its window edge: 2 beyond a sheet or box parent (which stops at the footprint),
 *  k / 2 + 2 beyond a field parent (whose cells straddling the footprint reach up to half a parent column in) */
fn fOver(L: u32) -> i32 {
  if (L == 0u) { return 0; }
  return 2 + select(0, i32(u.a.x) / 2, fOn(L - 1u));
}

// ---- reading columns (a level's page 0 of the 3 x 3 chunks round the baked one cached) ----------------------------------
var<workgroup> fPg: array<u32, 9>;
var<private> fC: vec2<i32>;
fn fPage0(lv: u32, X: i32, Y: i32) -> u32 {
  if (lv == u.a.w) {
    let dx = (X >> 4u) - fC.x + 1;
    let dy = (Y >> 4u) - fC.y + 1;
    if (dx >= 0 && dx < 3 && dy >= 0 && dy < 3) { return fPg[dy * 3 + dx]; }
  }
  return pageOf(lv, X >> 4u, Y >> 4u, 0u);
}
fn fCount(lv: u32, X: i32, Y: i32) -> u32 {
  let p = fPage0(lv, X, Y);
  if (p >= NOT_LOADED) { return 0u; }
  let r = pgLoad(p * PW + colIn(X, Y)) & 0xffffu;
  if (r < KR) { return r; }
  return recCount(lv, X, Y);
}
/** record j of a column: (top bits, material word) */
fn fRec(lv: u32, X: i32, Y: i32, j: u32) -> vec2<u32> {
  if (j < KR) {
    let p = fPage0(lv, X, Y);
    if (p >= NOT_LOADED) { return vec2<u32>(bitcast<u32>(OPEN_BOTTOM), MAT_AIR); }
    let b = p * PW + 256u + (colIn(X, Y) * KR + j) * 2u;
    return vec2<u32>(pgLoad(b), pgLoad(b + 1u));
  }
  return recAt(lv, X, Y, j);
}
// ---- (round 26 B2, step 3) each column's runs read once a chunk: the boundaries (inside / outside changes) of every own
// column the chunk's samples and sweeps can read (the computing area + 1 below, + 2 above) and of the parent's columns
// under it, in the scratch pages' first region: a table (2 words a column: offset, count | inside at the bottom << 31),
// then the boundaries (f32, the column's own level's units)
var<private> fRunsOn: bool;
var<private> fRA: vec2<i32>;
var<private> fRW: i32;
var<private> fPA: vec2<i32>;
var<private> fPWd: i32;
/** the scratch's first pages: the run region's word w */
fn fRunW(w: u32) -> u32 {
  // (the run region nearly always fits its first page: no division)
  if (w < PW) { return fSp[0] * PW + w; }
  let cz = w / PW;
  var p = 0u;
  if (cz < 16u) { p = fSp[cz]; } else { p = pageOf(FSCR_ID + u.a.w, fC.x, fC.y, cz); }
  return p * PW + w % PW;
}
/** the run table's index of column (lv, X, Y), or -1 when it is not cached */
fn fRunT(lv: u32, X: i32, Y: i32) -> i32 {
  if (!fRunsOn) { return -1; }
  if (lv == u.a.w) {
    let r = vec2<i32>(X, Y) - fRA;
    if (r.x < 0 || r.y < 0 || r.x >= fRW || r.y >= fRW) { return -1; }
    return r.y * fRW + r.x;
  }
  if (lv + 1u != u.a.w) { return -1; }
  let r = vec2<i32>(X, Y) - fPA;
  if (r.x < 0 || r.y < 0 || r.x >= fPWd || r.y >= fPWd) { return -1; }
  return fRW * fRW + r.y * fPWd + r.x;
}
/** the run table's column t: (lv, X, Y) */
fn fRunCol(t: u32) -> vec3<i32> {
  let n0 = u32(fRW * fRW);
  if (t < n0) { return vec3<i32>(i32(u.a.w), fRA.x + i32(t) % fRW, fRA.y + i32(t) / fRW); }
  let r = i32(t - n0);
  return vec3<i32>(i32(u.a.w) - 1, fPA.x + r % fPWd, fPA.y + r / fPWd);
}
/** a column's boundaries from its records: counted, or (write) written from run word `at` on; x the count, y 1 when
 *  inside at the bottom */
fn fRunsOf(lv: u32, X: i32, Y: i32, at: u32, write: bool) -> vec2<u32> {
  let n = fCount(lv, X, Y);
  if (n == 0u) { return vec2<u32>(0u); }
  var nxt = fRec(lv, X, Y, 0u);
  let bottom = select(0u, 1u, fInside(nxt.y));
  var c = 0u;
  for (var j = 0u; j < n; j++) {
    let cur = nxt;
    let s = fInside(cur.y);
    var sn = false;
    if (j + 1u < n) {
      nxt = fRec(lv, X, Y, j + 1u);
      sn = fInside(nxt.y);
    }
    if (sn != s) {
      if (write) { pgStore(fRunW(at + c), cur.x); }
      c++;
    }
  }
  return vec2<u32>(c, bottom);
}
/** a cached column: (boundary offset, count, inside at the bottom) */
fn fRunAt(t: i32) -> vec3<u32> {
  let w1 = pgLoad(fRunW(u32(t) * 2u + 1u));
  return vec3<u32>(pgLoad(fRunW(u32(t) * 2u)), w1 & 0x7fffffffu, w1 >> 31u);
}
/** a column's vertical signed distance to its inside runs at z (negative inside), clamped to +-FFAR; 0 on a boundary */
fn fColDist(lv: u32, X: i32, Y: i32, z: f32) -> f32 {
  let t = fRunT(lv, X, Y);
  if (t >= 0) {
    let r = fRunAt(t);
    var s = r.z == 1u;
    var lo = -1e30;
    for (var j = 0u; j < r.y; j++) {
      let b = bitcast<f32>(pgLoad(fRunW(r.x + j)));
      if (z < b) {
        let d = min(min(z - lo, b - z), FFAR);
        return select(d, -d, s);
      }
      lo = b;
      s = !s;
    }
    if (r.y == 0u) { return select(FFAR, -FFAR, s); }
    return min(z - lo, FFAR);
  }
  let n = fCount(lv, X, Y);
  if (n == 0u) { return FFAR; }
  var lo = -1e30;
  var nxt = fRec(lv, X, Y, 0u);
  for (var j = 0u; j < n; j++) {
    let cur = nxt;
    let s = fInside(cur.y);
    var sn = false;
    if (j + 1u < n) {
      nxt = fRec(lv, X, Y, j + 1u);
      sn = fInside(nxt.y);
    }
    if (sn != s) {
      let t = bitcast<f32>(cur.x);
      if (z < t) {
        let d = min(min(z - lo, t - z), FFAR);
        return select(d, -d, s);
      }
      lo = t;
    }
  }
  return min(z - lo, FFAR);
}
fn fClampCol(lv: u32, c: vec2<i32>) -> vec2<i32> {
  let w = u.lv[lv];
  return clamp(c, w.xy, w.xy + vec2<i32>(w.z - 1));
}
/** the field's bilinear blend of level lv's columns at (I + f) (I a global column, f an offset), height z */
fn fBil(lv: u32, I: vec2<i32>, f: vec2<f32>, z: f32) -> f32 {
  let g = f - 0.5;
  let fl = floor(g);
  let i0 = I + vec2<i32>(fl);
  let t = g - fl;
  var d = 0.0;
  for (var c = 0u; c < 4u; c++) {
    let o = vec2<u32>(c & 1u, c >> 1u);
    let wx = select(1.0 - t.x, t.x, o.x == 1u);
    let wy = select(1.0 - t.y, t.y, o.y == 1u);
    if (wx * wy > 0.0) {
      let q = fClampCol(lv, i0 + vec2<i32>(o));
      d += wx * wy * fColDist(lv, q.x, q.y, z);
    }
  }
  return d;
}

// ---- the warp (fortress terrainWarp, in column units; fieldsel.ts warpXY) -----------------------------------------------
fn fHash3(i: vec3<i32>) -> f32 {
  var h = (bitcast<u32>(i.x) * 0x27d4eb2du) ^ (bitcast<u32>(i.y) * 0x165667b1u) ^ (bitcast<u32>(i.z) * 0x9e3779b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h ^= h >> 15u;
  return f32(h >> 8u) / 16777216.0;
}
/** value noise on the integer lattice: cell b, fraction t in [0, 1) */
fn fNoise(b: vec3<i32>, t0: vec3<f32>) -> f32 {
  let t = t0 * t0 * (3.0 - 2.0 * t0);
  let a = mix(fHash3(b), fHash3(b + vec3<i32>(1, 0, 0)), t.x);
  let bb = mix(fHash3(b + vec3<i32>(0, 1, 0)), fHash3(b + vec3<i32>(1, 1, 0)), t.x);
  let c = mix(fHash3(b + vec3<i32>(0, 0, 1)), fHash3(b + vec3<i32>(1, 0, 1)), t.x);
  let d = mix(fHash3(b + vec3<i32>(0, 1, 1)), fHash3(b + vec3<i32>(1, 1, 1)), t.x);
  return mix(mix(a, bb, t.y), mix(c, d, t.y), t.z);
}
/** the warp's sideways move at point (I + f.xy, f.z), up to u.c.x columns: noise at half a column's frequency in x, y
 *  (0.5: the global lattice cell and fraction split exactly, so every chunk gets the same bits) and 0.6 in z */
fn fWarp(I: vec2<i32>, f: vec3<f32>) -> vec2<f32> {
  let W = u.c.x;
  if (W <= 0.0) { return vec2<f32>(0.0); }
  let fl = floor(f.xy);
  let gi = I + vec2<i32>(fl);
  let lat = gi >> vec2<u32>(1u);
  let fr = (vec2<f32>(gi & vec2<i32>(1)) + f.xy - fl) * 0.5;
  let zq = f.z * 0.6;
  let iz = i32(floor(zq));
  let t = vec3<f32>(fr, zq - floor(zq));
  let n1 = fNoise(vec3<i32>(lat, iz), t);
  let n2 = fNoise(vec3<i32>(lat + vec2<i32>(17, 5), iz + 9), t);
  return (vec2<f32>(n1, n2) - 0.5) * (2.0 * W);
}
/** the own level's share at lookup point (I + q): 0 within 1 column of its window edge, 1 from 1 + fade in (the root: 1) */
fn fFade(L: u32, I: vec2<i32>, q: vec2<f32>) -> f32 {
  if (L == 0u) { return 1.0; }
  let w = u.lv[L];
  let r = vec2<f32>(I - w.xy) + q;
  let d = min(min(r.x, f32(w.z) - r.x), min(r.y, f32(w.z) - r.y));
  let t = clamp((d - 1.0) / u.c.y, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
/** the field at (I + f.xy, f.z) of level u.a.w: its own columns, faded to its parent's near the window edge */
fn fField(I: vec2<i32>, f: vec3<f32>) -> f32 {
  let L = u.a.w;
  let q = f.xy + fWarp(I, f);
  let w = fFade(L, I, q);
  let k = i32(u.a.x);
  var F = 0.0;
  // (one call site of fBil: source 0 the own level, 1 the parent)
  for (var s = 0u; s < 2u; s++) {
    var wt = w;
    var lv = L;
    var Ii = I;
    var ff = q;
    var z = f.z;
    var sc = 1.0;
    if (s == 1u) {
      if (L == 0u) { break; }
      wt = 1.0 - w;
      lv = L - 1u;
      Ii = vec2<i32>(fdiv(I.x, k), fdiv(I.y, k));
      ff = (vec2<f32>(I - Ii * k) + q) / f32(k);
      z = f.z / f32(k) + zOrigin(L);
      sc = f32(k);
    }
    if (wt > 0.0) { F += wt * clamp(fBil(lv, Ii, ff, z) * sc, -FFAR, FFAR); }
  }
  return F;
}

// ---- the selection: the merge sweep over a cell column's support ------------------------------------------------------
var<private> swLv: array<u32, 25>;
var<private> swX: array<i32, 25>;
var<private> swY: array<i32, 25>;
var<private> swN: array<u32, 25>;
var<private> swJ: array<u32, 25>;
var<private> swS: array<bool, 25>;
var<private> swB: array<f32, 25>;
var<private> swO: array<u32, 25>;
var<private> swCount: u32;
var<private> swIn: u32;
var<private> swPrev: f32;
var<private> swPend: vec2<i32>;
var<private> swHas: bool;
/** cursor i's next boundary from its record swJ (in the own level's z: a parent's converted), +inf past the last */
fn swAdvance(i: u32) {
  let lv = swLv[i];
  let n = swN[i];
  var j = swJ[i];
  swB[i] = 1e30;
  // (B2 step 3: a cached column's next boundary is its next stored one)
  if (swO[i] != NONE) {
    if (j < n) {
      var z = bitcast<f32>(pgLoad(fRunW(swO[i] + j)));
      if (lv != u.a.w) { z = (z - zOrigin(u.a.w)) * f32(u.a.x); }
      swB[i] = z;
      swJ[i] = j + 1u;
    }
    return;
  }
  loop {
    if (j >= n) { break; }
    let r = fRec(lv, swX[i], swY[i], j);
    var sn = false;
    if (j + 1u < n) { sn = fInside(fRec(lv, swX[i], swY[i], j + 1u).y); }
    if (sn != fInside(r.y)) {
      var z = bitcast<f32>(r.x);
      if (lv != u.a.w) { z = (z - zOrigin(u.a.w)) * f32(u.a.x); }
      swB[i] = z;
      swJ[i] = j + 1u;
      break;
    }
    j++;
  }
  if (swB[i] >= 1e29) { swJ[i] = n; }
}
fn swAdd(lv: u32, c: vec2<i32>) {
  let i = swCount;
  if (i >= FCUR) {
    // (more support columns than the cursors: cannot happen with warp < 1; counted, never silent)
    atomicAdd(&ctl[14], 1u);
    return;
  }
  swLv[i] = lv;
  swX[i] = c.x;
  swY[i] = c.y;
  swJ[i] = 0u;
  let t = fRunT(lv, c.x, c.y);
  if (t >= 0) {
    let r = fRunAt(t);
    swO[i] = r.x;
    swN[i] = r.y;
    swS[i] = r.z == 1u;
  } else {
    swO[i] = NONE;
    let n = fCount(lv, c.x, c.y);
    swN[i] = n;
    swS[i] = n > 0u && fInside(fRec(lv, c.x, c.y, 0u).y);
  }
  if (swS[i]) { swIn++; }
  swAdvance(i);
  swCount = i + 1u;
}
/** the sweep over cell column (X, Y)'s support set up */
fn swInit(X: i32, Y: i32) {
  let L = u.a.w;
  let W = u.c.x;
  swCount = 0u;
  swIn = 0u;
  swHas = false;
  let a = 0.5 - W;
  let b = 1.5 + W;
  var wantOwn = true;
  var wantPar = false;
  let w = u.lv[L];
  if (L > 0u) {
    // (the fade over the box of warped sample points: its largest and smallest distance to the window edge)
    let n = f32(w.z);
    let ra = vec2<f32>(vec2<i32>(X, Y) - w.xy) + a;
    let rb = vec2<f32>(vec2<i32>(X, Y) - w.xy) + b;
    let cc = clamp(vec2<f32>(n * 0.5), ra, rb);
    let hi = min(min(cc.x, n - cc.x), min(cc.y, n - cc.y));
    let lo = min(min(min(ra.x, n - ra.x), min(rb.x, n - rb.x)), min(min(ra.y, n - ra.y), min(rb.y, n - rb.y)));
    wantOwn = hi > 1.0;
    wantPar = lo < 1.0 + u.c.y;
  }
  // (the columns whose bilinear weight can be non-zero for a lookup point in [X + a, X + b]: fieldsel.ts support)
  let o0 = i32(floor(a - 0.5));
  let o1 = i32(ceil(b - 0.5));
  if (wantOwn) {
    for (var y = o0; y <= o1; y++) {
      for (var x = o0; x <= o1; x++) {
        let c = vec2<i32>(X + x, Y + y);
        if (L > 0u && (c.x < w.x || c.y < w.y || c.x >= w.x + w.z || c.y >= w.y + w.z)) { continue; }
        swAdd(L, fClampCol(L, c));
      }
    }
  }
  if (wantPar) {
    let k = f32(u.a.x);
    let p0 = vec2<i32>(floor((vec2<f32>(f32(X), f32(Y)) + a) / k - 0.5));
    let p1 = vec2<i32>(ceil((vec2<f32>(f32(X), f32(Y)) + b) / k - 0.5));
    for (var y = p0.y; y <= p1.y; y++) {
      for (var x = p0.x; x <= p1.x; x++) { swAdd(L - 1u, fClampCol(L - 1u, vec2<i32>(x, y))); }
    }
  }
  var low = 1e30;
  for (var i = 0u; i < swCount; i++) { low = min(low, swB[i]); }
  // (a column inside at the bottom beside one that is not: cut FFAR + 1 under the lowest boundary, NS-202)
  swPrev = low - FFAR - 1.0;
}
/** the next raw candidate interval (z0, z1), or z0 >= 1e29 when done */
fn swRaw() -> vec2<f32> {
  var zb = 1e30;
  for (var i = 0u; i < swCount; i++) { zb = min(zb, swB[i]); }
  if (zb >= 1e29) { return vec2<f32>(1e30); }
  var out = vec2<f32>(zb, zb);
  if (swIn > 0u && swIn < swCount) { out = vec2<f32>(swPrev, zb); }
  for (var i = 0u; i < swCount; i++) {
    if (swB[i] == zb) {
      // (its state flips at the boundary)
      if (swS[i]) { swIn--; } else { swIn++; }
      swS[i] = !swS[i];
      swAdvance(i);
    }
  }
  swPrev = zb;
  return out;
}
/** the next merged range of candidate cells [k0, k1], or k0 > k1 when done */
fn swNext() -> vec2<i32> {
  let m = fMargin();
  loop {
    let r = swRaw();
    if (r.x >= 1e29) {
      if (swHas) {
        swHas = false;
        return swPend;
      }
      return vec2<i32>(1, 0);
    }
    let k0 = i32(ceil(r.x)) - 1 - m;
    let k1 = i32(floor(r.y)) + m;
    if (swHas && k0 <= swPend.y + 1) {
      swPend.y = max(swPend.y, k1);
      continue;
    }
    if (swHas) {
      let o = swPend;
      swPend = vec2<i32>(k0, k1);
      return o;
    }
    swPend = vec2<i32>(k0, k1);
    swHas = true;
  }
  return vec2<i32>(1, 0);
}

// ---- the drawn region ---------------------------------------------------------------------------------------------------
/** whether level L draws cell column (X, Y): the root its window's inner cells; a child its window and OVER past it;
 *  less the cells wholly inside a live child's footprint (a cell straddling it stays: the child draws over it) */
fn fInD(L: u32, X: i32, Y: i32) -> bool {
  let w = u.lv[L];
  if (L == 0u) {
    if (X < w.x || Y < w.y || X >= w.x + w.z - 1 || Y >= w.y + w.z - 1) { return false; }
  } else {
    let o = fOver(L);
    if (X < w.x - 1 - o || Y < w.y - 1 - o || X >= w.x + w.z - 1 + o || Y >= w.y + w.z - 1 + o) { return false; }
  }
  if (L + 1u < 8u && u.lv[L + 1u].w != 0) {
    let c = u.lv[L + 1u];
    let k = i32(u.a.x);
    let f0 = vec2<i32>(fdiv(c.x, k), fdiv(c.y, k));
    let f1 = vec2<i32>(fdiv(c.x + c.z, k), fdiv(c.y + c.z, k));
    if (X >= f0.x && X + 1 < f1.x && Y >= f0.y && Y + 1 < f1.y) { return false; }
  }
  return true;
}
/** whether cell column (X, Y) is computed: drawn, or beside a drawn one (its cells close the quads and skirts there) */
fn fComputed(L: u32, X: i32, Y: i32) -> bool {
  for (var j = 0; j < 9; j++) {
    if (fInD(L, X - 1 + j % 3, Y - 1 + j / 3)) { return true; }
  }
  return false;
}

// ---- the bake's workgroup state ---------------------------------------------------------------------------------------
var<workgroup> fOffV: array<u32, 1444>;
var<workgroup> fNV: array<u32, 1444>;
var<workgroup> fSp: array<u32, 16>;
var<workgroup> fQp: array<u32, 16>;
var<workgroup> fHdr: u32;
var<private> fA0: vec2<i32>;
var<private> fAW: i32;

/** the deepest page stack of the field's pages so far: ctl 11 (its own, so the column ops' reserves do not grow) */
fn fEnsure(lid: u32, cx: i32, cy: i32, need: u32) {
  for (var cz = 0u; cz < need; cz++) {
    if (tFind(tKey0(cx, cy), tKey1(lid, cz)) == NONE) {
      let p = allocPage();
      if (p != NONE) {
        if (tInsert(tKey0(cx, cy), tKey1(lid, cz), p, u.d.x)) { atomicMax(&ctl[11], cz); } else { freePage(p); }
      }
    }
  }
  var cz = need;
  loop {
    let s = tFind(tKey0(cx, cy), tKey1(lid, cz));
    if (s == NONE) { break; }
    let p = atomicLoad(&tab[s * 4u + 2u]);
    if (p < NOT_LOADED) { freePage(p); }
    atomicStore(&tab[s * 4u + 1u], TOMB);
    cz++;
  }
}
/** word address of scratch vertex entry i */
fn fScr(i: u32) -> u32 {
  let cz = fPrP + i / FVPP;
  var p = 0u;
  if (cz < 16u) { p = fSp[cz]; } else { p = pageOf(FSCR_ID + u.a.w, fC.x, fC.y, cz); }
  return p * PW + (i % FVPP) * FVW;
}
// ---- (round 26 B2, step 2) the samples, each evaluated once a chunk and shared by the cells round it: per sample column
// (the computing area's cell columns + 1 each way up) the z hull of the candidates of the 4 cell columns touching it,
// scanned; the table (offset, lo) and the values in the scratch pages after the candidate entries (word addressed)
var<workgroup> fPe: u32;
var<private> fPeP: u32;
/** (B2 step 3) the run region's pages (the scratch's first); the candidate entries start after them */
var<workgroup> fPr: u32;
var<private> fPrP: u32;
/** word address of word w of the sample region */
fn fSW(w: u32) -> u32 {
  if (w < PW && fPeP < 16u) { return fSp[fPeP] * PW + w; }
  let cz = fPeP + w / PW;
  var p = 0u;
  if (cz < 16u) { p = fSp[cz]; } else { p = pageOf(FSCR_ID + u.a.w, fC.x, fC.y, cz); }
  return p * PW + w % PW;
}
/** the first and last candidate K of computing-area cell column (X, Y) (an empty hull when none) */
fn fColKs(X: i32, Y: i32) -> vec2<i32> {
  let q = fIdx(X, Y);
  if (q < 0 || fNV[q] == 0u) { return vec2<i32>(1 << 30, -(1 << 30)); }
  return vec2<i32>(bitcast<i32>(pgLoad(fScr(fOffV[q]))), bitcast<i32>(pgLoad(fScr(fOffV[q] + fNV[q] - 1u))));
}
/** sample column s's z hull [lo, hi] (hi < lo: no samples) */
fn fSHull(s: u32) -> vec2<i32> {
  let w = u32(fAW + 1);
  let sx = fA0.x + i32(s % w);
  let sy = fA0.y + i32(s / w);
  var h = vec2<i32>(1 << 30, -(1 << 30));
  for (var j = 0; j < 4; j++) {
    let k = fColKs(sx - 1 + (j & 1), sy - 1 + (j >> 1));
    h = vec2<i32>(min(h.x, k.x), max(h.y, k.y + 1));
  }
  return h;
}
/** the field's value at sample (sample column X, Y; height z), from the table */
fn fSample(X: i32, Y: i32, z: i32) -> f32 {
  let w = fAW + 1;
  let s = u32((Y - fA0.y) * w + (X - fA0.x));
  let off = pgLoad(fSW(s * 2u));
  let lo = bitcast<i32>(pgLoad(fSW(s * 2u + 1u)));
  let ns = u32(w * w);
  return bitcast<f32>(pgLoad(fSW(2u * ns + off + u32(z - lo))));
}
/** word address of quad slot i */
fn fQuadAt(i: u32) -> u32 {
  let cz = i / FQPP;
  var p = 0u;
  if (cz < 16u) { p = fQp[cz]; } else { p = pageOf(FIELD_ID + u.a.w, fC.x, fC.y, 1u + fTBP * FBANK + cz); }
  return p * PW + FHW + (i % FQPP) * 16u;
}
/** pages cz base .. base + need - 1 of a chunk's stack made (missing ones), and those from base + need on let go up to
 *  the first missing one (one bank of the quad pages) */
fn fEnsureFrom(lid: u32, cx: i32, cy: i32, base: u32, need: u32) {
  for (var cz = base; cz < base + need; cz++) {
    if (tFind(tKey0(cx, cy), tKey1(lid, cz)) == NONE) {
      let p = allocPage();
      if (p != NONE) {
        if (tInsert(tKey0(cx, cy), tKey1(lid, cz), p, u.d.x)) { atomicMax(&ctl[11], cz - base + 1u); } else { freePage(p); }
      }
    }
  }
  var cz = base + need;
  loop {
    let s = tFind(tKey0(cx, cy), tKey1(lid, cz));
    if (s == NONE) { break; }
    let p = atomicLoad(&tab[s * 4u + 2u]);
    if (p < NOT_LOADED) { freePage(p); }
    atomicStore(&tab[s * 4u + 1u], TOMB);
    cz++;
  }
}
/** the computing area's index of cell column (X, Y), or -1 */
fn fIdx(X: i32, Y: i32) -> i32 {
  let r = vec2<i32>(X, Y) - fA0;
  if (r.x < 0 || r.y < 0 || r.x >= fAW || r.y >= fAW) { return -1; }
  return r.y * fAW + r.x;
}
/** the scratch entry of cell (X, Y, K), or NONE (a binary search of its column's entries by K) */
fn fFind(X: i32, Y: i32, K: i32) -> u32 {
  let q = fIdx(X, Y);
  if (q < 0) { return NONE; }
  var lo = fOffV[q];
  var hi = lo + fNV[q];
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    let km = bitcast<i32>(pgLoad(fScr(mid)));
    if (km == K) {
      // (a candidate the surface does not cross has mask 0: no vertex)
      if (pgLoad(fScr(mid) + 4u) == 0u) { return NONE; }
      return mid;
    }
    if (km < K) { lo = mid + 1u; } else { hi = mid; }
  }
  return NONE;
}

const FEDGE = array<vec2<u32>, 12>(
  vec2<u32>(0u, 1u), vec2<u32>(2u, 3u), vec2<u32>(4u, 5u), vec2<u32>(6u, 7u),
  vec2<u32>(0u, 2u), vec2<u32>(1u, 3u), vec2<u32>(4u, 6u), vec2<u32>(5u, 7u),
  vec2<u32>(0u, 4u), vec2<u32>(1u, 5u), vec2<u32>(2u, 6u), vec2<u32>(3u, 7u));

/** (round 26 B2, step 1) candidate cell i (its scratch entry: K, column index written by the list pass): its 8 corners
 *  evaluated; crossed: its vertex written into the entry (mask non-zero), else the entry's mask stays 0 */
fn fCell(i: u32) {
  let b = fScr(i);
  let K = bitcast<i32>(pgLoad(b));
  let q = i32(pgLoad(b + 5u));
  let I = fA0 + vec2<i32>(q % fAW, q / fAW);
  var v: array<f32, 8>;
  for (var c = 0u; c < 8u; c++) {
    v[c] = fSample(I.x + i32(c & 1u), I.y + i32((c >> 1u) & 1u), K + i32(c >> 2u));
  }
  {
      var mask = 0u;
      for (var c = 0u; c < 8u; c++) {
        if (v[c] < 0.0) { mask |= 1u << c; }
      }
      if (mask == 0u || mask == 255u) { return; }
      // the mean of the edge crossings, in the cell
      var acc = vec3<f32>(0.0);
      var ne = 0.0;
      for (var e = 0u; e < 12u; e++) {
        let a = FEDGE[e].x;
        let b = FEDGE[e].y;
        if ((v[a] < 0.0) == (v[b] < 0.0)) { continue; }
        let t = v[a] / (v[a] - v[b]);
        let ca = vec3<f32>(f32(a & 1u), f32((a >> 1u) & 1u), f32(a >> 2u));
        let cb = vec3<f32>(f32(b & 1u), f32((b >> 1u) & 1u), f32(b >> 2u));
        acc += mix(ca, cb, t);
        ne += 1.0;
      }
      let t = clamp(acc / ne, vec3<f32>(0.0), vec3<f32>(1.0));
      let fp = vec3<f32>(0.5 + t.x, 0.5 + t.y, f32(K) + t.z);
      // the normal: the field's gradient, central differences of the field itself (smooth across cells)
      var g = vec3<f32>(0.0);
      // (measurement only, ?fnorm=cell, u.c.w 1: the gradient of the cell's trilinear blend at the vertex, no field
      // evaluated: what the 6 evaluations cost)
      let nd = select(6u, 0u, (u32(u.c.w) & 1u) == 1u);
      if (nd == 0u) {
        for (var c = 0u; c < 8u; c++) {
          let o = vec3<f32>(f32(c & 1u), f32((c >> 1u) & 1u), f32(c >> 2u));
          let wv = mix(1.0 - t, t, o);
          g += v[c] * vec3<f32>((o.x * 2.0 - 1.0) * wv.y * wv.z, (o.y * 2.0 - 1.0) * wv.x * wv.z, (o.z * 2.0 - 1.0) * wv.x * wv.y);
        }
      }
      for (var d = 0u; d < nd; d++) {
        let ax = d >> 1u;
        let sg = select(-1.0, 1.0, (d & 1u) == 0u);
        var off = vec3<f32>(0.0);
        off[ax] = 0.35 * sg;
        g[ax] += sg * fField(I, fp + off);
      }
      let nrm = normalize(g + vec3<f32>(0.0, 0.0, 1e-6));
      pgStore(b + 1u, pack2x16unorm(t.xy));
      pgStore(b + 2u, bitcast<u32>(fp.z));
      pgStore(b + 3u, octEnc(nrm));
      pgStore(b + 4u, mask);
  }
}
/** cell column q = (X, Y)'s candidate cells: counted, or (write) listed from scratch entry `at` on as (K, mask 0, q) */
fn fSweepCol(X: i32, Y: i32, q: u32, at: u32, write: bool) -> u32 {
  swInit(X, Y);
  var n = 0u;
  loop {
    let r = swNext();
    if (r.x > r.y) { break; }
    if (write) {
      for (var K = r.x; K <= r.y; K++) {
        let b = fScr(at + n + u32(K - r.x));
        pgStore(b, bitcast<u32>(K));
        pgStore(b + 4u, 0u);
        pgStore(b + 5u, q);
      }
    }
    n += u32(r.y - r.x + 1);
  }
  return n;
}

/** a quad round a crossed sample edge: its 4 corners as (scratch entry, cell column offset from the chunk + 512 | skirt
 *  << 20); n 0: none */
struct FQ {
  n: u32,
  e: vec4<u32>,
  c: vec4<u32>,
}
/** the quad of cell (X, Y, K)'s edge along axis ax (0 +x, 1 +y, 2 +z) from its first corner: the four cells round it
 *  when all are drawn; a skirt from the two drawn ones on a straight edge of the drawn region; a triangle of the three
 *  drawn ones at an inner corner (the child footprint's) */
fn fEdgeQuad(X: i32, Y: i32, K: i32, ax: u32) -> FQ {
  let L = u.a.w;
  var o = FQ(0u, vec4<u32>(NONE), vec4<u32>(0u));
  // the four cells round the edge, in order round it: (column offset, K offset)
  var cx: array<vec2<i32>, 4>;
  var ck: array<i32, 4>;
  if (ax == 2u) {
    cx = array<vec2<i32>, 4>(vec2<i32>(-1, -1), vec2<i32>(0, -1), vec2<i32>(0, 0), vec2<i32>(-1, 0));
    ck = array<i32, 4>(0, 0, 0, 0);
  } else {
    let s = select(vec2<i32>(0, -1), vec2<i32>(-1, 0), ax == 1u);
    cx = array<vec2<i32>, 4>(s, vec2<i32>(0), vec2<i32>(0), s);
    ck = array<i32, 4>(-1, -1, 0, 0);
  }
  var inD = 0u;
  var nIn = 0u;
  for (var i = 0u; i < 4u; i++) {
    if (fInD(L, X + cx[i].x, Y + cx[i].y)) {
      inD |= 1u << i;
      nIn++;
    }
  }
  // which corners, in order: all four; or a pair (i, i + 1) with its skirt copies; or the three drawn
  var pick = vec4<u32>(0u, 1u, 2u, 3u);
  var skirt = vec4<u32>(0u);
  if (nIn == 4u) {
  } else if (nIn == 3u && ax == 2u) {
    var t = array<u32, 3>(0u, 0u, 0u);
    var j = 0u;
    // (from the corner after the missing one, so the three stay in order round the edge)
    var m = 0u;
    for (var i = 0u; i < 4u; i++) {
      if (((inD >> i) & 1u) == 0u) { m = i; }
    }
    for (var i = 1u; i < 4u; i++) {
      t[j] = (m + i) % 4u;
      j++;
    }
    pick = vec4<u32>(t[0], t[1], t[2], t[2]);
  } else if (nIn == 2u) {
    var a = 4u;
    for (var i = 0u; i < 4u; i++) {
      if (((inD >> i) & 1u) == 1u && ((inD >> ((i + 1u) % 4u)) & 1u) == 1u) { a = i; }
    }
    if (a == 4u) { return o; }
    let b2 = (a + 1u) % 4u;
    pick = vec4<u32>(a, b2, b2, a);
    skirt = vec4<u32>(0u, 0u, 1u, 1u);
  } else {
    return o;
  }
  for (var i = 0u; i < 4u; i++) {
    let p = pick[i];
    let e = fFind(X + cx[p].x, Y + cx[p].y, K + ck[p]);
    if (e == NONE) {
      // (a crossed edge's cell without a vertex: the selection missed it; counted, the quad left out)
      atomicAdd(&ctl[14], 1u);
      return o;
    }
    o.e[i] = e;
    let rx = u32(X + cx[p].x - fC.x * 16 + 512);
    let ry = u32(Y + cx[p].y - fC.y * 16 + 512);
    o.c[i] = rx | (ry << 10u) | (skirt[i] << 20u);
  }
  o.n = 1u;
  return o;
}

@compute @workgroup_size(16, 16)
fn fieldBake(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  if (u.e.z != 0) {
    let per = max(u.e.y & 0xffff, 1);
    var bi = i32(wid.y) / per;
    let nb = u.e.y >> 16u;
    if (nb > 0) { bi = min(bi, nb - 1); }
    if (bi != u.e.z - 1) { return; }
  }
  let w = u.lv[L];
  let ring = L > 0u && (cx * 16 == w.x || cy * 16 == w.y || cx * 16 + 16 == w.x + w.z || cy * 16 + 16 == w.y + w.z);
  // (mode 2: another level changed; only the window's ring of chunks reads another level: the fade and the cells past
  // the edge)
  if (u.e.x == 2 && !ring) { return; }
  fC = vec2<i32>(cx, cy);
  if (li < 9u) { fPg[li] = pageOf(L, cx - 1 + i32(li % 3u), cy - 1 + i32(li / 3u), 0u); }
  if (li == 0u) {
    if (pageOf(FIELD_ID + L, cx, cy, 0u) >= NOT_LOADED) {
      fEnsure(FIELD_ID + L, cx, cy, 1u);
      // (a fresh header: bank 0 active and empty, nothing pending)
      let p = pageOf(FIELD_ID + L, cx, cy, 0u);
      if (p < NOT_LOADED) {
        for (var w = 0u; w < FHW; w++) { pgStore(p * PW + w, 0u); }
      }
    }
    fHdr = pageOf(FIELD_ID + L, cx, cy, 0u);
    // (the bank this build writes: the one not drawn)
    if (fHdr < NOT_LOADED) { fTB = 1u - (pgLoad(fHdr * PW + 2u) & 1u); }
  }
  let hp = workgroupUniformLoad(&fHdr);
  if (hp >= NOT_LOADED) { return; }
  let hb = hp * PW;
  fTBP = workgroupUniformLoad(&fTB);
  let deferred = ((u32(u.e.w) >> 16u) & 1u) == 1u;
  // the hash skip (an edit's own region, mode 0): the chunk's columns and four round it unchanged
  var ha = 0u;
  var hb2 = 0u;
  for (var q = li; q < 576u; q += 256u) {
    let X = cx * 16 - 4 + i32(q % 24u);
    let Y = cy * 16 - 4 + i32(q / 24u);
    var a = (q + 1u) * 0x9e3779b1u;
    var b = (q + 7u) * 0x27d4eb2du;
    if (inWin(L, X, Y)) {
      let n = fCount(L, X, Y);
      a ^= n * 0x85ebca6bu;
      b ^= n * 0x165667b1u;
      for (var j = 0u; j < n; j++) {
        let r = fRec(L, X, Y, j);
        a = (a ^ r.x ^ (r.y << 24u)) * 0x2c1b3c6du;
        a ^= a >> 15u;
        b = (b ^ (r.x * 0x9e3779b1u) ^ r.y) * 0x297a2d39u;
        b ^= b >> 13u;
      }
    }
    ha += a;
    hb2 += b;
  }
  let hA = wgScan(li, ha).y | 1u;
  let hB = wgScan(li, hb2).y;
  if (li == 0u) {
    // (not over a build still waiting for its flip, nor a deferred one)
    let same = u.e.x == 0 && !deferred && pgLoad(hb + 6u) == 0u && pgLoad(hb) == hA && pgLoad(hb + 1u) == hB;
    pgStore(hb, hA);
    pgStore(hb + 1u, hB);
    wflag = select(0u, 1u, same);
    atomicAdd(&ctl[12], 1u);
    if (!same) { atomicAdd(&ctl[13], 1u); }
  }
  if (workgroupUniformLoad(&wflag) == 1u) { return; }
  // the computing area: the chunk's cell columns, one more on the low sides (the quads' lower cells), and at the window
  // edge OVER past it (+ 1 on the high sides: the skirts' base columns)
  let ov = fOver(L);
  let x0 = cx * 16;
  let y0 = cy * 16;
  var eL = vec2<i32>(0);
  var eH = vec2<i32>(0);
  if (L > 0u) {
    eL = vec2<i32>(select(0, ov, x0 == w.x), select(0, ov, y0 == w.y));
    eH = vec2<i32>(select(0, ov + 1, x0 + 16 == w.x + w.z), select(0, ov + 1, y0 + 16 == w.y + w.z));
  }
  fA0 = vec2<i32>(x0, y0) - 1 - eL;
  let a1 = vec2<i32>(x0, y0) + 16 + eH;
  // (a square area: the larger side; columns past the smaller side are not computed)
  fAW = max(a1.x - fA0.x, a1.y - fA0.y);
  let NA = u32(fAW * fAW);
  // 0. (B2 step 3) the runs of every column the chunk reads, once: counted, scanned, written
  fRunsOn = false;
  fRA = fA0 - 1;
  fRW = fAW + 3;
  fPWd = 0;
  if (L > 0u) {
    let k = i32(u.a.x);
    fPA = vec2<i32>(fdiv(fRA.x, k), fdiv(fRA.y, k)) - 1;
    let pe = vec2<i32>(fdiv(fRA.x + fRW, k), fdiv(fRA.y + fRW, k)) + 2;
    fPWd = max(pe.x - fPA.x, pe.y - fPA.y);
  }
  let NT = u32(fRW * fRW + fPWd * fPWd);
  if (li == 0u) {
    let need = (2u * NT + PW - 1u) / PW;
    fEnsure(FSCR_ID + L, cx, cy, need);
    wflag = 0u;
    for (var z = 0u; z < need; z++) {
      if (pageOf(FSCR_ID + L, cx, cy, z) >= NOT_LOADED) { wflag = 1u; }
    }
    if (wflag == 1u) { fFail(hb, deferred); }
  }
  storageBarrier();
  workgroupBarrier();
  if (workgroupUniformLoad(&wflag) == 1u) { return; }
  if (li < 16u) { fSp[li] = pageOf(FSCR_ID + L, cx, cy, li); }
  workgroupBarrier();
  let tper = (NT + 255u) / 256u;
  let t0 = li * tper;
  let t1 = min(NT, t0 + tper);
  var tb = 0u;
  for (var t = t0; t < t1; t++) {
    let c = fRunCol(t);
    let r = fRunsOf(u32(c.x), c.y, c.z, 0u, false);
    pgStore(fRunW(t * 2u + 1u), r.x | (r.y << 31u));
    tb += r.x;
  }
  let rs = wgScan(li, tb);
  if (li == 0u) {
    fPr = (2u * NT + rs.y + PW - 1u) / PW;
    fEnsure(FSCR_ID + L, cx, cy, fPr);
    wflag = 0u;
    for (var z = 0u; z < fPr; z++) {
      if (pageOf(FSCR_ID + L, cx, cy, z) >= NOT_LOADED) { wflag = 1u; }
    }
    if (wflag == 1u) { fFail(hb, deferred); }
  }
  storageBarrier();
  workgroupBarrier();
  if (workgroupUniformLoad(&wflag) == 1u) { return; }
  if (li < 16u) { fSp[li] = pageOf(FSCR_ID + L, cx, cy, li); }
  workgroupBarrier();
  var toff = 2u * NT + rs.x;
  for (var t = t0; t < t1; t++) {
    let c = fRunCol(t);
    let n = pgLoad(fRunW(t * 2u + 1u)) & 0x7fffffffu;
    pgStore(fRunW(t * 2u), toff);
    fRunsOf(u32(c.x), c.y, c.z, toff, true);
    toff += n;
  }
  storageBarrier();
  workgroupBarrier();
  fPrP = workgroupUniformLoad(&fPr);
  fRunsOn = true;
  // 1. candidate cells per computed cell column, scanned into scratch offsets
  var tot = 0u;
  for (var q = li; q < FA_N; q += 256u) {
    var c = 0u;
    if (q < NA) {
      let X = fA0.x + i32(q) % fAW;
      let Y = fA0.y + i32(q) / fAW;
      if (X < a1.x && Y < a1.y && fComputed(L, X, Y)) { c = fSweepCol(X, Y, q, 0u, false); }
    }
    fNV[q] = c;
    tot += c;
  }
  let sc = wgScan(li, tot);
  var off = sc.x;
  for (var q = li; q < FA_N; q += 256u) {
    fOffV[q] = off;
    off += fNV[q];
  }
  let N = sc.y;
  let NS = u32((fAW + 1) * (fAW + 1));
  if (li == 0u) {
    // (the candidate entries' pages, then the sample table's: 2 words a sample column)
    fPe = fPrP + (N + FVPP - 1u) / FVPP;
    let need = fPe + (2u * NS + PW - 1u) / PW;
    fEnsure(FSCR_ID + L, cx, cy, need);
    wflag = 0u;
    for (var z = 0u; z < need; z++) {
      if (pageOf(FSCR_ID + L, cx, cy, z) >= NOT_LOADED) { wflag = 1u; }
    }
    // (the pool full: the chunk draws nothing until it is baked again; the refusal is counted and shown)
    if (wflag == 1u) { fFail(hb, deferred); }
    pgStore(hb + 3u, u32(cx) | (u32(cy) << 16u));
    pgStore(hb + 4u, N);
  }
  storageBarrier();
  workgroupBarrier();
  if (workgroupUniformLoad(&wflag) == 1u) { return; }
  // (measurement only, u.c.w bit 2: stop after the count, the chunk drawn empty; bit 4: after the vertices)
  if ((u32(u.c.w) & 2u) != 0u) {
    if (li == 0u) { fFail(hb, deferred); }
    return;
  }
  if (li < 16u) { fSp[li] = pageOf(FSCR_ID + L, cx, cy, li); }
  workgroupBarrier();
  // 2. (round 26 B2, step 1) the candidates listed per cell column (K and the column, a thread a column: the sweep only),
  // then evaluated a thread a candidate over the flat list, so a long column no longer runs in one thread
  for (var q = li; q < FA_N; q += 256u) {
    if (q < NA && fNV[q] > 0u) { fSweepCol(fA0.x + i32(q) % fAW, fA0.y + i32(q) / fAW, q, fOffV[q], true); }
  }
  storageBarrier();
  workgroupBarrier();
  // 3. (B2, step 2) the samples: per sample column its z hull, scanned into the table, then each sample evaluated once,
  // a thread a sample over the flat list
  fPeP = workgroupUniformLoad(&fPe);
  var tsn = 0u;
  // (a thread a contiguous run of sample columns, so the scanned offsets ascend with the sample column: the flat pass
  // finds a sample's column by a binary search)
  let sper = (NS + 255u) / 256u;
  let s0 = li * sper;
  let s1 = min(NS, s0 + sper);
  for (var s = s0; s < s1; s++) {
    let h = fSHull(s);
    let c = u32(max(h.y - h.x + 1, 0));
    pgStore(fSW(s * 2u), c);
    pgStore(fSW(s * 2u + 1u), bitcast<u32>(h.x));
    tsn += c;
  }
  let ss = wgScan(li, tsn);
  var soff = ss.x;
  for (var s = s0; s < s1; s++) {
    let c = pgLoad(fSW(s * 2u));
    pgStore(fSW(s * 2u), soff);
    soff += c;
  }
  let NSV = ss.y;
  if (li == 0u) {
    let need = fPeP + (2u * NS + NSV + PW - 1u) / PW;
    fEnsure(FSCR_ID + L, cx, cy, need);
    wflag = 0u;
    for (var z = 0u; z < need; z++) {
      if (pageOf(FSCR_ID + L, cx, cy, z) >= NOT_LOADED) { wflag = 1u; }
    }
    if (wflag == 1u) { fFail(hb, deferred); }
  }
  storageBarrier();
  workgroupBarrier();
  if (workgroupUniformLoad(&wflag) == 1u) { return; }
  if (li < 16u) { fSp[li] = pageOf(FSCR_ID + L, cx, cy, li); }
  workgroupBarrier();
  let sw = u32(fAW + 1);
  for (var i = li; i < NSV; i += 256u) {
    // (the sample column: the last whose offset is at most i)
    var lo = 0u;
    var hi = NS;
    loop {
      if (hi - lo <= 1u) { break; }
      let mid = (lo + hi) / 2u;
      if (pgLoad(fSW(mid * 2u)) <= i) { lo = mid; } else { hi = mid; }
    }
    let z = bitcast<i32>(pgLoad(fSW(lo * 2u + 1u))) + i32(i - pgLoad(fSW(lo * 2u)));
    let I = fA0 + vec2<i32>(i32(lo % sw), i32(lo / sw));
    pgStore(fSW(2u * NS + i), bitcast<u32>(fField(I, vec3<f32>(0.5, 0.5, f32(z)))));
  }
  storageBarrier();
  workgroupBarrier();
  var nv = 0u;
  for (var i = li; i < N; i += 256u) {
    fCell(i);
    if (pgLoad(fScr(i) + 4u) != 0u) { nv++; }
  }
  storageBarrier();
  workgroupBarrier();
  if ((u32(u.c.w) & 4u) != 0u) {
    if (li == 0u) { fFail(hb, deferred); }
    return;
  }
  // 3. the quads of the owned cell columns' crossed edges, counted then written (one call site of fEdgeQuad)
  let own0 = vec2<i32>(x0, y0) - eL;
  var tq = 0u;
  var at = 0u;
  for (var ps = 0u; ps < 2u; ps++) {
    if (ps == 1u) {
      let s2 = wgScan(li, tq);
      at = s2.x;
      let Q = s2.y;
      if (li == 0u) {
        // (the target bank's quad pages: cz 1 + bank x FBANK on)
        let base = 1u + fTBP * FBANK;
        let need = (Q + FQPP - 1u) / FQPP;
        fEnsureFrom(FIELD_ID + L, cx, cy, base, need);
        wflag = 0u;
        for (var z = 0u; z < need; z++) {
          if (pageOf(FIELD_ID + L, cx, cy, base + z) >= NOT_LOADED) { wflag = 1u; }
        }
        if (wflag == 1u) { fFail(hb, deferred); } else { pgStore(hb + 7u + fTBP, Q); }
      }
      storageBarrier();
      workgroupBarrier();
      if (li < 16u) { fQp[li] = pageOf(FIELD_ID + L, cx, cy, 1u + fTBP * FBANK + li); }
      workgroupBarrier();
    }
    let fail = ps == 1u && workgroupUniformLoad(&wflag) == 1u;
    // (a thread a candidate, over the flat list)
    for (var j = li; j < N; j += 256u) {
      if (fail) { break; }
      {
        let b = fScr(j);
        let mask = pgLoad(b + 4u);
        if (mask == 0u) { continue; }
        let K = bitcast<i32>(pgLoad(b));
        let q = i32(pgLoad(b + 5u));
        let X = fA0.x + q % fAW;
        let Y = fA0.y + q / fAW;
        if (X < own0.x || Y < own0.y || X >= a1.x || Y >= a1.y) { continue; }
        for (var ax = 0u; ax < 3u; ax++) {
          // (the edge from corner 0 along the axis: corner 1, 2 or 4)
          if (((mask ^ (mask >> (1u << ax))) & 1u) == 0u) { continue; }
          let fq = fEdgeQuad(X, Y, K, ax);
          if (fq.n == 0u) { continue; }
          if (ps == 0u) {
            tq++;
            continue;
          }
          let qa = fQuadAt(at);
          at++;
          for (var i = 0u; i < 4u; i++) {
            let e = fScr(fq.e[i]);
            pgStore(qa + i * 4u, fq.c[i]);
            pgStore(qa + i * 4u + 1u, pgLoad(e + 1u));
            pgStore(qa + i * 4u + 2u, pgLoad(e + 2u));
            pgStore(qa + i * 4u + 3u, pgLoad(e + 3u));
          }
        }
      }
    }
  }
  // (vertices made, for the measurement)
  let V = wgScan(li, nv).y;
  storageBarrier();
  workgroupBarrier();
  if (li == 0u) {
    pgStore(hb + 5u, V);
    // the scratch let go
    fEnsure(FSCR_ID + L, cx, cy, 0u);
    // (the new bank drawn at once, the old one let go; a deferred build waits for fieldFlip)
    if (wflag == 0u) { fFinish(hb, cx, cy, deferred); }
  }
}
/** a build done: drawn now (its bank made the active one, the other let go) or, deferred, marked for fieldFlip */
fn fFinish(hb: u32, cx: i32, cy: i32, deferred: bool) {
  if (deferred) {
    pgStore(hb + 6u, 1u);
    return;
  }
  pgStore(hb + 2u, fTBP);
  pgStore(hb + 6u, 0u);
  fEnsureFrom(FIELD_ID + u.a.w, cx, cy, 1u + (1u - fTBP) * FBANK, 0u);
}
/** the pool full: the target bank holds nothing; drawn at once (the chunk empty, as before) unless deferred */
fn fFail(hb: u32, deferred: bool) {
  pgStore(hb, 0u);
  pgStore(hb + 7u + fTBP, 0u);
  fFinish(hb, fC.x, fC.y, deferred);
}

// ---- release: a field level's quad and scratch pages let go (all, or those outside a chunk rect: a slide), beside
// nest.wgsl release (same uniform: a.w the level, e the rect kept)
@compute @workgroup_size(64)
fn fieldRelease(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 >= BUSY) { return; }
  let lid = k1 & 0xffu;
  if (lid != FIELD_ID + u.a.w && lid != FSCR_ID + u.a.w) { return; }
  let k0 = atomicLoad(&tab[s * 4u]);
  let cx = i32(k0 & 0xffffu);
  let cy = i32(k0 >> 16u);
  let keep = u.e;
  if (cx >= keep.x && cy >= keep.y && cx < keep.z && cy < keep.w) { return; }
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p < NOT_LOADED) { freePage(p); }
  atomicStore(&tab[s * 4u + 1u], TOMB);
}

// ---- the field's page list (its own buffers, bound at 8 and 9 in the directory layout): 8 counts, then per level u.r.y
// (the pool's pages) entries of 3 words (page, chunk key, quads in it); the draw arguments a level (6 vertices a quad
// slot, an instance a page)
@compute @workgroup_size(1)
fn fieldDirClear() {
  for (var L = 0u; L < 8u; L++) { atomicStore(&dir[L], 0u); }
}
@compute @workgroup_size(64)
fn fieldDirBuild(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 >= BUSY) { return; }
  let lid = k1 & 0xffu;
  if (lid < FIELD_ID || lid >= FIELD_ID + 8u) { return; }
  let L = lid - FIELD_ID;
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p >= NOT_LOADED) { return; }
  let cz = k1 >> 8u;
  // (page 0 is the header; a quad page is listed when it is of the drawn bank and holds quads)
  if (cz == 0u) { return; }
  let k0 = atomicLoad(&tab[s * 4u]);
  let p0 = pageOf(lid, i32(k0 & 0xffffu), i32(k0 >> 16u), 0u);
  if (p0 >= NOT_LOADED) { return; }
  let b = (cz - 1u) / FBANK;
  let j = (cz - 1u) % FBANK;
  if (b != pgLoad(p0 * PW + 2u)) { return; }
  let Q = pgLoad(p0 * PW + 7u + b);
  if (Q <= j * FQPP) { return; }
  let i = atomicAdd(&dir[L], 1u);
  let e = 8u + (L * u.r.y + i) * 3u;
  atomicStore(&dir[e], p);
  atomicStore(&dir[e + 1u], k0);
  atomicStore(&dir[e + 2u], min(FQPP, Q - j * FQPP));
}
/** (B3) every deferred build of level u.a.w made the drawn one at once: its bank flipped, the old bank let go */
@compute @workgroup_size(64)
fn fieldFlip(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 != FIELD_ID + u.a.w) { return; }
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p >= NOT_LOADED || pgLoad(p * PW + 6u) == 0u) { return; }
  let k0 = atomicLoad(&tab[s * 4u]);
  let old = pgLoad(p * PW + 2u) & 1u;
  pgStore(p * PW + 2u, 1u - old);
  pgStore(p * PW + 6u, 0u);
  fEnsureFrom(FIELD_ID + u.a.w, i32(k0 & 0xffffu), i32(k0 >> 16u), 1u + old * FBANK, 0u);
}
@compute @workgroup_size(1)
fn fieldDirFinish() {
  for (var L = 0u; L < 8u; L++) {
    dargs[L * 4u] = 6u * FQPP;
    dargs[L * 4u + 1u] = atomicLoad(&dir[L]);
    dargs[L * 4u + 2u] = 0u;
    dargs[L * 4u + 3u] = 0u;
  }
}
