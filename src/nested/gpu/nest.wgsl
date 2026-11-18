// ---- nested/gpu/nest.wgsl: the lab's compute passes (docs/design/NESTED_SCALES.md "Storage") -------------------------
// store.wgsl is prepended. The maths is the oracle's (src/nested/oracle.ts); every pass works on whole 16 x 16 chunks
// of one level, a workgroup a chunk. Regions come from `reg` slots (written by the CPU for promote and slide, by the
// plan pass for an edit), so an edit runs from the pointer to the last level with no readback.

struct U {
  a: vec4<u32>, // k, seed, mode or op, level L
  r: vec4<u32>, // reg slot, pool pages, flags (1: the hit is forced, not picked), live levels
  c: vec4<f32>, // brush: x, y (window columns of the forced level), radius, amount (world units)
  d: vec4<f32>, // now, melt rate, forced level, detail amplitude
  e: vec4<i32>, // the stripe column (self-test): X, Y, interval count, 0
  lv: array<vec4<i32>, 8>, // per depth: window gx0, gy0, n (columns), live
  cA: vec4<f32>, // camera: the wished move x, y, z (world), 1 = place the eye (cam words 256-258)
  cB: vec4<f32>, // yaw, pitch, aspect, speed limit (nearest-solid distances a second)
  cC: vec4<f32>, // fovy, pointer ndc x, y, dt
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> tab: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> ctl: array<atomic<u32>>;
// (binding 3, retired: the pages are segments from binding 10 on, declared with pgLoad / pgStore by nest.ts)
@group(0) @binding(4) var<storage, read_write> scr: array<f32>;
@group(0) @binding(5) var<storage, read_write> reg: array<i32>;
@group(0) @binding(6) var<storage, read_write> cam: array<f32>;
// (the plan's only: the indirect dispatch arguments, 4 words a slot; other passes dispatch from it)
@group(0) @binding(7) var<storage, read_write> args: array<u32>;

fn tabLoad(i: u32) -> u32 { return atomicLoad(&tab[i]); }

// ---- ctl: 0 end, 1 refused, 2 free count, 3 pending count, 4 mismatches, 5 table full, 6 -, 7 max cz; free stack at
//      16, pending at 16 + cap
const CTL_STACK: u32 = 16u;

fn allocPage() -> u32 {
  var c = atomicLoad(&ctl[2]);
  loop {
    if (c == 0u) { break; }
    let r = atomicCompareExchangeWeak(&ctl[2], c, c - 1u);
    if (r.exchanged) { return atomicLoad(&ctl[CTL_STACK + c - 1u]); }
    c = r.old_value;
  }
  let p = atomicAdd(&ctl[0], 1u);
  if (p >= u.r.y) {
    atomicAdd(&ctl[1], 1u);
    return NONE;
  }
  return p;
}
fn freePage(p: u32) {
  let i = atomicAdd(&ctl[3], 1u);
  atomicStore(&ctl[CTL_STACK + u.r.y + i], p);
}
fn tInsert(k0: u32, k1: u32, page: u32, birth: f32) -> bool {
  var s = tHash(k0, k1);
  var p = 0u;
  loop {
    if (p >= TCAP) { break; }
    let e1 = atomicLoad(&tab[s * 4u + 1u]);
    if (e1 == EMPTY || e1 == TOMB) {
      let r = atomicCompareExchangeWeak(&tab[s * 4u + 1u], e1, BUSY);
      if (r.exchanged) {
        atomicStore(&tab[s * 4u], k0);
        atomicStore(&tab[s * 4u + 2u], page);
        atomicStore(&tab[s * 4u + 3u], bitcast<u32>(birth));
        atomicStore(&tab[s * 4u + 1u], k1);
        return true;
      }
      continue;
    }
    s = (s + 1u) & (TCAP - 1u);
    p++;
  }
  atomicAdd(&ctl[5], 1u);
  return false;
}
/** (one thread) the level's pages over chunk (cx, cy) for cz < need exist; those above are let go */
fn ensurePages(lid: u32, cx: i32, cy: i32, need: u32, birth: f32) {
  for (var cz = 0u; cz < need; cz++) {
    if (tFind(tKey0(cx, cy), tKey1(lid, cz)) == NONE) {
      let p = allocPage();
      if (p != NONE) {
        // a fresh page's counts are zero: columns a pass leaves alone read as empty (a residual: zero)
        for (var c = 0u; c < 256u; c++) { pgStore(p * PW + c, 0u); }
        if (tInsert(tKey0(cx, cy), tKey1(lid, cz), p, birth)) {
          atomicMax(&ctl[7], cz);
        } else {
          freePage(p);
        }
      }
    }
  }
  var cz = need;
  loop {
    let s = tFind(tKey0(cx, cy), tKey1(lid, cz));
    if (s == NONE) { break; }
    let p = atomicLoad(&tab[s * 4u + 2u]);
    if (p < NOT_LOADED) { freePage(p); }
    atomicStore(&tab[s * 4u + 1u], TOMB);
    cz++;
  }
}
/** e: the footprints word (store.wgsl packE; a residual record: the footprint's residual as f32 bits) */
fn pgSetIvl(page: u32, c: u32, i: u32, z0: f32, z1: f32, m: u32, e: u32) {
  let b = page * PW + 256u + (c * K + i) * RW;
  pgStore(b, bitcast<u32>(z0));
  pgStore(b + 1u, bitcast<u32>(z1));
  pgStore(b + 2u, m);
  pgStore(b + 3u, e);
}
fn setIvl(lid: u32, X: i32, Y: i32, i: u32, z0: f32, z1: f32, m: u32, e: u32) {
  let p = pageOf(lid, X >> 4, Y >> 4, i / K);
  if (p >= NOT_LOADED) { return; }
  pgSetIvl(p, colIn(X, Y), i % K, z0, z1, m, e);
}
/** a column's count written into each of its chunk's pages (cz < need) */
fn setCount(lid: u32, X: i32, Y: i32, n: u32, need: u32) {
  for (var cz = 0u; cz < need; cz++) {
    let p = pageOf(lid, X >> 4, Y >> 4, cz);
    if (p >= NOT_LOADED) { continue; }
    pgStore(p * PW + colIn(X, Y), u32(clamp(i32(n) - i32(cz * K), 0, i32(K))));
  }
}

// ---- regions: reg words 0-7 the levels' z origins (f32, parent units), 8-15 the hit, slots of 12 from 16 ------------
fn slotW(slot: u32, w: u32) -> i32 { return reg[16u + slot * 12u + w]; }
fn setSlot(slot: u32, r: vec4<i32>, ox: i32, oy: i32, nx: i32, ny: i32) {
  let b = 16u + slot * 12u;
  reg[b] = r.x;
  reg[b + 1u] = r.y;
  reg[b + 2u] = r.z;
  reg[b + 3u] = r.w;
  reg[b + 4u] = ox;
  reg[b + 5u] = oy;
  args[slot * 4u] = u32(max(nx, 0));
  args[slot * 4u + 1u] = u32(max(ny, 0));
  args[slot * 4u + 2u] = 1u;
}
fn zOrigin(lid: u32) -> f32 { return bitcast<f32>(reg[lid]); }

fn clampTo(lid: u32, x: i32, y: i32) -> vec2<i32> {
  let w = u.lv[lid];
  return vec2<i32>(clamp(x, w.x, w.x + w.z - 1), clamp(y, w.y, w.y + w.z - 1));
}
fn inWin(lid: u32, x: i32, y: i32) -> bool {
  let w = u.lv[lid];
  return x >= w.x && y >= w.y && x < w.x + w.z && y < w.y + w.z;
}
fn crW(t: f32) -> vec4<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4<f32>((-t3 + 2.0 * t2 - t) / 2.0, (3.0 * t3 - 5.0 * t2 + 2.0) / 2.0, (-3.0 * t3 + 4.0 * t2 + t) / 2.0, (t3 - t2) / 2.0);
}
/** PPM (Colella-Woodward): the edge value between cells c0 and c1, limited to lie between them */
fn ppmEdge(m1: f32, c0: f32, c1: f32, p2: f32) -> f32 {
  let e = (7.0 / 12.0) * (c0 + c1) - (1.0 / 12.0) * (m1 + p2);
  return clamp(e, min(c0, c1), max(c0, c1));
}
/** the average over sub-cell a (of k) of the middle cell's limited parabola, from five cell averages q (q[2] the cell).
 *  Mean-preserving: the k sub-averages sum to k q[2]. A monotone cell keeps its parabola inside its edges; at an
 *  extremum the curvature is kept only where the neighbours curve the same way (Colella-Sekora), so a smooth hilltop is
 *  not flattened and a step makes no spike. The oracle's ppmSub is the same maths. */
fn ppmSub(q: array<f32, 5>, a: f32, k: f32) -> f32 {
  let c = q[2];
  var aL = ppmEdge(q[0], q[1], q[2], q[3]);
  var aR = ppmEdge(q[1], q[2], q[3], q[4]);
  if ((aR - c) * (c - aL) <= 0.0) {
    let d2 = 6.0 * (aL - 2.0 * c + aR);
    let d2c = q[1] - 2.0 * c + q[3];
    let d2l = q[0] - 2.0 * q[1] + c;
    let d2r = c - 2.0 * q[3] + q[4];
    var lim = 0.0;
    let s = sign(d2);
    if (s != 0.0 && sign(d2c) == s && sign(d2l) == s && sign(d2r) == s) {
      lim = s * min(min(abs(d2), 1.25 * abs(d2c)), min(1.25 * abs(d2l), 1.25 * abs(d2r)));
    }
    if (d2 != 0.0) {
      aL = c + (aL - c) * lim / d2;
      aR = c + (aR - c) * lim / d2;
    } else {
      aL = c;
      aR = c;
    }
  } else {
    let da = aR - aL;
    let m = c - 0.5 * (aL + aR);
    if (da * m > da * da / 6.0) { aL = 3.0 * c - 2.0 * aR; } else if (-da * da / 6.0 > da * m) { aR = 3.0 * c - 2.0 * aL; }
  }
  let da = aR - aL;
  let a6 = 6.0 * (c - 0.5 * (aL + aR));
  let x0 = a / k;
  let x1 = (a + 1.0) / k;
  let F0 = aL * x0 + da * x0 * x0 * 0.5 + a6 * (x0 * x0 * 0.5 - x0 * x0 * x0 / 3.0);
  let F1 = aL * x1 + da * x1 * x1 * 0.5 + a6 * (x1 * x1 * 0.5 - x1 * x1 * x1 / 3.0);
  return (F1 - F0) * k;
}
fn bumpW(a: i32, k: i32) -> f32 {
  let s = sin(3.14159265358979 * (f32(a) + 0.5) / f32(k));
  return s * s;
}

// ---- derive (mode 0: live = enhance(parent) + residual) and residual (mode 1: residual = live - enhance(parent)) ------
var<workgroup> shv: array<f32, 256>;
var<workgroup> wmax: atomic<u32>;
var<workgroup> wany: atomic<u32>;
var<workgroup> wlive: atomic<u32>;
var<workgroup> wKeep: u32;

var<workgroup> wOrigin: vec2<i32>;
/** a slot's dispatch origin, uniform across the workgroup (it is read from a storage buffer) */
fn slotOrigin(slot: u32, li: u32) -> vec2<i32> {
  if (li == 0u) { wOrigin = vec2<i32>(slotW(slot, 4u), slotW(slot, 5u)); }
  return workgroupUniformLoad(&wOrigin);
}

var<private> gX: i32;
var<private> gY: i32;
var<private> gA: i32;
var<private> gB: i32;
var<private> gP: vec2<i32>;
var<private> gN: u32;
var<private> gOff: vec2<i32>;
var<private> gT: vec2<f32>;
var<private> gCompat: u32;
var<private> gS: f32;
/** the column is in the slot's rect (an edit's exact change; promote and slide: everything) */
var<private> gAct: bool;
/** its residual is a whole column (mode 0) / its live column differs in structure from the enhanced one (mode 1) */
var<private> gWhole: bool;
/** its per-bound residual applies (it exists and matches the enhanced structure) */
var<private> gResOk: bool;

fn blockSum(lx: u32, ly: u32, k: u32) -> f32 {
  let bx = (lx / k) * k;
  let by = (ly / k) * k;
  var s = 0.0;
  for (var j = 0u; j < k; j++) {
    for (var i = 0u; i < k; i++) { s += shv[(by + j) * 16u + bx + i]; }
  }
  return s;
}
fn sameMats(lid: u32, a: vec2<i32>, b: vec2<i32>, n: u32) -> bool {
  if (colCount(lid, a.x, a.y) != n) { return false; }
  for (var i = 0u; i < n; i++) {
    if (ivlAt(lid, a.x, a.y, i).m != ivlAt(lid, b.x, b.y, i).m) { return false; }
  }
  return true;
}
fn resAt(L: u32, rec: u32, w: u32) -> f32 {
  let p = pageOf(RES_ID + L, gX >> 4, gY >> 4, rec / K);
  if (p >= NOT_LOADED) { return 0.0; }
  if (pgLoad(p * PW + colIn(gX, gY)) <= rec % K) { return 0.0; }
  let b = p * PW + 256u + (colIn(gX, gY) * K + rec % K) * RW;
  return bitcast<f32>(pgLoad(b + w));
}
fn setRes(L: u32, rec: u32, v0: f32, v1: f32, er: f32) {
  let p = pageOf(RES_ID + L, gX >> 4, gY >> 4, rec / K);
  if (p >= NOT_LOADED) { return; }
  pgSetIvl(p, colIn(gX, gY), rec % K, v0, v1, 0u, bitcast<u32>(er));
}
/** footprints, enhanced: interval i's (eS, eG) from the parent's, bilinear over the 2 x 2 compatible samples (the
 *  layer pass's stencil), times k, kept within +-E_FAR, as stored (f16; the oracle's eScale) */
fn eEnh(i: u32) -> vec2<f32> {
  let L = u.a.w;
  let P = L - 1u;
  let own = unpack2x16float(ivlAt(P, gP.x, gP.y, i).e);
  var v = vec2<f32>(0.0);
  for (var jj = 0; jj < 2; jj++) {
    for (var ii = 0; ii < 2; ii++) {
      let q = clampTo(P, gP.x + gOff.x + ii, gP.y + gOff.y + jj);
      var s = own;
      if (((gCompat >> u32(jj * 2 + ii)) & 1u) != 0u) { s = unpack2x16float(ivlAt(P, q.x, q.y, i).e); }
      v += select(1.0 - gT.x, gT.x, ii == 1) * select(1.0 - gT.y, gT.y, jj == 1) * s;
    }
  }
  return unpack2x16float(packE(clamp(v.x * f32(u.a.x), -E_FAR, E_FAR), clamp(v.y * f32(u.a.x), -E_FAR, E_FAR)));
}
/** interval i's footprints in a derived column: enhanced plus the residual (exact: both are f16 values) */
fn eDerived(L: u32, i: u32) -> u32 {
  let e = eEnh(i);
  if (!gResOk) { return packE(e.x, e.y); }
  return packE(e.x + resAt(L, 2u * i, 3u), e.y + resAt(L, 2u * i + 1u, 3u));
}

/** the layer pass: every gap and thickness of the block, enhanced; mode 0 writes the live column (top down), mode 1
 *  the residual (or, write false, only marks whether any is non-zero) */
