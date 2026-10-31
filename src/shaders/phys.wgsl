// ---- physics voxels (docs/PHYSICS.md) ------------------------------------------
// Every voxel of a physical body is a particle on its body's lattice, held to
// its neighbours by bonds (the 26 around it). One solver for every material
// (lattice shape matching, Rivers & James 2007): each voxel's region (itself
// and what it's bonded to) finds the rotation that best maps its rest shape
// onto where it is now; every voxel moves toward the mean of where its
// regions would put it. Stiff materials move all the way each iteration
// (stone: rigid); soft ones part way. Past a material's yield the rest shape
// follows the bend (metal stays bent); past its break strain a bond snaps
// (stone cracks into pieces, which go on as rigid as before). Contacts never
// push anything out: they stop a voxel moving further in, and an overlap too
// deep (or an impact faster than the material's crumble speed) turns the
// voxel into its loose material (gravel, sand, dust) — so nothing gains
// energy from being shoved apart. Heat (the beam) softens metal
// and melts what gets hot enough.
//
// Per particle i:
//   px[2i]     xyz position (cells), w inverse mass (< 0: no particle; -2
//              crumbling, -3 melting this substep — the deaths pass ends them)
//   px[2i + 1] xyz position before this substep, w temperature
//   pv[i]      xyz velocity (cells/s), w the temperature after this substep's heat
//   pr[i]      xyz rest position on the lattice (local, cells), w its info (u32
//              bits): material | body << 8 | size code << 16 | hidden << 22 |
//              faces << 23 (the size: 0 a whole cell, n is n/16 of a cell; hidden:
//              a mesh draws it; faces: a hidden voxel's six face bonds at spawn)
//              A fragment's (FRAG_BODY) xyz are instead: x how long it has been
//              at rest, y its age (s)
//   pq[i]      its region's rotation (rest → world), a quaternion
//   pg[2i]     its region's centre now (xyz), w mass; pg[2i + 1] its rest centre
//   pb[i]      bonds: bit k set while bonded to lattice neighbour k (n26)
//   pc[i]      this substep's contacts: xyz summed normals, w the fastest approach
const PV_DEAD: f32 = -1.0;
const PV_CRUMBLE: f32 = -2.0;
const PV_MELT: f32 = -3.0;
// gone to dust without breaking into pieces first (a blast's heart, a voxel
// buried deep in the ground, a fragment come to rest)
const PV_DUST: f32 = -4.0;
// broken into eight fragments this substep (split): the deaths pass only ends it
const PV_SPLIT: f32 = -5.0;
// Mixed resolution (round 49): a crumbling voxel breaks into eight fragments
// half its size (in a ring of FRAG_CAP slots at the start of the particles,
// body FRAG_BODY, unbonded), which break up or come to rest and go to dust.
// physics.ts mirrors both.
const FRAG_BODY: u32 = 255u;
const FRAG_CAP: u32 = 8192u;
// the smallest fragment (size code): a voxel whose halves would be smaller goes to dust
const FRAG_MIN_CODE: u32 = 4u;
const HASH_N: u32 = 262144u;
const HASH_NONE: u32 = 0xffffffffu;
// G_ACC (was 20.0): worldG() × G.tune.voxelsGravity (solver step 1, AR9: one world gravity, a scale of its own)
// VMAX (was 60.0): none (solver step 1, AR10: no speed caps)
// AIR_DRAG (was 0.05): G.tune.voxelsAirDrag (round 108, src/tune/params.ts) // 1/s
// STEP_UP (was 0.45): G.tune.voxelsStepUp (round 108, src/tune/params.ts) // a ledge this high is climbed, not a wall
// CRUMBLE_DEPTH (was 0.6): G.tune.voxelsCrumbleDepth (round 108, src/tune/params.ts) // into solid ground this far, a voxel crumbles
// CRUMBLE_OVERLAP (was 0.5): G.tune.voxelsCrumbleOverlap (round 108, src/tune/params.ts) // two voxels this far into each other: the weaker crumbles
const RAD: f32 = 0.5;
const AMBIENT_T: f32 = 0.0;

struct PhysU {
  // x substep (s), y particles in use (as f32), z time, w beam on (1)
  a: vec4<f32>,
  // beam: xyz where it hits, w radius
  b0: vec4<f32>,
  // xyz its direction (into the surface), w heat per second at its centre
  b1: vec4<f32>,
  // x particles in use, y bodies, z tick, w (as f32 bits) this tick's blast strength
  c: vec4<u32>,
  // a blast: xyz centre, w radius (every substep of its tick)
  d: vec4<f32>,
  // x skinned triangles (skin)
  e: vec4<u32>,
};
@group(0) @binding(22) var<uniform> PU: PhysU;
// per material, 4 vec4 (physics.ts PHYS_MATS):
//  [0] density, stiffness 0..1, yield (cells of local deviation), plastic rate 0..1
//  [1] break strain, restitution, friction, crumble speed (cells/s)
//  [2] soften temperature, melt temperature (0: never), heat gain, loose material it crumbles to
//  [3] damping (share of its bonds' stretching speed taken out per substep), crack speed (cells/s; 0 never)
@group(0) @binding(23) var<uniform> PM: array<vec4<f32>, 160>; // 4 a material, MAX_MATERIALS (materials.ts)
// bodies: x first particle, yzw lattice dims
@group(0) @binding(24) var<uniform> PB: array<vec4<u32>, 256>;
// what the game asks of each body (round 49, physics.ts BODY_CTL), 5 vec4 a body:
//  [0] drive target: its centre (xyz, world cells), w stiffness (1/s², 0: not driven)
//  [1] drive target rotation (rest frame → world, as state() reports it)
//  [2] its rest centre (xyz, rest frame), w its voxels at spawn
//  [3] drive target velocity (xyz), w damping (1/s)
//  [4] velocity added each substep this tick (xyz: an impulse spread over the tick)
@group(0) @binding(33) var<uniform> BC: array<vec4<f32>, 1280>;
// pushes this tick (round 49): a pull toward a point, a push from it, a wind
// along a direction — a: centre xyz, radius; b: direction xyz, strength
// (cells/s² at the centre, falling off to 0 at the radius); c: kind (0 none,
// 1 pull, 2 push, 3 wind), the one body it acts on (0xffffffff: all), the
// body size (voxels) it acts on fully (f32 bits; smaller in proportion: big
// pieces move, dust stays; 0: all alike), damping (f32 bits, 1/s: what it
// holds settles instead of swinging through)
struct Push { a: vec4<f32>, b: vec4<f32>, c: vec4<u32> };
@group(0) @binding(34) var<uniform> PP: array<Push, 8>;
// (solver step 2, the experiment: the lattice sleeps too) the bodies asleep, a bit a body (physics.ts: settled for a
// moment — slower than the rigid rock's rest speed while it touches something — till something wakes it): their voxels
// are left out of the solve (they stay in the hash: what's awake still meets them), drawn and read as they lie
@group(0) @binding(36) var<uniform> PS: array<vec4<u32>, 2>;
fn sleeping(i: u32) -> bool {
  let bi = bodyOf(infoOf(i));
  let w = PS[bi >> 7u];
  let c = (bi >> 5u) & 3u;
  let word = select(select(select(w.x, w.y, c == 1u), w.z, c == 2u), w.w, c == 3u);
  return ((word >> (bi & 31u)) & 1u) != 0u;
}

