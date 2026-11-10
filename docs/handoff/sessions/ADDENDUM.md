# Addendum — read before starting any handoff in this folder

Changes and decisions made after the handoffs were written (2026-11-10). Newest first. Empty means nothing yet.

- **2026-11-10 — priorities.** Order: saving the season loop and town (Track A, in flight) → the building generator
  (`BUILDING_GENERATOR.md`, a new orchestrator session, next) in parallel with liquids (`trackA-liquids`, in flight)
  and soldiers (after Track B's U2 moves unit decisions to the GPU). On presenters for cards (an advisor, a wizard, a
  scout): "I do like the zoom in for cards to make it more diagetic but it slows play" — keep presentation quick and
  skippable; design later. Citygen, the living town and the season loop are on `fortress` (6290acba).

- **2026-11-10 — ownership and merges.** Track B (art_improvements session) owns the one GPU crowd, combat, flee
  priority, the inhabitants merge and removing the CPU flora mirror (its `GPU_UNIT_AI_PLAN.md`, `UNIT_MINDS.md`, battle
  playground U8 `?level=battle` with the user's spell list); Track A's `trackA-haul` owns the haul job states (format in
  `docs/design/LIVING_TOWN.md`). trackA-citygen + trackA-haul + trackA-opps are being merged into fortress — check
  `git log origin/fortress` before starting. The user: agents may later arrive from / leave to districts (a note, not
  yet designed).

- **2026-11-10 — citygen phone bench, Pixel 9a (bb7dd64b, q=low).** Stage times are cumulative in the report. A town
  costs 10.5–15.7 ms GPU (p50), a city 17.8 ms; per stage at Muru: field 2.3, phi 0.4, trace 4.4, lots 1.5, mesh 2.4.
  Raw ground 840–950 ms wall per town (1.6 s for a city), paced over frames. Generating a town every frame (20 a
  second): frame p50 unchanged at 16.7 ms, mean +0.84 ms, 4 of 456 frames over 33 ms. Streamed pan to Hedom: one 467 ms
  spike at 1.5 s, before any town was made (land streaming, not citygen); the towns made at 6.3 s and 18.2 s added no
  spike. Follow-up: split a town's run over 2–3 frames (trace is the largest stage) so one generation never exceeds a
  frame's budget; trim the trace stage.

