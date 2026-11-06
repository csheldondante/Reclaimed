// ---- wind field ---------------------------------------------------------------
// The one wind field everything feels (DECISIONS round 8): rg holds the wind
// the player has painted by dragging, ba the whole wind = the map's own wind
// (mapWind) + the painted wind. The painted part blends slowly back to the
// map wind by decaying to zero (e-folding ~7 s). One texel per 2×2 columns,
// cells/s.
// Each tick: carry the field along itself (semi-Lagrangian), spread it a
// little, let it relax, then add the current stroke segments (gusts[1..3]:
// x,y = segment end, gustDir.xy = direction, gustDir.z = segment length,
// z = radius, w = wind one pass adds). Passes stack (DECISIONS round 8): one
// pass ≈ a breeze, two a gust, three a gale. The add is scaled by segment
// length / stroke width so a pass adds the same whatever its speed.
@group(0) @binding(16) var windOut: texture_storage_2d<rgba32float, write>;
// air shoved by physics voxels landing, per texel (×1000; physics.ts, last tick); then (DA-B16) the box of the texels
// shoved: 65535 − x0, 65535 − y0, x1, y1 (all 0: none)
@group(0) @binding(30) var<storage, read> puff: array<u32>;
// blows and strokes (the world API's wind: api/wind.ts): [0].x the count,
// then per entry (x, y, radius, strength cells/s — a stroke's cap), (dx, dy,
// mode, a stroke's length), (a stroke's paint, 0, 0, 0); mode 0 along
// (dx, dy), 1 outward, 2 inward, 3 swirl (counter-clockwise; dx < 0
// clockwise), 4 a stroke: a segment ending at (x, y), painted as the
// player's drag is, never past its cap along it (a mover's wake)
@group(0) @binding(31) var<storage, read> blows: array<vec4<f32>>;
// (a blow holds the painted wind at its strength, reached in ~BLOW_S)
const BLOW_S: f32 = 0.12;

const DT_W: f32 = 1.0 / 60.0;
/** (perfopt, simhz) the world time a tick stands for */
fn dtW() -> f32 { return DT_W * simStep() * WIND_K; }
const DECAY_S: f32 = 7.0;
const MAX_W: f32 = 24.0;

fn texAt(t: vec2<i32>) -> vec2<f32> {
  let dims = vec2<i32>(textureDimensions(windTex));
  if (any(t < vec2<i32>(0)) || any(t >= dims)) { return vec2<f32>(0.0); }
  return textureLoad(windTex, texCol2(vec2<i32>(t)), 0).xy;
}

