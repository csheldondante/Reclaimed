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
  // (no reveal time: fsBody's CG25 clip and dirt pass it by)
  o.tint = REV_NONE;
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
// (citygen CG25, roads grow in with their lots) A vertex's second word's w: bits 0–7 its surface (1 a colour word; the
// town mesh's ground kinds — archgen 3 dirt, 4 cobbles, 5 grass), bits 8–31 a reveal code — 0 none, c the clock time
// (c − 1) / REV_RES s at which the growth reaches it (citygen/streets.wgsl ribbon, revCode: REV_RES mirrored). The
// time is interpolated along the triangle in VOut.tint; fsBody clips ahead of the mesh's clock, MESH_XF.w (a town's:
// its clock, citygen/town.ts), and lays the first REV_DIRT_S of it as dirt.
const REV_RES: f32 = 16.0;
const REV_NONE: f32 = -3e30;
const REV_DIRT_S: f32 = 1.2;
const REV_DIRT: vec3<f32> = vec3<f32>(0.47, 0.38, 0.27);
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
  o.info = vec2<u32>(a.w, nb.w & 0xffu);
  let rc = nb.w >> 8u;
  o.tint = select(REV_NONE, f32(rc - 1u) / REV_RES, rc != 0u);
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

@fragment
fn fsBody(in: VOut) -> FOut {
  let word = in.info.x;
  let mat = word & 0xffu;
  // (CG25: a town road growing in — nothing ahead of the growth: its time here, vsSkin's tint, past the town's clock)
  let revAge = MESH_XF.w - in.tint;
  if (revAge < 0.0) { discard; }
  // a little per-voxel variation so a tumbling slab doesn't read as one block
  // (a physics voxel, bit 30, carries its own speckle: it bends and moves)
  let physV = ((word >> 30u) & 1u) != 0u;
  let r = select(randv(vec3<i32>(floor(in.bmin * 3.0))), f32((word >> 8u) & 0xffu) / 255.0, physV);
  var alb = toLinear(MATS[mat].albedo.rgb) * (0.88 + 0.24 * r);
  // (round 117, inhabitants.wgsl meshIt: a creature's vertex carries its own colour — vsSkin's info.y 1)
  // (CG25: vsSkin passes only the surface byte; masked here too, so a reader never compares the whole word)
  if ((in.info.y & 0xffu) == 1u) { alb = toLinear(vec3<f32>(f32((word >> 16u) & 255u), f32((word >> 8u) & 255u), f32(word & 255u)) / 255.0) * (0.94 + 0.12 * r); }
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
  // (CG25: laid as dirt first, the road's own surface coming through after REV_DIRT_S)
  if (in.tint > -1e29) { alb = mix(toLinear(REV_DIRT), alb, smoothstep(0.4 * REV_DIRT_S, REV_DIRT_S, revAge)); }
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

// ---- the look's shared pieces (moved here from meshdraw.wgsl, unchanged, so the engine's bodies — fsEBody below, in
// the draw module, which has no field mesh — draw rock with the response the terrain and the rock mesh use) ----------
/** large-scale ground patchiness at p (the forward pass's per vertex; the deferred resolve's per pixel) */
fn meshTint(p: vec3<f32>) -> f32 { return 0.82 + 0.36 * fbm2(wo(p.xy) * 0.045 + vec2<f32>(p.z * 0.02)); }

/** A material's ground colour (blown dust: a greyer silt). */
fn groundAlbedo(m: u32) -> vec3<f32> {
  if (m == MAT_DRIFT) { return toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
  return toLinear(MATS[m].albedo.rgb);
}

/** (perfopt, ?nodetail=: the look's pieces left out, Camera.eye.w bits 2+ — renderer.ts DETAIL_BITS) */
fn noDetail(bit: u32) -> bool { return ((u32(CAM.eye.w) >> 2u) & bit) != 0u; }
const ND_STRATA: u32 = 1u;
const ND_WATER: u32 = 2u;
const ND_PLANTS: u32 = 4u;
const ND_STAINS: u32 = 8u;
const ND_STRUCT: u32 = 16u;
const ND_WARP: u32 = 64u;
const ND_FIELDS: u32 = 128u;
const ND_SPECKS: u32 = 256u;

/** Broken or built: rubble, trash, litter, and every solid but stone (ruins: concrete, brick, asphalt, steel). */
fn jagged(m: u32) -> bool {
  return m == 4u || m == MAT_TRASH || m == MAT_LITTER || (matState(m) == ST_SOLID && m != MAT_STONE && m != MAT_QUARTZ && !bedded(m));
}

/** rock in beds (round 79): basalt, sandstone, obsidian — faceted as stone is, its strata tinted */
fn bedded(m: u32) -> bool { return m == 23u || m == 30u || m == 35u; }

/** Does the detail layer (rockDetail) draw this material? */
fn rockDetailed(mat: u32) -> bool { return mat == MAT_STONE || bedded(mat) || jagged(mat); }

/**
 * Rock's colour at sp, a place in the piece's own frame (where it was when it was made: the pattern goes with the
 * piece), its normal there nL: the flecks a cell and a quarter cell, the land's large patches, the strata's bands and
 * their pebbles. One response for the rock mesh (rockmesh.wgsl fsRock) and the engine's bodies (fsEBody).
 */
fn rockAlbedo(alb0: vec3<f32>, mat: u32, sp: vec3<f32>, nL: vec3<f32>) -> vec3<f32> {
  var alb = alb0;
  let ips = sp - nL * 0.2;
  let vc = vec3<i32>(cellAt(ips.xy), i32(floor(ips.z)));
  let sub = vec3<i32>(floor(sp * 4.0 - nL * 0.02));
  let n1 = randv(sub);
  let steep = 1.0 - smoothstep(0.3, 0.7, abs(nL.z));
  if (!noDetail(ND_SPECKS)) { alb *= 1.0 + mix(1.0, 0.35, steep) * (0.12 * randv(vc) + 0.08 * n1 - 0.1); }
  alb *= meshTint(sp);
  if (mat >= 1u && mat <= 4u && !noDetail(ND_STRATA)) {
    let band = strata(sp);
    if (mat == 1u) { alb *= mix(vec3<f32>(0.8, 0.83, 0.9), vec3<f32>(1.16, 1.03, 0.88), band); }
    if (mat == 2u) { alb *= mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), band); }
    let pb = randv(sub + vec3<i32>(5, 77, 13));
    if (pb > 0.93) { alb *= 1.25; } else if (pb < 0.05) { alb *= 0.72; }
  }
  if ((mat == 23u || mat == 30u) && !noDetail(ND_STRATA)) { alb *= strataTint(mat, strata(sp)); }
  return alb;
}

