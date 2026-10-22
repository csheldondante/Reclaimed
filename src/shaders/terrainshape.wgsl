// ---- terrain shape: smooth soft surfaces (round 10, BACKLOG A15; hex: GRIDS) --
// Column heights are whole cells. Soft materials (MATS[m].look.x > 0: soil,
// sand, ash, litter, rubble) are *drawn* sloped: every hex corner gets one
// height shared by the three columns around it — a weighted mean of their
// tops and the three beyond — when all three are soft and their tops differ
// by no more than the smallest of their thresholds; otherwise each column
// keeps its own height there (a sheer step, like stone). Because a smoothed
// corner has one value for everyone touching it, the sloped surface stays
// watertight; side faces still cover the steps. The corner heights are
// computed once per render-fields pass (computeCornerZ) into `cornerTex`
// (binding 14); the draw passes only look them up (cornerZ).
//
// Hex corners: corner j of a cell lies at 30° + 60°·j from its centre, HEX_R
// out. Each corner touches three cells, and each cell owns two of them —
// slot 0 at 30° (itself, E, NE) and slot 1 at 90° (itself, NE, NW). The
// corner texture holds CT texels per cell: (CT·x + s, y) are its two corners
// (ground, water, drift, and in slot 0 whether its look differs from a
// neighbour's); then its tops' planes, fitted through all six corners —
// CT·x + 2 the centre heights (ground, water, drift), + 3 the ground and
// water gradients, + 4 the drift gradient — so a prism's top vertices read
// three texels instead of all six corners each (render.wgsl).
@group(0) @binding(14) var cornerTex: texture_2d<f32>;

const HEX_R: f32 = 0.57735027;
const CT: i32 = 5;

/** Offset of corner j from its cell's centre (world units). */
fn cornerOffset(j: u32) -> vec2<f32> {
  let a = radians(30.0 + 60.0 * f32(j % 6u));
  return vec2<f32>(cos(a), sin(a)) * HEX_R;
}

/** Corner j of cell p: (owner cell, its slot) — x < 0 when the owner is off the map. */
fn cornerOwner(p: vec2<i32>, j: u32) -> vec3<i32> {
  var o = p;
  var s = 0;
  switch (j % 6u) {
    case 0u: { o = p; s = 0; }
    case 1u: { o = p; s = 1; }
    case 2u: { o = nbr(p, 1u); s = 0; }  // W's 30°
    case 3u: { o = nbr(p, 3u); s = 1; }  // SW's 90°
    case 4u: { o = nbr(p, 3u); s = 0; }  // SW's 30°
    default: { o = nbr(p, 5u); s = 1; }  // SE's 90°
  }
  if (!inMap(o)) { return vec3<i32>(-1, 0, 0); }
  return vec3<i32>(o, s);
}

/** The texel holding corner j of cell p (x < 0 when its owner is off the map). */
fn cornerTexel(p: vec2<i32>, j: u32) -> vec2<i32> {
  let o = cornerOwner(p, j);
  if (o.x < 0) { return vec2<i32>(-1, 0); }
  return vec2<i32>(o.x * CT + o.z, o.y);
}

/** A top's plane: its centre height and gradient. */
struct Plane { c: f32, g: vec2<f32> };
/** The plane of p's top of a kind: 0 ground (soft), 1 water, 2 drift. */
fn planeAt(p: vec2<i32>, kind: u32) -> Plane {
  let c = textureLoad(cornerTex, vec2<i32>(p.x * CT + 2, p.y), 0);
  if (kind == 2u) { return Plane(c.z, textureLoad(cornerTex, vec2<i32>(p.x * CT + 4, p.y), 0).xy); }
  let g = textureLoad(cornerTex, vec2<i32>(p.x * CT + 3, p.y), 0);
  if (kind == 1u) { return Plane(c.y, g.zw); }
  return Plane(c.x, g.xy);
}

/** The three cells around owned corner `slot` of p, then the three beyond it. */
fn cornerRing(p: vec2<i32>, slot: u32) -> array<vec2<i32>, 6> {
  if (slot == 0u) {
    let e = nbr(p, 0u);
    return array<vec2<i32>, 6>(p, e, nbr(p, 2u), nbr(p, 5u), nbr(p, 4u), nbr(e, 2u));
  }
  let nw = nbr(p, 4u);
  return array<vec2<i32>, 6>(p, nbr(p, 2u), nw, nbr(p, 0u), nbr(p, 1u), nbr(nw, 2u));
}

/** The four corner values (ground, water, drift, mixed) stored for corner j of p. */
fn cornerVals(p: vec2<i32>, j: u32) -> vec4<f32> {
  let t = cornerTexel(p, j);
  if (t.x < 0) { return vec4<f32>(-1.0, -1.0, -1.0, 0.0); }
  return textureLoad(cornerTex, t, 0);
}

