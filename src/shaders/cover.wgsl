// ---- the weather's cover past the window (round 108, TC20; weather/cover.ts) -----------------------------------
// The user: "the distant tiles have seems and sometimes miss certain effects like snow". A tile is baked once; the
// weather it shows must not be baked into it (it would go stale) — the snow lying on the land, the ice on its water
// and how wet the ground is are kept here at the atlas's scale (coverfield.wgsl: a ring of texels round the window,
// COVER_CELL cells each) and the tiles read them when they're drawn (tiles.wgsl fsTile), as they read the light.
//   measure: a world's land into the field — the window's every update (its own snow and ice, from the climate sim,
//            and its moisture: the field there is the window's), or a render-only tile's once, as it's made (seed:
//            only texels the field doesn't hold yet — the land as made: a peak's snow, its moisture, its water).
//   step:    every texel the window doesn't cover: the storms' snow and rain on it, the snow and ice melting in the
//            warm, its water freezing in the cold, the ground drying back to its own moisture — then the texel drawn
//            (coverOut: snow, wet, ice, which lap round the ring it is).
// State a texel (vec4<u32>): x snow (cells, f32); y wet | its own moisture (pack2x16float); z the ground's height
// (window z: the air's temperature there) | the share of it iced (pack2x16float); w which world texel it holds (its
// lap round the ring, x | y << 4, | 1 << 15; 0: none) | the share of it under water (unorm, << 16).

@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> moisture: array<f32>;
@group(0) @binding(5) var<storage, read> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> cover: array<vec4<u32>>;
@group(0) @binding(7) var coverOut: texture_storage_2d<rgba16float, write>;
/** x: 0 measure the window (always), 1 seed (only texels not held); y: the step's seconds; z, w: the square of the
 *  world's cells that's its land (cells, both ways: a tile's scratch holds its region from its border on — the rest
 *  of it is border or empty) */
@group(0) @binding(8) var<uniform> CP: vec4<f32>;

// (climate.wgsl's: a storm of intensity 1's snow a second — RAIN_RATE_C · 4 ticks · SNOW_FALL, 15 updates a second —
// and the melt a second a degree over freezing)
const SNOW_RATE: f32 = 0.036;
const MELT_SNOW_S: f32 = 0.002;
// the ground wetted by rain (moisture a second at intensity 1) and how long it takes to dry back (s)
const WET_RATE: f32 = 0.05;
const DRY_S: f32 = 240.0;
// how long water takes to ice over in the cold, and the ice to go in the warm (s; climate.wgsl FREEZE, MELT_ICE: a
// sheet worth seeing in a few seconds at -8, gone over minutes)
const FREEZE_S: f32 = 20.0;
const THAW_S: f32 = 120.0;
/** a cell under water this deep is water (render.wgsl's film) */
const WET_CELL: f32 = 0.05;

/** the storms' rain over a texel (common.wgsl rainAt, its ragged noise taken at its mean: a texel is 8 cells across,
 *  and the field's every texel steps — the noise's octaves for each of them would be most of its cost) */
fn rainOver(p: vec2<f32>) -> f32 {
  var r = 0.0;
  for (var i = 0u; i < G.numStorms; i++) {
    let d = stormDist(p, i);
    if (d >= 1.0) { continue; }
    r += G.storms[i].w * (1.0 + G.stormsB[i].z) * smoothstep(1.0, 0.35, d) * 0.9;
  }
  return r;
}

/** the window's cell (0, 0) as a world cell */
fn orgCell() -> vec2<i32> { return vec2<i32>(round(G.org.zw)); }

/** which world texel a ring texel holds: its lap round the ring (coverfield.wgsl coverLap) */
fn coverId(t: vec2<i32>) -> u32 {
  let lap = vec2<u32>(coverLap(t));
  return lap.x | (lap.y << 4u) | (1u << 15u);
}

/** the world texel ring texel k stands for now: the one nearest the window's middle */
fn coverWorld(k: vec2<i32>) -> vec2<i32> {
  let mid = vec2<i32>(floor((vec2<f32>(orgCell()) + vec2<f32>(f32(G.mapW), f32(G.mapH)) * 0.5) / COVER_CELL));
  let d = ((k - mid) % vec2<i32>(COVER_N) + vec2<i32>(COVER_N + COVER_N / 2)) % vec2<i32>(COVER_N) - vec2<i32>(COVER_N / 2);
  return mid + d;
}

/** a world texel is a world's to measure: its middle cell is in that world's map */
fn mine(t: vec2<i32>) -> bool {
  let m = vec2<i32>(floor(vec2<f32>(t) * COVER_CELL)) - orgCell() + vec2<i32>(i32(COVER_CELL * 0.5));
  return inMap(m) && all(vec2<f32>(m) >= vec2<f32>(CP.z)) && all(vec2<f32>(m) < vec2<f32>(CP.w));
}

/** the world's cells in world texel t, over them: the snow lying, the moisture, the ground's top, the shares iced and
 *  under water */
