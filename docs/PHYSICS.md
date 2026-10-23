# Physics voxels

The `physics` branch (cut from `grids`, DECISIONS round 43): the sandbox as
a playground for destruction, and as terrain for other games. What the user
asked for:

- **Materials with properties.** Metal bends like World of Goo, both
  elastically (springs back) and plastically (stays bent past its yield).
  Stone fractures into bigger pieces that then move as rigid bodies.
- **Lose energy, never gain it.** How it looks matters more than never
  interpenetrating. Big things crumble and collapse and rarely bounce;
  small debris may still fly. An overlap too deep turns the voxel into its
  loose material (gravel, sand, dust) instead of being pushed out.
- **Destruction tools to play with:** a heat beam that cuts (first), then
  meteor impacts and volcanoes.

## One solver, every material

Every voxel of a physics body is a particle on its body's lattice, bonded
to the 26 around it. All of it runs on the GPU (`src/shaders/phys.wgsl`,
host `src/physics/physics.ts`); the CPU only places bodies and aims the
beam.

**Lattice shape matching** (Rivers & James 2007), solved per substep
(4 substeps a tick, 4 iterations each):

1. *predict*: gravity (20 cells/s²) and the move.
2. *region*: each voxel's region is itself and what it's bonded to. Find the
   rotation that best maps the region's rest shape onto where it is now
   (the polar part of Σ m (x − c)(r − c0)ᵀ, Müller et al. 2016's iteration,
   warm-started from last substep).
3. *gather*: each voxel moves toward the mean of where its regions would
   put it, by its material's stiffness (1: rigid; less: soft). Heat lowers it.
4. *contacts*: a spatial hash (2¹⁸ buckets); the ground from the layers
   (the column under it and its six walls); other voxels it isn't bonded to.
5. *finalize*: velocity from the move; a bounce at the material's
   restitution and Coulomb friction where it touched; bonds strained past
   the material's break strain snap; damping takes a share of each bond's
   stretching speed out (round 48: a knocked body doesn't ring; turning
   stretches no bond, so spin isn't slowed).
6. *relax*: past the yield, the rest shape follows the bend (plastic flow);
   heat evens out along bonds, cools, and the beam adds it. Cracks (round
   48): a bond whose end hit something faster than the material's crack
   speed snaps by chance (more often the harder; both ends draw the same
   random), and a voxel that lost three bonds that way may crumble, so a
   hard landing breaks concrete into chunks with rubble and dust along the
   breaks.
7. *split* (round 49): a crumbling voxel breaks into eight fragments half
   its size (below).
8. *deaths*: what crumbled goes to the deposit buffer as its loose material,
   by its volume (the sediment pass folds it into the layers), with a chip
   and some dust; what melted leaves as embers.

### Mixed resolution (round 49)

The user's ruling: not uniformly smaller voxels, but coarse simulation
refined where it's needed. Two ways in:

- **A body's own voxel size.** A model's `voxel` (1, 1/2, 1/4: n/16 of a
  cell) sets its lattice spacing; size code in each voxel's info (bits
  16–21, 0 a whole cell). Its mass goes with its volume, its contact radius,
  step-up, crumble depth, yield and the air and dust it shoves with its
  size; the smaller of two voxels is the weaker (a fragment breaks on what it
  hits, not the other way round). The world stays whole cells; a small thing
  like the hover bike gets a fine lattice of its own.
  `reclaimed.phys.drop('steel', 24, 2, 2, x, y, above, 0, 0, 0, 0.5)`.
- **Fracture refines.** A voxel that crumbles (an impact, a crack's seam, a
  squeeze) breaks into eight fragments half its size (*split*: velocity and
  heat its own, sprung a little apart, each turned its own way) instead of
  going straight to dust. Fragments are unbonded (body 255, a ring of 8192
  slots at the start of the particles; bodies start after it); one that
  crumbles in turn, comes to rest (0.6 s) or grows old (6 s) goes to dust
  and loose ground, so a block breaks into chunks, then pieces, then dust.
  Voxels halved below a quarter cell go straight to dust, and so do the
  heart of a blast (the meteor turns what it hits to dust) and a voxel
  deep in the ground. When the ring comes round onto a fragment still
  flying, that one goes to loose ground where it is, so no mass is lost.

Headless (`phystest --scene fine`): a half-cell steel bar across two posts
bends under a half-cell brick, which cracks open; a half-cell concrete
block falling 14 cells keeps 368 of 512 voxels (72%) and sheds about 1,200
fragments at the peak, all gone to dust by 4 s; the whole-cell slab beside
it keeps 53 of 64 (83%). The `fall` scene is unchanged (the slab keeps
116 of 144); `stress` costs 1.4 ms (it was 1.2–1.9).

