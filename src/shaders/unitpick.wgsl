// ---- unitpick.wgsl -------------------------------------------------------------------------------------------------
// (round 128p, DA-B22 (c)(2)) A tap's unit, found on the GPU (agents/pick.ts): over the candidates the game names
// (their slots), each live one's figure middle (its feet + `lift`) projected with the camera's matrix as the camera's
// own project() does; the nearest to the tap within `radius` CSS pixels wins (atomicMin over its distance, quantised,
// and its index in the list). One u32 read back a tap.

@group(0) @binding(7) var<storage, read> units: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> cand: array<u32>;
@group(0) @binding(2) var<storage, read_write> best: array<atomic<u32>, 1>;

struct PickParams {
  viewProj: mat4x4<f32>,
  // x y the viewport (CSS px), z w the tap
  view: vec4<f32>,
  // x the radius (px), y the lift (cells), z the candidates, w unused
  p: vec4<f32>,
};
@group(0) @binding(3) var<uniform> PP: PickParams;

const UNIT_V: u32 = 6u;
/** the distance's steps a pixel (key = distance × Q, then the candidate's index in the low 13 bits) */
const Q: f32 = 64.0;

@compute @workgroup_size(64)
fn pick(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= u32(PP.p.z)) { return; }
  let s = cand[k];
  let a = units[s * UNIT_V];
  if (((bitcast<u32>(a.w) >> 8u) & 1u) == 0u) { return; }
  let c = PP.viewProj * vec4<f32>(a.x, a.y, a.z + PP.p.y, 1.0);
  let w = max(c.w, 1e-4);
  let px = vec2<f32>((c.x / w + 1.0) * 0.5 * PP.view.x, (1.0 - c.y / w) * 0.5 * PP.view.y);
  let d = length(px - PP.view.zw);
  if (d >= PP.p.x) { return; }
  atomicMin(&best[0], (u32(d * Q) << 13u) | k);
}
