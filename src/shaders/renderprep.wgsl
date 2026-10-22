// ---- visibility / render preparation --------------------------------------
// Turns world state into box instances for the renderer:
//   opaque: one box per layered interval (vegetation: vegprep.wgsl)
//   liquid: one box per column for water and one for oil floating on it
// Appends with one global atomic per workgroup (local prefix via workgroup
// atomics) to avoid contention on the indirect-args counters.
//
// Instance (vec4<u32>):
//   x: x | y<<12 | (sx-1)<<24 | (sy-1)<<28  (storage cells; quarter cells
//      for detail instances)
//   y: bitcast z0 (f32)   z: bitcast z1 (f32)
//   w: material | flags<<8 | (damage or species)<<16 | sides<<20
//      flags: 1 = top of column, 2 = vegetation, 64 = top face hidden,
//             128 = detail instance
//      sides: bit k = the hex side toward neighbour k (NDIR order) hidden
// Column intervals are drawn as hex prisms; vegetation as boxes. Visibility: a side face is hidden when the neighbour's solid ground stack
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
// [12..15] the tops list: intervals whose six sides are all hidden are drawn
// as their top alone (12 vertices against a prism's 30; draw is
// vertex-bound). It lives in instOpaque from indirect[16] (set by the CPU;
// drawn through a binding offset there) on, two per column at most: a
// column's highest such interval (another, under a cave's roof, stays a whole
// prism) and its drift sheet (vegprep.wgsl).

const FLAG_TOP: u32 = 1u;
const FLAG_VEG: u32 = 2u;
const HIDE_TOP: u32 = 64u;
const SIDES_ALL: u32 = 63u;

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

/** Hidden faces: bits 0..5 the sides (NDIR order), bit 6 the top. */
fn hideFaces(gt: Dirs, z1: f32, nextZ0: f32) -> u32 {
  var f = 0u;
  for (var k = 0u; k < NDIR; k++) { if (gt[k] >= z1) { f |= 1u << k; } }
  if (abs(nextZ0 - z1) < 1e-3) { f |= 64u; }
  return f;
}
const HIDE_ALL: u32 = 127u;

/**
 * The sides of p's soft top that its smoothed corners cover: where both
 * corners of a side are shared smoothed corners (terrainshape.wgsl: one
 * height for the three columns round them, all soft), the neighbour's top
 * runs through the same two heights, so its body hides the side as long as
 * its ground is solid up to there. On slopes nearly every column has a lower
 * neighbour, so without this almost no column was drawn as its top alone.
 */
fn smoothSides(p: vec2<i32>, gt: Dirs) -> u32 {
  var f = 0u;
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (!inMap(q)) { continue; }
    let m = DIR_SIDE[k];
    if (cornerZ(p, (m + 5u) % 6u) < 0.0 || cornerZ(p, m) < 0.0) { continue; }
    if (gt[k] >= sfZ(surface[colIdxI(q)]) - 1e-3) { f |= 1u << k; }
  }
  return f;
}
/** Hidden faces → the instance's flag bits (top) and side bits. */
fn hideBits(h: u32) -> u32 { return ((h & 64u) << 8u) | ((h & SIDES_ALL) << 20u); }
const WATER_MIN: f32 = 0.012;
const OIL_MIN: f32 = 0.004;

var<workgroup> wgO: atomic<u32>;
var<workgroup> wgW: atomic<u32>;
var<workgroup> baseO: u32;
var<workgroup> baseW: u32;
var<workgroup> wgT: atomic<u32>;
var<workgroup> baseT: u32;

