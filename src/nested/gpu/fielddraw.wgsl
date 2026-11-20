// ---- nested/gpu/fielddraw.wgsl (round 26): the field mesh's draw, appended to the draw module (render.ts) in a module of
// its own, made only when ?field is set. An instance a quad page of a field level (gpu/field.wgsl fieldDirBuild: the
// list at binding 5, its own buffer), 6 vertices a quad slot; slots past the page's count are dropped. A skirt corner
// hangs fdu.p.z columns inward along its normal. The material per pixel from the column's record at a point just inside
// the surface, looked up where the field was (the warp) and jittered (never the normal or the slope).

struct FieldDU {
  /** x warp (columns), y the material lookup's jitter (columns), z skirt (columns), w the inside test (0 solid) */
  p: vec4<f32>,
}
@group(0) @binding(2) var<uniform> fdu: FieldDU;

const FD_QPP: u32 = 783u;
const FD_HW: u32 = 16u;
const FD_CORNER = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);

struct VOutF {
  @builtin(position) pos: vec4<f32>,
  /** the level's local units (window-relative x, y) */
  @location(0) q: vec3<f32>,
  @location(1) wp: vec3<f32>,
  @location(2) dEye: f32,
  @location(3) toEye: vec3<f32>,
  @location(4) vn: vec3<f32>,
  @location(5) @interpolate(flat) zo: f32,
}