fn layers(lx: u32, ly: u32, li: u32, maxN: u32, mode: u32, write: bool) {
  let L = u.a.w;
  let P = L - 1u;
  let k = i32(u.a.x);
  let kf = f32(k);
  // z: the enhanced column's running bound, top down; dPrev: the derived z0 of the interval above (mode 0)
  var z = gS;
  var dPrev = 3.0e38;
  for (var uu = 0u; uu + 1u < maxN; uu++) {
    let valid = uu + 1u < gN;
    let i = select(1u, gN - 1u - uu, valid);
    var vals = vec2<f32>(0.0, 0.0); // th, gap
    for (var which = 0u; which < 2u; which++) {
      let v = select(2u * i - 1u, 2u * i, which == 0u);
      var val = 0.0;
      if (valid) {
        let own = layerVal(P, gP.x, gP.y, v);
        for (var jj = 0; jj < 2; jj++) {
          for (var ii = 0; ii < 2; ii++) {
            let q = clampTo(P, gP.x + gOff.x + ii, gP.y + gOff.y + jj);
            let bit = u32(jj * 2 + ii);
            var sv = own;
            if (((gCompat >> bit) & 1u) != 0u) { sv = layerVal(P, q.x, q.y, v); }
            let w = select(1.0 - gT.x, gT.x, ii == 1) * select(1.0 - gT.y, gT.y, jj == 1);
            val += w * sv * kf;
          }
        }
      }
      shv[li] = val;
      workgroupBarrier();
      let B = blockSum(lx, ly, u32(k));
      workgroupBarrier();
      if (valid) {
        let own = layerVal(P, gP.x, gP.y, v);
        let T = kf * kf * kf * own;
        var e = T / (kf * kf);
        if (B > 0.0) { e = val * T / B; }
        vals[which] = e;
      }
    }
    if (valid) {
      let e1 = z;
      let e0 = z - vals[0];
      if (gAct && !gWhole && mode == 0u) {
        // the residual is per bound; the order of the bounds is kept (a no-op when nothing changed under them)
        let d1 = min(addRes(e1, L, i, 1u), dPrev);
        let d0 = min(addRes(e0, L, i, 0u), d1);
        if (write) { setIvl(L, gX, gY, i, d0, d1, ivlAt(P, gP.x, gP.y, i).m, eDerived(L, i)); }
        dPrev = d0;
      }
      if (gAct && !gWhole && mode == 1u) {
        let lv = ivlAt(L, gX, gY, i);
        let er = unpack2x16float(lv.e) - eEnh(i);
        putRes(lv.z0, e0, L, i, 0u, write, er.x);
        putRes(lv.z1, e1, L, i, 1u, write, er.y);
      }
      z = e0 - vals[1];
    }
  }
  if (gAct && !gWhole && gN > 0u) {
    if (mode == 0u && write) { setIvl(L, gX, gY, 0u, OPEN_BOTTOM, min(addRes(z, L, 0u, 1u), dPrev), ivlAt(P, gP.x, gP.y, 0u).m, eDerived(L, 0u)); }
    if (mode == 1u) {
      let er = unpack2x16float(ivlAt(L, gX, gY, 0u).e) - eEnh(0u);
      if (er.x != 0.0) { atomicOr(&wany, 1u); }
      if (write) { setRes(L, 0u, 0.0, 0.0, er.x); }
      putRes(ivlAt(L, gX, gY, 0u).z1, z, L, 0u, 1u, write, er.y);
    }
  }
}
// The residual of a bound is two floats, record 2i + (0: z0, 1: z1) of the residual column: hi = live - e and
// lo = live - (e + hi). Then (e + hi) + lo == live exactly (lo is exact: e + hi lies within an ulp of live), so deriving
// reproduces a live column bit for bit; one float cannot when live's ulp is finer than e's.
fn addRes(e: f32, L: u32, i: u32, which: u32) -> f32 {
  if (!gResOk) { return e; }
  let rec = 2u * i + which;
  return (e + resAt(L, rec, 0u)) + resAt(L, rec, 1u);
}
/** er: the footprint's residual (record 2i: eS's, 2i + 1: eG's), kept in the record's fourth word */
fn putRes(live: f32, e: f32, L: u32, i: u32, which: u32, write: bool, er: f32) { putResW(live, e, L, i, which, write, 0u, er); }
/** word2: 0 for a per-bound record; WHOLE | material for a whole column's (er then the footprint itself) */
fn putResW(live: f32, e: f32, L: u32, i: u32, which: u32, write: bool, word2: u32, er: f32) {
  let hi = live - e;
  let lo = live - (e + hi);
  if (hi != 0.0 || lo != 0.0 || word2 != 0u || er != 0.0) { atomicOr(&wany, 1u); }
  if (!write) { return; }
  if ((e + hi) + lo != live) { atomicAdd(&ctl[6], 1u); }
  let p = pageOf(RES_ID + L, gX >> 4, gY >> 4, (2u * i + which) / K);
  if (p >= NOT_LOADED) { return; }
  pgSetIvl(p, colIn(gX, gY), (2u * i + which) % K, hi, lo, word2, bitcast<u32>(er));
}
const WHOLE: u32 = 0x80000000u;
fn resWord(L: u32, rec: u32, w: u32) -> u32 {
  let p = pageOf(RES_ID + L, gX >> 4, gY >> 4, rec / K);
  if (p >= NOT_LOADED) { return 0u; }
  return pgLoad(p * PW + 256u + (colIn(gX, gY) * K + rec % K) * RW + w);
}
/** a live column of another structure than its enhanced parent: kept whole, bounds relative to the enhanced surface gS,
 *  footprints as they are */
fn putWhole(L: u32, n: u32, write: bool) {
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(L, gX, gY, i);
    let e = unpack2x16float(iv.e);
    if (i > 0u) { putResW(iv.z0, gS, L, i, 0u, write, WHOLE | iv.m, e.x); } else { putResW(0.0, 0.0, L, 0u, 0u, write, WHOLE | iv.m, e.x); }
    putResW(iv.z1, gS, L, i, 1u, write, WHOLE | iv.m, e.y);
  }
}
/** a whole column written from its residual */
fn writeWhole(L: u32, n: u32, need: u32) {
  setCount(L, gX, gY, n, need);
  for (var i = 0u; i < n; i++) {
    let z1 = (gS + bitcast<f32>(resWord(L, 2u * i + 1u, 0u))) + bitcast<f32>(resWord(L, 2u * i + 1u, 1u));
    var z0 = OPEN_BOTTOM;
    if (i > 0u) { z0 = (gS + bitcast<f32>(resWord(L, 2u * i, 0u))) + bitcast<f32>(resWord(L, 2u * i, 1u)); }
    setIvl(L, gX, gY, i, z0, z1, resWord(L, 2u * i + 1u, 2u) & 0xffffu, packE(bitcast<f32>(resWord(L, 2u * i, 3u)), bitcast<f32>(resWord(L, 2u * i + 1u, 3u))));
  }
}
fn sameAcross(la: u32, a: vec2<i32>, lb: u32, b: vec2<i32>, n: u32) -> bool {
  if (colCount(la, a.x, a.y) != n) { return false; }
  for (var i = 0u; i < n; i++) {
    if (ivlAt(la, a.x, a.y, i).m != ivlAt(lb, b.x, b.y, i).m) { return false; }
  }
  return true;
}

@compute @workgroup_size(16, 16)
fn derive(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let P = L - 1u;
  let mode = u.a.z;
  let k = i32(u.a.x);
  let kf = f32(k);
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; } // (uniform: the whole chunk)
  gX = cx * 16 + i32(lid.x);
  gY = cy * 16 + i32(lid.y);
  let px = gX / k;
  let py = gY / k;
  gA = gX - px * k;
  gB = gY - py * k;
  gP = clampTo(P, px, py);
  gN = colCount(P, gP.x, gP.y);
  // (the bilinear position the layer pass uses)
  let ux = (f32(gA) + 0.5) / kf - 0.5;
  let uy = (f32(gB) + 0.5) / kf - 0.5;
  gOff = vec2<i32>(select(0, -1, ux < 0.0), select(0, -1, uy < 0.0));
  gT = vec2<f32>(ux - f32(gOff.x), uy - f32(gOff.y));
  // the top surface: parent values are cell averages; a limited PPM along x for the five rows round the block, then
  // along y (the oracle's ppmSub): mean-preserving per block, no new extremum at a step (NS-34)
  let pref = topS(P, gP.x, gP.y, gN);
  var rows = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
  for (var j = 0; j < 5; j++) {
    var q = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
    for (var i = 0; i < 5; i++) {
      let c = clampTo(P, px - 2 + i, py - 2 + j);
      q[i] = topS(P, c.x, c.y, colCount(P, c.x, c.y)) - pref;
    }
    rows[j] = ppmSub(q, f32(gA), kf);
  }
  let fsum = ppmSub(rows, f32(gB), kf);
  let z0 = zOrigin(L);
  var s = (pref - z0) * kf + fsum * kf + detail(gX, gY, i32(L), k, u.a.y, u.d.w);
  shv[li] = s;
  workgroupBarrier();
  let sum = blockSum(lid.x, lid.y, u32(k));
  workgroupBarrier();
  let D = kf * kf * kf * (pref - z0) - sum;
  gS = s + D * bumpW(gA, k) * bumpW(gB, k) / (kf * kf / 4.0);
  // which 2 x 2 samples share the block's intervals
  gCompat = 0u;
  for (var jj = 0; jj < 2; jj++) {
    for (var ii = 0; ii < 2; ii++) {
      let q = clampTo(P, px + gOff.x + ii, py + gOff.y + jj);
      if (sameMats(P, q, gP, gN)) { gCompat |= 1u << u32(jj * 2 + ii); }
    }
  }
  let blk = vec4<i32>(slotW(u.r.x, 0u), slotW(u.r.x, 1u), slotW(u.r.x, 2u), slotW(u.r.x, 3u));
  gAct = inBox(gX, gY, blk);
  if (li == 0u) {
    atomicStore(&wmax, 0u);
    atomicStore(&wany, 0u);
    atomicStore(&wlive, 0u);
  }
  workgroupBarrier();
  // the residual's kind: mode 0 reads it (a whole column, a per-bound one that fits, or none); mode 1 decides it
  let liveN = colCount(L, gX, gY);
  var finalN = gN;
  if (mode == 0u) {
    let rc = colCount(RES_ID + L, gX, gY);
    gWhole = rc > 0u && (resWord(L, 0u, 2u) & WHOLE) != 0u;
    gResOk = !gWhole && rc == 2u * gN;
    if (gWhole) { finalN = rc / 2u; }
  } else {
    gWhole = !sameAcross(L, vec2<i32>(gX, gY), P, gP, gN);
    gResOk = false;
    finalN = max(liveN, gN);
  }
  // pages: as many as the chunk's longest column needs, the columns left alone included
  atomicMax(&wmax, select(liveN, finalN, gAct));
  if (!gAct) { atomicAdd(&wlive, 1u); }
  if (mode == 1u && gAct && gWhole) { atomicOr(&wany, 1u); }
  let maxN = workgroupUniformLoad(&wmax);
  let need = (maxN + K - 1u) / K;
  // a residual column holds two records an interval
  let needR = (2u * maxN + K - 1u) / K;
  if (mode == 0u) {
    if (li == 0u) { ensurePages(L, cx, cy, need, u.d.x); }
    storageBarrier();
    workgroupBarrier();
    if (gAct && !gWhole) { setCount(L, gX, gY, gN, need); }
    layers(lid.x, lid.y, li, maxN, 0u, true);
    if (gAct && gWhole) { writeWhole(L, finalN, need); }
  } else {
    layers(lid.x, lid.y, li, maxN, 1u, false);
    let any = workgroupUniformLoad(&wany);
    let others = workgroupUniformLoad(&wlive);
    // no page where nothing differs; a chunk with columns left alone keeps the pages it has (and its columns in the
    // rect are written, zero or not)
    if (li == 0u) {
      let keep = others != 0u && pageOf(RES_ID + L, cx, cy, 0u) < NOT_LOADED;
      wKeep = select(0u, 1u, keep);
      ensurePages(RES_ID + L, cx, cy, select(0u, needR, any != 0u || keep), u.d.x);
    }
    storageBarrier();
    let keepU = workgroupUniformLoad(&wKeep);
    if (any != 0u || keepU != 0u) {
      if (gAct) { setCount(RES_ID + L, gX, gY, 2u * select(gN, liveN, gWhole), needR); }
      layers(lid.x, lid.y, li, maxN, 1u, true);
      if (gAct && gWhole) { putWhole(L, liveN, true); }
    }
  }
}

/** restrict's footprints for interval i: the mean over the block's children of tn intervals of their distances clamped
 *  to +-E_SAT k (a block's far values must not swamp a contour in it), in parent columns (the oracle's restrictCell) */
const E_SAT: f32 = 2.0;
fn eRestrict(X: i32, Y: i32, i: u32, tn: u32) -> u32 {
  let L = u.a.w;
  let k = i32(u.a.x);
  let kf = f32(k);
  let sat = E_SAT * kf;
  var s = vec2<f32>(0.0);
  var c = 0.0;
  for (var b = 0; b < k; b++) {
    for (var a = 0; a < k; a++) {
      if (colCount(L, X * k + a, Y * k + b) != tn) { continue; }
      s += clamp(unpack2x16float(ivlAt(L, X * k + a, Y * k + b, i).e), vec2<f32>(-sat), vec2<f32>(sat));
      c += 1.0;
    }
  }
  // (a block saturated everywhere stays "far": restrict gives back E_FAR from an unedited block)
  // (compared on the sums: a GPU's division need not be exact, 624 / 39 can come out under 16)
  let m = s / c;
  let e = select(select(m / kf, vec2<f32>(-E_FAR), s <= vec2<f32>(-sat * c)), vec2<f32>(E_FAR), s >= vec2<f32>(sat * c));
  return packE(e.x, e.y);
}

