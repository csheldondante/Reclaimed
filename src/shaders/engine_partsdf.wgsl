// ---- settled parts get distance fields (docs/design/PHYSICS_ENGINE.md "Pieces are bodies"; BACKLOG PM4) --------------
// A part made a row by settle (engine_settle.wgsl) is pinned (ROW_HELD) with no model word, and its body's particles
// stand as its collision shape (engine_deform.wgsl S_HELD, the slot's word 24 = 2) for the few ticks it takes to bake
// its own field here, all on the GPU: the host is never told of a part.
//   bakeBegin  one thread, first: the store's region and the scratch as the host last gave them; the batch in flight
//              moved on (two flood passes a tick), ended, or the next one formed from the ring
//   partField  a thread a part's root: its voxels' bounds in the part's rest frame, a row of the model store and its
//              words (bump counters in the region the host reserved; `want` words tell it when to give another), a
//              job in the ring
//   partOcc    a thread a voxel: the cubes of half a cell whose centre its cell holds, in the part's lattice frame
//              (a part's cells lie where they settled, at any angle), OR-ed into the model's occupancy bits
//   (sdf-bake.wgsl with sdf-bake-ring.wgsl: seed, two flood passes, the field, the sample bricks)
//   partLive   a thread a root, last: its job done, the row gets its model word and is let go (still asleep; `compact`
//              tells the sleeper table); the slot is told what is still waiting, and lets its pages go when none is
// bk (atomic u32): [0] jobs claimed ever (the ring's tail), [1] its head (jobs done), [2] the batch's end (= head:
// none), [3] flood passes done, [4] flood passes it takes, [5] the batch's threads, [6] its bricks, [7] this tick's
// kernels (1 seed, 2 flood, 4 the field and the bricks), [8] the region's serial as last seen, [9..11] next model row,
// data word, occupancy word (in the region), [12..14] the most asked of each, [15] the threads of a job the scratch
// cannot hold, [16] the scratch's serial as last seen, [17] jobs made ever, [18] parts let go ever; [24..] dispatch
// arguments (seed, flood, field, bricks, jobs: 4 words each); from BK_RING a job, 8 words: model row, first thread,
// occupancy base, sample room, first brick, padded sides (8 bits each), threads, bricks.
const V_FIELD: u32 = 6u;
const V_LIVE: u32 = 7u;
const BK_TAIL: u32 = 0u;
const BK_HEAD: u32 = 1u;
const BK_END: u32 = 2u;
const BK_PHASE: u32 = 3u;
const BK_STEPS: u32 = 4u;
const BK_THREADS: u32 = 5u;
const BK_BRICKS: u32 = 6u;
const BK_BITS: u32 = 7u;
const BK_SERIAL: u32 = 8u;
const BK_ID_NEXT: u32 = 9u;
const BK_DATA_NEXT: u32 = 10u;
const BK_OCC_NEXT: u32 = 11u;
const BK_ID_WANT: u32 = 12u;
const BK_DATA_WANT: u32 = 13u;
const BK_OCC_WANT: u32 = 14u;
const BK_SCRATCH_WANT: u32 = 15u;
const BK_SCRATCH_SERIAL: u32 = 16u;
const BK_MADE: u32 = 17u;
const BK_LIVE: u32 = 18u;
const BK_ARGS: u32 = 24u;
const BK_RING: u32 = 64u;
const BK_JOBS: u32 = 1024u;
// cells a cube of a part's field (src/engine/sdf/hexmodel.ts HEX_SDF_VOXEL), the store's padding (contract.ts SDF_PAD)
const PF_VOXEL: f32 = 0.5;
// half a lattice cell's box (x along its row, y across the rows — ROW_H apart —, z up), 3 % over so that neighbours
// a strain apart leave no cube between them
const PF_HALF = vec3<f32>(0.515, 0.446, 0.515);

@group(0) @binding(70) var<storage, read_write> bk: array<atomic<u32>>;
// a: the region's serial, its first model row, its rows, the scratch's threads; b: its first data word, its data
// words, its first occupancy word, its occupancy words; c: the scratch's serial
struct BkU { a: vec4<u32>, b: vec4<u32>, c: vec4<u32> };
@group(0) @binding(71) var<uniform> BKU: BkU;
@group(0) @binding(72) var<storage, read_write> socc: array<atomic<u32>>;
// the store's rows, 8 words each (contract.ts SdfModel): field base, padded sides, sample base, samples, com xyz, voxel
@group(0) @binding(73) var<storage, read_write> smodels: array<u32>;

