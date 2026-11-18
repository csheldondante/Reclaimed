// ---- nested/gpu/draw.wgsl: a level's surface, pulled from its pages (store.wgsl prepended) ---------------------------
// One grid of n x n vertices at the window's column centres, in the level's own units; the view-projection comes from
// the camera pass (cam). A child's vertices in its rim band (one parent cell wide) and while it fades in are blended
// toward the parent's drawn surface there (the parent's own triangles and normals), so the two agree at the rim and a
// promotion sharpens in instead of popping. A parent discards its fragments inside its child's footprint (inset by
// three quarters of a child column, where the child already equals the parent): a coarse surface never pokes through.

struct DrawU {
  lvl: vec4<i32>, // gx0, gy0, n, depth
  par: vec4<i32>, // parent gx0, gy0, n, has a parent
  cut: vec4<f32>, // the child's footprint in this level's local units, inset (x0, y0, x1, y1); empty: x0 > x1
  misc: vec4<f32>, // now, fade seconds, tint on, k
  want: vec4<f32>, // (metrics) where the focus wants this level's child, local units
  sun: vec4<f32>,
}

@group(0) @binding(0) var<uniform> d: DrawU;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(2) var<storage, read> pg: array<u32>;
@group(0) @binding(3) var<storage, read> cam: array<f32>;
@group(0) @binding(4) var<storage, read> reg: array<i32>;

fn tabLoad(i: u32) -> u32 { return tab[i]; }
fn pgLoad(i: u32) -> u32 { return pg[i]; }

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) fade: f32,
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
/** a column's surface and the material showing there (the top interval with any thickness) */
fn surfMat(lid: u32, X: i32, Y: i32) -> vec2<f32> {
  let n = colCount(lid, X, Y);
  if (n == 0u) { return vec2<f32>(0.0, 0.0); }
  let top = ivlAt(lid, X, Y, n - 1u);
  var m = top.m;
  var i = n - 1u;
  loop {
    let a = ivlAt(lid, X, Y, i);
    if (a.z1 - a.z0 > 1e-4 || i == 0u) {
      m = a.m;
      break;
    }
    i--;
  }
  return vec2<f32>(top.z1, f32(m));
}
fn clampW(w: vec4<i32>, X: i32, Y: i32) -> vec2<i32> { return vec2<i32>(clamp(X, w.x, w.x + w.z - 1), clamp(Y, w.y, w.y + w.z - 1)); }
fn sAt(lid: u32, w: vec4<i32>, X: i32, Y: i32) -> f32 {
  let q = clampW(w, X, Y);
  return topS(lid, q.x, q.y, colCount(lid, q.x, q.y));
}
fn nrmAt(lid: u32, w: vec4<i32>, X: i32, Y: i32) -> vec3<f32> {
  return normalize(vec3<f32>(-(sAt(lid, w, X + 1, Y) - sAt(lid, w, X - 1, Y)) * 0.5, -(sAt(lid, w, X, Y + 1) - sAt(lid, w, X, Y - 1)) * 0.5, 1.0));
}
fn birthOf(lid: u32, X: i32, Y: i32) -> f32 {
  let s = tFind(tKey0(X >> 4, Y >> 4), tKey1(lid, 0u));
  if (s == NONE) { return -1e9; }
  return bitcast<f32>(tab[s * 4u + 3u]);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let w = d.lvl;
  let L = u32(w.w);
  let n = u32(w.z);
  let i = i32(vi % n);
  let j = i32(vi / n);
  let X = w.x + i;
  let Y = w.y + j;
  let sm = surfMat(L, X, Y);
  var h = sm.x;
  var nr = nrmAt(L, w, X, Y);
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
  let b = 32u + L * 24u;
  let vp = mat4x4<f32>(
    vec4<f32>(cam[b], cam[b + 1u], cam[b + 2u], cam[b + 3u]),
    vec4<f32>(cam[b + 4u], cam[b + 5u], cam[b + 6u], cam[b + 7u]),
    vec4<f32>(cam[b + 8u], cam[b + 9u], cam[b + 10u], cam[b + 11u]),
    vec4<f32>(cam[b + 12u], cam[b + 13u], cam[b + 14u], cam[b + 15u]));
  o.pos = vp * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nr;
  o.col = c;
  o.fade = fade;
  return o;
}

const TINTS = array<vec3<f32>, 6>(vec3<f32>(0.35, 0.55, 1.0), vec3<f32>(1.0, 0.35, 0.3), vec3<f32>(1.0, 0.9, 0.25), vec3<f32>(0.35, 1.0, 0.45), vec3<f32>(0.9, 0.4, 1.0), vec3<f32>(0.3, 1.0, 1.0));

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) info: vec4<f32>,
}

@fragment
fn fs(v: VOut) -> FOut {
  let c = d.cut;
  if (v.local.x > c.x && v.local.y > c.y && v.local.x < c.z && v.local.y < c.w) { discard; }
  let n = normalize(v.nrm);
  let sun = normalize(d.sun.xyz);
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = v.col * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  // info: r a surface was drawn, g the level, b not yet sharp (a parent where the focus wants its child, or a fading child)
  let wa = d.want;
  let coarse = wa.x < wa.z && v.local.x > wa.x && v.local.y > wa.y && v.local.x < wa.z && v.local.y < wa.w;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse || v.fade < 1.0), 1.0);
  return o;
}