@vertex
fn vsField(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOutF {
  var o: VOutF;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  let L = u32(d.lvl.w);
  let e = 8u + (L * d.misc2.x + inst) * 3u;
  let page = dir[e];
  let key = dir[e + 1u];
  let s = vv / 6u;
  if (s >= dir[e + 2u]) { return o; }
  let b = page * PW + FD_HW + s * 16u + FD_CORNER[vv % 6u] * 4u;
  let w0 = pgLoad(b);
  let t = unpack2x16unorm(pgLoad(b + 1u));
  // (the cell column as an integer offset from the window first, then the offset in the cell: every chunk that holds
  // this vertex places it bit for bit the same)
  let X = i32(key & 0xffffu) * 16 + i32(w0 & 1023u) - 512 - d.lvl.x;
  let Y = i32(key >> 16u) * 16 + i32((w0 >> 10u) & 1023u) - 512 - d.lvl.y;
  var lp = vec3<f32>(f32(X) + (0.5 + t.x), f32(Y) + (0.5 + t.y), bitcast<f32>(pgLoad(b + 2u)));
  let n = octDec(pgLoad(b + 3u));
  if (((w0 >> 20u) & 1u) == 1u) { lp -= n * fdu.p.z; }
  let pc = placeCorner(Corner(true, lp, 0u, 0u, false));
  o.pos = pc.pos;
  o.q = lp;
  o.wp = worldAt(L, d.lvl.xy, lp);
  let eb = 32u + L * 24u;
  let eye = vec3<f32>(cam[eb + 16u], cam[eb + 17u], cam[eb + 18u]);
  o.dEye = length(lp - eye);
  o.toEye = eye - lp;
  o.vn = n;
  o.zo = zOrigW(L);
  return o;
}

// ---- the material per pixel ----------------------------------------------------------------------------------------
fn fdInside(m: u32) -> bool {
  if (fdu.p.w == 0.0) { return matSolid(m); }
  return false;
}
fn fdHash3(i: vec3<i32>) -> f32 {
  var h = (bitcast<u32>(i.x) * 0x27d4eb2du) ^ (bitcast<u32>(i.y) * 0x165667b1u) ^ (bitcast<u32>(i.z) * 0x9e3779b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h ^= h >> 15u;
  return f32(h >> 8u) / 16777216.0;
}
fn fdNoise(b: vec3<i32>, t0: vec3<f32>) -> f32 {
  let t = t0 * t0 * (3.0 - 2.0 * t0);
  let a = mix(fdHash3(b), fdHash3(b + vec3<i32>(1, 0, 0)), t.x);
  let bb = mix(fdHash3(b + vec3<i32>(0, 1, 0)), fdHash3(b + vec3<i32>(1, 1, 0)), t.x);
  let c = mix(fdHash3(b + vec3<i32>(0, 0, 1)), fdHash3(b + vec3<i32>(1, 0, 1)), t.x);
  let dd = mix(fdHash3(b + vec3<i32>(0, 1, 1)), fdHash3(b + vec3<i32>(1, 1, 1)), t.x);
  return mix(mix(a, bb, t.y), mix(c, dd, t.y), t.z);
}
/** field.wgsl fWarp: the lookup's sideways move at global point (I + f.xy, f.z) */
fn fdWarp(I: vec2<i32>, f: vec3<f32>) -> vec2<f32> {
  let W = fdu.p.x;
  if (W <= 0.0) { return vec2<f32>(0.0); }
  let fl = floor(f.xy);
  let gi = I + vec2<i32>(fl);
  let lat = gi >> vec2<u32>(1u);
  let fr = (vec2<f32>(gi & vec2<i32>(1)) + f.xy - fl) * 0.5;
  let zq = f.z * 0.6;
  let iz = i32(floor(zq));
  let t = vec3<f32>(fr, zq - floor(zq));
  return (vec2<f32>(fdNoise(vec3<i32>(lat, iz), t), fdNoise(vec3<i32>(lat + vec2<i32>(17, 5), iz + 9), t)) - 0.5) * (2.0 * W);
}
/** the material of column (lv, X, Y) at height z: the record holding z if inside, else the nearest inside record (by
 *  height); MAT_AIR when the column has none */
fn fdMatOf(lv: u32, X: i32, Y: i32, z: f32) -> u32 {
  let n = recCount(lv, X, Y);
  var best = MAT_AIR;
  var bd = 1e30;
  var below = -1e30;
  for (var j = 0u; j < n; j++) {
    let r = recAt(lv, X, Y, j);
    let t = bitcast<f32>(r.x);
    if (fdInside(r.y)) {
      // (the record spans below .. t)
      if (z >= below && z < t) { return r.y & 0xffu; }
      let dd = select(below - z, z - t, z >= t);
      if (dd < bd) {
        bd = dd;
        best = r.y & 0xffu;
      }
    }
    below = t;
    if (below > z + bd) { break; }
  }
  return best;
}
/** the material at window-relative point q of the drawn level: q moved 0.3 columns inside along n, warped as the field
 *  was looked up, jittered by up to fdu.p.y columns (borders read ragged, not as the column squares); outside the window
 *  (the cells past its edge, where the field is the parent's) the parent's column */
fn fdMat(q: vec3<f32>, n: vec3<f32>) -> u32 {
  let L = u32(d.lvl.w);
  let p = q - n * 0.3;
  let pi = vec2<i32>(floor(p.xy));
  let I = d.lvl.xy + pi;
  let f = vec3<f32>(p.xy - vec2<f32>(pi), p.z);
  let jc = vec3<i32>(floor(q * 4.0));
  let jo = (vec2<f32>(fdHash3(jc + vec3<i32>(41, 0, 0)), fdHash3(jc + vec3<i32>(0, 43, 0))) - 0.5) * (2.0 * fdu.p.y);
  let g = f.xy + fdWarp(I, f) + jo;
  let C = I + vec2<i32>(floor(g));
  let r = vec2<i32>(C - d.lvl.xy);
  let nn = d.lvl.z;
  if (L > 0u && (r.x < 0 || r.y < 0 || r.x >= nn || r.y >= nn)) {
    let k = i32(d.misc.w);
    let Cp = vec2<i32>(i32(floor(f32(C.x) / f32(k))), i32(floor(f32(C.y) / f32(k))));
    return fdMatOf(L - 1u, Cp.x, Cp.y, p.z * d.want.w + bitcast<f32>(reg[L]));
  }
  let cc = clamp(r, vec2<i32>(0), vec2<i32>(nn - 1)) + d.lvl.xy;
  return fdMatOf(L, cc.x, cc.y, p.z);
}

/** the normal a pixel is lit by: the interpolated vertex normal (the field's gradient), turned toward the eye */
fn fdNormal(v: VOutF) -> vec3<f32> {
  var n = v.vn;
  let l = length(n);
  n = select(vec3<f32>(0.0, 0.0, 1.0), n / l, l > 1e-6);
  if (dot(n, v.toEye) < 0.0) { n = -n; }
  return n;
}
@fragment
fn fsField(v: VOutF) -> FOut {
  // (derivatives first, in uniform control flow)
  let px = length(fwidth(v.wp));
  let n = fdNormal(v);
  let mat = fdMat(v.q, n);
  let pat = pattern(v.wp, n, px);
  let sun = normalize(d.sun.xyz);
  let lit = mix(0.40, 0.52, 0.5 + 0.5 * n.z) + 0.55 * max(dot(n, sun), 0.0);
  var col = matColor(mat) * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  col = mix(col, FOG_FLAT, fogAt(u32(d.lvl.w), v.dEye));
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  let coarse = d.want.x > 0.0 && v.dEye < d.want.x;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse), 1.0);
  return o;
}
@fragment
fn fsFieldT(v: VOutF) -> FOut {
  let pxL = footprint(dpdx(v.q), dpdy(v.q));
  let n = fdNormal(v);
  return texOut(v.q, v.zo, n, fdMat(v.q, n), pxL, v.toEye, v.dEye);
}
