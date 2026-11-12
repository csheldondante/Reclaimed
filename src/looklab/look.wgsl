// (looklab) The look lab's own renderer: painted ground (Raygeas stylized terrain, height-blended), water, Synty
// trees, a static sun shadow map, a colour grade. Throwaway: what works here is rebuilt in the game's renderer later.

struct U {
  viewProj: mat4x4<f32>,
  sunVP: mat4x4<f32>,
  sun: vec4<f32>,      // towards the sun, strength
  eye: vec4<f32>,      // towards the eye, world units a pixel
  misc: vec4<f32>,     // time, painted on, shadows on, grade on
  tile: vec4<f32>,     // texture repeat (m), macro strength, exposure, skylight
  dbg: vec4<f32>,      // 1 normals, 2 light only (albedo grey)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var texC: texture_2d_array<f32>;
@group(0) @binding(2) var texN: texture_2d_array<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var shadowMap: texture_depth_2d;
@group(0) @binding(5) var shadowSamp: sampler_comparison;

const NL: u32 = 8u;
// each layer's flat colour (the "painted" toggle off: the lo-fi look) — linear
fn flatCol(i: u32) -> vec3<f32> {
  switch i {
    case 0u: { return vec3<f32>(0.16, 0.30, 0.07); }
    case 1u: { return vec3<f32>(0.18, 0.32, 0.08); }
    case 2u: { return vec3<f32>(0.26, 0.17, 0.10); }
    case 3u: { return vec3<f32>(0.20, 0.22, 0.09); }
    case 4u: { return vec3<f32>(0.22, 0.21, 0.20); }
    case 5u: { return vec3<f32>(0.30, 0.27, 0.24); }
    case 6u: { return vec3<f32>(0.62, 0.48, 0.30); }
    default: { return vec3<f32>(0.80, 0.85, 0.90); }
  }
}

fn toLin(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn toSrgb(c: vec3<f32>) -> vec3<f32> { return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2)); }
/** the shaded colour out: exposure, a soft filmic curve (ACES fit), sRGB */
fn finish(c0: vec3<f32>) -> vec3<f32> {
  // (a soft shoulder on the luminance only: the colours keep their saturation, as painted ones do)
  let c = c0 * u.tile.z;
  let l = max(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-4);
  // (no curve below 0.8: the painted albedo shows as painted; a soft knee above it)
  let lt = select(l, 0.8 + (1.0 - exp(-(l - 0.8) / 0.25)) * 0.25, l > 0.8);
  return toSrgb(clamp(c * (lt / l), vec3<f32>(0.0), vec3<f32>(1.0)));
}

fn hash2(p: vec2<f32>) -> f32 {
  let q = fract(p * vec2<f32>(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), s.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), s.x), s.y);
}
fn fbm(p: vec2<f32>) -> f32 { return vnoise(p) * 0.55 + vnoise(p * 2.03 + 7.1) * 0.3 + vnoise(p * 4.1 + 3.7) * 0.15; }

fn shadowAt(w: vec3<f32>, n: vec3<f32>) -> f32 {
  if (u.misc.z < 0.5) { return 1.0; }
  let c = u.sunVP * vec4<f32>(w + n * 0.15, 1.0);
  let uv = vec2<f32>(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
  let d = c.z - 0.0008;
  let px = 1.0 / f32(textureDimensions(shadowMap).x);
  var s = 0.0;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(f32(i), f32(j)) * px * 1.5, d);
    }
  }
  return s / 9.0;
}

/** warm sun, cool sky, a ground bounce */
fn light(alb: vec3<f32>, n: vec3<f32>, w: vec3<f32>, ao: f32, rough: f32) -> vec3<f32> {
  let L = u.sun.xyz;
  let sh = shadowAt(w, n);
  // (wrapped a little: the terminator soft, as painted light is)
  let nl = clamp((dot(n, L) + 0.15) / 1.15, 0.0, 1.0);
  let sunC = vec3<f32>(1.0, 0.88, 0.72) * u.sun.w;
  let up = n.z * 0.5 + 0.5;
  let sky = mix(vec3<f32>(0.42, 0.36, 0.38), vec3<f32>(0.6, 0.62, 0.74), up) * u.tile.w;
  let V = u.eye.xyz;
  let H = normalize(L + V);
  let spec = pow(max(dot(n, H), 0.0), mix(48.0, 8.0, rough)) * (1.0 - rough) * 0.12;
  return alb * (sunC * nl * sh + sky * ao) + sunC * spec * sh * nl;
}

// ---- the ground ----
struct GV {
  @builtin(position) pos: vec4<f32>,
  @location(0) w: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) wa: vec4<f32>,
  @location(3) wb: vec4<f32>,
  @location(4) water: f32,
};

