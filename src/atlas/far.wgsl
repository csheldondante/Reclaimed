// ---- atlas/far.wgsl -------------------------------------------------------
// The land beyond the window (round 73: "I only see the local chunks"): the
// atlas's ground from its macro map (heights and colours, a texel 16 cells),
// with the coarse world's changes (craters, cones, ash, set lava), as one grid
// round the camera drawn with the world, out to where it fades into the sky.
// Inside the window the columns draw the land: the grid is cut there.

struct FarCam {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
  light: mat4x4<f32>,
  pos: vec4<f32>,
  // (round 83) what's cut from the view, as render.wgsl Camera (camera.ts Cut)
  cut: vec4<f32>,
  see: array<vec4<f32>, 4>,
  boxes: array<vec4<f32>, 8>,
}
struct FarP {
  /** the window's cell (0, 0) in the world (world units), and its oz; the window's size (world units) */
  org: vec4<f32>,
  win: vec4<f32>,
  /** the grid's middle (window coordinates), its spacing, vertices a side, the fog's colour */
  mid: vec4<f32>,
  fog: vec4<f32>,
  /** the world (it wraps), the map's texels a side, the sea, the coarse world's cells a side */
  world: vec4<f32>,
  /** (round 83) the view's focus (window coordinates; w 1: on): the land on the eye's side of it kept under it */
  focus: vec4<f32>,
  /** (round 86) the storms (window coordinates: x, y, radius, how strong 0..1), how many, the time (s) */
  storms: array<vec4<f32>, 4>,
  rain: vec4<f32>,
  /** (round 93, the window's light — render.wgsl lighting, from the Globals: far.ts FarLight) the sun's way (xyz) and
   *  1 − night; its colour; the sky's (rgb) and night; the window's G.org (world units, cells); the season, the
   *  pollution, 1: the window's look on the rings (?fd=0: 0, the old look), 0 */
  sun: vec4<f32>,
  sunCol: vec4<f32>,
  sky: vec4<f32>,
  gorg: vec4<f32>,
  look: vec4<f32>,
}

/**
 * (round 86) How a storm lies on the land the rings draw at l (window coordinates): x its cloud's shade, y how
 * wet the ground is under it (as the window's sim makes it there — the mesh darkens its wet ground, a film
 * where it runs). A disc a storm, its edge softened (common.wgsl stormCover's falloff).
 */
fn farStorm(l: vec2<f32>) -> vec2<f32> {
  var o = vec2<f32>(0.0);
  for (var i = 0u; i < u32(FP.rain.x); i++) {
    let s = FP.storms[i];
    let d = length(l - s.xy) / max(s.z, 1.0);
    o = max(o, s.w * vec2<f32>(smoothstep(1.15, 1.0, d), smoothstep(1.25, 0.55, d)));
  }
  return o;
}

/** toward the eye from p (as render.wgsl toEye) */
fn farEye(p: vec3<f32>) -> vec3<f32> {
  if (FC.pos.w > 0.5) { return normalize(FC.pos.xyz - p); }
  return FC.eye.xyz;
}

/** 4 × 4 ordered dither, 0..1 (render.wgsl bayer4) */
fn farBayer(px: vec2<f32>) -> f32 {
  let i = vec2<u32>(px) & vec2<u32>(3u);
  let m = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
  return (f32(m[i.y * 4u + i.x]) + 0.5) / 16.0;
}

/**
 * (round 83, the user: "LOD rings don't interact correctly with dithering") Is p cut from the view — over the
 * slice, or in a kept-seen point's hole (dithered)? As render.wgsl cutAway; the boxes that limit a hole too.
 */
fn farCut(p: vec3<f32>, px: vec2<f32>) -> bool {
  if (FC.cut.w > 0.5 && p.z > FC.cut.x) { return true; }
  let n = u32(FC.cut.y);
  if (n == 0u) { return false; }
  let e = farEye(p);
  var k = 0.0;
  for (var i = 0u; i < n; i++) {
    let s = FC.see[i];
    let v = p - s.xyz;
    let along = dot(v, e);
    k = max(k, (1.0 - smoothstep(s.w * 0.7, s.w, length(v - along * e))) * smoothstep(1.0, 2.0, along) * smoothstep(0.0, 0.8, p.z - s.z));
  }
  let nb = u32(FC.cut.z);
  if (nb > 0u) {
    var inside = false;
    for (var i = 0u; i < nb; i++) {
      if (all(p >= FC.boxes[i * 2u].xyz - vec3<f32>(0.5)) && all(p <= FC.boxes[i * 2u + 1u].xyz + vec3<f32>(0.5))) { inside = true; }
    }
    if (!inside) { return false; }
  }
  return k > farBayer(px);
}

/**
 * (round 83, the user: "maybe not render the ones in the direction of the camera from the focus") The land
 * on the eye's side of the focus kept under the focus's height (over 24 world units: none at the focus), so
 * nothing past the window rises between the eye and what the camera's on. The fixed view only.
 */
fn underFocus(l: vec2<f32>, z: f32) -> f32 {
  if (FP.focus.w < 0.5 || FC.pos.w > 0.5) { return z; }
  // (hybrid: the window's own land the rings draw is the land itself — never pressed down)
  if (LD.mesh.z > 0.5 && all(l >= vec2<f32>(0.0)) && all(l <= FP.win.xy)) { return z; }
  let ah = dot(l - FP.focus.xy, normalize(FC.eye.xy));
  // (round 93: only what would rise into the line from the eye to the focus — the land under that line stays as it
  // is, not a flat floor at the focus's height; ?fd=0 the old floor)
  var cap = FP.focus.z;
  if (FP.look.z > 0.5) { cap = FP.focus.z + max(ah, 0.0) * FC.eye.z / max(length(FC.eye.xy), 1e-3) * 0.85; }
  return mix(z, min(z, cap), smoothstep(0.0, 24.0, ah));
}

@group(0) @binding(10) var<uniform> FC: FarCam;
@group(0) @binding(40) var<uniform> FP: FarP;
@group(0) @binding(41) var heightT: texture_2d<f32>;
@group(0) @binding(42) var colourT: texture_2d<f32>;
struct FarCoarse {
  s: vec4<f32>,
  l: vec4<f32>,
}
@group(0) @binding(43) var<storage, read> coarseF: array<FarCoarse>;

