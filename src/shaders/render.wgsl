// ---- renderer: hex prisms and boxes, opaque + water --------------------------
// One instanced draw per list. Column intervals are hex prisms on the nature
// grid (docs/GRIDS.md), 30 vertices: the top in four triangles and the three
// sides toward the eye. Plants are axis-aligned boxes, 18 vertices: the top
// and the two sides toward the eye (their own list: renderer.ts).
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,      // direction toward the eye (world), w look flags (1: flat-lit tops, ?smooth=0; 2: the field mesh draws the ground, ?mesh=1)
  viewport: vec4<f32>, // px w, px h, px per world unit, the shadow lookup's depth bias (light clip units)
  // world → the sun's shadow map (clip space; renderer.ts lightMatrix)
  light: mat4x4<f32>,
  // where the eye is (round 69: the free camera, perspective), w 1 when it's there; 0: the fixed view
  pos: vec4<f32>,
  // (round 83, V21) what's cut from the view (api/cutaway.ts; camera.ts Cut): x a slice's height (w 1: on),
  // y how many points are kept seen, z how many boxes may be dithered
  cut: vec4<f32>,
  // the points kept seen: xyz the point's base, w a hole's radius on screen (world units)
  see: array<vec4<f32>, 4>,
  // what may be dithered: lo xyz, hi xyz (two a box)
  boxes: array<vec4<f32>, 8>,
};

/** 4 × 4 ordered dither, 0..1 (a pixel's threshold) */
fn bayer4(px: vec2<f32>) -> f32 {
  let i = vec2<u32>(px) & vec2<u32>(3u);
  let m = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
  return (f32(m[i.y * 4u + i.x]) + 0.5) / 16.0;
}

/**
 * How far into a kept-seen point's hole p is, 0..1 (round 83, V21: api/cutaway.ts Dither): in front of the
 * point (over a cell and a half toward the eye) and over its base, near it on screen, thinning over the
 * outer third of the circle; where boxes are marked, only in one of them.
 */
fn seeReach(p: vec3<f32>) -> f32 {
  let n = u32(CAM.cut.y);
  if (n == 0u) { return 0.0; }
  let e = toEye(p);
  var k = 0.0;
  for (var i = 0u; i < n; i++) {
    let s = CAM.see[i];
    let v = p - s.xyz;
    let along = dot(v, e);
    let r = (1.0 - smoothstep(s.w * 0.7, s.w, length(v - along * e))) * smoothstep(1.0, 2.0, along) * smoothstep(0.0, 0.8, p.z - s.z);
    k = max(k, r);
  }
  let nb = u32(CAM.cut.z);
  if (nb > 0u) {
    var inside = false;
    for (var i = 0u; i < nb; i++) {
      let lo = CAM.boxes[i * 2u].xyz - vec3<f32>(0.5);
      let hi = CAM.boxes[i * 2u + 1u].xyz + vec3<f32>(0.5);
      if (all(p >= lo) && all(p <= hi)) { inside = true; }
    }
    if (!inside) { return 0.0; }
  }
  return k;
}

/** over the slice (round 83, V21: api/cutaway.ts Slice) */
fn sliced(p: vec3<f32>) -> bool { return CAM.cut.w > 0.5 && p.z > CAM.cut.x; }

/** Is p where the view was cut open (the slice on, or in a hole)? A surface seen from inside the solid there is drawn dark (a section). */
fn inCut(p: vec3<f32>) -> bool { return CAM.cut.w > 0.5 || seeReach(p) > 0.5; }

/**
 * Is this point cut away (round 83, V21)? Over the slice, sharply; in a kept-seen point's hole, dithered (it
 * opens and closes as an iris). The shadow pass doesn't cut: the light stays.
 */
fn cutAway(p: vec3<f32>, px: vec2<f32>) -> bool {
  return sliced(p) || seeReach(p) > bayer4(px);
}

/** toward the eye from p: one way for the fixed (orthographic) view, from where it is for the free one */
fn toEye(p: vec3<f32>) -> vec3<f32> {
  if (CAM.pos.w > 0.5) { return normalize(CAM.pos.xyz - p); }
  return CAM.eye.xyz;
}

// the sun's shadow map (with the field mesh: renderer.ts shadow pass)
@group(0) @binding(25) var shadowMap: texture_depth_2d;
@group(0) @binding(26) var shadowSamp: sampler_comparison;

/**
 * Direct-light visibility 0..1 from the shadow map: the point (nudged off its
 * surface along its normal) in the sun's view, compared with the nearest
 * depth there, over four filtered taps (soft edges).
 */
fn shadowLit(wpos: vec3<f32>, nrm: vec3<f32>) -> f32 {
  let lp = CAM.light * vec4<f32>(wpos + nrm * 0.15, 1.0);
  let uv = vec2<f32>(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  if (any(uv <= vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0))) { return 1.0; }
  let t = 0.75 / vec2<f32>(textureDimensions(shadowMap));
  let z = lp.z - CAM.viewport.w;
  var s = 0.0;
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(-t.x, -t.y), z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(t.x, -t.y), z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(-t.x, t.y), z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(t.x, t.y), z);
  return s * 0.25;
}

@group(0) @binding(3) var<storage, read> instances: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(6) var<storage, read> veg: array<f32>;
// packed per-column render fields: x shadow z, y moisture, z fire glow, w flow speed
@group(0) @binding(7) var<storage, read> fields: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> water: array<f32>;
@group(0) @binding(10) var<uniform> CAM: Camera;
// the loose layers beneath the top one (drift.wgsl strata): a thin top layer
// is drawn blended with the layer under it
@group(0) @binding(19) var strataTexR: texture_2d<f32>;

/** Material of the loose layer just beneath the top on q (0 if none). */
fn looseBelowAt(q: vec2<i32>) -> u32 {
  let s = textureLoad(strataTexR, q, 0);
  var m = 0u;
  for (var k = 0; k < 3; k++) { if (s[k] > 0.0) { m = u32(floor(s[k] / 1000.0)); } }
  return m;
}
@group(0) @binding(11) var<storage, read> surface: array<u32>;
// vegetation lean spring per column (sway.wgsl): xy lean, zw velocity
@group(0) @binding(12) var<storage, read> bend: array<vec4<f32>>;
// plant health (wilt.wgsl): y = brownness of plants here (withering, scorched)
@group(0) @binding(13) var<storage, read> wilt: array<vec4<f32>>;

/**
 * Smooth depth of a sheet at a world point: interpolated over the three
 * nearest column centres (the hex lattice's triangles), so its outline (an
 * isoline) is rounded rather than following the cells (round 12). kind 0
 * drift, 1 water.
 */
fn sheetDepth(p: vec2<f32>, kind: u32) -> f32 {
  let t = triAt(p);
  var s = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    s += t.w[k] * select(driftAt(q), water[colIdxI(q)], kind == 1u);
  }
  return s;
}

/** Withering plants dry out to straw and brown. */
fn wither(c: vec3<f32>, b: f32, n: f32) -> vec3<f32> {
  let dry = mix(vec3<f32>(0.55, 0.45, 0.22), vec3<f32>(0.36, 0.25, 0.13), smoothstep(0.5, 1.0, b) * (0.6 + 0.4 * n));
  return mix(c, toLinear(dry), smoothstep(0.05, 0.7, b));
}

const QUAD = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  @location(2) @interpolate(flat) info: vec2<u32>, // material, flags
  // large-scale ground patchiness; smooth, so evaluated per vertex (was per pixel)
  @location(3) tint: f32,
  // the box's z range (liquids derive depth from it)
  @location(4) @interpolate(flat) zr: vec2<f32>,
  // box bounds and its sway offset (sub-voxel canopies march inside the box;
  // a hex prism: its cell's centre - 0.5, and 1 x 1)
  @location(5) @interpolate(flat) bmin: vec3<f32>,
  @location(6) @interpolate(flat) bsize: vec3<f32>,
  @location(7) @interpolate(flat) boff: vec3<f32>,
  // a hex prism's hidden sides (bit k: toward neighbour k), and PRISM
  @location(8) @interpolate(flat) sides: u32,
};

const FLAG_VEG_R: u32 = 2u;
const FLAG_DETAIL: u32 = 128u;
const FLAG_TOP_R: u32 = 1u;
const PRISM: u32 = 64u;

// An instance: column intervals (water, oil, the loose sheet too) are hex
// prisms on their cell; plants are axis-aligned boxes. x, y: a box's world
// minimum corner; a prism's cell centre - 0.5.
struct Box { x: f32, y: f32, sx: f32, sy: f32, z0: f32, z1: f32, mat: u32, flags: u32, cell: vec2<i32>, sides: u32, hex: bool };

