// ---- field mesh draw (G13 C, a prototype: fieldmesh.wgsl) ----------------------
// The mesh's vertices are bound where the instances usually are (binding 3):
// two vec4<u32> each. The shape is the field's; the look is the intervals':
// each fragment finds the interval it lies in (one step into the surface)
// and takes that interval's material, so the layers show on a cut slope just
// as they did on a prism's side. Where the structure share is high (a fillet
// against a structure's face; its cubes draw the rest) it's that voxel's
// look instead (its moss and the sand over it, as fsBody draws).
// A detail layer gives the hard and broken materials a rough surface in
// the shading: rock in facets (rockFacet), rubble, trash, litter and ruins in
// chips, each tilted its own way; sand, soil, ash and silt stay smooth.
@group(0) @binding(9) var<storage, read> meshLayers: array<vec4<u32>>;

struct MOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) share: f32,
  @location(3) @interpolate(flat) word: u32,
  // large-scale ground patchiness (as the prisms have it)
  @location(4) tint: f32,
};

@vertex
fn vsMesh(@builtin(vertex_index) vi: u32) -> MOut {
  let a = instances[vi * 2u];
  let b = instances[vi * 2u + 1u];
  let p = vec3<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z));
  var o: MOut;
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  o.wpos = p;
  o.nrm = vec3<f32>(bitcast<f32>(b.x), bitcast<f32>(b.y), bitcast<f32>(b.z));
  o.share = bitcast<f32>(b.w);
  o.word = a.w;
  o.tint = 0.82 + 0.36 * fbm2(p.xy * 0.045 + vec2<f32>(p.z * 0.02));
  return o;
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

