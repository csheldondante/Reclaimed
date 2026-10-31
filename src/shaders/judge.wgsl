// ---- judge.wgsl: judge B, the method of sections on the GPU (round 120, `?judge=sections`) --------------------------
// The user (round 120): "average unsupported column mass to get a center of mass first. Then you flood fill in from
// the supports and for each step compute total support each point can provide to that center of mass and if it's
// less than the amount needed the whole piece comes down." Self-contained (no common.wgsl): its own params, the
// world's chunk table and slots read in place (layers.wgsl's addressing), its own material table. Host: game/judge.ts
// (SectionsJudge). docs/ARCHITECTURE.md "The collapse judges" has the contract; DEVLOG round 120 the why.
//
// Nodes are the columns' runs (fracture.ts columnRuns: touching intervals of matter), the same as judge A's. Kernels:
//   build      a thread a window column: its runs → nodes (mass, first moment in z, side-holding extent, strength)
//   adjacency  a thread a node: which runs of each neighbouring column it is joined to (fracture.ts `joined`)
//   judge1     ONE workgroup of 256: the flood and the pieces (phases 1-2)
//   faces      a thread a hanging run: its faces to the runs a step nearer, summed once
//   judge2     ONE workgroup of 256: the rest (phases 4-9). Every phase a parallel loop over a compact list, phases
//              separated by barriers, so the judge is one compute pass with no CPU in between:
//     1 flood        distance from what holds (standing runs, the map's or window's edge) by lateral hops, frontier
//                    by frontier: the runs laid out by level as they're found
//     2 pieces       connected components of the hanging runs (union-find, min-id roots)
//     4 sections     from the far end in, ONE PASS A LEVEL: the component of everything ≥ k out (union-find grown a
//                    level at a time, its mass and first moments carried from the level before: each run added once)
//                    and its section — the faces to the runs k − 1 out — checked: shear (carried weight on the faces'
//                    area) and moment (weight × lever to the centre of mass beyond, on strength × section modulus).
//                    A section held from opposite sides (the floods from two supports meet: the faces' normals
//                    cancel) is in compression: not bent, its piece judged by its thrust line (5)
//     5 thrust       Heyman's safe theorem, discretely: a uniform-load funicular (a parabola, along the span's axis, or
//                    radial for a dome) from the springings must fit inside every run of the piece; its thrust on the
//                    crown section within the crushing strength
//     6 release      a reachability flood from what holds that doesn't cross a failed section: what's left is freed
//     7 freed        the freed runs' connected components: the pieces
//     8 neck         a piece that held is weighed on the standing columns under it (fracture.ts neck): the horizontal
//                    section at its lowest point — tipping (its centre of mass past that section's hull), the far
//                    side's pull (bending), crushing
//     9 output       records for the host: freed runs (their slots copied: no CPU copy of the columns needed)

struct Params {
  ox: u32, oy: u32, ww: u32, wh: u32,
  mapW: u32, mapH: u32, chunksX: u32, chunkSize: u32,
  ncap: u32, kr: u32, outCap: u32, flags: u32,
  tensile: f32, shear: f32, crush: f32, tipGive: f32,
  meet: f32, archTol: f32, neckR: u32, minBody: f32,
  overlap: f32, filmGap: f32, maxLevels: u32, stopAt: u32,
  /** the pairs' capacity (a run at each of its levels); mode 1: the sections all levels at once (pairs), 0: a pass a
   *  level (the oracle) */
  pcap: u32, mode: u32, pad1: u32, pad2: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> slots: array<vec4<u32>>;
/** per material: state, strength, density, 1 = never gives (span Infinity) */
@group(0) @binding(3) var<storage, read> MT: array<vec4<f32>>;
/** per window column: bit 0 seeded (a seed column or beside one), bit 1 weighed (an edit cut it) */
@group(0) @binding(4) var<storage, read> colMask: array<u32>;
@group(0) @binding(5) var<storage, read_write> W: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> O: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> N: array<u32>;
/** (judge1 writes) the pair kernels' indirect dispatch: x the judged runs / 64, y the deepest level */
@group(0) @binding(8) var<storage, read_write> IND: array<u32>;

const NONE: u32 = 0xffffffffu;
const INF_D: u32 = 0x7fffffffu;
const FINF: u32 = 0x7f800000u;
const ROW_H: f32 = 0.8660254;
const EDGE: f32 = 0.57735027;
const ST_EMPTY: u32 = 0u;
const ST_SOLID: u32 = 1u;
const ST_LIQUID: u32 = 3u;
const ST_VEG: u32 = 4u;

// node flags
const NF_STANDS: u32 = 1u;
const NF_SOLID: u32 = 2u;
const NF_BED: u32 = 4u;
const NF_MAPEDGE: u32 = 8u;
const NF_WINEDGE: u32 = 16u;
const NF_SEEDED: u32 = 32u;
const NF_WEIGHED: u32 = 64u;
const NF_SIDE: u32 = 128u;
// piece flags (at a piece's root)
const PF_SEEDED: u32 = 1u;
const PF_WEIGHED: u32 = 2u;
const PF_REACHED: u32 = 4u;
const PF_FAILED: u32 = 8u;
const PF_KEYED: u32 = 16u;
const PF_NECKFAIL: u32 = 32u;
const PF_ARCHFAIL: u32 = 64u;
// failure kinds (F_KIND at the failed root)
const K_SHEAR: u32 = 1u;
const K_BEND: u32 = 2u;
const K_ARCH: u32 = 3u;
const K_ARCHCRUSH: u32 = 4u;
const K_TIP: u32 = 5u;
const K_LEAN: u32 = 6u;
const K_CRUSH: u32 = 7u;

// the nodes' own numbers (N: written by build and adjacency, read by judge — plain loads), each an array of P.ncap
const N_COL: u32 = 0u;
const N_Z0: u32 = 1u;
const N_Z1: u32 = 2u;
const N_SH0: u32 = 3u;
const N_SH1: u32 = 4u;
const N_MASS: u32 = 5u;
const N_MZ: u32 = 6u;
const N_STR: u32 = 7u;
const N_FLAGS: u32 = 8u;
const N_ADJ: u32 = 9u; // 3 words
const N_EFL: u32 = 12u;
const N_SL0: u32 = 13u;
const N_SLN: u32 = 14u;
const N_DIST: u32 = 15u;
const N_PIECE: u32 = 16u;
const N_ROOT: u32 = 17u;
// (the faces kernel's) a run's faces to the runs a step nearer: their unprojected sums (A0, A0x, A0y, Nx, Ny, Txx,
// Txy, Tyy, Zb), the weakest strength, never-gives; then per direction d (6): Σh, Σh·zc, Σ(h³/12 + h·zc²), zmin, zmax
const N_FU: u32 = 23u; // 9
const N_FSTR: u32 = 32u;
const N_FINF: u32 = 33u;
const N_FD: u32 = 34u; // 30
const N_PBASE: u32 = 64u;
const N_ORDER2: u32 = 65u;
const F_SEEDL: u32 = 66u; // (in N) the runs of the seeded pieces (all of them with P.pad1 = 1)
const NN: u32 = 67u;
// the judge's work (W: atomics), each an array of P.ncap words (fi)
const F_DYN: u32 = 0u;
const F_DIST: u32 = 12u;
const F_PC: u32 = 13u;
const F_LV: u32 = 14u;
const F_FR: u32 = 15u;
const F_AM: u32 = 16u;
const F_AX: u32 = 17u;
const F_AY: u32 = 18u;
const F_AZ: u32 = 19u;
const F_A0: u32 = 20u;
const F_A0X: u32 = 21u;
const F_A0Y: u32 = 22u;
const F_NX: u32 = 23u;
const F_NY: u32 = 24u;
const F_TXX: u32 = 25u;
const F_TXY: u32 = 26u;
const F_TYY: u32 = 27u;
const F_ZB: u32 = 28u;
const F_INF: u32 = 29u;
const F_SSTR: u32 = 30u;
const F_AP: u32 = 31u;
const F_APZ: u32 = 32u;
const F_IP: u32 = 33u;
const F_ZMIN: u32 = 34u;
const F_ZMAX: u32 = 35u;
const F_CUT: u32 = 36u;
const F_PF: u32 = 37u;
const F_REACH: u32 = 38u;
const F_FAIL: u32 = 39u;
const F_PIVX: u32 = 40u;
const F_PIVY: u32 = 41u;
const F_PIVZ: u32 = 42u;
const F_AXX: u32 = 43u;
const F_AXY: u32 = 44u;
const F_NECK: u32 = 45u;
const F_HOP: u32 = 46u;
const F_ZC: u32 = 47u;
const F_OUT: u32 = 48u;
const F_MINK: u32 = 49u;
const F_TIPSRC: u32 = 50u;
const F_ORDER: u32 = 18u; // (in N)
const F_HANG: u32 = 19u; // (in N)
const F_ROOTS: u32 = 20u; // (in N)
const F_ROOTS2: u32 = 21u; // (in N)
const F_NECKL: u32 = 55u;
const F_KIND: u32 = 56u;
const F_SLOT: u32 = 22u; // (in N)
const F_VOL: u32 = 59u;
const F_RAD: u32 = 60u;
// (the neck's sums at a piece's root: the leg's mass above zc and its moments, its area and middle, its weakest
// strength, its second moment across the lever and reach, its hull's reach in 24 directions and along the lever)
const F_KM: u32 = 61u;
const F_KMX: u32 = 62u;
const F_KMY: u32 = 63u;
const F_KA: u32 = 64u;
const F_KCX: u32 = 65u;
const F_KCY: u32 = 66u;
const F_KS: u32 = 67u;
const F_KI: u32 = 68u;
const F_KC: u32 = 69u;
const F_SUPU: u32 = 70u;
const F_SUP: u32 = 71u; // 24
const F_DEAD: u32 = 95u;
const NFIELDS: u32 = 96u;
// counters (after the fields and the two per-column arrays)
const C_NODES: u32 = 0u;
const C_HANG: u32 = 1u;
const C_MAXD: u32 = 2u;
const C_CHANGED: u32 = 3u;
const C_ROOTS: u32 = 4u;
const C_ROOTS2: u32 = 5u;
const C_NECK: u32 = 6u;
const C_OVER: u32 = 7u;
const C_LIST: u32 = 8u;
const C_MAXD2: u32 = 9u;
const C_PAIRS: u32 = 10u;
const C_H2: u32 = 11u;
const C_PROOTS: u32 = 12u;
const C_SEEDN: u32 = 13u;
const NCOUNT: u32 = 16u;
// the output's header: counts, then why (fracture.ts Fracture.why), then pieces (8 words each), then records
const O_RECW: u32 = 0u;
const O_PIECES: u32 = 1u;
const O_OVER: u32 = 2u;
const O_WHY: u32 = 4u; // free, load(shear), bend, arch, crush, tip, lean, weighed, keyed, crumbs (×1000), sections
const O_TIME: u32 = 16u;
const O_PIECE0: u32 = 32u;
const MAX_PIECES: u32 = 1024u;
const PIECE_W: u32 = 8u;
const O_REC0: u32 = 32u + 1024u * 8u;

var<private> DOFF_E: array<vec2<i32>, 6> = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(-1, -1), vec2<i32>(-1, 1), vec2<i32>(0, -1));
var<private> DOFF_O: array<vec2<i32>, 6> = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(1, 1), vec2<i32>(0, -1), vec2<i32>(0, 1), vec2<i32>(1, -1));
var<private> DIRV: array<vec2<f32>, 6> = array<vec2<f32>, 6>(vec2<f32>(1.0, 0.0), vec2<f32>(-1.0, 0.0), vec2<f32>(0.5, ROW_H), vec2<f32>(-0.5, -ROW_H), vec2<f32>(-0.5, ROW_H), vec2<f32>(0.5, -ROW_H));