Then once a tick: *fold* (crumbled ground into `deposit`) and *prep* (each
voxel with an open face becomes a rotated-cube instance for the body
pipeline: bit 30 marks it, bits 8–15 a stable speckle, 16–23 its heat,
24–29 its size).

### Meshes over bodies (round 49)

The user's ruling: mixed, not only voxels — lo-fi meshes deformed by control
points, still part of the simulation. A mesh body (`Physics.spawnMesh(mesh,
voxel, pos, q, vel)`, src/physics/mesh.ts) is a lattice of voxels built under
the mesh (`latticeFor`: a voxel wherever its centre is inside the mesh or
within half a voxel of its surface, of the nearest triangle's material) and
the mesh drawn over it. The voxels are what the world feels — contacts,
heat, lava, the beam, wind, sand, fracture, fragments — and are hidden
(info bit 22). Each mesh vertex is bound (`bindSkin`) to the nearest four
voxels within 1.25 voxels of the nearest, smooth weights; once a tick
`skin` moves it to the weighted sum of each voxel's position plus its
region's rotation of the vertex's rest offset, so the mesh dents, bends and
twists with the body. A triangle is dropped when the voxels under any of
its corners have mostly gone or an edge has stretched past 1.6 times its
rest length: it tears where the body breaks. A hidden voxel that has lost a
face neighbour it had at spawn (gone, or a crack that has opened past a
quarter voxel; bits 23–28 keep its spawn faces) is drawn, so a break shows
the inside as voxels; fragments are drawn as voxels too. Triangles are
flat-shaded with the bodies' shading (render.wgsl `vsSkin` → `fsBody`: the
world's light and shadow, a speckle per triangle, heat glow per triangle).
Up to 16,384 triangles over all bodies.

Test meshes: `reclaimed.phys.meshes.box(mat, w, d, h, step)` (faces cut
into a grid) and `.rock(mat, r, subdivisions, seed)` (a lumpy icosphere);
`reclaimed.phys.dropMesh(mesh, voxel, x, y, above, yaw, pitch, roll)`.
Headless (`phystest --scene mesh`): a 12 × 1 × 1 steel beam mesh on a half-
cell lattice across two posts bends round a concrete block dropped on it; a
brick crate mesh dropped 14 cells dents and tears at a corner, voxels in the
tear; a concrete rock dropped 12 cells is half crushed, mesh and rubble.

### For games (round 49)

What a game built on Reclaimed (the GameplayGM experiments) uses, all in
src/physics/:

- `installPhysics(core, { wakeOnTouch })` (install.ts): the solver and lava
  into a WorldCore in their order, their voxels, meshes and lava drawn, a
  ruin a body runs into woken. The sandbox level uses it too. Returns
  `{ physics, lava, waker }`.
- `waker.wake(x, y, z, r, { materials, flood })` (wake.ts): the map's ruins
  within r of a point (z < 0: any height) and everything they connect to,
  foundations pinned (the default); or `flood: false` with a height: only
  the cells within r, none pinned (a chunk torn out of a wall or rock).
  Resolves to `{ bodies, full }`; with no room in the solver nothing is
  taken. One wake at a time (each reads the layers the last left).
- `physics.spawn(model, pos, q, vel)`, `physics.spawnMesh(mesh, voxel, pos,
  q, vel)`: bodies from voxel models and from meshes.
- `physics.drive(body, { pos, q, vel, stiffness, damping })` / `null`: every
  voxel is pulled toward where that pose puts it (a spring, damped toward
  `vel`; critical damping by default); the body follows and still collides,
  bends and breaks. A grab, a carry, a vehicle steered; let go and it's
  free. Stays until changed.
- `physics.impulse(body, dv)`: a velocity change over the next tick (a
  throw, a hit).
- `physics.push({ kind: 'pull' | 'push' | 'wind', at, radius, strength, dir,
  body, sizeRef, damping })`: a force field for one tick (call it each tick;
  eight at most). Strength in cells/s² at the centre, to 0 at the radius;
  `sizeRef`: bodies smaller than that many voxels feel it in proportion (big
  pieces move, small ones and fragments barely); `damping` settles what it
  holds. `physics.setPushes(list)` replaces what's queued instead (a game
  that sets its fields every frame: frames with no tick between don't pile
  them up).
- `physics.state(body)`: `{ pos, vel, q, alive, total, damage, heat, tick }`
  read back from the GPU every tick (a tick or two late): its centre,
  velocity, mean rotation (what `drive` takes), voxels left, damage = 1 −
  alive / total, the hottest voxel's temperature. A crash is a jump in
  `vel`; damage grows as voxels crumble, melt or break off as fragments.
