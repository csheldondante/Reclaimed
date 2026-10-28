// ---- atlas/bake.wgsl -------------------------------------------------------
// (round 94, the user: "I don't understand why towns and grass aren't baked into a texture we can stream so that
// distant tiles draw correctly further out") The land past the window baked once into a texture: a level a ring
// (and one for the far land), each a square of N × N texels round the camera, a texel half the ring's spacing,
// anchored to the world (texel (I, J) at (I, J) · its size, held in slot (I mod N, J mod N): as the camera moves
// only the strips new to a level are baked). A texel is what the window would draw there, averaged over it: the
// ground's top (lod.wgsl surfaceAt — the rings' rules), the grass by the plants the window starts with, the ways
// paved, water by its depth, the woods' crowns and the shade under them, and the towns (their plans' tops: bake.ts
// stamps). Lit in the draw (far.wgsl): the light changes, the albedo doesn't. Appended to lod.wgsl.

struct BakeP {
  /** the texels baked: the first (world texel indices, unwrapped), how many across and down */
  rect: vec4<i32>,
  /** world units a texel, texels a side (N), the level (its layer), the plants the window's sim has grown on soil */
  lv: vec4<f32>,
  /** the season (0..1) */
  look: vec4<f32>,
}
@group(0) @binding(54) var<storage, read> bakeStamps: array<u32>;
@group(0) @binding(55) var<uniform> BP: BakeP;
@group(0) @binding(56) var bakeOut: texture_storage_2d_array<rgba8unorm, write>;

fn bLin(c: vec3<f32>) -> vec3<f32> { return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2)); }
fn bSrgb(c: vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }
fn bRand(q: vec2<i32>, s: u32) -> f32 { return hf(hash2u(q.x, q.y, AP.seed * 31u + s)); }

/** far.wgsl gSeasonGrass (the season: BP.look.x) */
fn bSeasonGrass(g: vec3<f32>, h: f32) -> vec3<f32> {
  let s = BP.look.x;
  let colour = smoothstep(0.35, 0.55, s) * (1.0 - smoothstep(0.85, 0.92, s));
  let bare = smoothstep(0.55, 0.78, s) * (1.0 - smoothstep(0.9, 1.0, s));
  let straw = mix(vec3<f32>(0.62, 0.52, 0.22), vec3<f32>(0.7, 0.6, 0.3), h);
  let c = mix(g, straw, colour * (0.45 + 0.4 * h));
  return mix(c, vec3<f32>(0.46, 0.39, 0.24) * (0.9 + 0.2 * h), bare * 0.75);
}

/**
 * The stamps over world point p (bake.ts: a town's plan, its tops' colours, sRGB, its cover in a): the finest raster
 * (a texel a world unit), or `coarse` its 4-unit average. Header: count; then 8 words a stamp (its corner x, y as f32
 * bits; w, h, offset of the 1-unit raster; w, h, offset of the 4-unit one); then the texels.
 */
fn stampAt(p: vec2<f32>, coarse: bool) -> vec4<f32> {
  let n = bakeStamps[0];
  var o = vec4<f32>(0.0);
  let size = vec2<f32>(AP.worldW, AP.worldH);
  for (var k = 0u; k < n; k++) {
    let b = 4u + k * 8u;
    var d = p - vec2<f32>(bitcast<f32>(bakeStamps[b]), bitcast<f32>(bakeStamps[b + 1u]));
    d -= floor(d / size) * size;
    var sc = 1.0;
    var w = bakeStamps[b + 2u];
    var h = bakeStamps[b + 3u];
    var off = bakeStamps[b + 4u];
    if (coarse) {
      sc = 4.0;
      w = bakeStamps[b + 5u];
      h = bakeStamps[b + 6u];
      off = bakeStamps[b + 7u];
    }
    let q = vec2<i32>(floor(d / sc));
    if (q.x < 0 || q.y < 0 || q.x >= i32(w) || q.y >= i32(h)) { continue; }
    let px = unpack4x8unorm(bakeStamps[off + u32(q.y) * w + u32(q.x)]);
    if (px.a > o.a) { o = px; }
  }
  return o;
}

/** far.wgsl's trees (vegplan.wgsl's woods: a crown on a 3-unit lattice square where the plants are a wood's), seen
 *  from above at q: x the crown's cover, y the shade on the ground round it; rgb its colour (linear, lit from above) */
