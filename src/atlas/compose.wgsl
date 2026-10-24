// ---- atlas/compose.wgsl ---------------------------------------------------
// The ground at any world point from the macro maps (round 67). The macro
// maps hold only what can't be known locally — which region a texel is in,
// the region across its nearest border, the distance to that border and to
// the coast (JFA) — so the same function draws the whole-world map, a zoomed
// view and the columns the streamer makes, and they all agree.
//
// A point takes its region A (the nearest texel's) and the region B across
// the nearest border, and s, its distance from that border signed towards A
// (bilinear over the texels, so the border is smooth below the texel). Each
// region's height is its own function (regionHeight); across the border they
// meet in the border's profile — a smooth blend, a cliff, a ravine, a wall,
// terraces; on a coast a beach or a sea cliff. Who sets the profile: on a
// coast the land; otherwise the region with the higher `prio`. Every profile
// is odd in s, so seen from B the same border comes out the same.

struct Region {
  kind: u32,
  pattern: u32,
  topMat: u32,
  rockMat: u32,
  /** height above the sea (land) or the floor's offset (water) */
  base: f32,
  rough: f32,
  ridge: f32,
  scale: f32,
  patAmp: f32,
  patScale: f32,
  terrace: f32,
  cover: f32,
  edge: u32,
  edgeW: f32,
  edgeD: f32,
  prio: f32,
  coastEdge: u32,
  moist: f32,
  veg: f32,
  cave: f32,
  seed: u32,
  /** 1 land, 2 a fault's strip */
  flags: u32,
  /** where the pattern stands highest, this material on top (0: none) */
  accent: u32,
  /** water: how deep the floor drops away from the coast */
  depth: f32,
  /** what stands on its ground or is cut into it (forms.wgsl, round 69) */
  f0: Form,
  f1: Form,
}

/** a region's form (regions.ts FormDef → 12 words): what each field means depends on the kind (forms.wgsl) */
struct Form {
  kind: u32,
  /** material | second material << 8 | profile << 16 | lobes << 24 */
  pk: u32,
  spacing: f32,
  chance: f32,
  hLo: f32,
  hHi: f32,
  radius: f32,
  twist: f32,
  lean: f32,
  lobeAmp: f32,
  shell: f32,
  zOff: f32,
}

const EDGE_SMOOTH: u32 = 0u;
const EDGE_CLIFF: u32 = 1u;
const EDGE_RAVINE: u32 = 2u;
const EDGE_WALL: u32 = 3u;
const EDGE_TERRACE: u32 = 4u;
const EDGE_BEACH: u32 = 5u;
const EDGE_SEACLIFF: u32 = 6u;

@group(0) @binding(20) var<storage, read> regionR: array<u32>;
/** x distance to the region's border (world units), y signed distance to the coast (+ land), z the region across (bits), w unused */
@group(0) @binding(21) var<storage, read> distR: array<vec4<f32>>;
@group(0) @binding(22) var<storage, read> regs: array<Region>;
@group(0) @binding(23) var<storage, read> pat: array<f32>;

struct Macro {
  a: u32,
  b: u32,
  s: f32,
  coast: f32,
}

fn macroAt(p: vec2<f32>) -> Macro {
  let t = torusU(p) * f32(AP.n) - 0.5;
  let i0 = vec2<i32>(floor(t));
  let f = t - floor(t);
  let near = texIdxW(vec2<i32>(floor(t + 0.5)));
  var m: Macro;
  m.a = regionR[near];
  m.b = bitcast<u32>(distR[near].z);
  var s: array<f32, 4>;
  var c: array<f32, 4>;
  var r: array<u32, 4>;
  for (var k = 0; k < 4; k++) {
    let j = texIdxW(i0 + vec2<i32>(k & 1, k >> 1));
    let d = distR[j];
    r[k] = regionR[j];
    s[k] = select(-d.x, d.x, r[k] == m.a);
    c[k] = d.y;
  }
  // the region across: one that's here when the border runs through these texels
  // (the nearest texel's own may be a third region's, past a corner)
  var bd = 1e30;
  for (var k = 0; k < 4; k++) {
    let j = texIdxW(i0 + vec2<i32>(k & 1, k >> 1));
    if (r[k] != m.a && distR[j].x < bd) {
      bd = distR[j].x;
      m.b = r[k];
    }
  }
  m.s = mix(mix(s[0], s[1], f.x), mix(s[2], s[3], f.x), f.y);
  m.coast = mix(mix(c[0], c[1], f.x), mix(c[2], c[3], f.x), f.y);
  return m;
}

fn isLand(r: Region) -> bool { return (r.flags & 1u) != 0u; }

struct RH {
  h: f32,
  /** its pattern's value here */
  pv: f32,
}

/** a region's own ground at p (as if it went on past its borders) */
fn regionHeight(r: Region, p: vec2<f32>, coast: f32) -> RH {
  let u = torusU(p);
  var h = AP.sea + r.base;
  if (isLand(r)) {
    h += AP.lift * smoothstep(0.0, 900.0, coast);
  } else {
    h -= r.depth * smoothstep(0.0, 260.0, -coast);
  }
  // (the world's own noise, at the region's scale and amplitude: regions alike meet without a seam)
  h += r.rough * pfbm(u, perOf(r.scale), 5u, AP.seed + 101u);
  if (r.ridge > 0.0) {
    h += r.ridge * pridged(u, perOf(r.scale * 1.6), 5u, AP.seed + 202u);
  }
  var pv = 0.0;
  if (r.pattern != 0u) {
    pv = pattern(r.pattern, p, r.patScale, r.seed);
    h += r.patAmp * pv;
  }
  if (r.terrace > 0.0) {
    let k = h / r.terrace;
    h = (floor(k) + smoothstep(0.62, 1.0, k - floor(k))) * r.terrace;
  }
  return RH(h, pv);
}

