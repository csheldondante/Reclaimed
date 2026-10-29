// ---- the world-anchored tile cache (round 103, ?tiles=1; render/tilecache.ts) ------------------------------
// A region's terrain (its four mesh chunks and those round it, the band's, the hybrid's grid) is drawn once into
// a G-buffer through a camera of its own — the view's rotation, its own scale and place — and baked here into a
// slot of the atlas: what the look is before it's lit (meshdraw.wgsl meshSurf): the albedo, the water film, the
// normal it's lit by, how far along the view the point is from the region's anchor. Every frame the tiles past
// the window are drawn as quads where they are and lit then (the sun, the time of day, the clouds' shadows, the
// shadow map where it reaches, the haze), their depth the frame's — the live things draw over and under them.
// Appended to the mesh's module (meshdraw.wgsl and what it includes before it).
//
// The bake's camera: CAM.pos.xy is the slot's corner in the atlas (pixels; pos.w 0: the fixed view, so toEye
// doesn't read it), CAM.pos.z the anchor's distance along the view (window units).
// (Round 108, TC20: the weather isn't baked — meshdraw.wgsl TILE_BAKE: the snow lying on top taken for what's under
// it, no wetness — it's drawn live from the weather's cover (weather/cover.ts, coverfield.wgsl) as the tile is drawn;
// the bake keeps what the wetness darkens by, the top's porosity, beside the normal.)

struct BakeOut { @location(0) a: vec4<f32>, @location(1) b: vec2<u32>, @location(2) c: vec4<f32> };

// ---- (round 108, TC20) the held rivers, drawn at their wetness now --------------------------------------------
// A held river's level follows the rivers' wetness (Globals ocean.w: weather/riverwet.ts — the storms, the season,
// eased over ~20 s; riverheld.wgsl riverHere): at its line its depth × wet^RIVER_DEPTH_EXP, the level shifted with it
// across the channel (at most 0.28 over the reference's), a dry bed under RIVER_DRY (riverheld.wgsl's, in this module:
// its riverWetAt — the wetness at a place). A tile keeps a held river's
// texel as its bed and, in its live plane (rgba8: BakeOut.c xy), how far under the river's level at the reference wetness
// the point is and the river's depth at its line there; the draw floods it to the level now.
// The snow the same way (BakeOut.c zw): a texel's own snow as baked (the cell's — a road the window keeps clear stays
// clear) and the cover's there then; drawn, the own snow melts as the cover's has since, and what's fallen since lies
// over all of it.
@group(0) @binding(22) var riverFlowTex: texture_2d<f32>;
/** the river plane's ranges: under the level (cells, -RIVER_UNDER_LO .. RIVER_UNDER_HI), the line's depth (0 .. RIVER_LINE) */
const RIVER_UNDER_LO: f32 = 1.0;
const RIVER_UNDER_HI: f32 = 3.0;
const RIVER_LINE: f32 = 4.0;
/** the snow's ranges in the live plane: a texel's own (cells), the cover's as baked (cells) */
const SNOW_OWN: f32 = 1.0;
const SNOW_REF: f32 = 2.0;
/** the water's colour over the ground by its depth there (the window draws its sheet as instances the tile doesn't hold) */
fn tileWater(dz: f32) -> vec3<f32> {
  return mix(toLinear(vec3<f32>(0.26, 0.40, 0.40)), toLinear(vec3<f32>(0.10, 0.20, 0.26)), smoothstep(0.1, 3.0, dz)) * 0.8;
}

/** the G-buffer's normal (meshdraw.wgsl: octahedral, 15 bits a side) */
fn octDec(w: u32) -> vec3<f32> { return octDecB(vec2<f32>(f32(w & 32767u), f32((w >> 15u) & 32767u)) / 32767.0); }
/** (round 108) the atlas's: 14 bits a side — bits 28-29 the top's porosity, 30 gem, 31 drawn */
fn tileNrmEnc(n: vec3<f32>) -> u32 {
  var o = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { o = (1.0 - abs(o.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), o >= vec2<f32>(0.0)); }
  let q = vec2<u32>(round(clamp(o * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * 16383.0));
  return q.x | (q.y << 14u);
}
fn tileNrmDec(w: u32) -> vec3<f32> { return octDecB(vec2<f32>(f32(w & 16383u), f32((w >> 14u) & 16383u)) / 16383.0); }
fn octDecB(u: vec2<f32>) -> vec3<f32> {
  let o = u * 2.0 - 1.0;
  var n = vec3<f32>(o, 1.0 - abs(o.x) - abs(o.y));
  if (n.z < 0.0) { n = vec3<f32>((1.0 - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0)), n.z); }
  return normalize(n);
}

