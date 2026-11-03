// ---- standing burned trees (round 128, `treegen`; the user: "Leafless and burned could also be useful states") ----
// snag.x per column: 1 a wood the fire burned stands there charred (decaying slowly: the snags fall in time), 0 none.
// Set where the fire burns a woodland column (succession 3+), cleared when the wood regrows past 3.6 (a living tree
// stands there again) or the snag has fallen. vegprep.wgsl draws a slot's tree there in its burned state; the flora
// plan's CPU mirror (api/plants.ts) reads it too. Ping-pong: in (sampled) → out (storage), copied back by the system.
@group(0) @binding(3) var<storage, read> fire: array<f32>;
@group(0) @binding(4) var<storage, read> veg: array<f32>;
@group(0) @binding(60) var snagIn: texture_2d<f32>;
@group(0) @binding(61) var snagOut: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  // (round 128: the texel of the column — texCol: the window's pages, as the streamer moves them; raw id.xy scrambled
  // the snags once the window slid)
  let tc = texCol(vec2<i32>(id.xy));
  var s = textureLoad(snagIn, tc, 0).x;
  let v = veg[i];
  if (fire[i] > 0.15 && v >= 3.0) {
    s = 1.0;
  } else if (s > 0.0) {
    // (a wood grown back: a living tree again; else the snag weathers and falls, ~a season of play at 1x)
    if (v >= 3.6) { s = 0.0; } else { s = max(0.0, s - 0.00004 * simStep()); }
  }
  textureStore(snagOut, tc, vec4<f32>(s, 0.0, 0.0, 0.0));
}
