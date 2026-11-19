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

fn matColor(m: u32, nz: f32) -> vec3<f32> {
  switch (m) {
    case 1u: { return vec3<f32>(0.47, 0.45, 0.43); }
    case 2u: { return select(vec3<f32>(0.45, 0.36, 0.24), vec3<f32>(0.36, 0.52, 0.24), nz > 0.5); }
    case 3u: { return vec3<f32>(0.80, 0.70, 0.48); }
    case 4u: { return vec3<f32>(0.62, 0.38, 0.30); }
    default: { return vec3<f32>(1.0, 0.0, 1.0); }
  }
}
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
  o.col = matColor(c.mat, n.z);
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
  o.dEye = length(pc.lp - vec3<f32>(cam[eb + 16u], cam[eb + 17u], cam[eb + 18u])) * sk;
  return o;
}

// ---- (round 14, NS-107) the smooth draw: the template over the vertex cache, the exceptions as baked ----------------
// (docs/design/NESTED_SCALES.md "The smooth draw: template, cache, exceptions".) The template is the same 14 triangle
// slots a column for every chunk of every level (an instance a cache page, 256 x 14 x 3 vertices); a vertex reads the
// column's mask word and the cache (a cap corner one slot, a wall vertex the raw heights of the edge's two corner lines
// and one slot), never a column page. A slot the mask leaves off, or a step onto an equal height, is degenerate (no
// pixels). The exceptions are the face pages (nest.wgsl faceBake with SMOOTH), drawn as the boxes are, z already placed.
const CHDR: u32 = 4u;
const CLW: u32 = 20u;
const CMASK: u32 = 5784u;
const TSLOTS: u32 = 14u;

struct TCorner {
  ok: bool,
  lp: vec3<f32>,
  mat: u32,
  kind: u32,
  /** (capture) the corner line and slot this vertex reads */
  line: u32,
  /** (step C) the slot's vertex normal (octahedral word) */
  nrm: u32,
}
/** (step C) a vertex normal from its word (nest.wgsl octEnc) */
fn octDec(w: u32) -> vec3<f32> {
  let p = unpack2x16snorm(w);
  var n = vec3<f32>(p, 1.0 - abs(p.x) - abs(p.y));
  if (n.z < 0.0) { n = vec3<f32>((1.0 - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0)), n.z); }
  return normalize(n);
}
/** the cache words of corner line (lx, ly) of a cache page */
fn tLine(page: u32, lx: u32, ly: u32) -> u32 { return page * PW + CHDR + (ly * 17u + lx) * CLW; }
/** the placed position of slot s of a corner line, local units of the level (the line at (ox + lx, oy + ly)) */
fn tPos(lb: u32, s: u32, x: i32, y: i32) -> vec3<f32> {
  let b = lb + 4u + s * 4u;
  return vec3<f32>(f32(x) + bitcast<f32>(pgLoad(b)), f32(y) + bitcast<f32>(pgLoad(b + 1u)), bitcast<f32>(pgLoad(b + 2u)));
}
/** a wall list entry: one of the line's slots q clamped to [lo, hi] (a clamped slot IS the lower or higher column's
 *  identity on the line: its slot) */
fn tClamp(r: f32, q: u32, lo: f32, loS: u32, hi: f32, hiS: u32) -> vec2<f32> {
  if (r <= lo) { return vec2<f32>(lo, f32(loS)); }
  if (r >= hi) { return vec2<f32>(hi, f32(hiS)); }
  return vec2<f32>(r, f32(q));
}
/** (round 15, NS-117) the chunk's wall list (nest.wgsl CWALL: a word a wall with pixels, column | dir << 8; its count in
 *  header word 3) and the walls a draw instance */