struct Ground {
  h: f32,
  /** the region whose ground this mostly is, and the other */
  a: u32,
  b: u32,
  /** A's weight (1: all A) */
  w: f32,
  coast: f32,
  /** the pattern's value here, A's (for its accent) */
  pv: f32,
  /** the distance from the border (signed towards A), and the lower of the two sides' heights there */
  s: f32,
  hlo: f32,
}

/** symmetric steps: st(1 − t) = 1 − st(t) */
fn stairs(t: f32, n: f32) -> f32 {
  let k = t * n;
  return (floor(k) + smoothstep(0.3, 0.7, k - floor(k))) / n;
}

fn ground(p: vec2<f32>) -> Ground {
  let u = torusU(p);
  let wq = vec2<f32>(pfbm(u, perOf(48.0), 3u, AP.seed + 21u), pfbm(u, perOf(48.0), 3u, AP.seed + 22u));
  let m = macroAt(p + wq * AP.warpCell);
  let A = regs[m.a];
  let B = regs[m.b];
  var g: Ground;
  g.a = m.a;
  g.b = m.b;
  g.coast = m.coast;
  // the border's profile
  var kind: u32;
  var ew: f32;
  var ed: f32;
  if (isLand(A) != isLand(B)) {
    var L = B;
    if (isLand(A)) {
      L = A;
    }
    kind = L.coastEdge;
    ew = L.edgeW;
    ed = L.edgeD;
  } else {
    let aWins = A.prio > B.prio || (A.prio == B.prio && m.a < m.b);
    var E = B;
    if (aWins) {
      E = A;
    }
    kind = E.edge;
    ew = E.edgeW;
    ed = E.edgeD;
  }
  let s = m.s;
  // the two regions' heights in a loop the compiler can't unroll (its bound isn't known):
  // regionHeight, and the pattern bank in it, compiled once
  let both = m.a != m.b && s <= ew * 1.05 + 3.0;
  let nr = select(1u, 2u, both);
  var hs = array<f32, 2>(0.0, 0.0);
  for (var k = 0u; k < nr; k++) {
    let rh = regionHeight(regs[select(m.b, m.a, k == 0u)], p, m.coast);
    hs[k] = rh.h;
    if (k == 0u) { g.pv = rh.pv; }
  }
  let hA = hs[0];
  g.s = s;
  g.hlo = hA;
  if (both) { g.hlo = min(hA, hs[1]); }
  if (!both) {
    g.h = hA;
    g.w = 1.0;
  } else {
    let hB = hs[1];
    var w = 0.0;
    var extra = 0.0;
    // (jitter along a border, odd under swapping the pair)
    let sgn = select(-1.0, 1.0, m.a < m.b);
    let jit = sgn * 2.5 * pfbm(u, perOf(14.0), 2u, AP.seed + 31u);
    switch kind {
      case EDGE_CLIFF, EDGE_SEACLIFF: {
        w = smoothstep(-1.2, 1.2, s + jit);
      }
      case EDGE_RAVINE: {
        w = smoothstep(-ew * 0.5, ew * 0.5, s);
        extra = -ed * (1.0 - smoothstep(ew * 0.3, ew, abs(s + jit * 0.5)));
      }
      case EDGE_WALL: {
        w = smoothstep(-ew, ew, s);
        extra = ed * (1.0 - smoothstep(ew * 0.15, ew, abs(s + jit * 0.5)));
      }
      case EDGE_TERRACE: {
        w = stairs(smoothstep(-ew, ew, s), 4.0);
      }
      default: {
        w = smoothstep(-ew, ew, s);
      }
    }
    g.h = mix(hB, hA, w) + extra;
    g.w = w;
  }
  g.h = clamp(g.h, 1.0, AP.zTop);
  return g;
}

/** 0 at the poles, 1 at the equator (the torus's v: poles at 0 and 1, the equator at ½) */
fn warmth(p: vec2<f32>) -> f32 { return 0.5 - 0.5 * cos(6.2831853 * torusU(p).y); }

/** °C: the latitude, cooler with height — the same as the sim's air (Atlas.climateAt sets its climate to this) */
fn temperature(p: vec2<f32>, h: f32) -> f32 {
  return warmth(p) * 34.0 - 8.0 - (h - AP.sea) * LAPSE;
}
/** °C a cell up: at 0.3 most uplands snowed over at mid-latitudes; now snow is for peaks and the cold */
const LAPSE: f32 = 0.12;

/** 0..1: wet at the equator and the mid-latitudes, dry in the subtropics and at the poles; wetter by the coast */
fn moistureAt(p: vec2<f32>, coast: f32, bias: f32) -> f32 {
  let lat = 1.0 - warmth(p);
  let m = 0.5 + 0.32 * cos(lat * 9.424778) + 0.25 * (1.0 - smoothstep(0.0, 500.0, coast)) + bias + 0.15 * pfbm(torusU(p), perOf(200.0), 3u, AP.seed + 43u);
  return clamp(m, 0.02, 1.0);
}
