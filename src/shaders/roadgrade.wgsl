// ---- roadgrade.wgsl: a road laid into the columns (road lab, RD1) ---------------------------------------------------
// The user, 2026-11-12: "roads flatten and color terrain … the flattening and build up along divots modify the actual
// column heights since it is cheap and easy to do and we can fill in with whatever material we want like dirt." One
// dispatch a road (its record: roadpath.wgsl, api/contracts/roadpath.ts), run once when it's laid; a thread a column of
// the road's box. Real interval edits, in place, in townstamp.wgsl stampCols' pattern (read the column, rebuild it in a
// local list, join touching runs of one material, fit to K, write only changed slots with bumpColumn).
//
//   roadLay   a column on the road (within its half width of the nearest segment): everything above the profile cut
//             away, packed dirt (soil) filled up to it, and its top RG_THICK made the road's surface interval (dirt
//             road, aux = record + 1, its reveal start f16 in z bits 16..31, its reveal end in w). A column on the
//             shoulder (within `shoulder` past the half width): its ground cut down to the profile + e·RG_CUT_SLOPE or
//             filled up to the profile − e·RG_FILL_SLOPE (e: how far past the edge; the most of the fills and the
//             least of the cuts over the road's segments), so the bank meets the land at a natural angle. A shoulder
//             never touches another road's surface. Without ROAD_GRADED a column whose ground would move more than
//             maxDz is left as it is (a structure carries the road there).
//             The column's plants (veg) cleared: the road and its fresh banks are bare.
//   roadPave  a column of the box: this road's dirt surface interval made cobble (its reveal end), nothing else moved
//
// Stats (rstats, atomics; the lab reads them once after a lay): 0 columns touched, 1 road columns, 2 shoulder columns
// changed, 3 the most intervals a written column holds, 4 columns folded to fit K, 5 columns left (beyond maxDz),
// 6 the most K seen, 7 the most ground moved (1/16 cells).

// (loop-streets) A lay takes records [road, road + n) at once (roadpath.wgsl roadHit: the first whose half width holds a
// column is its road; the banks over every shoulder that holds it), in their own frame placed in the window: window
// column p is the frame's column p − (gx, gy) (gy even: the rows' stagger is the window's), window z = the records' z +
// gz. The lab: one record a dispatch, its frame the window (0, 0, 0). A town: all its records over a rectangle that
// just got its land (citygen/town.ts, the claims' `claimed` hook). Every column holding an External interval (another
// owner's — a building, a wall, a deck's slab) is left as it is; with ROAD_DRY, every wet one.
struct GradeParams { road: u32, n: u32, x0: u32, y0: u32, x1: u32, y1: u32, gx: i32, gy: i32, gz: f32, _a: u32, _b: u32, _c: u32 };

@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> roads: array<vec4<u32>>;
@group(0) @binding(5) var<uniform> GP: GradeParams;
@group(0) @binding(6) var<storage, read_write> rstats: array<atomic<u32>>;
/** the plants' field (WorldGpu veg) and the next tick's: fresh earthworks and the road are bare (citygen bare.wgsl's way) */
@group(0) @binding(7) var<storage, read_write> veg: array<f32>;
@group(0) @binding(8) var<storage, read_write> vegNext: array<f32>;
/** (loop-streets) the water's depth a column (WorldGpu water): ROAD_DRY leaves a wet column */
@group(0) @binding(9) var<storage, read> water: array<f32>;
/** water deeper than this (cells) makes a column wet (citygen height.wgsl WET_DEPTH's order) */
const RG_WET: f32 = 0.05;

/** the road's surface interval's thickness (cells) */
const RG_THICK: f32 = 0.3;
/** a fill bank: up 1 for 1 across (soil's dry repose is 1.4: it stands) */
const RG_FILL_SLOPE: f32 = 1.0;
/** a cut bank: up 1.5 for 1 across (cut ground and rock stand steeper than a heap) */
const RG_CUT_SLOPE: f32 = 1.5;
/** what the road fills with: packed dirt (soil) */
const RG_FILL_MAT: u32 = 2u;
const RG_OUT: u32 = 24u;

/** the road's surface interval [z0, z1) as laid (dirt road, or what it was paved as when it's laid again), record `r`
 *  linked, its reveal times */
fn roadIv(z0: f32, z1: f32, rec: RoadRec, r: u32, mat: u32) -> vec4<u32> {
  let start16 = pack2x16float(vec2<f32>(rec.revealStart, 0.0)) & 0xffffu;
  return vec4<u32>(bitcast<u32>(z0), bitcast<u32>(z1), mat | (((r + 1u) & 0xffu) << 8u) | (start16 << 16u), bitcast<u32>(rec.revealEnd));
}

