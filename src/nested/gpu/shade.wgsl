// ---- nested/gpu/shade.wgsl: the textured terrain's materials and light (round 20; detail.wgsl before it) -----------
// Binding-free, so a test can run it in a compute pass. One function for both draws (draw.wgsl fsT, fsST):
// - the shading normal = the geometric normal (whichever the crease rule picked) bent by the gradient of the detail
//   bands the geometry has not resolved: every band from the coarsest drawn down to the pixel footprint (faded out as its
//   wavelength nears 2 pixels), at most SH_NB of them (the coarsest faded out as a finer one fades in, so zooming slides
//   the window smoothly); with `split` >= 0 only bands finer than 2 columns of the level (s = its log2 columns a world
//   unit). The window depends on the world point and the pixel footprint alone, never on the level, so the same world
//   point shades the same from any level (`split` < 0, ?bands=all, the default this round).
// - materials from the same bands (colour detail and bumps agree): stone (strata in world z, cracks on steep faces),
//   soil (grass on the up-facing geometric normal, dirt on slopes; the boundary moved by the detail height and a broad
//   noise: grass keeps the hollows), sand (wind ripples), clay. 3D noise in world space, so nothing stretches on cliffs.
// - light in linear space: sun diffuse + a modest specular by roughness, a sky / ground hemisphere ambient, an occlusion
//   term from the detail height (hollows darker), haze toward a dimmed, bluer sky colour by world distance (round 21),
//   a filmic tone map, sRGB.
// - (round 21) the forest canopy on soil seen from afar (below).
// Cost: at most SH_NB + 1 band noises, one broad noise and (steep stone only) one crack noise: SH_NB + 3 = 9 3D
// gradient noises (8 hashes each) a pixel at worst; the canopy adds 2 noise-equivalents on far soil (not on stone, so
// the worst pixel stays at 9 + 0 for stone, 8 + 2 = 10 for far soil).

const SH_NB: f32 = 6.0;
/** haze: the fraction of light kept per world unit is exp(-SH_HAZE) */
const SH_HAZE: f32 = 0.0011;
/** (round 21) the haze's in-scattered light: the sky along the view times this (round 20: 1, pale far hills) */
const SH_HAZE_TINT: vec3<f32> = vec3<f32>(0.56, 0.66, 0.82);
const SH_EXPOSURE: f32 = 1.0;

struct ShadeIn {
  p: DPt,
  /** the geometric normal (the crease rule's pick), unit, toward the eye */
  ng: vec3<f32>,
  mat: u32,
  /** world units a pixel */
  pxW: f32,
  /** unit, from the eye toward the point */
  view: vec3<f32>,
  /** the distance from the eye, world units */
  distW: f32,
  /** unit, toward the sun */
  sun: vec3<f32>,
  /** < 0: every band (?bands=all); else the level's s: only bands finer than 2 of its columns (?bands=split) */
  split: f32,
  /** (diagnostics, Renderer.diag 3) the bands' value as grey, the shading normal unlit */
  debug: bool,
  /** the band window's size (SH_NB by default; ?texbands= on the page: fewer bands, fewer noises a pixel) */
  nb: f32,
  /** (round 21) the forest canopy's crossover footprint, world units a pixel (half way between grass and canopy);
   *  0: no canopy (?canopy=0) */
  canopy: f32,
  /** (round 25) the fog's share, 0..1, by metres (draw.wgsl fogAt); < 0: round 21's haze by world distance */
  fog: f32,
  /** (round 31, ?cliff=1) the slope (rise over run) past which ground is shaded as faceted blocks; 0 off */
  cliff: f32,
  /** (round 31) a block's width: 2^cliffE columns of the drawn level (0: one column; ?cliffW= metres fixes it in the world) */
  cliffE: i32,
  /** (round 31, version 2, ?cliff=2) the marched columns' hit (draw.wgsl texOut calls shCol): its weight (0 none), face
   *  normal, tint and occlusion */
  colW: f32,
  colN: vec3<f32>,
  colTint: f32,
  colAo: f32,
}

