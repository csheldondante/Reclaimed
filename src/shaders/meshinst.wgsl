// ---- instanced meshes (round 99, ?meshinst=1; render/meshinst.ts) ---------------------------------------------
// Appended to render.wgsl (its bindings: instances = the instance list, the camera, the lighting, the shadow map).
// One indexed draw a kind; the kind is found from the vertex's index (MI_KINDS: each kind's vertex range), the
// instance in the list at kind × MI_CAP + instance_index. A vertex: x, y, z, part (0 trunk, 1 crown, 2 as it is).
// Faceted: the normal is the face's, from the position's derivatives (the vertices are shared).

struct MIOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  // kind, part, the instance's column (its pick and look), a per-instance random
  @location(1) @interpolate(flat) info: vec4<u32>,
  // local height share up the part (0 its foot, 1 its top): the crown darker underneath
  @location(2) h: f32,
};

fn miKind(vi: u32) -> u32 {
  var k = 0u;
  for (var i = 0u; i < MI_N; i++) { if (vi >= MI_KINDS[i].x && vi < MI_KINDS[i].y) { k = i; } }
  return k;
}
fn miRow(i: u32, r: u32) -> vec4<f32> { return bitcast<vec4<f32>>(instances[i * 4u + r]); }

@vertex
fn vsInst(@location(0) a: vec4<f32>, @builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MIOut {
  var o: MIOut;
  let k = miKind(vi);
  let i = k * MI_CAP + ii;
  let r0 = miRow(i, 0u);
  let r1 = miRow(i, 1u);
  let r2 = miRow(i, 2u);
  let p = miRow(i, 3u);
  let part = u32(a.w + 0.5);
  var l = a.xyz;
  var sway = 0.0;
  if (part == 0u) {
    l = vec3<f32>(a.xy, a.z * p.x);
    sway = a.z * 0.6;
  } else if (part == 1u) {
    // (the broadleaves thin in winter: the crown draws in a little)
    let bare = select(seasonBare() * 0.25, 0.0, k == 1u);
    l = vec3<f32>(a.xy * p.w * (1.0 - bare), p.y + a.z * p.z * (1.0 - bare * 0.5));
    sway = 1.0;
  }
  var wp = vec3<f32>(dot(r0.xyz, l) + r0.w, dot(r1.xyz, l) + r1.w, dot(r2.xyz, l) + r2.w);
  // the wind: the column's lean (sway.wgsl's spring) and a slow flutter, the crown shifting with the trunk's top
  let cell = clampCell(cellAt(vec2<f32>(r0.w, r1.w)));
  let lean = bend[colIdxI(cell)].xy;
  let amp = length(lean) / 0.3;
  let dir = lean / max(length(lean), 1e-4);
  let seed = fract(sin(dot(vec2<f32>(r0.w, r1.w), vec2<f32>(12.9898, 78.233))) * 43758.5453);
  let flutter = dir * sin(G.time * 2.2 + seed * 30.0) * 0.05 * (0.3 + amp);
  wp = wp + vec3<f32>((lean + flutter) * sway, 0.0);
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  // (ringwin: the pick's column in window order — the CPU reads it)
  o.info = vec4<u32>(k, part, winIdx(cell), u32(seed * 65535.0));
  o.h = a.z;
  return o;
}

@fragment
fn fsInst(in: MIOut) -> FOut {
  // (derivatives first: the cut may discard)
  var n = normalize(cross(dpdx(in.wpos), dpdy(in.wpos)));
  if (dot(n, toEye(in.wpos)) < 0.0) { n = -n; }
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  let k = in.info.x;
  let part = in.info.y;
  let rnd = f32(in.info.w) / 65535.0;
  var alb: vec3<f32>;
  var mat = MAT_WOOD;
  if (part == 0u) {
    alb = toLinear(MATS[MAT_WOOD].albedo.rgb) * (0.85 + 0.2 * rnd);
    if (k == 2u) {
      // birch bark: pale with dark marks
      let mark = randv(vec3<i32>(floor(in.wpos * vec3<f32>(4.0, 4.0, 6.0)))) < 0.18;
      alb = toLinear(select(vec3<f32>(0.82, 0.8, 0.74), vec3<f32>(0.2, 0.18, 0.16), mark));
    }
  } else {
    mat = MAT_LEAVES;
    var dark = vec3<f32>(0.14, 0.31, 0.11);
    var light = vec3<f32>(0.30, 0.52, 0.18);
    if (k == 1u) { dark = vec3<f32>(0.07, 0.2, 0.12); light = vec3<f32>(0.16, 0.34, 0.2); }
    if (k == 2u) { dark = vec3<f32>(0.3, 0.46, 0.16); light = vec3<f32>(0.55, 0.66, 0.28); }
    if (k == 3u) { dark = vec3<f32>(0.1, 0.24, 0.09); light = vec3<f32>(0.24, 0.42, 0.15); }
    // each face its own shade (a leaf cluster), lighter up the crown and on top
    let fr = randv(vec3<i32>(floor(in.wpos * 1.5)) + vec3<i32>(i32(in.info.w & 255u), 3, 7));
    var lc = mix(dark, light, clamp(0.25 + 0.45 * in.h + 0.25 * n.z + 0.2 * (fr - 0.5) + 0.15 * (rnd - 0.5), 0.0, 1.0));
    if (k != 1u) {
      let turned = autumnLeaf(k, fract(rnd * 0.75 + fr * 0.35)) * (0.72 + 0.3 * n.z);
      let sc = smoothstep(0.0, 0.3, seasonColour() * 1.3 - rnd * 0.3);
      lc = mix(lc, turned, sc);
      lc = mix(lc, vec3<f32>(0.4, 0.27, 0.14), seasonBare() * 0.6);
    }
    alb = toLinear(lc);
  }
  var col = alb * lighting(in.wpos, n);
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(in.info.z + 1u, pickInfo(mat, in.wpos.z, 0u));
  return o;
}
