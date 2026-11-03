// ---- the woods: stand-in biome fields shared by the window and the atlas (round 125, `forest`) ------------------
// The elder woods (src/flora/spacing.ts elderWood, exactly): value noise of the world column at 96 columns, 0 outside a
// wood, rising to 1 in its heart. vegplan.wgsl stands an elder a super-block in them; the atlas (forms.wgsl colFinish,
// lod.wgsl startVeg) lays old woods there (the succession at 4.2), so an elder wood is a wood — the user's "seas of
// leaves" need forests, and before this the atlas's woods were small patches (2% of a temperate window's columns at
// 3.9 or more). Needs `pcg` (common.wgsl's, or atlas/noise.wgsl's: the same).
const ELDER_SCALE: f32 = 96.0;
const ELDER_LO: f32 = 0.6;
const ELDER_HI: f32 = 0.74;
const ELDER_VEG: f32 = 3.9;
fn elderCorner(x: i32, y: i32) -> f32 { return f32(pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ 0xe1de4u)) >> 8u) / 16777216.0; }
/** the elder woods at world column w (0 outside .. 1 in a wood's heart): spacing.ts elderWood */
fn elderWoodW(w: vec2<i32>) -> f32 {
  let p = vec2<f32>(w) / ELDER_SCALE;
  let i = vec2<i32>(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n = mix(mix(elderCorner(i.x, i.y), elderCorner(i.x + 1, i.y), u.x), mix(elderCorner(i.x, i.y + 1), elderCorner(i.x + 1, i.y + 1), u.x), u.y);
  return smoothstep(ELDER_LO, ELDER_HI, n);
}

/**
 * (round 125) The succession the atlas lays in the elder woods at world column w, for a region growing `regionVeg` (its
 * kind's veg: plains and hills 1, marsh 1.3, highlands 0.7 ... dunes 0.05): old woods (4.2) through a wood's heart where
 * the land grows plants well, thinning to its rim; none where it barely grows any.
 */
fn elderWoods(w: vec2<i32>, regionVeg: f32) -> f32 {
  return 4.2 * smoothstep(0.15, 0.6, elderWoodW(w)) * smoothstep(0.55, 0.9, regionVeg);
}
