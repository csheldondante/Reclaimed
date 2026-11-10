// ---- agents (round 52, docs/AGENTS.md) -----------------------------------------
// The layer units walk on, the fields they follow, and the units.
//
// Surfaces: each column's intervals peeled into the places a unit can stand
// (the top of solid or loose ground with at least AGENT_H of air over it),
// up to NAV_K a column, highest first. Intervals that touch leave no air
// between them, so a layer cake of strata is one surface; a jagged cliff's
// slivers too thin to stand under drop out. Each surface links to one
// surface in each of the six hex neighbours: the one nearest in height that
// a unit can step up to (STEP) or drop down to (DROP) with headroom over both.
//
// Fields: a distance to a field's seeds on every surface (NFIELDS of them,
// shared by every group heading the same way), relaxed in place a few
// sweeps a tick. A surface's value is recomputed from its neighbours only
// (seeds are 0), never kept as a running minimum, so a field follows the
// terrain as it changes: a wall raised across a path raises the distances
// behind it within a few ticks.
//
// Units: one thread each. A unit follows its group's field down the gradient
// (smoothed over the six neighbours), is pushed apart by how crowded the
// columns round it are (occ: units per column, counted the tick before), and
// rides its surface's height. It writes its own voxels for the draw (the
// body format, render.wgsl vsBody): legs, torso and head.
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
// per surface (column i, slot k: i * NAV_K + k): x its height (f32 bits; < 0
// none), y headroom (bits 0-7, eighths of a cell) | wet (8) | links (9-26:
// 3 bits a direction, 0 none, else the neighbour's slot + 1), z its room
// (low 16 bits; places: the top surface the column's open-air room, those
// under it the enclosed level's) and that room's region (high 16; 0 no
// place), w the water's depth on it (f32 bits; the top surface only)
@group(0) @binding(5) var<storage, read_write> nav: array<vec4<u32>>;
// per field and surface: f * NS + s (NS = columns * NAV_K)
@group(0) @binding(6) var<storage, read_write> dist: array<f32>;
// (units.wgsl: the units, their crowding and their voxels, bindings 7-9, 13-14)

struct AgentParams {
  // x units, y seeds, z fields in use, w ticks
  n: vec4<u32>,
  // x, y, z (world), w the field it seeds
  seeds: array<vec4<f32>, 48>,
  // per group (24: agents.ts MAX_GROUPS): the field it follows, and the material it's drawn in
  groupField: array<vec4<u32>, 6>,
  groupMat: array<vec4<u32>, 6>,
  // per field: the place it's confined to (0 anywhere; bit 31 a region,
  // else a room): its distances live only on that place's surfaces
  fieldPlace: array<vec4<u32>, 4>,
  // x hits this tick, y targets, z events capacity, w the fields with seeds (bit per field)
  n2: vec4<u32>,
  // the kinds of unit (units.wgsl Kind)
  kinds: array<Kind, 8>,
  // the game's hits this tick (units.wgsl Hit)
  hits: array<Hit, 32>,
  // what hostile kinds go for (the player's units): x, y, z (its feet), radius
  targets: array<vec4<f32>, 8>,
  // x holds, y launches, z regroups this tick, w the fields to clear (left without seeds: set unreachable once)
  n3: vec4<u32>,
  // units the game holds (a lich, a gorilla): where (x, y, z) and the slot (w)
  holds: array<vec4<f32>, 8>,
  // units thrown this tick: velocity (x, y, z) and the slot (w)
  launches: array<vec4<f32>, 32>,
  // each target's height (cells; target t: [t / 4][t % 4]): it's a
  // vertical capsule from its feet up, radius its radius (round 59)
  targetH: array<vec4<f32>, 2>,
  // units moved to another group this tick (round 63: a worker off to its
  // job, then carrying to the pile): slot | group << 16, four a vec4
  regroups: array<vec4<u32>, 16>,
  // (round 128o, DA-B2a) per field: its arrival radius and its leaving radius (field f: floats 2f, 2f + 1; 0: off)
  arrive: array<vec4<f32>, 7>,
  // (round 128o, DA-B22) x the units' step's dt (s): a tick's, or at fast-forward the ticks since the last step's
  // (agents.ts stepPlan) — what units.wgsl integrates by in place of G.dt
  // (y, round 128p) the rekinds this step
  step: vec4<f32>,
  // (round 128p, DA-B22 (c)(4)) units made another kind where they stand (agents.ts rekind): x the slot, y the kind,
  // z its hp (f32 bits) when w is 1
  rekinds: array<vec4<u32>, 8>,
  // (U2) x the GPU-seeded hunt field (NFIELDS: none; it keeps each value's seed: relax), y the fields the CPU's marks
  // this tick are for (FC11: a seed moved; all for a confine, a scope drawn in, the roads), z unused, w 1: ?agentprof=1
  // (frontDbg counted)
  u2: vec4<u32>,
};
fn arriveR(f: u32) -> vec2<f32> {
  let i = f * 2u;
  return vec2<f32>(AP.arrive[i / 4u][i % 4u], AP.arrive[(i + 1u) / 4u][(i + 1u) % 4u]);
}
/**
 * A kind of unit: a (height, mass, hp, speed), b (reach, damage, swing
 * period s, notice: 0 a worker that always follows its field; else how far
 * along the field it notices a target), c (legs, head, torso materials;
 * torso 0: its group's colour)
 */
