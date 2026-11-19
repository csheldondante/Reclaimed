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
//   term from the detail height (hollows darker), haze toward the sky colour by world distance, a filmic tone map, sRGB.
// Cost: at most SH_NB + 1 band noises, one broad noise and (steep stone only) one crack noise: SH_NB + 3 = 9 3D
// gradient noises (8 hashes each) a pixel at worst.

const SH_NB: f32 = 6.0;
/** haze: the fraction of light kept per world unit is exp(-SH_HAZE) */
const SH_HAZE: f32 = 0.0018;
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
      // soil: grass where the geometric normal is up enough, dirt on slopes; grass keeps the hollows
      let gr = smoothstep(0.55, 0.78, ng.z - 0.10 * av + 0.07 * mv);
      let grass = mix(vec3<f32>(0.20, 0.33, 0.11), vec3<f32>(0.42, 0.45, 0.20), clamp(0.4 + 0.8 * mv, 0.0, 1.0)) * (0.78 + 0.36 * av);
      let dirt = vec3<f32>(0.46, 0.36, 0.25) * (0.86 + 0.22 * av);
      alb = mix(dirt, grass, gr);
      rough = mix(0.85, 0.95, gr);
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
  let fog = 1.0 - exp(-si.distW * SH_HAZE);
  c = mix(c, shSky(si.view, sun), fog);
  return shDisplay(c);
}
