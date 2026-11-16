// ---- the engine's substep with bodies meeting bodies (engine.wgsl; docs/design/PHYSICS_ENGINE.md "The join") ---------
// Stage 5 of the note: every contact a row has — its terrain contacts and the contact rows of every pair it is in —
// is solved in parallel, both bodies of a pair corrected consistently. A substep:
//   integrate   a thread a row awake: the tick's start pose kept, gravity and the air; its work words cleared
//   (coarse and fine, src/engine/sdf: the tick's pairs and their contact rows, once a tick, at the first substep)
//   tfine       a workgroup a row awake: its surface samples against the terrain's columns, reduced inside the
//               workgroup to at most TSLOTS contact rows (no thread walks a body's samples alone); erosion; the
//               hardest stop, weighed for deformation
//   pairPrep    (first substep) a thread a pair: its contact rows as the solver keeps them, by each body's own frame
//   pairPre     a thread a pair: who touches, who is held, which sleeper wakes, who deforms; rows a body counted
//   pairSolve   a thread a pair, an iteration: its rows' impulses from both bodies' velocities as the last iteration
//   rowSolve    left them, added into each body's work words; then a thread a row awake takes what its pairs gave it
//               and goes once over its own terrain rows
//   pairPush    a thread a pair: overlaps past the slop as position corrections; a deep one makes the softer deform;
//               the impulses kept by slot for the next tick
//   rowFinish   a thread a row awake: the last terrain pass, the move, the corrections, sleep
// Jacobi between bodies: a pair reads velocities and adds changes as fixed-point atomics, so the sums are the same in
// any order (the run is deterministic). A body in n pair rows gives each row a 1/n share of its mass (mass splitting),
// so the summed impulses never overshoot. Its own terrain rows are solved in turn inside its thread.
// The rules (DESIGN §10.5), for terrain and pairs alike: an impulse only ever stops an approach (separation adds no
// speed); overlap up to the mass-scaled slop is not corrected, past it the bodies are moved apart at pushV at most as
// a change of position; past slop + erode depth the softer (or smaller) loses material — against terrain its sample
// goes to the ground, against a body it is handed to stage 4 (`expand`), whose crumbling conserves mass; a sleeper
// keeps its pose bit for bit until a hit over the wake threshold, and then wakes the tick after with what the solver
// gave it; the speed out is at most restitution x the speed in.
// The helpers below are engine_step.wgsl's (step 1's route, kept as it was: a module binds the list one way only).
@group(0) @binding(10) var<storage, read_write> listA: array<atomic<u32>>;
@group(0) @binding(11) var<storage, read> layersIn: array<vec4<u32>>;
@group(0) @binding(12) var<storage, read> surfaceIn: array<u32>;
@group(0) @binding(13) var driftIn: texture_2d<f32>;
@group(0) @binding(15) var<storage, read_write> events: array<atomic<u32>>;
// a row's terrain rows this substep, TRW vec4 a row:
//   [0] u32 bits: x 1 it touches the ground, y samples eroded this substep (events below), z, w spare
//   [1] x the volume its eroded samples took (cells)
//   [2 + 3k ..] TSLOTS contact rows: [normal xyz, depth] [arm from the centre xyz (world), granular 0/1]
//               [its impulse this substep, the speed out a hit is given (< 0: not yet visited), material, 1 used]
//   [TEV ..] TEVENTS erosion events: [point xyz, volume] [u32 bits: column, material]
@group(0) @binding(40) var<storage, read_write> trow: array<vec4<f32>>;
// a pair's rows as the solver keeps them, PRW vec4 a pair of the tick's list:
//   [0] u32 bits: a, b, rows, slot      [1] x the pair's largest sample energy, w 1 once solved this substep
//   [2 + 3i ..] [the point in a's frame xyz, depth when found] [the point in b's frame xyz, its impulse this substep]
//               [normal xyz (from b to a), the speed out a hit is given]
@group(0) @binding(41) var<storage, read_write> prow: array<vec4<f32>>;
// the impulses kept by pair slot (four rows a slot)
@group(0) @binding(42) var<storage, read_write> pimp: array<vec4<f32>>;
@group(0) @binding(43) var<storage, read> pairBuf: array<u32>;
@group(0) @binding(44) var<storage, read> phits: array<u32>;
struct PContact { a: u32, b: u32, energy: f32, mats: u32, point: vec3<f32>, depth: f32, normal: vec3<f32>, closing: f32 };
@group(0) @binding(45) var<storage, read> pcon: array<PContact>;
@group(0) @binding(46) var<storage, read> slotKeys: array<vec4<u32>>;
@group(0) @binding(47) var<storage, read> missingIn: array<u32>;
@group(0) @binding(48) var<storage, read> pimpOld: array<vec4<f32>>;
@group(0) @binding(49) var<storage, read> slotRemap: array<u32>;
// the terrain lists' dispatch arguments, four words a substep (count, 1, 1, spare); cleared by the host each tick
@group(0) @binding(52) var<storage, read_write> targs: array<atomic<u32>>;

const TSLOTS: u32 = 13u;
const TEVENTS: u32 = 3u;
const TEV: u32 = 41u;
const TRW: u32 = 48u;
const PRW: u32 = 16u;
const PAIR_HEAD: u32 = 64u;
const NO_SLOT: u32 = 0xffffffffu;

struct Ground { top: f32, inside: bool, gran: f32, mat: u32 };

fn groundWalk(c: vec2<i32>, z: f32) -> Ground {
  var g = Ground(-1e9, false, 0.0, 0u);
  let cs = colSlots(u32(c.x), u32(c.y));
  for (var s = 0u; s < cs.y; s++) {
    let v = layersIn[cs.x + s];
    if (ivEmpty(v)) { break; }
    if (ivZ0(v) > z) { break; }
    g.top = ivZ1(v);
    g.mat = ivMat(v);
    g.gran = select(0.0, 1.0, matState(g.mat) == ST_GRANULAR);
    if (z < g.top) {
      g.inside = true;
      return g;
    }
  }
  return g;
}

fn groundAtE(c: vec2<i32>, z: f32) -> Ground {
  if (!inMap(c)) { return Ground(-1e9, false, 0.0, 0u); }
  if ((EU.e.w & 1u) != 0u) {
    // (the height first: the surface pass's word and the loose run's depth give the column's top. The intervals are
    // walked only for a point under the top of a column that has air under its top — a cave, an overhang)
    let s = surfaceIn[colIdxI(c)];
    let d = textureLoad(driftIn, texCol(c), 0);
    let top = sfZ(s) + d.x;
    if (!sfGap(s) || z >= top) {
      if (d.x > 0.0) { return Ground(top, z < top, 1.0, u32(d.z)); }
      return Ground(top, z < top, 0.0, sfMat(s));
    }
  }
  return groundWalk(c, z);
}

fn invInertia(q: vec4<f32>, d: vec3<f32>, o: vec3<f32>, v: vec3<f32>) -> vec3<f32> {
  let b = eqrot(eqinv(q), v);
  let ib = vec3<f32>(d.x * b.x + o.x * b.y + o.y * b.z, o.x * b.x + d.y * b.y + o.z * b.z, o.y * b.x + o.z * b.y + d.z * b.z);
  return eqrot(q, ib);
}

