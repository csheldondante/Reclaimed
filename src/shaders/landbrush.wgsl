// ---- landform brushes (round 64, docs/DECISIONS.md: "paint mountain ranges
// and mesas and have them rise from the ground relatively quickly under the
// brush") -------------------------------------------------------------------
// A stroke stamps where it went this tick (segments: from its last point to
// this one); each column keeps what the strokes still owe it, and the rock
// rises toward that at RISE cells/s, so the land comes up under the brush
// over a second or two. Two shapes:
//  * range: a ridge along the stroke — the height × a profile across it
//    (highest on the line), broken into peaks and spurs by ridged noise;
//    on top of the ground there;
//  * mesa: a flat top at a level (the stroke's), steep cliffs at its edge
//    (an outline broken by noise), grown in bands of sandstone and stone
//    by height (strata that line up across the land).
// The rock grows at the top of its run under the loose ground. The loose
// cover on a rising column turns to rock as it goes (sand pressed to
// sandstone; on a range, to stone), all but a skin of SKIN_B that rides up
// and is shaken off the new slopes — so cliffs come up bare, not buried in
// the sand they rose through (round 64: the sandbox's 4 cells of sand made
// every mesa a sand mound). The volume is kept. Overlapping stamps of a stroke
// compose: a column moves toward the most the stroke has asked of it.
@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
// per column: x still to rise (cells), y the stroke's most asked, z the ground's
// top when its stroke first touched it (mesa), w its stroke × 2 + its shape (0 range, 1 mesa)
@group(0) @binding(4) var<storage, read_write> brushState: array<vec4<f32>>;
@group(0) @binding(7) var shakeOut: texture_storage_2d<rgba32float, write>;

struct Stamp {
  // the segment it covers: from (x, y) to (z, w)
  a: vec4<f32>,
  // x half-width (cells), y height (range) or top level (mesa, absolute z), z shape (0 range, 1 mesa), w the stroke (a serial, from 1)
  b: vec4<f32>,
};
struct BrushParams {
  // x stamps this tick, y 1: rise this tick
  n: vec4<u32>,
  stamps: array<Stamp, 16>,
};
@group(0) @binding(6) var<uniform> BP: BrushParams;

const MAT_STONE_B: u32 = 1u;
const MAT_SANDSTONE_B: u32 = 30u;
// cells a second the rock rises
const RISE: f32 = 18.0;
// the loose skin left on rising ground (cells)
const SKIN_B: f32 = 0.4;

fn segDist(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - (a + ab * t));
}

fn vn(q: vec2<f32>, s: i32) -> f32 {
  let i = vec2<i32>(floor(q));
  let f = fract(q);
  let u = f * f * (3.0 - 2.0 * f);
  let a = randv(vec3<i32>(i, s));
  let b = randv(vec3<i32>(i + vec2<i32>(1, 0), s));
  let c = randv(vec3<i32>(i + vec2<i32>(0, 1), s));
  let d = randv(vec3<i32>(i + vec2<i32>(1, 1), s));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Ridged noise 0..1: sharp crests where the noise crosses its middle. */
fn ridgedB(q: vec2<f32>) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var f = 1.0;
  var n = 0.0;
  for (var o = 0; o < 4; o++) {
    var v = 1.0 - abs(vn(q * f, 61 + o * 7) * 2.0 - 1.0);
    v = v * v;
    s += v * a;
    n += a;
    a *= 0.5;
    f *= 2.07;
  }
  return s / n;
}

@compute @workgroup_size(8, 8)
fn stamp(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let wp = cellPos(p);
  var st = brushState[i];
  var touched = false;
  for (var e = 0u; e < BP.n.x; e++) {
    let s = BP.stamps[e];
    let hw = max(s.b.x, 0.5);
    let d = segDist(wp, s.a.xy, s.a.zw);
    if (d > hw * 1.4) { continue; }
    // (a stroke new to this column: nothing asked of it yet, its ground unread)
    let stroke = u32(s.b.w + 0.5);
    if (u32(st.w + 0.5) / 2u != stroke) { st.y = 0.0; st.z = -1.0; }
    var want = 0.0;
    if (s.b.z < 0.5) {
      // range: the crest on the line; peaks and spurs from ridged noise
      // turned across the stroke (spurs run down its sides)
      let f = pow(clamp(1.0 - d / hw, 0.0, 1.0), 1.6);
      let r = ridgedB(wp / 9.0);
      let r2 = ridgedB(wp / 4.0 + vec2<f32>(31.0, 7.0));
      // (peaks where the ridged noise crests, saddles between; spurs on the flanks)
      want = s.b.y * f * (0.25 + 0.75 * r * r) + s.b.y * 0.18 * r2 * sqrt(f);
    } else {
      // mesa: flat at the level, a steep broken edge
      let rr = d / hw + (vn(wp / 3.0, 77) - 0.5) * 0.35;
      let f = smoothstep(1.0, 0.88, rr);
      if (f <= 0.0) { continue; }
      if (st.z < 0.0) {
        let cs = colSlots(id.x, id.y);
        var n = 0u;
        for (var k = 0u; k < cs.y; k++) { if (ivEmpty(layers[cs.x + k])) { break; } n = k + 1u; }
        // (the ground's top, loose cover and all: it rides up on the rock, so
        // the top comes out at the level where it lies flat)
        st.z = select(0.0, ivZ1(layers[cs.x + n - 1u]), n > 0u);
      }
      want = max(s.b.y - st.z, 0.0) * f;
    }
    st.w = f32(stroke * 2u) + s.b.z;
    if (want > st.y) {
      st.x += want - st.y;
      st.y = want;
    }
    touched = true;
  }
  if (touched) { brushState[i] = st; }
}

