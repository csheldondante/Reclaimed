// ---- colapply.wgsl ------------------------------------------------------------------------------------------------
// (round 120, JB6: "no CPU readback on the hot path") Changes to the GPU's columns made in place, so the integrity
// system needs no CPU copy of the columns to make them: a collapse verdict's cuts and its crumbs spilled, loose ground
// laid, External intervals let go (sim/external.ts release) and orphans made ground again (orphans). Each kernel is the
// GPU's statement of a CPU rule (game/colapply.ts: cutColumn, spillPlan, releaseColumn, orphanColumn), held equal to it by
// test/gpu/colapply.test.ts. Standalone (as judge.wgsl): its own params, the GPU's chunk table and slots.
//
//   applyCuts     a thread a column: cuts [z0, z1) taken out of it (colbodies.ts subtract: any material; 1e-4), then
//                 fitted to its K slots (the bottom K − 1 kept, the rest's height piled as rubble on top)
//   spillTarget   a thread a crumbled cell: the lowest-topped column of the 3 x 3 round it (offset coordinates, dy then
//                 dx, the first lowest) that isn't one of the crumbled columns; its loose material voted into a hash
//   spillDeposit  a thread a hash entry: the target's deposit gets its cells (deposit.y +=) and the material most voted
//                 for (ties: the lowest material id); the entry cleared for the next use
//   depositAdd    a thread a column: loose ground laid (deposit.y += amount, deposit.z its material) — added, never
//                 overwritten (sediment.wgsl folds the deposit into the layers and clears it)
//   release       a thread a column: External intervals within each span let go — to its fallback material, or air —
//                 the column's touching runs of a material joined, then fitted
//   orphans       a thread a window column: the parts of its External intervals no claimed span covers become their
//                 fallback material (aux; 0: stone), joined, fitted
//
// `inp` (u32) holds every list at the offsets the params give; f32s as their bits.

