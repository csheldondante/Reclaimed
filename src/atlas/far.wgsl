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
  let ah = dot(l - FP.focus.xy, normalize(FC.eye.xy));
  return mix(z, min(z, FP.focus.z), smoothstep(0.0, 24.0, ah));
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
@group(0) @binding(45) var<storage, read> lodT: array<vec2<f32>>;
@group(0) @binding(46) var<uniform> LD: LodD;

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
  return o;
}

@fragment
fn fsLod(v: LOut) -> FOutF {
  let l = v.local.xy;
  // the window's own land is the columns' — where its mesh is built (round 83: till then, the ring's top, so
  // land just come in isn't a hole while its chunks are made); a finer ring's square is that ring's
  if (all(l >= vec2<f32>(0.0)) && all(l <= FP.win.xy) && meshBuilt(l)) { discard; }
  if (v.ring > 0u) {
    let F = LD.lv[v.ring - 1u];
    let fc = lodCorner(v.ring - 1u);
    if (all(l > fc) && all(l < fc + (F.w - 1.0) * F.z)) { discard; }
  }
  if (farCut(v.local, v.pos.xy)) { discard; }
  let sun = normalize(vec3<f32>(0.45, 0.35, 0.82));
  let lit = 0.45 + 0.7 * max(dot(normalize(v.nrm), sun), 0.0);
  var c = v.col * lit;
  var fog = smoothstep(0.55, 1.0, v.dist);
  if (FC.pos.w > 0.5) { fog = max(fog, smoothstep(300.0, 2600.0, length(v.local - FC.pos.xyz))); }
  c = mix(c, FP.fog.rgb, fog);
  var o: FOutF;
  o.color = vec4<f32>(c, 1.0);
  o.pick = vec2<u32>(0u, 0u);
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
