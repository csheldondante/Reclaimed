# Handoff: the construction time-lapse shader

Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## Goal (the user, 2026-11-10)
"the building construction animation shader work" is an independent body of work — "but use the design". Districts grow
in response to opportunities: "grow a noisy field over the plots then animate the buildings coming in and have that go
district by district." Construction stages are meant to be "as visually rewarding as combat actions" (DECISIONS 128r).

## The design (the user's reference: FONDACO dev, r/Unity3D "you don't need to model construction stages")
One 0–1 progress value per building drives a construction material on the real mesh; no modelled stages.
- Walls clipped at a ragged per-cell hashed height, in courses, with a mortar tint at the fresh edge.
- Floors pop in whole. Roof: a world-space rafter grid first, then tiles.
- The same clip in the shadow and depth passes (`gbuffer-shadow.ts` here). Cull off with dark back faces (hollow shell).
- Stage bands: 0–10 stakes/ropes/dirt, 10–25 foundations, 25–70 walls with a rising scaffold, 70–80 rafters, 80–92
  tiles, 92–100 scaffold down. Ground levelled and vegetation cleared under the site.
- Gotchas from the post: estimating the eave height, shadow proxies, levelling a copy of the terrain.

## Inputs
`src/api/contracts/citygen.ts` (branch `trackA-citygen`): the per-lot progress buffer (0–1) and lot records (footprint,
height, storeys, growth key, seed). Progress = clamp((district clock − growth key + noise) / build time); a district's
clock starts when an opportunity is chosen; running clocks fast is the time-lapse. Today the extrusion only scales its
height by progress, and a progress change shows after the next mesh run — the shader should read progress per frame.

## Notes
- GPU only: progress values are the only thing animated; no per-building CPU work.
- Must work on the plain extrusions now and on the building generator's meshes later (coordinate the vertex inputs it
  needs: local height within the building, floor index, roof flag).
- Judge at play zoom on the phone.
