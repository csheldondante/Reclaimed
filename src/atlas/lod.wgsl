// ---- atlas/lod.wgsl -------------------------------------------------------
// The land round the window in rings of less detail (round 83, the user: "I want some sort of LOD so that I
// can zoom out and still see more of the map loaded"): each ring a grid of the same ground the streamer's
// columns are made from (compose.wgsl ground), a vertex every 2, 4, 8, 16 cells — its top (the ground, a
// mesa's lip, what's loose on it; water's level where the sea or a river stands over it) and its colour.
// Drawn by far.wgsl (vsLod). No forms, caves or edits: those are the window's. A ring is anchored to the
// world (its texels on the world's lattice of its spacing), held round in its slots: as the camera moves,
// only the strips new to it are made; a slide of the window makes nothing.

struct LodP {
  /** the ring's window now and as it was made (world texel indices of its corner: a texel (I, J) stands at
   *  (I, J) · spacing in the world), the slots' rows refreshed (r0 ≤ row < r1) */
  now: vec4<i32>,
  /** the spacing, texels a side, where its slots start in lodOut */
  sp: vec4<f32>,
  at: vec4<u32>,
}
@group(0) @binding(50) var<uniform> LP: LodP;
/** a slot: its top (world z), its colour (pack4x8unorm, bitcast: rgb, its material / 255 in a), (hybrid) the
 *  ground under any water (world z), the rock its faces show (rgb, its material / 255 in a); a ring's texel
 *  (I, J) is in slot (I mod n, J mod n) — moving the ring makes only the texels new to it */
@group(0) @binding(51) var<storage, read_write> lodOut: array<vec4<f32>>;
/** each material's albedo (materials.ts; round 93: a uniform — the kernel's storage buffers are at the limit) */
@group(0) @binding(52) var<uniform> lodAlbedo: array<vec4<f32>, 64>;
/** (round 93) the atlas's ways binned (lod.ts wayBins): nbx, nby, the bin's side (bits), 0; nbx·nby + 1 offsets into
 *  the points after them; a point a word (x · 3 | y · 3 << 16, world units) — each in every bin within WAY_REACH of it */
@group(0) @binding(53) var<storage, read> lodWays: array<u32>;
const WAY_REACH: f32 = 3.2;
/** ways.ts HALF: a way's half width (paved) */
const WAY_HALF: f32 = 2.2;

/** (round 93) the distance from world point p to the nearest way's point (≤ WAY_REACH) */
fn wayDist(p: vec2<f32>) -> f32 {
  let nbx = lodWays[0];
  let nby = lodWays[1];
  let bs = bitcast<f32>(lodWays[2]);
  if (nbx == 0u) { return WAY_REACH; }
  let b = vec2<u32>(clamp(vec2<i32>(floor(p / bs)), vec2<i32>(0), vec2<i32>(i32(nbx) - 1, i32(nby) - 1)));
  let k = b.y * nbx + b.x;
  let o = 4u + nbx * nby + 1u;
  let a0 = lodWays[4u + k];
  let a1 = lodWays[5u + k];
  let size = vec2<f32>(AP.worldW, AP.worldH);
  var d2 = WAY_REACH * WAY_REACH;
  for (var i = a0; i < a1; i++) {
    let w = lodWays[o + i];
    var d = vec2<f32>(f32(w & 0xffffu), f32(w >> 16u)) / 3.0 - p;
    d -= round(d / size) * size;
    d2 = min(d2, dot(d, d));
  }
  return sqrt(d2);
}

/** (round 93) the plants a column starts with (forms.wgsl colFinish's o.veg, the window's: 0..4.2) at world point p */
fn startVeg(p: vec2<f32>, R: Region, g: Ground, h: f32, snowy: bool, wet: bool) -> f32 {
  if (R.veg <= 0.0 || snowy || h >= AP.sea + 70.0 || g.smat != 0u || g.cap != 0u || R.cover <= 0.0) { return 0.0; }
  var m = moistureAt(p, g.coast, R.moist);
  if (wet || g.rx < 1.0 || (g.lk > 0.0 && h < g.lk + 2.0)) { m = max(m, 0.8); }
  let woods = smoothstep(0.05, 0.35, pfbm(torusU(p), perOf(55.0), 3u, AP.seed + 6u)) * smoothstep(AP.sea + 60.0, AP.sea + 20.0, h);
  let x = i32(floor(p.x));
  let y = i32(floor(p.y / ROW_H_A));
  let v = clamp(R.veg * (1.0 + m * 1.6 + woods * 2.2) + (hf(hash2u(x, y, AP.seed + 7u)) - 0.5) * 0.6, 0.0, 4.2);
  let lz = select(0.0, g.loose, g.loose > 0.05 && g.lmat != 0u);
  return v * clamp(1.0 - lz * 2.0, 0.0, 1.0);
}

fn pmod(a: i32, n: i32) -> i32 { return ((a % n) + n) % n; }

/** a region's ground at height h: its top's colour (round 93: bare — its plants are drawn from the slot's veg, as the
 *  window draws them, far.wgsl ringPlants) */
fn regionColour(r: Region, h: f32) -> vec3<f32> {
  return lodAlbedo[r.topMat].rgb;
}

/** (round 94) what the ground is at a world point, by the rings' rules: its top (world z: water's where it stands), the
 *  ground under it, its colour (sRGB), the top's and the rock's materials, the plants it starts with, the way's
 *  distance, whether it glows (lava) */
struct Surf {
  top: f32,
  h: f32,
  c: vec3<f32>,
  mat: u32,
  rock: u32,
  veg: f32,
  wd: f32,
  glow: f32,
}

