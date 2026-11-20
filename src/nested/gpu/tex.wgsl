// ---- nested/gpu/tex.wgsl (round 27, ?tex=2): the tiling material textures, sampled triplanar in world space ---------
// Appended to the draw module after draw.wgsl (texdraw.wgsl's entry points and the field's fsFieldT2 call it); binding-
// free apart from the textures, so a test can run txMat and texShade2 in a compute pass.
// The textures (texgen.wgsl, generated once after the first frame) are tiles that wrap; a tile is sampled at two world
// sizes, fine (2^-geo.w world units: 2 m with 128 m root columns) and coarse (16 x: 32 m), and the two combined (the fine
// tile's colour times the coarse one's relative to its mean; slopes added; heights mixed), which hides the repeat.
// Position: the pixel's DPt (a level's integer window origin + a level-local point), split per axis into the tile's whole
// cells and a fraction in integers first (detail.wgsl dbSplit), so the same world point gets the same texel from every
// level and nothing is lost to f32 on a 65 km world. Mip and anisotropic filtering: the gradients are the level-local
// point's screen derivatives scaled to the tile (textureSampleGrad: also correct in the non-uniform branches below).
// Projection: the geometric normal picks the PROJECTIONS only (|n|^4), sharpened by the textures' heights (the taller
// texel's projection wins), never the material. Material: the drawn column's (sheets: its top interval; field: the
// lookup), and at a border the neighbouring column's, blended by height over a narrow band (matMix, draw.wgsl).

@group(0) @binding(6) var txA: texture_2d_array<f32>;
@group(0) @binding(7) var txN: texture_2d_array<f32>;
@group(0) @binding(8) var txS: sampler;

/** the coarse tile is 2^TX_COARSE times the fine one */
const TX_COARSE: i32 = 4;
/** the height's share in picking a projection and a material (in weight units) */
const TX_HPROJ: f32 = 0.5;
const TX_HMAT: f32 = 0.35;

/** a pixel's material(s): its own (a) and, at a border, the neighbouring column's (b) with its weight (0..1: the bilinear
 *  weight of the column centres around the pixel that hold b, of those holding a or b; draw.wgsl matMix) */
struct MatMix {
  a: u32,
  b: u32,
  wb: f32,
}
/** a material's texture sample at one point: albedo (sRGB values), roughness, cavity, height 0..1, and the surface
 *  gradient of its relief (world height per world distance, world axes) */
struct TxM {
  alb: vec3<f32>,
  rough: f32,
  cav: f32,
  h: f32,
  g: vec3<f32>,
}
/** a point's tile coordinates on the three axis planes at tile frequency 2^m (shading units): x, y the whole-cell-free
 *  fractions of world x, y; z of world z */
fn txUV(p: DPt, m: i32) -> vec3<f32> {
  let e = m - p.s;
  return vec3<f32>(dbSplit(p.o.x, p.f.x, e).t, dbSplit(p.o.y, p.f.y, e).t, dbAxisZ(p.zo, p.f.z, m, e).y);
}
/** mips the coarse tile is read blurrier than the pixel needs, by layer (stone, soil, sand, clay, plants) */
fn txCoarseBias(layer: i32) -> f32 {
  switch (layer) {
    case 0: { return 2.0; }
    case 1: { return 3.0; }
    case 2: { return 4.0; }
    case 3: { return 2.0; }
    default: { return 3.0; }
  }
}
fn txSlope(t: vec4<f32>) -> vec2<f32> {
  let xy = t.xy * 2.0 - 1.0;
  return -xy / max(sqrt(max(0.0, 1.0 - dot(xy, xy))), 0.05);
}

/** material `layer` at p: the three projections (weights from the geometric normal, sharpened by height), each at the
 *  fine and the coarse size. qx, qy: the level-local point's screen derivatives (local units) */
