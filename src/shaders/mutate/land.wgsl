// ---- mutate/land.wgsl: a thread a column of an entry's box (masks.wgsl before it; needs layers.wgsl) ------------
@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> veg: array<f32>;
@group(0) @binding(7) var<storage, read_write> vegNext: array<f32>;
/** molten rock's contract (x depth, y temperature, z the ground's heat, w level): the cracks' glow is the ground's heat */
@group(0) @binding(8) var<storage, read_write> lava: array<vec4<f32>>;
@compute @workgroup_size(8, 8)
fn mutLand(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = MP.box.x + id.x;
  let y = MP.box.y + id.y;
  if (x >= MP.box.z || y >= MP.box.w) { return; }
  let p = vec2<i32>(i32(x), i32(y));
  if (!inMap(p)) { return; }
  let wp = cellPos(p);
  let d = mutD(wp);
  if (d >= 1.0) { return; }
  let w = wp + MP.org.xy;
  let kind = MP.k.x;
  let cs = colSlots(x, y);
  var o: array<vec4<u32>, MUT_OUT>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    o[n] = v;
    n += 1u;
  }
  if (n == 0u) { return; }
  let tv = o[n - 1u];
  let top = ivZ1(tv);
  let tm = ivMat(tv);
  if (tm == MAT_EXTERNAL && top - ivZ0(tv) >= BUILDING_T) { return; }
  let j = colIdxI(p);
  let n0 = n;

  if (kind == MUT_FLOODED) {
    let want = floodLevel(d) - top;
    if (want > 0.05 && want > water[j]) {
      let before = water[j];
      water[j] = want;
      bumpWater(vec2<u32>(x, y), before, want);
    }
    return;
  }
  if (kind == MUT_BURNED) {
    if (!burnIn(w, d)) { return; }
    veg[j] = 0.0;
    vegNext[j] = 0.0;
    // (soil chars to ash on top; rock, sand, paving and what's ash already stay)
    if (tm == MAT_SOIL_U) {
      if (top - ivZ0(tv) <= ASH_T + 0.05) { o[n - 1u] = ivPack(ivZ0(tv), top, MAT_ASH_U, 0u); }
      else {
        o[n - 1u] = ivPack(ivZ0(tv), top - ASH_T, tm, ivAux(tv));
        o[n] = ivPack(top - ASH_T, top, MAT_ASH_U, 0u);
        n += 1u;
      }
    }
  } else if (kind == MUT_MELTED) {
    if (tm == MAT_BASALT_U) {
      // (written already: only its cracks' heat made sure of)
      if (meltT(wp, w, top - 0.4) > 0.0 && meltCrack(w)) { lava[j].z = max(lava[j].z, 1150.0); }
      return;
    }
    let t = meltT(wp, w, top);
    if (t <= 0.0 || top + t + 2.0 >= f32(G.zMax)) { return; }
    o[n] = ivPack(top, top + t, MAT_BASALT_U, 0u);
    n += 1u;
    veg[j] = 0.0;
    vegNext[j] = 0.0;
    if (water[j] > 0.0) {
      let before = water[j];
      water[j] = 0.0;
      bumpWater(vec2<u32>(x, y), before, 0.0);
    }
    if (meltCrack(w)) { lava[j].z = max(lava[j].z, 1150.0); }
  } else if (kind == MUT_BURIED) {
    let mat = u32(MP.p.y);
    if (tm == mat) { return; }
    let t = buryDepth(w, d);
    if (t < 0.15 || top + t + 2.0 >= f32(G.zMax)) { return; }
    o[n] = ivPack(top, top + t, mat, 0u);
    n += 1u;
    veg[j] = 0.0;
    vegNext[j] = 0.0;
  } else { return; }

  if (n == n0 && all(o[n - 1u] == tv)) { return; }
  // more than the column holds: its two lowest joined (what's near the top kept as it is)
  loop {
    if (n <= cs.y) { break; }
    o[0] = ivPack(ivZ0(o[0]), ivZ1(o[1]), ivMat(o[0]), ivAux(o[0]));
    for (var k = 1u; k + 1u < n; k++) { o[k] = o[k + 1u]; }
    n -= 1u;
  }
  for (var k = 0u; k < cs.y; k++) {
    let nv = select(IV_NONE, o[k], k < n);
    let old = layers[cs.x + k];
    if (any(old != nv)) {
      layers[cs.x + k] = nv;
      bumpColumn(vec2<u32>(x, y), old, nv);
    }
  }
}

