// bodies.wgsl: rigid bodies, skinned meshes, drape and strata (part 7 of 7 of the renderWgsl shader, joined in order by render.ts)
// ---- rigid bodies (round 14, F7): broken-off chunks tumbling free ----------
// The body-voxel list is bound where the box instances usually are: two
// vec4<u32> per voxel — (centre xyz as f32 bits, material) and the body's
// rotation quaternion (xyzw as f32 bits). Each voxel is a whole rotated cube
// (36 vertices, back faces culled), lit like the world; not pickable.
// The material word: bits 0-7 material, 24-29 the voxel's size (0: a whole
// cell; n: n/16 of a cell, so 4 is a quarter: a game model's fine voxels,
// round 49), 30 a physics voxel, 31 a structure grid's.

/** a body voxel's edge in cells (material word bits 24-29) */
fn bodySize(word: u32) -> f32 {
  let code = (word >> 24u) & 63u;
  return select(f32(code) / 16.0, 1.0, code == 0u);
}

fn quatRotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

const CUBE_N = array<vec3<f32>, 6>(
  vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, -1.0));

@vertex
fn vsBody(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let a = instances[ii * 2u];
  let qb = instances[ii * 2u + 1u];
  let c = vec3<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z));
  let q = vec4<f32>(bitcast<f32>(qb.x), bitcast<f32>(qb.y), bitcast<f32>(qb.z), bitcast<f32>(qb.w));
  let face = vi / 6u;
  let n = CUBE_N[face];
  // two axes spanning the face, ordered so the triangles wind outward
  var u = vec3<f32>(n.y, n.z, n.x);
  var v = cross(n, u);
  let k = QUAD[vi % 6u] * 2.0 - 1.0;
  let s = bodySize(a.w);
  let local = (n + u * k.x + v * k.y) * (0.5 * s);
  let wp = c + quatRotate(q, local);
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  o.nrm = quatRotate(q, n);
  o.info = vec2<u32>(a.w, 0u);
  o.tint = 0.0;
  o.zr = vec2<f32>(wp.z - 0.5 * s, wp.z + 0.5 * s);
  o.bmin = c;
  o.bsize = vec3<f32>(s);
  o.boff = vec3<f32>(0.0);
  return o;
}

// ---- meshes over physics bodies (round 49): phys.wgsl skin bends them ------
// Two vec4<u32> a vertex, three a triangle (no index buffer): its world
// position (f32 bits) and the material word (as vsBody's), then its
// triangle's normal. Lit and shaded like a body's voxel (fsBody), flat per
// triangle: lo-fi on purpose. (citygen M4a) Placed by its source's MESH_XF: a town's grid moved with the window.
@group(0) @binding(28) var<uniform> MESH_XF: vec4<f32>;
@vertex
fn vsSkin(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let a = instances[vi * 2u];
  let nb = instances[vi * 2u + 1u];
  let wp = bitcast<vec3<f32>>(a.xyz) + MESH_XF.xyz;
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  o.nrm = bitcast<vec3<f32>>(nb.xyz);
  // (round 117, inhabitants: nb.w 1 — the word is a colour 0xrrggbb, not a material; fsBody reads info.y)
  o.info = vec2<u32>(a.w, nb.w);
  o.tint = 0.0;
  o.zr = vec2<f32>(wp.z - 0.5, wp.z + 0.5);
  o.bmin = wp;
  o.bsize = vec3<f32>(1.0);
  o.boff = vec3<f32>(0.0);
  return o;
}

/**
 * The loose ground's smooth surface at p on a structure's face: the nature
 * grid's loose tops interpolated over the three nearest centres, counting
 * only columns whose loose run reaches down to this height (a column whose
 * run lies on the structure's own roof doesn't drape its walls); -1e9 none.
 */
fn drapeTop(p: vec3<f32>) -> f32 {
  let t = triAt(p.xy);
  var s = 0.0;
  var wsum = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    let base = f32(sfZ(surface[colIdxI(q)]));
    let d = driftAt(q);
    if (d < 0.05 || base > p.z + 0.6) { continue; }
    s += t.w[k] * (base + d);
    wsum += t.w[k];
  }
  return select(-1e9, s / max(wsum, 1e-4), wsum > 0.3);
}

/** (archgen) a cell noise at p (cells `size` m): the nearest point's distance, the gap to the second (a joint between
 *  stones), the nearest cell's hash */
