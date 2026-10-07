// ---- renderer: box instances, opaque + water ------------------------------
// One instanced draw per list. Each instance is an axis-aligned box; we emit
// only the three faces that can face the fixed isometric camera
// (top + the two sides toward the eye), 18 vertices per instance.
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,      // direction toward the eye (world), w unused
  viewport: vec4<f32>, // px w, px h, px per world unit, 0
};

@group(0) @binding(3) var<storage, read> instances: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read> moisture: array<f32>;
@group(0) @binding(6) var<storage, read> veg: array<f32>;
@group(0) @binding(7) var<storage, read> shadow: array<f32>;
@group(0) @binding(8) var<storage, read> water: array<f32>;
@group(0) @binding(9) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(10) var<uniform> CAM: Camera;
@group(0) @binding(11) var<storage, read> surface: array<u32>;

const QUAD = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  @location(2) @interpolate(flat) info: vec2<u32>, // material, flags
  // large-scale ground patchiness; smooth, so evaluated per vertex (was per pixel)
  @location(3) tint: f32,
  // the box's z range (liquids derive depth from it)
  @location(4) @interpolate(flat) zr: vec2<f32>,
};

struct Box { x: f32, y: f32, sx: f32, sy: f32, z0: f32, z1: f32, mat: u32, flags: u32 };

fn unpackBox(v: vec4<u32>) -> Box {
  return Box(
    f32(v.x & 0xfffu), f32((v.x >> 12u) & 0xfffu),
    f32(((v.x >> 24u) & 0xfu) + 1u), f32(((v.x >> 28u) & 0xfu) + 1u),
    bitcast<f32>(v.y), bitcast<f32>(v.z), v.w & 0xffu, (v.w >> 8u) & 0xffu);
}

fn boxVertex(b: Box, vi: u32, out: ptr<function, VOut>) -> bool {
  let face = vi / 6u;
  let uv = QUAD[vi % 6u];
  let sxn = select(-1.0, 1.0, CAM.eye.x > 0.0);
  let syn = select(-1.0, 1.0, CAM.eye.y > 0.0);
  var p: vec3<f32>;
  var n: vec3<f32>;
  if (face == 0u) {
    p = vec3<f32>(b.x + uv.x * b.sx, b.y + uv.y * b.sy, b.z1);
    n = vec3<f32>(0.0, 0.0, 1.0);
  } else if (face == 1u) {
    let fx = select(b.x, b.x + b.sx, sxn > 0.0);
    p = vec3<f32>(fx, b.y + uv.x * b.sy, mix(b.z0, b.z1, uv.y));
    n = vec3<f32>(sxn, 0.0, 0.0);
  } else {
    let fy = select(b.y, b.y + b.sy, syn > 0.0);
    p = vec3<f32>(b.x + uv.x * b.sx, fy, mix(b.z0, b.z1, uv.y));
    n = vec3<f32>(0.0, syn, 0.0);
  }
  (*out).pos = CAM.viewProj * vec4<f32>(p, 1.0);
  (*out).wpos = p;
  (*out).nrm = n;
  (*out).tint = 0.82 + 0.36 * fbm2(p.xy * 0.045 + vec2<f32>(p.z * 0.02));
  (*out).info = vec2<u32>(b.mat, b.flags);
  (*out).zr = vec2<f32>(b.z0, b.z1);
  // per-face visibility computed in render-prep
  var hideBit = 64u;
  if (face == 1u) { hideBit = select(8u, 4u, sxn > 0.0); }
  if (face == 2u) { hideBit = select(32u, 16u, syn > 0.0); }
  return b.z1 > b.z0 && (b.flags & hideBit) == 0u;
}

@vertex
fn vsBox(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let b = unpackBox(instances[ii]);
  if (!boxVertex(b, vi, &o)) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); }
  return o;
}

@vertex
fn vsWater(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let b = unpackBox(instances[ii]);
  var ok = boxVertex(b, vi, &o);
  // hide side faces that are inside a continuous body of water
  let face = vi / 6u;
  if (face > 0u && b.mat != MAT_OIL) {
    let q = vec2<i32>(i32(b.x), i32(b.y)) + vec2<i32>(o.nrm.xy);
    if (inMap(q)) {
      let j = colIdxI(q);
      if (f32(sfZ(surface[j])) + water[j] >= b.z1 - 0.02) { ok = false; }
    }
  }
  if (!ok) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); }
  return o;
}

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) pick: u32,
};