struct Kind { a: vec4<f32>, b: vec4<f32>, c: vec4<u32> };
/**
 * A hit from the game: a (x, y, z, radius), b (the push's direction xy, cos
 * of the cone's half angle: -2 a circle, damage), c (push cells/s, 1 outward
 * else along the direction, 1 sets alight, its id), d (the cone's axis xy)
 */
struct Hit { a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, d: vec4<f32> };
@group(0) @binding(10) var<uniform> AP: AgentParams;
// (the surfaces pass only) places: per column low u16 the open-air room, high
// u16 the enclosed level's (0 the same); the place table: a room's region
@group(0) @binding(11) var<storage, read> places: array<u32>;
@group(0) @binding(12) var<storage, read> placeTable: array<u32>;
// (round 104, simscale — agents.ts scope) the columns the fields are kept over: x0, y0, x1, y1 (exclusive); a
// neighbour past them is no way (the window's edge is the same)
// ([1] unused)
@group(0) @binding(38) var<uniform> AB: array<vec4<u32>, 2>;
fn inScope(q: vec2<i32>) -> bool { return q.x >= i32(AB[0].x) && q.y >= i32(AB[0].y) && q.x < i32(AB[0].z) && q.y < i32(AB[0].w); }
// (round 104, simscale — agents/scope.ts "the front") per window chunk: something in it changed for the fields — in
// this sweep's (cur: what the next sweep relaxes round) and the next's (what this sweep's relax marks); the chunks a
// sweep relaxes (frontList), and its dispatch's workgroups (frontArgs: x, 1, 1)
@group(0) @binding(34) var<storage, read_write> dirtyCur: array<atomic<u32>>;
@group(0) @binding(35) var<storage, read_write> dirtyNext: array<atomic<u32>>;
// (round 107: w the chunks that asked to be in it this sweep, FRONT_CAP taken)
@group(0) @binding(33) var<storage, read_write> frontArgs: array<atomic<u32>, 4>;
/** (round 107, agentspike) chunks a sweep relaxes at most: a change that reaches over more (a shore drying across a
 *  town, a field starting over) is relaxed over several sweeps, the rest carried — no tick carries more than this */
const FRONT_CAP: u32 = 32u;
/** (FC12) workgroups a front chunk's relax takes: 4 for relax's front kernel, 1 for relaxBlock (agents.ts sets it) */
const FRONT_WG: u32 = 4u;
// (U2, FC10: [k] the k-th chunk of the front, [FRONT_CAP + k] the fields it is relaxed for)
@group(0) @binding(36) var<storage, read_write> frontList: array<u32>;
/** (U2, FC10) the fields a chunk's marks name (a bit a field, NFIELDS ≤ 16): the low half of a dirty word; what's marked
 *  for every field (a surface changed, a chunk come in, the CPU's marks) is all of them */
const ALL_FIELDS: u32 = 0xffffu;
/** (U2, FC10) the fields this invocation relaxes: all, unless the front's entry (agents.ts frontSource) says which */
var<private> frontMask: u32 = 0xffffffffu;
/** (U2) per surface (as nav), a bit a field: a seed the GPU put there this frame (units.wgsl huntSet); bit 16 + f: there
 *  last frame (so a seed that stays isn't marked again, one that goes is). Then a second plane (from NS): the hunt
 *  field's seed each surface's distance came from (+ 1; 0 none) — the seed-id fix (relax) */
@group(0) @binding(52) var<storage, read_write> seedMask: array<atomic<u32>>;
/** (FC11, ?agentprof=1) counters: [f] a chunk asked for field f by a change round it, [16 + f] carried only; [32] seeds
 *  new this frame, [33] seeds gone (huntSet / huntGone) — read and cleared each tick (agents.ts probeLog) */
@group(0) @binding(54) var<storage, read_write> frontDbg: array<atomic<u32>>;
/** (ringwin) column (x, y)'s chunk's slot in the per-chunk marks: its page (common.wgsl pageIdx) */
fn chunkOfCol(x: u32, y: u32) -> u32 { return pageIdx(vec2<u32>(x, y) / COLS_PAGE); }
/** (round 107, agentspike) how far a surface's floor moves from the height its cost is reckoned at before that height
 *  follows it (cells; navCost). Round 104 marked any move at all; the sediment moves surfaces by hundredths every peel,
 *  so the front never emptied (FRAMECOST FC4) */
