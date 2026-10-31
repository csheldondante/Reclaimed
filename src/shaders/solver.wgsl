// ---- solver.wgsl: the one node solver (BACKLOG AR4; docs/PHYSICS.md "The node solver") ----------------------------
// The design (DECISIONS round 106, the user's "Reclaimed physics: a design to discuss"): one XPBD-style constraint solver
// on the GPU for everything that breaks free — rock, buildings, metal — grown from the physics voxels' lattice shape
// matching (phys.wgsl, the tankers) at a coarser grain. A body is a few to 64 NODES (points with mass, each standing for
// a block of the cells it was made from) joined by BONDS (a 64-bit mask per node: which of its body's nodes it is held
// to) with a rest shape. Rock is RIGID: each connected part of its bond graph is one shape-matching cluster solved
// exactly every iteration — it never flexes, it shatters (the host cuts its bonds). Metal and wood are DEFORMABLE: each
// node's region (itself and what it's bonded to) is shape-matched toward its rest shape, softly; past the yield
// stress the rest shape follows (plastic: bent and dented), past the break stress a bond goes (it snaps; the graph
// splits). The world is felt through up to 64 CONTACT POINTS per body (on its surface, each riding a node): the
// ground from the layers, other bodies' nodes as spheres.
//
// One workgroup a body slot (64 threads: node l and point l), every substep and iteration of a tick inside one
// dispatch (workgroup barriers, the state in workgroup memory): one dispatch a tick for all bodies. Other bodies are
// read from a snapshot taken before the dispatch (`snap`), moved on by their velocity: deterministic, no races.
//
// The contact rules (the user's notes, each a slider — tune/params.ts `rigid`, whose names they keep):
//  - an overlap up to the SLOP is never corrected (surface deformation at the contact, the user round 120: "Big things
//    can push into each other and not push back"): slop = rigid.slop + min(rigid.slopCap, rigid.slopK · cells^slopP),
//    the lighter body's against another body (the ground counts as heaviest), never less than the overlap it was
//    freed with (`allow`, which only shrinks);
//  - past it a contact stops the point moving further in, and pushes out at most rigid.pushV — never faster, and the
//    push-out part is taken off the velocity: separation never adds speed, no bounce (restitution ~0);
//  - friction (Coulomb, at the position level: static and sliding) and angular response stay: deflect and topple;
//  - past slop + rigid.erodeDepth into ground that isn't an External thing, the point isn't pushed: the ground there is
//    reported to erode (the host crumbles it into dust and rubble);
//  - a sleeping body stays put: contact never moves it; another body's impact on it (speed × mass past
//    solver.wakeImpulse) wakes it; so does losing its support (dug out under it);
//  - the hardest approach a tick is reported (impacts: the host turns the energy into particles, and breaks rock).
//
// Bindings (solver.ts): 0 Globals, 1 chunks, 2 materials (layers.wgsl, materials.wgsl), 3+ below.

const NN: u32 = 64u;
const BODY_V: u32 = 16u;
const ERODE_N: u32 = 4u;
const NBR_N: u32 = 8u;

// body states (bodies[b * BODY_V].z)
const B_EMPTY: f32 = 0.0;
const B_AWAKE: f32 = 1.0;
const B_ASLEEP: f32 = 2.0;

// SU (solver.ts packUniform): a h (s), substeps, iterations, slots used
//                             b gravity (cells/s², down), air drag (1/s), slop, slopK
//                             c slopP, slopCap, pushV, erodeDepth
//                             d restV, restT, tick dt, wakeImpulse
//                             e friction ×, node radius ×, 0, 0
//                             g a window slide to apply (xyz, world cells: shift), w 0
struct SolverU { a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, d: vec4<f32>, e: vec4<f32>, g: vec4<f32> };
@group(0) @binding(22) var<uniform> SU: SolverU;
// per material, 4 vec4 (solver.ts SOLVER_MATS):
//  [0] density, rigid (1) or deformable (0), stiffness (0..1 a substep), damping (share of relative speed a substep)
//  [1] modulus E, yield stress, tensile strength, shear strength
//  [2] friction μ, restitution, impact break speed (cells/s; rock: the host breaks it), plastic rate (share a substep)
//  [3] x frame: the share of a deformable's goal that is its whole part's rigid fit (the rest its region's; 1: stiff
//      between yields, as a girder), y dent strength (energy a cell³ of dent: a hit's kinetic energy over this × the
//      contact's area is how deep it dents), zw 0
@group(0) @binding(23) var<uniform> SM: array<vec4<f32>, 160>;

// Per lane (slot b's lanes at b * NN ..; lane l holds node l and contact point l), LANE_V vec4 (solver.ts packs them;
// one buffer: a stage binds at most 8 storage buffers):
//  [0] node position, w inverse mass (0 pinned, < 0 no node)
//  [1] velocity, w its material
//  [2] rest position (the spawn frame: world cells where it stood), w the node's size (cells across its block)
//  [3] rotation (rest → world): its region's (deformable) or its part's (rigid)
//  [4] xy (u32 bits) bonds: the nodes of its own body it's held to (bits 0..63); z its block's faces on the body's
//      surface (a number: bits 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z — build.ts exposed), w how far its cells reach below
//      it (its foot)
//  [5] contact point: rest position (spawn frame), w the node it rides (f32); < 0 no point
//  [6] the node's rest position as it was made (about the rest centre of mass): what meshes are skinned to (bound
//      there: [2] moves on as it bends, and the drawn vertices with it); w the cells it stands for
//  [7] how its rest has turned from that (a quaternion: a stiff deformable's plastic hinges) — its rotation [3] is
//      its part's turn times this, from the bind frame
@group(0) @binding(3) var<storage, read_write> lane: array<vec4<f32>>;
// per body, BODY_V vec4 (solver.ts BodyRead):
//  [0] x nodes, y points, z state, w cells (its size: the slop's mass)
//  [1] xyz centre of mass now, w bounding radius (about it)
//  [2] xyz velocity of the centre, w s still
//  [3] xyz angular velocity (an estimate), w node radius (as others feel it)
//  [4] its rotation (rest → world: its first part's)
//  [5] x hardest approach this tick (cells/s), yzw where (world)
//  [6] x points touching, y deepest overlap, z the overlap it may keep (allow), w points touching when it fell asleep
//  [7] x erode points this tick, y parts (connected), z mass, w bonds broken this tick
//  [8] x rigid (1) or deformable (0), y 1 when a node is pinned (a foundation holds it), zw 0
//  [9..12] where it erodes the ground this tick (world points, w how deep past its slop)
//  [13..14] the other bodies near it (slot + 1 as f32, 0 none; pairs)
//  [15] what the game asks of it this tick: xyz a velocity change (an impulse), w 1 when set (the solve clears it)
@group(0) @binding(9) var<storage, read_write> bodies: array<vec4<f32>>;
// a body hit hard by another while asleep: woken (atomics; the solve clears its own)
@group(0) @binding(13) var<storage, read_write> wakeFlag: array<atomic<u32>>;
// the lanes as the tick began (copied before the solve: what other bodies feel)
@group(0) @binding(14) var<storage, read> snap: array<vec4<f32>>;
// what the renderer and the host read: 4 vec4 a node — its position and rotation for the last two ticks
// ([4i] prev pos, [4i+1] prev rot, [4i+2] pos, [4i+3] rot): drawn between them (the design's choppiness fix)
@group(0) @binding(15) var<storage, read_write> pose: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> layersIn: array<vec4<u32>>;

const LANE_V: u32 = 8u;
// (stored as f32 numbers, not bits: small integers' bits are denormal floats, which the GPU may flush to 0)
// (read whole and picked in registers: a storage vec4 indexed by a variable came out a component off on D3D12)
fn nbrAt(b: u32, k: u32) -> u32 {
  let v = bodies[b * BODY_V + 13u + k / 4u];
  let c = k % 4u;
  return u32(select(select(select(v.x, v.y, c == 1u), v.z, c == 2u), v.w, c == 3u));
}

