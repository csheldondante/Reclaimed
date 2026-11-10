// (street lab m1; citygen M4a) The town grid's top ground height and a water mask, one thread a column, from the
// world's layers (the chunk table: layers.wgsl colSlots) and water depth (common.wgsl colIdx) — fieldmesh.wgsl
// colTopAt's top: the highest ground interval's z1 (not a structure's or a plant's). The town grid is a box of the
// window: its column (x, y) is window column (x + box.x, y + box.y) — box.y even, so a row's hex offset is the
// window's. Out in the grid's order (y · w + x), citygen's own buffers. Appended to common.wgsl + layers.wgsl +
// materials.wgsl.
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read_write> topOut: array<f32>;
@group(0) @binding(6) var<storage, read_write> wetOut: array<f32>;
/** the box: its first window column and row, its columns and rows (citygen/gpu.ts; the CPU checks it's in the window) */
@group(0) @binding(7) var<uniform> box: vec4<u32>;

/** water deeper than this (cells) is water to the streets */
const WET_DEPTH: f32 = 0.1;

/** materials that aren't ground: structures (concrete, asphalt, rust, wood, brick, steel, canvas, plaster, tile, an
 *  external mesh's) and plants (leaves, logs) — world/materials.ts MAT */
fn builtOrGrown(m: u32) -> bool {
  return m == 5u || m == 6u || m == 7u || m == 9u || m == 10u || m == 11u || m == 20u || m == 21u || m == 29u || m == 31u || m == 32u || m == 39u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= box.z || id.y >= box.w) { return; }
  let x = id.x + box.x;
  let y = id.y + box.y;
  let cs = colSlots(x, y);
  // (the ground's top: the highest interval of a ground material — what's built or grows on it left out)
  var t = 0.0;
  for (var i = 0u; i < cs.y; i++) {
    let v = layers[cs.x + i];
    if (ivEmpty(v)) { break; }
    if (!builtOrGrown(ivMat(v))) { t = ivZ1(v); }
  }
  let o = id.y * box.z + id.x;
  topOut[o] = t;
  // (the sea: Globals.ocean.x, window z; −1e9 none — M4a: it read G.org.x, the window's world x, by mistake)
  let wet = water[colIdx(x, y)] > WET_DEPTH || t < G.ocean.x;
  wetOut[o] = select(0.0, 1.0, wet);
}
