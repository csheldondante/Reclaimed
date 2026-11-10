// ---- places.wgsl: a town's named places resolved on the GPU from citygen's records (towncontracts/contracts.ts) ----
// Appended to common.wgsl. One town a set of dispatches when its inputs change (a few thousand threads: the lots' room);
// nothing is read back. Inputs are citygen's contract buffers (api/contracts/citygen.ts: CityLots, CityRoutes), a small
// uniform the CPU writes only when its contents change (where the grid is, the claimed purposes: a slide, a claim, a new
// town) and the towns' clock (CLK). Output: the town's slot of the place table, read by src/shaders/townplace.wgsl (keep
// its layout constants in step with TP_* here).
//
//   plWatch   (a thread a record, and the ring's and arterials' words) a sum of hashes of what a solve reads: each
//             record's words and its progress's class (not begun, rising, built), the counts, the ring, the arterials
//   plWake    (one thread) a solve when the sum moved, the uniform's version moved, or the clock passed the last solve's
//             wake clock (a gate's wall crossing "up"); the eight kernels below are indirect dispatches, 0 workgroups
//             when nothing woke one (UC-8: they ran every frame before)
//   plClear   the slot's district index, purposes, fill counters and picks cleared
//   plCount   (a thread a record) each lot counted into its (district, kind) bin; the district's purpose; stage A picks'
//             keys (stores, market, keep, muster: an atomic min)
//   plScan    (one workgroup) the bins' first entries (an exclusive scan), counts clamped to the room
//   plScatter (a thread a record) each lot into its bin's list (any order); stage A picks' seeds among the best keys
//   plRank    (a thread a record) its rank in its bin by (growth key, seed) — never the record's index, which follows the
//             GPU's thread order — and its entry written there; stage A picks' entries; stage B's key (the barracks:
//             the keep's seed now known)
//   plSeedB, plWriteB  stage B's seed and entry
//   plHead    (one thread) the header, the gates (routeread's slot rule from the wall's words), the spawn points,
//             every pick nobody won marked NONE, and the wake clock: the first clock a gate's status flips at

@group(0) @binding(3) var<storage, read> REC: array<u32>;
@group(0) @binding(4) var<storage, read> CNT: array<u32>;
@group(0) @binding(5) var<storage, read> PROG: array<f32>;
@group(0) @binding(6) var<storage, read> POP: array<f32>;
@group(0) @binding(7) var<storage, read> WALLW: array<u32>;
@group(0) @binding(8) var<storage, read> ART: array<u32>;
@group(0) @binding(9) var<storage, read> HT: array<f32>;
@group(0) @binding(10) var<storage, read_write> PT: array<atomic<u32>>;

struct TownP {
  /** x y the grid's columns and rows, z the town's slot, w its generation (moves on when the slot gets a town) */
  dims: vec4<u32>,
  /** the grid's place in the window: x, y (world units), z (window z less world z) */
  place: vec4<f32>,
  /** the town's centre (the grid's frame), its radius; w unused (the clock is CLK's: it moves every frame) */
  town: vec4<f32>,
  /** x the town's key (its site id's hash), y the uniform's version (moves when the CPU writes it: a solve), z the lot
   *  kernels' workgroups (the lots made + the landmarks' room), w unused */
  misc: vec4<u32>,
  /** x the wall's build span (s: citygen DISTRICT_SPAN), yzw unused */
  wall: vec4<f32>,
  /** (an input) the purpose each district was claimed for: a byte a district (four a u32), 255 none — a keep card's
   *  district is the keep's whatever the population field said */
  roles: array<vec4<u32>, 16>,
};
@group(0) @binding(11) var<uniform> TP: TownP;
/** (the watch) a town slot's words: PC_* */
@group(0) @binding(12) var<storage, read_write> PCTL: array<atomic<u32>>;
/** the towns' clock (s): x — the gates' rise; written by the CPU as it moves (4 bytes, every towns' slot) */
struct Clock { t: vec4<f32> };
@group(0) @binding(13) var<uniform> CLK: Clock;
/** the solve's indirect dispatches: a town slot's 12 words — clear, the lot kernels, one workgroup */
@group(0) @binding(14) var<storage, read_write> PARGS: array<u32>;

