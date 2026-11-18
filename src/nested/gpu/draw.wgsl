// ---- nested/gpu/draw.wgsl: a level's surface, from its pages and its baked items (store.wgsl prepended) --------------
// A, the top sheet: one grid of n x n vertices at the window's column centres, pulled from the columns and deformed by
// their heights. B, everything else (tunnel floors and ceilings, overhang undersides, the walls where an air region
// ends between columns): the items the bake wrote (nest.wgsl meshBake) when the columns changed; the vertex stage only
// places them (cut points, walls, the rim morph). Nothing here matches gaps or builds a list: a frame with no change
// draws what was baked. A triangle is A's when its three corners have one gap each, else B's, so the two never overlap.
// A child's vertices in its rim band (one parent cell wide) and while it fades in are blended toward the parent's
// surface there (baked targets for B), so the two agree at the rim and a promotion sharpens in instead of popping. A
// parent discards its fragments inside its child's footprint (inset by three quarters of a child column).

struct DrawU {
  lvl: vec4<i32>, // gx0, gy0, n, depth
  par: vec4<i32>, // parent gx0, gy0, n, has a parent
  cut: vec4<f32>, // the child's footprint in this level's local units, inset (x0, y0, x1, y1); empty: x0 > x1
  misc: vec4<f32>, // now, fade seconds, tint on, k
  want: vec4<f32>, // (metrics) where the focus wants this level's child, local units
  sun: vec4<f32>,
  misc2: vec4<u32>, // x: the pool's pages (the directory's stride), y: 1 = B without its rim morph (measurement)
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
  @location(1) nrm: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) fade: f32,
  @location(4) wp: vec3<f32>, // world position (the pattern's coordinates, the same on every level)
  @location(5) bOwn: f32, // (A) > 0: a corner of this triangle has more than one gap (B draws it)
  @location(6) lz: f32, // the local height (the watertight capture; 3e38: a vertex not drawn)
}

/** a level's z origin in world units (reg words 1..L: each level's origin in its parent's units) */
fn zOrigW(L: u32) -> f32 {
  var z = 0.0;
  for (var j = 1u; j <= L; j++) { z += bitcast<f32>(reg[j]) / pow(d.misc.w, f32(j - 1u)); }
  return z;
}
/** a level's local point in world units */
fn worldOf(L: u32, lp: vec3<f32>) -> vec3<f32> {
  let s = pow(d.misc.w, f32(L));
  return vec3<f32>((f32(d.lvl.x) + lp.x) / s, (f32(d.lvl.y) + lp.y) / s, zOrigW(L) + lp.z / s);
}
fn vpOf(L: u32) -> mat4x4<f32> {
  let b = 32u + L * 24u;
  return mat4x4<f32>(
    vec4<f32>(cam[b], cam[b + 1u], cam[b + 2u], cam[b + 3u]),
    vec4<f32>(cam[b + 4u], cam[b + 5u], cam[b + 6u], cam[b + 7u]),
    vec4<f32>(cam[b + 8u], cam[b + 9u], cam[b + 10u], cam[b + 11u]),
    vec4<f32>(cam[b + 12u], cam[b + 13u], cam[b + 14u], cam[b + 15u]));
}