struct Params {
  mapW: u32, mapH: u32, chunksX: u32, chunkSize: u32,
  nOps: u32, nSpill: u32, nGone: u32, hashCap: u32,
  opOff: u32, cutOff: u32, spillOff: u32, goneOff: u32,
  pageOff: u32, looseOff: u32, pagesX: u32, zMax: f32,
  /** the six loose materials (looseFrom's results), ascending */
  looseMat: array<vec4<u32>, 2>,
  /** depositAdd: entries (x, y, amount, mat); orphans: claimed column keys (sorted), their (first, count), spans */
  nDep: u32, depOff: u32, nKeys: u32, keyOff: u32,
  refOff: u32, spanOff: u32, pad0: u32, pad1: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read_write> slots: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> inp: array<u32>;
/** 8 words an entry: key + 1 (0: empty), cells, six votes */
@group(0) @binding(4) var<storage, read_write> hash: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> deposit: array<vec4<f32>>;

const MAX_K: u32 = 16u;
/** a column's intervals while changed: K (16 at most) plus a split a cut (the host keeps an op's cuts to 32) */
const MAX_IV: u32 = 48u;
const MAT_STONE: u32 = 1u;
const MAT_RUBBLE: u32 = 4u;
const MAT_EXTERNAL: u32 = 39u;
const EPS: f32 = 1e-4;
/** sim/external.ts's tolerance */
const EPS_X: f32 = 1e-3;

fn colBase(x: u32, y: u32) -> vec2<u32> {
  let cs = P.chunkSize;
  let ch = chunks[(y / cs) * P.chunksX + (x / cs)];
  return vec2<u32>(ch.x + ((y % cs) * cs + (x % cs)) * ch.y, ch.y);
}

fn z0Of(v: vec4<u32>) -> f32 { return bitcast<f32>(v.x); }
fn z1Of(v: vec4<u32>) -> f32 { return bitcast<f32>(v.y); }
fn matOf(v: vec4<u32>) -> u32 { return v.z & 255u; }
fn auxOf(v: vec4<u32>) -> u32 { return (v.z >> 8u) & 255u; }
fn iv(z0: f32, z1: f32, mat: u32, aux: u32) -> vec4<u32> { return vec4<u32>(bitcast<u32>(z0), bitcast<u32>(z1), (mat & 255u) | ((aux & 255u) << 8u), 0u); }
fn f(i: u32) -> f32 { return bitcast<f32>(inp[i]); }

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

/** column (x, y) into `a`: its count */
fn load(b: vec2<u32>, a: ptr<function, array<vec4<u32>, MAX_IV>>) -> u32 {
  var n = 0u;
  for (var s = 0u; s < b.y; s++) {
    let v = slots[b.x + s];
    if (v.y == 0u) { break; }
    (*a)[n] = v;
    n++;
  }
  return n;
}

/** `a` (n intervals) written back to its K slots: over K, the bottom K − 1 kept and the rest's height as rubble on top */
fn store(b: vec2<u32>, a: ptr<function, array<vec4<u32>, MAX_IV>>, n0: u32) {
  var n = n0;
  let k = b.y;
  if (n > k) {
    var top = 0.0;
    if (k > 1u) { top = z1Of((*a)[k - 2u]); }
    var rest = 0.0;
    for (var i = k - 1u; i < n; i++) { rest += z1Of((*a)[i]) - z0Of((*a)[i]); }
    (*a)[k - 1u] = iv(top, min(top + rest, P.zMax - 1.0), MAT_RUBBLE, 0u);
    n = k;
  }
  for (var s = 0u; s < k; s++) {
    if (s < n) { slots[b.x + s] = vec4<u32>((*a)[s].xyz, 0u); } else { slots[b.x + s] = vec4<u32>(0u); }
  }
}

/** touching runs of one material and aux joined (sim/external.ts join; `a` is in order) */
fn join(a: ptr<function, array<vec4<u32>, MAX_IV>>, n: u32) -> u32 {
  var m = 0u;
  for (var i = 0u; i < n; i++) {
    let v = (*a)[i];
    if (m > 0u) {
      let last = (*a)[m - 1u];
      if (matOf(last) == matOf(v) && abs(z1Of(last) - z0Of(v)) < 1e-4 && auxOf(last) == auxOf(v)) {
        (*a)[m - 1u] = vec4<u32>(last.x, v.y, last.z, 0u);
        continue;
      }
    }
    (*a)[m] = v;
    m++;
  }
  return m;
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
  var n = load(b, &a);
  // (subtract: each cut in turn over what's left — colbodies.ts)
  for (var c = 0u; c < nc; c++) {
    let cz0 = f(P.cutOff + (c0 + c) * 2u);
    let cz1 = f(P.cutOff + (c0 + c) * 2u + 1u);
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
  store(b, &a, n);
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

/** a window column's place in a per-column buffer (sim/pages.ts i()) */
fn depIdx(x: u32, y: u32) -> u32 {
  let page = inp[P.pageOff + (y / 16u) * P.pagesX + x / 16u];
  return page * 256u + (y % 16u) * 16u + x % 16u;
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
  let i = depIdx(w % P.mapW, w / P.mapW);
  let d = deposit[i];
  deposit[i] = vec4<f32>(d.x, d.y + f32(cells), f32(P.looseMat[best / 4u][best % 4u]), d.w);
  for (var k = 0u; k < 8u; k++) { atomicStore(&hash[e + k], 0u); }
}

@compute @workgroup_size(64)
fn depositAdd(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nDep) { return; }
  let o = P.depOff + gid.x * 4u;
  let i = depIdx(inp[o], inp[o + 1u]);
  let d = deposit[i];
  deposit[i] = vec4<f32>(d.x, d.y + f(o + 2u), f32(inp[o + 3u]), d.w);
}

@compute @workgroup_size(64)
fn release(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nOps) { return; }
  let o = P.opOff + gid.x * 4u;
  let b = colBase(inp[o], inp[o + 1u]);
  let s0 = inp[o + 2u];
  let ns = inp[o + 3u];
  var a: array<vec4<u32>, MAX_IV>;
  var n = load(b, &a);
  var changed = false;
  // (each span in turn — an instance's in this column: sim/external.ts release)
  for (var s = 0u; s < ns; s++) {
    let so = P.cutOff + (s0 + s) * 4u;
    let cz0 = f(so);
    let cz1 = f(so + 1u);
    var fb = inp[so + 2u];
    if (fb == 0u) { fb = MAT_STONE; }
    let toAir = inp[so + 3u] != 0u;
    var nx: array<vec4<u32>, MAX_IV>;
    var m = 0u;
    var hit = false;
    for (var i = 0u; i < n; i++) {
      let v = a[i];
      let z0 = z0Of(v);
      let z1 = z1Of(v);
      if (matOf(v) != MAT_EXTERNAL || z1 <= cz0 + EPS_X || z0 >= cz1 - EPS_X) {
        if (m < MAX_IV) { nx[m] = v; }
        m++;
        continue;
      }
      hit = true;
      if (z0 < cz0 - EPS_X) { if (m < MAX_IV) { nx[m] = vec4<u32>(v.x, bitcast<u32>(cz0), v.z, 0u); } m++; }
      if (!toAir) { if (m < MAX_IV) { nx[m] = iv(max(z0, cz0), min(z1, cz1), fb, 0u); } m++; }
      if (z1 > cz1 + EPS_X) { if (m < MAX_IV) { nx[m] = vec4<u32>(bitcast<u32>(cz1), v.y, v.z, 0u); } m++; }
    }
    if (!hit) { continue; }
    changed = true;
    a = nx;
    n = join(&a, min(m, MAX_IV));
  }
  if (changed) { store(b, &a, n); }
}

/** the claimed spans' column key: its index in the sorted keys (P.nKeys: none) */
fn keyAt(key: u32) -> u32 {
  var lo = 0u;
  var hi = P.nKeys;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    let v = inp[P.keyOff + mid];
    if (v == key) { return mid; }
    if (v < key) { lo = mid + 1u; } else { hi = mid; }
  }
  return P.nKeys;
}

