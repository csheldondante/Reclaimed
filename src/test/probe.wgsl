// (round 112, testspeed) The runner's self-check kernel (scripts/run.mjs selfcheck): it writes a constant of its own
// and one from common.wgsl (prepended, as every kernel's), so a check can tell which sources the GPU ran — an edit to
// either must show after a rebuild, never a cached pipeline of the old source.
const PROBE_OWN: f32 = 1.0;
@group(0) @binding(3) var<storage, read_write> probeOut: array<f32>;
@compute @workgroup_size(1)
fn main() {
  probeOut[0] = PROBE_OWN;
  probeOut[1] = ROW_H;
}
