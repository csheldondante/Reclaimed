// (archgen) Drawing the parts: a kind's instanced draw, its vertex shader building the shape from vertex_index; the
// fragment shader paints the surface from the lot's style. Prepended: arch.wgsl's constants and helpers (not its
// bindings), then the host's head; appended: the host's fragment stage (archlab.wgsl, archgame.wgsl).
//   vsArchBody   a quad prism: four sides and the top (30)
//   vsArchRoof   a roof of chunky courses: two slopes and two ends (hips, or a gable's wall and its stepped verges),
//                COURSES courses each a tread and a lip, a sagging ridge, a flared foot; the eaves' underside (582)
//   vsArchCren   a parapet's walls and merlons (1080)
//   vsArchWin    a window (frame, sill, pane, mullion and transom, shutters, a flower box) or a door (frame, door, step,
//                canopy) standing proud of its wall (330)
//   vsArchCyl    a round body (144); vsArchCone a conical roof of courses (1968); vsArchStair a flight of steps (480)
//
// The host gives: `instances` (array<vec4<u32>>: the arch buffer — archgen.ts layout), archClip(world) → clip,
// archPlace() (added to a part's position: the town's frame in the window), archNight(), archDetail() (0 phone … 1 PC).

fn AW(i: u32) -> u32 { return instances[i >> 2u][i & 3u]; }

struct VO {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  // lot, surface, flags | face << 8 | bits (I_*), tag (style | storeys << 8 | …)
  @location(2) @interpolate(flat) info: vec4<u32>,
  // walls: x along the face from its start, y the face's length, z height above the part's base, w the face's height;
  // courses: x along the course, y its length, z up the course (0 its foot … 1), w the course's index
  @location(3) uv: vec4<f32>,
  // x the part's base z, y the part's ground (the plinth's damp, the windows' storeys)
  @location(4) @interpolate(flat) zs: vec2<f32>,
};

/** info.z bits */
const I_TOP: u32 = 0x1000u;
const I_ROOF: u32 = 0x2000u;
const I_GABLE: u32 = 0x4000u;
const I_UNDER: u32 = 0x8000u;
const I_COURSE: u32 = 0x10000u;
const I_LIP: u32 = 0x20000u;

const GONE: vec3<f32> = vec3<f32>(0.0, 0.0, -1e6);

fn pf(o: u32, w: u32) -> f32 { return bitcast<f32>(AW(AW(2u) + o + w)); }
fn corner(o: u32, k: u32) -> vec2<f32> { return vec2<f32>(pf(o, 2u + k * 2u), pf(o, 3u + k * 2u)); }
fn partOf(kind: u32, ii: u32) -> u32 { return AW(AW(1u) + kind * AW(3u) + ii); }
fn pinfo(b: u32, surf: u32, bits: u32) -> vec4<u32> {
  let w0 = AW(AW(2u) + b);
  return vec4<u32>(AW(AW(2u) + b + 1u), surf, ((w0 >> 16u) & 0xffu) | bits, (AW(AW(2u) + b + 15u) & 0xffffffu) | (((b / PW) & 0xffu) << 24u));
}
fn pseed(b: u32) -> u32 { return hash(b * 2654435761u + 17u); }

/** the lot's construction progress (0–1; the header's word 4: citygen's, copied each frame) */
fn progress(lot: u32) -> f32 { return bitcast<f32>(AW(AW(4u) + min(lot, AW(5u) - 1u))); }

fn finish(o: ptr<function, VO>, wp0: vec3<f32>, live: bool) {
  // (until the construction shader: a lot rises from its ground with its progress — the town's old look; unbegun, gone)
  let pr = clamp(progress((*o).info.x), 0.0, 1.0);
  var wp = wp0;
  let g = bitcast<f32>(AW(AW(6u) + min((*o).info.x, AW(5u) - 1u)));
  wp.z = g + (wp0.z - g) * pr;
  if (pr <= 0.001 || !live) { wp = GONE; }
  let w = wp + archPlace();
  (*o).wpos = w;
  (*o).pos = archClip(w);
}

/** box j's vertex (0–29: four sides, the top) of the prism over quad c (counter-clockwise) from z0 to z1 */
fn boxVert(c: array<vec2<f32>, 4>, z0: f32, z1: f32, j: u32, o: ptr<function, VO>) -> vec3<f32> {
  var cc = c;
  let face = j / 6u;
  let t = j % 6u;
  var AL = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
  var UP = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
  var IX = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  if (face < 4u) {
    let a = cc[face];
    let e = cc[(face + 1u) % 4u];
    let p = select(a, e, AL[t] == 1u);
    let wp = vec3<f32>(p, select(z0, z1, UP[t] == 1u));
    let d = e - a;
    (*o).nrm = normalize(vec3<f32>(d.y, -d.x, 0.0));
    (*o).uv = vec4<f32>(f32(AL[t]) * length(d), length(d), wp.z - z0, z1 - z0);
    (*o).info.z = ((*o).info.z & 0xffu) | (face << 8u);
    return wp;
  }
  (*o).nrm = vec3<f32>(0.0, 0.0, 1.0);
  (*o).info.z = ((*o).info.z & 0xffu) | (face << 8u) | I_TOP;
  let wp = vec3<f32>(cc[IX[t]], z1);
  (*o).uv = vec4<f32>(wp.xy, 0.0, 0.0);
  return wp;
}

/** a box in a wall's frame: from a, u along d, v out (the wall's outside: right of d), w up from z */
fn wallBox(a: vec2<f32>, d: vec2<f32>, u0: f32, u1: f32, v0: f32, v1: f32, z0: f32, z1: f32, j: u32, o: ptr<function, VO>) -> vec3<f32> {
  let n = vec2<f32>(d.y, -d.x);
  // (d, n) turns clockwise: listed v1 first to go counter-clockwise
  let q = array<vec2<f32>, 4>(a + d * u0 + n * v1, a + d * u1 + n * v1, a + d * u1 + n * v0, a + d * u0 + n * v0);
  return boxVert(q, z0, z1, j, o);
}

@vertex
fn vsArchBody(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_BODY, ii) * PW;
  let w0 = AW(AW(2u) + b);
  let z0 = pf(b, 10u);
  let face = vi / 6u;
  let t = vi % 6u;
  var c: array<vec2<f32>, 4>;
  var zt: array<f32, 4>;
  for (var k = 0u; k < 4u; k++) { c[k] = corner(b, k); zt[k] = pf(b, 11u + k); }
  var wp: vec3<f32>;
  o.info = pinfo(b, (w0 >> 8u) & 0xffu, face << 8u);
  o.zs = vec2<f32>(z0, z0);
  if (face < 4u) {
    let a = c[face];
    let e = c[(face + 1u) % 4u];
    var AL = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
    var UP = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
    let along = AL[t];
    let p = select(a, e, along == 1u);
    let zt1 = select(zt[face], zt[(face + 1u) % 4u], along == 1u);
    wp = vec3<f32>(p, select(z0, zt1, UP[t] == 1u));
    let d = e - a;
    o.nrm = normalize(vec3<f32>(d.y, -d.x, 0.0));
    let len = length(d);
    o.uv = vec4<f32>(f32(along) * len, len, wp.z - z0, max(zt[face], zt[(face + 1u) % 4u]) - z0);
  } else {
    var IX = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    wp = vec3<f32>(c[IX[t]], zt[IX[t]]);
    // (from the diagonals: a triangle — a corner repeated — still has one)
    let n = cross(vec3<f32>(c[2], zt[2]) - vec3<f32>(c[0], zt[0]), vec3<f32>(c[3], zt[3]) - vec3<f32>(c[1], zt[1]));
    o.nrm = normalize(select(n, -n, n.z < 0.0));
    // (in the body's own frame — along its side 0 — so flat tops lie each its own way, not all on the world's axes)
    // (a triangle's repeated corner may be on side 0: then side 1's direction)
    var e0 = c[1] - c[0];
    if (dot(e0, e0) < 1e-6) { e0 = c[2] - c[1]; }
    let ex = normalize(e0);
    let rel = wp.xy - c[0];
    o.uv = vec4<f32>(dot(rel, ex), dot(rel, vec2<f32>(-ex.y, ex.x)), 0.0, 0.0);
    o.info.z = o.info.z | I_TOP;
  }
  finish(&o, wp, ii < AW(3u));
  return o;
}

/** a point on a roof face: foot edge B0 → B1 at zb, head edge T0 → T1 at zt; s along, t up. The profile is concave (a
 *  flared foot), the head sags in the middle (sag). */
fn slopePt(B0: vec2<f32>, B1: vec2<f32>, T0: vec2<f32>, T1: vec2<f32>, zb: f32, zt: f32, s: f32, t: f32, sag: f32) -> vec3<f32> {
  let p = mix(mix(B0, B1, s), mix(T0, T1, s), t);
  let z = zb + (zt - zb) * pow(t, 1.3) - sag * sin(3.14159 * s) * t;
  return vec3<f32>(p, z);
}

/** vertex k (0–11) of course i of a face: its tread (0–5) from the foot (lifted by the course's thickness) to the head,
 *  then its lip (6–11) down the foot's edge */
