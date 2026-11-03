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

/** (round 128) Voronoi: x the nearest feature's distance, y the second's, z the nearest cell's hash */
fn floraVoronoi(p: vec2<f32>) -> vec3<f32> {
  let i = floor(p);
  var f1 = 9.0;
  var f2 = 9.0;
  var id = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = i + vec2<f32>(f32(x), f32(y));
      let ci = vec2<i32>(c);
      let q = c + vec2<f32>(randv(vec3<i32>(ci, 77)), randv(vec3<i32>(ci, 78)));
      let d = length(p - q);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = randv(vec3<i32>(ci, 79));
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec3<f32>(f1, f2, id);
}

/**
 * (round 128) The bark's height at stem coordinates st (u round, v along, cells): x the height 0 (in a groove or
 * crack) .. 1 (the bark's face), y the plate's own shade, z 1 on a lenticel (a birch's dash). By the species' BarkLook
 * (FLORA_BARK): furrows (ridges along the stem, wandering), plates (Voronoi cells and the cracks between them), stripes
 * (horizontal dashes). `fw` cells a pixel: a feature under ~2 pixels fades out (no shimmer).
 */
fn floraBarkH(k: u32, st: vec2<f32>, fw: f32) -> vec3<f32> {
  let bk0 = FLORA_BARK[k * 2u];
  let bk1 = FLORA_BARK[k * 2u + 1u];
  var h = 1.0;
  var shade = 1.0;
  var mark = 0.0;
  if (bk0.x > 0.0) {
    let ff = max(bk0.y, 0.1);
    let a = 1.0 - smoothstep(0.25, 0.5, fw * ff);
    let x = st.x * ff + 0.7 * vnoise(vec2<f32>(st.x * ff * 0.5, st.y * 0.22));
    // (a groove a third of the period wide, its depth wandering; and short breaks along the ridges)
    let ridge = smoothstep(0.15, 0.75, abs(fract(x) - 0.5) * 2.0);
    let brk = vnoise(vec2<f32>(st.x * ff * 2.0, st.y * 1.3));
    h -= bk0.x * a * ((1.0 - ridge) * (0.7 + 0.6 * vnoise(st * vec2<f32>(0.8, 0.3))) + 0.35 * smoothstep(0.55, 0.8, brk));
  }
  if (bk0.z > 0.0) {
    let ps = max(bk0.w, 0.05);
    let a = 1.0 - smoothstep(0.12, 0.3, fw / ps);
    let vq = floraVoronoi(st / vec2<f32>(ps, ps * 1.7));
    let crack = 1.0 - smoothstep(0.03, 0.14, vq.y - vq.x);
    h -= bk0.z * crack * 0.85 * a;
    shade = mix(1.0, 0.8 + 0.4 * vq.z, bk0.z);
  }
  if (bk1.x > 0.0) {
    let a = 1.0 - smoothstep(0.3, 0.6, fw * bk1.y);
    let d = vnoise(st * vec2<f32>(2.2, bk1.y)) * (0.6 + 0.4 * vnoise(st * vec2<f32>(0.4, 0.6) + vec2<f32>(5.0, 1.0)));
    mark = step(1.0 - bk1.x * 0.9, d) * step(0.5, a);
    h -= mark * 0.3;
  }
  if (bk1.z > 0.0) { h -= bk1.z * 0.2 * vnoise(st * 6.0) * (1.0 - smoothstep(0.08, 0.2, fw)); }
  return vec3<f32>(h, shade, mark);
}

/** (round 128) A smooth normal where the vertex carries one (uv.zw, octahedral: a canopy lobe's, a stem's); else the face's `n`. */
fn floraSmoothN(uv: vec4<f32>, n: vec3<f32>) -> vec3<f32> {
  // (round 128: stems too carry a smooth normal — the ring's radial direction — wherever z w aren't zero)
  if (uv.x > -0.5 && abs(uv.z) + abs(uv.w) < 1e-5) { return n; }
  var q = vec3<f32>(uv.z, uv.w, 1.0 - abs(uv.z) - abs(uv.w));
  if (q.z < 0.0) { q = vec3<f32>((1.0 - abs(q.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), q.xy >= vec2<f32>(0.0)), q.z); }
  return normalize(q);
}

