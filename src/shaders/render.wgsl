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
@group(0) @binding(6) var<storage, read> veg: array<f32>;
// packed per-column render fields: x shadow z, y moisture, z fire glow, w flow speed
@group(0) @binding(7) var<storage, read> fields: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> water: array<f32>;
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
  // box bounds and its sway offset (sub-voxel canopies march inside the box)
  @location(5) @interpolate(flat) bmin: vec3<f32>,
  @location(6) @interpolate(flat) bsize: vec3<f32>,
  @location(7) @interpolate(flat) boff: vec3<f32>,
};

const FLAG_VEG_R: u32 = 2u;
const FLAG_DETAIL: u32 = 128u;

struct Box { x: f32, y: f32, sx: f32, sy: f32, z0: f32, z1: f32, mat: u32, flags: u32 };

fn unpackBox(v: vec4<u32>) -> Box {
  var b = Box(
    f32(v.x & 0xfffu), f32((v.x >> 12u) & 0xfffu),
    f32(((v.x >> 24u) & 0xfu) + 1u), f32(((v.x >> 28u) & 0xfu) + 1u),
    bitcast<f32>(v.y), bitcast<f32>(v.z), v.w & 0xffu, (v.w >> 8u) & 0xffu);
  // detail instances (grass tufts, flowers) are positioned in quarter cells
  if ((b.flags & FLAG_DETAIL) != 0u) {
    b.x *= 0.25; b.y *= 0.25; b.sx *= 0.25; b.sy *= 0.25;
  }
  return b;
}

/**
 * Vegetation sway in the shared wind field (prevailing wind, storms, gusts and
 * the cursor breeze): canopies shift rigidly, stems/shrubs/tufts bend (only
 * their top moves). Returns the offset for a vertex at height fraction h.
 */
