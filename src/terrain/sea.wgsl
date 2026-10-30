// Terrain track (round 117): where the sea's water stands — not wherever the ground is under the sea's level. Prepended
// to every atlas kernel by Atlas.parts().
//
// The user (DECISIONS round 112 / 117): "We should not have a sea level just a flood height into a basin" / "Yes
// replace global with flood fill regions as described." A first step (BACKLOG TR7, TR23): the sea fills only what
// joins it — the sea's own regions and the land within SEA_REACH of the coast (a beach's fringe, a river's mouth) — not a
// crater's bowl on a plateau that happens to dip under the sea's level (at 11028,5948 such a bowl was dry in the window
// and drawn as sea in the rings past it: a green floor walled by black slabs). Such a basin is dry until something
// floods it (terrain/flood.ts: water, sand, magma to its spill height). The sea's level itself is still AP.sea (TR7).

/** world units inland from the coast the sea still reaches (the coast's SDF: Ground.coast, + into the land) */
const SEA_REACH: f32 = 24.0;

fn seaOpen(a: u32, coast: f32) -> bool {
  return !isLand(regs[a]) || coast < SEA_REACH;
}
