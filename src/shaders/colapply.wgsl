// ---- colapply.wgsl ------------------------------------------------------------------------------------------------
// (round 120, JB6: "no CPU readback on the hot path") A collapse verdict applied to the GPU's columns in place: what a
// judge freed or crumbled is cut out of the layers here, and what crumbled spills as loose ground onto the lowest open
// column beside it (through `deposit`, as the CPU's toLoose did) — so Integrity needs no CPU copy of the columns to apply
// what judge B decided. Standalone (as judge.wgsl): its own params, the GPU's chunk table and slots.
//
//   applyCuts     a thread an op: column (x, y) has cuts [z0, z1) taken out of it (game/colbodies.ts subtract: any
//                 material; tolerance 1e-4), then written back with Integrity.writeColumn's rule for a column over its
//                 K slots (the bottom K − 1 kept, the rest's height piled as rubble on top)
//   spillTarget   a thread a crumbled cell: the lowest-topped column of the 3 x 3 round it (offset coordinates, dy then
//                 dx, the first lowest) that isn't one of the crumbled columns; its loose material (looseFrom) voted
//                 into a hash of targets, the cells counted
//   spillDeposit  a thread a hash entry: the target's deposit gets its cells (deposit.y +=) and the material most voted
//                 for (ties: the lowest material id), the entry cleared for the next use
//
// Layout of `inp` (u32): [opOff..] ops 4 words each (x, y, first cut, cut count); [cutOff..] cuts 2 words (z0, z1 f32
// bits); [spillOff..] crumbled cells 4 words (x, y, z, mat); [goneOff..] the crumbled columns' keys (y * mapW + x),
// sorted; [pageOff..] the window's page table (a slot a 16 x 16 page: sim/pages.ts); [looseOff..] 256 words: a
// material's loose slot (0..5, the order of P.looseMat).

struct Params {
  mapW: u32, mapH: u32, chunksX: u32, chunkSize: u32,
  nOps: u32, nSpill: u32, nGone: u32, hashCap: u32,
  opOff: u32, cutOff: u32, spillOff: u32, goneOff: u32,
  pageOff: u32, looseOff: u32, pagesX: u32, zMax: f32,
  /** the six loose materials (looseFrom's results), ascending */
  looseMat: array<vec4<u32>, 2>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read_write> slots: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> inp: array<u32>;
/** 8 words an entry: key + 1 (0: empty), cells, six votes */
@group(0) @binding(4) var<storage, read_write> hash: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> deposit: array<vec4<f32>>;

const MAX_K: u32 = 16u;
/** a column's intervals while cut: K (16 at most) plus a split a cut (the host keeps an op's cuts to 32) */
const MAX_IV: u32 = 48u;
const MAT_RUBBLE: u32 = 4u;
const EPS: f32 = 1e-4;

fn colBase(x: u32, y: u32) -> vec2<u32> {
  let cs = P.chunkSize;
  let ch = chunks[(y / cs) * P.chunksX + (x / cs)];
  return vec2<u32>(ch.x + ((y % cs) * cs + (x % cs)) * ch.y, ch.y);
}

fn z0Of(v: vec4<u32>) -> f32 { return bitcast<f32>(v.x); }
fn z1Of(v: vec4<u32>) -> f32 { return bitcast<f32>(v.y); }

/** the top of column (x, y): its last interval's z1, 0 when empty */
fn topOf(x: u32, y: u32) -> f32 {
  let b = colBase(x, y);
  var t = 0.0;
  for (var s = 0u; s < b.y; s++) {
    let v = slots[b.x + s];
    if (v.y == 0u) { break; }
    t = z1Of(v);
  }
  return t;
}

@compute @workgroup_size(64)
fn applyCuts(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nOps) { return; }
  let o = P.opOff + gid.x * 4u;
  let x = inp[o];
  let y = inp[o + 1u];
  let c0 = inp[o + 2u];
  let nc = inp[o + 3u];
  let b = colBase(x, y);
  var a: array<vec4<u32>, MAX_IV>;
  var n = 0u;
  for (var s = 0u; s < b.y; s++) {
    let v = slots[b.x + s];
    if (v.y == 0u) { break; }
    a[n] = v;
    n++;
  }
  // (subtract: each cut in turn over what's left — colbodies.ts)
  for (var c = 0u; c < nc; c++) {
    let cz0 = bitcast<f32>(inp[P.cutOff + (c0 + c) * 2u]);
    let cz1 = bitcast<f32>(inp[P.cutOff + (c0 + c) * 2u + 1u]);
    var nx: array<vec4<u32>, MAX_IV>;
    var m = 0u;
    for (var i = 0u; i < n; i++) {
      let v = a[i];
      let z0 = z0Of(v);
      let z1 = z1Of(v);
      if (z1 <= cz0 + EPS || z0 >= cz1 - EPS) {
        if (m < MAX_IV) { nx[m] = v; }
        m++;
        continue;
      }
      if (z0 < cz0 - EPS) {
        if (m < MAX_IV) { nx[m] = vec4<u32>(v.x, bitcast<u32>(cz0), v.z, 0u); }
        m++;
      }
      if (z1 > cz1 + EPS) {
        if (m < MAX_IV) { nx[m] = vec4<u32>(bitcast<u32>(cz1), v.y, v.z, 0u); }
        m++;
      }
    }
    n = min(m, MAX_IV);
    a = nx;
  }
  // (Integrity.writeColumn: no room — the bottom K − 1 kept, the rest's height piled as rubble on top)
  let k = b.y;
  if (n > k) {
    var top = 0.0;
    if (k > 1u) { top = z1Of(a[k - 2u]); }
    var rest = 0.0;
    for (var i = k - 1u; i < n; i++) { rest += z1Of(a[i]) - z0Of(a[i]); }
    a[k - 1u] = vec4<u32>(bitcast<u32>(top), bitcast<u32>(min(top + rest, P.zMax - 1.0)), MAT_RUBBLE, 0u);
    n = k;
  }
  for (var s = 0u; s < k; s++) {
    if (s < n) { slots[b.x + s] = vec4<u32>(a[s].x, a[s].y, a[s].z, 0u); } else { slots[b.x + s] = vec4<u32>(0u); }
  }
}

