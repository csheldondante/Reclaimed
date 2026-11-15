// ---- the engine's deformation: rows into particles and back (DESIGN §10.4; docs/design/PHYSICS_ENGINE.md, build step 2) ----
// A rigid row owns no particles. An impact past its material's threshold (engine_step.wgsl, `solve`) marks it, and
// `expand` gives it a deform slot and pages of particles from the pool here, all on the GPU; `fill` writes a particle
// a voxel of its model at the row's pose and velocity. The lattice (engine_lattice.wgsl) then deforms them, and settle
// (engine_settle.wgsl) turns the parts back into rows and frees the pages. Host: src/engine/engine.ts.
//
// Particles live in pages of PAGE voxels. A deforming body's voxels are its model's lattice box, cell k = x + w (y + d z),
// in its pages in order: particle = table[k / PAGE] * PAGE + k % PAGE. A page knows its slot and its place in it, so a
// particle carries no body id (no 8-bit id, no body limit), and the lattice neighbours are found by arithmetic.
//
// pool (atomic u32): the allocators. A header, then the free pages' stack, the free slots', the free rows', the slots' sums.
//   Taking: from the free stack, else the next never used (an atomic counter), else — past the room — it fails: counted
//   in the header, the body stays rigid, and the host grows the buffers from the header it reads now and then.
// dmeta (u32): pages' owners [slot + 1 (0 free), place in the slot] x page room; the slots' records, SLOT_W words; the
//   slots' page tables, EU.g.z entries each.
// dargs (u32): [0..2] the lattice's dispatch (8 workgroups a live page), [3] live pages, [4..6] the same while a body
//   settles, then the live pages from DARGS_AT.
// kargs (u32): [0..2] the per-page kernels' dispatch, [4..6] the per-slot kernels' — both zero while nothing deforms
//   (`arm`, one thread a tick, sets them from the pool) — [8..10] the draw list's (engine_draw.wgsl).
// heap (vec4): models and meshes. A model at h: [w, d, h, solid cells] [mesh first vertex (hAt), vertices, material |
//   loose << 8, the parity of its box's first row (the hex lattice: odd rows sit half a cell right)] [a cell's mean
//   mass, bound radius, 0, 0] [its lattice's frame in its rest frame (a quaternion: the identity for a model the host
//   bakes; a settled part's rest frame is the world's where it settled)], then a record a lattice cell: xyz its rest
//   place about the centre of mass, w (u32) material (6 bits; 0 none) | its 26 bonds << 6. A mesh vertex is MESH_V
//   vec4: [its four voxels (cell k; NONE) — the first is the cell whose face the vertex is on] [their weights] [its
//   rest place, its material word].
const PAGE: u32 = 512u;
const POOL_HDR: u32 = 64u;
const SLOT_W: u32 = 28u;
const SUMS_W: u32 = 16u;
const DARGS_AT: u32 = 16u;
const MODEL_HDR: u32 = 4u;
const MESH_V: u32 = 3u;
// the pool's header
const P_PAGE_TOP: u32 = 0u;
const P_PAGE_NEXT: u32 = 1u;
const P_PAGE_WANT: u32 = 2u;
const P_SLOT_TOP: u32 = 3u;
const P_SLOT_NEXT: u32 = 4u;
const P_SLOT_WANT: u32 = 5u;
const P_ROW_TOP: u32 = 6u;
const P_ROW_NEXT: u32 = 7u;
const P_ROW_WANT: u32 = 8u;
const P_SAMP_NEXT: u32 = 9u;
const P_SAMP_WANT: u32 = 10u;
const P_HEAP_NEXT: u32 = 11u;
const P_HEAP_WANT: u32 = 12u;
// expansions that found no room (the body stayed rigid), settles that found none (tried again the next tick)
const P_FAIL_EXPAND: u32 = 13u;
const P_FAIL_SETTLE: u32 = 14u;
// slots in use, bodies expanded ever, parts made rows ever, voxels gone to the ground ever
const P_DEFORMING: u32 = 15u;
const P_EXPANDS: u32 = 16u;
const P_PARTS: u32 = 17u;
const P_CRUMBS: u32 = 18u;
// the draw list: triangles wanted (whether it is to be made again: P_DL_DIRTY, engine.wgsl)
const P_DL_WANT: u32 = 19u;
// slots settling now (labels, parts)
const P_SETTLING: u32 = 21u;
// the voxel hash's chains cut short by its guard, ever (engine_lattice.wgsl: contacts past it were not seen)
const P_HASH_OVER: u32 = 22u;
// a slot's state
const S_FREE: u32 = 0u;
const S_NEW: u32 = 1u;
const S_LIVE: u32 = 2u;
const S_LABEL0: u32 = 3u;
const S_LABEL1: u32 = 4u;
const S_PARTS: u32 = 5u;
const S_RELEASE: u32 = 6u;
// still, and settle not built yet (letter D): its particles stand, no lattice kernel steps them, its mesh is drawn by them
const S_STILL: u32 = 7u;
// The draw list (engine_draw.wgsl; settle's mesh kernels walk it too), u32: [0..3] the draw's arguments (vertices, 1,
// 0, 0), [4..6] the frame's `eskin` dispatch, [7] triangles listed, [8] those of rows awake or deforming (they come
// first), [9] those of rows asleep, [10] triangles `eskin` places this frame, [11] the awake ones (what a frame places
// once the list has been placed whole), [12..14] the settle mesh kernels' dispatch (zero while nothing settles), then
// two words a triangle from DL_AT: its row, its first vertex's place in the heap.
const DL_AT: u32 = 16u;
// a slot's record: [0] state, [1] row (NONE: none to free), [2] model (heap index), [3..5] its lattice box, [6] pages,
// [7] how long it has been still (f32), [8..10] the row's centre when it expanded, [11..14] its rotation, [15..17] its
// velocity, [18..20] its spin, [21] voxels alive at the last count, [22] its material | loose << 8, [23] the row's
// bound radius when it expanded (f32: a body that settles whole gets it back), [24] parts of it made rows so far
const PV_DEAD: f32 = -1.0;
const PV_CRUMBLE: f32 = -2.0;

