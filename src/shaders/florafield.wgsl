// ---- plants placed by the world's other fields (round 117, flora) ------------------------------------------------
// The user: "Plants growing on fields". vegprep.wgsl places the succession field's plants (vegPlan: woods, thickets,
// meadows) and has all eight storage buffers; this kernel places what other fields decide, as library meshes into the
// same instance lists (floraput.wgsl):
//   - reeds at the water's edge and standing in the shallows ("Add reeds", round 117): ground within two cells of
//     open water, moist, not under deep water; denser the wetter.
// Run after vegprep in the render-prep pass (renderer.ts), over the window; off screen and heightfield-ring columns
// skipped as vegprep's are.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> veg: array<f32>;
@group(0) @binding(6) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> instTree: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> moisture: array<f32>;
@group(0) @binding(12) var<storage, read> water: array<f32>;

/** open water deeper than this is a river's or a lake's (not a puddle's after rain) */
const REED_WATER: f32 = 0.35;
/** reeds stand in water up to this deep (the margin; a shallow lake's middle is open water) */
const REED_WADE: f32 = 0.3;

fn waterAt(x: i32, y: i32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(G.mapW) || y >= i32(G.mapH)) { return 0.0; }
  return water[colIdx(u32(x), u32(y))];
}

fn wHash(x: i32, y: i32, salt: u32) -> f32 { return f32(pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(salt))) >> 8u) / 16777216.0; }
fn willowAt(c: vec2<u32>, i: u32) {
  if (water[i] > 0.02 || moisture[i] < 0.5) { return; }
  let w = vec2<i32>(i32(c.x) + i32(G.org.z), i32(c.y) + i32(G.org.w));
  let b = vec2<i32>(i32(floor(f32(w.x) / 9.0)), i32(floor(f32(w.y) / 10.0)));
  let cx = b.x * 9 + 1 + i32(floor(wHash(b.x, b.y, 0x3111u) * 7.0));
  let cy = b.y * 10 + 1 + i32(floor(wHash(b.x, b.y, 0x3112u) * 8.0));
  if (w.x != cx || w.y != cy) { return; }
  var near = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.785398;
    for (var r = 3; r <= 7; r += 2) {
      near = max(near, waterAt(i32(c.x) + i32(round(cos(a) * f32(r))), i32(c.y) + i32(round(sin(a) * f32(r)))));
    }
  }
  if (near < REED_WATER) { return; }
  let s = surface[i];
  let gm = groundMatAt(vec2<i32>(c), sfMat(s));
  if (MATS[gm].eco.x < 1.0) { return; }
  let top = groundCentreZ(vec2<i32>(c), f32(sfZ(s)));
  if (top < G.ocean.x - 0.1) { return; }
  let at = cellPos(vec2<i32>(c));
  let sz = 0.7 + 0.45 * wHash(w.x, w.y, 0x3113u);
  // (its level by its height on screen, as vegprep's trees)
  let hpx = 26.0 * sz * PC.viewport.z * FLORA_RPX;
  if (!floraSeen(at, top, 30.0 * sz, 9.0 * sz)) { return; }
  var r = array<vec2<u32>, 3>(FL_WILLOW, FL_WILLOW_L1, FL_WILLOW_L2)[select(select(2u, select(2u, 1u, !FLORA_SPRITES), hpx >= 55.0), 0u, hpx >= 150.0)];
  if (hpx >= 420.0) { r = FL_WILLOW_C; }
  floraPut(r, c, at, top, sz, 0.04, 9u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < 2u || id.y < 2u || id.x + 2u >= G.mapW || id.y + 2u >= G.mapH || heightfieldCol(id.xy)) { return; }
  if (G.misc.w > 0.5) { return; }
  let i = colIdx(id.x, id.y);
  // (round 128, the user: "willows ... (riverbanks, wet ground)") a willow on a bank: one candidate column a 9 × 10
  // block of world columns, on dry, moist ground with open water within ~6 cells
  willowAt(id.xy, i);
  let d = water[i];
  if (d > REED_WADE) { return; }
  let m = moisture[i];
  if (m < 0.35) { return; }
  // (round 119: off screen, before the bank's 5 × 5 look round)
  if (!floraSeen(cellPos(vec2<i32>(id.xy)), f32(sfZ(surface[i])), 3.5, 1.2)) { return; }
  // a bank: open water and dry land both within two cells
  // (and land enough: six dry columns of the 25 — a lone dry line through a river's held water isn't a bank)
  var near = 0.0;
  var dry = 0u;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let wd = waterAt(i32(id.x) + dx, i32(id.y) + dy);
      near = max(near, wd);
      dry += select(0u, 1u, wd <= 0.02);
    }
  }
  if (near < REED_WATER || dry < 6u) { return; }
  // on ground plants can live on (soil-like, not bare rock or ash): the material's ecology cap
  let s = surface[i];
  let gm = groundMatAt(vec2<i32>(id.xy), sfMat(s));
  if (MATS[gm].eco.x < 1.0) { return; }
  let chance = 0.25 + 0.5 * smoothstep(0.35, 0.9, m);
  if (rand3(id.x, id.y, 561u) >= chance) { return; }
  let top = groundCentreZ(vec2<i32>(id.xy), f32(sfZ(s)));
  // (not under the sea: its level past the window's edge, Globals.ocean.x)
  if (top < G.ocean.x - 0.1) { return; }
  let at = cellPos(vec2<i32>(id.xy)) + (vec2<f32>(rand3(id.x, id.y, 562u), rand3(id.x, id.y, 563u)) - 0.5) * 0.6;
  if (!floraSeen(at, top, 3.5, 1.2)) { return; }
  if (rand3(id.x, id.y, 564u) >= smoothstep(3.5, 6.0, PC.viewport.z * FLORA_RPX)) { return; }
  floraPut(FL_REED, id.xy, at, top, 0.85 + 0.3 * smoothstep(0.4, 1.0, m), 0.06, 7u);
}
