# Tooling — the fast loop for behaviour checks

Round 128l (`tooling`). The user: "development seems to have slowed considerably … I would like to speed up
iterations if possible." Measured in the agents' transcripts (2026-11-04): 55-70% of an agent's wall time was headless
browser runs and waiting on them — `scripts/fortresslanes.mjs` ran 53 times at ~75 s, `scripts/fortressoutside.mjs`
7 times at ~3.7 min. Each one boots `?level=atlas` (the atlas, the window, the old town: ~70 s before anything can be
planned) and then plays in real time. Typecheck (~8 s) and the unit tests were never the problem.

## The loop, cheapest first

1. **Unit tests for logic** (`npx vitest run src/fortress`, docs/TESTING.md): a rule, a plan, a field's numbers. Seconds.
2. **A lab scenario for behaviour** (`node scripts/lab.mjs run scripts/lab/<x>.mjs`): workers walking, building,
   hauling, roads ridden — the real systems on a small world, in a page kept open. 9-60 s.
3. **The full-game scripts only at the gate** (`scripts/fortressoutside.mjs`, `fortresslanes.mjs`, the town bench …):
   the atlas's land and its own town, by finger at the phone's size. Once, before handing a branch over.
4. **The full suite at commit**: `npm run typecheck`, `npx vitest run`, and the gate's scripts.

## The behaviour lab

`?level=lab&lab=<recipe>` (src/lab/; docs/ARCHITECTURE.md "The behaviour lab"): a fixed 320² window (256² before round 128m: the fortress's box must lie in it) of a recipe's
land made on the CPU (no atlas, no generation, a 120-tick warmup), the real fortress on the lab's own town, its builders
the real FortressLife on the real agents, its pieces drawn by the structures draw, its built blocks claimed in the
columns. Recipes (src/lab/recipes.ts):

| recipe | land |
|---|---|
| `flat` | a dry plain; a wood to the north-east |
| `hill` | the plain with a broad hill east of the heap (about 1 in 5 on its flanks: stepped lanes) |
| `valley` | two slopes down to a river east of the town, a lake at its foot |
| `plateau` | (round 128m) a dry plain 44 m up the window (the others lie at 10): room under it for a quarry's pit (scripts/lab/quarry.mjs, quarrygif.mjs; scripts/lab-gif.mjs joins a scenario's shots into a GIF) |
| `town` | (round 128m) **the user's start town**: the window the game made round it on the user's link (`?town=1&fortress=1&fresh=1&q=low`), loaded from `data/lab/town.rclt`: its land, rivers and sea, its buildings in the columns (solid, not drawn), its heap, doors and gate posts; the fortress's box where the game has it. Capture it again with `node scripts/labtown.mjs capture` when its test says it's stale (GEN_VERSION) |
| `walled` | the flat plain with a small walled town already standing round the heap, its gate east (the atlas's starting town, small) |

A recipe is a few lines: the ground's height as a function, water, springs and woods, the heap (the stores until a
warehouse stands) and the houses' doors, and what of the fortress stands at the start (`town`).

### The scenario API (`reclaimed.lab` in the page; src/lab/lab.ts)

