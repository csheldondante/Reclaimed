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
// tap responses (wilt.wgsl): z = bloom (flowers open at once), w = doomed sprout timer
@group(0) @binding(7) var<storage, read> wilt: array<vec4<f32>>;

const FLAG_VEG: u32 = 2u;
const FLAG_DETAIL: u32 = 128u;

var<workgroup> wgO: atomic<u32>;
var<workgroup> baseO: u32;

fn mkInst(x: u32, y: u32, sx: u32, sy: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  return vec4<u32>(x | (y << 12u) | ((sx - 1u) << 24u) | ((sy - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | (flags << 8u));
}


// vegPlan(): vegplan.wgsl (prepended)
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgO, 0u); }
  workgroupBarrier();
  let inside = id.x < G.mapW && id.y < G.mapH;
  var n = 0u;
  var pl = VegPlan(false, false, 0.0, 0.0, 0u, false, 0u);
  var top = 0.0;
  var tap = vec4<f32>(0.0);
  if (inside) {
    let i = colIdx(id.x, id.y);
    let s = surface[i];
    top = f32(sfZ(s));
    pl = vegPlan(id.x, id.y, veg[i], sfMat(s));
    tap = wilt[i];
    n = select(0u, 1u, pl.shrub) + select(0u, 2u, pl.tree) + pl.tufts + select(0u, 1u, pl.flower);
    n += select(0u, 2u, tap.z > 0.0) + select(0u, 2u, tap.w > 0.0);
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
  // a grow-tap on good ground: two flowers open right away, tall enough to see
  if (tap.z > 0.0) {
    for (var k = 0u; k < 2u; k++) {
      let hx = hash3(id.x, id.y, 401u + k);
      let open = smoothstep(0.0, 0.03, 1.0 - tap.z) * 0.5 + 0.5; // pops up, then stands
      instOpaque[o] = mkInst(qx + (hx % 3u), qy + ((hx >> 2u) % 3u), 2u, 2u, top, top + 0.9 * open, MAT_FLOWER, FLAG_VEG | FLAG_DETAIL);
      o += 1u;
    }
  }
  // a grow-tap on hostile ground: a sprout shoots up (~1 s), browns, then
  // droops and is gone (~7 s) — the ground has to be cleared first
  if (tap.w > 0.0) {
    let ph = 1.0 - tap.w;
    let h = 0.2 + 1.2 * smoothstep(0.0, 0.14, ph) * (1.0 - 0.85 * smoothstep(0.62, 1.0, ph));
    for (var k = 0u; k < 2u; k++) {
      let hx = hash3(id.x, id.y, 433u + k);
      instOpaque[o] = mkInst(qx + (hx % 3u), qy + ((hx >> 2u) % 3u), 2u, 2u, top, top + h, MAT_SPROUT, FLAG_VEG | FLAG_DETAIL);
      o += 1u;
    }
  }
  if (pl.flower) {
    let hx = hash3(id.x, id.y, 77u);
    instOpaque[o] = mkInst(qx + (hx & 3u), qy + ((hx >> 2u) & 3u), 1u, 1u, top, top + 0.45, MAT_FLOWER, FLAG_VEG | FLAG_DETAIL);
  }
}
