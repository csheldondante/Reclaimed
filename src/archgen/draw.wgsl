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
  return vec4<u32>(AW(AW(2u) + b + 1u), surf, ((w0 >> 16u) & 0xffu) | bits, AW(AW(2u) + b + 15u));
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
    let p0 = vec3<f32>(c[0], zt[0]);
    let n = cross(vec3<f32>(c[1], zt[1]) - p0, vec3<f32>(c[2], zt[2]) - p0);
    o.nrm = normalize(select(n, -n, n.z < 0.0));
    o.uv = vec4<f32>(wp.xy, 0.0, 0.0);
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
  o.info = pinfo(b, S_ROOF, I_ROOF | (face << 8u));
  o.zs = vec2<f32>(eave, ridgeZ);
  if (face < 2u) {
    if (face == 1u && shed) {
      live = false;
    } else {
      var B0 = e[0];
      var B1 = e[1];
      var T0 = R0;
      var T1 = R1;
      if (face == 1u) { B0 = e[2]; B1 = e[3]; T0 = R1; T1 = R0; }
      wp = courseVert(B0, B1, T0, T1, ez, rz, j / 12u, COURSES, j % 12u, sag, seed, &o);
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
      o.info.y = S_WALL;
      o.info.z = (face << 8u) | I_GABLE;
      o.zs = vec2<f32>(eave, eave);
    } else {
      // a hip's end: courses narrowing to the ridge's end
      let k = select(1u, 3u, face == 2u);
      let T = select(R1, R0, face == 2u);
      wp = courseVert(e[k], e[(k + 1u) % 4u], T, T, ez, rz, j / 12u, COURSES, j % 12u, 0.0, seed + 7u, &o);
    }
  } else {
    // the underside of the eaves
    if (j < 6u) {
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
  var live = ii < AW(3u);
  var surf = S_FRAME;
  // box: u0 u1 v0 v1 w0 w1 (the wall's frame: along, out, up from the sill)
  var bx = vec4<f32>(0.0);
  var bz = vec2<f32>(0.0);
  switch bk {
    case 0u: { bx = vec4<f32>(-f, 0.0, 0.0, dep); bz = vec2<f32>(0.0, H); }
    case 1u: { bx = vec4<f32>(W, W + f, 0.0, dep); bz = vec2<f32>(0.0, H); }
    case 2u: { bx = vec4<f32>(-f - 0.05, W + f + 0.05, 0.0, dep + 0.04); bz = vec2<f32>(H, H + f + 0.05); }
    case 3u: {
      if (door) { bx = vec4<f32>(-0.3, W + 0.3, 0.0, 0.55); bz = vec2<f32>(-0.28, 0.0); surf = S_STONE; }
      else { bx = vec4<f32>(-f - 0.09, W + f + 0.09, 0.0, dep + 0.11); bz = vec2<f32>(-0.09, 0.02); }
    }
    case 4u: { bx = vec4<f32>(0.0, W, 0.0, 0.025); bz = vec2<f32>(0.0, H); surf = select(S_GLASS, S_DOOR, door); }
    case 5u: { live = live && !door; bx = vec4<f32>(W * 0.5 - 0.03, W * 0.5 + 0.03, 0.0, 0.06); bz = vec2<f32>(0.0, H); }
    case 6u: { live = live && !door; bx = vec4<f32>(0.0, W, 0.0, 0.06); bz = vec2<f32>(H * 0.62 - 0.03, H * 0.62 + 0.03); }
    case 7u: { live = live && !door && (fl & F_SHUT) != 0u; bx = vec4<f32>(-f - W * 0.5 - 0.03, -f - 0.03, 0.0, 0.06); bz = vec2<f32>(0.0, H); surf = S_SHUTTER; }
    case 8u: { live = live && !door && (fl & F_SHUT) != 0u; bx = vec4<f32>(W + f + 0.03, W + f + W * 0.5 + 0.03, 0.0, 0.06); bz = vec2<f32>(0.0, H); surf = S_SHUTTER; }
    case 9u: {
      if (door) { live = live && (fl & F_CANOPY) != 0u; bx = vec4<f32>(-0.4, W + 0.4, 0.0, 0.75); bz = vec2<f32>(H + 0.3, H + 0.44); surf = S_WOOD; }
      else { live = live && (fl & F_BOX) != 0u; bx = vec4<f32>(-0.06, W + 0.06, 0.05, 0.4); bz = vec2<f32>(-0.42, -0.1); surf = S_WOOD; }
    }
    default: { live = live && !door && (fl & F_BOX) != 0u; bx = vec4<f32>(0.0, W, 0.09, 0.36); bz = vec2<f32>(-0.12, 0.16); surf = S_FLOWER; }
  }
  o.info = pinfo(b, surf, 0u);
  o.zs = vec2<f32>(z0, z0);
  let wp = wallBox(a, d, bx.x, bx.y, bx.z, bx.w, z0 + bz.x, z0 + bz.y, j, &o);
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
  o.info = pinfo(b, S_ROOF, I_ROOF);
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
fn stones(u: f32, v: f32, bw: f32, rh: f32, px: f32, seed: f32, detail: f32) -> vec2<f32> {
  let row = floor(v / rh);
  let off = h21(vec2<f32>(row, seed)) * bw;
  let uu = (u + off) / bw;
  // (each stone a little longer or shorter: the joint moved by its own hash)
  let col0 = floor(uu);
  let jit = (h21(vec2<f32>(col0, row + seed)) - 0.5) * 0.5;
  let col = floor(uu - jit);
  let fu = fract(uu - jit);
  let fv = fract(v / rh);
  let id = h21(vec2<f32>(col, row) + seed * 3.1);
  let m = min(min(fu, 1.0 - fu) * bw, min(fv, 1.0 - fv) * rh);
  let lw = 0.028;
  let mortar = 1.0 - smoothstep(lw - px, lw + px, m);
  // the bevel: the stone's top lit, its foot in shade, its edges rounded off
  let bev = 1.0 + 0.16 * (fv - 0.45) - 0.18 * (1.0 - smoothstep(0.0, 0.07, m - lw));
  let shade = mix(1.0, (0.84 + 0.3 * id) * bev, detail);
  return vec2<f32>(shade, mortar * detail);
}

fn styleV(s: u32, i: u32) -> vec4<f32> { return bitcast<vec4<f32>>(instances[(AW(0u) >> 2u) + s * SV + i]); }

struct Surf { col: vec3<f32>, glass: f32, ao: f32 };

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
  if (surf == S_WALL && !isTop) {
    let m = u32(wallC.w + 0.5);
    col = wallC.rgb * tint;
    // plaster's mottling, a little darker low down
    col *= 0.95 + 0.07 * avnoise(vec2<f32>(u, v) * 1.7) * detail + 0.03 * avnoise(vec2<f32>(u, v) * 0.4);
    if (m == 1u) {
      // brick
      let st = stones(u, v, 0.48, 0.19, px, 2.0, detail);
      col = mix(col * st.x, trimC.rgb * 0.95, st.y);
    } else if (m == 2u) {
      // ashlar
      let st = stones(u, v, 0.95, 0.45, px, 5.0, detail);
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
        // the door (the built one stands over it on the PC): planks in a frame
        let dw = 0.55;
        door = box1(fu, -dw, dw, px) * box1(fz, 0.0, 2.1, px);
        frame = clamp(box1(fu, -dw - 0.12, dw + 0.12, px) * box1(fz, 0.0, 2.24, px) - door, 0.0, 1.0);
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
      if (m == 2u) { k = (0.8 + 0.3 * avnoise(vec2<f32>(u * 8.0, row * 3.0 + v))) * mix(0.8, 1.0, smoothstep(1.0, 0.3, v)); }
      else { k = mix(k, k * 0.55, gap); }
      // (a few tiles mossed, more low on the roof)
      let moss = step(0.9, h21(vec2<f32>(floor(tu) * 1.7, row))) * 0.6;
      col = mix(col * mix(1.0, k, detail), vec3<f32>(0.42, 0.5, 0.3), moss * detail * 0.5);
      if (isLip) { col *= 0.58; }
    }
  } else if ((surf == S_WALL || surf == S_STONE) && isTop && (flags & F_UNDER) != 0u) {
    // a wall's top under its roof: dark, so the seams between the courses at a hip never show it
    col = vec3<f32>(0.16, 0.13, 0.1);
  } else if ((surf == S_WALL || surf == S_STONE) && isTop && (flags & F_NOWIN) == 0u) {
    // a flat roof: flagstones
    let st = stones(in.uv.x, in.uv.y, 1.1, 0.9, px, 9.0, detail);
    col = mix(stoneC.rgb * 0.7 * st.x, vec3<f32>(0.36, 0.4, 0.3), st.y);
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
      let st = stones(u, v, select(0.7, 0.62, big), select(0.36, 0.3, big), px, select(1.0, 3.0, big), detail);
      col = mix(col * st.x, stoneMortar, st.y);
    } else {
      col *= 0.9;
      if (surf == S_LOTWALL) { col = mix(col, vec3<f32>(0.45, 0.55, 0.32), 0.35); }
    }
    if (surf == S_CHIMNEY && isTop) { col = vec3<f32>(0.12); }
  } else if (surf == S_FRAME) {
    col = trimC.rgb * (0.95 + 0.1 * lr);
  } else if (surf == S_SHUTTER) {
    // a lot's shutters one of a few colours, slatted
    let pick = u32(lr * 4.0);
    var sc = vec3<f32>(0.36, 0.5, 0.42);
    if (pick == 1u) { sc = vec3<f32>(0.33, 0.43, 0.58); }
    if (pick == 2u) { sc = vec3<f32>(0.62, 0.3, 0.26); }
    if (pick == 3u) { sc = vec3<f32>(0.5, 0.42, 0.3); }
    col = sc * mix(1.0, 0.85 + 0.15 * step(0.5, fract(v * 6.0)), detail);
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
  var ao = 1.0;
  if (!isTop && surf != S_GROUND && !isCourse) { ao = mix(0.6, 1.0, smoothstep(0.0, 1.6, lz - in.zs.y + 0.6)); }
  if (surf == S_TRIM && in.nrm.z < -0.5) { ao = 0.5; }
  return Surf(col, glass, ao);
}
