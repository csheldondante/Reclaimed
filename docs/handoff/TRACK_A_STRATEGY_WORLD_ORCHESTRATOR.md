# Track A — Requirements context for the incumbent agent to transfer

**This file is not yet the final orchestrator onboarding package.** The incumbent coding agent must combine it with the project's **actual master design document**, a reading map to relevant sections, verified repository paths/APIs, status of current code, known failures, paused TODOs, and the cross-track agreement. See `PIVOT_ORCHESTRATOR_HANDOFF.md` for the handoff process.

## Mission

Orchestrate the playable turn-based **City POV** loop, deterministic/validated **instant world mutations**, visible city activity and legibility. Keep the existing real-time GPU simulations as living presentation, time-lapse, and interactive actions; do not require slow simulated construction or economics to resolve strategic turns. The world and its history persist through collapse and successor runs. Future POVs (character, caravan, faction, empire, etc.) should remain possible but are not the initial content scope.

## Context the incumbent must locate and transfer

- Master spec: opportunity schema, turn phases, cost/borrowing semantics, tags, predicates, triggers, dealer, POV, threats, persistent history; label implemented vs designed portions.
- State/data: atlas, regions, settlements, structures, factions, relations/laws/technologies; scoped modifier systems and save/persistence.
- Operators: terrain intervals, generation, water/flood fill, dust/ash/snow/ice, wind, weather, lava/fire/melting, flora/overgrowth, physics/destruction, agent systems, GPU dispatch, mutation state updates.
- Navigation: city roads and plot geometry, routing, traversability, road-terrain smoothing, map validation, agent/traffic representation, current failure cases.
- Camera and activity: isometric view, occlusion, plazas/landmarks/port visibility, settlement activity and crowd animation.
- Interactive systems: spell inputs, encounters, combat/defense, unit control, and how to record mechanical outcomes.

For each: pass specific design sections, code paths/API names, entry points, existing tests/demos and confidence level. The incumbent should not ask the successor to re-audit known facts, but the successor should validate important claims when integrating.

## Intended play loop and mechanics

- **Seasonal turn, provisional phase order:** resolve completed projects/release borrowed costs; apply income, upkeep, world events, threat progression; deal context-appropriate opportunities while retaining active offers; player chooses/commits resources and placement/targets; start funded projects, process immediate effects, decrement offer lifetimes and resolve expirations. Exact clock/trigger semantics remain to be specified and tested.
- **Resources:** Magic, Might, Labor, Resources, Intel; Unrest reduces effective Labor and is queryable. Influence is provisional and may be faction-scoped. Stockpile/income/capacity and spent-vs-borrowed costs must be consistent. A committed project cannot have its costs freely reassigned.
- **Opportunities:** identity/family/tags; actor/target; eligibility and discovery/visibility; costs; duration and offer expiration; activation/resolution/expiration effects; draw modifiers; scoped persistent world mutations. Eligibility, discovery, being offered, and affordability are separate states.
- **Triggers:** `OnReveal`, `OnAllocate`, `OnResolve`, `OnExpire`, `OnTurnStart`, `OnTurnEnd`, plus `OnDraw`/`OnDiscard` if hand cards exist, `OnDissolve`/`OnDestroy`, `OnTagAdded`/`OnRelationChanged`. Deterministic ordering must prevent unintended recursion.
- **Engines:** income, discounts, extra reveals, adjacency/placement, changed opportunity weights, activated abilities, condition-dependent synergies. Examples: University -> Intel/research draws; Explorers' Guild -> draw on Exploration resolution; Royal Armory -> military discount; Necromantic Foundry -> undead labor and Magic.
- **Dealer:** instantiate plausible offers from actual world and POV, including knowledge/authority/geography/relations. No artificial anti-player counter-drafting. World events may share effects/predicates but need not be player-facing offers.
- **Threat/legacy:** one staged major threat per run (initially subtle), increasingly consequential late-game effects, world-altering outcomes, collapse or POV shift **without erasing the persistent world**.

## Mutations and presentation