fn swayOffset(b: Box, h: f32) -> vec3<f32> {
  let c = vec3<f32>(b.x + b.sx * 0.5, b.y + b.sy * 0.5, b.z1);
  let w = windAt(c);
  let ws = length(w);
  let dir = w / max(ws, 1e-3);
  let seed = fract(sin(dot(c.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453);
  let amp = clamp(ws / 6.0, 0.0, 1.6);
  let lean = dir * amp * 0.28;
  let flutter = dir * sin(G.time * (2.5 + amp * 5.0) + seed * 30.0) * 0.07 * (0.3 + amp);
  var k = h;
  if (b.mat == MAT_LEAVES && b.sx > 1.5) { k = 1.0; } // canopy: rigid
  return vec3<f32>((lean + flutter) * k, 0.0);
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
  var off = vec3<f32>(0.0);
  if ((b.flags & FLAG_VEG_R) != 0u) {
    let h = clamp((p.z - b.z0) / max(b.z1 - b.z0, 1e-3), 0.0, 1.0);
    off = swayOffset(b, h);
    p += off;
  }
  (*out).pos = CAM.viewProj * vec4<f32>(p, 1.0);
  (*out).wpos = p;
  (*out).bmin = vec3<f32>(b.x, b.y, b.z0);
  (*out).bsize = vec3<f32>(b.sx, b.sy, b.z1 - b.z0);
  (*out).boff = swayOffsetRigid(b, off);
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
  // pick: x = column+1 (0 = nothing), y = material | z<<8 | flags<<16
  @location(1) pick: vec2<u32>,
};

fn toLinear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn toSrgb(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }

/** Column whose fields describe this fragment (step slightly into the surface). */
fn fragCell(wpos: vec3<f32>, nrm: vec3<f32>) -> vec2<i32> {
  return clampCell(vec2<i32>(floor(wpos.xy - nrm.xy * 0.01)));
}

/** The box offset used by the sub-voxel march (only meaningful for rigid canopies). */
fn swayOffsetRigid(b: Box, off: vec3<f32>) -> vec3<f32> {
  if (b.mat == MAT_LEAVES && b.sx > 1.5) { return off; }
  return vec3<f32>(0.0);
}

fn sunDir() -> vec3<f32> { return normalize(vec3<f32>(G.sunX, G.sunY, G.sunZ)); }

/** Direct + ambient light with heightfield shadow and storm cloud shade. */
fn lighting(wpos: vec3<f32>, nrm: vec3<f32>) -> vec3<f32> {
  let sun = sunDir();
  let ndl = max(dot(nrm, sun), 0.0);
  let sc = clampCell(vec2<i32>(floor(wpos.xy + nrm.xy * 0.5)));
  let lit = select(0.0, 1.0, wpos.z >= fields[colIdxI(sc)].x - 0.05);
  let cloud = cloudShade(wpos.xy);
  // light comes from the day/night cycle (src/weather/daynight.ts)
  let sunCol = G.sunCol.rgb;
  let sky = G.sky.rgb;
  let day = 1.0 - G.sky.w;
  let ambient = sky * (0.5 + 0.5 * nrm.z) * (1.0 - cloud * 0.5);
  // warm bounce light from the opposite side keeps shaded faces readable
  let fill = max(dot(nrm, normalize(vec3<f32>(-sun.x, -sun.y, 0.4))), 0.0) * vec3<f32>(0.42, 0.36, 0.29) * (1.0 - cloud * 0.5) * (0.15 + 0.85 * day);
  let flash = G.misc.z * vec3<f32>(1.1, 1.2, 1.5) * (0.6 + 0.4 * nrm.z);
  // firelight: flickering orange from nearby flames (render fields .z)
  let glow = fields[colIdxI(sc)].z;
  let flick = 0.75 + 0.25 * vnoise(vec2<f32>(G.time * 9.0, wpos.x + wpos.y));
  let firelight = vec3<f32>(1.8, 0.75, 0.25) * glow * flick;
  return ambient + fill + flash + firelight + sunCol * ndl * lit * (1.0 - cloud * 0.93);
}

fn haze(c: vec3<f32>, wpos: vec3<f32>) -> vec3<f32> {
  let dirty = vec3<f32>(0.62, 0.57, 0.48);
  let clean = vec3<f32>(0.62, 0.70, 0.78);
  // haze darkens with the sky at night
  let h = mix(clean, dirty, G.pollution) * mix(1.0, 0.15, G.sky.w);
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

/**
 * Sub-voxel canopy: march the view ray through a 4×4×4-per-cell grid inside
 * the (swayed) leaf box; occupancy is a hash thinning toward the edges of an
 * ellipsoid, so crowns are lumpy with gaps you can see through. Returns
 * vec4(hit position, axis of the face hit + 1) or w = 0 for a miss.
 */
fn canopyMarch(in: VOut) -> vec4<f32> {
  let res = 4.0;
  let dims = in.bsize * res;
  let local = (in.wpos - in.boff - in.bmin) * res;
  let dir = -CAM.eye.xyz;
  var cell = floor(local - in.nrm * 0.01);
  let stepv = sign(dir);
  let tDelta = abs(1.0 / dir);
  var tMax = ((cell + max(stepv, vec3<f32>(0.0))) - local) / dir;
  var axis = select(select(1.0, 2.0, abs(in.nrm.y) > 0.5), 3.0, abs(in.nrm.z) > 0.5);
  let seed = vec3<i32>(floor(in.bmin * res));
  for (var i = 0; i < 40; i++) {
    if (any(cell < vec3<f32>(0.0)) || any(cell >= dims)) { break; }
    let c = (cell + 0.5) / dims - 0.5;
    let d = length(c * vec3<f32>(2.0, 2.0, 2.2));
    let density = 0.85 - 0.75 * d * d;
    if (randv(vec3<i32>(cell) + seed) < density) {
      let hit = in.bmin + in.boff + (cell + 0.5) / res;
      return vec4<f32>(hit, axis);
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) { cell.x += stepv.x; tMax.x += tDelta.x; axis = 1.0; }
    else if (tMax.y < tMax.z) { cell.y += stepv.y; tMax.y += tDelta.y; axis = 2.0; }
    else { cell.z += stepv.z; tMax.z += tDelta.z; axis = 3.0; }
  }
  return vec4<f32>(0.0);
}

@fragment
fn fsBox(in: VOut) -> FOut {
  // derivatives first: canopy fragments may discard below
  let gl = gridLines(in.wpos, in.nrm);
  let mat = in.info.x;
  let flags = in.info.y;
  var lpos = in.wpos;
  var lnrm = in.nrm;
  var canopyN = 0.0;
  if ((flags & 2u) != 0u && mat == MAT_LEAVES) {
    let h = canopyMarch(in);
    if (h.w == 0.0) { discard; }
    lpos = h.xyz;
    let eye = CAM.eye.xyz;
    if (h.w == 1.0) { lnrm = vec3<f32>(sign(eye.x), 0.0, 0.0); }
    else if (h.w == 2.0) { lnrm = vec3<f32>(0.0, sign(eye.y), 0.0); }
    else { lnrm = vec3<f32>(0.0, 0.0, 1.0); }
    canopyN = randv(vec3<i32>(floor(h.xyz * 4.0)));
  }
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
      // per-leaf-cluster hue, lighter on top, a few autumn-tinted clumps
      var lc = mix(vec3<f32>(0.14, 0.31, 0.11), fresh, canopyN * 0.8 + 0.25 * lnrm.z);
      if (canopyN > 0.93) { lc = mix(lc, vec3<f32>(0.55, 0.45, 0.16), 0.6); }
      alb = toLinear(lc);
    }
    if (mat == MAT_GRASS) {
      let gv = randv(vec3<i32>(floor(in.bmin * 4.0)));
      alb = toLinear(mix(vec3<f32>(0.28, 0.44, 0.15), vec3<f32>(0.46, 0.6, 0.22), gv) * (0.8 + 0.3 * smoothstep(in.zr.x, in.zr.y, in.wpos.z)));
    }
    if (mat == MAT_FLOWER) {
      let fv = randv(vec3<i32>(floor(in.bmin * 4.0)) + vec3<i32>(3, 9, 1));
      var petal = vec3<f32>(0.92, 0.9, 0.82);
      if (fv > 0.75) { petal = vec3<f32>(0.95, 0.8, 0.25); } else if (fv > 0.5) { petal = vec3<f32>(0.62, 0.48, 0.82); } else if (fv > 0.3) { petal = vec3<f32>(0.85, 0.35, 0.3); }
      let top = in.wpos.z > in.zr.y - 0.12;
      alb = toLinear(select(vec3<f32>(0.3, 0.46, 0.17), petal, top));
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
    let m = fields[ci].y;
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
        // wind running through the grass: bright bands travel downwind
        let w = windAt(vec3<f32>(in.wpos.xy, in.wpos.z + 0.5));
        let ws = length(w);
        let wd = w / max(ws, 1e-3);
        let wave = sin(dot(in.wpos.xy, wd) * 0.7 - G.time * (1.5 + ws * 0.6));
        g *= 1.0 + wave * 0.12 * clamp(ws / 4.0, 0.0, 1.5) * smoothstep(0.8, 1.8, v);
        alb = toLinear(g);
      }
    }
  }

  var col = alb * lighting(lpos, lnrm);
  col *= 1.0 - gl * select(1.0, 0.0, canopyN > 0.0);
  col = haze(col, lpos);

  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(ci + 1u, in.info.x | (u32(max(in.wpos.z, 0.0)) << 8u) | (in.info.y << 16u));
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
  let flow = fields[ci].w;
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
    col += G.sunCol.rgb * (1.0 / 2.4) * spec * 0.7;
    // foam where flowing fast
    let sub = vec3<i32>(floor(vec3<f32>(in.wpos.xy * 4.0, t * 6.0)));
    let foam = smoothstep(0.03, 0.25, flow) * step(0.72, randv(sub));
    col = mix(col, vec3<f32>(0.85, 0.85, 0.8), foam * 0.6);
    alpha = max(alpha, foam * 0.7);
    // rain rings
    let rain = rainAt(in.wpos.xy);
    let rsub = vec3<i32>(floor(vec3<f32>(in.wpos.xy * 3.0, t * 10.0)));
    col += vec3<f32>(0.25) * (1.0 - 0.8 * G.sky.w) * step(1.0 - 0.06 * rain, randv(rsub));
  }
  col *= 1.0 - gl * 0.3;
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), alpha);
  o.pick = vec2<u32>(ci + 1u, in.info.x | (u32(max(in.wpos.z, 0.0)) << 8u) | (in.info.y << 16u));
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
    col += G.sunCol.rgb * (1.0 / 2.4) * spec;
  }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), clamp(0.55 + d * 3.0, 0.55, 0.96));
  o.pick = vec2<u32>(ci + 1u, in.info.x | (u32(max(in.wpos.z, 0.0)) << 8u) | (in.info.y << 16u));
  return o;
}
