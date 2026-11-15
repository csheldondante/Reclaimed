// ---- deforming voxels meet rigid rows, the contact (docs/design/PHYSICS_ENGINE.md "Pieces break pieces") -------------
// A thread a voxel of the live pages, each lattice substep, after the lattice's own contacts (`collide`) and before
// `finalize`. The voxel walks its body's candidate rows (engine_meetlink.wgsl: the coarse pass's pairs) and reads each
// row's distance field in the row's frame: one read gives depth and normal. The lattice's contact rule is applied
// (DECISIONS round 43): the voxel is never pushed out; it is stopped from closing further, by its share; past the
// material's overlap, or hit faster than its crumble speed, the weaker crumbles (`deaths` lays it on the ground with
// its mass). The row moved in the rigid substeps before the lattice's, so across the lattice's substeps it is taken
// along the straight way from where the tick began to where it is (MU.x, MU.y: the share of that way before and after
// this substep): closing is the voxel's move against the row's at that point.
// The reaction goes to the row through its work words, as the pair solver's does (fixed-point atomics: the same sums
// in any order), and is taken at the next tick's start (`integrate`; a sleeper stamped to wake: `compact`). A row's
// velocity does not change while the lattice steps, so each contact takes only a share of the row: its inverse mass
// times the contacts it had last tick (or has had so far this tick, if more) — the sum cannot overshoot — and the row
// takes no more than brings it to the fastest closing among them. Momentum the voxels lose reaches the row or is
// lost; none is made.
// A voxel of a body that is not stepped (still, settling, its parts waiting for their fields) does not move: to a
// row it is a wall, and the row still gets its reaction — that is how a settled part holds what lands on it until its
// own field is baked (engine.ts, the bake queue).
@group(0) @binding(10) var<storage, read_write> listM: array<atomic<u32>>;
@group(0) @binding(53) var<storage, read> sdfData: array<u32>;
// x, y: the share of the tick's way the rows have gone before and after this lattice substep
@group(0) @binding(52) var<uniform> MU: vec4<f32>;

const CW: u32 = 32u;
const MEET_RAD: f32 = 0.5;

fn candF(at: u32) -> f32 { return bitcast<f32>(cand[at]); }
fn cand3(at: u32) -> vec3<f32> { return vec3<f32>(candF(at), candF(at + 1u), candF(at + 2u)); }
fn cand4(at: u32) -> vec4<f32> { return vec4<f32>(candF(at), candF(at + 1u), candF(at + 2u), candF(at + 3u)); }

fn mAdd(i: u32, v: vec3<f32>) {
  let q = vec3<i32>(round(clamp(v * FPM, vec3<f32>(-2e9), vec3<f32>(2e9))));
  if (q.x != 0) { atomicAdd(&listM[i], bitcast<u32>(q.x)); }
  if (q.y != 0) { atomicAdd(&listM[i + 1u], bitcast<u32>(q.y)); }
  if (q.z != 0) { atomicAdd(&listM[i + 2u], bitcast<u32>(q.z)); }
}

fn mInvInertia(q: vec4<f32>, d: vec3<f32>, o: vec3<f32>, v: vec3<f32>) -> vec3<f32> {
  let b = eqrot(eqinv(q), v);
  let ib = vec3<f32>(d.x * b.x + o.x * b.y + o.y * b.z, o.x * b.x + d.y * b.y + o.z * b.z, o.y * b.x + o.z * b.y + d.z * b.z);
  return eqrot(q, ib);
}

/** the store's field (grad8: a word a voxel, the distance and its unit gradient, all four interpolated) at qc, inside
 *  the hull of the voxel centres: gradient xyz, distance w (voxels). As src/shaders/engine/sdf-fine.wgsl fieldSample. */
