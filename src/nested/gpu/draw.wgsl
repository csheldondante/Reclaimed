// ---- nested/gpu/draw.wgsl: a level's boxes, from the faces baked when its columns changed (store.wgsl prepended) ----
// One instanced draw a level over its face pages (nest.wgsl faceBake, dirBuild): an instance a page, three vertices a
// triangle slot; slots past the page's count are dropped. The vertex stage only places the baked corners: nothing here
// reads a column or matches anything, and a frame with no change draws what was baked. Flat face normals, colour by
// material, a triplanar pattern in world units. Finest level first, composed by depth (reverse Z, each level's
// view-projection in its own units). A parent bakes no faces under its child's footprint and walls it in, so the levels
// meet on whole parent cells with no morph.

struct DrawU {
  lvl: vec4<i32>, // gx0, gy0, n, depth
  misc: vec4<f32>, // diagnostics mode, -, tint on, k
  want: vec4<f32>, // (metrics) where the focus wants this level's child, local units
  sun: vec4<f32>,
  misc2: vec4<u32>, // x: the pool's pages (the directory's stride), w: (capture) face pages of this level
  // the grid's model matrix (a root grid's rigid frame; one grid with the identity today): level-local -> the frame the
  // camera's per-level view-projection expects
  model: mat4x4<f32>,
  // (round 11, NS-97) the live child's window (gx0, gy0, n, live): the parent's vertices on its rim lines are placed in
  // the child's units through the child's view-projection
  kid: vec4<i32>,
  // (round 25) x metres a world unit (a root column), y the fog's distance in metres (0: round 21's haze, the toy root),
  // z the textured shading's scale: its bands and materials in world units / 2^z (5 at 128 m: 4 m, near the 3.2 m root
  // column their constants were tuned at); (round 27) w: ?tex=2's fine tile, log2 tiles a world unit (6: 2 m tiles)
  geo: vec4<f32>,
}

@group(0) @binding(0) var<uniform> d: DrawU;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(3) var<storage, read> cam: array<f32>;
@group(0) @binding(4) var<storage, read> reg: array<i32>;
@group(0) @binding(5) var<storage, read> dir: array<u32>;
// (the pages: segments from binding 10 on, with pgLoad, declared by render.ts from nest.ts segWgsl)

fn tabLoad(i: u32) -> u32 { return tab[i]; }

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  @location(2) @interpolate(flat) col: vec3<f32>,
  @location(3) wp: vec3<f32>, // world position (the pattern's coordinates, the same on every level)
  @location(4) lz: f32, // the local height (the watertight capture; 3e38: a vertex not drawn)
  @location(5) dEye: f32, // (metrics) the distance to the eye, local units
  // (round 20, the textured draw only; the flat fs ignores them) the point in this level's units (a rim vertex brought
  // back from the child's), toward the eye in this level's units, this level's z origin in world units
  @location(6) q: vec3<f32>,
  @location(7) toEye: vec3<f32>,
  @location(8) @interpolate(flat) zo: f32,
  @location(9) @interpolate(flat) mat: u32,
}

/** a level's z origin in world units (reg words 1..L: each level's origin in its parent's units) */
fn zOrigW(L: u32) -> f32 {
  var z = 0.0;
  for (var j = 1u; j <= L; j++) { z += bitcast<f32>(reg[j]) / pow(d.misc.w, f32(j - 1u)); }
  return z;
}
/** a level's local point in world units */
fn worldOf(L: u32, lp: vec3<f32>) -> vec3<f32> {
  return worldAt(L, d.lvl.xy, lp);
}
/** a local point of level L whose window starts at global column o, in world units */
fn worldAt(L: u32, o: vec2<i32>, lp: vec3<f32>) -> vec3<f32> {
  let s = pow(d.misc.w, f32(L));
  return vec3<f32>((f32(o.x) + lp.x) / s, (f32(o.y) + lp.y) / s, zOrigW(L) + lp.z / s);
}
fn vpOf(L: u32) -> mat4x4<f32> {
  let b = 32u + L * 24u;
  return mat4x4<f32>(
    vec4<f32>(cam[b], cam[b + 1u], cam[b + 2u], cam[b + 3u]),
    vec4<f32>(cam[b + 4u], cam[b + 5u], cam[b + 6u], cam[b + 7u]),
    vec4<f32>(cam[b + 8u], cam[b + 9u], cam[b + 10u], cam[b + 11u]),
    vec4<f32>(cam[b + 12u], cam[b + 13u], cam[b + 14u], cam[b + 15u]));
}

/** a material's colour (round 25: the material alone; soil was green where the normal was up: the owner, "terrain layers
 *  should not have multiple materials by normal") */
fn matColor(m: u32) -> vec3<f32> {
  // (round 27: the material id alone, a generated interval's role bits off: store.wgsl matId)
  switch (matId(m)) {
    case 1u: { return vec3<f32>(0.47, 0.45, 0.43); }
    case 2u: { return vec3<f32>(0.45, 0.36, 0.24); }
    case 3u: { return vec3<f32>(0.80, 0.70, 0.48); }
    case 4u: { return vec3<f32>(0.62, 0.38, 0.30); }
    case 5u: { return vec3<f32>(0.30, 0.42, 0.18); }
    default: { return vec3<f32>(1.0, 0.0, 1.0); }
  }
}
/** (round 25) the fog's share at a distance of dEye in level L's units: full at about d.geo.y metres (1 - e^-4 there,
 *  a quarter of it at half the distance); 0 with no fog distance (the toy root: round 21's haze in the textured draw) */
