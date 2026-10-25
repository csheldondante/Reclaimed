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
  /** its landform (round 78, landforms.ts; 0xffffffff water), the landform's tier (0 lowland, 1 upland,
   *  2 plateau, 3 massif), a massif's peak above its level and how far in from its edge it peaks */
  lf: u32,
  tier: u32,
  peak: f32,
  rise: f32,
}

const TIER_PLATEAU: u32 = 2u;
const TIER_MASSIF: u32 = 3u;

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
/** a plateau's edge where it meets another landform (round 78, mesaEdge) */
const EDGE_MESA: u32 = 7u;
/** how far either side of a mesa's border its ravines, spurs and buttes reach */
const MESA_REACH: f32 = 110.0;

@group(0) @binding(20) var<storage, read> regionR: array<u32>;
/** x distance to the region's border (world units), y signed distance to the coast (+ land), z the region across (bits),
 *  w the distance into its landform (round 78) */
@group(0) @binding(21) var<storage, read> distR: array<vec4<f32>>;
@group(0) @binding(22) var<storage, read> regs: array<Region>;
@group(0) @binding(23) var<storage, read> pat: array<f32>;
// the rivers (round 69, rivers.ts): per texel its nearest node + 1 (0: none, JFA), and the nodes
struct RiverNode {
  x: f32,
  y: f32,
  level: f32,
  width: f32,
  next: u32,
  /** 1: lava */
  flags: u32,
  depth: f32,
  _p: f32,
}
// (one buffer: n² words of nearest node + 1, then the nodes, 8 words each — binding 26 is the coarse world's)
@group(0) @binding(25) var<storage, read> riverBuf: array<u32>;
// (round 78: the impact craters sit between the two — atlas.ts CRATER_BLOCK)
const CRATER_WORDS: u32 = 8u;
const CRATER_BLOCK: u32 = 4u + 64u * CRATER_WORDS;
fn riverNode(i: u32) -> RiverNode {
  let o = AP.n * AP.n + CRATER_BLOCK + i * 8u;
  return RiverNode(bitcast<f32>(riverBuf[o]), bitcast<f32>(riverBuf[o + 1u]), bitcast<f32>(riverBuf[o + 2u]), bitcast<f32>(riverBuf[o + 3u]), riverBuf[o + 4u], riverBuf[o + 5u], bitcast<f32>(riverBuf[o + 6u]), 0.0);
}

// the coarse world (round 71, coarse.wgsl CCell): what has changed from the atlas, cell by cell
struct CoarseCell {
  s: vec4<f32>,
  l: vec4<f32>,
}
@group(0) @binding(26) var<storage, read> coarse: array<CoarseCell>;

struct Co {
  /** rock added (+) or taken (−), loose ground on top, water, lava */
  dr: f32,
  loose: f32,
  water: f32,
  lava: f32,
  /** the loose ground's material, what added rock is made of (the nearest cell's) */
  lmat: u32,
  cap: u32,
}

/** the coarse world at p: bilinear between its cells' middles (it wraps) */
fn coarseAt(p: vec2<f32>) -> Co {
  let cn = u32(round(sqrt(f32(arrayLength(&coarse)))));
  let t = torusU(p) * f32(cn) - 0.5;
  let i0 = vec2<i32>(floor(t));
  let f = t - floor(t);
  var o: Co;
  var best = -1.0;
  for (var k = 0; k < 4; k++) {
    let o2 = vec2<i32>(k & 1, k >> 1);
    let w2 = wrapi(i0 + o2, vec2<i32>(i32(cn)));
    let c = coarse[u32(w2.y) * cn + u32(w2.x)];
    let wt = select(1.0 - f.x, f.x, o2.x == 1) * select(1.0 - f.y, f.y, o2.y == 1);
    o.dr += c.s.x * wt;
    o.loose += c.s.y * wt;
    o.water += c.s.z * wt;
    o.lava += c.l.x * wt;
    if (wt > best && c.s.y > 0.01) {
      best = wt;
      o.lmat = u32(c.l.z);
    }
    if (c.l.w > 0.5 && wt > 0.25) { o.cap = u32(c.l.w); }
  }
  return o;
}

/**
 * The impact craters' relief at p (round 78, atlas.ts makeCraters): a bowl, a raised rim, the ejecta
 * thinning outward, a central peak in the big ones (the coarse world's meteor, coarse.wgsl, the same
 * shape at its own scale).
 */
