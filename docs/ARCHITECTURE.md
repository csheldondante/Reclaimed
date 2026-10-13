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

Globals (`common.wgsl` / `src/sim/globals.ts`, 1104 bytes) carry storms (+ shape:
`stormsC` lobe phases and elongation), one-tick events, gusts (gusts[0] is the
cursor/tap breeze that animals flee; gusts[1] the player's drag-wind), day/night
light, the life lens, `env` (x, y: prevailing wind integrated over time; z:
debris seeding boost during warmup), up to two dust storms and up to four
cyclones (`cyclones: array<CycloneU, 4>`: position/strength, motion, six
spine nodes; `cycloneAt`, `windAt` and the particle capture loop over them;
caught debris keeps its cyclone's index in `m.z` bits 4..5). Analytic fields
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

Loose ground (round 22, branch strata): every granular interval in the
layers is loose ground — soil, sand, gravel (rubble), ash, litter, silt and
blown dust (material 19) — with fractional heights. The sediment system
(`sediment.wgsl`, period 2, two passes) works on the run of touching
granular intervals on top of each column: wind above the material's lift
threshold (reduced by shelter from taller ground upwind) carries its top
interval downwind (its airborne share goes up as dust grains the particles
carry), walls bank it, slopes steeper than its repose (lower when wet) slump,
moving water washes it, water held back by it pipes through, dust storms
and dying cyclones drop dust; what arrives joins the top interval or starts
a new one (strata). Granular intervals with air under them fall; buried
ones with air beside them spill out of the face to their repose
(undercutting). Behaviour per material is in the material table (`loose`
vec4 + repose in `sim`). Pass 1 (`outflow`) writes each column's outflows
to `sedOut`; pass 2 (`main`) takes its own off and gathers its
neighbours', updating its intervals in place (still columns are skipped).
The surface pass derives a view each tick: `surface` z = the base of the
loose run, the drift texture (x run depth, y top interval depth, z its
material, w the air output), strata (the intervals beneath the top; w the
exact base) — so readers use `sfZ + driftAt` for the ground's surface.
Rendered as a smooth sheet (vegprep emits a MAT_DRIFT box from the base;
corners from cornersTex.z computed in render-fields; renderprep skips the
run's intervals and culls a covered top). Under > 0.5 of blown dust or ash
on top, plants are dormant (wilt, ecology). Map wind magnitude is scaled by
`Weather.windScale` (0.3 calm … 1 with storms/dust storms about).

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
sediment pass takes a cell off a litter top for the rolls of ticks t and
t − 1 (it runs every other tick), the particle system spawns the flying
scrap evaluating the roll for tick t + 1 while the litter is still there.

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

### Consolidation in progress (branch `strata`, BACKLOG P4/N1)

Goal (user, round 22): one representation for everything that lies on the
land — material intervals — so that intervals and particles are the only two
things that carry material, with fluids moving it between them. Fewer
systems, fewer seams, fewer bugs (the spires, banked sand popping bodies and
the body projection all came from the seam between the layers and the
separate loose stack). Done on the GPU in stages, each one testable:

1. **Fractional intervals.** A slot becomes `vec4<u32>`: z0, z1 as f32 bits,
   material | aux << 8, spare. Empty slot: z1 bits = 0. `surface` packs z as
   8.8 fixed point (bits 0..15), material (16..23), slot count (24..31);
   `sfZ` returns f32. Behaviour unchanged.
2. **Loose ground lives in the intervals.** The drift kernel becomes the
   sediment kernel and works on the layers: the contiguous granular run on
   top of a column is what the drift stack used to be (wind, water, slumping
   take from its top interval; arrivals of a new material start a new
   interval). Two passes: outflows per column → `sedFlux`, then each column
   gathers its neighbours' outflows and rewrites its intervals. It also
   takes over gravity for granular intervals from `material.wgsl`, which is
   removed. The drift and strata textures stay as a *derived view* written
   by the surface pass (depth of the granular run on top, top interval's
   depth and material, the intervals beneath), so their readers don't change
   yet; `surface` z is the base of that run.
3. **Spill from exposed faces.** A granular interval with air beside it in a
   neighbouring column spills into the neighbour (landing on that column's
   support at that height, inserted mid-column if needed) until the face is
   at its angle of repose; rock above doesn't hold it, so sand under a cap
   rock is undercut and leaves an air pocket. Granular material carries load
   (only air removes support), so the structure pass sees the pocket grow
   and cracks the cap when its span is too long.
4. **Readers simplified**: `surface` z becomes the full top, the derived view
   is dropped where nothing needs it, fractional solids (the valley's
   reshaped rock, N2).

Storage stays a buffer (not a texture): per-chunk depth K is already
variable; a full chunk is counted (stats[15]) and can be given a deeper page.
At this map size the layers stay in cache, so the in-chunk order (column-major
now; slot-major is a one-line change in `colSlots`) is measured before it is
changed. Bodies (rigid pieces) are left as they are; a destruction model
where pieces turn to particles on impact is P3.

## Contract buffers (src/sim/world-gpu.ts)

| buffer | type | written by | read by |
|---|---|---|---|
| layers | vec4<u32> slots: z0, z1 (f32), mat \| aux << 8 (aux = support·16 + damage) | structure, sediment, edit | structure, sediment, surface, renderprep, edit |
| surface | u32: base of the loose run (8.8), material under it, slot count, bits 30/31 buried loose / air gap | surface | most systems |
| drift, strata (textures) | the loose run as seen from above (derived from layers) | surface | sediment, particles, water, oil, ecology, wilt, render… |
| deposit | vec4 per column: editor ±, a crumbled body's amount + material | edit, CPU (integrity) | sediment (folds in, zeroes) |
| sedOut | 7 vec4 per column: outflows, easing, totals, spills | sediment (outflow) | sediment (main) |
| water / waterPrev / flux | f32 depth / f32 / vec4 volume per tick | water | oil, contamination, moisture, ecology, fire, structure, material, renderfields, stats, draw |
| waterSource | f32 per tick | map | water |
| oil / oilFlux | f32 depth / vec4 | oil | water (weight), ecology, fire, renderprep, stats |
| oilStored | vec2 (amount, roof z) sealed in closed tanks | oil (releases on breach, burns inside) | fire (fuel) |
| contam | vec2 (soil, dissolved) | contamination | ecology, particles, draw, stats |
| contamDelta | atomic i32 ×1e5 | particles (pick-up/drop), oil (soak) | contamination (folds in, zeroes) |
| moisture | f32 0..1 | moisture | material, ecology, fire, particles, renderfields |
| fire | f32 0..1 | fire | oil (burns), ecology (burns), structure (heat, waste), particles (flames), renderfields (glow), stats |
| veg | f32 stage 0..5 | ecology (+ particles may plant 0 → 0.3: bird seeds) | most systems |
| sparkTex | rgba32f per column: x = tick + 1 of the last ember landing | particles | fire |
| reachTex | r8unorm per column: the player's reach on a story level (1 inside, 0.5 at the edge, 0 in the fog; 1 everywhere elsewhere) | game/reach.ts (CPU, ~1 Hz) | render.wgsl haze() fog |
| cornerTex | rgba32f per grid point: x soft-ground height, y water, z drift (−1 = not smoothed), w 1 where the four columns differ in top material or plant cover (soft borders, render.wgsl `edgeLook`) | renderfields | draw |
| particles / particleCounters | 48-byte ring + atomic head | particles | draw |
| renderFields | vec4 (shadow z, moisture, fire glow, flow) | renderfields | draw |
| stats | u32 sums | stats, structure (collapsed) | CPU (async) |

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

`game/levels.ts` is the level registry: id, name, blurb, title-screen model,
map generator (absent = not built yet), goal, intro, sandbox. `LevelScene`
takes a level id (`main.ts` startLevel; `?skipmenu=1&level=<id>`). Progress
is per level (`progress.ts`; the valley keeps the original storage key); the
title diorama reflects the best of the real levels. `menumap.ts` builds a
small model per level around the diorama and returns its position as poi
`level:<id>`; a tap near one selects that level (Begin/Continue/Play, or
"coming").

Sandbox (`world/sandbox.ts` map + `ui/editor.ts` panel): brush tools send
`EV_EDIT` events (z = op·32 + material, +512 on the first event of a press)
every frame while held; the edit system (`edit.wgsl`, first each tick, every
tick in the sandbox) adds/removes water, oil, pollution and plants, and does
the ground in layers (round 13): per column `editState` (rgba32float
ping-pong texture, read at binding 18 as `editTex`) holds what this press has
given (x; reset by the press flag), the fraction of a cell owed (y), cells
still to pour (z) and op·32+mat ×4 + fall time left (w). A press gives at
most `layers` cells, soft at the rim; build/dig apply at once, pour lands
after `POUR_FALL` at `POUR_RATE` (the particle emit pass reads `editTex` and
drops K_GRAIN particles timed to land with it), bedrock inserts stone at
the bottom and lifts the column. Loose pours, dust, digs of loose ground and
cleaning go through `deposit` (.x; folded into the layers by the sediment
pass). Spawn tools call Weather
(`spawn`, `placeDust`, `spawnCyclone`). Time: speed 0 (pause) … 8×.


Saved maps (`world/mapfile.ts`): `WorldCore.captureMap()` reads the live
world back (layers unpacked to a ColumnGrid via the chunk table — the
loose ground is in them — and the float fields) into a `MapData`; `encodeMap` writes it as gzip
(CompressionStream) of "RCLM" + u32 header length + JSON header (version,
dims, poi, field sizes, chunk table) + slots + fields (~250 KB for 256²).
Kept in IndexedDB (`savedMaps`) or downloaded as `.reclaimed`; loading
restarts the level with `LevelOptions.map` (30-tick prime, no settling).
Undo: `WorldCore.snapshot()` (each brush press) copies layers, water, oil,
oilStored, contam, moisture and veg into a GPU ring of 8 (the loose ground's
view is derived from the layers);
`undo()` copies the last back and clears pours in flight.

Model atlas (`world/models.ts`): voxel models (material per voxel) built by
code, turned into per-column runs (`modelColumns`, 4 rotations) and seated
into a column with `seatColumn` (base = mean ground under the footprint −
sink; the model replaces what it overlaps; dips below the base fill with the
column's top material). Map generators call `stampGrid`; the sandbox's place
tool (`LevelScene.placeModel`) reads the layers back, seats the footprint's
columns on the CPU and writes them back with full structural support (aux
support 15) so the structure rule only removes what is really unsupported.
Sandbox chunks are packed with K ≥ 10 (`packColumns(grid, minK)`) to leave
room. Thumbnails: `ui/thumbs.ts` (2D-canvas isometric, exposed faces only).

Structural integrity and rigid bodies (sandbox; F7): `game/integrity.ts`
marks boxes dirty (smash, place, cyclones, landings), reads the layers back
a few times a second and runs `game/fracture.ts` `analyse()` on them: pieces
of structural voxels (solid, strength < 1) that no longer touch terrain fall;
a piece whose centre of mass lies outside the hull of its footprint tips
over whole; otherwise load (mass, first moments) is passed from the far
voxels toward the ground along shortest paths (voxels on an unbroken stack
down to the ground are anchors) and where moment > 40 · strength ·
thickness³ (thickness = distance to the piece's skin) that cross-section
crumbles to chips. Pieces are cut out of the columns (CPU mirror + GPU
writeBuffer) and become `game/bodies.ts` falling bodies (round 21: they
only fall straight down — no rotation, sliding or bounce; collision points
just inside the exposed voxel corners find the deepest overlap below them
(solid run top, loose ground, a sleeping body's top); landing hard shatters
them, `game/integrity.ts` impact()). Bodies draw as rotated cubes
(`render.wgsl` vsBody/fsBody, buffer bound at 3). In the sandbox the GPU
structure rule collapses damage only (`Globals.misc.y` = 2).

Rigid bodies (round 17, K1–K2): bodies keep their own frame; at rest they
sleep (no physics, only drawn) and are projected into the terrain grid —
`bodyProj` texture (binding 21, `bodyTopAt()` in common.wgsl): per column the
top and bottom of any sleeping body over it (CPU copy also carries the body
id). The loose ground treats a body's top as ground (banks against it,
slides off it; material under a body doesn't move) and buries it once its
level rises past the top; water and dust grains treat it as ground too.
Bodies collide with solid cells, the loose surface (settling 0.35 into it)
and sleeping bodies. A sleeping body wakes when hit hard by a falling one,
when nothing holds it up any more (checked each integrity pass, ~1 s when
all are asleep), or when a cyclone passes (small bodies are carried). Break
on a body removes voxels in its frame and splits it; a budget (64 bodies /
16k voxels) crumbles the oldest small ones into loose ground (`deposit` .yz).

## Story rules (round 30)

`Globals.rules.x` = 1 on a story level (`LevelDef.story`, unless opened with
Free play / `?mode=free`). Then bare ground is colonised only by seeds:
ecology.wgsl skips its neighbour/spore colonisation; particles.wgsl lets
established green (veg >= 1.2) shed seeds into the breeze (more in wind, life
12 s), and a grow-tap on green lets go a puff of seeds instead of sprouting
bare ground. `game/reach.ts` (CPU) labels the patches of green touching the
reach from slow readbacks (veg + driftTex, buried green excluded) and floods
each patch's reach (max(8, ¼ of its width) past its edge) outward; reach
only grows. It is uploaded to reachTex; LevelScene confines the camera to it
(Director.limits) and ignores taps, drags and hover outside it.