/** a: sqrt(albedo / 2), the film; b: the normal (oct, 14 bits a side) | porosity (bits 28-29) | gem (bit 30) |
 *  drawn (bit 31), the depth
 *  along the view from the anchor (f32 bits). The window's source first, over the whole slot (nothing there, or
 *  the band's: cleared — the slot held another tile), then the band's over it (fsTileBakeOver). */
@fragment
fn fsTileBake(@builtin(position) pos: vec4<f32>) -> BakeOut {
  let px = vec2<i32>(pos.xy - CAM.pos.xy);
  let a = textureLoad(gbuf0, px, 0);
  if ((a.w >> 31u) == 0u || ((a.w >> 30u) & 1u) != u32(MR.zb.w)) { return BakeOut(vec4<f32>(0.0), vec2<u32>(0u), vec4<f32>(0.0)); }
  return tileBake(px, a);
}
@fragment
fn fsTileBakeOver(@builtin(position) pos: vec4<f32>) -> BakeOut {
  let px = vec2<i32>(pos.xy - CAM.pos.xy);
  let a = textureLoad(gbuf0, px, 0);
  if ((a.w >> 31u) == 0u || ((a.w >> 30u) & 1u) != u32(MR.zb.w)) { discard; }
  return tileBake(px, a);
}
fn tileBake(px: vec2<i32>, a: vec4<u32>) -> BakeOut {
  let b = textureLoad(gbuf1, px, 0);
  var m: MOut;
  m.pos = vec4<f32>(vec2<f32>(px) + 0.5, 0.0, 1.0);
  m.wpos = vec3<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z));
  m.nrm = octDec(a.w & 0x3fffffffu);
  m.share = unpack2x16unorm(b.y).x;
  m.word = b.x;
  m.tint = meshTint(m.wpos);
  // (round 108, TC20: the weather left out — drawn live from the cover)
  TILE_BAKE = true;
  let s = meshSurf(m);
  var alb = s.alb;
  var ln = s.lnrm;
  // (round 104, TC7: the woods' trees painted in — the rings' rule (far.wgsl gTrees): a crown on a lattice square
  // where the plants are a wood's, drawn where the screen shows it, its shadow on the ground; the crown lit live by
  // its ball's normal. The window's own trees are instances the tile doesn't hold)
  let t = tileTrees(wo(m.wpos.xy), cellFields(m.wpos.xy).y, CAM.viewport.w);
  alb *= 1.0 - 0.45 * t.shade * (1.0 - t.crown);
  if (t.crown > 0.0) {
    alb = mix(alb, t.alb, t.crown);
    if (t.crown > 0.5) { ln = t.n; }
  }
  // (the water over the ground — the window draws its sheet as instances the tile doesn't hold: its colour by depth,
  // flat, all film for the sun's glint)
  var film = s.film * (1.0 - t.crown);
  let wt = cellWater(m.wpos.xy);
  var o: BakeOut;
  o.c = vec4<f32>(0.0);
  // (its own snow — the cell's top, as the window's look has it before the bake left it out — and the cover's there)
  if (m.nrm.z > 0.55 && t.crown < 0.5) {
    let lk = meshLook(clampCell(cellAt(m.wpos.xy)), m.wpos.z - 0.2, true);
    let own = select(0.0, lk.thick, lk.mat == MAT_SNOW);
    o.c.z = clamp(own / SNOW_OWN, 0.0, 1.0);
    o.c.w = clamp(coverAt(m.wpos.xy).x / SNOW_REF, 0.0, 1.0);
  }
  // (round 108, TC20: a held river's column — riverheld.wgsl's table — kept as its bed: the draw floods it to the
  // rivers' level now; how far under the level its point is, at the reference wetness, the plane's)
  let rf = textureLoad(riverFlowTex, texCol(clampCell(cellAt(m.wpos.xy))), 0);
  let river = rf.z > 0.0 && t.crown < 0.5;
  if (river) {
    let under = select(-RIVER_UNDER_LO, wt.level - m.wpos.z, wt.wet > 0.5);
    o.c.x = clamp((under + RIVER_UNDER_LO) / (RIVER_UNDER_LO + RIVER_UNDER_HI), 0.0, 1.0);
    o.c.y = max(clamp(rf.w / RIVER_LINE, 0.0, 1.0), 1.0 / 255.0);
    film = 0.0;
  } else if (wt.wet > 0.5 && wt.level > m.wpos.z + 0.05) {
    alb = tileWater(wt.level - m.wpos.z);
    ln = vec3<f32>(0.0, 0.0, 1.0);
    film = 1.0;
  }
  o.a = vec4<f32>(sqrt(clamp(alb * 0.5, vec3<f32>(0.0), vec3<f32>(1.0))), film);
  let d = dot(-CAM.eye.xyz, m.wpos) - CAM.pos.z;
  // (what the wetness darkens it by: meshdraw.wgsl's MATS[mat].eco.w, 0..0.6 in quarters of it — none under water)
  let por = select(u32(round(clamp(MATS[s.mat].eco.w / POR_MAX, 0.0, 1.0) * 3.0)), 0u, film > 0.5 || t.crown > 0.5 || river);
  o.b = vec2<u32>(tileNrmEnc(ln) | (por << 28u) | select(0u, 1u << 30u, s.gem && t.crown < 0.5) | (1u << 31u), bitcast<u32>(d));
  return o;
}