fn matColor(m: u32, slope: f32) -> vec3<f32> {
  switch (m) {
    case 1u: { return vec3<f32>(0.47, 0.45, 0.43); }
    case 2u: { return mix(vec3<f32>(0.36, 0.52, 0.24), vec3<f32>(0.45, 0.36, 0.24), clamp(slope * 1.4 - 0.3, 0.0, 1.0)); }
    case 3u: { return vec3<f32>(0.80, 0.70, 0.48); }
    case 4u: { return vec3<f32>(0.62, 0.38, 0.30); }
    default: { return vec3<f32>(1.0, 0.0, 1.0); }
  }
}
/** a column's top present surface and the material showing there (the top present interval with any thickness) */
fn surfMat(lid: u32, X: i32, Y: i32) -> vec2<f32> {
  let n = colCount(lid, X, Y);
  if (n == 0u) { return vec2<f32>(0.0, 0.0); }
  let top = topPresent(lid, X, Y, n);
  var m = 0u;
  var i = n - 1u;
  loop {
    let a = ivlAt(lid, X, Y, i);
    if (i == 0u || (present(eS(a)) && a.z1 - a.z0 > 1e-4)) {
      m = a.m;
      break;
    }
    i--;
  }
  return vec2<f32>(top, f32(m));
}
fn clampW(w: vec4<i32>, X: i32, Y: i32) -> vec2<i32> { return vec2<i32>(clamp(X, w.x, w.x + w.z - 1), clamp(Y, w.y, w.y + w.z - 1)); }
fn sAt(lid: u32, w: vec4<i32>, X: i32, Y: i32) -> f32 {
  let q = clampW(w, X, Y);
  return topPresent(lid, q.x, q.y, colCount(lid, q.x, q.y));
}
fn nrmAt(lid: u32, w: vec4<i32>, X: i32, Y: i32) -> vec3<f32> {
  return normalize(vec3<f32>(-(sAt(lid, w, X + 1, Y) - sAt(lid, w, X - 1, Y)) * 0.5, -(sAt(lid, w, X, Y + 1) - sAt(lid, w, X, Y - 1)) * 0.5, 1.0));
}
fn birthOf(lid: u32, X: i32, Y: i32) -> f32 {
  let s = tFind(tKey0(X >> 4, Y >> 4), tKey1(lid, 0u));
  if (s == NONE) { return -1e9; }
  return bitcast<f32>(tab[s * 4u + 3u]);
}
fn cornerOf(q: u32) -> vec2<i32> { return vec2<i32>(i32(q & 1u), i32(q >> 1u)); }

/** A: the top sheet (the floor of the sky), an indexed grid: one vertex a column */
@vertex
fn vs(@builtin(vertex_index) vv: u32) -> VOut { return vertA(vv); }
fn vertA(vv: u32) -> VOut {
  let w = d.lvl;
  let L = u32(w.w);
  let i = i32(vv % u32(w.z));
  let j = i32(vv / u32(w.z));
  let X = w.x + i;
  let Y = w.y + j;
  let sm = surfMat(L, X, Y);
  var h = sm.x;
  // the normal: the gap table's (beside an overhang, the floor the neighbours' matching gaps continue), else the top
  // surface's
  var nr = vec3<f32>(0.0, 0.0, 1.0);
  let gc = gCount(L, X, Y);
  if (hasGapPages(L, X, Y)) { nr = unpackN(recW(GAP_ID + L, X, Y, 1u, 1u), false); } else { nr = nrmAt(L, w, X, Y); }
  var c = matColor(u32(sm.y), length(nr.xy) / max(nr.z, 1e-3));
  var fade = 1.0;
  if (d.par.w != 0) {
    let k = d.misc.w;
    let edge = min(min(f32(i) + 0.5, f32(j) + 0.5), min(f32(w.z - i) - 0.5, f32(w.z - j) - 0.5));
    let band = smoothstep(0.5, k, edge);
    fade = clamp((d.misc.x - birthOf(L, X, Y)) / d.misc.y, 0.0, 1.0);
    let bw = band * fade;
    if (bw < 1.0) {
      // the parent's drawn surface here: its triangle (diagonal from (i, j) to (i + 1, j + 1)) and normals
      let pw = d.par;
      let P = L - 1u;
      let ux = (f32(X) + 0.5) / k - 0.5;
      let uy = (f32(Y) + 0.5) / k - 0.5;
      let i0 = i32(floor(ux));
      let j0 = i32(floor(uy));
      let fu = ux - f32(i0);
      let fv = uy - f32(j0);
      let h00 = sAt(P, pw, i0, j0);
      let h10 = sAt(P, pw, i0 + 1, j0);
      let h01 = sAt(P, pw, i0, j0 + 1);
      let h11 = sAt(P, pw, i0 + 1, j0 + 1);
      var wts = vec4<f32>(0.0);
      if (fu >= fv) { wts = vec4<f32>(1.0 - fu, fu - fv, 0.0, fv); } else { wts = vec4<f32>(1.0 - fv, 0.0, fv - fu, fu); }
      let ph = wts.x * h00 + wts.y * h10 + wts.z * h01 + wts.w * h11;
      let pn = normalize(wts.x * nrmAt(P, pw, i0, j0) + wts.y * nrmAt(P, pw, i0 + 1, j0) + wts.z * nrmAt(P, pw, i0, j0 + 1) + wts.w * nrmAt(P, pw, i0 + 1, j0 + 1));
      let q00 = clampW(pw, i0, j0);
      let q10 = clampW(pw, i0 + 1, j0);
      let q01 = clampW(pw, i0, j0 + 1);
      let q11 = clampW(pw, i0 + 1, j0 + 1);
      let sl = length(pn.xy) / max(pn.z, 1e-3);
      let pc = wts.x * matColor(u32(surfMat(P, q00.x, q00.y).y), sl) + wts.y * matColor(u32(surfMat(P, q10.x, q10.y).y), sl) + wts.z * matColor(u32(surfMat(P, q01.x, q01.y).y), sl) + wts.w * matColor(u32(surfMat(P, q11.x, q11.y).y), sl);
      let z0 = bitcast<f32>(reg[L]);
      h = mix((ph - z0) * k, h, bw);
      nr = normalize(mix(pn, nr, bw));
      c = mix(pc, c, bw);
    }
  }
  var o: VOut;
  let lp = vec3<f32>(f32(i) + 0.5, f32(j) + 0.5, h);
  o.pos = vpOf(L) * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nr;
  o.col = c;
  o.fade = fade;
  o.wp = worldOf(L, lp);
  // (B draws every triangle with a flagged corner: more than one air run, or an edge the slab draw cuts)
  o.bOwn = select(0.0, 1.0, gc > 1u || (hasGapPages(L, X, Y) && ((recW(GAP_ID + L, X, Y, 0u, 2u) >> 16u) & 1u) == 1u));
  o.lz = lp.z;
  return o;
}