fn unpackBox(v: vec4<u32>) -> Box {
  var b: Box;
  let gx = f32(v.x & 0xfffu);
  let gy = f32((v.x >> 12u) & 0xfffu);
  b.sx = f32(((v.x >> 24u) & 0xfu) + 1u);
  b.sy = f32(((v.x >> 28u) & 0xfu) + 1u);
  b.z0 = bitcast<f32>(v.y);
  b.z1 = bitcast<f32>(v.z);
  b.mat = v.w & 0xffu;
  b.flags = (v.w >> 8u) & 0xfffu;
  b.sides = (v.w >> 20u) & 63u;
  b.hex = (b.flags & (FLAG_VEG_R | FLAG_DETAIL)) == 0u;
  // packed in storage cells (detail instances in quarter cells): place the
  // box by its centre - the cell it's in, then that cell's world centre
  let q = select(1.0, 0.25, (b.flags & FLAG_DETAIL) != 0u);
  b.sx *= q;
  b.sy *= q;
  let cs = vec2<f32>(gx * q + b.sx * 0.5, gy * q + b.sy * 0.5);
  b.cell = vec2<i32>(floor(cs));
  let wc = cellPos(b.cell) + (fract(cs) - 0.5) * vec2<f32>(1.0, ROW_H);
  b.x = wc.x - b.sx * 0.5;
  b.y = wc.y - b.sy * 0.5;
  return b;
}

/**
 * Vegetation sway in the shared wind field (prevailing wind, storms, gusts and
 * the cursor breeze): canopies shift rigidly, stems/shrubs/tufts bend (only
 * their top moves). Returns the offset for a vertex at height fraction h.
 */
fn swayOffset(b: Box, h: f32) -> vec3<f32> {
  let c = vec2<f32>(b.x + b.sx * 0.5, b.y + b.sy * 0.5);
  // the lean is a per-column spring (sway.wgsl): plants bend with the wind,
  // hold it, and spring back slowly when it drops
  let lean = bend[colIdxI(clampCell(b.cell))].xy;
  let amp = length(lean) / 0.3;
  let dir = lean / max(length(lean), 1e-4);
  let seed = fract(sin(dot(c, vec2<f32>(12.9898, 78.233))) * 43758.5453);
  // a slow, relaxed flutter on top (fixed frequency: no phase jumps)
  let flutter = dir * sin(G.time * 2.2 + seed * 30.0) * 0.05 * (0.3 + amp);
  var k = h;
  if (b.mat == MAT_LEAVES && b.sx > 1.5) { k = 1.0; } // canopy: rigid
  return vec3<f32>((lean + flutter) * k, 0.0);
}

/** Corner height of a smooth sheet (water or drift prism) at corner j of p. */
fn sheetOr(m: u32, p: vec2<i32>, j: u32, z: f32) -> f32 {
  let c = select(waterCornerAt(p, j), driftCornerAt(p, j), m == MAT_DRIFT);
  return select(c, z, c < 0.0);
}


/** Drawn top height of a prism at its corner j. */
fn prismCornerZ(b: Box, j: u32, soft: bool, liquid: bool) -> f32 {
  if (liquid) { return sheetOr(b.mat, b.cell, j, b.z1); }
  if (soft) { return cornerOr(b.cell, j, b.z1); }
  return b.z1;
}

/** The top of a prism as four triangles over its corners (symmetric: the three ears and the middle). */
const TOP_TRI = array<u32, 12>(0u, 1u, 2u, 2u, 3u, 4u, 4u, 5u, 0u, 0u, 2u, 4u);

/**
 * A hex prism (a column interval): 30 vertices - the top as four triangles
 * over its corners (soft ground and sheets slope through their shared corner
 * heights), then the three sides facing the camera. The top takes one flat
 * normal, the plane fitted through its corners (renderfields.wgsl caches it
 * per cell): per-triangle normals showed every hexagon's facets wherever the
 * smoothed corners aren't coplanar. (A fan from the centre cost six more
 * vertices for nothing the flat normal shows; draw is vertex-bound.)
 */
fn prismVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  let c = cellPos(b.cell);
  // soft ground: the column's top is drawn sloped (terrainshape.wgsl)
  let soft = (b.flags & FLAG_TOP_R) != 0u && MATS[b.mat].look.x > 0.0;
  // water and drifted dust: smooth sheets through their corner levels
  let liquid = b.mat == MAT_WATER || b.mat == MAT_DRIFT;
  var p: vec3<f32>;
  var n: vec3<f32>;
  var shown = true;
  if (vi < 12u) {
    let j = TOP_TRI[vi];
    var g = vec2<f32>(0.0);
    if (soft || liquid) {
      g = planeAt(b.cell, select(select(0u, 1u, b.mat == MAT_WATER), 2u, b.mat == MAT_DRIFT)).g;
    }
    p = vec3<f32>(c + cornerOffset(j), prismCornerZ(b, j, soft, liquid));
    n = normalize(vec3<f32>(-g, 1.0));
    shown = (b.flags & 64u) == 0u;
  } else {
    let s = (vi - 12u) / 6u;
    let uv = QUAD[(vi - 12u) % 6u];
    // the three sides facing the eye: the one most squarely toward it, and
    // the one either side
    let te = toEye(vec3<f32>(c, (b.z0 + b.z1) * 0.5));
    let m0 = i32(round(atan2(te.y, te.x) / 1.0471976));
    let m = u32((m0 - 1 + i32(s) + 12) % 6);
    // side m runs from corner m - 1 to corner m
    let j = select((m + 5u) % 6u, m, uv.x > 0.5);
    let k = SIDE_DIR[m];
    var top = b.z1;
    if (soft) { top = cornerOr(b.cell, j, b.z1); }
    if (liquid) { top = max(sheetOr(b.mat, b.cell, j, b.z1), b.z0); }
    p = vec3<f32>(c + cornerOffset(j), mix(b.z0, top, uv.y));
    n = vec3<f32>(DIRV[k], 0.0);
    shown = ((b.sides >> k) & 1u) == 0u;
    // a drift sheet tapers into the ground where it can (its corners meet the
    // neighbour's: no side there); where it stops at a step (a corner left at
    // the prism's height) it shows that side, up to its corner levels - without
    // it the background showed through under the sheet's edge (round 30)
    if (b.mat == MAT_DRIFT) {
      let nb = nbr(b.cell, k);
      if (!sheetGap(b.cell, (m + 5u) % 6u, nb) && !sheetGap(b.cell, m, nb)) { shown = false; }
    }
    // water: no side inside a continuous body of water
    if (b.mat == MAT_WATER) {
      let q = nbr(b.cell, k);
      if (inMap(q)) {
        let jq = colIdxI(q);
        if (f32(sfZ(surface[jq])) + driftAt(q) + water[jq] >= b.z1 - 0.02) { shown = false; }
      }
    }
  }
  (*out).pos = CAM.viewProj * vec4<f32>(p, 1.0);
  (*out).wpos = p;
  (*out).bmin = vec3<f32>(c - 0.5, b.z0);
  (*out).bsize = vec3<f32>(1.0, 1.0, b.z1 - b.z0);
  (*out).boff = vec3<f32>(0.0);
  (*out).nrm = n;
  (*out).tint = 0.82 + 0.36 * fbm2(wo(p.xy) * 0.045 + vec2<f32>(p.z * 0.02));
  (*out).info = vec2<u32>(b.mat, b.flags);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).sides = b.sides | PRISM;
  return b.z1 > b.z0 && shown;
}

/** A plant box: its top and the two sides toward the eye (18 vertices). */
fn boxVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  let face = vi / 6u;
  let uv = QUAD[vi % 6u];
  let te = toEye(vec3<f32>(b.x + b.sx * 0.5, b.y + b.sy * 0.5, (b.z0 + b.z1) * 0.5));
  let sxn = select(-1.0, 1.0, te.x > 0.0);
  let syn = select(-1.0, 1.0, te.y > 0.0);
  var p: vec3<f32>;
  var n: vec3<f32>;
  if (face == 0u) {
    p = vec3<f32>(b.x + uv.x * b.sx, b.y + uv.y * b.sy, b.z1);
    n = vec3<f32>(0.0, 0.0, 1.0);
  } else if (face == 1u) {
    let fx = select(b.x, b.x + b.sx, sxn > 0.0);
    p = vec3<f32>(fx, b.y + uv.x * b.sy, mix(b.z0, b.z1, uv.y));
    n = vec3<f32>(sxn, 0.0, 0.0);
  } else {
    let fy = select(b.y, b.y + b.sy, syn > 0.0);
    p = vec3<f32>(b.x + uv.x * b.sx, fy, mix(b.z0, b.z1, uv.y));
    n = vec3<f32>(0.0, syn, 0.0);
  }
  var off = vec3<f32>(0.0);
  if ((b.flags & FLAG_VEG_R) != 0u) {
    let h = clamp((p.z - b.z0) / max(b.z1 - b.z0, 1e-3), 0.0, 1.0);
    off = swayOffset(b, h);
    p += off;
  }
  (*out).pos = CAM.viewProj * vec4<f32>(p, 1.0);
  (*out).wpos = p;
  (*out).bmin = vec3<f32>(b.x, b.y, b.z0);
  (*out).bsize = vec3<f32>(b.sx, b.sy, b.z1 - b.z0);
  (*out).boff = swayOffsetRigid(b, off);
  (*out).nrm = n;
  (*out).tint = 0.82 + 0.36 * fbm2(wo(p.xy) * 0.045 + vec2<f32>(p.z * 0.02));
  (*out).info = vec2<u32>(b.mat, b.flags);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).sides = 0u;
  return b.z1 > b.z0;
}

