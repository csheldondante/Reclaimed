// ---- vegetation render preparation ------------------------------------------
// Emits instances for plants from the succession field: grass tufts and
// wildflowers (quarter-cell detail instances), shrubs, and trees (half-cell
// trunk + sub-voxel canopy box). Kept separate from terrain render-prep (each
// stays within 8 storage buffers). Instance layout and flags: renderprep.wgsl;
// flag 128 marks a detail instance whose x/y/size are in quarter cells.
// Plants are boxes, drawn from their own list (18 vertices each); the loose
// sheet is a hex prism and joins the opaque list (render.wgsl).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> veg: array<f32>;
@group(0) @binding(5) var<storage, read_write> instOpaque: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read_write> indirect: array<atomic<u32>>;
// the player's plantings (wilt.wgsl): z = on good ground (tier + growth),
// w = on hostile ground (tier + phase: grows, browns, withers)
@group(0) @binding(7) var<storage, read> wilt: array<vec4<f32>>;
// flowers shed by the wind (< 1) stand as bare stems until they regrow
@group(0) @binding(8) var<storage, read> petals: array<f32>;
@group(0) @binding(9) var<storage, read_write> instPlant: array<vec4<u32>>;
// (round 99, ?meshinst=1: TREE_MESH) the trees as instances of their species' mesh (render/meshinst.ts: four vec4s
// each, CAP a species), their draw args' instance counts in `indirect` from MI_ARGS (five words a species)
@group(0) @binding(10) var<storage, read_write> instTree: array<vec4<f32>>;

// (round 93) The instance lists may be smaller than their worst case (renderer.ts instgrow, ?instgrow=0 off): a write past
// one's room is left out, the count clamped after (clampVeg) and the raw count kept for the CPU, which grows it.
// The tops' room (two a column, after the prisms') is their worst case: never past it.
fn putP(i: u32, v: vec4<u32>) { if (i < arrayLength(&instPlant)) { instPlant[i] = v; } }
fn putO(i: u32, v: vec4<u32>) { if (i < arrayLength(&instOpaque) - 2u * G.mapW * G.mapH) { instOpaque[i] = v; } }

/** Drifted dust deeper than this is drawn (as a smooth sheet). */
const DRIFT_SHOW: f32 = 0.03;

// ---- fine plants (title screen, G.misc.w = 1): diorama-scale plants ----
const MAT_BONE_V: u32 = 16u;

fn fineCount(v: f32, m: u32, c: vec2<u32>) -> u32 {
  if (v < 0.3) { return 0u; }
  if (m == MAT_BONE_V) { return 3u; } // moss cushions
  var n = 0u;
  if (v >= 1.2) { n += 6u; } // two curving grass blades, three boxes each
  if (fineFlower(v, c)) { n += 12u; } // a flower: stem, 2 leaves, 8 petals, heart
  return n;
}

/** A diorama flower stands on this column (sparse: each head is ~5 cells across). */
fn fineFlower(v: f32, c: vec2<u32>) -> bool {
  return v >= 2.0 && c.x >= 3u && c.y >= 3u && rand3(c.x, c.y, 811u) < 0.03;
}