const NAV_DZ: f32 = 0.25;
// (round 128o, DA-B26: WADE, WADE_OFF, DEEP, DEEP_OFF — the walkers' water classes — are waterclass.wgsl's, prepended:
// the water's writers move a chunk's class version when its water crosses one)
// (round 107, agentspike) per surface (as nav: column i, slot k): the height and the wet the fields reckon its cost by
// (the links and the relax), apart from the exact floor in nav that the units ride. 0 none, else
// (round(z * 8) + 1) << 2 | deep << 1 | wet (round 128d: deep, FT-20). It follows the floor with hysteresis (NAV_DZ, WADE / WADE_OFF), so sediment's
// hundredths and a ripple at a shore don't send a wave down every field; a change to it marks the chunk for the front
@group(0) @binding(37) var<storage, read_write> navCost: array<u32>;
/** (a surface not peeled since its slot was cleared — a strip come in — counts by its floor until it is) */
fn costZ(s: u32) -> f32 { return select(navZ(s), f32((navCost[s] >> 2u) - 1u) / 8.0, navCost[s] != 0u); }
fn costWet(s: u32) -> bool { return (navCost[s] & 1u) != 0u; }
/** (round 128d, FT-20) water over DEEP on it (the top surface only): no way in from a surface that isn't */
fn costDeep(s: u32) -> bool { return (navCost[s] & 2u) != 0u; }
// (fortress milestone 3, FT-46: units prefer roads) per window column (window order, y * W + x), a bit: a road there.
// A step between two road columns costs ROAD_COST of a step on open ground, one end on a road halfway between: a
// worker goes round by the road when it's no more than a little longer. Set by the game (Agents.setRoads); all 0 none.
@group(0) @binding(40) var<storage, read> roads: array<u32>;
const ROAD_COST: f32 = 0.5;
/** (round 128i) the riding network's plane of the road bits (roadride.wgsl rideNetStamp): a column on an edge that leads
 *  to a riding group's goal — the road field's seeds */
fn onNet(p: vec2<i32>) -> bool {
  let w = winIdx(p);
  return ((roads[arrayLength(&roads) / 2u + (w >> 5u)] >> (w & 31u)) & 1u) != 0u;
}
/** fields (agents.ts NFIELDS); (round 128i, V128-14) the last, ROAD_FIELD, is the shared field onto the roads: every
 *  surface of a network column (onNet) a seed (agents.ts ROAD_FIELD; set while a group rides the roads — shaders/roadride.wgsl) */
const NFIELDS: u32 = 13u;
const ROAD_FIELD: u32 = 12u;
fn onRoad(p: vec2<i32>) -> f32 {
  let w = winIdx(p);
  return f32((roads[w >> 5u] >> (w & 31u)) & 1u);
}
/** (round 107) how far a distance moves before it is written and marks its chunk: below it the field keeps what it
 *  has (a twentieth of the cheapest step, so a unit's way down it is the same), and a sub-step ripple — a surface
 *  moved by hundredths — doesn't run down the whole field */
const DIST_EPS: f32 = 0.05;

/** a surface's record changed (its height, headroom, wet, links, room — not its water, which the fields don't read)? */
fn navMoved(a: vec4<u32>, b: vec4<u32>) -> bool { return a.x != b.x || a.y != b.y || a.z != b.z; }

const NAV_K: u32 = 4u;
const AGENT_H: f32 = 1.5;
const STEP: f32 = 1.1;
const DROP: f32 = 2.6;
const FAR: f32 = 1e9;

fn ns() -> u32 { return G.mapW * G.mapH * NAV_K; }
fn navZ(s: u32) -> f32 { return bitcast<f32>(nav[s].x); }
fn navHead(s: u32) -> f32 { return f32(nav[s].y & 0xffu) / 8.0; }
fn navWet(s: u32) -> bool { return ((nav[s].y >> 8u) & 1u) != 0u; }
fn navLink(s: u32, d: u32) -> u32 { return (nav[s].y >> (9u + 3u * d)) & 7u; }
fn navRoom(s: u32) -> u32 { return nav[s].z & 0xffffu; }
fn navRegion(s: u32) -> u32 { return nav[s].z >> 16u; }
fn navWater(s: u32) -> f32 { return bitcast<f32>(nav[s].w); }
/** Surface s lies on place fp (a field's place word: bit 31 a region). */
fn onPlace(s: u32, fp: u32) -> bool {
  return select(navRoom(s), navRegion(s), (fp >> 31u) != 0u) == (fp & 0x7fffffffu);
}
fn solidMat(m: u32) -> bool {
  let st = matState(m);
  return st == ST_SOLID || st == ST_GRANULAR;
}