fn bkGet(i: u32) -> u32 { return atomicLoad(&bk[i]); }
fn bkRing(seq: u32) -> u32 { return BK_RING + (seq % BK_JOBS) * 8u; }
/** particle i of a body that stands for its parts while their fields are baked, or ok false */
fn fielding(i: u32) -> Lat {
  var L: Lat;
  if (i == NONE) { return L; }
  L = latOf(i);
  L.ok = L.ok && L.state == S_HELD && dmeta[slotAt(L.slot) + 24u] == 2u;
  return L;
}
/** n in a row of the region's rows or words, or NONE (past the room: `want` tells the host) */
fn bkTake(next: u32, want: u32, room: u32, n: u32) -> u32 {
  let b = atomicAdd(&bk[next], n);
  atomicMax(&bk[want], b + n);
  if (b + n <= room) { return b; }
  atomicSub(&bk[next], n);
  return NONE;
}

@compute @workgroup_size(1)
fn bakeBegin() {
  if (bkGet(BK_SERIAL) != BKU.a.x) {
    // (a new region: the counters start again in it)
    atomicStore(&bk[BK_SERIAL], BKU.a.x);
    for (var k = BK_ID_NEXT; k <= BK_OCC_WANT; k++) { atomicStore(&bk[k], 0u); }
  }
  let tail = bkGet(BK_TAIL);
  var head = bkGet(BK_HEAD);
  var end = bkGet(BK_END);
  var phase = bkGet(BK_PHASE);
  let was = bkGet(BK_BITS);
  if (bkGet(BK_SCRATCH_SERIAL) != BKU.c.x) {
    // (a new scratch: what the flood had in the old one is gone — the batch is formed again)
    atomicStore(&bk[BK_SCRATCH_SERIAL], BKU.c.x);
    atomicStore(&bk[BK_SCRATCH_WANT], 0u);
    end = head;
  } else if (end != head) {
    if ((was & 4u) != 0u) {
      head = end;
    } else if ((was & 2u) != 0u) {
      phase += 2u;
    }
  }
  var bits = 0u;
  if (end == head && head != tail) {
    var threads = 0u;
    var bricks = 0u;
    var side = 1u;
    var k = head;
    for (; k != tail && k - head < BK_JOBS; k++) {
      let b = bkRing(k);
      let span = bkGet(b + 6u);
      if (threads + span > BKU.a.w) {
        if (k == head) { atomicMax(&bk[BK_SCRATCH_WANT], span); }
        break;
      }
      atomicStore(&bk[b + 1u], threads);
      atomicStore(&bk[b + 4u], bricks);
      threads += span;
      bricks += bkGet(b + 7u);
      let d = bkGet(b + 5u);
      side = max(side, max(d & 255u, max((d >> 8u) & 255u, (d >> 16u) & 255u)));
    }
    end = k;
    if (end != head) {
      var steps = 1u;
      for (var n = 1u; n < side; n *= 2u) { steps++; }
      phase = 0u;
      atomicStore(&bk[BK_STEPS], steps);
      atomicStore(&bk[BK_THREADS], threads);
      atomicStore(&bk[BK_BRICKS], bricks);
      bits = 1u;
    }
  }
  if (end != head) {
    bits |= 2u;
    if (phase + 2u >= bkGet(BK_STEPS)) { bits |= 4u; }
  }
  atomicStore(&bk[BK_HEAD], head);
  atomicStore(&bk[BK_END], end);
  atomicStore(&bk[BK_PHASE], phase);
  atomicStore(&bk[BK_BITS], bits);
  let tg = (bkGet(BK_THREADS) + 63u) / 64u;
  let bg = (bkGet(BK_BRICKS) + 63u) / 64u;
  let groups = array<u32, 5>(select(0u, tg, (bits & 1u) != 0u), select(0u, tg, (bits & 2u) != 0u), select(0u, tg, (bits & 4u) != 0u), select(0u, bg, (bits & 4u) != 0u), select(0u, (end - head + 63u) / 64u, (bits & 4u) != 0u));
  for (var a = 0u; a < 5u; a++) {
    atomicStore(&bk[BK_ARGS + 4u * a], groups[a]);
    atomicStore(&bk[BK_ARGS + 4u * a + 1u], 1u);
    atomicStore(&bk[BK_ARGS + 4u * a + 2u], 1u);
  }
}