/** the rings of less detail round the window (round 83, lod.ts / lod.wgsl) */
struct LodD {
  /** each ring: its corner (world texel indices: texel (I, J) at (I, J) · spacing in the world; held in slot
   *  (I mod n, J mod n)), its spacing, texels a side */
  lv: array<vec4<f32>, 5>,
  /** how many rings (0: none), the outermost's corner (window coordinates) and its span */
  info: vec4<f32>,
  /** (round 83) the window's mesh chunks: a chunk's width and depth (window units), chunks across and down;
   *  0: the rings never draw in the window */
  mesh: vec4<f32>,
  /** (round 86, the hybrid) a bit a mesh chunk, set: the window's grid draws it (renderer.ts setGrid) */
  grid: array<vec4<u32>, 16>,
}
/** the window's field mesh's state (its published layout: meshstate.wgsl, included before this) */
@group(0) @binding(47) var<storage, read> meshSt: array<u32>;

/** Is the window's mesh built where l (window coordinates) is? (No mesh: as if it were — the rings stay out.) */
fn meshBuilt(l: vec2<f32>) -> bool {
  if (LD.mesh.z < 0.5) { return true; }
  let c = vec2<i32>(floor(l / LD.mesh.xy));
  if (any(c < vec2<i32>(0)) || c.x >= i32(LD.mesh.z) || c.y >= i32(LD.mesh.w)) { return true; }
  let b = CHUNK0 + u32(c.y * i32(LD.mesh.z) + c.x) * CSTRIDE;
  let h = meshSt[b + MS_BUILT];
  // (and drawn: a chunk made while its land was still coming in — a slide's — is made, and empty, till it's
  // made again; word 0 its indices)
  return h != FRESH && h != 0u && meshSt[b + MS_INDICES] > 0u;
}
/** (round 86, the hybrid) Is l (window coordinates) in a chunk the window's grid draws (meshdraw.wgsl vsGrid)? */
fn gridChunk(l: vec2<f32>) -> bool {
  if (LD.mesh.z < 0.5) { return false; }
  let c = vec2<i32>(floor(l / LD.mesh.xy));
  if (any(c < vec2<i32>(0)) || c.x >= i32(LD.mesh.z) || c.y >= i32(LD.mesh.w)) { return false; }
  let k = u32(c.y * i32(LD.mesh.z) + c.x);
  if (k >= 2048u) { return false; }
  return ((LD.grid[k >> 7u][(k >> 5u) & 3u] >> (k & 31u)) & 1u) != 0u;
}
/** the window draws l itself: its mesh is built there, or its grid draws it */
fn windowDraws(l: vec2<f32>) -> bool { return meshBuilt(l) || gridChunk(l); }
/** (hybrid) Is l (window coordinates, in a built chunk) within SKIRT of an edge whose neighbour isn't built (nor
 *  the grid's: its lattice overlaps the chunks beside it by a cell)? */
const SKIRT: f32 = 0.9;
fn skirt(l: vec2<f32>) -> bool {
  if (LD.mesh.z < 0.5) { return false; }
  let f = l - floor(l / LD.mesh.xy) * LD.mesh.xy;
  if (f.x < SKIRT && !windowDraws(l - vec2<f32>(SKIRT * 2.0, 0.0))) { return true; }
  if (f.x > LD.mesh.x - SKIRT && !windowDraws(l + vec2<f32>(SKIRT * 2.0, 0.0))) { return true; }
  if (f.y < SKIRT && !windowDraws(l - vec2<f32>(0.0, SKIRT * 2.0))) { return true; }
  if (f.y > LD.mesh.y - SKIRT && !windowDraws(l + vec2<f32>(0.0, SKIRT * 2.0))) { return true; }
  return false;
}
@group(0) @binding(45) var<storage, read> lodT: array<vec4<f32>>;
@group(0) @binding(46) var<uniform> LD: LodD;
/** (round 93) each material's albedo (lod.ts: lod.wgsl lodAlbedo's) */
@group(0) @binding(48) var<uniform> farAlbedo: array<vec4<f32>, 64>;

/** in the outermost ring's square (window coordinates): the rings draw it */
fn inLod(l: vec2<f32>) -> bool {
  let o = LD.info.yz;
  return LD.info.x > 0.5 && all(l > o) && all(l < o + LD.info.w);
}

struct FOutV {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) dist: f32,
}

fn wrapT(i: vec2<i32>, n: i32) -> vec2<i32> { return ((i % n) + n) % n; }

/** the atlas's ground and the coarse world's change at world point p, and its colour */
fn farAt(p: vec2<f32>) -> vec4<f32> {
  let n = i32(FP.world.z);
  let t = p / FP.world.xy * f32(n) - 0.5;
  let i0 = vec2<i32>(floor(t));
  let f = t - floor(t);
  var h = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2<i32>(k & 1, k >> 1);
    let wt = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    h += textureLoad(heightT, wrapT(i0 + o, n), 0).x * wt;
  }
  // the coarse world
  let cn = i32(FP.world.w);
  let tc = p / FP.world.xy * f32(cn) - 0.5;
  let c0 = vec2<i32>(floor(tc));
  let fc = tc - floor(tc);
  var dr = 0.0;
  var loose = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2<i32>(k & 1, k >> 1);
    let wt = select(1.0 - fc.x, fc.x, o.x == 1) * select(1.0 - fc.y, fc.y, o.y == 1);
    let w = wrapT(c0 + o, cn);
    let c = coarseF[u32(w.y) * u32(cn) + u32(w.x)];
    dr += c.s.x * wt;
    loose += c.s.y * wt;
  }
  return vec4<f32>(h + dr + loose, dr, loose, 0.0);
}

fn farColour(p: vec2<f32>, h: f32, dr: f32, loose: f32) -> vec3<f32> {
  let n = i32(FP.world.z);
  let i = wrapT(vec2<i32>(floor(p / FP.world.xy * f32(n))), n);
  var c = textureLoad(colourT, i, 0).rgb;
  if (h < FP.mid.w) { c = vec3<f32>(0.2, 0.36, 0.42); }
  if (dr > 0.5) { c = vec3<f32>(0.18, 0.17, 0.18); }
  if (loose > 0.1) { c = mix(c, vec3<f32>(0.6, 0.58, 0.55), clamp(loose, 0.0, 1.0)); }
  return c;
}

