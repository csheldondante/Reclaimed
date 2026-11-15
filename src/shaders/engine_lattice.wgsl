// ---- the engine's stage 4: the voxel lattice on the particles of deforming bodies only (engine_deform.wgsl) ----------
// The lattice of docs/PHYSICS.md (phys.wgsl: lattice shape matching, contacts that never push out, plastic flow, bonds
// that snap, cracks, crumbling), forked here for the engine's route: its particles are paged, a particle finds its
// body through its page (no 8-bit body id, no body table), and every kernel is dispatched over the live pages only —
// eight workgroups a page, from the GPU's own count: nothing deforming, no workgroups. Its sleep is settling
// (engine_settle.wgsl): nothing is read back, there is no CPU sleep. phys.wgsl stays as it is for ?solver=lattice.
// The voxel hash stays, only among deforming voxels (the build note, "How the lattice becomes stage 4"): the two sides
// of a crack, and two deforming bodies, meet through it; a rigid row is never in it.
// Left out on this route for now (docs/design/PHYSICS_ENGINE.md, limits): half-size fragments (a crumbling voxel goes
// to loose ground, chips and dust: a body is only ever drawn as its mesh), heat, the game's drives and pushes, the air
// shoved by a landing.
@group(0) @binding(28) var<storage, read_write> dev: array<atomic<u32>>;
@group(0) @binding(29) var<storage, read> layersD: array<vec4<u32>>;
struct PartP { p: vec4<f32>, v: vec4<f32>, m: vec4<u32> };
@group(0) @binding(30) var<storage, read_write> parts: array<PartP>;
@group(0) @binding(31) var<storage, read_write> counters: array<atomic<u32>>;
const K_CHIP_P: u32 = 5u;
const K_DUST_P: u32 = 1u;
const K_HAZE_P: u32 = 15u;
const RAD: f32 = 0.5;
// a landing kicks up dust from this speed (cells/s)
const PUFF_V: f32 = 3.0;

fn spawnPart(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, seed: u32, state: u32) {
  let i = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[i] = PartP(vec4<f32>(pos, life), vec4<f32>(vel, 0.0), vec4<u32>(kind, seed, 0u, state));
}

/** particle i of a body the lattice is stepping (its slot live), or ok false */
fn stepping(i: u32) -> Lat {
  var L: Lat;
  if (i == NONE) { return L; }
  L = latOf(i);
  L.ok = L.ok && L.state == S_LIVE && alive(i);
  return L;
}

// ---- 1. predict: gravity and the move ---------------------------------------------------------------------------------
@compute @workgroup_size(64)
fn predict(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = stepping(i);
  if (!L.ok) { return; }
  let h = EU.k.w;
  let x = px[2u * i];
  var v = ps[3u * i].xyz;
  v.z -= worldG() * G.tune.voxelsGravity * h;
  ps[3u * i] = vec4<f32>(v, 0.0);
  px[2u * i + 1u] = vec4<f32>(x.xyz, px[2u * i + 1u].w);
  px[2u * i] = vec4<f32>(x.xyz + v * h, x.w);
}

