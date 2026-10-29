// ---- noiselab/lab.wgsl ----------------------------------------------------
// The noise lab (round 111, BACKLOG TG1): a recipe's layer stack evaluated per
// column on the GPU. Prepended: the layer's float indices (params.ts
// layerWgsl) and the atlas's own noise (atlas/noise.wgsl, unchanged — pnoise,
// pworley, the hashes), so what a lab layer samples is what the atlas samples.
//
// Kernels (lab.ts runs them in order, a uniform slot each):
//  labEval     layers [from, to) over every column's state (H, M1..M4, CF, CH)
//  labSlope    a slope layer's field: the steepest rise to a neighbour so far
//  labSeed     a JFA layer's seeds: the columns on its source's contour
//  labJfa      one jump-flood pass (step, ping-pong by flip)
//  labJfaDone  the field: nearest feature point, signed distance to it
//  labFinish   the columns' record: height, gaps, materials
//
// (round 112, TG10) Carves: a layer targeting `carve` makes a gap in the
// column, worked out per column from 2D values alone (the user: "2d noise plus
// height with SDF"; no 3D evaluation, no voxel march). Its value is the
// column's distance d in from the passage's edge (a JFA distance off a band of
// fractal noise: winding passages); a gap about a base height (below the
// surface, absolute or over the sea; brought to the sea where the mouths mask
// says, plus noise): roof = base + min(k d^2, vault) + noise, floor = base -
// depth + a smaller noise (walkable) — a rounded vault in section.
// Gaps union into a column's list (GAPS); labFinish settles them against the
// final height: a roof thinner than the cave roof opens to the sky (the column
// cut down to the floor: a mouth, an overhang's underside, a skylight) or
// isn't cut, as the layer says.

struct LabP {
  w: u32,
  h: u32,
  l0: u32,
  l1: u32,
  layer: u32,
  step: i32,
  flip: u32,
  src: u32,
  level: f32,
  seed: u32,
  base: f32,
  sea: f32,
  view: f32,
  cliffSlope: f32,
  beachH: f32,
  snowZ: f32,
  caveRoof: f32,
  caveMin: f32,
  zMax: f32,
  paint: u32,
  topMat: u32,
  rockMat: u32,
  cliffMat: u32,
  beachMat: u32,
  paintMat: u32,
  snowMat: u32,
  /** the thumbnails: every tStride-th column, tW across */
  tStride: u32,
  tW: u32,
}

@group(0) @binding(0) var<uniform> P: LabP;
@group(0) @binding(1) var<storage, read> LP: array<f32>;
/** two vec4 a column: (H, M1, M2, M3), (M4, CF, CH, -) */
@group(0) @binding(2) var<storage, read_write> st: array<vec4<f32>>;
/** a field a layer a column: (nearest feature x, y (sampled world), signed distance, slope) */
@group(0) @binding(3) var<storage, read_write> fields: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> jA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> jB: array<vec4<f32>>;
/** the columns, two vec4 a column: (height, gap 0 floor, gap 0 roof, materials: top + rock·64 + cliff·4096 +
 *  joined·8192 + cut·16384), (gap 1 floor, roof, gap 2 floor, roof); a gap 0, 0 is none */
@group(0) @binding(6) var<storage, read_write> outC: array<vec4<f32>>;
/** (round 112) a column's gaps while the stack runs: GAPS (floor, roof), two vec4 a column; an opening gap's floor
 *  is stored negated (floors are >= 1); 0, 0 none */
@group(0) @binding(7) var<storage, read_write> gapsW: array<vec4<f32>>;
/** (round 112) each layer's output (its value after shape and amp, and its mask's weight) at every tStride-th
 *  column: the stack's thumbnails */
@group(0) @binding(8) var<storage, read_write> thumbs: array<vec2<f32>>;

const GAPS: u32 = 4u;
const TARGET_CARVE: u32 = 7u;
const SHAPE_ISO: u32 = 8u;

const LAB_ROW_H: f32 = 0.8660254;
/** a lattice's period when it shouldn't wrap on the map */
const BIG: i32 = 65536;
const TAU: f32 = 6.2831853;

fn lp(l: u32, k: u32) -> f32 { return LP[l * LAYER_FLOATS + k]; }
fn lpu(l: u32, k: u32) -> u32 { return u32(round(LP[l * LAYER_FLOATS + k])); }