/** Grass blades, a flower with leaves and petals, or moss on bone. */
fn fineEmit(o0: u32, c: vec2<u32>, top: f32, v: f32, m: u32) -> u32 {
  var o = o0;
  let qx = c.x * 4u;
  let qy = c.y * 4u;
  let F = FLAG_VEG | FLAG_DETAIL;
  if (v < 0.3) { return o; }
  if (m == MAT_BONE_V) {
    for (var k = 0u; k < 3u; k++) {
      let hx = hash3(c.x, c.y, 851u + k);
      putP(o, mkInst(qx + (hx & 3u), qy + ((hx >> 2u) & 3u), 1u + ((hx >> 4u) & 1u), 1u, top, top + 0.06 + f32((hx >> 6u) & 3u) * 0.03, MAT_GRASS, F));
      o += 1u;
    }
    return o;
  }
  // Sized against the skull (a human one; round 13): grass reaches about
  // half way up it (3–8 cells), flower heads are about the size of its eye
  // sockets (5 cells across) on tall stems.
  if (v >= 1.2) {
    for (var k = 0u; k < 2u; k++) {
      let hx = hash3(c.x, c.y, 821u + k);
      let hgt = (3.0 + f32((hx >> 4u) & 15u) * 0.33) * min(1.0, (v - 0.9) * 1.5);
      // a blade curves over: three stacked boxes stepping a quarter cell
      // each way it leans
      let bx = qx + (hx & 3u);
      let by = qy + ((hx >> 2u) & 3u);
      let lx = select(0u, 1u, ((hx >> 9u) & 1u) == 1u);
      let ly = 1u - lx;
      putP(o, mkInst(bx, by, 1u, 1u, top, top + hgt * 0.55, MAT_GRASS, F));
      putP(o + 1u, mkInst(bx + lx, by + ly, 1u, 1u, top + hgt * 0.55, top + hgt * 0.85, MAT_GRASS, F));
      putP(o + 2u, mkInst(bx + 2u * lx, by + 2u * ly, 1u, 1u, top + hgt * 0.85, top + hgt, MAT_GRASS, F));
      o += 3u;
    }
  }
  if (fineFlower(v, c)) {
    let st = top + 5.0 + rand3(c.x, c.y, 812u) * 4.0;
    let hx = hash3(c.x, c.y, 813u);
    // one colour for the whole flower (render.wgsl reads the species bits):
    // 1..4 petal colours, 8 the yellow heart
    let col = (1u + (hx & 3u)) << 16u;
    let FC = F | (col >> 8u);
    let cx = qx + 1u; // the stem, a quarter cell wide
    let cy = qy + 1u;
    putP(o, mkInst(cx, cy, 1u, 1u, top, st, MAT_GRASS, F));
    // two long leaves part-way up
    putP(o + 1u, mkInst(cx - 3u, cy, 3u, 1u, top + (st - top) * 0.3, top + (st - top) * 0.3 + 0.2, MAT_GRASS, F));
    putP(o + 2u, mkInst(cx + 1u, cy, 3u, 1u, top + (st - top) * 0.5, top + (st - top) * 0.5 + 0.2, MAT_GRASS, F));
    // four petals (2 × 1 cells) around a 1-cell heart: 5 cells across
    putP(o + 3u, mkInst(cx - 10u, cy - 2u, 8u, 4u, st, st + 0.3, MAT_FLOWER, FC));
    putP(o + 4u, mkInst(cx + 2u, cy - 2u, 8u, 4u, st, st + 0.3, MAT_FLOWER, FC));
    putP(o + 5u, mkInst(cx - 2u, cy - 10u, 4u, 8u, st, st + 0.3, MAT_FLOWER, FC));
    putP(o + 6u, mkInst(cx - 2u, cy + 2u, 4u, 8u, st, st + 0.3, MAT_FLOWER, FC));
    putP(o + 7u, mkInst(cx - 2u, cy - 2u, 4u, 4u, st, st + 0.5, MAT_FLOWER, F | (8u << 8u)));
    // four smaller petals on the diagonals round the head off
    putP(o + 8u, mkInst(cx - 7u, cy - 7u, 5u, 5u, st, st + 0.25, MAT_FLOWER, FC));
    putP(o + 9u, mkInst(cx + 2u, cy - 7u, 5u, 5u, st, st + 0.25, MAT_FLOWER, FC));
    putP(o + 10u, mkInst(cx - 7u, cy + 2u, 5u, 5u, st, st + 0.25, MAT_FLOWER, FC));
    putP(o + 11u, mkInst(cx + 2u, cy + 2u, 5u, 5u, st, st + 0.25, MAT_FLOWER, FC));
    o += 12u;
  }
  return o;
}

/** A flower, or a bare stem if the wind has stripped it. */
fn flowerMat(c: vec2<u32>) -> u32 { return select(MAT_GRASS, MAT_FLOWER, petals[colIdx(c.x, c.y)] >= 1.0); }

const FLAG_VEG: u32 = 2u;
const FLAG_DETAIL: u32 = 128u;

var<workgroup> wgO: atomic<u32>;
var<workgroup> baseO: u32;
var<workgroup> wgS: atomic<u32>;
var<workgroup> baseS: u32;
var<workgroup> wgT: atomic<u32>;
var<workgroup> baseT: u32;