@vertex
fn vsFar(@builtin(vertex_index) vi: u32) -> FOutV {
  let G = u32(FP.mid.z);
  let s = FP.win.z;
  let gi = vec2<f32>(f32(vi % G), f32(vi / G)) - f32(G - 1u) * 0.5;
  // (on the world's lattice of the grid's spacing: it doesn't swim as the camera moves, and round 83 the
  // rings' edges are on it)
  let local = (floor((FP.mid.xy + FP.org.xy) / s) + gi) * s - FP.org.xy;
  let p = local + FP.org.xy;
  let a = farAt(p);
  let e = s;
  let hx = farAt(p + vec2<f32>(e, 0.0)).x - farAt(p - vec2<f32>(e, 0.0)).x;
  let hy = farAt(p + vec2<f32>(0.0, e)).x - farAt(p - vec2<f32>(0.0, e)).x;
  // (the sea stands at its level; under the window it sinks away, so the columns' land is drawn over it
  // and the two meet at the window's edge without a gap)
  let inset = min(min(local.x, FP.win.x - local.x), min(local.y, FP.win.y - local.y));
  let z = underFocus(local, max(a.x, FP.mid.w) - FP.org.z - 80.0 * clamp(inset / 12.0, 0.0, 1.0));
  var o: FOutV;
  o.local = vec3<f32>(local, z);
  o.pos = FC.viewProj * vec4<f32>(local, z, 1.0);
  o.nrm = normalize(vec3<f32>(-hx / (2.0 * e), -hy / (2.0 * e), 1.0));
  o.col = farColour(p, a.x, a.y, a.z);
  o.dist = length(local - FP.mid.xy) / (f32(G - 1u) * 0.5 * s);
  return o;
}

struct FOutF {
  @location(0) color: vec4<f32>,
  @location(1) pick: vec2<u32>,
}

@fragment
fn fsFar(v: FOutV) -> FOutF {
  // the window's own land is the columns' (the grid sank under it; deep inside it, not drawn)
  let l = v.local.xy;
  if (l.x > 24.0 && l.y > 24.0 && l.x < FP.win.x - 24.0 && l.y < FP.win.y - 24.0) { discard; }
  // (the fixed view looks from +x +y: land can only stand between the eye and the window where it's
  // past both of the window's near edges — what's beyond either far edge is drawn, the rest not)
  // (round 83: with the rings, all of it — what stands past both near edges is past the rings, too far
  // to rise between the eye and the window)
  if (FC.pos.w < 0.5 && l.x > 2.0 && l.y > 2.0 && LD.info.x < 0.5) { discard; }
  if (inLod(l)) { discard; }
  if (farCut(v.local, v.pos.xy)) { discard; }
  let sun = normalize(vec3<f32>(0.45, 0.35, 0.82));
  let lit = 0.45 + 0.7 * max(dot(v.nrm, sun), 0.0);
  var c = v.col * lit;
  // fading into the sky toward the grid's edge (and with distance from a free camera)
  var fog = smoothstep(0.55, 1.0, v.dist);
  if (FC.pos.w > 0.5) { fog = max(fog, smoothstep(300.0, 2600.0, length(v.local - FC.pos.xyz))); }
  c = mix(c, FP.fog.rgb, fog);
  var o: FOutF;
  o.color = vec4<f32>(c, 1.0);
  o.pick = vec2<u32>(0u, 0u);
  return o;
}

// ---- the rings (round 83, lod.ts) ---------------------------------------------------
// A ring an instance: its grid of n × n texels (lod.wgsl: the ground's top and colour). Toward its edge
// (its last 16 texels) a ring melts into the next one out — at its edge it's what that ring is there,
// so the two meet without a crack; the outermost melts into the far land the same way.

struct LOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) dist: f32,
  @location(4) @interpolate(flat) ring: u32,
  /** (hybrid) the rock its steep faces show, and the top's and the rock's materials */
  @location(5) rock: vec3<f32>,
  @location(6) @interpolate(flat) mats: vec2<u32>,
  /** (round 86) how far under its neighbours the texel lies (world units: a hollow, where a storm's water stands) */
  @location(7) hollow: f32,
  /** (round 93) the plants the window starts with here (0..4.2), the distance to a way (world units), the window's
   *  large-scale tint (meshdraw.wgsl meshTint), how deep water stands */
  @location(8) veg: f32,
  @location(9) road: f32,
  @location(10) tint: f32,
  @location(11) wdep: f32,
}

fn lodPmod(a: i32, n: i32) -> i32 { return ((a % n) + n) % n; }

/** ring k's texel i texels from its corner (clamped to the ring): its top and colour */
fn lodTexel(k: u32, i: vec2<i32>) -> vec4<f32> {
  let L = LD.lv[k];
  let n = i32(L.w);
  let c = clamp(i, vec2<i32>(0), vec2<i32>(n - 1)) + vec2<i32>(L.xy);
  let t = lodT[k * u32(n * n) + u32(lodPmod(c.y, n) * n + lodPmod(c.x, n))];
  return vec4<f32>(t.x, unpack4x8unorm(bitcast<u32>(t.y)).rgb);
}

/** (hybrid) ring k's texel i, the whole slot: top, colour (bits), the ground under any water, the rock (bits) */
fn lodSlot(k: u32, i: vec2<i32>) -> vec4<f32> {
  let L = LD.lv[k];
  let n = i32(L.w);
  let c = clamp(i, vec2<i32>(0), vec2<i32>(n - 1)) + vec2<i32>(L.xy);
  return lodT[k * u32(n * n) + u32(lodPmod(c.y, n) * n + lodPmod(c.x, n))];
}

/** (hybrid) Is l (window coordinates) in the window, its land the window's (a field mesh there)? Then what
 *  the rings draw there is picked as the window's columns, and never pressed under the focus. */
fn inWindowLand(l: vec2<f32>) -> bool {
  return LD.mesh.z > 0.5 && all(l >= vec2<f32>(0.0)) && all(l <= FP.win.xy);
}

/** ring k at l (window coordinates), bilinear: its top and colour */
fn lodAt(k: u32, l: vec2<f32>) -> vec4<f32> {
  let L = LD.lv[k];
  let q = (l + FP.org.xy) / L.z - L.xy;
  let i0 = vec2<i32>(floor(q));
  let f = q - floor(q);
  let a = mix(lodTexel(k, i0), lodTexel(k, i0 + vec2<i32>(1, 0)), f.x);
  let b = mix(lodTexel(k, i0 + vec2<i32>(0, 1)), lodTexel(k, i0 + vec2<i32>(1, 1)), f.x);
  return mix(a, b, f.y);
}

/** ring k's corner in window coordinates */
fn lodCorner(k: u32) -> vec2<f32> { return LD.lv[k].xy * LD.lv[k].z - FP.org.xy; }

