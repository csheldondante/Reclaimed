// ---- visibility / render preparation --------------------------------------
// Turns world state into box instances for the renderer:
//   opaque: one box per layered interval + vegetation shrubs/trees
//   water:  one box per column with water above its surface
// Appends with one global atomic per workgroup (local prefix via workgroup
// atomics) to avoid contention on the indirect-args counters.
//
// Instance (vec4<u32>):
//   x: x | y<<12 | (sx-1)<<24 | (sy-1)<<28
//   y: bitcast z0 (f32)   z: bitcast z1 (f32)
//   w: material | flags<<8   (flags: 1 = top of column, 2 = vegetation)
@group(0) @binding(3) var<storage, read> layers: array<u32>;
@group(0) @binding(4) var<storage, read> surface: array<u32>;
@group(0) @binding(5) var<storage, read> water: array<f32>;
@group(0) @binding(6) var<storage, read> veg: array<f32>;
@group(0) @binding(7) var<storage, read_write> instOpaque: array<vec4<u32>>;
@group(0) @binding(8) var<storage, read_write> instWater: array<vec4<u32>>;
// [0..3] opaque draw args, [4..7] water draw args (instanceCount at 1 and 5)
@group(0) @binding(9) var<storage, read_write> indirect: array<atomic<u32>>;

const FLAG_TOP: u32 = 1u;
const FLAG_VEG: u32 = 2u;
const WATER_MIN: f32 = 0.012;

var<workgroup> wgO: atomic<u32>;
var<workgroup> wgW: atomic<u32>;
var<workgroup> baseO: u32;
var<workgroup> baseW: u32;

fn mkInst(x: u32, y: u32, sx: u32, sy: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  return vec4<u32>(x | (y << 12u) | ((sx - 1u) << 24u) | ((sy - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | (flags << 8u));
}

struct VegPlan { shrub: bool, tree: bool, trunk: f32, crown: f32 };

fn vegPlan(x: u32, y: u32, v: f32) -> VegPlan {
  var pl = VegPlan(false, false, 0.0, 0.0);
  let h = rand3(x, y, 4242u);
  let edge = x == 0u || y == 0u || x + 1u >= G.mapW || y + 1u >= G.mapH;
  if (v >= 3.6 && h < 0.07 && !edge) {
    pl.tree = true;
    pl.trunk = 2.0 + floor(clamp(v - 3.6, 0.0, 1.4) * 2.5) + floor(rand3(x, y, 7u) * 2.0);
    pl.crown = 2.0 + select(0.0, 1.0, v > 4.5);
  } else if (v >= 2.6 && h < 0.3) {
    pl.shrub = true;
  }
  return pl;
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
  var pl = VegPlan(false, false, 0.0, 0.0);
  if (inside) {
    let i = colIdx(id.x, id.y);
    cs = colSlots(id.x, id.y);
    let s = surface[i];
    nSlots = (s >> 16u) & 0xffu;
    top = f32(sfZ(s));
    d = water[i];
    pl = vegPlan(id.x, id.y, veg[i]);
    nO = nSlots + select(0u, 1u, pl.shrub) + select(0u, 2u, pl.tree);
    nW = select(0u, 1u, d > WATER_MIN);
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
    let flags = select(0u, FLAG_TOP, k + 1u == nSlots);
    instOpaque[o] = mkInst(id.x, id.y, 1u, 1u, f32(ivZ0(v)), f32(ivZ1(v)), ivMat(v), flags);
    o += 1u;
  }
  if (pl.shrub) {
    instOpaque[o] = mkInst(id.x, id.y, 1u, 1u, top, top + 1.0, MAT_LEAVES, FLAG_VEG);
    o += 1u;
  }
  if (pl.tree) {
    instOpaque[o] = mkInst(id.x, id.y, 1u, 1u, top, top + pl.trunk, MAT_WOOD, FLAG_VEG);
    instOpaque[o + 1u] = mkInst(id.x - 1u, id.y - 1u, 3u, 3u, top + pl.trunk, top + pl.trunk + pl.crown, MAT_LEAVES, FLAG_VEG);
  }
  if (nW > 0u) {
    instWater[baseW + offW] = mkInst(id.x, id.y, 1u, 1u, top, top + d, MAT_WATER, 0u);
  }
}
