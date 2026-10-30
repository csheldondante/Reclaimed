// ---- (round 113, `tilesfirst`, the streaming design's step 5.1) the mesh's look's sources ------------------------
// What meshdraw.wgsl's look (meshSurf) and the hybrid grid (gridVertex) read of the land, behind these names only: a
// column's top (gridTop), its intervals' look at a height (meshLook), its fields blended (cellFields, cellFields1), the
// water round a point (cellWater), the strata at a point (srcStrata), whether its sim sleeps (srcAsleep), the loose
// ground's material (srcDriftMat), the pick's column (srcPickCol). This file is the window's: its layers, surface,
// drift, fields, water, through the window's chunk table and ring. A region's height grid (step 5) gives the same
// names from its own compact record, so the look is the same code. Moved here verbatim from meshdraw.wgsl (the window's
// image is the same, pixel for pixel: scripts/srcsplit.mjs checks the declarations); included before it.
@group(0) @binding(9) var<storage, read> meshLayers: array<vec4<u32>>;

/** column q's top (window z): its surface and what's loose on it (as cellWater's level) */
fn gridTop(q: vec2<i32>) -> f32 {
  let c = clampCell(q);
  return sfZ(surface[colIdxI(c)]) + driftAt(c);
}

/** What a fragment of column q's surface is made of: x its material, y the
 *  material under it (0 none), z how thick its layer is, w the top of its
 *  solid run (both as bits). */
struct Look { mat: u32, below: u32, thick: f32, top: f32 };

/**
 * The interval holding height z in column q (else the nearest). A top-facing
 * fragment within a cell of its solid run's top takes the run's top layer
 * however thin it is (the smoothed surface runs a little above or below the
 * tops), and the layer under that one, which shows through a thin top layer
 * as on the prisms' sheets.
 */
fn meshLook(q: vec2<i32>, z: f32, up: bool) -> Look {
  let cs = colSlots(u32(q.x), u32(q.y));
  var best = 1e9;
  var at = 0u;
  var n = 0u;
  for (var i = 0u; i < cs.y; i++) {
    let v = meshLayers[cs.x + i];
    if (ivEmpty(v)) { break; }
    n = i + 1u;
    let d = max(ivZ0(v) - z, z - ivZ1(v));
    if (d < best) {
      best = d;
      at = i;
    }
  }
  if (n == 0u) { return Look(MAT_STONE, 0u, 1.0, 0.0); }
  // up its run to the top (touching intervals)
  var t = at;
  while (t + 1u < n && abs(ivZ0(meshLayers[cs.x + t + 1u]) - ivZ1(meshLayers[cs.x + t])) < 1e-3) { t += 1u; }
  let runTop = ivZ1(meshLayers[cs.x + t]);
  if (up && z > runTop - 1.0) { at = t; }
  let v = meshLayers[cs.x + at];
  var below = 0u;
  if (at > 0u && abs(ivZ0(v) - ivZ1(meshLayers[cs.x + at - 1u])) < 1e-3) { below = ivMat(meshLayers[cs.x + at - 1u]); }
  return Look(ivMat(v), below, ivZ1(v) - ivZ0(v), runTop);
}

/** (perfopt, ?nodetail=fields) the cell's own fields, not blended over three */
fn cellFields1(xy: vec2<f32>) -> vec4<f32> {
  let j = colIdxI(clampCell(cellAt(xy)));
  return vec4<f32>(contam[j].x, veg[j], fields[j].y, wilt[j].y);
}

/** contamination, plant cover, wetness and withering at xy, blended barycentrically over the three nearest cells. */
fn cellFields(xy: vec2<f32>) -> vec4<f32> {
  let t = triAt(xy);
  var o = vec4<f32>(0.0);
  for (var k = 0; k < 3; k++) {
    let j = colIdxI(clampCell(t.c[k]));
    o += t.w[k] * vec4<f32>(contam[j].x, veg[j], fields[j].y, wilt[j].y);
  }
  return o;
}

/** The water round xy over the three nearest cells: its depth (blended),
 *  its level over the wet ones and their share, and its flow (blended). */
struct CellWater { d: f32, level: f32, wet: f32, flow: vec2<f32> };
fn cellWater(xy: vec2<f32>) -> CellWater {
  let t = triAt(xy);
  var o = CellWater(0.0, 0.0, 0.0, vec2<f32>(0.0));
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    let j = colIdxI(q);
    let dk = water[j];
    o.d += t.w[k] * dk;
    if (inMap(t.c[k]) && dk > WATER_MIN_R) {
      o.level += t.w[k] * (f32(sfZ(surface[j])) + driftAt(q) + dk);
      o.wet += t.w[k];
      o.flow += t.w[k] * flowOf(j);
    }
  }
  if (o.wet > 0.0) { o.level /= o.wet; }
  return o;
}

/** the strata band at p (render.wgsl strata) */
fn srcStrata(p: vec3<f32>) -> f32 { return strata(p); }
/** column q's sim asleep (common.wgsl asleep) */
fn srcAsleep(q: vec2<i32>) -> bool { return asleep(vec2<u32>(q)); }
/** the loose ground's material on column q (common.wgsl driftMatAt) */
fn srcDriftMat(q: vec2<i32>) -> u32 { return driftMatAt(q); }
/** the pick's column for q, window order (common.wgsl winIdx) */
fn srcPickCol(q: vec2<i32>) -> u32 { return winIdx(q); }