// ---- (round 31, version 2, ?cliff=2) standing columns by a ray march, no geometry, no buffer or texture reads ---------
// On a steep pixel (shSteep, as version 1) the ground near it is taken as the plane through the pixel with the geometric
// normal. A plan grid of square cells of a FIXED world width (2^k shading units: ?cliffW= metres, default 4) holds one
// column a cell, solid below its top: the plane's height at the cell centre snapped down to a half cell (absolute z),
// less 0..2 half cells by an integer hash of the cell. Tops only go down, so the ray starts inside a column by at most
// the snap. The view ray is marched from the pixel across plan cells (2D DDA, at most `steps` cells): the first cell
// whose top is above the ray where it enters is a side hit (normal the crossed face's axis), the ray falling to a cell's
// top inside it is a top hit (normal up). The starting cell first: if the pixel is already inside its column, the ray is
// followed back to where it came in (its top or a face). No hit within the steps: `miss` (version 0's shading, or a
// discard with ?cliffcut=1). Faded out under ~3-6 pixels a cell. Cost: up to steps + 1 integer hashes and a short loop.
struct ShCol {
  w: f32,
  n: vec3<f32>,
  tint: f32,
  ao: f32,
  miss: bool,
}
/** a column's top relative to the pixel, cells: the plane (normal gn) at the cell centre ctr (cells from the pixel),
 *  snapped down to a half cell in absolute z (zAbs, cells), less 0..2 half cells by the cell's hash */
fn shColTop(c: vec2<i32>, ctr: vec2<f32>, gn: vec3<f32>, zAbs: f32) -> f32 {
  let hc = -(gn.x * ctr.x + gn.y * ctr.y) / gn.z;
  let h = shH3(c.x, c.y, 5099);
  return (floor((zAbs + hc) * 2.0) - f32(h % 3u)) * 0.5 - zAbs;
}
fn shCol(si: ShadeIn, k: i32, steps: i32) -> ShCol {
  let ng = si.ng;
  var r = ShCol(0.0, ng, 1.0, 1.0, false);
  if (ng.z < -0.01) { return r; }
  let cellPx = ldexp(1.0, k) / max(si.pxW, 1e-30);
  let w = shSteep(ng, si.cliff) * clamp(log2(cellPx) - 1.6, 0.0, 1.0);
  if (w <= 0.0) { return r; }
  let p = si.p;
  // the pixel in cells: the start cell (whole, through integers) and the point in it
  let e = -p.s - k;
  let sx0 = dbSplit(p.o.x, p.f.x, e);
  let sy0 = dbSplit(p.o.y, p.f.y, e);
  let c0 = vec2<i32>(sx0.c, sy0.c);
  let p0 = vec2<f32>(sx0.t, sy0.t);
  let zAbs = ldexp(p.zo + ldexp(p.f.z, -p.s), -k);
  let gn = vec3<f32>(ng.xy, max(ng.z, 0.05));
  let v = si.view;
  let sx = select(-1, 1, v.x >= 0.0);
  let sy = select(-1, 1, v.y >= 0.0);
  let idx = 1.0 / max(abs(v.x), 1e-6);
  let idy = 1.0 / max(abs(v.y), 1e-6);
  var T = shColTop(c0, vec2<f32>(0.5) - p0, gn, zAbs);
  var ci = vec2<i32>(0);
  var hit = false;
  var hn = vec3<f32>(0.0, 0.0, 1.0);
  var th = 0.0;
  var zh = 0.0;
  if (T > 0.0) {
    // inside the start column: back along the ray to its top or the face it came through
    let bx = select(1.0 - p0.x, p0.x, v.x >= 0.0) * idx;
    let by = select(1.0 - p0.y, p0.y, v.y >= 0.0) * idy;
    let bt = select(1e30, T / -v.z, v.z < 0.0);
    hit = true;
    if (bt <= min(bx, by)) {
      th = -bt;
      zh = T;
    } else if (bx < by) {
      hn = vec3<f32>(-f32(sx), 0.0, 0.0);
      th = -bx;
      zh = -v.z * bx;
    } else {
      hn = vec3<f32>(0.0, -f32(sy), 0.0);
      th = -by;
      zh = -v.z * by;
    }
  } else {
    var tmx = select(p0.x, 1.0 - p0.x, v.x >= 0.0) * idx;
    var tmy = select(p0.y, 1.0 - p0.y, v.y >= 0.0) * idy;
    var z = 0.0;
    var t = 0.0;
    for (var i = 0; i < steps; i++) {
      let tx = min(tmx, tmy);
      // falling onto this column's top inside the cell
      if (v.z < 0.0) {
        let tt = t + (T - z) / v.z;
        if (tt <= tx) {
          hit = true;
          th = tt;
          zh = T;
          break;
        }
      }
      z += v.z * (tx - t);
      t = tx;
      if (tmx < tmy) {
        ci.x += sx;
        tmx += idx;
        hn = vec3<f32>(-f32(sx), 0.0, 0.0);
      } else {
        ci.y += sy;
        tmy += idy;
        hn = vec3<f32>(0.0, -f32(sy), 0.0);
      }
      T = shColTop(c0 + ci, vec2<f32>(ci) + vec2<f32>(0.5) - p0, gn, zAbs);
      if (z < T) {
        hit = true;
        th = t;
        zh = z;
        break;
      }
    }
  }
  if (!hit) {
    r.miss = true;
    return r;
  }
  // ---- the hit: per-column tint, a dark line at the vertical cell edges of a side, a lit rim under a side's top,
  // deeper hits (further along the ray from the pixel) darker
  let hp = p0 + v.xy * th;
  let lw = max(0.04, 0.9 / cellPx);
  let fr = fract(select(hp.x, hp.y, abs(hn.x) > 0.5));
  let edge = select(1.0 - smoothstep(0.5 * lw, lw, min(fr, 1.0 - fr)), 0.0, hn.z > 0.5);
  let rim = select((1.0 - smoothstep(lw, lw + 0.08, T - zh)) * (1.0 - edge), 0.0, hn.z > 0.5);
  let cc = c0 + ci;
  let hb = shH3(cc.x + 40503, cc.y - 7919, 31);
  let j = f32(hb & 1023u) / 1023.0;
  r.w = w;
  r.n = hn;
  r.tint = (0.80 + 0.32 * j) * (1.0 - 0.55 * edge) * (1.0 + 0.2 * rim);
  r.ao = (1.0 - 0.6 * edge) * mix(1.0, 0.5, smoothstep(0.0, 2.0, abs(th)));
  return r;
}

