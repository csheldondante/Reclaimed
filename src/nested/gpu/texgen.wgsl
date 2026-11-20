// ---- nested/gpu/texgen.wgsl (round 27): the tiling material textures, generated once on the GPU ----------------------
// Per material a square tile that wraps (every lattice below is periodic in the tile), as two layers of two texture arrays
// (layer = material id - 1: stone, soil, sand, clay, plants):
//   A (rgba8unorm): rgb the albedo (sRGB-encoded values, as shade.wgsl's material colours), a the roughness
//   N (rgba8unorm): rg the surface normal's x, y (0.5 + 0.5 n; the tile seen from above, u = x, v = y), b the height
//     (0..1: the taller texel wins a blend), a the cavity (1 open, 0 in a crack)
// The normal comes from the height's slope at the tile's world size, which is scale-free: the same tile drawn at two
// world sizes (draw: tex.wgsl) has the same slopes at both. texGen writes mip 0 of one layer; texMip makes mip m + 1 from
// mip m (2 x 2 mean; normals averaged as unit vectors and normalised again).
// No image files: everything here is a function of the texel and the material.

struct TexGenU {
  /** x layer (material id - 1: which material; the views bound hold that one layer), y the tile's side in texels at the
   *  mip written, z -, w the samples a texel (5: the texel and its four neighbours) */
  a: vec4<u32>,
}
@group(0) @binding(0) var<uniform> tg: TexGenU;
@group(0) @binding(1) var outA: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(2) var outN: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(3) var srcA: texture_2d_array<f32>;
@group(0) @binding(4) var srcN: texture_2d_array<f32>;

// ---- periodic lattices ------------------------------------------------------------------------------------------------
fn tgHash(c: vec2<i32>, s: u32) -> u32 {
  var h = (bitcast<u32>(c.x) * 0x8da6b343u) ^ (bitcast<u32>(c.y) * 0xd8163841u) ^ (s * 0x9e3779b9u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
fn tgH1(c: vec2<i32>, s: u32) -> f32 { return f32(tgHash(c, s) >> 8u) / 16777216.0; }
fn tgH2(c: vec2<i32>, s: u32) -> vec2<f32> {
  let h = tgHash(c, s);
  return vec2<f32>(f32(h & 0xffffu), f32(h >> 16u)) / 65535.0;
}
fn tgWrap(c: vec2<i32>, n: i32) -> vec2<i32> { return ((c % vec2<i32>(n)) + vec2<i32>(n)) % vec2<i32>(n); }
/** value noise of n cells a tile at uv (periodic), about 0..1 */
fn tgNoise(uv: vec2<f32>, n: i32, s: u32) -> f32 {
  let p = uv * f32(n);
  let i = vec2<i32>(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = tgH1(tgWrap(i, n), s);
  let b = tgH1(tgWrap(i + vec2<i32>(1, 0), n), s);
  let c = tgH1(tgWrap(i + vec2<i32>(0, 1), n), s);
  let d = tgH1(tgWrap(i + vec2<i32>(1, 1), n), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/** fractal value noise from n cells a tile, o octaves, about 0..1 */
fn tgFbm(uv: vec2<f32>, n: i32, o: i32, s: u32) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var w = 0.0;
  var m = n;
  for (var i = 0; i < o; i++) {
    v += a * tgNoise(uv, m, s + u32(i) * 31u);
    w += a;
    a *= 0.5;
    m *= 2;
  }
  return v / w;
}
/** cellular (Voronoi) of n cells a tile at uv, periodic, jitter j: x the distance to the nearest point, y to the cell's
 *  border (Quilez's exact border distance), z the nearest cell's hash (0..1); cell units */
struct Cell {
  f1: f32,
  edge: f32,
  id: f32,
  /** the nearest point's offset from uv (cell units) */
  r: vec2<f32>,
}
fn tgCell(uv: vec2<f32>, n: i32, j: f32, s: u32) -> Cell {
  let p = uv * f32(n);
  let ip = vec2<i32>(floor(p));
  let fp = p - floor(p);
  var mr = vec2<f32>(0.0);
  var mg = vec2<i32>(0);
  var md = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2<i32>(x, y);
      let o = tgH2(tgWrap(ip + g, n), s) * j + vec2<f32>(0.5 - 0.5 * j);
      let r = vec2<f32>(g) + o - fp;
      let d = dot(r, r);
      if (d < md) {
        md = d;
        mr = r;
        mg = g;
      }
    }
  }
  var ed = 8.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let g = mg + vec2<i32>(x, y);
      let o = tgH2(tgWrap(ip + g, n), s) * j + vec2<f32>(0.5 - 0.5 * j);
      let r = vec2<f32>(g) + o - fp;
      let dr = r - mr;
      if (dot(dr, dr) > 1e-5) { ed = min(ed, dot(0.5 * (mr + r), normalize(dr))); }
    }
  }
  return Cell(sqrt(md), ed, tgH1(tgWrap(ip + mg, n), s + 7u), mr);
}

