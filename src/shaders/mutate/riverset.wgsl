// ---- mutate/riverset.wgsl: the window's rivers settled to a cut, a thread a column (masks.wgsl before it, ------
// riverheld.wgsl after it; mutators round 5, BACKLOG MU-42) ------------------------------------------------------
// "A river running dry": a river's inflow lowered (a region's factor, a reach cut: weather/catchwet.ts) reaches the
// held rivers and the tiles through the riverWet field at once, but the water the window's columns HOLD came in at the
// reference and only eases to the table on a sleeping chunk's slow turn — so the dried river went on running blue.
// This writes the end state: a river column whose wetness is cut (the field under the climate's there) holds no more
// than the table's depth at that wetness. Only ever lowered (a rise is the liquid's to make); a flood's held or edge
// stage (the source word at or under -1) is left alone; written twice it finds the depth it left.
@group(0) @binding(4) var<storage, read_write> water: array<f32>;
@group(0) @binding(9) var<storage, read> waterSource: array<f32>;
@group(0) @binding(22) var riverFlowTex: texture_2d<f32>;

/** a wetness this far under the climate's is a cut (storm water only ever adds) */
const RIVER_CUT: f32 = 0.02;

@compute @workgroup_size(8, 8)
fn mutRiverSet(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = MP.box.x + id.x;
  let y = MP.box.y + id.y;
  if (x >= MP.box.z || y >= MP.box.w) { return; }
  let p = vec2<i32>(i32(x), i32(y));
  if (!inMap(p)) { return; }
  let q = vec2<u32>(x, y);
  let rh = riverHere(q);
  if (!rh.on) { return; }
  if (riverWetAt(vec2<f32>(q) + 0.5) > riverWet() - RIVER_CUT) { return; }
  let j = colIdxI(p);
  if (waterSource[j] <= -1.0) { return; }
  let before = water[j];
  if (before <= rh.depth) { return; }
  water[j] = rh.depth;
  bumpWater(q, before, rh.depth);
}