// ---- B: the baked items --------------------------------------------------------------------------------------------
/** the rim band and fade weight at a child's local point (x: 1 the child's own, 0 the parent's; y: the fade) */
fn bandW(lp: vec2<f32>, birth: f32) -> vec2<f32> {
  if (d.par.w == 0) { return vec2<f32>(1.0, 1.0); }
  let w = d.lvl;
  let k = d.misc.w;
  let edge = min(min(lp.x, lp.y), min(f32(w.z) - lp.x, f32(w.z) - lp.y));
  let band = smoothstep(0.5, k, edge);
  let fade = clamp((d.misc.x - birth) / d.misc.y, 0.0, 1.0);
  if (d.misc2.y == 1u) { return vec2<f32>(1.0, fade); }
  return vec2<f32>(band * fade, fade);
}
fn unpackN(w: u32, down: bool) -> vec3<f32> {
  let xy = unpack2x16snorm(w);
  let z = sqrt(max(0.0, 1.0 - dot(xy, xy)));
  return vec3<f32>(xy, select(z, -z, down));
}
/** one corner of an item, deformed for this frame */
struct Cn {
  p: vec2<f32>, // local position
  pres: bool, // present this frame (enclosed regions: the morphed presence)
  s: f32, // presence field (cut points sit where it crosses one half)
  f: f32, // floor
  c: f32, // ceiling (1e30: none)
  rb: f32, // the solid run's bottom (the sky's wall)
  nF: vec3<f32>,
  nC: vec3<f32>,
  fm: u32,
  cm: u32,
  fade: f32,
}

/** B: an item (one region of one triangle) as up to three parts of six vertices: its floor, its ceiling (where it is
 *  finite), and the wall along the cut where the region ends inside the triangle (marching triangles on the presence
 *  field; an enclosed region's wall from floor to ceiling, facing the air; the sky's down its solid run, facing out). */
// ---- the slab draw (footprints, F4; nest.wgsl writeSlab): an item is slab s of one triangle whose corners have one
// interval count. Every point on a triangle edge is computed from that edge's two corners alone, in one order (the
// corner first in (y, x)), so the faces on both sides of an edge, and the walls ending on it, share it bit for bit; points
// inside the triangle (where two slabs' edges cross) are computed by one function from the same corner data in every
// item that uses them. Watertight by construction.
/** a polygon or wall point: a corner (k 0), a point on edge r0-r1 at t from r0 (k 1, r0 the canonical first), or inside
 *  with barycentric weights w (k 2) */