fn toLinear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn toSrgb(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }

/** Column whose fields describe this fragment (step slightly into the surface). */
fn fragCell(wpos: vec3<f32>, nrm: vec3<f32>) -> vec2<i32> {
  return clampCell(vec2<i32>(floor(wpos.xy - nrm.xy * 0.01)));
}

fn sunDir() -> vec3<f32> { return normalize(vec3<f32>(G.sunX, G.sunY, G.sunZ)); }

/** Direct + ambient light with heightfield shadow and storm cloud shade. */
fn lighting(wpos: vec3<f32>, nrm: vec3<f32>) -> vec3<f32> {
  let sun = sunDir();
  let ndl = max(dot(nrm, sun), 0.0);
  let sc = clampCell(vec2<i32>(floor(wpos.xy + nrm.xy * 0.5)));
  let lit = select(0.0, 1.0, wpos.z >= shadow[colIdxI(sc)] - 0.05);
  let cloud = cloudShade(wpos.xy);
  let clear = 1.0 - G.pollution;
  let sunCol = mix(vec3<f32>(1.0, 0.84, 0.64), vec3<f32>(1.0, 0.95, 0.86), clear) * 2.4;
  let sky = mix(vec3<f32>(0.34, 0.33, 0.31), vec3<f32>(0.30, 0.38, 0.50), clear);
  let ambient = sky * (0.5 + 0.5 * nrm.z) * (1.0 - cloud * 0.5);
  // warm bounce light from the opposite side keeps shaded faces readable
  let fill = max(dot(nrm, normalize(vec3<f32>(-sun.x, -sun.y, 0.4))), 0.0) * vec3<f32>(0.42, 0.36, 0.29) * (1.0 - cloud * 0.5);
  let flash = G.misc.z * vec3<f32>(1.1, 1.2, 1.5) * (0.6 + 0.4 * nrm.z);
  return ambient + fill + flash + sunCol * ndl * lit * (1.0 - cloud * 0.93);
}

fn haze(c: vec3<f32>, wpos: vec3<f32>) -> vec3<f32> {
  let dirty = vec3<f32>(0.62, 0.57, 0.48);
  let clean = vec3<f32>(0.62, 0.70, 0.78);
  let h = mix(clean, dirty, G.pollution);
  let lowFog = smoothstep(24.0, 0.0, wpos.z) * 0.06;
  return mix(c, toLinear(h), 0.03 + 0.1 * G.pollution + lowFog);
}

/** Thin dark lines at cell boundaries so the voxel grid reads; fades out when cells are tiny. */
fn gridLines(wpos: vec3<f32>, nrm: vec3<f32>) -> f32 {
  var a: vec2<f32>;
  if (abs(nrm.z) > 0.5) { a = wpos.xy; } else if (abs(nrm.x) > 0.5) { a = wpos.yz; } else { a = wpos.xz; }
  let f = fract(a);
  let e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  let w = max(fwidth(a.x), fwidth(a.y));
  let line = 1.0 - smoothstep(0.0, w * 1.2, e);
  return line * 0.16 * smoothstep(0.45, 0.12, w);
}