@group(0) @binding(3) var<storage, read_write> px: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> pv: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> pr: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> pq: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> pg: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> pb: array<u32>;
// heads of the spatial hash [0, HASH_N), then each particle's next [HASH_N + i]
@group(0) @binding(9) var<storage, read_write> hashT: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> pc: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> layersIn: array<vec4<u32>>;
// the particle ring (particles.wgsl Particle) and its counters
@group(0) @binding(12) var<storage, read_write> parts: array<PartP>;
@group(0) @binding(13) var<storage, read_write> counters: array<atomic<u32>>;
// loose ground from crumbled voxels per column: amount ×1000, material (folded into deposit)
@group(0) @binding(14) var<storage, read_write> dep: array<atomic<u32>>;
@group(0) @binding(16) var<storage, read_write> deposit: array<vec4<f32>>;
// map structures bodies ran into: [0] count, then columns (the host wakes them)
@group(0) @binding(25) var<storage, read_write> touches: array<atomic<u32>>;
// draw instances (render.wgsl vsBody) and their indirect args
@group(0) @binding(19) var<storage, read_write> inst: array<vec4<u32>>;
@group(0) @binding(20) var<storage, read_write> indirect: array<atomic<u32>>;
// what each column sees of the voxels (prep; project.wgsl reads it): 8 words
// per column, bit z set where a voxel's centre lies in cell z
@group(0) @binding(26) var<storage, read_write> cols: array<atomic<u32>>;
// molten rock (lava.wgsl): x depth, y temperature, w its surface height
@group(0) @binding(28) var<storage, read> lava: array<vec4<f32>>;
// the fragment ring's head (split)
@group(0) @binding(29) var<storage, read_write> fragHead: array<atomic<u32>>;
// how fast a voxel in lava takes its heat (share a second)
const LAVA_HEAT: f32 = 1.5;
// air shoved by voxels landing (finalize; windfield.wgsl): per wind texel (2 cells), ×1000
@group(0) @binding(27) var<storage, read_write> puff: array<atomic<u32>>;

/** Mark cell z of the column under w as holding a voxel. */
fn splatCol(w: vec2<f32>, z: f32) {
  let c = cellAt(w);
  if (!inMap(c) || z < 0.0 || z >= f32(PHYS_COL_WORDS * 32u)) { return; }
  let zc = u32(z);
  atomicOr(&cols[colIdxI(c) * PHYS_COL_WORDS + zc / 32u], 1u << (zc % 32u));
}

// a landing shoves the air from this speed (cells/s), and kicks up dust
const PUFF_V: f32 = 3.0;

struct PartP { p: vec4<f32>, v: vec4<f32>, m: vec4<u32> };
const K_CHIP_P: u32 = 5u;
const K_EMBER_P: u32 = 9u;
const K_DUST_P: u32 = 1u;
// a low cloud of dust (particles.wgsl K_HAZE)
const K_HAZE_P: u32 = 15u;

fn pmA(m: u32) -> vec4<f32> { return PM[m * 4u]; }
fn pmB(m: u32) -> vec4<f32> { return PM[m * 4u + 1u]; }
fn pmC(m: u32) -> vec4<f32> { return PM[m * 4u + 2u]; }
fn pmD(m: u32) -> vec4<f32> { return PM[m * 4u + 3u]; }
fn infoOf(i: u32) -> u32 { return bitcast<u32>(pr[i].w); }
fn matOf(i: u32) -> u32 { return infoOf(i) & 0xffu; }
fn alive(i: u32) -> bool { return px[2u * i].w >= 0.0; }
fn bodyOf(info: u32) -> u32 { return (info >> 8u) & 0xffu; }
fn sizeCodeOf(info: u32) -> u32 { return (info >> 16u) & 63u; }
/** A voxel's edge in cells (its info's size code: 0 a whole cell, n is n/16). */
fn sizeOf(info: u32) -> f32 {
  let c = sizeCodeOf(info);
  return select(f32(c) / 16.0, 1.0, c == 0u);
}
/** How soft heat has made material m (0 cold .. 1 at its melting point). */
fn softAt(m: u32, t: f32) -> f32 {
  let c = pmC(m);
  if (c.y <= 0.0) { return 0.0; }
  return smoothstep(c.x, c.y, t);
}

/** Lattice neighbour k (0..25) of 26: every offset in -1..1 but the centre; 25 - k is the way back. */
fn n26(k: u32) -> vec3<i32> {
  let j = select(k, k + 1u, k >= 13u);
  return vec3<i32>(i32(j % 3u) - 1, i32((j / 3u) % 3u) - 1, i32(j / 9u) - 1);
}
fn latOf(i: u32, b: vec4<u32>) -> vec3<i32> {
  let l = i - b.x;
  return vec3<i32>(i32(l % b.y), i32((l / b.y) % b.z), i32(l / (b.y * b.z)));
}
/** Particle index of lattice cell l of body b, or -1 outside it. */
fn latIdx(l: vec3<i32>, b: vec4<u32>) -> i32 {
  if (any(l < vec3<i32>(0)) || any(vec3<u32>(l) >= b.yzw)) { return -1; }
  return i32(b.x + u32(l.x) + b.y * (u32(l.y) + b.z * u32(l.z)));
}

