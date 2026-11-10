# Cross-track contract — Track A (strategy, mutations, legibility) × Track B (art, assets, architecture)

Both tracks share one persistent world and one codebase. This file says who owns what, which files are shared, how a
change to a shared interface is made, and the first joint demonstration. Keep a short dependency log at the bottom.

## Ownership

| Concern | Track A owns | Track B owns |
|---|---|---|
| Strategic state, opportunities, threats, history, persistence | Logic, transitions, validation, save | Visual consumer only |
| Mutations, routes, reach, city layout and legibility | Semantics, scope, validation, placement and movement rules, camera-visible layout (streets, plazas, docks) | Geometric and visual realisation |
| Construction, damage, style | The strategic stage of a structure (planned → building → built → damaged → ruined → overgrown) and its gameplay effects | The building grammar, editable geometry, how each stage looks |
| Units and encounters | Behaviours, spells, strategic consequences | Meshes, animation, variants, rendering |
| Rendering and delivery | Required presentation scenarios and their phone budgets | Renderer, asset packing, benchmarks, caching, distribution, Phase 0 |

## Shared files and existing interfaces (verified)

- **Structure record** — `src/api/contracts/fortress.ts` `Structure` (on `onetown`): `id` (stable within a plan), `type`,
  `look` (palette bits), `floor`, `district`, `wear` (`'burned' | 'flooded'`), `sub` (plots + row angles: shape modifiers),
  `cells` (cell → level runs). The town plan `src/build/plan.ts` (TownPlan; `structure(id)`, `structureAt(cell)`,
  `structures()`) owns these records. **This is the semantic world/building state.** Track A writes it; Track B reads it.
- **Building view** — `src/build/view.ts` (and `edgeview.ts`, `curveroad.ts` on `onetown`) turns the plan into building
  records for `src/structures/*` (pieces, modules, styles). **This is the seam where Track B's grammar plugs in**: a new
  realisation replaces or extends the view → pieces step, keyed by structure id, cells and stage.
- **Claims into the terrain** — `src/build/claims.ts`, `src/sim/static-claims.ts`, External intervals (`src/sim/external.ts`;
  DESIGN §3). Geometry that changes what is solid must change claims through these, or routes and collision diverge.
- **Routes** — the route network is derived from the plan (`src/build/edgenet.ts`, `townroads.ts`, `src/agents/routes.ts`
  on `onetown`). Track B geometry never decides walkability; doors/edges come from the plan.
- **Cache invalidation** — per-chunk versions (`src/sim/chunkver.ts`; ARCHITECTURE "chunks' versions"): any writer of
  columns bumps them; the field mesh, agents' re-peel and others rebuild from them. New geometry that writes columns must
  use the existing bump path (`WorldCore.columnsWritten`).
- **Renderer** — `src/render/renderer.ts`, `src/render/renderer/*`, `src/shaders/render/*`, `src/render/meshinst.ts`:
  Track B owns; Track A requests presentation scenarios (e.g. a time-lapse, a festival crowd) through the owner.
- **Agents** — `src/agents/*`, `src/shaders/units.wgsl`, `src/town/*`: Track A owns; Track B supplies unit/creature
  visuals through `src/units/figures.ts` and `src/inhabitants/*`.

## Gaps to settle first (flagged, not decided)

- **Stage field.** `Structure` has `wear` (history marks) but no construction/damage stage enum. Proposal for the two
  orchestrators to agree (Track A authors the field, Track B the visuals): `stage: 'planned' | 'building' | 'built' |
  'damaged' | 'ruined'` plus `progress` (0..1) and `overgrowth` (0..1). Check the fortress's existing build progress
  (BuildBook, built blocks) before adding a parallel one.
- **Deterministic parameters.** Visual variety must come from `id` + `look` + a seed so a structure looks the same after
  reload and on regenerate.
- **Spatial anchors.** Doors/gates/stairs come from the plan's paths; Track B's grammar may add decorative anchors but
  not walkable ones.
- **Route updates.** Any change to a structure's footprint or stage that alters walkability goes through Track A's
  `relayRoads` (incremental), never directly.

## Rules for shared files

1. The owner edits first; the other track asks via the dependency log (below) with the reason and the smallest interface
   change.
2. Every shared-interface change lands with a **minimal interface test** both tracks run (e.g. "a plan with one structure
   at each stage produces building records with that stage"; "a geometry change that blocks an edge produces a route
   update").
3. Separate worktrees and branches per track (own `npm ci` — no `node_modules` junctions). Integration branch:
   `fortress`. Merge only green: both test tiers, transfer/boundary/writing gates, relevant lab gates.
4. Neither track invents a new state schema when `Structure`/TownPlan or the contracts in `src/api/contracts/` already
   cover it.
5. GPU timing runs take the timing lease; coordinate long benches.

## Communication

- A dependency log in this file (append-only, newest last): date, track, what's needed, from whom, status.
- Blocking questions go to the user, not to the other orchestrator's agents.

## First joint demonstration (proposal)

One structure in the start town goes through **planned → building → built → damaged → ruined → overgrown** driven by
Track A's turn loop (an opportunity that builds it, a crisis that damages it), with Track B's stage visuals, routes updating
as it changes, and the persistent world keeping its ruin into the next run. Acceptance: phone link, play-zoom shots per
stage, gates green.

## Dependency log

| Date | Track | Need | From | Status |
|---|---|---|---|---|
| 2026-11-09 | both | Agree the `stage` field above | A ↔ B | open |
| 2026-11-09 | B → A | GPU unit AI (docs/handoff/GPU_UNIT_AI_PLAN.md): the user asked for it planned and the WIP (`phonefix-observe-wip`) merged if applicable. Proposed: Track B owns the unit-mind lane (agent-units.ts, notice/reads, the sync, decision kernels, units contract); Track A keeps routes, plan, TownLife/crowd orders, DA-L4. Need from Track A: when the onetown/slice0 line lands in fortress (no unit-AI code before that — 5 files overlap) | Track A, user (ownership) | ownership: Track B (the user, 2026-11-10, relayed by Track A); formats sent to Track A (GPU_UNIT_AI_PLAN.md); landed: U1 in fortress 566b9189; U2 in progress on trackB-u2 |
| 2026-11-10 | A → B | Soldier calls for the Units contract (SEASON_LOOP.md, trackA-seasonlife 9347bf7a): `spawnGroup`, `orderGroup` drill / man (V3 posts, `posts.length` = group size, spares at the nearest gate) / march (a route id, not points; `leave`; back = a second order), per-group `arrived(g)` / `left(g)`. Soldiers are unit rows, not riders; ships and wagons are riders | B (U2), A (a walkable wall-walk reached by stairs or a gate tower; stable route ids gate → map edge; strategic-clock moves) | agreed both sides; B adds the calls after U2's hunt-field risk test |
| 2026-11-10 | A → B | "Graph settled/dirty" events on the unit event ring (the ring made a WorldGpu contract buffer, codes above 32) | B, the user | **rejected** (the user, 2026-11-10: "Your main goal is to remove the need for the CPU to read, why does it need this?"): the graph writes its own indirect dispatch args (0 when settled); phone toggle diff decides whether empty indirect dispatches need collapsing |
| 2026-11-10 | B → A | Manning walls = a formation along the wall-walk (the user): each wall-walk segment as a route id in the routeread pool; a free width per route point for formations that narrow with the path (the user) | A | asked |