// ---- the watch's words (contracts.ts PC: keep in step) ----
const PC_STRIDE: u32 = 8u;
const PC_ACC: u32 = 0u;
const PC_SEEN: u32 = 1u;
const PC_VERSION: u32 = 2u;
const PC_SOLVES: u32 = 3u;
const PC_WHY: u32 = 4u;
const PA_STRIDE: u32 = 12u;
/** the clear kernel's workgroups (its 3072 threads) */
const CLEAR_GROUPS: u32 = 48u;
/** the ring's words a solve reads (WB_S + NB) and the arterials' (4 + NART × AW) */
const WALL_WORDS: u32 = 584u;
const ART_WORDS: u32 = 2212u;
/** no wake by the clock */
const WAKE_NEVER: f32 = 3.0e38;

// ---- the table's layout (townplace.wgsl reads it: keep in step) ----
const TP_TOWN_WORDS: u32 = 42240u;
const TP_ENTRY: u32 = 8u;
const TP_NAMED_AT: u32 = 16u;
const TP_NAMED: u32 = 23u;
const TP_DIX_AT: u32 = 200u;
const TP_DPUR_AT: u32 = 3272u;
const TP_LOTS_AT: u32 = 3528u;
const TP_DISTRICTS: u32 = 256u;
const TP_KINDS: u32 = 6u;
const TP_LOT_ROOM: u32 = 4096u;
// (private: not read by townplace.wgsl)
const TP_FILL_AT: u32 = 36296u;
const TP_LIST_AT: u32 = 37832u;
const TP_PICK_AT: u32 = 41928u;
/** the clock a solve must run again by (f32: a gate's wall up, or down), WAKE_NEVER none */
const TP_WAKE_AT: u32 = 41980u;

const PL_MUSTER: u32 = 0u;
const PL_STORES: u32 = 1u;
const PL_BARRACKS: u32 = 2u;
const PL_MARKET: u32 = 3u;
const PL_KEEP: u32 = 4u;
const PL_GATE0: u32 = 5u;
const PL_SPAWN0: u32 = 15u;
const ST_OK: u32 = 0u;
const ST_NONE: u32 = 1u;
const ST_RISING: u32 = 2u;
const ST_WATER: u32 = 3u;
const NONE: u32 = 0xffffffffu;

// ---- citygen's words (streets.wgsl: RECW, REC_LM, LM_ROOM, the kinds, P_*, WALL's WB_*, ART's AW …) ----
const RECW: u32 = 24u;
const REC_LM: u32 = 32768u;
const LM_ROOM: u32 = 64u;
const K_NONE: u32 = 0u;
const K_BUILDING: u32 = 1u;
const K_PARK: u32 = 2u;
const K_PLAZA: u32 = 3u;
const K_LANDMARK: u32 = 4u;
const P_MARKET: u32 = 1u;
const P_KEEP: u32 = 5u;
const NB: u32 = 72u;
const WB_V: u32 = 80u;
const WB_KIND: u32 = 368u;
const WB_ART: u32 = 440u;
const WB_S: u32 = 512u;
const W_BAND: f32 = 0.12;
const NART: u32 = 8u;
const GATE_FILL: u32 = 2u;
const NAP: u32 = 128u;
const AP: u32 = 20u;
const AW: u32 = AP + 2u * NAP;
/** a spawn point: this far past the town's limit along its arterial (world units); an approach this far back */
const SPAWN_OUT: f32 = 16.0;
const APPROACH: f32 = 8.0;

fn base() -> u32 { return TP.dims.z * TP_TOWN_WORDS; }
fn ptGet(i: u32) -> u32 { return atomicLoad(&PT[base() + i]); }
fn ptSet(i: u32, v: u32) { atomicStore(&PT[base() + i], v); }