// ---- restrict: a parent column from its k x k children (dispatch over the parent's chunks; u.a.w = the child) --------
@compute @workgroup_size(16, 16)
fn restrictK(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let P = L - 1u;
  let k = i32(u.a.x);
  let kf = f32(k);
  let slot = u.r.x;
  let o = slotOrigin(slot, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(P, cx * 16, cy * 16)) { return; }
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  var act = X >= slotW(slot, 0u) && Y >= slotW(slot, 1u) && X < slotW(slot, 2u) && Y < slotW(slot, 3u) && inWin(L, X * k, Y * k) && inWin(L, X * k + k - 1, Y * k + k - 1);
  var n = colCount(P, X, Y);
  // the template: the child with the most intervals (the first on a tie); same: every child shares its structure
  var tpl = vec2<i32>(X * k, Y * k);
  var same = true;
  if (act) {
    var tn = 0u;
    for (var b = 0; b < k; b++) {
      for (var a = 0; a < k; a++) {
        let c = colCount(L, X * k + a, Y * k + b);
        if (c > tn) {
          tn = c;
          tpl = vec2<i32>(X * k + a, Y * k + b);
        }
      }
    }
    for (var b = 0; b < k; b++) {
      for (var a = 0; a < k; a++) {
        if (!sameMats(L, vec2<i32>(X * k + a, Y * k + b), tpl, tn)) { same = false; }
      }
    }
    n = tn;
  }
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  atomicMax(&wmax, n);
  let maxN = workgroupUniformLoad(&wmax);
  let need = (maxN + K - 1u) / K;
  if (li == 0u) { ensurePages(P, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!act) { return; }
  setCount(P, X, Y, n, need);
  let inv = 1.0 / (kf * kf) / kf;
  var ss = 0.0;
  for (var b = 0; b < k; b++) {
    for (var a = 0; a < k; a++) {
      let c = vec2<i32>(X * k + a, Y * k + b);
      ss += topS(L, c.x, c.y, colCount(L, c.x, c.y));
    }
  }
  var z = zOrigin(L) + ss * inv;
  if (same) {
    for (var i = max(n, 1u) - 1u; i >= 1u; i--) {
      var th = 0.0;
      var gap = 0.0;
      for (var b = 0; b < k; b++) {
        for (var a = 0; a < k; a++) {
          th += layerVal(L, X * k + a, Y * k + b, 2u * i);
          gap += layerVal(L, X * k + a, Y * k + b, 2u * i - 1u);
        }
      }
      setIvl(P, X, Y, i, z - th * inv, z, ivlAt(L, tpl.x, tpl.y, i).m, eRestrict(X, Y, i, n));
      z = z - th * inv - gap * inv;
    }
  } else {
    // children of different structures: the template, its thicknesses scaled per material and its gaps scaled, so
    // the parent holds the block's mean of each material and of enclosed air (the oracle's restrictCell). A ghost
    // interval's thickness is air; a ghost gap's is solid of the interval above it.
    var vm = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var tm = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var air = 0.0;
    var tair = 0.0;
    for (var b = 0; b < k; b++) {
      for (var a = 0; a < k; a++) {
        let c = vec2<i32>(X * k + a, Y * k + b);
        let cn = colCount(L, c.x, c.y);
        for (var i = 1u; i < cn; i++) {
          let iv = ivlAt(L, c.x, c.y, i);
          let th = iv.z1 - iv.z0;
          let gp = iv.z0 - ivlAt(L, c.x, c.y, i - 1u).z1;
          if (present(eS(iv))) { vm[iv.m & 7u] += th; } else { air += th; }
          if (present(eG(iv))) { air += gp; } else { vm[iv.m & 7u] += gp; }
        }
      }
    }
    for (var i = 1u; i < n; i++) {
      let iv = ivlAt(L, tpl.x, tpl.y, i);
      let th = iv.z1 - iv.z0;
      let gp = iv.z0 - ivlAt(L, tpl.x, tpl.y, i - 1u).z1;
      if (present(eS(iv))) { tm[iv.m & 7u] += th; } else { tair += th; }
      if (present(eG(iv))) { tair += gp; } else { tm[iv.m & 7u] += gp; }
    }
    let kk = kf * kf;
    for (var i = max(n, 1u) - 1u; i >= 1u; i--) {
      let iv = ivlAt(L, tpl.x, tpl.y, i);
      let mi = iv.m & 7u;
      // each part scaled by its kind's ratio (solid: its material's; air: the enclosed air's)
      let sS = present(eS(iv));
      let tS = select(tair, tm[mi], sS);
      let mS = select(air, vm[mi], sS);
      var th = 0.0;
      if (tS > 0.0) { th = (iv.z1 - iv.z0) * (mS / kk / tS) / kf; }
      let sG = !present(eG(iv));
      let tG = select(tair, tm[mi], sG);
      let mG = select(air, vm[mi], sG);
      var gap = 0.0;
      if (tG > 0.0) { gap = (iv.z0 - ivlAt(L, tpl.x, tpl.y, i - 1u).z1) * (mG / kk / tG) / kf; }
      setIvl(P, X, Y, i, z - th, z, iv.m, eRestrict(X, Y, i, n));
      z = z - th - gap;
    }
  }
  setIvl(P, X, Y, 0u, OPEN_BOTTOM, z, ivlAt(L, tpl.x, tpl.y, 0u).m, eRestrict(X, Y, 0u, n));
}

// ---- the root: hills and a winding valley (the oracle's rootHeight / makeRoot) -----------------------------------------
fn fbm(x: f32, y: f32, octaves: i32, seed: u32) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var f = 1.0;
  for (var o = 0; o < octaves; o++) {
    v += amp * valueNoise(x * f, y * f, 100 + o, seed);
    f *= 2.0;
    amp *= 0.5;
  }
  return v;
}
fn rootHeight(x: i32, y: i32, n: f32, seed: u32) -> f32 {
  let uu = (f32(x) + 0.5) / n;
  let vv = (f32(y) + 0.5) / n;
  let hills = 0.5 + 0.5 * fbm(uu * 4.0, vv * 4.0, 5, seed);
  let yv = 0.5 + 0.13 * sin(uu * 7.0 + f32(seed) * 0.37) + 0.05 * sin(uu * 17.0);
  let dv = abs(vv - yv);
  let valley = 0.15 + 0.85 * smooth3(min(1.0, dv / 0.2));
  return (n / 256.0) * (4.0 + 40.0 * hills * valley);
}
const MAT_STONE: u32 = 1u;
const MAT_SOIL: u32 = 2u;
const MAT_SAND: u32 = 3u;
const MAT_CLAY: u32 = 4u;

@compute @workgroup_size(16, 16)
fn rootGen(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let cx = i32(wid.x);
  let cy = i32(wid.y);
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  let nn = f32(u.lv[0].z);
  let s = rootHeight(X, Y, nn, u.a.y);
  let soil = 0.25 + 0.15 * valueNoise(f32(X) / 6.0, f32(Y) / 6.0, 7, u.a.y);
  let stripe = X == u.e.x && Y == u.e.y && u.e.z > 2;
  var n = 2u;
  if (stripe) { n = u32(u.e.z); }
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  atomicMax(&wmax, n);
  let maxN = workgroupUniformLoad(&wmax);
  let need = (maxN + K - 1u) / K;
  if (li == 0u) { ensurePages(0u, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  setCount(0u, X, Y, n, need);
  if (stripe) {
    for (var i = 0u; i < n; i++) {
      let lo = s - 4.0 + f32(i) * 0.1;
      setIvl(0u, X, Y, i, select(lo, OPEN_BOTTOM, i == 0u), s - 4.0 + f32(i + 1u) * 0.1, select(MAT_SAND, MAT_CLAY, (i & 1u) == 1u), E_FAR_W);
    }
  } else {
    setIvl(0u, X, Y, 0u, OPEN_BOTTOM, s - soil, MAT_STONE, E_FAR_W);
    setIvl(0u, X, Y, 1u, s - soil, s, MAT_SOIL, E_FAR_W);
  }
}

// ---- z origin of a promoted level: the parent's surface under the window's centre, whole parent units ----------------
@compute @workgroup_size(1)
fn zPick() {
  let L = u.a.w;
  let P = L - 1u;
  let k = i32(u.a.x);
  let w = u.lv[L];
  let q = clampTo(P, (w.x + w.z / 2) / k, (w.y + w.z / 2) / k);
  reg[L] = bitcast<i32>(round(topS(P, q.x, q.y, colCount(P, q.x, q.y))));
}

// ---- release: a level's pages let go (all, or those outside a chunk rect: a slide) ------------------------------------
@compute @workgroup_size(64)
fn release(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 >= BUSY) { return; }
  // the level's columns and its baked draw (gap table, mesh items)
  let lid = k1 & 0xffu;
  // (mode 7: a stroke's snapshot only, at its end)
  if (u.a.z == 7u) {
    if (lid != SNAP_ID + u.a.w) { return; }
  } else if (lid != u.a.w && lid != GAP_ID + u.a.w && lid != MESH_ID + u.a.w && lid != SNAP_ID + u.a.w) { return; }
  let k0 = atomicLoad(&tab[s * 4u]);
  let cx = i32(k0 & 0xffffu);
  let cy = i32(k0 >> 16u);
  let keep = u.e;
  if (cx >= keep.x && cy >= keep.y && cx < keep.z && cy < keep.w) { return; }
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p < NOT_LOADED) { freePage(p); }
  atomicStore(&tab[s * 4u + 1u], TOMB);
}

