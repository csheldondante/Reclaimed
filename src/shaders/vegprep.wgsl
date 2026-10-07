// ---- vegetation render preparation ------------------------------------------
// Emits box instances for shrubs and trees from the succession field. Kept
// separate from terrain render-prep (each stays within 8 storage buffers, and
// vegetation detail — tufts, flowers, vines — grows here).
// Instance layout and flags: see renderprep.wgsl.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> veg: array<f32>;
@group(0) @binding(5) var<storage, read_write> instOpaque: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read_write> indirect: array<atomic<u32>>;

const FLAG_VEG: u32 = 2u;

var<workgroup> wgO: atomic<u32>;
var<workgroup> baseO: u32;

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
  if (li == 0u) { atomicStore(&wgO, 0u); }
  workgroupBarrier();
  let inside = id.x < G.mapW && id.y < G.mapH;
  var n = 0u;
  var pl = VegPlan(false, false, 0.0, 0.0);
  var top = 0.0;
  if (inside) {
    let i = colIdx(id.x, id.y);
    top = f32(sfZ(surface[i]));
    pl = vegPlan(id.x, id.y, veg[i]);
    n = select(0u, 1u, pl.shrub) + select(0u, 2u, pl.tree);
  }
  let off = atomicAdd(&wgO, n);
  workgroupBarrier();
  if (li == 0u) { baseO = atomicAdd(&indirect[1], atomicLoad(&wgO)); }
  workgroupBarrier();
  if (!inside || n == 0u) { return; }
  let o = baseO + off;
  if (pl.shrub) {
    instOpaque[o] = mkInst(id.x, id.y, 1u, 1u, top, top + 1.0, MAT_LEAVES, FLAG_VEG);
  }
  if (pl.tree) {
    instOpaque[o] = mkInst(id.x, id.y, 1u, 1u, top, top + pl.trunk, MAT_WOOD, FLAG_VEG);
    instOpaque[o + 1u] = mkInst(id.x - 1u, id.y - 1u, 3u, 3u, top + pl.trunk, top + pl.trunk + pl.crown, MAT_LEAVES, FLAG_VEG);
  }
}