fn fogAt(L: u32, dEye: f32) -> f32 {
  if (d.geo.y <= 0.0) { return 0.0; }
  let m = dEye / pow(d.misc.w, f32(L)) * d.geo.x / d.geo.y;
  return 1.0 - exp(-4.0 * m * m);
}
/** the flat draws' fog colour (the clear colour) */
const FOG_FLAT = vec3<f32>(0.62, 0.71, 0.78);
const NRM = array<vec3<f32>, 6>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, -1.0));

/** triangle slot `tri` of face page `slot` of the level's list: its vertex v (local units), or none */
struct Corner {
  ok: bool,
  lp: vec3<f32>,
  kind: u32,
  mat: u32,
  /** (round 11, NS-97) a vertex on a rim line of the child: lp.z is in the child's units (nest.wgsl toKid) */
  kid: bool,
}
fn corner(inst: u32, tri: u32, v: u32) -> Corner {
  var c = Corner(false, vec3<f32>(0.0), 0u, 0u, false);
  let w = d.lvl;
  let L = u32(w.w);
  let e = 16u + (L * d.misc2.x + inst) * 2u;
  let page = dir[e];
  let key = dir[e + 1u];
  if (tri >= pgLoad(page * PW)) { return c; }
  let b = page * PW + FHDR + tri * 4u;
  let w0 = pgLoad(b);
  c.ok = true;
  c.kind = (w0 >> 8u) & 7u;
  c.mat = (w0 >> 11u) & 255u;
  if (c.kind == 6u) {
    // (round 9, NS-83) a down-cap fan: one z (word 1), the three points as chunk x | y << 5 (word 2: v0, v1 << 10;
    // word 3: v2)
    let w2 = pgLoad(b + 2u);
    var q = w2 & 1023u;
    if (v == 1u) { q = (w2 >> 10u) & 1023u; } else if (v == 2u) { q = pgLoad(b + 3u) & 1023u; }
    let X = i32(key & 0xffffu) * 16 + i32(q & 31u);
    let Y = i32(key >> 16u) * 16 + i32(q >> 5u);
    c.lp = vec3<f32>(f32(X - w.x), f32(Y - w.y), bitcast<f32>(pgLoad(b + 1u)));
    c.kind = 5u;
    return c;
  }
  let cc = (w0 >> (19u + 2u * v)) & 3u;
  let X = i32(key & 0xffffu) * 16 + i32(w0 & 15u) + i32(cc & 1u);
  let Y = i32(key >> 16u) * 16 + i32((w0 >> 4u) & 15u) + i32(cc >> 1u);
  c.lp = vec3<f32>(f32(X - w.x), f32(Y - w.y), bitcast<f32>(pgLoad(b + 1u + v)));
  c.kid = ((w0 >> (25u + v)) & 1u) == 1u;
  return c;
}

/** where a corner goes on screen. A parent's vertex on a rim line is placed as the child places its own vertex there:
 *  child-local x, y (whole columns), the stored child-units z, the child's view-projection, by the same expression; then
 *  scaled by 1 / k (exact: a power of two), which leaves its point on screen bit for bit (clip / w) and makes its w the
 *  parent's, so the triangle's interpolation is not warped. */
struct Placed {
  pos: vec4<f32>,
  L: u32,
  lp: vec3<f32>,
}
fn placeCorner(c: Corner) -> Placed {
  var L = u32(d.lvl.w);
  var p = c.lp;
  var sc = 1.0;
  if (c.kid) {
    let k = i32(d.misc.w);
    p = vec3<f32>(f32((i32(c.lp.x) + d.lvl.x) * k - d.kid.x), f32((i32(c.lp.y) + d.lvl.y) * k - d.kid.y), c.lp.z);
    L = L + 1u;
    // (1 / k from the CPU: exact for k a power of two; a GPU's division need not be)
    sc = d.want.w;
  }
  return Placed(vpOf(L) * (d.model * vec4<f32>(p, 1.0)) * sc, L, p);
}

@vertex
fn vs(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  o.lz = 3e38;
  let c = corner(inst, vv / 3u, vv % 3u);
  if (!c.ok) { return o; }
  let n = NRM[c.kind];
  let pc = placeCorner(c);
  let L = pc.L;
  o.pos = pc.pos;
  o.local = c.lp.xy;
  o.nrm = n;
  o.col = matColor(c.mat);
  // (diagnostics, Renderer.diag) 1: the triangle slot's parity, 2: the face kind
  if (d.misc.x == 1.0) { o.col = select(vec3<f32>(1.0, 0.2, 0.2), vec3<f32>(0.2, 0.4, 1.0), ((vv / 3u) & 1u) == 1u); }
  if (d.misc.x == 2.0) { o.col = abs(n) * 0.8 + select(vec3<f32>(0.0), vec3<f32>(0.2), n.x + n.y + n.z < 0.0); }
  o.lz = c.lp.z;
  let eb = 32u + L * 24u;
  // (a rim vertex's world point and its distance from the child's frame; the distance back in this level's units)
  var sk = 1.0;
  var wo = vec2<i32>(d.lvl.xy);
  if (c.kid) {
    sk = d.want.w;
    wo = d.kid.xy;
  }
  o.wp = worldAt(L, wo, pc.lp);
  let eye = vec3<f32>(cam[eb + 16u], cam[eb + 17u], cam[eb + 18u]);
  o.dEye = length(pc.lp - eye) * sk;
  o.toEye = (eye - pc.lp) * sk;
  o.q = c.lp;
  if (c.kid) { o.q = vec3<f32>(c.lp.x, c.lp.y, bitcast<f32>(reg[u32(d.lvl.w) + 1u]) + c.lp.z * d.want.w); }
  o.zo = zOrigW(u32(d.lvl.w));
  o.mat = c.mat;
  return o;
}