// ---- the records ----
fn recValid(r: u32) -> bool {
  let lots = min(CNT[0], CNT[3]);
  return r < lots || (r >= CNT[3] && r < CNT[3] + min(CNT[1], LM_ROOM));
}
/** a lot kernel's thread → its record: the lots, then the landmark sites (the dispatch covers the lots made + LM_ROOM) */
fn recOf(t: u32) -> u32 {
  let lots = min(CNT[0], CNT[3]);
  if (t < lots) { return t; }
  return CNT[3] + (t - lots);
}
fn rf(r: u32, w: u32) -> f32 { return bitcast<f32>(REC[r * RECW + w]); }
fn ru(r: u32, w: u32) -> u32 { return REC[r * RECW + w]; }
fn parcel(r: u32, k: u32) -> vec2<f32> { let j = k % 4u; return vec2<f32>(rf(r, 2u * j), rf(r, 2u * j + 1u)); }
fn foot(r: u32, k: u32) -> vec2<f32> { let j = k % 4u; return vec2<f32>(rf(r, 8u + 2u * j), rf(r, 9u + 2u * j)); }
fn lotMid(r: u32) -> vec2<f32> { return 0.25 * (foot(r, 0u) + foot(r, 1u) + foot(r, 2u) + foot(r, 3u)); }
fn lotKind(r: u32) -> u32 { return ru(r, 17u); }
fn lotDistrict(r: u32) -> u32 { return ru(r, 18u); }
fn lotSeed(r: u32) -> u32 { return ru(r, 23u); }
fn lotKey(r: u32) -> f32 { return rf(r, 22u); }
fn lotHeight(r: u32) -> f32 { return rf(r, 20u); }
/** open land a crowd can stand on: a park, a plaza, a landmark plaza (no storeys) */
fn lotOpen(r: u32) -> bool {
  let k = lotKind(r);
  return k == K_PARK || k == K_PLAZA || (k == K_LANDMARK && ru(r, 19u) == 0u);
}
fn lotArea(r: u32) -> f32 {
  var a = 0.0;
  for (var k = 0u; k < 4u; k++) { a += cross2v(foot(r, k), foot(r, k + 1u)); }
  return abs(0.5 * a);
}
fn cross2v(a: vec2<f32>, b: vec2<f32>) -> f32 { return a.x * b.y - a.y * b.x; }

// ---- the grid ----
fn gIx(p: vec2<f32>) -> u32 {
  let c = clamp(cellAt(p), vec2<i32>(0), vec2<i32>(i32(TP.dims.x) - 1, i32(TP.dims.y) - 1));
  return u32(c.y) * TP.dims.x + u32(c.x);
}
fn gz(p: vec2<f32>) -> f32 { return HT[gIx(p)]; }
fn purposeAt(p: vec2<f32>) -> u32 { return u32(max(round(POP[gIx(p) * 4u + 2u]), 0.0)); }
/** a district's claimed purpose (255 none) */
fn roleOf(d: u32) -> u32 {
  if (d >= 256u) { return 255u; }
  return (TP.roles[d / 16u][(d / 4u) % 4u] >> ((d % 4u) * 8u)) & 0xffu;
}
/** a lot's purpose: its district's claimed one, else the population field's at its middle */
fn lotPurpose(r: u32) -> u32 {
  let c = roleOf(lotDistrict(r));
  if (c != 255u) { return c; }
  return purposeAt(lotMid(r));
}
fn centre() -> vec2<f32> { return TP.town.xy; }

