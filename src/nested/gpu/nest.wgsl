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
  // the level's columns and its baked draw (gap table, mesh items)
  let lid = k1 & 0xffu;
  if (lid != u.a.w && lid != GAP_ID + u.a.w && lid != MESH_ID + u.a.w) { return; }
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
  let o = p * PW + 256u + (colIn(X, Y) * K + (i % K)) * 3u;
  pg[o] = a;
  pg[o + 1u] = b;
  pg[o + 2u] = c;
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
  let m = pg[p * PW + colIn(X, Y)];
  if (m < K) { return m; }
  return colCount(lid, X, Y);
}
fn cIvl(lid: u32, X: i32, Y: i32, i: u32) -> Ivl {
  if (i >= K) { return ivlAt(lid, X, Y, i); }
  let p = cPage(lid, X, Y);
  if (p >= NOT_LOADED) { return Ivl(OPEN_BOTTOM, OPEN_BOTTOM, 0u); }
  return pgIvl(p, colIn(X, Y), i);
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
  var i = i32(n) - 1;
  loop {
    let top = cIvl(L, X, Y, u32(i));
    var j = i;
    loop {
      if (j == 0) { break; }
      if (cIvl(L, X, Y, u32(j)).z0 > cIvl(L, X, Y, u32(j - 1)).z1 + GAP_MIN) { break; }
      j--;
    }
    let bot = cIvl(L, X, Y, u32(j));
    if (cur == g) { return Gap(top.z1, ceil, top.m, cm, max(bot.z0, top.z1 - 1000.0), vec2<f32>(0.0), vec2<f32>(0.0), true); }
    if (j == 0) { return out; }
    ceil = bot.z0;
    cm = bot.m;
    cur++;
    i = j - 1;
  }
}
fn gapCountI(L: u32, X: i32, Y: i32) -> u32 {
  let n = cCount(L, X, Y);
  var c = select(0u, 1u, n > 0u);
  for (var i = 1u; i < n; i++) {
    if (cIvl(L, X, Y, i).z0 > cIvl(L, X, Y, i - 1u).z1 + GAP_MIN) { c++; }
  }
  return c;
}
fn sAtC(L: u32, X: i32, Y: i32) -> f32 {
  let q = clampTo(L, X, Y);
  let n = cCount(L, q.x, q.y);
  if (n == 0u) { return 0.0; }
  return cIvl(L, q.x, q.y, n - 1u).z1;
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
  let top = cIvl(L, X, Y, n - 1u);
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
  let b = p * PW + 256u + (colIn(X, Y) * K + i) * 3u;
  let m = pg[b + 2u];
  return Gap(bitcast<f32>(pg[b]), bitcast<f32>(pg[b + 1u]), m & 0xffu, (m >> 8u) & 0xffu, bitcast<f32>(pg[b + 3u]), unpack2x16snorm(pg[b + 4u]), unpack2x16snorm(pg[b + 5u]), true);
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
  var i = i32(n) - 1;
  loop {
    let fl = cIvl(L, X, Y, u32(i)).z1;
    var j = i;
    loop {
      if (j == 0) { break; }
      if (cIvl(L, X, Y, u32(j)).z0 > cIvl(L, X, Y, u32(j - 1)).z1 + GAP_MIN) { break; }
      j--;
    }
    if (fl < c && f < ceil && abs(fl - f) < bd) {
      bd = abs(fl - f);
      out = Near(g, fl, ceil);
    }
    if (j == 0) { break; }
    ceil = cIvl(L, X, Y, u32(j)).z0;
    g++;
    i = j - 1;
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
  let v = (pg[p * PW + 256u + (colIn(mC[r].x, mC[r].y) * K + (i % K)) * 3u + d / 2u] >> (16u * (d % 2u))) & 0xffffu;
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
  pg[b] = lx | (ly << 4u) | (t << 8u) | (select(0u, 1u, enclosed) << 9u);
  pg[b + 1u] = birth;
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
    pg[o] = bitcast<u32>(G.f);
    pg[o + 1u] = bitcast<u32>(G.c);
    pg[o + 2u] = bitcast<u32>(G.rb);
    pg[o + 3u] = G.fm | (G.cm << 8u) | (select(0u, 1u, pres) << 16u);
    pg[o + 4u] = pack2x16snorm(G.nF);
    pg[o + 5u] = pack2x16snorm(G.nC);
    pg[o + 6u] = bitcast<u32>(pf);
    pg[o + 7u] = bitcast<u32>(pc);
    pg[o + 8u] = bitcast<u32>(x8);
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
          if (p < NOT_LOADED) { pg[p * PW] = min(IPP, total - cz * IPP); }
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
  if (p >= NOT_LOADED || pg[p * PW] == 0u) { return; }
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
