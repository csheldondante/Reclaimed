// ---- mutate/floodscan.wgsl: a flood's level from the place's real ground, on the GPU (masks.wgsl before it) -------
// The user (2026-11-15): flooded must read at a glance — "water visibly standing in the streets and yards between the
// houses up to a level", "the level from a basin fill of the place's real ground". Round 1 took the level from the
// atlas's coarse ground: a town on a slope stayed dry while the meadow below it went under.
//
// mutFloodScan, a thread a column of the entry's box: the heights of the ground in the disc counted into a histogram
// (quarter cells from p.y), dry ground and standing water apart. mutFloodPick, one thread: the level chosen — over the
// dry ground's share the strength asks for, and where water already stands in the disc (the river or shore the flood
// spills from) between a cell and a half and a few cells over it. The level is written to `floodOut` and copied on
// the GPU into the land and lot kernels' parameters (MutParams.p.x) before they run: nothing is read back to choose
// it. The engine reads the four bytes once afterwards to keep the level on the entry (mutate/engine.ts).
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
/** [0, FH_BINS) dry ground tops, [FH_BINS, 2 FH_BINS) the surfaces of standing water, both inside the rim;
 *  [2 FH_BINS, 3 FH_BINS) the outer ring's surfaces (ground or water, whichever is on top) */
@group(0) @binding(15) var<storage, read_write> floodHist: array<atomic<u32>>;
/** a slot a scan (MP.k.w): the level (window z), the level the rim falls to (-1e9: nothing counted), the dry columns counted,
 *  the wet ones. The first two are MutParams.p.xy of the kernels that follow */
@group(0) @binding(16) var<storage, read_write> floodOut: array<vec4<f32>>;

const FH_BINS: u32 = 256u;
const FH_PER_CELL: f32 = 4.0;
/** water this deep is standing water (a river, a pond, the sea), not a wet street */
const FH_WET: f32 = 0.3;
/** the outer ring: from here to the rim the lowest surface is looked for (what the flood's edge must come down to) */
const FH_RING: f32 = 0.85;

@compute @workgroup_size(8, 8)
fn mutFloodScan(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = MP.box.x + id.x;
  let y = MP.box.y + id.y;
  if (x >= MP.box.z || y >= MP.box.w) { return; }
  let p = vec2<i32>(i32(x), i32(y));
  if (!inMap(p)) { return; }
  // (the part of the disc that takes the full level: the rim falls away; the outer ring is counted for where to)
  let d = mutD(cellPos(p));
  if (d >= 0.98 || (d >= FLOOD_RIM && d < FH_RING)) { return; }
  let cs = colSlots(x, y);
  var tv = IV_NONE;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    tv = v;
  }
  if (ivEmpty(tv)) { return; }
  let top = ivZ1(tv);
  if (ivMat(tv) == MAT_EXTERNAL && top - ivZ0(tv) >= BUILDING_T) { return; }
  let wd = water[colIdxI(p)];
  if (d >= FH_RING) {
    let zr = (top + wd - MP.p.y) * FH_PER_CELL;
    atomicAdd(&floodHist[2u * FH_BINS + u32(clamp(zr, 0.0, f32(FH_BINS - 1u)))], 1u);
    return;
  }
  let wet = wd > FH_WET;
  let z = (top + select(0.0, wd, wet) - MP.p.y) * FH_PER_CELL;
  let bin = u32(clamp(z, 0.0, f32(FH_BINS - 1u)));
  atomicAdd(&floodHist[bin + select(0u, FH_BINS, wet)], 1u);
}

/** the height (cells over p.y) under which `share` of the `n` columns counted from `base` lie */
fn fhShare(base: u32, n: u32, share: f32) -> f32 {
  let want = u32(f32(n) * share);
  var acc = 0u;
  for (var b = 0u; b < FH_BINS; b++) {
    acc += atomicLoad(&floodHist[base + b]);
    if (acc > want) { return (f32(b) + 0.5) / FH_PER_CELL; }
  }
  return f32(FH_BINS) / FH_PER_CELL;
}

@compute @workgroup_size(1)
fn mutFloodPick() {
  var nDry = 0u;
  var nWet = 0u;
  for (var b = 0u; b < FH_BINS; b++) {
    nDry += atomicLoad(&floodHist[b]);
    nWet += atomicLoad(&floodHist[FH_BINS + b]);
  }
  let s = MP.at.w;
  // (the atlas's level when nothing was counted: the land isn't there)
  var level = MP.p.x;
  var river = -1e9;
  if (nDry > 0u) {
    level = MP.p.y + fhShare(0u, nDry, 0.22 + 0.48 * s) + 0.6;
    if (nWet >= 12u) {
      // (the lowest standing water of the place: what the flood rises from)
      river = MP.p.y + fhShare(FH_BINS, nWet, 0.2);
      level = clamp(level, river + 1.5, river + 2.5 + 4.0 * s);
    }
  }
  // (MU-36: where the rim falls to — a quarter cell under the lowest surface of the outer ring, ground or water, so
  // at the rim the flood's surface is under everything there and meets it with no step; never over the level)
  var low = -1e9;
  for (var b = 0u; b < FH_BINS; b++) {
    if (atomicLoad(&floodHist[2u * FH_BINS + b]) > 0u) {
      low = min(MP.p.y + f32(b) / FH_PER_CELL - 0.25, level - 1.0);
      break;
    }
  }
  floodOut[MP.k.w] = vec4<f32>(level, low, f32(nDry), f32(nWet));
  for (var b = 0u; b < 3u * FH_BINS; b++) { atomicStore(&floodHist[b], 0u); }
}
