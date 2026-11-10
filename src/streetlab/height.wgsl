// (street lab, milestone 1) The window's top ground height and a water mask, one thread a column, from the layers (the
// chunk table: layers.wgsl colSlots) and the water depth (common.wgsl colIdx) — fieldmesh.wgsl colTopAt's top: the
// highest interval's z1, any material. Out in window order (y · w + x), the street lab's own buffers.
// Appended to common.wgsl + layers.wgsl + materials.wgsl.
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read_write> topOut: array<f32>;
@group(0) @binding(6) var<storage, read_write> wetOut: array<f32>;

/** water deeper than this (cells) is water to the streets */
const WET_DEPTH: f32 = 0.1;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let cs = colSlots(id.x, id.y);
  var t = 0.0;
  for (var i = 0u; i < cs.y; i++) {
    let v = layers[cs.x + i];
    if (ivEmpty(v)) { break; }
    t = ivZ1(v);
  }
  let o = id.y * G.mapW + id.x;
  topOut[o] = t;
  // (the sea: G.org.x, window z; −1e9 none)
  let wet = water[colIdx(id.x, id.y)] > WET_DEPTH || t < G.org.x;
  wetOut[o] = select(0.0, 1.0, wet);
}