fn colIdx(c: vec2<i32>) -> u32 { return u32(c.y) * P.w + u32(c.x); }
/** a column's centre in the map's world units (odd rows half a cell right, rows ROW_H apart) */
fn cellW(c: vec2<i32>) -> vec2<f32> { return vec2<f32>(f32(c.x) + 0.5 + 0.5 * f32(c.y & 1), (f32(c.y) + 0.5) * LAB_ROW_H); }
/** where the recipe is sampled: the map's world scaled about its centre by the view */
fn viewW(p: vec2<f32>) -> vec2<f32> {
  let c = vec2<f32>(f32(P.w) * 0.5, f32(P.h) * 0.5 * LAB_ROW_H);
  return c + (p - c) * P.view;
}

/** fbm on lattice coordinates (the atlas's pfbm, any period a side: its octaves' sums and seeds), about [-1, 1] */
fn fbmL(q: vec2<f32>, per: vec2<i32>, oct: u32, s: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var pr = per;
  var f = 1.0;
  for (var o = 0u; o < oct; o++) {
    sum += amp * pnoise(q * f, pr, s + o * 1013u);
    norm += amp;
    amp *= 0.5;
    pr *= 2;
    f *= 2.0;
  }
  return sum / norm;
}

/** ridged fbm (the atlas's pridged), [0, 1] */
fn ridgeL(q: vec2<f32>, per: vec2<i32>, oct: u32, s: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var pr = per;
  var f = 1.0;
  var w = 1.0;
  for (var o = 0u; o < oct; o++) {
    var v = 1.0 - abs(pnoise(q * f, pr, s + o * 977u));
    v *= v;
    sum += v * amp * w;
    w = clamp(v * 1.6, 0.0, 1.0);
    norm += amp;
    amp *= 0.5;
    pr *= 2;
    f *= 2.0;
  }
  return sum / norm;
}

fn rot(v: vec2<f32>, deg: f32) -> vec2<f32> {
  let a = radians(deg);
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y);
}

struct Dom {
  q: vec2<f32>,
  per: vec2<i32>,
}

/** a layer's lattice point for world point p: warped, then grained or polar */
fn domain(l: u32, p: vec2<f32>, s: u32) -> Dom {
  let sc = max(lp(l, LK_SCALE), 0.5);
  var d = p;
  let wa = lp(l, LK_WARP);
  if (wa > 0.0) {
    let wq = p / (sc * 2.0);
    d += wa * sc * vec2<f32>(fbmL(wq, vec2<i32>(BIG), 3u, s + 71u), fbmL(wq + vec2<f32>(5.2, 1.3), vec2<i32>(BIG), 3u, s + 73u));
  }
  var o: Dom;
  let xf = lpu(l, LK_XFORM);
  if (xf == 1u) {
    // grain: the angle's direction stretched (bumps become ridges along it)
    let r = rot(d, -lp(l, LK_ANGLE));
    o.q = vec2<f32>(r.x / (sc * max(lp(l, LK_STRETCH), 1.0)), r.y / sc);
    o.per = vec2<i32>(BIG);
  } else if (xf == 2u) {
    // radial: (distance from the centre, the turn) — the turn's lattice wraps at `spokes`, so no seam
    let rel = d - vec2<f32>(lp(l, LK_CX), lp(l, LK_CY));
    let sp = max(i32(round(lp(l, LK_SPOKES))), 1);
    o.q = vec2<f32>(length(rel) / sc, (atan2(rel.y, rel.x) / TAU + 0.5) * f32(sp));
    o.per = vec2<i32>(BIG, sp);
  } else {
    o.q = d / sc;
    o.per = vec2<i32>(BIG);
  }
  return o;
}

/** a voronoi site of lattice cell c (pworley's) */
fn siteOf(c: vec2<i32>, per: vec2<i32>, jit: f32, s: u32) -> vec2<f32> {
  let w = wrapi(c, per);
  let h = hash2u(w.x, w.y, s);
  return vec2<f32>(c) + vec2<f32>(hf(h), hf(pcg(h))) * jit + (1.0 - jit) * 0.5;
}
fn cellHash(c: vec2<i32>, per: vec2<i32>, s: u32) -> u32 {
  let w = wrapi(c, per);
  return hash2u(w.x, w.y, s ^ 0x5bd1e995u);
}

