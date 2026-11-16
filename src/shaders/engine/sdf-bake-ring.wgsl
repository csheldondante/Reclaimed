// sdf-bake.wgsl's parameters when the GPU gives them: the engine's settled parts (docs/design/PHYSICS_ENGINE.md
// "Pieces are bodies"; src/shaders/engine_partsdf.wgsl has the buffer's layout, BK_*). The batch is the jobs of the
// ring from `head` to `end`; the bake is spread over ticks, and `bakeBegin` says each tick which kernels have work
// (BK_BITS: 1 seed, 2 two flood passes, 4 the field and the sample bricks). Put in front of sdf-bake.wgsl.
@group(0) @binding(0) var<storage, read> bkR: array<u32>;
// x: which of the tick's two flood passes this dispatch is
@group(0) @binding(8) var<uniform> BJ: vec4<u32>;
const BKR_RING: u32 = 64u;
const BKR_JOBS: u32 = 1024u;
fn bkJobs() -> u32 { return bkR[2] - bkR[1]; }
fn bkThreads() -> u32 { return bkR[5]; }
fn bkBricks() -> u32 { return bkR[6]; }
/** flood pass k of `steps` has stride N >> (k + 1), N the power of two at or past the longest side; the last, and any past it, 1 */
fn bkStep() -> u32 { return max(1u, (1u << (bkR[4] - 1u)) >> min(bkR[3] + BJ.x + 1u, 31u)); }
fn jobAt(k: u32) -> Job {
  let b = BKR_RING + ((bkR[1] + k) % BKR_JOBS) * 8u;
  return Job(bkR[b], bkR[b + 1u], bkR[b + 2u], bkR[b + 3u], bkR[b + 4u], 0u, 0u, 0u);
}
fn bkRun(kind: u32) -> bool { return (bkR[7] & (1u << kind)) != 0u; }