struct Meas { snow: f32, wet: f32, z: f32, ice: f32, water: f32 };
fn measureTexel(t: vec2<i32>) -> Meas {
  var o = Meas(0.0, 0.0, 0.0, 0.0, 0.0);
  var n = 0.0;
  let c0 = vec2<i32>(floor(vec2<f32>(t) * COVER_CELL)) - orgCell();
  let C = i32(COVER_CELL);
  for (var dy = 0; dy < C; dy++) {
    for (var dx = 0; dx < C; dx++) {
      let p = c0 + vec2<i32>(dx, dy);
      if (!inMap(p)) { continue; }
      let i = colIdx(u32(p.x), u32(p.y));
      // (the loose run on top: its depth, its top interval's depth and material — surface.wgsl's drift texture; with
      // none, the surface word's material is the top's)
      let d = textureLoad(driftTex, texCol(p), 0);
      let s = surface[i];
      n += 1.0;
      if (u32(d.z + 0.5) == MAT_SNOW) { o.snow += d.y; }
      if (d.x <= 0.0 && sfMat(s) == MAT_ICE) { o.ice += 1.0; }
      if (water[i] > WET_CELL) { o.water += 1.0; }
      o.wet += moisture[i];
      o.z += sfZ(s) + d.x;
    }
  }
  if (n > 0.0) {
    o.snow /= n;
    o.wet /= n;
    o.z /= n;
    o.ice /= n;
    o.water /= n;
  }
  // (the ice counted as water: it's water frozen)
  o.water = max(o.water, o.ice);
  return o;
}

@compute @workgroup_size(8, 8)
fn measure(@builtin(global_invocation_id) id: vec3<u32>) {
  // (the texels the world's cells fall in: from the one its corner's in, a texel past its far side)
  let t0 = vec2<i32>(floor(vec2<f32>(orgCell()) / COVER_CELL));
  let t = t0 + vec2<i32>(id.xy);
  let k = coverRing(t);
  let j = u32(k.y * COVER_N + k.x);
  let tid = coverId(t);
  let held = (cover[j].w & 0xffffu) == tid;
  if (!mine(t) || (CP.x > 0.5 && held)) { return; }
  let m = measureTexel(t);
  // (its own moisture: what it was when first seen — a seed's, or the window's the first time it held it)
  var base = m.wet;
  if (held) { base = unpack2x16float(cover[j].y).y; }
  cover[j] = vec4<u32>(bitcast<u32>(m.snow), pack2x16float(vec2<f32>(m.wet, base)), pack2x16float(vec2<f32>(m.z, m.ice)), tid | (u32(round(m.water * 65535.0)) << 16u));
  // (drawn now too: a render-only tile's bake reads what the cover is where its own snow lies, in the same encoder)
  textureStore(coverOut, k, vec4<f32>(m.snow, m.wet, m.ice, coverLapCode(t)));
}

@compute @workgroup_size(8, 8)
fn step(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(COVER_N) || id.y >= u32(COVER_N)) { return; }
  let k = vec2<i32>(id.xy);
  let j = id.y * u32(COVER_N) + id.x;
  let t = coverWorld(k);
  var s = cover[j];
  if ((s.w & 0xffffu) != coverId(t)) {
    // (nothing known of the land the ring has brought here)
    textureStore(coverOut, k, vec4<f32>(0.0, 0.0, 0.0, -1.0));
    return;
  }
  var snow = bitcast<f32>(s.x);
  var ww = unpack2x16float(s.y);
  var zi = unpack2x16float(s.z);
  // (the window's own texels are its measure's: the weather steps only the land past it)
  if (!mine(t)) {
    let dt = CP.y;
    let cc = vec2<i32>(floor(vec2<f32>(t) * COVER_CELL)) - orgCell() + vec2<i32>(i32(COVER_CELL * 0.5));
    let at = vec2<f32>(f32(cc.x) + 0.5, (f32(cc.y) + 0.5) * ROW_H);
    let rain = rainOver(at);
    let temp = airTempAt(zi.x);
    snow += rain * SNOW_RATE * snowShare(temp) * dt;
    if (temp > 0.5) { snow = max(0.0, snow - MELT_SNOW_S * (temp - 0.5) * dt); }
    ww.x = min(1.0, ww.x + rain * WET_RATE * (1.0 - snowShare(temp)) * dt);
    ww.x += (ww.y - ww.x) * (1.0 - exp(-dt / DRY_S));
    let wat = f32(s.w >> 16u) / 65535.0;
    if (temp < -0.5) { zi.y += (wat - zi.y) * (1.0 - exp(-dt / FREEZE_S)); }
    else if (temp > 0.5) { zi.y -= zi.y * (1.0 - exp(-dt / THAW_S)); }
    s.x = bitcast<u32>(snow);
    s.y = pack2x16float(ww);
    s.z = pack2x16float(zi);
    cover[j] = s;
  }
  textureStore(coverOut, k, vec4<f32>(snow, ww.x, zi.y, coverLapCode(t)));
}
