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
//   claim         (round 128, INT16) a thread a column: each span [z0, z1) cut out (sim/external.ts cutOut) and made
//                 External with its fallback as aux, sorted, joined, fitted (claimColumn)
//   claimGrid     (round 128j) a thread a column of a static grid (its own buffer as `inp`): claim where free, only where
//                 the column lies in the window rectangle written now (claims written with the land: sim/static-claims.ts)
//   take          (round 128) a thread a column: the listed whole cells of the masked materials taken out of it (the
//                 voxel lattice's wake, physics/wake.ts takeCells), fitted
//   seat          (round 128) a thread a column: a model's runs seated in it (world/models.ts seatColumn: a dip below
//                 the base filled with the top's material, the runs over what was there), fitted
//
// Every kernel that writes a column writes it to `slots` (WorldGpu.layers). (Round 128 to DA-B14 it wrote layersNext
// alike, with P.twin: the column passes copied layersNext back over the layers whole. They write in place now and
// layersNext is gone; the params word stays as `spare`.)
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
  refOff: u32, spanOff: u32, stamp: u32, maskLo: u32,
  /** take: the materials taken (bits 32..63); seat: the base and the new runs' aux */
  maskHi: u32, seatBase: f32, seatAux: u32,
  /** (round 128g) claim: only where free — the masked materials (maskLo, maskHi: air, liquids; any id past 63) */
  free: u32,
  /** (round 128j, claims at load) claimGrid: the grid's place in the window (its local column (0, 0) at (gx, gy); its
   *  spans' world z plus gz: the window's), and the window rectangle written now [rx0, rx1) × [ry0, ry1) */
  gx: i32, gy: i32, gz: f32, rx0: u32,
  ry0: u32, rx1: u32, ry1: u32,
  /** (citygen M4b) a GPU-owned grid (sim/static-claims.ts gpuGrid: dense, `owned` bound, its place gx, gy, gz):
   *  its columns across and down, 1 when there is one (orphans: its spans held too; gridDamage: the one checked) */
  gw: u32, gh: u32, gOn: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
// (round 128o, DA-B9: writable — the chunks' versions after the table, sim/chunkver.ts: a column store() changes bumps
// its chunk's to P.stamp)
@group(0) @binding(1) var<storage, read_write> chunks: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read_write> slots: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> inp: array<u32>;
/** 8 words an entry: key + 1 (0: empty), cells, six votes */
@group(0) @binding(4) var<storage, read_write> hash: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> deposit: array<vec4<f32>>;
/** (citygen M4b) a GPU-owned static grid, dense (claimGrid's layout: gw × gh columns, a span each after them) */
@group(0) @binding(6) var<storage, read> owned: array<u32>;

/** (M4b) the owned grid's span over window column (x, y), when it has one: (z0, z1) window z; z1 < z0 none */
fn ownedSpan(x: u32, y: u32) -> vec2<f32> {
  if (P.gOn == 0u) { return vec2<f32>(1.0, 0.0); }
  let lx = i32(x) - P.gx;
  let ly = i32(y) - P.gy;
  if (lx < 0 || ly < 0 || u32(lx) >= P.gw || u32(ly) >= P.gh) { return vec2<f32>(1.0, 0.0); }
  let i = u32(ly) * P.gw + u32(lx);
  if (owned[i * 4u + 3u] == 0u) { return vec2<f32>(1.0, 0.0); }
  let so = P.gw * P.gh * 4u + owned[i * 4u + 2u] * 4u;
  return vec2<f32>(bitcast<f32>(owned[so]) + P.gz, bitcast<f32>(owned[so + 1u]) + P.gz);
}

const MAX_K: u32 = 16u;
/** a column's intervals while changed: K (16 at most) plus a split a cut (the host keeps an op's cuts to 32) */
const MAX_IV: u32 = 48u;
const MAT_STONE: u32 = 1u;
const MAT_RUBBLE: u32 = 4u;
const MAT_EXTERNAL: u32 = 39u;
const EPS: f32 = 1e-4;
/** sim/external.ts's tolerance */
const EPS_X: f32 = 1e-3;

