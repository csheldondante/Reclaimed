# Orchestrator A — strategic loop, instant world mutations, city legibility

You orchestrate Track A. Read in this order: [CURRENT_STATE.md](CURRENT_STATE.md) → this file →
[TRACK_A_STRATEGY_WORLD_ORCHESTRATOR.md](TRACK_A_STRATEGY_WORLD_ORCHESTRATOR.md) (the pivot's intent and candidates) →
[CROSS_TRACK_CONTRACT.md](CROSS_TRACK_CONTRACT.md) → `docs/AGENT_RULES.md` (binding for you and every agent you start) →
the DESIGN.md sections below. You are an orchestrator: inventory, propose small slices, delegate to subagents with briefs,
review diffs for patches, merge green work, and report to the user with **Hacks and limits** in every report.

**Not gated by Phase 0.** The user: "I would not delay the instant mutation track for the art track's requirement for the
private repo." Work in the public repo as today; never add licensed assets.

## How the user wants work done (non-negotiable, from DECISIONS)

- Make the code match the design; delete duplicate systems rather than adapting them. "If the current implementation is
  bad redo it don't fight it. Git history preserves it."
- Design note before code; riskiest part first (phone toggle diff, play-zoom shot, edge cases as failing tests); no patches,
  thresholds, give-up timers or caps that hide a cause; gates that match the game (the `town` lab recipe).
- No per-frame or timed GPU→CPU readbacks; async, small, event-driven reads only. Flag every large transfer and every
  expensive representation with its reason (AGENT_RULES §1b/§1c).
- Perf is judged on the Pixel 9a by toggle diffs, not per-pass timestamps. Judge visuals in game at play zoom.
- Check DESIGN.md, DECISIONS and metacognition before asking the user something already decided. Ask for genuine product
  decisions; don't invent policy.

## Master design reading map (`.claude/docs/design/DESIGN.md`, line numbers at fortress 437f6210)

| Section | Why you need it |
|---|---|
| §11 Agents and flow fields (l.419) | One crowd, physical when needed, cheap otherwise — agents present the world. |
| §12 Routes and roads (l.458) | Route network, kinematic trips, queues, detours paid once. **The `onetown` branch rewrote §12/§13 lines that described old code** (DESIGN.md on `onetown` has the round-128p block: grid-edge paths, curve main roads, structures as one node, route queues). Read that version. |
| §13 Reach (l.502) | Reach is an invariant; fix the world (gate, bridge, stairs, grading) or refuse in plain words. |
| §14 Traits and effects (l.528) | Spells = effects with a cost; mana = fortress power; city spells as traits on places/fields — your modifiers. |
| §17 Towns: one plan (l.627) | One plan, generation through the player's plan API, one home town per run. |
| §18 Fortress loop and economy (l.651) | **Superseded for the strategic layer** by the user's 2026-11-09 decision: turns + abstract resources; physical goods become presentation (may be revisited). Update §18 with the user. |
| §19 Raids and combat (l.686) | Raids are one opportunity type among many; no combat-only damage rules. |
| §21 Runs, opportunities, GM, living world (l.749) | Card format (cost, effect if played, effect if it expires), dealer, arcs, persistent world, outcomes as near-instant mutations through owner systems. Your loop's core. |
| §22 UX (l.788) | Atlas button + card icons; messengers in person; spell wheel now, runes later. |
| §23 Persistence (l.822) | The world carries over between runs — the legacy mechanic is the point of the game. |
| §6–§9, §15 (l.222–384, l.564) | The world operators your mutations drive (weather, fluids, loose material, collapse, flora). |
| §5 Rendering (l.171) | Camera: minimal; click structures; cutaway later. Legibility work lives here too. |

Also: `docs/DECISIONS.md` rounds 128o–128p (latest first) for the user's exact words on roads, turns ("next turn" half a day
per click, BACKLOG DA-L10), raids, economy.

## Implemented systems you will reuse (verified paths)

