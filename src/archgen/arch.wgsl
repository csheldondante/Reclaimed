// (archgen, docs/design/ARCHGEN.md) The building generator: one thread a lot reads its citygen record
// (api/contracts/citygen.ts: 24 words) and writes up to PPL parts (a compact semantic plan) into the lot's own slot; a
// compact pass appends the live parts to a draw list a kind and writes the kinds' instance counts; each kind's vertex
// shader builds its shape from vertex_index (no vertex buffers). The fragment shader paints the materials from the
// lot's style (archgen/styles.ts, mirrored here).
//
// The massing grammar (round 2, after the user: "extruded warped rectangles with a texture slapped on them"; the
// references: Tiny Glade): a house is composed of volumes in the lot's own frame — a main block (its gable to the street
// or its eaves), a lower wing making an L, a lean-to behind, a round or square tower at a corner, a porch on the door, a
// stair up the side, dormers in the roofs, a low wall round the yard — and the volumes are smaller than the lot, the
// rest garden and yard. The lot is irregular but the building isn't: every volume is a true rectangle in a frame square
// to the street, inscribed in the lot (the user: "the lot is irregular but the structure is generally parallel walls
// except for intentionally curved or rotated wings. Think overlapping rotated and offset rectangles for the floor
// plan"); a wing may be turned on purpose about its own centre (the style's odds and angle).

const RECW: u32 = 24u;
/** u32 words a part */
const PW: u32 = 16u;
/** parts a lot (its slot) */
const PPL: u32 = 96u;
/** part kinds (0 an empty slot) */
const K_BODY: u32 = 1u;
const K_ROOF: u32 = 2u;
/** a parapet with merlons round a quad (4 edges × (a wall + CREN_M merlons)); 11–14: its wall height, merlon height,
 *  merlon width, thickness */
const K_CREN: u32 = 3u;
/** a window or a door on a wall: corners 0 → 1 its bottom edge on the wall's face (the wall's outside on the right),
 *  z0 its sill, 11 its height, 12 its frame */
const K_WIN: u32 = 4u;
/** a round body: corner 0 its centre, corner 1.x its radius, z0 → 11 */
const K_CYL: u32 = 5u;
/** a conical roof: corner 0 its centre, corner 1.x its eave's radius, z0 its eave, 11 its apex */
const K_CONE: u32 = 6u;
/** a flight of steps: corners 0 → 1 its foot's edge, 3 → 2 its head's; z0 → 11 */
const K_STAIR: u32 = 7u;
const NK: u32 = 8u;
const CREN_M: u32 = 8u;
/** segments round a K_CYL / K_CONE; a roof's courses */
const ROUND_N: u32 = 16u;
const COURSES: u32 = 12u;
const CONE_ROWS: u32 = 10u;
/** surfaces (the part's word 0, bits 8–15) */
const S_WALL: u32 = 0u;
const S_PLINTH: u32 = 1u;
const S_TRIM: u32 = 2u;
const S_ROOF: u32 = 3u;
const S_STONE: u32 = 4u;
const S_CHIMNEY: u32 = 5u;
const S_GROUND: u32 = 6u;
const S_FRAME: u32 = 7u;
const S_SHUTTER: u32 = 8u;
const S_GLASS: u32 = 9u;
const S_FLOWER: u32 = 10u;
const S_DOOR: u32 = 11u;
const S_WOOD: u32 = 12u;
const S_LOTWALL: u32 = 13u;
/** part flags (word 0, bits 16–23) */
const F_FRONT0: u32 = 1u; // the body's side 0 faces the street (its door)
const F_NOWIN: u32 = 2u;  // no painted windows (plinth, chimney, trim; and bodies whose windows are geometry)
const F_DOOR: u32 = 4u;   // K_WIN: a door
const F_SHUT: u32 = 8u;   // K_WIN: shutters
const F_BOX: u32 = 16u;   // K_WIN: a flower box
const F_SHED: u32 = 32u;  // K_ROOF: a lean-to (one slope, its high side on edge 3 → 2 after the turn)
const F_CANOPY: u32 = 64u; // K_WIN (a door): a canopy over it
const F_UNDER: u32 = 128u; // a wall under a roof: its top dark (a seam between courses never shows it)
/** a storey, world units (citygen: about 3) */
const STOREY: f32 = 3.0;
/** vec4s a style (styles.ts STYLE_VEC4S) */
const SV: u32 = 10u;

