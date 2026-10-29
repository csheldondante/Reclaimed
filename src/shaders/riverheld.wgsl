// ---- riverheld.wgsl (round 84, ?rivers=table) ---------------------------------
// The atlas's rivers at their steady state (sim/world-gpu.ts riverFlow): where nothing has woken a river, it isn't
// simulated — its depth is the atlas's table at the rivers' wetness, its flux the pipes' steady flux for that, and
// it's drawn flowing by the table's flow. The including shader declares
//   @group(0) @binding(22) var riverFlowTex: texture_2d<f32>;
// and is prefixed with RIVER_TABLE, RIVER_DEPTH_EXP, RIVER_SPEED_EXP (sim/systems.ts riverHeld).

/** a held river's column shallower than this is a dry bed */
const RIVER_DRY: f32 = 0.03;

struct RiverHere {
  on: bool,
  /** the column's depth at the rivers' wetness */
  depth: f32,
  /** the flow there (cells a 60 Hz step, downstream) */
  vel: vec2<f32>,
}

/** the rivers' wetness: their discharge over the reference's (Globals ocean.w; 0 unset: 1) */
fn riverWet() -> f32 { return select(max(G.ocean.w, 0.05), 1.0, G.ocean.w <= 0.0); }
/** (round 108) the rivers' wetness at a place (window cells): what draws a river's level reads it through this (the
 *  tiles: tiles.wgsl fsTile) — the whole world's for now; per watershed later (branch `watershed`: only this body) */
fn riverWetAt(cellXY: vec2<f32>) -> f32 { return riverWet(); }

fn riverHere(q: vec2<u32>) -> RiverHere {
  var r: RiverHere;
  r.on = false;
  if (!RIVER_TABLE) { return r; }
  let t = textureLoad(riverFlowTex, texCol(vec2<i32>(vec2<i32>(q))), 0);
  if (t.z <= 0.0) { return r; }
  let wet = riverWet();
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
