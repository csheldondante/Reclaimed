# Tooling — the fast loop for behaviour checks

Round 128l (`tooling`). The user: "development seems to have slowed considerably … I would like to speed up
iterations if possible." Measured in the agents' transcripts (2026-11-04): 55-70% of an agent's wall time was headless
browser runs and waiting on them — `scripts/fortresslanes.mjs` ran 53 times at ~75 s, `scripts/fortressoutside.mjs`
7 times at ~3.7 min. Each one boots `?level=atlas` (the atlas, the window, the old town: ~70 s before anything can be
planned) and then plays in real time. Typecheck (~8 s) and the unit tests were never the problem.

## The loop, cheapest first

1. **Unit tests for logic** (`npx vitest run --project unit`, docs/TESTING.md): a rule, a ledger, a field's numbers. Seconds.
2. **GPU kernel tests on Dawn** (`npx vitest run --project gpu test/gpu/<x>.test.ts`): a town's routes, its riders.
3. **A lab scenario at the gate** (`node scripts/lab.mjs run scripts/lab/<x>.mjs`): the town game itself at Muru,
   driven by a script — ~60 s a load, the scenario's sim after. Once, before handing a branch over.
4. **The full suite at commit**: `npm run typecheck`, `npx vitest run`, and the gate's scripts.

## The town lab (switchover, 2026-11-10; the behaviour lab of round 128l before)

The behaviour lab — `?level=lab&lab=<recipe>`, the fortress on small CPU-made land — went with fortress mode and the old
towns (docs/design/SWITCHOVER.md). The lab page is now **the town game itself**: `?skipmenu=1&level=atlas&town=1&fresh=1`
with `&lab=1` (and the runner's `tutorial=0&warmcache=0&q=low&tod=0.3&day=100000`) — the atlas at Muru, its GPU town,
living town and season loop, 412 × 915. `?lab=1` installs `reclaimed.lab` (src/lab/lab.ts) once the start town is made,
its people given and its first hand dealt.

### The scenario API (`reclaimed.lab`)

| | |
|---|---|
| `ready`, `town` | the lab is ready; the start town's id (`s84`, Muru, on the default world) |
| `towns`, `living`, `season` | the game's objects: FieldTowns (citygen/towns.ts), LivingTowns (citylife/towns.ts), SeasonLoop (season/loop.ts) |
| `run(seconds, speed = 16, {renderEvery = 8, keep, dt})` | `seconds` of sim (the world's ticks) at `speed`, as fast as the GPU goes: the lab steps the scene itself, the display's frames wait, drawing every Nth. Time stops after unless `keep`. The towns' clock runs with the frames' dt: set a season's stages at once with `season.skip()` |
| `look(x, y, zoom, aimY = 0.32)` | the camera on a window point, sat `aimY` down the screen (above the card sheet) |
| `shot(name)`, `project(x, y, z)`, `viewport()`, `ground(x, y)` | a screenshot (the runner saves it); a window point on the screen; the screen; the ground's height |
| `riders(id)` | (debug read) a living town's rider rows (routes.wgsl Rider, 16 words: pos, heading, job/state/leg, route, …, goal) and where its grid is in the window |

### The runner (`scripts/lab.mjs`)

```
node scripts/lab.mjs run scripts/lab/townfollow.mjs [--args '{"seconds":90,"shots":true}'] [--out dir] [--flags "&perf=1"]
node scripts/lab.mjs serve | status | stop
```

One headless Chrome and one lab page per worktree build (its own server; `RECLAIMED_PORT` gives a worktree its ports:
the page's server at it, the lab's control at +8). The page is loaded again for every scenario — the town game's world
can't be put back — its storage cleared first. A scenario is an ES module run in the page:

```js
export default async function (lab, args) {
  const S = lab.season;
  S.start(S.hand.findIndex((o) => o.card.id === 'houses'));
  await S.next();
  S.skip();
  await lab.run(6, 8);
  await lab.shot('after');
  return { left: S.left };
}
```

### Gates

- `scripts/lab/townfollow.mjs` — one living-town person at Muru followed: rides its route (its distance along it moves
  forward, its place moves), reaches its destination (the leg ends, its job steps on), on screen above the card sheet,
  no page error. `{"shots":true}` saves follow_000 … (scripts/lab/frames2gif.mjs joins them).
- `scripts/lab/townseason.mjs` — two seasons with a walls card (and houses, then farms): districts claimed on the GPU and
  staged (the town's edit log), the wall's ring made and risen (posts on its saved pieces), the save point written
  (`season:<x>,<y>` in the world store), no page error.

## The field mesh's rebuilds (round 128o, DA-B28)

`node scripts/meshderisk.mjs --url http://127.0.0.1:PORT [--pan 30]` on a dev server of your own port: the
atlas at rest, in a storm's rain, panning (slides), after; per phase the mesh chunks
rebuilt a frame and the fieldmesh passes' GPU ms, and for the pan by frames since a slide. Run on two builds for a
rebuild count and a toggle diff. It loads the GPU: only when the timing runs are yours.

## Measured (2026-11-04, the behaviour lab of the time — kept for the record; Intel Arc 140T iGPU)

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

- A rule, a number, a ledger's shape → a unit test (no browser).
- A kernel's behaviour (routes, riders, claims) → a GPU test on Dawn on a tiny world.
- The town game as played (the season loop, the living town, saving, streaming) → a town lab scenario, at the gate.
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
