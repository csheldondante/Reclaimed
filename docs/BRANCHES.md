# Branches

One engine, several games (DECISIONS round 33). Each line of work lives on
its own long-running branch, cut from `story` at 9f83137 (main + the story
rules + the level tools + the event fix). Fixes to the shared engine
(sim, render, tooling) go to `ambient` first and are merged or
cherry-picked into the others; each branch's own work stays on it. `main`
is what GitHub Pages deploys: it follows `ambient` until the user says
otherwise. A branch is pushed once it has meaningful work of its own
(round 34). Pages holds every pushed branch: `main` at the root, the others
under `/<branch>/` (e.g. https://csheldondante.github.io/Reclaimed/grids/),
so each can be tried on a phone. A push to any of them rebuilds all of them
from origin (.github/workflows/pages.yml); the workflow must be the same on
every branch, or a push from a branch with the old one publishes only `main`.

## Worktrees

Each branch has its own worktree (its own `npm install`; never a junction
to another's node_modules) and its own dev-server port, so they can be
worked on in parallel:

| Branch | Folder | Dev server |
|---|---|---|
| `ambient` | `C:/Projects/Reclaimed` | `npm run dev` → 5173 |
| `puzzle` | `C:/Projects/Reclaimed-puzzle` | `npm run dev -- --port 5174` |
| `mayhem` | `C:/Projects/Reclaimed-mayhem` | `npm run dev -- --port 5175` |
| `sandbox` | `C:/Projects/Reclaimed-sandbox` | `npm run dev -- --port 5176` |
| `grids` | `C:/Projects/Reclaimed-grids` | `npm run dev -- --port 5177` |
| `physics` | `C:/Projects/Reclaimed-physics` | `npm run dev -- --port 5181` |
| `agents` | `C:/Projects/Reclaimed-agents` | `npm run dev -- --port 5185` |
| `perf` | `C:/Projects/Reclaimed-perf` | `npm run dev -- --port 5189` |
| `builder` | `C:/Projects/Reclaimed-builder` | `npm run dev -- --port 5195` |
| `stream` | `C:/Projects/Reclaimed-stream` | `npm run dev -- --port 5199` |
| `atlas` | `C:/Projects/Reclaimed-atlas` | `npm run dev -- --port 5203` |
| `places` | `C:/Projects/Reclaimed-places` | `npm run dev -- --port 5207` |
| `physfix` | `C:/Projects/Reclaimed-physfix` | `npm run dev -- --port 5291` |
| `physfix2` | `C:/Projects/Reclaimed-physfix2` | `npm run dev -- --port 5311` |
| `testspeed` | `C:/Projects/Reclaimed-testspeed` | `node scripts/run.mjs serve` (port 6280) |
| `meshinst` | `C:/Projects/Reclaimed-meshinst` | `npm run dev -- --port 5281` |
| `regionstore` | `C:/Projects/Reclaimed-regionstore` | `npm run dev -- --port 5283` |
| `gpugen` | `C:/Projects/Reclaimed-gpugen` | `npm run dev -- --port 5293` |
| `perfopt` | `C:/Projects/Reclaimed-perfopt` | `npm run dev -- --port 5211` |
| `ceiling` | `C:/Projects/Reclaimed-ceiling` | `npm run dev -- --port 5215` |
| `hybrid` | `C:/Projects/Reclaimed-hybrid` | `npm run dev -- --port 5235` |
| `rivers` | `C:/Projects/Reclaimed-rivers` | `npm run dev -- --port 5219` |
| `flow` | `C:/Projects/Reclaimed-flow` | `npm run dev -- --port 5223` |
| `dialog` | `C:/Projects/Reclaimed-dialog` | `npm run dev -- --port 5227` |
| `heroapi` | `C:/Projects/Reclaimed-heroapi` | `npm run dev -- --port 5251` |
| `runstream` | `C:/Projects/Reclaimed-runstream` | `npm run dev -- --port 5279` |

| Branch | Game | Builds on | Backlog |
|---|---|---|---|
| `ambient` | Reclaimed as it is: the chill ambient game (Free play, the story rules) | everything to date | the main backlog |
| `puzzle` | Puzzle mode: levels as a DAG of gates, abilities as a toolkit | the level kit, map preview, gate validator, the Trial Grounds | R6–R10, docs/LEVELS.md |
| `mayhem` | FEMA Mayhem: an automated city that responds to disasters; the player only breaks things with weather | powers, structure collapse, fire, floods, people as agents | X1 |
| `sandbox` | World editor: place and modify prefabs, raise mountains, shape the land with wind, rain, meteors, volcanoes | the sandbox brushes (edit.wgsl), stampGrid models, bedrock uplift | X4 |
| `grids` | The map engine generalised: intersecting grids (a hex nature grid of material intervals, a rectangular voxel grid for structures, an irregular grid for WFC buildings) that read and write each other's data | the sim systems and their contracts | X5 |
| `agents` | Units that walk, dig, carry, build, fell, flee and attack, by shared fields; a layer for editors and games (docs/AGENTS.md) | grids' engine (and places, from physics) | A1 |
| `builder` | Terrain generation (landforms, caves, rivers), the range and mesa brushes, Townscaper-style building (instant, and planned: crews build the difference) | `agents` | W1, X4, API6 |
| `stream` | A world without an edge (round 66): the live world a window that slides with the camera, regions out of it frozen and thawed exactly, new land generated a region at a time; later deferred or coarse ticks for what's frozen, so towns and nature grow out of sight | `builder` | Q28, Q31–Q35 |
| `atlas` | A world map to stream from (round 67): a finite world (a torus) made on the GPU when it starts — continents, islands, a partition into regions by Voronoi cells and faults, each region a kind with its own ground, patterns from a bank (wallpaper groups, reaction–diffusion, automata, fractals), borders as cliffs, ravines, walls, terraces, beaches; caves; the streamer's columns drawn from it. `?atlas=view` the viewer, `?level=atlas` walks in | `stream` | Q33, Q36–Q43 |
| `places` | Readable places on an overmap (rounds 76–78): the atlas's macro height designed (noise for 2D shapes, SDF blends at region borders by the kinds that meet, superstructures, layers), regions given briefs and generated with rooms, paths and stamped crossings (ramps, switchbacks, lifts, tunnels, bridges), a traversal check per hero, a steep top-down camera; the overmap as a fantasy map | `atlas` | V1–V14 |
| `dialog` | Dialog and story cameras (round 83, docs/SYSTEMS.md systems 10, 11 and part of 5): a SessionStory played on a level — the dialog panel (phone first), the run (objectives, conditions, outcomes, AtlasEvents to the world state, the RunRecord), the objective list, the story cameras (frame a speaker, reveal a place, follow). `?story=demo` on the valley: /Reclaimed/dialog/?skipmenu=1&story=demo | `places` (1f1fea5, the contracts) | systems 10, 11 |
| `runstory` | A run story played as a hero (round 88): an on-foot hero on the atlas level (behind the `Hero` contract, so the hoverbike game's heroes plug in), the GM's Bell story staged near the spawn, its cast as units (the `Units` contract), talks, objectives, fights; death ends the run. `?run=bell` on the atlas level: /Reclaimed/runstory/?skipmenu=1&level=atlas&run=bell | `places` | D6, D8, D9, D10, G9 |
| `heroapi` | The hoverbike game's heroes in a run story (round 97): additive contracts and HeroRun options for a game's own hero, controller, units and camera (story/atlas-run.ts `startAtlasRun`), dialog as an event (barks, talks and sightings fired by happenings), the phone's missing dialog answers fixed, the Bell story showing more; GameplayGM's experiment/slice plays it. /Reclaimed/heroapi/?skipmenu=1&level=atlas&run=bell | `places` (28a0945) | HA1–HA10 |
| `runstream` | A run over the streamed world (round 99): the window streams during a story run; the stage in world units (StageFrame), its places in world cells stamped into the land as it arrives (story/stage-land.ts, Atlas.landHooks), what play changes that lasts (opened locks, graves, broken walls) kept as a diff, so warps and long rides keep them (RS9, RS16). /Reclaimed/runstream/?skipmenu=1&level=atlas&run=bell | `heroapi` (4e02676) + `places` (b936f81) | RS9, RS16, RS17 |
| `settlements` | Settlements with agents working round them (round 88, docs/SYSTEMS.md systems 6, 7, 12): every atlas site a Settlement record (the city game's contract) with a people's profile (data/recipes/), districts on overlay grids (radial, contour-Voronoi, irregular, orthogonal), buildings as Instances realised in the columns as land arrives (walls, plaza, fields, ruins adapted, raiders' camps); its people as units (the Units contract on the GPU agents) on their rounds, a raid met by guards. /Reclaimed/settlements/?skipmenu=1&level=atlas&town=1 (`&towndebug=1` the grid and jobs) | `places` | R4, R6, ST1–ST8 |
| `perf` | Profiling and experiments for phones (round 61): what's a clear win merges into `grids`; the user validates the feel on a phone | `grids` (with `agents`) | G16, Q20 |
| `physics` | The sandbox as a destruction playground and terrain for other games: physics voxels (one GPU solver: metal bends, stone cracks), heat beam, then meteors and volcanoes (docs/PHYSICS.md) | grids' engine and look | F13 |

## ambient

The game we have: an isometric ruined valley you nudge back to life with
weather. Chill and relaxing (round 31). Free play greens everywhere; the
story rules spread green only by seeds within a growing reach. Polish,
performance (Q18 mobile), the valley re-theme (N6/R5) and the menu live
here.

## puzzle

Levels built with the kit (`src/world/kit.ts`) as DAGs of gates: dust,
litter, compacted trash, poison, oil, walls; seed caches as easter eggs.
Not hard, just satisfying; abilities never locked, any ability that
clears an obstacle opens it, single-key obstacles teach (round 31); the
weather may wear a gate down but mustn't open it (round 32). The
validator (`scripts/gates.mjs`) checks every gate headlessly. Next: the
poison/oil leak (R10) — decided here; the user's lean: oil hard to get rid
of without burning it (that's what makes it fun), and water dissolving
only so much poison per amount of water; seed caches waking (R9), levels from the catalogue
(R8), the valley's DAG towards the lab (R3).

## mayhem

FEMA Mayhem (working title): the arcade version, fun mayhem. A full city
that runs itself — buildings, roads, people and traffic, and emergency
services that respond (fire crews, evacuations, sandbags, rebuilding).
The player never builds; they unleash weather and disasters on it:
storms, lightning, tornadoes, floods, fire; later meteors, volcanoes,
earthquakes, maybe killer aliens. Damage counters and the city's
recovery are the feedback loop. First steps: a city generator from the
kit (blocks of prefab buildings on a street grid), people as agents (the
animal system as a base), then one responder (fire crews putting out
fires).

## sandbox

A world editor. Place, move, rotate, scale and recolour prefab structures
(the voxel models, tanks, ruins, walls, houses); sculpt the land (raise
mountains, dig valleys, rivers and lakes); and shape it with the
processes: wind erosion, rain, floods, meteor impacts (crater, ejecta,
fire), volcanic eruptions (lava: a hot liquid that cools to stone).
Save and load worlds; the kit's levels load into it. First steps: a
prefab palette with placement and selection (stampGrid already places
models), then meteors (lightning's crater edit, scaled up, with ejecta
particles), then lava (a new liquid in the water/oil pattern).

## grids

The map engine, generalised: a world made of several grids that overlap
and talk to each other, so it can mix terrain with things that aren't
terrain and look better for it. Kept apart so the game branches don't
depend on it until it proves out. (First called `hex`; renamed, round 34:
hexes are one grid among several, not the point.)

1. **Intersecting grids.** Each grid suits what lives on it: a hex grid of
   material intervals for nature (sediment, wind, water — six equal
   neighbours, so dunes, talus and wind shadows come out round instead of
   diamond-shaped); a rectangular voxel grid for building structures; an
   irregular grid for WFC buildings, Townscaper-style. Any number of grids,
   at any offset, rotation and scale.
2. **Interactions both ways.** Each pair of grids has a precomputed
   overlap (which cells of one cover which of the other, with area
   weights), so any field reads across: a building on the irregular grid
   samples height, slope, moisture and wind from the nature grid, and
   writes back what it puts there (occupancy, roughness that slows the
   wind, roofs that shed rain, foundations that hold the soil); a voxel
   wall blocks the nature grid's water and sand; sand piles against it.
3. **Irregular grid + WFC.** Hexes split into triangles, merged into quads,
   relaxed into an organic mesh; wave function collapse on it places
   houses, walls, farmland and trees, stacking upward where it's dense,
   driven by the fields it reads (flat, dry, near water).

Measure against today's square columns at each step (the DEVLOG rule):
frame time per system, and pictures of the same dune field and the same
storm on both.

## physics

Cut from `grids` (round 43). The sandbox as a playground for destruction,
and as terrain for other games: every voxel of a physics body is a particle
(docs/PHYSICS.md). Metal bends and stays bent, stone cracks into rigid
pieces, contacts lose energy and never gain it (deep overlaps crumble to
loose ground). Tools: drop a body, the heat beam; next meteors and
volcanoes. Merges from `grids` for the look.

## agents

Cut from `grids` (round 52). A simulation layer of units: walkable surfaces
peeled from the intervals, distance fields per goal shared by state-driven
groups, units on the GPU following them; then digging and carrying,
building on a Townscaper-style irregular grid, felling, fleeing and
attacking (docs/AGENTS.md). Meant for many editors and games. Merges from
`grids` for the engine. Not on Pages yet: the workflow lists its branches
and must be the same on every branch.

## Threads that stack (round 67)

Three threads are built one on the other and are meant to merge together
once the user has tried them: `builder` (the town: plan mode, workers) →
`stream` (the window that slides, frozen regions) → `atlas` (the world map
the stream draws from). Each branch has everything below it. What crosses
them: the town doesn't follow a slide yet (Q32) — in the streamed and atlas
levels the town tool works only until the first slide; the atlas's regions
are where rooms and key-and-door rules would hang (Q39); frozen regions
ticking (Q31) is the stream's next step and applies to the atlas level as
it is. Round 69 (atlas) slides the window in z too (`Streamer.oz`,
`outside`): the stream level doesn't use it (its land has no height), so
`stream` merging under `atlas` stays as it is.

## Stable checkpoints

| Tag | Commit | Branch | What |
|---|---|---|---|
| `stable-r83-perf` | `a0d8bea` | `places` | Round 83, 2026-10-26: the user, testing it — "this is much better! I think this is sufficient for performance for now" (perfopt's deferred shading and phone set, the LOD rings filling unbuilt chunks, the mesh held during slides). The revert point if later work regresses; after it came the rings' cuts and the rock collapse (whose first versions froze for seconds). |

## Experiments (round 83, from `places`; merge back what wins)

| Branch | What | Try |
|---|---|---|
| `phonecam` | Round 90 (from `places`): the atlas level on the phone — the view turns (↺ ↻ bottom left, a sixth a tap, held turns on; Q / E), a range setting for how far out the land is built in detail (256/320/384, the phone's default 320; `&win=` to A/B), a slide's regions nearest the camera first; scripts/turnshot.mjs, rangeprobe.mjs. Round 91: the map's place names (the wiki's), a compass (tap: face north), the map no longer mirrored, the camera kept a region in from the window's edge, the land asked for where it's heading, grain on the rings; scripts/mapnames.mjs, edgeprobe.mjs | https://csheldondante.github.io/Reclaimed/phonecam/?skipmenu=1&level=atlas |
| `fardetail` | Round 93 (from `phonecam`): the land past the window drawn the window's way — the LOD rings bake the plants the window's columns start with and the distance to the atlas's ways (once a texel, as they bake their heights), and draw grass, flowers, brick ways, water, painted trees and the window's light; the near side past the window no longer pressed flat; `?fd=0` the old look, `?fdveg=` the grass floor; scripts/fdshot.mjs (shots with the window's edge, the seam's colour) | https://csheldondante.github.io/Reclaimed/fardetail/?skipmenu=1&level=atlas&at=11956,15471 |
| `farbake` | Round 94 (from `fardetail`): the land past the window baked into a streamed texture — a clipmap level a ring and one for the far land (atlas/bake.ts, bake.wgsl), the window's look averaged a texel, the settlements within reach planned in a worker on the atlas's rough ground and their tops baked in (settle/plan-worker.ts, raster.ts); the rings and the far land draw it, lit a frame; `?fb=0` round 93's look, `?fbr=` the towns' reach, `?fbn=` a level's side; scripts/farshot.mjs | https://csheldondante.github.io/Reclaimed/farbake/?skipmenu=1&level=atlas&at=11956,15471 |
| `winmem` | Round 93 (from `phonecam`): the streamed window's GPU memory — the field mesh in a page pool sized by what's built, one shared quad index buffer, the instance lists grown on demand (465 → 230 MB at win 320, the largest binding 103 → 25 MB; `?meshpool=0`, `?instgrow=0` the old); `?winh=` a window deeper than wide (experiment); scripts/memprobe.mjs (every buffer by label, what's used), edgeprobe `--face` | https://csheldondante.github.io/Reclaimed/winmem/?skipmenu=1&level=atlas&at=11956,15471 |
| `zmesh` | Round 100 (overnight, from `places`): the window holds the atlas's whole height (zMax 504: the surface packed 9.8, the physics voxels' columns 16 words, the pick's z 9 bits) — no slide in z, no band; the hybrid's voxels by content (open gaps, edits, steep columns: `?steep=` 12; a form alone no longer: `?formvox=1`), not near the camera (`?vradius=` 0); the grid takes land 3 sim ticks after it comes in (`?readyticks=`); the mesh's samples skipped where nothing reads them. `?zwin=248&vradius=40&readyticks=24&steep=1000&formvox=1` the way before | https://csheldondante.github.io/Reclaimed/zmesh/?skipmenu=1&level=atlas&at=11956,15471 |
| `streamspeed` | Round 98 (from `places`): streaming ahead of the camera — a slide waits for its land and is written in a frame or two (not `busy` while it's made), the region build's tiles paced by the frame's time, arrivals meshed urgently, a cheaper write (`?streamold=1` the old way); `?pan=speed[,deg]` pans the camera itself, `?flyspeed=` the free camera; scripts/speedsweep.mjs. Holds ~120 cells/s straight (was ~40) with the window's detail in view | https://csheldondante.github.io/Reclaimed/streamspeed/?skipmenu=1&level=atlas&at=11956,15471 |
| `hitchrec` | Round 100 (from `places`): the hitch recorder (`?hitch=1`: every frame over 20 ms with its cause — CPU steps, frames held for the GPU, GPU time, GC, long frames, the GPU's traffic; a HUD; "send report" shares the JSON), the GC audit (the judge's scan allocated ~1 GB/s panning: read in place), land come in no longer judged (multi-second freezes panning gone), scripts/hitchrun.mjs, soak.mjs, fracturesame.mjs | https://csheldondante.github.io/Reclaimed/hitchrec/?skipmenu=1&level=atlas&hitch=1 |
| `gpugen` | Round 102 (from `places` c223350): region generation on the GPU — a region's columns finished by atlas/finish.wgsl (the merge, the geysers' sinter, the ways, the stamps, the cut, the pack) straight into a pool slot, no readback of the columns, no CPU cut, no upload (`?gpugen=0` the CPU's path, bit-identical: scripts/gpugentest.mjs); the settlements' and a run's stage's stamps as operations (atlas/stamps.ts); settlement plans in the worker on the GPU's raw ground; the tile pacer by a GPU budget a frame; the ring round a warp precached; ahead strips by speed | https://csheldondante.github.io/Reclaimed/gpugen/?skipmenu=1&level=atlas&at=11956,15471 |
| `bench` | Round 101 (from `places` 187258c): the calibration benchmark (`?bench=1`: one tap, ~5 min, a chain of pages — device facts, a fixed GPU workload for the thermal drift, readback/upload/copy rates, region generation stage by stage, regions/s at 1/2/4/8 tiles a frame, mesh, sims, agents, render scales, the disk store; the ride, pans at 80/120, a warp, a meteor, the hero run, the three window sizes; derived throughput); "Download report" / "Copy" / "Share…"; data/bench/desktop-igpu.json, scripts/benchrun.mjs, benchdiff.mjs | https://csheldondante.github.io/Reclaimed/bench/?bench=1 |
| `bench2` | Round 102 (from `places` 8e197b3): bench v2 after the Pixel 9a's report — Mali's per-pass timestamps judged unreliable (cumulative/overlapping) and an A/B instead (each sim, agents, particles, renderprep, mesh rebuilds, shadows, far land, the grid and the voxel mesh off for 2 s: frame interval and drain), the A/B on each window size, timestamps three ways, the hero walked by the stick, a summary block first; `benchrun.mjs --uncapped` | https://csheldondante.github.io/Reclaimed/bench2/?bench=1 |
| `tilecache` | Round 103 (from `places` 950cb67, `?tiles=1`, default off; **untested**): world-anchored rendered tiles — a region's terrain baked once (unlit: albedo, normal, depth, film) into an LRU atlas slot per view turn, relit every frame and drawn as quads past the window, the rings skipping those regions; kept after the region leaves the window, so land passed stays in detail (render/tilecache.ts, shaders/tiles.wgsl; scripts/tileprobe.mjs) | https://csheldondante.github.io/Reclaimed/tilecache/?skipmenu=1&level=atlas&at=11956,15471&tiles=1 |
| `tileahead` | Round 105 (from `places` 50b07a7): the tiles load the camera's way — the render-only land ordered by when the screen reaches it and how far ahead along the motion (`?tileahead=` s ahead), three regions made at once (`?tilelandn=`), the trailing bakes never take its turn; tileprobe `--zoom`, the leading and trailing halves' detail | https://csheldondante.github.io/Reclaimed/tileahead/?skipmenu=1&level=atlas&at=11956,15471&tiles=1 |
| `tilelatency` | Round 105 (from `places` 6d8eec0): the tiles' latency — the render-only land all on the GPU (Atlas.regionTile: no readback, no stamps, the pacer's first lane; tilelandgpu.wgsl prep and camera; the grid's bake, several a frame), wanted to drawn p50 ~60 ms at 120 c/s; `?tiles=N` (the pacer's) renamed `?tilesfixed=N`; tiles on by default (`?tiles=0` off); with them the LOD rings, farbake and fardetail retired, the round 73 far land kept | https://csheldondante.github.io/Reclaimed/tilelatency/?skipmenu=1&level=atlas&at=11956,15471 |
| `tilephone` | Round 106 (from `places` 1d33c31): why the phone's tiles fell behind — the pan bench reports the tiles (tiles/s, stages, the leading half), the look-ahead reaches a region and a half and a margin round the screen, a window region never baked bakes even a frame the land does (the pool's pop-in behind), rs.hash sliced; tileprobe/benchrun --throttle as a phone proxy | https://csheldondante.github.io/Reclaimed/tilephone/?skipmenu=1&level=atlas&at=11956,15471 |
| `lakes` | Round 90 (from `places`): the atlas owns its lakes (W2) — each filled hollow deep and wet enough a lake at its spill height (rivers.ts AtlasLake: outlet, rivers in and out, regions), realised on arrival filled to its level with a bank over it on its rim, still water; in the rings, the map, the wiki; scripts/lakeprobe.mjs | https://csheldondante.github.io/Reclaimed/lakes/?skipmenu=1&level=atlas&at=11956,15471 |
| `seawall` | Round 88 (from `places`): the sea held over a raised window floor — the sea's columns cut off under the floor (a warp or a slide up by a coast) hold the sea from the floor to its level instead of coming in dry and draining ("a steep wall of water"); scripts/seawall*.mjs | https://csheldondante.github.io/Reclaimed/seawall/?skipmenu=1&level=atlas&at=11600,18213 |
| `rockbody` | Round 96: on by default in the atlas and the rock lab (`?rockbody=0` off); rock slightly weightier (less bounce and spin, more crumbling, big pieces weaker); metal woken into the physics voxels (it bends: the rock lab's steel bridge and tower). Round 95 (from `places`, `?rockbody=1`, default off): the rock the judge frees, or that tips, falls as a rigid body — turning, bouncing, breaking on a hard hit into smaller bodies and rubble with dust and sparks, written back into the columns where it rests; drawn as its own mesh (meshed once, moved with the body), the cubes hidden; the knobs on a panel in the rock lab; scripts/rockbodyperf.mjs | https://csheldondante.github.io/Reclaimed/rockbody/?skipmenu=1&level=rocklab&rockbody=1, https://csheldondante.github.io/Reclaimed/rockbody/?skipmenu=1&level=atlas&rockbody=1 |
| `regionstore` | Round 100 (from `places` 8bff120): the world serializes — frozen regions in a GPU pool (copied GPU to GPU, LRU, `?pool=`), changed regions written whole to IndexedDB (compressed in a worker; `?worldsave=0` memory only), restored on reload; land asked for two strips ahead of the camera and uploaded into the pool so a slide only copies; a warp freezes what it leaves; `?world=new` / the ✦ button a new world; scripts/worldsavetest.mjs | https://csheldondante.github.io/Reclaimed/regionstore/?skipmenu=1&level=atlas&at=11956,15471 |
| `meshinst` | Round 99 (from `places`, `?meshinst=1`, default off): External intervals — an owner's cells, solid to every sim, skipped by the terrain's draws (sim/external.ts) — and an instanced mesh renderer (render/meshinst.ts); trees as instanced meshes (four species, turned and leaning); a rigid rock body at rest stays its mesh with External cells under it (buried under sand it holds it; dug, it becomes ground). Measured a wash on the desktop iGPU (a forest of 704 trees: GPU 5.50 → 5.70 ms). Buildings and characters outlined (BACKLOG MI7, MI8); scripts/meshinsttest.mjs | https://csheldondante.github.io/Reclaimed/meshinst/?skipmenu=1&level=atlas&meshinst=1, https://csheldondante.github.io/Reclaimed/meshinst/?skipmenu=1&level=rocklab&meshinst=1 |
| `collapse` | Round 86 (from `places`): rock collapse and meteors made immediate — a meteor deletes its bowl the next frame with a flash, a shockwave ring, a dust cloud and the rim melted to lava; what it undercut is judged at once (no 0.35 s timer, only the chunks near read back); freed pieces fall in the columns' own format, meshed as the ground (no cubes), crumbling at the foot where they land. Round 88: no floating rock — every run with no way to the ground falls whole, whatever it's made of (scripts/floatsweep.mjs, rockcpu.mjs). Round 92: what holds rock up (a joint's load, the piece above a cut on its columns, tipping — fracture.ts ROCK); the meteor-made floaters (a window slide while a piece fell) fixed; the rock lab (`level=rocklab`) | /Reclaimed/collapse/?skipmenu=1&level=atlas, /Reclaimed/collapse/?skipmenu=1&level=rocklab |
| `collapse` | Round 86 (from `places`): rock collapse and meteors made immediate — a meteor deletes its bowl the next frame with a flash, a shockwave ring, a dust cloud and the rim melted to lava; what it undercut is judged at once (no 0.35 s timer, only the chunks near read back); freed pieces fall in the columns' own format, meshed as the ground (no cubes), crumbling at the foot where they land. Round 88: no floating rock — every run with no way to the ground falls whole, whatever it's made of (scripts/floatsweep.mjs, rockcpu.mjs). Round 92: what holds rock up (a joint's load, the piece above a cut on its columns, tipping — fracture.ts ROCK); the meteor-made floaters (a window slide while a piece fell) fixed; the rock lab (`level=rocklab`). Round 96: thin legs buckle or snap (ROCK.BUCKLE, TENSILE), the knobs on the address and the rock lab's panel, the meteor's rim melts only what's near its height | /Reclaimed/collapse/?skipmenu=1&level=atlas, /Reclaimed/collapse/?skipmenu=1&level=rocklab |
| `ceiling` | The perf ceiling: a heightfield of the atlas's ground only (`?ceiling=1`): GPU 8.4 → 2.5 ms a frame on the desktop's iGPU; the rings' vertices are what's left | /Reclaimed/ceiling/?skipmenu=1&level=atlas&drive=18&perf=lite&ceiling=1 |
| `hybrid` | The hybrid renderer (from ceiling + places): `?hybrid=1` — voxels only in the chunks that need them (forms, gaps open to the air, near the focus, edited), the LOD rings with rock on steep faces everywhere else | /Reclaimed/hybrid/?skipmenu=1&level=atlas&hybrid=1&drive=18&perf=lite |
| `hybrid` | The hybrid renderer (from ceiling + places): `?hybrid=1` — voxels only in the chunks that need them (forms, gaps open to the air, near the focus, edited); round 86 the rest of the window a grid through its own column tops with the voxels' look (storms wet it, sheets run, plants, no square seam), the LOD rings past it | /Reclaimed/hybrid/?skipmenu=1&level=atlas&drive=18&perf=lite |
| `rivers` | Rivers at the atlas's steady state (`?rivers=table`): discharge from each node's watershed, levees, held asleep, drawn flowing, pulled back when woken, scaled by wetness **Merged into places (round 86)**, the atlas level's default | /Reclaimed/rivers/?skipmenu=1&level=atlas&rivers=table |
| `flow` | One interval flow for liquids (`?flow=1`, `level=flowlab`): runs in the columns' gaps, arcing falls, cave streams, lava setting to basalt, near-steady chunks frozen as animation, supply rescaled | /Reclaimed/flow/?skipmenu=1&flow=1&level=flowlab |
| `rivers` | Rivers at the atlas's steady state (`?rivers=table`): discharge from each node's watershed, levees, held asleep, drawn flowing, pulled back when woken, scaled by wetness | /Reclaimed/rivers/?skipmenu=1&level=atlas&rivers=table |
| `flow` | One interval flow for liquids (`?flow=1`, `level=flowlab`): runs in the columns' gaps, arcing falls (round 86: in real time, drawn as a sheet with spray, splash and mist), cave streams, lava setting to basalt, near-steady chunks frozen as animation, supply rescaled; places merged in (round 86) | /Reclaimed/flow/?skipmenu=1&flow=1&level=flowlab |
| `hybrid` | The heightfield for most of the view, voxels only near the focus and where the land needs them (forms, gaps open to the air, edits) (`?hybrid=1`); rock in beds on steep ring faces (also in the default game's rings). GPU 9.0 → 7.7 ms riding (ceiling 3.0); the rest is the sim's whole-window dispatches and the rings' vertices. **Merged into places (round 85)**, the phone tier's default | /Reclaimed/hybrid/?skipmenu=1&level=atlas&hybrid=1&drive=18&perf=lite |
| `simcull` | The sim isn't dispatched over what sleeps (round 85, sim/cull.ts): the passes that skip sleeping chunks run over a list of the live ones, their copies back too; bit-for-bit the same asleep (scripts/culltest.mjs). GPU −0.6 to −0.9 ms a frame on the desktop iGPU after the rivers merge (sim passes −20–30%; water not culled with rivers=table). On by default, `&simcull=0` off | /Reclaimed/simcull/?skipmenu=1&level=atlas&drive=18&perf=lite |
| `slidehitch` | Round 104 (from `places` 78898ba): a slide without a long frame — a region's buffers moved by a compute kernel a dispatch a buffer (not ~28 000 copies a slide), the shift along x one copy a plane, no readback of untouched regions, a loaded body uploaded as it came, the store's hashing spread over frames, the pool evicting what's farthest from where the window heads (BN28); scripts/slideprobe.mjs | https://csheldondante.github.io/Reclaimed/slidehitch/?bench=pan |
| `simscale` | Round 104 (from `places` 1a9b65c): the sims scale with what's active, not the window — water (rivers=table), renderfields, the lava's spill and prisms, the particles' emitters and the projection over the live chunks or what touches them; the wind field only round what painted it; the agents' fields round what they do, relaxed only where something changed (a GPU-built front; `?agentscope=0` off); scripts/simprobe.mjs | /Reclaimed/simscale/ |
| `ringwin` | Round 105 (from `places` d7c3af2): the window on a ring — every per-column buffer and texture addressed by the world cell's place mod the window's size through page-shaped helpers (common.wgsl colIdx / texCol*, sim/ring.ts), so a slide moves nothing on the GPU; `?ringbias=` and scripts/ringtest.mjs the identity test, scripts/ringunit.mjs the CPU's | https://csheldondante.github.io/Reclaimed/ringwin/?bench=pan |
| `frameprobe` | Round 106 (from `places` 8c93cc1): where a frame's time goes and a slide's CPU — docs/FRAMECOST.md (the base frame's GPU passes, the post-slide catch-up, the slide's sync CPU by part); the CPU's per-column arrays on the ring, a slide's freeze region by region as its place is written, the coarse snapshots batched, no slide-wide drowse; scripts/framecost.mjs, scripts/cpugridcheck.mjs | https://csheldondante.github.io/Reclaimed/frameprobe/?bench=pan |
| `watersurf` | Round 107 (from `places` ea4808e): FC2 — the window's water drawn as one surface (render/watersurf.ts, watersurf.wgsl: the lattice of the column centres, the triangles with a wet corner on screen, one indexed draw) instead of a prism a wet column; fsWater's terms worked out only where they show; renderprep's blended list holds the oil and the see-through solids ("blended prisms"); scripts/watersurfshot.mjs, framecost --at | https://csheldondante.github.io/Reclaimed/watersurf/?skipmenu=1&level=atlas |
| `riverfalls` | Round 107 (from `places` 175bff4): WF1 — the held rivers' falls as the flow model's arcing sheet, render-only (render/riverfalls.ts, riverfalls.wgsl: lips from the contract, a parabola by the held speed and heading and the world's gravity, clipped where it meets the columns, drawn by streamVertex / shadeStream; spray, splash and mist budgeted by the discharge; only what the view sees); gravity shared as common.wgsl WORLD_G (the flow model's too); tiles paint a fall's face white; scripts/riverfalls.mjs (find falls, before/after shots); `?falls=0` off | https://csheldondante.github.io/Reclaimed/riverfalls/?skipmenu=1&level=atlas&at=6828,14314 |
| `simtiers` | Round 108 (from `places` d26891c): SM1 — the sims' tiers, live or baked (api/contracts/simtiers.ts, sim/tiers.ts `core.tiers`; common.wgsl tierRate): in the atlas level rain and wind erosion and vegetation growth are baked (the map doesn't change; rain, water, blowing dust, seeds and leaves still show), `tiers.live(processes, rect)` asks for them live, `tiers.bake(rect | 'all', processes, seconds)` runs them between runs or on a story event; `?tiers=live|baked|rain,wind,veg`; scripts/simtierstest.mjs | https://csheldondante.github.io/Reclaimed/simtiers/?skipmenu=1&level=atlas&at=15024,14337 |
| `playground` | Round 108 (from `places` d26891c): AR5 and AR8 - the tuning registry (src/tune: every physics and flow constant a live parameter, CPU groups and Globals.tune for the GPU), the tuning panel with presets (localStorage, JSON, ?tune=), the bug report (B / report button: shot, parameters, camera, time, seed, state, note as JSON + PNG), the physics and water playground (six stations, each with buttons and a reset; the flow model on) | https://csheldondante.github.io/Reclaimed/playground/?skipmenu=1&level=playground |
| `noiselab` | Round 111 (from `places` 9e7779b): TG1-TG7 - the noise lab, an experimental sandbox for terrain recipes (`?level=noiselab`, the title screen's Noise lab): a stack of eight layers (fbm, ridge, billow, voronoi, grouped-cell mesas, sdf shapes, ramps, spires, slope, JFA distance and JFA ridges; grain and radial domains; thresholds, bands, stairs, the atlas's cliff tiers; add, max, min, lerp and smooth blends into the height, four masks and a cave) on the GPU with the atlas's own noise, written into the level as the game's columns and drawn by its renderer, a preview in the panel; the tuning panel as its editor (presets, JSON, ?lab= links); the atlas untouched | https://csheldondante.github.io/Reclaimed/noiselab/?skipmenu=1&level=noiselab |
| `watershed` | Round 109 (from `places` 650b5be): RWS1 — the held rivers' wetness per watershed (the user: "I want it per water shed please"): the climate's (the season) plus each river's storm water from its own catchment and its reaches upstream, lagged down the river (weather/catchwet.ts, the riverWet field, riverheld.wgsl riverWetAt; binding 62). /Reclaimed/watershed/?skipmenu=1&level=atlas | `places` | RWS1 |
| `physfix` | Round 110 (from `places` 650b5be): the rigid rock's four faults in the playground (BACKLOG PX1-PX6) — a rested body stays its mesh, asleep (the resting rock everywhere the rigid rock is; woken, not re-made, when its ground goes), a load break hinges (the arch topples, not a heap), no push-out (hex prism corners, the freed overlap allowed, push-outs at rigid.pushV, deep overlap erodes), the allowed overlap by mass (rigid.slopK, slopP, slopCap); scripts/physfix.mjs (headless), scripts/physfix-cpu.mjs (the judge and bodies on the CPU, no browser) | https://csheldondante.github.io/Reclaimed/physfix/?skipmenu=1&level=playground |
| `physfix2` | Round 112 (from `places` 36ff5fe): the user's five physics reports in the playground (BACKLOG PF1-PF6) — what's built (concrete, brick) freed as a rigid body drawn as its cells (the rock mesh is the field mesh's, which draws none of it: it had vanished), at rest too; a body whose centre of mass is past what it touches topples (no ground damping, not at rest: rigid.balanceGive); thin sections snap (necks from a distance transform and medial axis: rigid.neckStrength, neckDepth, neckMin); sleeping ground streams no grains, and dust is shown by the wind where nothing is lifted (dust.shown); scripts/physfix2.mjs (headless), scripts/physfix2-cpu.mjs (both judges and both kinds of body on the CPU) | https://csheldondante.github.io/Reclaimed/physfix2/?skipmenu=1&level=playground |
| `testspeed` | Round 112 (from `places` 27f0ffa, merged 4ce9840, 5604f5e): tests faster — the shared runner (scripts/lib/runner.mjs: a production build per worktree, kept Chrome profiles, check kinds and GPU leases, sim-time waits, `node scripts/run.mjs status/daemon/boot/selfcheck`), boot marks, the contract tier (contract.html, a system on a tiny world), warm snapshots (src/sim/snapshot.ts, proven equal to a fresh warmup by buffer hash; the player's `?warmcache=1`), the boot's pipelines compiled together off the GPU's main thread (atlas boot 48-52 → 28.5 s; the player's warm cache by default, 2nd visit 19 s); shot/tileprobe/playwater/tilegate ported (BACKLOG TS1-TS18) |
| `agentspike` | Round 107 (from `places` ab286d9): FRAMECOST FC4, the agents' GPU spikes — the front made proportional to what changed (navCost: the fields' own heights and wet, with hysteresis; distances written past 0.05; fields started over when a seed goes or the scope draws in, not counted up; the peel an eighth of the scope a tick; FRONT_CAP chunks a sweep); `?agentprof=1`, scripts/agentspike.mjs | https://csheldondante.github.io/Reclaimed/agentspike/?skipmenu=1&level=atlas |
| `pages` | Round 107 (from `places` ab286d9): phase 2 of the engine (docs/PAGES.md P2.0-P2.3) — the M1 bench (`?pagebench=1`: the page-table lookup computed / in the Globals / in storage at window 256, per dispatch); the page table in Globals.pages (`?pages=table`, the default; `?pages=ring` computes it); page-major per-column buffers and texture page atlases (`?pageperm=<seed>` shuffles the slots: the identity test), page-major region records; the slow turns by world chunk; Sleep, the liquid's counters and the chunk lists by slot; scripts/pagetest.mjs, pageunit.mjs, `?pagecheck=1` | https://csheldondante.github.io/Reclaimed/pages/?pagebench=1 |
| `tileparity` | Round 108 (from `places` d26891c): TC18-TC20, TC8 — a tile is the window's land minus the simulation: one generation path (Atlas.regionInto, MakeHow; the settlements' stamps once planned), the window's SurfaceSystem and RenderFieldsSystem on a tile's land (render/tileworld.ts), a border of its neighbours' cells (no seams), the weather live (weather/cover.ts: snow, wetness, ice past the window; the bake without it, the draw with it), the held rivers' level live (riverWetAt), the atlas never evicting what the screen drew; scripts/tileparity.mjs | https://csheldondante.github.io/Reclaimed/tileparity/?skipmenu=1&level=atlas&at=11956,15471 |
| `tilefast` | Round 112 (from `places` 36ff5fe): a render-only tile's land in a few frames, not 8 (the pacer's tiles' lane in the asker's order, a frame's unused turns as credit for a region's next tile: TilePacer.next(true, order)); the atlas's slots split into halves and quarters at wide zoom (TC21: up to 384 tiles in the same 36 MB; drawn oversized tiles remade smaller); window tiles kept from eviction; the pool's uploads split across frames (0.5 MB a frame on a phone); the pan bench's `missWhy`, slots, pacer, `landFrames`, `?benchzooms=`; scripts/tilefast.mjs | https://csheldondante.github.io/Reclaimed/tilefast/?bench=pan&panwin=256 |
| `tilefix` | Round 112 (from `places` 27f0ffa, with `tilefast` merged): the terrain past the window drawn on every screen — the atlas's budget by the screen's area, a CPU bound for each render-only tile (culled, so evictable; no readback), the look-ahead's grid two points a region; scripts/tilegate.mjs, the merge gate (coverage, frames, golden images in data/baselines/tilegate) | https://csheldondante.github.io/Reclaimed/tilefix/?skipmenu=1&level=atlas |
| `tilefix2` | Round 112 (from `places` 4ce9840): the hero's grey screen (HybridChunks.clear after a warp's writes); the gate by frames (rAF held to 60 Hz, `--loadframes`, fillFrames), golden images by adapter, run=bell and win=384 views, `window-undrawn`; tiles a frame off the phone while the lane is backed up; TF5 the eye side cut, not left out; the pan bench's disk line its full length | https://csheldondante.github.io/Reclaimed/tilefix2/?skipmenu=1&level=atlas&run=bell |
| `tilefix3` | Round 112 (from `places` f946ca4): the camera's zoom floor by the device's tile capacity and fill rate (Camera.zoomFloor, TileCache.zoomFloor); lava in the tiles (renderfields z, tileBake); scripts/herorepro.mjs (a saved world between launches) | https://csheldondante.github.io/Reclaimed/tilefix3/?skipmenu=1&level=atlas&world=new |
| `framepace` | Round 114 (from `places` 3604bc2): the phone's parked frame drops measured — the frame pacing probe (perf/framepace.ts: rAF to submit to GPU done per frame, frames in flight, GPU span and passes, sim ticks, the coarse world's parts), the pan bench's parked `pace` (bench v6: timed, untimed, frames in flight 1 / 3, sim off); the coarse world's step in three parts on three frames (Coarse.stepPart) | https://csheldondante.github.io/Reclaimed/framepace/?bench=pan&panwin=256&benchzooms=14_8_5 |
| `covercheck` | Round 114 (from `places` 3604bc2): why the geometric coverage check missed the stand-in the pixel check saw — the tiles' eye-side cut (a screen-wide wedge round a stale focus) punching a band through the tiles (the user's "screenspace band of low detail"); Camera.focus, the cut near the focus and only over the window; the gate's agreement check (`--agreemax`), 160 c/s pans, window 384 pans; scripts/covshot.mjs | https://csheldondante.github.io/Reclaimed/covercheck/?bench=pan&panwin=256&benchzooms=14_8_5 |
| `tilesfirst` | Round 113 (from `places` 5281b21): the streaming design's steps (BACKLOG SF1-SF6) — the chain timed and the geometric coverage check (render/coverage.ts), the stand-in, tiles as cover, the planner, the height grid | https://csheldondante.github.io/Reclaimed/tilesfirst/?skipmenu=1&level=atlas&world=new |
| `worldstore` | Round 114 (from `places` 3604bc2): saved worlds and generator versions — GEN_VERSION a hash of the generator's sources at build time (scripts/lib/gen-sources.mjs), records of another generator dropped as the store opens, the world id with the atlas options, a run its own world each run (`?runinst=`), scripts/worldstale.mjs and gendeterm.mjs | https://csheldondante.github.io/Reclaimed/worldstore/?skipmenu=1&level=atlas |
| `tilecal` | Round 115 (from `places` 3c850b9): the tiles calibrated to the device and the screen (the user's wide monitor) — the land's fill rate measured (render/tilecalib.ts), the zoom floor by the screen's own regions in 5 s at that rate, the atlas grown in place within a memory budget; the tile gate's ultrawide screens, scripts/fillprobe.mjs | https://csheldondante.github.io/Reclaimed/tilecal/?skipmenu=1&level=atlas |
| `testkit` | Round 117 (from `places` bcd4198): the test pyramid (docs/TESTING.md, BACKLOG TK1-TK11) — `npm test`: the unit tier (vitest in Node, ~2 s) and the gpu tier (real WGSL on Dawn in Node via the npm `webgpu` package, a real WorldCore on a 32 x 32 world, ~15 s); `npm run smoke` (the built atlas booted headless, ~40 s); first tests: the tick clock, the world state (a snapshot aliasing its factions: fixed), the region record and generator hash, the External registry, buried statues un-buried (no launch; a thing hanging from the ground over it: TK4) | https://csheldondante.github.io/Reclaimed/testkit/?skipmenu=1&level=atlas |
| `terrain` | Round 117 (from `places`, testkit merged): the terrain track (BACKLOG TR1-TR17) — rivers off the texel grid with eroded banks, bars, boulders, cascades and plunge pools; the region graph (api/contracts/terrain.ts: features, rooms 1-3 screens, borders with measures, costs per controller); requests for exits and obstacles (ramps, fords, walls stamped; bridges, vegetation as needs); the basin flood on the GPU (water, sand, magma) into the lakes' table; the viewer ?terrain=view; scripts/perf/terrain.mjs | https://csheldondante.github.io/Reclaimed/terrain/?terrain=view , https://csheldondante.github.io/Reclaimed/terrain/?skipmenu=1&level=atlas&at=6108,14009 |
| `structures` | Round 117 (from `places`): buildings, districts and cities (ARCHITECTURE "Structures", BACKLOG STR1-STR17) — contracts/structures.ts; tile systems (irregular, contour-voronoi, radial, orthogonal) to one quad mesh, massing, WFC façades, warped module instances (hearth, bastion, terrace), roofs from one height rule, baked nav (stairs, doors, lifts, ramparts), External column spans, buriable assets; linear features (roads graded over the ground, viaducts, town walls), mega tiles (domed temple, keep), a far look by zoom, towns into the earth, growth as stored progress; the viewer structures.html; the city on the atlas `?city=<system>` | https://csheldondante.github.io/Reclaimed/structures/structures.html , https://csheldondante.github.io/Reclaimed/structures/?skipmenu=1&level=atlas&city=irregular&croads=2 |
| `inhabitants` | Round 117 (from `places` 140b4e3, merged 8bd557b): creatures with bodies (docs/INHABITANTS.md, BACKLOG IN1-IN13) — the Inhabitants contract, a body generator for seven plans with gear and fur, Rain World-style procedural animation on the GPU (planted feet, IK, verlet tails/capes in the wind, wings), herds, stalking wolves, flocks, townsfolk on paths, a dragon's breath and wing beats through the fire/lava/wind systems; drawn as low-poly meshes, bigger than life when zoomed out. `?life=1|dragon|town`, the viewer `?level=bestiary&life=viewer` | https://csheldondante.github.io/Reclaimed/inhabitants/?skipmenu=1&level=atlas&life=1, https://csheldondante.github.io/Reclaimed/inhabitants/?skipmenu=1&level=bestiary&life=viewer |
| `bgcheck` | Round 112 (from `places` c885679): the background colour measured on the GPU (render/bgcheck.ts, ?bgcheck=1: the world pass's depth and pick sampled 64 x 128, the far land told apart by its pick tag) in the pan bench (flag, ?bgfail=1 fail) and scripts/tilegate.mjs (fails over 0.1%) | (deployed by `places`) |
| `playwater` | Round 110 (from `places` 650b5be): one water path — the playground runs the game's water (the pipes, its river held at an authored river table as the atlas's: world/rivertable.ts → riverFlow, sleep and settle-then-freeze); LevelDef.rivers (the river mode is the level's, not the URL's); ?flow=1 the flow lab's only | https://csheldondante.github.io/Reclaimed/playwater/?skipmenu=1&level=playground |