/** in a mesa's group: a slow noise at the cell's site over the share's threshold */
fn inGroup(site: vec2<f32>, l: u32, s: u32) -> bool {
  let g = fbmL(site * (max(lp(l, LK_SCALE), 0.5) / max(lp(l, LK_SIZE), 1.0)), vec2<i32>(BIG), 2u, s + 301u);
  return g > (0.5 - lp(l, LK_SHARE)) * 0.8;
}

/**
 * Mesas (TG2, the user: "use a voronoi at the atlas scale and group several cells to define the mesa region, then
 * choose heights of different edges with some zero and blend height to the full mesa height"). Cells whose site a
 * slow noise puts in a group are the mesa; each of its outer edges (to a cell outside) is a wall (height 1) or, for
 * `ramp share` of them, a ramp (height 0) the top blends up from over `blend` cells. mode 0: that height (0..1,
 * 0 outside); mode 1: the signed distance into the group (cells; negative outside).
 */
fn mesas(l: u32, q: vec2<f32>, per: vec2<i32>, s: u32) -> f32 {
  let jit = lp(l, LK_JITTER);
  let sc = max(lp(l, LK_SCALE), 0.5);
  let i = vec2<i32>(floor(q));
  var best = 1e9;
  var ca = i;
  var sa = vec2<f32>(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = i + vec2<i32>(dx, dy);
      let sp = siteOf(c, per, jit, s);
      let d = length(sp - q);
      if (d < best) {
        best = d;
        ca = c;
        sa = sp;
      }
    }
  }
  let inA = inGroup(sa, l, s);
  let mode = lpu(l, LK_MODE);
  var v = 1.0;
  var dist = 1e9;
  let ha = cellHash(ca, per, s);
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let cb = ca + vec2<i32>(dx, dy);
      let sb = siteOf(cb, per, jit, s);
      if (inGroup(sb, l, s) == inA) { continue; }
      // the distance to the bisector between the two sites (lattice units, ≥ 0 on a's side)
      let n = normalize(sa - sb);
      let e = max(dot(q - (sa + sb) * 0.5, n), 0.0);
      dist = min(dist, e);
      if (inA && mode == 0u) {
        let hb = cellHash(cb, per, s);
        let pair = pcg(min(ha, hb) * 31u + max(ha, hb) + s);
        let hE = select(1.0, 0.0, hf(pair) < lp(l, LK_SHARE2));
        let bw = max(lp(l, LK_BLEND), 0.01) / sc;
        v = min(v, mix(hE, 1.0, smoothstep(0.0, bw, e)));
      }
    }
  }
  if (mode == 1u) {
    let dc = min(dist, 64.0 / sc) * sc;
    return select(-dc, dc, inA);
  }
  return select(0.0, v, inA);
}

/** an sdf shape about the centre, rotated by the angle: its value positive inside (cells) */
fn sdfShape(l: u32, p: vec2<f32>, s: u32) -> f32 {
  var rel = p - vec2<f32>(lp(l, LK_CX), lp(l, LK_CY));
  let wa = lp(l, LK_WARP);
  if (wa > 0.0) {
    let sc = max(lp(l, LK_SCALE), 0.5);
    rel += wa * sc * vec2<f32>(fbmL(p / sc, vec2<i32>(BIG), 3u, s + 81u), fbmL(p / sc + vec2<f32>(3.7, 9.1), vec2<i32>(BIG), 3u, s + 83u));
  }
  rel = rot(rel, -lp(l, LK_ANGLE));
  let a = lp(l, LK_SIZE);
  let b = lp(l, LK_SIZE2);
  var d = 0.0;
  switch (lpu(l, LK_MODE)) {
    case 1u: {
      let qq = abs(rel) - vec2<f32>(a, b);
      d = length(max(qq, vec2<f32>(0.0))) + min(max(qq.x, qq.y), 0.0);
    }
    case 2u: { d = abs(length(rel) - a) - b; }
    case 3u: {
      let hx = clamp(rel.x, -b, b);
      d = length(rel - vec2<f32>(hx, 0.0)) - a;
    }
    default: { d = length(rel) - a; }
  }
  return -d;
}

