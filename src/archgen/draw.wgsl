// (archgen) Drawing the parts: a kind's instanced draw, its vertex shader building the shape from vertex_index
// (vsBody: 30 vertices, four sides and the top; vsRoof: 24, two slopes, two ends, the eaves' underside); the fragment
// shader paints the surface from the lot's style: plaster, half-timber, brick, ashlar; tiles, slate, thatch; painted
// windows fitted to each wall's bays and a door on the street side. Prepended: arch.wgsl's constants (not its
// bindings — draw.wgsl is compiled with the constants block only: archgen.ts CONSTS).

struct View {
  viewProj: mat4x4<f32>,
  /** xyz towards the sun, w its strength */
  sun: vec4<f32>,
  /** xyz the view direction (towards the camera), w world units a pixel */
  eye: vec4<f32>,
  /** x time, y night (0–1), z detail (0 phone … 1 PC), w the list room a kind */
  p: vec4<f32>,
};

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> P: array<u32>;
@group(0) @binding(2) var<storage, read> L: array<u32>;
@group(0) @binding(3) var<storage, read> S: array<vec4<f32>>;

struct VO {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  // lot, surface, flags | side << 8 | roof << 12, tag (style | storeys << 8 | …)
  @location(2) @interpolate(flat) info: vec4<u32>,
  // x along the face's edge from its start, y the edge's length, z height above the face's base, w the face's height
  @location(3) uv: vec4<f32>,
  // x the part's base z, y the part's ground (for the plinth's damp, the windows' storeys)
  @location(4) @interpolate(flat) zs: vec2<f32>,
};

fn pf(o: u32, w: u32) -> f32 { return bitcast<f32>(P[o + w]); }
fn corner(o: u32, k: u32) -> vec2<f32> { return vec2<f32>(pf(o, 2u + k * 2u), pf(o, 3u + k * 2u)); }

fn partOf(kind: u32, ii: u32) -> u32 {
  let room = u32(V.p.w);
  return L[kind * room + ii];
}

fn finish(o: ptr<function, VO>, wp: vec3<f32>) {
  (*o).wpos = wp;
  (*o).pos = V.viewProj * vec4<f32>(wp, 1.0);
}

@vertex
fn vsBody(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let pi = partOf(K_BODY, ii);
  let b = pi * PW;
  let w0 = P[b];
  let z0 = pf(b, 10u);
  let face = vi / 6u;
  let t = vi % 6u;
  var c: array<vec2<f32>, 4>;
  var zt: array<f32, 4>;
  for (var k = 0u; k < 4u; k++) { c[k] = corner(b, k); zt[k] = pf(b, 11u + k); }
  var wp: vec3<f32>;
  o.info = vec4<u32>(P[b + 1u], (w0 >> 8u) & 0xffu, ((w0 >> 16u) & 0xffu) | (face << 8u), P[b + 15u]);
  o.zs = vec2<f32>(z0, z0);
  if (face < 4u) {
    let a = c[face];
    let e = c[(face + 1u) % 4u];
    let za = zt[face];
    let ze = zt[(face + 1u) % 4u];
    // (a,0) (e,0) (e,1) / (a,0) (e,1) (a,1)
    var AL = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
    var UP = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
    let along = AL[t];
    let up = UP[t];
    let p = select(a, e, along == 1u);
    let zt1 = select(za, ze, along == 1u);
    wp = vec3<f32>(p, select(z0, zt1, up == 1u));
    let d = e - a;
    o.nrm = normalize(vec3<f32>(d.y, -d.x, 0.0));
    let len = length(d);
    o.uv = vec4<f32>(f32(along) * len, len, wp.z - z0, max(za, ze) - z0);
  } else {
    var IX = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    let idx = IX[t];
    wp = vec3<f32>(c[idx], zt[idx]);
    let p0 = vec3<f32>(c[0], zt[0]);
    let n = cross(vec3<f32>(c[1], zt[1]) - p0, vec3<f32>(c[2], zt[2]) - p0);
    o.nrm = normalize(select(n, -n, n.z < 0.0));
    o.uv = vec4<f32>(wp.xy, 0.0, 0.0);
    o.info.z = o.info.z | 0x1000u;
  }
  if (ii >= u32(V.p.w)) { wp = vec3<f32>(0.0, 0.0, -1e6); }
  finish(&o, wp);
  return o;
}