fn qmul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
fn qrotP(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn qinvP(q: vec4<f32>) -> vec4<f32> { return vec4<f32>(-q.xyz, q.w); }

fn spawnPart(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, seed: u32, state: u32) {
  let i = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[i] = PartP(vec4<f32>(pos, life), vec4<f32>(vel, 0.0), vec4<u32>(kind, seed, 0u, state));
}

/**
 * What the game does to voxel i this substep (cells/s²): its body's drive
 * (a spring toward where the target pose puts it, damped toward the target
 * velocity), its body's impulse, and the pushes that reach it.
 */
fn gameAccel(i: u32, x: vec3<f32>, v: vec3<f32>) -> vec3<f32> {
  let info = infoOf(i);
  let bi = bodyOf(info);
  let h = PU.a.x;
  var acc = BC[bi * 5u + 4u].xyz / h;
  let tgt = BC[bi * 5u];
  if (tgt.w > 0.0) {
    let goal = tgt.xyz + qrotP(BC[bi * 5u + 1u], pr[i].xyz - BC[bi * 5u + 2u].xyz);
    let d = BC[bi * 5u + 3u];
    // (each substep's step stays stable: no more than the spring can take in one)
    let k = min(tgt.w, 0.5 / (h * h));
    acc += (goal - x) * k + (d.xyz - v) * min(d.w, 0.9 / h);
  }
  let size = BC[bi * 5u + 2u].w;
  for (var k = 0u; k < 8u; k++) {
    let p = PP[k];
    if (p.c.x == 0u) { break; }
    if (p.c.y != 0xffffffffu && p.c.y != bi) { continue; }
    let rel = x - p.a.xyz;
    let dist = length(rel);
    if (dist > p.a.w) { continue; }
    let sref = bitcast<f32>(p.c.z);
    let fall = (1.0 - dist / max(p.a.w, 1e-3)) * select(1.0, clamp(size / sref, 0.0, 1.0), sref > 0.0);
    let f = p.b.w * fall;
    if (p.c.x == 1u) { acc -= rel / max(dist, 0.3) * f; }
    else if (p.c.x == 2u) { acc += rel / max(dist, 0.3) * f; }
    else { acc += p.b.xyz * f; }
    let dmp = bitcast<f32>(p.c.w) * fall;
    if (dmp > 0.0) { acc -= v * min(dmp, 0.9 / h); }
  }
  return acc;
}

// ---- 1. predict: gravity, the game's forces, and the move ----------------------------
@compute @workgroup_size(64)
fn predict(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i) || sleeping(i)) { return; }
  let x = px[2u * i];
  let vt = pv[i];
  var v = vt.xyz;
  if (x.w > 0.0) {
    v.z -= worldG() * G.tune.voxelsGravity * PU.a.x;
    v += gameAccel(i, x.xyz, v) * PU.a.x;
  }
  pv[i] = vec4<f32>(v, vt.w);
  px[2u * i + 1u] = vec4<f32>(x.xyz, vt.w);
  px[2u * i] = vec4<f32>(x.xyz + v * PU.a.x * f32(x.w > 0.0), x.w);
}

// ---- 2. regions: the best rotation of each voxel's neighbourhood -----------------
@compute @workgroup_size(64)
fn region(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i) || sleeping(i)) { return; }
  let info = infoOf(i);
  let b = PB[(info >> 8u) & 0xffu];
  let l = latOf(i, b);
  let bonds = pb[i];
  // centres (mass-weighted), self included
  let m0 = 1.0 / max(px[2u * i].w, 1e-3);
  var M = m0;
  var c = px[2u * i].xyz * m0;
  var c0 = pr[i].xyz * m0;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(l + n26(k), b);
    if (j < 0 || !alive(u32(j))) { continue; }
    let xj = px[2u * u32(j)];
    let m = 1.0 / max(xj.w, 1e-3);
    M += m;
    c += xj.xyz * m;
    c0 += pr[u32(j)].xyz * m;
  }
  c /= M;
  c0 /= M;
  // A = Σ m (x − c)(r − c0)ᵀ, as its three columns
  var a0 = (px[2u * i].xyz - c) * (pr[i].x - c0.x) * m0;
  var a1 = (px[2u * i].xyz - c) * (pr[i].y - c0.y) * m0;
  var a2 = (px[2u * i].xyz - c) * (pr[i].z - c0.z) * m0;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(l + n26(k), b);
    if (j < 0 || !alive(u32(j))) { continue; }
    let xj = px[2u * u32(j)];
    let m = 1.0 / max(xj.w, 1e-3);
    let d = (xj.xyz - c) * m;
    let r = pr[u32(j)].xyz - c0;
    a0 += d * r.x;
    a1 += d * r.y;
    a2 += d * r.z;
  }
  // its rotation (Müller et al. 2016), from last substep's
  var q = pq[i];
  for (var it = 0; it < 6; it++) {
    let r0 = qrotP(q, vec3<f32>(1.0, 0.0, 0.0));
    let r1 = qrotP(q, vec3<f32>(0.0, 1.0, 0.0));
    let r2 = qrotP(q, vec3<f32>(0.0, 0.0, 1.0));
    let om = (cross(r0, a0) + cross(r1, a1) + cross(r2, a2)) / (abs(dot(r0, a0) + dot(r1, a1) + dot(r2, a2)) + 1e-9);
    let w = length(om);
    if (w < 1e-7) { break; }
    let ax = om / w;
    q = normalize(qmul(vec4<f32>(ax * sin(w * 0.5), cos(w * 0.5)), q));
  }
  pq[i] = q;
  pg[2u * i] = vec4<f32>(c, M);
  pg[2u * i + 1u] = vec4<f32>(c0, 0.0);
}

// ---- 3. goals: toward where its regions would put it ----------------------------
@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i) || sleeping(i)) { return; }
  let x = px[2u * i];
  if (x.w <= 0.0) { return; }
  let info = infoOf(i);
  let m = info & 0xffu;
  let b = PB[(info >> 8u) & 0xffu];
  let l = latOf(i, b);
  let bonds = pb[i];
  let r = pr[i].xyz;
  var sum = pg[2u * i].xyz + qrotP(pq[i], r - pg[2u * i + 1u].xyz);
  var n = 1.0;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(l + n26(k), b);
    if (j < 0 || !alive(u32(j))) { continue; }
    let ju = u32(j);
    sum += pg[2u * ju].xyz + qrotP(pq[ju], r - pg[2u * ju + 1u].xyz);
    n += 1.0;
  }
  if (n < 1.5) { return; }
  let soft = softAt(m, px[2u * i + 1u].w);
  let alpha = pmA(m).y * (1.0 - 0.92 * soft);
  px[2u * i] = vec4<f32>(x.xyz + (sum / n - x.xyz) * alpha, x.w);
}

// ---- 4. contacts: the spatial hash, the ground, other voxels -----------------------
fn cellHash(c: vec3<i32>) -> u32 {
  return ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u)) % HASH_N;
}

@compute @workgroup_size(64)
fn hashClear(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < HASH_N) { atomicStore(&hashT[id.x], HASH_NONE); }
}

@compute @workgroup_size(64)
fn hashInsert(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i)) { return; }
  let h = cellHash(vec3<i32>(floor(px[2u * i].xyz)));
  let prev = atomicExchange(&hashT[h], i);
  atomicStore(&hashT[HASH_N + i], prev);
}

/** The solid ground in column c: the top of what lies below z, and whether z is inside something (x: top, y: 1 inside, z: granular, w: its material). */
fn groundAt(c: vec2<i32>, z: f32) -> vec4<f32> {
  if (!inMap(c)) { return vec4<f32>(-1e9, 0.0, 0.0, 0.0); }
  let cs = colSlots(u32(c.x), u32(c.y));
  var top = -1e9;
  var gran = 0.0;
  var mat = 0u;
  for (var s = 0u; s < cs.y; s++) {
    let v = layersIn[cs.x + s];
    if (ivEmpty(v)) { break; }
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    if (z0 > z) { break; }
    top = z1;
    mat = ivMat(v);
    gran = select(0.0, 1.0, matState(mat) == ST_GRANULAR);
    if (z < z1) { return vec4<f32>(z1, 1.0, gran, f32(mat)); }
  }
  return vec4<f32>(top, 0.0, gran, f32(mat));
}