struct Stamped {
  /** the height added (craters summed, the oddities' highest over the ground), and the material where an
   *  oddity stands (0: none) */
  dh: f32,
  mat: u32,
}

fn craterAt(p: vec2<f32>) -> f32 { return stampsAt(p).dh; }

/** the craters' shape, each its bowl −1 deep (the continent's noise takes it: atlas build.wgsl base) */
fn craterShape(p: vec2<f32>) -> f32 { return stampSum(p, true).dh; }

fn stampsAt(p: vec2<f32>) -> Stamped { return stampSum(p, false); }

/** an oddity's height at p (atlas.ts STAMP): a faceted crystal (its faces planes to its point), a bulb */
fn oddityAt(o: u32, p: vec2<f32>, kind: u32) -> f32 {
  let c = nearTo(vec2<f32>(bitcast<f32>(riverBuf[o]), bitcast<f32>(riverBuf[o + 1u])), p);
  let R = bitcast<f32>(riverBuf[o + 2u]);
  let H = bitcast<f32>(riverBuf[o + 3u]);
  let d = p - c;
  if (dot(d, d) > R * R * 1.5) { return 0.0; }
  if (kind == 3u) {
    // a field of facets (the user: "large voronoi facets raised slightly deeper in"): the ground broken into
    // cells, each a tilted plane, higher toward the field's middle, a crack between each two
    let cs = bitcast<f32>(riverBuf[o + 5u]);
    let sd = u32(bitcast<f32>(riverBuf[o + 4u])) + AP.seed;
    let wr = pworley(d / cs + 4096.0, vec2<i32>(1 << 16), 0.85, sd);
    let site = (wr.near - 4096.0) * cs;
    let rr = length(site) / R;
    if (rr >= 1.0) { return 0.0; }
    let hh = hf(pcg(wr.id ^ sd));
    let ta = hf(pcg(wr.id * 5u + sd)) * 6.2831853;
    let tilt = vec2<f32>(cos(ta), sin(ta)) * H * (0.25 + 0.35 * hh) / cs;
    let crack = 1.0 - smoothstep(0.0, 0.07, wr.f2 - wr.f1);
    let v = H * (1.0 - rr * rr) * (0.55 + 0.45 * hh) + dot(d - site, tilt) - crack * H * 0.12;
    return max(v, 0.0);
  }
  if (kind == 1u) {
    // the faces: a pyramid of n planes (the farthest plane is the face p is on)
    let turn = bitcast<f32>(riverBuf[o + 4u]);
    let nf = bitcast<f32>(riverBuf[o + 5u]);
    var e = 0.0;
    for (var f = 0.0; f < nf; f += 1.0) {
      let a = turn + f * 6.2831853 / nf;
      e = max(e, dot(d, vec2<f32>(cos(a), sin(a))));
    }
    return H * max(0.0, 1.0 - e / R);
  }
  // a bulb: a dome, its outline lobed, swelling steep at its foot
  let lobe = bitcast<f32>(riverBuf[o + 4u]);
  let ang = atan2(d.y, d.x);
  let rr = length(d) / (R * (1.0 + 0.18 * lobe * sin(ang * 3.0 + lobe * 9.0) + 0.1 * sin(ang * 5.0 + 1.3)));
  if (rr >= 1.0) { return 0.0; }
  return H * pow(1.0 - rr * rr, 0.35);
}