/** symmetric steps (compose.wgsl's stairs) */
fn stairsL(t: f32, n: f32) -> f32 {
  let k = t * n;
  return (floor(k) + smoothstep(0.3, 0.7, k - floor(k))) / n;
}

/**
 * The atlas's cliff walls (compose.wgsl mesaEdge's tiers, round 78: "multiple tiers as a function of distance with
 * some noise"): x, the distance onto the high side (cells); up to six walls, each its share of the drop by a noise
 * along the edge, the ledge before it by another — a share near none merges two walls, a ledge near none stacks
 * them. [0, 1].
 */
fn tiersL(l: u32, x: f32, p: vec2<f32>, s: u32) -> f32 {
  let n = clamp(lpu(l, LK_STEPS), 1u, 6u);
  let ledge = lp(l, LK_HI);
  let e = max(lp(l, LK_SOFT), 0.05);
  var sh: array<f32, 6>;
  var xw: array<f32, 6>;
  var tot = 0.0;
  var xa = lp(l, LK_LO);
  for (var k = 0u; k < n; k++) {
    let fk = f32(k);
    sh[k] = max(0.0, fbmL(p / (160.0 - 18.0 * fk), vec2<i32>(BIG), 2u, s + 613u + k * 7u) + 0.22) + 0.02;
    tot += sh[k];
    if (k > 0u) { xa += max(0.0, ledge * fbmL(p / (95.0 - 9.0 * fk), vec2<i32>(BIG), 2u, s + 614u + k * 7u) + ledge * 0.18); }
    xw[k] = xa;
  }
  var w = 0.0;
  for (var k = 0u; k < n; k++) { w += sh[k] / tot * smoothstep(-e, e, x - xw[k]); }
  return w;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

/** the state's eight floats */
fn loadSt(i: u32) -> array<f32, 8> {
  let a = st[i * 2u];
  let b = st[i * 2u + 1u];
  return array<f32, 8>(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w);
}

/** a source: 0 the height, 1..4 a mask */
fn srcOf(S: array<f32, 8>, k: u32) -> f32 { return S[min(k, 4u)]; }

/** one layer's value at column c (world p, sampled pv) */
fn layerValue(l: u32, c: vec2<i32>, pv0: vec2<f32>, S: array<f32, 8>) -> f32 {
  let g = lpu(l, LK_GEN);
  let s = P.seed * 7919u + lpu(l, LK_SEED) * 131u;
  var pv = pv0;
  // cells (quantize): sampled at the nearest voronoi site — flat blocks
  let cq = lp(l, LK_CELLQ);
  if (cq > 0.0 && g != 9u && g != 13u && g < 10u) {
    let wq = pworley(pv / cq, vec2<i32>(BIG), 0.9, s + 91u);
    pv = wq.near * cq;
  }
  let i = colIdx(c);
  let N = P.w * P.h;
  switch (g) {
    case 0u: { return 1.0; }
    case 1u, 2u, 3u: {
      let d = domain(l, pv, s);
      let oct = clamp(lpu(l, LK_OCT), 1u, 8u);
      if (g == 2u) { return ridgeL(d.q, d.per, oct, s); }
      let f = fbmL(d.q, d.per, oct, s);
      return select(f, abs(f), g == 3u);
    }
    case 4u: {
      let d = domain(l, pv, s);
      let w = pworley(d.q, d.per, lp(l, LK_JITTER), s);
      switch (lpu(l, LK_MODE)) {
        case 1u: { return w.f2; }
        case 2u: { return w.f2 - w.f1; }
        case 3u: { return hf(pcg(w.id ^ s)); }
        default: { return w.f1; }
      }
    }
    case 5u: {
      let d = domain(l, pv, s);
      return mesas(l, d.q, d.per, s);
    }
    case 6u: { return sdfShape(l, pv, s); }
    case 7u: {
      let a = radians(lp(l, LK_ANGLE));
      return dot(pv - vec2<f32>(lp(l, LK_CX), lp(l, LK_CY)), vec2<f32>(cos(a), sin(a))) / max(lp(l, LK_SCALE), 0.5);
    }
    case 8u: {
      // spires: a share of the cells stand a column, flat topped, of varied height
      let d = domain(l, pv, s);
      let w = pworley(d.q, d.per, lp(l, LK_JITTER), s);
      if (hf(pcg(w.id * 7u + s)) >= lp(l, LK_SHARE)) { return 0.0; }
      let r = lp(l, LK_RADIUS);
      return smoothstep(r + 0.04, r - 0.04, w.f1) * (0.6 + 0.4 * hf(pcg(w.id * 13u + 5u)));
    }
    case 9u: { return S[0]; }
    case 10u: { return fields[l * N + i].w; }
    case 11u: { return fields[l * N + i].z; }
    case 12u: {
      // JFA ridges (TG7, the user: "store the vector to the nearest feature at each point then adjust height by
      // noise along the feature border to make ridges perpendicular to isolines"): the noise sampled at the
      // nearest feature point (constant along the line out from it), the distance stretched out of it
      let f = fields[l * N + i];
      let dv = pv - f.xy;
      let dl = length(dv);
      let n = select(vec2<f32>(0.0), dv / dl, dl > 1e-3);
      let qf = (f.xy + n * dl / max(lp(l, LK_STRETCH), 1.0)) / max(lp(l, LK_SCALE), 0.5);
      return ridgeL(qf, vec2<i32>(BIG), clamp(lpu(l, LK_OCT), 1u, 8u), s);
    }
    case 13u: { return srcOf(S, lpu(l, LK_SRC)); }
    default: { return 0.0; }
  }
}

fn shapeOf(l: u32, v: f32, pv: vec2<f32>) -> f32 {
  let lo = lp(l, LK_LO);
  let hi = lp(l, LK_HI);
  let so = max(lp(l, LK_SOFT), 1e-4);
  switch (lpu(l, LK_SHAPE)) {
    case 1u: { return smoothstep(lo - so, lo + so, v); }
    case 2u: { return smoothstep(lo - so, lo + so, v) * (1.0 - smoothstep(hi - so, hi + so, v)); }
    case 3u: { return abs(v); }
    case 4u: {
      let span = select(hi - lo, 1.0, abs(hi - lo) < 1e-4);
      return lo + span * stairsL((v - lo) / span, f32(max(lpu(l, LK_STEPS), 1u)));
    }
    case 5u: { return tiersL(l, v, pv, P.seed * 7919u + lpu(l, LK_SEED) * 131u); }
    case 6u: { return sign(v) * pow(abs(v), max(lo, 0.01)); }
    case 7u: { return clamp(v, 0.0, 1.0); }
    default: { return v; }
  }
}

fn applyOp(op: u32, t: f32, o: f32, m: f32, k: f32) -> f32 {
  switch (op) {
    case 1u: { return t - o * m; }
    case 2u: { return t * mix(1.0, o, m); }
    case 3u: { return mix(t, max(t, o), m); }
    case 4u: { return mix(t, min(t, o), m); }
    case 5u: { return mix(t, o, m); }
    case 6u: { return mix(t, -smin(-t, -o, max(k, 0.01)), m); }
    case 7u: { return mix(t, smin(t, o, max(k, 0.01)), m); }
    default: { return t + o * m; }
  }
}

fn inMap(id: vec3<u32>) -> bool { return id.x < P.w && id.y < P.h; }

struct Gaps {
  g: array<vec2<f32>, 4>,
  joined: bool,
}

fn loadGaps(i: u32) -> Gaps {
  let a = gapsW[i * 2u];
  let b = gapsW[i * 2u + 1u];
  var o: Gaps;
  o.g = array<vec2<f32>, 4>(a.xy, a.zw, b.xy, b.zw);
  o.joined = false;
  return o;
}

fn storeGaps(i: u32, G: Gaps) {
  gapsW[i * 2u] = vec4<f32>(G.g[0], G.g[1]);
  gapsW[i * 2u + 1u] = vec4<f32>(G.g[2], G.g[3]);
}

/** a gap [lo, hi] into the list (open: it may open to the sky): merged with any it touches; a fifth apart from the
 *  rest joins the nearest (the air between them too) and the column says so */
fn addGap(G0: Gaps, lo0: f32, hi0: f32, open0: bool) -> Gaps {
  var G = G0;
  var lo = lo0;
  var hi = hi0;
  var open = open0;
  // (merge with every gap it touches, until none does)
  for (var it = 0u; it < GAPS; it++) {
    var hit = false;
    for (var k = 0u; k < GAPS; k++) {
      let e = G.g[k];
      if (e.y <= 0.0) { continue; }
      let el = abs(e.x);
      if (el <= hi && lo <= e.y) {
        lo = min(lo, el);
        hi = max(hi, e.y);
        open = open || e.x < 0.0;
        G.g[k] = vec2<f32>(0.0);
        hit = true;
      }
    }
    if (!hit) { break; }
  }
  for (var k = 0u; k < GAPS; k++) {
    if (G.g[k].y <= 0.0) {
      G.g[k] = vec2<f32>(select(lo, -lo, open), hi);
      return G;
    }
  }
  // (full: join the nearest)
  var best = 0u;
  var bd = 1e9;
  for (var k = 0u; k < GAPS; k++) {
    let e = G.g[k];
    let d = max(abs(e.x) - hi, lo - e.y);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  let e = G.g[best];
  let o2 = open || e.x < 0.0;
  let l2 = min(lo, abs(e.x));
  G.g[best] = vec2<f32>(select(l2, -l2, o2), max(hi, e.y));
  G.joined = true;
  return G;
}

/** a carve layer's gap at a column: (floor, roof), or roof < floor for none. d: the distance in from the passage's
 *  edge (cells), m: the layer's mask (the vault scaled by it) */
fn carveGap(l: u32, d: f32, m: f32, S: array<f32, 8>, pv: vec2<f32>, s: u32) -> vec2<f32> {
  if (d <= 0.0 || m <= 0.0) { return vec2<f32>(0.0, -1.0); }
  var base = lp(l, LK_ZOFF);
  switch (lpu(l, LK_ZREF)) {
    case 0u: { base += S[0]; }
    case 2u: { base += P.sea; }
    default: {}
  }
  let ck = lpu(l, LK_COAST);
  if (ck > 0u) { base = mix(base, P.sea + lp(l, LK_SEAZ), clamp(S[min(ck, 4u)], 0.0, 1.0)); }
  let nq = pv / max(lp(l, LK_NSCALE), 1.0);
  base += lp(l, LK_WOB) * fbmL(nq * 0.5, vec2<i32>(BIG), 2u, s + 401u);
  let roof = base + min(lp(l, LK_KQ) * d * d, lp(l, LK_UP)) * m + lp(l, LK_ROOFN) * fbmL(nq, vec2<i32>(BIG), 3u, s + 403u);
  let fl = base - lp(l, LK_DOWN) + lp(l, LK_FLOORN) * fbmL(nq, vec2<i32>(BIG), 2u, s + 409u);
  return vec2<f32>(fl, roof);
}

fn thumbAt(c: vec2<i32>) -> i32 {
  let ts = i32(max(P.tStride, 1u));
  if (c.x % ts != 0 || c.y % ts != 0) { return -1; }
  return (c.y / ts) * i32(P.tW) + c.x / ts;
}
fn thumbsPerLayer() -> u32 { return P.tW * ((P.h + max(P.tStride, 1u) - 1u) / max(P.tStride, 1u)); }

@compute @workgroup_size(8, 8)
fn labEval(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!inMap(id)) { return; }
  let c = vec2<i32>(id.xy);
  let i = colIdx(c);
  var S: array<f32, 8>;
  var G: Gaps;
  if (P.l0 == 0u) {
    S = array<f32, 8>(P.base, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  } else {
    S = loadSt(i);
    G = loadGaps(i);
  }
  let pv = viewW(cellW(c));
  let ti = thumbAt(c);
  for (var l = P.l0; l < P.l1; l++) {
    if (lp(l, LK_ON) < 0.5) { continue; }
    let v = layerValue(l, c, pv, S);
    var sv = 0.0;
    if (lpu(l, LK_SHAPE) == SHAPE_ISO) {
      // (round 112) the distance to the value's isoline at lo: |v - lo| over its slope (finite differences), cells
      let e = 0.5;
      let gx = layerValue(l, c, pv + vec2<f32>(e, 0.0), S) - v;
      let gy = layerValue(l, c, pv + vec2<f32>(0.0, e), S) - v;
      sv = abs(v - lp(l, LK_LO)) * e / max(length(vec2<f32>(gx, gy)), 1e-5) / P.view;
    } else {
      sv = shapeOf(l, v, pv);
    }
    let o = lp(l, LK_AMP) * sv + lp(l, LK_OFFSET);
    let mk = lpu(l, LK_MASK);
    var m = 1.0;
    if (mk > 0u) {
      m = clamp(S[min(mk, 4u)], 0.0, 1.0);
      if (lp(l, LK_MASKINV) > 0.5) { m = 1.0 - m; }
    }
    let t = min(lpu(l, LK_TARGET), TARGET_CARVE);
    var shown = o;
    if (t == TARGET_CARVE) {
      let s = P.seed * 7919u + lpu(l, LK_SEED) * 131u;
      let gp = carveGap(l, o, m, S, pv, s);
      // (its thumbnail: the distance in, where it cuts — the stack measures the passages' widths off it)
      shown = select(0.0, o, gp.y - gp.x >= 0.5);
      if (gp.y - gp.x >= 0.5) {
        G = addGap(G, max(gp.x, 1.0), gp.y, lpu(l, LK_OPEN) == 0u);
        if (G.joined) { S[7] = 1.0; }
      }
    } else {
      S[t] = applyOp(lpu(l, LK_OP), S[t], o, m, lp(l, LK_K));
    }
    if (ti >= 0) { thumbs[l * thumbsPerLayer() + u32(ti)] = vec2<f32>(shown, m); }
  }
  st[i * 2u] = vec4<f32>(S[0], S[1], S[2], S[3]);
  st[i * 2u + 1u] = vec4<f32>(S[4], S[5], S[6], S[7]);
  storeGaps(i, G);
}

fn nbrC(c: vec2<i32>, k: u32) -> vec2<i32> {
  let e = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(-1, -1), vec2<i32>(-1, 1), vec2<i32>(0, -1));
  let o = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(1, 1), vec2<i32>(0, -1), vec2<i32>(0, 1), vec2<i32>(1, -1));
  let d = select(e[k], o[k], (c.y & 1) == 1);
  return clamp(c + d, vec2<i32>(0), vec2<i32>(i32(P.w) - 1, i32(P.h) - 1));
}