/** A structure of the map's (the layers' concrete, brick, rust, steel, canvas): touched by a body, it wakes into one. */
fn wakeable(m: u32) -> bool { return m == 5u || m == 11u || m == 7u || m == 20u || m == 21u; }

@compute @workgroup_size(64)
fn collide(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i) || sleeping(i)) { return; }
  let x0 = px[2u * i];
  let info = infoOf(i);
  let m = info & 0xffu;
  // its size (round 49: a body's voxels may be smaller than a cell)
  let sz = sizeOf(info);
  let rad = RAD * sz;
  let frag = bodyOf(info) == FRAG_BODY;
  // a foundation (pinned) whose ground has gone (dug, blasted, melted): it
  // falls with the rest instead of hanging in the air
  if (x0.w == 0.0) {
    let gp = groundAt(cellAt(x0.xyz.xy), x0.z - rad - 0.05);
    if (gp.x < x0.z - rad - 0.35) { px[2u * i] = vec4<f32>(x0.xyz, 1.0 / max(pmA(m).x * sz * sz * sz, 0.01)); }
    return;
  }
  if (x0.w < 0.0) { return; }
  var x = x0.xyz;
  let v = pv[i].xyz;
  let crumbleV = pmB(m).w;
  let fr = pmB(m).z;
  var nsum = vec3<f32>(0.0);
  var fastest = 0.0;
  var dying = false;
  var dust = false;
  // Contacts never push out (DECISIONS round 43): they only stop a voxel
  // moving further in. An overlap it already has stays (that reads better than
  // a shove, which looks like energy from nowhere); one deeper than the
  // material can bear crumbles the voxel to its loose material.
  let p0 = px[2u * i + 1u].xyz;
  // a structure of the map's it ran into (column + 1): the host wakes it
  var touched = 0u;
  let moving = length(v) > 0.8;

  // the ground under it
  let c = cellAt(x.xy);
  let g = groundAt(c, x.z);
  let depth = g.x - (x.z - rad);
  if (depth > 0.0) {
    // (deep in the ground it goes straight to dust: its pieces would be buried)
    if (g.y > 0.5 && g.z < 0.5 && depth > G.tune.voxelsCrumbleDepth * sz) { dust = true; }
    if (x.z < p0.z) {
      fastest = max(fastest, -v.z * (1.0 - 0.6 * g.z));
      x.z = p0.z;
    }
    nsum += vec3<f32>(0.0, 0.0, 1.0);
    if (moving && wakeable(u32(g.w)) && inMap(c)) { touched = winIdx(c) + 1u; }
  }
  // the columns around: a wall is one standing higher than a step up
  if (inMap(c)) {
    let cp = cellPos(c);
    for (var k = 0u; k < NDIR; k++) {
      if (dot(x.xy - cp, DIRV[k]) <= 0.0) { continue; }
      let gn = groundAt(nbr(c, k), x.z + rad);
      if (gn.x - (x.z - rad) <= G.tune.voxelsStepUp * sz) { continue; }
      if (gn.y < 0.5 && gn.x < x.z - rad) { continue; }
      let into = dot(x.xy - p0.xy, DIRV[k]);
      if (moving && wakeable(u32(gn.w)) && inMap(nbr(c, k))) { touched = winIdx(nbr(c, k)) + 1u; }
      if (into > 0.0) {
        fastest = max(fastest, dot(v.xy, DIRV[k]) * (1.0 - 0.6 * gn.z));
        x -= vec3<f32>(DIRV[k] * into, 0.0);
      }
      nsum += vec3<f32>(-DIRV[k], 0.0);
    }
  }

  // other voxels: those it isn't bonded to
  let b = PB[(info >> 8u) & 0xffu];
  let l = latOf(i, b);
  let bonds = pb[i];
  let cell = vec3<i32>(floor(x));
  // (the smaller of two voxels is the weaker: a fragment breaks on what it hits)
  let toughI = pmA(m).x * crumbleV * sz;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let cc = cell + vec3<i32>(dx, dy, dz);
        var j = atomicLoad(&hashT[cellHash(cc)]);
        var guard = 0u;
        while (j != HASH_NONE && guard < 128u) {
          guard++;
          let ju = j;
          j = atomicLoad(&hashT[HASH_N + ju]);
          if (ju == i) { continue; }
          let xj = px[2u * ju];
          if (xj.w < 0.0) { continue; }
          if (any(vec3<i32>(floor(xj.xyz)) != cc)) { continue; }
          let infoJ = infoOf(ju);
          let reach = rad + RAD * sizeOf(infoJ);
          let d = x - xj.xyz;
          let dist = length(d);
          if (dist >= reach || dist < 1e-5) { continue; }
          // bonded neighbours hold each other by their bonds; voxels of one
          // body that started close (a squeeze, two sides of a crack) only
          // nudge each other, never crumble (fragments have no lattice)
          var near = false;
          if (bodyOf(infoJ) == bodyOf(info) && !frag) {
            let dl = latOf(ju, b) - l;
            if (all(abs(dl) <= vec3<i32>(1))) {
              let k = u32((dl.x + 1) + 3 * (dl.y + 1) + 9 * (dl.z + 1));
              let kk = select(k, k - 1u, k > 13u);
              if ((bonds & (1u << kk)) != 0u) { continue; }
            }
            near = all(abs(dl) <= vec3<i32>(2));
          }
          let n = d / dist;
          let over = reach - dist;
          let closing = -dot(v - pv[ju].xyz, n);
          let mj = infoJ & 0xffu;
          let toughJ = pmA(mj).x * pmB(mj).w * sizeOf(infoJ);
          // too fast for the weaker of the two: it breaks up (ties: the higher index)
          // (by chance, the harder the more likely: below)
          if (!near && closing > crumbleV && (toughI < toughJ || (toughI == toughJ && i > ju))) { fastest = max(fastest, closing); }
          // deeper than the weaker can bear: it crumbles
          if (!near && over > G.tune.voxelsCrumbleOverlap * min(sz, sizeOf(infoJ)) && (toughI < toughJ || (toughI == toughJ && i > ju))) { dying = true; }
          // stop them closing further (each its share); never part them
          let wi = x0.w;
          let wj = max(xj.w, 0.0);
          let shut = -dot((x - p0) - (xj.xyz - px[2u * ju + 1u].xyz), n);
          if (shut > 0.0) { x += n * shut * wi / max(wi + wj, 1e-6); }
          nsum += n;
          if (!near) { fastest = max(fastest, closing * 0.5); }
        }
      }
    }
  }
  // an impact past its crumble speed breaks some of the voxels that took it,
  // more the harder it was; the rest hold and stop the body, so a hard
  // landing crushes its face instead of every layer in turn (round 48)
  if (fastest > crumbleV) {
    let r = f32(hash3(i, PU.c.z, 0x6b2du) & 0xffffu) / 65536.0;
    if (r < clamp((fastest - crumbleV) / crumbleV, 0.2, 0.6)) { dying = true; }
  }
  if (dust) {
    px[2u * i] = vec4<f32>(x, PV_DUST);
    return;
  }
  if (dying) {
    px[2u * i] = vec4<f32>(x, PV_CRUMBLE);
    return;
  }
  px[2u * i] = vec4<f32>(x, x0.w);
  pc[i] = vec4<f32>(nsum, bitcast<f32>(touched));
}