fn courseVert(B0: vec2<f32>, B1: vec2<f32>, T0: vec2<f32>, T1: vec2<f32>, zb: f32, zt: f32, i: u32, rows: u32, k: u32, sag: f32, seed: u32, o: ptr<function, VO>) -> vec3<f32> {
  let t0 = f32(i) / f32(rows);
  let t1 = f32(i + 1u) / f32(rows);
  let a0 = slopePt(B0, B1, T0, T1, zb, zt, 0.0, t0, sag);
  let a1 = slopePt(B0, B1, T0, T1, zb, zt, 1.0, t0, sag);
  let c0 = slopePt(B0, B1, T0, T1, zb, zt, 0.0, t1, sag);
  let c1 = slopePt(B0, B1, T0, T1, zb, zt, 1.0, t1, sag);
  var nf = cross(a1 - a0, c0 - a0);
  if (nf.z < 0.0) { nf = -nf; }
  nf = normalize(nf);
  // the course's thickness: chunky, a little uneven course to course
  let lip = 0.11 + 0.05 * rnd(seed, i);
  let L0 = a0 + nf * lip;
  let L1 = a1 + nf * lip;
  var q: array<vec3<f32>, 4>;
  var lipFace = false;
  if (k < 6u) {
    q = array<vec3<f32>, 4>(L0, L1, c1, c0);
  } else {
    q = array<vec3<f32>, 4>(a0, a1, L1, L0);
    lipFace = true;
  }
  var IX = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  let idx = IX[k % 6u];
  let p = q[idx];
  var n = cross(q[1] - q[0], q[3] - q[0]);
  if (lipFace) {
    // the lip faces down the slope
    let down = (a0 + a1) * 0.5 - (c0 + c1) * 0.5;
    if (dot(n, down) < 0.0) { n = -n; }
  } else if (n.z < 0.0) { n = -n; }
  (*o).nrm = normalize(n);
  let len = length(a1.xy - a0.xy);
  var sAt = select(0.0, 1.0, idx == 1u || idx == 2u);
  // the along-course distance measured on this course's foot (its tiles line up course by course, staggered)
  (*o).uv = vec4<f32>(sAt * len, len, select(select(0.0, 1.0, idx >= 2u), select(0.0, 1.0, idx >= 2u), lipFace), f32(i));
  (*o).info.z = (*o).info.z | I_COURSE | select(0u, I_LIP, lipFace);
  return p;
}

/** (the user: "the cloth roofs … don't look billowy or saggy") a face of cloth: one smooth sheet, no courses — a
 *  grid of 4 × 6 quads (the face's 144 vertices) from the foot edge B0 → B1 (zb) to the head T0 → T1 (zt), bellied down
 *  the slope and dipping between its ends, its normals the surface's own (smooth); lifted by half its sag so it rests on
 *  its frame rather than through it */
fn clothVert(B0: vec2<f32>, B1: vec2<f32>, T0: vec2<f32>, T1: vec2<f32>, zb: f32, zt: f32, j: u32, seed: u32, o: ptr<function, VO>) -> vec3<f32> {
  var IX = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  var DS = array<f32, 4>(0.0, 1.0, 1.0, 0.0);
  var DT = array<f32, 4>(0.0, 0.0, 1.0, 1.0);
  let qd = j / 6u;
  let c = IX[j % 6u];
  let s = (f32(qd % 4u) + DS[c]) / 4.0;
  let t = (f32(qd / 4u) + DT[c]) / 6.0;
  let len = length(B1 - B0);
  let dip = clamp(0.07 * len, 0.1, 0.3) * (0.8 + 0.4 * rnd(seed, 91u));
  let belly = 0.07 + 0.05 * abs(zt - zb);
  let PI = 3.14159;
  let ss = sin(PI * s);
  let st = sin(PI * t);
  let hang = 0.35 + 0.65 * st;
  let lift = 0.5 * (dip + belly);
  let xy = mix(mix(B0, B1, s), mix(T0, T1, s), t);
  let z = zb + (zt - zb) * t - belly * st - dip * ss * hang + lift;
  let dzs = -dip * PI * cos(PI * s) * hang;
  let dzt = (zt - zb) - belly * PI * cos(PI * t) - dip * ss * 0.65 * PI * cos(PI * t);
  let ds = vec3<f32>(mix(B1 - B0, T1 - T0, t), dzs);
  let dt = vec3<f32>(mix(T0, T1, s) - mix(B0, B1, s), dzt);
  var n = cross(ds, dt);
  if (n.z < 0.0) { n = -n; }
  (*o).nrm = normalize(n);
  (*o).uv = vec4<f32>(s * len, len, fract(t * 6.0), floor(t * 6.0));
  (*o).info.z = (*o).info.z | I_COURSE;
  return vec3<f32>(xy, z);
}

@vertex
fn vsArchRoof(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_ROOF, ii) * PW;
  let w0 = AW(AW(2u) + b);
  let flags = (w0 >> 16u) & 0xffu;
  let shed = (flags & F_SHED) != 0u;
  let eave = pf(b, 10u);
  let ridgeZ = pf(b, 11u);
  let inset = pf(b, 12u);
  let turn = u32(pf(b, 13u) + 0.5);
  let over = pf(b, 14u);
  let seed = pseed(b);
  var c: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { c[k] = corner(b, (k + turn) % 4u); }
  // the ridge parallel to c0 → c1: from the middle of edge 3–0 to the middle of edge 1–2, pulled in by the inset; a
  // lean-to's ridge is its high side, edge 3 → 2
  let m30 = (c[3] + c[0]) * 0.5;
  let m12 = (c[1] + c[2]) * 0.5;
  var r0 = mix(m30, m12, inset);
  var r1 = mix(m12, m30, inset);
  var span = max(length(c[0] - m30) + length(c[1] - m12), 0.2) * 0.5;
  if (shed) {
    r0 = c[3];
    r1 = c[2];
    span = max(length(c[0] - c[3]) + length(c[1] - c[2]), 0.2) * 0.5;
  }
  let slope = (ridgeZ - eave) / span;
  // the eaves: each corner out along its bisector; the slopes dropped so their planes hold
  var e: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) {
    let n0 = normalize(persp2(c[k] - c[(k + 3u) % 4u]));
    let n1 = normalize(persp2(c[(k + 1u) % 4u] - c[k]));
    e[k] = c[k] + (n0 + n1) * over;
  }
  let gable = inset < 0.02 && !shed;
  let ax = normalize(r1 - r0);
  var R0 = r0;
  var R1 = r1;
  if (gable) { R0 = r0 - ax * over; R1 = r1 + ax * over; }
  if (shed) { R0 = e[3]; R1 = e[2]; }
  let ez = eave - over * slope;
  let rz = select(ridgeZ, ridgeZ + over * slope, shed);
  // the ridge sags a little in the middle (Tiny Glade's soft roofs), more on a long one
  let sag = select(0.0, (0.04 + 0.08 * rnd(seed, 90u)) * min(length(R1 - R0) / 6.0, 1.5), !shed);
  let PER = COURSES * 12u;
  let face = vi / PER;
  let j = vi % PER;
  var wp = GONE;
  var live = ii < AW(3u);
  let psurf = (w0 >> 8u) & 0xffu;
  o.info = pinfo(b, psurf, I_ROOF | (face << 8u));
  o.zs = vec2<f32>(eave, ridgeZ);
  // cloth: a tent's or an awning's, or a patchwork roof's tarp (the same pick as archSurface's)
  let roofM = u32(styleV(o.info.w & 0xffu, 2u).w + 0.5);
  let cloth = psurf == S_CLOTH || (psurf == S_ROOF && roofM == 3u && hash((o.info.w >> 24u) * 7u + o.info.x) % 3u == 0u);
  if (face < 2u) {
    if (face == 1u && shed) {
      live = false;
    } else {
      var B0 = e[0];
      var B1 = e[1];
      var T0 = R0;
      var T1 = R1;
      if (face == 1u) { B0 = e[2]; B1 = e[3]; T0 = R1; T1 = R0; }
      if (cloth) { wp = clothVert(B0, B1, T0, T1, ez, rz, j, seed + face * 13u, &o); }
      else { wp = courseVert(B0, B1, T0, T1, ez, rz, j / 12u, COURSES, j % 12u, sag, seed, &o); }
    }
  } else if (face < 4u) {
    if (gable || shed) {
      // a gable's wall (c3 c0 r0 / c1 c2 r1), or a lean-to's side (c3 c0 c3↑ / c1 c2 c2↑): a triangle, the rest gone
      let k = select(1u, 3u, face == 2u);
      let p0 = c[k];
      let p1 = c[(k + 1u) % 4u];
      var top = select(r1, r0, face == 2u);
      if (shed) { top = select(c[2], c[3], face == 2u); }
      var tri = array<vec3<f32>, 3>(vec3<f32>(p0, eave), vec3<f32>(p1, eave), vec3<f32>(top, ridgeZ));
      if (j < 3u) { wp = tri[j]; } else { live = false; }
      var n = vec3<f32>(persp2(p1 - p0), 0.0);
      o.nrm = normalize(n);
      let ed = p1 - p0;
      o.uv = vec4<f32>(dot(wp.xy - p0, normalize(ed)), length(ed), wp.z - eave, ridgeZ - eave);
      // (a roof's gable is wall; a tent's is its cloth)
      o.info.y = select(psurf, S_WALL, psurf == S_ROOF);
      o.info.z = (face << 8u) | I_GABLE;
      o.zs = vec2<f32>(eave, eave);
    } else {
      // a hip's end: courses narrowing to the ridge's end
      let k = select(1u, 3u, face == 2u);
      let T = select(R1, R0, face == 2u);
      wp = courseVert(e[k], e[(k + 1u) % 4u], T, T, ez, rz, j / 12u, COURSES, j % 12u, 0.0, seed + 7u, &o);
    }
  } else {
    // the underside of the eaves (not a cloth's: it's a sheet)
    if (j < 6u && !cloth) {
      var IX = array<u32, 6>(0u, 2u, 1u, 0u, 3u, 2u);
      var u = e;
      if (shed) { u = array<vec2<f32>, 4>(e[0], e[1], c[1], c[0]); }
      wp = vec3<f32>(u[IX[j]], ez);
    } else { live = false; }
    o.nrm = vec3<f32>(0.0, 0.0, -1.0);
    o.uv = vec4<f32>(0.0);
    o.info.y = S_TRIM;
    o.info.z = I_ROOF | (face << 8u) | I_UNDER;
  }
  finish(&o, wp, live);
  return o;
}