fn instVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  if (b.hex) { return prismVertex(b, vi, out); }
  return boxVertex(b, vi, out);
}

@vertex
fn vsBox(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let b = unpackBox(instances[ii]);
  var shown: bool;
  if ((u32(CAM.eye.w) & 2u) != 0u && b.mat == MAT_LAVA_M) { shown = lavaSheetVertex(b, ii, vi, &o); }
  else { shown = instVertex(b, vi, &o); }
  if (!shown) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); }
  return o;
}

/**
 * Lava over the field mesh (round 48: smooth like the ground, not hex
 * prisms): as waterSheetVertex, the six triangles round the column's centre
 * over the cell-centre lattice, each drawn once (by its lowest lava corner).
 * The levels round it come from lava.wgsl prep, after the prisms in the
 * same buffer: by direction, a lava neighbour's level, a dry one's ground as
 * -1 - ground. A dry corner stands at the lava's level or its ground below
 * it, so the edge slopes down onto the ground.
 */
fn lavaSheetVertex(b: Box, ii: u32, vi: u32, out: ptr<function, VOut>) -> bool {
  if (vi >= 18u) { return false; }
  let t = vi / 3u;
  let p = b.cell;
  let da = SIDE_DIR[t];
  let db = SIDE_DIR[(t + 1u) % 6u];
  let qa = nbr(p, da);
  let qb = nbr(p, db);
  let o = arrayLength(&instances) / 3u + 2u * ii;
  let l0 = instances[o];
  let l1 = instances[o + 1u];
  let lv = array<f32, 6>(bitcast<f32>(l0.x), bitcast<f32>(l0.y), bitcast<f32>(l0.z), bitcast<f32>(l0.w), bitcast<f32>(l1.x), bitcast<f32>(l1.y));
  let me = b.z1;
  let ra = lv[da];
  let rb = lv[db];
  let wa = ra >= 0.0;
  let wb = rb >= 0.0;
  let ip = colIdxI(p);
  if (wa && colIdxI(qa) < ip) { return false; }
  if (wb && colIdxI(qb) < ip) { return false; }
  let level = (me + select(0.0, ra, wa) + select(0.0, rb, wb)) / (1.0 + f32(wa) + f32(wb));
  // (a dry corner dips under its ground: the ground's smoothed mesh then cuts
  // the edge along a curve, not the triangles' zigzag)
  let za = select(min(level, -1.0 - ra) - 0.12, ra, wa);
  let zb = select(min(level, -1.0 - rb) - 0.12, rb, wb);
  let pa = vec3<f32>(cellPos(qa), za);
  let pb = vec3<f32>(cellPos(qb), zb);
  let pm = vec3<f32>(cellPos(p), me);
  let k = vi % 3u;
  var v = pm;
  if (k == 1u) { v = pa; } else if (k == 2u) { v = pb; }
  var n = normalize(cross(pa - pm, pb - pm));
  if (n.z < 0.0) { n = -n; }
  (*out).pos = CAM.viewProj * vec4<f32>(v, 1.0);
  (*out).wpos = v;
  (*out).nrm = n;
  (*out).info = vec2<u32>(MAT_LAVA_M, b.flags);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).tint = 1.0;
  (*out).bmin = vec3<f32>(cellPos(p) - 0.5, b.z0);
  (*out).bsize = vec3<f32>(1.0, 1.0, b.z1 - b.z0);
  (*out).boff = vec3<f32>(0.0);
  (*out).sides = 0u;
  return true;
}

@vertex
fn vsWater(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let b = unpackBox(instances[ii]);
  var shown: bool;
  if ((u32(CAM.eye.w) & 2u) != 0u && b.mat == MAT_WATER) { shown = waterSheetVertex(b, vi, &o); }
  else { shown = instVertex(b, vi, &o); }
  if (!shown) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); }
  return o;
}

/** The water's level on q if it's wet (x; y 1), else its ground (x; y 0). */
fn waterLevelAt(q: vec2<i32>) -> vec2<f32> {
  let j = colIdxI(clampCell(q));
  let bed = f32(sfZ(surface[j])) + driftAt(clampCell(q));
  let d = water[j];
  if (inMap(q) && d > WATER_MIN_R) { return vec2<f32>(bed + d, 1.0); }
  return vec2<f32>(bed, 0.0);
}

/**
 * Water over the field mesh (?mesh=1): no prisms but one smooth sheet over
 * the triangle lattice of the cell centres. A wet column draws the six
 * triangles round its centre (18 vertices), each of them drawn once, by its
 * wet corner first in storage order (it's blended: twice would show). A dry
 * corner stands at the water's level, or at its own ground where that's
 * lower: the sheet runs on into a bank, and the opaque ground's depth cuts
 * the shore there; down a step it slopes to the ground below and thins out.
 */
fn waterSheetVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  if (vi >= 18u) { return false; }
  let t = vi / 3u;
  let p = b.cell;
  // the triangle's corners: me and the neighbours across sides t and t + 1
  let qa = nbr(p, SIDE_DIR[t]);
  let qb = nbr(p, SIDE_DIR[(t + 1u) % 6u]);
  let me = waterLevelAt(p);
  let la = waterLevelAt(qa);
  let lb = waterLevelAt(qb);
  let ip = colIdxI(p);
  if (la.y > 0.0 && colIdxI(qa) < ip) { return false; }
  if (lb.y > 0.0 && colIdxI(qb) < ip) { return false; }
  // the level of its wet corners; a dry corner at that level or its ground below it
  let level = (me.x + la.x * la.y + lb.x * lb.y) / (1.0 + la.y + lb.y);
  let za = select(min(level, la.x), la.x, la.y > 0.0);
  let zb = select(min(level, lb.x), lb.x, lb.y > 0.0);
  let pa = vec3<f32>(cellPos(qa), za);
  let pb = vec3<f32>(cellPos(qb), zb);
  let pm = vec3<f32>(cellPos(p), me.x);
  let k = vi % 3u;
  var v = pm;
  if (k == 1u) { v = pa; } else if (k == 2u) { v = pb; }
  var n = normalize(cross(pa - pm, pb - pm));
  if (n.z < 0.0) { n = -n; }
  (*out).pos = CAM.viewProj * vec4<f32>(v, 1.0);
  (*out).wpos = v;
  (*out).nrm = n;
  (*out).info = vec2<u32>(MAT_WATER, 0u);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  (*out).tint = 1.0;
  (*out).bmin = vec3<f32>(cellPos(p) - 0.5, b.z0);
  (*out).bsize = vec3<f32>(1.0, 1.0, b.z1 - b.z0);
  (*out).boff = vec3<f32>(0.0);
  (*out).sides = 0u;
  return true;
}

struct FOut {
  @location(0) color: vec4<f32>,
  // pick: x = column+1 (0 = nothing), y = material | z<<8 | flags<<16
  @location(1) pick: vec2<u32>,
};

fn toLinear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }

/**
 * Snow or dust lying on a structure's face (round 52; structtick.wgsl keeps
 * it): cover 0..1, over the faces that look up, ragged at its thin edge
 * (sub: a 0..1 per-fragment dither), with a lip of it hanging over the
 * sides near the top (ztop: the voxel's top, roughly). The albedo in, out.
 */
fn coverLook(alb: vec3<f32>, nrm: vec3<f32>, wpos: vec3<f32>, ztop: f32, cover: f32, dusty: bool, sub: f32) -> vec3<f32> {
  if (cover <= 0.0) { return alb; }
  let onTop = nrm.z > 0.5 && cover > 0.03 + 0.5 * sub * (1.0 - cover);
  let lip = nrm.z > -0.2 && nrm.z <= 0.5 && cover > 0.45 && wpos.z > ztop - 0.18 * cover * (0.6 + 0.8 * sub);
  if (!onTop && !lip) { return alb; }
  let c = select(vec3<f32>(0.86, 0.88, 0.93), vec3<f32>(0.6, 0.53, 0.43), dusty);
  // (dust thin over it lets the face show through)
  let k = select(1.0, smoothstep(0.03, 0.4, cover), dusty);
  return mix(alb, toLinear(c) * (0.94 + 0.12 * sub), k);
}