// ---- the materials: height (0..1), albedo (sRGB values), roughness, cavity ---------------------------------------
struct TexS {
  h: f32,
  alb: vec3<f32>,
  rough: f32,
  cav: f32,
}
/** stone: large fractured blocks (5 a tile, warped), each its own tone and a slight tilt, sharp dark cracks between them,
 *  smaller cracks inside some (17 a tile), chipped block edges, a fine grain and specks */
fn tgStone(uv0: vec2<f32>) -> TexS {
  // (warped strongly and stretched along u: fractured blocks of uneven size and a grain to the rock, not paving)
  let wv = vec2<f32>(tgFbm(uv0, 3, 3, 11u), tgFbm(uv0 + vec2<f32>(0.37, 0.71), 3, 3, 12u)) - 0.5;
  let uv = uv0 + 0.13 * wv;
  let b = tgCell(uv, 4, 1.0, 21u);
  let s = tgCell(uv + 0.02 * wv, 14, 1.0, 22u);
  // (a second family of big joints, 9 a tile, open only in stretches: blocks of very different sizes, some split)
  let b2 = tgCell(uv + 0.05 * wv, 9, 1.0, 31u);
  let grain = tgFbm(uv0, 48, 4, 23u);
  let stain = tgFbm(uv0, 4, 4, 28u);
  let speck = tgCell(uv0, 140, 0.9, 24u);
  // (a rough, ridged surface: the rock's own relief inside a block)
  let rr = 1.0 - abs(2.0 * tgFbm(uv0, 12, 4, 32u) - 1.0);
  // (how open a stretch of crack is: some joints gape, others are hairlines or closed)
  let open = smoothstep(0.45, 0.8, tgFbm(uv, 10, 3, 29u));
  let use2 = smoothstep(0.55, 0.7, tgFbm(uv, 6, 2, 33u));
  let e = min(b.edge, mix(1.0, b2.edge, use2));
  // the block's face: its own height and a tilt, chipped near its border
  let tilt = (tgH2(vec2<i32>(i32(b.id * 9973.0), 3), 25u) - 0.5) * 0.45;
  var h = 0.68 + 0.14 * (b.id - 0.5) + dot(tilt, -b.r) + 0.08 * (b2.id - 0.5) * use2;
  h -= 0.16 * (1.0 - smoothstep(0.0, 0.16, e)) * (0.4 + 0.6 * open);
  // the crack: a sharp V a few texels wide where the joint is open, a hairline elsewhere
  let cw = mix(0.005, 0.04, open);
  // (angular facets: each small cell a plane of its own tilt, so a block's face breaks into flat faces, not a dome)
  h += 0.1 * dot(tgH2(vec2<i32>(i32(s.id * 6007.0), 5), 27u) - 0.5, -s.r);
  let crack = 1.0 - smoothstep(0.0, cw, e);
  h -= 0.5 * crack * crack * (0.3 + 0.7 * open);
  // smaller cracks inside about half the blocks, away from the big crack, thin
  let inner = select(0.0, 1.0, tgH1(vec2<i32>(i32(s.id * 7919.0), 1), 26u) < 0.5) * smoothstep(0.04, 0.1, e);
  let c2 = (1.0 - smoothstep(0.0, 0.035, s.edge)) * inner * smoothstep(0.3, 0.6, tgFbm(uv, 24, 2, 30u));
  h -= 0.16 * c2;
  h += 0.08 * (grain - 0.5) + 0.14 * (rr - 0.6);
  // colour: grey with a little warmth, blocks differing only slightly, mottling inside a block, weathering stains over
  // several blocks, the grain, specks of light and dark minerals, dark cracks
  var alb = mix(vec3<f32>(0.57, 0.55, 0.51), vec3<f32>(0.47, 0.46, 0.44), b.id * 0.5 + 0.5 * stain);
  alb *= mix(vec3<f32>(1.0), vec3<f32>(1.06, 0.97, 0.88), smoothstep(0.45, 0.8, stain));
  alb *= 0.8 + 0.22 * grain + 0.18 * tgFbm(uv0, 16, 3, 34u);
  let sp = smoothstep(0.25, 0.1, speck.f1) * select(0.0, 1.0, speck.id < 0.16);
  alb = mix(alb, select(vec3<f32>(0.74, 0.72, 0.68), vec3<f32>(0.22, 0.21, 0.20), speck.id < 0.08), sp * 0.6);
  alb *= 1.0 - 0.75 * crack * (0.5 + 0.5 * open);
  alb *= 1.0 - 0.35 * c2;
  let cav = 1.0 - max(crack * (0.4 + 0.6 * open), 0.6 * c2);
  return TexS(clamp(h, 0.0, 1.0), alb, 0.78 - 0.1 * grain, cav);
}
/** soil: clods (24 a tile) with gaps between them, some pebbles (9 a tile), a fine grain */
fn tgSoil(uv: vec2<f32>) -> TexS {
  let wv = vec2<f32>(tgFbm(uv, 8, 2, 31u), tgFbm(uv + vec2<f32>(0.5, 0.2), 8, 2, 32u)) - 0.5;
  // (crumbs, 48 a tile, their edges soft; lumps of them, 6 a tile; a fine grain)
  let c = tgCell(uv + 0.03 * wv, 48, 1.0, 33u);
  let pb = tgCell(uv + 0.01 * wv, 14, 1.0, 34u);
  let grain = tgFbm(uv, 64, 3, 35u);
  let lump = tgFbm(uv, 6, 3, 36u);
  let mot = tgFbm(uv, 12, 3, 37u);
  var h = 0.3 + 0.1 * sqrt(clamp(c.edge * 2.5, 0.0, 1.0)) + 0.3 * lump + 0.16 * (grain - 0.5);
  var alb = mix(vec3<f32>(0.45, 0.35, 0.24), vec3<f32>(0.30, 0.23, 0.16), clamp(0.3 * c.id + 0.9 * (mot - 0.5) + 0.5, 0.0, 1.0)) * (0.85 + 0.3 * grain);
  alb *= 1.0 - 0.08 * (1.0 - smoothstep(0.0, 0.1, c.edge));
  // pebbles: one cell in seven holds one, a rounded stone of uneven outline and size, darker grey-brown
  let pr = (0.12 + 0.2 * fract(pb.id * 7.3)) * (0.85 + 0.3 * tgNoise(uv, 64, 38u));
  if (pb.id < 0.15 && pb.f1 < pr) {
    let q = 1.0 - (pb.f1 / pr) * (pb.f1 / pr);
    h = max(h, 0.6 + 0.4 * sqrt(q));
    alb = mix(vec3<f32>(0.38, 0.35, 0.31), vec3<f32>(0.26, 0.24, 0.21), fract(pb.id * 13.7)) * (0.9 + 0.2 * grain) * (0.75 + 0.25 * sqrt(q));
  }
  let cav = smoothstep(0.0, 0.1, c.edge) * (0.6 + 0.4 * lump);
  return TexS(clamp(h, 0.0, 1.0), alb, 0.9, cav);
}
/** sand: wind ripples (16 a tile, bent), grains (110 a tile) of a few colours, a few dark grains */
fn tgSand(uv: vec2<f32>) -> TexS {
  let bend = tgFbm(uv, 3, 3, 41u) - 0.5;
  let ph = 6.2831853 * (uv.x * 16.0 + uv.y * 2.0 + 1.6 * bend);
  // (ripples: a long gentle stoss side and a short steep lee side)
  let r = 0.5 + 0.5 * sin(ph + 0.6 * sin(ph));
  let g = tgCell(uv, 110, 0.95, 42u);
  var h = 0.3 + 0.45 * r + 0.18 * sqrt(clamp(1.0 - g.f1, 0.0, 1.0)) + 0.05 * (tgFbm(uv, 32, 2, 43u) - 0.5);
  var alb = vec3<f32>(0.80, 0.71, 0.52) * (0.92 + 0.12 * g.id) * (0.95 + 0.08 * r);
  // (a few darker and lighter grains, rounded dots inside their cells: no square blotches seen close up)
  let dot0 = 1.0 - smoothstep(0.2, 0.35, g.f1);
  if (g.id < 0.05) { alb = mix(alb, vec3<f32>(0.55, 0.49, 0.40), dot0); }
  if (g.id > 0.96) { alb = mix(alb, vec3<f32>(0.86, 0.80, 0.66), dot0); }
  return TexS(clamp(h, 0.0, 1.0), alb, 0.95, 1.0);
}
/** clay: smooth, dried into plates (6 a tile) with thin cracks, a little grain */
fn tgClay(uv: vec2<f32>) -> TexS {
  let c = tgCell(uv, 6, 0.8, 51u);
  let grain = tgFbm(uv, 32, 3, 52u);
  let crack = 1.0 - smoothstep(0.0, 0.03, c.edge);
  let h = 0.7 + 0.08 * (c.id - 0.5) + 0.1 * (grain - 0.5) - 0.45 * crack + 0.08 * smoothstep(0.0, 0.3, c.edge);
  let alb = mix(vec3<f32>(0.64, 0.40, 0.31), vec3<f32>(0.55, 0.33, 0.26), c.id) * (0.9 + 0.2 * grain) * (1.0 - 0.5 * crack);
  return TexS(clamp(h, 0.0, 1.0), alb, 0.8, 1.0 - crack);
}
/** plants: a low sward seen from above, tufts (40 a tile) of blades (fine cells, 160 a tile), green of a few kinds, some
 *  dry, dark gaps */
