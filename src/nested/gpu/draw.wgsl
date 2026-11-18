// ---- nested/gpu/draw.wgsl: a level's boxes, from the faces baked when its columns changed (store.wgsl prepended) ----
// One instanced draw a level over its face pages (nest.wgsl faceBake, dirBuild): an instance a page, three vertices a
// triangle slot; slots past the page's count are dropped. The vertex stage only places the baked corners: nothing here
// reads a column or matches anything, and a frame with no change draws what was baked. Flat face normals, colour by
// material, a triplanar pattern in world units. Finest level first, composed by depth (reverse Z, each level's
// view-projection in its own units). A parent bakes no faces under its child's footprint and walls it in, so the levels
// meet on whole parent cells with no morph.

struct DrawU {
  lvl: vec4<i32>, // gx0, gy0, n, depth
  misc: vec4<f32>, // -, -, tint on, k
  want: vec4<f32>, // (metrics) where the focus wants this level's child, local units
  sun: vec4<f32>,
  misc2: vec4<u32>, // x: the pool's pages (the directory's stride), w: (capture) face pages of this level
  // the grid's model matrix (a root grid's rigid frame; one grid with the identity today): level-local -> the frame the
  // camera's per-level view-projection expects
  model: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> d: DrawU;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(3) var<storage, read> cam: array<f32>;
@group(0) @binding(4) var<storage, read> reg: array<i32>;
@group(0) @binding(5) var<storage, read> dir: array<u32>;
// (the pages: segments from binding 10 on, with pgLoad, declared by render.ts from nest.ts segWgsl)

fn tabLoad(i: u32) -> u32 { return tab[i]; }

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) nrm: vec3<f32>,
  @location(2) @interpolate(flat) col: vec3<f32>,
  @location(3) wp: vec3<f32>, // world position (the pattern's coordinates, the same on every level)
  @location(4) lz: f32, // the local height (the watertight capture; 3e38: a vertex not drawn)
}

/** a level's z origin in world units (reg words 1..L: each level's origin in its parent's units) */
fn zOrigW(L: u32) -> f32 {
  var z = 0.0;
  for (var j = 1u; j <= L; j++) { z += bitcast<f32>(reg[j]) / pow(d.misc.w, f32(j - 1u)); }
  return z;
}
/** a level's local point in world units */
fn worldOf(L: u32, lp: vec3<f32>) -> vec3<f32> {
  let s = pow(d.misc.w, f32(L));
  return vec3<f32>((f32(d.lvl.x) + lp.x) / s, (f32(d.lvl.y) + lp.y) / s, zOrigW(L) + lp.z / s);
}
fn vpOf(L: u32) -> mat4x4<f32> {
  let b = 32u + L * 24u;
  return mat4x4<f32>(
    vec4<f32>(cam[b], cam[b + 1u], cam[b + 2u], cam[b + 3u]),
    vec4<f32>(cam[b + 4u], cam[b + 5u], cam[b + 6u], cam[b + 7u]),
    vec4<f32>(cam[b + 8u], cam[b + 9u], cam[b + 10u], cam[b + 11u]),
    vec4<f32>(cam[b + 12u], cam[b + 13u], cam[b + 14u], cam[b + 15u]));
}

fn matColor(m: u32, nz: f32) -> vec3<f32> {
  switch (m) {
    case 1u: { return vec3<f32>(0.47, 0.45, 0.43); }
    case 2u: { return select(vec3<f32>(0.45, 0.36, 0.24), vec3<f32>(0.36, 0.52, 0.24), nz > 0.5); }
    case 3u: { return vec3<f32>(0.80, 0.70, 0.48); }
    case 4u: { return vec3<f32>(0.62, 0.38, 0.30); }
    default: { return vec3<f32>(1.0, 0.0, 1.0); }
  }
}
const NRM = array<vec3<f32>, 6>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, -1.0));

