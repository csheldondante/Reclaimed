// ---- structure grids (docs/GRIDS.md) -----------------------------------------
// Rigid voxel grids over the nature grid, each in its own frame (full
// rotation): a toppled building is one. They own their solids (and the growth
// on their faces); the nature grid sees them through a projection
// (project.wgsl), they see the nature grid by sampling it (structtick.wgsl).
// The CPU only writes the frames (src/grids/structures.ts).
//
// Frame (64 bytes, mirrored in structures.ts):
//   a  world position of the grid's local origin (voxel (0, 0, 0)'s corner)
//   q  rotation, local → world (quaternion xyzw)
//   d  dims in voxels (x = 0: an unused slot); w: offset of its voxels in the pool
//   b  world xy bounds (min x, min y, max x, max y): a quick reject
// A voxel (u32): material (bits 0..7, 0 = air), moss 0..255 (8..15), sand
// cover 0..255 (16..23).
struct Frame { a: vec4<f32>, q: vec4<f32>, d: vec4<u32>, b: vec4<f32> };
const MAX_STRUCTS: u32 = 8u;

fn qrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn qconj(q: vec4<f32>) -> vec4<f32> { return vec4<f32>(-q.xyz, q.w); }
fn toLocal(f: Frame, w: vec3<f32>) -> vec3<f32> { return qrot(qconj(f.q), w - f.a.xyz); }
fn toWorld(f: Frame, l: vec3<f32>) -> vec3<f32> { return f.a.xyz + qrot(f.q, l); }
fn inGrid(f: Frame, c: vec3<i32>) -> bool { return all(c >= vec3<i32>(0)) && all(vec3<u32>(c) < f.d.xyz); }
fn voxIndex(f: Frame, c: vec3<i32>) -> u32 { return f.d.w + u32(c.x) + f.d.x * (u32(c.y) + f.d.y * u32(c.z)); }
fn voxMat(v: u32) -> u32 { return v & 0xffu; }
fn voxMoss(v: u32) -> f32 { return f32((v >> 8u) & 0xffu) / 255.0; }
fn voxSand(v: u32) -> f32 { return f32((v >> 16u) & 0xffu) / 255.0; }
fn voxPack(mat: u32, moss: f32, sand: f32) -> u32 {
  return mat | (u32(clamp(moss, 0.0, 1.0) * 255.0 + 0.5) << 8u) | (u32(clamp(sand, 0.0, 1.0) * 255.0 + 0.5) << 16u);
}
/** the six face directions of a voxel, in its grid's local axes */
const FACE6 = array<vec3<i32>, 6>(
  vec3<i32>(1, 0, 0), vec3<i32>(-1, 0, 0), vec3<i32>(0, 1, 0),
  vec3<i32>(0, -1, 0), vec3<i32>(0, 0, 1), vec3<i32>(0, 0, -1));
