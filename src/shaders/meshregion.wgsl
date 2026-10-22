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
 * solid other than rock (stone, basalt) and packed trash (concrete, brick, asphalt, steel,
 * rust, bone, canvas) — and drawn as prisms, sharp, the way the structure
 * grids stay cubes? (Smoothed, a ruin's walls melted into cones.)
 */
fn fieldMat(m: u32) -> bool { return matState(m) != ST_SOLID || m == MAT_STONE || m == 12u || m == 23u; }

/** Smooth value noise 0..1 (trilinear between hashed lattice values). */
fn warpNoise(p: vec3<f32>) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = smoothstep(vec3<f32>(0.0), vec3<f32>(1.0), fract(p));
  let a = mix(randv(i), randv(i + vec3<i32>(1, 0, 0)), f.x);
  let b = mix(randv(i + vec3<i32>(0, 1, 0)), randv(i + vec3<i32>(1, 1, 0)), f.x);
  let c = mix(randv(i + vec3<i32>(0, 0, 1)), randv(i + vec3<i32>(1, 0, 1)), f.x);
  let d = mix(randv(i + vec3<i32>(0, 1, 1)), randv(i + vec3<i32>(1, 1, 1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

/**
 * Where the terrain field is looked up for world point p: p moved sideways
 * by up to 0.45 cells of 3D noise, so a cliff's face bulges and recedes (and
 * differently up its height) instead of following the hexes; flat ground
 * keeps its height (moved sideways it finds the same ground). The draw
 * shader looks its materials up at the same place.
 */
fn terrainWarp(p: vec3<f32>) -> vec2<f32> {
  let q = p * vec3<f32>(0.45, 0.45, 0.6);
  return p.xy + (vec2<f32>(warpNoise(q), warpNoise(q + vec3<f32>(17.3, 5.1, 9.7))) - 0.5) * 0.9;
}

/** Is world point xy drawn by the field mesh (not by prisms or sheets)? */
fn meshed(xy: vec2<f32>) -> bool {
  return MR.n.w != 0u && xy.x >= MR.r.x && xy.y >= MR.r.y && xy.x < MR.r.z && xy.y < MR.r.w;
}