/** column (x, y): its first slot and K, and (round 128o) the column itself (z, w: its chunk's version to bump) */
fn colBase(x: u32, y: u32) -> vec4<u32> {
  let cs = P.chunkSize;
  let ch = chunks[(y / cs) * P.chunksX + (x / cs)];
  return vec4<u32>(ch.x + ((y % cs) * cs + (x % cs)) * ch.y, ch.y, x, y);
}

/** (round 128o, DA-B9) column (b.z, b.w)'s chunk changed: its columns' version to this apply's stamp, and (DA-B28,
 *  `shaped`: a slot's shapekey.wgsl key changed) its 4 x 4 block's shape version (chunkver.wgsl's layout and
 *  bumpColumn's rule) */
fn bumpOf(b: vec4<u32>, shaped: bool) {
  let cs = P.chunkSize;
  let t = chunks[(b.w / cs) * P.chunksX + b.z / cs];
  // (ten vec2s a chunk, dense by its page: chunkver.wgsl VER_VEC2; its shape a word per 4 x 4 columns)
  let at = P.chunksX * (P.mapH / cs) + 10u * (t.x / (cs * cs * t.y));
  chunks[at].x = P.stamp;
  if (shaped) {
    let k = ((b.w % cs) / 4u) * (cs / 4u) + (b.z % cs) / 4u;
    chunks[at + 2u + k / 2u][k % 2u] = P.stamp;
  }
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
fn load(b: vec4<u32>, a: ptr<function, array<vec4<u32>, MAX_IV>>) -> u32 {
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
fn store(b: vec4<u32>, a: ptr<function, array<vec4<u32>, MAX_IV>>, n0: u32) {
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
  var moved = false;
  var shaped = false;
  for (var s = 0u; s < k; s++) {
    var v = vec4<u32>(0u);
    if (s < n) { v = vec4<u32>((*a)[s].xyz, 0u); }
    let old = slots[b.x + s];
    if (any(old != v)) {
      slots[b.x + s] = v;
      moved = true;
      shaped = shaped || shapeMoved(old, v);
    }
  }
  if (moved) { bumpOf(b, shaped); }
}

/** `a` (n intervals) sorted by z0, stable (insertion) */
fn sortIv(a: ptr<function, array<vec4<u32>, MAX_IV>>, n: u32) {
  for (var i = 1u; i < n; i++) {
    let v = (*a)[i];
    var j = i;
    while (j > 0u && z0Of((*a)[j - 1u]) > z0Of(v)) {
      (*a)[j] = (*a)[j - 1u];
      j--;
    }
    (*a)[j] = v;
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
  // (M4b: and the GPU-owned grid's span here — its claims are never orphans)
  let os = ownedSpan(x, y);
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
    if (os.y > os.x) {
      var nx: array<vec2<f32>, 24>;
      var q = 0u;
      for (var r = 0u; r < nr; r++) {
        let p = rest[r];
        if (os.y <= p.x + EPS_X || os.x >= p.y - EPS_X) { if (q < 24u) { nx[q] = p; } q++; continue; }
        if (os.x > p.x + EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(p.x, os.x); } q++; }
        if (os.y < p.y - EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(os.y, p.y); } q++; }
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

@compute @workgroup_size(64)
fn claim(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nOps) { return; }
  let o = P.opOff + gid.x * 4u;
  claimAt(colBase(inp[o], inp[o + 1u]), inp[o + 2u], inp[o + 3u], 0.0);
}

/**
 * (round 128j, claims at load) A static grid's claims (a town's buildings, the fortress's blocks: sim/static-claims.ts)
 * where its columns lie in the window rectangle being written now: a thread a column of the grid (its local x, y as
 * i32, the first span, the count — the grid's own buffer bound as `inp`), its spans in world z made window z by P.gz.
 * Claimed where free (P.free), as claim's: a column claimed already is unchanged (External isn't free).
 */
@compute @workgroup_size(64)
fn claimGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nOps) { return; }
  let o = P.opOff + gid.x * 4u;
  let x = bitcast<i32>(inp[o]) + P.gx;
  let y = bitcast<i32>(inp[o + 1u]) + P.gy;
  if (x < i32(P.rx0) || y < i32(P.ry0) || x >= i32(P.rx1) || y >= i32(P.ry1)) { return; }
  if (x < 0 || y < 0 || u32(x) >= P.mapW || u32(y) >= P.mapH) { return; }
  claimAt(colBase(u32(x), u32(y)), inp[o + 2u], inp[o + 3u], P.gz);
}

/** column `b` with spans s0 .. s0 + ns (at P.cutOff: z0, z1, aux, 0; z plus dz) claimed, in turn (claimColumn's rule) */
fn claimAt(b: vec4<u32>, s0: u32, ns: u32, dz: f32) {
  var a: array<vec4<u32>, MAX_IV>;
  var n = load(b, &a);
  // (each span in turn — sim/external.ts claimColumn: cut out, then External with its fallback as aux; round 128g, with
  // P.free — claimFreeColumn: only its parts that are free now, each of them so)
  for (var s = 0u; s < ns; s++) {
    let so = P.cutOff + (s0 + s) * 4u;
    var parts: array<vec2<f32>, 24>;
    var np = 1u;
    parts[0] = vec2<f32>(f(so) + dz, f(so + 1u) + dz);
    if (P.free != 0u) {
      // (sim/external.ts freeSpans: [z0, z1) less every interval that isn't free, the parts under 0.05 left out)
      for (var i = 0u; i < n; i++) {
        let v = a[i];
        if (freeMat(matOf(v))) { continue; }
        let iz0 = z0Of(v);
        let iz1 = z1Of(v);
        var nx: array<vec2<f32>, 24>;
        var q = 0u;
        for (var r = 0u; r < np; r++) {
          let p = parts[r];
          if (iz1 <= p.x + EPS_X || iz0 >= p.y - EPS_X) { if (q < 24u) { nx[q] = p; } q++; continue; }
          if (iz0 > p.x + EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(p.x, iz0); } q++; }
          if (iz1 < p.y - EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(iz1, p.y); } q++; }
        }
        parts = nx;
        np = min(q, 24u);
      }
      var kept = 0u;
      for (var r = 0u; r < np; r++) {
        if (parts[r].y - parts[r].x >= 0.05) {
          parts[kept] = parts[r];
          kept++;
        }
      }
      np = kept;
    }
    for (var r = 0u; r < np; r++) {
      let cz0 = parts[r].x;
      let cz1 = parts[r].y;
      var nx: array<vec4<u32>, MAX_IV>;
      var m = 0u;
      for (var i = 0u; i < n; i++) {
        let v = a[i];
        let z0 = z0Of(v);
        let z1 = z1Of(v);
        if (z1 <= cz0 + EPS_X || z0 >= cz1 - EPS_X) { if (m < MAX_IV) { nx[m] = v; } m++; continue; }
        if (z0 < cz0 - EPS_X) { if (m < MAX_IV) { nx[m] = vec4<u32>(v.x, bitcast<u32>(cz0), v.z, 0u); } m++; }
        if (z1 > cz1 + EPS_X) { if (m < MAX_IV) { nx[m] = vec4<u32>(bitcast<u32>(cz1), v.y, v.z, 0u); } m++; }
      }
      if (m < MAX_IV) { nx[m] = iv(cz0, cz1, MAT_EXTERNAL, inp[so + 2u]); }
      m++;
      a = nx;
      n = min(m, MAX_IV);
    }
  }
  sortIv(&a, n);
  store(b, &a, join(&a, n));
}

