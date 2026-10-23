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
  seeds: array<vec4<f32>, 32>,
  // per group (16): the field it follows, and the material it's drawn in
  groupField: array<vec4<u32>, 4>,
  groupMat: array<vec4<u32>, 4>,
  // per field: the place it's confined to (0 anywhere; bit 31 a region,
  // else a room): its distances live only on that place's surfaces
  fieldPlace: vec4<u32>,
  // x hits this tick, y targets, z events capacity
  n2: vec4<u32>,
  // the kinds of unit (units.wgsl Kind)
  kinds: array<Kind, 8>,
  // the game's hits this tick (units.wgsl Hit)
  hits: array<Hit, 32>,
  // what hostile kinds go for (the player's units): x, y, z, radius
  targets: array<vec4<f32>, 8>,
  // x holds, y launches this tick
  n3: vec4<u32>,
  // units the game holds (a lich, a gorilla): where (x, y, z) and the slot (w)
  holds: array<vec4<f32>, 8>,
  // units thrown this tick: velocity (x, y, z) and the slot (w)
  launches: array<vec4<f32>, 32>,
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

const NAV_K: u32 = 4u;
const AGENT_H: f32 = 1.5;
const STEP: f32 = 1.1;
const DROP: f32 = 2.6;
const WADE: f32 = 0.6;
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
      // (only the top surface carries the water sheet)
      let wet = r == i32(n) - 1 && water[i] > WADE;
      let room = select(underRoom, topRoom, out == 0u);
      let region = select(0u, placeTable[room], room != 0u);
      nav[i * NAV_K + out] = vec4<u32>(bitcast<u32>(z), u32(min(head, 31.0) * 8.0) | (select(0u, 1u, wet) << 8u), (room & 0xffffu) | (region << 16u), bitcast<u32>(select(0.0, water[i], out == 0u)));
      out += 1u;
    }
    r -= 1;
  }
  for (var k = out; k < NAV_K; k++) { nav[i * NAV_K + k] = vec4<u32>(bitcast<u32>(-1.0), 0u, 0u, 0u); }
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
        let dz = zq - z;
        if (dz > STEP || dz < -DROP) { continue; }
        // headroom over the step: the lower ceiling above the higher floor
        if (min(ceilA, zq + navHead(j0 + j)) - max(z, zq) < AGENT_H) { continue; }
        if (abs(dz) < bestDz) { bestDz = abs(dz); best = j + 1u; }
      }
      bits |= best << (3u * d);
    }
    nav[s].y = (nav[s].y & 0x1ffu) | (bits << 9u);
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
  for (var k = 0u; k < NAV_K; k++) {
    let s = i * NAV_K + k;
    let z = navZ(s);
    if (z < 0.0) {
      for (var f = 0u; f < AP.n.z; f++) { dist[f * N + s] = FAR; }
      continue;
    }
    for (var f = 0u; f < AP.n.z; f++) {
      // (confined: off its place, nothing)
      let fp = AP.fieldPlace[f];
      if (fp != 0u && !onPlace(s, fp)) {
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
      if (d > 0.0) {
        for (var dd = 0u; dd < NDIR; dd++) {
          let l = navLink(s, dd);
          if (l == 0u) { continue; }
          let t = colIdxI(nbr(p, dd)) * NAV_K + l - 1u;
          let dn = dist[f * N + t];
          if (dn >= FAR) { continue; }
          d = min(d, dn + stepCost(z, navZ(t), navWet(t)));
        }
      }
      // (a field cut off from its seeds counts up forever unless capped: past
      // any real path's length it's unreachable)
      dist[f * N + s] = select(d, FAR, d > f32(G.mapW + G.mapH) * 6.0);
    }
  }
}