/** A material's ground colour (blown dust: a greyer silt). */
fn groundAlbedo(m: u32) -> vec3<f32> {
  if (m == MAT_DRIFT) { return toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
  return toLinear(MATS[m].albedo.rgb);
}

@fragment
fn fsMesh(in: MOut) -> FOut {
  let nrm = normalize(in.nrm);
  // one step into the surface: the interval this point of it belongs to
  let ip = in.wpos - nrm * 0.2;
  // (looked up a little off the point, a quarter cell at random: the borders
  // between cells of different ground come out ragged, not hexagons)
  let jit = vec3<i32>(floor(in.wpos * 4.0 - nrm * 0.02));
  let jo = vec2<f32>(randv(jit + vec3<i32>(41, 0, 0)), randv(jit + vec3<i32>(0, 43, 0))) - 0.5;
  let cell = clampCell(cellAt(terrainWarp(ip) + jo * 0.6));
  let ci = colIdxI(cell);
  let up = nrm.z > 0.55;
  let lk = meshLook(cell, ip.z, up);
  var mat = lk.mat;
  // the cells' own fields blended over the three nearest (no hexagons in
  // the plants or stains): contamination, plants, wetness, withering
  let cf = cellFields(in.wpos.xy);
  let isTop = up && in.wpos.z > lk.top - 0.8;
  var alb = groundAlbedo(mat);
  // a thin top layer shows the one beneath through it (a trace of blown dust
  // doesn't flip the ground's colour — round 17)
  if (isTop && lk.below != 0u) { alb = mix(groundAlbedo(lk.below), alb, smoothstep(0.02, 0.2, lk.thick)); }
  // per-voxel and sub-voxel variation (cell, whole heights), as the prisms had
  let vc = vec3<i32>(cell, i32(floor(ip.z)));
  let sub = vec3<i32>(floor(in.wpos * 4.0 - nrm * 0.02));
  let n1 = randv(sub);
  let n2 = randv(sub + vec3<i32>(71, 13, 5));
  alb *= 0.9 + 0.12 * randv(vc) + 0.08 * n1;
  alb *= in.tint;
  if (mat >= 1u && mat <= 4u) {
    let band = fbm2(in.wpos.xy * 0.11 + vec2<f32>(in.wpos.z * 0.35, 0.0));
    if (mat == 1u) { alb *= mix(vec3<f32>(0.9, 0.92, 0.96), vec3<f32>(1.1, 1.0, 0.9), band); }
    if (mat == 2u) { alb *= mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), band); }
    let pb = randv(sub + vec3<i32>(5, 77, 13));
    if (pb > 0.93) { alb *= 1.25; } else if (pb < 0.05) { alb *= 0.72; }
  }
  if (mat == MAT_TRASH || mat == MAT_LITTER) {
    // faded plastics, paper, glass and rust specks (litter: scraps on dirt), as fsBox
    let k = u32(n2 * 6.0);
    var tc = vec3<f32>(0.45, 0.43, 0.40);
    if (k == 0u) { tc = vec3<f32>(0.42, 0.52, 0.62); }
    else if (k == 1u) { tc = vec3<f32>(0.78, 0.76, 0.70); }
    else if (k == 2u) { tc = vec3<f32>(0.66, 0.38, 0.34); }
    else if (k == 3u) { tc = vec3<f32>(0.38, 0.48, 0.34); }
    else if (k == 4u) { tc = vec3<f32>(0.50, 0.33, 0.20); }
    alb = toLinear(tc) * (0.75 + 0.35 * n1);
    if (mat == MAT_LITTER && n1 < 0.5) { alb = toLinear(vec3<f32>(0.45, 0.36, 0.27)) * (0.85 + 0.3 * n2); }
  }
  if (isTop) {
    let c = cf.x;
    let stain = smoothstep(0.12, 1.1, c);
    let oil = mix(vec3<f32>(0.10, 0.09, 0.06), vec3<f32>(0.42, 0.40, 0.12), smoothstep(0.55, 0.95, n2));
    alb = mix(alb, toLinear(oil), stain * 0.8);
  }
  // wet ground darkens
  alb *= 1.0 - MATS[mat].eco.w * 0.5 * smoothstep(0.15, 0.9, cf.z);
  // plant cover on tops, a few tufts of it up the slopes
  let v = cf.y;
  if (v > 0.0) {
    let cover = select(smoothstep(0.8, 3.0, v) * 0.55 * (0.5 + 0.5 * n2), smoothstep(0.0, 1.2, v), isTop);
    if (n1 < cover) {
      var g = mix(vec3<f32>(0.33, 0.40, 0.17), vec3<f32>(0.36, 0.54, 0.19), smoothstep(1.0, 2.0, v));
      g = mix(g, vec3<f32>(0.17, 0.33, 0.12), smoothstep(3.0, 4.5, v));
      alb = wither(toLinear(g * (0.82 + 0.3 * n2)), cf.w, n2);
    }
  }
  // a structure's face: its moss, and the sand lying against it
  let sw = smoothstep(0.35, 0.65, in.share);
  if (sw > 0.0 && in.word != 0u) {
    let w = in.word;
    let r = randv(vec3<i32>(floor(in.wpos * 1.0 - nrm * 0.02)) + vec3<i32>(3, 9, 27));
    var sa = toLinear(MATS[voxMatR(w)].albedo.rgb) * (0.88 + 0.24 * r);
    let moss = f32((w >> 8u) & 0xffu) / 255.0;
    let sand = f32((w >> 16u) & 0xffu) / 255.0;
    let s = randv(sub + vec3<i32>(13, 5, 71));
    if (s < moss * (0.55 + 0.45 * max(nrm.z, 0.0))) {
      sa = toLinear(mix(vec3<f32>(0.2, 0.33, 0.12), vec3<f32>(0.36, 0.5, 0.2), randv(vec3<i32>(floor(in.wpos * 2.0)) + vec3<i32>(3, 1, 7))));
    }
    if (sand > 0.7 + 0.3 * s) {
      var sc = toLinear(MATS[driftMatAt(cell)].albedo.rgb);
      if (driftMatAt(cell) == MAT_DRIFT) { sc = toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
      sa = sc * (0.9 + 0.2 * s);
    }
    alb = mix(alb, sa, sw);
    if (sw > 0.5) { mat = voxMatR(w); }
  }
  // water on the ground: a film where it runs too thin to clear the
  // smoothed ground (the sheet draws the rest), darker wet ground above the
  // water's edge, and the swash running up and back (round 41)
  let wt = cellWater(in.wpos.xy);
  var film = 0.0;
  var filmN = nrm;
  if (wt.wet > 0.0 && nrm.z > 0.2 && sw < 0.5) {
    film = smoothstep(WATER_MIN_R, 0.05, wt.d);
    let above = in.wpos.z - wt.level;
    let wv = windAt(vec3<f32>(in.wpos.xy, in.wpos.z + 0.5));
    let lw = clamp(length(wv) / 4.0, 0.0, 1.5);
    // the swash: how far up the waves run now (higher in the wind), ragged along the shore
    let along = vnoise(in.wpos.xy * 0.7 + 3.0);
    let run = (0.06 + 0.12 * lw) * (0.55 + 0.45 * sin(G.time * 1.3 + along * 9.0));
    let damp = smoothstep(run + 0.35, run, above) * (1.0 - film);
    alb *= 1.0 - 0.45 * max(film, damp * 0.75) * (0.4 + 0.6 * MATS[mat].eco.w);
    // (a glaze of the water's own colour, more of it the deeper)
    alb = mix(alb, toLinear(vec3<f32>(0.30, 0.45, 0.44)) * 0.75, film * mix(0.3, 0.6, smoothstep(0.05, 0.3, wt.d)));
    // the film's streaks running with the flow, and foam where it's fast
    let fl = length(wt.flow);
    let st = flowStreaks(in.wpos.xy, wt.flow, wt.d) * smoothstep(0.003, 0.04, fl);
    alb += toLinear(vec3<f32>(0.42, 0.48, 0.48)) * film * smoothstep(0.5, 0.9, st) * 0.3;
    let froth = film * smoothstep(0.04, 0.2, fl) * smoothstep(0.62, 0.85, flowStreaks(in.wpos.xy * 1.7, wt.flow, wt.d));
    let lip = smoothstep(0.05, 0.0, abs(above - run)) * (1.0 - film) * smoothstep(0.3, 0.65, vnoise(in.wpos.xy * 2.2 + vec2<f32>(G.time * 0.35, 0.0)));
    alb = mix(alb, toLinear(vec3<f32>(0.82, 0.84, 0.82)), max(froth * 0.6, lip * 0.55 * (0.4 + 0.6 * lw)));
    filmN = windWaves(in.wpos.xy, in.wpos.z, 0.25 + 0.5 * lw);
  }
  // the detail layer (only where a chip is a few pixels across)
  var lnrm = nrm;
  if (CAM.viewport.z > 4.0 && sw < 0.5) {
    if (mat == MAT_STONE) {
      let rf = rockFacet(in.wpos, nrm, 1.0);
      lnrm = rf.xyz;
      alb *= rf.w;
    } else if (jagged(mat)) {
      // chips a quarter cell across (the colour specks' own grid)
      let chip = vec3<i32>(floor(in.wpos * 4.0 - nrm * 0.1));
      let t = vec3<f32>(randv(chip + vec3<i32>(1, 0, 0)), randv(chip + vec3<i32>(0, 1, 0)), randv(chip + vec3<i32>(0, 0, 1))) - 0.5;
      lnrm = normalize(nrm + (t - nrm * dot(t, nrm)) * 1.3);
      // a darker gap between chips
      let f = fract(in.wpos * 4.0 - nrm * 0.1);
      let edge = min(min(f.x, 1.0 - f.x), min(min(f.y, 1.0 - f.y), min(f.z, 1.0 - f.z)));
      alb *= 0.8 + 0.2 * smoothstep(0.0, 0.12, edge);
    }
  }
  // (water smooths the rough ground it covers)
  lnrm = normalize(mix(lnrm, nrm, film * 0.8));
  var col = alb * lighting(in.wpos, lnrm);
  if (film > 0.0) {
    // the wet sheen: the sun's glint off the film
    let sunL = sunDir();
    let fn2 = normalize(nrm + vec3<f32>(filmN.xy, 0.0));
    let hv = normalize(normalize(sunL + CAM.eye.xyz) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(dot(fn2, hv), 0.0), 120.0) * (1.0 - cloudShade(in.wpos.xy)) * shadowLit(in.wpos, nrm);
    col += G.sunCol.rgb * (1.0 / 2.4) * spec * 0.6 * film;
    // and the sky in it
    col += G.sky.rgb * 0.08 * film;
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(ci + 1u, mat | (u32(max(in.wpos.z, 0.0)) << 8u));
  return o;
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

fn voxMatR(w: u32) -> u32 { return w & 0xffu; }

/** Broken or built: rubble, trash, litter, and every solid but stone (ruins: concrete, brick, asphalt, steel). */
fn jagged(m: u32) -> bool {
  return m == 4u || m == MAT_TRASH || m == MAT_LITTER || (matState(m) == ST_SOLID && m != MAT_STONE);
}
