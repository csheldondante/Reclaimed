# Pivot handoff — instructions for the **current coding agent**

**Audience:** The incumbent agent that knows this repository, has been implementing the existing systems, and maintains the **master design/architecture document**.

**Task:** Close out the current work and transfer ownership to **two new orchestrator agents**, with enough verified design and code context for each to direct implementation agents effectively. **You are preparing and coordinating the handoff, not starting the pivot implementation yourself.**

This is a change in **development priority and orchestration**, not a request to replace the master design or rebuild mature systems. The master document remains the authority on intended architecture and mechanics; the repository is the evidence for what actually exists. This brief explains the new priorities, additions, and concerns. Where it conflicts with the master document, identify the conflict and ask the user rather than silently rewriting either.

## 1. Finish and preserve current work

Before delegating:

1. Bring current work to a safe stopping point. Record branch/commit, uncommitted changes, active worktrees, tests/build commands, runnable demos, and known-good configurations. Do not discard unfinished work.
2. Report **working / partially working / broken / not started** with concrete evidence. Distinguish implemented features from prototypes, plans, assumptions, and features that work only in an isolated demo.
3. Preserve the existing backlog and TODOs as **provisional**. Note what is paused by this pivot, what remains valuable, and what should not be resumed until priorities are reviewed.
4. Specifically identify city legibility/occlusion issues, route/traversability failures, and cases where passive weather, flooding, terrain generation, or simulation invalidates maps. State observed root causes where known; do not speculate as fact.
5. Give each successor a reproducible starting point, including warnings about risky files, overlapping work, integration tests, and existing performance limitations.

**First output to the user:** A concise status report and proposed split of responsibility. Present the handoff plan and unresolved product questions **before** launching large new implementation efforts.

### Phase 0 — Required GitHub privacy and Cloudflare Pages migration

**This is a hard prerequisite for incorporating the owned Synty assets, not a speculative hosting experiment.** The game is currently hosted through GitHub Pages; the project must move to **a private GitHub repository deployed through Cloudflare Pages** before Track B adds licensed Synty source assets or includes them in a public build. The incumbent must pass this explicit gate and the actual repo/hosting configuration to the successors. If the migration belongs to the incumbent rather than Track B, identify its owner and completion evidence; do not leave it implicitly unassigned.

1. **Identify the exact game repository and existing GitHub Pages deployment** from project configuration. Do not confuse the game with any separate website repository or domain.
2. **Preserve a working baseline** (commit/build/deployment settings and current public URL), then make the game repository private and configure Cloudflare Pages to build/deploy from it. Coordinate any domain/DNS changes; do not assume the domain is already moved or that a Pages project exists.
3. **Prove the migration works:** build from the private repository, deploy successfully, validate the game and static files, record the Cloudflare Pages project, URL/custom domain (if any), build command/output directory, required secrets and rollback steps, and confirm that GitHub Pages is no longer the active deployment.
4. **Validate asset licensing before ingestion/publication.** Private source control does *not* make downloaded browser assets private. Verify the applicable Synty license and what transformed/bundled assets may be delivered to end users; document any restrictions and required protective packaging or technical adjustments. Keep licensed source files and raw redistributable files out of publicly accessible paths until compliant delivery is established.
5. **Mark the gate complete with evidence** in the Track B handoff and `CURRENT_STATE.md`. If licensing or migration is blocked, escalate to the user, keep Synty assets out of public builds, and allow unrelated strategy work and placeholder-based asset experiments to continue.

Cloudflare Pages is the **required deployment target**. Whether to add R2, Workers, OPFS, special streaming, or an impostor pipeline remains experimental and must be justified separately.

## 2. Transfer the project's existing context — do not recreate it

You already have the master design document and direct knowledge of the codebase. **Pass that context to each new orchestrator.** Neither should be asked to rediscover architecture already documented or reverse-engineer known working systems merely because this handoff omitted the context.

For **each** successor, create a tailored onboarding package containing:

- **Master design:** The actual document (or an explicitly accessible repository path/version), plus a **section-level reading guide** identifying which passages apply to that track. Do not substitute your summary for the design document. If the complete document cannot be transferred, say so and provide the relevant full sections, with pointers to what is missing.
- **Implemented architecture:** Verified source paths, key interfaces/data representations, entry points, call flow, tests, asset conventions, and the existing operators the track should reuse. Cite code and document locations precisely; **do not invent filenames or API names**.
- **State of implementation:** Working features, partial features, known problems, abandoned experiments, and provisional TODOs **relevant to that track**. Include recent work that a fresh-context agent would otherwise repeat.
- **Pivot requirements:** The applicable material from **Track A** or **Track B** below and the corresponding context memo. Separate firm requirements from brainstormed candidates and experimental hypotheses.
- **Near-term plan:** Recommended *small* investigations/vertical slices, grounded in existing code, with expected visual or gameplay payoff, dependencies, measurable acceptance criteria, and explicit user review points.
- **Dependencies and interfaces:** Shared files/data models, what the other track owns, any required contract changes, and a way to communicate/block on those changes.
- **Open decisions:** Ambiguities, conflicts with the master spec, and implementation choices requiring the user's direction rather than agent-made product decisions.

Prefer a **short navigable map to authoritative documentation + verified code pointers** over pasting the same broad design explanation into every prompt. But do not reduce the handoff to a file link without describing what to read and why.

## 3. The two successor orchestrators

They are **orchestrators**, not single-task feature agents. They should inventory, propose bounded experiments, delegate implementation to subagents, review results, integrate changes, and report to the user. They share the same persistent world and must coordinate, but have distinct ownership.

### Track A — Strategic loop, instant world mutations, city legibility

**Purpose:** Prioritize a playable, card/board-game-inspired **City POV** loop whose decisions immediately alter strategic state and visibly transform the persistent world. Preserve real-time simulation as spectacle and as an interactive, diegetic interface; do **not** make slow continuous simulation the mechanism for resolving most strategic actions.

Transfer the existing master-document sections and code paths for:

- Turn controller, opportunities, costs/borrowing, timers, expiration, state-dependent dealing, POV, tags/triggers, engines, threats, and persistent legacy progression **to the extent already designed or implemented**.
- World state, atlas/regions/cities, faction and political state; terrain/interval edits; vegetation, water, wind, fire, physics, agent behavior; mutation validation and deterministic application.
- Generation, roads/routing/traversability, city activity, landmarks, plazas, agent traffic, camera/visibility, and event staging.
- Interactive spells, units, encounters, and pathways by which real-time actions feed persistent strategic outcomes.

**New emphasis:** Validated **instant mutations** followed by optional time-lapse presentation; composable modifiers (festival, occupation, siege, prosperity, undead, electrified, quarantine, ruin, overgrowth, floods, ice, volcano, etc.); legible camera-visible streets, plazas, waterfronts, elevated circulation, and events. Agent movement largely *presents* the state of the world, rather than determining the pace of strategic resolution. Prevent passive simulation from accidentally breaking required routes, while allowing explicitly modeled obstructions from gameplay.

**Prototype target:** A fixed City POV that draws state-appropriate opportunities, commits resources, advances turns, generates new choices through changed state/engine effects, visibly transforms the city/world, and eventually demonstrates persistent consequences across a major threat or run transition. Include at least one constructive and one defensive **real-time spell** with a measurable strategic consequence. Choose the first opportunities/modifiers with the user after ranking spectacle, reuse, effort, and risk; **do not** build the full card catalog.

**Source context memo:** `TRACK_A_STRATEGY_WORLD_ORCHESTRATOR.md`. It describes intent/candidates; **you must attach the actual project/code context** before handing it to the new orchestrator.

### Track B — Art, GPU asset pipeline, procedural architecture

**Purpose:** Improve visual quality and asset variety on mobile browsers while keeping downloads, memory, batching, and frame time economical. Run experiments independently of the gameplay track, with explicit integration points.

Transfer the existing master-document sections and code paths for:

- Renderer, GPU instancing and buffers, mesh/material formats, current asset imports, animation/skinning, lighting/shadows, mobile performance instrumentation.
- Existing flora/fauna/unit/building generation, procedural geometry tools, irregular plot/city representation, attachments, destruction/repair and terrain integration.
- **Phase 0 deployment prerequisite:** the exact existing game repository and GitHub Pages build/deploy configuration; steps and evidence to make that repo private and move its public build to Cloudflare Pages; license constraints and allowed Synty asset delivery. Assign a named owner to this gate.
- Hosting/deployment, bundling/caching, asset licenses, and any known technical constraints for Cloudflare and Synty assets.