// ---- 2. regions: the best rotation of each voxel's neighbourhood --------------------------------------------------------
@compute @workgroup_size(64)
fn region(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = stepping(i);
  if (!L.ok) { return; }
  let l = cellOf(L.k, L.dims);
  let bonds = pb[i];
  // Every place is taken about the voxel's own (a neighbour's less its own is a small number, exact in a float): a
  // centre summed from the world's coordinates is rounded to their grid — 1.5e-5 of a cell at x = 233 — the same way
  // every substep, and the goals made from it pushed a body lying still across the ground at a steady 4 to 11
  // cells/s in the level (0.5 with the voxel hash's contacts damping it). Found in letter E's lab captures.
  let xi = px[2u * i];
  let ri = ps[3u * i + 1u].xyz;
  let m0 = 1.0 / max(xi.w, 1e-3);
  var M = m0;
  var c = vec3<f32>(0.0);
  var c0 = ri * m0;
  var nb: array<i32, 26>;
  for (var k = 0u; k < 26u; k++) {
    nb[k] = -1;
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(L.slot, l + n26(k), L.dims);
    if (j < 0 || !alive(u32(j))) { continue; }
    nb[k] = j;
    let xj = px[2u * u32(j)];
    let m = 1.0 / max(xj.w, 1e-3);
    M += m;
    c += (xj.xyz - xi.xyz) * m;
    c0 += ps[3u * u32(j) + 1u].xyz * m;
  }
  c /= M;
  c0 /= M;
  // A = sum m (x - c)(r - c0)^T, as its three columns (x about the voxel's own place: its own is zero)
  var a0 = -c * (ri.x - c0.x) * m0;
  var a1 = -c * (ri.y - c0.y) * m0;
  var a2 = -c * (ri.z - c0.z) * m0;
  for (var k = 0u; k < 26u; k++) {
    if (nb[k] < 0) { continue; }
    let j = u32(nb[k]);
    let xj = px[2u * j];
    let d = (xj.xyz - xi.xyz - c) / max(xj.w, 1e-3);
    let r = ps[3u * j + 1u].xyz - c0;
    a0 += d * r.x;
    a1 += d * r.y;
    a2 += d * r.z;
  }
  // its rotation (Müller et al. 2016), from last substep's
  var q = ps[3u * i + 2u];
  for (var it = 0; it < 6; it++) {
    let r0 = eqrot(q, vec3<f32>(1.0, 0.0, 0.0));
    let r1 = eqrot(q, vec3<f32>(0.0, 1.0, 0.0));
    let r2 = eqrot(q, vec3<f32>(0.0, 0.0, 1.0));
    let om = (cross(r0, a0) + cross(r1, a1) + cross(r2, a2)) / (abs(dot(r0, a0) + dot(r1, a1) + dot(r2, a2)) + 1e-9);
    let w = length(om);
    if (w < 1e-7) { break; }
    let ax = om / w;
    let dq = vec4<f32>(ax * sin(w * 0.5), cos(w * 0.5));
    q = normalize(vec4<f32>(dq.w * q.xyz + q.w * dq.xyz + cross(dq.xyz, q.xyz), dq.w * q.w - dot(dq.xyz, q.xyz)));
  }
  ps[3u * i + 2u] = q;
  pw[3u * i] = vec4<f32>(c, M);
  pw[3u * i + 1u] = vec4<f32>(c0, 0.0);
}

// ---- 3. goals: toward where its regions would put it ------------------------------------------------------------------
@compute @workgroup_size(64)
fn gather(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = stepping(i);
  if (!L.ok) { return; }
  let x = px[2u * i];
  let l = cellOf(L.k, L.dims);
  let bonds = pb[i];
  let r = ps[3u * i + 1u].xyz;
  // (each goal about the voxel's own place: its region's centre is kept about its region's voxel — `region`)
  var sum = pw[3u * i].xyz + eqrot(ps[3u * i + 2u], r - pw[3u * i + 1u].xyz);
  var n = 1.0;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(L.slot, l + n26(k), L.dims);
    if (j < 0 || !alive(u32(j))) { continue; }
    let ju = u32(j);
    sum += (px[2u * ju].xyz - x.xyz) + pw[3u * ju].xyz + eqrot(ps[3u * ju + 2u], r - pw[3u * ju + 1u].xyz);
    n += 1.0;
  }
  if (n < 1.5) { return; }
  px[2u * i] = vec4<f32>(x.xyz + sum / n * pmA(matOf(i)).y, x.w);
}

// ---- 4. contacts: the voxel hash, the ground under it, the columns beside it, other voxels --------------------------------
// every voxel of a deforming body goes in, the still ones too (what moves still meets them)
@compute @workgroup_size(64)
fn vhash(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  if (i == NONE) { return; }
  let L = latOf(i);
  if (!L.ok || L.state == S_NEW || L.state == S_RELEASE || !alive(i)) { return; }
  let h = vhBucket(vec3<i32>(floor(px[2u * i].xyz)));
  let prev = atomicExchange(&vh[h], i + 1u);
  let r = vhRec(i);
  atomicStore(&vh[r], prev);
  atomicStore(&vh[r + 1u], h);
  atomicStore(&vh[r + 2u], pb[i]);
}