| call | what |
|---|---|
| `place(kind, x, y, {level, built})` | one block of a structure type (or `'gate'` on a wall cell) at window world (x, y) |
| `plan({at, walls: {r, gate}, blocks: [{type, d, level}], cells: [{type, at, level}], built})` | a whole plan at once: a ring of wall round `at` (default the heap) with a gate on a side, blocks by offset or position; `built: true` stands it at once. Returns `{cells, types, cutOff, skipped}` (a block whose cell the ring took is skipped, not an error) |
| `drag(kind, x0, y0, x1, y1)` | (RT-6) the cells along a line placed together (`Fortress.paintMany`): the reach judges them as one batch and refuses only those out of reach (`fortress().refusal` says how many). Returns the cells |
| `standAll()` | every planned block standing at once |
| `stores({stone: 200})` | set the stores |
| `build()` / `planMode()` | the bar's Build and Plan (the game's own buttons) |
| `sims('all' \| 'fortress' \| [names])` | which of the sim's systems tick. `fortress` leaves out the land's slow processes (oil, contamination, moisture, fire, sediment, climate, cover, wilt, ecology, lava, sway, wind, particles, stats): about twice the sim seconds a wall second. `reset()` puts `all` back |
| `run(seconds, speed = 16, {renderEvery = 8, keep, dt})` | `seconds` of **sim** time at the game's `speed`, as fast as the GPU goes: the display's frames wait, the lab steps the scene a frame after another (each once the GPU has done the last), drawing every Nth. Time stops after (unless `keep`). `dt` (default 1/60: every tick runs) is a frame's wall time; `0.1` is the game's longest frame — the people step 0.1 × speed while the world's ticks are capped (the tier's maxTicksPerFrame × speed), as on a loaded phone at 16x: ~10x real time, but the walkers cover less ground a sim second (fortressoutside: 304 s to reach the sites against 90-121). Returns `{simSeconds, frames, wallMs, xRealtime}` |
| `snapshot()` | JSON: sim time, mode, progress, stores, people, jobs, every walker (where, state, phase, job, on a road or not), the roads (shapes, walking, on a road, the roads' share of the ground round the walkers, which legs ride the road graph), structures (cells, planned and built blocks), cut off, the bar's note, the builders' stats |
| `look(x, y, zoom)` / `await shot(name)` | the camera; a screenshot after two drawn frames (the runner saves `<name>.png`) |
| `await reset()` | the builders gone, the plan erased, the land as it opened (WorldCore.restoreChunks), the stores refilled, the recipe's town put back |
| `raid()` | (round 128l, m4) the attack wave (fortress/raiders.ts): `state()`, `callNow()`, `clock`; `lab.sims('raid')` adds the fire and the particles to the fortress preset |
| `heap`, `recipe`, `dims`, `ground(x, y)`, `fortress()`, `life()`, `units` | where things are; the game's own objects for what the API doesn't cover |

### The runner (`scripts/lab.mjs`)

(round 128m) A worktree's ports come from a hash of its path, and two can meet: set `RECLAIMED_PORT` (e.g. 7540) to give yours its own.

```
node scripts/lab.mjs run scripts/lab/example.mjs [--recipe hill] [--args '{"seconds":40}'] [--out dir] [--reload]
node scripts/lab.mjs serve | status | stop
```

`run` starts the lab server if it isn't up (one headless Chrome on this worktree's own profile slot, one lab page, its
own static server — never shared with other checks, so stopping it can't pull a page from under one), sends it the
scenario and prints the page's console, the shots and the scenario's JSON result. Each run: the build checked (cached
by the sources' content; ~2-4 s when something changed); the page **reloaded only when the build or the recipe
changed** (or `--reload`, or the last run left the fatal overlay), otherwise **`lab.reset()` on the same page** — no
boot, no pipelines compiled again. The GPU is leased as a behaviour check for the run (shared with other worktrees'
checks: scripts/lib/runner.mjs). The console lines also go to `.testcache/lab-serve.log` as they come (tail it to
watch a long scenario). `stop` closes Chrome and the servers.

### Writing a scenario

An ES module whose default export runs **in the page** (no closures over the module's variables; `args` comes from
`--args`):

```js
export const recipe = 'flat'; // optional; --recipe overrides
export default async function (lab, args) {
  lab.sims(args.sims ?? 'fortress');
  const [hx, hy] = lab.heap;
  lab.plan({ cells: [{ type: 'house', at: [hx + 12, hy + 6] }, { type: 'farm', at: [hx + 20, hy - 8] }] });
  lab.build();
  await lab.run(20, 16);
  await lab.shot('after');
  return lab.snapshot(); // printed as JSON
}
```

Or a plain `.js` file: the body of `async (lab, args) => { … }` — handy for a one-off probe. Throw to fail the run
(the runner exits non-zero). Examples: `scripts/lab/example.mjs` (the template), `scripts/lab/fortressoutside.mjs`
(do the builders get out of a walled town to sites outside it), `scripts/lab/fortressrefuse.mjs` (unreachable placements refused: a house on the valley's lake, a block in a shut ring, a drag across the lake), `scripts/lab/fortresslanes.mjs` (the lanes of a walled
site, and the share of walking on them).

## The field mesh's rebuilds (round 128o, DA-B28)

`node scripts/meshderisk.mjs --url http://127.0.0.1:PORT [--nofort] [--pan 30]` on a dev server of your own port: the
atlas at rest, building (with the fortress), in a storm's rain, panning (slides), after; per phase the mesh chunks
rebuilt a frame and the fieldmesh passes' GPU ms, and for the pan by frames since a slide. Run on two builds for a
rebuild count and a toggle diff. It loads the GPU: only when the timing runs are yours.

## The placement bench (round 128m)

The user's phone: `/?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low&bench=place` (`&placetypes=house,wall`
fewer types, `&placearrive=300` the arrival check's sim seconds). Each building type at 31 points round the start town,
the reach's answer and the panel's line, tap CPU, the answer's delay, frames; then whether builders reach houses at the
points. A summary on screen and a report downloaded. The same on the desktop:
`node scripts/placebench.mjs [--types house]` (the user's link at 412x915, the report and a shot of the summary in
`.testcache/placebench/`) and `node scripts/lab.mjs run scripts/lab/placebench.mjs` (the lab's `town`, ~2 min).

## Measured (2026-11-04, Intel Arc 140T iGPU, other agents' checks sharing the GPU)

| | before (atlas scripts) | the lab |
|---|---|---|
| boot to plannable | 67-70 s (atlas level 55-67 s, the fortress ready ~5-10 s after) | 11-20 s on a reload (pipelines 6-13 s of it); `walled` +4 s for its town |
| a scenario again, same build | a full boot every run | `reset()` 0.5 s (`walled`: 4.7 s, its town re-planned) |
| edit a scenario → result (example.mjs: plan, build, 20 sim s) | — | **8.9 s** (reset 0.5 + scenario 8.1) |
| edit game code → result (example.mjs) | — | ~25 s (build 2-4 + reload 13 + scenario 8) |
| fortressoutside | ~3.7 min | 39 s (reset) - 61 s (reload) for 90-121 sim s |
| fortresslanes, one site | ~75 s (40 s of wall at 6x, sim time unknown) | 74-92 s for 100 sim s; the defaults now 60 sim s |

The sim itself is the ceiling: on this GPU the world's tick costs ~4-7 ms (256², every system) and ~12 ms once the
builders' fields run, so `run()` manages 1.5-3x real time at 16x (`sims('fortress')` about doubles it). Behaviour
scenarios should ask for the sim seconds they need, not more.

## When to use which

- A rule, a number, a plan's shape → a unit test (no browser).
- How the people behave on a plan (reach, routes, roads, jobs, timings in sim seconds) → a lab scenario.
- Anything about the atlas's land, its towns, streaming and slides, the phone's frame time, or the player's fingers on
  the real UI → the full-game script, at the gate (the lab's window never slides, its land isn't the atlas's, its town
  has no settlement buildings — only fortress blocks).
- Frame cost → a timing check alone on the GPU (scripts/lib/runner.mjs `kind: 'timing'`) or the phone bench, never the
  lab.

## Found on the way (not fixed here: BACKLOG TL-5..TL-7)

- **Every boot compiles ~9 MB of WGSL** (115 modules, the shared prelude prepended to each, ~80 KB a module):
  `pipelines` is 6-13 s of every level's boot even with a warm Dawn cache; the slowest single pipeline
  (`sediment-out`) takes ~7.5 s alone.
- **~60 pipelines were made outside the level's batch** (attach: agents, physics, the structures draw …) and compiled
  one at a time at their first use, holding the first frames 10-18 s. Now attach runs inside the batch
  (`attach-pipelines` boot mark); the agents' first surfaces and the fortress's first surface read wait for it
  (gpu/pipeline.ts `whenPipelinesReady`).
- **A fortress block's placement runs the reach check over the whole box** (fortress/reach.ts ReachMap): ~140 ms a block,
  4-5 s for a 33-block plan (more on a loaded machine).

### Town roads in the lab (round 128p, DA-A13)

- `lab.edges({spokes, off})` draws the paths on the grid's edges (paved, buildings inset) in place of the lanes, and
  returns the reach.
- `lab.edges({hybrid: true, drawn, place, far, radial})` lays the town's roads (build/townroads.ts) first.
- `node scripts/lab.mjs run scripts/lab/edges.mjs` and `scripts/lab/hybrid.mjs` (recipe `town`) take shots at play zoom.
- `EDGE_OUT=<dir> npx vitest run --project unit edgetown` writes the map previews.
- `node scripts/lab.mjs run scripts/lab/townroads.mjs`: the start town's generated roads, and a far lumber camp painted
  (the edit's grown road).
