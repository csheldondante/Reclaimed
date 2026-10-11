// ---- visibility / render preparation --------------------------------------
// Turns world state into box instances for the renderer:
//   opaque: one box per layered interval (vegetation: vegprep.wgsl)
//   liquid: one box per column for water and one for oil floating on it
// Appends with one global atomic per workgroup (local prefix via workgroup
// atomics) to avoid contention on the indirect-args counters.
//
// Instance (vec4<u32>):
//   x: x | y<<12 | (sx-1)<<24 | (sy-1)<<28
//   y: bitcast z0 (f32)   z: bitcast z1 (f32)
//   w: material | flags<<8
//      flags: 1 = top of column, 2 = vegetation,
//             4/8/16/32 = side face toward +x/-x/+y/-y hidden, 64 = top face hidden
// Visibility: a side face is hidden when the neighbour's solid ground stack
// (contiguous from z=0) reaches the interval's top; a top face is hidden when
// the next interval sits directly on it. Fully hidden intervals are not
// emitted at all (camera-independent, so rotation stays correct).
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> surface: array<u32>;
@group(0) @binding(5) var<storage, read> water: array<f32>;
@group(0) @binding(6) var<storage, read> oil: array<f32>;
@group(0) @binding(7) var<storage, read_write> instOpaque: array<vec4<u32>>;
@group(0) @binding(8) var<storage, read_write> instWater: array<vec4<u32>>;
// [0..3] opaque draw args, [4..7] water draw args (instanceCount at 1 and 5)
@group(0) @binding(9) var<storage, read_write> indirect: array<atomic<u32>>;

const FLAG_TOP: u32 = 1u;
const FLAG_VEG: u32 = 2u;
const HIDE_TOP: u32 = 64u;
const HIDE_ALL: u32 = 4u | 8u | 16u | 32u | 64u;

/** z of the top of the contiguous stack starting at the ground (0 outside the map). */
fn groundTop(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  let cs = colSlots(u32(q.x), u32(q.y));
  var t = 0.0;
  for (var i = 0u; i < cs.y; i++) {
    let v = layers[cs.x + i];
    if (ivEmpty(v) || abs(ivZ0(v) - t) > 1e-3) { break; }
    t = ivZ1(v);
  }
  return t;
}

fn hideFlags(gt: vec4<f32>, z1: f32, nextZ0: f32) -> u32 {
  var f = 0u;
  if (gt.x >= z1) { f |= 4u; }
  if (gt.y >= z1) { f |= 8u; }
  if (gt.z >= z1) { f |= 16u; }
  if (gt.w >= z1) { f |= 32u; }
  if (abs(nextZ0 - z1) < 1e-3) { f |= HIDE_TOP; }
  return f;
}
const WATER_MIN: f32 = 0.012;
const OIL_MIN: f32 = 0.004;

var<workgroup> wgO: atomic<u32>;
var<workgroup> wgW: atomic<u32>;
var<workgroup> baseO: u32;
var<workgroup> baseW: u32;

fn mkInst(x: u32, y: u32, sx: u32, sy: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  return vec4<u32>(x | (y << 12u) | ((sx - 1u) << 24u) | ((sy - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | (flags << 8u));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgO, 0u); atomicStore(&wgW, 0u); }
  workgroupBarrier();

  let inside = id.x < G.mapW && id.y < G.mapH;
  var nO = 0u;
  var nW = 0u;
  var cs = vec2<u32>(0u);
  var nSlots = 0u;
  var top = 0.0;
  var d = 0.0;
  var ol = 0.0;
  var gt = vec4<f32>(0.0);
  var nVis = 0u;
  if (inside) {
    let i = colIdx(id.x, id.y);
    cs = colSlots(id.x, id.y);
    let s = surface[i];
    nSlots = sfCount(s);
    top = sfZ(s);
    d = water[i];
    ol = oil[i];
    let p = vec2<i32>(id.xy);
    gt = vec4<f32>(groundTop(p + DIRS[0]), groundTop(p + DIRS[1]), groundTop(p + DIRS[2]), groundTop(p + DIRS[3]));
    for (var k = 0u; k < nSlots; k++) {
      let v = layers[cs.x + k];
      var nz = 9999.0;
      if (k + 1u < nSlots) { nz = ivZ0(layers[cs.x + k + 1u]); }
      if (hideFlags(gt, ivZ1(v), nz) != HIDE_ALL) { nVis += 1u; }
    }
    nO = nVis;
    nW = select(0u, 1u, d > WATER_MIN) + select(0u, 1u, ol > OIL_MIN);
  }
  let offO = atomicAdd(&wgO, nO);
  let offW = atomicAdd(&wgW, nW);
  workgroupBarrier();
  if (li == 0u) {
    baseO = atomicAdd(&indirect[1], atomicLoad(&wgO));
    baseW = atomicAdd(&indirect[5], atomicLoad(&wgW));
  }
  workgroupBarrier();
  if (!inside) { return; }

  var o = baseO + offO;
  for (var k = 0u; k < nSlots; k++) {
    let v = layers[cs.x + k];
    var nz = 9999.0;
    if (k + 1u < nSlots) { nz = ivZ0(layers[cs.x + k + 1u]); }
    let hide = hideFlags(gt, ivZ1(v), nz);
    if (hide == HIDE_ALL) { continue; }
    let flags = select(0u, FLAG_TOP, k + 1u == nSlots) | hide;
    var inst = mkInst(id.x, id.y, 1u, 1u, ivZ0(v), ivZ1(v), ivMat(v), flags);
    inst.w |= (ivAux(v) & 15u) << 16u; // structural damage → cracks
    instOpaque[o] = inst;
    o += 1u;
  }
  var w = baseW + offW;
  // liquids lie on top of drifted dust (it sinks; round 13)
  let bed = max(top + driftAt(vec2<i32>(id.xy)), bodyTopAt(vec2<i32>(id.xy)));
  if (d > WATER_MIN) {
    instWater[w] = mkInst(id.x, id.y, 1u, 1u, bed, bed + d, MAT_WATER, 0u);
    w += 1u;
  }
  if (ol > OIL_MIN) {
    // oil floats on whatever water is here (even a thin film)
    let base = bed + max(d, 0.0);
    instWater[w] = mkInst(id.x, id.y, 1u, 1u, base, base + max(ol, 0.06), MAT_OIL, 0u);
  }
}