/** (round 128) The stem's tangents for the bark's bump (call in uniform control flow: derivatives): x round, y along. */
fn floraTangents(p: vec3<f32>, uv: vec2<f32>, n: vec3<f32>) -> mat2x3<f32> {
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let du1 = dpdx(uv);
  let du2 = dpdy(uv);
  let p2 = cross(dp2, n);
  let p1 = cross(n, dp1);
  let t = p2 * du1.x + p1 * du2.x;
  let b = p2 * du1.y + p1 * du2.y;
  let m = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
  return mat2x3<f32>(t * m, b * m);
}

/** (round 128) The bark's normal: the face's, tilted by the height's slope along the stem's tangents. */
fn floraBump(k: u32, part: u32, uv: vec2<f32>, n: vec3<f32>, tb: mat2x3<f32>, fw: f32) -> vec3<f32> {
  if (!(part == 3u || part == 7u) || fw > 0.5) { return n; }
  let e = max(fw, 0.03);
  let h0 = floraBarkH(k, uv, fw).x;
  let hu = floraBarkH(k, uv + vec2<f32>(e, 0.0), fw).x;
  let hv = floraBarkH(k, uv + vec2<f32>(0.0, e), fw).x;
  let g = vec2<f32>(hu - h0, hv - h0) / e;
  return normalize(n - 0.12 * (tb[0] * g.x + tb[1] * g.y));
}