fn stampSum(p: vec2<f32>, unit: bool) -> Stamped {
  let base = AP.n * AP.n;
  let k = min(riverBuf[base], 64u);
  var dh = 0.0;
  var odd = 0.0;
  var mat = 0u;
  for (var i = 0u; i < k; i++) {
    let o = base + 4u + i * CRATER_WORDS;
    let kind = riverBuf[o + 6u];
    if (kind != 0u) {
      if (unit) { continue; }
      let v = oddityAt(o, p, kind);
      if (v > odd) {
        odd = v;
        mat = riverBuf[o + 7u];
      }
      continue;
    }
    let c = nearTo(vec2<f32>(bitcast<f32>(riverBuf[o]), bitcast<f32>(riverBuf[o + 1u])), p);
    let R = bitcast<f32>(riverBuf[o + 2u]);
    var r = length(p - c);
    if (r > R * 2.4) { continue; }
    // (no perfect circles: the distance warped by a noise at the crater's own scale — slumped walls,
    // a rim broken in places)
    let wu = torusU(p) + f32(i) * 0.137;
    r *= 1.0 + 0.16 * pfbm(wu, perOf(R * 0.7), 3u, AP.seed + 401u);
    var D = bitcast<f32>(riverBuf[o + 3u]);
    let rim = bitcast<f32>(riverBuf[o + 4u]);
    var pk = bitcast<f32>(riverBuf[o + 5u]);
    if (unit) {
      pk = pk / max(D, 1e-3);
      D = 1.0;
    }
    // (the bowl flat-bottomed, its wall steepest under the rim)
    let t = r / R;
    var h = -D * (1.0 - smoothstep(0.55, 1.0, t));
    h += D * 0.35 * rim * exp(-pow((t - 1.0) / 0.12, 2.0));
    h += D * 0.08 * rim * smoothstep(2.2, 1.0, t) * step(1.0, t);
    h += pk * exp(-pow(t / 0.12, 2.0));
    dh += h;
  }
  return Stamped(dh + odd, select(0u, mat, odd > 1.5));
}

struct River {
  on: bool,
  /** distance from the river's line, in its half-widths */
  x: f32,
  level: f32,
  w: f32,
  depth: f32,
  flags: u32,
}

/** q moved by whole turns of the torus to be nearest p */
fn nearTo(q: vec2<f32>, p: vec2<f32>) -> vec2<f32> {
  let W = vec2<f32>(AP.worldW, AP.worldH);
  let d = q - p;
  return p + d - round(d / W) * W;
}

/** the nearest river at p: of the segments from the nodes nearest the four texels round it to their next */
fn riverAt(p: vec2<f32>) -> River {
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
    let pa = nearTo(vec2<f32>(a.x, a.y), p);
    let pb = nearTo(vec2<f32>(b.x, b.y), pa);
    let ab = pb - pa;
    let l2 = dot(ab, ab);
    var s = 0.0;
    if (l2 > 1e-6) { s = clamp(dot(p - pa, ab) / l2, 0.0, 1.0); }
    let w = mix(a.width, b.width, s);
    let x = length(p - (pa + ab * s)) / w;
    if (x < r.x) {
      r.on = true;
      r.x = x;
      r.level = mix(a.level, b.level, s);
      r.w = w;
      r.depth = mix(a.depth, b.depth, s);
      r.flags = a.flags & b.flags;
      if (a.flags == 1u && s < 0.5) { r.flags = 1u; }
    }
  }
  return r;
}