// ---- the smooth draw's vertex output (round 14; round 18 deleted the template, wall and exception draws: git keeps them)
/** (step C) a vertex normal from its word (nest.wgsl octEnc) */
fn octDec(w: u32) -> vec3<f32> {
  let p = unpack2x16snorm(w);
  var n = vec3<f32>(p, 1.0 - abs(p.x) - abs(p.y));
  if (n.z < 0.0) { n = vec3<f32>((1.0 - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0)), n.z); }
  return normalize(n);
}
struct VOutS {
  @builtin(position) pos: vec4<f32>,
  /** the level's local units (the face normal by derivatives) */
  @location(0) q: vec3<f32>,
  @location(1) @interpolate(flat) mat: u32,
  @location(2) wp: vec3<f32>,
  @location(3) dEye: f32,
  /** toward the eye, local units (which side of a face is out) */
  @location(4) toEye: vec3<f32>,
  /** (step C) the interpolated vertex normal (the template's; zero for the exceptions: flat) */
  @location(5) vn: vec3<f32>,
  /** (round 20, the textured draw) this level's z origin, world units */
  @location(6) @interpolate(flat) zo: f32,
}
/** a vertex of the smooth draw from its level-local point (rim: a parent's vertex on a child's rim line, placed as the
 *  boxes place it) */
