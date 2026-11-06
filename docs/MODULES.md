# Modules — a map of src/

Read this instead of opening files to find where something lives: every source file under `src/` (tests left out),
grouped by folder, with its line count, the first sentence of its header comment, and its first exports (`+N`
more). Generated: `node scripts/modules-map.mjs > docs/MODULES.md` — rerun it when files are added, split or renamed.

**The split classes** (docs/ARCHITECTURE.md "Source layout"): the class file keeps the state, the lifecycle and the
public API; the folder beside it holds what the class does, as free functions over the instance — its internals,
called only by the class file and the folder. From outside, use the class.

- `scenes/level.ts` + `scenes/level/` — LevelScene: `attach.ts` wires a level once (attach-tools, input-wiring, test-api, stream-setup); `frame.ts` is a frame of play; the tools, runs, fortress, valley, atlas controls, camera moves and labs beside them.
- `scenes/streamer.ts` + `scenes/streamer/` — Streamer: `slide.ts` (follow the camera, the slide), `freeze.ts`, `generate.ts`, `write.ts`, `store.ts`, `jobs.ts`, `warp.ts`, `regions.ts`; `defs.ts` its flags, records and public types.
- `game/integrity.ts` + `game/integrity/` — Integrity: `tick.ts` (update and the analysis pass), `rigid.ts`, `metal.ts`, `resting.ts`, `columns.ts`, `loose.ts`, `lattice.ts`, `window.ts`; `defs.ts`.
- `render/renderer.ts` + `render/renderer/` — Renderer: `encode.ts` (a frame's draw), `mesh-draws.ts` (the field mesh's pipelines, made by the constructor), `gbuffer-shadow.ts`, `terrain-cache.ts`, `grid.ts`, `features.ts`; `defs.ts`.
- `perf/bench.ts` + `perf/bench/` — The bench (?bench=1): bench.ts keeps the flow of a run, the heartbeat and the state of the Bench class; `pages.ts`, `pace.ts`, `ab.ts`, `sweeps.ts`, `regions.ts` its work; `defs`, `timestamps`, `pan-report`, `state`, `page`, `device`, `report` the free functions.
- `atlas/atlas.ts` + `atlas/atlas/` — Atlas: the class keeps its state, build and small reads; `build.ts` (run: the GPU passes), `regions.ts`, `columns.ts`, `region-land.ts`, `window.ts`; `params.ts`, `tile-pacer.ts`, `defs.ts` re-exported by atlas.ts.

## src/

Boot: WebGPU, the quality tier, the phone flags, and which scene runs.