fn txMat(p: DPt, layer: i32, ng: vec3<f32>, qx: vec3<f32>, qy: vec3<f32>, mF: i32) -> TxM {
  let mC = mF - TX_COARSE;
  let uF = txUV(p, mF);
  let uC = txUV(p, mC);
  let uM = txUV(p, mC - TX_COARSE);
  let sF = ldexp(1.0, mF - p.s);
  // (the coarse tile is read some mips blurrier than the pixel needs: it brings the large variation, the fine tile the
  // crisp detail; sand's grains at 16 x would read as pebbles. Stone keeps most of its large blocks)
  let sC = ldexp(1.0, mC - p.s) * exp2(txCoarseBias(layer));
  var b = pow(abs(ng), vec3<f32>(4.0));
  b /= b.x + b.y + b.z;
  // (the tile's mean: its last mip; a scale whose tile spans few pixels fades to it, else its repeat shows as a grid)
  let meanA = textureSampleLevel(txA, txS, vec2<f32>(0.5), layer, 16.0);
  let meanN = textureSampleLevel(txN, txS, vec2<f32>(0.5), layer, 16.0);
  // pass 1: heights and slopes of every projection with some weight (fine and coarse)
  var hp = vec3<f32>(0.0);
  var nF: array<vec4<f32>, 3>;
  var nC: array<vec4<f32>, 3>;
  var fF = vec3<f32>(0.0);
  var fC = vec3<f32>(0.0);
  for (var a = 0; a < 3; a++) {
    if (b[a] < 0.02) { continue; }
    // (axis a's plane: x -> (y, z), y -> (x, z), z -> (x, y))
    let i0 = select(0, 1, a == 0);
    let i1 = select(2, 1, a == 2);
    let dxF = vec2<f32>(qx[i0], qx[i1]) * sF;
    let dyF = vec2<f32>(qy[i0], qy[i1]) * sF;
    // (tile widths a pixel: a scale fades out between 256 and 64 pixels a tile; at 128 to 32 the coarse tile's repeat
    // still read as a lattice from 300 m)
    let tw = max(max(length(dxF), length(dyF)), 1e-12);
    fF[a] = smoothstep(6.0, 8.0, -log2(tw));
    fC[a] = smoothstep(6.0, 8.0, -log2(tw) + f32(TX_COARSE));
    nF[a] = mix(meanN, textureSampleGrad(txN, txS, vec2<f32>(uF[i0], uF[i1]), layer, dxF, dyF), fF[a]);
    nC[a] = mix(meanN, textureSampleGrad(txN, txS, vec2<f32>(uC[i0], uC[i1]), layer, dxF * (sC / sF), dyF * (sC / sF)), fC[a]);
    hp[a] = 0.65 * nF[a].z + 0.35 * nC[a].z;
  }
  // the taller texel's projection wins near a change of projection
  let hb = b + TX_HPROJ * hp * select(vec3<f32>(0.0), vec3<f32>(1.0), b >= vec3<f32>(0.02));
  let mx = max(hb.x, max(hb.y, hb.z));
  var w = max(hb - vec3<f32>(mx - 0.25), vec3<f32>(0.0)) * select(vec3<f32>(0.0), vec3<f32>(1.0), b >= vec3<f32>(0.02));
  w /= max(w.x + w.y + w.z, 1e-6);
  // pass 2: colour where a projection kept weight
  var o = TxM(vec3<f32>(0.0), 0.0, 0.0, 0.0, vec3<f32>(0.0));
  for (var a = 0; a < 3; a++) {
    if (w[a] <= 0.0) { continue; }
    let i0 = select(0, 1, a == 0);
    let i1 = select(2, 1, a == 2);
    let dxF = vec2<f32>(qx[i0], qx[i1]) * sF;
    let dyF = vec2<f32>(qy[i0], qy[i1]) * sF;
    let aF = mix(meanA, textureSampleGrad(txA, txS, vec2<f32>(uF[i0], uF[i1]), layer, dxF, dyF), fF[a]);
    let aC = mix(meanA, textureSampleGrad(txA, txS, vec2<f32>(uC[i0], uC[i1]), layer, dxF * (sC / sF), dyF * (sC / sF)), fC[a]);
    // (the macro tile, 16 x the coarse (512 m with 2 m tiles), colour and slope only: what a hillside shows from a few
    // hundred metres, where the two tiles have faded to their mean)
    let tw = max(max(length(dxF), length(dyF)), 1e-12);
    let fM = smoothstep(6.0, 8.0, -log2(tw) + f32(2 * TX_COARSE));
    let sM = sC * ldexp(1.0, -TX_COARSE) / sF;
    let aM = mix(meanA, textureSampleGrad(txA, txS, vec2<f32>(uM[i0], uM[i1]), layer, dxF * sM, dyF * sM), fM);
    let nM = mix(meanN, textureSampleGrad(txN, txS, vec2<f32>(uM[i0], uM[i1]), layer, dxF * sM, dyF * sM), fM);
    // (the coarse and macro tiles relative to the mean: the large variation over the fine tile's colour)
    let rel = clamp(aC.rgb * aM.rgb / max(meanA.rgb * meanA.rgb, vec3<f32>(0.0004)), vec3<f32>(0.5), vec3<f32>(1.7));
    o.alb += w[a] * aF.rgb * rel;
    o.rough += w[a] * aF.a;
    o.cav += w[a] * nF[a].w * mix(1.0, nC[a].w, 0.5);
    o.h += w[a] * hp[a];
    let s = txSlope(nF[a]) + txSlope(nC[a]) + txSlope(nM);
    var g = vec3<f32>(0.0);
    g[i0] = s.x;
    g[i1] = s.y;
    o.g += w[a] * g;
  }
  return o;
}

