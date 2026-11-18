// ---- nested/gpu/store.wgsl: the lab's paged column store, read side (docs/design/NESTED_SCALES.md "Storage") -------
// Prepended to the compute module (nest.wgsl) and the draw (draw.wgsl). The stage defines tabLoad(i) and pgLoad(i)
// (compute: atomic table; draw: read-only) and TCAP.
//
// Table entry (4 words): key0 = cx | cy << 16 (global chunk of the level's depth), key1 = level | cz << 8, page, birth
// (f32 bits: when the page was handed out, for the draw's fade). Level ids: 0-7 a live level of that depth, 8-15 the
// residual of depth (id - 8). Page: K intervals x 256 columns, four words each (z0, z1, material, footprints), after
// 256 counts.
//
// Footprints (docs/design/NESTED_SCALES.md "Footprints"): the fourth word holds two f16 signed distances in plan (column
// units, positive inside): eS to the edge of the interval's own footprint, eG to the edge of the gap below it. A
// negative one is a ghost: it keeps its place in the structure but is not solid (not air). present() is the one test.

const K: u32 = 16u;
/** words a record */
const RW: u32 = 4u;
const PW: u32 = 16640u; // 256 + 256 * 16 * 4
const NONE: u32 = 0xffffffffu;
const EMPTY: u32 = 0xffffffffu;
const NOT_LOADED: u32 = 0xfffffffeu;
const TOMB: u32 = 0xfffffffdu;
const BUSY: u32 = 0xfffffffcu;
const OPEN_BOTTOM: f32 = -1e30;
const RES_ID: u32 = 8u;
/** "present, far from any edge" (the oracle's E_FAR), both halves: f16 1024 = 0x6400 */
const E_FAR: f32 = 1024.0;
const E_FAR_W: u32 = 0x64006400u;

struct Ivl {
  z0: f32,
  z1: f32,
  m: u32,
  e: u32,
}
fn eS(iv: Ivl) -> f32 { return unpack2x16float(iv.e).x; }
fn eG(iv: Ivl) -> f32 { return unpack2x16float(iv.e).y; }
fn present(e: f32) -> bool { return e > 0.0; }
/** interval i is solid (interval 0 always is) */
fn solidIv(iv: Ivl, i: u32) -> bool { return i == 0u || present(eS(iv)); }
/** the two distances as stored (f16, no negative zero: a residual gives the stored bits back) */
fn packE(s: f32, g: f32) -> u32 { return pack2x16float(vec2<f32>(select(s, 0.0, s == 0.0), select(g, 0.0, g == 0.0))); }

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
fn pgIvl(page: u32, c: u32, i: u32) -> Ivl {
  let b = page * PW + 256u + (c * K + i) * RW;
  return Ivl(bitcast<f32>(pgLoad(b)), bitcast<f32>(pgLoad(b + 1u)), pgLoad(b + 2u), pgLoad(b + 3u));
}
/** a column's interval count over its stacked pages (0: no page; a page not loaded ends the run, its open interval
 *  extrapolated) */
fn colCount(lid: u32, X: i32, Y: i32) -> u32 {
  let c = colIn(X, Y);
  var n = 0u;
  var cz = 0u;
  loop {
    let p = pageOf(lid, X >> 4, Y >> 4, cz);
    if (p == NONE || p == NOT_LOADED) { break; }
    let m = pgLoad(p * PW + c);
    n += m;
    if (m < K) { break; }
    cz++;
  }
  return n;
}
fn ivlAt(lid: u32, X: i32, Y: i32, i: u32) -> Ivl {
  let p = pageOf(lid, X >> 4, Y >> 4, i / K);
  if (p == NONE || p == NOT_LOADED) { return Ivl(OPEN_BOTTOM, OPEN_BOTTOM, 0u, E_FAR_W); }
  return pgIvl(p, colIn(X, Y), i % K);
}
/** the top surface of a column of n intervals in layer form (the last interval's z1, ghost or not: enhance's S) */
fn topS(lid: u32, X: i32, Y: i32, n: u32) -> f32 {
  if (n == 0u) { return 0.0; }
  return ivlAt(lid, X, Y, n - 1u).z1;
}
/** the top PRESENT surface (the draw's top sheet, the camera's ground): the highest solid interval's z1 */
fn topPresent(lid: u32, X: i32, Y: i32, n: u32) -> f32 {
  if (n == 0u) { return 0.0; }
  var i = n - 1u;
  loop {
    let iv = ivlAt(lid, X, Y, i);
    if (i == 0u || present(eS(iv))) { return iv.z1; }
    i--;
  }
}
/** layer form: v = 2i - 1 the gap below interval i, v = 2i its thickness (i >= 1) */
fn layerVal(lid: u32, X: i32, Y: i32, v: u32) -> f32 {
  let i = (v + 1u) / 2u;
  let a = ivlAt(lid, X, Y, i);
  if ((v & 1u) == 0u) { return a.z1 - a.z0; }
  return a.z0 - ivlAt(lid, X, Y, i - 1u).z1;
}