/** triangle slot `tri` of face page `slot` of the level's list: its vertex v (local units), or none */
struct Corner {
  ok: bool,
  lp: vec3<f32>,
  kind: u32,
  mat: u32,
}
fn corner(inst: u32, tri: u32, v: u32) -> Corner {
  var c = Corner(false, vec3<f32>(0.0), 0u, 0u);
  let w = d.lvl;
  let L = u32(w.w);
  let e = 16u + (L * d.misc2.x + inst) * 2u;
  let page = dir[e];
  let key = dir[e + 1u];
  if (tri >= pgLoad(page * PW)) { return c; }
  let b = page * PW + FHDR + tri * 4u;
  let w0 = pgLoad(b);
  let cc = (w0 >> (19u + 2u * v)) & 3u;
  let X = i32(key & 0xffffu) * 16 + i32(w0 & 15u) + i32(cc & 1u);
  let Y = i32(key >> 16u) * 16 + i32((w0 >> 4u) & 15u) + i32(cc >> 1u);
  c.ok = true;
  c.lp = vec3<f32>(f32(X - w.x), f32(Y - w.y), bitcast<f32>(pgLoad(b + 1u + v)));
  c.kind = (w0 >> 8u) & 7u;
  c.mat = (w0 >> 11u) & 255u;
  return c;
}

@vertex
fn vs(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  o.lz = 3e38;
  let c = corner(inst, vv / 3u, vv % 3u);
  if (!c.ok) { return o; }
  let L = u32(d.lvl.w);
  let n = NRM[c.kind];
  o.pos = vpOf(L) * (d.model * vec4<f32>(c.lp, 1.0));
  o.local = c.lp.xy;
  o.nrm = n;
  o.col = matColor(c.mat, n.z);
  o.wp = worldOf(L, c.lp);
  o.lz = c.lp.z;
  return o;
}

// ---- the watertight check's capture (test only): every triangle the draw would place, in local units ---------------
// three vec4 a triangle slot: x, y, z local, w 1 when drawn (0 for an empty slot)
@group(1) @binding(0) var<storage, read_write> capOut: array<vec4<f32>>;
@compute @workgroup_size(64)
fn capture(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  // (two dimensions: a level's slots can need more than 65,535 workgroups)
  let i = gid.x + gid.y * nw.x * 64u;
  let inst = i / TPP;
  if (inst >= d.misc2.w) { return; }
  for (var v = 0u; v < 3u; v++) {
    let c = corner(inst, i % TPP, v);
    capOut[i * 3u + v] = vec4<f32>(c.lp, select(0.0, 1.0, c.ok));
  }
}

const TINTS = array<vec3<f32>, 6>(vec3<f32>(0.35, 0.55, 1.0), vec3<f32>(1.0, 0.35, 0.3), vec3<f32>(1.0, 0.9, 0.25), vec3<f32>(0.35, 1.0, 0.45), vec3<f32>(0.9, 0.4, 1.0), vec3<f32>(0.3, 1.0, 1.0));

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) info: vec4<f32>,
}

fn hash2(p: vec2<f32>) -> f32 {
  let q = vec2<u32>(vec2<i32>(floor(p)));
  var h = (q.x * 0x9e3779b1u) ^ (q.y * 0x85ebca6bu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = h ^ (h >> 13u);
  return f32(h & 0xffffu) / 65535.0;
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
/** a triplanar pattern in world units (the same on every level, so the rim shows no change of pattern): value noise
 *  on the three axis planes blended by the normal, octaves from a root column down, each faded out before it is finer
 *  than a pixel */
fn pattern(p: vec3<f32>, n: vec3<f32>, px: f32) -> f32 {
  var bw = pow(abs(n), vec3<f32>(4.0));
  bw /= bw.x + bw.y + bw.z;
  let top = clamp(floor(log2(0.4 / max(px, 1e-9)) * 0.5), 0.0, 9.0);
  let o0 = max(0.0, top - 2.0);
  var acc = 0.0;
  var norm = 0.0;
  for (var o = o0; o <= top; o += 1.0) {
    let f = pow(4.0, o);
    let vis = 1.0 - smoothstep(0.15, 0.4, px * f);
    let q = p * f + o * 17.0;
    acc += vis * (bw.x * vnoise(q.yz) + bw.y * vnoise(q.xz) + bw.z * vnoise(q.xy));
    norm += vis;
  }
  return select(0.5, acc / norm, norm > 1e-4);
}
@fragment
fn fs(v: VOut) -> FOut {
  // (fwidth before anything that could branch)
  let px = length(fwidth(v.wp));
  let n = normalize(v.nrm);
  let pat = pattern(v.wp, n, px);
  let sun = normalize(d.sun.xyz);
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = v.col * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  // info: r a surface was drawn, g the level, b not yet sharp (a parent where the focus wants its child)
  let wa = d.want;
  let coarse = wa.x < wa.z && v.local.x > wa.x && v.local.y > wa.y && v.local.x < wa.z && v.local.y < wa.w;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse), 1.0);
  return o;
}
