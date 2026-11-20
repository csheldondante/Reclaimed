// ---- nested/gpu/detail.wgsl: the world-space detail height (round 20) ----------------------------------------------
// One procedural height field in WORLD units, as a stack of bands. Band b is one octave of 3D gradient noise with
// wavelength 2^(1 - b) world units (band 0: two root columns) and an amplitude proportional to its wavelength, so every
// band adds the same slope. No derivative built-ins and no texture sampling: callable from the vertex, fragment and
// compute stages (a later round feeds the same bands into finer levels' geometry).
//
// Precision: a point is given as a level's integer window origin plus a local offset (DPt), not as an f32 world point.
// Each band's lattice is periodic with DB_P cells, so the integer part is reduced modulo DB_P exactly and only the small
// local part goes through floats: the same world point gives the same lattice coordinate (to f32 rounding of the local
// part) from any level, and the finest bands stay exact at any distance from the world origin. A band's period is DB_P
// wavelengths: a band is only drawn where its wavelength is at least 2 pixels, so one screen never shows a repeat.
// Levels must scale by a power of two (s = L log2 k); a k that is not one is out of contract (BACKLOG NS-146).

/** bands in the stack: wavelength 2 world units (band 0) down to 2^-14 (band 15) */
const DB_N: i32 = 16;
/** band 0's frequency: 2^DB_M0 cycles a world unit */
const DB_M0: i32 = -1;
/** each band's lattice period, cells (a power of two) */
const DB_P: i32 = 4096;

/** a point: world x, y = (o + f.xy) / 2^s; world z = zo + f.z / 2^s (a level L's window origin o in its global columns,
 *  s = L log2 k, zo its z origin in world units, f a level-local point) */
struct DPt {
  o: vec2<i32>,
  s: i32,
  zo: f32,
  f: vec3<f32>,
}

/** (o + f) 2^e as a whole cell (wrapping: only its value mod DB_P is used) and a fraction in [0, 1); the whole part
 *  goes through integers, so only f's fraction is scaled in floats */
struct DbA {
  c: i32,
  t: f32,
}
fn dbSplit(o: i32, f: f32, e: i32) -> DbA {
  let fl = floor(f);
  let oi = o + i32(fl);
  let ff = f - fl;
  var r = DbA(0, 0.0);
  if (e >= 0) {
    r.c = bitcast<i32>(bitcast<u32>(oi) << u32(min(e, 31)));
    r.t = ldexp(ff, e);
  } else {
    let sh = u32(min(-e, 31));
    let a = oi >> sh;
    r.c = a;
    r.t = ldexp(f32(oi - (a << sh)) + ff, e);
  }
  let ti = floor(r.t);
  r.c += i32(ti);
  r.t -= ti;
  return r;
}
/** one axis of the lattice of frequency 2^m: (cell mod DB_P, fraction) of (o + f) 2^(m - s) */
fn dbAxis(o: i32, f: f32, e: i32) -> vec2<f32> {
  let r = dbSplit(o, f, e);
  return vec2<f32>(f32(r.c & (DB_P - 1)), r.t);
}
/** the z axis: zo 2^m (exact: a power-of-two scale) split into whole and fraction, plus f 2^(m - s) */
fn dbAxisZ(zo: f32, f: f32, m: i32, e: i32) -> vec2<f32> {
  let z0 = ldexp(zo, m);
  let zi = floor(z0);
  let r = dbSplit(0, f, e);
  var t = (z0 - zi) + r.t;
  var c = i32(zi) + r.c;
  if (t >= 1.0) {
    t -= 1.0;
    c += 1;
  }
  return vec2<f32>(f32(c & (DB_P - 1)), t);
}