// ---- 5. velocities, bounce and friction, bonds that snap ------------------------------
@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i) || sleeping(i)) { return; }
  let x = px[2u * i];
  let prev = px[2u * i + 1u];
  let info = infoOf(i);
  let m = info & 0xffu;
  let h = PU.a.x;
  let sz = sizeOf(info);
  let vOld = pv[i];
  var v = (x.xyz - prev.xyz) / h;
  if (x.w <= 0.0) { v = vec3<f32>(0.0); }
  let ct = pc[i];
  if (dot(ct.xyz, ct.xyz) > 1e-6) {
    let n = normalize(ct.xyz);
    let vnOld = dot(vOld.xyz, n);
    let vn = dot(v, n);
    // a contact gives back no more than the bounce: it comes away at its
    // restitution of the speed it came in at (or barely at all), however far
    // it had to be pushed out — pushing out never adds energy
    let bounce = max(-pmB(m).y * vnOld, 0.0);
    let vnNew = select(min(vn, 0.3), bounce, vnOld < -0.5);
    var vt = v - n * vn;
    let lt = length(vt);
    let jn = abs(vnNew - vnOld);
    if (lt > 1e-6) { vt *= max(0.0, 1.0 - pmB(m).z * jn / lt); }
    v = vt + n * vnNew;
    let hit = -vnOld;
    // (x: how hard it hit, for relax's cracks; w, a touch, is the deaths pass's to report)
    pc[i] = vec4<f32>(max(hit, 0.0), 0.0, 0.0, ct.w);
    // landing hard on something: it shoves the air out from under it (the
    // wind lifts the loose ground round it) and kicks up dust (round 47)
    // (a smaller voxel shoves less air, by its face, and raises less dust)
    if (n.z > 0.5 && hit > PUFF_V) {
      let face = sz * sz;
      let wt = vec2<i32>(floor(x.xy * 0.5));
      let ww = (G.mapW + 1u) / 2u;
      if (all(wt >= vec2<i32>(0)) && u32(wt.x) < ww && u32(wt.y) < (G.mapH + 1u) / 2u) {
        atomicAdd(&puff[u32(wt.y) * ww + u32(wt.x)], u32(min(hit - PUFF_V, 25.0) * 100.0 * face));
      }
      let seed = hash3(i, PU.c.z, 0x2c1bu);
      if (f32(seed >> 24u) < min((hit - PUFF_V) * 6.0, 120.0) * face) {
        let r = vec3<f32>(f32(seed & 255u), f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0 - 0.5;
        spawnPart(x.xyz - vec3<f32>(0.0, 0.0, RAD * sz), vec3<f32>(r.xy * 0.4 * hit, 0.6 + r.z), 3.0 + r.z * 2.0, K_HAZE_P, seed, (u32(pmC(m).w) & 255u) << 8u);
      }
    }
  }
  // damping (round 48): the speed at which its bonds stretch or squeeze is
  // taken out, so a body doesn't ring like a spring after a knock (rigid
  // turning stretches no bond, so it isn't slowed)
  let damp = pmD(m).x;
  if (damp > 0.0 && x.w > 0.0) {
    let bi = PB[(info >> 8u) & 0xffu];
    let li = latOf(i, bi);
    let bnd = pb[i];
    var dv = vec3<f32>(0.0);
    var nb = 0.0;
    for (var k = 0u; k < 26u; k++) {
      if ((bnd & (1u << k)) == 0u) { continue; }
      let j = latIdx(li + n26(k), bi);
      if (j < 0 || !alive(u32(j))) { continue; }
      let ju = u32(j);
      let xj = px[2u * ju].xyz;
      let vj = (xj - px[2u * ju + 1u].xyz) / h;
      let e = normalize(xj - x.xyz + vec3<f32>(1e-6));
      dv += e * dot(vj - v, e);
      nb += 1.0;
    }
    if (nb > 0.0) { v += dv / nb * damp; }
  }
  v *= 1.0 - G.tune.voxelsAirDrag * h;
  let sp = length(v);
  pv[i] = vec4<f32>(v, prev.w);
  if (x.z < -20.0) {
    px[2u * i] = vec4<f32>(x.xyz, PV_DEAD);
    return;
  }
  let melt = pmC(m).y;
  if (melt > 0.0 && prev.w > melt) {
    px[2u * i] = vec4<f32>(x.xyz, PV_MELT);
    return;
  }
  // a fragment: come to rest (or old), it goes to dust and loose ground
  if (bodyOf(info) == FRAG_BODY) {
    var t = pr[i];
    t.y += h;
    t.x = select(0.0, t.x + h, sp < 1.0);
    pr[i] = t;
    if (t.x > G.tune.voxelsFragRest || t.y > G.tune.voxelsFragLife) { px[2u * i] = vec4<f32>(x.xyz, PV_DUST); }
    return;
  }
  // bonds past their break strain snap (both sides judge the same numbers)
  let b = PB[(info >> 8u) & 0xffu];
  let l = latOf(i, b);
  var bonds = pb[i];
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(l + n26(k), b);
    if (j < 0 || !alive(u32(j))) {
      bonds &= ~(1u << k);
      continue;
    }
    let ju = u32(j);
    let mj = matOf(ju);
    let t = max(prev.w, px[2u * ju + 1u].w);
    let lim = min(pmB(m).x * (1.0 - 0.7 * softAt(m, t)), pmB(mj).x * (1.0 - 0.7 * softAt(mj, t)));
    let r0 = length(pr[i].xyz - pr[ju].xyz);
    let strain = abs(length(x.xyz - px[2u * ju].xyz) / max(r0, 1e-3) - 1.0);
    if (strain > lim) { bonds &= ~(1u << k); }
  }
  pb[i] = bonds;
}

// a fragment this long at rest, or this old (s), goes to dust
// FRAG_REST (was 0.6): G.tune.voxelsFragRest (round 108, src/tune/params.ts)
// FRAG_LIFE (was 6.0): G.tune.voxelsFragLife (round 108, src/tune/params.ts)