fn pushEvent(kind: u32, row: u32, col: u32, mat: u32, p: vec3<f32>, val: f32) {
  let k = atomicAdd(&events[3], 1u);
  if (k >= u32(EU.f.y)) { return; }
  if (k % 64u == 0u) { atomicAdd(&events[0], 1u); }
  let b = EV_AT + k * EV_WORDS;
  atomicStore(&events[b], kind);
  atomicStore(&events[b + 1u], row);
  atomicStore(&events[b + 2u], col);
  atomicStore(&events[b + 3u], mat);
  atomicStore(&events[b + 4u], bitcast<u32>(p.x));
  atomicStore(&events[b + 5u], bitcast<u32>(p.y));
  atomicStore(&events[b + 6u], bitcast<u32>(p.z));
  atomicStore(&events[b + 7u], bitcast<u32>(val));
}

/** (PA10) a hit on an owner's matter (an External interval: a building): kept past the tick in a ring after the
 *  events' room — count, then HIT_ROOM entries of place and energy — for the host's read after an event (engine.ts
 *  hits): the owner is found from the place. */
fn pushHit(row: u32, p: vec3<f32>, e: f32) {
  let at = EV_AT + u32(EU.f.y) * EV_WORDS;
  let k = atomicAdd(&events[at], 1u) % HIT_ROOM;
  let b = at + 4u + k * 4u;
  atomicStore(&events[b], bitcast<u32>(p.x));
  atomicStore(&events[b + 1u], bitcast<u32>(p.y));
  atomicStore(&events[b + 2u], bitcast<u32>(p.z));
  atomicStore(&events[b + 3u], bitcast<u32>(e));
}

fn fpLoad(i: u32, scale: f32) -> vec3<f32> {
  return vec3<f32>(f32(bitcast<i32>(atomicLoad(&listA[i]))), f32(bitcast<i32>(atomicLoad(&listA[i + 1u]))), f32(bitcast<i32>(atomicLoad(&listA[i + 2u])))) / scale;
}
fn fpTake(i: u32, scale: f32) -> vec3<f32> {
  return vec3<f32>(f32(bitcast<i32>(atomicExchange(&listA[i], 0u))), f32(bitcast<i32>(atomicExchange(&listA[i + 1u], 0u))), f32(bitcast<i32>(atomicExchange(&listA[i + 2u], 0u)))) / scale;
}
fn fpAdd(i: u32, v: vec3<f32>, scale: f32) {
  let q = vec3<i32>(round(clamp(v * scale, vec3<f32>(-2e9), vec3<f32>(2e9))));
  if (q.x != 0) { atomicAdd(&listA[i], bitcast<u32>(q.x)); }
  if (q.y != 0) { atomicAdd(&listA[i + 1u], bitcast<u32>(q.y)); }
  if (q.z != 0) { atomicAdd(&listA[i + 2u], bitcast<u32>(q.z)); }
}
fn fListF(i: u32) -> vec3<f32> {
  return vec3<f32>(bitcast<f32>(atomicLoad(&listA[i])), bitcast<f32>(atomicLoad(&listA[i + 1u])), bitcast<f32>(atomicLoad(&listA[i + 2u])));
}

/** the tick, counted on the GPU (`integrate` at the first substep): the stamps below must not depend on a uniform,
 *  which several ticks encoded before one submit would share */
fn gTick() -> u32 { return atomicLoad(&listA[tickAt()]); }

/** a row's pair contact rows this tick, stamped with the tick (no clear: a sleeper's words are visited by nothing) */
fn nAdd(r: u32, k: u32) {
  let i = rwAt(r) + RW_N;
  let stamp = (gTick() & 0xffffu) << 16u;
  var old = atomicLoad(&listA[i]);
  for (var t = 0u; t < 64u; t++) {
    let base = select(stamp, old, (old & 0xffff0000u) == stamp);
    let res = atomicCompareExchangeWeak(&listA[i], old, base + k);
    if (res.exchanged) { return; }
    old = res.old_value;
  }
}
fn nOf(r: u32) -> f32 {
  let o = atomicLoad(&listA[rwAt(r) + RW_N]);
  if ((o & 0xffff0000u) != ((gTick() & 0xffffu) << 16u)) { return 1.0; }
  return max(1.0, f32(o & 0xffffu));
}

fn slopOf(r: u32) -> f32 {
  let cells = max(info[4u * r + 1u].w / max(info[4u * r + 2u].w, 1e-6), 1.0);
  return EU.b.x + min(EU.b.w, EU.b.y * pow(cells, EU.b.z));
}

/** the hold (engine.wgsl RW_MT) on a row's velocity after gravity: its approach along the kept way is stopped, by no
 *  more than is left of the tick's cap (speeds: the cap is kept over the row's mass) */
fn heldBy(b: u32, v: vec4<f32>, cap: f32) -> vec4<f32> {
  let hold = fListF(b + RW_MH);
  let used = bitcast<f32>(atomicLoad(&listA[b + RW_MUSED]));
  let j = min(cap - used, max(-dot(v.xyz, hold), 0.0));
  if (j <= 0.0) { return v; }
  atomicStore(&listA[b + RW_MUSED], bitcast<u32>(used + j));
  return vec4<f32>(v.xyz + hold * j, v.w);
}