@group(0) @binding(18) var<storage, read_write> pool: array<atomic<u32>>;
@group(0) @binding(19) var<storage, read_write> dmeta: array<u32>;
@group(0) @binding(20) var<storage, read_write> dargsW: array<atomic<u32>>;
@group(0) @binding(21) var<storage, read> dargs: array<u32>;
@group(0) @binding(22) var<storage, read_write> heap: array<vec4<f32>>;
// particle i: px[2i] xyz, w inverse mass (< 0: none; PV_CRUMBLE: `deaths` ends it); px[2i+1] xyz its place before this
// substep, w its bonds (u32 bits: pb's word, kept here too for the draw, which has no binding left for pb)
@group(0) @binding(23) var<storage, read_write> px: array<vec4<f32>>;
// ps[3i] velocity; ps[3i+1] xyz its rest place (the model's frame; follows a plastic bend), w its material (u32);
// ps[3i+2] its region's rotation
@group(0) @binding(24) var<storage, read_write> ps: array<vec4<f32>>;
// pw[3i] its region's centre now about its own place, w mass; pw[3i+1] its rest centre; pw[3i+2] this substep's contacts (settling: its label)
@group(0) @binding(25) var<storage, read_write> pw: array<vec4<f32>>;
// its bonds: bit k set while bonded to lattice neighbour k (n26)
@group(0) @binding(26) var<storage, read_write> pb: array<u32>;
@group(0) @binding(27) var<storage, read> rlist: array<u32>;
@group(0) @binding(37) var<storage, read_write> kargs: array<atomic<u32>>;
// the rigid rows a deforming body's voxels may meet this tick (engine_meetlink.wgsl writes it, engine_meet.wgsl walks
// it): a head a slot, then a record a pair
@group(0) @binding(51) var<storage, read_write> cand: array<u32>;
// the lattice's material table (physics.ts PHYS_MATS, 4 vec4 a material)
@group(0) @binding(35) var<uniform> PM: array<vec4<f32>, 192>;
// The voxel hash (u32, atomic), sized by the particles' room (V = pages x PAGE): [0] chains cut short by the guard since
// `arm` last took the count (never silent: the pool's header has the total), heads from VH_AT, 2V of them (a particle
// + 1; 0 none), then three words a particle: the next of its chain (+ 1), its bucket's index (0: not in), its bonds as
// they stood when it went in. Only what was put in is cleared (`relax`, each particle its own bucket), so its cost
// follows the voxels deforming, and between substeps it is all zero: a grown one starts empty.
@group(0) @binding(38) var<storage, read_write> vh: array<atomic<u32>>;
const VH_AT: u32 = 4u;
const VH_GUARD: u32 = 128u;
fn vhBucket(c: vec3<i32>) -> u32 {
  return VH_AT + ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u)) % (2u * EU.g.x * PAGE);
}
fn vhRec(i: u32) -> u32 { return VH_AT + 2u * EU.g.x * PAGE + 3u * i; }
fn pmA(m: u32) -> vec4<f32> { return PM[m * 4u]; }
fn pmB(m: u32) -> vec4<f32> { return PM[m * 4u + 1u]; }
fn pmC(m: u32) -> vec4<f32> { return PM[m * 4u + 2u]; }
fn pmD(m: u32) -> vec4<f32> { return PM[m * 4u + 3u]; }