fn smoothOut(lp: vec3<f32>, kid: bool, mat: u32) -> VOutS {
  var o: VOutS;
  let pc = placeCorner(Corner(true, lp, 0u, mat, kid));
  o.pos = pc.pos;
  o.mat = mat;
  let eb = 32u + pc.L * 24u;
  var sk = 1.0;
  var wo = vec2<i32>(d.lvl.xy);
  // (q in this level's units: a rim vertex brought back from the child's)
  var q = lp;
  if (kid) {
    sk = d.want.w;
    wo = d.kid.xy;
    q = vec3<f32>(lp.x, lp.y, bitcast<f32>(reg[u32(d.lvl.w) + 1u]) + lp.z * d.want.w);
  }
  o.q = q;
  o.wp = worldAt(pc.L, wo, pc.lp);
  let eye = vec3<f32>(cam[eb + 16u], cam[eb + 17u], cam[eb + 18u]);
  o.dEye = length(pc.lp - eye) * sk;
  o.toEye = (eye - pc.lp) * sk;
  o.vn = vec3<f32>(0.0);
  o.zo = zOrigW(u32(d.lvl.w));
  return o;
}
/** the sheet list (nest.wgsl sheetDir): 8 counts from 16 + 16 x cap, then per level EX_PB x cap entries of 2 words */
const EX_PB: u32 = 48u;
// ---- (round 16) the sheet draw (nest.wgsl sheetBake; boxmesh.ts sheetMesh): an instance a sheet of a chunk, 2 triangles
// a column (its surface of that sheet on its four corners' clusters) and 32 zipper triangles (a child's window edge: the
// parent column's surface of that sheet closed against the child's lines between the parent's corners). Reads only the
// cache: the sheet words and the clusters (position z, normal). A slot the bake left off is degenerate (no pixels).
const SLN: u32 = 8u;
const SCL: u32 = 372u;
const SCL0: u32 = 3043u;
const CPP: u32 = 3136u;
const SPW: u32 = 800u;
const SZIP: u32 = 768u;
const CACHE_LID: u32 = 48u;
struct SV {
  ok: bool,
  lp: vec3<f32>,
  kid: bool,
  mat: u32,
  nrm: u32,
}
/** cluster i of the chunk whose cache page 0 is p0 (spill pages through the table) */
fn sclD(p0: u32, key: u32, i: u32) -> u32 {
  if (i < SCL0) { return p0 * PW + SCL + i * 4u; }
  let p = pageOf(CACHE_LID + u32(d.lvl.w), i32(key & 0xffffu), i32(key >> 16u), 1u + (i - SCL0) / CPP);
  return p * PW + ((i - SCL0) % CPP) * 4u;
}
fn sLineD(p0: u32, lx: u32, ly: u32) -> u32 { return pgLoad(p0 * PW + SLN + (ly + 1u) * 19u + lx + 1u); }
/** whether global corner line (CX, CY) of the drawn level lies on its live child's footprint boundary (nest.wgsl rimP) */
fn rimD(CX: i32, CY: i32) -> bool {
  if (d.kid.w == 0) { return false; }
  let k = i32(d.misc.w);
  let x = CX * k;
  let y = CY * k;
  let c = d.kid;
  if (x < c.x || y < c.y || x > c.x + c.z || y > c.y + c.z) { return false; }
  return x == c.x || y == c.y || x == c.x + c.z || y == c.y + c.z;
}
fn sheetVert(inst: u32, t: u32, v0: u32) -> SV {
  var o = SV(false, vec3<f32>(0.0), false, 0u, 0u);
  let cap = d.misc2.x;
  let L = u32(d.lvl.w);
  let e = 16u + 16u * cap + 8u + L * EX_PB * cap + inst * 2u;
  let w0 = dir[e];
  let p0 = dir[e + 1u];
  let sb = (w0 & 0xffffffu) * PW + (w0 >> 24u) * SPW;
  let key = pgLoad(p0 * PW + 5u);
  let cx = i32(key & 0xffffu);
  let cy = i32(key >> 16u);
  var v = v0;
  var lx = 0u;
  var ly = 0u;
  var idx = 0u;
  var byZ = false;
  var zz = 0.0;
  // (round 23) the column's sheet flags (0 for a zipper triangle)
  var qn = 0u;
  if (t < 512u) {
    let col = t / 2u;
    let tt = t % 2u;
    let f = pgLoad(sb + col * 3u + 2u);
    if ((f >> 31u) == 0u || ((f >> (1u + tt)) & 1u) == 0u) { return o; }
    if ((f & 1u) == 0u && v != 0u) { v = 3u - v; }
    // triangle 0: corners (0, 1, 3), 1: (0, 3, 2); (round 23, flag bit 3, ?rimsnap=1) the other diagonal: (0, 1, 2),
    // (1, 3, 2)
    var cc = 0u;
    if ((f & 8u) != 0u) {
      if (v == 0u) { cc = select(1u, 0u, tt == 0u); } else if (v == 1u) { cc = select(3u, 1u, tt == 0u); } else { cc = 2u; }
    } else if (v == 1u) { cc = select(3u, 1u, tt == 0u); } else if (v == 2u) { cc = select(2u, 3u, tt == 0u); }
    qn = f;
    lx = (col & 15u) + (cc & 1u);
    ly = (col >> 4u) + (cc >> 1u);
    idx = (pgLoad(sb + col * 3u + cc / 2u) >> (16u * (cc & 1u))) & 0xffffu;
    o.mat = (f >> 8u) & 255u;
  } else {
    let zt = t - 512u;
    let side = zt / 16u;
    let ts = zt % 16u;
    let k = u32(d.misc.w);
    let seg = ts / (k - 1u);
    let i = ts % (k - 1u) + 1u;
    if (seg >= 16u / k || seg >= 8u) { return o; }
    let zw = sb + SZIP + (side * 8u + seg) * 2u;
    let f = pgLoad(zw + 1u);
    if ((f >> 31u) == 0u || ((f >> (15u + i)) & 1u) == 0u) { return o; }
    if ((f & 1u) == 0u && v != 0u) { v = 3u - v; }
    let ki = i32(k);
    let s0 = i32(seg) * ki;
    var l0 = vec2<i32>(0);
    var dd = vec2<i32>(0);
    let gx = d.lvl.x;
    let gy = d.lvl.y;
    let n = d.lvl.z;
    if (side == 0u) {
      if (cx * 16 == gx) {
        l0 = vec2<i32>(0, s0);
        dd = vec2<i32>(0, 1);
      } else if (cx * 16 + 16 == gx + n) {
        l0 = vec2<i32>(16, s0 + ki);
        dd = vec2<i32>(0, -1);
      } else { return o; }
    } else {
      if (cy * 16 == gy) {
        l0 = vec2<i32>(s0 + ki, 0);
        dd = vec2<i32>(-1, 0);
      } else if (cy * 16 + 16 == gy + n) {
        l0 = vec2<i32>(s0, 16);
        dd = vec2<i32>(1, 0);
      } else { return o; }
    }
    var st = 0;
    if (v == 1u) { st = i32(i); } else if (v == 2u) { st = i32(i) + 1; }
    let pl = l0 + dd * st;
    lx = u32(pl.x);
    ly = u32(pl.y);
    byZ = true;
    zz = bitcast<f32>(pgLoad(zw));
    o.mat = (f >> 8u) & 255u;
  }
  let lw = sLineD(p0, lx, ly);
  let first = lw & 0xfffffu;
  if (byZ) {
    var lo = 0u;
    var hi = lw >> 20u;
    loop {
      if (lo >= hi) { break; }
      let mid = (lo + hi) / 2u;
      if (bitcast<f32>(pgLoad(sclD(p0, key, first + mid))) <= zz) { lo = mid + 1u; } else { hi = mid; }
    }
    idx = max(lo, 1u) - 1u;
  }
  let cw = sclD(p0, key, first + idx);
  let CX = cx * 16 + i32(lx);
  let CY = cy * 16 + i32(ly);
  o.kid = !byZ && rimD(CX, CY);
  // (round 22) the slide (the cluster's word 1 after the bake; a rim vertex's word 1 is its top: not a slide), on with
  // misc2.y (?slide=1, the "Round edges" button); 0 leaves the draw exactly as before
  var off = vec2<f32>(0.0);
  var sl = 0u;
  if (d.misc2.y != 0u && !o.kid) {
    sl = pgLoad(cw + 1u);
    off = unpack2x16snorm(sl) * 0.5;
  }
  o.lp = vec3<f32>(f32(CX - d.lvl.x) + off.x, f32(CY - d.lvl.y) + off.y, bitcast<f32>(pgLoad(cw + 2u)));
  o.nrm = pgLoad(cw + 3u);
  // (round 23, ?rimsnap=1) a slid vertex takes its quad's own normal (sheet flags bit 4, bits 16-30: octahedral 8 + 7
  // bits), so each side of the rim shades with its own surface: a hard crease there by construction
  if (sl != 0u && (qn & 16u) != 0u) { o.nrm = (((qn >> 16u) & 255u) << 8u) | (((qn >> 24u) & 127u) << 25u); }
  o.ok = true;
  return o;
}
@vertex
fn vsSheet(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOutS {
  let s = sheetVert(inst, vv / 3u, vv % 3u);
  if (!s.ok) {
    var o: VOutS;
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  var o = smoothOut(s.lp, s.kid, s.mat);
  if (s.nrm != 0u) { o.vn = octDec(s.nrm); }
  return o;
}
/** (test only) the sheets as vsSheet places them: misc2.w instances x 544 slots, three vec4 a slot (w 1, a rim vertex 2,
 *  0 none) */
@compute @workgroup_size(64)
fn captureSheet(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 64u;
  if (i / 544u >= d.misc2.w) { return; }
  var ok = true;
  var s: array<SV, 3>;
  for (var v = 0u; v < 3u; v++) {
    s[v] = sheetVert(i / 544u, i % 544u, v);
    ok = ok && s[v].ok;
  }
  for (var v = 0u; v < 3u; v++) { capOut[i * 3u + v] = vec4<f32>(s[v].lp, select(0.0, select(1.0, 2.0, s[v].kid), ok)); }
}
@fragment
fn fsS(v: VOutS) -> FOut {
  // (derivatives first, in uniform control flow) the face's normal from the local position's screen derivatives, turned
  // toward the eye (every visible face of a closed solid faces it)
  let px = length(fwidth(v.wp));
  let cr = cross(dpdx(v.q), dpdy(v.q));
  let cl = length(cr);
  var n = select(vec3<f32>(0.0, 0.0, 1.0), cr / cl, cl > 0.0);
  if (dot(n, v.toEye) < 0.0) { n = -n; }
  // (step C) the template's interpolated vertex normal where it is within the crease angle of the face's (d.sun.w: its
  // cosine; ?crease=); flat beyond it, so cliffs and kept walls stay sharp; the exceptions carry none (flat)
  let vl = length(v.vn);
  if (vl > 1e-3) {
    let nv = v.vn / vl;
    if (dot(nv, n) >= d.sun.w) { n = nv; }
  }
  let pat = pattern(v.wp, n, px);
  let sun = normalize(d.sun.xyz);
  // (round 17, NS-123 (b)) a sky / ground ambient instead of the flat 0.35 less 0.12 for a face turned down: walls away
  // from the sun read at 0.47 of full light (was 0.35), undersides 0.40 (was 0.23; nearly black on stone)
  let lit = mix(0.40, 0.52, 0.5 + 0.5 * n.z) + 0.55 * max(dot(n, sun), 0.0);
  var col = matColor(v.mat) * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  col = mix(col, FOG_FLAT, fogAt(u32(d.lvl.w), v.dEye));
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  let coarse = d.want.x > 0.0 && v.dEye < d.want.x;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse), 1.0);
  return o;
}

