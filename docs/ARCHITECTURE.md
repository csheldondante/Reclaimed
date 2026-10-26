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

## Contract buffers (src/sim/world-gpu.ts)

| buffer | type | written by | read by |
|---|---|---|---|
| layers | vec4<u32> slots: z0, z1 (f32), mat \| aux << 8 (aux = support·16 + damage) | structure, sediment, edit | structure, sediment, surface, renderprep, edit |
| surface | u32: base of the loose run (8.8), material under it, slot count, bits 30/31 buried loose / air gap | surface | most systems |
| drift, strata (textures) | the loose run as seen from above (derived from layers) | surface | sediment, particles, water, oil, ecology, wilt, render… |
| deposit | vec4 per column: editor ±, a crumbled body's amount + material, a cold storm's snow and a tree's leaves (climate), a place's bury (placeop) | edit, CPU (integrity), climate, placeop | sediment (folds in, zeroes) |
| pullGiven | f32 per stroke slot (8) and column: the height a layer pull's stroke has given it | layerpull | layerpull |
| shake (texture) | rgba32float per column: x the tick the ground was shaken, y how hard (0..1): loose ground there slips at up to 80% less steep a slope, up to 1.5× as fast and unheld by roots, for 240 ticks (sediment `shakeAt`) | layerpull | sediment |
| places | u32 per column: low u16 the room of the open air on top, high u16 the room of the enclosed level under it (0 the same); 0 no place (docs/PLACES.md) | CPU (`core.places.load`) | placeop |
| placeTable | u32 per place id (MAX_PLACES 4096): a room's region, a region itself | CPU (`core.places.load`) | placeop |
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
  (`waterSource`: what comes from upstream), lava springs. The ground is made
  twice: first without rivers (to find them on), then with them.
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
- **In z** (round 69, when the LandSource has a `height` — the atlas's 480):
  the window holds world heights `oz` .. `oz + zMax` (the atlas level's
  zMax 248, the most the 8-bit z holds less a margin) and every column
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
- The sea in a streamed window (round 79): `Globals.ocean.x` (`seaZ`, window z; the atlas level sets it
  from the start) — water_flux.wgsl's off-map neighbour stands at least at it, so the sea doesn't drain out
  of the window's edges (it did: in seconds, during the warmup). The atlas's sea is at 90 (was 28: 27
  deep at most over the floor); the ocean floor drops off near the shore (0.9 × depth over 90) then
  shelves (3 × over 70–650).
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
