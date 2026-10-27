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
// the mesh's state (round 73): each range's translation (meshregion.wgsl offBase), the vertex stage's
@group(0) @binding(5) var<storage, read> meshState: array<u32>;

struct MOut {
  // (invariant: the depth prepass (?prepass=1) draws the same vertices and the look's pass tests equal against it)
  @builtin(position) @invariant pos: vec4<f32>,
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
  // (where it was made, moved by the slides since: its range's translation)
  let ob = offBase() + (vi / MR.k.z) * 4u;
  let p = vec3<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z)) + vec3<f32>(bitcast<f32>(meshState[ob]), bitcast<f32>(meshState[ob + 1u]), bitcast<f32>(meshState[ob + 2u]));
  var o: MOut;
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  o.wpos = p;
  o.nrm = vec3<f32>(bitcast<f32>(b.x), bitcast<f32>(b.y), bitcast<f32>(b.z));
  o.share = bitcast<f32>(b.w);
  o.word = a.w;
  o.tint = meshTint(p);
  return o;
}

/** large-scale ground patchiness at p (the forward pass's per vertex; the deferred resolve's per pixel) */
fn meshTint(p: vec3<f32>) -> f32 { return 0.82 + 0.36 * fbm2(wo(p.xy) * 0.045 + vec2<f32>(p.z * 0.02)); }

/** (perfopt) the mesh's vertex without the tint: the shadow pass's and the G-buffer's (the resolve takes the tint a pixel) */
@vertex
fn vsMeshG(@builtin(vertex_index) vi: u32) -> MOut {
  let a = instances[vi * 2u];
  let b = instances[vi * 2u + 1u];
  let ob = offBase() + (vi / MR.k.z) * 4u;
  let p = vec3<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z)) + vec3<f32>(bitcast<f32>(meshState[ob]), bitcast<f32>(meshState[ob + 1u]), bitcast<f32>(meshState[ob + 2u]));
  var o: MOut;
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  o.wpos = p;
  o.nrm = vec3<f32>(bitcast<f32>(b.x), bitcast<f32>(b.y), bitcast<f32>(b.z));
  o.share = bitcast<f32>(b.w);
  o.word = a.w;
  o.tint = 1.0;
  return o;
}

// ---- (hybrid, round 86) the window's heightfield chunks: a grid through its own columns' tops ----------------
// A chunk whose land is a heightfield of the ground isn't meshed (no build, a few hundred vertices, not
// thousands); it's drawn as a lattice through its columns' centres (the hex rows are a triangular lattice) at
// each column's top — the window's own columns, so its water, plants, wetness and stains sit on it — and shaded
// by the mesh's own look (meshShade), so it can't be told from the voxels beside it. A chunk's lattice is its
// 32 x 32 columns and one past each edge (GRID_N a side), so it overlaps whatever is next to it by a cell.
// Drawn indexed with the base vertex at chunk c's first: vertex_index / GRID_N^2 is the chunk (renderer.ts).
// The mesh chunks across and their side are Globals.ocean.yz (hybrid).
const GRID_N: u32 = 34u;

/** column q's top (window z): its surface and what's loose on it (as cellWater's level) */
fn gridTop(q: vec2<i32>) -> f32 {
  let c = clampCell(q);
  return sfZ(surface[colIdxI(c)]) + driftAt(c);
}

/** column q's centre (window coordinates) */
fn gridAt(q: vec2<i32>) -> vec2<f32> { return vec2<f32>(f32(q.x) + 0.5 + 0.5 * f32(q.y & 1), (f32(q.y) + 0.5) * 0.8660254); }