fn toSrgb(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }

/** Column whose fields describe this fragment (step slightly into the surface). */
fn fragCell(wpos: vec3<f32>, nrm: vec3<f32>) -> vec2<i32> {
  return clampCell(cellAt(wpos.xy - nrm.xy * 0.01));
}

/** A face's own 2D coordinates: tops their xy, sides along the wall and up. */
fn faceUV(wpos: vec3<f32>, nrm: vec3<f32>) -> vec2<f32> {
  if (abs(nrm.z) > 0.5) { return wpos.xy; }
  return vec2<f32>(dot(wpos.xy, normalize(vec2<f32>(-nrm.y, nrm.x))), wpos.z);
}

/** The box offset used by the sub-voxel march (only meaningful for rigid canopies). */
fn swayOffsetRigid(b: Box, off: vec3<f32>) -> vec3<f32> {
  if (b.mat == MAT_LEAVES && b.sx > 1.5) { return off; }
  return vec3<f32>(0.0);
}

/**
 * A smooth top's normal at xy: the fitted planes (renderfields.wgsl) of the
 * three cells round it, blended barycentrically over the triangle lattice of
 * centres — so light runs smoothly across the cells instead of each hexagon
 * taking its own flat normal (which is what made the hexes read). A cell
 * whose top of this kind stands far from mine (a step, another level) is left
 * out: its slope isn't this surface's.
 */
fn smoothNormal(xy: vec2<f32>, cell: vec2<i32>, kind: u32) -> vec3<f32> {
  let own = planeAt(cell, kind);
  let t = triAt(xy);
  var g = vec2<f32>(0.0);
  var ws = 0.0;
  for (var k = 0; k < 3; k++) {
    let pl = planeAt(clampCell(t.c[k]), kind);
    if (abs(pl.c - own.c) > 1.2) { continue; }
    g += t.w[k] * pl.g;
    ws += t.w[k];
  }
  if (ws < 1e-3) { return normalize(vec3<f32>(-own.g, 1.0)); }
  return normalize(vec3<f32>(-g / ws, 1.0));
}

fn sunDir() -> vec3<f32> { return normalize(vec3<f32>(G.sunX, G.sunY, G.sunZ)); }

/**
 * Direct-light visibility 0..1. Tops blend the shadow test of the three
 * nearest columns of similar height (barycentric), so shadow edges are soft and
 * slide smoothly across the ground as the sun moves instead of stepping a
 * whole cell at a time. Side faces use their own column.
 */
fn sunLit(wpos: vec3<f32>, nrm: vec3<f32>, sc: vec2<i32>) -> f32 {
  let own = select(0.0, 1.0, wpos.z >= fields[colIdxI(sc)].x - 0.05);
  if (nrm.z < 0.5) { return own; }
  let t = triAt(wpos.xy);
  var acc = 0.0;
  var wsum = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    let j = colIdxI(q);
    // only neighbours at or a little below this height: a higher neighbour is
    // a step/wall beside us (its own top is no shadow test for this point),
    // and one far below is a different level
    let nz = f32(sfZ(surface[j]));
    // (slack: soft ground is drawn sloped up to ~1 cell from its whole-cell top)
    if (nz > wpos.z + 1.05 || nz < wpos.z - 1.5) { continue; }
    let wgt = t.w[k];
    acc += wgt * select(0.0, 1.0, wpos.z >= fields[j].x - 0.9);
    wsum += wgt;
  }
  if (wsum < 1e-3) { return own; }
  return smoothstep(0.1, 0.9, acc / wsum);
}

/** Direct + ambient light with heightfield shadow and storm cloud shade. */
fn lighting(wpos: vec3<f32>, nrm: vec3<f32>) -> vec3<f32> {
  let sun = sunDir();
  let ndl = max(dot(nrm, sun), 0.0);
  let sc = clampCell(cellAt(wpos.xy + nrm.xy * 0.5));
  // (with the field mesh, from the shadow map; without, the heightfield march)
  var lit: f32;
  if ((u32(CAM.eye.w) & 2u) != 0u) { lit = shadowLit(wpos, nrm); } else { lit = sunLit(wpos, nrm, sc); }
  // storm shade, and the light shadow of passing fair-weather clouds
  let cloud = max(cloudShade(wpos.xy), fairCloud(wpos.xy) * 0.22);
  // light comes from the day/night cycle (src/weather/daynight.ts)
  let sunCol = G.sunCol.rgb;
  let sky = G.sky.rgb;
  let day = 1.0 - G.sky.w;
  // storm shade: a dark, unmistakable shadow (it marks where lightning can
  // strike; DECISIONS round 5 asked for it darker again)
  let ambient = sky * (0.5 + 0.5 * nrm.z) * (1.0 - cloud * 0.42);
  // warm bounce light from the opposite side keeps shaded faces readable
  let fill = max(dot(nrm, normalize(vec3<f32>(-sun.x, -sun.y, 0.4))), 0.0) * vec3<f32>(0.42, 0.36, 0.29) * (1.0 - cloud * 0.42) * (0.15 + 0.85 * day);
  // lightning lights the whole scene, cold blue-white, every face
  let flash = G.misc.z * vec3<f32>(2.4, 2.6, 3.3) * (0.75 + 0.25 * nrm.z);
  // firelight: flickering orange from nearby flames (render fields .z)
  let glow = fields[colIdxI(sc)].z;
  let flick = 0.75 + 0.25 * vnoise(vec2<f32>(G.time * 9.0, wpos.x + wpos.y));
  let firelight = vec3<f32>(1.8, 0.75, 0.25) * glow * flick;
  return ambient + fill + flash + firelight + sunCol * ndl * lit * (1.0 - cloud * 0.9);
}

// the player's reach on a story level (game/reach.ts): 1 inside, 0.5 at
// its edge, 0 in the fog beyond; 1 everywhere elsewhere
@group(0) @binding(23) var reachTex: texture_2d<f32>;

fn reachAt(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  var r = 0.0;
  for (var k = 0; k < 3; k++) { r += t.w[k] * textureLoad(reachTex, clampCell(t.c[k]), 0).x; }
  return r;
}

fn haze(c: vec3<f32>, wpos: vec3<f32>) -> vec3<f32> {
  let dirty = vec3<f32>(0.62, 0.57, 0.48);
  let clean = vec3<f32>(0.62, 0.70, 0.78);
  // haze darkens with the sky at night
  let h = mix(clean, dirty, G.pollution) * mix(1.0, 0.15, G.sky.w);
  let lowFog = smoothstep(24.0, 0.0, wpos.z) * 0.06;
  var o = mix(c, toLinear(h), 0.03 + 0.1 * G.pollution + lowFog);
  // beyond the reach: a dim, colourless fog (the land not yet reached)
  let fog = 1.0 - smoothstep(0.05, 0.5, reachAt(wpos.xy));
  if (fog > 0.0) {
    let g = dot(o, vec3<f32>(0.3, 0.59, 0.11));
    o = mix(o, vec3<f32>(g) * 0.3 + toLinear(h) * 0.08, fog * 0.88);
  }
  return o;
}

/** Thin dark lines at cell boundaries so the grid reads (hex edges on tops; prism corners and whole heights on sides); fades out when cells are tiny. */
fn gridLines(wpos: vec3<f32>, nrm: vec3<f32>) -> f32 {
  let d = wpos.xy - cellPos(cellAt(wpos.xy - nrm.xy * 0.01));
  var e: f32;
  if (abs(nrm.z) > 0.5) {
    // distance to the hexagon's edge (inradius 0.5)
    e = 0.5 - max(abs(d.x), max(abs(dot(d, DIRV[2])), abs(dot(d, DIRV[4]))));
  } else {
    let along = dot(d, normalize(vec2<f32>(-nrm.y, nrm.x)));
    let fz = fract(wpos.z);
    e = min(HEX_R * 0.5 - abs(along), min(fz, 1.0 - fz));
  }
  let a = faceUV(wpos, nrm);
  let w = max(fwidth(a.x), fwidth(a.y));
  let line = 1.0 - smoothstep(0.0, w * 1.2, e);
  return line * 0.16 * smoothstep(0.45, 0.12, w);
}

/**
 * Sub-voxel canopy: march the view ray through a 4×4×4-per-cell grid inside
 * the (swayed) leaf box; occupancy is a hash thinning toward the edges of an
 * ellipsoid, so crowns are lumpy with gaps you can see through. Returns
 * vec4(hit position, axis of the face hit + 1) or w = 0 for a miss.
 */