/** the steepest rise or fall to a neighbour (cells a cell of the sampled world) */
fn slopeAt(c: vec2<i32>) -> f32 {
  let h = st[colIdx(c) * 2u].x;
  var m = 0.0;
  for (var k = 0u; k < 6u; k++) { m = max(m, abs(st[colIdx(nbrC(c, k)) * 2u].x - h)); }
  return m / P.view;
}

@compute @workgroup_size(8, 8)
fn labSlope(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!inMap(id)) { return; }
  let c = vec2<i32>(id.xy);
  let i = colIdx(c);
  fields[P.layer * P.w * P.h + i] = vec4<f32>(0.0, 0.0, 0.0, slopeAt(c));
}

fn sideOf(c: vec2<i32>) -> bool { return srcOf(loadSt(colIdx(c)), P.src) > P.level; }

@compute @workgroup_size(8, 8)
fn labSeed(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!inMap(id)) { return; }
  let c = vec2<i32>(id.xy);
  let me = sideOf(c);
  var seed = false;
  for (var k = 0u; k < 6u; k++) { seed = seed || sideOf(nbrC(c, k)) != me; }
  jA[colIdx(c)] = select(vec4<f32>(-1.0), vec4<f32>(f32(c.x), f32(c.y), 0.0, 0.0), seed);
}

