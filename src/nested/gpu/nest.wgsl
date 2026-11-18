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
@group(0) @binding(3) var<storage, read_write> pg: array<u32>;
@group(0) @binding(4) var<storage, read_write> scr: array<f32>;
@group(0) @binding(5) var<storage, read_write> reg: array<i32>;
@group(0) @binding(6) var<storage, read_write> cam: array<f32>;
// (the plan's only: the indirect dispatch arguments, 4 words a slot; other passes dispatch from it)
@group(0) @binding(7) var<storage, read_write> args: array<u32>;

fn tabLoad(i: u32) -> u32 { return atomicLoad(&tab[i]); }
fn pgLoad(i: u32) -> u32 { return pg[i]; }

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
        for (var c = 0u; c < 256u; c++) { pg[p * PW + c] = 0u; }
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
fn pgSetIvl(page: u32, c: u32, i: u32, z0: f32, z1: f32, m: u32) {
  let b = page * PW + 256u + (c * K + i) * 3u;
  pg[b] = bitcast<u32>(z0);
  pg[b + 1u] = bitcast<u32>(z1);
  pg[b + 2u] = m;
}
fn setIvl(lid: u32, X: i32, Y: i32, i: u32, z0: f32, z1: f32, m: u32) {
  let p = pageOf(lid, X >> 4, Y >> 4, i / K);
  if (p >= NOT_LOADED) { return; }
  pgSetIvl(p, colIn(X, Y), i % K, z0, z1, m);
}
/** a column's count written into each of its chunk's pages (cz < need) */
fn setCount(lid: u32, X: i32, Y: i32, n: u32, need: u32) {
  for (var cz = 0u; cz < need; cz++) {
    let p = pageOf(lid, X >> 4, Y >> 4, cz);
    if (p >= NOT_LOADED) { continue; }
    pg[p * PW + colIn(X, Y)] = u32(clamp(i32(n) - i32(cz * K), 0, i32(K)));
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
        if (write) { setIvl(L, gX, gY, i, d0, d1, ivlAt(P, gP.x, gP.y, i).m); }
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
    if (mode == 0u && write) { setIvl(L, gX, gY, 0u, OPEN_BOTTOM, min(addRes(z, L, 0u, 1u), dPrev), ivlAt(P, gP.x, gP.y, 0u).m); }
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
  setCount(L, gX, gY, n, need);
  for (var i = 0u; i < n; i++) {
    let z1 = (gS + bitcast<f32>(resWord(L, 2u * i + 1u, 0u))) + bitcast<f32>(resWord(L, 2u * i + 1u, 1u));
    var z0 = OPEN_BOTTOM;
    if (i > 0u) { z0 = (gS + bitcast<f32>(resWord(L, 2u * i, 0u))) + bitcast<f32>(resWord(L, 2u * i, 1u)); }
    setIvl(L, gX, gY, i, z0, z1, resWord(L, 2u * i + 1u, 2u) & 0xffffu);
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
  // the Catmull-Rom surface
  let ux = (f32(gA) + 0.5) / kf - 0.5;
  let uy = (f32(gB) + 0.5) / kf - 0.5;
  gOff = vec2<i32>(select(0, -1, ux < 0.0), select(0, -1, uy < 0.0));
  gT = vec2<f32>(ux - f32(gOff.x), uy - f32(gOff.y));
  let wx = crW(gT.x);
  let wy = crW(gT.y);
  let pref = topS(P, gP.x, gP.y, gN);
  var fsum = 0.0;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let q = clampTo(P, px + gOff.x - 1 + i, py + gOff.y - 1 + j);
      fsum += wx[i] * wy[j] * (topS(P, q.x, q.y, colCount(P, q.x, q.y)) - pref);
    }
  }
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
      setIvl(P, X, Y, i, z - th * inv, z, ivlAt(L, tpl.x, tpl.y, i).m);
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
      setIvl(P, X, Y, i, z - th, z, iv.m);
      z = z - th - gap;
    }
  }
  setIvl(P, X, Y, 0u, OPEN_BOTTOM, z, ivlAt(L, tpl.x, tpl.y, 0u).m);
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
      setIvl(0u, X, Y, i, select(lo, OPEN_BOTTOM, i == 0u), s - 4.0 + f32(i + 1u) * 0.1, select(MAT_SAND, MAT_CLAY, (i & 1u) == 1u));
    }
  } else {
    setIvl(0u, X, Y, 0u, OPEN_BOTTOM, s - soil, MAT_STONE);
    setIvl(0u, X, Y, 1u, s - soil, s, MAT_SOIL);
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
  if ((k1 & 0xffu) != u.a.w) { return; }
  let k0 = atomicLoad(&tab[s * 4u]);
  let cx = i32(k0 & 0xffffu);
  let cy = i32(k0 >> 16u);
  let keep = u.e;
  if (cx >= keep.x && cy >= keep.y && cx < keep.z && cy < keep.w) { return; }
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p < NOT_LOADED) { freePage(p); }
  atomicStore(&tab[s * 4u + 1u], TOMB);
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
  var box = vec4<i32>(i32(floor(cxg - r)), i32(floor(cyg - r)), i32(ceil(cxg + r)) + 1, i32(ceil(cyg + r)) + 1);
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
    setIvl(L, X, Y, n - 1u, t.z0, t.z1 + a, t.m);
    return;
  }
  let top = ivlAt(L, X, Y, n - 1u).z1 - a;
  for (var i = n; i > 0u; i--) {
    let t = ivlAt(L, X, Y, i - 1u);
    if (t.z1 <= top) { break; }
    var z0 = t.z0;
    if (i > 1u && z0 > top) { z0 = top; }
    setIvl(L, X, Y, i - 1u, z0, top, t.m);
  }
}