fn gridVertex(vi: u32) -> MOut {
  let per = GRID_N * GRID_N;
  let c = vi / per;
  let k = vi % per;
  let side = i32(G.ocean.z);
  let nx = max(u32(G.ocean.y), 1u);
  let lo = vec2<i32>(i32(c % nx), i32(c / nx)) * side;
  let q = clampCell(lo - vec2<i32>(1) + vec2<i32>(i32(k % GRID_N), i32(k / GRID_N)));
  var z = gridTop(q);
  // (past the chunk's edge — the cell it overlaps its neighbour by — kept near the edge's own top: a form or a
  // cliff just inside a voxel chunk doesn't pull a slope out of this one)
  let qi = clamp(q, lo, lo + vec2<i32>(side - 1));
  if (any(qi != q)) {
    let zi = gridTop(qi);
    z = clamp(z, zi - 1.5, zi + 1.5);
  }
  // the normal from the neighbours: along the row, and the rows above and below (their two columns straddling q)
  let o = q.y & 1;
  let hx = gridTop(q + vec2<i32>(1, 0)) - gridTop(q - vec2<i32>(1, 0));
  let up = 0.5 * (gridTop(vec2<i32>(q.x + o - 1, q.y + 1)) + gridTop(vec2<i32>(q.x + o, q.y + 1)));
  let dn = 0.5 * (gridTop(vec2<i32>(q.x + o - 1, q.y - 1)) + gridTop(vec2<i32>(q.x + o, q.y - 1)));
  let p = vec3<f32>(gridAt(q), z);
  var m: MOut;
  m.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  m.wpos = p;
  m.nrm = normalize(vec3<f32>(-hx / 2.0, -(up - dn) / (2.0 * 0.8660254), 1.0));
  m.share = 0.0;
  m.word = 0u;
  m.tint = 1.0;
  return m;
}

@vertex
fn vsGrid(@builtin(vertex_index) vi: u32) -> MOut {
  var m = gridVertex(vi);
  m.tint = meshTint(m.wpos);
  return m;
}

/** (the shadow pass's and the G-buffer's: the resolve takes the tint a pixel) */
@vertex
fn vsGridG(@builtin(vertex_index) vi: u32) -> MOut { return gridVertex(vi); }

/** (perfopt, ?prepass=1) The depth prepass: the mesh's depth only, so the look's pass shades each pixel once. */
@fragment
fn fsMeshZ(in: MOut) -> FOut {
  var f: FOut;
  f.color = vec4<f32>(0.0);
  f.pick = vec2<u32>(0u);
  return f;
}

/** the prepass with the cutaway on (its discard keeps the depth of what the cut opens) */
@fragment
fn fsMeshZCut(in: MOut) -> FOut {
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  var f: FOut;
  f.color = vec4<f32>(0.0);
  f.pick = vec2<u32>(0u);
  return f;
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
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  return meshShade(in);
}

// ---- (perfopt, ?defer=1) deferred: the mesh drawn to a G-buffer, its look shaded once a pixel ----------------
// At the phone's resolution (low: half the CSS pixels, dpr 1) a cell is ~1.3 pixels, so the mesh's triangles
// are about a pixel each: the GPU shades a 2 x 2 quad for every triangle touching a pixel (up to four times
// the look a pixel), and everything drawn behind the front surface too. Here the mesh's pass writes only
// what the look needs (where, the normal, the structure word and share, the tint: two uint targets) and a
// full-screen pass shades each pixel once.
struct GOut { @location(0) g0: vec4<u32>, @location(1) g1: vec2<u32> };
@group(0) @binding(40) var gbuf0: texture_2d<u32>;
@group(0) @binding(41) var gbuf1: texture_2d<u32>;

/** g0: the point's xyz (bits), w the normal (octahedral, 15 bits a side) | the source (bit 30: 1 the window's,
 *  0 the band's — MR.zb.w) | drawn (bit 31); g1: the structure word, the share (unorm16; the tint is the resolve's) */
fn gPack(in: MOut) -> GOut {
  let n = normalize(in.nrm);
  var o = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { o = (1.0 - abs(o.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), o >= vec2<f32>(0.0)); }
  let q = vec2<u32>(round(clamp(o * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * 32767.0));
  var g: GOut;
  g.g0 = vec4<u32>(bitcast<u32>(in.wpos.x), bitcast<u32>(in.wpos.y), bitcast<u32>(in.wpos.z), q.x | (q.y << 15u) | (u32(MR.zb.w) << 30u) | (1u << 31u));
  g.g1 = vec2<u32>(in.word, pack2x16unorm(vec2<f32>(in.share, 0.0)));
  return g;
}

@fragment
fn fsMeshG(in: MOut) -> GOut { return gPack(in); }

@fragment
fn fsMeshGCut(in: MOut) -> GOut {
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  return gPack(in);
}

/** a triangle over the whole screen */
@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

/** the look, a pixel at a time, from the G-buffer (drawn once for the window's source, once for the band's) */
@fragment
fn fsMeshResolve(@builtin(position) pos: vec4<f32>) -> FOut { return resolveAt(pos); }

/** (perfopt, ?tcache=N) the resolve into the terrain's cached layer: its depth too (a colour target: the
 *  composite reads it back and writes it as the frame's depth, moved by the camera's since) */
struct COut { @location(0) color: vec4<f32>, @location(1) pick: vec2<u32>, @location(2) depth: f32 };
@fragment
fn fsMeshResolveC(@builtin(position) pos: vec4<f32>) -> COut {
  let f = resolveAt(pos);
  let a = textureLoad(gbuf0, vec2<i32>(pos.xy), 0);
  let p = CAM.viewProj * vec4<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z), 1.0);
  var o: COut;
  o.color = f.color;
  o.pick = f.pick;
  o.depth = p.z / p.w;
  return o;
}

