// ---- atlas/patterns.wgsl --------------------------------------------------
// The pattern bank (round 67): tiling scalar fields a region mixes into its
// height. Symmetric ones fold the plane onto a fundamental domain of a
// wallpaper group (a lattice, square or hex, and the rotations and mirrors of
// its point) and evaluate a motif there — any motif takes any symmetry; the
// motif fades out before the cell's edge so every group joins up. Others are
// procedural (Truchet, cracks, craters, dunes, veins, a kaleidoscopic fractal,
// basalt columns) or simulated once when the atlas is built (reaction–
// diffusion, cellular automata: tiles in `pat`, PAT_TILE² each).
// p: world units; scale: world units a lattice cell; returns about [-1, 1],
// 0 where the pattern leaves the ground as it is.

const PAT_TILE: u32 = 256u;

const PAT_NONE: u32 = 0u;
const PAT_P6M: u32 = 1u;
const PAT_P4M: u32 = 2u;
const PAT_P6: u32 = 3u;
const PAT_P3: u32 = 4u;
const PAT_WEAVE: u32 = 5u;
const PAT_TRUCHET: u32 = 6u;
const PAT_CRACKS: u32 = 7u;
const PAT_CRATERS: u32 = 8u;
const PAT_DUNES: u32 = 9u;
const PAT_CORAL: u32 = 10u;
const PAT_MAZE: u32 = 11u;
const PAT_CA: u32 = 12u;
const PAT_VEINS: u32 = 13u;
const PAT_KIFS: u32 = 14u;
const PAT_BASALT: u32 = 15u;

const SQ3H: f32 = 0.8660254;

/** a simulated tile, wrapped and bilinear; q in tiles */
fn patTex(t: u32, q: vec2<f32>) -> f32 {
  let n = f32(PAT_TILE);
  let p = q * n - 0.5;
  let i = vec2<i32>(floor(p));
  let f = p - floor(p);
  let per = vec2<i32>(i32(PAT_TILE));
  let base = t * PAT_TILE * PAT_TILE;
  var v: array<f32, 4>;
  for (var k = 0; k < 4; k++) {
    let w = wrapi(i + vec2<i32>(k & 1, k >> 1), per);
    v[k] = pat[base + u32(w.y) * PAT_TILE + u32(w.x)];
  }
  return mix(mix(v[0], v[1], f.x), mix(v[2], v[3], f.x), f.y);
}

struct Cell {
  /** the cell's centre (lattice units) */
  c: vec2<f32>,
  /** the point from it */
  v: vec2<f32>,
  key: vec2<i32>,
}

/** the hex lattice (spacing 1): the nearest lattice point */
fn hexCell(q: vec2<f32>) -> Cell {
  let r = q.y / SQ3H;
  let a = q.x - 0.5 * r;
  let s = -a - r;
  var ra = round(a);
  var rr = round(r);
  let rs = round(s);
  let da = abs(ra - a);
  let dr = abs(rr - r);
  let ds = abs(rs - s);
  if (da > dr && da > ds) {
    ra = -rr - rs;
  } else if (dr > ds) {
    rr = -ra - rs;
  }
  let c = vec2<f32>(ra + 0.5 * rr, rr * SQ3H);
  return Cell(c, q - c, vec2<i32>(i32(ra), i32(rr)));
}

fn sqCell(q: vec2<f32>) -> Cell {
  let c = floor(q) + 0.5;
  return Cell(c, q - c, vec2<i32>(floor(q)));
}

/** fold v into one sector of n about the cell's centre (and its mirror half when `mirror`) */
fn foldPolar(v: vec2<f32>, n: f32, mirror: bool) -> vec2<f32> {
  let r = length(v);
  let seg = 6.2831853 / n;
  var a = atan2(v.y, v.x);
  a = a - seg * floor(a / seg);
  if (mirror && a > seg * 0.5) {
    a = seg - a;
  }
  return vec2<f32>(cos(a), sin(a)) * r;
}

/** a motif in the fundamental domain: a dome with noise on it, gone by the cell's inradius */
fn motif(v: vec2<f32>, s: u32) -> f32 {
  let r = length(v);
  let env = smoothstep(0.47, 0.18, r);
  let k = snoise(v * 6.0 + vec2<f32>(hf(s) * 50.0, hf(pcg(s)) * 50.0), s);
  let ring = 0.5 + 0.5 * cos(r * (10.0 + 8.0 * hf(pcg(s + 3u))));
  return env * (0.45 + 0.35 * k + 0.3 * ring);
}

fn hexDist(v: vec2<f32>) -> f32 {
  let a = abs(v.x);
  let b = abs(0.5 * v.x + SQ3H * v.y);
  let c = abs(-0.5 * v.x + SQ3H * v.y);
  return max(a, max(b, c));
}

fn rot2(a: f32) -> mat2x2<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat2x2<f32>(c, s, -s, c);
}