@vertex
fn vsLod(@builtin(vertex_index) vi: u32, @builtin(instance_index) k: u32) -> LOut {
  let L = LD.lv[k];
  let n = u32(L.w);
  let s = L.z;
  let ij = vec2<i32>(i32(vi % n), i32(vi / n));
  let local = lodCorner(k) + vec2<f32>(ij) * s;
  var t = lodTexel(k, ij);
  let slot = lodSlot(k, ij);
  // (toward the edge, what the next ring out — or the far land — is there)
  let e = f32(min(min(ij.x, i32(n) - 1 - ij.x), min(ij.y, i32(n) - 1 - ij.y)));
  let a = clamp((16.0 - e) / 14.0, 0.0, 1.0);
  if (a > 0.0) {
    var w: vec4<f32>;
    if (k + 1u < u32(LD.info.x)) {
      w = lodAt(k + 1u, local);
    } else {
      let p = local + FP.org.xy;
      let fa = farAt(p);
      w = vec4<f32>(max(fa.x, FP.mid.w), farColour(p, fa.x, fa.y, fa.z));
    }
    t = mix(t, w, a);
  }
  let hx = lodTexel(k, ij + vec2<i32>(1, 0)).x - lodTexel(k, ij - vec2<i32>(1, 0)).x;
  let hy = lodTexel(k, ij + vec2<i32>(0, 1)).x - lodTexel(k, ij - vec2<i32>(0, 1)).x;
  let z = underFocus(local, t.x - FP.org.z);
  var o: LOut;
  o.local = vec3<f32>(local, z);
  o.pos = FC.viewProj * vec4<f32>(local, z, 1.0);
  o.nrm = normalize(vec3<f32>(-hx / (2.0 * s), -hy / (2.0 * s), 1.0));
  o.col = t.yzw;
  o.dist = length(local - FP.mid.xy) / (f32(u32(FP.mid.z) - 1u) * 0.5 * FP.win.z);
  o.ring = k;
  let ca = unpack4x8unorm(bitcast<u32>(slot.y));
  // (round 93: the rock's material, the plants, the way's distance — lod.wgsl)
  let sw = bitcast<u32>(slot.w);
  let rm = min(sw & 0xffu, 63u);
  o.rock = farAlbedo[rm].rgb;
  o.mats = vec2<u32>(u32(round(ca.a * 255.0)), rm);
  // (the last ring melting into the far land: its plants and ways go with it — the far land's colour has its green)
  let last = select(0.0, a, k + 1u >= u32(LD.info.x));
  o.veg = f32((sw >> 8u) & 0xffu) / 60.0 * (1.0 - last);
  o.road = mix(f32((sw >> 16u) & 0xffu) / 255.0 * 3.2, 3.2, last);
  o.wdep = slot.x - slot.z;
  o.tint = 1.0;
  if (FP.look.z > 0.5) { o.tint = 0.82 + 0.36 * gFbm2(gWo(local) * 0.045 + vec2<f32>(z * 0.02)); }
  let nb = lodTexel(k, ij + vec2<i32>(1, 0)).x + lodTexel(k, ij - vec2<i32>(1, 0)).x + lodTexel(k, ij + vec2<i32>(0, 1)).x + lodTexel(k, ij - vec2<i32>(0, 1)).x;
  o.hollow = nb * 0.25 - slot.z;
  return o;
}

// ---- (round 93) the window's look on the rings: its noise, its light, its plants, its ways, its trees ----------
// The user (round 93): "detail further out ... could be fairly cheap and fast and resolve much of the visual pop in on
// its own". What the window draws (meshdraw.wgsl meshShade) from what the rings bake once (lod.wgsl: the plants the
// columns start with, the ways' distance): nothing here is updated a frame but the light.

