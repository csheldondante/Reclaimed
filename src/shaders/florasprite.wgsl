// ---- the flora sprites' bake (round 128, `treegen`; src/flora/sprites.ts, render/florasprites.ts) ----------------
// Prepended: common.wgsl, materials.wgsl, the library's constants (FLORA_*), floralook.wgsl. A tree kind's full mesh
// drawn once per yaw step at the iso pitch into its atlas cell: per texel the look's albedo and coverage (target 0),
// and its normal in the tree's frame (octahedral, two bytes), its depth along the view (a byte, 0 nearest the eye ..
// 1 the far side of the bounds) and its material (target 1). One indexed draw a (kind, yaw): the instance index is
// the bake's (firstInstance), which picks its view from `bakes`.

struct Bake {
  // xyz toward the eye (the tree's frame, unit), w the atlas cell
  eye: vec4<f32>,
  // R, v0, v1, d0 (sprites.ts spriteBounds)
  b: vec4<f32>,
  // d1, the atlas's cells across and down
  c: vec4<f32>,
};
@group(0) @binding(1) var<storage, read> bakes: array<Bake>;

struct BOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) p: vec3<f32>,
  @location(1) @interpolate(flat) info: vec2<u32>,
  @location(2) h: f32,
  @location(3) @interpolate(flat) eye: vec3<f32>,
  @location(4) uv: vec2<f32>,
};

@vertex
fn vsBake(@location(0) a: vec4<f32>, @location(1) uvIn: vec2<f32>, @builtin(instance_index) ii: u32) -> BOut {
  let bk = bakes[ii];
  let k = u32(floor(a.w / 16.0));
  let aw = a.w - f32(k) * 16.0;
  let part = u32(floor(aw));
  let e = bk.eye.xyz;
  let right = normalize(vec3<f32>(-e.y, e.x, 0.0));
  let up = cross(e, right);
  let R = bk.b.x;
  let u = dot(a.xyz, right) / (2.0 * R) + 0.5;
  let v = (dot(a.xyz, up) - bk.b.y) / (bk.b.z - bk.b.y);
  let d = (dot(a.xyz, e) - bk.b.w) / (bk.c.x - bk.b.w);
  let cell = u32(bk.eye.w);
  let cols = bk.c.y;
  let rows = bk.c.z;
  let cx = f32(cell % u32(cols));
  let cy = f32(cell / u32(cols));
  var o: BOut;
  // (the cell's square of the atlas: u right, v up — the texture's rows run down)
  o.pos = vec4<f32>((cx + clamp(u, 0.0, 1.0)) / cols * 2.0 - 1.0, 1.0 - (cy + 1.0 - clamp(v, 0.0, 1.0)) / rows * 2.0, clamp(1.0 - d, 0.0, 1.0), 1.0);
  // (icicles out of winter: as the draw, nothing)
  if (part == 11u && seasonSnow() < 0.5) { o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0); }
  o.p = a.xyz;
  o.info = vec2<u32>(k, part);
  o.h = fract(aw);
  o.eye = e;
  o.uv = uvIn;
  return o;
}

struct BFrag {
  @location(0) alb: vec4<f32>,
  @location(1) nd: vec4<f32>,
};

@fragment
fn fsBake(in: BOut) -> BFrag {
  var n = normalize(cross(dpdx(in.p), dpdy(in.p)));
  if (dot(n, in.eye) < 0.0) { n = -n; }
  // (the per-instance random a mesh tree takes from its column: the middle)
  let fw = max(fwidth(in.uv).x, fwidth(in.uv).y);
  let tb = floraTangents(in.p, in.uv, n);
  let fl = floraLook(in.info.x, in.info.y, in.p, n, in.h, 0.5, 7u, in.uv, fw);
  n = floraBump(in.info.x, in.info.y, in.uv, n, tb, fw);
  if (fl.w < 0.0) { discard; }
  var o: BFrag;
  o.alb = vec4<f32>(fl.rgb, 1.0);
  var q = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { q = (1.0 - abs(q.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), q >= vec2<f32>(0.0)); }
  // (the depth: the fragment's own, 1 − z: 0 the bounds' far side .. 1 nearest — stored as the draw reads it, 0 nearest)
  o.nd = vec4<f32>(q * 0.5 + 0.5, in.pos.z, fl.w / 64.0);
  return o;
}
