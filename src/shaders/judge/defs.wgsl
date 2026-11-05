// defs.wgsl: the layout, records and helpers (part 1 of 5 of the judgeWgsl shader, joined in order by judge.ts)
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
  pcap: u32, mode: u32, pad1: u32, autoD: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> slots: array<vec4<u32>>;
/** per material: state, strength, density, w its tensile share (round 120b, "Follow the material": natural rock 1,
 *  built masonry 0 — TUNE.judgeB by group) or −1: never gives (span Infinity) */
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
const N_TS: u32 = 67u; // a run's weakest tensile strength (strength × its material's tensile share)
const N_FTS: u32 = 68u; // its faces' weakest
const NN: u32 = 69u;
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
const F_STS: u32 = 96u; // a section's weakest tensile strength (the level pass)
const F_KT: u32 = 97u; // a leg's weakest tensile strength (the neck)
const NFIELDS: u32 = 98u;
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
/** (judge1) the path taken: 1 the pairs, 0 the level pass — mode 2 picks by depth (P.autoD) */
const C_MODE: u32 = 14u;
fn pairsMode() -> bool { return ld(cnt(C_MODE)) == 1u; }
const NCOUNT: u32 = 16u;
// the output's header: counts, then why (fracture.ts Fracture.why), then pieces (8 words each), then records
const O_RECW: u32 = 0u;
const O_PIECES: u32 = 1u;
const O_OVER: u32 = 2u;
const O_WHY: u32 = 4u; // free, load(shear), bend, arch, crush, tip, lean, weighed, keyed, crumbs (×1000), sections
const O_TIME: u32 = 16u;
/** (judge.ts) the window was too small: a seeded piece or its leg reached its side */
const O_GROW: u32 = 24u;
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