@vertex
fn vsRoof(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let pi = partOf(K_ROOF, ii);
  let b = pi * PW;
  let w0 = P[b];
  let eave = pf(b, 10u);
  let ridgeZ = pf(b, 11u);
  let inset = pf(b, 12u);
  let axis = u32(pf(b, 13u) + 0.5);
  let over = pf(b, 14u);
  var c: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { c[k] = corner(b, (k + axis) % 4u); }
  // the ridge parallel to c0 → c1: from the middle of edge 3–0 to the middle of edge 1–2, pulled in by the inset
  let m30 = (c[3] + c[0]) * 0.5;
  let m12 = (c[1] + c[2]) * 0.5;
  var r0 = mix(m30, m12, inset);
  var r1 = mix(m12, m30, inset);
  let span = max(length(c[0] - m30) + length(c[1] - m12), 0.2) * 0.5;
  let slope = (ridgeZ - eave) / span;
  // the eaves: each corner out along its bisector; the slopes dropped so their planes hold
  var e: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) {
    let pv = c[(k + 3u) % 4u];
    let nx = c[(k + 1u) % 4u];
    let n0 = normalize(vec2<f32>((c[k] - pv).y, -(c[k] - pv).x));
    let n1 = normalize(vec2<f32>((nx - c[k]).y, -(nx - c[k]).x));
    e[k] = c[k] + (n0 + n1) * over;
  }
  let gable = inset < 0.02;
  let ax = normalize(r1 - r0);
  var R0 = r0;
  var R1 = r1;
  if (gable) { R0 = r0 - ax * over; R1 = r1 + ax * over; }
  let ez = eave - over * slope;
  let face = vi / 6u;
  let t = vi % 6u;
  var wp: vec3<f32>;
  o.info = vec4<u32>(P[b + 1u], S_ROOF, 0x2000u | (face << 8u), P[b + 15u]);
  o.zs = vec2<f32>(eave, ridgeZ);
  if (face < 2u) {
    // slope 0: e0 e1 R1 R0; slope 1: e2 e3 R0 R1
    var q = array<vec3<f32>, 4>(vec3<f32>(e[0], ez), vec3<f32>(e[1], ez), vec3<f32>(R1, ridgeZ), vec3<f32>(R0, ridgeZ));
    if (face == 1u) { q = array<vec3<f32>, 4>(vec3<f32>(e[2], ez), vec3<f32>(e[3], ez), vec3<f32>(R0, ridgeZ), vec3<f32>(R1, ridgeZ)); }
    var IX = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    let idx = IX[t];
    wp = q[idx];
    var n = cross(q[1] - q[0], q[3] - q[0]);
    n = select(n, -n, n.z < 0.0);
    o.nrm = normalize(n);
    // u along the eave, v up the slope
    let ed = normalize(q[1].xy - q[0].xy);
    let up = normalize(vec2<f32>(ed.y, -ed.x));
    o.uv = vec4<f32>(dot(wp.xy - q[0].xy, ed), length(q[1].xy - q[0].xy), dot(wp.xy - q[0].xy, -up) * sqrt(1.0 + slope * slope), 0.0);
  } else if (face < 4u) {
    // the ends: a gable's wall (c3 c0 r0 / c1 c2 r1) or a hip's slope (e3 e0 R0 / e1 e2 R1)
    let k = select(1u, 3u, face == 2u);
    let p0 = select(c[k], e[k], !gable);
    let p1 = select(c[(k + 1u) % 4u], e[(k + 1u) % 4u], !gable);
    let rr = select(R1, R0, face == 2u);
    let rp = select(select(r1, r0, face == 2u), rr, !gable);
    let zb = select(eave, ez, !gable);
    var tri = array<vec3<f32>, 3>(vec3<f32>(p0, zb), vec3<f32>(p1, zb), vec3<f32>(rp, ridgeZ));
    wp = tri[min(t, 2u)];
    if (t >= 3u) { wp = tri[2]; }
    var n = cross(tri[1] - tri[0], tri[2] - tri[0]);
    n = select(n, -n, dot(n.xy, p0 - (r0 + r1) * 0.5) < 0.0 && gable);
    n = select(n, -n, n.z < -0.01 && !gable);
    o.nrm = normalize(n);
    let ed = p1 - p0;
    o.uv = vec4<f32>(dot(wp.xy - p0, normalize(ed)), length(ed), wp.z - zb, ridgeZ - zb);
    if (gable) {
      o.info.y = S_WALL;
      o.info.z = (face << 8u) | 0x4000u;
      o.zs = vec2<f32>(eave, eave);
    }
  } else {
    // the underside of the eaves
    var IX = array<u32, 6>(0u, 2u, 1u, 0u, 3u, 2u);
    let idx = IX[t];
    wp = vec3<f32>(e[idx], ez);
    o.nrm = vec3<f32>(0.0, 0.0, -1.0);
    o.uv = vec4<f32>(0.0);
    o.info.y = S_TRIM;
    o.info.z = 0x2000u | (face << 8u) | 0x8000u;
  }
  if (ii >= u32(V.p.w)) { wp = vec3<f32>(0.0, 0.0, -1e6); }
  finish(&o, wp);
  return o;
}

