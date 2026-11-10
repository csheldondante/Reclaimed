// ---- the living town's routes and riders (docs/design/LIVING_TOWN.md) -----------------------------------------------
// One town's box (citygen's grid: w × h columns, its first column's corner at 0, 0, world units; odd rows shifted half
// a column right — common.wgsl cellPos). The graph is citygen's road raster (ROADS: 1 a road, DECK_BIT | z·256 a deck)
// plus door segments, connector tracks and site pads, as a word a column (WALK). Hubs are distance fields over it
// (FIELD, a u32 a column a hub, 1/16 m), relaxed in place with no readback: a changed word becomes the next frame's
// sweeps or none. Routes are traced down a hub's field into a points pool (PTS) once per (start column, hub) key and
// shared ("like conveyor belts", DESIGN §12). Riders (RID) ride them as kinematic trips; their jobs are a state machine
// here. Nothing is read back but the debug panel's counters.
//
// Bindings (each kernel's layout lists the ones it uses — at most 8 storage buffers a kernel):
//   0 P (uniform)   1 ROADS  2 H  3 REC  4 CNT  5 POP  6 ART  15 M (citygen's, read)   7 PROG (citygen's progress, read)
//   8 WALK  9 FIELD  10 LT (state, atomic)  11 RB (the route buffer: routeread.wgsl)  12 RID  13 VOX  14 IND (indirect args)  16 VARGS (draw args)

struct P {
  /** w, h (the box), riders, frame */
  n: vec4<u32>,
  /** lot room (citygen REC_LM), the first landmark record, flags (F_*), sweeps this frame */
  m: vec4<u32>,
  /** cumulative job ends: commuter, farmer, quarryman, stone hauler */
  j0: vec4<u32>,
  /** woodcutter, log hauler, builder, total */
  j1: vec4<u32>,
  /** dt (world s), time, the town's centre x, y */
  t: vec4<f32>,
  /** the town's radius, walk speed, cart speed, work time (s) */
  r: vec4<f32>,
  /** quarry: footprint side (m), bench height, depth, wall slope (degrees) */
  q: vec4<f32>,
  /** quarry: dig rate (m³ a worker-second), ledge width, a cart's load (m³), ramp width */
  q2: vec4<f32>,
  /** clearing: radius, cut time (s), replant (0/1), regrow delay (s) */
  f: vec4<f32>,
  /** where the grid is in the window: dx, dy (columns), the window's columns, rows */
  pl: vec4<i32>,
  /** z: world → window (add), unused, lateral spread (m), (tests only) a rider forced overridden: its index + 1 */
  pz: vec4<f32>,
  /** (season life) the wagons' and the ships' ends (after the builders'), 0, 0 */
  x: vec4<u32>,
};
@group(0) @binding(0) var<uniform> u: P;

const F_ON: u32 = 1u;
const F_QUARRY: u32 = 2u;
const F_FOREST: u32 = 4u;
const F_REPLANT: u32 = 8u;
/** ?livingdebug=1: the graph drawn over the town (figures' pass) */
const F_DEBUG: u32 = 16u;

const ROW_H: f32 = 0.8660254;
const NONE: u32 = 0xffffffffu;
const DECK_BIT: u32 = 0x80000000u;
/** (season life) a town wall's column in citygen's road raster (streets.wgsl WALL_MARK) */
const WALL_MARK: u32 = 0x40000000u;

/** hubs */
const HUBS: u32 = 8u;
const H_STORES: u32 = 0u;
const H_GRANARY: u32 = 1u;
const H_MARKET: u32 = 2u;
const H_WORKSHOPS: u32 = 3u;
const H_FARMS: u32 = 4u;
const H_GATES: u32 = 5u;
const H_QUARRY: u32 = 6u;
const H_CAMP: u32 = 7u;

/** WALK classes (bits 0-3); bit 16: a tree there is claimed by a woodcutter */
const W_ROAD: u32 = 1u;
const W_DECK: u32 = 2u;
const W_DOOR: u32 = 3u;
const W_TRACK: u32 = 4u;
const W_PAD: u32 = 5u;
const W_CLAIM: u32 = 0x10000u;
/** bit 17: a passage the connectivity check laid (kept across rebuilds, walked as a track); bit 18: a building stands
 *  there (open ground's passages go round it); bit 19: a lot's ground, built or not (the works keep off it) */
const W_PASS: u32 = 0x20000u;
const W_BLOCK: u32 = 0x40000u;
const W_LOTGROUND: u32 = 0x80000u;
/** FIELD's planes past the hubs: the open ground's distance to the network, the cut-off components' labels */
const P_OPEN: u32 = 8u;
const P_LAB: u32 = 9u;
/** (season life) the sea field: the water's distance from the harbour's quays (ships) */
const P_SEA: u32 = 10u;
const PLANES: u32 = 11u;
const P_HARBOUR: u32 = 2u;
/** (season life) ships: the water this near a harbour lot is its quay (columns); a hull's height over the ground under
 *  the water; moored within this of a quay (the sea field's 1/16 units) */
const QUAY_R: i32 = 6;
const SHIP_DRAFT: f32 = 1.2;
const MOOR: u32 = 48u;

/** citygen streets.wgsl: a record's words, kinds, the district purposes */
const RECW: u32 = 24u;
const REC_BUILDING: u32 = 1u;
const P_HOMES: u32 = 0u;
const P_MARKET: u32 = 1u;
const P_WORKSHOPS: u32 = 3u;
const P_FARMS: u32 = 4u;
/** citygen ART: header words, words an arterial, where its points start, the room */
const NART: u32 = 8u;
const NAP: u32 = 128u;
const AP: u32 = 20u;
const AW: u32 = AP + 2u * NAP;

// ---- LT: the state words (living.ts mirrors the panel's) ----
const L_PHASE: u32 = 0u;
const L_CHANGED: u32 = 1u;
const L_TQ: u32 = 2u;
const L_PTS: u32 = 3u;
const L_ROUTES: u32 = 4u;
const L_SWEEPS: u32 = 7u;
/** the gate's snapshot: relax sweeps run this frame (the phase was 1 at its start), the trace ran (it was 2) */
const L_RELAXING: u32 = 8u;
const L_TRACING: u32 = 9u;
/** the gate's snapshot of the phase (the phase-specific single kernels act on it) */
const L_GPH: u32 = 10u;
/** the points pool in two halves, used in turn: the half routes go into now, each half's generation (a route carries
 *  its half's generation; a rider on a route whose half was reused ends its leg), the switch asked (the half three
 *  quarters full), the hash being cleared (every key traced again into the new half) */
const L_HALF: u32 = 11u;
const L_GEN0: u32 = 12u;
const L_SWITCH: u32 = 14u;
const L_CLEARHASH: u32 = 15u;
const L_PICK: u32 = 16u;
const L_SEEDS: u32 = 24u;
const L_HUBCOL: u32 = 32u;
const L_C: u32 = 48u;
const L_Q: u32 = 96u;
const L_F: u32 = 128u;
const L_TREES: u32 = 160u;
const TREE_ROOM: u32 = 1024u;
const L_SITES: u32 = 1184u;
const SITE_ROOM: u32 = 64u;
const L_FELL: u32 = 1248u;
const FELL_ROOM: u32 = 64u;
const L_HASH: u32 = 1320u;
const HASH: u32 = 8192u;
const L_TQL: u32 = 17704u;
const TQ_ROOM: u32 = 2048u;
const L_RH: u32 = 19752u;
const ROUTES: u32 = 8192u;
/** (works.wgsl) the felled columns waiting to be replanted: column + 1, the time felled (f32 bits) */
const L_REGROW: u32 = 52520u;
const REGROW_ROOM: u32 = 256u;
// (L_REGROW + REGROW_ROOM × 2 = 53032 words: living.ts LT_WORDS)

/** counters (L_C + …): volumes in litres (1e-3 m³) */
const C_DUG: u32 = 0u;
const C_FACE: u32 = 1u;
const C_CART_STONE: u32 = 2u;
const C_INBOX: u32 = 3u;
const C_DEPOSITED: u32 = 4u;
const C_FELLED: u32 = 5u;
const C_LOG_CAMP: u32 = 6u;
const C_LOG_CART: u32 = 7u;
const C_LOG_STORES: u32 = 8u;
const C_PRODUCE: u32 = 9u;
const C_ARRIVALS: u32 = 10u;
const C_MISS: u32 = 11u;
const C_TRACED: u32 = 12u;
const C_POOLFULL: u32 = 13u;
const C_IDLE: u32 = 14u;
const C_BUILDWORK: u32 = 15u;
const C_DIGBUDGET: u32 = 16u;
const C_RIDING: u32 = 17u;
const C_TREES: u32 = 18u;
const C_TREECUR: u32 = 19u;
const C_SITES: u32 = 20u;
const C_WORKING: u32 = 21u;
const C_LOGS_CUT: u32 = 22u;
const C_REGROWN: u32 = 23u;
/** the connectivity check (DESIGN §13): walkable columns cut off from the stores, passages laid, rounds, built doors
 *  cut off, and what's left cut off after the last round (0: every door and hub joined) */
const C_ORPHANS: u32 = 24u;
const C_PASSAGES: u32 = 25u;
const C_ROUNDS: u32 = 26u;
const C_DOORS_CUT: u32 = 27u;
const C_CUT_LEFT: u32 = 28u;
/** pool switches; legs ended because their route's half was reused */
const C_SWITCHES: u32 = 29u;
const C_STALE: u32 = 30u;
/** the most passage rounds before the check gives up and says what's left (a place no open ground reaches: water) */
const MAX_ROUNDS: u32 = 4u;

/** quarry state (L_Q + …) */
const Q_X0: u32 = 0u;     // footprint's first column + 1 (0: no site yet)
const Q_Y0: u32 = 1u;
const Q_BENCH: u32 = 2u;  // the working bench
const Q_PROG: u32 = 3u;   // its progress (f32 bits, 0–1)
const Q_RAMP: u32 = 4u;   // the ramp's route id + 1 (0: none yet)
const Q_FACEX: u32 = 5u;  // the face (f32 bits, grid world)
const Q_FACEY: u32 = 6u;
const Q_RIM: u32 = 7u;    // the rim's column + 1 (the ramp's top)
const Q_BENCHES: u32 = 8u;
const Q_PICK: u32 = 9u;   // the pick (atomicMax: score << 18 | candidate)
const Q_RAMPV: u32 = 10u; // the bench the ramp was made for + 1
const Q_ENDX: u32 = 11u;  // the ramp's foot (f32 bits)
const Q_ENDY: u32 = 12u;
const Q_SIDE: u32 = 13u;  // the footprint's side in columns
const Q_DONE: u32 = 14u;
const Q_YARDPICK: u32 = 15u; // the stockpile's yard: (distance << 15 | lot) atomicMin over the open lots
const Q_YARD: u32 = 16u;     // its lot + 1
const Q_APEX: u32 = 17u;     // the pile's apex height (f32 bits)
const Q_RIMZ: u32 = 18u;     // the rim's ground (world z, f32 bits: the ramp's top)
/** clearing state (L_F + …) */
const F_PICK: u32 = 0u;   // the pick (atomicMax: trees << 18 | candidate)
const F_CAMP: u32 = 1u;   // the clearing's centre column + 1
const F_YARD: u32 = 2u;   // the yard's column + 1
const F_ASKED: u32 = 3u;  // picked: 1

/** a hash slot's route word: being traced, no route (unreachable or the pool full) */
const R_PENDING: u32 = 0xfffffffeu;
const R_FAILED: u32 = 0xfffffffdu;

@group(0) @binding(1) var<storage, read> ROADS: array<u32>;
@group(0) @binding(2) var<storage, read> HT: array<f32>;
@group(0) @binding(3) var<storage, read> REC: array<u32>;
@group(0) @binding(4) var<storage, read> CNT: array<u32>;
@group(0) @binding(5) var<storage, read> POP: array<f32>;
@group(0) @binding(6) var<storage, read> ART: array<u32>;
@group(0) @binding(7) var<storage, read> PROG: array<f32>;
@group(0) @binding(8) var<storage, read_write> WALK: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> FIELD: array<u32>;
@group(0) @binding(10) var<storage, read_write> LT: array<atomic<u32>>;
/** the route buffer (the contract src/shaders/routeread.wgsl reads: keep the two the same): an 8-word header (the
 *  halves' generations, ids a half, where the points start, the grid's place, the points' room), a head a route
 *  (first point, count, length, generation), then the points (x, y, z, distance along) */
