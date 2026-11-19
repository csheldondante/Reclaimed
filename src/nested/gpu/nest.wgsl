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
    // (round 22: one material, the edge of the interval whose top is kept: this one, since top > pTop here)
    if (have && ((m ^ pMat) & 0xffu) == 0u) {
      pTop = top;
      pMat = m;
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
  if (matSolid(m)) { *solids += 1u; }
}
@compute @workgroup_size(16, 16)
fn pack(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let T = TMP_ID + L;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  if (li == 0u) { wflag = select(0u, 1u, pageOf(T, cx, cy, 0u) < NOT_LOADED); }
  if (workgroupUniformLoad(&wflag) == 0u) { return; }
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  let p0 = pageOf(T, cx, cy, 0u);
  let touched = (pgLoad(p0 * PW + colIn(X, Y)) & TOUCHED) != 0u;
  var r = 0u;
  if (touched) { r = packCol(T, L, X, Y, false); } else { r = recCount(L, X, Y); }
  let need = (wgMax(li, r) + KR - 1u) / KR;
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
var<workgroup> wKeep: u32;

// ---- workgroup reductions (round 9, NS-86): NO atomics in workgroup memory. On the desktop's Intel Arc (D3D12), after
// some GPU work, workgroup-memory atomics went wrong (src/nested/hazard.ts: an atomicMax, an atomicAdd, even one
// thread's atomicStore read back with workgroupUniformLoad, gave stale values to 5-15 % of threads), so a workgroup's
// page count came out 0 for some waves and their columns were never written: root columns with no records. Plain
// workgroup words with one writer each and barriers held in the same state. So every reduction is a tree over a plain
// array, every flag a plain word written by one thread and read with workgroupUniformLoad. Each helper is called by all
// 256 threads of a 256-thread workgroup in uniform control flow, with li the local invocation index.
var<workgroup> wred: array<u32, 256>;
/** one thread's flag (a plain word, one writer) */
var<workgroup> wflag: u32;
/** the workgroup's max of v (uniform) */
fn wgMax(li: u32, v: u32) -> u32 {
  workgroupBarrier();
  wred[li] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { wred[li] = max(wred[li], wred[li + s]); }
    workgroupBarrier();
  }
  return workgroupUniformLoad(&wred[0]);
}
/** the workgroup's bitwise or of v (uniform) */
fn wgOr(li: u32, v: u32) -> u32 {
  workgroupBarrier();
  wred[li] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { wred[li] = wred[li] | wred[li + s]; }
    workgroupBarrier();
  }
  return workgroupUniformLoad(&wred[0]);
}
/** the workgroup's min of v (uniform) */
fn wgMin(li: u32, v: u32) -> u32 {
  workgroupBarrier();
  wred[li] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { wred[li] = min(wred[li], wred[li + s]); }
    workgroupBarrier();
  }
  return workgroupUniformLoad(&wred[0]);
}
/** v's exclusive prefix over the threads in li order (x) and the workgroup's total (y, uniform) */
fn wgScan(li: u32, v: u32) -> vec2<u32> {
  workgroupBarrier();
  wred[li] = v;
  workgroupBarrier();
  for (var off = 1u; off < 256u; off <<= 1u) {
    var a = 0u;
    if (li >= off) { a = wred[li - off]; }
    workgroupBarrier();
    wred[li] = wred[li] + a;
    workgroupBarrier();
  }
  let incl = wred[li];
  return vec2<u32>(incl - v, workgroupUniformLoad(&wred[255]));
}

var<workgroup> wOrigin: vec2<i32>;
/** derive: the parent's tops round the chunk ((16 / k + 4)^2, k >= 2) */
var<workgroup> wPTop: array<f32, 144>;
/** derive (round 10): for each own cell (up to 64) and each cell of its 5 x 5 stencil, 1 where they share a structure */
var<workgroup> wPSame: array<u32, 1600>;
/** derive (round 24): the edge sample of the top of each parent cell round the chunk (as wPTop) */
var<workgroup> wPEdge: array<u32, 144>;
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
    if (((ivlAt(lid, a.x, a.y, i).m ^ ivlAt(lid, b.x, b.y, i).m) & 0xffu) != 0u) { return false; }
  }
  return true;
}

// ---- (round 22) the edge sample (src/nested/edge.ts, the same expressions) -------------------------------------------
const TAU: f32 = 6.2831853;
fn edgeEncA(ang: f32, d: f32) -> u32 {
  if (!(abs(d) <= 2.0)) { return 0u; }
  let a = u32(i32(floor(ang / TAU * 512.0 + 0.5)) & 511);
  let q = u32(clamp(i32(floor(d * 1024.0 + 0.5)) + 2048, 0, 4095));
  return EDGE_ON | (a << 9u) | (q << 18u);
}
fn edgeAng(e: u32) -> f32 { return f32((e >> 9u) & 511u) * (TAU / 512.0); }
fn edgeD(e: u32) -> f32 { return f32(i32((e >> 18u) & 4095u) - 2048) / 1024.0; }
/** enhance: a parent's line seen from a child whose centre is `off` from the parent's (parent units) */
fn edgeToChild(e: u32, off: vec2<f32>, k: f32) -> u32 {
  if ((e & EDGE_ON) == 0u) { return 0u; }
  let a = edgeAng(e);
  return edgeEncA(a, (edgeD(e) - dot(vec2<f32>(cos(a), sin(a)), off)) * k);
}
/** derive: interval i's enhanced material word (the parent's material, its edge seen from this child: gA, gB) */
fn edgeEnh(pm: u32, k: f32) -> u32 {
  let off = vec2<f32>((f32(gA) + 0.5) / k - 0.5, (f32(gB) + 0.5) / k - 0.5);
  return (pm & 0xffu) | edgeToChild(pm & EDGE_MASK, off, k);
}
/** (round 24) derive: this column's edge-aware top (child units; gS where the block's parent has no line or edge-aware
 *  enhance is off). The layer pass puts it on the top interval's z1 alone, never under its z0 (the oracle's enhancedCol). */
var<private> gSe: f32;
fn sgnI(v: i32) -> i32 { return select(select(0, -1, v < 0), 1, v > 0); }
/** (round 24) derive: the top surface with the block's line (the oracle's enhanceTops): the limited PPM of the parent's
 *  5 x 5 tops round (px, py) with every cell on the other side of the line from side `sd` (a cell's side: its own
 *  sample's sign, else the parent's line at its centre) replaced by side sd's surface carried on from the nearest cells
 *  of that side (linearly where the next cell back is on that side too, never past the cell's own top), relative to
 *  pref as the plain one: written to gEv, which derive's PPM then reads */
var<private> gEv: array<f32, 25>;
fn edgeFill(pe: u32, px: i32, py: i32, p0: vec2<i32>, ps: i32, pref: f32, sd: bool) {
  let an = edgeAng(pe);
  let nP = vec2<f32>(cos(an), sin(an));
  let dP = edgeD(pe);
  var top: array<f32, 25>;
  var side: array<bool, 25>;
  for (var q = 0; q < 25; q++) {
    let c = clampTo(u.a.w - 1u, px - 2 + q % 5, py - 2 + q / 5);
    let cq = (py - 2 + q / 5 - p0.y) * ps + (px - 2 + q % 5 - p0.x);
    top[q] = wPTop[cq];
    let e = wPEdge[cq];
    side[q] = dP - dot(nP, vec2<f32>(f32(c.x - px), f32(c.y - py))) > 0.0;
    if ((e & EDGE_ON) != 0u) { side[q] = edgeD(e) > 0.0; }
  }
  for (var j = 0; j < 5; j++) {
    for (var i = 0; i < 5; i++) {
      let c = j * 5 + i;
      var v = top[c];
      if (side[c] != sd) {
        var best = 99;
        var sum = 0.0;
        var cnt = 0.0;
        for (var q = 0; q < 25; q++) {
          let qx = q % 5;
          let qy = q / 5;
          let d = (qx - i) * (qx - i) + (qy - j) * (qy - j);
          if (side[q] != sd || d > best) { continue; }
          if (d < best) {
            best = d;
            sum = 0.0;
            cnt = 0.0;
          }
          let rx = qx - sgnI(i - qx);
          let ry = qy - sgnI(j - qy);
          var ext = top[q];
          if (rx >= 0 && rx < 5 && ry >= 0 && ry < 5) {
            if (side[ry * 5 + rx] == sd) { ext = top[q] + (top[q] - top[ry * 5 + rx]) * f32(max(abs(i - qx), abs(j - qy))); }
          }
          sum += min(max(ext, min(top[q], top[c])), max(top[q], top[c]));
          cnt += 1.0;
        }
        if (cnt > 0.0) { v = sum / cnt; }
      }
      gEv[c] = v - pref;
    }
  }
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
      let e0 = z - vals[0];
      // (round 24) the top interval's z1: the edge-aware top, never under its z0 (gSe == gS: plain)
      let e1 = select(z, max(e0, gSe), uu == 0u);
      if (gAct && !gWhole) {
        // (round 22: one call site for the material word of either mode, for the compile)
        var lv = Ivl(0.0, 0.0, 0u);
        if (mode == 1u) { lv = ivlAt(L, gX, gY, i); }
        let mw = matWord(L, P, i, kf, mode, lv.m);
        if (mode == 0u) {
          // the residual is per bound; the order of the bounds is kept (a no-op when nothing changed under them)
          let d1 = min(addRes(e1, L, i, 1u), dPrev);
          let d0 = min(addRes(e0, L, i, 0u), d1);
          if (write) { setIvl(TMP_ID + L, gX, gY, i, d0, d1, mw); }
          dPrev = d0;
        } else {
          putRes(lv.z0, e0, L, i, 0u, write);
          putResW(lv.z1, e1, L, i, 1u, write, mw);
        }
      }
      z = e0 - vals[1];
    }
  }
  if (gAct && !gWhole && gN > 0u) {
    var lv0 = Ivl(0.0, 0.0, 0u);
    if (mode == 1u) { lv0 = ivlAt(L, gX, gY, 0u); }
    let mw0 = matWord(L, P, 0u, kf, mode, lv0.m);
    // (round 24: a one-interval column's top is the edge-aware one)
    let t0 = select(z, gSe, gN == 1u);
    if (mode == 0u && write) { setIvl(TMP_ID + L, gX, gY, 0u, OPEN_BOTTOM, min(addRes(t0, L, 0u, 1u), dPrev), mw0); }
    if (mode == 1u) {
      if (write) { setRes(L, 0u, 0.0, 0.0); }
      putResW(lv0.z1, t0, L, 0u, 1u, write, mw0);
    }
  }
}
/** (round 22) interval i's material word. Mode 0 (derive): the parent's material with its edge seen from this child,
 *  or the residual's override where the residual applies. Mode 1 (residual): the override word of a top whose live edge
 *  (`live`) differs from the enhanced one (RES_EDGE | the live edge; 0: none). */
