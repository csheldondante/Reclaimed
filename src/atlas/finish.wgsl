// ---- atlas/finish.wgsl --------------------------------------------------------
// (round 102, `gpugen`; atlas/finish.ts) A region's columns made into the window's form on the GPU, written straight
// into a slot of the region pool (world/region-record.ts's layout): no readback of the columns, no CPU cut, no upload.
// One invocation a column, in the order the CPU's path does it (atlas.ts landFrom, the geysers' sinter, ways.ts
// stampWays, atlas/stamps.ts applyStamps, streamer.ts cutRegion / settleLoose / splitColumn / fitColumn / packColumn
// / waterInWindow) and in the same whole 1/256ths of a cell — the same columns, bit for bit
// (scripts/gpugentest.mjs). What the CPU still keeps of a region comes back small: a column's top, its ground, its
// top and highest gap over the window (the hybrid's relief), its flags, what's outside the window.
//   mode 0: the region into the slot;  mode 1 (raw): the ground a settlement is planned on (top, water, its
//   material, plants: after the geysers and the ways, before the stamps) into the summary only

struct ColOut {
  top: f32, cover: f32, mats: u32, water: f32,
  moisture: f32, veg: f32, lava: f32, region: u32,
  kind: u32, n: u32, flags: u32, ground: f32,
  spring: f32, rvx: f32, rvy: f32, rd: f32,
}

struct FP {
  w: u32, h: u32, mode: u32, settle: u32,
  oz: i32, zMax: i32, K: u32, colK: u32,
  pageSlots: u32, rc: u32, mr: u32, hasOps: u32,
  // the slot's parts (words from the slot's start; textures: a row's words)
  oWater: u32, oWaterSource: u32, oLava: u32, oMoisture: u32,
  oVeg: u32, oPetals: u32, oLavaSpring: u32, oRiverFlow: u32,
  tRowLS: u32, tRowRF: u32, hasWays: u32, nLifts: u32,
  // the aux words: the ways (regionWays), the geysers and their stencil, the materials' flags
  aPts: u32, aBinStart: u32, aBinItems: u32, aLifts: u32,
  aRows: u32, nb: u32, mb: u32, nGeysers: u32,
  aGeysers: u32, aStencil: u32, aMats: u32, outCap: u32,
  // the md words (what comes back): the summary (vec4 a column), the flags, the marks, what's outside
  mSum: u32, mFlags: u32, mMarks: u32, mOut: u32,
  markCap: u32, _p0: u32, _p1: u32, _p2: u32,
}

@group(0) @binding(0) var<uniform> P: FP;
@group(0) @binding(1) var<storage, read> colOut: array<ColOut>;
@group(0) @binding(2) var<storage, read> colRuns: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read> aux: array<u32>;
@group(0) @binding(4) var<storage, read> ops: array<u32>;
@group(0) @binding(5) var<storage, read_write> slot: array<u32>;
@group(0) @binding(6) var<storage, read_write> md: array<u32>;
@group(0) @binding(7) var<storage, read_write> outN: array<atomic<u32>>;

const MAXI: u32 = 48u;
const MAXO: u32 = 16u;
const Q: i32 = 256;
const MAT_SINTER: i32 = 37;
const MAT_BUILT: i32 = 5;
const MAT_FILL: i32 = 2;
const MAT_PAVE: i32 = 11;
// (ways.ts WQ: the stamp's lengths in 1/256ths)
const W_REACH: i32 = 6656;
const W_HALF: i32 = 563;
const W_TUNNEL: i32 = 768;
const W_BARE: i32 = 691;
const W_PILLAR: i32 = 333;
const W_LIFT: i32 = 896;
const W_BORE: i32 = 1280;
const W_DECK: i32 = 307;
const W_PAVE: i32 = 102;
const W_STILL: i32 = 13;
const WAY_TUNNEL: i32 = 1;
const WAY_BRIDGE: i32 = 2;
const WAY_LIFT: i32 = 4;
const LAVA_HOT: f32 = 1250.0;
// (streamer.ts RELIEF_GAP: a gap over a quarter cell is open)
const RELIEF_GAP: i32 = 64;