// ---- the watertight check's capture (test only): every triangle the draw would place, in local units ---------------
// three vec4 a triangle slot: x, y, z local, w 1 when drawn (0 for an empty slot)
@group(1) @binding(0) var<storage, read_write> capOut: array<vec4<f32>>;
@compute @workgroup_size(64)
fn capture(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  // (two dimensions: a level's slots can need more than 65,535 workgroups)
  let i = gid.x + gid.y * nw.x * 64u;
  let inst = i / TPP;
  if (inst >= d.misc2.w) { return; }
  for (var v = 0u; v < 3u; v++) {
    let c = corner(inst, i % TPP, v);
    // (w 2: a rim vertex, z in the child's units; round 11)
    capOut[i * 3u + v] = vec4<f32>(c.lp, select(0.0, select(1.0, 2.0, c.kid), c.ok));
  }
}

const TINTS = array<vec3<f32>, 6>(vec3<f32>(0.35, 0.55, 1.0), vec3<f32>(1.0, 0.35, 0.3), vec3<f32>(1.0, 0.9, 0.25), vec3<f32>(0.35, 1.0, 0.45), vec3<f32>(0.9, 0.4, 1.0), vec3<f32>(0.3, 1.0, 1.0));

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) info: vec4<f32>,
}

fn hash2(p: vec2<f32>) -> f32 {
  let q = vec2<u32>(vec2<i32>(floor(p)));
  var h = (q.x * 0x9e3779b1u) ^ (q.y * 0x85ebca6bu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = h ^ (h >> 13u);
  return f32(h & 0xffffu) / 65535.0;
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
/** a triplanar pattern in world units (the same on every level, so the rim shows no change of pattern): value noise
 *  on the three axis planes blended by the normal, octaves from a root column down, each faded out before it is finer
 *  than a pixel */
fn pattern(p: vec3<f32>, n: vec3<f32>, px: f32) -> f32 {
  var bw = pow(abs(n), vec3<f32>(4.0));
  bw /= bw.x + bw.y + bw.z;
  let top = clamp(floor(log2(0.4 / max(px, 1e-9)) * 0.5), 0.0, 9.0);
  let o0 = max(0.0, top - 2.0);
  var acc = 0.0;
  var norm = 0.0;
  for (var o = o0; o <= top; o += 1.0) {
    let f = pow(4.0, o);
    let vis = 1.0 - smoothstep(0.15, 0.4, px * f);
    let q = p * f + o * 17.0;
    acc += vis * (bw.x * vnoise(q.yz) + bw.y * vnoise(q.xz) + bw.z * vnoise(q.xy));
    norm += vis;
  }
  return select(0.5, acc / norm, norm > 1e-4);
}
@fragment
fn fs(v: VOut) -> FOut {
  // (fwidth before anything that could branch)
  let px = length(fwidth(v.wp));
  return flatOut(v, px);
}
/** the box draw's flat shading (round 6-19; the textured draw's diagnostics modes use it too) */
fn flatOut(v: VOut, px: f32) -> FOut {
  let n = normalize(v.nrm);
  let pat = pattern(v.wp, n, px);
  let sun = normalize(d.sun.xyz);
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = v.col * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  col = mix(col, FOG_FLAT, fogAt(u32(d.lvl.w), v.dEye));
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  // info: r a surface was drawn, g the level, b not yet sharp: a parent where its child is wanted, i.e. nearer the eye
  // than the zoom band's promote distance for the child (want.x, this level's units; 0: no child level allowed). The
  // same rule as the band, so it does not depend on where the streaming policy put the child's window (round 7).
  // (the distance comes from the vertex stage: reading the camera words here doubled the draw's time)
  let coarse = d.want.x > 0.0 && v.dEye < d.want.x;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse), 1.0);
  return o;
}