// ---- entries ----
fn putEntry(at: u32, p: vec3<f32>, status: u32, a: vec3<f32>, aux: u32) {
  ptSet(at, bitcast<u32>(p.x));
  ptSet(at + 1u, bitcast<u32>(p.y));
  ptSet(at + 2u, bitcast<u32>(p.z));
  ptSet(at + 3u, status);
  ptSet(at + 4u, bitcast<u32>(a.x));
  ptSet(at + 5u, bitcast<u32>(a.y));
  ptSet(at + 6u, bitcast<u32>(a.z));
  ptSet(at + 7u, aux);
}
fn at3(p: vec2<f32>) -> vec3<f32> { return vec3<f32>(p, gz(p)); }
/** a lot's entry: a building's door (just out from its face on its frontage) and its street (the parcel's frontage
 *  edge); open land its middle and its street; the status by its construction progress */
fn lotEntry(at: u32, r: u32) {
  let f = ru(r, 16u);
  var pos = lotMid(r);
  var app = pos;
  if (f <= 3u) {
    let a = parcel(r, f);
    let b = parcel(r, f + 1u);
    let e = b - a;
    app = 0.5 * (a + b);
    if (lotKind(r) == K_BUILDING && dot(e, e) > 1e-4) {
      let out = normalize(vec2<f32>(e.y, -e.x));
      pos = 0.5 * (foot(r, f) + foot(r, f + 1u)) + out * 0.6;
    }
  } else if (lotKind(r) == K_BUILDING) {
    pos = 0.25 * (parcel(r, 0u) + parcel(r, 1u) + parcel(r, 2u) + parcel(r, 3u));
    app = pos;
  }
  let p = PROG[r];
  let st = select(select(ST_OK, ST_RISING, p < 1.0), ST_NONE, p <= 0.0);
  putEntry(at, at3(pos), st, at3(app), lotSeed(r));
}

// ---- the wall (streets.wgsl WALL; its rise mirrors wallRise at the towns' clock, as routes.wgsl wallRiseAt) ----
fn ringMade() -> bool { return WALLW[0] == 1u; }
fn corner(b: u32) -> vec2<f32> { let o = WB_V + 2u * (b % NB); return vec2<f32>(bitcast<f32>(WALLW[o]), bitcast<f32>(WALLW[o + 1u])); }
fn segMid(b: u32) -> vec2<f32> { return 0.5 * (corner(b) + corner(b + 1u)); }
fn rise(seg: u32) -> f32 { return riseAt(seg, CLK.t.x); }
/** a piece's rise at clock t: monotone in t (the stage eased from WALLW[4] to [5] over [WALLW[6], + the span]) */
fn riseAt(seg: u32, t: f32) -> f32 {
  let span = max(TP.wall.x, 1e-3);
  let k = clamp((t - bitcast<f32>(WALLW[6])) / span, 0.0, 1.0);
  let S = mix(bitcast<f32>(WALLW[4]), bitcast<f32>(WALLW[5]), k * k * (3.0 - 2.0 * k));
  let w = f32((seg + NB - WALLW[2] % NB) % NB) / f32(NB);
  return clamp((S - w * (1.0 - W_BAND)) / W_BAND, 0.0, 1.0);
}
/** inside the ring's polygon (the corners, the grid's frame) */
fn inRing(p: vec2<f32>) -> bool {
  var c = false;
  for (var b = 0u; b < NB; b++) {
    let a = corner(b);
    let q = corner(b + 1u);
    if ((a.y > p.y) != (q.y > p.y)) {
      let x = a.x + (p.y - a.y) / (q.y - a.y) * (q.x - a.x);
      if (p.x < x) { c = !c; }
    }
  }
  return c;
}

