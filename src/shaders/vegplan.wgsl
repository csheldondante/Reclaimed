// ---- vegetation layout (shared) -------------------------------------------
// Where trees and shrubs stand and how tall they are, from the succession
// field. Pure function of (column, veg, material) so render-prep draws the
// plants and particles (perching birds) find the same crowns.
// species (instance bits 16..19 for vegetation): 0 broadleaf, 1 conifer, 2 birch, 3 old giant
struct VegPlan { shrub: bool, tree: bool, trunk: f32, crown: f32, tufts: u32, flower: bool, species: u32 };

fn vegPlan(x: u32, y: u32, v: f32, m: u32) -> VegPlan {
  var pl = VegPlan(false, false, 0.0, 0.0, 0u, false, 0u);
  let h = rand3(x, y, 4242u);
  let edge = x < 2u || y < 2u || x + 3u >= G.mapW || y + 3u >= G.mapH;
  if (v >= 3.6 && h < 0.045 && !edge) {
    pl.tree = true;
    let hs = rand3(x, y, 321u);
    let hv = rand3(x, y, 7u);
    let age = clamp(v - 3.6, 0.0, 1.4);
    if (v > 4.7 && hs < 0.12) {
      pl.species = 3u; // old giant: tall trunk, broad crown
      pl.trunk = 5.0 + floor(hv * 4.0);
      pl.crown = 3.0 + floor(hv * 2.0);
    } else if (hs < 0.42) {
      pl.species = 1u; // conifer: short bare trunk, tall tapering crown
      pl.trunk = 1.0 + floor(hv * 2.0);
      pl.crown = 4.0 + floor(age * 2.0) + floor(hv * 3.0);
    } else if (hs < 0.58) {
      pl.species = 2u; // birch: slender pale trunk, small light crown
      pl.trunk = 3.0 + floor(age * 2.0) + floor(hv * 2.0);
      pl.crown = 2.0;
    } else {
      pl.trunk = 2.0 + floor(age * 2.5) + floor(hv * 3.0);
      pl.crown = 2.0 + floor(hv * 1.99) + select(0.0, 1.0, v > 4.5);
    }
  } else if (v >= 2.6 && h < 0.25) {
    pl.shrub = true;
  }
  // grass tufts on soil-like ground once grass has taken hold
  let soilish = MATS[m].eco.x >= 2.0;
  if (soilish && v >= 1.2) {
    let t = rand3(x, y, 99u);
    pl.tufts = select(0u, 1u + u32(t * 2.99), t < smoothstep(1.2, 2.5, v) * 0.9);
    // meadows (grass that stopped short of woodland) are full of flowers
    pl.flower = v >= 1.6 && v < 3.8 && rand3(x, y, 123u) < select(0.12, 0.3, v > 2.4 && v < 3.4);
  }
  return pl;
}