fn meetField(base: u32, dims: vec3<u32>, qc: vec3<f32>) -> vec4<f32> {
  let i0 = min(vec3<u32>(qc), dims - vec3<u32>(2u));
  let fr = qc - vec3<f32>(i0);
  let i = base + i0.x + dims.x * (i0.y + dims.y * i0.z);
  let sy = dims.x;
  let sz = dims.x * dims.y;
  let v = mix(
    mix(mix(unpack4x8snorm(sdfData[i]), unpack4x8snorm(sdfData[i + 1u]), fr.x), mix(unpack4x8snorm(sdfData[i + sy]), unpack4x8snorm(sdfData[i + sy + 1u]), fr.x), fr.y),
    mix(mix(unpack4x8snorm(sdfData[i + sz]), unpack4x8snorm(sdfData[i + sz + 1u]), fr.x), mix(unpack4x8snorm(sdfData[i + sz + sy]), unpack4x8snorm(sdfData[i + sz + sy + 1u]), fr.x), fr.y),
    fr.z,
  );
  return vec4<f32>(v.yzw, v.x * (127.0 / 16.0));
}

@compute @workgroup_size(64)
fn meet(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = pidx(wg.x, li);
  if (i == NONE) { return; }
  let L = latOf(i);
  if (!L.ok || L.state == S_NEW || L.state == S_RELEASE || L.state == S_FREE) { return; }
  var c = cand[L.slot];
  if (c == 0u) { return; }
  let X = px[2u * i];
  // (dead, or crumbling since `collide`)
  if (X.w < 0.0) { return; }
  let live = L.state == S_LIVE;
  let wi = select(0.0, X.w, live);
  var x = X.xyz;
  var p0 = px[2u * i + 1u].xyz;
  if (!live) { p0 = x; }
  let h = EU.k.w;
  let m = matOf(i);
  let crumbleV = pmB(m).w;
  let toughI = pmA(m).x * crumbleV;
  var nsum = vec3<f32>(0.0);
  var fastest = 0.0;
  var dying = false;
  var guard = 0u;
  // (a chain is as long as the body has pairs: the guard is the pairs' room, never a cap of its own)
  while (c != 0u && guard <= EU.n.y) {
    guard++;
    let at = EU.g.y + (c - 1u) * CW;
    c = cand[at];
    let row = cand[at + 1u];
    let mode = cand[at + 2u];
    let x0 = cand3(at + 9u);
    let x1 = cand3(at + 16u);
    let q0 = cand4(at + 12u);
    var q1 = cand4(at + 19u);
    if (dot(q0, q1) < 0.0) { q1 = -q1; }
    let Xn = mix(x0, x1, MU.y);
    let reach = candF(at + 30u) + MEET_RAD;
    let d = x - Xn;
    if (dot(d, d) > reach * reach) { continue; }
    let Qn = normalize(mix(q0, q1, MU.y));
    let voxel = candF(at + 8u);
    let local = eqrot(eqinv(Qn), d);
    // (index space: voxel (i, j, k)'s centre is at (i, j, k))
    let com = cand3(at + 5u);
    let q = local / voxel + com - vec3<f32>(0.5);
    let dims = vec3<u32>(cand[at + 4u] & 0xffu, (cand[at + 4u] >> 8u) & 0xffu, (cand[at + 4u] >> 16u) & 0xffu);
    let hi = vec3<f32>(dims) - vec3<f32>(1.0);
    let ball = MEET_RAD / voxel;
    if (any(q < vec3<f32>(-ball)) || any(q > hi + vec3<f32>(ball))) { continue; }
    let qc = clamp(q, vec3<f32>(0.0), hi);
    let fs = meetField(cand[at + 3u], dims, qc);
    var dist = fs.w;
    var nl: vec3<f32>;
    let gl = length(fs.xyz);
    if (gl > 1e-4) {
      nl = fs.xyz / gl;
    } else {
      let away = qc - (com - vec3<f32>(0.5));
      let al = length(away);
      nl = select(vec3<f32>(0.0, 0.0, 1.0), away / al, al > 1e-4);
    }
    // (past the hull of the voxel centres: the hull's value plus the way out)
    let past = q - qc;
    if (dot(past, past) > 0.0) {
      let v = past + nl * max(dist, 0.0);
      dist = length(v);
      nl = v / max(dist, 1e-6);
    }
    let over = (ball - dist) * voxel;
    if (over <= 0.0) { continue; }
    let n = eqrot(Qn, nl);
    // where the point of the row now under the voxel was a substep ago: closing is the voxel's place then against it
    let Xp = mix(x0, x1, MU.x);
    let Qp = normalize(mix(q0, q1, MU.x));
    let shut = dot(p0 - (Xp + eqrot(Qp, local)), n);
    nsum += n;
    if (mode == 1u) {
      // (the row's hold for the next tick: who touches it, and which way)
      atomicAdd(&listM[rwAt(row) + RW_MT], 1u);
      let qn = vec3<i32>(round(n * 1024.0));
      atomicAdd(&listM[rwAt(row) + RW_MNS], bitcast<u32>(qn.x));
      atomicAdd(&listM[rwAt(row) + RW_MNS + 1u], bitcast<u32>(qn.y));
      atomicAdd(&listM[rwAt(row) + RW_MNS + 2u], bitcast<u32>(qn.z));
    }
    let closing = shut / h;
    let mj = cand[at + 31u];
    let toughJ = pmA(mj).x * pmB(mj).w;
    let weaker = toughI <= toughJ;
    let rb = rwAt(row);
    if (live) {
      if (closing > crumbleV && weaker) { fastest = max(fastest, closing); }
      if (over > G.tune.voxelsCrumbleOverlap) {
        if (weaker) { dying = true; } else if (mode == 1u) { atomicStore(&listM[rb + RW_MX], 1u); }
      }
      fastest = max(fastest, closing * 0.5);
    }
    if (shut <= 0.0) { continue; }
    let invM = candF(at + 23u);
    if (mode == 0u || invM <= 0.0) {
      // (it cannot be moved: the voxel takes the whole stop; a sleeper is told what it would have been given)
      x += n * shut * select(0.0, 1.0, wi > 0.0);
      if (wi > 0.0 && invM > 0.0) {
        atomicAdd(&listM[rb + RW_MP], u32(min(closing / wi, 1e6) * 256.0));
        atomicMax(&listM[rb + RW_MC], bitcast<u32>(closing));
        atomicAdd(&listM[rb + RW_MN], 1u);
      }
      continue;
    }
    let rc = d;
    let rn = cross(rc, n);
    let kB = invM + dot(rn, mInvInertia(Qn, cand3(at + 24u), cand3(at + 27u), rn));
    let k = atomicAdd(&listM[rb + RW_MN], 1u) + 1u;
    let share = f32(max(k, atomicLoad(&listM[rb + RW_MNP])));
    let kS = kB * share;
    x += n * (shut * wi / (wi + kS));
    let J = closing / (wi + kS);
    mAdd(rb + RW_MDV, -n * (J * invM));
    mAdd(rb + RW_MDW, -mInvInertia(Qn, cand3(at + 24u), cand3(at + 27u), rn * J));
    atomicMax(&listM[rb + RW_MC], bitcast<u32>(closing));
  }
  if (!live) { return; }
  if (fastest > crumbleV) {
    let r = f32(hash3(i, EU.g.w, 0x3a7fu) & 0xffffu) / 65536.0;
    if (r < clamp((fastest - crumbleV) / crumbleV, 0.2, 0.6)) { dying = true; }
  }
  if (dying) {
    px[2u * i] = vec4<f32>(x, PV_CRUMBLE);
    return;
  }
  px[2u * i] = vec4<f32>(x, X.w);
  // (`finalize` takes the bounce and the friction from the sum of this substep's contact normals: the rows' beside
  // the ground's and the voxels')
  pw[3u * i + 2u] = vec4<f32>(pw[3u * i + 2u].xyz + nsum, 0.0);
}