fn matWord(L: u32, P: u32, i: u32, kf: f32, mode: u32, live: u32) -> u32 {
  let em = edgeEnh(ivlAt(P, gP.x, gP.y, i).m, kf);
  if (mode == 1u) {
    let le = live & EDGE_MASK;
    return select(0u, RES_EDGE | le, le != (em & EDGE_MASK));
  }
  if (gResOk) {
    let w = resWord(L, 2u * i + 1u, 2u);
    if ((w & RES_EDGE) != 0u) { return (em & 0xffu) | (w & EDGE_MASK); }
  }
  return em;
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
/** (this thread) some residual word of its column is not zero (derive mode 1 reduces it over the workgroup) */
var<private> gAnyRes: bool;
/** word2: 0 for a per-bound record; WHOLE | material for a whole column's */
fn putResW(live: f32, e: f32, L: u32, i: u32, which: u32, write: bool, word2: u32) {
  let hi = live - e;
  let lo = live - (e + hi);
  if (hi != 0.0 || lo != 0.0 || word2 != 0u) { gAnyRes = true; }
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
    // (round 22: the material word with its edge, bits 0-29)
    setIvl(TMP_ID + L, gX, gY, i, z0, z1, resWord(L, 2u * i + 1u, 2u) & 0x3fffffffu);
  }
}
fn sameAcross(la: u32, a: vec2<i32>, lb: u32, b: vec2<i32>, n: u32) -> bool {
  if (colCount(la, a.x, a.y) != n) { return false; }
  for (var i = 0u; i < n; i++) {
    if (((ivlAt(la, a.x, a.y, i).m ^ ivlAt(lb, b.x, b.y, i).m) & 0xffu) != 0u) { return false; }
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
    let cn = colCount(P, c.x, c.y);
    wPTop[q] = topS(P, c.x, c.y, cn);
    // (round 24) the top's edge sample (edge-aware enhance only)
    wPEdge[q] = 0u;
    if ((u.e.w & 8) != 0 && cn > 0u) { wPEdge[q] = ivlAt(P, c.x, c.y, cn - 1u).m & EDGE_MASK; }
  }
  // (round 10) which of those cells share the structure of each parent cell the chunk's blocks hang from (the nb x nb
  // "own" cells, each against its 5 x 5 stencil). The top surface interpolates between same-structure cells
  // only, as the gaps and thicknesses always did ("Column correspondence"): a neighbour of another structure is taken
  // at the block's own top. Before, a cave's thin roof beside the column where the ball broke through followed the top
  // down to the cave's floor (each child a step lower than its neighbour, more than the roof is thick): a staircase of
  // roof pieces, each floating (the owner's "floating columns").
  // (one pair a thread: each own cell against each cell of its 5 x 5 stencil, nb x nb x 25 pairs, at most 1,600)
  let nb = 16 / k;
  for (var t = li; t < u32(nb * nb * 25) && u.e.x != 1; t += 256u) {
    let o = i32(t / 25u);
    let sI = i32(t % 25u);
    let own = clampTo(P, p0.x + 2 + o % nb, p0.y + 2 + o / nb);
    let c = clampTo(P, p0.x + 2 + o % nb + sI % 5 - 2, p0.y + 2 + o / nb + sI / 5 - 2);
    wPSame[t] = select(0u, 1u, sameMats(P, c, own, colCount(P, own.x, own.y)));
  }
  workgroupBarrier();
  let pref = wPTop[(py - p0.y) * ps + (px - p0.x)];
  let ownI = (py - p0.y - 2) * nb + (px - p0.x - 2);
  // (round 24) edge-aware enhance (the oracle's enhanceTops): where the block's parent top keeps a line, this column's
  // top from its side of it; the home side's (most children's: the parent's centre's) corrected to the parent's mean.
  // The child's side: its own enhanced sample's sign, else the parent's line at its centre.
  let pe = wPEdge[(py - p0.y) * ps + (px - p0.x)];
  let useE = (pe & EDGE_ON) != 0u;
  var sd = false;
  var cdv = 0.0;
  if (useE) {
    let off = vec2<f32>(ux, uy);
    let ce = edgeToChild(pe, off, kf);
    let an = edgeAng(pe);
    sd = edgeD(pe) - dot(vec2<f32>(cos(an), sin(an)), off) > 0.0;
    if ((ce & EDGE_ON) != 0u) {
      cdv = edgeD(ce);
      sd = cdv > 0.0;
    }
  }
  // the 5 x 5 values round the block, relative to pref: pass 0 the plain ones, pass 1 (edge-aware) gEv's; one PPM code
  for (var c = 0; c < 25; c++) {
    let cq = (py - 2 + c / 5 - p0.y) * ps + (px - 2 + c % 5 - p0.x);
    // (u.e.x = 1, tests only: round 9's rule, every neighbour's top, for the before stills)
    gEv[c] = select(0.0, wPTop[cq] - pref, u.e.x == 1 || wPSame[u32(ownI * 25 + c)] != 0u);
  }
  var fs = vec2<f32>(0.0);
  for (var pi = 0; pi < 2; pi++) {
    var rows = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
    for (var j = 0; j < 5; j++) {
      var q = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
      for (var i = 0; i < 5; i++) { q[i] = gEv[j * 5 + i]; }
      rows[j] = ppmSub(q, f32(gA), kf);
    }
    fs[pi] = ppmSub(rows, f32(gB), kf);
    if (!useE) { break; }
    edgeFill(pe, px, py, p0, ps, pref, sd);
  }
  let z0 = zOrigin(L);
  let det = detail(gX, gY, i32(L), k, u.a.y, u.d.w);
  var s = (pref - z0) * kf + fs.x * kf + det;
  let se = (pref - z0) * kf + fs.y * kf + det;
  shv[li] = s;
  workgroupBarrier();
  let sum = blockSum(lid.x, lid.y, u32(k));
  workgroupBarrier();
  let D = kf * kf * kf * (pref - z0) - sum;
  gS = s + D * bumpW(gA, k) * bumpW(gB, k) / (kf * kf / 4.0);
  let kk = kf * kf;
  let w = bumpW(gA, k) * bumpW(gB, k);
  var red = vec4<f32>(0.0);
  for (var t = 0u; t < 4u; t++) {
    // (the block's children inside; the sum of their samples; then the home children's tops and bump weights)
    let home = 2.0 * red.x > kk || (2.0 * red.x == kk && red.y > 0.0);
    let isHome = sd == home;
    shv[li] = select(select(select(se, w, t == 3u), 0.0, t >= 2u && !isHome), select(cdv, select(0.0, 1.0, sd), t == 0u), t < 2u);
    workgroupBarrier();
    red[t] = blockSum(lid.x, lid.y, u32(k));
    workgroupBarrier();
  }
  gSe = gS;
  if (useE) {
    let home = 2.0 * red.x > kk || (2.0 * red.x == kk && red.y > 0.0);
    gSe = se;
    if (sd == home) { gSe = se + (select(kk - red.x, red.x, home) * (pref - z0) * kf - red.z) * w / red.w; }
  }
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
  gAnyRes = false;
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
  let maxN = wgMax(li, select(liveN, finalN, gAct));
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
    // (bit 0: some residual of the chunk is not zero; bit 1: some column of the chunk lies outside the rect, left alone)
    let flags = wgOr(li,select(0u, 1u, gAnyRes || (gAct && gWhole)) | select(2u, 0u, gAct));
    let any = flags & 1u;
    let others = flags & 2u;
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
  let maxN = wgMax(li, n);
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
  // (round 24, edge-aware enhance's restrict: the oracle's homeTop) the same loop gathers the top's line (restrictEdge's
  // maths for the top interval: the children of n intervals with a sample) and each child's top and side (its own
  // sample's sign; 0 none, 1 inside, 2 outside: those without one are placed by the line after the loop)
  let eOn = (u.e.w & 8) != 0;
  var tops: array<f32, 64>;
  var sides: array<u32, 64>;
  var sN = vec2<f32>(0.0);
  var sP = vec2<f32>(0.0);
  var sC = 0.0;
  var dSum = 0.0;
  for (var b = 0; b < k; b++) {
    for (var a = 0; a < k; a++) {
      let c = vec2<i32>(X * k + a, Y * k + b);
      let cn = colCount(L, c.x, c.y);
      let t = topS(L, c.x, c.y, cn);
      ss += t;
      if (eOn) {
        let ci = b * k + a;
        tops[ci] = t;
        sides[ci] = 0u;
        let e = ivlAt(L, c.x, c.y, max(cn, 1u) - 1u).m & EDGE_MASK;
        if ((e & EDGE_ON) != 0u) {
          let d = edgeD(e);
          dSum += d;
          sides[ci] = select(2u, 1u, d > 0.0);
          if (cn == n) {
            let an = edgeAng(e);
            let nn = vec2<f32>(cos(an), sin(an));
            sN += nn;
            sP += vec2<f32>((f32(a) + 0.5) / kf - 0.5, (f32(b) + 0.5) / kf - 0.5) + (d / kf) * nn;
            sC += 1.0;
          }
        }
      }
    }
  }
  var z = zOrigin(L) + ss * inv;
  // where the parent's top keeps a line, its top is the mean of its home children's; the top interval's z0 and every
  // bound below as before
  let sl = length(sN);
  // (the line as stored: quantised as restrictEdge's, none past the range, so a child without a sample is placed as the
  // stored line places it)
  var te = 0u;
  if (eOn && sC > 0.0 && sl >= 0.5 * sC) { te = edgeEncA(atan2(sN.y / sl, sN.x / sl), dot(sN / sl, sP) / sC); }
  let useH = (te & EDGE_ON) != 0u;
  var zH = z;
  if (useH) {
    let an = edgeAng(te);
    let nQ = vec2<f32>(cos(an), sin(an));
    var nIn = 0.0;
    var tIn = 0.0;
    var tOut = 0.0;
    for (var ci = 0; ci < k * k; ci++) {
      var sd = sides[ci] == 1u;
      if (sides[ci] == 0u) { sd = edgeD(te) - dot(nQ, vec2<f32>((f32(ci % k) + 0.5) / kf - 0.5, (f32(ci / k) + 0.5) / kf - 0.5)) > 0.0; }
      if (sd) {
        nIn += 1.0;
        tIn += tops[ci];
      } else { tOut += tops[ci]; }
    }
    let kk = kf * kf;
    let home = 2.0 * nIn > kk || (2.0 * nIn == kk && dSum > 0.0);
    zH = zOrigin(L) + select(tOut / (kk - nIn), tIn / nIn, home) / kf;
  }
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
      setIvl(T, X, Y, i, z - th * inv, select(z, max(z - th * inv, zH), useH && i + 1u == n), (ivlAt(L, tpl.x, tpl.y, i).m & 0xffu) | restrictEdge(L, X, Y, k, i, n));
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
      setIvl(T, X, Y, i, z - th, select(z, max(z - th, zH), useH && i + 1u == n), (iv.m & 0xffu) | restrictEdge(L, X, Y, k, i, n));
      z = z - th - gap;
    }
  }
  setIvl(T, X, Y, 0u, OPEN_BOTTOM, select(z, zH, useH && n <= 1u), (ivlAt(L, tpl.x, tpl.y, 0u).m & 0xffu) | restrictEdge(L, X, Y, k, 0u, n));
}
/** (round 22) restrict: a parent interval's edge from its k x k children of n intervals that keep one, in row order: the
 *  mean normal (normalised) and the mean of the children's line points projected on it (edge.ts edgeFromChildren) */