fn fi(f: u32, n: u32) -> u32 { return f * P.ncap + n; }
fn colArr(a: u32, c: u32) -> u32 { return NN * P.ncap + a * P.ww * P.wh + c; }
fn cnt(c: u32) -> u32 { return NFIELDS * P.ncap + c; }
fn lvl(k: u32) -> u32 { return cnt(NCOUNT) + k; }
fn lvlCur(k: u32) -> u32 { return cnt(NCOUNT) + P.maxLevels + 2u + k; }
/** the judged runs' levels (ORDER2: level k's at [lvl2(k), lvl2(k + 1))) */
fn lvl2(k: u32) -> u32 { return cnt(NCOUNT) + 2u * (P.maxLevels + 2u) + k; }
// ---- the pairs: a run at each of its levels, (v, k) for 1 ≤ k ≤ dist(v) — the component of everything ≥ k out that
// v is in is the pairs' connected component at level k. Their fields in W after the levels (pf) ----
const P_PAR: u32 = 0u;
const P_NODE: u32 = 1u;
const P_RT: u32 = 2u;
const P_M: u32 = 3u; // 4: mass, its first moments
const P_U: u32 = 7u; // 9: the faces' unprojected sums (faces' N_FU)
const P_D: u32 = 16u; // 30: per direction Σh, Σh·zc, Σ(h³/12 + h·zc²), zmin, zmax
const P_STR: u32 = 46u;
const P_INF: u32 = 47u;
const P_KIND: u32 = 48u;
const P_PIVX: u32 = 49u;
const P_PIVY: u32 = 50u;
const P_PIVZ: u32 = 51u;
const P_AXX: u32 = 52u;
const P_AXY: u32 = 53u;
const P_LIST: u32 = 54u;
const NPF: u32 = 55u;
fn pw(f: u32, q: u32) -> u32 { return cnt(NCOUNT) + 3u * (P.maxLevels + 2u) + f * P.pcap + q; }
/** run v's pair at level k */
fn pairOf(v: u32, k: u32) -> u32 { return nu(N_PBASE, v) + k - 1u; }

