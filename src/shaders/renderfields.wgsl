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
@group(0) @binding(6) var<storage, read> flux: array<Dirs>;
@group(0) @binding(7) var<storage, read_write> fields: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> waterDepth: array<f32>;
@group(0) @binding(9) var<storage, read> veg: array<f32>;

/**
 * 1 where cell p's top material (the loose sheet's where there's a fair
 * depth of it) or plant cover differs from any neighbour's: only there do
 * draw shaders vote on soft borders (render.wgsl edgeLook).
 */
fn mixedCell(p: vec2<i32>) -> f32 {
  var m0 = 0xffffffffu;
  var lo = 1e9;
  var hi = -1e9;
  for (var k = 0u; k <= NDIR; k++) {
    let q = clampCell(select(nbr(p, min(k, NDIR - 1u)), p, k == NDIR));
    let t = textureLoad(driftTex, q, 0);
    var m = sfMat(surface[colIdxI(q)]);
    if (t.x >= 0.07) { m = select(u32(t.z + 0.5), 19u, u32(t.z + 0.5) == 0u); }
    if (k == 0u) { m0 = m; } else if (m != m0) { return 1.0; }
    let g = veg[colIdxI(q)];
    lo = min(lo, g);
    hi = max(hi, g);
  }
  return select(0.0, 1.0, hi - lo > 0.02);
}

