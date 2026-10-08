# Architecture

Current state of the system boundaries. Update when a contract changes.

## Scenes

`main.ts` boots WebGPU and switches scenes. `scenes/world-core.ts` (WorldCore) is one
live world: WorldGpu + Simulation + Renderer + Weather + DayNight + Camera +
Globals, with warmup/advance/render and readbacks. `LevelScene` (the valley:
powers, HUD, goal) and `MenuScene` (48×48 skull diorama from `world/menumap.ts`,
state = f(saved progress); runs only surface/particles/renderfields/stats) each
own one and dispose it on exit (WorldGpu.destroy frees every buffer made via
`buf()`; in-flight readbacks reject with AbortError, swallowed by
`ignoreTeardown`).

## Frame

```
CPU: controls → powers → weather + day/night → Nature (reads last stats)
GPU per sim tick (60 Hz fixed, ≤ N ticks/frame by quality tier):
   structure → material → surface → water(flux, depth) → oil(flux, depth)
   → contamination → moisture → fire → ecology (every 15)
   → particles (emit, fireEmit, bursts, update) → renderfields (every 2)
   → stats (every 20, async readback)
GPU per frame: renderprep (terrain + liquids) + vegprep (plants) → draw
   (opaque boxes incl. sub-voxel canopies, liquids, particles, rain)
```