// ---- the arterials (streets.wgsl ART) ----
fn artBase(k: u32) -> u32 { return 4u + k * AW; }
fn artCount() -> u32 { return min(ART[0], NART); }
fn artPts(k: u32) -> u32 { return min(ART[artBase(k)], NAP); }
fn artPt(k: u32, j: u32) -> vec2<f32> { let o = artBase(k) + AP + 2u * j; return vec2<f32>(bitcast<f32>(ART[o]), bitcast<f32>(ART[o + 1u])); }
/** the point s world units along arterial k from its centre end (clamped to its points) */
fn artAt(k: u32, s: f32) -> vec2<f32> {
  let n = artPts(k);
  if (n == 0u) { return centre(); }
  var acc = 0.0;
  for (var j = 0u; j + 1u < n; j++) {
    let a = artPt(k, j);
    let b = artPt(k, j + 1u);
    let d = distance(a, b);
    if (acc + d >= s) { return mix(a, b, clamp((s - acc) / max(d, 1e-4), 0.0, 1.0)); }
    acc += d;
  }
  return artPt(k, n - 1u);
}
/** a bridge's deck z where arterial k is s along (one of its spans), or -1e9 when it's on the ground there */
fn artDeck(k: u32, s: f32) -> f32 {
  let o = artBase(k);
  for (var j = 0u; j < min(ART[o + 2u], 4u); j++) {
    let a = bitcast<f32>(ART[o + 4u + 4u * j]);
    let b = bitcast<f32>(ART[o + 5u + 4u * j]);
    if (s >= a && s <= b) {
      return mix(bitcast<f32>(ART[o + 6u + 4u * j]), bitcast<f32>(ART[o + 7u + 4u * j]), clamp((s - a) / max(b - a, 1e-4), 0.0, 1.0));
    }
  }
  return -1e9;
}

// ---- picks: a key per lot (smaller better; NONE not a candidate), ties by seed ----
fn pickKey(p: u32, r: u32) -> u32 {
  if (PROG[r] <= 0.0) { return NONE; }
  let m = lotMid(r);
  let dq = min(u32(distance(m, centre()) * 2.0), 2047u);
  let pu = lotPurpose(r);
  let k = lotKind(r);
  switch (p) {
    case 1u: {
      // (the stores: the living town's hubPick rule — nearest the centre in a market district, else nearest the centre)
      if (k != K_BUILDING) { return NONE; }
      return dq + select(2048u, 0u, pu == P_MARKET);
    }
    case 3u: {
      if (pu != P_MARKET || (k != K_BUILDING && !lotOpen(r))) { return NONE; }
      return dq + select(4096u, 0u, lotOpen(r));
    }
    case 4u: {
      if (pu != P_KEEP || k != K_BUILDING) { return NONE; }
      return 0xffffu - min(u32(lotHeight(r) * 16.0), 0xffffu);
    }
    case 0u: {
      // (the muster yard: the walls card's — open land inside the ring, nearest its first gate)
      if (!ringMade() || !lotOpen(r) || !inRing(m)) { return NONE; }
      return min(u32(distance(m, segMid(WALLW[2] % NB)) * 4.0), 0xfffffu);
    }
    case 2u: {
      // (the barracks: the keep district's biggest building but the keep)
      if (pu != P_KEEP || k != K_BUILDING) { return NONE; }
      let keep = ptGet(TP_PICK_AT + 2u * PL_KEEP + 1u);
      if (keep == NONE || lotSeed(r) == keep) { return NONE; }
      return 0xfffffu - min(u32(lotArea(r) * 16.0), 0xfffffu);
    }
    default: { return NONE; }
  }
}
fn pickKeyMin(p: u32, r: u32) {
  let k = pickKey(p, r);
  if (k != NONE) { atomicMin(&PT[base() + TP_PICK_AT + 2u * p], k); }
}
fn pickSeedMin(p: u32, r: u32) {
  let k = pickKey(p, r);
  if (k != NONE && k == ptGet(TP_PICK_AT + 2u * p)) { atomicMin(&PT[base() + TP_PICK_AT + 2u * p + 1u], lotSeed(r)); }
}
fn pickWrite(p: u32, r: u32) {
  let k = pickKey(p, r);
  if (k != NONE && k == ptGet(TP_PICK_AT + 2u * p) && lotSeed(r) == ptGet(TP_PICK_AT + 2u * p + 1u)) {
    lotEntry(TP_NAMED_AT + p * TP_ENTRY, r);
  }
}

