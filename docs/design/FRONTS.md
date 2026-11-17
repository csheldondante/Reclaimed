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

## Hot lava runs, cooling lava stalls (loop round 14, LS-122, LS-127, LS-130)

The owner (2026-11-17): "I like more flow for hot lava". The design of record: lava "flows only while hot, sets into
basalt".

**The rule (liquid.wgsl `stiffness`, `gainAt`, `yieldAt`, `fluidity`).** A run's stiffness is how far it has cooled
from fresh (1250) toward setting (750), squared. Its gain is `hotGain` (8) times the liquid's own when fresh, its own
at setting; its yield (0.12) and the thickness below which it barely flows (0.4) grow from nothing (a floor of 15 % of
the thickness) to their full numbers as it cools. Fresh lava runs down any slope as a sheet; lava near setting needs a
deep run and a steep step, then stops and sets. Water has no heat and is unchanged.

**Cooling.** A run deeper than 1.5 cools as one 1.5 deep (`LAVA_COOL_DEPTH`): a deep pool sets in tens of seconds, not
minutes, while lava fresh from the vent keeps the channel hot. The cooling's number is halved (0.02 → 0.01). With
this the 25x quench after a front's event (LS-127) is not needed: removed.

**Measured** (`test/gpu/lavareach.test.ts`, a 256-column ramp 30 wide, 120 a second for 60 s, then 120 s with no
spring): before, 39 / 41 / 35 columns on slopes 0.05 / 0.1 / 0.2, and 4300-5400 of the 7200 poured still molten after
120 s; after, 130 / 218 / 254 columns, none molten after 120 s; mass kept (poured 7200, lying 7199).

**A far source.** The window holds 256 columns (320 on the phone tier); a front's source 150+ cells from the town
fits only with the window centred between them, and only if it then holds still. So:

1. (As built. The first form of this note chose the way on the atlas's macro ground; tried once, its highest point 160
   out lay across a river valley and the lava ran into the river. Replaced.) **The way is walked from the town**: 16
   ways, each stepped out 4 cells at a time on the terrain pages to `far` or 12 cells inside the window's edge; a dip of
   more than 3 cells under the highest ground nearer the town ends that way (lava would pool or turn there); the source
   is the farthest rise, the highest among as far (CPU: the round-12 hack extended, LS-121, LS-137).
2. If the window's edge cut the best way short of `far`, the window is slid a region that way by hand (the town kept
   12 + `spread` cells inside it) and the walk made again, at most twice.
3. **The window holds still while the front runs and its lava sets** (`Streamer.holds`): the slides are what moved the
   window back and forth (LS-130). The cause, read from round 12's and 13's logs: the camera follows the front's frame
   (the head and the town; after a cast, the shield's far rim and the head), which moves by more than the slide's
   threshold (0.75 of a region off the window's middle) when the head advances or a shield is raised; each slide
   re-streams land, and a source that slides out of the window stops pouring. Held, the camera is free and the land
   beyond the window is the far tiles.

## The shield as an energy barrier (loop round 14, LS-123, LS-131)

The owner (2026-11-17): "I think a shield should possibly be a barrier that can block units and fire too but collapses
if it loses energy too fast."

- **What it stops.** Liquids (as before), fire (fire.wgsl: no column inside a shield burns or catches) and units
  (units.wgsl: a unit's step that would cross a shield's rim, in or out, is refused — it stands at the rim). **Both
  sides' units**: a barrier is a barrier — the town's people inside stay inside, foes outside stay out. Decided here,
  not by the owner (a question for him: let the caster's own side through?).
- **Where the GPU knows it.** The discs go into the Globals (`shields`, 4 vec4 after `ring`; the TUNE_WORD moves 480
  → 496), so every kernel reads them as it reads the storms. The liquids keep their own uniform's copy.
- **Energy.** A store (`energy`) and a recharge a second (`regen`), both pack numbers on the ability (`in_event.shield`
  becomes `{ "radius", "seconds", "energy", "regen" }`; a bare number stays the radius with default energy). What
  presses on it drains it: each read, a small kernel (`shieldPress`, 4 shields x a band 2 cells outside the rim) sums
  the liquid lava standing there (depth), the fire burning there, and the units standing there (foes' only: a unit
  of the caster's side waiting at the rim is not a blow) into four counters. Drain a second = lava depth-cells x
  LAVA_DRAIN + fire x FIRE_DRAIN + units x BLOW_DRAIN; recharge is `regen`. When the store is empty the shield
  collapses at once. It loses energy "too fast" when what presses outruns the recharge.
- **Reads.** The counters are read every 0.25 s while a shield is up (64 bytes, async, never waited on — the pattern of
  the front's 2 s probe; nothing when no shield stands). The bookkeeping (store, recharge, collapse) is the CPU's from
  those counts; what presses is measured on the GPU — the CPU never learns where the lava or the units are.
- **The look.** Round 13's: flares where lava presses; the wall flickers once the store is below a quarter (as in its
  last seconds); the collapse is a burst: the rim's streaks thrown out hard, a second ring, a flash at the middle,
  bigger than a time-out's end (round 13 judged the end too weak).
- **Its end.** With its energy or its time — never silently: either end is told in the event's line ("The Fire ward
  gave way" / "The Fire ward faded") and drawn. It is not ended by its event's close (LS-131's question answered by
  energy: a ward outlives the event only while it has time and energy, and its end is shown wherever it is).

## Departures and limits (each is a BACKLOG item)

- **The channel is chosen, not carved.** The brief allowed "a carved or chosen channel". The source is the highest
  point on a ring round the target; lava runs down the ground as it is. On ground that falls away from the town on
  every side, nothing reaches it — that is the land's truth. Carving a channel (edits along the way) would force it;
  not done.
- **(Round 12; superseded in round 14 by "Hot lava runs" above.) Lava is thick (measured, LS-122).** The flow model's lava has a yield (0.12 a cell) and thins out: on Muru's
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
