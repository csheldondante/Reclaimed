// (tilekit, docs/design/TILEKIT.md §5, §10) The tile kit's draw: a module vertex (x with an anchor, w out of the wall,
// z up; kit.ts) swept along its instance's cell edge with mitred ends (sweep.ts is the same on the CPU), or a world
// vertex (anchor 4: roofs, ground); then displaced by the control grid (wonk, sag) with its normal corrected by the
// field's gradient. Lit like archlab (Townscaper's peach key, teal shade, warm bounce), the sun's shadow map, the
// module's baked occlusion; ssao.wgsl runs after on the depth.

struct View {
  vp: mat4x4<f32>,
  sunVP: mat4x4<f32>,
  /** towards the sun, its strength */
  sun: vec4<f32>,
  /** the control grid: origin xyz, w 1 on */
  ctlO: vec4<f32>,
  /** its step xyz */
  ctlS: vec4<f32>,
  /** its points a side xyz */
  ctlD: vec4<f32>,
  /** x shadows on, y baked occlusion on, z ground z, w debug (1 normals, 2 baked occlusion alone) */
  misc: vec4<f32>,
  /** (step 3) x the light: 0 step 2's, 1 step 3's (sky by direction, warm ground and facade bounce); y bounce strength,
   *  z sky strength, w the baked occlusion's weight */
  light: vec4<f32>,
};

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> INST: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> CTL: array<vec4<f32>>;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowCmp: sampler_comparison;

struct VIn {
  /** x w z anchor */
  @location(0) a: vec4<f32>,
  /** normal (x w z frame), baked occlusion */
  @location(1) b: vec4<f32>,
  /** colour, material */
  @location(2) c: vec4<f32>,
};

struct VO {
  @builtin(position) p: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) ao: f32,
  @location(4) @interpolate(flat) mat: u32,
};

fn ctlAt(i: i32, j: i32, k: i32) -> vec3<f32> {
  let d = vec3<i32>(V.ctlD.xyz);
  let q = clamp(vec3<i32>(i, j, k), vec3<i32>(0), d - 1);
  return CTL[(q.z * d.y + q.y) * d.x + q.x].xyz;
}