struct BTree { cover: f32, shade: f32, c: vec3<f32> }
const B_TREE_STEP: f32 = 3.0;
const B_TREE_P: f32 = 0.34;
fn treesAt(q: vec2<f32>, dens: f32) -> BTree {
  var t = BTree(0.0, 0.0, vec3<f32>(0.0));
  let b0 = vec2<i32>(floor(q / B_TREE_STEP));
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let bq = b0 + vec2<i32>(i, j);
      let r0 = bRand(bq, 4242u);
      if (r0 >= B_TREE_P * dens) { continue; }
      let r1 = bRand(bq, 321u);
      let r2 = bRand(bq, 7u);
      let foot = (vec2<f32>(bq) + vec2<f32>(0.2 + 0.6 * r1, 0.2 + 0.6 * r2)) * B_TREE_STEP;
      let conifer = r1 < 0.42;
      let R = select(1.3 + 0.7 * r1, 0.9 + 0.5 * r2, conifer);
      let d = length(q - foot) / R;
      t.shade = max(t.shade, 1.0 - smoothstep(1.0, 1.45, d));
      if (d < 1.0 && t.cover < 1.0) {
        t.cover = 1.0;
        var leaf = select(vec3<f32>(0.2, 0.36, 0.13), vec3<f32>(0.13, 0.27, 0.13), conifer) * (0.85 + 0.3 * r0 / B_TREE_P);
        if (!conifer) { leaf = bSeasonGrass(leaf, r2) * 0.5 + leaf * 0.5; }
        // (lit as a ball from above: brighter at its top)
        t.c = bLin(leaf) * (0.72 + 0.4 * sqrt(max(1.0 - d * d, 0.0)));
      }
    }
  }
  return t;
}

/**
 * A texel of a level: the window's look averaged over it, its albedo (sRGB) and in a what it is — land 0..0.5 (the
 * grass's cover × 0.5: the draw's finest levels vary it a quarter cell as the window does), water 0.75 (its colour by
 * depth, lit from above in the draw), 1 glowing (lava: drawn as it is).
 */