// ---- surfaces ------------------------------------------------------------------------------------------------------

fn h21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2<f32>(1.0, 0.0)), u.x), mix(h21(i + vec2<f32>(0.0, 1.0)), h21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
/** a soft box mask: 1 inside [lo, hi] (anti-aliased by w) */
fn box1(x: f32, lo: f32, hi: f32, w: f32) -> f32 { return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x)); }
/** grout lines of a running bond: rows of height rh, bricks of width bw, line width lw → 0 on a line, 1 off */
fn bond(u: f32, v: f32, bw: f32, rh: f32, lw: f32, aa: f32) -> f32 {
  let row = floor(v / rh);
  let uu = u / bw + select(0.0, 0.5, (row % 2.0) > 0.5);
  let fu = abs(fract(uu) - 0.5) * bw;
  let fv = abs(fract(v / rh) - 0.5) * rh;
  let m = min(bw * 0.5 - fu, rh * 0.5 - fv);
  return smoothstep(lw - aa, lw + aa, m);
}

struct Mat { col: vec3<f32>, glass: f32 };

fn styleV(s: u32, i: u32) -> vec4<f32> { return S[s * SV + i]; }

@fragment
fn fsArch(in: VO) -> @location(0) vec4<f32> {
  let surf = in.info.y;
  let flags = in.info.z & 0xffu;
  let side = (in.info.z >> 8u) & 0xfu;
  let isTop = (in.info.z & 0x1000u) != 0u;
  let isRoof = (in.info.z & 0x2000u) != 0u;
  let s = in.info.w & 0xffu;
  let lot = in.info.x;
  let lr = h21(vec2<f32>(f32(lot), 3.7));
  // derivatives first (WGSL: before any branch that isn't uniform)
  let px = max(length(fwidth(in.uv.xz)), 1e-4);
  let pxw = length(fwidth(in.wpos));
  let detail = V.p.z;
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
  let tint = 0.92 + 0.16 * lr;
  if (surf == S_WALL && !isTop) {
    let m = u32(wallC.w + 0.5);
    col = wallC.rgb * tint;
    // plaster's mottling
    col *= 0.94 + 0.08 * vnoise(vec2<f32>(u, v) * 1.7) * detail + 0.03 * vnoise(vec2<f32>(u, v) * 0.4);
    if (m == 1u) {
      // brick: courses, mortar a shade lighter
      let g = bond(u, v, 0.5, 0.2, 0.018, px);
      col = mix(trimC.rgb * 1.05, col * (0.9 + 0.2 * h21(floor(vec2<f32>(u / 0.5 + floor(v / 0.2) * 0.5, v / 0.2)))), mix(1.0, g, detail));
    } else if (m == 2u) {
      // ashlar
      let g = bond(u, v, 1.1, 0.55, 0.03, px);
      col = mix(col * 0.75, col * (0.9 + 0.18 * h21(floor(vec2<f32>(u / 1.1 + floor(v / 0.55) * 0.5, v / 0.55)))), g);
    }
    // windows and doors: bays fitted to the wall's length, a window a storey
    let L = in.uv.y;
    let bayW = win.x;
    let nb = max(1.0, round(L / bayW));
    let bw = L / nb;
    let bi = floor(u / bw);
    let fu = u - (bi + 0.5) * bw; // from the bay's middle
    let hz = in.wpos.z - in.zs.x; // above the part's base
    let st = floor(hz / STOREY);
    let fz = hz - st * STOREY;
    let ww = win.y * 0.5;
    let isFront = (flags & F_FRONT0) != 0u && side == 0u;
    let ground = in.uv.z <= STOREY && (in.info.z & 0x4000u) == 0u;
    let doorBay = floor(nb * 0.5 + 0.5 * h21(vec2<f32>(f32(lot), 9.1)) * select(0.0, 1.0, nb > 2.0));
    var hole = 0.0;
    var frame = 0.0;
    let room = in.uv.w - hz; // wall left above
    if ((flags & F_NOWIN) == 0u && L > 1.2) {
      if (isFront && ground && bi == min(doorBay, nb - 1.0) && hz < 2.3) {
        // the door
        let dw = 0.55;
        hole = box1(fu, -dw, dw, px) * box1(hz, 0.0, 2.1, px);
        frame = box1(fu, -dw - 0.12, dw + 0.12, px) * box1(hz, 0.0, 2.25, px) - hole;
        col = mix(col, trimC.rgb * 0.9, clamp(frame, 0.0, 1.0));
        let plank = 0.85 + 0.15 * step(0.5, fract((fu + 1.0) * 4.0));
        col = mix(col, vec3<f32>(0.36, 0.22, 0.13) * plank, hole);
        hole = 0.0;
      } else if (room > 0.6 || (in.info.z & 0x4000u) != 0u) {
        let wlo = win.w;
        let whi = win.z;
        let inWin = box1(fu, -ww, ww, px) * box1(fz, wlo, whi, px);
        let inFrame = box1(fu, -ww - 0.1, ww + 0.1, px) * box1(fz, wlo - 0.14, whi + 0.08, px);
        // a gable's attic window: only where the triangle is wide enough
        var ok = 1.0;
        if ((in.info.z & 0x4000u) != 0u) {
          let half = 0.5 * L * (1.0 - hz / max(in.uv.w, 0.01));
          ok = select(0.0, 1.0, abs(u - 0.5 * L) + ww + 0.3 < half && nb >= 1.0) * select(0.0, 1.0, bi == floor(nb * 0.5));
        }
        hole = inWin * ok;
        frame = clamp(inFrame * ok - hole, 0.0, 1.0);
        col = mix(col, trimC.rgb, frame);
        // shutters on the homes (the style's win.y > 0.5 marks wide-set windows)
        let shut = box1(abs(fu), ww + 0.12, ww + 0.45, px) * box1(fz, wlo, whi, px) * ok * step(0.5, styleV(s, 6u).z);
        col = mix(col, styleV(s, 6u).z * vec3<f32>(0.25, 0.42, 0.38) + (1.0 - styleV(s, 6u).z) * col, shut);
        // mullions
        let mull = (1.0 - box1(abs(fu), 0.0, 0.03, px)) * (1.0 - box1(abs(fz - (wlo + whi) * 0.5), 0.0, 0.03, px));
        hole *= mix(1.0, mull, detail);
        frame = max(frame, 0.0);
      }
    }
    // half-timbering: posts at the bays' edges, a rail a storey, braces (the style's material 3)
    if (m == 3u && (in.info.z & 0x4000u) == 0u) {
      let tw = 0.11;
      let post = 1.0 - smoothstep(tw - px, tw + px, abs(fract(u / bw + 0.5) - 0.5) * bw);
      let rail = 1.0 - smoothstep(tw - px, tw + px, min(fz, STOREY - fz));
      let brace = 1.0 - smoothstep(tw - px, tw + px, abs(abs(fu) - (fz / STOREY) * bw * 0.5) * 0.7);
      let beam = max(max(post, rail), brace * (1.0 - box1(abs(fu), 0.0, ww + 0.25, px)) * 0.9);
      col = mix(col, vec3<f32>(0.26, 0.17, 0.11), beam * (1.0 - max(hole, frame)));
    }
    col = mix(col, mix(vec3<f32>(0.12, 0.14, 0.18), vec3<f32>(1.0, 0.75, 0.38), V.p.y * step(0.35, h21(vec2<f32>(f32(lot), st)))), hole);
    glass = hole;
  } else if (surf == S_ROOF || (isRoof && surf != S_WALL && surf != S_TRIM)) {
    let m = u32(roofC.w + 0.5);
    col = roofC.rgb * (0.9 + 0.2 * lr);
    if (m == 0u) {
      // clay tiles: rows, staggered, each a shade apart
      let rh = 0.32;
      let row = floor(v / rh);
      let tu = u / 0.42 + row * 0.5;
      let tv = fract(v / rh);
      let ti = h21(vec2<f32>(floor(tu), row));
      col *= mix(1.0, (0.86 + 0.24 * ti) * (0.75 + 0.25 * smoothstep(0.0, 0.5, tv)), detail);
    } else if (m == 1u) {
      // slate: small, blue-grey, a fine edge
      let g = bond(u, v, 0.36, 0.22, 0.012, px);
      col *= mix(1.0, (0.88 + 0.2 * h21(floor(vec2<f32>(u / 0.36, v / 0.22)))) * mix(0.7, 1.0, g), detail);
    } else {
      // thatch: streaks down the slope
      col *= 0.82 + 0.3 * vnoise(vec2<f32>(u * 9.0, v * 0.8)) * detail;
    }
    // the roof's edge: a light rim reads as the covering's thickness (Tiny Glade's chunky roofs)
    let edge = min(v, min(u, in.uv.y - u));
    col = mix(col * 1.25 + 0.04, col, smoothstep(0.05, 0.12, edge));
    // moss low on the slopes of the worn (later: the condition)
  } else if (surf == S_TRIM) {
    col = trimC.rgb;
    // the eaves' underside: the rafters' dark wood
    if ((in.info.z & 0x8000u) != 0u) { col = vec3<f32>(0.3, 0.22, 0.16); }
  } else if (surf == S_PLINTH || surf == S_STONE || surf == S_CHIMNEY) {
    col = stoneC.rgb * (0.9 + 0.15 * lr);
    let g = bond(u, v, 0.9, 0.45, 0.03, px);
    if (!isTop) { col = mix(col * 0.7, col * (0.9 + 0.2 * h21(floor(vec2<f32>(u / 0.9 + floor(v / 0.45) * 0.5, v / 0.45)))), mix(1.0, g, detail)); }
    if (surf == S_CHIMNEY) { col = mix(col, vec3<f32>(0.2), smoothstep(0.6, 0.0, in.uv.w - in.uv.z) * 0.6); }
    if (surf == S_STONE && !isTop) {
      // the keep's arrow slits a storey
      let st = floor(in.uv.z / STOREY);
      let fz = in.uv.z - st * STOREY;
      let slit = box1(abs(u - in.uv.y * 0.5), 0.0, 0.09, px) * box1(fz, 1.0, 2.1, px) * step(1.0, in.uv.z) * step(2.0, in.uv.y);
      col = mix(col, vec3<f32>(0.08, 0.08, 0.1), slit * step(0.6, in.uv.w - in.uv.z));
    }
  } else if (surf == S_GROUND) {
    // the lab's parcels by kind: building plot, park, plaza, landmark, field
    let k = (in.info.w >> 8u) & 0xffu;
    var g = vec3<f32>(0.62, 0.6, 0.55);
    if (k == 2u) { g = vec3<f32>(0.47, 0.62, 0.32); }
    if (k == 3u) { g = vec3<f32>(0.72, 0.68, 0.6); }
    if (k == 5u) { g = vec3<f32>(0.6, 0.55, 0.32); }
    if (k == 1u) { g = vec3<f32>(0.5, 0.62, 0.36); }
    col = g * (0.95 + 0.1 * vnoise(in.wpos.xy * 0.7));
    if (!isTop) { col = vec3<f32>(0.45, 0.4, 0.34); }
  }
  // light: a warm sun with wrap, a cool sky, bounce from the ground; a soft darkening at a wall's foot (ambient
  // occlusion's look) and under the eaves
  let n = normalize(in.nrm);
  let sunC = vec3<f32>(1.0, 0.93, 0.8) * V.sun.w;
  let ndl = dot(n, normalize(V.sun.xyz));
  let diff = max(ndl * 0.85 + 0.15, 0.0);
  let sky = mix(vec3<f32>(0.42, 0.40, 0.38), vec3<f32>(0.55, 0.65, 0.8), n.z * 0.5 + 0.5);
  var ao = 1.0;
  if (!isTop && surf != S_GROUND) { ao = mix(0.62, 1.0, smoothstep(0.0, 1.6, in.wpos.z - in.zs.y + 0.6)); }
  if (surf == S_TRIM && n.z < -0.5) { ao = 0.5; }
  var lit = col * (sunC * diff + sky * 0.55) * ao;
  // glass: a sky reflection
  lit = mix(lit, lit + vec3<f32>(0.1, 0.13, 0.16) * (1.0 - V.p.y), glass * 0.6);
  // a little aerial haze
  return vec4<f32>(pow(lit, vec3<f32>(1.0 / 1.1)), 1.0);
}