@group(0) @binding(11) var<storage, read_write> RB: array<u32>;
fn ptsRoom() -> u32 { return RB[7u]; }
fn pt(i: u32) -> vec4<f32> { let o = RB[3u] + i * 4u; return bitcast<vec4<f32>>(vec4<u32>(RB[o], RB[o + 1u], RB[o + 2u], RB[o + 3u])); }
fn setPt(i: u32, v: vec4<f32>) { let o = RB[3u] + i * 4u; let b = bitcast<vec4<u32>>(v); RB[o] = b.x; RB[o + 1u] = b.y; RB[o + 2u] = b.z; RB[o + 3u] = b.w; }
fn setHead(rid: u32, first: u32, count: u32, len: f32, gen: u32) { let o = 8u + rid * 4u; RB[o] = first; RB[o + 1u] = count; RB[o + 2u] = bitcast<u32>(len); RB[o + 3u] = gen; }
@group(0) @binding(12) var<storage, read_write> RID: array<vec4<f32>>;
@group(0) @binding(13) var<storage, read_write> VOX: array<vec4<u32>>;
@group(0) @binding(14) var<storage, read_write> IND: array<u32>;
@group(0) @binding(15) var<storage, read> WET: array<u32>;
@group(0) @binding(16) var<storage, read_write> VARGS: array<atomic<u32>>;
/** per column two words: a cut-off component's cheapest passage (its cost, then its column), keyed by its label */
@group(0) @binding(17) var<storage, read_write> PASS: array<atomic<u32>>;
/** the passages' mesh (citygen's vertex format: x, y, z, colour, normal, 0) and its draw args */
@group(0) @binding(18) var<storage, read_write> PMESH: array<u32>;
@group(0) @binding(19) var<storage, read_write> PARGS: array<atomic<u32>>;

// ---- the lattice (common.wgsl's, in the box) ----
fn W() -> i32 { return i32(u.n.x); }
fn Hh() -> i32 { return i32(u.n.y); }
fn N() -> u32 { return u.n.x * u.n.y; }
fn inBox(c: vec2<i32>) -> bool { return c.x >= 0 && c.y >= 0 && c.x < W() && c.y < Hh(); }
fn ix(c: vec2<i32>) -> u32 { return u32(c.y * W() + c.x); }
fn cxy(i: u32) -> vec2<i32> { return vec2<i32>(i32(i % u.n.x), i32(i / u.n.x)); }
fn cpos(c: vec2<i32>) -> vec2<f32> { return vec2<f32>(f32(c.x) + 0.5 + 0.5 * f32(c.y & 1), (f32(c.y) + 0.5) * ROW_H); }
fn axialCell(a: vec2<i32>) -> vec2<i32> { return vec2<i32>(a.x + (a.y - (a.y & 1)) / 2, a.y); }
fn cat(w: vec2<f32>) -> vec2<i32> {
  let r = (w.y - 0.5 * ROW_H) / ROW_H;
  let a = vec2<f32>(w.x - 0.5 - 0.5 * r, r);
  let c = vec3<f32>(a.x, a.y, -a.x - a.y);
  var o = round(c);
  let e = abs(o - c);
  if (e.x > e.y && e.x > e.z) { o.x = -o.y - o.z; } else if (e.y > e.z) { o.y = -o.x - o.z; }
  return axialCell(vec2<i32>(i32(o.x), i32(o.y)));
}
/** the six neighbours of a column (odd rows shifted right) */
fn nbr(c: vec2<i32>, k: u32) -> vec2<i32> {
  let odd = (c.y & 1) == 1;
  switch k {
    case 0u: { return c + vec2<i32>(-1, 0); }
    case 1u: { return c + vec2<i32>(1, 0); }
    case 2u: { return c + select(vec2<i32>(-1, -1), vec2<i32>(0, -1), odd); }
    case 3u: { return c + select(vec2<i32>(0, -1), vec2<i32>(1, -1), odd); }
    case 4u: { return c + select(vec2<i32>(-1, 1), vec2<i32>(0, 1), odd); }
    default: { return c + select(vec2<i32>(0, 1), vec2<i32>(1, 1), odd); }
  }
}
fn hash(x: u32) -> u32 {
  var s = x * 747796405u + 2891336453u;
  s = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (s >> 22u) ^ s;
}
fn rnd(a: u32, b: u32) -> f32 { return f32(hash((a * 9781u) ^ hash(b + 0x9e37u)) >> 8u) / 16777216.0; }

fn lt(i: u32) -> u32 { return atomicLoad(&LT[i]); }
fn ltf(i: u32) -> f32 { return bitcast<f32>(atomicLoad(&LT[i])); }
fn setLt(i: u32, v: u32) { atomicStore(&LT[i], v); }
fn setLtf(i: u32, v: f32) { atomicStore(&LT[i], bitcast<u32>(v)); }
fn bump(c: u32, v: u32) { atomicAdd(&LT[L_C + c], v); }
fn walkClass(i: u32) -> u32 { return atomicLoad(&WALK[i]) & 0xfu; }
fn rf(i: u32) -> f32 { return bitcast<f32>(REC[i]); }

// ---- lots ----
fn lotCount() -> u32 { return min(CNT[0], u.m.x); }
fn lotKind(r: u32) -> u32 { return REC[r * RECW + 17u]; }
fn corner(r: u32, k: u32) -> vec2<f32> { let o = r * RECW + (k & 3u) * 2u; return vec2<f32>(rf(o), rf(o + 1u)); }
fn fcorner(r: u32, k: u32) -> vec2<f32> { let o = r * RECW + 8u + (k & 3u) * 2u; return vec2<f32>(rf(o), rf(o + 1u)); }
fn lotMid(r: u32) -> vec2<f32> { return 0.25 * (fcorner(r, 0u) + fcorner(r, 1u) + fcorner(r, 2u) + fcorner(r, 3u)); }
fn purposeAt(p: vec2<f32>) -> u32 {
  let c = cat(p);
  if (!inBox(c)) { return P_HOMES; }
  return u32(POP[ix(c) * 4u + 2u] + 0.5);
}
/** a building's door: its footprint's frontage edge's middle and the way out (right of the parcel's edge k → k+1) */
struct Door { at: vec2<f32>, out: vec2<f32>, street: vec2<f32>, ok: bool };
fn doorOf(r: u32) -> Door {
  var d = Door(vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), false);
  if (lotKind(r) != REC_BUILDING) { return d; }
  let f = REC[r * RECW + 16u];
  if (f > 3u) { return d; }
  let a = corner(r, f);
  let b = corner(r, f + 1u);
  let e = b - a;
  if (dot(e, e) < 1e-4) { return d; }
  d.out = normalize(vec2<f32>(e.y, -e.x));
  d.at = 0.5 * (fcorner(r, f) + fcorner(r, f + 1u));
  d.street = 0.5 * (a + b) + d.out * 3.0;
  d.ok = true;
  return d;
}
/** a building that's up (citygen's progress: a district not begun is sunk out of sight, its roads not drawn) */
fn built(r: u32) -> bool { return PROG[r] >= 0.999; }
/** the column the door stands in (just out of the footprint): a route's start for its building */
fn doorCol(r: u32) -> u32 {
  let d = doorOf(r);
  if (!d.ok) { return NONE; }
  let c = cat(d.at + d.out * 0.6);
  if (!inBox(c)) { return NONE; }
  return ix(c);
}

// ---- the gate: the build's and the relax's indirect args from the phase ----
// IND: [0..3) build over columns, [3..6) build over lots, [6..9) build one thread, [9..12) relax sweeps,
// [12..15) trace, [15..18) build over hash slots
@compute @workgroup_size(1)
fn gate() {
  let ph = lt(L_PHASE);
  let b = ph == 0u;
  let cols = (N() + 63u) / 64u;
  IND[0] = select(0u, cols, b); IND[1] = 1u; IND[2] = 1u;
  IND[3] = select(0u, (u.m.x + 63u) / 64u, b); IND[4] = 1u; IND[5] = 1u;
  IND[6] = select(0u, 1u, b); IND[7] = 1u; IND[8] = 1u;
  IND[9] = select(0u, cols, ph == 1u || ph == 3u); IND[10] = 1u; IND[11] = 1u;
  // (the hash cleared only on a pool switch: poolSwitch writes these)
  IND[27] = 0u; IND[28] = 1u; IND[29] = 1u;
  IND[12] = select(0u, (min(lt(L_TQ), TQ_ROOM) + 63u) / 64u, ph == 4u); IND[13] = 1u; IND[14] = 1u;
  IND[15] = select(0u, HASH / 64u, b); IND[16] = 1u; IND[17] = 1u;
  // (the connectivity check: over the columns at phase 2 and 5, over the lots at 2, one thread at 2 and 5)
  IND[18] = select(0u, cols, ph == 2u || ph == 5u); IND[19] = 1u; IND[20] = 1u;
  IND[21] = select(0u, (u.m.x + 63u) / 64u, ph == 2u); IND[22] = 1u; IND[23] = 1u;
  IND[24] = select(0u, 1u, ph == 2u || ph == 5u); IND[25] = 1u; IND[26] = 1u;
  setLt(L_GPH, ph);
  // (the frame's own counts: riding, working, idle — what the panel shows is one frame's)
  setLt(L_C + C_RIDING, 0u);
  setLt(L_C + C_WORKING, 0u);
  setLt(L_C + C_IDLE, 0u);
  setLt(L_RELAXING, select(0u, 1u, ph == 1u || ph == 3u));
  setLt(L_TRACING, select(0u, 1u, ph == 4u));
  if (b) {
    for (var h = 0u; h < HUBS; h++) { setLt(L_PICK + h, NONE); setLt(L_SEEDS + h, 0u); }
    setLt(L_Q + Q_PICK, 0u);
  }
}

// ---- the build (phase 0): the walkable mask, the hubs' seeds ----
/** B1 (a thread a column): WALK from the road raster; every field cleared */
@compute @workgroup_size(64)
fn walkInit(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  let m = ROADS[i];
  var w = 0u;
  // (season life: a town wall's column — citygen streets.wgsl WALL_MARK — blocked: routes go out through the gates)
  if (m == WALL_MARK) {
    atomicStore(&WALK[i], W_BLOCK);
    for (var h = 0u; h < PLANES; h++) { FIELD[h * N() + i] = NONE; }
    return;
  }
  if (m != 0u) { w = select(W_ROAD, W_DECK, (m & DECK_BIT) != 0u); }
  // (a passage laid by an earlier round stays: walked as a track)
  if ((atomicLoad(&WALK[i]) & W_PASS) != 0u) { w = select(w, W_TRACK, w == 0u) | W_PASS; }
  atomicStore(&WALK[i], w);
  for (var h = 0u; h < PLANES; h++) { FIELD[h * N() + i] = NONE; }
}

/** rasterise a straight piece into WALK as class `cls` where nothing walkable is (half width hw) */
fn rasterWalk(a: vec2<f32>, b: vec2<f32>, hw: f32, cls: u32) {
  let L = distance(a, b);
  let n = u32(ceil(L / 0.4)) + 1u;
  let d = select(vec2<f32>(1.0, 0.0), (b - a) / max(L, 1e-4), L > 1e-4);
  let s = vec2<f32>(-d.y, d.x);
  for (var k = 0u; k <= n; k++) {
    let p = mix(a, b, f32(k) / f32(n));
    for (var j = -1; j <= 1; j++) {
      let c = cat(p + s * hw * f32(j));
      if (!inBox(c)) { continue; }
      let i = ix(c);
      if ((atomicLoad(&WALK[i]) & 0xfu) == 0u) { atomicOr(&WALK[i], cls); }
    }
  }
}

/** B2 (a thread a lot): each building's door segment, from its footprint out to its street */
@compute @workgroup_size(64)
fn doors(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (r >= lotCount()) { return; }
  let d = doorOf(r);
  // (lots begun only: a lot not begun has no street drawn to it yet — the graph is made again when its district
  // starts; a rising lot is a building site, its builders need its door)
  if (!d.ok || PROG[r] <= 0.0) { return; }
  rasterWalk(d.at, d.street, 0.0, W_DOOR);
  // (the door's own column, which the 0.4 m samples can miss at a corner: where its routes start)
  let dc = doorCol(r);
  if (dc != NONE && walkClass(dc) == 0u) { atomicOr(&WALK[dc], W_DOOR); }
}