fn pattern(id: u32, p: vec2<f32>, scale: f32, s: u32) -> f32 {
  let q = p / max(scale, 1.0);
  switch id {
    case PAT_P6M: {
      let c = hexCell(q);
      return motif(foldPolar(c.v, 6.0, true), s);
    }
    case PAT_P4M: {
      let c = sqCell(q);
      return motif(foldPolar(c.v, 4.0, true), s);
    }
    case PAT_P6: {
      // chiral: a spiral of six arms (no mirrors)
      let c = hexCell(q);
      let r = length(c.v);
      let a = atan2(c.v.y, c.v.x);
      return smoothstep(0.47, 0.2, r) * (0.5 + 0.5 * sin(a * 6.0 + r * 14.0));
    }
    case PAT_P3: {
      // a triskelion on the hex lattice
      let c = hexCell(q);
      let r = length(c.v);
      let a = atan2(c.v.y, c.v.x);
      return smoothstep(0.47, 0.15, r) * smoothstep(0.2, 0.9, 0.5 + 0.5 * sin(a * 3.0 - r * 16.0));
    }
    case PAT_WEAVE: {
      // basket weave: strips turn a quarter each cell
      let c = sqCell(q);
      var v = c.v;
      if (((c.key.x + c.key.y) & 1) == 1) {
        v = v.yx;
      }
      let strip = (1.0 - smoothstep(0.1, 0.18, abs(abs(v.y) - 0.25))) * smoothstep(0.5, 0.4, abs(v.x));
      return strip;
    }
    case PAT_TRUCHET: {
      let c = vec2<i32>(floor(q));
      var f = q - floor(q);
      if ((hash2u(c.x, c.y, s) & 1u) == 1u) {
        f.x = 1.0 - f.x;
      }
      let d = min(abs(length(f) - 0.5), abs(length(f - 1.0) - 0.5));
      return 1.0 - smoothstep(0.06, 0.16, d);
    }
    case PAT_CRACKS: {
      let w = pworley(q, vec2<i32>(1 << 20), 0.9, s);
      return smoothstep(0.02, 0.1, w.f2 - w.f1) * (0.5 + 0.5 * hf(pcg(w.id ^ s))) - 0.35;
    }
    case PAT_CRATERS: {
      let w = pworley(q, vec2<i32>(1 << 20), 0.7, s);
      let h = pcg(w.id ^ s);
      if (hf(h) > 0.55) {
        return 0.0;
      }
      let rad = 0.18 + 0.22 * hf(pcg(h));
      let d = w.f1 / rad;
      let bowl = select(0.0, d * d - 1.0, d < 1.0);
      let rim = exp(-((d - 1.0) * (d - 1.0)) / 0.04) * 0.45;
      return bowl + rim;
    }
    case PAT_DUNES: {
      let a = q.x + 0.35 * snoise(q * 0.35, s) + 0.15 * snoise(q * 1.3, s + 1u);
      let f = a - floor(a);
      let saw = select((1.0 - f) / 0.25, f / 0.75, f < 0.75);
      return smoothstep(0.0, 1.0, saw) * (0.6 + 0.4 * snoise(q * 0.2, s + 2u));
    }
    case PAT_CORAL: {
      return patTex(0u, q * 0.25) * 2.0 - 1.0;
    }
    case PAT_MAZE: {
      return patTex(1u, q * 0.25) * 2.0 - 1.0;
    }
    case PAT_CA: {
      return patTex(2u, q * 0.25) * 2.0 - 1.0;
    }
    case PAT_VEINS: {
      // vessels: the edges of cells at three scales, thinner as they get finer
      var v = 0.0;
      var amp = 1.0;
      var qq = q + vec2<f32>(snoise(q * 0.5, s), snoise(q * 0.5, s + 7u)) * 0.3;
      for (var o = 0u; o < 3u; o++) {
        let w = pworley(qq, vec2<i32>(1 << 20), 0.95, s + o * 31u);
        v = max(v, amp * (1.0 - smoothstep(0.0, 0.07, w.f2 - w.f1)));
        amp *= 0.6;
        qq = qq * 2.3 + 17.0;
      }
      return v;
    }
    case PAT_KIFS: {
      // a kaleidoscopic fractal folded into each square cell
      let c = sqCell(q);
      var z = foldPolar(c.v, 4.0, true) * 2.0;
      let ang = 0.4 + hf(s) * 0.8;
      var trap = 1e9;
      var sc = 1.0;
      for (var i = 0; i < 6; i++) {
        z = abs(z) - vec2<f32>(0.3, 0.17);
        z = rot2(ang) * z * 1.4;
        sc *= 1.4;
        trap = min(trap, length(z) / sc);
      }
      return smoothstep(0.06, 0.0, trap) * smoothstep(0.5, 0.35, length(c.v));
    }
    case PAT_BASALT: {
      // columns: each hex cell its own height, cracks between them
      let c = hexCell(q);
      let h = floor(hf(hash2u(c.key.x, c.key.y, s)) * 4.0) / 3.0;
      return (0.25 + 0.75 * h) * smoothstep(0.5, 0.43, hexDist(c.v));
    }
    default: {
      return 0.0;
    }
  }
}