fn nu(f: u32, n: u32) -> u32 { return N[f * P.ncap + n]; }
fn nf(f: u32, n: u32) -> f32 { return bitcast<f32>(N[f * P.ncap + n]); }
fn nst(f: u32, n: u32, v: u32) { N[f * P.ncap + n] = v; }
fn ld(i: u32) -> u32 { return atomicLoad(&W[i]); }
fn st(i: u32, v: u32) { atomicStore(&W[i], v); }
fn ldf(i: u32) -> f32 { return bitcast<f32>(atomicLoad(&W[i])); }
fn stf(i: u32, v: f32) { atomicStore(&W[i], bitcast<u32>(v)); }
fn addf(i: u32, v: f32) {
  if (v == 0.0) { return; }
  var old = atomicLoad(&W[i]);
  loop {
    let r = atomicCompareExchangeWeak(&W[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}
/** (non-negative floats order as their bits) */
fn minf(i: u32, v: f32) { atomicMin(&W[i], bitcast<u32>(max(v, 0.0))); }
fn maxf(i: u32, v: f32) { atomicMax(&W[i], bitcast<u32>(max(v, 0.0))); }
fn oadd(i: u32, v: u32) { atomicAdd(&O[i], v); }

/** world cell (x, y) of window column c */
fn colXY(c: u32) -> vec2<i32> { return vec2<i32>(i32(P.ox + c % P.ww), i32(P.oy + c / P.ww)); }
/** world (x, y) of a cell's centre (lattice.ts cellPos) */
fn cellPos(q: vec2<i32>) -> vec2<f32> { return vec2<f32>(f32(q.x) + 0.5 + 0.5 * f32(q.y & 1), (f32(q.y) + 0.5) * ROW_H); }
fn nbrOf(q: vec2<i32>, d: u32) -> vec2<i32> {
  if ((q.y & 1) == 0) { return q + DOFF_E[d]; }
  return q + DOFF_O[d];
}
/** window column of world cell q (NONE: off the window) */
fn winCol(q: vec2<i32>) -> u32 {
  let x = q.x - i32(P.ox);
  let y = q.y - i32(P.oy);
  if (x < 0 || y < 0 || x >= i32(P.ww) || y >= i32(P.wh)) { return NONE; }
  return u32(y) * P.ww + u32(x);
}
fn onMap(q: vec2<i32>) -> bool { return q.x >= 0 && q.y >= 0 && q.x < i32(P.mapW) && q.y < i32(P.mapH); }

fn isMatter(m: u32) -> bool {
  let s = u32(MT[m].x);
  return s != ST_EMPTY && s != ST_LIQUID;
}
fn sideHolds(m: u32) -> bool {
  let s = u32(MT[m].x);
  return s == ST_SOLID || s == ST_VEG;
}

// ---- build: a thread a window column -------------------------------------------------------------------------------
@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= P.ww * P.wh) { return; }
  let q = colXY(c);
  let cs = P.chunkSize;
  let ch = chunks[(u32(q.y) / cs) * P.chunksX + u32(q.x) / cs];
  let base = ch.x + ((u32(q.y) % cs) * cs + (u32(q.x) % cs)) * ch.y;
  let k = ch.y;
  // count the runs (fracture.ts columnRuns: touching intervals of matter, films FILM_GAP apart touch)
  var n = 0u;
  var open = false;
  var top = 0.0;
  for (var s = 0u; s < k; s++) {
    let v = slots[base + s];
    if (v.y == 0u) { break; }
    if (!isMatter(v.z & 0xffu)) { open = false; continue; }
    let z0 = bitcast<f32>(v.x);
    let z1 = bitcast<f32>(v.y);
    if (!open || z0 > top + P.filmGap) { n++; top = z1; } else { top = max(top, z1); }
    open = true;
  }
  let id0 = atomicAdd(&W[cnt(C_NODES)], n);
  N[colArr(0u, c)] = id0;
  N[colArr(1u, c)] = n;
  if (id0 + n > P.ncap) { st(cnt(C_OVER), 1u); return; }
  let cm = colMask[c];
  var r = 0u;
  open = false;
  top = 0.0;
  // the run being summed
  var rz0 = 0.0;
  var rz1 = 0.0;
  var sh0 = 1e9;
  var sh1 = -1e9;
  var mass = 0.0;
  var mz = 0.0;
  var str = 1e9;
  var fl = 0u;
  var sl0 = 0u;
  var sln = 0u;
  for (var s = 0u; s <= k; s++) {
    var v = vec4<u32>(0u, 0u, 0u, 0u);
    if (s < k) { v = slots[base + s]; }
    let m = v.z & 0xffu;
    let matter = v.y != 0u && isMatter(m);
    let z0 = bitcast<f32>(v.x);
    let z1 = bitcast<f32>(v.y);
    let starts = matter && (!open || z0 > top + P.filmGap);
    // a run ends: written out
    if (open && (!matter || starts)) {
      let id = id0 + r;
      r++;
      N[id] = c;
      N[N_Z0 * P.ncap + id] = bitcast<u32>(rz0);
      N[N_Z1 * P.ncap + id] = bitcast<u32>(rz1);
      N[N_SH0 * P.ncap + id] = bitcast<u32>(sh0);
      N[N_SH1 * P.ncap + id] = bitcast<u32>(sh1);
      N[N_MASS * P.ncap + id] = bitcast<u32>(mass);
      N[N_MZ * P.ncap + id] = bitcast<u32>(mz);
      N[N_STR * P.ncap + id] = bitcast<u32>(str);
      N[N_FLAGS * P.ncap + id] = fl;
      N[N_SL0 * P.ncap + id] = sl0;
      N[N_SLN * P.ncap + id] = sln;
      open = false;
    }
    if (v.y == 0u) { break; }
    if (!matter) { continue; }
    if (starts) {
      rz0 = z0;
      rz1 = z1;
      sh0 = 1e9;
      sh1 = -1e9;
      mass = 0.0;
      mz = 0.0;
      str = 1e9;
      fl = 0u;
      if (z0 < 1e-3) { fl |= NF_STANDS; }
      if ((cm & 1u) != 0u) { fl |= NF_SEEDED; }
      if ((cm & 2u) != 0u) { fl |= NF_WEIGHED; }
      sl0 = base + s;
      top = z1;
    }
    open = true;
    top = max(top, z1);
    rz1 = max(rz1, z1);
    sln = base + s + 1u - sl0;
    let mt = MT[m];
    // (a column is a hex prism √3/2 m² across: its mass in tonnes of rock of density 1 a cubic metre)
    let dm = max(z1 - z0, 0.0) * mt.z * ROW_H;
    mass += dm;
    mz += dm * 0.5 * (z0 + z1);
    if (u32(mt.x) == ST_SOLID) { fl |= NF_SOLID; }
    if (sideHolds(m)) {
      fl |= NF_SIDE;
      sh0 = min(sh0, z0);
      sh1 = max(sh1, z1);
      str = min(str, mt.y);
      if (mt.w > 0.5) { fl |= NF_BED; }
    }
  }
}

/** do runs a and b (neighbouring columns) hold each other: side-holding extents touching (fracture.ts touch) */
fn joinedNodes(a: u32, b: u32) -> bool {
  let fa = nu(N_FLAGS, a);
  let fb = nu(N_FLAGS, b);
  if ((fa & fb & NF_SIDE) == 0u) { return false; }
  let a0 = nf(N_SH0, a);
  let a1 = nf(N_SH1, a);
  let b0 = nf(N_SH0, b);
  let b1 = nf(N_SH1, b);
  let o = min(a1, b1) - max(a0, b0);
  return o > 1e-3 && o >= min(P.overlap, 0.5 * min(a1 - a0, b1 - b0));
}

// ---- adjacency: a thread a node ------------------------------------------------------------------------------------
@compute @workgroup_size(64)
fn adjacency(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let n = min(ld(cnt(C_NODES)), P.ncap);
  if (i >= n) { return; }
  let c = nu(N_COL, i);
  let q = colXY(c);
  var efl = 0u;
  var adj = array<u32, 3>(0u, 0u, 0u);
  for (var d = 0u; d < 6u; d++) {
    let nq = nbrOf(q, d);
    if (!onMap(nq)) { efl |= NF_MAPEDGE; continue; }
    let nc = winCol(nq);
    if (nc == NONE) { efl |= NF_WINEDGE; continue; }
    let b = N[colArr(0u, nc)];
    let bn = N[colArr(1u, nc)];
    var mask = 0u;
    for (var r = 0u; r < min(bn, 16u); r++) {
      if (b + r < P.ncap && joinedNodes(i, b + r)) { mask |= 1u << r; }
    }
    adj[d / 2u] |= mask << (16u * (d % 2u));
  }
  for (var w = 0u; w < 3u; w++) { N[(N_ADJ + w) * P.ncap + i] = adj[w]; }
  N[N_EFL * P.ncap + i] = efl;
  let fl = nu(N_FLAGS, i);
  let stands = (fl & NF_STANDS) != 0u;
  st(fi(F_DIST, i), select(INF_D, 0u, stands));
  N[N_DIST * P.ncap + i] = select(INF_D, 0u, stands);
  st(fi(F_PC, i), i);
  st(fi(F_LV, i), i);
  st(fi(F_FR, i), i);
  st(fi(F_NECK, i), NONE);
  st(fi(F_ZC, i), FINF);
  st(fi(F_TIPSRC, i), NONE);
  st(fi(F_MINK, i), INF_D);
  st(fi(F_OUT, i), NONE);
  // the hanging runs (holding something sideways: what joins at all)
  if (!stands && (fl & NF_SIDE) != 0u) {
    let h = atomicAdd(&W[cnt(C_HANG)], 1u);
    nst(F_HANG, h, i);
  }
}

/** the joined neighbours of node i: direction d's column's first node and its mask */
fn nbrBase(i: u32, d: u32) -> vec2<u32> {
  let mask = (nu(N_ADJ + d / 2u, i) >> (16u * (d % 2u))) & 0xffffu;
  if (mask == 0u) { return vec2<u32>(0u, 0u); }
  let nc = winCol(nbrOf(colXY(nu(N_COL, i)), d));
  return vec2<u32>(N[colArr(0u, nc)], mask);
}
fn standsN(j: u32) -> bool { return (nu(N_FLAGS, j) & NF_STANDS) != 0u; }
fn edgeHeld(i: u32) -> bool { return nu(N_EFL, i) != 0u; }

/** compare-and-swap that only fails when the word isn't `expect` (the weak one may fail spuriously) */
fn cas(i: u32, expect: u32, v: u32) -> bool {
  loop {
    let r = atomicCompareExchangeWeak(&W[i], expect, v);
    if (r.exchanged) { return true; }
    if (r.old_value != expect) { return false; }
  }
}

fn find(f: u32, x: u32) -> u32 { return findAt(f * P.ncap, x); }
fn unite(f: u32, a: u32, b: u32) { uniteAt(f * P.ncap, a, b); }
fn findAt(base: u32, x: u32) -> u32 {
  var r = x;
  loop {
    let p = ld(base + r);
    if (p == r) { break; }
    // (path halving)
    let gp = ld(base + p);
    _ = atomicCompareExchangeWeak(&W[base + r], p, gp);
    r = p;
  }
  return r;
}
/** union by hooking the larger root under the smaller: a component's root is its least id */
fn uniteAt(base: u32, a: u32, b: u32) {
  var x = a;
  var y = b;
  loop {
    x = findAt(base, x);
    y = findAt(base, y);
    if (x == y) { return; }
    if (x < y) { let t = x; x = y; y = t; }
    let r = atomicCompareExchangeWeak(&W[base + x], x, y);
    if (r.exchanged) { return; }
  }
}

var<workgroup> wgA: atomic<u32>;
var<workgroup> wgU: u32;
var<workgroup> wgL: array<u32, 4>;

/** a value every invocation agrees on (thread 0's read of a counter) */
fn uniformCount(i: u32) -> u32 {
  workgroupBarrier();
  storageBarrier();
  return workgroupUniformLoad(&wgL[i]);
}

fn hangN() -> u32 { return min(ld(cnt(C_HANG)), P.ncap); }
fn seedN() -> u32 { return min(ld(cnt(C_SEEDN)), P.ncap); }

/** the projected section's numbers for root r at its level (centroid, lever direction, CoM) */
struct Lever { u: vec2<f32>, L: f32, com: vec2<f32>, cen: vec2<f32>, meet: bool }
fn leverOf(r: u32) -> Lever {
  var o: Lever;
  let M = max(ldf(fi(F_AM, r)), 1e-6);
  o.com = vec2<f32>(ldf(fi(F_AX, r)), ldf(fi(F_AY, r))) / M;
  let A0 = max(ldf(fi(F_A0, r)), 1e-6);
  o.cen = vec2<f32>(ldf(fi(F_A0X, r)), ldf(fi(F_A0Y, r))) / A0;
  let v = o.com - o.cen;
  o.L = length(v);
  o.u = select(vec2<f32>(1.0, 0.0), v / max(o.L, 1e-6), o.L > 1e-4);
  let N = vec2<f32>(ldf(fi(F_NX, r)), ldf(fi(F_NY, r)));
  o.meet = length(N) < P.meet * A0;
  return o;
}

/** the hex cell's support (how far it reaches from its centre) in unit direction n: pointy-top, flats 1 apart */
fn hexReach(n: vec2<f32>) -> f32 {
  var m = 0.0;
  for (var k = 0u; k < 6u; k++) {
    let a = 1.5707963 + f32(k) * 1.0471976;
    m = max(m, dot(n, vec2<f32>(cos(a), sin(a)) * EDGE));
  }
  return m;
}

// ---- the workgroup's sums: a slot a root (WSLOTS of them; a root past them sums on storage), 16 fields a slot ----
const WSLOTS: u32 = 128u;
var<workgroup> wacc: array<atomic<u32>, 2048>;
fn waddf(i: u32, v: f32) {
  var old = atomicLoad(&wacc[i]);
  loop {
    let r = atomicCompareExchangeWeak(&wacc[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}
/** a thread's sums for root r (n of them, the fields from f0 on) into its slot's fields from g0 on, or onto storage */
fn put(r: u32, acc: ptr<function, array<f32, 9>>, n: u32, f0: u32, g0: u32) {
  if (r == NONE) { return; }
  let slot = nu(F_SLOT, r);
  for (var q = 0u; q < n; q++) {
    let v = (*acc)[q];
    if (v == 0.0) { continue; }
    if (slot < WSLOTS) { waddf((g0 + q) * WSLOTS + slot, v); } else { addf(fi(f0 + q, r), v); }
    (*acc)[q] = 0.0;
  }
}
/** every slot's sums (n fields from g0) onto its root's fields (from f0); a barrier after (the caller's before) */
fn wflush(list: u32, nNew: u32, n: u32, f0: u32, g0: u32) {
  for (var t = wgLid; t < min(nNew, WSLOTS); t += 256u) {
    let r = nu(list, t);
    for (var q = 0u; q < n; q++) {
      let v = bitcast<f32>(atomicLoad(&wacc[(g0 + q) * WSLOTS + t]));
      if (v != 0.0) { addf(fi(f0 + q, r), v); }
    }
  }
  workgroupBarrier();
  storageBarrier();
}
var<private> wgLid: u32;

// ---- judge: one workgroup ------------------------------------------------------------------------------------------
// ---- pieces, pieceFlags: a thread a hanging run (the whole GPU; union-find is lock-free) ----
// 1 — pieces first: the hanging runs' connected components, and which a cut could have weakened (seeded: a solid
// run in a seed column or beside one). Round 120, the user's local culling: only those are flooded and judged —
// exact, not a radius: a piece's verdict depends on its own runs, what holds them and (the neck) the standing runs
// within TUNE.judgeB.neck columns, nothing farther (P.pad1 = 1 judges every piece: the whole-window reference)
@compute @workgroup_size(64)
fn pieces(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= hangN()) { return; }
  {
    let i = nu(F_HANG, t);
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var r = 0u; r < 16u; r++) {
        if ((nb.y & (1u << r)) == 0u) { continue; }
        let j = nb.x + r;
        if (!standsN(j) && j < i) { unite(F_PC, i, j); }
      }
    }
  }
}

@compute @workgroup_size(64)
fn pieceFlags(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= hangN()) { return; }
  {
    let i = nu(F_HANG, t);
    let p = find(F_PC, i);
    N[N_PIECE * P.ncap + i] = p;
    // (weighed: an edit cut its column, or the column of a standing run holding it)
    var wByHolder = false;
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var r = 0u; r < 16u; r++) {
        if ((nb.y & (1u << r)) == 0u) { continue; }
        let j = nb.x + r;
        if (standsN(j) && (nu(N_FLAGS, j) & NF_WEIGHED) != 0u) { wByHolder = true; }
      }
    }
    if (wByHolder) { st(fi(F_DYN, i), NF_WEIGHED); }
    let fl = nu(N_FLAGS, i) | select(0u, NF_WEIGHED, wByHolder);
    var pf = 0u;
    if ((fl & NF_SEEDED) != 0u && (fl & NF_SOLID) != 0u) { pf |= PF_SEEDED; }
    if ((fl & NF_WEIGHED) != 0u) { pf |= PF_WEIGHED; }
    atomicOr(&W[fi(F_PF, p)], pf);
    minf(fi(F_ZC, p), nf(N_Z0, i));
  }
}