// ---- (round 31, look experiment, ?cliff=1) steep ground shaded as stacked faceted stone blocks, no new geometry --------
// Where the geometric slope passes si.cliff (rise over run; faded in over T / 1.25 .. T x 1.25): the wall is split on a
// grid of the DRAWN level's columns in plan (one column wide; ?cliffW= metres: a fixed world width instead, a power of two
// of the shading unit) along the wall's run and, per such column, a stack of blocks 1-3 half-blocks high
// (segments of 4 half-blocks, each cut once at a hashed integer, the stack shifted per column so joints do not line up).
// Each block: one facet normal (the wall's plan direction snapped to 30 degree steps after a per-block jitter, its pitch
// hashed), a tint, a dark joint at its borders (at least a pixel), a lighter top edge tilted up. Integer hashes only.
// It modulates the light and the albedo of whatever material is there; it never picks a material. Faded out where a
// block is under ~6-11 pixels. Cost: 3 integer hashes, one atan2, one cos/sin pair a steep pixel; nothing elsewhere.
// (?cliffcut=1, draw.wgsl cliffCutAt: the skyline notched by discarding crest pixels above a hashed stack top.)
struct ShCliff {
  w: f32,
  n: vec3<f32>,
  tint: f32,
  ao: f32,
}
fn shH3(a: i32, b: i32, c: i32) -> u32 {
  var h = (bitcast<u32>(a) * 0x8da6b343u) ^ (bitcast<u32>(b) * 0xd8163841u) ^ (bitcast<u32>(c) * 0xcb1ab31fu) ^ 0x2545f491u;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
/** how steep, 0..1 (the slope past T / 1.25 .. T x 1.25; slope = sqrt(1 - nz^2) / nz) */
fn shSteep(ng: vec3<f32>, T: f32) -> f32 {
  let n0 = inverseSqrt(1.0 + T * T / 1.5625);
  let n1 = inverseSqrt(1.0 + T * T * 1.5625);
  return 1.0 - smoothstep(n1, n0, abs(ng.z));
}
fn shCliff(si: ShadeIn) -> ShCliff {
  let ng = si.ng;
  var r = ShCliff(0.0, ng, 1.0, 1.0);
  let e = si.cliffE;
  // a block of 2^e columns of the drawn level in pixels (2^-s shading units a column)
  let colPx = ldexp(1.0, e - si.p.s) / max(si.pxW, 1e-30);
  // (faded in from about 6 to 11 pixels a block: smaller blocks only make a hatching)
  let w = shSteep(ng, si.cliff) * clamp(log2(colPx) - 2.5, 0.0, 1.0);
  if (w <= 0.0) { return r; }
  let p = si.p;
  // ---- the block: columns along the wall's run (the plan axis nearer the wall's horizontal: a wall facing x is cut by
  // y = const lines only; x borders would cross a leaning wall as slanted lines and make triangles), then the stack in
  // half-blocks; all in block widths (2^e columns: dbSplit keeps the whole part in integers)
  let ax = abs(ng.x) >= abs(ng.y);
  let sp = dbSplit(select(p.o.x, p.o.y, ax), select(p.f.x, p.f.y, ax), -e);
  let cc = sp.c;
  let cx = select(cc, 0x3fff, ax);
  let cy = select(0x3fff, cc, ax);
  let tc = sp.t;
  let zU = (ldexp(p.zo, p.s) + p.f.z) * ldexp(2.0, -e);
  let zs = zU + f32(shH3(cx, cy, 977) & 3u);
  let seg = floor(zs * 0.25);
  let cut = f32(1u + shH3(cx, cy, i32(seg)) % 3u);
  let zin = zs - seg * 4.0;
  let up = zin >= cut;
  let b0 = select(0.0, cut, up);
  let b1 = select(cut, 4.0, up);
  let hb = shH3(cx + 40503, cy - 7919, 2 * i32(seg) + select(0, 1, up));
  let j = vec3<f32>(f32(hb & 1023u), f32((hb >> 10u) & 1023u), f32((hb >> 20u) & 1023u)) / 1023.0;
  // ---- joints: distances to the borders in columns along the surface (the column border divided by how fast that
  // plan coordinate changes along the surface)
  let pc = 1.0 / colPx;
  let nc = select(ng.x, ng.y, ax);
  let dc = min(tc, 1.0 - tc) / max(sqrt(max(1.0 - nc * nc, 0.0)), 1e-3);
  let dzb = (zin - b0) * 0.5;
  let dzt = (b1 - zin) * 0.5;
  let dj = min(dc, min(dzb, dzt));
  let cw = max(0.035, 0.9 * pc);
  let joint = 1.0 - smoothstep(0.5 * cw, cw, dj);
  let top = (1.0 - smoothstep(cw, cw + 0.1, dzt)) * (1.0 - joint);
  // ---- the facet: plan direction snapped to 30 degrees after a per-block jitter; pitch hashed; tops tilted up
  let stp = 0.5235988;
  let a = round(atan2(ng.y, ng.x) / stp + (j.x - 0.5) * 0.9) * stp;
  let pz = ng.z * 0.6 + (j.y - 0.5) * 0.7 + 0.9 * top;
  r.n = normalize(vec3<f32>(cos(a), sin(a), pz));
  r.w = w;
  r.tint = (0.80 + 0.32 * j.z) * (1.0 - 0.55 * joint) * (1.0 + 0.22 * top);
  r.ao = 1.0 - 0.6 * joint;
  return r;
}

// ---- (round 21) the forest canopy seen from afar (the owner: "I think we want the hills at the furthest zoom to read as
// trees not grass but from miles away"). A stand-in for trees that do not exist as objects yet: on soil, where the pixel
// footprint is large, the ground is shaded as a closed canopy of rounded crowns; nearer it fades to the grass.
// - where: a forest density field in world space (a 32 world unit noise and the broad 8 unit one: woods and clearings),
//   none on slopes steeper than about 40 degrees (geometric normal z 0.62-0.82), soil only (stone, sand, clay bare).
// - crowns: a jittered grid of cells of 2^-SH_CROWN_M world units (2: 6.4 m, the root column being 3.2 m) in world
//   x, y, one crown a cell (radius 0.5-0.8 cells with a lobed outline: 6.4-10 m across, so neighbours overlap into a
//   closed canopy), kept where its hash is under the density (the forest thins to scattered trees at its edge); each a
//   rounded cap whose gradient bends the shading normal through the same light, the gaps between them dark (occlusion);
//   at grazing views the crowns grow (up to 1.3 x) so the gaps behind front crowns are hidden. The band bumps are
//   doubled on the crowns (lumpy, cauliflower-like). Colour by crown hash and the broad noise (stands of darker and
//   lighter trees).
// - crossover: by the footprint alone (same point, same look from any level): canopy at footprints over twice
//   `canopy`, grass under half of it (a smoothstep in log2). Crowns under ~4 pixels fade to their mean (no shimmer).
// Cost: 0 extra noises where the footprint is under canopy / 2 or the material is not soil or the slope is steep (a
// branch; texShade takes no derivatives, so the branch is safe); else the density noise (8 hashes) and, where the
// density is above 0, the crown cells (9 hashes + 9 atan2): 2 noise-equivalents a pixel at most.
const SH_CROWN_M: i32 = -1;

fn shHash2(c: vec2<i32>) -> vec4<f32> {
  var h = (bitcast<u32>(c.x) * 0x8da6b343u) ^ (bitcast<u32>(c.y) * 0xd8163841u) ^ 0x51ed270bu;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return vec4<f32>(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u), f32(h >> 24u)) / 255.0;
}
/** the crowns at p: x the crown's height over its radius (0 in a gap, 1 at a crown's top), yz the height's gradient per
 *  world unit (a rounded cap), w the crown's hash (colour); grow scales every crown (grazing views) */
