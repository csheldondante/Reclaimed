// ---- vegetation render preparation ------------------------------------------
// Emits instances for plants from the succession field: grass tufts and
// wildflowers (quarter-cell detail instances), shrubs, and trees (half-cell
// trunk + sub-voxel canopy box). Kept separate from terrain render-prep (each
// stays within 8 storage buffers). Instance layout and flags: renderprep.wgsl;
// flag 128 marks a detail instance whose x/y/size are in quarter cells.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> veg: array<f32>;
@group(0) @binding(5) var<storage, read_write> instOpaque: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read_write> indirect: array<atomic<u32>>;

const FLAG_VEG: u32 = 2u;
const FLAG_DETAIL: u32 = 128u;

var<workgroup> wgO: atomic<u32>;
var<workgroup> baseO: u32;

fn mkInst(x: u32, y: u32, sx: u32, sy: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  return vec4<u32>(x | (y << 12u) | ((sx - 1u) << 24u) | ((sy - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | (flags << 8u));
}

// species (instance bits 16..19 for vegetation): 0 broadleaf, 1 conifer, 2 birch, 3 old giant
struct VegPlan { shrub: bool, tree: bool, trunk: f32, crown: f32, tufts: u32, flower: bool, species: u32 };

fn vegPlan(x: u32, y: u32, v: f32, m: u32) -> VegPlan {
  var pl = VegPlan(false, false, 0.0, 0.0, 0u, false, 0u);
  let h = rand3(x, y, 4242u);
  let edge = x < 2u || y < 2u || x + 3u >= G.mapW || y + 3u >= G.mapH;
  if (v >= 3.6 && h < 0.045 && !edge) {
    pl.tree = true;
    let hs = rand3(x, y, 321u);
    let hv = rand3(x, y, 7u);
    let age = clamp(v - 3.6, 0.0, 1.4);
    if (v > 4.7 && hs < 0.12) {
      pl.species = 3u; // old giant: tall trunk, broad crown
      pl.trunk = 5.0 + floor(hv * 4.0);
      pl.crown = 3.0 + floor(hv * 2.0);
    } else if (hs < 0.42) {
      pl.species = 1u; // conifer: short bare trunk, tall tapering crown
      pl.trunk = 1.0 + floor(hv * 2.0);
      pl.crown = 4.0 + floor(age * 2.0) + floor(hv * 3.0);
    } else if (hs < 0.58) {
      pl.species = 2u; // birch: slender pale trunk, small light crown
      pl.trunk = 3.0 + floor(age * 2.0) + floor(hv * 2.0);
      pl.crown = 2.0;
    } else {
      pl.trunk = 2.0 + floor(age * 2.5) + floor(hv * 3.0);
      pl.crown = 2.0 + floor(hv * 1.99) + select(0.0, 1.0, v > 4.5);
    }
  } else if (v >= 2.6 && h < 0.25) {
    pl.shrub = true;
  }
  // grass tufts on soil-like ground once grass has taken hold
  let soilish = MATS[m].eco.x >= 2.0;
  if (soilish && v >= 1.2) {
    let t = rand3(x, y, 99u);
    pl.tufts = select(0u, 1u + u32(t * 2.99), t < smoothstep(1.2, 2.5, v) * 0.9);
    // meadows (grass that stopped short of woodland) are full of flowers
    pl.flower = v >= 1.6 && v < 3.8 && rand3(x, y, 123u) < select(0.12, 0.3, v > 2.4 && v < 3.4);
  }
  return pl;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgO, 0u); }
  workgroupBarrier();
  let inside = id.x < G.mapW && id.y < G.mapH;
  var n = 0u;
  var pl = VegPlan(false, false, 0.0, 0.0, 0u, false, 0u);
  var top = 0.0;
  if (inside) {
    let i = colIdx(id.x, id.y);
    let s = surface[i];
    top = f32(sfZ(s));
    pl = vegPlan(id.x, id.y, veg[i], sfMat(s));
    n = select(0u, 1u, pl.shrub) + select(0u, 2u, pl.tree) + pl.tufts + select(0u, 1u, pl.flower);
  }
  let off = atomicAdd(&wgO, n);
  workgroupBarrier();
  if (li == 0u) { baseO = atomicAdd(&indirect[1], atomicLoad(&wgO)); }
  workgroupBarrier();
  if (!inside || n == 0u) { return; }
  var o = baseO + off;
  let qx = id.x * 4u;
  let qy = id.y * 4u;
  if (pl.shrub) {
    instOpaque[o] = mkInst(id.x, id.y, 1u, 1u, top, top + 1.0, MAT_LEAVES, FLAG_VEG);
    o += 1u;
  }
  if (pl.tree) {
    // half-cell trunk, then the canopy box (sub-voxel crown) above it
    let sp = pl.species << 16u;
    var trunk = mkInst(qx + 1u, qy + 1u, 2u, 2u, top, top + pl.trunk + 0.5, MAT_WOOD, FLAG_VEG | FLAG_DETAIL);
    var crown = mkInst(id.x - 1u, id.y - 1u, 3u, 3u, top + pl.trunk, top + pl.trunk + pl.crown, MAT_LEAVES, FLAG_VEG);
    if (pl.species == 2u) { trunk = mkInst(qx + 1u, qy + 1u, 1u, 1u, top, top + pl.trunk + 0.5, MAT_WOOD, FLAG_VEG | FLAG_DETAIL); }
    if (pl.species == 3u) {
      trunk = mkInst(qx, qy, 4u, 4u, top, top + pl.trunk + 0.5, MAT_WOOD, FLAG_VEG | FLAG_DETAIL);
      crown = mkInst(id.x - 2u, id.y - 2u, 5u, 5u, top + pl.trunk - 0.5, top + pl.trunk + pl.crown, MAT_LEAVES, FLAG_VEG);
    }
    trunk.w |= sp;
    crown.w |= sp;
    instOpaque[o] = trunk;
    instOpaque[o + 1u] = crown;
    o += 2u;
  }
  for (var k = 0u; k < pl.tufts; k++) {
    let hx = hash3(id.x, id.y, 31u + k);
    let tx = qx + (hx & 3u);
    let ty = qy + ((hx >> 2u) & 3u);
    let th = 0.25 + f32((hx >> 4u) & 7u) * 0.06;
    instOpaque[o] = mkInst(tx, ty, 1u, 1u, top, top + th, MAT_GRASS, FLAG_VEG | FLAG_DETAIL);
    o += 1u;
  }
  if (pl.flower) {
    let hx = hash3(id.x, id.y, 77u);
    instOpaque[o] = mkInst(qx + (hx & 3u), qy + ((hx >> 2u) & 3u), 1u, 1u, top, top + 0.45, MAT_FLOWER, FLAG_VEG | FLAG_DETAIL);
  }
}
