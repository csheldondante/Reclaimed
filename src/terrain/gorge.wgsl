// Terrain track (round 117): gorges cut into the plateaus' tops (compose.wgsl ground()). Prepended to every atlas kernel
// by Atlas.parts().
//
// The user (DECISIONS round 117): "I would love more variety in terrain. Traversvlable gorges (both at the bottom and
// above)." Earlier (round 111): "larger mesas … where the ravines between them are traversable … good set up for flash
// floods", and the cliffs' recipe the user praised: "the way cliffs use voronoi plus noise plus sdf to make steps and
// spires".
//
// How: the zero lines of a slow noise (|n| under a threshold) wind across a plateau's top — a network of gorges.
// Across one, the distance from its line (|n| / threshold) is an SDF: a flat floor in the middle (walkable: a corridor
// for the bottom), then the walls in tiers (stairs of the SDF) whose edges each Voronoi cell offsets — blocks and
// ledges, as the mesas' shelves; the rims stay at the plateau's height (walkable above, the gorge a barrier to cross
// there, or the bridge a run asks for). The depth varies along it (deeper where a second noise says) and shallows to
// nothing at its heads (where the network's mask fades), so a gorge starts as a crease and deepens to a canyon; where
// one meets the plateau's edge its floor is open to the low ground below. Talus piles at its walls' feet.

/** the network's period (world units) and a gorge's half-width at the rim in the noise's units */
const GORGE_PER: f32 = 420.0;
const GORGE_W: f32 = 0.085;

struct Gorge {
  /** the ground cut down to this (1e9: no gorge) */
  cut: f32,
  /** loose ground at its walls' feet */
  talus: f32,
}

/** the gorge at p on a plateau whose top here is `top` (the low ground beyond its edge ~`low`); dl: the distance into it */
fn gorgeAt(u: vec2<f32>, top: f32, low: f32, dl: f32) -> Gorge {
  var o = Gorge(1e9, 0.0);
  let mask = smoothstep(-0.1, 0.15, pfbm(u, perOf(900.0), 2u, AP.seed + 902u));
  if (mask <= 0.0) { return o; }
  let n = pfbm(u, perOf(GORGE_PER), 3u, AP.seed + 901u);
  let wN = GORGE_W * (0.7 + 0.6 * mask);
  var x = abs(n) / wN;
  if (x >= 1.0) { return o; }
  // the walls' blocks: each Voronoi cell ~9 across moves its share of the SDF a little (ledges, jutting blocks)
  let pj = perOf(9.0);
  let wj = pworley(u * f32(pj), vec2<i32>(pj), 0.9, AP.seed + 903u);
  let hj = hf(pcg(wj.id ^ (AP.seed * 0x3c6ef372u)));
  x = clamp(x + (hj - 0.5) * 0.14, 0.0, 1.0);
  let full = 14.0 + 30.0 * (0.5 + 0.5 * pfbm(u, perOf(300.0), 2u, AP.seed + 904u));
  // (no deeper than the low ground beyond the plateau's edge: near the edge its floor meets it — a way in)
  let D = min(full * mask, max(top - low - 2.0, 0.0)) * (0.35 + 0.65 * smoothstep(0.0, 60.0, dl + 40.0));
  if (D < 3.0) { return o; }
  // the floor flat to half the width, then three tiers to the rim
  let t = smoothstep(0.5, 1.0, x);
  let k = t * 3.0;
  let st = (floor(k) + smoothstep(0.55, 0.95, k - floor(k))) / 3.0;
  o.cut = top - D * (1.0 - st) + 0.6 * pfbm(u, perOf(12.0), 2u, AP.seed + 905u);
  // talus where a tier's wall meets the floor or a ledge (the step's lower end)
  let foot = k - floor(k);
  if (foot < 0.3) { o.talus = (1.0 - foot / 0.3) * min(D * 0.08, 3.5); }
  return o;
}
