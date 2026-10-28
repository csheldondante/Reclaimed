// ---- layer pulls (round 52, BACKLOG E2; docs/WORLD_API.md "Layer pulls") -------
// Grab a material's layer and pull it: its run in each column under the
// brush grows (or, pulled down, shrinks) toward a target height, and what
// lies over it moves with it. The world editor drags a pull each frame with
// a moving centre and a growing height; each column remembers how much the
// stroke has given it already (pullGiven, per stroke slot), so overlapping
// calls compose: a column only ever moves toward the most any call has
// asked of it in that stroke, never stacks the same height twice.
//
// The target in a column: height × the brush's falloff, roughened by the
// material's own noise (hard rock comes up with a broken outline, loose
// ground stays smooth), tilted along `dir` when the pull leans.
//
// Modes (what lies over the pulled run):
//  * lift: everything above rides up with it (loose cover then slumps off
//    the steepened sides by itself: the sediment pass, so it's conserved);
//  * through: the solids just over it crack to their rubble (the same
//    volume) and ride up too, then slump and part.
// Pulled up, the material comes from nowhere (an authoring tool, like the
// sandbox's bedrock brush); pulled down, what's over it sinks with it.
// A column without that material grows a new run of it under its loose
// ground (if it has a free slot).
@group(0) @binding(3) var<storage, read> layersIn: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> layersOut: array<vec4<u32>>;
// per stroke slot and column (slot * columns + i): the height this stroke has given it
@group(0) @binding(5) var<storage, read_write> pullGiven: array<f32>;
// ground shaken (sediment.wgsl reposeAt): the tick, how hard. Where a pull
// lifts loose cover, it slips at a lower angle for a while: shaken off
@group(0) @binding(7) var shakeOut: texture_storage_2d<rgba32float, write>;

struct Pull {
  // x, y (world), radius, height (cells; < 0 pulls down)
  a: vec4<f32>,
  // material (bits 0-7) | shake (8-15, 0..255), mode (0 lift, 1 through), stroke slot, 1: the stroke starts
  b: vec4<u32>,
  // roughness (0..1), lean direction xy, lean (0: none; 1: the far rim twice the height, the near one nothing)
  c: vec4<f32>,
};
struct PullParams {
  n: vec4<u32>,
  pulls: array<Pull, 16>,
};
@group(0) @binding(6) var<uniform> PP: PullParams;

const MODE_THROUGH: u32 = 1u;
// pulled down, a column keeps this much of its bottom (the map's floor)
const FLOOR_KEEP: f32 = 2.0;