@vertex
fn vsArchCren(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_CREN, ii) * PW;
  let w0 = AW(AW(2u) + b);
  let z0 = pf(b, 10u);
  let wallH = pf(b, 11u);
  let merH = pf(b, 12u);
  let merW = pf(b, 13u);
  let th = pf(b, 14u);
  o.info = pinfo(b, (w0 >> 8u) & 0xffu, F_NOWIN);
  o.zs = vec2<f32>(z0, z0);
  let box = vi / 30u;
  let j = vi % 30u;
  let edge = box / (CREN_M + 1u);
  let k = box % (CREN_M + 1u);
  let a = corner(b, edge);
  let e = corner(b, (edge + 1u) % 4u);
  let L = length(e - a);
  let d = (e - a) / max(L, 1e-4);
  let inw = vec2<f32>(-d.y, d.x);
  var s0 = 0.0;
  var s1 = L;
  var za = z0;
  var zb = z0 + wallH;
  var live = ii < AW(3u);
  if (k > 0u) {
    // merlons: every other gap of width merW, centred on the edge
    let nm = min(u32(floor((L / merW + 1.0) * 0.5)), CREN_M);
    let m = k - 1u;
    live = live && m < nm && nm >= 2u;
    let span = f32(2u * max(nm, 1u) - 1u) * merW;
    s0 = (L - span) * 0.5 + f32(2u * m) * merW;
    s1 = s0 + merW;
    za = zb;
    zb = zb + merH;
  }
  let p0 = a + d * s0;
  let p1 = a + d * s1;
  let q = array<vec2<f32>, 4>(p0, p1, p1 + inw * th, p0 + inw * th);
  let wp = boxVert(q, za, zb, j, &o);
  finish(&o, wp, live);
  return o;
}

@vertex
fn vsArchWin(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_WIN, ii) * PW;
  let w0 = AW(AW(2u) + b);
  let fl = (w0 >> 16u) & 0xffu;
  let a = corner(b, 0u);
  let a1 = corner(b, 1u);
  let W = length(a1 - a);
  let d = (a1 - a) / max(W, 1e-4);
  let z0 = pf(b, 10u);
  let H = pf(b, 11u);
  let f = pf(b, 12u);
  let bk = vi / 30u;
  let j = vi % 30u;
  let door = (fl & F_DOOR) != 0u;
  let dep = 0.13;
  // (the user: "the windows could use more variety in shape and the sills could use more variety and color") its
  // shape (0 square-headed, 1 round-headed, 2 segmental, 3 pointed two-light) and its dressing: the sill (0 stone,
  // 1 wood, 2 painted), the head (0 plain, 1 a keystone, 2 a hood, 3 a heavy lintel), a balcony (16)
  let shape = u32(pf(b, 13u) + 0.5);
  let wst = u32(pf(b, 14u) + 0.5);
  let sillK = wst & 3u;
  let headK = (wst >> 2u) & 3u;
  let bal = (wst & 16u) != 0u;
  var live = ii < AW(3u);
  var surf = S_FRAME;
  // box: u0 u1 v0 v1 w0 w1 (the wall's frame: along, out, up from the sill)
  var bx = vec4<f32>(0.0);
  var bz = vec2<f32>(0.0);
  switch bk {
    case 0u: { bx = vec4<f32>(-f, 0.0, 0.0, dep); bz = vec2<f32>(0.0, H); }
    case 1u: { bx = vec4<f32>(W, W + f, 0.0, dep); bz = vec2<f32>(0.0, H); }
    case 2u: {
      bx = vec4<f32>(-f - 0.05, W + f + 0.05, 0.0, dep + 0.04);
      bz = vec2<f32>(H, H + f + 0.05);
      if (!door && headK == 2u) { bx = vec4<f32>(-f - 0.2, W + f + 0.2, 0.0, dep + 0.18); bz = vec2<f32>(H + 0.02, H + f + 0.12); surf = S_STONE; }
      if (!door && headK == 3u) { bx = vec4<f32>(-f - 0.14, W + f + 0.14, 0.0, dep + 0.09); bz = vec2<f32>(H, H + f + 0.26); surf = S_STONE; }
    }
    case 3u: {
      if (door) { bx = vec4<f32>(-0.3, W + 0.3, 0.0, 0.55); bz = vec2<f32>(-0.28, 0.0); surf = S_STONE; }
      else if (sillK == 0u) { bx = vec4<f32>(-f - 0.13, W + f + 0.13, 0.0, dep + 0.15); bz = vec2<f32>(-0.15, 0.02); surf = S_STONE; }
      else if (sillK == 1u) { bx = vec4<f32>(-f - 0.05, W + f + 0.05, 0.0, dep + 0.09); bz = vec2<f32>(-0.07, 0.02); surf = S_WOOD; }
      else { bx = vec4<f32>(-f - 0.09, W + f + 0.09, 0.0, dep + 0.11); bz = vec2<f32>(-0.09, 0.02); }
    }
    case 4u: { bx = vec4<f32>(0.0, W, 0.0, 0.025); bz = vec2<f32>(0.0, H); surf = select(S_GLASS, S_DOOR, door); }
    case 5u: {
      live = live && !door;
      let mw = select(0.03, 0.06, shape == 3u);
      bx = vec4<f32>(W * 0.5 - mw, W * 0.5 + mw, 0.0, 0.06);
      bz = vec2<f32>(0.0, H);
    }
    case 6u: {
      live = live && !door;
      if (headK == 1u) {
        // a keystone over the head
        bx = vec4<f32>(W * 0.5 - 0.11, W * 0.5 + 0.11, 0.0, dep + 0.08);
        bz = vec2<f32>(H - 0.14, H + f + 0.16);
        surf = S_STONE;
      } else {
        // the transom: at the arch's springing on a round- or point-headed one
        var tz = H * 0.62;
        if (shape == 1u) { tz = H - W * 0.5; }
        if (shape == 3u) { tz = H - W * 0.87; }
        bx = vec4<f32>(0.0, W, 0.0, 0.06);
        bz = vec2<f32>(tz - 0.03, tz + 0.03);
      }
    }
    case 7u: { live = live && !door && (fl & F_SHUT) != 0u; bx = vec4<f32>(-f - W * 0.5 - 0.03, -f - 0.03, 0.0, 0.06); bz = vec2<f32>(0.0, H); surf = S_SHUTTER; }
    case 8u: { live = live && !door && (fl & F_SHUT) != 0u; bx = vec4<f32>(W + f + 0.03, W + f + W * 0.5 + 0.03, 0.0, 0.06); bz = vec2<f32>(0.0, H); surf = S_SHUTTER; }
    case 9u: {
      if (door) { live = live && (fl & F_CANOPY) != 0u; bx = vec4<f32>(-0.4, W + 0.4, 0.0, 0.75); bz = vec2<f32>(H + 0.3, H + 0.44); surf = S_WOOD; }
      else if (bal) { bx = vec4<f32>(-0.45, W + 0.45, 0.0, 0.85); bz = vec2<f32>(-0.18, 0.0); surf = S_STONE; }
      else { live = live && (fl & F_BOX) != 0u; bx = vec4<f32>(-0.06, W + 0.06, 0.05, 0.4); bz = vec2<f32>(-0.42, -0.1); surf = S_WOOD; }
    }
    default: {
      if (bal && !door) { bx = vec4<f32>(-0.45, W + 0.45, 0.77, 0.85); bz = vec2<f32>(0.0, 0.95); surf = select(S_WOOD, S_FRAME, sillK == 2u); }
      else { live = live && !door && (fl & F_BOX) != 0u; bx = vec4<f32>(0.0, W, 0.09, 0.36); bz = vec2<f32>(-0.12, 0.16); surf = S_FLOWER; }
    }
  }
  o.info = pinfo(b, surf, 0u);
  o.zs = vec2<f32>(z0, z0);
  let wp = wallBox(a, d, bx.x, bx.y, bx.z, bx.w, z0 + bz.x, z0 + bz.y, j, &o);
  // (the glass knows its window's shape: archSurface fills the head's spandrels with the frame)
  if (bk == 4u && !door) { o.info.z = o.info.z | (shape << 20u); }
  finish(&o, wp, live);
  return o;
}

@vertex
fn vsArchCyl(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_CYL, ii) * PW;
  let w0 = AW(AW(2u) + b);
  let c = corner(b, 0u);
  let r = corner(b, 1u).x;
  let z0 = pf(b, 10u);
  let z1 = pf(b, 11u);
  let N = ROUND_N;
  o.info = pinfo(b, (w0 >> 8u) & 0xffu, 0u);
  o.zs = vec2<f32>(z0, z0);
  var wp: vec3<f32>;
  let circ = 6.28318 * r;
  if (vi < N * 6u) {
    let seg = vi / 6u;
    var AL = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
    var UP = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
    let k = vi % 6u;
    let ang = 6.28318 * (f32(seg) + f32(AL[k])) / f32(N);
    let dir = vec2<f32>(cos(ang), sin(ang));
    wp = vec3<f32>(c + dir * r, select(z0, z1, UP[k] == 1u));
    let mid = 6.28318 * (f32(seg) + 0.5) / f32(N);
    o.nrm = vec3<f32>(cos(mid), sin(mid), 0.0);
    // (a segment is its own face: the painted bays across the round wall)
    o.uv = vec4<f32>((f32(seg) + f32(AL[k])) / f32(N) * circ, circ, wp.z - z0, z1 - z0);
  } else {
    let k = vi - N * 6u;
    let seg = k / 3u;
    let t = k % 3u;
    var ang = 6.28318 * (f32(seg) + select(0.0, 1.0, t == 1u)) / f32(N);
    wp = select(vec3<f32>(c + vec2<f32>(cos(ang), sin(ang)) * r, z1), vec3<f32>(c, z1), t == 2u);
    o.nrm = vec3<f32>(0.0, 0.0, 1.0);
    o.uv = vec4<f32>(wp.xy, 0.0, 0.0);
    o.info.z = o.info.z | I_TOP;
  }
  finish(&o, wp, ii < AW(3u));
  return o;
}

