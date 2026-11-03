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
  // (round 125) how far up into the canopy's shade a bole is under it (0 .. 1 at its cut top): it darkens into it
  @location(6) dark: f32,
  // (round 128, ?flod=sprite) a sprite's quad: its corner (0..1 across, up) and, flat, the two yaw cells it dissolves
  // between, the share of the second, the instance's yaw; its scale
  @location(7) suv: vec2<f32>,
  @location(8) @interpolate(flat) spr: vec4<f32>,
  @location(9) @interpolate(flat) sprS: f32,
  // (round 128) the bark's / leaf card's coordinates (mesh.ts uv)
  @location(10) uv: vec4<f32>,
};

// (round 128, treegen: the flora sprites — flora/sprites.ts, render/florasprites.ts) the atlas: albedo and coverage;
// the normal (the tree's frame, octahedral), the depth along the view (0 nearest), the material
@group(0) @binding(44) var sprAlb: texture_2d<f32>;
@group(0) @binding(45) var sprNd: texture_2d<f32>;
// (the shadow pass's pipeline sets it: a sprite kind casts its far mesh's shadow — part 13 — and draws no quad)
override SHADOW_PASS: bool = false;

fn miKind(vi: u32) -> u32 {
  var k = 0u;
  for (var i = 0u; i < MI_N; i++) { if (vi >= MI_KINDS[i].x && vi < MI_KINDS[i].y) { k = i; } }
  return k;
}
fn miRow(i: u32, r: u32) -> vec4<f32> { return bitcast<vec4<f32>>(instances[i * 4u + r]); }