fn restrictEdge(L: u32, X: i32, Y: i32, k: i32, i: u32, n: u32) -> u32 {
  let kf = f32(k);
  var s = vec2<f32>(0.0);
  var pt = vec2<f32>(0.0);
  var c = 0.0;
  for (var b = 0; b < k; b++) {
    for (var a = 0; a < k; a++) {
      let cX = X * k + a;
      let cY = Y * k + b;
      if (colCount(L, cX, cY) != n) { continue; }
      let e = ivlAt(L, cX, cY, i).m & EDGE_MASK;
      if ((e & EDGE_ON) == 0u) { continue; }
      let an = edgeAng(e);
      let nn = vec2<f32>(cos(an), sin(an));
      s += nn;
      pt += vec2<f32>((f32(a) + 0.5) / kf - 0.5, (f32(b) + 0.5) / kf - 0.5) + (edgeD(e) / kf) * nn;
      c += 1.0;
    }
  }
  let l = length(s);
  // (no line where the normals spread too far: a feature smaller than the parent's cell; edge.ts edgeFromChildren)
  if (c == 0.0 || l < 0.5 * c) { return 0u; }
  let nn = s / l;
  return edgeEncA(atan2(nn.y, nn.x), dot(nn, pt) / c);
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
  let maxN = wgMax(li, n);
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
  // (mode 8, round 14: the smooth draw's cache pages only, when it is switched off)
  if (u.a.z == 7u) {
    if (lid != SNAP_ID + u.a.w) { return; }
  } else if (u.a.z == 8u) {
    if (lid != 48u + u.a.w) { return; }
  } else if (u.a.z == 9u) {
    // (mode 9, round 18: the box draw's face pages only, when the smooth draw is switched on)
    if (lid != FACE_ID + u.a.w) { return; }
  } else if (lid != u.a.w && lid != FACE_ID + u.a.w && lid != SNAP_ID + u.a.w && lid != TMP_ID + u.a.w && lid != 48u + u.a.w) { return; }
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
    // (one word, one writer: 0 when the snapshot exists already, else the chunk's page stack's depth)
    var n = 0u;
    loop {
      if (pageOf(L, cx, cy, n) >= NOT_LOADED) { break; }
      n++;
    }
    wflag = select(n, 0u, pageOf(SNAP_ID + L, cx, cy, 0u) < NOT_LOADED);
  }
  let n = workgroupUniformLoad(&wflag);
  if (n == 0u) { return; }
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
/** (round 22) the columns round a ball's outline whose edge sample is written (oracle.ts EDGE_PAD) */
const EDGE_PAD: i32 = 3;
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
  // (round 22) a ball's box grows by EDGE_PAD: the columns round its outline get the edge sample too (oracle.ts edit)
  if (u.a.z == 4u || u.a.z == 5u) { box += vec4<i32>(-EDGE_PAD, -EDGE_PAD, EDGE_PAD, EDGE_PAD); }
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
  let need = (wgMax(li, select(0u, n, act)) + K - 1u) / K;
  if (li == 0u && need > 0u) { ensurePages(T, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!act) { return; }
  // (the column's solid view copied into TMP and moved there; pack writes it back, dropping emptied intervals)
  tmpCopy(L, X, Y, n, need);
  let a = bitcast<f32>(reg[12]) * p;
  if (u.a.z == 1u) {
    let t = ivlAt(T, X, Y, n - 1u);
    // (round 22) a top this moves loses its edge sample (raise and dig make no sharp edge)
    setIvl(T, X, Y, n - 1u, t.z0, t.z1 + a, t.m & 0xffu);
    return;
  }
  let top = ivlAt(T, X, Y, n - 1u).z1 - a;
  for (var i = n; i > 0u; i--) {
    let t = ivlAt(T, X, Y, i - 1u);
    if (t.z1 <= top) { break; }
    var z0 = t.z0;
    if (i > 1u && z0 > top) { z0 = top; }
    setIvl(T, X, Y, i - 1u, z0, top, t.m & 0xffu);
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
  // (round 22) the column's edge sample (from its original top): written to its topmost interval, also where the ball
  // does not touch the column (the uncarved side of a rim)
  var es = 0u;
  if (inBox(X, Y, box) && n > 0u) { es = ballEdgeAt(X, Y, L, ivlAt(L, X, Y, n - 1u).z1); }
  let act = hit || es != 0u;
  var nn = n;
  if (hit) { nn = ballCount(L, X, Y, n, sp.x, sp.y, add); }
  let maxN = wgMax(li, select(0u, max(n, nn), act));
  let need = (maxN + K - 1u) / K;
  // the ball works on the column's solid view copied into TMP (in place there, as before the partition); pack then
  // writes the partition: Carve leaves air over the span, Add soil, and soil touching soil merges
  let T = TMP_ID + L;
  if (li == 0u && need > 0u) { ensurePages(T, cx, cy, need, u.d.x); }
  storageBarrier();
  workgroupBarrier();
  if (!act) { return; }
  tmpCopy(L, X, Y, n, need);
  if (hit) { ballCol(L, X, Y, n, nn, need, sp.x, sp.y, add); }
  // (round 22) the topmost interval's edge: the sample where there is one, else what the ball left (none where it
  // changed that top: ballCol clears it; the old one where it did not)
  if (es != 0u) {
    let t = ivlAt(T, X, Y, nn - 1u);
    setIvl(T, X, Y, nn - 1u, t.z0, t.z1, (t.m & 0xffu) | es);
  }
}
/** (round 22) the ball's edge sample for column (X, Y) at height zr (its original top): over the stroke's balls (the
 *  centres ballSpan samples) the largest R_b(zr) - rho_b (R_b: the radius where ball b cuts height zr; rho_b: the
 *  column's horizontal distance from its centre) with that ball's outward normal; 0 where no ball reaches zr or the line
 *  is past the range (oracle.ts ballSample, one ball) */
fn ballEdgeAt(X: i32, Y: i32, L: u32, zr: f32) -> u32 {
  let w = u.lv[L];
  let c1 = vec3<f32>(f32(w.x) + bitcast<f32>(reg[9]), f32(w.y) + bitcast<f32>(reg[10]), bitcast<f32>(reg[13]));
  var c0 = c1;
  if ((u.r.z & STROKE) != 0u) { c0 = vec3<f32>(f32(w.x) + cam[305], f32(w.y) + cam[306], cam[307]); }
  let r = bitcast<f32>(reg[11]);
  let q = vec2<f32>(f32(X) + 0.5, f32(Y) + 0.5);
  let steps = u32(clamp(ceil(length(c1 - c0) / (0.25 * r)), 0.0, 256.0));
  var best = -1e30;
  var nb = vec2<f32>(1.0, 0.0);
  for (var i = 0u; i <= steps; i++) {
    let c = mix(c0, c1, select(1.0, f32(i) / f32(steps), steps > 0u));
    let dz = zr - c.z;
    if (!(abs(dz) < r)) { continue; }
    let dv = q - c.xy;
    let rho = length(dv);
    let dd = sqrt(r * r - dz * dz) - rho;
    if (dd > best) {
      best = dd;
      nb = select(vec2<f32>(1.0, 0.0), dv / rho, rho > 0.0);
    }
  }
  if (best < -1e29) { return 0u; }
  return edgeEncA(atan2(nb.y, nb.x), best);
}
/** a hit column's ball in TMP (the column copied there): carve or add over [lo, hi], nn intervals after */
fn ballCol(L: u32, X: i32, Y: i32, n: u32, nn: u32, need: u32, lo: f32, hi: f32, add: bool) {
  let T = TMP_ID + L;
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
      // (round 22: a top the ball made has no edge; one it left keeps its own)
      setIvl(T, X, Y, u32(iF), f.z0, lo, f.m & 0xffu);
      setIvl(T, X, Y, u32(iF + 1), hi, f.z1, f.m);
    } else {
      var w = iF;
      if (f.z0 < lo) {
        setIvl(T, X, Y, u32(w), f.z0, lo, f.m & 0xffu);
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

// ---- (round 10) a material write clears what finer levels kept under it. The owner: "I expect boolean deletion to
// delete parents and all children in those sub cells". A carve or add at level d rewrites the columns its ball covers;
// every finer level's kept residual (live or dropped) under those columns is let go, so there the finer level is
// enhance(parent) again: what a finer edit had made (a tunnel's roof, a blob) cannot come back over the new parent, at a
// promote or at the derive that follows this edit. One thread a table entry: residual pages of depths below d.
@compute @workgroup_size(64)
fn resClear(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let d = reg[8];
  if (d < 0) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 >= BUSY) { return; }
  let lid = k1 & 0xffu;
  if (lid <= RES_ID + u32(d) || lid >= RES_ID + 8u) { return; }
  let p = atomicLoad(&tab[s * 4u + 2u]);
  if (p >= NOT_LOADED) { return; }
  let k0 = atomicLoad(&tab[s * 4u]);
  let cx = i32(k0 & 0xffffu);
  let cy = i32(k0 >> 16u);
  // the chunk's columns on level d: global column / k^(m - d)
  var sc = 1;
  for (var m = u32(d); m < lid - RES_ID; m++) { sc *= i32(u.a.x); }
  let slot = slotOf(d, 3);
  let box = vec4<i32>(slotW(slot, 0u), slotW(slot, 1u), slotW(slot, 2u), slotW(slot, 3u));
  if (fdiv(cx * 16 + 15, sc) < box.x || fdiv(cy * 16 + 15, sc) < box.y || fdiv(cx * 16, sc) >= box.z || fdiv(cy * 16, sc) >= box.w) { return; }
  var left = 0u;
  for (var c = 0u; c < 256u; c++) {
    if ((pgLoad(p * PW + c) & 0xffffu) == 0u) { continue; }
    let ax = fdiv(cx * 16 + i32(c & 15u), sc);
    let ay = fdiv(cy * 16 + i32(c >> 4u), sc);
    if (inBox(ax, ay, box) && ballSpan(ax, ay, u32(d)).z > 0.0) { pgStore(p * PW + c, 0u); } else { left++; }
  }
  // (a page left with no column is let go, as a residual pass leaves no page where nothing differs)
  if (left == 0u) {
    freePage(p);
    atomicStore(&tab[s * 4u + 1u], TOMB);
  }
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
  for (var i = 0u; i < n; i++) { h = h * 31u + (ivlAt(L, X, Y, i).m & 0xffu); }
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
  let need = (wgMax(li, n) + K - 1u) / K;
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
    // (round 22) a top melt moves loses its edge sample
    setIvl(L, X, Y, 0u, t.z0, base, select(t.m & 0xffu, t.m, base == t.z1));
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
    setIvl(L, X, Y, i, z0, z0 + th, select(t.m & 0xffu, t.m, z0 + th == t.z1));
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
  // (each thread's nearest per level, then a min over the workgroup: NS-86, no workgroup atomics; distances are
  // non-negative, so their bits order as the floats do)
  var wD: array<f32, 8>;
  for (var m = 0u; m < 8u; m++) {
    var dmin = FAR;
    let e = wEye[m];
    if (m < live && e.w >= 0.5) {
      let w = u.lv[m];
      let ex = w.x + i32(floor(e.x)) - CAM_R;
      let ey = w.y + i32(floor(e.y)) - CAM_R;
      for (var idx = li; idx < side * side; idx += 256u) {
        let X = ex + i32(idx % side);
        let Y = ey + i32(idx / side);
        if (X < w.x || Y < w.y || X >= w.x + w.z || Y >= w.y + w.z) { continue; }
        let dd = colDist(m, X, Y, w, e.xyz);
        if (dd < dmin) { dmin = dd; }
      }
    }
    wD[m] = bitcast<f32>(wgMin(li, bitcast<u32>(dmin)));
  }
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
    raw = wD[m];
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
// touches the line, so no T-junction is left. There is no world bottom (round 8): a column's box ends at its own depth
// (zbOf, below), closed by a down cap, so every level's face set is closed.
// The owner's rule stands: "nothing per frame": an op bakes its changed chunks (grown by one), a frame only draws.
@group(0) @binding(8) var<storage, read_write> dir: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> dargs: array<u32>;

/** the level's cz 0 column pages of the 3 x 3 chunks round the baked one, and the baked chunk's face pages cz 0..7 */
var<workgroup> wPg: array<u32, 9>;
var<workgroup> wFp: array<u32, 8>;
var<private> bOrg: vec2<i32>;
var<private> bChunk: vec2<i32>;

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
// ---- (round 8) no world bottom: a drawn column's box ends at its own depth -------------------------------------------
// The world is stone below and open-ended (the owner: "I would expect to never see open sky that direction"). A face
// exists only where solid touches air, and under the lowest air its four neighbours can show it a column is solid on
// every side, so its box ends there: zb = min(its first record's top, each neighbour's depth as seen from it) - 1, closed
// by a down cap. A neighbour's depth is its first record's top, taken from the level that draws there: outside a child's
// window the parent's column, under a child's footprint the k child columns along the shared side. So the two levels'
// walls at a rim reach as deep as the air on either side, at any dig depth (round 7 and before: a fixed bottom plane per
// level, root -8, a child -2 x its window; a pit dug below it showed the sky under its neighbours).
const NO_DEPTH: f32 = 3e38;
/** the top of the first record of column (X, Y) of level `lv`, from its pages (its own units; NO_DEPTH: none) */
fn rec0Of(lv: u32, X: i32, Y: i32) -> f32 {
  let p = pageOf(lv, X >> 4, Y >> 4, 0u);
  if (p >= NOT_LOADED) { return NO_DEPTH; }
  if ((pgLoad(p * PW + colIn(X, Y)) & 0xffffu) == 0u) { return NO_DEPTH; }
  return bitcast<f32>(pgLoad(p * PW + 256u + colIn(X, Y) * KR * 2u));
}
fn fdiv(a: i32, b: i32) -> i32 { return i32(floor(f32(a) / f32(b))); }
/** the depth of what is drawn at (NX, NY), a neighbour of drawn column (X, Y) of level L that L does not draw, in L's
 *  units: outside L's window, the parent's column there; under L's child's footprint, the lowest of the child's k
 *  columns along the side facing (X, Y) (a child's window lies k + 2 cells inside a non-root parent, so those child
 *  columns are drawn by the child itself) */
fn depthElsewhere(L: u32, X: i32, Y: i32, NX: i32, NY: i32) -> f32 {
  let k = i32(u.a.x);
  let kf = f32(u.a.x);
  if (!inWin(L, NX, NY)) {
    if (L == 0u) { return NO_DEPTH; }
    let t = rec0Of(L - 1u, fdiv(NX, k), fdiv(NY, k));
    if (t >= NO_DEPTH) { return NO_DEPTH; }
    return (t - zOrigin(L)) * kf;
  }
  var cx = NX * k;
  var cy = NY * k;
  var dx = 0;
  var dy = 0;
  if (X > NX) {
    cx = NX * k + k - 1;
    dy = 1;
  } else if (X < NX) {
    dy = 1;
  } else if (Y > NY) {
    cy = NY * k + k - 1;
    dx = 1;
  } else {
    dx = 1;
  }
  var m = NO_DEPTH;
  for (var i = 0; i < k; i++) { m = min(m, rec0Of(L + 1u, cx + i * dx, cy + i * dy)); }
  if (m >= NO_DEPTH) { return NO_DEPTH; }
  return zOrigin(L + 1u) + m / kf;
}
/** a drawn column's bottom from its own first record's top and its four neighbours' depths: a column under them, on a
 *  lattice of ZB_STEP units so that neighbouring bottoms mostly agree (no walls between them under the ground) */
const ZB_STEP: f32 = 32.0;
fn zbOf(t0: f32, n0: f32, n1: f32, n2: f32, n3: f32) -> f32 {
  return floor((min(min(t0, min(n0, n1)), min(n2, n3)) - 1.0) / ZB_STEP) * ZB_STEP;
}
/** a neighbour's depth as seen from drawn column (X, Y) of level L, from the pages */
fn nbDepthG(L: u32, X: i32, Y: i32, NX: i32, NY: i32) -> f32 {
  if (colOn(L, NX, NY)) { return rec0Of(L, NX, NY); }
  return depthElsewhere(L, X, Y, NX, NY);
}
/** a drawn column's bottom, from the pages (the workgroup's copy computes the same values: bFill) */
fn zbG(L: u32, X: i32, Y: i32) -> f32 {
  return zbOf(rec0Of(L, X, Y), nbDepthG(L, X, Y, X + 1, Y), nbDepthG(L, X, Y, X - 1, Y), nbDepthG(L, X, Y, X, Y + 1), nbDepthG(L, X, Y, X, Y - 1));
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
  bFillRecs(L, cx, cy, li);
  bFillBottoms(L, li);
}
/** (round 19: the sheet pass needs only this part) the counts and first SC records of the columns round chunk (cx, cy) */
fn bFillRecs(L: u32, cx: i32, cy: i32, li: u32) {
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
  }
  workgroupBarrier();
}
/** the box draw's part: each drawn column's bottom and the shared down caps */
fn bFillBottoms(L: u32, li: u32) {
  // (round 8) each drawn column's bottom from its own and its neighbours' depths (zbG's values, from the copy)
  for (var q = li; q < 324u; q += 256u) {
    let X = sOrg.x + i32(q % 18u);
    let Y = sOrg.y + i32(q / 18u);
    sB[q] = 0.0;
    if (sN[q] > 0u) { sB[q] = zbOf(sT[q * SC], nbDepthC(L, X, Y, X + 1, Y), nbDepthC(L, X, Y, X - 1, Y), nbDepthC(L, X, Y, X, Y + 1), nbDepthC(L, X, Y, X, Y - 1)); }
  }
  workgroupBarrier();
  // (round 9, NS-83) which 4 x 4 blocks of the chunk, and whether the whole chunk, have one down cap: every column drawn,
  // its first record solid, the same bottom (one writer a word: thread b for block b, then thread 0 for the chunk)
  if (li < 16u) {
    let bx = sOrg.x + 1 + i32(li % 4u) * 4;
    let by = sOrg.y + 1 + i32(li / 4u) * 4;
    let z = sB[u32(sIdx(bx, by))];
    var ok = 1u;
    for (var q = 0; q < 16; q++) {
      let i = u32(sIdx(bx + q % 4, by + q / 4));
      if (sN[i] == 0u || !matSolid(sM[i] & 255u) || sB[i] != z) { ok = 0u; }
    }
    // (round 11, NS-97) no fan where the block touches a rim line (those down-cap vertices go in the child's units, one by
    // one: a fan has one z): the block's corner lines along its edge
    for (var e = 0; e <= 4; e++) {
      if (rimP(L, bx + e, by) || rimP(L, bx + e, by + 4) || rimP(L, bx, by + e) || rimP(L, bx + 4, by + e)) { ok = 0u; }
    }
    sBlk[li] = ok;
  }
  workgroupBarrier();
  if (li == 0u) {
    var ok = 1u;
    let z = sB[u32(sIdx(sOrg.x + 1, sOrg.y + 1))];
    for (var b = 0; b < 16; b++) {
      if (sBlk[b] == 0u || sB[u32(sIdx(sOrg.x + 1 + (b % 4) * 4, sOrg.y + 1 + (b / 4) * 4))] != z) { ok = 0u; }
    }
    sBlk[16] = ok;
  }
  workgroupBarrier();
}
/** (round 9, NS-83) 1 where a 4 x 4 block of the chunk (0-15) or the whole chunk (16) shares one down cap */
var<workgroup> sBlk: array<u32, 17>;
/** nbDepthG through the workgroup's copy where it holds the neighbour's records */
fn nbDepthC(L: u32, X: i32, Y: i32, NX: i32, NY: i32) -> f32 {
  let i = sIdx(NX, NY);
  if (i >= 0 && sN[i] > 0u) { return sT[u32(i) * SC]; }
  return nbDepthG(L, X, Y, NX, NY);
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
/** a drawn column's bottom (round 8: its own depth, zbG) */
fn bBot(L: u32, X: i32, Y: i32) -> f32 {
  let i = sIdx(X, Y);
  if (i >= 0) { return sB[i]; }
  return zbG(L, X, Y);
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
    // (round 15, NS-116) the first record whose top is above z, by a binary search (a column's tops rise with j): the
    // linear scan made every wall step O(records), a wall O(records^2), with a hash lookup a record past the first page;
    // a dug world's 60-record columns took ~300 ms a chunk, boxes and smooth alike
    var lo = 0u;
    var hi = n;
    loop {
      if (lo >= hi) { break; }
      let mid = (lo + hi) / 2u;
      if (bitcast<f32>(bRec(L, X, Y, mid).x) > z) { hi = mid; } else { lo = mid + 1u; }
    }
    if (lo < n) { best = min(best, bitcast<f32>(bRec(L, X, Y, lo).x)); }
  }
  return best;
}
// ---- (round 11, NS-97) rim lines: one vertex arithmetic for both levels ---------------------------------------------
// A rim line is a corner line both a parent and its live child draw faces on: a parent corner line on the boundary of the
// child's footprint (k child columns apart along the rim). Before, each level split it at its own breakpoints and placed
// its vertices through its own view-projection, so where a wall crossed the rim (a shaft's wall, coplanar on both
// sides) the two levels' edges along the line differed in their end points and arithmetic, and a pixel centre exactly on
// the line could be missed by both (1 hole pixel in the shaft poses). The rule now: on a rim line every face of both
// levels has a vertex at every breakpoint of both levels' columns round the line, each height in the CHILD's units
// (toKid, the one conversion both bakes use), and the draw places those vertices through the child's view-projection
// (draw.wgsl corner: face word bits 25-27 flag them on the parent's faces). So both levels' edges along the line are
// the same segments with bit-identical end points in clip space (up to the exact factor 1 / k), as within one level.
// (round 12, NS-103) The bake is two pipelines of faceBake: BAKE_RIM false for the chunks that touch no rim line (no rim
// code compiled in: the round 10 bake), true for the chunks that do (chunkRim). Both run over every bake slot; each skips
// the other's chunks. The rim rule's code made every chunk's bake slower, rim or not.
override BAKE_RIM: bool = false;
/** (measurement only: false with BAKE_RIM true is round 11's one bake for every chunk, GpuNest.splitBake false) */
override BAKE_SPLIT: bool = true;
/** whether any corner line of chunk (cx, cy) of level L (lines cx * 16 .. cx * 16 + 16) is a rim line (rimP or rimC) */
fn chunkRim(L: u32, cx: i32, cy: i32) -> bool {
  // (u.e.w bit 0: rimOff; bit 1, round 22: ?rimtop=1 in the sheet pass; bit 2, round 23: ?rimsnap=1)
  if ((u.e.w & 1) != 0) { return false; }
  let a0 = cx * 16;
  let b0 = cy * 16;
  let a1 = a0 + 16;
  let b1 = b0 + 16;
  let k = i32(u.a.x);
  if (L + 1u < 8u && u.lv[L + 1u].w != 0) {
    let c = u.lv[L + 1u];
    let f0 = vec2<i32>(fdiv(c.x, k), fdiv(c.y, k));
    let f1 = vec2<i32>(fdiv(c.x + c.z, k), fdiv(c.y + c.z, k));
    let meets = a1 >= f0.x && a0 <= f1.x && b1 >= f0.y && b0 <= f1.y;
    let inside = a0 > f0.x && a1 < f1.x && b0 > f0.y && b1 < f1.y;
    if (meets && !inside) { return true; }
  }
  if (L > 0u) {
    let w = u.lv[L];
    if (a0 == w.x || b0 == w.y || a1 == w.x + w.z || b1 == w.y + w.z) { return true; }
  }
  return false;
}
/** whether corner line (CX, CY) of level L lies on the boundary of its live child's footprint */
fn rimP(L: u32, CX: i32, CY: i32) -> bool {
  // (u.e.w: GpuNest.rimOff, the cost A/B only)
  if (!BAKE_RIM || L + 1u >= 8u || u.lv[L + 1u].w == 0 || (u.e.w & 1) != 0) { return false; }
  let c = u.lv[L + 1u];
  let k = i32(u.a.x);
  let x = CX * k;
  let y = CY * k;
  if (x < c.x || y < c.y || x > c.x + c.z || y > c.y + c.z) { return false; }
  return x == c.x || y == c.y || x == c.x + c.z || y == c.y + c.z;
}
/** whether corner line (cx, cy) of level L (a child) is a rim line: on its window's boundary and a parent corner line */
fn rimC(L: u32, cx: i32, cy: i32) -> bool {
  if (!BAKE_RIM || L == 0u || (u.e.w & 1) != 0) { return false; }
  let w = u.lv[L];
  let k = i32(u.a.x);
  if (cx < w.x || cy < w.y || cx > w.x + w.z || cy > w.y + w.z) { return false; }
  if (cx - fdiv(cx, k) * k != 0 || cy - fdiv(cy, k) * k != 0) { return false; }
  return cx == w.x || cy == w.y || cx == w.x + w.z || cy == w.y + w.z;
}
/** a height of level L in its child's units: the one conversion every rim vertex goes through */
fn toKid(L: u32, z: f32) -> f32 { return (z - zOrigin(L + 1u)) * f32(u.a.x); }
/** a drawn column of any level: its record count, from the pages (not the bake's workgroup copy) */
fn oCount(lv: u32, X: i32, Y: i32) -> u32 {
  if (!colOn(lv, X, Y)) { return 0u; }
  var n = 0u;
  var cz = 0u;
  loop {
    let p = pageOf(lv, X >> 4, Y >> 4, cz);
    if (p >= NOT_LOADED) { break; }
    let m = pgLoad(p * PW + colIn(X, Y)) & 0xffffu;
    n += m;
    if (m < KR) { break; }
    cz++;
  }
  return n;
}
fn oTop(lv: u32, X: i32, Y: i32, j: u32) -> f32 {
  let p = pageOf(lv, X >> 4, Y >> 4, j / KR);
  if (p >= NOT_LOADED) { return 0.0; }
  return bitcast<f32>(pgLoad(p * PW + 256u + (colIn(X, Y) * KR + j % KR) * 2u));
}
/** the lowest breakpoint above zc on a rim line, child level Lk's corner line (cx, cy), in Lk's units: a record top or a
 *  bottom of the child's columns round it and of the parent's columns round the same line (converted by toKid). Both
 *  levels' bakes call it with the same arguments. */
fn nextBpRim(Lk: u32, cx: i32, cy: i32, zc: f32, ob: vec4<f32>) -> f32 {
  var best = 3e38;
  let k = i32(u.a.x);
  for (var s = 0u; s < 2u; s++) {
    let lv = Lk - s;
    var lx = cx;
    var ly = cy;
    if (s == 1u) {
      lx = fdiv(cx, k);
      ly = fdiv(cy, k);
    }
    // (the baked level's own columns through the bake's workgroup copy: the same values, far cheaper)
    let own = lv == u.a.w;
    for (var q = 0; q < 4; q++) {
      let X = lx - 1 + (q & 1);
      let Y = ly - 1 + (q >> 1);
      var n = 0u;
      if (own) { n = bCount(lv, X, Y); } else { n = oCount(lv, X, Y); }
      if (n == 0u) { continue; }
      // (the bottom lies under the first top: needed only while zc is under that top; zbG reads many pages)
      var t0 = 0.0;
      if (own) { t0 = bitcast<f32>(bRec(lv, X, Y, 0u).x); } else { t0 = oTop(lv, X, Y, 0u); }
      if (s == 1u) { t0 = toKid(lv, t0); }
      if (t0 > zc) {
        var b = ob[q];
        if (own) {
          b = bBot(lv, X, Y);
          if (s == 1u) { b = toKid(lv, b); }
        }
        if (b > zc) { best = min(best, b); }
      }
      // (round 15, NS-116) the first top above zc by a binary search, as nextBp (toKid keeps the order)
      var lo = 0u;
      var hi = n;
      loop {
        if (lo >= hi) { break; }
        let mid = (lo + hi) / 2u;
        if (rimTop(own, s, lv, X, Y, mid) > zc) { hi = mid; } else { lo = mid + 1u; }
      }
      if (lo < n) { best = min(best, rimTop(own, s, lv, X, Y, lo)); }
    }
  }
  return best;
}
/** a rim line column's record top in the child's units (nextBpRim) */
fn rimTop(own: bool, s: u32, lv: u32, X: i32, Y: i32, j: u32) -> f32 {
  var t = 0.0;
  if (own) { t = bitcast<f32>(bRec(lv, X, Y, j).x); } else { t = oTop(lv, X, Y, j); }
  if (s == 1u) { t = toKid(lv, t); }
  return t;
}
/** the bottoms of the OTHER level's four columns round a rim line (as nextBpRim reads them, converted; 3e38 where not
 *  drawn): zbG reads many pages, so a wall side computes them once, not at every step of its strip */
fn rimOther(Lk: u32, cx: i32, cy: i32) -> vec4<f32> {
  var ob = vec4<f32>(3e38);
  let k = i32(u.a.x);
  let s = select(1u, 0u, Lk != u.a.w);
  let lv = Lk - s;
  var lx = cx;
  var ly = cy;
  if (s == 1u) {
    lx = fdiv(cx, k);
    ly = fdiv(cy, k);
  }
  for (var q = 0; q < 4; q++) {
    let X = lx - 1 + (q & 1);
    let Y = ly - 1 + (q >> 1);
    if (oCount(lv, X, Y) == 0u) { continue; }
    var b = zbG(lv, X, Y);
    if (s == 1u) { b = toKid(lv, b); }
    ob[q] = b;
  }
  return ob;
}
/** a wall side's corner line: 0 an ordinary line, 1 a rim line of the parent (heights in the child's units, flagged),
 *  2 a rim line of the child (its own units, split as the rim) */
fn rimMode(L: u32, CX: i32, CY: i32) -> u32 {
  if (rimP(L, CX, CY)) { return 1u; }
  if (rimC(L, CX, CY)) { return 2u; }
  return 0u;
}
/** a side's height back in the level's own units (only to order the two sides' steps) */
fn sideOwn(L: u32, mode: u32, z: f32) -> f32 {
  if (mode == 1u) { return zOrigin(L + 1u) + z / f32(u.a.x); }
  return z;
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
/** a triangle's four words as given (a down-cap fan: kind 6) */
fn putTriRaw(t: u32, w0: u32, w1: u32, w2: u32, w3: u32) {
  var p = NONE;
  let cz = t / TPP;
  if (cz < 8u) { p = wFp[cz]; } else { p = pageOf(FACE_ID + u.a.w, bChunk.x, bChunk.y, cz); }
  if (p >= NOT_LOADED) { return; }
  let b = p * PW + FHDR + (t % TPP) * 4u;
  pgStore(b, w0);
  pgStore(b + 1u, w1);
  pgStore(b + 2u, w2);
  pgStore(b + 3u, w3);
}
/** point i of the rim of the s x s square at chunk column (ox, oy), anticlockwise from its corner, as x | y << 5 (chunk
 *  units, 0..16) */
fn fanPt(ox: u32, oy: u32, s: u32, i: u32) -> u32 {
  let e = i / s;
  let k = i % s;
  var x = ox + k;
  var y = oy;
  if (e == 1u) {
    x = ox + s;
    y = oy + k;
  } else if (e == 2u) {
    x = ox + s - k;
    y = oy + s;
  } else if (e == 3u) {
    x = ox;
    y = oy + s - k;
  }
  return x | (y << 5u);
}
/** a column's faces: counted, or written from index `at` (returns the count). Caps where a solid record meets air above
 *  or below; for each side, each solid record's height range less the neighbour's solid, as strips between the two
 *  corner lines' breakpoints. */
fn emitCol(L: u32, X: i32, Y: i32, write: bool, at: u32) -> u32 {
  let n = bCount(L, X, Y);
  if (n == 0u) { return 0u; }
  let lxy = u32(X & 15) | (u32(Y & 15) << 4u);
  let zb = bBot(L, X, Y);
  var t = 0u;
  // (round 11, NS-97) which of the column's corners lie on a rim line of its child: those vertices are written in the
  // child's units and flagged (bits 25-27, one a vertex), so both levels place them by the same arithmetic
  let rp = vec4<bool>(rimP(L, X, Y), rimP(L, X + 1, Y), rimP(L, X, Y + 1), rimP(L, X + 1, Y + 1));
  let rz = vec4<u32>(select(0u, 1u, rp.x), select(0u, 1u, rp.y), select(0u, 1u, rp.z), select(0u, 1u, rp.w));
  let f013 = (rz.x << 25u) | (rz.y << 26u) | (rz.w << 27u);
  let f032 = (rz.x << 25u) | (rz.w << 26u) | (rz.z << 27u);
  // caps: (j, j + 1) for j < n (above the last record: air); and the down cap where the column's box ends (round 8)
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
      let zk = select(z, toKid(L, z), any(rp));
      putTri(at + t, w | (0u << 19u) | (1u << 21u) | (3u << 23u) | f013, select(z, zk, rp.x), select(z, zk, rp.y), select(z, zk, rp.w));
      putTri(at + t + 1u, w | (0u << 19u) | (3u << 21u) | (2u << 23u) | f032, select(z, zk, rp.x), select(z, zk, rp.w), select(z, zk, rp.z));
    }
    t += 2u;
  }
  let r0 = bRec(L, X, Y, 0u);
  if (matSolid(r0.y)) {
    // (round 9, NS-83) the down cap: never seen (under it the ground is solid on every side), there only to close the
    // box. Where the whole chunk, or the column's 4 x 4 block, shares one bottom, its first column bakes one fan for it:
    // a centre and every column corner along its rim (so each rim edge is one column long, as the walls and the
    // neighbouring caps there have it: no T-junction), 64 triangles a chunk instead of 512, 16 a block instead of 32
    let lx = u32(X & 15);
    let ly = u32(Y & 15);
    var s = 0u;
    if (sBlk[16] != 0u) {
      if (lx == 0u && ly == 0u) { s = 16u; } else { s = 99u; }
    } else if (sBlk[(ly / 4u) * 4u + lx / 4u] != 0u) {
      if ((lx & 3u) == 0u && (ly & 3u) == 0u) { s = 4u; } else { s = 99u; }
    }
    if (s == 0u) {
      let w = lxy | (5u << 8u) | ((r0.y & 255u) << 11u);
      if (write) {
        let zk = select(zb, toKid(L, zb), any(rp));
        putTri(at + t, w | (0u << 19u) | (1u << 21u) | (3u << 23u) | f013, select(zb, zk, rp.x), select(zb, zk, rp.y), select(zb, zk, rp.w));
        putTri(at + t + 1u, w | (0u << 19u) | (3u << 21u) | (2u << 23u) | f032, select(zb, zk, rp.x), select(zb, zk, rp.w), select(zb, zk, rp.z));
      }
      t += 2u;
    } else if (s != 99u) {
      if (write) {
        let w = lxy | (6u << 8u) | ((r0.y & 255u) << 11u);
        let c = (lx + s / 2u) | ((ly + s / 2u) << 5u);
        for (var i = 0u; i < 4u * s; i++) {
          putTriRaw(at + t + i, w, bitcast<u32>(zb), c | (fanPt(lx, ly, s, i) << 10u), fanPt(lx, ly, s, (i + 1u) % (4u * s)));
        }
      }
      t += 4u * s;
    }
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
    // (round 11, NS-97) a side on a rim line: split at both levels' breakpoints there, the parent's in the child's units
    let mA = rimMode(L, AX, AY);
    let mB = rimMode(L, BX, BY);
    let fA = select(0u, 1u, mA == 1u);
    let fB = select(0u, 1u, mB == 1u);
    // (the other level's bottoms round each rim side, once a wall side; one call site: the compiler inlines it)
    var obs = array<vec4<f32>, 2>(vec4<f32>(3e38), vec4<f32>(3e38));
    for (var s2 = 0u; s2 < 2u; s2++) {
      let m = select(mA, mB, s2 == 1u);
      if (m == 0u) { continue; }
      let up = m == 1u;
      let kk = select(1, i32(u.a.x), up);
      obs[s2] = rimOther(select(L, L + 1u, up), select(AX, BX, s2 == 1u) * kk, select(AY, BY, s2 == 1u) * kk);
    }
    var lo = zb;
    // (round 15, NS-116) the neighbour's scan starts at its first record above this record's bottom (a cursor that only
    // moves up; the records under it are skipped by the scan anyway): restarting at record 0 made a side O(records^2)
    var js = 0u;
    for (var j = 0u; j < n; j++) {
      let r = bRec(L, X, Y, j);
      let hi = bitcast<f32>(r.x);
      if (matSolid(r.y)) {
        let w = lxy | (d << 8u) | ((r.y & 255u) << 11u);
        // the neighbour's solid runs subtracted from [lo, hi], in order
        var cur = lo;
        loop {
          if (js >= nn || bitcast<f32>(bRec(L, NX, NY, js).x) > lo) { break; }
          js++;
        }
        var jn = js;
        var nlo = nb;
        if (js > 0u) { nlo = bitcast<f32>(bRec(L, NX, NY, js - 1u).x); }
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
            // (each side in its own units: a parent's rim side in the child's)
            let eA = select(p1, toKid(L, p1), mA == 1u);
            let eB = select(p1, toKid(L, p1), mB == 1u);
            var za = select(p0, toKid(L, p0), mA == 1u);
            var zc = select(p0, toKid(L, p0), mB == 1u);
            loop {
              if (za >= eA && zc >= eB) { break; }
              // (both sides' next breakpoints from one call site of each finder: the D3D compiler inlines every call,
              // and two copies of the rim finder doubled the bake's time)
              var nx = array<f32, 2>(0.0, 0.0);
              for (var s2 = 0u; s2 < 2u; s2++) {
                let sb = s2 == 1u;
                let m = select(mA, mB, sb);
                let lx = select(AX, BX, sb);
                let ly = select(AY, BY, sb);
                let z = select(za, zc, sb);
                var r = 0.0;
                if (m == 0u) {
                  r = nextBp(L, lx, ly, z);
                } else {
                  let up = m == 1u;
                  let kk = select(1, i32(u.a.x), up);
                  r = nextBpRim(select(L, L + 1u, up), lx * kk, ly * kk, z, obs[s2]);
                }
                nx[s2] = min(r, select(eA, eB, sb));
              }
              let na = nx[0];
              let nc = nx[1];
              if (za < eA && (sideOwn(L, mA, na) <= sideOwn(L, mB, nc) || zc >= eB)) {
                if (write) { putTri(at + t, w | (cA << 19u) | (cB << 21u) | (cA << 23u) | (fA << 25u) | (fB << 26u) | (fA << 27u), za, zc, na); }
                za = na;
              } else {
                if (write) { putTri(at + t, w | (cA << 19u) | (cB << 21u) | (cB << 23u) | (fA << 25u) | (fB << 26u) | (fB << 27u), za, zc, nc); }
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

// ---- the sheet draw's line walk (round 14's helpers kept by the sheet pass; round 18 deleted the round 13-15 cache,
// template, wall list and exception bake: git keeps them) -----------------------------------------------------------
/** the sheet pass's cache pages: level id CACHE_ID + depth */
const CACHE_ID: u32 = 48u;
/** a column round a vertex's corner line: q 0-3 the line's own level's four; on a child's rim line (rimC) q 4-7 the
 *  parent's four round the same line, heights through toKid (s = 1) */
struct LC {
  lv: u32,
  X: i32,
  Y: i32,
  s: u32,
}
// (round 19, NS-136) The sheet pass compiles in one piece on D3D11 (FXC inlines every call): every helper below is
// called from as few places as possible, record reads go through one function each (oRec / sRec), and the walk reads
// each record of a line once from a single call site.
/** record j of a column of any level, from its pages: (top bits, material); (0, air) where the page is missing */
fn oRec(lv: u32, X: i32, Y: i32, j: u32) -> vec2<u32> {
  let p = pageOf(lv, X >> 4, Y >> 4, j / KR);
  if (p >= NOT_LOADED) { return vec2<u32>(0u, MAT_AIR); }
  let b = p * PW + 256u + (colIn(X, Y) * KR + j % KR) * 2u;
  return vec2<u32>(pgLoad(b), pgLoad(b + 1u));
}
/** a drawn column's record count: the baked level's through the workgroup's copy where it holds it, else the pages */
fn sCount(lv: u32, X: i32, Y: i32) -> u32 {
  let i = select(-1, sIdx(X, Y), lv == u.a.w);
  if (i >= 0) { return sN[i]; }
  return oCount(lv, X, Y);
}
/** record j: (top bits, material), through the workgroup's copy where it holds it, else the pages */
fn sRec(lv: u32, X: i32, Y: i32, j: u32) -> vec2<u32> {
  let i = select(-1, sIdx(X, Y), lv == u.a.w);
  // (round 22: the material word whole, its edge sample from sE)
  if (i >= 0 && j < SC) { return vec2<u32>(bitcast<u32>(sT[u32(i) * SC + j]), ((sM[i] >> (8u * j)) & 255u) | sE[u32(i) * SC + j]); }
  return oRec(lv, X, Y, j);
}
/** (round 22, the sheet pass only) the edge samples (material word bits 8-29) of the records bFillRecs copied */
var<workgroup> sE: array<u32, 1296>;
fn sFillEdges(L: u32, li: u32) {
  for (var q = li; q < 324u; q += 256u) {
    let X = sOrg.x + i32(q % 18u);
    let Y = sOrg.y + i32(q / 18u);
    for (var j = 0u; j < SC; j++) {
      var e = 0u;
      if (j < sN[q]) { e = oRec(L, X, Y, j).y & EDGE_MASK; }
      sE[q * SC + j] = e;
    }
  }
  workgroupBarrier();
}
/** the walk's four quadrant columns (q 0-3): who owns it, whether drawn, its record count */
var<private> wkC: array<LC, 4>;
var<private> wkN: array<u32, 4>;
/** per walk column: the next record to read; the solidity and top (line units) of the record before it; the next
 *  surface's height (NO_DEPTH: none left); the solidity just above the walk's last breakpoint */
var<private> wkJ: array<u32, 4>;
var<private> wkS: array<bool, 4>;
var<private> wkT: array<f32, 4>;
var<private> wkX: array<f32, 4>;
var<private> wkA: array<bool, 4>;
/** (round 22) per walk column: the material word of the record before the next one; the edge sample of its pending
 *  surface (wkX; an up surface's, from its solid record; 0 for a down surface) */
var<private> wkW: array<u32, 4>;
var<private> wkE: array<u32, 4>;
/** the chunk's cache page 0 (the sheet pass; bChunk is the chunk) */
var<private> sCp: u32;
/** (round 15, NS-116) the chunk's cluster table pages cz 1..16, looked up once a workgroup (civPages): a long table's
 *  binary search did a hash-table lookup at every probe (a chunk of 46-60 records a column took ~300 ms) */
var<workgroup> wCivP: array<u32, 16>;
fn civPages(li: u32) {
  if (li < 16u) { wCivP[li] = pageOf(CACHE_ID + u.a.w, bChunk.x, bChunk.y, 1u + li); }
  workgroupBarrier();
}
/** the chunk's table index of corner line (CX, CY) (lines -1..17 of the chunk: 0..360) */
fn lnIdx(CX: i32, CY: i32) -> u32 { return u32((CY - bChunk.y * 16 + 1) * 19 + (CX - bChunk.x * 16 + 1)); }
/** (step C) a unit normal as one word (octahedral, 2 x 16-bit snorm) */
fn octEnc(n: vec3<f32>) -> u32 {
  var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { p = (1.0 - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0)); }
  return pack2x16snorm(p);
}
var<workgroup> wCp: u32;

/** (over a slot's chunks) a chunk's faces: counted per column, the chunk's face pages sized, then written (one call
 *  site of emitCol: the D3D11 compiler inlines every call) */
@compute @workgroup_size(16, 16)
fn faceBake(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  // (round 15, NS-116) a banded bake (the smooth draw's): only the slot's chunk row u.e.z - 1
  if (u.e.z != 0 && i32(wid.y) != u.e.z - 1) { return; }
  if (BAKE_SPLIT && chunkRim(L, cx, cy) != BAKE_RIM) { return; }
  if (li < 9u) { wPg[li] = pageOf(L, cx - 1 + i32(li % 3u), cy - 1 + i32(li / 3u), 0u); }
  workgroupBarrier();
  bOrg = vec2<i32>(cx - 1, cy - 1);
  bChunk = vec2<i32>(cx, cy);
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  bFill(L, cx, cy, li);
  var n = 0u;
  var at = 0u;
  for (var ps = 0u; ps < 2u; ps++) {
    if (ps == 1u) {
      // (each column's first triangle: an exclusive scan over the workgroup, NS-86: no workgroup atomics)
      let sc = wgScan(li, n);
      at = sc.x;
      let total = sc.y;
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
// ---- (round 16) the sheet draw: the owner's spec (docs/design/NESTED_SCALES.md "As built (round 16)"; boxmesh.ts
// sheetMesh is the reference, rule for rule). A column's j-th surface (bottom up: every solid/air change of its records)
// is a quad on its four corner lines, drawn by sheet instance j of its chunk; a vertex is a cluster of its corner line
// (the quadrants' owners' surface heights chained while the owners are not all solid or all air between them: every
// wall collapses), placed at the integer mean of its heights. No walls, skirts, down caps or outer ring. Level edges: a
// child's window-edge lines see the parent's column outside; a parent's rim line is the child's line (both bakes walk it
// with the same function and inputs: the same bits); the child draws the zipper that closes each parent edge against its
// k - 1 lines between (sheet instance j: parent surface j). The cache pass (sheetBake) writes per corner line its
// clusters (bot, top, z, normal) and per column and surface the four corners' cluster indices; the draw (draw.wgsl
// vsSheet) reads only these.
/** cache page 0 (level id CACHE_ID + depth): words 0-1 the input hash, 2 1 when unchanged, 3 S (the chunk's sheets), 5 the
 *  chunk key, 6 A (cluster spill pages, cz 1..A; sheet pages from cz 1 + A); from SLN a word a corner line of the chunk's
 *  19 x 19 (first cluster | count << 20); from SCL the clusters, 4 words each (bot, top, z, octahedral normal): SCL0 in
 *  page 0, then CPP a spill page */
const SLN: u32 = 8u;
const SCL: u32 = 372u;
const SCL0: u32 = 3043u;
const CPP: u32 = 3136u;
/** sheet pages: SPP sheets a page, SPW words a sheet: per column 3 words (cluster indices of corners 0 | 1 << 16, 2 | 3 <<
 *  16 on their lines; flags: bit 31 drawn, 0 up, 1 / 2 triangle 0 / 1 kept, 8-15 material), then from SZIP 16 zipper
 *  slots (side * 8 + segment) of 2 words (z in the child's units; flags: bit 31 drawn, 0 up, 8-15 material, 16 + i - 1
 *  triangle i kept) */
const SPP: u32 = 15u;
const SPW: u32 = 800u;
const SZIP: u32 = 768u;
const SFIX: f32 = 256.0;
/** (round 22) the slide's regulariser and bound (edge.ts SLIDE_REG, SLIDE_MAX: why 0.35) */
const SLIDE_REG: f32 = 0.05;
const SLIDE_MAX: f32 = 0.35;
/** (round 23, ?rimsnap=1) the snap's box (edge.ts SNAP_BOX) */
const SNAP_BOX: f32 = 0.49;
var<private> wkOn: array<bool, 4>;
var<workgroup> wShP: array<u32, 16>;
var<workgroup> wSA: u32;
var<workgroup> wSS: u32;
/** the canonical line of level L's corner line (CX, CY): on its child's footprint boundary, the child's (level, x, y) */
fn sCanon(L: u32, CX: i32, CY: i32) -> vec3<i32> {
  if (rimP(L, CX, CY)) {
    let k = i32(u.a.x);
    return vec3<i32>(i32(L) + 1, CX * k, CY * k);
  }
  return vec3<i32>(i32(L), CX, CY);
}
/** the four quadrant owners of canonical line (Lw, LX, LY): the column drawn there, outside the window the parent's */
fn sPrep(Lw: u32, LX: i32, LY: i32) {
  let k = i32(u.a.x);
  for (var q = 0u; q < 4u; q++) {
    let X = LX - 1 + i32(q & 1u);
    let Y = LY - 1 + i32(q >> 1u);
    var c = LC(Lw, X, Y, 0u);
    var on = colOn(Lw, X, Y);
    if (!on && Lw > 0u && !inWin(Lw, X, Y)) {
      c = LC(Lw - 1u, fdiv(X, k), fdiv(Y, k), 1u);
      on = colOn(Lw - 1u, c.X, c.Y);
    }
    wkC[q] = c;
    wkOn[q] = on;
    wkJ[q] = 0u;
    wkS[q] = false;
    wkT[q] = 0.0;
    wkX[q] = NO_DEPTH;
    wkA[q] = false;
    wkW[q] = MAT_AIR;
    wkE[q] = 0u;
    wkN[q] = 0u;
    if (on) { wkN[q] = sCount(c.lv, c.X, c.Y); }
  }
}
/** walk column q moved on to its next surface: records read from wkJ[q] up, each once a line (the one record read of
 *  the walk); a record ends in a surface when its solidity differs from the next one's (the last one's from the air
 *  above); its top goes to wkX[q] (NO_DEPTH: none left). The first record read sets the solidity under every surface
 *  (wkA: a column continues downward as its first record; a drawn column with no records is air). */
fn sAdvance(q: u32) {
  let c = wkC[q];
  let n = wkN[q];
  var j = wkJ[q];
  var ps = wkS[q];
  var pt = wkT[q];
  var pw = wkW[q];
  wkX[q] = NO_DEPTH;
  wkE[q] = 0u;
  loop {
    if (j > n) { break; }
    var s = false;
    var t = 0.0;
    var w = MAT_AIR;
    if (j < n) {
      let r = sRec(c.lv, c.X, c.Y, j);
      w = r.y;
      s = matSolid(w);
      t = bitcast<f32>(r.x);
      if (c.s == 1u) { t = toKid(c.lv, t); }
    }
    if (j == 0u) { wkA[q] = s; }
    let at = pt;
    let aw = pw;
    let surf = j > 0u && s != ps;
    ps = s;
    pt = t;
    pw = w;
    j++;
    if (surf) {
      wkX[q] = at;
      // (round 22: an up surface's edge sample is its solid record's)
      wkE[q] = select(0u, aw & EDGE_MASK, matSolid(aw));
      break;
    }
  }
  wkJ[q] = j;
  wkS[q] = ps;
  wkT[q] = pt;
  wkW[q] = pw;
}
fn sFix(z: f32) -> i32 { return i32(floor(z * SFIX)); }
/** cluster i of the chunk's table: its first word */
fn scl(i: u32) -> u32 {
  if (i < SCL0) { return sCp * PW + SCL + i * 4u; }
  let j = i - SCL0;
  let pz = j / CPP;
  var p = 0u;
  if (pz < 16u) { p = wCivP[pz]; } else { p = pageOf(CACHE_ID + u.a.w, bChunk.x, bChunk.y, 1u + pz); }
  return p * PW + (j % CPP) * 4u;
}
/** (after sPrep) the line walked bottom up: its breakpoints are the owners' surface heights, merged in order; two
 *  consecutive ones are joined when the present owners are not all solid or all air between them; its clusters written
 *  from `first` (bot, top, z = fixed-point mean, normal 0); their count */
fn sWalk(first: u32) -> u32 {
  var cnt = 0u;
  var a = 0.0;
  var b = -NO_DEPTH;
  var sum = 0;
  var n = 0u;
  // (round 22) the slide (edge.ts slideOf; boxmesh.ts sheetMesh): only on a line whose four quadrants are the walked
  // level's own drawn columns. Per cluster: the normal equations of its members' edge lines (height, then quadrant
  // order), how many members lie inside / outside the edge, and (?rimtop=1) the outside members' heights
  var slide = true;
  for (var q = 0u; q < 4u; q++) { slide = slide && wkOn[q] && wkC[q].s == 0u; }
  var axx = 0.0;
  var axy = 0.0;
  var ayy = 0.0;
  var bv = vec2<f32>(0.0);
  var pos = 0u;
  var neg = 0u;
  var oSum = 0;
  var oN = 0u;
  // (each quadrant's first surface found first; then each one whose surface was consumed, one a turn: one call site)
  var pend = 15u;
  loop {
    if (pend != 0u) {
      let q = firstTrailingBit(pend);
      pend &= pend - 1u;
      sAdvance(q);
      continue;
    }
    var nx = NO_DEPTH;
    var have = false;
    var s0 = false;
    var mixed = false;
    for (var q = 0u; q < 4u; q++) {
      nx = min(nx, wkX[q]);
      if (wkOn[q]) {
        if (!have) {
          have = true;
          s0 = wkA[q];
        } else if (wkA[q] != s0) {
          mixed = true;
        }
      }
    }
    let join = n > 0u && nx < NO_DEPTH && mixed;
    if (join) {
      sum += sFix(nx);
      n++;
    } else {
      if (n > 0u) {
        let o = scl(first + cnt);
        var zc = f32(sum) / f32(n * 256u);
        // (round 22) the slide: the least-squares point of the members' lines plus SLIDE_REG |p|^2, in a disc of
        // SLIDE_MAX, where the edge crosses the corner's cell (members inside and outside); kept in word 3 until step 3
        // moves it to word 1 (pack2x16snorm of p / 0.5)
        var ow = 0u;
        if (pos > 0u && neg > 0u) {
          let ma = axx + SLIDE_REG;
          let mc = ayy + SLIDE_REG;
          let det = ma * mc - axy * axy;
          var p = vec2<f32>(mc * bv.x - axy * bv.y, ma * bv.y - axy * bv.x) / det;
          if ((u.e.w & 4) != 0) {
            // (round 23, ?rimsnap=1: the owner's snap) inside the corner's own box, at the outside members' height
            p = clamp(p, vec2<f32>(-SNAP_BOX), vec2<f32>(SNAP_BOX));
          } else {
            let pl = length(p);
            if (pl > SLIDE_MAX) { p *= SLIDE_MAX / pl; }
          }
          ow = pack2x16snorm(p / 0.5);
          if ((u.e.w & 6) != 0 && oN > 0u) { zc = f32(oSum) / f32(oN * 256u); }
        }
        pgStore(o, bitcast<u32>(a));
        pgStore(o + 1u, bitcast<u32>(b));
        pgStore(o + 2u, bitcast<u32>(zc));
        pgStore(o + 3u, ow);
        cnt++;
      }
      if (nx >= NO_DEPTH) { break; }
      a = nx;
      sum = sFix(nx);
      n = 1u;
      axx = 0.0;
      axy = 0.0;
      ayy = 0.0;
      bv = vec2<f32>(0.0);
      pos = 0u;
      neg = 0u;
      oSum = 0;
      oN = 0u;
    }
    b = nx;
    // (the breakpoint consumed: each quadrant whose surface it is changes state there and moves on)
    for (var q = 0u; q < 4u; q++) {
      if (wkX[q] == nx) {
        // (round 22) its edge sample joins the cluster's
        let e = wkE[q];
        if (slide && e != 0u) {
          let an = edgeAng(e);
          let nn = vec2<f32>(cos(an), sin(an));
          let dd = edgeD(e);
          let ev = dd + dot(nn, vec2<f32>(-0.5 + f32(q & 1u), -0.5 + f32(q >> 1u)));
          axx += nn.x * nn.x;
          axy += nn.x * nn.y;
          ayy += nn.y * nn.y;
          bv += nn * ev;
          if (dd > 0.0) {
            pos++;
          } else {
            neg++;
            oSum += sFix(nx);
            oN++;
          }
        }
        wkA[q] = !wkA[q];
        pend |= 1u << q;
      }
    }
  }
  return cnt;
}
/** the index (from the line's first) of the cluster holding z (the line's units) on the chunk's line (CX, CY) */
fn sFind(CX: i32, CY: i32, z: f32) -> u32 {
  let w = pgLoad(sCp * PW + SLN + lnIdx(CX, CY));
  let s = w & 0xfffffu;
  var lo = 0u;
  var hi = w >> 20u;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    if (bitcast<f32>(pgLoad(scl(s + mid))) <= z) { lo = mid + 1u; } else { hi = mid; }
  }
  return max(lo, 1u) - 1u;
}
fn sClW(CX: i32, CY: i32, i: u32) -> u32 { return scl((pgLoad(sCp * PW + SLN + lnIdx(CX, CY)) & 0xfffffu) + i); }
fn sZ(CX: i32, CY: i32, i: u32) -> f32 { return bitcast<f32>(pgLoad(sClW(CX, CY, i) + 2u)); }
/** a column's surfaces in turn (any level, from its pages; oNext): the next record to read, the material and top bits of
 *  the record before it */
struct OSurf {
  j: u32,
  m: u32,
  t: u32,
}
/** the next surface of column (lv, X, Y) of n records after state *s: (top bits, material below, material above, 1), or
 *  w = 0 when none is left. A record ends in a surface when its solidity differs from the next one's (the last one's
 *  from the air above). */
fn oNext(lv: u32, X: i32, Y: i32, n: u32, s: ptr<function, OSurf>) -> vec4<u32> {
  var out = vec4<u32>(0u);
  loop {
    let j = (*s).j;
    if (j > n) { break; }
    var r = vec2<u32>(0u, MAT_AIR);
    if (j < n) { r = oRec(lv, X, Y, j); }
    let prev = *s;
    *s = OSurf(j + 1u, r.y, r.x);
    if (j > 0u && matSolid(r.y) != matSolid(prev.m)) {
      out = vec4<u32>(prev.t, prev.m, r.y, 1u);
      break;
    }
  }
  return out;
}
/** sheet j's first word in the chunk's sheet pages */
fn sheetW(j: u32) -> u32 {
  let pz = j / SPP;
  var p = 0u;
  if (pz < 16u) { p = wShP[pz]; } else { p = pageOf(CACHE_ID + u.a.w, bChunk.x, bChunk.y, 1u + wSA + pz); }
  return p * PW + (j % SPP) * SPW;
}
/** (round 23) twice the signed area of a triangle in plan (> 0 counter-clockwise from above) */
fn sArea(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> f32 { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
/** a quad's area normal from its four placed corners (zero where a corner is a rim line: those are the child's units) */
fn sQuadN(L: u32, X: i32, Y: i32, t: f32, up: bool) -> vec3<f32> {
  var z = vec4<f32>(0.0);
  for (var c = 0u; c < 4u; c++) {
    let CX = X + i32(c & 1u);
    let CY = Y + i32(c >> 1u);
    if (rimP(L, CX, CY)) { return vec3<f32>(0.0); }
    z[c] = sZ(CX, CY, sFind(CX, CY, t));
  }
  let n = vec3<f32>(z.x - z.y + z.z - z.w, z.x + z.y - z.z - z.w, 2.0);
  return select(-n, n, up);
}
/** the zipper of segment `seg` on side `side` (0: the chunk's x edge on the window's west or east, 1: its y edge on the
 *  south or north): the parent column outside, the line of chain step t (0 = the zipper's apex A), whether it exists */
struct Zip {
  ok: bool,
  X: i32,
  Y: i32,
  l0: vec2<i32>,
  d: vec2<i32>,
}
fn sZip(L: u32, cx: i32, cy: i32, side: u32, seg: u32) -> Zip {
  var z = Zip(false, 0, 0, vec2<i32>(0), vec2<i32>(0));
  let k = i32(u.a.x);
  if (L == 0u || i32(seg) >= 16 / k) { return z; }
  let w = u.lv[L];
  let s0 = i32(seg) * k;
  if (side == 0u) {
    let a = cy * 16 + s0;
    if (cx * 16 == w.x) {
      z = Zip(true, fdiv(w.x, k) - 1, fdiv(a, k), vec2<i32>(cx * 16, a), vec2<i32>(0, 1));
    } else if (cx * 16 + 16 == w.x + w.z) {
      z = Zip(true, fdiv(w.x + w.z, k), fdiv(a, k), vec2<i32>(cx * 16 + 16, a + k), vec2<i32>(0, -1));
    }
  } else {
    let a = cx * 16 + s0;
    if (cy * 16 == w.y) {
      z = Zip(true, fdiv(a, k), fdiv(w.y, k) - 1, vec2<i32>(a + k, cy * 16), vec2<i32>(-1, 0));
    } else if (cy * 16 + 16 == w.y + w.z) {
      z = Zip(true, fdiv(a, k), fdiv(w.y + w.z, k), vec2<i32>(a, cy * 16 + 16), vec2<i32>(1, 0));
    }
  }
  if (z.ok && !colOn(L - 1u, z.X, z.Y)) { z.ok = false; }
  return z;
}
@compute @workgroup_size(16, 16)
fn sheetBake(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let L = u.a.w;
  let o = slotOrigin(u.r.x, li);
  let cx = o.x + i32(wid.x);
  let cy = o.y + i32(wid.y);
  if (!inWin(L, cx * 16, cy * 16)) { return; }
  // (round 17) a band is (u.e.y & 0xffff) region rows (0: one); the last of (u.e.y >> 16) bands (0: no last) takes every
  // row after it too, so the bands cover the region whatever its size (the CPU's bound sets only how long a submit runs)
  if (u.e.z != 0) {
    let per = max(u.e.y & 0xffff, 1);
    var bi = i32(wid.y) / per;
    let nb = u.e.y >> 16u;
    if (nb > 0) { bi = min(bi, nb - 1); }
    if (bi != u.e.z - 1) { return; }
  }
  // (round 17, the region rule) mode u.e.x: 0 an edit's own region (skip when the chunk's own columns hash the same: a
  // change of the other level's columns comes as a mode 2 bake), 1 forced (window ops), 2 another level's change: the
  // chunks with a rim line only, forced
  let mode = u.e.x;
  if (mode == 2 && !chunkRim(L, cx, cy)) { return; }
  if (li == 0u) {
    // (page 0 made if missing; the spill and sheet pages are sized below, after the skip)
    if (pageOf(CACHE_ID + L, cx, cy, 0u) >= NOT_LOADED) { ensurePages(CACHE_ID + L, cx, cy, 1u, u.d.x); }
    wCp = pageOf(CACHE_ID + L, cx, cy, 0u);
  }
  if (li < 9u) { wPg[li] = pageOf(L, cx - 1 + i32(li % 3u), cy - 1 + i32(li / 3u), 0u); }
  let cp = workgroupUniformLoad(&wCp);
  if (cp >= NOT_LOADED) { return; }
  bOrg = vec2<i32>(cx - 1, cy - 1);
  bChunk = vec2<i32>(cx, cy);
  bFillRecs(L, cx, cy, li);
  sFillEdges(L, li);
  sCp = cp;
  let base = cp * PW;
  // (round 14's skip, the same hash: the chunk's 20 x 20 columns unchanged and off every rim: nothing to do)
  var ha = 0u;
  var hb = 0u;
  for (var q = li; q < 400u; q += 256u) {
    let X = sOrg.x - 1 + i32(q % 20u);
    let Y = sOrg.y - 1 + i32(q / 20u);
    let n = bCount(L, X, Y);
    let on = select(0u, 1u, colOn(L, X, Y));
    var a = ((q + 1u) * 0x9e3779b1u) ^ (n * 0x85ebca6bu) ^ (on * 0xc2b2ae35u);
    var b = ((q + 7u) * 0x27d4eb2du) ^ (n * 0x165667b1u) ^ (on * 0x7feb352du);
    for (var j = 0u; j < n; j++) {
      // (round 22: the material word with its edge sample, so an edge-only change bakes; bRec's copy holds the material
      // only, sE the edges of the records it holds, the pages the rest)
      var r = bRec(L, X, Y, j);
      let qi = sIdx(X, Y);
      if (qi >= 0 && j < SC) { r.y |= sE[u32(qi) * SC + j]; }
      a = (a ^ r.x ^ (r.y << 24u)) * 0x2c1b3c6du;
      a ^= a >> 15u;
      b = (b ^ (r.x * 0x9e3779b1u) ^ r.y) * 0x297a2d39u;
      b ^= b >> 13u;
    }
    ha += a;
    hb += b;
  }
  let hA = wgScan(li, ha).y | 1u;
  let hB = wgScan(li, hb).y;
  if (li == 0u) {
    let same = mode == 0 && pgLoad(base) == hA && pgLoad(base + 1u) == hB;
    pgStore(base, hA);
    pgStore(base + 1u, hB);
    pgStore(base + 2u, select(0u, 1u, same));
    wflag = select(0u, 1u, same);
  }
  // (round 17, measurement: ctl 12 the chunks that reached the hash, 13 those baked; storage atomics, one a workgroup)
  if (li == 0u) {
    atomicAdd(&ctl[12], 1u);
    if (wflag == 0u) { atomicAdd(&ctl[13], 1u); }
  }
  if (workgroupUniformLoad(&wflag) == 1u) { return; }
  // sizes: the cluster table (each line's place bounded by its owners' records: a scan), the sheets (the deepest column's
  // surfaces, and on a child's window edge the parent columns' outside: the zippers), then every page made at once
  // (round 19: one pass over the lines twice, ps 0 the bound, ps 1 the walk, so the line's owners are read from one call
  // site; 1. below)
  let X = cx * 16 + i32(lid.x);
  let Y = cy * 16 + i32(lid.y);
  let nOwn = sN[sIdx(X, Y)];
  var S = 0u;
  var first = 0u;
  for (var ps = 0u; ps < 2u; ps++) {
  if (ps == 1u) {
  let sc = wgScan(li, first);
  first = sc.x;
  var ns = 0u;
  var pm = false;
  for (var j = 0u; j <= nOwn; j++) {
    var s = false;
    if (j < nOwn) { s = matSolid(sRec(L, X, Y, j).y); }
    if (j > 0u && s != pm) { ns++; }
    pm = s;
  }
  if (li < 16u) {
    let z = sZip(L, cx, cy, li / 8u, li % 8u);
    if (z.ok) {
      let n = oCount(L - 1u, z.X, z.Y);
      var st = OSurf(0u, MAT_AIR, 0u);
      var c = 0u;
      loop {
        if (oNext(L - 1u, z.X, z.Y, n, &st).w == 0u) { break; }
        c++;
      }
      ns = max(ns, c);
    }
  }
  S = wgMax(li, ns);
  if (li == 0u) {
    var A = 0u;
    if (sc.y > SCL0) { A = 1u + (sc.y - SCL0 - 1u) / CPP; }
    let need = 1u + A + (S + SPP - 1u) / SPP;
    ensurePages(CACHE_ID + L, cx, cy, need, u.d.x);
    pgStore(base + 3u, S);
    pgStore(base + 5u, u32(cx) | (u32(cy) << 16u));
    pgStore(base + 6u, A);
    wSA = A;
    // (the pool full: a page missing; the chunk is left as it was, its count 0 so nothing of it is drawn)
    wflag = 0u;
    for (var z = 1u; z < need; z++) {
      if (pageOf(CACHE_ID + L, cx, cy, z) >= NOT_LOADED) { wflag = 1u; }
    }
    if (wflag == 1u) {
      pgStore(base + 3u, 0u);
      pgStore(base, 0u);
    }
  }
  storageBarrier();
  workgroupBarrier();
  if (workgroupUniformLoad(&wflag) == 1u) { return; }
  civPages(li);
  let A = workgroupUniformLoad(&wSA);
  if (li < 16u) { wShP[li] = pageOf(CACHE_ID + L, cx, cy, 1u + A + li); }
  workgroupBarrier();
  }
  // 1. every corner line of the chunk and the ring round it walked once (ps 1); ps 0 sums each line's bound (its owners'
  // records: the most clusters it can have)
  for (var q = li; q < 361u; q += 256u) {
    let c = sCanon(L, cx * 16 - 1 + i32(q % 19u), cy * 16 - 1 + i32(q / 19u));
    sPrep(u32(c.x), c.y, c.z);
    if (ps == 1u) { pgStore(base + SLN + q, first | (sWalk(first) << 20u)); }
    first += wkN[0] + wkN[1] + wkN[2] + wkN[3];
  }
  }
  storageBarrier();
  workgroupBarrier();
  // 2. (a child) a window-edge line between two rim lines: a cluster holding surfaces of the parent's column outside is
  // placed on the parent's edge: per such surface zP + (zQ - zP) i / k from the clusters holding it on the edge's rim
  // lines P and Q (fixed point, integer i), averaged
  if (L > 0u) {
    let w = u.lv[L];
    let k = i32(u.a.x);
    for (var q = li; q < 289u; q += 256u) {
      let CX = cx * 16 + i32(q % 17u);
      let CY = cy * 16 + i32(q / 17u);
      let onX = CX == w.x || CX == w.x + w.z;
      let onY = CY == w.y || CY == w.y + w.z;
      if (!(onX || onY) || CX < w.x || CY < w.y || CX > w.x + w.z || CY > w.y + w.z) { continue; }
      if (CX - fdiv(CX, k) * k == 0 && CY - fdiv(CY, k) * k == 0) { continue; }
      var P = vec2<i32>(CX, fdiv(CY, k) * k);
      var Q = P + vec2<i32>(0, k);
      var i = CY - P.y;
      var XX = select(fdiv(CX, k), fdiv(CX, k) - 1, CX == w.x);
      var XY = fdiv(CY, k);
      if (!onX) {
        P = vec2<i32>(fdiv(CX, k) * k, CY);
        Q = P + vec2<i32>(k, 0);
        i = CX - P.x;
        XX = fdiv(CX, k);
        XY = select(fdiv(CY, k), fdiv(CY, k) - 1, CY == w.y);
      }
      if (!colOn(L - 1u, XX, XY)) { continue; }
      let nX = oCount(L - 1u, XX, XY);
      let lw = pgLoad(base + SLN + lnIdx(CX, CY));
      for (var ci = 0u; ci < (lw >> 20u); ci++) {
        let cb = scl((lw & 0xfffffu) + ci);
        let bot = bitcast<f32>(pgLoad(cb));
        let top = bitcast<f32>(pgLoad(cb + 1u));
        var sum = 0;
        var m = 0u;
        var st = OSurf(0u, MAT_AIR, 0u);
        loop {
          let sf = oNext(L - 1u, XX, XY, nX, &st);
          if (sf.w == 0u) { break; }
          let zk = toKid(L - 1u, bitcast<f32>(sf.x));
          if (zk < bot || zk > top) { continue; }
          // (the clusters holding it on the rim lines P (e 0) and Q (e 1): one call site)
          var zpq = vec2<i32>(0);
          for (var e = 0; e < 2; e++) {
            let R = select(P, Q, e == 1);
            zpq[e] = sFix(sZ(R.x, R.y, sFind(R.x, R.y, zk)));
          }
          sum += zpq.x * k + (zpq.y - zpq.x) * i;
          m++;
        }
        if (m > 0u) { pgStore(cb + 2u, bitcast<u32>(f32(sum) / f32(m * u32(k) * 256u))); }
      }
    }
  }
  storageBarrier();
  workgroupBarrier();
  // 3. each cluster's normal (the chunk's lines; rim lines none: flat): the sum of the area normals of this level's quads
  // on it (a merge walk: the clusters and each quadrant column's surfaces both rise)
  for (var q = li; q < 289u; q += 256u) {
    let CX = cx * 16 + i32(q % 17u);
    let CY = cy * 16 + i32(q / 17u);
    if (rimP(L, CX, CY)) { continue; }
    let lw = pgLoad(base + SLN + lnIdx(CX, CY));
    // (per quadrant column: the next record to read and the one before it; each record read once, one call site)
    var cj = array<u32, 4>(0u, 0u, 0u, 0u);
    var cr = array<vec2<u32>, 4>(vec2<u32>(0u), vec2<u32>(0u), vec2<u32>(0u), vec2<u32>(0u));
    for (var ci = 0u; ci < (lw >> 20u); ci++) {
      let cb = scl((lw & 0xfffffu) + ci);
      let top = bitcast<f32>(pgLoad(cb + 1u));
      var nsum = vec3<f32>(0.0);
      for (var qd = 0u; qd < 4u; qd++) {
        let QX = CX - 1 + i32(qd & 1u);
        let QY = CY - 1 + i32(qd >> 1u);
        let n = sN[sIdx(QX, QY)];
        loop {
          let j = cj[qd];
          if (j > n) { break; }
          let pr = cr[qd];
          if (j > 0u && bitcast<f32>(pr.x) > top) { break; }
          var r = vec2<u32>(0u, MAT_AIR);
          if (j < n) { r = sRec(L, QX, QY, j); }
          if (j > 0u && matSolid(r.y) != matSolid(pr.y)) { nsum += sQuadN(L, QX, QY, bitcast<f32>(pr.x), matSolid(pr.y)); }
          cj[qd] = j + 1u;
          cr[qd] = r;
        }
      }
      var wd = 0u;
      if (dot(nsum, nsum) > 0.0) { wd = octEnc(normalize(nsum)); }
      // (round 22) the slide the walk kept in word 3 goes to word 1 (the cluster's top: not read after this step, and
      // not by the draw); the normal takes word 3. Rim lines keep both as the walk wrote them (no slide there).
      pgStore(cb + 1u, pgLoad(cb + 3u));
      pgStore(cb + 3u, wd);
    }
  }
  // (round 23: step 4 reads the slides step 3 moved to word 1, ?rimsnap=1's diagonal and normal)
  storageBarrier();
  workgroupBarrier();
  // 4. each column's surfaces: its corners' cluster indices, and the pair rule per triangle (a run of consecutive
  // surfaces on the same three vertices keeps its top one when odd, none when even)
  {
    let col = colIn(X, Y);
    var kid = vec4<bool>(false);
    for (var c = 0u; c < 4u; c++) { kid[c] = rimP(L, X + i32(c & 1u), Y + i32(c >> 1u)); }
    var j = 0u;
    var prev = vec4<u32>(0xffffffffu);
    var run = vec2<u32>(0u);
    // (the flags word of the column's previous surface; each record read once, one call site)
    var pf = 0u;
    var rec = vec2<u32>(0u, MAT_AIR);
    for (var r1 = 0u; r1 <= nOwn; r1++) {
      var m1 = MAT_AIR;
      var t1 = 0u;
      if (r1 < nOwn) {
        let x = sRec(L, X, Y, r1);
        m1 = x.y;
        t1 = x.x;
      }
      let r0 = rec;
      rec = vec2<u32>(t1, m1);
      if (r1 == 0u) { continue; }
      let a = matSolid(r0.y);
      let b = matSolid(m1);
      if (a == b) { continue; }
      let h = bitcast<f32>(r0.x);
      var ix = vec4<u32>(0u);
      for (var c = 0u; c < 4u; c++) {
        let CX = X + i32(c & 1u);
        let CY = Y + i32(c >> 1u);
        var z = h;
        if (kid[c]) { z = toKid(L, h); }
        ix[c] = sFind(CX, CY, z);
      }
      let sw = sheetW(j) + col * 3u;
      pgStore(sw, ix.x | (ix.y << 16u));
      pgStore(sw + 1u, ix.z | (ix.w << 16u));
      let mat = select(m1, r0.y, a) & 255u;
      // (round 23, ?rimsnap=1: boxmesh.ts sheetMesh snapDiag 'surface') the quad's diagonal from its slid corners: the
      // fixed one (0-3) unless one of its triangles folds and the other diagonal's (1-2) do not (flag bit 3); and where a
      // corner slid, the quad's own normal from its slid corners in bits 16-30 (octahedral, 8 + 7 bits; bit 4 on): a
      // triangle at a slid corner shades with its own side's surface (a hard crease at the rim; draw.wgsl sheetVert)
      var fx = 0u;
      if ((u.e.w & 4) != 0) {
        var p = array<vec3<f32>, 4>(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
        var slid = false;
        for (var c = 0u; c < 4u; c++) {
          let CX = X + i32(c & 1u);
          let CY = Y + i32(c >> 1u);
          var off = vec2<f32>(0.0);
          if (!kid[c]) {
            let cw = sClW(CX, CY, ix[c]);
            let sl = pgLoad(cw + 1u);
            off = unpack2x16snorm(sl) * 0.5;
            slid = slid || sl != 0u;
            p[c] = vec3<f32>(f32(c & 1u) + off.x, f32(c >> 1u) + off.y, bitcast<f32>(pgLoad(cw + 2u)));
          } else {
            p[c] = vec3<f32>(f32(c & 1u), f32(c >> 1u), 0.0);
          }
        }
        let a013 = sArea(p[0].xy, p[1].xy, p[3].xy);
        let a032 = sArea(p[0].xy, p[3].xy, p[2].xy);
        let a012 = sArea(p[0].xy, p[1].xy, p[2].xy);
        let a132 = sArea(p[1].xy, p[3].xy, p[2].xy);
        if (min(a013, a032) < 0.0 && min(a012, a132) >= 0.0) { fx = 8u; }
        if (slid && !any(kid)) {
          let nq = cross(p[3] - p[0], p[2] - p[1]);
          if (dot(nq, nq) > 0.0) {
            let w = octEnc(normalize(select(-nq, nq, a)));
            fx |= 16u | (((w >> 8u) & 255u) << 16u) | ((w >> 25u) << 24u);
          }
        }
      }
      pgStore(sw + 2u, 0x80000000u | select(0u, 1u, a) | (mat << 8u) | fx);
      // triangle 0 (corners 0, 1, 3) and 1 (0, 3, 2), flipped (0, 1, 2) and (1, 3, 2): same three vertices as the surface
      // below (the same diagonal and the same clusters)?
      let fl = (fx & 8u) != 0u;
      let sameD = j > 0u && fl == ((pgLoad(pf) & 8u) != 0u);
      let same0 = sameD && ix.x == prev.x && ix.y == prev.y && select(ix.w == prev.w, ix.z == prev.z, fl);
      let same1 = sameD && ix.w == prev.w && ix.z == prev.z && select(ix.x == prev.x, ix.y == prev.y, fl);
      if (j > 0u && !same0 && run.x % 2u == 1u) { pgStore(pf, pgLoad(pf) | 2u); }
      if (j > 0u && !same1 && run.y % 2u == 1u) { pgStore(pf, pgLoad(pf) | 4u); }
      run.x = select(1u, run.x + 1u, same0);
      run.y = select(1u, run.y + 1u, same1);
      prev = ix;
      pf = sw + 2u;
      j++;
    }
    if (j > 0u) {
      var f = pgLoad(pf);
      if (run.x % 2u == 1u) { f |= 2u; }
      if (run.y % 2u == 1u) { f |= 4u; }
      pgStore(pf, f);
    }
    for (var e = j; e < S; e++) { pgStore(sheetW(e) + col * 3u + 2u, 0u); }
  }
  // 5. (a child) the zippers: slot li cleared on every sheet, then each segment's own written (same thread)
  if (li < 16u) {
    for (var e = 0u; e < S; e++) { pgStore(sheetW(e) + SZIP + li * 2u + 1u, 0u); }
    let side = li / 8u;
    let seg = li % 8u;
    let z = sZip(L, cx, cy, side, seg);
    if (z.ok) {
      let k = u32(u.a.x);
      let n = oCount(L - 1u, z.X, z.Y);
      var j = 0u;
      var prev: array<vec3<u32>, 8>;
      var run: array<u32, 8>;
      var st = OSurf(0u, MAT_AIR, 0u);
      // (the flags word of the previous surface's slot)
      var pw = 0u;
      loop {
        let sf = oNext(L - 1u, z.X, z.Y, n, &st);
        if (sf.w == 0u) { break; }
        let up = matSolid(sf.y);
        let mat = select(sf.z, sf.y, up);
        let zk = toKid(L - 1u, bitcast<f32>(sf.x));
        let zw = sheetW(j) + SZIP + li * 2u;
        pgStore(zw, bitcast<u32>(zk));
        let flags = 0x80000000u | select(0u, 1u, up) | ((mat & 255u) << 8u);
        // (the chain's lines t = 0 .. k, one cluster lookup each: triangle t is (A, s_t, s_t+1), A = line 0)
        var i0 = 0u;
        var ia = 0u;
        for (var t = 0u; t <= k; t++) {
          let pt = z.l0 + z.d * i32(t);
          let ib = sFind(pt.x, pt.y, zk);
          if (t == 0u) { i0 = ib; }
          if (t >= 2u) {
            let tt = t - 1u;
            let key = vec3<u32>(i0, ia, ib);
            let same = j > 0u && all(key == prev[tt]);
            if (j > 0u && !same && run[tt] % 2u == 1u) { pgStore(pw, pgLoad(pw) | (1u << (15u + tt))); }
            run[tt] = select(1u, run[tt] + 1u, same);
            prev[tt] = key;
          }
          ia = ib;
        }
        pgStore(zw + 1u, flags);
        pw = zw + 1u;
        j++;
      }
      if (j > 0u) {
        var f = pgLoad(pw);
        for (var t = 1u; t < k; t++) {
          if (run[t] % 2u == 1u) { f |= 1u << (15u + t); }
        }
        pgStore(pw, f);
      }
    }
  }
}

@compute @workgroup_size(1)
fn dirClear() {
  for (var L = 0u; L < 16u; L++) { atomicStore(&dir[L], 0u); }
  for (var L = 0u; L < 8u; L++) { atomicStore(&dir[sheetDir() + L], 0u); }
}
/** (round 16) the sheets: 8 counts a level from sheetDir() (after the face lists: 8 levels x cap entries of 2 words),
 *  then per level up to 24 x cap entries of 2 words (EX_PB words a page of the pool) from sheetDir() + 8 + L * EX_PB *
 *  cap. Not a cap: a chunk's sheets are at most its deepest column's surfaces, at most its records, at most 24 a column
 *  page of the chunk; on a child's window edge also the parent column's outside (BACKLOG NS-125). (Round 18: the
 *  round 14-15 cache page lists and wall blocks that sat between are gone; draw.wgsl sheetVert reads the same offsets.) */
const EX_PB: u32 = 48u;
fn sheetDir() -> u32 { return 16u + 16u * u.r.y; }
@compute @workgroup_size(64)
fn dirBuild(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= TCAP) { return; }
  let k1 = atomicLoad(&tab[s * 4u + 1u]);
  if (k1 >= BUSY) { return; }
  let lid = k1 & 0xffu;
  // (round 16) the sheet draw's cache pages: the sheet pages list their sheets
  if (lid >= CACHE_ID && lid < CACHE_ID + 8u) {
    let p = atomicLoad(&tab[s * 4u + 2u]);
    if (p >= NOT_LOADED) { return; }
    let L = lid - CACHE_ID;
    let cz = k1 >> 8u;
    let k0 = atomicLoad(&tab[s * 4u]);
    // (round 16) a sheet page: an instance a sheet (2 words: the sheet page | the sheet in it << 24, the chunk's page 0)
    let p0 = pageOf(lid, i32(k0 & 0xffffu), i32(k0 >> 16u), 0u);
    if (p0 >= NOT_LOADED) { return; }
    let A = pgLoad(p0 * PW + 6u);
    if (cz < 1u + A) { return; }
    let b = cz - 1u - A;
    let S = pgLoad(p0 * PW + 3u);
    if (S <= b * SPP) { return; }
    let ns = min(SPP, S - b * SPP);
    let xd = sheetDir();
    let i0 = atomicAdd(&dir[xd + L], ns);
    for (var jj = 0u; jj < ns; jj++) {
      let e = xd + 8u + L * EX_PB * u.r.y + (i0 + jj) * 2u;
      atomicStore(&dir[e], p | (jj << 24u));
      atomicStore(&dir[e + 1u], p0);
    }
    return;
  }
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
    // (round 16) the sheets: an instance a sheet of a chunk, 2 triangles a column and 32 zipper triangles (args 8 + L)
    dargs[(8u + L) * 4u] = (512u + 32u) * 3u;
    dargs[(8u + L) * 4u + 1u] = atomicLoad(&dir[sheetDir() + L]);
    dargs[(8u + L) * 4u + 2u] = 0u;
    dargs[(8u + L) * 4u + 3u] = 0u;
  }
}
/** a bake slot (u.e.y) from up to three region slots (u.e.x: s0 | s1 << 8 | s2 << 16, 255 none): the union of their
 *  chunks grown by one each way, within level u.a.w's window. (Round 12, NS-103: an edit's three regions on a level, the
 *  edit, the derive and the restrict into it, mostly overlap; baked one by one their shared chunks were baked two or
 *  three times in one submit.) */
@compute @workgroup_size(1)
fn dilate() {
  let L = u.a.w;
  let t = u32(u.e.y);
  // (round 16, NS-126: the sheet draw's level edges) u.e.z 1: the source slots are level L - 1's (a parent change seen by
  // the child's window-edge lines), 2: level L + 1's (a child change seen by the parent's rim lines): their union is
  // taken in the source level's chunks, grown by one, then carried into level L's chunks and clipped to its window
  // (round 17: the region rule of NESTED_SCALES.md "As built (round 17)", GpuNest.bakeChanged) the source's changed
  // COLUMNS (each slot's box within its chunks), grown by two, carried into level L's columns (x k, or / k rounded
  // out), grown by two there, in chunks; the sheet pass then bakes only the rim chunks of it (mode 2). Round 16 carried
  // the slots' chunk rects grown by a chunk (x k: four child chunks each way) and leaned on rim chunks always baking.
  if (u.e.z != 0) {
    let SL = select(L + 1u, L - 1u, u.e.z == 1);
    let ws = u.lv[SL];
    let wt = u.lv[L];
    let k = i32(u.a.x);
    var a = vec4<i32>(1 << 30, 1 << 30, -(1 << 30), -(1 << 30));
    for (var i = 0u; i < 3u; i++) {
      let s = (u32(u.e.x) >> (8u * i)) & 255u;
      if (s == 255u) { continue; }
      let nx = i32(args[s * 4u]);
      let ny = i32(args[s * 4u + 1u]);
      if (nx <= 0 || ny <= 0 || ws.z == 0 || wt.z == 0) { continue; }
      let ox = slotW(s, 4u) * 16;
      let oy = slotW(s, 5u) * 16;
      let bx = vec4<i32>(max(slotW(s, 0u), ox), max(slotW(s, 1u), oy), min(slotW(s, 2u), ox + nx * 16), min(slotW(s, 3u), oy + ny * 16));
      if (bx.z <= bx.x || bx.w <= bx.y) { continue; }
      a = vec4<i32>(min(a.x, bx.x), min(a.y, bx.y), max(a.z, bx.z), max(a.w, bx.w));
    }
    a += vec4<i32>(-2, -2, 2, 2);
    var c = a;
    if (u.e.z == 1) { c = a * k; } else { c = vec4<i32>(fdiv(a.x, k), fdiv(a.y, k), fdiv(a.z + k - 1, k), fdiv(a.w + k - 1, k)); }
    c += vec4<i32>(-2, -2, 2, 2);
    var b = vec4<i32>(fdiv(c.x, 16), fdiv(c.y, 16), fdiv(c.z + 15, 16), fdiv(c.w + 15, 16));
    b = vec4<i32>(max(b.x, wt.x / 16), max(b.y, wt.y / 16), min(b.z, (wt.x + wt.z) / 16), min(b.w, (wt.y + wt.z) / 16));
    if (a.z <= a.x || b.z <= b.x || b.w <= b.y) {
      setSlot(t, vec4<i32>(0), 0, 0, 0, 0);
      return;
    }
    setSlot(t, vec4<i32>(-(1 << 30), -(1 << 30), 1 << 30, 1 << 30), b.x, b.y, b.z - b.x, b.w - b.y);
    return;
  }
  let w = u.lv[L];
  var x0 = 1 << 30;
  var y0 = 1 << 30;
  var x1 = -(1 << 30);
  var y1 = -(1 << 30);
  for (var i = 0u; i < 3u; i++) {
    let s = (u32(u.e.x) >> (8u * i)) & 255u;
    if (s == 255u) { continue; }
    let nx = i32(args[s * 4u]);
    let ny = i32(args[s * 4u + 1u]);
    if (nx <= 0 || ny <= 0 || w.z == 0) { continue; }
    let ox = slotW(s, 4u);
    let oy = slotW(s, 5u);
    // the columns the slot's pass changes (its box) grown by two columns, in chunks: a column's bottom depends on its
    // four neighbours' depths, and its walls' splits on the bottoms of the columns round its corner lines (round 8; one
    // before) (a CPU slot's box is everything: its chunks grown by one)
    let bx0 = (max(slotW(s, 0u), -(1 << 28)) - 2) >> 4;
    let by0 = (max(slotW(s, 1u), -(1 << 28)) - 2) >> 4;
    let bx1 = ((min(slotW(s, 2u), 1 << 28) + 1) >> 4) + 1;
    let by1 = ((min(slotW(s, 3u), 1 << 28) + 1) >> 4) + 1;
    x0 = min(x0, max(max(ox - 1, bx0), w.x / 16));
    y0 = min(y0, max(max(oy - 1, by0), w.y / 16));
    x1 = max(x1, min(min(ox + nx + 1, bx1), (w.x + w.z) / 16));
    y1 = max(y1, min(min(oy + ny + 1, by1), (w.y + w.z) / 16));
  }
  if (x1 <= x0 || y1 <= y0) {
    setSlot(t, vec4<i32>(0), 0, 0, 0, 0);
    return;
  }
  setSlot(t, vec4<i32>(-(1 << 30), -(1 << 30), 1 << 30, 1 << 30), x0, y0, x1 - x0, y1 - y0);
}
