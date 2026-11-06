// ---- waterclass.wgsl ----------------------------------------------------------------------------------------------
// (round 128o, DA-B26) The walkers' water classes: a column's top surface is wet past WADE (dry again under WADE_OFF)
// and deep past DEEP (wadeable again under DEEP_OFF), the bands' hysteresis kept by its reader (agents.wgsl navCost).
// Shared by the reader and the water's writers (chunkver.wgsl bumpWater): a class can change only when the water
// crosses one of these four, so a writer moves a chunk's class version exactly when it does. Mirrored on the CPU by
// agents/rules.ts DEEP.

/** (round 107) the water under which a wet surface counts dry again (it turns wet past WADE): a shore's ripple round
 *  WADE doesn't flip it */
const WADE_OFF: f32 = 0.45;
const WADE: f32 = 0.6;
/** (round 128d, FT-20) water this deep is no way for a walker: the shortest unit (a worker, 1.0 tall) drowns in water
 *  over its height (units.wgsl), so a field never leads a walker into it — a ford (shallower) or a bridge, or nothing.
 *  A unit already in it still finds its way out (a deep surface reads its neighbours; a dry one doesn't read a deep). */
const DEEP: f32 = 0.9;
/** the water under which a deep surface counts wadeable again (hysteresis, as WADE_OFF) */
const DEEP_OFF: f32 = 0.8;

/** the water went from `a` to `b` across a class's edge (any of the four) */
fn waterClassCrossed(a: f32, b: f32) -> bool {
  return (a > WADE_OFF) != (b > WADE_OFF) || (a > WADE) != (b > WADE) || (a > DEEP_OFF) != (b > DEEP_OFF) || (a > DEEP) != (b > DEEP);
}