// A thread a row awake: the tick's start pose (the frame is drawn between it and now), gravity and the air.
@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) {
    if ((EU.e.w & 2u) != 0u) { atomicAdd(&listA[tickAt()], 1u); }
    atomicStore(&targs[TARGS_AT + 4u * EU.l.w + 1u], 1u);
    atomicStore(&targs[TARGS_AT + 4u * EU.l.w + 2u], 1u);
  }
  if (id.x >= atomicLoad(&listA[3])) { return; }
  let r = atomicLoad(&listA[LIST_AT + id.x]);
  let b = rwAt(r);
  for (var k = 0u; k < 6u; k++) { atomicStore(&listA[b + k], 0u); }
  for (var k = RW_FLAGS; k < RW_V; k++) { atomicStore(&listA[b + k], 0u); }
  let fl = rowFlags(r);
  // what the deforming voxels touching it gave it last tick (engine_meet.wgsl), taken at the tick's start: never more
  // than brings it to the fastest of them (the sum of many voxels' shares cannot throw it back), and weighed for
  // deformation as a pair's hit is — half the closing by the speed it was given
  var mdv = vec3<f32>(0.0);
  var mdw = vec3<f32>(0.0);
  var mhit = 0.0;
  var mdeep = false;
  if ((EU.e.w & 2u) != 0u) {
    let mn = atomicExchange(&listA[b + RW_MN], 0u);
    atomicStore(&listA[b + RW_MNP], mn);
    // the hold for this tick (engine.wgsl RW_MT): along the mean normal of the voxels that touched it, up to what the
    // hold took last tick and what their reaction adds along it
    let mt = atomicExchange(&listA[b + RW_MT], 0u);
    let ns = fpTake(b + RW_MNS, 1024.0);
    let usedLast = bitcast<f32>(atomicExchange(&listA[b + RW_MUSED], 0u));
    var cap = 0.0;
    var hold = vec3<f32>(0.0);
    if (mt > 0u && dot(ns, ns) > 1e-6) {
      // (the normals run from the row out to the voxels: it is held the other way)
      hold = -normalize(ns);
      let got = fpLoad(b + RW_MDV, FPM);
      cap = usedLast + max(dot(got, hold), 0.0);
    }
    atomicStore(&listA[b + RW_MCAP], bitcast<u32>(cap));
    atomicStore(&listA[b + RW_MH], bitcast<u32>(hold.x));
    atomicStore(&listA[b + RW_MH + 1u], bitcast<u32>(hold.y));
    atomicStore(&listA[b + RW_MH + 2u], bitcast<u32>(hold.z));
    mdv = fpTake(b + RW_MDV, FPM);
    mdw = fpTake(b + RW_MDW, FPM);
    let mc = bitcast<f32>(atomicExchange(&listA[b + RW_MC], 0u));
    mdeep = atomicExchange(&listA[b + RW_MX], 0u) != 0u;
    atomicStore(&listA[b + RW_MP], 0u);
    let ml = length(mdv);
    if (ml > mc) {
      mdv *= mc / max(ml, 1e-9);
      mdw *= mc / max(ml, 1e-9);
    }
    mhit = 0.5 * min(ml, mc) * mc;
  }
  // (it deforms this tick: `expand` takes it as it came in — engine_deform.wgsl; deforming: its voxels carry it)
  if ((fl & (ROW_EXPAND | ROW_DEFORM)) != 0u) { return; }
  let P = pose[4u * r + 2u];
  if ((EU.e.w & 2u) != 0u) {
    pose[4u * r] = P;
    pose[4u * r + 1u] = pose[4u * r + 3u];
    let thr = canDeform(r);
    if (thr > 0.0 && (mhit > thr || mdeep)) { atomicOr(&listA[b + RW_FLAGS], RF_EXPAND); }
  }
  let dt = EU.a.x;
  var v = vel[2u * r];
  var w = vel[2u * r + 1u];
  v = vec4<f32>(v.xyz + mdv, v.w);
  w = vec4<f32>(w.xyz + mdw, w.w);
  // (the host's grab: its spring, before gravity so the weight it holds up cancels; held, it is not still however it hangs)
  if ((fl & ROW_GRAB) != 0u && EU.o.w > 0.5) { v = vec4<f32>(grabPull(P.xyz, v.xyz, dt, info[4u * r + 3u].z), 0.0); }
  v.z -= worldG() * dt;
  v = vec4<f32>(v.xyz * max(0.0, 1.0 - EU.d.x * dt), v.w);
  w = vec4<f32>(w.xyz * max(0.0, 1.0 - EU.d.y * dt), w.w);
  let capNow = bitcast<f32>(atomicLoad(&listA[b + RW_MCAP]));
  if (capNow > 0.0) { v = heldBy(b, v, capNow); }
  vel[2u * r] = v;
  vel[2u * r + 1u] = w;
  atomicStore(&listA[b + RW_V], bitcast<u32>(v.x));
  atomicStore(&listA[b + RW_V + 1u], bitcast<u32>(v.y));
  atomicStore(&listA[b + RW_V + 2u], bitcast<u32>(v.z));
  atomicStore(&listA[b + RW_W], bitcast<u32>(w.x));
  atomicStore(&listA[b + RW_W + 1u], bitcast<u32>(w.y));
  atomicStore(&listA[b + RW_W + 2u], bitcast<u32>(w.z));
  // One test a row before any sample gets a thread (engine_ground.wgsl): its bound's lowest point against the highest
  // ground under its footprint, both widened by what it can travel this substep and a margin (the contact reach, and
  // half a cell for a speed a hit gives it within the substep: it is tested again the next). Above it: no terrain
  // rows this substep, and none read. Else it joins the substep's terrain list, a workgroup of `tfine` each.
  let reach = w.w + length(v.xyz) * dt + EU.f.x + EU.m.w;
  if (P.z - reach > groundTopUnder(P.xy, reach)) {
    atomicOr(&listA[b + RW_FLAGS], RF_AIR);
    return;
  }
  let ta = TARGS_AT + 4u * EU.l.w;
  let k = atomicAdd(&targs[ta], 1u);
  atomicStore(&listA[tlAt(EU.l.w) + k], r);
}

// ---- terrain contacts, reduced ---------------------------------------------------------------------------------------
// a sample's two contacts: the ground under it (g: normal, depth; gm: material, granular) and the walls beside it (w)
struct SC { g: vec4<f32>, gm: vec2<f32>, w: vec4<f32>, wm: vec2<f32> };

fn sampleContacts(x: vec3<f32>, q: vec4<f32>, sm: vec4<f32>) -> SC {
  var o = SC(vec4<f32>(0.0, 0.0, 1.0, NO_CONTACT), vec2<f32>(0.0), vec4<f32>(0.0, 0.0, 1.0, NO_CONTACT), vec2<f32>(0.0));
  let nearGap = EU.f.x;
  let p = x + eqrot(q, sm.xyz);
  let rad = sm.w;
  let c = cellAt(p.xy);
  let g = groundAtE(c, p.z);
  let depth = g.top - (p.z - rad);
  if (depth > -nearGap) {
    o.g.w = depth;
    o.gm = vec2<f32>(f32(g.mat), g.gran);
  }
  // (the walls round a sample taken as one: engine_step.wgsl `fine` says why)
  if (inMap(c)) {
    let cp = cellPos(c);
    var sumN = vec2<f32>(0.0);
    var sumD = 0.0;
    var cnt = 0.0;
    var bestD = NO_CONTACT;
    var bestN = vec2<f32>(0.0);
    var wm = vec2<f32>(0.0);
    for (var k = 0u; k < NDIR; k++) {
      let gn = groundAtE(nbr(c, k), p.z + rad);
      if (gn.top - (p.z - rad) <= EU.d.z * 2.0 * rad) { continue; }
      let dist = 0.5 - dot(p.xy - cp, DIRV[k]);
      sumN -= DIRV[k];
      sumD += dist;
      cnt += 1.0;
      wm = vec2<f32>(f32(gn.mat), gn.gran);
      if (rad - dist > bestD) {
        bestD = rad - dist;
        bestN = -DIRV[k];
      }
    }
    if (cnt > 0.0) {
      let l = length(sumN);
      var wn = bestN;
      var dw = bestD;
      if (l > 0.3) {
        wn = sumN / l;
        dw = rad - sumD / cnt;
      }
      if (dw > -nearGap) {
        o.w = vec4<f32>(wn, 0.0, dw);
        o.wm = wm;
      }
    }
  }
  return o;
}

// (the workgroup's reduction: a bid a slot — score (12 bits) << 20 | sample; the hardest stop; what erosion took)
var<workgroup> wBid: array<atomic<u32>, 13>;
var<workgroup> wWorst: atomic<u32>;
var<workgroup> wEroded: atomic<u32>;
var<workgroup> wLost: atomic<u32>;
var<workgroup> wTouch: atomic<u32>;

fn bid(slot: u32, score: f32, s: u32) {
  atomicMax(&wBid[slot], (u32(clamp(score, 0.0, 1.0) * 4094.0 + 1.0) << 20u) | (s & 0xfffffu));
}

