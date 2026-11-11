// (archgen, docs/design/ARCHGEN.md) The building generator: one thread a lot reads its citygen record
// (api/contracts/citygen.ts: 24 words) and writes up to PPL parts (a compact semantic plan: bodies, roofs) into the
// lot's own slot; a compact pass appends the live parts to a draw list a kind and writes the kinds' instance counts;
// each kind's vertex shader builds its shape from vertex_index (no vertex buffers). The fragment shader paints the
// materials, windows and doors from the lot's style (archgen/styles.ts STYLE_WORDS, mirrored here).

const RECW: u32 = 24u;
/** u32 words a part */
const PW: u32 = 16u;
/** parts a lot (its slot) */
const PPL: u32 = 24u;
/** part kinds (0 an empty slot) */
const K_BODY: u32 = 1u;
const K_ROOF: u32 = 2u;
/** a parapet with merlons round a quad (4 edges × (a wall + CREN_M merlons)); 11–14: its wall height, merlon height,
 *  merlon width, thickness */
const K_CREN: u32 = 3u;
const NK: u32 = 4u;
const CREN_M: u32 = 8u;
/** surfaces (the part's word 0, bits 8–15) */
const S_WALL: u32 = 0u;
const S_PLINTH: u32 = 1u;
const S_TRIM: u32 = 2u;
const S_ROOF: u32 = 3u;
const S_STONE: u32 = 4u;
const S_CHIMNEY: u32 = 5u;
const S_GROUND: u32 = 6u;
/** part flags (word 0, bits 16–23) */
const F_FRONT0: u32 = 1u; // the body's side 0 faces the street (its door)
const F_NOWIN: u32 = 2u;  // no windows (plinth, chimney, trim)
/** a storey, world units (citygen: about 3) */
const STOREY: f32 = 3.0;
/** vec4s a style (styles.ts STYLE_VEC4S) */
const SV: u32 = 8u;

// Part layout (PW words):
//   0  kind | surface << 8 | flags << 16
//   1  lot index
//   2–9  four corners (x, y; f32), counter-clockwise
//   10 z0 (f32): a body's bottom; a roof's eave
//   11–14: a body's top z at each corner; a roof's ridge z, ridge inset (0 gable … 0.5 pyramid), axis (0: the ridge
//          parallel to corner 0 → 1; 1: to 1 → 2), overhang
//   15 style id | lot's storeys << 8 | (frontage side + 1) << 16 (0 none)

struct GenU {
  /** the first lot this run makes, how many */
  first: u32,
  count: u32,
  /** a style for every lot (the lab's override), or 0xffffffff the district's */
  style: u32,
  /** (lab) write each lot's parcel as a ground body in slot 0 */
  ground: u32,
  /** (lab) the ground's bottom z */
  zmin: f32,
  /** the styles in the table */
  nstyles: u32,
  /** the lot slots (ARCH's room: lots past it are not made) */
  lots: u32,
  _p1: u32,
};