/** the most a material's wetness darkens it (materials.ts porosity) */
const POR_MAX: f32 = 0.6;

fn tRand(p: vec3<i32>) -> f32 { return f32(pcg(bitcast<u32>(p.x) ^ pcg(bitcast<u32>(p.y) ^ pcg(bitcast<u32>(p.z)))) >> 8u) / 16777216.0; }

struct TTree { crown: f32, shade: f32, alb: vec3<f32>, n: vec3<f32> };
/** world units a tree's lattice step, and the share of its squares with one (far.wgsl G_TREE_STEP, G_TREE_P) */
const T_TREE_STEP: f32 = 3.0;
const T_TREE_P: f32 = 0.34;
/** (far.wgsl gTrees, unlit) the trees over ground point w (world units), v the plants there, px world units a texel */
fn tileTrees(w: vec2<f32>, v: f32, px: f32) -> TTree {
  var t = TTree(0.0, 0.0, vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0));
  let dens = smoothstep(3.3, 3.8, v);
  if (dens <= 0.0) { return t; }
  let eh = length(CAM.eye.xy);
  let away = -CAM.eye.xy / max(eh, 1e-3);
  let cotE = eh / max(CAM.eye.z, 0.05);
  let sun = sunDir();
  let sh = -sun.xy / max(sun.z, 0.25);
  let b0 = vec2<i32>(floor(w / T_TREE_STEP));
  let sx = select(1, -1, away.x < 0.0);
  let sy = select(1, -1, away.y < 0.0);
  for (var j = -3; j <= 1; j++) {
    for (var i = -3; i <= 1; i++) {
      let bq = b0 + vec2<i32>(i * sx, j * sy);
      let r0 = tRand(vec3<i32>(bq, 4242));
      if (r0 >= T_TREE_P * dens) { continue; }
      let r1 = tRand(vec3<i32>(bq, 321));
      let r2 = tRand(vec3<i32>(bq, 7));
      let foot = (vec2<f32>(bq) + vec2<f32>(0.2 + 0.6 * r1, 0.2 + 0.6 * r2)) * T_TREE_STEP;
      let conifer = r1 < 0.42;
      let H = select(3.0 + 3.0 * r2, 3.5 + 4.0 * r2, conifer);
      let Rr = select(1.3 + 0.7 * r1, 0.9 + 0.5 * r2, conifer);
      let ds = length(w - (foot + sh * H * 0.8)) / (Rr * 1.1);
      t.shade = max(t.shade, 1.0 - smoothstep(0.75, 1.0, ds));
      let cc = foot + away * H * cotE;
      let q = (w - cc) / Rr;
      var dd = length(q);
      if (conifer) {
        let up = dot(q, away);
        dd = length(q - away * up * 0.55);
      }
      let edge = clamp(px / Rr, 0.05, 0.5);
      let cov = 1.0 - smoothstep(1.0 - edge, 1.0, dd);
      if (cov > t.crown) {
        t.crown = cov;
        t.n = normalize(vec3<f32>(q * 0.8, sqrt(max(1.0 - min(dot(q, q), 1.0), 0.0)) + 0.25));
        var leaf = select(vec3<f32>(0.2, 0.36, 0.13), vec3<f32>(0.13, 0.27, 0.13), conifer) * (0.85 + 0.3 * r0 / T_TREE_P);
        if (!conifer) { leaf = seasonGrass(leaf, r2) * 0.5 + leaf * 0.5; }
        t.alb = toLinear(leaf);
      }
    }
  }
  return t;
}

