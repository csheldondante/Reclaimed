# Switchover: the GPU towns are the towns (2026-11-10)

The user: "Don't build against a system we are deprecating switch over." and "Stop wasting resources on old code."
Earlier: "players just choose opportunities and we place and build for them" (player painting retired); "we still may
want the irregular grids for vertical surfaces" (keep `src/structures/tiles/*`).

**Rule: delete, don't port.** No compatibility bridges, no CPU readback to feed old code. A feature that only the old
towns had, with no GPU replacement yet, is removed and listed in BACKLOG as a gap (SW-G*) with its owner.

## What plays now

`?skipmenu=1&level=atlas&town=1&fresh=1` — the atlas at the start town (Muru on the default world). Every settlement
whose population warrants a grid (a village and up) is a field town made by citygen (`src/citygen/*`) as the window
nears it; the living town (`src/citylife/*`) and the season loop (`src/season/*`, `scenes/level/season.ts`) run on it.
What was `?citygen=fields&living=1&opps=1` is the default. Flags turn parts off: `?opps=0` (no season loop),
`?living=0` (no living town), `?towns=0` (no settlements at all). Nothing turns the old generator on: it is gone.
`?lab=1` installs the town lab (`src/lab/lab.ts`) that `scripts/lab.mjs` drives.

## The audit: every consumer of the old towns

Owner: **A** = Track A (towns, season loop, world), **B** = Track B (units, combat, art). "Deleted" means the code is
gone in this branch; "kept" says why.

| Item | Fate | Replaced by / gap | Owner |
|---|---|---|---|
| `settle/plan.ts` `planSettlement`, `plan-worker.ts`, `raster.ts` (far plans), `field.ts`, `grids.ts`, `catalogue.ts` | deleted | citygen's field towns; hamlets and farms (no grid) have no town: **SW-G1** | A |
| `settle/settlements.ts` (planning, stamps, life, far plans, raids, pin, places, realise, diplomacy, rates) | cut to the records | records, `approachWays`, `byFields`, `regionAt` kept (citygen's inputs) | A |
| `settle/records.ts` (civ, ruin, box, approaches, override, placed) | cut to the records | `rec`, camp, seed, setting kept; the old draws kept so the camps (and `?town=1` → Muru) don't move | A |
| `settle/view.ts` SettlementsView, `onscreen.ts`, `debug.ts` (TownDebug) | deleted | citygen's own mesh and claims | A |
| `settle/live.ts`, `crowd.ts`, `work.ts` (a town's people as AgentUnits, raids from its camp) | deleted | the living town's riders (GPU); raids: **SW-G2** | A / B |
| `settle/ships.ts`, `shipsview.ts` (sailing ships between ports) | deleted | **SW-G4** | A |
| `src/town/*` (one crowd, the job board) | deleted | the living town's jobs (routes.wgsl) | A |
| `structures/plan.ts` `draftCity`, `place.ts` `siteOfDraft`/`placeDraft`/`planTown`, `pieces.ts`, `gpu.ts` (StructureGpu), `nav.ts`, `wfc.ts`, `linear.ts`, `columns.ts`, `purpose.ts`, `assets.ts`, `styles.ts`, `index.ts`, the viewer (`structures.html`) | deleted | citygen's buildings; the art comes back through Track B's building generator | A / B |
| `structures/tiles/*`, `modules.ts`, `dressmodules.ts`, `rng.ts` | kept | irregular grids for vertical surfaces (cliff cities); the modules are art for the building generator | B |
| renderer's structures draw (`enableStructures`, `structmesh.wgsl`, `structgame.wgsl`, the towns' light pools) | deleted | the night light pools: **SW-G6** | B |
| `build/site.ts` TownSite, `plan.ts` TownPlan, `view.ts`, `ways.ts`, `lanes.ts`, `claims.ts`, `solid.ts`, `sitereach.ts`, `pit.ts`, `shapes.ts`, `entrances.ts`, `grade.ts`, `types.ts` | deleted | citygen (roads, lots, claims, walls), the living town (routes, quarry) | A |
| `build/reachgpu.ts` FortressReachGpu, `reach.ts` | kept | citygen's reach check uses the GPU reach (rename later) | A |
| `build/town.ts`, `towngrid.ts`, `quadgrid.ts`, `runs.ts` (the sandbox's Town: the world API's `town`, the build crew) | kept | not the town generator: the sandbox's builder (world API). Retire with the sandbox's Town tool when its owner says | A |
| `agents/roadgraph.ts`, `roads.ts`, `ride.ts` (roads the agents ride: the fortress set them) | kept, dormant | part of the agents (Track B's files); nothing sets roads now — the living town's riders ride citygen's routes | B |
| CPU static-claims registry (`sim/static-claims.ts` `grid()`/`set()`, StaticInstance, the registry's StaticSet lookups) | deleted | GPU-owned grids only (`gpuGrid`, the arena, `damage`, `ownedJob`) | A |
| town fixture `data/lab/town.rclt`, its test, `scripts/labtown.mjs capture` | retired | the street lab's site fixtures stay (`site-*.rclt`, `labtown.mjs site`) | A |
| `scripts/settletest.mjs`, `placebench.mjs` (+ `src/perf/placebench*`), `townbench`, `speedbench`, `structshot`, `structtouch`, `structtowns`, `townpan`, `townslide`, `hallcheck`, `hallprobe`, `staticclaims.mjs`, `citiesshot`, `settlementtest`, `settlecrowd`, `m124world`, `fortress*.mjs`, `perf/structcity`, `perf/structures` | deleted | the town lab's gates (below); citygen/living benches stay | A |
| fortress mode `?fortress=1`, `scenes/level/fortress.ts`, `src/fortress/*` (painting `fort.paint`, the bar, Skip to done, Inspect, follow, quarry, economy, recipes, raid clock, "Call raiders now", defence, crowd, raiders) | deleted | the season loop; the menu's Fortress button is now Town | A / B |
| the parallel raid loop (RaidClock, "Call raiders now"; BACKLOG DA-L4) | deleted | **SW-G2**: raids come back on Track B's GPU units against the new contracts | B |
| the behaviour lab (`?level=lab`, `src/lab/{town,view,recipes}.ts`, the fortress scenarios) | deleted | the town lab (`?lab=1`, `src/lab/lab.ts`) on the default page; gates `townfollow`, `townseason` | A |
| a situation run's town (`runsit`: its finale's doors, its townsfolk, a fallen town charred) | cut | the record's centre and reach only: **SW-G5** | A |
| the far view of distant towns (old rasters baked into the far land) | deleted | **SW-G3** | A |
| `?city=`, `?cstyle=`, `?cseed=`, `?croads=`, `?cwalls=`, `?cpurpose=` (the old planner's overrides) | deleted | citygen's parameters (`citygen/params.ts`, the street lab) | A |
| inhabitants reading the old plan | none found | `src/inhabitants/*` never read the old plan | — |

## Gates

The fortress lab gates (fortressraid, fortressfollow, fortressallbuilt and the other scenarios) went with the behaviour
lab. On the town game's page instead (`node scripts/lab.mjs run scripts/lab/<gate>.mjs`):

- **townfollow** — one living-town person at Muru followed: rides its route, reaches its destination, on screen, no error.
- **townseason** — two seasons with a walls card: districts claimed and staged, the wall rises, the save point written.

Raid gates come back with Track B's GPU units (SW-G2).