/** B2b (a thread a record: the lots, then the landmark sites): open ground people cross — a plaza's or a park's parcel, a
 *  landmark's circle — walkable pads (W_PAD) where its district is built. citygen clips its streets at a landmark's
 *  circle and lets a plaza's paving join them; without these the streets round a landmark were islands */
@compute @workgroup_size(64)
fn pads(@builtin(global_invocation_id) g: vec3<u32>) {
  var r = g.x;
  let nl = lotCount();
  if (r >= nl) {
    if (r - nl >= min(CNT[1], 64u)) { return; }
    r = u.m.y + (r - nl);
  }
  let kind = lotKind(r);
  if (kind != 2u && kind != 3u && kind != 4u) { return; }
  if (PROG[r] < 0.999) { return; }
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  for (var k = 0u; k < 4u; k++) { lo = min(lo, corner(r, k)); hi = max(hi, corner(r, k)); }
  let mid = 0.25 * (corner(r, 0u) + corner(r, 1u) + corner(r, 2u) + corner(r, 3u));
  let rad = distance(mid, corner(r, 0u));
  let y0 = max(i32(floor(lo.y / ROW_H)) - 1, 0);
  let y1 = min(i32(ceil(hi.y / ROW_H)) + 1, Hh() - 1);
  let x0 = max(i32(floor(lo.x)) - 1, 0);
  let x1 = min(i32(ceil(hi.x)) + 1, W() - 1);
  if ((x1 - x0) * (y1 - y0) > 4096) { return; }
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      let c = vec2<i32>(x, y);
      let p = cpos(c);
      var inside = true;
      if (kind == 4u) { inside = distance(p, mid) <= rad + 0.5; }
      else {
        for (var k = 0u; k < 4u; k++) {
          let a = corner(r, k);
          let e = corner(r, k + 1u) - a;
          if (e.x * (p.y - a.y) - e.y * (p.x - a.x) < -0.5 * length(e)) { inside = false; }
        }
      }
      if (inside && walkClass(ix(c)) == 0u) { atomicOr(&WALK[ix(c)], W_PAD); }
    }
  }
}

/** B3 (a thread a lot): the stores' and the granary's buildings — nearest the centre in their district (others only
 *  past every one of those) */
@compute @workgroup_size(64)
fn hubPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (r >= lotCount() || r >= 32768u) { return; }
  if (doorCol(r) == NONE || !built(r)) { return; }
  let m = lotMid(r);
  let dq = min(u32(distance(m, u.t.zw) * 2.0), 2047u);
  let pu = purposeAt(m);
  atomicMin(&LT[L_PICK + H_STORES], ((dq + select(2048u, 0u, pu == P_MARKET)) << 15u) | r);
  atomicMin(&LT[L_PICK + H_GRANARY], ((dq + select(2048u, 0u, pu == P_FARMS)) << 15u) | r);
}

/** B4 (a thread a column): the quarry's site, once — past the built core (0.55–1.1 radii from the centre), dry, off the
 *  roads, steep (exposed rock: the ground's slope is the stand-in until the columns are read), near */
@compute @workgroup_size(64)
fn quarryPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N() || lt(L_Q + Q_X0) != 0u) { return; }
  let c = cxy(i);
  let side = i32(clamp(u.q.x, 8.0, 96.0));
  let sideR = i32(ceil(f32(side) / ROW_H));
  if (c.x + side + 2 >= W() || c.y + sideR + 2 >= Hh() || c.x < 2 || c.y < 2) { return; }
  let mid = cpos(c) + vec2<f32>(f32(side), f32(side)) * 0.5;
  let dc = distance(mid, u.t.zw);
  // (past the built core — a game town starts with its core only — and near it: 0.55–1.1 radii)
  if (dc < 0.55 * u.r.x + f32(side) * 0.5 || dc > 1.1 * u.r.x + f32(side)) { return; }
  var slope = 0.0;
  var lo = 1e9;
  var hi = -1e9;
  for (var a = 0; a <= 4; a++) {
    for (var b = 0; b <= 4; b++) {
      let p = cpos(c) + vec2<f32>(f32(side) * f32(a) / 4.0, f32(side) * f32(b) / 4.0);
      let q = cat(p);
      if (!inBox(q)) { return; }
      let k = ix(q);
      if (ROADS[k] != 0u || WET[k] != 0u || (atomicLoad(&WALK[k]) & W_LOTGROUND) != 0u) { return; }
      let h = HT[k];
      lo = min(lo, h);
      hi = max(hi, h);
      let q2 = nbr(q, 1u);
      let q3 = nbr(q, 5u);
      if (inBox(q2) && inBox(q3)) { slope += abs(HT[ix(q2)] - h) + abs(HT[ix(q3)] - h); }
    }
  }
  // (rock: steep, but the footprint not a cliff face — a knoll's flank; near the town)
  if (hi - lo > f32(side) * 0.9) { return; }
  let score = slope / 25.0 * 100.0 - (dc - 0.55 * u.r.x) * 0.8 + rnd(i, 77u);
  let s = u32(clamp(score * 16.0 + 2048.0, 0.0, 16383.0));
  atomicMax(&LT[L_Q + Q_PICK], (s << 18u) | (i & 0x3ffffu));
}

/** B5 (one thread): the hubs' main columns from the picks; the quarry's site and rim; the camp's yard */
@compute @workgroup_size(1)
fn siteFix() {
  for (var h = 0u; h < 2u; h++) {
    let p = lt(L_PICK + h);
    setLt(L_HUBCOL + h, select(0u, doorCol(p & 0x7fffu) + 1u, p != NONE));
  }
  if (lt(L_Q + Q_X0) == 0u && (u.m.z & F_QUARRY) != 0u) {
    let p = lt(L_Q + Q_PICK);
    if (p != 0u) {
      let c = cxy(p & 0x3ffffu);
      setLt(L_Q + Q_X0, u32(c.x) + 1u);
      setLt(L_Q + Q_Y0, u32(c.y) + 1u);
    }
  }
  if (lt(L_Q + Q_X0) != 0u) {
    // (the rim: a column out of the footprint's first corner, where ramp 0 starts down side 0)
    let o = cpos(vec2<i32>(i32(lt(L_Q + Q_X0)) - 1, i32(lt(L_Q + Q_Y0)) - 1));
    let rim = cat(o + vec2<f32>(-1.5, -1.5));
    setLt(L_Q + Q_RIM, select(0u, ix(rim) + 1u, inBox(rim)));
    setLt(L_HUBCOL + H_QUARRY, lt(L_Q + Q_RIM));
  } else { setLt(L_HUBCOL + H_QUARRY, 0u); }
  setLt(L_HUBCOL + H_CAMP, lt(L_F + F_YARD));
}

/** B6 (a thread a lot): every lot's ground marked (W_LOTGROUND: the works keep off it, so no district grows over
 *  them), a standing building's footprint blocked (W_BLOCK: open ground's passages go round it) */
@compute @workgroup_size(64)
fn lotMask(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (r >= lotCount() || lotKind(r) == 0u) { return; }
  let block = lotKind(r) == REC_BUILDING && built(r);
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  for (var k = 0u; k < 4u; k++) { lo = min(lo, corner(r, k)); hi = max(hi, corner(r, k)); }
  let y0 = max(i32(floor(lo.y / ROW_H)) - 1, 0);
  let y1 = min(i32(ceil(hi.y / ROW_H)) + 1, Hh() - 1);
  let x0 = max(i32(floor(lo.x)) - 1, 0);
  let x1 = min(i32(ceil(hi.x)) + 1, W() - 1);
  if ((x1 - x0) * (y1 - y0) > 4096) { return; }
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      let p = cpos(vec2<i32>(x, y));
      var inP = true;
      var inF = true;
      for (var k = 0u; k < 4u; k++) {
        let a = corner(r, k);
        let e = corner(r, k + 1u) - a;
        if (e.x * (p.y - a.y) - e.y * (p.x - a.x) < 0.0) { inP = false; }
        let fa = fcorner(r, k);
        let fe = fcorner(r, k + 1u) - fa;
        if (fe.x * (p.y - fa.y) - fe.y * (p.x - fa.x) < 0.0) { inF = false; }
      }
      let i = ix(vec2<i32>(x, y));
      if (inP) { atomicOr(&WALK[i], W_LOTGROUND); }
      if (inF && block) { atomicOr(&WALK[i], W_BLOCK); }
    }
  }
}

/** B7 (a thread a column): the works' own ground as walkable pads: the quarry's rim yard (where its ramp starts and
 *  carts load), the camp's yard, and the clearing (open woods within its radius, dry, off any lot), over which the
 *  woodcutters' routes to their trees are traced. The connectivity check joins each to the roads by a passage */
@compute @workgroup_size(64)
fn sitePads(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N() || walkClass(i) != 0u || WET[i] != 0u) { return; }
  let p = cpos(cxy(i));
  for (var s = 0u; s < 2u; s++) {
    let hc = lt(L_HUBCOL + H_QUARRY + s);
    if (hc != 0u && distance(p, cpos(cxy(hc - 1u))) <= 2.6) { atomicOr(&WALK[i], W_PAD); return; }
  }
  let cc = lt(L_F + F_CAMP);
  if (cc != 0u && (u.m.z & F_FOREST) != 0u && distance(p, cpos(cxy(cc - 1u))) <= u.f.x && (atomicLoad(&WALK[i]) & (W_LOTGROUND | W_BLOCK)) == 0u) {
    atomicOr(&WALK[i], W_PAD);
  }
}

/** B8 (a thread a lot): the district hubs' seeds — every building's door in its district */
@compute @workgroup_size(64)
fn hubSeed(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (r >= lotCount()) { return; }
  let dc = doorCol(r);
  if (dc == NONE || !built(r)) { return; }
  let pu = purposeAt(lotMid(r));
  var h = NONE;
  if (pu == P_MARKET) { h = H_MARKET; } else if (pu == P_WORKSHOPS) { h = H_WORKSHOPS; } else if (pu == P_FARMS) { h = H_FARMS; }
  if (h == NONE) { return; }
  FIELD[h * N() + dc] = 0u;
  atomicAdd(&LT[L_SEEDS + h], 1u);
}

/** a column near c that's walkable (c's own first, then its rings to 3) */
fn snapWalk(c: vec2<i32>) -> u32 {
  if (inBox(c) && walkClass(ix(c)) != 0u) { return ix(c); }
  for (var r = 1; r <= 3; r++) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        let q = c + vec2<i32>(dx, dy);
        if (inBox(q) && walkClass(ix(q)) != 0u) { return ix(q); }
      }
    }
  }
  return NONE;
}

/** B9 (one thread): the single hubs' seeds (stores, granary, quarry, camp), the gates (each arterial's end), the
 *  district hubs with no building of their own seeded at the stores; then the phase: relaxing */
@compute @workgroup_size(1)
fn hubSeed1() {
  let st = lt(L_HUBCOL + H_STORES);
  for (var h = 0u; h < HUBS; h++) {
    if (h == H_STORES || h == H_GRANARY || h == H_QUARRY || h == H_CAMP) {
      let c = lt(L_HUBCOL + h);
      if (c != 0u) { FIELD[h * N() + c - 1u] = 0u; atomicAdd(&LT[L_SEEDS + h], 1u); }
    }
  }
  // (the gates: where each arterial ends — ART word o+3, its length to the town's limit)
  let na = min(ART[0] + ART[2], NART);
  for (var k = 0u; k < na; k++) {
    let o = 4u + k * AW;
    let n = min(ART[o], NAP);
    let lim = bitcast<f32>(ART[o + 3u]);
    var acc = 0.0;
    var at = vec2<f32>(-1.0);
    for (var j = 0u; j + 1u < n; j++) {
      let a = vec2<f32>(bitcast<f32>(ART[o + AP + 2u * j]), bitcast<f32>(ART[o + AP + 2u * j + 1u]));
      let b = vec2<f32>(bitcast<f32>(ART[o + AP + 2u * j + 2u]), bitcast<f32>(ART[o + AP + 2u * j + 3u]));
      let L = distance(a, b);
      if (acc + L >= lim) { at = mix(a, b, clamp((lim - acc) / max(L, 1e-4), 0.0, 1.0)); break; }
      acc += L;
      at = b;
    }
    if (at.x < 0.0) { continue; }
    let c = snapWalk(cat(at));
    if (c != NONE) { FIELD[H_GATES * N() + c] = 0u; atomicAdd(&LT[L_SEEDS + H_GATES], 1u); }
  }
  if (st != 0u) {
    for (var h = 0u; h < HUBS; h++) {
      if (lt(L_SEEDS + h) == 0u && h != H_QUARRY && h != H_CAMP) { FIELD[h * N() + st - 1u] = 0u; }
    }
  }
  setLt(L_PHASE, 1u);
  setLt(L_CHANGED, 1u);
}

