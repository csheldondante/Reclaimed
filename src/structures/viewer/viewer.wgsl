// The structures viewer's host shader (src/structures/viewer/render.ts): a ground, the pieces (structmesh.wgsl), a sun
// with a shadow map, sky light, fog. Its own small renderer so the viewer opens fast on a phone; the game's renderer
// draws the same pieces with the same structmesh.wgsl and its own light (render.wgsl).

struct View {
  viewProj: mat4x4<f32>,
  lightProj: mat4x4<f32>,
  // xyz toward the sun, w night (0 day, 1 night)
  sun: vec4<f32>,
  // xyz the eye, w the fog's distance
  eye: vec4<f32>,
  sunCol: vec4<f32>,
  skyCol: vec4<f32>,
  // x: shadow map texel, y: show tile lines, z: seconds (round 120), w: the wind's strength
  misc: vec4<f32>,
};

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> spData: array<vec4<f32>>;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSamp: sampler_comparison;

fn hostNight() -> f32 { return V.sun.w; }
// (the viewer's ground is the plan's)
fn hostGround(xy: vec2<f32>, planned: f32) -> f32 { return planned; }
fn spFetch(i: u32) -> vec4<f32> { return spData[i]; }
// (round 120: a steady breeze from the west-south-west, its strength the viewer's wind slider)
fn hostWind(xy: vec2<f32>) -> vec2<f32> { return vec2<f32>(0.94, 0.34) * V.misc.w; }
fn hostTime() -> f32 { return V.misc.z; }

fn shadowAt(wpos: vec3<f32>, n: vec3<f32>) -> f32 {
  let p = V.lightProj * vec4<f32>(wpos + n * 0.06, 1.0);
  let uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  let d = p.z - 0.0015;
  let t = V.misc.x;
  var s = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(f32(i), f32(j)) * t, d);
    }
  }
  return s / 9.0;
}

fn light(wpos: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let sun = normalize(V.sun.xyz);
  let ndl = max(dot(n, sun), 0.0);
  let sh = select(0.0, shadowAt(wpos, n), ndl > 0.0);
  let sky = V.skyCol.rgb * (0.55 + 0.45 * n.z);
  let bounce = max(dot(n, normalize(vec3<f32>(-sun.x, -sun.y, 0.3))), 0.0) * vec3<f32>(0.4, 0.33, 0.25) * 0.35 * (1.0 - V.sun.w);
  return sky + bounce + V.sunCol.rgb * ndl * sh;
}

fn finish(c: vec3<f32>, wpos: vec3<f32>) -> vec4<f32> {
  let d = distance(wpos, V.eye.xyz);
  let fog = 1.0 - exp(-d / V.eye.w);
  var o = mix(c, V.skyCol.rgb * 1.6, fog * 0.55);
  // a gentle filmic curve
  o = o * (2.51 * o + 0.03) / (o * (2.43 * o + 0.59) + 0.14);
  return vec4<f32>(pow(clamp(o, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)), 1.0);
}

// ---- the pieces

struct PieceOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) info: vec4<u32>,
  @location(2) @interpolate(flat) base: vec3<f32>,
  @location(3) w: f32,
};

@vertex
fn vsPiece(@location(0) a: vec4<f32>, @builtin(instance_index) ii: u32) -> PieceOut {
  let sv = spVertex(a, ii);
  var o: PieceOut;
  o.pos = V.viewProj * vec4<f32>(sv.wpos, 1.0);
  o.wpos = sv.wpos;
  o.info = vec4<u32>(sv.part, sv.look, bitcast<u32>(sv.seed), 0u);
  o.base = sv.base;
  o.w = sv.w;
  return o;
}

@vertex
fn vsPieceShadow(@location(0) a: vec4<f32>, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  return V.lightProj * vec4<f32>(spVertex(a, ii).wpos, 1.0);
}

@fragment
fn fsPiece(in: PieceOut) -> @location(0) vec4<f32> {
  var n = normalize(cross(dpdx(in.wpos), dpdy(in.wpos)));
  if (dot(n, V.eye.xyz - in.wpos) < 0.0) { n = -n; }
  var sv: SpVert;
  sv.wpos = in.wpos;
  sv.w = in.w;
  sv.part = in.info.x;
  sv.look = in.info.y;
  sv.seed = bitcast<f32>(in.info.z);
  sv.base = in.base;
  let alb = spAlbedo(sv, n);
  if (sv.part == 20u) { return finish(spFlame(sv), in.wpos); }
  return finish(alb * light(in.wpos, n) + spEmit(sv), in.wpos);
}

