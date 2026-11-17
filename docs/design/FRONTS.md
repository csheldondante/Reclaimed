# Hazard fronts and shields (loop round 12)

The owner: "Watch the shield you raise divert a pyroclastic flow around your city and preserve it for the ashen
world." "The fluid flow is cool but we don't have a great way to make a magma river head toward a town or anything."
"target the MVP for making this possible as cheaply and easily as possible. We already built a ton of cool systems".

A **front** is a live event's hazard: a liquid poured at a source and left to run downhill to a place. A **shield** is a
spell: a disc the liquid cannot flow into, so the front parts round it. Both are general (any pack card's event may
start a front; any pack ability may raise a shield); neither is a set piece.

## What carries it (existing systems)

| Need | System | Where |
|---|---|---|
| The liquid itself, downhill, cooling to rock | The flow model's lava and water (`LiquidSystem`, the same kernels with two liquids' numbers); lava sets into basalt in the columns as it cools — the land is really changed | `src/flow/liquid.ts`, `src/shaders/liquid.wgsl` (installed in every world since trackA-liquids) |
| A source | `LiquidSystem.addSpring(x, y, z, rate)` | as above |
| Where it runs | The ground as it is. The source is chosen **uphill**: the highest of 16 points on a ring `far` cells round the target, read once from the ground's pages as the fire hazard reads its stalls' ground (`terrain.load`) | `live-runner.ts` |
| The sim awake where it runs | The sleep mask and the hybrid's filter: the front touches the chunks between its source and its target (`hybrid.edit`, `sleep.wake`) each second while it runs — sleeping chunks freeze liquid, and the hybrid lets only touched or voxel chunks wake (found by probe, round 12: a spring 80 cells out poured nothing until its chunks were touched) | `live-runner.ts` |
| What it reached | Points in the town (`points` within `spread` of the target) and along the way, read every 2 s through the world API's mirror (a few KB of pages; the fire hazard's pattern) | `api/fire.ts flowLavaAt`, `api/water.ts depthAt` |
| What it leaves | The realm's land mutators at every reached point (`melted` for lava: lots `destroyed`; `flooded` for water: lots `drowned`), saved and drawn on the map like any other; with nothing played, one change round the target as wide as the share reached | `season/realm.ts finishLive` (`frontLand`) |
| Its result | The live event's `burned` count (read as `reached`): points reached, out of `points` | `living/live.ts` |
| The camera | The live event's camera: (round 13) the front's head (the source before it reaches anything) and the town it runs at, both in the frame, so the player casts the ward from the event's own view; once a shield is up, the shield's disc and the head; the zoom no closer than that span fits in 0.85 of the screen's width (`frontFrame`, FRONT_FIT) | `live-runner.ts` |

## What is new

1. **Shields in the liquid** (`liquid.wgsl shielded`, `LiquidSystem.shields`): up to 4 discs in the liquid's uniform.
   A column whose centre lies inside one is a wall to flux and to falling streams from outside. Liquid already inside
   drains out. Tested on Dawn: `test/gpu/shield.test.ts` (lava parts round the disc, both sides, none inside).
2. **`Shields`** (`src/api/shields.ts`): raise (x, y, radius, seconds), expire, move with the window's slides, give the
   discs to both liquids, and show the dome through the effects system. (Round 13: round 12's look — 32 soft glows a
   fifth of a second — was a few faint arcs at phone size.) Now the particles' glows place a whole ring from one burst
   request on the GPU: a wall of bright beads round the rim, each on the ground where it stands, 0.3–3 cells up, and a
   faint haze over a dome half as high as wide; the cast is a ring spreading from the middle to the rim in 0.8 s and
   streaks of light thrown up as it closes; the last 3 s flicker and the end throws streaks off the rim; where hot lava
   presses on it the wall flares white (the lava kernel's own particles, `liquid.wgsl publishLava`: the CPU does not
   know where the lava is).
3. **A front hazard** in `LiveDef.hazard`: `{ kind: 'front', liquid: 'lava' | 'water', at, far, rate, pour, points,
   spread, mutate }`. The pack word: an event's `hazard: { "kind": "lava" | "flood", ... }`.
4. **The shield spell** as a pack ability: `in_event: { kinds: [...], shield: <radius>, seconds?: <n> }`.

## Departures and limits (each is a BACKLOG item)

- **The channel is chosen, not carved.** The brief allowed "a carved or chosen channel". The source is the highest
  point on a ring round the target; lava runs down the ground as it is. On ground that falls away from the town on
  every side, nothing reaches it — that is the land's truth. Carving a channel (edits along the way) would force it;
  not done.
- **Lava is thick (measured, LS-122).** The flow model's lava has a yield (0.12 a cell) and thins out: on Muru's
  flat valley it piles round its vent and stops 25-40 cells out whatever it pours (90 out at 40/s: 1 of 10 way points;
  45 out at 300/s for 60 s: 6 of 10 and 1 of 8 in the town). The example pack's source is therefore 36 cells out,
  220 a second: a vent opening on the slope above the town, not a mountain far off. A river of magma that runs far
  needs the rheology changed (heat-dependent yield) — the owner's call.
- **The source is read on the CPU once** (16 heights from the terrain mirror's pages at the event's start, the fire
  hazard's pattern). The rule is world queries on the GPU; a GPU pass for 16 samples was judged not worth it this
  round. Tagged in code; BACKLOG.
- **The shield is a disc on the ground, drawn as particles**, not a mesh dome. Units are not stopped by it. Its 75 s
  outlast the event (~60 s), so it ends in the town after.
- **FIXED-CITY**: the target is a place of the home town; the runner's points are window points of the live town.
- **Pyroclastic ash cloud**: not built — the particles have no GPU emitter a front could drive and the wind is painted
  for ~45 s. The lava front stands in for the pyroclastic flow; the ash fall sign covers the town as a separate card
  effect.