struct PV {
  k: u32,
  r0: u32,
  r1: u32,
  t: f32,
  w: vec3<f32>,
}
var<private> sP: array<vec2<f32>, 3>;
var<private> sRank: array<u32, 3>;
fn pvVal(v: PV, x: array<f32, 3>) -> f32 {
  if (v.k == 0u) { return x[v.r0]; }
  if (v.k == 1u) { return x[v.r0] + (x[v.r1] - x[v.r0]) * v.t; }
  return v.w.x * x[0] + v.w.y * x[1] + v.w.z * x[2];
}
fn pvPos(v: PV) -> vec2<f32> {
  if (v.k == 0u) { return sP[v.r0]; }
  if (v.k == 1u) { return sP[v.r0] + (sP[v.r1] - sP[v.r0]) * v.t; }
  return v.w.x * sP[0] + v.w.y * sP[1] + v.w.z * sP[2];
}
/** where field x crosses 0 on edge ra-rb (canonical order) */
fn edgeCut(x: array<f32, 3>, ra: u32, rb: u32) -> PV {
  var u = ra;
  var v = rb;
  if (sRank[rb] < sRank[ra]) {
    u = rb;
    v = ra;
  }
  return PV(1u, u, v, x[u] / (x[u] - x[v]), vec3<f32>(0.0));
}
/** where fields x and y (x the lower slab's) are both 0; w.x < -1: not inside the triangle */
fn crossPt(x: array<f32, 3>, y: array<f32, 3>) -> PV {
  let c = cross(vec3<f32>(x[0], x[1], x[2]), vec3<f32>(y[0], y[1], y[2]));
  let sum = c.x + c.y + c.z;
  var w = vec3<f32>(-9.0);
  if (sum != 0.0) { w = c / sum; }
  if (w.x < 0.0 || w.y < 0.0 || w.z < 0.0) { w = vec3<f32>(-9.0); }
  return PV(2u, 0u, 0u, 0.0, w);
}
/** vertex j of the fan of the region {sf * x >= 0, sg * y >= 0} of the triangle (x the lower slab's field); ok false: none */
struct PolyV {
  v: PV,
  ok: bool,
}
fn regionVert(x: array<f32, 3>, y: array<f32, 3>, sf: f32, sg: f32, tri: u32, j: u32) -> PolyV {
  var pts: array<PV, 6>;
  var np = 0u;
  let ps = crossPt(x, y);
  for (var r = 0u; r < 3u; r++) {
    let r1 = (r + 1u) % 3u;
    let fin = sf * x[r] > 0.0;
    let gin = sg * y[r] > 0.0;
    if (fin && gin) {
      pts[np] = PV(0u, r, 0u, 0.0, vec3<f32>(0.0));
      np++;
    }
    // crossings on this edge, in walk order (parameter from r)
    var c0 = PV(0u, 0u, 0u, 0.0, vec3<f32>(0.0));
    var c1 = c0;
    var w0 = 2.0;
    var w1 = 2.0;
    var e0 = false;
    var e1 = false;
    if ((x[r] > 0.0) != (x[r1] > 0.0)) {
      let c = edgeCut(x, r, r1);
      let tw = select(1.0 - c.t, c.t, c.r0 == r);
      if (sg * pvVal(c, y) >= 0.0) {
        c0 = c;
        w0 = tw;
        e0 = fin;
      }
    }
    if ((y[r] > 0.0) != (y[r1] > 0.0)) {
      let c = edgeCut(y, r, r1);
      let tw = select(1.0 - c.t, c.t, c.r0 == r);
      if (sf * pvVal(c, x) >= 0.0) {
        c1 = c;
        w1 = tw;
        e1 = gin;
      }
    }
    for (var q = 0u; q < 2u; q++) {
      // (the nearer first)
      let first = w0 <= w1;
      let take0 = select(q == 1u, q == 0u, first);
      let wv = select(w1, w0, take0);
      if (wv > 1.5) { continue; }
      if (take0) { pts[np] = c0; } else { pts[np] = c1; }
      np++;
      // an exit (inside before the crossing): the boundary goes inside, through the corner of the two lines if any
      if (select(e1, e0, take0) && ps.w.x > -1.0) {
        pts[np] = ps;
        np++;
      }
    }
  }
  var out = PolyV(PV(0u, 0u, 0u, 0.0, vec3<f32>(0.0)), false);
  if (tri + 2u >= np) { return out; }
  var q = 0u;
  if (j == 1u) { q = tri + 1u; } else if (j == 2u) { q = tri + 2u; }
  out.v = pts[q];
  out.ok = true;
  return out;
}