@fragment
fn fsBox(in: VOut) -> FOut {
  let mat = in.info.x;
  let flags = in.info.y;
  let cell = fragCell(in.wpos, in.nrm);
  let ci = colIdxI(cell);
  var alb = toLinear(MATS[mat].albedo.rgb);

  // voxel texture: per-cell and per-subcell (4x4) variation
  let vc = vec3<i32>(floor(in.wpos - in.nrm * 0.01));
  let sub = vec3<i32>(floor(in.wpos * 4.0 - in.nrm * 0.02));
  let n1 = randv(sub);
  let n2 = randv(sub + vec3<i32>(71, 13, 5));
  alb *= 0.9 + 0.12 * randv(vc) + 0.08 * n1;
  // large-scale patchiness so open ground is not one flat colour
  alb *= in.tint;
  // natural materials: per-voxel hue drift (warm/cool, mineral streaks) and
  // sub-voxel pebbles, so stone and dirt aren't a single flat colour
  if (mat >= 1u && mat <= 4u) {
    let hv = randv(vc + vec3<i32>(17, 3, 91));
    let warm = vec3<f32>(1.08, 0.97, 0.88);
    let cool = vec3<f32>(0.92, 0.98, 1.06);
    alb *= mix(cool, warm, hv);
    // large-scale mineral bands on stone / clay-iron patches on soil
    let band = fbm2(in.wpos.xy * 0.11 + vec2<f32>(in.wpos.z * 0.35, 0.0));
    if (mat == 1u) { alb *= mix(vec3<f32>(0.9, 0.92, 0.96), vec3<f32>(1.1, 1.0, 0.9), band); }
    if (mat == 2u) { alb *= mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), band); }
    // pebbles: occasional lighter/darker sub-voxels
    let pb = randv(sub + vec3<i32>(5, 77, 13));
    if (pb > 0.93) { alb *= 1.25; } else if (pb < 0.05) { alb *= 0.72; }
  }

  if (mat == MAT_TRASH) {
    // faded plastics, paper, glass and rust specks
    let k = u32(n2 * 6.0);
    var tc = vec3<f32>(0.45, 0.43, 0.40);
    if (k == 0u) { tc = vec3<f32>(0.42, 0.52, 0.62); }
    else if (k == 1u) { tc = vec3<f32>(0.78, 0.76, 0.70); }
    else if (k == 2u) { tc = vec3<f32>(0.66, 0.38, 0.34); }
    else if (k == 3u) { tc = vec3<f32>(0.38, 0.48, 0.34); }
    else if (k == 4u) { tc = vec3<f32>(0.50, 0.33, 0.20); }
    alb = toLinear(tc) * (0.75 + 0.35 * n1);
  }

  let v = veg[ci];
  let isVeg = (flags & 2u) != 0u;
  if (isVeg) {
    // leaves/wood: hue jitter, lighter tips on top
    let fresh = vec3<f32>(0.30, 0.52, 0.18);
    if (mat == MAT_LEAVES) {
      alb = toLinear(mix(vec3<f32>(0.16, 0.34, 0.12), fresh, n1 * 0.8 + 0.2 * in.nrm.z));
    }
  } else {
    let isTop = (flags & 1u) != 0u && in.nrm.z > 0.5;
    let porosity = MATS[mat].eco.w;
    if (isTop) {
      // contamination stains: oily black-brown with sickly yellow-green streaks
      let c = contam[ci].x;
      let stain = smoothstep(0.12, 1.1, c);
      let oil = mix(vec3<f32>(0.10, 0.09, 0.06), vec3<f32>(0.42, 0.40, 0.12), smoothstep(0.55, 0.95, n2));
      alb = mix(alb, toLinear(oil), stain * 0.8);
      // desaturate when dead/dry
      let lum = dot(alb, vec3<f32>(0.3, 0.55, 0.15));
      alb = mix(alb, vec3<f32>(lum), 0.25 * G.pollution);
    }
    // wet surfaces darken
    let m = moisture[ci];
    alb *= 1.0 - porosity * 0.5 * smoothstep(0.15, 0.9, m);

    // vegetation cover (dithered at sub-cell resolution)
    if (v > 0.0) {
      var cover: f32;
      if (isTop) { cover = smoothstep(0.0, 1.2, v); } else { cover = smoothstep(0.8, 3.0, v) * 0.55 * (0.5 + 0.5 * n2); }
      if (n1 < cover) {
        let moss = vec3<f32>(0.33, 0.40, 0.17);
        let grass = vec3<f32>(0.36, 0.54, 0.19);
        let forest = vec3<f32>(0.17, 0.33, 0.12);
        var g = mix(moss, grass, smoothstep(1.0, 2.0, v));
        g = mix(g, forest, smoothstep(3.0, 4.5, v));
        g *= 0.82 + 0.3 * n2;
        alb = toLinear(g);
      }
    }
  }

  var col = alb * lighting(in.wpos, in.nrm);
  col *= 1.0 - gridLines(in.wpos, in.nrm);
  col = haze(col, in.wpos);

  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = ci + 1u;
  return o;
}

