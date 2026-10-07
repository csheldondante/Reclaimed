// ---- common.wgsl -------------------------------------------------------
// Shared by every shader. Binding conventions (group 0):
//   0 = Globals (uniform)        — always present
//   1 = chunk table (storage)    — layers.wgsl
//   2 = material table (uniform) — materials.wgsl
//   3+ = per-shader buffers
// Keep in sync with src/sim/globals.ts.

struct Globals {
  mapW: u32, mapH: u32, tick: u32, chunkSize: u32,
  chunksX: u32, zMax: u32, numStorms: u32, seed: u32,
  time: f32, dt: f32, windX: f32, windY: f32,
  sunX: f32, sunY: f32, sunZ: f32, pollution: f32,
  // per storm: x, y, radius, intensity(0..1)
  storms: array<vec4<f32>, 4>,
  // per storm: velocity x, y, downpour boost, lightning flash 0..1
  stormsB: array<vec4<f32>, 4>,
  // one-tick world events: x, y, radius, strength
  events: array<vec4<f32>, 4>,
  // per event kind (EV_*), as f32
  eventKind: vec4<f32>,
  // x: event count, y: structural collapse enabled (0/1), z: lightning flash 0..1, w: unused
  misc: vec4<f32>,
  // wind impulses (player gusts, cursor breeze): x, y, radius, strength
  gusts: array<vec4<f32>, 4>,
  // per gust: direction x, y (unit), falloff shape, unused
  gustDir: array<vec4<f32>, 4>,
  // sky / day-night: rgb ambient sky colour, w = night factor 0..1
  sky: vec4<f32>,
  // rgb sun colour × intensity, w = time of day 0..1
  sunCol: vec4<f32>,
  // life lens around the cursor: x, y, radius, strength 0..1 (0 = off)
  lens: vec4<f32>,
};

const EV_LIGHTNING: u32 = 1u;
fn numEvents() -> u32 { return u32(G.misc.x); }

@group(0) @binding(0) var<uniform> G: Globals;

const DIRS = array<vec2<i32>, 4>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(0, -1));

fn colIdx(x: u32, y: u32) -> u32 { return y * G.mapW + x; }
fn colIdxI(p: vec2<i32>) -> u32 { return u32(p.y) * G.mapW + u32(p.x); }
fn inMap(p: vec2<i32>) -> bool { return p.x >= 0 && p.y >= 0 && p.x < i32(G.mapW) && p.y < i32(G.mapH); }
fn clampCell(p: vec2<i32>) -> vec2<i32> { return clamp(p, vec2<i32>(0), vec2<i32>(i32(G.mapW) - 1, i32(G.mapH) - 1)); }

// ---- interval packing (see src/world/layout.ts) ----
fn ivZ0(v: u32) -> u32 { return v & 0xffu; }
fn ivZ1(v: u32) -> u32 { return (v >> 8u) & 0xffu; }
fn ivMat(v: u32) -> u32 { return (v >> 16u) & 0xffu; }
fn ivAux(v: u32) -> u32 { return v >> 24u; }
fn ivPack(z0: u32, z1: u32, mat: u32, aux: u32) -> u32 {
  return (z0 & 0xffu) | ((z1 & 0xffu) << 8u) | ((mat & 0xffu) << 16u) | ((aux & 0xffu) << 24u);
}

// ---- surface packing (written by the surface system) ----
// bits 0..7 top z, 8..15 top material, 16..23 valid slot count
fn sfZ(s: u32) -> u32 { return s & 0xffu; }
fn sfMat(s: u32) -> u32 { return (s >> 8u) & 0xffu; }

// ---- hashing / noise ----
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hash3(x: u32, y: u32, z: u32) -> u32 { return pcg(x ^ pcg(y ^ pcg(z))); }
fn rand3(x: u32, y: u32, z: u32) -> f32 { return f32(hash3(x, y, z) >> 8u) / 16777216.0; }
fn randv(p: vec3<i32>) -> f32 { return rand3(bitcast<u32>(p.x), bitcast<u32>(p.y), bitcast<u32>(p.z)); }

fn vnoise(p: vec2<f32>) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = randv(vec3<i32>(i, 911));
  let b = randv(vec3<i32>(i + vec2<i32>(1, 0), 911));
  let c = randv(vec3<i32>(i + vec2<i32>(0, 1), 911));
  let d = randv(vec3<i32>(i + vec2<i32>(1, 1), 911));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm2(p: vec2<f32>) -> f32 {
  return vnoise(p) * 0.55 + vnoise(p * 2.03 + 17.0) * 0.3 + vnoise(p * 4.1 + 41.0) * 0.15;
}

// ---- weather fields (analytic from storm uniforms; see src/weather) ----
fn stormCover(p: vec2<f32>) -> f32 {
  var c = 0.0;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = length(p - s.xy) / s.z;
    c = max(c, s.w * smoothstep(1.25, 0.55, d));
  }
  return c;
}

/** Rain intensity 0..~2 at a world position. */
fn rainAt(p: vec2<f32>) -> f32 {
  var r = 0.0;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let b = G.stormsB[i];
    let d = length(p - s.xy) / s.z;
    let n = fbm2(p * 0.045 + vec2<f32>(G.time * 0.05, -G.time * 0.03) + f32(i) * 13.0);
    r += s.w * (1.0 + b.z) * smoothstep(1.0, 0.35, d) * (0.45 + 0.9 * n);
  }
  return r;
}

/**
 * Cloud shadow 0..1: one ragged-edged cloud mass per storm, drifting with the
 * wind. Deliberately crisp-edged (narrow smoothstep) so storms read clearly
 * from above even though we never render the cloud itself.
 */
fn cloudShade(p: vec2<f32>) -> f32 {
  var c = 0.0;
  let drift = vec2<f32>(G.time * G.windX, G.time * G.windY) * 0.02;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = length(p - s.xy) / s.z;
    let n = fbm2(p * 0.035 + drift + f32(i) * 7.0);
    let edge = 1.08 - d + (n - 0.5) * 0.7;
    c = max(c, s.w * smoothstep(0.0, 0.05, edge));
  }
  return c;
}

// ---- wind field (shared contract: particles, sway, dust pickup, fire) ----
// Analytic: prevailing wind + storm swirl/outflow + player gusts + cursor
// breeze + gentle turbulence. Stronger with height above the ground.
fn windAt(p: vec3<f32>) -> vec2<f32> {
  var w = vec2<f32>(G.windX, G.windY);
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = p.xy - s.xy;
    let r = length(d) / s.z;
    if (r < 2.0) {
      let t = vec2<f32>(-d.y, d.x) / max(length(d), 0.001);
      let out = d / max(length(d), 0.001);
      w += (t * 2.5 + out * 1.2) * s.w * exp(-r * r * 1.5) * r * 2.0;
    }
  }
  for (var i = 0u; i < 4u; i++) {
    let g = G.gusts[i];
    if (g.w <= 0.0) { continue; }
    let d = length(p.xy - g.xy) / g.z;
    w += G.gustDir[i].xy * g.w * exp(-d * d * 2.0);
  }
  let tn = G.time * 0.35;
  let turb = vec2<f32>(vnoise(p.xy * 0.05 + vec2<f32>(tn, 0.0)), vnoise(p.xy * 0.05 + vec2<f32>(0.0, tn) + 50.0)) - 0.5;
  w = w * (0.75 + 0.5 * vnoise(p.xy * 0.03 - vec2<f32>(tn * 0.7))) + turb * 2.0;
  return w;
}