@vertex
fn vsGround(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) wt: vec2<u32>, @location(3) water: f32) -> GV {
  var o: GV;
  o.pos = u.viewProj * vec4<f32>(p, 1.0);
  o.w = p;
  o.n = n;
  o.wa = unpack4x8unorm(wt.x);
  o.wb = unpack4x8unorm(wt.y);
  o.water = water;
  return o;
}

@vertex
fn vsGroundShadow(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.sunVP * vec4<f32>(p, 1.0);
}

@fragment
fn fsGround(in: GV) -> @location(0) vec4<f32> {
  let N = normalize(in.n);
  let tile = u.tile.x;
  let uvT = in.w.xy / tile;
  let uvC = in.w.xy / (tile * 0.55);
  // (sides of steep ground: the texture across the slope, not smeared down it)
  let side = select(in.w.yz, in.w.xz, abs(N.y) > abs(N.x)) / tile * vec2<f32>(1.0, -1.0);
  let topW = smoothstep(0.55, 0.85, N.z);
  let gT = vec4<f32>(dpdx(uvT), dpdy(uvT));
  let gS = vec4<f32>(dpdx(side), dpdy(side));
  var wts = array<f32, 8>(in.wa.x, in.wa.y, in.wa.z, in.wa.w, in.wb.x, in.wb.y, in.wb.z, in.wb.w);
  var col = vec3<f32>(0.0);
  var nrm = vec3<f32>(0.0);
  var rough = 0.0;
  var ao = 0.0;
  if (u.misc.y > 0.5) {
    // height blend: each layer scored by its weight and its texture's height, the top ones kept
    var score = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var hs = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var best = -1.0;
    for (var i = 0u; i < NL; i++) {
      if (wts[i] > 0.02) {
        let uv = select(uvT, uvC, i == 5u);
        let nt = textureSampleGrad(texN, samp, uv, i32(i), gT.xy * select(1.0, 1.818, i == 5u), gT.zw * select(1.0, 1.818, i == 5u));
        hs[i] = nt.b;
        score[i] = wts[i] + nt.b * 0.6;
        best = max(best, score[i]);
      }
    }
    var tot = 0.0;
    for (var i = 0u; i < NL; i++) {
      if (wts[i] > 0.02) {
        let b = max(score[i] - best + 0.2, 0.0);
        if (b > 0.0) {
          let uv = select(uvT, uvC, i == 5u);
          let k = select(1.0, 1.818, i == 5u);
          var c = textureSampleGrad(texC, samp, uv, i32(i), gT.xy * k, gT.zw * k).rgb * topW;
          var nt = textureSampleGrad(texN, samp, uv, i32(i), gT.xy * k, gT.zw * k) * topW;
          if (topW < 0.999) {
            c += textureSampleGrad(texC, samp, side, i32(i), gS.xy, gS.zw).rgb * (1.0 - topW);
            nt += textureSampleGrad(texN, samp, side, i32(i), gS.xy, gS.zw) * (1.0 - topW);
          }
          col += c * b;
          let t = vec2<f32>(nt.x, nt.y) * 2.0 - 1.0;
          nrm += vec3<f32>(t, 1.0) * b;
          rough += nt.a * b;
          ao += mix(0.55, 1.0, hs[i]) * b;
          tot += b;
        }
      }
    }
    col /= tot;
    rough /= tot;
    ao /= tot;
    let tn = normalize(vec3<f32>(nrm.xy / tot, 1.0));
    // the texture's normal about the ground's (x along +x, y along +y)
    let T = normalize(vec3<f32>(1.0, 0.0, 0.0) - N * N.x);
    let B = normalize(cross(N, T));
    let tw = normalize(T * tn.x + B * tn.y + N * tn.z);
    nrm = normalize(mix(N, tw, topW * 0.9 + 0.1));
  } else {
    var tot = 0.0;
    for (var i = 0u; i < NL; i++) { col += flatCol(i) * wts[i]; tot += wts[i]; }
    col = col / max(tot, 1e-3);
    nrm = N;
    rough = 0.9;
    ao = 1.0;
  }
  var alb = col;
  // macro variation: soft patches a few cells to tens of cells across (value, a touch of hue)
  let m1 = fbm(in.w.xy / 9.0);
  let m2 = fbm(in.w.xy / 38.0 + 11.0);
  let mv = (m1 - 0.5) * 0.7 + (m2 - 0.5) * 1.0;
  alb *= 1.0 + mv * u.tile.y;
  alb *= mix(vec3<f32>(1.0), vec3<f32>(1.06, 1.0, 0.9), clamp(m2 - 0.45, 0.0, 1.0) * 2.0 * u.tile.y);
  // wet ground at the water's edge
  let wet = smoothstep(0.6, 0.0, in.water) * step(0.001, in.water) + smoothstep(0.15, 0.0, in.water) * 0.0;
  alb *= mix(1.0, 0.6, wet);
  if (u.dbg.x == 1.0) { return vec4<f32>(nrm * 0.5 + 0.5, 1.0); }
  if (u.dbg.x == 2.0) { alb = vec3<f32>(0.18); }
  let c = light(alb, nrm, in.w, ao, rough);
  return vec4<f32>(finish(c), 1.0);
}

