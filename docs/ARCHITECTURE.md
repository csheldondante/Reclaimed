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
GPU per frame: renderprep (terrain + liquids; only columns on screen or whose
   shadow is: the camera at binding 31) + vegprep (plants) → draw
   (opaque boxes incl. sub-voxel canopies, liquids, particles, rain)
```

Globals (`common.wgsl` / `src/sim/globals.ts`, 1104 bytes) carry storms (+ shape:
`stormsC` lobe phases and elongation), one-tick events (at most MAX_EVENTS = 4
a tick; the overflow waits for the next tick), gusts (gusts[0] is the
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
The air texture it writes carries, besides the dust lifted (x), the flow
the particles show (round 50): y the amount sliding or spilling off the
column this pass (or falling, a run that lost its support), z the height it
starts at, w its way (0–5 a direction, 6 down) + 8 × its material; the
particles stream running grains (K_RUN) from it — only a look.
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

### External intervals and instanced meshes (round 99, branch `meshinst`, `?meshinst=1`)

The user (DECISIONS round 99): "let a skewed mesh be buried instead of turning back into an ordinary layer … the
layer needs to be skipped and marked as being in an external system so that it can properly support columns over it
and interact." Code: `src/sim/external.ts` (the contract and registry), `src/render/meshinst.ts` +
`src/shaders/meshinst.wgsl` (the instanced renderer), `src/render/treemesh.ts` (the tree kinds).

**The interval.** `MAT.External` (39): an interval owned by an external system, aux = the material it becomes if its
owner lets go (0: stone). To the sims it is rock that never gives by itself (strength 1, bear 1, `span: Infinity`;
not structural): it holds what's put on it, water and lava go round it, loose ground piles on it, moss takes on its
top (growthCap 1.2). The terrain's draws skip it: the field mesh (meshregion.wgsl `fieldMat` is false for it, so the
mesher treats it as air — the faces of the ground round it are drawn, buried parts of the owner's mesh are hidden by
them), the prisms (renderprep.wgsl skips it), the hybrid grid (an owner's columns are touched: the chunk becomes
voxels — `Integrity.onTouched` → `HybridChunks.edit`), the band and far bake (they never see it: it lives only in
the streamed window, see slides below).

**Who writes them.** Only an owner, through `ExternalRegistry.claim(owner, cols, fallback)` — it claims the free
parts of each column span asked for (air or a liquid; ground already there is where the thing is buried, not
claimed) — and `release(id)` (what's left becomes the fallback material in place). The registry is the truth of who
owns what (instance → its intervals, window cells); nothing reads ownership from the GPU's words, because the sims
may move, join or cut intervals (sediment joins touching ones of a material and drops aux; most writers keep aux).

**How an owner is told.**
- *Cut*: after each read of the ground into the integrity system's CPU copy (an edit, a meteor, a body moving),
  `verify` checks every instance there still holds each cell it claimed; one that lost any (dug, smashed to rubble,
  melted, moved by a pull or lava's lift) is cut — `onLost(inst, 'cut')`.
- *Loose*: the rock judge (fracture.ts analyseRock) judges External runs like any rock; a piece or a run that gives
  containing them has those intervals turned to their fallback material in the analysis (`Integrity.takeExternal`)
  and their instances told — `onLost(inst, 'loose')` — before it falls as ordinary rock.
- *Orphans*: after a whole read (a slide, an undo, a warp), External intervals no instance claims become their
  fallback material (`orphans`, a scan of the copy's words).
- The owner must release or take back the instance in `onLost`; the registry releases it otherwise.

**What the sims may assume.** That an External interval is solid ground (they need not know of owners); that it
does not move or change by itself; that its owner draws it. What owners may assume: that the cells they claimed
stay External until a sim cuts or moves them, which they hear of within a judge's pass of the read (0.35 s, at
once after an edit); nothing about aux.

**Slides.** Before the window slides (Integrity.settle), an instance in the strip leaving (all of them, for a slide in
z or a warp) is released to ground: the streamer freezes columns as they are and no owner exists over there; after
it (Integrity.slid) the registry and the owners' transforms move with the land.

**First owner: the resting rock** (`OWNER_ROCK`, game/integrity.ts `restRigid`). A rigid rock body (rockbodies.ts)
that comes to rest keeps its mesh (render/rockmesh.ts, its slot drawn at the body's last transform, and now in the
sun's shadow pass too: it has no cubes casting one) and claims its cells: per column from its lowest to its highest
cell, down to the ground under it where that's within REST_FILL (3) cells (what it stands on: the judge weighs by
columns). At most REST_MAX (16) rest at once, and a falling body short of mesh room takes the oldest's: the oldest
becomes ground (the round-95 behaviour). Cut or loose: it becomes ground in place (stone, or its own material), its
mesh lingers 6 frames, and the judge looks at what's left — a piece of it hanging free falls as a new body.

**The instanced renderer.** Mesh kinds in one vertex buffer (x, y, z, part) and one index buffer; instances in one
storage buffer (MI_CAP 8192 a kind; four vec4s: three affine rows — turn, scale, lean, skew; translation in w — and
params: trunk height, crown base, crown height, crown half-width: parts 0 and 1 are stretched to them, part 2 is taken
as it is). One `drawIndexedIndirect` a kind from the renderer's indirect buffer at MI_ARGS_WORD (24: five words a
kind), in the world pass after the plants and in the shadow pass after them; first instance 0 (no
indirect-first-instance feature needed: the kind comes from the vertex's index range, MI_KINDS). Lit with render.wgsl
`lighting`, hazed, cut away with `cutAway`; flat-shaded from the position's derivatives (shared vertices). The wind's
lean from `bend` (sway.wgsl), the season from Globals.

**First consumer: trees.** vegprep.wgsl (`TREE_MESH`, its binding 10) writes a tree instance where it would have
written the trunk and crown boxes (vegplan.wgsl: the same places, species and heights; a random turn, a lean of up to
±0.07 a cell up, ±10% size); the player's plantings stay boxes. The trees are not External yet (see BACKLOG MI6).

## Contract buffers (src/sim/world-gpu.ts)

| buffer | type | written by | read by |
|---|---|---|---|
| layers | vec4<u32> slots: z0, z1 (f32), mat \| aux << 8 (aux = support·16 + damage) | structure, sediment, edit | structure, sediment, surface, renderprep, edit |
| surface | u32: base of the loose run (9.8 since round 100, bits 0..16; 8.8 before), material under it (17..24), slot count (25..29), bits 30/31 buried loose / air gap | surface | most systems |
| drift, strata (textures) | the loose run as seen from above (derived from layers) | surface | sediment, particles, water, oil, ecology, wilt, render… |
| deposit | vec4 per column: editor ±, a crumbled body's amount + material, a cold storm's snow and a tree's leaves (climate), a place's bury (placeop) | edit, CPU (integrity), climate, placeop | sediment (folds in, zeroes) |
| pullGiven | f32 per stroke slot (8) and column: the height a layer pull's stroke has given it | layerpull | layerpull |
| shake (texture) | rgba32float per column: x the tick the ground was shaken, y how hard (0..1): loose ground there slips at up to 80% less steep a slope, up to 1.5× as fast and unheld by roots, for 240 ticks (sediment `shakeAt`) | layerpull | sediment |
| places | u32 per column: low u16 the room of the open air on top, high u16 the room of the enclosed level under it (0 the same); 0 no place (docs/PLACES.md) | CPU (`core.places.load`) | placeop |
| placeTable | u32 per place id (MAX_PLACES 4096): a room's region, a region itself | CPU (`core.places.load`) | placeop |
| sedOut | 7 vec4 per column: outflows, easing, totals, spills | sediment (outflow) | sediment (main) |
| water / waterPrev / flux | f32 depth / f32 / vec4 volume per tick | water | oil, contamination, moisture, ecology, fire, structure, material, renderfields, stats, draw |
| waterSource | f32 per tick | map | water |
| riverFlow (texture) | rgba32f per column (round 84, `?rivers=table`): xy the atlas river's flow at the reference wetness (cells a 60 Hz step, downstream), z the column's depth then (> 0: a river's), w the river's depth at its line; at wetness `wet` (Globals ocean.y) its level stands w·(wet^0.6 − 1) higher and it runs wet^0.4 as fast. A river's column asleep or at the window's edge is held there (riverheld.wgsl): no simulation, its flux the pipes' steady flux for its levels, drawn flowing by xy | the land's maker (atlas colFinish → landFrom), kept with its region by the streamer | water (flux, depth), renderfields |
| (?flow=1) runs, flux, emit, jets per liquid; flowAct | the runs in the columns' gaps, their flux and streams (ARCHITECTURE "The flow model"); per chunk net change, throughput, perturbed, overflow | flow/liquid.ts (water also writes water, waterPrev, flux) | itself, render (addWaterPrisms), flow/steady.ts |
| (?flow=1) runs, flux, emit, jets per liquid; flowAct | the runs in the columns' gaps, their flux and streams (ARCHITECTURE "The flow model"); per chunk net change, throughput, perturbed, overflow | flow/liquid.ts (water also writes water, waterPrev, flux) | itself, render (addWaterPrisms), flow/steady.ts |
| riverFlow (texture) | rgba32f per column (round 84, `?rivers=table`): xy the atlas river's flow at the reference wetness (cells a 60 Hz step, downstream), z the column's depth then (> 0: a river's), w the river's depth at its line; at wetness `wet` (Globals ocean.y) its level stands w·(wet^0.6 − 1) higher and it runs wet^0.4 as fast. A river's column asleep or at the window's edge is held there (riverheld.wgsl): no simulation, its flux the pipes' steady flux for its levels, drawn flowing by xy | the land's maker (atlas colFinish → landFrom), kept with its region by the streamer | water (flux, depth), renderfields |
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
| windBlows | vec4s: [0].x count, then three per entry (x, y, radius, strength or cap), (dx, dy, mode 0-4, a stroke's length), (a stroke's paint) — blows, strokes and wakes | CPU (api/wind.ts, the world API) | windfield |
| renderFields | vec4 (shadow z, moisture, fire glow, flow) | renderfields | draw |
| stats | u32 sums | stats, structure (collapsed) | CPU (async) |

The water system can be replaced by anything that publishes `water`,
`waterPrev` and `flux` with the same meaning; oil likewise with `oil`/`oilFlux`.
Draw shaders read the packed `renderFields` instead of individual fields, so
they stay within 8 storage buffers.

## The hex nature grid (branch `grids`, docs/GRIDS.md)

The columns sit on a hex lattice: pointy-top hexes, centre to centre 1, rows
√3/2 apart, odd rows shifted half a cell right (odd-r offset). Storage is
unchanged — a w × h array indexed (column, row) — and kernels reach their six
neighbours through `nbr(p, k)` (common.wgsl; TS mirror `world/lattice.ts`).
Directions come in opposite pairs (E, W, NE, SW, NW, SE), so `k ^ 1` is the
way back. World positions are `cellPos(p)`; `cellAt(w)` is the inverse; `triAt(w)`
gives the three centres around a point with barycentric weights (smooth
interpolation of per-cell fields). Per-direction buffers (`flux`, `oilFlux`,
`sedOut` lanes) are `array<f32, 6>` per cell (`Dirs`, 24 bytes). Per-pipe
rates (water and oil gain, slumping, wind easing) are 2/3 of the square
grid's: the hex Laplacian's weighting, the same continuum rate. The wind
field stays its own half-resolution square grid in world space. Levels and
the kit still author in grid cells: a map laid onto the hex lattice row by
row is ~13 % shorter in y and slightly sheared; points of interest convert
with `poiWorld`. The world spans (w + 0.5) × h·√3/2.

Structure grids (src/grids/, grids.wgsl): rigid voxel grids in their own
frames (position + quaternion; `strFrames`, 8 × 64 bytes) over a shared voxel
pool (`strVox`, u32: bits 0-7 material, 8-15 moss, 16-23 sand cover, 24-28
the snow or dust on its up faces in 31 levels, 29 dust (else snow): round 52,
structtick.wgsl). The CPU writes frames only.
`project.wgsl` (first each tick) writes `bodyProj` — x top, y bottom, z body id
(−1: a structure) — from the structures and the CPU's sleeping bodies
(`bodyCpu`, written by integrity.ts), and `foreign` (xy the top face's world
normal, z structure + 1, w its top material), and `proj` — every solid stretch
a column's vertical line crosses, up to PROJ_K = 3 per column, top first, in
the layers' own interval form (`projAt()` in common.wgsl, binding 28; texture
3w × h). The surface pass adds `levels` (binding 29 in sediment.wgsl): the
floor of each stretch of open air they leave — the sky over the top one, the
air between them, the air under the lowest. The sediment pass moves loose
ground within one level: a column's run lies in one (`runLevel`); what a
neighbour sends at height h comes into the level open at h, or steps up onto
the solid there (`openAt`); what comes from the sky lands on the top one; a
run under a structure feels no wind or water, only slumps. `structtick.wgsl` is the
structures' own tick; `structprep.wgsl` turns exposed voxels into body-format
instances (bit 31 of the material word: a structure voxel).

Physics voxels (branch `physics`, docs/PHYSICS.md; src/physics/,
phys.wgsl): bodies whose every voxel is a particle on its body's lattice
(position, previous position and temperature, velocity, rest position,
region rotation, 26 bond bits; its info word: material, body, size code
(n/16 of a cell, 0 whole), hidden), solved by lattice shape matching on the
GPU. Each body has its own voxel size (round 49); a crumbling voxel splits
into eight fragments half its size, in a ring at the start of the
particles (body 255), which go to dust in turn. A body may carry a mesh
(`Physics.spawnMesh`, round 49): its voxels hidden, the mesh bound to them
and bent by them once a tick (phys.wgsl `skin`, into `skinOut` /
`skinArgs`), drawn by `Renderer.addMesh(verts, indirect)` (render.wgsl
`vsSkin`: two vec4<u32> a vertex, position + material word, then the
triangle's normal; three a triangle, no index buffer) with the body
shading, lit and shadowed. Games hold bodies through `Physics.drive` /
`impulse` / `push` (round 49: a per-body control table and up to eight
force fields a tick, uniforms read by `predict`) and read them back through
`state()` (a `stats` pass sums each body's voxels into atomics every tick;
mapped asynchronously). `installPhysics` (physics/install.ts) wires
physics, lava and waking (physics/wake.ts `Waker`) into any WorldCore. The CPU places bodies (uploads them once) and aims the beam. They
read the layers (ground contacts) and write crumbled voxels into `deposit`
(y amount, z material, through their own per-column atomics) and chips,
dust and embers into the particle ring; the renderer draws their instances
with the body pipeline (`Renderer.addVoxels`). The nature grid sees them
through `physCols` (WorldGpu: 8 words per column, bit z set where a voxel's
centre lies in cell z, refilled by phys.wgsl `prep` each tick); project.wgsl
merges each run of set cells into `bodyProj` / `proj` as a stretch (like a
CPU body: aux 0), so sand and water lie on them a tick later and the air
under a table stays air. Voxels landing hard add to `physPuff` (u32 per wind
texel, ×1000; cleared each tick by physics.ts), which windfield.wgsl turns
into wind pushing out from it.

Lava (sim/lava.ts, lava_flux.wgsl, lava.wgsl; sandbox, spliced before the
physics): a third liquid in WorldGpu `lava` (vec4 per column: depth,
temperature, the ground's heat at its top, the lava's surface height),
`lavaNext`, `lavaFlux`. Its flux pass reads `surface`, drift and bodyProj
like water; its depth pass edits the column's own layers in place (as
sediment does: melting off the top interval, setting basalt, MAT 23) and
takes water off the top (steam), and lifts the columns of a rising volcano
cone (the bottom interval grows, the rest move up). The CPU sets only the
beam and up to four vents with their cones (a uniform). It draws through
`Renderer.addPrisms` (the opaque pipeline): one instance a column in
renderprep's prism form (MAT 24, temperature in the damage bits), then
after all of them (`lavaInst`, 3 vec4 a column) two vec4 of the six levels
round each, from which render.wgsl `lavaSheetVertex` draws a smooth sheet
when the field mesh is on. renderfields reads `lava` so it lights its
surroundings like fire, and phys.wgsl `relax` reads it so voxels in it heat
up. A meteor is the level's (particles on a path), then one EV_EDIT event
(op 13, `OP_CRATER`: a bowl removed, ejecta into `deposit` as drift),
ripples, bursts, a wake and a physics blast.

## Rendering

The field mesh through a slide (round 73): chunks are CHUNK across and
CHUNK rows down (samples a row apart in y), so a slide is whole chunks both
ways; each chunk record holds the mesh range its geometry is in (word 10)
and each range a translation (after the records: meshregion.wgsl offBase).
`FieldMesh.shift` (fieldmesh.wgsl shiftChunks) hands every chunk the record
of the chunk its land came from and adds the slide to every range's
translation; the chunks the land came into fresh take the leaving ones'
ranges, empty, to be built; chunks hash their columns where they are in the
world, so moved land doesn't count as changed; a range's translation is
zeroed when its chunk is rebuilt; vsMesh adds it. Each frame a first hash
pass gives the rebuild slots to chunks with nothing built, a second to the
rest.

The land beyond the window (round 73, atlas/far.ts, far.wgsl): a grid
round the camera (161² vertices, 32 world units apart) of the atlas's
macro ground at half resolution and the coarse world's changes, coloured by
each region's ground (its top's colour, green where it grows, snow where
it's freezing, the sea); it sinks away under the window (the columns draw
over it, meeting at the edge) and fades into the sky. The fixed view draws
only what's beyond the window's two far edges (anything past both near
edges could stand between the eye and the window). `Renderer.extraDraws`.

The camera (render/camera.ts): the fixed isometric orthographic view, or
(round 69, F in a level) a free perspective camera (`Camera.fly`: where it
is, yaw, pitch, field of view). The draw shaders get its position
(render.wgsl `Camera.pos`, w 1 when flying: `toEye(p)` is the way to the eye
from p), so the sides drawn toward the eye, canopy and rock marches and
highlights look from where the eye is; what's sized in pixels divides by
clip w (1 in the fixed view); culling (field-mesh chunks, renderprep's
columns) divides by w and keeps what's behind the eye; picking flies a ray
into the ground (`groundAt`). A streamed window follows the camera's
position.

(Round 91) The atlas map's names come from label sources (api/map-labels.ts `MapLabel` / `LabelSource`: a name, a
kind, a world point, a weight): the map (api/atlas-map.ts) only styles, filters by zoom and declutters them. The
level gives it the world wiki's (gm/map-names.ts `wikiLabels`, from atlasFacts → buildWiki on the live atlas: the
GM's names); another system adds a source, never edits the map. North is world −y, the map's up; the map is drawn
as seen from above (world +x to the left). The compass (ui/compass.ts) reads only `Camera.azimuth`.
`Streamer.unwritten` (a slide's regions moved over but not written yet) and `Streamer.vel` (the camera's
velocity, cells a second) are read-only for probes and the level.

(Round 90) The player turns the fixed view round the ground under the screen's middle (render/turn.ts `Turn`,
the atlas level's ↺ ↻ and Q / E): it writes `Camera.azimuth`, as round 82's Orbit does; nothing downstream
assumes the fixed π/4 — the draw, culling, picking, the shadow box and the far land read the camera's matrix or
`eye`.

The camera's puck and what's cut from the view (round 83, V21; api/puck.ts,
api/cutaway.ts), each on its own:
- `Puck.update(dt)` after the camera's input: what moved `Camera.target`
  since the puck wrote it (a pan, a zoom, a director's shot, a slide) moves
  the puck with it, then it picks the screen's middle (the first surface
  drawn along the eye's line; over `cut.slice` isn't) and goes to the floor
  on that point's vertical line nearest its own height: along the eye's line
  at once (unseen in the orthographic view), across the screen on a
  critically damped spring with a velocity. It writes `Camera.target`.
- `Slice.update(x, y, floor, dt)`: rock 1.5–12 over most of the point and
  the ring round it, so `Camera.cut.slice` eases from 60 over down to the
  roof's underside (and back up, then null).
- `Orbit.update(x, y, floor, dt)`: solid more than `large` (8) over the
  floor between the point and the eye gives a goal azimuth (the nearest
  clear one in 5° steps, 10° on), looked at again every 0.15 s;
  `Camera.azimuth` turns to it on a critically damped spring (≤ 2.2 rad/s).
  `Orbit.prefer`
  ({ az, dead, firm? }, set each frame: a game's heading) draws the view
  back within `dead` of `az` while the point is seen (twice as firm past
  `firm`) and starts the clear-angle search from that zone;
  `Orbit.seen(x, y, floor, az)` is the test, for a game's own rules.
- `Dither.see(id, x, y, z, r)` / `surface(id, lo, hi)` / `update(dt)`: up
  to 4 points kept seen (a hole opens round one while something hides it)
  and up to 4 boxes that limit what may be dithered.
render.wgsl `Camera.cut` (x the slice's height, y points, z boxes, w the
slice on), `see[4]`, `boxes[8]` (CAMERA_CUT_OFFSET, CAMERA_CUT_BYTES 208).
fsMesh and fsBox discard what `cutAway` cuts (over the slice; in a hole,
by a 4 × 4 ordered dither); fsMesh draws a surface seen from inside, within
the cut, dark (a section), and WorldCore clears to the same dark under a
slice. The sun's camera has the cut zeroed. `?cutaway=1` (the level): the
puck, slice and orbit on the camera.

The rings of less detail (round 83, atlas/lod.ts, lod.wgsl, far.wgsl
vsLod): between the window and the far land, rings centred on the camera,
`n` vertices a side (193; `?lod=low` 129 and spacings 4, 8, 16; `?lod=0`
none), 2, 4, 8, 16 cells apart. Each is a dispatch of `lodHeight` (the
atlas's `ground()`: the top (a mesa's lip, what's loose, the sea's or a
river's level over it) and a colour (the two regions' grounds blended by
the ground's border weight, oddities, ash, snow, water, lava)) into
`LodRings.data`, made again when the camera moves 8 of its spacings, on a
slide, and one ring every 3 s (the coarse world). Each ring's last 16
texels melt into the next ring out (at its edge it is that ring there: a
ring's square is on the next one's lattice) and the outermost into the
far land's `farAt`; a ring discards the window's square and the finer
ring's; the far land discards the outermost ring's square, and with rings
draws its near side too.

The hybrid renderer (round 84, `?hybrid=1` on the atlas level, branch
`hybrid`; scenes/hybrid.ts): voxels only where they're needed, the
heightfield everywhere else. The window's mesh chunks (32 cells across, 32
rows down) are each either voxels — the field mesh and the band built and
drawn there, the window's water, plants and sheets prepared there — or the
heightfield's: never built (FieldMesh.setWanted: not looked at, not drawn,
a built one emptied — its indices 0, its hash FRESH), so far.wgsl's
`meshBuilt` is false and the rings (a 1-cell ring first: spacings 1, 2, 4,
8, 16) draw its land. A chunk is voxels when (HybridChunks.update) its land
isn't a heightfield — Streamer.relief / gapTop / colTop, made per column as
land comes in (writeNow, editLive, the first window) and moved with the
window: a form standing on the ground or cut into it (the top off the
ground's own by more than 0.75), or a gap between runs open to the air (a
neighbour's top under its roof: an overhang's lip, a cave mouth, a bridge,
a tunnel's portal; a cave under its neighbours' tops is buried and doesn't
count; round 100: a form alone no longer, `?formvox=1` as before), or (round 100) a column in it is steep (a neighbour's top over `?steep=` 12 cells off its own) — or
it's within `?vradius=` of the camera's target (40 before round 100; 0 since: none), or a world
event (Globals.events) has touched it (kept while it's in the window). The
choice reaches the renderer as Renderer.setMeshWanted (the window's mesh and
the band's) and the GPU as Globals.hfield (a bit a mesh chunk, `ocean.yz`
the chunks across and their side; common.wgsl `heightfieldCol`):
renderprep and vegprep prepare nothing in a heightfield chunk — its water
too is the rings' (the river's and the sea's level, lod.wgsl). The rings in
the window are never pressed under the focus (underFocus) and write the pick
target as the columns do (meshdraw.wgsl's encoding, the top's or the rock's
material), so powers land on heightfield chunks; along a voxel chunk's edge
with a heightfield neighbour they draw a skirt (a 0.9-cell strip, far.wgsl
`skirt`) over the hairline between the two. The window's layers stay the
truth for every column (physics, queries, the sim where it's awake); the
sim wakes only in voxel chunks (Sleep.only, HybridChunks.sleepFilter). The
rings' look (fsLod `ringLook`): where the surface is steeper than ~60° (the
vertex normal and the triangle's own) the region's rock (lod.wgsl writes
the rock's albedo and material beside the top's) in beds (render.wgsl's
strata), lit by the sun, the sky and a bounce; no green from 70 over the
sea up (as colFinish's plants).

Round 93 (`fardetail`): the rings' slot's last word is the rock's material, the
plants the window's columns start with (colFinish's rule; 1/60 a step) and the
distance to the nearest way (lod.ts `wayBins`: the atlas's way points binned
once, a storage buffer; the albedos a uniform, `farAlbedo`, shared with
far.wgsl). fsLod draws them with `ringWindowLook` (meshShade's ground, grass,
flowers, paving and water; render.wgsl's lighting and haze from the Globals the
level hands FarLand a frame as `FarLight`; painted trees over a wood's ground)
unless `?fd=0`. underFocus keeps the land only under the eye's line to the focus.

Round 94 (`farbake`): the land past the window is drawn from a baked
texture, `SurfaceBake` (atlas/bake.ts, bake.wgsl): a clipmap of 512² RGBA8
levels in one 2d-array — a level a ring (a texel half its spacing) and one for
the far land (16 units) — world-anchored, toroidally addressed, the strips new
to a level baked as the camera moves (two 16k-texel bands a frame at most). A
texel is lod.wgsl `surfaceAt` (the rings' per-vertex rules, shared) plus the
window's grass, ways, water and woods averaged over it, plus the **stamps**
laid on it (`SurfaceStamp`: a raster of tops a world unit, and its 4-unit
average). fsLod/fsFar sample the finest valid level (far.wgsl `bakeAt`,
bindings 37–39) and light it a frame. The settlements system makes the stamps:
`Settlements.farPlans(FarIO)` plans each settlement within reach on the
atlas's rough ground (`SurfaceBake.roughGround`, the level hands it over as
FarIO.rough) in a worker (settle/plan-worker.ts), rasters it
(settle/raster.ts) and publishes the list through `onStamps`; the level lays
them (`bake.setStamps`). The exact plan's raster replaces a far one when its
land arrives. FarLand never reads the settlements, nor they the bake's
insides.

Round 86 (the grid): a heightfield chunk is one of two kinds. Most are the
**grid's** — their columns' tops all within the window's z, their land come
in at least `?readyticks=` (3) sim ticks ago (round 100; a fixed 0.4 s before) — drawn by the renderer as a lattice through the window's
own column centres (the hex rows are a triangular lattice) at each column's
top (surface + drift), 34 x 34 vertices a chunk (its 32 columns and one past
each edge, overlapping its neighbours by a cell), with the mesh's own
fragment shaders (meshdraw.wgsl vsGrid / vsGridG into fsMeshG, fsMesh, the
shadow pass): the look is meshShade's, so the seam with a voxel chunk can't
be seen. Renderer.setGrid(on, lo, hi) takes the chunks and their tops' span
(the culling's boxes). Only the rest — land past the window's floor or
ceiling, land just come in — is the **rings'**: Globals.hfield now holds
only those (renderprep and vegprep prepare the grid's chunks: their water,
plants and sheets are the window's, drawn on the window's own columns), and
far.wgsl's LodD.grid (a bit a chunk) keeps the rings out of the grid's
chunks. The sim may wake in a grid chunk within `?stormreach=` (110) of the
focus, or one an event touched (HybridChunks.sleepFilter); Sleep's own rules
then wake it (a storm raining). Only edits and chips (what can cut shapes a
heightfield can't hold) turn a chunk to voxels now. A storm over land whose
sim is asleep darkens it all the same (meshShade: stormCover where asleep),
and the rings past the window draw a storm's shade, wet ground, water in
hollows and sheets running down slopes (far.wgsl farStorm; FarP.storms).

Vertex pulling from storage buffers. Column intervals (ground, water, oil, the
loose sheet) are hex prisms, 30 vertices: the top in four triangles with one
flat normal (the plane through its corners, cached per cell by render-fields)
and the three sides toward the eye. Plants are axis-aligned boxes from their
own list (vegprep.wgsl → instPlant), 18 vertices: top + two sides. Soft tops and sheets slope through hex corner heights: each corner
touches three cells and each cell owns two (30° and 90°), so `cornerTex` is
5w × h with the planes (terrainshape.wgsl).
An interval (renderprep) or drift sheet (vegprep) whose six sides are all
hidden is drawn as its top alone — the prism's first 12 vertices — from a
tops list after the opaque list in `instOpaque` (from the 256-byte-aligned
instance `indirect[16]`, drawn through a binding offset: `drawIndirect`
can't take a first instance without an optional feature). A soft top's side
counts as hidden where both its corners are smoothed (shared, so the
neighbour's top runs through them) and the neighbour is solid up to its loose
run; a sheet's where `sheetGap` (terrainshape.wgsl) is false at both corners.
The field mesh (G13 h, behind `?mesh=1`; fieldmesh.wgsl, meshdraw.wgsl,
render/fieldmesh.ts): the terrain is a surface-nets mesh of a signed field
evaluated on the fly from the intervals (each column's vertical distance to
its solid, blended over the three nearest centres) and the structures'
voxels (box distance in their rotated frames, joined by a smooth minimum:
the fillets). The map is cut into 32-cell chunks of the world, each with
room for its own vertices and indices and one indexed indirect draw (culled
to the view on the CPU). Every frame `hashChunks` hashes each chunk's
columns (heights to 1/16) and the frames over it; changed chunks are
rebuilt, 8 a frame at most (3 at spacing 0.5), by sampleField, makeVerts
and makeQuads into a per-slot scratch grid. Samples lie on one lattice over
the map and each chunk computes the cells one sample past its low edges, so
the seams close. Built materials (`fieldMat`: solids but rock and trash)
aren't in the field — renderprep still draws them as prisms — and quads
that are all structure are dropped (the cubes draw them), so both stay
sharp. The layout is the `MeshRegion` uniform (meshregion.wgsl, binding 30;
renderprep and vegprep read it). The fragment shader takes its material
from the interval the point lies in (a top-facing point: its run's top
layer, blended with the one below when thin), so the look still comes from
the intervals; plants, stains and wetness are blended over the three
nearest cells; rock gets facets and rubble, trash and ruins chips (the
detail layer).
The mesh's look is shaded deferred (perfopt; renderer.ts `encodeGBuffer`,
meshdraw.wgsl `gPack`, `fsMeshResolve`; `?defer=0` the forward draw): a
`gbuffer` pass draws the mesh (window and band) into two uint targets —
the point (xyz bits) and its octahedral normal with the source bit (1 the
window's, `MR.zb.w`) and a drawn bit; the structure word and share and the
tint — and the depth; the world pass loads that depth and first draws a
full-screen triangle per source (its own bind group: that source's chunk
table, layers and region) that shades each pixel of its source once
(`meshShade`, the same function the forward `fsMesh` calls), writing the
colour and the pick; the rest draws over it as before. With the cutaway on
the G-buffer pass's pipeline discards (`fsMeshGCut`). Why: at the phone's
resolution a mesh triangle is about a pixel, and the forward draw shaded
2 × 2 quads per triangle and every surface behind the front one.
Run-time switches for A/B (`Renderer.opts`, each from a URL flag;
scripts/drawbench.mjs sets them with `@name=value` pieces): `defer`,
`prepass`, `cull` (the G-buffer pass culls faces turned away; the mesh's
quads are wound out of the solid), `shadowEvery` (the shadow map and the
light matrix it was drawn with kept for N frames, redrawn after a slide —
`FieldMesh.slides` — or a new box), `shadowCache` (the static casters —
mesh, prisms — into `shadowStatic` every N frames with the matrix kept,
copied into the map each frame and the moving casters drawn over it),
`prepEvery` (renderprep's and vegprep's
instance lists kept N frames), `noDetail` (bits of the look left out,
carried to the shaders in `Camera.eye.w` from bit 2: meshdraw.wgsl `ND_*`).
The terrain's cached layer (`?tcache=N`, `Renderer.opts.tcache`; tcache.wgsl):
the terrain drawn deferred every Nth frame into a layer 24 render pixels
past the screen each side (colour, pick, depth as r32float); between, the
frame's camera (camData only) is snapped to the layer's pixels and a
full-screen draw copies the layer in, shifted, with its depth (frag_depth)
and picks, before the rest of the world pass. Redrawn after a slide, a turn
or zoom, a resize or when the shift passes the margin; off with the cutaway
and the free camera.
The world pass discards its depth and, unless a pick is asked for, its pick
target (nothing reads them after it).
The terrain field is looked up 0.45 cells of 3D noise to the side
(`terrainWarp`, meshregion.wgsl), so cliffs bulge and recede; the draw
shader looks materials up at the same place. Only chunks near the view
(their flags after the chunks in the state, written by the CPU) are hashed
and rebuilt; the rest catch up when they come into view. Water over the mesh
is a sheet over the triangle lattice of the cell centres (render.wgsl
`waterSheetVertex`: six triangles round each wet column, each drawn once by
its first wet corner; dry corners at the level or their ground below it,
the ground's depth cutting the shore). With the mesh on, renderprep skips
the neighbours of columns with nothing built and no water, and renderfields
computes only water's corners and no sun march (`world.meshRegion` says
it's on). Renderfields then stores the flow's direction in x and w of the
render fields (no march reads x), for the water's streaks (render.wgsl
`flowOf`, `flowStreaks`). Water too thin to clear the smoothed ground is
drawn on the ground itself (meshdraw.wgsl `cellWater`: depth, level and
flow over the three nearest cells; a glaze, streaks, glint, the wet band
and swash above the edge); the mesh layout gives the vertices to the vertex
stage only and the look's buffers to the fragments' (eight a stage). Shadows with the mesh come from a shadow map: one depth32 texture (quality
`shadowSize`: low 1024², else 2048²) over the mesh chunks near the view,
floor to sky, along the sun (an orthographic box round them, renderer.ts
`writeLight`; it holds every caster whose shadow falls there; only the
chunks inside it are drawn into it, fieldmesh.ts `castCull`), drawn each frame by the draw pipelines' own
vertex shaders, depth only, through a second camera buffer holding the
sun's matrix (so prisms and plants draw the sides facing the sun); every
built chunk casts, not only those in view. The draw shaders' Camera carries
the matrix after the view's (`light`) and the lookup's bias in
`viewport.w`; `lighting()` takes four filtered comparison taps (bindings 25,
26) when the mesh is on, the heightfield march otherwise.
Water is a second instance list drawn translucent; inner water side-faces are
culled in the vertex shader. Rain is stateless hashed streaks. Shadows come
from a heightfield sun-march compute pass. Cloud shadows/rain field are
analytic functions of the storm uniforms. An `rg32uint` pick target (column +
material, height, flags) gives exact picking via a 1-pixel async readback.

(Round 93, `winmem`; `?meshpool=0` the old layout.) The mesh's vertices and quads live in a **page pool**: one
buffer of 16 KB pages (512 vertices, or 2048 quads of four 16-bit chunk-local vertices), handed to the chunks that
are built and given back when a chunk is rebuilt, unwanted (the hybrid's heightfield) or slides out. Each mesh range
(a chunk's record's word 10, the slide's hand-on) has a page table in the mesh state after the rebuild's dispatch
words (meshregion.wgsl `rtBase`), then the free stack (`freeBase`). A rebuild counts first (countVerts, countQuads:
the same tests makeVerts and makeQuads make), then a one-workgroup pass gives back and takes pages (allocVerts,
allocQuads: pushes and pops in separate barrier-split phases). No index buffer per chunk: every chunk's draw reads
one shared quad index buffer (corners 0 1 2, 0 2 3), its base vertex r · 4 · vertsPer, and the vertex shader reads
the quad's corner from its page and the vertex from its own (meshdraw.wgsl `meshVert`). A rebuild that finds no
pages is STARVED (record word 13): not marked built, so it's owed and made again, the LOD rings drawing its land
meanwhile; the free stack's header is read every 15 frames and the pool grows by half (a new buffer, the old pages
copied, `FieldMesh.maintain` once a frame; `Renderer.syncMeshPool` makes the draw groups again) when a rebuild
starved or under a fifth is free. Past one binding (min(128 MB, the adapter's)) it's an UnsupportedError. The
instance lists (`?instgrow=0` the old) likewise start at a tenth of their worst case: writes past a list's room are
left out (renderprep.wgsl putO/putW, vegprep.wgsl putP), its count clamped after (clampWater, clampVeg) with the raw
count kept in indirect words 20–22, and `Renderer.syncInst` grows a list asked for more than 85% of its room.

## Snippets (concatenated after a kernel that declares their inputs)

- `flow.wgsl::netFlow(p)` needs `flux`; `slope.wgsl::slopeAt/flatness` needs `surface`.

## Derived helpers

- `flow.wgsl::netFlow(p)` — net volume/tick through a column from `flux`.
  Anything reacting to *moving* water (erosion, flood damage, scouring, foam)
  must use it; gross flux is large even in still water.

## Instance flags (render-prep → draw)

`w = material | flags << 8 | sides << 20`; flags: 1 top-of-column, 2 vegetation,
64 top face hidden; sides: bit k = the hex side toward neighbour k hidden.
Fully hidden intervals are not emitted. Plant boxes are packed in storage
cells (quarter cells for detail) and placed by their centre's cell. Bits 16..19 of `w`: structural damage
(terrain: drawn as cracks) or tree species (vegetation: 0 broadleaf, 1 conifer,
2 birch, 3 giant). Flag 128 = detail instance (x/y/size in
quarter cells: trunks, grass tufts, flowers). Leaf boxes with the vegetation flag
are shaded by a sub-voxel ray march inside the box (discard = gap).

## Events

`Globals.events` (≤4, one tick): x, y, radius, strength + kind
(`EV_LIGHTNING`, `EV_CHIP`, `EV_SCARE` — flushes perched birds;
`EV_IGNITE` 7 — fuel within the radius catches at intensity w, the world
API's fire.ignite; `eventKind` packs kind + 16·z for height-targeted
events). The CPU queues them; `Simulation.step` clears them after
the tick that consumes them.

## The world API (round 52, docs/WORLD_API.md)

`src/api/`: `createSim(host, worldDef)` makes a WorldCore from a game's
world definition (map, places, climate, season) and installs the modules it
asks for; `attachSim(core)` puts them over a WorldCore a scene runs (the
level: `reclaimed.api`). One `Mirror` per sim: every module registers the
buffers and textures it reads (terrain: surface, layers, drift, levels;
water: water, flux; fire: fire, lava; wind: windField), read back together
on a timer (250 ms), decoded by the module. Commands go through the world's
own queues: Globals.events (edits, ignite; the excess waits a tick), the
particle burst queue (now kept past 64 a tick, not dropped), and
`windBlows` (wind.ts, a SimSystem just before the windfield: blows, strokes
and wakes, merged past 256).

## The atlas (round 67, branch `atlas`)

A finite world's map, made on the GPU when the world starts, that the
streamer's columns are drawn from (`src/atlas/`). The world is a torus of
`cols` × `rows` cells (16384 × 18944 by default: it wraps); the macro grid
is `n` × `n` texels over it (2048: a texel ~8 cells).
- `build.wgsl`, the macro passes: continents (warped periodic fbm above a
  threshold) → their connected components (GPU flood fill: hook roots onto
  the smaller, pointer jumping, to a fixed point) → islands and lakes too
  small flipped → the partition (Voronoi cells, bent by two octaves of warp,
  split by the faults: the strip between two thresholds of one noise is its
  own region; provinces, a coarser partition, for the kinds) → regions, the
  components of equal keys → (CPU, `atlas.ts`) dense ids, tiny regions
  merged into the neighbour they share most border with, the region table
  (`regions.ts`: kinds by rules from land or water, fault strip, latitude,
  province, size; each a ground, a pattern, a border profile, materials) →
  JFA from the regions' borders (distance, the region across) and from the
  coast (signed distance) → the ground of every texel (`hmac`).
- `compose.wgsl`, the ground at any world point: the regions on either side
  of the nearest border and the distance to it (bilinear, below the texel),
  each region's own height (noise at its scale, ridges, its pattern,
  terraces; land rises from its coast, water deepens from it), met in the
  border's profile (smooth, cliff, ravine, wall, terraces; on a coast beach
  or sea cliff), chosen by the region with the higher priority (on a coast,
  the land). Every profile is odd in the distance so both sides agree.
- `patterns.wgsl`, the pattern bank: wallpaper-group folds (p6m, p4m, p6,
  p3, a weave), Truchet, cracks, craters, dunes, veins, a kaleidoscopic
  fractal, basalt columns; reaction–diffusion (coral, maze) and a cave
  automaton simulated once into tiles (`patsim.wgsl`).
- `columns.wgsl`: the ground of a batch of columns (and a margin), and the
  caves as a signed field (two dual-threshold noises crossing, a third's
  peaks).
- `forms.wgsl` (round 69): what stands on the ground and what's cut into
  it. Each region has up to two forms (12 words each after its 24, regions.ts
  `FormDef`): SPIRE (a solid of revolution on a jittered lattice of one of
  seven spacings: a profile up its height, round / n-lobed / polygonal
  section, twist, a bending axis or a tilted top, hollow, a cap material —
  spires, towers, hoodoos, buttes, crystals, seracs), ARCH, NETWORK (tubes
  along a meandering zero set or cellular edges: tunnels with skylights
  holding water or lava, or walled vessels arching in and out of the
  ground), ALCOVE (openings in a cliff's face, on the high side of a border).
  `formSeed` places a batch's lattice forms (48 cells round it);
  `colFinish` finishes each column (cover, snow, accent, water, plants) and
  marches it up as signed values — ground, minus caves and carves, plus
  forms — writing runs where the value crosses zero (fractional), up to 24
  a column, each marked form or ground. `landFrom` merges them into
  intervals, at most K − headroom a column (closest neighbours made one past
  that: `Atlas.gapsFilled`), and a mask of columns holding a form of a weak
  material. Batches are 64² (the first window in tiles: one dispatch of
  the whole window trips the GPU's watchdog where forms are thick).
- Lava in the tubes: `lavaSpring`, a world texture (lava.wgsl's depth pass
  is at its 8 storage buffers): a column's lava is topped up to its depth
  and kept molten; what spills runs off and sets. Kept with its region by
  the streamer.
- Rivers (round 69, `rivers.ts`): on the CPU over the macro ground, a
  priority flood from the coast fills every hollow and gives each texel the
  one it drains to; texels drained through (less where it's dry) over a
  threshold are river nodes (level: the filled ground, so it only falls;
  width with what drains through), and lava nodes run down the same tree
  from each volcanic region's top. JFA spreads the nearest node to every
  texel (build.wgsl jfaSeedV/jfaOutV → `riverNear`); compose.wgsl `riverAt`
  measures the distance to the segments from the nodes round a point to
  their next, and `ground` carves the channel to the river's level with
  steep valley sides (gorges through high ground). Where the level drops
  across a segment the channel is a chute: a fall. colFinish fills the
  channel (water to its level, lava along its middle), beds it (sand, silt;
  basalt under lava) and feeds it: water springs along its middle
  (`waterSource`: what comes from upstream), lava springs. (Round 84,
  `?rivers=table`: no springs — each node carries its watershed's discharge,
  `RIVER_RUNOFF` × what drains through it, and a speed from it over the
  channel's wetted section, quicker where the level falls; `riverAt` gives the
  flow along the segment, colFinish writes it with the depth to the
  `riverFlow` contract texture, and the water holds an unwoken river there.) The ground is made
  twice: first without rivers (to find them on), then with them.
- Lakes (round 90, `rivers.ts` AtlasLake, `Atlas.lakes` / `lakeAt`): the priority flood's filled hollows deep
  (LAKE_DEPTH) and wet (LAKE_CATCH) enough, each a lake — its level the spill height, its outlet, rivers in and out,
  its regions; a river's level in a lake is the lake's, in a hollow too small for one the floor's. Per texel a u16
  (the lake's id + 1, LAKE_IN set inside, unset on its rim: land texels within LAKE_RING whose filled level is near
  the lake's) and a table (the level) follow the river nodes in `riverBuf`; the crater block's words 1 and 2 say
  where (0: none). compose.wgsl `lakeAt` picks the lake most of the four texels round a point are inside of and how
  much (bilinear): over half, `Ground.lkw` (its water may stand there); less, the rim — the ground raised to a bank
  LAKE_BANK and more over the level, before any river cuts it (a river through a lake cuts no channel under its
  water; one lower than the lake doesn't cut its bank where its water is near). colFinish fills every column under
  the level with `lkw` (form tops and holes too; no tube skylights under it; no loose cover on a steep bed), bedded
  in silt, sand at the waterline where flat; no `riverFlow`: a lake's water is still water, asleep as it comes in,
  simulated where woken (held like a table river, it fed what woke beside it over its level). The rings (lod.wgsl), the
  viewer (view.wgsl) and the atlas map draw it; sites keep out of lakes; the wiki names them (`WorldWiki.lakes`,
  contracts/world.ts `Lake`, `lakeFlood`).
- The coarse world (round 72, `coarse.ts`, `coarse.wgsl`): the torus at
  `coarseN`² cells (512: 32 world units each), what has changed from the
  atlas — rock taken or added, loose ground (its material), water, the
  sediment it carries, lava (its heat) — simulated on the GPU (cFlux: what
  leaves each cell for its four neighbours; cDepth: what came, rain, the
  sea, erosion and deposition, lava cooling to basalt, vents; one buffer
  everything reads, the step's result copied back) a step every 4th frame
  in the level, 4 a frame in the viewer. Events (cEvent): a meteor (bowl,
  rim, ejecta of rubble), ash downwind of an eruption, a cone; `erupt` adds
  a vent. compose.wgsl `coarseAt` (bilinear) adds it to `ground` and the
  columns lay its loose ground on top (burying plants), its basalt cap, its
  water and lava. Regions come in changed: the streamer keeps a snapshot of
  the coarse cells round a region when it's made and when it's left
  (`LandSource.snapshot`), and on the way back in applies what changed since
  (`changes`: rock off or on, loose ground on, water — layout.ts lowerTop /
  addTop). An event in sight is made in the window's columns too
  (`Streamer.editLive` with coarse.ts `eventAt`, the GPU's shapes cell by
  cell), with the fine meteor's flash and blast or a lava vent. Rain and
  erosion run when `rain` / `erode` are set (off by default: untuned).
- Landforms (round 78, branch `places`, landforms.ts): the macro height is
  designed. An elevation noise (domain-warped, blending its own size and
  half of it by a slow noise: `AtlasParams.formPer` cells a turn) gives each
  land region a tier at its centre by rank — lowland 45 %, upland 30 %, the
  rest plateau or massif (a second noise, plateaus where it's dry); a
  fault's strip is a range (massif) or a rift. Adjacent regions of one tier
  are one landform (union-find over `Atlas.adjacency`, keyed a · regions + b
  by dense ids) with one level (a massif also a peak and how far in it
  peaks). Region words 48–51 carry it (REGION_WORDS 52; compose.wgsl
  `Region.lf, tier, peak, rise`); a JFA from the landforms' borders (the
  coast is one) puts the distance into the landform in `distR.w`. In
  `ground`: a massif rises from its edge to its peaks along ridges by that
  distance; where two landforms meet the higher one's edge is used — a
  plateau's a cliff, a massif's a wide smooth rise; inside one landform a
  border is never a cliff or a terrace. The kind follows the tier
  (regions.ts TIER_KINDS). The continent slopes down to the sea all the way
  across (`lift` over `liftReach` of the coast's SDF), so the rivers (a
  priority flood on this ground) run down it and drop off plateaus as
  falls. Each region's own noise and pattern are `detail` (0.5) of what
  they were. `?atlas=view&mode=landforms` shows the tiers.
- Impact craters (round 78, `Atlas.craters`, `AtlasParams.craters`): placed
  once (many a few hundred cells across, a few huge with a central peak,
  the older the more worn) and stamped twice — into the continents' noise
  (build.wgsl `base`, CRATER_LAND: a bowl by a coast floods into a bay)
  and into the ground (compose.wgsl `craterAt`: bowl, rim, ejecta, peak, the
  distance noise-warped so none is a circle). They live in the river
  buffer between the nearest-node words and the nodes (CRATER_BLOCK): the
  column shaders are at their eight storage buffers.
- **Columns as intervals** (round 81, forms.wgsl colFinish): no walk up the
  column. The ground from 0 to its top (loose on it), minus the voids — the
  caves' layers (columns.wgsl `caveVoids`: up to three, tunnels where a 2D
  noise is near zero and chambers where another is high, floors between the
  sea and the ground, roofs under caveDepth of rock, shafts between layers),
  the cavern or an overhang's open, a tube's inside (its circle cut by the
  column) and skylight, alcoves (six bands, a 2D noise each) — split into
  rock, cover and loose; plus the forms, each sampled only over its own
  heights (1.5 apart, the edges halved four times), kept where there's air;
  sorted, joined, written. fitColumn joins loose layers with each other
  first (a loose and a solid +3).
- Mesa tiers (round 79): MESA_TIERS 6 walls by the distance onto the high
  side (shares and ledges by noises along the edge, `tiersW`); by the
  cliff, Worley cells ~10 across each take the tiers' height at their own
  site's distance (the distance's gradient from two more macro samples)
  moved by their own offset: flat shelves at varied heights; sediment on
  the cells that fell. Caves: caveScale 160, their height scales with it
  (columns.wgsl caveZ).
- Mesa edges (round 79, compose.wgsl `mesaEdge`, `EDGE_MESA`): a plateau's
  edge against another landform. Within MESA_REACH (110) of the border, on
  the distance onto the high side: ravines (the zero lines of a noise,
  tapering to their heads, floors rising), spurs, four walls each its share
  of the drop with a ledge before it (shares and widths by noises along the
  edge), the rim lowered and rough near the edge, a pediment at the foot,
  buttes (Worley cells) on the low side; the walls jointed (Worley cells
  ~11 across: on a step's top by its wall a cell drops by its own amount,
  sediment on it; off its foot one stands); eroded ramps (MESA_REACH 200
  for them; a slow noise: rock under a skin of loose ground from the plain
  to the top, Worley cells left standing as stone pillars). Talus at each wall's foot is loose
  ground (Ground.loose/lmat: sand where dry, soil, rubble patches) with
  boulders of the cliff's rock (rock added, Ground.cap). Overhangs:
  Ground.ov (lip top, open floor, roof) — a lip over the ground or ledge
  past the top wall, an undercut at the foot; colHeight raises the column
  to the lip and carves the open as a great cavern's (ColG cf/cr). Forms
  don't grow in an alcove's, a cavern's or an overhang's open, and a column
  holds four forms' runs at most (forms.wgsl).
- Facet fields (round 79, STAMP.field 3): a crystal cluster's ground broken
  into Voronoi cells, each a tilted plane, higher toward the middle, cracks
  between (x, y, R, H, seed, cell size).
- Oddities (round 78, `Atlas.makeOddities`, `AtlasParams.oddities`):
  clusters on land regions' middles stamped into the ground with the
  craters (the same list, atlas.ts STAMP: kind and material words) —
  faceted crystal mountains (a pyramid of 5–8 planes to its point, quartz)
  and bulbous domes (lobed outlines, steep feet; granite, coral or flesh by
  the style). An oddity's height is the highest of them over the ground
  (craters add); where one stands, Ground.smat (ColG.smat, COLG_BYTES 76)
  makes the column's top and rock its material, bare. No lava rises from
  one (the rivers' volcanic sources skip them).
- Great caverns (round 78, compose.wgsl `cavernAt`): under plateaus and
  massifs, deep inside them (120–360 into the landform) where a slow noise
  says; the floor near the sea's level, a domed roof up to ~100 over it
  with 28 of rock kept above, columns of rock standing in it (where a fine
  noise peaks). colHeight puts (floor, roof) in ColG (COLG_BYTES 72) and
  the column march carves it.
- Ways (round 79, ways.ts, `Atlas.ways`, `stampWays` in `regionLand`):
  each road's coarse path unwrapped, smoothed (Chaikin ×3), sampled every
  2; the macro ground under it (`Atlas.macroAt`, bilinear hmac) smoothed
  along it and graded forward and back (≤ 0.22 a unit; the atlas's lift
  and switchbacks stretches exempt). Each point a kind: tunnel (7+ under
  the ground: a bore 5 high), bridge (4+ over: a deck of concrete 1.2
  thick, a pillar every 7 points), road (cut or filled, a 1:1 shoulder
  back to the ground), switchbacks (legs of 26 across the fall line,
  climbing evenly), lift (a concrete tower radius 3.5 at the stretch's
  lowest ground up to the top, the way level with the top from it), plaza
  (a disc at each site). Paved in brick (built: prisms). A column takes
  its nearest point within 26; points binned by 64.
- Sites and roads (round 78, sites.ts, `Atlas.settlement`): on the CPU
  over a coarse grid (4 × 4 texels a cell) of the ground with its rivers.
  Each land cell scores a setting — a plateau's rim over a 60+ drop
  (cliffside), a river's mouth (port), a river in the low ground, a
  massif's flank, a crater's rim, a coast, plain; the best taken first, 18
  cells apart (`AtlasParams.sites`, 140). Roads: the relative neighbourhood
  graph of each continent's sites (within 70 cells), each by A* (slope,
  high ground and rivers cost; the sea is no way). Walking a road finds its
  crossings: tunnels at passes (45 up and down within 14 cells), steep runs
  classed by their drop (ramp < 30, switchbacks < 90, else a lift), gorges
  and rivers bridged. Nothing is stamped into the ground yet: the crossings
  are for the regions' briefs (BACKLOG V2), which build them. The viewer
  draws them over the map (O).
- Giants (round 75, `Atlas.giants`): quartz crystals the size of mountains
  in the crystal regions (a few each, 150–420 tall, leaning up to 35°),
  placed once when the atlas is made. Each column batch is handed the giants
  that reach into it as forms ahead of its lattice forms (forms.wgsl
  PROF_PRISM: a hexagonal prism to its point, its axis straight); the far
  land draws them as meshes beyond the window, and over it above and below
  the window's heights.
- Geysers (round 75, `Atlas.geysersIn`): a pure function of where — a
  lattice 64 cells apart over the volcanic regions' land; the generator lays
  each one's sinter, the level makes them go (a jet of water and steam for a
  few seconds every half a minute or so; their vent spills water).
- The window's height goes by the ground's own top, not what stands on it
  (`RegionLand.ground`, `Streamer.ground`): a giant's point under the camera
  isn't where the land is.
- Physics of forms: the ground is terrain (strength-1 materials: stone,
  sandstone, basalt, obsidian, flesh); forms of weaker ones (crystal, ice,
  coral) are judged by the integrity system when they arrive
  (`Streamer.onArrive` with the box round the mask; the first window region
  by region) — what can't stand breaks free and falls.
- One function, three users: the viewer (`?atlas=view`,
  `scenes/atlas-view.ts`) draws `ground()` per pixel, the macro pass per
  texel, the columns per cell.
- `?level=atlas` (LevelDef.atlas): LevelScene.create builds the atlas,
  picks a start (`?at=x,y`, or `Atlas.spawn`), makes the window from it
  and gives the Streamer the atlas as its LandSource (wrapping round the
  torus). `?a.<param>=` sets any AtlasParams.

## The streamed world (round 66, branch `stream`)

`?level=stream` (LevelDef.stream): the live world is a 256² window onto
land without an edge. `scenes/streamer.ts` (`Streamer`, `reclaimed.stream`)
slides it a region (`REGION` = 64 columns: whole chunks, an even number of
rows so the hex parity holds) when the camera comes within 1¼ regions of
its edge:
- **Freeze** what leaves: its chunks' layer pages and the fields that are
  state (water, waterSource, oil, oilStored, lava, contam, moisture, veg,
  fire, petals, wilt, bend; the shake texture) are copied to a staging
  buffer and read back into `frozen` (keyed by region). Derived fields
  aren't kept.
- **Shift**: every per-column buffer and texture (state and derived, the
  half-res wind field, `proj`'s PROJ_K texels a column) moves a region over
  through a scratch copy, so nothing jumps for a tick. The layers don't
  move: every chunk has the same K (the sandbox's 14), so the chunk table is
  a page table and the leaving chunks' pages go to the ones coming in.
- **Thaw** what comes in from `frozen`, exactly as it was left, or generate
  it (`world/streamgen.ts`, a pure function of world position: no seams).
  Its derived fields start at zero (bodyProj/bodyCpu at −1, none).
- The CPU's window coordinates move too: the camera, the weather
  (`Weather.shift`), the map's surface heights, the level's surface cache
  (`onSlide`); the undo ring is cleared; particles in the air are dropped.
- **When** (round 98, `streamspeed`): the slide waits until every region it brings in is ready — made ahead (the
  prefetch), checked for what changed while it was away (`since`), its relief made — and then moves the window and
  writes the strip in a frame or two (`WRITE_MS`); `busy` (the sim stopped, the meshes held) only for that. The
  atlas's streamed batches' tiles go through `TilePacer` (as many a frame as the frame's time allows, at least one).
  `?streamold=1`: the slide at once and busy till its land is written, a tile a frame.
- **The whole height** (round 100, `zmesh`): the window's zMax is the world's height and a margin
  (`layout.ts windowZMax`: the atlas's zTop 480 + 24 → 504; at most `Z_LIMIT` 511, what the surface's 9.8 fixed
  point holds), so oz stays 0, `outside` stays empty, there's no band, and the slide in z below never happens.
  What's sized by zMax: the surface packing (9.8: z bits 0..16, material 17..24, slot count 25..29),
  the physics voxels' columns (`PHYS_COL_WORDS` 16 u32: a bit a cell to 511), the pick's info word (material 8
  bits, z 9, flags 15: common.wgsl `pickInfo`), the field mesh's samples along z (its rebuild scratch, slots ×
  35² × (zMax + 4) × 8 bytes — its sample pass skips the z blocks no later pass reads, fieldmesh.wgsl
  `sampleIdle`), the light's box. `?zwin=248` (or any zwin): the sliding window as before.
- **In z** (round 69, when the LandSource has a `height` taller than the window — since round 100 only with
  `?zwin=`, or a world over 504):
  the window holds world heights `oz` .. `oz + zMax` (the atlas level's
  zMax was 248, the most the 8-bit z held less a margin) and every column
  keeps what's above and below on the CPU (`Streamer.outside`, world z).
  LandSources give world z; the streamer cuts each column at the window
  (`layout.ts` splitColumn) and fits it to K − headroom (fitColumn). When
  the ground under the camera is within 40 of the top or 24 of the bottom
  the window slides a `TIER` (32): the whole window is read back, each
  column joined with what's outside it (joinColumn) and cut again; water
  and lava stay only where the ground's top is in the window both before
  and after; bodies and undo are cleared. A frozen region keeps the oz it
  was left at and is cut again if it comes back at another (`resliced`).
  The sim's z is the window's (the climate's temperature at z = 0 is the
  world's at oz). Water that runs into a column with nothing in the window
  (ground below its floor) drains (water_depth.wgsl).
- `Globals.org` carries the window's world origin: `hash3` adds it to its
  cell coordinates and `wo()` to positions in the noise of the render, the
  wind, the clouds and the ecology's woodland patches, so what they draw
  stays with the land.
- The sim waits (`busy`) only while a region coming in is still being read
  back from its last visit. Frozen regions don't tick (BACKLOG Q31).
- Not yet moved by a slide: the town, units, physics bodies, places (Q32).
- **The band outside the window** (round 79, render/band.ts `OutsideBand`,
  `Renderer.enableBand`, the atlas level): every column's runs outside
  the window (`outside`) packed in window z (under 0 below, over zMax
  above; runs cut at the window's edges reach SEAM 6 across) into a second
  layers buffer and chunk table (BAND_K 12 slots a column), meshed by a
  second FieldMesh (`MeshSource`: its own region uniform — MeshRegion gains
  `zb` (samples' base z, bedrock's top, the cut top a run goes on up past)
  and `ze` (the quads kept: base sample inside or outside a z range);
  REGION_BYTES 96) and drawn with the window's mesh. The window's mesh
  keeps quads under zMax and doesn't close a run reaching it; the band's
  keeps quads outside [0, zMax). It doesn't tick and casts no shadow; it
  shifts with the window's mesh on a slide and is repacked after every
  slide (`Streamer.refreshBand`). `?skip=band` leaves it out. ~58 MB
  (vertex room 2, 3 rebuild slots, samples up the world's height).
- **Sleep and wake** (round 80, sim/sleep.ts `Sleep`, the atlas level):
  each chunk (16 × 16, the layers') is awake until a time. Globals.sleep
  (a bit a chunk, set: asleep; 2 048 chunks) and Globals.drowse (fallen
  asleep in the last 0.25 s); common.wgsl `asleep`, `drowsy`. Skipped
  asleep: surface, structure, edit, water, oil, lava, contamination,
  moisture, fire, wilt, ecology, sediment (its deposit cleared: what lands
  fades), climate. The double-buffered ones copy their value through when
  asleep (their next buffers are copied back over them every tick, and the
  streamer doesn't fill the next ones); structure and edit copy a column's
  slots only while drowsy (sediment, lava and climate write the layers in
  place after the next layers are written: once is enough, then the two
  agree). Water's and lava's flux isn't touched asleep: the surface is
  drawn moving, and a frozen river goes on feeding what's awake below it.
  Wakers: the camera's target (40, 1.5 s), Globals.events (+16, 8 s),
  storms over 0.2 intensity, a slide's new chunks (1.5 s), everything
  after a slide in z (2 s), coarse events in sight, integrity's column
  writes, placed models (WorldCore.sleep). `?sleep=0` off.
  (perfopt, round 83; the low tier's defaults from index.html, `?phone=0`
  off) `settle=0`: land that comes in doesn't wake to settle — drowsy at
  once; a river come in takes the pipes' steady flux for its levels while
  drowsy (water_flux.wgsl FLUX_SEED), the flux is frozen with its region,
  and a streamed column's loose intervals over air are dropped onto their
  support (streamer.ts `settleLoose`). `sleepmore=1`: surface and render
  fields skip sleeping chunks too, every chunk drowsy for 0.25 s after any
  slide. `inplace=1`: edit, structure and layer pulls rewrite the layers in
  place (no layersNext copied back); the brush runs 5 s after an edit.
- **Not dispatched over what sleeps** (round 85, sim/cull.ts; on by default,
  `?simcull=0` off). Simulation.step makes, from the same Globals.sleep and
  drowse masks, a list of the chunks live this tick (WorldGpu.tiles,
  `AwakeTiles`): awake, drowsy, or, for a flow with a `?flowhz=` rate, on its
  slow turn (one list per rate n, made on first ask; a uniform of chunk
  indices). The passes skipped asleep (above; surface only with sleepmore)
  are compiled with a wrapper (`cullSource`: the kernel's 8 × 8
  global-id entry renamed, a new one that finds its columns from the list,
  four workgroups a chunk) and dispatched over the list (`dispatchTiles`; no
  pass when it's empty). Their copies back (water, oil, lava, contamination,
  moisture, fire, veg) run over the same list (`TileCopy`), so a sleeping
  chunk's current buffers are never touched and its next buffers go stale.
  Contract: nothing but a field's own pass and copy reads its next buffer;
  anything that writes a current buffer of a sleeping chunk (particles on
  veg, place ops on water) keeps what it wrote, as before. `?settleiters=`
  needs `?simcull=0` (its passes read waterNext as the water everywhere).
  With `rivers=table` the water's passes aren't culled: a held river's
  columns are simulated asleep (riverheld.wgsl).
  Not culled (they run everywhere by design): particles, project, agents,
  wind field, sway, render fields, lava-prep, stats.
- **The simulation's rates** (perfopt, round 83, sim/flow.ts): `?simhz=60|30
  |15` the tick rate — the kernels' per-60 Hz-tick rates scale by
  common.wgsl `simStep()` (G.dt × 60), `perTick`, `relaxTick`; water, oil
  and lava run `FLOW_SUB` 60 Hz substeps a tick (their pipes' stability).
  `?flowhz=water:N,oil:N,lava:N,sediment:N` a sleeping chunk's flow updated
  N times a second (staggered, common.wgsl `slowTick`, `flowFrozen`) instead
  of frozen. `?windhz=N` the wind field and the API's blows every TICK_HZ/N
  ticks, strokes held for it. `?fieldhz=N` moisture, contamination,
  climate, ecology N times a second (their kernels' step × K: `fieldPass`).
- The sea in a streamed window (round 79): `Globals.ocean.x` (`seaZ`, window z; the atlas level sets it
  from the start) — water_flux.wgsl's off-map neighbour stands at least at it, so the sea doesn't drain out
  of the window's edges (it did: in seconds, during the warmup). The atlas's sea is at 90 (was 28: 27
  deep at most over the floor); the ocean floor drops off near the shore (0.9 × depth over 90) then
  shelves (3 × over 70–650).
  Round 88: a column whose ground lies under the window's floor (nothing inside) under the sea holds the sea from
  the floor up — layout.ts `waterInWindow` wherever a column is cut at oz (Atlas.window, Streamer cutRegion /
  reslice / slideZNow), and water_depth.wgsl drains such a column only where there's no sea (ocean.x <= 0).
- Strata (round 79, render.wgsl `strata`, `strataTint`): rock's beds by height (a noise up the column,
  dipping only over long distances), on stone, soil, basalt and sandstone; bedded rocks (basalt,
  sandstone, obsidian) faceted as stone (they were chips, like rubble); on steep faces less per-cell
  speckle and plants only near the top. The atlas level's columns hold 16 runs (was 14).
- `?win=N` (round 79): the atlas level's window N wide (whole regions); the
  device asks for the adapter's buffer limits (gpu/device.ts), FieldMesh
  says when the mesh can't be bound.
- Where new land comes from is a `LandSource` (round 67): streamgen's noise
  (`noiseLand`), or the atlas. A slide asks for all its regions at once;
  `prefetch` asks for the next slide's when the camera is 0.4 regions off
  the middle (land made ahead is kept in `pending`).

### Region storage: the pool, the store, the record (round 100, branch `regionstore`)

The user (DECISIONS round 100): "I want the world to serialize so we can recover the visited cells that change …
lean towards the whole region until we know we need the other … stream and cache regions ahead of time even
further out ahead of the camera so we never wait for them". Three tiers under the window, one layout:

- **The layout** (`world/region-record.ts` regionLayout): a region's bytes are its chunk pages (rc² pages of
  K × 16² slots, row-major), then each kept per-column buffer (per plane, R rows of R × stride), then each kept
  texture (rows of align256(texels × 16)). Its `sig` (R, K, the window's zMax, the kept fields and strides) names
  it. A GPU pool slot, the staging a region is read back through, and a record's body are these same bytes.
- **GPU pool** (`scenes/region-pool.ts`; `?pool=` slots, default 32 ≈ 52 MB at the atlas's K 16): a region leaving
  the window is copied GPU to GPU into a slot (`Streamer.freezeInto`); it comes back by copies too (`copyIn`: its
  pages to layers and layersNext, its buffers a row at a time, its textures; what isn't kept from a blank buffer on
  the GPU). Land made or loaded ahead is uploaded into a slot (`prepare`, `pump`: a few ms of a frame) before the
  slide that brings it in, so a slide only copies. `Streamer.frozen` is the pool's index in LRU order; the oldest
  not in use is evicted when a slot is wanted. The CPU parts go with a slot: what's outside the window per column,
  the surface, the ground, the relief, the coarse world's snapshot.
- **Change detection**: a region is *changed* once play touches it (`Streamer.touch`, window cells): every event
  sent to the GPU but scares and ripples (edits — the world API's, the editor's, agents' digs, a story's door —
  lightning, chips, a fire lit, a tap to grow: `Simulation.eventTaps`), what falls and lands or comes to rest
  (`Integrity.onTouched`), the coarse world's events in sight (`editLive`). Not the sims' own drift (sediment,
  water, plants: a still region read twice differs in ~40 columns by ≤ 0.03 cells). Every region frozen, and each
  of the window's in turn (one every `SWEEP_MS` = 400 ms; the whole window when the page is hidden), is copied into
  staging and read back off the frame; a changed one's columns are hashed in world z (`columnsHash`: the same land
  cut at another oz hashes the same) and it's written whole when the hash differs from what was saved. A region
  never changed is not saved: evicted, it's made again by the source when it's wanted. Nothing waits for a readback
  but a load of the same region (`checks`).
- **The store** (`world/region-store.ts`, worker `region-store.worker.ts`): IndexedDB `reclaimed-world`, stores
  `regions` (key `world|rx,ry` → the compressed record) and `meta` (→ session, time, raw and packed sizes, hash; read
  whole at open: `has` answers at once). Records are byte-shuffled (each word's four bytes in four planes) and
  deflated (CompressionStream) in the worker; reads are inflated there. `?worldsave=0`: the same tier in the
  worker's memory, nothing on disk. A store that can't open is a console error and the memory tier.
- **The record**: `u32 'RCLR' | u32 n | header JSON (n bytes) | sections` (16-byte aligned, offsets from the data's
  start). Header: `format` (RECORD_FORMAT 1), `gen` (GEN_VERSION 1: bump when the land generator changes), `world`,
  `rx, ry, x0, y0, oz`, `sig`, `session`, `savedAt`, `hash`, `sections`, `things`. Sections: `body` (the layout),
  `outside` (per column n, then z0 z1 mat aux), `surface`, `ground`, `relief`, `gapTop`, `colTop`. A record of
  another format, generator, world or layout is reported (console) and the region made again; one that can't be
  read is a console error and the region made again.
- **Things** (`Streamer.things`, `RegionThings`): what owns cells with a mesh and a transform (sim/external.ts:
  with `?meshinst=1` the resting rock) is taken with a region frozen — `{owner, kind, m (3×4, region-local), state,
  cols, fallback, id}` — and given back when it's written (ExternalRegistry.adopt: its cells are External in the
  columns already). The window's sweep saves them without taking them.
- **The world id** (level.ts worldSaveOf): `atlas:<seed>` (`:run=<id>` in a run, `:<name>` for `?world=<name>`);
  `?world=new` (or the ✦ button, two taps) clears it. On load, the window's regions with a record are written in
  (`Streamer.restore`) before the window slides, and the LandSource's `restored` lets the atlas's hooks (the
  settlements' plans, a run's stage) see that land as made. A warp freezes what the window held into the pool (a
  warp back finds it); `warp(…, fresh)` (a run's stage just laid) makes the window again, using only records of
  an earlier session.
- **Ahead**: while the camera moves (> 6 cells/s) along an axis, `AHEAD` (2, `?ahead=`) strips that way are asked
  for (`bring`: the pool's, the store's, or made; checked for coarse changes; cut at the window's oz; uploaded).
- **Made on the GPU** (round 102, `gpugen`; default, `?gpugen=0` the CPU's way): `LandSource.regionInto(x0, y0, w, h,
  target)` — the atlas's `regionInto` — makes a region straight into a slot (`Streamer.generateGpu`): its columns
  (colHeight, formSeed, colFinish a tile a frame), then `atlas/finish.wgsl` reads colOut/colRuns where they are and
  writes the slot's pages and kept fields in the layout above (the slot cleared first; pool pages are STORAGE too).
  Back to the CPU (`FinishMeta`, ~100 KB): per column the top and ground (window z), the top and highest gap's roof
  (world z), the structural flag, what's outside the window. `RegionPool.temp()` is a slot of its own when every slot
  is taken (let go by `release`). The CPU path and the GPU's make the same bytes (scripts/gpugentest.mjs): heights in
  1/256ths, the ways by integer distance in the region's frame (`ways.ts regionWays`, shared), the geysers' stencil.
- **Stamps** (`atlas/stamps.ts`): what's built into land as it's made is a list of operations a column (PLAN, ADD with
  a mark, VEGMAX, BARE), from `Atlas.stampHooks` (the settlements, a run's stage) in order; finish.wgsl and
  `applyStamps` run them alike. A settlement's plan is made in the plan worker on its box's raw ground
  (`Atlas.rawGround`: finish.wgsl's raw mode, 16 bytes a column back), never on the main thread.
- **Precache**: `Streamer.precache(ox, oy, ring)` asks for a window's regions and a ring round it into the pool; a
  warp uses what's made or under way for its window and asks for its ring (`?warpring=` 1) right after its own.
  Ahead of fast motion: `?aheads=` seconds of it, 2–4 strips.

## The town (round 65, branch `builder`)

`build/towngrid.ts`: Townscaper's irregular grid (relaxed quads over the
hex lattice), per cell four corners and four neighbours, per column its
cell (`cellOf`). `build/town.ts`: blocks (cell, level) and per cell its
ground floor; `design(cell, column)` works out the column's intervals from
the blocks around it; changes restamp the cell and its neighbours.
`TownStampSystem` (`sim.town`, townstamp.wgsl, period 1, after the land
brushes): `ColumnStamp`s — a column, its span [lo, hi), the design, a
foundation flag — up to 4,096 columns a tick, written in place on the
layers; a column queued twice keeps its latest stamp. Built matter starts
at support 15 (aux 240). `api.town(opts)` makes the one town of a sim.
The plan (`plans`, a mask a cell like `mask`) is what a building crew
(agents/buildcrew.ts) builds toward; `delta()` is plan XOR what stands.

## The flow model (round 84, branch `flow`, `?flow=1`)

The user: "a unified model of material flow would be great for waterfalls emerging from underground streams or
lava flows … a water fall that actually arcs out"; "think noita physics which just checks for adjacent emptiness
and moves pixels over. We are just doing this in a compressed column space and adding in velocity"; steady flow
frozen and drawn as an animation, woken only when perturbed. Behind `?flow=1` (any level but the atlas's; the
test scenes: `?flow=1&level=flowlab`, src/levels/flowlab.ts).

- **Gaps and runs.** A column's empty space is its gaps: the air between two solid or granular intervals of
  the layers, and the open air on top (floor: the column's top, or a sleeping body on it). A liquid lies in a
  gap as a run on its floor: slot 0 the open run, slots 1..3 runs under rock (a cave's, a tunnel's floor).
  Liquids aren't intervals *of the layers* — a run is an interval in the column's gaps, held in the flow
  module's own buffer — so a liquid tick writes no layers and no layer reader skips water (see "one system or
  two" below).
- **One kernel set, a liquid's numbers** (`flow/liquid.ts` LiquidKind, prepended as `LQ_*` constants to
  `liquid.wgsl`): gain and friction (how far sideways, how much momentum), yield, thick (thin runs barely
  move), heat (hot, set, runny), drop (what counts as a fall). Water and lava are two instances.
- **Rules per run, per tick:** sideways into each neighbour's gap that spans the run's height (the highest
  floor under its level) by the level difference, keeping last tick's flux (the pipe model's momentum and
  look); no gap: a wall. Where the neighbour's level is more than `drop` under the run's floor, what goes that
  way leaves as a **stream**: off the lip at the critical flow's speed for its discharge, `2 (g q)^(1/3)`, and
  ballistic after (z − g t²/2, g = 14 cells/s² as the spray's particles), so a steady outflow draws a
  steady parabola. **In real time** (round 86): a column holds the volume in flight over it (V) and the
  time its path takes across it (tc); nothing passes on before the stream's front has crossed, then
  V·dt/tc a step — in a steady state V = rate × tc, and a fall's front, its changes and its water go at the
  path's own speed (it had moved a column a step, 10–20× fast). What a run sends off its ledge leaves with
  one velocity, its falls' mean direction (within 60° of each face, else the face's own) at the speed for
  their mean discharge, and no more than the critical flow, √g d^(3/2) a unit of edge, goes over a lip.
  A stream arriving over a sleeping column that had none is carried on there (jets, j3.w = 1), what would
  land held aloft, and its chunk flagged to wake (`act` z bit 2: woken whatever its balance).
  It lands where its path meets the level under it (or a wall: it runs down the face). What flows in, lands,
  springs or rains joins the run in the gap it arrives in; a run whose gap closed moves to the gap above; a
  fourth run under rock is the deepest three kept, the rest counted (`act` w), never silent.
- **Passes** (per 60 Hz step; at `?simhz=30|15` FLOW_SUB of them a tick, each its own uniforms): `flux` (each run's flux and its target per direction: a gap
  index, fall, drain, wall) → `jets` (gather the streams coming on and the runs falling off a ledge; move each
  through its column) → `depth` (gather; write the runs) → publish (water: the open runs into the water
  contract with rain, springs, evaporation, and `flux`; lava: each run cools, boils the water over it, sets
  into basalt in the layers below its setting point — the only layer writes) → `prep` (once a tick: the draw
  lists; the spray along each stream's path — K_DROP particles set off on the path itself, the particles'
  gravity the flow model's — and the splash and mist where it lands, all scaled by the particle ring's size). Records carry the step they were written at: a dry column writes nothing.
  Runs and jets ping-pong by parity (bind groups, no copies).
- **Contracts.** Water replaces the water system: its open runs ARE `water` (`waterPrev`, `flux`), so every
  reader is unchanged and the edit brush, climate and old lava still write it. Runs under rock and streams
  are the module's own (`<kind>Runs0/1`, `<kind>Flux`, `<kind>Emit`, four jet textures each way). Drawn:
  `Renderer.addWaterPrisms` (a new list for the water pipeline: runs under rock as flat prisms, flag 2048
  FLAG_RUN; streams, FLAG_RUN | FLAG_DETAIL, as a sheet along the path — render.wgsl `streamVertex`: a
  curtain across the flow and a band in the arc's plane, three segments each, from the header and two vec4
  after the list's room; `shadeStream` scrolls with the water: its pattern is a function of (time along the
  path − the sim's time), so the streaks fall at the fall's speed, paused when the sim is), open lava through
  `addPrisms` in lava's own instance form (the sandbox's beam and volcanoes keep sim/lava.ts).
- **Steady state** (`flow/steady.ts`). `depth` adds per chunk the net change of its runs and its bed (the
  loose ground moving) and its throughput (the length of each column's net flow vector: a river's discharge,
  nothing for water sloshing in a pool); read back every `?steadywin=` ticks (30). A chunk whose net change
  a tick is under `?steadyfloor=` + `?steadytol=` × throughput two windows running is let sleep (sim/sleep.ts:
  every system skips it; its last flux kept and drawn — the sheet's flow, the fall's arc and spray; the
  sediment's air texture keeps a pour's running grains); one that isn't is kept awake. Events wake for
  1.5 s (`Sleep.eventSecs`) and the steady state decides after. With every chunk asleep the liquid passes
  aren't dispatched at all (the step stands still), only `prep`.
- **Frozen, rescaled** (the user: "keep the flow proportional and then zero out when they get too low"). A
  sleeping column beside an awake chunk checks its balance each tick: its chunk's edge inflow and outflow
  are summed. Past `?waketol=` the chunk is flagged; read back, its flux (and its streams' volume, and the
  water contract's flux) is rescaled by in / out for one step, no simulation (`LiquidU.scale`, the frozen
  paths apply it); under the floor, zeroed (dried up); a change past `?rescalemax=` (4×) either way, or
  something arriving where nothing flowed, wakes it to find its new steady state. Shape changes (edits,
  powers) wake it by their events.
- **One system or two.** Loose ground stays in the sediment system and liquids are this one, sharing the
  column/gap view of the layers (recommendation, round 84): granular ground is the layers themselves (strata,
  repose, wind, wash; it *is* the ground, and it changes the gaps), liquids are what lies in the gaps (no
  strata, per-run momentum, every tick). One kernel with granular numbers (repose for gain's threshold, set at
  once when at rest) would carry *moving* sand — a pour off a ledge as an arc — the way lava already sets; the
  next step, if wanted (BACKLOG FL4).

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
(`render.wgsl` vsBody/fsBody, buffer bound at 3). Any system or game can
draw voxels this way: `Renderer.addVoxels(inst, indirect)` takes a
GPU-written instance buffer and drawIndirect args (36 vertices, one
instance a voxel); per voxel two vec4<u32>, (centre xyz as f32 bits,
material word) and the rotation quaternion xyzw as f32 bits. The word:
bits 0-7 material, 24-29 size (0 a whole cell, n is n/16 of a cell: 4 a
quarter, for a fine game model, round 49), 30 a physics voxel (8-15 its
speckle, 16-23 its heat), 31 a structure grid's (8-11 moss and 12-15 sand
to 16 levels, 16-20 its snow or dust cover, 21 dust; structprep.wgsl repacks
the pool's word so 24-29 stay 0); a
game model leaves 30-31 clear. They are lit and cast shadows like the
world, with the field mesh or without, and pick as bodies (flag 0x8000).
`WorldCore`'s last argument turns the field mesh on (the sandbox passes
it). In the sandbox the GPU
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

Falling pieces in the columns (round 86, `collapse`; DECISIONS round 86): what
the integrity system frees no longer becomes a cube body. `game/colbodies.ts`
`ColumnBodies` keeps a piece as its runs, column by column (the rock's whole
runs from analyseRock's `Fracture.pieces`, fractional ends kept; a structure's
cells joined into runs), plus an offset `dz` and a speed (the same feel:
gravity 10, drag, 4 cells/s at most; straight down). Each frame the columns it
covers are written to the GPU's layers as their *base* (what the column holds
without the falling pieces) plus every piece there at its offset; the CPU copy
(`WorldVox.slots`) holds only the base, so analyses and the pieces' own
collision (the gap under each run to the highest base top or another piece)
never see a piece in flight, and a readback that brings one back is overwritten
by the bases (`restoreCpu`; columns written while a readback was in flight are
put back too: `Integrity.inflight`). The field mesh meshes the piece as the
ground it was — same look, shading, hybrid voxel chunks — split from what's
under it, the chunks marked urgent (below). Landing: hit at 1.2 cells/s or
more, the rim columns of its foot within the impact radius crumble (rubble
through `deposit`, chips thrown at the impact speed, dust); a piece of 16
cells or fewer crumbles whole; the rest is committed (base + runs, CPU and
GPU) and its columns judged again. The old `Bodies` (cube voxels, the
projection) stays for API compatibility, empty.

Field mesh urgency (round 86): `FieldMesh.urgent(x0, y0, x1, y1, frames)`
marks the chunks over a world rect; their near word carries `URGENT_BIT`
(0x10000) for those frames: always hashed (even asleep), allowed the
`URGENT_SLOTS` (4) rebuild slots over the tier's ordinary ones
(`MeshRegion.pr.x`; `k.y` is both; the ordinary count lives in the rebuild
args' spare word), and the window's mesh is looked at every frame while any
is marked (not on the band's alternate turn). The level marks the cuts
(dig, smash, crater, take; a crater by its bowl) and the integrity system its
falling pieces. `MeshRegion` is 128 bytes (`pr`).

The integrity pass (round 86): a cut sent this tick (`Simulation.eventTaps`)
makes the next pass start at once rather than on the 0.35 s timer — its
readback is submitted after the tick that carried the cut — and reads back
only the chunks it looks at by default (`?intread=all`: all the layers, as
before); the drift texture is no longer read (the cube bodies used it).

What hangs free (round 88, `collapse`; DECISIONS round 88): `fracture.ts`
`analyseRock` judges *runs* — a column's touching intervals of anything but air
and liquid (rock, a structure on it, the soil on that: `columnRuns`). A run
reaching the window's floor stands; one over air is held through runs of the
six neighbouring columns it is `joined` to (intervals that hold sideways —
solid or plant — overlapping by half a cell) back to a standing run or the
map's edge. From the runs in and beside the cut columns, each hanging piece is
followed to its end (one held nowhere has no cap; a held one stops at 4096
runs, and a piece joined to such is held with it) and falls whole, whatever
it's made of; held, its rock past span × thickness gives. The pass reads back
the chunks round its seeds; a piece reaching columns not read this pass is
left (`Fracture.need` / `undecided`), those chunks read and the piece judged
again at once (`Integrity.needChunks`), so a fall never writes back stale
columns. Edits that aren't events say what they changed: `Integrity.cutAt`
(the heat beam), `cutCols` (a great meteor's window edit), `watch(x, y, r, s)`
(a meteor's rim melting and setting, the beam's bore draining: judged once a
second). `floatingRuns(world)` is the ground truth the tests hold it to (a
flood from every standing run). In `ColumnBodies` a piece that catches up
with one falling under it rides down on it rather than landing mid-air. The
sandbox's break tool, dig and meteor no longer wake structures into physics
bodies: everything they undercut falls through this path.

What holds rock up, and the window sliding (round 92, `collapse`; DECISIONS round 92). Intervals touch face to
face (`touch`) when they overlap by half a cell or by half the thinner one's thickness, and a column's intervals
that overlap count as touching. A held piece is then weighed (`analyseRock` opts.weigh: true, or a test of the
columns an edit itself changed — `Integrity.cutSeeds`, a crater's bowl and rim rather than its 30-cell ejecta —
so the land as made stands and what an edit weakened is judged): (1) cross-sections from the far end in (its
distance from what holds it): every part k or more steps out weighs its mass (cells × the table's `density`)
against its joints to the runs k − 1 out, each `strength × min(ROCK.BEND h², ROCK.SHEAR h)` (h the overlap);
the part most over gives there and falls (one break a pass); (2) else the piece above its lowest point zc with
the standing runs it's joined to above zc (followed `ROCK.NECK_R` columns; past that, the map's edge or a run a
flood before found so: keyed into the land) on the standing columns under it, each bearing `ROCK.CRUSH ×` the
least `bear` down its run (materials.ts: rock 1, soil 0.3, sand 0.15 …); heavier than that, or its centre of
mass off their hull (`ROCK.TIP_GIVE`), those columns crush from where it would land to zc and it falls straight
(rotation: BACKLOG C4). `Fracture.why` counts the reasons. The streamer calls `onBeforeSlide(dx, dy, dz)`
before a slide, a slide in z or a warp touches the columns: `Integrity.settle` lands every piece falling in the
strip that leaves (all of them for a slide in z or a warp); `Streamer.columnsHeld` (a slide in z, a warp: the
columns read back and written again) holds the integrity system (`Integrity.held`: nothing falls or is judged);
`onSlide` → `Integrity.slid` moves the seeds, watches, boxes and the falling pieces (`ColumnBodies.shift`) with
the land. Before, a piece falling when the window slid was frozen, cut again or written at its old place mid-air
and forgotten — the meteor-made floaters.

Rigid rock (round 95, `rockbody`, `?rockbody=1`, default off; DECISIONS round 95). With the flag, the rock judge's
pieces (`Fracture.pieces`) are rigid bodies instead of column falls (structures' pieces still fall in the columns):
`game/rockbodies.ts` (pure CPU: cells of the lattice about the centre of mass, mass and inertia from cells ×
density, impulses at exposed cube corners with restitution and Coulomb friction, sleep, a break into pieces by
impact speed against `RB.breakSpeed × √strength`) knows the world only through `RockGround` — `Integrity`'s probe of
its CPU copy of the columns (in solid or loose ground: out the top within 0.6 of its run's top, else through the
nearest open hex face). `analyseRock(…, { rotate: true })` returns a tipping piece cut free above the standing
columns (not crushed) with the hull edge it tips over (`Fracture.tips`): the body starts turning about it
(`RB.tipSpin`). `Integrity.spawnRigid` takes the piece's runs out of both copies; `settleRigid` writes its cells
back where it rests (each down onto what's under it in its column — no cell left over air — in place of a liquid),
seeds those columns (not weighed) and watches them 4 s. `settle` (before a slide) runs the leaving bodies on alone
to rest and writes them; `slid` shifts the rest and freezes them (`RockBodies.frozen`) until the copy is read
again. The phone cap `RB.maxBodies` settles the oldest first. Drawn: `render/rockmesh.ts` (`Renderer.enableRockMesh`)
— a third `FieldMesh` (the band's pattern: `MeshSource` with `pages`, and `FieldMesh.pin` instead of the camera's
cull) over a sparse layers copy whose chunk table points every column chunk at one empty block but the slots': a
body's cells are written once into a slot (a rectangle of mesh chunks, shifted whole columns and an even number of
rows) and meshed there; `rockmesh.wgsl` vsRock moves each vertex by its slot's body transform (spawn frame → world,
`RockMesh.setDraws`: a uniform at binding 31 of the mesh layout), fsRock shades it with the mesh's look from where
it came from (the copy's intervals, the spawn frame's strata, specks, facets, plants), lit where it is. A break
draws the parent's slot split by the fragments' Voronoi seeds (a ghost, `BUILD_FRAMES`) while theirs are built;
a settled body's mesh stays 6 frames. The cubes are only drawn for a body with no slot (too big: over 3 × 3 mesh
chunks, or no room) or with `RB.cubes`; they always cast the shadow (`Renderer.setBodies(data, count, shown)`: the
main pass draws the first `shown`).
Round 96: on by default in the atlas and the rock lab (`rockbodyFor(level.id)`; `?rockbody=0|1`). Metal (steel,
rust) isn't the judges' with it on: `Integrity.takeMetal` strips it from what they found and `wakeMetal` takes
everything of it connected (26 round, METAL_MAX cells) out of both copies into one physics body
(`Physics.spawnLattice`; cells on other ground pinned, as wake.ts does), set by the level (`Integrity.physics`).
It's drawn as its particles' voxels; `?rbskin=1` (an experiment) gives it a rock-mesh slot meshed as stone and drawn
skinned per vertex to the particle of its cell (`RockDraw.skin`: rockmesh.wgsl reads the particles' positions, rest
and rotations at bindings 32–34, `Renderer.setRockParticles`; `Physics.buffers`), tearing where a triangle
stretches past 1.6× or its particle is gone. A one-sided failure leans (round 96 (2)): with `rotate`, neck() turns
any off-centre give (tips, snaps, buckle, a crush with the weight off the leg's middle) into a tip — over the hull edge
the centre of mass is past, or over `facingEdge` (the edge it lies toward) with the rest of the leg's top two cells
crumbled — and the body leans (`RockBody.tipping`: undamped, not at rest) till it comes down.
Round 96: the piece above a cut also fails on a slender leg — `ROCK.BUCKLE × strength × I / L²` (I the leg's least
second moment from its columns, L from where the piece would land to the cut; only a leg free over more than 2√A
buckles) — or when its weight off the leg's middle pulls on the leg's far side past `ROCK.TENSILE × strength`
(fracture.ts `legOf`); a piece already resting (a quarter of its hanging runs within a cell of what's under them,
its centre over those) isn't judged off its leg. ROCK and a material's `bear` are set from the address
(`?crush=` … `?bear=sand:0.1`) or the rock lab's panel (src/ui/rockpanel.ts), logged `[rock]`. The rim's watch
weighs; the columns a piece left are judged again (weighed); intervals within `FILM_GAP` (0.02) touch. The meteor's
blast melts only columns whose top is within `BLAST_UP` (4) of where it hit (lava.wgsl, `LavaU.blast2.z`).

## Agents (round 52, docs/AGENTS.md; branch `agents`)

`installAgents(core)` (src/agents/) adds one system after the particles and
a voxel source on the renderer. Its buffers are its own (not world
contracts): `agentNav` (per column NAV_K = 4 surfaces, vec4<u32>: height,
headroom | wet | six 3-bit links, room, region — the peel reads `places` and
`placeTable` in its own bind group), `agentDist` (NFIELDS = 4 fields × surfaces,
f32), `agentUnits` (four vec4 a unit: units.wgsl), `agentOcc` (units per
column, two halves by tick parity), `agentEvents` (a count and 8-u32
records: swing, hurt, death, alight; the CPU copies and clears it in
`sync`), `agentModels` (the kinds' voxels) with `agentKindModels`, and
`agentInst` (body-format voxels, appended) with its indirect args, and
`agentShove` (per column, two halves: the momentum and mass tumbling units
carried through it, and how many burning units). The peel reads `layers`,
`water` (stored on each top surface: nav.w), `places`/`placeTable` (nav.z:
room | region << 16). The units read `fire`, `lava` and the sparks texture
(catching fire). Four bind groups, each within 8 storage buffers: peel, fields,
units, draw. A tick: every 8 ticks the
surfaces are re-peeled and linked; `agentSweeps` sweeps (quality: low 2, high 8) of the fields with seeds; the
occupancy half cleared; every unit stepped; every unit's voxels written.
The params uniform (binding 10) carries counts, 32 seeds, each group's field
and colour, each field's place, 8 kinds, 32 hits, 8 targets, 8 holds, 32
launches.

## Climate (round 50)

`Globals.rules.y` is the air's temperature (°C) at height 0 by day and
`rules.z` its fall per cell up (GlobalsState `climate: { temp, lapse }`;
absent: 15 °C, no fall), so a level can have snow on its peaks while its
valley rains; `airTempAt(z)` (common.wgsl) is 4° colder at night.
`snowShare(t)` splits a storm: the water pass rains only the warm share;
`ClimateSystem` (climate.wgsl, period 4, after sediment) lays the rest as
snow through `deposit`, melts snow and ice on top when warm (lava and fire
on the column add their heat) into `water`, freezes water onto the ground
under it when cold (ice, from the bed up; the water is drawn under a frosted
skin meanwhile, fsWater), drops leaves under trees (leaf litter, to a carpet
0.3 deep) and rots them into the soil under them where it's damp. Rain
streaks turn to slow swaying flakes where the air is freezing (rain.wgsl).
Materials (round 50): 25 snow and 26 leaf litter (loose; a breeze moves
them, they blow as particles, raise no dust), 27 ice and 28 crystal (solid,
`look.y` see-through: renderprep puts up to two a column into the blended
list with the liquids, hiding nothing behind them; shadeGlass breaks their
faces into tilted facets). Physics bodies of ice shatter to snow, crystal
to sand.

## Seasons (round 51)

`Globals.rules.w` is the season, 0..1 through the year from midsummer
(GlobalsState `season`; `?season=`; WorldCore `yearLength` seconds turns it,
`?year=`). common.wgsl: `seasonColour` (the leaves turned, ~0.35–0.55, gone
by ~0.9), `seasonShed` (falling, ~0.46–0.8), `seasonBare` (crowns bare,
~0.55–0.78, green again by 1), `autumnLeaf(species, h)`, `seasonGrass`.
render.wgsl thins broadleaf crowns (canopyMarch density) and turns them
(species 1, conifers, stays green), turns the grass cover and tufts
(meshdraw too); particles.wgsl sheds K_LEAF from broadleaf crowns (state 1 +
species: drawn in autumn colours); climate.wgsl drops leaf litter mostly in
the fall, in drops of 0.01 (thinner tops are spent to the sediment pass).

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

## Level kit and gate validator (round 31; docs/LEVELS.md)

`world/kit.ts` builds a level from a short script (`levels/<id>.ts`): shape
the land (height field: `land`, `sculpt`, `level`, `rock`, `river`, `pond`),
`ground()` turns it into columns (stone, soil, a loose soil top), then
features stamp onto the grid and the MapData fields (`green`, `poison`,
`dust`, `litter`, `trash`, `slick`, `wall`, `plug`, `tank`, `ruin`, `model`,
`cache`). Shapes are SDFs (`disc`, `ring`, `rect`, `band`, `union`,
`subtract`, `wobble`). `gate(id, name, kind, shape, teaches)` records the
columns of an obstacle; `build()` returns a `KitMap` (MapData + `gates`).
Kit levels may be `hidden` (not on the title screen: `MENU_LEVELS`).

`scripts/mapview.mjs` runs a generator on the CPU through Vite's SSR loader
and writes a top-down PNG with the gates outlined. `game/trial.ts` is the
page side of `scripts/gates.mjs`: `reclaimed.trial.run(ability, s, settle)`
applies one ability to every gate through Powers / Weather / events (wind
strokes one after another, cyclones, parked storms, scripted lightning
(`Powers.scriptStrike`), poured water, focused chips; 'ambient' sends one
natural storm and one dust storm), and measures each gate from readbacks
(surface, contam, oil, moisture, water, driftTex): share closed, share
fertile, amount of its stuff left.

## Dialog, the run and story cameras (round 83, branch `dialog`; docs/SYSTEMS.md 10, 11, 5)

Coded against src/api/contracts (dialog.ts, run.ts, story.ts, world.ts); each piece knows only its inputs:

- `src/dialog/dialog.ts` — `DialogBox implements Dialog`: `open(tree, at?) → path`, `isOpen`, `onChoice`;
  beyond the contract `onNode(tree, node)` (each node said: the run applies its effects and notes
  `talked`), `onOpen` / `onClose`, `close()`. Choices filtered by a `check(conds)` callback; indices are the
  node's own (hidden ones counted). DOM in `#ui`: `.dlg-scrim` (swallows input while open) and `.dlg`.