/** common.wgsl's randoms and noise exactly (the window's G.org: its hashes and noise stay with the land) */
fn gPcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn gRandv(p: vec3<i32>) -> f32 {
  let x = bitcast<u32>(p.x) + bitcast<u32>(i32(FP.gorg.z));
  let y = bitcast<u32>(p.y) + bitcast<u32>(i32(FP.gorg.w));
  return f32(gPcg(x ^ gPcg(y ^ gPcg(bitcast<u32>(p.z)))) >> 8u) / 16777216.0;
}
fn gWo(p: vec2<f32>) -> vec2<f32> { return p + FP.gorg.xy; }
fn gVnoise(p: vec2<f32>) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = gRandv(vec3<i32>(i, 911));
  let b = gRandv(vec3<i32>(i + vec2<i32>(1, 0), 911));
  let c = gRandv(vec3<i32>(i + vec2<i32>(0, 1), 911));
  let d = gRandv(vec3<i32>(i + vec2<i32>(1, 1), 911));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn gFbm2(p: vec2<f32>) -> f32 {
  return gVnoise(p) * 0.55 + gVnoise(p * 2.03 + 17.0) * 0.3 + gVnoise(p * 4.1 + 41.0) * 0.15;
}
fn gLin(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
fn gSrgb(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }

/** render.wgsl lighting without its shadows, clouds, flashes and fire (the rings' land is past them) */
fn gLight(n: vec3<f32>) -> vec3<f32> {
  let sun = normalize(FP.sun.xyz);
  let day = FP.sun.w;
  let ambient = FP.sky.rgb * (0.5 + 0.5 * n.z);
  let fill = max(dot(n, normalize(vec3<f32>(-sun.x, -sun.y, 0.4))), 0.0) * vec3<f32>(0.42, 0.36, 0.29) * (0.15 + 0.85 * day);
  return ambient + fill + FP.sunCol.rgb * max(dot(n, sun), 0.0);
}
/** render.wgsl haze (no reach: the atlas has none) */
fn gHaze(c: vec3<f32>, z: f32) -> vec3<f32> {
  let h = mix(vec3<f32>(0.62, 0.70, 0.78), vec3<f32>(0.62, 0.57, 0.48), FP.look.y) * mix(1.0, 0.15, FP.sky.w);
  return mix(c, gLin(h), 0.03 + 0.1 * FP.look.y + smoothstep(24.0, 0.0, z) * 0.06);
}
/** common.wgsl seasonGrass (G.rules.w the season) */
fn gSeasonGrass(g: vec3<f32>, h: f32) -> vec3<f32> {
  let s = FP.look.x;
  let colour = smoothstep(0.35, 0.55, s) * (1.0 - smoothstep(0.85, 0.92, s));
  let bare = smoothstep(0.55, 0.78, s) * (1.0 - smoothstep(0.9, 1.0, s));
  let straw = mix(vec3<f32>(0.62, 0.52, 0.22), vec3<f32>(0.7, 0.6, 0.3), h);
  let c = mix(g, straw, colour * (0.45 + 0.4 * h));
  return mix(c, vec3<f32>(0.46, 0.39, 0.24) * (0.9 + 0.2 * h), bare * 0.75);
}

/** ways.ts HALF; its paving (ways.ts MAT_PAVE: brick) */
const G_WAY_HALF: f32 = 2.2;
const G_MAT_PAVE: u32 = 11u;
/** world units a tree's lattice step (vegplan.wgsl: a tree in 4.5% of the cells where v >= 3.6 — one in ~3 of these
 *  3 x 3 squares) */
const G_TREE_STEP: f32 = 3.0;
const G_TREE_P: f32 = 0.34;

struct Tree { crown: f32, shade: f32, c: vec3<f32> }

/**
 * (round 93) The trees over ground point w (world): a crown on a lattice square where the plants are a wood's
 * (vegplan.wgsl's rule), drawn where it stands on the screen — raised by its height (a point h up is seen
 * h / tan(elevation) further from the eye on the ground) — and its shadow on the ground the sun's way. No geometry:
 * a few hashes a pixel, only where the plants are a wood's.
 */
fn gTrees(w: vec2<f32>, v: f32, px: f32) -> Tree {
  var t = Tree(0.0, 0.0, vec3<f32>(0.0));
  let dens = smoothstep(3.3, 3.8, v);
  if (dens <= 0.0) { return t; }
  let eh = length(FC.eye.xy);
  let away = -FC.eye.xy / max(eh, 1e-3);
  let cotE = eh / max(FC.eye.z, 0.05);
  let sun = normalize(FP.sun.xyz);
  let sh = -sun.xy / max(sun.z, 0.25);
  let b0 = vec2<i32>(floor(w / G_TREE_STEP));
  // (a crown is raised away from the eye — up to ~8 world units — so it stands over ground nearer the eye than its
  // foot: the squares from there)
  let sx = select(1, -1, away.x < 0.0);
  let sy = select(1, -1, away.y < 0.0);
  for (var j = -3; j <= 1; j++) {
    for (var i = -3; i <= 1; i++) {
      let bq = b0 + vec2<i32>(i * sx, j * sy);
      let r0 = gRandv(vec3<i32>(bq, 4242));
      if (r0 >= G_TREE_P * dens) { continue; }
      let r1 = gRandv(vec3<i32>(bq, 321));
      let r2 = gRandv(vec3<i32>(bq, 7));
      let foot = (vec2<f32>(bq) + vec2<f32>(0.2 + 0.6 * r1, 0.2 + 0.6 * r2)) * G_TREE_STEP;
      let conifer = r1 < 0.42;
      let H = select(3.0 + 3.0 * r2, 3.5 + 4.0 * r2, conifer);
      let R = select(1.3 + 0.7 * r1, 0.9 + 0.5 * r2, conifer);
      // its shadow on the ground
      let ds = length(w - (foot + sh * H * 0.8)) / (R * 1.1);
      t.shade = max(t.shade, 1.0 - smoothstep(0.75, 1.0, ds));
      // its crown where the screen shows it (a conifer's taller than wide)
      let cc = foot + away * H * cotE;
      let q = (w - cc) / R;
      var d = length(q);
      if (conifer) {
        let up = dot(q, away);
        d = length(q - away * up * 0.55);
      }
      let edge = clamp(px / R, 0.05, 0.5);
      let cov = 1.0 - smoothstep(1.0 - edge, 1.0, d);
      if (cov > t.crown) {
        t.crown = cov;
        // lit as a ball (its normal from where on it), a little each its own green
        let nb = normalize(vec3<f32>(q * 0.8, sqrt(max(1.0 - min(dot(q, q), 1.0), 0.0)) + 0.25));
        var leaf = select(vec3<f32>(0.2, 0.36, 0.13), vec3<f32>(0.13, 0.27, 0.13), conifer) * (0.85 + 0.3 * r0 / G_TREE_P);
        if (!conifer) { leaf = gSeasonGrass(leaf, r2) * 0.5 + leaf * 0.5; }
        t.c = gLin(leaf) * gLight(nb);
      }
    }
  }
  return t;
}

/**
 * (round 93) A ring's ground as the window draws it (meshdraw.wgsl meshShade): its top's albedo with the window's tint
 * and specks, the plants it starts with over it (its grass by how much, turning with the season; the tufts' shade),
 * the ways paved, water left as it is; lit by the window's light and hazed as the window is; the trees over it.
 * Linear light inside, sRGB out.
 */
fn ringWindowLook(v: LOut, n: vec3<f32>, rockK: f32, /** world units a pixel */ cellPx: f32, cell: vec2<i32>, road: f32, fw: f32) -> vec3<f32> {
  let w = gWo(v.local.xy);
  var alb = gLin(v.col);
  let water = v.wdep > 0.05;
  // (the window's speckle is a quarter cell's, drawn however small — it sparkles; here too, until a pixel is 1.5
  // cells and more (the far rings), where its average)
  let avgW = smoothstep(1.5, 3.0, cellPx);
  if (!water) {
    // the specks a cell (the window's randv of its cell, fading where a cell is under a pixel)
    let sp = gRandv(vec3<i32>(cell, i32(floor(v.local.z))));
    alb *= 1.0 + (0.12 * sp - 0.06) * (1.0 - avgW);
    alb *= v.tint;
    // plants on the tops (the window's grow from what its columns start with: on soil and silt its sim has them
    // grassed over — at least FP.look.w there)
    let soilish = v.mats.x == 2u || v.mats.x == 22u || v.mats.x == 26u;
    let veg = max(v.veg, select(0.0, FP.look.w, soilish)) * (1.0 - rockK);
    if (veg > 0.0) {
      let cover = smoothstep(0.0, 1.2, veg);
      var g = mix(vec3<f32>(0.33, 0.40, 0.17), vec3<f32>(0.36, 0.54, 0.19), smoothstep(1.0, 2.0, veg));
      g = mix(g, vec3<f32>(0.17, 0.33, 0.12), smoothstep(3.0, 4.5, veg));
      g = mix(g, gSeasonGrass(g, gFbm2(w * 0.08)), 1.0 - 0.5 * smoothstep(3.0, 4.5, veg));
      // (the window: a quarter cell green where its random is under the cover; here that, or its share where a
      // quarter cell is under a pixel)
      let n1 = gRandv(vec3<i32>(vec2<i32>(floor(v.local.xy * 4.0)), i32(floor(v.local.z * 4.0))));
      let k = mix(select(0.0, 1.0, n1 < cover), cover, avgW);
      // (?tufts=0's painted tufts: their shade, on average)
      let tuft = 1.0 - 0.13 * smoothstep(1.2, 2.5, veg);
      // (the window's grass varies a quarter cell: 0.82 + 0.3 · its random; its share where that's under a pixel)
      let n2 = gRandv(vec3<i32>(vec2<i32>(floor(v.local.xy * 4.0)), i32(floor(v.local.z * 4.0)) + 13));
      let gv = mix(0.82 + 0.3 * n2, 0.97, avgW);
      alb = mix(alb, gLin(g * gv) * tuft, k);
      // (and its flowers: a quarter cell here and there, red, yellow, white or violet, in the grass)
      let n3 = gRandv(vec3<i32>(vec2<i32>(floor(v.local.xy * 4.0)), 57));
      if (n3 < 0.04 * smoothstep(1.2, 2.5, veg) * k) {
        let fk = u32(n3 * 100.0) % 4u;
        var fc = vec3<f32>(0.85, 0.22, 0.2);
        if (fk == 1u) { fc = vec3<f32>(0.92, 0.82, 0.3); }
        if (fk == 2u) { fc = vec3<f32>(0.9, 0.9, 0.86); }
        if (fk == 3u) { fc = vec3<f32>(0.62, 0.45, 0.85); }
        alb = mix(alb, gLin(fc), 1.0 - avgW);
      }
    }
    // the ways: paved (their shoulders the ground's)
    let pave = 1.0 - smoothstep(G_WAY_HALF - fw, G_WAY_HALF + fw, road);
    if (pave > 0.0) { alb = mix(alb, gLin(farAlbedo[G_MAT_PAVE].rgb) * (0.92 + 0.16 * gRandv(vec3<i32>(cell, 5))), pave); }
  }
  var c = alb * gLight(n);
  if (water) {
    // (render.wgsl fsWater: its colour by depth, over its bed by how deep; lava glows as it is)
    if (v.col.r > 0.8 && v.col.b < 0.2) { return v.col; }
    let deep = 1.0 - exp(-v.wdep * 0.45);
    let wl = gLin(mix(vec3<f32>(0.30, 0.45, 0.44), vec3<f32>(0.07, 0.19, 0.25), deep)) * gLight(vec3<f32>(0.0, 0.0, 1.0));
    let bed = gLin(farAlbedo[min(v.mats.x, 63u)].rgb) * gLight(n) * 0.8;
    c = mix(bed, wl, mix(0.5, 0.9, deep));
    // (the window's ripples, glints and foam lighten it ~1.4x in the shots: their average, and a fleck a quarter cell
    // where a quarter cell is pixels across)
    c *= 1.9;
    let fl = gRandv(vec3<i32>(vec2<i32>(floor(v.local.xy * 4.0)), 77));
    c = mix(c, gLin(vec3<f32>(0.72, 0.75, 0.75)) * gLight(vec3<f32>(0.0, 0.0, 1.0)) * 0.55, select(0.0, 0.5, fl > 0.92) * (1.0 - avgW));
  } else {
    let t = gTrees(w, v.veg * (1.0 - rockK), cellPx);
    c *= 1.0 - 0.45 * t.shade * (1.0 - t.crown);
    c = mix(c, t.c, t.crown);
  }
  return gSrgb(gHaze(c, v.local.z));
}

// ---- (hybrid) the rings' look: rock on the steep faces, in beds; the light from finer normals ----------------

fn farHash(p: vec2<i32>) -> f32 {
  var h = bitcast<u32>(p.x) * 374761393u + bitcast<u32>(p.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) / 4294967295.0;
}
fn farVnoise(p: vec2<f32>) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = smoothstep(vec2<f32>(0.0), vec2<f32>(1.0), fract(p));
  let a = mix(farHash(i), farHash(i + vec2<i32>(1, 0)), f.x);
  let b = mix(farHash(i + vec2<i32>(0, 1)), farHash(i + vec2<i32>(1, 1)), f.x);
  return mix(a, b, f.y);
}
fn farFbm2(p: vec2<f32>) -> f32 {
  return farVnoise(p) * 0.55 + farVnoise(p * 2.03 + 17.0) * 0.3 + farVnoise(p * 4.1 + 41.0) * 0.15;
}
/** the beds a rock face shows at world xy w and window z (as render.wgsl strata) */
fn farStrata(w: vec2<f32>, z0: f32) -> f32 {
  let z = z0 + 6.0 * farFbm2(w * 0.01) + 1.2 * farFbm2(w * 0.045);
  let bed = smoothstep(0.32, 0.68, farFbm2(vec2<f32>(z * 0.3, 3.7)));
  let lam = 0.5 + 0.5 * sin(z * 2.3 + 2.0 * farFbm2(w * 0.03));
  return bed * 0.8 + lam * 0.2;
}
/** a rock's colour across its beds (render.wgsl's tints: sandstone, basalt, soil, stone and the rest) */
fn farBedTint(m: u32, b: f32) -> vec3<f32> {
  if (m == 30u) { return mix(vec3<f32>(1.16, 1.02, 0.84), vec3<f32>(0.84, 0.74, 0.74), b); }
  if (m == 23u) { return mix(vec3<f32>(0.92, 0.94, 1.0), vec3<f32>(1.1, 0.96, 0.86), b); }
  if (m == 2u) { return mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), b); }
  return mix(vec3<f32>(0.8, 0.83, 0.9), vec3<f32>(1.16, 1.03, 0.88), b);
}

