// ---- nested/gpu/store.wgsl: the lab's paged column store, read side (docs/design/NESTED_SCALES.md "Storage") -------
// Prepended to the compute module (nest.wgsl) and the draw (draw.wgsl). The stage defines tabLoad(i) and pgLoad(i)
// (compute: atomic table; draw: read-only) and TCAP.
//
// Table entry (4 words): key0 = cx | cy << 16 (global chunk of the level's depth), key1 = level id | cz << 8, page,
// birth (f32 bits: when the page was handed out). Level ids: 0-7 a live level of that depth, 8-15 its residual, 16-23
// its baked faces, 32-39 a stroke's snapshot of it, 40-47 a pass's scratch columns (TMP).
//
// A page is PW words: 256 count words (one a column), then the records. Two record layouts share the page size:
// - COLUMN pages (live levels and snapshots): a column is a FULL PARTITION of height, an ordered list (bottom up) of
//   intervals of any material, air included, with shared boundaries. A record is two words: the interval's absolute
//   top (f32, level-local units) and its material. Its bottom is the top of the record below; the first record is
//   open downward; above the last record is air (a trailing air record is never stored). Adjacent records never have
//   the same material. KR = 24 records a page; the count word holds the page's records | its solid records << 16.
// - SOLID pages (residuals, TMP): the solid view, K = 16 records of three words (z0, z1, material). The passes' maths
//   (enhance, restrict, residuals, brushes) runs in this relative form; a pass writes TMP and `pack` converts it into
//   the partition at the pass boundary.

const K: u32 = 16u;
const KR: u32 = 24u;
const PW: u32 = 12544u; // 256 + 256 * 16 * 3 == 256 + 256 * 24 * 2
const NONE: u32 = 0xffffffffu;
const EMPTY: u32 = 0xffffffffu;
const NOT_LOADED: u32 = 0xfffffffeu;
const TOMB: u32 = 0xfffffffdu;
const BUSY: u32 = 0xfffffffcu;
const OPEN_BOTTOM: f32 = -1e30;
/** (round 18, the owner's snap to the grid) every stored bound is a multiple of 1/SNAP of its level's column unit; with
 *  k = 8 one parent step is exactly one child unit. Round half up (oracle.ts snapZ); OPEN_BOTTOM kept as it is. */
const SNAP: f32 = 8.0;
fn snapZ(z: f32) -> f32 {
  if (z <= OPEN_BOTTOM) { return z; }
  return floor(z * SNAP + 0.5) / SNAP;
}
const RES_ID: u32 = 8u;
const FACE_ID: u32 = 16u;
const SNAP_ID: u32 = 32u;
const TMP_ID: u32 = 40u;
const MAT_AIR: u32 = 0u;
/** TMP count words: a column the pass wrote (pack converts only those) */
const TOUCHED: u32 = 0x80000000u;

/** the material table's draw property: whether a material is drawn as an opaque solid (air and, later, water or lava
 *  as their own kinds). The mesher asks only this: a new material is a row here, not a change to the mesher. */
fn matSolid(m: u32) -> bool { return m != MAT_AIR; }

struct Ivl {
  z0: f32,
  z1: f32,
  m: u32,
}

fn tKey0(cx: i32, cy: i32) -> u32 { return u32(cx) | (u32(cy) << 16u); }
fn tKey1(lid: u32, cz: u32) -> u32 { return lid | (cz << 8u); }
fn tHash(k0: u32, k1: u32) -> u32 {
  var h = (k0 * 0x9e3779b1u) ^ (k1 * 0x85ebca6bu);
  h ^= h >> 15u;
  h *= 0x2c1b3c6du;
  h ^= h >> 13u;
  return h & (TCAP - 1u);
}
/** the table slot of a key, or NONE */
fn tFind(k0: u32, k1: u32) -> u32 {
  var s = tHash(k0, k1);
  for (var p = 0u; p < TCAP; p++) {
    let e1 = tabLoad(s * 4u + 1u);
    if (e1 == EMPTY) { return NONE; }
    if (e1 == k1 && tabLoad(s * 4u) == k0) { return s; }
    s = (s + 1u) & (TCAP - 1u);
  }
  return NONE;
}
/** a level's page over chunk (cx, cy) at overflow cz: the page, NOT_LOADED, or NONE */
fn pageOf(lid: u32, cx: i32, cy: i32, cz: u32) -> u32 {
  let s = tFind(tKey0(cx, cy), tKey1(lid, cz));
  if (s == NONE) { return NONE; }
  return tabLoad(s * 4u + 2u);
}
fn colIn(X: i32, Y: i32) -> u32 { return u32((Y & 15) * 16 + (X & 15)); }
/** whether a level id holds column pages (the partition) */
fn isColId(lid: u32) -> bool { return lid < 8u || (lid >= SNAP_ID && lid < SNAP_ID + 8u); }

