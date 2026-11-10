// ---- unitreads.wgsl ------------------------------------------------------------------------------------------------
// (round 128p, DA-B22 (c)(1)(4)) The few units the CPU reads, gathered on the GPU (agents/reads.ts) — so a sync copies
// one block, not every unit's record or a copy a unit:
//   gather   the records of the slots listed (the observed units) packed one after another
//   near     the live units within a radius of a point: their slot and position appended (a query's answer)
//   nearMany the live units within each of up to MANY points' radii: (x, y, id, the point's index) appended — the
//            game's "who has come to this place" asked of the GPU in one pass (a raid's goals, its gates)

@group(0) @binding(7) var<storage, read> units: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> slots: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> count: array<atomic<u32>, 4>;
// (near) the units' combat words (notice.ts): a query of one faction looks at its units only
@group(0) @binding(6) var<storage, read> combat: array<vec4<u32>>;

struct ReadParams {
  // x the slots listed (gather) or in use (near), y the most answers (near), z the points (nearMany), w (near) a
  // faction's number + 1 to look at only (0: any)
  n: vec4<u32>,
  // x y the point, z the radius (near), w unused
  at: vec4<f32>,
};
@group(0) @binding(3) var<uniform> RP: ReadParams;
// (nearMany) the points: x y, z the radius
@group(0) @binding(5) var<uniform> PTS: array<vec4<f32>, 32>;
const MANY: u32 = 32u;

const UNIT_V: u32 = 6u;
const MAX_SLOTS: u32 = 8192u;

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
  if (RP.n.w != 0u && (combat[s].x & 0xffu) != RP.n.w - 1u) { return; }
  let k = atomicAdd(&count[0], 1u);
  if (k >= RP.n.y) { return; }
  // (its id in w's bits: its generation and slot, agents.ts — generation × MAX_SLOTS + slot)
  out[k] = vec4<f32>(a.xyz, bitcast<f32>((bitcast<u32>(a.w) >> 16u) * MAX_SLOTS + s));
}

@compute @workgroup_size(64)
fn nearMany(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= RP.n.x) { return; }
  let a = units[s * UNIT_V];
  let info = bitcast<u32>(a.w);
  if (((info >> 8u) & 1u) == 0u) { return; }
  for (var k = 0u; k < min(RP.n.z, MANY); k++) {
    let q = PTS[k];
    if (length(a.xy - q.xy) > q.z) { continue; }
    let j = atomicAdd(&count[0], 1u);
    if (j >= RP.n.y) { return; }
    out[j] = vec4<f32>(a.x, a.y, bitcast<f32>((info >> 16u) * MAX_SLOTS + s), bitcast<f32>(k));
  }
}