fn bin(r: u32) -> u32 { return min(lotDistrict(r), TP_DISTRICTS - 1u) * TP_KINDS + min(lotKind(r), TP_KINDS - 1u); }
fn indexed(r: u32) -> bool { return recValid(r) && lotKind(r) != K_NONE && lotDistrict(r) < TP_DISTRICTS; }

@compute @workgroup_size(64)
fn plClear(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i < TP_DISTRICTS * TP_KINDS * 2u) { ptSet(TP_DIX_AT + i, 0u); }
  if (i < TP_DISTRICTS) { ptSet(TP_DPUR_AT + i, NONE); }
  if (i < TP_DISTRICTS * TP_KINDS) { ptSet(TP_FILL_AT + i, 0u); }
  if (i < TP_NAMED * 2u) { ptSet(TP_PICK_AT + i, NONE); }
}

@compute @workgroup_size(64)
fn plCount(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = recOf(g.x);
  if (!indexed(r)) { return; }
  atomicAdd(&PT[base() + TP_DIX_AT + 2u * bin(r) + 1u], 1u);
  atomicMin(&PT[base() + TP_DPUR_AT + lotDistrict(r)], lotPurpose(r));
  pickKeyMin(PL_STORES, r);
  pickKeyMin(PL_MARKET, r);
  pickKeyMin(PL_KEEP, r);
  pickKeyMin(PL_MUSTER, r);
}

var<workgroup> scanS: array<u32, 256>;
@compute @workgroup_size(256)
fn plScan(@builtin(local_invocation_index) li: u32) {
  var sum = 0u;
  for (var k = 0u; k < TP_KINDS; k++) { sum += ptGet(TP_DIX_AT + 2u * (li * TP_KINDS + k) + 1u); }
  scanS[li] = sum;
  workgroupBarrier();
  for (var o = 1u; o < 256u; o *= 2u) {
    var v = 0u;
    if (li >= o) { v = scanS[li - o]; }
    workgroupBarrier();
    scanS[li] += v;
    workgroupBarrier();
  }
  var first = scanS[li] - sum;
  for (var k = 0u; k < TP_KINDS; k++) {
    let b = li * TP_KINDS + k;
    let n = ptGet(TP_DIX_AT + 2u * b + 1u);
    let f = min(first, TP_LOT_ROOM);
    ptSet(TP_DIX_AT + 2u * b, f);
    ptSet(TP_DIX_AT + 2u * b + 1u, min(n, TP_LOT_ROOM - f));
    first += n;
  }
}

@compute @workgroup_size(64)
fn plScatter(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = recOf(g.x);
  if (!indexed(r)) { return; }
  let b = bin(r);
  let s = atomicAdd(&PT[base() + TP_FILL_AT + b], 1u);
  if (s < ptGet(TP_DIX_AT + 2u * b + 1u)) { ptSet(TP_LIST_AT + ptGet(TP_DIX_AT + 2u * b) + s, r); }
  pickSeedMin(PL_STORES, r);
  pickSeedMin(PL_MARKET, r);
  pickSeedMin(PL_KEEP, r);
  pickSeedMin(PL_MUSTER, r);
}

@compute @workgroup_size(64)
fn plRank(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = recOf(g.x);
  if (!indexed(r)) { return; }
  let b = bin(r);
  let first = ptGet(TP_DIX_AT + 2u * b);
  let n = ptGet(TP_DIX_AT + 2u * b + 1u);
  let key = lotKey(r);
  let seed = lotSeed(r);
  var rank = 0u;
  var listed = false;
  for (var i = 0u; i < n; i++) {
    let o = ptGet(TP_LIST_AT + first + i);
    if (o == r) { listed = true; continue; }
    let ko = lotKey(o);
    if (ko < key || (ko == key && lotSeed(o) < seed)) { rank++; }
  }
  if (listed) { lotEntry(TP_LOTS_AT + (first + rank) * TP_ENTRY, r); }
  pickWrite(PL_STORES, r);
  pickWrite(PL_MARKET, r);
  pickWrite(PL_KEEP, r);
  pickWrite(PL_MUSTER, r);
  pickKeyMin(PL_BARRACKS, r);
}