// ---- 6. plastic flow and heat --------------------------------------------------------
@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i) || sleeping(i)) { return; }
  let x = px[2u * i];
  let t = px[2u * i + 1u].w;
  let info = infoOf(i);
  let m = info & 0xffu;
  let h = PU.a.x;
  // past its yield, the rest shape follows the bend (metal stays bent)
  let soft = softAt(m, t);
  let sz = sizeOf(info);
  let frag = bodyOf(info) == FRAG_BODY;
  let yieldD = pmA(m).z * (1.0 - soft) * sz;
  let r = pr[i];
  let d = qrotP(qinvP(pq[i]), x.xyz - pg[2u * i].xyz) - (r.xyz - pg[2u * i + 1u].xyz);
  let dl = length(d);
  // (a fragment's xyz are its timers, not a rest shape)
  if (dl > yieldD && pmA(m).w > 0.0 && !frag) {
    pr[i] = vec4<f32>(r.xyz + d * (1.0 - yieldD / dl) * min(1.0, pmA(m).w + soft), r.w);
  }
  // heat: it evens out with what it's bonded to, and cools
  let b = PB[(info >> 8u) & 0xffu];
  let l = latOf(i, b);
  let bonds = pb[i];
  var sum = 0.0;
  var n = 0.0;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(l + n26(k), b);
    if (j < 0 || !alive(u32(j))) { continue; }
    sum += px[2u * u32(j) + 1u].w;
    n += 1.0;
  }
  // cracks (round 48): a bond whose either end hit something faster than the
  // material's crack speed may snap (both ends draw the same random), more
  // likely the harder the hit, so a hard landing breaks it into chunks
  let crackV = pmD(m).y;
  if (crackV > 0.0) {
    var kept = bonds;
    let hi = pc[i].x;
    for (var k = 0u; k < 26u; k++) {
      if ((bonds & (1u << k)) == 0u) { continue; }
      let j = latIdx(l + n26(k), b);
      if (j < 0) { continue; }
      let ju = u32(j);
      let crackJ = pmD(matOf(ju)).y;
      let hit = max(hi, pc[ju].x);
      let cv = select(crackV, min(crackV, crackJ), crackJ > 0.0);
      if (hit <= cv) { continue; }
      let p = clamp((hit - cv) / (2.0 * cv), 0.0, 0.5);
      let r = f32(hash3(min(i, ju), max(i, ju), PU.c.z) & 0xffffu) / 65536.0;
      if (r < p) { kept &= ~(1u << k); }
    }
    if (kept != bonds) {
      pb[i] = kept;
      // a voxel the crack ran through on several sides crumbles (rubble and
      // dust along the break, not clean cuts)
      let r2 = f32(hash3(i, PU.c.z, 0x51edu) & 0xffffu) / 65536.0;
      if (countOneBits(bonds & ~kept) >= 3u && x.w > 0.0 && r2 < 0.35) { px[2u * i] = vec4<f32>(x.xyz, PV_CRUMBLE); }
    }
  }
  var tn = t;
  if (n > 0.0) { tn += (sum / n - t) * min(1.0, 6.0 * h); }
  tn += (AMBIENT_T - tn) * min(1.0, 0.15 * h);
  // lava it's in heats it toward the lava's temperature
  let lc = cellAt(x.xy);
  if (inMap(lc)) {
    let L = lava[colIdxI(lc)];
    if (L.x > 0.02 && x.z - RAD * sz < L.w && L.y > tn) { tn += (L.y - tn) * min(LAVA_HEAT * pmC(m).z * h, 1.0); }
  }
  // the beam
  if (PU.a.w > 0.5) {
    let rel = x.xyz - PU.b0.xyz;
    let along = dot(rel, PU.b1.xyz);
    let off = length(rel - PU.b1.xyz * along);
    // (all along its line in front of where it hits: through a hole it has
    // cut it goes on heating the hole's sides, so it cuts through)
    if (along < 1.5 && off < PU.b0.w) {
      let f = 1.0 - (off * off) / (PU.b0.w * PU.b0.w);
      tn += PU.b1.w * pmC(m).z * f * h;
    }
  }
  var vel = pv[i].xyz;
  // a blast (the break tool, a meteor): what's inside crumbles, what's near is thrown out
  let bs = bitcast<f32>(PU.c.w);
  if (bs > 0.0 && PU.d.w > 0.0) {
    let rel = x.xyz - PU.d.xyz;
    let dist = length(rel);
    if (dist < PU.d.w) {
      // (its heart goes to dust; what's thrown breaks up where it lands)
      px[2u * i] = vec4<f32>(x.xyz, PV_DUST);
    } else if (dist < PU.d.w * 2.5 && x.w > 0.0) {
      // (heavier voxels move less)
      vel += rel / dist * bs * (1.0 - dist / (PU.d.w * 2.5)) * min(1.0, x.w * 2.5);
    }
  }
  pv[i] = vec4<f32>(vel, tn);
}

// ---- 7. what crumbled breaks into fragments half its size ------------------------------
// (round 49: most of the simulation stays coarse; it refines where it breaks)
const SPLIT_OFF = array<vec3<f32>, 8>(
  vec3<f32>(-1.0, -1.0, -1.0), vec3<f32>(1.0, -1.0, -1.0), vec3<f32>(-1.0, 1.0, -1.0), vec3<f32>(1.0, 1.0, -1.0),
  vec3<f32>(-1.0, -1.0, 1.0), vec3<f32>(1.0, -1.0, 1.0), vec3<f32>(-1.0, 1.0, 1.0), vec3<f32>(1.0, 1.0, 1.0));

@compute @workgroup_size(64)
fn split(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x) { return; }
  let x = px[2u * i];
  if (x.w != PV_CRUMBLE) { return; }
  let info = infoOf(i);
  let code = select(sizeCodeOf(info), 16u, sizeCodeOf(info) == 0u);
  let cc = code / 2u;
  // a fragment, or too small to halve: it goes to dust (deaths)
  if (bodyOf(info) == FRAG_BODY || cc < FRAG_MIN_CODE) { return; }
  let m = info & 0xffu;
  let cs = f32(cc) / 16.0;
  let q = pq[i];
  let v = pv[i];
  let temp = px[2u * i + 1u].w;
  let invM = 1.0 / max(pmA(m).x * cs * cs * cs, 1e-4);
  let ci = (info & 0xffu) | (FRAG_BODY << 8u) | (cc << 16u);
  let base = atomicAdd(&fragHead[0], 8u);
  for (var k = 0u; k < 8u; k++) {
    let j = (base + k) % FRAG_CAP;
    // (the ring has come round onto a fragment still flying: it goes to
    // loose ground where it is, so nothing is lost)
    let old = px[2u * j];
    if (old.w >= 0.0 || old.w == PV_CRUMBLE || old.w == PV_DUST) {
      let oc = cellAt(old.xy);
      if (inMap(oc)) {
        let os = sizeOf(infoOf(j));
        let oci = colIdxI(oc);
        atomicAdd(&dep[2u * oci], u32(1000.0 * os * os * os));
        atomicMax(&dep[2u * oci + 1u], u32(pmC(matOf(j)).w));
      }
    }
    let o = qrotP(q, SPLIT_OFF[k]);
    let p = x.xyz + o * (cs * 0.5);
    let seed = hash3(i, k, PU.c.z);
    let rn = vec3<f32>(f32(seed & 255u), f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0 - 0.5;
    // (they spring apart a little, each turned its own way)
    let vel = v.xyz + o * 0.9 + rn * 1.2;
    let spin = normalize(qmul(normalize(vec4<f32>(rn * 0.8, 1.0)), q));
    px[2u * j] = vec4<f32>(p, invM);
    px[2u * j + 1u] = vec4<f32>(p, temp);
    pv[j] = vec4<f32>(vel, temp);
    pr[j] = vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(ci));
    pq[j] = spin;
    pb[j] = 0u;
    pc[j] = vec4<f32>(0.0);
  }
  px[2u * i] = vec4<f32>(x.xyz, PV_SPLIT);
}