/** The detail layer in the piece's own frame: xyz the normal there (to be turned with the piece), w what the colour is
 *  multiplied by — stone and bedded rock in facets with cracks between, what is jagged in quarter-cell chips. */
fn rockDetail(mat: u32, sp: vec3<f32>, nL: vec3<f32>) -> vec4<f32> {
  if (mat == MAT_STONE || bedded(mat)) { return rockFacet(sp, nL, 1.0); }
  let chip = vec3<i32>(floor(sp * 4.0 - nL * 0.1));
  let t = vec3<f32>(randv(chip + vec3<i32>(1, 0, 0)), randv(chip + vec3<i32>(0, 1, 0)), randv(chip + vec3<i32>(0, 0, 1))) - 0.5;
  let f = fract(sp * 4.0 - nL * 0.1);
  let edge = min(min(f.x, 1.0 - f.x), min(min(f.y, 1.0 - f.y), min(f.z, 1.0 - f.z)));
  return vec4<f32>(normalize(nL + (t - nL * dot(t, nL)) * 1.3), 0.8 + 0.2 * smoothstep(0.0, 0.12, edge));
}

// ---- the physics engine's bodies (engine/engine.ts, engine_draw.wgsl; docs/design/PHYSICS_ENGINE.md "Look round 3") ----
// One mesh a body in every state, placed on the GPU. Two vec4<u32> a vertex, three a triangle, vsSkin's stride (the
// shadow pass draws it with vsSkin: it reads the place only): [its place (f32 bits), the material word] [its place in
// the grain's frame — the lattice of the body it first was, which a part keeps however often it breaks: f32 bits —
// its normal, 10 bits an axis]. The look is drawn in the grain's frame, so it goes with the piece and does not swim,
// the two sides of a crack carry one pattern, and a break face (the word's bit 29) shows the same stone inside, fresher.
const MAT_BRICK_E: u32 = 11u;
struct EOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) gpos: vec3<f32>,
  @location(3) @interpolate(flat) word: u32,
  // where in its triangle (1 at its own corner of the three), and which of the triangle's edges are a break's line (bit
  // k: the edge from corner k to the next — engine_draw.wgsl, each vertex's bit 30)
  @location(4) ck: vec3<f32>,
  @location(5) @interpolate(flat) edges: u32,
};