@compute @workgroup_size(8, 8)
fn rise(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  var st = brushState[i];
  if (st.x <= 1e-4) { return; }
  let cs = colSlots(id.x, id.y);
  var arr: array<vec4<u32>, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    arr[k] = v;
    n = k + 1u;
  }
  if (n == 0u) { brushState[i] = vec4<f32>(0.0, st.y, st.z, st.w); return; }
  var dd = min(st.x, RISE * G.dt);
  // (under the sky's ceiling)
  dd = min(dd, max(f32(G.zMax) - 2.0 - ivZ1(arr[n - 1u]), 0.0));
  st.x = select(st.x - dd, 0.0, dd <= 0.0);
  if (dd > 0.0) {
    // the rock's run: its topmost interval that isn't loose
    var kr = 0u;
    for (var k = 0u; k < n; k++) { if (matState(ivMat(arr[k])) != ST_GRANULAR) { kr = k; } }
    let mesa = (u32(st.w + 0.5) & 1u) == 1u;
    // the loose cover over the run, but a skin, turns to rock (bottom up)
    var loose = ivZ1(arr[n - 1u]) - ivZ1(arr[kr]);
    var lith = loose - SKIN_B;
    let pressed = select(MAT_STONE_B, MAT_SANDSTONE_B, mesa);
    var k2 = kr + 1u;
    loop {
      if (lith <= 1e-3 || k2 >= n) { break; }
      let u = arr[k2];
      if (matState(ivMat(u)) != ST_GRANULAR) { break; }
      let t = ivZ1(u) - ivZ0(u);
      if (t <= lith || n >= cs.y) {
        arr[k2] = ivPack(ivZ0(u), ivZ1(u), pressed, 0u);
        lith -= t;
      } else {
        // (split: the bottom pressed, the rest still loose)
        for (var k = n; k > k2 + 1u; k--) { arr[k] = arr[k - 1u]; }
        arr[k2 + 1u] = ivPack(ivZ0(u) + lith, ivZ1(u), ivMat(u), ivAux(u));
        arr[k2] = ivPack(ivZ0(u), ivZ0(u) + lith, pressed, 0u);
        n += 1u;
        lith = 0.0;
      }
      k2 += 1u;
    }
    // (pressed rock joins the run: the topmost interval that isn't loose again)
    for (var k = 0u; k < n; k++) { if (matState(ivMat(arr[k])) != ST_GRANULAR) { kr = k; } }
    // (touching intervals of one material merge)
    var m = 0u;
    for (var k = 0u; k < n; k++) {
      if (m > 0u && ivMat(arr[k]) == ivMat(arr[m - 1u]) && abs(ivZ0(arr[k]) - ivZ1(arr[m - 1u])) < 1e-3) {
        arr[m - 1u] = ivPack(ivZ0(arr[m - 1u]), ivZ1(arr[k]), ivMat(arr[k]), ivAux(arr[m - 1u]));
        if (k <= kr) { kr -= 1u; }
      } else {
        arr[m] = arr[k];
        m += 1u;
      }
    }
    for (var k = m; k < n; k++) { arr[k] = IV_NONE; }
    n = m;
    for (var k = 0u; k < n; k++) { if (matState(ivMat(arr[k])) != ST_GRANULAR) { kr = k; } }
    let v = arr[kr];
    let z1 = ivZ1(v);
    var mat = MAT_STONE_B;
    if (mesa) {
      // the band at this height: ~4 cells of sandstone, then stone, wavy
      let band = floor((z1 + vn(cellPos(p) / 30.0, 91) * 2.0) / 4.0);
      mat = select(MAT_STONE_B, MAT_SANDSTONE_B, (i32(band) % 3) != 1);
    }
    // what lies over the run rides up
    for (var k = n; k > kr + 1u; k--) {
      let w = arr[k - 1u];
      arr[k - 1u] = ivPack(ivZ0(w) + dd, ivZ1(w) + dd, ivMat(w), ivAux(w));
    }
    if (ivMat(v) == mat || n >= cs.y) {
      arr[kr] = ivPack(ivZ0(v), z1 + dd, ivMat(v), ivAux(v));
    } else {
      // a new band on the run (what's over it moves up a slot)
      for (var k = n; k > kr + 1u; k--) { arr[k] = arr[k - 1u]; }
      arr[kr + 1u] = ivPack(z1, z1 + dd, mat, 0u);
      n += 1u;
    }
    // (loose ground on it: shaken off the new slope)
    if (kr + 1u < n && matState(ivMat(arr[n - 1u])) == ST_GRANULAR) {
      textureStore(shakeOut, p, vec4<f32>(f32(G.tick), 1.0, 0.0, 0.0));
    }
    for (var k = 0u; k < cs.y; k++) { layers[cs.x + k] = select(IV_NONE, arr[k], k < n); }
  }
  brushState[i] = st;
}
