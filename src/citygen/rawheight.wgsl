// (citygen M4b) The town grid's ground from the atlas's raw ground (Atlas.rawGroundGpu: 64 × 64 tiles, row-major, 4
// words a column — its top in world z, the water on it, its top's material, its plants): the top height (world z)
// and the wet mask, one thread a column — what height.wgsl reads from the window, without the window: the town is
// made over its whole box wherever the window is. Out in the grid's order (y · w + x).
struct RawU {
  /** the grid's columns and rows, the tiles across, 0 */
  n: vec4<u32>,
  /** the sea's level (world z), 0, 0, 0 */
  s: vec4<f32>,
};
@group(0) @binding(0) var<uniform> RU: RawU;
@group(0) @binding(1) var<storage, read> raw: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> topOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> wetOut: array<f32>;
/** (trackA-liquids) the water's surface where it's water to the streets (world z), else -1e9: a deck clears it */
@group(0) @binding(4) var<storage, read_write> surfOut: array<f32>;

/** water deeper than this (cells) is water to the streets (height.wgsl's) */
const WET_DEPTH: f32 = 0.1;
const RT: u32 = 64u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= RU.n.x || id.y >= RU.n.y) { return; }
  let k = (id.y / RT) * RU.n.z + id.x / RT;
  let v = raw[k * RT * RT + (id.y % RT) * RT + id.x % RT];
  let t = bitcast<f32>(v.x);
  let o = id.y * RU.n.x + id.x;
  topOut[o] = t;
  let wet = bitcast<f32>(v.y) > WET_DEPTH || t < RU.s.x;
  wetOut[o] = select(0.0, 1.0, wet);
  surfOut[o] = select(-1e9, max(t + bitcast<f32>(v.y), RU.s.x), wet);
}