/** the textured surface colour with the tiling textures (?tex=2), display-ready. `mix` the pixel's material(s) */
fn texShade2(si0: ShadeIn, mm: MatMix, qx: vec3<f32>, qy: vec3<f32>, mF: i32) -> vec3<f32> {
  var si = si0;
  let p = si.p;
  let a = matId(mm.a);
  var m = txMat(p, i32(a) - 1, si.ng, qx, qy, mF);
  var mat = a;
  // a border: the neighbour's material where its height wins within the band (sand lying in the rock's cracks)
  let b = matId(mm.b);
  if (mm.wb > 0.02 && b != a && b != MAT_AIR) {
    let mb = txMat(p, i32(b) - 1, si.ng, qx, qy, mF);
    let t = smoothstep(-0.04, 0.04, (mm.wb + TX_HMAT * mb.h) - ((1.0 - mm.wb) + TX_HMAT * m.h));
    m.alb = mix(m.alb, mb.alb, t);
    m.rough = mix(m.rough, mb.rough, t);
    m.cav = mix(m.cav, mb.cav, t);
    m.g = mix(m.g, mb.g, t);
    m.h = mix(m.h, mb.h, t);
    if (t > 0.5) { mat = b; }
  }
  si.mat = mat;
  // (a broad tone over both tiles: one gradient noise of wavelength 32 fine tiles, 64 m with 2 m tiles, so the coarse
  // tile's repeat does not line up from tile to tile)
  m.alb *= 0.86 + 0.28 * (0.5 + 0.5 * dbNoise(p, mF - 5, 7u).x);
  let av = clamp((m.h - 0.5) * 2.0, -1.0, 1.0);
  // (the broad noise the canopy's colours use: only where the canopy can show)
  var mv = 0.0;
  if (mat == 5u && si.canopy > 0.0) {
    let mw = clamp(log2(8.0 / max(si.pxW, 1e-30)) - 1.0, 0.0, 1.0);
    mv = mw * dbNoise(p, -3, 5u).x;
  }
  let ao = mix(0.55, 1.0, m.cav);
  return shFinish(si, m.alb, m.rough, ao, m.g, av, mv);
}