/** The ground in column c: the top of what lies at or below z, whether z is inside it, whether that is loose (x top, y inside, z granular, w material). */
fn groundAtD(c: vec2<i32>, z: f32) -> vec4<f32> {
  if (!inMap(c)) { return vec4<f32>(-1e9, 0.0, 0.0, 0.0); }
  let cs = colSlots(u32(c.x), u32(c.y));
  var top = -1e9;
  var gran = 0.0;
  var mat = 0u;
  for (var s = 0u; s < cs.y; s++) {
    let v = layersD[cs.x + s];
    if (ivEmpty(v)) { break; }
    if (ivZ0(v) > z) { break; }
    top = ivZ1(v);
    mat = ivMat(v);
    gran = select(0.0, 1.0, matState(mat) == ST_GRANULAR);
    if (z < top) { return vec4<f32>(top, 1.0, gran, f32(mat)); }
  }
  return vec4<f32>(top, 0.0, gran, f32(mat));
}

// Contacts never push out (DECISIONS round 43): they only stop a voxel moving further in; an overlap deeper than the
// material can bear, or an impact faster than its crumble speed, turns the voxel to its loose material.
@compute @workgroup_size(64)
fn collide(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = stepping(i);
  if (!L.ok) { return; }
  let x0 = px[2u * i];
  let m = matOf(i);
  var x = x0.xyz;
  let v = ps[3u * i].xyz;
  let crumbleV = pmB(m).w;
  var nsum = vec3<f32>(0.0);
  var fastest = 0.0;
  var dying = false;
  let p0 = px[2u * i + 1u].xyz;
  let c = cellAt(x.xy);
  let g = groundAtD(c, x.z);
  let depth = g.x - (x.z - RAD);
  if (depth > 0.0) {
    if (g.y > 0.5 && g.z < 0.5 && depth > G.tune.voxelsCrumbleDepth) { dying = true; }
    if (x.z < p0.z) {
      fastest = max(fastest, -v.z * (1.0 - 0.6 * g.z));
      x.z = p0.z;
    }
    nsum += vec3<f32>(0.0, 0.0, 1.0);
  }
  if (inMap(c)) {
    let cp = cellPos(c);
    for (var k = 0u; k < NDIR; k++) {
      if (dot(x.xy - cp, DIRV[k]) <= 0.0) { continue; }
      let gn = groundAtD(nbr(c, k), x.z + RAD);
      if (gn.x - (x.z - RAD) <= G.tune.voxelsStepUp) { continue; }
      if (gn.y < 0.5 && gn.x < x.z - RAD) { continue; }
      let into = dot(x.xy - p0.xy, DIRV[k]);
      if (into > 0.0) {
        fastest = max(fastest, dot(v.xy, DIRV[k]) * (1.0 - 0.6 * gn.z));
        x -= vec3<f32>(DIRV[k] * into, 0.0);
      }
      nsum += vec3<f32>(-DIRV[k], 0.0);
    }
  }
  // other deforming voxels: those it isn't bonded to (phys.wgsl `collide`, with the chain guard counted)
  let l = cellOf(L.k, L.dims);
  let bonds = atomicLoad(&vh[vhRec(i) + 2u]);
  let cell = vec3<i32>(floor(x));
  let toughI = pmA(m).x * crumbleV;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let cc = cell + vec3<i32>(dx, dy, dz);
        var j = atomicLoad(&vh[vhBucket(cc)]);
        var guard = 0u;
        while (j != 0u) {
          if (guard >= VH_GUARD) {
            atomicAdd(&vh[0], 1u);
            break;
          }
          guard++;
          let ju = j - 1u;
          j = atomicLoad(&vh[vhRec(ju)]);
          if (ju == i) { continue; }
          let xj = px[2u * ju];
          if (xj.w < 0.0) { continue; }
          if (any(vec3<i32>(floor(xj.xyz)) != cc)) { continue; }
          let d = x - xj.xyz;
          let dist = length(d);
          if (dist >= 2.0 * RAD || dist < 1e-5) { continue; }
          // bonded neighbours hold each other by their bonds; voxels of one body that started close (a squeeze, the
          // two sides of a crack) only nudge each other, never crumble
          var near = false;
          let Lj = latOf(ju);
          if (Lj.ok && Lj.slot == L.slot) {
            let dl = cellOf(Lj.k, L.dims) - l;
            if (all(abs(dl) <= vec3<i32>(1))) {
              let k = u32((dl.x + 1) + 3 * (dl.y + 1) + 9 * (dl.z + 1));
              let kk = select(k, k - 1u, k > 13u);
              if ((bonds & (1u << kk)) != 0u) { continue; }
            }
            near = all(abs(dl) <= vec3<i32>(2));
          }
          let n = d / dist;
          let over = 2.0 * RAD - dist;
          let closing = -dot(v - ps[3u * ju].xyz, n);
          let mj = matOf(ju);
          let toughJ = pmA(mj).x * pmB(mj).w;
          // too fast for the weaker of the two: it breaks up (ties: the higher index); deeper than it can bear: it crumbles
          if (!near && closing > crumbleV && (toughI < toughJ || (toughI == toughJ && i > ju))) { fastest = max(fastest, closing); }
          if (!near && over > G.tune.voxelsCrumbleOverlap && (toughI < toughJ || (toughI == toughJ && i > ju))) { dying = true; }
          // stop them closing further (each its share); never part them
          // (a voxel of a body that is not being stepped — still, settling — does not give way: the whole stop is this one's)
          let wj = select(0.0, max(xj.w, 0.0), Lj.ok && Lj.state == S_LIVE);
          let shut = -dot((x - p0) - (xj.xyz - px[2u * ju + 1u].xyz), n);
          if (shut > 0.0) { x += n * shut * x0.w / max(x0.w + wj, 1e-6); }
          nsum += n;
          if (!near) { fastest = max(fastest, closing * 0.5); }
        }
      }
    }
  }
  // an impact past its crumble speed breaks some of the voxels that took it, more the harder it was; the rest hold
  if (fastest > crumbleV) {
    let r = f32(hash3(i, EU.g.w, 0x6b2du) & 0xffffu) / 65536.0;
    if (r < clamp((fastest - crumbleV) / crumbleV, 0.2, 0.6)) { dying = true; }
  }
  if (dying) {
    px[2u * i] = vec4<f32>(x, PV_CRUMBLE);
    return;
  }
  px[2u * i] = vec4<f32>(x, x0.w);
  pw[3u * i + 2u] = vec4<f32>(nsum, 0.0);
}