fn resolveAt(pos: vec4<f32>) -> FOut {
  let px = vec2<i32>(pos.xy);
  let a = textureLoad(gbuf0, px, 0);
  if ((a.w >> 31u) == 0u || ((a.w >> 30u) & 1u) != u32(MR.zb.w)) { discard; }
  let b = textureLoad(gbuf1, px, 0);
  let o = vec2<f32>(f32(a.w & 32767u), f32((a.w >> 15u) & 32767u)) / 32767.0 * 2.0 - 1.0;
  var n = vec3<f32>(o, 1.0 - abs(o.x) - abs(o.y));
  if (n.z < 0.0) { n = vec3<f32>((1.0 - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0)), n.z); }
  let st = unpack2x16unorm(b.y);
  var m: MOut;
  m.pos = pos;
  m.wpos = vec3<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z));
  m.nrm = normalize(n);
  m.share = st.x;
  m.word = b.x;
  m.tint = meshTint(m.wpos);
  return meshShade(m);
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

/** (perfopt, ?nodetail=fields) the cell's own fields, not blended over three */
fn cellFields1(xy: vec2<f32>) -> vec4<f32> {
  let j = colIdxI(clampCell(cellAt(xy)));
  return vec4<f32>(contam[j].x, veg[j], fields[j].y, wilt[j].y);
}