@compute @workgroup_size(64)
fn orphans(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.mapW * P.mapH) { return; }
  let x = gid.x % P.mapW;
  let y = gid.x / P.mapW;
  let b = colBase(x, y);
  var a: array<vec4<u32>, MAX_IV>;
  let n = load(b, &a);
  var ext = false;
  for (var i = 0u; i < n; i++) { ext = ext || matOf(a[i]) == MAT_EXTERNAL; }
  if (!ext) { return; }
  // (sim/external.ts keys columns y · 65536 + x)
  let ki = keyAt(y * 65536u + x);
  var c0 = 0u;
  var nc = 0u;
  if (ki < P.nKeys) {
    c0 = inp[P.refOff + ki * 2u];
    nc = inp[P.refOff + ki * 2u + 1u];
  }
  var out: array<vec4<u32>, MAX_IV>;
  var m = 0u;
  var changed = false;
  for (var i = 0u; i < n; i++) {
    let v = a[i];
    if (matOf(v) != MAT_EXTERNAL) { if (m < MAX_IV) { out[m] = v; } m++; continue; }
    // (the parts of it no claimed span holds, in order)
    var rest: array<vec2<f32>, 24>;
    var nr = 1u;
    rest[0] = vec2<f32>(z0Of(v), z1Of(v));
    for (var c = 0u; c < nc; c++) {
      let sz0 = f(P.spanOff + (c0 + c) * 2u);
      let sz1 = f(P.spanOff + (c0 + c) * 2u + 1u);
      var nx: array<vec2<f32>, 24>;
      var q = 0u;
      for (var r = 0u; r < nr; r++) {
        let p = rest[r];
        if (sz1 <= p.x + EPS_X || sz0 >= p.y - EPS_X) { if (q < 24u) { nx[q] = p; } q++; continue; }
        if (sz0 > p.x + EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(p.x, sz0); } q++; }
        if (sz1 < p.y - EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(sz1, p.y); } q++; }
      }
      rest = nx;
      nr = min(q, 24u);
    }
    if (nr == 0u) { if (m < MAX_IV) { out[m] = v; } m++; continue; }
    changed = true;
    var fb = auxOf(v);
    if (fb == 0u) { fb = MAT_STONE; }
    var z = z0Of(v);
    for (var r = 0u; r < nr; r++) {
      if (rest[r].x > z + EPS_X) { if (m < MAX_IV) { out[m] = vec4<u32>(bitcast<u32>(z), bitcast<u32>(rest[r].x), v.z, 0u); } m++; }
      if (m < MAX_IV) { out[m] = iv(rest[r].x, rest[r].y, fb, 0u); }
      m++;
      z = rest[r].y;
    }
    if (z1Of(v) > z + EPS_X) { if (m < MAX_IV) { out[m] = vec4<u32>(bitcast<u32>(z), v.y, v.z, 0u); } m++; }
  }
  if (!changed) { return; }
  let nj = join(&out, min(m, MAX_IV));
  store(b, &out, nj);
}
