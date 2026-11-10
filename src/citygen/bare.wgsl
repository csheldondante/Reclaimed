// (citygen M4b) A town's claimed columns bare of plants: where its claim grid has a span (a building, a road's paving,
// a deck), the plants' field (WorldGpu veg, and the next tick's) set to none as its claims are written — the old
// towns' BARE stamp (atlas/stamps.ts), for a town whose land is made before it. What grows back on a claimed top is
// capped by its material (External: moss at most, ecology.wgsl) — no trees, no shrubs. One thread a window column of
// the rectangle claimed. Appended to common.wgsl.
// (farms) And a field's columns (no span; their owner word FIELD_COL | the field's record — streets.wgsl claimField)
// set to its crop (common.wgsl cropVeg): its stage from the field's construction progress (0 tilled … 3 ripe), its
// rows along the field's first edge. A field not begun keeps its wild plants. DESIGN §15: "Farms produce, and the
// field's crop stage shows it."
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
/** (farms) the town's lot progress (f32 a record) and its lot records (24 u32 a record: the footprint at 8–15) */
@group(0) @binding(7) var<storage, read> prog: array<f32>;
@group(0) @binding(8) var<storage, read> recs: array<u32>;

const BARE_ONLY_BIT: u32 = 0x80000000u;
const FIELD_COL_BIT: u32 = 0x40000000u;
const REC_WORDS: u32 = 24u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = BU.r.x + id.x;
  let y = BU.r.y + id.y;
  if (x >= BU.r.z || y >= BU.r.w || x >= G.mapW || y >= G.mapH) { return; }
  let lx = i32(x) - BU.g.x;
  let ly = i32(y) - BU.g.y;
  if (lx < 0 || ly < 0 || lx >= BU.g.z || ly >= BU.g.w) { return; }
  let gi = u32(ly * BU.g.z + lx);
  let span = grid[gi * 4u + 3u] != 0u;
  let ow = grid[u32(BU.g.z * BU.g.w) * 4u + gi * 4u + 3u];
  let i = colIdx(x, y);
  // (farms: a field's column — its crop at the field's stage, its rows along its first edge in one of four directions)
  if (!span && (ow & (BARE_ONLY_BIT | FIELD_COL_BIT)) == FIELD_COL_BIT) {
    let r = ow & 0x3fffffffu;
    let p = prog[r];
    if (p <= 0.0) { return; }
    let o = r * REC_WORDS;
    let e = vec2<f32>(bitcast<f32>(recs[o + 10u]) - bitcast<f32>(recs[o + 8u]), bitcast<f32>(recs[o + 11u]) - bitcast<f32>(recs[o + 9u]));
    let dir = u32(i32(round(atan2(e.y, e.x) / (3.14159265 / 4.0))) + 8) & 3u;
    let v = cropVeg(3.0 * p, dir);
    veg[i] = v;
    vegNext[i] = v;
    return;
  }
  // (a span — a building, a road's paving — or a parcel kept bare: its owner word's top bit, streets.wgsl BARE_ONLY)
  if (!span && (ow & BARE_ONLY_BIT) == 0u) { return; }
  veg[i] = 0.0;
  vegNext[i] = 0.0;
}