// ---- the baked draw (docs/design/NESTED_SCALES.md "The baked draw") ---------------------------------------------------
// GAP pages (level id GAP_ID + depth): a chunk's per-column air regions (gaps), only for chunks where some column has
// more than one; elsewhere a column's one gap (the sky) is read from its intervals. A column's gap g is three records:
// (floor, ceiling, fm | cm << 8), (the bottom of the solid run under the floor, floor normal, ceiling normal; the
// normals' xy packed snorm16) and its links: the corresponding gap of the neighbour at +x, +y, +x+y (-1: none). MESH pages (MESH_ID + depth): the chunk's baked items (draw B), word 0 the item count
// of that page, items of ITEM_W words from MESH_HDR; only for chunks that have items.
const GAP_ID: u32 = 16u;
const GREC: u32 = 3u;
const MESH_ID: u32 = 24u;
const MESH_HDR: u32 = 4u;
const ITEM_W: u32 = 29u;
const IPP: u32 = 573u; // (PW - MESH_HDR) / ITEM_W
/** an air gap thinner than this (local units: a quarter column) is below the level's resolution (a finer level's tunnel
 *  restricted to its mean air) and is drawn as solid (NS-30) */
const GAP_MIN: f32 = 0.25;
struct Gap {
  f: f32, // floor
  c: f32, // ceiling (1e30: the sky)
  fm: u32,
  cm: u32,
  rb: f32, // the bottom of the solid run under the floor
  nF: vec2<f32>,
  nC: vec2<f32>,
  ok: bool,
}
fn recW(lid: u32, X: i32, Y: i32, i: u32, w: u32) -> u32 {
  let p = pageOf(lid, X >> 4, Y >> 4, i / K);
  if (p >= NOT_LOADED) { return 0u; }
  return pgLoad(p * PW + 256u + (colIn(X, Y) * K + (i % K)) * RW + w);
}
/** whether the column's chunk has gap pages */
fn hasGapPages(L: u32, X: i32, Y: i32) -> bool { return pageOf(GAP_ID + L, X >> 4, Y >> 4, 0u) < NOT_LOADED; }
/** a column's gap count (the baked table; a chunk without one: 1, or 0 for no column) */
fn gCount(L: u32, X: i32, Y: i32) -> u32 {
  if (hasGapPages(L, X, Y)) { return colCount(GAP_ID + L, X, Y) / GREC; }
  return select(0u, 1u, colCount(L, X, Y) > 0u);
}
/** a column's gap g from the baked table (only for columns of chunks with gap pages) */
fn gRec(L: u32, X: i32, Y: i32, g: u32) -> Gap {
  let lid = GAP_ID + L;
  let r = GREC * g;
  let m = recW(lid, X, Y, r, 2u);
  return Gap(bitcast<f32>(recW(lid, X, Y, r, 0u)), bitcast<f32>(recW(lid, X, Y, r, 1u)), m & 0xffu, (m >> 8u) & 0xffu, bitcast<f32>(recW(lid, X, Y, r + 1u, 0u)), unpack2x16snorm(recW(lid, X, Y, r + 1u, 1u)), unpack2x16snorm(recW(lid, X, Y, r + 1u, 2u)), true);
}
/** the baked link of gap g to the corresponding gap of the neighbour in direction d (+x, +y, +x+y, -x, -y, -x-y: 16
 *  bits each, two a word); -1: none */
fn gLink(L: u32, X: i32, Y: i32, g: u32, d: u32) -> i32 {
  let v = (recW(GAP_ID + L, X, Y, GREC * g + 2u, d / 2u) >> (16u * (d % 2u))) & 0xffffu;
  return select(i32(v), -1, v == 0xffffu);
}

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