/** Peel a column into surfaces (highest first). */
@compute @workgroup_size(8, 8)
fn surfaces(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let cs = colSlots(id.x, id.y);
  // the solid runs, bottom up: merge touching intervals into one
  var tops: array<f32, MAX_K>;
  var bots: array<f32, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v) || !solidMat(ivMat(v))) { continue; }
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    if (n > 0u && z0 - tops[n - 1u] < 1e-3) { tops[n - 1u] = max(tops[n - 1u], z1); continue; }
    bots[n] = z0;
    tops[n] = z1;
    n += 1u;
  }
  let pl = places[i];
  let topRoom = pl & 0xffffu;
  var underRoom = pl >> 16u;
  if (underRoom == 0u) { underRoom = topRoom; }
  var out = 0u;
  var r = i32(n) - 1;
  while (r >= 0 && out < NAV_K) {
    let z = tops[r];
    var head = 31.0;
    if (u32(r) + 1u < n) { head = bots[r + 1] - z; }
    if (head >= AGENT_H) {
      // (trackA-liquids, LQ4: the water on this surface — the top's open water, or under the flow model a run lying on a
      // lower one: a riverbed under a deck, a cave's pool — agents.ts surfaceDepth)
      let wd = surfaceDepth(i, z, r == i32(n) - 1);
      let wet = wd > WADE;
      let room = select(underRoom, topRoom, out == 0u);
      let region = select(0u, placeTable[room], room != 0u);
      let nv = vec4<u32>(bitcast<u32>(z), u32(min(head, 31.0) * 8.0) | (select(0u, 1u, wet) << 8u), (room & 0xffffu) | (region << 16u), bitcast<u32>(wd));
      // (the links' bits are the links pass's: compared there)
      let ov = nav[i * NAV_K + out];
      // (round 107: the cost's height and wet follow the floor with hysteresis — navCost)
      let oc = navCost[i * NAV_K + out];
      var cz = z;
      var cw = wet;
      var cd = wd > DEEP;
      if (oc != 0u) {
        let ocz = f32((oc >> 2u) - 1u) / 8.0;
        if (abs(z - ocz) <= NAV_DZ) { cz = ocz; }
        cw = wd > select(WADE, WADE_OFF, (oc & 1u) != 0u);
        cd = wd > select(DEEP, DEEP_OFF, (oc & 2u) != 0u);
      }
      let nc = ((u32(round(max(cz, 0.0) * 8.0)) + 1u) << 2u) | select(0u, 2u, cd) | select(0u, 1u, cw);
      navCost[i * NAV_K + out] = nc;
      // (round 104: a surface that changed for the fields marks its chunk for the front. Round 107: its cost — a
      // surface come, its height or wet as navCost has them — or its room; the headroom counts through the links,
      // compared in the links pass)
      if (nc != oc || ov.z != nv.z) { atomicOr(&dirtyCur[chunkOfCol(id.x, id.y)], ALL_FIELDS); }
      // (its links kept: the links pass makes them again, the same where nothing moved — so no change is flagged)
      nav[i * NAV_K + out] = vec4<u32>(nv.x, nv.y | (ov.y & ~0x1ffu), nv.z, nv.w);
      out += 1u;
    }
    r -= 1;
  }
  for (var k = out; k < NAV_K; k++) {
    let none = vec4<u32>(bitcast<u32>(-1.0), 0u, 0u, 0u);
    if (navMoved(nav[i * NAV_K + k], none)) { atomicOr(&dirtyCur[chunkOfCol(id.x, id.y)], ALL_FIELDS); }
    nav[i * NAV_K + k] = none;
    navCost[i * NAV_K + k] = 0u;
  }
}

/**
 * (round 128o, DA-B26) The top surface's water (nav .w: the units wade, drown and put out fire by it) brought up to
 * date where the water's depth moved and nothing else did: the peel runs where the columns or the water's class
 * changed (agents.ts encodeScoped), this over the chunks whose depth's version moved. A column with no surface keeps
 * the peel's none.
 */
@compute @workgroup_size(8, 8)
fn surfaceWater(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let s = nav[i * NAV_K];
  if (s.y == 0u && s.z == 0u && bitcast<f32>(s.x) == -1.0) { return; }
  nav[i * NAV_K].w = bitcast<u32>(water[i]);
}

/** Link each surface to the six neighbours (after surfaces). */
@compute @workgroup_size(8, 8)
fn links(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdx(id.x, id.y);
  for (var k = 0u; k < NAV_K; k++) {
    let s = i * NAV_K + k;
    let z = navZ(s);
    if (z < 0.0) { break; }
    let ceilA = z + navHead(s);
    // (round 107: the step up or down by the cost's heights — navCost — so a floor's hundredths don't flip a link)
    let cz = costZ(s);
    var bits = 0u;
    for (var d = 0u; d < NDIR; d++) {
      let q = nbr(p, d);
      if (!inMap(q)) { continue; }
      let j0 = colIdxI(q) * NAV_K;
      var best = 0u;
      var bestDz = FAR;
      for (var j = 0u; j < NAV_K; j++) {
        let zq = navZ(j0 + j);
        if (zq < 0.0) { break; }
        let dz = costZ(j0 + j) - cz;
        if (dz > STEP || dz < -DROP) { continue; }
        // headroom over the step: the lower ceiling above the higher floor
        if (min(ceilA, zq + navHead(j0 + j)) - max(z, zq) < AGENT_H) { continue; }
        if (abs(dz) < bestDz) { bestDz = abs(dz); best = j + 1u; }
      }
      bits |= best << (3u * d);
    }
    let ny = (nav[s].y & 0x1ffu) | (bits << 9u);
    // (?jfa=1: the columns' links were made again here — the obstacles JFA runs again)
    if (k == 0u) { atomicStore(&jfa[2], 1u); }
    if (ny != nav[s].y) { atomicOr(&dirtyCur[chunkOfCol(id.x, id.y)], ALL_FIELDS); }
    nav[s].y = ny;
  }
}

