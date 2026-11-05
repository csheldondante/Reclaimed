// common.wgsl: the camera, the cutaway, dither, shadows, the loose sheet and wither, VOut (part 1 of 7 of the renderWgsl shader, joined in order by render.ts)
// ---- renderer: hex prisms and boxes, opaque + water --------------------------
// One instanced draw per list. Column intervals are hex prisms on the nature
// grid (docs/GRIDS.md), 30 vertices: the top in four triangles and the three
// sides toward the eye. Plants are axis-aligned boxes, 18 vertices: the top
// and the two sides toward the eye (their own list: renderer.ts).
struct Camera {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,      // direction toward the eye (world), w look flags (1: flat-lit tops, ?smooth=0; 2: the field mesh draws the ground, ?mesh=1)
  viewport: vec4<f32>, // px w, px h, px per world unit, the shadow lookup's depth bias (light clip units)
  // world → the sun's shadow map (clip space; renderer.ts lightMatrix)
  light: mat4x4<f32>,
  // where the eye is (round 69: the free camera, perspective), w 1 when it's there; 0: the fixed view
  pos: vec4<f32>,
  // (round 83, V21) what's cut from the view (api/cutaway.ts; camera.ts Cut): x a slice's height (w 1: on),
  // y how many points are kept seen, z how many boxes may be dithered
  cut: vec4<f32>,
  // the points kept seen: xyz the point's base, w a hole's radius on screen (world units)
  see: array<vec4<f32>, 4>,
  // what may be dithered: lo xyz, hi xyz (two a box)
  boxes: array<vec4<f32>, 8>,
};

/** 4 × 4 ordered dither, 0..1 (a pixel's threshold) */
fn bayer4(px: vec2<f32>) -> f32 {
  let i = vec2<u32>(px) & vec2<u32>(3u);
  let m = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
  return (f32(m[i.y * 4u + i.x]) + 0.5) / 16.0;
}

/**
 * How far into a kept-seen point's hole p is, 0..1 (round 83, V21: api/cutaway.ts Dither): in front of the
 * point (over a cell and a half toward the eye) and over its base, near it on screen, thinning over the
 * outer third of the circle; where boxes are marked, only in one of them.
 */
fn seeReach(p: vec3<f32>) -> f32 {
  let n = u32(CAM.cut.y);
  if (n == 0u) { return 0.0; }
  let e = toEye(p);
  var k = 0.0;
  for (var i = 0u; i < n; i++) {
    let s = CAM.see[i];
    let v = p - s.xyz;
    let along = dot(v, e);
    let r = (1.0 - smoothstep(s.w * 0.7, s.w, length(v - along * e))) * smoothstep(1.0, 2.0, along) * smoothstep(0.0, 0.8, p.z - s.z);
    k = max(k, r);
  }
  let nb = u32(CAM.cut.z);
  if (nb > 0u) {
    var inside = false;
    for (var i = 0u; i < nb; i++) {
      let lo = CAM.boxes[i * 2u].xyz - vec3<f32>(0.5);
      let hi = CAM.boxes[i * 2u + 1u].xyz + vec3<f32>(0.5);
      if (all(p >= lo) && all(p <= hi)) { inside = true; }
    }
    if (!inside) { return 0.0; }
  }
  return k;
}

/** over the slice (round 83, V21: api/cutaway.ts Slice) */
fn sliced(p: vec3<f32>) -> bool { return CAM.cut.w > 0.5 && p.z > CAM.cut.x; }

/** Is p where the view was cut open (the slice on, or in a hole)? A surface seen from inside the solid there is drawn dark (a section). */
fn inCut(p: vec3<f32>) -> bool { return CAM.cut.w > 0.5 || seeReach(p) > 0.5; }

/**
 * Is this point cut away (round 83, V21)? Over the slice, sharply; in a kept-seen point's hole, dithered (it
 * opens and closes as an iris). The shadow pass doesn't cut: the light stays.
 */
fn cutAway(p: vec3<f32>, px: vec2<f32>) -> bool {
  return sliced(p) || seeReach(p) > bayer4(px);
}

/** toward the eye from p: one way for the fixed (orthographic) view, from where it is for the free one */
fn toEye(p: vec3<f32>) -> vec3<f32> {
  if (CAM.pos.w > 0.5) { return normalize(CAM.pos.xyz - p); }
  return CAM.eye.xyz;
}