// Part layout (PW words):
//   0  kind | surface << 8 | flags << 16
//   1  lot index
//   2–9  four corners (x, y; f32), counter-clockwise
//   10 z0 (f32): a body's bottom; a roof's eave
//   11–14: a body's top z at each corner; a roof's ridge z, ridge inset (0 gable … 0.5 pyramid), turn (0–3: the
//          corners turned so the ridge is parallel to corner 0 → 1), overhang; the other kinds' above
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

/** a wall's bays: as many as fit `bay` wide (one at least) */
fn baysOf(len: f32, bay: f32) -> u32 { return max(1u, u32(round(len / bay))); }
/** the bay the door is in (the painted and the built agree): the middle of two, else one off the corners */
fn doorBayOf(lot: u32, nb: u32) -> u32 {
  if (nb <= 2u) { return nb / 2u; }
  return 1u + hash(lot * 7u + 3u) % (nb - 2u);
}
/** does a storey's window fit under a wall's top? (painted and built alike) */
fn winFits(st: u32, top: f32, wallH: f32) -> bool { return f32(st) * STOREY + top + 0.3 <= wallH; }

// ---- generation -------------------------------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> GU: GenU;
@group(0) @binding(1) var<storage, read> REC: array<u32>;
@group(0) @binding(2) var<storage, read> CNT: array<u32>;
// the arch buffer (archgen.ts layout): a header, the styles, the draw lists, the parts, the progress, the grounds
@group(0) @binding(3) var<storage, read_write> ARCH: array<u32>;

fn rf(o: u32, w: u32) -> f32 { return bitcast<f32>(REC[o + w]); }

var<private> gLot: u32;
/** the parts' first word in ARCH */
var<private> PB: u32;
var<private> gN: u32;
var<private> gTag: u32;
var<private> gS: u32;
var<private> gGround: f32;
/** the walls whose windows are built (their part slots), for the window pass */
var<private> gWalls: array<u32, 12>;
var<private> gNW: u32;
/** the lot's frame: its origin, along the street, into the lot */
var<private> LO: vec2<f32>;
var<private> LX: vec2<f32>;
var<private> LY: vec2<f32>;
var<private> gQ: array<vec2<f32>, 4>;
/** a wing turned on purpose: the angle (radians) about its pivot (the lot's frame); 0 square */
var<private> gRot: f32;
var<private> gPiv: vec2<f32>;
var<private> gW: f32;
var<private> gD: f32;

fn put(kind: u32, surf: u32, flags: u32, q0: array<vec2<f32>, 4>, z0: f32, t: vec4<f32>) -> u32 {
  if (gN >= PPL) { return 0xffffffffu; }
  let slot = gN;
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
  return slot;
}

fn body(surf: u32, flags: u32, q: array<vec2<f32>, 4>, z0: f32, z1: f32) -> u32 {
  return put(K_BODY, surf, flags, q, z0, vec4<f32>(z1));
}

/** a wall body whose windows the window pass builds */
fn wallBody(surf: u32, flags: u32, q: array<vec2<f32>, 4>, z0: f32, z1: f32) {
  let slot = body(surf, flags, q, z0, z1);
  if (slot != 0xffffffffu && gNW < 12u) {
    gWalls[gNW] = slot;
    gNW++;
  }
}

/** q grown outward by d (each corner along the bisector of its two edges' outward normals) */
fn grow(q0: array<vec2<f32>, 4>, d: f32) -> array<vec2<f32>, 4> {
  var q = q0;
  var r = q0;
  for (var k = 0u; k < 4u; k++) {
    let p = q[(k + 3u) % 4u];
    let n = q[(k + 1u) % 4u];
    let n0 = persp2(normalize(q[k] - p));
    let n1 = persp2(normalize(n - q[k]));
    let b = normalize(n0 + n1);
    r[k] = q[k] + b * (d / max(dot(b, n0), 0.3));
  }
  return r;
}

fn sty(s: u32, i: u32) -> vec4<f32> {
  let o = ARCH[0] + (s * SV + i) * 4u;
  return bitcast<vec4<f32>>(vec4<u32>(ARCH[o], ARCH[o + 1u], ARCH[o + 2u], ARCH[o + 3u]));
}