- `flags.ts` (72) — The page's URL flags, resolved (DA-B17): the URL's own, plus the phone's performance set on the low tier. API: `LITE_SET`, `SIM_SET`, `isPhoneTier`, `expandPhoneFlags` +2.
- `fresh-start.ts` (39) — (round 128n, phonefix; API: `FRESH_DBS`, `FRESH_KEYS`, `freshStart`.
- `main.ts` (293) — Boot: WebGPU, shared services, and switching between the menu diorama and the level.

## src/agents/

GPU agents (the crowd every unit and worker runs on): their kernels' wrappers, jobs, build crews. Installed on a WorldCore by `install.ts`.

- `agents.ts` (1666) — Agents (round 52, docs/AGENTS.md): units that walk the world's surfaces by following shared fields, and fight. API: `AgentTickLog`, `NAV_K`, `MAX_UNITS`, `NFIELDS` +17.
- `buildcrew.ts` (343) — A building crew (round 65, docs/DECISIONS.md: "a mode where it takes the delta of the finished thing you … API: `BuildCrewDef`, `buildOrder`, `BuildCrew`.
- `crew.ts` (286) — A work crew (round 63, docs/AGENTS.md "Crews"): workers that dig or fell and carry what they get to a … API: `CrewJob`, `CrewDef`, `Crew`.
- `fieldreader.ts` (134) — A CPU copy of one agents field (round 52, docs/AGENTS.md), for walkers the CPU moves itself (a game's … API: `FieldSample`, `FieldReader`.
- `install.ts` (17) — Agents in a world (round 52, docs/AGENTS.md): one call, as installPhysics. API: `installAgents`.
- `ride.ts` (216) — The agents ride the roads on the GPU (round 128i, V128-14; API: `MAX_DESTS`, `RIDE_NEAR`, `RoadRide`.
- `roadgraph.ts` (239) — The agents' road graph (round 128i, V128-14; API: `RoadSeg`, `RoadGraph`, `noGraph`, `nodeCount` +8.
- `roads.ts` (162) — The agents' road bits from shapes (round 128i, FT-58; API: `RoadShape`, `ROAD_SHAPE_FLOATS`, `packRoadShapes`, `roadInside` +2.
- `scope.ts` (155) — Where the agents' fields are kept, and where they're relaxed (round 104, simscale — the user: "For the … API: `SCOPE_MARGIN`, `Box`, `AgentScope`.

## src/api/

The engine's public APIs over a live world (the Sim facade `world.ts`, terrain, atlas map, cutaway, puck); game layers use these, not system internals.

- `atlas-map.ts` (559) — ---- api/atlas-map.ts --------------------------------------------------------- The atlas as a map a game … API: `MapWorld`, `MapMark`, `AtlasMap`, `paintAtlasImage`.
- `atlas-world.ts` (246) — ---- api/atlas-world.ts ------------------------------------------------------- An atlas world for a game … API: `AtlasWorldOptions`, `AtlasWorld`, `warpWindow`, `precacheWarp` +2.
- `common.ts` (49) — Shared bits of the world API (docs/WORLD_API.md): materials by name, and world points to columns. API: `MaterialName`, `materialId`, `materialName`, `materialState` +2.
- `cutaway.ts` (290) — ---- api/cutaway.ts ----------------------------------------------------------- Keeping what matters in … API: `LayersSource`, `Slice`, `Orbit`, `Dither` +2.
- `fire.ts` (83) — world.fire (docs/WORLD_API.md): fire, lava and the ground's heat from a CPU mirror; API: `LavaAt`, `Fire`.
- `fx.ts` (76) — world.fx (docs/WORLD_API.md): particle bursts by name. API: `FxName`, `FxOpts`, `Fx`.
- `map-labels.ts` (28) — ---- api/map-labels.ts -------------------------------------------------------- (round 91, the user: "the … API: `LabelKind`, `MapLabel`, `LabelSource`.
- `mirror.ts` (427) — A CPU mirror of some world buffers and textures (docs/WORLD_API.md): the world modules answer their … API: `RingPages`, `SourceKind`, `PageAsk`, `PageReader` +3.
- `plants.ts` (200) — world.plants (docs/WORLD_API.md; API: `TreeSpecies`, `Tree`, `birchWood`, `planTree` +1.
- `puck.ts` (158) — ---- api/puck.ts -------------------------------------------------------------- The camera's puck (round … API: `Puck`.
- `smooth.ts` (111) — Sampling the ground the way the field mesh draws it (fieldmesh.wgsl terrainField, meshregion.wgsl … API: `Tri`, `terrainWarp`, `triAt`, `blendedTop`.
- `terrain.ts` (480) — world.terrain (docs/WORLD_API.md): the ground, read from a CPU mirror in world coordinates, and the … API: `Layer`, `SampleOpts`, `PullOpts`, `PullStroke` +3.
- `treequery.ts` (212) — (round 128o, DA-B6; DESIGN.md §24 "world queries are GPU passes") The nearest trees to a point, answered … API: `MAX_N`, `TreeQueryIO`, `FoundTree`, `TreeQuery`.
- `water.ts` (120) — world.water (docs/WORLD_API.md): depth and flow from a CPU mirror, flood and drain as commands. API: `Water`.
- `wind.ts` (346) — world.wind (docs/WORLD_API.md): blows and strokes a game manages as lists, with no cap a game sees; API: `BlowMode`, `BlowSpec`, `StrokeSpec`, `WakeSpec` +2.
- `world.ts` (224) — The engine's outward API (docs/WORLD_API.md; API: `SimModules`, `SIM_ALL`, `WorldDef`, `WarmupOpts` +3.

## src/api/contracts/

Interface contracts between tracks (world state, structures, settlement, flora, units ...): types only, no behaviour.

- `cast.ts` (61) — The cast: who a character is, as the dialog and the map show them (dialog2; API: `Quirk`, `VoiceId`, `Trait`, `PortraitSpec` +1.
- `compose.ts` (133) — The recipe model's reference implementation (round 85): matching tags, deriving capabilities, checking … API: `Catalogue`, `matches`, `ownTags`, `derive` +4.
- `dialog.ts` (68) — Dialog — trees as data, played by the dialog system (round 83, docs/SYSTEMS.md system 10). API: `DialogTree`, `DialogNode`, `DialogChoice`, `Dialog` +1.
- `diplomacy-memory.ts` (259) — Diplomacy's reference implementation (round 85): opinions read off the interactions by their fading. API: `partyKey`, `AGREEMENT_RELATION`, `MemoryDiplomacy`, `importDiplomacy`.
- `diplomacy.ts` (112) — Diplomacy — memories and agreements (round 85, docs/SYSTEMS.md systems 1, 6, 9 and 10). API: `Party`, `Interaction`, `AgreementKind`, `Agreement` +2.
- `facts-rules.ts` (159) — ---- api/contracts/facts-rules.ts … API: `homeOf`, `polityOf`, `lawAt`, `Invariant` +3.
- `facts-store.ts` (320) — ---- api/contracts/facts-store.ts … API: `MemoryFacts`, `migrateFacts`.
- `facts.ts` (309) — ---- api/contracts/facts.ts … API: `EntityKind`, `ENTITY_KINDS`, `EntityId`, `FactLocation` +25.
- `flora.ts` (148) — The flora contract (round 117, track `flora`; API: `FloraSpeciesId`, `FloraForm`, `FloraHost`, `FloraBarrier` +10.
- `fortress.ts` (166) — Fortress mode's contract (round 128c, docs/design/FORTRESS_MODE.md, FORTRESS_SLICE1.md). API: `StructureType`, `STRUCTURE_TYPES`, `Good`, `Goods` +11.
- `hero.ts` (142) — Heroes — who the player is in a run (round 88, docs/SYSTEMS.md system 8; API: `HeroIntent`, `HeroAbility`, `HeroCamera`, `ChaseFraming` +4.
- `index.ts` (26) — The engine's contracts between systems (round 83, docs/SYSTEMS.md): types every session codes against.
- `inhabitants.ts` (225) — Inhabitants — creatures and people with bodies, procedural animation and wilderness behaviour (round 117, … API: `BodyPlan`, `BODY_PLANS`, `Proportions`, `Palette` +14.
- `items.ts` (41) — Items — what a hero carries on a run, in slots, with mechanical effects (round 120, `runsit`; API: `ItemSlot`, `ITEM_SLOTS`, `ItemEffect`, `ItemDef` +1.
- `opportunity.ts` (513) — ---- api/contracts/opportunity.ts … API: `AgentKind`, `AGENT_KINDS`, `GoodKind`, `Goods` +37.
- `orders.ts` (33) — Orders — the hero tells people what to do (round 120, `runsit`; API: `Order`, `Followers`.
- `play.ts` (231) — Play — the game layer's contract (round 117, the `play` track): heroes, their controllers, controls, gear … API: `ParamSpec`, `Params`, `ControllerProfile`, `Encounters` +8.
- `recipe.ts` (208) — Things made of things: recipes, instances, derived capabilities, civilizations (round 85, docs/SYSTEMS.md … API: `Tag`, `KindId`, `RecipeId`, `InstanceId` +14.
- `run.ts` (318) — A run — from setting out to its end, and what's left of it (round 83, docs/SYSTEMS.md system 11). API: `RunRecord`, `PlayerRecord`, `Run`, `EncounterKind` +18.
- `settlement.ts` (144) — Settlements (round 83, first pass round 85; API: `GridStyle`, `SettlementGrid`, `Settlement`, `SettlementPurpose` +5.
- `simtiers.ts` (87) — The sims' tiers (round 108, BACKLOG SM1; API: `TieredProcess`, `TIERED_PROCESSES`, `Tier`, `TierRect` +4.
- `situation.ts` (141) — A situation — a run as one unfolding situation on the live map (round 120, `runsit`; API: `Situation`, `SituationThreat`, `SituationEnd`, `SITUATION_ENDS` +5.
- `solver.ts` (99) — The node solver's contract (BACKLOG AR4, the physics design: DECISIONS rounds 106, 120). API: `V3`, `Q`, `SolverCell`, `BodySpec` +4.
- `story.ts` (142) — The session story — what the GM writes, offline, before a run (round 83, docs/SYSTEMS.md system 9). API: `SessionStory`, `StoryLocation`, `StoryCharacter`, `Objective` +3.
- `structures.ts` (360) — Structures: buildings, districts, cities, linear features (roads, walls, bridges) and the pieces of them … API: `V2`, `V3`, `GroundFn`, `StructureStyleId` +33.
- `terrain.ts` (316) — Terrain — the map's partition into regions and the terrain's generative tools (round 117, the `terrain` track; API: `BarrierKind`, `TerrainRegion`, `TerrainPass`, `BorderMeasure` +15.
- `traits.ts` (171) — Traits and effects (Living World slice 1, BACKLOG LW1; API: `INTRINSIC`, `STATUSES`, `IntrinsicName`, `StatusName` +16.
- `units.ts` (162) — Units — people and creatures in play (round 88, docs/SYSTEMS.md system 6). API: `UnitId`, `V2`, `V3`, `UnitJob` +5.
- `world-state.ts` (309) — The world state's reference implementation (round 83): in memory, one RegionState a region, the events … API: `MemoryWorldState`.
- `world.ts` (211) — The world between runs — its contract (round 83, docs/SYSTEMS.md systems 1 and 2). API: `RegionId`, `FactionId`, `RegionState`, `Mark` +8.

## src/atlas/

The atlas: the whole generated world map (coarse sim, GPU finish, far land, geysers), from which the streamed window's land comes.

- `atlas.ts` (457) — The atlas (round 67, branch `atlas`): a finite world's coarse map, made on the GPU when the world is … API: `Atlas`, `WINDOW_MAKE`, `FINISH_TILE`, `GEYSER_STENCIL` +14.
- `bake.ts` (340) — The land past the window baked into a texture (round 94, bake.wgsl; API: `SurfaceStamp`, `MAX_BAKE`, `BAKE_UNI_BYTES`, `SurfaceBake`.
- `bake.wgsl` (219) — ---- atlas/bake.wgsl ------------------------------------------------------- (round 94, the user: "I don't …
- `build.wgsl` (313) — ---- atlas/build.wgsl ----------------------------------------------------- The macro passes (round 67), n …
- `coarse.ts` (397) — The coarse world (round 71, coarse.wgsl): the whole torus at cn × cn cells, what has changed from the … API: `EV`, `CoarseEvent`, `CoarseAt`, `CoarseSnap` +2.
- `coarse.wgsl` (271) — ---- atlas/coarse.wgsl ---------------------------------------------------- The coarse world (round 71): …
- `columns.wgsl` (150) — ---- atlas/columns.wgsl --------------------------------------------------- Columns for the streamer from …
- `common.wgsl` (72) — ---- atlas/common.wgsl ---------------------------------------------------- The atlas's parameters (round 67;
- `compose.wgsl` (959) — ---- atlas/compose.wgsl --------------------------------------------------- The ground at any world point …
- `far.ts` (358) — The land beyond the window (round 73, far.wgsl): the atlas's macro ground (heights and colours at half its … API: `FarLight`, `FarTargets`, `FarLand`.
- `far.wgsl` (1024) — ---- atlas/far.wgsl ------------------------------------------------------- The land beyond the window …
- `finish.ts` (321) — ---- atlas/finish.ts -------------------------------------------------------- (round 102, `gpugen`; API: `GPUGEN`, `FinishTarget`, `GpuColumns`, `FinishMeta` +2.
- `finish.wgsl` (521) — ---- atlas/finish.wgsl -------------------------------------------------------- (round 102, `gpugen`;
- `forms.wgsl` (770) — ---- atlas/forms.wgsl ----------------------------------------------------- What stands on the ground and …
- `kind-traits.ts` (26) — (round 120, `cities`) A region kind's land as a settlement's purpose sees it (settle/purpose.ts): from … API: `KindTraits`, `kindTraits`.
- `landforms.ts` (149) — Landforms (round 78, branch `places`): the atlas's macro height designed, not left to each region's noise. API: `TIER`, `TIER_NAMES`, `Landform`, `elevation` +2.
- `lod.ts` (202) — The land round the window in rings of less detail (round 83, lod.wgsl; API: `LOD_UNI_BYTES`, `wayBins`, `LodRings`.
- `lod.wgsl` (175) — ---- atlas/lod.wgsl ------------------------------------------------------- The land round the window in …
- `noise.wgsl` (140) — ---- atlas/noise.wgsl --------------------------------------------------- Noise for the atlas (round 67): …
- `patsim.wgsl` (105) — ---- atlas/patsim.wgsl ---------------------------------------------------- The simulated tiles of the …
- `patterns.wgsl` (231) — ---- atlas/patterns.wgsl -------------------------------------------------- The pattern bank (round 67): …
- `regions.ts` (353) — The atlas's regions (round 67): what each region of the partition is — its kind, its ground's parameters, … API: `REGION_WORDS`, `PAT`, `EDGE`, `FORM` +13.
- `rivers.ts` (483) — The atlas's rivers (round 69: "it would be cool to add waterfalls or lava waterfalls" / "And rivers (water … API: `NODE_WORDS`, `RIVER_LAVA`, `RIVER_RUNOFF`, `LAKE_IN` +5.
- `sites.ts` (440) — Sites and roads (round 78, branch `places`): the atlas's superstructure of settlement. API: `SITE`, `SITE_NAMES`, `SETTING`, `SETTING_NAMES` +8.
- `stamps.ts` (136) — ---- atlas/stamps.ts -------------------------------------------------------- (round 102, `gpugen`) What's … API: `OP`, `StampOps`, `applyStamps`.
- `view.wgsl` (131) — ---- atlas/view.wgsl ------------------------------------------------------ The atlas viewer (round 67): …
- `ways.ts` (531) — ---- atlas/ways.ts -------------------------------------------------------- The roads and their crossings … API: `WAY`, `WAY_NAMES`, `WayPoint`, `Lift` +13.

## src/atlas/atlas/

- `build.ts` (364) — Building the atlas (Atlas.build): the GPU passes from the macro height to rivers, lakes, settlements and … API: `run`, `makeCraters`, `makeOddities`, `makeGiants`.
- `columns.ts` (195) — Columns of the atlas's land for a rectangle: on the CPU (columns) or kept on the GPU (columnsGpu), the … API: `columns`, `columnsGpu`, `giantsFor`, `changes`.
- `defs.ts` (224) — The atlas's buffer sizes, tile pacing flags and stamp kinds, its records (Geyser, AtlasStats, … API: `Extra`, `PARAM_BYTES`, `COL_WORDS`, `COLG_BYTES` +37.
- `params.ts` (106) — The atlas's parameters: AtlasParams, their defaults and keys, read from the URL (?a.<key>=). API: `AtlasParams`, `DEFAULT_ATLAS`, `ATLAS_KEYS`, `atlasParamsFrom`.
- `region-land.ts` (141) — A region's land for the streamer: its stamps (craters, vents, ways), its land as intervals (regionLand) or … API: `stampsFor`, `ventsIn`, `waysOf`, `regionLand` +4.
- `regions.ts` (230) — The atlas's regions: the pattern pass and the regions found on the CPU (continents, islands, waters, … API: `patterns`, `regionsCpu`.
- `tile-pacer.ts` (191) — TilePacer: how many streamed tiles of land a frame may make (round 98, adaptive since round 102). API: `TilePacer`.
- `window.ts` (86) — The first window made from the atlas: its map data, height offset, what's outside and the ground. API: `window`.

## src/audio/

- `ambience.ts` (939) — Procedural ecological soundscape (design doc §3). API: `AudioState`, `Ambience`.

## src/build/

- `runs.ts` (190) — (round 128d) Occupancy as runs per cell: the levels a cell holds, as sorted half-open runs [lo, hi), each … API: `Run`, `CellRuns`.
- `town.ts` (427) — The town (round 65, docs/DECISIONS.md: "a townscraper inspired grid and building system"; API: `LEVEL_H`, `TownIO`, `Block`, `Town`.
- `towngrid.ts` (301) — The town's irregular grid (round 65; API: `TownGridOpts`, `CellGrid`, `TownGrid`.

## src/cardlab/

- `entry.ts` (7) — ---- cardlab/entry.ts …
- `main.ts` (434) — ---- cardlab/main.ts …

## src/dialog/

- `dialog.ts` (285) — ---- dialog/dialog.ts ---------------------------------------------------------- The dialog system (round … API: `Speaker`, `DialogOptions`, `DialogBox`.
- `petition.ts` (145) — ---- dialog/petition.ts … API: `PetitionAct`, `Petition`, `PetitionSpeaker`, `PetitionState` +4.
- `portrait.ts` (119) — ---- dialog/portrait.ts … API: `portraitUrl`, `drawPortrait`.

## src/flora/

- `bench.ts` (110) — The flora phone bench (round 119; API: `floraBench`.
- `flags.ts` (6) — (round 117, flora) `?flora=0` draws the plants as before (boxes, or `?meshinst=1`'s four hand-made trees); API: `FLORA`.
- `generate.ts` (222) — One plant from (species, seed) (round 117): the L-system and turtle for the woody plants, the root … API: `generate`, `grassClump`.
- `index.ts` (103) — The flora system (round 117): the contract (api/contracts/flora.ts) over the generators (library, … API: `FloraSource`, `FloraWorld`.
- `library.ts` (134) — The plant library (round 117): every species' variants as meshes, made once from seeds, in the instanced … API: `LibraryKind`, `LibrarySpec`, `GAME_LIBRARY`, `FloraLibrary`.
- `lsystem.ts` (240) — L-systems for trunks and branches (round 117; API: `V3`, `LSystemSpec`, `TurtleSpec`, `Segment` +5.
- `mesh.ts` (243) — Plant meshes from skeletons (round 117). API: `PART`, `FloraMesh`, `MeshBuilder`, `LeafStyle` +2.
- `passability.ts` (76) — Plants as soft barriers (round 117). API: `StandPlant`, `MUST_CUT`, `coverage`, `passage`.
- `placement.ts` (81) — Where plants grow (round 117): "Plants growing on fields". API: `fit`, `Stand`, `standsAt`.
- `rng.ts` (27) — Deterministic randomness for the flora generators (round 117, track `flora`). API: `rng`, `hashSeed`.
- `roots.ts` (165) — Roots by cellular automaton (round 117; API: `RootSpec`, `SoilFn`, `RootGrid`, `growRoots` +3.
- `scene.ts` (250) — Viewer scenes (round 117): a biome laid out on a disc, from a seed — the viewer page's "forest scene" and … API: `Biome`, `BIOMES`, `SceneKind`, `FloraScene` +2.
- `species.ts` (514) — The species: each a set of parameters, nothing hand-modelled (round 117). API: `RGB`, `SpeciesId`, `PlantForm`, `Host` +6.
- `viewer.ts` (494) — The flora viewer page (round 117;
- `viewer.wgsl` (147) — ---- the flora viewer page (round 117;

## src/flow/

- `install.ts` (47) — The flow model in a world (?flow=1, docs/ARCHITECTURE.md "The flow model"): one call, as installPhysics. API: `FlowKit`, `installFlow`.
- `liquid.ts` (305) — Liquids as runs in the columns (?flow=1, docs/ARCHITECTURE.md "The flow model"; API: `LiquidKind`, `Tuned`, `WATER`, `LAVA` +3.
- `steady.ts` (139) — Steady state (?flow=1; API: `STEADY_TOL`, `STEADY_FLOOR`, `STEADY_WIN`, `WAKE_TOL` +2.

## src/fortress/

Fortress mode: the fortress, its economy, pieces, claims, life (workers) and its UI bar; started on a level by scenes/level/fortress.ts.

- `claims.ts` (108) — The fortress's built blocks in the world's columns (round 128d; API: `ClaimsIO`, `FortressClaims`.
- `defence.ts` (202) — The fortress's defence against a wave (round 128l, m4: the attack wave, part B; API: `ARROW`, `swordsOf`, `arrowFlight`, `arrowHits` +3.
- `defs.ts` (152) — The eight first buildings (round 128c, the user's list) and their numbers: a block's cost and what it gives. API: `POWER_RISE`, `DEFS`, `START_STORES`, `ECON` +1.
- `economy.ts` (228) — The fortress's economy (fortress slice 1, milestone 3: "the economy feeds the building"). API: `JobKind`, `JobSlot`, `STORED`, `builtBlocks` +17.
- `follow.ts` (189) — Follow a person (round 128l, m4; API: `Doing`, `PersonFacts`, `nameOf`, `thoughtOf` +3.
- `fortress.ts` (1330) — The fortress (fortress slice 1, milestone 1): the plan (plan.ts) kept as Town blocks (build/town.ts: a … API: `Erased`, `FortressStatus`, `FortressIO`, `Tool` +2.
- `host.ts` (55) — (round 128l, tooling) What the fortress's start (scenes/level.ts startFortress) needs of the world it's … API: `FortressTownRec`, `FortressTownSource`, `FortressWindow`, `FORTRESS_BOX` +3.
- `inspect.ts` (156) — Inspect (round 128d; the user: "Maybe an inspect to highlight a continuous section of structure and see … API: `InspectFacts`, `InspectLive`, `inspectFacts`, `inspectCard`.
- `lanes.ts` (469) — The fortress's roads (round 128k; API: `LaneGrid`, `LaneKind`, `LaneSeg`, `LaneOpts` +13.
- `life.ts` (1590) — The fortress's people (fortress slice 1; API: `LOAD`, `R4`, `FortressLifeIO`, `FortressLife`.
- `pick.ts` (59) — Which block face a tap lands on (round 128d, the user: "Fix the clicking on the side to build next to it. API: `PickCells`, `FaceHit`, `pickFace`, `placeFor`.
- `pieces.ts` (860) — The fortress drawn (fortress slice 1, milestone 1): its plan made into the towns' pieces — the structures … API: `LOOK_GHOST`, `PIECE_PICKED`, `PIECE_WARN`, `PieceInputs` +6.
- `pit.ts` (209) — A quarry's pit as tiers and ramps down its footprint (round 128m, `quarry`, BACKLOG V128-11): the player … API: `PIT_SHELF`, `PIT_RAMP`, `PitTopo`, `PitGeo` +9.
- `plan.ts` (337) — The fortress's plan (fortress slice 1, milestone 1): what the player painted, cell by cell, each cell … API: `typeIndex`, `wallTileOf`, `towered`, `FortressPlan`.
- `quarry.ts` (318) — The miners grow a quarry's pit down, tier by tier (round 128m, `quarry`, BACKLOG V128-11; API: `QuarryIO`, `QuarryDig`.
- `raid.ts` (289) — The attack wave's rules (round 128l, m4: fortress M5-lite, docs/DECISIONS.md round 128l "the attack wave"). API: `RAID`, `LOOT_ORDER`, `waveSize`, `Side` +13.
- `raiders.ts` (748) — The attack wave on the fortress (round 128l, m4: fortress M5-lite; API: `RAID_FACTION`, `RaidIO`, `RaidReport`, `FortressRaid`.
- `reach.ts` (222) — The fortress's reach: what a check asks and answers (the GPU's — reachgpu.ts, shaders/fortreach.wgsl — in … API: `AGENT_H`, `STEP`, `DROP`, `DEEP` +10.
- `reachgpu.ts` (256) — The fortress's reach on the GPU (round 128l, m4; API: `FortressReachGpu`.
- `recipes.ts` (154) — The fortress's recipes (round 128l, m4: fortress slice 1, milestone 4 — "the blacksmith makes weapons from … API: `Recipe`, `RECIPES`, `recipeTakes`, `TrainRoom` +2.
- `shapes.ts` (163) — (round 128d) Painted shapes make landmarks, Townscaper's way: the player paints blocks, and some shapes … API: `COURT_MAX`, `TOWER_LEVELS`, `ShapeGrid`, `Dome` +3.
- `solid.ts` (256) — What of the fortress is solid to the world (round 128d; API: `WALL_HALF`, `WALL_LINTEL`, `SolidInputs`, `RAMPS_ID` +4.
- `townpick.ts` (48) — (round 128e, FT-48; the user: "Inspect doesn't work on the generated town and it should") Inspect's card … API: `townCard`.
- `ui.ts` (388) — The fortress's bar. Planning (time stopped): select what — one of the nine types — then tap to plan it; API: `FortressBarHooks`, `SPEEDS`, `FortressBar`.
- `ways.ts` (506) — The fortress's ways (round 128d; API: `WaysGrid`, `WAY_NONE`, `WAY_ROAD`, `WAY_SQUARE` +13.
- `words.ts` (268) — What the fortress's planning panel says (docs/WRITING.md: plain words, one idea a sentence, numbers of … API: `goodsText`, `givesLines`, `typeCard`, `typeLines` +26.
- `work.ts` (99) — What the fortress's builders owe and have brought (fortress slice 1, milestone 2). API: `Load`, `BuildBook`.

## src/game/

Game rules over the world: powers, Nature, progress, levels, and Integrity (structures that break and fall).

- `blows.ts` (30) — What a blow does to the ground (round 120, the user: "dropping the tanker in a stone does not trigger … API: `groundBlowRadius`, `sinkDepth`, `splitDisplaced`, `softnessOf`.
- `bodies.ts` (422) — Falling pieces (round 14, BACKLOG F7; API: `Body`, `rotate`, `Bodies`.
- `colapply.ts` (475) — (round 120, JB6: "no CPU readback on the hot path") Changes to the GPU's columns made in place … API: `looseFrom`, `fitColumn`, `cutColumn`, `spillPlan` +5.
- `colbodies.ts` (310) — Falling pieces in the columns' own format (round 86). API: `ColPiece`, `FallingBody`, `Landing`, `subtract` +1.
- `colcopy.ts` (244) — (round 120, JB6: "no CPU readback on the hot path") The CPU's copy of the GPU's columns (WorldGpu.layers), … API: `CopyMode`, `CopyHost`, `ColumnCopy`.
- `colquery.ts` (78) — (round 120, JB6: "no CPU readback on the hot path") Small questions asked of the GPU's columns in place … API: `ColumnQuery`.
- `director.ts` (123) — Camera director (DECISIONS round 9): limits on pan/zoom, smooth camera shots, and a step-by-step script … API: `CameraLimits`, `Director`.
- `fracture.ts` (1348) — Structural integrity for structures (round 13/14, BACKLOG F7). API: `Voxel`, `Fracture`, `RunPiece`, `WorldVox` +8.
- `integrity.ts` (768) — Structural integrity and falling pieces (round 14, BACKLOG F7; API: `Integrity`, `GROUND_DUST`, `Grab`.
- `judge.ts` (477) — The collapse judges (round 120, the user: "Can we treat this as an experiment and test each approach side … API: `JudgeColumns`, `JudgeInput`, `JudgeStats`, `RockJudge` +5.
- `levels.ts` (261) — Level registry (BACKLOG C6): every place the player can reclaim, plus the sandbox. API: `LevelModel`, `LevelDef`, `LoadedLand`, `LEVELS` +3.
- `nature.ts` (107) — Gameplay resource (design doc §7). API: `COSTS`, `HARM`, `Nature`, `reclamation` +1.
- `places.ts` (216) — The places API (docs/PLACES.md): `core.places`. API: `Places`, `PlaceRef`.
- `powers.ts` (474) — What the player's gestures do in the world (DECISIONS 2026-10-07, round 6). API: `PowersDeps`, `Powers`.
- `progress.ts` (108) — Persistent progression shown by the menu scene (design doc §4): the best reclamation the player has … API: `loadLevelProgress`, `loadProgress`, `Difficulty`, `DIFFICULTY_LEVEL` +7.
- `reach.ts` (160) — The player's reach on a story level (DECISIONS round 30): the land around the green, by the green's size. API: `MIN_REACH`, `Reach`.
- `rockbodies.ts` (1306) — Rock that breaks free as a rigid body (round 95, `?rockbody=1`, an experiment). API: `V3`, `RB`, `rockbodyFor`, `SUB_DT` +14.
- `rockdraw.ts` (14) — How a moving rock is drawn (round 120): one pose source from its break to its rest (Integrity.rockDraws). API: `rockDrawFor`.
- `trial.ts` (300) — Gate trials (docs/LEVELS.md, "The tools"): the page side of the gate validator (scripts/gates.mjs). API: `GateResult`, `Trial`.

## src/game/integrity/

Integrity's internals, split out of game/integrity.ts: free functions over the Integrity instance (`ig`). Only integrity.ts and these modules call them.

- `columns.ts` (196) — Integrity's writes to the world's columns: a falling body's landing and touch, column writes on the CPU … API: `touch`, `land`, `touchCols`, `writeColumn` +2.
- `defs.ts` (113) — Integrity's flags, budgets and impact tuning (METAL, PASS, READ_NEAR, IMP ...), the Grab type, and the … API: `METAL`, `WOOD`, `METAL_MAX`, `Grab` +14.
- `lattice.ts` (148) — Lattice bodies on the physics voxels: dropped models, the lattice rock, and the blows and wakes they take. API: `dropModels`, `spawnLattice`, `latticeBlows`, `wakeLattice`.
- `loose.ts` (154) — Debris and impacts: the bodies' projection on the ground, the body budget, impacts that break bodies, … API: `resetProjection`, `project`, `keepBudget`, `impact` +3.
- `metal.ts` (220) — Metal (and what bends) on the node solver: taking a fracture's metal, waking a ruin's metal into … API: `takeMetal`, `wakeMetal`, `wakeMetalNow`, `metalBlows` +1.
- `resting.ts` (313) — Resting pieces as External instances: kept with their region, carried by a slide, woken when cut or … API: `carried`, `regionThings`, `restingMass`, `bakeDust` +5.
- `rigid.ts` (424) — Rigid rock bodies: spawning a fallen piece as a body, stepping and drawing them, settling one back into … API: `rockGround`, `spawnRigid`, `stepRigid`, `rockDraws` +8.
- `tick.ts` (414) — Integrity's tick and its analysis pass: what's dirty is read (the columns near, or all), judged into … API: `update`, `wantChunks`, `judgeCols`, `pass` +3.
- `window.ts` (150) — Integrity across the streamed window's moves: settling after a slide, shifting what it keeps in window … API: `settle`, `slid`, `forget`.

## src/game/traits/

- `caps.wgsl` (12) — caps (the game's rule, LW1): what the agents' step honours, derived from the traits each tick (round 85: …
- `heal.wgsl` (19) — heal (the game's rule, LW1): restoration fields heal whom the table lets them.
- `holy_harm.wgsl` (19) — holy_harm (the game's rule, LW1): "healing on undead harms" — what a restoration field would heal, it …
- `look.wgsl` (19) — look (the game's rule, LW1): what the draw shows, derived from the traits each tick.
- `modules.ts` (102) — The game's trait rules (LW1, slice 1: healing vs necromancy). API: `CAP`, `LOOK`, `healModule`, `holyHarmModule` +8.
- `raise.wgsl` (33) — raise (the game's rule, LW1): "raise turns a dead living agent into undead with its role".
- `status.wgsl` (15) — status (the game's rule, LW1): an effect lays a status on (fear, petrification…), unless the unit is immune.
- `typed_damage.wgsl` (27) — typed_damage (the game's rule, LW1): damage of a type, scaled by what the unit is — the resist table …

## src/gm/

- `atlas-facts.ts` (198) — The atlas's facts for the world wiki (GM, docs/GM.md): what a built Atlas knows about its regions, … API: `ATLAS_FACTS_VERSION`, `RegionFacts`, `SiteFacts`, `RoadFacts` +4.
- `gm.ts` (55) — The game master's adapter (round 84, docs/SYSTEMS.md system 9, docs/GM.md). API: `GameMaster`, `FileGM`, `fetchGM`.
- `map-names.ts` (56) — (round 91) The world wiki's names as the atlas map's labels (api/map-labels.ts): the same names the GM's … API: `wikiLabels`.
- `oppcheck.ts` (175) — ---- gm/oppcheck.ts … API: `OppWorld`, `checkOpportunity`, `PREREQ_RELATIONS`, `checkTemplates` +1.
- `situationcheck.ts` (394) — The situation's validator (round 120, `runsit`; API: `SituationWorld`, `situationWorldFrom`, `worldPrint`, `checkSituation` +1.
- `storycheck.ts` (635) — The session story's validator (round 84, docs/GM.md): checks a SessionStory (src/api/contracts/story.ts) … API: `ATLAS_EVENT_KINDS`, `ATLAS_EVENT_KINDS_COMPLETE`, `CONDITION_KINDS_COMPLETE`, `CheckWorld` +3.
- `wiki.ts` (500) — The world wiki (round 84, docs/GM.md): the facts the GM reads, made from the atlas's facts … API: `WIKI_VERSION`, `WikiRegion`, `WikiSite`, `WikiRoad` +4.

## src/gpu/

WebGPU plumbing: device, pipelines and bind-group layouts, CPU timing stats.

- `cpustat.ts` (67) — The main thread's longest steps (round 80, the hitches): each named step's last and worst ms, the perf … API: `CpuStat`, `cpuStats`, `frameSteps`, `spans` +4.
- `device.ts` (87) — WebGPU initialisation and capability detection. API: `UnsupportedError`, `Gpu`, `REQUIRED_STORAGE_BUFFERS_PER_STAGE`, `requestGpu` +2.
- `pages-mode.ts` (98) — Round 107 (`pages`, docs/PAGES.md P2.0-P2.3): how a kernel finds a window chunk's page (common.wgsl colPlace). API: `PageAddr`, `PAGE_ADDR`, `PAGE_TAB_BINDING`, `PAGE_STORAGE_KERNELS` +8.
- `pipeline.ts` (186) — Explicit bind-group-layout helpers. API: `BindKind`, `BindSpec`, `makeLayout`, `makeBindGroup` +9.
- `profiler.ts` (178) — Lightweight instrumentation (design doc §9 "benchmark before escalating"). API: `Profiler`.
- `transfers.ts` (376) — (round 128o, DA-G1) Every GPU data transfer that matters, in one table: each GPU→CPU read, and each … API: `SMALL_BYTES`, `TransferKind`, `TransferRate`, `TransferPlay` +2.

## src/grids/

- `structures.ts` (145) — Structure grids (docs/GRIDS.md): rigid voxel grids over the nature grid, each in its own frame with full … API: `MAX_STRUCTS`, `FRAME_BYTES`, `POOL_VOXELS`, `PROJ_K` +8.
- `systems.ts` (118) — The structure grids' systems (docs/GRIDS.md): the projection the nature grid sees them through, and their … API: `ProjectSystem`, `StructTickSystem`.

## src/hero/

- `path.ts` (239) — ---- hero/path.ts --------------------------------------------------------------- A way round walls (round … API: `PathGround`, `PathOpts`, `canStep`, `clearLine` +1.
- `touchpad.ts` (264) — ---- hero/touchpad.ts ----------------------------------------------------------- A hero's controller for … API: `TouchPad`.
- `walker.ts` (256) — ---- hero/walker.ts ------------------------------------------------------------- A hero on foot (round 88; API: `STEP`, `WalkerOpts`, `Walker`.

## src/inhabitants/

- `install.ts` (94) — Inhabitants in a world (round 117): one call, as installAgents. API: `installInhabitants`, `lifeFocus`, `wilderness`, `abilityHost`.
- `pack.ts` (63) — The species table the GPU reads (inhabitants.wgsl SpeciesTable): fixed regions per species so a kernel … API: `MAX_SPECIES`, `HDR`, `TABLE_VEC4`, `BEHAVIOUR_CODE` +4.
- `paths.ts` (86) — Walk paths for townsfolk (round 117). API: `PATH_NODES`, `PATH_EDGES`, `EDGE_KIND`, `packPaths` +1.
- `presence.ts` (45) — Density and threat per region (round 117): hostile creatures are soft barriers for runs (r117: "transient … API: `GroupSample`, `presence`.
- `rig.ts` (505) — The body generator (round 117, docs/INHABITANTS.md): a species' body plan and parameters → a rig, the … API: `enum`, `MAX_POINTS`, `MAX_SEGS`, `BONE_VERTS` +10.
- `species.ts` (205) — Species presets (round 117): one per body plan and a few variants, as data a level, a run or the viewer … API: `SPECIES`, `speciesTraits`, `PresetName`, `PRESETS`.
- `system.ts` (490) — The inhabitants system (round 117, docs/INHABITANTS.md): a GPU population of creatures with bodies, behind … API: `MAX_GROUPS`, `STATE`, `InhabitantsOpts`, `InhabitantsGpu`.
- `viewer.ts` (229) — The inhabitants viewer (round 117; API: `mountViewer`.

## src/input/

- `controls.ts` (147) — Pointer/keyboard input → intent (DECISIONS 2026-10-07): LMB tap → interact with whatever is under the … API: `ControlHandlers`, `Controls`.

## src/inspector/

- `main.ts` (237) — ---- inspector/main.ts …

## src/lab/

- `lab.ts` (552) — (round 128l, tooling) The behaviour lab: ?level=lab&lab=<recipe> — the game with less world, for scripted … API: `LabSceneIO`, `LabPlan`, `LabSnapshot`, `LAB_SIMS` +2.
- `recipes.ts` (212) — (round 128l, tooling) The behaviour lab's land (?level=lab&lab=<recipe>): a few small deterministic … API: `LabTownSpec`, `LabRecipe`, `LAB_DIMS`, `LAB_MID` +4.
- `town.ts` (71) — (round 128l, tooling) The behaviour lab's town: what the fortress starts from (fortress/host.ts … API: `LabTown`, `stillWindow`.
- `townfixture.ts` (175) — (round 128m, townlab) The user's start town as a lab fixture (?level=lab&lab=town; API: `TOWN_FIXTURE_FORMAT`, `TownFixtureHeader`, `TownFixture`, `TownCapture` +2.
- `view.ts` (44) — (round 128l, tooling) The lab's pieces host: draws the fortress's pieces (fortress/host.ts … API: `LabPiecesView`.

## src/levels/

- `bestiary.ts` (77) — The bestiary (round 117, inhabitants): rolling grass hills, a rocky rise and a pond — ground to watch … API: `generateBestiary`.
- `flowlab.ts` (125) — The flow lab (?flow=1&level=flowlab, docs/ARCHITECTURE.md "The flow model"): the flow model's test scenes … API: `FLOWLAB`, `generateFlowlab`, `setupFlowlab`.
- `noiselab.ts` (40) — The noise lab level (round 111, BACKLOG TG1; API: `generateNoiselab`.
- `playground.ts` (658) — The physics and water playground (round 108, BACKLOG AR8; API: `StationKit`, `Station`, `STATIONS`, `generatePlayground` +1.
- `rocklab.ts` (245) — The rock lab (?level=rocklab, round 92; API: `ROCKLAB_STATIONS`, `ROCKLAB`, `generateRocklab`.
- `traitlab.ts` (69) — The traits lab (?level=traitlab, or "The Traits Lab" on the title screen; API: `TRAITLAB_STATIONS`, `generateTraitlab`.
- `traitstation.ts` (129) — The playground's traits station (LW1): a crowd of the living and the walking dead, a lich, the fallen … API: `TraitStationDriver`, `TraitStation`.
- `trials.ts` (110) — The Trial Grounds (docs/LEVELS.md, build order 1): one obstacle of every kind around a last green spring — … API: `generateTrials`.

## src/living/

- `attachment.ts` (57) — ---- living/attachment.ts … API: `stakes`, `hops`, `attachment`.
- `briar.ts` (141) — ---- living/briar.ts … API: `briarHoldings`, `briarWorld`, `briarEngine`.
- `cast.ts` (259) — ---- living/cast.ts … API: `QUIRKS`, `TRAITS`, `Voice`, `VOICES` +3.
- `dsl.ts` (432) — ---- living/dsl.ts … API: `Ref`, `Value`, `Bind`, `Pred` +13.
- `engine.ts` (957) — ---- living/engine.ts … API: `StoreNeed`, `RewardSpec`, `TemplateDef`, `TierOutcome` +11.
- `horde.ts` (803) — ---- living/horde.ts … API: `VETERANS`, `HORDE_HOOKS`, `CONFLICT_OPS`, `DETOURS` +10.
- `library.ts` (331) — ---- living/library.ts … API: `TEMPLATES`, `droughtArc`.
- `mutations.ts` (94) — ---- living/mutations.ts … API: `setRiverInflow`, `placeStructure`, `adjustStores`, `shiftPower` +3.
- `people.ts` (124) — ---- living/people.ts … API: `PresenterSpec`, `membersOf`, `pickPresenter`, `makePresenter` +2.
- `plain.ts` (9) — ---- living/plain.ts … API: `capitalise`.
- `present.ts` (135) — ---- living/present.ts … API: `things`, `moreWords`, `goodsWords`, `minutesWords` +4.
- `seed.ts` (104) — ---- living/seed.ts … API: `seedStanding`, `seedCohorts`, `voiceOf`, `castAt` +1.
- `traits.ts` (116) — ---- living/traits.ts … API: `UnitSpec`, `unitTraits`, `pawnTraits`, `entityTraits` +5.
- `world.ts` (262) — ---- living/world.ts … API: `DAYS_PER_TURN`, `FullSnapshot`, `FactWorld`, `diffWorld`.

## src/noiselab/

- `columns.ts` (155) — (round 111, BACKLOG TG1) A noise-lab record (lab.ts LabResult) as the world's columns, and as the lab's … API: `ChunkLayout`, `LabColumns`, `labColumns`, `drawPreview` +1.
- `control.ts` (165) — (round 111, BACKLOG TG1) The noise lab in a level: its panel (the tuning editor shell on the lab's … API: `LabWorld`, `LabStats`, `START_PRESET`, `NoiseLabControl`.
- `lab.ts` (212) — (round 111, BACKLOG TG1) The noise lab's GPU runner: a recipe (params.ts) evaluated over a w × h map of … API: `LabResult`, `NoiseLabGpu`.
- `lab.wgsl` (542) — ---- noiselab/lab.wgsl ---------------------------------------------------- The noise lab (round 111, …
- `params.ts` (230) — (round 111, BACKLOG TG1) The noise lab's parameters: a recipe is a stack of LAYERS layer slots and the … API: `LAYERS`, `GENS`, `GEN`, `FIELD_GENS` +22.
- `presets.ts` (134) — (round 111, BACKLOG TG1–TG7) The noise lab's built-in recipes: three of the atlas's biomes rebuilt from … API: `PRESETS`.

## src/opps/

- `dealer.ts` (295) — ---- opps/dealer.ts … API: `ScorePart`, `SCORE_PARTS`, `TierOffer`, `Made` +7.
- `deck.ts` (838) — ---- opps/deck.ts … API: `WorldOp`, `CardOutcome`, `CardDef`, `LabPlace` +14.
- `finish.ts` (38) — ---- opps/finish.ts … API: `finishOpps`.
- `kingdom.ts` (165) — ---- opps/kingdom.ts … API: `Purpose`, `Owner`, `KPlace`, `StackWorldOp` +6.
- `level-opps.ts` (632) — ---- opps/level-opps.ts … API: `LevelOpps`.
- `run.ts` (446) — ---- opps/run.ts … API: `OppRunOptions`, `OppRun`, `VETERANS`.
- `tune.ts` (95) — ---- opps/tune.ts … API: `OPP_TUNING`, `OPP_TUNE`, `DealerTune`, `HordeTune`.
- `words.ts` (123) — ---- opps/words.ts … API: `HeroCard`, `rosterLines`, `IntroFacts`, `introLines` +4.

## src/perf/

- `bench.ts` (616) — Round 101 (bench): the calibration benchmark (`?bench=1`). API: `sleep`, `frame`, `benchGpuUp`, `benchGpu` +23.
- `boot-marks.ts` (29) — (round 112, testspeed) The page's boot as a timeline: each stage's time since navigation start (ms), on … API: `BootMarks`, `bootMark`.
- `framepace.ts` (409) — Round 114 (framepace): the frame pacing probe. API: `clusters`, `PaceSources`, `FramePace`, `startFramePace`.
- `gpumem.ts` (131) — Round 100 (hitchrec): the GPU memory the page holds, buffer and texture bytes alive — every createBuffer / … API: `GpuMemTrack`.
- `hitch-hud.ts` (148) — Round 100 (hitchrec): the hitch recorder's HUD — hitches a minute, the worst ten with their causes, the … API: `HitchHud`.
- `hitch.ts` (521) — Round 100 (hitchrec): the hitch recorder (`?hitch=1`, threshold `?hitchms=20`). API: `Step`, `Hitch`, `HitchOptions`, `HitchRecorder` +3.
- `pagebench.ts` (508) — Round 107 (`pages`, docs/PAGES.md P2.0 M1): what the page-table lookup costs, on the phone. API: `pageBenchMode`, `pageBenchStandalone`, `pageBenchBoot`, `pageBenchDevice` +2.
- `physbench.ts` (328) — The physics phone bench (round 120; API: `physBench`.
- `physsummary.ts` (111) — The physics phone bench's rows and its readable summary (round 120; API: `PhysRow`, `Toggle`, `TIMESTAMP_NOTE`, `PairSummary` +2.
- `placebench.ts` (158) — The placement phone bench (round 128m, townlab; API: `gameIO`, `placeReport`, `placeBench`.
- `readstats.ts` (38) — (round 128n, phonefix; API: `ReadRow`, `startReadStats`.
- `report-io.ts` (93) — Round 101 (bench): getting a report (JSON) off the phone, shared by the hitch recorder's HUD and the … API: `deviceTag`, `stamp`, `downloadJson`, `copyText` +2.
- `start.ts` (54) — Round 100 (hitchrec): `?hitch=1` boots the hitch recorder (hitch.ts), its HUD (hitch-hud.ts) and the GPU … API: `HitchBoot`, `startHitch`.
- `townbench.ts` (356) — The town pan phone bench (round 128g, cityrender; API: `townBench`.

## src/perf/bench/

The parts of the bench, split out of perf/bench.ts: the methods of the Bench class as functions over it (`bn`) and its top-level helpers by concern.

- `ab.ts` (282) — A/B toggles (a system off, the frame's difference) and what the view shows: its state, the systems that … API: `view`, `toggles`, `abPhase`, `ab` +4.
- `defs.ts` (57) — The bench's constants and small helpers: the version and build, the A/B system lists, the probe speeds, … API: `BENCH_VERSION`, `STATE`, `BUILD`, `LAST` +13.
- `device.ts` (191) — What the device is and can do: a fixed GPU workload, upload and readback rates, the device's facts. API: `fixedWorkload`, `ioRates`, `deviceFacts`.
- `pace.ts` (298) — Measuring frames: the pace probe, waiting for the scene to settle, capturing a stretch of frames and … API: `paceProbe`, `paceSettle`, `settle`, `capture` +2.
- `page.ts` (161) — The bench on the page: its mode from the URL, the screen kept awake (the wake lock, re-asked when let go), … API: `benchMode`, `WakeSentinel`, `wakeLock`, `wakeWanted` +7.
- `pages.ts` (451) — The bench's pages, each a load of the level: main, pans, hero, a pan page per zoom (its ramps), the window … API: `mainPage`, `pansPage`, `heroPage`, `panPage` +2.
- `pan-report.ts` (153) — The pan bench's plan and report: the window for a zoom, the zooms and speeds tried, tile steps, the … API: `panWindowFor`, `panPlan`, `tileStepOf`, `paceHeadline` +3.
- `regions.ts` (217) — Region generation and the store timed: fresh spots, generation stage by stage (CPU and GPU), the store's … API: `freshAt`, `regionStages`, `regionStagesGpu`, `makeRegion` +1.
- `report.ts` (203) — The bench's report: every page's results put together, and its summary lines. API: `makeReport`, `summary`.
- `state.ts` (170) — The bench's state between page loads: BenchState and its pages, kept in localStorage and IndexedDB (the … API: `PageSpec`, `BenchState`, `IDB`, `idbP` +9.
- `sweeps.ts` (329) — The bench's sweeps: the fastest pan, each system's GPU cost, tiles, agents, render scales, a warp and a … API: `maxPan`, `systemGpu`, `storm`, `tileSweep` +5.
- `timestamps.ts` (148) — GPU timestamps judged (reliable or not, per mode) and the pan bench's thresholds (PAN_*: speeds, budgets, … API: `judgeTimestamps`, `timestampModes`, `PAN_ZOOMS`, `PAN_MAX_WINDOW` +8.

## src/perf/placebench/

- `diagnose.ts` (114) — (round 128m, townlab) The placement bench's diagnosis, on the game only: on the Pixel 9a every placement … API: `DiagnoseIO`, `Diagnosis`, `diagnose`, `diagnosisLines`.
- `points.ts` (92) — (round 128m, townlab) The placement bench's points (perf/placebench.ts; API: `V2`, `PlacePoint`, `PointsIn`, `RING_DISTS` +1.
- `run.ts` (200) — (round 128m, townlab) The placement bench's run (the user: "build a bench for me to run that places … API: `PlaceBenchIO`, `PlaceRow`, `ArriveRow`, `ARRIVE_R` +3.
- `summary.ts` (62) — (round 128m, townlab) The placement bench's report and its plain summary (docs/WRITING.md: plain words, … API: `reasonOf`, `placeSummary`.

## src/physics/

The physics voxels (one GPU solver), wake, shapes and meshes.

- `install.ts` (55) — Physics in a world (round 49: the level and games built on Reclaimed do it the same way; API: `PhysicsKit`, `installPhysics`.
- `mesh.ts` (303) — Meshes over physics bodies (round 49, F15; API: `SkinMesh`, `SkinLattice`, `latticeFor`, `bindSkin` +3.
- `physics.ts` (906) — Physics voxels (docs/PHYSICS.md): bodies whose every voxel is a particle, one GPU solver for every … API: `PV_CAP`, `FRAG_CAP`, `MAX_BODIES`, `SKIN_TRIS` +7.
- `shapes.ts` (66) — Simple test shapes for the physics playground (docs/PHYSICS.md), in the models' own format … API: `box`, `table`, `girder`, `LINEUP` +2.
- `wake.ts` (200) — Waking the map into physics bodies (round 49: moved out of the level so a game can do it too; API: `STRUCTURAL`, `WakeOptions`, `Waker`.

## src/play/

- `library.ts` (16) — ---- play/library.ts … API: `library`.
- `session.ts` (279) — ---- play/session.ts … API: `SessionDeps`, `PlaySession`, `el`, `tunedParams` +2.
- `testing.ts` (127) — ---- play/testing.ts … API: `PX`, `FakeUnit`, `TestWorld`, `testWorld` +5.
- `world.ts` (135) — ---- play/world.ts … API: `PlayUnits`, `Blow`, `Vehicle`, `PlayWorld` +1.

## src/play/controllers/

- `hoverbike.ts` (134) — ---- play/controllers/hoverbike.ts … API: `BIKE_WEAPONS`, `BIKE_FASTER`, `BIKE_CAMERA`, `BikeParams` +4.
- `lich.ts` (110) — ---- play/controllers/lich.ts … API: `LICH_DEFAULTS`, `LichParams`, `LICH_PARAMS`, `lichProfile` +1.

## src/play/core/

- `aim.ts` (47) — (ported from GameplayGM runtimes/hoverbike/src/aim.ts @ experiment/slice 515fcd9, round 117: the play … API: `Assisted`, `assist`, `lean`.
- `bike.ts` (397) — (round 117: BikeTuning a type, not an interface, so it is a Params record for the play contract) (ported … API: `BikeTuning`, `BIKE`, `Bike`, `HeightAt` +7.
- `chase.ts` (112) — ---- play/core/chase.ts … API: `DEFAULT_CHASE`, `ChaseView`, `reach`, `reachAlong` +3.
- `fling.ts` (97) — (ported from GameplayGM runtimes/hoverbike/src/fling.ts @ experiment/slice 515fcd9, round 117) Intent → … API: `FlingBudget`, `FLING_ASSIST`, `FlingScene`, `FlingPlan` +2.
- `gestures.ts` (83) — (ported from GameplayGM runtimes/hoverbike/src/gestures.ts @ experiment/slice 515fcd9, round 117: the play … API: `Pt`, `TOUCH`, `Gesture`, `Stroke`.
- `intent.ts` (101) — (ported from GameplayGM runtimes/hoverbike/src/intent.ts @ experiment/slice 515fcd9, round 117: the play … API: `V3`, `V2`, `Intent`, `Candidate` +7.
- `intercept.ts` (182) — (ported from GameplayGM runtimes/hoverbike/src/intercept.ts @ experiment/slice 515fcd9, round 117: the … API: `Rider`, `PassTarget`, `PassBudget`, `ASSIST` +7.
- `levitate.ts` (96) — (ported from GameplayGM runtimes/hoverbike/src/levitate.ts @ experiment/slice 515fcd9, round 117: the play … API: `LevitateTuning`, `LEVITATE`, `stepLevitate`.

## src/play/draw/

- `shapes.ts` (126) — ---- play/draw/shapes.ts … API: `V3`, `Q`, `Voxels`, `Part` +13.
- `voxels.ts` (69) — ---- play/draw/voxels.ts … API: `VoxelDraw`.

## src/play/heroes/

- `base.ts` (162) — ---- play/heroes/base.ts … API: `PlayIntent`, `Hit`, `Target`, `UNIT_HEIGHT` +1.
- `bike.ts` (365) — ---- play/heroes/bike.ts … API: `SLASH`, `LANCE`, `TRAIL`, `intents` +1.
- `hook.ts` (269) — ---- play/heroes/hook.ts … API: `HookParams`, `DRAG`, `ALONGSIDE`, `Hook`.
- `lich.ts` (588) — ---- play/heroes/lich.ts … API: `MOVE`, `FLOAT_PER_PX`, `PICK`, `LIFT` +6.
- `make.ts` (29) — ---- play/heroes/make.ts … API: `PlayHeroId`, `heroes`, `makeHero`.

## src/play/input/

- `controls.ts` (226) — ---- play/input/controls.ts … API: `Controls`.
- `read.ts` (77) — ---- play/input/read.ts … API: `ReadView`, `readInput`, `gapToSegment`.
- `types.ts` (63) — ---- play/input/types.ts … API: `Drag`, `Act`, `PlayInput`, `NO_INPUT` +3.

## src/play/sandbox/

- `hills.ts` (72) — ---- play/sandbox/hills.ts … API: `Height`, `HillOpts`, `HillSpot`, `findHills`.
- `rival.ts` (71) — ---- play/sandbox/rival.ts … API: `LAP`, `Rival`.
- `sandbox.ts` (295) — ---- play/sandbox/sandbox.ts … API: `SandboxDeps`, `PlaySandbox`.

## src/render/

Drawing: the camera, the renderer (render-prep, the draw passes, shadows), the field mesh, tiles, the turn and the pick.

- `band.ts` (168) — The band outside the window (round 79, the user: "Why not stream vertical identical to lateral … It will … API: `OutsideBand`.
- `bgcheck.ts` (262) — Round 112 (bgcheck): how much of the screen shows the background — the world pass's clear colour, where … API: `FAR_PICK_TAG`, `BGCHECK`, `BgTotals`, `BgShares` +2.
- `bodymesh.ts` (168) — Bodies' own meshes (round 120, the user: "it switches for rendering as voxels. API: `MeshPose`, `BodyMeshes`.
- `bodymeshbuild.ts` (117) — A body's own mesh (round 120, the user: "Rendering and simulation should not be coupled that way" — one … API: `BM_VERT`, `MeshCell`, `MeshBind`, `buildBodyMesh`.
- `camera.ts` (317) — Fixed-angle orthographic isometric camera (design doc §14). API: `Mat4`, `CAMERA_BYTES`, `CAMERA_POS_OFFSET`, `CAMERA_CUT_OFFSET` +5.
- `coverage.ts` (189) — Round 113 (`tilesfirst`; API: `CoverView`, `Coverage`, `coverage`.
- `fieldmesh.ts` (906) — The field mesh (G13 h; API: `READBACK`, `REGION_BYTES`, `MESH_POOL`, `MeshSource` +1.
- `meshinst.ts` (100) — The instanced mesh renderer (round 99, `?meshinst=1`; API: `MI_CAP`, `MI_STRIDE`, `MI_ARGS_WORD`, `MeshInstances`.
- `renderer.ts` (964) — Renderer: render-preparation compute pass (world → box instances) followed by one render pass (opaque … API: `Renderer`, `SKIP`, `PickHit`, `RenderOptions`.
- `rockmesh.ts` (398) — The rigid rock's own mesh (round 95, `?rockbody=1`; API: `BUILD_FRAMES`, `RockDraw`, `RockMesh`.
- `shore.ts` (88) — The shore field (round 83, shore.wgsl): the nearest shore point to every column, by jump flooding over the … API: `ShoreField`.
- `tilecache.ts` (1358) — The world-anchored tile cache (round 103, ?tiles=1; API: `LandMaker`, `MOVING`, `Part`, `Size` +5.
- `tilecalib.ts` (174) — The tiles' calibration to the hardware and the screen (round 115, `tilecal`; API: `FloorInput`, `FloorOut`, `floorSearch`, `TileCalibration`.
- `tileland.ts` (37) — The render-only land's shared types (round 104 TC2; API: `TileLandSource`, `LandTimes`.
- `tilelandgpu.ts` (440) — Render-only land for the tile cache with nothing read back (round 105, `tilelatency`; API: `TileLandGpuSource`, `TileLandGpuHost`, `TileLandGpu`.
- `tileworld.ts` (126) — A render-only tile's world (round 108, TC18; API: `TileWorld`.
- `treemesh.ts` (113) — Tree meshes for the instanced mesh renderer (round 99, `?meshinst=1`; API: `MeshKind`, `treeKinds`.
- `turn.ts` (88) — (round 90, the user on the phone: "add a button or bar to rotate the camera") The player's turn of the … API: `TURN_STEP`, `Turn`.
- `watersurf.ts` (65) — (watersurf, FC2) The window's water drawn as one surface, not a prism a wet column. API: `WaterSurface`.

## src/render/renderer/

The Renderer's internals, split out of render/renderer.ts: free functions over the renderer (`rd`). The constructor still builds most pipelines; `mesh-draws.ts` builds the field mesh's.

- `defs.ts` (83) — The renderer's sizes, formats and URL flags (CAM_BYTES, SHADOW_SIZE, TILES, SKIP ...), its public types … API: `CAM_BYTES`, `SHADOW_SIZE`, `SHADOW_FORMAT`, `ShadowViews` +21.
- `encode.ts` (371) — A frame's draw: render-prep (instances grown as needed), the terrain cache or the G-buffer, shadows, the … API: `encode`, `encodeCeiling`, `syncInst`, `syncMeshPool`.
- `features.ts` (93) — Optional draws turned on after construction: the outside band, the rock mesh, structures. API: `enableBand`, `enableRockMesh`, `enableStructures`, `structGroups`.
- `gbuffer-shadow.ts` (228) — The deferred mesh's G-buffer pass and the sun's shadow map (its light camera, what's due: all or the … API: `encodeGBuffer`, `writeLight`, `encodeShadow`.
- `grid.ts` (84) — The grid of mesh chunks drawn: culling chunks to the view and the sun, drawing the visible, and what moved … API: `windowMoved`, `windowDrawn`, `gridCull`, `drawGrid` +1.
- `mesh-draws.ts` (282) — The field mesh's draws, made once by the Renderer's constructor when the mesh is on: its draw and depth … API: `buildMeshDraws`.
- `terrain-cache.ts` (177) — The terrain cache: the field mesh drawn once to a cached G-buffer and reused while the camera holds still … API: `terrainCacheMode`, `tcPrepare`, `tcPipesMake`, `encodeTerrainCache`.

## src/run/

- `hud.ts` (71) — ---- run/hud.ts ---------------------------------------------------------------- What to do now (round … API: `ObjectiveHud`.
- `run.ts` (277) — ---- run/run.ts ---------------------------------------------------------------- A run of a SessionStory … API: `RunOptions`, `StoryRun`.
- `validate.ts` (206) — ---- run/validate.ts ----------------------------------------------------------- A SessionStory checked … API: `StoryError`, `validateStory`.

## src/runplan/

- `affords.ts` (52) — ---- runplan/affords.ts … API: `Affordances`, `affordances`.
- `clock.ts` (25) — ---- runplan/clock.ts … API: `RunClock`.
- `consequences.ts` (314) — ---- runplan/consequences.ts … API: `HERO_NAMES`, `StageContext`, `stageOutcomes`, `failureRules` +5.
- `graph.ts` (138) — ---- runplan/graph.ts … API: `GraphNames`, `AtlasGraphLike`, `BARRIER_RANK`, `torusDelta` +5.
- `heroes.ts` (49) — ---- runplan/heroes.ts … API: `ROLES`, `heroProfile`, `heroCaps`, `borderCost`.
- `level-run.ts` (382) — ---- runplan/level-run.ts … API: `LevelRunDeps`, `LevelRun`.
- `plan.ts` (351) — ---- runplan/plan.ts … API: `STAGE_MINUTES`, `LEG_EFFORT`, `PlanOptions`, `GraphRunPlanner` +1.
- `play-adapter.ts` (73) — ---- runplan/play-adapter.ts … API: `barrierGround`, `capsFromProfile`.
- `requests.ts` (98) — ---- runplan/requests.ts … API: `STAGE_HALF`, `OBSTACLE`, `asksFor`, `stageRoom` +3.
- `rng.ts` (20) — (round 117, runplan) A small seeded random (mulberry32): plans are deterministic from the seed, the run … API: `hashStr`, `rng`.
- `route.ts` (86) — ---- runplan/route.ts … API: `Reach`, `enters`, `reach`, `routeTo`.
- `travel.ts` (145) — ---- runplan/travel.ts … API: `enRoute`, `Precacher`, `JourneyState`, `along` +1.
- `viewer-text.ts` (20) — (round 117, runplan) An outcome's effects as a line of text (the viewer and the level's run card). API: `describe`.
- `viewer.ts` (652) — ---- runplan/viewer.ts … API: `RunPlanView`.

## src/runplay/

- `course.ts` (106) — ---- runplay/course.ts … API: `P2`, `CourseOpts`, `Course`, `prominence` +2.
- `notice.ts` (132) — ---- runplay/notice.ts … API: `SIGNPOSTED`, `signposted`, `onScreen`, `GateNotice` +2.
- `player.ts` (90) — ---- runplay/player.ts … API: `PlayerDeps`, `RunPlayer`.
- `riders.ts` (153) — ---- runplay/riders.ts … API: `GATE_R`, `Racer`, `Quarry`.
- `rules.ts` (193) — ---- runplay/rules.ts … API: `StageKind`, `StageSpec`, `stageKind`, `stageSpec` +4.
- `stage.ts` (477) — ---- runplay/stage.ts … API: `StageResult`, `StageDeps`, `StagePlay`.

## src/runsit/

- `area.ts` (830) — ---- runsit/area.ts … API: `EDGE_S`, `EDGE_CELLS`, `ENTRY_R`, `THERE` +4.
- `fill.ts` (274) — ---- runsit/fill.ts … API: `FillOptions`, `situationMap`, `fillSituation`.
- `finale.ts` (106) — ---- runsit/finale.ts … API: `FIRE_EVERY`, `BREACH_MAX`, `FALL_AT`, `HOLD_S` +6.
- `finish.ts` (44) — ---- runsit/finish.ts … API: `finishSituation`.
- `followers.ts` (77) — ---- runsit/followers.ts … API: `UnitFollowers`.
- `gm.ts` (53) — ---- runsit/gm.ts … API: `writtenSituations`, `situationFor`.
- `items.ts` (93) — ---- runsit/items.ts … API: `ITEMS`, `emptyLoadout`, `slotsOf`, `displaced` +5.
- `level-sit.ts` (500) — ---- runsit/level-sit.ts … API: `SettlementsView`, `LevelSitDeps`, `LevelSit`.
- `state.ts` (403) — ---- runsit/state.ts … API: `V2`, `TRAVEL_PACE`, `LEVY_PACE`, `LEG_MIN` +16.

## src/scenes/

Scenes and the live world: WorldCore (one live world), the level and the menu, the streamer (the sliding window), the planner, the region pool and copier.

- `atlas-view.ts` (361) — The atlas viewer (round 67): `?atlas=view` (and `?a.<param>=` for the atlas's parameters). API: `AtlasView`.
- `frame-cap.ts` (15) — (round 128o, DA-B5; DESIGN.md §24, decided 2026-11-05: "Cap at 30 fps while building or paused" — the … API: `CAP_FPS`, `frameDue`.
- `hybrid.ts` (362) — The hybrid renderer's choice (?hybrid=1, the atlas level): which of the window's mesh chunks are voxels — … API: `HybridStats`, `HybridChunks`.
- `level.ts` (698) — The playable valley: world + diegetic powers + HUD + level goal. API: `LevelOptions`, `worldSaveOf`, `LevelScene`.
- `menu.ts` (355) — Main menu (design doc §4): a small live diorama — a skull in barren soil — whose state reflects persistent … API: `MenuScene`.
- `planner.ts` (124) — Round 113 (`tilesfirst`, the streaming design's step 4 — https://claude.ai/artifact/UnqDENhSKGH1abe7pxWiNh; API: `PlanSource`, `Plan`, `StreamPlanner`.
- `pool-victim.ts` (38) — (merge122) The region pool's eviction choice, out of the Streamer so it is tested on its own … API: `VictimQuery`, `poolVictim`.
- `range.ts` (63) — (round 90, the user on the phone: "can we increase the range of tiles that load" … "have a setting for how … API: `RANGES`, `PHONE_RANGE`, `DESKTOP_RANGE`, `atlasRange` +3.
- `region-copy.ts` (181) — Round 104 (`slidehitch`): rectangles of u32 words moved between buffers by a compute kernel, one dispatch … API: `Rect`, `RegionCopier`.
- `region-pool.ts` (67) — The GPU region pool (round 100, `regionstore`; API: `PoolSlot`, `RegionPool`.
- `streamer.ts` (792) — The streamed world (round 66, BACKLOG Q28): the live world is a window of W × H columns onto land without … API: `settleLoose`, `Streamer`, `REGION`, `STREAM_OLD` +14.
- `world-core.ts` (636) — Everything a live world needs, independent of what the scene does with it: GPU state, simulation, … API: `Quality`, `Host`, `Scene`, `WorldCore`.

## src/scenes/level/

LevelScene's internals, split out of scenes/level.ts: free functions over the scene (`scene`). Only level.ts and these modules call them.

- `atlas-controls.ts` (225) — The atlas level's own controls and world: its buttons (map, new world), the terrain system over the atlas, … API: `atlasControls`, `terrainSystem`, `worldAt`, `worldEventHere` +1.
- `attach-tools.ts` (181) — The level's tools, wired once at attach: the HUD and the powers (their probes of the world), the animals … API: `attachTools`.
- `attach.ts` (93) — LevelScene.attach: wires a made level to the page once — the HUD and powers, the sandbox's tools, the … API: `attach`.
- `camera-moves.ts` (173) — Scripted and keyed camera motion: the drive and pan benches (?drive, ?pan), the free flyer's keys, and the … API: `driveOn`, `panOn`, `flyKeys`, `turnControls` +2.
- `flags.ts` (37) — The level's URL flags and constants (read once at load): test and comparison switches (?cutaway, ?planner, … API: `NON_METAL`, `CUTAWAY`, `PLANNER_OFF`, `COARSE_PARTS` +10.
- `fortress.ts` (470) — Fortress mode on the level: making the fortress, its life, claims and bar for a town, Skip to done, taps … API: `startFortress`, `pitView`, `skipFrame`, `fortressAt` +4.
- `frame.ts` (529) — The level's frame: camera input, the planner and the window's slide, the world's systems, the sim's ticks, … API: `levelFrame`, `planFrame`, `lifeFrame`, `ceilingFrame` +1.
- `impacts.ts` (298) — The sandbox's world-changing tools: meteors and their impacts, volcano vents, dropped bodies, the heat … API: `meteorAtPick`, `stepMeteors`, `impact`, `bowlVolume` +7.
- `input-wiring.ts` (209) — The level's pointer and key input: Controls' taps, drags, pinches and wheel routed to the powers, the … API: `wireInput`.
- `labs.ts` (205) — The test beds on the level: the tuning panel, bug report and stations bar (level.lab, ?tunepanel=1), the … API: `mountLab`, `mountNoiseLab`, `labStationKit`, `traitStationDriver` +1.
- `runs.ts` (253) — Starting the game layers a URL asks for on the level: the play sandbox (?play), a situation or planned run … API: `startPlay`, `playRaise`, `startSituationRun`, `useRiverWorld` +3.
- `sandbox-tools.ts` (230) — The sandbox editor's brush tools: layer edits and pours, the break tool, the brush ring, undo, and the … API: `editTool`, `pickSmash`, `smashAt`, `drawRing` +4.
- `stream-setup.ts` (373) — The level's world over time, set up once at attach: sleep for a fixed map's held rivers, and for a … API: `attachStream`.
- `test-api.ts` (226) — window.reclaimed: the test and console API over the live level (scripts/*.mjs drive the game through it). API: `testApi`, `exposeTestApi`.
- `town-fixture.ts` (45) — (round 128m, townlab) The window round the start town as the lab's fixture (src/lab/townfixture.ts): read … API: `captureTownFixture`.
- `town-tools.ts` (149) — The sandbox's town tool: picking blocks of the editor's town, the plan outline, placing rectangles, and … API: `editorTown`, `townPick`, `townAtPick`, `sendBuilders` +3.
- `valley-reads.ts` (57) — (round 128o, DA-B5; DESIGN.md §24) The sandbox valley's timed reads of the GPU, in one place: what the … API: `ValleyReadsIO`, `ValleyReads`.
- `valley.ts` (264) — The story valley's rules and feel: the green's reach, the opening and the intro, the goal's completion, … API: `refreshReach`, `confineToReach`, `openValley`, `runIntro` +3.
- `world-api.ts` (11) — (round 128n, phonefix; API: `worldApiOf`.

## src/scenes/streamer/

The Streamer's internals, split out of scenes/streamer.ts: free functions over the streamer (`S`). Its public API stays on the class.

- `defs.ts` (343) — The streamer's definitions: its URL flags and sizes (REGION, TIER ...), the public types (LandSource, … API: `REGION`, `SLIDE_SKIP`, `LEAD`, `STREAM_OLD` +44.
- `freeze.ts` (250) — Freezing regions that leave the window and their bodies: copying a region's columns, fields and textures … API: `copyOut`, `copyIn`, `toBody`, `fromBody` +5.
- `generate.ts` (334) — New land: a region generated (on the GPU or the CPU), cut to the window's depth, brought up to date with … API: `generate`, `generateGpu`, `genHash`, `compareGen` +5.
- `jobs.ts` (147) — The regions' jobs and the pool: a slot for each region made ahead or thawed, evicting what's not needed, … API: `slotFor`, `evict`, `slotHeld`, `ready` +4.
- `keep.ts` (45) — (round 128m, townlab) What the window keeps (Streamer.keep; API: `KeepRect`, `keepHeld`, `keepAllows`, `boxInWindow`.
- `regions.ts` (122) — Region geometry in the window's ring: a region's slots, its columns' and textures' rectangles, which … API: `regionSlots`, `regionIdx`, `regionOutside`, `regionOf` +8.
- `slide.ts` (310) — The slide: following the camera (update, track), waiting for the regions coming in, and the slide itself — … API: `update`, `slideWhenReady`, `track`, `doneAfter` +1.
- `store.ts` (315) — Keeping regions: what's saved to the region store (hashed against the generator's, so unchanged land isn't … API: `saveItem`, `fillAt`, `flushFills`, `check` +8.
- `warp.ts` (169) — Jumps: the window moved far at once (warp: everything re-made where it lands) and up or down (slideZNow, … API: `warp`, `slideZNow`.
- `write.ts` (241) — Writing a region into the window: its columns into the chunk pages, its fields and textures, its relief; API: `write`, `writeNow`, `blankBuf`, `zeros` +4.

## src/settle/

Settlements: towns and cities on the atlas, their plans, the view that draws them, ships.

- `catalogue.ts` (91) — The recipe content (data/recipes/, round 88) read into the contracts' shapes (recipe.ts), and the civ … API: `CivLook`, `CivEntry`, `MATERIALS`, `voxelOf` +9.
- `debug.ts` (125) — ?towndebug=1 (round 88): the live settlement's grids and jobs over the view — its districts' cells (the … API: `TownDebug`.
- `field.ts` (117) — A growth field (round 89): the user — "vegetation and settlements should work similarly actually. API: `GrowthOpts`, `GrowthField`.
- `grids.ts` (452) — A settlement's districts as overlay grids (round 88, BACKLOG R6; API: `Pt`, `rand`, `Lot`, `radialPolys` +5.
- `life.ts` (507) — A settlement in play (round 88; API: `R`, `LiveSpot`, `LiveSite`, `LifeIO` +4.
- `onscreen.ts` (98) — (round 128g, cityrender) Which settlements are drawn as pieces, and which are made ready — by the screen, … API: `SHOW`, `HIDE`, `BUILD`, `DROP` +5.
- `plan-worker.ts` (111) — (round 94) A settlement planned off the main thread for the land past the window (settlements.ts … API: `FarPlanInit`, `FarPlanJob`, `FarPlanDone`, `ExactPlanJob` +1.
- `plan.ts` (967) — A settlement realised (round 88, arrival scale; API: `Iv`, `ColumnPlan`, `Spot`, `SiteSpec` +17.
- `purpose.ts` (122) — What a settlement is for (round 120, `cities`; API: `PURPOSES`, `PurposeFacts`, `purposeScores`, `purposeOf`.
- `raster.ts` (134) — A settlement's plan as the land past the window draws it (round 94; API: `rasterPlan`, `stampMatch`.
- `records.ts` (98) — The settlements' records from the world wiki (round 88): one per atlas site, with the wiki's stable id … API: `OUTLAWS`, `SettlementSeed`, `recordsFrom`.
- `settlements.ts` (873) — The settlements system (round 88; API: `DAY_S`, `SettlementEvents`, `LiveIO`, `FarIO` +1.
- `ships.ts` (306) — Ships between the ports (round 120, `cities`; API: `SeaChart`, `ShipRoute`, `SEA_DEPTH`, `shipRoutes` +3.
- `shipsview.ts` (56) — The sailing ships as the player sees them (round 120, `cities`; API: `ShipsIO`, `ShipsView`.
- `story.ts` (98) — A settlement's story (round 120, `cities`; API: `StoryFacts`, `storyOf`.
- `thing.ts` (80) — (round 128e, FT-48; the user: "Inspect doesn't work on the generated town and it should") What a town has … API: `TownThing`, `townThingAt`.
- `view.ts` (400) — The settlements as the player sees and touches them (round 119: "have them actually use the new … API: `ViewIO`, `SettlementsView`.

## src/shaders/

WGSL. `common.wgsl` (+ layers, materials) is prepended to every kernel; flow/slope appended to kernels that declare them.

- `agents.wgsl` (464) — ---- agents (round 52, docs/AGENTS.md) ----------------------------------------- The layer units walk on, …
- `bodymesh.wgsl` (79) — Bodies' own meshes, skinned (round 120;
- `climate.wgsl` (135) — ---- climate: snow, ice, fallen leaves (round 50;
- `colapply.wgsl` (597) — ---- colapply.wgsl …
- `colquery.wgsl` (59) — ---- colquery.wgsl …
- `common.wgsl` (828) — ---- common.wgsl ------------------------------------------------------- Shared by every shader.
- `contamination.wgsl` (75) — ---- contamination system ---------------------------------------------- Two scalar fields per column: x = …
- `cover.wgsl` (166) — ---- the weather's cover past the window (round 108, TC20;
- `coverfield.wgsl` (16) — ---- the weather's cover past the window: the field's shape (round 108, TC20;
- `ecology.wgsl` (93) — ---- ecology / succession ------------------------------------------------- veg = continuous succession …
- `edit.wgsl` (475) — ---- editor brush (sandbox;
- `fieldmesh.wgsl` (887) — ---- field mesh (G13 h) ----------------------------------------------------------- The terrain drawn as …
- `fire.wgsl` (122) — ---- fire ------------------------------------------------------------------- fire[i] = burning intensity …
- `florafield.wgsl` (63) — ---- plants placed by the world's other fields (round 117, flora) …
- `floralook.wgsl` (73) — ---- the flora library's look and wind (round 117;
- `floraput.wgsl` (55) — ---- placing a flora library plant (round 117;
- `flow.wgsl` (21) — ---- flow.wgsl ----------------------------------------------------------------- Net water flow through a …
- `fortreach.wgsl` (261) — ---- the fortress's reach on the GPU (round 128l, m4;
- `grids.wgsl` (40) — ---- structure grids (docs/GRIDS.md) ----------------------------------------- Rigid voxel grids over the …
- `inhabitants.wgsl` (934) — Inhabitants (round 117, docs/INHABITANTS.md;
- `judge.ts` (11) — Judge B, the method of sections on the GPU, in parts (2026-11-04, the monolith split; API: `judgeWgsl`.
- `landbrush.wgsl` (225) — ---- landform brushes (round 64, docs/DECISIONS.md: "paint mountain ranges and mesas and have them rise …
- `lava_flux.wgsl` (53) — ---- lava (molten rock): flux pass (docs/PHYSICS.md "Lava") ------------------- The same virtual pipes as …
- `lava.wgsl` (499) — ---- lava (molten rock): heat, melting, setting, vents (docs/PHYSICS.md "Lava") -- One material for the …
- `layerpull.wgsl` (155) — ---- layer pulls (round 52, BACKLOG E2;
- `layers.wgsl` (29) — ---- layers.wgsl ------------------------------------------------------- Chunked column-slot addressing …
- `liquid.wgsl` (852) — ---- liquid.wgsl: liquids as runs in the columns (?flow=1;
- `materials.wgsl` (55) — ---- materials.wgsl ---------------------------------------------------- Mirrors src/world/materials.ts …
- `meshdraw.wgsl` (563) — ---- field mesh draw (G13 C, a prototype: fieldmesh.wgsl) ---------------------- The mesh's vertices are …
- `meshinst.wgsl` (122) — ---- instanced meshes (round 99, ?meshinst=1;
- `meshregion.wgsl` (84) — ---- the field mesh's layout (G13 h: fieldmesh.wgsl) ---------------------------- The whole map drawn as a …
- `meshsource.wgsl` (102) — ---- (round 113, `tilesfirst`, the streaming design's step 5.1) the mesh's look's sources …
- `meshstate.wgsl` (13) — ---- the field mesh's state: its published layout (round 83) ------------------ The field mesh …
- `moisture.wgsl` (40) — ---- soil moisture field ------------------------------------------------- Wetted by rain and …
- `oil_depth.wgsl` (66) — ---- oil (second liquid): depth pass ---------------------------------------- Applies oil flux.
- `oil_flux.wgsl` (46) — ---- oil (second liquid): flux pass ------------------------------------------ Same virtual-pipes model as …
- `particles_draw.wgsl` (256) — ---- particles (drawing) ----------------------------------------------------- One screen-aligned square …
- `particles.wgsl` (1051) — ---- particles (simulation) ------------------------------------------------ A fixed-capacity ring of GPU …
- `phys.wgsl` (1043) — ---- physics voxels (docs/PHYSICS.md) ------------------------------------------ Every voxel of a physical …
- `placeop.wgsl` (48) — ---- ops masked to a place (docs/PLACES.md step 1;
- `project.wgsl` (201) — ---- structure → nature projection (docs/GRIDS.md) ----------------------------- What the nature grid sees …
- `rain.wgsl` (83) — ---- rain streaks ----------------------------------------------------------- Purely visual.
- `render.ts` (14) — The renderer's draw shader, in parts (2026-11-04, the monolith split; API: `renderWgsl`.
- `renderfields.wgsl` (240) — ---- render fields (render preparation) --------------------------------------- One packed vec4 per column …
- `renderprep.wgsl` (325) — ---- visibility / render preparation -------------------------------------- Turns world state into box …
- `riverheld.wgsl` (69) — ---- riverheld.wgsl (round 84, ?rivers=table) --------------------------------- The atlas's rivers at …
- `roadride.wgsl` (378) — ---- the agents ride the roads (round 128i, V128-14) …
- `roadstamp.wgsl` (84) — ---- the agents' road bits stamped from shapes (round 128i, FT-58: roads narrower than a cell) …
- `rockmesh.wgsl` (302) — ---- the rigid rock's mesh (round 95, render/rockmesh.ts;
- `sediment.wgsl` (984) — ---- sediment: the loose ground in the layers ---------------------------------- (round 11 drifts → round …
- `settlehold.wgsl` (57) — ---- settlehold.wgsl …
- `shore.wgsl` (60) — ---- shore field (round 83) --------------------------------------------------- The nearest shore to every …
- `slope.wgsl` (20) — ---- slope.wgsl ---------------------------------------------------------------- Local ground steepness: …
- `solver.wgsl` (1274) — ---- solver.wgsl: the one node solver (BACKLOG AR4;
- `stats.wgsl` (54) — ---- aggregate stats (gameplay / audio / HUD read these) ------------------ Fixed-point sums via …
- `structgame.wgsl` (119) — ---- structures in the game (round 117, `structures`;
- `structmesh.wgsl` (298) — ---- structures: warped module instances (src/structures/gpu.ts;
- `structprep.wgsl` (65) — ---- structure grids → draw instances (docs/GRIDS.md) -------------------------- One thread per voxel of …
- `structtick.wgsl` (123) — ---- structure grids: their own tick (docs/GRIDS.md) --------------------------- One thread per voxel of …
- `structure.wgsl` (277) — ---- structural system ------------------------------------------------------ Simplest systemic structural …
- `surface.wgsl` (95) — ---- surface system ---------------------------------------------------- Derives the per-column views …
- `sway.wgsl` (37) — ---- vegetation sway (render-only state) ------------------------------------ One damped spring per …
- `tcache.wgsl` (36) — ---- the terrain's cached layer (perfopt, ?tcache=N;
- `terrainshape.wgsl` (185) — ---- terrain shape: smooth soft surfaces (round 10, BACKLOG A15;
- `tiers.wgsl` (20) — ---- the sims' tiers (round 108, simtiers: sim/tiers.ts, api/contracts/simtiers.ts) …
- `tilelandgpu.wgsl` (101) — ---- a render-only tile's bake, set up on the GPU (round 105, tilelatency;
- `tiles.wgsl` (417) — ---- the world-anchored tile cache (round 103, ?tiles=1;
- `townstamp.wgsl` (119) — ---- the town's columns (round 65, build/town.ts) --------------------------- The town is real matter: its …
- `treequery.wgsl` (107) — ---- treequery.wgsl …
- `units.wgsl` (827) — ---- agents: the units (round 52, docs/AGENTS.md) ------------------------------ One thread a unit …
- `vegplan.wgsl` (64) — ---- vegetation layout (shared) ------------------------------------------- Where trees and shrubs stand …
- `vegprep.wgsl` (409) — ---- vegetation render preparation ------------------------------------------ Emits instances for plants …
- `water_depth.wgsl` (91) — ---- water transport: depth pass --------------------------------------- Applies flux, rain, springs and …
- `water_flux.wgsl` (59) — ---- water transport: flux pass --------------------------------------- Column-volume "virtual pipes" model.
- `watersurf.wgsl` (106) — ---- (watersurf, FC2) the water's top as a surface: the lattice of the wet columns' centres …
- `wilt.wgsl` (124) — ---- wilt: plant health and tap responses (diegetic clues;
- `windfield.wgsl` (147) — ---- wind field --------------------------------------------------------------- The one wind field …

## src/shaders/judge/

- `build.wgsl` (360) — build.wgsl: the pairs, build (a thread a window column), adjacency, the workgroup's sums (part 2 of 5 of …
- `defs.wgsl` (236) — defs.wgsl: the layout, records and helpers (part 1 of 5 of the judgeWgsl shader, joined in order by …
- `pieces.wgsl` (406) — pieces.wgsl: judge, pieces and pieceFlags, seedList, the pairs on the whole GPU (part 3 of 5 of the …
- `release.wgsl` (507) — release.wgsl: judge3 (the release), freedUnite, judge4 (the freed pieces, necks, records) (part 5 of 5 of …
- `sections.wgsl` (391) — sections.wgsl: faces, judge2: the sections, thrust lines, release, pieces out (part 4 of 5 of the …

## src/shaders/render/

- `bodies.wgsl` (172) — bodies.wgsl: rigid bodies, skinned meshes, drape and strata (part 7 of 7 of the renderWgsl shader, joined …
- `common.wgsl` (190) — common.wgsl: the camera, the cutaway, dither, shadows, the loose sheet and wither, VOut (part 1 of 7 of …
- `fs-box.wgsl` (316) — fs-box.wgsl: fsBox: the ground's and the boxes' fragment shading (part 5 of 7 of the renderWgsl shader, …
- `light.wgsl` (290) — light.wgsl: FOut, colour space, the sun and the cover, lighting, haze, the grid lines, the canopy march …
- `rock.wgsl` (249) — rock.wgsl: soft material borders, faceted and carved rock (part 4 of 7 of the renderWgsl shader, joined in …
- `vertex.wgsl` (427) — vertex.wgsl: the vertex stages: instances, prisms, boxes, lava and water sheets, streams (part 2 of 7 of …
- `water.wgsl` (401) — water.wgsl: glow and flow, water, streams, runs, glass and oil shading (part 6 of 7 of the renderWgsl …

## src/sim/

GPU world buffers (the WorldGpu contracts), the systems' wrappers, the fixed-step scheduler, Globals, particles, sleep, snapshots, static claims.

- `cull.ts` (324) — Dispatching only where the world is awake (on by default, ?simcull=0 off; API: `SIM_CULL`, `LIVE`, `TILES_BINDING`, `NEAR` +8.
- `edit-ops.ts` (89) — The edit pass's ops (edit.wgsl: keep the two the same) and how an Edit event carries one (round 83: one … API: `OP`, `BLOW_TAG`, `STROKE_START`, `editOpOf` +5.
- `external.ts` (601) — External intervals (round 99, `?meshinst=1`; API: `MESHINST`, `OwnerId`, `OWNER_ROCK`, `OWNER_STRUCT` +14.
- `flow.ts` (83) — The simulation's rates (perfopt, DECISIONS round 83). API: `TICK_HZ`, `FLOW_SUB`, `Flow`, `flowN` +4.
- `globals.ts` (285) — CPU mirror of `struct Globals` in src/shaders/common.wgsl. API: `TUNE_WORD`, `GLOBALS_HEAD_BYTES`, `GLOBALS_BYTES`, `globalsBytes` +13.
- `lava.ts` (194) — Lava (docs/PHYSICS.md "Lava"; API: `MAX_VENTS`, `Vent`, `LavaSystem`.
- `pages.ts` (391) — Round 105 (`ringwin`): the window on a ring — a world cell keeps its place while the window slides over … API: `COLUMN_BUFS`, `COLS_PAGE`, `PAGE_COLS`, `MAX_PAGES` +3.
- `particles.ts` (254) — GPU particle system: emission from world state, CPU-requested bursts, and integration in the shared wind … API: `enum`, `Burst`, `ParticleSystem`.
- `settlehold.ts` (66) — (round 128o, DA-B20; DESIGN.md §24 — no timed read back in play) The water's settling hold, on the GPU: a … API: `HOLD_S`, `SettleHold`.
- `simulation.ts` (206) — Fixed-timestep orchestration of the simulation systems (design doc §24). API: `TICK_DT`, `Simulation`, `TICK_HZ`.
- `sleep.ts` (315) — Sleep and wake (round 80, BACKLOG P3; API: `SLEEP_MORE`, `settleLand`, `WAKE_NEAR`, `settleTol` +1.
- `snapshot.ts` (161) — (round 112, testspeed) A warmed world, saved and put back: every buffer and texture the WorldGpu holds … API: `WorldSnapshot`, `captureWorld`, `restoreWorld`, `encodeSnapshot` +3.
- `static-claims.ts` (475) — Static grids' claims written with the land (round 128j, M128-8 widened; API: `StaticThing`, `GridPlace`, `StaticClaimsIO`, `StaticGrid` +2.
- `system.ts` (31) — Simulation system interface (design doc §9, §23, §24). API: `SimSystem`, `dispatch`.
- `systems.ts` (1086) — First (simplest) implementations of each simulation system. API: `riverHeld`, `PrepWorld`, `SurfaceSystem`, `StructureSystem` +25.
- `tickclock.ts` (130) — Round 114 (framepace, FP4): how many sim ticks a rendered frame runs. API: `TickMode`, `TickClock`, `tickModeFrom`.
- `tiers.ts` (277) — The sims' tiers (round 108, simtiers; API: `TIER_CHANNEL`, `BAKE_GAIN`, `INTERACT_MIN_S`, `INTERACT_MAX_S` +2.
- `translate.ts` (87) — Moving what lives in window coordinates when the streamed window slides (round 80; API: `Translator`.
- `warm-cache.ts` (68) — (round 112, testspeed) The player's warmed world, kept in the browser (IndexedDB): the second visit to the … API: `warmKey`, `loadWarm`, `saveWarm`.
- `windrect.ts` (100) — Where the painted wind is (round 104, simscale — the user: "Why does wind and climate need to run … API: `LIFE_S`, `reach`, `WindRects`.
- `world-gpu.ts` (587) — GPU-resident world state: every buffer that forms a contract between systems is allocated (and documented) … API: `STATS_COUNT`, `EDIT_TAGS`, `RiverMode`, `riverMode` +8.

## src/solver/

- `build.ts` (220) — A body's nodes from its cells (the physics design: "nodes come from the voxels by clustering"). API: `NN`, `BuiltNode`, `Built`, `cellCentre` +2.
- `materials.ts` (79) — What each material is to the node solver (solver.wgsl SM: 4 vec4 a material). API: `SolverMat`, `solverMat`, `packSolverMats`, `kindOf`.
- `solver.ts` (517) — The node solver's host (src/api/contracts/solver.ts NodeSolver; API: `BODY_V`, `LANE_V`, `Solver`.
- `variant.ts` (50) — The physics experiment (the user, round 120: "Can we treat this as an experiment and test each approach … API: `SolverVariant`, `VARIANTS`, `Routing`, `ROUTING` +2.

## src/story/

Stories: dialog play, hero runs, the atlas run.

- `atlas-run.ts` (210) — ---- story/atlas-run.ts ----------------------------------------------------------- (round 97, heroapi) A … API: `RUN_STORIES`, `loadRunStory`, `runWorld`, `AtlasRunDeps` +1.
- `camera.ts` (220) — ---- story/camera.ts ----------------------------------------------------------- Story cameras (round 83, … API: `V3`, `ShotOpts`, `StoryCamera`.
- `hero-run.ts` (463) — ---- story/hero-run.ts ---------------------------------------------------------- A run story played as a … API: `HeroRunDeps`, `HeroRun`.
- `play.ts` (650) — ---- story/play.ts ------------------------------------------------------------- A SessionStory played on … API: `Stage`, `StageLock`, `StageFrame`, `StageLasting` +3.
- `stage-gen.ts` (316) — ---- story/stage-gen.ts --------------------------------------------------------- A story's locations … API: `StageGenDeps`, `StagePiece`, `StageGen`, `stageStory`.
- `stage-land.ts` (220) — ---- story/stage-land.ts -------------------------------------------------------- (round 99, `runstream`; API: `WorldPiece`, `StageLand`.
- `waypoint.ts` (191) — ---- story/waypoint.ts ---------------------------------------------------------- Where to go now (round 94; API: `Target`, `TargetDeps`, `objectiveTarget`, `describe` +1.

## src/story/demo/

- `index.ts` (24) — ---- story/demo/index.ts ------------------------------------------------------- `?story=demo` (round 83): … API: `demoStory`.

## src/structures/

- `assets.ts` (162) — Buriable pieces (the user, round 117: "buried statues and fallen structures and stones. API: `buriable`, `AFFINE`, `assetPieces`.
- `columns.ts` (92) — Plan → columns: what the sims see of a city (contracts/structures.ts ColumnSpan): per hex column under a … API: `columnsOf`, `raster`.
- `dressmodules.ts` (511) — The purposes' and the dressing's modules (round 120, `cities`; API: `PROP_SIZE`, `dressModules`.
- `gpu.ts` (429) — The pieces on the GPU (any host: the viewer, the game's renderer): the module library in one vertex and … API: `SP_PAL`, `GRID_CAP`, `GRID_VEC4`, `SP_GRID0` +9.
- `index.ts` (23) — The structures system (contracts/structures.ts Structures): plan, pieces, columns, buriable assets. API: `structures`, `planCity`, `piecesOf`, `columnsOf` +7.
- `linear.ts` (272) — Linear features (the user, round 117: "linear tile features we can use for bridges, roads, railroads and … API: `Sample`, `resample`, `segFrame`, `BRIDGE_AT` +7.
- `modules.ts` (861) — The module library: every drawn piece of a building, made in code in a unit frame (u, v, w) and warped … API: `enum`, `PARTS`, `Module`, `Kit` +8.
- `nav.ts` (285) — Baked navigation (the user, round 117: "bake paths into the tiles we generate so agents can interact with … API: `bakeNav`, `navPath`.
- `pieces.ts` (467) — Plan → pieces: every module the city shows, each warped into its frame (contracts/structures.ts … API: `PIECE_FLOATS`, `REL`, `DRAPE`, `WIND` +10.
- `plan.ts` (690) — The planner: a CitySpec and the ground → a CityPlan (tiles, buildings, occupancy spans, façades, … API: `STOREY_H`, `WALL_H`, `HOUSE_D`, `defaultDensity` +6.
- `purpose.ts` (620) — A city's purpose in its plan (round 120, `cities`; API: `PurposeCtx`, `Works`, `SHIP_DRAFT`, `PIER_DECK` +5.
- `rng.ts` (62) — Deterministic randomness for the generators: same seed, same city, on every machine (no Math.random). API: `rng`, `hash32`, `hashf`, `vnoise` +1.
- `styles.ts` (163) — Styles: which modules a look uses and its palette (the shader colours a module's parts from it). API: `RGB`, `Style`, `STYLES`, `styleOf` +2.
- `wfc.ts` (130) — Wave function collapse on any graph (the user, round 117: "some WFC"). API: `WfcProblem`, `WfcContradiction`, `solve`.

## src/structures/tiles/

- `builder.ts` (233) — The tile systems' common ground: a planar quad mesh with shared vertices (contracts/structures.ts TileMesh). API: `TileBuilder`, `adjacency`, `quadCorners`, `quadCentre` +1.
- `farmland.ts` (196) — The farmland: a tile system of its own on the ground round a settlement (round 119, the user: "Can we get … API: `FarmOpts`, `PlotFence`, `farmland`, `mergeTiles`.
- `systems.ts` (409) — The tile systems (the user, round 117: "Irregular tiles like towscraper, voronoi tilings of isolines to … API: `TileOpts`, `tileSystem`, `clipHalf`, `inset` +1.

## src/structures/viewer/

- `main.ts` (557) — The structures viewer (structures.html;
- `mat.ts` (53) — Column-major 4×4 matrices for the viewer (WebGPU clip space: z in [0, 1]). API: `Mat4`, `mul`, `perspective`, `ortho` +1.
- `render.ts` (286) — The viewer's renderer: the ground, the pieces, a sun shadow map, lines for the overlays. API: `FrameView`, `ViewerRenderer`.
- `viewer.wgsl` (201) — The structures viewer's host shader (src/structures/viewer/render.ts): a ground, the pieces …

## src/terrain/

- `atlasgraph.ts` (137) — Terrain track (round 117): the atlas's regions as a graph — the top level of the partition, world-wide, … API: `atlasGraph`.
- `cave.wgsl` (93) — Terrain track (round 117): caves that open at a cliff's foot — inland cliffs and sea cliffs (compose.wgsl …
- `flood.ts` (383) — Terrain track (round 117): a basin flooded by height — the GPU tool (flood.wgsl) and its CPU reference … API: `FLUID_CODE`, `FloodGrid`, `FloodMask`, `fillCpu` +5.
- `flood.wgsl` (77) — Terrain track (round 117): a basin flooded by height on the GPU (terrain/flood.ts) — the user: "I think …
- `gorge.wgsl` (56) — Terrain track (round 117): gorges cut into the plateaus' tops (compose.wgsl ground()).
- `partition.ts` (920) — Terrain track (round 117): the region graph — the map partitioned into features and rooms, the borders … API: `TerrainSamples`, `PartitionOpts`, `SCREEN_AREA`, `SOFT_COST` +6.
- `props.ts` (136) — Terrain track (round 117): where things lie buried — skew stones, statues, fallen columns and slabs, ruins … API: `PROP_TILE`, `placeBuried`.
- `river.wgsl` (202) — Terrain track (round 117): a river's course and cross-section as an SDF, per cell (atlas compose.wgsl …
- `rivershape.ts` (197) — Terrain track (round 117): the shape of the atlas's rivers along their course — where their water stands. API: `RiverCourse`, `incisionFor`, `CASCADE_STEP`, `CASCADE_SLOPE` +5.
- `sample.ts` (88) — Terrain track (round 117): the land on a grid, sampled on the GPU from the atlas's ground() … API: `MAX_SIDE`, `LandSampler`.
- `sample.wgsl` (67) — Terrain track (round 117): the land sampled on a grid for the region graph (terrain/sample.ts → …
- `sea.wgsl` (17) — Terrain track (round 117): where the sea's water stands — not wherever the ground is under the sea's level.
- `terrain.ts` (325) — Terrain track (round 117): the terrain system — api/contracts/terrain.ts `Terrain` over the atlas. API: `TerrainSystem`.
- `viewer.ts` (402) — Terrain track (round 117): the terrain viewer — `?terrain=view` (the user, round 117 part 4: "If we are … API: `TerrainView`.

## src/test/

- `contract.ts` (348) — Round 112 (testspeed): the contract tier — a system (or a few) on a tiny world, its contract inputs set … API: `ContractResult`, `ContractOpts`.
- `crop.ts` (47) — (round 112, testspeed) A map's rectangle as a map of its own: a contract test's tiny world cut from a level's. API: `cropMap`.
- `probe.wgsl` (11) — (round 112, testspeed) The runner's self-check kernel (scripts/run.mjs selfcheck): it writes a constant of …

## src/traits/

- `core.wgsl` (92) — ---- traits: the core's bookkeeping (LW1), around the game's modules …
- `install.ts` (21) — The trait system on a world's agents (LW1): one call, as installAgents — its system ticked just before the … API: `installTraits`.
- `prelude.wgsl` (153) — ---- traits: the prelude every trait kernel shares (LW1;
- `registry.ts` (88) — The trait modules' registry (LW1; API: `TABLE_WORDS`, `Registered`, `TraitRegistry`, `packTable`.
- `system.ts` (361) — The trait system on the GPU agents (LW1; API: `MAX_EFFECTS`, `TraitSystemOpts`, `TraitSystem`.

## src/tune/

- `params.ts` (301) — (round 108, BACKLOG AR5) The physics and flow parameters: every number the tuning panel shows, one … API: `TUNING`, `TUNE`, `worldG`.
- `registry.ts` (200) — (round 108, BACKLOG AR5) The tuning registry: every physics and flow number that used to be a constant, in … API: `ParamSpec`, `GroupSpec`, `Values`, `ParamDef` +3.

## src/ui/

DOM UI: HUD, editor, panels, compass, bug report, perf overlay.

- `audio-debug.ts` (44) — Audio debug panel (round 11, `?audio=1`): every continuous voice with its live level and a mute box, and a … API: `AudioDebug`.
- `bugreport.ts` (146) — (round 108, BACKLOG AR5) The quick bug report: one key (B) or the 🐞 button takes a picture of the world, … API: `BugContext`, `BugReport`.
- `compass.ts` (52) — (round 91, the user: "a directional compas for the way your are facing") A small compass on the game view: … API: `Compass`, `NORTH_AZIMUTH`.
- `editor.ts` (324) — Sandbox editor panel (BACKLOG B2, round 13 F2–F4): brushes, materials, spawns and time. API: `BODIES`, `EditorMaps`, `EditTool`, `EDIT_OP` +2.
- `experiment.ts` (118) — The physics experiment's controls (round 120, the user: "test each approach side by side … so I can see … API: `ExperimentHooks`, `reloadWith`, `comparePairs`, `experimentControls` +2.
- `hud.ts` (150) — Minimal HUD (DECISIONS 2026-10-07): no tool buttons — interaction is by gesture on the world. API: `Hud`.
- `perf-overlay.ts` (73) — Performance overlay (design doc §9). API: `PerfSnapshot`, `PerfOverlay`.
- `shot.ts` (28) — (round 108, AR5) A picture of the world's canvas for the bug report. API: `requestShot`, `serviceShot`.
- `stations.ts` (74) — (round 108, BACKLOG AR8) The playground's stations bar (levels/playground.ts): which station, its buttons, … API: `StationHandlers`, `StationsBar`.
- `thumbs.ts` (57) — Model thumbnails (round 13, F5): each model of the atlas drawn as a little isometric picture on a 2D … API: `thumbnail`.
- `tunepanel.ts` (458) — (round 108, BACKLOG AR5) The tuning panel: every parameter of the tuning registry (src/tune/params.ts) as … API: `TunePanelOpts`, `offerFiles`, `TunePanel`.

## src/units/

- `agent-units.ts` (696) — ---- units/agent-units.ts --------------------------------------------------------- The Units contract … API: `F`, `G`, `RAISED_GROUP`, `Routine` +2.
- `figures.ts` (159) — ---- units/figures.ts ----------------------------------------------------------- The hero and the units … API: `FigurePose`, `unitPose`, `Figures`.
- `simple.ts` (364) — ---- units/simple.ts ------------------------------------------------------------ The Units contract … API: `Ground`, `REACH`, `SimpleUnits`.

## src/weather/

Storms, day and night, the rivers' wetness.

- `catchwet.ts` (218) — The rivers' wetness per watershed (round 109 — the user: "I want it per water shed please"). API: `RiverGraph`, `RainSource`, `CatchmentWet`.
- `cover.ts` (90) — The weather's cover past the window (round 108, TC20; API: `COVER_N`, `COVER_CELL`, `CoverSource`, `WeatherCoverSystem`.
- `daynight.ts` (88) — Day/night cycle. Produces the light the renderer uses (sun direction, sun colour × intensity, ambient sky … API: `Daylight`, `DayNight`.
- `riverwet.ts` (32) — The rivers' wetness (round 84, ?rivers=table — the user: "precompute the flow of those as a function of … API: `RiverWet`.
- `weather.ts` (500) — Weather (design doc §20, DECISIONS 2026-10-07): storms are large CPU-side entities that roll across the … API: `Storm`, `DustStorm`, `Cyclone`, `SPINE_N` +2.
- `wetfield.ts` (87) — The window's river-wetness field (round 109): the storm water each river carries (weather/catchwet.ts), at … API: `RiverWetField`.

## src/world/

CPU world data: map generation, the column layout (chunks, intervals), materials, lattice, models, region records and store.

- `kit.ts` (544) — The level kit (docs/LEVELS.md): a level is a short script against this builder instead of hundreds of … API: `P`, `Sdf`, `disc`, `ring` +12.
- `landforms.ts` (685) — The wilds (round 64, docs/DECISIONS.md): natural land, generated from a room plan (places.ts; API: `Landform`, `LandformsOpts`, `generateLandforms`.
- `lattice.ts` (56) — The hex lattice of the nature grid (docs/GRIDS.md), mirrored from common.wgsl: pointy-top hexes, centre to … API: `ROW_H`, `NDIR`, `DIRS_BYTES`, `DIRV` +5.
- `layout.ts` (336) — Canonical world representation (design doc §12) — the data contract every system reads/writes. API: `CHUNK`, `MAX_K`, `MIN_K`, `K_HEADROOM` +26.
- `loose.ts` (47) — Loose ground lives in the layers (round 22, branch strata): the soft ground a map lays (soil, sand, ash, … API: `looseIntoGrid`.
- `mapfile.ts` (177) — Saved maps (BACKLOG F6/E8): a sandbox world captured from the GPU, written as one gzip-compressed binary — … API: `unpackColumns`, `encodeMap`, `decodeMap`, `savedMaps`.
- `mapgen.ts` (712) — Procedural first-prototype map (design doc §26): sloped valley, a dammed reservoir (future leverage), a … API: `MapData`, `generateMap`, `buildRuin`, `buildTank` +1.
- `materials.ts` (275) — Shared material table (design doc §12). API: `enum`, `MaterialDef`, `Bond`, `MAT` +6.
- `menumap.ts` (390) — The main-menu diorama (design doc §4): a skull and bones on a mound of reddish-grey dust. API: `MENU_SCALE`, `MenuModel`, `generateMenuMap`.
- `models.ts` (537) — Model atlas (round 13, BACKLOG F5): small voxel models — ruined cars, a bus, a tanker truck, a beached … API: `VoxelModel`, `MODELS`, `modelById`, `footprint` +6.
- `noise.ts` (57) — Small deterministic noise helpers for procedural map generation. API: `hash2`, `valueNoise`, `fbm`, `smoothstep` +1.
- `places.ts` (678) — Places (docs/PLACES.md, round 51): regions, and rooms within them, as named places a runtime (a game, an … API: `MAX_PLACES`, `PlaceKind`, `Place`, `ConnectionKind` +11.
- `region-record.ts` (348) — A region's record (round 100, `regionstore`; API: `RECORD_MAGIC`, `RECORD_FORMAT`, `GEN_VERSION`, `LayoutBuf` +14.
- `region-store.ts` (172) — The region store (round 100, `regionstore`; API: `StoreKeep`, `RegionStore`, `StoreMeta`.
- `region-store.worker.ts` (223) — The region store's worker (round 100, `regionstore`): records compressed and put into IndexedDB, read and … API: `StoreMeta`, `StoreAsk`, `Dropped`, `StoreReply`.
- `rivertable.ts` (302) — Held rivers from a river table (round 110 — the user: "The waterfalls don't use the same system as the … API: `RIVER_FALL`, `RIVER_SHEET`, `RIVER_LEVEE`, `RIVER_UNDER` +8.
- `sandbox.ts` (189) — The sandbox map (BACKLOG B2): open rolling ground with a little of everything to play with — a pond, a … API: `generateSandbox`.
- `scale.ts` (6) — The world's scale (DECISIONS round 106: "a cell feels about 1–2 m … start from true gravity at that scale … API: `WORLD_G`.
- `streamgen.ts` (156) — Streamed land (round 66, BACKLOG Q28): ground generated a region at a time from world coordinates alone, … API: `SEA`, `streamHeight`, `RegionLand`, `generateRegion` +1.