/** B10 (a thread a hash slot): routes that failed traced again over the new graph */
@compute @workgroup_size(64)
fn hashScrub(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = g.x;
  if (s >= HASH) { return; }
  if (lt(L_HASH + s * 2u) != 0u && lt(L_HASH + s * 2u + 1u) == R_FAILED) {
    setLt(L_HASH + s * 2u + 1u, R_PENDING);
    let q = atomicAdd(&LT[L_TQ], 1u);
    if (q < TQ_ROOM) { setLt(L_TQL + q, s); }
  }
}

// ---- relaxing (phase 1) ----
/** a step's cost into a column of this class (1/16 m a metre: roads cheapest, tracks and doors dearer) */
fn stepCost(w: u32) -> u32 {
  switch w {
    case 1u, 2u: { return 16u; }
    case 3u: { return 28u; }
    case 4u, 5u: { return 20u; }
    default: { return NONE; }
  }
}
/** a sweep (a thread a column, every hub): each walkable column takes the least of its neighbours' + its step, in
 *  place (monotone: a value only falls to a path's true cost, so a neighbour's fresh or stale value are both safe) */
@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  if (lt(L_GPH) == 3u) { relaxOpen(i); return; }
  let cost = stepCost(walkClass(i));
  if (cost == NONE) { return; }
  let c = cxy(i);
  var moved = false;
  for (var h = 0u; h < HUBS; h++) {
    let o = h * N();
    var best = FIELD[o + i];
    for (var k = 0u; k < 6u; k++) {
      let q = nbr(c, k);
      if (!inBox(q)) { continue; }
      let v = FIELD[o + ix(q)];
      if (v != NONE && v + cost < best) { best = v + cost; }
    }
    if (best < FIELD[o + i]) { FIELD[o + i] = best; moved = true; }
  }
  if (moved) { atomicStore(&LT[L_CHANGED], 1u); }
}
/** before the frame's last sweep: the changed word cleared, so the last sweep says whether anything still moves */
@compute @workgroup_size(1)
fn relaxMark() {
  if (lt(L_RELAXING) == 1u) { setLt(L_CHANGED, 0u); atomicAdd(&LT[L_SWEEPS], 1u); }
}
/** after it: nothing moved — settled */
@compute @workgroup_size(1)
fn relaxCheck() {
  if (lt(L_RELAXING) == 1u && lt(L_CHANGED) == 0u) {
    if (lt(L_PHASE) == 1u) { setLt(L_PHASE, 2u); } else if (lt(L_PHASE) == 3u) { setLt(L_PHASE, 5u); }
  }
}

// ---- the connectivity check (DESIGN §13: reach is an invariant; phases 2, 3, 5) ----
// After the hubs settle, every walkable column the stores' field didn't reach is cut off. Each cut-off component
// (labelled by its least column) gets one passage: its cheapest way over open ground (dry, no building; dearer up a
// slope) to the network, laid as a track (W_PASS, kept across rebuilds); then the graph is made again. At most
// MAX_ROUNDS rounds; what's still cut off is counted (C_CUT_LEFT).
@compute @workgroup_size(1)
fn checkClear() {
  if (lt(L_GPH) != 2u) { return; }
  setLt(L_C + C_ORPHANS, 0u);
  setLt(L_C + C_DOORS_CUT, 0u);
}
/** (one thread, phases 2 and 5, after the counts) the round's end: the next phase */
@compute @workgroup_size(1)
fn checkStep() {
  let ph = lt(L_GPH);
  if (ph == 5u) {
    atomicAdd(&LT[L_C + C_ROUNDS], 1u);
    setLt(L_PHASE, 0u);
    return;
  }
  if (ph != 2u) { return; }
  let left = lt(L_C + C_ORPHANS);
  if (left == 0u || lt(L_C + C_ROUNDS) >= MAX_ROUNDS) {
    setLt(L_C + C_CUT_LEFT, left);
    setLt(L_PHASE, 4u);
  } else {
    setLt(L_PHASE, 3u);
    setLt(L_CHANGED, 1u);
  }
}
/** (a thread a column) phase 2: cut off or joined (the labels, the open ground's seeds); phase 5: each cut-off column
 *  beside reached open ground offers its way, the cheapest of its label kept */
@compute @workgroup_size(64)
fn checkCols(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  let ph = lt(L_GPH);
  let walkable = walkClass(i) != 0u;
  if (ph == 2u) {
    atomicStore(&PASS[i * 2u], NONE);
    atomicStore(&PASS[i * 2u + 1u], NONE);
    let cut = walkable && FIELD[H_STORES * N() + i] == NONE;
    if (cut) { atomicAdd(&LT[L_C + C_ORPHANS], 1u); }
    FIELD[P_LAB * N() + i] = select(NONE, i, cut);
    FIELD[P_OPEN * N() + i] = select(NONE, 0u, walkable && !cut);
    return;
  }
  if (ph != 5u) { return; }
  let lab = FIELD[P_LAB * N() + i];
  if (lab == NONE) { return; }
  let c = cxy(i);
  var best = NONE;
  for (var k = 0u; k < 6u; k++) {
    let q = nbr(c, k);
    if (!inBox(q)) { continue; }
    let v = FIELD[P_OPEN * N() + ix(q)];
    if (v != NONE && walkClass(ix(q)) == 0u) { best = min(best, v); }
  }
  if (best != NONE) { atomicMin(&PASS[lab * 2u], best); }
}
/** (phase 5) the least open column at its label's cheapest cost: where the passage leaves the component */
@compute @workgroup_size(64)
fn checkPick(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N() || lt(L_GPH) != 5u) { return; }
  let lab = FIELD[P_LAB * N() + i];
  if (lab == NONE) { return; }
  let c = cxy(i);
  let want = atomicLoad(&PASS[lab * 2u]);
  if (want == NONE) { return; }
  for (var k = 0u; k < 6u; k++) {
    let q = nbr(c, k);
    if (!inBox(q)) { continue; }
    if (walkClass(ix(q)) == 0u && FIELD[P_OPEN * N() + ix(q)] == want) { atomicMin(&PASS[lab * 2u + 1u], ix(q)); }
  }
}
/** (phase 5) a component's root lays its passage, down the open ground's field to the network */
@compute @workgroup_size(64)
fn checkLay(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N() || lt(L_GPH) != 5u || FIELD[P_LAB * N() + i] != i) { return; }
  var c = atomicLoad(&PASS[i * 2u + 1u]);
  if (c == NONE) { return; }
  for (var step = 0u; step < 4096u; step++) {
    let v = FIELD[P_OPEN * N() + c];
    if (v == 0u || v == NONE) { break; }
    atomicOr(&WALK[c], W_PASS);
    var best = v;
    var bi = c;
    let cc = cxy(c);
    for (var k = 0u; k < 6u; k++) {
      let q = nbr(cc, k);
      if (!inBox(q)) { continue; }
      let nv = FIELD[P_OPEN * N() + ix(q)];
      if (nv < best) { best = nv; bi = ix(q); }
    }
    if (bi == c) { break; }
    c = bi;
  }
  atomicAdd(&LT[L_C + C_PASSAGES], 1u);
}
/** (a thread a lot, phase 2) a built building whose door the stores don't reach */
@compute @workgroup_size(64)
fn checkDoors(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (r >= lotCount() || lt(L_GPH) != 2u || !built(r)) { return; }
  let dc = doorCol(r);
  if (dc == NONE) { return; }
  if (FIELD[H_STORES * N() + dc] == NONE) { atomicAdd(&LT[L_C + C_DOORS_CUT], 1u); }
}
/** (relax, phase 3) a sweep of the check: the cut-off labels spread (the least wins), the open ground's distance relaxed
 *  (dry, no building; a step dearer by its climb, so a passage follows the ground) */
fn relaxOpen(i: u32) {
  let c = cxy(i);
  let lab = FIELD[P_LAB * N() + i];
  if (lab != NONE) {
    var m = lab;
    for (var k = 0u; k < 6u; k++) {
      let q = nbr(c, k);
      if (!inBox(q)) { continue; }
      m = min(m, FIELD[P_LAB * N() + ix(q)]);
    }
    if (m < lab) { FIELD[P_LAB * N() + i] = m; atomicStore(&LT[L_CHANGED], 1u); }
    return;
  }
  if (walkClass(i) != 0u || (atomicLoad(&WALK[i]) & W_BLOCK) != 0u || WET[i] != 0u) { return; }
  var best = FIELD[P_OPEN * N() + i];
  let h = HT[i];
  for (var k = 0u; k < 6u; k++) {
    let q = nbr(c, k);
    if (!inBox(q)) { continue; }
    let v = FIELD[P_OPEN * N() + ix(q)];
    if (v == NONE) { continue; }
    let climb = u32(min(abs(HT[ix(q)] - h) * 96.0, 4096.0));
    if (v + 16u + climb < best) { best = v + 16u + climb; }
  }
  if (best < FIELD[P_OPEN * N() + i]) { FIELD[P_OPEN * N() + i] = best; atomicStore(&LT[L_CHANGED], 1u); }
}

// ---- cached routes ----
/** the route for (start column, hub): its id, R_PENDING while it's traced (asked here the first time), R_FAILED */
fn routeFor(col: u32, hub: u32) -> u32 {
  if (col == NONE || col >= N()) { return R_FAILED; }
  let key = (col + 1u) * HUBS + hub;
  var s = hash(key) % HASH;
  for (var p = 0u; p < 32u; p++) {
    let k = lt(L_HASH + s * 2u);
    if (k == key) { return lt(L_HASH + s * 2u + 1u); }
    if (k == 0u) {
      let r = atomicCompareExchangeWeak(&LT[L_HASH + s * 2u], 0u, key);
      if (r.exchanged) {
        setLt(L_HASH + s * 2u + 1u, R_PENDING);
        let q = atomicAdd(&LT[L_TQ], 1u);
        if (q < TQ_ROOM) { setLt(L_TQL + q, s); } else { setLt(L_HASH + s * 2u + 1u, R_FAILED); }
        return R_PENDING;
      }
      if (r.old_value == key) { return R_PENDING; }
    }
    s = (s + 1u) % HASH;
  }
  bump(C_MISS, 1u);
  return R_FAILED;
}
fn rFirst(r: u32) -> u32 { return RB[8u + rId(r) * 4u]; }
fn rCount(r: u32) -> u32 { return RB[8u + rId(r) * 4u + 1u]; }
fn rLen(r: u32) -> f32 { return bitcast<f32>(RB[8u + rId(r) * 4u + 2u]); }
/** a route's last point's column (where it ended: its hub's seed) */
fn rEndCol(r: u32) -> u32 {
  let p = pt(rFirst(r) + rCount(r) - 1u);
  let c = cat(p.xy);
  return select(NONE, ix(c), inBox(c));
}
/** a point on the route: the ground's height there (a road's paving over it), a deck's own */
fn pointZ(c: u32) -> f32 {
  let m = ROADS[c];
  if ((m & DECK_BIT) != 0u) { return f32(m & ~DECK_BIT) / 256.0; }
  return HT[c] + select(0.05, 0.27, m != 0u);
}

/** a route's id (the low 16 bits: the high are its half's generation, in a rider's word) */
fn rId(x: u32) -> u32 { return x & 0xffffu; }
fn halfOf(id: u32) -> u32 { return select(0u, 1u, id >= ROUTES / 2u); }
fn genOf(id: u32) -> u32 { return RB[halfOf(id)] & 0xffffu; }
/** np points and a route id in the current half: (first point, route id), or NONE when the half is full; three
 *  quarters full asks for the switch */
