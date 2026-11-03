// ---- the flora library's look and wind (round 117; src/flora) --------------------------------------------------
// One place for how a generated plant moves and is coloured, shared by the game's instanced draw (meshinst.wgsl) and
// the flora viewer page (src/flora/viewer.wgsl): what the viewer shows is what the game draws. Needs common.wgsl
// (randv, the season through G.rules.w) and the library's constants (FLORA_COL: 6 vec4s a kind — bark (w deciduous),
// bark mark (w sway stiffness), leaf dark, leaf light, autumn, flower; FLORA_ACC: the accent a kind).
//
// A vertex's part (src/flora/mesh.ts PART): 3 wood, 4 leaf, 5 blade, 6 petal, 7 root, 8 accent.

// (round 125, forest: the user's foliage matrix, docs/design/FOLIAGE_WIND.md) which of the wind's treatments are on, a
// bit each — set per pipeline (renderer.ts, ?fwind=): 1 the sway as it was (the column's lean, the leaves' flutter, the
// meadow's wave: the grass's 1B vertex bending), 2 the 1A wind-shading ripple (the canopy and the meadow brighten and
// darken as a gust runs over them: fragment only, the silhouette stays), 4 the 1C coarse lattice (a tree's crown moved
// by eight control points of a traveling gust field, its foot anchored: the gust ripples through the canopy). 0: the
// static baseline (nothing moves), the matrix's row 0.
override FWIND: u32 = 7u;

/**
 * (round 125, 1C/1A) The traveling gust at world point q (window xy + the window's origin `org`, so it stays with the
 * land): 0..1, a front running downwind `wd` with a slow wobble across it; `amp` the wind's strength (the column's
 * lean over its full, ~1 at a strong wind).
 */
fn floraGust(q: vec2<f32>, org: vec2<f32>, wd: vec2<f32>, amp: f32, time: f32) -> f32 {
  let w = q + org;
  let ph = dot(w, wd) * 0.18 - time * (1.4 + 0.7 * amp) + 2.2 * vnoise(w * 0.045);
  return 0.5 + 0.5 * sin(ph);
}

/**
 * (round 125, 1C) The coarse lattice: a tree's crown moved by the gust field at eight control points round it (a box
 * `R` cells out from its foot, from a third of its height `H` to its top), blended trilinearly at the vertex `wp`
 * (world) — so a gust passes through the canopy, one side then the other, the crown keeping its shape. Its foot stays:
 * the offset is scaled by the vertex's sway weight. Downwind mostly, a little across, a dip as it bows.
 */