/** (round 128g) is material m free for a claim (P.free's mask: air, liquids; an id past 63) */
fn freeMat(m: u32) -> bool {
  if (m < 32u) { return ((P.maskLo >> m) & 1u) != 0u; }
  if (m < 64u) { return ((P.maskHi >> (m - 32u)) & 1u) != 0u; }
  return true;
}

/** is material m one the take stage's mask holds */
fn masked(m: u32) -> bool {
  if (m < 32u) { return ((P.maskLo >> m) & 1u) != 0u; }
  if (m < 64u) { return ((P.maskHi >> (m - 32u)) & 1u) != 0u; }
  return false;
}

@compute @workgroup_size(64)
fn take(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nOps) { return; }
  let o = P.opOff + gid.x * 4u;
  let b = colBase(inp[o], inp[o + 1u]);
  let c0 = inp[o + 2u];
  let nc = inp[o + 3u];
  var a: array<vec4<u32>, MAX_IV>;
  let n = load(b, &a);
  var out: array<vec4<u32>, MAX_IV>;
  var m = 0u;
  for (var i = 0u; i < n; i++) {
    let v = a[i];
    if (!masked(matOf(v))) { if (m < MAX_IV) { out[m] = v; } m++; continue; }
    // (layout.ts cellRange: the cells whose centre lies inside it; the runs of them kept, at the ends its own z0, z1)
    let e0 = i32(ceil(z0Of(v) - 0.5));
    let e1 = i32(ceil(z1Of(v) - 0.5));
    var run = -1;
    for (var z = e0; z <= e1; z++) {
      var gone = false;
      for (var c = 0u; c < nc; c++) { gone = gone || i32(inp[P.cutOff + c0 + c]) == z; }
      let keep = z < e1 && !gone;
      if (keep && run < 0) { run = z; }
      if (!keep && run >= 0) {
        var lo = f32(run);
        if (run == e0) { lo = z0Of(v); }
        var hi = f32(z);
        if (z == e1) { hi = z1Of(v); }
        if (m < MAX_IV) { out[m] = vec4<u32>(bitcast<u32>(lo), bitcast<u32>(hi), v.z, 0u); }
        m++;
        run = -1;
      }
    }
  }
  store(b, &out, min(m, MAX_IV));
}

