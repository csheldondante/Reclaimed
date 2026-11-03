// ---- the flora sprites' mips (round 128, `treegen`; render/florasprites.ts) --------------------------------------
// One level from the one above: each texel from its four children. The rules keep a far tree a tree:
//   alpha     the children's mean × 2, capped (a quarter of them covered keeps it: thin twigs and leaf cards don't thin
//             to nothing as the sprite shrinks; the silhouette keeps its size)
//   colour    the covered children's mean (the uncovered ones' black would darken the edge)
//   normal    the covered children's octahedral normals decoded, averaged, renormalised
//   depth     the nearest covered child's (0 nearest: the minimum) — an average would push the edge back and float it
//   material  the most covered child's

@group(0) @binding(0) var srcAlb: texture_2d<f32>;
@group(0) @binding(1) var srcNd: texture_2d<f32>;

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn octDecode(q: vec2<f32>) -> vec3<f32> {
  let o = q * 2.0 - 1.0;
  var n = vec3<f32>(o, 1.0 - abs(o.x) - abs(o.y));
  if (n.z < 0.0) { n = vec3<f32>((1.0 - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0)), n.z); }
  return normalize(n);
}
fn octEncode(n: vec3<f32>) -> vec2<f32> {
  var o = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { o = (1.0 - abs(o.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), o >= vec2<f32>(0.0)); }
  return o * 0.5 + 0.5;
}

struct MOut {
  @location(0) alb: vec4<f32>,
  @location(1) nd: vec4<f32>,
};

@fragment
fn fsMip(@builtin(position) pos: vec4<f32>) -> MOut {
  let p = vec2<i32>(pos.xy) * 2;
  var a = 0.0;
  var col = vec3<f32>(0.0);
  var nrm = vec3<f32>(0.0);
  var depth = 1.0;
  var bestA = -1.0;
  var mat = 0.0;
  var cov = 0.0;
  for (var j = 0; j < 4; j++) {
    let q = p + vec2<i32>(j & 1, j >> 1);
    let c = textureLoad(srcAlb, q, 0);
    let d = textureLoad(srcNd, q, 0);
    a += c.a;
    if (c.a > 0.01) {
      col += c.rgb * c.a;
      cov += c.a;
      nrm += octDecode(d.xy) * c.a;
      depth = min(depth, d.z);
      if (c.a > bestA) {
        bestA = c.a;
        mat = d.w;
      }
    }
  }
  var o: MOut;
  if (cov <= 0.0) {
    o.alb = vec4<f32>(0.0);
    o.nd = vec4<f32>(0.5, 0.5, 1.0, 0.0);
    return o;
  }
  o.alb = vec4<f32>(col / cov, min(1.0, a * 0.25 * 2.0));
  o.nd = vec4<f32>(octEncode(normalize(nrm)), depth, mat);
  return o;
}