fn alloc(np: u32) -> vec2<u32> {
  let h = lt(L_HALF);
  let room = ptsRoom() / 2u;
  let at = atomicAdd(&LT[L_PTS], np);
  let rid = atomicAdd(&LT[L_ROUTES], 1u);
  if (at + np > room * 3u / 4u || rid >= ROUTES * 3u / 8u) { setLt(L_SWITCH, 1u); }
  if (at + np > room || rid >= ROUTES / 2u) { return vec2<u32>(NONE); }
  return vec2<u32>(h * room + at, h * (ROUTES / 2u) + rid);
}
/** (one thread, before the trace) the switch: the other half becomes the current one, its generation moves on (riders
 *  still on its old routes end their legs), every key is traced again (the hash cleared), the ramp made again */
@compute @workgroup_size(1)
fn poolSwitch() {
  setLt(L_CLEARHASH, 0u);
  if (lt(L_SWITCH) == 0u || lt(L_GPH) != 4u) { return; }
  let h = 1u - lt(L_HALF);
  setLt(L_HALF, h);
  RB[h] = RB[h] + 1u;
  setLt(L_PTS, 0u);
  setLt(L_ROUTES, 0u);
  setLt(L_SWITCH, 0u);
  setLt(L_TQ, 0u);
  setLt(L_Q + Q_RAMPV, 0u);
  setLt(L_Q + Q_RAMP, 0u);
  setLt(L_CLEARHASH, 1u);
  IND[27] = HASH / 64u;
  atomicAdd(&LT[L_C + C_SWITCHES], 1u);
}
@compute @workgroup_size(64)
fn hashClear(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= HASH || lt(L_CLEARHASH) == 0u) { return; }
  setLt(L_HASH + g.x * 2u, 0u);
  setLt(L_HASH + g.x * 2u + 1u, 0u);
}

/** (a thread a queued key, phase 2) traced down its hub's field: counted, room taken, written — a point every second
 *  step, the last always */
@compute @workgroup_size(64)
fn trace(@builtin(global_invocation_id) g: vec3<u32>) {
  let q = g.x;
  if (q >= min(lt(L_TQ), TQ_ROOM)) { return; }
  let s = lt(L_TQL + q);
  let key = lt(L_HASH + s * 2u);
  let hub = key % HUBS;
  let start = key / HUBS - 1u;
  let o = hub * N();
  if (FIELD[o + start] == NONE) { setLt(L_HASH + s * 2u + 1u, R_FAILED); bump(C_MISS, 1u); return; }
  // (count)
  var c = start;
  var n = 1u;
  for (var step = 0u; step < 4096u; step++) {
    let v = FIELD[o + c];
    if (v == 0u) { break; }
    var best = v;
    var bi = c;
    let cc = cxy(c);
    for (var k = 0u; k < 6u; k++) {
      let nq = nbr(cc, k);
      if (!inBox(nq)) { continue; }
      let nv = FIELD[o + ix(nq)];
      if (nv < best) { best = nv; bi = ix(nq); }
    }
    if (bi == c) { break; }
    c = bi;
    n++;
  }
  if (FIELD[o + c] != 0u) { setLt(L_HASH + s * 2u + 1u, R_FAILED); bump(C_MISS, 1u); return; }
  let np = (n + 1u) / 2u + 1u;
  let al = alloc(np);
  // (the half full: the key stays asked — traced again into the next half after the switch)
  if (al.x == NONE) { setLt(L_HASH + s * 2u + 1u, R_PENDING); bump(C_POOLFULL, 1u); return; }
  let first = al.x;
  let rid = al.y;
  // (write)
  c = start;
  var w = 0u;
  var acc = 0.0;
  var prev = cpos(cxy(start));
  setPt(first, vec4<f32>(prev, pointZ(start), 0.0));
  w = 1u;
  for (var step = 1u; step < n; step++) {
    let cc = cxy(c);
    var best = FIELD[o + c];
    var bi = c;
    for (var k = 0u; k < 6u; k++) {
      let nq = nbr(cc, k);
      if (!inBox(nq)) { continue; }
      let nv = FIELD[o + ix(nq)];
      if (nv < best) { best = nv; bi = ix(nq); }
    }
    c = bi;
    let p = cpos(cxy(c));
    if ((step & 1u) == 0u || step == n - 1u) {
      acc += distance(p, prev);
      prev = p;
      if (w < np) { setPt(first + w, vec4<f32>(p, pointZ(c), acc)); w++; }
    }
  }
  setHead(rid, first, w, acc, genOf(rid));
  setLt(L_HASH + s * 2u + 1u, rid | (genOf(rid) << 16u));
  bump(C_TRACED, 1u);
}
/** after the trace: the queue emptied (only when it was traced: phase 2) */
@compute @workgroup_size(1)
fn traceDone() {
  if (lt(L_TRACING) == 1u) { setLt(L_TQ, 0u); }
}

// ---- the quarry's ramp: a route made from the pit's shape (works.wgsl digs it) ----
/** the pit's numbers: per bench the inset it takes (ledge + the face's run), the face's run */
fn benchRun() -> f32 { return u.q2.y + u.q.y / tan(radians(clamp(u.q.w, 20.0, 80.0))); }
fn benchCount() -> u32 { return u32(clamp(floor(u.q.z / max(u.q.y, 0.5)), 1.0, 40.0)); }
/** the footprint's corner k (0–3, counter-clockwise from its first column's corner) inset by d */
fn pitCorner(k: u32, d: f32) -> vec2<f32> {
  let o = cpos(vec2<i32>(i32(lt(L_Q + Q_X0)) - 1, i32(lt(L_Q + Q_Y0)) - 1)) - vec2<f32>(0.5, 0.5 * ROW_H);
  let s = u.q.x;
  let c = array<vec2<f32>, 4>(vec2<f32>(d, d), vec2<f32>(s - d, d), vec2<f32>(s - d, s - d), vec2<f32>(d, s - d));
  return o + c[k & 3u];
}
/** (one thread) the ramp route when the working bench changed: from the rim down each bench's ramp (side k mod 4, the
 *  face's run as its width) and landing to the working bench's floor; z from the dug shape (world z: the ground's
 *  at the rim less the bench's depth) */
@compute @workgroup_size(1)
fn rampRoute() {
  if (lt(L_Q + Q_X0) == 0u) { return; }
  let bench = lt(L_Q + Q_BENCH);
  if (lt(L_Q + Q_RAMPV) == bench + 1u) { return; }
  let run = benchRun();
  let rimc = lt(L_Q + Q_RIM);
  if (rimc == 0u) { return; }
  let z0 = HT[rimc - 1u];
  let al = alloc(2u + bench * 2u + 3u);
  if (al.x == NONE) { bump(C_POOLFULL, 1u); return; }
  let first = al.x;
  let rid = al.y;
  var w = 0u;
  var acc = 0.0;
  var prev = cpos(cxy(rimc - 1u));
  setPt(first, vec4<f32>(prev, z0 + 0.05, 0.0));
  w = 1u;
  for (var k = 0u; k <= bench; k++) {
    // (bench k's ramp down side k mod 4, along the face's strip: from its corner k to corner k + 1, k benches in)
    // (the middle of the ramp's strip: works.wgsl rampWidth)
    let d = f32(k) * run + max(u.q.y / tan(radians(clamp(u.q.w, 20.0, 80.0))), 2.0) * 0.5;
    let a = pitCorner(k, d);
    let zA = z0 - f32(k) * u.q.y;
    acc += distance(a, prev);
    setPt(first + w, vec4<f32>(a, zA + 0.05, acc));
    w++;
    prev = a;
    if (k == bench) { break; }
    let b = pitCorner(k + 1u, d);
    acc += distance(b, prev);
    setPt(first + w, vec4<f32>(b, zA - u.q.y + 0.05, acc));
    w++;
    prev = b;
  }
  // (the bench's walkway: from the ramp's foot to the face's line across the working bench's floor, where the carts
  // load — the face moves along that line as the bench is dug)
  {
    let o = pitCorner(0u, 0.0);
    let ww = max(u.q.y / tan(radians(clamp(u.q.w, 20.0, 80.0))), 2.0);
    let wk = vec2<f32>(o.x + f32(bench) * run + ww, o.y + u.q.x * 0.5);
    acc += distance(wk, prev);
    setPt(first + w, vec4<f32>(wk, z0 - f32(bench) * u.q.y + 0.05, acc));
    w++;
    prev = wk;
  }
  setHead(rid, first, w, acc, genOf(rid));
  setLt(L_Q + Q_RAMP, (rid | (genOf(rid) << 16u)) + 1u);
  setLt(L_Q + Q_RAMPV, bench + 1u);
  setLtf(L_Q + Q_ENDX, prev.x);
  setLtf(L_Q + Q_ENDY, prev.y);
}

// ---- riders ----
// RID, 4 vec4s a rider (64 B):
//   0 x, y, z (grid world, world z), heading
//   1 (u32 bits) the behaviour word — byte 0 job, byte 1 state, byte 2 leg (0 none, 1 route forward, 2 back, 3 open
//     walk), byte 3 reserved (unused); then route id, cursor, home lot. Overrides are Track B's (`overridden`)
//   2 s (along the route), timer, load (m³ or logs), walk phase
//   3 the open leg's end x, y; aux (u32 bits: a claimed tree's column + 1, a site's record + 1), the job's column
//     (u32 bits: a farm's door, the base)
const J_COMMUTER: u32 = 0u;
const J_FARMER: u32 = 1u;
const J_QUARRY: u32 = 2u;
const J_STONE: u32 = 3u;
const J_WOOD: u32 = 4u;
const J_LOGS: u32 = 5u;
const J_BUILDER: u32 = 6u;
const J_NONE: u32 = 7u;
/** (season life) a trade route's wagons (a gate → a shop → back out) and ships (the box's edge → the quay → out) */
const J_WAGON: u32 = 8u;
const J_SHIP: u32 = 9u;

const LEG_NONE: u32 = 0u;
const LEG_FWD: u32 = 1u;
const LEG_BACK: u32 = 2u;
const LEG_OPEN: u32 = 3u;

struct Rider {
  pos: vec3<f32>,
  heading: f32,
  job: u32,
  st: u32,
  leg: u32,
  /** byte 3: reserved (kept as it is, never set here) */
  ovr: u32,
  route: u32,
  cursor: u32,
  home: u32,
  s: f32,
  timer: f32,
  load: f32,
  phase: f32,
  goal: vec2<f32>,
  aux: u32,
  col: u32,
};
/**
 * STUB — to be replaced by Track B's unitstate.wgsl `overridden(info)` (docs/design/UNIT_MINDS.md on trackB: the
 * override in the unit row's state bits, info 12–14) when the riders become unit rows (U5). Until then no rider has an
 * override; a test forces one rider's (P.pz.w = its index + 1) to check the job kernel's side of the interface.
 */
fn overridden(i: u32) -> bool { return u.pz.w > 0.5 && u32(u.pz.w) == i + 1u; }

fn loadRider(i: u32) -> Rider {
  let a = RID[i * 4u];
  let b = bitcast<vec4<u32>>(RID[i * 4u + 1u]);
  let c = RID[i * 4u + 2u];
  let d = RID[i * 4u + 3u];
  return Rider(a.xyz, a.w, b.x & 0xffu, (b.x >> 8u) & 0xffu, (b.x >> 16u) & 0xffu, b.x >> 24u, b.y, b.z, b.w, c.x, c.y, c.z, c.w, d.xy, bitcast<u32>(d.z), bitcast<u32>(d.w));
}
fn saveRider(i: u32, r: Rider) {
  RID[i * 4u] = vec4<f32>(r.pos, r.heading);
  RID[i * 4u + 1u] = bitcast<vec4<f32>>(vec4<u32>(r.job | (r.st << 8u) | (r.leg << 16u) | (r.ovr << 24u), r.route, r.cursor, r.home));
  RID[i * 4u + 2u] = vec4<f32>(r.s, r.timer, r.load, r.phase);
  RID[i * 4u + 3u] = vec4<f32>(r.goal, bitcast<f32>(r.aux), bitcast<f32>(r.col));
}
fn jobOf(i: u32) -> u32 {
  if (i < u.j0.x) { return J_COMMUTER; }
  if (i < u.j0.y) { return J_FARMER; }
  if (i < u.j0.z) { return J_QUARRY; }
  if (i < u.j0.w) { return J_STONE; }
  if (i < u.j1.x) { return J_WOOD; }
  if (i < u.j1.y) { return J_LOGS; }
  if (i < u.j1.z) { return J_BUILDER; }
  if (i < u.x.x) { return J_WAGON; }
  if (i < u.x.y) { return J_SHIP; }
  return J_NONE;
}