// ---- (round 27) the material at a column's surface (both draws), and the border mix of ?tex=2 -------------------------
/** the material of column (lv, X, Y) at height z (round 26's fielddraw fdMatOf, shared): within half a column of one of
 *  the column's surfaces (an inside / outside boundary) the inside record at that surface, so a thin top layer reads as
 *  itself wherever a mesh puts the pixel; deeper in, the record holding z (strata on a wall); MAT_AIR when the column has
 *  nothing inside. x the material word, y the distance to the nearest surface (f32 bits, local units). sel: which
 *  records are inside (0 solid; anything else none yet: water later) */
fn surfMatD(lv: u32, X: i32, Y: i32, z: f32, sel: u32) -> vec2<u32> {
  let n = recCount(lv, X, Y);
  var bm = MAT_AIR;
  var bd = 1e30;
  var held = MAT_AIR;
  var pIn = false;
  var pMat = MAT_AIR;
  var below = -1e30;
  for (var j = 0u; j < n; j++) {
    let r = recAt(lv, X, Y, j);
    let t = bitcast<f32>(r.x);
    let inside = sel == 0u && matSolid(r.y);
    // (a surface at `below`, between record j - 1 and j: its inside side's material)
    if (j > 0u && inside != pIn) {
      let dd = abs(z - below);
      if (dd < bd) {
        bd = dd;
        bm = select(pMat, r.y & 0xffu, inside);
      }
    }
    if (inside && z >= below && z < t) { held = r.y & 0xffu; }
    pIn = inside;
    pMat = r.y & 0xffu;
    below = t;
  }
  // (the last record's top, with air above it)
  if (pIn && abs(z - below) < bd) {
    bd = abs(z - below);
    bm = pMat;
  }
  if (bd <= 0.5 || held == MAT_AIR) { return vec2<u32>(bm, bitcast<u32>(bd)); }
  return vec2<u32>(held, bitcast<u32>(bd));
}
/** (?tex=2) the pixel's material and, at a border, the neighbouring one: P the pixel's point in the drawn level's window
 *  (column units), z its height, own the material the draw gives it (the sheet's column, the field's lookup). The four
 *  column centres round P carry bilinear weights; the three other than P's own column are looked up at z (surfMatD:
 *  a neighbour whose surface is more than a column from z, outside the window, or empty counts as own). b is the other
 *  material of most weight, wb its share of a's and b's. Never the normal or the slope. */
fn matMix(L: u32, P: vec2<f32>, z: f32, own: u32) -> MatMix {
  let fl = floor(P);
  let f = P - fl - vec2<f32>(0.5);
  let sx = select(-1, 1, f.x >= 0.0);
  let sy = select(-1, 1, f.y >= 0.0);
  let t = abs(f);
  let a = matId(own);
  let C = vec2<i32>(fl);
  let nn = d.lvl.z;
  var ms = array<u32, 3>(a, a, a);
  var ws = array<f32, 3>(t.x * (1.0 - t.y), (1.0 - t.x) * t.y, t.x * t.y);
  for (var i = 0; i < 3; i++) {
    let o = select(select(vec2<i32>(sx, sy), vec2<i32>(0, sy), i == 1), vec2<i32>(sx, 0), i == 0);
    let r = C + o;
    if (r.x < 0 || r.y < 0 || r.x >= nn || r.y >= nn || ws[i] <= 0.0) { continue; }
    let m = surfMatD(L, d.lvl.x + r.x, d.lvl.y + r.y, z, 0u);
    if (m.x != MAT_AIR && bitcast<f32>(m.y) <= 1.0) { ms[i] = matId(m.x); }
  }
  var wa = (1.0 - t.x) * (1.0 - t.y);
  var b = a;
  var wb = 0.0;
  for (var i = 0; i < 3; i++) {
    if (ms[i] == a) {
      wa += ws[i];
      continue;
    }
    var w = 0.0;
    for (var j = 0; j < 3; j++) { w += select(0.0, ws[j], ms[j] == ms[i]); }
    if (w > wb) {
      wb = w;
      b = ms[i];
    }
  }
  return MatMix(a, b, wb / max(wa + wb, 1e-6));
}