// ---- water ----
struct WV {
  @builtin(position) pos: vec4<f32>,
  @location(0) w: vec3<f32>,
  @location(1) depth: f32,
};

@vertex
fn vsWater(@location(0) p: vec3<f32>, @location(3) water: f32, @location(4) level: f32) -> WV {
  var o: WV;
  let s = vec3<f32>(p.xy, level);
  o.pos = u.viewProj * vec4<f32>(s, 1.0);
  o.w = s;
  o.depth = level - p.z;
  return o;
}

@fragment
fn fsWater(in: WV) -> @location(0) vec4<f32> {
  if (in.depth < -0.5) { discard; }
  let t = u.misc.x;
  let p = in.w.xy;
  let e = 0.35;
  let h0 = fbm(p * 0.25 + vec2<f32>(t * 0.08, t * 0.05));
  let hx = fbm((p + vec2<f32>(e, 0.0)) * 0.25 + vec2<f32>(t * 0.08, t * 0.05));
  let hy = fbm((p + vec2<f32>(0.0, e)) * 0.25 + vec2<f32>(t * 0.08, t * 0.05));
  let n = normalize(vec3<f32>((h0 - hx) * 1.2, (h0 - hy) * 1.2, 1.0));
  let deep = smoothstep(0.0, 3.5, in.depth);
  let base = mix(vec3<f32>(0.10, 0.36, 0.36), vec3<f32>(0.02, 0.10, 0.17), deep);
  let V = u.eye.xyz;
  let fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  let sky = vec3<f32>(0.45, 0.6, 0.75);
  let H = normalize(u.sun.xyz + V);
  let sh = shadowAt(in.w, vec3<f32>(0.0, 0.0, 1.0));
  let spec = pow(max(dot(n, H), 0.0), 180.0) * 3.0 * sh;
  var c = base * (0.35 + 0.65 * sh) + sky * fres * 0.6 + vec3<f32>(1.0, 0.92, 0.75) * spec;
  // foam along the shore
  let foam = smoothstep(0.25, 0.0, in.depth) * step(-0.05, in.depth) * smoothstep(0.45, 0.7, fbm(p * 1.3 + t * 0.2));
  c = mix(c, vec3<f32>(0.85, 0.9, 0.88), foam * 0.7);
  let a = mix(0.35, 0.94, smoothstep(0.0, 1.8, in.depth));
  return vec4<f32>(finish(c), max(a, foam * 0.8));
}

// ---- trees (Synty Nature leafy trees, instanced) ----
@group(0) @binding(7) var treeTex: texture_2d_array<f32>;

struct TV {
  @builtin(position) pos: vec4<f32>,
  @location(0) w: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) @interpolate(flat) layer: i32,
  @location(4) leaf: f32,
  @location(5) tint: vec3<f32>,
  @location(6) hue: f32,
  @location(7) h: f32,
};

fn treeWorld(p: vec3<f32>, inst: vec4<f32>, sc: f32) -> vec3<f32> {
  let c = cos(inst.w);
  let s = sin(inst.w);
  var q = vec3<f32>(c * p.x - s * p.y, s * p.x + c * p.y, p.z) * sc;
  // a little wind: the crown sways, the trunk's foot stays
  let k = max(p.z - 0.8, 0.0) * 0.02;
  q.x += sin(u.misc.x * 1.3 + inst.x * 0.37 + inst.y * 0.21) * k;
  q.y += cos(u.misc.x * 1.1 + inst.y * 0.33) * k * 0.6;
  return q + inst.xyz;
}