The authoritative strategic/world state changes **immediately**, then may be shown through time-lapse or real-time spectacle. Mutations must keep state consistent and traversability valid unless an intentional gameplay event explicitly changes reachable space. Weather and ordinary simulation should not silently strand all agents or invalidate generated city maps. Report which consistency checks already exist and which are needed.

Support composable **strategic state + visual/activity/behavioral projections**, rather than bespoke state scripts: prosperity and busy trade/ships, festivals and crowds, occupation/checkpoints/flags, siege/camps, undead social transformation, electrification/lighting, quarantine, revolt, industrialization, construction/repair, ruin, overgrowth, ice/stasis, flood/ash/fire/lava, volcano/chasm/floating city, magical corruption. Test stacking/override semantics; do not assume all combinations are automatically compatible.

**Legibility:** The city is too dense/tall and often obscures roads. Generate camera-visible arterial routes, plazas, markets, docks, promenade, gate and event areas; retain spectacular sparse superstructures with traversable stairs/balconies/bridges/terraces. Compare actual isometric views across zoom levels with moving agents, not only overhead layouts. Quantify route/event visibility where useful. Agent movement can often be a cheaper visual depiction of world state, not a hard simulation dependency.

**Interactive bridge:** Spells and unlocked units should be playable in the city or encounters, with effects that feed the turn system. Initial constructive example: draw growth runes, erupting crops/trees and increased resource income. Defensive example: steer wind/tornado, wall/geomancy or water diversion to reduce losses/damage during an attack. Use existing mutation primitives, not separate disconnected reward paths.

## Prototype candidates — user chooses after code audit

| Candidate | Mechanics | Distinct visual demonstration |
|---|---|---|
| Found University | Intel, research draws, unlock magic | Landmark, staged construction |
| Harbor / trade boom | trade/resources/engine | Ships, cargo, crowded docks |
| Festival or occupation | relations/Influence, state modifiers | Parades/crowds **or** patrols/checkpoints |
| Siege or awakening giant | major threat, intervention, persistent damage | Camps, battles, rampage, aftermath |
| Volcano or great flood | geographic mutation and crises | Lava, debris, inundation, evacuation |
| Barracks / Royal Foundry | Might/industry and synergies | Troops or workers/furnaces |

Other candidate families to retain as **provisional content**: magical schools (storm, geomancy, vegetation, telekinesis, water, fire, ice, necromancy, binding), civic laws/factions, grand monuments, infrastructure (roads/rails/warp gates), flying citadels, giant creatures, magical ecological transformations, and political revolutions. Do not implement the catalog until the loop demonstrates replayable choices.

## Initial orchestration gates

1. Verify implemented strategic systems, mutation operators and navigation/city visibility bugs. Propose a shortlist ranked by **reuse × strategic interest × spectacle / effort**, with measured mobile risk. Review with user.
2. Produce fixed City POV loop with context draws, resource commitments, timers, expiration, deterministic effects, at least one persistent engine synergy.
3. Connect chosen opportunities to validated world mutations and clear before/after views. Implement time-lapse presentation only after instant mutation correctness.
4. Demonstrate a visible social/civic state, a major crisis and one constructive + one defensive real-time ability with durable strategic outcomes.
5. Demonstrate a threat resolution and a subsequent run/POV inheriting changed world state, at minimum as a controlled proof rather than a complete game.

**Success:** The player makes meaningful drafting choices, the city visibly and mechanically transforms, route/state integrity is maintained, and the changes persist. Deliver a reproducible scenario/seed, tests, screenshots/video and known limits.

## Cross-track boundaries and unresolved details

Track A owns state, mutations, routing/placement/camera-visible layout and strategic spell outcomes. Track B owns the procedural architecture grammar, geometric construction/damage representation, asset pipeline and rendering. Agree on semantic building states, stable IDs, anchors, damage/construction stages, deterministic seeds, and GPU/cache invalidation via the **existing** interfaces wherever possible.

Explicitly flag: exact timer semantics; event scheduling versus player offers; modifier precedence; deliberate route severing; first catastrophe/successor POV; what counts as an acceptable first vertical slice; performance constraints. Do not silently invent policy.
