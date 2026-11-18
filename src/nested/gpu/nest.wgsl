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

// ---- ctl: 0 end, 1 refused, 2 free count, 3 pending count, 4 mismatches, 5 table full, 6 inexact residuals, 7 max cz
//      of column and residual pages, 8 of TMP pages, 9 of face pages; free stack at
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
          // (the deepest page stack so far: ctl 8 for a pass's scratch, 9 for faces, 7 for the rest; the ops' reserves
          // use them)
          var slot = 7u;
          if (lid >= TMP_ID) { slot = 8u; } else if (lid >= FACE_ID && lid < FACE_ID + 8u) { slot = 9u; }
          atomicMax(&ctl[slot], cz);
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
fn pgSetIvl(page: u32, c: u32, i: u32, z0: f32, z1: f32, m: u32) {
  let b = page * PW + 256u + (c * K + i) * 3u;
  pgStore(b, bitcast<u32>(z0));
  pgStore(b + 1u, bitcast<u32>(z1));
  pgStore(b + 2u, m);
}
fn setIvl(lid: u32, X: i32, Y: i32, i: u32, z0: f32, z1: f32, m: u32) {
  let p = pageOf(lid, X >> 4, Y >> 4, i / K);
  if (p >= NOT_LOADED) { return; }
  pgSetIvl(p, colIn(X, Y), i % K, z0, z1, m);
}
/** a column's count written into each of its chunk's pages (cz < need; solid pages: residuals and TMP, where a written
 *  column is marked TOUCHED for pack) */
fn setCount(lid: u32, X: i32, Y: i32, n: u32, need: u32) {
  let mark = select(0u, TOUCHED, lid >= TMP_ID);
  for (var cz = 0u; cz < need; cz++) {
    let p = pageOf(lid, X >> 4, Y >> 4, cz);
    if (p >= NOT_LOADED) { continue; }
    pgStore(p * PW + colIn(X, Y), u32(clamp(i32(n) - i32(cz * K), 0, i32(K))) | mark);
  }
}
/** (a pass that changes only part of a column) its solid view copied into TMP first; the pass then edits the copy and
 *  pack writes the result back as the partition */
fn tmpCopy(L: u32, X: i32, Y: i32, n: u32, need: u32) {
  let T = TMP_ID + L;
  setCount(T, X, Y, n, need);
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(L, X, Y, i);
    setIvl(T, X, Y, i, iv.z0, iv.z1, iv.m);
  }
}