@vertex
fn vsArchCone(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_CONE, ii) * PW;
  let c = corner(b, 0u);
  let R = corner(b, 1u).x;
  let eave = pf(b, 10u);
  let apex = pf(b, 11u);
  let seed = pseed(b);
  let N = ROUND_N;
  o.info = pinfo(b, (AW(AW(2u) + b) >> 8u) & 0xffu, I_ROOF);
  o.zs = vec2<f32>(eave, apex);
  var wp = GONE;
  var live = ii < AW(3u);
  let PER = CONE_ROWS * 12u;
  if (vi < N * PER) {
    // a segment's courses: its foot the eave's chord, its head the apex
    let seg = vi / PER;
    let j = vi % PER;
    let a0 = 6.28318 * f32(seg) / f32(N);
    let a1 = 6.28318 * f32(seg + 1u) / f32(N);
    let B0 = c + vec2<f32>(cos(a0), sin(a0)) * R;
    let B1 = c + vec2<f32>(cos(a1), sin(a1)) * R;
    wp = courseVert(B0, B1, c, c, eave, apex, j / 12u, CONE_ROWS, j % 12u, 0.0, seed, &o);
    // (the along-course distance round the whole cone, so the tiles run on across the segments)
    o.uv.x = o.uv.x + f32(seg) * o.uv.y;
  } else {
    let k = vi - N * PER;
    if (k < N * 3u) {
      let seg = k / 3u;
      let t = k % 3u;
      let ang = 6.28318 * (f32(seg) + select(0.0, 1.0, t == 2u)) / f32(N);
      wp = select(vec3<f32>(c + vec2<f32>(cos(ang), sin(ang)) * R, eave), vec3<f32>(c, eave), t == 1u);
    } else { live = false; }
    o.nrm = vec3<f32>(0.0, 0.0, -1.0);
    o.uv = vec4<f32>(0.0);
    o.info.y = S_TRIM;
    o.info.z = I_ROOF | I_UNDER;
  }
  finish(&o, wp, live);
  return o;
}

@vertex
fn vsArchStair(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_STAIR, ii) * PW;
  let w0 = AW(AW(2u) + b);
  var c: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { c[k] = corner(b, k); }
  let z0 = pf(b, 10u);
  let z1 = pf(b, 11u);
  let n = clamp(u32(round((z1 - z0) / 0.24)), 2u, 16u);
  let i = vi / 30u;
  let j = vi % 30u;
  o.info = pinfo(b, (w0 >> 8u) & 0xffu, 0u);
  o.zs = vec2<f32>(z0, z0);
  let t0 = f32(i) / f32(n);
  let t1 = f32(i + 1u) / f32(n);
  let q = array<vec2<f32>, 4>(mix(c[0], c[3], t0), mix(c[1], c[2], t0), mix(c[1], c[2], t1), mix(c[0], c[3], t1));
  let wp = boxVert(q, z0, z0 + (z1 - z0) * t1, j, &o);
  finish(&o, wp, ii < AW(3u) && i < n);
  return o;
}

/** vertex j (0–35) of a box: centre c, half-extent vectors ax ay az (any orientation) */
fn obox(c: vec3<f32>, ax: vec3<f32>, ay: vec3<f32>, az: vec3<f32>, j: u32, o: ptr<function, VO>) -> vec3<f32> {
  let face = j / 6u;
  let t = j % 6u;
  var U = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0);
  var V = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let sgn = select(1.0, -1.0, (face & 1u) == 1u);
  var n = ax;
  var a = ay;
  var b = az;
  if (face >= 2u && face < 4u) { n = ay; a = az; b = ax; }
  if (face >= 4u) { n = az; a = ax; b = ay; }
  (*o).nrm = normalize(n * sgn);
  (*o).uv = vec4<f32>(U[t] * length(a), length(a) * 2.0, V[t] * length(b) + length(b), length(b) * 2.0);
  return c + n * sgn + a * U[t] + b * V[t];
}

@vertex
fn vsArchWheel(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_WHEEL, ii) * PW;
  let c2 = corner(b, 0u);
  let pd = normalize(corner(b, 1u));
  let axd = normalize(corner(b, 2u));
  let zc = pf(b, 10u);
  let R = pf(b, 11u);
  let wdt = pf(b, 12u);
  o.info = pinfo(b, S_WOOD, 0u);
  o.zs = vec2<f32>(zc - R, zc - R);
  let c = vec3<f32>(c2, zc);
  let P = vec3<f32>(pd, 0.0);
  let A = vec3<f32>(axd, 0.0);
  let Z = vec3<f32>(0.0, 0.0, 1.0);
  let N = 12u;
  let bx = vi / 36u;
  let j = vi % 36u;
  // turning slowly with the clock
  let spin = archTime() * 0.5;
  var wp: vec3<f32>;
  if (bx < 2u * N) {
    // two rims of N chords, one each side of the wheel
    let k = bx % N;
    let side = select(-1.0, 1.0, bx >= N);
    let a0 = 6.28318 * f32(k) / f32(N) + spin;
    let a1 = 6.28318 * f32(k + 1u) / f32(N) + spin;
    let m = (a0 + a1) * 0.5;
    let rad = P * cos(m) + Z * sin(m);
    let tan = -P * sin(m) + Z * cos(m);
    let half = R * sin((a1 - a0) * 0.5);
    wp = obox(c + rad * (R - 0.12) * cos((a1 - a0) * 0.5) + A * side * wdt * 0.5, tan * half, rad * 0.12, A * 0.07, j, &o);
  } else if (bx < 3u * N) {
    // paddles: radial boards across the wheel's width
    let k = bx - 2u * N;
    let m = 6.28318 * (f32(k) + 0.5) / f32(N) + spin;
    let rad = P * cos(m) + Z * sin(m);
    let tan = -P * sin(m) + Z * cos(m);
    wp = obox(c + rad * (R - 0.35), rad * 0.45, tan * 0.05, A * wdt * 0.55, j, &o);
  } else if (bx < 3u * N + 2u) {
    // spokes: two beams crossing
    let m = select(0.0, 1.5708, bx == 3u * N + 1u) + spin;
    let rad = P * cos(m) + Z * sin(m);
    let tan = -P * sin(m) + Z * cos(m);
    wp = obox(c, rad * R * 0.95, tan * 0.08, A * wdt * 0.35, j, &o);
  } else {
    // the axle
    wp = obox(c, P * 0.18, Z * 0.18, A * (wdt * 0.5 + 0.6), j, &o);
  }
  finish(&o, wp, ii < AW(3u));
  return o;
}

@vertex
fn vsArchBush(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let b = partOf(K_BUSH, ii) * PW;
  let c = corner(b, 0u);
  let z0 = pf(b, 10u);
  let r = pf(b, 11u);
  let h = pf(b, 12u);
  let seed = pseed(b);
  o.info = pinfo(b, S_LEAF, 0u);
  o.zs = vec2<f32>(z0, z0);
  // an octahedron's eight faces, each split in four: a lumpy ball, flat-shaded
  let f = vi / 12u;
  let tri = (vi % 12u) / 3u;
  let k = vi % 3u;
  let sx = select(1.0, -1.0, (f & 1u) != 0u);
  let sy = select(1.0, -1.0, (f & 2u) != 0u);
  let sz = select(1.0, -1.0, (f & 4u) != 0u);
  let v0 = vec3<f32>(sx, 0.0, 0.0);
  let v1 = vec3<f32>(0.0, sy, 0.0);
  let v2 = vec3<f32>(0.0, 0.0, sz);
  let m01 = normalize(v0 + v1);
  let m12 = normalize(v1 + v2);
  let m20 = normalize(v2 + v0);
  var T = array<vec3<f32>, 12>(v0, m01, m20, m01, v1, m12, m20, m12, v2, m01, m12, m20);
  var P3: array<vec3<f32>, 3>;
  for (var q = 0u; q < 3u; q++) {
    let d = T[tri * 3u + q];
    // lumps: each direction pushed out or in by its own hash
    let lump = 0.8 + 0.4 * rnd(seed, u32(dot(floor(d * 3.0 + 3.0), vec3<f32>(1.0, 7.0, 49.0))));
    let dd = vec3<f32>(d.xy * r, (d.z * 0.5 + 0.5) * h) * lump;
    P3[q] = vec3<f32>(c, z0 + 0.05) + dd;
  }
  var n = cross(P3[1] - P3[0], P3[2] - P3[0]);
  let mid = (P3[0] + P3[1] + P3[2]) / 3.0 - vec3<f32>(c, z0 + h * 0.5);
  if (dot(n, mid) < 0.0) { n = -n; }
  o.nrm = normalize(n);
  o.uv = vec4<f32>(P3[k].xy, P3[k].z - z0, h);
  let wp = P3[k];
  finish(&o, wp, ii < AW(3u));
  return o;
}

// ---- surfaces ------------------------------------------------------------------------------------------------------

fn h21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn avnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2<f32>(1.0, 0.0)), u.x), mix(h21(i + vec2<f32>(0.0, 1.0)), h21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
/** a soft box mask: 1 inside [lo, hi] (anti-aliased by w) */
fn box1(x: f32, lo: f32, hi: f32, w: f32) -> f32 { return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x)); }

/** stones in courses (rh tall, about bw long, each row's joints its own): a stone's shade with a bevelled look — lit
 *  on its top, shadowed at its foot, dark mortar between — or 1 where detail is off */
/** (bump) the surface's relief at this fragment in metres (0 its face, below it its joints): the patterns write it,
 *  the hosts tilt the normal by its screen derivatives (bumpN) */
var<private> gRelief: f32 = 0.0;
/** relief fades out where a pattern's joint is under a few pixels (it would only shimmer), and on the phone */
fn reliefFade(px: f32, size: f32) -> f32 { return (1.0 - smoothstep(size * 0.08, size * 0.25, px)) * archDetail(); }

/** n tilted by the relief h (a height in metres over the surface at p): bump mapping by screen derivatives (no
 *  tangents, no textures — Mikkelsen's surface gradient). Call in uniform control flow. */
fn bumpN(n: vec3<f32>, p: vec3<f32>, h: f32) -> vec3<f32> {
  let dpx = dpdx(p);
  let dpy = dpdy(p);
  let dhx = dpdx(h);
  let dhy = dpdy(h);
  let r1 = cross(dpy, n);
  let r2 = cross(n, dpx);
  let det = dot(dpx, r1);
  let g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - g);
}