fn shCrowns(p: DPt, dens: f32, grow: f32) -> vec4<f32> {
  let e = SH_CROWN_M - p.s;
  let ax = dbSplit(p.o.x, p.f.x, e);
  let ay = dbSplit(p.o.y, p.f.y, e);
  let t = vec2<f32>(ax.t, ay.t);
  var best = vec4<f32>(0.0);
  var bh = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let hc = shHash2(vec2<i32>(ax.c + i, ay.c + j));
      if (hc.w > dens * 1.2) { continue; }
      let dv = t - vec2<f32>(f32(i), f32(j)) - (vec2<f32>(0.05) + 0.9 * hc.xy);
      // (a lobed outline: a crown is a clump of a few rounded masses, not a disc; no noise, the angle and the hash)
      let an = atan2(dv.y, dv.x) + 6.2831853 * hc.w;
      let r = (0.5 + 0.3 * hc.z) * grow * (1.0 + 0.09 * sin(3.0 * an) + 0.06 * sin(5.0 * an + 2.0 * hc.x));
      let q = 1.0 - dot(dv, dv) / (r * r);
      // (the taller crown wins where two overlap: crowns of different heights, by size)
      let hq = q * r;
      if (q > 0.0 && hq > bh) {
        bh = hq;
        // (a rounded crown: about a sphere's cap, 0.45 r sqrt(q) high in cells; its gradient in cells per cell = per world
        // unit, capped near the rim at about 2.7)
        best = vec4<f32>(q, -0.75 * dv / (r * sqrt(max(q, 0.1))), hc.x);
      }
    }
  }
  return best;
}