struct RingLook { c: vec3<f32>, rock: bool }

/**
 * (hybrid) A ring's colour at v, `facet` its triangle's own normal (finer than the vertices' — on the 1-cell
 * ring, a cell's): where the surface is steeper than ~60 degrees, the region's rock in its beds instead of the
 * top's colour stretched down the face; lit by the sun, the sky above and a little bounce.
 */
fn ringLook(v: LOut, facet: vec3<f32>) -> RingLook {
  let sn = normalize(v.nrm);
  let n = normalize(mix(sn, facet, 0.6));
  let up = min(sn.z, facet.z * 0.5 + sn.z * 0.5);
  let rk = 1.0 - smoothstep(0.44, 0.56, up);
  var c = v.col;
  if (rk > 0.0) {
    let w = v.local.xy + FP.org.xy;
    let b = farStrata(w, v.local.z);
    let grain = 0.9 + 0.2 * farVnoise(vec2<f32>(w.x + w.y, v.local.z) * 1.7);
    c = mix(c, v.rock * farBedTint(v.mats.y, b) * grain, rk);
  }
  let sun = normalize(vec3<f32>(0.45, 0.35, 0.82));
  let fill = normalize(vec3<f32>(-0.5, -0.4, 0.3));
  let lit = 0.3 + 0.16 * n.z + 0.72 * max(dot(n, sun), 0.0) + 0.12 * max(dot(n, fill), 0.0);
  return RingLook(c * lit, rk > 0.5);
}

