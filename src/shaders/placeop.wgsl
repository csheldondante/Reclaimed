// ---- ops masked to a place (docs/PLACES.md step 1; sim/systems.ts PlaceOpSystem)
// One op a dispatch, from `op` (written by the CPU before the tick): over the
// columns whose top room is the place (a room), or any of its rooms (a
// region: placeTable maps each room to its region):
//  * bury: loose material laid on top through `deposit` .yz (as a crumbled
//    body's or the climate's snow: sediment.wgsl folds it into the layers
//    the same tick, PlaceOpSystem runs on its ticks), `amount` cells, varied
//    by `noise` (0: even; 1: 0..2× in patches `scale` cells across);
//  * flood: `amount` cells of water added on every column (then it flows:
//    nothing holds it in the place until W1 shapes the rooms);
//  * drain: the water there taken away.
@group(0) @binding(3) var<storage, read> places: array<u32>;
@group(0) @binding(4) var<storage, read> placeTable: array<u32>;
@group(0) @binding(5) var<storage, read_write> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> deposit: array<vec4<f32>>;
struct PlaceOp {
  // x op, y place id, z material, w the seed
  a: vec4<u32>,
  // x amount (cells), y noise 0..1, z noise scale (cells)
  b: vec4<f32>,
};
@group(0) @binding(7) var<uniform> op: PlaceOp;

const PO_BURY: u32 = 1u;
const PO_FLOOD: u32 = 2u;
const PO_DRAIN: u32 = 3u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let room = places[i] & 0xffffu;
  if (room == 0u || (room != op.a.y && placeTable[room] != op.a.y)) { return; }
  let amt = op.b.x;
  if (op.a.x == PO_BURY) {
    let n = fbm2(cellPos(p) / max(op.b.z, 1.0) + vec2<f32>(f32(op.a.w % 997u), f32(op.a.w % 991u)));
    let d = amt * max(0.0, 1.0 + op.b.y * (2.0 * n - 1.0) * 1.6);
    if (d <= 0.0) { return; }
    let dep = deposit[i];
    deposit[i] = vec4<f32>(dep.x, dep.y + d, f32(op.a.z), dep.w);
  } else if (op.a.x == PO_FLOOD) {
    water[i] += amt;
  } else if (op.a.x == PO_DRAIN) {
    water[i] = 0.0;
  }
}