// A workgroup a row of the substep's terrain list (the rows `integrate` could not show clear of the ground). Its 64 threads share its samples out; each sample's contacts bid for the row's contact
// rows: the deepest on the ground and the farthest out along eight directions (they carry a resting or toppling
// body's torque), and the deepest against a wall in each of four quarters. After the barrier a thread a slot writes
// the winner. Past the erode depth in solid ground a sample is lost here (TEVENTS a substep; more wait a substep).
@compute @workgroup_size(64)
fn tfine(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  // (dispatched a workgroup a listed row exactly; the terrain list is never longer than the awake list)
  let on = wg.x < atomicLoad(&listA[3]);
  var r = 0u;
  if (on) { r = atomicLoad(&listA[tlAt(EU.l.w) + wg.x]); }
  let frozen = !on || (rowFlags(r) & (ROW_EXPAND | ROW_DEFORM)) != 0u;
  let m = bitcast<vec4<u32>>(info[4u * r + 2u]);
  let x = pose[4u * r + 2u].xyz;
  let invM = pose[4u * r + 2u].w;
  let q = pose[4u * r + 3u];
  let I0 = info[4u * r];
  let I1 = info[4u * r + 1u];
  let cellMass = info[4u * r + 2u].w;
  let rb = rwAt(r);
  let s0 = sAt(m.x);
  let tb = r * TRW;
  let slop = slopOf(r);
  // (how far out a sample is, as a share of this: bodies wider than 64 cells have their far samples tie)
  let bound = 32.0;
  let thr = expandAt(m.z & 0xffu);
  let weigh = (EU.e.w & 4u) != 0u && thr > 0.0 && (rowFlags(r) & ROW_DENIED) == 0u && bitcast<u32>(info[4u * r + 3u].x) != 0u;
  let v = fListF(rb + RW_V);
  let w = fListF(rb + RW_W);
  let dt = EU.a.x;
  if (!frozen) {
    for (var s = li; s < m.y; s += 64u) {
      let si = s0 + s;
      let sm = samples[si];
      if (sm.w <= 0.0) { continue; }
      let c = sampleContacts(x, q, sm);
      let rl = eqrot(q, sm.xyz);
      // erode, don't push: deeper than slop + erode depth into solid ground, the sample goes to the ground
      let deepG = c.g.w > slop + EU.c.x && c.gm.y < 0.5;
      let deepW = c.w.w > slop + EU.c.x && c.wm.y < 0.5;
      if (deepG || deepW) {
        let k = atomicAdd(&wEroded, 1u);
        if (k < TEVENTS) {
          samples[si] = vec4<f32>(sm.xyz, -sm.w);
          let p = x + rl;
          let col = cellAt(p.xy);
          let vol = 8.0 * sm.w * sm.w * sm.w;
          atomicAdd(&wLost, u32(vol * 1024.0));
          var ci = NONE;
          if (inMap(col)) { ci = colIdxI(col); }
          trow[tb + TEV + 2u * k] = vec4<f32>(p, vol);
          trow[tb + TEV + 2u * k + 1u] = bitcast<vec4<f32>>(vec4<u32>(ci, (m.z >> 8u) & 0xffu, 0u, 0u));
          continue;
        }
      }
      if (c.g.w > NO_CONTACT) {
        if (c.g.w > -0.02) { atomicStore(&wTouch, 1u); }
        bid(0u, (c.g.w + EU.f.x) / (EU.f.x + 1.0), s);
        for (var k = 0u; k < 8u; k++) {
          let a = f32(k) * 0.78539816;
          bid(1u + k, dot(rl.xy, vec2<f32>(cos(a), sin(a))) / bound * 0.5 + 0.5, s);
        }
      }
      if (c.w.w > NO_CONTACT) {
        if (c.w.w > -0.02) { atomicStore(&wTouch, 1u); }
        let quarter = u32(floor(atan2(c.w.y, c.w.x) / 1.5707963 + 2.0)) % 4u;
        bid(9u + quarter, (c.w.w + EU.f.x) / (EU.f.x + 1.0), s);
      }
      // (DESIGN §10.4 "only for bodies in a true collision": the hardest stop among its contacts as it comes in)
      if (weigh) {
        for (var k = 0u; k < 2u; k++) {
          var cc = c.g;
          if (k == 1u) { cc = c.w; }
          if (cc.w <= NO_CONTACT) { continue; }
          let rc = rl - cc.xyz * sm.w;
          let stop = min(cc.w, 0.0) / dt - dot(v + cross(w, rc), cc.xyz);
          if (stop <= 0.0 || 0.5 * stop * stop <= thr) { continue; }
          let rn = cross(rc, cc.xyz);
          let kn = invM + dot(rn, invInertia(q, I0.xyz, I1.xyz, rn));
          atomicMax(&wWorst, bitcast<u32>(0.5 * stop * stop / kn));
        }
      }
    }
  }
  workgroupBarrier();
  if (on && li < TSLOTS) {
    let won = atomicLoad(&wBid[li]);
    var c0 = vec4<f32>(0.0, 0.0, 1.0, NO_CONTACT);
    var c1 = vec4<f32>(0.0);
    var c2 = vec4<f32>(0.0);
    if (won != 0u && !frozen) {
      let sm = samples[s0 + (won & 0xfffffu)];
      let c = sampleContacts(x, q, sm);
      var cc = c.g;
      var cm = c.gm;
      if (li >= 9u) {
        cc = c.w;
        cm = c.wm;
      }
      if (cc.w > NO_CONTACT && sm.w > 0.0) {
        c0 = cc;
        c1 = vec4<f32>(eqrot(q, sm.xyz) - cc.xyz * sm.w, cm.y);
        c2 = vec4<f32>(0.0, -1.0, cm.x, 1.0);
      }
    }
    trow[tb + 2u + 3u * li] = c0;
    trow[tb + 2u + 3u * li + 1u] = c1;
    trow[tb + 2u + 3u * li + 2u] = c2;
  }
  if (on && li == TSLOTS) {
    trow[tb] = bitcast<vec4<f32>>(vec4<u32>(atomicLoad(&wTouch), min(atomicLoad(&wEroded), TEVENTS), 0u, 0u));
    trow[tb + 1u] = vec4<f32>(f32(atomicLoad(&wLost)) / 1024.0, 0.0, 0.0, 0.0);
    if (!frozen && weigh && bitcast<f32>(atomicLoad(&wWorst)) > thr * I1.w) { atomicOr(&listA[rb + RW_FLAGS], RF_EXPAND); }
  }
}

// what a row's thread carries through its terrain rows
struct TS { v: vec3<f32>, w: vec3<f32>, touching: bool, hitE: f32, hitP: vec3<f32>, hitMat: u32 };