/** (hybrid) the window column whose hexagon holds w (window coordinates; common.wgsl cellAt) */
fn farCellAt(w: vec2<f32>) -> vec2<i32> {
  let RH = 0.8660254;
  let r0 = (w.y - 0.5 * RH) / RH;
  let a = vec2<f32>(w.x - 0.5 - 0.5 * r0, r0);
  let c = vec3<f32>(a.x, a.y, -a.x - a.y);
  var r = round(c);
  let d = abs(r - c);
  if (d.x > d.y && d.x > d.z) { r.x = -r.y - r.z; } else if (d.y > d.z) { r.y = -r.x - r.z; }
  let q = vec2<i32>(i32(r.x), i32(r.y));
  return vec2<i32>(q.x + (q.y - (q.y & 1)) / 2, q.y);
}

@fragment
fn fsLod(v: LOut) -> FOutF {
  // (derivatives before any discard: the triangle's own normal, up)
  var facet = normalize(cross(dpdx(v.local), dpdy(v.local)));
  if (facet.z < 0.0) { facet = -facet; }
  let l = v.local.xy;
  // (round 91: a cell's size on screen, for the grain below)
  let cellPx = length(fwidth(l));
  // (round 93: the way's distance across the pixel, for its edge)
  let roadFw = max(fwidth(v.road), 0.05);
  // the window's own land is the columns' — where its mesh is built (round 83: till then, the ring's top, so
  // land just come in isn't a hole while its chunks are made); a finer ring's square is that ring's
  // (hybrid: but a skirt — a strip of a cell along a built chunk's edge where the chunk beside it is the
  // rings': the mesh and the rings meet there from the same ground, and the strip closes the hairline between)
  // (round 86: and where the window's grid draws a heightfield chunk, all of it — the grid's own lattice overlaps
  // its neighbours by a cell)
  if (all(l >= vec2<f32>(0.0)) && all(l <= FP.win.xy) && (gridChunk(l) || (meshBuilt(l) && !skirt(l)))) { discard; }
  if (v.ring > 0u) {
    let F = LD.lv[v.ring - 1u];
    let fc = lodCorner(v.ring - 1u);
    if (all(l > fc) && all(l < fc + (F.w - 1.0) * F.z)) { discard; }
  }
  if (farCut(v.local, v.pos.xy)) { discard; }
  let look = ringLook(v, facet);
  var c = look.c;
  // (round 93) the window's own look (?fd=0: the old)
  if (FP.look.z > 0.5) {
    let sn = normalize(v.nrm);
    let nn = normalize(mix(sn, facet, 0.6));
    let up = min(sn.z, facet.z * 0.5 + sn.z * 0.5);
    let rk = 1.0 - smoothstep(0.44, 0.56, up);
    let wcell = farCellAt(l);
    var vv = v;
    // (the rock's face: its beds, as ringLook)
    if (rk > 0.0) {
      let w = l + FP.org.xy;
      let b = farStrata(w, v.local.z);
      let grain = 0.9 + 0.2 * farVnoise(vec2<f32>(w.x + w.y, v.local.z) * 1.7);
      vv.col = mix(v.col, v.rock * farBedTint(v.mats.y, b) * grain, rk);
    }
    c = ringWindowLook(vv, nn, rk, cellPx, wcell, v.road, roadFw);
  }
  // (round 91, the user: "I easily hit the edge of the loaded ground") The window's ground is a colour a cell,
  // each a little lighter or darker; the rings' was smooth — a blur past the window's edge. Their ground gets the
  // same grain a cell (the window's hexagons, by world cell: it stays put as the rings move and the window
  // slides), fading out where a cell is under a pixel.
  if (!look.rock && FP.look.z < 0.5) {
    let cell = farCellAt(l) + vec2<i32>(i32(round(FP.org.x)), i32(round(FP.org.y / 0.8660254)));
    let g = farHash(cell) - 0.5;
    c *= 1.0 + 0.24 * g * (1.0 - smoothstep(0.7, 1.4, cellPx));
  }
  // (round 86) a storm over it: the cloud's shade, the ground dark with rain, water standing in the hollows, and
  // sheets of it running down the slopes (the window's sim does this where it's awake; here it's drawn)
  if (FP.rain.x > 0.5) {
    let st = farStorm(l);
    if (st.x + st.y > 0.0) {
      let w = l + FP.org.xy;
      c *= 1.0 - 0.45 * st.x;
      c *= 1.0 - 0.3 * smoothstep(0.15, 0.9, st.y) * select(1.0, 0.4, look.rock);
      let water = vec3<f32>(0.25, 0.36, 0.38) * (1.0 - 0.45 * st.x);
      // (the hollows fill: deeper ones first, ragged at their edge)
      let pool = st.y * smoothstep(0.04, 0.3, v.hollow + 0.12 * (farVnoise(w * 0.7) - 0.5));
      // (down the slope: the normal's tilt; streaks across it, running down)
      let sn = normalize(v.nrm);
      let tilt = length(sn.xy);
      if (tilt > 0.02) {
        let dn = sn.xy / tilt;
        let along = dot(w, dn);
        let across = dot(w, vec2<f32>(-dn.y, dn.x));
        let run = fract(along * 0.45 - FP.rain.y * (0.6 + 2.0 * tilt) + farVnoise(vec2<f32>(across * 0.8, 3.1)) * 3.0);
        let streak = smoothstep(0.82, 0.95, run) * smoothstep(0.35, 0.75, farVnoise(vec2<f32>(across * 1.3, along * 0.08)));
        let sheet = st.y * smoothstep(0.03, 0.12, tilt) * (1.0 - smoothstep(0.55, 0.8, tilt)) * select(1.0, 0.3, look.rock);
        c = mix(c, water, sheet * 0.35);
        c += vec3<f32>(0.16, 0.18, 0.18) * streak * sheet;
      }
      c = mix(c, water, pool * 0.85);
    }
  }
  var fog = smoothstep(0.55, 1.0, v.dist);
  if (FC.pos.w > 0.5) { fog = max(fog, smoothstep(300.0, 2600.0, length(v.local - FC.pos.xyz))); }
  c = mix(c, FP.fog.rgb, fog);
  var o: FOutF;
  o.color = vec4<f32>(c, 1.0);
  o.pick = vec2<u32>(0u, 0u);
  // (hybrid: the window's land the rings draw is picked as its columns are — meshdraw.wgsl's encoding)
  if (inWindowLand(l)) {
    let cell = farCellAt(l);
    let mw = i32(floor(FP.win.x));
    let mh = i32(round(FP.win.y / 0.8660254));
    if (all(cell >= vec2<i32>(0)) && cell.x < mw && cell.y < mh) {
      let m = select(v.mats.x, v.mats.y, look.rock);
      o.pick = vec2<u32>(u32(cell.y * mw + cell.x) + 1u, m | (u32(clamp(v.local.z, 0.0, 255.0)) << 8u));
    }
  }
  return o;
}