// ---- carve (op 4) and add (op 5): a ball's z-span on each column (the oracle's applyBall). Carve removes solid in
// [lo, hi]: an interval it lies inside splits in two, ones inside it go. Add fills each air piece of [lo, hi] with soil
// as a new interval. Counts change, so pages are ensured per chunk first; the column is rewritten in place (top down
// when it grows, bottom up when it shrinks).
fn ballSpan(X: i32, Y: i32, L: u32) -> vec3<f32> {
  let w = u.lv[L];
  let c = vec2<f32>(f32(w.x) + bitcast<f32>(reg[9]), f32(w.y) + bitcast<f32>(reg[10]));
  let r = bitcast<f32>(reg[11]);
  let dd = length(vec2<f32>(f32(X) + 0.5, f32(Y) + 0.5) - c);
  if (dd >= r) { return vec3<f32>(0.0, 0.0, -1.0); }
  let h = sqrt(r * r - dd * dd);
  let cz = bitcast<f32>(reg[13]);
  return vec3<f32>(cz - h, cz + h, 1.0);
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
  atomicMax(&wmax, nn);
  let maxN = workgroupUniformLoad(&wmax);
  let need = (maxN + K - 1u) / K;
  if (li == 0u) { ensurePages(L, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!hit) { return; }
  let lo = sp.x;
  let hi = sp.y;
  if (add) {
    // top down: every interval moves up by the pieces added below it
    var idx = i32(nn) - 1;
    let top = ivlAt(L, X, Y, n - 1u).z1;
    if (max(top, lo) < hi) {
      setIvl(L, X, Y, u32(idx), max(top, lo), hi, MAT_SOIL);
      idx--;
    }
    for (var i = i32(n) - 1; i >= 0; i--) {
      let iv = ivlAt(L, X, Y, u32(i));
      var below = OPEN_BOTTOM;
      if (i > 0) { below = ivlAt(L, X, Y, u32(i - 1)).z1; }
      setIvl(L, X, Y, u32(idx), iv.z0, iv.z1, iv.m);
      idx--;
      if (i > 0 && max(below, lo) < min(iv.z0, hi)) {
        setIvl(L, X, Y, u32(idx), max(below, lo), min(iv.z0, hi), MAT_SOIL);
        idx--;
      }
    }
  } else {
    var iF = -1;
    var iL = -1;
    for (var i = 0; i < i32(n); i++) {
      let iv = ivlAt(L, X, Y, u32(i));
      if (iv.z1 > lo && iv.z0 < hi) {
        if (iF < 0) { iF = i; }
        iL = i;
      }
    }
    if (iF < 0) { return; }
    let f = ivlAt(L, X, Y, u32(iF));
    let l = ivlAt(L, X, Y, u32(iL));
    if (iF == iL && f.z0 < lo && f.z1 > hi) {
      for (var i = i32(n) - 1; i > iF; i--) {
        let iv = ivlAt(L, X, Y, u32(i));
        setIvl(L, X, Y, u32(i + 1), iv.z0, iv.z1, iv.m);
      }
      setIvl(L, X, Y, u32(iF), f.z0, lo, f.m);
      setIvl(L, X, Y, u32(iF + 1), hi, f.z1, f.m);
    } else {
      var w = iF;
      if (f.z0 < lo) {
        setIvl(L, X, Y, u32(w), f.z0, lo, f.m);
        w++;
      }
      if (l.z1 > hi) {
        setIvl(L, X, Y, u32(w), select(hi, OPEN_BOTTOM, w == 0), l.z1, l.m);
        w++;
      }
      for (var j = iL + 1; j < i32(n); j++) {
        let iv = ivlAt(L, X, Y, u32(j));
        setIvl(L, X, Y, u32(w), iv.z0, iv.z1, iv.m);
        w++;
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
  let n = colCount(m, X, Y);
  var d = 1e9;
  for (var i = 0u; i < n; i++) {
    let iv = ivlAt(m, X, Y, i);
    if (p.z >= iv.z0 && p.z <= iv.z1) { return -min(p.z - iv.z0, iv.z1 - p.z); }
    d = min(d, min(abs(p.z - iv.z1), select(abs(p.z - iv.z0), 1e9, i == 0u)));
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
  // nothing is nearer than dn; every point at dn or more inside the frustum is past half of it
  let near = 0.5 * dn;
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