fn vertSlab(vv: u32, b: u32, h0: u32) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  o.fade = 1.0;
  o.bOwn = 0.0;
  o.lz = 3e38;
  let w = d.lvl;
  let L = u32(w.w);
  let t = (h0 >> 8u) & 1u;
  let s = h0 >> 11u;
  var tc = array<u32, 3>(0u, 1u, 3u);
  if (t == 1u) { tc = array<u32, 3>(0u, 3u, 2u); }
  var lo: array<f32, 3>;
  var hi: array<f32, 3>;
  var am: array<f32, 3>;
  var a0: array<f32, 3>;
  var a1: array<f32, 3>;
  var nu: array<vec3<f32>, 3>;
  var mt = vec2<u32>(0u);
  var fade = 1.0;
  for (var r = 0u; r < 3u; r++) {
    let q = b + 2u + r * 10u;
    sP[r] = sBase + vec2<f32>(cornerOf(tc[r])) + 0.5;
    sRank[r] = tc[r];
    lo[r] = bitcast<f32>(pgLoad(q));
    hi[r] = bitcast<f32>(pgLoad(q + 1u));
    let e2 = unpack2x16float(pgLoad(q + 2u));
    am[r] = e2.x;
    a0[r] = e2.y;
    a1[r] = unpack2x16float(pgLoad(q + 3u)).x;
    nu[r] = unpackN(pgLoad(q + 4u), false);
    if (r == 0u) { mt = vec2<u32>(pgLoad(q + 5u) & 0xffu, (pgLoad(q + 5u) >> 8u) & 0xffu); }
    let birth = bitcast<f32>(pgLoad(q + 8u));
    let bw = bandW(sP[r], birth);
    fade = min(fade, bw.y);
    // the top sheet's rim morph and fade, the same per column (draw A's vertA): every bound of the column moves with it
    if (d.par.w != 0 && bw.x < 1.0) {
      let top = bitcast<f32>(pgLoad(q + 6u));
      let mv = mix(bitcast<f32>(pgLoad(q + 7u)), top, bw.x);
      hi[r] = select(hi[r] + (mv - top), mv, hi[r] == top);
      lo[r] = select(lo[r] + (mv - top), mv, lo[r] == top);
    }
  }
  let part = vv / 9u;
  var lp = vec3<f32>(0.0);
  var nrm = vec3<f32>(0.0, 0.0, 1.0);
  var mat = mt.x;
  if (part < 2u) {
    // the faces at H_s: up where slab s is solid and s + 1 air, down where s is air and s + 1 solid
    let up = part == 0u;
    let pv = regionVert(a0, a1, select(1.0, -1.0, up), select(-1.0, 1.0, up), (vv % 9u) / 3u, vv % 3u);
    if (!pv.ok) { return o; }
    lp = vec3<f32>(pvPos(pv.v), pvVal(pv.v, hi));
    var nn = array<f32, 3>(nu[0].x, nu[1].x, nu[2].x);
    let nx = pvVal(pv.v, nn);
    nn = array<f32, 3>(nu[0].y, nu[1].y, nu[2].y);
    let ny = pvVal(pv.v, nn);
    nrm = normalize(vec3<f32>(nx, ny, sqrt(max(0.0, 1.0 - nx * nx - ny * ny))));
    if (!up) {
      nrm = -nrm;
      mat = mt.y;
    }
  } else {
    // slab s's wall along a_s = 0, from H_{s-1} to H_s, split where slab s - 1's and s + 1's edges cross it
    if (s == 0u) { return o; }
    var ends: array<PV, 2>;
    var ne = 0u;
    for (var r = 0u; r < 3u; r++) {
      let r1 = (r + 1u) % 3u;
      if ((a0[r] > 0.0) != (a0[r1] > 0.0) && ne < 2u) {
        ends[ne] = edgeCut(a0, r, r1);
        ne++;
      }
    }
    if (ne < 2u) { return o; }
    let pa = pvPos(ends[0]);
    let dir = pvPos(ends[1]) - pa;
    var pts = array<PV, 4>(ends[0], ends[1], ends[1], ends[1]);
    var prm = array<f32, 4>(0.0, 1.0, 2.0, 2.0);
    var np = 2u;
    for (var q = 0u; q < 2u; q++) {
      var c = crossPt(am, a0);
      if (q == 1u) { c = crossPt(a0, a1); }
      if (c.w.x > -1.0) {
        let pp = clamp(dot(pvPos(c) - pa, dir) / max(dot(dir, dir), 1e-12), 0.0, 1.0);
        // insert in order
        var k = np;
        loop {
          if (k == 0u || prm[k - 1u] <= pp) { break; }
          pts[k] = pts[k - 1u];
          prm[k] = prm[k - 1u];
          k--;
        }
        pts[k] = c;
        prm[k] = pp;
        np++;
      }
    }
    let wv = vv - 18u;
    let piece = wv / 6u;
    if (piece + 1u >= np) { return o; }
    let A = pts[piece];
    let B = pts[piece + 1u];
    let sv = wv % 6u;
    let pA = pvPos(A);
    let pB = pvPos(B);
    let quad = array<vec3<f32>, 4>(vec3<f32>(pA, pvVal(A, lo)), vec3<f32>(pB, pvVal(B, lo)), vec3<f32>(pB, pvVal(B, hi)), vec3<f32>(pA, pvVal(A, hi)));
    let idx = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    lp = quad[idx[sv]];
    // facing the air (the side where slab s is air)
    var hn = normalize(vec2<f32>(-dir.y, dir.x) + vec2<f32>(1e-9, 0.0));
    // (the gradient of a_s over the triangle points to the air)
    let g = slabGrad(a0);
    if (dot(hn, g) < 0.0) { hn = -hn; }
    nrm = vec3<f32>(hn, 0.0);
  }
  o.pos = vpOf(L) * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nrm;
  o.col = matColor(mat, select(length(nrm.xy) / max(abs(nrm.z), 1e-3), 2.0, part == 2u));
  if (d.misc2.z == 1u) { o.col = array<vec3<f32>, 3>(vec3<f32>(0.2, 0.3, 1.0), vec3<f32>(0.1, 0.9, 0.2), vec3<f32>(1.0, 0.1, 0.1))[part]; }
  o.fade = fade;
  o.wp = worldOf(L, lp);
  o.lz = lp.z;
  o.bOwn = 2.0; // (the capture's tag: a slab item; B's fragment stage ignores it)
  return o;
}
/** the gradient (local xy) of a field over the triangle sP */
fn slabGrad(x: array<f32, 3>) -> vec2<f32> {
  let e1 = sP[1] - sP[0];
  let e2 = sP[2] - sP[0];
  let det = e1.x * e2.y - e1.y * e2.x;
  let d1 = x[1] - x[0];
  let d2 = x[2] - x[0];
  return vec2<f32>(d1 * e2.y - d2 * e1.y, d2 * e1.x - d1 * e2.x) / det;
}
var<private> sBase: vec2<f32>;