- `src/run/run.ts` — `StoryRun implements Run` over a SessionStory and a WorldState: `note(fact)`,
  `update(dt)` (the clock), `holds(c)` (`all(conds)` for a list), `objectives()`, `flag`, `has(item)`, `attitude(character)`,
  `entry(tree)` (its last unlocked node), `hear(dialog)`, `end(how) → RunRecord`; events `onObjective`,
  `onOutcome(outcome, cause)`, `onEnd`. AtlasEvents (and faction attitudes, as `faction-attitude`) go to
  `WorldState.apply` when the outcome fires; the RunRecord to `WorldState.record`.
- `src/run/validate.ts` — `validateStory(json) → SessionStory`, or a `StoryError` listing every problem
  (references only, no snapshot needed; the GM's storycheck is the full check).
- `src/run/hud.ts` — `ObjectiveHud(root, run)`: the shown objectives, bottom left.
- `src/story/camera.ts` — `StoryCamera(camera, { dither?, slice? })`: `frame`/`release`, `reveal`, `look`,
  `follow`, `skip`, `idle`, `busy`, `update(dt)`. Writes only `camera.target` and `camera.zoom`; the
  cutaway through Dither.see / Slice.update.
- `src/story/play.ts` — `StoryPlay.start({ ui, camera, api, world, story, stage, cut })`: the above over the
  world API (terrain for heights and the cast's pillars; plants, water, fx for play-scale stand-ins of
  atlas events). `Stage` maps story locations and cast to world positions: the region generator's output
  later, hand-written now. `holdsInput`: the level's controls wait (a tap skips a reveal).
- `src/story/demo/` — `?story=demo`: a placeholder story (JSON) and its stage in the valley; the level
  (`LevelScene.startStory`) makes a MemoryWorldState for it. `window.reclaimed.story` is the StoryPlay.

## A run story as a hero (round 88, branch `runstory`; docs/HEROES.md, docs/SYSTEMS.md 6, 8, 3)

`?skipmenu=1&level=atlas&run=bell`: the GM's story played as a hero on the atlas level. Each piece is coded
against a contract and knows only its inputs:

- `src/api/contracts/units.ts` — `Units`: spawn(kind, at, faction, { name, character, settlement, role,
  hostile, health, sight, speed, damage, colour, job }), get, query(near, r, filter), byCharacter, order(job),
  setHostile, hit(id, damage, by), remove, watch(actor), shift, update; events died / hurt / noticed. `Actor`:
  what takes part without being a unit (the hero). `src/units/simple.ts` `SimpleUnits` is the CPU stand-in;
  the GPU agents (`settlements`) are to implement it.
- `src/api/contracts/hero.ts` — `Hero` (an actor, abilities, a camera preference, position / heading / speed,
  health, update(dt, HeroIntent), place, shift, hurt / died) and `HeroController` (intent()). `src/hero/walker.ts`
  `Walker` on foot; `src/hero/touchpad.ts` `TouchPad` the phone-first controller (a floating stick, ⚔, a
  context button; WASD / Space / E). It sits under the rest of #ui, over the canvas: the level's Controls see
  none of its pointers.
- `src/units/figures.ts` — `Figures`: the hero and units as a few voxels each, written from the CPU every frame
  into an instance buffer drawn by `Renderer.addVoxels` (units.wgsl's instance form: centre f32 × 3 + the
  material word with the size in bits 24–29 and the body glow for the hurt flash; a quaternion).
- `src/story/stage-gen.ts` — `stageStory(story, deps) → { stage, pieces }` (round 99; was `edits`): the region generator's first pass at
  a story's briefs (system 3). Each location goes toward its real spot on the atlas (the settlement's site,
  else the region's centre), pulled in near the spawn. Its rooms are circles out from the first one along the
  connections: walled, with a doorway toward each neighbour, or open. Locks plug the far room's doorway;
  landmarks are matched by keyword. All of it is made with the world API's `terrain.build`. Returns the
  `Stage` (locations, cast, `rooms`, `locks`).
- `src/story/play.ts` (additions) — with `units`, the cast stand as units (the badge follows them) and
  `killed` is noted when a unit dies. An Outcome's `spawn` appears as units (`hostile` from the spawn), and
  its `hostile` turns cast members on the player. Rooms note `reached { location, room }`. A lock opens when
  the player comes to it holding its key (`terrain.dig`). The new methods are `shift`, `canTalk`, `unitOf`,
  `characterOf`, and the options `onBadge` and `again`.
- `src/story/hero-run.ts` — `HeroRun.start(deps)`: the stage, the units, the hero (`makeHero`, default Walker),
  the pad, StoryPlay (`reached` from the hero), the chase camera (StoryCamera.follow, plus Orbit.prefer behind
  the heading while it moves) and Dither. A tap on a person walks up and talks, or fights if they're hostile;
  a tap on the ground walks there. The hero's death ends the run, lost. `window.reclaimed.run` is the HeroRun
  (`.world`: its MemoryWorldState).
- `LevelScene.startRun` — the atlas level only. It loads the story, and the world it was written for from
  `data/wiki/seed1.run.json` (the factions and the story's regions, cut from the GM's 4 MB wiki). The spawn
  and the spots go into window coordinates the shortest way round the torus, and `core.onShift` shifts the
  run when the window slides.
- (round 94) `src/story/waypoint.ts` — `objectiveTarget({ story, run, stage, units, unitOf, heightAt }) →
  Target` (a person, a place or a door, from the shown objective's own conditions) and `Waypoint` (a marker in
  view, an edge arrow with the distance), plus `describe(from, to)` ("north-east · 140 m"). HeroRun shows it,
  and puts the line under the objective with `ObjectiveHud.hint(id, text)`. The level gives the atlas map
  `marks` (the target's pin), `playerAt` and `facing` (the hero's dot and wedge). AtlasMap's additive options:
  `marks`, `playerAt`, `facing`, `canWarp`. A map warp in a run calls `HeroRun.warped(dx, dy, dz, at)`.
  `HeroIntent.sprint` is the run toggle.
- Story contract (additive): `Outcome.spawn[].hostile`, `Outcome.hostile` (cast ids); storycheck and
  validate accept and check them.
## A run over the streamed world (round 99, branch `runstream`; BACKLOG RS9, RS16)

The window streams during a run: nothing of the story is kept in window coordinates across a slide or a warp.

- **Stage in world units.** `HeroRunDeps.frame` (a `StageFrame`, story/play.ts: `toWin(p)` a stage point into the
  window as it is now, the nearest way round the torus; `toWorld(p)` back). startAtlasRun passes one; HeroRun moves
  the generator's stage onto it before StoryPlay starts, so `HeroRun.stage` (locations, rooms, cast spots, locks) is
  in **world units** (x cells, y world units = rows x ROW_H, on the torus). StoryPlay measures `reached`, `saw`, the
  locks, the talk queue and the spawns' rooms through `toWin`; waypoint.ts `objectiveTarget` takes `toWin` (its
  `Target.at` stays window coordinates, made each frame). `HeroRun.winOf(p)` / `HeroRun.worldOf(p)` convert for a game
  or a script. Without a frame (the god's-eye `?story=`), the stage is the window's, as before.
- **Places in world cells.** `stageStory` returns `{ stage, pieces }` (StagePiece: a disc of a material, `layers`
  high, `pass` 0 or 1, a `tag`: `wall`, `landmark`, `lock:<id>`; `grow` for plants) instead of building.
  `HeroRunDeps.realise(pieces)` builds them (default: the world API's edits, waited for). startAtlasRun's realise
  keeps them in a `StageLand` (story/stage-land.ts), an `Atlas.landHooks` hook like the settlements': each region's
  land, as the atlas makes it, gets the pieces over it laid on its columns' tops (edit.wgsl OP_BUILD's
  smoothstep(1, 0.5, d) profile; overlapping pieces of a pass take the tallest). The window is made again in place
  once (`Streamer.warp` to its own origin) so the places come in as land; after that every first arrival and every
  warp stamps them; a slide freezes and thaws them with everything else.
- **What lasts, as a diff.** `StoryPlayDeps.lasting` (`StageLasting`: `opened(lock)`, `built(at, material, radius,
  layers, tag)`) hears an opened lock (its `lock:<id>` pieces gone from the next stamp), a cast member's grave and a
  mark's cairn (added as pieces); `StageLand.watch` (once a second from startAtlasRun) finds a piece seen standing
  whose top has come down (a broken wall) and drops it. `HeroRun.land` is the StageLand (`pieces`, `stats`).
- **Units.** `HeroRun.shift` shifts the units only when they're its own SimpleUnits; a game's own units keep in step
  with the window themselves (the GPU agents through `WorldCore.onShift`). A warp shifts the run's own by the jump,
  so the cast keep their world spots while their land is away.
- **Streamer (one block).** On an x/y slide the world's queued events (`globals.events`, window coordinates) shift
  with the window, so an edit queued across a slide lands where it was aimed.

## Heroes from another game (round 97, branch `heroapi`; docs/HEROES.md)

The hoverbike game (GameplayGM, which vendors Reclaimed as a submodule) plays a run story with its own heroes,
controls and enemies. Everything it needs is an additive change to the contracts and HeroRun's options; the
level's `?run=` goes through the same call.

```
GameplayGM (the game)                         Reclaimed (the engine)
 hero select → HoverHero (Hero)      ─┐
 Controls → HoverController           ├─ startAtlasRun({ atlas, stream, core, api, story, world,
   (RunController)                    │                   makeHero, units, makeController, ownCamera,
 FoeUnits (Units) over sim.agents    ─┘                   again, remember })  (story/atlas-run.ts)
 its chase camera (ownCamera)                └─ HeroRun ─ StoryPlay ─ StoryRun / DialogBox / ObjectiveHud
 save: WorldSnapshot ─────────────────────── runWorld(story, snapshot) → MemoryWorldState.restore
```

- `src/story/atlas-run.ts` — `startAtlasRun(deps) → HeroRun`: what `LevelScene.startRun` did, for any game with
  an atlas and its streamer: the window held round the spawn, each story location's spot on the atlas, HeroRun
  started, slides and the map's warp kept in step, the map's dot / facing / pin. `RUN_STORIES`,
  `loadRunStory(id)`, `runWorld(story, snapshot?)` (fresh from data/wiki/seed1.run.json, or restored).
- `HeroRunDeps` (additive): `units` (a game's own Units, drawn by itself: no figures for them), `makeController`
  (a `RunController` in place of the TouchPad), `ownCamera` (the game drives the camera while `cameraFree`; no
  follow, zoom or Orbit.prefer from the run), `again` (the end card's new run), `remember` (past runs' events,
  realised at play scale as the run begins).
- `contracts/hero.ts` (additive): `HeroIntent.talk` (talk as an intent), `Hero.claims(sx, sy)` (a tap the hero
  takes for its own mechanics: asked first, a claimed tap never walks or talks), `Hero.goesTo` (false: a vehicle
  that doesn't walk itself to a point; a tap on someone far says "go closer"), `RunController` (HeroController +
  onTap, onAction, setAction, setHealth, hidden).
- `contracts/units.ts` (additive): `Units.all?()`.
- `contracts/story.ts` (additive) — dialog as an event: `Outcome.say` (barks: a line over its speaker or the
  narrator's), `Outcome.talk` (a cast member's dialog opens — queued until the screen's free and the player is
  within SIGHT of them), `Condition.saw` (the hero first within SIGHT, 16 cells, of a cast member alive or of a
  place's edge; StoryPlay notes it), `Outcome.spawn[].toward` (they set off for a location), `Objective.short`
  (the objective list's few words). Happenings are the triggers: their `when` conditions (a death, arriving, a
  sighting, a collapse) fire the line or the talk once. validate.ts and the GM's storycheck know the new shapes.
- `contracts/world-state.ts`: `MemoryWorldState.restore(snapshot)` — the world as a save left it.
- `StoryPlay`: barks (`bark(b)`, `.story-bark`), the talk queue, `saw` sightings, marks with their names over them
  (`.story-mark`), `remember`.
- DialogBox: a frame's timestamp before the line's start made the typing step negative; with reduced motion
  (cps Infinity) that was −Infinity, so the line never finished and the answers never showed (the phone bug).

## The game master (round 84, branch `gm`; docs/GM.md, docs/SYSTEMS.md system 9)

The GM writes a run's `SessionStory` (src/api/contracts/story.ts) offline, from the world wiki. For now it is a
Claude subagent run with docs/GM.md as its context. Later it will be a model called behind the same interface.

- **The wiki's facts.** `src/gm/atlas-facts.ts` `atlasFacts(atlas)` reads a built Atlas without changing it (its
  defs, landforms, regionOf, macro heights, river nodes, stamps and settlement). It gives each region's kind,
  tier, climate, ground min/mean/max, neighbours, river and lava nodes and stamps. Sites: world point, level
  cell, size, setting, region. Roads: their ends, the regions they pass and their crossings. Also
  Atlas.spawn and its region. `scripts/worldwiki.mjs --pull` runs it once in a page (headless,
  `?atlas=view`) and caches it to `data/atlas/seed<N>.json`, so nothing after needs the browser.
- **The wiki.** `src/gm/wiki.ts` has `buildWiki(facts) → WorldWiki` and `wikiMarkdown(wiki, {around, radius})`.
  Both are pure and deterministic, and run in Node and the browser.
  - A `WorldSnapshot`: version 0, the atlas's `seed`, run 0 (the run to come), every region fresh except
    for faction presence, and the `settlements` (settlement.ts's draft shape).
  - Beside it: geography (`regions`), `sites` (each settlement's setting, atlas size, cell and roads),
    `roads`, `continents` and `factions` (marked as placeholders).
  - Names (regions, continents, settlements) come from a syllable table, one tongue a continent.
  - **Factions are placeholders.** Realms are each continent's settlements clustered (about 32 a realm,
    named for the seat). Four world factions (Ashwrights, Green Choir, Hollow Court, Salt Fleet) are present
    where their kinds of land are. They wait for the user's diplomacy design.
  - Output: `data/wiki/seed<N>.json` and `.md`.
- **The validator.** `src/gm/storycheck.ts` has `checkStory(story, world) → string[]` (every problem; empty
  means clean) and `checkWorldFrom(json)` (a wiki or a bare snapshot). It checks:
  - shapes against story.ts, with no extra keys;
  - every reference, item spellings, and flags set before they're needed;
  - AtlasEvent kinds and magnitudes: a flood's `level` against the region's ground (when the wiki gives it),
    faction-presence and faction-attitude −1..1, `location` a story location in the event's regions;
  - `any` conditions, cast `room`s, and `from` (version, run to come, seed) against the snapshot;
  - then a fixed point over what can happen: every node reachable, every objective shown and done, every
    happening fired, every room reached through its locks, a way to win and a way to lose, and an AtlasEvent
    somewhere.

  Its runtime lists of kinds have compile-time checks that they cover world.ts's and story.ts's unions.
  CLI: `scripts/storycheck.mjs`.
- **The adapter.** `src/gm/gm.ts`: `GameMaster.brief(snapshot, player: PlayerRecord) → Promise<SessionStory>`.
  `FileGM(ids, load)` serves the first listed story whose `from` matches the snapshot's version and run, and
  validates it again. It throws on a story with problems, and when no story was written for this world.
  `fetchGM(ids)` loads `data/stories/<id>.json` from the dev server. The player is run.ts's `PlayerRecord`.
- **The format's meanings** (now in story.ts's, dialog.ts's and run.ts's comments; docs/GM.md "The format"):
  - conditions in a list are ANDed, `any` ORs its own;
  - a happening fires once;
  - a talk opens at its most recently unlocked node, else at its start;
  - a brief's first room is its way in;
  - `time.after` is seconds of run time;
  - a flag condition with `value: false` holds while the flag is unset.
- Node runs the gm modules directly (type stripping). So they import only types, or runtime modules with a
  `.ts` extension (tsconfig `allowImportingTsExtensions`), and use no TS-only runtime syntax (no parameter
  properties, no enums).
- Test: `scripts/gmtest.mjs`. The first story and docs/GM.md's example come out clean, 18 kinds of mistake
  are caught, and FileGM serves and refuses as it should.

## Things and diplomacy (round 85, src/api/contracts)

- **recipe.ts.** Everything made is an `Instance` of a `Kind` (tags, base stats, slots). Its `parts` fill slots by
  tag (`TagQuery`), so a hoverbike fills a knight's `mount` slot as a horse does. A `Recipe` says how things
  combine (assemble keeps parts, craft uses them up, train adds a skill tag, adapt gives an existing thing new
  parts and function, salvage takes it apart). `CapabilityRule`s (data) read the composition's tags — its own
  plus each part's as `slot:tag`, and `has:slot` — and give stats, abilities, tags and unmet requirements.
  `CivProfile.knowledge` holds a mastery per recipe: uses, repairs, makes or understands.
- **compose.ts.** `derive(catalogue, id)` gives a thing's capabilities, parts first. Nothing stores them, and
  condition scales the stats. `plan(catalogue, civ, recipe, at, facilities)` fills a recipe's slots from what's
  at hand, or says why it can't: making needs `makes`.
- **diplomacy.ts.** `Interaction`s are a party's deed to another. Each has a weight (−1..1) and a half-life in
  runs; witnesses and kin take half. `Agreement`s are terms: war, truce, peace, alliance, trade (flows), land
  rights, mineral rights (share), passage, tribute or vassalage, with places and resources. An `Opinion` (value,
  stance, the interactions behind it) is derived. Breaking an agreement notes a broke-word interaction.
  MemoryDiplomacy is the reference implementation.
- **settlement.ts.** A settlement lays its districts out on overlay `SettlementGrid`s (irregular, contour
  Voronoi, radial, orthogonal). Its buildings are things on grid cells, and their `use` is derived.
  `founded.over` records adaptive reuse.
- Test: scripts/recipetest.mjs.

## Settlements and units in play (round 88, branch `settlements`; docs/SYSTEMS.md 6, 7, 12)

- **Records (atlas scale).** `Settlements` (src/settle/settlements.ts) makes one `Settlement` (settlement.ts) per
  atlas site from the world wiki built live (`buildWiki(atlasFacts(atlas))`: the ids `s<n>`, names, regions and
  realms the GM's stories use). records.ts picks each one's `CivProfile` (data/recipes/civs.json, by the realm's
  era and the site's setting), whether it stands over an older ruin, whether raiders camp near it (the region's
  hostile power, else `f-outlaws`), and its box: whole streamer regions round it. A settlement not in play
  advances its `stores` by their rates (a day is `DAY_S` = 600 s). Rights: each realm holds land rights over its
  settlements' regions and mineral rights over those and some neighbours (MemoryDiplomacy); a quarry outside its
  own region is worked only with mineral rights there (`diplomacy.rights(region, at)`).
- **Arrival.** `Atlas.landHooks`: after the ways, each region's land goes through the hooks (raw lands skip
  them). The first region of a settlement's box that's made plans it (plan.ts) on the raw ground of the whole box
  (`regionLand(…, raw = true)`, a tile a frame while streaming), once; every region of the box then gets the
  plan's columns stamped in (what stands is real matter: intervals in world z, cut and frozen by the streamer like
  any land). Deterministic: the same settlement plans the same whichever region comes first.
- **The plan.** Districts on overlay grids (src/settle/grids.ts): `radial` (rings and spokes, sectors doubling
  outward), `contour-voronoi` (Voronoi seeded on the ground's height contours), `irregular` (Townscaper's merged
  triangles), `orthogonal` (a turned square lattice). Every style makes lots (polygons); `LotGrid` cuts each lot
  into a ring of yard quads and its inset polygon cut centre-to-midpoints (the footprint), as a `CellGrid`
  (build/towngrid.ts: what `Town` builds on; Townscaper's `TownGrid` is one). The core district is the profile's
  first style; a town or city has a second round it; the fields are an orthogonal district past the wall.
  Buildings are `Town` blocks (walls, floors, doors, windows, roofs from the neighbours) in the building's
  materials (the profile's `look`), each a `Building` whose `thing` is an `Instance` (house, hall, granary,
  workshop, megastructure …) with parts (rooms, hearths, a forge, bins), its `use` derived (compose.ts) by the
  rules in data/recipes/core.json. Also: the plaza's well and stalls, a wall ring with gates and towers, furrowed
  fields, the quarry spot, a ruined tower adapted into homes (`founded.over`, its history `adapted`), a camp of
  tents round a fire (its own Settlement record, `size: 'camp'`, hostile people). `spots` are where agents go:
  homes, stores, posts, farm, mine, repair, make, trade, the camp.
- **Units.** src/units/agent-units.ts implements the `Units` contract (api/contracts/units.ts, runstory's) on the
  GPU agents. Per unit on the CPU: the job, faction, health (GPU hp = 3 × it), its target. Groups and fields:
  striking (0, standing, the work pose), standing (1), three shared goal fields for go / patrol / follow / flee /
  back-to-post (agents fields 9–11, groups 2–4, keyed by where), the defenders' field on the foes (field 8, group
  5), the hunt (targets, field 7, group 6), hostiles loafing (7); fields 0–6 and groups 8–15 are the settlements'
  rounds (life.ts). Hostile units notice what's within their sight and join the hunt; the GPU swings, its
  swing events become damage (an actor's `hurt`, a unit's `agents.hit`). Guards and units ordered to attack close
  in on the foes' field and strike on the CPU. Window coordinates.
- **Life (play).** The planned settlement nearest the camera inside the window (40 cells in from its edge) is live
  (src/settle/life.ts, a `Routine` the units hand 'work' jobs to): its people within the tier's budget (28 on the
  phone tier, 48 otherwise; `?townfolk=`) — guards at their posts; each role on its own round, a field a leg
  (farm 0, fell 1, quarry 2, home 3, store 4, the heaps 5, the house going up 6): miners take the quarry's floor
  exactly (terrain.take) and put it on the stone heap (terrain.put), woodcutters fell real trees (plants.fell) and
  heap the logs, builders carry from the heaps to the site, where every 1.2 cells³ a block of the house stands (a
  `Town` over the site's lot in window coordinates, stamped through the town system; its floors fixed relative to
  the door's ground so the grid can be made again when the window moves); a finished house is a Building +
  Instance on the record and four more people. Farmers carry sheaves to the granary. Standing at work, a group's
  units are drawn bent to a tool (`agents.workPose`). The growth field (field.ts: the settlement's intensity and
  style over its box, the ecology pass's shape) steps every 8 s while the grain lasts; when nothing's being built,
  the free lot it's strongest on becomes the next site. A raid (`settlements.raid()`): the camp's raiders march on the plaza, workers run home, guards meet them;
  it ends repelled (all raiders dead) or looted (70 s: a quarter of the stores gone). Events: built, died, raided.
- **Agents' changes.** `NFIELDS` 12 (was 4; `fieldPlace` three vec4s), `MAX_SEEDS` 48 (was 32), `spawn(…, { hp })`,
  `workPose(group, on)` (bit 8 of the group's material word: unitDraw bends the figure and adds a tool voxel; a
  swing bends it too); a field left without seeds is set unreachable once (`n3.w`, the fields to clear) and then
  skipped by the sweeps; with no unit, nothing in flight and no field seeded, the agents' pass does nothing (no
  peel, no sweeps); the first tick that needs the surfaces peels them.
- **The plan's ground work.** `ColumnPlan.cut` (the ground let down: benches, an apron, a well) and `.hole` (a gap
  through a column: an adit under the rock that stays over it).
- Debug: `?towndebug=1` (src/settle/debug.ts). Tests: scripts/settletest.mjs (the planner, no browser),
  scripts/settlementtest.mjs (in play).

## Instrumentation (round 100, branch `hitchrec`)

- **CPU steps**: gpu/cpustat.ts `record(label, ms)` / `timed(label, f)` — the perf overlay's worst steps, and while
  the hitch recorder runs, every step ≥ 0.5 ms into two reused arrays (`spans`). A system that wants its work
  attributed in a hitch times it under a label; the label's family (before the first '.') is the cause.
- **GPU passes**: gpu/profiler.ts timestamps a pass when `active`; `frameNo` and `onFrame(frame, ms, top)` give each
  frame's GPU time to whoever listens.
- **The hitch recorder** (`?hitch=1`, src/perf/): main.ts calls `frameStart(now)` before `scene.frame` and
  `frameEnd(cpuMs)` after, `heldFrame()` for a rAF held for the GPU. It owns no system's state: it reads the spans,
  the profiler's frames, PerformanceObservers, FinalizationRegistry canaries and the GPU traffic counted by
  perf/gpumem.ts (which wraps the device's create/submit/write/map calls once, at boot, only with `?hitch=1`).
  `window.reclaimedHitch` = { rec, mem, report() } for scripts. The report is one JSON (kind
  'reclaimed-hitch-report'); the dev server's /__hitch (vite.config.ts) writes it to perf-reports/.
- **The judge's inputs** (integrity.ts): edits, cuts, watches, lightning, cyclones and the first window's structures
  seed it; land that comes in with a slide does not (round 100). A pass judges structure boxes for at most 8 ms.
- **The world API's mirror** (api/mirror.ts, round 100): paged sources (the layers) are read by pages round
  `Paged.focus()` — the camera's target and `Terrain.keepFresh` points — between whole reads (every 8th, after a
  slide, `refresh(true)`); `?mirror=full` reads everything every time.

## Benchmark (round 101, branch `bench`)

**How to run it on the phone.** Plug the Pixel in if you can, open
https://csheldondante.github.io/Reclaimed/bench/?bench=1 in Chrome, tap **Start benchmark** and put the phone down
with the screen on (it keeps itself awake). The page reloads itself four times (the atlas at your range, the hero run,
the other two ranges) — don't switch apps; a page that went to the background is marked `hiddenDuring`. After about
five and a half minutes it shows a few headline numbers and a big **Download report** button: the JSON lands in
Downloads (`reclaimed-bench-<date>-<phone>.json`) — send it with Quick Share, Drive or Gmail, or tap **Copy** and paste
the whole JSON into the chat (no selecting), or **Share…** for the share sheet. The last result is kept: opening
`?bench=1` again shows the same buttons. Your saved world isn't touched (the bench plays in worlds of its own and
clears them).