Globals (`common.wgsl` / `src/sim/globals.ts`, 576 bytes) carry storms (+ shape:
`stormsC` lobe phases and elongation), one-tick events, gusts (gusts[0] is the
cursor/tap breeze that animals flee; gusts[1] the player's drag-wind), day/night
light, the life lens, `env` (x, y: prevailing wind integrated over time; z:
debris seeding boost during warmup) and up to two dust storms. Analytic fields
derived from them: `windAt()`, `gustField()` (smooth gust patches advected by
`env.xy` — every wind noise term lives in that moving frame, so nothing
flickers), `stormDist()` (irregular storm outline; CPU twin
`Weather.stormDist`), `rainAt()`, `cloudShade()`.

Particles: debris (dust, litter, leaves) is born *resting* on the ground and
only lifted by wind over a per-kind threshold; strong wind over dusty ground
(and dust storms) raises haze puffs. Birds are a small state machine in
`Particle.m.w` (flee / seek / perch; a seeker keeps its target column in
`v.w`); they find crowns with `vegPlan()` from the shared `vegplan.wgsl`
(also used by vegprep), and count each flush in `particleCounters[1]` so the
CPU can tell whether a tapped tree really had birds. Oil smoke (smoke with
`m.w = 1`) counts each puff the wind disperses (or carries off the map) in
`particleCounters[2]`; the level reads it ~2 Hz and pays Nature for it. Puffs
that die in calm air drop their soot payload as soil contamination.

Vegetation sway has state: `bend` (vec4 per column: lean xy, velocity zw) is
a damped spring updated by the sway system (stiff while the wind pushes,
soft and lightly damped on the way back); the draw shaders read it.

Wind field: `windField` (rgba32float texture, one texel per 2×2 columns) is
the one wind everything feels. rg = the wind the player has painted; ba = the
whole wind = `mapWind()` (prevailing wind in advected gust patches, dust
storms, eddies) + painted. The windfield system (every tick; also at prime)
advects the painted part at 30 % of its own speed, spreads it, relaxes it to
zero (e-folding 7 s), adds the stroke segment drawn since the last tick
(gusts[1..3], gustDir.z = segment length; one-tick impulses like events —
`Simulation.step` zeroes them and sets `strokeSent` so Powers re-anchors),
and writes both. Passes stack (≈ 7 / 12 / 17 cells/s painted: breeze, gust,
gale). `windAt()` = field ba + storm swirl + the cursor/tap breeze
(gusts[0]). The level reads the field back ~4 Hz (`WorldCore.readWindField`);
each storm's target velocity is the field's mean whole wind over its body.
Pipelines that sample wind bind the texture at 15 (not a storage slot).

Drifts: `drift` (rgba32float texture, x = loose dust depth per column, y = dust lost to the
wind this pass; read at binding 17 via `driftAt()`) is owned by the drift
system (period 2): wind above 9 cells/s (reduced by shelter from taller
ground upwind) carries dust downwind (40 % goes airborne), walls bank it,
steep dust slumps, water washes it, dust storms drop it in sheltered spots.
Rendered as a smooth sheet (vegprep emits a MAT_DRIFT box; corners from
cornersTex.z computed in render-fields). Under > 0.5 dust, plants are
dormant (wilt, ecology). Map wind magnitude is scaled by `Weather.windScale`
(0.3 calm … 1 with storms/dust storms about).

Plant health: the wilt system (period 15, just before ecology) writes
`wilt` (vec4: ground hostility to plants from poison/oil/trash/litter/
drowning/drought; brownness of what grows there; tap bloom; doomed-sprout
timer — the last two are drawn by vegprep). It runs every tick (grow-taps
are one-tick events). Ecology reads it instead of
contamination and oil (young sprouts grow anywhere, browned plants wither);
the renderer tints plants with it. Seeds (particle 16) come from trees in
pulses, from wind, and from birds; they sprout on any bare dry-land cell.
Grow taps are `EV_GROW` events handled in the particle emit pass (period 1).
Litter (material 18) is stripped by `litterStrip()` (common.wgsl): the
material system removes the cell at tick t, the particle system spawns the
flying scrap evaluating the same roll for tick t + 1 while the cell still
exists.

Reclamation (HUD bar, level goal) = ½ clean land (stat 12: no poison,
oil, trash or litter) + ½ life (mean stage / 4.2, so woodland counts fully).
Nature pays out on deltas between stats readbacks: soil contamination
removed, litter stripped (stat 13), new mature cells.

Nature consequences come from stats: free oil volume and drowning living
cells (stat 11: veg ≥ 0.5 under > 0.4 water) drain it (`HARM` in
`game/nature.ts`). Compacted waste (trash) is solid and only fire removes it:
a burning heap loses a cell at a time and its last cell turns to loose ash
(material 17), which wind (dust) and water then carry.

Audio: two buses — ambient (attenuated by zoom; positional levels computed by
the level from storms, slow veg/water readbacks and the dam's position) and
click responses (full volume, panned to the click).

## Biomes

Moisture dries slower on flat ground; ecology only lets succession pass stage
3.3 (trees) where flat × wet × a large-scale patch noise (woodland); elsewhere
it stops at meadow. Fireflies only over meadow.

## World representation

- **Columns** on an XY grid, each with up to K ordered intervals `[z0, z1) material`
  packed in a u32 (see `src/world/layout.ts`). Chunked storage: 16×16-column
  chunks each with their own K (min 4, max 16, need + 2 headroom). A chunk
  table maps chunk → (slot offset, K). Overflow when material piles up beyond
  K is counted (`stats[15]`) and shown in the perf overlay, never silent.
- **Material table**: uniform array of 32 materials × 3 vec4 (render, sim, eco).

## Contract buffers (src/sim/world-gpu.ts)

| buffer | type | written by | read by |
|---|---|---|---|
| layers | u32 slots (aux = support·16 + damage) | structure, material | structure, surface, renderprep |
| surface | u32 (z, mat, count) | surface | most systems |
| water / waterPrev / flux | f32 depth / f32 / vec4 volume per tick | water | oil, contamination, moisture, ecology, fire, structure, material, renderfields, stats, draw |
| waterSource | f32 per tick | map | water |
| oil / oilFlux | f32 depth / vec4 | oil | water (weight), ecology, fire, renderprep, stats |
| oilStored | vec2 (amount, roof z) sealed in closed tanks | oil (releases on breach, burns inside) | fire (fuel) |
| contam | vec2 (soil, dissolved) | contamination | ecology, particles, draw, stats |
| contamDelta | atomic i32 ×1e5 | particles (pick-up/drop), oil (soak) | contamination (folds in, zeroes) |
| moisture | f32 0..1 | moisture | material, ecology, fire, particles, renderfields |
| fire | f32 0..1 | fire | oil (burns), ecology (burns), structure (heat, waste), particles (flames), renderfields (glow), stats |
| veg | f32 stage 0..5 | ecology (+ particles may plant 0 → 0.3: bird seeds) | most systems |
| particles / particleCounters | 48-byte ring + atomic head | particles | draw |
| renderFields | vec4 (shadow z, moisture, fire glow, flow) | renderfields | draw |
| stats | u32 sums | stats, structure (collapsed), material (overflow) | CPU (async) |

The water system can be replaced by anything that publishes `water`,
`waterPrev` and `flux` with the same meaning; oil likewise with `oil`/`oilFlux`.
Draw shaders read the packed `renderFields` instead of individual fields, so
they stay within 8 storage buffers.

## Rendering

Single path: every interval is a box instance; vertex pulling from a storage
buffer; only the three camera-facing faces are emitted (18 verts/instance).
Water is a second instance list drawn translucent; inner water side-faces are
culled in the vertex shader. Rain is stateless hashed streaks. Shadows come
from a heightfield sun-march compute pass. Cloud shadows/rain field are
analytic functions of the storm uniforms. An `rg32uint` pick target (column +
material, height, flags) gives exact picking via a 1-pixel async readback.

## Snippets (concatenated after a kernel that declares their inputs)

- `flow.wgsl::netFlow(p)` needs `flux`; `slope.wgsl::slopeAt/flatness` needs `surface`.

## Derived helpers

- `flow.wgsl::netFlow(p)` — net volume/tick through a column from `flux`.
  Anything reacting to *moving* water (erosion, flood damage, scouring, foam)
  must use it; gross flux is large even in still water.

## Instance flags (render-prep → draw)

`w = material | flags << 8`; flags: 1 top-of-column, 2 vegetation,
4/8/16/32 side face toward +x/−x/+y/−y hidden, 64 top face hidden.
Fully hidden intervals are not emitted. Bits 16..19 of `w`: structural damage
(terrain: drawn as cracks) or tree species (vegetation: 0 broadleaf, 1 conifer,
2 birch, 3 giant). Flag 128 = detail instance (x/y/size in
quarter cells: trunks, grass tufts, flowers). Leaf boxes with the vegetation flag
are shaded by a sub-voxel ray march inside the box (discard = gap).

## Events

`Globals.events` (≤4, one tick): x, y, radius, strength + kind
(`EV_LIGHTNING`, `EV_CHIP`, `EV_SCARE` — flushes perched birds; `eventKind` packs kind + 16·z for height-targeted
events). The CPU queues them; `Simulation.step` clears them after
the tick that consumes them.

## Levels and the sandbox

 is the level registry: id, name, blurb, title-screen model,
map generator (absent = not built yet), goal, intro, sandbox. takes a level id ( startLevel; ). Progress
is per level (; the valley keeps the original storage key); the
title diorama reflects the best of the real levels.  builds a
small model per level around the diorama and returns its position as poi
; a tap near one selects that level (Begin/Continue/Play, or
"coming").

Sandbox ( map +  panel): brush tools send
 events (z = op·32 + material) every frame while held; the edit
system (, first each tick, only when an edit is pending) deposits/
digs whole cells probabilistically by brush falloff and adds/removes water,
oil, pollution and plants; drift dust goes through  (folded in by
the drift system, which owns the drift texture). Spawn tools call Weather
(, , ). Time: speed 0 (pause) … 8×.
