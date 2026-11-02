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
  // (round 125, forest) the instance's foot (world): the understory's dither asks where the tree stands
  @location(3) @interpolate(flat) foot: vec3<f32>,
  // (round 125, 1A) the wind over the plant: xy the way it blows, z its strength (the column's lean over its full)
  @location(4) @interpolate(flat) wind: vec3<f32>,
  // (round 125) how far into the canopy's cut this vertex is (0 kept .. 1 gone: compared with the dither)
  @location(5) cut: f32,
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
  // (round 119: the kind from the vertex's w — render/meshinst.ts adds 16 × kind — not a search of MI_KINDS)
  let k = u32(floor(a.w / 16.0));
  let aw = a.w - f32(k) * 16.0;
  let i = k * MI_CAP + ii;
  let r0 = miRow(i, 0u);
  let r1 = miRow(i, 1u);
  let r2 = miRow(i, 2u);
  let p = miRow(i, 3u);
  let part = u32(aw + 0.5);
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
  // (round 117, flora) a generated plant's vertex (src/flora/mesh.ts): parts 3+ taken as they are, w = part + sway
  let fpart = u32(floor(aw));
  let fl = fpart >= 3u;
  if (fl) { sway = fract(aw); }
  var wp = vec3<f32>(dot(r0.xyz, l) + r0.w, dot(r1.xyz, l) + r1.w, dot(r2.xyz, l) + r2.w);
  // the wind: the column's lean (sway.wgsl's spring) and a slow flutter, the crown shifting with the trunk's top
  let cell = clampCell(cellAt(vec2<f32>(r0.w, r1.w)));
  let lean = bend[colIdxI(cell)].xy;
  let amp = length(lean) / 0.3;
  let dir = lean / max(length(lean), 1e-4);
  let seed = fract(sin(dot(vec2<f32>(r0.w, r1.w), vec2<f32>(12.9898, 78.233))) * 43758.5453);
  let flutter = dir * sin(G.time * 2.2 + seed * 30.0) * 0.05 * (0.3 + amp);
  if (!fl) {
    wp = wp + vec3<f32>((lean + flutter) * sway, 0.0);
  } else {
    // (flora: floralook.wgsl, shared with the viewer page; round 125: FWIND's treatments — 0 the static baseline)
    let foot = vec3<f32>(r0.w, r1.w, r2.w);
    var off = vec3<f32>(0.0);
    if ((FWIND & 1u) != 0u) { off = floraSway(k, fpart, a.xyz, sway, vec2<f32>(r0.w, r1.w), lean, seed, G.time); }
    let H = FLORA_COL[k * 6u + 4u].w;
    if ((FWIND & 4u) != 0u && H > 5.0 && (fpart == 3u || fpart == 4u)) {
      // (a tree: its crown through the coarse lattice, the column's spring's share of the lean taken off — the lattice
      // carries the gust; scaled into the instance's height)
      let hs = length(r2.xyz);
      off = off * 0.5 + floraLattice(wp, foot, H * hs, FLORA_COL[k * 6u + 5u].w * hs * 0.6, sway, lean, FLORA_COL[k * 6u + 1u].w, G.org.xy, G.time);
    }
    wp = wp + off;
  }
  // (round 125, forest: under the canopy only the trunks are drawn — the user: "Just the s shadows and the trunks". A tree's
  // leaves, and its wood over the crown's base away from the bole's axis (the limbs), dither out with the understory's
  // weight round the hero and once it's whole aren't drawn at all — the fill saved; the sun's camera has no understory,
  // so the shadow pass keeps every leaf and the floor's dapple stays)
  o.cut = 0.0;
  if (fl && CAM.under[0].w > 0.0) {
    let cb = FLORA_CROWN[k];
    let limb = fpart == 4u || (fpart == 3u && a.z > cb.x && length(a.xy) > cb.y * 1.6);
    if (cb.x < 1e8 && limb) {
      let foot = vec3<f32>(r0.w, r1.w, r2.w);
      let c = CAM.under[0].w * CAM.under[1].z * (1.0 - smoothstep(48.0, 62.0, length(foot.xy - CAM.under[0].xy)));
      if (c >= 0.999) {
        o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return o;
      }
      o.cut = c;
    }
  }
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  // (ringwin: the pick's column in window order — the CPU reads it)
  o.info = vec4<u32>(k, select(part, fpart, fl), winIdx(cell), u32(seed * 65535.0));
  // (flora: the sway weight stands in for the height share up the plant — it rises with it)
  o.h = select(a.z, sway, fl);
  o.foot = vec3<f32>(r0.w, r1.w, r2.w);
  o.wind = vec3<f32>(dir, amp);
  return o;
}

@fragment
fn fsInst(in: MIOut) -> FOut {
  // (derivatives first: the cut may discard)
  var n = normalize(cross(dpdx(in.wpos), dpdy(in.wpos)));
  if (dot(n, toEye(in.wpos)) < 0.0) { n = -n; }
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  // (round 125, forest: under the canopy, what hides the floor round the hero dithered out — understory.wgsl)
  if (max(underHide(in.wpos, in.foot), in.cut) > bayer4(in.pos.xy)) { discard; }
  let k = in.info.x;
  let part = in.info.y;
  let rnd = f32(in.info.w) / 65535.0;
  var alb: vec3<f32>;
  var mat = MAT_WOOD;
  if (part >= 3u) {
    // (round 117, flora) the generated species' look (floralook.wgsl, shared with the viewer page)
    let fl = floraLook(k, part, in.wpos, n, in.h, rnd, in.info.w);
    if (fl.w < 0.0) { discard; }
    mat = u32(fl.w);
    alb = toLinear(fl.rgb);
    // (round 125, 1A: the wind-shading ripple — a gust's front brightens the leaves and blades it turns over, the
    // trough behind it darker; the silhouette stays)
    if ((FWIND & 2u) != 0u && (part == 4u || part == 5u)) {
      let g = floraGust(in.wpos.xy, G.org.xy, in.wind.xy, in.wind.z, G.time);
      alb *= 1.0 + (g - 0.5) * (0.12 + 0.25 * min(in.wind.z, 1.5));
    }
  } else if (part == 0u) {
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