@compute @workgroup_size(256)
fn judge1(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt == 1u) { return; }
  if (lid == 0u) { wgL[0] = hangN(); }
  let H = uniformCount(0u);
  let gW = 256u;

  // (the seeded pieces' runs: every later single-workgroup phase walks these, not the whole window)
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_HANG, t);
    if (P.pad1 != 0u || (ld(fi(F_PF, nu(N_PIECE, i))) & PF_SEEDED) != 0u) { nst(F_SEEDL, atomicAdd(&W[cnt(C_SEEDN)], 1u), i); }
  }
  if (lid == 0u) { st(cnt(C_LIST), 0u); st(lvl(1u), 0u); }
  workgroupBarrier();
  storageBarrier();

  if (P.stopAt == 2u) { return; }
  // 2 — flood: frontier by frontier from what holds (level 1: joined to a standing run, or at an edge) — each run
  // visited once, the levels laid out in order as they're found (F_ORDER: level k at [lvl(k), lvl(k + 1))); only
  // the seeded pieces (a frontier never leaves its piece)
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_HANG, t);
    if (P.pad1 == 0u && (ld(fi(F_PF, nu(N_PIECE, i))) & PF_SEEDED) == 0u) { continue; }
    var held = edgeHeld(i);
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var r = 0u; r < 16u; r++) {
        if ((nb.y & (1u << r)) == 0u) { continue; }
        if (standsN(nb.x + r)) { held = true; }
      }
    }
    if (held) {
      st(fi(F_DIST, i), 1u);
      nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), i);
    }
  }
  workgroupBarrier();
  storageBarrier();
  var loK = 0u;
  var k = 1u;
  loop {
    if (lid == 0u) { wgL[1] = ld(cnt(C_LIST)); }
    let hiK = uniformCount(1u);
    if (hiK == loK) { break; }
    if (k + 2u >= P.maxLevels) {
      if (lid == 0u) { st(cnt(C_OVER), 2u); }
      break;
    }
    if (lid == 0u) { st(lvl(k + 1u), hiK); }
    for (var t = loK + lid; t < hiK; t += gW) {
      let i = nu(F_ORDER, t);
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var r = 0u; r < 16u; r++) {
          if ((nb.y & (1u << r)) == 0u) { continue; }
          let j = nb.x + r;
          if (standsN(j)) { continue; }
          if (cas(fi(F_DIST, j), INF_D, k + 1u)) { nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), j); }
        }
      }
    }
    loK = hiK;
    k++;
    // (every append of this frontier in before the next is counted)
    workgroupBarrier();
    storageBarrier();
  }
  let maxD = k - 1u;
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_HANG, t);
    // (the distances as plain words from here on)
    let d = ld(fi(F_DIST, i));
    N[N_DIST * P.ncap + i] = d;
    if (d < INF_D) { atomicOr(&W[fi(F_PF, nu(N_PIECE, i))], PF_REACHED); }
  }
  workgroupBarrier();
  storageBarrier();
  // the judged runs (a seeded, weighed piece the flood reached: the only ones a verdict can come from), by level
  // again, each given its pairs (a slot a level it reaches)
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_HANG, t);
    let d = nu(N_DIST, i);
    let p = nu(N_PIECE, i);
    if (d == 1u) { nst(N_ROOT, i, p); }
    let pfl = ld(fi(F_PF, p));
    if (d != INF_D && (pfl & (PF_SEEDED | PF_WEIGHED)) == (PF_SEEDED | PF_WEIGHED)) {
      atomicAdd(&W[lvl2(d)], 1u);
      nst(N_PBASE, i, atomicAdd(&W[cnt(C_PAIRS)], d));
    } else {
      nst(N_PBASE, i, NONE);
    }
  }
  workgroupBarrier();
  storageBarrier();
  if (lid == 0u) {
    var sum = 0u;
    for (var k = 0u; k <= maxD + 1u; k++) {
      let c = ld(lvl2(k));
      st(lvl2(k), sum);
      st(lvlCur(k), sum);
      sum += c;
    }
    st(cnt(C_H2), sum);
    // (stats: the window's hanging runs, the judged ones, the deepest level)
    atomicStore(&O[O_TIME], H);
    atomicStore(&O[O_TIME + 1u], sum);
    atomicStore(&O[O_TIME + 2u], maxD);
    atomicStore(&O[O_TIME + 3u], ld(cnt(C_PAIRS)));
    atomicStore(&O[O_TIME + 4u], NONE);
    atomicStore(&O[O_TIME + 5u], NONE);
    if (ld(cnt(C_PAIRS)) > P.pcap && ld(cnt(C_OVER)) == 0u) { st(cnt(C_OVER), 3u); }
    let go = P.mode == 1u && ld(cnt(C_OVER)) == 0u;
    IND[0] = select(0u, (sum + 63u) / 64u, go);
    IND[1] = select(0u, maxD, go);
    IND[2] = 1u;
    // (the checks: a thread a root pair, at most a pair each)
    IND[4] = select(0u, (ld(cnt(C_PAIRS)) + 63u) / 64u, go);
    IND[5] = 1u;
    IND[6] = 1u;
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_HANG, t);
    if (nu(N_PBASE, i) == NONE) { continue; }
    let q = colXY(nu(N_COL, i));
    atomicMin(&O[O_TIME + 4u], u32(q.x));
    atomicMin(&O[O_TIME + 5u], u32(q.y));
    atomicMax(&O[O_TIME + 6u], u32(q.x));
    atomicMax(&O[O_TIME + 7u], u32(q.y));
    nst(N_ORDER2, atomicAdd(&W[lvlCur(nu(N_DIST, i))], 1u), i);
  }

  if (lid == 0u) { st(cnt(C_MAXD2), maxD); }
}

// ---- the pairs (mode 1): every level's sections at once, on the whole GPU — a thread a pair, (x: a run of the
// judged ones ≥ that level, y: the level − 1), dispatched indirectly (IND). Union-find on the pairs (a pair joined to
// the pairs of its joined runs at the same level) is concurrent and lock-free, so a constant number of dispatches
// gives every level's components: no pass a level ----
/** the pair at this invocation: (run, level, pair), or the run NONE */
fn pairAt(gid: vec3<u32>) -> vec3<u32> {
  let k = gid.y + 1u;
  let t = ld(lvl2(k)) + gid.x;
  if (ld(cnt(C_OVER)) != 0u || t >= ld(cnt(C_H2))) { return vec3<u32>(NONE, 0u, 0u); }
  let v = nu(N_ORDER2, t);
  return vec3<u32>(v, k, pairOf(v, k));
}

@compute @workgroup_size(64)
fn pairsInit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  st(pw(P_PAR, a.z), a.z);
  st(pw(P_NODE, a.z), a.x);
  stf(pw(P_STR, a.z), 1e9);
  for (var d = 0u; d < 6u; d++) { stf(pw(P_D + d * 5u + 3u, a.z), 1e9); }
}

@compute @workgroup_size(64)
fn pairsUnite(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  let v = a.x;
  let k = a.y;
  for (var d = 0u; d < 6u; d++) {
    let nb = nbrBase(v, d);
    for (var r = 0u; r < 16u; r++) {
      if ((nb.y & (1u << r)) == 0u) { continue; }
      let j = nb.x + r;
      let dj = nu(N_DIST, j);
      if (j < v && dj >= k && dj != INF_D) { uniteAt(pw(P_PAR, 0u), a.z, pairOf(j, k)); }
    }
  }
}

@compute @workgroup_size(64)
fn pairsFind(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  let r = findAt(pw(P_PAR, 0u), a.z);
  st(pw(P_RT, a.z), r);
  if (r == a.z) { st(pw(P_LIST, atomicAdd(&W[cnt(C_PROOTS)], 1u)), r); }
}

