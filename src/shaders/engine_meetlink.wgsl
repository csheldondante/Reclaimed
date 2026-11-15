// ---- deforming voxels meet rigid rows, the broadphase (docs/design/PHYSICS_ENGINE.md "Pieces break pieces") ----------
// A deforming body is in the awake list by its voxels' bounds (engine.wgsl ROW_DEFORM), so the coarse pass pairs it
// with the rigid rows near it like any row: no voxel is hashed against a rigid row. `meetLink` is a thread a pair of
// the tick's list, once a tick, after the rigid substeps (the rows stand where the tick leaves them) and before the
// lattice's: a pair of one deforming body and one rigid row writes a candidate record — all a voxel needs of the row,
// so the lattice's kernel binds no row buffer — and links it into the deforming body's list (its slot's head, then a
// chain through the records: as many candidates as the body has pairs, no room of its own to run out). Two deforming
// bodies meet through the voxel hash (engine_lattice.wgsl), two rigid rows through the pair solver: neither is linked.
// Here too a sleeper is asked to wake: by what the voxels it stopped last tick would have given it, or by the
// deforming body beside it moving (the pair solver's rule, engine_pairs.wgsl pairPre, for a body with no rigid shape).
//
// cand (u32): a head a deform slot (a pair's index + 1; 0: none — `slots`, engine_deform.wgsl, zeroes it at the
// tick's end), then CW words a pair of the list:
//   [0] the next of its chain (+ 1; 0 the end)   [1] the rigid row   [2] how it takes a push: 0 it cannot be moved
//   (asleep, freed), 1 awake, 2 a sleeper stamped to wake      [3] its field's place in the store's data   [4] the
//   field's padded sides   [5..7] its centre of mass (padded voxels)   [8] cells a voxel   [9..11] its centre when
//   the tick began, [12..15] its rotation then   [16..18] its centre now, [19..22] its rotation   [23] its inverse
//   mass   [24..26] its inverse inertia's diagonal, [27..29] its off-diagonal   [30] its bound radius   [31] its
//   material
@group(0) @binding(10) var<storage, read_write> listA: array<atomic<u32>>;
@group(0) @binding(43) var<storage, read> pairBuf: array<u32>;
@group(0) @binding(51) var<storage, read_write> candA: array<atomic<u32>>;
@group(0) @binding(54) var<storage, read> rowModel: array<u32>;
struct SdfModelRow { fieldBase: u32, dims: u32, sampleBase: u32, sampleCount: u32, com: vec3<f32>, voxel: f32 };
@group(0) @binding(55) var<storage, read> sdfModels: array<SdfModelRow>;

const CW: u32 = 32u;
const PAIR_HEAD: u32 = 64u;

fn putF(at: u32, v: f32) { atomicStore(&candA[at], bitcast<u32>(v)); }
fn put3(at: u32, v: vec3<f32>) {
  putF(at, v.x);
  putF(at + 1u, v.y);
  putF(at + 2u, v.z);
}

@compute @workgroup_size(64)
fn meetLink(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = id.x;
  if (p >= min(pairBuf[0], EU.n.y)) { return; }
  let a = pairBuf[PAIR_HEAD + 2u * p];
  let b = pairBuf[PAIR_HEAD + 2u * p + 1u];
  let da = (rowFlags(a) & (ROW_ALIVE | ROW_DEFORM)) == (ROW_ALIVE | ROW_DEFORM);
  let db = (rowFlags(b) & (ROW_ALIVE | ROW_DEFORM)) == (ROW_ALIVE | ROW_DEFORM);
  if (da == db) { return; }
  let d = select(b, a, da);
  let r = select(a, b, da);
  let fl = rowFlags(r);
  let model = rowModel[r];
  if ((fl & ROW_ALIVE) == 0u || model == NONE) { return; }
  let slot = bitcast<u32>(info[4u * d + 3u].y);
  if (slot >= EU.g.y) { return; }
  let P = pose[4u * r + 2u];
  var mode = 0u;
  let rb = rwAt(r);
  if (P.w > 0.0) {
    if ((fl & ROW_ASLEEP) != 0u) {
      let gt = atomicLoad(&listA[tickAt()]);
      var wake = atomicLoad(&listA[rb + RW_WAKE]) == gt;
      if (!wake) {
        // (what it stopped last tick, taken by whichever of its pairs comes first)
        let mp = f32(atomicExchange(&listA[rb + RW_MP], 0u)) / 256.0;
        let mc = bitcast<f32>(atomicExchange(&listA[rb + RW_MC], 0u));
        atomicStore(&listA[rb + RW_MN], 0u);
        for (var k = RW_MT; k <= RW_MUSED; k++) { atomicStore(&listA[rb + k], 0u); }
        // (the deforming body as one mass moving at its voxels' mean speed: the pair solver's reduced mass)
        let md = max(info[4u * d + 1u].w, 1e-6);
        let sp = vel[2u * d].w;
        let e = max(0.5 * mp * mc, 0.5 * sp * sp / (1.0 / md + P.w));
        if (e * P.w > EU.m.x) {
          for (var k = 0u; k < 6u; k++) { atomicStore(&listA[rb + RW_MDV + k], 0u); }
          atomicStore(&listA[rb + RW_WAKE], gt);
          wake = true;
        }
      }
      if (wake) { mode = 2u; }
    } else if ((fl & (ROW_EXPAND | ROW_DEFORM)) == 0u) {
      mode = 1u;
    }
  }
  let m = sdfModels[model];
  let c = EU.g.y + p * CW;
  atomicStore(&candA[c + 1u], r);
  atomicStore(&candA[c + 2u], mode);
  atomicStore(&candA[c + 3u], m.fieldBase);
  atomicStore(&candA[c + 4u], m.dims);
  put3(c + 5u, m.com);
  putF(c + 8u, m.voxel);
  let Q = pose[4u * r + 3u];
  var P0 = pose[4u * r].xyz;
  var Q0 = pose[4u * r + 1u];
  // (a row not moved by the solver this tick stood still: a sleeper's first pose word is its ground's)
  if (mode != 1u) {
    P0 = P.xyz;
    Q0 = Q;
  }
  put3(c + 9u, P0);
  put3(c + 12u, Q0.xyz);
  putF(c + 15u, Q0.w);
  put3(c + 16u, P.xyz);
  put3(c + 19u, Q.xyz);
  putF(c + 22u, Q.w);
  putF(c + 23u, max(P.w, 0.0));
  put3(c + 24u, info[4u * r].xyz);
  put3(c + 27u, info[4u * r + 1u].xyz);
  putF(c + 30u, vel[2u * r + 1u].w);
  atomicStore(&candA[c + 31u], bitcast<u32>(info[4u * r + 2u].z) & 0xffu);
  atomicStore(&candA[c], atomicExchange(&candA[slot], p + 1u));
}