**Town plan and building** — `src/build/plan.ts` (TownPlan), `site.ts`, `town.ts`, `towngrid.ts`, `quadgrid.ts`
(Townscaper grid), `types.ts` (building type table), `shapes.ts`, `solid.ts`, `claims.ts`, `view.ts`; fortress host and UI
`src/fortress/fortress.ts`, `ui.ts`, `words.ts` (plain player text), `economy.ts`, `recipes.ts` (+ `data/recipes/`),
`quarry.ts`, `inspect.ts`, `follow.ts`; scene glue `src/scenes/level/fortress.ts`.

**Roads, reach, routes (DA-A13, on `onetown` c0ff931f; merge pending)** — `src/build/edgenet.ts` (grid-edge path network +
union-find reach), `edgeview.ts` (insets, paving), `curveroad.ts` (grown curve roads, bridges), `townroads.ts`
(`relayRoads`: the one order for generation and edits), `terrace.ts` (levelling), `stands.ts`; routes
`src/agents/routes.ts`, `routeride.ts`, `src/shaders/routes.wgsl`. On fortress the **old** system still runs:
`src/build/lanes.ts`, `ways.ts`, `entrances.ts`, `reach.ts`, `reachgpu.ts`, `sitereach.ts`, `src/agents/ride.ts`,
`roadgraph.ts`, `src/shaders/roadride.wgsl` — all deleted by DA-A13.

**People** — `src/town/life.ts` (TownLife, event-driven, pure; tests `life.test.ts`), `src/town/jobs.ts`; adapters
`src/fortress/townwork.ts`, `src/settle/work.ts`; wiring `src/fortress/crowd.ts`, `src/settle/crowd.ts`.

**Agents (GPU)** — `src/agents/agents.ts`, `src/shaders/units.wgsl`, `src/agents/stepplan.ts` (fast-forward strides),
`notice.ts` + `src/shaders/notice.wgsl` (combat targeting, fight rules as data), `pick.ts` (tap pick), `scope.ts`;
units API `src/units/*`, contract `src/api/contracts/units.ts`.

**Raids (to become an opportunity type)** — `src/fortress/raid.ts` (RaidClock, `RAID.timed: false`), `raiders.ts`,
`defence.ts`.

**Opportunities, living world, GM (exist on the run path, unused by the fortress)** — dealer `src/opps/dealer.ts`
(`deal(...)`), `deck.ts`, `kingdom.ts`, `run.ts`, `level-opps.ts`; living world `src/living/engine.ts` (`LivingEngine`,
`applyBatch`), `mutations.ts` (`setRiverInflow`, `placeStructure`, `adjustStores`, `shiftPower`, `setCondition`, `migrate`,
`setControl`), `world.ts`, `dsl.ts`, `library.ts`, `people.ts`, `present.ts`; contracts
`src/api/contracts/opportunity.ts`, `facts.ts`, `world-state.ts`, `settlement.ts`, `run.ts`; GM `src/gm/*`
(`oppcheck.ts` validates deals).

**World operators for mutations** — terrain/intervals `src/world/layout.ts`, `src/sim/*` (edit brush `edit-ops.ts`,
`systems.ts`, `lava.ts`, `particles.ts`, `world-gpu.ts`, versions `chunkver.ts`), water/flood `src/terrain/flood.ts`
(+ `flood.wgsl`), `src/api/water.ts`, wind `src/api/wind.ts`, fire `src/api/fire.ts`, plants `src/api/plants.ts`
(`treesNear` on the GPU), world API `src/api/world.ts`, `terrain.ts`, `mirror.ts` (pages on demand); traits on units
`src/traits/*`.

**Camera/visibility** — `src/render/camera.ts`, `src/render/turn.ts`, cutaway `src/api/cutaway.ts`.

