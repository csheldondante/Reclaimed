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
  /** (round 31) the columns' fill: a half-Lambert share of the sun's light on column faces (0 none) */
  colFill: f32,
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
  /** (round 31, version 3 diagnostics, ?cliffDbg=: draw.wgsl CLIFF_DBG) a categorical colour index to show, -1 none */
  dbg: i32,
}
/** a column's top relative to the pixel, cells: the plane (normal gn) at the cell centre ctr (cells from the pixel),
 *  snapped down to a half cell in absolute z (zAbs, cells), less 0..2 drop half cells by the cell's hash (drop:
 *  ?cliffDrop=, the most in cells, default 1) */
fn shColTop(c: vec2<i32>, ctr: vec2<f32>, gn: vec3<f32>, zAbs: f32, drop: u32) -> f32 {
  let hc = -(gn.x * ctr.x + gn.y * ctr.y) / gn.z;
  let h = shH3(c.x, c.y, 5099);
  return (floor((zAbs + hc) * 2.0) - f32(h % (2u * drop + 1u))) * 0.5 - zAbs;
}
// ---- (round 31, ?cliffSmooth=1) smooth tops: neighbouring columns whose tops differ by at most n cells (n = the
// steepness threshold, ?cliffT=) are joined by one continuous sheet; only a larger difference stands as a face. Each
// cell's top is four bilinear quadrants spanned by shared values: its own top at the centre; at each edge midpoint the mean
// of the two tops if that edge is joined, else its own top (flat toward a face); at each corner the mean of the cells
// joined to it round that corner (through joined edges). Two joined cells compute the same edge and corner values, so the
// sheet is continuous across their edge (a linear ramp of tops comes out exactly linear); the normal is the quadrant's slope.
/** the 3 x 3 column tops round cell ci (cells from the start cell c0), index (dx + 1) + 3 (dy + 1) */
fn scTops(c0: vec2<i32>, ci: vec2<i32>, p0: vec2<f32>, gn: vec3<f32>, zAbs: f32, drop: u32) -> array<f32, 9> {
  var t: array<f32, 9>;
  for (var j = 0; j < 9; j++) {
    let d = ci + vec2<i32>(j % 3 - 1, j / 3 - 1);
    t[j] = shColTop(c0 + d, vec2<f32>(d) + vec2<f32>(0.5) - p0, gn, zAbs, drop);
  }
  return t;
}
/** the smooth top over the local point q (0..1 in the cell): x its height (cells, from the pixel), yz its gradient */
fn scH(tp: array<f32, 9>, q: vec2<f32>, n: f32) -> vec3<f32> {
  var t = tp;
  let ix = select(-1, 1, q.x >= 0.5);
  let iy = select(-1, 1, q.y >= 0.5);
  let c = t[4];
  let a = t[4 + ix];
  let b = t[4 + 3 * iy];
  let d = t[4 + ix + 3 * iy];
  let jA = abs(c - a) <= n;
  let jB = abs(c - b) <= n;
  let jAD = abs(a - d) <= n;
  let jBD = abs(b - d) <= n;
  let ex = select(c, 0.5 * (c + a), jA);
  let ey = select(c, 0.5 * (c + b), jB);
  // the corner: the mean of the cells joined to this one round it
  let inA = jA || (jB && jBD && jAD);
  let inB = jB || (jA && jAD && jBD);
  let inD = (jA && jAD) || (jB && jBD);
  let cs = c + select(0.0, a, inA) + select(0.0, b, inB) + select(0.0, d, inD);
  let cc = cs / (1.0 + select(0.0, 1.0, inA) + select(0.0, 1.0, inB) + select(0.0, 1.0, inD));
  let s = clamp(abs(q.x - 0.5) * 2.0, 0.0, 1.0);
  let u = clamp(abs(q.y - 0.5) * 2.0, 0.0, 1.0);
  let h = mix(mix(c, ex, s), mix(ey, cc, s), u);
  return vec3<f32>(h, mix(ex - c, cc - ey, u) * 2.0 * f32(ix), mix(ey - c, cc - ex, s) * 2.0 * f32(iy));
}
fn shCol(si: ShadeIn, k: i32, steps: i32, drop: u32, sheet: bool) -> ShCol {
  let ng = si.ng;
  var r = ShCol(0.0, ng, 1.0, 1.0, false, -1);
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
  var T = shColTop(c0, vec2<f32>(0.5) - p0, gn, zAbs, drop);
  var ci = vec2<i32>(0);
  var hit = false;
  var hn = vec3<f32>(0.0, 0.0, 1.0);
  var th = 0.0;
  var zh = 0.0;
  // (a top hit: no edge lines; with smooth tops no per-cell tint either, the sheet runs across cells)
  var isTop = false;
  if (sheet) {
    // One loop, one site each for scTops and scH (every inlined copy of them costs compile time). Per cell, the ray's
    // height over the cell's sheet is sampled at entry, middle and exit; the first sign change is refined by 3
    // false-position steps (a top hit). Under the sheet already at entry: a face (a top hit where the crossed edge is
    // joined: there the sheets meet, so that is rounding). Else on to the next cell, `steps` crossings at most. The
    // start cell first: if the pixel is under its sheet, the ray is taken back to where it entered that cell and the
    // search runs from there to the pixel (under the sheet, so the entry is found).
    let n = si.cliff;
    let bx = select(1.0 - p0.x, p0.x, v.x >= 0.0) * idx;
    let by = select(1.0 - p0.y, p0.y, v.y >= 0.0) * idy;
    var tmx = select(p0.x, 1.0 - p0.x, v.x >= 0.0) * idx;
    var tmy = select(p0.y, 1.0 - p0.y, v.y >= 0.0) * idy;
    var t = 0.0;
    var tp: array<f32, 9>;
    var fresh = true;
    var first = true;
    var joined = true;
    var hh = vec3<f32>(0.0, 0.0, 0.0);
    var i = 0;
    loop {
      if (fresh) {
        tp = scTops(c0, ci, p0, gn, zAbs, drop);
        fresh = false;
      }
      let tx = select(min(tmx, tmy), 0.0, t < 0.0);
      var a = t;
      var b = tx;
      var fa = 0.0;
      var fb = 0.0;
      var found = false;
      var under = false;
      for (var j = 0; j < 6; j++) {
        if (j >= 3 && !found) { break; }
        let x = select(mix(t, tx, 0.5 * f32(j)), a + (b - a) * fa / (fa - fb), j >= 3);
        let h = scH(tp, p0 + v.xy * x - vec2<f32>(ci), n);
        let fx = v.z * x - h.x;
        if (j < 3 && found) { continue; }
        if (fx >= 0.0) {
          a = x;
          fa = fx;
        } else {
          b = x;
          fb = fx;
          hh = h;
          found = true;
          if (j == 0) {
            under = true;
            break;
          }
        }
      }
      if (under) {
        if (first) {
          first = false;
          t = -min(bx, by);
          joined = abs(tp[4] - tp[select(4 - 3 * sy, 4 - sx, bx < by)]) <= n;
          hn = select(vec3<f32>(0.0, -f32(sy), 0.0), vec3<f32>(-f32(sx), 0.0, 0.0), bx < by);
          continue;
        }
        hit = true;
        isTop = joined;
        th = t;
        break;
      }
      if (found) {
        hit = true;
        isTop = true;
        th = b;
        break;
      }
      first = false;
      if (i >= steps) { break; }
      i += 1;
      var nb = 0;
      t = tx;
      if (tmx < tmy) {
        ci.x += sx;
        tmx += idx;
        nb = 4 + sx;
        hn = vec3<f32>(-f32(sx), 0.0, 0.0);
      } else {
        ci.y += sy;
        tmy += idy;
        nb = 4 + 3 * sy;
        hn = vec3<f32>(0.0, -f32(sy), 0.0);
      }
      joined = abs(tp[4] - tp[nb]) <= n;
      fresh = true;
    }
    if (hit) {
      // the top's normal from the sheet's slope; a face's from its axis; T the sheet over the hit (for the rim)
      T = hh.x;
      zh = v.z * th;
      if (isTop) {
        hn = normalize(vec3<f32>(-hh.y, -hh.z, 1.0));
      }
    }
  } else if (T > 0.0) {
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
      T = shColTop(c0 + ci, vec2<f32>(ci) + vec2<f32>(0.5) - p0, gn, zAbs, drop);
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
  let top = isTop || hn.z > 0.5;
  let edge = select(1.0 - smoothstep(0.5 * lw, lw, min(fr, 1.0 - fr)), 0.0, top);
  let rim = select((1.0 - smoothstep(lw, lw + 0.08, T - zh)) * (1.0 - edge), 0.0, top);
  let cc = c0 + ci;
  let hb = shH3(cc.x + 40503, cc.y - 7919, 31);
  let j = select(f32(hb & 1023u) / 1023.0, 0.625, sheet && top);
  r.w = w;
  r.n = hn;
  r.tint = (0.80 + 0.32 * j) * (1.0 - 0.55 * edge) * (1.0 + 0.2 * rim);
  r.ao = (1.0 - 0.6 * edge) * mix(1.0, 0.5, smoothstep(0.0, 2.0, abs(th)));
  return r;
}

// ---- (round 31, version 3, ?cliff=3; draw.wgsl CLIFF_V3 compiles it in) nested columns: a max-mip march -------------
// Level 0: cells of a fixed world width (?cliffW=, default 16 m), tops as version 2 (the plane at the cell centre snapped
// down to a half cell, less 0..2 drop hashed half cells). Level l + 1 halves the cell (2 x 2 children); a child's top is
// its parent's less 0..2 drop of its own hashed half cells (no re-snap of the plane per level: that made a staircase per
// level), so a parent bounds its descendants and coarse columns never move. The finest level D and its share are chosen
// from the distance to the eye (dist x pxAng = a pixel), not from the pixel's derivatives, so neighbouring pixels agree:
// level-0 cells over 2^D pixels at least ?cliffPx= (default 6); level D's drops, edge lines and tint grow in with the
// fraction of the level (0 when it appears, full one level later). The march: step a level's cells while the ray is above
// their tops; entering a cell below its top (or falling onto it) descends into its children (a max-mip heightfield trace);
// leaving the parent goes back up. A hit at level D is the answer (side: the crossed face's axis; top: up). Bounds:
// SC3_LCAP + 1 levels, SC3_ITER steps in all (descents and crossings), `steps` level-0 cells; else a miss.
const SC3_LCAP: i32 = 5;
const SC3_ITER: i32 = 40;
// (step 4b) Fine depth: level l's hashed drop is at most drop + dropF x l of its own (nominal 2^-l) cells
// (?cliffDrop=, ?cliffDropF=), so finer columns sit at visibly different depths. Horizontal noise (?cliffHN=, 0..1):
// a cell splits into its 2 x 2 children at a hashed fraction of its width per axis, 0.5 +- 0.2 x HN, instead of the
// middle; children stay inside their parent, so the max-mip march stays exact (it carries each level's bounds and a
// path hash instead of integer cell indices). Level 0 stays a regular grid.
/** a cell's hashed drop below its parent (level-0 cells): key the cell's hash, l its level. (Sinks, ?cliffSink= percent,
 *  default 0, the first reading of the owner's "gaps", kept: at levels 1 and finer that share of cells, by another part
 *  of the hash, drops 4 of its own cells more; still below the parent, so a parent bounds its children) */
fn sc3Drop(key: u32, l: i32, drop: u32, dropF: f32, sink: f32) -> f32 {
  let dl = drop + u32(round(dropF * f32(l)));
  let g = select(0.0, 4.0, l > 0 && f32((key >> 8u) % 100u) < sink);
  return (f32(key % (2u * dl + 1u)) * 0.5 + g) * ldexp(1.0, -l);
}
// (step 4b, ?cliffGap= percent, ?cliffGapD= depth: the owner's "random dropped fine intervals around the cliff edge to a
// small depth 0-4 columns"; "notches vary along the vertical surface") A fine column keeps its top; below it, z is cut into
// segments: a base length of 1-3 of its nominal cell widths per cell, each boundary moved by a hashed +-0.4 of it per
// (cell, boundary); a hashed share of segments (by cell and segment index) is a gap, never the segment touching the top;
// all independent between neighbouring columns. Where the ray's first side hit lands in a gap of the outermost cell, a hashed depth d of 0..GapD
// cells (by cell and segment; 0: no recess) is cut into the face: the ray passes through d cells at that level with
// the first cell's gap z-range (a box-shaped notch), hitting the notch's floor (up, a lit ledge) or ceiling (down) if
// it leaves that range inside a cell, else the side of the cell after them (the notch's back), shaded as recessed.
// Tops never change.
/** whether segment j of cell key is a gap */
fn sc3GapAt(key: u32, j: i32, share: f32) -> bool {
  return f32(shH3(bitcast<i32>(key), j, 6151) % 100u) < share;
}
/** boundary j's depth below the top (segment j spans boundaries j..j + 1): a base length lc per cell, each boundary
 *  (j >= 1) moved by a hashed +-0.4 lc, so segment lengths vary per (cell, segment) from 0.2 to 1.8 lc */
fn sc3Bound(key: u32, j: i32, lc: f32) -> f32 {
  if (j <= 0) { return 0.0; }
  return lc * (f32(j) + 0.8 * (f32(shH3(bitcast<i32>(key), j, 7121) & 1023u) / 1023.0 - 0.5));
}
/** the run of gap segments round height z in a column of top T (cell width sz): (floor, ceiling, its top segment's
 *  index), or floor > ceiling for none */
fn sc3Gap(key: u32, sz: f32, T: f32, z: f32, share: f32) -> vec3<f32> {
  if (share <= 0.0) { return vec3<f32>(1.0, 0.0, 0.0); }
  let lc = sz * f32(1u + ((key >> 4u) % 3u));
  let dz = T - z;
  var j = i32(floor(dz / lc));
  if (dz < sc3Bound(key, j, lc)) {
    j -= 1;
  } else if (dz >= sc3Bound(key, j + 1, lc)) {
    j += 1;
  }
  if (j < 1 || !sc3GapAt(key, j, share)) { return vec3<f32>(1.0, 0.0, 0.0); }
  // (the run of air segments round j, 3 more each way at most; never segment 0)
  var a = j;
  var b = j;
  for (var u = 0; u < 3; u++) {
    if (a > 1 && sc3GapAt(key, a - 1, share)) { a -= 1; } else { break; }
  }
  for (var u = 0; u < 3; u++) {
    if (sc3GapAt(key, b + 1, share)) { b += 1; } else { break; }
  }
  return vec3<f32>(T - sc3Bound(key, b + 1, lc), T - sc3Bound(key, a, lc), f32(a));
}
/** a level-0 column's top over cell rc (cells from the start cell c0), relative to the pixel, level-0 cells */
fn sc3Top0(key: u32, rc: vec2<i32>, p0: vec2<f32>, gn: vec3<f32>, zAbs: f32, drop: u32) -> f32 {
  let ctr = vec2<f32>(rc) + vec2<f32>(0.5) - p0;
  let hc = -(gn.x * ctr.x + gn.y * ctr.y) / gn.z;
  return floor((zAbs + hc) * 2.0) * 0.5 - sc3Drop(key, 0, drop, 0.0, 0.0) - zAbs;
}
/** (step 4b, ?cliffPatch= P level-0 cells, 0 off) the fine detail's mask along the wall: value noise on a lattice of P
 *  cells (integer-hashed lattice values, smoothstep-interpolated) at the level-0 cell c0 + rc's centre, remapped so about
 *  a third of the wall is 0 (coarse columns only), a third 1 and the rest between. Evaluated per level-0 cell, so a
 *  column's height stays a function of its cell; it scales the fine levels' drops and gap share, never switches levels */
fn sc3Mask(c0: vec2<i32>, rc: vec2<i32>, P: f32) -> f32 {
  if (P <= 0.0) { return 1.0; }
  let Pi = max(i32(round(P)), 1);
  let c = c0 + rc;
  // (floor division in integers: c0 is a large world index)
  let cb = vec2<i32>(floor(vec2<f32>(c) / f32(Pi)));
  let rem = c - cb * Pi;
  let qf = (vec2<f32>(rem) + vec2<f32>(0.5)) / f32(Pi);
  let f = qf * qf * (vec2<f32>(3.0) - 2.0 * qf);
  let h00 = f32(shH3(cb.x, cb.y, 9157) & 1023u);
  let h10 = f32(shH3(cb.x + 1, cb.y, 9157) & 1023u);
  let h01 = f32(shH3(cb.x, cb.y + 1, 9157) & 1023u);
  let h11 = f32(shH3(cb.x + 1, cb.y + 1, 9157) & 1023u);
  let n = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y) / 1023.0;
  return smoothstep(0.38, 0.62, n);
}
/** where a cell (bounds lo..hi, hash key) splits into its children: 0.5 +- 0.2 hn of its width per axis */
fn sc3Split(lo: vec2<f32>, hi: vec2<f32>, key: u32, hn: f32) -> vec2<f32> {
  let f = vec2<f32>(f32((key >> 12u) & 1023u), f32((key >> 22u) & 1023u)) / 1023.0 - vec2<f32>(0.5);
  return lo + (hi - lo) * (vec2<f32>(0.5) + 0.4 * hn * f);
}
/** a child's hash from its parent's and its index (0/1 per axis) */
fn sc3Key(parent: u32, c: vec2<i32>, l: i32) -> u32 {
  return shH3(bitcast<i32>(parent), c.x + 2 * c.y, 7919 + l);
}
/** dbg (diagnostics, ?cliffDbg=, 0 off): 1 the finest level D, 2 the hit's level, 3 the hit's kind (0 top, 1 side through
 *  an x face, 2 through a y face, 3 the start cell traced back, 4 a miss, 5 the iteration cap), 4 the hit's level-0 top
 *  in half cells mod 6 (pixels disagreeing about one cell's top show as different colours in it), 5 no edge lines, tint
 *  or occlusion (lighting only), 6 no edge lines, 7 no darkening by depth along the ray, 8 (draw.wgsl) a fill on faces */
