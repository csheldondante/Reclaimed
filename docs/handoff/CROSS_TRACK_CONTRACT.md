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
| 2026-11-10 | B → A | Place orders built (U2 round 5, trackB-u2r6): `units.spawnAt(kind, faction, PlaceRef, n) → GroupId`, `units.orderGroup(g, {kind: 'go' \| 'guard' \| 'attack', at: PlaceRef})`, `arrived(g)`, `orderFailed(g, 'none' \| 'rising' \| 'water' \| 'no-town' \| 'pool-full')`, `members(g)` — `PlaceRef = {town, place} \| {town, district, purpose (LOT_KIND), rank}`, resolved by townplace.wgsl (binding 57). Wired in stream-setup (`units.usePlaces(tc.places, tc.townArea)`); one addition to Track A's TownContracts: `townArea(i)` (the grid's corners, CPU plan, for the agents' scope). TownForces can build against it. Open for A: is `purpose` the lot kind (assumed) or a district purpose? | B | delivered; question open |
| 2026-11-10 | B → A | Round 5b: `PlaceRef.purpose` renamed `kind`; `else` (≤ 3 deep) and `also` resolved on the GPU in the group's record — the settled choice holds while valid, `orderFailed` only when the whole chain fails (the last ref's reason). Lab tests 'gate else keep' and 'spawn k also gate k' pass on Muru (gate 0 is over water) | B | delivered |
| 2026-11-11 | B → A | U2 round 6 (trackB-u2r8): `units.orderGroup(g, o: SquadOrder)` — `{kind: 'drill', at: PlaceRef, formation: 'column' \| 'line'}`, `{kind: 'man', town, side?}` (side: a run's index in routeread's wall table), `{kind: 'march', town, gate: k, leave?}`, and go/guard/attack `{…, formation?}`; `units.left(g)` (a march that leaves: its last member out of the window); `orderFailed` reasons + 'failed' (gate route not traced), 'busy' (one town's routes at a time). Wiring: `units.usePlaces(tc.places, tc.townArea, routesFor)` with routesFor(slot) = LivingTowns.routeRead(TownContracts.townSite(slot)).buffer — one small addition to TownContracts (`townSite`) | B | delivered |
| 2026-11-11 | B → A | Man needs the wall-walk reachable: on Muru the stair ends at z ≈ 104.9, routeread's walk points continue at 106.2–107.8 with no surface under them, and the wall's top (109.0) is unreachable — the stair must reach the walk (steps ≤ 1.1, headroom ≥ 1.5) (BACKLOG U2-WALLSTAIR) | A | open |
| 2026-11-11 | B → A | Your three asks (round 6): `spawnAt` returns an id and tells orderFailed(g, 'pool-full') past the groups (SF-8 can go); `spawnAt(kind, faction, at, n, {sight, speed, health, damage})` — sight/health per unit, damage per unit at actors only, speed picks the pace class (soldier kind 3.2, raider 3.4, your values); a failed spawn makes no units and its failure sticks (orders held till the spawn resolves) | B | delivered |