/** is column key (y * mapW + x) one of the crumbled columns (a binary search of the sorted keys) */
fn gone(key: u32) -> bool {
  var lo = 0u;
  var hi = P.nGone;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    let v = inp[P.goneOff + mid];
    if (v == key) { return true; }
    if (v < key) { lo = mid + 1u; } else { hi = mid; }
  }
  return false;
}

@compute @workgroup_size(64)
fn spillTarget(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nSpill) { return; }
  let o = P.spillOff + gid.x * 4u;
  let cx = i32(inp[o]);
  let cy = i32(inp[o + 1u]);
  let mat = inp[o + 3u];
  var best = vec2<i32>(cx, cy);
  var low = 3.0e38;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let x = cx + dx;
      let y = cy + dy;
      if (x < 0 || y < 0 || x >= i32(P.mapW) || y >= i32(P.mapH)) { continue; }
      if (gone(u32(y) * P.mapW + u32(x))) { continue; }
      let t = topOf(u32(x), u32(y));
      if (t < low) { best = vec2<i32>(x, y); low = t; }
    }
  }
  let key = u32(best.y) * P.mapW + u32(best.x) + 1u;
  let slot = inp[P.looseOff + (mat & 255u)];
  // (open addressing: the target's entry, made if new)
  // (the host makes the table at least twice the cells: a free entry is always found; a weak exchange that failed
  // spuriously — old value 0 — tries the same entry again)
  var h = (key * 2654435761u) & (P.hashCap - 1u);
  loop {
    let r = atomicCompareExchangeWeak(&hash[h * 8u], 0u, key);
    if (r.exchanged || r.old_value == key) {
      atomicAdd(&hash[h * 8u + 1u], 1u);
      atomicAdd(&hash[h * 8u + 2u + slot], 1u);
      return;
    }
    if (r.old_value != 0u) { h = (h + 1u) & (P.hashCap - 1u); }
  }
}

@compute @workgroup_size(64)
fn spillDeposit(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.hashCap) { return; }
  let e = gid.x * 8u;
  let key = atomicLoad(&hash[e]);
  if (key == 0u) { return; }
  let cells = atomicLoad(&hash[e + 1u]);
  var best = 0u;
  var n = 0u;
  for (var s = 0u; s < 6u; s++) {
    let c = atomicLoad(&hash[e + 2u + s]);
    if (c > n) { best = s; n = c; }
  }
  let w = key - 1u;
  let x = w % P.mapW;
  let y = w / P.mapW;
  // (sim/pages.ts i(): the window column's place in a per-column buffer)
  let page = inp[P.pageOff + (y / 16u) * P.pagesX + x / 16u];
  let i = page * 256u + (y % 16u) * 16u + x % 16u;
  let d = deposit[i];
  deposit[i] = vec4<f32>(d.x, d.y + f32(cells), f32(P.looseMat[best / 4u][best % 4u]), d.w);
  for (var k = 0u; k < 8u; k++) { atomicStore(&hash[e + k], 0u); }
}