fn shCol3(si: ShadeIn, k: i32, steps: i32, drop: u32, pxAng: f32, pxT: f32, dbg: u32, dropF: f32, hnz: f32, sink: f32, patchP: f32, gap: f32, gapD: u32) -> ShCol {
  let ng = si.ng;
  var r = ShCol(0.0, ng, 1.0, 1.0, false, -1);
  if (ng.z < -0.01) { return r; }
  // a level-0 cell in pixels, by the distance alone
  let cellPx = ldexp(1.0, k) / max(si.distW * pxAng, 1e-30);
  let w = shSteep(ng, si.cliff) * clamp(log2(cellPx) - 1.6, 0.0, 1.0);
  if (w <= 0.0) { return r; }
  // the finest level and its share
  let lf = clamp(log2(cellPx / max(pxT, 1.0)), 0.0, f32(SC3_LCAP));
  let li = i32(floor(lf));
  let fr = lf - f32(li);
  let D = select(li, li + 1, fr > 0.0 && li < SC3_LCAP);
  let ampD = select(1.0, fr, D > li);
  let p = si.p;
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
  let okx = abs(v.x) > 1e-6;
  let oky = abs(v.y) > 1e-6;
  // per level: the column top, the cell's bounds (level-0 cells from the start cell's corner), its hash, its child index
  var tops: array<f32, 6>;
  var blo: array<vec2<f32>, 6>;
  var bhi: array<vec2<f32>, 6>;
  var key: array<u32, 6>;
  var cid: array<vec2<i32>, 6>;
  var l = 0;
  var rc = vec2<i32>(0);
  key[0] = shH3(c0.x, c0.y, 5099);
  blo[0] = vec2<f32>(0.0);
  bhi[0] = vec2<f32>(1.0);
  tops[0] = sc3Top0(key[0], rc, p0, gn, zAbs, drop);
  // (the slow mask of the current level-0 cell: scales the fine drops and the sink and gap shares)
  var mask0 = sc3Mask(c0, rc, patchP);
  var t = 0.0;
  var crossed = false;
  var hit = false;
  var hn = vec3<f32>(0.0, 0.0, 1.0);
  var n0 = 0;
  // (diagnostics: the steps taken; the start cell traced back)
  var its = 0;
  var back = false;
  // (the notch: inside one, the cells still to pass and its z-range)
  var inRec = false;
  var recLeft = 0;
  var recR = vec2<f32>(0.0);
  for (var it = 0; it < SC3_ITER; it++) {
    its = it + 1;
    let lo = blo[l];
    let hi = bhi[l];
    let sz = min(hi.x - lo.x, hi.y - lo.y);
    let T = tops[l];
    let z = v.z * t;
    let tx = select(1e30, (select(lo.x, hi.x, v.x >= 0.0) - p0.x) / v.x, okx);
    let ty = select(1e30, (select(lo.y, hi.y, v.y >= 0.0) - p0.y) / v.y, oky);
    let tExit = min(tx, ty);
    var down = false;
    if (z < T - 1e-4 * sz) {
      // inside this cell's column: a hit at the finest level (unless a notch lets the ray through), else into the children
      var through = false;
      if (l >= D && crossed && gap > 0.0) {
        if (!inRec) {
          let gr = sc3Gap(key[l], ldexp(1.0, -l), T, z, gap * mask0);
          if (gr.x < gr.y) {
            let dd = i32(shH3(bitcast<i32>(key[l]), i32(gr.z), 3571) % (gapD + 1u));
            if (dd > 0) {
              inRec = true;
              recLeft = dd;
              recR = gr.xy;
            }
          }
        }
        if (inRec && recLeft > 0) {
          // through this cell of the notch, unless the ray leaves the notch's z-range inside it (its floor or ceiling)
          recLeft -= 1;
          through = true;
          let zE = v.z * tExit;
          if (v.z < 0.0 && zE < recR.x) {
            t = recR.x / v.z;
            hn = vec3<f32>(0.0, 0.0, 1.0);
            hit = true;
            break;
          }
          if (v.z > 0.0 && zE > recR.y) {
            t = recR.y / v.z;
            hn = vec3<f32>(0.0, 0.0, -1.0);
            hit = true;
            break;
          }
        }
      }
      if (l >= D && !through) {
        hit = true;
        if (!crossed) {
          back = true;
          // (the start: back along the ray to the cell's top or the face it came through)
          let bx = select(1e30, select(hi.x - p0.x, p0.x - lo.x, v.x >= 0.0) / abs(v.x), okx);
          let by = select(1e30, select(hi.y - p0.y, p0.y - lo.y, v.y >= 0.0) / abs(v.y), oky);
          let bt = select(1e30, T / -v.z, v.z < 0.0);
          if (bt <= min(bx, by)) {
            t = -bt;
            hn = vec3<f32>(0.0, 0.0, 1.0);
          } else if (bx < by) {
            t = -bx;
            hn = vec3<f32>(-f32(sx), 0.0, 0.0);
          } else {
            t = -by;
            hn = vec3<f32>(0.0, -f32(sy), 0.0);
          }
        }
        break;
      }
      down = l < D;
    } else if (v.z < 0.0) {
      // falling onto this cell's top inside it
      let tt = t + (T - z) / v.z;
      if (tt <= tExit) {
        t = tt;
        if (l >= D) {
          hit = true;
          hn = vec3<f32>(0.0, 0.0, 1.0);
          break;
        }
        down = true;
      }
    }
    if (down) {
      // into the child the ray is in (split at the parent's hashed fraction)
      let pp = p0 + v.xy * (t + 1e-4 * sz);
      let spl = sc3Split(lo, hi, key[l], hnz);
      let c = vec2<i32>(select(0, 1, pp.x >= spl.x), select(0, 1, pp.y >= spl.y));
      let ch = vec2<bool>(c.x == 1, c.y == 1);
      l += 1;
      blo[l] = select(lo, spl, ch);
      bhi[l] = select(spl, hi, ch);
      cid[l] = c;
      key[l] = sc3Key(key[l - 1], c, l);
      tops[l] = tops[l - 1] - select(1.0, ampD, l == D) * mask0 * sc3Drop(key[l], l, drop, dropF, sink * mask0);
      continue;
    }
    // across the face to the neighbour: the sibling inside the same parent, else up a level and try again; at level 0
    // the next grid cell
    t = tExit;
    crossed = true;
    let isX = tx < ty;
    let sg = select(sy, sx, isX);
    hn = select(vec3<f32>(0.0, -f32(sy), 0.0), vec3<f32>(-f32(sx), 0.0, 0.0), isX);
    var moved = false;
    for (var u = 0; u < SC3_LCAP; u++) {
      if (l == 0) { break; }
      let ca = select(cid[l].y, cid[l].x, isX);
      if ((sg > 0 && ca == 0) || (sg < 0 && ca == 1)) {
        // the sibling: the other side of the parent's split on this axis
        let spl = sc3Split(blo[l - 1], bhi[l - 1], key[l - 1], hnz);
        let nc = 1 - ca;
        var c = cid[l];
        var nlo = blo[l];
        var nhi = bhi[l];
        if (isX) {
          c.x = nc;
          nlo.x = select(blo[l - 1].x, spl.x, nc == 1);
          nhi.x = select(spl.x, bhi[l - 1].x, nc == 1);
        } else {
          c.y = nc;
          nlo.y = select(blo[l - 1].y, spl.y, nc == 1);
          nhi.y = select(spl.y, bhi[l - 1].y, nc == 1);
        }
        cid[l] = c;
        blo[l] = nlo;
        bhi[l] = nhi;
        key[l] = sc3Key(key[l - 1], c, l);
        tops[l] = tops[l - 1] - select(1.0, ampD, l == D) * mask0 * sc3Drop(key[l], l, drop, dropF, sink * mask0);
        moved = true;
        break;
      }
      l -= 1;
    }
    if (!moved) {
      n0 += 1;
      if (n0 > steps) { break; }
      rc += select(vec2<i32>(0, sy), vec2<i32>(sx, 0), isX);
      blo[0] = vec2<f32>(rc);
      bhi[0] = vec2<f32>(rc) + vec2<f32>(1.0);
      key[0] = shH3(c0.x + rc.x, c0.y + rc.y, 5099);
      tops[0] = sc3Top0(key[0], rc, p0, gn, zAbs, drop);
      mask0 = sc3Mask(c0, rc, patchP);
    }
  }
  if (!hit) {
    r.miss = true;
    if (dbg == 3u) { r.dbg = select(4, 5, its >= SC3_ITER && n0 <= steps); }
    if (dbg == 1u) { r.dbg = D; }
    return r;
  }
  if (dbg == 1u) { r.dbg = D; }
  if (dbg == 2u) { r.dbg = l; }
  if (dbg == 3u) { r.dbg = select(select(select(2, 1, abs(hn.x) > 0.5), 0, hn.z > 0.5), 3, back); }
  if (dbg == 4u) { r.dbg = i32(round((tops[0] + zAbs) * 2.0)) % 6 + 6; }
  // (4c, NS-256) 9 the hit cell's hash mod 6 (one colour over many pixels = one cell), 10 |t| along the ray in quarter
  // level-0 cells (0..5), 11 level-0 cells crossed (0..5), 12 march steps / 8 (0..5), 13 the hit's depth under its cell's
  // top in that cell's widths (0..5); 14, 15 below
  if (dbg == 9u) { r.dbg = i32(key[l] % 6u); }
  if (dbg == 10u) { r.dbg = min(i32(abs(t) * 4.0), 5); }
  if (dbg == 11u) { r.dbg = min(n0, 5); }
  if (dbg == 12u) { r.dbg = min(its / 8, 5); }
  if (dbg == 13u) { r.dbg = clamp(i32((tops[l] - v.z * t) / max(min(bhi[l].x - blo[l].x, bhi[l].y - blo[l].y), 1e-6)), 0, 5); }
  // ---- the hit, as version 2, at the hit's level; the finest level's lines and tint grown in by its share
  // (the hit cell's extent along the face's tangent: cells have hashed widths with ?cliffHN=)
  let xFace = abs(hn.x) > 0.5;
  let sz = select(bhi[l].x - blo[l].x, bhi[l].y - blo[l].y, xFace);
  let lpx = cellPx * sz;
  let share = select(1.0, ampD, l == D && D > li) * select(1.0, 0.0, dbg == 5u);
  let hp = p0 + v.xy * t;
  // (the vertical edge lines, the owner's rule: a fixed 5 % of the cell's width each side of the edge, never widened to a
  // pixel; their strength fades to zero as the cell's on-screen width, squeezed by the view's plan angle to the face
  // (x sqrt(1 - (v . tangent)^2)), falls from 24 to 12 px; the finest level's also carry its share. The diagnosis
  // (?cliffDbg=6): lines a pixel wide on cells squeezed to 1-3 px were the dark gaps between columns, NS-252)
  let vt = select(v.x, v.y, xFace);
  let lpxF = lpx * sqrt(max(1.0 - vt * vt, 0.0));
  let lw = 0.05;
  let fa = clamp((select(hp.x, hp.y, xFace) - select(blo[l].x, blo[l].y, xFace)) / max(sz, 1e-6), 0.0, 1.0);
  let lineOn = smoothstep(12.0, 24.0, lpxF);
  // (a notch's floor or ceiling is flat: no lines, no rim)
  let isFlat = abs(hn.z) > 0.5;
  let edge = share * lineOn * select(1.0 - smoothstep(0.5 * lw, lw, min(fa, 1.0 - fa)), 0.0, isFlat || dbg == 6u);
  let rim = select((1.0 - smoothstep(lw, lw + 0.08, (tops[l] - v.z * t) / sz)) * (1.0 - edge), 0.0, isFlat || inRec);
  let jl = f32(shH3(bitcast<i32>(key[l]), 40503, 31) & 1023u) / 1023.0;
  let jp = f32(shH3(bitcast<i32>(key[max(l - 1, 0)]), 40503, 31) & 1023u) / 1023.0;
  let j = mix(jp, jl, share);
  r.w = w;
  r.n = hn;
  r.tint = select((0.80 + 0.32 * j) * (1.0 - 0.55 * edge) * (1.0 + 0.2 * rim), 1.0, dbg == 5u);
  // (inside or at the back of a notch: recessed, a further 0.6 on the depth darkening)
  let recess = select(1.0, 0.6, inRec);
  r.ao = select((1.0 - 0.6 * edge) * recess * select(mix(1.0, 0.5, smoothstep(0.0, 1.0, abs(t))), 1.0, dbg == 7u), 1.0, dbg == 5u);
  // (4c) 14 the columns' weight w in sixths, 15 the occlusion ao in sixths
  if (dbg == 14u) { r.dbg = min(i32(w * 6.0), 5); }
  if (dbg == 15u) { r.dbg = min(i32(r.ao * 6.0), 5); }
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
  // (round 31, the columns' fill: a half-Lambert share of the sun, so faces turned from it are not near black)
  if (si.colFill > 0.0) {
    let hl = 0.5 + 0.5 * dot(n, sun);
    c += albL * sunC * (si.colFill * hl * hl);
  }
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