fn shToLinear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn shAces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}
fn shSrgb(c: vec3<f32>) -> vec3<f32> {
  return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3<f32>(0.0031308));
}
/** linear light to the display: tone map, then sRGB (the canvas is a unorm format: we encode) */
fn shDisplay(c: vec3<f32>) -> vec3<f32> { return shSrgb(shAces(c * SH_EXPOSURE)); }

/** the sky's radiance looking along dir (unit): horizon to zenith, a glow round the sun, the sun's disc */
fn shSky(dir: vec3<f32>, sun: vec3<f32>) -> vec3<f32> {
  let hor = vec3<f32>(0.62, 0.70, 0.80);
  let zen = vec3<f32>(0.16, 0.30, 0.62);
  var c = mix(hor, zen, pow(clamp(dir.z, 0.0, 1.0), 0.55));
  c = mix(c, hor * 0.85, clamp(-dir.z * 3.0, 0.0, 1.0));
  let mu = max(dot(dir, sun), 0.0);
  c += vec3<f32>(1.0, 0.82, 0.58) * (0.30 * pow(mu, 6.0) + 0.9 * pow(mu, 120.0));
  c += vec3<f32>(1.0, 0.95, 0.85) * 12.0 * smoothstep(0.9993, 0.9997, mu);
  return c;
}

