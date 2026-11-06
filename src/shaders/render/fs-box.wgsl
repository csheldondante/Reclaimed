// fs-box.wgsl: fsBox: the ground's and the boxes' fragment shading (part 5 of 7 of the renderWgsl shader, joined in order by render.ts)
@fragment
fn fsBox(in: VOut) -> FOut {
  // derivatives first: canopy fragments may discard below
  let gl = gridLines(in.wpos, in.nrm);
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  let mat = in.info.x;
  let flags = in.info.y & 0xffu;
  let damage = in.info.y >> 8u;
  // drifted dust: cut a rounded, slightly ragged outline from the smooth depth
  if (mat == MAT_DRIFT) {
    let rag = (randv(vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 4.0)), 7)) - 0.5) * 0.04;
    if (sheetDepth(in.wpos.xy, 0u) < 0.07 + rag) { discard; }
  }
  var lpos = in.wpos;
  var lnrm = in.nrm;
  var canopyN = 0.0;
  if ((flags & 2u) != 0u && mat == MAT_LEAVES) {
    let h = canopyMarch(in);
    if (h.w == 0.0) { discard; }
    lpos = h.xyz;
    let eye = toEye(in.wpos);
    if (h.w == 1.0) { lnrm = vec3<f32>(sign(eye.x), 0.0, 0.0); }
    else if (h.w == 2.0) { lnrm = vec3<f32>(0.0, sign(eye.y), 0.0); }
    else { lnrm = vec3<f32>(0.0, 0.0, 1.0); }
    canopyN = randv(vec3<i32>(floor(h.xyz * 4.0)));
  }
  // rock: carved to a jagged surface inside its box (round 29) — only when
  // zoomed in far enough to see it (ROCK_ZOOM px per cell): it doubled the
  // draw of the whole valley at the default zoom, where a cell is a few px
  let carved = mat == MAT_STONE && (in.sides & PRISM) != 0u && CAM.viewport.z > ROCK_ZOOM;
  if (carved) {
    let h = rockMarch(in, flags);
    if (h.w == 0.0) { discard; }
    lpos = h.xyz;
    // (an uncut face keeps its own normal)
    if (h.w > 1.5) { lnrm = rockNormal(in, flags, h.xyz); }
  }
  let cell = fragCell(in.wpos, in.nrm);
  let ci = colIdxI(cell);
  // soft ground and drift sheets: lit smoothly across their cells
  if (in.nrm.z > 0.5 && (flags & 2u) == 0u && !carved && (u32(CAM.eye.w) & 1u) == 0u) {
    if (mat == MAT_DRIFT) { lnrm = smoothNormal(in.wpos.xy, cell, 2u); }
    else if ((flags & 1u) != 0u && MATS[mat].look.x > 0.0) { lnrm = smoothNormal(in.wpos.xy, cell, 0u); }
  }
  var alb = toLinear(MATS[mat].albedo.rgb);
  // the loose layer is drawn in its own material's colour (dust, sand, ash, dirt)
  if (mat == MAT_DRIFT) {
    alb = toLinear(MATS[driftMatAt(cell)].albedo.rgb);
    // blown dust on top is drawn a greyer, darker silt than sand or dirt, so
    // what the wind lays down reads where it lands
    if (driftMatAt(cell) == MAT_DRIFT) { alb = toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
    // a thin top layer shows the one beneath through it (a trace of blown dust
    // doesn't flip a cell's colour — round 17)
    let below = looseBelowAt(cell);
    if (below != 0u) {
      var bc = toLinear(MATS[below].albedo.rgb);
      if (below == MAT_DRIFT) { bc = toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
      alb = mix(bc, alb, smoothstep(0.02, 0.2, driftTopAt(cell)));
    }
  }

  // the material whose surface detail is drawn (the loose sheet: its top
  // interval's — loose ground looks like that material however thin it is)
  var dmat = mat;
  if (mat == MAT_DRIFT) { dmat = driftMatAt(cell); }
  // soft borders: near an edge the neighbour's ground may show instead
  var vTop = veg[ci];
  if (in.nrm.z > 0.5 && (flags & 2u) == 0u && blends(dmat)) {
    let e = edgeLook(in.wpos, dmat, vTop);
    vTop = e.v;
    if (e.m != dmat) {
      dmat = e.m;
      alb = topAlbedo(e.m);
    }
  }

  // voxel texture: per-cell (the hex column, whole heights) and per-subcell (4x4) variation
  let vc = vec3<i32>(cell, i32(floor(in.wpos.z - in.nrm.z * 0.01)));
  let sub = vec3<i32>(floor(in.wpos * 4.0 - in.nrm * 0.02));
  let n1 = randv(sub);
  let n2 = randv(sub + vec3<i32>(71, 13, 5));
  alb *= 0.9 + 0.12 * randv(vc) + 0.08 * n1;
  // large-scale patchiness so open ground is not one flat colour
  alb *= in.tint;
  // natural materials: per-voxel hue drift (warm/cool, mineral streaks) and
  // sub-voxel pebbles, so stone and dirt aren't a single flat colour
  if (dmat >= 1u && dmat <= 4u) {
    let hv = randv(vc + vec3<i32>(17, 3, 91));
    let warm = vec3<f32>(1.08, 0.97, 0.88);
    let cool = vec3<f32>(0.92, 0.98, 1.06);
    alb *= mix(cool, warm, hv);
    // the beds (round 79: strata — sheets, not blotches)
    let band = strata(in.wpos);
    if (dmat == 1u) { alb *= mix(vec3<f32>(0.8, 0.83, 0.9), vec3<f32>(1.16, 1.03, 0.88), band); }
    if (dmat == 2u) { alb *= mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), band); }
    // pebbles: occasional lighter/darker sub-voxels
    let pb = randv(sub + vec3<i32>(5, 77, 13));
    if (pb > 0.93) { alb *= 1.25; } else if (pb < 0.05) { alb *= 0.72; }
  }

  if (dmat == 23u || dmat == 30u) { alb *= strataTint(dmat, strata(in.wpos)); }
  if (dmat == MAT_LEAFLIT) {
    // fallen leaves (round 51): a mottle of autumn colours, browned ones among them
    var tc = autumnLeaf(select(0u, 2u, n2 > 0.82), fract(n2 * 3.7));
    if (n2 < 0.3) { tc = mix(vec3<f32>(0.36, 0.24, 0.12), vec3<f32>(0.5, 0.34, 0.16), n1); }
    alb = toLinear(tc) * (0.7 + 0.4 * n1);
  }
  if (dmat == MAT_TRASH || dmat == MAT_LITTER) {
    // faded plastics, paper, glass and rust specks (litter: scraps on dirt)
    let k = u32(n2 * 6.0);
    var tc = vec3<f32>(0.45, 0.43, 0.40);
    if (k == 0u) { tc = vec3<f32>(0.42, 0.52, 0.62); }
    else if (k == 1u) { tc = vec3<f32>(0.78, 0.76, 0.70); }
    else if (k == 2u) { tc = vec3<f32>(0.66, 0.38, 0.34); }
    else if (k == 3u) { tc = vec3<f32>(0.38, 0.48, 0.34); }
    else if (k == 4u) { tc = vec3<f32>(0.50, 0.33, 0.20); }
    alb = toLinear(tc) * (0.75 + 0.35 * n1);
    if (dmat == MAT_LITTER && n1 < 0.5) { alb = toLinear(vec3<f32>(0.45, 0.36, 0.27)) * (0.85 + 0.3 * n2); }
  }

  let v = veg[ci];
  let isVeg = (flags & 2u) != 0u;
  if (isVeg) {
    // leaves/wood: hue jitter, lighter tips on top
    let fresh = vec3<f32>(0.30, 0.52, 0.18);
    if (mat == MAT_LEAVES) {
      // per-leaf-cluster hue, lighter on top, a few autumn-tinted clumps
      let species = (in.info.y >> 8u) & 15u;
      var dark = vec3<f32>(0.14, 0.31, 0.11);
      var light = fresh;
      if (species == 1u) { dark = vec3<f32>(0.07, 0.2, 0.12); light = vec3<f32>(0.16, 0.34, 0.2); }
      if (species == 2u) { dark = vec3<f32>(0.3, 0.46, 0.16); light = vec3<f32>(0.55, 0.66, 0.28); }
      if (species == 3u) { dark = vec3<f32>(0.1, 0.24, 0.09); light = vec3<f32>(0.24, 0.42, 0.15); }
      var lc = mix(dark, light, canopyN * 0.8 + 0.25 * lnrm.z);
      if (canopyN > 0.93) { lc = mix(lc, vec3<f32>(0.55, 0.45, 0.16), 0.6); }
      // autumn (round 51): the broadleaves turn — each tree its own shade and
      // its own time, clusters varying round it — and the last leaves left go
      // brown; conifers (species 1) stay green
      if (species != 1u) {
        let th = randv(vec3<i32>(floor(in.bmin)) + vec3<i32>(5, 1, 9));
        let turned = autumnLeaf(species, fract(th * 0.75 + canopyN * 0.35)) * (0.72 + 0.3 * lnrm.z + 0.12 * canopyN);
        let sc = smoothstep(0.0, 0.3, seasonColour() * 1.3 - th * 0.3);
        lc = mix(lc, turned, sc);
        lc = mix(lc, vec3<f32>(0.4, 0.27, 0.14), seasonBare() * 0.6);
      }
      alb = toLinear(lc);
    }
    if (mat == MAT_WOOD && ((in.info.y >> 8u) & 15u) == 2u) {
      // birch bark: pale with dark horizontal marks
      let mark = randv(vec3<i32>(floor(in.wpos * vec3<f32>(4.0, 4.0, 6.0)))) < 0.18;
      alb = toLinear(select(vec3<f32>(0.82, 0.8, 0.74), vec3<f32>(0.2, 0.18, 0.16), mark));
    }
    if (mat == MAT_GRASS) {
      let gv = randv(vec3<i32>(floor(in.bmin * 4.0)));
      alb = toLinear(seasonGrass(mix(vec3<f32>(0.28, 0.44, 0.15), vec3<f32>(0.46, 0.6, 0.22), gv), fbm2(wo(in.wpos.xy) * 0.08)) * (0.8 + 0.3 * smoothstep(in.zr.x, in.zr.y, in.wpos.z)));
    }
    if (mat == MAT_FLOWER) {
      // one colour per plant (fine flowers are several boxes); a yellow heart
      // (diorama flowers carry their colour in the species bits: 1..4, 8 = heart)
      let sp = (in.info.y >> 8u) & 15u;
      var fv = randv(vec3<i32>(floor(in.bmin)) + vec3<i32>(3, 9, 1));
      if (sp >= 1u && sp <= 4u) { fv = f32(sp) * 0.25 - 0.1; }
      let heart = sp == 8u;
      var petal = vec3<f32>(0.92, 0.9, 0.82);
      if (fv > 0.75) { petal = vec3<f32>(0.95, 0.8, 0.25); } else if (fv > 0.5) { petal = vec3<f32>(0.62, 0.48, 0.82); } else if (fv > 0.3) { petal = vec3<f32>(0.85, 0.35, 0.3); }
      let top = sp != 0u || in.wpos.z > in.zr.y - max(0.12, (in.zr.y - in.zr.x) * 0.3);
      alb = toLinear(select(select(vec3<f32>(0.3, 0.46, 0.17), petal, top), vec3<f32>(0.95, 0.78, 0.2), heart));
    }
    if (mat != MAT_WOOD) { alb = wither(alb, wilt[ci].y, n1); }
  } else {
    // drifted dust (or ash) is plain: no stains or plant cover painted on it
    // (what lies under it is buried); a loose layer of sand or dirt is ground
    // like any other — it shows its plants and stains (round 15)
    let plainSheet = mat == MAT_DRIFT && buriedAt(cell);
    let isTop = (flags & 1u) != 0u && in.nrm.z > 0.5 && !plainSheet;
    let porosity = MATS[mat].eco.w;
    if (isTop) {
      // contamination stains: oily black-brown with sickly yellow-green streaks
      let c = contam[ci].x;
      let stain = smoothstep(0.12, 1.1, c);
      let oil = mix(vec3<f32>(0.10, 0.09, 0.06), vec3<f32>(0.42, 0.40, 0.12), smoothstep(0.55, 0.95, n2));
      alb = mix(alb, toLinear(oil), stain * 0.8);
      // grime texture: tarry blobs and sickly/rusty flecks at sub-voxel scale,
      // thicker the worse the ground (the same stuff the wind lifts as grime)
      let clump = randv(sub + vec3<i32>(31, 7, 59));
      if (clump < stain * 0.32) { alb = toLinear(vec3<f32>(0.05, 0.045, 0.04)) * (0.8 + 0.4 * n1); }
      else if (clump > 1.0 - stain * 0.1) { alb = toLinear(select(vec3<f32>(0.55, 0.5, 0.15), vec3<f32>(0.5, 0.27, 0.14), n1 > 0.5)); }
      // desaturate when dead/dry
      let lum = dot(alb, vec3<f32>(0.3, 0.55, 0.15));
      alb = mix(alb, vec3<f32>(lum), 0.25 * G.pollution);
    }
    // wet surfaces darken
    let m = fields[ci].y;
    alb *= 1.0 - porosity * 0.5 * smoothstep(0.15, 0.9, m);

    // vegetation cover (dithered at sub-cell resolution)
    // (tops use the cover smoothed across the edges, like the material)
    let vCov = select(v, vTop, isTop);
    if (vCov > 0.0 && !plainSheet) {
      var cover: f32;
      if (isTop) { cover = smoothstep(0.0, 1.2, vCov); } else { cover = smoothstep(0.8, 3.0, vCov) * 0.55 * (0.5 + 0.5 * n2); }
      if (n1 < cover) {
        let moss = vec3<f32>(0.33, 0.40, 0.17);
        let grass = vec3<f32>(0.36, 0.54, 0.19);
        let forest = vec3<f32>(0.17, 0.33, 0.12);
        var g = mix(moss, grass, smoothstep(1.0, 2.0, vCov));
        g = mix(g, forest, smoothstep(3.0, 4.5, vCov));
        g *= 0.82 + 0.3 * n2;
        // (it turns with the season: woodland floor less, under the trees)
        g = mix(g, seasonGrass(g, fbm2(wo(in.wpos.xy) * 0.08)), 1.0 - 0.5 * smoothstep(3.0, 4.5, vCov));
        // wind running through the grass: gust patches roll downwind (advected
        // with the integrated wind, so they move smoothly), with fine bands
        // across them; stronger local wind (gusts, drags) deepens the waves
        let w = windAt(vec3<f32>(in.wpos.xy, in.wpos.z + 0.5));
        let ws = length(w);
        let pd = vec2<f32>(G.windX, G.windY);
        let wd = pd / max(length(pd), 1e-3);
        let gp = gustField(in.wpos.xy);
        let band = sin(dot(windDrift(in.wpos.xy), wd) * 0.8);
        let wave = (gp - 0.5) * 1.6 + band * 0.35;
        g *= 1.0 + wave * 0.13 * clamp(ws / 4.0, 0.3, 1.6) * smoothstep(0.8, 1.8, vCov);
        alb = wither(toLinear(g), wilt[ci].y, n2);
      }
    }

    // vines: climb walls from living ground in front of the face; the longer
    // that ground has been green (higher succession stage) the higher they reach
    if (!isTop && in.nrm.z < 0.5 && MATS[mat].sim.x == 1.0 && mat != 1u) {
      let front = clampCell(cellAt(cellPos(cell) + in.nrm.xy));
      let fv = veg[colIdxI(front)];
      let gz = f32(sfZ(surface[colIdxI(front)]));
      let reach = clamp((fv - 1.4) * 3.2, 0.0, 16.0);
      let rel = in.wpos.z - gz;
      if (reach > 0.0 && rel >= 0.0) {
        let along = faceUV(in.wpos, in.nrm).x;
        let strand = i32(floor(along * 4.0));
        let sh = randv(vec3<i32>(strand, cell.x * 7 + cell.y, 515));
        let len = reach * (0.35 + 0.65 * sh);
        let leafy = randv(vec3<i32>(strand, i32(floor(in.wpos.z * 4.0)), 919));
        if (rel < len && sh > 0.25 && leafy < 0.8) {
          let vg = mix(vec3<f32>(0.16, 0.32, 0.11), vec3<f32>(0.33, 0.5, 0.18), leafy);
          alb = toLinear(vg * (0.85 + 0.25 * smoothstep(len - 1.0, len, rel)));
        }
      }
    }
  }

  // cracks and chipped edges grow with structural damage (taps, lightning,
  // heat, water pressure) so decay is visible before anything fails
  if (damage > 0u && (flags & 2u) == 0u) {
    let fa = faceUV(in.wpos + vec3<f32>(G.org.xy, 0.0), in.nrm);
    let dk = f32(damage);
    let c1 = abs(vnoise(fa * 2.2 + vec2<f32>(f32(ci % 97u))) - 0.5);
    let c2 = abs(vnoise(fa * 4.7 + 11.0) - 0.5);
    let crack = c1 < 0.012 * dk || (dk > 4.0 && c2 < 0.007 * (dk - 4.0));
    let chipped = randv(vec3<i32>(floor(in.wpos * 4.0 - in.nrm * 0.02)) + vec3<i32>(7, 1, 3)) < dk * 0.025;
    if (crack) { alb *= 0.35; } else if (chipped) { alb *= 0.72; }
  }

  // rock: Voronoi facets catch the light at their own tilt (round 28)
  if (dmat == MAT_STONE && (flags & 2u) == 0u) {
    // (carved rock already has its shape: the facets only nudge it)
    let rf = rockFacet(lpos, lnrm, select(1.0, 0.4, carved));
    lnrm = rf.xyz;
    alb *= rf.w;
  }
  var col = alb * lighting(lpos, lnrm);
  // lava (sim/lava.ts): its own light, by temperature (the damage bits):
  // a dark crust with glowing cracks as it cools, orange to yellow-white hot
  if (mat == MAT_LAVA_M) {
    let t = f32(damage & 15u) / 15.0;
    let flow = G.time * 0.15;
    let cr = fbm2(wo(in.wpos.xy) * 1.3 + vec2<f32>(flow, -flow * 0.7));
    let crack = smoothstep(0.42, 0.5, abs(cr - 0.5) * 2.0 + (1.0 - t) * 0.6);
    let hot = mix(vec3<f32>(0.9, 0.12, 0.02), vec3<f32>(1.0, 0.75, 0.3), smoothstep(0.6, 1.0, t)) * (1.1 + 1.6 * t);
    let crust = toLinear(vec3<f32>(0.12, 0.1, 0.09)) * lighting(lpos, lnrm);
    // hot: mostly glowing with a little crust; cooling: crust with glowing seams
    col = mix(hot * (0.8 + 0.4 * n1), crust, crack * smoothstep(0.95, 0.45, t));
    // a fall of it (round 69): bright streaks running down a steep face, no crust on it
    let steepL = 1.0 - smoothstep(0.25, 0.7, in.nrm.z);
    if (steepL > 0.0) {
      let lane = randv(vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 1.5)), 11));
      let streak = smoothstep(0.2, 0.9, fract(in.wpos.z * 0.15 + G.time * 0.9 + lane));
      col = mix(col, hot * (0.9 + 0.5 * streak), steepL * 0.85);
    }
  }
  // life lens (hold Space): what keeps life out, around the cursor
  if (G.lens.w > 0.0 && in.nrm.z > 0.5) {
    let d = length(in.wpos.xy - G.lens.xy) / G.lens.z;
    if (d < 1.0) {
      let k = G.lens.w * smoothstep(1.0, 0.8, d);
      let c = contam[ci].x;
      let wet = fields[ci].y;
      var lensCol = vec3<f32>(0.0);
      var pattern = 1.0;
      let q = vec2<i32>(floor(wo(in.wpos.xy) * 4.0));
      if (v > 0.4) { lensCol = vec3<f32>(0.2, 0.9, 0.3); }
      else if (c > 0.2) { lensCol = vec3<f32>(0.85, 0.15, 0.6); pattern = select(0.4, 1.0, ((q.x + q.y) & 3) == 0); }
      else if (MATS[mat].eco.x < 1.6) { lensCol = vec3<f32>(0.55, 0.58, 0.65); pattern = select(0.3, 1.0, ((q.x - q.y) & 3) == 0); }
      else if (wet < 0.06) { lensCol = vec3<f32>(0.95, 0.75, 0.3); pattern = select(0.3, 1.0, (q.x & 1) == 0 && (q.y & 1) == 0); }
      else { lensCol = vec3<f32>(0.3, 0.6, 0.9); pattern = 0.5; }
      col = mix(col, toLinear(lensCol) * 1.4, k * 0.55 * pattern);
    }
  }
  // (no straight grid lines across carved rock or canopies)
  col *= 1.0 - gl * select(1.0, 0.0, canopyN > 0.0 || carved);
  col = haze(col, lpos);

  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(pickCol(ci), pickInfo(in.info.x, in.wpos.z, in.info.y));
  return o;
}