const CWALL: u32 = 6401u;
const WALL_B: u32 = 32u;
/** the level's wall block `inst` (nest.wgsl wallDir): (cache list index, the wall's index in its chunk's list) */
fn tWallItem(inst: u32, k: u32) -> vec2<u32> {
  let L = u32(d.lvl.w);
  let w = dir[16u + 32u * d.misc2.x + 8u + L * 16u * d.misc2.x + inst];
  return vec2<u32>(w >> 4u, (w & 15u) * WALL_B + k);
}
/** vertex v of a cap triangle: cache list entry `inst`, triangle tri (column tri / 2, half tri % 2) */
fn tCap(inst: u32, tri: u32, v0: u32) -> TCorner {
  return tCorner(inst, (tri / 2u) * TSLOTS + tri % 2u, v0);
}
/** vertex v of wall triangle `tri` (wall tri / 6, step tri % 6) of wall block `inst`; none past the chunk's list */
fn tWall(inst: u32, tri: u32, v0: u32) -> TCorner {
  let it = tWallItem(inst, tri / 6u);
  let L = u32(d.lvl.w);
  let page = dir[16u + ((8u + L) * d.misc2.x + it.x) * 2u];
  if (it.y >= pgLoad(page * PW + 3u)) { return TCorner(false, vec3<f32>(0.0), 0u, 0u, 0u, 0u); }
  let w = pgLoad(page * PW + CWALL + it.y);
  return tCorner(it.x, (w & 255u) * TSLOTS + 2u + (w >> 8u) * 6u + tri % 6u, v0);
}
/** vertex v of template triangle slot `tri` (column tri / 14, part tri % 14) of cache page `inst` of the level's list
 *  (boxmesh.ts templateTris, the same rule). Round 15 draws only the slots tCap and tWall pick. */
