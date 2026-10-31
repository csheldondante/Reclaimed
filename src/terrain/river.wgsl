// Terrain track (round 117): a river's course and cross-section as an SDF, per cell (atlas compose.wgsl ground()
// calls riverAt and riverCut). Prepended to every atlas kernel by Atlas.parts().
//
// The user (DECISIONS round 117): "Rivers look bad right now. They have serious isotropy issues and they have no banks.
// Use SDF. Have them carve into the ground. Make their banks look eroded. Add reeds. Have rocks and rapids. Have
// waterfalls. So many waterfalls." / "Waterfalls and flow are what look pretty good" (keep them).
//
// Why each piece:
//  - riverAt looks the river up at a WARPED point (a slow noise, RIVER_WARP world units): the drainage tree's nodes
//    sit on the macro texel grid (8 cells), so its line only ran at 0/45/90 degrees — the isotropy problem. A domain
//    warp bends every reach by a smooth field (its gradient well under 1, so the line never folds) at any angle; the
//    CPU (terrain/rivershape.ts) has already relaxed the grid's corners out of the nodes.
//  - It tests the two segments from each nearby node (a→b and b→c), so the joints between segments are continuous
//    when the nodes have moved off their texels, and so the segment past a fall knows the fall above it (the pool).
//  - riverCut is the cross-section: the channel (a parabola under the level), then a bank face to the ground — its
//    steepness by a noise along the river (cut banks steep, slumps gentle), broken into slumped blocks by Voronoi cells
//    (the treatment the user praised on the cliffs: "voronoi plus noise plus sdf to make steps"); gravel bars just over
//    the water on some stretches; boulders in rapids and round plunge pools; a deeper pool under each fall. The water's
//    level is the node's (incised under the plain on the CPU), so the bank is the plain standing over it.
//  - Cascades (a step the CPU made, 3-8 cells) drop at the segment's middle within ~1 cell, so the bed steps and the
//    held river pours over it as a sheet (forms.wgsl: a step over RIVER_FALL) — a waterfall, not a chute. Bigger
//    drops (the cliffs' falls) keep the interpolation they had: those were the ones that looked good.

/** world units the river lookup is warped by (its noise's period: RIVER_WARP_PER) */
const RIVER_WARP: f32 = 7.0;
const RIVER_WARP_PER: f32 = 150.0;
/** a segment falling between these (cells) is a cascade step: its bed drops at its middle */
const CASCADE_MIN: f32 = 2.9;
const CASCADE_MAX: f32 = 8.5;

struct River {
  on: bool,
  /** distance from the river's line, in its half-widths */
  x: f32,
  level: f32,
  w: f32,
  depth: f32,
  flags: u32,
  /** (round 84) its flow at the reference wetness: downstream along the segment, its node's speed (cells a tick) */
  vel: vec2<f32>,
  /** (round 117) the segment's fall (cells), its length (world units), how far along it (0..1), the fall of the
   *  segment above it (0: none known), which side of the line (±1) */
  fall: f32,
  len: f32,
  s: f32,
  fallUp: f32,
  side: f32,
}

fn riverWarp(p: vec2<f32>) -> vec2<f32> {
  let u = torusU(p);
  return RIVER_WARP * vec2<f32>(pfbm(u, perOf(RIVER_WARP_PER), 2u, AP.seed + 811u), pfbm(u, perOf(RIVER_WARP_PER), 2u, AP.seed + 812u));
}

/** the water's level along a segment at s: linear, or (a cascade) a step at its middle about a cell wide */
fn segLevel(a: RiverNode, b: RiverNode, s: f32, len: f32) -> f32 {
  let f = a.level - b.level;
  if (f >= CASCADE_MIN && f <= CASCADE_MAX && (a.flags & 1u) == 0u) {
    let hw = 0.6 / max(len, 1.0);
    return mix(a.level, b.level, smoothstep(0.5 - hw, 0.5 + hw, s));
  }
  return mix(a.level, b.level, s);
}

