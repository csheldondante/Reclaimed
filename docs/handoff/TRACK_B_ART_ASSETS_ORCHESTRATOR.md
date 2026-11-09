# Track B — Requirements context for the incumbent agent to transfer

**This file is not yet the final orchestrator onboarding package.** The incumbent coding agent must combine it with the **master design/architecture document**, precise reading pointers, verified renderer and generator source paths, current benchmark evidence, asset/deployment status, failed experiments, and cross-track interfaces. See `PIVOT_ORCHESTRATOR_HANDOFF.md` for the handoff process.

## Mission and constraints

Orchestrate a high-payoff art/asset improvement track for a GPU-driven, mostly fixed-isometric game targeting **mobile browsers**. The project has existing world and renderer systems and Synty fantasy/nature assets; **reuse them**. Most units occupy very few pixels in gameplay view; occasional close-up views may retain full 3D. Maximize quality and procedural variation while limiting first-load bytes, draw/dispatch overhead, GPU memory, upload stalls and asset complexity. Favor measured choices over major rewrites or a giant prefabricated asset library.

## Phase 0 — Mandatory repository privacy and hosting migration

**Blocker for adding or publishing licensed Synty assets:** the existing **game** project must become a **private GitHub repository** and move from **GitHub Pages to Cloudflare Pages**. This is a prerequisite, not a hosting optimization to be weighed after the graphics experiments.

The incumbent must identify and document the exact game repo, current GitHub Pages deployment, build configuration, current domain/URL, and who owns this migration. The responsible agent must:

1. Save the current working deployment/build settings, make the game repo private, and connect the private repo to Cloudflare Pages.
2. Reproduce a successful build and live deployment. Verify app routes, assets, caching headers as relevant, domain/DNS changes if any, and that GitHub Pages is no longer serving the active build. Record configuration, evidence, and recovery instructions.
3. Check the actual Synty license terms applicable to the owned packs and browser distribution **before** committing/publishing licensed assets. A private source repository does not protect mesh/texture files delivered over HTTP. Document what packaging and exposure are permitted and hold back any disallowed public asset delivery.
4. Record an explicit **PASS / BLOCKED** result with repository/deployment evidence and license findings. If blocked, defer licensed Synty ingestion/publication and escalate; proceed with code review and placeholder-only benchmark work where possible.

**Cloudflare Pages is mandatory here.** Whether to introduce R2, Workers, special caching or impostors is a later, evidence-based decision.

## Context the incumbent must locate and transfer

- Master spec and code for current GPU buffers/instancing, geometry format, skinning/animation, materials/shadows/lights/wind, and existing GPU-based generators.
- Synty imports, usable assets/animations, mesh/tooling problems, license and packaging constraints; **do not assume private GitHub makes public browser asset delivery private**.
- Exact GitHub Pages → private GitHub + Cloudflare Pages migration status, owner, build commands, project/domain configuration, proof of live deployment and license review; existing manifest/cache or streaming infrastructure and measured device/browser limits.
- Current architecture editor/generators, irregular settlement plots, terrain integration, procedural structures, interval/mesh operations, semantic attachments, damage and construction stage systems.
- The actual phone/browser performance baseline and reproducible scenes (if available), not abstract assumptions about sprites versus 3D.

Provide each with exact code references, tests/demos, what is known working and what is only an untested proposal.

## Experiment 1 — Benchmark instanced 3D first (highest priority)

Audit current implementation before adding new packing. Test shared GPU-resident mesh vertices/indices, optional skinning data, materials and instance attributes with offsets or IDs as appropriate. Texture atlas for material textures, geometry buffers/data textures as justified; compare palette/vertex colors with atlases. Consider multi-draw/indirect where actually supported and useful; otherwise batch by mesh/pipeline.

Benchmark **100 / 1,000 / 5,000 visible units** with both repeated geometry and diverse meshes, equipment, morphs and animations. Evaluate **8 / 16 / 32 / 64 / 128 pixel** projected heights, including representative shadows/lighting and wind/secondary animation. Measure frame time (CPU/GPU where available), draws, VRAM, upload/parse time, bandwidth and first-load bytes on a target phone. Verify relevant sizes and densities with realistic scenes.

**Gate:** If instanced 3D already meets acceptable measured budgets and visually reads well, favor it and do not build a large sprite pipeline.

## Experiment 2 — Impostors, only if measurements warrant

