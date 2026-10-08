// ---- material physics system --------------------------------------------
// Simplest falling-sand style rules on the layered columns:
//  1. gravity: granular intervals with empty space below drop 1 cell per tick
//  2. angle of repose: a column whose top is granular and stands more than
//     `repose` cells above a neighbour gives 1 cell to its steepest neighbour.
//     Wet material has a lower repose, so rain triggers slumps / mudslides.
// Race-free gather formulation: every column recomputes its neighbours'
// donor decisions from the same read-only inputs, so donations and receipts
// always match and mass is conserved.
@group(0) @binding(3) var<storage, read> layersIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> layersOut: array<u32>;
@group(0) @binding(5) var<storage, read> surface: array<u32>;
@group(0) @binding(6) var<storage, read> moisture: array<f32>;
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read> water: array<f32>;

// Piping: loose material holding back a large water-level difference is
// pushed toward the low side (how embankments and rubble plugs breach).
const PIPE_HEAD: f32 = 2.5;
const PIPE_RATE: f32 = 0.02;

// Flow-driven transport (erosion): fast water drags loose top material one
// cell downstream, probability rising with flow. Direction 4..7 means "carried
// off the map edge" (the donor loses it, nobody receives it).
const ERODE_FLOW: f32 = 0.15;
const ERODE_RATE: f32 = 0.6;

const STAT_OVERFLOW: u32 = 15u;