// ---- 8. what crumbled or melted leaves the bodies -------------------------------------
@compute @workgroup_size(64)
fn deaths(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x) { return; }
  // a map structure it touched: into the list the host reads (first 255 a tick)
  let tc = bitcast<u32>(pc[i].w);
  if (tc != 0u) {
    pc[i].w = 0.0;
    let k = atomicAdd(&touches[0], 1u);
    if (k < 255u) { atomicStore(&touches[k + 1u], tc - 1u); }
  }
  let x = px[2u * i];
  if (x.w > -1.5 || x.w < -5.5) { return; }
  let m = matOf(i);
  let melted = x.w == PV_MELT;
  px[2u * i] = vec4<f32>(x.xyz, PV_DEAD);
  pb[i] = 0u;
  let seed = hash3(i, PU.c.z, 0x9e37u);
  let r = vec3<f32>(f32(seed & 255u), f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0 - 0.5;
  if (melted) {
    spawnPart(x.xyz, vec3<f32>(r.xy * 3.0, 2.0 + r.z * 2.0), 2.5, K_EMBER_P, seed, 0u);
    return;
  }
  // broken into fragments (split): a puff of dust where it broke
  if (x.w == PV_SPLIT) {
    if ((seed >> 24u) >= 96u) { return; }
    spawnPart(x.xyz, vec3<f32>(r.xy * 1.5, 0.8), 3.0, K_DUST_P, seed ^ 0x55u, (u32(pmC(m).w) & 255u) << 8u);
    return;
  }
  // a crumbled voxel: its loose material (by its volume) lands below, with a chip and dust
  let sz = sizeOf(infoOf(i));
  let c = cellAt(x.xy);
  if (inMap(c)) {
    let ci = colIdxI(c);
    atomicAdd(&dep[2u * ci], u32(1000.0 * sz * sz * sz));
    atomicMax(&dep[2u * ci + 1u], u32(pmC(m).w));
  }
  spawnPart(x.xyz, vec3<f32>(r.xy * 6.0, 3.0 + r.z * 3.0), 1.4, K_CHIP_P, seed, (m & 255u) << 8u);
  // and a puff of dust (round 47: more of it, so a collapse smokes; a
  // fragment's by its size, so a voxel's eight raise what it would have)
  let rd = f32((seed >> 16u) & 255u) / 256.0;
  if (rd < sz * sz * 2.0) {
    spawnPart(x.xyz, vec3<f32>(r.xy * 1.5, 0.8), 3.0, K_DUST_P, seed ^ 0x55u, (u32(pmC(m).w) & 255u) << 8u);
  }
  if (f32(seed >> 24u) < 128.0 * sz * sz) {
    spawnPart(x.xyz + r * 0.6, vec3<f32>(r.yx * 2.5, 1.2), 4.0, K_HAZE_P, seed ^ 0xa3u, (u32(pmC(m).w) & 255u) << 8u);
  }
}

// ---- once a tick: crumbled ground into the deposit, and the draw instances ---------------
@compute @workgroup_size(8, 8)
fn fold(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let ci = colIdx(id.x, id.y);
  let a = atomicExchange(&dep[2u * ci], 0u);
  if (a == 0u) { return; }
  let m = atomicExchange(&dep[2u * ci + 1u], 0u);
  let d = deposit[ci];
  deposit[ci] = vec4<f32>(d.x, d.y + f32(a) / 1000.0, f32(m), d.w);
}

// the six face neighbours among n26
const FACES = array<u32, 6>(4u, 10u, 12u, 13u, 15u, 21u);
var<workgroup> wgN: atomic<u32>;
var<workgroup> wgBase: u32;

/** Each voxel with a face open (an unbonded face neighbour): a rotated cube; bit 30 marks it, bits 8..15 a stable speckle, 16..23 its heat. */
@compute @workgroup_size(64)
fn prep(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wgN, 0u); }
  workgroupBarrier();
  let i = id.x;
  var show = false;
  if (i < PU.c.x && alive(i)) {
    // the nature grid sees it (sand and water lie on it): the columns under it,
    // its centre and a little round it so a turned body leaves no holes
    let xc = px[2u * i].xyz;
    for (var k = 0u; k <= NDIR; k++) {
      let o = select(DIRV[min(k, NDIR - 1u)] * 0.3, vec2<f32>(0.0), k == NDIR);
      splatCol(xc.xy + o, xc.z);
    }
    // the six face neighbours are n26 4, 10, 12, 13, 15, 21
    let bonds = pb[i];
    let faces = (1u << 4u) | (1u << 10u) | (1u << 12u) | (1u << 13u) | (1u << 15u) | (1u << 21u);
    show = (bonds & faces) != faces;
    if (!show) {
      let info = infoOf(i);
      let b = PB[(info >> 8u) & 0xffu];
      let l = latOf(i, b);
      for (var f = 0u; f < 6u; f++) {
        let j = latIdx(l + n26(FACES[f]), b);
        if (j < 0 || !alive(u32(j))) { show = true; }
      }
    }
    // (a body a mesh draws: its voxels are only what the world feels, round 49
    // — but one that has lost a face neighbour it had shows where the mesh
    // tore, so a break shows what's inside)
    let info = infoOf(i);
    if (((info >> 22u) & 1u) != 0u) {
      let b = PB[bodyOf(info)];
      let l = latOf(i, b);
      // (gone, or the crack has opened: a snapped bond whose two sides still
      // touch is hidden under the mesh, which bends across it)
      var lost = false;
      let gap = 1.25 * sizeOf(info);
      for (var f = 0u; f < 6u; f++) {
        if (((info >> (23u + f)) & 1u) == 0u) { continue; }
        let j = latIdx(l + n26(FACES[f]), b);
        if (j < 0 || !alive(u32(j))) { lost = true; continue; }
        if ((bonds & (1u << FACES[f])) == 0u && length(px[2u * u32(j)].xyz - xc) > gap) { lost = true; }
      }
      show = lost;
    }
  }
  let off = atomicAdd(&wgN, select(0u, 1u, show));
  workgroupBarrier();
  if (li == 0u) { wgBase = atomicAdd(&indirect[1], atomicLoad(&wgN)); }
  workgroupBarrier();
  if (!show) { return; }
  let x = px[2u * i];
  let m = matOf(i);
  let melt = pmC(m).y;
  let heat = select(0.0, clamp(px[2u * i + 1u].w / max(melt, 1.0), 0.0, 1.0), melt > 0.0);
  // (its size code in bits 24..29: render.wgsl bodySize)
  let word = m | ((pcg(i) & 255u) << 8u) | (u32(heat * 255.0) << 16u) | (sizeCodeOf(infoOf(i)) << 24u) | 0x40000000u;
  let q = pq[i];
  let o = (wgBase + off) * 2u;
  inst[o] = vec4<u32>(bitcast<u32>(x.x), bitcast<u32>(x.y), bitcast<u32>(x.z), word);
  inst[o + 1u] = vec4<u32>(bitcast<u32>(q.x), bitcast<u32>(q.y), bitcast<u32>(q.z), bitcast<u32>(q.w));
}