// ---- 5. velocities, bounce and friction, bonds that snap -----------------------------------------------------------------
@compute @workgroup_size(64)
fn finalize(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  let L = stepping(i);
  if (!L.ok) { return; }
  let x = px[2u * i];
  let prev = px[2u * i + 1u];
  let m = matOf(i);
  let h = EU.k.w;
  let vOld = ps[3u * i].xyz;
  var v = (x.xyz - prev.xyz) / h;
  let ct = pw[3u * i + 2u];
  var hitV = 0.0;
  if (dot(ct.xyz, ct.xyz) > 1e-6) {
    let n = normalize(ct.xyz);
    let vnOld = dot(vOld, n);
    let vn = dot(v, n);
    // (a contact gives back no more than the bounce, however far in it was: nothing gains energy from an overlap)
    let bounce = max(-pmB(m).y * vnOld, 0.0);
    let vnNew = select(min(vn, 0.3), bounce, vnOld < -0.5);
    var vt = v - n * vn;
    let lt = length(vt);
    let jn = abs(vnNew - vnOld);
    if (lt > 1e-6) { vt *= max(0.0, 1.0 - pmB(m).z * jn / lt); }
    v = vt + n * vnNew;
    hitV = max(-vnOld, 0.0);
    if (n.z > 0.5 && hitV > PUFF_V) {
      let seed = hash3(i, EU.g.w, 0x2c1bu);
      if (f32(seed >> 24u) < min((hitV - PUFF_V) * 6.0, 120.0)) {
        let r = vec3<f32>(f32(seed & 255u), f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0 - 0.5;
        spawnPart(x.xyz - vec3<f32>(0.0, 0.0, RAD), vec3<f32>(r.xy * 0.4 * hitV, 0.6 + r.z), 3.0 + r.z * 2.0, K_HAZE_P, seed, (u32(pmC(m).w) & 255u) << 8u);
      }
    }
  }
  // (x: how hard it hit, for relax's cracks)
  pw[3u * i + 2u] = vec4<f32>(hitV, 0.0, 0.0, 0.0);
  let l = cellOf(L.k, L.dims);
  var bonds = pb[i];
  // damping: the speed at which its bonds stretch or squeeze is taken out, so a body doesn't ring after a knock
  let damp = pmD(m).x;
  var dv = vec3<f32>(0.0);
  var nb = 0.0;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(L.slot, l + n26(k), L.dims);
    if (j < 0 || !alive(u32(j))) {
      bonds &= ~(1u << k);
      continue;
    }
    let ju = u32(j);
    let xj = px[2u * ju].xyz;
    let vj = (xj - px[2u * ju + 1u].xyz) / h;
    let e = normalize(xj - x.xyz + vec3<f32>(1e-6));
    dv += e * dot(vj - v, e);
    nb += 1.0;
    // a bond past its break strain snaps (both ends judge the same numbers)
    let lim = min(pmB(m).x, pmB(matOf(ju)).x);
    let r0 = length(ps[3u * i + 1u].xyz - ps[3u * ju + 1u].xyz);
    if (abs(length(x.xyz - xj) / max(r0, 1e-3) - 1.0) > lim) { bonds &= ~(1u << k); }
  }
  if (nb > 0.0 && damp > 0.0) { v += dv / nb * damp; }
  v *= 1.0 - G.tune.voxelsAirDrag * h;
  ps[3u * i] = vec4<f32>(v, 0.0);
  pb[i] = bonds;
  px[2u * i + 1u].w = bitcast<f32>(bonds);
  if (x.z < -20.0) { px[2u * i] = vec4<f32>(x.xyz, PV_DEAD); }
}