fn qmulS(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
fn qrotS(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn qinvS(q: vec4<f32>) -> vec4<f32> { return vec4<f32>(-q.xyz, q.w); }
fn qmat(q: vec4<f32>) -> mat3x3<f32> {
  return mat3x3<f32>(qrotS(q, vec3<f32>(1.0, 0.0, 0.0)), qrotS(q, vec3<f32>(0.0, 1.0, 0.0)), qrotS(q, vec3<f32>(0.0, 0.0, 1.0)));
}
/** The rotation nearest A (its polar part), from q: Müller, Bender, Chentanez & Macklin 2016's iteration. */
fn extractRot(A: mat3x3<f32>, q0: vec4<f32>) -> vec4<f32> {
  var q = q0;
  for (var i = 0; i < 6; i++) {
    let R = qmat(q);
    let om = (cross(R[0], A[0]) + cross(R[1], A[1]) + cross(R[2], A[2])) / (abs(dot(R[0], A[0]) + dot(R[1], A[1]) + dot(R[2], A[2])) + 1e-9);
    let w = length(om);
    if (w < 1e-7) { break; }
    let ax = om / w;
    let s = sin(0.5 * w);
    q = normalize(qmulS(vec4<f32>(ax * s, cos(0.5 * w)), q));
  }
  return q;
}

fn smA(m: u32) -> vec4<f32> { return SM[m * 4u]; }
fn smB(m: u32) -> vec4<f32> { return SM[m * 4u + 1u]; }
fn smC(m: u32) -> vec4<f32> { return SM[m * 4u + 2u]; }

// ---- the ground (the layers): rockbodies.ts columnsGround's rules on the GPU ---------------------------------------
fn isGroundMat(m: u32) -> bool {
  let s = matState(m);
  return s == ST_SOLID || s == ST_GRANULAR;
}
/** the material at height z of column c (0: none), and its interval's top */
fn ivAt(c: vec2<i32>, z: f32) -> vec2<f32> {
  let cs = colSlots(u32(c.x), u32(c.y));
  for (var s = 0u; s < cs.y; s++) {
    let v = layersIn[cs.x + s];
    if (ivEmpty(v)) { break; }
    if (ivZ0(v) > z) { break; }
    if (z < ivZ1(v)) { return vec2<f32>(f32(ivMat(v)), ivZ1(v)); }
  }
  return vec2<f32>(0.0, 0.0);
}

struct GHit { d: f32, n: vec3<f32>, ext: bool };

/**
 * A point in the ground: how deep, and the way out — up when it's within 0.6 of its run's top, else sideways through
 * the nearest of its column's six faces with air beside it at that height, else up (at most 2). The window's floor
 * holds. d <= 0: not in the ground.
 */
fn probe(w: vec3<f32>) -> GHit {
  var h: GHit;
  h.d = -1.0;
  h.n = vec3<f32>(0.0, 0.0, 1.0);
  h.ext = false;
  if (w.z < 0.0) { h.d = -w.z; return h; }
  let c = cellAt(w.xy);
  if (!inMap(c)) { return h; }
  let zq = max(0.0, w.z - 0.5);
  var iv = ivAt(c, zq);
  let m = u32(iv.x);
  if (m == 0u || !isGroundMat(m)) { return h; }
  h.ext = m == MAT_EXTERNAL;
  var t = iv.y;
  for (var i = 0; i < 8; i++) {
    let nx2 = ivAt(c, t - 0.49);
    if (nx2.x == 0.0 || !isGroundMat(u32(nx2.x)) || nx2.y <= t) { break; }
    t = nx2.y;
  }
  let up = t - w.z;
  if (up < 0.6) { h.d = up; return h; }
  let cp = cellPos(c);
  var best = 1e9;
  var n = vec3<f32>(0.0, 0.0, 1.0);
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(c, k);
    if (inMap(q)) {
      let a = ivAt(q, zq);
      if (a.x != 0.0 && isGroundMat(u32(a.x))) { continue; }
    }
    let d = 0.5 - dot(w.xy - cp, DIRV[k]);
    if (d < best) { best = d; n = vec3<f32>(DIRV[k], 0.0); }
  }
  if (best >= up || best > 1e8) { h.d = min(up, 2.0); return h; }
  h.d = max(0.01, best);
  h.n = n;
  return h;
}

// ---- the solve: one workgroup a body -----------------------------------------------------------------------------
var<workgroup> sx: array<vec3<f32>, 64>;
var<workgroup> sp: array<vec3<f32>, 64>;
var<workgroup> sv: array<vec3<f32>, 64>;
var<workgroup> sw: array<f32, 64>;
var<workgroup> sr: array<vec3<f32>, 64>;
var<workgroup> sq: array<vec4<f32>, 64>;
var<workgroup> scomp: array<u32, 64>;
var<workgroup> sbond: array<atomic<u32>, 128>;
// a region's (deformable) centre now and at rest
var<workgroup> sc: array<vec3<f32>, 64>;
var<workgroup> sc0: array<vec3<f32>, 64>;
// per point: the correction it asks of its node, the push-out part of it, touching
var<workgroup> pd: array<vec3<f32>, 64>;
var<workgroup> po: array<vec3<f32>, 64>;
var<workgroup> pn: array<u32, 64>;
var<workgroup> wState: u32;
var<workgroup> wN: u32;
var<workgroup> wP: u32;
var<workgroup> wRigid: u32;
// (a stiff deformable: metal, wood — frame 1; the load flow)
var<workgroup> wStiff: u32;
var<workgroup> spar: array<u32, 64>;
var<workgroup> sord: array<u32, 64>;
var<workgroup> wRp: vec4<f32>;
// (the workgroup's memory is 16 KB on a phone: the load flow's sums reuse arrays free by then — its corrections sc (the
// soft regions' centres), its subtree forces pd (the points' asks, gathered already) and moments pdent (their dents,
// taken at the first pass) — and the bind rests, hinge turns and point rests are read from the lanes)
var<workgroup> wChanged: atomic<u32>;
var<workgroup> wFlag: u32;
var<workgroup> ptN: array<u32, 64>;
var<workgroup> wHit: atomic<u32>;
var<workgroup> wDeep: atomic<u32>;
var<workgroup> wTouch: atomic<u32>;
var<workgroup> wFast: atomic<u32>;
var<workgroup> wErode: atomic<u32>;
var<workgroup> wBroke: atomic<u32>;
var<workgroup> wHitAt: vec3<f32>;
var<workgroup> wCtl: vec4<f32>;
// the substep's velocity after gravity, before contacts (each node), and the excess taken off them all
var<workgroup> svp: array<vec3<f32>, 64>;
var<workgroup> wExcess: vec3<f32>;
// (each node) the reaction it takes from other bodies' points in its block this iteration: the normals summed, touched
var<workgroup> rn: array<vec3<f32>, 64>;
var<workgroup> rt: array<u32, 64>;
// (each node) the highest stress on its bonds this substep: past the yield it flows (plastic)
var<workgroup> ssm: array<f32, 64>;
// (each point) the dent it makes in its own node this substep (world: into the body × depth)
var<workgroup> pdent: array<vec3<f32>, 64>;
// the body's centre as the tick began: positions are kept relative to it (f32 at world coordinates of a few hundred
// has ~1e-5 steps — a slow body's move a substep is ~1e-4: its velocity from the move came out 6% off)
var<workgroup> wO: vec3<f32>;
// (a substep with a dent in it)
var<workgroup> wDent: u32;

struct Fit { goal: vec3<f32>, rot: vec4<f32> };
/** Node l's part (its connected piece), fitted rigidly: the rotation and centre that best match where its nodes are,
 *  and where that puts node l. `anchored`: pinned nodes are as heavy as the world (a rigid part held by a foundation);
 *  else every node counts alike (a deformable's frame: its shape, wherever it is — the foundations hold it, not the fit). */
fn partFit(l: u32, nN: u32, anchored: bool) -> Fit {
  let me = scomp[l];
  var m = 0.0;
  var c = vec3<f32>(0.0);
  var c0 = vec3<f32>(0.0);
  for (var k = 0u; k < nN; k++) {
    if (sw[k] < 0.0 || scomp[k] != me) { continue; }
    let mk = select(1.0, massOf(k), anchored);
    m += mk;
    c += mk * sx[k];
    c0 += mk * sr[k];
  }
  c /= m;
  c0 /= m;
  var A = mat3x3<f32>(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
  for (var k = 0u; k < nN; k++) {
    if (sw[k] < 0.0 || scomp[k] != me) { continue; }
    let mk = select(1.0, massOf(k), anchored);
    let p = sx[k] - c;
    let r = sr[k] - c0;
    A += mat3x3<f32>(p * (mk * r.x), p * (mk * r.y), p * (mk * r.z));
  }
  var f: Fit;
  f.rot = extractRot(A, sq[l]);
  f.goal = c + qrotS(f.rot, sr[l] - c0);
  return f;
}

/** The mass a contact on node j of body o meets: the whole body's when it's rigid (it moves as one), the node's own
 *  when it's deformable (it gives locally: a dent) — pinned nodes as heavy as the world. */
fn contactMass(o: u32, invM: f32, mat: u32) -> f32 {
  if (invM <= 0.0) { return 1e6; }
  // (stiff: as one — held by a foundation, as the world)
  if (bodies[o * BODY_V + 8u].x > 0.5 || SM[mat * 4u + 3u].x >= 0.999) {
    return select(bodies[o * BODY_V + 7u].z, 1e6, bodies[o * BODY_V + 8u].y > 0.5);
  }
  return 1.0 / invM;
}
/** a stiff deformable (metal, wood: frame 1) dents where it's hit hard */
fn dentable(o: u32, mat: u32) -> bool { return bodies[o * BODY_V + 8u].x < 0.5 && SM[mat * 4u + 3u].x >= 0.999 && SM[mat * 4u + 3u].y > 0.0; }
/** how deep a hit of this kinetic energy dents a block of this size (cells; at most half the block) */
fn dentDepth(energy: f32, mat: u32, size: f32) -> f32 {
  let a = size * size;
  // (at most a quarter of the block at a blow: what moves the rest of its part onto the dent comes as a jolt)
  return clamp(energy / (SM[mat * 4u + 3u].y * a) - 0.02, 0.0, 0.25 * size);
}

fn bondedTo(l: u32, j: u32) -> bool {
  return (atomicLoad(&sbond[l * 2u + (j >> 5u)]) & (1u << (j & 31u))) != 0u;
}
fn massOf(l: u32) -> f32 { return select(1e6, 1.0 / sw[l], sw[l] > 0.0); }
/** the overlap allowed against something of `cells` cells (PX3's rule: rigid.slop + min(slopCap, slopK · cells^slopP)) */
fn slopFor(cells: f32) -> f32 { return SU.b.z + min(SU.c.y, SU.b.w * pow(max(cells, 1.0), SU.c.x)); }

/**
 * (thread 0, a stiff deformable's last pass of a substep) The loads through its bonds — the user (round 120): "Does it
 * also propagate forces to compute torque and shear forces?", "you propagate support in then weight back out". What
 * holds it (pinned nodes, nodes touching something) are the roots; a breadth-first walk over its bonds from them gives
 * each node the bond it hangs from. Back from the far ends, each node's subtree sums its forces (m Δ / h²: what the
 * fit had to do to hold it there) and their moments; at the bond to its parent that is a moment (bend), a shear and a
 * pull, over the section of what the node stands for (its cells along it: A = s², Z = s³ / 6). Past the material's
 * strength the bond snaps; past its yield the most overloaded bond is a plastic hinge: what hangs from it turns about
 * it a little (its rest shape: it stays bent), by how far past.
 */
fn loadFlow(b: u32, nN: u32, nP: u32, h: f32, mat: u32) {
  // roots: what holds each part — its pinned nodes if it has any (a part held by a foundation is fixed by it: what
  // it touches can't hold it up any further, and a hinge mustn't turn it into what it touches), else what it touches
  var nq = 0u;
  for (var k = 0u; k < nN; k++) {
    spar[k] = 0xffffffffu;
    pd[k] = vec3<f32>(0.0);
    pdent[k] = vec3<f32>(0.0);
    if (sw[k] < 0.0) { continue; }
    var pinnedPart = false;
    for (var j = 0u; j < nN; j++) { if (sw[j] == 0.0 && scomp[j] == scomp[k]) { pinnedPart = true; break; } }
    var held = sw[k] == 0.0 || (!pinnedPart && rt[k] != 0u);
    for (var j = 0u; j < nP && !held && !pinnedPart; j++) { if (ptN[j] == k && pn[j] != 0u) { held = true; } }
    if (held) {
      spar[k] = k;
      sord[nq] = k;
      nq++;
    }
  }
  if (nq == 0u) { return; }
  var head = 0u;
  while (head < nq) {
    let k = sord[head];
    head++;
    for (var j = 0u; j < nN; j++) {
      if (spar[j] != 0xffffffffu || sw[j] < 0.0 || !bondedTo(k, j)) { continue; }
      spar[j] = k;
      sord[nq] = j;
      nq++;
    }
  }
  // back from the far ends: each subtree's force and moment (about the origin), handed to its parent
  let mB = smB(mat);
  var worst = 1.0;
  var wk = 0xffffffffu;
  var waxis = vec3<f32>(0.0);
  for (var i = nq; i > 0u; i--) {
    let k = sord[i - 1u];
    let p = spar[k];
    // (a blow is stopped within a substep here — PBD's contacts are perfectly stiff — so its force would be without
    // bound; a real one is spread over the give at the contact: a node's load is held to SU.e.w g)
    var f = massOf(k) * sc[k] / (h * h);
    let fmax = massOf(k) * SU.b.x * SU.e.w;
    if (length(f) > fmax) { f = f * (fmax / length(f)); }
    pd[k] += f;
    pdent[k] += cross(sx[k], f);
    if (p == k) { continue; }
    pd[p] += pd[k];
    pdent[p] += pdent[k];
    // at the bond k–p
    let bp = 0.5 * (sx[k] + sx[p]);
    let M = pdent[k] - cross(bp, pd[k]);
    let e = normalize(sx[k] - sx[p]);
    let Mp = M - e * dot(M, e);
    let cellsK = max(1.0, lane[(b * NN + k) * LANE_V + 6u].w);
    let s = sqrt(max(1.0, cellsK / max(lane[(b * NN + k) * LANE_V + 2u].w, 1.0)));
    let A = s * s;
    let Z = s * s * s / 6.0;
    let sB = length(Mp) / Z;
    let sT = max(0.0, dot(pd[k], e)) / A;
    let sS2 = length(pd[k] - e * dot(pd[k], e)) / A;
    if (sB > mB.z || sT > mB.z || sS2 > mB.w) {
      atomicAnd(&sbond[k * 2u + (p >> 5u)], ~(1u << (p & 31u)));
      atomicAnd(&sbond[p * 2u + (k >> 5u)], ~(1u << (k & 31u)));
      atomicAdd(&wBroke, 1u);
      atomicStore(&wChanged, 1u);
      continue;
    }
    let ratio = sB / max(mB.y, 1e-6);
    if (ratio > worst) {
      worst = ratio;
      wk = k;
      waxis = Mp;
    }
  }
  // the plastic hinge: what hangs from bond wk–parent turns about it (its rest shape), by how far past the yield
  if (wk == 0xffffffffu || length(waxis) < 1e-9) { return; }
  let p = spar[wk];
  // (only a part a foundation holds creeps: a free one's supports are what it touches — roots of the walk, never in
  // what hangs from a bond — so its hinge couldn't see the ground it would turn into)
  var held = false;
  for (var j = 0u; j < nN; j++) { if (sw[j] == 0.0 && scomp[j] == scomp[wk]) { held = true; break; } }
  if (!held) { return; }
  let ang = min(0.012, (worst - 1.0) * 0.01) * smC(mat).w;
  // (the forces summed are what holds it — the loads are their opposite: it turns the way they push)
  let axr = qrotS(qinvS(wRp), -normalize(waxis));
  let dq = vec4<f32>(axr * sin(0.5 * ang), cos(0.5 * ang));
  let pivot = 0.5 * (sr[wk] + sr[p]);
  // (and where it is, turned the same about the hinge where it is now — its position before the substep too: plastic
  // flow is a creep, not a fling; the turn makes no speed)
  let dqW = qmulS(qmulS(wRp, dq), qinvS(wRp));
  let pivotW = 0.5 * (sx[wk] + sx[p]);
  // (what hangs from it: wk's subtree, marked in spar's high bit) — and only a bond it hangs by alone turns: one in a
  // loop (a braced frame) is held by the others, which share its load (the walk gave the load to one path)
  for (var j = 0u; j < nN; j++) {
    if (sw[j] < 0.0) { continue; }
    var a = j;
    for (var d = 0u; d < 64u; d++) {
      if (a == wk) { sord[j] = 1u; break; }
      let up = spar[a];
      if (up == a || up == 0xffffffffu) { sord[j] = 0u; break; }
      a = up;
      sord[j] = 0u;
    }
  }
  for (var j = 0u; j < nN; j++) {
    if (sw[j] < 0.0 || sord[j] == 0u) { continue; }
    // (what hangs from it already rests on something: the ground carries it, it turns no further into it)
    if (rt[j] != 0u) { return; }
    for (var k = 0u; k < nP; k++) { if (ptN[k] == j && pn[k] != 0u) { return; } }
    for (var k = 0u; k < nN; k++) {
      if (sw[k] < 0.0 || sord[k] == 1u || !bondedTo(j, k)) { continue; }
      if (j == wk && k == p) { continue; }
      return;
    }
  }
  for (var j = 0u; j < nN; j++) {
    if (sw[j] < 0.0 || sord[j] == 0u) { continue; }
    sr[j] = pivot + qrotS(dq, sr[j] - pivot);
    sx[j] = pivotW + qrotS(dqW, sx[j] - pivotW);
    sp[j] = pivotW + qrotS(dqW, sp[j] - pivotW);
    let qi = (b * NN + j) * LANE_V + 7u;
    lane[qi] = normalize(qmulS(dq, lane[qi]));
  }
}

@compute @workgroup_size(64)
fn solve(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) l: u32) {
  let b = wg.x;
  let B0 = b * BODY_V;
  let gi = b * NN + l;
  if (l == 0u) {
    let st = bodies[B0];
    var state = u32(st.z);
    // (woken by another body's impact)
    if (state == 2u && atomicExchange(&wakeFlag[b], 0u) != 0u) { state = 1u; bodies[B0 + 2u].w = 0.0; }
    // (an impulse wakes it too; it's taken once)
    wCtl = bodies[B0 + 15u];
    if (wCtl.w > 0.0) { bodies[B0 + 15u] = vec4<f32>(0.0); }
    if (wCtl.w > 0.0 && state == 2u) { state = 1u; bodies[B0 + 2u].w = 0.0; }
    if (state == 1u) { bodies[B0].z = B_AWAKE; }
    wState = state;
    wN = u32(st.x);
    wP = u32(st.y);
    atomicStore(&wChanged, 1u);
    atomicStore(&wHit, 0u);
    atomicStore(&wDeep, 0u);
    atomicStore(&wTouch, 0u);
    atomicStore(&wFast, 0u);
    atomicStore(&wErode, 0u);
    atomicStore(&wBroke, 0u);
    wHitAt = vec3<f32>(0.0);
    wO = bodies[B0 + 1u].xyz;
  }
  let state = workgroupUniformLoad(&wState);
  if (state == 0u || state == 3u) { return; }
  let nN = wN;
  let nP = wP;
  let live = l < nN && lane[gi * LANE_V].w >= 0.0;
  let mat = min(u32(lane[gi * LANE_V + 1u].w), 39u);
  if (l == 0u) {
    wRigid = u32(bodies[B0 + 8u].x > 0.5);
    wStiff = u32(bodies[B0 + 8u].x < 0.5 && SM[mat * 4u + 3u].x >= 0.999);
  }
  // the body into workgroup memory
  sx[l] = lane[gi * LANE_V].xyz - wO;
  sv[l] = lane[gi * LANE_V + 1u].xyz + select(vec3<f32>(0.0), wCtl.xyz, wCtl.w > 0.0 && live);
  sw[l] = select(-1.0, lane[gi * LANE_V].w, live);
  sr[l] = lane[gi * LANE_V + 2u].xyz;
  sq[l] = lane[gi * LANE_V + 3u];
  let bm = bitcast<vec2<u32>>(lane[gi * LANE_V + 4u].xy);
  atomicStore(&sbond[l * 2u], select(0u, bm.x, live));
  atomicStore(&sbond[l * 2u + 1u], select(0u, bm.y, live));
  let pt = lane[gi * LANE_V + 5u];
  let pLive = l < nP && pt.w >= 0.0;
  let pNode = min(u32(max(pt.w, 0.0)), NN - 1u);
  ptN[l] = select(0xffffffffu, pNode, pLive);
  let cells = bodies[B0].w;
  // (a foundation lets go once there's nothing under it: its support smashed or dug — the physics voxels' rule)
  if (live && sw[l] == 0.0 && (state == 1u || state == 2u)) {
    let size = lane[gi * LANE_V + 2u].w;
    let g0 = probe(sx[l] + wO - vec3<f32>(0.0, 0.0, 0.5 * size + 0.3));
    if (g0.d <= 0.0) {
      let cellsN = max(1.0, lane[gi * LANE_V + 6u].w);
      sw[l] = 1.0 / (cellsN * smA(mat).x);
      lane[gi * LANE_V] = vec4<f32>(lane[gi * LANE_V].xyz, sw[l]);
    }
  }
  let ownSlop = max(slopFor(cells), bodies[B0 + 6u].z);
  let h = SU.a.x;
  let subs = u32(SU.a.y);
  let iters = u32(SU.a.z);
  let rigid = workgroupUniformLoad(&wRigid) == 1u;
  let mu = smC(mat).x * SU.e.x;

  // (asleep: nothing moves. It wakes when what holds it has gone — fewer than half the points that touched when it
  // fell asleep still touch — or another body hit it hard, above)
  if (state == 2u) {
    // (its support looked at every sixth tick, staggered: a sleeper costs next to nothing)
    if ((G.tick + b) % 6u != 0u) { return; }
    if (pLive) {
      let w = sx[pNode] + qrotS(sq[pNode], lane[gi * LANE_V + 5u].xyz - lane[(b * NN + pNode) * LANE_V + 6u].xyz) + wO;
      let g = probe(w);
      if (g.d > -0.15) { atomicAdd(&wTouch, 1u); }
    }
    workgroupBarrier();
    if (l == 0u) {
      let had = bodies[B0 + 6u].w;
      let now = f32(atomicLoad(&wTouch));
      if (now < 0.5 * had) { bodies[B0].z = B_AWAKE; bodies[B0 + 2u].w = 0.0; }
      bodies[B0 + 5u] = vec4<f32>(0.0);
      bodies[B0 + 7u].x = 0.0;
      bodies[B0 + 7u].w = 0.0;
    }
    // (drawn where it lies: the last two poses the same)
    if (live) {
      pose[gi * 4u] = vec4<f32>(sx[l] + wO, 0.0);
      pose[gi * 4u + 1u] = sq[l];
      pose[gi * 4u + 2u] = vec4<f32>(sx[l] + wO, 0.0);
      pose[gi * 4u + 3u] = sq[l];
    }
    return;
  }

  // the prev pose (what was drawn as `now` last tick)
  if (live) {
    pose[gi * 4u] = vec4<f32>(sx[l] + wO, 0.0);
    pose[gi * 4u + 1u] = sq[l];
  }
  workgroupBarrier();

  // parts: the connected pieces of the bond graph (a rigid body's clusters), by the least index reached
  scomp[l] = l;
  workgroupBarrier();
  if (l == 0u) { atomicStore(&wChanged, 0u); }
  for (var round = 0u; round < 64u; round++) {
    var c = scomp[l];
    if (live) {
      for (var j = 0u; j < nN; j++) { if (bondedTo(l, j) && scomp[j] < c) { c = scomp[j]; } }
    }
    workgroupBarrier();
    if (c != scomp[l]) { scomp[l] = c; atomicStore(&wChanged, 1u); }
    workgroupBarrier();
    if (l == 0u) { wFlag = atomicExchange(&wChanged, 0u); }
    if (workgroupUniformLoad(&wFlag) == 0u) { break; }
  }

  // the other bodies near it (read from the snapshot, moved on by their velocity)
  let g = SU.b.x;
  let pushMax = SU.c.z * h;
  let erodeD = SU.c.w;

  for (var s = 0u; s < subs; s++) {
    let tSub = f32(s + 1u) * h;
    // ---- predict
    if (live) {
      var v = sv[l];
      if (sw[l] > 0.0) {
        v.z -= g * h;
        v *= max(0.0, 1.0 - SU.b.y * h);
      } else { v = vec3<f32>(0.0); }
      sv[l] = v;
      svp[l] = v;
      sp[l] = sx[l];
      sx[l] = sx[l] + v * h;
    }
    pn[l] = 0u;
    po[l] = vec3<f32>(0.0);
    rn[l] = vec3<f32>(0.0);
    rt[l] = 0u;
    pdent[l] = vec3<f32>(0.0);
    workgroupBarrier();
    for (var it = 0u; it < iters; it++) {
      // ---- contacts: each point against the ground and the bodies near
      var dsum = vec3<f32>(0.0);
      var osum = vec3<f32>(0.0);
      if (pLive && sw[pNode] > 0.0) {
        let n = pNode;
        let off = qrotS(sq[n], lane[gi * LANE_V + 5u].xyz - lane[(b * NN + n) * LANE_V + 6u].xyz);
        let w = sx[n] + off + wO;
        let mv = sx[n] - sp[n];
        let gh = probe(w);
        if (gh.d > 0.0) {
          pn[l] = 1u;
          if (it == 0u) {
            let ap = -dot(sv[n], gh.n);
            if (ap > 0.0) {
              let prevMax = bitcast<f32>(atomicMax(&wHit, bitcast<u32>(ap)));
              if (ap > prevMax) { wHitAt = w; }
              // (metal and wood dent where they hit: the body's energy into the ground, shared over what touches)
              if (dentable(b, mat)) {
                let e = 0.5 * bodies[B0 + 7u].z / max(4.0, bodies[B0 + 6u].x) * ap * ap;
                pdent[l] += gh.n * dentDepth(e, mat, lane[(b * NN + n) * LANE_V + 2u].w);
              }
            }
            atomicMax(&wDeep, bitcast<u32>(gh.d));
          }
          let ex = gh.d - ownSlop;
          if (ex > 0.0) {
            // (deeper than the slop and erodeDepth into ground: erode, don't push — the ground there crumbles; it's
            // still stopped from going further in, never pushed out)
            // (rock erodes the ground it's cut into; metal and wood don't — they're pushed out, at the push-out speed)
            let deep = !gh.ext && ex > erodeD && rigid;
            if (deep && it == 0u && s == 0u) {
              let k = atomicAdd(&wErode, 1u);
              if (k < ERODE_N) { bodies[b * BODY_V + 9u + k] = vec4<f32>(w, ex); }
            }
            {
              let inward = max(0.0, -dot(mv, gh.n));
              let corr = min(ex, inward + select(pushMax, 0.0, deep));
              let tang = mv - gh.n * dot(mv, gh.n);
              let tl = length(tang);
              var d = gh.n * corr;
              if (tl > 1e-7) { d -= tang / tl * min(tl, mu * corr); }
              dsum += d;
              osum += gh.n;
            }
          }
        }
        // other bodies: their nodes as spheres; the deepest only
        var bestD = 0.0;
        var bestN = vec3<f32>(0.0);
        var bestShare = 1.0;
        var bestO = 0u;
        for (var k = 0u; k < NBR_N; k++) {
          let o1 = nbrAt(b, k);
          if (o1 == 0u) { break; }
          let o = o1 - 1u;
          let ob = bodies[o * BODY_V];
          // (not near it at all: skipped — its bounding sphere, a margin for this tick's moves)
          let oc = bodies[o * BODY_V + 1u];
          if (length(w - oc.xyz) > oc.w + 2.0) { continue; }
          let oN = u32(ob.x);
          let ov = bodies[o * BODY_V + 2u].xyz;
          let oRad = bodies[o * BODY_V + 3u].w;
          let oSlop = slopFor(min(cells, ob.w));
          let asleep = ob.z == B_ASLEEP;
          for (var j = 0u; j < oN; j++) {
            let sj = snap[(o * NN + j) * LANE_V];
            if (sj.w < 0.0) { continue; }
            let xo = sj.xyz + select(ov * tSub, vec3<f32>(0.0), asleep);
            // its node as the block of cells it stands for (turned with it): the blocks tile the body, no gaps between
            // them for a corner to slip through (spheres had); how deep the point is in, and out through the nearest face
            let qo = snap[(o * NN + j) * LANE_V + 3u];
            let go = snap[(o * NN + j) * LANE_V + 2u].w * oRad;
            let lp = qrotS(qinvS(qo), w - xo);
            let hs = vec3<f32>(0.5, 0.5 * ROW_H, 0.5) * go;
            let inside = hs - abs(lp);
            if (any(inside <= vec3<f32>(0.0))) { continue; }
            // out through the nearest of its faces on the body's surface (the side the point is on)
            let ex = u32(snap[(o * NN + j) * LANE_V + 4u].z);
            var dd = 1e9;
            var ax = vec3<f32>(0.0);
            let fx = select(1u, 2u, lp.x < 0.0);
            let fy = select(4u, 8u, lp.y < 0.0);
            let fz = select(16u, 32u, lp.z < 0.0);
            if ((ex & fx) != 0u && inside.x < dd) { dd = inside.x; ax = vec3<f32>(sign(lp.x), 0.0, 0.0); }
            if ((ex & fy) != 0u && inside.y < dd) { dd = inside.y; ax = vec3<f32>(0.0, sign(lp.y), 0.0); }
            if ((ex & fz) != 0u && inside.z < dd) { dd = inside.z; ax = vec3<f32>(0.0, 0.0, sign(lp.z)); }
            if (dd > 1e8) { continue; }
            let pen = dd - oSlop;
            if (pen > bestD) {
              bestD = pen;
              bestN = qrotS(qo, ax);
              // (each takes its share by mass; a sleeper doesn't move)
              let mo = contactMass(o, sj.w, u32(snap[(o * NN + j) * LANE_V + 1u].w));
              let me = contactMass(b, sw[pNode], mat);
              bestShare = select(mo / (mo + me), 1.0, asleep);
              bestO = o1;
            }
          }
        }
        if (bestD > 0.0) {
          pn[l] = 1u;
          let o = bestO - 1u;
          let ovel = bodies[o * BODY_V + 2u].xyz;
          let rel = sv[n] - select(ovel, vec3<f32>(0.0), bodies[o * BODY_V].z == B_ASLEEP);
          let ap = -dot(rel, bestN);
          if (it == 0u && ap > 0.0) {
            let prevMax = bitcast<f32>(atomicMax(&wHit, bitcast<u32>(ap)));
            if (ap > prevMax) { wHitAt = w; }
            // (an impact wakes a sleeper: speed × mass past wakeImpulse)
            if (bodies[o * BODY_V].z == B_ASLEEP && ap * cells > SU.d.w) { atomicStore(&wakeFlag[o], 1u); }
            if (dentable(b, mat)) {
              let mo = min(bodies[o * BODY_V + 7u].z, 1e5) / max(4.0, bodies[o * BODY_V + 6u].x);
              let e = 0.5 * min(mo, bodies[B0 + 7u].z) * ap * ap;
              pdent[l] += bestN * dentDepth(e, mat, lane[(b * NN + n) * LANE_V + 2u].w);
            }
          }
          let relMove = mv - select(ovel * h, vec3<f32>(0.0), bodies[o * BODY_V].z == B_ASLEEP);
          let inward = max(0.0, -dot(relMove, bestN));
          let corr = min(bestD, inward + pushMax) * bestShare;
          let tang = relMove - bestN * dot(relMove, bestN);
          let tl = length(tang);
          var d = bestN * corr;
          if (tl > 1e-7) { d -= tang / tl * min(tl * bestShare, mu * corr); }
          dsum += d;
          osum += bestN;
        }
      }
      pd[l] = dsum;
      if (it == iters - 1u) { po[l] = osum; }
      workgroupBarrier();
      // each node takes the mean of what its points ask, and the reactions of other bodies' points in its block: the
      // same test those bodies make (their point in this node's block, out through its faces on the surface), from
      // this side — so a contact pushes both ways, each by its share of the mass (a body's points alone would leave
      // the one it lands on unmoved, untouched)
      var dentW = vec3<f32>(0.0);
      if (live && sw[l] > 0.0) {
        var acc = vec3<f32>(0.0);
        var cnt = 0.0;
        // (the node's own foot too — the bottom of the block it stands for, however it's turned: a piece broken down to
        // a node or two keeps the ground under it, whatever its few points face)
        var footN = vec3<f32>(0.0);
        {
          let foot = sx[l] + wO - vec3<f32>(0.0, 0.0, 0.9 * lane[gi * LANE_V + 4u].w);
          let gh = probe(foot);
          let ex = gh.d - ownSlop;
          if (ex > 0.0) {
            let mvn = sx[l] - sp[l];
            let inward = max(0.0, -dot(mvn, gh.n));
            acc += gh.n * min(ex, inward + select(pushMax, 0.0, !gh.ext && ex > erodeD && rigid));
            cnt += 1.0;
            footN = gh.n;
            if (it == iters - 1u) { rt[l] = 1u; }
          }
        }
        for (var k = 0u; k < nP; k++) {
          if (ptN[k] == l && length(pd[k]) > 0.0) { acc += pd[k]; cnt += 1.0; }
          // (its points' dents: its rest shape pushed in, once a substep)
          // (the node stays where the contact holds it; the rest of its part comes down onto the dent)
          if (it == 0u && ptN[k] == l && length(pdent[k]) > 0.0) {
            sr[l] = sr[l] + qrotS(qinvS(sq[l]), pdent[k]);
            dentW += pdent[k];
          }
        }
        let myScale = bodies[B0 + 3u].w;
        let gl = lane[gi * LANE_V + 2u].w * myScale;
        let hs = vec3<f32>(0.5, 0.5 * ROW_H, 0.5) * gl;
        let xl = sx[l] + wO;
        let qi = qinvS(sq[l]);
        let exM = u32(lane[gi * LANE_V + 4u].z);
        let mvl = sx[l] - sp[l];
        var nsum = footN;
        for (var k = 0u; k < NBR_N; k++) {
          let o1 = nbrAt(b, k);
          if (o1 == 0u) { break; }
          let o = o1 - 1u;
          let ob = bodies[o * BODY_V];
          let oc = bodies[o * BODY_V + 1u];
          if (length(xl - oc.xyz) > oc.w + gl + 2.0) { continue; }
          let oP = u32(ob.y);
          let asleep = ob.z == B_ASLEEP;
          let ov = select(bodies[o * BODY_V + 2u].xyz, vec3<f32>(0.0), asleep);
          let oSlop = slopFor(min(cells, ob.w));
          for (var j = 0u; j < oP; j++) {
            let pt = snap[(o * NN + j) * LANE_V + 5u];
            if (pt.w < 0.0) { continue; }
            let on = u32(pt.w);
            let nl = snap[(o * NN + on) * LANE_V];
            if (nl.w <= 0.0 && !asleep) { continue; }
            let mo = contactMass(o, nl.w, u32(snap[(o * NN + on) * LANE_V + 1u].w));
            let me = contactMass(b, sw[l], mat);
            let share = select(mo / (mo + me), 1.0, asleep);
            let nq2 = snap[(o * NN + on) * LANE_V + 3u];
            let nb2 = snap[(o * NN + on) * LANE_V + 6u];
            let wpt = nl.xyz + qrotS(nq2, pt.xyz - nb2.xyz) + ov * tSub;
            let lp = qrotS(qi, wpt - xl);
            let inside = hs - abs(lp);
            if (any(inside <= vec3<f32>(0.0))) { continue; }
            var dd = 1e9;
            var ax = vec3<f32>(0.0);
            let fx = select(1u, 2u, lp.x < 0.0);
            let fy = select(4u, 8u, lp.y < 0.0);
            let fz = select(16u, 32u, lp.z < 0.0);
            if ((exM & fx) != 0u && inside.x < dd) { dd = inside.x; ax = vec3<f32>(sign(lp.x), 0.0, 0.0); }
            if ((exM & fy) != 0u && inside.y < dd) { dd = inside.y; ax = vec3<f32>(0.0, sign(lp.y), 0.0); }
            if ((exM & fz) != 0u && inside.z < dd) { dd = inside.z; ax = vec3<f32>(0.0, 0.0, sign(lp.z)); }
            let pen = dd - oSlop;
            if (dd > 1e8 || pen <= 0.0) { continue; }
            let N = qrotS(sq[l], ax);
            // (it moves away from the point: -N; how far it moved toward it this substep, less the point's own move)
            let inward = max(0.0, dot(mvl - ov * h, N));
            let corr = min(pen, inward + pushMax) * share;
            acc -= N * corr;
            cnt += 1.0;
            nsum -= N;
            if (it == 0u) {
              let ap = dot(sv[l] - ov, N);
              if (ap > 0.0) {
                let prevMax = bitcast<f32>(atomicMax(&wHit, bitcast<u32>(ap)));
                if (ap > prevMax) { wHitAt = wpt; }
                // (hit: dented by the hitter's energy, shared over what it touches)
                if (dentable(b, mat)) {
                  let mo2 = min(bodies[o * BODY_V + 7u].z, 1e5) / max(4.0, bodies[o * BODY_V + 6u].x);
                  let e = 0.5 * min(mo2, bodies[B0 + 7u].z) * ap * ap;
                  let dd2 = dentDepth(e, mat, lane[gi * LANE_V + 2u].w);
                  sr[l] = sr[l] - qrotS(qinvS(sq[l]), N) * dd2;
                  dentW -= N * dd2;
                }
              }
            }
          }
        }
        if (it == iters - 1u) {
          rn[l] = nsum;
          rt[l] = select(0u, 1u, length(nsum) > 0.0);
        }
        if (cnt > 0.0) { sx[l] = sx[l] + acc / cnt; }
      }
      // (a dent changed the rest shape: its part put in that shape now, its centre of mass kept, where it was before
      // the substep too — the fit then has nothing to correct, and the crush makes no speed: a small piece's dent had
      // flung it)
      if (it == 0u) {
        if (l == 0u) { wDent = 0u; }
        workgroupBarrier();
        sc0[l] = dentW;
        if (length(dentW) > 0.0) { wDent = 1u; }
        if (workgroupUniformLoad(&wDent) == 1u) {
          if (live && sw[l] > 0.0) {
            var m = 0.0;
            var md = vec3<f32>(0.0);
            for (var k = 0u; k < nN; k++) {
              if (sw[k] <= 0.0 || scomp[k] != scomp[l]) { continue; }
              let mk = massOf(k);
              m += mk;
              md += mk * sc0[k];
            }
            let shift = sc0[l] - md / max(m, 1e-6);
            sx[l] = sx[l] + shift;
            sp[l] = sp[l] + shift;
          }
          workgroupBarrier();
        }
      }
      workgroupBarrier();

      // ---- shape matching
      var goal = sx[l];
      var rot = sq[l];
      if (rigid) {
        // its part, exactly: the rotation and centre that best fit where its nodes are
        if (live) {
          let f = partFit(l, nN, true);
          rot = f.rot;
          goal = select(f.goal, sx[l], sw[l] == 0.0);
        }
        workgroupBarrier();
        if (live) {
          if (sw[l] > 0.0) { sx[l] = goal; }
          sq[l] = rot;
        }
        workgroupBarrier();
      } else if (workgroupUniformLoad(&wStiff) == 1u) {
        // a stiff deformable (metal, wood: frame 1): rigid between yields — its part fitted rigidly to its rest shape,
        // pinned nodes holding it — and the corrections that fit makes are the loads it carries (m Δ / h²: the weight
        // it holds up, the blow it stops). On the last pass they flow from its far ends to what holds it (loadFlow):
        // the moment and shear at each bond — past the yield a plastic hinge turns what's beyond it, past the strength
        // the bond snaps
        var pf: Fit;
        if (live) { pf = partFit(l, nN, true); }
        workgroupBarrier();
        // (summed over the substep's passes: the first does most of it)
        if (it == 0u) { sc[l] = vec3<f32>(0.0); }
        if (live && sw[l] > 0.0) {
          sc[l] = sc[l] + pf.goal - sx[l];
          sx[l] = pf.goal;
        }
        if (live) { sq[l] = qmulS(pf.rot, lane[gi * LANE_V + 7u]); }
        if (l == 0u) { wRp = pf.rot; }
        workgroupBarrier();
        // (once a tick, on its last pass: the loads change over ticks, not substeps)
        if (s == subs - 1u && it == iters - 1u && l == 0u) { loadFlow(b, nN, nP, h, mat); }
        storageBarrier();
        workgroupBarrier();
      } else {
        // a deformable (metal, wood): first how the loads on it now (the contacts' pushes, what holds it) would bend
        // it — each node's region (itself and what it's bonded to) fitted to where its nodes are — and so the stress
        // on each bond (in its region's frame: along the bond a tension, across it a shear, and the turn between the
        // two regions a bend at the section's edge, E κ s / 2): past the yield its rest shape follows (plastic: bent,
        // dented), past the strength the bond goes (it snaps, on the last pass). Then where it goes: with a full frame
        // (steel, wood) its part's rigid fit to that rest shape — stiff between yields, as a girder is; with less, a
        // blend with its regions' soft goal (canvas, scrap: it sags and flaps)
        let mB = smB(mat);
        let frame = SM[mat * 4u + 3u].x;
        if (live) {
          var m = massOf(l);
          var c = m * sx[l];
          var c0 = m * sr[l];
          for (var k = 0u; k < nN; k++) {
            if (k == l || sw[k] < 0.0 || !bondedTo(l, k)) { continue; }
            let mk = massOf(k);
            m += mk;
            c += mk * sx[k];
            c0 += mk * sr[k];
          }
          c /= m;
          c0 /= m;
          var A = mat3x3<f32>(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
          for (var k = 0u; k < nN; k++) {
            if (sw[k] < 0.0 || (k != l && !bondedTo(l, k))) { continue; }
            let mk = massOf(k);
            let p = sx[k] - c;
            let r = sr[k] - c0;
            A += mat3x3<f32>(p * (mk * r.x), p * (mk * r.y), p * (mk * r.z));
          }
          sq[l] = extractRot(A, sq[l]);
          sc[l] = c;
          sc0[l] = c0;
        }
        workgroupBarrier();
        var regGoal = sx[l];
        if (live) {
          let size = lane[gi * LANE_V + 2u].w;
          let Rinv = qinvS(sq[l]);
          var sMax = 0.0;
          for (var k = 0u; k < nN; k++) {
            if (k == l || sw[k] < 0.0 || !bondedTo(l, k)) { continue; }
            let r0 = sr[k] - sr[l];
            let L = max(length(r0), 1e-4);
            let e = r0 / L;
            let d = qrotS(Rinv, sx[k] - sx[l]) - r0;
            let along = dot(d, e);
            let shear = length(d - e * along) / L;
            let dq = qmulS(Rinv, sq[k]);
            let ang = 2.0 * acos(clamp(abs(dq.w), 0.0, 1.0));
            let sT = mB.x * along / L;
            let sS = mB.x * 0.4 * shear;
            let sB = mB.x * ang / L * size * 0.5;
            sMax = max(sMax, max(abs(sT), max(sS, sB)));
            if (it == iters - 1u && k > l && (sT > mB.z || sB > mB.z || sS > mB.w)) {
              atomicAnd(&sbond[l * 2u + (k >> 5u)], ~(1u << (k & 31u)));
              atomicAnd(&sbond[k * 2u + (l >> 5u)], ~(1u << (l & 31u)));
              atomicAdd(&wBroke, 1u);
              atomicStore(&wChanged, 1u);
            }
          }
          ssm[l] = sMax;
          var gsum = sc[l] + qrotS(sq[l], sr[l] - sc0[l]);
          var gn = 1.0;
          for (var k = 0u; k < nN; k++) {
            if (k == l || sw[k] < 0.0 || !bondedTo(l, k)) { continue; }
            gsum += sc[k] + qrotS(sq[k], sr[l] - sc0[k]);
            gn += 1.0;
          }
          regGoal = gsum / gn;
        }
        workgroupBarrier();
        if (live && sw[l] > 0.0 && ssm[l] > mB.y) {
          let gl = sc[l] + qrotS(sq[l], sr[l] - sc0[l]);
          let dev = qrotS(qinvS(sq[l]), sx[l] - gl);
          sr[l] = sr[l] + dev * ((ssm[l] - mB.y) / ssm[l]) * smC(mat).w / f32(iters);
        }
        workgroupBarrier();
        var pf: Fit;
        if (live) { pf = partFit(l, nN, frame >= 0.999); }
        workgroupBarrier();
        if (live && sw[l] > 0.0) {
          if (frame >= 0.999) { sx[l] = pf.goal; }
          else { sx[l] = sx[l] + (mix(regGoal, pf.goal, frame) - sx[l]) * smA(mat).z; }
        }
        workgroupBarrier();
      }
    }
    // ---- velocities: from the move. Separation never adds speed: the body's own velocity away from what it touches
    // (along the mean of its contacts' normals) is held to what it had before the contacts (restitution ~0) — taken
    // off every node alike, so a turn (a topple about an edge) is kept; push-outs move it without momentum
    if (live && sw[l] > 0.0) { sv[l] = (sx[l] - sp[l]) / h; }
    workgroupBarrier();
    if (l == 0u) {
      var nsum = vec3<f32>(0.0);
      for (var k = 0u; k < nP; k++) { nsum += po[k]; }
      for (var k = 0u; k < nN; k++) { nsum += rn[k]; }
      var ex = vec3<f32>(0.0);
      let nl = length(nsum);
      if (nl > 1e-6) {
        let N = nsum / nl;
        var m = 0.0;
        var vp = 0.0;
        var vn = 0.0;
        for (var k = 0u; k < nN; k++) {
          if (sw[k] <= 0.0) { continue; }
          let mk = massOf(k);
          m += mk;
          vp += mk * dot(svp[k], N);
          vn += mk * dot(sv[k], N);
        }
        if (m > 0.0) {
          let over = vn / m - max(0.0, vp / m);
          if (over > 0.0) { ex = N * over; }
        }
      }
      wExcess = ex;
    }
    workgroupBarrier();
    if (live && sw[l] > 0.0) { sv[l] = sv[l] - wExcess; }
    workgroupBarrier();
    // ---- a soft deformable: damping toward its region's mean velocity (the bonds' stretching speed, not a spin)
    var vNew = sv[l];
    if (!rigid && live && SM[mat * 4u + 3u].x < 0.999) {
      var vm = sv[l];
      var cntv = 1.0;
      for (var k = 0u; k < nN; k++) {
        if (k == l || sw[k] < 0.0 || !bondedTo(l, k)) { continue; }
        vm += sv[k];
        cntv += 1.0;
      }
      vNew = sv[l] + (vm / cntv - sv[l]) * smA(mat).w;
    }
    workgroupBarrier();
    if (!rigid && live) { sv[l] = vNew; }
    workgroupBarrier();
    // (a bond broke: the parts again)
    if (!rigid) {
      if (l == 0u) { wFlag = atomicExchange(&wChanged, 0u); }
      if (workgroupUniformLoad(&wFlag) != 0u) {
        scomp[l] = l;
        workgroupBarrier();
        for (var round = 0u; round < 64u; round++) {
          var c = scomp[l];
          if (live) {
            for (var j = 0u; j < nN; j++) { if (bondedTo(l, j) && scomp[j] < c) { c = scomp[j]; } }
          }
          workgroupBarrier();
          if (c != scomp[l]) { scomp[l] = c; atomicStore(&wChanged, 1u); }
          workgroupBarrier();
          if (l == 0u) { wFlag = atomicExchange(&wChanged, 0u); }
          if (workgroupUniformLoad(&wFlag) == 0u) { break; }
        }
      }
    }
  }

  // ---- out: the nodes, the body's summary, its pose for drawing
  var sp2 = 0.0;
  if (live) {
    lane[gi * LANE_V] = vec4<f32>(sx[l] + wO, sw[l]);
    lane[gi * LANE_V + 1u] = vec4<f32>(sv[l], f32(mat));
    lane[gi * LANE_V + 2u] = vec4<f32>(sr[l], lane[gi * LANE_V + 2u].w);
    lane[gi * LANE_V + 3u] = sq[l];
    lane[gi * LANE_V + 4u] = vec4<f32>(bitcast<vec2<f32>>(vec2<u32>(atomicLoad(&sbond[l * 2u]), atomicLoad(&sbond[l * 2u + 1u]))), lane[gi * LANE_V + 4u].zw);
    pose[gi * 4u + 2u] = vec4<f32>(sx[l] + wO, 0.0);
    pose[gi * 4u + 3u] = sq[l];
    sp2 = length(sv[l]);
    atomicMax(&wFast, bitcast<u32>(sp2));
  }
  if (pLive && pn[l] != 0u) { atomicAdd(&wTouch, 1u); }
  if (live && rt[l] != 0u) { atomicAdd(&wTouch, 1u); }
  // (a pinned node holds it as the ground does: a standing frame at rest sleeps)
  if (live && sw[l] == 0.0) { atomicAdd(&wTouch, 1u); }
  workgroupBarrier();
  if (l == 0u) {
    var m = 0.0;
    var c = vec3<f32>(0.0);
    var v = vec3<f32>(0.0);
    var parts = 0.0;
    for (var k = 0u; k < nN; k++) {
      if (sw[k] < 0.0) { continue; }
      let mk = massOf(k);
      m += mk;
      c += mk * sx[k];
      v += mk * sv[k];
      if (scomp[k] == k) { parts += 1.0; }
    }
    c /= max(m, 1e-6);
    v /= max(m, 1e-6);
    // the spin: Σ m r × v about the centre, over the inertia's trace (an estimate, for the host's dust and pose)
    var L = vec3<f32>(0.0);
    var I = 0.0;
    for (var k = 0u; k < nN; k++) {
      if (sw[k] < 0.0) { continue; }
      let mk = massOf(k);
      let r = sx[k] - c;
      L += mk * cross(r, sv[k] - v);
      I += mk * dot(r, r);
    }
    let om = L / max(I, 1e-6) * 1.5;
    let touch = f32(atomicLoad(&wTouch));
    let fast = bitcast<f32>(atomicLoad(&wFast));
    var still = bodies[B0 + 2u].w;
    // (at rest: everything slower than restV while something holds it, for restT)
    if (touch > 0.0 && fast < SU.d.x) { still += SU.d.z; } else { still = 0.0; }
    var st = bodies[B0];
    if (still > SU.d.y) { st.z = B_ASLEEP; bodies[B0 + 6u].w = touch; }
    bodies[B0] = st;
    bodies[B0 + 1u] = vec4<f32>(c + wO, bodies[B0 + 1u].w);
    bodies[B0 + 2u] = vec4<f32>(v, still);
    bodies[B0 + 3u] = vec4<f32>(om, bodies[B0 + 3u].w);
    bodies[B0 + 4u] = sq[0];
    let hit = bitcast<f32>(atomicLoad(&wHit));
    bodies[B0 + 5u] = vec4<f32>(hit, wHitAt);
    let deep = bitcast<f32>(atomicLoad(&wDeep));
    let b6 = bodies[B0 + 6u];
    // (the overlap it was freed with only shrinks: to its deepest now)
    bodies[B0 + 6u] = vec4<f32>(touch, deep, min(b6.z, deep), b6.w);
    bodies[B0 + 7u] = vec4<f32>(f32(min(atomicLoad(&wErode), ERODE_N)), parts, m, f32(atomicLoad(&wBroke)));
  }
}

// ---- pairs: the bodies near each (a thread a body, every other body's bounding sphere) ------------------------------
@compute @workgroup_size(64)
fn pairs(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let used = u32(SU.a.w);
  if (i >= used) { return; }
  let bi = bodies[i * BODY_V];
  var n = 0u;
  var near = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  if (bi.z == B_AWAKE) {
    let ci = bodies[i * BODY_V + 1u];
    let vi = length(bodies[i * BODY_V + 2u].xyz) * SU.d.z;
    for (var j = 0u; j < used && n < NBR_N; j++) {
      if (j == i) { continue; }
      let bj = bodies[j * BODY_V];
      if (bj.z != B_AWAKE && bj.z != B_ASLEEP) { continue; }
      let cj = bodies[j * BODY_V + 1u];
      let vj = length(bodies[j * BODY_V + 2u].xyz) * SU.d.z;
      if (length(ci.xyz - cj.xyz) < ci.w + cj.w + vi + vj + 0.5) {
        near[n] = f32(j + 1u);
        n++;
        // (a sleeper about to be hit hard — this one closing on it fast enough that its blow will wake it — is woken
        // now, so both are awake when they meet: the blow then reaches it, dents it, moves it. Touching alone never
        // wakes one)
        if (bj.z == B_ASLEEP) {
          let d = cj.xyz - ci.xyz;
          let close = dot(bodies[i * BODY_V + 2u].xyz, normalize(d));
          if (close * bi.w > SU.d.w && length(d) < ci.w + cj.w + close * 0.15) { atomicStore(&wakeFlag[j], 1u); }
        }
      }
    }
  }
  bodies[i * BODY_V + 13u] = vec4<f32>(near[0], near[1], near[2], near[3]);
  bodies[i * BODY_V + 14u] = vec4<f32>(near[4], near[5], near[6], near[7]);
}

// ---- shift: the window slid (streaming) — every node, its pose and its body's centre moved by -SU.g ------------------
@compute @workgroup_size(64)
fn shift(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let used = u32(SU.a.w);
  if (i >= used * NN) { return; }
  let d = SU.g.xyz;
  if (lane[i * LANE_V].w >= 0.0) {
    lane[i * LANE_V] = vec4<f32>(lane[i * LANE_V].xyz - d, lane[i * LANE_V].w);
    pose[i * 4u] = vec4<f32>(pose[i * 4u].xyz - d, 0.0);
    pose[i * 4u + 2u] = vec4<f32>(pose[i * 4u + 2u].xyz - d, 0.0);
  }
  if (i % NN == 0u) {
    let b = i / NN;
    bodies[b * BODY_V + 1u] = vec4<f32>(bodies[b * BODY_V + 1u].xyz - d, bodies[b * BODY_V + 1u].w);
  }
}

// ---- skin: the cells of bodies drawn as voxels (metal: the field mesh can't hold its thin members) -----------------
// Each cell rides the node it was bound to (skinCells: xyz its rest about its body's rest centre of mass, f32 bits; w
// its node's lane | material << 24), placed by that node's transform as the tick ends and drawn as render.wgsl vsBody's
// instances (two vec4<u32>: position bits and the material word, then the rotation), counted into drawIndirect args.
@group(0) @binding(17) var<storage, read> skinCells: array<vec4<u32>>;
@group(0) @binding(18) var<storage, read_write> skinInst: array<vec4<u32>>;
@group(0) @binding(19) var<storage, read_write> skinArgs: array<atomic<u32>>;

@compute @workgroup_size(64)
fn skin(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= u32(SU.e.z)) { return; }
  let c = skinCells[i];
  let li = c.w & 0xffffffu;
  let m = c.w >> 24u;
  let b = li / NN;
  let st = bodies[b * BODY_V].z;
  if (st != B_AWAKE && st != B_ASLEEP) { return; }
  if (lane[li * LANE_V].w < 0.0) { return; }
  let r = bitcast<vec3<f32>>(c.xyz);
  let q = pose[li * 4u + 3u];
  let x = pose[li * 4u + 2u].xyz + qrotS(q, r - lane[li * LANE_V + 6u].xyz);
  let k = atomicAdd(&skinArgs[1], 1u);
  let word = m | ((pcg(i) & 255u) << 8u) | 0x40000000u;
  skinInst[k * 2u] = vec4<u32>(bitcast<vec3<u32>>(x), word);
  skinInst[k * 2u + 1u] = bitcast<vec4<u32>>(q);
}
