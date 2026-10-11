// ---- surface system ----------------------------------------------------
// Derives the per-column surface (top z, top material, slot count) from the
// layered world. This is the main read-only contract other systems use, so
// they do not need to understand the slot layout.
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> surface: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let cs = colSlots(id.x, id.y);
  var top = 0.0;
  var mat = 0u;
  var n = 0u;
  for (var i = 0u; i < cs.y; i++) {
    let v = layers[cs.x + i];
    if (ivEmpty(v)) { break; }
    top = ivZ1(v);
    mat = ivMat(v);
    n = i + 1u;
  }
  surface[colIdx(id.x, id.y)] = sfPack(top, mat, n);
}
