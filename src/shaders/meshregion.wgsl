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
//   zb (round 79, the band outside the window) x the samples' lowest z, y the
//      bedrock's top (solid below it), z the window's top: a run reaching it
//      goes on up (the live mesh: what's above is the band's; else far up)
//   ze the quads made: those whose base sample's z is in [x, y), or (z = 1)
//      outside it — the live mesh its window's, the band what's outside
//   cv (perfopt, ?cavemesh=near) w 1: the mesh leaves out what's more than CAVE_DEEP under the lowest top of a
//      sample's cell and its neighbours (caves, the insides of hills: under the ground, never seen from the
//      sky), except within z of (x, y) — the cut's focus, where the player is under a roof
//   pr (round 86) x the rebuild slots a frame for any change (k.y is that and the urgent ones: a chunk the CPU
//      marked — an edit's, a falling piece's — takes any slot, so what the player did shows the next frame);
//      (round 93) y, z vertex and quad pages a range's table holds at most, w 1: the page pool (below)
struct MeshRegion { o: vec4<f32>, n: vec4<u32>, k: vec4<u32>, r: vec4<f32>, zb: vec4<f32>, ze: vec4<f32>, cv: vec4<f32>, pr: vec4<u32> };
@group(0) @binding(30) var<uniform> MR: MeshRegion;

/**
 * Is an interval of material m part of the field (meshed), or built — a
 * solid other than rock (stone, basalt) and packed trash (concrete, brick, asphalt, steel,
 * rust, bone, canvas) — and drawn as prisms, sharp, the way the structure
 * grids stay cubes? (Smoothed, a ruin's walls melted into cones.)
 */
// (round 112: world/materials.ts fieldMeshed is its CPU mirror -- keep the two the same)
fn fieldMat(m: u32) -> bool { return matState(m) != ST_SOLID || m == MAT_STONE || m == 12u || m == 23u || m == 30u || (m >= 33u && m <= 36u) || m == 38u; }

// the field mesh's state (fieldmesh.wgsl binding 9): CHUNK0 words, then CSTRIDE a chunk, then a word
// a chunk (near the view), then (round 73) four a mesh range: the translation its vertices are drawn
// with — the streamed window slid since they were made (fieldmesh.ts shift)
// (CHUNK0, CSTRIDE: meshstate.wgsl, included before this)
fn offBase() -> u32 { return CHUNK0 + MR.n.x * MR.n.y * (CSTRIDE + 1u); }

// ---- (round 93, the page pool: MR.pr.w 1) -------------------------------------------------------------------
// The mesh's vertices and quads live in pages of one pool buffer (fieldmesh.wgsl binding 7, the draw's binding 3)
// handed to the chunks that are built, sized by what they hold, not a chunk's worst case for every chunk of the
// window. A page is PAGE_VEC4 vec4s (16 KB): VPP vertices (two vec4 each) or QPP quads (two u32 each: its four
// chunk-local vertices, 16 bits each — the triangles x y z, x z w through one shared quad index buffer). Each mesh range r (a
// chunk's record's word 10) has a table after the rebuild's dispatch words (rtBase): [0] vertex pages held,
// [1] quad pages held, [2] vertices needed, [3] quads needed (the count passes), [4..7] spare, then MR.pr.y
// vertex page ids, then MR.pr.z quad page ids. After the tables (freeBase): [0] the free stack's top, [1] the
// pool's pages (the CPU grows it), [2] pages pushed so far, [3] rebuilds starved (no pages: cumulative),
// [4] the fewest pages left free since the start, [5] the most one take asked for, [6..7] spare, then the stack.
const PAGE_VEC4: u32 = 1024u;
const VPP: u32 = 512u;
const QPP: u32 = 2048u;
fn meshPool() -> bool { return MR.pr.w != 0u; }
fn rtBase(r: u32) -> u32 { return offBase() + MR.n.x * MR.n.y * 4u + 4u + r * (8u + MR.pr.y + MR.pr.z); }
fn freeBase() -> u32 { return rtBase(MR.n.x * MR.n.y); }

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
