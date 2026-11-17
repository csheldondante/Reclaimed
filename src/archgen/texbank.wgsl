// ---- (AG19; ground branch) the material textures: bind group 1 of the arch draws and the terrain's look ----
// textures.ts: 20 CC0 sets (ambientCG, scripts/packtex.py) in two arrays with mips — colour (its occlusion folded in)
// and normal xy + roughness — one anisotropic sampler, and a uniform: x 1 once loaded, y the size. Shared by the
// buildings (archgen/draw.wgsl texPick) and the terrain (meshdraw.wgsl meshSurf, through light.wgsl groundTex).
@group(1) @binding(0) var archTexC: texture_2d_array<f32>;
@group(1) @binding(1) var archTexN: texture_2d_array<f32>;
@group(1) @binding(2) var archSamp: sampler;
@group(1) @binding(3) var<uniform> archTexU: vec4<f32>;
const TX_BRICK: i32 = 0;
const TX_RUBBLE: i32 = 1;
const TX_ASHLAR: i32 = 2;
const TX_PLASTER: i32 = 3;
const TX_SIDING: i32 = 4;
const TX_WOOD: i32 = 5;
const TX_DECK: i32 = 6;
const TX_TILE: i32 = 7;
const TX_SLATE: i32 = 8;
const TX_THATCH: i32 = 9;
const TX_FLAG: i32 = 10;
const TX_COBBLE: i32 = 11;
const TX_DIRT: i32 = 12;
const TX_GRASS: i32 = 13;
const TX_CANVAS: i32 = 14;
const TX_SAND: i32 = 15;
const TX_ROCK: i32 = 16;
const TX_GRAVEL: i32 = 17;
const TX_SNOW: i32 = 18;
const TX_MOSS: i32 = 19;
/** each set's mean colour (scripts/packtex.py): a tint moves it onto the colour wanted */
fn txMean(l: i32) -> vec3<f32> {
  var m = array<vec3<f32>, 20>(vec3<f32>(0.58, 0.416, 0.325), vec3<f32>(0.494, 0.459, 0.384), vec3<f32>(0.647, 0.612, 0.478),
    vec3<f32>(0.843, 0.827, 0.816), vec3<f32>(0.294, 0.239, 0.192), vec3<f32>(0.482, 0.388, 0.306), vec3<f32>(0.353, 0.29, 0.22),
    vec3<f32>(0.392, 0.231, 0.153), vec3<f32>(0.275, 0.282, 0.267), vec3<f32>(0.329, 0.294, 0.251), vec3<f32>(0.478, 0.443, 0.349),
    vec3<f32>(0.533, 0.529, 0.498), vec3<f32>(0.294, 0.216, 0.176), vec3<f32>(0.333, 0.376, 0.169), vec3<f32>(0.451, 0.435, 0.369),
    vec3<f32>(0.58, 0.514, 0.408), vec3<f32>(0.29, 0.278, 0.255), vec3<f32>(0.424, 0.408, 0.369), vec3<f32>(0.769, 0.773, 0.776),
    vec3<f32>(0.588, 0.565, 0.337));
  return m[clamp(l, 0, 19)];
}
