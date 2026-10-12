// ---- render fields (render preparation) ---------------------------------------
// One packed vec4 per column for the draw shaders, so they stay within the
// 8-storage-buffer budget no matter how many simulation fields exist:
//   x  sun shadow: lowest z that receives direct light (heightfield march
//      toward the light; includes the column itself, so floors under a roof
//      are shadowed)
//   y  soil moisture (wet surfaces darken)
//   z  fire glow: max nearby fire, softly blurred (lights walls next to flames)
//   w  net water flow speed (foam)
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> moisture: array<f32>;
@group(0) @binding(5) var<storage, read> fire: array<f32>;
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> fields: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> waterDepth: array<f32>;
@group(0) @binding(9) var<storage, read> veg: array<f32>;

/**
 * 1 where the four columns around grid corner v differ in top material
 * (the loose sheet's where there's a fair depth of it) or in plant cover:
 * only there do draw shaders vote on soft borders (render.wgsl edgeLook).
 */
fn mixedCorner(v: vec2<i32>) -> f32 {
  var m0 = 0xffffffffu;
  var lo = 1e9;
  var hi = -1e9;
  for (var k = 0; k < 4; k++) {
    let q = clampCell(v - vec2<i32>(1 - (k & 1), 1 - (k >> 1)));
    let t = textureLoad(driftTex, q, 0);
    var m = sfMat(surface[colIdxI(q)]);
    if (t.x >= 0.07) { m = select(u32(t.z + 0.5), 19u, u32(t.z + 0.5) == 0u); }
    if (k == 0) { m0 = m; } else if (m != m0) { return 1.0; }
    let g = veg[colIdxI(q)];
    lo = min(lo, g);
    hi = max(hi, g);
  }
  return select(0.0, 1.0, hi - lo > 0.02);
}

/** Drift surface height at grid corner v: mean (ground + dust) of the dusty columns touching it, or -1. */
fn driftCornerZ(v: vec2<i32>) -> f32 {
  var sum = 0.0;
  var n = 0.0;
  var solid = -1.0;
  var lo = 1e9;
  for (var k = 0; k < 4; k++) {
    let q = v - vec2<i32>(1 - (k & 1), 1 - (k >> 1));
    if (!inMap(q)) { continue; }
    let d = driftAt(q);
    if (d < 0.03) { continue; }
    let g = f32(sfZ(surface[colIdxI(q)]));
    sum += g + d;
    n += 1.0;
    solid = max(solid, g);
    lo = min(lo, g + d);
  }
  // a solid top standing well over another column's dust: no shared sheet
  if (solid - lo > SHEET_STEP) { return -1.0; }
  let c = taperCorner(v, sum, n, 0);
  // never below the solid top of a covered column it touches: soft ground
  // drapes over a step in the rock beneath instead of the rock poking
  // through it along every step (round 16)
  return select(c, max(c, solid + 0.04), c >= 0.0);
}

/** Water surface height at grid corner v: mean level of the wet columns touching it, or -1. */
fn waterCornerZ(v: vec2<i32>) -> f32 {
  var sum = 0.0;
  var n = 0.0;
  var lo = 1e9;
  var hi = -1e9;
  for (var k = 0; k < 4; k++) {
    let q = v - vec2<i32>(1 - (k & 1), 1 - (k >> 1));
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let d = waterDepth[j];
    if (d < 0.012) { continue; }
    let bed = f32(sfZ(surface[j])) + driftAt(q);
    sum += bed + d;
    n += 1.0;
    lo = min(lo, bed + d);
    hi = max(hi, bed);
  }
  // a wet bed standing well over another column's water: no shared sheet
  if (hi - lo > SHEET_STEP) { return -1.0; }
  return taperCorner(v, sum, n, 1);
}

/**
 * Corner level of a sheet (drift or water): the mean of the covered columns,
 * pulled down toward the dry ground of the uncovered columns touching the
 * corner when it is close by (within 1.5) — so sheets taper into the ground
 * at their edges instead of ending in square box sides (round 12). -1 if no
 * covered column touches the corner.
 */
fn taperCorner(v: vec2<i32>, sum0: f32, n0: f32, kind: u32) -> f32 {
  if (n0 < 1.0) { return -1.0; }
  let level = sum0 / n0;
  var sum = sum0;
  var n = n0;
  for (var k = 0; k < 4; k++) {
    let q = v - vec2<i32>(1 - (k & 1), 1 - (k >> 1));
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let covered = select(driftAt(q) >= 0.03, waterDepth[j] >= 0.012, kind == 1u);
    if (covered) { continue; }
    let g = f32(sfZ(surface[j])) + driftAt(q);
    if (abs(g - level) < 1.5) { sum += g; n += 1.0; }
  }
  return sum / n;
}
// smoothed corner heights for soft ground (terrainshape.wgsl), x = height or -1
@group(0) @binding(16) var cornerOut: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);

  let sun = normalize(vec3<f32>(G.sunX, G.sunY, G.sunZ));
  let horiz = max(length(sun.xy), 1e-3);
  let dir = sun.xy / horiz;
  let tanE = sun.z / horiz;
  let p0 = vec2<f32>(p) + 0.5;
  // (the loose ground's depth counts: it's part of the surface — drawn
  // smoothed, so across the cell it dips below the column's level: start a
  // little lower or the downhill half of every cell shadows itself)
  var sz = f32(sfZ(surface[i])) + driftAt(p) - select(0.0, 0.9, driftAt(p) >= 0.05);
  for (var k = 1; k < 160; k++) {
    let drop = f32(k) * tanE;
    if (f32(G.zMax) - drop <= sz) { break; }
    let q = vec2<i32>(floor(p0 + dir * f32(k)));
    if (!inMap(q)) { break; }
    // soft ground is drawn sloped (terrainshape.wgsl): it casts from about a
    // cell lower than its whole-cell top, so gentle slopes throw no saw-tooth
    let sq = surface[colIdxI(q)];
    // (loose ground is drawn smoothed between columns too)
    let soft = select(0.0, 0.9, MATS[sfMat(sq)].look.x > 0.0 || driftAt(q) >= 0.05);
    sz = max(sz, f32(sfZ(sq)) + driftAt(q) - soft - drop);
  }

  var glow = fire[i];
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let q = p + vec2<i32>(dx, dy);
      if (!inMap(q)) { continue; }
      let fall = 1.0 - length(vec2<f32>(f32(dx), f32(dy))) / 3.2;
      glow = max(glow, fire[colIdxI(q)] * fall);
    }
  }

  fields[i] = vec4<f32>(sz, moisture[i], glow, length(netFlow(p)));
  textureStore(cornerOut, p, vec4<f32>(computeCornerZ(p), waterCornerZ(p), driftCornerZ(p), mixedCorner(p)));
}