// ---- column pages: the partition ------------------------------------------------------------------------------------
fn recTop(page: u32, c: u32, j: u32) -> f32 { return bitcast<f32>(pgLoad(page * PW + 256u + (c * KR + j) * 2u)); }
fn recMat(page: u32, c: u32, j: u32) -> u32 { return pgLoad(page * PW + 256u + (c * KR + j) * 2u + 1u); }
/** a column's record count (all materials, air included) */
fn recCount(lid: u32, X: i32, Y: i32) -> u32 {
  let c = colIn(X, Y);
  var n = 0u;
  var cz = 0u;
  loop {
    let p = pageOf(lid, X >> 4, Y >> 4, cz);
    if (p >= NOT_LOADED) { break; }
    let m = pgLoad(p * PW + c) & 0xffffu;
    n += m;
    if (m < KR) { break; }
    cz++;
  }
  return n;
}
/** record j of a column: (top, material as f32 bits) */
fn recAt(lid: u32, X: i32, Y: i32, j: u32) -> vec2<u32> {
  let p = pageOf(lid, X >> 4, Y >> 4, j / KR);
  if (p >= NOT_LOADED) { return vec2<u32>(bitcast<u32>(OPEN_BOTTOM), MAT_AIR); }
  let b = p * PW + 256u + (colIn(X, Y) * KR + j % KR) * 2u;
  return vec2<u32>(pgLoad(b), pgLoad(b + 1u));
}

// ---- solid pages ----------------------------------------------------------------------------------------------------
fn pgIvl(page: u32, c: u32, i: u32) -> Ivl {
  let b = page * PW + 256u + (c * K + i) * 3u;
  return Ivl(bitcast<f32>(pgLoad(b)), bitcast<f32>(pgLoad(b + 1u)), pgLoad(b + 2u));
}

/** the SOLID VIEW of a column: its non-air intervals in order (any level id). For column pages it is read from the
 *  partition: interval i is the i-th non-air record, z0 the top of the record below it (open for record 0), z1 its top.
 *  A page not loaded ends the run (its open interval extrapolated). */