fn mkInst(x: u32, y: u32, sx: u32, sy: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  return vec4<u32>(x | (y << 12u) | ((sx - 1u) << 24u) | ((sy - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | (flags << 8u));
}


/** Instances a planting of this tier needs (see planting). */
fn plantingCount(tier: f32) -> u32 {
  if (tier < 1.0) { return 0u; }
  // (on the diorama a tree is a sapling: a stem and three leaf clusters)
  return 2u + select(0u, 2u, tier >= 2.0) + select(0u, select(2u, 4u, G.misc.w > 0.5), tier >= 3.0);
}

/** Grass tufts; + flowers or a shrub; + a tree. grow 0..1, wither 0..1 shrinks it. */
fn planting(o0: u32, c: vec2<u32>, top: f32, tier: f32, grow: f32, wither: f32) -> u32 {
  var o = o0;
  let qx = c.x * 4u;
  let qy = c.y * 4u;
  // on the diorama plants are at the skull's scale (round 13): much taller
  let FS = select(1.0, 5.0, G.misc.w > 0.5);
  let TS = select(1.0, 2.5, G.misc.w > 0.5);
  for (var k = 0u; k < 2u; k++) {
    let hx = hash3(c.x, c.y, 461u + k);
    let th = (0.35 + f32((hx >> 4u) & 7u) * 0.05) * grow * (1.0 - 0.7 * wither) * FS;
    putP(o, mkInst(qx + (hx % 3u), qy + ((hx >> 2u) % 3u), 2u, 2u, top, top + th, MAT_GRASS, FLAG_VEG | FLAG_DETAIL));
    o += 1u;
  }
  if (tier >= 2.0) {
    for (var k = 0u; k < 2u; k++) {
      let hx = hash3(c.x, c.y, 401u + k);
      if (k == 1u && (hx & 1u) == 1u) {
        // a shrub (sub-voxel leaf box)
        putP(o, mkInst(c.x, c.y, 1u, 1u, top, top + 1.1 * TS * grow * (1.0 - 0.5 * wither), MAT_LEAVES, FLAG_VEG));
      } else {
        putP(o, mkInst(qx + (hx % 3u), qy + ((hx >> 2u) % 3u), 2u, 2u, top, top + 0.9 * FS * grow * (1.0 - 0.6 * wither), flowerMat(c), FLAG_VEG | FLAG_DETAIL));
      }
      o += 1u;
    }
  }
  if (tier >= 3.0 && c.x > 0u && c.y > 0u && G.misc.w > 0.5) {
    // the diorama (round 14): a sapling at the skull's scale, not the
    // level's tree — a quarter-cell stem and three small leaf clusters
    let stem = 7.0 * grow * (1.0 - 0.3 * wither);
    let leaf = 0.5 * (1.0 - 0.6 * wither);
    putP(o, mkInst(qx + 1u, qy + 1u, 1u, 1u, top, top + stem, MAT_WOOD, FLAG_VEG | FLAG_DETAIL));
    putP(o + 1u, mkInst(qx - 1u, qy - 1u, 6u, 6u, top + stem - 0.3, top + stem - 0.3 + leaf, MAT_GRASS, FLAG_VEG | FLAG_DETAIL));
    putP(o + 2u, mkInst(qx - 3u, qy + 1u, 5u, 4u, top + stem * 0.62, top + stem * 0.62 + leaf, MAT_GRASS, FLAG_VEG | FLAG_DETAIL));
    putP(o + 3u, mkInst(qx + 2u, qy - 2u, 4u, 5u, top + stem * 0.78, top + stem * 0.78 + leaf, MAT_GRASS, FLAG_VEG | FLAG_DETAIL));
    o += 4u;
  } else if (tier >= 3.0 && c.x > 0u && c.y > 0u) {
    let trunk = 2.5 * TS * grow;
    putP(o, mkInst(qx + 1u, qy + 1u, 2u, 2u, top, top + trunk + 0.5, MAT_WOOD, FLAG_VEG | FLAG_DETAIL));
    putP(o + 1u, mkInst(c.x - 1u, c.y - 1u, 3u, 3u, top + trunk, top + trunk + 2.6 * TS * grow * (1.0 - 0.6 * wither), MAT_LEAVES, FLAG_VEG));
    o += 2u;
  } else if (tier >= 3.0) {
    // (map edge: no room for a crown; keep the count honest)
    let n = select(2u, 4u, G.misc.w > 0.5);
    for (var k = 0u; k < n; k++) { putP(o + k, mkInst(c.x, c.y, 1u, 1u, top, top, MAT_GRASS, FLAG_VEG)); }
    o += n;
  }
  return o;
}

/**
 * (round 99, TREE_MESH) Column c's tree as an instance of its species' mesh: turned, leaning a little (a skew), its
 * trunk and crown the heights the boxes had (the crown from the trunk's top, the old giant's half a cell lower).
 */
fn treeInstance(c: vec2<u32>, top: f32, pl: VegPlan) {
  if (FLORA) {
    // (round 117, flora) the species' library variants (src/flora/library.ts): picked by the column's hash, drawn at
    // their own size (the L-system's), scaled a little by the plan's age so young woods stand lower
    var r = FL_OAK;
    if (pl.species == 1u) { r = FL_PINE; }
    if (pl.species == 2u) { r = FL_BIRCH; }
    if (pl.species == 3u) { r = FL_GIANT; }
    // (the plan's age: young woods (succession just past 3.6) stand at 0.8 of the variant's height, old ones full)
    let age = 0.8 + 0.2 * clamp((veg[colIdx(c.x, c.y)] - 3.6) / 1.2, 0.0, 1.0);
    floraInstance(r, c, top, age, 0.05);
    return;
  }
  let k = min(pl.species, MI_N - 1u);
  let j = atomicAdd(&indirect[MI_ARGS + k * 5u + 1u], 1u);
  if (j >= MI_CAP) { return; }
  let at = cellPos(vec2<i32>(c));
  let yaw = rand3(c.x, c.y, 517u) * 6.2831853;
  let lx = (rand3(c.x, c.y, 518u) - 0.5) * 0.14;
  let ly = (rand3(c.x, c.y, 519u) - 0.5) * 0.14;
  let s = 0.9 + 0.2 * rand3(c.x, c.y, 520u);
  let cs = cos(yaw) * s;
  let sn = sin(yaw) * s;
  var half = 1.5;
  if (k == 2u) { half = 1.15; }
  if (k == 3u) { half = 2.5; }
  let base = select(pl.trunk, pl.trunk - 0.5, k == 3u);
  let o = (k * MI_CAP + j) * 4u;
  instTree[o] = vec4<f32>(cs, -sn, lx, at.x);
  instTree[o + 1u] = vec4<f32>(sn, cs, ly, at.y);
  instTree[o + 2u] = vec4<f32>(0.0, 0.0, 1.0, top);
  instTree[o + 3u] = vec4<f32>(pl.trunk + 0.5, base, pl.crown + select(0.0, 0.5, k == 3u), half);
}

fn floraInstance(r: vec2<u32>, c: vec2<u32>, top: f32, scale: f32, lean: f32) {
  // (round 117, perf: a tree off screen, its shadow too, isn't drawn — up to 20 cells tall, 6 across)
  if (!floraSeen(cellPos(vec2<i32>(c)), top, 20.0, 6.0)) { return; }
  floraPut(r, c, cellPos(vec2<i32>(c)), top, scale, lean, 0u);
}

/**
 * (round 117, flora) The small plants on column c as library meshes: tall grass in the meadows (most columns of
 * grassland, a clump each, jittered in the cell), wildflowers, ferns on the woodland floor (the shade plant: under the
 * canopy), a thicket shrub. Returns true when it drew the column's small plants (the tufts' boxes are then left out).
 */
fn floraSmall(c: vec2<u32>, top: f32, v: f32, pl: VegPlan) -> bool {
  if (pl.tufts == 0u && !pl.shrub && !pl.flower && v < 3.6) { return false; }
  let jit = (vec2<f32>(rand3(c.x, c.y, 541u), rand3(c.x, c.y, 542u)) - 0.5) * 0.7;
  let at = cellPos(vec2<i32>(c)) + jit;
  // (round 117, perf: only what shows — the plant's box or its shadow on screen; and the grass, flowers and ferns
  // only where a cell is wide enough on screen to see a blade: thinned under 11 render px a cell, gone under 5 — the
  // ground's plant cover paints the meadow there)
  if (!floraSeen(at, top, 2.5, 1.6)) { return true; }
  // (render pixels a cell: the zoom × the tier's render pixels a CSS pixel — the phone's low tier renders half)
  let px = PC.viewport.z * FLORA_RPX;
  // (round 117, the phone: at 7 render px a cell — zoom 14 on the low tier — a full meadow of clumps read as static;
  // sparse there, full from 11)
  let fine = rand3(c.x, c.y, 546u) < smoothstep(5.0, 11.0, px);
  // (shrubland — succession 2.6 to 3.6 — is the thicket, a soft barrier; under the woods' canopy only a few: the
  // forest floor stays open, ferns and leaf litter)
  if (pl.shrub && (v < 3.6 || rand3(c.x, c.y, 545u) < 0.2)) { floraPut(FL_SHRUB, c, at, top, 0.8, 0.05, 1u); }
  if (v >= 3.6 && !pl.tree) {
    // the woodland floor: ferns in the shade, here and there
    if (fine && rand3(c.x, c.y, 543u) < 0.16) { floraPut(FL_FERN, c, at, top, 1.0, 0.05, 2u); }
    return true;
  }
  if (pl.tufts > 0u && v >= 1.4 && fine) {
    // tall grass: the meadows (taller the lusher), thinning toward the woods' shade
    let lush = smoothstep(1.4, 2.6, v) * (1.0 - smoothstep(3.3, 3.8, v));
    if (rand3(c.x, c.y, 544u) < 0.25 + 0.7 * lush) { floraPut(FL_TALLGRASS, c, at, top, 0.7 + 0.45 * lush, 0.08, 3u); }
    if (pl.flower) { floraPut(FL_FLOWER, c, at + vec2<f32>(0.3, -0.2), top, 1.0, 0.1, 4u); }
    return true;
  }
  return pl.flower;
}

// vegPlan(): vegplan.wgsl (prepended)
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgO, 0u); atomicStore(&wgS, 0u); atomicStore(&wgT, 0u); }
  workgroupBarrier();
  // (hybrid: no plants on a heightfield chunk — the LOD rings draw its land)
  let inside = id.x < G.mapW && id.y < G.mapH && !heightfieldCol(id.xy);
  var n = 0u;
  var pl = VegPlan(false, false, 0.0, 0.0, 0u, false, 0u);
  var top = 0.0;
  var tap = vec4<f32>(0.0);
  var floraKeep = false;
  var plF = pl;
  if (inside) {
    let i = colIdx(id.x, id.y);
    let s = surface[i];
    // plants stand on the drawn (possibly sloped) ground at the cell centre —
    // on top of a loose layer of sand or dirt (they grow in it; round 15),
    // under deep dust or ash (buried; the wind uncovers them)
    top = groundCentreZ(vec2<i32>(id.xy), f32(sfZ(s)));
    let lay = driftAt(vec2<i32>(id.xy));
    if (lay > 0.0 && !buriedAt(vec2<i32>(id.xy))) { top = f32(sfZ(s)) + lay; }
    let gm = groundMatAt(vec2<i32>(id.xy), sfMat(s));
    pl = vegPlan(id.x, id.y, veg[i], gm);
    plF = pl;
    // (perfopt, ?tufts=0: no grass tufts — quarter-cell boxes, a third of a pixel at low; the mesh's plant cover draws the grass)
    if (!TUFTS) { pl.tufts = 0u; }
    tap = wilt[i];
    // (round 117, flora: the meadows' and woodland floor's small plants are library meshes — floraSmall — and take no
    // room in the box lists)
    if (FLORA && G.misc.w < 0.5 && (plF.tufts > 0u || pl.shrub || pl.flower || veg[i] >= 3.6)) { pl.tufts = 0u; floraKeep = true; }
    n = select(0u, 1u, pl.shrub && !floraKeep) + select(0u, 2u, pl.tree && !TREE_MESH) + pl.tufts + select(0u, 1u, pl.flower && !floraKeep);
    if (G.misc.w > 0.5) { n = fineCount(veg[i], gm, id.xy); }
    n += plantingCount(floor(tap.z)) + plantingCount(floor(tap.w));
  }
  // (no sheet where the field mesh draws the ground: meshregion.wgsl)
  var nS = select(0u, 1u, inside && driftAt(vec2<i32>(id.xy)) > DRIFT_SHOW && !meshed(cellPos(vec2<i32>(id.xy))));
  // a sheet whose sides all meet the ground beside it is drawn as its top
  // alone, in the tops list (renderprep.wgsl)
  var hid = 0u;
  if (nS > 0u) { hid = sheetHidden(vec2<i32>(id.xy)); }
  let nT = select(0u, 1u, nS > 0u && hid == 63u);
  nS -= nT;
  let off = atomicAdd(&wgO, n);
  let offS = atomicAdd(&wgS, nS);
  let offT = atomicAdd(&wgT, nT);
  workgroupBarrier();
  if (li == 0u) {
    baseO = atomicAdd(&indirect[9], atomicLoad(&wgO));
    baseS = atomicAdd(&indirect[1], atomicLoad(&wgS));
    baseT = atomicLoad(&indirect[16]) + atomicAdd(&indirect[13], atomicLoad(&wgT));
  }
  workgroupBarrier();
  // (round 99: a tree drawn as a mesh takes no room in the lists, but is still written)
  if (!inside || (n + nS + nT == 0u && !(TREE_MESH && pl.tree) && !floraKeep)) { return; }
  var o = baseO + off;
  let qx = id.x * 4u;
  let qy = id.y * 4u;
  // drifted dust: a box from the ground up to the dust's surface; its top
  // corners follow the smooth drift sheet (render.wgsl). Plants under it are
  // buried (dormant: wilt/ecology).
  let dd = driftAt(vec2<i32>(id.xy));
  if (dd > DRIFT_SHOW) {
    let g = f32(sfZ(surface[colIdx(id.x, id.y)]));
    var si = mkInst(id.x, id.y, 1u, 1u, g, g + dd, MAT_DRIFT, 1u);
    si.w |= hid << 20u;
    if (nT > 0u) { instOpaque[baseT + offT] = si; } else { putO(baseS + offS, si); }
  }
  if (G.misc.w > 0.5) {
    o = fineEmit(o, id.xy, top, veg[colIdx(id.x, id.y)], groundMatAt(vec2<i32>(id.xy), sfMat(surface[colIdx(id.x, id.y)])));
  }
  if (floraKeep) {
    _ = floraSmall(id.xy, top, veg[colIdx(id.x, id.y)], plF);
  }
  if (pl.shrub && G.misc.w < 0.5 && !floraKeep) {
    putP(o, mkInst(id.x, id.y, 1u, 1u, top, top + 1.0, MAT_LEAVES, FLAG_VEG));
    o += 1u;
  }
  if (pl.tree && G.misc.w < 0.5 && TREE_MESH) {
    treeInstance(id.xy, top, pl);
  }
  if (pl.tree && G.misc.w < 0.5 && !TREE_MESH) {
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
    putP(o, trunk);
    putP(o + 1u, crown);
    o += 2u;
  }
  for (var k = 0u; k < select(pl.tufts, 0u, G.misc.w > 0.5); k++) {
    let hx = hash3(id.x, id.y, 31u + k);
    let tx = qx + (hx & 3u);
    let ty = qy + ((hx >> 2u) & 3u);
    let th = 0.25 + f32((hx >> 4u) & 7u) * 0.06;
    putP(o, mkInst(tx, ty, 1u, 1u, top, top + th, MAT_GRASS, FLAG_VEG | FLAG_DETAIL));
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
  if (pl.flower && G.misc.w < 0.5 && !floraKeep) {
    let hx = hash3(id.x, id.y, 77u);
    putP(o, mkInst(qx + (hx & 3u), qy + ((hx >> 2u) & 3u), 1u, 1u, top, top + 0.45, flowerMat(id.xy), FLAG_VEG | FLAG_DETAIL));
  }
}

// (round 93) after renderprep and this: the prisms' and plants' counts held to their lists' room, the raw counts
// kept in indirect words 20 and 22 (renderer.ts reads them and grows a list that ran out)
@compute @workgroup_size(1)
fn clampVeg() {
  let o = atomicLoad(&indirect[1]);
  atomicStore(&indirect[20], o);
  atomicStore(&indirect[1], min(o, arrayLength(&instOpaque) - 2u * G.mapW * G.mapH));
  let p = atomicLoad(&indirect[9]);
  atomicStore(&indirect[22], p);
  atomicStore(&indirect[9], min(p, arrayLength(&instPlant)));
  // (round 99) the trees' counts held to their room (MI_CAP a species)
  if (TREE_MESH) {
    for (var k = 0u; k < MI_N; k++) { atomicMin(&indirect[MI_ARGS + k * 5u + 1u], MI_CAP); }
  }
}