@compute @workgroup_size(64)
fn seat(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.nOps) { return; }
  let o = P.opOff + gid.x * 4u;
  let b = colBase(inp[o], inp[o + 1u]);
  let r0 = inp[o + 2u];
  let nr = inp[o + 3u];
  var a: array<vec4<u32>, MAX_IV>;
  var n = load(b, &a);
  // (a dip below the base filled up to it with the column's top material)
  if (n > 0u && z1Of(a[n - 1u]) < P.seatBase && n < MAX_IV) {
    a[n] = iv(z1Of(a[n - 1u]), P.seatBase, matOf(a[n - 1u]), P.seatAux);
    n++;
  }
  // (models.ts mergeColumn: what was there cut round every run, the runs added, sorted, touching runs of a material joined)
  var out: array<vec4<u32>, MAX_IV>;
  var m = 0u;
  for (var i = 0u; i < n; i++) {
    var pieces: array<vec2<f32>, 24>;
    var np = 1u;
    pieces[0] = vec2<f32>(z0Of(a[i]), z1Of(a[i]));
    for (var r = 0u; r < nr; r++) {
      let rz0 = f(P.cutOff + (r0 + r) * 4u);
      let rz1 = f(P.cutOff + (r0 + r) * 4u + 1u);
      var nx: array<vec2<f32>, 24>;
      var q = 0u;
      for (var p = 0u; p < np; p++) {
        let pc = pieces[p];
        if (rz1 <= pc.x || rz0 >= pc.y) { if (q < 24u) { nx[q] = pc; } q++; continue; }
        if (pc.x < rz0) { if (q < 24u) { nx[q] = vec2<f32>(pc.x, rz0); } q++; }
        if (pc.y > rz1) { if (q < 24u) { nx[q] = vec2<f32>(rz1, pc.y); } q++; }
      }
      pieces = nx;
      np = min(q, 24u);
    }
    for (var p = 0u; p < np; p++) {
      if (m < MAX_IV) { out[m] = vec4<u32>(bitcast<u32>(pieces[p].x), bitcast<u32>(pieces[p].y), a[i].z, 0u); }
      m++;
    }
  }
  for (var r = 0u; r < nr; r++) {
    let ro = P.cutOff + (r0 + r) * 4u;
    if (m < MAX_IV) { out[m] = iv(f(ro), f(ro + 1u), inp[ro + 2u], P.seatAux); }
    m++;
  }
  m = min(m, MAX_IV);
  sortIv(&out, m);
  // (exactly touching, one material: one — the lower one's aux kept)
  var k = 0u;
  for (var i = 0u; i < m; i++) {
    let v = out[i];
    if (k > 0u && out[k - 1u].y == v.x && matOf(out[k - 1u]) == matOf(v)) {
      out[k - 1u] = vec4<u32>(out[k - 1u].x, v.y, out[k - 1u].z, 0u);
      continue;
    }
    out[k] = v;
    k++;
  }
  store(b, &out, k);
}

