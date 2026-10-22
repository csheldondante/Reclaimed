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

| Branch | Game | Builds on | Backlog |
|---|---|---|---|
| `ambient` | Reclaimed as it is: the chill ambient game (Free play, the story rules) | everything to date | the main backlog |
| `puzzle` | Puzzle mode: levels as a DAG of gates, abilities as a toolkit | the level kit, map preview, gate validator, the Trial Grounds | R6–R10, docs/LEVELS.md |
| `mayhem` | FEMA Mayhem: an automated city that responds to disasters; the player only breaks things with weather | powers, structure collapse, fire, floods, people as agents | X1 |
| `sandbox` | World editor: place and modify prefabs, raise mountains, shape the land with wind, rain, meteors, volcanoes | the sandbox brushes (edit.wgsl), stampGrid models, bedrock uplift | X4 |
| `grids` | The map engine generalised: intersecting grids (a hex nature grid of material intervals, a rectangular voxel grid for structures, an irregular grid for WFC buildings) that read and write each other's data | the sim systems and their contracts | X5 |

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