fn hash(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
fn rnd(seed: u32, k: u32) -> f32 { return f32(hash(seed ^ (k * 0x9e3779b9u)) & 0xffffu) / 65535.0; }

fn persp2(a: vec2<f32>) -> vec2<f32> { return vec2<f32>(a.y, -a.x); }

// ---- generation -------------------------------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> GU: GenU;
@group(0) @binding(1) var<storage, read> REC: array<u32>;
@group(0) @binding(2) var<storage, read> CNT: array<u32>;
// the arch buffer (archgen.ts layout): a header [styles, list, parts, room] in u32 words, the styles, the draw lists,
// the parts
@group(0) @binding(3) var<storage, read_write> ARCH: array<u32>;

fn rf(o: u32, w: u32) -> f32 { return bitcast<f32>(REC[o + w]); }

var<private> gLot: u32;
/** the parts' first word in ARCH */
var<private> PB: u32;
var<private> gN: u32;
var<private> gTag: u32;

fn put(kind: u32, surf: u32, flags: u32, q0: array<vec2<f32>, 4>, z0: f32, t: vec4<f32>) {
  if (gN >= PPL) { return; }
  let o = (gLot * PPL + gN) * PW;
  gN++;
  var q = q0;
  ARCH[PB + o] = kind | (surf << 8u) | (flags << 16u);
  ARCH[PB + o + 1u] = gLot;
  for (var k = 0u; k < 4u; k++) {
    ARCH[PB + o + 2u + k * 2u] = bitcast<u32>(q[k].x);
    ARCH[PB + o + 3u + k * 2u] = bitcast<u32>(q[k].y);
  }
  ARCH[PB + o + 10u] = bitcast<u32>(z0);
  ARCH[PB + o + 11u] = bitcast<u32>(t.x);
  ARCH[PB + o + 12u] = bitcast<u32>(t.y);
  ARCH[PB + o + 13u] = bitcast<u32>(t.z);
  ARCH[PB + o + 14u] = bitcast<u32>(t.w);
  ARCH[PB + o + 15u] = gTag;
}

fn body(surf: u32, flags: u32, q: array<vec2<f32>, 4>, z0: f32, z1: f32) {
  put(K_BODY, surf, flags, q, z0, vec4<f32>(z1));
}

/** q grown outward by d (each corner along the bisector of its two edges' outward normals) */
fn grow(q0: array<vec2<f32>, 4>, d: f32) -> array<vec2<f32>, 4> {
  var q = q0;
  var r = q0;
  for (var k = 0u; k < 4u; k++) {
    let p = q[(k + 3u) % 4u];
    let n = q[(k + 1u) % 4u];
    let e0 = normalize(q[k] - p);
    let e1 = normalize(n - q[k]);
    let n0 = persp2(e0);
    let n1 = persp2(e1);
    let b = n0 + n1;
    let s = max(dot(normalize(b), n0), 0.3);
    r[k] = q[k] + normalize(b) * (d / s);
  }
  return r;
}

/** the sub-quad s ∈ [s0, s1] along edge 0 → 1, t ∈ [t0, t1] along edge 0 → 3 (bilinear) */
fn sub(q0: array<vec2<f32>, 4>, s0: f32, s1: f32, t0: f32, t1: f32) -> array<vec2<f32>, 4> {
  var q = q0;
  let a0 = mix(q[0], q[1], s0);
  let a1 = mix(q[0], q[1], s1);
  let b0 = mix(q[3], q[2], s0);
  let b1 = mix(q[3], q[2], s1);
  return array<vec2<f32>, 4>(mix(a0, b0, t0), mix(a1, b1, t0), mix(a1, b1, t1), mix(a0, b0, t1));
}

fn sty(s: u32, i: u32) -> vec4<f32> {
  let o = ARCH[0] + (s * SV + i) * 4u;
  return bitcast<vec4<f32>>(vec4<u32>(ARCH[o], ARCH[o + 1u], ARCH[o + 2u], ARCH[o + 3u]));
}

/** one house unit on quad q: plinth, body (a jetty above the ground floor), cornice, roof, a chimney */
fn unit(q0: array<vec2<f32>, 4>, ground: f32, eave: f32, s: u32, seed: u32, front: bool, ridgeAlong: bool) {
  var q = q0;
  let shape = sty(s, 4u);
  let shape2 = sty(s, 5u);
  let pitch = shape.x * mix(0.85, 1.2, rnd(seed, 1u));
  let over = shape.y;
  let jetty = shape.z;
  // the plinth
  let ff = select(0u, F_FRONT0, front);
  body(S_PLINTH, F_NOWIN, grow(q, 0.08), ground - 0.6, ground + 0.45);
  // the walls: a jetty (upper floors out over the ground floor) when the style has one and there are two storeys
  var top = q;
  if (jetty > 0.0 && eave - ground > STOREY * 1.6) {
    let j = ground + STOREY;
    body(S_WALL, ff, q, ground + 0.45, j);
    top = grow(q, jetty);
    body(S_TRIM, F_NOWIN, grow(q, jetty + 0.05), j - 0.18, j + 0.05);
    body(S_WALL, ff, top, j + 0.05, eave);
  } else {
    body(S_WALL, ff, q, ground + 0.45, eave);
  }
  // the cornice
  body(S_TRIM, F_NOWIN, grow(top, 0.07), eave - 0.22, eave);
  // the roof: the ridge along the longer side unless the style turns its gables to the street
  let l0 = length(top[1] - top[0]) + length(top[2] - top[3]);
  let l1 = length(top[2] - top[1]) + length(top[3] - top[0]);
  var axis = select(1u, 0u, l0 >= l1);
  if (!ridgeAlong) { axis = 1u - axis; }
  let span = select(l0, l1, axis == 0u) * 0.25; // half the span across the ridge
  let hipOdds = shape2.x;
  var inset = 0.0;
  if (rnd(seed, 2u) < hipOdds) { inset = min(0.45, span / max(select(l1, l0, axis == 0u) * 0.5, 0.1)); }
  // (the roof never outweighs the walls: Tiny Glade's houses are walls first)
  let rise = min(pitch * span, min(max(1.4, (eave - ground) * 0.8), 4.2));
  if (shape2.z > 0.5) {
    // a flat roof behind a crenellated parapet (the keep's)
    put(K_CREN, S_STONE, 0u, grow(top, 0.06), eave, vec4<f32>(0.7, 0.75, 0.7, 0.45));
  } else {
    // (the eave a little over the cornice, whose top would poke through the slope's plane just past the wall)
    put(K_ROOF, S_ROOF, 0u, top, eave + 0.1, vec4<f32>(eave + 0.1 + rise, inset, f32(axis), over));
    // a chimney on the ridge
    if (rnd(seed, 3u) < shape.w) {
      let c = (top[0] + top[1] + top[2] + top[3]) * 0.25;
      let ea = normalize(select(top[2] - top[1], top[1] - top[0], axis == 0u));
      let p = c + ea * (rnd(seed, 4u) - 0.5) * 0.9 * (select(l1, l0, axis == 0u) * 0.5 - 1.0);
      let en = persp2(ea);
      let w = 0.32;
      let cq = array<vec2<f32>, 4>(p - ea * w - en * w, p + ea * w - en * w, p + ea * w + en * w, p - ea * w + en * w);
      body(S_CHIMNEY, F_NOWIN, cq, eave + rise * 0.3, eave + rise + 0.9);
    }
  }
}

/** a round-ish tower on corner k of q: a stone body and a steep spire */
fn tower(q0: array<vec2<f32>, 4>, k: u32, ground: f32, top: f32, s: u32, seed: u32) {
  var q = q0;
  let c = q[k];
  let ea = normalize(q[(k + 1u) % 4u] - c);
  let eb = normalize(q[(k + 3u) % 4u] - c);
  let w = clamp(min(length(q[(k + 1u) % 4u] - c), length(q[(k + 3u) % 4u] - c)) * 0.42, 1.4, 3.2);
  let tq = array<vec2<f32>, 4>(c - (ea + eb) * 0.35, c + ea * w - eb * 0.35, c + (ea + eb) * w, c + eb * w - ea * 0.35);
  body(S_PLINTH, F_NOWIN, grow(tq, 0.1), ground - 0.6, ground + 0.5);
  body(S_STONE, 0u, tq, ground + 0.5, top);
  body(S_TRIM, F_NOWIN, grow(tq, 0.12), top - 0.3, top);
  if (sty(s, 5u).z > 0.5 && rnd(seed, 15u) < 0.5) {
    // a fighting top: merlons round the tower's roof, the spire set in
    put(K_CREN, S_STONE, 0u, grow(tq, 0.12), top, vec4<f32>(0.5, 0.6, 0.5, 0.35));
    put(K_ROOF, S_ROOF, 0u, grow(tq, -0.3), top + 0.4, vec4<f32>(top + 0.4 + w * sty(s, 5u).y * 0.8, 0.5, 0.0, 0.1));
    return;
  }
  put(K_ROOF, S_ROOF, 0u, grow(tq, 0.0), top, vec4<f32>(top + w * sty(s, 5u).y, 0.5, 0.0, 0.25));
}

@compute @workgroup_size(64)
fn gen(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= GU.count) { return; }
  let i = GU.first + g.x;
  gLot = i;
  PB = ARCH[2];
  gN = 0u;
  let lots = min(min(CNT[0], CNT[3]), GU.lots);
  if (i >= lots) { return; }
  let o = i * RECW;
  var q: array<vec2<f32>, 4>;
  var parcel: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) {
    q[k] = vec2<f32>(rf(o, 8u + k * 2u), rf(o, 9u + k * 2u));
    parcel[k] = vec2<f32>(rf(o, k * 2u), rf(o, 1u + k * 2u));
  }
  let kind = REC[o + 17u];
  let district = REC[o + 18u];
  let storeys = REC[o + 19u];
  let height = rf(o, 20u);
  let zb = rf(o, 21u);
  let seed = hash(REC[o + 23u] + 17u);
  let front = REC[o + 16u];
  // the style: the lab's override, else the district's (until citygen's districtStyle word: a hash of the district)
  var s = GU.style;
  if (s == 0xffffffffu) { s = hash(district * 31u + 7u) % GU.nstyles; }
  gTag = s | (storeys << 8u);
  // (lab) the parcel as ground, its kind's surface
  if (GU.ground != 0u) {
    gTag = s | (kind << 8u);
    body(S_GROUND, F_NOWIN, parcel, GU.zmin, zb + 0.5);
    gTag = s | (storeys << 8u);
  }
  if (kind != 1u || storeys == 0u || height <= 0.0) {
    for (var j = gN; j < PPL; j++) { ARCH[PB + (i * PPL + j) * PW] = 0u; }
    return;
  }
  // turn the quad so its side 0 is the frontage (a door on it); none: the longest side
  var r = 0u;
  if (front < 4u) { r = front; } else {
    var best = 0.0;
    for (var k = 0u; k < 4u; k++) {
      let l = length(q[(k + 1u) % 4u] - q[k]);
      if (l > best) { best = l; r = k; }
    }
  }
  var fq: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { fq[k] = q[(k + r) % 4u]; }
  let ground = zb + 0.5;
  ARCH[ARCH[6] + i] = bitcast<u32>(ground);
  let eave = zb + height;
  let wide = (length(fq[1] - fq[0]) + length(fq[2] - fq[3])) * 0.5;
  let deep = (length(fq[3] - fq[0]) + length(fq[2] - fq[1])) * 0.5;
  let shape2 = sty(s, 5u);
  let unitW = sty(s, 6u).x;
  // row houses along the street: the frontage split into units, each its own height and roof
  let n = clamp(u32(round(wide / unitW)), 1u, 3u);
  // a deep lot: a lower back wing
  let wing = deep > wide * 1.5 && deep > 7.0;
  let tf = select(1.0, 0.58, wing);
  let ridgeAlong = shape2.w < 0.5;
  for (var u = 0u; u < n; u++) {
    let us = hash(seed + u * 101u);
    let s0 = f32(u) / f32(n);
    let s1 = f32(u + 1u) / f32(n);
    let uq = sub(fq, s0, s1, 0.0, tf);
    var e = eave;
    if (n > 1u && rnd(us, 9u) < 0.5 && eave - ground > STOREY * 1.5) { e = eave - STOREY; }
    e = e + (rnd(us, 10u) - 0.5) * 0.6;
    unit(uq, ground, e, s, us, true, select(ridgeAlong, !ridgeAlong, rnd(us, 11u) < 0.2));
  }
  if (wing) {
    let wq = sub(fq, 0.12, 0.88, tf, 1.0);
    let we = max(ground + STOREY, eave - STOREY);
    unit(wq, ground, we, s, hash(seed + 977u), false, !ridgeAlong);
  }
  // a corner tower: the style's odds, on a lot big enough
  if (rnd(seed, 12u) < sty(s, 6u).y && min(wide, deep) > 4.5) {
    tower(fq, select(0u, 1u, rnd(seed, 13u) < 0.5), ground, eave + STOREY * mix(0.6, 1.4, rnd(seed, 14u)), s, seed);
  }
  for (var j = gN; j < PPL; j++) { ARCH[PB + (i * PPL + j) * PW] = 0u; }
}

// ---- compaction: the live parts into a draw list a kind, the kinds' instance counts -------------------------------

@group(0) @binding(0) var<uniform> CU: vec4<u32>; // x part slots
@group(0) @binding(1) var<storage, read_write> CA: array<u32>; // the arch buffer
@group(0) @binding(2) var<storage, read_write> ARGS: array<atomic<u32>>;

@compute @workgroup_size(1)
fn reset() {
  for (var k = 0u; k < NK; k++) { atomicStore(&ARGS[k * 4u + 1u], 0u); }
}

@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= CU.x) { return; }
  let kind = CA[CA[2] + g.x * PW] & 0xffu;
  if (kind == 0u || kind >= NK) { return; }
  let n = atomicAdd(&ARGS[kind * 4u + 1u], 1u);
  let room = CA[3];
  if (n < room) { CA[CA[1] + kind * room + n] = g.x; }
}
