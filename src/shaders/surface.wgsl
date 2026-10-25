// ---- surface system ----------------------------------------------------
// Derives the per-column views other systems read, so they don't need to
// understand the slot layout:
//  * surface: the base of the loose ground on top (the run of touching
//    granular intervals at the top of the column; the column's top if there
//    is none), the material under that run, the slot count, whether
//    there's air between two intervals and loose ground buried under something;
//  * drift (texture): x the run's depth, y its top interval's depth, z that
//    interval's material, w what the wind sent up off it (sediment.wgsl's
//    air output) — base + x is the ground's surface;
//  * strata (texture): xyz the run's intervals just beneath the top one
//    (bottom first, packed material·1000 + depth), w the run's base (exact);
//  * levels (texture): the floor of each stretch of open air the projected
//    intervals leave (common.wgsl projAt): x above the top one (the open
//    sky), y under it and above the next, … — the highest of the column's
//    own ground and the projected interval beneath it (-1 none).
// Since round 22 the loose ground is part of the layers; this view is what
// the drift and strata textures used to store (their readers didn't change).
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> surface: array<u32>;
@group(0) @binding(16) var driftOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(19) var airTex: texture_2d<f32>;
@group(0) @binding(20) var strataOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(30) var levelsOut: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  // (a sleeping chunk: round 80)
  if (id.x >= G.mapW || id.y >= G.mapH || asleep(id.xy)) { return; }
  let p = vec2<i32>(id.xy);
  let cs = colSlots(id.x, id.y);
  var arr: array<vec4<u32>, MAX_K>;
  var n = 0u;
  for (var i = 0u; i < cs.y; i++) {
    let v = layers[cs.x + i];
    if (ivEmpty(v)) { break; }
    arr[i] = v;
    n = i + 1u;
  }
  let r = looseRun(&arr, n);
  var top = 0.0;
  if (n > 0u) { top = ivZ1(arr[n - 1u]); }
  var base = top;
  var topDepth = 0.0;
  var topMat = 0u;
  if (r < n) {
    base = ivZ0(arr[r]);
    topDepth = ivZ1(arr[n - 1u]) - ivZ0(arr[n - 1u]);
    topMat = ivMat(arr[n - 1u]);
  }
  var under = 0u;
  if (r > 0u) { under = ivMat(arr[r - 1u]); }
  // (air between two intervals: loose ground beside it can spill into it)
  var gap = false;
  for (var i = 1u; i < n; i++) { gap = gap || ivZ0(arr[i]) > ivZ1(arr[i - 1u]) + 1e-3; }
  // (loose ground under something else: it may spill out of a face)
  var buried = false;
  for (var i = 0u; i < r; i++) { buried = buried || matState(ivMat(arr[i])) == ST_GRANULAR; }
  surface[colIdx(id.x, id.y)] = sfPack(base, under, n) | select(0u, 1u << 31u, gap) | select(0u, 1u << 30u, buried);
  textureStore(driftOut, p, vec4<f32>(top - base, topDepth, f32(topMat), textureLoad(airTex, p, 0).x));
  var st = vec4<f32>(0.0, 0.0, 0.0, base);
  // the (up to) three intervals just beneath the top one, bottom first
  var k = 0u;
  let lo = max(i32(r), i32(n) - 4);
  for (var i = lo; i < i32(n) - 1; i++) {
    let v = arr[u32(i)];
    st[k] = f32(ivMat(v)) * 1000.0 + min(ivZ1(v) - ivZ0(v), 999.0);
    k += 1u;
  }
  textureStore(strataOut, p, st);
  // the open air's floors: level j lies under projected interval j-1 (the
  // sky for j = 0) and over projected interval j
  var lv = vec4<f32>(-1.0);
  var ceil = 1e9;
  for (var j = 0u; j <= PROJ_K; j++) {
    var below = IV_NONE;
    if (j < PROJ_K) { below = projAt(p, j); }
    var fl = 0.0;
    // (what of the column's own ground reaches up into it)
    for (var i = 0u; i < n; i++) {
      if (ivZ0(arr[i]) < ceil) { fl = max(fl, min(ivZ1(arr[i]), ceil)); }
    }
    if (!ivEmpty(below)) { fl = max(fl, ivZ1(below)); }
    lv[j] = fl;
    if (ivEmpty(below)) { break; }
    ceil = ivZ0(below);
  }
  textureStore(levelsOut, p, lv);
}
