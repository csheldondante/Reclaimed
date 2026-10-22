// ---- materials.wgsl ----------------------------------------------------
// Mirrors src/world/materials.ts packMaterialTable().
struct Material {
  albedo: vec4<f32>, // rgb (sRGB), emissive
  sim: vec4<f32>,    // state, reposeDry, reposeWet, strength
  eco: vec4<f32>,    // growthCap, suitability, specular, porosity
  look: vec4<f32>,   // smooth (cells; 0 = hard steps), unused ×3
  loose: vec4<f32>,  // wind lift (cells/s; ≥ 1e8 never), airborne share, water mobility, wash flow
};
@group(0) @binding(2) var<uniform> MATS: array<Material, 32>;

const ST_EMPTY: u32 = 0u;
const ST_SOLID: u32 = 1u;
const ST_GRANULAR: u32 = 2u;
const ST_LIQUID: u32 = 3u;
const ST_VEG: u32 = 4u;

const MAT_STONE: u32 = 1u;
const MAT_WATER: u32 = 8u;
const MAT_LEAVES: u32 = 9u;
const MAT_WOOD: u32 = 10u;
const MAT_TRASH: u32 = 12u;
const MAT_OIL: u32 = 13u;
const MAT_GRASS: u32 = 14u;
const MAT_FLOWER: u32 = 15u;
const MAT_DRIFT: u32 = 19u;
const MAT_BASALT_M: u32 = 23u;
const MAT_LAVA_M: u32 = 24u;

fn matState(m: u32) -> u32 { return u32(MATS[m].sim.x); }

/**
 * What a destroyed solid becomes, the same volume where it was (round 23,
 * Q3: "stone to gravel"): wood, canvas and leaves burn down to ash, bone to
 * dust, compacted waste to litter, the rest (stone, concrete, brick, metal,
 * asphalt) to rubble. Mirrors integrity.ts looseFrom().
 */
fn rubbleOf(m: u32) -> u32 {
  if (m == MAT_WOOD || m == 21u || m == MAT_LEAVES) { return 17u; }
  if (m == 16u) { return MAT_DRIFT; }
  if (m == MAT_TRASH) { return 18u; }
  return 4u;
}
