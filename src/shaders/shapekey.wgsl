// ---- shapekey.wgsl ------------------------------------------------------------------------------------------------
// (round 128o, DA-B28) A slot as the field mesh sees it: its ends to a sixteenth of a cell and its material (an empty
// slot its own key). The one quantization of "the mesh's shape changed": the column writers' bumpColumn
// (chunkver.wgsl) and colapply's store move a chunk's shape version when a slot's key changes, and the field mesh
// rebuilds a chunk whose shape version moved — sediment creeping by hundredths rebuilds nothing until a sixteenth adds
// up. Raw bits only (no other snippet needed): colapply includes it as well as chunkver.wgsl.

fn shapeKey(v: vec4<u32>) -> vec3<u32> {
  if (v.y == 0u) { return vec3<u32>(0xffffffffu); }
  return vec3<u32>(u32(bitcast<f32>(v.x) * 16.0 + 0.5), u32(bitcast<f32>(v.y) * 16.0 + 0.5), v.z & 0xffu);
}

/** slot `a` became `b` and the mesh would see it */
fn shapeMoved(a: vec4<u32>, b: vec4<u32>) -> bool { return any(shapeKey(a) != shapeKey(b)); }