fn slotAt(s: u32) -> u32 { return EU.i.y + SLOT_W * s; }
fn slotF(s: u32, k: u32) -> f32 { return bitcast<f32>(dmeta[slotAt(s) + k]); }
fn slotV3(s: u32, k: u32) -> vec3<f32> { return vec3<f32>(slotF(s, k), slotF(s, k + 1u), slotF(s, k + 2u)); }
fn slotDims(s: u32) -> vec3<u32> { return vec3<u32>(dmeta[slotAt(s) + 3u], dmeta[slotAt(s) + 4u], dmeta[slotAt(s) + 5u]); }

// Where particle i sits: its slot, its lattice cell k, the box. ok: its page is a body's.
struct Lat { slot: u32, k: u32, dims: vec3<u32>, state: u32, ok: bool };
fn latOf(i: u32) -> Lat {
  var L: Lat;
  let pg = i / PAGE;
  let o = dmeta[EU.i.x + 2u * pg];
  L.ok = o != 0u;
  if (!L.ok) { return L; }
  L.slot = o - 1u;
  L.k = dmeta[EU.i.x + 2u * pg + 1u] * PAGE + (i % PAGE);
  L.dims = slotDims(L.slot);
  L.state = dmeta[slotAt(L.slot)];
  return L;
}
/** the particle of lattice cell k of a slot */
fn partAt(slot: u32, k: u32) -> u32 { return dmeta[EU.i.z + slot * EU.g.z + k / PAGE] * PAGE + (k % PAGE); }
fn cellOf(k: u32, d: vec3<u32>) -> vec3<i32> { return vec3<i32>(i32(k % d.x), i32((k / d.x) % d.y), i32(k / (d.x * d.y))); }
/** the particle of lattice cell l of a slot, or -1 outside its box */
fn latIdx(slot: u32, l: vec3<i32>, d: vec3<u32>) -> i32 {
  if (any(l < vec3<i32>(0)) || any(vec3<u32>(l) >= d)) { return -1; }
  return i32(partAt(slot, u32(l.x) + d.x * (u32(l.y) + d.y * u32(l.z))));
}
/** Lattice neighbour k (0..25) of 26: every offset in -1..1 but the centre; 25 - k is the way back. */
fn n26(k: u32) -> vec3<i32> {
  let j = select(k, k + 1u, k >= 13u);
  return vec3<i32>(i32(j % 3u) - 1, i32((j / 3u) % 3u) - 1, i32(j / 9u) - 1);
}
fn alive(i: u32) -> bool { return px[2u * i].w >= 0.0; }
fn matOf(i: u32) -> u32 { return bitcast<u32>(ps[3u * i + 1u].w) & 63u; }

/**
 * A mesh vertex's voxels that carry it: the cell whose face it is on (its first), and those of its others that cell is
 * still bonded to. So a face follows its own side of a crack — while the body deforms (engine_draw.wgsl) and when its
 * part's mesh is baked (engine_settle.wgsl), by the one rule: nothing moves when it settles.
 */
