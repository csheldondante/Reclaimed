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
| `perfopt` | `C:/Projects/Reclaimed-perfopt` | `npm run dev -- --port 5211` |
| `ceiling` | `C:/Projects/Reclaimed-ceiling` | `npm run dev -- --port 5215` |
| `hybrid` | `C:/Projects/Reclaimed-hybrid` | `npm run dev -- --port 5235` |
| `rivers` | `C:/Projects/Reclaimed-rivers` | `npm run dev -- --port 5219` |
| `flow` | `C:/Projects/Reclaimed-flow` | `npm run dev -- --port 5223` |
| `dialog` | `C:/Projects/Reclaimed-dialog` | `npm run dev -- --port 5227` |

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
| `seawall` | Round 88 (from `places`): the sea held over a raised window floor — the sea's columns cut off under the floor (a warp or a slide up by a coast) hold the sea from the floor to its level instead of coming in dry and draining ("a steep wall of water"); scripts/seawall*.mjs | https://csheldondante.github.io/Reclaimed/seawall/?skipmenu=1&level=atlas&at=11600,18213 |
| `collapse` | Round 86 (from `places`): rock collapse and meteors made immediate — a meteor deletes its bowl the next frame with a flash, a shockwave ring, a dust cloud and the rim melted to lava; what it undercut is judged at once (no 0.35 s timer, only the chunks near read back); freed pieces fall in the columns' own format, meshed as the ground (no cubes), crumbling at the foot where they land. Round 88: no floating rock — every run with no way to the ground falls whole, whatever it's made of (scripts/floatsweep.mjs, rockcpu.mjs) | /Reclaimed/collapse/?skipmenu=1&level=atlas |
| `ceiling` | The perf ceiling: a heightfield of the atlas's ground only (`?ceiling=1`): GPU 8.4 → 2.5 ms a frame on the desktop's iGPU; the rings' vertices are what's left | /Reclaimed/ceiling/?skipmenu=1&level=atlas&drive=18&perf=lite&ceiling=1 |
| `hybrid` | The hybrid renderer (from ceiling + places): `?hybrid=1` — voxels only in the chunks that need them (forms, gaps open to the air, near the focus, edited), the LOD rings with rock on steep faces everywhere else | /Reclaimed/hybrid/?skipmenu=1&level=atlas&hybrid=1&drive=18&perf=lite |
| `hybrid` | The hybrid renderer (from ceiling + places): `?hybrid=1` — voxels only in the chunks that need them (forms, gaps open to the air, near the focus, edited); round 86 the rest of the window a grid through its own column tops with the voxels' look (storms wet it, sheets run, plants, no square seam), the LOD rings past it | /Reclaimed/hybrid/?skipmenu=1&level=atlas&drive=18&perf=lite |
| `rivers` | Rivers at the atlas's steady state (`?rivers=table`): discharge from each node's watershed, levees, held asleep, drawn flowing, pulled back when woken, scaled by wetness **Merged into places (round 86)**, the atlas level's default | /Reclaimed/rivers/?skipmenu=1&level=atlas&rivers=table |
| `flow` | One interval flow for liquids (`?flow=1`, `level=flowlab`): runs in the columns' gaps, arcing falls, cave streams, lava setting to basalt, near-steady chunks frozen as animation, supply rescaled | /Reclaimed/flow/?skipmenu=1&flow=1&level=flowlab |
| `rivers` | Rivers at the atlas's steady state (`?rivers=table`): discharge from each node's watershed, levees, held asleep, drawn flowing, pulled back when woken, scaled by wetness | /Reclaimed/rivers/?skipmenu=1&level=atlas&rivers=table |
| `flow` | One interval flow for liquids (`?flow=1`, `level=flowlab`): runs in the columns' gaps, arcing falls (round 86: in real time, drawn as a sheet with spray, splash and mist), cave streams, lava setting to basalt, near-steady chunks frozen as animation, supply rescaled; places merged in (round 86) | /Reclaimed/flow/?skipmenu=1&flow=1&level=flowlab |
| `hybrid` | The heightfield for most of the view, voxels only near the focus and where the land needs them (forms, gaps open to the air, edits) (`?hybrid=1`); rock in beds on steep ring faces (also in the default game's rings). GPU 9.0 → 7.7 ms riding (ceiling 3.0); the rest is the sim's whole-window dispatches and the rings' vertices. **Merged into places (round 85)**, the phone tier's default | /Reclaimed/hybrid/?skipmenu=1&level=atlas&hybrid=1&drive=18&perf=lite |
| `simcull` | The sim isn't dispatched over what sleeps (round 85, sim/cull.ts): the passes that skip sleeping chunks run over a list of the live ones, their copies back too; bit-for-bit the same asleep (scripts/culltest.mjs). GPU −0.6 to −0.9 ms a frame on the desktop iGPU after the rivers merge (sim passes −20–30%; water not culled with rivers=table). On by default, `&simcull=0` off | /Reclaimed/simcull/?skipmenu=1&level=atlas&drive=18&perf=lite |