/** once over a row's terrain rows, in turn (they are its own: no other thread reads them) */
fn terrainPass(r: u32, x: vec3<f32>, q: vec4<f32>, invM: f32, d: vec3<f32>, o: vec3<f32>, st: TS) -> TS {
  var s = st;
  let tb = r * TRW;
  let dt = EU.a.x;
  for (var k = 0u; k < TSLOTS; k++) {
    let at = tb + 2u + 3u * k;
    let T2 = trow[at + 2u];
    if (T2.w < 0.5) { continue; }
    let c = trow[at];
    let n = c.xyz;
    let rc = trow[at + 1u].xyz;
    let vn = dot(s.v + cross(s.w, rc), n);
    // (a gap may close this substep and no further; an overlap may not deepen)
    let allowed = min(c.w, 0.0) / dt;
    if (c.w > -0.02) { s.touching = true; }
    let rn = cross(rc, n);
    let kn = invM + dot(rn, invInertia(q, d, o, rn));
    var acc = T2.x;
    var want = T2.y;
    if (want < 0.0) {
      want = 0.0;
      if (vn < allowed) {
        let e = 0.5 * (allowed - vn) * (allowed - vn) / kn;
        if (e > s.hitE) {
          s.hitE = e;
          s.hitP = x + rc;
          s.hitMat = u32(T2.z);
        }
        // (a bounce only off a real hit: resting contacts never ring)
        if (c.w >= 0.0 && vn < -1.5) { want = EU.a.z * -vn; }
      }
    }
    let goal = select(allowed, want, want > 0.0);
    let total = max(0.0, acc + (goal - vn) / kn);
    let jn = total - acc;
    trow[at + 2u] = vec4<f32>(total, want, T2.z, T2.w);
    if (jn == 0.0) { continue; }
    s.v += n * (jn * invM);
    s.w += invInertia(q, d, o, rn * jn);
    if (jn <= 0.0) { continue; }
    let vr = s.v + cross(s.w, rc);
    let vt = vr - n * dot(vr, n);
    let vtl = length(vt);
    if (vtl > 1e-5) {
      let t = vt / vtl;
      let rt = cross(rc, t);
      let kt = invM + dot(rt, invInertia(q, d, o, rt));
      let jt = min(EU.a.y * jn, vtl / kt);
      s.v -= t * (jt * invM);
      s.w -= invInertia(q, d, o, rt * jt);
    }
  }
  return s;
}

// ---- pairs -----------------------------------------------------------------------------------------------------------
fn pairCount() -> u32 { return min(pairBuf[0], EU.n.y); }

// (the tick after the pair slots' table grew: every kept impulse to its slot's new place)
@compute @workgroup_size(64)
fn pimpMove(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= EU.n.w) { return; }
  let to = slotRemap[id.x];
  if (to != NO_SLOT && to < EU.n.z) { pimp[to] = pimpOld[id.x]; }
}

// A thread a pair, at the tick's first substep: its contact rows as the solver keeps them. A row's point is kept in
// each body's own frame, so its depth follows the two bodies through the substeps; its impulse starts from what the
// slot kept (a slot of age 0 is clean: nothing carried).
@compute @workgroup_size(64)
fn pairPrep(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = id.x;
  if (p >= pairCount()) { return; }
  let a = pairBuf[PAIR_HEAD + 2u * p];
  let b = pairBuf[PAIR_HEAD + 2u * p + 1u];
  let slot = phits[32u * p + 7u];
  var rows = min(phits[32u * p + 6u], 4u);
  if (slot == NO_SLOT) { rows = 0u; }
  let base = p * PRW;
  var kept = vec4<f32>(0.0);
  var energy = 0.0;
  if (rows > 0u) {
    if (slotKeys[slot].z > 0u) { kept = pimp[slot] * EU.m.y; }
    energy = pcon[4u * slot].energy;
  }
  let xa = pose[4u * a + 2u].xyz;
  let qa = eqinv(pose[4u * a + 3u]);
  let xb = pose[4u * b + 2u].xyz;
  let qb = eqinv(pose[4u * b + 3u]);
  // One plane a pair. The fine pass's first row is the deepest sample with the mean normal of the samples that face
  // its way; its other three are the farthest out, which on a face are rim samples: there the distance field is
  // rounded, so they read a gap of up to 0.4 voxels where the faces touch and a normal leaning out over the edge
  // (BACKLOG PF3). Left as they come, one row carried a resting block and it sank and crept (test/gpu/engine-pairs:
  // the dropped stack). So every row takes the first row's normal, and a rim row's depth is given the rounding back
  // (EU.m.z, cells), never past the deepest: the three then carry a face on a face. (Hack: BACKLOG PJ7.)
  var n0 = vec3<f32>(0.0, 0.0, 1.0);
  var d0 = 0.0;
  if (rows > 0u) {
    n0 = pcon[4u * slot].normal;
    d0 = pcon[4u * slot].depth;
  }
  for (var i = 0u; i < rows; i++) {
    let c = pcon[4u * slot + i];
    var depth = c.depth;
    if (i > 0u) { depth = min(d0, c.depth + EU.m.z); }
    prow[base + 2u + 3u * i] = vec4<f32>(eqrot(qa, c.point - xa), depth);
    prow[base + 2u + 3u * i + 1u] = vec4<f32>(eqrot(qb, c.point - xb), kept[i]);
    prow[base + 2u + 3u * i + 2u] = vec4<f32>(n0, -1.0);
  }
  prow[base] = bitcast<vec4<f32>>(vec4<u32>(a, b, rows, slot));
  prow[base + 1u] = vec4<f32>(energy, 0.0, 0.0, 0.0);
}

/** a row as a pair's thread sees it. mode 0: it cannot be moved this substep (asleep, held, freed); 1: awake; 2: a
 *  sleeper stamped to wake — its velocity is what the solver has given it so far; 3: it deforms: the pair is left */
struct Bd { x: vec3<f32>, q: vec4<f32>, invM: f32, d: vec3<f32>, o: vec3<f32>, v: vec3<f32>, w: vec3<f32>, n: f32, mode: u32 };

fn bodyOf(r: u32) -> Bd {
  let P = pose[4u * r + 2u];
  var o = Bd(P.xyz, pose[4u * r + 3u], 0.0, vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), 1.0, 0u);
  let fl = rowFlags(r);
  if ((fl & ROW_ALIVE) == 0u || P.w <= 0.0) { return o; }
  if ((fl & (ROW_EXPAND | ROW_DEFORM)) != 0u) {
    o.mode = 3u;
    return o;
  }
  let b = rwAt(r);
  if ((fl & ROW_ASLEEP) != 0u) {
    if (atomicLoad(&listA[b + RW_WAKE]) != gTick()) { return o; }
    o.mode = 2u;
    o.v = fpLoad(b + RW_DV, FPV);
    o.w = fpLoad(b + RW_DW, FPV);
  } else {
    let rf = atomicLoad(&listA[b + RW_FLAGS]);
    if ((rf & RF_EXPAND) != 0u) {
      o.mode = 3u;
      return o;
    }
    if ((rf & RF_HOLD) != 0u) { return o; }
    o.mode = 1u;
    o.v = vel[2u * r].xyz;
    o.w = vel[2u * r + 1u].xyz;
  }
  o.invM = P.w;
  o.d = info[4u * r].xyz;
  o.o = info[4u * r + 1u].xyz;
  o.n = nOf(r);
  return o;
}

fn canDeform(r: u32) -> f32 {
  let fl = rowFlags(r);
  let thr = expandAt(bitcast<vec4<u32>>(info[4u * r + 2u]).z & 0xffu);
  if ((EU.e.w & 20u) != 20u || (fl & (ROW_DENIED | ROW_DEFORM)) != 0u || bitcast<u32>(info[4u * r + 3u].x) == 0u) { return 0.0; }
  return thr;
}

