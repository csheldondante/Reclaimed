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
  if (part == 4u || part == 5u || part == 6u || part == 8u) {
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
    if (FLORA_COL[b + 3u].w > 0.5) {
      // (round 125, forest) ridged bark (the elder): long vertical grooves, darker in them, and a broad light and dark
      // banding round the trunk — a pale trunk that reads as bark, not plaster, in a few pixels
      let q = vec3<i32>(floor(wpos * vec3<f32>(3.0, 3.0, 0.6)));
      let groove = randv(q) < 0.3;
      c = mix(c, markC, select(0.0, 0.8, groove) + 0.25 * fr);
      // (roots as pale as the trunk: the reference's sprawl is the same bark)
    } else if (length(markC - c) > 0.1) {
      // birch bark: white, with dark lenticel marks across the trunk
      let q = vec3<i32>(floor(wpos * vec3<f32>(2.5, 2.5, 7.0)));
      if (randv(q) < 0.2) { c = markC; }
    }
    let ridged = FLORA_COL[b + 3u].w > 0.5;
    c = c * select(1.0, select(0.7, 0.92, ridged), part == 7u) * (0.88 + 0.2 * rnd);
    // (round 125) moss on the foot's upward faces — the roots' backs, the buttresses' tops (the accent colour)
    let moss = FLORA_COL[b + 2u].w;
    if (moss > 0.0) {
      let low = select(1.0 - smoothstep(0.004, 0.03, h), 1.0, part == 7u);
      let m = moss * low * smoothstep(0.15, 0.6, n.z + 0.25 * (fr - 0.5));
      if (m > 0.35) { c = FLORA_ACC[k].rgb * (0.75 + 0.45 * fr); }
    }
  } else if (part == 4u) {
    mat = f32(MAT_LEAVES);
    // winter: a deciduous crown thins to its twigs (faces drop out by their own hash as the season bares it)
    if (decid && fr < seasonBare() * 0.92) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    c = mix(FLORA_COL[b + 2u].rgb, FLORA_COL[b + 3u].rgb, clamp(0.2 + 0.5 * h + 0.25 * n.z + 0.25 * (fr - 0.5) + 0.12 * (rnd - 0.5), 0.0, 1.0));
    if (decid) {
      let sc = smoothstep(0.0, 0.3, seasonColour() * 1.3 - rnd * 0.3);
      c = mix(c, FLORA_COL[b + 4u].rgb * (0.75 + 0.35 * fr) * (0.72 + 0.3 * n.z), sc);
    }
  } else if (part == 5u) {
    mat = f32(MAT_GRASS);
    // blades: dark at the foot, light at the tips (so a meadow reads as blades against its ground)
    c = mix(FLORA_COL[b + 2u].rgb, FLORA_COL[b + 3u].rgb, clamp(0.1 + 0.95 * h + 0.15 * (fr - 0.5), 0.0, 1.0));
    if (decid) { c = seasonGrass(c, fract(rnd * 3.7)); }
  } else if (part == 6u) {
    mat = f32(MAT_FLOWER);
    // each flower its own colour from a meadow palette, tinted by the species
    let pal = array<vec3<f32>, 4>(vec3<f32>(0.95, 0.95, 0.98), vec3<f32>(0.95, 0.8, 0.2), vec3<f32>(0.75, 0.4, 0.85), vec3<f32>(0.9, 0.3, 0.3));
    c = pal[min(u32(rnd * 4.0), 3u)] * FLORA_COL[b + 5u].rgb * 1.08;
  } else {
    mat = f32(MAT_GRASS);
    c = FLORA_ACC[k].rgb * (0.85 + 0.3 * fr);
  }
  return vec4<f32>(c, mat);
}