// the column being made: (z0, z1, mat, 0), bottom to top
var<private> C: array<vec4<i32>, MAXI>;
var<private> NC: u32;
var<private> ERR: u32;

fn topC() -> i32 { if (NC == 0u) { return 0; } return C[NC - 1u].y; }

fn pushC(z0: i32, z1: i32, mat: i32) {
  if (NC >= MAXI) { ERR |= 1u << 19u; return; }
  C[NC] = vec4<i32>(z0, z1, mat, 0);
  NC++;
}

/** layout.ts addTop */
fn addTopC(dz: i32, mat: i32) {
  if (dz <= 0) { return; }
  if (NC > 0u && C[NC - 1u].z == mat) { C[NC - 1u].y += dz; return; }
  let z0 = topC();
  pushC(z0, z0 + dz, mat);
}

/** layout.ts lowerTop */
fn lowerTopC(dz: i32) {
  if (NC == 0u || dz <= 0) { return; }
  let to = C[NC - 1u].y - dz;
  while (NC > 0u && C[NC - 1u].x >= to) { NC--; }
  if (NC > 0u && C[NC - 1u].y > to) { C[NC - 1u].y = to; }
  if (NC == 0u) { pushC(0, max(128, to), 1); }
}

/** ways.ts carve: the solid between a and b taken out */
fn carveC(a: i32, b: i32) {
  var k = 0u;
  loop {
    if (k >= NC) { break; }
    let iv = C[k];
    if (iv.y <= a || iv.x >= b) { k++; continue; }
    let lo = iv.x < a;
    let hi = iv.y > b;
    if (lo && hi) {
      // split in two: room made above it
      if (NC >= MAXI) { ERR |= 1u << 19u; return; }
      for (var j = NC; j > k + 1u; j--) { C[j] = C[j - 1u]; }
      NC++;
      C[k] = vec4<i32>(iv.x, a, iv.z, 0);
      C[k + 1u] = vec4<i32>(b, iv.y, iv.z, 0);
      k += 2u;
    } else if (lo) {
      C[k].y = a;
      k++;
    } else if (hi) {
      C[k].x = b;
      k++;
    } else {
      for (var j = k; j + 1u < NC; j++) { C[j] = C[j + 1u]; }
      NC--;
    }
  }
}

/** ways.ts fillTo */
fn fillToC(T: i32, pave: bool) {
  let top = topC();
  if (T < top) { lowerTopC(top - T); } else if (T > top) { addTopC(T - top, MAT_FILL); }
  if (pave) {
    lowerTopC(W_PAVE);
    addTopC(W_PAVE, MAT_PAVE);
  }
}

fn isqrtU(n: u32) -> u32 {
  var r = u32(sqrt(f32(n)));
  while (r > 0u && r * r > n) { r--; }
  while ((r + 1u) * (r + 1u) <= n) { r++; }
  return r;
}

fn auxI(k: u32) -> i32 { return bitcast<i32>(aux[k]); }

/** the material's flags (bit 0 granular, bit 1 weak: atlas.ts WEAK) */
fn matF(m: i32) -> u32 { return aux[P.aMats + u32(m)]; }