fn carries(slot: u32, d: vec3<u32>, own: u32, ownBonds: u32, k: u32) -> bool {
  if (k == own) { return true; }
  let dl = cellOf(k, d) - cellOf(own, d);
  if (any(abs(dl) > vec3<i32>(1))) { return false; }
  let b = u32((dl.x + 1) + 3 * (dl.y + 1) + 9 * (dl.z + 1));
  return (ownBonds & (1u << select(b, b - 1u, b > 13u))) != 0u;
}
/** The particle a thread of a per-particle dispatch has (8 workgroups of 64 a live page), or NONE. */
fn pidx(wg: u32, li: u32) -> u32 {
  let n = wg / 8u;
  if (n >= dargs[3]) { return NONE; }
  return dargs[DARGS_AT + n] * PAGE + (wg % 8u) * 64u + li;
}

/** One from a pool: the free stack, else the next never used, else NONE (past the room: `want` tells the host). */
fn takeOne(top: u32, next: u32, want: u32, stack: u32, room: u32) -> u32 {
  let t = atomicSub(&pool[top], 1u);
  if (t >= 1u && t <= room) { return atomicLoad(&pool[stack + t - 1u]); }
  atomicAdd(&pool[top], 1u);
  let b = atomicAdd(&pool[next], 1u);
  atomicMax(&pool[want], b + 1u);
  if (b < room) { return b; }
  atomicSub(&pool[next], 1u);
  return NONE;
}
/** n in a row from a bump counter (the GPU's half of the samples or the heap), or NONE */
fn takeRun(next: u32, want: u32, room: u32, n: u32) -> u32 {
  let b = atomicAdd(&pool[next], n);
  atomicMax(&pool[want], b + n);
  if (b + n <= room) { return b | 0x80000000u; }
  atomicSub(&pool[next], n);
  return NONE;
}
// one thread, every tick after `expand`: the per-page and per-slot kernels are dispatched only while a slot is in use
@compute @workgroup_size(1)
fn arm() {
  let on = atomicLoad(&pool[P_DEFORMING]) != 0u;
  atomicStore(&kargs[0], select(0u, (EU.g.x + 63u) / 64u, on));
  atomicStore(&kargs[1], 1u);
  atomicStore(&kargs[2], 1u);
  atomicStore(&kargs[4], select(0u, (EU.g.y + 63u) / 64u, on));
  atomicStore(&kargs[5], 1u);
  atomicStore(&kargs[6], 1u);
}