- `physics.blast(at, radius, strength)`: inside crumbles to dust, near is
  thrown. `physics.beam`: the heat beam.

Headless (`phystest --scene game`): a steel crate driven 8 cells up and
held, then thrown (lands 13 cells off); a mesh sled driven along at 3
cells/s; a pull with `sizeRef` 30 lifts a 64-voxel stone 8 cells and leaves
a one-voxel stone where it lay; a chunk torn out of the nearest ruin wall
(`flood: false`) rises under a damped pull and falls when it ends. Physics
in the stress scene: 1.43 ms (the pushes loop costs nothing measurable).

### Contacts never push out

A contact only stops a voxel moving further in: the ground resets its
downward move this substep, a wall its move into the wall, another voxel
the closing part of their moves (each its share by mass). An overlap it
already has stays. That way no contact can add energy (a shove out of an
overlap reads as energy from nowhere). Crumbling replaces penetration:

- deeper than 0.6 into solid ground, or 0.5 into a voxel of another body
  (the weaker of the two, by density × crumble speed): it crumbles;
- an impact faster than the material's crumble speed (stone 14 cells/s,
  concrete and brick 9, steel 40) crumbles some of the voxels that took it
  (20–60 %, more the harder): the rest hold and stop the body, so a hard
  landing crushes its face rather than every layer in turn;
- voxels of one body that started within two lattice steps of each other
  (a squeeze, the two faces of a crack) only stop each other, never crumble.

A contact's bounce is capped at restitution × the speed it came in at, and
it never leaves faster than 0.3 cells/s otherwise.

### Materials (physics.ts PHYS)

| | stiffness | yield | break strain | restitution | crumble (cells/s) | melt |
|---|---|---|---|---|---|---|
| stone, concrete, brick, bone | 1 | never | 0.02–0.04 | 0.1 | 9–14 | 1600 |
| steel | 0.6 | 0.025 | 0.25 | 0.2 | 40 | 1400 |
| rust | 0.5 | 0.02 | 0.1 | 0.1 | 18 | 1300 |
| wood | 0.7 | 0.2 | 0.15 | 0.2 | 22 | 300 |
| canvas, trash | 0.25–0.4 | 0.2–0.4 | 0.12–1 | 0.05 | 10–40 | 250–350 |

Heat between a material's soften and melt temperatures lowers its stiffness
(to 8 %), its yield (to 0) and its break strain (to 30 %): hot steel sags.
The beam heats steel about three times faster than stone.

Damping (share of bond stretching speed per substep): rocky 0.5, steel 0.2,
wood, rust, trash 0.25–0.3, canvas 0.15. Crack speed: concrete and brick 5
cells/s, asphalt and bone 7, stone 9, rust 14, wood 16; steel, canvas and
trash never crack.

## The map's own structures

They stay terrain (the layers) until something touches them (round 44):
the beam, the break tool (💥), or a body running into them (collide
reports the column — phys.wgsl `touches` — and the host reads the list a
few times a second). Then `Level.wake` floods out from the cells near the
touch through every structure cell they touch (concrete, brick, rust,
steel, canvas: not stone, the bedrock; not asphalt, the roads), up to 6,000
cells; those leave the layers and become bodies, one per connected piece,
each voxel starting where its cell stood (rest positions are world
positions: the hex rows half a cell apart). A cell resting on the ground is
a foundation, pinned until its bonds break; so is the edge of a piece cut
off at the limit (it holds on to the rest, still terrain).

A foundation (pinned where it stood on the ground) lets go once there is
no ground under it (dug, blasted, melted away: round 48; it hung in the
air before), and digging with physics on wakes the ruins round the brush.

## The ground sees them

Each tick `prep` marks the columns under every live voxel (its centre and
six points 0.3 round it, so a turned body leaves no holes): one bit per
cell of height (`physCols`, 8 words a column). The projection pass turns
each run of marked cells into a stretch, merged with what the nature grid
sees of structures, so poured sand lies on a body, water runs round it,
the air under a table stays air, and the loose ground under a body can't
slump out (it no longer sinks). Tops are whole cells (up to half a cell
off). Sand a body is nudged up into stays on
it (sediment: a projected interval the sand starts inside holds it); a body
that moves away leaves its sand to fall.

## Dust and air

A voxel landing on something faster than 3 cells/s shoves the air out from
under it (`physPuff`: the wind field pushes out from each wind texel by how
hard it was hit, so a slab landing flat blows out from its edges; the wind
lifts the sand round it like any gust) and may kick up a low dust cloud
(haze particles). Every crumbled voxel puffs dust too.

## Lava

