// build.wgsl: the pairs, build (a thread a window column), adjacency, the workgroup's sums (part 2 of 5 of the judgeWgsl shader, joined in order by judge.ts)
// ---- the pairs: a run at each of its levels, (v, k) for 1 ≤ k ≤ dist(v) — the component of everything ≥ k out that
// v is in is the pairs' connected component at level k. Their fields in W after the levels (pf) ----
const P_PAR: u32 = 0u;
const P_NODE: u32 = 1u;
const P_RT: u32 = 2u;
const P_M: u32 = 3u; // 4: mass, its first moments
const P_U: u32 = 7u; // 9: the faces' unprojected sums (faces' N_FU)
const P_D: u32 = 16u; // 30: per direction Σh, Σh·zc, Σ(h³/12 + h·zc²), zmin, zmax
const P_STR: u32 = 46u;
const P_INF: u32 = 47u;
const P_KIND: u32 = 48u;
const P_PIVX: u32 = 49u;
const P_PIVY: u32 = 50u;
const P_PIVZ: u32 = 51u;
const P_AXX: u32 = 52u;
const P_AXY: u32 = 53u;
const P_LIST: u32 = 54u;
const P_TS: u32 = 55u;
const NPF: u32 = 56u;
fn pw(f: u32, q: u32) -> u32 { return cnt(NCOUNT) + 3u * (P.maxLevels + 2u) + f * P.pcap + q; }
/** run v's pair at level k */
fn pairOf(v: u32, k: u32) -> u32 { return nu(N_PBASE, v) + k - 1u; }