// ---- expand: a thread a row awake; a marked row gets a slot and its pages ------------------------------------------
@compute @workgroup_size(64)
fn expand(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= rlist[3]) { return; }
  let r = rlist[LIST_AT + id.x];
  var fl = rowFlags(r);
  if ((fl & ROW_EXPAND) == 0u) {
    // (refused last tick: it has had its rigid tick, and may ask again)
    if ((fl & ROW_DENIED) != 0u) { info[4u * r].w = bitcast<f32>(fl & ~ROW_DENIED); }
    return;
  }
  let ids = bitcast<vec4<u32>>(info[4u * r + 3u]);
  let mh = hAt(ids.x);
  let dm = bitcast<vec4<u32>>(heap[mh]);
  let pages = (dm.x * dm.y * dm.z + PAGE - 1u) / PAGE;
  var slot = NONE;
  if (pages <= EU.g.z) { slot = takeOne(P_SLOT_TOP, P_SLOT_NEXT, P_SLOT_WANT, EU.h.y, EU.g.y); }
  if (slot == NONE) {
    atomicAdd(&pool[P_FAIL_EXPAND], 1u);
    info[4u * r].w = bitcast<f32>((fl & ~ROW_EXPAND) | ROW_DENIED);
    return;
  }
  atomicAdd(&pool[P_DEFORMING], 1u);
  // Its pages, all or none (bodies expanding in one tick each taking some and none enough would starve them all): what
  // the free stack has, the rest never used. Nothing is pushed in this dispatch, so the stack's entries stand still.
  let t = atomicSub(&pool[P_PAGE_TOP], pages);
  var have = 0u;
  if (t <= EU.g.x) { have = min(t, pages); }
  if (have < pages) { atomicAdd(&pool[P_PAGE_TOP], pages - have); }
  let need = pages - have;
  var b = 0u;
  var got = true;
  if (need > 0u) {
    b = atomicAdd(&pool[P_PAGE_NEXT], need);
    atomicMax(&pool[P_PAGE_WANT], b + need);
    if (b + need > EU.g.x) {
      atomicSub(&pool[P_PAGE_NEXT], need);
      atomicAdd(&pool[P_PAGE_TOP], have);
      got = false;
    }
  }
  let s = slotAt(slot);
  dmeta[s + 6u] = select(0u, pages, got);
  for (var j = 0u; j < pages && got; j++) {
    var pg = b + j - have;
    if (j < have) { pg = atomicLoad(&pool[EU.h.x + t - 1u - j]); }
    dmeta[EU.i.z + slot * EU.g.z + j] = pg;
    dmeta[EU.i.x + 2u * pg] = slot + 1u;
    dmeta[EU.i.x + 2u * pg + 1u] = j;
  }
  if (!got) {
    // (no room for its pages: the slot goes back at this tick's end — `slots` — and the row stays rigid)
    dmeta[s] = S_RELEASE;
    dmeta[s + 1u] = NONE;
    atomicAdd(&pool[P_FAIL_EXPAND], 1u);
    info[4u * r].w = bitcast<f32>((fl & ~ROW_EXPAND) | ROW_DENIED);
    return;
  }
  dmeta[s] = S_NEW;
  dmeta[s + 1u] = r;
  dmeta[s + 2u] = ids.x;
  dmeta[s + 3u] = dm.x;
  dmeta[s + 4u] = dm.y;
  dmeta[s + 5u] = dm.z;
  dmeta[s + 7u] = 0u;
  let x = pose[4u * r + 2u].xyz;
  let q = pose[4u * r + 3u];
  let v = vel[2u * r].xyz;
  let w = vel[2u * r + 1u].xyz;
  dmeta[s + 8u] = bitcast<u32>(x.x);
  dmeta[s + 9u] = bitcast<u32>(x.y);
  dmeta[s + 10u] = bitcast<u32>(x.z);
  dmeta[s + 11u] = bitcast<u32>(q.x);
  dmeta[s + 12u] = bitcast<u32>(q.y);
  dmeta[s + 13u] = bitcast<u32>(q.z);
  dmeta[s + 14u] = bitcast<u32>(q.w);
  dmeta[s + 15u] = bitcast<u32>(v.x);
  dmeta[s + 16u] = bitcast<u32>(v.y);
  dmeta[s + 17u] = bitcast<u32>(v.z);
  dmeta[s + 18u] = bitcast<u32>(w.x);
  dmeta[s + 19u] = bitcast<u32>(w.y);
  dmeta[s + 20u] = bitcast<u32>(w.z);
  dmeta[s + 21u] = dm.w;
  dmeta[s + 22u] = bitcast<u32>(heap[mh + 1u].z);
  dmeta[s + 23u] = bitcast<u32>(vel[2u * r + 1u].w);
  dmeta[s + 24u] = 0u;
  // (the drawn pose stops here: the frame's draw is by the particles from now)
  pose[4u * r] = pose[4u * r + 2u];
  pose[4u * r + 1u] = q;
  info[4u * r + 3u] = bitcast<vec4<f32>>(vec4<u32>(ids.x, slot, ids.z, ids.w));
  info[4u * r].w = bitcast<f32>((fl & ~(ROW_EXPAND | ROW_ASLEEP | ROW_DENIED)) | ROW_DEFORM);
  atomicAdd(&pool[P_EXPANDS], 1u);
  atomicStore(&pool[P_DL_DIRTY], 1u);
}

// ---- the live pages, listed (a thread a page; dispatched only while something deforms) -------------------------------
@compute @workgroup_size(64)
fn pagelist(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) {
    atomicStore(&dargsW[1], 1u);
    atomicStore(&dargsW[2], 1u);
    atomicStore(&dargsW[5], 1u);
    atomicStore(&dargsW[6], 1u);
  }
  let pg = id.x;
  if (pg >= EU.g.x || dmeta[EU.i.x + 2u * pg] == 0u) { return; }
  let k = atomicAdd(&dargsW[3], 1u);
  atomicAdd(&dargsW[0], 8u);
  if (atomicLoad(&pool[P_SETTLING]) != 0u) { atomicAdd(&dargsW[4], 8u); }
  atomicStore(&dargsW[DARGS_AT + k], pg);
}