// the sun's shadow map (with the field mesh: renderer.ts shadow pass)
@group(0) @binding(25) var shadowMap: texture_depth_2d;
@group(0) @binding(26) var shadowSamp: sampler_comparison;

/**
 * Direct-light visibility 0..1 from the shadow map: the point (nudged off its
 * surface along its normal) in the sun's view, compared with the nearest
 * depth there, over four filtered taps (soft edges).
 */
fn shadowLit(wpos: vec3<f32>, nrm: vec3<f32>) -> f32 {
  let lp = CAM.light * vec4<f32>(wpos + nrm * 0.15, 1.0);
  let uv = vec2<f32>(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  if (any(uv <= vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0))) { return 1.0; }
  let t = 0.75 / vec2<f32>(textureDimensions(shadowMap));
  let z = lp.z - CAM.viewport.w;
  var s = 0.0;
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(-t.x, -t.y), z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(t.x, -t.y), z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(-t.x, t.y), z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(t.x, t.y), z);
  return s * 0.25;
}

@group(0) @binding(3) var<storage, read> instances: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(6) var<storage, read> veg: array<f32>;
// packed per-column render fields: x shadow z, y moisture, z fire glow, w flow speed
@group(0) @binding(7) var<storage, read> fields: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> water: array<f32>;
@group(0) @binding(10) var<uniform> CAM: Camera;
// the loose layers beneath the top one (drift.wgsl strata): a thin top layer
// is drawn blended with the layer under it
@group(0) @binding(19) var strataTexR: texture_2d<f32>;

/** Material of the loose layer just beneath the top on q (0 if none). */
fn looseBelowAt(q: vec2<i32>) -> u32 {
  let s = textureLoad(strataTexR, texCol(vec2<i32>(q)), 0);
  var m = 0u;
  for (var k = 0; k < 3; k++) { if (s[k] > 0.0) { m = u32(floor(s[k] / 1000.0)); } }
  return m;
}
@group(0) @binding(11) var<storage, read> surface: array<u32>;
// vegetation lean spring per column (sway.wgsl): xy lean, zw velocity
@group(0) @binding(12) var<storage, read> bend: array<vec4<f32>>;
// plant health (wilt.wgsl): y = brownness of plants here (withering, scorched)
@group(0) @binding(13) var<storage, read> wilt: array<vec4<f32>>;

/**
 * Smooth depth of a sheet at a world point: interpolated over the three
 * nearest column centres (the hex lattice's triangles), so its outline (an
 * isoline) is rounded rather than following the cells (round 12). kind 0
 * drift, 1 water.
 */
fn sheetDepth(p: vec2<f32>, kind: u32) -> f32 {
  let t = triAt(p);
  var s = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    s += t.w[k] * select(driftAt(q), water[colIdxI(q)], kind == 1u);
  }
  return s;
}

/** Withering plants dry out to straw and brown. */
fn wither(c: vec3<f32>, b: f32, n: f32) -> vec3<f32> {
  let dry = mix(vec3<f32>(0.55, 0.45, 0.22), vec3<f32>(0.36, 0.25, 0.13), smoothstep(0.5, 1.0, b) * (0.6 + 0.4 * n));
  return mix(c, toLinear(dry), smoothstep(0.05, 0.7, b));
}

const QUAD = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  @location(2) @interpolate(flat) info: vec2<u32>, // material, flags
  // large-scale ground patchiness; smooth, so evaluated per vertex (was per pixel)
  @location(3) tint: f32,
  // the box's z range (liquids derive depth from it)
  @location(4) @interpolate(flat) zr: vec2<f32>,
  // box bounds and its sway offset (sub-voxel canopies march inside the box;
  // a hex prism: its cell's centre - 0.5, and 1 x 1)
  @location(5) @interpolate(flat) bmin: vec3<f32>,
  @location(6) @interpolate(flat) bsize: vec3<f32>,
  @location(7) @interpolate(flat) boff: vec3<f32>,
  // a hex prism's hidden sides (bit k: toward neighbour k), and PRISM
  @location(8) @interpolate(flat) sides: u32,
};

const FLAG_VEG_R: u32 = 2u;
const FLAG_DETAIL: u32 = 128u;
const FLAG_TOP_R: u32 = 1u;
const PRISM: u32 = 64u;