fn tgPlant(uv: vec2<f32>) -> TexS {
  let t = tgCell(uv, 40, 0.9, 61u);
  let bl = tgCell(uv + 0.004 * (vec2<f32>(tgNoise(uv, 20, 62u), tgNoise(uv, 20, 63u)) - 0.5), 160, 1.0, 64u);
  let pt = tgFbm(uv, 4, 3, 65u);
  let tuft = sqrt(clamp(1.0 - t.f1 * 1.1, 0.0, 1.0));
  let blade = sqrt(clamp(1.0 - bl.f1 * 1.3, 0.0, 1.0));
  let h = clamp(0.15 + 0.5 * tuft + 0.35 * blade * (0.4 + 0.6 * tuft), 0.0, 1.0);
  var alb = mix(vec3<f32>(0.20, 0.34, 0.11), vec3<f32>(0.36, 0.44, 0.16), clamp(t.id * 0.7 + 0.6 * (pt - 0.5) + 0.3 * bl.id, 0.0, 1.0));
  if (bl.id < 0.07) { alb = vec3<f32>(0.55, 0.50, 0.28); }
  alb *= 0.45 + 0.65 * h;
  return TexS(h, alb, 0.95, 0.4 + 0.6 * h);
}
fn tgMat(layer: u32, uv: vec2<f32>) -> TexS {
  switch (layer) {
    case 0u: { return tgStone(uv); }
    case 1u: { return tgSoil(uv); }
    case 2u: { return tgSand(uv); }
    case 3u: { return tgClay(uv); }
    default: { return tgPlant(uv); }
  }
}
/** a material's relief: its height range as a fraction of the tile's side (the slopes the normal map holds) */
fn tgRelief(layer: u32) -> f32 {
  switch (layer) {
    case 0u: { return 0.035; }
    case 1u: { return 0.012; }
    case 2u: { return 0.006; }
    case 3u: { return 0.008; }
    default: { return 0.02; }
  }
}