// (round 104, simscale — sim/systems.ts WindFieldSystem) what this dispatch covers: x, y its first texel; z the
// mode — 0 the painted wind's update (where something blew lately, sim/windrect.ts), 1 the map's own wind
// refreshed under the painted wind as it stands (the rest of the field, a band a tick); w unused
@group(0) @binding(32) var<uniform> WR: vec4<u32>;
// (DA-B16) the painted wind's box this update, made on the GPU (windBox): the dispatch's args, then x0, y0, x1, y1 —
// the run with WR.w = 1 starts there (an indirect dispatch: what things landing shove is known only on the GPU)
@group(0) @binding(33) var<storage, read> wbox: array<u32>;
/** painted wind weaker than this (cells/s) is none: what's left of a blow ends, so its texels can stop updating */
const PAINT_MIN: f32 = 0.05;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<u32>(textureDimensions(windTex));
  let at = select(WR.xy, vec2<u32>(wbox[4], wbox[5]), WR.w == 1u);
  let id = gid.xy + at;
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  if (WR.w == 1u && (id.x >= wbox[6] || id.y >= wbox[7])) { return; }
  let t = vec2<i32>(id.xy);
  let c = (vec2<f32>(t) + 0.5) * 2.0; // world position of this texel
  var v = texAt(t);
  if (WR.z == 1u) {
    textureStore(windOut, texCol2(vec2<i32>(t)), vec4<f32>(v, mapWind(c) + v));
    return;
  }
  // advect: the gust drifts on in its own direction, but slowly (30 % of its
  // speed) so painted wind stays roughly where it was painted
  v = windField(c - v * dtW() * 0.3);
  // spread
  let avg = (texAt(t + vec2<i32>(1, 0)) + texAt(t - vec2<i32>(1, 0)) + texAt(t + vec2<i32>(0, 1)) + texAt(t - vec2<i32>(0, 1))) * 0.25;
  v = mix(v, avg, 1.0 - pow(0.94, simStep() * WIND_K));
  // die down
  v *= exp(-dtW() / DECAY_S);
  // painted wind is wilder under a storm (round 10), and never quite
  // mechanical: a little noise in its direction and strength
  let stormBoost = 1.0 + 0.8 * stormCover(c);
  let wob = vnoise(c * 0.15 + vec2<f32>(G.time * 0.6, 3.0)) - 0.5;
  let ca = cos(wob * 0.5);
  let sa = sin(wob * 0.5);
  // stamp the strokes being drawn right now
  for (var k = 1u; k < 4u; k++) {
    let g = G.gusts[k];
    if (g.w <= 0.0) { continue; }
    let d0 = G.gustDir[k].xy;
    let dir = vec2<f32>(d0.x * ca - d0.y * sa, d0.x * sa + d0.y * ca);
    let len = G.gustDir[k].z;
    let a = g.xy - d0 * len;
    let s = clamp(dot(c - a, d0), 0.0, len);
    let d = length(c - (a + d0 * s));
    let f = smoothstep(g.z, g.z * 0.35, d);
    v += dir * g.w * stormBoost * (0.85 + 0.3 * (wob + 0.5)) * f * min(1.0, len / (1.3 * g.z));
  }
  // blows: under each, the painted wind is pushed toward the blow's strength
  // along its direction and never past it, so a held blow is a steady wind
  // (and stacking blows doesn't run away); it decays as painted wind does
  // once the blow ends
  let nb = u32(blows[0].x);
  for (var k = 0u; k < nb; k++) {
    let a = blows[1u + k * 3u];
    let b = blows[2u + k * 3u];
    if (u32(b.z + 0.5) == 4u) {
      // a stroke: as the drag's segments above, capped
      let len = b.w;
      let s0 = a.xy - b.xy * len;
      let s = clamp(dot(c - s0, b.xy), 0.0, len);
      let ds = length(c - (s0 + b.xy * s));
      if (ds > a.z) { continue; }
      let sdir = vec2<f32>(b.x * ca - b.y * sa, b.x * sa + b.y * ca);
      let add = blows[3u + k * 3u].x * stormBoost * (0.85 + 0.3 * (wob + 0.5)) * smoothstep(a.z, a.z * 0.35, ds) * min(1.0, len / (1.3 * a.z));
      v += sdir * min(add, max(a.w - dot(v, sdir), 0.0));
      continue;
    }
    let o = c - a.xy;
    let d = length(o);
    if (d > a.z) { continue; }
    let fall = smoothstep(a.z, a.z * 0.35, d);
    var dir = b.xy;
    let m = u32(b.z + 0.5);
    let od = o / max(d, 0.01);
    if (m == 1u) { dir = od; }
    if (m == 2u) { dir = -od; }
    if (m == 3u) { dir = vec2<f32>(-od.y, od.x) * select(1.0, -1.0, b.x < 0.0); }
    if (d < 0.01 && m != 0u) { continue; }
    let along = dot(v, dir);
    v += dir * max(a.w - along, 0.0) * fall * (1.0 - exp(-dtW() / BLOW_S));
  }
  // a click's ripple: wind pushing out from it in a ring (round 20: every
  // click is a breath of wind — you are the wind); it relaxes away like any
  // painted wind
  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_RIPPLE) { continue; }
    let ev = G.events[e];
    let o = c - ev.xy;
    let d = length(o);
    if (d < 0.01 || d > ev.z) { continue; }
    v += o / d * ev.w * smoothstep(ev.z, ev.z * 0.45, d) * smoothstep(0.0, ev.z * 0.3, d);
  }
  // things landing shove the air out from under them (round 47): each
  // texel's shove pushes the wind away from it, out to two texels
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let n = t + vec2<i32>(dx, dy);
      if ((dx == 0 && dy == 0) || any(n < vec2<i32>(0)) || any(n >= vec2<i32>(dims))) { continue; }
      let s = f32(puff[u32(n.y) * dims.x + u32(n.x)]) / 1000.0;
      if (s <= 0.0) { continue; }
      let o = vec2<f32>(f32(-dx), f32(-dy));
      let d = length(o);
      v += o / d * min(s, 12.0) * (1.0 - d / 3.0);
    }
  }
  let m = length(v);
  if (m > MAX_W) { v *= MAX_W / m; }
  if (m < PAINT_MIN) { v = vec2<f32>(0.0); }
  textureStore(windOut, texCol2(vec2<i32>(t)), vec4<f32>(v, mapWind(c) + v));
}

