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
  var o: BakeOut;
  o.a = vec4<f32>(sqrt(clamp(s.alb * 0.5, vec3<f32>(0.0), vec3<f32>(1.0))), s.film);
  let d = dot(-CAM.eye.xyz, m.wpos) - CAM.pos.z;
  o.b = vec2<u32>(octEnc(s.lnrm) | select(0u, 1u << 30u, s.gem) | (1u << 31u), bitcast<u32>(d));
  return o;
}

// ---- the tiles drawn ---------------------------------------------------------------------------------------
@group(0) @binding(42) var tileA: texture_2d<f32>;
@group(0) @binding(43) var tileB: texture_2d<u32>;
/** a tile drawn this frame: its quad (clip x0 y0 x1 y1); its slot (atlas px x y w h); its anchor (window units)
 *  and the clip depth there; the view-plane coordinates of the slot's left and top edges and the texels a unit */
struct TileI { clip: vec4<f32>, slot: vec4<f32>, anchor: vec4<f32>, plane: vec4<f32> };
@group(0) @binding(44) var<storage, read> tilesI: array<TileI>;
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
  var o: TOut;
  // (uv down the slot: its top is the clip's y1)
  o.pos = vec4<f32>(mix(t.clip.x, t.clip.z, c.x), mix(t.clip.w, t.clip.y, c.y), 0.5, 1.0);
  o.uv = c;
  o.slot = t.slot;
  o.anchor = t.anchor;
  o.plane = t.plane;
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
  if (all(p.xy > vec2<f32>(TU.win.w)) && all(p.xy < TU.win.xy - TU.win.w)) { discard; }
  let a = textureLoad(tileA, tx, 0);
  let alb = a.rgb * a.rgb * 2.0;
  let n = octDec(b.x & 0x3fffffffu);
  var col = alb * lighting(p, n);
  if (((b.x >> 30u) & 1u) != 0u) { col = gemLook(p, n); }
  col += filmSheen(p, n, vec3<f32>(0.0, 0.0, 1.0), a.a);
  col = haze(col, p);
  var o: TFrag;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(0u);
  o.depth = clamp(t.anchor.w + d * TU.f.w, 0.0, 1.0);
  return o;
}
