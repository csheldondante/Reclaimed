// ---- structures in the game (round 117, `structures`; src/render/renderer.ts enableStructures) --------------------
// Appended to render.wgsl + structmesh.wgsl: the city's pieces drawn with the game's own light (lighting: the sun, the
// shadow map, the sky, firelight, lightning), haze and cut-aways, into the world pass's colour and pick targets, as the
// trees are (meshinst.wgsl). The pieces' data is the draw group's binding 3 (render.wgsl `instances`), read as floats.

fn spFetch(i: u32) -> vec4<f32> { return bitcast<vec4<f32>>(instances[i]); }
// (the day/night cycle's darkness: G.sky.w, 1 at night — render.wgsl haze)
fn hostNight() -> f32 { return smoothstep(0.3, 0.8, G.sky.w); }
// (round 120) the wind: the plants' lean there (sway.wgsl's spring, 0.3 a strong wind) as the banners' strength; past
// the window, the prevailing wind
fn hostWind(xy: vec2<f32>) -> vec2<f32> {
  let c = cellAt(xy);
  if (!inMap(c)) { return vec2<f32>(G.windX, G.windY) / 6.0; }
  return bend[colIdxI(clampCell(c))].xy / 0.3;
}
fn hostTime() -> f32 { return G.time; }
// (a draped piece on the window's ground now: its column's top and the loose ground on it (render.wgsl's bed), a little
// over; past the window, the plan's)
const DRAPE_LIFT: f32 = 0.15;
fn hostGround(xy: vec2<f32>, planned: f32) -> f32 {
  let c = cellAt(xy);
  if (!inMap(c)) { return planned; }
  // the three nearest columns' tops blended (barycentric: the columns are whole cells, stepped — one column's top made
  // the rows' vertices jump a step apart into fins); a building's or a wall's column (External: its top the roof's) isn't
  // ground and is left out (structmesh.wgsl spVertex decides per piece what to do with it)
  let t = triAt(xy);
  var acc = 0.0;
  var wsum = 0.0;
  for (var k = 0; k < 3; k++) {
    let q = clampCell(t.c[k]);
    let s = surface[colIdxI(q)];
    if (sfMat(s) == MAT_EXTERNAL) { continue; }
    acc += t.w[k] * (sfZ(s) + driftAt(q));
    wsum += t.w[k];
  }
  if (wsum < 1e-3) { return planned; }
  return acc / wsum + DRAPE_LIFT;
}

struct SGOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  // part, look, seed's bits, the column under it (the pick's)
  @location(1) @interpolate(flat) info: vec4<u32>,
  @location(2) @interpolate(flat) base: vec3<f32>,
  @location(3) w: f32,
};

@vertex
fn vsStruct(@location(0) a: vec4<f32>, @builtin(instance_index) ii: u32) -> SGOut {
  let sv = spVertex(a, ii);
  var o: SGOut;
  o.pos = CAM.viewProj * vec4<f32>(sv.wpos, 1.0);
  o.wpos = sv.wpos;
  o.info = vec4<u32>(sv.part, sv.look, bitcast<u32>(sv.seed), winIdx(clampCell(cellAt(sv.wpos.xy))));
  o.base = sv.base;
  o.w = sv.w;
  return o;
}

@fragment
fn fsStruct(in: SGOut) -> FOut {
  // (derivatives first: the cut may discard)
  var n = normalize(cross(dpdx(in.wpos), dpdy(in.wpos)));
  if (dot(n, toEye(in.wpos)) < 0.0) { n = -n; }
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  // (round 128d, fortress) look bit 23: a block planned, not built yet — see-through (every other pixel, a screen door:
  // the pass is opaque) and pale, so what stands reads apart from what's still to build
  let ghost = (in.info.y & 0x800000u) != 0u;
  if (ghost && ((u32(in.pos.x) + u32(in.pos.y)) & 1u) == 0u) { discard; }
  var sv: SpVert;
  sv.wpos = in.wpos;
  sv.w = in.w;
  sv.part = in.info.x;
  sv.look = in.info.y;
  sv.seed = bitcast<f32>(in.info.z);
  sv.base = in.base;
  var col = spAlbedo(sv, n) * lighting(in.wpos, n) + spEmit(sv);
  if (sv.part == 20u) { col = spFlame(sv); }
  if (ghost) { col = mix(col, vec3<f32>(0.75, 0.85, 1.0), 0.55); }
  // (round 128d, fortress) look bit 24: the structure Inspect picked — warm gold, a slow pulse, so it reads at a glance
  if ((in.info.y & 0x1000000u) != 0u) { col = mix(col, vec3<f32>(1.0, 0.78, 0.25), 0.5 + 0.12 * sin(G.time * 4.0)) + vec3<f32>(0.05, 0.035, 0.0); }
  // (round 128h, fortress) look bit 25: the outline round cells a placement cut off from the stores — red, pulsing
  if ((in.info.y & 0x2000000u) != 0u) { col = vec3<f32>(0.95, 0.1, 0.06) * (0.85 + 0.25 * sin(G.time * 5.0)); }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(in.info.w + 1u, pickInfo(MAT_STONE, in.wpos.z, 0u));
  return o;
}

// ---- (round 120, cities) the lights' pools: drawn after the opaque world, added to what's there (the pipeline blends
// one + one), no depth written — a pool of warm light on the ground round each lamp, torch and beacon at night
struct SPoolOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) @interpolate(flat) info: vec4<f32>,
};

@vertex
fn vsPool(@location(0) a: vec4<f32>, @builtin(instance_index) ii: u32) -> SPoolOut {
  let sv = spVertex(a, ii);
  var o: SPoolOut;
  o.pos = CAM.viewProj * vec4<f32>(sv.wpos, 1.0);
  o.wpos = sv.wpos;
  o.info = spPoolInfo(ii);
  return o;
}

@fragment
fn fsPool(in: SPoolOut) -> FOut {
  if (cutAway(in.wpos, in.pos.xy)) { discard; }
  var o: FOut;
  // (added to the lit, hazed colour already there: a little goes a long way in the encoded target)
  o.color = vec4<f32>(spPoolLight(in.wpos, in.info) * 0.8, 0.0);
  o.pick = vec2<u32>(0u, 0u);
  return o;
}
