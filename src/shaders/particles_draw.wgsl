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
  // x: 1 for birds (V-shaped wings), y: wing angle
  @location(3) @interpolate(flat) shapeInfo: vec2<f32>,
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
  if (kind == 1u && P.m.w == 1u) { // grime: dark tarry clumps with sickly flecks
    size = 0.19 + sr * 0.09;
    col = vec4<f32>(mix(vec3<f32>(0.11, 0.1, 0.08), vec3<f32>(0.34, 0.31, 0.12), sr2 * sr2), 0.95);
  } else if (kind == 1u) { // dust: tan, darker/yellower when carrying pollution
    size = 0.16 + sr * 0.1;
    col = vec4<f32>(mix(vec3<f32>(0.78, 0.71, 0.58), vec3<f32>(0.52, 0.48, 0.38), clamp(P.v.w * 60.0, 0.0, 1.0)), 0.7);
    // settled dust lies faintly on the ground
    if ((P.m.z & 1u) != 0u) { col = vec4<f32>(col.rgb * 0.85, 0.3); size *= 0.8; }
  } else if (kind == 2u) { // litter: faded plastics, paper
    size = 0.28;
    let k = u32(sr * 5.0);
    var c = vec3<f32>(0.8, 0.78, 0.72);
    if (k == 1u) { c = vec3<f32>(0.42, 0.55, 0.68); } else if (k == 2u) { c = vec3<f32>(0.7, 0.36, 0.32); } else if (k == 3u) { c = vec3<f32>(0.45, 0.55, 0.38); }
    col = vec4<f32>(c * (0.75 + 0.25 * sin(G.time * 9.0 + sr * 30.0)), 1.0); // tumbling flicker
  } else if (kind == 3u) { // leaf
    size = 0.17;
    var c = mix(vec3<f32>(0.25, 0.45, 0.16), vec3<f32>(0.62, 0.48, 0.18), sr2 * sr2);
    if (sr2 > 0.995) { c = mix(vec3<f32>(0.42, 0.31, 0.17), vec3<f32>(0.55, 0.42, 0.24), sr); } // dead, dry flakes
    col = vec4<f32>(c * (0.7 + 0.3 * abs(sin(G.time * 7.0 + sr * 50.0))), 1.0);
  } else if (kind == 4u) { col = vec4<f32>(0.3, 0.3, 0.3, 0.7); size = 0.12; }
  else if (kind == 5u) { col = vec4<f32>(0.64, 0.63, 0.6, 1.0); size = 0.14 + sr * 0.1; }
  else if (kind == 6u) { // cloud puff
    size = 3.5 + sr * 5.5;
    soft = 1.0;
    let life = P.p.w;
    let a = clamp(life / 2.0, 0.0, 1.0) * clamp((12.0 - life) / 2.0, 0.0, 1.0);
    // thin: the deck sits high and you look through it at the land
    col = vec4<f32>(mix(vec3<f32>(0.42, 0.44, 0.47), vec3<f32>(0.8, 0.81, 0.82), sr2), 0.075 * a);
  } else if (kind == 7u) { col = vec4<f32>(0.8, 0.86, 0.9, 0.7); size = 0.1; }
  else if (kind == 8u && P.m.w == 1u) { // oil smoke: a big dark lingering cloud
    let age = clamp(1.0 - P.p.w / 40.0, 0.0, 1.0);
    col = vec4<f32>(vec3<f32>(0.14, 0.13, 0.12) + age * 0.1, 0.3 * clamp(P.p.w / 3.0, 0.0, 1.0) * clamp(age * 8.0, 0.0, 1.0));
    size = 1.2 + age * 2.6 + sr * 1.2;
    soft = 1.0;
  }
  else if (kind == 8u) { // smoke: grows and thins as it rises
    let age = clamp(1.0 - P.p.w / 11.0, 0.0, 1.0);
    col = vec4<f32>(vec3<f32>(0.22, 0.21, 0.2) + age * 0.15, 0.45 * (1.0 - age) * clamp(P.p.w, 0.0, 1.0));
    size = 0.6 + age * 2.5 + sr;
    soft = 1.0;
  }
  else if (kind == 12u) { // flame tongue: yellow core to red tip as it burns out
    let t = clamp(P.p.w / 0.9, 0.0, 1.0);
    col = vec4<f32>(mix(vec3<f32>(0.9, 0.25, 0.05), vec3<f32>(1.0, 0.85, 0.35), t), 0.9);
    size = 0.18 + 0.22 * t;
  }
  else if (kind == 9u) { col = vec4<f32>(1.0, 0.6, 0.2, 1.0); size = 0.09; }
  else if (kind == 11u) { // firefly: unlit glow, pulsing
    size = 0.13;
    let glow = 0.5 + 0.5 * sin(G.time * 3.0 + sr * 40.0);
    col = vec4<f32>(vec3<f32>(0.85, 1.0, 0.45) * (0.6 + 0.8 * glow), glow);
  }
  else if (kind == 13u) { // deer: warm brown, longer than tall
    size = 0.3;
    col = vec4<f32>(mix(vec3<f32>(0.42, 0.28, 0.16), vec3<f32>(0.55, 0.38, 0.22), sr), 1.0);
  }
  else if (kind == 10u) { // bird: white, V-shaped wings that flap
    size = 0.34;
    col = vec4<f32>(0.95, 0.95, 0.92, 1.0);
  }
  else if (kind == 15u) { // dust haze kicked up by strong wind: grows and thins
    let age = clamp(1.0 - P.p.w / 10.0, 0.0, 1.0);
    size = 1.6 + age * 3.0 + sr * 1.5;
    soft = 1.0;
    col = vec4<f32>(mix(vec3<f32>(0.74, 0.65, 0.5), vec3<f32>(0.6, 0.53, 0.42), sr2), 0.2 * clamp(P.p.w / 2.0, 0.0, 1.0) * clamp(age * 6.0, 0.0, 1.0));
  }
  else if (kind == 16u) { // seed fluff: soft cream, a touch luminous so it reads in flight
    size = 0.11 + sr * 0.05;
    col = vec4<f32>(vec3<f32>(0.97, 0.95, 0.86) * (0.85 + 0.15 * sin(G.time * 6.0 + sr * 40.0)), 0.95);
  }
  else if (kind == 17u) { // grow-tap: green-gold sparkle (it took) or a brown fleck (it won't)
    size = 0.1;
    let t = clamp(P.p.w / 1.5, 0.0, 1.0);
    col = select(vec4<f32>(mix(vec3<f32>(0.55, 0.9, 0.35), vec3<f32>(1.0, 0.95, 0.55), sr), t), vec4<f32>(0.42, 0.3, 0.14, t), P.m.w == 1u);
  }
  else if (kind == 20u) { // cyclone funnel puff: dusty grey-tan, thicker low down
    let h = P.v.y;
    size = 0.35 + h * 0.06 + sr * 0.15;
    soft = 1.0;
    col = vec4<f32>(mix(vec3<f32>(0.34, 0.3, 0.25), vec3<f32>(0.5, 0.45, 0.38), sr2), 0.8 * clamp(1.0 - h / 20.0, 0.3, 1.0) * clamp(h * 2.0, 0.0, 1.0));
  }
  else if (kind == 19u) { // glow: a soft light that swells and fades
    let age = clamp(1.0 - P.p.w / 1.4, 0.0, 1.0);
    size = 1.2 + age * 1.6;
    soft = 1.0;
    let c = select(vec3<f32>(0.85, 1.0, 0.55), vec3<f32>(0.75, 0.88, 1.0), P.m.w == 1u);
    col = vec4<f32>(c, 0.32 * clamp(P.p.w / 0.6, 0.0, 1.0) * clamp(age * 8.0, 0.0, 1.0));
  }
  else if (kind == 18u) { // petal: flower colours, fluttering
    size = 0.1;
    let fv = sr2;
    var c = vec3<f32>(0.92, 0.9, 0.82);
    if (fv > 0.75) { c = vec3<f32>(0.95, 0.8, 0.25); } else if (fv > 0.5) { c = vec3<f32>(0.62, 0.48, 0.82); } else if (fv > 0.3) { c = vec3<f32>(0.85, 0.35, 0.3); }
    col = vec4<f32>(c * (0.75 + 0.25 * abs(sin(G.time * 8.0 + sr * 50.0))), 1.0);
  }
  else if (kind == 14u) { // rabbit: small, sandy brown
    size = 0.17;
    col = vec4<f32>(mix(vec3<f32>(0.5, 0.38, 0.26), vec3<f32>(0.6, 0.5, 0.38), sr), 1.0);
  }
  if (soft == 0.0) { col.a *= fade; }
  if (kind != 9u && kind != 11u && kind != 12u && kind != 17u && kind != 19u) { col = vec4<f32>(col.rgb * mix(1.0, 0.22, G.sky.w) + vec3<f32>(0.5, 0.55, 0.65) * G.misc.z, col.a); }
  // perched birds sit with folded wings
  let perched = kind == 10u && P.m.w == 2u;
  if (perched) { size = 0.24; }
  let c = CORNERS[vi];
  let center = CAM.viewProj * vec4<f32>(P.p.xyz, 1.0);
  // world-size square in screen space: viewport.z = px per world unit
  let px = max(size * CAM.viewport.z, select(1.0, 0.0, soft > 0.5));
  var shape = vec2<f32>(1.0);
  if (kind == 13u) { shape = vec2<f32>(1.7, 0.9); }
  if (kind == 14u) { shape = vec2<f32>(1.3, 1.0); }
  if (kind == 10u) { shape = vec2<f32>(1.6, 0.8); }
  let ndc = c * shape * px * 2.0 / CAM.viewport.xy;
  o.pos = vec4<f32>(center.xy + ndc, center.z - 0.0005, 1.0);
  o.col = col;
  o.uv = c;
  o.soft = soft;
  o.shapeInfo = vec2<f32>(select(0.0, 1.0, kind == 10u), select(sin(G.time * 12.0 + sr * 60.0), 0.35, perched));
  return o;
}

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) pick: vec2<u32>,
};

@fragment
fn fs(in: VOut) -> FOut {
  var o: FOut;
  var a = in.col.a;
  if (in.shapeInfo.x > 0.5) {
    // a 'V' whose wing angle flaps: |y − |x|·k| thin
    let k = in.shapeInfo.y * 0.9;
    if (abs(in.uv.y + abs(in.uv.x) * k) > 0.32) { discard; }
  }
  if (in.soft > 0.5) {
    let r = length(in.uv);
    // lumpy, broken-up puffs rather than discs
    let n = vnoise(in.uv * 2.5 + vec2<f32>(G.time * 0.15)) * 0.6 + vnoise(in.uv * 6.0 - vec2<f32>(G.time * 0.1)) * 0.4;
    a *= smoothstep(1.0, 0.2, r) * smoothstep(0.35, 0.7, n + (1.0 - r) * 0.35);
  }
  o.color = vec4<f32>(in.col.rgb, a);
  o.pick = vec2<u32>(0u);
  return o;
}