@vertex
fn vsTree(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) lt: vec2<f32>, @location(4) tint: vec3<f32>,
          @location(5) inst: vec4<f32>, @location(6) ext: vec4<f32>, @location(7) cen: vec3<f32>, @location(8) off: vec2<f32>) -> TV {
  var o: TV;
  var w = treeWorld(p, inst, ext.x);
  if (lt.y > 0.01) {
    // a leaf card turned to face the camera round its own centre (the fluffy-foliage trick: a crown full from any
    // angle), a little larger than modelled
    let fw = u.eye.xyz;
    let R = normalize(cross(vec3<f32>(0.0, 0.0, 1.0), fw));
    let U = cross(fw, R);
    w = treeWorld(cen, inst, ext.x) + (R * off.x + U * off.y) * ext.x * 1.25;
  }
  o.pos = u.viewProj * vec4<f32>(w, 1.0);
  o.w = w;
  let c = cos(inst.w);
  let s = sin(inst.w);
  o.n = vec3<f32>(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
  o.uv = uv;
  o.layer = i32(lt.x + 0.5);
  o.leaf = lt.y;
  o.tint = tint;
  o.hue = ext.y;
  o.h = p.z / max(ext.z, 1.0);
  return o;
}

@vertex
fn vsTreeShadow(@location(0) p: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) lt: vec2<f32>, @location(5) inst: vec4<f32>, @location(6) ext: vec4<f32>) -> TSV {
  var o: TSV;
  o.pos = u.sunVP * vec4<f32>(treeWorld(p, inst, ext.x), 1.0);
  o.uv = uv;
  o.layer = i32(lt.x + 0.5);
  return o;
}
struct TSV {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) layer: i32,
};
@fragment
fn fsTreeShadow(in: TSV) {
  if (textureSampleLevel(treeTex, samp, in.uv, in.layer, 1.0).a < 0.5) { discard; }
}

@fragment
fn fsTree(in: TV) -> @location(0) vec4<f32> {
  let t = textureSample(treeTex, samp, in.uv, in.layer);
  let isLeaf = in.leaf > 0.01;
  if (isLeaf && t.a < 0.5) { discard; }
  // (the leaf textures' own darkness evened out: the pines' is near black, Synty's shader lifts it)
  let gain = select(1.0, select(select(1.0, 7.0, in.layer == 1), 1.4, in.layer == 0), isLeaf);
  var alb = toLin(t.rgb) * in.tint * gain;
  if (isLeaf) {
    // (the leaf texture as the cards' shape and a little detail; the crown's colour its own, flat — so the light's
    // gradient across the crown is what reads, as in Synty's own shots)
    let base = select(select(vec3<f32>(0.20, 0.34, 0.07), vec3<f32>(0.07, 0.17, 0.09), in.layer == 1), vec3<f32>(0.24, 0.32, 0.06), in.layer == 2);
    let det = dot(toLin(t.rgb) * gain, vec3<f32>(0.3, 0.6, 0.1)) / max(dot(base, vec3<f32>(0.3, 0.6, 0.1)), 1e-3);
    alb = base * mix(1.0, clamp(det, 0.5, 1.5), 0.3);
  }
  // each tree its own shade (greens to yellows; now and then an autumn one)
  alb *= mix(vec3<f32>(0.85, 1.0, 0.8), vec3<f32>(1.15, 1.0, 0.7), in.hue);
  if (in.hue > 0.9 && isLeaf) { alb = alb * vec3<f32>(2.2, 0.9, 0.35); }
  let n = normalize(in.n);
  if (u.dbg.x == 1.0) { return vec4<f32>(n * 0.5 + 0.5, 1.0); }
  if (u.dbg.x == 2.0) { alb = vec3<f32>(0.18); }
  var c: vec3<f32>;
  if (isLeaf) {
    // a clump lit as a volume: half-Lambert squared round its blob normal (lit side to shade side across the clump),
    // the inner leaves darker, the crown's lower half in its own shade, light through the leaves from behind
    let sh = shadowAt(in.w, n);
    let hl = dot(n, u.sun.xyz) * 0.5 + 0.5;
    let key = hl * hl * mix(0.45, 1.0, sh);
    let occ = in.leaf * mix(0.65, 1.0, clamp(in.h, 0.0, 1.0));
    let sunC = vec3<f32>(1.0, 0.88, 0.72) * u.sun.w;
    let sky = mix(vec3<f32>(0.42, 0.4, 0.38), vec3<f32>(0.6, 0.62, 0.74), n.z * 0.5 + 0.5) * u.tile.w;
    let ramp = mix(vec3<f32>(0.32, 0.45, 0.58), vec3<f32>(1.45, 1.25, 0.8), smoothstep(0.1, 0.8, key));
    c = alb * ramp * (sunC * 0.45 + sky * 0.75) * occ * 1.5;
    let back = pow(max(dot(-n, u.sun.xyz), 0.0), 2.0) * sh;
    c += alb * vec3<f32>(1.0, 0.95, 0.55) * back * 0.4 * u.sun.w;
  } else {
    c = light(alb, n, in.w, 0.85, 0.9);
  }
  return vec4<f32>(finish(c), 1.0);
}

// ---- the grade (a full-screen pass over the scene) ----
@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> gu: vec4<f32>; // grade on, time, w, h

@vertex
fn vsPost(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fsPost(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  var c = textureLoad(sceneTex, vec2<i32>(fc.xy), 0).rgb;
  if (gu.x > 0.5) {
    // warm, a touch more saturated, gentle S-curve, soft vignette (the painted look's grade)
    let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    c = mix(vec3<f32>(l), c, 1.12);
  }
  return vec4<f32>(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
