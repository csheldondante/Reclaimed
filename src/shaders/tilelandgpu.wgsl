// ---- a render-only tile's bake, set up on the GPU (round 105, tilelatency; render/tilelandgpu.ts) ---------------
// The user: "Why does the CPU readback and all of that happen all we care about is visuals until your character gets
// there." A region made for a tile (Atlas.regionTile) leaves its per-column summary on the GPU (finish.wgsl's: the
// surface, the ground, the top, the highest gap's roof — 4 f32 a column); from it, here, with nothing read back:
//   prep: each column's surface packed (common.wgsl sfPack) for the scratch's draws, and the region's lowest and
//         highest point (atomics, 1/256ths);
//   camera: the bake's box from those — the region and a cell round it, its lowest to its highest — its scale (the
//         frame's px a unit at most, what fits the slot), the bake camera's matrix (render.wgsl Camera: written over
//         the frame's, which the CPU put there), and what the tile was baked at (TP, the slot's: tiles.wgsl vsTile).
// Self-contained: no common.wgsl.

struct Job {
  /** the view's right, up, along (unit; along's w: the clip depth a unit), the scale: x the frame's render px a unit,
   *  y the scratch's oz (world z of its z 0), z the atlas slot, w unused */
  r: vec4<f32>,
  u: vec4<f32>,
  f: vec4<f32>,
  misc: vec4<f32>,
  /** the slot's corner in the atlas (px), its size (px) */
  slot: vec4<f32>,
  /** the region's anchor in the scratch's coordinates (its corner, world z 0), its size (cells), the overlap (cells) */
  anchor: vec4<f32>,
  size: vec4<f32>,
};
@group(0) @binding(0) var<uniform> J: Job;
@group(0) @binding(1) var<storage, read> summ: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> surfaceOut: array<u32>;
@group(0) @binding(3) var<storage, read_write> box: array<atomic<i32>, 2>;
@group(0) @binding(4) var<storage, read_write> cam: array<f32>;
@group(0) @binding(5) var<storage, read_write> TP: array<vec4<f32>>;

const R: u32 = 64u;

fn pack(z: f32) -> u32 { return min(u32(round(max(z, 0.0) * 256.0)), 0x1ffffu); }

@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= R || id.y >= R) { return; }
  let i = id.y * R + id.x;
  let m = summ[i];
  surfaceOut[i] = pack(m.x);
  // (its lowest: the surface; its highest: the top (world z, so less oz) or the surface)
  atomicMin(&box[0], i32(floor(m.x * 256.0)));
  atomicMax(&box[1], i32(ceil(max(m.z - J.misc.y, m.x) * 256.0)));
}

@compute @workgroup_size(1)
fn camera() {
  let lo = f32(atomicLoad(&box[0])) / 256.0 - 2.0;
  let hi = f32(atomicLoad(&box[1])) / 256.0 + 2.0;
  let oz = J.misc.y;
  let ov = J.size.y;
  var a0 = 1e30;
  var a1 = -1e30;
  var b0 = 1e30;
  var b1 = -1e30;
  for (var k = 0u; k < 8u; k++) {
    let x = select(-ov, J.size.x + ov, (k & 1u) != 0u);
    let y = select(-ov, J.size.x * 0.8660254 + ov, (k & 2u) != 0u);
    // (relative to the anchor: world z = the scratch's z + oz)
    let z = select(lo, hi, (k & 4u) != 0u) + oz;
    let p = vec3<f32>(x, y, z);
    let a = dot(J.r.xyz, p);
    let b = dot(J.u.xyz, p);
    a0 = min(a0, a);
    a1 = max(a1, a);
    b0 = min(b0, b);
    b1 = max(b1, b);
  }
  let SW = J.slot.z;
  let SH = J.slot.w;
  let dens = min(J.misc.x, min((SW - 1.0) / (a1 - a0), (SH - 1.0) / (b1 - b0)));
  let tw = min(SW, ceil((a1 - a0) * dens) + 1.0);
  let th = min(SH, ceil((b1 - b0) * dens) + 1.0);
  // the bake's camera: the view's rotation, the tile's scale, the region's box from the slot's top left (the viewport
  // is the whole slot: a texel is 1 / dens either way)
  let kx = 2.0 * dens / SW;
  let ky = 2.0 * dens / SH;
  let aw = J.anchor.xyz;
  let ra = dot(J.r.xyz, aw);
  let ua = dot(J.u.xyz, aw);
  let fa = dot(J.f.xyz, aw);
  let sz = J.f.w;
  cam[0] = J.r.x * kx; cam[1] = J.u.x * ky; cam[2] = J.f.x * sz; cam[3] = 0.0;
  cam[4] = J.r.y * kx; cam[5] = J.u.y * ky; cam[6] = J.f.y * sz; cam[7] = 0.0;
  cam[8] = J.r.z * kx; cam[9] = J.u.z * ky; cam[10] = J.f.z * sz; cam[11] = 0.0;
  cam[12] = -(ra + a0) * kx - 1.0; cam[13] = 1.0 - (b1 + ua) * ky; cam[14] = 0.5 - fa * sz; cam[15] = 1.0;
  // (viewport.w: world units a texel, for the painted trees' edges — tiles.wgsl tileTrees)
  cam[23] = 1.0 / dens;
  // (pos: the slot's corner, the anchor's distance along the view; w 0: the fixed view — camera.ts CAMERA_POS_OFFSET)
  cam[40] = J.slot.x;
  cam[41] = J.slot.y;
  cam[42] = fa;
  cam[43] = 0.0;
  let s = u32(J.misc.z);
  TP[s * 2u] = vec4<f32>(a0, b1, dens, 0.0);
  TP[s * 2u + 1u] = vec4<f32>(tw, th, hi + oz, 1.0);
}
