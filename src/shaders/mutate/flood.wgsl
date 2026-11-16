// ---- mutate/flood.wgsl: a flood written into a box of the window, a thread a column (masks.wgsl before it) -------
// Its own kernel (land.wgsl's is at the eight storage buffers a stage may bind): water raised to the level over each
// column's top, never lowered, and the water it adds is the river's — clean. The water's look takes the column's
// dissolved contamination (render/water.wgsl: contam.y over the depth); what a dry column kept there turned the first
// floods into an opaque olive-brown sheet over the town, so it is cleared where water is added.
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> contam: array<vec2<f32>>;
@group(0) @binding(7) var<storage, read_write> contamNext: array<vec2<f32>>;

@compute @workgroup_size(8, 8)
fn mutFlood(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = MP.box.x + id.x;
  let y = MP.box.y + id.y;
  if (x >= MP.box.z || y >= MP.box.w) { return; }
  let p = vec2<i32>(i32(x), i32(y));
  if (!inMap(p)) { return; }
  let d = mutD(cellPos(p));
  // (short of the rim by a hair: a column on the circle itself is outside it)
  if (d >= 0.98) { return; }
  let cs = colSlots(x, y);
  var tv = IV_NONE;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    tv = v;
  }
  if (ivEmpty(tv)) { return; }
  let top = ivZ1(tv);
  if (ivMat(tv) == MAT_EXTERNAL && top - ivZ0(tv) >= BUILDING_T) { return; }
  let j = colIdxI(p);
  let want = floodLevel(d) - top;
  let before = water[j];
  if (want > 0.05 && want > before) {
    water[j] = want;
    // (what was dissolved in the water that stood here is thinned by what came; a dry column's is gone)
    let keep = before / want;
    contam[j].y = contam[j].y * keep;
    contamNext[j].y = contamNext[j].y * keep;
    bumpWater(vec2<u32>(x, y), before, want);
  }
}
