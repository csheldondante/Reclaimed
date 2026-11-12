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
/** a water wheel: corner 0 its centre, 1 its plane's direction, 2 its axle's; z0 the axle's height, 11 its radius, 12
 *  its width (turning with the clock) */
const K_WHEEL: u32 = 8u;
/** a shrub: corner 0 its centre, z0 its foot, 11 its radius, 12 its height (F_BLOOM: flowering) */
const K_BUSH: u32 = 9u;
/** (Synty, local only) a plant mesh: small (<= 1008 vertices) and medium (<= 1896) — plants.json */
const K_PLANT_S: u32 = 10u;
const K_PLANT_M: u32 = 11u;
const NK: u32 = 12u;
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
const S_CLOTH: u32 = 14u;
const S_CRATE: u32 = 15u;
const S_GOODS: u32 = 16u;
const S_WATER: u32 = 17u;
const S_PLANK: u32 = 18u;
const S_LEAF: u32 = 19u;
const S_BRICK: u32 = 20u;
/** a wall in a colour of its own (the grid family's columns: Townscaper's palette, a part's hash) */
const S_TINT: u32 = 21u;
const S_PLANT: u32 = 22u;
/** part flags (word 0, bits 16–23) */
const F_FRONT0: u32 = 1u; // the body's side 0 faces the street (its door)
const F_NOWIN: u32 = 2u;  // no painted windows (plinth, chimney, trim; and bodies whose windows are geometry)
const F_DOOR: u32 = 4u;   // K_WIN: a door
const F_SHUT: u32 = 8u;   // K_WIN: shutters
const F_BOX: u32 = 16u;   // K_WIN: a flower box
const F_SHED: u32 = 32u;  // K_ROOF: a lean-to (one slope, its high side on edge 3 → 2 after the turn)
const F_CANOPY: u32 = 64u; // K_WIN (a door): a canopy over it
const F_BLOOM: u32 = 4u; // K_BUSH: flowering
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

/** a low wall along a – b (the lot's edge), with a gap [g0, g1] (share of the edge; g0 ≥ g1: none) */
fn lotWall(a: vec2<f32>, b: vec2<f32>, g0: f32, g1: f32) { wallRun(a, b, g0, g1, 0.85, 0.38); }

/** the windows and doors of the walls made, as geometry (the painted ones under them are switched off: F_NOWIN) */
fn windows() {
  let s = gS;
  let win = sty(s, 7u);
  let shut = sty(s, 6u).z > 0.5;
  // the lot's windows: a shape for its ground floor and one for above (often square-headed), its sills and heads, a
  // balcony on its front now and then, small square lights in a top storey
  let ls = hash(gLot * 977u + 5u);
  let rs = rnd(ls, 1u);
  var shape0 = 0u;
  if (rs < 0.22) { shape0 = 1u; } else if (rs < 0.42) { shape0 = 2u; } else if (rs < 0.5) { shape0 = 3u; }
  let shapeUp = select(0u, shape0, rnd(ls, 2u) < 0.45);
  let dress = (hash(ls + 1u) % 3u) | ((hash(ls + 2u) % 4u) << 2u);
  let balcony = rnd(ls, 3u) < 0.3;
  let balAll = rnd(ls, 4u) < 0.35;
  let attic = rnd(ls, 5u) < 0.4;
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
            let dw = sty(s, 6u).x * 0.5;
            let p0 = a + d * (mid - dw);
            let p1 = a + d * (mid + dw);
            put(K_WIN, S_DOOR, F_DOOR | select(0u, F_CANOPY, dw < 1.0), array<vec2<f32>, 4>(p0, p1, vec2<f32>(0.0), vec2<f32>(0.0)), z0, vec4<f32>(sty(s, 6u).w, 0.12, 0.0, 0.0));
            continue;
          }
          if (!winFits(st, win.z, wallH)) { continue; }
          var ww = win.y * 0.5;
          var zs = z0 + f32(st) * STOREY + win.w;
          var H = win.z - win.w;
          var shape = select(shapeUp, shape0, st == 0u);
          var dr = dress;
          // (the top storey that fits, above the first: small square lights under the eaves, sometimes)
          let top = !winFits(st + 1u, win.z, wallH) && st >= 2u;
          if (top && attic) { H = min(H, ww * 2.2); zs = z0 + f32(st) * STOREY + win.z - H; shape = 0u; }
          // a balcony: a door-height window onto a slab with a rail, on the front above the ground floor
          else if (balcony && front && f == 0u && st >= 1u && (balAll || bi == nb / 2u)) {
            dr |= 16u;
            zs = z0 + f32(st) * STOREY + 0.1;
            H = win.z - 0.1;
            ww = max(ww, 0.5);
          }
          if (shape == 1u) { H = max(H, ww * 2.0 + 0.3); }
          let p0 = a + d * (mid - ww);
          let p1 = a + d * (mid + ww);
          var fl = 0u;
          if (shut && (dr & 16u) == 0u && shape != 1u && shape != 3u) { fl |= F_SHUT; }
          if ((dr & 16u) == 0u && rnd(hash(gLot * 131u + f * 17u + st * 5u + bi), 1u) < sty(s, 9u).z) { fl |= F_BOX; }
          put(K_WIN, S_GLASS, fl, array<vec2<f32>, 4>(p0, p1, vec2<f32>(0.0), vec2<f32>(0.0)), zs, vec4<f32>(H, 0.1, f32(shape), f32(dr)));
        }
      }
    }
  }
}

/** a house: the composed massing on the lot's frame [0, gW] × [0, gD] */
/** a stretch of wall a – b (inward along iw), up to z1; a tall one capped with a stone coping */
fn wallSeg(a: vec2<f32>, b: vec2<f32>, iw: vec2<f32>, z1: f32, tall: bool) {
  let q = array<vec2<f32>, 4>(a, b, b + iw, a + iw);
  body(S_LOTWALL, F_NOWIN, q, gGround - 0.3, z1);
  if (tall) { body(S_STONE, F_NOWIN, grow(q, 0.07), z1, z1 + 0.16); }
}

/** a wall along a – b (the lot's edge, counter-clockwise: the lot on its left), th thick, h high, with a gate [g0, g1]
 *  (shares of the edge; g0 ≥ g1: none). A tall one (a court's) is coped, its gate under a lintel and a little roof. */
fn wallRun(a: vec2<f32>, b: vec2<f32>, g0: f32, g1: f32, h: f32, th: f32) {
  let ground = gGround;
  let dn = normalize(b - a);
  let iw = -persp2(dn) * th;
  let z1 = ground + h;
  let tall = h > 1.5;
  if (g0 >= g1) {
    wallSeg(a, b, iw, z1, tall);
    return;
  }
  let p0 = mix(a, b, g0);
  let p1 = mix(a, b, g1);
  wallSeg(a, p0, iw, z1, tall);
  wallSeg(p1, b, iw, z1, tall);
  let pw = select(0.4, 0.55, tall);
  let ptop = z1 + select(0.45, 0.5, tall);
  body(S_LOTWALL, F_NOWIN, array<vec2<f32>, 4>(p0 - dn * pw, p0, p0 + iw, p0 + iw - dn * pw), ground - 0.3, ptop);
  body(S_LOTWALL, F_NOWIN, array<vec2<f32>, 4>(p1, p1 + dn * pw, p1 + dn * pw + iw, p1 + iw), ground - 0.3, ptop);
  if (tall) {
    // the lintel over the gateway, a little gabled roof along the wall over it
    body(S_STONE, F_NOWIN, array<vec2<f32>, 4>(p0 - dn * 0.2, p1 + dn * 0.2, p1 + dn * 0.2 + iw, p0 - dn * 0.2 + iw), z1 - 0.35, ptop);
    let n = normalize(iw);
    let ext = pw + 0.25;
    let rq = array<vec2<f32>, 4>(p0 - dn * ext - n * 0.4, p1 + dn * ext - n * 0.4, p1 + dn * ext + iw + n * 0.4, p0 - dn * ext + iw + n * 0.4);
    roof(rq, ptop, 0u, 0.9, 0.0, 0.08, 0u);
  }
}

/** (the user: "You can use Synty trees as long as we don't commit to a public repo and they look much better") a plant
 *  mesh of category `cat` (0 tree, 1 bush, 2 flowers: plants.json) at p on z, about h tall, turned its own way — when
 *  the local conversion is present (the header's word 7: how many); false without, and the caller draws its own */