fn donorDir(p: vec2<i32>) -> i32 {
  let s = surface[colIdxI(p)];
  let m = sfMat(s);
  if (matState(m) != ST_GRANULAR) { return -1; }
  let h = i32(sfZ(s));
  let wet = moisture[colIdxI(p)];
  let rep = mix(MATS[m].sim.y, MATS[m].sim.z, smoothstep(0.35, 0.8, wet));
  var best = -1;
  var bestDrop = rep;
  let rot = hash3(u32(p.x), u32(p.y), G.tick) & 3u;
  for (var k = 0u; k < 4u; k++) {
    let d = (k + rot) & 3u;
    let q = p + DIRS[d];
    if (!inMap(q)) { continue; }
    let drop = f32(h - i32(sfZ(surface[colIdxI(q)])));
    if (drop > bestDrop) {
      bestDrop = drop;
      best = i32(d);
    }
  }
  if (best < 0) {
    var hi = -1.0;
    var lo = 1e9;
    var loDir = 0u;
    for (var k = 0u; k < 4u; k++) {
      let q = p + DIRS[k];
      if (!inMap(q)) { continue; }
      let j = colIdxI(q);
      let lvl = f32(sfZ(surface[j])) + water[j];
      if (water[j] > 0.05) { hi = max(hi, lvl); }
      if (lvl < lo) { lo = lvl; loDir = k; }
    }
    // only when the water actually presses against this column's loose top
    if (hi > f32(h) - 4.0 && hi - lo > PIPE_HEAD && lo < f32(h)) {
      let chance = (hi - lo - PIPE_HEAD) * PIPE_RATE * (1.0 - MATS[m].sim.w);
      if (rand3(u32(p.x), u32(p.y), G.tick ^ 0x9119u) < chance) { best = i32(loDir); }
    }
  }
  if (best < 0) {
    let v = netFlow(p);
    let sp = length(v);
    if (sp > ERODE_FLOW) {
      let chance = (sp - ERODE_FLOW) * ERODE_RATE * (1.0 - MATS[m].sim.w);
      if (rand3(u32(p.x), u32(p.y), G.tick ^ 0xe20du) < chance) {
        var d = select(1u, 0u, v.x > 0.0);
        if (abs(v.y) > abs(v.x)) { d = select(3u, 2u, v.y > 0.0); }
        best = select(i32(d) + 4, i32(d), inMap(p + DIRS[d]));
      }
    }
  }
  return best;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let cs = colSlots(id.x, id.y);
  var arr: array<u32, MAX_K>;
  var n = 0u;
  for (var i = 0u; i < cs.y; i++) {
    let v = layersIn[cs.x + i];
    if (v == 0u) { break; }
    arr[i] = v;
    n = i + 1u;
  }

  // 1. gravity for granular intervals
  var floorZ = 0u;
  for (var i = 0u; i < n; i++) {
    let v = arr[i];
    var z0 = ivZ0(v);
    var z1 = ivZ1(v);
    if (matState(ivMat(v)) == ST_GRANULAR && z0 > floorZ) {
      z0 -= 1u;
      z1 -= 1u;
      arr[i] = ivPack(z0, z1, ivMat(v), ivAux(v));
    }
    floorZ = z1;
  }

  // 2a. donate
  if (n > 0u && donorDir(p) >= 0) {
    let v = arr[n - 1u];
    let z1 = ivZ1(v) - 1u;
    if (z1 <= ivZ0(v)) { n -= 1u; arr[n] = 0u; }
    else { arr[n - 1u] = ivPack(ivZ0(v), z1, ivMat(v), ivAux(v)); }
  }

  // 2c. strong wind strips loose litter and ash off the top (see litterStrip)
  if (n > 0u && donorDir(p) < 0 && isStrippable(ivMat(arr[n - 1u])) && litterStrip(p, G.tick)) {
    let v = arr[n - 1u];
    let z1 = ivZ1(v) - 1u;
    if (z1 <= ivZ0(v)) { n -= 1u; arr[n] = 0u; }
    else { arr[n - 1u] = ivPack(ivZ0(v), z1, ivMat(v), ivAux(v)); }
  }

  // 2b. receive
  var cnt = 0u;
  var rmat = 0u;
  for (var k = 0u; k < 4u; k++) {
    let q = p + DIRS[k];
    if (!inMap(q)) { continue; }
    if (donorDir(q) == i32(k ^ 1u)) {
      if (cnt == 0u) { rmat = sfMat(surface[colIdxI(q)]); }
      cnt += 1u;
    }
  }
  if (cnt > 0u) {
    var topZ = 0u;
    if (n > 0u) { topZ = ivZ1(arr[n - 1u]); }
    let newTop = min(topZ + cnt, G.zMax);
    // Same material, or loose material landing on loose material with few
    // slots left: just grow the top interval (material mixes into the top).
    // Keeps deposits from fragmenting columns into many thin intervals.
    let topGranular = n > 0u && matState(ivMat(arr[n - 1u])) == ST_GRANULAR;
    if (n > 0u && (ivMat(arr[n - 1u]) == rmat || (topGranular && n + 2u > cs.y))) {
      let v = arr[n - 1u];
      arr[n - 1u] = ivPack(ivZ0(v), newTop, ivMat(v), ivAux(v));
    } else if (n < cs.y) {
      arr[n] = ivPack(topZ, newTop, rmat, 0u);
      n += 1u;
    } else {
      // no free slot: grow the top interval in its own material and report it
      let v = arr[n - 1u];
      arr[n - 1u] = ivPack(ivZ0(v), newTop, ivMat(v), ivAux(v));
      atomicAdd(&stats[STAT_OVERFLOW], 1u);
    }
  }

  // 3. merge touching intervals of the same material
  var m = 0u;
  for (var i = 0u; i < n; i++) {
    let v = arr[i];
    if (m > 0u) {
      let prev = arr[m - 1u];
      if (ivMat(prev) == ivMat(v) && ivZ1(prev) == ivZ0(v)) {
        arr[m - 1u] = ivPack(ivZ0(prev), ivZ1(v), ivMat(v), ivAux(prev));
        continue;
      }
    }
    arr[m] = v;
    m += 1u;
  }

  for (var i = 0u; i < cs.y; i++) {
    layersOut[cs.x + i] = select(0u, arr[i], i < m);
  }
}
