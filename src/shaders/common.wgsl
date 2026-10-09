// ---- common.wgsl -------------------------------------------------------
// Shared by every shader. Binding conventions (group 0):
//   0 = Globals (uniform)        — always present
//   1 = chunk table (storage)    — layers.wgsl
//   2 = material table (uniform) — materials.wgsl
//   3+ = per-shader buffers
// Keep in sync with src/sim/globals.ts.

// a cyclone (round 12; several at once since round 14): a = x, y, radius,
// strength × spin sign (0 = none); b = velocity x, y, dust-dropping rate as
// it dies, unused; spine = the funnel's nodes (Weather.spine): x, y, z, radius
struct CycloneU {
  a: vec4<f32>,
  b: vec4<f32>,
  spine: array<vec4<f32>, 6>,
};
const MAX_CYCLONES: u32 = 4u;

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
  // x: event count, y: structural collapse (0 off, 1 on, 2 damage only — the
  // sandbox's rigid bodies take the rest), z: lightning flash 0..1,
  // w: fine plants (1 = diorama-scale plants, the title screen)
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
  // per storm shape: three outline phases + elongation along travel
  stormsC: array<vec4<f32>, 4>,
  // x, y: prevailing wind integrated over time (cells) — advects gust patches
  // and ripples so they travel smoothly downwind; z: debris seeding boost;
  // w: difficulty 0 easy, 1 medium, 2 hard
  env: vec4<f32>,
  // dust storms: x, y, radius, strength (0 = none)
  dusts: array<vec4<f32>, 2>,
  // the cyclones (no cap on summoning them: round 14)
  cyclones: array<CycloneU, 4>,
};

/** Point on cyclone c's funnel spine at t in 0..1 (Catmull-Rom through the nodes); w = radius. */
fn spineAt(c: u32, t: f32) -> vec4<f32> {
  let u = clamp(t, 0.0, 1.0) * 5.0;
  let i = min(u32(floor(u)), 4u);
  let f = u - f32(i);
  let p0 = G.cyclones[c].spine[max(i, 1u) - 1u];
  let p1 = G.cyclones[c].spine[i];
  let p2 = G.cyclones[c].spine[i + 1u];
  let p3 = G.cyclones[c].spine[min(i + 2u, 5u)];
  let f2 = f * f;
  let f3 = f2 * f;
  return 0.5 * ((2.0 * p1) + (-p0 + p2) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * f3);
}

/** 0..1 how deep in a cyclone p is (1 inside an eye wall, 0 beyond ~2 radii). */
fn cycloneAt(p: vec2<f32>) -> f32 {
  var k = 0.0;
  for (var i = 0u; i < MAX_CYCLONES; i++) {
    let c = G.cyclones[i].a;
    if (c.w == 0.0) { continue; }
    k = max(k, abs(c.w) * smoothstep(2.0, 0.8, length(p - c.xy) / c.z));
  }
  return k;
}

const EV_LIGHTNING: u32 = 1u;
// a tap on masonry: small damage to the interval at height evZ(e)
const EV_CHIP: u32 = 2u;
// a tap on a tree: perched birds within the radius take off
const EV_SCARE: u32 = 3u;
// a tap on the ground: growth boost (or a wilt where nothing can take)
const EV_GROW: u32 = 4u;
// eventKind packs kind (low 4 bits) and a z height (above): kind + 16·z
fn evKind(e: u32) -> u32 { return u32(G.eventKind[e]) & 15u; }
fn evZ(e: u32) -> u32 { return u32(G.eventKind[e]) >> 4u; }
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
/**
 * Normalised distance from storm i's centre (1 = its edge). Storms are not
 * discs: the outline wobbles with three slowly drifting angular harmonics and
 * stretches along the direction of travel. Mirrored on the CPU in
 * src/weather/weather.ts (stormDist).
 */
