// ---- unitreads.wgsl ------------------------------------------------------------------------------------------------
// (round 128p, DA-B22 (c)(1)(4)) The few units the CPU reads, gathered on the GPU (agents/reads.ts) — so a sync copies
// one block, not every unit's record or a copy a unit:
//   gather   the records of the slots listed (the observed units) packed one after another
//   near     the live units within a radius of a point: their slot and position appended (a query's answer)

@group(0) @binding(7) var<storage, read> units: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> slots: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> count: array<atomic<u32>, 4>;

struct ReadParams {
  // x the slots listed (gather) or in use (near), y the most answers (near), zw unused
  n: vec4<u32>,
  // x y the point, z the radius (near), w unused
  at: vec4<f32>,
};
@group(0) @binding(3) var<uniform> RP: ReadParams;

const UNIT_V: u32 = 6u;

@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= RP.n.x) { return; }
  let s = slots[k];
  for (var v = 0u; v < UNIT_V; v++) { out[k * UNIT_V + v] = units[s * UNIT_V + v]; }
}

@compute @workgroup_size(64)
fn near(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= RP.n.x) { return; }
  let a = units[s * UNIT_V];
  if (((bitcast<u32>(a.w) >> 8u) & 1u) == 0u) { return; }
  if (length(a.xy - RP.at.xy) > RP.at.z) { return; }
  let k = atomicAdd(&count[0], 1u);
  if (k >= RP.n.y) { return; }
  // (the slot's id in w: its generation and slot, as its info word carries)
  out[k] = vec4<f32>(a.xyz, a.w);
}