fn colCount(lid: u32, X: i32, Y: i32) -> u32 {
  let c = colIn(X, Y);
  let col = isColId(lid);
  let per = select(K, KR, col);
  var n = 0u;
  var cz = 0u;
  loop {
    let p = pageOf(lid, X >> 4, Y >> 4, cz);
    if (p >= NOT_LOADED) { break; }
    let w = pgLoad(p * PW + c);
    let r = w & 0xffffu;
    n += select(r, w >> 16u, col);
    if (r < per) { break; }
    cz++;
  }
  return n;
}
fn ivlAt(lid: u32, X: i32, Y: i32, i: u32) -> Ivl {
  if (!isColId(lid)) {
    let p = pageOf(lid, X >> 4, Y >> 4, i / K);
    if (p >= NOT_LOADED) { return Ivl(OPEN_BOTTOM, OPEN_BOTTOM, 0u); }
    return pgIvl(p, colIn(X, Y), i % K);
  }
  let c = colIn(X, Y);
  var rem = i;
  var below = OPEN_BOTTOM;
  var cz = 0u;
  loop {
    let p = pageOf(lid, X >> 4, Y >> 4, cz);
    if (p >= NOT_LOADED) { break; }
    let w = pgLoad(p * PW + c);
    let r = w & 0xffffu;
    let s = w >> 16u;
    if (rem < s) {
      // (a page with no air record: interval rem is record rem)
      if (s == r) {
        var b = below;
        if (rem > 0u) { b = recTop(p, c, rem - 1u); }
        return Ivl(b, recTop(p, c, rem), recMat(p, c, rem));
      }
      for (var j = 0u; j < r; j++) {
        let t = recTop(p, c, j);
        let m = recMat(p, c, j);
        if (m != MAT_AIR) {
          if (rem == 0u) { return Ivl(below, t, m); }
          rem--;
        }
        below = t;
      }
      break;
    }
    rem -= s;
    if (r > 0u) { below = recTop(p, c, r - 1u); }
    if (r < KR) { break; }
    cz++;
  }
  return Ivl(OPEN_BOTTOM, OPEN_BOTTOM, 0u);
}
/** the top surface of a column of n intervals */
fn topS(lid: u32, X: i32, Y: i32, n: u32) -> f32 {
  if (n == 0u) { return 0.0; }
  return ivlAt(lid, X, Y, n - 1u).z1;
}
/** layer form: v = 2i - 1 the gap below interval i, v = 2i its thickness (i >= 1) */
fn layerVal(lid: u32, X: i32, Y: i32, v: u32) -> f32 {
  let i = (v + 1u) / 2u;
  let a = ivlAt(lid, X, Y, i);
  if ((v & 1u) == 0u) { return a.z1 - a.z0; }
  return a.z0 - ivlAt(lid, X, Y, i - 1u).z1;
}

// ---- the baked faces (docs/design/NESTED_SCALES.md "The box draw") --------------------------------------------------
// FACE pages (FACE_ID + depth, stacked by cz as needed): word 0 the triangles in this page, 1-2 the chunk (cx, cy); from
// FHDR, triangles of 4 words: w0 = column x | y << 4 (in the chunk) | face kind << 8 (0 +x, 1 -x, 2 +y, 3 -y, 4 +z,
// 5 -z) | material << 11 (8 bits) | each vertex's corner (bit 0: +1 in x, bit 1: +1 in y) << 19 + 2v; w1-w3 the three
// vertices' z (local units).
const FHDR: u32 = 4u;
const TPP: u32 = 3135u; // (PW - FHDR) / 4

// ---- hashing and detail (the oracle's hash3 / valueNoise / detail, src/nested/oracle.ts) -------------------------------
fn hash3(x: i32, y: i32, z: i32, seed: u32) -> f32 {
  var h = (bitcast<u32>(x) * 0x27d4eb2du) ^ (bitcast<u32>(y) * 0x165667b1u) ^ (bitcast<u32>(z) * 0x9e3779b1u) ^ (seed * 0x85ebca6bu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h ^= h >> 15u;
  return f32(h) / 2147483648.0 - 1.0;
}
fn smooth3(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }
fn valueNoise(x: f32, y: f32, layer: i32, seed: u32) -> f32 {
  let ix = floor(x);
  let iy = floor(y);
  let fx = smooth3(x - ix);
  let fy = smooth3(y - iy);
  let i = i32(ix);
  let j = i32(iy);
  let a = hash3(i, j, layer, seed);
  let b = hash3(i + 1, j, layer, seed);
  let c = hash3(i, j + 1, layer, seed);
  let d = hash3(i + 1, j + 1, layer, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** amp: per wavelength (the oracle's DETAIL_AMP by default; nest.ts detailAmp) */
fn detail(gx: i32, gy: i32, depth: i32, k: i32, seed: u32, amp: f32) -> f32 {
  var v = 0.0;
  var lam = 2;
  var o = 0;
  loop {
    if (lam * 2 > k) { break; }
    let l = f32(lam);
    v += amp * l * valueNoise((f32(gx) + 0.5) / l, (f32(gy) + 0.5) / l, depth * 16 + o, seed);
    lam *= 2;
    o++;
  }
  return v;
}