fn jRead(i: u32) -> vec4<f32> {
  if (P.flip == 0u) { return jA[i]; }
  return jB[i];
}
fn jWrite(i: u32, v: vec4<f32>) {
  if (P.flip == 0u) { jB[i] = v; } else { jA[i] = v; }
}

@compute @workgroup_size(8, 8)
fn labJfa(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!inMap(id)) { return; }
  let c = vec2<i32>(id.xy);
  let p = cellW(c);
  var best = jRead(colIdx(c));
  var bd = select(1e18, dot(cellW(vec2<i32>(best.xy)) - p, cellW(vec2<i32>(best.xy)) - p), best.x >= 0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = c + vec2<i32>(dx, dy) * P.step;
      if (q.x < 0 || q.y < 0 || q.x >= i32(P.w) || q.y >= i32(P.h)) { continue; }
      let s = jRead(colIdx(q));
      if (s.x < 0.0) { continue; }
      let dv = cellW(vec2<i32>(s.xy)) - p;
      let d = dot(dv, dv);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
  }
  jWrite(colIdx(c), best);
}

@compute @workgroup_size(8, 8)
fn labJfaDone(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!inMap(id)) { return; }
  let c = vec2<i32>(id.xy);
  let i = colIdx(c);
  let s = jRead(i);
  let pv = viewW(cellW(c));
  let sgn = select(-1.0, 1.0, sideOf(c));
  var f = vec4<f32>(pv, 1e4 * sgn, 0.0);
  if (s.x >= 0.0) {
    let fp = viewW(cellW(vec2<i32>(s.xy)));
    f = vec4<f32>(fp, length(pv - fp) * sgn, 0.0);
  }
  fields[P.layer * P.w * P.h + i] = f;
}