fn floraLattice(wp: vec3<f32>, foot: vec3<f32>, H: f32, R: f32, swayW: f32, lean: vec2<f32>, stiff: f32, org: vec2<f32>, time: f32) -> vec3<f32> {
  let amp = length(lean) / 0.3;
  var wd = lean / max(length(lean), 1e-4);
  if (length(lean) < 1e-3) { wd = vec2<f32>(0.8, 0.6); }
  let across = vec2<f32>(-wd.y, wd.x);
  let u = clamp((wp.xy - foot.xy) / (2.0 * R) + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
  let w = clamp((wp.z - foot.z - H * 0.33) / (H * 0.67), 0.0, 1.0);
  var off = vec2<f32>(0.0);
  for (var c = 0u; c < 8u; c++) {
    let cx = f32(c & 1u);
    let cy = f32((c >> 1u) & 1u);
    let cz = f32((c >> 2u) & 1u);
    let cp = foot.xy + (vec2<f32>(cx, cy) * 2.0 - 1.0) * R + wd * cz * R * 0.3;
    let g = floraGust(cp, org, wd, amp, time - cz * 0.35);
    // (each control point's push: the gust over its calm share, more at the top)
    let push = wd * (g - 0.35) * (0.25 + 1.1 * amp) + across * (g - 0.5) * 0.25 * (0.2 + amp);
    let k = mix(1.0 - cx, cx, u.x) * mix(1.0 - cy, cy, u.y) * mix(1.0 - cz, cz, w) * (0.55 + 0.45 * cz);
    off += push * k;
  }
  off *= stiff * 0.9 * min(1.0, swayW * 2.5);
  return vec3<f32>(off, -dot(off, off) * 0.02);
}

/**
 * The wind's offset for a vertex of kind k, part `part`, local position `a`, sway weight `sway` (0 at the foot), of a
 * plant standing at `at` (world xy) whose column leans `lean` (sway.wgsl's spring: cells at canopy height). The lean
 * scaled by the species' stiffness; leaves, blades and petals flutter on their own faster beat; grass ripples — a
 * wave running downwind across the meadow (its phase from the plant's place along the wind), so a field of clumps
 * moves as one body of grass. Blades dip as they bow (length kept, roughly).
 */
fn floraSway(k: u32, part: u32, a: vec3<f32>, sway: f32, at: vec2<f32>, lean: vec2<f32>, seed: f32, time: f32) -> vec3<f32> {
  let amp = length(lean) / 0.3;
  var wd = lean / max(length(lean), 1e-4);
  if (length(lean) < 1e-3) { wd = vec2<f32>(0.8, 0.6); }
  let stiff = FLORA_COL[k * 6u + 1u].w;
  var off = lean * stiff;
  if (part == 4u || part == 5u || part == 6u || part == 8u || part == 9u || part == 10u) {
    let beat = sin(time * (3.1 + seed * 1.7) + a.x * 5.0 + a.y * 4.0 + seed * 40.0);
    off = off + wd * beat * (0.035 + 0.05 * amp) * stiff;
  }
  if (part == 5u || part == 6u || part == 8u) {
    let wave = sin(dot(at, wd) * 0.45 - time * (1.6 + 0.8 * amp));
    off = off + wd * (0.5 + 0.5 * wave) * (0.08 + 0.25 * amp) * stiff;
  }
  return vec3<f32>(off * sway, -dot(off, off) * sway * sway * 0.25);
}

/** A flora fragment's colour (sRGB-ish albedo, before toLinear) and, in w, its material (MAT_*), or −1: discard. */
fn floraLook(k: u32, part: u32, wpos: vec3<f32>, n: vec3<f32>, h: f32, rnd: f32, salt: u32) -> vec4<f32> {
  let b = k * 6u;
  let fr = randv(vec3<i32>(floor(wpos * 1.7)) + vec3<i32>(i32(salt & 255u), 5, 11));
  let decid = FLORA_COL[b].w > 0.5;
  var c = FLORA_COL[b].rgb;
  var mat = f32(MAT_WOOD);
  if (part == 3u || part == 7u) {
    let markC = FLORA_COL[b + 1u].rgb;
    // (round 128, treegen) the bark's texture by the species' parameters (species.ts BarkLook, FLORA_BARK): furrows,
    // plates, stripes and roughness over the base colour, in the mark colour — round 125's two styles (the elder's
    // ridges, the birch's lenticels) are two settings of it
    let bk0 = FLORA_BARK[k * 2u];
    let bk1 = FLORA_BARK[k * 2u + 1u];
    if (bk0.x > 0.0) {
      // furrows: long vertical grooves, darker in them
      let q = vec3<i32>(floor(wpos * vec3<f32>(bk0.y, bk0.y, 0.6)));
      let groove = randv(q) < bk0.x * 0.375;
      c = mix(c, markC, select(0.0, 0.8, groove) + 0.3 * bk0.x * fr);
    }
    if (bk0.z > 0.0) {
      // plates: the face's across-coordinate and its height cut into staggered plates, cracks between them in the
      // mark colour, each plate its own shade (a pine's scales)
      let t = normalize(vec2<f32>(-n.y, n.x) + vec2<f32>(1e-4, 0.0));
      var pq = vec2<f32>(dot(wpos.xy, t), wpos.z / 1.7) / max(bk0.w, 0.05);
      let row = floor(pq.y);
      pq.x += 0.5 * fract(row * 0.5) * 2.0 + 0.3 * randv(vec3<i32>(i32(row), 41, 7));
      let id = floor(pq);
      let f = fract(pq);
      let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y) * 1.4);
      let shade = 0.82 + 0.36 * randv(vec3<i32>(i32(id.x), i32(id.y), 23));
      c = mix(c, mix(markC, c * shade, smoothstep(0.04, 0.14, edge)), bk0.z);
    }
    if (bk1.x > 0.0) {
      // stripes: dark dashes across the trunk (a birch's lenticels)
      let q = vec3<i32>(floor(wpos * vec3<f32>(2.5, 2.5, bk1.y)));
      if (randv(q) < bk1.x) { c = markC; }
    }
    if (bk1.z > 0.0) {
      // roughness: broad pale and grey streaks up the trunk, and warm patches (the elder's reference beech)
      let streak = randv(vec3<i32>(floor(wpos * vec3<f32>(0.9, 0.9, 0.22))) + vec3<i32>(3, 7, 1));
      c *= (1.0 - 0.25 * bk1.z) + 0.4 * bk1.z * streak;
      c = mix(c, c * vec3<f32>(1.08, 1.0, 0.86), min(1.0, bk1.z / 0.8) * smoothstep(0.6, 0.9, randv(vec3<i32>(floor(wpos * 0.5)) + vec3<i32>(11, 2, 5))));
    }
    // (round 128, the close-up level — FLORA_EPI.w: the bark's finer octave, a grain of short vertical strands)
    if (FLORA_EPI[k].w > 0.5) { c *= 0.88 + 0.24 * randv(vec3<i32>(floor(wpos * vec3<f32>(8.0, 8.0, 1.6))) + vec3<i32>(7, 1, 3)); }
    let ridged = FLORA_COL[b + 3u].w > 0.5;
    c = c * select(1.0, select(0.7, 0.92, ridged), part == 7u) * (0.88 + 0.2 * rnd);
    // (round 125) moss on the foot's upward faces — the roots' backs, the buttresses' tops (the accent colour)
    let moss = FLORA_COL[b + 2u].w;
    if (moss > 0.0) {
      let low = select(1.0 - smoothstep(0.004, 0.03, h), 1.0, part == 7u);
      // (the roots' flares mossier: a root is moss wherever it faces at all up)
      // (on the roots' tops only, in patches: lab8 — moss on every root face read as giant green leaves at the foot)
      let up = smoothstep(0.35, 0.75, n.z + 0.25 * (fr - 0.5));
      let spot = select(1.0, step(0.45, randv(vec3<i32>(floor(wpos * 0.9)) + vec3<i32>(17, 3, 9))), part == 7u);
      let m = moss * low * up * spot;
      if (m > 0.35) { c = FLORA_ACC[k].rgb * (0.75 + 0.45 * fr); }
    }
    // (round 128, treegen) epiphytes in the look (FLORA_EPI): lichen crusts anywhere on the bark, moss on the limbs'
    // upper faces all the way up
    let ep = FLORA_EPI[k];
    if (ep.x > 0.0 && part == 3u) {
      let lc = randv(vec3<i32>(floor(wpos * 2.2)) + vec3<i32>(5, 29, 13));
      if (lc < ep.x * 0.3) { c = mix(vec3<f32>(0.66, 0.7, 0.58), vec3<f32>(0.78, 0.62, 0.3), step(0.8, fr)) * (0.85 + 0.25 * fr); }
    }
    if (ep.y > 0.0 && part == 3u) {
      let up = smoothstep(0.3, 0.7, n.z + 0.3 * (fr - 0.5));
      let spot = randv(vec3<i32>(floor(wpos * 1.3)) + vec3<i32>(31, 7, 2));
      if (up * step(1.0 - ep.y, spot) > 0.5) { c = vec3<f32>(0.3, 0.42, 0.13) * (0.75 + 0.45 * fr); }
    }
    // (round 128) winter: ice glazes the bark (paler, bluer), snow lies on its upper faces
    let snow = seasonSnow();
    if (snow > 0.0) {
      c = mix(c, c * 0.7 + vec3<f32>(0.2, 0.25, 0.32), 0.35 * snow);
      if (n.z > 0.45 - 0.2 * fr && fr < snow * 0.95) {
        c = vec3<f32>(0.9, 0.93, 0.97) * (0.92 + 0.08 * fr);
        mat = f32(MAT_SNOW);
      }
    }
  } else if (part == 4u) {
    mat = f32(MAT_LEAVES);
    c = mix(FLORA_COL[b + 2u].rgb, FLORA_COL[b + 3u].rgb, clamp(0.2 + 0.5 * h + 0.25 * n.z + 0.25 * (fr - 0.5) + 0.12 * (rnd - 0.5), 0.0, 1.0));
    // winter: a deciduous crown thins to its twigs (faces drop out by their own hash as the season bares it) — (round
    // 128) a share stay as the twigs' haze: the crown's fine twigs, a dark grey-brown stipple round the limbs, so the
    // bare tree keeps its crown's shape and doesn't read as a pole
    if (decid && fr < seasonBare() * 0.92) {
      let fr2 = randv(vec3<i32>(floor(wpos * 3.1)) + vec3<i32>(9, i32(salt & 63u), 4));
      if (fr2 > 0.38) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
      c = mix(FLORA_COL[b + 1u].rgb, FLORA_COL[b].rgb, 0.35) * vec3<f32>(0.62, 0.55, 0.52) * (0.8 + 0.4 * fr2);
      mat = f32(MAT_WOOD);
      if (seasonSnow() * 0.8 > fr2 && n.z > 0.2) { c = vec3<f32>(0.88, 0.91, 0.96); mat = f32(MAT_SNOW); }
      return vec4<f32>(c, mat);
    }
    if (decid) {
      let sc = smoothstep(0.0, 0.3, seasonColour() * 1.3 - rnd * 0.3);
      c = mix(c, FLORA_COL[b + 4u].rgb * (0.75 + 0.35 * fr) * (0.72 + 0.3 * n.z), sc);
    }
    // (round 128, close-up: the leaves' own grain, finer than a cluster)
    if (FLORA_EPI[k].w > 0.5) { c *= 0.86 + 0.28 * randv(vec3<i32>(floor(wpos * 5.0)) + vec3<i32>(2, 9, 4)); }
    // (round 128) in flower: a share of the clusters bloom (spring, as the crowns come back)
    let bl = FLORA_EPI[k].z * seasonBloom();
    if (bl > 0.0 && randv(vec3<i32>(floor(wpos * 1.1)) + vec3<i32>(3, 3, 41)) < bl) {
      c = FLORA_COL[b + 5u].rgb * (0.86 + 0.22 * fr);
      mat = f32(MAT_FLOWER);
    }
    // (round 128) snow on the evergreens' upper faces: the snow-laden conifer
    let sn = seasonSnow();
    if (sn > 0.0 && n.z > 0.25 - 0.3 * fr && fr < sn * 0.9) { c = vec3<f32>(0.9, 0.93, 0.97) * (0.9 + 0.1 * fr); mat = f32(MAT_SNOW); }
  } else if (part == 5u) {
    mat = f32(MAT_GRASS);
    // blades: dark at the foot, light at the tips (so a meadow reads as blades against its ground)
    c = mix(FLORA_COL[b + 2u].rgb, FLORA_COL[b + 3u].rgb, clamp(0.1 + 0.95 * h + 0.15 * (fr - 0.5), 0.0, 1.0));
    if (decid) { c = seasonGrass(c, fract(rnd * 3.7)); }
    // (round 128) winter: the blades' tips under snow
    if (seasonSnow() * smoothstep(0.35, 0.8, h) > 0.4 + 0.3 * fr) { c = vec3<f32>(0.88, 0.91, 0.95); mat = f32(MAT_SNOW); }
  } else if (part == 6u) {
    mat = f32(MAT_FLOWER);
    // each flower its own colour from a meadow palette, tinted by the species
    let pal = array<vec3<f32>, 4>(vec3<f32>(0.95, 0.95, 0.98), vec3<f32>(0.95, 0.8, 0.2), vec3<f32>(0.75, 0.4, 0.85), vec3<f32>(0.9, 0.3, 0.3));
    c = pal[min(u32(rnd * 4.0), 3u)] * FLORA_COL[b + 5u].rgb * 1.08;
  } else if (part == 9u) {
    // (round 128) an epiphyte's green: ferns in the forks, a vine's leaves — evergreen, snow on top in winter
    mat = f32(MAT_LEAVES);
    c = mix(vec3<f32>(0.14, 0.3, 0.1), vec3<f32>(0.34, 0.52, 0.18), clamp(0.3 + 0.4 * n.z + 0.3 * (fr - 0.5), 0.0, 1.0));
    if (seasonSnow() > 0.5 && n.z > 0.3) { c = vec3<f32>(0.88, 0.91, 0.96); mat = f32(MAT_SNOW); }
  } else if (part == 10u) {
    // (round 128) hanging lines: Spanish-moss grey-green, a few darker lianas
    mat = f32(MAT_LEAVES);
    c = select(vec3<f32>(0.6, 0.64, 0.52), vec3<f32>(0.3, 0.26, 0.17), fr < 0.2) * (0.85 + 0.25 * rnd);
  } else if (part == 11u) {
    // (round 128) icicles: only in deep winter
    if (seasonSnow() < 0.5) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    mat = f32(MAT_ICE);
    c = vec3<f32>(0.78, 0.88, 0.97) * (0.9 + 0.15 * fr);
  } else {
    mat = f32(MAT_GRASS);
    c = FLORA_ACC[k].rgb * (0.85 + 0.3 * fr);
  }
  return vec4<f32>(c, mat);
}
