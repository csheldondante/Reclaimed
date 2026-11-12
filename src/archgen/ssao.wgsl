// (archgen) The lab's screen-space ambient occlusion (AG26; the user: "Can we do sceenspace AO?"). Two passes over the
// lab's scene: fsAo reads the depth (the orthographic camera's: a view-space point from a pixel and its depth is a
// scale and an offset) and counts how much of a hemisphere of points round each pixel lies behind what's drawn;
// fsComp blurs that 4×4 and darkens the scene by it. DEPTH_T is the depth texture's type (multisampled with MSAA:
// sample 0 read), swapped in by lab.ts.

struct AoParams {
  /** x, y the view's half width and height (world units), z, w the target's pixels */
  ext: vec4<f32>,
  /** x the radius (world units), y the strength (0 off … 1), z the depth range D (2000: lab.ts ortho), w 1 the occlusion alone */
  k: vec4<f32>,
};

@group(0) @binding(0) var dep: DEPTH_T;
@group(0) @binding(1) var<uniform> P: AoParams;

struct FO { @builtin(position) p: vec4<f32> };

@vertex
fn vsFull(@builtin(vertex_index) i: u32) -> FO {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FO;
  o.p = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn depthAt(px: vec2<i32>) -> f32 {
  let d = vec2<i32>(textureDimensions(dep));
  return textureLoad(dep, clamp(px, vec2<i32>(0), d - 1), 0);
}

/** a pixel's point in view space: x right, y up, z towards the eye (world units) */
fn viewAt(px: vec2<i32>, d: f32) -> vec3<f32> {
  let ndc = vec2<f32>((f32(px.x) + 0.5) / P.ext.z * 2.0 - 1.0, 1.0 - (f32(px.y) + 0.5) / P.ext.w * 2.0);
  return vec3<f32>(ndc * P.ext.xy, (0.5 - d) * 2.0 * P.k.z);
}

fn hash2(p: vec2<u32>) -> f32 {
  var h = p.x * 1664525u + p.y * 1013904223u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = h ^ (h >> 13u);
  return f32(h & 0xffffu) / 65535.0;
}

@fragment
fn fsAo(in: FO) -> @location(0) vec4<f32> {
  let px = vec2<i32>(in.p.xy);
  let d = depthAt(px);
  if (d >= 0.99999) { return vec4<f32>(1.0); }
  let p = viewAt(px, d);
  // the normal from the neighbours (each axis the side whose depth is nearer this one's: no smearing over edges)
  let r = viewAt(px + vec2<i32>(1, 0), depthAt(px + vec2<i32>(1, 0)));
  let l = viewAt(px - vec2<i32>(1, 0), depthAt(px - vec2<i32>(1, 0)));
  let t = viewAt(px - vec2<i32>(0, 1), depthAt(px - vec2<i32>(0, 1)));
  let b = viewAt(px + vec2<i32>(0, 1), depthAt(px + vec2<i32>(0, 1)));
  let dx = select(p - l, r - p, abs(r.z - p.z) < abs(p.z - l.z));
  let dy = select(b - p, p - t, abs(t.z - p.z) < abs(p.z - b.z));
  var n = normalize(cross(dx, dy));
  if (n.z < 0.0) { n = -n; }
  // a basis turned by a random angle per pixel (the 4×4 blur takes the noise out)
  let ang = hash2(vec2<u32>(u32(px.x) & 3u, u32(px.y) & 3u)) * 6.28318;
  let rv = vec3<f32>(cos(ang), sin(ang), 0.0);
  let tg = normalize(rv - n * dot(rv, n));
  let bt = cross(n, tg);
  let R = P.k.x;
  var occ = 0.0;
  let N = 16u;
  for (var i = 0u; i < N; i++) {
    // points spread over the hemisphere (a spiral), denser near the pixel
    let fi = (f32(i) + 0.5) / f32(N);
    let ph = f32(i) * 2.39996;
    let cz = sqrt(1.0 - fi);
    let sr = sqrt(fi);
    let dir = tg * cos(ph) * sr + bt * sin(ph) * sr + n * cz;
    let len = mix(0.15, 1.0, fi * fi) * R;
    let s = p + dir * len;
    let sp = vec2<i32>(i32((s.x / P.ext.x * 0.5 + 0.5) * P.ext.z), i32((0.5 - s.y / P.ext.y * 0.5) * P.ext.w));
    let sd = depthAt(sp);
    let sz = (0.5 - sd) * 2.0 * P.k.z;
    // occluded when what's drawn there is in front of the point; less so when it's far in front (a different object)
    let range = smoothstep(0.0, 1.0, R / max(abs(p.z - sz), 1e-4));
    occ += select(0.0, 1.0, sz > s.z + 0.03 && sd < 0.99999) * range;
  }
  return vec4<f32>(vec3<f32>(1.0 - occ / f32(N)), 1.0);
}

@group(0) @binding(2) var aoTex: texture_2d<f32>;
@group(0) @binding(3) var sceneTex: texture_2d<f32>;

@fragment
fn fsComp(in: FO) -> @location(0) vec4<f32> {
  let px = vec2<i32>(in.p.xy);
  let c = textureLoad(sceneTex, px, 0).rgb;
  let dm = vec2<i32>(textureDimensions(aoTex)) - 1;
  var a = 0.0;
  for (var j = -2; j < 2; j++) {
    for (var i = -2; i < 2; i++) { a += textureLoad(aoTex, clamp(px + vec2<i32>(i, j), vec2<i32>(0), dm), 0).r; }
  }
  a = a / 16.0;
  // (?aodbg=1: the occlusion alone)
  if (P.k.w > 0.5) { return vec4<f32>(vec3<f32>(a), 1.0); }
  return vec4<f32>(c * mix(1.0, a, P.k.y), 1.0);
}