/** a point of the lot's frame: x along the street (0 … gW), y into the lot (0 … gD) */
fn lp(x: f32, y: f32) -> vec2<f32> {
  var v = vec2<f32>(x, y);
  if (gRot != 0.0) {
    let d = v - gPiv;
    let cs = cos(gRot);
    let sn = sin(gRot);
    v = gPiv + vec2<f32>(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
  }
  return LO + LX * v.x + LY * v.y;
}
/** a rectangle of the lot's frame, counter-clockwise, its side 0 on the street side */
fn rect(x0: f32, x1: f32, y0: f32, y1: f32) -> array<vec2<f32>, 4> {
  return array<vec2<f32>, 4>(lp(x0, y0), lp(x1, y0), lp(x1, y1), lp(x0, y1));
}

/** a roof over q: its ridge parallel to q's side `turn` (0 or 1, or 2/3 for a lean-to's high side), rise over the
 *  half span, hip inset, overhang */
fn roof(q: array<vec2<f32>, 4>, eave: f32, turn: u32, pitch: f32, inset: f32, over: f32, flags: u32) -> f32 {
  var c = q;
  let a = length(c[(turn + 1u) % 4u] - c[turn]) + length(c[(turn + 2u) % 4u] - c[(turn + 3u) % 4u]);
  let b = length(c[(turn + 2u) % 4u] - c[(turn + 1u) % 4u]) + length(c[(turn + 3u) % 4u] - c[turn]);
  var span = b * 0.25;
  if ((flags & F_SHED) != 0u) { span = b * 0.5; }
  // (walls first: a roof's rise no more than its walls are tall, Tiny Glade's proportion)
  let rise = min(pitch * span, min(max(1.6, (eave - gGround) * 0.85), 5.0));
  let ins = select(0.0, min(inset, span / max(a * 0.5, 0.1)), inset > 0.0);
  put(K_ROOF, S_ROOF, flags, q, eave, vec4<f32>(eave + rise, ins, f32(turn), over));
  return rise;
}

/** a chimney with its cap at p, from z0 to z1 */
fn chimney(p: vec2<f32>, z0: f32, z1: f32) {
  let w = 0.34;
  let cq = array<vec2<f32>, 4>(p + vec2<f32>(-w, -w), p + vec2<f32>(w, -w), p + vec2<f32>(w, w), p + vec2<f32>(-w, w));
  body(S_CHIMNEY, F_NOWIN, cq, z0, z1);
  body(S_CHIMNEY, F_NOWIN, grow(cq, 0.08), z1 - 0.18, z1);
}

/** a block of a house in the lot's frame: plinth, walls (a jetty above the ground floor if the style has one),
 *  cornice, roof (ridge along x — turn 0 — or y — turn 1), a chimney. Returns its roof's rise. */
fn block(x0: f32, x1: f32, y0: f32, y1: f32, eave: f32, turn: u32, seed: u32, front: bool, chim: bool) -> f32 {
  let s = gS;
  let ground = gGround;
  let shape = sty(s, 4u);
  let q = rect(x0, x1, y0, y1);
  let ff = select(0u, F_FRONT0, front);
  let raised = sty(s, 9u).w;
  body(S_PLINTH, F_NOWIN, grow(q, 0.1), ground - 0.6, ground + 0.45 + raised);
  var top = q;
  let jetty = shape.z;
  if (jetty > 0.0 && eave - ground > STOREY * 1.6) {
    let j = ground + raised + STOREY;
    wallBody(S_WALL, ff | F_UNDER, q, ground + 0.45 + raised, j);
    top = grow(q, jetty);
    body(S_TRIM, F_NOWIN, grow(q, jetty + 0.06), j - 0.2, j + 0.05);
    wallBody(S_WALL, F_UNDER, top, j + 0.05, eave);
  } else {
    wallBody(S_WALL, ff | F_UNDER, q, ground + 0.45 + raised, eave);
  }
  body(S_TRIM, F_NOWIN, grow(top, 0.08), eave - 0.24, eave);
  let pitch = shape.x * mix(0.9, 1.25, rnd(seed, 1u));
  var inset = 0.0;
  if (rnd(seed, 2u) < sty(s, 5u).x) { inset = 0.45; }
  let rise = roof(top, eave + 0.1, turn, pitch, inset, shape.y, 0u);
  if (chim && rnd(seed, 3u) < shape.w) {
    // on the ridge, towards one end
    let f = mix(0.2, 0.8, rnd(seed, 4u));
    var p: vec2<f32>;
    if (turn == 0u) { p = lp(mix(x0, x1, f), (y0 + y1) * 0.5); } else { p = lp((x0 + x1) * 0.5, mix(y0, y1, f)); }
    chimney(p, eave + rise * 0.3, eave + rise + 1.0);
  }
  return rise;
}

/** dormers in a roof whose ridge runs along x (turn 0) over [x0, x1] × [y0, y1]: on the street side's slope */
fn dormers(x0: f32, x1: f32, y0: f32, y1: f32, eave: f32, rise: f32, seed: u32) {
  let len = x1 - x0;
  let n = min(u32(floor(len / 3.2)), 3u);
  if (n == 0u || rise < 1.4) { return; }
  let half = (y1 - y0) * 0.5;
  let slope = rise / max(half, 0.1);
  let w = 1.15;
  let h = 1.25;
  // the dormer's front a third of the way up the slope; its back far enough into the roof to be hidden
  let fy = y0 + half * 0.32;
  let fz = eave + 0.1 + (fy - y0) * slope;
  let d = (h + w * 0.55) / slope + 0.3;
  for (var k = 0u; k < n; k++) {
    let cx = x0 + len * (f32(k) + 0.5) / f32(n);
    let q = rect(cx - w * 0.5, cx + w * 0.5, fy, fy + d);
    wallBody(S_WALL, F_FRONT0 | F_UNDER, q, fz - 0.1, fz + h);
    roof(q, fz + h, 1u, 1.1, 0.0, 0.18, 0u);
  }
}

/** a round tower at c, radius r, from the ground to its top; a timber top storey out over it (jetty) and a cone */
fn roundTower(c: vec2<f32>, r: f32, top: f32, seed: u32) {
  let ground = gGround;
  let s = gS;
  let jetty = select(0.0, 0.3, rnd(seed, 21u) < 0.6);
  let q = array<vec2<f32>, 4>(c, vec2<f32>(r + 0.12, 0.0), vec2<f32>(0.0), vec2<f32>(0.0));
  put(K_CYL, S_PLINTH, F_NOWIN, q, ground - 0.6, vec4<f32>(ground + 0.6));
  let q2 = array<vec2<f32>, 4>(c, vec2<f32>(r, 0.0), vec2<f32>(0.0), vec2<f32>(0.0));
  let split = select(top, top - STOREY, jetty > 0.0);
  put(K_CYL, S_STONE, 0u, q2, ground + 0.6, vec4<f32>(split));
  var er = r;
  if (jetty > 0.0) {
    er = r + jetty;
    let q3 = array<vec2<f32>, 4>(c, vec2<f32>(er + 0.06, 0.0), vec2<f32>(0.0), vec2<f32>(0.0));
    put(K_CYL, S_TRIM, F_NOWIN, q3, split - 0.2, vec4<f32>(split + 0.05));
    let q4 = array<vec2<f32>, 4>(c, vec2<f32>(er, 0.0), vec2<f32>(0.0), vec2<f32>(0.0));
    put(K_CYL, S_WALL, 0u, q4, split + 0.05, vec4<f32>(top));
  }
  let q5 = array<vec2<f32>, 4>(c, vec2<f32>(er + 0.35, 0.0), vec2<f32>(0.0), vec2<f32>(0.0));
  put(K_CONE, S_ROOF, 0u, q5, top, vec4<f32>(top + (er + 0.35) * sty(s, 5u).y * mix(0.9, 1.2, rnd(seed, 22u))));
}

/** a square tower on [x0, x1] × [y0, y1]: stone, a timber top storey out over it, a flared hip spire */
fn squareTower(x0: f32, x1: f32, y0: f32, y1: f32, top: f32, seed: u32) {
  let ground = gGround;
  let q = rect(x0, x1, y0, y1);
  body(S_PLINTH, F_NOWIN, grow(q, 0.12), ground - 0.6, ground + 0.6);
  let split = top - STOREY;
  wallBody(S_STONE, F_UNDER, q, ground + 0.6, split);
  body(S_TRIM, F_NOWIN, grow(q, 0.36), split - 0.2, split + 0.05);
  let tq = grow(q, 0.3);
  wallBody(S_WALL, F_UNDER, tq, split + 0.05, top);
  roof(tq, top + 0.05, 0u, sty(gS, 5u).y * 0.9, 0.5, 0.35, 0u);
}

/** a porch on the front of [x0, x1] at the street side y0: a deck, two posts, a lean-to roof against the wall */
fn porch(cx: f32, y0: f32, depth: f32, width: f32) {
  let ground = gGround;
  let x0 = cx - width * 0.5;
  let x1 = cx + width * 0.5;
  let yf = y0 - depth;
  body(S_WOOD, F_NOWIN, rect(x0, x1, yf, y0), ground - 0.3, ground + 0.32);
  let pw = 0.11;
  body(S_WOOD, F_NOWIN, rect(x0 + 0.1, x0 + 0.1 + pw * 2.0, yf + 0.1, yf + 0.1 + pw * 2.0), ground + 0.32, ground + 2.6);
  body(S_WOOD, F_NOWIN, rect(x1 - 0.1 - pw * 2.0, x1 - 0.1, yf + 0.1, yf + 0.1 + pw * 2.0), ground + 0.32, ground + 2.6);
  // (the lean-to's high side against the wall: its quad turned so edge 3 → 2 is the wall's)
  let q = rect(x0 - 0.1, x1 + 0.1, yf - 0.05, y0);
  roof(q, ground + 2.55, 0u, 0.55, 0.0, 0.2, F_SHED);
}

/** a flight of steps along a block's street face (y ∈ [y0, y1], in front of it) from x0 towards dir (±1) up to z1,
 *  and a landing at its head */
fn frontStair(x0: f32, dir: f32, y0: f32, y1: f32, z1: f32) {
  let ground = gGround;
  let run = (z1 - ground) * 1.2;
  let xh = x0 + dir * run;
  // (the foot's edge x0, the head's xh: corners 0 → 1 the foot, 3 → 2 the head, counter-clockwise either way)
  var q = array<vec2<f32>, 4>(lp(x0, y1), lp(x0, y0), lp(xh, y0), lp(xh, y1));
  if (dir < 0.0) { q = array<vec2<f32>, 4>(lp(x0, y0), lp(x0, y1), lp(xh, y1), lp(xh, y0)); }
  put(K_STAIR, S_STONE, F_NOWIN, q, ground - 0.2, vec4<f32>(z1));
  let xl = min(xh, xh + dir * 1.3);
  body(S_STONE, F_NOWIN, rect(xl, xl + 1.3, y0, y1), ground - 0.2, z1);
}

/** a low wall along a – b (the lot's edge), inward by in, with a gap [g0, g1] (share of the edge; g0 ≥ g1: none) */
fn lotWall(a: vec2<f32>, b: vec2<f32>, g0: f32, g1: f32) {
  let ground = gGround;
  let d = b - a;
  let inw = -persp2(normalize(d)) * 0.38;
  let h = ground + 0.85;
  if (g0 < g1) {
    let p0 = mix(a, b, g0);
    let p1 = mix(a, b, g1);
    body(S_LOTWALL, F_NOWIN, array<vec2<f32>, 4>(a, p0, p0 + inw, a + inw), ground - 0.3, h);
    body(S_LOTWALL, F_NOWIN, array<vec2<f32>, 4>(p1, b, b + inw, p1 + inw), ground - 0.3, h);
    // gate posts
    let pq0 = array<vec2<f32>, 4>(p0 - normalize(d) * 0.4, p0, p0 + inw, p0 + inw - normalize(d) * 0.4);
    let pq1 = array<vec2<f32>, 4>(p1, p1 + normalize(d) * 0.4, p1 + normalize(d) * 0.4 + inw, p1 + inw);
    body(S_LOTWALL, F_NOWIN, pq0, ground - 0.3, h + 0.45);
    body(S_LOTWALL, F_NOWIN, pq1, ground - 0.3, h + 0.45);
  } else {
    body(S_LOTWALL, F_NOWIN, array<vec2<f32>, 4>(a, b, b + inw, a + inw), ground - 0.3, h);
  }
}

/** the windows and doors of the walls made, as geometry (the painted ones under them are switched off: F_NOWIN) */
fn windows() {
  let s = gS;
  let win = sty(s, 7u);
  let shut = sty(s, 6u).z > 0.5;
  for (var k = 0u; k < gNW; k++) {
    let o = (gLot * PPL + gWalls[k]) * PW;
    let w0 = ARCH[PB + o];
    let front = ((w0 >> 16u) & F_FRONT0) != 0u;
    let z0 = bitcast<f32>(ARCH[PB + o + 10u]);
    let z1 = bitcast<f32>(ARCH[PB + o + 11u]);
    var c: array<vec2<f32>, 4>;
    for (var j = 0u; j < 4u; j++) {
      c[j] = vec2<f32>(bitcast<f32>(ARCH[PB + o + 2u + j * 2u]), bitcast<f32>(ARCH[PB + o + 3u + j * 2u]));
    }
    let wallH = z1 - z0;
    for (var f = 0u; f < 4u; f++) {
      let a = c[f];
      let b = c[(f + 1u) % 4u];
      let L = length(b - a);
      if (L < 1.2) { continue; }
      let d = (b - a) / L;
      let nb = baysOf(L, win.x);
      let bw = L / f32(nb);
      let door = doorBayOf(gLot, nb);
      // a dormer's front (a low wall): one window filling it
      if (wallH < 2.0) {
        if (f == 0u) {
          let ww = min(L - 0.35, 0.75) * 0.5;
          put(K_WIN, S_GLASS, 0u, array<vec2<f32>, 4>(a + d * (L * 0.5 - ww), a + d * (L * 0.5 + ww), vec2<f32>(0.0), vec2<f32>(0.0)), z0 + 0.25, vec4<f32>(wallH - 0.55, 0.08, 0.0, 0.0));
        }
        continue;
      }
      for (var st = 0u; st < 4u; st++) {
        if (!winFits(st, win.z, wallH) && !(front && f == 0u && st == 0u)) { break; }
        for (var bi = 0u; bi < nb; bi++) {
          let mid = (f32(bi) + 0.5) * bw;
          if (front && f == 0u && st == 0u && bi == door) {
            let dw = 0.55;
            let p0 = a + d * (mid - dw);
            let p1 = a + d * (mid + dw);
            put(K_WIN, S_DOOR, F_DOOR | F_CANOPY, array<vec2<f32>, 4>(p0, p1, vec2<f32>(0.0), vec2<f32>(0.0)), z0, vec4<f32>(2.1, 0.12, 0.0, 0.0));
            continue;
          }
          if (!winFits(st, win.z, wallH)) { continue; }
          let ww = win.y * 0.5;
          let p0 = a + d * (mid - ww);
          let p1 = a + d * (mid + ww);
          var fl = 0u;
          if (shut) { fl |= F_SHUT; }
          if (rnd(hash(gLot * 131u + f * 17u + st * 5u + bi), 1u) < sty(s, 9u).z) { fl |= F_BOX; }
          put(K_WIN, S_GLASS, fl, array<vec2<f32>, 4>(p0, p1, vec2<f32>(0.0), vec2<f32>(0.0)), z0 + f32(st) * STOREY + win.w, vec4<f32>(win.z - win.w, 0.1, 0.0, 0.0));
        }
      }
    }
  }
}

/** a house: the composed massing on the lot's frame [0, gW] × [0, gD] */
fn house(eave: f32, seed: u32) {
  let s = gS;
  let ground = gGround;
  let st8 = sty(s, 8u);
  let st9 = sty(s, 9u);
  let W = gW;
  let D = gD;
  // the front garden (the setback), the main block's width and depth, its side
  let sb = min(st8.y * mix(0.6, 1.4, rnd(seed, 30u)), D * 0.25);
  var mw = min(W, mix(5.5, 8.5, rnd(seed, 31u)));
  if (W - mw < 3.2) { mw = W; }
  let md = min(D - sb, mix(5.5, 9.0, rnd(seed, 32u)));
  let left = rnd(seed, 33u) < 0.5;
  let mx0 = select(W - mw, 0.0, left);
  let mx1 = mx0 + mw;
  // gable to the street (ridge along y) for a narrow block or a style that turns its gables out
  let gableFront = mw < md * 0.95 || sty(s, 5u).w > 0.5 || rnd(seed, 54u) < 0.4;
  let turn = select(0u, 1u, gableFront);
  let rise = block(mx0, mx1, sb, sb + md, eave, turn, seed, true, true);
  if (turn == 0u) {
    // eaves to the street: a cross gable stepping forward out of the facade, or dormers
    if (mw > 6.0 && sb > 1.0 && rnd(seed, 55u) < 0.55) {
      let cw = mix(2.8, 4.0, rnd(seed, 56u));
      let cx = mx0 + mw * mix(0.3, 0.7, rnd(seed, 57u));
      let fwd = min(sb - 0.4, mix(0.8, 1.8, rnd(seed, 58u)));
      block(cx - cw * 0.5, cx + cw * 0.5, sb - fwd, sb + md * 0.5, eave - 0.1, 1u, hash(seed + 91u), true, false);
    } else if (rnd(seed, 34u) < st9.z + 0.3) { dormers(mx0, mx1, sb, sb + md, eave, rise, seed); }
  }
  // the wing: the rest of the frontage, a storey lower, set back, its ridge across the main's — an L
  let ww = W - mw - 0.2;
  var wingX0 = 0.0;
  var wingX1 = 0.0;
  if (ww >= 3.2) {
    wingX0 = select(0.0, mx1 + 0.2, left);
    wingX1 = wingX0 + ww;
    let wy0 = sb + mix(0.4, 1.6, rnd(seed, 35u));
    let wd = min(md * mix(0.6, 0.85, rnd(seed, 36u)), D - wy0);
    let we = max(ground + STOREY + 0.45, eave - STOREY);
    // (turned on purpose, sometimes: about its corner on the main block, away from the street)
    if (rnd(seed, 52u) < st9.y) {
      gPiv = vec2<f32>(select(wingX1, wingX0, left), wy0 + wd);
      gRot = select(1.0, -1.0, left) * mix(0.12, 0.35, rnd(seed, 53u));
    }
    let wr = block(wingX0, wingX1, wy0, wy0 + wd, we, 0u, hash(seed + 77u), true, rnd(seed, 37u) < 0.5);
    if (rnd(seed, 38u) < st9.z + 0.2) { dormers(wingX0, wingX1, wy0, wy0 + wd, we, wr, hash(seed + 78u)); }
    gRot = 0.0;
  }
  // a lean-to behind the main block
  let back = D - (sb + md);
  if (back > 3.0 && rnd(seed, 39u) < 0.6) {
    let lw = mw * mix(0.5, 0.8, rnd(seed, 40u));
    let lx0 = mx0 + (mw - lw) * rnd(seed, 41u);
    let ld = min(back - 1.2, 3.2);
    let q = rect(lx0, lx0 + lw, sb + md, sb + md + ld);
    body(S_PLINTH, F_NOWIN, grow(q, 0.08), ground - 0.6, ground + 0.35);
    wallBody(S_WALL, F_UNDER, q, ground + 0.35, ground + 2.6);
    // (its high side against the main block: the quad turned by 2, so edge 3 → 2 is the main's back wall)
    roof(q, ground + 2.7, 2u, 0.5, 0.0, 0.25, F_SHED);
  }
  // a tower at the main block's front corner by the wing (or the free one)
  if (rnd(seed, 42u) < sty(s, 6u).y && min(mw, md) > 4.5) {
    let top = eave + STOREY * mix(1.2, 2.0, rnd(seed, 43u));
    let cx = select(mx0, mx1, left);
    if (rnd(seed, 44u) < st8.x) {
      let r = mix(1.5, 2.2, rnd(seed, 45u));
      roundTower(lp(cx + select(r * 0.35, -r * 0.35, left), sb + r * 0.45), r, top, seed);
    } else {
      let tw = mix(2.6, 3.4, rnd(seed, 46u));
      let tx = select(cx - tw * 0.6, cx - tw * 0.4, left);
      squareTower(tx, tx + tw, sb - 0.3, sb - 0.3 + tw, top, seed);
    }
  }
  // the door's porch, in the front garden
  let win = sty(s, 7u);
  let nb = baysOf(mw, win.x);
  let door = doorBayOf(gLot, nb);
  let dx = mx0 + (f32(door) + 0.5) * mw / f32(nb);
  let stairUp = eave - ground > STOREY * 1.6 && sb > 1.4 && mw > 6.0 && rnd(seed, 48u) < st9.x;
  if (stairUp) {
    // a stair along the front up to the first floor, its foot at the end away from the door
    let fromLeft = dx > mx0 + mw * 0.5;
    frontStair(select(mx1 - 0.2, mx0 + 0.2, fromLeft), select(-1.0, 1.0, fromLeft), sb - 1.15, sb - 0.02, ground + STOREY + 0.45);
  } else if (sb > 1.3 && rnd(seed, 47u) < st8.w) {
    porch(dx, sb, min(sb - 0.25, 1.8), 2.6);
  }
  // the lot's low wall: round the yard, a gate on the street in front of the door
  if (rnd(seed, 49u) < st8.z) {
    let g = clamp(dx / W, 0.12, 0.88);
    lotWall(lp(0.0, 0.0), lp(W, 0.0), g - 0.1, g + 0.1);
    lotWall(lp(W, 0.0), lp(W, D), 1.0, 0.0);
    lotWall(lp(W, D), lp(0.0, D), 1.0, 0.0);
    lotWall(lp(0.0, D), lp(0.0, 0.0), 1.0, 0.0);
  }
}

/** a keep: the inscribed rectangle walled in stone, crenellated, round or square towers at the front corners */
fn keep(eave: f32, seed: u32) {
  let ground = gGround;
  let W = gW;
  let D = gD;
  let q = rect(0.6, W - 0.6, 0.6, D - 0.6);
  body(S_PLINTH, F_NOWIN, grow(q, 0.15), ground - 0.6, ground + 0.7);
  wallBody(S_WALL, F_FRONT0 | F_UNDER, q, ground + 0.7, eave);
  body(S_TRIM, F_NOWIN, grow(q, 0.12), eave - 0.3, eave);
  // (its flat roof: a flagstone slab — the wall's own top is dark, as under a pitched roof)
  body(S_STONE, 0u, q, eave - 0.05, eave + 0.03);
  put(K_CREN, S_STONE, 0u, grow(q, 0.1), eave, vec4<f32>(0.7, 0.75, 0.7, 0.45));
  let top = eave + STOREY * mix(1.0, 1.8, rnd(seed, 50u));
  let r = clamp(min(W, D) * 0.16, 1.5, 2.8);
  for (var k = 0u; k < 2u; k++) {
    let c = lp(select(0.6, W - 0.6, k == 1u), 0.6);
    if (rnd(seed, 51u) < sty(gS, 8u).x) {
      roundTower(c, r, top, hash(seed + k));
    } else {
      let x = select(0.6 - r, W - 0.6 - r, k == 1u);
      squareTower(x, x + 2.0 * r, -0.4, 2.0 * r - 0.4, top, hash(seed + k));
    }
  }
}

@compute @workgroup_size(64)
fn gen(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= GU.count) { return; }
  let i = GU.first + g.x;
  gLot = i;
  PB = ARCH[2];
  gN = 0u;
  gNW = 0u;
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
  gS = s;
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
  for (var k = 0u; k < 4u; k++) { gQ[k] = q[(k + r) % 4u]; }
  let ground = zb + 0.5;
  gGround = ground;
  ARCH[ARCH[6] + i] = bitcast<u32>(ground);
  let eave = zb + height;
  // the lot's frame: square to the street (the stone styles: the rectangle inscribed in the lot) or its own quad
  LX = normalize(gQ[1] - gQ[0]);
  LY = vec2<f32>(-LX.y, LX.x);
  var p: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { p[k] = vec2<f32>(dot(gQ[k] - gQ[0], LX), dot(gQ[k] - gQ[0], LY)); }
  let xl = max(p[0].x, p[3].x);
  let xr = min(p[1].x, p[2].x);
  let yb = max(p[0].y, p[1].y);
  let yt = min(p[2].y, p[3].y);
  gRot = 0.0;
  LO = gQ[0] + LX * xl + LY * yb;
  gW = xr - xl;
  gD = yt - yb;
  // (a sliver of a lot: a small square house on what there is)
  if (gW < 3.0 || gD < 3.0) {
    LO = gQ[0];
    gW = max(length(gQ[1] - gQ[0]) * 0.8, 3.0);
    gD = max(length(gQ[3] - gQ[0]) * 0.8, 3.0);
  }
  if (sty(s, 5u).z > 0.5) { keep(eave, seed); } else { house(eave, seed); }
  windows();
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