// ---- fill: a thread a particle of the live pages; a new slot's particles are written from its model ------------------
// At this moment every particle sits exactly at pose x rest place with the row's rotation, so the mesh skinned to them
// (engine_draw.wgsl) is the rigid mesh: nothing moves on the screen when a body expands.
@compute @workgroup_size(64)
fn fill(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  if (i == NONE) { return; }
  let L = latOf(i);
  if (!L.ok || L.state != S_NEW) { return; }
  var mw = 0u;
  var rest = vec3<f32>(0.0);
  if (L.k < L.dims.x * L.dims.y * L.dims.z) {
    let m = heap[hAt(dmeta[slotAt(L.slot) + 2u]) + MODEL_HDR + L.k];
    mw = bitcast<u32>(m.w);
    rest = m.xyz;
  }
  let mat = mw & 63u;
  if (mat == 0u) {
    px[2u * i] = vec4<f32>(0.0, 0.0, 0.0, PV_DEAD);
    pb[i] = 0u;
    return;
  }
  let q = vec4<f32>(slotV3(L.slot, 11u), slotF(L.slot, 14u));
  let rl = eqrot(q, rest);
  let p = slotV3(L.slot, 8u) + rl;
  px[2u * i] = vec4<f32>(p, 1.0 / max(pmA(mat).x, 0.01));
  px[2u * i + 1u] = vec4<f32>(p, bitcast<f32>(mw >> 6u));
  ps[3u * i] = vec4<f32>(slotV3(L.slot, 15u) + cross(slotV3(L.slot, 18u), rl), 0.0);
  ps[3u * i + 1u] = vec4<f32>(rest, bitcast<f32>(mat));
  ps[3u * i + 2u] = q;
  pw[3u * i] = vec4<f32>(0.0);
  pw[3u * i + 1u] = vec4<f32>(rest, 0.0);
  pw[3u * i + 2u] = vec4<f32>(0.0);
  pb[i] = mw >> 6u;
}

// ---- release: a thread a page; a page of a slot being let go returns to the free stack -----------------------------
// (pushes only here and pops only in `expand`: two dispatches, so the stack is never popped while it is pushed)
@compute @workgroup_size(64)
fn release(@builtin(global_invocation_id) id: vec3<u32>) {
  let pg = id.x;
  if (pg >= EU.g.x) { return; }
  let o = dmeta[EU.i.x + 2u * pg];
  if (o == 0u || dmeta[slotAt(o - 1u)] != S_RELEASE) { return; }
  dmeta[EU.i.x + 2u * pg] = 0u;
  let k = atomicAdd(&pool[P_PAGE_TOP], 1u);
  atomicStore(&pool[EU.h.x + k], pg);
}

