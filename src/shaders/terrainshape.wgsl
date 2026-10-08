// ---- terrain shape: smooth soft surfaces (round 10, BACKLOG A15) ------------
// Column heights are whole cells. Soft materials (MATS[m].look.x > 0: soil,
// sand, ash, litter, rubble) are *drawn* sloped: every grid corner gets one
// height shared by the four columns around it — their mean top — when all
// four are soft and their tops differ by no more than the smallest of their
// thresholds; otherwise each column keeps its own height there (a sheer
// step, like stone). Because a smoothed corner has one value for everyone
// touching it, the sloped surface stays watertight; side faces still cover
// the steps. The corner heights are computed once per render-fields pass
// (computeCornerZ, which needs `surface` and MATS) into `cornerTex`
// (binding 14, one texel per grid point at a column's low corner); the
// draw passes only look them up (cornerZ). Per-vertex evaluation doubled the
// draw cost.
@group(0) @binding(14) var cornerTex: texture_2d<f32>;

/** Height of the corner at grid point v (texture lookup), or -1 if it isn't smoothed. */
fn cornerZ(v: vec2<i32>) -> f32 {
  if (!inMap(v)) { return -1.0; }
  return textureLoad(cornerTex, v, 0).x;
}

/**
 * Height of the corner at grid point v, or -1 if it isn't smoothed. The four
 * columns touching v must all be soft and within the smallest threshold of
 * each other; the height is then a tent-weighted mean over the 4×4 columns
 * around v (the outer ring only where it is soft and within the threshold),
 * so slopes spread across terraces instead of just bevelling their edges.
 */
fn computeCornerZ(v: vec2<i32>) -> f32 {
  var lo = 1e9;
  var hi = -1e9;
  var thr = 1e9;
  var inner = 0.0;
  var n = 0.0;
  for (var k = 0; k < 4; k++) {
    let q = v - vec2<i32>(1 - (k & 1), 1 - (k >> 1));
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
  var sum = 0.0;
  var wsum = 0.0;
  for (var oy = -2; oy <= 1; oy++) {
    for (var ox = -2; ox <= 1; ox++) {
      let q = v + vec2<i32>(ox, oy);
      if (!inMap(q)) { continue; }
      let w = (2.0 - abs(f32(ox) + 0.5)) * (2.0 - abs(f32(oy) + 0.5));
      let s = surface[colIdxI(q)];
      let z = f32(sfZ(s));
      let isInner = ox >= -1 && ox <= 0 && oy >= -1 && oy <= 0;
      if (!isInner && (MATS[sfMat(s)].look.x <= 0.0 || abs(z - mid) > thr)) { continue; }
      sum += z * w;
      wsum += w;
    }
  }
  // keep it within the four touching columns' range so nothing pokes out
  return clamp(sum / wsum, lo, hi);
}

/** Drawn height at the corner v of a column whose own top is z. */
fn cornerOr(v: vec2<i32>, z: f32) -> f32 {
  let c = cornerZ(v);
  return select(c, z, c < 0.0);
}

/** Drawn ground height anywhere on cell c (bilinear over its four corners). */
fn groundZAt(c: vec2<i32>, f: vec2<f32>, z: f32) -> f32 {
  let a = cornerOr(c, z);
  let b = cornerOr(c + vec2<i32>(1, 0), z);
  let d = cornerOr(c + vec2<i32>(0, 1), z);
  let e = cornerOr(c + vec2<i32>(1, 1), z);
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}