@compute @workgroup_size(8, 8)
fn labFinish(@builtin(global_invocation_id) id: vec3<u32>) {
  if (!inMap(id)) { return; }
  let c = vec2<i32>(id.xy);
  let i = colIdx(c);
  let S = loadSt(i);
  let h = clamp(S[0], 1.0, P.zMax - 2.0);
  let sl = slopeAt(c);
  var top = P.topMat;
  var cliff = 0u;
  if (P.sea > 0.0 && h <= P.sea + P.beachH) { top = P.beachMat; }
  if (sl > P.cliffSlope) {
    top = P.cliffMat;
    cliff = 1u;
  } else if (h > P.snowZ) {
    top = P.snowMat;
  }
  if (P.paint == 1u && S[4] > 0.5) { top = P.paintMat; }
  // the gaps: the carves', and the cave the stack's floor and height make (never opening)
  var G = loadGaps(i);
  var joined = S[7] > 0.5;
  if (S[6] >= P.caveMin) {
    G = addGap(G, max(S[5], 1.0), S[5] + S[6], false);
    joined = joined || G.joined;
  }
  // (lowest first)
  for (var a = 0u; a < GAPS; a++) {
    for (var b = 0u; b + 1u < GAPS - a; b++) {
      let x = G.g[b];
      let y = G.g[b + 1u];
      let kx = select(1e9, abs(x.x), x.y > 0.0);
      let ky = select(1e9, abs(y.x), y.y > 0.0);
      if (ky < kx) {
        G.g[b] = y;
        G.g[b + 1u] = x;
      }
    }
  }
  // from the top down: a gap in the air goes; one under too thin a roof opens the column down to its floor or isn't
  // cut; one too low isn't cut. The bottom two cells stay (the edit tools' floor).
  var hh = h;
  var cut = 0u;
  var keep: array<vec2<f32>, 4>;
  for (var k = 0u; k < GAPS; k++) {
    let j = GAPS - 1u - k;
    let e = G.g[j];
    keep[j] = vec2<f32>(0.0);
    if (e.y <= 0.0) { continue; }
    let lo = max(abs(e.x), 2.0);
    let hi = e.y;
    if (hi - lo < P.caveMin || lo >= hh) { continue; }
    if (hi > hh - P.caveRoof) {
      if (e.x < 0.0) {
        hh = lo;
        cut = 1u;
      }
      continue;
    }
    keep[j] = vec2<f32>(lo, hi);
  }
  // (three go out: a fourth joins the third)
  var o: array<vec2<f32>, 3>;
  var n = 0u;
  for (var k = 0u; k < GAPS; k++) {
    let e = keep[k];
    if (e.y <= 0.0 || e.y > hh - P.caveRoof) { continue; }
    if (n < 3u) {
      o[n] = e;
      n++;
    } else {
      o[2] = vec2<f32>(o[2].x, e.y);
      joined = true;
    }
  }
  if (cut == 1u) { top = P.rockMat; }
  let mats = f32(top + P.rockMat * 64u + cliff * 4096u + select(0u, 8192u, joined) + cut * 16384u);
  outC[i * 2u] = vec4<f32>(hh, o[0].x, o[0].y, mats);
  outC[i * 2u + 1u] = vec4<f32>(o[1], o[2]);
}
