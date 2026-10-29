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

struct BakeOut { @location(0) a: vec4<f32>, @location(1) b: vec2<u32> };

fn octEnc(n: vec3<f32>) -> u32 {
  var o = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { o = (1.0 - abs(o.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), o >= vec2<f32>(0.0)); }
  let q = vec2<u32>(round(clamp(o * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * 32767.0));
  return q.x | (q.y << 15u);
}
fn octDec(w: u32) -> vec3<f32> {
  let o = vec2<f32>(f32(w & 32767u), f32((w >> 15u) & 32767u)) / 32767.0 * 2.0 - 1.0;
  var n = vec3<f32>(o, 1.0 - abs(o.x) - abs(o.y));
  if (n.z < 0.0) { n = vec3<f32>((1.0 - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0)), n.z); }
  return normalize(n);
}

/** a: sqrt(albedo / 2), the film; b: the normal (oct, 15 bits a side) | gem (bit 30) | drawn (bit 31), the depth
 *  along the view from the anchor (f32 bits). The window's source first, over the whole slot (nothing there, or
 *  the band's: cleared — the slot held another tile), then the band's over it (fsTileBakeOver). */
@fragment
fn fsTileBake(@builtin(position) pos: vec4<f32>) -> BakeOut {
  let px = vec2<i32>(pos.xy - CAM.pos.xy);
  let a = textureLoad(gbuf0, px, 0);
  if ((a.w >> 31u) == 0u || ((a.w >> 30u) & 1u) != u32(MR.zb.w)) { return BakeOut(vec4<f32>(0.0), vec2<u32>(0u)); }
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
  if (wt.wet > 0.5 && wt.level > m.wpos.z + 0.05) {
    let dz = wt.level - m.wpos.z;
    alb = mix(toLinear(vec3<f32>(0.26, 0.40, 0.40)), toLinear(vec3<f32>(0.10, 0.20, 0.26)), smoothstep(0.1, 3.0, dz)) * 0.8;
    ln = vec3<f32>(0.0, 0.0, 1.0);
    film = 1.0;
  }
  // (riverfalls, BACKLOG WF1) a held river's fall in a tile: the window draws its sheet (render/riverfalls.ts) as
  // instances the tile doesn't hold, so here water down a steep face is white water, baked still (render.wgsl steepW,
  // without its scroll), lit as the face it runs down
  let steepW = (1.0 - smoothstep(0.25, 0.7, m.nrm.z)) * step(0.5, wt.wet) * smoothstep(0.02, 0.15, wt.d) * step(m.wpos.z - 0.3, wt.level);
  if (steepW > 0.0) {
    let streak = smoothstep(0.35, 0.8, vnoise(vec2<f32>(dot(wo(m.wpos.xy), vec2<f32>(1.3, 0.9)) * 1.5, m.wpos.z * 0.6)));
    alb = mix(alb, toLinear(vec3<f32>(0.86, 0.88, 0.88)), steepW * (0.55 + 0.4 * streak));
    ln = m.nrm;
    film = max(film, 0.6 * steepW);
  }
  var o: BakeOut;
  o.a = vec4<f32>(sqrt(clamp(alb * 0.5, vec3<f32>(0.0), vec3<f32>(1.0))), film);
  let d = dot(-CAM.eye.xyz, m.wpos) - CAM.pos.z;
  o.b = vec2<u32>(octEnc(ln) | select(0u, 1u << 30u, s.gem && t.crown < 0.5) | (1u << 31u), bitcast<u32>(d));
  return o;
}

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
  let alb = a.rgb * a.rgb * 2.0;
  let n = octDec(b.x & 0x3fffffffu);
  var col = alb * lighting(p, n);
  if (((b.x >> 30u) & 1u) != 0u) { col = gemLook(p, n); }
  col += filmSheen(p, n, vec3<f32>(0.0, 0.0, 1.0), a.a);
  col = haze(col, p);
  // (?tiledebug=1: the tiles tinted, to tell them from the window and the rings)
  if (TU.r.w > 0.5) { col = mix(col, vec3<f32>(0.6, 0.05, 0.4), 0.35); }
  var o: TFrag;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(0u);
  o.depth = clamp(t.anchor.w + d * TU.f.w, 0.0, 1.0);
  return o;
}
