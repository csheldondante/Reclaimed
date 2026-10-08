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
// the player's plantings (wilt.wgsl): z = on good ground (tier + growth),
// w = on hostile ground (tier + phase: grows, browns, withers)
@group(0) @binding(7) var<storage, read> wilt: array<vec4<f32>>;
// flowers shed by the wind (< 1) stand as bare stems until they regrow
@group(0) @binding(8) var<storage, read> petals: array<f32>;

/** A flower, or a bare stem if the wind has stripped it. */
fn flowerMat(c: vec2<u32>) -> u32 { return select(MAT_GRASS, MAT_FLOWER, petals[colIdx(c.x, c.y)] >= 1.0); }

const FLAG_VEG: u32 = 2u;
const FLAG_DETAIL: u32 = 128u;

var<workgroup> wgO: atomic<u32>;
var<workgroup> baseO: u32;

fn mkInst(x: u32, y: u32, sx: u32, sy: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  return vec4<u32>(x | (y << 12u) | ((sx - 1u) << 24u) | ((sy - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | (flags << 8u));
}


/** Instances a planting of this tier needs (see planting). */
fn plantingCount(tier: f32) -> u32 {
  if (tier < 1.0) { return 0u; }
  return 2u + select(0u, 2u, tier >= 2.0) + select(0u, 2u, tier >= 3.0);
}

/** Grass tufts; + flowers or a shrub; + a tree. grow 0..1, wither 0..1 shrinks it. */
fn planting(o0: u32, c: vec2<u32>, top: f32, tier: f32, grow: f32, wither: f32) -> u32 {
  var o = o0;
  let qx = c.x * 4u;
  let qy = c.y * 4u;
  for (var k = 0u; k < 2u; k++) {
    let hx = hash3(c.x, c.y, 461u + k);
    let th = (0.35 + f32((hx >> 4u) & 7u) * 0.05) * grow * (1.0 - 0.7 * wither);
    instOpaque[o] = mkInst(qx + (hx % 3u), qy + ((hx >> 2u) % 3u), 2u, 2u, top, top + th, MAT_GRASS, FLAG_VEG | FLAG_DETAIL);
    o += 1u;
  }
  if (tier >= 2.0) {
    for (var k = 0u; k < 2u; k++) {
      let hx = hash3(c.x, c.y, 401u + k);
      if (k == 1u && (hx & 1u) == 1u) {
        // a shrub (sub-voxel leaf box)
        instOpaque[o] = mkInst(c.x, c.y, 1u, 1u, top, top + 1.1 * grow * (1.0 - 0.5 * wither), MAT_LEAVES, FLAG_VEG);
      } else {
        instOpaque[o] = mkInst(qx + (hx % 3u), qy + ((hx >> 2u) % 3u), 2u, 2u, top, top + 0.9 * grow * (1.0 - 0.6 * wither), flowerMat(c), FLAG_VEG | FLAG_DETAIL);
      }
      o += 1u;
    }
  }
  if (tier >= 3.0 && c.x > 0u && c.y > 0u) {
    let trunk = 2.5 * grow;
    instOpaque[o] = mkInst(qx + 1u, qy + 1u, 2u, 2u, top, top + trunk + 0.5, MAT_WOOD, FLAG_VEG | FLAG_DETAIL);
    instOpaque[o + 1u] = mkInst(c.x - 1u, c.y - 1u, 3u, 3u, top + trunk, top + trunk + 2.6 * grow * (1.0 - 0.6 * wither), MAT_LEAVES, FLAG_VEG);
    o += 2u;
  } else if (tier >= 3.0) {
    // (map edge: no room for a crown; keep the count honest)
    instOpaque[o] = mkInst(c.x, c.y, 1u, 1u, top, top, MAT_GRASS, FLAG_VEG);
    instOpaque[o + 1u] = mkInst(c.x, c.y, 1u, 1u, top, top, MAT_GRASS, FLAG_VEG);
    o += 2u;
  }
  return o;
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
    // plants stand on the drawn (possibly sloped) ground at the cell centre
    top = groundZAt(vec2<i32>(id.xy), vec2<f32>(0.5), f32(sfZ(s)));
    pl = vegPlan(id.x, id.y, veg[i], sfMat(s));
    tap = wilt[i];
    n = select(0u, 1u, pl.shrub) + select(0u, 2u, pl.tree) + pl.tufts + select(0u, 1u, pl.flower);
    n += plantingCount(floor(tap.z)) + plantingCount(floor(tap.w));
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
  // the player's plantings: one tap grass, two flowers or a shrub, three a
  // tree. On good ground they grow in and stay; on hostile ground they come
  // up, then shrink as they brown (the browning is wilt.y) and are gone
  if (tap.z >= 1.0) {
    o = planting(o, id.xy, top, floor(tap.z), 0.25 + 0.75 * smoothstep(0.0, 0.7, fract(tap.z)), 0.0);
  }
  if (tap.w >= 1.0) {
    let ph = fract(tap.w);
    o = planting(o, id.xy, top, floor(tap.w), 0.25 + 0.75 * smoothstep(0.0, 0.2, ph), smoothstep(0.6, 1.0, ph));
  }
  if (pl.flower) {
    let hx = hash3(id.x, id.y, 77u);
    instOpaque[o] = mkInst(qx + (hx & 3u), qy + ((hx >> 2u) & 3u), 1u, 1u, top, top + 0.45, flowerMat(id.xy), FLAG_VEG | FLAG_DETAIL);
  }
}