/** joint k of a run of pieces of mean size w, each joint moved by its own hash (±0.4 w: sizes 0.2–1.8 w, never
 *  crossing) */
fn joint(k: f32, w: f32, key: f32) -> f32 { return (k + 0.8 * (h21(vec2<f32>(k, key)) - 0.5)) * w; }

/** (the user: "the stone pattern is a bit too regular") courses of their own heights, stones of their own lengths, each
 *  course's joints laid fresh: x the stone's shade (its bevel), y its mortar */
fn stones(u: f32, v: f32, bw: f32, rh: f32, px: f32, seed: f32, detail: f32) -> vec2<f32> {
  // the course: its joints below and above (rows of 0.6–1.4 the mean)
  var row = floor(v / rh);
  var r0 = (row + 0.4 * (h21(vec2<f32>(row, seed + 0.5)) - 0.5)) * rh;
  if (v < r0) { row -= 1.0; }
  r0 = (row + 0.4 * (h21(vec2<f32>(row, seed + 0.5)) - 0.5)) * rh;
  var r1 = (row + 1.0 + 0.4 * (h21(vec2<f32>(row + 1.0, seed + 0.5)) - 0.5)) * rh;
  if (v >= r1) {
    row += 1.0;
    r0 = r1;
    r1 = (row + 1.0 + 0.4 * (h21(vec2<f32>(row + 1.0, seed + 0.5)) - 0.5)) * rh;
  }
  let ch = r1 - r0;
  // the stone along the course: its joints (each course offset)
  let uu = u + h21(vec2<f32>(row, seed)) * bw * 3.0;
  let key = row * 7.3 + seed;
  var k = floor(uu / bw);
  if (uu < joint(k, bw, key)) { k -= 1.0; }
  if (uu >= joint(k + 1.0, bw, key)) { k += 1.0; }
  let c0 = joint(k, bw, key);
  let c1 = joint(k + 1.0, bw, key);
  let fu = (uu - c0) / (c1 - c0);
  let fv = (v - r0) / ch;
  let id = h21(vec2<f32>(k, row) + seed * 3.1);
  let m = min(min(uu - c0, c1 - uu), min(v - r0, r1 - v));
  // (the joint and the bevel in proportion to the stone: the user asked for bricks half the size, stone smaller still)
  let sz = min(bw, rh);
  let lw = min(0.028, 0.14 * sz);
  let mortar = 1.0 - smoothstep(lw - px, lw + px, m);
  // the bevel: the stone's top lit, its foot in shade, its edges rounded off
  let bev = 1.0 + 0.16 * (fv - 0.45) - 0.18 * (1.0 - smoothstep(0.0, 0.35 * sz, m - lw));
  let shade = mix(1.0, (0.82 + 0.34 * id) * bev, detail);
  // its relief: the joint sunk, the stone's edge rounded into it, each stone a little proud of the next or not
  let face = smoothstep(lw * 0.5, lw + 0.25 * sz, m);
  gRelief = (face * (0.018 + 0.012 * id) - 0.012) * reliefFade(px, min(bw, rh));
  return vec2<f32>(shade, mortar * detail);
}

fn styleV(s: u32, i: u32) -> vec4<f32> { return bitcast<vec4<f32>>(instances[(AW(0u) >> 2u) + s * SV + i]); }


// ---- (AG19) material textures: bind group 1 (textures.ts — 15 CC0 sets in two arrays; archTexU.x 1 once loaded) ----
@group(1) @binding(0) var archTexC: texture_2d_array<f32>;
@group(1) @binding(1) var archTexN: texture_2d_array<f32>;
@group(1) @binding(2) var archSamp: sampler;
@group(1) @binding(3) var<uniform> archTexU: vec4<f32>;
const TX_BRICK: i32 = 0;
const TX_RUBBLE: i32 = 1;
const TX_ASHLAR: i32 = 2;
const TX_PLASTER: i32 = 3;
const TX_SIDING: i32 = 4;
const TX_WOOD: i32 = 5;
const TX_DECK: i32 = 6;
const TX_TILE: i32 = 7;
const TX_SLATE: i32 = 8;
const TX_THATCH: i32 = 9;
const TX_FLAG: i32 = 10;
const TX_COBBLE: i32 = 11;
const TX_DIRT: i32 = 12;
const TX_GRASS: i32 = 13;
const TX_CANVAS: i32 = 14;
/** each set's mean colour (scripts/packtex.py): a tint moves it onto the style's colour */
fn txMean(l: i32) -> vec3<f32> {
  var m = array<vec3<f32>, 15>(vec3<f32>(0.58, 0.416, 0.325), vec3<f32>(0.494, 0.459, 0.384), vec3<f32>(0.647, 0.612, 0.478),
    vec3<f32>(0.843, 0.827, 0.816), vec3<f32>(0.294, 0.239, 0.192), vec3<f32>(0.482, 0.388, 0.306), vec3<f32>(0.353, 0.29, 0.22),
    vec3<f32>(0.392, 0.231, 0.153), vec3<f32>(0.275, 0.282, 0.267), vec3<f32>(0.329, 0.294, 0.251), vec3<f32>(0.478, 0.443, 0.349),
    vec3<f32>(0.533, 0.529, 0.498), vec3<f32>(0.294, 0.216, 0.176), vec3<f32>(0.333, 0.376, 0.169), vec3<f32>(0.451, 0.435, 0.369));
  return m[clamp(l, 0, 14)];
}

/** which set a fragment wears and where in it: layer (−1 none), texture coordinates (one repeat = 1), the colour to
 *  tint toward (most surfaces: the style's; the branches pass their own for walls, roofs, cloth), how much of the set's
 *  own colour stays (0 none … 1 all), and whether archSurface applies it after its branches (`post`) */
struct TexPick { layer: i32, tc: vec2<f32>, goal: vec3<f32>, keep: f32, post: bool };

fn texPick(in: VO) -> TexPick {
  var t: TexPick;
  t.layer = -1;
  t.tc = vec2<f32>(0.0);
  t.goal = vec3<f32>(1.0);
  t.keep = 0.0;
  t.post = true;
  let surf = in.info.y;
  let flags = in.info.z & 0xffu;
  let isTop = (in.info.z & I_TOP) != 0u;
  let isCourse = (in.info.z & I_COURSE) != 0u;
  let s = in.info.w & 0xffu;
  let lot = in.info.x;
  let part = in.info.w >> 24u;
  // (a part's own place in the set, so neighbours don't line up)
  let off = vec2<f32>(h21(vec2<f32>(f32(lot), f32(part) + 0.5)), h21(vec2<f32>(f32(part), f32(lot) + 5.5))) * 7.0;
  let wallUV = vec2<f32>(in.uv.x, -(in.wpos.z - archPlace().z));
  let wallC = styleV(s, 0u);
  let roofC = styleV(s, 2u);
  let stoneC = styleV(s, 3u);
  if ((surf == S_WALL || surf == S_TINT) && !isTop) {
    let m = u32(wallC.w + 0.5);
    t.post = false;
    if (m == 1u) { t.layer = TX_BRICK; t.tc = wallUV / 1.3; t.keep = 0.55; }
    else if (m == 2u) { t.layer = TX_ASHLAR; t.tc = wallUV / 2.0; t.keep = 0.3; }
    else if (m == 4u) { t.layer = TX_SIDING; t.tc = vec2<f32>(wallUV.y, wallUV.x) / 2.0; t.keep = 0.35; }
    else { t.layer = TX_PLASTER; t.tc = wallUV / 2.5; }
  } else if (surf == S_ROOF && isCourse) {
    let m = u32(roofC.w + 0.5);
    var mm = m;
    if (m == 3u && hash((in.info.w >> 24u) * 7u + lot) % 3u != 0u) { mm = 4u; }
    t.post = false;
    // (one row of the set's tiles a course: the drawn tiles sit on the courses' lips)
    let crow = (f32(u32(in.uv.w) % 8u) + 1.0 - in.uv.z) / 8.0;
    if (mm == 0u) { t.layer = TX_TILE; t.tc = vec2<f32>(in.uv.x / 2.4, crow); t.keep = 0.12; }
    else if (mm == 1u) { t.layer = TX_SLATE; t.tc = vec2<f32>(in.uv.x / 2.4, crow); t.keep = 0.2; }
    else if (mm == 2u) { t.layer = TX_THATCH; t.tc = vec2<f32>(in.uv.x / 2.0, (in.uv.w + 1.0 - in.uv.z) * 0.18); t.keep = 0.4; }
    else if (mm == 4u) { t.layer = TX_DECK; t.tc = vec2<f32>(in.uv.x, (in.uv.w + 1.0 - in.uv.z) * 0.4) / 1.4; t.keep = 0.7; }
    else { t.layer = TX_CANVAS; t.tc = vec2<f32>(in.uv.x, in.uv.w * 0.3 + in.uv.z * 0.3) / 1.5; }
  } else if ((surf == S_WALL || surf == S_STONE || surf == S_TINT) && isTop && (flags & F_UNDER) == 0u && (flags & F_NOWIN) == 0u) {
    // a flat roof's floor (archSurface's pick: 0 flagstones, 1 terracotta — procedural — 2 a deck)
    let fk = hash((in.info.w >> 24u) * 389u + lot * 17u);
    let pick = select(fk % 3u, 0u, surf != S_TINT);
    if (pick == 0u) { t.layer = TX_FLAG; t.tc = in.uv.xy / 2.2; t.goal = stoneC.rgb * 0.8; t.keep = 0.4; }
    else if (pick == 2u) { t.layer = TX_DECK; t.tc = in.uv.xy / 1.4; t.keep = 1.0; }
  } else if ((surf == S_PLINTH || surf == S_LOTWALL) && !isTop) {
    t.layer = TX_RUBBLE; t.tc = wallUV / 1.8; t.goal = stoneC.rgb; t.keep = 0.45;
  } else if (surf == S_STONE && !isTop) {
    t.layer = TX_ASHLAR; t.tc = wallUV / 2.0; t.goal = stoneC.rgb; t.keep = 0.35;
  } else if ((surf == S_CHIMNEY || surf == S_BRICK) && !isTop) {
    t.layer = TX_BRICK; t.tc = wallUV / 1.3; t.goal = vec3<f32>(0.62, 0.36, 0.27); t.keep = 0.7;
  } else if (surf == S_WOOD || surf == S_CRATE) {
    t.layer = TX_WOOD; t.tc = select(wallUV, in.uv.xy, isTop) / 1.0; t.keep = 1.0;
  } else if (surf == S_DOOR) {
    t.layer = TX_DECK; t.tc = wallUV / 1.4; t.goal = vec3<f32>(0.42, 0.26, 0.15); t.keep = 0.4;
  } else if (surf == S_PLANK) {
    t.layer = TX_DECK; t.tc = select(wallUV, in.uv.xy, isTop) / 1.6; t.goal = vec3<f32>(0.6, 0.47, 0.32); t.keep = 0.6;
  } else if (surf == S_CLOTH) {
    t.layer = TX_CANVAS; t.tc = vec2<f32>(in.uv.x, in.uv.z + in.uv.w * 0.3) / 1.5; t.goal = vec3<f32>(-1.0);
  } else if (surf == S_GROUND && isTop) {
    let k = (in.info.w >> 8u) & 0xffu;
    t.layer = TX_GRASS;
    if (k == 3u) { t.layer = TX_COBBLE; }
    if (k == 5u) { t.layer = TX_DIRT; }
    if (k == 4u) { t.layer = TX_FLAG; }
    t.tc = in.wpos.xy / 2.4;
    t.keep = 1.0;
  }
  t.tc += off;
  return t;
}