/** start a route leg: (col, hub) asked; false while it's being traced (or none: the rider idles a while) */
fn startRoute(r: ptr<function, Rider>, col: u32, hub: u32, dir: u32) -> bool {
  let id = routeFor(col, hub);
  if (id == R_PENDING) { return false; }
  if (id == R_FAILED) { (*r).timer = 5.0; bump(C_IDLE, 1u); return false; }
  return startRid(r, id, dir);
}
fn startRid(r: ptr<function, Rider>, id: u32, dir: u32) -> bool {
  // (an id carries its generation: a held route whose half was reused since is stale — the caller asks again)
  if ((id >> 16u) != genOf(rId(id)) || rCount(id) < 2u) { return false; }
  (*r).route = id;
  (*r).leg = dir;
  if (dir == LEG_FWD) { (*r).s = 0.0; (*r).cursor = 0u; } else { (*r).s = rLen(id); (*r).cursor = rCount(id) - 2u; }
  return true;
}
fn startOpen(r: ptr<function, Rider>, at: vec2<f32>) {
  (*r).goal = at;
  (*r).leg = LEG_OPEN;
}
/** the rider's spread across its road (its own offset, so riders on one route don't stand on one spot) */
fn spread(i: u32) -> f32 { return (rnd(i, 5u) - 0.5) * 2.0 * u.pz.z; }

/** a leg advanced by the frame; true when it ended */
fn advance(i: u32, r: ptr<function, Rider>, speed: f32) -> bool {
  let dt = u.t.x;
  if ((*r).leg == LEG_OPEN) {
    let d = (*r).goal - (*r).pos.xy;
    let L = length(d);
    let st = speed * dt;
    if (L <= st) { (*r).pos = vec3<f32>((*r).goal, (*r).pos.z); (*r).leg = LEG_NONE; return true; }
    (*r).pos = vec3<f32>((*r).pos.xy + d / L * st, (*r).pos.z);
    (*r).heading = atan2(d.y, d.x);
    (*r).phase += st;
    return false;
  }
  if ((*r).leg != LEG_FWD && (*r).leg != LEG_BACK) { return true; }
  let id = rId((*r).route);
  // (its half reused since it set out: the leg ends where it is — the next leg is asked afresh)
  if (((*r).route >> 16u) != genOf(id)) { (*r).leg = LEG_NONE; bump(C_STALE, 1u); return true; }
  let f = rFirst(id);
  let n = rCount(id);
  let len = rLen(id);
  let fwd = (*r).leg == LEG_FWD;
  (*r).s = clamp((*r).s + select(-1.0, 1.0, fwd) * speed * dt, 0.0, len);
  var k = min((*r).cursor, n - 2u);
  for (var g = 0u; g < 64u; g++) {
    if (fwd && k + 2u < n && pt(f + k + 1u).w < (*r).s) { k++; continue; }
    if (!fwd && k > 0u && pt(f + k).w > (*r).s) { k--; continue; }
    break;
  }
  (*r).cursor = k;
  let a = pt(f + k);
  let b = pt(f + k + 1u);
  let t = clamp(((*r).s - a.w) / max(b.w - a.w, 1e-4), 0.0, 1.0);
  let dir = select(a.xy - b.xy, b.xy - a.xy, fwd);
  let L = max(length(dir), 1e-4);
  let side = vec2<f32>(-dir.y, dir.x) / L;
  (*r).pos = vec3<f32>(mix(a.xy, b.xy, t) + side * spread(i), mix(a.z, b.z, t));
  (*r).heading = atan2(dir.y, dir.x);
  (*r).phase += speed * dt;
  let done = select((*r).s <= 0.0, (*r).s >= len, fwd);
  if (done) { (*r).leg = LEG_NONE; }
  return done;
}

/** a building lot dealt to rider i (its home): a hash over the lots, the first building found */
fn homeOf(i: u32) -> u32 {
  let n = lotCount();
  if (n == 0u) { return NONE; }
  var r = hash(i * 31u + 7u) % n;
  for (var k = 0u; k < 64u; k++) {
    if (doorCol(r) != NONE && built(r)) { return r; }
    r = (r + 1u) % n;
  }
  return NONE;
}
fn quarryOn() -> bool { return (u.m.z & F_QUARRY) != 0u && lt(L_Q + Q_RIM) != 0u; }
fn forestOn() -> bool { return (u.m.z & F_FOREST) != 0u && lt(L_F + F_YARD) != 0u; }
fn hubCol(h: u32) -> u32 { let c = lt(L_HUBCOL + h); return select(NONE, c - 1u, c != 0u); }
/** take a whole load from a counter (litres): true if one was there */
fn takeLoad(c: u32, amount: u32) -> bool {
  var have = lt(L_C + c);
  for (var k = 0u; k < 8u; k++) {
    if (have < amount) { return false; }
    let r = atomicCompareExchangeWeak(&LT[L_C + c], have, have - amount);
    if (r.exchanged) { return true; }
    have = r.old_value;
  }
  return false;
}

// states shared by the jobs
const S_INIT: u32 = 0u;
const S_REST: u32 = 1u;   // at home or base, a timer
const S_GO: u32 = 2u;     // riding out
const S_WORK: u32 = 3u;   // working, a timer
const S_BACK: u32 = 4u;   // riding home or to base
const S_RAMP: u32 = 5u;   // down the ramp
const S_FACE: u32 = 6u;   // walking to the face (open)
const S_UPFACE: u32 = 7u; // walking back to the ramp's foot (open)
const S_UPRAMP: u32 = 8u; // up the ramp
const S_HAUL: u32 = 9u;   // riding a load in
const S_LOAD: u32 = 10u;  // waiting for a load
const S_TREE: u32 = 11u;  // walking to a tree (open)
const S_FELL: u32 = 12u;  // the fell asked; waiting for its answer
const S_YARD: u32 = 13u;  // walking back to the yard (open)
const S_DROP: u32 = 14u;  // at a drop
const S_IDLE: u32 = 15u;
const S_TREEQ: u32 = 16u; // a tree claimed, its route asked