// (a workgroup's masses gathered by root first: a level's pairs lie together, nearly all in one component)
var<workgroup> hk: array<atomic<u32>, 64>;
// (a slot's 32 words: mass and its moments (4), the faces' sums (9), per direction Σh, Σh·zc, ΣI (18))
var<workgroup> hv: array<atomic<u32>, 2048>;
fn haddf(i: u32, v: f32) {
  var old = atomicLoad(&hv[i]);
  loop {
    let r = atomicCompareExchangeWeak(&hv[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}

@compute @workgroup_size(64)
fn pairsSum(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  atomicStore(&hk[lid], NONE);
  for (var q = 0u; q < 32u; q++) { atomicStore(&hv[lid * 32u + q], 0u); }
  workgroupBarrier();
  let a = pairAt(gid);
  if (a.x != NONE) {
    let v = a.x;
    let k = a.y;
    let r = ld(pw(P_RT, a.z));
    let m = nf(N_MASS, v);
    let pos = cellPos(colXY(nu(N_COL, v)));
    let vals = array<f32, 4>(m, m * pos.x, m * pos.y, nf(N_MZ, v));
    var slot = NONE;
    let h = (r * 2654435761u) >> 26u;
    for (var probe = 0u; probe < 8u && slot == NONE; probe++) {
      let sl = (h + probe) & 63u;
      loop {
        let o = atomicCompareExchangeWeak(&hk[sl], NONE, r);
        if (o.exchanged || o.old_value == r) { slot = sl; break; }
        if (o.old_value != NONE) { break; }
      }
    }
    for (var q = 0u; q < 4u; q++) {
      if (slot != NONE) { haddf(slot * 32u + q, vals[q]); } else { addf(pw(P_M + q, r), vals[q]); }
    }
    // the faces: a run's own level only (its faces to the runs a step nearer)
    if (k == nu(N_DIST, v)) {
      for (var q = 0u; q < 9u; q++) {
        let x = nf(N_FU + q, v);
        if (slot != NONE) { haddf(slot * 32u + 4u + q, x); } else { addf(pw(P_U + q, r), x); }
      }
      minf(pw(P_STR, r), nf(N_FSTR, v));
      if (nu(N_FINF, v) != 0u) { st(pw(P_INF, r), 1u); }
      for (var d = 0u; d < 6u; d++) {
        let sh = nf(N_FD + d * 5u, v);
        if (sh <= 0.0) { continue; }
        for (var q = 0u; q < 3u; q++) {
          let x = nf(N_FD + d * 5u + q, v);
          if (slot != NONE) { haddf(slot * 32u + 13u + d * 3u + q, x); } else { addf(pw(P_D + d * 5u + q, r), x); }
        }
        minf(pw(P_D + d * 5u + 3u, r), nf(N_FD + d * 5u + 3u, v));
        maxf(pw(P_D + d * 5u + 4u, r), nf(N_FD + d * 5u + 4u, v));
      }
    }
  }
  workgroupBarrier();
  let key = atomicLoad(&hk[lid]);
  if (key != NONE) {
    for (var q = 0u; q < 13u; q++) {
      let x = bitcast<f32>(atomicLoad(&hv[lid * 32u + q]));
      if (x != 0.0) { addf(pw(select(P_U + q - 4u, P_M + q, q < 4u), key), x); }
    }
    for (var d = 0u; d < 6u; d++) {
      for (var q = 0u; q < 3u; q++) {
        let x = bitcast<f32>(atomicLoad(&hv[lid * 32u + 13u + d * 3u + q]));
        if (x != 0.0) { addf(pw(P_D + d * 5u + q, key), x); }
      }
    }
  }
}

/** a thread a component at a level (a root pair): its section checked, as judge2's level pass does (phase 4 g) */
@compute @workgroup_size(64)
fn checks(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (P.mode != 1u || ld(cnt(C_OVER)) != 0u || gid.x >= ld(cnt(C_PROOTS))) { return; }
  let r = ld(pw(P_LIST, gid.x));
  let v = ld(pw(P_NODE, r));
  let k = r - nu(N_PBASE, v) + 1u;
  let piece = nu(N_PIECE, v);
  let M = ldf(pw(P_M, r));
  let com = vec2<f32>(ldf(pw(P_M + 1u, r)), ldf(pw(P_M + 2u, r))) / max(M, 1e-6);
  let A0 = ldf(pw(P_U, r));
  let cen = vec2<f32>(ldf(pw(P_U + 1u, r)), ldf(pw(P_U + 2u, r))) / max(A0, 1e-6);
  let lvv = com - cen;
  let L = length(lvv);
  let u = select(vec2<f32>(1.0, 0.0), lvv / max(L, 1e-6), L > 1e-4);
  let meet = length(vec2<f32>(ldf(pw(P_U + 3u, r)), ldf(pw(P_U + 4u, r)))) < P.meet * max(A0, 1e-6);
  let inf = ld(pw(P_INF, r)) != 0u;
  // (level 1: the piece's own sums, where the thrust check and the neck read them)
  if (k == 1u) {
    for (var q = 0u; q < 4u; q++) { st(fi(F_AM + q, piece), ld(pw(P_M + q, r))); }
    for (var q = 0u; q < 9u; q++) { st(fi(F_A0 + q, piece), ld(pw(P_U + q, r))); }
    st(fi(F_INF, piece), select(0u, 1u, inf));
    st(fi(F_SSTR, piece), ld(pw(P_STR, r)));
    nst(F_ROOTS, atomicAdd(&W[cnt(C_ROOTS)], 1u), piece);
  }
  if (inf || meet) { return; }
  oadd(O_WHY + 10u, 1u);
  let s = min(ldf(pw(P_STR, r)), 1e3);
  var Ap = 0.0;
  var Apz = 0.0;
  var Ip = 0.0;
  var zlo = 1e9;
  var zhi = 0.0;
  for (var d = 0u; d < 6u; d++) {
    let sh = ldf(pw(P_D + d * 5u, r));
    let w = EDGE * abs(dot(DIRV[d], u));
    if (sh <= 0.0 || w <= 1e-4) { continue; }
    Ap += w * sh;
    Apz += w * ldf(pw(P_D + d * 5u + 1u, r));
    Ip += w * ldf(pw(P_D + d * 5u + 2u, r));
    zlo = min(zlo, ldf(pw(P_D + d * 5u + 3u, r)));
    zhi = max(zhi, ldf(pw(P_D + d * 5u + 4u, r)));
  }
  let As = select(0.6366 * A0, Ap, L > 1e-3);
  var kind = 0u;
  if (M > P.shear * s * As) { kind = K_SHEAR; }
  if (kind == 0u && Ap > 1e-6) {
    let zb = Apz / Ap;
    let I = max(Ip - Ap * zb * zb, 0.0);
    let c = max(zhi - zb, zb - zlo);
    let S = I / max(c, 1e-3);
    if (M * L > P.tensile * s * S) { kind = K_BEND; }
  } else if (kind == 0u && L > 1e-3) { kind = K_BEND; }
  if (kind == 0u) { return; }
  st(pw(P_KIND, r), kind);
  stf(pw(P_PIVX, r), cen.x);
  stf(pw(P_PIVY, r), cen.y);
  stf(pw(P_PIVZ, r), select(zlo, 0.0, zlo >= 1e9));
  stf(pw(P_AXX, r), -u.y);
  stf(pw(P_AXY, r), u.x);
  atomicOr(&W[fi(F_PF, piece)], PF_FAILED);
}

/** a thread a pair: a run in a failed component goes; the runs of a failed section's own level are its cut */
@compute @workgroup_size(64)
fn marks(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  let r = ld(pw(P_RT, a.z));
  if (ld(pw(P_KIND, r)) == 0u) { return; }
  st(fi(F_DEAD, a.x), 1u);
  if (a.y == nu(N_DIST, a.x)) { st(fi(F_CUT, a.x), r + 1u); }
}

// ---- faces: a thread a hanging run — its faces to the runs a step nearer, summed once (the sections read them) -----
@compute @workgroup_size(64)
fn faces(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (P.stopAt == 1u || P.stopAt == 2u || P.stopAt == 3u) { return; }
  let t = gid.x;
  if (t >= hangN()) { return; }
  let i = nu(F_HANG, t);
  let k = nu(N_DIST, i);
  if (k == 0u || k == INF_D) { return; }
  var u = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var dd: array<f32, 30>;
  for (var q = 0u; q < 6u; q++) {
    dd[q * 5u] = 0.0;
    dd[q * 5u + 1u] = 0.0;
    dd[q * 5u + 2u] = 0.0;
    dd[q * 5u + 3u] = 1e9;
    dd[q * 5u + 4u] = 0.0;
  }
  var smin = 1e9;
  var inf = select(0u, 1u, k == 1u && edgeHeld(i));
  let pi = cellPos(colXY(nu(N_COL, i)));
  let a0 = nf(N_SH0, i);
  let a1 = nf(N_SH1, i);
  let si = nf(N_STR, i);
  let bi = (nu(N_FLAGS, i) & NF_BED) != 0u;
  for (var d = 0u; d < 6u; d++) {
    let nb = nbrBase(i, d);
    for (var rr = 0u; rr < 16u; rr++) {
      if ((nb.y & (1u << rr)) == 0u) { continue; }
      let j = nb.x + rr;
      if (nu(N_DIST, j) != k - 1u) { continue; }
      let z0 = max(a0, nf(N_SH0, j));
      let z1 = min(a1, nf(N_SH1, j));
      let h = max(z1 - z0, 0.0);
      let a = EDGE * h;
      let pf = 0.5 * (pi + cellPos(colXY(nu(N_COL, j))));
      let n = DIRV[d];
      u[0] += a;
      u[1] += a * pf.x;
      u[2] += a * pf.y;
      u[3] += a * n.x;
      u[4] += a * n.y;
      u[5] += a * n.x * n.x;
      u[6] += a * n.x * n.y;
      u[7] += a * n.y * n.y;
      u[8] += a * z0;
      smin = min(smin, min(si, nf(N_STR, j)));
      if (bi || (nu(N_FLAGS, j) & NF_BED) != 0u) { inf = 1u; }
      if (h > 0.0) {
        let zc = 0.5 * (z0 + z1);
        dd[d * 5u] += h;
        dd[d * 5u + 1u] += h * zc;
        dd[d * 5u + 2u] += h * h * h / 12.0 + h * zc * zc;
        dd[d * 5u + 3u] = min(dd[d * 5u + 3u], z0);
        dd[d * 5u + 4u] = max(dd[d * 5u + 4u], z1);
      }
    }
  }
  for (var q = 0u; q < 9u; q++) { N[(N_FU + q) * P.ncap + i] = bitcast<u32>(u[q]); }
  N[N_FSTR * P.ncap + i] = bitcast<u32>(smin);
  N[N_FINF * P.ncap + i] = inf;
  for (var q = 0u; q < 30u; q++) { N[(N_FD + q) * P.ncap + i] = bitcast<u32>(dd[q]); }
}

// ---- judge2: one workgroup — the sections, the thrust lines, the release, the pieces out -----------------------------
@compute @workgroup_size(256)
fn judge2(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt >= 1u && P.stopAt <= 4u) { return; }
  if (lid == 0u) { wgL[0] = seedN(); wgL[2] = ld(cnt(C_MAXD2)); }
  let H = uniformCount(0u);
  let maxD = workgroupUniformLoad(&wgL[2]);
  let gW = 256u;
  // 4 — the sections, from the far end in: a pass a level (mode 0, the oracle; mode 1 has done them all at once)
  var nPrev = 0u;
  let levels = select(maxD, 0u, P.mode == 1u);
  for (var k = levels; k >= 1u; k--) {
    let lo = ld(lvl(k));
    let hi = ld(lvl(k + 1u));
    let oldList = select(F_ROOTS2, F_ROOTS, (k & 1u) == 0u);
    let newList = select(F_ROOTS, F_ROOTS2, (k & 1u) == 0u);
    let oldC = select(C_ROOTS2, C_ROOTS, (k & 1u) == 0u);
    let newC = select(C_ROOTS, C_ROOTS2, (k & 1u) == 0u);
    let nOld = select(0u, nPrev, k < levels);
    // a: the level's runs start as their own components, their sums cleared
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      for (var f = F_AM; f <= F_ZMAX; f++) { st(fi(f, i), 0u); }
      st(fi(F_ZMIN, i), FINF);
      stf(fi(F_SSTR, i), 1e9);
    }
    for (var t = lid; t < nOld; t += gW) {
      let r = nu(oldList, t);
      for (var f = F_A0; f <= F_ZMAX; f++) { st(fi(f, r), 0u); }
      st(fi(F_ZMIN, r), FINF);
      stf(fi(F_SSTR, r), 1e9);
    }
    // b: joined to everything ≥ k out
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var r = 0u; r < 16u; r++) {
          if ((nb.y & (1u << r)) == 0u) { continue; }
          let j = nb.x + r;
          let dj = nu(N_DIST, j);
          if (dj >= k && dj < INF_D) { unite(F_LV, i, j); }
        }
      }
    }
    if (lid == 0u) { st(cnt(newC), 0u); }
    workgroupBarrier();
    storageBarrier();
    // d: the roots now (each given a slot of the workgroup's sums: its sections are summed there, not on one word of
    // storage every run of a front contends for)
    for (var t = lid; t < nOld; t += gW) {
      let j = nu(oldList, t);
      if (find(F_LV, j) == j) {
        let q = atomicAdd(&W[cnt(newC)], 1u);
        nst(newList, q, j);
        nst(F_SLOT, j, q);
      }
    }
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      let r = find(F_LV, i);
      N[N_ROOT * P.ncap + i] = r;
      if (r == i) {
        let q = atomicAdd(&W[cnt(newC)], 1u);
        nst(newList, q, i);
        nst(F_SLOT, i, q);
      }
    }
    // (every root listed before the count is read)
    workgroupBarrier();
    storageBarrier();
    if (lid == 0u) { wgL[0] = ld(cnt(newC)); }
    let nNew = uniformCount(0u);
    nPrev = nNew;
    // c: the sums carried — the level's runs their own, a component of the level before into its new root
    {
      var acc = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      var cur = NONE;
      for (var t = lo + lid; t < hi; t += gW) {
        let i = nu(F_ORDER, t);
        let r = nu(N_ROOT, i);
        if (r != cur) { put(cur, &acc, 4u, F_AM, 0u); cur = r; }
        let m = nf(N_MASS, i);
        let p = cellPos(colXY(nu(N_COL, i)));
        acc[0] += m;
        acc[1] += m * p.x;
        acc[2] += m * p.y;
        acc[3] += nf(N_MZ, i);
      }
      put(cur, &acc, 4u, F_AM, 0u);
    }
    for (var t = lid; t < nOld; t += gW) {
      let j = nu(oldList, t);
      let r = find(F_LV, j);
      if (r != j) {
        addf(fi(F_AM, r), ldf(fi(F_AM, j)));
        addf(fi(F_AX, r), ldf(fi(F_AX, j)));
        addf(fi(F_AY, r), ldf(fi(F_AY, j)));
        addf(fi(F_AZ, r), ldf(fi(F_AZ, j)));
      }
    }
    // e: the section, unprojected — the faces from the level's runs to those a step nearer (or what holds them)
    {
      var acc = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      var cur = NONE;
      var smin = 1e9;
      for (var t = lo + lid; t < hi; t += gW) {
        let i = nu(F_ORDER, t);
        let r = nu(N_ROOT, i);
        if (r != cur) {
          put(cur, &acc, 9u, F_A0, 4u);
          if (cur != NONE && smin < 1e9) { minf(fi(F_SSTR, cur), smin); }
          smin = 1e9;
          cur = r;
        }
        for (var q = 0u; q < 9u; q++) { acc[q] += nf(N_FU + q, i); }
        smin = min(smin, nf(N_FSTR, i));
        if (nu(N_FINF, i) != 0u) { st(fi(F_INF, r), 1u); }
      }
      put(cur, &acc, 9u, F_A0, 4u);
      if (cur != NONE && smin < 1e9) { minf(fi(F_SSTR, cur), smin); }
    }
    workgroupBarrier();
    wflush(newList, nNew, 13u, F_AM, 0u);
    // f: the section projected across the lever (a face's width as seen along it), for one held from one side
    {
      var acc = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      var cur = NONE;
      var zlo = 1e9;
      var zhi = 0.0;
      var lv: Lever;
      for (var t = lo + lid; t < hi; t += gW) {
        let i = nu(F_ORDER, t);
        let r = nu(N_ROOT, i);
        if (r != cur) {
          put(cur, &acc, 3u, F_AP, 13u);
          if (cur != NONE && zlo < 1e9) { minf(fi(F_ZMIN, cur), zlo); maxf(fi(F_ZMAX, cur), zhi); }
          zlo = 1e9;
          zhi = 0.0;
          cur = r;
          lv = leverOf(r);
        }
        if (lv.meet) { continue; }
        for (var d = 0u; d < 6u; d++) {
          let sh = nf(N_FD + d * 5u, i);
          let w = EDGE * abs(dot(DIRV[d], lv.u));
          if (sh <= 0.0 || w <= 1e-4) { continue; }
          acc[0] += w * sh;
          acc[1] += w * nf(N_FD + d * 5u + 1u, i);
          acc[2] += w * nf(N_FD + d * 5u + 2u, i);
          zlo = min(zlo, nf(N_FD + d * 5u + 3u, i));
          zhi = max(zhi, nf(N_FD + d * 5u + 4u, i));
        }
      }
      put(cur, &acc, 3u, F_AP, 13u);
      if (cur != NONE && zlo < 1e9) { minf(fi(F_ZMIN, cur), zlo); maxf(fi(F_ZMAX, cur), zhi); }
    }
    workgroupBarrier();
    wflush(newList, nNew, 3u, F_AP, 13u);
    // g: each section checked (only what an edit weakened is weighed: fracture.ts RockOpts.weigh)
    for (var t = lid; t < nNew; t += gW) {
      let r = nu(newList, t);
      let pf = ld(fi(F_PF, nu(N_PIECE, r)));
      if ((pf & (PF_SEEDED | PF_WEIGHED)) != (PF_SEEDED | PF_WEIGHED)) { continue; }
      if (ld(fi(F_INF, r)) != 0u) { continue; }
      let lv = leverOf(r);
      if (lv.meet) { continue; }
      oadd(O_WHY + 10u, 1u);
      let M = ldf(fi(F_AM, r));
      let s = min(ldf(fi(F_SSTR, r)), 1e3);
      let Ap = ldf(fi(F_AP, r));
      let A0 = ldf(fi(F_A0, r));
      // (shear on the faces' area across the lever; with no lever, a face's mean share)
      let As = select(0.6366 * A0, Ap, lv.L > 1e-3);
      var kind = 0u;
      if (M > P.shear * s * As) { kind = K_SHEAR; }
      if (kind == 0u && Ap > 1e-6) {
        let zb = ldf(fi(F_APZ, r)) / Ap;
        let I = max(ldf(fi(F_IP, r)) - Ap * zb * zb, 0.0);
        let c = max(ldf(fi(F_ZMAX, r)) - zb, zb - ldf(fi(F_ZMIN, r)));
        let S = I / max(c, 1e-3);
        if (M * lv.L > P.tensile * s * S) { kind = K_BEND; }
      } else if (kind == 0u && lv.L > 1e-3) { kind = K_BEND; }
      if (kind != 0u) {
        st(fi(F_FAIL, r), k);
        // it hinges where it broke (fracture.ts hingeOf): about the section's foot, the axis across the lever — kept
        // in the pair of the root at this level (as mode 1 keeps it in its root pair)
        let q = pairOf(r, k);
        st(pw(P_KIND, q), kind);
        stf(pw(P_PIVX, q), lv.cen.x);
        stf(pw(P_PIVY, q), lv.cen.y);
        stf(pw(P_PIVZ, q), select(ldf(fi(F_ZMIN, r)), 0.0, ld(fi(F_ZMIN, r)) == FINF));
        stf(pw(P_AXX, q), -lv.u.y);
        stf(pw(P_AXY, q), lv.u.x);
        atomicOr(&W[fi(F_PF, nu(N_PIECE, r))], PF_FAILED);
      }
    }
    workgroupBarrier();
    storageBarrier();
    // h: a failed section's faces cut
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      let r = nu(N_ROOT, i);
      if (ld(fi(F_FAIL, r)) == k) { st(fi(F_CUT, i), pairOf(r, k) + 1u); }
    }
    for (var t = lid; t < WSLOTS * 16u; t += gW) { atomicStore(&wacc[t], 0u); }
    workgroupBarrier();
    storageBarrier();
  }

  if (P.stopAt == 5u) { return; }
  // 5 — the thrust line of the pieces held from opposite sides (the level-1 components that meet)
  if (lid == 0u) { wgL[0] = select(0u, ld(cnt(C_ROOTS)), maxD >= 1u); }
  let nR = uniformCount(0u);
  // (level 1 is odd: its roots are in F_ROOTS) — the span's axis, its springings each side
  for (var t = lid; t < nR; t += gW) {
    let r = nu(F_ROOTS, t);
    st(fi(F_RAD, r), 0u);
    // (F_AP.. reused for a meeting piece: the springings' sums on the + side of the axis, then the parabola's bounds)
    st(fi(F_AP, r), 0u);
    st(fi(F_APZ, r), 0u);
    st(fi(F_IP, r), 0u);
    stf(fi(F_ZMIN, r), 0.0);
    stf(fi(F_ZMAX, r), 1e6);
  }
  workgroupBarrier();
  storageBarrier();
  let lo1 = ld(lvl(1u));
  let hi1 = ld(lvl(2u));
  for (var t = lo1 + lid; t < hi1; t += gW) {
    let i = nu(F_ORDER, t);
    let r = nu(N_ROOT, i);
    let lv = leverOf(r);
    if (!lv.meet) { continue; }
    let ax = archAxis(r);
    let pi = cellPos(colXY(nu(N_COL, i)));
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var rr = 0u; rr < 16u; rr++) {
        if ((nb.y & (1u << rr)) == 0u) { continue; }
        let j = nb.x + rr;
        if (nu(N_DIST, j) != 0u) { continue; }
        let h = max(min(nf(N_SH1, i), nf(N_SH1, j)) - max(nf(N_SH0, i), nf(N_SH0, j)), 0.0);
        let pf = 0.5 * (pi + cellPos(colXY(nu(N_COL, j))));
        addf(fi(F_RAD, r), EDGE * h * length(pf - lv.cen));
        if (dot(DIRV[d], ax.xy) <= 0.0) { continue; }
        addf(fi(F_AP, r), EDGE * h);
        addf(fi(F_APZ, r), EDGE * h * pf.x);
        addf(fi(F_IP, r), EDGE * h * pf.y);
      }
    }
  }
  workgroupBarrier();
  storageBarrier();
  // every run of a meeting piece bounds the parabola's rise: z_s + f q inside [z0, z1] (give archTol)
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    let d = nu(N_DIST, i);
    if (d == 0u || d > maxD) { continue; }
    let r = nu(N_PIECE, i);
    let lv = leverOf(r);
    if (!lv.meet) { continue; }
    let sp = span(r);
    let q = archQ(sp, cellPos(colXY(nu(N_COL, i))));
    if (q <= 0.05) { continue; }
    let lo = (nf(N_Z0, i) - P.archTol - sp.zs) / q;
    let hi = (nf(N_Z1, i) + P.archTol - sp.zs) / q;
    maxf(fi(F_ZMIN, r), lo);
    minf(fi(F_ZMAX, r), hi);
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < nR; t += gW) {
    let r = nu(F_ROOTS, t);
    let lv = leverOf(r);
    if (!lv.meet) { continue; }
    let pf = ld(fi(F_PF, nu(N_PIECE, r)));
    if ((pf & (PF_SEEDED | PF_WEIGHED)) != (PF_SEEDED | PF_WEIGHED) || ld(fi(F_INF, r)) != 0u) { continue; }
    oadd(O_WHY + 10u, 1u);
    let sp = span(r);
    let fLo = ldf(fi(F_ZMIN, r));
    let fHi = ldf(fi(F_ZMAX, r));
    var kind = 0u;
    if (fHi < fLo || fHi < 0.25) { kind = K_ARCH; } else {
      // the least thrust (the highest rise that fits) on the springings' area, each side half the section
      let thrust = ldf(fi(F_AM, r)) * sp.L / (8.0 * fHi);
      let A = 0.5 * ldf(fi(F_A0, r));
      if (thrust > P.crush * min(ldf(fi(F_SSTR, r)), 1e3) * A) { kind = K_ARCHCRUSH; }
    }
    if (kind != 0u) {
      let q = pairOf(r, 1u);
      st(pw(P_KIND, q), kind);
      stf(pw(P_PIVX, q), lv.cen.x);
      stf(pw(P_PIVY, q), lv.cen.y);
      stf(pw(P_PIVZ, q), sp.zs);
      stf(pw(P_AXX, q), 0.0);
      stf(pw(P_AXY, q), 0.0);
      atomicOr(&W[fi(F_PF, r)], PF_FAILED | PF_ARCHFAIL);
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lo1 + lid; t < hi1; t += gW) {
    let i = nu(F_ORDER, t);
    let r = nu(N_PIECE, i);
    if ((ld(fi(F_PF, r)) & PF_ARCHFAIL) != 0u) { st(fi(F_CUT, i), pairOf(r, 1u) + 1u); }
  }
  workgroupBarrier();
  storageBarrier();

}