/** a set's colour moved onto `target` (by its mean), `keep` of its own colour left */
fn archTexCol(rgb: vec3<f32>, t: TexPick, goal: vec3<f32>) -> vec3<f32> {
  return rgb * mix(goal / max(txMean(t.layer), vec3<f32>(0.02)), vec3<f32>(1.0), t.keep);
}

struct Surf { col: vec3<f32>, glass: f32, ao: f32, h: f32, n: vec3<f32>, rough: f32 };

/** a lot's window frames: half the lots the style's trim, the rest a paint of their own */
fn frameColour(lot: u32, trim: vec3<f32>) -> vec3<f32> {
  let k = hash(lot * 2654435761u + 11u);
  if ((k & 1u) == 0u) { return trim; }
  var pal = array<vec3<f32>, 6>(vec3<f32>(0.3, 0.45, 0.36), vec3<f32>(0.28, 0.38, 0.55), vec3<f32>(0.55, 0.22, 0.2),
                                vec3<f32>(0.45, 0.32, 0.22), vec3<f32>(0.88, 0.82, 0.62), vec3<f32>(0.42, 0.5, 0.56));
  return pal[(k >> 1u) % 6u];
}

/** a window's glass outside its shaped head (info.z bits 20–22: 1 round, 2 segmental, 3 pointed) */
fn archedOut(in: VO) -> bool {
  let shape = (in.info.z >> 20u) & 7u;
  if (shape == 0u) { return false; }
  let W = in.uv.y;
  let H = in.uv.w;
  let p = vec2<f32>(in.uv.x, in.uv.z);
  if (shape == 1u) { return p.y > H - W * 0.5 && length(p - vec2<f32>(W * 0.5, H - W * 0.5)) > W * 0.5; }
  if (shape == 2u) {
    let s = W * 0.18;
    let R = (W * W * 0.25 + s * s) / (2.0 * s);
    return p.y > H - s && length(p - vec2<f32>(W * 0.5, H - R)) > R;
  }
  let cy = H - W * 0.87;
  return p.y > cy && (length(p - vec2<f32>(0.0, cy)) > W || length(p - vec2<f32>(W, cy)) > W);
}