@vertex
fn vsInst(@location(0) a: vec4<f32>, @location(1) uvIn: vec4<f32>, @builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MIOut {
  var o: MIOut;
  o.uv = uvIn;
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
  // (round 128, treegen) icicles exist only in deep winter: out of it they collapse off screen (no fill)
  if (fpart == 11u && seasonSnow() < 0.5) {
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  // (round 128, ?flod=sprite: a sprite kind is a quad for the eye (part 12) and its far mesh for the sun (part 13))
  if (fl && ((fpart == 12u && SHADOW_PASS) || (fpart == 13u && !SHADOW_PASS))) {
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  var wp = vec3<f32>(dot(r0.xyz, l) + r0.w, dot(r1.xyz, l) + r1.w, dot(r2.xyz, l) + r2.w);
  // the wind: the column's lean (sway.wgsl's spring) and a slow flutter, the crown shifting with the trunk's top
  let cell = clampCell(cellAt(vec2<f32>(r0.w, r1.w)));
  let lean = bend[colIdxI(cell)].xy;
  let amp = length(lean) / 0.3;
  let dir = lean / max(length(lean), 1e-4);
  let seed = fract(sin(dot(vec2<f32>(r0.w, r1.w), vec2<f32>(12.9898, 78.233))) * 43758.5453);
  let flutter = dir * sin(G.time * 2.2 + seed * 30.0) * 0.05 * (0.3 + amp);
  if (fl && fpart == 12u) {
    // (round 128) the sprite: a quad facing the eye from the instance's foot, the bake's bounds × its scale; the yaw
    // step the eye is at in the tree's frame and the next, dissolved between in the fragment
    let sp = FLORA_SPR[k];
    let foot = vec3<f32>(r0.w, r1.w, r2.w);
    let s = length(vec2<f32>(r0.x, r1.x));
    let yaw = atan2(r1.x, r0.x);
    let e = normalize(CAM.eye.xyz);
    let right = normalize(vec3<f32>(-e.y, e.x, 0.0));
    let up = cross(e, right);
    let N = f32(FLORA_SPR_YAWS);
    var t = (atan2(e.y, e.x) - yaw) / 6.2831853 * N;
    t = t - floor(t / N) * N;
    let j0 = min(u32(floor(t)), FLORA_SPR_YAWS - 1u);
    let j1 = (j0 + 1u) % FLORA_SPR_YAWS;
    let base = u32(sp.x) * FLORA_SPR_YAWS;
    var swp = foot + right * ((a.x - 0.5) * 2.0 * sp.y * s) + up * ((sp.z + a.y * (sp.w - sp.z)) * s);
    // (the wind: the trunk's sway at the quad's top — floraSway's lean for wood — and 1A in the fragment)
    if ((FWIND & 1u) != 0u) { swp = swp + floraSway(k, 3u, a.xyz, sway, vec2<f32>(r0.w, r1.w), lean, seed, G.time); }
    o.pos = CAM.viewProj * vec4<f32>(swp, 1.0);
    o.wpos = swp;
    o.info = vec4<u32>(k, 12u, winIdx(cell), u32(seed * 65535.0));
    o.h = sway;
    o.foot = foot;
    o.wind = vec3<f32>(dir, amp);
    o.suv = a.xy;
    o.spr = vec4<f32>(f32(base + j0), f32(base + j1), t - floor(t), yaw);
    o.sprS = s;
    return o;
  }
  if (!fl) {
    wp = wp + vec3<f32>((lean + flutter) * sway, 0.0);
  } else {
    // (flora: floralook.wgsl, shared with the viewer page; round 125: FWIND's treatments — 0 the static baseline)
    let foot = vec3<f32>(r0.w, r1.w, r2.w);
    var off = vec3<f32>(0.0);
    if ((FWIND & 1u) != 0u) { off = floraSway(k, fpart, a.xyz, sway, vec2<f32>(r0.w, r1.w), lean, seed, G.time); }
    let H = FLORA_COL[k * 6u + 4u].w;
    if ((FWIND & 4u) != 0u && H > 5.0 && (fpart == 3u || fpart == 4u || fpart == 14u)) {
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
  o.dark = 0.0;
  if (fl && CAM.under[0].w > 0.0) {
    let cb = FLORA_CROWN[k];
    // (the bole kept under the canopy ends where its limbs went: it darkens over the last few cells into the crowns'
    // shade — no pale cap against the dark)
    if (cb.x < 1e8 && fpart == 3u) { o.dark = CAM.under[0].w * CAM.under[1].z * smoothstep(cb.x - 5.0, cb.x + 1.0, a.z); }
    let limb = fpart == 4u || fpart == 14u || (fpart == 3u && a.z > cb.x && length(a.xy) > cb.y * 1.15);
    if (cb.x < 1e8 && limb) {
      let foot = vec3<f32>(r0.w, r1.w, r2.w);
      // (round the hero as far as a crown can reach onto the screen: the crowns of trees 50+ cells in front lift into
      // its lower half)
      let c = CAM.under[0].w * CAM.under[1].z * (1.0 - smoothstep(100.0, 120.0, length(foot.xy - CAM.under[0].xy)));
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
  // (round 128: the bark's coordinates' footprint and tangents — derivatives, so before any discard)
  let fw = max(fwidth(in.uv.xy).x, fwidth(in.uv.xy).y);
  let tb = floraTangents(in.wpos, in.uv.xy, n);
  // (a canopy lobe shades round: its smooth normal)
  n = floraSmoothN(in.uv, n);
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  // (round 125, forest: under the canopy, what hides the floor round the hero dithered out — understory.wgsl)
  // (round 125: the stumps in front cut clean, no stipple; the canopy's own dither only while it fades in or out)
  if (underHide(in.wpos, in.foot) > 0.5 || in.cut > bayer4(in.pos.xy)) { discard; }
  let hd = underStumpFade(in.wpos, in.foot);
  let k = in.info.x;
  let part = in.info.y;
  let rnd = f32(in.info.w) / 65535.0;
  var alb: vec3<f32>;
  var mat = MAT_WOOD;
  if (part >= 3u) {
    // (round 117, flora) the generated species' look (floralook.wgsl, shared with the viewer page)
    let fl = floraLook(k, part, in.wpos, n, in.h, rnd, in.info.w, in.uv.xy, fw);
    n = floraBump(k, part, in.uv.xy, n, tb, fw);
    if (fl.w < 0.0) { discard; }
    mat = u32(fl.w);
    alb = toLinear(fl.rgb);
    // (round 125: wood fading out into the canopy darkens as it goes — into the crowns' shade)
    // (and a stump in front darkens toward its fading top: it fades, not just thins)
    alb *= 1.0 - 0.6 * in.cut;
    alb *= 1.0 - 0.85 * in.dark;
    // (a stump darkens toward its cut top: it fades into the floor's shade)
    alb *= 1.0 - 0.75 * hd;
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

// ---- (round 128, ?flod=sprite) the flora sprites' draw ----------------------------------------------------------
// A texel of the yaw step's cell (dissolved into the next by the ordered dither as the eye turns): its albedo, its
// normal turned by the instance's yaw, its point rebuilt from the depth along the view — lit as the mesh trees are
// (lighting: the sun, the sky, the shadow map; haze) and written to the depth buffer at that point, so a sprite meets
// the ground and its neighbours where the mesh tree would.
struct SOut {
  @location(0) color: vec4<f32>,
  @location(1) pick: vec2<u32>,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fsSprite(in: MIOut) -> SOut {
  let cell = u32(select(in.spr.x, in.spr.y, bayer4(in.pos.xy) < in.spr.z));
  // (round 128: the mip by the sprite's size on screen — its texels a pixel, the level where that's about one: the
  // sprite's level of detail)
  let k = in.info.x;
  let quadPx = 2.0 * FLORA_SPR[k].y * in.sprS * CAM.viewport.z;
  let lvl = u32(clamp(floor(log2(max(f32(FLORA_SPR_CELL) / max(quadPx, 1.0), 1.0))), 0.0, f32(FLORA_SPR_LEVELS - 1u)));
  let C = f32(FLORA_SPR_CELL >> lvl);
  let cx = f32(cell % FLORA_SPR_COLS);
  let cy = f32(cell / FLORA_SPR_COLS);
  let tx = vec2<i32>(i32(cx * C + clamp(in.suv.x, 0.0, 0.999) * C), i32(cy * C + (1.0 - clamp(in.suv.y, 0.001, 1.0)) * C));
  let alb = textureLoad(sprAlb, tx, i32(lvl));
  if (alb.a < 0.5) { discard; }
  let nd = textureLoad(sprNd, tx, i32(lvl));
  let q = nd.xy * 2.0 - 1.0;
  var nl = vec3<f32>(q, 1.0 - abs(q.x) - abs(q.y));
  if (nl.z < 0.0) { nl = vec3<f32>((1.0 - abs(nl.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), nl.xy >= vec2<f32>(0.0)), nl.z); }
  nl = normalize(nl);
  let cw = cos(in.spr.w);
  let sw = sin(in.spr.w);
  let n = vec3<f32>(cw * nl.x - sw * nl.y, sw * nl.x + cw * nl.y, nl.z);
  let b2 = FLORA_SPR2[k];
  let along = (b2.x + (1.0 - nd.z) * (b2.y - b2.x)) * in.sprS;
  let wpos = in.wpos + normalize(CAM.eye.xyz) * along;
  if (cutAway(wpos, in.pos.xy)) { discard; }
  let mat = u32(round(nd.w * 64.0));
  var a3 = toLinear(alb.rgb);
  // (1A: the wind-shading ripple, as the mesh's leaves)
  if ((FWIND & 2u) != 0u && mat == MAT_LEAVES) {
    let g = floraGust(wpos.xy, G.org.xy, in.wind.xy, in.wind.z, G.time);
    a3 *= 1.0 + (g - 0.5) * (0.12 + 0.25 * min(in.wind.z, 1.5));
  }
  var col = a3 * lighting(wpos, n);
  col = haze(col, wpos);
  var o: SOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(in.info.z + 1u, pickInfo(mat, wpos.z, 0u));
  let cp = CAM.viewProj * vec4<f32>(wpos, 1.0);
  o.depth = clamp(cp.z / cp.w, 0.0, 1.0);
  return o;
}