fn plant(cat: u32, p: vec2<f32>, z: f32, h: f32, seed: u32) -> bool {
  if (ARCH[7] == 0u) { return false; }
  var cats = PLANT_CAT;
  var hs = PLANT_H;
  var cls = PLANT_CLS;
  var n = 0u;
  for (var i = 0u; i < PLANT_N; i++) { if (cats[i] == cat) { n++; } }
  if (n == 0u) { return false; }
  var pick = hash(seed + 31u) % n;
  var mi = 0u;
  for (var i = 0u; i < PLANT_N; i++) {
    if (cats[i] != cat) { continue; }
    if (pick == 0u) { mi = i; break; }
    pick--;
  }
  let s = clamp(h / hs[mi], 0.55, 1.8);
  let a = rnd(seed, 77u) * 6.28318;
  let k = select(K_PLANT_S, K_PLANT_M, cls[mi] == 1u);
  put(k, S_PLANT, F_NOWIN, array<vec2<f32>, 4>(p, vec2<f32>(cos(a), sin(a)) * s, vec2<f32>(f32(mi), 0.0), vec2<f32>(0.0)), z, vec4<f32>(0.0));
  return true;
}

/** a tree at p, h tall: a Synty tree, or a trunk and a crown */
fn tree(p: vec2<f32>, h: f32, seed: u32) {
  let g = gGround;
  if (plant(0u, p, g - 0.05, h, seed)) { return; }
  cyl(p, 0.17, g - 0.1, g + h * 0.5, S_WOOD, F_NOWIN);
  bushBlob(p, g + h * 0.38, mix(1.0, 1.4, rnd(seed, 1u)), h * 0.66, rnd(seed, 2u) < 0.25);
}

/** a well: a stone ring with water in it, two posts and a little roof */
fn well(p: vec2<f32>) {
  let g = gGround;
  cyl(p, 0.75, g - 0.2, g + 0.75, S_STONE, F_NOWIN);
  cyl(p, 0.55, g + 0.5, g + 0.62, S_WATER, F_NOWIN);
  let a = LX * 0.08;
  let b = LY * 0.08;
  let l = p - LX * 0.65;
  let r = p + LX * 0.65;
  body(S_WOOD, F_NOWIN, array<vec2<f32>, 4>(l - a - b, l + a - b, l + a + b, l - a + b), g + 0.7, g + 2.0);
  body(S_WOOD, F_NOWIN, array<vec2<f32>, 4>(r - a - b, r + a - b, r + a + b, r - a + b), g + 0.7, g + 2.0);
  let rq = array<vec2<f32>, 4>(p - LX * 1.0 - LY * 0.7, p + LX * 1.0 - LY * 0.7, p + LX * 1.0 + LY * 0.7, p - LX * 1.0 + LY * 0.7);
  roof(rq, g + 2.0, 0u, 0.9, 0.0, 0.05, 0u);
}

/** a court's garden in [x0, x1] × [y0, y1]: paved or lawn, a fountain, a well or a tree in the middle, trees or
 *  shrubs in its corners */
fn courtGarden(x0: f32, x1: f32, y0: f32, y1: f32, seed: u32) {
  if (x1 - x0 < 2.0 || y1 - y0 < 2.0) { return; }
  let g = gGround;
  if (rnd(seed, 1u) < 0.55) { body(S_STONE, 0u, rect(x0, x1, y0, y1), g - 0.2, g + 0.04); }
  let c = lp((x0 + x1) * 0.5, (y0 + y1) * 0.5);
  let m = rnd(seed, 2u);
  let small = min(x1 - x0, y1 - y0) < 4.5;
  if (m < 0.4 && !small) { fountain(c, min(1.4, min(x1 - x0, y1 - y0) * 0.22)); }
  else if (m < 0.7) { well(c); }
  else { tree(c, mix(4.0, 5.5, rnd(seed, 3u)), hash(seed + 3u)); }
  if (small) { return; }
  for (var k = 0u; k < 4u; k++) {
    let s = hash(seed + 10u + k);
    if (rnd(s, 1u) < 0.35) { continue; }
    let px = select(x0 + 0.9, x1 - 0.9, (k & 1u) == 1u);
    let py = select(y0 + 0.9, y1 - 0.9, k >= 2u);
    if (rnd(s, 2u) < 0.5) { tree(lp(px, py), mix(3.2, 4.8, rnd(s, 3u)), s); }
    else { bush(lp(px, py), mix(0.6, 0.9, rnd(s, 4u)), mix(0.8, 1.3, rnd(s, 5u)), rnd(s, 6u) < 0.6); }
  }
}

/** a manor round a walled forecourt (the user: "more variety in the manors. Walled in courtyards would be great"):
 *  its main range across the back of the lot, its door on the court; no wing, one or two down the sides; a tall coped
 *  wall on the street with a roofed gateway on the court's axis, walls down the sides the wings don't close; the court
 *  a garden */
fn manorCourt(eave: f32, seed: u32) {
  let ground = gGround;
  let W = gW;
  let D = gD;
  let e = 0.4;
  let md = clamp(D * 0.38, 5.5, 8.5);
  let my0 = D - e - md;
  let rise = block(e, W - e, my0, D - e, eave, 0u, seed, true, true);
  if (rnd(seed, 1u) < 0.5) { dormers(e, W - e, my0, D - e, eave, rise, seed); }
  // the wings: none, one (its side by hash), or both
  let nw = hash(seed + 5u) % 3u;
  let leftW = nw == 2u || (nw == 1u && rnd(seed, 2u) < 0.5);
  let rightW = nw == 2u || (nw == 1u && !leftW);
  let ww = clamp(W * 0.25, 3.4, 4.6);
  let we = max(ground + STOREY + 0.45, eave - STOREY * select(0.0, 1.0, rnd(seed, 3u) < 0.6));
  let wy0 = e + mix(0.0, 2.2, rnd(seed, 4u));
  if (leftW) { block(e, e + ww, wy0, my0 + 0.3, we, 1u, hash(seed + 11u), false, rnd(seed, 6u) < 0.5); }
  if (rightW) { block(W - e - ww, W - e, wy0, my0 + 0.3, we, 1u, hash(seed + 12u), false, rnd(seed, 7u) < 0.5); }
  let cx0 = select(e, e + ww, leftW);
  let cx1 = select(W - e, W - e - ww, rightW);
  // the walls: the street's with its gateway, the sides up to a wing or the main range
  let h = mix(2.3, 3.0, rnd(seed, 8u));
  let th = 0.5;
  let gm = ((cx0 + cx1) * 0.5 - e) / (W - 2.0 * e);
  let gh = 1.3 / (W - 2.0 * e);
  wallRun(lp(e, e), lp(W - e, e), gm - gh, gm + gh, h, th);
  wallRun(lp(W - e, e), lp(W - e, select(my0, wy0, rightW)), 1.0, 0.0, h, th);
  wallRun(lp(e, select(my0, wy0, leftW)), lp(e, e), 1.0, 0.0, h, th);
  courtGarden(cx0 + 0.5, cx1 - 0.5, e + th + 0.4, my0 - 0.4, hash(seed + 20u));
  // a round tower at a back corner of the court, sometimes
  if (rnd(seed, 9u) < sty(gS, 6u).y * 0.6) { roundTower(lp(select(cx0, cx1, rnd(seed, 10u) < 0.5), my0), 1.7, eave + STOREY * 1.3, seed); }
}