// ---- judge3: one workgroup — the release (mode 0: a flood that doesn't cross a failed section; mode 1: the marks) ----
@compute @workgroup_size(256)
fn judge3(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt >= 1u && P.stopAt <= 4u) { return; }
  if (lid == 0u) { wgL[0] = seedN(); }
  let H = uniformCount(0u);
  let gW = 256u;
  if (P.stopAt == 6u) { return; }
  // 6 — release: what still reaches what holds without crossing a failed section (frontier by frontier, F_ORDER
  // reused for the frontiers). Mode 1: the same runs, from the marks — a run is cut off from what holds it exactly
  // when a component it's in at some level failed (that component's only ties to what holds it are its section's
  // faces), or its piece's thrust line didn't fit
  if (P.mode == 1u) {
    for (var t = lid; t < H; t += gW) {
      let i = nu(F_SEEDL, t);
      let gone = ld(fi(F_DEAD, i)) != 0u || (ld(fi(F_PF, nu(N_PIECE, i))) & PF_ARCHFAIL) != 0u;
      st(fi(F_REACH, i), select(0u, 1u, nu(N_DIST, i) != INF_D && !gone));
    }
  }
  if (lid == 0u) { st(cnt(C_LIST), 0u); }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (P.mode == 0u && nu(N_DIST, i) == 1u && ld(fi(F_CUT, i)) == 0u) {
      st(fi(F_REACH, i), 1u);
      nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), i);
    }
  }
  workgroupBarrier();
  storageBarrier();
  var lo6 = 0u;
  loop {
    if (lid == 0u) { wgL[1] = ld(cnt(C_LIST)); }
    let hi6 = uniformCount(1u);
    if (hi6 == lo6) { break; }
    for (var t = lo6 + lid; t < hi6; t += gW) {
      let i = nu(F_ORDER, t);
      let di = nu(N_DIST, i);
      let ci = ld(fi(F_CUT, i)) != 0u;
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var rr = 0u; rr < 16u; rr++) {
          if ((nb.y & (1u << rr)) == 0u) { continue; }
          let j = nb.x + rr;
          let dj = nu(N_DIST, j);
          if (dj == 0u || dj == INF_D || ld(fi(F_REACH, j)) != 0u) { continue; }
          // (a cut face: from a failed section's run to the run a step nearer)
          if (ci && di == dj + 1u) { continue; }
          if (ld(fi(F_CUT, j)) != 0u && dj == di + 1u) { continue; }
          if (cas(fi(F_REACH, j), 0u, 1u)) { nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), j); }
        }
      }
    }
    lo6 = hi6;
    workgroupBarrier();
    storageBarrier();
  }

  if (P.stopAt == 7u) { return; }
}