fn cellStones(p: vec2<f32>, size: f32) -> vec3<f32> {
  let g = p / size;
  let i = floor(g);
  var f1 = 9.0;
  var f2 = 9.0;
  var id = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = vec2<i32>(i32(i.x) + x, i32(i.y) + y);
      let o = vec2<f32>(randv(vec3<i32>(c, 71)), randv(vec3<i32>(c, 113))) * 0.7 + 0.15;
      let d = length(vec2<f32>(f32(c.x), f32(c.y)) + o - g);
      if (d < f1) { f2 = f1; f1 = d; id = randv(vec3<i32>(c, 29)); } else if (d < f2) { f2 = d; }
    }
  }
  return vec3<f32>(f1 * size, (f2 - f1) * size, id);
}

/** (archgen, the user: "Cobblestone streets or dirt and grass") a town mesh's ground (vsSkin info.y 3 dirt, 4 cobbles,
 *  5 grass): its colour textured by where it is in the world. px: metres a pixel (the pattern fades out under it) */
fn groundLook(base: vec3<f32>, kind: u32, p: vec2<f32>, px: f32) -> vec3<f32> {
  let mottle = vnoise(p * 0.35) * 0.6 + vnoise(p * 1.3) * 0.4;
  if (kind == 4u) {
    // cobbles: rounded setts, each its own shade, dark joints, a little moss in them
    let c = cellStones(p, 0.24);
    let fine = 1.0 - smoothstep(0.09, 0.22, px);
    let joint = 1.0 - smoothstep(0.015, 0.015 + max(px * 0.6, 0.01), c.y * 0.5);
    let dome = 1.0 - 0.25 * smoothstep(0.0, 0.14, c.x);
    var col = base * (0.8 + 0.22 * mottle) * mix(1.0, (0.8 + 0.35 * c.z) * dome, fine);
    let jc = mix(base * 0.45, vec3<f32>(0.2, 0.26, 0.14), step(0.6, vnoise(p * 2.1)));
    return mix(col, mix(col, jc, joint), fine);
  }
  if (kind == 3u) {
    // dirt: mottled, pebbles here and there, a little grass at its edge and in its middle
    let c = cellStones(p, 0.12);
    let fine = 1.0 - smoothstep(0.06, 0.15, px);
    var col = base * (0.72 + 0.45 * mottle);
    let pebble = step(0.82, c.z) * (1.0 - smoothstep(0.02, 0.04, c.x));
    col = mix(col, base * 1.25 + 0.05, pebble * fine);
    let tuft = smoothstep(0.62, 0.8, vnoise(p * 0.9 + 17.0));
    return mix(col, vec3<f32>(0.32, 0.42, 0.2), tuft * 0.6);
  }
  // grass: mottled patches, blades as fine speckle, now and then a flower
  let fine = 1.0 - smoothstep(0.06, 0.16, px);
  let blade = randv(vec3<i32>(vec2<i32>(floor(p * 10.0)), 5));
  var col = base * (0.66 + 0.55 * mottle) * mix(1.0, 0.85 + 0.3 * blade, fine);
  let fl = step(0.985, randv(vec3<i32>(vec2<i32>(floor(p * 6.0)), 9))) * fine;
  return mix(col, select(vec3<f32>(0.95, 0.9, 0.5), vec3<f32>(0.92, 0.6, 0.7), blade > 0.5), fl);
}