/** a surface's colour (sRGB), its glass, its occlusion. Takes derivatives: call it in uniform control flow, before any discard. */
fn archSurface(in: VO) -> Surf {
  let lz = in.wpos.z - archPlace().z;
  let surf = in.info.y;
  let flags = in.info.z & 0xffu;
  let side = (in.info.z >> 8u) & 0xfu;
  let isTop = (in.info.z & I_TOP) != 0u;
  let isGable = (in.info.z & I_GABLE) != 0u;
  let isCourse = (in.info.z & I_COURSE) != 0u;
  let isLip = (in.info.z & I_LIP) != 0u;
  let s = in.info.w & 0xffu;
  let lot = in.info.x;
  let lr = h21(vec2<f32>(f32(lot), 3.7));
  // derivatives first (WGSL: before any branch that isn't uniform)
  let px = max(max(length(fwidth(in.uv.xz)), length(fwidth(in.uv.xy))), 1e-4);
  let detail = archDetail();
  // (AG19) the material's texture: picked, then sampled with its own gradients here (the branches below aren't uniform)
  let tp = texPick(in);
  let tdx = dpdx(tp.tc);
  let tdy = dpdy(tp.tc);
  let dpx = dpdx(in.wpos);
  let dpy = dpdy(in.wpos);
  let texOn = archTexU.x > 0.5 && tp.layer >= 0;
  let tl = max(tp.layer, 0);
  let tc0 = textureSampleGrad(archTexC, archSamp, tp.tc, tl, tdx, tdy);
  let tn0 = textureSampleGrad(archTexN, archSamp, tp.tc, tl, tdx, tdy);
  var nOut = normalize(in.nrm);
  var rough = 0.85;
  if (texOn) {
    // the normal map in a frame from the screen derivatives (no stored tangents); GL maps: green up the image
    let N = nOut;
    var nm = vec2<f32>(tn0.x * 2.0 - 1.0, -(tn0.y * 2.0 - 1.0)) * mix(0.6, 1.0, detail);
    let nz = sqrt(max(1.0 - dot(nm, nm), 0.0));
    let p2 = cross(dpy, N);
    let p1 = cross(N, dpx);
    let Tg = p2 * tdx.x + p1 * tdy.x;
    let Bg = p2 * tdx.y + p1 * tdy.y;
    let im = inverseSqrt(max(max(dot(Tg, Tg), dot(Bg, Bg)), 1e-20));
    nOut = normalize(Tg * im * nm.x + Bg * im * nm.y + N * nz);
    rough = tn0.z;
  }
  let wallC = styleV(s, 0u);
  let trimC = styleV(s, 1u);
  let roofC = styleV(s, 2u);
  let stoneC = styleV(s, 3u);
  let win = styleV(s, 7u);
  var col = wallC.rgb;
  var glass = 0.0;
  let u = in.uv.x;
  let v = in.uv.z;
  // the lot's own tint: neighbours differ a little (Tiny Glade's soft variety)
  let tint = 0.93 + 0.14 * lr;
  let stoneMortar = stoneC.rgb * 0.55;
  if ((surf == S_WALL || surf == S_TINT) && !isTop) {
    let m = u32(wallC.w + 0.5);
    col = wallC.rgb * tint;
    if (surf == S_TINT) {
      // a column's own colour: Townscaper's palette, by its part
      var pal = array<vec3<f32>, 8>(vec3<f32>(0.96, 0.84, 0.52), vec3<f32>(0.92, 0.55, 0.45), vec3<f32>(0.58, 0.76, 0.86),
                                    vec3<f32>(0.62, 0.8, 0.6), vec3<f32>(0.96, 0.95, 0.9), vec3<f32>(0.88, 0.62, 0.74),
                                    vec3<f32>(0.98, 0.7, 0.42), vec3<f32>(0.5, 0.62, 0.82));
      col = pal[hash((in.info.w >> 24u) * 131u + lot * 7u) % 8u];
    }
    // plaster's mottling, a little darker low down
    col *= 0.95 + 0.07 * avnoise(vec2<f32>(u, v) * 1.7) * detail + 0.03 * avnoise(vec2<f32>(u, v) * 0.4);
    if (texOn) {
      col = archTexCol(tc0.rgb, tp, col);
    } else if (m == 1u) {
      // brick
      let st = stones(u, v, 0.24, 0.095, px, 2.0, detail);
      col = mix(col * st.x, trimC.rgb * 0.95, st.y);
    } else if (m == 4u) {
      // planks: upright boards, each its own weathering, a patch or two nailed over
      let bw = 0.26;
      let bi = floor(u / bw);
      let seam = 1.0 - box1(fract(u / bw), 0.07, 0.93, px / bw);
      let tone = 0.75 + 0.4 * h21(vec2<f32>(bi, f32(lot)));
      col = wallC.rgb * mix(1.0, tone, detail);
      let patchM = box1(fract(u * 0.37 + lr), 0.0, 0.25, px) * box1(fract(v * 0.41 + lr * 1.7), 0.3, 0.55, px);
      col = mix(col, col * vec3<f32>(0.8, 0.85, 0.95), patchM * detail);
      col = mix(col, col * 0.45, seam * detail);
      gRelief = -seam * 0.012 * reliefFade(px, bw);
    } else if (m == 2u) {
      // ashlar
      let st = stones(u, v, 0.42, 0.2, px, 5.0, detail);
      col = mix(col * st.x, col * 0.55, st.y);
    }
    // painted windows: only where none are built (a round tower's bays, a gable's attic)
    let L = in.uv.y;
    let nb = baysOf(L, win.x);
    let bw = L / f32(nb);
    let bi = u32(floor(u / bw));
    let fu = u - (f32(bi) + 0.5) * bw;
    let hz = lz - in.zs.x;
    let st = u32(max(floor(hz / STOREY), 0.0));
    let fz = hz - f32(st) * STOREY;
    let ww = win.y * 0.5;
    var hole = 0.0;
    var frame = 0.0;
    var door = 0.0;
    if ((flags & F_NOWIN) == 0u && L > 1.2) {
      let isDoor = (flags & F_FRONT0) != 0u && side == 0u && st == 0u && bi == doorBayOf(lot, nb) && !isGable;
      var ok = select(0.0, 1.0, winFits(st, win.z, in.uv.w));
      if (isGable) {
        // a gable's attic window: only in the middle where the triangle is wide enough
        let half = 0.5 * L * (1.0 - (hz + 1.4) / max(in.uv.w, 0.01));
        ok = select(0.0, 1.0, abs(u - 0.5 * L) + ww * 0.7 + 0.2 < half && in.uv.w > 2.4);
      }
      if (isDoor) {
        // the door (the built one stands over it on the PC): planks in a frame, the style's size
        let dw = styleV(s, 6u).x * 0.5;
        let dh = styleV(s, 6u).w;
        door = box1(fu, -dw, dw, px) * box1(fz, 0.0, dh, px);
        frame = clamp(box1(fu, -dw - 0.12, dw + 0.12, px) * box1(fz, 0.0, dh + 0.14, px) - door, 0.0, 1.0);
      } else {
        let inWin = box1(fu, -ww, ww, px) * box1(fz, win.w, win.z, px);
        let inFrame = box1(fu, -ww - 0.1, ww + 0.1, px) * box1(fz, win.w - 0.14, win.z + 0.08, px);
        hole = inWin * ok;
        frame = clamp(inFrame * ok - hole, 0.0, 1.0);
        // shutters (the style's), a lot's own colour
        if (styleV(s, 6u).z > 0.5 && !isGable) {
          let sh = box1(abs(fu), ww + 0.12, ww + 0.12 + ww, px) * box1(fz, win.w, win.z, px) * ok;
          let pick = u32(lr * 4.0);
          var sc = vec3<f32>(0.36, 0.5, 0.42);
          if (pick == 1u) { sc = vec3<f32>(0.33, 0.43, 0.58); }
          if (pick == 2u) { sc = vec3<f32>(0.62, 0.3, 0.26); }
          if (pick == 3u) { sc = vec3<f32>(0.5, 0.42, 0.3); }
          col = mix(col, sc, sh);
        }
      }
      // (a frame's lower edge — the sill — a shade darker, so it reads at a few pixels)
      col = mix(col, trimC.rgb * select(1.0, 0.8, fz < win.w), frame);
      col = mix(col, vec3<f32>(0.42, 0.26, 0.15), door);
    }
    // half-timbering: posts at the bays' edges, a rail a storey, braces (the style's material 3)
    if (m == 3u && !isGable) {
      let tw = 0.12;
      let post = 1.0 - smoothstep(tw - px, tw + px, abs(fract(u / bw + 0.5) - 0.5) * bw);
      let rail = 1.0 - smoothstep(tw - px, tw + px, min(fz, STOREY - fz));
      let brace = 1.0 - smoothstep(tw - px, tw + px, abs(abs(fu) - (fz / STOREY) * bw * 0.5) * 0.7);
      let beam = max(max(post, rail), brace * (1.0 - box1(abs(fu), 0.0, ww + 0.25, px)) * 0.9);
      // (a beam's edge lit above, shadowed below: it reads as standing out of the plaster)
      col = mix(col, vec3<f32>(0.3, 0.2, 0.13), beam * (1.0 - max(max(hole, frame), door)));
    }
    col = mix(col, mix(vec3<f32>(0.14, 0.16, 0.2), vec3<f32>(1.0, 0.75, 0.38), archNight() * step(0.35, h21(vec2<f32>(f32(lot), f32(st))))), hole);
    glass = hole;
  } else if (surf == S_ROOF) {
    let m = u32(roofC.w + 0.5);
    col = roofC.rgb * (0.9 + 0.18 * lr);
    if (isCourse) {
      // a course of tiles (or slates): each its own shade, staggered course to course, gaps between, darker up under
      // the next course's lip; thatch: streaks
      let row = in.uv.w;
      let tw = select(0.44, 0.36, m == 1u);
      let tu = u / tw + row * 0.5;
      let ti = h21(vec2<f32>(floor(tu), row + f32(lot) * 0.01));
      let gap = 1.0 - smoothstep(0.035 - px / tw, 0.035 + px / tw, min(fract(tu), 1.0 - fract(tu)) * 1.0);
      var k = (0.82 + 0.3 * ti) * mix(0.78, 1.0, smoothstep(1.0, 0.25, v));
      // (a shanty's roofs are patchwork: each part planks or a tarp of cloth — the user: tin looked wrong for fantasy)
      var mm = m;
      if (m == 3u && hash((in.info.w >> 24u) * 7u + lot) % 3u != 0u) { mm = 4u; }
      if (mm == 2u) { k = (0.8 + 0.3 * avnoise(vec2<f32>(u * 8.0, row * 3.0 + v))) * mix(0.8, 1.0, smoothstep(1.0, 0.3, v)); }
      else if (mm == 3u) {
        // a tarp: faded canvas of one of a few dyes, broad stripes or none, patched
        let pk = hash((in.info.w >> 24u) * 977u + lot * 13u);
        var pal = array<vec3<f32>, 5>(vec3<f32>(0.62, 0.4, 0.33), vec3<f32>(0.45, 0.5, 0.55), vec3<f32>(0.7, 0.62, 0.44),
                                      vec3<f32>(0.5, 0.55, 0.42), vec3<f32>(0.76, 0.72, 0.62));
        col = pal[pk % 5u];
        let stripe = step(0.5, fract(u / 0.7)) * select(0.0, 1.0, (pk & 96u) == 96u);
        col = mix(col, vec3<f32>(0.82, 0.78, 0.68), stripe * 0.6);
        // (its sag is in the sheet's shape now — clothVert — only a weave's faint mottling here)
        k = 0.95 + 0.06 * avnoise(vec2<f32>(u * 2.0, row + v));
        let patchT = box1(fract(u * 0.29 + f32(pk & 15u) * 0.1), 0.0, 0.3, px) * box1(fract(row * 0.37 + v * 0.3), 0.2, 0.6, px);
        col = mix(col, vec3<f32>(0.62, 0.5, 0.36), patchT * 0.7);
      } else if (mm == 4u) {
        // planks down the slope
        k = 0.75 + 0.35 * h21(vec2<f32>(floor(u / 0.3), f32(lot)));
        col = vec3<f32>(0.55, 0.42, 0.3);
      }
      else {
        k = mix(k, k * 0.55, gap);
        gRelief = -gap * 0.015 * reliefFade(px, tw);
      }
      if (texOn) {
        col = archTexCol(tc0.rgb, tp, col);
        k = 1.0;
        gRelief = 0.0;
      }
      // (a few tiles mossed, more low on the roof)
      let moss = step(0.9, h21(vec2<f32>(floor(tu) * 1.7, row))) * 0.6;
      col = mix(col * mix(1.0, k, detail), vec3<f32>(0.42, 0.5, 0.3), moss * detail * 0.5);
      if (isLip) { col *= 0.58; }
    }
  } else if ((surf == S_WALL || surf == S_STONE || surf == S_TINT) && isTop && (flags & F_UNDER) != 0u) {
    // a wall's top under its roof: dark, so the seams between the courses at a hip never show it
    col = vec3<f32>(0.16, 0.13, 0.1);
  } else if ((surf == S_WALL || surf == S_STONE || surf == S_TINT) && isTop && (flags & F_NOWIN) == 0u) {
    // a flat roof: a floor of its own — flagstones (their own size), terracotta tiles, or a deck of planks
    let fk = hash((in.info.w >> 24u) * 389u + lot * 17u);
    let pick = fk % 3u;
    if (pick == 0u || surf != S_TINT) {
      let sc = 0.8 + 0.5 * f32((fk >> 4u) & 7u) / 7.0;
      let st = stones(in.uv.x, in.uv.y, 0.5 * sc, 0.36 * sc, px, 9.0 + f32(fk & 15u), detail);
      col = mix(stoneC.rgb * 0.75 * st.x, vec3<f32>(0.36, 0.4, 0.3), st.y);
    } else if (pick == 1u) {
      let st = stones(in.uv.x, in.uv.y, 0.24, 0.24, px, 4.0 + f32(fk & 15u), detail);
      col = mix(vec3<f32>(0.74, 0.44, 0.32) * st.x, vec3<f32>(0.78, 0.72, 0.62), st.y);
    } else {
      let bw = 0.22;
      let seam = 1.0 - box1(fract(in.uv.x / bw), 0.06, 0.94, px / bw);
      let tone = 0.82 + 0.3 * h21(vec2<f32>(floor(in.uv.x / bw), f32(fk & 255u)));
      // (the boards' ends staggered)
      let endJ = 1.0 - box1(fract(in.uv.y / 2.4 + h21(vec2<f32>(floor(in.uv.x / bw), 3.0))), 0.01, 0.99, px / 2.4);
      col = vec3<f32>(0.56, 0.4, 0.27) * mix(1.0, tone, detail);
      col = mix(col, col * 0.45, max(seam, endJ) * detail);
      gRelief = -max(seam, endJ) * 0.01 * reliefFade(px, bw);
    }
  } else if (surf == S_TRIM) {
    col = trimC.rgb;
    // (a cornice's top is under the roof: dark, so a seam between the courses never shows it)
    if (isTop) { col = vec3<f32>(0.18, 0.14, 0.11); }
    // the eaves' underside: the rafters' dark wood
    if ((in.info.z & I_UNDER) != 0u) { col = vec3<f32>(0.3, 0.22, 0.16); }
  } else if (surf == S_PLINTH || surf == S_STONE || surf == S_CHIMNEY || surf == S_LOTWALL) {
    col = stoneC.rgb * (0.92 + 0.12 * lr);
    if (!isTop) {
      // rubble for the plinths and the lot walls, coursed stone for the towers and chimneys
      let big = surf == S_PLINTH || surf == S_LOTWALL;
      let st = stones(u, v, select(0.32, 0.3, big), select(0.16, 0.14, big), px, select(1.0, 3.0, big), detail);
      col = mix(col * st.x, stoneMortar, st.y);
    } else {
      col *= 0.9;
      if (surf == S_LOTWALL) { col = mix(col, vec3<f32>(0.45, 0.55, 0.32), 0.35); }
    }
    if (surf == S_CHIMNEY && isTop) { col = vec3<f32>(0.12); }
  } else if (surf == S_FRAME) {
    col = frameColour(lot, trimC.rgb) * (0.95 + 0.1 * lr);
  } else if (surf == S_SHUTTER) {
    // a lot's shutters one of a few colours, slatted
    let pick = u32(lr * 4.0);
    var sc = vec3<f32>(0.36, 0.5, 0.42);
    if (pick == 1u) { sc = vec3<f32>(0.33, 0.43, 0.58); }
    if (pick == 2u) { sc = vec3<f32>(0.62, 0.3, 0.26); }
    if (pick == 3u) { sc = vec3<f32>(0.5, 0.42, 0.3); }
    col = sc * mix(1.0, 0.85 + 0.15 * step(0.5, fract(v * 6.0)), detail);
  } else if (surf == S_GLASS && archedOut(in)) {
    // the head's spandrels over a round, segmental or pointed light: the frame's
    col = frameColour(lot, trimC.rgb);
  } else if (surf == S_GLASS) {
    // small panes, leaded: dark, catching the sky toward their tops
    let pane = box1(fract(u * 4.0), 0.08, 0.92, px * 4.0) * box1(fract(v * 3.5), 0.08, 0.92, px * 3.5);
    col = mix(vec3<f32>(0.2, 0.18, 0.16), mix(vec3<f32>(0.14, 0.17, 0.22), vec3<f32>(0.32, 0.4, 0.48), clamp(v / max(in.uv.w, 0.1), 0.0, 1.0)), mix(1.0, pane, detail));
    col = mix(col, vec3<f32>(1.0, 0.76, 0.4), archNight() * step(0.4, lr));
    glass = 1.0;
  } else if (surf == S_FLOWER) {
    // a box of flowers: leaves and blooms in blobs
    let cell = floor(vec2<f32>(u * 7.0, v * 6.0 + in.wpos.z * 3.0));
    let hsh = h21(cell + f32(lot));
    var fc = vec3<f32>(0.3, 0.48, 0.22);
    if (hsh > 0.55) { fc = vec3<f32>(0.9, 0.42, 0.55); }
    if (hsh > 0.75) { fc = vec3<f32>(0.62, 0.42, 0.85); }
    if (hsh > 0.9) { fc = vec3<f32>(0.98, 0.85, 0.35); }
    col = fc;
  } else if (surf == S_DOOR) {
    let plank = 0.82 + 0.18 * step(0.5, fract(u * 5.0)) + 0.06 * h21(vec2<f32>(floor(u * 5.0), f32(lot)));
    col = vec3<f32>(0.42, 0.26, 0.15) * mix(1.0, plank, detail);
  } else if (surf == S_WOOD) {
    let plank = 0.85 + 0.15 * h21(vec2<f32>(floor(v * 6.0 + u * 0.3), f32(lot)));
    col = vec3<f32>(0.5, 0.35, 0.22) * mix(1.0, plank, detail);
  } else if (surf == S_CLOTH) {
    // canvas: broad stripes of the part's two colours, a little sag-shaded
    let pk = hash((in.info.w >> 24u) * 977u + lot * 13u);
    var c0 = vec3<f32>(0.92, 0.88, 0.78);
    var pal = array<vec3<f32>, 6>(vec3<f32>(0.78, 0.3, 0.28), vec3<f32>(0.3, 0.5, 0.72), vec3<f32>(0.85, 0.65, 0.25),
                                  vec3<f32>(0.4, 0.62, 0.42), vec3<f32>(0.6, 0.38, 0.62), vec3<f32>(0.85, 0.5, 0.35));
    let c1 = pal[pk % 6u];
    let stripe = step(0.5, fract(u / 0.55));
    col = mix(c1, c0, stripe * select(1.0, 0.0, (pk & 64u) != 0u));
    col *= 0.9 + 0.1 * avnoise(vec2<f32>(u * 2.0, v * 2.0));
    if (isLip) { col *= 0.7; }
  } else if (surf == S_CRATE) {
    // a crate: planks, a darker frame round its faces
    let edge = min(min(u, in.uv.y - u), min(v, in.uv.w - v));
    col = vec3<f32>(0.62, 0.46, 0.28) * (0.85 + 0.15 * step(0.5, fract(v * 5.0)));
    col = mix(vec3<f32>(0.38, 0.27, 0.16), col, smoothstep(0.06, 0.1, edge));
    if (isTop) { col = vec3<f32>(0.6, 0.45, 0.28); }
  } else if (surf == S_GOODS) {
    // goods heaped on a counter: fruit, cloth, pots in blobs of colour
    let cell = floor(in.wpos.xy * 5.0 + in.wpos.z * 3.0);
    let hsh = h21(cell + f32(lot) * 0.37);
    var gc = vec3<f32>(0.85, 0.35, 0.25);
    if (hsh > 0.25) { gc = vec3<f32>(0.95, 0.75, 0.3); }
    if (hsh > 0.5) { gc = vec3<f32>(0.45, 0.65, 0.3); }
    if (hsh > 0.75) { gc = vec3<f32>(0.62, 0.4, 0.68); }
    col = gc;
  } else if (surf == S_WATER) {
    col = vec3<f32>(0.32, 0.52, 0.6) + 0.06 * avnoise(in.wpos.xy * 2.0 + archTime() * 0.6);
    glass = 0.6;
  } else if (surf == S_PLANK) {
    // a deck: boards along it, their ends staggered, weathered
    let bw = 0.32;
    let bi = floor(in.wpos.y / bw + in.wpos.x * 0.0);
    let p2 = select(in.uv.xy, vec2<f32>(u, v), !isTop);
    let board = floor(p2.y / bw);
    let seam = 1.0 - box1(fract(p2.y / bw), 0.06, 0.94, px / bw);
    let tone = 0.82 + 0.25 * h21(vec2<f32>(board, floor(p2.x / 2.4 + board * 0.37)));
    col = vec3<f32>(0.6, 0.47, 0.32) * mix(1.0, tone, detail);
    col = mix(col, col * 0.5, seam * detail);
  } else if (surf == S_LEAF) {
    // leaves: greens in clumps, lighter on top; a flowering shrub's blooms
    let cell = floor(in.wpos * 4.0);
    let hsh = h21(cell.xy + cell.z * 7.0);
    col = mix(vec3<f32>(0.24, 0.42, 0.2), vec3<f32>(0.42, 0.62, 0.28), clamp(0.3 + 0.5 * in.nrm.z + 0.3 * (hsh - 0.5), 0.0, 1.0));
    if ((flags & F_BLOOM) != 0u && hsh > 0.72) {
      col = select(vec3<f32>(0.95, 0.55, 0.7), vec3<f32>(0.98, 0.92, 0.6), h21(vec2<f32>(f32(lot), 2.0)) > 0.5);
    }
  } else if (surf == S_BRICK) {
    col = vec3<f32>(0.66, 0.36, 0.26) * (0.92 + 0.12 * lr);
    if (!isTop) {
      let st = stones(u, v, 0.24, 0.095, px, 2.0, detail);
      col = mix(col * st.x, vec3<f32>(0.75, 0.7, 0.62), st.y);
      // soot near the top
      col *= mix(1.0, 0.45, smoothstep(in.uv.w - 3.0, in.uv.w, v));
    } else { col = vec3<f32>(0.08); }
  } else if (surf == S_GROUND) {
    // the lab's parcels by kind: building plot, park, plaza, landmark, field
    let k = (in.info.w >> 8u) & 0xffu;
    var g = vec3<f32>(0.62, 0.6, 0.55);
    if (k == 2u) { g = vec3<f32>(0.47, 0.62, 0.32); }
    if (k == 3u) { g = vec3<f32>(0.72, 0.68, 0.6); }
    if (k == 5u) { g = vec3<f32>(0.6, 0.55, 0.32); }
    if (k == 1u) { g = vec3<f32>(0.52, 0.64, 0.36); }
    col = g * (0.95 + 0.1 * avnoise(in.wpos.xy * 0.7));
    if (!isTop) { col = vec3<f32>(0.45, 0.4, 0.34); }
  }
  // (AG19) the other textured surfaces: the set tinted to the style's colour (cloth: to its own stripes)
  if (texOn && tp.post) {
    col = archTexCol(tc0.rgb, tp, select(tp.goal, col, tp.goal.x < 0.0));
    gRelief = 0.0;
  }
  // ivy: on some lots, up their walls from the ground in uneven tongues (not over glass)
  if (!isTop && (surf == S_WALL || surf == S_TINT || surf == S_STONE || surf == S_PLINTH || surf == S_LOTWALL || surf == S_BRICK) && h21(vec2<f32>(f32(lot), 5.5)) > 0.55) {
    let g = bitcast<f32>(AW(AW(6u) + min(lot, AW(5u) - 1u)));
    let hg = lz - g;
    let reach = 0.6 + 4.0 * avnoise(vec2<f32>(u * 0.3 + f32(side) * 3.7 + f32(lot) * 1.31, 0.5)) * avnoise(vec2<f32>(u * 0.11 + f32(lot), 2.5));
    let edge = reach + 0.5 * (avnoise(vec2<f32>(u * 3.0, hg * 3.0)) - 0.5);
    let leaves = (1.0 - smoothstep(edge - 0.15, edge + 0.15, hg)) * (1.0 - glass);
    let lc = mix(vec3<f32>(0.2, 0.36, 0.16), vec3<f32>(0.38, 0.55, 0.24), avnoise(vec2<f32>(u * 6.0, hg * 6.0)));
    col = mix(col, lc, leaves * mix(0.85, 0.85 * step(0.35, avnoise(vec2<f32>(u * 9.0, hg * 9.0))) + 0.15, detail));
  }
  var ao = 1.0;
  if (!isTop && surf != S_GROUND && !isCourse) { ao = mix(0.6, 1.0, smoothstep(0.0, 1.6, lz - in.zs.y + 0.6)); }
  if (surf == S_TRIM && in.nrm.z < -0.5) { ao = 0.5; }
  return Surf(col, glass, ao, gRelief, nOut, rough);
}