// ---- (DA-B16) the painted wind's box, made on the GPU ----------------------------------------------------------------
// The CPU knows where the player and the world painted (strokes, blows, ripples: sim/windrect.ts, its box in WB.cpu);
// things landing shove the air where the GPU has them (phys.wgsl: this tick's box after the puff texels). windBox keeps
// that shove's box as a stamp — the box of the shoves since it was empty, the tick of its first and its last — and grows
// it by how far painted wind can have gone since its first (windrect.ts reach); a stamp dies LIFE ticks after its last
// shove. The update's box is the CPU's and the stamp's together, as the dispatch's args (wbox) for main and windCopy.
struct WindBoxIn {
  /** the CPU's painted box, texels [x0, y0, x1, y1) (x1 <= x0: none) */
  cpu: vec4<i32>,
  /** x the tick now (60 Hz), y painted wind's life (60 Hz ticks), z w the window's slide since the last update (texels) */
  t: vec4<f32>,
}
@group(0) @binding(34) var<storage, read_write> stamp: array<vec4<f32>, 2>;
@group(0) @binding(35) var<storage, read_write> wboxOut: array<u32>;
@group(0) @binding(36) var<uniform> WB: WindBoxIn;

/** windrect.ts reach: how far (texels) painted wind can have gone `ticks` 60 Hz steps after its stamp */
fn windReach(ticks: f32) -> f32 {
  let s = ticks / 60.0;
  let drift = (0.3 * MAX_W * DECAY_S * (1.0 - exp(-s / DECAY_S))) / 2.0;
  let spread = 3.0 * sqrt(0.03 * ticks);
  return 2.0 + drift + spread;
}

@compute @workgroup_size(1)
fn windBox() {
  let dims = vec2<i32>(textureDimensions(windTex));
  let now = WB.t.x;
  var b = stamp[0];
  var tt = stamp[1];
  // (the window slid: the stamp goes with the land)
  b -= vec4<f32>(WB.t.z, WB.t.w, WB.t.z, WB.t.w);
  let alive = tt.z > 0.5 && now - tt.y < WB.t.y;
  let tail = u32(dims.x * dims.y);
  if (puff[tail + 2u] > 0u) {
    let p = vec4<f32>(65535.0 - f32(puff[tail]), 65535.0 - f32(puff[tail + 1u]), f32(puff[tail + 2u]), f32(puff[tail + 3u]));
    if (alive) {
      b = vec4<f32>(min(b.xy, p.xy), max(b.zw, p.zw));
      tt.y = now;
    } else {
      b = p;
      tt = vec4<f32>(now, now, 1.0, 0.0);
    }
  } else if (!alive) {
    tt.z = 0.0;
  }
  stamp[0] = b;
  stamp[1] = tt;
  var lo = vec2<i32>(dims);
  var hi = vec2<i32>(0);
  if (WB.cpu.z > WB.cpu.x && WB.cpu.w > WB.cpu.y) {
    lo = WB.cpu.xy;
    hi = WB.cpu.zw;
  }
  if (tt.z > 0.5) {
    let m = ceil(windReach(now - tt.x));
    lo = min(lo, vec2<i32>(floor(b.xy - m)));
    hi = max(hi, vec2<i32>(ceil(b.zw + m)));
  }
  lo = max(lo, vec2<i32>(0));
  hi = min(hi, dims);
  let n = select(vec2<u32>(0u), vec2<u32>((hi - lo + 7) / 8), all(hi > lo));
  wboxOut[0] = n.x;
  wboxOut[1] = select(0u, n.y, n.x > 0u);
  wboxOut[2] = 1u;
  wboxOut[4] = u32(max(lo.x, 0));
  wboxOut[5] = u32(max(lo.y, 0));
  wboxOut[6] = u32(max(hi.x, 0));
  wboxOut[7] = u32(max(hi.y, 0));
}

// (DA-B16) the box's new texels into the field everything reads (the next texture's, where they lie on the ring)
@group(0) @binding(37) var windNextTex: texture_2d<f32>;
@group(0) @binding(38) var windFieldOut: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8)
fn windCopy(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy + vec2<u32>(wbox[4], wbox[5]);
  if (id.x >= wbox[6] || id.y >= wbox[7]) { return; }
  let q = texCol2(vec2<i32>(id));
  textureStore(windFieldOut, q, textureLoad(windNextTex, q, 0));
}