/** ways.ts nearestWay + wayColumn: whether the way did; `bd` its distance² */
fn ways(x: u32, y: u32, bdOut: ptr<function, i32>) -> bool {
  let cx = auxI(P.aRows + y * 2u) + i32(x) * Q;
  let cy = auxI(P.aRows + y * 2u + 1u);
  var best = -1;
  var bd = W_REACH * W_REACH;
  let bi = (cx + W_REACH) / W_REACH;
  let bm = (cy + W_REACH) / W_REACH;
  for (var m = max(0, bm - 1); m <= min(i32(P.mb) - 1, bm + 1); m++) {
    for (var i = max(0, bi - 1); i <= min(i32(P.nb) - 1, bi + 1); i++) {
      let b = u32(m) * P.nb + u32(i);
      let s0 = aux[P.aBinStart + b];
      let s1 = aux[P.aBinStart + b + 1u];
      for (var q = s0; q < s1; q++) {
        let j = aux[P.aBinItems + q];
        let dx = auxI(P.aPts + j * 4u) - cx;
        let dy = auxI(P.aPts + j * 4u + 1u) - cy;
        let d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = i32(j);
        }
      }
    }
  }
  *bdOut = bd;
  var did = false;
  for (var k = 0u; k < P.nLifts; k++) {
    let dx = auxI(P.aLifts + k * 4u) - cx;
    let dy = auxI(P.aLifts + k * 4u + 1u) - cy;
    if (dx * dx + dy * dy > W_LIFT * W_LIFT) { continue; }
    let top = topC();
    let z1 = auxI(P.aLifts + k * 4u + 2u);
    if (top < z1) { addTopC(z1 - top, MAT_BUILT); }
    did = true;
  }
  if (best < 0 || did) { return did; }
  let pj = u32(best) * 4u;
  let pz = auxI(P.aPts + pj + 2u);
  let pk = aux[P.aPts + pj + 3u];
  let kind = i32(pk & 255u);
  let pillar = (pk & 256u) != 0u;
  let top = topC();
  if (kind == WAY_TUNNEL) {
    if (bd <= W_TUNNEL * W_TUNNEL && top > pz + W_BORE + Q) {
      carveC(pz, pz + W_BORE);
      did = true;
    }
  } else if (kind == WAY_BRIDGE || (kind == WAY_LIFT && top < pz - (W_DECK + Q))) {
    if (bd <= W_HALF * W_HALF && top < pz - (W_DECK + Q / 2)) {
      if (pillar && bd <= W_PILLAR * W_PILLAR) { addTopC(pz - top, MAT_BUILT); } else { pushC(pz - W_DECK, pz, MAT_BUILT); }
      did = true;
    } else if (bd <= W_HALF * W_HALF && top <= pz + Q) {
      fillToC(pz, true);
      did = true;
    }
  } else {
    let on = bd <= W_HALF * W_HALF;
    let off = max(i32(isqrtU(u32(bd))) - W_HALF, 0);
    var T = pz;
    if (!on) { T = pz + max(-off, min(off, top - pz)); }
    if (abs(T - top) >= W_STILL || on) {
      fillToC(T, on);
      did = true;
    }
  }
  return did;
}