fn house(eave: f32, seed: u32) {
  let s = gS;
  let ground = gGround;
  let st8 = sty(s, 8u);
  let st9 = sty(s, 9u);
  let W = gW;
  let D = gD;
  // the front garden (the setback), the main block's width and depth, its side
  // a big lot: a courtyard block
  if (W >= 13.0 && D >= 13.0 && rnd(seed, 60u) < 0.45) {
    courtyard(eave, seed);
    return;
  }
  // a manor round a walled forecourt
  if (W >= 10.0 && D >= 12.0 && rnd(seed, 62u) < 0.45) {
    manorCourt(eave, seed);
    return;
  }
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
  plantings(seed, sb, dx);
  // the lot's wall: low round the yard, a gate on the street in front of the door; or the back garden walled in tall
  // (coped, a garden's) behind a low street wall, trees in it
  let backY = sb + md;
  let walledBack = D - backY > 3.5 && rnd(seed, 61u) < 0.35;
  if (walledBack || rnd(seed, 49u) < st8.z) {
    let g = clamp(dx / W, 0.12, 0.88);
    let bh = mix(2.2, 2.7, rnd(seed, 63u));
    lotWall(lp(0.0, 0.0), lp(W, 0.0), g - 0.1, g + 0.1);
    if (walledBack) {
      lotWall(lp(W, 0.0), lp(W, backY), 1.0, 0.0);
      wallRun(lp(W, backY), lp(W, D), 1.0, 0.0, bh, 0.45);
      wallRun(lp(W, D), lp(0.0, D), 1.0, 0.0, bh, 0.45);
      wallRun(lp(0.0, D), lp(0.0, backY), 1.0, 0.0, bh, 0.45);
      lotWall(lp(0.0, backY), lp(0.0, 0.0), 1.0, 0.0);
    } else {
      lotWall(lp(W, 0.0), lp(W, D), 1.0, 0.0);
      lotWall(lp(W, D), lp(0.0, D), 1.0, 0.0);
      lotWall(lp(0.0, D), lp(0.0, 0.0), 1.0, 0.0);
    }
  }
  // trees in the back garden
  if (D - backY > 3.5 && (walledBack || rnd(seed, 64u) < 0.5)) {
    let nt = 1u + hash(seed + 65u) % 3u;
    for (var k = 0u; k < nt; k++) {
      let s2 = hash(seed + 66u + k);
      tree(lp(mix(1.2, W - 1.2, rnd(s2, 1u)), mix(backY + 1.4, D - 1.2, rnd(s2, 2u))), mix(3.5, 5.5, rnd(s2, 3u)), s2);
    }
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
  // a roof garden behind the parapet
  for (var k = 0u; k < 3u; k++) {
    let s2 = hash(seed + 200u + k);
    bushAt(lp(mix(2.0, W - 2.0, rnd(s2, 1u)), mix(2.0, D - 2.0, rnd(s2, 2u))), eave, mix(0.6, 1.1, rnd(s2, 3u)), mix(0.8, 1.5, rnd(s2, 4u)), rnd(s2, 5u) < 0.5);
  }
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

// ---- round 3: more archetypes (the user: "Docks and shanties for ports. Industrial warehouses, smokestacks maybe a
// water wheel? Then I think tents would be cool, open air market stalls, courtyards, plants on the structures") ----

/** a shrub (K_BUSH) at p: radius, height; flowering or not */
fn bushAt(p: vec2<f32>, z: f32, r: f32, h: f32, flowers: bool) {
  // (a Synty bush, or flowers when it's a small flowering one)
  let ps = hash((u32(round(p.x * 8.0) + 100000.0) * 73856093u) ^ (u32(round(p.y * 8.0) + 100000.0) * 19349663u));
  if (plant(select(1u, 2u, flowers && h < 1.0), p, z, h * 1.25, ps)) { return; }
  bushBlob(p, z, r, h, flowers);
}
/** the generator's own shrub: a lumpy ball of leaves */
fn bushBlob(p: vec2<f32>, z: f32, r: f32, h: f32, flowers: bool) {
  let q = array<vec2<f32>, 4>(p, vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0));
  put(K_BUSH, S_LEAF, select(0u, F_BLOOM, flowers), q, z, vec4<f32>(r, h, 0.0, 0.0));
}
fn bush(p: vec2<f32>, r: f32, h: f32, flowers: bool) { bushAt(p, gGround - 0.1, r, h, flowers); }

/** a round body standing on the ground at p: radius, from z0 to z1 */
fn cyl(p: vec2<f32>, r: f32, z0: f32, z1: f32, surf: u32, flags: u32) {
  put(K_CYL, surf, flags, array<vec2<f32>, 4>(p, vec2<f32>(r, 0.0), vec2<f32>(0.0), vec2<f32>(0.0)), z0, vec4<f32>(z1));
}

/** a fountain at p: a stone basin of water, a column, a bowl */
fn fountain(p: vec2<f32>, r: f32) {
  let g = gGround;
  cyl(p, r, g - 0.2, g + 0.5, S_STONE, F_NOWIN);
  cyl(p, r - 0.18, g + 0.3, g + 0.42, S_WATER, F_NOWIN);
  cyl(p, 0.22, g + 0.4, g + 1.5, S_STONE, F_NOWIN);
  cyl(p, 0.55, g + 1.5, g + 1.65, S_STONE, F_NOWIN);
}

/** a crate (a stack of n) at p, side w, turned */
fn crates(p: vec2<f32>, w: f32, n: u32, turnA: f32) {
  let cs = cos(turnA);
  let sn = sin(turnA);
  let ex = (LX * cs + LY * sn) * w * 0.5;
  let ey = (LY * cs - LX * sn) * w * 0.5;
  let q = array<vec2<f32>, 4>(p - ex - ey, p + ex - ey, p + ex + ey, p - ex + ey);
  for (var k = 0u; k < n; k++) { body(S_CRATE, F_NOWIN, q, gGround + f32(k) * w, gGround + f32(k + 1u) * w - 0.02); }
}

/** a hut of planks: walls, a lean-to roof of planks or a cloth tarp (patchwork: the part's own), sometimes a second storey
 *  stacked crooked on it, an awning of cloth on two posts at its door. In the lot's frame, turned by `rot`. */
fn hut(x0: f32, x1: f32, y0: f32, y1: f32, rot: f32, seed: u32) {
  let g = gGround;
  gPiv = vec2<f32>((x0 + x1) * 0.5, (y0 + y1) * 0.5);
  gRot = rot;
  let q = rect(x0, x1, y0, y1);
  let h = mix(2.3, 2.9, rnd(seed, 1u));
  body(S_PLINTH, F_NOWIN, grow(q, 0.05), g - 0.4, g + 0.2);
  wallBody(S_WALL, F_FRONT0 | F_UNDER, q, g + 0.2, g + h);
  let turn = hash(seed) % 4u;
  roof(q, g + h + 0.05, turn, mix(0.25, 0.5, rnd(seed, 2u)), 0.0, 0.3, F_SHED);
  if (rnd(seed, 3u) < 0.35 && x1 - x0 > 3.2) {
    // a room stacked on top, set back and turned a little more
    let s2 = hash(seed + 5u);
    gRot = rot + (rnd(s2, 1u) - 0.5) * 0.3;
    let q2 = rect(x0 + 0.4, x1 - 0.6, y0 + 0.5, y1 - 0.3);
    let h2 = h + mix(2.0, 2.4, rnd(s2, 2u));
    wallBody(S_WALL, F_UNDER, q2, g + h, g + h2);
    roof(q2, g + h2 + 0.05, (turn + 2u) % 4u, 0.35, 0.0, 0.3, F_SHED);
  }
  if (rnd(seed, 4u) < 0.6) {
    // an awning out over the door: cloth on two posts
    let ax0 = mix(x0, x1, 0.2);
    let ax1 = mix(x0, x1, 0.8);
    gRot = rot;
    put(K_ROOF, S_CLOTH, F_SHED, rect(ax0, ax1, y0 - 1.5, y0), g + 1.95, vec4<f32>(g + 2.35, 0.0, 0.0, 0.05));
    body(S_WOOD, F_NOWIN, rect(ax0, ax0 + 0.14, y0 - 1.45, y0 - 1.31), g, g + 2.0);
    body(S_WOOD, F_NOWIN, rect(ax1 - 0.14, ax1, y0 - 1.45, y0 - 1.31), g, g + 2.0);
  }
  // a cloth lean-to against its side wall, where there's room (the user: "tents at angles or against walls")
  gRot = rot;
  if (rnd(seed, 6u) < 0.5 && x1 + 1.9 < gW) { leanTent(x1, x1 + mix(1.4, 1.9, rnd(seed, 7u)), y0 + 0.3, y1 - 0.3, 1u, seed); }
  else if (rnd(seed, 6u) > 0.75 && x0 - 1.9 > 0.0) { leanTent(x0 - mix(1.4, 1.9, rnd(seed, 7u)), x0, y0 + 0.3, y1 - 0.3, 3u, seed); }
  gRot = 0.0;
}

/** a lean-to of cloth from the ground up to a wall: its high side `turn` (lean-to turns: 0 the rect's back, 1 its
 *  x0 side, 2 its front, 3 its x1 side) */
fn leanTent(x0: f32, x1: f32, y0: f32, y1: f32, turn: u32, seed: u32) {
  let g = gGround;
  put(K_ROOF, S_CLOTH, F_SHED, rect(x0, x1, y0, y1), g + 0.55, vec4<f32>(g + mix(2.0, 2.5, rnd(seed, 31u)), 0.0, f32(turn), 0.05));
}

/** a shanty lot: a few huts, crooked, crowded, crates and barrels between them */
fn shanty(seed: u32) {
  let W = gW;
  let D = gD;
  let n = clamp(u32(W * D / 30.0), 1u, 4u);
  for (var k = 0u; k < n; k++) {
    let s = hash(seed + k * 31u);
    let w = min(mix(2.8, 4.6, rnd(s, 10u)), W - 0.6);
    let d = min(mix(2.6, 4.0, rnd(s, 11u)), D - 0.6);
    // (packed in rows along the street, the back ones behind)
    let cols = max(1u, u32(W / 4.5));
    let cx = (f32(k % cols) + 0.5) * W / f32(cols) + (rnd(s, 12u) - 0.5) * 0.8;
    let cy = select(1.6 + d * 0.5, D - d * 0.5 - 0.5, k >= cols) + (rnd(s, 13u) - 0.5) * 0.6;
    let x0 = clamp(cx - w * 0.5, 0.2, W - w - 0.2);
    let y0 = clamp(cy - d * 0.5, 1.5, D - d - 0.2);
    hut(x0, x0 + w, y0, y0 + d, (rnd(s, 14u) - 0.5) * 0.45, s);
  }
  crates(lp(W * rnd(seed, 20u), 0.9), 0.7, 1u + hash(seed + 3u) % 2u, rnd(seed, 21u));
  cyl(lp(W * rnd(seed, 22u), 0.6), 0.32, gGround, gGround + 0.85, S_WOOD, F_NOWIN);
}

/** a dock: a deck of planks over the lot on posts, a crane with a crate on its rope, crates stacked, barrels, bollards,
 *  a small shed */
fn dock(seed: u32) {
  let g = gGround;
  let W = gW;
  let D = gD;
  body(S_PLANK, F_NOWIN, rect(0.2, W - 0.2, 0.2, D - 0.2), g - 0.5, g + 0.25);
  // posts round its edge
  let np = u32(W / 2.5) + 1u;
  for (var k = 0u; k < min(np, 6u); k++) {
    let x = mix(0.25, W - 0.55, f32(k) / f32(max(np - 1u, 1u)));
    body(S_WOOD, F_NOWIN, rect(x, x + 0.3, 0.05, 0.35), g - 1.8, g + 0.5);
    cyl(lp(x + 0.15, 0.7), 0.16, g + 0.25, g + 0.7, S_STONE, F_NOWIN);
  }
  // the crane: a post, a jib out over the front, a rope and a crate
  let cx = W * mix(0.25, 0.75, rnd(seed, 1u));
  let ch = mix(5.5, 7.5, rnd(seed, 2u));
  body(S_WOOD, F_NOWIN, rect(cx - 0.25, cx + 0.25, 1.4, 1.9), g + 0.25, g + ch);
  body(S_WOOD, F_NOWIN, rect(cx - 0.12, cx + 0.12, -1.6, 2.1), g + ch - 0.35, g + ch);
  body(S_WOOD, F_NOWIN, rect(cx - 0.05, cx + 0.05, -1.35, -1.25), g + 2.3, g + ch - 0.35);
  let cq = rect(cx - 0.45, cx + 0.45, -1.75, -0.85);
  body(S_CRATE, F_NOWIN, cq, g + 1.5, g + 2.3);
  // crates and barrels
  for (var k = 0u; k < 4u; k++) {
    let s = hash(seed + k * 13u);
    crates(lp(mix(1.0, W - 1.0, rnd(s, 1u)), mix(3.0, D - 1.0, rnd(s, 2u))), mix(0.7, 1.0, rnd(s, 3u)), 1u + hash(s) % 3u, rnd(s, 4u) * 0.6);
    cyl(lp(mix(1.0, W - 1.0, rnd(s, 5u)), mix(2.6, D - 1.0, rnd(s, 6u))), 0.34, g + 0.25, g + 1.1, S_WOOD, F_NOWIN);
  }
  // a shed at the back
  if (D > 7.0) { hut(W * 0.5 - 2.0, W * 0.5 + 2.0, D - 3.6, D - 0.4, 0.0, hash(seed + 99u)); }
}

/** a banded brick smokestack at p */
fn smokestack(p: vec2<f32>, top: f32) {
  let g = gGround;
  cyl(p, 0.95, g - 0.4, g + 1.2, S_STONE, F_NOWIN);
  cyl(p, 0.72, g + 1.2, top, S_BRICK, F_NOWIN);
  cyl(p, 0.82, (g + top) * 0.5, (g + top) * 0.5 + 0.35, S_STONE, F_NOWIN);
  cyl(p, 0.85, top - 0.5, top, S_STONE, F_NOWIN);
}

/** a water wheel on the side x = xs of a building (out towards dir), its centre at y, radius r */
fn waterWheel(xs: f32, dir: f32, y: f32, r: f32) {
  let c = lp(xs + dir * 0.75, y);
  // corner 1: the wheel's plane (along y in the lot's frame); z0 its axle's height; radius, width along the axle
  put(K_WHEEL, S_WOOD, 0u, array<vec2<f32>, 4>(c, LY, LX * dir, vec2<f32>(0.0)), gGround + r * 0.55, vec4<f32>(r, 0.9, 0.0, 0.0));
  // its race: a stone trough under it
  body(S_STONE, F_NOWIN, rect(min(xs, xs + dir * 1.4), max(xs, xs + dir * 1.4), y - r - 0.6, y + r + 0.6), gGround - 0.5, gGround - 0.1);
}

/** an industrial hall: brick, the lot's length, a sawtooth roof of lean-tos with glazed lights, big doors, a smokestack,
 *  sometimes a water wheel on its end */
fn industrial(eave: f32, seed: u32) {
  let g = gGround;
  let W = gW;
  let D = gD;
  let x0 = 0.5;
  let x1 = W - 0.5;
  let y0 = 0.6;
  let y1 = D - 0.5;
  let e = max(eave, g + 5.0);
  let q = rect(x0, x1, y0, y1);
  body(S_PLINTH, F_NOWIN, grow(q, 0.12), g - 0.6, g + 0.5);
  wallBody(S_WALL, F_FRONT0 | F_UNDER, q, g + 0.5, e);
  body(S_TRIM, F_NOWIN, grow(q, 0.1), e - 0.3, e);
  // the sawtooth: lean-tos across the hall, each its glazed light facing the back (north light)
  let n = clamp(u32((y1 - y0) / 4.0), 1u, 6u);
  let step = (y1 - y0) / f32(n);
  for (var k = 0u; k < n; k++) {
    let a = y0 + f32(k) * step;
    let sq = rect(x0, x1, a, a + step);
    // (turn 2: the high side on the quad's edge 0 → 1 — the street side of the tooth; its glass faces the street)
    put(K_ROOF, S_ROOF, F_SHED, sq, e + 0.05, vec4<f32>(e + 0.05 + step * 0.55, 0.0, 2.0, 0.15));
    body(S_GLASS, F_NOWIN, rect(x0 + 0.1, x1 - 0.1, a - 0.04, a + 0.04), e, e + step * 0.55);
  }
  // (its big street door: the window pass's, the style's door size)
  // the smokestack, at a back corner
  smokestack(lp(select(x0 + 1.2, x1 - 1.2, rnd(seed, 1u) < 0.5), y1 - 1.2), e + mix(7.0, 11.0, rnd(seed, 2u)));
  if (rnd(seed, 3u) < 0.5) { waterWheel(select(x0, x1, rnd(seed, 4u) < 0.5), select(-1.0, 1.0, rnd(seed, 4u) < 0.5), (y0 + y1) * 0.5, 2.3); }
  // a yard of crates and barrels by the street
  crates(lp(x0 + 0.8, y0 - 0.2), 0.8, 2u, 0.2);
}

/** a market stall: four posts, a striped canopy, a counter with goods; in the frame, at (x, y), facing the street */
fn stall(x: f32, y: f32, w: f32, d: f32, seed: u32) {
  let g = gGround;
  let pw = 0.12;
  body(S_WOOD, F_NOWIN, rect(x, x + pw, y, y + pw), g, g + 2.2);
  body(S_WOOD, F_NOWIN, rect(x + w - pw, x + w, y, y + pw), g, g + 2.2);
  body(S_WOOD, F_NOWIN, rect(x, x + pw, y + d - pw, y + d), g, g + 2.5);
  body(S_WOOD, F_NOWIN, rect(x + w - pw, x + w, y + d - pw, y + d), g, g + 2.5);
  // the canopy: a lean-to high at the back (turn 2)
  put(K_ROOF, S_CLOTH, F_SHED, rect(x - 0.2, x + w + 0.2, y - 0.35, y + d), g + 2.15, vec4<f32>(g + 2.6, 0.0, 0.0, 0.05));
  body(S_WOOD, F_NOWIN, rect(x + 0.15, x + w - 0.15, y + 0.1, y + 0.7), g, g + 0.95);
  body(S_GOODS, F_NOWIN, rect(x + 0.25, x + w - 0.25, y + 0.15, y + 0.62), g + 0.95, g + 1.15 + 0.15 * rnd(seed, 1u));
}

/** a tent: a ridge of cloth to the ground (a gable roof with no walls), or a round one (a cone on a short wall) */
fn tent(cx: f32, cy: f32, seed: u32) {
  let g = gGround;
  if (rnd(seed, 1u) < 0.5) {
    let w = mix(2.4, 3.2, rnd(seed, 2u));
    let d = mix(3.0, 4.2, rnd(seed, 3u));
    // (turned to its own angle: tents are pitched where they fit, not on the street's square)
    gPiv = vec2<f32>(cx, cy);
    gRot = (rnd(seed, 4u) - 0.5) * 1.7;
    put(K_ROOF, S_CLOTH, 0u, rect(cx - w * 0.5, cx + w * 0.5, cy - d * 0.5, cy + d * 0.5), g + 0.15, vec4<f32>(g + 2.4, 0.0, 1.0, 0.05));
    gRot = 0.0;
  } else {
    let r = mix(1.4, 2.0, rnd(seed, 2u));
    cyl(lp(cx, cy), r, g, g + 1.1, S_CLOTH, F_NOWIN);
    put(K_CONE, S_CLOTH, 0u, array<vec2<f32>, 4>(lp(cx, cy), vec2<f32>(r + 0.2, 0.0), vec2<f32>(0.0), vec2<f32>(0.0)), g + 1.05, vec4<f32>(g + 1.05 + r * 1.1));
  }
}

/** is the frame's point p nearest a street edge of the footprint (else a lot line, a neighbour's wall beyond it) */
fn sideStreet(p: vec2<f32>) -> bool {
  var best = 1e9;
  var k0 = 0u;
  for (var k = 0u; k < 4u; k++) {
    let a = gFp[k];
    let e = gFp[(k + 1u) % 4u] - a;
    let t = clamp(dot(p - a, e) / max(dot(e, e), 1e-4), 0.0, 1.0);
    let d = length(p - a - e * t);
    if (d < best) { best = d; k0 = k; }
  }
  return gStreet[k0];
}

/** a row of cloth lean-tos along a side of the frame, their high sides on it (against the neighbour's wall) */
fn tentRow(along: bool, at: f32, s0: f32, s1: f32, dep: f32, turn: u32, seed: u32) {
  var x = s0;
  var k = 0u;
  loop {
    let s = hash(seed + k * 41u);
    let w = mix(2.0, 3.0, rnd(s, 1u));
    if (x + w > s1 || k >= 5u) { break; }
    if (rnd(s, 2u) < 0.8) {
      let d = dep * mix(0.8, 1.0, rnd(s, 3u));
      if (along) { leanTent(x, x + w, at - d, at, turn, s); }
      else if (turn == 1u) { leanTent(at, at + d, x, x + w, turn, s); }
      else { leanTent(at - d, at, x, x + w, turn, s); }
    }
    x += w + 0.25;
    k++;
  }
}

/** a market on a plaza: stalls in rows facing aisles, tents pitched among them at their own angles, lean-tos against
 *  the walls of the lots beside it, a fountain in the middle */
fn market(seed: u32) {
  let W = gW;
  let D = gD;
  // the sides that are lot lines (not streets): a row of lean-tos against each
  var x0 = 0.5;
  var x1 = W - 0.5;
  var y1 = D - 0.5;
  let dep = 2.0;
  if (D > 7.0 && !sideStreet(lp(W * 0.5, D))) { tentRow(true, D - 0.1, 0.3, W - 0.3, dep, 0u, seed + 1u); y1 = D - dep - 0.6; }
  if (W > 8.0 && !sideStreet(lp(0.0, D * 0.5))) { tentRow(false, 0.1, 1.0, y1, dep, 1u, seed + 2u); x0 = dep + 0.6; }
  if (W > 8.0 && !sideStreet(lp(W, D * 0.5))) { tentRow(false, W - 0.1, 1.0, y1, dep, 3u, seed + 3u); x1 = W - dep - 0.6; }
  let sw = 2.6;
  let sd = 1.9;
  let aw = x1 - x0;
  let ad = y1 - 0.5;
  let nx = min(u32(aw / (sw + 1.0)), 4u);
  let ny = min(u32(ad / (sd + 2.4)), 3u);
  if (nx == 0u || ny == 0u) {
    if (W > 3.0 && D > 3.0) { fountain(lp(W * 0.5, D * 0.5), min(1.3, min(W, D) * 0.3)); }
    return;
  }
  let midx = nx / 2u;
  let midy = ny / 2u;
  for (var j = 0u; j < ny; j++) {
    for (var i = 0u; i < nx; i++) {
      let s = hash(seed + i * 7u + j * 131u);
      let x = x0 + (f32(i) + 0.5) * aw / f32(nx) - sw * 0.5;
      let y = 0.5 + (f32(j) + 0.5) * ad / f32(ny) - sd * 0.5;
      if (i == midx && j == midy && nx * ny > 2u) { fountain(lp(x + sw * 0.5, y + sd * 0.5), 1.2); continue; }
      if (rnd(s, 5u) < 0.3) { tent(x + sw * 0.5 + (rnd(s, 6u) - 0.5) * 0.8, y + sd * 0.5, s); } else { stall(x, y, sw, sd, s); }
    }
  }
}

/** a garden on a park, on the land itself (no plate: the user, "just make grass and plants"): shrubs in clumps round
 *  its edge, trees through it, low flowering beds, a fountain or a great tree in the middle */
fn garden(seed: u32) {
  let W = gW;
  let D = gD;
  // shrubs round the edge, in clumps of two or three
  let n = clamp(u32((W + D) / 4.0), 2u, 9u);
  for (var k = 0u; k < n; k++) {
    let s = hash(seed + k * 17u);
    let per = rnd(s, 1u) * 2.0 * (W + D);
    var p = vec2<f32>(per, 0.7);
    if (per > W) { p = vec2<f32>(W - 0.7, per - W); }
    if (per > W + D) { p = vec2<f32>(W - (per - W - D), D - 0.7); }
    if (per > 2.0 * W + D) { p = vec2<f32>(0.7, D - (per - 2.0 * W - D)); }
    let m = 1u + hash(s) % 3u;
    for (var j = 0u; j < m; j++) {
      let q = p + (vec2<f32>(rnd(s, 10u + j), rnd(s, 20u + j)) - 0.5) * 1.6;
      bush(lp(clamp(q.x, 0.6, W - 0.6), clamp(q.y, 0.6, D - 0.6)), mix(0.45, 0.9, rnd(s, 30u + j)), mix(0.6, 1.3, rnd(s, 40u + j)), rnd(s, 4u) < 0.35);
    }
  }
  let big = W > 6.0 && D > 6.0;
  let mid = lp(W * 0.5, D * 0.5);
  let centreTree = rnd(seed, 50u) < 0.45;
  if (big) {
    if (centreTree) { tree(mid, mix(5.5, 7.5, rnd(seed, 51u)), hash(seed + 51u)); }
    else { fountain(mid, min(1.6, min(W, D) * 0.2)); }
  }
  // trees through it (clear of the middle)
  let nt = clamp(u32(W * D / 45.0), 1u, 6u);
  for (var k = 0u; k < nt; k++) {
    let s = hash(seed + 200u + k * 13u);
    var x = mix(1.5, W - 1.5, rnd(s, 1u));
    var y = mix(1.5, D - 1.5, rnd(s, 2u));
    if (big && abs(x - W * 0.5) < 2.4 && abs(y - D * 0.5) < 2.4) { x = select(W * 0.5 + 2.6, W * 0.5 - 2.6, x < W * 0.5); }
    tree(lp(clamp(x, 1.2, W - 1.2), clamp(y, 1.2, D - 1.2)), mix(3.5, 6.0, rnd(s, 3u)), s);
  }
  // flowering beds: low wide clumps in a row or two
  let nb = clamp(u32(W / 3.5), 1u, 4u);
  for (var k = 0u; k < nb; k++) {
    let s = hash(seed + 400u + k * 7u);
    let x = (f32(k) + 0.5) * W / f32(nb) + (rnd(s, 1u) - 0.5);
    let y = select(D * 0.25, D * 0.75, (k & 1u) == 1u) + (rnd(s, 2u) - 0.5);
    bushAt(lp(clamp(x, 0.8, W - 0.8), clamp(y, 0.8, D - 0.8)), gGround - 0.15, mix(0.6, 0.9, rnd(s, 3u)), 0.45, true);
  }
}

/** a courtyard block: four ranges round a court, a gateway on the street, a fountain and shrubs inside */
fn courtyard(eave: f32, seed: u32) {
  let W = gW;
  let D = gD;
  let sb = min(1.2, D * 0.1);
  let dep = clamp(min(W, D) * 0.28, 4.5, 7.0);
  let s = gS;
  // the street range, the back range, the two sides between them
  let r0 = block(0.4, W - 0.4, sb, sb + dep, eave, 0u, hash(seed + 1u), true, true);
  block(0.4, W - 0.4, D - 0.4 - dep, D - 0.4, eave, 0u, hash(seed + 2u), false, true);
  let e2 = max(gGround + STOREY + 0.45, eave - STOREY);
  block(0.4, 0.4 + dep, sb + dep, D - 0.4 - dep, e2, 1u, hash(seed + 3u), false, false);
  block(W - 0.4 - dep, W - 0.4, sb + dep, D - 0.4 - dep, e2, 1u, hash(seed + 4u), false, false);
  if (rnd(seed, 5u) < 0.6) { dormers(0.4, W - 0.4, sb, sb + dep, eave, r0, seed); }
  // the court
  let cx = W * 0.5;
  let cy = (sb + dep + D - 0.4 - dep) * 0.5;
  fountain(lp(cx, cy), 1.1);
  for (var k = 0u; k < 4u; k++) {
    let a = f32(k) * 1.5708 + 0.6;
    bush(lp(cx + cos(a) * 2.6, cy + sin(a) * 2.2), 0.7, 1.1, k % 2u == 0u);
  }
  // a round tower at a front corner, sometimes
  if (rnd(seed, 6u) < sty(s, 6u).y) { roundTower(lp(select(0.4, W - 0.4, rnd(seed, 7u) < 0.5), sb), 2.0, eave + STOREY * 1.5, seed); }
}

/** shrubs and planters round a house: by the door, along the lot wall, in the front garden */
fn plantings(seed: u32, sb: f32, dx: f32) {
  if (sb < 1.0) { return; }
  let W = gW;
  let n = 2u + hash(seed + 300u) % 3u;
  for (var k = 0u; k < n; k++) {
    let s = hash(seed + 301u + k);
    var x = mix(0.8, W - 0.8, rnd(s, 1u));
    if (abs(x - dx) < 1.6) { x = dx + select(-1.8, 1.8, x > dx); }
    bush(lp(clamp(x, 0.7, W - 0.7), mix(0.7, max(sb - 0.6, 0.8), rnd(s, 2u))), mix(0.45, 0.8, rnd(s, 3u)), mix(0.6, 1.2, rnd(s, 4u)), rnd(s, 5u) < 0.5);
  }
}

// ---- the irregular-grid family (the user: "consider some styles could use the irregular grids … Townscaper does
// unusually well with larger structures and shanties"; "port to gpu"; "Can the irregular grid span lots so they are
// more seamless?"; "I want the irregular grid lots pretty full and continuous except at roads") ----
// One grid for the whole town, anchored in the town's frame, so lots share it and it runs on across their lines:
// a triangle lattice (side GRID_S) whose neighbours pair into quads where both pick each other (a symmetric hash per
// shared edge: each triangle takes its best edge), every piece then split into quads Townscaper's way (its centre to its
// edges' middles: corners of three and five cells), every vertex nudged by a hash of where it is (so two lots computing
// the same vertex agree). Each lot's thread walks the lattice under its parcel and keeps the cells whose centre is in
// its parcel (and in its footprint grown to its lot lines): no cell twice, no gap between lots; at a street, the cell's
// corners past the footprint's street edge are pulled back onto it, so the facades stand on the street line. Each cell
// a column of its own colour and height (the lot's storeys, a step either way; now and then a tower), its own gable
// roof; arcades along the street; the shanty variant crooked, on stilts, its roofs lean-tos, a yard here and there.

const GRID_S: f32 = 5.4;
const SQ3: f32 = 1.7320508;

var<private> gPar: array<vec2<f32>, 4>;
var<private> gFp: array<vec2<f32>, 4>;
var<private> gFpG: array<vec2<f32>, 4>;
var<private> gStreet: array<bool, 4>;
var<private> gFront: bool;

fn latP(a: i32, b: i32) -> vec2<f32> { return vec2<f32>(f32(a) + 0.5 * f32(b), f32(b) * SQ3 * 0.5) * GRID_S; }
/** a triangle's id: its lattice cell and up (0) or down (1) */
fn triId(a: i32, b: i32, t: u32) -> u32 { return ((u32(a + 32768) * 65599u) ^ (u32(b + 32768) * 2654435761u)) ^ (t * 97u); }
fn triV(a: i32, b: i32, t: u32, k: u32) -> vec2<f32> {
  if (t == 0u) {
    if (k == 0u) { return latP(a, b); }
    if (k == 1u) { return latP(a + 1, b); }
    return latP(a, b + 1);
  }
  if (k == 0u) { return latP(a + 1, b); }
  if (k == 1u) { return latP(a + 1, b + 1); }
  return latP(a, b + 1);
}
/** the triangle across edge k (from vertex k to k + 1) */
fn triN(a: i32, b: i32, t: u32, k: u32) -> vec3<i32> {
  if (t == 0u) {
    if (k == 0u) { return vec3<i32>(a, b - 1, 1); }
    if (k == 1u) { return vec3<i32>(a, b, 1); }
    return vec3<i32>(a - 1, b, 1);
  }
  if (k == 0u) { return vec3<i32>(a + 1, b, 0); }
  if (k == 1u) { return vec3<i32>(a, b + 1, 0); }
  return vec3<i32>(a, b, 0);
}
fn edgeH(i0: u32, i1: u32) -> u32 { return hash(min(i0, i1) * 31u + hash(max(i0, i1))); }
/** the edge (0–2) a triangle would merge across: its best edge */
fn triPick(a: i32, b: i32, t: u32) -> u32 {
  let me = triId(a, b, t);
  var best = 0u;
  var bh = 0u;
  for (var k = 0u; k < 3u; k++) {
    let n = triN(a, b, t, k);
    let h = edgeH(me, triId(n.x, n.y, u32(n.z)));
    if (h > bh) { bh = h; best = k; }
  }
  return best;
}
/** a point nudged by a hash of where it is: the same wherever it's computed */
fn nudge(p: vec2<f32>) -> vec2<f32> {
  let key = vec2<i32>(round(p * 8.0));
  let h = hash((u32(key.x + 100000) * 73856093u) ^ (u32(key.y + 100000) * 19349663u));
  let a = f32(h & 0xffffu) / 65535.0 * 6.28318;
  let r = f32((h >> 16u) & 0xffffu) / 65535.0;
  return p + vec2<f32>(cos(a), sin(a)) * r * GRID_S * 0.09;
}
fn inQuad(q: array<vec2<f32>, 4>, p: vec2<f32>) -> bool {
  var qq = q;
  for (var k = 0u; k < 4u; k++) {
    let e = qq[(k + 1u) % 4u] - qq[k];
    let d = p - qq[k];
    if (e.x * d.y - e.y * d.x < 0.0) { return false; }
  }
  return true;
}
/** a corner pulled back onto the footprint's street edges (it never stands in the street) */
fn toStreet(p0: vec2<f32>) -> vec2<f32> {
  var p = p0;
  for (var k = 0u; k < 4u; k++) {
    if (!gStreet[k]) { continue; }
    let a = gFp[k];
    let e = normalize(gFp[(k + 1u) % 4u] - a);
    let out = vec2<f32>(e.y, -e.x);
    let d = dot(p - a, out);
    if (d > 0.0) { p -= out * d; }
  }
  return p;
}

/** the footprint's street edges: inset from the parcel by more than a lot line's 0.35 */
fn streetEdges() {
  for (var k = 0u; k < 4u; k++) {
    let a = gPar[k];
    let e = normalize(gPar[(k + 1u) % 4u] - a);
    let m = (gFp[k] + gFp[(k + 1u) % 4u]) * 0.5;
    gStreet[k] = abs(dot(m - a, vec2<f32>(e.y, -e.x))) > 0.6;
  }
}

/** is p on a street edge of the footprint */
fn onStreet(p: vec2<f32>) -> bool {
  for (var e = 0u; e < 4u; e++) {
    if (!gStreet[e]) { continue; }
    let a = gFp[e];
    let ed = normalize(gFp[(e + 1u) % 4u] - a);
    if (abs(dot(p - a, vec2<f32>(ed.y, -ed.x))) < 0.05) { return true; }
  }
  return false;
}

/** q's corners pulled onto the streets; gFront if one stands on a street, and then q turned so its side 0 is the
 *  longest side lying on the street line (its door's side) */
fn faceStreet(q0: array<vec2<f32>, 4>) -> array<vec2<f32>, 4> {
  var q = q0;
  for (var k = 0u; k < 4u; k++) { q[k] = toStreet(q[k]); }
  gFront = false;
  var best = 4u;
  var bl = 0.0;
  for (var k = 0u; k < 4u; k++) {
    if (!onStreet(q[k])) { continue; }
    gFront = true;
    let n = (k + 1u) % 4u;
    let l = length(q[n] - q[k]);
    if (onStreet(q[n]) && l > bl) { bl = l; best = k; }
  }
  if (best == 4u) { return q; }
  var r = q;
  for (var k = 0u; k < 4u; k++) { r[k] = q[(k + best) % 4u]; }
  return r;
}

fn quadArea(q: array<vec2<f32>, 4>) -> f32 {
  return 0.5 * abs((q[2].x - q[0].x) * (q[3].y - q[1].y) - (q[3].x - q[1].x) * (q[2].y - q[0].y));
}
/** a hash of where a point is (the same in every lot that computes it) */
fn posHash(c: vec2<f32>) -> u32 {
  return hash((u32(round(c.x * 4.0) + 100000.0) * 2246822519u) ^ (u32(round(c.y * 4.0) + 100000.0) * 3266489917u));
}

/** one cell of the grid: a column and its roof, a column with a patio on top, or (a shanty's yard) a cloth lean-to or
 *  a shrub */
fn gridCell(q0: array<vec2<f32>, 4>, seed: u32, shanty: bool) {
  // (room for the most a cell makes: a column, a parapet, a shrub, four stilts and a roof)
  if (gN + 7u > PPL) { return; }
  var q = faceStreet(q0);
  let front = gFront;
  // (pulled flat onto a street: too thin to stand)
  if (quadArea(q) < 1.2) { return; }
  let c = (q[0] + q[1] + q[2] + q[3]) * 0.25;
  let ch = posHash(c);
  let g = gGround;
  let LH = STOREY;
  let H0 = select(f32(max(REC[gLot * RECW + 19u], 1u)), 1.4, shanty);
  // (the street's columns lead; behind them a storey lower, so the fronts read and the roofs step down)
  var h = i32(round(H0 + (rnd(ch, 1u) - 0.5) * 1.4 - select(1.0, 0.0, front)));
  let tower = !shanty && rnd(ch, 2u) > 0.965;
  if (tower) { h += 2; }
  h = clamp(h, 1, select(6, 2, shanty));
  if (shanty && !front && rnd(ch, 3u) < 0.16) {
    // a yard: a cloth lean-to against the next column (its high side away from the street), or a shrub
    if (rnd(ch, 4u) < 0.65) {
      put(K_ROOF, S_CLOTH, F_SHED, grow(q, -0.15), g + 0.6, vec4<f32>(g + mix(2.0, 2.5, rnd(ch, 13u)), 0.0, f32(hash(ch) % 4u), 0.05));
    } else {
      bushAt(c, g - 0.1, 0.6, 0.9, rnd(ch, 14u) < 0.5);
    }
    return;
  }
  var z0 = g;
  let z1 = g + f32(h) * LH;
  var ff = select(0u, F_FRONT0, front);
  let lifted = (shanty && rnd(ch, 5u) < 0.4) || (!shanty && front && h >= 3 && rnd(ch, 6u) < 0.18);
  if (lifted) {
    let lz = select(LH, 1.3, shanty);
    let ps = select(0.42, 0.18, shanty);
    let inq = grow(q, -ps * 0.5);
    for (var k = 0u; k < 4u; k++) { post(inq[k], ps, z0 - 0.3, z0 + lz, select(S_STONE, S_WOOD, shanty)); }
    z0 = z0 + lz;
    ff = 0u;
  }
  if (shanty) {
    put(K_BODY, S_WALL, ff, q, z0, vec4<f32>(z1 + (rnd(ch, 7u) - 0.5) * 0.3, z1 + (rnd(ch, 8u) - 0.5) * 0.3, z1 + (rnd(ch, 9u) - 0.5) * 0.3, z1 + (rnd(ch, 10u) - 0.5) * 0.3));
    roof(q, z1 + 0.12, hash(ch) % 4u, 0.4, 0.0, 0.25, F_SHED);
    return;
  }
  body(S_TINT, ff | F_UNDER, q, z0, z1);
  // its own gable: a street column's to the street (side 0 is on it); behind, the ridge along the lot's street, so the
  // roofs fall into rows instead of a heap; a tower's a pyramid
  var turn = 1u;
  if (!front) {
    let a0 = abs(dot(normalize(q[1] - q[0]), LX));
    let a1 = abs(dot(normalize(q[2] - q[1]), LX));
    turn = select(1u, 0u, a0 >= a1);
  }
  if (front && rnd(ch, 11u) < 0.2) { turn = 0u; }
  let rise = roof(q, z1 + 0.05, turn, select(1.05, 1.6, tower), select(0.0, 0.5, tower), 0.16, 0u);
  if (!tower && rnd(ch, 12u) < 0.07) { chimney(c + (q[1] - q[0]) * 0.15, z1 + rise * 0.3, z1 + rise + 0.8); }
}

/** a whole piece of the grid joined into one house (the user: rooflines "need to either join into larger sections"):
 *  the merged pair of triangles its cells came from, one column of one colour, one roof over it all — a gable along
 *  its length, or a hip — a chimney or two */
fn gridPiece(q0: array<vec2<f32>, 4>, ch: u32) {
  if (gN + 4u > PPL) { return; }
  let q = faceStreet(q0);
  let front = gFront;
  let g = gGround;
  let H0 = f32(max(REC[gLot * RECW + 19u], 1u));
  let h = clamp(i32(round(H0 + (rnd(ch, 1u) - 0.3) * 1.4 - select(0.8, 0.0, front))), 1, 6);
  let z1 = g + f32(h) * STOREY;
  body(S_TINT, select(0u, F_FRONT0, front) | F_UNDER, q, g, z1);
  let l0 = length(q[1] - q[0]) + length(q[2] - q[3]);
  let l1 = length(q[2] - q[1]) + length(q[3] - q[0]);
  // (the ridge along its length; on the street, now and then turned to show the street a broad gable)
  var turn = select(1u, 0u, l0 >= l1);
  if (front && rnd(ch, 5u) < 0.3) { turn = 1u - turn; }
  let hip = rnd(ch, 2u) < 0.4;
  let rise = roof(q, z1 + 0.05, turn, 0.95, select(0.0, 0.32, hip), 0.24, 0u);
  let c = (q[0] + q[1] + q[2] + q[3]) * 0.25;
  if (rnd(ch, 3u) < 0.45) { chimney(mix(c, q[1], 0.45), z1 + rise * 0.3, z1 + rise + 0.9); }
  if (rnd(ch, 4u) < 0.25) { chimney(mix(c, q[3], 0.45), z1 + rise * 0.3, z1 + rise + 0.7); }
}

/** a whole piece of the grid as one roof terrace (the user: "little open patios up top"; adjacent ones "not joined"
 *  looked bad): one column a storey under its neighbours, one floor, one low parapet round it all, a stair hut at a
 *  corner with a lean-to roof, potted shrubs. q a quad, or a triangle (its corner 3 on corner 2). */
fn gridTerrace(q0: array<vec2<f32>, 4>, tri: bool, ch: u32) {
  if (gN + 7u > PPL) { return; }
  let q = faceStreet(q0);
  let front = gFront;
  let g = gGround;
  let H0 = f32(max(REC[gLot * RECW + 19u], 1u));
  let h = clamp(i32(round(H0 - 0.6 + (rnd(ch, 1u) - 0.5))), 1, 5);
  let z1 = g + f32(h) * STOREY;
  body(S_TINT, select(0u, F_FRONT0, front), q, g, z1);
  put(K_CREN, S_FRAME, 0u, q, z1, vec4<f32>(0.5, 0.0, 1.0, 0.14));
  // the stair hut in a corner (a triangle's corner 0 or 1: its two sides real)
  let k = select(hash(ch) % 4u, hash(ch) % 2u, tri);
  let c = q[k];
  let e1 = normalize(q[(k + 1u) % 4u] - c);
  let e2 = normalize(q[(k + 3u) % 4u] - c);
  let hq = array<vec2<f32>, 4>(c + (e1 + e2) * 0.25, c + e1 * 1.75 + e2 * 0.25, c + (e1 + e2) * 1.75, c + e1 * 0.25 + e2 * 1.75);
  if (rnd(ch, 2u) < 0.7 && quadArea(q) > 14.0) {
    body(S_TINT, 0u, hq, z1, z1 + 2.3);
    roof(hq, z1 + 2.35, 2u, 0.5, 0.0, 0.15, F_SHED);
  }
  let cen = (q[0] + q[1] + q[2] + q[3]) * 0.25;
  bushAt(mix(cen, q[(k + 2u) % 4u], 0.55), z1, 0.42, 0.7, rnd(ch, 3u) < 0.6);
  if (rnd(ch, 4u) < 0.5) { bushAt(mix(cen, q[(k + 1u) % 4u], 0.55), z1, 0.36, 0.6, rnd(ch, 5u) < 0.6); }
}

/** a small square post at p (a pillar, a stilt) */
fn post(p: vec2<f32>, w: f32, z0: f32, z1: f32, surf: u32) {
  let ex = LX * w * 0.5;
  let ey = LY * w * 0.5;
  body(surf, F_NOWIN, array<vec2<f32>, 4>(p - ex - ey, p + ex - ey, p + ex + ey, p - ex + ey), z0, z1);
}

fn grid(seed: u32) {
  let shanty = u32(sty(gS, 0u).w + 0.5) == 4u;
  gFpG = grow(gFp, 0.6);
  // the lattice under the parcel: its bounding box in lattice coordinates (b from y, a from x less half of b)
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  for (var k = 0u; k < 4u; k++) { lo = min(lo, gPar[k]); hi = max(hi, gPar[k]); }
  let b0 = i32(floor(lo.y / (GRID_S * SQ3 * 0.5))) - 1;
  let b1 = i32(ceil(hi.y / (GRID_S * SQ3 * 0.5))) + 1;
  for (var b = b0; b <= b1; b++) {
    let a0 = i32(floor(lo.x / GRID_S - 0.5 * f32(b))) - 1;
    let a1 = i32(ceil(hi.x / GRID_S - 0.5 * f32(b))) + 1;
    for (var a = a0; a <= a1; a++) {
      for (var t = 0u; t < 2u; t++) {
        // a piece: this triangle merged with the one across its pick if that one picks it back (the pair made once,
        // by the lower id), else this triangle alone
        let pk = triPick(a, b, t);
        let n = triN(a, b, t, pk);
        let nk = triPick(n.x, n.y, u32(n.z));
        let nn = triN(n.x, n.y, u32(n.z), nk);
        let merged = nn.x == a && nn.y == b && u32(nn.z) == t;
        if (merged && triId(a, b, t) > triId(n.x, n.y, u32(n.z))) { continue; }
        var V: array<vec2<f32>, 4>;
        var nv = 3u;
        if (merged) {
          // A B C (this one, CCW) with the shared edge A → B; D the other's far corner: A D B C
          let A = triV(a, b, t, pk);
          let B = triV(a, b, t, (pk + 1u) % 3u);
          let C = triV(a, b, t, (pk + 2u) % 3u);
          let D = triV(n.x, n.y, u32(n.z), (nk + 2u) % 3u);
          V = array<vec2<f32>, 4>(nudge(A), nudge(D), nudge(B), nudge(C));
          nv = 4u;
        } else {
          V = array<vec2<f32>, 4>(nudge(triV(a, b, t, 0u)), nudge(triV(a, b, t, 1u)), nudge(triV(a, b, t, 2u)), vec2<f32>(0.0));
        }
        // split: each corner a quad with its two edges' middles and the centre (the middles on the straight edges
        // between nudged corners, so a piece's cells together are exactly the piece)
        // each corner's next and previous, built whole (2026-11-12, the phone: a corner's neighbour read as
        // V[(k + nv - 1u) % nv] — an index modulo a count known only at run time — came back on the Mali with its y
        // from the unused V[3], 0, so the cell's corner landed ~145 m away and the roofs drew as spikes; perf-reports
        // archdump of the Pixel 9a. The desktop never did. No index arithmetic on a run-time count here.)
        var Vn = array<vec2<f32>, 4>(V[1], V[2], V[3], V[0]);
        var Vp = array<vec2<f32>, 4>(V[3], V[0], V[1], V[2]);
        if (!merged) {
          Vn = array<vec2<f32>, 4>(V[1], V[2], V[0], V[0]);
          Vp = array<vec2<f32>, 4>(V[2], V[0], V[1], V[1]);
        }
        var cen = V[0] + V[1] + V[2];
        if (merged) { cen += V[3]; }
        cen = nudge(cen / f32(nv));
        var kept = array<bool, 4>(false, false, false, false);
        var allIn = true;
        var anyIn = false;
        for (var k = 0u; k < nv; k++) {
          let vk = V[k];
          let qc = (vk + (vk + Vn[k]) * 0.5 + cen + (Vp[k] + vk) * 0.5) * 0.25;
          kept[k] = inQuad(gPar, qc) && inQuad(gFpG, qc);
          allIn = allIn && kept[k];
          anyIn = anyIn || kept[k];
        }
        if (!anyIn) { continue; }
        // a whole quad piece in this lot: now and then one house (not the shanties: theirs stay huts)
        let ph = posHash(cen);
        // (a terrace a whole piece, so neighbouring flats are one floor behind one parapet, not cells side by side)
        let pr = rnd(ph, 21u);
        if (merged && allIn && !shanty && pr < 0.45) {
          gridPiece(V, ph);
          continue;
        }
        if (allIn && !shanty && ((merged && pr < 0.62) || (!merged && pr < 0.18))) {
          var tq = V;
          if (!merged) { tq[3] = V[2]; }
          gridTerrace(tq, !merged, ph);
          continue;
        }
        for (var k = 0u; k < nv; k++) {
          if (!kept[k]) { continue; }
          let vk = V[k];
          gridCell(array<vec2<f32>, 4>(vk, (vk + Vn[k]) * 0.5, cen, (Vp[k] + vk) * 0.5), seed, shanty);
        }
      }
    }
  }
}

// (2026-11-11, the phone: "CreateComputePipelines failed with VK_ERROR_INITIALIZATION_FAILED … [ComputePipeline
// "arch gen"]") The generator in four passes, one a family of lots — each its own entry point, so each pipeline holds
// only its family's code (a driver inlines a whole entry point's calls: all of them in one was more than the phone's
// compiler would take). Every pass reads every lot (genHead) and makes only its own family's (genFam); the others it
// leaves alone. Family 0 also clears the lots nothing is built on.
var<private> gKind: u32;
var<private> gSeed: u32;
var<private> gEave: f32;
var<private> gArchetype: u32;
var<private> gBuild: bool;

/** the lot's family: 0 houses (and the lots nothing's built on), 1 keeps, docks, industry, 2 shanties, markets,
 *  gardens, 3 the irregular grid; 99 none (past the lots) */
fn genFam() -> u32 {
  if (!gBuild) { return 0u; }
  if (gKind == 3u || gKind == 2u || gArchetype == 2u) { return 2u; }
  if (gArchetype == 1u || gArchetype == 3u || gArchetype == 4u) { return 1u; }
  if (gArchetype == 5u) { return 3u; }
  return 0u;
}

/** the lot's frame and the generator's globals (nothing written) — its family, or 99 */
fn genHead(gx: u32) -> u32 {
  if (gx >= GU.count) { return 99u; }
  let i = GU.first + gx;
  gLot = i;
  PB = ARCH[2];
  gN = 0u;
  gNW = 0u;
  let lots = min(min(CNT[0], CNT[3]), GU.lots);
  if (i >= lots) { return 99u; }
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
  gSeed = hash(REC[o + 23u] + 17u);
  gKind = kind;
  let front = REC[o + 16u];
  // the style: the lab's override, else the district's (until citygen's districtStyle word: a hash of the district)
  var s = GU.style;
  if (s == 0xffffffffu) { s = hash(district * 31u + 7u) % GU.nstyles; }
  gS = s;
  gTag = s | (storeys << 8u);
  gPar = parcel;
  gFp = q;
  gGround = zb + 0.5;
  // (buildings; plazas become markets, parks gardens; fields and landmarks stay citygen's)
  gBuild = (kind == 1u && storeys > 0u && height > 0.0) || kind == 2u || kind == 3u;
  if (!gBuild) { return 0u; }
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
  gEave = zb + height;
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
  gArchetype = u32(sty(s, 5u).z + 0.5);
  return genFam();
}

/** the owning pass's start: the lot's ground height for the draws, (lab) its parcel as ground, its streets */
fn genStart() {
  ARCH[ARCH[6] + gLot] = bitcast<u32>(gGround);
  if (GU.ground != 0u) {
    let t = gTag;
    gTag = gS | (gKind << 8u);
    body(S_GROUND, F_NOWIN, gPar, GU.zmin, gGround);
    gTag = t;
  }
}

/** the owning pass's end: the windows, and the lot's part slots past its last cleared */
fn genEnd() {
  if (gBuild) { windows(); }
  for (var j = gN; j < PPL; j++) { ARCH[PB + (gLot * PPL + j) * PW] = 0u; }
}

@compute @workgroup_size(64)
fn genHouses(@builtin(global_invocation_id) g: vec3<u32>) {
  if (genHead(g.x) != 0u) { return; }
  genStart();
  if (gBuild) {
    streetEdges();
    house(gEave, gSeed);
  }
  genEnd();
}

@compute @workgroup_size(64)
fn genKeeps(@builtin(global_invocation_id) g: vec3<u32>) {
  if (genHead(g.x) != 1u) { return; }
  genStart();
  streetEdges();
  if (gArchetype == 1u) { keep(gEave, gSeed); }
  else if (gArchetype == 3u) { dock(gSeed); }
  else { industrial(gEave, gSeed); }
  genEnd();
}

@compute @workgroup_size(64)
fn genShanties(@builtin(global_invocation_id) g: vec3<u32>) {
  if (genHead(g.x) != 2u) { return; }
  genStart();
  streetEdges();
  if (gKind == 3u) { market(gSeed); }
  else if (gKind == 2u) { garden(gSeed); }
  else { shanty(gSeed); }
  genEnd();
}

@compute @workgroup_size(64)
fn genGrid(@builtin(global_invocation_id) g: vec3<u32>) {
  if (genHead(g.x) != 3u) { return; }
  genStart();
  streetEdges();
  grid(gSeed);
  genEnd();
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