@compute @workgroup_size(8, 8)
fn texGen(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = tg.a.y;
  if (id.x >= n || id.y >= n) { return; }
  let layer = tg.a.x;
  let inv = 1.0 / f32(n);
  let uv = (vec2<f32>(id.xy) + 0.5) * inv;
  // the texel and the heights a texel each way (the slope; the tile wraps: fract). ONE call site in a loop whose bound
  // the compiler does not know (tg.a.w = 5, from the CPU): five call sites took the compile to 4.8 s (FXC inlines each)
  var s: TexS;
  var hs = vec4<f32>(0.0);
  for (var q = 0u; q < tg.a.w; q++) {
    let o = vec2<f32>(select(select(0.0, -inv, q == 1u), inv, q == 2u), select(select(0.0, -inv, q == 3u), inv, q == 4u));
    let t = tgMat(layer, fract(uv + o));
    if (q == 0u) { s = t; } else { hs[q - 1u] = t.h; }
  }
  // (d height / d u in tile units, times the relief: world height over world distance)
  let sl = vec2<f32>(hs.y - hs.x, hs.w - hs.z) / (2.0 * inv) * tgRelief(layer);
  let nn = normalize(vec3<f32>(-sl, 1.0));
  // (the views hold the one layer and mip being written: index 0)
  textureStore(outA, vec2<i32>(id.xy), 0, vec4<f32>(clamp(s.alb, vec3<f32>(0.0), vec3<f32>(1.0)), s.rough));
  textureStore(outN, vec2<i32>(id.xy), 0, vec4<f32>(0.5 + 0.5 * nn.xy, s.h, s.cav));
}

@compute @workgroup_size(8, 8)
fn texMip(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = tg.a.y;
  if (id.x >= n || id.y >= n) { return; }
  // (the views hold one layer and one mip each: the source mip m - 1 and the target m, both at index 0)
  let layer = 0;
  let m = 0;
  var a = vec4<f32>(0.0);
  var nv = vec3<f32>(0.0);
  var hc = vec2<f32>(0.0);
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let q = vec2<i32>(id.xy) * 2 + vec2<i32>(i, j);
      a += textureLoad(srcA, q, layer, m);
      let t = textureLoad(srcN, q, layer, m);
      let xy = t.xy * 2.0 - 1.0;
      nv += vec3<f32>(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
      hc += t.zw;
    }
  }
  let nn = normalize(nv);
  textureStore(outA, vec2<i32>(id.xy), 0, a * 0.25);
  textureStore(outN, vec2<i32>(id.xy), 0, vec4<f32>(0.5 + 0.5 * nn.xy, hc * 0.25));
}