// ---- (round 20) the textured draw: shade.wgsl's materials and light behind the "Textured" toggle (?tex=1, default) ----
// Separate entry points and pipelines (made after the first frame; the flat draw meanwhile), so the flat path above
// stays exactly as it was. Both draws call one function, texOut.
/** a level's s: log2 of its columns a world unit (k a power of two: BACKLOG NS-146) */
fn levelS() -> i32 { return i32(d.lvl.w) * i32(round(log2(d.misc.w))); }

// ---- (round 31, look experiment, ?cliffcut=1) the skyline notched to the fake blocks: on steep pixels near a wall's top,
// the pixel is dropped when it lies above a hashed stack top: the top of the column behind the wall (3/4 of a column back
// from the point against the wall's plan normal) brought down to the unit (half a block) below it, in every other block
// column by an integer hash. So a notch is at most one unit deep and one block column wide. Discarding only removes
// pixels: seen from above there is no notch floor (a see-through hole into the terrain), so the cut fades out as the view
// looks down (the stack top raised by up to a unit from 0.2 to 0.5 of the view's downward component). Compiled in only
// when the pipelines are made with the override (?cliffcut=1 at load: render.ts); the cut itself is a run-time bit.
override CLIFF_CUT: bool = false;
/** the top of column (L, X, Y): the top of its highest solid record (local units); very low when none */
fn cliffColTop(L: u32, X: i32, Y: i32) -> f32 {
  let n = recCount(L, X, Y);
  var t = -1e30;
  for (var j = 0u; j < n; j++) {
    let r = recAt(L, X, Y, j);
    if (matSolid(r.y)) { t = bitcast<f32>(r.x); }
  }
  return t;
}
fn cliffCutAt(si: ShadeIn, q: vec3<f32>, ng: vec3<f32>) -> bool {
  if (shSteep(ng, si.cliff) < 0.5) { return false; }
  let hl = length(ng.xy);
  if (hl < 1e-3) { return false; }
  let e = si.cliffE;
  let C = vec2<i32>(floor(q.xy - ng.xy / hl * 0.75));
  let nn = d.lvl.z;
  if (C.x < 0 || C.y < 0 || C.x >= nn || C.y >= nn) { return false; }
  let X = d.lvl.x + C.x;
  let Y = d.lvl.y + C.y;
  let me = max(e, 0);
  if ((shH3(X >> u32(me), Y >> u32(me), 4243) & 1u) == 0u) { return false; }
  let u = ldexp(0.5, e);
  let H = cliffColTop(u32(d.lvl.w), X, Y);
  let top = (ceil(H / u) - 1.0) * u + 1.05 * u * smoothstep(0.2, 0.5, -si.view.z);
  return q.z > top;
}
fn texOut(q: vec3<f32>, zo: f32, ng: vec3<f32>, mat: u32, pxL: f32, toEye: vec3<f32>, dEye: f32) -> FOut {
  // (round 25) in shading units of a world unit / 2^geo.z: s less it, the z origin times it (exact: powers of two)
  let gz = i32(d.geo.z);
  let s = levelS() - gz;
  let sc = ldexp(1.0, -s);
  var si: ShadeIn;
  si.p = DPt(d.lvl.xy, s, ldexp(zo, gz), q);
  // (the fog by metres; 0 keeps round 21's haze)
  si.fog = select(-1.0, fogAt(u32(d.lvl.w), dEye), d.geo.y > 0.0);
  si.ng = ng;
  si.mat = matId(mat);
  si.pxW = pxL * sc;
  si.view = -normalize(toEye);
  si.distW = dEye * sc;
  si.sun = normalize(d.sun.xyz);
  // (misc.y: ?bands=split, the per-level cut-off; else every band)
  si.split = select(-1.0, f32(s), d.misc.y > 0.5);
  si.debug = d.misc.x == 3.0;
  // (want.z: ?texbands=, the band window's size; 0 the default)
  si.nb = d.want.z;
  // (want.y, round 21: the forest canopy's crossover footprint, world units a pixel; 0 off: ?canopy, ?canopyfade)
  si.canopy = d.want.y;
  // (misc2.z, round 31: ?cliff: bits 0-11 the slope threshold x 100 (0 off), 12-15 version 3's pixel threshold, 16-23
  // the block width code (0: a column of this level; else 128 + log2 of the width in shading units), 24-27 versions 2-3's
  // cells, 28 version 3, 29 misses red, 30 version 2 or 3, 31 ?cliffcut's cut on (render.ts uniforms))
  let cz = d.misc2.z;
  si.cliff = f32(cz & 0xfffu) / 100.0;
  let wc = i32((cz >> 16u) & 0xffu);
  si.cliffE = select(0, wc - 128 + s, wc != 0);
  var colMiss = false;
  if (((cz >> 30u) & 1u) != 0u) {
    // (version 2, ?cliff=2, bit 30: the marched columns, cells of 2^(wc - 128) shading units, bits 24-27 the steps;
    // version 3, bit 28: the nested columns, level 0 cells of that width, cells under (bits 12-15) pixels not drawn)
    if (si.cliff > 0.0) {
      let nst = i32((cz >> 24u) & 15u);
      var hc: ShCol;
      if (((cz >> 28u) & 1u) != 0u) {
        hc = shCol3(si, wc - 128, nst, f32((cz >> 12u) & 15u));
      } else {
        hc = shCol(si, wc - 128, nst);
      }
      if (CLIFF_CUT && hc.miss && (cz >> 31u) != 0u) { discard; }
      colMiss = hc.miss;
      si.colW = hc.w;
      si.colN = hc.n;
      si.colTint = hc.tint;
      si.colAo = hc.ao;
    }
    si.cliff = 0.0;
  } else if (CLIFF_CUT && si.cliff > 0.0 && (cz >> 31u) != 0u) {
    if (cliffCutAt(si, q, ng)) { discard; }
  }
  var col = texShade(si);
  // (round 31 diagnostics, ?cliffdbg=1, bit 29: version 2's misses red)
  if (colMiss && ((cz >> 29u) & 1u) != 0u) { col = vec3<f32>(1.0, 0.0, 0.0); }
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * dot(col, vec3<f32>(0.3, 0.5, 0.2)) * 1.3, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  let coarse = d.want.x > 0.0 && dEye < d.want.x;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse), 1.0);
  return o;
}
/** a pixel's footprint for the band window, from the level-local point's screen derivatives (precise at any zoom, where
 *  the world point is not): the shorter axis, but at least a quarter of the longer, so a surface seen at a grazing angle
 *  keeps its detail across the view (the cut by the longer axis smeared it into streaks) without bands far under a
 *  pixel along it (shimmer) */
