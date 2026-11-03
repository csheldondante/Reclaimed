// ---- interiors (branch `interiors`; src/interiors/draw.ts; Renderer.addLitDraw) -----------------------------------
// Appended to render.wgsl. A building's inside drawn in its place in the world (the same world space as its outside,
// which the structures veil): the triangle list src/interiors/mesh.ts builds, after a header of IH vec4s, in the draw
// group's binding 3 (`instances`). The look: the Rain World mood — a dark ambient, the sun only where it comes in at the
// windows (the shadow map: the building's outside still casts, its glass doesn't), a cool daylight off each window's
// opening, warm local lights (candles, the hearth: render.wgsl localLight), dust in the shafts of sun.
//
// Header (draw.ts writes it each frame; u32 words, floats as bits):
//   h0  storeys, shown storey, the cut's height (world z: the shown storey's ceiling), the assembly (0..1)
//   h1  floors' z 0-3, h2 floors' z 4-7
//   h3  the cut walls' stub height (m), ambient strength, night (0..1), windows
//   h4  ambient colour (linear), the shafts' strength
//   h8+ windows (WMAX), three a window: centre xyz, half width | outward xy, half height, its storey | the sun's way in
//       across the room to the far wall (m, draw.ts: the storey's floor walked from the window along −sun)

const IH: u32 = 64u;
const WMAX: u32 = 18u;
const M_PLASTER: u32 = 0u;
const M_PLANKS: u32 = 1u;
const M_FLAGS: u32 = 2u;
const M_TIMBER: u32 = 3u;
const M_VOXEL: u32 = 4u;
const M_CLOTH: u32 = 5u;
const M_FLAME: u32 = 6u;
const K_FLOOR: u32 = 0u;
const K_WALL: u32 = 1u;
const K_PROP: u32 = 2u;
const K_TRIM: u32 = 4u;

fn ih(i: u32) -> vec4<f32> { return bitcast<vec4<f32>>(instances[i]); }
fn floorZ(s: u32) -> f32 {
  let v = ih(1u + s / 4u);
  return v[s % 4u];
}

struct IVOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  @location(2) @interpolate(flat) col: u32,
  @location(3) @interpolate(flat) info: u32,
};

fn ivert(vi: u32) -> IVOut {
  let a = instances[IH + vi * 2u];
  let b = instances[IH + vi * 2u + 1u];
  var o: IVOut;
  o.wpos = bitcast<vec3<f32>>(a.xyz);
  o.nrm = bitcast<vec3<f32>>(b.xyz);
  o.col = a.w;
  o.info = b.w;
  return o;
}

