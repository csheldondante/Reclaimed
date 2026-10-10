// ---- slope.wgsl ----------------------------------------------------------------
// Local ground steepness: max height difference to neighbours two cells away,
// per cell. The including shader must declare
//   var<storage, read> surface: array<u32>;
// Biomes: flat ground holds water and grows woodland; slopes drain, stay meadow.
fn slopeAt(p: vec2<i32>) -> f32 {
  let z = f32(sfZ(surface[colIdxI(p)])) + driftAt(p);
  var m = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let q = clampCell(p + DIRS[k] * 2);
    m = max(m, abs(f32(sfZ(surface[colIdxI(q)])) + driftAt(q) - z));
  }
  return m * 0.5;
}

/** 1 on flat ground, 0 on steep ground. */
fn flatness(p: vec2<i32>) -> f32 {
  return 1.0 - smoothstep(0.4, 1.6, slopeAt(p));
}
