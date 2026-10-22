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
//   pr[i]      xyz rest position on the lattice (local, cells), w material | body << 8 (u32 bits)
//   pq[i]      its region's rotation (rest → world), a quaternion
//   pg[2i]     its region's centre now (xyz), w mass; pg[2i + 1] its rest centre
//   pb[i]      bonds: bit k set while bonded to lattice neighbour k (n26)
//   pc[i]      this substep's contacts: xyz summed normals, w the fastest approach
const PV_DEAD: f32 = -1.0;
const PV_CRUMBLE: f32 = -2.0;
const PV_MELT: f32 = -3.0;
const HASH_N: u32 = 262144u;
const HASH_NONE: u32 = 0xffffffffu;
const G_ACC: f32 = 20.0; // cells/s²
const VMAX: f32 = 60.0;
const AIR_DRAG: f32 = 0.05; // 1/s
const STEP_UP: f32 = 0.45; // a ledge this high is climbed, not a wall
const CRUMBLE_DEPTH: f32 = 0.6; // into solid ground this far, a voxel crumbles
const CRUMBLE_OVERLAP: f32 = 0.5; // two voxels this far into each other: the weaker crumbles
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
};
@group(0) @binding(22) var<uniform> PU: PhysU;
// per material, 4 vec4 (physics.ts PHYS_MATS):
//  [0] density, stiffness 0..1, yield (cells of local deviation), plastic rate 0..1
//  [1] break strain, restitution, friction, crumble speed (cells/s)
//  [2] soften temperature, melt temperature (0: never), heat gain, loose material it crumbles to
//  [3] damping (share of its bonds' stretching speed taken out per substep), crack speed (cells/s; 0 never)
@group(0) @binding(23) var<uniform> PM: array<vec4<f32>, 128>;
// bodies: x first particle, yzw lattice dims
@group(0) @binding(24) var<uniform> PB: array<vec4<u32>, 256>;

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
// how fast a voxel in lava takes its heat (share a second)
const LAVA_HEAT: f32 = 1.5;
// air shoved by voxels landing (finalize; windfield.wgsl): per wind texel (2 cells), ×1000
@group(0) @binding(27) var<storage, read_write> puff: array<atomic<u32>>;

/** Mark cell z of the column under w as holding a voxel. */
fn splatCol(w: vec2<f32>, z: f32) {
  let c = cellAt(w);
  if (!inMap(c) || z < 0.0 || z >= 256.0) { return; }
  let zc = u32(z);
  atomicOr(&cols[colIdxI(c) * 8u + zc / 32u], 1u << (zc % 32u));
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

// ---- 1. predict: gravity, and the move ----------------------------------------
@compute @workgroup_size(64)
fn predict(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i)) { return; }
  let x = px[2u * i];
  let vt = pv[i];
  var v = vt.xyz;
  if (x.w > 0.0) { v.z -= G_ACC * PU.a.x; }
  pv[i] = vec4<f32>(v, vt.w);
  px[2u * i + 1u] = vec4<f32>(x.xyz, vt.w);
  px[2u * i] = vec4<f32>(x.xyz + v * PU.a.x * f32(x.w > 0.0), x.w);
}

