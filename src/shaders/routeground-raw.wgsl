// ---- the route network's ground, at generation: the raw ground the GPU made of a town's box (Atlas.rawGround), its
// columns box-local (townroute.wgsl reads the ground only through rgValid / rgTop / rgWater; routeground-live.wgsl is
// play's — one cut kernel, two grounds). The box's place is (0, 0) and its size RP.dims; z is world z (RP.rules.x 0). ----
@group(0) @binding(3) var<storage, read> rawGround: array<f32>;
@group(0) @binding(4) var<storage, read> rawWater: array<f32>;

fn rgValid(p: vec2<i32>) -> bool { return p.x >= 0 && p.y >= 0 && p.x < i32(RP.dims.x) && p.y < i32(RP.dims.y); }
fn rgTop(p: vec2<i32>) -> f32 { return rawGround[u32(p.y) * RP.dims.x + u32(p.x)]; }
fn rgWater(p: vec2<i32>) -> f32 { return rawWater[u32(p.y) * RP.dims.x + u32(p.x)]; }