/** atlas/stamps.ts applyStamps: column i's operations; `veg` its plants */
fn stampOps(i: u32, veg: ptr<function, f32>) {
  let o0 = ops[i * 2u];
  let n = ops[i * 2u + 1u];
  var k = o0;
  let end = o0 + n;
  loop {
    if (k >= end) { break; }
    let h = ops[k];
    let op = h & 63u;
    if (op == 1u) {
      let ni = h >> 8u;
      let lo = bitcast<i32>(ops[k + 1u]);
      let cut = bitcast<i32>(ops[k + 2u]);
      let h0 = bitcast<i32>(ops[k + 3u]);
      let h1 = bitcast<i32>(ops[k + 4u]);
      k += 5u;
      // (what stands above lo goes)
      var m = 0u;
      for (var j = 0u; j < NC; j++) {
        if (C[j].x >= lo) { continue; }
        C[m] = C[j];
        if (C[m].y > lo) { C[m].y = lo; }
        m++;
      }
      NC = m;
      if (cut != 0) { lowerTopC(cut); }
      if ((h & 64u) != 0u) {
        var j = i32(NC) - 1;
        loop {
          if (j < 0) { break; }
          let iv = C[u32(j)];
          if (iv.y <= h0 || iv.x >= h1) { j--; continue; }
          let lo2 = iv.x < h0;
          let hi2 = iv.y > h1;
          if (lo2 && hi2) {
            if (NC >= MAXI) { ERR |= 1u << 19u; return; }
            for (var t = NC; t > u32(j) + 1u; t--) { C[t] = C[t - 1u]; }
            NC++;
            C[u32(j)] = vec4<i32>(iv.x, h0, iv.z, 0);
            C[u32(j) + 1u] = vec4<i32>(h1, iv.y, iv.z, 0);
          } else if (lo2) {
            C[u32(j)].y = h0;
          } else if (hi2) {
            C[u32(j)].x = h1;
          } else {
            for (var t = u32(j); t + 1u < NC; t++) { C[t] = C[t + 1u]; }
            NC--;
          }
          j--;
        }
      }
      for (var j = 0u; j < ni; j++) {
        pushC(bitcast<i32>(ops[k]), bitcast<i32>(ops[k + 1u]), i32(ops[k + 2u]));
        k += 3u;
      }
      if ((h & 128u) != 0u) { *veg = 0.0; }
    } else if (op == 2u) {
      let mk = ops[k + 3u];
      if (mk != 0u) {
        if (mk - 1u < P.markCap) { md[P.mMarks + mk - 1u] = bitcast<u32>(f32(topC()) / 256.0); } else { ERR |= 1u << 21u; }
      }
      addTopC(bitcast<i32>(ops[k + 1u]), i32(ops[k + 2u]));
      k += 4u;
    } else if (op == 3u) {
      *veg = max(*veg, bitcast<f32>(ops[k + 1u]));
      k += 2u;
    } else if (op == 4u) {
      *veg = 0.0;
      k += 1u;
    } else {
      ERR |= 1u << 22u;
      return;
    }
  }
}

/** streamer.ts settleLoose: loose intervals with air under them dropped onto what's under them. Whether any moved. */
fn settleC() -> bool {
  var moved = false;
  var support = -2147483647;
  var k = 0u;
  loop {
    if (k >= NC) { break; }
    let iv = C[k];
    if ((matF(iv.z) & 1u) != 0u && k > 0u && iv.x > support) {
      let drop = iv.x - support;
      C[k].x -= drop;
      C[k].y -= drop;
      moved = true;
      let below = C[k - 1u];
      if (below.z == C[k].z && below.y == C[k].x) {
        C[k - 1u].y = C[k].y;
        for (var j = k; j + 1u < NC; j++) { C[j] = C[j + 1u]; }
        NC--;
        support = C[k - 1u].y;
        continue;
      }
    }
    support = C[k].y;
    k++;
  }
  return moved;
}

fn f(z: i32) -> f32 { return f32(z) / 256.0; }
fn fb(z: i32) -> u32 { return bitcast<u32>(f32(z) / 256.0); }