// ---- 2. regions: the best rotation of each voxel's neighbourhood -----------------
@compute @workgroup_size(64)
fn region(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i)) { return; }
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
  if (i >= PU.c.x || !alive(i)) { return; }
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
  if (i >= PU.c.x || !alive(i)) { return; }
  let x0 = px[2u * i];
  let info = infoOf(i);
  let m = info & 0xffu;
  // a foundation (pinned) whose ground has gone (dug, blasted, melted): it
  // falls with the rest instead of hanging in the air
  if (x0.w == 0.0) {
    let gp = groundAt(cellAt(x0.xyz.xy), x0.z - RAD - 0.05);
    if (gp.x < x0.z - RAD - 0.35) { px[2u * i] = vec4<f32>(x0.xyz, 1.0 / max(pmA(m).x, 0.1)); }
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
  let depth = g.x - (x.z - RAD);
  if (depth > 0.0) {
    if (g.y > 0.5 && g.z < 0.5 && depth > CRUMBLE_DEPTH) { dying = true; }
    if (x.z < p0.z) {
      fastest = max(fastest, -v.z * (1.0 - 0.6 * g.z));
      x.z = p0.z;
    }
    nsum += vec3<f32>(0.0, 0.0, 1.0);
    if (moving && wakeable(u32(g.w)) && inMap(c)) { touched = colIdxI(c) + 1u; }
  }
  // the columns around: a wall is one standing higher than a step up
  if (inMap(c)) {
    let cp = cellPos(c);
    for (var k = 0u; k < NDIR; k++) {
      if (dot(x.xy - cp, DIRV[k]) <= 0.0) { continue; }
      let gn = groundAt(nbr(c, k), x.z + RAD);
      if (gn.x - (x.z - RAD) <= STEP_UP) { continue; }
      if (gn.y < 0.5 && gn.x < x.z - RAD) { continue; }
      let into = dot(x.xy - p0.xy, DIRV[k]);
      if (moving && wakeable(u32(gn.w)) && inMap(nbr(c, k))) { touched = colIdxI(nbr(c, k)) + 1u; }
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
  let toughI = pmA(m).x * crumbleV;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let cc = cell + vec3<i32>(dx, dy, dz);
        var j = atomicLoad(&hashT[cellHash(cc)]);
        var guard = 0u;
        while (j != HASH_NONE && guard < 64u) {
          guard++;
          let ju = j;
          j = atomicLoad(&hashT[HASH_N + ju]);
          if (ju == i) { continue; }
          let xj = px[2u * ju];
          if (xj.w < 0.0) { continue; }
          if (any(vec3<i32>(floor(xj.xyz)) != cc)) { continue; }
          let d = x - xj.xyz;
          let dist = length(d);
          if (dist >= 2.0 * RAD || dist < 1e-5) { continue; }
          let infoJ = infoOf(ju);
          // bonded neighbours hold each other by their bonds; voxels of one
          // body that started close (a squeeze, two sides of a crack) only
          // nudge each other, never crumble
          var near = false;
          if (infoJ >> 8u == info >> 8u) {
            let dl = latOf(ju, b) - l;
            if (all(abs(dl) <= vec3<i32>(1))) {
              let k = u32((dl.x + 1) + 3 * (dl.y + 1) + 9 * (dl.z + 1));
              let kk = select(k, k - 1u, k > 13u);
              if ((bonds & (1u << kk)) != 0u) { continue; }
            }
            near = all(abs(dl) <= vec3<i32>(2));
          }
          let n = d / dist;
          let over = 2.0 * RAD - dist;
          let closing = -dot(v - pv[ju].xyz, n);
          let mj = infoJ & 0xffu;
          let toughJ = pmA(mj).x * pmB(mj).w;
          // too fast for the weaker of the two: it breaks up (ties: the higher index)
          // (by chance, the harder the more likely: below)
          if (!near && closing > crumbleV && (toughI < toughJ || (toughI == toughJ && i > ju))) { fastest = max(fastest, closing); }
          // deeper than the weaker can bear: it crumbles
          if (!near && over > CRUMBLE_OVERLAP && (toughI < toughJ || (toughI == toughJ && i > ju))) { dying = true; }
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
  if (i >= PU.c.x || !alive(i)) { return; }
  let x = px[2u * i];
  let prev = px[2u * i + 1u];
  let info = infoOf(i);
  let m = info & 0xffu;
  let h = PU.a.x;
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
    if (n.z > 0.5 && hit > PUFF_V) {
      let wt = vec2<i32>(floor(x.xy * 0.5));
      let ww = (G.mapW + 1u) / 2u;
      if (all(wt >= vec2<i32>(0)) && u32(wt.x) < ww && u32(wt.y) < (G.mapH + 1u) / 2u) {
        atomicAdd(&puff[u32(wt.y) * ww + u32(wt.x)], u32(min(hit - PUFF_V, 25.0) * 100.0));
      }
      let seed = hash3(i, PU.c.z, 0x2c1bu);
      if (f32(seed >> 24u) < min((hit - PUFF_V) * 6.0, 120.0)) {
        let r = vec3<f32>(f32(seed & 255u), f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0 - 0.5;
        spawnPart(x.xyz - vec3<f32>(0.0, 0.0, RAD), vec3<f32>(r.xy * 0.4 * hit, 0.6 + r.z), 3.0 + r.z * 2.0, K_HAZE_P, seed, (u32(pmC(m).w) & 255u) << 8u);
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
  v *= 1.0 - AIR_DRAG * h;
  let sp = length(v);
  if (sp > VMAX) { v *= VMAX / sp; }
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

// ---- 6. plastic flow and heat --------------------------------------------------------
@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= PU.c.x || !alive(i)) { return; }
  let x = px[2u * i];
  let t = px[2u * i + 1u].w;
  let info = infoOf(i);
  let m = info & 0xffu;
  let h = PU.a.x;
  // past its yield, the rest shape follows the bend (metal stays bent)
  let soft = softAt(m, t);
  let yieldD = pmA(m).z * (1.0 - soft);
  let r = pr[i];
  let d = qrotP(qinvP(pq[i]), x.xyz - pg[2u * i].xyz) - (r.xyz - pg[2u * i + 1u].xyz);
  let dl = length(d);
  if (dl > yieldD && pmA(m).w > 0.0) {
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
    if (L.x > 0.02 && x.z - RAD < L.w && L.y > tn) { tn += (L.y - tn) * min(LAVA_HEAT * pmC(m).z * h, 1.0); }
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
      px[2u * i] = vec4<f32>(x.xyz, PV_CRUMBLE);
    } else if (dist < PU.d.w * 2.5 && x.w > 0.0) {
      // (heavier voxels move less)
      vel += rel / dist * bs * (1.0 - dist / (PU.d.w * 2.5)) * min(1.0, x.w * 2.5);
    }
  }
  pv[i] = vec4<f32>(vel, tn);
}

// ---- 7. what crumbled or melted leaves the bodies -------------------------------------
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
  if (x.w > -1.5 || x.w < -3.5) { return; }
  let m = matOf(i);
  let melted = x.w < -2.5;
  px[2u * i] = vec4<f32>(x.xyz, PV_DEAD);
  pb[i] = 0u;
  let seed = hash3(i, PU.c.z, 0x9e37u);
  let r = vec3<f32>(f32(seed & 255u), f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0 - 0.5;
  if (melted) {
    spawnPart(x.xyz, vec3<f32>(r.xy * 3.0, 2.0 + r.z * 2.0), 2.5, K_EMBER_P, seed, 0u);
    return;
  }
  // a crumbled voxel: its loose material lands below, with a chip and dust
  let c = cellAt(x.xy);
  if (inMap(c)) {
    let ci = colIdxI(c);
    atomicAdd(&dep[2u * ci], 1000u);
    atomicMax(&dep[2u * ci + 1u], u32(pmC(m).w));
  }
  spawnPart(x.xyz, vec3<f32>(r.xy * 6.0, 3.0 + r.z * 3.0), 1.4, K_CHIP_P, seed, (m & 255u) << 8u);
  // and a puff of dust (round 47: more of it, so a collapse smokes)
  spawnPart(x.xyz, vec3<f32>(r.xy * 1.5, 0.8), 3.0, K_DUST_P, seed ^ 0x55u, (u32(pmC(m).w) & 255u) << 8u);
  if ((seed >> 24u) < 128u) {
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
  let word = m | ((pcg(i) & 255u) << 8u) | (u32(heat * 255.0) << 16u) | 0x40000000u;
  let q = pq[i];
  let o = (wgBase + off) * 2u;
  inst[o] = vec4<u32>(bitcast<u32>(x.x), bitcast<u32>(x.y), bitcast<u32>(x.z), word);
  inst[o + 1u] = vec4<u32>(bitcast<u32>(q.x), bitcast<u32>(q.y), bitcast<u32>(q.z), bitcast<u32>(q.w));
}