For fixed-camera, nonrotating objects, one isometric view may suffice; rotating objects need additional orientations. If justified, bake selected poses offscreen into atlases with appropriate antialiasing/alpha-safe downsampling. Compare (A) instanced 3D, (B) RGBA impostors, and (C) impostors with normal/depth/material information for lighting. Test 32/64/128-pixel frames and animations at different variant counts. Measure overdraw, quality under zoom/lighting, bake/upload/cache costs and break-even points. Avoid the combinatorial explosion of morph × equipment × animation × direction; retain 3D for near-camera views.

**Gate:** Adopt only when the cost/quality break-even is demonstrated, not because sprites seem intrinsically cheaper.

## Experiment 3 — Minimal content-addressed asset delivery

Trial a semantic asset manifest mapping IDs to versioned/content-hashed source blobs and dependencies, including file sizes, formats and license metadata. Package reusable rigs, meshes, clips, material families, parts and optional region/faction packs—not every generated variation.

**After the required migration**, test content-addressed immutable static assets on Cloudflare Pages and standard HTTP caching. Evaluate R2/custom domain **only if** size, traffic, deployment or update cadence justify it; no speculative Worker/KV/database. Test OPFS only for selected generated assets where measurable value exists, plus bounded in-memory/GPU caching. Use versioned cache keys based on source+recipe+generator+bake settings. Record cold/warm/partial-update/redeploy bytes, time-to-play, parsing, upload stalls, eviction and cache invalidation. Verify that unchanged hashes do not redownload after a code deploy. Do not publish Synty-derived browser assets until the Phase 0 license check has explicitly passed.

## Experiment 4 — Editable procedural architecture vertical slice

Build a **semantic geometry/grammar** demo inspired by Tiny Glade, compatible with irregular plots and terrain gradients. Curves swept/extruded into walls; connected masses, lofts, bends/setbacks/taper, courtyards and openings. Subdivide into bays/floors and place anchors for doors, windows, arches, pillars, lintels, buttresses, balconies, stairs, roofs and caps. Maintain editable relationships, corners, spacing/opening constraints and connectivity.

Separate **construction system** (masonry, timber, metal, glass, living materials, crystal, etc.) from **style** (proportions, motifs, rhythm, detail density, surface material). Begin with three visibly different presets: fortress/Gothic masonry, timber village, and industrial or organic. Existing Synty components can inform motifs/attachments but should not dictate the entire construction system.

Model **foundation → frame/walls → roof → finished** and **damage → partial ruin → vegetation/fungal recolonization** as reproducible semantic states, preserving plausible surviving features and necessary route/collision information. Avoid arbitrary mesh noise as the only destruction model. Demonstrate three distinct building programs on irregular lots, with editable silhouettes, style swaps, partial construction, damage and overgrowth; compare quality, performance and engineering cost against existing assets.

## Interface with Track A

Track B owns appearance, geometric asset recipes, architecture grammars, construction/damage visual realization, packing, rendering, streaming and cache details. Track A owns strategic semantic changes, where to put buildings, city route visibility/agent movement, and gameplay validity. The incumbent agent must identify the actual shared state/geometry hooks and hand them to both teams. Align on structure IDs, spatial anchors, stage/damage values, deterministic generation, collision/nav updates, and invalidation—**do not invent a new schema if a compatible one already exists**.

## Orchestration order, stop points and acceptance

1. **Complete/verify Phase 0:** private game repository, successful Cloudflare Pages deployment, old GitHub Pages migration/retirement, and documented Synty browser-distribution license outcome. Do not ingest/publish licensed assets before this gate passes.
2. Audit code and master design; reproduce baseline device scenes. List missing primitives separately from already-working capabilities. This audit can run in parallel with Phase 0 using existing code/placeholders.
3. Benchmark instanced 3D and review findings with user before extending sprite/impostor work.
4. Deliver minimal manifest/cache experiment and evidence for whether **Cloudflare Pages alone** suffices or R2 is warranted; review before adding infrastructure beyond the required migration.
5. Deliver editable architecture vertical slice integrated into representative game scenes, not only a standalone editor mockup.
6. Produce an ordered backlog of reusable operators and assets by visual payoff, engineering effort, mobile runtime/download cost, and dependencies on Track A. Preserve alternate directions as provisional.

**Success:** A demonstrably better-looking, reusable game scene and evidence-backed performance/content-delivery decisions on a real mobile device. It is acceptable for a correctly executed experiment to conclude **do not build**.