@vertex
fn vsInterior(@builtin(vertex_index) vi: u32) -> IVOut {
  var o = ivert(vi);
  let h0 = ih(0u);
  let storey = o.info & 15u;
  let shown = u32(h0.y);
  // (the storeys over the shown one aren't drawn; the one under it only through the stair's hole)
  if (storey > shown || storey + 1u < shown) {
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  o.pos = CAM.viewProj * vec4<f32>(o.wpos, 1.0);
  return o;
}

@vertex
fn vsInteriorShadow(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let o = ivert(vi);
  // (every storey casts: the floors upstairs keep the sun off the rooms under them)
  return CAM.viewProj * vec4<f32>(o.wpos, 1.0);
}

fn ihash(p: vec3<f32>) -> f32 { return randv(vec3<i32>(floor(p))); }

/** a surface's pattern by its material (linear albedo in, out) */
fn interiorAlbedo(mat: u32, base: vec3<f32>, p: vec3<f32>, n: vec3<f32>, floorz: f32) -> vec3<f32> {
  var c = base;
  if (mat == M_PLANKS) {
    // boards along x, each its own shade, dark joints, a nail now and then
    let along = select(p.y, p.x, abs(n.z) > 0.5);
    let bw = 0.22;
    let row = floor(p.y / bw);
    let fv = fract(p.y / bw);
    let seg = floor(p.x / 1.6 + row * 0.37);
    let joint = 1.0 - smoothstep(0.0, 0.08, min(fv, 1.0 - fv));
    let endj = 1.0 - smoothstep(0.0, 0.02, abs(fract(p.x / 1.6 + row * 0.37) - 0.5) - 0.48);
    c *= (0.78 + 0.34 * randv(vec3<i32>(i32(row), i32(seg), 7))) * (1.0 - 0.55 * max(joint, endj));
    c *= 0.92 + 0.12 * vnoise(vec2<f32>(along * 6.0, row));
  } else if (mat == M_FLAGS) {
    // stone flags: big irregular slabs, worn lighter in the middle of the room
    let q = p.xy * 1.6 + vec2<f32>(vnoise(p.xy * 1.3), vnoise(p.yx * 1.3)) * 0.35;
    let cell = floor(q);
    let f = fract(q);
    let e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    c *= (0.8 + 0.3 * randv(vec3<i32>(i32(cell.x), i32(cell.y), 3))) * (1.0 - 0.6 * (1.0 - smoothstep(0.02, 0.06, e)));
  } else if (mat == M_PLASTER) {
    // limewash over the wall: blotchy, grimy low down, cracked here and there; bare stone where it fell off
    let up = p.z - floorz;
    c *= 0.86 + 0.18 * vnoise(p.xy * 1.7 + vec2<f32>(p.z * 1.3, 0.0)) + 0.05 * vnoise(p.xy * 9.0 + p.z * 7.0);
    c = mix(c * 0.55, c, smoothstep(0.0, 1.1, up));
    let bare = smoothstep(0.62, 0.7, vnoise(p.xy * 0.9 + vec2<f32>(p.z * 0.8, 3.0)));
    if (bare > 0.0) {
      let along = p.x + p.y;
      let r = floor(p.z / 0.3);
      let bk = floor(along / 0.5 + r * 0.5);
      let fu = fract(along / 0.5 + r * 0.5);
      let fz = fract(p.z / 0.3);
      let mortar = 1.0 - smoothstep(0.0, 0.07, min(min(fu, 1.0 - fu), min(fz, 1.0 - fz)));
      let stone = vec3<f32>(0.2, 0.19, 0.17) * (0.8 + 0.4 * randv(vec3<i32>(i32(bk), i32(r), 11))) * (1.0 - 0.5 * mortar);
      c = mix(c, stone, bare);
    }
  } else if (mat == M_TIMBER) {
    c *= 0.82 + 0.2 * vnoise(vec2<f32>((p.x + p.y) * 2.0, p.z * 14.0));
  } else if (mat == M_CLOTH) {
    c *= 0.9 + 0.12 * vnoise(p.xy * 30.0 + p.z * 20.0);
  } else if (mat == M_VOXEL) {
    // (a voxel prop: each sixteenth-cell voxel a hair its own shade — the pixel art's texture)
    c *= 0.9 + 0.16 * randv(vec3<i32>(floor(p * 16.0 - n * 0.01)));
  }
  return c;
}

/** the cool daylight in off the windows: each opening a soft light from outside (stronger by day, faint at night) */
fn windowLight(p: vec3<f32>, n: vec3<f32>, storey: u32) -> vec3<f32> {
  let h3 = ih(3u);
  let nw = min(u32(h3.w), WMAX);
  var acc = 0.0;
  for (var i = 0u; i < nw; i++) {
    let a = ih(8u + i * 3u);
    let b = ih(8u + i * 3u + 1u);
    if (u32(b.w) != storey) { continue; }
    // from the window's middle, a little inside, to the point
    let w = vec3<f32>(a.xy - b.xy * 0.2, a.z);
    let d = w - p;
    let r = length(d);
    let l = d / max(r, 1e-3);
    // (only the room's side of the window: light comes in, toward -outward)
    let inside = clamp(dot(-l, vec3<f32>(-b.xy, 0.0)) * 1.5 + 0.2, 0.0, 1.0);
    let facing = clamp(dot(n, l) * 0.8 + 0.2, 0.0, 1.0);
    acc += a.w * b.z * 4.0 * facing * inside / (1.0 + r * r * 0.9);
  }
  let night = h3.z;
  let day = mix(G.sky.rgb * 1.6 + vec3<f32>(0.05), vec3<f32>(0.05, 0.07, 0.12), night);
  return day * acc;
}

@fragment
fn fsInterior(in: IVOut) -> FOut {
  let h0 = ih(0u);
  let h3 = ih(3u);
  let storey = in.info & 15u;
  let kind = (in.info >> 4u) & 15u;
  let shown = u32(h0.y);
  let floorz = floorZ(storey);
  let px = in.pos.xy;
  // (a cut wall's stub: its share of being in front — the silhouette's dark — and the cut's edge, a light rim)
  var front = 0.0;
  var rim = 0.0;
  // the storey's cut: nothing over its ceiling; the storey under it only its flight (seen up through the hole)
  if (in.wpos.z > h0.z) { discard; }
  if (storey < shown && (kind != 3u || in.wpos.z < floorZ(shown) - 0.5)) { discard; }
  // the storey under: only what's seen down the stair's hole (under the shown floor anyway)
  // walls between the eye and the room: cut down to a stub (a dithered edge), so the room shows
  if ((in.info & 65536u) != 0u && storey == shown) {
    let ang = f32((in.info >> 8u) & 255u) / 256.0 * 6.2831853;
    let out = vec2<f32>(cos(ang), sin(ang));
    let e = normalize(CAM.eye.xy);
    // (a partition hides the room behind it from either side)
    var facing = dot(out, e);
    // (a partition: always down to a stub a little higher — the rooms read from above, none hides another)
    var stubH = h3.x;
    if ((in.info & 131072u) != 0u) { facing = 1.0; stubH = h3.x + 0.35; }
    let up = in.wpos.z - floorz;
    let stub = stubH;
    // (a wall facing the eye: its top over the stub goes; one side-on fades in between)
    let cut = smoothstep(0.05, 0.35, facing);
    let edge = stub + (1.0 - cut) * 6.0;
    // (a clean cut, as a dollhouse's: no dither on the edge — the cap below closes it)
    if (cut > 0.0 && up > edge) { discard; }
    front = cut * select(1.0, 0.0, (in.info & 131072u) != 0u);
    rim = cut * (1.0 - smoothstep(0.0, 0.07, edge - up));
  }
  // the assembly: each object comes in by its own share of the dither as the interior assembles
  let objId = in.info >> 18u;
  let order = f32(pcg(objId * 2654435761u) & 1023u) / 1023.0;
  if (h0.w < 0.999 && order * 0.7 + bayer4(px) * 0.3 > h0.w) { discard; }

  let mat = (in.col >> 24u) & 255u;
  let base = toLinear(vec3<f32>(f32((in.col >> 16u) & 255u), f32((in.col >> 8u) & 255u), f32(in.col & 255u)) / 255.0);
  var n = normalize(in.nrm);
  var alb = interiorAlbedo(mat, base, in.wpos, n, floorz);
  // (a wall's inside seen down through its cut — the slice's or a stub's: drawn as its solid top, the cap)
  // (seen from behind: its outward normal away from the eye)
  if (dot(n, toEye(in.wpos)) < -0.02 && (kind == K_WALL || kind == K_TRIM)) {
    n = vec3<f32>(0.0, 0.0, 1.0);
    alb = toLinear(vec3<f32>(0.36, 0.32, 0.27));
    rim = 0.0;
  }
  // the sun through the windows (the shadow map: the outside still casts), the cool light off the openings, a dark
  // ambient (the Rain World mood), the warm local lights
  let sun = sunDir();
  let ndl = max(dot(n, sun), 0.0);
  let lit = shadowLit(in.wpos, n);
  let amb = vec3<f32>(ih(4u).xyz) * h3.y * (0.6 + 0.4 * n.z);
  // (the sun's patch warm and strong: the room's brightest thing by day)
  var light = amb + G.sunCol.rgb * vec3<f32>(1.15, 0.98, 0.78) * ndl * lit * 2.2 + windowLight(in.wpos, n, storey) * 0.65 + localLight(in.wpos, n);
  var col = alb * light;
  // (the walls in front of the room: dark silhouettes against its light, their cut edge a thin lit line)
  col = mix(col, col * 0.22 + vec3<f32>(0.004, 0.004, 0.008), front * 0.85);
  col = mix(col, vec3<f32>(0.42, 0.36, 0.28) * (0.35 + 0.65 * (1.0 - h3.z)), rim * 0.9);
  if (mat == M_FLAME) { col = vec3<f32>(1.6, 0.8, 0.3) * (0.85 + 0.15 * sin(G.time * 17.0 + in.wpos.x * 40.0)); }
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  let bc = clampCell(cellAt(in.wpos.xy));
  o.pick = vec2<u32>(winIdx(bc) + 1u, pickInfo(MAT_STONE, in.wpos.z, 0u));
  _ = kind;
  return o;
}

// ---- the sun's shafts: each window's opening pushed into the room along the sun's way, drawn added (one + one) with
// dust in it; where the sun doesn't reach the window (another house, the hill) the shadow map takes the shaft away

struct ShaftOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  // the point on the shaft's middle line beside this one, and how far along it (0 the window .. 1 its end)
  @location(1) core: vec3<f32>,
  @location(2) t: f32,
  @location(3) @interpolate(flat) strength: f32,
};

