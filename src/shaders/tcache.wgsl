// ---- the terrain's cached layer (perfopt, ?tcache=N; renderer.ts encodeTerrainCache) ----------------------
// The terrain (the field mesh, deferred: G-buffer and resolve) drawn every Nth frame into a layer a margin
// larger than the screen; between, the camera is moved by whole pixels of it (snapped) and this full-screen
// draw copies the layer in, moved by the camera's shift, with its depth (moved by the camera's along the view)
// and its picks; what's not terrain (plants, water, bodies, particles) draws over it as before.
struct CompOut {
  @location(0) color: vec4<f32>,
  @location(1) pick: vec2<u32>,
  @builtin(frag_depth) depth: f32,
};
@group(0) @binding(0) var tColor: texture_2d<f32>;
@group(0) @binding(1) var tPick: texture_2d<u32>;
@group(0) @binding(2) var tDepth: texture_2d<f32>;
// shift: the screen's pixels the layer's content has moved since it was drawn; dz: the depth's change; m: the margin (px)
struct TC { shift: vec2<f32>, dz: f32, m: f32 };
@group(0) @binding(3) var<uniform> TCU: TC;

@vertex
fn vsComp(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fsComp(@builtin(position) pos: vec4<f32>) -> CompOut {
  let c = vec2<i32>(floor(pos.xy - TCU.shift + vec2<f32>(TCU.m)));
  let d = textureLoad(tDepth, c, 0).x;
  // (nothing of the terrain there: the sky's clear colour, or what the frame draws)
  if (d >= 1.0) { discard; }
  var o: CompOut;
  o.color = textureLoad(tColor, c, 0);
  o.pick = textureLoad(tPick, c, 0).xy;
  o.depth = clamp(d + TCU.dz, 0.0, 1.0);
  return o;
}