/** (a thread a rider, every frame) the rider's job, one step */
@compute @workgroup_size(64)
fn riders(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= u.n.z) { return; }
  var r = loadRider(i);
  // (an override set — Track B's DOWNED > FLEE > FIGHT: the job steps not at all this tick and its state isn't touched,
  // so it resumes by itself)
  if (overridden(i)) { return; }
  let dt = u.t.x;
  if (r.st == S_INIT && r.job == 0u && r.home == 0u) {
    // (a fresh row: dealt its job and home, placed at its door — or its base: the stores)
    r.job = jobOf(i);
    r.home = homeOf(i);
    r.timer = rnd(i, 3u) * 20.0;
    r.leg = LEG_NONE;
  }
  if (r.job == J_NONE || r.home == NONE || (u.m.z & F_ON) == 0u) { saveRider(i, r); return; }
  // (a ship is the ships kernel's: on the water, not the roads)
  if (r.job == J_SHIP) { saveRider(i, r); return; }
  let walk = u.r.y * (0.85 + 0.3 * rnd(i, 9u));
  let cart = u.r.z;
  let homeCol = doorCol(r.home);
  let st = hubCol(H_STORES);
  if (r.st == S_INIT) {
    let base = select(homeCol, st, r.job == J_STONE || r.job == J_LOGS || r.job == J_BUILDER);
    if (base == NONE) { saveRider(i, r); return; }
    r.pos = vec3<f32>(cpos(cxy(base)), pointZ(base));
    r.col = base;
    r.st = S_REST;
  }
  if (r.leg != LEG_NONE) {
    let sp = select(walk, cart, r.job == J_STONE || r.job == J_LOGS || r.job == J_WAGON);
    if (!advance(i, &r, sp)) { bump(C_RIDING, 1u); saveRider(i, r); return; }
    bump(C_ARRIVALS, 1u);
  }
  // (the leg, if any, has ended: the next step of the job)
  switch r.job {
    case J_COMMUTER: {
      let hub = select(H_MARKET, H_WORKSHOPS, rnd(i, 11u) < 0.5);
      let hub2 = select(hub, H_GATES, rnd(i, 12u) < 0.12);
      if (r.st == S_REST) {
        r.timer -= dt;
        if (r.timer <= 0.0 && startRoute(&r, homeCol, hub2, LEG_FWD)) { r.st = S_GO; }
      } else if (r.st == S_GO) {
        r.st = S_WORK; r.timer = u.r.w * (0.5 + rnd(i, u.n.w / 600u));
      } else if (r.st == S_WORK) {
        r.timer -= dt; bump(C_WORKING, 1u);
        if (r.timer <= 0.0 && (startRid(&r, r.route, LEG_BACK) || startRoute(&r, homeCol, hub2, LEG_BACK))) { r.st = S_BACK; }
      } else if (r.st == S_BACK) {
        r.st = S_REST; r.timer = u.r.w * (0.3 + rnd(i, 13u));
      }
    }
    case J_FARMER: {
      if (r.st == S_REST) {
        r.timer -= dt;
        if (r.timer <= 0.0 && startRoute(&r, homeCol, H_FARMS, LEG_FWD)) { r.st = S_GO; }
      } else if (r.st == S_GO) {
        r.col = rEndCol(r.route); r.st = S_WORK; r.timer = u.r.w * (0.6 + rnd(i, 14u));
      } else if (r.st == S_WORK) {
        r.timer -= dt; bump(C_WORKING, 1u);
        if (r.timer <= 0.0 && startRoute(&r, r.col, H_GRANARY, LEG_FWD)) { r.st = S_HAUL; r.load = 1.0; }
      } else if (r.st == S_HAUL) {
        bump(C_PRODUCE, 1u); r.load = 0.0; r.st = S_DROP;
      } else if (r.st == S_DROP) {
        if (startRoute(&r, homeCol, H_GRANARY, LEG_BACK)) { r.st = S_BACK; }
      } else if (r.st == S_BACK) {
        r.st = S_REST; r.timer = u.r.w * (0.3 + rnd(i, 15u));
      }
    }
    case J_QUARRY, J_STONE: {
      let hauler = r.job == J_STONE;
      if (!quarryOn()) { bump(C_IDLE, 1u); saveRider(i, r); return; }
      let rim = hubCol(H_QUARRY);
      let ramp = lt(L_Q + Q_RAMP);
      if (r.st == S_REST) {
        r.timer -= dt;
        // (the quarrymen from home: home → the rim; the carts from the stores: the rim's route to the stores, ridden back)
        if (r.timer <= 0.0) {
          if (hauler) {
            // (the carts the face's pile wants: one a two loads there, at least one, at most the stone carts)
            let want = clamp(lt(L_C + C_FACE) / max(u32(u.q2.z * 2000.0), 1u) + 1u, 1u, u.j0.w - u.j0.z);
            if (i - u.j0.z >= want) { r.timer = 2.0; }
            else if (startRoute(&r, rim, H_STORES, LEG_BACK)) { r.st = S_GO; }
          }
          else if (startRoute(&r, homeCol, H_QUARRY, LEG_FWD)) { r.st = S_GO; }
        }
      } else if (r.st == S_GO) {
        if (ramp != 0u && startRid(&r, ramp - 1u, LEG_FWD)) { r.st = S_RAMP; }
      } else if (r.st == S_RAMP) {
        let face = vec2<f32>(ltf(L_Q + Q_FACEX), ltf(L_Q + Q_FACEY));
        startOpen(&r, face + vec2<f32>(rnd(i, 20u) - 0.5, rnd(i, 21u) - 0.5) * 6.0);
        r.st = S_FACE;
      } else if (r.st == S_FACE) {
        if (hauler) { r.st = S_LOAD; r.timer = 0.0; } else { r.st = S_WORK; r.timer = u.r.w * (0.8 + rnd(i, 22u)); }
      } else if (r.st == S_WORK) {
        // (a quarryman at the face: the dig's budget, litres)
        r.timer -= dt; bump(C_WORKING, 1u);
        bump(C_DIGBUDGET, u32(u.q2.x * dt * 1000.0));
        if (r.timer <= 0.0) { startOpen(&r, vec2<f32>(ltf(L_Q + Q_ENDX), ltf(L_Q + Q_ENDY))); r.st = S_UPFACE; }
      } else if (r.st == S_LOAD && hauler) {
        let ld = u32(u.q2.z * 1000.0);
        if (takeLoad(C_FACE, ld)) {
          bump(C_CART_STONE, ld); r.load = u.q2.z;
          startOpen(&r, vec2<f32>(ltf(L_Q + Q_ENDX), ltf(L_Q + Q_ENDY))); r.st = S_UPFACE;
        } else { r.timer += dt; bump(C_IDLE, 1u); }
      } else if (r.st == S_UPFACE) {
        if (ramp != 0u && startRid(&r, ramp - 1u, LEG_BACK)) { r.st = S_UPRAMP; }
      } else if (r.st == S_UPRAMP) {
        if (hauler) { if (startRoute(&r, rim, H_STORES, LEG_FWD)) { r.st = S_HAUL; } }
        else if (startRoute(&r, homeCol, H_QUARRY, LEG_BACK)) { r.st = S_BACK; }
      } else if (r.st == S_HAUL) {
        // (the stone into the stores' inbox: works.wgsl's pile puts it into the world)
        let ld = u32(r.load * 1000.0);
        atomicSub(&LT[L_C + C_CART_STONE], ld);
        bump(C_INBOX, ld);
        r.load = 0.0;
        r.st = S_REST; r.timer = 2.0;
      } else if (r.st == S_BACK) {
        r.st = S_REST; r.timer = u.r.w * (0.3 + rnd(i, 23u));
      }
    }
    case J_WOOD, J_LOGS: {
      let cutter = r.job == J_WOOD;
      if (!forestOn()) { if (r.leg == LEG_NONE) { bump(C_IDLE, 1u); } saveRider(i, r); return; }
      let yard = hubCol(H_CAMP);
      if (r.st == S_REST) {
        r.timer -= dt;
        if (r.timer <= 0.0) {
          if (cutter) { if (startRoute(&r, homeCol, H_CAMP, LEG_FWD)) { r.st = S_GO; } }
          else {
            // (the log carts the camp's pile wants: one a two loads there, at least one, at most the log carts)
            let want = clamp(lt(L_C + C_LOG_CAMP) / 8u + 1u, 1u, u.j1.y - u.j1.x);
            if (i - u.j1.x >= want) { r.timer = 2.0; }
            else if (startRoute(&r, yard, H_STORES, LEG_BACK)) { r.st = S_GO; }
          }
        }
      } else if (r.st == S_GO || r.st == S_DROP) {
        if (cutter) {
          // (a tree claimed off the clearing's list: its column, swapped for 0)
          let n = min(lt(L_C + C_TREES), TREE_ROOM);
          var got = 0u;
          for (var k = 0u; k < 4u && got == 0u; k++) {
            let at = atomicAdd(&LT[L_C + C_TREECUR], 1u);
            if (at >= n) { break; }
            got = atomicExchange(&LT[L_TREES + at], 0u);
          }
          if (got != 0u) {
            r.aux = got;
            r.st = S_TREEQ;
          } else { r.timer -= dt; bump(C_IDLE, 1u); if (r.timer < -20.0 && startRoute(&r, homeCol, H_CAMP, LEG_BACK)) { r.st = S_BACK; } }
        } else {
          r.st = S_LOAD;
        }
      } else if (r.st == S_TREEQ) {
        // (the tree's route: traced from its column down the camp's field over the clearing, ridden from the yard)
        if (startRoute(&r, r.aux - 1u, H_CAMP, LEG_BACK)) { r.st = S_TREE; }
      } else if (r.st == S_TREE) {
        r.st = S_WORK; r.timer = u.f.y * (0.8 + 0.4 * rnd(i, 30u));
      } else if (r.st == S_WORK) {
        r.timer -= dt; bump(C_WORKING, 1u);
        if (r.timer <= 0.0) {
          // (the fell as an op: works.wgsl fellApply cuts it to a stump and gives the rider its logs)
          let q = atomicAdd(&LT[L_FELL], 1u);
          if (q < FELL_ROOM) { setLt(L_FELL + 1u + q, i + 1u); r.st = S_FELL; r.load = -1.0; }
        }
      } else if (r.st == S_FELL) {
        if (r.load >= 0.0 && (startRid(&r, r.route, LEG_FWD) || startRoute(&r, r.aux - 1u, H_CAMP, LEG_FWD))) { r.st = S_YARD; }
      } else if (r.st == S_YARD) {
        bump(C_LOG_CAMP, u32(r.load)); r.load = 0.0; r.aux = 0u; r.st = S_DROP; r.timer = 0.0;
      } else if (r.st == S_LOAD) {
        // (a log cart at the yard: a load taken, then the yard's route to the stores ridden)
        if (r.load <= 0.0) {
          if (takeLoad(C_LOG_CAMP, 4u)) { bump(C_LOG_CART, 4u); r.load = 4.0; } else { bump(C_IDLE, 1u); }
        }
        if (r.load > 0.0 && startRoute(&r, yard, H_STORES, LEG_FWD)) { r.st = S_HAUL; }
      } else if (r.st == S_HAUL) {
        atomicSub(&LT[L_C + C_LOG_CART], u32(r.load)); bump(C_LOG_STORES, u32(r.load)); r.load = 0.0;
        r.st = S_REST; r.timer = 3.0;
      } else if (r.st == S_BACK) {
        r.st = S_REST; r.timer = u.r.w * (0.5 + rnd(i, 31u));
      }
    }
    case J_BUILDER: {
      if (r.st == S_REST) {
        r.timer -= dt;
        let n = min(lt(L_C + C_SITES), SITE_ROOM);
        if (r.timer <= 0.0 && n > 0u) {
          let site = lt(L_SITES + hash(i + u.n.w / 900u) % n);
          if (startRoute(&r, doorCol(site), H_STORES, LEG_BACK)) { r.aux = site + 1u; r.st = S_GO; }
        } else if (r.timer <= 0.0) { r.timer = 3.0; bump(C_IDLE, 1u); }
      } else if (r.st == S_GO) {
        r.st = S_WORK; r.timer = u.r.w;
      } else if (r.st == S_WORK) {
        r.timer -= dt; bump(C_WORKING, 1u);
        // (the site's progress is the construction owner's — citygen's time-lapse sets it on the GPU each frame; a
        // builder works while it's rising and leaves once it's built)
        let p = PROG[r.aux - 1u];
        if (p < 1.0) { bump(C_BUILDWORK, 1u); }
        if ((r.timer <= 0.0 || p >= 1.0) && (startRid(&r, r.route, LEG_FWD) || startRoute(&r, doorCol(r.aux - 1u), H_STORES, LEG_FWD))) { r.st = S_BACK; }
      } else if (r.st == S_BACK) {
        r.st = S_REST; r.timer = 2.0 + rnd(i, 40u) * 4.0;
      }
    }
    case J_WAGON: {
      // (season life: a trade route's wagon — away (S_REST, not drawn), in through a gate along the roads to its shop
      // (its home lot's door: the gate nearest it, the GATES field ridden backwards), unloading, out the same way)
      if (r.st == S_REST) {
        r.timer -= dt;
        if (r.timer <= 0.0 && startRoute(&r, homeCol, H_GATES, LEG_BACK)) { r.st = S_HAUL; r.load = 1.0; }
      } else if (r.st == S_HAUL) {
        r.st = S_DROP; r.timer = u.r.w * (0.6 + rnd(i, 41u) * 0.6); bump(C_PRODUCE, 1u);
      } else if (r.st == S_DROP) {
        r.timer -= dt;
        if (r.timer <= 0.0 && (startRid(&r, r.route, LEG_FWD) || startRoute(&r, homeCol, H_GATES, LEG_FWD))) { r.st = S_GO; r.load = 0.0; }
      } else if (r.st == S_GO) {
        r.st = S_REST; r.timer = 20.0 + rnd(i, u.n.w / 600u + 42u) * 40.0;
      }
    }
    default: {}
  }
  saveRider(i, r);
}

/** (a thread a lot, every 30 frames) the building sites: lots whose progress is under 1 */
@compute @workgroup_size(64)
fn sites(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (r >= lotCount()) { return; }
  // (a site: a building under way — its progress between 0 and 1, read here on the GPU)
  let p = PROG[r];
  if (lotKind(r) != REC_BUILDING || p <= 0.0 || p >= 1.0 || doorCol(r) == NONE) { return; }
  let k = atomicAdd(&LT[L_C + C_SITES], 1u);
  if (k < SITE_ROOM) { setLt(L_SITES + k, r); }
}
@compute @workgroup_size(1)
fn sitesClear() { setLt(L_C + C_SITES, 0u); }

// ---- the figures: each rider as a few voxels in the bodies' format (render.wgsl vsBody) ----
const M_STONE: u32 = 1u;
const M_RUBBLE: u32 = 4u;
const M_RUST: u32 = 7u;
const M_LEAVES: u32 = 9u;
const M_WOOD: u32 = 10u;
const M_BRICK: u32 = 11u;
const M_FLOWER: u32 = 15u;
const M_STEEL: u32 = 20u;
const M_CANVAS: u32 = 21u;
const M_BASALT: u32 = 23u;
const M_LOG: u32 = 29u;
const M_FLESH: u32 = 33u;
const M_SAND: u32 = 3u;
fn torsoOf(j: u32) -> u32 {
  switch j {
    case 0u: { return M_CANVAS; }
    case 1u: { return M_FLOWER; }
    case 2u: { return M_RUST; }
    case 3u: { return M_STEEL; }
    case 4u: { return M_LEAVES; }
    case 5u: { return M_WOOD; }
    default: { return M_BRICK; }
  }
}
@compute @workgroup_size(1)
fn figuresClear() {
  atomicStore(&VARGS[0], 36u);
  atomicStore(&VARGS[1], 0u);
  atomicStore(&VARGS[2], 0u);
  atomicStore(&VARGS[3], 0u);
}
fn vox(at: vec3<f32>, mat: u32, size: u32, yaw: f32) {
  let k = atomicAdd(&VARGS[1], 1u);
  if (k * 2u + 1u >= arrayLength(&VOX)) { return; }
  VOX[k * 2u] = vec4<u32>(bitcast<u32>(at.x), bitcast<u32>(at.y), bitcast<u32>(at.z), (mat & 0xffu) | ((size & 63u) << 24u));
  VOX[k * 2u + 1u] = vec4<u32>(0u, 0u, bitcast<u32>(sin(yaw * 0.5)), bitcast<u32>(cos(yaw * 0.5)));
}
/** (a thread a rider) its voxels, placed in the window (culled to it) */
@compute @workgroup_size(64)
fn figures(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= u.n.z || (u.m.z & F_ON) == 0u) { return; }
  let r = loadRider(i);
  if (r.job == J_NONE || r.st == S_INIT || r.home == NONE) { return; }
  // (at rest at home: inside; a wagon or a ship away: off the map)
  if (r.st == S_REST && r.leg == LEG_NONE && (r.job == J_COMMUTER || r.job == J_FARMER || r.job == J_QUARRY || r.job == J_WOOD || r.job == J_WAGON || r.job == J_SHIP)) { return; }
  let wp = vec3<f32>(r.pos.xy + vec2<f32>(f32(u.pl.x), f32(u.pl.y) * ROW_H), r.pos.z + u.pz.x);
  if (wp.x < 1.0 || wp.y < 1.0 || wp.x > f32(u.pl.z) - 1.0 || wp.y > f32(u.pl.w) * ROW_H - 1.0) { return; }
  let h = r.heading;
  if (r.job == J_SHIP) {
    shipVox(wp, h, i);
    return;
  }
  let fw = vec2<f32>(cos(h), sin(h));
  let sd = vec2<f32>(-fw.y, fw.x);
  let moving = r.leg != LEG_NONE;
  let sw = select(0.0, sin(r.phase * 4.0) * 0.14, moving);
  // (working: a bob, a swing)
  let bob = select(0.0, abs(sin(u.t.y * 6.0 + f32(i))) * 0.12, r.st == S_WORK);
  vox(wp + vec3<f32>(fw * sw + sd * 0.11, 0.19), M_BASALT, 6u, h);
  vox(wp + vec3<f32>(-fw * sw - sd * 0.11, 0.19), M_BASALT, 6u, h);
  vox(wp + vec3<f32>(0.0, 0.0, 0.66 - bob * 0.5), torsoOf(r.job), 9u, h);
  vox(wp + vec3<f32>(fw * bob, 1.13 - bob), M_FLESH, 6u, h);
  let cartJob = r.job == J_STONE || r.job == J_LOGS || r.job == J_WAGON;
  if (cartJob) {
    // (a cart pushed ahead: its bed, and the load on it)
    vox(wp + vec3<f32>(fw * 0.9, 0.35), M_WOOD, 10u, h);
    vox(wp + vec3<f32>(fw * 1.45, 0.35), M_WOOD, 10u, h);
    if (r.load > 0.0) {
      let lm = select(select(M_LOG, M_RUBBLE, r.job == J_STONE), M_CANVAS, r.job == J_WAGON);
      vox(wp + vec3<f32>(fw * 0.9, 0.8), lm, 9u, h);
      vox(wp + vec3<f32>(fw * 1.45, 0.8), lm, 9u, h);
    }
  } else if (r.load > 0.0) {
    let lm = select(M_SAND, M_LOG, r.job == J_WOOD);
    vox(wp + vec3<f32>(-fw * 0.3, 0.95), lm, 7u, h);
  }
  if (r.job == J_WOOD && r.st == S_WORK) {
    // (the tree coming down: a trunk leaning further as the cut goes on, falling over its last second)
    let c = cxy(r.aux - 1u);
    let base = vec3<f32>(cpos(c) + vec2<f32>(f32(u.pl.x), f32(u.pl.y) * ROW_H), wp.z);
    let tt = clamp(1.0 - r.timer / max(u.f.y, 0.1), 0.0, 1.0);
    let lean = select(tt * 0.15, 0.15 + (tt - 0.85) / 0.15 * 1.42, tt > 0.85);
    let dirc = normalize(cpos(c) - r.pos.xy + vec2<f32>(0.001, 0.0));
    for (var k = 0u; k < 6u; k++) {
      let l = 0.5 + f32(k) * 0.9;
      vox(base + vec3<f32>(dirc * sin(lean) * l, cos(lean) * l), M_LOG, 8u, h);
    }
  }
}