// A thread a pair, each substep: what the rows' threads need to know before anything is solved.
//  - a row a room could not serve this tick (`missing`) is held: it is not moved, and the solver treats it as it
//    treats a sleeper, so nothing is pushed through it
//  - a sleeper is asked to wake when the hit's energy over its mass passes the wake threshold (a hit, or what it
//    leans on moving away): until then no impulse reaches it and its pose stays bit for bit
//  - the pair's largest sample energy over a body's mass past its material's bar: it deforms (`expand`)
@compute @workgroup_size(64)
fn pairPre(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = id.x;
  if (p >= pairCount()) { return; }
  let base = p * PRW;
  let H = bitcast<vec4<u32>>(prow[base]);
  let rows = H.z;
  let energy = prow[base + 1u].x;
  prow[base + 1u].w = 0.0;
  let r2 = array<u32, 2>(H.x, H.y);
  var asleep = array<bool, 2>(false, false);
  var invM = array<f32, 2>(0.0, 0.0);
  for (var k = 0u; k < 2u; k++) {
    let r = r2[k];
    let fl = rowFlags(r);
    asleep[k] = (fl & ROW_ASLEEP) != 0u;
    invM[k] = max(pose[4u * r + 2u].w, 0.0);
    if (!asleep[k] && (missingIn[r2[0]] | missingIn[r2[1]]) != 0u) { atomicOr(&listA[rwAt(r) + RW_FLAGS], RF_HOLD); }
  }
  if (rows == 0u) { return; }
  if ((EU.e.w & 2u) != 0u) {
    // (a pair is one share of a body's mass: its own rows are solved in turn on the pair's copy of the two bodies)
    nAdd(r2[0], 1u);
    nAdd(r2[1], 1u);
  }
  // the fastest the two move against each other at a row, and whether any row touches
  let xa = pose[4u * r2[0] + 2u].xyz;
  let qa = pose[4u * r2[0] + 3u];
  let xb = pose[4u * r2[1] + 2u].xyz;
  let qb = pose[4u * r2[1] + 3u];
  var va = vec3<f32>(0.0);
  var wa = vec3<f32>(0.0);
  var vb = vec3<f32>(0.0);
  var wb = vec3<f32>(0.0);
  if (!asleep[0]) {
    va = vel[2u * r2[0]].xyz;
    wa = vel[2u * r2[0] + 1u].xyz;
  }
  if (!asleep[1]) {
    vb = vel[2u * r2[1]].xyz;
    wb = vel[2u * r2[1] + 1u].xyz;
  }
  var rel2 = 0.0;
  var touch = false;
  for (var i = 0u; i < rows; i++) {
    let R0 = prow[base + 2u + 3u * i];
    let R1 = prow[base + 2u + 3u * i + 1u];
    let n = prow[base + 2u + 3u * i + 2u].xyz;
    let rcA = eqrot(qa, R0.xyz);
    let rcB = eqrot(qb, R1.xyz);
    let depth = R0.w - dot((xa + rcA) - (xb + rcB), n);
    let vr = (va + cross(wa, rcA)) - (vb + cross(wb, rcB));
    if (depth > -0.02) { touch = true; }
    // (touching, or a gap that closes within this substep: a hit about to land counts as it comes in)
    if (depth > -0.02 || dot(vr, n) * EU.a.x < depth) { rel2 = max(rel2, dot(vr, vr)); }
  }
  for (var k = 0u; k < 2u; k++) {
    let r = r2[k];
    let rb = rwAt(r);
    if (touch && !asleep[k]) { atomicOr(&listA[rb + RW_FLAGS], RF_TOUCH); }
    if (invM[k] <= 0.0) { continue; }
    let thr = canDeform(r);
    let hard = thr > 0.0 && energy * invM[k] > thr;
    if (asleep[k]) {
      // (the two as one reduced mass: a pebble does not wake a boulder; a boulder moving under a pebble does)
      let reduced = 1.0 / max(invM[0] + invM[1], 1e-9);
      let e = max(energy, 0.5 * reduced * rel2);
      if (e * invM[k] > EU.m.x) {
        atomicStore(&listA[rb + RW_WAKE], gTick());
        if (hard) { atomicMax(&listA[rb + RW_ENERGY], bitcast<u32>(energy)); }
      }
    } else if (hard) {
      atomicOr(&listA[rb + RW_FLAGS], RF_EXPAND);
    }
  }
}

fn kOf(B: Bd, rn: vec3<f32>) -> f32 {
  if (B.invM <= 0.0) { return 0.0; }
  return B.invM + dot(rn, invInertia(B.q, B.d, B.o, rn));
}
fn spinOf(B: Bd, t: vec3<f32>) -> vec3<f32> {
  if (B.invM <= 0.0) { return vec3<f32>(0.0); }
  return invInertia(B.q, B.d, B.o, t);
}

// A thread a pair, an iteration. Velocities are the last iteration's (Jacobi between pairs; the pair's own rows in
// turn on its own copy); each body's changes are added into its work words.
@compute @workgroup_size(64)
fn pairSolve(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = id.x;
  if (p >= pairCount()) { return; }
  let base = p * PRW;
  let H = bitcast<vec4<u32>>(prow[base]);
  let rows = H.z;
  if (rows == 0u) { return; }
  var A = bodyOf(H.x);
  var B = bodyOf(H.y);
  if (A.mode == 3u || B.mode == 3u || (A.invM <= 0.0 && B.invM <= 0.0)) { return; }
  let dt = EU.a.x;
  let first = prow[base + 1u].w == 0.0;
  let va0 = A.v;
  let wa0 = A.w;
  let vb0 = B.v;
  let wb0 = B.w;
  for (var i = 0u; i < rows; i++) {
    let at = base + 2u + 3u * i;
    let R0 = prow[at];
    let R1 = prow[at + 1u];
    let R2 = prow[at + 2u];
    let n = R2.xyz;
    let rcA = eqrot(A.q, R0.xyz);
    let rcB = eqrot(B.q, R1.xyz);
    let depth = R0.w - dot((A.x + rcA) - (B.x + rcB), n);
    let rnA = cross(rcA, n);
    let rnB = cross(rcB, n);
    let kA = kOf(A, rnA);
    let kB = kOf(B, rnB);
    let kn = A.n * kA + B.n * kB;
    if (kn <= 0.0) { continue; }
    var acc = R1.w;
    var want = R2.w;
    var jn = 0.0;
    var vn = dot((A.v + cross(A.w, rcA)) - (B.v + cross(B.w, rcB)), n);
    let allowed = min(depth, 0.0) / dt;
    if (first) {
      want = 0.0;
      if (depth >= 0.0 && vn < -1.5) { want = EU.a.z * -vn; }
      // (what the slot kept is given first, then judged like any impulse: it may be taken back, never below nothing)
      vn += acc * (kA + kB);
      let total = max(0.0, acc + (select(allowed, want, want > 0.0) - vn) / kn);
      jn = total;
      acc = total;
    } else {
      let total = max(0.0, acc + (select(allowed, want, want > 0.0) - vn) / kn);
      jn = total - acc;
      acc = total;
    }
    prow[at + 1u].w = acc;
    prow[at + 2u].w = want;
    if (jn == 0.0) { continue; }
    A.v += n * (jn * A.invM);
    A.w += spinOf(A, rnA * jn);
    B.v -= n * (jn * B.invM);
    B.w -= spinOf(B, rnB * jn);
    if (jn <= 0.0) { continue; }
    // Coulomb friction at the row, by what this iteration added
    let vr = (A.v + cross(A.w, rcA)) - (B.v + cross(B.w, rcB));
    let vt = vr - n * dot(vr, n);
    let vtl = length(vt);
    if (vtl > 1e-5) {
      let t = vt / vtl;
      let rtA = cross(rcA, t);
      let rtB = cross(rcB, t);
      let kt = A.n * kOf(A, rtA) + B.n * kOf(B, rtB);
      let jt = min(EU.a.y * jn, vtl / max(kt, 1e-9));
      A.v -= t * (jt * A.invM);
      A.w -= spinOf(A, rtA * jt);
      B.v += t * (jt * B.invM);
      B.w += spinOf(B, rtB * jt);
    }
  }
  prow[base + 1u].w = 1.0;
  if (A.invM > 0.0) {
    fpAdd(rwAt(H.x) + RW_DV, A.v - va0, FPV);
    fpAdd(rwAt(H.x) + RW_DW, A.w - wa0, FPV);
  }
  if (B.invM > 0.0) {
    fpAdd(rwAt(H.y) + RW_DV, B.v - vb0, FPV);
    fpAdd(rwAt(H.y) + RW_DW, B.w - wb0, FPV);
  }
}

