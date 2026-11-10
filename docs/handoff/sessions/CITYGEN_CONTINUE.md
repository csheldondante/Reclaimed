# Handoff: finish the GPU city generator in the game

Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## Goal (the user's words)
- "Please merge and update the existing city generation to use this. Do add bridges though across the water that's
  needed … I would do that with the main roads coming into the city."
- "players just choose opportunities and we place and build for them. The only painting would be future work to make
  buildings customizable." "we still may want the irregular grids for vertical surfaces but you can retire the player
  painting and migrate to this system."
- "Yes make it gpu owned and driven by the population density map and make roads dirt or stone colored (but a bit
  lighter) and narrower."
- Streaming: "stream in the grid generation as needed so when we pan to a new population center it appears but we can
  ignore it where there is no population or low enough not to necessitate a grid." "We can serialize town changes like
  terrain changes if needed but the default is streaming and if that proves too slow we can generate starting towns and
  nearby towns in the background so that there is never a hitch."
- What it is: "a much faster GPU layout generator for the streets and a straightforward way to grow out districts
  visually in response to opportunities and a GPU resident set of streets that can be easily used for generating paths"
  — "grow a noisy field over the plots then animate the buildings coming in and have that go district by district."
- Scope: buildings stay plain extruded shapes here; the building generator, construction shader and physics are other
  sessions (see their handoffs). "We should wire paths and claim external columns with this work."

## State (branch `trackA-citygen`, worktree `C:\Projects\Reclaimed-trackA-citygen`, not merged)
Read `docs/design/CITYGEN.md` and DEVLOG entries from 2026-11-10. Done: M4a (Muru in the game behind
`?citygen=fields`, shared `src/citygen/` with the lab, arterials from atlas roads, bridges, height-to-plot rule,
deterministic layout), M4b (GPU population field, stone/dirt narrow roads, generation from atlas raw ground with the
normal window, sloped decks, a town bridge, GPU-owned static claims in a 4-slot arena, plants cleared on claims, GPU
reach with red outlines, streaming towns within 128 / dropped beyond 448 columns). ~5.3 ms GPU per town (desktop).

## Next (BACKLOG CG*)
1. **Decide with the user first:** CG15 bridges aren't walkable — the water model takes a column's top as the water
   floor, so a claimed deck lifts the river. Needs a gap-under-a-top in the water contract (DESIGN §7 owner). CG18
   free generator buffers after a run (~30 → ~10 MB a town; recommended). Start town pops in 8–9 s after load: pre-
   generate during loading (the user's "never a hitch").
2. **M4c (CG3): routes.** Show the user `trackA-legible`'s route graph and riders on their own first (unmerged work),
   then merge it and feed it citygen's road segments, arterials and decks plus a door segment per lot frontage; cached
   routes between destinations in a GPU buffer; riders as kinematic trips (DESIGN §11–§12).
3. **M4d (CG4): opportunities grow districts.** A chosen opportunity → the best supercell(s) by purpose (shore for
   harbour, hill for keep, roads for market) or a landmark site; lots appear in growth order with per-lot progress
   (the contract's progress buffer). The CPU uploads only the choice. Update the population field as the city grows.
4. **M4e (CG5): delete** the old CPU generator (`settle/plan.ts` draft path, `structures/plan.ts draftCity`, WFC facades,
   CPU lanes/roadgraph), player painting and the CPU claim registry for towns. Keep `structures/tiles/*` for vertical/
   cliff cities. "One system" — no two generators.
5. Smaller: CG14 shared arterial stretches, CG17/CG20 reach sampling and multi-town reach, CG19 phone bench of the pan.

## Phone link setup
`openssl` self-signed cert for the LAN IP, a git-excluded `vite.https.local.mts` that imports `vite.config.ts` and sets
`server.https` (and `preview.https` for a production preview). Example in the citygen worktree.
