// ---- atlas/lod.wgsl -------------------------------------------------------
// The land round the window in rings of less detail (round 83, the user: "I want some sort of LOD so that I
// can zoom out and still see more of the map loaded"): each ring a grid of the same ground the streamer's
// columns are made from (compose.wgsl ground), a vertex every 2, 4, 8, 16 cells — its top (the ground, a
// mesa's lip, what's loose on it; water's level where the sea or a river stands over it) and its colour.
// Drawn by far.wgsl (vsLod). No forms, caves or edits: those are the window's.

struct LodP {
  /** the ring's texel (0, 0) in the world (world units), its spacing, texels a side */
  org: vec4<f32>,
  /** where its texels go in lodOut */
  at: vec4<u32>,
}
@group(0) @binding(50) var<uniform> LP: LodP;
/** a texel: its top (world z) and its colour (pack4x8unorm, bitcast) */
@group(0) @binding(51) var<storage, read_write> lodOut: array<vec2<f32>>;
/** each material's albedo (materials.ts) */
@group(0) @binding(52) var<storage, read> lodAlbedo: array<vec4<f32>>;

/** a region's ground: its top's colour, green where it grows */
fn regionColour(r: Region) -> vec3<f32> {
  let c = lodAlbedo[r.topMat].rgb;
  return mix(c, vec3<f32>(0.34, 0.52, 0.2), 0.65 * smoothstep(0.3, 0.7, r.veg));
}

@compute @workgroup_size(8, 8)
fn lodHeight(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = u32(LP.org.w);
  if (id.x >= n || id.y >= n) { return; }
  let size = vec2<f32>(AP.worldW, AP.worldH);
  var p = LP.org.xy + vec2<f32>(id.xy) * LP.org.z;
  p = p - floor(p / size) * size;
  let g = ground(p);
  var h = g.h;
  // (a mesa's lip over its overhang: colHeight's top)
  if (g.ov.z > g.ov.y && g.ov.x > h) { h = g.ov.x; }
  h += g.loose;
  // (the two regions' grounds blended as the ground's own border is: no steps of the macro map's texels)
  var c = mix(regionColour(regs[g.b]), regionColour(regs[g.a]), clamp(g.w, 0.0, 1.0));
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
  lodOut[LP.at.x + id.y * n + id.x] = vec2<f32>(top, bitcast<f32>(pack4x8unorm(vec4<f32>(c, 1.0))));
}