fn stormDist(p: vec2<f32>, i: u32) -> f32 {
  let s = G.storms[i];
  let c = G.stormsC[i];
  let v = G.stormsB[i].xy;
  let fwd = select(vec2<f32>(1.0, 0.0), normalize(v), length(v) > 1e-3);
  let o = p - s.xy;
  let along = dot(o, fwd) / c.w;
  let across = dot(o, vec2<f32>(-fwd.y, fwd.x));
  let th = atan2(across, along);
  // the outline's lobes drift slowly (CPU twin: Weather.stormDist)
  let t = G.time * 0.015;
  let lobe = 1.0 + 0.22 * sin(2.0 * th + c.x + t) + 0.15 * sin(3.0 * th + c.y - t * 1.3) + 0.08 * sin(5.0 * th + c.z + t * 0.7);
  return length(vec2<f32>(along, across)) / (s.z * lobe);
}

fn stormCover(p: vec2<f32>) -> f32 {
  var c = 0.0;
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = stormDist(p, i);
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
    let d = stormDist(p, i);
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
  for (var i = 0u; i < G.numStorms; i++) {
    let s = G.storms[i];
    let d = stormDist(p, i);
    // the ragged edge lives in the storm's own frame (it travels with the
    // storm and evolves slowly); scrolling it by time × wind made the shadow
    // jump whenever the wind shifted (round 10)
    let n = fbm2((p - s.xy) * 0.035 + f32(i) * 7.0 + vec2<f32>(G.time * 0.01, 0.0));
    let edge = 1.08 - d + (n - 0.5) * 0.7;
    c = max(c, s.w * smoothstep(0.0, 0.05, edge));
  }
  return c;
}

/**
 * Fair-weather clouds (round 10): large, soft, *light* shadows drifting with
 * the prevailing wind (advected by the integrated wind, a little faster than
 * the ground wind), so the sky shows which way the wind blows. 0..1 cover;
 * the renderer dims sunlight by ~15 % under them. They are not storms: no
 * rain, no lightning.
 */
fn fairCloud(p: vec2<f32>) -> f32 {
  let q = (p - G.env.xy * 1.3) * 0.022 + vec2<f32>(G.time * 0.004, 31.0);
  return smoothstep(0.47, 0.6, fbm2(q));
}

// ---- wind field (shared contract: particles, sway, dust pickup, fire) ----
// Analytic: prevailing wind + storm swirl/outflow + dust storms + player
// gusts + cursor breeze + gentle turbulence.
//
// Every noise term is sampled in a frame that moves with the integrated
// prevailing wind (G.env.xy), so gust patches roll smoothly downwind instead
// of flickering. (Before, noise was scrolled by time along fixed axes and
// phases were time × a varying speed, which read as jitter.)
fn windDrift(p: vec2<f32>) -> vec2<f32> { return p - G.env.xy; }

/** Smooth 0..1 gust patches travelling with the wind (also drives grass and water ripples). */
fn gustField(p: vec2<f32>) -> f32 {
  let q = windDrift(p) * 0.045;
  return fbm2(q + vec2<f32>(G.time * 0.02, 0.0));
}

// The wind field (windfield.wgsl): rgba32float, one texel per 2×2 columns.
//   rg = the wind the player has painted (relaxes back to zero)
//   ba = the whole wind there: the map's own wind + the painted wind.
// Everything that feels wind reads ba (storms too, via a CPU readback); only
// pipelines whose entry points sample the wind bind it (binding 15).
@group(0) @binding(15) var windTex: texture_2d<f32>;

/** Bilinear sample of the wind texture (all four channels). */
fn windSample(p: vec2<f32>) -> vec4<f32> {
  let dims = vec2<i32>(textureDimensions(windTex));
  let t = p * 0.5 - 0.5;
  let i0 = vec2<i32>(floor(t));
  let f = fract(t);
  let a = textureLoad(windTex, clamp(i0, vec2<i32>(0), dims - 1), 0);
  let b = textureLoad(windTex, clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), dims - 1), 0);
  let c = textureLoad(windTex, clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), dims - 1), 0);
  let d = textureLoad(windTex, clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), dims - 1), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** The painted part of the wind (cells/s). */
fn windField(p: vec2<f32>) -> vec2<f32> { return windSample(p).xy; }

/**
 * The map's own wind, before the player touches it: prevailing wind in
 * advected gust patches, dust storms, small eddies. Evaluated by the wind
 * field system; everyone else reads the field.
 */