fn surfaceAt(p: vec2<f32>) -> Surf {
  let g = ground(p);
  var h = g.h;
  // (a mesa's lip over its overhang: colHeight's top)
  if (g.ov.z > g.ov.y && g.ov.x > h) { h = g.ov.x; }
  h += g.loose;
  // (the two regions' grounds blended as the ground's own border is: no steps of the macro map's texels)
  var c = mix(regionColour(regs[g.b], h), regionColour(regs[g.a], h), clamp(g.w, 0.0, 1.0));
  // (hybrid: what's on top, and the rock under it — the faces too steep to hold the top show it, far.wgsl)
  let ra = regs[select(g.b, g.a, g.w >= 0.5)];
  var mat = ra.topMat;
  let rock = ra.rockMat;
  if (g.smat != 0u) { mat = g.smat; }
  if (g.loose > 0.1) { mat = g.lmat; }
  if (g.smat != 0u) { c = lodAlbedo[g.smat].rgb; }
  if (g.cap != 0u) { c = vec3<f32>(0.18, 0.17, 0.18); }
  if (g.loose > 0.1) { c = mix(c, lodAlbedo[g.lmat].rgb, clamp(g.loose, 0.0, 1.0)); }
  let snowy = temperature(p, h) < 0.0;
  if (snowy && h > AP.sea) {
    c = vec3<f32>(0.86, 0.88, 0.92);
    // (round 93: and snow's its top, as the window's — no grass drawn over it)
    if (g.smat == 0u && g.cap == 0u) { mat = 25u; }
  }
  // (round 93: the window's top where it's wet — sand or silt by the sea, a lake's beach, a river's bed —
  // forms.wgsl colFinish; and the plants it starts with, and the ways)
  let wet = h < AP.sea + 1.2;
  let river = g.rx < 1.0;
  if (wet && !snowy && g.smat == 0u && g.loose <= 0.1) {
    mat = select(3u, 22u, ra.topMat == 22u);
    c = lodAlbedo[mat].rgb;
  }
  if (river && g.rflags != 1u && g.smat == 0u && g.loose <= 0.1) {
    mat = select(3u, 22u, g.rx < 0.5);
    c = lodAlbedo[mat].rgb;
  }
  if (g.lk > 0.0 && !river && g.lkw && h < g.lk + 1.5 && h >= g.lk - 0.6) {
    mat = 3u;
    c = lodAlbedo[mat].rgb;
  }
  var veg = select(startVeg(p, ra, g, h, snowy, wet), 0.0, h < AP.sea || (g.lkw && g.lk > h) || (river && g.rl > h));
  let wd = wayDist(p);
  if (wd < WAY_HALF + 0.5) { veg = 0.0; }
  var top = h;
  var glow = 0.0;
  // water over it: the sea, a river (lava glowing)
  if (h < AP.sea) {
    top = AP.sea;
    c = mix(vec3<f32>(0.2, 0.36, 0.42), vec3<f32>(0.08, 0.18, 0.3), clamp((AP.sea - h) / 20.0, 0.0, 1.0));
  } else if (g.lkw && g.lk > h) {
    // (round 90) a lake, at its level
    top = g.lk;
    c = mix(vec3<f32>(0.2, 0.4, 0.5), vec3<f32>(0.1, 0.24, 0.36), clamp((g.lk - h) / 12.0, 0.0, 1.0));
  } else if (g.rx < 1.0 && g.rl > h) {
    top = g.rl;
    c = select(vec3<f32>(0.2, 0.4, 0.55), vec3<f32>(1.0, 0.45, 0.1), g.rflags == 1u);
    if (g.rflags == 1u) { glow = 1.0; }
  }
  if (g.clava > 0.05) {
    c = mix(c, vec3<f32>(1.0, 0.4, 0.06), clamp(g.clava, 0.0, 1.0));
    glow = max(glow, clamp(g.clava, 0.0, 1.0));
  }
  return Surf(top, h, c, mat, rock, veg, wd, glow);
}

@compute @workgroup_size(8, 8)
fn lodHeight(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = i32(LP.sp.y);
  if (i32(id.x) >= n || i32(id.y) >= n) { return; }
  // the texel this slot holds in the window now, and whether it held it before (or its row is refreshed)
  let I = LP.now.x + pmod(i32(id.x) - LP.now.x, n);
  let J = LP.now.y + pmod(i32(id.y) - LP.now.y, n);
  let had = I >= LP.now.z && I < LP.now.z + n && J >= LP.now.w && J < LP.now.w + n;
  let row = i32(id.y);
  if (had && !(row >= i32(LP.at.y) && row < i32(LP.at.z))) { return; }
  let size = vec2<f32>(AP.worldW, AP.worldH);
  var p = vec2<f32>(f32(I), f32(J)) * LP.sp.x;
  p = p - floor(p / size) * size;
  let s = surfaceAt(p);
  let ca = pack4x8unorm(vec4<f32>(s.c, f32(s.mat) / 255.0));
  // (round 93: the rock's material, the plants (0..4.2 in 1/60), the way's distance (0..WAY_REACH) — the rock's colour is
  // its material's, far.wgsl)
  let rc = (s.rock & 0xffu) | (u32(round(clamp(s.veg, 0.0, 4.25) * 60.0)) << 8u) | (u32(round(s.wd / WAY_REACH * 255.0)) << 16u);
  lodOut[LP.at.x + id.y * u32(n) + id.x] = vec4<f32>(s.top, bitcast<f32>(ca), s.h, bitcast<f32>(rc));
}
