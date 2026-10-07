// ---- particles (drawing) -----------------------------------------------------
// One screen-aligned square per particle (pixel-art "sub-voxel" look); clouds
// are large soft puffs. Depth-tested against the world, not depth-writing.
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
};
struct Particle {
  p: vec4<f32>,
  v: vec4<f32>,
  m: vec4<u32>,
};
@group(0) @binding(3) var<storage, read> parts: array<Particle>;
@group(0) @binding(10) var<uniform> CAM: Camera;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) col: vec4<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) @interpolate(flat) soft: f32,
};

const CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0);
  let P = parts[ii];
  if (P.p.w <= 0.0) { return o; }
  let kind = P.m.x;
  let sr = f32(P.m.y & 0xffffu) / 65536.0;
  let sr2 = f32(P.m.y >> 16u) / 65536.0;
  var size = 0.16; // half-size in cells
  var col = vec4<f32>(0.62, 0.56, 0.45, 0.55);
  var soft = 0.0;
  let fade = clamp(P.p.w / 1.5, 0.0, 1.0);
  if (kind == 1u) { // dust: tan, darker/yellower when carrying pollution
    size = 0.2 + sr * 0.12;
    col = vec4<f32>(mix(vec3<f32>(0.86, 0.78, 0.62), vec3<f32>(0.55, 0.50, 0.22), clamp(P.v.w * 60.0, 0.0, 1.0)), 0.75);
  } else if (kind == 2u) { // litter: faded plastics, paper
    size = 0.28;
    let k = u32(sr * 5.0);
    var c = vec3<f32>(0.8, 0.78, 0.72);
    if (k == 1u) { c = vec3<f32>(0.42, 0.55, 0.68); } else if (k == 2u) { c = vec3<f32>(0.7, 0.36, 0.32); } else if (k == 3u) { c = vec3<f32>(0.45, 0.55, 0.38); }
    col = vec4<f32>(c * (0.75 + 0.25 * sin(G.time * 9.0 + sr * 30.0)), 1.0); // tumbling flicker
  } else if (kind == 3u) { // leaf
    size = 0.17;
    let c = mix(vec3<f32>(0.25, 0.45, 0.16), vec3<f32>(0.62, 0.48, 0.18), sr2 * sr2);
    col = vec4<f32>(c * (0.7 + 0.3 * abs(sin(G.time * 7.0 + sr * 50.0))), 1.0);
  } else if (kind == 4u) { col = vec4<f32>(0.3, 0.3, 0.3, 0.7); size = 0.12; }
  else if (kind == 5u) { col = vec4<f32>(0.64, 0.63, 0.6, 1.0); size = 0.14 + sr * 0.1; }
  else if (kind == 6u) { // cloud puff
    size = 6.0 + sr * 6.0;
    soft = 1.0;
    let life = P.p.w;
    let a = clamp(life / 2.0, 0.0, 1.0) * clamp((12.0 - life) / 2.0, 0.0, 1.0);
    col = vec4<f32>(mix(vec3<f32>(0.42, 0.44, 0.47), vec3<f32>(0.78, 0.79, 0.8), sr2), 0.34 * a);
  } else if (kind == 7u) { col = vec4<f32>(0.8, 0.86, 0.9, 0.7); size = 0.1; }
  else if (kind == 8u) { col = vec4<f32>(0.35, 0.34, 0.33, 0.35); size = 0.5 + sr; soft = 1.0; }
  else if (kind == 9u) { col = vec4<f32>(1.0, 0.6, 0.2, 1.0); size = 0.09; }
  else if (kind == 10u) { // bird: dark, wings flicker
    size = 0.22;
    let flap = 0.5 + 0.5 * sin(G.time * 18.0 + sr * 60.0);
    col = vec4<f32>(vec3<f32>(0.12, 0.11, 0.1), 1.0);
    size *= 0.6 + 0.6 * flap;
  }
  if (soft == 0.0) { col.a *= fade; }
  let c = CORNERS[vi];
  let center = CAM.viewProj * vec4<f32>(P.p.xyz, 1.0);
  // world-size square in screen space: viewport.z = px per world unit
  let px = max(size * CAM.viewport.z, select(1.0, 0.0, soft > 0.5));
  let ndc = c * px * 2.0 / CAM.viewport.xy;
  o.pos = vec4<f32>(center.xy + ndc, center.z - 0.0005, 1.0);
  o.col = col;
  o.uv = c;
  o.soft = soft;
  return o;
}

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) pick: u32,
};

@fragment
fn fs(in: VOut) -> FOut {
  var o: FOut;
  var a = in.col.a;
  if (in.soft > 0.5) {
    let r = length(in.uv);
    a *= smoothstep(1.0, 0.25, r) * (0.7 + 0.3 * vnoise(in.uv * 3.0 + vec2<f32>(G.time * 0.2)));
  }
  o.color = vec4<f32>(in.col.rgb, a);
  o.pick = 0u;
  return o;
}
