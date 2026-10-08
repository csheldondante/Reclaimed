// ---- player wind field --------------------------------------------------------
// The wind the player paints by dragging (DECISIONS round 7: stronger, and it
// persists along the whole stroke). One texel per 2×2 columns, cells/s.
// Each tick: carry the field along itself (semi-Lagrangian), spread it a
// little to the neighbours, let it die down (e-folding ~3 s), then stamp the
// current stroke segments in (gusts[1..3]: x,y = segment end, gustDir.xy =
// direction, gustDir.z = segment length, z = radius, w = strength).
@group(0) @binding(16) var windOut: texture_storage_2d<rg32float, write>;

const DT_W: f32 = 1.0 / 60.0;
const DECAY_S: f32 = 3.0;
const MAX_W: f32 = 30.0;

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
  // advect: the gust rolls on in its own direction
  v = windField(c - v * DT_W);
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
    v = mix(v, dir * g.w, f * 0.35);
  }
  let m = length(v);
  if (m > MAX_W) { v *= MAX_W / m; }
  textureStore(windOut, t, vec4<f32>(v, 0.0, 0.0));
}