/** Drift surface height at owned corner `slot` of p: mean (ground + dust) of the dusty columns touching it, or -1. */
fn driftCornerZ(p: vec2<i32>, slot: u32) -> f32 {
  let ring = cornerRing(p, slot);
  var sum = 0.0;
  var n = 0.0;
  var solid = -1.0;
  var lo = 1e9;
  for (var k = 0u; k < 3u; k++) {
    let q = ring[k];
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
  let c = taperCorner(ring, sum, n, 0u);
  // never below the solid top of a covered column it touches: soft ground
  // drapes over a step in the rock beneath instead of the rock poking
  // through it along every step (round 16)
  return select(c, max(c, solid + 0.04), c >= 0.0);
}

/** Water surface height at owned corner `slot` of p: mean level of the wet columns touching it, or -1. */
fn waterCornerZ(p: vec2<i32>, slot: u32) -> f32 {
  let ring = cornerRing(p, slot);
  var sum = 0.0;
  var n = 0.0;
  var lo = 1e9;
  var hi = -1e9;
  for (var k = 0u; k < 3u; k++) {
    let q = ring[k];
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
  return taperCorner(ring, sum, n, 1u);
}

/**
 * Corner level of a sheet (drift or water): the mean of the covered columns,
 * pulled down toward the dry ground of the uncovered columns touching the
 * corner when it is close by (within 1.5) — so sheets taper into the ground
 * at their edges instead of ending in box sides (round 12). -1 if no
 * covered column touches the corner.
 */
fn taperCorner(ring: array<vec2<i32>, 6>, sum0: f32, n0: f32, kind: u32) -> f32 {
  if (n0 < 1.0) { return -1.0; }
  let level = sum0 / n0;
  var sum = sum0;
  var n = n0;
  for (var k = 0u; k < 3u; k++) {
    let q = ring[k];
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let covered = select(driftAt(q) >= 0.03, waterDepth[j] >= 0.012, kind == 1u);
    if (covered) { continue; }
    let g = f32(sfZ(surface[j])) + driftAt(q);
    if (abs(g - level) < 1.5) { sum += g; n += 1.0; }
  }
  return sum / n;
}
// hex corner values (terrainshape.wgsl; 2w × h, two owned corners per cell):
// x ground height or -1, y water level or -1, z drift level or -1, w (slot 0
// only) 1 where the cell's look differs from a neighbour's
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
  let p0 = cellPos(p);
  // (the loose ground's depth counts: it's part of the surface — drawn
  // smoothed, so across the cell it dips below the column's level: start a
  // little lower or the downhill half of every cell shadows itself)
  var sz = f32(sfZ(surface[i])) + driftAt(p) - select(0.0, 0.9, driftAt(p) >= 0.05);
  // (with the field mesh the sun's shadow map gives the shadows: no march)
  for (var k = 1; k < 160 && MR.n.w == 0u; k++) {
    let drop = f32(k) * tanE;
    if (f32(G.zMax) - drop <= sz) { break; }
    let q = cellAt(p0 + dir * f32(k));
    if (!inMap(q)) { break; }
    // soft ground is drawn sloped (terrainshape.wgsl): it casts from about a
    // cell lower than its whole-cell top, so gentle slopes throw no saw-tooth
    let sq = surface[colIdxI(q)];
    // (loose ground is drawn smoothed between columns too)
    let soft = select(0.0, 0.9, MATS[sfMat(sq)].look.x > 0.0 || driftAt(q) >= 0.05);
    sz = max(sz, f32(sfZ(sq)) + driftAt(q) - soft - drop);
  }

  var glow = fire[i];
  // (the cells within two rings: the same 2.5-cell radius as before)
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let q = p + vec2<i32>(dx, dy);
      if (!inMap(q)) { continue; }
      let dd = length(cellPos(q) - p0);
      if (dd > 2.5) { continue; }
      glow = max(glow, fire[colIdxI(q)] * (1.0 - dd / 3.2));
    }
  }

  // (with the field mesh no march reads x: the flow's direction goes in x
  // and w, for the water's streaks — render.wgsl flowOf)
  let fv = netFlow(p);
  if (MR.n.w != 0u) { fields[i] = vec4<f32>(fv.x, moisture[i], glow, fv.y); }
  else { fields[i] = vec4<f32>(sz, moisture[i], glow, length(fv)); }
  // the six corners (my two, and the four my neighbours own — the same
  // functions on the same inputs, so the same values they store), and the
  // planes of my tops through them (terrainshape.wgsl); a corner that isn't
  // shared stands at my own top there, as the prism draws it
  let gTop = f32(sfZ(surface[i]));
  let dTop = gTop + driftAt(p);
  let wTop = dTop + waterDepth[i];
  var cen = vec3<f32>(0.0);
  var gG = vec2<f32>(0.0);
  var gW = vec2<f32>(0.0);
  var gD = vec2<f32>(0.0);
  var own: array<vec3<f32>, 2>;
  for (var j = 0u; j < 6u; j++) {
    let o = cornerOwner(p, j);
    var cv = vec3<f32>(-1.0);
    if (o.x >= 0) {
      let s = u32(o.z);
      // (the field mesh draws the ground and the dust: only water's corners)
      if (MR.n.w != 0u) { cv.y = waterCornerZ(o.xy, s); }
      else { cv = vec3<f32>(computeCornerZ(o.xy, s), waterCornerZ(o.xy, s), driftCornerZ(o.xy, s)); }
    }
    if (j < 2u) { own[j] = cv; }
    let h = select(cv, vec3<f32>(gTop, wTop, dTop), cv < vec3<f32>(0.0));
    let off = cornerOffset(j);
    cen += h;
    gG += h.x * off;
    gW += h.y * off;
    gD += h.z * off;
  }
  let k = 1.0 / (3.0 * HEX_R * HEX_R);
  textureStore(cornerOut, vec2<i32>(p.x * CT, p.y), vec4<f32>(own[0], select(mixedCell(p), 0.0, MR.n.w != 0u)));
  textureStore(cornerOut, vec2<i32>(p.x * CT + 1, p.y), vec4<f32>(own[1], 0.0));
  textureStore(cornerOut, vec2<i32>(p.x * CT + 2, p.y), vec4<f32>(cen / 6.0, 0.0));
  textureStore(cornerOut, vec2<i32>(p.x * CT + 3, p.y), vec4<f32>(gG * k, gW * k));
  textureStore(cornerOut, vec2<i32>(p.x * CT + 4, p.y), vec4<f32>(gD * k, 0.0, 0.0));
}