@compute @workgroup_size(64)
fn plSeedB(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = recOf(g.x);
  if (!indexed(r)) { return; }
  pickSeedMin(PL_BARRACKS, r);
}

@compute @workgroup_size(64)
fn plWriteB(@builtin(global_invocation_id) g: vec3<u32>) {
  let r = recOf(g.x);
  if (!indexed(r)) { return; }
  pickWrite(PL_BARRACKS, r);
}

@compute @workgroup_size(1)
fn plHead() {
  // (the header: townplace.wgsl's words)
  ptSet(0u, 1u);
  ptSet(1u, TP.misc.x);
  ptSet(2u, TP.dims.w);
  ptSet(3u, TP_NAMED);
  ptSet(4u, bitcast<u32>(TP.place.x));
  ptSet(5u, bitcast<u32>(TP.place.y));
  ptSet(6u, bitcast<u32>(TP.place.z));
  ptSet(7u, TP_DISTRICTS);
  // (the picks nobody won: no such place)
  for (var p = 0u; p < 5u; p++) {
    if (ptGet(TP_PICK_AT + 2u * p + 1u) == NONE) { putEntry(TP_NAMED_AT + p * TP_ENTRY, vec3<f32>(0.0), ST_NONE, vec3<f32>(0.0), 0u); }
  }
  // (the gates: routeread's slots — slot k the arterial k's outer crossing, the filler gates after in ring order from
  // the first gate; as routes.wgsl wallCopy)
  var seg = array<u32, 10>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
  var along = array<f32, 10>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  if (ringMade()) {
    let g0 = WALLW[2] % NB;
    var fill = 0u;
    for (var j = 0u; j < NB; j++) {
      let b = (g0 + j) % NB;
      if (WALLW[WB_KIND + b] != 1u) { continue; }
      let art = WALLW[WB_ART + b];
      let s = bitcast<f32>(WALLW[WB_S + b]);
      if (art > 0u && art - 1u < NART) {
        let k = art - 1u;
        if (seg[k] == 0u || s > along[k]) { seg[k] = b + 1u; along[k] = s; }
      } else if (fill < GATE_FILL) {
        seg[NART + fill] = b + 1u;
        fill++;
      }
    }
  }
  for (var k = 0u; k < NART + GATE_FILL; k++) {
    let at = TP_NAMED_AT + (PL_GATE0 + k) * TP_ENTRY;
    if (seg[k] == 0u) { putEntry(at, vec3<f32>(0.0), ST_NONE, vec3<f32>(0.0), 0u); continue; }
    let b = seg[k] - 1u;
    var st = select(ST_OK, ST_RISING, rise(b) < 1.0);
    var p = at3(segMid(b));
    var a = at3(segMid(b) + normalize(centre() - segMid(b) + vec2<f32>(1e-4, 0.0)) * APPROACH);
    if (k < NART) {
      p = at3(artAt(k, along[k]));
      a = at3(artAt(k, max(along[k] - APPROACH, 0.0)));
      let deck = artDeck(k, along[k]);
      if (deck > -1e8) {
        p.z = deck;
        if (st == ST_OK) { st = ST_WATER; }
      }
    }
    putEntry(at, p, st, a, b);
  }
  // (the wake clock: a gate's status follows its piece's rise at the clock, which only moves inside the stage's span;
  // rise ≥ 1 is monotone in the clock there, so the first clock it flips at is a bisection — the next solve's)
  var wake = WAKE_NEVER;
  let now = CLK.t.x;
  let t1 = bitcast<f32>(WALLW[6]) + max(TP.wall.x, 1e-3);
  if (ringMade() && now < t1) {
    for (var k = 0u; k < NART + GATE_FILL; k++) {
      if (seg[k] == 0u) { continue; }
      let b = seg[k] - 1u;
      let end = riseAt(b, t1) >= 1.0;
      if ((riseAt(b, now) >= 1.0) == end) { continue; }
      var lo = now;
      var hi = t1;
      for (var i = 0u; i < 24u; i++) {
        let m = 0.5 * (lo + hi);
        if ((riseAt(b, m) >= 1.0) == end) { hi = m; } else { lo = m; }
      }
      wake = min(wake, hi);
    }
  }
  ptSet(TP_WAKE_AT, bitcast<u32>(wake));
  // (the spawn points: each arterial's road past the town's limit — where a raid comes in)
  for (var k = 0u; k < NART; k++) {
    let at = TP_NAMED_AT + (PL_SPAWN0 + k) * TP_ENTRY;
    if (k >= artCount() || artPts(k) < 2u) { putEntry(at, vec3<f32>(0.0), ST_NONE, vec3<f32>(0.0), 0u); continue; }
    let o = artBase(k);
    let len = bitcast<f32>(ART[o + 1u]);
    let lim = bitcast<f32>(ART[o + 3u]);
    let s = max(min(lim + SPAWN_OUT, len - 2.0), 0.0);
    var p = at3(artAt(k, s));
    let deck = artDeck(k, s);
    if (deck > -1e8) { p.z = deck; }
    putEntry(at, p, ST_OK, at3(artAt(k, max(s - APPROACH, 0.0))), k);
  }
}

