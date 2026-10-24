// ---- atlas/noise.wgsl ---------------------------------------------------
// Noise for the atlas (round 67): everything periodic on the torus the world
// is, so the world wraps without a seam. A periodic octave has an integer
// lattice period `per`; an fbm's octaves double it.

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hash2u(x: i32, y: i32, s: u32) -> u32 { return pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(s))); }
/** [0, 1) from a hash */
fn hf(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }

fn wrapi(i: vec2<i32>, per: vec2<i32>) -> vec2<i32> { return ((i % per) + per) % per; }

fn gradAt(i: vec2<i32>, per: vec2<i32>, s: u32) -> vec2<f32> {
  let w = wrapi(i, per);
  let a = hf(hash2u(w.x, w.y, s)) * 6.2831853;
  return vec2<f32>(cos(a), sin(a));
}

/** periodic gradient noise, about [-1, 1] */
fn pnoise(p: vec2<f32>, per: vec2<i32>, s: u32) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(gradAt(i, per, s), f);
  let b = dot(gradAt(i + vec2<i32>(1, 0), per, s), f - vec2<f32>(1.0, 0.0));
  let c = dot(gradAt(i + vec2<i32>(0, 1), per, s), f - vec2<f32>(0.0, 1.0));
  let d = dot(gradAt(i + vec2<i32>(1, 1), per, s), f - vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.414;
}

/** fbm on the torus: u in torus units ([0, 1) a turn), `base` lattice cells a turn at the first octave; about [-1, 1] */
fn pfbm(u: vec2<f32>, base: i32, oct: u32, s: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var per = max(base, 1);
  for (var o = 0u; o < oct; o++) {
    sum += amp * pnoise(u * f32(per), vec2<i32>(per), s + o * 1013u);
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;
}

/** ridged fbm (sharp crests), [0, 1] */
fn pridged(u: vec2<f32>, base: i32, oct: u32, s: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var per = max(base, 1);
  var w = 1.0;
  for (var o = 0u; o < oct; o++) {
    var v = 1.0 - abs(pnoise(u * f32(per), vec2<i32>(per), s + o * 977u));
    v *= v;
    sum += v * amp * w;
    w = clamp(v * 1.6, 0.0, 1.0);
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;
}

struct Wor {
  f1: f32,
  f2: f32,
  /** the nearest feature's cell, wrapped: its index in the period */
  id: u32,
  /** the nearest feature, in lattice units */
  near: vec2<f32>,
}

/** periodic cellular (Worley) noise: one jittered feature a lattice cell */
fn pworley(p: vec2<f32>, per: vec2<i32>, jit: f32, s: u32) -> Wor {
  let i = vec2<i32>(floor(p));
  let f = p - floor(p);
  var r: Wor;
  r.f1 = 1e9;
  r.f2 = 1e9;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = i + vec2<i32>(dx, dy);
      let w = wrapi(c, per);
      let h = hash2u(w.x, w.y, s);
      let o = vec2<f32>(hf(h), hf(pcg(h))) * jit + (1.0 - jit) * 0.5;
      let fp = vec2<f32>(f32(dx), f32(dy)) + o;
      let d = length(fp - f);
      if (d < r.f1) {
        r.f2 = r.f1;
        r.f1 = d;
        r.id = u32(w.y * per.x + w.x);
        r.near = vec2<f32>(i) + fp;
      } else if (d < r.f2) {
        r.f2 = d;
      }
    }
  }
  return r;
}

/** value noise in 3D, periodic in x and y (per) only; [-1, 1] */
fn vnoise3(p: vec3<f32>, per: vec2<i32>, s: u32) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  var c: array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    let o = vec3<i32>(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let w = wrapi(i.xy + o.xy, per);
    c[k] = hf(hash2u(w.x, w.y, s ^ pcg(bitcast<u32>(i.z + o.z)))) * 2.0 - 1.0;
  }
  let x0 = mix(mix(c[0], c[1], u.x), mix(c[2], c[3], u.x), u.y);
  let x1 = mix(mix(c[4], c[5], u.x), mix(c[6], c[7], u.x), u.y);
  return mix(x0, x1, u.z);
}

fn vfbm3(p: vec3<f32>, per: vec2<i32>, oct: u32, s: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var q = p;
  var pr = per;
  for (var o = 0u; o < oct; o++) {
    sum += amp * vnoise3(q, pr, s + o * 733u);
    norm += amp;
    amp *= 0.5;
    q *= 2.0;
    pr *= 2;
  }
  return sum / norm;
}

/** non-periodic hash noise for patterns (they live inside one region) */
fn snoise(p: vec2<f32>, s: u32) -> f32 { return pnoise(p, vec2<i32>(1 << 20), s); }