// ---- the giants beyond the window (round 75: Atlas.giants, 8 floats each) -------------
// A hexagonal prism to its point, leaning: six sides (two triangles each) and six faces of its
// point, 54 vertices; each face flat-lit. Inside the window the columns have them.
@group(0) @binding(44) var<storage, read> giants: array<f32>;

struct GOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec3<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  @location(2) dist: f32,
}

/** a giant's corner k (0..5) at height up (its foot 0, the shoulder 1, the point 2), in window coordinates */
fn giantCorner(g: u32, k: u32, up: u32) -> vec3<f32> {
  let o = g * 8u;
  var c = vec2<f32>(giants[o], giants[o + 1u]) - FP.org.xy;
  // (the copy round the torus nearest the grid's middle)
  c -= round((c - FP.mid.xy) / FP.world.xy) * FP.world.xy;
  let zb = giants[o + 2u];
  let H = giants[o + 3u];
  let R = giants[o + 4u] * 1.1547;
  let lean = vec2<f32>(giants[o + 5u], giants[o + 6u]);
  var h = 0.0;
  if (up == 1u) { h = H * 0.84; }
  if (up == 2u) { h = H; }
  let a = giants[o + 7u] + f32(k) * 1.0471976;
  var p = c + lean * h;
  if (up < 2u) { p += vec2<f32>(cos(a), sin(a)) * R; }
  return vec3<f32>(p, zb + h - FP.org.z);
}

@vertex
fn vsGiant(@builtin(vertex_index) vi: u32, @builtin(instance_index) gi: u32) -> GOut {
  let tri = vi / 3u;
  let corner = vi % 3u;
  // triangles 0..11: the sides (k, k+1) foot to shoulder; 12..17: the point's faces
  var t: array<vec3<f32>, 3>;
  if (tri < 12u) {
    let k = tri / 2u;
    let k1 = (k + 1u) % 6u;
    if ((tri & 1u) == 0u) {
      t = array<vec3<f32>, 3>(giantCorner(gi, k, 0u), giantCorner(gi, k1, 0u), giantCorner(gi, k1, 1u));
    } else {
      t = array<vec3<f32>, 3>(giantCorner(gi, k, 0u), giantCorner(gi, k1, 1u), giantCorner(gi, k, 1u));
    }
  } else {
    let k = tri - 12u;
    t = array<vec3<f32>, 3>(giantCorner(gi, k, 1u), giantCorner(gi, (k + 1u) % 6u, 1u), giantCorner(gi, 0u, 2u));
  }
  var o: GOut;
  let p = t[corner];
  o.pos = FC.viewProj * vec4<f32>(p, 1.0);
  o.local = p;
  var n = normalize(cross(t[1] - t[0], t[2] - t[0]));
  // (outward: away from the axis)
  let mid = (t[0] + t[1] + t[2]) / 3.0;
  let axis = giantCorner(gi, 0u, 2u);
  if (dot(n.xy, mid.xy - axis.xy) < 0.0 && tri < 12u) { n = -n; }
  if (tri >= 12u && n.z < 0.0) { n = -n; }
  o.nrm = n;
  o.dist = length(p.xy - FP.mid.xy) / (f32(u32(FP.mid.z) - 1u) * 0.5 * FP.win.z);
  return o;
}

@fragment
fn fsGiant(v: GOut) -> FOutF {
  let l = v.local.xy;
  // (over the window, between its floor and ceiling (win.w), the columns have it; above or below, this)
  let inWin = l.x > 0.0 && l.y > 0.0 && l.x < FP.win.x && l.y < FP.win.y;
  if (inWin && v.local.z >= 0.0 && v.local.z < FP.win.w) { discard; }
  if (FC.pos.w < 0.5 && !inWin && l.x > 2.0 && l.y > 2.0) { discard; }
  if (farCut(v.local, v.pos.xy)) { discard; }
  let sun = normalize(vec3<f32>(0.45, 0.35, 0.82));
  let d = max(dot(v.nrm, sun), 0.0);
  // quartz: pale violet, its faces catching the light, a glow of its own
  var c = vec3<f32>(0.62, 0.52, 0.9) * (0.45 + 0.6 * d) + vec3<f32>(0.12, 0.1, 0.18) + vec3<f32>(1.0) * pow(d, 24.0) * 0.5;
  var fog = smoothstep(0.7, 1.15, v.dist);
  if (FC.pos.w > 0.5) { fog = max(fog, smoothstep(600.0, 3200.0, length(v.local - FC.pos.xyz))); }
  c = mix(c, FP.fog.rgb, fog);
  var o: FOutF;
  o.color = vec4<f32>(c, 1.0);
  o.pick = vec2<u32>(0u, 0u);
  return o;
}

// ---- ?ceiling=1 (the perf ceiling: the heightfield alone) ----------------------------
// Only the rings and the far land, into the colour target alone (no pick, no window, nothing cut): the
// cheapest look of the world — the column's colour, lambert from the sun, a little height tint, the fog.

fn ceilShade(col: vec3<f32>, nrm: vec3<f32>, local: vec3<f32>, dist: f32) -> vec4<f32> {
  let sun = normalize(vec3<f32>(0.45, 0.35, 0.82));
  let lit = 0.45 + 0.7 * max(dot(normalize(nrm), sun), 0.0);
  let up = smoothstep(FP.mid.w, FP.mid.w + 160.0, local.z + FP.org.z);
  let c = col * lit * (0.94 + 0.12 * up);
  return vec4<f32>(mix(c, FP.fog.rgb, smoothstep(0.55, 1.0, dist)), 1.0);
}

@fragment
fn fsCeilLod(v: LOut) -> @location(0) vec4<f32> {
  let l = v.local.xy;
  if (v.ring > 0u) {
    let F = LD.lv[v.ring - 1u];
    let fc = lodCorner(v.ring - 1u);
    if (all(l > fc) && all(l < fc + (F.w - 1.0) * F.z)) { discard; }
  }
  return ceilShade(v.col, v.nrm, v.local, v.dist);
}

@fragment
fn fsCeilFar(v: FOutV) -> @location(0) vec4<f32> {
  if (inLod(v.local.xy)) { discard; }
  return ceilShade(v.col, v.nrm, v.local, v.dist);
}