// ---- the tiles drawn ---------------------------------------------------------------------------------------
@group(0) @binding(42) var tileA: texture_2d<f32>;
@group(0) @binding(43) var tileB: texture_2d<u32>;
/** a tile drawn this frame: the clip x and y at its anchor and the clip a unit of the view's plane (x, y); its slot
 *  (atlas px x y), its slot's index, 1 when it's an arriving region's; its anchor (window units) and the clip depth
 *  there (round 105, tilelatency: what it was baked at is TP's — a render-only tile's written by the GPU) */
struct TileI { clip: vec4<f32>, slot: vec4<f32>, anchor: vec4<f32>, pad: vec4<f32> };
@group(0) @binding(44) var<storage, read> tilesI: array<TileI>;
/** per atlas slot (tilecache.ts tparams): the view-plane coordinates of its left and top edges (from the anchor), the
 *  texels a unit; the texels used (w, h), its top (world z), 1 when written */
@group(0) @binding(46) var<storage, read> TP: array<vec4<f32>>;
/** the view's right, up and along (toward the far side) — unit vectors; w: the clip depth a unit along; the
 *  window's size (window units), the region's size (x, y window units), how far past its edge a tile draws */
struct TileU { r: vec4<f32>, u: vec4<f32>, f: vec4<f32>, win: vec4<f32> };
@group(0) @binding(45) var<uniform> TU: TileU;
/** (round 108, TC20) the weather's cover (weather/cover.ts): snow (cells), wet, ice (its share of the texel), which lap
 *  round the ring it is (-1: nothing known) */
@group(0) @binding(47) var coverTex: texture_2d<f32>;
/** (round 108, TC20) the tiles' live plane (BakeOut.c: xy the held river's, zw the snow's — what the draw brings up to now) */
@group(0) @binding(48) var tileLive: texture_2d<f32>;

/** the cover at window point p (bilinear over the texels the field holds there): snow lying (cells), wetness, ice */
fn coverAt(p: vec2<f32>) -> vec3<f32> {
  let cell = vec2<f32>(p.x, p.y / ROW_H) + G.org.zw;
  let f = cell / COVER_CELL - 0.5;
  let t0 = vec2<i32>(floor(f));
  let fr = f - floor(f);
  var sum = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2<i32>(k & 1, k >> 1);
    let t = t0 + o;
    let v = textureLoad(coverTex, coverRing(t), 0);
    if (v.w != coverLapCode(t)) { continue; }
    let w = mix(1.0 - fr.x, fr.x, f32(o.x)) * mix(1.0 - fr.y, fr.y, f32(o.y));
    sum += v.xyz * w;
    wsum += w;
  }
  return select(vec3<f32>(0.0), sum / wsum, wsum > 1e-4);
}

struct TOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  // (the instance's, flat: the fragment stage has no storage buffer to spare — the mesh's eight)
  @location(1) @interpolate(flat) slot: vec4<f32>,
  @location(2) @interpolate(flat) anchor: vec4<f32>,
  @location(3) @interpolate(flat) plane: vec4<f32>,
};

@vertex
fn vsTile(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TOut {
  let c = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0))[vi];
  let t = tilesI[ii];
  let si = u32(t.slot.z);
  let pa = TP[si * 2u];
  let pb = TP[si * 2u + 1u];
  var o: TOut;
  // (its quad from what it was baked at: the plane's left and top edges, its texels a unit, those used)
  let x0 = t.clip.x + pa.x * t.clip.z;
  let x1 = t.clip.x + (pa.x + pb.x / max(pa.z, 1e-6)) * t.clip.z;
  let y1 = t.clip.y + pa.y * t.clip.w;
  let y0 = t.clip.y + (pa.y - pb.y / max(pa.z, 1e-6)) * t.clip.w;
  // (uv down the slot: its top is the clip's y1; a slot not written yet: no quad)
  let on = pb.w > 0.5;
  o.pos = vec4<f32>(select(2.0, mix(x0, x1, c.x), on), mix(y1, y0, c.y), 0.5, 1.0);
  o.uv = c;
  o.slot = vec4<f32>(t.slot.xy, pb.xy);
  o.anchor = t.anchor;
  o.plane = vec4<f32>(pa.xyz, t.slot.w);
  return o;
}

struct TFrag { @location(0) color: vec4<f32>, @location(1) pick: vec2<u32>, @builtin(frag_depth) depth: f32 };