// (round 120) the lights' pools: added over what's drawn (blend one + one), at night
struct PoolOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) info: vec4<f32>,
};

@vertex
fn vsPool(@location(0) a: vec4<f32>, @builtin(instance_index) ii: u32) -> PoolOut {
  let sv = spVertex(a, ii);
  var o: PoolOut;
  o.pos = V.viewProj * vec4<f32>(sv.wpos, 1.0);
  // (a hair toward the eye: over the ground it lies on)
  o.pos.z -= 0.0003 * o.pos.w;
  o.wpos = sv.wpos;
  o.info = spPoolInfo(ii);
  return o;
}

@fragment
fn fsPool(in: PoolOut) -> @location(0) vec4<f32> {
  return vec4<f32>(spPoolLight(in.wpos, in.info) * 0.8, 0.0);
}

// ---- the ground: a height grid (x, y, z, wetness/slope tint)

struct GroundOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) tint: f32,
};

@vertex
fn vsGround(@location(0) a: vec4<f32>) -> GroundOut {
  var o: GroundOut;
  o.pos = V.viewProj * vec4<f32>(a.xyz, 1.0);
  o.wpos = a.xyz;
  o.tint = a.w;
  return o;
}

@vertex
fn vsGroundShadow(@location(0) a: vec4<f32>) -> @builtin(position) vec4<f32> {
  return V.lightProj * vec4<f32>(a.xyz, 1.0);
}

@fragment
fn fsGround(in: GroundOut) -> @location(0) vec4<f32> {
  var n = normalize(cross(dpdx(in.wpos), dpdy(in.wpos)));
  if (n.z < 0.0) { n = -n; }
  let p = in.wpos.xy;
  let g = spN2(p * 0.08) * 0.6 + spN2(p * 0.5) * 0.3 + spN2(p * 3.0) * 0.1;
  var grass = mix(vec3<f32>(0.11, 0.2, 0.06), vec3<f32>(0.26, 0.34, 0.11), g);
  grass = mix(grass, vec3<f32>(0.36, 0.33, 0.2), smoothstep(0.62, 0.8, g) * 0.6);
  let rock = vec3<f32>(0.33, 0.31, 0.28) * (0.85 + 0.3 * spN2(p * 1.3 + in.wpos.z));
  let steep = smoothstep(0.82, 0.62, n.z);
  var c = mix(grass, rock, steep);
  // trodden earth near the town (tint); (round 120) water where the tint is 2 (the sea or a river at its level)
  c = mix(c, vec3<f32>(0.3, 0.25, 0.17), min(in.tint, 1.0) * 0.6);
  if (in.tint > 1.5) {
    let rip = spN2(p * 0.7 + vec2<f32>(V.misc.z * 0.3, 0.0)) * 0.5 + spN2(p * 2.3 - vec2<f32>(0.0, V.misc.z * 0.5)) * 0.5;
    c = mix(vec3<f32>(0.04, 0.12, 0.16), vec3<f32>(0.1, 0.24, 0.28), rip);
    n = normalize(vec3<f32>((rip - 0.5) * 0.15, 0.0, 1.0));
  }
  // tile lines (the viewer's overlay): drawn by the line pass
  return finish(c * light(in.wpos, n), in.wpos);
}

// ---- lines (tile outlines, nav links): x, y, z, colour index

struct LineOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) col: vec3<f32>,
};

@vertex
fn vsLine(@location(0) a: vec4<f32>) -> LineOut {
  var o: LineOut;
  o.pos = V.viewProj * vec4<f32>(a.xyz, 1.0);
  // (drawn a hair toward the eye: over the surfaces they outline)
  o.pos.z -= 0.0004 * o.pos.w;
  let k = u32(a.w);
  var c = vec3<f32>(1.0, 1.0, 1.0);
  if (k == 1u) { c = vec3<f32>(1.0, 0.85, 0.2); }
  if (k == 2u) { c = vec3<f32>(0.3, 0.9, 1.0); }
  if (k == 3u) { c = vec3<f32>(1.0, 0.35, 0.3); }
  if (k == 4u) { c = vec3<f32>(0.5, 1.0, 0.4); }
  if (k == 5u) { c = vec3<f32>(0.85, 0.5, 1.0); }
  o.col = c;
  return o;
}

@fragment
fn fsLine(in: LineOut) -> @location(0) vec4<f32> { return vec4<f32>(in.col, 1.0); }