// ---- a stroke's snapshot (round 4; the owner: "sweep the carve along a trajectory of the original uncarved surface so
// you carve one layer at a time"). Level id SNAP_ID + depth: a copy of a chunk's column pages made the first time a
// stroke is about to change that chunk (copy on write), let go at the stroke's end. The pick (solidDist) reads it
// where it exists, so during a stroke the ball rides the surface as it was when the stroke began. u.r.z & STROKE: a
// stroke is on (carve, add).
const SNAP_ID: u32 = 32u;
const STROKE: u32 = 2u;
@compute @workgroup_size(256)
fn snap(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  if (li == 0u) {
    atomicStore(&wany, select(0u, 1u, pageOf(SNAP_ID + L, cx, cy, 0u) < NOT_LOADED));
    var n = 0u;
    loop {
      if (pageOf(L, cx, cy, n) >= NOT_LOADED) { break; }
      n++;
    }
    atomicStore(&wmax, n);
  }
  let have = workgroupUniformLoad(&wany);
  let n = workgroupUniformLoad(&wmax);
  if (have != 0u || n == 0u) { return; }
  if (li == 0u) { ensurePages(SNAP_ID + L, cx, cy, n, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  for (var cz = 0u; cz < n; cz++) {
    let src = pageOf(L, cx, cy, cz);
    let dst = pageOf(SNAP_ID + L, cx, cy, cz);
    if (src >= NOT_LOADED || dst >= NOT_LOADED) { continue; }
    for (var i = li; i < PW; i += 256u) { pgStore(dst * PW + i, pgLoad(src * PW + i)); }
  }
}

/** the pages let go since the last merge join the free stack (its own pass: no push races a pop) */
@compute @workgroup_size(256)
fn merge(@builtin(local_invocation_index) li: u32) {
  let n = atomicLoad(&ctl[3]);
  let base = atomicLoad(&ctl[2]);
  for (var i = li; i < n; i += 256u) {
    atomicStore(&ctl[CTL_STACK + base + i], atomicLoad(&ctl[CTL_STACK + u.r.y + i]));
  }
  storageBarrier();
  workgroupBarrier();
  if (li == 0u) {
    atomicStore(&ctl[2], base + n);
    atomicStore(&ctl[3], 0u);
  }
}

// ---- plan: an edit's regions on every level (the oracle's Nest.edit + propagate, as chunk rects) ----------------------
// reg 8: the hit level (-1: none), 9-10: the hit (window columns of that level, f32), 11: radius, 12: amount (its
// units). Slots: level m role 0 restrict m -> m-1 (parent chunks), 1 residual of m, 2 derive of m, 3 the edit on m.
const SLOTS: u32 = 32u;
const MAX_R: f32 = 76.0;
fn slotOf(m: i32, role: i32) -> u32 { return u32(m * 4 + role); }
fn chunksOver(c: vec4<i32>, lid: u32) -> vec4<i32> {
  let w = u.lv[lid];
  let x0 = max(c.x, w.x) / 16;
  let y0 = max(c.y, w.y) / 16;
  let x1 = (min(c.z, w.x + w.z) + 15) / 16;
  let y1 = (min(c.w, w.y + w.z) + 15) / 16;
  return vec4<i32>(x0, y0, x1, y1);
}
fn setChunks(slot: u32, blk: vec4<i32>, ch: vec4<i32>) { setSlot(slot, blk, ch.x, ch.y, ch.z - ch.x, ch.w - ch.y); }
fn unionR(a: vec4<i32>, b: vec4<i32>) -> vec4<i32> { return vec4<i32>(min(a.x, b.x), min(a.y, b.y), max(a.z, b.z), max(a.w, b.w)); }

@compute @workgroup_size(1)
fn plan() {
  let k = i32(u.a.x);
  for (var s = 0u; s < SLOTS; s++) { setSlot(s, vec4<i32>(0), 0, 0, 0, 0); }
  var d = reg[8];
  var hx = bitcast<f32>(reg[9]);
  var hy = bitcast<f32>(reg[10]);
  if ((u.r.z & 1u) != 0u) {
    d = i32(u.d.z);
    hx = u.c.x;
    hy = u.c.y;
  }
  reg[8] = d;
  if (d < 0) { return; }
  let sc = pow(f32(k), f32(d));
  let r = min(u.c.z * sc, MAX_R);
  reg[9] = bitcast<i32>(hx);
  reg[10] = bitcast<i32>(hy);
  reg[11] = bitcast<i32>(r);
  reg[12] = bitcast<i32>(u.c.w * sc);
  // the ball's centre height (carve, add): the pick's, or the forced hit's (u.d.y)
  if ((u.r.z & 1u) != 0u) { reg[13] = bitcast<i32>(u.d.y); }
  let w = u.lv[d];
  let cxg = f32(w.x) + hx;
  let cyg = f32(w.y) + hy;
  // carve and add reach a ring of ghosts past their radius; the brush's one structural decision (where a new gap or
  // interval goes, by index: the oracle's ballSite) is made here, once, from the column under the centre as it is
  let isBall = u.a.z == 4u || u.a.z == 5u;
  var rb = r;
  if (isBall) {
    rb = r + RING;
    let cc = clampTo(u32(d), i32(floor(cxg)), i32(floor(cyg)));
    reg[14] = i32(ballSiteOf(u32(d), cc.x, cc.y, bitcast<f32>(reg[13]), r, u.a.z == 5u));
    reg[15] = i32(colCount(u32(d), cc.x, cc.y));
  }
  var box = vec4<i32>(i32(floor(cxg - rb)), i32(floor(cyg - rb)), i32(ceil(cxg + rb)) + 1, i32(ceil(cyg + rb)) + 1);
  // a stroke (carve, add): the ball sweeps from the last centre of the stroke to this one (a capsule), so a fast drag
  // leaves no gaps. cam 300-303: the last centre (level, x, y, z in that level's window units), 304: 1 once the stroke
  // has one; 305-307: it in level d's units (ballSpan's)
  if ((u.r.z & STROKE) != 0u) {
    let cz = bitcast<f32>(reg[13]);
    var pc = vec3<f32>(hx, hy, cz);
    if (cam[304] > 0.5) {
      let pd = u32(cam[300]);
      let wp = u.lv[pd];
      let s = pow(f32(k), f32(d) - f32(pd));
      // (window units of level pd to level d: global columns scaled, z through the world)
      pc = vec3<f32>((f32(wp.x) + cam[301]) * s - f32(w.x), (f32(wp.y) + cam[302]) * s - f32(w.y), ((zOrig(pd) + cam[303] / kpow(pd)) - zOrig(u32(d))) * kpow(u32(d)));
    }
    cam[305] = pc.x;
    cam[306] = pc.y;
    cam[307] = pc.z;
    cam[300] = f32(d);
    cam[301] = hx;
    cam[302] = hy;
    cam[303] = cz;
    cam[304] = 1.0;
    let px = f32(w.x) + pc.x;
    let py = f32(w.y) + pc.y;
    box = unionR(box, vec4<i32>(i32(floor(px - rb)), i32(floor(py - rb)), i32(ceil(px + rb)) + 1, i32(ceil(py + rb)) + 1));
  }
  box = vec4<i32>(max(box.x, w.x), max(box.y, w.y), min(box.z, w.x + w.z), min(box.w, w.y + w.z));
  if (box.x >= box.z || box.y >= box.w) {
    reg[8] = -1;
    return;
  }
  var ch: array<vec4<i32>, 8>;
  var has: array<bool, 8>;
  for (var m = 0; m < 8; m++) { has[m] = false; }
  ch[d] = box;
  has[d] = true;
  setChunks(slotOf(d, 3), box, chunksOver(box + vec4<i32>(-2, -2, 2, 2), u32(d)));
  for (var m = d; m >= 1; m--) {
    let c = ch[m];
    let pr = vec4<i32>(c.x / k, c.y / k, (c.z + k - 1) / k, (c.w + k - 1) / k);
    setChunks(slotOf(m, 0), pr, chunksOver(pr, u32(m - 1)));
    if (has[m - 1]) { ch[m - 1] = unionR(ch[m - 1], pr); } else { ch[m - 1] = pr; }
    has[m - 1] = true;
  }
  let live = i32(u.r.w);
  for (var m = 1; m < live; m++) {
    let wm = u.lv[m];
    let cover = vec4<i32>(wm.x / k, wm.y / k, (wm.x + wm.z) / k, (wm.y + wm.z) / k);
    var any = false;
    var un = vec4<i32>(0);
    if (has[m - 1]) {
      un = ch[m - 1] + vec4<i32>(-2, -2, 2, 2);
      any = true;
    }
    if (has[m]) {
      let c = ch[m];
      let own = vec4<i32>(c.x / k, c.y / k, (c.z + k - 1) / k, (c.w + k - 1) / k);
      if (any) { un = unionR(un, own); } else { un = own; }
      any = true;
    }
    if (!any) { continue; }
    let pr = vec4<i32>(max(un.x, cover.x), max(un.y, cover.y), min(un.z, cover.z), min(un.w, cover.w));
    if (pr.x >= pr.z || pr.y >= pr.w) { continue; }
    let cols = pr * k;
    let cc = chunksOver(cols, u32(m));
    // at and above the edit, a level's live columns stay (only the restricted or edited ones changed) and its
    // residual takes up its parent's change; derive reproduces them exactly (exactRes), so it is not run there. Below,
    // the live columns follow their parent over the enhance support. (Deriving the levels above too, over the support,
    // made the next level's region its whole window: an edit at depth 2 cost ~100 ms.)
    if (m <= d) {
      setChunks(slotOf(m, 1), cols, cc);
    } else {
      setChunks(slotOf(m, 2), cols, cc);
      ch[m] = cols;
      has[m] = true;
    }
    has[m] = true;
  }
}

// ---- edits on the hit level (u.a.w = L; only the hit level's slot has work) ------------------------------------------
fn brushW(X: i32, Y: i32, L: u32) -> f32 {
  let w = u.lv[L];
  let cx = f32(w.x) + bitcast<f32>(reg[9]);
  let cy = f32(w.y) + bitcast<f32>(reg[10]);
  let r = bitcast<f32>(reg[11]);
  let d = length(vec2<f32>(f32(X) + 0.5 - cx, f32(Y) + 0.5 - cy)) / r;
  if (d >= 1.0) { return 0.0; }
  return (1.0 - d * d) * (1.0 - d * d);
}
fn inBox(X: i32, Y: i32, b: vec4<i32>) -> bool { return X >= b.x && Y >= b.y && X < b.z && Y < b.w; }

@compute @workgroup_size(16, 16)
fn edit(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let L = u.a.w;
  let slot = slotOf(i32(L), 3);
  let X = (slotW(slot, 4u) + i32(wid.x)) * 16 + i32(lid.x);
  let Y = (slotW(slot, 5u) + i32(wid.y)) * 16 + i32(lid.y);
  let box = vec4<i32>(slotW(slot, 0u), slotW(slot, 1u), slotW(slot, 2u), slotW(slot, 3u));
  if (!inBox(X, Y, box)) { return; }
  let p = brushW(X, Y, L);
  if (p <= 0.0) { return; }
  let a = bitcast<f32>(reg[12]) * p;
  let n = colCount(L, X, Y);
  if (n == 0u) { return; }
  if (u.a.z == 1u) {
    let t = ivlAt(L, X, Y, n - 1u);
    setIvl(L, X, Y, n - 1u, t.z0, t.z1 + a, t.m, t.e);
    return;
  }
  let top = ivlAt(L, X, Y, n - 1u).z1 - a;
  for (var i = n; i > 0u; i--) {
    let t = ivlAt(L, X, Y, i - 1u);
    if (t.z1 <= top) { break; }
    var z0 = t.z0;
    if (i > 1u && z0 > top) { z0 = top; }
    setIvl(L, X, Y, i - 1u, z0, top, t.m, t.e);
  }
}

// ---- carve (op 4) and add (op 5): a ball on each column (the oracle's applyBall; docs/design/NESTED_SCALES.md
// "Footprints"). Inside its footprint the ball's z-span is carved or filled; in a ring of RING columns past it only
// ghosts are written. Nothing is removed: a cut-away interval stays as a ghost (eS < 0). One structural change a brush
// (the plan's site, reg 14-15): carve splits the interval holding the centre (a new gap), add inserts an interval into
// the air holding it (or revives the ghost holding it), in every column of the centre column's interval count, so the
// structure stays constant across the footprint and its ring. Footprints analytic: the ball's air eG = r - d, a bound
// it reaches cut away (eS = min(eS, d - r_slice(z))), a laid interval eS = r - d. A column grows by one at most; pages
// are ensured per chunk first; it is rewritten in place (top down).
const RING: f32 = 1.5;
/** (the plan, one thread) the brush's site: kind | idx << 2 (kind 0 none, 1 carve: split interval idx / add: insert
 *  into gap idx (idx = n: the sky), 2 add: revive ghost interval idx) */
/** a gap a carve may reuse: real air (some thickness) or one a brush made (a ghost, or a footprint nearer than E_FAR);
 *  not the zero-thickness boundary between two materials (the oracle's reusableGap) */
fn reusableGap(L: u32, X: i32, Y: i32, i: u32) -> bool {
  let iv = ivlAt(L, X, Y, i);
  return iv.z0 > ivlAt(L, X, Y, i - 1u).z1 || eG(iv) < E_FAR;
}
/** the interval a carve splits: the highest solid one starting at or below the centre (the oracle's splitIdx) */
fn splitIdx(L: u32, X: i32, Y: i32, cz: f32) -> u32 {
  var s = 0u;
  let n = colCount(L, X, Y);
  for (var i = 1u; i < n; i++) {
    let iv = ivlAt(L, X, Y, i);
    if (present(eS(iv)) && iv.z0 <= cz) { s = i; }
  }
  return s;
}
fn ballSiteOf(L: u32, X: i32, Y: i32, cz: f32, r: f32, add: bool) -> u32 {
  let n = colCount(L, X, Y);
  // reuse: a gap (carve) or an interval (add), ghost or not, within the ball's reach in z makes no new structure
  for (var i = 1u; i < n; i++) {
    let iv = ivlAt(L, X, Y, i);
    if (!add && reusableGap(L, X, Y, i) && iv.z0 >= cz - r && ivlAt(L, X, Y, i - 1u).z1 <= cz + r) { return 0u; }
    if (add && iv.z0 <= cz && cz <= iv.z1 && !solidIv(iv, i)) { return 2u | (i << 2u); }
  }
  if (!add) { return 1u | (splitIdx(L, X, Y, cz) << 2u); }
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(L, X, Y, i);
    if ((i == 0u || iv.z0 <= cz + r) && cz - r <= iv.z1 && solidIv(iv, i)) { return 0u; }
  }
  for (var i = 1u; i < n; i++) {
    if (add && ivlAt(L, X, Y, i - 1u).z1 < cz && cz < ivlAt(L, X, Y, i).z0) { return 1u | (i << 2u); }
  }
  if (add && n > 0u && cz > ivlAt(L, X, Y, n - 1u).z1) { return 1u | (n << 2u); }
  return 0u;
}
/** the ball (or a stroke's capsule) at a column: x the plan distance to its centre line, y the centre's height there */
fn ballAt(X: i32, Y: i32, L: u32) -> vec2<f32> {
  let w = u.lv[L];
  let c1 = vec3<f32>(f32(w.x) + bitcast<f32>(reg[9]), f32(w.y) + bitcast<f32>(reg[10]), bitcast<f32>(reg[13]));
  var c0 = c1;
  if ((u.r.z & STROKE) != 0u) { c0 = vec3<f32>(f32(w.x) + cam[305], f32(w.y) + cam[306], cam[307]); }
  let q = vec2<f32>(f32(X) + 0.5, f32(Y) + 0.5);
  let dv = c1.xy - c0.xy;
  let l2 = dot(dv, dv);
  var t = 1.0;
  if (l2 > 0.0) { t = clamp(dot(q - c0.xy, dv) / l2, 0.0, 1.0); }
  let p = mix(c0, c1, t);
  return vec2<f32>(length(q - p.xy), p.z);
}
fn ballSpan(X: i32, Y: i32, L: u32) -> vec3<f32> {
  let w = u.lv[L];
  let c1 = vec3<f32>(f32(w.x) + bitcast<f32>(reg[9]), f32(w.y) + bitcast<f32>(reg[10]), bitcast<f32>(reg[13]));
  var c0 = c1;
  // (a stroke: the capsule from the last centre; its span on a vertical line is one interval, the union of the balls'
  // spans along the segment, sampled at a quarter radius at most)
  if ((u.r.z & STROKE) != 0u) { c0 = vec3<f32>(f32(w.x) + cam[305], f32(w.y) + cam[306], cam[307]); }
  let r = bitcast<f32>(reg[11]);
  let q = vec2<f32>(f32(X) + 0.5, f32(Y) + 0.5);
  let steps = u32(clamp(ceil(length(c1 - c0) / (0.25 * r)), 0.0, 256.0));
  var lo = 1e30;
  var hi = -1e30;
  for (var i = 0u; i <= steps; i++) {
    let c = mix(c0, c1, select(1.0, f32(i) / f32(steps), steps > 0u));
    let dd = length(q - c.xy);
    if (dd >= r) { continue; }
    let h = sqrt(r * r - dd * dd);
    lo = min(lo, c.z - h);
    hi = max(hi, c.z + h);
  }
  if (hi < lo) { return vec3<f32>(0.0, 0.0, -1.0); }
  return vec3<f32>(lo, hi, 1.0);
}
/** a bound at height z the ball reaches at plan distance dd is cut away there: dd - r_slice(z) (E_FAR: out of reach) */
fn eCut(z: f32, czc: f32, r: f32, dd: f32) -> f32 {
  if (abs(z - czc) >= r) { return E_FAR; }
  return dd - sqrt(max(0.0, r * r - (z - czc) * (z - czc)));
}
/** shift intervals from..n-1 of a column up by one (top down) */
fn shiftUp(L: u32, X: i32, Y: i32, first: u32, n: u32) {
  for (var j = i32(n) - 1; j >= i32(first); j--) {
    let t = ivlAt(L, X, Y, u32(j));
    setIvl(L, X, Y, u32(j + 1), t.z0, t.z1, t.m, t.e);
  }
}

@compute @workgroup_size(16, 16)
fn ball(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let slot = slotOf(i32(L), 3);
  let o = slotOrigin(slot, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  let box = vec4<i32>(slotW(slot, 0u), slotW(slot, 1u), slotW(slot, 2u), slotW(slot, 3u));
  let add = u.a.z == 5u;
  let r = bitcast<f32>(reg[11]);
  let sp = ballSpan(X, Y, L);
  let ba = ballAt(X, Y, L);
  let dd = ba.x;
  let czc = ba.y;
  let inside = sp.z > 0.0;
  let lo = sp.x;
  let hi = sp.y;
  let n = colCount(L, X, Y);
  let hit = inBox(X, Y, box) && (inside || dd < r + RING) && n > 0u;
  let kind = u32(reg[14]) & 3u;
  let sIdx = u32(reg[14]) >> 2u;
  let atSite = kind != 0u && n == u32(reg[15]);
  // carve: the site's split; elsewhere, where no gap lies within the ball's reach, a split of the solid interval holding
  // the span (in the ring: the centre's height), so the columns past a reused gap's ring get the same gap
  var split = -1;
  var nearG = -1;
  var nearD = 0.0;
  if (hit && !add) {
    if (kind == 1u && atSite) { split = i32(sIdx); }
    if (split < 0) {
      // the nearest reusable gap within the ball's radius of its centre in z (the same test inside and in the ring)
      for (var g = 1u; g < n; g++) {
        let dz = max(max(ivlAt(L, X, Y, g - 1u).z1 - czc, czc - ivlAt(L, X, Y, g).z0), 0.0);
        if (reusableGap(L, X, Y, g) && dz <= r && (nearG < 0 || dz < nearD)) {
          nearG = i32(g);
          nearD = dz;
        }
      }
      if (nearG < 0) { split = i32(splitIdx(L, X, Y, czc)); }
    }
  }
  var nn = n;
  if (hit && (split >= 0 || (add && kind == 1u && atSite))) { nn = n + 1u; }
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  atomicMax(&wmax, max(nn, colCount(L, X, Y)));
  let maxN = workgroupUniformLoad(&wmax);
  let need = (maxN + K - 1u) / K;
  if (li == 0u) { ensurePages(L, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!hit) { return; }
  let eBall = r - dd;
  var made = -1;
  if (!add) {
    if (split >= 0) {
      let i = u32(split);
      let iv = ivlAt(L, X, Y, i);
      let zi0 = iv.z0;
      let zi1 = iv.z1;
      var a = clamp(czc, zi0, zi1);
      var b = a;
      if (inside) {
        a = clamp(lo, zi0, zi1);
        b = clamp(hi, zi0, zi1);
      }
      let esI = eS(iv);
      shiftUp(L, X, Y, i + 1u, n);
      // the lower piece keeps index i (and the gap below it); the upper is new, over the ball's gap
      var lowE = esI;
      if (i > 0u) { lowE = min(esI, eCut(zi0, czc, r, dd)); }
      setIvl(L, X, Y, i, zi0, a, iv.m, packE(lowE, eG(iv)));
      setIvl(L, X, Y, i + 1u, b, zi1, iv.m, packE(min(esI, eCut(zi1, czc, r, dd)), eBall));
      made = split;
    }
    if (split < 0 && nearG > 0 && inside) {
      // (a span that misses the reused gap: the gap grows to the span, as a swept capsule would)
      let g = u32(nearG);
      let bl = ivlAt(L, X, Y, g - 1u);
      let ab = ivlAt(L, X, Y, g);
      if (lo < bl.z1) { setIvl(L, X, Y, g - 1u, bl.z0, select(max(lo, bl.z0), lo, g == 1u), bl.m, bl.e); }
      if (hi > ab.z0) { setIvl(L, X, Y, g, min(hi, ab.z1), ab.z1, ab.m, ab.e); }
    }
    if (inside) {
      for (var j = 0; j < i32(nn); j++) {
        if (made >= 0 && (j == made || j == made + 1)) { continue; }
        let iv = ivlAt(L, X, Y, u32(j));
        let z0 = select(iv.z0, -3.0e38, j == 0);
        if (!(iv.z1 > lo && z0 < hi)) { continue; }
        var e = unpack2x16float(iv.e);
        var b0 = iv.z0;
        var b1 = iv.z1;
        if (lo <= z0 && iv.z1 <= hi) {
          e.x = min(e.x, min(eCut(z0, czc, r, dd), eCut(iv.z1, czc, r, dd)));
        } else if (iv.z1 <= hi) {
          b1 = lo;
        } else if (lo <= z0) {
          b0 = hi;
        }
        setIvl(L, X, Y, u32(j), b0, b1, iv.m, packE(e.x, e.y));
      }
    }
    // the ball's air: every gap it opens or reaches (in the ring: within its radius in z)
    for (var g = 1u; g < nn; g++) {
      let iv = ivlAt(L, X, Y, g);
      let f = ivlAt(L, X, Y, g - 1u).z1;
      let cc = iv.z0;
      var near = max(max(f - czc, czc - cc), 0.0) <= r;
      if (inside) { near = cc >= lo && f <= hi; }
      if (near && eBall > eG(iv)) { setIvl(L, X, Y, g, iv.z0, iv.z1, iv.m, packE(eS(iv), eBall)); }
    }
  } else {
    if (kind == 1u && atSite) {
      let g = sIdx;
      let f = ivlAt(L, X, Y, g - 1u).z1;
      var cc = 3.0e38;
      var egOld = E_FAR;
      if (g < n) {
        cc = ivlAt(L, X, Y, g).z0;
        egOld = eG(ivlAt(L, X, Y, g));
      }
      var a = clamp(czc, f, cc);
      var b = a;
      if (inside) {
        a = clamp(lo, f, cc);
        b = clamp(hi, f, cc);
      }
      shiftUp(L, X, Y, g, n);
      // the new interval takes index g; the gap below it keeps the old gap's footprint, as does the one above it
      setIvl(L, X, Y, g, a, b, MAT_SOIL, packE(eBall, egOld));
      made = i32(g);
    } else if (kind == 2u && atSite) {
      let j = sIdx;
      let iv = ivlAt(L, X, Y, j);
      var b0 = iv.z0;
      var b1 = iv.z1;
      if (inside) {
        b0 = min(iv.z0, max(lo, ivlAt(L, X, Y, j - 1u).z1));
        var up = 3.0e38;
        if (j + 1u < n) { up = ivlAt(L, X, Y, j + 1u).z0; }
        b1 = max(iv.z1, min(hi, up));
      }
      setIvl(L, X, Y, j, b0, b1, iv.m, packE(max(eS(iv), eBall), eG(iv)));
      made = i32(j);
    }
    if (inside) {
      // the other air pieces the span reaches are filled from the solid they touch (no new interval)
      for (var g = 1; g <= i32(nn); g++) {
        if (made >= 0 && (g == made || g == made + 1)) { continue; }
        let below = ivlAt(L, X, Y, u32(g - 1));
        let f = below.z1;
        var cc = 3.0e38;
        if (g < i32(nn)) { cc = ivlAt(L, X, Y, u32(g)).z0; }
        if (!(cc > lo && f < hi)) { continue; }
        // (a span strictly inside an air piece, no new interval made: filled from the solid below)
        if (lo <= f || (made < 0 && hi < cc)) {
          var es = eS(below);
          if (g - 1 > 0) { es = max(es, eBall); }
          setIvl(L, X, Y, u32(g - 1), below.z0, min(hi, cc), below.m, packE(es, eG(below)));
        } else if (hi >= cc && g < i32(nn)) {
          let above = ivlAt(L, X, Y, u32(g));
          setIvl(L, X, Y, u32(g), max(lo, f), above.z1, above.m, packE(max(eS(above), eBall), eG(above)));
        }
      }
    }
  }
  setCount(L, X, Y, nn, need);
}

// ---- melt: a slump of the top four intervals between same-structure neighbours, mass kept exactly in reals ------------
// scratch: 8 floats a column over the box + 2: S, the top four thicknesses (interval 0: 1e30), structure hash, n, brush
const MELT_W: i32 = 160;
const MELT_DEPTH: u32 = 4u;
fn snapIdx(X: i32, Y: i32, box: vec4<i32>) -> u32 { return u32((Y - box.y + 2) * MELT_W + (X - box.x + 2)) * 8u; }

@compute @workgroup_size(16, 16)
fn meltSnap(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let L = u.a.w;
  let slot = slotOf(i32(L), 3);
  let X = (slotW(slot, 4u) + i32(wid.x)) * 16 + i32(lid.x);
  let Y = (slotW(slot, 5u) + i32(wid.y)) * 16 + i32(lid.y);
  let box = vec4<i32>(slotW(slot, 0u), slotW(slot, 1u), slotW(slot, 2u), slotW(slot, 3u));
  if (!inBox(X, Y, box + vec4<i32>(-2, -2, 2, 2))) { return; }
  let b = snapIdx(X, Y, box);
  if (!inWin(L, X, Y)) {
    scr[b + 6u] = 0.0;
    return;
  }
  let n = colCount(L, X, Y);
  var h = n;
  for (var i = 0u; i < n; i++) { h = h * 31u + ivlAt(L, X, Y, i).m; }
  // (footprints: the surface that slumps is the top present one; a ghost interval holds no mass)
  scr[b] = topPresent(L, X, Y, n);
  for (var q = 0u; q < MELT_DEPTH; q++) {
    var th = 0.0;
    if (q < n) {
      let i = n - 1u - q;
      if (i == 0u) { th = 1e30; } else if (present(eS(ivlAt(L, X, Y, i)))) { th = layerVal(L, X, Y, 2u * i); }
    }
    scr[b + 1u + q] = th;
  }
  scr[b + 5u] = bitcast<f32>(h);
  scr[b + 6u] = f32(n);
  scr[b + 7u] = brushW(X, Y, L);
}
fn snapOk(b: u32, o: u32) -> bool { return scr[b + 6u] > 0.0 && scr[o + 6u] > 0.0 && bitcast<u32>(scr[b + 5u]) == bitcast<u32>(scr[o + 5u]) && scr[b + 6u] == scr[o + 6u]; }
/** a snapshot column's outflow, after its cap (what its top four intervals hold) */
fn outflow(X: i32, Y: i32, box: vec4<i32>) -> f32 {
  let b = snapIdx(X, Y, box);
  var o = 0.0;
  let rate = u.d.y;
  for (var k = 0; k < 4; k++) {
    let d = select(select(select(vec2<i32>(0, -1), vec2<i32>(0, 1), k == 2), vec2<i32>(-1, 0), k == 1), vec2<i32>(1, 0), k == 0);
    let q = snapIdx(X + d.x, Y + d.y, box);
    if (!snapOk(b, q)) { continue; }
    o += rate * min(scr[b + 7u], scr[q + 7u]) * max(0.0, scr[b] - scr[q]);
  }
  var cap = 0.0;
  let n = u32(scr[b + 6u]);
  for (var q = 0u; q < min(n, MELT_DEPTH); q++) { cap += scr[b + 1u + q]; }
  return min(o, cap);
}
fn outRaw(X: i32, Y: i32, box: vec4<i32>) -> f32 {
  let b = snapIdx(X, Y, box);
  var o = 0.0;
  for (var k = 0; k < 4; k++) {
    let d = select(select(select(vec2<i32>(0, -1), vec2<i32>(0, 1), k == 2), vec2<i32>(-1, 0), k == 1), vec2<i32>(1, 0), k == 0);
    let q = snapIdx(X + d.x, Y + d.y, box);
    if (!snapOk(b, q)) { continue; }
    o += u.d.y * min(scr[b + 7u], scr[q + 7u]) * max(0.0, scr[b] - scr[q]);
  }
  return o;
}
/** of an outflow o, the part taken from the q-th interval from the top */
fn takeFrom(b: u32, o: f32, q: u32) -> f32 {
  var left = o;
  for (var j = 0u; j < q; j++) { left = max(0.0, left - scr[b + 1u + j]); }
  return min(left, scr[b + 1u + q]);
}

@compute @workgroup_size(16, 16)
fn meltApply(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let L = u.a.w;
  let slot = slotOf(i32(L), 3);
  let X = (slotW(slot, 4u) + i32(wid.x)) * 16 + i32(lid.x);
  let Y = (slotW(slot, 5u) + i32(wid.y)) * 16 + i32(lid.y);
  let box = vec4<i32>(slotW(slot, 0u), slotW(slot, 1u), slotW(slot, 2u), slotW(slot, 3u));
  if (!inBox(X, Y, box)) { return; }
  let b = snapIdx(X, Y, box);
  let n = u32(scr[b + 6u]);
  if (n == 0u) { return; }
  let m = min(n, MELT_DEPTH);
  var dth = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  let oo = outflow(X, Y, box);
  for (var q = 0u; q < m; q++) { dth[q] -= takeFrom(b, oo, q); }
  for (var k = 0; k < 4; k++) {
    let d = select(select(select(vec2<i32>(0, -1), vec2<i32>(0, 1), k == 2), vec2<i32>(-1, 0), k == 1), vec2<i32>(1, 0), k == 0);
    let qb = snapIdx(X + d.x, Y + d.y, box);
    if (!snapOk(b, qb)) { continue; }
    let f = u.d.y * min(scr[b + 7u], scr[qb + 7u]) * max(0.0, scr[qb] - scr[b]);
    if (f <= 0.0) { continue; }
    let raw = outRaw(X + d.x, Y + d.y, box);
    let og = outflow(X + d.x, Y + d.y, box);
    let fe = f * og / raw;
    for (var q = 0u; q < m; q++) { dth[q] += fe * takeFrom(qb, og, q) / og; }
  }
  // rebuild the top m intervals over the unchanged ones below
  let lo = n - m;
  var base = 0.0;
  var prevOld = 0.0;
  var first = lo;
  if (lo == 0u) {
    let t = ivlAt(L, X, Y, 0u);
    prevOld = t.z1;
    base = t.z1 + dth[n - 1u];
    setIvl(L, X, Y, 0u, t.z0, base, t.m, t.e);
    first = 1u;
  } else {
    base = ivlAt(L, X, Y, lo - 1u).z1;
    prevOld = base;
  }
  for (var i = first; i < n; i++) {
    let t = ivlAt(L, X, Y, i);
    let gap = t.z0 - prevOld;
    prevOld = t.z1;
    let th = max(0.0, (t.z1 - t.z0) + dth[n - 1u - i]);
    let z0 = base + gap;
    setIvl(L, X, Y, i, z0, z0 + th, t.m, t.e);
    base = z0 + th;
  }
}

// ---- the camera: per level view-projections in that level's own units (the owner's nested scenes) ---------------------
// cam: 0 target z (eased), 1 started, 2 eye z, 3 near (world), 4-6 right, 8-10 up, 12-14 forward, 16-18 the eye's
// offset from the target (world); level m at 32 + m * 24: the view-projection (16), the eye (3), near (1) in its units.
// The target's x, y come from the CPU as hi + lo floats; z is the ground there, found on the finest level holding it.
fn kpow(m: u32) -> f32 { return pow(f32(u.a.x), f32(m)); }
fn zOrig(m: u32) -> f32 {
  var z = 0.0;
  for (var j = 1u; j <= m; j++) { z += bitcast<f32>(reg[j]) / kpow(j - 1u); }
  return z;
}
/** a level's surface at local (x, y) (window columns), bilinear over the column centres */
fn surfLocal(m: u32, x: f32, y: f32) -> f32 {
  let w = u.lv[m];
  let fx = x - 0.5;
  let fy = y - 0.5;
  let i0 = i32(floor(fx));
  let j0 = i32(floor(fy));
  let tx = fx - f32(i0);
  let ty = fy - f32(j0);
  var h = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  for (var q = 0; q < 4; q++) {
    let X = clamp(w.x + i0 + (q & 1), w.x, w.x + w.z - 1);
    let Y = clamp(w.y + j0 + (q >> 1), w.y, w.y + w.z - 1);
    h[q] = topPresent(m, X, Y, colCount(m, X, Y));
  }
  return mix(mix(h[0], h[1], tx), mix(h[2], h[3], tx), ty);
}
/** at a level's local point: the vertical distance to the nearest bound of the column under it, negative inside solid
 *  (1e9 outside the window). Picking and the camera use it, so they see every interval, not only the top. */
fn solidDist(m: u32, p: vec3<f32>) -> f32 {
  let w = u.lv[m];
  if (p.x < 0.0 || p.y < 0.0 || p.x >= f32(w.z) || p.y >= f32(w.z)) { return 1e9; }
  let X = w.x + i32(floor(p.x));
  let Y = w.y + i32(floor(p.y));
  // (during a stroke the pick sees the surface as it was when the stroke began: the snapshot where the stroke changed it)
  var lid = m;
  if ((u.r.z & STROKE) != 0u && pageOf(SNAP_ID + m, X >> 4, Y >> 4, 0u) < NOT_LOADED) { lid = SNAP_ID + m; }
  let n = colCount(lid, X, Y);
  var d = 1e9;
  // solid: the present intervals and the ghost gaps (footprints: present())
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(lid, X, Y, i);
    var lo = iv.z0;
    var hi = iv.z1;
    var sol = solidIv(iv, i);
    for (var part = 0u; part < 2u; part++) {
      if (part == 1u) {
        if (i == 0u || present(eG(iv))) { break; }
        lo = ivlAt(lid, X, Y, i - 1u).z1;
        hi = iv.z0;
        sol = true;
      }
      if (!sol) { continue; }
      if (p.z >= lo && p.z <= hi) { return -min(p.z - lo, hi - p.z); }
      d = min(d, min(abs(p.z - hi), select(abs(p.z - lo), 1e9, i == 0u && part == 0u)));
    }
  }
  return d;
}
/** the distance from local point p to column (X, Y)'s solid, the column dilated to the square between its neighbours'
 *  centres (2 x 2 columns): the drawn surface between column centres (sheets, floors, ceilings, the half-way walls)
 *  lies inside the union of these boxes, so the eye kept outside them is never behind a drawn face. FAR: no solid. */
const FAR: f32 = 1e30;
fn colDist(m: u32, X: i32, Y: i32, w: vec4<i32>, p: vec3<f32>) -> f32 {
  let dx = max(0.0, abs(p.x - (f32(X - w.x) + 0.5)) - 1.0);
  let dy = max(0.0, abs(p.y - (f32(Y - w.y) + 0.5)) - 1.0);
  let n = colCount(m, X, Y);
  var best = FAR;
  // solid: the present intervals and the ghost gaps (the oracle's colDist)
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(m, X, Y, i);
    let z0 = select(iv.z0, -FAR, i == 0u);
    if (solidIv(iv, i)) { best = min(best, max(0.0, max(z0 - p.z, p.z - iv.z1))); }
    if (i > 0u && !present(eG(iv))) { best = min(best, max(0.0, max(ivlAt(m, X, Y, i - 1u).z1 - p.z, p.z - iv.z0))); }
  }
  if (best >= FAR) { return FAR; }
  return length(vec3<f32>(dx, dy, best));
}

/** the ground (world z) under world (hi + lo) x, y: the finest live level holding it */
fn ground(xh: f32, yh: f32, xl: f32, yl: f32) -> f32 {
  let live = u.r.w;
  for (var mi = i32(live) - 1; mi >= 0; mi--) {
    let m = u32(mi);
    let s = kpow(m);
    let w = u.lv[m];
    let lx = (xh * s - f32(w.x)) + xl * s;
    let ly = (yh * s - f32(w.y)) + yl * s;
    if (lx >= 1.0 && ly >= 1.0 && lx <= f32(w.z) - 1.0 && ly <= f32(w.z) - 1.0) { return zOrig(m) + surfLocal(m, lx, ly) / s; }
  }
  let w0 = u.lv[0];
  return surfLocal(0u, clamp(xh + xl, 1.0, f32(w0.z) - 1.0), clamp(yh + yl, 1.0, f32(w0.z) - 1.0));
}

// ---- the camera: a free eye with collision ---------------------------------------------------------------------------
// The eye lives here (world, hi + lo floats a coordinate). The CPU sends a wished move; the pass measures the nearest
// solid round the eye on every level holding it (colDist, CAM_R columns of that level each way), lets the eye move at
// most (nearest - margin) this frame and at most speed x nearest a second (the owner's rule: "speed limited by
// interpolated distance so it could never go through a surface"), then writes each level's view-projection.
// cam words: 1 placed, 2 eye z (world), 3 near (world), 4-6 right, 8-10 up, 12-14 forward, 20-22 eye hi, 24-26 eye lo,
// 27 times the eye was lifted out of solid, 28 the nearest solid after the move (world, a lower bound), 29 the centre
// ray's first solid (world; -1 none), 30 the level that measured the nearest solid, 31 the margin (world). Words 0-31 are
// the report the CPU reads back (asynchronously, never awaited). Level m at 32 + m * 24: view-projection (16), eye (3),
// near (1) in its units. 256-258: a placement's target x, y and distance (CPU-written).
const CAM_R: i32 = 24;
var<workgroup> wEye: array<vec4<f32>, 8>;
var<workgroup> wD: array<atomic<u32>, 8>;

fn eyeHi() -> vec3<f32> { return vec3<f32>(cam[20], cam[21], cam[22]); }
fn eyeLo() -> vec3<f32> { return vec3<f32>(cam[24], cam[25], cam[26]); }
/** the eye in level m's local units; w = 1 when it is inside the level's window */
fn eyeLocal(m: u32, hi: vec3<f32>, lo: vec3<f32>) -> vec4<f32> {
  let s = kpow(m);
  let w = u.lv[m];
  let p = vec3<f32>((hi.x * s - f32(w.x)) + lo.x * s, (hi.y * s - f32(w.y)) + lo.y * s, (hi.z - zOrig(m)) * s + lo.z * s);
  let inside = p.x >= 0.0 && p.y >= 0.0 && p.x < f32(w.z) && p.y < f32(w.z);
  return vec4<f32>(p, select(0.0, 1.0, inside));
}
/** a + b as hi + lo (two-sum, then renormalised) */
fn add2(hi: f32, lo: f32, b: f32) -> vec2<f32> {
  let s = hi + b;
  let bb = s - hi;
  let err = (hi - (s - bb)) + (b - bb);
  let l = lo + err;
  let h2 = s + l;
  return vec2<f32>(h2, l - (h2 - s));
}
fn viewDir(yaw: f32, pitch: f32) -> vec3<f32> { return -vec3<f32>(cos(pitch) * cos(yaw), cos(pitch) * sin(yaw), sin(pitch)); }

@compute @workgroup_size(256)
fn camera(@builtin(local_invocation_index) li: u32) {
  let live = u.r.w;
  if (li == 0u) {
    for (var m = 0u; m < 8u; m++) { atomicStore(&wD[m], bitcast<u32>(FAR)); }
    if (cam[1] == 0.0 || u.cA.w > 0.5) {
      // placed: the ground under the target, then back along the view by the distance
      // (a negative distance: the eye at (x, y, word 259) itself)
      let t = vec3<f32>(cam[256], cam[257], ground(cam[256], cam[257], 0.0, 0.0));
      var e = t - cam[258] * viewDir(u.cB.x, u.cB.y);
      if (cam[258] < 0.0) { e = vec3<f32>(cam[256], cam[257], cam[259]); }
      for (var i = 0u; i < 3u; i++) {
        cam[20u + i] = e[i];
        cam[24u + i] = 0.0;
      }
      cam[1] = 1.0;
    }
    let hi = eyeHi();
    let lo = eyeLo();
    for (var m = 0u; m < 8u; m++) {
      if (m < live) { wEye[m] = eyeLocal(m, hi, lo); } else { wEye[m] = vec4<f32>(0.0); }
    }
  }
  workgroupBarrier();
  // the nearest solid on each level holding the eye, CAM_R of its columns each way
  let side = u32(2 * CAM_R + 1);
  for (var m = 0u; m < live; m++) {
    let e = wEye[m];
    if (e.w < 0.5) { continue; }
    let w = u.lv[m];
    let ex = w.x + i32(floor(e.x)) - CAM_R;
    let ey = w.y + i32(floor(e.y)) - CAM_R;
    for (var idx = li; idx < side * side; idx += 256u) {
      let X = ex + i32(idx % side);
      let Y = ey + i32(idx / side);
      if (X < w.x || Y < w.y || X >= w.x + w.z || Y >= w.y + w.z) { continue; }
      let dd = colDist(m, X, Y, w, e.xyz);
      if (dd < FAR) { atomicMin(&wD[m], bitcast<u32>(dd)); }
    }
  }
  workgroupBarrier();
  if (li != 0u) { return; }
  let yaw = u.cB.x;
  let pitch = u.cB.y;
  let aspect = u.cB.z;
  let speed = u.cB.w;
  let fovy = u.cC.x;
  let dt = u.cC.w;
  var hi = eyeHi();
  var lo = eyeLo();
  // the finest level holding the eye sets the margin (a third of its column)
  var fin = 0u;
  for (var m = 0u; m < live; m++) {
    if (wEye[m].w > 0.5) { fin = m; }
  }
  let margin = 0.3 / kpow(fin);
  // the nearest solid (world): the finest level that found one within its reach; finer levels that found none bound it
  // from below by their reach (or their window's edge). A coarser level's distance is less one of its columns (its
  // surface is the finer one's mean, not the finer one itself).
  var lb = 0.0;
  var d = -1.0;
  var used = -1;
  var raw = FAR;
  for (var mi = i32(live) - 1; mi >= 0; mi--) {
    let m = u32(mi);
    let e = wEye[m];
    if (e.w < 0.5) { continue; }
    let s = kpow(m);
    raw = bitcast<f32>(atomicLoad(&wD[m]));
    if (raw < 1e29) {
      d = max(lb, (raw - select(1.0, 0.0, m == fin)) / s);
      used = mi;
      break;
    }
    let w = u.lv[m];
    let edge = min(min(e.x, e.y), min(f32(w.z) - e.x, f32(w.z) - e.y));
    lb = max(lb, max(0.0, min(f32(CAM_R), edge) - 1.5) / s);
  }
  if (d < 0.0) { d = lb; }
  // inside solid (a level promoted under the eye with detail above it, or an add over it): lifted to the air above
  if (used == i32(fin) && raw <= 0.0) {
    let m = fin;
    let s = kpow(m);
    let w = u.lv[m];
    var p = wEye[m].xyz;
    for (var it = 0; it < 64; it++) {
      var moved = false;
      for (var X = i32(ceil(p.x - 1.5)); X <= i32(floor(p.x + 0.5)); X++) {
        for (var Y = i32(ceil(p.y - 1.5)); Y <= i32(floor(p.y + 0.5)); Y++) {
          let n = colCount(m, w.x + X, w.y + Y);
          for (var i = 0u; i < n; i++) {
            let iv = ivlAt(m, w.x + X, w.y + Y, i);
            // (a ghost interval is air; a ghost gap below a present interval is solid: from the one below's top)
            var z0 = iv.z0;
            if (i > 0u && !present(eG(iv))) { z0 = ivlAt(m, w.x + X, w.y + Y, i - 1u).z1; }
            if (solidIv(iv, i) && (i == 0u || p.z >= z0) && p.z <= iv.z1) {
              p.z = iv.z1 + 0.3;
              moved = true;
            }
          }
        }
      }
      if (!moved) { break; }
    }
    hi.z = zOrig(m) + p.z / s;
    lo.z = 0.0;
    cam[27] += 1.0;
    // (not measured at the lifted point: no move this frame; the next frame measures it)
    d = 0.0;
  }
  // the move, limited by the nearest solid
  var mv = u.cA.xyz;
  let len = length(mv);
  // (half the nearest distance can never reach a surface: an eye nearer than the margin can still move away)
  let allow = max(0.0, min(max(d - margin, 0.5 * d), speed * d * dt));
  if (len > allow) { mv *= allow / max(len, 1e-30); }
  for (var i = 0u; i < 3u; i++) {
    let r2 = add2(hi[i], lo[i], mv[i]);
    hi[i] = r2.x;
    lo[i] = r2.y;
  }
  // inside the root's footprint, below a ceiling
  let n0 = f32(u.lv[0].z);
  if (hi.x < 1.0 || hi.x > n0 - 1.0) { hi.x = clamp(hi.x, 1.0, n0 - 1.0); lo.x = 0.0; }
  if (hi.y < 1.0 || hi.y > n0 - 1.0) { hi.y = clamp(hi.y, 1.0, n0 - 1.0); lo.y = 0.0; }
  if (hi.z > 600.0) { hi.z = 600.0; lo.z = 0.0; }
  for (var i = 0u; i < 3u; i++) {
    cam[20u + i] = hi[i];
    cam[24u + i] = lo[i];
  }
  let dn = max(margin, d - length(mv));
  cam[28] = dn;
  cam[30] = f32(used);
  cam[31] = margin;
  let f = viewDir(yaw, pitch);
  let r = normalize(cross(f, vec3<f32>(0.0, 0.0, 1.0)));
  let up = cross(r, f);
  // the near plane: a tenth of the margin the eye keeps from solid (a thirtieth of the finest column), not half the
  // measured nearest distance: that distance can be overestimated (NS-36: 5.5 reported with a surface 1.4 away), and
  // then the near plane cut the surface in front of the eye away (61,000 hole pixels in one pose of the screen check).
  // Reverse Z with an infinite far plane keeps the depth precise with a near plane this small.
  let near = min(0.5 * dn, 0.1 * margin);
  cam[2] = hi.z + lo.z;
  cam[3] = near;
  for (var i = 0u; i < 3u; i++) {
    cam[4u + i] = r[i];
    cam[8u + i] = up[i];
    cam[12u + i] = f[i];
  }
  let fy = 1.0 / tan(fovy * 0.5);
  for (var m = 0u; m < live; m++) {
    let s = kpow(m);
    let w = u.lv[m];
    let e = eyeLocal(m, hi, lo).xyz;
    let view = mat4x4<f32>(vec4<f32>(r.x, up.x, -f.x, 0.0), vec4<f32>(r.y, up.y, -f.y, 0.0), vec4<f32>(r.z, up.z, -f.z, 0.0), vec4<f32>(-dot(r, e), -dot(up, e), dot(f, e), 1.0));
    let proj = mat4x4<f32>(vec4<f32>(fy / aspect, 0.0, 0.0, 0.0), vec4<f32>(0.0, fy, 0.0, 0.0), vec4<f32>(0.0, 0.0, 0.0, -1.0), vec4<f32>(0.0, 0.0, near * s, 0.0));
    let vp = proj * view;
    let b = 32u + m * 24u;
    for (var c = 0u; c < 4u; c++) {
      for (var rr = 0u; rr < 4u; rr++) { cam[b + c * 4u + rr] = vp[c][rr]; }
    }
    cam[b + 16u] = e.x;
    cam[b + 17u] = e.y;
    cam[b + 18u] = e.z;
    cam[b + 19u] = near * s;
  }
  // the centre ray's first solid (the pan's and the zoom's scale)
  // (every frame, one thread: a short march, steps growing 3 % of the distance; a scale, not a pick)
  let h = rayFirst(f, 160, 0.03);
  cam[29] = select(-1.0, h.t / kpow(u32(max(h.lvl, 0))), h.lvl >= 0);
}

struct Hit {
  lvl: i32,
  p: vec3<f32>,
  t: f32,
}
/** a ray from the eye (this frame's camera words): marched over each level, finest first, kept on the first level whose
 *  interior (away from its rim band) it lands in; lvl -1: none */
fn rayFirst(dir: vec3<f32>, steps: i32, grow: f32) -> Hit {
  let k = f32(u.a.x);
  let live = u.r.w;
  for (var mi = i32(live) - 1; mi >= 0; mi--) {
    let m = u32(mi);
    let b = 32u + m * 24u;
    let e = vec3<f32>(cam[b + 16u], cam[b + 17u], cam[b + 18u]);
    let n = f32(u.lv[m].z);
    let margin = select(k, 0.0, m == 0u);
    // the first solid along the ray, against every interval (a tunnel's wall or ceiling from inside it)
    var t = cam[b + 19u];
    var tp = t;
    var hit = false;
    let tmax = 4.0 * n;
    for (var it = 0; it < steps; it++) {
      let p = e + dir * t;
      let dz = solidDist(m, p);
      if (dz < 0.0) {
        hit = true;
        break;
      }
      tp = t;
      t += max(min(0.4 * dz, 0.5 * n), max(grow * t, 0.01));
      if (t > tmax) { break; }
    }
    if (!hit) { continue; }
    var lo = tp;
    var hi = t;
    for (var q = 0; q < 20; q++) {
      let mid = 0.5 * (lo + hi);
      if (solidDist(m, e + dir * mid) < 0.0) { hi = mid; } else { lo = mid; }
    }
    let p = e + dir * hi;
    if (p.x < margin || p.y < margin || p.x > n - margin || p.y > n - margin) { continue; }
    return Hit(mi, p, hi);
  }
  return Hit(-1, vec3<f32>(0.0), -1.0);
}

/** the pointer's hit (reg 8-10, 13) */
@compute @workgroup_size(1)
fn pick() {
  let th = tan(u.cC.x * 0.5);
  let r = vec3<f32>(cam[4], cam[5], cam[6]);
  let up = vec3<f32>(cam[8], cam[9], cam[10]);
  let f = vec3<f32>(cam[12], cam[13], cam[14]);
  let h = rayFirst(normalize(f + r * u.cC.y * th * u.cB.z + up * u.cC.z * th), 1200, 0.001);
  reg[8] = h.lvl;
  if (h.lvl < 0) { return; }
  reg[9] = bitcast<i32>(h.p.x);
  reg[10] = bitcast<i32>(h.p.y);
  reg[13] = bitcast<i32>(h.p.z);
}

// ---- the baked draw: the gap table and the mesh items, baked where columns changed ------------------------------------
// (docs/design/NESTED_SCALES.md "The baked draw"; store.wgsl holds the page layouts.) The owner's rule: "deforming
// vertices and baking the seam mesh, nothing per frame". Each op that changes a level's columns (root, promote, slide,
// edit: the edited, restricted and derived regions) bakes that region grown by one chunk: gapsBake writes each
// column's air regions with their normals, meshBake the draw-B items of the quads there, dirBuild the list of mesh pages
// the draw instances over. A frame with no change draws the baked buffers and reads nothing else of them.
@group(0) @binding(8) var<storage, read_write> dir: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> dargs: array<u32>;

fn setRec(lid: u32, X: i32, Y: i32, i: u32, a: u32, b: u32, c: u32) {
  let p = pageOf(lid, X >> 4, Y >> 4, i / K);
  if (p >= NOT_LOADED) { return; }
  let o = p * PW + 256u + (colIn(X, Y) * K + (i % K)) * RW;
  pgStore(o, a);
  pgStore(o + 1u, b);
  pgStore(o + 2u, c);
}
// The bakes read the columns of their chunk and its eight neighbours over and over: the cz 0 pages of those nine
// chunks (the level's and its gap table's) are looked up once a workgroup, not a hashed table probe a read.
// (and the parent's: the chunk under this one's centre and its neighbours, for the rim morph's targets)
var<workgroup> wCache: array<u32, 36>;
var<private> cOrg: vec2<i32>;
var<private> pOrg: vec2<i32>;
var<private> cOn: bool;
/** (every thread of the workgroup, uniform control flow) the cache over chunk (cx, cy) and its neighbours */
fn cacheFill(L: u32, cx: i32, cy: i32, li: u32) {
  let k = i32(u.a.x);
  let pc = vec2<i32>(((cx * 16 + 8) / k) >> 4, ((cy * 16 + 8) / k) >> 4);
  if (li < 36u) {
    let j = li % 9u;
    let q = li / 9u; // 0 the level, 1 its gap table, 2 the parent, 3 the parent's gap table
    var o = vec2<i32>(cx, cy);
    if (q >= 2u) { o = pc; }
    var lid = L + select(0u, GAP_ID, (q & 1u) == 1u);
    if (q >= 2u) { lid = lid - 1u; }
    wCache[li] = NONE;
    if (q < 2u || L > 0u) { wCache[li] = pageOf(lid, o.x - 1 + i32(j % 3u), o.y - 1 + i32(j / 3u), 0u); }
  }
  workgroupBarrier();
  cOrg = vec2<i32>(cx - 1, cy - 1);
  pOrg = pc - 1;
  cOn = true;
}
/** a column's cz 0 page of level id lid (the cache where it holds it) */
fn cPage(lid: u32, X: i32, Y: i32) -> u32 {
  let L = u.a.w;
  if (cOn) {
    var q = 4u;
    if (lid == L) { q = 0u; } else if (lid == GAP_ID + L) { q = 1u; } else if (L > 0u && lid == L - 1u) { q = 2u; } else if (L > 0u && lid == GAP_ID + L - 1u) { q = 3u; }
    if (q < 4u) {
      let c = vec2<i32>(X >> 4, Y >> 4) - select(cOrg, pOrg, q >= 2u);
      if (c.x >= 0 && c.y >= 0 && c.x < 3 && c.y < 3) { return wCache[q * 9u + u32(c.y * 3 + c.x)]; }
    }
  }
  return pageOf(lid, X >> 4, Y >> 4, 0u);
}
fn cCount(lid: u32, X: i32, Y: i32) -> u32 {
  let p = cPage(lid, X, Y);
  if (p >= NOT_LOADED) { return 0u; }
  let m = pgLoad(p * PW + colIn(X, Y));
  if (m < K) { return m; }
  return colCount(lid, X, Y);
}
fn cIvl(lid: u32, X: i32, Y: i32, i: u32) -> Ivl {
  if (i >= K) { return ivlAt(lid, X, Y, i); }
  let p = cPage(lid, X, Y);
  if (p >= NOT_LOADED) { return Ivl(OPEN_BOTTOM, OPEN_BOTTOM, 0u, E_FAR_W); }
  return pgIvl(p, colIn(X, Y), i);
}

// Footprints: the solid runs walk the PRESENT intervals (a ghost interval is air); between two present intervals a < b
// there is air when one of the slabs between them is air and not thinner than GAP_MIN (a present gap, or a ghost
// interval); a ghost gap is solid.
/** the next present interval below interval i (interval 0 always is) */
fn prevSolid(L: u32, X: i32, Y: i32, i: i32) -> i32 {
  var j = i - 1;
  loop {
    if (j <= 0) { return 0; }
    if (present(eS(cIvl(L, X, Y, u32(j))))) { return j; }
    j--;
  }
}
/** air (GAP_MIN or more) between present intervals a < b */
fn airBetween(L: u32, X: i32, Y: i32, a: i32, b: i32) -> bool {
  for (var q = a + 1; q <= b; q++) {
    let iv = cIvl(L, X, Y, u32(q));
    if (present(eG(iv)) && iv.z0 > cIvl(L, X, Y, u32(q - 1)).z1 + GAP_MIN) { return true; }
    if (q < b && iv.z1 - iv.z0 > GAP_MIN) { return true; }
  }
  return false;
}
/** the top present interval */
fn topSolid(L: u32, X: i32, Y: i32, n: u32) -> i32 {
  var i = i32(n) - 1;
  loop {
    if (i <= 0 || present(eS(cIvl(L, X, Y, u32(i))))) { return max(i, 0); }
    i--;
  }
}
/** a column's gap g from its intervals (gap 0 the sky above the top, then the air between solid runs; gaps under
 *  GAP_MIN merged into the solid), normals not set */
fn gapAtI(L: u32, X: i32, Y: i32, g: u32) -> Gap {
  let n = cCount(L, X, Y);
  var out = Gap(0.0, 0.0, 0u, 0u, 0.0, vec2<f32>(0.0), vec2<f32>(0.0), false);
  if (n == 0u) { return out; }
  var cur = 0u;
  var ceil = 1e30;
  var cm = 0u;
  var i = topSolid(L, X, Y, n);
  loop {
    let top = cIvl(L, X, Y, u32(i));
    var j = i;
    loop {
      if (j == 0) { break; }
      let pj = prevSolid(L, X, Y, j);
      if (airBetween(L, X, Y, pj, j)) { break; }
      j = pj;
    }
    let bot = cIvl(L, X, Y, u32(j));
    if (cur == g) { return Gap(top.z1, ceil, top.m, cm, max(bot.z0, top.z1 - 1000.0), vec2<f32>(0.0), vec2<f32>(0.0), true); }
    if (j == 0) { return out; }
    ceil = bot.z0;
    cm = bot.m;
    cur++;
    i = prevSolid(L, X, Y, j);
  }
}
fn gapCountI(L: u32, X: i32, Y: i32) -> u32 {
  let n = cCount(L, X, Y);
  if (n == 0u) { return 0u; }
  var c = 1u;
  var j = topSolid(L, X, Y, n);
  loop {
    if (j == 0) { break; }
    let pj = prevSolid(L, X, Y, j);
    if (airBetween(L, X, Y, pj, j)) { c++; }
    j = pj;
  }
  return c;
}
fn sAtC(L: u32, X: i32, Y: i32) -> f32 {
  let q = clampTo(L, X, Y);
  let n = cCount(L, q.x, q.y);
  if (n == 0u) { return 0.0; }
  return cIvl(L, q.x, q.y, u32(topSolid(L, q.x, q.y, n))).z1;
}
/** the top sheet's normal (the draw's nrmAt: central differences of the top surface, clamped to the window) */
fn sheetN(L: u32, X: i32, Y: i32) -> vec3<f32> {
  return normalize(vec3<f32>(-(sAtC(L, X + 1, Y) - sAtC(L, X - 1, Y)) * 0.5, -(sAtC(L, X, Y + 1) - sAtC(L, X, Y - 1)) * 0.5, 1.0));
}
/** a column's gap g: the baked table where its chunk has one, else (one gap) the sky from its intervals */
fn gapOf(L: u32, X: i32, Y: i32, g: u32) -> Gap {
  if (cPage(GAP_ID + L, X, Y) < NOT_LOADED) { return gRecC(L, X, Y, g); }
  // one gap: the sky over the column's whole solid run (no gap inside it by GAP_MIN, so its bottom is the first
  // interval's)
  let n = cCount(L, X, Y);
  if (n == 0u) { return Gap(0.0, 0.0, 0u, 0u, 0.0, vec2<f32>(0.0), vec2<f32>(0.0), false); }
  let top = cIvl(L, X, Y, u32(topSolid(L, X, Y, n)));
  return Gap(top.z1, 1e30, top.m, 0u, max(cIvl(L, X, Y, 0u).z0, top.z1 - 1000.0), sheetN(L, X, Y).xy, vec2<f32>(0.0), true);
}
fn gCountW(L: u32, X: i32, Y: i32) -> u32 {
  if (!inWin(L, X, Y)) { return 0u; }
  if (cPage(GAP_ID + L, X, Y) < NOT_LOADED) { return cCount(GAP_ID + L, X, Y) / GREC; }
  return select(0u, 1u, cCount(L, X, Y) > 0u);
}
/** gap g's records from the cached page (store.wgsl gRec when they reach past it) */
fn gRecC(L: u32, X: i32, Y: i32, g: u32) -> Gap {
  let i = GREC * g;
  if (i + 2u >= K) { return gRec(L, X, Y, g); }
  let p = cPage(GAP_ID + L, X, Y);
  let b = p * PW + 256u + (colIn(X, Y) * K + i) * RW;
  let m = pgLoad(b + 2u);
  return Gap(bitcast<f32>(pgLoad(b)), bitcast<f32>(pgLoad(b + 1u)), m & 0xffu, (m >> 8u) & 0xffu, bitcast<f32>(pgLoad(b + RW)), unpack2x16snorm(pgLoad(b + RW + 1u)), unpack2x16snorm(pgLoad(b + RW + 2u)), true);
}
// Neighbouring columns' gaps correspond when each is the other's nearest-floor gap among those overlapping it in z
// (mutual nearest): the ground outside an overhang meets the floor under it, not its roof; a tunnel's air meets no air
// in a solid neighbour. The I forms read intervals (the gap bake), the R forms the baked table (the mesh bake).
/** the gap of column (X, Y) nearest by floor among those overlapping (f, c), and its floor and ceiling: one walk down
 *  the intervals (few call sites: the D3D11 compiler inlines every call) */
struct Near {
  g: i32,
  f: f32,
  c: f32,
}
fn nearestGapI(L: u32, X: i32, Y: i32, f: f32, c: f32) -> Near {
  var out = Near(-1, 0.0, 0.0);
  var bd = 1e30;
  let n = cCount(L, X, Y);
  if (n == 0u) { return out; }
  var g = 0;
  var ceil = 1e30;
  var i = topSolid(L, X, Y, n);
  loop {
    let fl = cIvl(L, X, Y, u32(i)).z1;
    var j = i;
    loop {
      if (j == 0) { break; }
      let pj = prevSolid(L, X, Y, j);
      if (airBetween(L, X, Y, pj, j)) { break; }
      j = pj;
    }
    if (fl < c && f < ceil && abs(fl - f) < bd) {
      bd = abs(fl - f);
      out = Near(g, fl, ceil);
    }
    if (j == 0) { break; }
    ceil = cIvl(L, X, Y, u32(j)).z0;
    g++;
    i = prevSolid(L, X, Y, j);
  }
  return out;
}
/** gap g of column a (floor f, ceiling c): the corresponding gap of column b (mutual nearest floor), and its bounds */
fn mutualI(L: u32, a: vec2<i32>, g: u32, f: f32, c: f32, b: vec2<i32>) -> Near {
  let none = Near(-1, 0.0, 0.0);
  if (!inWin(L, b.x, b.y)) { return none; }
  let H = nearestGapI(L, b.x, b.y, f, c);
  if (H.g < 0) { return none; }
  if (nearestGapI(L, a.x, a.y, H.f, H.c).g != i32(g)) { return none; }
  return H;
}
fn nearestGapR(L: u32, X: i32, Y: i32, f: f32, c: f32) -> i32 {
  var best = -1;
  var bd = 1e30;
  let gc = gCountW(L, X, Y);
  for (var g = 0u; g < gc; g++) {
    let h = gapOf(L, X, Y, g);
    if (h.f < c && f < h.c && abs(h.f - f) < bd) {
      bd = abs(h.f - f);
      best = i32(g);
    }
  }
  return best;
}
/** the six neighbour offsets a triangle's edges use: +x, +y, +x+y, -x, -y, -x-y (direction d + 3 is d's opposite) */
fn dirOff(d: u32) -> vec2<i32> {
  var t = array<vec2<i32>, 3>(vec2<i32>(1, 0), vec2<i32>(0, 1), vec2<i32>(1, 1));
  let o = t[d % 3u];
  return select(o, -o, d >= 3u);
}
fn dirOf(o: vec2<i32>) -> u32 {
  let s = select(0u, 3u, o.x < 0 || o.y < 0);
  let a = abs(o);
  return s + select(select(2u, 1u, a.x == 0), 0u, a.y == 0);
}
/** a one-sided or central difference */
fn diff1(own: f32, lo: f32, hasLo: bool, hi: f32, hasHi: bool) -> f32 {
  if (hasLo && hasHi) { return 0.5 * (hi - lo); }
  if (hasHi) { return hi - own; }
  if (hasLo) { return own - lo; }
  return 0.0;
}

/** (over a slot's chunks) a chunk's gap table: written where some column has more than one gap, let go elsewhere */
@compute @workgroup_size(16, 16)
fn gapsBake(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  cacheFill(L, cx, cy, li);
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  if (li == 0u) {
    atomicStore(&wmax, 0u);
    atomicStore(&wany, 0u);
  }
  workgroupBarrier();
  let G = gapCountI(L, X, Y);
  atomicMax(&wmax, G);
  // a table where some column, or a neighbour of one, has more than one gap: the top sheet beside an overhang takes
  // its normal from the table (the floor its neighbours' matching gaps continue), not from the top surface's steps
  var near = G > 1u;
  for (var d = 0u; d < 6u; d++) {
    let b = vec2<i32>(X, Y) + dirOff(d);
    if (d % 3u != 2u && inWin(L, b.x, b.y) && gapCountI(L, b.x, b.y) > 1u) { near = true; }
  }
  if (near) { atomicOr(&wany, 1u); }
  let mg = workgroupUniformLoad(&wmax);
  let anyNear = workgroupUniformLoad(&wany);
  let need = select(0u, (GREC * mg + K - 1u) / K, anyNear != 0u);
  if (li == 0u) { ensurePages(GAP_ID + L, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (need == 0u) { return; }
  setCount(GAP_ID + L, X, Y, GREC * G, need);
  let C = vec2<i32>(X, Y);
  let sn = sheetN(L, X, Y).xy;
  for (var g = 0u; g < G; g++) {
    let a = gapAtI(L, X, Y, g);
    // the six links (the normals' neighbours among them: +-x, +-y), one matching call site
    var lk = array<u32, 3>(0u, 0u, 0u);
    var zf = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var zc = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var hf = array<bool, 6>(false, false, false, false, false, false);
    var hc = array<bool, 6>(false, false, false, false, false, false);
    for (var d = 0u; d < 6u; d++) {
      let H = mutualI(L, C, g, a.f, a.c, C + dirOff(d));
      lk[d / 2u] |= (select(0xffffu, u32(H.g), H.g >= 0) & 0xffffu) << (16u * (d % 2u));
      hf[d] = H.g >= 0;
      hc[d] = H.g >= 0 && H.c < 1e29;
      zf[d] = H.f;
      zc[d] = H.c;
    }
    var nF = sn;
    if (G > 1u || near) { nF = normalize(vec3<f32>(-diff1(a.f, zf[3], hf[3], zf[0], hf[0]), -diff1(a.f, zf[4], hf[4], zf[1], hf[1]), 1.0)).xy; }
    var nC = vec2<f32>(0.0, 0.0);
    if (a.c < 1e29) { nC = normalize(vec3<f32>(diff1(a.c, zc[3], hc[3], zc[0], hc[0]), diff1(a.c, zc[4], hc[4], zc[1], hc[1]), -1.0)).xy; }
    setRec(GAP_ID + L, X, Y, GREC * g, bitcast<u32>(a.f), bitcast<u32>(a.c), a.fm | (a.cm << 8u));
    setRec(GAP_ID + L, X, Y, GREC * g + 1u, bitcast<u32>(a.rb), pack2x16snorm(nF), pack2x16snorm(nC));
    setRec(GAP_ID + L, X, Y, GREC * g + 2u, lk[0], lk[1], lk[2]);
  }
}

// ---- mesh items: per triangle of a quad with a corner of more than one gap, per region (connected air across the
// triangle's corners), one item: each corner's gap (or none), its bounds and normals, and the parent's matching bounds
// and presence at that corner for the rim morph. The draw cuts and walls it in the vertex stage (draw.wgsl vsB).
var<private> mC: array<vec2<i32>, 3>;
var<private> mG: array<u32, 3>;
/** per corner of the triangle: its chunk's gap page (cz 0, or NONE) */
var<private> mPg: array<u32, 3>;
/** corner r's gap g: its baked link in direction d */
fn linkAt(r: u32, g: u32, d: u32) -> i32 {
  let i = GREC * g + 2u;
  var p = mPg[r];
  if (i >= K) { p = pageOf(GAP_ID + u.a.w, mC[r].x >> 4, mC[r].y >> 4, i / K); }
  if (p >= NOT_LOADED) { return -1; }
  let v = (pgLoad(p * PW + 256u + (colIn(mC[r].x, mC[r].y) * K + (i % K)) * RW + d / 2u) >> (16u * (d % 2u))) & 0xffffu;
  return select(i32(v), -1, v == 0xffffu);
}
/** corner r's gap g: the corresponding gap at corner s, from the baked links: r's own link where its chunk has a gap
 *  table; else (one gap at r) s's gap whose link back is gap 0; else (one gap each) the skies meet */
fn mm(r: u32, s: u32, g: i32) -> i32 {
  if (g < 0 || mG[s] == 0u) { return -1; }
  let d = dirOf(mC[s] - mC[r]);
  if (mPg[r] < NOT_LOADED) { return linkAt(r, u32(g), d); }
  if (mPg[s] >= NOT_LOADED) { return 0; }
  let back = (d + 3u) % 6u;
  for (var h = 0u; h < mG[s]; h++) {
    if (linkAt(s, h, back) == 0) { return i32(h); }
  }
  return -1;
}
/** the region seeded by corner 0's gap g: its gap at corners 1 and 2 (direct, else through the third corner when that
 *  gap is no other corner-0 gap's) */
fn comp0(g: i32) -> vec3<i32> {
  var a1 = mm(0u, 1u, g);
  var a2 = mm(0u, 2u, g);
  if (a2 < 0 && a1 >= 0) {
    let b = mm(1u, 2u, a1);
    if (b >= 0 && mm(2u, 0u, b) < 0) { a2 = b; }
  }
  if (a1 < 0 && a2 >= 0) {
    let b = mm(2u, 1u, a2);
    if (b >= 0 && mm(1u, 0u, b) < 0) { a1 = b; }
  }
  return vec3<i32>(g, a1, a2);
}
/** whether corner r's gap x belongs to a region seeded at corner 0 (directly, or through the third corner as comp0
 *  takes it) */
fn in0(r: u32, x: i32) -> bool {
  let o = 3u - r; // the third corner
  if (mm(r, 0u, x) >= 0) { return true; }
  let b = mm(r, o, x);
  if (b < 0) { return false; }
  let g = mm(o, 0u, b);
  return g >= 0 && mm(0u, r, g) < 0;
}
fn comp1(h: i32) -> vec3<i32> {
  var a2 = mm(1u, 2u, h);
  if (a2 >= 0 && in0(2u, a2)) { a2 = -1; }
  return vec3<i32>(-1, h, a2);
}
/** whether corner 2's gap x (in no corner-0 region) belongs to a region seeded at corner 1 */
fn in1(x: i32) -> bool {
  let h = mm(2u, 1u, x);
  return h >= 0 && !in0(1u, h);
}
/** the parent's triangle at a child column's centre (the top sheet's morph): corner (i0, j0) and the weights */
struct PTri {
  i0: i32,
  j0: i32,
  w: vec4<f32>,
}
fn parentTri(X: i32, Y: i32) -> PTri {
  let k = f32(u.a.x);
  let ux = (f32(X) + 0.5) / k - 0.5;
  let uy = (f32(Y) + 0.5) / k - 0.5;
  let i0 = i32(floor(ux));
  let j0 = i32(floor(uy));
  let fu = ux - f32(i0);
  let fv = uy - f32(j0);
  var wts = vec4<f32>(0.0);
  if (fu >= fv) { wts = vec4<f32>(1.0 - fu, fu - fv, 0.0, fv); } else { wts = vec4<f32>(1.0 - fv, 0.0, fv - fu, fu); }
  return PTri(i0, j0, wts);
}
/** the parent's bound matching a child gap (child units): over the parent triangle, each corner's gap overlapping the
 *  child's, its floor or ceiling; a corner with none takes `own` */
/** the parent's bounds matching a child gap (floor gf, ceiling gc; child units) over the parent triangle: each corner's
 *  gap overlapping the child's gives its floor and ceiling (a corner with none, or no finite ceiling: the child's
 *  own); z the parent's presence of the gap (its corners' indicator interpolated) */
fn parentQ(L: u32, T: PTri, gf: f32, gc: f32) -> vec3<f32> {
  let k = f32(u.a.x);
  let P = L - 1u;
  let z0 = zOrigin(L);
  let pf = gf / k + z0;
  let pc = select(gc / k + z0, 1e30, gc > 1e29);
  var out = vec3<f32>(0.0);
  for (var q = 0u; q < 4u; q++) {
    if (T.w[q] <= 0.0) { continue; }
    let C = clampTo(P, T.i0 + i32(q & 1u), T.j0 + i32(q >> 1u));
    let g = nearestGapR(P, C.x, C.y, pf, pc);
    var v = vec3<f32>(gf, gc, 0.0);
    if (g >= 0) {
      let G = gapOf(P, C.x, C.y, u32(g));
      v = vec3<f32>((G.f - z0) * k, select(gc, (G.c - z0) * k, G.c < 1e29), 1.0);
    }
    out += T.w[q] * v;
  }
  return out;
}
/** the parent's top sheet under a child column, child units (the top sheet's morph target, draw.wgsl vs) */
fn parentSheet(L: u32, T: PTri) -> f32 {
  let P = L - 1u;
  let ph = T.w.x * sAtC(P, T.i0, T.j0) + T.w.y * sAtC(P, T.i0 + 1, T.j0) + T.w.z * sAtC(P, T.i0, T.j0 + 1) + T.w.w * sAtC(P, T.i0 + 1, T.j0 + 1);
  return (ph - zOrigin(L)) * f32(u.a.x);
}
var<private> mChunk: vec2<i32>;
/** one region's item, written at slot i of the chunk's mesh pages */
fn writeItem(L: u32, cmp: vec3<i32>, i: u32, lx: u32, ly: u32, t: u32, birth: u32) {
  let p = pageOf(MESH_ID + L, mChunk.x, mChunk.y, i / IPP);
  if (p >= NOT_LOADED) { return; }
  let b = p * PW + MESH_HDR + (i % IPP) * ITEM_W;
  var r0 = 0u;
  if (cmp.x < 0) { r0 = select(2u, 1u, cmp.y >= 0); }
  var gs: array<Gap, 3>;
  var enclosed = true;
  for (var r = 0u; r < 3u; r++) {
    gs[r] = gapOf(L, mC[r].x, mC[r].y, u32(max(cmp[r], 0)));
    if (cmp[r] >= 0 && gs[r].c > 1e29) { enclosed = false; }
  }
  let rep = gs[r0];
  pgStore(b, lx | (ly << 4u) | (t << 8u) | (select(0u, 1u, enclosed) << 9u));
  pgStore(b + 1u, birth);
  for (var r = 0u; r < 3u; r++) {
    let pres = cmp[r] >= 0;
    var G = rep;
    if (pres) { G = gs[r]; }
    var pf = G.f;
    var pc = G.c;
    var x8 = select(0.0, 1.0, pres);
    if (!enclosed) { x8 = G.rb; }
    if (L > 0u) {
      let T = parentTri(mC[r].x, mC[r].y);
      // query 0: this gap's bounds; query 1: (enclosed) the region's presence, or (the sky) the parent's ceiling of
      // the gap below, which the sky's wall bottom (its solid run's) follows
      var below = false;
      var Gb = G;
      if (!enclosed && pres && u32(cmp[r]) + 1u < gCount(L, mC[r].x, mC[r].y)) {
        Gb = gapOf(L, mC[r].x, mC[r].y, u32(cmp[r]) + 1u);
        below = true;
      }
      x8 = G.rb;
      for (var qi = 0u; qi < 2u; qi++) {
        var qf = G.f;
        var qc = G.c;
        if (qi == 1u) {
          if (enclosed) {
            qf = rep.f;
            qc = rep.c;
          } else {
            qf = Gb.f;
            qc = Gb.c;
          }
        }
        let Q = parentQ(L, T, qf, qc);
        if (qi == 0u) {
          pf = Q.x;
          pc = Q.y;
        } else if (enclosed) {
          x8 = Q.z;
        } else if (below) {
          x8 = Q.y;
        }
      }
      if (pres && cmp[r] == 0) { pf = parentSheet(L, T); }
      if (!enclosed && !below) { x8 = G.rb + (pf - G.f); }
    }
    let o = b + 2u + r * 9u;
    pgStore(o, bitcast<u32>(G.f));
    pgStore(o + 1u, bitcast<u32>(G.c));
    pgStore(o + 2u, bitcast<u32>(G.rb));
    pgStore(o + 3u, G.fm | (G.cm << 8u) | (select(0u, 1u, pres) << 16u));
    pgStore(o + 4u, pack2x16snorm(G.nF));
    pgStore(o + 5u, pack2x16snorm(G.nC));
    pgStore(o + 6u, bitcast<u32>(pf));
    pgStore(o + 7u, bitcast<u32>(pc));
    pgStore(o + 8u, bitcast<u32>(x8));
  }
}
/** a quad's regions, both triangles: counted, or written from slot `at` (returns the count). Every region is seeded at
 *  the first corner (0, 1, 2) that has it; one loop and one write site (the D3D11 compiler inlines every call). */
fn quadItems(L: u32, base: vec2<i32>, write: bool, at: u32, lx: u32, ly: u32, birth: u32) -> u32 {
  var n = 0u;
  for (var t = 0u; t < 2u; t++) {
    // (the diagonal from (i, j) to (i + 1, j + 1), as the top sheet's index buffer)
    var tc = array<u32, 3>(0u, 1u, 3u);
    if (t == 1u) { tc = array<u32, 3>(0u, 3u, 2u); }
    var multi = false;
    for (var r = 0u; r < 3u; r++) {
      mC[r] = base + vec2<i32>(i32(tc[r] & 1u), i32(tc[r] >> 1u));
      mPg[r] = cPage(GAP_ID + L, mC[r].x, mC[r].y);
      var c = 0u;
      if (inWin(L, mC[r].x, mC[r].y)) {
        if (mPg[r] < NOT_LOADED) { c = cCount(GAP_ID + L, mC[r].x, mC[r].y) / GREC; } else { c = 1u; }
      }
      mG[r] = c;
      if (c > 1u) { multi = true; }
    }
    if (!multi) { continue; }
    for (var r = 0u; r < 3u; r++) {
      for (var x = 0; x < i32(mG[r]); x++) {
        var cmp = vec3<i32>(-1, -1, x);
        if (r == 0u) {
          cmp = comp0(x);
        } else {
          if (in0(r, x)) { continue; }
          if (r == 1u) { cmp = comp1(x); } else if (in1(x)) { continue; }
        }
        if (write) { writeItem(L, cmp, at + n, lx, ly, t, birth); }
        n++;
      }
    }
  }
  return n;
}

/** (over a slot's chunks) a chunk's mesh items: the quads whose (i, j) corner is in it */
@compute @workgroup_size(16, 16)
fn meshBake(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  cacheFill(L, cx, cy, li);
  let base = vec2<i32>(cx * 16 + i32(lid.x), cy * 16 + i32(lid.y));
  let ok = inWin(L, base.x + 1, base.y + 1);
  if (li == 0u) {
    atomicStore(&wmax, 0u);
    atomicStore(&wany, 0u);
  }
  workgroupBarrier();
  mChunk = vec2<i32>(cx, cy);
  let s = tFind(tKey0(cx, cy), tKey1(L, 0u));
  var birth = 0u;
  if (s != NONE) { birth = atomicLoad(&tab[s * 4u + 3u]); }
  // pass 0 counts the quad's items; then the chunk's pages are sized; pass 1 writes them (one call site)
  var n = 0u;
  var at = 0u;
  for (var ps = 0u; ps < 2u; ps++) {
    if (ps == 1u) {
      atomicAdd(&wmax, n);
      let total = workgroupUniformLoad(&wmax);
      let need = (total + IPP - 1u) / IPP;
      if (li == 0u) {
        ensurePages(MESH_ID + L, cx, cy, need, u.d.x);
        for (var cz = 0u; cz < need; cz++) {
          let p = pageOf(MESH_ID + L, cx, cy, cz);
          if (p < NOT_LOADED) { pgStore(p * PW, min(IPP, total - cz * IPP)); }
        }
      }
      storageBarrier();
      workgroupBarrier();
      at = atomicAdd(&wany, n);
    }
    if (ok && (ps == 0u || n > 0u)) { n = quadItems(L, base, ps == 1u, at, lid.x, lid.y, birth); }
  }
}

/** the draw's list of mesh pages: dir[L] their count, entries (page, chunk key) from 16 + (L * cap + i) * 2 */
@compute @workgroup_size(1)
fn dirClear() {
  for (var L = 0u; L < 8u; L++) { atomicStore(&dir[L], 0u); }
}
@compute @workgroup_size(64)
fn dirBuild(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 >= BUSY) { return; }
  let lid = k1 & 0xffu;
  if (lid < MESH_ID || lid >= MESH_ID + 8u) { return; }
  let L = lid - MESH_ID;
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p >= NOT_LOADED || pgLoad(p * PW) == 0u) { return; }
  let i = atomicAdd(&dir[L], 1u);
  let e = 16u + (L * u.r.y + i) * 2u;
  atomicStore(&dir[e], p);
  atomicStore(&dir[e + 1u], atomicLoad(&tab[s * 4u]));
}
/** draw B's indirect arguments a level: 18 vertices, an instance per item slot of its mesh pages */
@compute @workgroup_size(1)
fn dirFinish() {
  for (var L = 0u; L < 8u; L++) {
    dargs[L * 4u] = 18u;
    dargs[L * 4u + 1u] = atomicLoad(&dir[L]) * IPP;
    dargs[L * 4u + 2u] = 0u;
    dargs[L * 4u + 3u] = 0u;
  }
}
/** a bake slot (u.e.y) from a region slot (u.e.x): its chunks grown by one each way, within level u.a.w's window */
@compute @workgroup_size(1)
fn dilate() {
  let L = u.a.w;
  let s = u32(u.e.x);
  let t = u32(u.e.y);
  let nx = i32(args[s * 4u]);
  let ny = i32(args[s * 4u + 1u]);
  let w = u.lv[L];
  if (nx <= 0 || ny <= 0 || w.z == 0) {
    setSlot(t, vec4<i32>(0), 0, 0, 0, 0);
    return;
  }
  let ox = slotW(s, 4u);
  let oy = slotW(s, 5u);
  let x0 = max(ox - 1, w.x / 16);
  let y0 = max(oy - 1, w.y / 16);
  let x1 = min(ox + nx + 1, (w.x + w.z) / 16);
  let y1 = min(oy + ny + 1, (w.y + w.z) / 16);
  setSlot(t, vec4<i32>(-(1 << 30), -(1 << 30), 1 << 30, 1 << 30), x0, y0, x1 - x0, y1 - y0);
}
