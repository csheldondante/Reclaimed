// ---- mutate/flood.wgsl: a flood written into a box of the window, a thread a column (masks.wgsl before it) -------
// Its own kernel (land.wgsl's is at the eight storage buffers a stage may bind): water raised to the level over each
// column's top, never lowered, and the water it adds is the river's — clean. The water's look takes the column's
// dissolved contamination (render/water.wgsl: contam.y over the depth); what a dry column kept there turned the first
// floods into an opaque olive-brown sheet over the town, so it is cleared where water is added.
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> contam: array<vec2<f32>>;
@group(0) @binding(7) var<storage, read_write> contamNext: array<vec2<f32>>;
/** the liquid's source word a column (liquid.wgsl FLOOD_STAGE_BIAS, FLOOD_EDGE_BIAS; BACKLOG MU-28, MU-36):
 *  inside the rim a HELD stage, -(1024 + the level in window z): the liquid holds the column's water up to it instead
 *  of draining it. In the rim an EDGE stage, -(4096 + the level): the liquid keeps the column's water AT it, up or
 *  down — the higher of the flood's falling level and what stood there (the river, the lake, dry ground). What the
 *  held core sheds runs down the rim and is taken up there, so nothing is poured into the water beyond the rim: that
 *  made a raised straight-edged sheet over the river in round 3 (the chunks awake rose, the sleeping ones did not) */
@group(0) @binding(8) var<storage, read_write> waterSource: array<f32>;

const FLOOD_STAGE_BIAS_M: f32 = 1024.0;
const FLOOD_EDGE_BIAS_M: f32 = 4096.0;

@compute @workgroup_size(8, 8)
fn mutFlood(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = MP.box.x + id.x;
  let y = MP.box.y + id.y;
  if (x >= MP.box.z || y >= MP.box.w) { return; }
  let p = vec2<i32>(i32(x), i32(y));
  if (!inMap(p)) { return; }
  let d = mutD(cellPos(p));
  // (short of the rim by a hair: a column on the circle itself is outside it)
  if (d >= 0.98) { return; }
  let cs = colSlots(x, y);
  var tv = IV_NONE;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    tv = v;
  }
  if (ivEmpty(tv)) { return; }
  let top = ivZ1(tv);
  if (ivMat(tv) == MAT_EXTERNAL && top - ivZ0(tv) >= BUILDING_T) { return; }
  let j = colIdxI(p);
  let lvl = floodLevel(d);
  let want = lvl - top;
  let before = water[j];
  // (a river's or a spring's own inflow there stays the river's: the table holds those)
  if (waterSource[j] <= 0.0) {
    if (d < FLOOD_RIM) {
      if (want > 0.05) { waterSource[j] = -(FLOOD_STAGE_BIAS_M + lvl); }
    } else if (top < MP.p.x) {
      // (the edge: at the higher of the falling level and what is there now. Idempotent: written again it finds the
      // water it left, and the higher of the two is the same)
      waterSource[j] = -(FLOOD_EDGE_BIAS_M + max(lvl, top + select(0.0, before, before > 0.05)));
    }
  }
  if (want > 0.05 && want > before) {
    water[j] = want;
    // (what was dissolved in the water that stood here is thinned by what came; a dry column's is gone)
    let keep = before / want;
    contam[j].y = contam[j].y * keep;
    contamNext[j].y = contamNext[j].y * keep;
    bumpWater(vec2<u32>(x, y), before, want);
  }
}