fn mkInst(x: u32, y: u32, sx: u32, sy: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  return vec4<u32>(x | (y << 12u) | ((sx - 1u) << 24u) | ((sy - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | (flags << 8u));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgO, 0u); atomicStore(&wgW, 0u); atomicStore(&wgT, 0u); }
  workgroupBarrier();

  let inside = id.x < G.mapW && id.y < G.mapH;
  var nO = 0u;
  var nW = 0u;
  var cs = vec2<u32>(0u);
  var nSlots = 0u;
  var top = 0.0;
  var d = 0.0;
  var ol = 0.0;
  var gt = dZero();
  var nVis = 0u;
  // the interval drawn as its top alone (none: run)
  var topOnly = 0u;
  // the sides the soft top's smoothed corners cover (smoothSides)
  var coverSides = 0u;
  // the loose ground on top is drawn as the coverSides sheet (vegprep.wgsl), not as boxes
  var run = 0u;
  var coverZ = -1.0;
  var meshCol = false;
  if (inside) {
    let i = colIdx(id.x, id.y);
    cs = colSlots(id.x, id.y);
    let s = surface[i];
    nSlots = sfCount(s);
    top = sfZ(s);
    d = water[i];
    ol = oil[i];
    let p = vec2<i32>(id.xy);
    var col: array<vec4<u32>, MAX_K>;
    for (var k = 0u; k < nSlots; k++) { col[k] = layers[cs.x + k]; }
    run = looseRun(&col, nSlots);
    // (the field mesh draws this column but what's built: meshregion.wgsl)
    meshCol = meshed(cellPos(p));
    // (a meshed column with nothing built on it and no water draws nothing
    // here: its neighbours needn't be looked at)
    var needN = !meshCol || d > WATER_MIN;
    if (meshCol) { for (var k = 0u; k < run; k++) { if (!fieldMat(ivMat(col[k]))) { needN = true; } } }
    if (needN) {
      for (var k = 0u; k < NDIR; k++) { gt[k] = groundTop(nbr(p, k)); }
      coverSides = smoothSides(p, gt);
    }
    // under a fair depth of loose ground the top face is covered by the sheet
    // (it only shows where the sheet thins out at its edges)
    if (run < nSlots && run > 0u && ivZ1(col[nSlots - 1u]) - ivZ0(col[run]) >= 0.3) { coverZ = ivZ1(col[run - 1u]); }
    topOnly = run;
    for (var k = 0u; k < run; k++) {
      let v = layers[cs.x + k];
      if (meshCol && fieldMat(ivMat(v))) { continue; }
      var nz = 9999.0;
      if (k + 1u < run) { nz = ivZ0(layers[cs.x + k + 1u]); } else if (coverZ >= 0.0) { nz = coverZ; }
      var h = hideFaces(gt, ivZ1(v), nz);
      if (k + 1u == run && MATS[ivMat(v)].look.x > 0.0) { h |= coverSides; }
      if (h != HIDE_ALL) { nVis += 1u; }
      if (h == SIDES_ALL) { topOnly = k; }
    }
    nO = nVis - select(0u, 1u, topOnly < run);
    nW = select(0u, 1u, d > WATER_MIN) + select(0u, 1u, ol > OIL_MIN);
  }
  let offO = atomicAdd(&wgO, nO);
  let offW = atomicAdd(&wgW, nW);
  let offT = atomicAdd(&wgT, select(0u, 1u, topOnly < run));
  workgroupBarrier();
  if (li == 0u) {
    baseO = atomicAdd(&indirect[1], atomicLoad(&wgO));
    baseW = atomicAdd(&indirect[5], atomicLoad(&wgW));
    baseT = atomicLoad(&indirect[16]) + atomicAdd(&indirect[13], atomicLoad(&wgT));
  }
  workgroupBarrier();
  if (!inside) { return; }

  var o = baseO + offO;
  for (var k = 0u; k < run; k++) {
    let v = layers[cs.x + k];
    if (meshCol && fieldMat(ivMat(v))) { continue; }
    var nz = 9999.0;
    if (k + 1u < run) { nz = ivZ0(layers[cs.x + k + 1u]); } else if (coverZ >= 0.0) { nz = coverZ; }
    var hide = hideFaces(gt, ivZ1(v), nz);
    if (k + 1u == run && MATS[ivMat(v)].look.x > 0.0) { hide |= coverSides; }
    if (hide == HIDE_ALL) { continue; }
    var inst = mkInst(id.x, id.y, 1u, 1u, ivZ0(v), ivZ1(v), ivMat(v), select(0u, FLAG_TOP, k + 1u == run));
    inst.w |= hideBits(hide);
    inst.w |= (ivAux(v) & 15u) << 16u; // structural damage → cracks
    if (k == topOnly) {
      instOpaque[baseT + offT] = inst;
      continue;
    }
    instOpaque[o] = inst;
    o += 1u;
  }
  var w = baseW + offW;
  // liquids lie on top of drifted dust (it sinks; round 13)
  let bed = max(top + driftAt(vec2<i32>(id.xy)), bodyTopAt(vec2<i32>(id.xy)));
  if (d > WATER_MIN) {
    // no side wall where the coverSides sheet runs on into a wet neighbour, or
    // where the ground beside rises over the water: drawn, those walls stood
    // inside the neighbour's water and showed through it as dark blocks
    // wherever water ran down a slope (round 25)
    let lv = bed + d;
    var hide = 0u;
    for (var k = 0u; k < NDIR; k++) {
      let q = nbr(vec2<i32>(id.xy), k);
      if (!inMap(q)) { continue; }
      let j = colIdxI(q);
      let nd = water[j];
      let nb = max(sfZ(surface[j]) + driftAt(q), bodyTopAt(q));
      if ((nd > WATER_MIN && max(bed, nb) - min(lv, nb + nd) <= SHEET_STEP) || gt[k] >= lv) { hide |= 1u << k; }
    }
    var wi = mkInst(id.x, id.y, 1u, 1u, bed, lv, MAT_WATER, 0u);
    wi.w |= hideBits(hide);
    instWater[w] = wi;
    w += 1u;
  }
  if (ol > OIL_MIN) {
    // oil floats on whatever water is here (even a thin film)
    let base = bed + max(d, 0.0);
    instWater[w] = mkInst(id.x, id.y, 1u, 1u, base, base + max(ol, 0.06), MAT_OIL, 0u);
  }
}