/** A flora fragment's colour (sRGB-ish albedo, before toLinear) and, in w, its material (MAT_*), or −1: discard. */
fn floraLook(k: u32, part: u32, wpos: vec3<f32>, n: vec3<f32>, h: f32, rnd: f32, salt: u32, uv: vec2<f32>, fw: f32) -> vec4<f32> {
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
    // (round 128, the user: "bark texture ... it's just scaled colored noise and normals" — in the stem's own
    // coordinates now (mesh.ts: u round the stem, v along it, in cells), not world space: furrows wander along the
    // stem, plates are Voronoi cells, a birch's lenticels horizontal dashes; floraBump turns the same height into the
    // normal. Details finer than a pixel fade (fw: cells a pixel).)
    if (part != 14u) {
      let bh = floraBarkH(k, uv, fw);
      c = mix(markC, c, clamp(bh.x, 0.0, 1.0)) * bh.y;
      if (bh.z > 0.5) { c = markC; }
      if (bk1.z > 0.0) {
        // roughness: broad pale and grey streaks along the stem, warm patches (the elder's reference beech)
        let streak = vnoise(uv * vec2<f32>(0.6, 0.12) + vec2<f32>(3.0, 7.0));
        c *= (1.0 - 0.25 * bk1.z) + 0.4 * bk1.z * streak;
        c = mix(c, c * vec3<f32>(1.08, 1.0, 0.86), min(1.0, bk1.z / 0.8) * smoothstep(0.6, 0.9, vnoise(uv * 0.25 + vec2<f32>(11.0, 2.0))));
      }
    }
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
      // (on the faces turned well up only — a faceted bole's tilted facets read as a whitewashed trunk otherwise)
      if (n.z > 0.62 - 0.15 * fr && fr < snow * 0.85) {
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
    // (round 128, main's review: "deciduous trees in winter should be mostly bare twigs (a few marcescent leaves at most)":
    // the species' share of leaves kept through the winter, FLORA_ACC.w — an oak's or a beech's few dead ones)
    // (the drop decided over ~1.7-cell blocks, not per fragment's own small cell: a crown is many layers of cards, and
    // a per-fragment keep of a few percent showed through every layer as a brown crown)
    let frW = randv(vec3<i32>(floor(wpos * 0.6)) + vec3<i32>(i32(salt & 255u), 13, 2));
    if (decid && frW < seasonBare() * (1.0 - FLORA_ACC[k].w)) {
      // (round 128: no twig haze — the crowns' sprays sit on the limbs, which the deciduous keep at every level, so bare
      // the branching is the tree's shape; the haze's dark cards read as dead leaves)
      return vec4<f32>(0.0, 0.0, 0.0, -1.0);
    }
    if (decid) {
      let sc = smoothstep(0.0, 0.3, seasonColour() * 1.3 - rnd * 0.3);
      c = mix(c, FLORA_COL[b + 4u].rgb * (0.75 + 0.35 * fr) * (0.72 + 0.3 * n.z), sc);
      // (round 128: the few leaves a deciduous crown keeps into deep winter are dead brown, not the fall's colour)
      c = mix(c, vec3<f32>(0.42, 0.3, 0.19) * (0.8 + 0.3 * fr), seasonSnow() * 0.85);
    }
    // (round 128, close-up: the leaves' own grain, finer than a cluster)
    if (FLORA_EPI[k].w > 0.5) { c *= 0.86 + 0.28 * randv(vec3<i32>(floor(wpos * 5.0)) + vec3<i32>(2, 9, 4)); }
    // (round 128) a leaf card's own look (card space: mesh.ts addCrown — u across, v stalk to tip): the midrib and side
    // veins a little lighter, the edge darker; faded where a card is under a few pixels
    // (round 128) a canopy lobe (uv.x = −1, uv.y its occlusion; the user's target: "trees that look like dota 2 or
    // heroes of the storm from above"): a painted ramp — the lit tops and the sun's side warm and light, the undersides
    // and crevices cool and dark (the occlusion baked a vertex), a soft painterly breakup, no cards
    if (uv.x < -0.5) {
      let up = clamp(0.5 + 0.5 * n.z, 0.0, 1.0);
      let t = clamp(up * 0.75 + (h - 0.4) * 0.5 + 0.15, 0.0, 1.0);
      let cool = FLORA_COL[b + 2u].rgb * vec3<f32>(0.78, 0.88, 1.08);
      let warm = FLORA_COL[b + 3u].rgb * vec3<f32>(1.12, 1.06, 0.86);
      c = mix(cool, warm, smoothstep(0.15, 0.95, t));
      // (the occlusion — a crevice, a deeper shell — darker and cooler: the depth the user saw in those crowns)
      c = mix(c * vec3<f32>(0.62, 0.72, 0.86) * 0.55, c, smoothstep(0.1, 1.0, uv.y));
      c *= 0.93 + 0.14 * vnoise(wpos.xy * 0.45 + vec2<f32>(wpos.z * 0.3, 0.0));
    }
    if (uv.y > 0.0 && fw < 0.35) {
      let x = abs(uv.x - 0.5) * 2.0;
      let halfw = select(uv.y / 0.45, (1.0 - uv.y) / 0.55, uv.y > 0.45);
      let edge = clamp(x / max(halfw, 1e-3), 0.0, 1.0);
      let rib = 1.0 - smoothstep(0.0, 0.1, x);
      let side = 1.0 - smoothstep(0.0, 0.18, abs(fract(uv.y * 4.0 - x * 1.4) - 0.5) * 2.0 - 0.75);
      let a = 1.0 - smoothstep(0.15, 0.35, fw);
      c *= 1.0 + a * (0.14 * rib + 0.07 * side - 0.28 * smoothstep(0.65, 1.0, edge));
    }
    // (round 128) in flower: a share of the clusters bloom (spring, as the crowns come back)
    let bl = FLORA_EPI[k].z * seasonBloom();
    if (bl > 0.0 && randv(vec3<i32>(floor(wpos * 1.1)) + vec3<i32>(3, 3, 41)) < bl) {
      c = FLORA_COL[b + 5u].rgb * (0.86 + 0.22 * fr);
      mat = f32(MAT_FLOWER);
    }
    // (round 128) snow on the evergreens' upper faces: the snow-laden conifer
    let sn = seasonSnow();
    // (on the upper faces only, and not all of them: the dark needles show under it — main's review: the winter
    // conifer went fully white)
    if (sn > 0.0 && n.z > 0.55 - 0.15 * fr && fr < sn * 0.75) { c = vec3<f32>(0.9, 0.93, 0.97) * (0.9 + 0.1 * fr); mat = f32(MAT_SNOW); }
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
  } else if (part == 14u) {
    // (round 128) the fine twigs: the bark toward its mark colour (a birch's twigs dark, an oak's darker brown); snow on
    // the ones lying level in deep winter
    mat = f32(MAT_WOOD);
    c = mix(FLORA_COL[b].rgb, FLORA_COL[b + 1u].rgb, 0.65) * (0.75 + 0.3 * fr);
    if (seasonSnow() > 0.5 && n.z > 0.75 && fr < 0.6) { c = vec3<f32>(0.88, 0.91, 0.96); mat = f32(MAT_SNOW); }
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
