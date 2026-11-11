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
// Fields: a distance to a field's seeds on every surface (U2 round 7: on
// pages, as many fields as the pool has rows — fieldseam.wgsl), shared by
// every group heading the same way, relaxed a few sweeps a tick. A surface's value is recomputed from its neighbours only
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
// (binding 6: the fields' page pool — gpu/pagepool.ts, fieldseam.wgsl)
// (units.wgsl: the units, their crowding and their voxels, bindings 7-9, 13-14)

struct AgentParams {
  // x units, y seeds, z fields in use, w ticks
  n: vec4<u32>,
  // x, y, z (world), w the field it seeds
  seeds: array<vec4<f32>, 48>,
  // per group (24: agents.ts MAX_GROUPS): the field it follows, and the material it's drawn in
  groupField: array<vec4<u32>, 64>,
  groupMat: array<vec4<u32>, 64>,
  // x hits this tick, y targets, z events capacity, w unused
  n2: vec4<u32>,
  // the kinds of unit (units.wgsl Kind)
  kinds: array<Kind, 8>,
  // the game's hits this tick (units.wgsl Hit)
  hits: array<Hit, 32>,
  // what hostile kinds go for (the player's units): x, y, z (its feet), radius
  targets: array<vec4<f32>, 8>,
  // x holds, y launches, z regroups this tick, w unused
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
  // (round 128o, DA-B22) x the units' step's dt (s): a tick's, or at fast-forward the ticks since the last step's
  // (agents.ts stepPlan) — what units.wgsl integrates by in place of G.dt
  // (y, round 128p) the rekinds this step
  step: vec4<f32>,
  // (round 128p, DA-B22 (c)(4)) units made another kind where they stand (agents.ts rekind): x the slot, y the kind,
  // z its hp (f32 bits) when w is 1
  rekinds: array<vec4<u32>, 8>,
  // (U2) x the GPU-seeded hunt field (FIELD_NONE: none; ?jfa's targets JFA starts it), y the road field (FIELD_NONE
  // none), z flags (units.wgsl SEEN_ONLY ...), w 1: ?agentprof=1 (frontDbg counted)
  u2: vec4<u32>,
};
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
      if (nc != oc || ov.z != nv.z) { ppMarkSlot(chunkOfCol(id.x, id.y)); }
      // (its links kept: the links pass makes them again, the same where nothing moved — so no change is flagged)
      nav[i * NAV_K + out] = vec4<u32>(nv.x, nv.y | (ov.y & ~0x1ffu), nv.z, nv.w);
      out += 1u;
    }
    r -= 1;
  }
  for (var k = out; k < NAV_K; k++) {
    let none = vec4<u32>(bitcast<u32>(-1.0), 0u, 0u, 0u);
    if (navMoved(nav[i * NAV_K + k], none)) { ppMarkSlot(chunkOfCol(id.x, id.y)); }
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
    if (ny != nav[s].y) { ppMarkSlot(chunkOfCol(id.x, id.y)); }
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

// ---- (FC12) block relaxation: fieldseam.wgsl fieldRelax, over pages (U2 round 7) ----
/** the relax's passes a sweep over a chunk in workgroup memory (?relaxk=N) */
const RELAX_K: u32 = 16u;
const BNONE: u32 = 0xffffffffu;