@fragment
fn fsBody(in: VOut) -> FOut {
  // (derivatives first: the town mesh's ground textures fade by them)
  let gpx = max(length(fwidth(in.wpos.xy)), 1e-4);
  let word = in.info.x;
  let mat = word & 0xffu;
  // a little per-voxel variation so a tumbling slab doesn't read as one block
  // (a physics voxel, bit 30, carries its own speckle: it bends and moves)
  let physV = ((word >> 30u) & 1u) != 0u;
  let r = select(randv(vec3<i32>(floor(in.bmin * 3.0))), f32((word >> 8u) & 0xffu) / 255.0, physV);
  var alb = toLinear(MATS[mat].albedo.rgb) * (0.88 + 0.24 * r);
  // (round 117, inhabitants.wgsl meshIt: a creature's vertex carries its own colour — vsSkin's info.y 1)
  if (in.info.y == 1u) { alb = toLinear(vec3<f32>(f32((word >> 16u) & 255u), f32((word >> 8u) & 255u), f32(word & 255u)) / 255.0) * (0.94 + 0.12 * r); }
  // (archgen: a town mesh's ground — dirt, cobbles, grass — textured where it lies)
  // (the flag word's low byte is the surface; citygen packs its own data above it — Track A, roadgrow)
  let gsurf = in.info.y & 0xffu;
  if (gsurf >= 3u && gsurf <= 5u) {
    let base = vec3<f32>(f32((word >> 16u) & 255u), f32((word >> 8u) & 255u), f32(word & 255u)) / 255.0;
    alb = toLinear(groundLook(base, gsurf, in.wpos.xy - MESH_XF.xy, gpx));
  }
  let nrm = normalize(in.nrm);
  // a structure grid's voxel (structprep.wgsl): the growth it owns on its
  // faces, and the nature grid's sand drawn over it where it's buried
  if ((word >> 31u) != 0u) {
    // (structprep.wgsl packs them: moss and sand to 16 levels, the cover to 31)
    let moss = f32((word >> 8u) & 0xfu) / 15.0;
    let sand = f32((word >> 12u) & 0xfu) / 15.0;
    let sub = randv(vec3<i32>(floor(in.wpos * 4.0 - nrm * 0.02)) + vec3<i32>(13, 5, 71));
    if (sub < moss * (0.55 + 0.45 * max(nrm.z, 0.0))) {
      let mc = mix(vec3<f32>(0.2, 0.33, 0.12), vec3<f32>(0.36, 0.5, 0.2), randv(vec3<i32>(floor(in.wpos * 2.0)) + vec3<i32>(3, 1, 7)));
      alb = toLinear(mc);
    }
    let cell = clampCell(cellAt(in.wpos.xy));
    let dt = drapeTop(in.wpos);
    let rag = (sub - 0.5) * 0.15;
    if (in.wpos.z < dt + rag || sand > 0.7 + 0.3 * sub) {
      var sc = toLinear(MATS[driftMatAt(cell)].albedo.rgb);
      if (driftMatAt(cell) == MAT_DRIFT) { sc = toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
      alb = sc * (0.9 + 0.2 * sub);
    }
    // snow or dust on its up faces (round 52)
    alb = coverLook(alb, nrm, in.wpos, in.zr.y, f32((word >> 16u) & 31u) / 31.0, ((word >> 21u) & 1u) != 0u, sub);
  }
  var col = alb * lighting(in.wpos, nrm);
  if (physV) {
    // heat (bits 16..23, a share of its melting point): dull red, orange, then white
    let heat = f32((word >> 16u) & 0xffu) / 255.0;
    let glow = smoothstep(0.35, 1.0, heat);
    col = col * (1.0 - 0.5 * glow) + vec3<f32>(1.0, 0.25, 0.04) * glow * 3.0 + vec3<f32>(1.0, 0.8, 0.5) * smoothstep(0.75, 1.0, heat) * 4.0;
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  // pickable (the Break tool hits bodies): the column under the fragment, its
  // height, and flag 0x8000 ("a body") in the instance-flags field
  let bc = clampCell(cellAt(in.wpos.xy));
  // (a structure grid's voxel picks as the ground beneath: they can't be broken yet)
  let flag = select(0x8000u, 0u, (word >> 31u) != 0u);
  // (ringwin: the pick's column in window order — the CPU reads it)
  o.pick = vec2<u32>(winIdx(bc) + 1u, pickInfo(mat, in.wpos.z, flag));
  return o;
}

/**
 * The rock's beds at p, 0..1 (round 79, the user: the cross section "should be biased heavily in the x,y plane so
 * it looks more sheet like strata rather than blotches"): a noise up the column — beds of their own
 * thicknesses, a sharper edge between two — the beds dipping and swelling only over long distances
 * across the land, fine laminations in them.
 */
fn strata(p: vec3<f32>) -> f32 {
  let w = wo(p.xy);
  let z = p.z + 6.0 * fbm2(w * 0.01) + 1.2 * fbm2(w * 0.045);
  let bed = smoothstep(0.32, 0.68, fbm2(vec2<f32>(z * 0.3, 3.7)));
  let lam = 0.5 + 0.5 * sin(z * 2.3 + 2.0 * fbm2(w * 0.03));
  return bed * 0.8 + lam * 0.2;
}

/** a bedded rock's colour across its beds (sandstone: cream to red; basalt: grey to rust) */
fn strataTint(m: u32, b: f32) -> vec3<f32> {
  if (m == 30u) { return mix(vec3<f32>(1.16, 1.02, 0.84), vec3<f32>(0.84, 0.74, 0.74), b); }
  return mix(vec3<f32>(0.92, 0.94, 1.0), vec3<f32>(1.1, 0.96, 0.86), b);
}