// ---- 6. plastic flow and cracks ---------------------------------------------------------------------------------------------
@compute @workgroup_size(64)
fn relax(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  // (the voxel hash, cleared where it was filled: this substep's contacts are done)
  if (i != NONE) {
    let hb = atomicExchange(&vh[vhRec(i) + 1u], 0u);
    if (hb != 0u) { atomicStore(&vh[hb], 0u); }
  }
  let L = stepping(i);
  if (!L.ok) { return; }
  let x = px[2u * i];
  let m = matOf(i);
  // past its yield, the rest shape follows the bend (metal stays bent)
  let yieldD = pmA(m).z;
  let r = ps[3u * i + 1u];
  let d = eqrot(eqinv(ps[3u * i + 2u]), -pw[3u * i].xyz) - (r.xyz - pw[3u * i + 1u].xyz);
  let dl = length(d);
  if (dl > yieldD && pmA(m).w > 0.0) { ps[3u * i + 1u] = vec4<f32>(r.xyz + d * (1.0 - yieldD / dl) * min(1.0, pmA(m).w), r.w); }
  // cracks: a bond whose either end hit something faster than the material's crack speed may snap (both ends draw the
  // same random), more likely the harder the hit, so a hard landing breaks it into chunks
  let crackV = pmD(m).y;
  if (crackV <= 0.0) { return; }
  let l = cellOf(L.k, L.dims);
  let bonds = pb[i];
  var kept = bonds;
  let hi = pw[3u * i + 2u].x;
  for (var k = 0u; k < 26u; k++) {
    if ((bonds & (1u << k)) == 0u) { continue; }
    let j = latIdx(L.slot, l + n26(k), L.dims);
    if (j < 0) { continue; }
    let ju = u32(j);
    let crackJ = pmD(matOf(ju)).y;
    let hit = max(hi, pw[3u * ju + 2u].x);
    let cv = select(crackV, min(crackV, crackJ), crackJ > 0.0);
    if (hit <= cv) { continue; }
    let p = clamp((hit - cv) / (2.0 * cv), 0.0, 0.5);
    let rnd = f32(hash3(min(i, ju), max(i, ju), EU.g.w) & 0xffffu) / 65536.0;
    if (rnd < p) { kept &= ~(1u << k); }
  }
  if (kept != bonds) {
    pb[i] = kept;
    px[2u * i + 1u].w = bitcast<f32>(kept);
    // (a voxel the crack ran through on several sides crumbles: rubble and dust along the break, not clean cuts)
    let r2 = f32(hash3(i, EU.g.w, 0x51edu) & 0xffffu) / 65536.0;
    if (countOneBits(bonds & ~kept) >= 3u && r2 < 0.35) { px[2u * i] = vec4<f32>(x.xyz, PV_CRUMBLE); }
  }
}

