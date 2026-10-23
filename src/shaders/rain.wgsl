// ---- rain streaks -----------------------------------------------------------
// Purely visual. Each instance is a streak falling inside one storm's disc;
// position is a hash of the instance index and time, so nothing is stored.
// Terrain occludes streaks through the depth buffer.
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
};
@group(0) @binding(10) var<uniform> CAM: Camera;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) a: f32,
  // 1: a snowflake (round 50: a cold storm, common.wgsl airTempAt)
  @location(1) snow: f32,
};

const QUAD = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));

@vertex
fn vsRain(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0);
  o.a = 0.0;
  o.snow = 0.0;
  if (G.numStorms == 0u) { return o; }
  let si = ii % G.numStorms;
  let s = G.storms[si];
  let b = G.stormsB[si];
  let k = ii / G.numStorms;
  if (rand3(k, si, 3u) > s.w * (0.6 + 0.4 * b.z)) { return o; }
  let ang = rand3(k, si, 1u) * 6.2831853;
  let rad = sqrt(rand3(k, si, 2u)) * s.z * 0.9;
  let base = s.xy + vec2<f32>(cos(ang), sin(ang)) * rad * 1.3;
  if (stormDist(base, si) > 0.95) { return o; } // follow the storm's irregular outline
  // no cloud deck: streaks fade in from nothing as they fall from height,
  // so the land under a storm is seen through rain (DECISIONS round 5)
  // (snow where the air a little over the ground is freezing: slow flakes
  // that sway and blow along, not streaks)
  let snow = snowShare(airTempAt(10.0)) > rand3(k, si, 6u);
  let span = select(56.0, 40.0, snow);
  let speed = select(70.0 + rand3(k, si, 4u) * 25.0, 4.5 + rand3(k, si, 4u) * 3.0, snow);
  let phase = fract(G.time * speed / span + rand3(k, si, 5u));
  let z = span - phase * span;
  let slant = vec2<f32>(G.windX, G.windY) * 0.06;
  var bottom = vec3<f32>(base + slant * (span - z) * 0.05, z);
  var top = bottom + vec3<f32>(slant, 3.2);
  if (snow) {
    let sw = f32(k) * 1.7 + G.time * 1.3;
    bottom = vec3<f32>(base + vec2<f32>(G.windX, G.windY) * (span - z) / speed * 0.5 + vec2<f32>(sin(sw), cos(sw * 0.8)) * 0.5, z);
    top = bottom + vec3<f32>(0.0, 0.0, 0.16);
  }
  let cb = CAM.viewProj * vec4<f32>(bottom, 1.0);
  let ct = CAM.viewProj * vec4<f32>(top, 1.0);
  let dir = normalize((ct.xy - cb.xy) * CAM.viewport.xy);
  let perp = vec2<f32>(-dir.y, dir.x) / CAM.viewport.xy * 2.0 * select(0.9, 2.0, snow);
  let q = QUAD[vi];
  var c = mix(cb, ct, q.y);
  c = vec4<f32>(c.xy + perp * q.x, c.z, c.w);
  o.pos = c;
  o.a = select((1.0 - q.y * 0.75) * 0.22, 0.75, snow) * smoothstep(span, span - 26.0, z);
  o.snow = select(0.0, 1.0, snow);
  return o;
}

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) pick: vec2<u32>,
};

@fragment
fn fsRain(in: VOut) -> FOut {
  var o: FOut;
  o.color = vec4<f32>(mix(vec3<f32>(0.78, 0.82, 0.86), vec3<f32>(0.96, 0.97, 1.0), in.snow), in.a);
  o.pick = vec2<u32>(0u);
  return o;
}