// ---- the watch (UC-8): a solve only when what it reads changed ----
fn progClass(p: f32) -> u32 { return select(select(ST_OK, ST_RISING, p < 1.0), ST_NONE, p <= 0.0); }

@compute @workgroup_size(64)
fn plWatch(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x;
  var h = 0u;
  let lots = min(CNT[0], CNT[3]);
  if (t < lots + min(CNT[1], LM_ROOM)) {
    let r = recOf(t);
    var x = pcg(r ^ 0x9e3779b9u);
    for (var w = 0u; w < RECW; w++) { x = pcg(x ^ REC[r * RECW + w]); }
    h += pcg(x ^ progClass(PROG[r]));
  }
  if (t < WALL_WORDS) { h += pcg(WALLW[t] ^ pcg(t + 0x51ed27u)); }
  if (t < ART_WORDS) { h += pcg(ART[t] ^ pcg(t + 0x2545f491u)); }
  if (t == 0u) { h += pcg(CNT[0] ^ pcg(CNT[1] + 7u)); }
  if (h != 0u) { atomicAdd(&PCTL[TP.dims.z * PC_STRIDE + PC_ACC], h); }
}

fn pargs(at: u32, n: u32) { PARGS[at] = n; PARGS[at + 1u] = 1u; PARGS[at + 2u] = 1u; }

@compute @workgroup_size(1)
fn plWake() {
  let o = TP.dims.z * PC_STRIDE;
  let acc = atomicExchange(&PCTL[o + PC_ACC], 0u);
  var why = 0u;
  if (acc != atomicLoad(&PCTL[o + PC_SEEN])) { atomicStore(&PCTL[o + PC_SEEN], acc); why |= 1u; }
  if (TP.misc.y != atomicLoad(&PCTL[o + PC_VERSION])) { atomicStore(&PCTL[o + PC_VERSION], TP.misc.y); why |= 2u; }
  if (CLK.t.x >= bitcast<f32>(ptGet(TP_WAKE_AT))) { why |= 4u; }
  let a = TP.dims.z * PA_STRIDE;
  if (why != 0u) {
    atomicAdd(&PCTL[o + PC_SOLVES], 1u);
    atomicStore(&PCTL[o + PC_WHY], why);
  }
  let on = why != 0u;
  pargs(a, select(0u, CLEAR_GROUPS, on));
  pargs(a + 3u, select(0u, TP.misc.z, on));
  pargs(a + 6u, select(0u, 1u, on));
}