@vertex
fn vsB(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOut { return vertB(vv, inst); }
fn vertB(vv: u32, inst: u32) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  o.fade = 1.0;
  o.bOwn = 0.0;
  o.lz = 3e38;
  let w = d.lvl;
  let L = u32(w.w);
  let e = 16u + (L * d.misc2.x + inst / IPP) * 2u;
  let page = dir[e];
  let key = dir[e + 1u];
  let slot = inst % IPP;
  if (slot >= pgLoad(page * PW)) { return o; }
  let b = page * PW + MESH_HDR + slot * ITEM_W;
  let h0 = pgLoad(b);
  let birth = bitcast<f32>(pgLoad(b + 1u));
  let enclosed = ((h0 >> 9u) & 1u) == 1u;
  let t = (h0 >> 8u) & 1u;
  let base = vec2<i32>(i32(key & 0xffffu) * 16 + i32(h0 & 15u), i32(key >> 16u) * 16 + i32((h0 >> 4u) & 15u));
  // (an item baked before a slide may reach past the window's new edge)
  if (base.x < w.x || base.y < w.y || base.x + 1 >= w.x + w.z || base.y + 1 >= w.y + w.z) { return o; }
  // footprints: a slab item (kind 1) is cut on its corners' distances (F4); a region item (kind 0, triangles of corners
  // of different interval counts) as before, half way (NS-55)
  if (((h0 >> 10u) & 1u) == 1u) {
    sBase = vec2<f32>(base - w.xy);
    return vertSlab(vv, b, h0);
  }
  if (vv >= 18u) { return o; }
  var tc = array<u32, 3>(0u, 1u, 3u);
  if (t == 1u) { tc = array<u32, 3>(0u, 3u, 2u); }
  var cn: array<Cn, 3>;
  for (var r = 0u; r < 3u; r++) {
    let q = b + 2u + r * 9u;
    let m = pgLoad(q + 3u);
    let own = ((m >> 16u) & 1u) == 1u;
    let p = vec2<f32>(base - w.xy + cornerOf(tc[r])) + 0.5;
    let bw = bandW(p, birth);
    var f = bitcast<f32>(pgLoad(q));
    var c = bitcast<f32>(pgLoad(q + 1u));
    var rb = bitcast<f32>(pgLoad(q + 2u));
    let pf = bitcast<f32>(pgLoad(q + 6u));
    let pc = bitcast<f32>(pgLoad(q + 7u));
    let x8 = bitcast<f32>(pgLoad(q + 8u));
    var s = select(0.0, 1.0, own);
    if (enclosed) {
      s = mix(x8, s, bw.x);
    } else if (d.par.w != 0) {
      rb = mix(x8, rb, bw.x);
    }
    f = mix(pf, f, bw.x);
    if (c < 1e29) { c = mix(pc, c, bw.x); }
    cn[r] = Cn(p, select(own, s >= 0.5, enclosed), s, f, c, rb, unpackN(pgLoad(q + 4u), false), unpackN(pgLoad(q + 5u), true), m & 0xffu, (m >> 8u) & 0xffu, bw.y);
  }
  let part = vv / 6u;
  let sv = vv % 6u;
  // present for this part: floors need the region; ceilings also a finite ceiling
  var pr = array<bool, 3>(false, false, false);
  var np = 0u;
  for (var r = 0u; r < 3u; r++) {
    pr[r] = cn[r].pres && (part != 1u || cn[r].c < 1e29);
    if (pr[r]) { np++; }
  }
  if (np == 0u || (part == 2u && np == 3u)) { return o; }
  // present corners first
  var ord = array<u32, 3>(0u, 1u, 2u);
  var k2 = 0u;
  for (var r = 0u; r < 3u; r++) {
    if (pr[r]) {
      ord[k2] = r;
      k2++;
    }
  }
  for (var r = 0u; r < 3u; r++) {
    if (!pr[r]) {
      ord[k2] = r;
      k2++;
    }
  }
  let A = cn[ord[0]];
  let B = cn[ord[1]];
  let X = cn[ord[2]];
  // where the region ends along an edge from a present corner to an absent one: the presence field's half crossing
  // (the child's own: half way; in the rim band it moves to where the parent's region ends)
  let tAX = clamp((A.s - 0.5) / max(A.s - X.s, 1e-6), 0.0, 1.0);
  let tBX = clamp((B.s - 0.5) / max(B.s - X.s, 1e-6), 0.0, 1.0);
  let tAB = clamp((A.s - 0.5) / max(A.s - B.s, 1e-6), 0.0, 1.0);
  var lp = vec3<f32>(0.0);
  var nrm = vec3<f32>(0.0, 0.0, 1.0);
  var mat = A.fm;
  var fade = min(min(cn[0].fade, cn[1].fade), cn[2].fade);
  if (part < 2u) {
    let ce = part == 1u;
    var P = array<vec2<f32>, 6>();
    var S = array<u32, 6>(0u, 0u, 0u, 0u, 0u, 0u); // which of A, B, X a point takes its bounds from
    if (np == 3u) {
      P = array<vec2<f32>, 6>(A.p, B.p, X.p, A.p, A.p, A.p);
      S = array<u32, 6>(0u, 1u, 2u, 0u, 0u, 0u);
    } else if (np == 2u) {
      let mbx = mix(B.p, X.p, tBX);
      let max_ = mix(A.p, X.p, tAX);
      P = array<vec2<f32>, 6>(A.p, B.p, mbx, A.p, mbx, max_);
      S = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
    } else {
      let mab = mix(A.p, B.p, tAB);
      let mak = mix(A.p, X.p, tAX);
      P = array<vec2<f32>, 6>(A.p, mab, mak, A.p, A.p, A.p);
    }
    var src = A;
    if (S[sv] == 1u) { src = B; } else if (S[sv] == 2u) { src = X; }
    lp = vec3<f32>(P[sv], select(src.f, src.c, ce));
    nrm = select(src.nF, src.nC, ce);
    mat = select(src.fm, src.cm, ce);
  } else {
    // the wall along the cut, between its two points (np 2: on edges B-X and A-X; np 1: A-B and A-X)
    var m1 = mix(A.p, X.p, tAX);
    var m2 = mix(B.p, X.p, tBX);
    var e2 = B;
    if (np == 1u) {
      m2 = mix(A.p, B.p, tAB);
      e2 = A;
    }
    let b1 = select(A.rb, A.f, enclosed);
    let t1 = select(A.f, A.c, enclosed);
    let b2 = select(e2.rb, e2.f, enclosed);
    let t2 = select(e2.f, e2.c, enclosed);
    let pts = array<vec3<f32>, 6>(vec3<f32>(m1, b1), vec3<f32>(m2, b2), vec3<f32>(m2, t2), vec3<f32>(m1, b1), vec3<f32>(m2, t2), vec3<f32>(m1, t1));
    lp = pts[sv];
    let dr = normalize(m2 - m1 + vec2<f32>(1e-9, 0.0));
    var hn = vec2<f32>(-dr.y, dr.x);
    // toward the present side for an enclosed region (the air), away from it for the sky (the solid faces out)
    let toPresent = dot(hn, A.p - m1) > 0.0;
    if (toPresent != enclosed) { hn = -hn; }
    nrm = vec3<f32>(hn, 0.0);
  }
  o.pos = vpOf(L) * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nrm;
  o.col = matColor(mat, select(length(nrm.xy) / max(abs(nrm.z), 1e-3), 2.0, part == 2u));
  // (diagnostics) B's parts in flat colours: floors blue, ceilings green, walls red
  if (d.misc2.z == 1u) { o.col = array<vec3<f32>, 3>(vec3<f32>(0.2, 0.3, 1.0), vec3<f32>(0.1, 0.9, 0.2), vec3<f32>(1.0, 0.1, 0.1))[part]; }
  o.fade = fade;
  o.wp = worldOf(L, lp);
  o.lz = lp.z;
  return o;
}

