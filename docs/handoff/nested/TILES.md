# Thread: tiles (pregenerated and runtime), also in the simulation — DESIGN TALK ONLY

Nothing here is built. It is a design conversation of 2026-11-20 that the cliff-columns work grew out of. A
new session should treat it as a proposal to review with the owner before any builder.

## The owner's ideas (their words)
- "having pregenerated instanced tiles or fields we can use according to courser heightmaps or fields. That
  way we could selectively increase the field and render resolution only where needed along sharp rims or tall
  curved vertical drops."
- Tiles stay in the simulation: "we have external columns as a type and the stamp could still indicate slope
  and average height for loose columns over it to use. I think that we might need to let the renderer read the
  true height of the stamp geometry and then add the material film over that or else let a tile precompute
  flow past solids in each direction which could allow very realistic looking flows like sand falling between
  rocks and then coming out the sides at the base of the tile."
- "Can't we treat user edited columns as runtime generated tiles? Then we can do the same bakes and tricks for
  them to show them from further away. Slower changes in elevation don't use the tiles at all. Steeper changes
  we can generate a tiling set of tiles so that visually there is variety or we can layer on some small
  perturbations with noise to hide the repetition or both."
- Bakes need not keep the full fine mesh: "traditional LOD bakes so far away use fewer triangles".

## The orchestrator's proposal (its additions are marked)
A tile = one block of fine columns with a summary and a mesh, whatever its source.
- Shared tiles: pregenerated; a coarse column stores an id and a turn.
- Private tiles: the block of fine columns a brush touched; the mesh the field mesh already builds for the
  block, kept instead of thrown away, so a carve keeps its shape at any distance.
- Summary for the level above (orchestrator's additions): mean height, slope, void fraction, a fill curve
  (stored volume -> surface height) and a flow rate per face. Shared tiles can measure face rates by running
  the fine simulation offline; private tiles would estimate them from open area per face.
- Variety on steep ground: a tiling set picked by which of a column's four corners are high (16 cases with
  variants, edges matching within the set), plus integer-hash noise added at stamp time so mesh and columns
  agree and every device gets the same result.

## Problems named
- Turning a tile: four turns and a mirror keep stamped columns exact; free rotation mismatches mesh and columns.
- Tile edges must overlap or sink to look closed; neighbours' face flow rates must agree.
- One flow rate per face is a rough model (a half-full tile passes material differently).
- Memory for private meshes needs a budget and a coarser version for distance.
- Bakes after every brush dab must be spread over frames.
- None of it can be judged without a simulation to pour something.

## Questions left with the owner (unanswered)
1. Exact turns only, or free rotation?
2. One coarse column per tile, or tiles spanning several columns for big cliffs?
3. Order: simulation slice first, then one rock tile with sand poured over it?

## How it relates to what was built
The cliff-columns rule (CLIFF_COLUMNS.md) is a procedural stand-in for shared cliff tiles: detail from a hash
plus parent data, no stored tiles. The "private tile" proof (carve at 2 m, fly away until that level closes,
the carve keeps its fine mesh) was proposed and never run. External intervals exist in the main game
(`sim/external.ts` there); the lab's columns already allow several intervals per column.
