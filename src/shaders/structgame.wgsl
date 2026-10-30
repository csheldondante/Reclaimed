// ---- structures in the game (round 117, `structures`; src/render/renderer.ts enableStructures) --------------------
// Appended to render.wgsl + structmesh.wgsl: the city's pieces drawn with the game's own light (lighting: the sun, the
// shadow map, the sky, firelight, lightning), haze and cut-aways, into the world pass's colour and pick targets, as the
// trees are (meshinst.wgsl). The pieces' data is the draw group's binding 3 (render.wgsl `instances`), read as floats.

fn spFetch(i: u32) -> vec4<f32> { return bitcast<vec4<f32>>(instances[i]); }
// (the day/night cycle's darkness: G.sky.w, 1 at night — render.wgsl haze)
fn hostNight() -> f32 { return smoothstep(0.3, 0.8, G.sky.w); }
// (a draped piece on the window's ground now: its column's top (the field mesh draws the ground through it); past the window,
// the plan's)
// (the field mesh draws soft ground up to about a cell over its column's whole-cell top: half that lifts a draped piece onto
// it)
const DRAPE_LIFT: f32 = 0.15;
fn hostGround(xy: vec2<f32>, planned: f32) -> f32 {
  let c = cellAt(xy);
  if (!inMap(c)) { return planned; }
  // (the loose ground lying on it too: drift, sand, soil — render.wgsl's bed)
  return sfZ(surface[colIdxI(c)]) + driftAt(c) + DRAPE_LIFT;
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
  var sv: SpVert;
  sv.wpos = in.wpos;
  sv.w = in.w;
  sv.part = in.info.x;
  sv.look = in.info.y;
  sv.seed = bitcast<f32>(in.info.z);
  sv.base = in.base;
  var col = spAlbedo(sv, n) * lighting(in.wpos, n) + spEmit(sv);
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(in.info.w + 1u, pickInfo(MAT_STONE, in.wpos.z, 0u));
  return o;
}