fn canopyMarch(in: VOut) -> vec4<f32> {
  let res = 4.0;
  let species = (in.info.y >> 8u) & 15u;
  let dims = in.bsize * res;
  let local = (in.wpos - in.boff - in.bmin) * res;
  let dir = -toEye(in.wpos);
  var cell = floor(local - in.nrm * 0.01);
  let stepv = sign(dir);
  let tDelta = abs(1.0 / dir);
  var tMax = ((cell + max(stepv, vec3<f32>(0.0))) - local) / dir;
  var axis = select(select(1.0, 2.0, abs(in.nrm.y) > 0.5), 3.0, abs(in.nrm.z) > 0.5);
  let seed = vec3<i32>(floor(in.bmin * res));
  for (var i = 0; i < 40; i++) {
    if (any(cell < vec3<f32>(0.0)) || any(cell >= dims)) { break; }
    let c = (cell + 0.5) / dims - 0.5;
    var density: f32;
    if (species == 1u) {
      // conifer: a cone, wide at the bottom, a point at the top
      let zf = c.z + 0.5;
      let rr = length(c.xy) * 2.0;
      density = select(0.0, 0.92 - 0.3 * rr, rr < (1.0 - zf) * 0.95 + 0.08);
    } else {
      let d = length(c * vec3<f32>(2.0, 2.0, 2.2));
      density = 0.85 - 0.75 * d * d;
      if (species == 2u) { density -= 0.12; } // birch: airy
      // (round 51: the leaves fall in autumn, the crown thins to a few)
      density -= seasonBare() * 0.8;
    }
    if (randv(vec3<i32>(cell) + seed) < density) {
      let hit = in.bmin + in.boff + (cell + 0.5) / res;
      return vec4<f32>(hit, axis);
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) { cell.x += stepv.x; tMax.x += tDelta.x; axis = 1.0; }
    else if (tMax.y < tMax.z) { cell.y += stepv.y; tMax.y += tDelta.y; axis = 2.0; }
    else { cell.z += stepv.z; tMax.z += tDelta.z; axis = 3.0; }
  }
  return vec4<f32>(0.0);
}

// ---- soft borders between ground materials (round 26) ----------------------
// A top face doesn't switch material at the cell edge: each point takes the
// material that wins a vote over the three nearest columns (barycentric weights,
// like the rounded shorelines), nudged by world-space noise and by each
// material's relief (pebbly rubble pokes up through sand, sand fills the
// low spots of dirt). Both sides of an edge see the same columns and the same
// noise, so the border is seamless. Only ground materials at about the same
// height take part: cliffs, concrete and brick keep crisp edges.

/** What a column's top is made of and how high it is (the loose sheet's material where there's a fair depth of it). */
fn topLookAt(q: vec2<i32>) -> vec2<f32> {
  let s = surface[colIdxI(q)];
  let t = textureLoad(driftTex, q, 0); // (one load: driftAt + driftMatAt)
  if (t.x >= 0.07) {
    let m = u32(t.z + 0.5);
    return vec2<f32>(f32(select(m, MAT_DRIFT, m == 0u)), sfZ(s) + t.x);
  }
  return vec2<f32>(f32(sfMat(s)), sfZ(s));
}

/** Ground that blends with its neighbours: the soft materials and natural stone. */
fn blends(m: u32) -> bool { return MATS[m].look.x > 0.0 || m == MAT_STONE; }

/** A material's relief at p, centred on 0: who shows where two meet. */
fn relief(m: u32, p: vec2<f32>) -> f32 {
  if (m == 4u || m == 18u) { return 0.4 * (randv(vec3<i32>(vec2<i32>(floor(p * 4.0)), 41)) - 0.5); } // rubble, litter: pebbles, scraps
  if (m == 3u || m == MAT_DRIFT) { return 0.1 * (vnoise(p * 0.9 + 3.0) - 0.5); } // sand, dust: smooth, fills hollows
  if (m == MAT_STONE) { return 0.3 * (vnoise(p * 1.6 + 11.0) - 0.5); }
  return 0.2 * (vnoise(p * 2.3 + 5.0) - 0.5); // soil, ash, silt
}

/** Albedo a top of material m is drawn in (blown dust: a greyer silt). */
fn topAlbedo(m: u32) -> vec3<f32> {
  if (m == MAT_DRIFT) { return toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
  return toLinear(MATS[m].albedo.rgb);
}

struct EdgeLook { m: u32, v: f32 };

/**
 * The material shown at a point of a top face whose own material is `own`,
 * and the plant cover there smoothed the same way (so grass edges aren't
 * square either). Columns that don't take part count as `own`.
 */
fn edgeLook(p: vec3<f32>, own: u32, ownV: f32) -> EdgeLook {
  // (render-fields marks the corners where anything differs: elsewhere, one
  // texture read and done)
  // (a point lies in the triangles around its own cell: unless that cell
  // differs from a neighbour, there is nothing to vote on)
  let own0 = clampCell(cellAt(p.xy));
  if (textureLoad(cornerTex, vec2<i32>(own0.x * CT, own0.y), 0).w < 0.5) { return EdgeLook(own, ownV); }
  let t = triAt(p.xy);
  var ms: array<u32, 3>;
  var ws: array<f32, 3>;
  var vs = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    let tl = topLookAt(q);
    var m = u32(tl.x + 0.5);
    var v = veg[colIdxI(q)];
    if (!blends(m) || abs(tl.y - p.z) > 0.9) { m = own; v = ownV; }
    ms[k] = m;
    ws[k] = t.w[k];
    vs += ws[k] * v;
  }
  // (most of the ground: one material all round, nothing to vote on)
  if (ms[0] == own && ms[1] == own && ms[2] == own) { return EdgeLook(own, vs); }
  var best = own;
  var bestS = -1e9;
  for (var k = 0; k < 3; k++) {
    let m = ms[k];
    // each material once
    var seen = false;
    for (var j = 0; j < k; j++) { if (ms[j] == m) { seen = true; } }
    if (seen) { continue; }
    var w = 0.0;
    for (var j = 0; j < 3; j++) { if (ms[j] == m) { w += ws[j]; } }
    let s = w + 0.28 * (vnoise(wo(p.xy) * 1.1 + vec2<f32>(f32(m) * 7.3, f32(m) * 3.1)) - 0.5) + relief(m, wo(p.xy));
    if (s > bestS) { bestS = s; best = m; }
  }
  return EdgeLook(best, vs);
}

// ---- faceted rock (round 28, a test) -----------------------------------------
// Stone doesn't read as rock when every face is one flat plane: each face is
// split into Voronoi facets (about a cell across) that catch the light at
// their own small tilt, with dark cracks between them. Shading only — the
// silhouette is still the voxels.

/** Voronoi on a face: x = distance to the nearest seed, y = to the second, zw = the nearest seed's cell. */
fn voronoi2(p: vec2<f32>, salt: i32) -> vec4<f32> {
  let i0 = vec2<i32>(floor(p));
  var f1 = 9.0;
  var f2 = 9.0;
  var id = vec2<f32>(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = i0 + vec2<i32>(x, y);
      let s = vec2<f32>(c) + vec2<f32>(randv(vec3<i32>(c, salt)), randv(vec3<i32>(c, salt + 17)));
      let d = length(p - s);
      if (d < f1) { f2 = f1; f1 = d; id = vec2<f32>(c); } else if (d < f2) { f2 = d; }
    }
  }
  return vec4<f32>(f1, f2, id);
}

/** Rock facets: the tilted normal and how much to darken (cracks, facet tone). */
fn rockFacet(wpos: vec3<f32>, nrm: vec3<f32>, tiltK: f32) -> vec4<f32> {
  // the face's own 2D coordinates (tops: xy; sides: along the wall and up)
  var a = faceUV(wpos, nrm);
  var salt = 301;
  if (abs(nrm.z) <= 0.5) { a.y *= 1.3; salt = 333 + i32(round(atan2(nrm.y, nrm.x) * 3.0)); }
  let v = voronoi2(a * 1.25, salt);
  let fid = vec3<i32>(vec2<i32>(v.zw), salt);
  let tilt = vec3<f32>(randv(fid + vec3<i32>(0, 0, 5)) - 0.5, randv(fid + vec3<i32>(0, 0, 9)) - 0.5, randv(fid + vec3<i32>(0, 0, 13)) - 0.5) * 0.7 * tiltK;
  let n = normalize(nrm + tilt - nrm * dot(tilt, nrm));
  // a crack where two facets meet; each facet a slightly different tone
  let crack = 1.0 - smoothstep(0.02, 0.09, v.y - v.x);
  let tone = 0.9 + 0.2 * randv(fid + vec3<i32>(0, 0, 21));
  return vec4<f32>(n, tone * (1.0 - 0.45 * crack));
}