// ---- pack: TMP (the solid view a pass wrote) -> the level's partition, at the pass boundary ------------------------
// Each written column becomes records bottom up: an air record wherever an interval starts above the last top, the
// interval itself; zero or negative thicknesses are dropped and adjacent records of one material merged (so repeated adds
// cannot pile up intervals: NS-63). Then the TMP pages are let go. Dispatch over the writing pass's slot.
fn packCol(T: u32, L: u32, X: i32, Y: i32, write: bool) -> u32 {
  let n = colCount(T, X, Y);
  var r = 0u;
  var pTop = OPEN_BOTTOM;
  var pMat = 0xffffffffu;
  var have = false;
  var solids = 0u;
  for (var i = 0u; i <= n; i++) {
    var top = 0.0;
    var m = 0u;
    var air = false;
    if (i < n) {
      let iv = ivlAt(T, X, Y, i);
      if (i > 0u && !(iv.z1 > iv.z0)) { continue; }
      if (have && i > 0u && iv.z0 > pTop) {
        // the air below this interval: the pending record is flushed, the air record follows it
        if (write) { packPut(L, X, Y, r, pTop, pMat, &solids); }
        r++;
        pTop = iv.z0;
        pMat = MAT_AIR;
      }
      top = iv.z1;
      m = iv.m;
    } else {
      air = true;
    }
    if (air) { break; }
    // (an interval reaching no higher than the record below adds nothing)
    if (have && top <= pTop) { continue; }
    if (have && m == pMat) {
      pTop = max(pTop, top);
      continue;
    }
    if (have) {
      if (write) { packPut(L, X, Y, r, pTop, pMat, &solids); }
      r++;
    }
    pTop = top;
    pMat = m;
    have = true;
  }
  if (have) {
    if (write) { packPut(L, X, Y, r, pTop, pMat, &solids); }
    r++;
  }
  if (write && r > 0u) {
    // the count words: records | solids << 16 of each page; the last page written by packPut's running count
    let last = (r - 1u) / KR;
    let p = pageOf(L, X >> 4, Y >> 4, last);
    if (p < NOT_LOADED) { pgStore(p * PW + colIn(X, Y), (r - last * KR) | (solids << 16u)); }
    var cz = last + 1u;
    loop {
      let q = pageOf(L, X >> 4, Y >> 4, cz);
      if (q >= NOT_LOADED) { break; }
      pgStore(q * PW + colIn(X, Y), 0u);
      cz++;
    }
  }
  return r;
}
/** record j of a column written; a page's count word written when the next page starts */
fn packPut(L: u32, X: i32, Y: i32, j: u32, top: f32, m: u32, solids: ptr<function, u32>) {
  if (j > 0u && j % KR == 0u) {
    let pp = pageOf(L, X >> 4, Y >> 4, j / KR - 1u);
    if (pp < NOT_LOADED) { pgStore(pp * PW + colIn(X, Y), KR | (*solids << 16u)); }
    *solids = 0u;
  }
  let p = pageOf(L, X >> 4, Y >> 4, j / KR);
  if (p >= NOT_LOADED) { return; }
  let b = p * PW + 256u + (colIn(X, Y) * KR + j % KR) * 2u;
  pgStore(b, bitcast<u32>(top));
  pgStore(b + 1u, m);
  // (the count word's second half counts the solid view's intervals: every record that is not air)
  if (m != MAT_AIR) { *solids += 1u; }
}
@compute @workgroup_size(16, 16)
fn pack(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let T = TMP_ID + L;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  if (li == 0u) {
    atomicStore(&wany, select(0u, 1u, pageOf(T, cx, cy, 0u) < NOT_LOADED));
    atomicStore(&wmax, 0u);
  }
  if (workgroupUniformLoad(&wany) == 0u) { return; }
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  let p0 = pageOf(T, cx, cy, 0u);
  let touched = (pgLoad(p0 * PW + colIn(X, Y)) & TOUCHED) != 0u;
  var r = 0u;
  if (touched) { r = packCol(T, L, X, Y, false); } else { r = recCount(L, X, Y); }
  atomicMax(&wmax, r);
  let need = (workgroupUniformLoad(&wmax) + KR - 1u) / KR;
  if (li == 0u) { ensurePages(L, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (touched) { packCol(T, L, X, Y, true); }
  storageBarrier();
  workgroupBarrier();
  if (li == 0u) { ensurePages(T, cx, cy, 0u, u.d.x); }
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
/** derive: the parent's tops round the chunk ((16 / k + 4)^2, k >= 2) */
var<workgroup> wPTop: array<f32, 144>;
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
  let b = p * PW + 256u + (colIn(gX, gY) * K + rec % K) * 3u;
  return bitcast<f32>(pgLoad(b + w));
}
fn setRes(L: u32, rec: u32, v0: f32, v1: f32) {
  let p = pageOf(RES_ID + L, gX >> 4, gY >> 4, rec / K);
  if (p >= NOT_LOADED) { return; }
  pgSetIvl(p, colIn(gX, gY), rec % K, v0, v1, 0u);
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
        if (write) { setIvl(TMP_ID + L, gX, gY, i, d0, d1, ivlAt(P, gP.x, gP.y, i).m); }
        dPrev = d0;
      }
      if (gAct && !gWhole && mode == 1u) {
        let lv = ivlAt(L, gX, gY, i);
        putRes(lv.z0, e0, L, i, 0u, write);
        putRes(lv.z1, e1, L, i, 1u, write);
      }
      z = e0 - vals[1];
    }
  }
  if (gAct && !gWhole && gN > 0u) {
    if (mode == 0u && write) { setIvl(TMP_ID + L, gX, gY, 0u, OPEN_BOTTOM, min(addRes(z, L, 0u, 1u), dPrev), ivlAt(P, gP.x, gP.y, 0u).m); }
    if (mode == 1u) {
      if (write) { setRes(L, 0u, 0.0, 0.0); }
      putRes(ivlAt(L, gX, gY, 0u).z1, z, L, 0u, 1u, write);
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
fn putRes(live: f32, e: f32, L: u32, i: u32, which: u32, write: bool) { putResW(live, e, L, i, which, write, 0u); }
/** word2: 0 for a per-bound record; WHOLE | material for a whole column's */
fn putResW(live: f32, e: f32, L: u32, i: u32, which: u32, write: bool, word2: u32) {
  let hi = live - e;
  let lo = live - (e + hi);
  if (hi != 0.0 || lo != 0.0 || word2 != 0u) { atomicOr(&wany, 1u); }
  if (!write) { return; }
  if ((e + hi) + lo != live) { atomicAdd(&ctl[6], 1u); }
  let p = pageOf(RES_ID + L, gX >> 4, gY >> 4, (2u * i + which) / K);
  if (p >= NOT_LOADED) { return; }
  pgSetIvl(p, colIn(gX, gY), (2u * i + which) % K, hi, lo, word2);
}
const WHOLE: u32 = 0x80000000u;
fn resWord(L: u32, rec: u32, w: u32) -> u32 {
  let p = pageOf(RES_ID + L, gX >> 4, gY >> 4, rec / K);
  if (p >= NOT_LOADED) { return 0u; }
  return pgLoad(p * PW + 256u + (colIn(gX, gY) * K + rec % K) * 3u + w);
}
/** a live column of another structure than its enhanced parent: kept whole, bounds relative to the enhanced surface gS */
fn putWhole(L: u32, n: u32, write: bool) {
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(L, gX, gY, i);
    if (i > 0u) { putResW(iv.z0, gS, L, i, 0u, write, WHOLE | iv.m); } else { putResW(0.0, 0.0, L, 0u, 0u, write, WHOLE | iv.m); }
    putResW(iv.z1, gS, L, i, 1u, write, WHOLE | iv.m);
  }
}
/** a whole column written from its residual */
fn writeWhole(L: u32, n: u32, need: u32) {
  setCount(TMP_ID + L, gX, gY, n, need);
  for (var i = 0u; i < n; i++) {
    let z1 = (gS + bitcast<f32>(resWord(L, 2u * i + 1u, 0u))) + bitcast<f32>(resWord(L, 2u * i + 1u, 1u));
    var z0 = OPEN_BOTTOM;
    if (i > 0u) { z0 = (gS + bitcast<f32>(resWord(L, 2u * i, 0u))) + bitcast<f32>(resWord(L, 2u * i, 1u)); }
    setIvl(TMP_ID + L, gX, gY, i, z0, z1, resWord(L, 2u * i + 1u, 2u) & 0xffffu);
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
  // along y (the oracle's ppmSub): mean-preserving per block, no new extremum at a step (NS-34). The parent tops round
  // the chunk are read once a workgroup (the same values: topS of the clamped column), not 25 times a column.
  let ps = 16 / k + 4;
  let p0 = vec2<i32>(cx * 16 / k - 2, cy * 16 / k - 2);
  for (var q = li; q < u32(ps * ps); q += 256u) {
    let c = clampTo(P, p0.x + i32(q) % ps, p0.y + i32(q) / ps);
    wPTop[q] = topS(P, c.x, c.y, colCount(P, c.x, c.y));
  }
  workgroupBarrier();
  let pref = wPTop[(py - p0.y) * ps + (px - p0.x)];
  var rows = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
  for (var j = 0; j < 5; j++) {
    var q = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
    for (var i = 0; i < 5; i++) { q[i] = wPTop[(py - 2 + j - p0.y) * ps + (px - 2 + i - p0.x)] - pref; }
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
    // (written to TMP in the solid view; pack makes the partition)
    if (li == 0u) { ensurePages(TMP_ID + L, cx, cy, need, u.d.x); }
    storageBarrier();
    workgroupBarrier();
    if (gAct && !gWhole) { setCount(TMP_ID + L, gX, gY, gN, need); }
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
  // (written to TMP in the solid view; pack makes the partition)
  let T = TMP_ID + P;
  if (li == 0u) { ensurePages(T, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!act) { return; }
  setCount(T, X, Y, n, need);
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
      setIvl(T, X, Y, i, z - th * inv, z, ivlAt(L, tpl.x, tpl.y, i).m);
      z = z - th * inv - gap * inv;
    }
  } else {
    // children of different structures: the template, its thicknesses scaled per material and its gaps scaled, so
    // the parent holds the block's mean of each material and of enclosed air (the oracle's restrictCell)
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
          vm[iv.m & 7u] += iv.z1 - iv.z0;
          air += iv.z0 - ivlAt(L, c.x, c.y, i - 1u).z1;
        }
      }
    }
    for (var i = 1u; i < n; i++) {
      let iv = ivlAt(L, tpl.x, tpl.y, i);
      tm[iv.m & 7u] += iv.z1 - iv.z0;
      tair += iv.z0 - ivlAt(L, tpl.x, tpl.y, i - 1u).z1;
    }
    let kk = kf * kf;
    for (var i = max(n, 1u) - 1u; i >= 1u; i--) {
      let iv = ivlAt(L, tpl.x, tpl.y, i);
      let mi = iv.m & 7u;
      var th = 0.0;
      if (tm[mi] > 0.0) { th = (iv.z1 - iv.z0) * (vm[mi] / kk / tm[mi]) / kf; }
      var gap = 0.0;
      if (tair > 0.0) { gap = (iv.z0 - ivlAt(L, tpl.x, tpl.y, i - 1u).z1) * (air / kk / tair) / kf; }
      setIvl(T, X, Y, i, z - th, z, iv.m);
      z = z - th - gap;
    }
  }
  setIvl(T, X, Y, 0u, OPEN_BOTTOM, z, ivlAt(L, tpl.x, tpl.y, 0u).m);
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
  // (the solid view into TMP; pack makes the partition)
  let T = TMP_ID;
  if (li == 0u) { ensurePages(T, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  setCount(T, X, Y, n, need);
  if (stripe) {
    // (alternating sand and clay: no two neighbours of one material, so no records merge)
    for (var i = 0u; i < n; i++) {
      let lo = s - 4.0 + f32(i) * 0.1;
      setIvl(T, X, Y, i, select(lo, OPEN_BOTTOM, i == 0u), s - 4.0 + f32(i + 1u) * 0.1, select(MAT_SAND, MAT_CLAY, (i & 1u) == 1u));
    }
  } else {
    setIvl(T, X, Y, 0u, OPEN_BOTTOM, s - soil, MAT_STONE);
    setIvl(T, X, Y, 1u, s - soil, s, MAT_SOIL);
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
  // the level's columns, its baked faces, a stroke's snapshot and any scratch
  let lid = k1 & 0xffu;
  // (mode 7: a stroke's snapshot only, at its end)
  if (u.a.z == 7u) {
    if (lid != SNAP_ID + u.a.w) { return; }
  } else if (lid != u.a.w && lid != FACE_ID + u.a.w && lid != SNAP_ID + u.a.w && lid != TMP_ID + u.a.w) { return; }
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

// ---- the table's tombstones cleared (NS-14): every op lets TMP and other entries go, and a lookup that misses walks
// over tombstones to the next empty slot, so after many ops every miss got slower. At the end of each op the live
// entries are copied out to the scratch buffer, the table emptied, and the entries put back (two passes over TCAP).
@compute @workgroup_size(64)
fn tabOut(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  scr[s * 4u + 1u] = bitcast<f32>(select(k1, EMPTY, k1 >= BUSY || k1 == TOMB));
  scr[s * 4u] = bitcast<f32>(atomicLoad(&tab[s * 4u]));
  scr[s * 4u + 2u] = bitcast<f32>(atomicLoad(&tab[s * 4u + 2u]));
  scr[s * 4u + 3u] = bitcast<f32>(atomicLoad(&tab[s * 4u + 3u]));
  atomicStore(&tab[s * 4u + 1u], EMPTY);
}
@compute @workgroup_size(64)
fn tabIn(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = bitcast<u32>(scr[s * 4u + 1u]);
  if (k1 == EMPTY) { return; }
  tInsert(bitcast<u32>(scr[s * 4u]), k1, bitcast<u32>(scr[s * 4u + 2u]), bitcast<f32>(scr[s * 4u + 3u]));
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

// ---- the pool given back (round 7, NS-67): pages in use at or above a new cap C (u.r.y) move under it, between ops ------
// shrinkFree (one thread): the free stack keeps its ids under C (in order), the bump end is held at C, the move count
// (ctl 10) starts at 0. shrinkMove (over the table): each entry whose page is at or above C takes a page under C
// (allocPage, which pops the filtered stack, then the bump end up to C) and records the move in the scratch buffer.
// shrinkCopy (a workgroup a move): the page's words copied. Nothing else holds a page id between ops (TMP and pending
// frees are empty, a stroke is off); the draw's page list is rebuilt after.
@compute @workgroup_size(1)
fn shrinkFree() {
  let C = u.r.y;
  let n = atomicLoad(&ctl[2]);
  var j = 0u;
  for (var i = 0u; i < n; i++) {
    let p = atomicLoad(&ctl[CTL_STACK + i]);
    if (p < C) {
      atomicStore(&ctl[CTL_STACK + j], p);
      j++;
    }
  }
  atomicStore(&ctl[2], j);
  if (atomicLoad(&ctl[0]) > C) { atomicStore(&ctl[0], C); }
  atomicStore(&ctl[10], 0u);
}
@compute @workgroup_size(64)
fn shrinkMove(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 >= BUSY) { return; }
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p >= NOT_LOADED || p < u.r.y) { return; }
  let dst = allocPage();
  if (dst == NONE) { return; }
  atomicStore(&tab[s * 4u + 2u], dst);
  let i = atomicAdd(&ctl[10], 1u);
  // (u32 words parked in the f32 scratch, as the table's compaction does: NS-64)
  scr[i * 2u] = bitcast<f32>(p);
  scr[i * 2u + 1u] = bitcast<f32>(dst);
}
@compute @workgroup_size(256)
fn shrinkCopy(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = wid.x;
  if (i >= atomicLoad(&ctl[10])) { return; }
  let src = bitcast<u32>(scr[i * 2u]);
  let dst = bitcast<u32>(scr[i * 2u + 1u]);
  for (var w = li; w < PW; w += 256u) { pgStore(dst * PW + w, pgLoad(src * PW + w)); }
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
  var box = vec4<i32>(i32(floor(cxg - r)), i32(floor(cyg - r)), i32(ceil(cxg + r)) + 1, i32(ceil(cyg + r)) + 1);
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
    box = unionR(box, vec4<i32>(i32(floor(px - r)), i32(floor(py - r)), i32(ceil(px + r)) + 1, i32(ceil(py + r)) + 1));
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
fn edit(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let T = TMP_ID + L;
  let slot = slotOf(i32(L), 3);
  let o = slotOrigin(slot, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  let box = vec4<i32>(slotW(slot, 0u), slotW(slot, 1u), slotW(slot, 2u), slotW(slot, 3u));
  let p = brushW(X, Y, L);
  let n = colCount(L, X, Y);
  let act = inBox(X, Y, box) && p > 0.0 && n > 0u;
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  if (act) { atomicMax(&wmax, n); }
  let need = (workgroupUniformLoad(&wmax) + K - 1u) / K;
  if (li == 0u && need > 0u) { ensurePages(T, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!act) { return; }
  // (the column's solid view copied into TMP and moved there; pack writes it back, dropping emptied intervals)
  tmpCopy(L, X, Y, n, need);
  let a = bitcast<f32>(reg[12]) * p;
  if (u.a.z == 1u) {
    let t = ivlAt(T, X, Y, n - 1u);
    setIvl(T, X, Y, n - 1u, t.z0, t.z1 + a, t.m);
    return;
  }
  let top = ivlAt(T, X, Y, n - 1u).z1 - a;
  for (var i = n; i > 0u; i--) {
    let t = ivlAt(T, X, Y, i - 1u);
    if (t.z1 <= top) { break; }
    var z0 = t.z0;
    if (i > 1u && z0 > top) { z0 = top; }
    setIvl(T, X, Y, i - 1u, z0, top, t.m);
  }
}

// ---- carve (op 4) and add (op 5): a ball's z-span on each column (the oracle's applyBall). Carve removes solid in
// [lo, hi]: an interval it lies inside splits in two, ones inside it go. Add fills each air piece of [lo, hi] with soil
// as a new interval. Counts change, so pages are ensured per chunk first; the column is rewritten in place (top down
// when it grows, bottom up when it shrinks).
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
fn ballCount(L: u32, X: i32, Y: i32, n: u32, lo: f32, hi: f32, add: bool) -> u32 {
  var c = 0u;
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(L, X, Y, i);
    if (add) {
      c += 1u;
      if (i > 0u && max(ivlAt(L, X, Y, i - 1u).z1, lo) < min(iv.z0, hi)) { c += 1u; }
    } else if (iv.z1 > lo && iv.z0 < hi) {
      c += select(0u, 1u, iv.z0 < lo) + select(0u, 1u, iv.z1 > hi);
    } else {
      c += 1u;
    }
  }
  if (add && max(ivlAt(L, X, Y, n - 1u).z1, lo) < hi) { c += 1u; }
  return c;
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
  let sp = ballSpan(X, Y, L);
  let n = colCount(L, X, Y);
  let hit = inBox(X, Y, box) && sp.z > 0.0 && n > 0u;
  var nn = n;
  if (hit) { nn = ballCount(L, X, Y, n, sp.x, sp.y, add); }
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  if (hit) { atomicMax(&wmax, max(n, nn)); }
  let maxN = workgroupUniformLoad(&wmax);
  let need = (maxN + K - 1u) / K;
  // the ball works on the column's solid view copied into TMP (in place there, as before the partition); pack then
  // writes the partition: Carve leaves air over the span, Add soil, and soil touching soil merges
  let T = TMP_ID + L;
  if (li == 0u && need > 0u) { ensurePages(T, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!hit) { return; }
  tmpCopy(L, X, Y, n, need);
  let lo = sp.x;
  let hi = sp.y;
  if (add) {
    // top down: every interval moves up by the pieces added below it
    var idx = i32(nn) - 1;
    let top = ivlAt(T, X, Y, n - 1u).z1;
    if (max(top, lo) < hi) {
      setIvl(T, X, Y, u32(idx), max(top, lo), hi, MAT_SOIL);
      idx--;
    }
    for (var i = i32(n) - 1; i >= 0; i--) {
      let iv = ivlAt(T, X, Y, u32(i));
      var below = OPEN_BOTTOM;
      if (i > 0) { below = ivlAt(T, X, Y, u32(i - 1)).z1; }
      setIvl(T, X, Y, u32(idx), iv.z0, iv.z1, iv.m);
      idx--;
      if (i > 0 && max(below, lo) < min(iv.z0, hi)) {
        setIvl(T, X, Y, u32(idx), max(below, lo), min(iv.z0, hi), MAT_SOIL);
        idx--;
      }
    }
  } else {
    var iF = -1;
    var iL = -1;
    for (var i = 0; i < i32(n); i++) {
      let iv = ivlAt(T, X, Y, u32(i));
      if (iv.z1 > lo && iv.z0 < hi) {
        if (iF < 0) { iF = i; }
        iL = i;
      }
    }
    if (iF < 0) { return; }
    let f = ivlAt(T, X, Y, u32(iF));
    let l = ivlAt(T, X, Y, u32(iL));
    if (iF == iL && f.z0 < lo && f.z1 > hi) {
      for (var i = i32(n) - 1; i > iF; i--) {
        let iv = ivlAt(T, X, Y, u32(i));
        setIvl(T, X, Y, u32(i + 1), iv.z0, iv.z1, iv.m);
      }
      setIvl(T, X, Y, u32(iF), f.z0, lo, f.m);
      setIvl(T, X, Y, u32(iF + 1), hi, f.z1, f.m);
    } else {
      var w = iF;
      if (f.z0 < lo) {
        setIvl(T, X, Y, u32(w), f.z0, lo, f.m);
        w++;
      }
      if (l.z1 > hi) {
        setIvl(T, X, Y, u32(w), select(hi, OPEN_BOTTOM, w == 0), l.z1, l.m);
        w++;
      }
      for (var j = iL + 1; j < i32(n); j++) {
        let iv = ivlAt(T, X, Y, u32(j));
        setIvl(T, X, Y, u32(w), iv.z0, iv.z1, iv.m);
        w++;
      }
    }
  }
  setCount(T, X, Y, nn, need);
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
  scr[b] = topS(L, X, Y, n);
  for (var q = 0u; q < MELT_DEPTH; q++) {
    var th = 0.0;
    if (q < n) {
      let i = n - 1u - q;
      if (i == 0u) { th = 1e30; } else { th = layerVal(L, X, Y, 2u * i); }
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
fn meltApply(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L0 = u.a.w;
  let slot = slotOf(i32(L0), 3);
  let o = slotOrigin(slot, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L0, cx * 16, cy * 16)) { return; }
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  let box = vec4<i32>(slotW(slot, 0u), slotW(slot, 1u), slotW(slot, 2u), slotW(slot, 3u));
  let inside = inBox(X, Y, box);
  var n = 0u;
  if (inside) { n = u32(scr[snapIdx(X, Y, box) + 6u]); }
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  atomicMax(&wmax, n);
  let need = (workgroupUniformLoad(&wmax) + K - 1u) / K;
  if (li == 0u && need > 0u) { ensurePages(TMP_ID + L0, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (n == 0u) { return; }
  // (the column's solid view copied into TMP and rebuilt there; pack writes the partition back)
  tmpCopy(L0, X, Y, n, need);
  let L = TMP_ID + L0;
  let b = snapIdx(X, Y, box);
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
    setIvl(L, X, Y, 0u, t.z0, base, t.m);
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
    setIvl(L, X, Y, i, z0, z0 + th, t.m);
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
    h[q] = topS(m, X, Y, colCount(m, X, Y));
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
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(lid, X, Y, i);
    if (p.z >= iv.z0 && p.z <= iv.z1) { return -min(p.z - iv.z0, iv.z1 - p.z); }
    d = min(d, min(abs(p.z - iv.z1), select(abs(p.z - iv.z0), 1e9, i == 0u)));
  }
  return d;
}
/** the distance from local point p to column (X, Y)'s solid boxes (the column's own square: the box draw draws exactly
 *  these), so the eye kept outside them is never behind a drawn face. FAR: no solid. */
const FAR: f32 = 1e30;
fn colDist(m: u32, X: i32, Y: i32, w: vec4<i32>, p: vec3<f32>) -> f32 {
  let dx = max(0.0, abs(p.x - (f32(X - w.x) + 0.5)) - 0.5);
  let dy = max(0.0, abs(p.y - (f32(Y - w.y) + 0.5)) - 0.5);
  let n = colCount(m, X, Y);
  var best = FAR;
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(m, X, Y, i);
    let z0 = select(iv.z0, -FAR, i == 0u);
    best = min(best, max(0.0, max(z0 - p.z, p.z - iv.z1)));
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
// near (1) in its units. 256-258: a placement's target x, y and distance (CPU-written). 260-262: cruise (CPU-written
// on, speed; 262 the kept height, set by this pass when the CPU writes it negative).
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
            if ((i == 0u || p.z >= iv.z0) && p.z <= iv.z1) {
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
  // cruise (cam 260 on, 261 speed in world units a second, 262 the height kept over the ground: < 0 takes the eye's
  // height now): along the heading over the ground, the height eased toward the ground ahead plus the kept height
  if (cam[260] > 0.5) {
    let ez = hi.z + lo.z;
    if (cam[262] < 0.0) { cam[262] = max(ez - ground(hi.x, hi.y, lo.x, lo.y), 4.0 * margin); }
    let hd = vec2<f32>(-cos(yaw), -sin(yaw));
    let st = cam[261] * dt;
    let nx = add2(hi.x, lo.x, hd.x * st);
    let ny = add2(hi.y, lo.y, hd.y * st);
    // (and 0.3 s further on: the eye rises before a slope, not into it)
    let ax = add2(hi.x, lo.x, hd.x * cam[261] * 0.3);
    let ay = add2(hi.y, lo.y, hd.y * cam[261] * 0.3);
    let want = max(ground(nx.x, ny.x, nx.y, ny.y), ground(ax.x, ay.x, ax.y, ay.y)) + cam[262];
    mv += vec3<f32>(hd * st, (want - ez) * min(1.0, 10.0 * dt));
  }
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

// ---- the box draw, baked where columns changed (docs/design/NESTED_SCALES.md "The box draw") -------------------------
// Every column is drawn as boxes: a face exists exactly where a solid interval touches an air interval, vertically at
// their shared bound (a cap) or laterally where a solid interval of one column overlaps in height an air interval of the
// neighbouring column (a wall over the overlap). Nothing pairs bounds between columns. A column outside the level's
// window, or under its child's footprint (the child draws there), is air to its neighbours, so walls stand at the window
// edge and round the footprint and every level's faces close by themselves. Each vertical edge of a wall is split at
// every record top of the four columns round that corner line (and their bottoms), the same set for every face that
// touches the line, so no T-junction is left. The world below a level is open: a column's first record ends at
// botOf(L) (or 1 under its top when that is lower), and no cap is drawn on the bottom plane itself.
// The owner's rule stands: "nothing per frame": an op bakes its changed chunks (grown by one), a frame only draws.
@group(0) @binding(8) var<storage, read_write> dir: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> dargs: array<u32>;

/** the level's cz 0 column pages of the 3 x 3 chunks round the baked one, and the baked chunk's face pages cz 0..7 */
var<workgroup> wPg: array<u32, 9>;
var<workgroup> wFp: array<u32, 8>;
var<private> bOrg: vec2<i32>;
var<private> bChunk: vec2<i32>;

/** the open world bottom of a level (local units): the root's terrain stands above 0; a child's surface lies within
 *  about its window's width of its z origin */
fn botOf(L: u32) -> f32 {
  if (L == 0u) { return -8.0; }
  return -2.0 * f32(u.lv[L].z);
}
/** whether column (X, Y) is drawn on level L (in the window and not under a live child's footprint) */
fn colOn(L: u32, X: i32, Y: i32) -> bool {
  if (!inWin(L, X, Y)) { return false; }
  if (L + 1u < 8u && u.lv[L + 1u].w != 0) {
    let c = u.lv[L + 1u];
    let k = i32(u.a.x);
    if (X * k >= c.x && Y * k >= c.y && X * k < c.x + c.z && Y * k < c.y + c.z) { return false; }
  }
  return true;
}
/** a column's cz page (the workgroup's cache for cz 0) */
fn bPage(L: u32, X: i32, Y: i32, cz: u32) -> u32 {
  if (cz == 0u) {
    let c = vec2<i32>(X >> 4, Y >> 4) - bOrg;
    if (c.x >= 0 && c.y >= 0 && c.x < 3 && c.y < 3) { return wPg[u32(c.y * 3 + c.x)]; }
  }
  return pageOf(L, X >> 4, Y >> 4, cz);
}
// The bake reads the 18 x 18 columns round its chunk over and over (each wall's corner lines): their record counts,
// bottoms and first SC records are copied into workgroup memory once (bFill); deeper records are read from the pages.
const SC: u32 = 4u;
var<workgroup> sN: array<u32, 324>;
var<workgroup> sB: array<f32, 324>;
var<workgroup> sT: array<f32, 1296>;
var<workgroup> sM: array<u32, 324>;
var<private> sOrg: vec2<i32>;
fn sIdx(X: i32, Y: i32) -> i32 {
  let q = vec2<i32>(X, Y) - sOrg;
  if (q.x < 0 || q.y < 0 || q.x >= 18 || q.y >= 18) { return -1; }
  return q.y * 18 + q.x;
}
/** (every thread, uniform control flow) the copy of the columns round chunk (cx, cy) */
fn bFill(L: u32, cx: i32, cy: i32, li: u32) {
  sOrg = vec2<i32>(cx * 16 - 1, cy * 16 - 1);
  for (var q = li; q < 324u; q += 256u) {
    let X = sOrg.x + i32(q % 18u);
    let Y = sOrg.y + i32(q / 18u);
    let n = bCountG(L, X, Y);
    sN[q] = n;
    var mats = 0u;
    for (var j = 0u; j < min(n, SC); j++) {
      let r = bRecG(L, X, Y, j);
      sT[q * SC + j] = bitcast<f32>(r.x);
      mats |= (r.y & 255u) << (8u * j);
    }
    sM[q] = mats;
    sB[q] = 0.0;
    if (n > 0u) { sB[q] = min(botOf(L), sT[q * SC] - 1.0); }
  }
  workgroupBarrier();
}
fn bCount(L: u32, X: i32, Y: i32) -> u32 {
  let i = sIdx(X, Y);
  if (i >= 0) { return sN[i]; }
  return bCountG(L, X, Y);
}
fn bRec(L: u32, X: i32, Y: i32, j: u32) -> vec2<u32> {
  let i = sIdx(X, Y);
  if (i >= 0 && j < SC) { return vec2<u32>(bitcast<u32>(sT[u32(i) * SC + j]), (sM[i] >> (8u * j)) & 255u); }
  return bRecG(L, X, Y, j);
}
/** a drawn column's record count (0 where it is air to the draw), from the pages */
fn bCountG(L: u32, X: i32, Y: i32) -> u32 {
  if (!colOn(L, X, Y)) { return 0u; }
  var n = 0u;
  var cz = 0u;
  loop {
    let p = bPage(L, X, Y, cz);
    if (p >= NOT_LOADED) { break; }
    let m = pgLoad(p * PW + colIn(X, Y)) & 0xffffu;
    n += m;
    if (m < KR) { break; }
    cz++;
  }
  return n;
}
/** record j: (top, material), from the pages */
fn bRecG(L: u32, X: i32, Y: i32, j: u32) -> vec2<u32> {
  let p = bPage(L, X, Y, j / KR);
  if (p >= NOT_LOADED) { return vec2<u32>(0u, MAT_AIR); }
  let b = p * PW + 256u + (colIn(X, Y) * KR + j % KR) * 2u;
  return vec2<u32>(pgLoad(b), pgLoad(b + 1u));
}
/** a drawn column's bottom: the first record ends at the level's open bottom, or 1 under its top when that is lower */
fn bBot(L: u32, X: i32, Y: i32) -> f32 {
  let i = sIdx(X, Y);
  if (i >= 0) { return sB[i]; }
  return min(botOf(L), bitcast<f32>(bRecG(L, X, Y, 0u).x) - 1.0);
}
/** the lowest breakpoint above z on the corner line (CX, CY): a record top or a bottom of one of its four columns
 *  (3e38: none) */
fn nextBp(L: u32, CX: i32, CY: i32, z: f32) -> f32 {
  var best = 3e38;
  for (var q = 0; q < 4; q++) {
    let X = CX - 1 + (q & 1);
    let Y = CY - 1 + (q >> 1);
    let n = bCount(L, X, Y);
    if (n == 0u) { continue; }
    let b = bBot(L, X, Y);
    if (b > z) { best = min(best, b); }
    for (var j = 0u; j < n; j++) {
      let t = bitcast<f32>(bRec(L, X, Y, j).x);
      if (t > z) {
        best = min(best, t);
        break;
      }
    }
  }
  return best;
}
/** one triangle written at index t of the chunk's faces */
fn putTri(t: u32, w0: u32, z0: f32, z1: f32, z2: f32) {
  var p = NONE;
  let cz = t / TPP;
  if (cz < 8u) { p = wFp[cz]; } else { p = pageOf(FACE_ID + u.a.w, bChunk.x, bChunk.y, cz); }
  if (p >= NOT_LOADED) { return; }
  let b = p * PW + FHDR + (t % TPP) * 4u;
  pgStore(b, w0);
  pgStore(b + 1u, bitcast<u32>(z0));
  pgStore(b + 2u, bitcast<u32>(z1));
  pgStore(b + 3u, bitcast<u32>(z2));
}
/** a column's faces: counted, or written from index `at` (returns the count). Caps where a solid record meets air above
 *  or below; for each side, each solid record's height range less the neighbour's solid, as strips between the two
 *  corner lines' breakpoints. */
fn emitCol(L: u32, X: i32, Y: i32, write: bool, at: u32) -> u32 {
  let n = bCount(L, X, Y);
  if (n == 0u) { return 0u; }
  let lxy = u32(X & 15) | (u32(Y & 15) << 4u);
  let zb = bBot(L, X, Y);
  let bot = botOf(L);
  var t = 0u;
  // caps: (j, j + 1) for j < n (above the last record: air); and the bottom where the column ends above the open bottom
  for (var j = 0u; j < n; j++) {
    let r = bRec(L, X, Y, j);
    var up = MAT_AIR;
    if (j + 1u < n) { up = bRec(L, X, Y, j + 1u).y; }
    let s0 = matSolid(r.y);
    if (s0 == matSolid(up)) { continue; }
    let z = bitcast<f32>(r.x);
    let kind = select(5u, 4u, s0);
    let w = lxy | (kind << 8u) | ((select(up, r.y, s0) & 255u) << 11u);
    if (write) {
      putTri(at + t, w | (0u << 19u) | (1u << 21u) | (3u << 23u), z, z, z);
      putTri(at + t + 1u, w | (0u << 19u) | (3u << 21u) | (2u << 23u), z, z, z);
    }
    t += 2u;
  }
  let r0 = bRec(L, X, Y, 0u);
  if (matSolid(r0.y) && zb != bot) {
    let w = lxy | (5u << 8u) | ((r0.y & 255u) << 11u);
    if (write) {
      putTri(at + t, w | (0u << 19u) | (1u << 21u) | (3u << 23u), zb, zb, zb);
      putTri(at + t + 1u, w | (0u << 19u) | (3u << 21u) | (2u << 23u), zb, zb, zb);
    }
    t += 2u;
  }
  // walls: +x, -x, +y, -y; corner codes (bit 0: x + 1, bit 1: y + 1) of the face's two vertical edges
  for (var d = 0u; d < 4u; d++) {
    var off = vec2<i32>(1, 0);
    var cA = 1u;
    var cB = 3u;
    if (d == 1u) {
      off = vec2<i32>(-1, 0);
      cA = 0u;
      cB = 2u;
    } else if (d == 2u) {
      off = vec2<i32>(0, 1);
      cA = 2u;
      cB = 3u;
    } else if (d == 3u) {
      off = vec2<i32>(0, -1);
      cA = 0u;
      cB = 1u;
    }
    let NX = X + off.x;
    let NY = Y + off.y;
    let nn = bCount(L, NX, NY);
    var nb = 0.0;
    if (nn > 0u) { nb = bBot(L, NX, NY); }
    let AX = X + i32(cA & 1u);
    let AY = Y + i32(cA >> 1u);
    let BX = X + i32(cB & 1u);
    let BY = Y + i32(cB >> 1u);
    var lo = zb;
    for (var j = 0u; j < n; j++) {
      let r = bRec(L, X, Y, j);
      let hi = bitcast<f32>(r.x);
      if (matSolid(r.y)) {
        let w = lxy | (d << 8u) | ((r.y & 255u) << 11u);
        // the neighbour's solid runs subtracted from [lo, hi], in order
        var cur = lo;
        var jn = 0u;
        var nlo = nb;
        loop {
          if (cur >= hi) { break; }
          // the next solid range of the neighbour reaching above cur (or none: [3e38, 3e38])
          var a = 3e38;
          var b = 3e38;
          loop {
            if (jn >= nn) { break; }
            let q = bRec(L, NX, NY, jn);
            let qt = bitcast<f32>(q.x);
            let qlo = nlo;
            nlo = qt;
            jn++;
            if (matSolid(q.y) && qt > cur) {
              a = qlo;
              b = qt;
              break;
            }
          }
          let p0 = cur;
          let p1 = min(a, hi);
          if (p1 > p0) {
            // a strip between the two corner lines from p0 to p1: advance the lower side to its next breakpoint
            var za = p0;
            var zc = p0;
            loop {
              if (za >= p1 && zc >= p1) { break; }
              let na = min(nextBp(L, AX, AY, za), p1);
              let nc = min(nextBp(L, BX, BY, zc), p1);
              if (za < p1 && (na <= nc || zc >= p1)) {
                if (write) { putTri(at + t, w | (cA << 19u) | (cB << 21u) | (cA << 23u), za, zc, na); }
                za = na;
              } else {
                if (write) { putTri(at + t, w | (cA << 19u) | (cB << 21u) | (cB << 23u), za, zc, nc); }
                zc = nc;
              }
              t++;
            }
          }
          cur = max(cur, b);
        }
      }
      lo = hi;
    }
  }
  return t;
}

/** (over a slot's chunks) a chunk's faces: counted per column, the chunk's face pages sized, then written (one call
 *  site of emitCol: the D3D11 compiler inlines every call) */
@compute @workgroup_size(16, 16)
fn faceBake(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  if (li < 9u) { wPg[li] = pageOf(L, cx - 1 + i32(li % 3u), cy - 1 + i32(li / 3u), 0u); }
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  bOrg = vec2<i32>(cx - 1, cy - 1);
  bChunk = vec2<i32>(cx, cy);
  bFill(L, cx, cy, li);
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  var n = 0u;
  var at = 0u;
  for (var ps = 0u; ps < 2u; ps++) {
    if (ps == 1u) {
      at = atomicAdd(&wmax, n);
      let total = workgroupUniformLoad(&wmax);
      let need = (total + TPP - 1u) / TPP;
      if (li == 0u) {
        ensurePages(FACE_ID + L, cx, cy, need, u.d.x);
        for (var cz = 0u; cz < need; cz++) {
          let p = pageOf(FACE_ID + L, cx, cy, cz);
          if (p < NOT_LOADED) {
            pgStore(p * PW, min(TPP, total - cz * TPP));
            pgStore(p * PW + 1u, u32(cx));
            pgStore(p * PW + 2u, u32(cy));
          }
        }
      }
      storageBarrier();
      workgroupBarrier();
      if (li < 8u) { wFp[li] = pageOf(FACE_ID + L, cx, cy, li); }
      workgroupBarrier();
    }
    if (ps == 0u || n > 0u) { n = emitCol(L, X, Y, ps == 1u, at); }
  }
}

/** the draw's list of face pages: dir[L] their count, entries (page, chunk key) from 16 + (L * cap + i) * 2 */
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
  if (lid < FACE_ID || lid >= FACE_ID + 8u) { return; }
  let L = lid - FACE_ID;
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p >= NOT_LOADED || pgLoad(p * PW) == 0u) { return; }
  let i = atomicAdd(&dir[L], 1u);
  let e = 16u + (L * u.r.y + i) * 2u;
  atomicStore(&dir[e], p);
  atomicStore(&dir[e + 1u], atomicLoad(&tab[s * 4u]));
}
/** the draw's indirect arguments a level: an instance per face page, three vertices a triangle slot */
@compute @workgroup_size(1)
fn dirFinish() {
  for (var L = 0u; L < 8u; L++) {
    dargs[L * 4u] = 3u * TPP;
    dargs[L * 4u + 1u] = atomicLoad(&dir[L]);
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
  // the columns the slot's pass changes (its box) grown by one column, in chunks: a column's faces depend on its four
  // neighbours only (a CPU slot's box is everything: its chunks grown by one)
  let bx0 = (max(slotW(s, 0u), -(1 << 28)) - 1) >> 4;
  let by0 = (max(slotW(s, 1u), -(1 << 28)) - 1) >> 4;
  let bx1 = (min(slotW(s, 2u), 1 << 28) >> 4) + 1;
  let by1 = (min(slotW(s, 3u), 1 << 28) >> 4) + 1;
  let x0 = max(max(ox - 1, bx0), w.x / 16);
  let y0 = max(max(oy - 1, by0), w.y / 16);
  let x1 = min(min(ox + nx + 1, bx1), (w.x + w.z) / 16);
  let y1 = min(min(oy + ny + 1, by1), (w.y + w.z) / 16);
  setSlot(t, vec4<i32>(-(1 << 30), -(1 << 30), 1 << 30, 1 << 30), x0, y0, x1 - x0, y1 - y0);
}