/** (?livingdebug=1, a thread a column) the graph over the town: a small block on each walkable column — quartz reached
 *  from the stores, lava cut off, flesh a door, sand a passage the check laid, steel a deck, flowers a pad */
@compute @workgroup_size(64)
fn overlay(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N() || (u.m.z & F_DEBUG) == 0u) { return; }
  let w = atomicLoad(&WALK[i]);
  let cls = w & 0xfu;
  if (cls == 0u) { return; }
  let c = cxy(i);
  let wp = vec3<f32>(cpos(c) + vec2<f32>(f32(u.pl.x), f32(u.pl.y) * ROW_H), pointZ(i) + u.pz.x + 0.5);
  if (wp.x < 1.0 || wp.y < 1.0 || wp.x > f32(u.pl.z) - 1.0 || wp.y > f32(u.pl.w) * ROW_H - 1.0) { return; }
  var m = 36u;
  if (FIELD[H_STORES * N() + i] == NONE) { m = 24u; }
  else if (cls == W_DOOR) { m = 33u; }
  else if ((w & W_PASS) != 0u) { m = 3u; }
  else if (cls == W_DECK) { m = 20u; }
  else if (cls == W_PAD) { m = 15u; }
  vox(wp, m, 10u, 0.0);
}

// ---- the passages drawn (LT-F8): dirt road in citygen's own mesh format and tone, made with the graph (phase 0) ----
/** citygen's dirt tone (gpu.ts ROAD_TONES[1] × 0.95, its minor streets'), as its rgb word */
const DIRT_RGB: u32 = 0x8f7a60u;
@compute @workgroup_size(1)
fn passMeshClear() {
  atomicStore(&PARGS[0], 0u);
  atomicStore(&PARGS[1], 1u);
  atomicStore(&PARGS[2], 0u);
  atomicStore(&PARGS[3], 0u);
}
fn pv(at: u32, p: vec3<f32>) {
  let o = at * 8u;
  PMESH[o] = bitcast<u32>(p.x);
  PMESH[o + 1u] = bitcast<u32>(p.y);
  PMESH[o + 2u] = bitcast<u32>(p.z);
  PMESH[o + 3u] = DIRT_RGB;
  PMESH[o + 4u] = 0u;
  PMESH[o + 5u] = 0u;
  PMESH[o + 6u] = bitcast<u32>(1.0);
  PMESH[o + 7u] = 0u;
}
/** (a thread a column) a passage's column as a flat hexagon of dirt over the ground (citygen's paving lift) */
@compute @workgroup_size(64)
fn passMesh(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N()) { return; }
  let w = atomicLoad(&WALK[i]);
  if ((w & W_PASS) == 0u || (w & 0xfu) != W_TRACK) { return; }
  let at = atomicAdd(&PARGS[0], 18u);
  if ((at + 18u) * 8u > arrayLength(&PMESH)) { atomicSub(&PARGS[0], 18u); return; }
  let c = cpos(cxy(i));
  let z = HT[i] + 0.22;
  for (var k = 0u; k < 6u; k++) {
    let a0 = 0.5235988 + f32(k) * 1.0471976;
    let a1 = a0 + 1.0471976;
    pv(at + k * 3u, vec3<f32>(c, z));
    pv(at + k * 3u + 1u, vec3<f32>(c + vec2<f32>(cos(a0), sin(a0)) * 0.62, z));
    pv(at + k * 3u + 2u, vec3<f32>(c + vec2<f32>(cos(a1), sin(a1)) * 0.62, z));
  }
}

// ---- season life: ships on the water (docs/design/SEASON_LOOP.md "Season life" 3) ----
// A distance field over the box's open water (P_SEA: 1/16 unit a step) from the water beside the harbour district's
// built lots, relaxed in place a few sweeps a frame (it settles in a second or two; the graph's rebuild clears it and
// it's seeded again). A ship is a rider (J_SHIP) moved here, not by `riders` (whose eight storage buffers are taken):
// away (S_REST, not drawn) for a while, then in at the box's edge where the field reaches, down the field a column at
// a time to the quay (S_HAUL), moored (S_DROP), and out up the field to the edge (S_GO), away again.
/** (a thread a record, every 30 frames) the harbour's quays: the water within reach of each built harbour lot */
@compute @workgroup_size(64)
fn seaSeed(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = g.x;
  if (r >= lotCount() || u.x.y <= u.x.x) { return; }
  if (lotKind(r) != REC_BUILDING || !built(r) || (REC[r * RECW + 18u] >> 24u) != P_HARBOUR) { return; }
  let c0 = cat(lotMid(r));
  for (var dy = -QUAY_R; dy <= QUAY_R; dy++) {
    for (var dx = -QUAY_R; dx <= QUAY_R; dx++) {
      let c = c0 + vec2<i32>(dx, dy);
      if (!inBox(c) || WET[ix(c)] == 0u) { continue; }
      FIELD[P_SEA * N() + ix(c)] = 0u;
    }
  }
}
/** (a thread a column, a few times a frame while there are ships) the sea field relaxed one step (in place) */
@compute @workgroup_size(64)
fn seaRelax(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= N() || u.x.y <= u.x.x || WET[i] == 0u) { return; }
  let c = cxy(i);
  var best = FIELD[P_SEA * N() + i];
  for (var k = 0u; k < 6u; k++) {
    let q = nbr(c, k);
    if (!inBox(q) || WET[ix(q)] == 0u) { continue; }
    let f = FIELD[P_SEA * N() + ix(q)];
    if (f != NONE && f + 16u < best) { best = f + 16u; }
  }
  FIELD[P_SEA * N() + i] = best;
}
fn seaAt(c: vec2<i32>) -> u32 {
  if (!inBox(c) || WET[ix(c)] == 0u) { return NONE; }
  return FIELD[P_SEA * N() + ix(c)];
}
/** (a thread a ship) one step */
@compute @workgroup_size(64)
fn ships(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = u.x.x + g.x;
  if (i >= u.x.y || i >= u.n.z || (u.m.z & F_ON) == 0u) { return; }
  var r = loadRider(i);
  if (r.job != J_SHIP) { return; }
  let dt = u.t.x;
  let speed = u.r.z * 1.6;
  if (r.st == S_INIT || r.st == S_REST) {
    r.st = S_REST;
    r.leg = LEG_NONE;
    r.timer -= dt;
    if (r.timer <= 0.0) {
      // (in at the box's edge where the field reaches: a few tries a frame)
      for (var t = 0u; t < 8u; t++) {
        let h = hash(i * 7919u + u.n.w * 31u + t);
        let side = h & 3u;
        let along = i32((h >> 2u) % u32(max(W(), Hh())));
        var c = vec2<i32>(along, 0);
        if (side == 1u) { c = vec2<i32>(along, Hh() - 1); }
        if (side == 2u) { c = vec2<i32>(0, along); }
        if (side == 3u) { c = vec2<i32>(W() - 1, along); }
        if (seaAt(c) != NONE) {
          r.pos = vec3<f32>(cpos(c), HT[ix(c)] + SHIP_DRAFT);
          r.st = S_HAUL;
          r.load = 1.0;
          break;
        }
      }
      if (r.st == S_REST) { r.timer = 0.5; }
    }
    saveRider(i, r);
    return;
  }
  let c = cat(r.pos.xy);
  let f = seaAt(c);
  if (r.st == S_DROP) {
    r.leg = LEG_NONE;
    r.timer -= dt;
    if (r.timer <= 0.0) { r.st = S_GO; r.load = 0.0; }
    saveRider(i, r);
    return;
  }
  // (in: down the field; out: up it — the neighbour lowest or highest, steered to its middle)
  let inward = r.st == S_HAUL;
  if (inward && f != NONE && f <= MOOR) {
    r.st = S_DROP;
    r.timer = u.r.w * 3.0;
    saveRider(i, r);
    return;
  }
  var best = c;
  var bf = select(0u, NONE, inward);
  if (f != NONE) { bf = f; }
  for (var k = 0u; k < 6u; k++) {
    let q = nbr(c, k);
    let fq = seaAt(q);
    if (fq == NONE) { continue; }
    if ((inward && fq < bf) || (!inward && fq > bf)) { bf = fq; best = q; }
  }
  let edge = c.x <= 0 || c.y <= 0 || c.x >= W() - 1 || c.y >= Hh() - 1;
  if (!inward && (all(best == c) || edge)) {
    // (out at the edge, or nowhere further: away a while)
    r.st = S_REST;
    r.timer = 25.0 + rnd(i, u.n.w / 600u) * 40.0;
    saveRider(i, r);
    return;
  }
  if (all(best == c) && f == NONE) {
    // (off the water — the field rebuilt under it: back to the edge next time)
    r.st = S_REST;
    r.timer = 2.0;
    saveRider(i, r);
    return;
  }
  let to = cpos(best);
  let d = to - r.pos.xy;
  let L = length(d);
  let st = min(L, speed * dt);
  if (L > 1e-4) {
    let h = atan2(d.y, d.x);
    // (turn smoothly toward the next column)
    var dh = h - r.heading;
    dh = dh - round(dh / 6.2831853) * 6.2831853;
    r.heading += clamp(dh, -2.0 * dt, 2.0 * dt);
    r.pos = vec3<f32>(r.pos.xy + d / L * st, mix(r.pos.z, HT[ix(best)] + SHIP_DRAFT, 0.1));
  }
  r.leg = LEG_OPEN;
  r.phase += st;
  saveRider(i, r);
}
/** a ship's voxels: a hull of five along its heading, a cabin, a mast and its sail */
fn shipVox(wp: vec3<f32>, h: f32, i: u32) {
  let fw = vec2<f32>(cos(h), sin(h));
  let sd = vec2<f32>(-fw.y, fw.x);
  // (a hull of five big voxels along its heading — about 9 units — tapered at bow and stern; a cabin aft; a mast and
  // a square sail across it)
  for (var k = 0; k < 5; k++) {
    let a = f32(k - 2) * 1.8;
    vox(wp + vec3<f32>(fw * a, 0.0), M_WOOD, select(30u, 22u, k == 0 || k == 4), h);
  }
  vox(wp + vec3<f32>(-fw * 2.6, 1.4), M_WOOD, 18u, h);
  for (var k = 0; k < 4; k++) { vox(wp + vec3<f32>(fw * 0.4, 1.4 + f32(k) * 1.3), M_WOOD, 7u, h); }
  vox(wp + vec3<f32>(fw * 0.6, 3.6), M_CANVAS, 44u, h + 1.5708);
}
