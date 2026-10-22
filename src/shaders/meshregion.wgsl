// ---- the field mesh's layout (G13 h: fieldmesh.wgsl) ----------------------------
// The whole map drawn as a mesh extracted from a field instead of as prisms,
// sheets and cubes, in square chunks of the world. Mirrored in
// src/render/fieldmesh.ts:
//   o  x a chunk's side (world units), y the sample spacing
//   n  chunks along x, y; samples along z; w 1 when the mesh is on
//   k  x samples along a chunk's side (N cells), y chunks rebuilt per frame
//      at most, z vertices and w indices a chunk has room for
//   r  the world xy rectangle the prisms and sheets leave to the mesh
//      (min x, min y, max x, max y)
struct MeshRegion { o: vec4<f32>, n: vec4<u32>, k: vec4<u32>, r: vec4<f32> };
@group(0) @binding(30) var<uniform> MR: MeshRegion;

/**
 * Is an interval of material m part of the field (meshed), or built — a
 * solid other than rock and packed trash (concrete, brick, asphalt, steel,
 * rust, bone, canvas) — and drawn as prisms, sharp, the way the structure
 * grids stay cubes? (Smoothed, a ruin's walls melted into cones.)
 */
fn fieldMat(m: u32) -> bool { return matState(m) != ST_SOLID || m == MAT_STONE || m == 12u; }

/** Is world point xy drawn by the field mesh (not by prisms or sheets)? */
fn meshed(xy: vec2<f32>) -> bool {
  return MR.n.w != 0u && xy.x >= MR.r.x && xy.y >= MR.r.y && xy.x < MR.r.z && xy.y < MR.r.w;
}
