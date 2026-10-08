// ---- player wind field --------------------------------------------------------
// The wind the player paints by dragging, on top of the map's own wind
// (windAt adds the two): it blends slowly back to the map wind by decaying
// to zero (e-folding ~7 s). One texel per 2×2 columns, cells/s.
// Each tick: carry the field along itself (semi-Lagrangian), spread it a
// little, let it relax, then add the current stroke segments (gusts[1..3]:
// x,y = segment end, gustDir.xy = direction, gustDir.z = segment length,
// z = radius, w = wind one pass adds). Passes stack (DECISIONS round 8): one
// pass ≈ a breeze, two a gust, three a gale. The add is scaled by segment
// length / stroke width so a pass adds the same whatever its speed.
@group(0) @binding(16) var windOut: texture_storage_2d<rg32float, write>;

const DT_W: f32 = 1.0 / 60.0;
const DECAY_S: f32 = 7.0;
const MAX_W: f32 = 24.0;

fn texAt(t: vec2<i32>) -> vec2<f32> {
  let dims = vec2<i32>(textureDimensions(windTex));
  if (any(t < vec2<i32>(0)) || any(t >= dims)) { return vec2<f32>(0.0); }
  return textureLoad(windTex, t, 0).xy;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = vec2<u32>(textureDimensions(windTex));
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let t = vec2<i32>(id.xy);
  let c = (vec2<f32>(t) + 0.5) * 2.0; // world position of this texel
  var v = texAt(t);
  // advect: the gust drifts on in its own direction, but slowly (30 % of its
  // speed) so painted wind stays roughly where it was painted
  v = windField(c - v * DT_W * 0.3);
  // spread
  let avg = (texAt(t + vec2<i32>(1, 0)) + texAt(t - vec2<i32>(1, 0)) + texAt(t + vec2<i32>(0, 1)) + texAt(t - vec2<i32>(0, 1))) * 0.25;
  v = mix(v, avg, 0.06);
  // die down
  v *= exp(-DT_W / DECAY_S);
  // stamp the strokes being drawn right now
  for (var k = 1u; k < 4u; k++) {
    let g = G.gusts[k];
    if (g.w <= 0.0) { continue; }
    let dir = G.gustDir[k].xy;
    let len = G.gustDir[k].z;
    let a = g.xy - dir * len;
    let s = clamp(dot(c - a, dir), 0.0, len);
    let d = length(c - (a + dir * s));
    let f = smoothstep(g.z, g.z * 0.35, d);
    v += dir * g.w * f * min(1.0, len / (1.3 * g.z));
  }
  let m = length(v);
  if (m > MAX_W) { v *= MAX_W / m; }
  textureStore(windOut, t, vec4<f32>(v, 0.0, 0.0));
}
