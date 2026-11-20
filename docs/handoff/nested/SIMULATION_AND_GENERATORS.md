# Thread: simulation and generators — NOT STARTED (the owner's top interest)

## Why this matters
The owner, 2026-11-19: "I don't want to waste too much time on the rendering honestly. I'm much more
interested in editing and simulation and performance." By 2026-11-20 the lab had ten rendering rounds and no
simulation. The orchestrator recommended a first simulation slice more than once; the owner chose to chase the
cliff look first ("orchestrate and derisk early and see if we can get this look"). Whoever takes over should
raise the simulation again as soon as the cliff look is either proven or dropped.

## Rulings so far
- Fluids are materials: "I think treating fluids like any other material makes sense and it means wind can
  work like other flows too".
- Coarse edits win: "it's fine if course edits obliterate fine authored detail on the same cells."
- Generators: "we need a separate pass to tune generators but a good rule is to cap their residual so that it
  can't introduce cliffs to the parent view. It could still introduce finer cliffs and fading those in is a
  separate lod concern".
- Standing: never design assuming one root grid or solids only; nothing built per frame; everything on the GPU;
  no new per-frame CPU readbacks.

## Proposed first slice (orchestrator's, not yet agreed in detail)
Loose soil slumping to an angle of repose, and water as a material, at ONE level, on integer heights
(see INTEGER_HEIGHTS_AND_MEANS.md); then flow between levels. Steady state should cost nothing (sleep).

## Open questions for the owner
1. Should a coarse edit silence the generator's fine detail on the cells it touches, so flattened ground stays
   flat? Today the generator adds its detail back (up to 25 m at the 16 m level, 10 m at 2 m). The orchestrator
   recommends yes; the owner answered with the cap rule above, which bounds the size but does not settle
   whether edited cells are exempt.
2. Integer heights before the slice: yes?

## Generator facts found along the way
- The atlas generator (`src/nested/gpu/gen.wgsl` calling `ground(p)`) makes cones with long steep slopes and
  almost no cliffs or plateaus. Under the cliff rule that turns whole mountainsides into stepped columns at
  T=2 and leaves almost nothing at T=8. A clean plateau-and-cliff world has to come from the generator pass.
- The current generated detail breaks the owner's cap rule: it can make a parent's cells steep.
- Under the cliff-columns plan, on steep cells the rule replaces the generator's fine detail (step C there).
- Overhangs from coarse notches would be real air in the columns: water and sand would flow into them, and
  nothing in the lab checks that unsupported rock holds (the main game has a rule for that).

## Other parked simulation-facing items
- NS-227 pillars (derive's limited PPM flattens extrema), NS-216 checkerboard materials (per-column material
  decision). Both affect what a simulation would see at finer levels.