/** Height of corner j of p, or -1 if it isn't smoothed. */
fn cornerZ(p: vec2<i32>, j: u32) -> f32 { return cornerVals(p, j).x; }
/** Drift surface height at corner j of p (round 11), or -1. */
fn driftCornerAt(p: vec2<i32>, j: u32) -> f32 { return cornerVals(p, j).z; }
/** Water surface height at corner j of p (smooth water, round 11), or -1. */
fn waterCornerAt(p: vec2<i32>, j: u32) -> f32 { return cornerVals(p, j).y; }

/** Drawn height at corner j of a column whose own top is z. */
fn cornerOr(p: vec2<i32>, j: u32, z: f32) -> f32 {
  let c = cornerZ(p, j);
  return select(c, z, c < 0.0);
}

/** Drawn ground height at the centre of cell p (the mean of its six corners). */
fn groundCentreZ(p: vec2<i32>, z: f32) -> f32 {
  var s = 0.0;
  for (var j = 0u; j < 6u; j++) { s += cornerOr(p, j, z); }
  return s / 6.0;
}

/**
 * Height of owned corner `slot` of p, or -1 if it isn't smoothed. The three
 * columns touching it must all be soft and within the smallest threshold of
 * each other; the height is then a weighted mean of them (weight 2) and of
 * the three beyond (weight 1, only where soft and within the threshold), so
 * slopes spread across terraces instead of just bevelling their edges.
 */
fn computeCornerZ(p: vec2<i32>, slot: u32) -> f32 {
  let ring = cornerRing(p, slot);
  var lo = 1e9;
  var hi = -1e9;
  var thr = 1e9;
  var inner = 0.0;
  var n = 0.0;
  for (var k = 0u; k < 3u; k++) {
    let q = ring[k];
    if (!inMap(q)) { continue; }
    let s = surface[colIdxI(q)];
    let sm = MATS[sfMat(s)].look.x;
    if (sm <= 0.0) { return -1.0; }
    let z = f32(sfZ(s));
    lo = min(lo, z);
    hi = max(hi, z);
    thr = min(thr, sm);
    inner += z;
    n += 1.0;
  }
  if (n < 1.0 || hi - lo > thr) { return -1.0; }
  let mid = inner / n;
  var sum = inner * 2.0;
  var wsum = n * 2.0;
  for (var k = 3u; k < 6u; k++) {
    let q = ring[k];
    if (!inMap(q)) { continue; }
    let s = surface[colIdxI(q)];
    let z = f32(sfZ(s));
    if (MATS[sfMat(s)].look.x <= 0.0 || abs(z - mid) > thr) { continue; }
    sum += z;
    wsum += 1.0;
  }
  // keep it within the three touching columns' range so nothing pokes out
  return clamp(sum / wsum, lo, hi);
}

// ---- hex sides (needs `surface` and driftTex: every module that takes this declares them)

/** Drawn height of q's ground with its loose layer on (0 off the map). */
fn groundTopR(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  return sfZ(surface[colIdxI(q)]) + textureLoad(driftTex, q, 0).x;
}

/**
 * Does a drift sheet's edge at corner j of p stand clear of the ground of the
 * neighbour n beside it? Its corner was left at its prism (a step), or n has
 * no sheet of its own (sheets share their corners) and n's top is drawn lower there.
 */
fn sheetGap(p: vec2<i32>, j: u32, n: vec2<i32>) -> bool {
  let d = driftCornerAt(p, j);
  // (the map's edge always shows its side)
  if (d < 0.0 || !inMap(n)) { return true; }
  if (textureLoad(driftTex, n, 0).x > 0.12) { return false; }
  return d > cornerOr(p, j, groundTopR(n)) + 0.02;
}

/** Hex side m (facing 60 deg * m, counter-clockwise from +x) -> its neighbour direction (NDIR order). */
const SIDE_DIR = array<u32, 6>(0u, 2u, 4u, 1u, 3u, 5u);
/** NDIR direction k -> the hex side m facing it (SIDE_DIR inverted). */
const DIR_SIDE = array<u32, 6>(0u, 3u, 1u, 4u, 2u, 5u);

/** The sides of p's drift sheet that don't show (bit k: NDIR order): its edge meets the ground beside it on both corners. */
fn sheetHidden(p: vec2<i32>) -> u32 {
  var f = 0u;
  for (var k = 0u; k < NDIR; k++) {
    let m = DIR_SIDE[k];
    let nb = nbr(p, k);
    if (!sheetGap(p, (m + 5u) % 6u, nb) && !sheetGap(p, m, nb)) { f |= 1u << k; }
  }
  return f;
}