fn segTest(r: ptr<function, River>, a: RiverNode, b: RiverNode, p: vec2<f32>, fallUp: f32) {
  let pa = nearTo(vec2<f32>(a.x, a.y), p);
  let pb = nearTo(vec2<f32>(b.x, b.y), pa);
  let ab = pb - pa;
  let l2 = dot(ab, ab);
  var s = 0.0;
  if (l2 > 1e-6) { s = clamp(dot(p - pa, ab) / l2, 0.0, 1.0); }
  let w = mix(a.width, b.width, s);
  let x = length(p - (pa + ab * s)) / w;
  if (x < (*r).x) {
    let len = sqrt(max(l2, 1e-12));
    (*r).on = true;
    (*r).x = x;
    (*r).level = segLevel(a, b, s, len);
    (*r).w = w;
    (*r).depth = mix(a.depth, b.depth, s);
    (*r).vel = select(vec2<f32>(0.0), ab / len, l2 > 1e-6) * mix(a.speed, b.speed, s);
    (*r).flags = a.flags & b.flags;
    if (a.flags == 1u && s < 0.5) { (*r).flags = 1u; }
    (*r).fall = max(a.level - b.level, 0.0);
    (*r).len = len;
    (*r).s = s;
    (*r).fallUp = fallUp;
    let d = p - pa;
    (*r).side = select(-1.0, 1.0, ab.x * d.y - ab.y * d.x >= 0.0);
  }
}

/** the nearest river at p (looked up at the warped point): of the two segments from each node nearest the four texels round it */
fn riverAt(p0: vec2<f32>) -> River {
  let p = p0 + riverWarp(p0);
  var r: River;
  r.on = false;
  r.x = 1e9;
  let t = torusU(p) * f32(AP.n) - 0.5;
  let i0 = vec2<i32>(floor(t));
  for (var k = 0; k < 4; k++) {
    let id = riverBuf[texIdxW(i0 + vec2<i32>(k & 1, k >> 1))];
    if (id == 0u) { continue; }
    let a = riverNode(id - 1u);
    let b = riverNode(a.next);
    segTest(&r, a, b, p, 0.0);
    if (b.next != a.next) {
      segTest(&r, b, riverNode(b.next), p, max(a.level - b.level, 0.0));
    }
  }
  return r;
}

struct RiverCut {
  /** the ground is cut down to this */
  cut: f32,
  /** and raised to this (a boulder, a bar: rock or gravel over the water; 0 none) */
  raise: f32,
  /** 1: what's raised is rock (a boulder: the region's rock, bare), 0 loose (a gravel bar) */
  rock: f32,
}

/**
 * The river's cross-section at p (rv: riverAt(p)): the channel, the eroded bank up to the plain, bars, boulders and
 * plunge pools. Only for water rivers within 4 half-widths (lava keeps the plain channel).
 */
