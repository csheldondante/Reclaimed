// ---- aggregate stats (gameplay / audio / HUD read these) ------------------
// Fixed-point sums via workgroup-local atomics then one global atomic each.
@group(0) @binding(3) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read> veg: array<f32>;
@group(0) @binding(5) var<storage, read> water: array<f32>;
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>>;

// indices — keep in sync with src/sim/stats.ts
// 0 soil contamination x1000   1 dissolved x1000   2 vegetated cells (v>=0.5)
// 3 sum veg x100               4 water volume x100  5 flow x1000
// 6 clean cells (c<0.2)        7 wet cells           8 mature cells (v>=3)
const N_STATS: u32 = 9u;
var<workgroup> acc: array<atomic<u32>, 9>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li < N_STATS) { atomicStore(&acc[li], 0u); }
  workgroupBarrier();
  if (id.x < G.mapW && id.y < G.mapH) {
    let i = colIdx(id.x, id.y);
    let c = contam[i];
    let v = veg[i];
    let d = water[i];
    let f = flux[i];
    atomicAdd(&acc[0], u32(c.x * 1000.0));
    atomicAdd(&acc[1], u32(c.y * 1000.0));
    atomicAdd(&acc[2], select(0u, 1u, v >= 0.5));
    atomicAdd(&acc[3], u32(v * 100.0));
    atomicAdd(&acc[4], u32(d * 100.0));
    atomicAdd(&acc[5], u32((f.x + f.y + f.z + f.w) * 1000.0));
    atomicAdd(&acc[6], select(0u, 1u, c.x < 0.2));
    atomicAdd(&acc[7], select(0u, 1u, d > 0.02));
    atomicAdd(&acc[8], select(0u, 1u, v >= 3.0));
  }
  workgroupBarrier();
  if (li < N_STATS) { atomicAdd(&stats[li], atomicLoad(&acc[li])); }
}