/**
 * (citygen M4b) The GPU-owned grid's claims checked where an edit was (the window rectangle [rx0, rx1) × [ry0, ry1)): a
 * thread a window column there; a span of the grid's that has lost a quarter cell or more to what's free (air, a
 * liquid — dug, blown out, flooded) is damaged: its owner word (a lot record + 1; 0 the town's roads) listed once in
 * `hash` (0 the count, then the owners, 64 at most; from 128 a flag an owner). What comes back: those few words.
 */
@compute @workgroup_size(8, 8)
fn gridDamage(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = P.rx0 + gid.x;
  let y = P.ry0 + gid.y;
  if (x >= P.rx1 || y >= P.ry1 || x >= P.mapW || y >= P.mapH) { return; }
  let os = ownedSpan(x, y);
  if (os.y <= os.x) { return; }
  let lx = u32(i32(x) - P.gx);
  let ly = u32(i32(y) - P.gy);
  let i = ly * P.gw + lx;
  let who = owned[P.gw * P.gh * 4u + owned[i * 4u + 2u] * 4u + 3u];
  var a: array<vec4<u32>, MAX_IV>;
  let n = load(colBase(x, y), &a);
  // (the span less every interval that isn't free: what's left is free now)
  var parts: array<vec2<f32>, 24>;
  var np = 1u;
  parts[0] = os;
  for (var k = 0u; k < n; k++) {
    let v = a[k];
    if (freeMat(matOf(v))) { continue; }
    let iz0 = z0Of(v);
    let iz1 = z1Of(v);
    var nx: array<vec2<f32>, 24>;
    var q = 0u;
    for (var r = 0u; r < np; r++) {
      let p = parts[r];
      if (iz1 <= p.x + EPS_X || iz0 >= p.y - EPS_X) { if (q < 24u) { nx[q] = p; } q++; continue; }
      if (iz0 > p.x + EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(p.x, iz0); } q++; }
      if (iz1 < p.y - EPS_X) { if (q < 24u) { nx[q] = vec2<f32>(iz1, p.y); } q++; }
    }
    parts = nx;
    np = min(q, 24u);
  }
  var lost = 0.0;
  for (var r = 0u; r < np; r++) { lost += parts[r].y - parts[r].x; }
  if (lost < 0.25) { return; }
  if (atomicExchange(&hash[128u + who], 1u) != 0u) { return; }
  let k = atomicAdd(&hash[0], 1u);
  if (k < 64u) { atomicStore(&hash[1u + k], who); }
}