/** value noise on a lattice, bilinear (0..1) */
fn pullNoise(q: vec2<f32>, seed: u32) -> f32 {
  let i = vec2<i32>(floor(q));
  let f = fract(q);
  let u = f * f * (3.0 - 2.0 * f);
  let s = i32(seed);
  let a = randv(vec3<i32>(i, s));
  let b = randv(vec3<i32>(i + vec2<i32>(1, 0), s));
  let c = randv(vec3<i32>(i + vec2<i32>(0, 1), s));
  let d = randv(vec3<i32>(i + vec2<i32>(1, 1), s));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let cols = G.mapW * G.mapH;
  let cs = colSlots(id.x, id.y);
  var arr: array<vec4<u32>, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    let v = layersIn[cs.x + k];
    if (ivEmpty(v)) { break; }
    arr[k] = v;
    n = k + 1u;
  }
  let wp = cellPos(p);
  for (var e = 0u; e < PP.n.x; e++) {
    let pl = PP.pulls[e];
    let slot = pl.b.z;
    let gi = slot * cols + i;
    if (pl.b.w != 0u) { pullGiven[gi] = 0.0; }
    let off = wp - pl.a.xy;
    let r = length(off) / max(pl.a.z, 0.5);
    if (r >= 1.3) { continue; }
    let mat = pl.b.x & 0xffu;
    let shake = f32((pl.b.x >> 8u) & 0xffu) / 255.0;
    // the brush: a smooth dome, its edge broken by the material's noise
    var f = select(0.0, (1.0 - r * r) * (1.0 - r * r), r < 1.0);
    let rough = pl.c.x;
    if (rough > 0.0) {
      let q = wp * (2.5 / max(pl.a.z, 1.0)) + vec2<f32>(f32(mat) * 17.3, 0.0);
      let nz = pullNoise(q, mat) * 0.65 + pullNoise(q * 2.7, mat + 7u) * 0.35;
      f = clamp(f + rough * (nz - 0.5) * 0.9, 0.0, 1.0);
      // (a broken outline: below a sliver, nothing)
      f = select(0.0, f, f > 0.05);
    }
    if (pl.c.w != 0.0) { f *= clamp(1.0 + pl.c.w * dot(off, pl.c.yz) / max(pl.a.z, 0.5), 0.0, 2.0); }
    let want = pl.a.w * f;
    let given = pullGiven[gi];
    // toward the most asked of it this stroke (up, or down), never back
    var d = 0.0;
    if (pl.a.w > 0.0) { d = max(want - given, 0.0); } else { d = min(want - given, 0.0); }
    if (abs(d) < 1e-4) { continue; }
    // the pulled run: the topmost interval of the material
    var km = -1;
    for (var k = 0u; k < n; k++) { if (ivMat(arr[k]) == mat) { km = i32(k); } }
    if (km < 0) {
      if (d < 0.0 || n >= cs.y || n == 0u) { pullGiven[gi] = given + d; continue; }
      // none here: a new run of it, under the loose ground
      let lr = looseRun(&arr, n);
      let at = select(ivZ1(arr[lr - 1u]), ivZ0(arr[lr]), lr < n);
      for (var k = n; k > lr; k--) { arr[k] = arr[k - 1u]; }
      arr[lr] = ivPack(at, at, mat, 0u);
      n += 1u;
      km = i32(lr);
    }
    let kk = u32(km);
    let v = arr[kk];
    var dd = d;
    if (dd > 0.0) {
      // (the column's top stays under the sky's ceiling)
      dd = min(dd, max(f32(G.zMax) - 2.0 - ivZ1(arr[n - 1u]), 0.0));
    } else {
      // (not through the map's floor)
      let lo = select(ivZ0(v), max(ivZ0(v), FLOOR_KEEP), kk == 0u);
      dd = max(dd, lo - ivZ1(v));
    }
    pullGiven[gi] = given + d;
    // through: the solids lying on it crack to their rubble
    if (pl.b.y == MODE_THROUGH && dd > 0.0) {
      var top = ivZ1(v);
      for (var k = kk + 1u; k < n; k++) {
        let w = arr[k];
        if (ivZ0(w) - top > 1e-3) { break; }
        top = ivZ1(w);
        if (matState(ivMat(w)) == ST_SOLID) { arr[k] = ivPack(ivZ0(w), ivZ1(w), rubbleOf(ivMat(w)), 0u); }
      }
    }
    arr[kk] = ivPack(ivZ0(v), ivZ1(v) + dd, mat, ivAux(v));
    if (shake > 0.0 && dd > 0.0) { textureStore(shakeOut, texCol(vec2<i32>(p)), vec4<f32>(f32(G.tick), shake, 0.0, 0.0)); }
    for (var k = kk + 1u; k < n; k++) {
      let w = arr[k];
      arr[k] = ivPack(ivZ0(w) + dd, ivZ1(w) + dd, ivMat(w), ivAux(w));
    }
    // (pulled away to nothing: the run goes)
    if (ivZ1(arr[kk]) - ivZ0(arr[kk]) < 1e-3) {
      for (var k = kk; k + 1u < n; k++) { arr[k] = arr[k + 1u]; }
      n -= 1u;
      arr[n] = IV_NONE;
    }
  }
  for (var k = 0u; k < cs.y; k++) { layersOut[cs.x + k] = select(IV_NONE, arr[k], k < n); }
}