@vertex
fn vsEBody(@builtin(vertex_index) vi: u32) -> EOut {
  var o: EOut;
  let a = instances[vi * 2u];
  let b = instances[vi * 2u + 1u];
  let wp = bitcast<vec3<f32>>(a.xyz) + MESH_XF.xyz;
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  o.nrm = vec3<f32>(f32(b.w & 1023u), f32((b.w >> 10u) & 1023u), f32((b.w >> 20u) & 1023u)) / 511.5 - 1.0;
  o.gpos = bitcast<vec3<f32>>(b.xyz);
  o.word = a.w;
  o.ck = vec3<f32>(0.0);
  o.ck[vi % 3u] = 1.0;
  let t0 = vi - vi % 3u;
  o.edges = ((instances[t0 * 2u + 1u].w >> 30u) & 1u) | (((instances[t0 * 2u + 3u].w >> 30u) & 1u) << 1u) | (((instances[t0 * 2u + 5u].w >> 30u) & 1u) << 2u);
  return o;
}

/**
 * Brick in its courses at p, a place in the grain's frame, on a face whose normal there is n: xyz what the brick's
 * colour is multiplied by, w how much of the place is mortar. The courses are the grain's own (engine_grain.wgsl
 * grainCellAt, GR_BRICK: the same numbers, the tuning panel's), so the joints drawn on a wall's faces are where it
 * comes apart: the teeth of a broken edge are the bricks drawn.
 */
fn brickLook(p: vec3<f32>, n: vec3<f32>) -> vec4<f32> {
  let len = max(G.tune.engineGrainBrickLength, 0.5);
  let dep = max(G.tune.engineGrainBrickDepth, 1.0) * 0.8660254;
  let crs = max(G.tune.engineGrainBrickCourse, 0.5);
  // (the brick just behind the face: a face that lies on a joint is that brick's end, not the joint)
  let q = p - n * 0.12;
  let k = floor(q.z / crs);
  let u = (q.x + 0.25) / len + G.tune.engineGrainBrickOffset * k;
  let v = q.y / dep;
  let w = q.z / crs;
  let fu = fract(u);
  let fv = fract(v);
  let fw = fract(w);
  let d = vec3<f32>(min(fu, 1.0 - fu) * len, min(fv, 1.0 - fv) * dep, min(fw, 1.0 - fw) * crs);
  // (the joints a face shows are those that cross it: not the one it lies along)
  let a = abs(n);
  var j = 1e9;
  if (a.x < 0.75) { j = min(j, d.x); }
  if (a.y < 0.75) { j = min(j, d.y); }
  if (a.z < 0.75) { j = min(j, d.z); }
  let id = vec3<i32>(i32(floor(u)), i32(floor(v)), i32(k));
  let tone = 0.82 + 0.32 * randv(id + vec3<i32>(11, 3, 57));
  let warm = randv(id + vec3<i32>(5, 91, 2)) - 0.5;
  let fleck = 0.94 + 0.12 * randv(vec3<i32>(floor(q * 5.0)));
  return vec4<f32>(vec3<f32>(1.0 + 0.1 * warm, 1.0, 1.0 - 0.12 * warm) * tone * fleck, 1.0 - smoothstep(0.05, 0.1, j));
}