fn mapWind(p: vec2<f32>) -> vec2<f32> {
  let prevail = vec2<f32>(G.windX, G.windY);
  let gf = gustField(p);
  // a steady flow one way with gentle gust patches (round 10)
  var w = prevail * (0.8 + 0.4 * gf);
  for (var i = 0u; i < 2u; i++) {
    let d = G.dusts[i];
    if (d.w <= 0.0) { continue; }
    let r = length(p - d.xy) / d.z;
    if (r < 1.6) {
      let dir = prevail / max(length(prevail), 1e-3);
      w += dir * d.w * smoothstep(1.4, 0.3, r) * (0.5 + gf);
    }
  }
  // small eddies, carried with the wind and slowly evolving
  let q = windDrift(p) * 0.07;
  let tn = G.time * 0.08;
  let turb = vec2<f32>(vnoise(q + vec2<f32>(tn, 0.0)), vnoise(q + vec2<f32>(0.0, tn) + 50.0)) - 0.5;
  return w + turb * 0.8;
}

/** Wind felt at a point: the wind field + storm swirl + the cursor/tap breeze. */
// Drifts (drift.wgsl): loose dust depth per column (.x), dust lost to the
// wind this pass (.y). A texture so it doesn't use a storage slot; bound at 17
// by the pipelines that read it.
@group(0) @binding(17) var driftTex: texture_2d<f32>;

/** Depth of drifted dust on column q (0 off the map). */
fn driftAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  return textureLoad(driftTex, q, 0).x;
}

// The sandbox brush state per column (edit.wgsl writes it; the particle
// system reads it to show poured grains falling). Bound at 18 by those two.
@group(0) @binding(18) var editTex: texture_2d<f32>;
const POUR_FALL: f32 = 0.8; // s from release to landing (grains drop ~12 cells)
const POUR_RATE: f32 = 4.0; // cells/s a pour lands at

fn windAt(p: vec3<f32>) -> vec2<f32> {
  var w = windSample(p.xy).zw;
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
  let g0 = G.gusts[0];
  if (g0.w > 0.0) {
    let d = length(p.xy - g0.xy) / g0.z;
    w += G.gustDir[0].xy * g0.w * exp(-d * d * 2.0);
  }
  // the cyclones: fierce vortices (peak ~26 cells/s at the eye wall) that
  // pull a little inward; each carries everything it spins along with it
  for (var i = 0u; i < MAX_CYCLONES; i++) {
    let cy = G.cyclones[i].a;
    if (cy.w == 0.0) { continue; }
    let o = p.xy - cy.xy;
    let dist = max(length(o), 1e-3);
    let r = dist / cy.z;
    if (r < 3.5) {
      let tang = vec2<f32>(-o.y, o.x) / dist * sign(cy.w);
      // tight: full strength at the eye wall, fading fast beyond it (a wide
      // profile lifted a ring of dust that hid the funnel)
      let prof = r * exp((1.0 - r * r) * 0.5);
      w = w * (1.0 - 0.6 * smoothstep(1.5, 0.5, r)) + (tang * 26.0 - o / dist * 4.0) * abs(cy.w) * prof + G.cyclones[i].b.xy * smoothstep(2.0, 0.5, r);
    }
  }
  return w;
}

/** Hostility 0..1 from wilt.x (which carries +2 when the column is established). */
fn wiltHostility(x: f32) -> f32 { return select(x, x - 2.0, x >= 2.0); }

// ---- litter stripping (shared contract: material system ↔ particles) ----
// Strong wind tears loose litter off the ground one cell at a time. The
// material system removes the cell at tick t; the particle system evaluates
// the same roll for tick t + 1 while the litter is still there and throws up
// the flying scrap — so what you see leave is what was removed.
const MAT_LITTER: u32 = 18u;
const MAT_ASH_C: u32 = 17u;
/** Loose enough for a strong wind to strip a cell at a time: litter, ash (round 10). */
fn isStrippable(m: u32) -> bool { return m == MAT_LITTER || m == MAT_ASH_C; }
fn litterStrip(p: vec2<i32>, tick: u32) -> bool {
  let ws = length(windAt(vec3<f32>(vec2<f32>(p) + 0.5, 0.0)));
  return ws > 5.0 && rand3(u32(p.x), u32(p.y), tick ^ 0x1177u) < (ws - 5.0) * 0.004;
}