fn footprint(dx: vec3<f32>, dy: vec3<f32>) -> f32 {
  let a = length(dx);
  let b = length(dy);
  return max(min(a, b), max(a, b) / 4.0);
}
@fragment
fn fsT(v: VOut) -> FOut {
  // (derivatives first, in uniform control flow)
  let px = length(fwidth(v.wp));
  let pxL = footprint(dpdx(v.q), dpdy(v.q));
  if (d.misc.x == 1.0 || d.misc.x == 2.0) { return flatOut(v, px); }
  var n = normalize(v.nrm);
  if (dot(n, v.toEye) < 0.0) { n = -n; }
  return texOut(v.q, v.zo, n, v.mat, pxL, v.toEye, v.dEye);
}
@fragment
fn fsST(v: VOutS) -> FOut {
  // (derivatives first, as fsS; the crease rule as fsS, the detail on top of whichever normal it picks)
  let qx = dpdx(v.q);
  let qy = dpdy(v.q);
  let pxL = footprint(qx, qy);
  let cr = cross(qx, qy);
  let cl = length(cr);
  var n = select(vec3<f32>(0.0, 0.0, 1.0), cr / cl, cl > 0.0);
  if (dot(n, v.toEye) < 0.0) { n = -n; }
  let vl = length(v.vn);
  if (vl > 1e-3) {
    let nv = v.vn / vl;
    if (dot(nv, n) >= d.sun.w) { n = nv; }
  }
  return texOut(v.q, v.zo, n, v.mat, pxL, v.toEye, v.dEye);
}

// ---- (round 20) the sky behind the textured draw: a full-screen triangle where nothing was drawn (depth still the
// clear value 0), the direction per pixel from level 0's view-projection; info is not written (its write mask is 0)
fn inverse4(m: mat4x4<f32>) -> mat4x4<f32> {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];
  let b00 = a00 * a11 - a01 * a10; let b01 = a00 * a12 - a02 * a10; let b02 = a00 * a13 - a03 * a10;
  let b03 = a01 * a12 - a02 * a11; let b04 = a01 * a13 - a03 * a11; let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30; let b07 = a20 * a32 - a22 * a30; let b08 = a20 * a33 - a23 * a30;
  let b09 = a21 * a32 - a22 * a31; let b10 = a21 * a33 - a23 * a31; let b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  let id = 1.0 / det;
  return mat4x4<f32>(
    vec4<f32>(a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09, a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03) * id,
    vec4<f32>(a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07, a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01) * id,
    vec4<f32>(a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06, a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00) * id,
    vec4<f32>(a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06, a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00) * id);
}
struct VSky {
  @builtin(position) pos: vec4<f32>,
  /** toward the near plane's point from the eye, level 0's units (affine in the screen, so interpolated exactly) */
  @location(0) dir: vec3<f32>,
}
@vertex
fn vsSky(@builtin(vertex_index) i: u32) -> VSky {
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  let inv = inverse4(vpOf(0u) * d.model);
  let pn = inv * vec4<f32>(xy, 1.0, 1.0);
  var o: VSky;
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.dir = pn.xyz / pn.w - vec3<f32>(cam[48], cam[49], cam[50]);
  return o;
}
@fragment
fn fsSky(v: VSky) -> FOut {
  var o: FOut;
  o.color = vec4<f32>(shDisplay(shSky(normalize(v.dir), normalize(d.sun.xyz))), 1.0);
  o.info = vec4<f32>(0.0);
  return o;
}