fn riverCut(p: vec2<f32>, rv: River) -> RiverCut {
  var o: RiverCut;
  o.raise = 0.0;
  o.rock = 0.0;
  let u = torusU(p);
  let x = rv.x;
  let lava = rv.flags == 1u;
  // the channel: a parabola under the level
  let ch = rv.level - rv.depth * (1.0 - min(x * x, 1.0));
  if (lava) {
    o.cut = select(rv.level + (x - 1.0) * rv.w * 2.5, ch, x < 1.0);
    return o;
  }
  // the bank (cells out from the water's edge, t): its steepness by a noise along the river — cut banks steep, slumped
  // stretches gentle — broken into blocks: each Voronoi cell ~6 across takes the bank's height at its own offset, so the
  // face steps irregularly, as the cliffs' shelves do
  let t = (x - 1.0) * rv.w;
  let k = mix(0.9, 3.2, smoothstep(-0.35, 0.35, pfbm(u, perOf(70.0), 2u, AP.seed + 821u)));
  let pj = perOf(6.0);
  let wj = pworley(u * f32(pj), vec2<i32>(pj), 0.9, AP.seed + 822u);
  let hj = hf(pcg(wj.id ^ (AP.seed * 0x2c1b3c6du)));
  let tb = max(t + (hj - 0.5) * 2.6, 0.0);
  // a bench (a floodplain the river cut and left: flat, a little over the water) along stretches, as wide as the river
  // or so, then the bank's face up to the plain — banks in steps, not one ruler line
  let benchN = 0.5 + 0.5 * pfbm(u, perOf(110.0), 2u, AP.seed + 826u);
  let benchW = rv.w * (0.3 + 1.4 * benchN) * smoothstep(0.25, 0.45, benchN);
  let benchZ = rv.level + 0.5 + 0.4 * hj;
  var bank = rv.level + 0.15 + k * tb;
  if (benchW > 0.5) {
    bank = select(benchZ + k * max(tb - benchW, 0.0), min(bank, benchZ), tb < benchW);
  }
  // (a lip of the plain's own roughness at the top: no ruler-straight edge)
  bank += 0.5 * pfbm(u, perOf(11.0), 2u, AP.seed + 823u);
  o.cut = select(bank, ch, x < 1.0);
  // a plunge pool under a fall: deeper, wider, round the foot of the step (a cascade's middle, or the top of the
  // segment past a big fall)
  var pool = 0.0;
  if (rv.fall >= CASCADE_MIN && rv.fall <= CASCADE_MAX) {
    let along = (rv.s - 0.5) * rv.len;
    pool = smoothstep(rv.w * 1.4, 0.0, length(vec2<f32>(max(along, 0.0) - rv.w * 0.6, x * rv.w))) * step(0.0, along) * min(0.5 * rv.fall, 3.0);
  }
  if (rv.fallUp > 4.0 && rv.s < 0.6) {
    let along = rv.s * rv.len;
    pool = max(pool, smoothstep(rv.w * 1.6, 0.0, length(vec2<f32>(along - rv.w * 0.5, x * rv.w))) * min(0.3 * rv.fallUp, 4.0));
  }
  if (x < 1.35) { o.cut = min(o.cut, ch) - pool; }
  // gravel bars: on one side where a slow noise along the river says (an inside bend, as far as this field knows), the
  // channel's margin rises just over the water — a beach of gravel to stand on at the river's edge
  let barN = pfbm(u, perOf(90.0), 2u, AP.seed + 824u) * rv.side;
  if (barN > 0.18 && x > 0.55 && x < 1.25 && rv.fall < CASCADE_MIN) {
    o.raise = rv.level + 0.25 + 0.2 * smoothstep(0.55, 1.2, x);
  }
  // boulders: in rapids (the level falling fast along the segment) and round a pool's rim; a few on every bank
  let slope = rv.fall / max(rv.len, 1.0);
  let rapid = smoothstep(0.05, 0.2, slope) * select(1.0, 0.0, rv.fall > CASCADE_MAX);
  let rim = select(0.0, 1.0, pool > 0.3 && x > 0.6 && x < 1.6);
  let chance = max(max(0.35 * rapid * step(x, 1.1), 0.45 * rim), 0.06 * step(0.9, x) * step(x, 2.2));
  if (chance > 0.0) {
    let pb = perOf(4.5);
    let wb = pworley(u * f32(pb), vec2<i32>(pb), 0.85, AP.seed + 825u);
    let hb = hf(pcg(wb.id ^ (AP.seed * 0x632be5abu)));
    if (hb < chance) {
      let rad = 0.25 + 0.2 * hf(pcg(wb.id * 3u + 11u));
      let q = wb.f1 / rad;
      if (q < 1.0) {
        let top = max(rv.level, min(o.cut, rv.level + 3.0)) + (0.3 + 1.3 * hf(pcg(wb.id * 7u + 5u))) * sqrt(1.0 - q * q);
        if (top > o.raise) {
          o.raise = top;
          o.rock = 1.0;
        }
      }
    }
  }
  return o;
}