/** The surface in column i nearest below (or a step above) height z; NAV_K none. */
fn surfaceAt(i: u32, z: f32) -> u32 {
  var best = NAV_K;
  var bd = FAR;
  for (var k = 0u; k < NAV_K; k++) {
    let zk = navZ(i * NAV_K + k);
    if (zk < 0.0) { break; }
    if (zk > z + STEP) { continue; }
    if (z - zk < bd) { bd = z - zk; best = k; }
  }
  return best;
}

/** The surface in column i nearest height z, up or down (a seed's: a target's z may be off by a bit); NAV_K none. */
fn surfaceNear(i: u32, z: f32) -> u32 {
  var best = NAV_K;
  var bd = FAR;
  for (var k = 0u; k < NAV_K; k++) {
    let zk = navZ(i * NAV_K + k);
    if (zk < 0.0) { break; }
    if (abs(z - zk) < bd) { bd = abs(z - zk); best = k; }
  }
  return best;
}

fn stepCost(z: f32, zq: f32, wet: bool) -> f32 {
  let dz = zq - z;
  return 1.0 + max(dz, 0.0) * 1.5 + max(-dz, 0.0) * 0.3 + select(0.0, 3.0, wet);
}

/** One sweep of every field in use, in place. */
@compute @workgroup_size(8, 8)
fn relax(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdx(id.x, id.y);
  let N = ns();
  let ch = chunkOfCol(id.x, id.y);
  for (var k = 0u; k < NAV_K; k++) {
    let s = i * NAV_K + k;
    if (navZ(s) < 0.0) { break; }
    // (round 107: the cost's heights and wet, navCost)
    let z = costZ(s);
    // (round 128d, FT-20) this surface under deep water: its way out reads every neighbour
    let deepHere = costDeep(s);
    // (the surfaces are packed from 0: past the last, none. Nothing links to
    // an empty slot, so what's left in its fields is never read; a slot that
    // fills again is recomputed from its neighbours the next sweep)
    if (z < 0.0) { break; }
    for (var f = 0u; f < AP.n.z; f++) {
      // (U2, FC10: a front per field — this chunk relaxed for the fields that changed round it only)
      if (((frontMask >> f) & 1u) == 0u) { continue; }
      // (confined: off its place, nothing; a field with no seeds: nowhere)
      let fp = AP.fieldPlace[f / 4u][f % 4u];
      if ((AP.n2.w & (1u << f)) == 0u) {
        if (((AP.n3.w >> f) & 1u) != 0u) { dist[f * N + s] = FAR; }
        continue;
      }
      if (fp != 0u && !onPlace(s, fp)) {
        if (dist[f * N + s] != FAR) { atomicOr(&dirtyNext[ch], 1u << f); }
        dist[f * N + s] = FAR;
        continue;
      }
      var d = FAR;
      for (var e = 0u; e < AP.n.y; e++) {
        let sd = AP.seeds[e];
        if (u32(sd.w) != f) { continue; }
        let c = cellAt(sd.xy);
        if (all(c == p) && surfaceNear(i, sd.z) == k) { d = 0.0; }
      }
      if (f == ROAD_FIELD && onNet(p)) { d = 0.0; }
      // (U2: seeds the GPU scattered this frame — the hunt's targets, units.wgsl huntSet)
      if (d > 0.0 && ((atomicLoad(&seedMask[s]) >> f) & 1u) != 0u) { d = 0.0; }
      // (U2 §5, the seed-id fix: the GPU-seeded hunt field keeps, per surface, the seed its distance came from
      // (seedMask's second plane: that seed's surface + 1). A neighbour whose seed is no longer one (its distance there
      // isn't 0) is passed over: a seed gone empties the values it made at once, then they refill from the seeds left —
      // no count-up (FRAMECOST FC4))
      let bySource = f == AP.u2.x;
      var src = select(0u, s + 1u, d == 0.0);
      if (d > 0.0) {
        for (var dd = 0u; dd < NDIR; dd++) {
          let l = navLink(s, dd);
          if (l == 0u) { continue; }
          let qn = nbr(p, dd);
          if (!inScope(qn)) { continue; }
          let t = colIdxI(qn) * NAV_K + l - 1u;
          // (round 128d, FT-20: no way into deep water from a surface that isn't — it drowns a walker)
          if (costDeep(t) && !deepHere) { continue; }
          let dn = dist[f * N + t];
          if (dn >= FAR) { continue; }
          var ts = 0u;
          if (bySource) {
            ts = atomicLoad(&seedMask[N + t]);
            if (ts == 0u || dist[f * N + ts - 1u] != 0.0) { continue; }
          }
          // (FT-46: cheaper along a road — both ends on one ROAD_COST, one end halfway)
          let road = 1.0 - (1.0 - ROAD_COST) * 0.5 * (onRoad(p) + onRoad(qn));
          let dt = dn + stepCost(z, costZ(t), costWet(t)) * road;
          if (dt < d) {
            d = dt;
            src = ts;
          }
        }
      }
      // (a field cut off from its seeds counts up forever unless capped: past
      // any real path's length it's unreachable)
      // (round 104: past the scope's own size — a pocket cut off within it counts up to that, then it's settled)
      let nd = select(d, FAR, d > f32(min(G.mapW + G.mapH, (AB[0].z - AB[0].x) + (AB[0].w - AB[0].y))) * 6.0);
      // (round 104: a distance that moved marks its chunk — the next sweep relaxes round it; round 107: past DIST_EPS,
      // else it keeps what it has)
      let od = dist[f * N + s];
      if (bySource) {
        let os = atomicLoad(&seedMask[N + s]);
        let ns2 = select(src, 0u, nd >= FAR);
        // (its seed changed: written, and marked — what came through it is checked again round it)
        if (os != ns2) {
          atomicStore(&seedMask[N + s], ns2);
          atomicOr(&dirtyNext[ch], 1u << f);
          dist[f * N + s] = nd;
          continue;
        }
      }
      if (abs(nd - od) > DIST_EPS || (nd >= FAR) != (od >= FAR)) {
        atomicOr(&dirtyNext[ch], 1u << f);
        dist[f * N + s] = nd;
      }
    }
  }
}