@compute @workgroup_size(8, 8)
fn roadLay(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = GP.x0 + id.x;
  let y = GP.y0 + id.y;
  if (x >= GP.x1 || y >= GP.y1) { return; }
  let p = vec2<i32>(i32(x), i32(y));
  if (!inMap(p)) { return; }
  // (the records' frame: the column's own position there — cellPos of the frame's column, as the town's raster takes it,
  // so the town's gradeRast and this lay agree to the bit)
  let wp = cellPos(p - vec2<i32>(GP.gx, GP.gy));
  // the record the column lies on (the first), and the banks of the ones whose shoulder it lies in
  let hit = roadHit(wp, GP.road, GP.n, RG_FILL_SLOPE, RG_CUT_SLOPE);
  let on = hit.rec != ROAD_NONE;
  if (!on && !hit.near) { return; }
  // (a shoulder's flags: the first record's of the lay — a town's records share theirs)
  let r = select(GP.road, hit.rec, on);
  let rec = roadRec(r);
  let cs = colSlots(x, y);
  // the column's ground top and its top material; another owner's interval in it, and the water over it
  var g = 0.0;
  var topMat = 0u;
  var cnt = 0u;
  var owned = false;
  // (this road's own surface already here: laid again, it keeps its paving; ROAD_PAVED: laid as its surface)
  var surf = select(MAT_DIRTROAD, select(MAT_DIRTROAD, MAT_COBBLE, rec.surface == 1u), (rec.flags & ROAD_PAVED) != 0u);
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    g = ivZ1(v);
    topMat = ivMat(v);
    cnt = k + 1u;
    if (topMat == MAT_EXTERNAL) { owned = true; }
    if (isRoadMat(topMat) && ivAux(v) == ((r + 1u) & 0xffu)) { surf = topMat; }
  }
  // (loop-streets: another owner's column — a claim — is never cut or buried; with ROAD_DRY a wet one is left too)
  if (owned) { return; }
  if ((rec.flags & ROAD_DRY) != 0u && (water[colIdx(x, y)] > RG_WET || g < G.ocean.x)) { return; }
  atomicAdd(&rstats[0], 1u);
  atomicMax(&rstats[6], cs.y);
  let graded = (rec.flags & ROAD_GRADED) != 0u;
  // where the ground goes: the profile on the road, the banks on the shoulder (window z)
  var T = hit.z + GP.gz;
  if (!on) {
    // (a shoulder never cuts or buries another road's surface)
    if (isRoadMat(topMat)) { return; }
    T = max(min(g, hit.cutT + GP.gz), hit.fillT + GP.gz);
    if (abs(T - g) < 0.02) { return; }
  }
  if (!graded && abs(T - g) > rec.maxDz) {
    atomicAdd(&rstats[5], 1u);
    return;
  }
  atomicMax(&rstats[7], u32(abs(T - g) * 16.0));
  // rebuild: what's under the cut kept (clipped), dirt filled up to it, the road's surface on top
  let keepTo = select(T, T - RG_THICK, on);
  var o: array<vec4<u32>, RG_OUT>;
  var n = 0u;
  for (var k = 0u; k < cnt; k++) {
    let v = layers[cs.x + k];
    let z0 = ivZ0(v);
    if (z0 >= keepTo - 1e-4) { break; }
    if (ivZ1(v) <= keepTo) { o[n] = v; } else { o[n] = ivPack(z0, keepTo, ivMat(v), ivAux(v)); }
    n += 1u;
  }
  let kept = select(0.0, ivZ1(o[max(n, 1u) - 1u]), n > 0u);
  if (kept < keepTo - 1e-3) {
    o[n] = ivPack(kept, keepTo, RG_FILL_MAT, 0u);
    n += 1u;
  }
  if (on) {
    o[n] = roadIv(keepTo, T, rec, r, surf);
    n += 1u;
    atomicAdd(&rstats[1], 1u);
  } else {
    atomicAdd(&rstats[2], 1u);
  }
  // (touching intervals of one material are one; the road's own never joins: one a column)
  var m = 0u;
  for (var k = 0u; k < n; k++) {
    let mk = ivMat(o[k]);
    if (m > 0u && !isRoadMat(mk) && mk == ivMat(o[m - 1u]) && abs(ivZ0(o[k]) - ivZ1(o[m - 1u])) < 1e-3) {
      o[m - 1u] = ivPack(ivZ0(o[m - 1u]), ivZ1(o[k]), mk, ivAux(o[m - 1u]));
    } else {
      o[m] = o[k];
      m += 1u;
    }
  }
  n = m;
  atomicMax(&rstats[3], n);
  // more than the column holds: its two lowest joined (the road's surface and what's near the top kept as they are)
  if (n > cs.y) { atomicAdd(&rstats[4], 1u); }
  loop {
    if (n <= cs.y) { break; }
    o[0] = ivPack(ivZ0(o[0]), ivZ1(o[1]), ivMat(o[0]), ivAux(o[0]));
    for (var k = 1u; k + 1u < n; k++) { o[k] = o[k + 1u]; }
    n -= 1u;
  }
  for (var k = 0u; k < cs.y; k++) {
    let nv = select(IV_NONE, o[k], k < n);
    let old = layers[cs.x + k];
    if (any(old != nv)) {
      layers[cs.x + k] = nv;
      bumpColumn(vec2<u32>(x, y), old, nv);
    }
  }
  let j = colIdxI(p);
  veg[j] = 0.0;
  vegNext[j] = 0.0;
}

@compute @workgroup_size(8, 8)
fn roadPave(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = GP.x0 + id.x;
  let y = GP.y0 + id.y;
  if (x >= GP.x1 || y >= GP.y1) { return; }
  if (!inMap(vec2<i32>(i32(x), i32(y)))) { return; }
  let cs = colSlots(x, y);
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    if (ivMat(v) != MAT_DIRTROAD || ivAux(v) != ((GP.road + 1u) & 0xffu)) { continue; }
    let nv = vec4<u32>(v.x, v.y, (v.z & ~0xffu) | MAT_COBBLE, v.w);
    layers[cs.x + k] = nv;
    bumpColumn(vec2<u32>(x, y), v, nv);
    atomicAdd(&rstats[1], 1u);
  }
}