@compute @workgroup_size(64)
fn partField(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = fielding(i);
  if (!L.ok || !alive(i) || labelOf(i) != L.k || verdictOf(i) != V_DONE) { return; }
  let A = bitcast<vec4<u32>>(pw[3u * i + 1u]);
  // (a whole body given its own row back has no part)
  if (A.w == NONE) { return; }
  if (bkGet(BK_TAIL) - bkGet(BK_HEAD) >= BK_JOBS) { return; }
  let c = pw[3u * i].xyz;
  let lo = vec3<i32>(unpack3(A.y));
  let hi = vec3<i32>(unpack3(A.z));
  let fq = ps[3u * i];
  // (its voxels' bounds about its centre, each a lattice cell's box turned by the part's lattice frame)
  let e = abs(eqrot(fq, vec3<f32>(PF_HALF.x, 0.0, 0.0))) + abs(eqrot(fq, vec3<f32>(0.0, PF_HALF.y, 0.0))) + abs(eqrot(fq, vec3<f32>(0.0, 0.0, PF_HALF.z)));
  var bmin = vec3<f32>(1e9);
  var bmax = vec3<f32>(-1e9);
  for (var z = lo.z; z <= hi.z; z++) {
    for (var y = lo.y; y <= hi.y; y++) {
      for (var x = lo.x; x <= hi.x; x++) {
        let j = partCell(L.slot, vec3<i32>(x, y, z), L.dims, L.k);
        if (j < 0) { continue; }
        let p = px[2u * u32(j)].xyz - c;
        bmin = min(bmin, p);
        bmax = max(bmax, p);
      }
    }
  }
  bmin -= e;
  bmax += e;
  // (cubes over the bounds, centred on them; 253 a side at most — the store's 255 with its padding: BACKLOG PR2)
  let nd = min(vec3<u32>(max(ceil((bmax - bmin) / PF_VOXEL - vec3<f32>(0.08)), vec3<f32>(1.0))), vec3<u32>(253u));
  let o = 0.5 * (bmin + bmax) - vec3<f32>(nd) * (0.5 * PF_VOXEL);
  let d = nd + vec3<u32>(2u);
  let nvox = d.x * d.y * d.z;
  let bd = (d + vec3<u32>(3u)) / 4u;
  let bricks = bd.x * bd.y * bd.z;
  let cap = min(min(nd.x * nd.y * nd.z, 12u * A.x + 8u), 65536u);
  let id = bkTake(BK_ID_NEXT, BK_ID_WANT, BKU.a.z, 1u);
  if (id == NONE) { return; }
  let dw = bkTake(BK_DATA_NEXT, BK_DATA_WANT, BKU.b.y, nvox + bricks + 1u + cap);
  if (dw == NONE) { return; }
  let ow = bkTake(BK_OCC_NEXT, BK_OCC_WANT, BKU.b.w, (nvox + 31u) / 32u);
  if (ow == NONE) { return; }
  var seq = NONE;
  for (var t = 0u; t < 4096u; t++) {
    let tl = bkGet(BK_TAIL);
    if (tl - bkGet(BK_HEAD) >= BK_JOBS) { break; }
    if (atomicCompareExchangeWeak(&bk[BK_TAIL], tl, tl + 1u).exchanged) {
      seq = tl;
      break;
    }
  }
  // (the ring full: what was taken of the region is not given back — another thread's run may lie after it — and the
  // part asks again next tick)
  if (seq == NONE) { return; }
  let model = BKU.a.y + id;
  let m = model * 8u;
  let com = -o / PF_VOXEL + vec3<f32>(1.0);
  smodels[m] = BKU.b.x + dw;
  smodels[m + 1u] = d.x | (d.y << 8u) | (d.z << 16u);
  smodels[m + 2u] = BKU.b.x + dw + nvox;
  smodels[m + 3u] = 0u;
  smodels[m + 4u] = bitcast<u32>(com.x);
  smodels[m + 5u] = bitcast<u32>(com.y);
  smodels[m + 6u] = bitcast<u32>(com.z);
  smodels[m + 7u] = bitcast<u32>(PF_VOXEL);
  let b = bkRing(seq);
  atomicStore(&bk[b], model);
  atomicStore(&bk[b + 1u], 0u);
  atomicStore(&bk[b + 2u], BKU.b.z + ow);
  atomicStore(&bk[b + 3u], cap);
  atomicStore(&bk[b + 4u], 0u);
  atomicStore(&bk[b + 5u], d.x | (d.y << 8u) | (d.z << 16u));
  atomicStore(&bk[b + 6u], ((nvox + 3u) / 4u) * 4u);
  atomicStore(&bk[b + 7u], bricks);
  pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(L.k, model, seq, V_FIELD));
  atomicAdd(&bk[BK_MADE], 1u);
}