/** a row awake as its own thread sees it; `go` false: it is frozen (it deforms) or held this substep */
struct Mine { go: bool, held: bool, v: vec3<f32>, w: vec3<f32> };

fn takeMine(r: u32) -> Mine {
  var o = Mine(false, false, vec3<f32>(0.0), vec3<f32>(0.0));
  let fl = rowFlags(r);
  let b = rwAt(r);
  let dv = fpTake(b + RW_DV, FPV);
  let dw = fpTake(b + RW_DW, FPV);
  if ((fl & (ROW_EXPAND | ROW_DEFORM)) != 0u) { return o; }
  let rf = atomicLoad(&listA[b + RW_FLAGS]);
  if ((rf & RF_EXPAND) != 0u) {
    // (its hit passed its material's bar: not solved — `expand` hands it to its particles as it came in)
    // (PM1: "as it came in" — this substep's `integrate` gave it gravity and the air already, and its particles take
    // the whole tick's themselves: taken back, or the tick it expands counts a substep of gravity twice)
    let dt = EU.a.x;
    var v0 = vel[2u * r];
    var w0 = vel[2u * r + 1u];
    v0 = vec4<f32>(v0.xyz / max(1e-3, 1.0 - EU.d.x * dt), v0.w);
    w0 = vec4<f32>(w0.xyz / max(1e-3, 1.0 - EU.d.y * dt), w0.w);
    v0.z += worldG() * dt;
    vel[2u * r] = v0;
    vel[2u * r + 1u] = w0;
    info[4u * r].w = bitcast<f32>(fl | ROW_EXPAND);
    return o;
  }
  // (held: a room ran out, it may lack a pair this tick — it keeps its pose and its velocity till the room has grown)
  if ((rf & RF_HOLD) != 0u || missingIn[r] != 0u) {
    o.held = true;
    return o;
  }
  o.go = true;
  o.v = vel[2u * r].xyz + dv;
  o.w = vel[2u * r + 1u].xyz + dw;
  return o;
}

// A thread a row awake, an iteration: what its pairs gave it, then once over its own terrain rows.
@compute @workgroup_size(64)
fn rowSolve(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= atomicLoad(&listA[3])) { return; }
  let r = atomicLoad(&listA[LIST_AT + id.x]);
  let me = takeMine(r);
  if (!me.go) { return; }
  // (in no pair this tick: nothing was added to it, and `rowFinish` goes over its terrain rows every pass itself)
  if ((atomicLoad(&listA[rwAt(r) + RW_N]) & 0xffff0000u) != ((gTick() & 0xffffu) << 16u)) { return; }
  let P = pose[4u * r + 2u];
  var s = TS(me.v, me.w, false, 0.0, P.xyz, 0u);
  // (clear of the ground this substep: it has no terrain rows — what its row of `trow` holds is an older substep's)
  let air = (atomicLoad(&listA[rwAt(r) + RW_FLAGS]) & RF_AIR) != 0u;
  if (!air) { s = terrainPass(r, P.xyz, pose[4u * r + 3u], P.w, info[4u * r].xyz, info[4u * r + 1u].xyz, s); }
  vel[2u * r] = vec4<f32>(s.v, vel[2u * r].w);
  vel[2u * r + 1u] = vec4<f32>(s.w, vel[2u * r + 1u].w);
  // (a hit's energy is weighed at a row's first visit: kept for the finish's event)
  if (s.hitE > 0.0) {
    let tb = r * TRW;
    if (s.hitE > trow[tb + 1u].y) { trow[tb + 1u] = vec4<f32>(trow[tb + 1u].x, s.hitE, f32(s.hitMat), 0.0); }
  }
}

// A thread a pair, when the substep's iterations are done: overlaps past the slop as position corrections (out at
// pushV at most, shared by inverse mass; the velocity never sees them), the deep ones handed to stage 4, and each
// row's impulse kept by slot for the next tick.
@compute @workgroup_size(64)
fn pairPush(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = id.x;
  if (p >= pairCount()) { return; }
  let base = p * PRW;
  let H = bitcast<vec4<u32>>(prow[base]);
  let rows = H.z;
  if (rows == 0u) { return; }
  let A = bodyOf(H.x);
  let B = bodyOf(H.y);
  var kept = vec4<f32>(0.0);
  // (the smaller body's slop: the less overlap of the two)
  let slop = min(slopOf(H.x), slopOf(H.y));
  let ma = select(0.0, A.invM, A.mode == 1u);
  let mb = select(0.0, B.invM, B.mode == 1u);
  var deepest = -1e9;
  for (var i = 0u; i < rows; i++) {
    let at = base + 2u + 3u * i;
    let R0 = prow[at];
    let R1 = prow[at + 1u];
    let n = prow[at + 2u].xyz;
    kept[i] = R1.w;
    let depth = R0.w - dot((A.x + eqrot(A.q, R0.xyz)) - (B.x + eqrot(B.q, R1.xyz)), n);
    deepest = max(deepest, depth);
    let over = min(depth - slop, EU.a.w * EU.a.x);
    if (over <= 0.0 || ma + mb <= 0.0) { continue; }
    if (ma > 0.0) {
      fpAdd(rwAt(H.x) + RW_PUSH, n * (over * ma / (ma + mb)), FPP);
      atomicAdd(&listA[rwAt(H.x) + RW_PUSHN], 1u);
    }
    if (mb > 0.0) {
      fpAdd(rwAt(H.y) + RW_PUSH, -n * (over * mb / (ma + mb)), FPP);
      atomicAdd(&listA[rwAt(H.y) + RW_PUSHN], 1u);
    }
  }
  if (H.w != NO_SLOT && A.mode != 3u && B.mode != 3u) { pimp[H.w] = kept; }
  // erode, don't push: past the erode depth the softer of the two (the lower bar; the same bar: the lighter) loses
  // material — it is handed to stage 4, whose voxels crumble against the other and go to the ground with their mass
  if (deepest > slop + EU.c.x) {
    let ta = canDeform(H.x);
    let tb = canDeform(H.y);
    var loser = NONE;
    if (ta > 0.0 && (tb <= 0.0 || ta < tb || (ta == tb && A.invM >= B.invM))) { loser = H.x; }
    else if (tb > 0.0) { loser = H.y; }
    if (loser != NONE) {
      let fl = rowFlags(loser);
      if ((fl & ROW_ASLEEP) != 0u) { atomicStore(&listA[rwAt(loser) + RW_WAKE], gTick()); }
      else { atomicOr(&listA[rwAt(loser) + RW_FLAGS], RF_EXPAND); }
    }
  }
}

