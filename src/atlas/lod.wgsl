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
/** each material's albedo (materials.ts) */
@group(0) @binding(52) var<storage, read> lodAlbedo: array<vec4<f32>>;

fn pmod(a: i32, n: i32) -> i32 { return ((a % n) + n) % n; }

/** a region's ground at height h: its top's colour, green where it grows */
fn regionColour(r: Region, h: f32) -> vec3<f32> {
  let c = lodAlbedo[r.topMat].rgb;
  // (hybrid: no green from 70 over the sea up — the columns' plants stop there, forms.wgsl colFinish)
  return mix(c, vec3<f32>(0.34, 0.52, 0.2), 0.65 * smoothstep(0.3, 0.7, r.veg) * (1.0 - smoothstep(AP.sea + 58.0, AP.sea + 70.0, h)));
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
  if (temperature(p, h) < 0.0 && h > AP.sea) { c = vec3<f32>(0.86, 0.88, 0.92); }
  var top = h;
  // water over it: the sea, a river (lava glowing)
  if (h < AP.sea) {
    top = AP.sea;
    c = mix(vec3<f32>(0.2, 0.36, 0.42), vec3<f32>(0.08, 0.18, 0.3), clamp((AP.sea - h) / 20.0, 0.0, 1.0));
  } else if (g.rx < 1.0 && g.rl > h) {
    top = g.rl;
    c = select(vec3<f32>(0.2, 0.4, 0.55), vec3<f32>(1.0, 0.45, 0.1), g.rflags == 1u);
  }
  if (g.clava > 0.05) { c = mix(c, vec3<f32>(1.0, 0.4, 0.06), clamp(g.clava, 0.0, 1.0)); }
  let ca = pack4x8unorm(vec4<f32>(c, f32(mat) / 255.0));
  let rc = pack4x8unorm(vec4<f32>(lodAlbedo[rock].rgb, f32(rock) / 255.0));
  lodOut[LP.at.x + id.y * u32(n) + id.x] = vec4<f32>(top, bitcast<f32>(ca), h, bitcast<f32>(rc));
}