@compute @workgroup_size(64)
fn partOcc(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = fielding(i);
  if (!L.ok || !alive(i)) { return; }
  let root = partAt(L.slot, labelOf(i));
  let B = bitcast<vec4<u32>>(pw[3u * root + 2u]);
  if (B.w != V_FIELD) { return; }
  // (its job is in a batch, or done: the bits are being read, and were all set the tick it was claimed)
  let head = bkGet(BK_HEAD);
  if (bitcast<i32>(B.z - head) < bitcast<i32>(bkGet(BK_END) - head)) { return; }
  let m = B.y * 8u;
  let dw = smodels[m + 1u];
  let d = vec3<i32>(i32(dw & 255u), i32((dw >> 8u) & 255u), i32((dw >> 16u) & 255u));
  let com = vec3<f32>(bitcast<f32>(smodels[m + 4u]), bitcast<f32>(smodels[m + 5u]), bitcast<f32>(smodels[m + 6u]));
  let ob = bkGet(bkRing(B.z) + 2u);
  let inv = eqinv(ps[3u * root]);
  // (its centre in the padded grid's own coordinates; a cube's centre is half a cube past its corner)
  let g = (px[2u * i].xyz - pw[3u * root].xyz) / PF_VOXEL + com;
  let c0 = vec3<i32>(ceil(g - vec3<f32>(2.4)));
  for (var dz = 0; dz < 5; dz++) {
    for (var dy = 0; dy < 5; dy++) {
      for (var dx = 0; dx < 5; dx++) {
        let ci = c0 + vec3<i32>(dx, dy, dz);
        if (any(ci < vec3<i32>(1)) || any(ci >= d - vec3<i32>(1))) { continue; }
        let off = eqrot(inv, (vec3<f32>(ci) + vec3<f32>(0.5) - g) * PF_VOXEL);
        if (any(abs(off) > PF_HALF)) { continue; }
        let idx = u32(ci.x) + u32(d.x) * (u32(ci.y) + u32(d.y) * u32(ci.z));
        atomicOr(&socc[ob + (idx >> 5u)], 1u << (idx & 31u));
      }
    }
  }
}

@compute @workgroup_size(64)
fn partLive(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = fielding(i);
  if (!L.ok || !alive(i) || labelOf(i) != L.k) { return; }
  let sum = EU.h.w + SUMS_W * L.slot;
  // (the slot's parts were gone over this tick: `slots` lets it go only on such a tick)
  atomicStore(&pool[sum + 7u], 1u);
  let row = bitcast<vec4<u32>>(pw[3u * i + 1u]).w;
  if (row == NONE) { return; }
  let B = bitcast<vec4<u32>>(pw[3u * i + 2u]);
  if (B.w == V_FIELD && bitcast<i32>(B.z - bkGet(BK_HEAD)) < 0) {
    rowSdf[row] = B.y;
    // (let go, asleep where it is: `compact` takes the ground's word under it again and tells the sleeper table)
    info[4u * row].w = bitcast<f32>((rowFlags(row) & ~ROW_HELD) | ROW_NEWSLEEP);
    pw[3u * i + 2u] = bitcast<vec4<f32>>(vec4<u32>(B.x, B.y, B.z, V_LIVE));
    atomicAdd(&bk[BK_LIVE], 1u);
    return;
  }
  if (B.w == V_DONE || B.w == V_FIELD) { atomicAdd(&pool[sum + 5u], 1u); }
}
