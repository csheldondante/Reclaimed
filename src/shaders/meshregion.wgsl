// ---- the field mesh's region (G13 C, a prototype: fieldmesh.wgsl) ------------
// Where the terrain and the structure grids are drawn as one mesh extracted
// from a field instead of as prisms and cubes. Mirrored in
// src/render/fieldmesh.ts:
//   o  world position of sample (0, 0, 0); w the sample spacing
//   n  samples along x, y, z; w 1 when the region is on
//   r  the world xy rectangle the prisms, sheets and cubes leave to the mesh
//      (min x, min y, max x, max y)
struct MeshRegion { o: vec4<f32>, n: vec4<u32>, r: vec4<f32> };
@group(0) @binding(30) var<uniform> MR: MeshRegion;

/** Is world point xy drawn by the field mesh (not by prisms, sheets or cubes)? */
fn meshed(xy: vec2<f32>) -> bool {
  return MR.n.w != 0u && xy.x >= MR.r.x && xy.y >= MR.r.y && xy.x < MR.r.z && xy.y < MR.r.w;
}
