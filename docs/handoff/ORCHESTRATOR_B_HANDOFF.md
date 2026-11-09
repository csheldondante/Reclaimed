# Orchestrator B — art, GPU asset pipeline, procedural architecture

You orchestrate Track B. Read in this order: [CURRENT_STATE.md](CURRENT_STATE.md) → this file →
[TRACK_B_ART_ASSETS_ORCHESTRATOR.md](TRACK_B_ART_ASSETS_ORCHESTRATOR.md) (the pivot's experiments and gates) →
[CROSS_TRACK_CONTRACT.md](CROSS_TRACK_CONTRACT.md) → `docs/AGENT_RULES.md` (binding) → the DESIGN.md sections below. You
inventory, propose bounded experiments, delegate to subagents, review, integrate, and report to the user with **Hacks and
limits** in every report. "A correctly executed experiment may conclude **do not build**."

## Phase 0 — private repo + Cloudflare Pages (you own it; the user does account steps)

**Status: NOT STARTED.** Owner: **Track B orchestrator**; the user performs the account actions. Track A is **not** blocked
by it (the user's decision). Licensed asset ingestion/publication **is** blocked by it.

Facts (verified):
- Game repo: `github.com/csheldondante/Reclaimed` (public). No separate website repo is involved.
- Current deploy: GitHub Pages via GitHub Actions, workflow `.github/workflows/pages.yml`, triggered on pushes to `main`
  and `places`; it builds the branches listed in its loop (`main places fortress before128o onetown phonefix townlab`) with
  `npm ci && npm run build` (Vite, `base: './'` in `vite.config.ts`) and publishes `main` at the root and every other branch
  under `/<branch>/`. Public URL: `https://csheldondante.github.io/Reclaimed/<branch>/`.
- Making the repo private stops GitHub Pages on the user's plan *(unverified which plan; check)* — and those URLs are how
  the user tests on the phone. So **Cloudflare Pages must be live first**, then the repo goes private.

Steps (record evidence for each in this file and CURRENT_STATE.md):
1. Write down the current baseline: commit, workflow, build command (`npm ci && npm run build`), output (`dist/`), the
   branch-per-path layout, and the working phone URLs.
2. Decide the Cloudflare layout with the user: Cloudflare Pages builds per branch natively (preview deployments per
   branch at their own subdomains) — that may replace the `/<branch>/` folder trick; keep `base: './'` working either way.
3. The user creates the Cloudflare Pages project and connects the GitHub repo (OAuth — the user's account). You supply the
   build settings (Node 22, `npm ci && npm run build`, output `dist`), any env, and verify a deploy of `fortress`.
4. Validate on the phone: the game loads, WebGPU works, assets and workers load (`src/world/region-store.worker.ts`,
   `src/settle/plan-worker.ts`), the hitch/speedbench links work.
5. Then the user flips the repo private; confirm GitHub Pages no longer serves; record rollback (make public + re-enable
   Pages, or keep the Cloudflare project as primary).
6. **Licence gate:** read the actual Synty licence terms for the owned packs and browser delivery. A private repo does not
   make files served over HTTP private. Document what may be shipped (e.g. converted/merged meshes in a packed binary vs raw
   FBX/textures), required protections, and record **PASS / BLOCKED**. Until PASS: no Synty-derived files in any build or
   commit; placeholder-only benchmarks.

Local asset location (never commit, never publish): `C:\Users\cshel\AppData\Roaming\Unity\Asset Store-5.x\` — Synty Studios
(POLYGON Fantasy characters, Dungeons, Fantasy environments, Historic, Trees), plus MalberS Animations (animals), Raygeas
(nature textures/materials), Opsive and Explosive (animation). BACKLOG **ART1** already describes an import plan
(unpack `.unitypackage`, convert FBX, normalise to cell scale, palette-map Synty's single atlas, tag catalogue; raw packs
outside the repo; only converted data committed after each licence check). Licence status: **unchecked**.

## Master design reading map (`.claude/docs/design/DESIGN.md`)

| Section | Why |
|---|---|
| §5 Rendering and 3D tile streaming (l.171) | Lo-fi look stays; open to a high-res texture experiment (Dota 2 look); streaming must stay low-latency with no draw gaps. |
| §3 Grids and External intervals (l.73) | Buildings are their own grids; External intervals claim terrain; burial. Your geometry must claim/project through this. |
| §15 Flora (l.564), §16 Fauna (l.600) | Flora redo as sprites or low-poly (Dota or asset packs); composable creatures form the unit builder. |
| §17 Towns: one plan (l.627) | One plan; Townscaper-style painting stays the interaction; shape modifiers (curves, dragged areas, farm plots/rows). |
| §10 Physics engine (l.384) | Destruction is voxel deformation/fracture on baked voxel models — your damage states must be compatible. |
| §24 Performance and platform (l.851) | Pixel 9a floor; Chrome only; 30 fps cap while planning/paused; toggle diffs on the phone. |
| §25 Process (l.884) | Rules for agents. |

DECISIONS: round 128p (2026-11-06 to 2026-11-09) for the user's words on tiles vs curves vs dragged areas, insets, paving,
"visuals pass later".

## Implemented architecture you will reuse (verified paths)

- **Renderer:** `src/render/renderer.ts` + `src/render/renderer/` (`defs.ts`, `encode.ts`, `features.ts`,
  `gbuffer-shadow.ts` — shadow cache with a static map read beside the sun's, `grid.ts`, `mesh-draws.ts`,
  `terrain-cache.ts`); WGSL in `src/shaders/` (render shaders under `src/shaders/render/`; `common.wgsl` prepended to all;
  `plantLean` breeze lean there). Docs: `docs/ARCHITECTURE.md` "Rendering" (l.411), "Instance flags" (l.727).
- **Instanced meshes:** `src/render/meshinst.ts` (instances), `treemesh.ts`, `rockmesh.ts`, `bodymesh.ts` /
  `bodymeshbuild.ts` (physics bodies); structure pieces are module instances drawn with one `drawIndexed` per module
  (ARCHITECTURE "Structures", l.2446ff).
- **Terrain mesh and tiles:** `src/render/fieldmesh.ts` (rebuilds from per-chunk shape versions, DA-B28), `tilecache.ts`,
  `tileland.ts`, `tilelandgpu.ts`, `tileworld.ts`, `tilecalib.ts`, `band.ts`, `watersurf.ts`, `shore.ts`.
- **Structures / procedural buildings:** `src/structures/` (`plan.ts`, `place.ts`, `pieces.ts`, `modules.ts`,
  `dressmodules.ts`, `styles.ts`, `wfc.ts`, `linear.ts` walls, `gates.ts`-tests, `assets.ts` buriable assets, `tiles/`
  builder/farmland/systems, `viewer/`); building view of the town plan `src/build/view.ts` and (on `onetown`)
  `src/build/edgeview.ts` (insets, paving), `curveroad.ts` (curve roads, bridges).
- **Flora:** `src/flora/` (L-system trees `lsystem.ts`, `mesh.ts`, `placement.ts`, `species.ts`, `viewer.ts`). The user
  rejected the current tree look in game ("I don't love the current trees"); sprites or Dota-like low-poly preferred.
- **Creatures / units:** `src/inhabitants/` (procedural rigs `rig.ts`, `species.ts`, `pack.ts`, `viewer.ts`),
  `src/units/figures.ts` (unit figures), `src/units/agent-units.ts`.
- **Physics/destruction:** `src/physics/` (+ the voxel lattice `phys.wgsl`), `src/solver/`; five movers today, one engine
  designed (DA-E5..E8).
- **Perf instrumentation:** `src/perf/` (`hitch.ts`, `hitch-hud.ts` — per-pass table; `speedbench.ts` — 16x toggle-diff
  phone bench; `pagebench.ts`, `townbench.ts`, `physbench.ts`, `placebench.ts`, `gpumem.ts`, `readstats.ts`); GPU
  profiler `src/gpu/profiler.ts` (grows its query set, counts untimed passes); transfer table `src/gpu/transfers.ts`.
- **Asset delivery today:** none beyond the Vite bundle; no manifest, no content-addressed store, no OPFS.

## Measurements already available

- Phone (Pixel 9a, fortress, 2026-11-06): 30 fps cap in planning; 16x after Build 12–20 fps. GPU frame mean ~36 ms in that
  run; per-pass timestamps on Mali are unreliable (similar values across unrelated passes) — use toggle diffs.
- Earlier phone report (2026-11-06 05:26): GPU frame mean 20 ms at 1x; `draw` 7.8 ms, field-mesh hash 6.3 ms (since
  removed by DA-B28), shadow 2.6 ms, render prep 2.5 ms.
- No instanced-3D benchmark at 100/1,000/5,000 units exists yet; no impostor work exists.

## Proposed first slices

0. **Phase 0** as above (in parallel with 1).
1. **Audit + baseline** (memo gate 2): what the renderer, structures and inhabitants already do; reproducible phone
   scenes; list missing primitives separately from working ones.
2. **Instanced-3D benchmark first** (Experiment 1) with placeholder meshes (procedural or the repo's own) at
   100/1,000/5,000 units and 8–128 px heights, measured on the Pixel 9a by toggle diff. Review with the user before any
   impostor work.
3. Manifest/cache experiment only after Phase 0 PASS for licensed content (placeholder content may go first).
4. Semantic architecture slice on irregular plots — designed against the town plan's structures (see contract), with
   construction/damage/overgrowth stages compatible with DESIGN §10's voxel destruction.

## Dependencies and interfaces

You own appearance and geometry; Track A owns semantics, placement, routes and gameplay validity. The shared hooks are the
town plan's structure records (identity, cells, `sub` sub-layout for plots/rows, stage), the building view, claims into
terrain (External intervals), and cache invalidation via per-chunk versions. See CROSS_TRACK_CONTRACT.md before editing
`src/build/*`, `src/structures/*` or `src/render/renderer/*`.

## Open decisions for the user

- Cloudflare layout (per-branch previews vs folder-per-branch); custom domain or not.
- Synty licence outcome and what packaging is acceptable.
- Art direction: lo-fi stylised vs higher-res (Dota-like) experiment; sprites vs low-poly for flora.
- Target budgets on the Pixel 9a (draws, VRAM, first-load bytes).