// A thread a row awake, the substep's end: what the last iteration gave it, its terrain rows (every pass, when it is
// in no pair), the move, the corrections, erosion's mass, sleep.
@compute @workgroup_size(64)
fn rowFinish(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) {
    atomicStore(&events[1], 1u);
    atomicStore(&events[2], 1u);
  }
  if (id.x >= atomicLoad(&listA[3])) { return; }
  let r = atomicLoad(&listA[LIST_AT + id.x]);
  let rb = rwAt(r);
  let rf0 = atomicLoad(&listA[rb + RW_FLAGS]);
  let me = takeMine(r);
  let push = fpTake(rb + RW_PUSH, FPP);
  let pushN = atomicExchange(&listA[rb + RW_PUSHN], 0u);
  // (held: the substep's gravity is given back, so it goes on as it was when the room has grown)
  if (me.held) { vel[2u * r].z += worldG() * EU.a.x; }
  if (!me.go) { return; }
  let P = pose[4u * r + 2u];
  let dt = EU.a.x;
  var x = P.xyz;
  var invM = P.w;
  var q = pose[4u * r + 3u];
  var still = vel[2u * r].w;
  let bound = vel[2u * r + 1u].w;
  var I0 = info[4u * r];
  var I1 = info[4u * r + 1u];
  let cellMass = info[4u * r + 2u].w;
  let tb = r * TRW;
  // (clear of the ground this substep — `integrate`: no terrain rows, and what `trow` holds for it is not read)
  let air = (rf0 & RF_AIR) != 0u;
  var TH = vec4<u32>(0u);
  var s = TS(me.v, me.w, false, 0.0, x, 0u);
  if (!air) {
    TH = bitcast<vec4<u32>>(trow[tb]);
    s.hitE = trow[tb + 1u].y;
    s.hitMat = u32(trow[tb + 1u].z);
  }
  // (in pairs its terrain rows were visited every iteration; alone, every pass is here)
  let paired = (atomicLoad(&listA[rb + RW_N]) & 0xffff0000u) == ((gTick() & 0xffffu) << 16u);
  let passes = select(select(EU.e.z, 1u, paired), 0u, air);
  for (var it = 0u; it < passes; it++) { s = terrainPass(r, x, q, invM, I0.xyz, I1.xyz, s); }
  var v = s.v;
  var w = s.w;
  let touching = s.touching || TH.x != 0u || (rf0 & RF_TOUCH) != 0u;
  if (s.touching || TH.x != 0u) {
    v *= max(0.0, 1.0 - EU.f.z * dt);
    w *= max(0.0, 1.0 - EU.f.z * dt);
  }
  // the move
  x += v * dt;
  let dq = vec4<f32>(w * (0.5 * dt), 0.0);
  q = normalize(q + vec4<f32>(dq.w * q.xyz + q.w * dq.xyz + cross(dq.xyz, q.xyz), dq.w * q.w - dot(dq.xyz, q.xyz)));
  // overlaps past the slop: out at pushV (position only) — the deepest of its terrain rows, and its pairs' share
  let slop = slopOf(r);
  var over = 0.0;
  var overN = vec3<f32>(0.0, 0.0, 1.0);
  for (var k = 0u; k < select(TSLOTS, 0u, air); k++) {
    let c = trow[tb + 2u + 3u * k];
    if (trow[tb + 2u + 3u * k + 2u].w > 0.5 && c.w - slop > over) {
      over = c.w - slop;
      overN = c.xyz;
    }
  }
  x += overN * min(over, EU.a.w * dt);
  if (pushN > 0u) { x += push / f32(pushN); }
  // what erosion took (tfine): its mass leaves the row and lands on the columns as loose ground (engine_fold.wgsl)
  var mass = I1.w;
  let mass0 = mass;
  for (var k = 0u; k < min(TH.y, TEVENTS); k++) {
    let E0 = trow[tb + TEV + 2u * k];
    let E1 = bitcast<vec4<u32>>(trow[tb + TEV + 2u * k + 1u]);
    mass -= cellMass * E0.w;
    if (E1.x != NONE) { pushEvent(EV_ERODE, r, E1.x, E1.y, E0.xyz, E0.w); }
  }
  var fl = bitcast<u32>(I0.w);
  if (mass != mass0) {
    if (mass < 0.5 * cellMass) {
      // (all of it gone to the ground: the row ends — freed: no kernel visits it again, in no table of the coarse pass)
      fl = 0u;
      mass = 0.0;
      invM = -1.0;
    } else {
      let k = mass0 / mass;
      invM = 1.0 / mass;
      I0 = vec4<f32>(I0.xyz * k, I0.w);
      I1 = vec4<f32>(I1.xyz * k, mass);
    }
  }
  // sleep, decided here: still for the rest time while touching the ground or a body
  if (touching && length(v) < EU.c.y && length(w) < EU.c.z) { still += dt; } else { still = 0.0; }
  var slept = false;
  // (a bench's held scene, EU.e.w bit 256 — Engine.hold: the row stays where it was, at rest and awake, so every tick
  // does this tick's work again)
  if ((EU.e.w & 256u) != 0u) {
    x = P.xyz;
    q = pose[4u * r + 3u];
    v = vec3<f32>(0.0);
    w = vec3<f32>(0.0);
    still = 0.0;
  }
  if (still > EU.c.w && fl != 0u) {
    fl = fl | ROW_ASLEEP;
    v = vec3<f32>(0.0);
    w = vec3<f32>(0.0);
    slept = true;
  }
  if (s.hitE > EU.d.w) {
    pushEvent(EV_IMPACT, r, 0u, s.hitMat, s.hitP, s.hitE);
    if (s.hitMat == MAT_EXTERNAL) { pushHit(r, s.hitP, s.hitE); }
  }
  pose[4u * r + 2u] = vec4<f32>(x, invM);
  pose[4u * r + 3u] = q;
  if (slept) {
    let c = cellAt(x.xy);
    var word = 0u;
    if (inMap(c)) { word = surfaceIn[colIdxI(c)]; }
    pose[4u * r] = vec4<f32>(x, bitcast<f32>(word));
    pose[4u * r + 1u] = q;
    // (the coarse pass's sleeper table is out of date)
    atomicAdd(&listA[LIST_EPOCH], 1u);
  }
  vel[2u * r] = vec4<f32>(v, still);
  vel[2u * r + 1u] = vec4<f32>(w, bound);
  info[4u * r] = vec4<f32>(I0.xyz, bitcast<f32>(fl));
  info[4u * r + 1u] = vec4<f32>(I1.xyz, mass);
}
