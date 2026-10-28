// ---- the town's columns (round 65, build/town.ts) ---------------------------
// The town is real matter: its walls, floors and roofs are intervals in the
// columns like any rock, so dust drifts onto them, sand buries them and they
// crack and crumble. A stamp rewrites one column's span [lo, hi): what was
// there goes (the town's own old matter, or the ground the building stands
// in), the design comes in; loose ground in the span isn't lost — it lands
// on the new top and slides off as it will. Under lo the column is kept
// (clipped at lo), with a stone foundation from its top up to lo when asked.
// One thread a stamp, each its own column (the CPU never sends one column
// twice in a batch).
@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
// two a stamp: x the column (y * w + x), y design intervals, z where they
// start in `design`, w flags (1: a foundation); then x lo, y hi (f32 bits)
@group(0) @binding(4) var<storage, read> recs: array<vec4<u32>>;
// the designs, in the layers' form (bottom up, within [lo, hi))
@group(0) @binding(5) var<storage, read> design: array<vec4<u32>>;
// x stamps this tick
@group(0) @binding(6) var<uniform> TP: vec4<u32>;

const MAT_STONE_T: u32 = 1u;
// built matter starts fully supported (the structure pass works it out from there)
const AUX_BUILT: u32 = 240u;
const OUT_N: u32 = 40u;

@compute @workgroup_size(64)
fn stampCols(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= TP.x) { return; }
  let r0 = recs[id.x * 2u];
  let r1 = recs[id.x * 2u + 1u];
  // (the CPU's window-order index)
  let xy = winXY(r0.x);
  let x = xy.x;
  let y = xy.y;
  let lo = bitcast<f32>(r1.x);
  let hi = bitcast<f32>(r1.y);
  let cs = colSlots(x, y);
  var o: array<vec4<u32>, OUT_N>;
  var n = 0u;
  var above: array<vec4<u32>, MAX_K>;
  var na = 0u;
  var loose = 0.0;
  var looseMat = 0u;
  var looseBig = 0.0;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    let m = ivMat(v);
    if (z0 < lo) {
      o[n] = ivPack(z0, min(z1, lo), m, ivAux(v));
      n += 1u;
    }
    let a = max(z0, lo);
    let b = min(z1, hi);
    if (b > a && matState(m) == ST_GRANULAR) {
      loose += b - a;
      if (b - a > looseBig) { looseBig = b - a; looseMat = m; }
    }
    if (z1 > hi) {
      above[na] = ivPack(max(z0, hi), z1, m, ivAux(v));
      na += 1u;
    }
  }
  var top = select(0.0, ivZ1(o[max(n, 1u) - 1u]), n > 0u);
  if ((r0.w & 1u) != 0u && top < lo - 0.01) {
    o[n] = ivPack(top, lo, MAT_STONE_T, AUX_BUILT);
    n += 1u;
  }
  for (var k = 0u; k < r0.y && n < OUT_N - MAX_K - 2u; k++) {
    o[n] = design[r0.z + k];
    n += 1u;
  }
  for (var k = 0u; k < na; k++) {
    o[n] = above[k];
    n += 1u;
  }
  // the loose ground that was in the span, on top
  if (loose > 1e-3 && n > 0u) {
    let zt = ivZ1(o[n - 1u]);
    o[n] = ivPack(zt, min(zt + loose, f32(G.zMax) - 1.0), looseMat, 0u);
    n += 1u;
  }
  // (touching intervals of one material are one)
  var m = 0u;
  for (var k = 0u; k < n; k++) {
    if (m > 0u && ivMat(o[k]) == ivMat(o[m - 1u]) && abs(ivZ0(o[k]) - ivZ1(o[m - 1u])) < 1e-3) {
      o[m - 1u] = ivPack(ivZ0(o[m - 1u]), ivZ1(o[k]), ivMat(o[k]), ivAux(o[m - 1u]));
    } else {
      o[m] = o[k];
      m += 1u;
    }
  }
  n = m;
  // more than the column holds: close its smallest gaps (a window filled in),
  // else fold its thinnest interval into the one under it
  loop {
    if (n <= cs.y) { break; }
    var best = 1e9;
    var bk = 1u;
    for (var k = 1u; k < n; k++) {
      let g = ivZ0(o[k]) - ivZ1(o[k - 1u]);
      if (g < best) { best = g; bk = k; }
    }
    if (best < 1e-3) {
      best = 1e9;
      for (var k = 1u; k < n; k++) {
        let t = ivZ1(o[k]) - ivZ0(o[k]);
        if (t < best) { best = t; bk = k; }
      }
    }
    let lower = o[bk - 1u];
    o[bk - 1u] = ivPack(ivZ0(lower), ivZ1(o[bk]), ivMat(lower), ivAux(lower));
    for (var k = bk; k + 1u < n; k++) { o[k] = o[k + 1u]; }
    n -= 1u;
  }
  for (var k = 0u; k < cs.y; k++) { layers[cs.x + k] = select(IV_NONE, o[k], k < n); }
}