// ---- freedUnite: a thread a hanging run — the freed runs' pieces (lock-free union-find, the whole GPU) ----
@compute @workgroup_size(64)
fn freedUnite(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (P.stopAt >= 1u && P.stopAt <= 7u) { return; }
  // 7 — the freed runs (of a seeded piece, held nowhere now) and their pieces
  let t = gid.x;
  if (t >= seedN()) { return; }
  {
    let i = nu(F_SEEDL, t);
    if (!freed(i)) { return; }
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var rr = 0u; rr < 16u; rr++) {
        if ((nb.y & (1u << rr)) == 0u) { continue; }
        let j = nb.x + rr;
        if (j < i && !standsN(j) && freed(j)) { unite(F_FR, i, j); }
      }
    }
  }
}

// ---- judge4: one workgroup — the freed pieces out, the necks, the records ----
@compute @workgroup_size(256)
fn judge4(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt >= 1u && P.stopAt <= 4u) { return; }
  if (lid == 0u) { wgL[0] = seedN(); }
  let H = uniformCount(0u);
  let gW = 256u;
  if (P.stopAt == 7u) { return; }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (!freed(i)) { continue; }
    let r = find(F_FR, i);
    addf(fi(F_VOL, r), nf(N_Z1, i) - nf(N_Z0, i));
    if (ld(fi(F_CUT, i)) != 0u) { atomicMin(&W[fi(F_MINK, r)], nu(N_DIST, i)); }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (!freed(i)) { continue; }
    let r = find(F_FR, i);
    if (ld(fi(F_CUT, i)) != 0u && nu(N_DIST, i) == ld(fi(F_MINK, r))) { st(fi(F_TIPSRC, r), ld(fi(F_CUT, i)) - 1u); }
    if (r == i) {
      // a piece out: its kind, its hinge
      if (ldf(fi(F_VOL, r)) >= P.minBody) {
        let o = atomicAdd(&O[O_PIECES], 1u);
        if (o >= MAX_PIECES) { atomicOr(&O[O_OVER], 1u); } else { st(fi(F_OUT, r), o); }
      }
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let r = nu(F_SEEDL, t);
    if (!freed(r) || find(F_FR, r) != r) { continue; }
    let o = ld(fi(F_OUT, r));
    let src = ld(fi(F_TIPSRC, r));
    var kind = 0u;
    if (src != NONE) { kind = ld(pw(P_KIND, src)); }
    let vol = ldf(fi(F_VOL, r));
    if (o == NONE) {
      oadd(O_WHY + 9u, u32(vol * 1000.0));
      continue;
    }
    // why: free, shear, bend, arch (fits or crushes) — fracture.ts Fracture.why's load is the shear and bend
    if (kind == 0u) { oadd(O_WHY + 0u, 1u); } else if (kind == K_SHEAR) { oadd(O_WHY + 1u, 1u); } else if (kind == K_BEND) { oadd(O_WHY + 2u, 1u); } else { oadd(O_WHY + 3u, 1u); }
    let pb = O_PIECE0 + o * PIECE_W;
    atomicStore(&O[pb], kind);
    // (a hinge for a section that bent or sheared: P.flags bit 0, opts.rotate)
    let tip = (P.flags & 1u) != 0u && (kind == K_BEND || kind == K_SHEAR);
    atomicStore(&O[pb + 1u], select(0u, 1u, tip));
    if (tip) {
      atomicStore(&O[pb + 2u], ld(pw(P_PIVX, src)));
      atomicStore(&O[pb + 3u], ld(pw(P_PIVY, src)));
      atomicStore(&O[pb + 4u], ld(pw(P_PIVZ, src)));
      atomicStore(&O[pb + 5u], ld(pw(P_AXX, src)));
      atomicStore(&O[pb + 6u], ld(pw(P_AXY, src)));
    }
    atomicStore(&O[pb + 7u], bitcast<u32>(vol));
  }
  workgroupBarrier();
  storageBarrier();

  if (P.stopAt == 8u) { return; }
  // 8 — the neck: a seeded, weighed piece that held, on the standing columns under it (fracture.ts neck). A standing
  // run two pieces reach goes with the lesser piece (atomicMin, then listed once): the same verdict every time —
  // the first claim winning was a race (round 120's equality tests caught a cave judged two ways)
  if (lid == 0u) { st(cnt(C_LIST), 0u); st(cnt(C_NECK), 0u); }
  workgroupBarrier();
  storageBarrier();
  for (var ph = 0u; ph < 2u; ph++) {
    for (var t = lid; t < H; t += gW) {
      let i = nu(F_SEEDL, t);
      let p = nu(N_PIECE, i);
      let pf = ld(fi(F_PF, p));
      if ((pf & (PF_SEEDED | PF_WEIGHED | PF_REACHED)) != (PF_SEEDED | PF_WEIGHED | PF_REACHED) || (pf & PF_FAILED) != 0u) { continue; }
      if (ph == 0u && p == i) { nst(F_ROOTS, atomicAdd(&W[cnt(C_LIST)], 1u), p); }
      // the standing runs it's joined to (hop 1)
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var rr = 0u; rr < 16u; rr++) {
          if ((nb.y & (1u << rr)) == 0u) { continue; }
          let j = nb.x + rr;
          if (!standsN(j)) { continue; }
          if (ph == 0u) { atomicMin(&W[fi(F_NECK, j)], p); } else if (cas(fi(F_HOP, j), 0u, 1u)) { st(fi(F_NECKL, atomicAdd(&W[cnt(C_NECK)], 1u)), j); }
        }
      }
    }
    workgroupBarrier();
    storageBarrier();
  }
  // on through the standing runs joined above the piece's lowest point, NECK_R columns (past it: keyed into the land)
  // (the runs are listed hop by hop: this hop's are the ones listed since the last)
  var loH = 0u;
  for (var hop = 1u; hop <= P.neckR; hop++) {
    if (lid == 0u) { wgL[0] = ld(cnt(C_NECK)); }
    let nN = uniformCount(0u);
    for (var ph = 0u; ph < 2u; ph++) {
      for (var t = loH + lid; t < nN; t += gW) {
        let j = ld(fi(F_NECKL, t));
        if (ld(fi(F_HOP, j)) != hop) { continue; }
        let p = ld(fi(F_NECK, j));
        if (edgeHeld(j)) {
          if (ph == 0u) { atomicOr(&W[fi(F_PF, p)], PF_KEYED); }
          continue;
        }
        let zc = ldf(fi(F_ZC, p));
        for (var d = 0u; d < 6u; d++) {
          let nb = nbrBase(j, d);
          for (var rr = 0u; rr < 16u; rr++) {
            if ((nb.y & (1u << rr)) == 0u) { continue; }
            let m = nb.x + rr;
            if (!standsN(m)) { continue; }
            // joined above zc
            let o = min(nf(N_SH1, j), nf(N_SH1, m)) - max(zc, max(nf(N_SH0, j), nf(N_SH0, m)));
            if (o < P.overlap) { continue; }
            if (hop == P.neckR) {
              if (ph == 0u) { atomicOr(&W[fi(F_PF, p)], PF_KEYED); }
              continue;
            }
            // (a run listed at an earlier hop keeps its piece)
            if (ph == 0u) {
              if (ld(fi(F_HOP, m)) == 0u) { atomicMin(&W[fi(F_NECK, m)], p); }
            } else if (cas(fi(F_HOP, m), 0u, hop + 1u)) {
              st(fi(F_NECKL, atomicAdd(&W[cnt(C_NECK)], 1u)), m);
            }
          }
        }
      }
      workgroupBarrier();
      storageBarrier();
    }
    // (nothing new this hop: the leg is whole — the hops past it would find nothing)
    loH = nN;
    if (lid == 0u) { wgL[1] = ld(cnt(C_NECK)); }
    if (uniformCount(1u) == nN) { break; }
  }
  if (lid == 0u) { wgL[0] = ld(cnt(C_LIST)); wgL[1] = ld(cnt(C_NECK)); }
  let nP = uniformCount(0u);
  let nN = workgroupUniformLoad(&wgL[1]);
  // the checks in parallel: the leg's sums (a thread a standing run), then each piece's middle and lever, then its
  // section's second moment and its hull's reach in 24 directions (a thread a standing run), then the verdict
  for (var t = lid; t < nP; t += gW) { st(fi(F_KS, nu(F_ROOTS, t)), FINF); }
  workgroupBarrier();
  storageBarrier();
  // (a thread's sums kept while its runs are one piece's — nearly always — and put once: not every leg run's six
  // adds on the same words)
  {
    var cur = NONE;
    var acc = array<f32, 7>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1e9);
    for (var t = lid; t <= nN + gW; t += gW) {
      var p = NONE;
      var j = 0u;
      if (t < nN) {
        j = ld(fi(F_NECKL, t));
        p = ld(fi(F_NECK, j));
        if ((ld(fi(F_PF, p)) & PF_KEYED) != 0u) { p = NONE; }
      }
      if (p != cur || t >= nN) {
        if (cur != NONE) {
          for (var q = 0u; q < 6u; q++) { addf(fi(F_KM + q, cur), acc[q]); }
          minf(fi(F_KS, cur), acc[6]);
        }
        acc = array<f32, 7>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1e9);
        cur = p;
      }
      if (t >= nN) { break; }
      if (p == NONE) { continue; }
      let zc = ldf(fi(F_ZC, p));
      let z0 = nf(N_Z0, j);
      let z1 = nf(N_Z1, j);
      let m = nf(N_MASS, j) * max(z1 - zc, 0.0) / max(z1 - z0, 1e-6);
      let q = cellPos(colXY(nu(N_COL, j)));
      acc[0] += m;
      acc[1] += m * q.x;
      acc[2] += m * q.y;
      acc[3] += ROW_H;
      acc[4] += ROW_H * q.x;
      acc[5] += ROW_H * q.y;
      acc[6] = min(acc[6], select(nf(N_STR, j), 1e9, (nu(N_FLAGS, j) & NF_BED) != 0u));
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < nP; t += gW) {
    let p = nu(F_ROOTS, t);
    let A = ldf(fi(F_KA, p));
    let M = ldf(fi(F_AM, p)) + ldf(fi(F_KM, p));
    if (A <= 0.0 || M <= 0.0) { continue; }
    let com = vec2<f32>(ldf(fi(F_AX, p)) + ldf(fi(F_KMX, p)), ldf(fi(F_AY, p)) + ldf(fi(F_KMY, p))) / M;
    let cen = vec2<f32>(ldf(fi(F_KCX, p)), ldf(fi(F_KCY, p))) / A;
    let v = com - cen;
    let L = length(v);
    let uu = select(vec2<f32>(1.0, 0.0), v / max(L, 1e-6), L > 1e-4);
    // (the middle and the lever's direction, for the next pass: F_PIV*, F_AX* hold them till the verdict)
    stf(fi(F_PIVX, p), cen.x);
    stf(fi(F_PIVY, p), cen.y);
    stf(fi(F_AXX, p), uu.x);
    stf(fi(F_AXY, p), uu.y);
  }
  workgroupBarrier();
  storageBarrier();
  {
    var cur = NONE;
    var ki = 0.0;
    var kc = 0.0;
    var sup = array<f32, 25>();
    for (var a = 0u; a < 25u; a++) { sup[a] = 0.0; }
    for (var t = lid; t <= nN + gW; t += gW) {
      var p = NONE;
      var j = 0u;
      if (t < nN) {
        j = ld(fi(F_NECKL, t));
        p = ld(fi(F_NECK, j));
        if ((ld(fi(F_PF, p)) & PF_KEYED) != 0u) { p = NONE; }
      }
      if (p != cur || t >= nN) {
        if (cur != NONE) {
          addf(fi(F_KI, cur), ki);
          maxf(fi(F_KC, cur), kc);
          // (reaches offset by 1e4: positive, so they order as their bits)
          maxf(fi(F_SUPU, cur), sup[24]);
          for (var a = 0u; a < 24u; a++) { maxf(fi(F_SUP + a, cur), sup[a]); }
        }
        ki = 0.0;
        kc = 0.0;
        for (var a = 0u; a < 25u; a++) { sup[a] = 0.0; }
        cur = p;
      }
      if (t >= nN) { break; }
      if (p == NONE) { continue; }
      let q = cellPos(colXY(nu(N_COL, j)));
      let cen = vec2<f32>(ldf(fi(F_PIVX, p)), ldf(fi(F_PIVY, p)));
      let uu = vec2<f32>(ldf(fi(F_AXX, p)), ldf(fi(F_AXY, p)));
      let dd = dot(q - cen, uu);
      ki += ROW_H * dd * dd + 0.0601;
      kc = max(kc, abs(dd) + 0.5);
      sup[24] = max(sup[24], dot(q, uu) + 1e4);
      for (var a = 0u; a < 24u; a++) {
        let ang = f32(a) * 0.2617994;
        sup[a] = max(sup[a], dot(q, vec2<f32>(cos(ang), sin(ang))) + 1e4);
      }
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < nP; t += gW) {
    let p = nu(F_ROOTS, t);
    if ((ld(fi(F_PF, p)) & PF_KEYED) != 0u) { oadd(O_WHY + 8u, 1u); continue; }
    let zc = ldf(fi(F_ZC, p));
    let A = ldf(fi(F_KA, p));
    let M = ldf(fi(F_AM, p)) + ldf(fi(F_KM, p));
    if (A <= 0.0 || M <= 0.0) { continue; }
    oadd(O_WHY + 7u, 1u);
    let s = min(ldf(fi(F_KS, p)), 1e3);
    let com = vec2<f32>(ldf(fi(F_AX, p)) + ldf(fi(F_KMX, p)), ldf(fi(F_AY, p)) + ldf(fi(F_KMY, p))) / M;
    let cen = vec2<f32>(ldf(fi(F_PIVX, p)), ldf(fi(F_PIVY, p)));
    let uu = vec2<f32>(ldf(fi(F_AXX, p)), ldf(fi(F_AXY, p)));
    let L = length(com - cen);
    // tipping: its centre of mass past the section's hull (its reach in 24 directions, each cell's own added)
    var worst = -1e9;
    var wn = vec2<f32>(1.0, 0.0);
    var wh = 0.0;
    for (var a = 0u; a < 24u; a++) {
      let ang = f32(a) * 0.2617994;
      let n = vec2<f32>(cos(ang), sin(ang));
      let h = ldf(fi(F_SUP + a, p)) - 1e4 + hexReach(n);
      let ex = dot(com, n) - h;
      if (ex > worst) { worst = ex; wn = n; wh = h; }
    }
    // the far side's pull: the moment about the section's middle over its modulus, less the weight on its area
    let S = ldf(fi(F_KI, p)) / max(ldf(fi(F_KC, p)), 0.5);
    var kind = 0u;
    if (worst > P.tipGive) { kind = K_TIP; } else if (M * L / S - M / A > P.tensile * s) { kind = K_LEAN; } else if (M / A > P.crush * s) { kind = K_CRUSH; }
    if (kind == 0u) { continue; }
    atomicOr(&W[fi(F_PF, p)], PF_NECKFAIL);
    st(fi(F_KIND, p), kind);
    // the edge it turns over: past the hull, that side; leaning, the side its weight is on
    var n = wn;
    var h = wh;
    if (kind == K_LEAN) {
      n = uu;
      h = ldf(fi(F_SUPU, p)) - 1e4 + hexReach(n);
    }
    let piv = com - n * (dot(com, n) - h);
    stf(fi(F_PIVX, p), piv.x);
    stf(fi(F_PIVY, p), piv.y);
    stf(fi(F_PIVZ, p), zc);
    stf(fi(F_AXX, p), -n.y);
    stf(fi(F_AXY, p), n.x);
    let o = atomicAdd(&O[O_PIECES], 1u);
    if (o >= MAX_PIECES) { atomicOr(&O[O_OVER], 1u); continue; }
    st(fi(F_OUT, p), o);
    if (kind == K_TIP) { oadd(O_WHY + 5u, 1u); } else if (kind == K_LEAN) { oadd(O_WHY + 6u, 1u); } else { oadd(O_WHY + 4u, 1u); }
    let pb = O_PIECE0 + o * PIECE_W;
    let tip = (P.flags & 1u) != 0u && kind != K_CRUSH;
    atomicStore(&O[pb], kind);
    atomicStore(&O[pb + 1u], select(0u, 1u, tip));
    atomicStore(&O[pb + 2u], bitcast<u32>(piv.x));
    atomicStore(&O[pb + 3u], bitcast<u32>(piv.y));
    atomicStore(&O[pb + 4u], bitcast<u32>(zc));
    atomicStore(&O[pb + 5u], bitcast<u32>(-n.y));
    atomicStore(&O[pb + 6u], bitcast<u32>(n.x));
    atomicStore(&O[pb + 7u], bitcast<u32>(M));
  }
  workgroupBarrier();
  storageBarrier();

  // 9 — the records: every run that goes (its slots copied), and the leg a crushed piece leaves as rubble
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (freed(i)) {
      let o = ld(fi(F_OUT, find(F_FR, i)));
      record(i, o, 0.0, 1e9);
      continue;
    }
    let p = nu(N_PIECE, i);
    if ((ld(fi(F_PF, p)) & PF_NECKFAIL) != 0u) { record(i, ld(fi(F_OUT, p)), 0.0, 1e9); }
  }
  for (var t = lid; t < nN; t += gW) {
    let j = ld(fi(F_NECKL, t));
    let p = ld(fi(F_NECK, j));
    if ((ld(fi(F_PF, p)) & PF_NECKFAIL) == 0u) { continue; }
    let zc = ldf(fi(F_ZC, p));
    record(j, ld(fi(F_OUT, p)), zc, 1e9);
    if (ld(fi(F_KIND, p)) == K_CRUSH) { record(j, NONE, max(0.0, zc - 2.0), zc); }
  }
  if (lid == 0u) {
    atomicStore(&O[O_OVER + 1u], ld(cnt(C_OVER)));
  }
}