fn tCorner(inst: u32, tri: u32, v0: u32) -> TCorner {
  var c = TCorner(false, vec3<f32>(0.0), 0u, 0u, 0u, 0u);
  let L = u32(d.lvl.w);
  let e = 16u + ((8u + L) * d.misc2.x + inst) * 2u;
  let page = dir[e];
  let key = dir[e + 1u];
  let col = tri / TSLOTS;
  let part = tri % TSLOTS;
  let lx = col & 15u;
  let ly = col >> 4u;
  let mw = pgLoad(page * PW + CMASK + col);
  let ox = i32(key & 0xffffu) * 16 - d.lvl.x;
  let oy = i32(key >> 16u) * 16 - d.lvl.y;
  if (part < 2u) {
    if ((mw & 1u) == 0u) { return c; }
    // part 0: corners (0, 1, 3), part 1: (0, 3, 2); corner cc's line (lx + (cc & 1), ly + (cc >> 1)), the column's slot
    // on it 3 - cc
    var cc = 0u;
    if (v0 == 1u) { cc = select(3u, 1u, part == 0u); } else if (v0 == 2u) { cc = select(2u, 3u, part == 0u); }
    let qx = lx + (cc & 1u);
    let qy = ly + (cc >> 1u);
    c.lp = tPos(tLine(page, qx, qy), 3u - cc, ox + i32(qx), oy + i32(qy));
    c.nrm = pgLoad(tLine(page, qx, qy) + 4u + (3u - cc) * 4u + 3u);
    c.ok = true;
    c.mat = (mw >> 8u) & 255u;
    c.kind = 4u;
    c.line = ((qy * 17u + qx) << 2u) | (3u - cc);
    return c;
  }
  let dr = (part - 2u) / 6u;
  let st = (part - 2u) % 6u;
  if (((mw >> (1u + dr)) & 1u) == 0u) { return c; }
  // the edge's corner lines P (lower along the edge) and Q, and the slots of this column (C) and the neighbour (B) on
  // each (slotOf(X, Y, CX, CY) = X - CX + 1 + 2 (Y - CY + 1)); the two other slots of each line
  var px = lx + 1u;
  var py = ly;
  var sCP = 2u;
  var sBP = 3u;
  var sCQ = 0u;
  var sBQ = 1u;
  var oP = vec2<u32>(0u, 1u);
  var oQ = vec2<u32>(2u, 3u);
  if (dr == 1u) {
    px = lx;
    py = ly + 1u;
    sCP = 1u;
    sBP = 3u;
    sCQ = 0u;
    sBQ = 2u;
    oP = vec2<u32>(0u, 2u);
    oQ = vec2<u32>(1u, 3u);
  }
  let bP = tLine(page, px, py);
  let bQ = tLine(page, lx + 1u, ly + 1u);
  let rP = vec4<f32>(bitcast<f32>(pgLoad(bP)), bitcast<f32>(pgLoad(bP + 1u)), bitcast<f32>(pgLoad(bP + 2u)), bitcast<f32>(pgLoad(bP + 3u)));
  let rQ = vec4<f32>(bitcast<f32>(pgLoad(bQ)), bitcast<f32>(pgLoad(bQ + 1u)), bitcast<f32>(pgLoad(bQ + 2u)), bitcast<f32>(pgLoad(bQ + 3u)));
  let tC = rP[sCP];
  let tB = rP[sBP];
  let lo = min(tC, tB);
  let hi = max(tC, tB);
  let aIsC = tC > tB;
  let loP = select(sCP, sBP, aIsC);
  let hiP = select(sBP, sCP, aIsC);
  let loQ = select(sCQ, sBQ, aIsC);
  let hiQ = select(sBQ, sCQ, aIsC);
  // each line's list [lo, a, b, hi] (height, slot)
  let a0 = tClamp(rP[oP.x], oP.x, lo, loP, hi, hiP);
  let a1 = tClamp(rP[oP.y], oP.y, lo, loP, hi, hiP);
  let b0 = tClamp(rQ[oQ.x], oQ.x, lo, loQ, hi, hiQ);
  let b1 = tClamp(rQ[oQ.y], oQ.y, lo, loQ, hi, hiQ);
  var pl = array<vec2<f32>, 4>(vec2<f32>(lo, f32(loP)), select(a0, a1, a1.x < a0.x), select(a1, a0, a1.x < a0.x), vec2<f32>(hi, f32(hiP)));
  var ql = array<vec2<f32>, 4>(vec2<f32>(lo, f32(loQ)), select(b0, b1, b1.x < b0.x), select(b1, b0, b1.x < b0.x), vec2<f32>(hi, f32(hiQ)));
  // the zip from the bottom, the side whose next height is lower first, ties to P: to step st
  var i = 0u;
  var j = 0u;
  for (var s = 0u; s < st; s++) {
    if (i < 3u && (j == 3u || pl[i + 1u].x <= ql[j + 1u].x)) { i++; } else { j++; }
  }
  let onP = i < 3u && (j == 3u || pl[i + 1u].x <= ql[j + 1u].x);
  // the triangle (P_i, Q_j, P_i+1) or (P_i, Q_j, Q_j+1), wound by the wall's out direction: (P, Q, up) faces +x on
  // edge +x and -y on edge +y
  var v = v0;
  let flip = select(!aIsC, aIsC, dr == 1u);
  if (flip && v != 0u) { v = 3u - v; }
  var useP = true;
  var idx = i;
  if (v == 1u) {
    useP = false;
    idx = j;
  } else if (v == 2u) {
    if (onP) { idx = i + 1u; } else {
      useP = false;
      idx = j + 1u;
    }
  }
  var s = 0u;
  if (useP) {
    s = u32(pl[idx].y);
    c.lp = tPos(bP, s, ox + i32(px), oy + i32(py));
    c.line = ((py * 17u + px) << 2u) | s;
    c.nrm = pgLoad(bP + 4u + s * 4u + 3u);
  } else {
    s = u32(ql[idx].y);
    c.lp = tPos(bQ, s, ox + i32(lx + 1u), oy + i32(ly + 1u));
    c.line = (((ly + 1u) * 17u + lx + 1u) << 2u) | s;
    c.nrm = pgLoad(bQ + 4u + s * 4u + 3u);
  }
  c.ok = true;
  c.mat = (mw >> (16u + 8u * dr)) & 255u;
  c.kind = select(select(1u, 0u, aIsC), select(3u, 2u, aIsC), dr == 1u);
  return c;
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
  return o;
}
@vertex
fn vsS(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOutS {
  let c = corner(inst, vv / 3u, vv % 3u);
  if (!c.ok) {
    var o: VOutS;
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  return smoothOut(c.lp, c.kid, c.mat);
}
/** (round 15, NS-117) the exceptions in blocks of EX_B triangles (nest.wgsl exDir): an instance a block, so a face page's
 *  empty slots cost no vertex (vsS instanced a whole page, 3 x TPP vertices, whatever its count) */
const EX_B: u32 = 128u;
const EX_PB: u32 = 25u;
fn exCorner(inst: u32, tri: u32, v: u32) -> Corner {
  let L = u32(d.lvl.w);
  let cap = d.misc2.x;
  let w = dir[16u + 32u * cap + 8u + 128u * cap + 8u + L * EX_PB * cap + inst];
  return corner(w >> 5u, (w & 31u) * EX_B + tri, v);
}
@vertex
fn vsSB(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOutS {
  let c = exCorner(inst, vv / 3u, vv % 3u);
  if (!c.ok) {
    var o: VOutS;
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  return smoothOut(c.lp, c.kid, c.mat);
}
fn tOut(c: TCorner) -> VOutS {
  if (!c.ok) {
    var o: VOutS;
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  var o = smoothOut(c.lp, false, c.mat);
  o.vn = octDec(c.nrm);
  return o;
}
/** (round 15, NS-117) the template's caps: an instance a cache page, 2 triangles a column */
@vertex
fn vsTC(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOutS {
  return tOut(tCap(inst, vv / 3u, vv % 3u));
}
/** (round 15, NS-117) the template's walls: an instance a block of WALL_B walls with pixels, 6 triangles a wall */
@vertex
fn vsTW(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOutS {
  return tOut(tWall(inst, vv / 3u, vv % 3u));
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
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = matColor(v.mat, n.z) * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  let coarse = d.want.x > 0.0 && v.dEye < d.want.x;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse), 1.0);
  return o;
}
/** (test only) the template's triangles as the draw places them: three vec4 a slot (local x, y, z; w 1 when the mask
 *  draws the slot and its three vertices are distinct points, else 0). Round 15: the caps' slots (misc2.y cache pages x
 *  512), then the walls' (misc2.z blocks x WALL_B x 6), as vsTC and vsTW place them. */
@compute @workgroup_size(64)
fn captureT(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 64u;
  let nc = d.misc2.y * 512u;
  let per = WALL_B * 6u;
  if (i >= nc + d.misc2.z * per) { return; }
  var t0: TCorner;
  var t1: TCorner;
  var t2: TCorner;
  if (i < nc) {
    t0 = tCap(i / 512u, i % 512u, 0u);
    t1 = tCap(i / 512u, i % 512u, 1u);
    t2 = tCap(i / 512u, i % 512u, 2u);
  } else {
    let j = i - nc;
    t0 = tWall(j / per, j % per, 0u);
    t1 = tWall(j / per, j % per, 1u);
    t2 = tWall(j / per, j % per, 2u);
  }
  let ok = t0.ok && any(t0.lp != t1.lp) && any(t1.lp != t2.lp) && any(t0.lp != t2.lp);
  capOut[i * 3u] = vec4<f32>(t0.lp, select(0.0, 1.0, ok));
  capOut[i * 3u + 1u] = vec4<f32>(t1.lp, select(0.0, 1.0, ok));
  capOut[i * 3u + 2u] = vec4<f32>(t2.lp, select(0.0, 1.0, ok));
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
/** (round 15, test only) the smooth exceptions as vsSB draws them: misc2.w blocks of EX_B slots */
@compute @workgroup_size(64)
fn captureSB(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 64u;
  if (i / EX_B >= d.misc2.w) { return; }
  for (var v = 0u; v < 3u; v++) {
    let c = exCorner(i / EX_B, i % EX_B, v);
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
  let n = normalize(v.nrm);
  let pat = pattern(v.wp, n, px);
  let sun = normalize(d.sun.xyz);
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = v.col * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
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