fn nu(f: u32, n: u32) -> u32 { return N[f * P.ncap + n]; }
fn nf(f: u32, n: u32) -> f32 { return bitcast<f32>(N[f * P.ncap + n]); }
fn nst(f: u32, n: u32, v: u32) { N[f * P.ncap + n] = v; }
fn ld(i: u32) -> u32 { return atomicLoad(&W[i]); }
fn st(i: u32, v: u32) { atomicStore(&W[i], v); }
fn ldf(i: u32) -> f32 { return bitcast<f32>(atomicLoad(&W[i])); }
fn stf(i: u32, v: f32) { atomicStore(&W[i], bitcast<u32>(v)); }
fn addf(i: u32, v: f32) {
  if (v == 0.0) { return; }
  var old = atomicLoad(&W[i]);
  loop {
    let r = atomicCompareExchangeWeak(&W[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}
/** (non-negative floats order as their bits) */
fn minf(i: u32, v: f32) { atomicMin(&W[i], bitcast<u32>(max(v, 0.0))); }
fn maxf(i: u32, v: f32) { atomicMax(&W[i], bitcast<u32>(max(v, 0.0))); }
fn oadd(i: u32, v: u32) { atomicAdd(&O[i], v); }

/** world cell (x, y) of window column c */
fn colXY(c: u32) -> vec2<i32> { return vec2<i32>(i32(P.ox + c % P.ww), i32(P.oy + c / P.ww)); }
/** world (x, y) of a cell's centre (lattice.ts cellPos) */
fn cellPos(q: vec2<i32>) -> vec2<f32> { return vec2<f32>(f32(q.x) + 0.5 + 0.5 * f32(q.y & 1), (f32(q.y) + 0.5) * ROW_H); }
fn nbrOf(q: vec2<i32>, d: u32) -> vec2<i32> {
  if ((q.y & 1) == 0) { return q + DOFF_E[d]; }
  return q + DOFF_O[d];
}
/** window column of world cell q (NONE: off the window) */
fn winCol(q: vec2<i32>) -> u32 {
  let x = q.x - i32(P.ox);
  let y = q.y - i32(P.oy);
  if (x < 0 || y < 0 || x >= i32(P.ww) || y >= i32(P.wh)) { return NONE; }
  return u32(y) * P.ww + u32(x);
}
fn onMap(q: vec2<i32>) -> bool { return q.x >= 0 && q.y >= 0 && q.x < i32(P.mapW) && q.y < i32(P.mapH); }

fn isMatter(m: u32) -> bool {
  let s = u32(MT[m].x);
  return s != ST_EMPTY && s != ST_LIQUID;
}
fn sideHolds(m: u32) -> bool {
  let s = u32(MT[m].x);
  return s == ST_SOLID || s == ST_VEG;
}

// ---- build: a thread a window column -------------------------------------------------------------------------------
@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= P.ww * P.wh) { return; }
  let q = colXY(c);
  let cs = P.chunkSize;
  let ch = chunks[(u32(q.y) / cs) * P.chunksX + u32(q.x) / cs];
  let base = ch.x + ((u32(q.y) % cs) * cs + (u32(q.x) % cs)) * ch.y;
  let k = ch.y;
  // count the runs (fracture.ts columnRuns: touching intervals of matter, films FILM_GAP apart touch)
  var n = 0u;
  var open = false;
  var top = 0.0;
  for (var s = 0u; s < k; s++) {
    let v = slots[base + s];
    if (v.y == 0u) { break; }
    if (!isMatter(v.z & 0xffu)) { open = false; continue; }
    let z0 = bitcast<f32>(v.x);
    let z1 = bitcast<f32>(v.y);
    if (!open || z0 > top + P.filmGap) { n++; top = z1; } else { top = max(top, z1); }
    open = true;
  }
  let id0 = atomicAdd(&W[cnt(C_NODES)], n);
  N[colArr(0u, c)] = id0;
  N[colArr(1u, c)] = n;
  if (id0 + n > P.ncap) { st(cnt(C_OVER), 1u); return; }
  let cm = colMask[c];
  var r = 0u;
  open = false;
  top = 0.0;
  // the run being summed
  var rz0 = 0.0;
  var rz1 = 0.0;
  var sh0 = 1e9;
  var sh1 = -1e9;
  var mass = 0.0;
  var mz = 0.0;
  var str = 1e9;
  var tsh = 1e9;
  var fl = 0u;
  var sl0 = 0u;
  var sln = 0u;
  for (var s = 0u; s <= k; s++) {
    var v = vec4<u32>(0u, 0u, 0u, 0u);
    if (s < k) { v = slots[base + s]; }
    let m = v.z & 0xffu;
    let matter = v.y != 0u && isMatter(m);
    let z0 = bitcast<f32>(v.x);
    let z1 = bitcast<f32>(v.y);
    let starts = matter && (!open || z0 > top + P.filmGap);
    // a run ends: written out
    if (open && (!matter || starts)) {
      let id = id0 + r;
      r++;
      N[id] = c;
      N[N_Z0 * P.ncap + id] = bitcast<u32>(rz0);
      N[N_Z1 * P.ncap + id] = bitcast<u32>(rz1);
      N[N_SH0 * P.ncap + id] = bitcast<u32>(sh0);
      N[N_SH1 * P.ncap + id] = bitcast<u32>(sh1);
      N[N_MASS * P.ncap + id] = bitcast<u32>(mass);
      N[N_MZ * P.ncap + id] = bitcast<u32>(mz);
      N[N_STR * P.ncap + id] = bitcast<u32>(str);
      N[N_TS * P.ncap + id] = bitcast<u32>(tsh);
      N[N_FLAGS * P.ncap + id] = fl;
      N[N_SL0 * P.ncap + id] = sl0;
      N[N_SLN * P.ncap + id] = sln;
      open = false;
    }
    if (v.y == 0u) { break; }
    if (!matter) { continue; }
    if (starts) {
      rz0 = z0;
      rz1 = z1;
      sh0 = 1e9;
      sh1 = -1e9;
      mass = 0.0;
      mz = 0.0;
      str = 1e9;
      tsh = 1e9;
      fl = 0u;
      if (z0 < 1e-3) { fl |= NF_STANDS; }
      if ((cm & 1u) != 0u) { fl |= NF_SEEDED; }
      if ((cm & 2u) != 0u) { fl |= NF_WEIGHED; }
      sl0 = base + s;
      top = z1;
    }
    open = true;
    top = max(top, z1);
    rz1 = max(rz1, z1);
    sln = base + s + 1u - sl0;
    let mt = MT[m];
    // (a column is a hex prism √3/2 m² across: its mass in tonnes of rock of density 1 a cubic metre)
    let dm = max(z1 - z0, 0.0) * mt.z * ROW_H;
    mass += dm;
    mz += dm * 0.5 * (z0 + z1);
    if (u32(mt.x) == ST_SOLID) { fl |= NF_SOLID; }
    if (sideHolds(m)) {
      fl |= NF_SIDE;
      sh0 = min(sh0, z0);
      sh1 = max(sh1, z1);
      str = min(str, mt.y);
      tsh = min(tsh, mt.y * select(mt.w, 1.0, mt.w < -0.5));
      if (mt.w < -0.5) { fl |= NF_BED; }
    }
  }
}

/** do runs a and b (neighbouring columns) hold each other: side-holding extents touching (fracture.ts touch) */
fn joinedNodes(a: u32, b: u32) -> bool {
  let fa = nu(N_FLAGS, a);
  let fb = nu(N_FLAGS, b);
  if ((fa & fb & NF_SIDE) == 0u) { return false; }
  let a0 = nf(N_SH0, a);
  let a1 = nf(N_SH1, a);
  let b0 = nf(N_SH0, b);
  let b1 = nf(N_SH1, b);
  let o = min(a1, b1) - max(a0, b0);
  return o > 1e-3 && o >= min(P.overlap, 0.5 * min(a1 - a0, b1 - b0));
}

// ---- adjacency: a thread a node ------------------------------------------------------------------------------------
@compute @workgroup_size(64)
fn adjacency(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let n = min(ld(cnt(C_NODES)), P.ncap);
  if (i >= n) { return; }
  let c = nu(N_COL, i);
  let q = colXY(c);
  var efl = 0u;
  var adj = array<u32, 3>(0u, 0u, 0u);
  for (var d = 0u; d < 6u; d++) {
    let nq = nbrOf(q, d);
    if (!onMap(nq)) { efl |= NF_MAPEDGE; continue; }
    let nc = winCol(nq);
    if (nc == NONE) { efl |= NF_WINEDGE; continue; }
    let b = N[colArr(0u, nc)];
    let bn = N[colArr(1u, nc)];
    var mask = 0u;
    for (var r = 0u; r < min(bn, 16u); r++) {
      if (b + r < P.ncap && joinedNodes(i, b + r)) { mask |= 1u << r; }
    }
    adj[d / 2u] |= mask << (16u * (d % 2u));
  }
  for (var w = 0u; w < 3u; w++) { N[(N_ADJ + w) * P.ncap + i] = adj[w]; }
  N[N_EFL * P.ncap + i] = efl;
  let fl = nu(N_FLAGS, i);
  let stands = (fl & NF_STANDS) != 0u;
  st(fi(F_DIST, i), select(INF_D, 0u, stands));
  N[N_DIST * P.ncap + i] = select(INF_D, 0u, stands);
  st(fi(F_PC, i), i);
  st(fi(F_LV, i), i);
  st(fi(F_FR, i), i);
  st(fi(F_NECK, i), NONE);
  st(fi(F_ZC, i), FINF);
  st(fi(F_TIPSRC, i), NONE);
  st(fi(F_MINK, i), INF_D);
  st(fi(F_OUT, i), NONE);
  // the hanging runs (holding something sideways: what joins at all)
  if (!stands && (fl & NF_SIDE) != 0u) {
    let h = atomicAdd(&W[cnt(C_HANG)], 1u);
    nst(F_HANG, h, i);
  }
}

/** the joined neighbours of node i: direction d's column's first node and its mask */
fn nbrBase(i: u32, d: u32) -> vec2<u32> {
  let mask = (nu(N_ADJ + d / 2u, i) >> (16u * (d % 2u))) & 0xffffu;
  if (mask == 0u) { return vec2<u32>(0u, 0u); }
  let nc = winCol(nbrOf(colXY(nu(N_COL, i)), d));
  return vec2<u32>(N[colArr(0u, nc)], mask);
}
fn standsN(j: u32) -> bool { return (nu(N_FLAGS, j) & NF_STANDS) != 0u; }
fn edgeHeld(i: u32) -> bool { return nu(N_EFL, i) != 0u; }

/** compare-and-swap that only fails when the word isn't `expect` (the weak one may fail spuriously) */
fn cas(i: u32, expect: u32, v: u32) -> bool {
  loop {
    let r = atomicCompareExchangeWeak(&W[i], expect, v);
    if (r.exchanged) { return true; }
    if (r.old_value != expect) { return false; }
  }
}

fn find(f: u32, x: u32) -> u32 { return findAt(f * P.ncap, x); }
fn unite(f: u32, a: u32, b: u32) { uniteAt(f * P.ncap, a, b); }
fn findAt(base: u32, x: u32) -> u32 {
  var r = x;
  loop {
    let p = ld(base + r);
    if (p == r) { break; }
    // (path halving)
    let gp = ld(base + p);
    _ = atomicCompareExchangeWeak(&W[base + r], p, gp);
    r = p;
  }
  return r;
}
/** union by hooking the larger root under the smaller: a component's root is its least id */
fn uniteAt(base: u32, a: u32, b: u32) {
  var x = a;
  var y = b;
  loop {
    x = findAt(base, x);
    y = findAt(base, y);
    if (x == y) { return; }
    if (x < y) { let t = x; x = y; y = t; }
    let r = atomicCompareExchangeWeak(&W[base + x], x, y);
    if (r.exchanged) { return; }
  }
}

var<workgroup> wgA: atomic<u32>;
var<workgroup> wgU: u32;
var<workgroup> wgL: array<u32, 4>;

/** a value every invocation agrees on (thread 0's read of a counter) */
fn uniformCount(i: u32) -> u32 {
  workgroupBarrier();
  storageBarrier();
  return workgroupUniformLoad(&wgL[i]);
}

fn hangN() -> u32 { return min(ld(cnt(C_HANG)), P.ncap); }
fn seedN() -> u32 { return min(ld(cnt(C_SEEDN)), P.ncap); }

/** the projected section's numbers for root r at its level (centroid, lever direction, CoM) */
struct Lever { u: vec2<f32>, L: f32, com: vec2<f32>, cen: vec2<f32>, meet: bool }
fn leverOf(r: u32) -> Lever {
  var o: Lever;
  let M = max(ldf(fi(F_AM, r)), 1e-6);
  o.com = vec2<f32>(ldf(fi(F_AX, r)), ldf(fi(F_AY, r))) / M;
  let A0 = max(ldf(fi(F_A0, r)), 1e-6);
  o.cen = vec2<f32>(ldf(fi(F_A0X, r)), ldf(fi(F_A0Y, r))) / A0;
  let v = o.com - o.cen;
  o.L = length(v);
  o.u = select(vec2<f32>(1.0, 0.0), v / max(o.L, 1e-6), o.L > 1e-4);
  let N = vec2<f32>(ldf(fi(F_NX, r)), ldf(fi(F_NY, r)));
  o.meet = length(N) < P.meet * A0;
  return o;
}

/** the hex cell's support (how far it reaches from its centre) in unit direction n: pointy-top, flats 1 apart */
fn hexReach(n: vec2<f32>) -> f32 {
  var m = 0.0;
  for (var k = 0u; k < 6u; k++) {
    let a = 1.5707963 + f32(k) * 1.0471976;
    m = max(m, dot(n, vec2<f32>(cos(a), sin(a)) * EDGE));
  }
  return m;
}

// ---- the workgroup's sums: a slot a root (WSLOTS of them; a root past them sums on storage), 16 fields a slot ----
const WSLOTS: u32 = 128u;
var<workgroup> wacc: array<atomic<u32>, 2048>;
fn waddf(i: u32, v: f32) {
  var old = atomicLoad(&wacc[i]);
  loop {
    let r = atomicCompareExchangeWeak(&wacc[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}
/** a thread's sums for root r (n of them, the fields from f0 on) into its slot's fields from g0 on, or onto storage */
fn put(r: u32, acc: ptr<function, array<f32, 9>>, n: u32, f0: u32, g0: u32) {
  if (r == NONE) { return; }
  let slot = nu(F_SLOT, r);
  for (var q = 0u; q < n; q++) {
    let v = (*acc)[q];
    if (v == 0.0) { continue; }
    if (slot < WSLOTS) { waddf((g0 + q) * WSLOTS + slot, v); } else { addf(fi(f0 + q, r), v); }
    (*acc)[q] = 0.0;
  }
}
/** every slot's sums (n fields from g0) onto its root's fields (from f0); a barrier after (the caller's before) */
fn wflush(list: u32, nNew: u32, n: u32, f0: u32, g0: u32) {
  for (var t = wgLid; t < min(nNew, WSLOTS); t += 256u) {
    let r = nu(list, t);
    for (var q = 0u; q < n; q++) {
      let v = bitcast<f32>(atomicLoad(&wacc[(g0 + q) * WSLOTS + t]));
      if (v != 0.0) { addf(fi(f0 + q, r), v); }
    }
  }
  workgroupBarrier();
  storageBarrier();
}
var<private> wgLid: u32;