// ---- once a tick: meshes drawn over bodies, bent by their voxels (round 49) ------------
// A mesh's vertices are bound to up to four of its body's voxels each (weights
// at bind time, physics.ts spawnMesh): per vertex, 7 vec4 — the voxels'
// indices (none: 0xffffffff), their weights, the vertex's rest position (xyz,
// local cells; w its triangle's material, u32 bits), then its offset from each
// voxel's rest centre (local). Where it is now: each voxel's position plus its
// region's rotation of the offset, weighted. A triangle whose voxels have
// mostly gone (crumbled, melted) or which a crack has stretched past
// TEAR times its rest size is dropped: the mesh tears where the body breaks.
// Out: per vertex (xyz f32 bits, the material word as vsBody's), (its
// triangle's normal xyz f32 bits, 0); render.wgsl vsSkin draws them.
@group(0) @binding(30) var<storage, read> skinSrc: array<vec4<f32>>;
@group(0) @binding(31) var<storage, read_write> skinOut: array<vec4<u32>>;
@group(0) @binding(32) var<storage, read_write> skinArgs: array<atomic<u32>>;
const SKIN_NONE: u32 = 0xffffffffu;
const SKIN_V: u32 = 7u;
// TEAR (was 1.6): G.tune.voxelsTear (round 108, src/tune/params.ts)

struct SkinV { p: vec3<f32>, rest: vec3<f32>, heat: f32, ok: bool, mat: u32 };

fn skinVertex(v: u32) -> SkinV {
  let b = v * SKIN_V;
  let idx = bitcast<vec4<u32>>(skinSrc[b]);
  let wt = skinSrc[b + 1u];
  let rest = skinSrc[b + 2u];
  var o: SkinV;
  o.rest = rest.xyz;
  o.mat = bitcast<u32>(rest.w);
  var p = vec3<f32>(0.0);
  var t = 0.0;
  var ws = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let j = idx[k];
    if (j == SKIN_NONE || wt[k] <= 0.0) { continue; }
    if (!alive(j)) { continue; }
    p += (px[2u * j].xyz + qrotP(pq[j], skinSrc[b + 3u + k].xyz)) * wt[k];
    t += px[2u * j + 1u].w * wt[k];
    ws += wt[k];
  }
  o.ok = ws > 0.35;
  o.p = p / max(ws, 1e-6);
  o.heat = t / max(ws, 1e-6);
  return o;
}

@compute @workgroup_size(64)
fn skin(@builtin(global_invocation_id) id: vec3<u32>) {
  let t = id.x;
  if (t >= PU.e.x) { return; }
  let a = skinVertex(3u * t);
  let b = skinVertex(3u * t + 1u);
  let c = skinVertex(3u * t + 2u);
  if (!a.ok || !b.ok || !c.ok) { return; }
  // torn: an edge stretched far past its rest length
  let la = length(a.rest - b.rest);
  let lb = length(b.rest - c.rest);
  let lc = length(c.rest - a.rest);
  if (length(a.p - b.p) > la * G.tune.voxelsTear + 0.05 || length(b.p - c.p) > lb * G.tune.voxelsTear + 0.05 || length(c.p - a.p) > lc * G.tune.voxelsTear + 0.05) { return; }
  let n = normalize(cross(b.p - a.p, c.p - a.p) + vec3<f32>(0.0, 0.0, 1e-9));
  let m = a.mat & 0xffu;
  let melt = pmC(m).y;
  let heat = select(0.0, clamp(max(max(a.heat, b.heat), c.heat) / max(melt, 1.0), 0.0, 1.0), melt > 0.0);
  let word = m | ((pcg(t) & 255u) << 8u) | (u32(heat * 255.0) << 16u) | 0x40000000u;
  let o = atomicAdd(&skinArgs[0], 3u) * 2u;
  let nb = bitcast<vec3<u32>>(n);
  let ps = array<vec3<f32>, 3>(a.p, b.p, c.p);
  for (var k = 0u; k < 3u; k++) {
    skinOut[o + 2u * k] = vec4<u32>(bitcast<vec3<u32>>(ps[k]), word);
    skinOut[o + 2u * k + 1u] = vec4<u32>(nb, 0u);
  }
}

// ---- once a tick: each body's state for the game (round 49) ----------------------------
// Per body 16 words (atomics): live voxels; Σ position (×32, i32); Σ velocity
// (×64); Σ region rotation (×1024, each turned to w ≥ 0); hottest temperature.
@group(0) @binding(35) var<storage, read_write> bstat: array<atomic<i32>>;

@compute @workgroup_size(64)
fn stats(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i)) { return; }
  let bi = bodyOf(infoOf(i));
  if (bi == FRAG_BODY) { return; }
  let o = bi * 16u;
  let x = px[2u * i];
  let v = pv[i].xyz;
  var q = pq[i];
  if (q.w < 0.0) { q = -q; }
  atomicAdd(&bstat[o], 1);
  let xp = vec3<i32>(round(x.xyz * 32.0));
  atomicAdd(&bstat[o + 1u], xp.x);
  atomicAdd(&bstat[o + 2u], xp.y);
  atomicAdd(&bstat[o + 3u], xp.z);
  let vp = vec3<i32>(round(v * 64.0));
  atomicAdd(&bstat[o + 4u], vp.x);
  atomicAdd(&bstat[o + 5u], vp.y);
  atomicAdd(&bstat[o + 6u], vp.z);
  let qp = vec4<i32>(round(q * 1024.0));
  atomicAdd(&bstat[o + 7u], qp.x);
  atomicAdd(&bstat[o + 8u], qp.y);
  atomicAdd(&bstat[o + 9u], qp.z);
  atomicAdd(&bstat[o + 10u], qp.w);
  atomicMax(&bstat[o + 11u], i32(px[2u * i + 1u].w));
}
