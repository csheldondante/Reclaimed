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
/** reeds stand in water up to this deep */
const REED_WADE: f32 = 0.7;

fn waterAt(x: i32, y: i32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(G.mapW) || y >= i32(G.mapH)) { return 0.0; }
  return water[colIdx(u32(x), u32(y))];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < 2u || id.y < 2u || id.x + 2u >= G.mapW || id.y + 2u >= G.mapH || heightfieldCol(id.xy)) { return; }
  if (G.misc.w > 0.5) { return; }
  let i = colIdx(id.x, id.y);
  let d = water[i];
  if (d > REED_WADE) { return; }
  let m = moisture[i];
  if (m < 0.35) { return; }
  // open water within two cells (the bank), the nearest's depth
  var near = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      near = max(near, waterAt(i32(id.x) + dx, i32(id.y) + dy));
    }
  }
  if (near < REED_WATER) { return; }
  // on ground plants can live on (soil-like, not bare rock or ash): the material's ecology cap
  let s = surface[i];
  let gm = groundMatAt(vec2<i32>(id.xy), sfMat(s));
  if (MATS[gm].eco.x < 1.0) { return; }
  let chance = 0.25 + 0.5 * smoothstep(0.35, 0.9, m);
  if (rand3(id.x, id.y, 561u) >= chance) { return; }
  let top = groundCentreZ(vec2<i32>(id.xy), f32(sfZ(s)));
  let at = cellPos(vec2<i32>(id.xy)) + (vec2<f32>(rand3(id.x, id.y, 562u), rand3(id.x, id.y, 563u)) - 0.5) * 0.6;
  if (!floraSeen(at, top, 3.5, 1.2)) { return; }
  if (rand3(id.x, id.y, 564u) >= smoothstep(4.0, 7.0, PC.viewport.z)) { return; }
  floraPut(FL_REED, id.xy, at, top, 0.85 + 0.3 * smoothstep(0.4, 1.0, m), 0.06, 7u);
}