// ---- (FC12, UNIT_MINDS_U2.md §5c) block relaxation ------------------------------------------------------------------
// One workgroup a front chunk (16 x 16 columns, a thread a column). For each field the front names: the chunk's
// distances and a one-column halo from its neighbours are loaded into workgroup memory once, relaxed RELAX_K times
// there (each pass reads the last: a change crosses the chunk in one sweep, not a column or two), and written back
// where they moved past DIST_EPS (marking the chunk for that field, as relax does). The halo stays as loaded: the
// neighbours' own sweeps carry what changes there. The rules are relax's: confined fields, the CPU's and the GPU's seeds,
// the road field, deep water, roads, the cap, and the hunt field's seed-id (each value's seed, checked as it's loaded:
// a value whose seed is gone is loaded as FAR, so the values it made empty at once).
// (?blockrelax=0: relax's front kernel instead; ?relaxk=N the passes)
const RELAX_K: u32 = 16u;
const BT: u32 = 18u;
const BCELLS: u32 = 324u;
var<workgroup> bDist: array<f32, 1296>;
var<workgroup> bSrc: array<u32, 1296>;
var<workgroup> bMask: u32;
fn bAt(lx: u32, ly: u32, k: u32) -> u32 { return (ly * BT + lx) * NAV_K + k; }
const BNONE: u32 = 0xffffffffu;