// ---- carved rock (round 29) ----------------------------------------------------
// Faceted shading alone left rock dead straight in profile. Stone is carved:
// its surface lies a noisy depth (0..ROCK_CARVE) inside the prism's exposed
// faces — the top (smoothed slope included) and the sides open to the air;
// faces against a neighbour aren't carved, so stone columns join without
// gaps. Each stone fragment marches the view ray into its box to that
// surface; a ray that leaves through an exposed face missed the rock and is
// discarded, so what's behind shows through and the silhouette is jagged.
// Rock is only ever removed, so everything behind is already drawn and no
// depth needs writing (the face's depth is at most ROCK_CARVE in front).
const ROCK_CARVE: f32 = 0.45;
/** px per cell below which rock isn't carved (too small to see) */
const ROCK_ZOOM: f32 = 10.0;

fn vnoise3(p: vec3<f32>) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(randv(i), randv(i + vec3<i32>(1, 0, 0)), u.x);
  let b = mix(randv(i + vec3<i32>(0, 1, 0)), randv(i + vec3<i32>(1, 1, 0)), u.x);
  let c = mix(randv(i + vec3<i32>(0, 0, 1)), randv(i + vec3<i32>(1, 0, 1)), u.x);
  let d = mix(randv(i + vec3<i32>(0, 1, 1)), randv(i + vec3<i32>(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

/** How deep the rock is cut away at p (0..ROCK_CARVE): lumpy, with sharper chips. */
fn rockCut(p: vec3<f32>) -> f32 {
  // (one octave: the facets add the fine detail; two cost too much)
  return ROCK_CARVE * smoothstep(0.2, 0.85, vnoise3((p + vec3<f32>(G.org.xy, 0.0)) * 1.1));
}

// nt: the top of the ground in each neighbour (NDIR order). A side is only
// open to the air above it: below, the neighbour's facing side isn't drawn
// (hidden behind this prism), so a ray leaving there would show the
// background through the rock (round 30: holes between stone columns)
struct RockBox { c: vec2<f32>, z0: f32, z1: f32, open: u32, top: bool, nt: Dirs, h: array<f32, 6>, hc: f32 };

fn rockBox(in: VOut, flags: u32) -> RockBox {
  var rb: RockBox;
  rb.c = in.bmin.xy + 0.5;
  let cell = cellAt(rb.c);
  rb.z0 = in.bmin.z;
  rb.z1 = in.bmin.z + in.bsize.z;
  // exposed: the top if it's the column's top and nothing sits on it; the sides not hidden
  rb.open = (~in.sides) & 63u;
  rb.top = (flags & 1u) != 0u && (flags & 64u) == 0u;
  // the top as drawn: the fan through the corner heights
  rb.hc = 0.0;
  for (var j = 0u; j < 6u; j++) {
    rb.h[j] = cornerOr(cell, j, rb.z1);
    rb.hc += rb.h[j] / 6.0;
  }
  // a rise the smoothing draws as a slope isn't a rock face: only sheer
  // rises are carved (carving the slopes opened seams between the tops)
  let sm = MATS[MAT_STONE].look.x;
  for (var k = 0u; k < NDIR; k++) {
    // (the map's edge is no rock face: on the hex grid it zigzags, and rays
    // left a prism through the notches into nothing)
    let q = nbr(cell, k);
    rb.nt[k] = select(1e9, groundTopR(q), inMap(q));
    if (rb.z1 - rb.nt[k] <= sm + 0.01) { rb.nt[k] = 1e9; }
  }
  return rb;
}

/** The drawn top's height at p (the triangle of the fan p is over). */
fn rockTopZ(rb: RockBox, p: vec2<f32>) -> f32 {
  let d = p - rb.c;
  let t = u32(floor((atan2(d.y, d.x) - 0.5235988) / 1.0471976) + 6.0) % 6u;
  let a = cornerOffset(t);
  let b = cornerOffset(t + 1u);
  // d = u a + v b
  let det = a.x * b.y - a.y * b.x;
  let u = (d.x * b.y - d.y * b.x) / det;
  let v = (a.x * d.y - a.y * d.x) / det;
  return rb.hc + u * (rb.h[t] - rb.hc) + v * (rb.h[(t + 1u) % 6u] - rb.hc);
}

/** Inside the carved rock by this much at p (< 0: in the air cut away). */
fn rockIn(rb: RockBox, p: vec3<f32>) -> f32 {
  var d = 1e3;
  if (rb.top) { d = min(d, rockTopZ(rb, p.xy) - p.z); }
  let r = p.xy - rb.c;
  for (var k = 0u; k < NDIR; k++) {
    if (((rb.open >> k) & 1u) != 0u && p.z > rb.nt[k]) { d = min(d, 0.5 - dot(r, DIRV[k])); }
  }
  return d - rockCut(p);
}

/** March into a stone prism from the face point: vec4(hit, 1) or w = 0 (missed: the air). */
fn rockMarch(in: VOut, flags: u32) -> vec4<f32> {
  let rb = rockBox(in, flags);
  let dir = -normalize(toEye(in.wpos));
  var t = 0.0;
  for (var i = 0; i < 20; i++) {
    let p = in.wpos + dir * t;
    // left the prism: into the air through an open side, or into solid stuff
    // (a neighbour, the ground) through a closed one (an open side only
    // leads into the air above the neighbour's ground)
    let r = p.xy - rb.c;
    for (var k = 0u; k < NDIR; k++) {
      if (dot(r, DIRV[k]) > 0.5) {
        if (((rb.open >> k) & 1u) != 0u && p.z > rb.nt[k]) { return vec4<f32>(0.0); }
        return vec4<f32>(p, 2.0);
      }
    }
    if (p.z < rb.z0) { return vec4<f32>(p, 2.0); }
    let s = rockIn(rb, p);
    if (s >= 0.0) { return vec4<f32>(p, select(1.0, 2.0, i > 0)); }
    t += max(-s * 0.8, 0.02);
  }
  return vec4<f32>(in.wpos + dir * t, 2.0);
}

/** The carved surface's normal at p (outward). */
fn rockNormal(in: VOut, flags: u32, p: vec3<f32>) -> vec3<f32> {
  let rb = rockBox(in, flags);
  let e = 0.04;
  let s0 = rockIn(rb, p);
  let g = vec3<f32>(rockIn(rb, p + vec3<f32>(e, 0.0, 0.0)) - s0, rockIn(rb, p + vec3<f32>(0.0, e, 0.0)) - s0, rockIn(rb, p + vec3<f32>(0.0, 0.0, e)) - s0);
  // (inside grows inward: the outward normal is against the gradient)
  let l = length(g);
  return select(in.nrm, -g / l, l > 1e-5);
}

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
  o.pick = vec2<u32>(ci + 1u, in.info.x | (u32(max(in.wpos.z, 0.0)) << 8u) | (in.info.y << 16u));
  return o;
}

/** The water's flow at column j: with the field mesh renderfields stores
 *  its direction (x, w); without, only its speed (x here). */
fn flowOf(j: u32) -> vec2<f32> {
  if ((u32(CAM.eye.w) & 2u) != 0u) { return vec2<f32>(fields[j].x, fields[j].w); }
  return vec2<f32>(fields[j].w, 0.0);
}

/**
 * Streaks carried along by the flow v (column flux, blended) at p, 0..1:
 * noise stretched along the flow and moved down it, in two phases half a
 * cycle apart that take turns (a flow map: each phase is pulled back before
 * it smears). The pace follows the water's speed, the flux over its depth.
 */
fn flowStreaks(p: vec2<f32>, v: vec2<f32>, d: f32) -> f32 {
  let sp = length(v);
  if (sp < 1e-4) { return 0.0; }
  let dir = v / sp;
  // cells a cycle: speed (flux / depth), held to a believable range
  let pace = min(sp / max(d, 0.06) * 6.0, 5.0);
  var s = 0.0;
  for (var k = 0; k < 2; k++) {
    let ph = fract(G.time * 0.5 + f32(k) * 0.5);
    let q = p - dir * pace * ph;
    let u = vec2<f32>(dot(q, dir), dot(q, vec2<f32>(-dir.y, dir.x)));
    s += (1.0 - abs(2.0 * ph - 1.0)) * vnoise(u * vec2<f32>(0.6, 1.9) + f32(k) * 17.0);
  }
  return s;
}

/**
 * Water's surface normal under the wind: a few travelling waves round the
 * local wind's direction (crests across it, longer ones faster), their
 * phases broken by noise, plus the catspaws of gusts (noise advected
 * downwind). Calm air or shallow water lies flatter (rough).
 */
fn windWaves(p: vec2<f32>, z: f32, rough: f32) -> vec3<f32> {
  let wv = windAt(vec3<f32>(p, z + 0.5));
  let lw = length(wv);
  let pw = vec2<f32>(G.windX, G.windY) + vec2<f32>(1e-4, 0.0);
  let wd = select(normalize(pw), wv / max(lw, 1e-4), lw > 0.05);
  let wp = vec2<f32>(-wd.y, wd.x);
  let t = G.time;
  // (in the wind's frame: a along it, c across)
  let a = dot(p, wd);
  let c = dot(p, wp);
  var g = vec2<f32>(0.0);
  let ang = vec3<f32>(-0.22, 0.0, 0.25);
  let kk = vec3<f32>(1.3, 2.3, 3.9);
  let amp = vec3<f32>(1.0, 0.6, 0.35);
  for (var i = 0; i < 3; i++) {
    let dir = vec2<f32>(cos(ang[i]), sin(ang[i]));
    // crests broken into lengths along themselves, set in patches
    let warp = vnoise(vec2<f32>(a * 0.25, c * 0.5) + f32(i) * 13.0) * 2.5;
    let gang = smoothstep(0.25, 0.75, vnoise(vec2<f32>(a * 0.3 - t * 0.4, c * 0.6) + f32(i) * 29.0));
    let ph = (a * dir.x + c * dir.y) * kk[i] - t * sqrt(kk[i]) * 2.2 + warp;
    g += (wd * dir.x + wp * dir.y) * kk[i] * amp[i] * gang * cos(ph);
  }
  let rp = windDrift(p) * 1.7;
  let cat = vec2<f32>(
    vnoise(rp + vec2<f32>(t * 0.7, 0.0)) - vnoise(rp + vec2<f32>(0.0, t * 0.6) + 31.0),
    vnoise(rp + vec2<f32>(0.0, -t * 0.8) + 7.0) - vnoise(rp + vec2<f32>(-t * 0.5, 0.0) + 19.0));
  return normalize(vec3<f32>(-g * 0.11 * rough + cat * rough * 0.15, 1.4));
}

@fragment
fn fsWater(in: VOut) -> FOut {
  let cell = fragCell(in.wpos, in.nrm);
  let ci = colIdxI(cell);
  // smooth depth: rounded shorelines (round 12)
  let d = sheetDepth(in.wpos.xy, 1u);
  // derivatives must be taken in uniform control flow, before any branch
  let gl = gridLines(in.wpos, in.nrm);
  // the depth's slope across the map (it's linear over each triangle of
  // the centres): which way the shore is, and how far
  let ex = dpdx(in.wpos.xy);
  let ey = dpdy(in.wpos.xy);
  let ddx = dpdx(d);
  let ddy = dpdy(d);
  if (in.info.x == MAT_OIL) { return shadeOil(in, ci); }
  if (MATS[in.info.x].look.y > 0.0) { return shadeGlass(in, ci); }
  if (in.nrm.z > 0.5 && d < 0.02) { discard; }
  let det = ex.x * ey.y - ex.y * ey.x;
  let dg = select(vec2<f32>(0.0), vec2<f32>(ddx * ey.y - ddy * ex.y, ddy * ex.x - ddx * ey.x) / det, abs(det) > 1e-9);
  let fv = flowOf(ci);
  let flow = length(fv);
  let deep = 1.0 - exp(-d * 0.45);
  var c = mix(vec3<f32>(0.30, 0.45, 0.44), vec3<f32>(0.07, 0.19, 0.25), deep);
  let conc = contam[ci].y / max(d, 0.05);
  c = mix(c, vec3<f32>(0.40, 0.37, 0.11), smoothstep(0.03, 0.8, conc) * 0.85);
  // sludge: thick, opaque, sickly olive-brown with a scummy mottle (an
  // obvious thing to wash away); fades back to water as it is diluted
  let sludge = smoothstep(0.9, 2.2, conc);
  let scum = smoothstep(0.55, 0.75, vnoise(wo(in.wpos.xy) * 1.3 + vec2<f32>(G.time * 0.03, 0.0)));
  let murk = vnoise(wo(in.wpos.xy) * 0.4 + 9.0);
  c = mix(c, mix(mix(vec3<f32>(0.13, 0.11, 0.06), vec3<f32>(0.2, 0.16, 0.08), murk), vec3<f32>(0.44, 0.42, 0.1), scum * 0.8), sludge);
  var col = toLinear(c) * lighting(in.wpos, in.nrm);
  var alpha = mix(mix(0.5, 0.9, deep), 0.97, sludge) * smoothstep(WATER_MIN_R, 0.08, d);

  if (in.nrm.z > 0.5) {
    // ripples + sun glint
    let t = G.time;
    // ripples ride the wind: the pattern is advected downwind and roughens
    // with the local wind, so gusts and drags send catspaws across the water
    let wv = windAt(vec3<f32>(in.wpos.xy, in.wpos.z + 0.5));
    let lw = length(wv);
    // (shallow puddles lie still: the ripples fade out below ~0.7 deep)
    let rough = (0.5 + clamp(lw / 5.0, 0.0, 2.0)) * smoothstep(0.1, 0.7, d);
    // (the waves' crests lie across the wind: round 41)
    let nn = windWaves(in.wpos.xy, in.wpos.z, rough);
    // Stylised for the fixed view: ripple slopes facing the sun brighten, and the
    // half-vector is biased toward vertical so glints appear on ordinary
    // ripples instead of only at one viewing angle.
    let sunL = sunDir();
    let shade = 1.0 + dot(nn.xy, normalize(sunL.xy)) * 0.45;
    let h = normalize(normalize(sunL + toEye(in.wpos)) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(dot(nn, h), 0.0), 160.0) * (1.0 - cloudShade(in.wpos.xy)) * (1.0 - sludge * 0.8);
    col *= mix(shade, 1.0, sludge * 0.7);
    col += G.sunCol.rgb * (1.0 / 2.4) * spec * 0.7;
    // slow bubbles rising through the sludge
    let bub = vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 2.5)), i32(floor(t * 0.8 + randv(vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 2.5)), 3)) * 7.0)));
    let bf = fract(wo(in.wpos.xy) * 2.5) - 0.5;
    col += vec3<f32>(0.05, 0.05, 0.01) * sludge * step(0.93, randv(bub)) * step(length(bf), 0.32) * (1.0 - 0.8 * G.sky.w);
    // foam where flowing fast
    // (on the field mesh smooth, in streaks down the flow; on the prisms in cells)
    let meshOn = (u32(CAM.eye.w) & 2u) != 0u;
    let sub = vec3<i32>(floor(vec3<f32>(wo(in.wpos.xy) * 4.0, t * 6.0)));
    var fleck = step(0.72, randv(sub));
    if (meshOn) { fleck = smoothstep(0.62, 0.85, flowStreaks(wo(in.wpos.xy) * 1.7, fv, d)); }
    let foam = smoothstep(0.03, 0.25, flow) * fleck;
    col = mix(col, vec3<f32>(0.85, 0.85, 0.8), foam * 0.6);
    alpha = max(alpha, foam * 0.7);
    // a fall (round 69: the atlas's rivers over cliffs): water steep down a face is white water,
    // streaks of it running down
    let steepW = 1.0 - smoothstep(0.25, 0.7, in.nrm.z);
    if (steepW > 0.0) {
      let lane = randv(vec3<i32>(vec2<i32>(floor(wo(in.wpos.xy) * 1.5)), 9));
      let streak = smoothstep(0.3, 0.85, fract(in.wpos.z * 0.22 + t * 1.6 + lane)) * (0.6 + 0.4 * vnoise(wo(in.wpos.xy) * 3.0 + vec2<f32>(0.0, in.wpos.z * 0.5 + t * 4.0)));
      col = mix(col, vec3<f32>(0.88, 0.9, 0.9) * (1.0 - 0.7 * G.sky.w), steepW * (0.5 + 0.45 * streak));
      alpha = max(alpha, steepW * (0.72 + 0.25 * streak));
    }
    // the flow's streaks (with the field mesh, which knows its direction)
    if (meshOn && flow > 0.005) {
      let st = flowStreaks(in.wpos.xy, fv, d) * smoothstep(0.005, 0.06, flow) * (1.0 - sludge);
      col += vec3<f32>(0.10, 0.12, 0.12) * smoothstep(0.55, 0.9, st) * (1.0 - 0.7 * G.sky.w);
    }
    // the shore: swell lines running in to the shallows, foam where they
    // break, more where the wind blows on shore and the stronger it is
    let gl2 = length(dg);
    let toShore = -dg / max(gl2, 1e-5);
    let dist = d / max(gl2, 0.03);
    let onshore = clamp(dot(wv / max(lw, 1e-3), toShore), 0.0, 1.0) * clamp(lw / 4.0, 0.0, 1.0);
    let alongN = vnoise(wo(in.wpos.xy) * 0.6 + 5.0);
    // (dist is only piecewise smooth, over the centres' triangles: broad
    // soft crests, so the joins don't show)
    let crest = sin(min(dist, 3.0) * 1.8 + t * (1.6 + onshore) + alongN * 5.0);
    let near = smoothstep(2.6, 0.6, dist) * smoothstep(0.012, 0.03, d);
    // (a running stream has no swell: its banks are all near)
    let swell = near * smoothstep(0.55, 0.95, crest) * (0.2 + 0.6 * onshore) * (1.0 - smoothstep(0.01, 0.06, flow));
    let froth = smoothstep(0.3, 0.65, vnoise(wo(in.wpos.xy) * 2.2 + vec2<f32>(t * 0.35, -t * 0.2)));
    let sf = swell * (1.0 - sludge * 0.7) * froth;
    col = mix(col, vec3<f32>(0.8, 0.82, 0.8) * (1.0 - 0.75 * G.sky.w), sf * 0.65);
    alpha = max(alpha, sf * 0.8);
    // rain rings
    let rain = rainAt(in.wpos.xy);
    if (meshOn) {
      // (on the field mesh: rings spreading from each drop, a third of a
      // cell apart, each cell's drops at its own times)
      let rc = vec2<i32>(floor(wo(in.wpos.xy) * 3.0));
      let rf = fract(wo(in.wpos.xy) * 3.0) - 0.5;
      let rt = t * 2.5 + randv(vec3<i32>(rc, 5));
      let rr = fract(rt) * 0.5;
      let ring = smoothstep(0.07, 0.0, abs(length(rf) - rr)) * (1.0 - rr * 2.0);
      col += vec3<f32>(0.3) * (1.0 - 0.8 * G.sky.w) * ring * step(1.0 - 0.25 * min(rain, 3.0), randv(vec3<i32>(rc, i32(floor(rt)))));
    } else {
      let rsub = vec3<i32>(floor(vec3<f32>(wo(in.wpos.xy) * 3.0, t * 10.0)));
      col += vec3<f32>(0.25) * (1.0 - 0.8 * G.sky.w) * step(1.0 - 0.06 * rain, randv(rsub));
    }
  }
  // (round 50) in the freezing cold a skin of ice over it: frosted, pale,
  // still, cracked — climate.wgsl freezes the water itself from its bed up
  let frost = smoothstep(-0.5, -3.0, airTempAt(in.wpos.z)) * select(0.6, 1.0, in.nrm.z > 0.5);
  if (frost > 0.0) {
    let cr = vnoise(wo(in.wpos.xy) * 1.7 + 3.0);
    let crack = smoothstep(0.03, 0.0, abs(cr - 0.5)) * 0.6;
    let frosted = toLinear(vec3<f32>(0.78, 0.86, 0.9) * (0.88 + 0.12 * vnoise(wo(in.wpos.xy) * 4.0))) * lighting(in.wpos, in.nrm);
    col = mix(col, frosted * (1.0 - crack * 0.35), frost * 0.85);
    alpha = mix(alpha, 0.92, frost);
  }
  col *= 1.0 - gl * 0.3;
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = vec2<u32>(ci + 1u, in.info.x | (u32(max(in.wpos.z, 0.0)) << 8u) | (in.info.y << 16u));
  return o;
}