@fragment
fn fsWater(in: VOut) -> FOut {
  let cell = fragCell(in.wpos, in.nrm);
  let ci = colIdxI(cell);
  // derivatives must be taken in uniform control flow, before any branch
  let gl = gridLines(in.wpos, in.nrm);
  if (in.info.x == MAT_OIL) { return shadeOil(in, ci); }
  let d = water[ci];
  let flow = length(netFlow(cell));
  let deep = 1.0 - exp(-d * 0.45);
  var c = mix(vec3<f32>(0.30, 0.45, 0.44), vec3<f32>(0.07, 0.19, 0.25), deep);
  let conc = contam[ci].y / max(d, 0.05);
  c = mix(c, vec3<f32>(0.40, 0.37, 0.11), smoothstep(0.03, 0.8, conc) * 0.85);
  var col = toLinear(c) * lighting(in.wpos, in.nrm);
  var alpha = mix(0.5, 0.9, deep) * smoothstep(WATER_MIN_R, 0.08, d);

  if (in.nrm.z > 0.5) {
    // ripples + sun glint
    let t = G.time;
    let rp = in.wpos.xy * 1.7;
    let rn = vec3<f32>(
      vnoise(rp + vec2<f32>(t * 0.7, 0.0)) - vnoise(rp + vec2<f32>(0.0, t * 0.6) + 31.0),
      vnoise(rp + vec2<f32>(0.0, -t * 0.8) + 7.0) - vnoise(rp + vec2<f32>(-t * 0.5, 0.0) + 19.0),
      1.4);
    let nn = normalize(rn);
    // Stylised for the fixed view: ripple slopes facing the sun brighten, and the
    // half-vector is biased toward vertical so glints appear on ordinary
    // ripples instead of only at one viewing angle.
    let sunL = sunDir();
    let shade = 1.0 + dot(nn.xy, normalize(sunL.xy)) * 0.45;
    let h = normalize(normalize(sunL + CAM.eye.xyz) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(dot(nn, h), 0.0), 160.0) * (1.0 - cloudShade(in.wpos.xy));
    col *= shade;
    col += vec3<f32>(1.0, 0.94, 0.84) * spec * 0.7;
    // foam where flowing fast
    let sub = vec3<i32>(floor(vec3<f32>(in.wpos.xy * 4.0, t * 6.0)));
    let foam = smoothstep(0.03, 0.25, flow) * step(0.72, randv(sub));
    col = mix(col, vec3<f32>(0.85, 0.85, 0.8), foam * 0.6);
    alpha = max(alpha, foam * 0.7);
    // rain rings
    let rain = rainAt(in.wpos.xy);
    let rsub = vec3<i32>(floor(vec3<f32>(in.wpos.xy * 3.0, t * 10.0)));
    col += vec3<f32>(0.25) * step(1.0 - 0.06 * rain, randv(rsub));
  }
  col *= 1.0 - gl * 0.3;
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = ci + 1u;
  return o;
}

const WATER_MIN_R: f32 = 0.012;


/** Oil: near-black, glossy, with a slow thin-film rainbow sheen on top. */
fn shadeOil(in: VOut, ci: u32) -> FOut {
  let d = in.zr.y - in.zr.x;
  var c = toLinear(vec3<f32>(0.08, 0.065, 0.05));
  var col = c * lighting(in.wpos, in.nrm);
  if (in.nrm.z > 0.5) {
    let n = vnoise(in.wpos.xy * 0.45 + vec2<f32>(G.time * 0.04, -G.time * 0.03)) * 2.0 + vnoise(in.wpos.xy * 1.3) * 0.6;
    // cosine palette ≈ thin-film interference colours
    let film = 0.5 + 0.5 * cos(6.2831 * (vec3<f32>(n) + vec3<f32>(0.0, 0.33, 0.67)));
    col += toLinear(film) * 0.035 * (1.0 - cloudShade(in.wpos.xy));
    let h = normalize(normalize(sunDir() + CAM.eye.xyz) + vec3<f32>(0.0, 0.0, 1.6));
    let spec = pow(max(h.z, 0.0), 30.0) * 0.25;
    col += vec3<f32>(spec);
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), clamp(0.55 + d * 3.0, 0.55, 0.96));
  o.pick = ci + 1u;
  return o;
}