@fragment
fn fsEBody(in: EOut) -> FOut {
  // (derivatives first: the face's two directions in the grain's frame and in the world — they give the normal in the
  // grain's frame and carry the detail's tilt from it to the world, with no rotation passed a vertex)
  let e1 = dpdx(in.gpos);
  let e2 = dpdy(in.gpos);
  let w1 = dpdx(in.wpos);
  let w2 = dpdy(in.wpos);
  let ckw = fwidth(in.ck);
  let word = in.word;
  let mat = word & 0xffu;
  var broken = ((word >> 29u) & 1u) != 0u;
  var nW = normalize(in.nrm);
  // Seen from behind: the inside of the body's skin, through a crack that has opened while it deforms (its break faces
  // are made when it settles: engine_settle.wgsl). Drawn as the material's inside in shadow, so an open crack reads as
  // a dark break in something solid, not as a lit hollow shell. (A settled part is closed: none of its faces is seen
  // from behind.)
  // (its normal lies on the far side of the triangle's own plane from the eye)
  let gw = cross(w1, w2);
  let inside = dot(gw, nW) * dot(gw, toEye(in.wpos)) < 0.0;
  if (inside) {
    nW = -nW;
    broken = true;
  }
  var gl = cross(e1, e2);
  if (dot(cross(w1, w2), nW) < 0.0) { gl = -gl; }
  let nL = normalize(gl + vec3<f32>(0.0, 0.0, 1e-12));
  let sp = in.gpos;
  var alb = toLinear(MATS[mat].albedo.rgb);
  var lnL = nL;
  if (mat == MAT_STONE || bedded(mat)) {
    alb = rockAlbedo(groundAlbedo(mat), mat, sp, nL);
    if (CAM.viewport.z > 4.0) {
      let rd = rockDetail(mat, sp, nL);
      lnL = rd.xyz;
      alb *= rd.w;
    }
    // (a break face: the stone inside, not yet weathered)
    if (broken) { alb = mix(alb, groundAlbedo(mat) * 1.3, 0.45); }
  } else if (mat == MAT_BRICK_E) {
    let b = brickLook(sp, nL);
    let mortar = toLinear(vec3<f32>(0.62, 0.6, 0.55));
    alb = mix(alb * b.xyz * select(1.0, 1.18, broken), mortar * (0.9 + 0.2 * randv(vec3<i32>(floor(sp * 6.0)))), b.w * select(0.85, 0.55, broken));
  } else {
    // (what else is built: a little variation a third of a cell, in the piece's own frame; a break face fresher)
    alb *= (0.88 + 0.24 * randv(vec3<i32>(floor(sp * 3.0 - nL * 0.02)))) * select(1.0, 1.15, broken);
  }
  // A break's line on the outer surface, drawn dark: pieces of a block cracked where it stands keep their places (a
  // break adds no speed), and the hairline between them is what tells them apart. A twentieth of a cell wide, and
  // never under a pixel.
  if (!broken && in.edges != 0u) {
    // (how far from each edge: the share of the way to the corner opposite, in pixels and in cells)
    let px = in.ck / max(ckw, vec3<f32>(1e-6));
    let cpp = max(length(e1), length(e2));
    let dist = min(px, px * cpp / 0.05);
    var near = 1e9;
    if ((in.edges & 1u) != 0u) { near = min(near, dist.z); }
    if ((in.edges & 2u) != 0u) { near = min(near, dist.x); }
    if ((in.edges & 4u) != 0u) { near = min(near, dist.y); }
    alb *= mix(0.3, 1.0, smoothstep(0.6, 1.3, near));
  }
  // the detail's normal turned with the piece: its part along the face's normal stays there, its part in the face goes
  // by the face's own two directions
  var n = nW;
  let t = lnL - nL * dot(lnL, nL);
  if (dot(t, t) > 1e-8) {
    let a11 = dot(e1, e1);
    let a12 = dot(e1, e2);
    let a22 = dot(e2, e2);
    let det = a11 * a22 - a12 * a12;
    if (det > 1e-12) {
      let b1 = dot(t, e1);
      let b2 = dot(t, e2);
      let ca = (b1 * a22 - b2 * a12) / det;
      let cb = (b2 * a11 - b1 * a12) / det;
      n = normalize(nW * dot(lnL, nL) + ca * w1 + cb * w2);
    }
  }
  var col = alb * lighting(in.wpos, n);
  if (inside) { col *= 0.4; }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  // (pickable as a body: fsBody's flag)
  let bc = clampCell(cellAt(in.wpos.xy));
  o.pick = vec2<u32>(winIdx(bc) + 1u, pickInfo(mat, in.wpos.z, 0x8000u));
  return o;
}
