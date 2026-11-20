# Thread: the field mesh (surface nets) and the sheet draw — BUILT, NOT DEFAULT, OPEN FAULTS

## Rulings
- "Literally I just want it to look good and be fast. … I'm happy to do surface nets (but please use the
  column data intelligently so we aren't walking every cube) as long as it is fast."
- "It only needs to be visually watertight because the field is represented by intervals."
- After phone screenshots of round 27: "For the terrain, I still see a lot of visual bugs at the rim of carves."

## What exists (rounds 26-29)
- `src/nested/fieldsel.ts` (sparse cell selection from interval boundaries, 0 missed against a brute walk),
  `src/nested/gpu/field.wgsl`, two-bank quad pages, `?field=<levels>` (e.g. `1,2,3`), a "Field mesh" HUD
  button, `?warp=`, `?fmargin=`, `?fbudget=`, `?fdbg=`. Closure check = no sky pixels below the horizon.
- All-field config has 0 hole pixels; field over a sheet parent leaks (NS-224).
- Field is 0.4-1.2 ms slower than sheets (2.3x the triangles plus a per-pixel material lookup), so the default
  stayed sheets (`?smooth=1`).
- Round 28 fixed a level thrash (the 2 m level opening and closing every 0.6 s when standing 230-310 m from the
  surface), the likely cause of 17-43 ms frames on the phone. The phone was never re-measured after the fix.

## Open
- Per-pixel material speckle and blockiness on rims and cliffs; straight walls and spires along 16 m cells;
  thin dark dashes (NS-212); steep chunk build 5-6 ms (NS-209); textured shading of the finest level is the
  biggest frame cost, 3.3-3.6 ms (NS-226); pillars (NS-227); checkerboards (NS-216).
- Decision never made: field mesh as the default for near levels.
- The cliff-columns look (`?cliff=5`) currently works only with the sheet draw and switches off under the
  field mesh. If the cliff look is adopted, steep cells stop being a field-mesh problem at all, and the field
  mesh's remaining job would be overhangs, tunnels and edited shapes on gentle ground. That re-scoping has not
  been discussed with the owner.
- Proposed and not done: park unused draw paths on a branch once one draw is chosen.

## Fortress reference
Fortress draws terrain with a GPU surface-nets field mesh on a hex lattice (`src/shaders/fieldmesh.wgsl`,
`meshregion.wgsl`, `meshdraw.wgsl`). The lab's field mesh is a port of the idea, not the code.