- **`?bench=1`** (src/perf/bench.ts) is a chain of page loads; its state (`reclaimed.bench.state`, versioned) is in
  localStorage between them, the last report in `reclaimed.bench.last`. main.ts asks `benchMode(params)`: `start`
  and `final` run instead of any scene (`benchStandalone`: nothing else draws); `level` pages load the atlas level as
  deployed (every system on, the phone flags as usual, `?hitch=1&hitchhud=0`) and `benchLevel` runs that page's
  part once `window.reclaimed.stream.store` is open, then goes to the next page.
- **Pages:** start (device facts, the fixed GPU workload, readback/upload/copy) → main (the atlas at the viewer's
  range, `?at=` driveprofile's road, `?drive=18` held till the ride) → hero (`?run=bell`) → the other two of
  scenes/range.ts RANGES → final (the workload again, the report). Each level page uses its own world
  (`?world=bench-<id>`): the viewer's saved world is never read or written; the bench's worlds are cleared at the end
  (and at the next start, if a run was cut short).
- **It reads, it doesn't change:** the engine's objects through `window.reclaimed`; the profiler's frames through a
  chained `onFrame` (its per-pass map read in the callback); the CPU steps from gpu/cpustat.ts; the hitch
  recorder's report. Its own GPU timing (`GpuTimer`, its own query set) is lent to the atlas as `atlas.profiler`
  while it makes regions, then given back. The two hooks it adds to the engine: `TilePacer.fixed` (tiles a frame
  held at N while it measures; 0 = paced, the default) and main.ts's `setRenderScale` (the tier's scale, resized).
  Region generation is timed stage by stage by calling what `Atlas.regionLand` and `Streamer.generate` call
  (`columns`, `landFrom`, `stampWays`, `landHooks`, `cutRegion`, `toBody`, a writeBuffer to a scratch buffer) on
  fresh land regions 12+ regions from the window; nothing it makes enters the pool or the window.
