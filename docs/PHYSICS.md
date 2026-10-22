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
7. *deaths*: what crumbled goes to the deposit buffer as its loose material
   (the sediment pass folds it into the layers) with a chip and some dust;
   what melted leaves as embers.

Then once a tick: *fold* (crumbled ground into `deposit`) and *prep* (each
voxel with an open face becomes a rotated-cube instance for the body
pipeline: bit 30 marks it, bits 8–15 a stable speckle, 16–23 its heat).

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
- **Volcano** (🌋 tap): a vent pours 6 cells³/s at 1350 for 25 s (four at
  most), with a smoke plume, ash and embers.
- **Flow**: virtual pipes, slow (gain 0.012, friction 0.9), only while hot
  (fluidity from 750 to 1150) and not over a step under 0.12, so it runs in
  tongues and stops as it cools; the heat travels with it.
- **Cooling**: e-folding 0.06 a second per cell of depth (thin lava sets
  first); water over it boils off as steam and quenches it. Below 750 it
  sets at 0.6 cells/s into basalt on top of the column (under a skin of
  loose ground that slid onto it, so it doesn't leave sand and basalt
  slices). Basalt is part of the field mesh.
- **Fire**: hot lava spits embers, which light what they land on.
- **Bodies**: a voxel in lava heats toward its temperature (steel fastest),
  softens and melts.
- **Drawn** as prisms, by temperature: yellow-white hot, orange, then a dark
  crust with glowing seams; it lights what's round it like fire.

## Using it

- Sandbox tools: 🧱 **drop** (a body from the list: test shapes and every
  model, a height above what's under the pointer), 🔥 **beam** (hold on
  something: drawn from the sky to a dot, 80 px above the finger on a touch
  screen; it heats everything along its line in front of where it hits, so
  through a hole it has cut it keeps eating the sides and cuts through) and
  💥 **break** (wakes what it hits, then a blast: what's inside crumbles,
  what's near is thrown). The beam on bare ground melts it into lava; 🌋
  **volcano** opens a vent where you tap.
- In the console: `reclaimed.phys.drop('steel', 18, 2, 2, x, y, above)`,
  `reclaimed.phys.spawn(model, x, y, above, yaw, pitch, roll)`,
  `reclaimed.phys.physics.readPositions()`.
- `node scripts/phystest.mjs --url http://localhost:5181 --scene drop|beam|cut|heat|stress|one|sand|slam|melt|gbeam|quench|volcano [--one mat,w,d,h,above] [--perf 1] [--gif out.gif --frames 45]`.

## Cost

Intel Xe-LPG, 1400 × 900: 24 bodies (1.5k voxels) 1.3 ms of GPU a frame;
one 30 × 30 × 12 block (10.8k voxels) 1.5 ms. Most of it is the fixed part
(about 60 dispatches a tick, the hash cleared four times).

## Not yet

- Large bodies are only as stiff as 4 × 4 iterations allow (a 30-wide slab
  flexes a little): a cluster-level rigid pass for rigid materials.
- Volcanoes: a cone (the vent's ground pushed up), lava bombs (hot physics
  bodies, once spent bodies can be reused), eruptions that build and fade.
- Meteors.
- Sleeping: every live voxel is solved every substep.