**Execution order / gates:** **(0) Complete and verify private-GitHub → Cloudflare Pages migration and Synty browser-delivery license review before licensed asset ingestion/publication.** (1) Benchmark shared GPU-resident geometry/material/animation and **instanced 3D first** at representative on-screen counts and projected sizes. (2) Test on-device impostor baking **only if the 3D measurements justify it**. (3) Implement the smallest useful versioned manifest/caching/optional-pack experiment and measure cold/warm/redeploy behavior before expanding infrastructure. (4) Prototype an editable Tiny Glade-like **semantic architecture** system on irregular plots with distinct construction styles and staged construction, damage, and overgrowth. Use existing geometry/operators; do not assume a rewrite is needed. Review priorities and results with the user.

**Source context memo:** `TRACK_B_ART_ASSETS_ORCHESTRATOR.md`. It is experimental scope, **not** a replacement for the renderer/asset architecture documented in the project.

## 4. Establish boundaries and coordination before parallel implementation

| Concern | Track A owns | Track B owns |
|---|---|---|
| Strategic state / opportunities / threats / history | Authoritative logic, transitions, persistence | Visual consumer |
| Mutations / routing / city legibility | Semantics, scope, validation, placement and movement constraints, camera-visible layout | Geometric/visual realization and asset support |
| Construction, damage, style | Strategic construction/damage states and their gameplay consequences | Building grammar, editable geometry, staged/ruined appearance |
| Units and encounters | Behaviors, spell mechanics and strategic consequences | Meshes, animation, visual variants and rendering |
| Rendering and delivery | Required presentation and performance scenarios | Asset packing, 3D/impostor benchmarks, caching, distribution |

You know where these responsibilities currently live in code. **Identify shared files and existing interfaces in the handoff**. If both tracks need the same subsystem, define who edits it first, how changes are reviewed, and a minimal interface test; do not let two orchestrators independently invent state schemas or rewrite shared systems.

At minimum, resolve or explicitly flag the interface between **semantic world/building state** and **visual/geometric realization**: identity, scope, construction/damage phase, deterministic parameters, spatial anchors, route updates, visual modifiers, and cache invalidation. Reuse existing conventions where possible. Keep a compact cross-track dependency log and use separate worktrees/branches if the environment permits.

## 5. Required handoff deliverables

Produce the following **from the actual repository and master document**, not from this brief alone:

1. **`CURRENT_STATE.md`** — verified work status, build/test steps, outstanding issues, paused TODOs, source locations and branch state.
2. **`ORCHESTRATOR_A_HANDOFF.md`** — Track A mission + precise master-document reading map + implemented system/code pointers + current known problems + staged proposal + dependencies + unanswered questions.
3. **`ORCHESTRATOR_B_HANDOFF.md`** — analogous tailored package for Track B, including renderer measurements already available, existing generators/importers, and **Phase 0 private-repo/Cloudflare Pages migration status, owner, validation steps, and Synty license gate**. Distinguish deployment/licensing facts from assumptions.
4. **`CROSS_TRACK_CONTRACT.md`** — ownership, shared interfaces/files, integration risks, tests, communication mechanism, and proposed first joint demonstration.
5. **A short user-facing summary** of the handoff, what each successor will tackle first, what remains paused, **the status/owner of private-repo → Cloudflare Pages migration**, and specific decisions requiring user input.

If you can instantiate the two orchestrators, give each its **tailored package plus access to the master design**, not merely this instruction sheet. If you cannot instantiate them directly, deliver the handoff packages ready for separate new contexts. Verify that all referenced documents and code paths are accessible in their destination environments.

## 6. Principles and questions to preserve

- The priority is **mechanically meaningful, immediately visible changes** to a living, persistent world—not a bigger catalog of isolated effects.
- The city needs visible streets, plazas, and events from the actual isometric camera. Dense verticality can remain where it does not hide the point of the scene.
- Strategic outcomes must be deterministic/validated where appropriate; their animation can be rapid or interactive. Real-time interventions must have actual strategic consequences.
- Existing GPU/terrain/physics/agent systems are assets to reuse. Do not assume expensive implementation when an existing representation already makes a transformation trivial.
- Preserve **open design choices** rather than silently settling them: exact turn/expiration timing, autonomous events versus offers, mutation stacking, route-blocking exceptions, first showcase opportunities, first successor-run scope, cross-track architecture interface, and target-device budgets. **Synty license verification is a required gate**, not an optional design preference.
- Treat all candidate opportunity/modifier lists as **options for ranking with the user**, not assigned build queues. Preserve the broader backlog as provisional.

**Handoff completion criterion:** Both new orchestrators can name their authoritative design sections, exact existing code they should reuse, current validated behavior and failures, near-term scope, ownership boundaries, and what they must ask before changing shared systems. The user has a clear status report and can approve the first vertical slices **without needing to re-explain the project**.