- **Report:** one JSON, `kind: 'reclaimed-bench'`, `version: 1`: `device`, `thermalStart/End`, `io`, `main`
  (`idle`, `regionStages`, `tiles`, `mesh`, `agents`, `renderScale`, `store`, `ride`, `pan80`, `pan120`, `warp`,
  `meteor`), `hero`, `win<N>`, `derived`. A measure is `{unit, n, p50, p95, max, mean, min}`; GPU numbers are
  timestamp-query's or the string `'n/a'`; wall-clock ones say so in their unit. src/perf/report-io.ts takes it
  off the phone (download, copy, share; the dev server's /__hitch?kind=bench → perf-reports/bench-*.json) — the hitch
  HUD uses the same.
- **v2 (round 102, `bench2`):** `version: 2`. Every capture judges its timestamps (`timestamps.reliable`: the
  passes' sum a frame over 1.5 frame intervals, or a frame's first-to-last span over 1.25 → false — the Pixel 9a's
  Mali). The **A/B** (`main.ab`, the window pages' `ab`) turns one thing off for 2 s at a time against the 2 s before:
  a sim system's `encode` shadowed by a no-op on the instance (deleted after: the prototype's again), the agents'
  likewise, a renderer piece by `Renderer.skip` (the live set drawbench uses). It reads the frame interval's mean and
  the median wall from a frame's submit to `onSubmittedWorkDone` (its own rAF callback runs after main.ts's). Only a
  bound frame shows a cost in its interval (`ab.bound` says which). The start page times one workload three ways
  (`timestampModes`). The report opens with `summary` (the headline numbers), then the details.
- **Scripts:** scripts/benchrun.mjs runs it headless and writes the JSON (data/bench/desktop-igpu.json is the desktop
  baseline); scripts/benchdiff.mjs prints two reports' measures side by side with their ratio.
