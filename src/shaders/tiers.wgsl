// ---- the sims' tiers (round 108, simtiers: sim/tiers.ts, api/contracts/simtiers.ts) -----------------------------
// Prepended to the kernels whose slow processes change the map (sediment, ecology, climate, particles, structtick).
// A slow process runs at the rate tierRate gives at a column: 0 baked (the map doesn't change; its visuals go on),
// 1 live, more inside a bake (its gain). The kernels scale the process's map change by it.
// The rates are a texture of the window's chunks (sim/tiers.ts rasterises the tiers, the regions asked live, the
// bakes and the player's interactions into it, written only when it changes): one texel a chunk, x rain erosion,
// y wind erosion, z vegetation. Its own binding, not the Globals: their size and any array indexed in them by a
// computed index slow every kernel (docs/PAGES.md §1, scripts/kernelab.mjs).
@group(0) @binding(50) var tierTex: texture_2d<f32>;

const TIER_RAIN: u32 = 0u;
const TIER_WIND: u32 = 1u;
const TIER_VEG: u32 = 2u;

fn tierRate(proc: u32, p: vec2<i32>) -> f32 {
  let n = vec2<i32>(textureDimensions(tierTex)) - 1;
  let t = textureLoad(tierTex, clamp(p / i32(G.chunkSize), vec2<i32>(0), n), 0);
  return select(select(t.z, t.y, proc == TIER_WIND), t.x, proc == TIER_RAIN);
}