const WATER_MIN_R: f32 = 0.012;


/**
 * See-through solids (round 50): ice and crystal, drawn blended with the
 * liquids. Each face is broken into tilted triangular facets (a coarse
 * lattice across it, a random tilt each), so the light catches them one by
 * one: a sharp sun glint, a rim brighter at grazing angles, darker toward
 * the base (the depth of the body seen through), bright facet edges.
 * Crystal glows faintly of its own, more at night, each column a shade of
 * violet, cyan or rose.
 */
fn shadeGlass(in: VOut, ci: u32) -> FOut {
  let m = in.info.x;
  let crystal = m == MAT_CRYSTAL;
  var alb = toLinear(MATS[m].albedo.rgb);
  let hc = randv(vec3<i32>(i32(ci), 11, 3));
  if (crystal) { alb = mix(mix(alb, toLinear(vec3<f32>(0.45, 0.85, 0.92)), smoothstep(0.4, 0.7, hc)), toLinear(vec3<f32>(0.95, 0.55, 0.75)), smoothstep(0.75, 0.95, hc)); }
  let n0 = normalize(in.nrm);
  let t = normalize(cross(n0, select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(n0.z) > 0.9)));
  let bt = cross(n0, t);
  let fp = in.wpos * select(1.4, 2.2, crystal);
  let uv = vec2<f32>(dot(fp, t), dot(fp, bt));
  // (a triangle lattice: skewed square cells, each cut in two)
  let sk = vec2<f32>(uv.x + uv.y * 0.57735, uv.y * 1.1547);
  let cid = vec2<i32>(floor(sk));
  let fr = fract(sk);
  let tri = select(0, 1, fr.x + fr.y > 1.0);
  let h1 = randv(vec3<i32>(cid, tri + i32(ci % 97u) * 2));
  let h2 = randv(vec3<i32>(cid + vec2<i32>(17, 5), tri));
  let tilt = (vec2<f32>(h1, h2) - 0.5) * select(0.5, 0.9, crystal);
  let n = normalize(n0 + t * tilt.x + bt * tilt.y);
  let V = normalize(toEye(in.wpos));
  let fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
  let L = sunDir();
  let hv = normalize(L + V);
  let spec = pow(max(dot(n, hv), 0.0), 80.0) * (1.0 - cloudShade(in.wpos.xy));
  let depth = clamp((in.zr.y - in.wpos.z) / max(in.zr.y - in.zr.x, 0.3), 0.0, 1.0);
  var col = alb * lighting(in.wpos, n) * mix(1.0, 0.6, depth) * (0.8 + 0.4 * h1);
  col += alb * MATS[m].albedo.w * (0.7 + 0.3 * sin(G.time * 1.3 + h1 * 6.28)) * (0.5 + 0.8 * G.sky.w);
  col += G.sunCol.rgb * (1.0 / 2.4) * spec * 1.4;
  col += vec3<f32>(0.75, 0.85, 1.0) * fres * 0.3 * (1.0 - 0.6 * G.sky.w);
  // (the facets' edges catch the light)
  let edge = min(min(fr.x, fr.y), abs(1.0 - fr.x - fr.y));
  col += alb * smoothstep(0.05, 0.0, edge) * 0.3;
  let alpha = clamp(select(0.4, 0.55, crystal) + fres * 0.35 + spec * 0.5, 0.0, 0.95);
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = vec2<u32>(ci + 1u, m | (u32(max(in.wpos.z, 0.0)) << 8u) | (in.info.y << 16u));
  return o;
}

