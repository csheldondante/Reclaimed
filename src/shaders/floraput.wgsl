// ---- placing a flora library plant (round 117; src/flora) -------------------------------------------------------
// Shared by vegprep.wgsl (the succession field's plants) and florafield.wgsl (the plants placed by other fields:
// reeds by water). The kernel declares `indirect` (the draw args, atomic) and `instTree` (the instances: four vec4s
// each, MI_CAP a kind — render/meshinst.ts) and binds the camera at 31 (PC).

/**
 * (round 117, flora) A plant of species range r (first kind, variants) at column c: a variant by the column's hash,
 * turned, scaled by `scale` (± 10 %), leaning up to `lean` (a skew: the foot stays put). Offset within the cell by
 * `off` (quarter cells, so small plants don't line up on the grid). Its sway comes from the column's bend in the draw.
 */
fn floraPut(r: vec2<u32>, c: vec2<u32>, at: vec2<f32>, top: f32, scale: f32, lean: f32, salt: u32) {
  let k = r.x + min(u32(rand3(c.x, c.y, 530u + salt) * f32(r.y)), r.y - 1u);
  let j = atomicAdd(&indirect[MI_ARGS + k * 5u + 1u], 1u);
  if (j >= MI_CAP) { return; }
  let yaw = rand3(c.x, c.y, 517u + salt) * 6.2831853;
  let lx = (rand3(c.x, c.y, 518u + salt) - 0.5) * 2.0 * lean;
  let ly = (rand3(c.x, c.y, 519u + salt) - 0.5) * 2.0 * lean;
  let s = scale * (0.9 + 0.2 * rand3(c.x, c.y, 520u + salt));
  let cs = cos(yaw) * s;
  let sn = sin(yaw) * s;
  let o = (k * MI_CAP + j) * 4u;
  instTree[o] = vec4<f32>(cs, -sn, lx * s, at.x);
  instTree[o + 1u] = vec4<f32>(sn, cs, ly * s, at.y);
  instTree[o + 2u] = vec4<f32>(0.0, 0.0, s, top);
  instTree[o + 3u] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
// (round 117, flora) the view, as renderprep.wgsl's PrepCam (the renderer's camera buffer: render.wgsl Camera's head)
struct PrepCam {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
  light: mat4x4<f32>,
};
@group(0) @binding(31) var<uniform> PC: PrepCam;

/** Is a plant at `at` on ground `top`, `h` tall and `r` across, or the shadow its top casts, on screen? */
fn floraSeen(at: vec2<f32>, top: f32, h: f32, r: f32) -> bool {
  var sh = vec2<f32>(0.0);
  if (G.sunZ > 0.02) { sh = -vec2<f32>(G.sunX, G.sunY) / G.sunZ * h; }
  if (length(sh) > 40.0) { sh *= 40.0 / length(sh); }
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  let pts = array<vec3<f32>, 3>(vec3<f32>(at, top), vec3<f32>(at, top + h), vec3<f32>(at + sh, top));
  for (var k = 0u; k < 3u; k++) {
    let q = PC.viewProj * vec4<f32>(pts[k], 1.0);
    if (q.w <= 1e-3) { return true; }
    lo = min(lo, q.xy / q.w);
    hi = max(hi, q.xy / q.w);
  }
  // (its width on screen: r cells at the view's pixels a cell, in clip units)
  let pad = 2.0 * r * PC.viewport.z / max(min(PC.viewport.x, PC.viewport.y), 1.0) + 0.04;
  return all(hi > vec2<f32>(-1.0 - pad)) && all(lo < vec2<f32>(1.0 + pad));
}