fn dbGrad(c: vec3<i32>, seed: u32) -> vec3<f32> {
  let q = vec3<u32>(c & vec3<i32>(DB_P - 1));
  var h = (q.x * 0x8da6b343u) ^ (q.y * 0xd8163841u) ^ (q.z * 0xcb1ab31fu) ^ (seed * 0x9e3779b9u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return vec3<f32>(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) * (2.0 / 1023.0) - 1.0;
}

/** 3D gradient noise of frequency 2^m at p (seed: which field): x the value (about -1..1), yzw its gradient per WORLD
 *  unit times the wavelength 2^-m (so about -3..3 whatever the band) */
fn dbNoise(p: DPt, m: i32, seed: u32) -> vec4<f32> {
  let e = m - p.s;
  let ax = dbAxis(p.o.x, p.f.x, e);
  let ay = dbAxis(p.o.y, p.f.y, e);
  let az = dbAxisZ(p.zo, p.f.z, m, e);
  let c = vec3<i32>(i32(ax.x), i32(ay.x), i32(az.x));
  let w = vec3<f32>(ax.y, ay.y, az.y);
  let u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  let du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  let ga = dbGrad(c, seed);
  let gb = dbGrad(c + vec3<i32>(1, 0, 0), seed);
  let gc = dbGrad(c + vec3<i32>(0, 1, 0), seed);
  let gd = dbGrad(c + vec3<i32>(1, 1, 0), seed);
  let ge = dbGrad(c + vec3<i32>(0, 0, 1), seed);
  let gf = dbGrad(c + vec3<i32>(1, 0, 1), seed);
  let gg = dbGrad(c + vec3<i32>(0, 1, 1), seed);
  let gh = dbGrad(c + vec3<i32>(1, 1, 1), seed);
  let va = dot(ga, w);
  let vb = dot(gb, w - vec3<f32>(1.0, 0.0, 0.0));
  let vc = dot(gc, w - vec3<f32>(0.0, 1.0, 0.0));
  let vd = dot(gd, w - vec3<f32>(1.0, 1.0, 0.0));
  let ve = dot(ge, w - vec3<f32>(0.0, 0.0, 1.0));
  let vf = dot(gf, w - vec3<f32>(1.0, 0.0, 1.0));
  let vg = dot(gg, w - vec3<f32>(0.0, 1.0, 1.0));
  let vh = dot(gh, w - vec3<f32>(1.0, 1.0, 1.0));
  let k1 = vb - va;
  let k2 = vc - va;
  let k3 = ve - va;
  let k4 = va - vb - vc + vd;
  let k5 = va - vc - ve + vg;
  let k6 = va - vb - ve + vf;
  let k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  let v = va + u.x * k1 + u.y * k2 + u.z * k3 + u.x * u.y * k4 + u.y * u.z * k5 + u.z * u.x * k6 + u.x * u.y * u.z * k7;
  let g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf) + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh) + du * (vec3<f32>(k1, k2, k3) + u.yzx * vec3<f32>(k4, k5, k6) + u.zxy * vec3<f32>(k6, k4, k5) + u.yzx * u.zxy * k7);
  return vec4<f32>(v, g);
}

/** a material's bump slope (every band the same: amplitude = slope x wavelength / 2 pi); 0 for none */
fn dbSlope(mat: u32) -> f32 {
  switch (mat) {
    case 1u: { return 0.7; }
    case 2u: { return 0.45; }
    case 3u: { return 0.25; }
    case 4u: { return 0.5; }
    case 5u: { return 0.45; }
    default: { return 0.0; }
  }
}
/** the wavelength of band b, world units */
fn dbLambda(b: i32) -> f32 { return ldexp(1.0, -(DB_M0 + b)); }

/** band b of the detail height at p for material mat: x the height (world units), yzw its gradient (per world unit) */
fn detailHG(p: DPt, mat: u32, b: i32) -> vec4<f32> {
  let n = dbNoise(p, DB_M0 + b, u32(b) + 17u);
  let a = dbSlope(mat);
  return vec4<f32>(n.x * dbLambda(b), n.yzw) * (a * 0.159155);
}
/** band b of the detail height at p for material mat, world units */
fn detailH(p: DPt, mat: u32, b: i32) -> f32 {
  return detailHG(p, mat, b).x;
}