// ---- slots: a thread a slot, at the tick's end; each slot's state moves on here and nowhere else ---------------------
// The sums the particles left this tick (engine_lattice.wgsl `stats`): [0] voxels alive, [1] the sum of their speeds
// x 256, [2] labels changed (settling), [3] voxels waiting to go to the ground, [4] a part found no room, [6] the
// fastest voxel's speed x 256, [8..10] and [11..13] the voxels' bounds about where the body expanded (the most of
// (1024 + x) x 64 and of (1024 - x) x 64 an axis; 0: none counted).
// A deforming body's row is kept in the coarse pass's tables by these: its centre the middle of its voxels' bounds,
// its radius theirs and what they can cover in a tick, its rotation the zero quaternion (engine.wgsl ROW_DEFORM); the
// mean speed of its voxels is in its still timer's word (engine_meetlink.wgsl weighs it for a sleeper beside it).
@compute @workgroup_size(64)
fn slots(@builtin(global_invocation_id) id: vec3<u32>) {
  let sl = id.x;
  if (sl >= EU.g.y) { return; }
  let s = slotAt(sl);
  let st = dmeta[s];
  if (st == S_FREE) { return; }
  let sum = EU.h.w + SUMS_W * sl;
  let n = atomicExchange(&pool[sum], 0u);
  let speed = f32(atomicExchange(&pool[sum + 1u], 0u)) / 256.0;
  let changed = atomicExchange(&pool[sum + 2u], 0u);
  let waiting = atomicExchange(&pool[sum + 3u], 0u);
  let failed = atomicExchange(&pool[sum + 4u], 0u);
  let fast = f32(atomicExchange(&pool[sum + 6u], 0u)) / 256.0;
  var bhi = vec3<f32>(0.0);
  var blo = vec3<f32>(0.0);
  var bound = true;
  for (var k = 0u; k < 3u; k++) {
    let hiw = atomicExchange(&pool[sum + 8u + k], 0u);
    let low = atomicExchange(&pool[sum + 11u + k], 0u);
    if (hiw == 0u || low == 0u) { bound = false; }
    bhi[k] = f32(hiw) / 64.0 - 1024.0;
    blo[k] = 1024.0 - f32(low) / 64.0;
  }
  let row = dmeta[s + 1u];
  // (this tick's candidate rows are done with)
  cand[sl] = 0u;
  if (st != S_RELEASE && row != NONE && bound && (rowFlags(row) & (ROW_ALIVE | ROW_DEFORM)) == (ROW_ALIVE | ROW_DEFORM)) {
    let tick = EU.k.w * f32(EU.l.z);
    pose[4u * row + 2u] = vec4<f32>(slotV3(sl, 8u) + 0.5 * (blo + bhi), pose[4u * row + 2u].w);
    pose[4u * row + 3u] = vec4<f32>(0.0);
    vel[2u * row] = vec4<f32>(vel[2u * row].xyz, speed / max(f32(n), 1.0));
    // (half a cell a voxel, and a cell for what a row coming at it covers before the lattice's substeps see it)
    vel[2u * row + 1u] = vec4<f32>(vel[2u * row + 1u].xyz, 0.5 * length(bhi - blo) + 1.5 + fast * tick);
  }
  // the host lets it go (a lab's reset, a test)
  var drop = false;
  for (var c = 0u; c < EU.e.y; c++) {
    if (EC[c].b.x == 6u && (EC[c].b.y == NONE || EC[c].b.y == row)) { drop = true; }
  }
  if (st == S_RELEASE) {
    // (its pages went back just now, in `release`: the slot and the row it expanded from go too)
    if (row != NONE) {
      info[4u * row].w = bitcast<f32>(0u);
      pose[4u * row + 2u].w = -1.0;
      atomicStore(&pool[P_DL_DIRTY], 1u);
      // (a row the GPU made — an odd one — goes back on the free rows' stack: popped only in `partAlloc`)
      if ((row & 1u) == 1u) {
        let k = atomicAdd(&pool[P_ROW_TOP], 1u);
        atomicStore(&pool[EU.h.z + k], row >> 1u);
      }
    }
    dmeta[s] = S_FREE;
    let k = atomicAdd(&pool[P_SLOT_TOP], 1u);
    atomicStore(&pool[EU.h.y + k], sl);
    atomicSub(&pool[P_DEFORMING], 1u);
    return;
  }
  if (drop) {
    if (st >= S_LABEL0 && st <= S_PARTS) { atomicSub(&pool[P_SETTLING], 1u); }
    dmeta[s] = S_RELEASE;
    return;
  }
  if (st == S_NEW) {
    dmeta[s] = S_LIVE;
    return;
  }
  dmeta[s + 21u] = n;
  if (st == S_LIVE) {
    // (nothing of it left: all gone to the ground)
    if (n == 0u && waiting == 0u) {
      dmeta[s] = S_RELEASE;
      return;
    }
    // still: its voxels' mean speed under the still speed for the still time, and none on its way to the ground
    var still = bitcast<f32>(dmeta[s + 7u]);
    if (n > 0u && speed / f32(n) < EU.k.x && waiting == 0u) { still += EU.k.w * f32(EU.l.z); } else { still = 0.0; }
    dmeta[s + 7u] = bitcast<u32>(still);
    if (still > EU.k.y) {
      if ((EU.e.w & 8u) != 0u) {
        dmeta[s] = S_LABEL0;
        atomicAdd(&pool[P_SETTLING], 1u);
      } else {
        dmeta[s] = S_STILL;
      }
    }
    return;
  }
  if (st == S_LABEL0) {
    dmeta[s] = S_LABEL1;
    return;
  }
  if (st == S_LABEL1) {
    // (the labels stood still a whole tick: every part has one label)
    if (changed == 0u) { dmeta[s] = S_PARTS; }
    return;
  }
  if (st == S_PARTS) {
    // (every part a row or on its way to the ground; a part that found no room is tried again)
    if (failed == 0u && waiting == 0u) {
      dmeta[s] = S_RELEASE;
      atomicSub(&pool[P_SETTLING], 1u);
    }
    return;
  }
}
