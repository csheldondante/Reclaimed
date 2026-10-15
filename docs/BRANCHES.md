# Branches

One engine, several games (DECISIONS round 33). Each line of work lives on
its own long-running branch, cut from `story` at 9f83137 (main + the story
rules + the level tools + the event fix). Fixes to the shared engine
(sim, render, tooling) go to `ambient` first and are merged or
cherry-picked into the others; each branch's own work stays on it. `main`
is what GitHub Pages deploys: it follows `ambient` until the user says
otherwise.

| Branch | Game | Builds on | Backlog |
|---|---|---|---|
| `ambient` | Reclaimed as it is: the chill ambient game (Free play, the story rules) | everything to date | the main backlog |
| `puzzle` | Puzzle mode: levels as a DAG of gates, abilities as a toolkit | the level kit, map preview, gate validator, the Trial Grounds | R6–R10, docs/LEVELS.md |
| `mayhem` | FEMA Mayhem: an automated city that responds to disasters; the player only breaks things with weather | powers, structure collapse, fire, floods, people as agents | X1 |
| `sandbox` | World editor: place and modify prefabs, raise mountains, shape the land with wind, rain, meteors, volcanoes | the sandbox brushes (edit.wgsl), stampGrid models, bedrock uplift | X4 |
| `hex` | Experimental terrain engine: sediment and wind on a hex grid; interlocking grids that share data, so WFC can build on irregular grids | the sim systems and their contracts | X5 |

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
poison/oil leak (R10), seed caches waking (R9), levels from the catalogue
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

## hex

An experiment in the terrain engine itself, kept apart so the game
branches don't depend on it until it proves out.

1. **Hex sim grid.** Sediment (slope relaxation, erosion, deposition) and
   the wind field on a hex grid instead of the square columns. Six equal
   neighbours remove the square grid's diagonal bias: dunes, talus and
   wind shadows come out round instead of diamond-shaped. Axial
   coordinates stored row-offset in flat GPU buffers; same kernel
   structure, six fluxes per cell instead of four.
2. **Interlocking grids.** Several grids over the same world, each good at
   something: the hex grid for the sim, square voxel columns for
   rendering and structures, and an irregular grid for buildings. Each
   pair has a precomputed overlap (which cells of one cover which of the
   other, with area weights), so any field can be read across: the
   irregular grid samples height, slope, moisture and wind from the hex
   grid (area-weighted), and writes back what it puts there (occupancy,
   roughness that slows the wind, roofs that shed rain).
3. **Irregular grid + WFC.** A Townscaper-style grid: hexes split into
   triangles, merged into quads, relaxed into an organic mesh. Wave
   function collapse on it places houses, walls, farmland and trees,
   stacking upward where it's dense — driven by the fields it reads from
   the hex grid (flat, dry, near water).

Measure against the square grid at each step (the DEVLOG rule): frame
time per system, and pictures of the same dune field and the same storm
on both grids.