One molten material for the beam and volcanoes (round 47; sim/lava.ts,
lava_flux.wgsl, lava.wgsl). A liquid field like oil: per column its depth
and temperature, and the heat of the ground at the column's top.

- **The beam on the ground** heats the column it hits (within 2.5 cells of
  its top); past 1300 the top of the layers melts into lava (4000 of heat
  per cell melted), so a held beam digs a glowing pit through sand and
  stone alike (never below z 1), and the lava pools in it. The lava on it
  is kept molten (no hotter than 1400).
- **Volcano** (🌋 tap; round 48: it was far too short): first its cone
  rises out of the ground, 30 cells over 10 s (radius 21, concave sides
  with ridges and gullies, a crater 2.5 across): the column's bedrock grows,
  lifting all that lies on it, and the loose ground slides off the steep
  sides. Then its vent pours 9 cells³/s at 1350 into the crater for 30 s
  (four at most), with a fountain of embers, a smoke plume and ash; the
  lava overflows and runs down the gullies.
- **Meteor** (☄️ tap; round 48): it comes in from the sky in 1.6 s, a
  burning head and a smoke trail. On impact (edit.wgsl `OP_CRATER`) a bowl
  12 cells in radius is blown out of everything there, ground and ruins
  alike, and is gone to dust; ejecta land round it as drift out to 2.5
  times the radius, thinning outward. The ruins there wake and a blast
  (radius 12) crumbles the bodies in it and throws those near; six ripples
  of wind push out every way (radius 55) and lift the loose ground; a
  flash, clouds of dust and ash, chips, embers and smoke; a molten pool in
  the bowl.
- **Flow**: virtual pipes, slow (gain 0.012, friction 0.9), only while hot
  (fluidity from 750 to 1150), and not over a step under 0.12, so it runs in
  tongues and stops as it cools; the heat travels with it. Thin lava barely
  moves (round 48: it flows as (depth / 0.8)²), so it gathers into streams
  rather than racing down a slope as an unseen film.
- **Cooling**: e-folding 0.06 a second per cell of depth (thin lava sets
  first); water over it boils off as steam and quenches it. Below 750 it
  sets at 0.6 cells/s into basalt on top of the column (under a skin of
  loose ground that slid onto it, so it doesn't leave sand and basalt
  slices). Basalt is part of the field mesh.
- **Fire**: hot lava spits embers, which light what they land on.
- **Bodies**: a voxel in lava heats toward its temperature (steel fastest),
  softens and melts.
- **Drawn** as a smooth sheet over the field mesh (round 48: it was hex
  prisms; prisms still without the mesh), like water's: six triangles round
  each column's centre at the lava's level, a dry neighbour's corner at its
  ground just under the level, so the edge slopes into the ground. By
  temperature: yellow-white hot, orange, then a dark crust with glowing
  seams; it lights what's round it like fire. Basalt (set lava) is ground,
  part of the field mesh; columnar basalt isn't modelled.

## Using it

- Sandbox tools: 🧱 **drop** (a body from the list: test shapes and every
  model, a height above what's under the pointer), 🔥 **beam** (hold on
  something: drawn from the sky to a dot, 80 px above the finger on a touch
  screen; it heats everything along its line in front of where it hits, so
  through a hole it has cut it keeps eating the sides and cuts through) and
  💥 **break** (wakes what it hits, then a blast: what's inside crumbles,
  what's near is thrown). The beam on bare ground melts it into lava; 🌋
  **volcano** raises a cone where you tap and erupts; ☄️ **meteor** strikes
  where you tap.
- In the console: `reclaimed.phys.drop('steel', 18, 2, 2, x, y, above)`,
  `reclaimed.phys.spawn(model, x, y, above, yaw, pitch, roll)`,
  `reclaimed.phys.physics.readPositions()`.
- `node scripts/phystest.mjs --url http://localhost:5181 --scene drop|beam|cut|heat|stress|one|sand|slam|melt|gbeam|quench|volcano|meteor|fall|dig|fine|mesh|game [--one mat,w,d,h,above] [--perf 1] [--gif out.gif --frames 45]`.

## Cost

Intel Xe-LPG, 1400 × 900: 24 bodies (1.5k voxels) 1.3 ms of GPU a frame;
one 30 × 30 × 12 block (10.8k voxels) 1.5 ms. Most of it is the fixed part
(about 60 dispatches a tick, the hash cleared four times).

## Not yet

- Large bodies are only as stiff as 4 × 4 iterations allow (a 30-wide slab
  flexes a little): a cluster-level rigid pass for rigid materials.
- Lava bombs (hot physics bodies, once spent bodies can be reused),
  eruptions that build and fade; the meteor as a physics body that
  tumbles in (it is particles on a straight path).
- Sleeping: every live voxel is solved every substep.
