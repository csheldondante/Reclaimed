// sdf-bake.wgsl's parameters when the host gives them (src/engine/sdf/models.ts flush): a uniform a dispatch, the
// batch's jobs in a buffer. Put in front of sdf-bake.wgsl. (The engine's parts are baked from a ring the GPU fills:
// sdf-bake-ring.wgsl.)
@group(0) @binding(0) var<uniform> P: BakeParams;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
fn bkJobs() -> u32 { return P.jobs; }
fn bkThreads() -> u32 { return P.threads; }
fn bkStep() -> u32 { return P.step; }
fn bkBricks() -> u32 { return P.bricks; }
fn jobAt(k: u32) -> Job { return jobs[k]; }
/** does this kernel (0 seed, 1 a flood pass, 2 the field and the sample bricks) run in this dispatch? The host encodes only those that do. */
fn bkRun(kind: u32) -> bool { return true; }
