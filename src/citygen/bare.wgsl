// (citygen M4b) A town's claimed columns bare of plants: where its claim grid has a span (a building, a road's paving,
// a deck), the plants' field (WorldGpu veg, and the next tick's) set to none as its claims are written — the old
// towns' BARE stamp (atlas/stamps.ts), for a town whose land is made before it. What grows back on a claimed top is
// capped by its material (External: moss at most, ecology.wgsl) — no trees, no shrubs. One thread a window column of
// the rectangle claimed. Appended to common.wgsl.
struct BareU {
  /** the grid's first column in the window (gx, gy), its columns and rows */
  g: vec4<i32>,
  /** the window rectangle [x0, x1) × [y0, y1) */
  r: vec4<u32>,
};
@group(0) @binding(3) var<storage, read> grid: array<u32>;
@group(0) @binding(4) var<storage, read_write> veg: array<f32>;
@group(0) @binding(5) var<storage, read_write> vegNext: array<f32>;
@group(0) @binding(6) var<uniform> BU: BareU;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = BU.r.x + id.x;
  let y = BU.r.y + id.y;
  if (x >= BU.r.z || y >= BU.r.w || x >= G.mapW || y >= G.mapH) { return; }
  let lx = i32(x) - BU.g.x;
  let ly = i32(y) - BU.g.y;
  if (lx < 0 || ly < 0 || lx >= BU.g.z || ly >= BU.g.w) { return; }
  // (a span — a building, a road's paving — or a parcel kept bare: its owner word's top bit, streets.wgsl BARE_ONLY)
  let gi = u32(ly * BU.g.z + lx);
  if (grid[gi * 4u + 3u] == 0u && (grid[u32(BU.g.z * BU.g.w) * 4u + gi * 4u + 3u] & 0x80000000u) == 0u) { return; }
  let i = colIdx(x, y);
  veg[i] = 0.0;
  vegNext[i] = 0.0;
}
