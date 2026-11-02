// ---- the pixel-art post pass (src/render/pixelpost.ts) ---------------------------------------------------------------
// The world rendered small (a pixel of it `px` CSS pixels) is drawn onto the screen, each of its pixels a block, through
// three filters shared by everything in view (not per asset): a dark outline where a nearer thing meets a farther one
// (the depth steps), the colours brought to a palette (the two nearest, ordered-dithered between by how near each is),
// and a lift of the darks toward the palette's darkest blue so the shadows read as the Rain World's, not black.

struct PostP {
  /** the small picture's size (px), the screen's (px) */
  src: vec4<f32>,
  /** x outline strength, y the depth step that makes an edge, z dither (0..1), w the palette's colours */
  k: vec4<f32>,
  /** x on (1) / straight through (0), y how far the darks are lifted, z the grade's warmth */
  m: vec4<f32>,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var<uniform> P: PostP;
@group(0) @binding(3) var<storage, read> pal: array<vec4<f32>>;

struct PVOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsPost(@builtin(vertex_index) vi: u32) -> PVOut {
  var o: PVOut;
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}

fn bayer4p(px: vec2<i32>) -> f32 {
  let i = vec2<u32>(px) & vec2<u32>(3u);
  let m = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
  return (f32(m[i.y * 4u + i.x]) + 0.5) / 16.0;
}

fn dep(t: vec2<i32>) -> f32 {
  let s = vec2<i32>(P.src.xy) - vec2<i32>(1);
  return textureLoad(depthTex, clamp(t, vec2<i32>(0), s), 0);
}

/** perceptual-ish distance (sRGB in, weighted) */
fn cdist(a: vec3<f32>, b: vec3<f32>) -> f32 {
  let d = a - b;
  let r = (a.r + b.r) * 0.5;
  return (2.0 + r) * d.r * d.r + 4.0 * d.g * d.g + (3.0 - r) * d.b * d.b;
}

@fragment
fn fsPost(in: PVOut) -> @location(0) vec4<f32> {
  let t = vec2<i32>(floor(in.uv * P.src.xy));
  var c = textureLoad(srcTex, t, 0).rgb;
  if (P.m.x < 0.5) { return vec4<f32>(c, 1.0); }
  // the outline: this pixel nearer than a neighbour by a step (its far side gets none: one pixel wide, on the near thing)
  let d0 = dep(t);
  var step = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = array<vec2<i32>, 4>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(0, -1))[k];
    step = max(step, dep(t + o) - d0);
  }
  let edge = smoothstep(P.k.y, P.k.y * 3.0, step) * select(1.0, 0.0, d0 >= 0.9999);
  c = mix(c, c * vec3<f32>(0.18, 0.17, 0.22), edge * P.k.x);
  // the grade: darks lifted toward a cold blue, a little warmth in the lights
  let lum = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  c = mix(c, vec3<f32>(0.07, 0.075, 0.11), P.m.y * (1.0 - smoothstep(0.0, 0.25, lum)));
  c *= vec3<f32>(1.0 + P.m.z * 0.06, 1.0, 1.0 - P.m.z * 0.06);
  // the palette: the two nearest, dithered between by how near
  let n = u32(P.k.w);
  var b0 = 0u;
  var b1 = 0u;
  var d0c = 1e9;
  var d1c = 1e9;
  for (var i = 0u; i < n; i++) {
    let p = pal[i].rgb;
    let d = cdist(c, p);
    if (d < d0c) {
      d1c = d0c;
      b1 = b0;
      d0c = d;
      b0 = i;
    } else if (d < d1c) {
      d1c = d;
      b1 = i;
    }
  }
  let f = sqrt(d0c) / max(sqrt(d0c) + sqrt(d1c), 1e-5);
  let pick = select(b0, b1, f * P.k.z * 2.0 > bayer4p(t));
  return vec4<f32>(pal[pick].rgb, 1.0);
}