/** a run of a seeded piece that nothing holds now */
fn freed(i: u32) -> bool {
  if (ld(fi(F_REACH, i)) != 0u) { return false; }
  return (ld(fi(F_PF, nu(N_PIECE, i))) & PF_SEEDED) != 0u;
}

/** a record: the run's column, the piece it goes with (NONE: it crumbles), what of it goes [z0, z1), its slots */
fn record(i: u32, piece: u32, z0: f32, z1: f32) {
  let n = nu(N_SLN, i);
  let w = 6u + 4u * n;
  let at = atomicAdd(&O[O_RECW], w);
  if (O_REC0 + at + w > P.outCap) { atomicOr(&O[O_OVER], 2u); return; }
  let b = O_REC0 + at;
  let q = colXY(nu(N_COL, i));
  atomicStore(&O[b], u32(q.x));
  atomicStore(&O[b + 1u], u32(q.y));
  atomicStore(&O[b + 2u], piece);
  atomicStore(&O[b + 3u], bitcast<u32>(z0));
  atomicStore(&O[b + 4u], bitcast<u32>(z1));
  atomicStore(&O[b + 5u], n);
  let s0 = nu(N_SL0, i);
  for (var s = 0u; s < n; s++) {
    let v = slots[s0 + s];
    atomicStore(&O[b + 6u + 4u * s], v.x);
    atomicStore(&O[b + 7u + 4u * s], v.y);
    atomicStore(&O[b + 8u + 4u * s], v.z);
    atomicStore(&O[b + 9u + 4u * s], v.w);
  }
}

/** a meeting piece's axis: xy the dominant direction of its faces' normals, z 1 when they spread every way (a dome) */
fn archAxis(r: u32) -> vec3<f32> {
  let a = ldf(fi(F_TXX, r));
  let b = ldf(fi(F_TXY, r));
  let c = ldf(fi(F_TYY, r));
  let tr = 0.5 * (a + c);
  let disc = sqrt(max(0.25 * (a - c) * (a - c) + b * b, 0.0));
  let l1 = tr + disc;
  let l2 = tr - disc;
  var e = vec2<f32>(1.0, 0.0);
  if (abs(b) > 1e-6) { e = normalize(vec2<f32>(l1 - c, b)); } else if (c > a) { e = vec2<f32>(0.0, 1.0); }
  return vec3<f32>(e, select(0.0, 1.0, l2 > 0.5 * l1));
}

struct Span { mid: vec2<f32>, ax: vec2<f32>, L: f32, zs: f32, radial: bool }
/** the span between a meeting piece's springings (the faces to what holds it, level 1) */
fn span(r: u32) -> Span {
  var o: Span;
  let A0 = max(ldf(fi(F_A0, r)), 1e-6);
  let cen = vec2<f32>(ldf(fi(F_A0X, r)), ldf(fi(F_A0Y, r))) / A0;
  let ax = archAxis(r);
  o.ax = ax.xy;
  o.radial = ax.z > 0.5;
  // springing: the faces' mean foot
  o.zs = ldf(fi(F_ZB, r)) / A0;
  let Ap = ldf(fi(F_AP, r));
  if (o.radial || Ap <= 1e-6 || Ap >= A0 - 1e-6) {
    o.mid = cen;
    // (radial: the springings' mean distance from the middle)
    o.L = 2.0 * ldf(fi(F_RAD, r)) / A0;
  } else {
    let cp = vec2<f32>(ldf(fi(F_APZ, r)), ldf(fi(F_IP, r))) / Ap;
    let cm = (cen * A0 - cp * Ap) / (A0 - Ap);
    o.mid = 0.5 * (cp + cm);
    o.L = abs(dot(cp - cm, o.ax));
  }
  return o;
}

/** where a run lies along the span: 1 at the crown, 0 at the springings */
fn archQ(sp: Span, p: vec2<f32>) -> f32 {
  if (sp.radial) {
    let s = length(p - sp.mid) / max(0.5 * sp.L, 1e-3);
    return 1.0 - s * s;
  }
  let s = dot(p - sp.mid, sp.ax) / max(0.5 * sp.L, 1e-3);
  return 1.0 - s * s;
}