// ---- the watertight check's capture (test only): every vertex the draw would place, in local units -------------------
// x, y, z local; w: A, 1 when the vertex's triangles are B's (bOwn); B, 0 for a vertex not drawn
@group(1) @binding(0) var<storage, read_write> capOut: array<vec4<f32>>;
@compute @workgroup_size(64)
fn captureA(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let n = u32(d.lvl.z);
  let i = gid.x + gid.y * nw.x * 64u;
  if (i >= n * n) { return; }
  let o = vertA(i);
  capOut[i] = vec4<f32>(o.local, o.lz, o.bOwn);
}
@compute @workgroup_size(64)
fn captureB(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 64u;
  let inst = i / VPI;
  if (inst >= d.misc2.w) { return; }
  let o = vertB(i % VPI, inst);
  // (w: 0 not drawn, 1 a region item's, 2 a slab item's)
  capOut[i] = vec4<f32>(o.local, o.lz, select(select(1.0, 2.0, o.bOwn == 2.0), 0.0, o.lz > 1e38));
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
 *  than a pixel. Steep faces and strips take the side planes, so nothing is stretched. */
fn pattern(p: vec3<f32>, n: vec3<f32>, px: f32) -> f32 {
  var bw = pow(abs(n), vec3<f32>(4.0));
  bw /= bw.x + bw.y + bw.z;
  // the three finest octaves (wavelengths 1, 1/4, 1/16 ... world units) still coarser than a pixel
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
/** px: world units a pixel (fwidth, taken before any discard) */
fn shade(v: VOut, px: f32) -> FOut {
  let n = normalize(v.nrm);
  let pat = pattern(v.wp, n, px);
  let sun = normalize(d.sun.xyz);
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = v.col * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  // info: r a surface was drawn, g the level, b not yet sharp (a parent where the focus wants its child, or a fading child)
  let wa = d.want;
  let coarse = wa.x < wa.z && v.local.x > wa.x && v.local.y > wa.y && v.local.x < wa.z && v.local.y < wa.w;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse || v.fade < 1.0), 1.0);
  return o;
}
fn cutAway(v: VOut) -> bool {
  let c = d.cut;
  return v.local.x > c.x && v.local.y > c.y && v.local.x < c.z && v.local.y < c.w;
}
@fragment
fn fs(v: VOut) -> FOut {
  let px = length(fwidth(v.wp));
  if (cutAway(v)) { discard; }
  return shade(v, px);
}
/** the top sheet: a triangle with a corner of more than one gap is B's */
@fragment
fn fsA(v: VOut) -> FOut {
  let px = length(fwidth(v.wp));
  if (cutAway(v) || v.bOwn > 0.0) { discard; }
  return shade(v, px);
}
