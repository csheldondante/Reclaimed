# Handoff: generated buildings as physical structures

Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## Goal (the user, 2026-11-10)
"Physics integration is a must but can be a separate step as well. It may make sense to do as part of the improved
building generators." (BACKLOG CG11.)

## What exists to build on
- DESIGN §3 (grids and External intervals), §9 (structural integrity and collapse), §10 (physics engine), and BACKLOG
  DA-E3 (GPU destruction trigger), DA-E4 (raid/spell damage through it), DA-E5 (one solver for freed pieces), DA-E8
  (budgeted deformation; town buildings on the physics lattice like spawned buildings).
- Citygen claims (branch `trackA-citygen`, `docs/design/CITYGEN.md` M4b, `src/sim/static-claims.ts`): GPU-owned
  External intervals per lot record in a 4-slot arena; after an edit a GPU check returns only damaged lot ids
  (currently only logged — nothing reacts). Claims were designed so a physics or building-generator step can take
  ownership of one building's intervals cleanly.
- The user's physics intent (memory/DECISIONS round 106): one GPU constraint solver, soft contacts, erode not push,
  objects stay objects; show results in the physics playground/rock lab before pushing.

## Plan to propose to the user
Decide the building representation with the building-generator session (mass, material, support per piece), then:
damage report → the GPU destruction trigger → freed pieces as bodies in the one solver → rubble back into the
columns. Everything on the GPU; reads are a few words after events.