/** The look of the mesh's surface at a point (the forward pass's and the deferred resolve's). */
fn meshShade(in: MOut) -> FOut {
  // (round 82, V21: the inside of the ground, seen only where the cutaway opened it — a section through the
  // rock, dark and flat, not its far side lit as if it were outside. Its normal, not the winding: the mesh's
  // triangles face either way.)
  // (a little past edge-on: a silhouette's smooth normals tip under it)
  if (inCut(in.wpos) && dot(normalize(in.nrm), toEye(in.wpos)) < -0.15) {
    var f: FOut;
    f.color = vec4<f32>(0.12, 0.11, 0.1, 1.0); // (sRGB; world-core.ts SECTION_DARK)
    f.pick = vec2<u32>(0u, 0u);
    return f;
  }
  // (round 82, ?look=flat: grey by the normal — the geometry's own cost)
  if (MESH_LOOK == 2u) {
    var f: FOut;
    f.color = vec4<f32>(vec3<f32>(0.35 + 0.45 * max(dot(normalize(in.nrm), normalize(vec3<f32>(-0.4, -0.6, 0.7))), 0.0)), 1.0);
    f.pick = vec2<u32>(1u, 1u);
    return f;
  }
  let nrm = normalize(in.nrm);
  // one step into the surface: the interval this point of it belongs to
  let ip = in.wpos - nrm * 0.2;
  // (looked up a little off the point, a quarter cell at random: the borders
  // between cells of different ground come out ragged, not hexagons)
  let jit = vec3<i32>(floor(in.wpos * 4.0 - nrm * 0.02));
  let jo = vec2<f32>(randv(jit + vec3<i32>(41, 0, 0)), randv(jit + vec3<i32>(0, 43, 0))) - 0.5;
  // (?nodetail=warp: looked up where it is, not warped and jittered — the borders hexagons again)
  var cell: vec2<i32>;
  if (noDetail(ND_WARP)) { cell = clampCell(cellAt(ip.xy)); } else { cell = clampCell(cellAt(terrainWarp(ip) + jo * 0.6)); }
  let ci = colIdxI(cell);
  let up = nrm.z > 0.55;
  let lk = meshLook(cell, ip.z, up);
  var mat = lk.mat;
  // the cells' own fields blended over the three nearest (no hexagons in
  // the plants or stains): contamination, plants, wetness, withering
  var cf: vec4<f32>;
  if (noDetail(ND_FIELDS)) { cf = cellFields1(in.wpos.xy); } else { cf = cellFields(in.wpos.xy); }
  // (hybrid, round 86: a storm over land whose sim is asleep — a heightfield chunk past the storms' reach,
  // scenes/hybrid.ts — is wet under it all the same, as if it had rained there)
  if (G.numStorms > 0u && asleep(vec2<u32>(cell))) { cf.z = max(cf.z, 0.9 * stormCover(in.wpos.xy)); }
  let isTop = up && in.wpos.z > lk.top - 0.8;
  var alb = groundAlbedo(mat);
  // (?look=lookup: the interval's material and the lighting, none of the detail)
  if (MESH_LOOK == 1u) {
    var f: FOut;
    f.color = vec4<f32>(toSrgb(haze(alb * in.tint * lighting(in.wpos, nrm), in.wpos)), 1.0);
    f.pick = vec2<u32>(ci + 1u, mat | (u32(clamp(in.wpos.z, 0.0, 255.0)) << 8u));
    return f;
  }
  // a thin top layer shows the one beneath through it (a trace of blown dust
  // doesn't flip the ground's colour — round 17)
  if (isTop && lk.below != 0u) { alb = mix(groundAlbedo(lk.below), alb, smoothstep(0.02, 0.2, lk.thick)); }
  // per-voxel and sub-voxel variation (cell, whole heights), as the prisms had
  let vc = vec3<i32>(cell, i32(floor(ip.z)));
  let sub = vec3<i32>(floor(in.wpos * 4.0 - nrm * 0.02));
  let n1 = randv(sub);
  let n2 = randv(sub + vec3<i32>(71, 13, 5));
  // (round 79: on a steep face less of it — the beds read as sheets, not a mosaic of cells)
  let steep = 1.0 - smoothstep(0.3, 0.7, abs(nrm.z));
  if (!noDetail(ND_SPECKS)) { alb *= 1.0 + mix(1.0, 0.35, steep) * (0.12 * randv(vc) + 0.08 * n1 - 0.1); }
  alb *= in.tint;
  if (mat >= 1u && mat <= 4u && !noDetail(ND_STRATA)) {
    // (round 79: strata — render.wgsl)
    let band = strata(in.wpos);
    if (mat == 1u) { alb *= mix(vec3<f32>(0.8, 0.83, 0.9), vec3<f32>(1.16, 1.03, 0.88), band); }
    if (mat == 2u) { alb *= mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), band); }
    let pb = randv(sub + vec3<i32>(5, 77, 13));
    if (pb > 0.93) { alb *= 1.25; } else if (pb < 0.05) { alb *= 0.72; }
  }
  if ((mat == 23u || mat == 30u) && !noDetail(ND_STRATA)) { alb *= strataTint(mat, strata(in.wpos)); }
  if (mat == MAT_LEAFLIT) {
    // fallen leaves (round 51), as fsBox
    var tc = autumnLeaf(select(0u, 2u, n2 > 0.82), fract(n2 * 3.7));
    if (n2 < 0.3) { tc = mix(vec3<f32>(0.36, 0.24, 0.12), vec3<f32>(0.5, 0.34, 0.16), n1); }
    alb = toLinear(tc) * (0.7 + 0.4 * n1);
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
  if (isTop && !noDetail(ND_STAINS)) {
    let c = cf.x;
    let stain = smoothstep(0.12, 1.1, c);
    let oil = mix(vec3<f32>(0.10, 0.09, 0.06), vec3<f32>(0.42, 0.40, 0.12), smoothstep(0.55, 0.95, n2));
    alb = mix(alb, toLinear(oil), stain * 0.8);
  }
  // wet ground darkens
  alb *= 1.0 - MATS[mat].eco.w * 0.5 * smoothstep(0.15, 0.9, cf.z);
  // plant cover on tops, a few tufts of it up the slopes
  // (plants on a face only near its top: a cut face isn't green all the way down — round 79)
  let v = select(cf.y, 0.0, (!isTop && in.wpos.z < lk.top - 2.5) || noDetail(ND_PLANTS));
  if (v > 0.0) {
    let cover = select(smoothstep(0.8, 3.0, v) * 0.55 * (0.5 + 0.5 * n2), smoothstep(0.0, 1.2, v), isTop);
    if (n1 < cover) {
      var g = mix(vec3<f32>(0.33, 0.40, 0.17), vec3<f32>(0.36, 0.54, 0.19), smoothstep(1.0, 2.0, v));
      g = mix(g, vec3<f32>(0.17, 0.33, 0.12), smoothstep(3.0, 4.5, v));
      // (it turns with the season, as fsBox)
      g = mix(g, seasonGrass(g, fbm2(wo(in.wpos.xy) * 0.08)), 1.0 - 0.5 * smoothstep(3.0, 4.5, v));
      alb = wither(toLinear(g * (0.82 + 0.3 * n2)), cf.w, n2);
      // (perfopt, ?tufts=0: no tuft boxes — their look painted here instead: on soil-like ground, a quarter cell
      // in shade here and there, as many as vegplan.wgsl would stand there)
      if (!TUFTS_DRAWN && isTop && MATS[lk.mat].eco.x >= 2.0) {
        let tr = randv(vec3<i32>(vec2<i32>(floor(in.wpos.xy * 4.0)), 911));
        // (a tuft's shaded side, or its lit top)
        let d = smoothstep(1.2, 2.5, v);
        if (tr < d * 0.32) { alb *= 0.5; } else if (tr < d * 0.44) { alb *= 1.25; }
      }
    }
  }
  // a structure's face: its moss, and the sand lying against it
  let sw = smoothstep(0.35, 0.65, in.share);
  if (sw > 0.0 && in.word != 0u && !noDetail(ND_STRUCT)) {
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
    // snow or dust on its up faces (round 52; the raw voxel word: bits 24..29)
    sa = coverLook(sa, nrm, in.wpos, ceil(in.wpos.z - 0.05), f32((w >> 24u) & 31u) / 31.0, ((w >> 29u) & 1u) != 0u, s);
    alb = mix(alb, sa, sw);
    if (sw > 0.5) { mat = voxMatR(w); }
  }
  // water on the ground: a film where it runs too thin to clear the
  // smoothed ground (the sheet draws the rest), darker wet ground above the
  // water's edge, and the swash running up and back (round 41)
  var wt = CellWater(0.0, 0.0, 0.0, vec2<f32>(0.0));
  if (!noDetail(ND_WATER)) { wt = cellWater(in.wpos.xy); }
  var film = 0.0;
  var filmN = nrm;
  if (wt.wet > 0.0 && nrm.z > 0.2 && sw < 0.5) {
    film = smoothstep(WATER_MIN_R, 0.05, wt.d);
    let above = in.wpos.z - wt.level;
    let wv = windAt(vec3<f32>(in.wpos.xy, in.wpos.z + 0.5));
    let lw = clamp(length(wv) / 4.0, 0.0, 1.5);
    // the swash: how far up the waves run now (higher in the wind), ragged along the shore
    let along = vnoise(wo(in.wpos.xy) * 0.7 + 3.0);
    let run = (0.06 + 0.12 * lw) * (0.55 + 0.45 * sin(G.time * 1.3 + along * 9.0));
    let damp = smoothstep(run + 0.35, run, above) * (1.0 - film);
    alb *= 1.0 - 0.45 * max(film, damp * 0.75) * (0.4 + 0.6 * MATS[mat].eco.w);
    // (a glaze of the water's own colour, more of it the deeper)
    alb = mix(alb, toLinear(vec3<f32>(0.30, 0.45, 0.44)) * 0.75, film * mix(0.3, 0.6, smoothstep(0.05, 0.3, wt.d)));
    // the film's streaks running with the flow, and foam where it's fast
    let fl = length(wt.flow);
    let st = flowStreaks(in.wpos.xy, wt.flow, wt.d) * smoothstep(0.003, 0.04, fl);
    alb += toLinear(vec3<f32>(0.42, 0.48, 0.48)) * film * smoothstep(0.5, 0.9, st) * 0.3;
    let froth = film * smoothstep(0.04, 0.2, fl) * smoothstep(0.62, 0.85, flowStreaks(wo(in.wpos.xy) * 1.7, wt.flow, wt.d));
    let lip = smoothstep(0.05, 0.0, abs(above - run)) * (1.0 - film) * smoothstep(0.3, 0.65, vnoise(wo(in.wpos.xy) * 2.2 + vec2<f32>(G.time * 0.35, 0.0)));
    alb = mix(alb, toLinear(vec3<f32>(0.82, 0.84, 0.82)), max(froth * 0.6, lip * 0.55 * (0.4 + 0.6 * lw)));
    filmN = windWaves(in.wpos.xy, in.wpos.z, 0.25 + 0.5 * lw);
  }
  // the detail layer (only where a chip is a few pixels across)
  var lnrm = nrm;
  if (CAM.viewport.z > 4.0 && sw < 0.5) {
    // (round 79: the bedded rocks too — sandstone, basalt, obsidian were chips like rubble, blotching a cliff's face)
    if (mat == MAT_STONE || bedded(mat)) {
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
  // (round 83: quartz cut as a gem — the hoverbike's playtest: the giant crystals didn't look faceted)
  if (mat == MAT_QUARTZ && sw < 0.5) { col = gemLook(in.wpos, nrm); }
  if (film > 0.0) {
    // the wet sheen: the sun's glint off the film
    let sunL = sunDir();
    let fn2 = normalize(nrm + vec3<f32>(filmN.xy, 0.0));
    let hv = normalize(normalize(sunL + toEye(in.wpos)) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(dot(fn2, hv), 0.0), 120.0) * (1.0 - cloudShade(in.wpos.xy)) * shadowLit(in.wpos, nrm);
    col += G.sunCol.rgb * (1.0 / 2.4) * spec * 0.6 * film;
    // and the sky in it
    col += G.sky.rgb * 0.08 * film;
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  // (the band's z runs past the byte: round 79)
  o.pick = vec2<u32>(ci + 1u, mat | (u32(clamp(in.wpos.z, 0.0, 255.0)) << 8u));
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
  return m == 4u || m == MAT_TRASH || m == MAT_LITTER || (matState(m) == ST_SOLID && m != MAT_STONE && m != MAT_QUARTZ && !bedded(m));
}

/**
 * Quartz as a cut gem (round 83): the smooth normal snapped to facets (12 ways round, 5 up: flat faces
 * with sharp edges between them whatever the mesh's triangles), each facet its own shade between violet
 * and a pale blue; lit, a glint off the facets turned to the sun, the sky's rim at grazing angles, and a
 * glow of its own (more at night).
 */
fn gemLook(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  // (60° round: a hexagonal crystal's six sides a face each; three up — side, shoulder, point)
  let az = atan2(n.y, n.x);
  let el = asin(clamp(n.z, -1.0, 1.0));
  let ia = floor(az / 1.0471976 + 0.5);
  let ie = clamp(floor(el / 0.7853982 + 0.5), -1.0, 2.0);
  // (and bands up it, 9 cells each: long facets, as a crystal's striations)
  let id = vec3<i32>(i32(ia), i32(ie), i32(floor(p.z / 9.0)));
  let h = randv(id);
  let a2 = (ia + (h - 0.5) * 0.3) * 1.0471976;
  let e2 = ie * 0.7853982 + (randv(id + vec3<i32>(7, 3, 1)) - 0.5) * 0.3;
  var fnm = vec3<f32>(cos(a2) * cos(e2), sin(a2) * cos(e2), sin(e2));
  if (dot(fnm, n) < 0.2) { fnm = n; }
  let alb = mix(toLinear(vec3<f32>(0.62, 0.5, 0.92)), toLinear(vec3<f32>(0.72, 0.86, 0.98)), h) * (0.85 + 0.25 * randv(id + vec3<i32>(1, 9, 5)));
  var c = alb * lighting(p, fnm);
  let e = toEye(p);
  let sunL = sunDir();
  let hv = normalize(sunL + e);
  c += G.sunCol.rgb * pow(max(dot(fnm, hv), 0.0), 24.0) * 0.35 * shadowLit(p, n);
  c += G.sky.rgb * 0.3 * pow(1.0 - max(dot(fnm, e), 0.0), 3.0);
  c += alb * (0.15 + 0.3 * (1.0 - smoothstep(-0.1, 0.25, sunL.z)));
  return c;
}

/** rock in beds (round 79): basalt, sandstone, obsidian — faceted as stone is, its strata tinted */
fn bedded(m: u32) -> bool { return m == 23u || m == 30u || m == 35u; }