@fragment
fn fsTile(in: TOut) -> TFrag {
  let t = in;
  let tx = vec2<i32>(t.slot.xy + min(floor(in.uv * t.slot.zw), t.slot.zw - 1.0));
  let b = textureLoad(tileB, tx, 0);
  if ((b.x >> 31u) == 0u) { discard; }
  let d = bitcast<f32>(b.y);
  // (the texel's centre in the view's plane, from the anchor)
  let k = (floor(in.uv * t.slot.zw) + 0.5) / t.plane.z;
  let p = t.anchor.xyz + TU.r.xyz * (t.plane.x + k.x) + TU.u.xyz * (t.plane.y - k.y) + TU.f.xyz * d;
  // (its own region and a cell round it: the bake took the chunks round it in, cut off here; and not inside the
  // window, past a cell — the window draws its own land live)
  let rl = p.xy - t.anchor.xy;
  if (any(rl < vec2<f32>(-TU.win.w)) || any(rl > TU.win.zz * vec2<f32>(1.0, 0.8660254) + TU.win.w)) { discard; }
  // (an arriving region's tile — plane.w 1 — draws inside the window till the window draws its land)
  if (t.plane.w < 0.5 && all(p.xy > vec2<f32>(TU.win.w)) && all(p.xy < TU.win.xy - TU.win.w)) { discard; }
  let a = textureLoad(tileA, tx, 0);
  var alb = a.rgb * a.rgb * 2.0;
  var n = tileNrmDec(b.x);
  // (round 108, TC20: the weather, live — as the window's own look has it: wet ground darkens by its porosity
  // (meshdraw.wgsl), the snow lying on what faces up (its look: MAT_SNOW's, a thin layer showing what's under it,
  // ragged at its edge))
  let cv = coverAt(p.xy);
  let por = f32((b.x >> 28u) & 3u) / 3.0 * POR_MAX;
  alb *= 1.0 - por * 0.5 * smoothstep(0.15, 0.9, cv.y);
  let r = randv(vec3<i32>(vec3<f32>(floor(p.xy * 4.0), 7.0)));
  let pc = textureLoad(tileLive, tx, 0);
  // (the snow: the texel's own as baked, melted as the cover's has since; what's fallen since over it all)
  let sref = pc.w * SNOW_REF;
  let kept = select(1.0, clamp(cv.x / sref, 0.0, 1.0), sref > 0.01);
  let snow = pc.z * SNOW_OWN * kept + max(cv.x - sref, 0.0);
  if (snow > 0.0 && n.z > 0.55 && a.a < 0.5) {
    let ks = smoothstep(0.02, 0.2, snow) * select(1.0, 0.0, snow < 0.03 + 0.12 * r);
    alb = mix(alb, groundAlbedo(MAT_SNOW) * (0.94 + 0.12 * r), ks);
  }
  var film = a.a;
  // (a held river's bed flooded to the rivers' level now: under it at the reference by the plane's, shifted as the line's
  // depth is with the wetness)
  let rv = pc.xy;
  if (rv.y > 0.0) {
    let wet = riverWetAt(vec2<f32>(p.x, p.y / ROW_H));
    let line = rv.y * RIVER_LINE;
    let shift = min(line * (pow(wet, RIVER_DEPTH_EXP) - 1.0), 0.28);
    let dz = rv.x * (RIVER_UNDER_LO + RIVER_UNDER_HI) - RIVER_UNDER_LO + shift;
    if (dz > 0.05 && line + shift >= RIVER_DRY) {
      alb = tileWater(dz);
      n = vec3<f32>(0.0, 0.0, 1.0);
      film = 1.0;
    }
  }
  // (the water iced over: as the window's ice sheet — its share of the texel, ragged at its edge)
  if (cv.z > 0.0 && film > 0.5 && cv.z > 0.25 + 0.5 * r) {
    alb = groundAlbedo(MAT_ICE) * (0.9 + 0.15 * r);
    film = 0.3;
  }
  var col = alb * lighting(p, n);
  if (((b.x >> 30u) & 1u) != 0u) { col = gemLook(p, n); }
  col += filmSheen(p, n, vec3<f32>(0.0, 0.0, 1.0), film);
  col = haze(col, p);
  // (?tiledebug=1: the tiles tinted, to tell them from the window and the rings)
  if (TU.r.w > 0.5) { col = mix(col, vec3<f32>(0.6, 0.05, 0.4), 0.35); }
  var o: TFrag;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(0u);
  o.depth = clamp(t.anchor.w + d * TU.f.w, 0.0, 1.0);
  return o;
}