struct Macro {
  a: u32,
  b: u32,
  s: f32,
  coast: f32,
  /** the distance into the landform (bilinear: near a landform's border both sides are near 0) */
  dl: f32,
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
  var l: array<f32, 4>;
  var r: array<u32, 4>;
  for (var k = 0; k < 4; k++) {
    let j = texIdxW(i0 + vec2<i32>(k & 1, k >> 1));
    let d = distR[j];
    r[k] = regionR[j];
    s[k] = select(-d.x, d.x, r[k] == m.a);
    c[k] = d.y;
    l[k] = min(d.w, 1e5);
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
  m.dl = mix(mix(l[0], l[1], f.x), mix(l[2], l[3], f.x), f.y);
  return m;
}

fn isLand(r: Region) -> bool { return (r.flags & 1u) != 0u; }

struct RH {
  h: f32,
  /** its pattern's value here */
  pv: f32,
}

/** a region's own ground at p (as if it went on past its borders); dl: the distance into its landform */
fn regionHeight(r: Region, p: vec2<f32>, coast: f32, dl: f32) -> RH {
  let u = torusU(p);
  var h = AP.sea + r.base;
  if (isLand(r)) {
    // the continent slopes down to the sea all the way across (round 78: the coast's SDF; rivers, found
    // on this ground by a priority flood, run down it)
    h += AP.lift * smoothstep(0.0, AP.liftReach, coast);
    // a massif rises from its edge to its peaks (round 78), along ridges
    if (r.tier == TIER_MASSIF) {
      let rd = pridged(u, perOf(r.rise * 0.9), 4u, AP.seed + 303u);
      h += r.peak * smoothstep(0.0, r.rise, dl) * (0.4 + 0.6 * rd);
    }
  } else {
    h -= r.depth * smoothstep(0.0, 260.0, -coast);
  }
  // (the world's own noise, at the region's scale and amplitude: regions alike meet without a seam)
  // (round 78: on the landforms each region's own noise and pattern are detail, AP.detail of them)
  h += AP.detail * r.rough * pfbm(u, perOf(r.scale), 5u, AP.seed + 101u);
  if (r.ridge > 0.0) {
    h += AP.detail * r.ridge * pridged(u, perOf(r.scale * 1.6), 5u, AP.seed + 202u);
  }
  var pv = 0.0;
  if (r.pattern != 0u) {
    pv = pattern(r.pattern, p, r.patScale, r.seed);
    h += AP.detail * r.patAmp * pv;
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
  /** a river: its level (−1: none), the distance from its line in half-widths, 1 lava */
  rl: f32,
  rx: f32,
  rflags: u32,
  /** the coarse world here (coarseAt): loose ground on top and its material, water, lava, what added rock is */
  loose: f32,
  lmat: u32,
  cw: f32,
  clava: f32,
  cap: u32,
  /** the distance into its landform (round 78) */
  dl: f32,
  /** an oddity's material where one stands (round 78; 0: none) */
  smat: u32,
  /** an overhang at a mesa's edge (round 78): the lip's top (0: none — an undercut), the open under it
   *  (floor, roof; none when roof ≤ floor) */
  ov: vec3<f32>,
}

struct Mesa {
  /** the high side's weight */
  w: f32,
  /** a ravine's floor, risen toward its head */
  rise: f32,
  /** the distance onto the high side from the cliff's foot, and the ledge's width (the upper wall at x = L) */
  x: f32,
  L: f32,
  /** the ledge's height, a fraction of the drop */
  f: f32,
  /** in a ravine (1) */
  rav: f32,
  /** talus: the loose ground piled at the walls' feet and round the buttes */
  tal: f32,
}

/**
 * A plateau's edge (round 78, the user: "the boundary should probably use ridge noise to cut ravines into
 * the border so it's not so flat and there are places from the ground to run between the cliffs … butes
 * that stick out and intermediary ledges and overhangs"). sh: the distance onto the high side from the
 * border. The zero lines of a noise cut ravines back into it, tapering to their heads, their floors rising;
 * spurs push it out; the drop is two walls with a ledge between (it narrows to none in places); buttes
 * stand off it on the low side, flat-topped, shorter farther out.
 */
fn mesaEdge(u: vec2<f32>, sh: f32, drop: f32) -> Mesa {
  var o: Mesa;
  let sp = 34.0 * smoothstep(0.1, 0.4, pfbm(u, perOf(130.0), 2u, AP.seed + 611u));
  let on = smoothstep(-0.35, -0.05, pfbm(u, perOf(420.0), 2u, AP.seed + 615u));
  let depth = 95.0 * on;
  let taper = clamp(1.0 - max(sh, 0.0) / max(depth, 1.0), 0.0, 1.0);
  let rn = pfbm(u, perOf(140.0), 3u, AP.seed + 612u);
  o.rav = (1.0 - smoothstep(0.0, 0.13 * taper + 1e-4, abs(rn))) * on * step(0.001, taper);
  o.x = sh + sp - depth * o.rav;
  // the steps (the user: "more step variety in height on the cliffs"): four walls, each its share of the
  // drop and the ledge before it by a noise along the edge — a share near none merges two walls, a ledge
  // near none stacks them; the shares and widths change smoothly, so steps come and go along the edge
  var sh4 = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  var xw = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  var tot = 0.0;
  var xa = 0.0;
  for (var k = 0u; k < 4u; k++) {
    sh4[k] = max(0.0, pfbm(u, perOf(150.0 - 25.0 * f32(k)), 2u, AP.seed + 613u + k * 7u) + 0.2) + 0.02;
    tot += sh4[k];
    if (k > 0u) { xa += max(0.0, 30.0 * pfbm(u, perOf(95.0 - 12.0 * f32(k)), 2u, AP.seed + 614u + k * 7u) + 3.0); }
    xw[k] = xa;
  }
  o.w = 0.0;
  for (var k = 0u; k < 4u; k++) {
    sh4[k] /= tot;
    o.w += sh4[k] * smoothstep(-1.2, 1.2, o.x - xw[k]);
  }
  o.f = sh4[0];
  o.L = xw[3];
  // the rim and the foot (the user: "the height at the top and bottom should have noise and fade up to the
  // full height"): the top lower at its edge, rising to the full height inland, rough; the ground at the
  // foot rising to the wall (a pediment, under the talus), rough
  let xt = o.x - o.L;
  let D = 25.0 + 55.0 * (0.5 + 0.5 * pfbm(u, perOf(110.0), 2u, AP.seed + 625u));
  let rim = (0.05 + 0.12 * (0.5 + 0.5 * pfbm(u, perOf(80.0), 2u, AP.seed + 626u))) * (1.0 - smoothstep(0.0, D, max(xt, 0.0)));
  let rough = pfbm(u, perOf(22.0), 3u, AP.seed + 627u);
  o.w -= smoothstep(-1.2, 1.2, xt) * (rim - 0.04 * rough * (1.0 - smoothstep(0.0, D, max(xt, 0.0))));
  if (o.x < 0.0) {
    let fade = 1.0 - smoothstep(0.0, D * 0.8, -o.x);
    o.w += fade * (0.04 + 0.05 * (0.5 + 0.5 * pfbm(u, perOf(90.0), 2u, AP.seed + 628u)) + 0.02 * rough);
  }
  o.rise = drop * 0.3 * o.rav * clamp(sh / max(depth, 1.0), 0.0, 1.0);
  if (o.x < -2.0) {
    let per = perOf(46.0);
    let wr = pworley(u * f32(per), vec2<i32>(per), 0.8, AP.seed + 616u);
    let hh = hf(pcg(wr.id ^ (AP.seed * 0x9e3779b9u)));
    if (hh < 0.4) {
      let rad = (0.16 + 0.2 * hf(pcg(wr.id * 7u + 3u))) * smoothstep(-MESA_REACH * 0.95, -MESA_REACH * 0.3, o.x);
      let bw = smoothstep(rad + 0.035, rad - 0.035, wr.f1) * (0.55 + 0.45 * hf(pcg(wr.id * 13u + 5u)));
      o.w = max(o.w, bw);
      // (a butte's own apron of talus)
      if (wr.f1 > rad) { o.tal = max(0.0, min(bw * drop * 0.2, 18.0) - 0.8 * (wr.f1 - rad) * 46.0); }
    }
  }
  // talus (the user: "pile up sand or dirt along the base and then have rocks in it … cliffs erode and debris
  // collects and slopes at the base"): an apron sloping off each wall's foot (an SDF of the wall, its height
  // a fifth of the wall's, varying along it), lumpy; thinner in the ravines
  let tn = 0.55 + 0.45 * (0.5 + 0.5 * pfbm(u, perOf(40.0), 2u, AP.seed + 621u));
  if (o.x < 0.0) { o.tal = max(o.tal, min(sh4[0] * drop * 0.2, 26.0) * tn - 0.8 * (-o.x)); }
  for (var k = 1u; k < 4u; k++) {
    if (o.x > xw[k - 1u] + 1.2 && o.x < xw[k] - 1.2) { o.tal = max(o.tal, min(sh4[k] * drop * 0.2, 20.0) * tn - 0.8 * (xw[k] - o.x)); }
  }
  if (o.tal > 0.0) { o.tal = max(0.0, o.tal + 1.2 * pfbm(u, perOf(9.0), 2u, AP.seed + 622u)) * (1.0 - 0.7 * o.rav); }
  return o;
}

/**
 * A great cavern under a plateau or a massif (round 78: "a massive cave under mountains"): deep inside the
 * landform (by the distance into it) where a slow noise says, its floor near the sea's level, its roof
 * domed under the rock kept over it, columns of rock left standing in it. (floor, roof): none when roof ≤ floor.
 */
fn cavernAt(p: vec2<f32>, g: Ground) -> vec2<f32> {
  let A = regs[g.a];
  if (!isLand(A) || A.tier < TIER_PLATEAU) { return vec2<f32>(0.0); }
  let u = torusU(p);
  let m = smoothstep(0.02, 0.3, pfbm(u, perOf(700.0), 3u, AP.seed + 501u)) * smoothstep(120.0, 360.0, g.dl);
  if (m <= 0.0) { return vec2<f32>(0.0); }
  // (pillars: the columns where a fine noise peaks stay rock)
  if (pfbm(u, perOf(26.0), 2u, AP.seed + 504u) > 0.42) { return vec2<f32>(0.0); }
  let fl = AP.sea + 4.0 + 6.0 * pfbm(u, perOf(90.0), 2u, AP.seed + 502u);
  let dome = (30.0 + 70.0 * m) * sqrt(m) * (0.7 + 0.3 * pfbm(u, perOf(60.0), 2u, AP.seed + 503u));
  let roof = min(fl + dome, g.h - 28.0);
  if (roof - fl < 4.0) { return vec2<f32>(0.0); }
  return vec2<f32>(fl, roof);
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
  var hiA = true;
  var hiRock = 0u;
  var talus = 0.0;
  if (isLand(A) != isLand(B)) {
    var L = B;
    if (isLand(A)) {
      L = A;
    }
    kind = L.coastEdge;
    ew = L.edgeW;
    ed = L.edgeD;
  } else if (A.lf != B.lf) {
    // two landforms meet (round 78): the higher one's edge — a plateau's a cliff, a massif's a wide rise
    var H = B;
    hiA = false;
    if (A.base > B.base) {
      H = A;
      hiA = true;
    }
    kind = H.edge;
    ew = H.edgeW;
    ed = H.edgeD;
    hiRock = H.rockMat;
    if (H.tier == TIER_PLATEAU) {
      kind = EDGE_MESA;
      ew = MESA_REACH;
    } else if (H.tier == TIER_MASSIF) {
      kind = EDGE_SMOOTH;
      ew = max(ew, 50.0);
    }
  } else {
    let aWins = A.prio > B.prio || (A.prio == B.prio && m.a < m.b);
    var E = B;
    if (aWins) {
      E = A;
    }
    kind = E.edge;
    ew = E.edgeW;
    ed = E.edgeD;
    // (round 78: inside one landform a region's border is no cliff or step — the landform's edges are the
    // cliffs; ravines and walls stay, features of their own)
    if (kind == EDGE_CLIFF || kind == EDGE_TERRACE) { kind = EDGE_SMOOTH; }
  }
  let s = m.s;
  // the two regions' heights in a loop the compiler can't unroll (its bound isn't known):
  // regionHeight, and the pattern bank in it, compiled once
  let both = m.a != m.b && s <= ew * 1.05 + 3.0;
  let nr = select(1u, 2u, both);
  var hs = array<f32, 2>(0.0, 0.0);
  for (var k = 0u; k < nr; k++) {
    let rk = regs[select(m.b, m.a, k == 0u)];
    // (the distance into B's landform: A's own where they're one landform; at another's edge, ~0)
    let rh = regionHeight(rk, p, m.coast, select(0.0, m.dl, rk.lf == A.lf));
    hs[k] = rh.h;
    if (k == 0u) { g.pv = rh.pv; }
  }
  let hA = hs[0];
  g.s = s;
  g.dl = m.dl;
  g.hlo = hA;
  g.ov = vec3<f32>(0.0);
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
      case EDGE_MESA: {
        let hHi = select(hB, hA, hiA);
        let hLo = select(hA, hB, hiA);
        let drop = max(hHi - hLo, 0.0);
        // (the jitter odd under swapping the pair, as the distance is: the same line from both sides)
        let me = mesaEdge(u, select(-1.0, 1.0, hiA) * (s + jit), drop);
        w = select(1.0 - me.w, me.w, hiA);
        extra = (1.0 - me.w) * me.rise;
        talus = me.tal;
        // overhangs: the top wall's lip out over the ledge or the ground, the foot's wall undercut
        // (where it's tall, not in a ravine; each comes and goes along it)
        if (drop > 30.0 && me.rav < 0.05) {
          let xt = me.x - me.L;
          let lipD = min(14.0 * pfbm(u, perOf(70.0), 2u, AP.seed + 617u) + 4.0, 10.0);
          let ucD = 12.0 * pfbm(u, perOf(55.0), 2u, AP.seed + 618u) + 3.5;
          if (xt < -1.2 && xt > -lipD) {
            let T = 7.0 + 5.0 * (0.5 + 0.5 * pfbm(u, perOf(30.0), 2u, AP.seed + 619u));
            g.ov = vec3<f32>(hHi, -1.0, hHi - T);
          } else if (me.x > 1.2 && me.x < ucD && me.L > 3.0) {
            let ucH = min(5.0 + 9.0 * (0.5 + 0.5 * pfbm(u, perOf(30.0), 2u, AP.seed + 620u)), drop * me.f - 5.0);
            g.ov = vec3<f32>(0.0, hLo, hLo + ucH);
          }
        }
      }
      default: {
        w = smoothstep(-ew, ew, s);
      }
    }
    g.h = mix(hB, hA, w) + extra;
    g.w = w;
    // (a lip's open runs from the ground under it)
    if (g.ov.y < 0.0) { g.ov.y = g.h; }
    if (g.ov.z - g.ov.y < 3.0) { g.ov = vec3<f32>(0.0); }
  }
  // the impact craters and the oddities (round 78)
  let st = stampsAt(p);
  g.h += st.dh;
  g.hlo += st.dh;
  g.smat = st.mat;
  // the coarse world: rock taken or added (a crater, a cone, set lava), what lies on top
  let co = coarseAt(p);
  g.h += co.dr;
  g.hlo += co.dr;
  g.loose = co.loose;
  g.lmat = co.lmat;
  g.cw = co.water;
  g.clava = co.lava;
  g.cap = select(0u, co.cap, co.dr > 0.3);
  // a river's channel, and the valley it cuts (its sides steep, so it cuts gorges through high
  // ground); its level only falls, all at once where the ground drops away: a waterfall
  g.rl = -1.0;
  g.rx = 9.0;
  g.rflags = 0u;
  let rv = riverAt(p);
  if (rv.on && rv.x < 4.0) {
    var cut = rv.level + (rv.x - 1.0) * rv.w * 2.5;
    if (rv.x < 1.0) { cut = rv.level - rv.depth * (1.0 - rv.x * rv.x); }
    g.h = min(g.h, cut);
    g.rl = rv.level;
    g.rx = rv.x;
    g.rflags = rv.flags;
  }
  // (no overhang where a river runs or the coarse world has changed the ground)
  if (g.rx < 3.0 || abs(co.dr) > 0.3) { g.ov = vec3<f32>(0.0); }
  // a mesa's talus (round 78): loose ground — sand where it's dry, soil, patches of rubble — with boulders of
  // the cliff's rock in it (rock added, bare: the cap)
  if (talus > 0.3 && g.rx > 1.5 && abs(co.dr) < 0.3) {
    let R0 = regs[g.a];
    let pr = perOf(30.0);
    let wp = pworley(u * f32(pr), vec2<i32>(pr), 0.9, AP.seed + 623u);
    var tm = select(2u, 3u, moistureAt(p, g.coast, R0.moist) < 0.35);
    if (hf(pcg(wp.id + AP.seed)) < 0.3) { tm = 4u; }
    let pb = perOf(9.0);
    let wb = pworley(u * f32(pb), vec2<i32>(pb), 0.85, AP.seed + 624u);
    let hb = hf(pcg(wb.id ^ (AP.seed * 0x85ebca6bu)));
    var bump = 0.0;
    if (hb < 0.3 && hiRock != 0u) {
      let rad = 0.22 + 0.25 * hf(pcg(wb.id * 3u + 1u));
      bump = (talus * 0.5 + 2.0 + 4.0 * hb / 0.3) * sqrt(max(0.0, 1.0 - (wb.f1 / rad) * (wb.f1 / rad)));
    }
    if (bump > talus + 0.3) {
      g.h += bump;
      g.hlo += bump;
      g.cap = hiRock;
    } else {
      g.loose = max(g.loose, talus);
      g.lmat = tm;
    }
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
/** °C a cell up: at 0.3 most uplands snowed over at mid-latitudes; 0.12 snow for peaks and the cold; round 78:
 *  0.05, the landforms reach ~300 over the sea (at 0.12 every plateau was snowed over) */
const LAPSE: f32 = 0.05;

/** 0..1: wet at the equator and the mid-latitudes, dry in the subtropics and at the poles; wetter by the coast */
fn moistureAt(p: vec2<f32>, coast: f32, bias: f32) -> f32 {
  let lat = 1.0 - warmth(p);
  let m = 0.5 + 0.32 * cos(lat * 9.424778) + 0.25 * (1.0 - smoothstep(0.0, 500.0, coast)) + bias + 0.15 * pfbm(torusU(p), perOf(200.0), 3u, AP.seed + 43u);
  return clamp(m, 0.02, 1.0);
}
