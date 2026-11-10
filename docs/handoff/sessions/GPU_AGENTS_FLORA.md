# Handoff: agents and plants fully on the GPU (as designed)

Read `README.md` (rules) and `ADDENDUM.md` in this folder first.

## The user (2026-11-10)
"Aren't agents and plants GPU only and if not can we get a handoff for that? That was the design."
Earlier, on Track B's plan: "The whole point of flow fields was to make the AI entirely GPU and let units path and target
based on their state."

## The design (DESIGN §11, §12, §14, §15; §24 no per-frame readback)
- Units are GPU rows; one crowd (agents and inhabitants merged; species, body plan, behaviour per unit).
- Behaviour is a state on the unit's row; transitions from GPU signals; goals are shared fields or cached routes seeded
  on the GPU; units change the world only through world operations (terrain take/put, felling, fire).
- CPU → GPU: orders only, when they change. GPU → CPU: events + watched units (≤ 32), a few words, async.
- Flora is a field plus hashes; one placement read by everyone; "no second copy of where plants are"; animation GPU only.

## What the code does today (checked 2026-11-10 on trackA-citygen = fortress + citygen)
- `src/agents/agents.ts`: movement, fields, notice, swings, road rides and the event ring are GPU. But `sync()` reads
  every unit (96 B) plus events back, effectively every frame (~1126, ~1427); `src/units/agent-units.ts think()` decides
  on the CPU (goals, patrols, flee, hunt targets, damage application, defender strikes); the scope box is read back.
- `src/agents/crew.ts`, `buildcrew.ts`: work crews (dig, fell, carry) with the brain on the CPU, a state per worker.
- `src/inhabitants/system.ts`: a second crowd with its own readback (~406, ~437) — the design says one crowd.
- Flora: placement is GPU (`vegplan.wgsl vegPlan`) but mirrored on the CPU (`flora/placement.ts standsAt`,
  `api/plants.ts planTree`) for passability and queries — a second copy of where plants are. Felling goes through the
  CPU `Plants` API.

## Existing plan to build on
Track B wrote it: `git show origin/trackB:docs/handoff/GPU_UNIT_AI_PLAN.md` (proposed 2026-11-09; slices U0 design note,
U1… with gates and phone bench; it waits on the user's ownership call). It covers units/combat; extend the same state and
order formats to work crews (haul: to source → work → carry → deposit), and add flora:
- Passability and queries read the GPU placement (a pass, few words back after an event), and the CPU mirror goes.
- Felling, stumps, burning, harvest change the field on the GPU; a felled tree becomes a body only when it matters (§15).

## In flight that touches this
`trackA-haul` (worktree `C:\Projects\Reclaimed-trackA-haul`) is building town hauling, a deep quarry and forest
clearing with stumps on the citygen route graph, told to keep brains on the GPU and stay compatible with the plan
above. Check ADDENDUM.md for its outcome before starting, and coordinate with Track B on ownership (the user decides).