/** the textured surface colour, display-ready */
fn texShade(si: ShadeIn) -> vec3<f32> {
  let p = si.p;
  let ng = si.ng;
  let a = dbSlope(si.mat);
  // ---- the band window (see the head of the file)
  let tp = -log2(max(si.pxW, 1e-30));
  let nb = select(SH_NB, clamp(si.nb, 1.0, 12.0), si.nb > 0.0);
  var bLo = max(0.0, ceil(tp - nb));
  if (si.split >= 0.0) { bLo = max(bLo, si.split); }
  let bHi = min(f32(DB_N - 1), floor(tp));
  var g = vec3<f32>(0.0);
  var hv = 0.0;
  var hw = 0.0;
  for (var bf = bLo; bf <= bHi; bf += 1.0) {
    var w = clamp(tp - bf, 0.0, 1.0) * clamp(bf - (tp - nb), 0.0, 1.0);
    if (si.split >= 0.0) { w *= clamp(bf - si.split, 0.0, 1.0); }
    if (w <= 0.0) { continue; }
    let b = i32(bf);
    let hg = detailHG(p, si.mat, b);
    g += w * hg.yzw;
    // (the band's noise value back, about -1..1: the same bands drive the colour)
    hv += w * hg.x / max(a * 0.159155 * dbLambda(b), 1e-30);
    hw += w;
  }
  // the fine variation, about -1..1, and a broad one (8 world units) that the window never drops
  let av = clamp(hv / sqrt(max(hw, 1.0)) * 1.2, -1.0, 1.0);
  let mw = clamp(log2(8.0 / max(si.pxW, 1e-30)) - 1.0, 0.0, 1.0);
  let mv = mw * dbNoise(p, -3, 5u).x;
  let zW = p.zo + ldexp(p.f.z, -p.s);
  // ---- materials: albedo (sRGB), roughness, occlusion; extra normal terms into g
  var alb = vec3<f32>(1.0, 0.0, 1.0);
  var rough = 0.85;
  var ao = mix(0.62, 1.0, clamp(0.5 + 0.6 * av, 0.0, 1.0));
  let steep = 1.0 - smoothstep(0.55, 0.85, abs(ng.z));
  switch (si.mat) {
    case 1u: {
      // stone: strata in world z (warped by the noise), as tone and as small ledges; cracks on steep faces
      // (two strata spacings beating, bent by the broad noise: beds of uneven thickness, not a regular zebra)
      let sl = 0.21;
      let sf = clamp(log2(sl / max(si.pxW, 1e-30)) - 2.0, 0.0, 1.0) * steep;
      let ph = 6.2831853 * (zW / sl + 1.5 * mv + 0.15 * av);
      let st = 0.5 + 0.32 * sin(ph) + 0.18 * sin(ph * 2.37 + 1.3);
      alb = mix(vec3<f32>(0.55, 0.52, 0.47), vec3<f32>(0.44, 0.40, 0.36), st * sf * 0.6);
      alb *= (0.86 + 0.22 * av) * (0.92 + 0.16 * mv);
      g.z += sf * 0.12 * cos(ph);
      rough = 0.75;
      if (steep > 0.0) {
        // cracks: thin dark lines where one noise crosses zero, only where another is high (sparse), at least a pixel wide
        let cn = dbNoise(p, 1, 9u);
        let cw = 0.012 + 0.6 * si.pxW;
        let cf = clamp(log2(0.5 / max(si.pxW, 1e-30)) - 4.0, 0.0, 1.0) * steep * smoothstep(0.05, 0.25, mv + 0.3 * av);
        let crack = (1.0 - smoothstep(0.0, cw, abs(cn.x))) * cf;
        alb *= 1.0 - 0.45 * crack;
        ao *= 1.0 - 0.4 * crack;
      }
    }
    case 2u: {
      // soil: dirt (round 25: no grass picked by the normal; plants are their own layer, material 5)
      alb = vec3<f32>(0.46, 0.36, 0.25) * (0.86 + 0.22 * av);
      rough = 0.85;
    }
    case 5u: {
      // (round 25) plants: the generator's plant layer over soil, the grass colours round 20 gave up-facing soil
      alb = mix(vec3<f32>(0.20, 0.33, 0.11), vec3<f32>(0.42, 0.45, 0.20), clamp(0.4 + 0.8 * mv, 0.0, 1.0)) * (0.78 + 0.36 * av);
      rough = 0.95;
    }
    case 3u: {
      // sand: wind ripples (wavelength 0.04 world, along one direction, bent by the noise) on up-facing sand
      let rl = 0.04;
      let dir = vec2<f32>(0.8, 0.6);
      let xy = (vec2<f32>(p.o) + p.f.xy) * ldexp(1.0, -p.s);
      let rf = clamp(log2(rl / max(si.pxW, 1e-30)) - 2.0, 0.0, 1.0) * smoothstep(0.5, 0.9, ng.z);
      let ph = 6.2831853 * (dot(xy, dir) / rl + 1.2 * av + 3.0 * mv);
      g += vec3<f32>(dir, 0.0) * (rf * 0.22 * cos(ph));
      alb = vec3<f32>(0.80, 0.70, 0.49) * (0.94 + 0.1 * av + 0.04 * sin(ph) * rf);
      rough = 0.95;
    }
    case 4u: {
      alb = vec3<f32>(0.62, 0.38, 0.30) * (0.88 + 0.2 * av) * (0.95 + 0.1 * mv);
      rough = 0.8;
    }
    default: {}
  }
  // ---- (round 31, ?cliff=1) steep ground as faceted blocks (shCliff above): the facet replaces the geometric normal,
  // the band bumps mostly flattened on it (flat faces), tint and joints into the albedo and occlusion
  var so = si;
  so.cliff = 0.0;
  // (version 2, ?cliff=2: the marched column's face, found by draw.wgsl texOut)
  if (si.colW > 0.0) {
    so.ng = normalize(mix(ng, si.colN, si.colW));
    g *= 1.0 - 0.7 * si.colW;
    alb *= mix(1.0, si.colTint, si.colW);
    ao *= mix(1.0, si.colAo, si.colW);
  }
  if (si.cliff > 0.0) {
    let ck = shCliff(si);
    if (ck.w > 0.0) {
      so.ng = normalize(mix(ng, ck.n, ck.w));
      g *= 1.0 - 0.6 * ck.w;
      alb *= mix(1.0, ck.tint, ck.w);
      ao *= mix(1.0, ck.ao, ck.w);
    }
  }
  return shFinish(so, alb, rough, ao, g, av, mv);
}
/** (round 27: split from texShade so ?tex=2, tex.wgsl texShade2, shares it) the forest canopy, the shading normal, the
 *  light and the haze from a material's albedo (sRGB values), roughness, occlusion, height gradient g (world units of
 *  the shading), its variation av (-1..1) and the broad noise mv */