**Tests and lab** — see CURRENT_STATE.md "Build, run, test". Gates you must keep green: `test/unit/transfers.test.ts`,
`boundaries.test.ts`, writing lint, both test tiers, lab `fortressallbuilt`, `fortressharvest`, `fortressrecipes`,
`fortresscarts`, `fortressraid`, `unitsonground`, `fortressfollow`, `settlecrowd` (`scripts/settlecrowd.mjs`).

## State relevant to you (see CURRENT_STATE for evidence)

- Building works on the phone (user-confirmed). Roads rewrite green alone but the merge with fast-forward fails two gates.
- City legibility: streets hidden in the dense core at play zoom.
- Passive simulation can cut routes after planning (no world check yet).
- Five clocks; no run end; no persistence across runs; raids are a separate loop with combat-only damage rules.
- Opportunities/living world unused by the fortress. No mana spending, no spells, no modifiers system.

## Pivot requirements (from TRACK_A memo; firm vs candidate)

**Firm:** a fixed City POV loop with turns that deal context-appropriate opportunities, commit resources (Magic, Might,
Labor, Resources, Intel; Unrest), resolve **instantly and deterministically** into validated world mutations, then present
them (time-lapse/real-time spectacle); routes stay valid unless a gameplay event intends otherwise; at least one
constructive and one defensive real-time spell with durable strategic consequences; persistence across a major threat or
run transition (controlled proof).
**Candidates (rank with the user, don't build a catalog):** Found University, Harbor/trade boom, Festival or occupation,
Siege/awakening giant, Volcano/great flood, Barracks/Royal Foundry; modifier families (prosperity, festival, occupation,
siege, undead, electrified, quarantine, ruin, overgrowth, flood, ice, volcano).

## Proposed first slices (small, grounded in existing code)

0. **Finish the roads merge** (`onetown-merge-wip` d5a0333c): diagnose `unitsonground` (person inside warehouse #18 near the
   stores point — suspects: straight last leg ~0.4 m off a lane, or crowd shove on riders at the goal) and
   `fortressallbuilt &ffwd=0` (house at cell 1666). Fix causes, all gates green, merge to fortress, phone link to the user.
1. **Audit + shortlist (gate 1 of the memo):** what of `src/opps`/`src/living` fits the turn loop; which mutation operators
   exist; the legibility and route-breaking cases. Rank candidates by reuse × strategic interest × spectacle / effort with
   mobile risk; review with the user.
2. **One run clock + turn controller** (supersedes DA-L1; connects to "next turn", DA-L10): one clock that the economy,
   day/night, raids and cards read; a turn = a fixed span (the user suggested half a day per click) resolved instantly,
   then shown as a time-lapse.
3. **The raid as the first opportunity card** (DA-L4): the existing raid through the dealer and the card format; delete the
   parallel RaidClock loop.
4. **First modifier through an existing operator** (e.g. flood via `src/terrain/flood.ts`, overgrowth via plants, ash via
   sediment) with a before/after view and the route-validity check.

Acceptance for every slice: user-visible on the phone, tests + lab gates green, play-zoom shots looked at, Hacks and limits.

## Dependencies and interfaces

- **Shared with Track B:** the town plan (`src/build/*`: structure identity, cells, `sub` layouts for plots/rows, stage),
  the building view (`src/build/view.ts`, `edgeview.ts`), structure meshes (`src/structures/*`), damage/construction
  stage. See CROSS_TRACK_CONTRACT.md: you own semantics and placement; Track B owns geometry and appearance.
- Raid/agent code is shared with the unfinished Units-contract cutover (`phonefix-observe-wip`); decide with the user
  whether to finish it (it removes per-frame unit reads) before or after the loop.

## Open decisions for the user (ask, don't decide)

- Exact turn length and phases (memo's provisional order vs "half a day per click"); offers' expiry timing.
- Autonomous world events vs player offers; modifier stacking and precedence; deliberate route severing rules.
- First showcase opportunities/modifiers; first threat and successor-run scope.
- How DESIGN §18/§21 change for turns + abstract resources (write the edit with the user).
- Mobile budget per frame for the loop's presentation.
