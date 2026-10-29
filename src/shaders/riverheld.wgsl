// ---- riverheld.wgsl (round 84, ?rivers=table) ---------------------------------
// The atlas's rivers at their steady state (sim/world-gpu.ts riverFlow): where nothing has woken a river, it isn't
// simulated — its depth is the atlas's table at the rivers' wetness, its flux the pipes' steady flux for that, and
// it's drawn flowing by the table's flow. The including shader declares
//   @group(0) @binding(22) var riverFlowTex: texture_2d<f32>;
// and is prefixed with RIVER_TABLE, RIVER_DEPTH_EXP, RIVER_SPEED_EXP, RIVER_WET_CELLS (sim/systems.ts riverHeld). A
// shader that calls riverWetAt binds the riverWet field (sim/world-gpu.ts riverWet) at RIVER_WET_BINDING (62).

/** (round 109, watershed) the rivers' storm water at the window's coarse texels (sim/world-gpu.ts riverWet) */
@group(0) @binding(62) var riverWetTex: texture_2d<f32>;

/** a held river's column shallower than this is a dry bed */
const RIVER_DRY: f32 = 0.03;

struct RiverHere {
  on: bool,
  /** the column's depth at the rivers' wetness */
  depth: f32,
  /** the flow there (cells a 60 Hz step, downstream) */
  vel: vec2<f32>,
}

/** the climate's wetness, the same for every river: the season (Globals ocean.w; 0 unset: 1) */
fn riverWet() -> f32 { return select(max(G.ocean.w, 0.05), 1.0, G.ocean.w <= 0.0); }
/** (round 109 — the user: "I want it per water shed please") A river's wetness at a place (window cells; its discharge
 *  over the reference's): the climate's plus the storm water its own watershed's rain sends down it (the riverWet
 *  field, bilinear; 0 past the window). Every reader with a position asks this. */
fn riverWetAt(cellXY: vec2<f32>) -> f32 {
  let d = vec2<i32>(textureDimensions(riverWetTex));
  let t = (cellXY - 0.5) / RIVER_WET_CELLS;
  let i = vec2<i32>(floor(t));
  let f = t - floor(t);
  var e = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2<i32>(k & 1, k >> 1);
    let c = i + o;
    if (any(c < vec2<i32>(0)) || any(c >= d)) { continue; }
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    e += w * textureLoad(riverWetTex, c, 0).x;
  }
  return riverWet() + e;
}

fn riverHere(q: vec2<u32>) -> RiverHere {
  var r: RiverHere;
  r.on = false;
  if (!RIVER_TABLE) { return r; }
  let t = textureLoad(riverFlowTex, texCol(vec2<i32>(vec2<i32>(q))), 0);
  if (t.z <= 0.0) { return r; }
  let wet = riverWetAt(vec2<f32>(q) + 0.5);
  r.on = true;
  // (its level up or down with the discharge; no higher than the banks' tops, 0.3 over the reference's)
  // (the user: "keep the flow proportional and then zero out when they get too low": the frozen pattern scaled by
  // the discharge — at the line the depth × wet^RIVER_DEPTH_EXP, the level shifted with it across the channel — and
  // a dry bed under RIVER_DRY)
  r.depth = t.z + min(t.w * (pow(wet, RIVER_DEPTH_EXP) - 1.0), 0.28);
  if (r.depth < RIVER_DRY) { r.depth = 0.0; }
  r.vel = t.xy * pow(wet, RIVER_SPEED_EXP);
  return r;
}

/** Is column q a river's held at its steady state: asleep, or at the window's edge (where it comes in from past the
 *  window and goes on out of it — the world beyond is the atlas's, unsimulated)? */
fn riverHeld(q: vec2<u32>, r: RiverHere) -> bool {
  if (!r.on) { return false; }
  let edge = q.x == 0u || q.y == 0u || q.x + 1u >= G.mapW || q.y + 1u >= G.mapH;
  return edge || asleep(q);
}