fn shFinish(si: ShadeIn, alb0: vec3<f32>, rough0: f32, ao0: f32, g0: vec3<f32>, av: f32, mv: f32) -> vec3<f32> {
  let p = si.p;
  let ng = si.ng;
  var alb = alb0;
  var rough = rough0;
  var ao = ao0;
  var g = g0;
  // ---- (round 21) the forest canopy from afar (see shCrowns above)
  // (round 25: on the plant layer, by the footprint alone; round 21's fade on the normal's z is gone, the material decides)
  var cw = 0.0;
  if (si.mat == 5u && si.canopy > 0.0) {
    cw = smoothstep(-1.0, 1.0, log2(si.pxW / si.canopy));
  }
  if (cw > 0.0) {
    // woods and clearings: a 32 world unit noise and the broad one (beyond 4 units a pixel the broad one is gone)
    let dens = smoothstep(-0.2, 0.15, dbNoise(p, -5, 23u).x + 0.3 * mv);
    // (the understorey: the grass, darker the denser the wood)
    var cAlb = mix(alb, vec3<f32>(0.06, 0.10, 0.05), dens);
    var cAo = ao * mix(1.0, 0.4, dens);
    var cg = g;
    if (dens > 0.0) {
      // (seen at a grazing angle, the crowns in front hide the gaps behind them: the crowns grow, up to 1.3 times, as the
      // view nears the surface)
      let cr = shCrowns(p, dens, mix(1.3, 1.0, smoothstep(0.2, 0.7, abs(dot(si.view, ng)))));
      let on = smoothstep(0.0, 0.2, cr.x);
      // crowns: dark green, hue and brightness from crown to crown (dark conifer-like to yellow-green broadleaf) and
      // with the band variation and the broad noise (stands of one kind); tops less occluded
      let kind = clamp(cr.w + 0.5 * mv, 0.0, 1.0);
      let leaf = mix(vec3<f32>(0.07, 0.15, 0.08), vec3<f32>(0.25, 0.30, 0.09), kind) * (0.78 + 0.4 * fract(cr.w * 7.31)) * (0.85 + 0.25 * av);
      // (the bumps: each crown's dome, the band bumps doubled on it; under ~4 pixels a crown fades to its mean)
      let bw = clamp(log2(2.0 / max(si.pxW, 1e-30)) - 1.5, 0.0, 1.0);
      let ex = mix(cAlb, leaf, on);
      let exAo = mix(cAo, ao * mix(0.72, 1.0, cr.x), on);
      let cover = min(dens * 1.2, 1.0) * 0.85;
      cAlb = mix(mix(cAlb, leaf, cover), ex, bw);
      cAo = mix(mix(cAo, ao * 0.8, cover), exAo, bw);
      cg = mix(g, 2.0 * g + vec3<f32>(cr.yz, 0.0), on * bw);
    }
    alb = mix(alb, cAlb, cw);
    ao = mix(ao, cAo, cw);
    g = mix(g, cg, cw);
    rough = mix(rough, 0.9, cw);
  }
  // ---- the shading normal: the geometric one bent by the bands' surface gradient
  let gs = g - ng * dot(g, ng);
  let n = normalize(ng - gs);
  if (si.debug) { return vec3<f32>(0.5 + 0.5 * av, 0.5 + 0.5 * dot(n, si.sun), 0.5 + 0.5 * mv); }
  // ---- light
  let sun = si.sun;
  let sunC = vec3<f32>(1.0, 0.92, 0.80) * 2.9;
  // (a face turned from the sun by its geometry gets no sun whatever its bumps)
  let ndl = max(dot(n, sun), 0.0) * smoothstep(-0.05, 0.15, dot(ng, sun));
  let amb = mix(vec3<f32>(0.30, 0.26, 0.20), vec3<f32>(0.50, 0.62, 0.85), 0.5 + 0.5 * n.z);
  let albL = shToLinear(alb);
  var c = albL * (sunC * ndl + amb * ao);
  let h = normalize(sun - si.view);
  let r4 = rough * rough * rough * rough;
  let sh = max(2.0 / r4 - 2.0, 1.0);
  let fr = 0.04 + 0.96 * pow(1.0 - clamp(dot(-si.view, h), 0.0, 1.0), 5.0);
  c += sunC * ndl * fr * ((sh + 8.0) / 8.0) * pow(max(dot(n, h), 0.0), sh);
  // ---- haze toward the sky colour along the view, by world distance (the same on every level)
  // (round 21: the light scattered in is the sky's colour along the view, dimmed and bluer, so far hills go blue-green and
  // dark rather than milky: aerial perspective, darker than the sky behind them)
  // (round 25: by metres where the draw gives a fog distance, full at about 8 km by default: ?fog=)
  var fog = 1.0 - exp(-si.distW * SH_HAZE);
  if (si.fog >= 0.0) { fog = si.fog; }
  c = mix(c, shSky(si.view, sun) * SH_HAZE_TINT, fog);
  return shDisplay(c);
}
