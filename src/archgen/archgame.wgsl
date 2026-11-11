// (archgen) The game's host for draw.wgsl: appended to the renderer's draw module (common, materials, terrain shape,
// renderWgsl), so `instances` (binding 3: the arch buffer), CAM (binding 10: the view's or the sun's camera) and
// MESH_XF (binding 28: the town's frame in the window, render/bodies.wgsl) are render.wgsl's. Lit, hazed, cut away and
// picked as the game's other meshes are (meshinst.wgsl fsInst). Order: arch.wgsl's constants, this head, draw.wgsl,
// this file's fragment part (archgen.ts ARCH_GAME).

fn archClip(w: vec3<f32>) -> vec4<f32> { return CAM.viewProj * vec4<f32>(w, 1.0); }
fn archPlace() -> vec3<f32> { return MESH_XF.xyz; }
// (night lights in the windows: SW-G6, later)
fn archNight() -> f32 { return 0.0; }
fn archTime() -> f32 { return G.time; }
fn archDetail() -> f32 { return ARCH_DETAIL; }

// ---- fragment (appended after draw.wgsl) ----
@fragment
fn fsArch(in: VO) -> FOut {
  // (derivatives first: the cut may discard)
  let sf = archSurface(in);
  var n = normalize(in.nrm);
  // (a clipped shell's inside, seen through the cut: drawn as its dark section)
  let inside = dot(n, toEye(in.wpos)) < 0.0;
  if (inside) { n = -n; }
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  var col = toLinear(sf.col) * lighting(in.wpos, n) * sf.ao;
  if (inside) { col *= 0.25; }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(0u, pickInfo(MAT_STONE, in.wpos.z, 0u));
  return o;
}