const SHAFT_LEN: f32 = 7.0;

@vertex
fn vsShaft(@builtin(vertex_index) vi: u32) -> ShaftOut {
  var o: ShaftOut;
  let w = vi / 36u;
  let k = vi % 36u;
  let h0 = ih(0u);
  let a = ih(8u + w * 3u);
  let b = ih(8u + w * 3u + 1u);
  let reach = ih(8u + w * 3u + 2u).x;
  let sun = sunDir();
  let out = vec3<f32>(b.xy, 0.0);
  // (the sun must be up and on the window's side; the window on the shown storey)
  let facing = dot(sun, out);
  if (u32(b.w) != u32(h0.y) || sun.z < 0.03 || facing < 0.05) {
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  // the window's four corners (in the wall's plane: along it, up), then pushed in along the sun's rays (-sun)
  let along = vec3<f32>(-b.y, b.x, 0.0);
  let c0 = vec3<f32>(a.xy - b.xy * 0.18, a.z);
  // (the shaft's length: down to the floor or SHAFT_LEN)
  let floorz = floorZ(u32(b.w));
  // (down to the floor, or across to the far wall — horizontally `reach`)
  let hor = max(length(sun.xy), 1e-3);
  let len = min(SHAFT_LEN, min(max(0.5, (a.z + b.z - floorz) / max(sun.z, 0.05)), reach / hor));
  // a box: 8 corners (window side 0-3, far side 4-7), 12 triangles
  let cs = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let idx = array<u32, 36>(0u, 1u, 2u, 0u, 2u, 3u, 4u, 6u, 5u, 4u, 7u, 6u, 0u, 4u, 5u, 0u, 5u, 1u, 1u, 5u, 6u, 1u, 6u, 2u, 2u, 6u, 7u, 2u, 7u, 3u, 3u, 7u, 4u, 3u, 4u, 0u);
  let v = idx[k];
  let c = cs[v % 4u];
  let far = select(0.0, 1.0, v >= 4u);
  let corner = c0 + along * c.x * a.w + vec3<f32>(0.0, 0.0, c.y * b.z);
  let p = corner - sun * len * far;
  o.wpos = p;
  o.core = c0 - sun * len * far;
  o.t = far;
  o.strength = smoothstep(0.05, 0.3, facing) * smoothstep(0.03, 0.15, sun.z) * ih(4u).w;
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  return o;
}

@fragment
fn fsShaft(in: ShaftOut) -> FOut {
  let h0 = ih(0u);
  var o: FOut;
  o.pick = vec2<u32>(0u);
  if (in.wpos.z > h0.z || focusOut(in.wpos) > 0.5) { discard; }
  // lit: the shadow map at a point between this face and the middle line (the beam's own edge is half in shadow)
  let q = mix(in.wpos, in.core, 0.5);
  let lit = shadowLit(q, vec3<f32>(0.0, 0.0, 1.0));
  // fading off along it, and dust: specks drifting in the light
  let fade = (1.0 - in.t) * (0.35 + 0.65 * (1.0 - in.t));
  // (fine motes: a few centimetres, sparse, drifting down and twinkling — the user: "the dust is a bit of an issue")
  let cell = floor(in.wpos * 36.0 + vec3<f32>(0.0, 0.0, G.time * 0.7));
  let r = randv(vec3<i32>(cell));
  let speck = smoothstep(0.993, 1.0, r) * (0.5 + 0.5 * sin(G.time * 3.0 + r * 50.0));
  let haze = 0.15 + 0.07 * vnoise(in.wpos.xy * 1.5 + vec2<f32>(G.time * 0.15, in.wpos.z));
  let c = G.sunCol.rgb * vec3<f32>(1.1, 0.92, 0.68) * (haze * fade + speck * 1.1) * lit * in.strength * h0.w;
  o.color = vec4<f32>(c, 0.0);
  return o;
}