@compute @workgroup_size(8, 8)
fn finish(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.w || gid.y >= P.h) { return; }
  let x = gid.x;
  let y = gid.y;
  let i = y * P.w + x;
  let co = colOut[i];
  ERR = 0u;
  if ((co.flags & 1u) != 0u) { ERR |= 1u << 16u; }
  if ((co.flags & 2u) != 0u) { ERR |= 1u << 17u; }
  // ---- landFrom: the runs, alike neighbours merged ----
  NC = 0u;
  var structural = false;
  for (var k = 0u; k < co.n; k++) {
    let r = colRuns[i * P.mr + k];
    let z0 = i32(r.x & 0x7fffffffu);
    let z1 = i32(r.y & 0xffffffu);
    let mat = i32(r.y >> 24u);
    if ((r.x >> 31u) == 1u && (matF(mat) & 2u) != 0u) { structural = true; }
    if (NC > 0u && C[NC - 1u].z == mat && z0 <= C[NC - 1u].y) { C[NC - 1u].y = z1; } else { pushC(z0, z1, mat); }
  }
  if (NC == 0u) { ERR |= 1u << 18u; }
  let landTop = topC();
  var veg = co.veg;
  var ground = co.ground;
  // ---- the geysers' sinter (atlas.ts regionLand: the stencil made on the CPU) ----
  for (var g = 0u; g < P.nGeysers; g++) {
    let dx = i32(x) - auxI(P.aGeysers + g * 2u);
    let dy = i32(y) - auxI(P.aGeysers + g * 2u + 1u);
    if (abs(dx) > 4 || abs(dy) > 4 || NC == 0u) { continue; }
    let s = aux[P.aStencil + u32((dy + 4) * 9 + dx + 4)];
    let kind = s & 3u;
    if (kind == 0u) { continue; }
    let dz = i32(s >> 2u);
    if (kind == 1u) { lowerTopC(dz); } else { addTopC(dz, MAT_SINTER); }
    veg = 0.0;
  }
  // ---- the ways ----
  if (P.hasWays != 0u) {
    var bd = 0;
    if (ways(x, y, &bd)) {
      ground = f(topC());
      if (bd <= W_BARE * W_BARE) { veg = 0.0; }
    }
  }
  if (P.mode == 1u) {
    var mat = 0u;
    if (NC > 0u) { mat = u32(C[NC - 1u].z); }
    let so = P.mSum + i * 4u;
    md[so] = fb(topC());
    md[so + 1u] = bitcast<u32>(co.water);
    md[so + 2u] = mat;
    md[so + 3u] = bitcast<u32>(veg);
    md[P.mFlags + i] = ERR;
    return;
  }
  // ---- what's built on it (atlas/stamps.ts) ----
  if (P.hasOps != 0u) { stampOps(i, &veg); }
  // ---- streamer.ts cutRegion ----
  var flags = 0u;
  if (structural) { flags |= 1u; }
  if (P.settle != 0u && settleC()) { flags |= 4u; }
  let topW = topC();
  // splitColumn at oz: inside (window z) into I, outside (world z) into O
  var I: array<vec4<i32>, MAXI>;
  var NI = 0u;
  var O: array<vec4<i32>, MAXO>;
  var NO = 0u;
  let lo = P.oz;
  let hi = P.oz + P.zMax;
  for (var k = 0u; k < NC; k++) {
    let iv = C[k];
    if (iv.x < lo) {
      if (NO < MAXO) { O[NO] = vec4<i32>(iv.x, min(iv.y, lo), iv.z, 0); NO++; } else { ERR |= 1u << 20u; }
    }
    if (iv.y > lo && iv.x < hi) {
      I[NI] = vec4<i32>(max(iv.x, lo) - lo, min(iv.y, hi) - lo, iv.z, 0);
      NI++;
    }
    if (iv.y > hi) {
      if (NO < MAXO) { O[NO] = vec4<i32>(max(iv.x, hi), iv.y, iv.z, 0); NO++; } else { ERR |= 1u << 20u; }
    }
  }
  var over = false;
  for (var k = 0u; k < NO; k++) { if (O[k].x >= hi) { over = true; } }
  let topIn = NI > 0u && !over;
  // fitColumn: at most colK, the neighbours closest to being one made one
  if (NI > P.colK) { flags |= 2u; }
  while (NI > P.colK) {
    var best = 1u;
    var bc = 2147483647;
    for (var k = 1u; k < NI; k++) {
      let a = I[k - 1u];
      let b = I[k];
      var c = b.x - a.y + min(b.y - b.x, a.y - a.x);
      if ((matF(a.z) & 1u) != (matF(b.z) & 1u)) { c += 3 * Q; }
      if (c < bc) { bc = c; best = k; }
    }
    let a = I[best - 1u];
    let b = I[best];
    var mat = a.z;
    if (b.y - b.x > a.y - a.x) { mat = b.z; }
    I[best - 1u] = vec4<i32>(a.x, b.y, mat, 0);
    for (var k = best; k + 1u < NI; k++) { I[k] = I[k + 1u]; }
    NI--;
  }
  // packColumn into its page's slots
  let page = (y / 16u) * P.rc + x / 16u;
  let sb = (page * P.pageSlots + ((y % 16u) * 16u + x % 16u) * P.K) * 4u;
  for (var s = 0u; s < NI && s < P.K; s++) {
    slot[sb + s * 4u] = fb(I[s].x);
    slot[sb + s * 4u + 1u] = fb(I[s].y);
    slot[sb + s * 4u + 2u] = u32(I[s].z) & 0xffu;
  }
  var inTop = 0;
  if (NI > 0u) { inTop = I[NI - 1u].y; }
  // waterInWindow: over its top in the window (or over the floor), to the water's level
  var water = 0.0;
  if (NC > 0u && !over) {
    let d = (topW - lo) - inTop;
    water = max(0.0, min(co.water + f(d), f(P.zMax - inTop)));
  }
  slot[P.oWater + i] = bitcast<u32>(water);
  slot[P.oMoisture + i] = bitcast<u32>(co.moisture);
  slot[P.oVeg + i] = bitcast<u32>(veg);
  slot[P.oPetals + i] = bitcast<u32>(1.0);
  if (topIn) {
    slot[P.oWaterSource + i] = bitcast<u32>(co.spring);
    if (co.lava > 0.0) {
      let lw = (f(landTop) + co.lava) - f(lo);
      slot[P.oLava + i * 4u] = bitcast<u32>(co.lava);
      slot[P.oLava + i * 4u + 1u] = bitcast<u32>(LAVA_HOT);
      slot[P.oLava + i * 4u + 3u] = bitcast<u32>(lw);
    }
    if (co.rd > 0.0) {
      let t = P.oRiverFlow + y * P.tRowRF + x * 4u;
      slot[t] = bitcast<u32>(co.rvx);
      slot[t + 1u] = bitcast<u32>(co.rvy);
      slot[t + 2u] = bitcast<u32>(co.water);
      slot[t + 3u] = bitcast<u32>(co.rd);
    }
  }
  if (co.lava > 0.0) { slot[P.oLavaSpring + y * P.tRowLS + x * 4u] = bitcast<u32>(co.lava); }
  // ---- what the CPU keeps: the summary (the relief from the column joined again: streamer.ts setReliefIn) ----
  var colTop = 0;
  var gapTop = -2147483647;
  var hasGap = false;
  var lz1 = 0;
  var lmat = -1;
  var nj = 0u;
  // (joinColumn: the outside below, the window's, the outside above; alike pieces touching made one)
  for (var ph = 0u; ph < 3u; ph++) {
    let n = select(NI, NO, ph != 1u);
    for (var k = 0u; k < n; k++) {
      var iv: vec4<i32>;
      if (ph == 1u) { iv = I[k] + vec4<i32>(lo, lo, 0, 0); } else {
        iv = O[k];
        if ((ph == 0u) != (iv.x < lo)) { continue; }
      }
      if (nj > 0u && iv.z == lmat && iv.x == lz1) {
        lz1 = max(lz1, iv.y);
      } else {
        if (nj > 0u && iv.x - lz1 > RELIEF_GAP) { gapTop = iv.x; hasGap = true; }
        lz1 = iv.y;
        lmat = iv.z;
        nj++;
      }
    }
  }
  colTop = lz1;
  let so = P.mSum + i * 4u;
  md[so] = fb(inTop);
  md[so + 1u] = bitcast<u32>(ground - f(lo));
  md[so + 2u] = fb(colTop);
  md[so + 3u] = select(0xff800000u, fb(gapTop), hasGap);
  // what's outside the window: a list, (column, its index) and the interval
  if (NO > 0u) {
    let at = atomicAdd(&outN[0], NO);
    for (var k = 0u; k < NO; k++) {
      if (at + k >= P.outCap) { ERR |= 1u << 20u; break; }
      let e = P.mOut + (at + k) * 4u;
      md[e] = (i << 5u) | k;
      md[e + 1u] = bitcast<u32>(O[k].x);
      md[e + 2u] = bitcast<u32>(O[k].y);
      md[e + 3u] = u32(O[k].z);
    }
  }
  md[P.mFlags + i] = flags | (min(NO, 255u) << 8u) | ERR;
}