// ---- 7. what crumbled leaves its body: loose ground where it is, a chip and dust ------------------------------------------
// Its volume goes to the ground as one of the engine's erosion events (engine_fold.wgsl lays the tick's events on the
// deposit). The events of a tick have a room: with no room left the voxel waits, crumbling, for the next tick, so a
// body that shatters in one tick loses nothing — its slot is told (the sums) and doesn't settle or free its pages yet.
@compute @workgroup_size(64)
fn deaths(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  if (i == NONE) { return; }
  let L = latOf(i);
  if (!L.ok) { return; }
  let x = px[2u * i];
  if (x.w != PV_CRUMBLE) { return; }
  let m = matOf(i);
  let loose = u32(pmC(m).w);
  let c = cellAt(x.xy);
  if (inMap(c)) {
    let k = atomicAdd(&dev[3], 1u);
    if (k >= u32(EU.f.y)) {
      atomicAdd(&pool[EU.h.w + SUMS_W * L.slot + 3u], 1u);
      return;
    }
    if (k % 64u == 0u) { atomicAdd(&dev[0], 1u); }
    atomicStore(&dev[1], 1u);
    atomicStore(&dev[2], 1u);
    let b = EV_AT + k * EV_WORDS;
    atomicStore(&dev[b], EV_ERODE);
    atomicStore(&dev[b + 1u], dmeta[slotAt(L.slot) + 1u]);
    atomicStore(&dev[b + 2u], colIdxI(c));
    atomicStore(&dev[b + 3u], loose);
    atomicStore(&dev[b + 4u], bitcast<u32>(x.x));
    atomicStore(&dev[b + 5u], bitcast<u32>(x.y));
    atomicStore(&dev[b + 6u], bitcast<u32>(x.z));
    atomicStore(&dev[b + 7u], bitcast<u32>(1.0));
  }
  px[2u * i] = vec4<f32>(x.xyz, PV_DEAD);
  atomicAdd(&pool[P_CRUMBS], 1u);
  let seed = hash3(i, EU.g.w, 0x9e37u);
  let r = vec3<f32>(f32(seed & 255u), f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0 - 0.5;
  spawnPart(x.xyz, vec3<f32>(r.xy * 6.0, 3.0 + r.z * 3.0), 1.4, K_CHIP_P, seed, (m & 255u) << 8u);
  spawnPart(x.xyz, vec3<f32>(r.xy * 1.5, 0.8), 3.0, K_DUST_P, seed ^ 0x55u, (loose & 255u) << 8u);
  if ((seed >> 24u) < 128u) { spawnPart(x.xyz + r * 0.6, vec3<f32>(r.yx * 2.5, 1.2), 4.0, K_HAZE_P, seed ^ 0xa3u, (loose & 255u) << 8u); }
}

// ---- once a tick: each slot's voxels counted and their speeds summed (the still timer is `slots`'s) -----------------------
@compute @workgroup_size(64)
fn stats(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  // (the hash's guard: what it cut short this tick, into the pool's header — the host's one read)
  if (wg.x == 0u && li == 0u) { atomicAdd(&pool[P_HASH_OVER], atomicExchange(&vh[0], 0u)); }
  let i = pidx(wg.x, li);
  if (i == NONE) { return; }
  let L = latOf(i);
  if (!L.ok || !alive(i)) { return; }
  let s = EU.h.w + SUMS_W * L.slot;
  atomicAdd(&pool[s], 1u);
  let sp = u32(min(length(ps[3u * i].xyz), 4000.0) * 256.0);
  atomicAdd(&pool[s + 1u], sp);
  // (hook for body against body, engine_deform.wgsl `slots`: the body's bounds about where it expanded and its fastest
  // voxel, so its row can stand in the coarse pass's tables)
  atomicMax(&pool[s + 6u], sp);
  let rel = clamp(px[2u * i].xyz - slotV3(L.slot, 8u), vec3<f32>(-1000.0), vec3<f32>(1000.0));
  let qh = vec3<u32>((vec3<f32>(1024.0) + rel) * 64.0);
  let ql = vec3<u32>((vec3<f32>(1024.0) - rel) * 64.0);
  atomicMax(&pool[s + 8u], qh.x);
  atomicMax(&pool[s + 9u], qh.y);
  atomicMax(&pool[s + 10u], qh.z);
  atomicMax(&pool[s + 11u], ql.x);
  atomicMax(&pool[s + 12u], ql.y);
  atomicMax(&pool[s + 13u], ql.z);
}