@compute @workgroup_size(16, 16)
fn relaxBlock(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let c = frontList[wg.x];
  if (li == 0u) { bMask = frontList[FRONT_CAP + wg.x]; }
  let fm = workgroupUniformLoad(&bMask);
  let cxy = vec2<u32>(c % G.chunksX, c / G.chunksX);
  let o = vec2<i32>(cxy * G.chunkSize);
  let ch = pageIdx(cxy);
  let p = o + vec2<i32>(lid.xy);
  let inside = u32(p.x) < G.mapW && u32(p.y) < G.mapH;
  let N = ns();
  let cap = f32(min(G.mapW + G.mapH, (AB[0].z - AB[0].x) + (AB[0].w - AB[0].y))) * 6.0;
  var i = 0u;
  if (inside) { i = colIdxI(p); }
  // (this column's surfaces, their links into the tile and each step's cost: fixed through the sweep)
  var nk = 0u;
  var nT: array<u32, 24>;
  var nC: array<f32, 24>;
  if (inside) {
    for (var k = 0u; k < NAV_K; k++) {
      let s = i * NAV_K + k;
      if (navZ(s) < 0.0) { break; }
      let z = costZ(s);
      if (z < 0.0) { break; }
      nk = k + 1u;
      let deepHere = costDeep(s);
      for (var dd = 0u; dd < NDIR; dd++) {
        nT[k * NDIR + dd] = BNONE;
        let l = navLink(s, dd);
        if (l == 0u) { continue; }
        let qn = nbr(p, dd);
        if (!inScope(qn)) { continue; }
        let t = colIdxI(qn) * NAV_K + l - 1u;
        if (costDeep(t) && !deepHere) { continue; }
        let lq = vec2<u32>(qn - o + vec2<i32>(1));
        nT[k * NDIR + dd] = bAt(lq.x, lq.y, l - 1u);
        let road = 1.0 - (1.0 - ROAD_COST) * 0.5 * (onRoad(p) + onRoad(qn));
        nC[k * NDIR + dd] = stepCost(z, costZ(t), costWet(t)) * road;
      }
    }
  }
  for (var f = 0u; f < AP.n.z; f++) {
    if (((fm >> f) & 1u) == 0u) { continue; }
    // (a field with no seeds: nowhere — set once, as relax)
    if ((AP.n2.w & (1u << f)) == 0u) {
      if (((AP.n3.w >> f) & 1u) != 0u) { for (var k = 0u; k < nk; k++) { dist[f * N + i * NAV_K + k] = FAR; } }
      continue;
    }
    let bySource = f == AP.u2.x;
    // the tile and its halo, loaded (a value whose seed is gone: FAR)
    for (var e = li; e < BCELLS; e += 256u) {
      let q = o + vec2<i32>(i32(e % BT), i32(e / BT)) - vec2<i32>(1);
      let ok = q.x >= 0 && q.y >= 0 && u32(q.x) < G.mapW && u32(q.y) < G.mapH && inScope(q);
      var qi = 0u;
      if (ok) { qi = colIdxI(q); }
      for (var k = 0u; k < NAV_K; k++) {
        var v = FAR;
        var sv = 0u;
        if (ok) {
          v = dist[f * N + qi * NAV_K + k];
          if (bySource && v < FAR) {
            sv = atomicLoad(&seedMask[N + qi * NAV_K + k]);
            let live = sv != 0u && ((((atomicLoad(&seedMask[sv - 1u]) >> f) & 1u) != 0u) || dist[f * N + sv - 1u] == 0.0);
            if (!live) {
              v = FAR;
              sv = 0u;
            }
          }
        }
        bDist[e * NAV_K + k] = v;
        bSrc[e * NAV_K + k] = sv;
      }
    }
    workgroupBarrier();
    // (this column's fixed values: seeds, and off a confined field's place)
    let fp = AP.fieldPlace[f / 4u][f % 4u];
    var fixed: array<u32, 4>;
    for (var k = 0u; k < nk; k++) {
      let s = i * NAV_K + k;
      fixed[k] = 0u;
      if (fp != 0u && !onPlace(s, fp)) { fixed[k] = 2u; continue; }
      var seed = (f == ROAD_FIELD && onNet(p)) || ((atomicLoad(&seedMask[s]) >> f) & 1u) != 0u;
      for (var e = 0u; e < AP.n.y && !seed; e++) {
        let sd = AP.seeds[e];
        if (u32(sd.w) == f && all(cellAt(sd.xy) == p) && surfaceNear(i, sd.z) == k) { seed = true; }
      }
      if (seed) { fixed[k] = 1u; }
    }
    let me = vec2<u32>(lid.xy) + vec2<u32>(1u);
    for (var it = 0u; it < RELAX_K; it++) {
      var nv: array<f32, 4>;
      var nsrc: array<u32, 4>;
      for (var k = 0u; k < nk; k++) {
        if (fixed[k] == 1u) { nv[k] = 0.0; nsrc[k] = i * NAV_K + k + 1u; continue; }
        if (fixed[k] == 2u) { nv[k] = FAR; nsrc[k] = 0u; continue; }
        var d = FAR;
        var sv = 0u;
        for (var dd = 0u; dd < NDIR; dd++) {
          let t = nT[k * NDIR + dd];
          if (t == BNONE) { continue; }
          let dn = bDist[t];
          if (dn >= FAR) { continue; }
          let dt = dn + nC[k * NDIR + dd];
          if (dt < d) {
            d = dt;
            sv = bSrc[t];
          }
        }
        nv[k] = select(d, FAR, d > cap);
        nsrc[k] = select(sv, 0u, nv[k] >= FAR);
      }
      workgroupBarrier();
      for (var k = 0u; k < nk; k++) {
        bDist[bAt(me.x, me.y, k)] = nv[k];
        bSrc[bAt(me.x, me.y, k)] = nsrc[k];
      }
      workgroupBarrier();
    }
    // written back where it moved (DIST_EPS, as relax), the chunk marked for the field
    for (var k = 0u; k < nk; k++) {
      let s = i * NAV_K + k;
      let nd = bDist[bAt(me.x, me.y, k)];
      let od = dist[f * N + s];
      var moved = abs(nd - od) > DIST_EPS || (nd >= FAR) != (od >= FAR);
      if (bySource) {
        let ns2 = bSrc[bAt(me.x, me.y, k)];
        if (atomicLoad(&seedMask[N + s]) != ns2) {
          atomicStore(&seedMask[N + s], ns2);
          moved = true;
        }
      }
      if (moved) {
        dist[f * N + s] = nd;
        atomicOr(&dirtyNext[ch], 1u << f);
      }
    }
    workgroupBarrier();
  }
}