/** the control grid's displacement at p (trilinear) */
fn disp(p: vec3<f32>) -> vec3<f32> {
  if (V.ctlO.w < 0.5) { return vec3<f32>(0.0); }
  let g = clamp((p - V.ctlO.xyz) / V.ctlS.xyz, vec3<f32>(0.0), V.ctlD.xyz - 1.0);
  let i0 = vec3<i32>(floor(g));
  let f = g - floor(g);
  let c00 = mix(ctlAt(i0.x, i0.y, i0.z), ctlAt(i0.x + 1, i0.y, i0.z), f.x);
  let c10 = mix(ctlAt(i0.x, i0.y + 1, i0.z), ctlAt(i0.x + 1, i0.y + 1, i0.z), f.x);
  let c01 = mix(ctlAt(i0.x, i0.y, i0.z + 1), ctlAt(i0.x + 1, i0.y, i0.z + 1), f.x);
  let c11 = mix(ctlAt(i0.x, i0.y + 1, i0.z + 1), ctlAt(i0.x + 1, i0.y + 1, i0.z + 1), f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

struct Placed {
  pos: vec3<f32>,
  n: vec3<f32>,
  tint: vec3<f32>,
};

/** kit.ts's anchors: from the start, from the end, from the middle, a fraction; 4 world */
fn place(v: VIn, ii: u32) -> Placed {
  var o: Placed;
  let anchor = u32(v.a.w + 0.5);
  if (anchor == 4u) {
    o.pos = v.a.xyz;
    o.n = v.b.xyz;
    o.tint = vec3<f32>(1.0);
  } else {
    let i0 = INST[ii * 4u];
    let i1 = INST[ii * 4u + 1u];
    let i2 = INST[ii * 4u + 2u];
    let i3 = INST[ii * 4u + 3u];
    let A = i0.xy;
    let B = i0.zw;
    let L = length(B - A);
    let t = (B - A) / L;
    let nr = vec2<f32>(t.y, -t.x);
    var al = v.a.x;
    if (anchor == 1u) { al = L - v.a.x; }
    if (anchor == 2u) { al = L * 0.5 + v.a.x; }
    if (anchor == 3u) { al = v.a.x * L; }
    var nx = v.b.x;
    if (i2.y > 0.5) {
      al = L - al;
      nx = -nx;
    }
    let s = al / L;
    let xy = A + (B - A) * s + v.a.y * mix(i1.xy, i1.zw, s);
    o.pos = vec3<f32>(xy, i2.x + v.a.z);
    o.n = vec3<f32>(t * nx + nr * v.b.y, v.b.z);
    o.tint = i3.xyz;
  }
  // the control grid: the position moved, the normal by the field's gradient (n' = n − Jᵀn, first order)
  if (V.ctlO.w > 0.5) {
    let h = 0.3;
    let dx = (disp(o.pos + vec3<f32>(h, 0.0, 0.0)) - disp(o.pos - vec3<f32>(h, 0.0, 0.0))) / (2.0 * h);
    let dy = (disp(o.pos + vec3<f32>(0.0, h, 0.0)) - disp(o.pos - vec3<f32>(0.0, h, 0.0))) / (2.0 * h);
    let dz = (disp(o.pos + vec3<f32>(0.0, 0.0, h)) - disp(o.pos - vec3<f32>(0.0, 0.0, h))) / (2.0 * h);
    o.n = o.n - vec3<f32>(dot(dx, o.n), dot(dy, o.n), dot(dz, o.n));
    // (the ground stays put: only what stands above it moves)
    if (o.pos.z > V.misc.z + 0.01) { o.pos += disp(o.pos); }
  }
  o.n = normalize(o.n);
  return o;
}

@vertex
fn vsMain(v: VIn, @builtin(instance_index) ii: u32) -> VO {
  let pl = place(v, ii);
  var o: VO;
  o.p = V.vp * vec4<f32>(pl.pos, 1.0);
  o.wpos = pl.pos;
  o.n = pl.n;
  let mat = u32(v.c.w + 0.5);
  o.col = select(v.c.rgb, v.c.rgb * pl.tint, mat == 0u);
  o.ao = select(1.0, v.b.w, V.misc.y > 0.5);
  o.mat = mat;
  return o;
}

/** (step 3) the contact shadow: a strip on the ground along each ground-floor wall, multiplied onto what is drawn
 *  (blend dst × src), dark at the wall (its vertices' occlusion) fading out */
@fragment
fn fsDecal(in: VO) -> @location(0) vec4<f32> {
  let k = smoothstep(0.0, 1.0, in.ao);
  return vec4<f32>(vec3<f32>(mix(0.5, 1.0, k)), 1.0);
}

@vertex
fn vsShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  return V.sunVP * vec4<f32>(place(v, ii).pos, 1.0);
}

fn shadowAt(p: vec3<f32>, n: vec3<f32>) -> f32 {
  if (V.misc.x < 0.5) { return 1.0; }
  let c = V.sunVP * vec4<f32>(p + n * 0.04, 1.0);
  let uv = vec2<f32>(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
  let ts = 1.0 / f32(textureDimensions(shadowMap).x);
  var s = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      s += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2<f32>(f32(i), f32(j)) * ts * 1.5, c.z - 0.0015);
    }
  }
  return s / 9.0;
}

fn h21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }

@fragment
fn fsMain(in: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4<f32> {
  var n = normalize(in.n);
  var col = in.col;
  if (in.mat == 3u) {
    // roof tiles: courses along the contours (z), joints staggered a course
    let course = in.wpos.z / 0.21;
    let row = floor(course);
    let along = dot(in.wpos.xy, normalize(vec2<f32>(-n.y, n.x) + vec2<f32>(1e-4))) / 0.26 + row * 0.5;
    let edge = smoothstep(0.0, 0.18, fract(course)) * (0.85 + 0.15 * smoothstep(0.0, 0.08, abs(fract(along) - 0.5) * 2.0 - 0.0));
    col = col * (0.8 + 0.2 * edge) * (0.93 + 0.12 * h21(vec2<f32>(row, floor(along))));
  }
  if (in.mat == 4u) {
    col = col * (0.95 + 0.08 * h21(floor(in.wpos.xy * 2.0)));
  }
  if (V.misc.w > 0.5 && V.misc.w < 1.5) { return vec4<f32>(n * 0.5 + 0.5, 1.0); }
  if (V.misc.w > 1.5) { return vec4<f32>(vec3<f32>(in.ao), 1.0); }
  let L = normalize(V.sun.xyz);
  let ndl = max(dot(n, L), 0.0) * shadowAt(in.wpos, n);
  let sunC = vec3<f32>(1.0, 0.78, 0.62) * V.sun.w * 1.25;
  let above = max(in.wpos.z - V.misc.z, 0.0);
  var lit: vec3<f32>;
  if (V.light.x < 0.5) {
    let sky = mix(vec3<f32>(0.2, 0.3, 0.36), vec3<f32>(0.34, 0.48, 0.6), n.z * 0.5 + 0.5);
    let bounce = vec3<f32>(0.16, 0.11, 0.08) * max(-n.z, 0.0);
    let foot = mix(0.6, 1.0, smoothstep(0.0, 4.0, above));
    lit = col * (sunC * ndl + (sky * foot + bounce) * 0.9 * in.ao);
  } else {
    // (step 3) the shade is lit by three things, so it is not one tone: the sky (bluer overhead and on sides facing
    // away from the sun, a warmer grey at the horizon on sides facing it), the sunlit ground below (warm, strongest
    // low on a wall, nothing on a roof), and the sunlit facades across the street (warm, on sides facing away)
    let side = 1.0 - abs(n.z);
    let away = (0.5 - 0.5 * dot(normalize(n.xy + vec2<f32>(1e-4)), normalize(L.xy + vec2<f32>(1e-4)))) * side;
    let skyUp = vec3<f32>(0.33, 0.45, 0.58);
    let skyHor = vec3<f32>(0.45, 0.45, 0.45);
    var sky = mix(skyHor, skyUp, clamp(n.z * 0.6 + 0.4, 0.0, 1.0));
    sky = mix(sky, sky * vec3<f32>(0.88, 0.97, 1.1), away);
    let ground = vec3<f32>(0.62, 0.5, 0.38);
    let low = mix(1.0, 0.5, smoothstep(0.0, 10.0, above));
    let bounce = ground * sunC * max(L.z, 0.0) * V.light.y * clamp(0.5 - 0.5 * n.z, 0.0, 1.0) * low;
    let facade = vec3<f32>(0.62, 0.5, 0.4) * sunC * V.light.y * 0.3 * away;
    let foot = mix(0.72, 1.0, smoothstep(0.0, 3.0, above));
    let ao = mix(1.0, in.ao, V.light.w);
    lit = col * (sunC * ndl + (sky * V.light.z * foot + bounce + facade) * ao);
  }
  if (in.mat == 2u) {
    // glass: dark, the sky in it by the view's fresnel (a fixed sky tone)
    let fr = 0.25 + 0.5 * pow(1.0 - abs(n.z), 3.0);
    lit = mix(col * 0.6, vec3<f32>(0.45, 0.58, 0.68), fr * 0.5) * (0.6 + 0.4 * in.ao);
  }
  return vec4<f32>(pow(lit, vec3<f32>(1.0 / 1.1)), 1.0);
}
