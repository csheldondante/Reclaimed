# Handoff: procedural building and architecture style generator

Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## Goal (the user, 2026-11-10)
"I want a separate session to work on our procedural building and architecture style generator. It's an independent
body of work." The city generator gives plain extruded lots; this session turns lot records into buildings with style.

## Inputs (the contract — read it, don't read citygen internals)
`src/api/contracts/citygen.ts` and `docs/design/CITYGEN.md` on branch `trackA-citygen`: one 24-word GPU record per lot
and landmark site (parcel, footprint polygon, frontage edge, kind: building / park / plaza / landmark, district and
purpose id, storeys, height, base z, growth key, a stable seed), a count buffer, a per-lot progress buffer (0–1), and the
town's placement transform. Claims are per lot record, so this session can take over a building's intervals.

## Requirements and ideas already agreed with the user
- **Height vs plot size** was the user's main readability point: wide plots get low, broad buildings; only towers go
  tall; streets must stay visible at 60° pitch. Huge structures spaced so they don't occlude each other or the streets.
- **Superstructures for large or irregular plots** (BACKLOG ST12): a perimeter block with a courtyard following any
  outline, corner towers at sharp turns; round landmark sites get a ring building + central tower; district styles
  (warehouse, university, keep) as variants.
- **Districts read visually:** port with docks, quays, anchored ships and a warehouse district; city centre with the
  growing fortress megastructure; a university on a hill; walls. Purpose id per lot is the hook.
- **Trees and doodads in the gaps** (BACKLOG ST11) — can be this session or a small separate one: a GPU scatter off roads
  and lots with JFA clearance; reuse instanced trees (`render/meshinst.ts`) and prop modules
  (`structures/dressmodules.ts`): orchards/gardens in empty districts, a well and stalls on plazas, quays/cranes/boats
  on the shore, sparse trees along arterials; follows the growth slider.
- Existing art to check before inventing: `structures/pieces.ts`, `modules.ts`, `dressmodules.ts`, the old WFC facades
  (`structures/wfc.ts`, sequential CPU — not to be reused as-is). Track B owns art direction/assets — coordinate.
- Everything generated on the GPU, per lot in parallel (hash + neighbour types), no sequential CPU picking.
- Future city kinds to keep in mind: cliff/mesa faces with irregular 3D grids (`structures/tiles/*` kept for this),
  Bulwark-style radial spires with bridges, waterfall, lake, treehouse, termite-mound cities.
- Physics of buildings is a separate handoff (`BUILDING_PHYSICS.md`) but "may make sense to do as part of the improved
  building generators" — design the output so it can feed the physics lattice.