/** Oil: near-black, glossy, with a slow thin-film rainbow sheen on top. */
fn shadeOil(in: VOut, ci: u32) -> FOut {
  let d = in.zr.y - in.zr.x;
  var c = toLinear(vec3<f32>(0.08, 0.065, 0.05));
  var col = c * lighting(in.wpos, in.nrm);
  if (in.nrm.z > 0.5) {
    let n = vnoise(wo(in.wpos.xy) * 0.45 + vec2<f32>(G.time * 0.04, -G.time * 0.03)) * 2.0 + vnoise(wo(in.wpos.xy) * 1.3) * 0.6;
    // cosine palette ≈ thin-film interference colours
    let film = 0.5 + 0.5 * cos(6.2831 * (vec3<f32>(n) + vec3<f32>(0.0, 0.33, 0.67)));
    col += toLinear(film) * 0.035 * (1.0 - cloudShade(in.wpos.xy));
    let h = normalize(normalize(sunDir() + toEye(in.wpos)) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(h.z, 0.0), 30.0) * 0.25;
    col += G.sunCol.rgb * (1.0 / 2.4) * spec;
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), clamp(0.55 + d * 3.0, 0.55, 0.96));
  o.pick = vec2<u32>(ci + 1u, in.info.x | (u32(max(in.wpos.z, 0.0)) << 8u) | (in.info.y << 16u));
  return o;
}

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
// triangle: lo-fi on purpose.
@vertex
fn vsSkin(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let a = instances[vi * 2u];
  let nb = instances[vi * 2u + 1u];
  let wp = bitcast<vec3<f32>>(a.xyz);
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  o.nrm = bitcast<vec3<f32>>(nb.xyz);
  o.info = vec2<u32>(a.w, 0u);
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

@fragment
fn fsBody(in: VOut) -> FOut {
  let word = in.info.x;
  let mat = word & 0xffu;
  // a little per-voxel variation so a tumbling slab doesn't read as one block
  // (a physics voxel, bit 30, carries its own speckle: it bends and moves)
  let physV = ((word >> 30u) & 1u) != 0u;
  let r = select(randv(vec3<i32>(floor(in.bmin * 3.0))), f32((word >> 8u) & 0xffu) / 255.0, physV);
  var alb = toLinear(MATS[mat].albedo.rgb) * (0.88 + 0.24 * r);
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
  o.pick = vec2<u32>(colIdxI(bc) + 1u, mat | (u32(max(in.wpos.z, 0.0)) << 8u) | (flag << 16u));
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