@compute @workgroup_size(8, 8)
fn bakeSurface(@builtin(global_invocation_id) id: vec3<u32>) {
  if (i32(id.x) >= BP.rect.z || i32(id.y) >= BP.rect.w) { return; }
  let I = BP.rect.x + i32(id.x);
  let J = BP.rect.y + i32(id.y);
  let t = BP.lv.x;
  let N = i32(BP.lv.y);
  let size = vec2<f32>(AP.worldW, AP.worldH);
  let corner = vec2<f32>(f32(I), f32(J)) * t;
  var pc = corner + 0.5 * t;
  pc -= floor(pc / size) * size;
  let s = surfaceAt(pc);
  var alb = bLin(s.c);
  var a = 0.0;
  let depth = s.top - s.h;
  if (s.glow > 0.5) {
    a = 1.0;
  } else if (depth > 0.05) {
    // (render.wgsl fsWater, as far.wgsl ringWindowLook drew it: its colour by depth over its bed; ~1.9× for the window's
    // ripples, glints and foam)
    let deep = 1.0 - exp(-depth * 0.45);
    let wl = bLin(mix(vec3<f32>(0.30, 0.45, 0.44), vec3<f32>(0.07, 0.19, 0.25), deep));
    let bed = bLin(lodAlbedo[min(s.mat, 63u)].rgb) * 0.8;
    alb = mix(bed, wl, mix(0.5, 0.9, deep)) * 1.9 * 0.5;
    a = 0.75;
  } else {
    // the grass by the plants (meshdraw.wgsl meshShade's colours, its season; the tufts' shade and the flowers on
    // average; on soil, silt and litter at least what the window's sim has grown)
    let soilish = s.mat == 2u || s.mat == 22u || s.mat == 26u;
    let veg = max(s.veg, select(0.0, BP.lv.w, soilish));
    var cover = 0.0;
    if (veg > 0.0) {
      cover = smoothstep(0.0, 1.2, veg);
      var g = mix(vec3<f32>(0.33, 0.40, 0.17), vec3<f32>(0.36, 0.54, 0.19), smoothstep(1.0, 2.0, veg));
      g = mix(g, vec3<f32>(0.17, 0.33, 0.12), smoothstep(3.0, 4.5, veg));
      g = mix(g, bSeasonGrass(g, clamp(0.5 + 0.5 * snoise(pc * 0.08, AP.seed + 91u), 0.0, 1.0)), 1.0 - 0.5 * smoothstep(3.0, 4.5, veg));
      let tuft = 1.0 - 0.13 * smoothstep(1.2, 2.5, veg);
      alb = mix(alb, bLin(g * 0.97) * tuft, cover);
      // (the flowers: 4% of the quarter cells where it's thick, four colours — their average)
      alb = mix(alb, bLin(vec3<f32>(0.82, 0.6, 0.55)), 0.04 * smoothstep(1.2, 2.5, veg) * cover);
    }
    // over the texel: the ways, the woods, the towns (a few points across it — up to 4 × 4)
    let S = clamp(i32(ceil(t)), 1, 4);
    let coarse = t >= 4.0;
    let dens = smoothstep(3.3, 3.8, s.veg);
    var pave = 0.0;
    var crown = 0.0;
    var crownC = vec3<f32>(0.0);
    var shade = 0.0;
    var st = vec4<f32>(0.0);
    for (var j = 0; j < S; j++) {
      for (var i = 0; i < S; i++) {
        var q = corner + (vec2<f32>(f32(i), f32(j)) + 0.5) / f32(S) * t;
        q -= floor(q / size) * size;
        pave += 1.0 - smoothstep(WAY_HALF - 0.3, WAY_HALF + 0.3, wayDist(q));
        if (dens > 0.0 && t <= 2.0) {
          let tr = treesAt(q, dens);
          crown += tr.cover;
          crownC += tr.c * tr.cover;
          shade += tr.shade * (1.0 - tr.cover);
        }
        let sp = stampAt(q, coarse);
        st += vec4<f32>(bLin(sp.rgb) * sp.a, sp.a);
      }
    }
    let k = 1.0 / f32(S * S);
    pave *= k;
    st *= k;
    if (dens > 0.0 && t <= 2.0) {
      crownC = crownC / max(crown, 1e-4);
      crown *= k;
      shade *= k;
    } else if (dens > 0.0) {
      // (a texel of many lattice squares: the woods' share — a crown in a third of the squares, ~π · 1.6² of 9 — and
      // the shade round them)
      crown = dens * B_TREE_P * 0.9;
      crownC = mix(bLin(vec3<f32>(0.2, 0.36, 0.13)), bLin(vec3<f32>(0.13, 0.27, 0.13)), 0.42) * 0.9;
      shade = dens * 0.3;
    }
    alb = mix(alb, bLin(lodAlbedo[11u].rgb), pave);
    alb *= 1.0 - 0.45 * shade;
    alb = mix(alb, crownC, crown);
    a = 0.5 * cover * (1.0 - pave) * (1.0 - crown);
    if (st.a > 0.0) {
      alb = mix(alb, st.rgb / st.a, st.a);
      a *= 1.0 - st.a;
    }
  }
  textureStore(bakeOut, vec2<i32>(pmod(I, N), pmod(J, N)), i32(BP.lv.z), vec4<f32>(bSrgb(alb), a));
}

// ---- (round 94) the atlas's ground for a settlement's plan, a column a cell (bake.ts RoughGround) ----------------
// The plan (settle/plan.ts) wants the raw ground its box is made of: the window's columns (atlas.ts columns — ~13 ms
// of GPU a 64² region, made only as land arrives). Far from the window it's planned from this instead: the rings' own
// ground (surfaceAt) at each column's middle — no forms (rocks, arches, the lattice's pieces), no caves.
struct RoughP {
  /** the box: its first cell (world cells, an even row), cells across, rows down */
  box: vec4<i32>,
}
@group(0) @binding(57) var<uniform> RP: RoughP;
/** per column: the ground's top (world z), the water on it, its top's material (bits), the plants it starts with */
@group(0) @binding(58) var<storage, read_write> roughOut: array<vec4<f32>>;

@compute @workgroup_size(8, 8)
fn roughGround(@builtin(global_invocation_id) id: vec3<u32>) {
  if (i32(id.x) >= RP.box.z || i32(id.y) >= RP.box.w) { return; }
  let cx = RP.box.x + i32(id.x);
  let cy = RP.box.y + i32(id.y);
  let size = vec2<f32>(AP.worldW, AP.worldH);
  var p = vec2<f32>(f32(cx) + 0.5 + 0.5 * f32(cy & 1), (f32(cy) + 0.5) * ROW_H_A);
  p -= floor(p / size) * size;
  let s = surfaceAt(p);
  roughOut[id.y * u32(RP.box.z) + id.x] = vec4<f32>(s.h, max(s.top - s.h, 0.0), bitcast<f32>(s.mat), s.veg);
}