// ---- the front (round 104, simscale — agents/scope.ts) ------------------------------------------------------------
// A sweep relaxes only the chunks of the scope (the box AB[0], whole chunks) where something changed in the last one,
// and those next to them: frontReset, frontBuild (one thread a chunk of the box: it, or a neighbour in the box,
// marked → listed), frontClear (the marks read, cleared), then relax dispatched indirect over the list.
@compute @workgroup_size(1)
fn frontReset() {
  atomicStore(&frontArgs[0], 0u);
  atomicStore(&frontArgs[1], 1u);
  atomicStore(&frontArgs[2], 1u);
  atomicStore(&frontArgs[3], 0u);
}

/** the scope box's chunk t, or none (its chunk x, y; ok) */
fn boxChunk(t: u32) -> vec3<u32> {
  let cs = G.chunkSize;
  let bw = (AB[0].z - AB[0].x) / cs;
  let bh = (AB[0].w - AB[0].y) / cs;
  if (bw == 0u || t >= bw * bh) { return vec3<u32>(0u, 0u, 0u); }
  return vec3<u32>(AB[0].x / cs + t % bw, AB[0].y / cs + t / bw, 1u);
}

@compute @workgroup_size(64)
fn frontBuild(@builtin(global_invocation_id) id: vec3<u32>) {
  // (round 107: the box walked from a place that turns with the tick, so the chunks past FRONT_CAP aren't always the same)
  let cs0 = G.chunkSize;
  let total = ((AB[0].z - AB[0].x) / cs0) * ((AB[0].w - AB[0].y) / cs0);
  if (id.x >= total) { return; }
  let b = boxChunk((id.x + AP.n.w * 37u) % total);
  if (b.z == 0u) { return; }
  let cs = G.chunkSize;
  // (U2, FC10: per field — the low half a change for that field, reaching the chunks round it; the high half carried
  // past FRONT_CAP, itself only. The chunk is relaxed for the fields in `fm` alone)
  var fm = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let i = i32(b.x) + dx;
      let j = i32(b.y) + dy;
      if (i < i32(AB[0].x / cs) || j < i32(AB[0].y / cs) || i >= i32(AB[0].z / cs) || j >= i32(AB[0].w / cs)) { continue; }
      let m = atomicLoad(&dirtyCur[pageIdx(vec2<u32>(u32(i), u32(j)))]);
      fm |= m & ALL_FIELDS;
      if (dx == 0 && dy == 0) { fm |= m >> 16u; }
    }
  }
  if (fm == 0u) { return; }
  // (FC11: what asks, a field at a time — a change round it (low) or carried (high, not also changed); counted only
  // under ?agentprof=1, which reads and clears them each tick: AP.u2.w)
  for (var f = 0u; f < NFIELDS && AP.u2.w != 0u; f++) {
    if (((fm >> f) & 1u) == 0u) { continue; }
    var changed = false;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let i = i32(b.x) + dx;
        let j = i32(b.y) + dy;
        if (i < i32(AB[0].x / cs) || j < i32(AB[0].y / cs) || i >= i32(AB[0].z / cs) || j >= i32(AB[0].w / cs)) { continue; }
        if (((atomicLoad(&dirtyCur[pageIdx(vec2<u32>(u32(i), u32(j)))]) >> f) & 1u) != 0u) { changed = true; }
      }
    }
    atomicAdd(&frontDbg[select(16u + f, f, changed)], 1u);
  }
  // (round 107: past FRONT_CAP, the chunk is carried to the next sweep — its fields in the high half: relaxed then, itself only)
  let k = atomicAdd(&frontArgs[3], 1u);
  if (k >= FRONT_CAP) {
    atomicOr(&dirtyNext[pageIdx(b.xy)], fm << 16u);
    return;
  }
  // (FC12: the relax kernel's workgroups a chunk — relax's front 4 (8 x 8 each), relaxBlock 1)
  atomicAdd(&frontArgs[0], FRONT_WG);
  frontList[k] = b.y * G.chunksX + b.x;
  frontList[FRONT_CAP + k] = fm;
}

@compute @workgroup_size(64)
fn frontClear(@builtin(global_invocation_id) id: vec3<u32>) {
  let b = boxChunk(id.x);
  if (b.z == 0u) { return; }
  atomicStore(&dirtyCur[pageIdx(b.xy)], 0u);
}

/** (round 107) the fields left without seeds this tick, or starting over (a seed gone or moved far: agents.ts seed),
 *  AP.n3.w, set unreachable over a tile list (the scope): no marks — nothing follows a field with no seeds, and its
 *  seeds mark where it refills from */
@compute @workgroup_size(8, 8)
fn clearFields(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let N = ns();
  for (var f = 0u; f < NFIELDS; f++) {
    if (((AP.n3.w >> f) & 1u) == 0u) { continue; }
    for (var k = 0u; k < NAV_K; k++) { dist[f * N + i * NAV_K + k] = FAR; }
  }
}

/** mark the chunks of a tile list changed (a seed placed or moved, a field cleared: agents.ts) */
@compute @workgroup_size(8, 8)
fn markChunks(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  // (FC11 (c): for the fields whose seeds moved — not every field)
  atomicOr(&dirtyCur[chunkOfCol(id.x, id.y)], AP.u2.y & ALL_FIELDS);
}
