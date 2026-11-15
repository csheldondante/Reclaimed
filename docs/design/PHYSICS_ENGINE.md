# Physics engine: build note against DESIGN §10

A build note, not a new design. Authority: `.claude/docs/design/DESIGN.md` §3, §9, §10, §24. Branch `physics10`
(from `fortress` 7ea5e4da). Everything marked **proposal** is mine and fills a place where the design names no
mechanism; everything quoted is the design's. Nothing here is built yet.

## What today's code is (read, 2026-11-15)

- The lattice (`src/shaders/phys.wgsl`, `src/physics/physics.ts`) has no body rows. Every dispatch covers all used
  particles (`physics.ts:854`), sleepers return early per voxel (`phys.wgsl:401`), and the 2^18-bucket voxel hash is
  cleared every substep (`physics.ts:873`, 4096 workgroups × 4).
- Its sleep decision is on the CPU, from a 16 KB `bstat` read every tick (`physics.ts:647`, `updateSleep` `:761`), and
  structure wakes come from a `touches` read (`:659`). Both break §10's rule "No per-tick CPU readback of bodies."
- Limits baked in: 255 bodies (8-bit id in `pr.w`, `phys.wgsl:23`), `PV_CAP` 131,072 voxels, 8,192 fragments, 128
  hash-chain steps (`phys.wgsl:479`, contacts past it are dropped silently).
- Two projection paths exist: `MAT_EXTERNAL` intervals (`sim/external.ts`, one per column, aux = fallback material
  only) and the older `bodyProj` texture (`shaders/project.wgsl`, `PROJ_K` 3 spans, fed by the lattice's `physCols`
  and by `src/grids/structures.ts`, an 8-row frame table). §3 says one: "There is no separate span list or span limit."

## The six stages

Rows are bodies. Buffers grow by doubling and rebinding (as `Physics.growSkin` does), never a fixed cap. Awake rows are
a compacted index list; every per-body dispatch is indirect, sized by that list ("Asleep rows cost nothing").

| stage | buffers (bytes a row) | dispatches | reused / moved | deleted when it lands | gpu test · lab station |
|---|---|---|---|---|---|
| 1 integration | `bodyPose` 32 (pos, inverse mass; quat), `bodyPrev` 32, `bodyVel` 32 (linear, rest timer; angular, bound radius), `bodyInfo` 32 (inverse inertia, material, flags asleep/kinematic/deformable/handled, priority, model row, grid id), `awake` u32 list + indirect args | `compact` (all rows, 1 read each), `integrate` (awake) | gravity and pushes `phys.wgsl:217-266`; window shift `physics.ts:563`; poses interpolated as `solver.ts` `pose` | `game/rockbodies.ts`, `bodies.ts`, `colbodies.ts` (route `old`) | `engine-rows.test.ts`: free fall matches ½gt²; asleep rows give 0 workgroups · rock station "drop" |
| 2 coarse | `bodyHash` 2^14 heads + next per row (u32); `pairs` 8 B, atomic count | `hashClear`, `hashInsert` (awake + kinematic), `pairs` (awake); sleepers sit in a second hash rebuilt only on sleep/wake | hash code `phys.wgsl:356-372`, moved from voxels to **body bounds** | the per-voxel hash for anything rigid | `engine-pairs.test.ts`: brute-force pair set equals the hash's · build station pile |
| 3 fine | `contacts` 48 (a, b or terrain/grid owner, point, normal, depth, closing speed, energy, materials), atomic count; model store (below) | `fineTerrain` (a thread a surface sample of an awake body), `finePairs` | `groundAt` and the wall test `phys.wgsl:375-463` | `solver.wgsl` `probe` (`:162`), node contact points | `engine-contacts.test.ts` against a CPU reference · rock station "topple" |
| 4 deform | today's particle buffers (`px pv pr pq pg pb pc`), in pages of 512 voxels with a GPU free stack (**proposal**); voxel hash sized to the budget | `select` (budget), `expand` (row → particles), the lattice substeps, `settle` (particles → rows) | `region gather collide finalize relax split deaths fold` (`phys.wgsl:269-890`), `stats` (`:1025`), `PHYS_MATS` | CPU sleep and `bstat`/`touches` reads; `PV_CAP`, 255-body id; `Physics.spawn` as a public entry | `engine-roundtrip.test.ts` · metal station "drop the line-up", tanker |
| 5 solver | `bodyDelta` 32 (accumulated position and rotation correction, contact count; fixed-point atomics) | `solveContacts`, `applyDelta` × iterations | rules and sliders from `solver.wgsl:298-329` (`contactMass`, `slopFor`), `TUNE.rigid` (`tune/params.ts:35-40`) | `src/solver/*`, `solver.wgsl`, `solver/variant.ts` | `engine-rules.test.ts`: one test a rule (below) · slide and house stations |
| 6 events | `physEvents` ring, 32 B (bodies, point, normal, energy, materials), count | written by 3 and 5; read by particles, `physPuff` (`phys.wgsl:142-153`), the wake stamp, the dent stamp | dust and puff code in `finalize`/`deaths` | `touches` and its read; `Physics.state()` per tick | `engine-events.test.ts`; transfer gate shows no frame read · dust station |

CPU read: the event count and up to 64 events, async, only while a listener (sound, damage) is registered. Uploads:
new rows and impulses, bytes shown in the call.

**The rules as tests (stage 5).** Separation adds no speed: an overlapped pair at rest ends with kinetic energy ≤ start.
Mass-scaled slop: overlap ≤ `slopFor(cells)` is never corrected. Erode, don't push: past slop + `erodeDepth` the softer
(or smaller) loses material; mass removed equals mass deposited. Sleepers stay: a sleeper under a sub-threshold hit
keeps its pose bit for bit. Deflect and topple: normal speed after contact ≤ restitution × speed in, never above.

## Collision coverage

The owner's question: "Ground collision works but what about rigidbody–rigidbody collision or other grids … does that
use the projections?" Short answer: only static grids are met through the projection. Bodies meet bodies in their own
frames, because §3 says "A body is projected into the terrain only while it intersects the terrain, and most never do."

| pair | the design says | test reads | resolution | status |
|---|---|---|---|---|
| body ↔ terrain | "Bodies are tested against the **columns** directly, so terrain needs no collision mesh." | the column intervals, native | 1-cell hex footprint, f32 heights | design; lattice does it per voxel today |
| body ↔ body, awake | "a GPU spatial grid or hash of body bounds gives candidate pairs" | each other's model, own frames | the model's voxel (1, ½, ¼ cell) | design names coarse; fine mechanism below |
| body ↔ sleeper | "At rest a body stays an object. It claims its space as External intervals"; "sleepers stay put unless an impulse wakes them or their support goes" | **proposal:** the sleeper's own model, via the sleeper hash; the terrain test skips External whose owner is a body row | the model's voxel | design is silent on which; see options |
| body ↔ building (tile grid, turned about z) | "the others see the owner's matter only as a read-only projection"; "External intervals are support that never gives by itself. When a piece containing them goes, their owner is told." | the External projection in the columns | column footprint, f32 heights, plus the face normal | design; needs owner + normal in the interval |
| body ↔ buried hall interior | "the hall's whole extent is External intervals owned by that grid. Inside, the tile system runs **its own material tick**" (deferred) | outside: the projection. Inside: the hall's own cells in its frame (**proposal**, later) | tile cell | not built; the row's `grid id` is reserved for it |
| kinematic rows | "Heroes, agents and vehicles are kinematic rows"; "pushed, knocked down or buried through reaction profiles" | a capsule in the body hash; infinite mass in the solve | capsule | not built (DA-E6) |

- **Sleeper options.** (a) Own model through the sleeper hash: true shape, one extra bucket read per awake body.
  (b) The External projection: free, but one flat-topped span a column, so a rock landing on a tilted boulder meets
  stairs. I recommend (a). External then does what §3 gives as its purpose: "have the material around it render and
  interact properly".
- **Face normals.** External is to name "the owner grid, with face normals". Today it carries neither. **Proposal:**
  the slot's spare word (`common.wgsl:481`) holds owner (16 bits) and an oct-encoded normal (16 bits). A body then
  slides along a wall turned 30° instead of catching on column steps, and sand slides off by the same normal.
- **Past the threshold.** The contact's event carries the owner. Energy over the material's threshold goes to the §9
  trigger: the owner is told, the struck region's External goes to air, and it "becomes voxel bodies that deform and
  fracture within the engine's budget". Over budget, "the column result stands alone."
- **Missing today:** the GPU grid table of §3 (only the 8-row frame table and citygen's lot records); owner and normal
  in the interval; several External intervals a column (INT8, `external.ts:67`); `bodyProj` still beside External.

## Fine collision, body ↔ body

**Chosen: a signed distance field per model, built on the GPU with a jump flood.** The owner, 2026-11-15: "SDF with
JFA on GPU sounds like a winner for the fine collision". The earlier steer still holds for the coarse pass: "Just make
bounding boxes or build trees and do tree tree collisions for intersecting RBs unless you think there is a faster GPU
option? I do like spatial hashes but not for fully voxelated things". So: bounds in a hash give the pairs; the fine
pass never hashes voxels.

**Built on `physics10-fine`, not wired into the game.** (What follows is round 1; round 2 below changed the pass
and the rows.) `src/engine/sdf/` (`contract.ts` the layouts, `models.ts` the
store and bake, `fine.ts` the pass), `src/shaders/engine/sdf-*.wgsl`, tests `test/gpu/sdf-bake.test.ts` and
`sdf-fine.test.ts`, the desktop bench `sdf-fine-bench.test.ts`, the phone bench `sdfbench.html`.

- **Model store.** One row a model (32 B: field offset, padded sides, sample offset and count, centre of mass, cells a
  voxel). Each model is padded by one empty voxel a side. Occupancy bits go in; the bake writes the field and the
  list of surface voxels. Instances share a row until a body deforms.
- **Bake.** Seed, then a jump flood of ceil(log2(side)) + 1 passes, then finalize and commit: 9 dispatches for a batch
  of 16³ models (a batch floods up to 2^18 padded voxels; more models run as more batches in the one submit). The
  flood keeps the nearest matter voxel and the nearest empty voxel for every voxel; distance is to that voxel's box,
  so the zero lies on the voxel faces. A model baked again after its voxels change takes the same path: `update`
  (voxels changed on the CPU) or `rebakeFromGpu` (bits written by a GPU pass, no upload).
- **Fine pass.** `expand` (a thread a half pair: bound spheres, the transform composed once, chunks of 64 samples
  appended), `args` (the dispatch size, on the GPU), `fine` (a thread a sample: into the other body's frame, bounds,
  8 field reads, a contact appended). Nothing is read back.
- **Contact row, 48 B** (`contract.ts`): `u32 a, u32 b, f32 energy, u32 mats (a | b << 16), vec3f point, f32 depth,
  vec3f normal (from b to a), f32 closing`. Counts in a 16 B buffer: contacts asked, contacts dropped, chunks, chunks
  dropped. A reader takes min(asked, room).
- **Inputs it expects** (stage 1 and 2's rows): `bodyPose` (pos, inverse mass; quat), `bodyVel` (linear, rest timer;
  angular in the world frame, bound radius), `bodyInfo` (inverse inertia diagonal, material; flags, priority, model
  row, grid id), `pairs` (a, b) with the count in word 0 of its own buffer.

**Choices where the design was silent** (mine, each a proposal the owner can turn):

1. **Both bodies give samples.** A corner of one body in a flat face of the other is seen only by the corner's own
   sample: in the corner test, the face's samples alone report no overlap for a corner 0.5 deep. Cost: twice the
   threads.
2. **Sample cap 2,048 a half pair.** A bigger model's samples are taken evenly, the offset turning each tick, so every
   sample is tested once in ceil(count / cap) ticks. A 16³ box has 1,352 samples (none skipped); a 32³ box 5,768
   (each tested every third tick).
3. **Margin 0.25 cells.** Gaps up to the margin give contacts with a negative depth.
4. **Field format, by measurement.** Three were built: `f32` (4 B a voxel), `snorm8` (1 B, sixteenths of a voxel),
   `grad8` (4 B: the snorm8 distance and a unit gradient kept at the bake, both interpolated). **`grad8` is my pick**:
   the same speed as `f32` on the desktop, a normal that is continuous from cell to cell, and on a 12-voxel ball its
   normals are within 8° of the true ball's on average (17° at worst) against 18° (38°) for the other two. `snorm8`
   is the one to take if memory matters more: 12 KB for a 16³ model against 29.5 KB. The phone bench runs all three.
5. **A surface sample is a point, not a ball.** It sits on the voxel's open face, edge or corner, so box corners are
   exact. A voxel with no single open side on any axis (the inside of a one-voxel plate) is a ball of half a voxel.

**Tested** (33 fine tests and 15 bake tests pass on Dawn, all three formats). The flood matches the brute-force
distance at every voxel for boxes, a ball, an L, a notched block, a one-voxel plate and rod, a hollow shell, a diagonal
stair, a comb and a girder. Its only misses: 64 voxels of a 32-voxel ball, 8.4 voxels or more inside, at most 0.175
voxels off. The GPU's contacts equal a CPU mirror's (0.005 cells, 1°). Against the exact voxel geometry: on smooth
ground (no edge within 1 voxel, 2 for `grad8`) depth and normal are exact; near an edge the depth is within 0.37
voxels and the normal leans towards the next face.

**Measured, desktop proxy** (Intel Xe integrated, Dawn D3D12 in Node, timestamp queries round the pass, median of 16;
the adapter's clock ticks in 0.066 ms steps). `touch`: each pair overlapping by 0.75 voxels. `deep`: a third of each
body inside the other.

| scene | model | pairs | f32 ms | snorm8 ms | grad8 ms | threads | contacts |
|---|---|---|---|---|---|---|---|
| touch | 8³ | 256 | 0.39 | 0.20 | 0.20 | 141 k | 654 |
| touch | 16³ | 64 | 0.20 | 0.20 | 0.20 | 140 k | 66 |
| touch | 16³ | **256** | **0.66** | **0.59** | **0.66** | 553 k | 414 |
| touch | 16³ | 1,024 | 2.2 | 2.3 | 2.4 | 2.2 M | 1,501 |
| touch | 16³ | 4,096 | 9.0 | 9.6 | 10.6 | 8.9 M | 6,018 |
| touch | 32³ | 256 | 2.1 | 1.4 | 2.2 | 1.0 M | 390 |
| touch | 32³ | 4,096 | 16.8 | 18.4 | 18.6 | 16.8 M | 5,188 |
| deep | 16³ | 256 | 0.66 | 0.66 | 0.72 | 553 k | 102 k |
| deep | 32³ | 256 | 1.2 | 1.2 | 1.1 | 1.0 M | 194 k |

Every row is in `data/perf/sdf/fine-bench.json`. Bake, wall time: one 16³ model about 1 ms (mostly the submit), 64 of
them 9 ms; 64 of 32³ 60 to 72 ms. Bytes a 16³ box: 29,504 (`f32`, `grad8`) or 12,008 (`snorm8`); a 32³ box 185 KB or
67 KB. The pass's own buffers at 256 pairs: 115 KB of work, plus 48 B a contact row.

**Round 1's finding (answered in round 2 below).** 256 pairs of 16³ cost 0.6 to 0.7 ms here by timestamps, and 0.8 to
1.3 ms in headless Chrome by the bench page's toggle: at the 1 ms line set for this pass. The cost follows the
threads (about 1.1 ns each) and hardly the contacts: a touching pair spends over 99% of its threads on samples
nowhere near the other body. The fix is to cull before threads are made: samples sorted into bricks at the bake, and
`expand` making chunks only for bricks inside the other body's bounds (PF2). I estimate a tenth of the threads for
touching pairs; not measured.

**For the phone:** `sdfbench.html` (dev server: `http://<this PC>:5173/sdfbench.html`), about 5 minutes for every
format, size and pair count; `?formats=grad8&sides=16&pairs=256,1024` for a short run. It toggles the pass on and off
in windows and offers the report to download. The numbers to read are each row's `toggleDoneMs` and `toggleFrameMs`.

### Round 2: cost, contact count, normals, the join (2026-11-15)

Main's rulings: `grad8` is the packing; both bodies give samples; the margin and the cap are tuning parameters
(`SdfFine.margin`, `SdfFine.cap`, settable between passes), not constants.

**Threads follow the overlap (PF2).** The bake now sorts a model's samples into bricks of 4 × 4 × 4 voxels, in a fixed
order, with a table of offsets (three dispatches: count, offsets, write; no atomics). The pass is `expand` (the
transform a half pair), `cull` (a thread a half pair and a row of bricks: the bricks whose box, turned into the other
body's frame, reaches its box grown by the margin), `args`, `fine` (a workgroup 16 samples of a surviving brick) and
`reduce`. Same bench, same scenes, `grad8`, desktop proxy (Intel Xe integrated, timestamps, median of 16):

| scene | model | pairs | before ms | after ms | threads before | threads after |
|---|---|---|---|---|---|---|
| touch | 16³ | 256 | 0.66 | 0.20 | 553 k | 96 k |
| touch | 16³ | 1,024 | 2.36 | **0.46** | 2.2 M | 369 k |
| touch | 16³ | 4,096 | 10.6 | 1.97 | 8.9 M | 1.47 M |
| touch | 32³ | 256 | 2.16 | 0.33 | 1.0 M | 132 k |
| deep | 16³ | 256 | 0.72 | 0.46 | 553 k | 400 k |
| deep | 16³ | 1,024 | 2.75 | 1.70 | 2.2 M | 1.6 M |
| deep | 16³ | 4,096 | 11.9 | 6.6 | 8.9 M | 6.4 M |
| deep | 32³ | 256 | 1.11 | 2.16 | 1.0 M | 1.04 M |

The after column includes the reduction. Small pair counts are not slower: 64 touching pairs of 16³ went from 0.20 to
0.07 ms. One row is worse: deep pairs of 32³, because the cap used to bound the threads and now only skips samples
after their thread exists (every third sample is tested a tick; all surviving samples get a thread), and every sample
contact now does ten atomic writes for the reduction. Two forms that were slower, measured on the way: a workgroup of
64 a brick (bricks hold 14 samples on average: 1.6 M threads at 16³ × 1,024, 1.97 ms), and one thread a half pair
looping over all its bricks (a thread's loop is serial: 0.72 ms for 64 pairs of 32³ against 0.13 ms with a thread a
row of bricks). Every row: `data/perf/sdf/fine-bench.json`; round 1's: `fine-bench-r1.json`.

**Four contact rows a pair at most (PF4).** `fine` no longer appends rows. Every sample contact goes into its pair's
record (`hits`, 128 B a pair): a count, the largest energy, its normal summed with the others that point the same way,
and a bid for each of four places: the deepest, and the farthest out along three directions 120° apart across the
line of centres. `reduce` (a thread a pair) computes the winners again and writes them at fixed places, rows
`pair * 4` on. Why four: three spread points carry a resting or toppling body's torque, the deepest is the corner or
edge that hit. In the bench: 0.74 rows a pair for touching 16³ pairs (many touch at one or two samples, or only
within the margin), 4 for deep ones (408,516 sample contacts became 4,096 rows at 1,024 pairs). The pair's record
keeps the full sample count and the largest energy for the event stage and the lattice hand-over. Nothing is dropped
unsaid: rows have fixed room; pairs past the pass's room and sample groups past the list's room are counted in
`counts`.

**Normals near edges (PF3).** A row's normal is the mean of the pair's sample normals that point the same way (the
same dominant axis in the pair's own axes). Against each scene's true normal, `grad8`:

| scene | every sample, mean / worst | the rows, mean / worst | rows, normal read at the surface point |
|---|---|---|---|
| ball on ball | 22° / 43° | 1.6° / 1.6° | 1.6° / 1.6° |
| box, face on face over a corner | 16° / 54° | 9.5° / 9.5° | 9.4° / 9.4° |
| box, an edge in a face | 11° / 46° | 19° / 46° | 19° / 46° |
| box, a corner in a face | 8° / 16° | 8° / 8° | 7.6° / 7.6° |

The mean fixes the ball and takes the face's worst from 54° to 9.5°. It does not fix: the 9.5° bias where one box
sits over another's corner (the rims on two sides lean the same way); the edge scene's third row, which is a sample of
the lower box inside the upper box's 45° flank and keeps that flank's normal; the corner scene's second sample.
Reading the gradient again at the contact's point on the surface changed nothing (the field is as rounded there), so
that variant is measured and left off. Still poor near edges; not chased further.

**Deterministic (PF6).** The sample order is fixed by the bake (brick by brick, voxel by voxel), bids tie-break on
the sample's index, and rows have fixed places: the same scene gives the same rows bit for bit, across passes and
across freshly baked stores (tested). `rebakeFromGpu` takes room for every voxel of the model by default (a bound
that always holds, 4 B a voxel), or the caller's tighter bound; samples past a bound that is too small are counted.

**The join with `physics10`** (read at c6f1bab7: `src/shaders/engine.wgsl`, `engine_step.wgsl`, `src/engine/engine.ts`;
nothing merged). Its rows: `pose` 4 vec4 a row (last tick's centre and rotation, then centre + inverse mass, rotation),
`vel` 2 vec4, `info` 3 vec4 (inverse inertia diagonal + flags; off-diagonal + mass; first sample, samples, material,
cells), a sample list a body (`samples`: body-frame point + radius), two contact slots a sample, and a solve that is
one thread a row over its own samples. What must change, and where:

1. **Fine pass (mine): read its `pose` at 4 a row** (centre and inverse mass at `4r + 2`, rotation at `4r + 3`), and
   treat an inverse mass below zero (a freed row) as zero. A few lines in `sdf-fine.wgsl`.
2. **Fine pass (mine): read its `info` at 3 a row**: the inverse inertia diagonal from `3r`, the off-diagonal from
   `3r + 1` (my effective mass uses the diagonal only today), the material from `3r + 2`. `vel` already matches word
   for word.
3. **Engine (theirs): a model row a body.** `info[3r + 2]` is full. Short term: a fourth vec4 a row holding the model
   row. Better, later: the store's sample list replaces its `samples` buffer (its terrain pass reads the model's
   samples by the sample rule in `contract.ts`), so one list serves terrain and bodies, instances share it, and
   erosion becomes a copy of the model and `rebakeFromGpu`.
4. **Engine (theirs): spawn bakes through the store** in the body's spawn frame, with the store's centre of mass the
   row's centre (the store computes the same centroid from the voxels).
5. **Engine (theirs): the coarse stage** (stage 2), writing `pairs` (a, b) and the count in word 0 of a buffer, with
   no freed row in a pair.
6. **Engine (theirs): the solve meets pair rows.** Its solve walks a row's own samples; pair contacts are 4 rows at
   `pair * 4` with the pair's record saying how many. Either the coarse stage also writes each row's pair indices, or
   the solve gains a pass over pairs that accumulates into `bodyDelta` (the note's stage 5).
7. **Engine (theirs): events** from the pair's record (largest energy, the deepest row's point) into its event buffer.
8. **Both: tuning.** `margin` should be its `EU.f.x` ("how near a gap is still a contact"); `cap` a new entry in
   `tune/params.ts`.

Items 1, 2 and 8 are small and mine to do at the merge; 3 to 7 are engine work that the note's stages 2 and 5
already call for.

### Round 3: the coarse pass (stage 2), built alone; exact, and over its budget (2026-11-15)

(Answered by round 4 below: the pass was rebuilt and the fine pass's dispatches are sized by the pair count.)

**Stopped for main's attention: the coarse pass gives the exact pair set, but costs 0.7 ms at 4,096 rows with 10%
awake in a loose field and 4.2 ms in a pile, against the 0.3 ms line.**

**What is built** (`src/engine/sdf/coarse.ts`, `sdf-coarse.wgsl`; the owner: "Just make bounding boxes … I do like
spatial hashes but not for fully voxelated things"). A hash over body bounds, never voxels. Each body is in exactly one
cell: the cell of its centre at the level whose cells hold its bound diameter (five levels, each half the one above;
the top holds the biggest body). So a big body's bucket never fills with the small ones round it, and a query is at
most 27 cells a level. The awake hash is rebuilt every tick by the awake rows. The sleeper hash is rebuilt only in a
tick whose sleep epoch differs (its dispatches have zero workgroups otherwise): a sleeper at its own level, and once
more at every coarser level under a second key, so an awake body finds the sleepers smaller than itself in its own
level's cells. The pairs pass is a thread an awake row and a level. A pair is written once with no sort: an awake pair
by the row at the finer level (same level: the lower row), an awake row and a sleeper by the awake row, and an entry
counts only when the body's own cell is the cell asked for. A candidate is a pair only if the bound spheres and then
the models' oriented boxes (15 axes) overlap. Pairs go to one buffer with a 256 B header (the count) in the layout the
fine pass reads; it has room for 8 pairs a row and is made again bigger with the rows, as the engine's row buffers
are; pairs past the room are counted and the fine pass reports them.

The fine pass now reads the engine's rows as `physics10` has them (pose at 4 vec4 a row, info at 3 with the inertia's
off-diagonal, an inverse mass below zero as immovable) plus one buffer the engine lacks: a model row a body.

**Tested** (7 coarse tests on Dawn): random scenes of mixed sizes (a 2³ crumb to a 32 × 32 × 8 slab; piles and loose
fields; all awake and part asleep) give exactly the brute-force pair set, each pair once; the same set with 1, 2 or 5
levels; all asleep: no pair and no workgroup but the gate's; a sleeper found by an awake body bigger or smaller, and
the sleeper hash following the epoch; 10,000 rows with 200 awake; pairs past the room and bodies too big for the top
level counted; the pairs fed to the fine pass.

**Measured** (desktop proxy, Intel Xe integrated, timestamps, median of 12; mixed sizes; fine pass sized by the pair
buffer's room, see below):

| scene | rows | awake | coarse ms | pairs |
|---|---|---|---|---|
| loose | 1,024 | 103 | 0.66 | 28 |
| loose | 1,024 | 1,024 | 0.33 | 133 |
| loose | 4,096 | 446 | **0.72** | 131 |
| loose | 4,096 | 4,096 | 0.46 | 609 |
| loose | 16,384 | 1,740 | 1.25 | 476 |
| loose | 16,384 | 16,384 | 1.18 | 2,409 |
| pile | 1,024 | 103 | 2.8 | 229 |
| pile | 4,096 | 446 | **4.2** | 1,016 |
| pile | 4,096 | 4,096 | 1.6 | 5,701 |
| pile | 16,384 | 1,740 | 5.8 | 4,549 |
| pile | 16,384 | 16,384 | 3.7 | 23,152 |

One level against several (pile, 4,096 rows, all awake): 1 level 3.8 ms, 2 levels 1.6, 3 levels 1.4, 5 levels 1.6 to
1.8. So levels are needed (a crumb beside a slab), and three would do for this mix.

**Why it is slow, as far as I got.** Fewer awake rows cost more, not less: the time is the longest single thread, not
the sum. A big awake body walks the list of every smaller sleeper in its level's cells (46 cells wide at the top): a
few hundred steps in one thread, and a thread's loop is serial (the same effect as the fine pass's brick loop, where
729 steps cost 0.6 ms). Two things already done: the pairs kernel reads the table as plain words (an atomic load is an
interlocked operation on D3D), and it visits only the cells a body of that level could reach from (8 of the 27, as a
rule). What I would try next, none measured: sleepers kept in contiguous runs a cell (a counting sort when the epoch
changes) so the pairs pass can be a thread a (row, run of 16) like the fine pass; or bigger sleepers' side doing the
work for big awake bodies (a thread a sleeper near one). Both are design changes for main and the owner.

**Found on the way, fixed.** The fine kernel read its group count with an atomic load in every thread. Read from the
indirect arguments instead: touching 16³ × 1,024 went 0.46 → 0.20 ms, × 4,096 1.97 → 0.59 ms; deep 16³ × 256 0.46 →
0.26, × 1,024 1.70 → 0.79, × 4,096 6.6 → 2.9; deep 32³ × 256 2.16 → 0.92 ms (PF14: now under round 1's 1.11). The cap
is applied before a thread exists (only the tick's samples get threads). Reading a bid before writing it was twice as
slow and is not done. The `normalAtSurface` variant is deleted.

**Found on the way, not fixed.** The fine pass's expand, cull and reduce dispatches cover the pair buffer's room, not
the pair count: with room for 65,536 pairs and 131 pairs, the fine pass costs 2.2 ms (PF19). They need indirect
arguments from the count. The end-to-end numbers above are therefore not worth quoting, and the end-to-end scenes
are not in `sdfbench.html` yet (PF20).

### Round 4: the coarse pass's cost follows the candidates (2026-11-15)

The owner on the structure, 2026-11-15: "Yeah you could also do a few levels of spatial hash if sizes vary too much.
Binned into powers of two BB sizes. SAP is also a reasonable alternative to try for moving bodies." And then: "Yeah I
don't know that SAP is actually any better and I don't know if it makes sense to try a hybrid and hash the tall piles
along the remaining dimensions. If the hash is fast enough I like the simplicity of it". So: the multi-level hash over
body bounds stays; sweep and prune was not built.

Main's rulings: an inverse mass below zero is a freed row (in no table, never paired; the alive flag decides), zero is
immovable; three levels unless the numbers say otherwise; the engine will supply a model row a body and a sleep epoch.

**The cause, measured** (round 3's linked-list pass, pile, 4,096 rows, 446 awake, five levels): 3.80 ms. With the
sleepers out of the hash: 0.20 ms. With nothing awake: under one clock tick. The longest walk by one thread: 1,263
entries, 1,254 of them sleepers; 84,560 entries walked by 2,230 threads in all. So it was the long sleeper chains of
the big awake bodies, a thread's loop being serial, as read.

**The cure.** Each table is now a counting sort by bucket (count, sums a block of 32 and of 1,024, starts, fill), so a
bucket's members are one run. Stage A (a thread an awake row and a level) cuts the runs of the cells a partner could be
in into work items of up to 16 entries; stage B (dispatched indirectly over the items, a thread an entry) checks the
entry is of that cell and level, then the spheres, then the oriented boxes, and writes the pair. No thread walks a
list. The rule that writes each pair once with no sort: two awake rows by the one at the finer level (same level: the
lower row); an awake row and a sleeper by the awake row; a pair with an oversize body by the other row, and two
oversize awake rows by the higher. **Oversize bodies** (bigger than the top level's cell) are in a short list of their
own, tested against every awake row, and an oversize awake row covers the sleeper cells it reaches: tested exact with
a top cell of 20 cells under 16³ boxes and 32-cell slabs.

**Every dispatch sized by what exists.** The awake table's by the awake rows, the sleeper table's only when the epoch
changed, stage A by the awake rows, stage B by the items. The fine pass's expand, cull and reduce by the pair count
(PF19), and a pair's record is cleared by its own expand thread, not by a clear of the room. What is left that is
sized by room: a GPU clear of the awake table's counts each tick (8 B a bucket: 64 KB at 4,096 rows).

**Measured** (desktop proxy, Intel Xe integrated, timestamps, median of 12, three levels; before = round 3's
linked-list pass with five levels). Coarse alone, then coarse + fine + reduction:

| scene | rows | awake | coarse ms, before → after | whole path ms, before → after | pairs |
|---|---|---|---|---|---|
| loose | 1,024 | 103 | 0.66 → 0.33 | 1.05 → 0.39 | 28 |
| loose | 1,024 | 1,024 | 0.33 → 0.33 | 0.79 → 0.46 | 133 |
| loose | 4,096 | 446 | 0.72 → **0.39** | 3.08 → 0.46 | 131 |
| loose | 4,096 | 4,096 | 0.46 → 1.18 | 2.95 → 1.57 | 609 |
| loose | 16,384 | 1,740 | 1.25 → 2.16 | 10.7 → 2.36 | 476 |
| loose | 16,384 | 16,384 | 1.18 → 2.95 | 10.7 → 3.47 | 2,409 |
| pile | 1,024 | 103 | 2.8 → 0.33 | 3.28 → 0.39 | 229 |
| pile | 1,024 | 1,024 | 0.92 → 0.33 | 1.51 → 0.59 | 1,178 |
| pile | 4,096 | 446 | 4.2 → **0.46** | 6.75 → 0.66 | 1,016 |
| pile | 4,096 | 4,096 | 1.6 → 0.66 | 5.05 → 1.77 | 5,701 |
| pile | 16,384 | 1,740 | 5.8 → 2.3 | 16.0 → 3.15 | 4,549 |
| pile | 16,384 | 16,384 | 3.7 → 3.7 | 16.1 → 8.5 | 23,152 |
| pile | 4,096 | **0** | 0.07 (one clock tick) | 0.07 | 0 |

Against the targets at 4,096 rows with 10% awake: loose 0.39 ms (target about 0.3), pile 0.46 ms (under 1), nothing
awake one clock tick. Levels on the 4,096-row pile (10% awake / all awake): one 0.46 / 0.85, two 0.39 / 0.66, three
0.39 / 0.72, five 0.46 / 0.85 ms: two or three; three kept.

**What got worse, and why.** A loose field with every row awake, and 16,384 rows: the pass now has a floor of about
0.33 ms, and a cost that grows with the buckets (two a row), not with the work. The table build's sums run over every
bucket whenever a row is awake, and they read the counts with atomic loads (an interlocked operation each on D3D):
32,768 buckets at 16,384 rows. The fix, not done: keep the counts and cursors (atomics) in one buffer and the starts
and runs in another, so the sums read plain words (PF22).

**A pair's place in the contact rows (not built; left for the join).** Pairs are appended in thread order, so a
pair's rows move from tick to tick. For warm starting the solver needs a stable place. What I would build: a
persistent table keyed by (a, b), open addressing, one probe a pair in a small pass after stage B; a pair found keeps
its slot, a new pair takes a free one, and slots not touched this tick are freed by a sweep sized by the table. The
fine pass then writes a pair's rows at `slot * 4` and the solver reads its kept impulses there, with the key stored
beside them. It is a new buffer, two kernels and a rule for freed slots: large enough that I left it, and say so.

**Join list, added:** the engine supplies `model` (a u32 a row: the model row) and a sleep epoch word that changes on
every sleep, wake, spawn or free of a sleeper and every move of one.

### Round 5: the coarse pass's floor removed (2026-11-15); two of three items not built

**Not built this round, and why it matters:** growing rooms with a fail-safe tick (item 2) and stable pair slots
(item 3). Both are specified in the hand-over below. Until item 2 lands, three rooms can still miss a collision when
they run out (each is counted): oversize lists (256 + 256), work items (64 a row), pairs (8 a row).

**PF22, isolated then fixed.** The coarse pass by part, cumulative ms (`SDF_PROBE=1 npx vitest run --project gpu
sdf-probe`, desktop proxy, timestamps, median of 12), before the fix:

| scene | gate + sleepers | + awake table | + stage A | + stage B |
|---|---|---|---|---|
| pile 1,024 rows, 103 awake | 0.00 | 0.26 | 0.26 | 0.33 |
| pile 4,096, 446 awake | 0.00 | 0.33 | 0.33 | 0.85 |
| loose 4,096, all awake | 0.07 | 0.66 | 0.72 | 0.66 |
| loose 16,384, 1,740 awake | 0.07 | 2.23 | 2.56 | 2.69 |
| pile 16,384, all awake | 0.00 | 2.43 | 2.69 | 4.46 |

So the floor and the growth with rows were the awake table's build: its sums ran over every bucket reading the counts
with atomic loads. Fix: a table is two buffers, the counters (atomics, written only by count and fill) and the table
proper (plain words). After: the awake table costs 0.07 to 0.13 ms in every scene above. Work items went from 16
entries to 8 (16 was slower with everything awake, 4 slower for an awake body in a pile of sleepers: 0.66 ms against
0.20).

Coarse alone, round 3 → round 4 → now, and the whole path now (ms):

| scene | rows | awake | coarse | whole path |
|---|---|---|---|---|
| loose | 1,024 | 103 | 0.66 → 0.33 → 0.26 | 0.39 |
| loose | 1,024 | 1,024 | 0.33 → 0.33 → 0.13 | 0.26 |
| loose | 4,096 | 446 | 0.72 → 0.39 → **0.20** | 0.33 |
| loose | 4,096 | 4,096 | 0.46 → 1.18 → 0.46 to 0.66 | 1.18 |
| loose | 16,384 | 1,740 | 1.25 → 2.16 → 0.39 | 0.72 |
| loose | 16,384 | 16,384 | 1.18 → 2.95 → 0.92 | 1.57 |
| pile | 1,024 | 103 | 2.8 → 0.33 → 0.20 | 0.33 |
| pile | 4,096 | 446 | 4.2 → 0.46 → **0.26** | 0.66 |
| pile | 4,096 | 4,096 | 1.6 → 0.66 → 0.46 | 2.16 |
| pile | 16,384 | 1,740 | 5.8 → 2.3 → 0.46 | 1.97 |
| pile | 16,384 | 16,384 | 3.7 → 3.7 → 1.84 | 8.7 |
| pile | 4,096 | 0 | 0.07 (one clock tick) | 0.07 |

The loose field with every row awake measured 0.46 ms in the probe and 0.66 ms in the bench run (the clock ticks in
0.066 ms steps and runs differ by one or two): at round 3's 0.46, not below it. What is left in that scene is stage B:
every awake row offers the entries of some 8 to 27 cells a level.

The whole path's largest row (pile, 16,384 all awake, 23,152 pairs: 8.7 ms) is the fine pass, 6.9 ms of it: its cull
dispatch gives every half pair the rows of the store's biggest model (81 rows of bricks for the slab) although a crumb
has one brick (PF23).

### Round 6: rooms that grow, a tick that fails safe (2026-11-15)

The owner's rule: no fixed cap that can drop a collision; paging before caps. Every room of the two passes, and what
happens when it runs out:

| room | when it runs out | grows |
|---|---|---|
| oversize bodies (was 256 awake + 256 asleep) | it cannot: they are a run of the table's counting sort, one entry a row | with the rows |
| the tables' runs | they cannot: an awake row has one entry, a sleeper one a level at most | with the rows |
| the engine's rows (`rows`) | `SdfCollide.encode` sees it on the CPU: the tables double before the tick's passes | at once, in that tick |
| work items (64 a row) | stage A flags its row and every entry of the run it could not cut into items (`MISS_ITEMS`) | by the read |
| pairs (8 a row) | stage B flags both rows of the pair it could not write (`MISS_PAIRS`) | by the read |
| cull items (8 a half pair) | `expand` flags both rows of the pair whose rows of bricks found no room (`MISS_CULL`) | by the read |
| sample groups (64 a half pair) | `cull` flags both rows of the pair whose group found no room (`MISS_GROUPS`) | by the read |
| a pair's contact rows | four a pair by design (the reduction); not a room | |
| pair slots (a table twice the pairs) | `slots` flags both rows of the pair that found no free entry (`MISS_SLOTS`) | by the read |
| the model store | sized on the CPU before each bake; doubles there (one GPU to GPU copy) | at the bake |

**Safe.** `missing` is a u32 a body row on the GPU (`SdfCollide.missing`; bits in `contract.ts` `MISS_*`), cleared by
the coarse pass each tick. A nonzero word means the row may lack a pair or a contact this tick. The solver's part,
not built here: hold a flagged row at its last pose for the tick. Every row of a pair that was not written, or was
written with contacts left out, is flagged; for work items some rows are flagged that had nothing to miss (the entries
were never tested).

**Growth.** Each room counts what was asked of it whole, past its end too, and keeps the most asked in a tick. `poll`
(after the engine's submit) copies those words, 128 B, and maps them: every 8 ticks, one read under way at most, and
no tick waits for it. A room at half or more (`rooms.ts`) is doubled until the asking is under half, by the next
`encode`: the buffers are made again and the bind groups with them. No pipeline is made (tested by counting
`createComputePipeline` calls): the kernels' layouts never depended on the sizes, the rooms are in the uniforms.
Nothing is copied, because the pass rebuilds every one of these buffers each tick.

**Departures from the hand-over as written.** (1) An oversize body that does not fit its list was to fall back to
every awake row; instead the list is gone (the same exactness, one mechanism fewer). (2) "Tested first next tick" is
not built: the room has grown by then and the row is tested like any other. (3) The two tables are one buffer, so
stage B has a binding free for `missing` (eight storage buffers a stage). (4) The read will be a timed read in play,
which DESIGN §24 does not allow: BACKLOG PF26, the owner's call.

**Tested** (`test/gpu/sdf-rooms.test.ts`, 6, and 2 more with the cull below; `test/unit/sdf-rooms.test.ts`, 3). A pile of 1,500 rows with every room
an eighth of what the scene asks: each tick, every pair brute force has and the pass lacks has both rows flagged, and
so has every pair whose record differs from a roomy pass's; then the pair set is brute force's, every record the
roomy pass's and no row flagged, and further ticks grow nothing. Each room alone. 400 oversize rows, awake and
asleep. Rows grown from 300 to 700 mid-run.

**Measured** (desktop proxy, Dawn in Node, pile of 4,096 rows all awake; `data/perf/sdf/rooms-bench.json`). The read:
0.19 ms of CPU in the tick that starts one (0.015 ms a tick averaged over 8), the tick's wall time 2.02 ms with no
read and 2.04 ms with one every 8 ticks (inside the noise); its answer lands 2 ms later. A growth (all five
rooms from an eighth, with the slots and the cull items of the later commits in): 0.14 to 0.85 ms making buffers, and
the tick that does it encodes in 1.2 to 1.8 ms against 0.57 (the bind groups). The wall time of the three growth
ticks: 2.9, 3.6 and 8.4 ms against 2.9. **The last is a stall of about 5 ms in one tick**: it made the two biggest
buffers at once (the sample groups 39,522 → 632,352 and the slots 4,096 → 16,384, some 10 MB that the driver clears
at first use) and moved the slots. Under a frame, and once; a room that doubles instead of jumping sixteenfold costs
less (the jump is what starting at an eighth does). From an eighth, the rooms took three growth ticks in a row (a
room that ran out hides what the next would be asked).

**Stable pair slots (PF25).** The solver will keep impulses a pair from tick to tick, so a pair's contact rows must
stay in one place while the pair lasts. They now do: rows at `slot * 4`, the slot in the pair's record (word 7).

- *The table.* Open addressing over a power of two of entries, keyed by the pair's rows (lower, higher: which body
  the coarse pass names first can change when one falls asleep). An entry is a stamp (the epoch of the last pass that
  touched it) and a key record of 16 B beside the rows: lower row, higher row, age in passes, the pair's index in this
  pass's list.
- *Probing.* Double hashing: entry `(h + i * step) & (entries - 1)`, `step` odd, `i` under 32. One walk a pair a pass,
  by the pair's own thread in a small kernel (`slots`) before `expand`. It stops at its own key in an entry stamped
  last pass (found: stamped now, age + 1) or at an entry never used (not in the table: every key took the first free
  entry of its walk). Not found: it claims the first free entry it passed by compare-exchange, writes the key with
  age 0 and zeroes the four rows. Each pair is in the list once (tested since round 3), so no two threads seek one key.
- *Release.* No sweep. The epoch goes up one a pass; an entry is live when its stamp is this pass's or the last's, and
  anything older is free. A pair absent for one pass has lost its slot.
- *Growth.* At half full (entries that may be live: last pass's pairs and this pass's new ones, the most since the
  last read), or at once when a pair finds no free entry in its 32 (that pair has no rows that pass and both its rows
  are flagged `MISS_SLOTS`). The next `encode` runs `rehash` first: a thread an old entry, every entry live at the last
  pass put in the new table with its key, age and rows, and `slotRemap[old]` its new place (`slotGeneration` goes up:
  the solver moves its own impulses by the same map).
- *Departure.* The pair's record (128 B: sample count, energy, rows written) stays by the pair's index in this
  tick's list, not by slot: it is rebuilt every tick and the dispatches walk the list. Only the rows and the key
  record are by slot.

Tested (`test/gpu/sdf-slots.test.ts`, 6): a stack of six boxes keeps each pair's slot, and bit-identical rows, for 100
passes with the list shuffled and either body named first; a pair absent for one pass comes back with age 0 and
zeroed rows while the pair beside it keeps slot and age; 720 claims of 168 pairs through a table of 64; a growth
keeps key, age and rows (checked in a pass with no pair, so the copy is the rehash's own); a table of 4 under 12
pairs: 4 whole, 8 flagged with no rows; a pile of 1,100 rows through both passes: every pair a slot of its own with
its key beside it, the table grown at half full with no pair failing and every age going on through it.

Measured (`SDF_PROBE=1 npx vitest run --project gpu sdf-probe -t "pair slots"`; desktop proxy, timestamps round
`pairArgs` + `slots` alone, median of 12): one clock tick (0.07 ms) for 4,549 and 5,701 pairs whether every pair finds
its slot or claims a new one; 0.20 to 0.26 ms for 23,152 pairs found, 0.33 ms claiming. On the bench table the whole
path moved by less than the runs differ (pile, 4,096 rows all awake: 1.57 to 1.97 ms before, 1.77 to 1.97 after).

**The cull sized by each pair's own model (PF23).** The cull dispatch gave every half pair the brick rows of the
store's biggest model (81 for the slab). Now `expand`, which already has the transform, turns the other body's box
(grown by the margin) into a box of the sampler's bricks and appends a cull item for each row of bricks along x
inside it; `cullArgs` sizes an indirect dispatch from the item count; `cull` is a thread an item and tests only the
bricks of that row between the box's ends. The brick test itself is unchanged, so the contacts are the same rows
(77,578 in the largest scene, before and after; a few groups fewer, because the box of bricks is tighter than the
old test at a body's corners). The bound-sphere test left `expand` (the coarse pass has done it; a pair that is far
apart asks for no item) to make room for the items' counter and the `missing` words in its eight bindings. The cull
items are a room like the others: counted whole, grown by the read, both rows flagged `MISS_CULL` when it runs out.

Before → after, the bench table (desktop proxy, Intel Xe, timestamps, median of 12 a run; three runs each side, the
median run given; before is the slots commit):

| scene | rows | awake | pairs | fine ms | whole path ms | cull items |
|---|---|---|---|---|---|---|
| loose | 4,096 | 446 | 131 | 0.13 → 0.13 | 0.26 → 0.26 | 1,875 |
| loose | 4,096 | 4,096 | 609 | 0.20 → 0.39 | 0.46 → 0.85 | 9,196 |
| loose | 16,384 | 1,740 | 476 | 0.33 → 0.33 | 0.72 → 0.66 | 6,794 |
| loose | 16,384 | 16,384 | 2,409 | 0.92 → 0.72 | 2.16 → 1.90 | 35,810 |
| pile | 4,096 | 446 | 1,016 | 0.26 → 0.33 | 0.46 → 0.46 | 14,502 |
| pile | 4,096 | 4,096 | 5,701 | 1.31 → 1.25 | 1.70 → 1.70 | 85,314 |
| pile | 16,384 | 1,740 | 4,549 | 1.11 → 0.85 | 1.44 → 1.18 | 64,942 |
| pile | 16,384 | 16,384 | 23,152 | **5.64 → 4.65** | **7.08 → 6.16** | 339,350 |
| pile | 4,096 | 0 | 0 | 0 | 0.07 | 0 |

The 1,024-row scenes are at the clock's floor both sides (0.26 to 0.52 ms whole). Runs differ by one or two clock
ticks (0.066 ms) in the small rows and by up to a third in the largest (after: 4.39, 4.65 and 5.77 ms), so only the
last two rows show a change I would stand behind, and the loose field with 4,096 awake is not a real loss (its
three runs after: 0.46, 0.85, 0.98; before: 0.46, 0.46, 0.52: one clock tick apart at best, unexplained at worst).

**What the cull was not.** Round 5 read the largest row as "the fine pass, 6.9 ms of 8.7, because of the cull
dispatch". By part now (`SDF_PROBE=1 … sdf-probe -t "pair slots"`, the same scene): slots 0.26 ms, expand and cull
0.8, the samples' threads 4.8, reduce under a clock tick. The cull was a fifth; the rest is 9.7 M sample threads for
23,152 pairs (420 a pair), which is the overlap itself in a pile half full of matter at random poses (BACKLOG PF29).

**The page** (`sdfbench.html` v4 in headless Chrome, `node scripts/sdfbench.mjs --url http://localhost:5352`: 24
configurations with 16,384 rows in, 3 min 37 s, no error; `data/perf/sdf/sdfbench-desktop.json`). The whole path, ms a
tick, by the toggle's GPU-done difference and by a batch alone:

| rows | awake | scene | toggle | batch | pairs |
|---|---|---|---|---|---|
| 4,096 | 446 | loose | 0.50 | 0.93 | 131 |
| 4,096 | 4,096 | loose | 0.77 | 1.38 | 609 |
| 4,096 | 446 | pile | 0.82 | 1.29 | 1,016 |
| 4,096 | 4,096 | pile | 4.46 | 3.48 | 5,701 |
| 16,384 | 1,740 | loose | 1.91 | 1.43 | 476 |
| 16,384 | 16,384 | loose | 2.65 | 3.80 | 2,409 |
| 16,384 | 1,740 | pile | 3.92 | 2.98 | 4,549 |
| 16,384 | 16,384 | pile | 36.6 | 6.78 | 23,152 |

Round 5's page runs at 4,096 rows (the only ones kept, `perf-reports/`): 0.48 to 1.47, 0.67 to 2.47, 0.96 to 1.51
and 3.48 to 3.65 ms by the toggle: the same within their own spread. The last row's toggle (36.6 ms, and 12.8 and
30.3 in two shorter runs, against a batch of 6.8 to 11.7) is not the pass's cost: the frame goes over the display's
refresh and the GPU-done time jumps by whole frames. A first full run of the page, made while this machine was busy
(its empty frames took 3.8 to 7.3 ms against 3.0 to 3.7), read two to four times higher throughout and is not kept.
The phone run is the owner's (PF20).

### Hand-over: joining body ↔ body into the engine

Everything here is on `physics10-fine` (not merged anywhere). Code: `src/engine/sdf/` (`contract.ts` layouts,
`models.ts` the model store, `coarse.ts`, `fine.ts`, `collide.ts` both passes with one set of rooms, `rooms.ts` the
growth rule, `shapes.ts` test scenes), kernels `src/shaders/engine/sdf-*.wgsl`. Each kernel file's header states its
scheme. The engine's row layout is the one in `physics10`'s `engine.wgsl` at c6f1bab7; if the breaking branch changed
it, `contract.ts` "the engine's rows" and the three `poseOf` / `velOf` / `centre` helpers in the kernels are the only
places that know it.

**What the engine must supply (it has neither today).**
1. `model`: a u32 a row, the row's model row in the store. Write it at spawn: `store.add({ size, vox, voxel })`
   returns the model row; `store.flush()` bakes (once for all pending models; it submits its own commands). Instances
   of the same voxel model share one row. The store's centre of mass is the matter's centroid in the model's voxel
   coordinates: the row's `pose` centre must be that point. A body whose voxels change needs `store.update(id, spec)`
   (CPU voxels) or `store.rebakeFromGpu(id)` (occupancy bits written by a GPU pass into `store.occ` at
   `store.info(id).occBase`), then `flush()`.
2. `sleepEpoch`: a buffer whose word 0 changes whenever a row falls asleep, wakes, is made or freed asleep, or a
   sleeper is moved. `compact` is where the engine decides sleep: bump it there. The coarse pass rebuilds its sleeper
   table only in a tick where the word differs from the one it last built for.

**Buffers bound.** Read from the engine: `list` (the awake list: indirect arguments in words 0-2, the count in word
3, rows from word 8; needs INDIRECT and STORAGE usage), `pose`, `vel`, `info`, `model`, `sleepEpoch`. The membership
rule: only rows in the awake list and rows with ROW_ALIVE and ROW_ASLEEP in `info[3r].w` are in any table; an inverse
mass below zero is a freed row and must be in neither; zero is immovable.

**A tick, in order.** One object: `const collide = new SdfCollide(device, store, { rows, cellTop, margin })`.
1. `collide.encode(enc, { list, pose, vel, info, model, sleepEpoch }, rowsInUse, tick)` in the engine's encoder,
   after integration and `compact`. Nothing is read back. It makes any room bigger that the last read asked for (and
   the rows' room at once if `rowsInUse` is past it), uploads three small uniforms, and encodes two compute passes:
   - coarse: (two GPU clears: the awake table's counters, the rows' `missing` words) gate; the sleeper table
     (clearTab, countCells, blockSum, superSum, startCells, fillCells: zero workgroups unless the epoch changed); the
     awake table (the last five); stageA; argsB; stageB.
   - fine: (rehash, only in the tick after the slots' table grew) pairArgs; slots; expand; cullArgs; cull; fineArgs;
     fine; reduce.
2. The solve, then events, in the same encoder.
3. The engine's submit, then `collide.poll()`: it destroys the buffers a growth replaced, and every `readEvery`
   ticks (8) starts the 128 B read of what was asked of the rooms. It never waits; the answer makes a room bigger at
   a later `encode`.

**What the solver reads.** A growth replaces buffers, so take them from the objects each tick (or when
`collide.growths.length` changes), never keep them.
- `collide.missing`: a u32 a body row, `contract.ts` `MISS_*` bits. Nonzero: the row may lack a pair or a contact
  this tick, because a room ran out before it grew. Hold the row at its last pose for the tick (the solver's part,
  not built). It is zero again once the room has grown, a few ticks later.
- The pair list: `collide.coarse.pairBuf`, word 0 the pairs asked for, pairs (a, b) from word 64; take min(asked,
  `collide.coarse.pairRoom`). A pair's index p in the list changes from tick to tick.
- Pair p's record: `collide.fine.hits` at `p * 128` B: word 4 the sample contacts (what the lattice hand-over wants:
  how much of the surface touched), word 5 the largest sample energy (f32 bits; also on every row), word 6 the rows
  written (0 to 4), **word 7 the pair's slot** (`NO_SLOT`, 0xffffffff: no rows this tick, and both rows flagged).
- The pair's contact rows: `collide.fine.contacts` rows `4 * slot` to `4 * slot + rows - 1`, 48 B each (`contract.ts`
  "A contact row": a, b, energy, materials, point, depth, normal from b to a, closing speed). **The slot is the
  pair's for as long as the pair is in the list every tick.** Keep impulses by slot.
- **The key beside the rows:** `collide.fine.slotKeys` at `16 * slot` B: the pair's lower row, its higher row, the
  slot's age in ticks, the pair's index p this tick. Age 0: the pair is new (or was away for a tick), the rows it did
  not write are zero, and its impulses start from nothing.
- At a growth of the slots' table every live pair moves: `collide.fine.slotGeneration` goes up, and after that
  tick's `encode` `collide.fine.slotRemap` holds, for each old slot, its new slot or `NO_SLOT`. Move the impulses by
  it before the solve (a kernel of the solver's own; the old table's size is the `from` of the growth in
  `collide.growths`).
- A row's index inside a slot follows the reduction's order and can change (PF28): match rows by point, or keep one
  impulse a pair.

**Tuning parameters.** `CollideOptions.margin` (cells; it sets both passes: to change it later set
`collide.coarse.margin` and `collide.fine.margin` alike; the engine's `EU.f.x`), `collide.fine.cap` (samples a half pair a tick, default 2,048), `cellTop` (about the biggest
common body's bound diameter), `levels` (3), `readEvery` (8). The rooms start at `pairsARow` (8), `itemRoom`,
`cullRoom`, `groupRoom`, `slotRoom` and grow; none needs setting for correctness. Field format: `grad8`.

**Open hacks and limits, by id** (docs/BACKLOG.md): PF3 normals near edges (rows take the mean; 9.5° over a corner,
46° on one row of an edge in a face); PF5 cap and margin defaults are not from the phone; PF7 the field holds ±7.9
voxels; PF8 one-voxel plates' rims; PF9 a 3D-texture field unmeasured; PF10 the store's arena has no compaction;
PF11 and PF20 the phone runs asked of the owner; PF15 at most 65,536 samples a model, four rows a pair whatever its
size; PF17 the join itself; PF21 pair order, the reach of an oversize row, a sleeper moved without an epoch bump is
not found; PF26 the rooms' read is a timed read in play (the owner's call); PF27 the rooms' hacks; PF28 the slots'
hacks; PF29 the samples' threads in a dense pile.

**Tests a joiner should run first** (Node, real GPU, about a minute):
`npx vitest run --project gpu sdf-bake sdf-fine.test sdf-coarse.test sdf-rooms sdf-slots` (15 + 36 + 8 + 8 + 6 pass
at this commit, one bench skipped), then `npm run typecheck` and `npx vitest run --project unit` (one failure on the
base: `roadlab/control.ts` in the writing lint). Read first: `test/gpu/sdf-collide-rig.ts`, the smallest example of
a tick (hand-made engine rows, `encode`, submit, `poll`, and everything the solver reads, read back); then
`sdf-rooms.test.ts` "room for an eighth" (what `missing` promises) and `sdf-slots.test.ts` "a resting stack" and "a
pair absent for one pass" (what a slot promises). `test/gpu/sdf-harness.ts` drives the fine pass alone from a
hand-made pair list. Benches: `SDF_BENCH=1 npx vitest run --project gpu sdf-coarse-bench` (coarse and the whole
path), `SDF_BENCH=1 … sdf-rooms -t "cost of the read"` (the read and a growth), `sdf-fine-bench` (the fine pass
alone), `SDF_PROBE=1 … sdf-probe` (the coarse pass, the slots and the fine pass by part); the phone page is
`sdfbench.html`.

**Considered, not chosen** (both from the same baked voxel model):

- **Tree ↔ tree** (an octree over the voxels, about 5 KB a 16³ model): one thread a pair with a stack of node pairs.
  The owner's first baseline. On a tiler the threads of a workgroup diverge and the group waits for its slowest;
  normals come from leaf faces. Not built.
- **Occupancy mip pyramid** (about 0.6 KB): one thread a surface voxel, 1 to 3 bit reads. The least memory, but its
  normals are voxel faces. Not built.

## How the lattice becomes stage 4

- **Stays:** the material table, shape matching, contacts that never push out, crumble and crack rules, `split`,
  `deaths`, `fold`, the fragment ring, mesh skinning. The voxel hash stays, only among deforming voxels.
- **In:** `select` reads contacts; a body whose energy passes its material's threshold is a candidate. Priority is the
  design's order: "what the player handles, size, on screen, energy". Each candidate counts the voxels of candidates
  ranked above it (candidates are few) and is admitted if the sum fits the budget. `expand` writes one particle a
  model voxel at the row's pose and velocity, into free pages. Not admitted: it stays rigid and the erode rule softens it.
- **Out:** `settle` uses `stats`. A body slower than `restV` for `restT` gets its bonds labelled into connected
  parts (label propagation); each part becomes a row with a model re-splatted from its particles in the fitted frame;
  parts under the `crumb` size go to loose ground through `deaths`. Pages return to the stack.
- **Budget:** one uniform, voxels deforming at once, set from the phone bench (§10: "found by the phone bench, not
  set in advance").

## Build order, riskiest first

Each step: a Node gpu test, a lab station, a before/after GIF against today's default, a phone toggle diff. A step adds
its route beside the old movers (`?solver=engine`); each deletion is its own later commit, after the owner's OK in the lab.

1. **Rows on terrain** (stages 1, 3 terrain, 5, GPU sleep). **Built: see "Step 1 as built".** Then deletes the CPU
   rigid rock.
2. **Round trip for one body** (stage 4 without budget): row → particles → rows, with a split. The riskiest new
   part, and it carries the look the owner liked. Deletes the lattice's CPU sleep and both reads.
3. **Body ↔ body** (stage 2, the fine benchmark, then the winner). Deletes the voxel hash for rigid bodies.
4. **Terrain pieces as rows, fed by today's judge** (below). Deletes the lattice and the CPU rock as direct movers of
   freed pieces (`spawnRigid`'s two branches, `integrity/lattice.ts spawnLattice` for rock, `ROUTING`).
5. **The §9 GPU trigger** (DA-E3) in place of the judge (below). Deletes `game/judge.ts`, `fracture.ts`,
   `integrity.ts` and `integrity/*`, `shaders/judge/*`, the rule in `structure.wgsl`, and the judge's 1–4 MB column
   reads (DA-B12).
6. **Budget and priority,** paged particles, the phone run that sets the budget. Deletes `PV_CAP` and the 8-bit id.
7. **Events and rest:** GPU consumers; rest writes External (owner + normal) from the model on the GPU. Deletes
   `touches`, `Integrity.restRigid`'s CPU claims, `project.wgsl`'s `physCols` path.
8. **Retire the node solver** and `variant.ts`.
9. **Kinematic rows, buildings waking** (DA-E6, DA-E8). A time distortion field (PE12) is a small step of its own
   right after step 1: `rowDt` in `engine_step.wgsl` is its hook.

## Terrain pieces are rows (the owner, 2026-11-15)

"And terrain breaking needs rigidbodies to be complete. Pieces can hit and break other pieces." Terrain destruction is
inside this engine's finish line. A piece freed from the terrain (a cut spire, an undercut mesa, ejecta, a wall) is an
ordinary row with a model baked from the freed column region. From then on it is any other body: it meets bodies, a
hit past the material threshold sends either one through stage 4, and the parts that settle are rows that can break
further pieces. §9: "The marked region … becomes voxel bodies that deform and fracture within the engine's budget."

- **The seam today:** `game/integrity/tick.ts:331 apply` cuts a verdict's pieces out of the columns on the GPU, then
  `game/integrity/rigid.ts:33 spawnRigid` turns each piece's runs into cells on the CPU and hands them to a mover
  (`:51` the lattice, `:55` the CPU rock). The judge knows the cells because it read the columns back (DA-B12).
- **Step 4, the judge feeds rows.** `spawnRigid` calls the engine's `add` with those cells: no new read (the judge
  has them), one upload of the row and its samples. This makes the chain testable before the trigger exists.
- **Step 5, the trigger feeds rows with no CPU in between.** The trigger leaves a label per column run for each
  marked region. Three dispatches over the marked columns only: `count` (atomics per label: cells, mass, centre,
  second moments, surface cells), `alloc` (a thread a label: a row from an atomic row counter, a sample range from
  an atomic bump), `write` (each surface cell writes its sample; the row gets mass, centre and inverse inertia; the
  runs are cut from the columns in the same pass). The mesh is the rock mesh's own GPU path: the region copied into a
  slot of its layers copy and meshed there (`render/rockmesh.ts`), written by a kernel instead of `alloc`'s CPU
  packing. The CPU learns the new row count from a 4-byte async read after the edit, only to size `compact`.
- **The chain's test** (`test/gpu/engine-chain.test.ts`, with steps 2–4): piece A cut from terrain falls on body B;
  B fractures; a part of B hits C; C fractures. Asserted: every part is a row or loose ground, and mass is conserved
  across terrain → rows → loose ground to within the deposit's rounding.
- **The lab station:** in the rock lab and the playground's rock station, a spire toppled onto a second spire and a
  stack of blocks, as part of the pile-up.
- **When the budget is full:** candidates the `select` pass does not admit stay rigid. They still collide, and the
  erode rule takes material where they overlap, so a big collapse loses detail (fewer bodies deform) and never waits
  on stage 4. §9: "When the budget is full, or a piece is huge or off screen, the column result stands alone. The
  piece falls as a rigid body, or turns to rubble behind dust."

## Step 1 as built (`?solver=engine`)

`src/engine/engine.ts`, `install.ts`; `src/shaders/engine.wgsl`, `engine_compact.wgsl`, `engine_step.wgsl`,
`engine_fold.wgsl`; `test/gpu/engine.test.ts` (11 tests); the playground's `rigid` station; `scripts/enginelab.mjs`.

- **Rows:** `pose` 64 B (the tick's start and now, drawn between them), `vel` 32 B, `info` 48 B, growing by doubling
  with a GPU copy. A model's surface cells are its samples (16 B), with two contacts a sample (64 B): the ground under
  it and the walls beside it.
- **A tick:** `compact` (one read a row; the host's impulses and wakes), then per substep `fine` (a workgroup an
  awake row) and `solve` (a thread an awake row), then `fold`. All but `compact` are indirect dispatches sized on the
  GPU, so rows asleep cost one read.
- **Drawing:** one mesh a body (`render/bodymesh.ts`, a third pose kind), placed on the GPU from `pose`.
- **Nothing is read back** on this route. The transfer gate lists its three sites: uploads and one GPU copy.
- **Not in step 1:** bodies do not meet each other; what the judge frees still goes to the lattice; a body at rest
  claims no External; an impact stops dead instead of being softened by stage 4; a sleeper wakes only by an impulse or
  `wakeNear`, not when the ground under it goes.

## Step 2, the round trip: the mechanism (not built; for review before code)

**Ruled on (the orchestrator, 2026-11-15): departures 1 and 2 below are rejected, 3 is accepted. What is built is in
"Step 2 as built" at the end of this note; this section stays as the proposal that was reviewed.**

Read from the code on 2026-11-15. Two fixes the review asked for are built and tested (below); `expand` and `settle`
are not. Everything here is a proposal for how §10.4's "A body returns to rigid once settled" is done with no readback.

- **One particle set a body, made when the row is added.** `Engine.add` also makes the body's lattice twin
  (`physics.ts:392 spawnLattice`, its mesh bound by `integrity/lattice.ts:72`): rest positions, bonds, material. The
  twin is *held*: a new bit of the particle's info word (`phys.wgsl:23`, bit 29) that `sleeping()` (`phys.wgsl:102`)
  also tests, so no lattice kernel solves it. That is one added line in `phys.wgsl`; the old route never sets the bit.
- **The row is drawn by the lattice's own mesh from the start.** A `follow` kernel (a workgroup an awake row) moves
  the row's held particles by the row's change of pose this tick, and the lattice's `skin` draws them. So the mesh
  before, during and after deformation is the same mesh on the same particles: no swap, and no pop to hide behind
  dust. Step 1's hex-prism mesh (`render/bodymesh.ts` kind `row`) stays only for rows with no twin.
- **`expand`** is decided in `solve`'s first pass, where step 1 already has the impact's energy. Past the material's
  threshold (energy over mass, a panel slider a material) the row is *not* solved: it keeps the velocity it came in
  with, its particles get that velocity and spin, their held bit is cleared, and the row is marked deforming (no
  kernel visits it). The lattice then takes the hit itself, so the break is the lattice's, as the owner liked it.
- **`settle`**: `stats` (`phys.wgsl:1025`) already sums a body's speed. A thread a body keeps a still timer on the
  GPU; past rest speed for rest time it labels the body's particles by their bonds (label propagation with pointer
  jumping, dispatched only while a settle is pending), then a thread per part's root sums mass, centre and inertia
  over the part, takes a row and a sample range from atomic counters, writes the samples (surface particles about
  the centre, the row's rotation the identity: the model is re-expressed where it lies, so nothing is re-splatted
  onto a grid and a bent beam keeps its bend to the particle), and sets the held bit. Parts under the crumb size are
  marked crumbling and leave through `deaths` to the deposit. Mass in = rows out + deposit.
- **The lattice's sleep and reads on this route:** settling is its sleep. `Physics` takes a flag that skips
  `updateSleep` and the `bstat` and `touches` copies (`physics.ts:647-668`, `:761`, `:893-904`); the lattice's
  substeps are dispatched indirectly from a GPU count of deforming bodies, so they cost nothing when none deform.

**Departures this mechanism adds, to rule on before it is built:**
1. Every rigid body's particles exist from the moment it is added (132 B a voxel), not only while it deforms. It
   removes the hand-over pop and any GPU allocation at `expand`. The note's paged pool (step 6) changes where they
   live, not this.
2. Until step 6: the lattice's 255 bodies and 131,072 voxels cap the engine's bodies too, and rows made on the GPU
   need their own index range (the CPU cannot know the count without a read): a fixed split of the row and sample
   buffers. Both are caps of the kind the owner wants gone; step 6 removes them.
3. A settled part's model is its particles where they lie, not a grid. Body ↔ body's occupancy pyramid or distance
   field (PE3) then needs a splat of those particles: that is where "loses shape below one voxel" would come in, for
   collision only, never for the look.

**Built now** (`test/gpu/engine.test.ts`, 13 pass): a sleeper wakes when its support goes (`compact` compares the
surface pass's word of the column under its centre with the one it fell asleep on: one read a row asleep); a row
eroded to nothing is freed where it is (flags 0, inverse mass negative, its mesh draws nothing).

## Departures from DESIGN.md, and additions

1. Sleepers are met through their own model, not their projection (§10 is silent). Cost: a second, event-built hash.
2. Fine collision by signed distance field, the owner's choice of 2026-11-15, instead of the first baseline, tree ↔ tree.
3. Owner + normal packed in the interval's spare word: at most 65,535 owners in a window.
4. Paged particles with a GPU free stack; models shared until deformed (copy on deform). Additions.
5. The budget's unit is voxels deforming at once. §10 says "a fixed budget per frame"; this is my reading.
6. Settling makes several rows from one body, and parts under the crumb size become loose ground. Addition.
7. Kinematic rows use a capsule, not a voxel model. §10 says "one baked voxel model per object"; agents have none.
8. **Heightfield first for terrain contact** (the owner asked whether most cells need full columns). The terrain
   test can read the surface pass's column word and its loose run's depth (two reads) and walk the intervals only in
   columns with an air gap (the word's gap bit, already there). It is derived state from the surface pass, not a
   collision mesh, so §10's "tested against the **columns** directly" holds. Fresh in the same tick: the engine runs
   right after the surface pass. Measured (desktop proxy, Dawn, 4,096 awake rows of 8 samples): 0.51–0.61 ms a tick
   with it, 0.53–0.55 without; no difference outside noise. So the interval walk is the default and the fast path is
   a panel switch (`engine.fastPath`) for the phone to judge. Trade-off: one more code path, heights quantised to
   1/256 cell.
9. Step 1's solve is each row over its own contacts in turn, with the impulse kept per contact, not the note's
   `bodyDelta` accumulation: against terrain alone rows are independent. `bodyDelta` comes with body ↔ body.
10. Contacts are two fixed slots a sample (64 B), not a counted 48 B list; point, closing speed and energy go to the
    event instead. Events are a ring of 1,024 a tick.
11. Wall contacts use the mean normal of the hex faces round a sample. Face by face, a straight cliff is a zigzag and
    a body's own cells mesh with it like teeth: a toppled block hung on the cliff for seconds (the test's first run).
12. Erosion in step 1 takes material from the body only, and only in solid ground; the dent in soft ground is step 7.

## Hacks and limits

- Contacts are one per surface sample. A half pair tests at most 2,048 samples a pass (a number of mine, to be set on
  the phone); a pair reaches the solver as four rows at most.
- The distance field rounds edges: within a voxel of an edge (two for `grad8`) a contact's normal leans towards the
  next face, up to 54° at single samples. A pair's rows take the mean, which leaves 9.5° where a box sits over
  another's corner and 46° on one row of an edge in a face (PF3).
- Deep overlaps of big models are the fine pass's worst case: 256 pairs of 32³ a third inside each other cost
  2.2 ms on the desktop (PF14).
- Jacobi accumulation with fixed-point atomics: stacks settle slower than a coloured solve. §10 leaves the choice to
  measurement.
- Re-splatting a bent body loses shape below one voxel.
- Buildings collide at column resolution until owner + normal lands; no insides until INT8.
- The hash chain guard (128) stays in stage 4 unless the budget makes it unreachable: a silent drop today.
- Positions are f32 in window space; the shift on a slide stays.
- Step 1: a sample is a sphere of half a cell at a surface cell's centre. A row's solve is one thread looping all its
  samples, so a 2,000-sample block is slow. Interior cells are not samples: once a face erodes, the layer behind it is
  held only by its edges. A row's inertia follows its mass, not its changed shape. A station reset lets every row go. Sample and row ranges
  are never reused until a reset. Over 65,535 awake rows won't dispatch. Events past 1,024 a tick are counted, not kept.
- With `?sleepmore=1` the surface pass skips sleeping chunks; the fast path then trusts a chunk's last surface word
  (not checked). The default interval walk has no such lag.
- The writing lint fails on `src/roadlab/control.ts` at this tip, before any change here.
- A sleeper watches only the column under its centre: a long beam whose end loses its ground stays asleep. Any change
  of that column's word wakes it (a new interval, sand buried under something), and it sleeps again 0.6 s later.
- Of this note, the fine collision pass (tests and desktop bench) and the lattice bench below have been run. The rest
  has not.

## Open questions for the owner

1. Sleepers: own model (recommended) or the column projection?
2. Should an agent stop or turn a rolling rock at all, or only be knocked down by it (one way)?
3. Deleting movers as steps land means before-GIFs come from 7ea5e4da, recorded once. Is that enough to judge by?

## Measurement: the lattice today

`?physbench=1` still runs on this tip. One run, **desktop proxy** (headless Chrome, D3D11, Intel, 412 × 915,
`q=low`), `node scripts/physbench.mjs --url http://localhost:5310 --pairs lattice:runs`, exit 0, no page error:

| stage | p50 / p95 / p99 ms | physics toggle, frame / GPU ms | awake bodies | column read |
|---|---|---|---|---|
| drop the line-up | 9.9 / 10.6 / 11.5 | +0.04 / +0.8 | 7 | 8 × 3.8 MB, 171 ms latency |
| topple the rock towers | 9.9 / 10.4 / 10.7 | −0.02 / +0.33 | 9 | 10 × 1.9 MB |
| undercut the mesa | 9.9 / 10.4 / 10.7 | +0.02 / +0.37 | 10 | 7 × 1.7 MB |
| topple the house towers | 9.9 / 10.4 / 10.8 | +0.04 / +0.49 | 13 | 7 × 1.7 MB |
| swing the tanker into the bridge | 9.9 / 10.4 / 10.8 | 0 / +0.34 | 19 | 17 × 1.1 MB |

The frame sits at the headless cap (9.9 ms), so the frame diff says nothing here; the GPU diff is 0.3–0.8 ms. The
1–4 MB column reads are the integrity system's CPU copy (DA-B12), not the lattice's, and they are what §9's trigger
removes. Round 120's phone figure for this pair was p95 22 / p99 37 ms.

**For the phone** (Pixel 9a, Chrome, screen on; the bench holds a wake lock and offers the report to download):
`/?skipmenu=1&level=playground&tutorial=0&q=low&physbench=1&pairs=lattice:runs`, about 4 minutes. The numbers to
read are each stage's `physicsToggle.frameMs` and `gpuMs`. The lattice code on `physics10` is `fortress` 7ea5e4da's,
so a build of either gives the same run.

**What the report can't give yet:** a voxel count. It logs awake bodies, not voxels in use (`Physics.used`) or voxels
awake, so the phone run gives ms per scene but not ms per thousand voxels, which is what the stage 4 budget needs.
Adding those two numbers to each row is a few lines in `src/perf/physbench.ts`; I have not made the change (PE8).

## Step 2 as built: letters A to C (branch `physics10-break`)

The orchestrator ruled on the mechanism above (2026-11-15): departures 1 and 2 rejected, 3 accepted. What is built
follows the rulings, not the proposal. Files: `src/engine/engine.ts`, `modelmesh.ts`, `install.ts`;
`src/shaders/engine_deform.wgsl`, `engine_lattice.wgsl`, `engine_draw.wgsl`; `test/gpu/engine-break.test.ts` (8 tests
and a numbers run). Letter D is built: see "Step 2, letter D as built" below.

- **A pristine row owns no particles.** A model lives once in the heap (16 B a lattice cell: rest place about the
  centre of mass, material, 26 bonds), shared by every row made from it. `expand` gives a row a deform slot and pages
  of 512 particles from a GPU pool; `fill` writes a particle a voxel at pose × rest place with the row's velocity and
  spin.
- **Paging before caps.** A particle carries no body id: its page knows its slot and its place in it, and lattice
  neighbours are found by arithmetic through the slot's page table. No 255-body limit, no `PV_CAP`. Pages, slots and
  rows are taken on the GPU (a free stack, then a never-used counter). Every buffer doubles and rebinds.
- **Rows the GPU makes** take odd indices and the host's even ones, so neither needs the other's count. Samples and
  the heap are each one buffer in two halves (the host's, then the GPU's), addressed past a line in the uniform.
- **The one read:** the pool's header, 256 B, every 4 ticks, never waited for. It only sizes buffers ahead of need
  (grow when half full). An allocation that finds no room is counted there; the body stays rigid.
- **`expand` is decided in `solve`** from the hardest stop among the row's contacts (½ stop² over the contact's
  inverse effective mass, against threshold × mass, a slider a material). The row is not solved that tick.
- **Stage 4 is a fork** of the lattice's kernels (`engine_lattice.wgsl`): `phys.wgsl` is untouched and
  `?solver=lattice` is as it was. They are dispatched over live pages only, from the GPU's count: nothing deforming,
  no workgroups (tested). Still is decided on the GPU (mean voxel speed under the still speed for the still time).
- **One mesh a body in every state** (the owner: "the render should not jump to voxel"). The draw list is built on
  the GPU when a row comes or goes; `eskin` places each triangle each frame: a rigid row's by its pose, a deforming
  body's by the voxels its vertices are weighted to. At the tick of expansion the two are the same triangles: the
  largest vertex move measured is 3.8e-6 cells.

### How each state is drawn

| state | engine route (`physics10-break`) | lattice route today |
|---|---|---|
| rigid | the model's mesh by the row's pose | (none: a dropped body is lattice from the start) |
| expanded | the same mesh, skinned to the particles by vertex weights | a body mesh (or the rock mesh for rock) skinned to its particles; its voxels hidden |
| cracked | triangles stretched past the tear limit or with their voxels gone are dropped: **the break is an open hole, no break face is drawn** | the same: `skin` drops torn triangles, no break faces |
| settled part | not built (letter D): a still body stays skinned to its standing particles | no settle: it stays lattice, asleep |
| fragment | none exist: a crumbling voxel goes to loose ground with a chip and dust particles | bodies Integrity makes are hidden and go to dust; only `Physics.spawn(model)` (the test API) draws cubes and half-size cube fragments (body 255) |

Freed terrain today: `spawnRigid` gives a rock piece a slot of the rock mesh (the field mesh's own copy of the
region), so it is not drawn as cubes; a piece of built material gets the body mesh (hex prisms of its cells).

### Measured (desktop proxy: Dawn in Node, Intel Xe, D3D12; wall time of a tick, the surface pass included)

- 8 rigid rows of 16³ awake: 10.45 ms a tick (step 1's one-thread solve over 1,352 samples a row, PE15).
- The tick those 8 expand (32,768 voxels): 27.3 ms, once.
- 32,768 voxels deforming: 12.6 ms a tick, so about 2.2 ms over the rigid tick.
- Bytes: a pristine row 160 B plus 80 B a surface sample; its model is shared (16 B a lattice cell, 48 B a mesh
  vertex). A deforming voxel 132 B plus 8 B a page. A settled deformed voxel: not built (planned 16 B a cell of the
  part's box plus its baked mesh).

### Findings for the owner

- **Cracked stone bounces for a long time.** A 6 × 6 × 4 stone block from 24 cells loses 36 voxels to the ground and
  half its bonds, and its chunks rebound about 5 cells; it is still 8 s after the hit. The kernels are a line-for-line
  port, so the lattice route likely does the same; I have not run the two side by side. To judge in the lab.
- **A break is a hole today** on both routes. The owner's method for break faces is recorded below; it is not built.

### Departures from the rulings and the design in A to C

1. Rows the GPU makes take odd indices, the host's even ones. The ruling said "atomic counter plus free list": that
   is what the odd rows use. Cost: up to half the row room unused when one side makes few rows (160 B each).
2. ~~The voxel hash is left out of the engine's stage 4.~~ Restored in D0 (below): deforming voxels meet each other;
   a deforming voxel and a rigid row still do not (PE3).
3. Left out of the fork: half-size fragments, heat, drives and pushes, the air shoved by a landing.
4. A row that expands is frozen for the one tick it expands (not solved, lattice from the next tick).
5. The transfer gate counts the pool header read as a §24 breach (a timed read in play). It is listed with PE21.
6. Pages are taken all or none. Taking them one by one let bodies expanding in one tick starve each other.

### Hacks and limits in A to C (all in BACKLOG PE20 to PE27)

- Samples, heap words and the host's rows are never reused until a reset; only pages, slots and GPU rows are.
- A slot's page table holds the biggest model's pages; a wider table re-lays the records (a copy a slot).
- A model whose row eroded while rigid expands whole again (the eroded cells return).
- The draw places every listed triangle every frame, asleep rows too, as step 1's did.
- A still body is never woken until settle exists. `Engine.clear()` and `release()` are the only ways out.
- A deforming body does not follow the window's slide.
- Crumbled voxels go to the ground through the 1,024 events a tick; more wait a tick (none lost).
- 16 host commands a tick; more wait.

### D0: three things settled before letter D (measured, `test/gpu/engine-d0.test.ts`, the numbers run)

1. **Bounce: the missing voxel hash was the cause.** The same 6 × 6 × 4 stone block from 24 cells on both routes,
   measured by its voxels: the lattice route is still 0.33 to 0.80 s after the hit, mean rebound 0.07 to 0.10 cells;
   the fork took 7.57 s and 1.88 cells. On the lattice route a voxel touching an unbonded neighbour (the two sides of
   a crack) has its speed along that contact held to the bounce (`finalize`), so a cracked block cannot ring. With the
   hash restored the engine is still in 0.45 to 1.45 s, rebound 0.26 to 0.34 cells. No constant changed. What is
   left of the difference is not explained: the lattice route loses about 41 voxels to fragments, the engine about 32.
2. **Contacts among deforming voxels.** `vhash` puts every living voxel of a deforming body into a hash (heads
   twice the particles' room, 20 B a voxel of room); `collide` reads its 27 cells as phys.wgsl does; `relax` clears
   each voxel's own bucket, so clearing follows the voxels deforming and the table is empty between substeps. The
   128-step chain guard is counted (the pool's header, `hashOver`), not silent. Two expanded bodies meet.
3. **The expand tick does not hitch; the growth tick does.** With room made, the tick 8 bodies of 4,096 voxels
   expand is 1.2 ms of engine GPU time (the draw list remade 0.46, `fill` 0.07). The 27.3 ms recorded above held a
   grow-ahead: new buffers, a GPU copy, every bind group again, about 8 ms of wall here (PE29). The "ordinary tick"
   of 10.45 ms was step 1's one-thread solve (5.7 ms for 8 rows of 1,352 samples, PE15) plus the test world's surface
   pass and the wait for the submit (3.7 ms with every row asleep, engine GPU under 0.2 ms). 32,768 voxels deforming:
   4.9 to 5.2 ms of engine GPU (region 1.6 to 2.0, gather 1.1 to 1.3, collide 0.9 to 1.1, the hash 0.2). Pipelines are
   made in the level's pipeline batch, before the first frame.

## Owner's directions for the next letters (2026-11-15, verbatim)

**Rendering.** "the voxelized terrain should carve the mesh not turn into voxels visually it is fine to simulate as
voxels with vertex weights tied to them but the render should not jump to voxel."

**Break faces (replaces capping with voxel faces).** "When the lattice breaks we could use a scalar or normal field
and then dual contour or marching tetrahedrons to close the gap so that the shape resembles whole bricks or whatever
the material grain is."
- A scalar field with normals over the part's voxels at its rest lattice; its iso-surface is the break surface.
  Occupancy shaped by a grain function a material (brick courses, bedded stone, concrete aggregate, wood splinters,
  torn metal), in the body's rest frame, on the tuning panel (cell size, aspect, offset a course, roughness).
- Extraction on the GPU only over cells next to snapped bonds. The outer surface keeps its mesh: carve, never
  re-mesh the body. Compare surface nets / dual contouring (a vertex a cell, a quad a sign-changing edge) with
  marching tetrahedra by stills of brick and stone and by cost; name the choice and keep the other listed.
- The new vertices are skinned to the part's voxels and baked with the mesh at settle. The seam with the original
  surface must be closed: say how they meet.
- If too big for D: land D with surface nets over plain occupancy behind the same interface (field → extractor →
  skinned break mesh), grain kernels as the next letter. Never cube faces as a stand-in.

**Terrain pieces as rows (PE13), to record, not built.** A freed piece takes its outer surface from the terrain's
own mesh for that region, the terrain mesh is carved where it left, its voxels exist only for simulation with the
mesh weighted to them, and the cut faces come from the same extractor and field for both the piece and the hole, so
they fit like a broken thing. No jump to voxels at release.

**Telekinesis rip (PE28).** See BACKLOG. The owner's refinement (2026-11-15): "Minor but for the telikinisis it should
already be dampened spring like and increase force as you drag further from the grabbed material. I would not cut the
material until the drag distance produces sufficient force. They gives players a cancel and it means their finger
isn't covering up the cool effect when it rips free".
- The grab anchors a damped spring at the grabbed matter; the force grows with the drag distance from the grab point
  (stiffness, damping and maximum on the panel; reuse the drag tool's spring, SL17 `src/ui/editor.ts`, after checking it).
- Nothing is cut at grab time. Below the force the lattice rule needs to snap the boundary bonds the matter stays put
  (elastic give shown where affordable); dragging back or releasing cancels with no change to the world.
- The cut happens when the spring force crosses the threshold, with the finger already away from the grab point; the
  freed chunk is then pulled along the spring toward the finger. Feedback while charging (the spring line, strain on
  the surface) is a UI note for that step. Not built.

## Step 2, letter D as built: settle, with break faces (branch `physics10-break`)

Files: `src/shaders/engine_settle.wgsl` (new), `engine_draw.wgsl`, `engine_deform.wgsl`, `engine_compact.wgsl`,
`src/engine/engine.ts`, `modelmesh.ts`; `test/gpu/engine-settle.test.ts` (6 tests, two numbers runs).

- **The state machine** is `slots`'s, as designed: still for the still time, then LABEL0, LABEL1, PARTS, RELEASE. The
  settle kernels are dispatched over the live pages only while a body settles (the GPU's count).
- **Labels.** A label a voxel: the least lattice cell among the voxels it is bonded to (both ends holding the bond),
  eight passes a tick with pointer jumping, till a whole tick changes none.
- **Parts.** A thread a part's root. Under the crumb size: its voxels crumble and `deaths` lays them on the ground. The
  whole body, every bond holding and within 0.02 cells of its model moved rigidly: its own row back, on the shared
  model, nothing allocated. Otherwise a row (an odd one), samples and heap from the pool: a **compact model** (a
  record a cell of the part's lattice box: its place about the part's centre where it lies, material, the bonds that
  hold; the rest frame is the world's at that moment, the row's rotation the identity) and a **baked mesh**. The row
  is written asleep; `compact` gives it the ground's word it sleeps on. Pages, the slot and the old row go back.
- **A later `expand`** reads the compact model like any model: a bent beam re-expands bent, no vertex moves
  (measured 1.9e-6 cells).
- **Vertex weights changed** (`modelmesh.ts`): a vertex is weighted to the body's cells round its lattice corner
  (at most four, equal weights, the cell whose face it is on first), not to the four nearest voxels. Every face at a
  corner is then carried by the same voxels, and a triangle belongs to one cell, so a part's outer faces are exactly
  its own cells'.
- **Break faces** (the owner's method; the plain closed surface, grain not built). Field: the parts' labels over the
  body's rest lattice. Extractor: surface nets on the hex-prism lattice, a vertex a lattice corner (three columns by
  two layers meet there), a polygon a face between a cell of the part and a cell that was the body's but is not the
  part's. A corner's place depends only on the corner: the mean of the middles of the cut edges round it
  (`breakSmooth`), plus a noise of the corner (`breakRough`); both sides of a crack get the same surface. **The seam:**
  a corner that also touches the body's outer surface stays at the cell's own corner, where the outer mesh has its
  vertices, so the break is sealed to the original surface and the original surface is never re-meshed. Closed is
  tested by welding vertices within 0.02 cells and counting edges with other than two triangles: none. The break
  vertices are weighted to the part's cells round the corner and baked with the mesh.
- **Marching tetrahedra was not built**, so there is no comparison: surface nets was the brief's starting point and
  it closed against the original mesh by construction. The other stays listed (PE22).
- **Break faces appear at settle only.** While a body deforms a crack is a hole (torn faces dropped), for the still
  time plus at least four ticks. Live break faces need the labels every tick (PE31).
- **The draw** (PE26): rows asleep come after the rows awake in the draw list, are placed once and stand; a frame
  with nothing awake dispatches no workgroup.
- **For the collision branch:** `Engine.occupancy(enc, row, out)` writes a row's lattice box, voxel count and a
  material word a lattice cell into a buffer, on the GPU, for an SDF bake.

### How each state is drawn now

| state | engine route |
|---|---|
| rigid | its model's mesh by the row's pose; asleep: placed once, not every frame |
| expanded | the same mesh, each face by the voxels its own cell is still bonded to |
| cracked, mid-break | faces follow their own side of the crack; the gap between is an open hole; faces stretched past the tear limit are dropped |
| settled part | its own baked mesh: the outer faces of its cells and the break faces that close it, rigid by the row's pose |
| crumb | never drawn as a voxel: loose ground where it lay, a chip and dust particles |

### Measured (desktop proxy: Dawn in Node, Intel Xe, D3D12; GPU timestamps a kernel)

- Settle, the most a tick took: labels 0.2 to 0.3 ms (8 passes); a part's numbers, model, samples and row 0.39 ms
  for a 144-voxel body, 3.67 ms for a 2,048-voxel one (the root threads' loops, PE32); the baked outer mesh 0.13 ms;
  the break faces 0.20 to 0.26 ms.
- A settled voxel: 20 to 27 B of compact model (16 B a cell of the part's box and a 64 B header), plus its mesh at
  48 B a vertex unindexed: 574 B a voxel for a 1,467-voxel part, about 1 KB for parts of 60, 2 KB for one of 7.
- At settle: a bent steel beam, no vertex moves (0); a stone slab broken over a ridge, 49 of 638 triangles move more
  than 0.05 cells, the most 0.19 (hairlines inside a part closing, PE31).

### Departures in letter D

1. A vertex's weights are the cells round its corner, not the four nearest voxels (above). Trade-off: a bend is
   blended over one cell's reach, not two; in return faces stay joined and a triangle has one owner.
2. While deforming, a face is placed only by voxels its cell is still bonded to (the old rule blended across a crack
   until the triangle tore). Trade-off: the baked mesh uses the part's voxels, so hairlines inside a part close at
   settle (PE31).
3. Faces the deforming draw had dropped as stretched come back at settle if their cell is in a part (a creased steel
   beam: 42 of 492). No bond had snapped there.
4. A settled row is written asleep, not awake: bodies do not meet each other yet, so an awake part would fall through
   the part under it.
5. Break faces are surface nets on the hex-prism lattice, the lattice the bodies have, not on a cubic grid.

## Step 2, letter E as built: the lab's break station

- **Station `break`** on the playground (`src/levels/playground.ts`), on the metal station's land: a stone block
  from three heights (8, 24, 48 cells) on its stone pad, a stone slab and a steel beam across a post on a new pad
  beside the tanker, a brick section dropped on its long side. The buttons go through `k.drop`, so `?solver=lattice`
  and `?solver=engine` press the same things. Its hint says bodies do not meet each other yet.
- **Panel:** the tuning panel's engine group has the break thresholds a material, the still speed and time, the crumb
  size and the break faces' two numbers (smoothing, roughness). Grain numbers come with the grain (PE22).
- **Capture:** `node scripts/breaklab.mjs --solver lattice|engine --out <path> [--press "a|b"] [--look x,y,z --zoom n]`
  (412 x 915; a GIF, stills, and under the engine the pool's header at the end).
- **Found by the captures, fixed:** deforming bodies slid across the ground for ever in the level (PE33: the shape
  matching's sums at world coordinates). The Node tests stand at x = 12 to 20 and did not show it.

**What the stills show** (looked at; the engine route unless said):
- **The station, both routes.** Lattice: the stone comes down as smooth rock-mesh lumps in dust, the brick section
  as one red block, each near where it was dropped. Engine: every body settled (5 parts, none left deforming), where
  it fell; each is drawn as hex prisms of its cells with flat-shaded sides, so stone reads blockier than on the
  lattice route. The view is crowded by the tanker and its posts.
- **The slab over the post, close.** Snapped in two; the halves lean on the post as tilted wedges. No hole: the
  ends are closed by pale faces. The tilted prisms give the sides a sawtooth outline. The break face itself is
  nearly flat and reads as a tiled end, not as broken stone.
- **The stone blocks, close.** Two blocks sunk a layer into their own rubble, one with a round pit in its top. No
  open hole into either. Where voxels crumbled the cap is, in effect, the faces of the cells left standing: in a
  body three or four cells thick almost every corner of a break face also touches the outer surface and is held at
  the cell's corner, so smoothing and roughness move very little. It does not yet look like broken rock.
- **The brick section, close.** Two low clumps of hex-outlined cells in brick red. Closed, but nothing about it
  says brick: no courses, no whole bricks. That is the grain, not built.
- **What looks wrong:** the hex-prism look of every body; break faces that are cell faces in thin bodies; the
  sawtooth of tilted prisms; no shatter into many pieces from any height; the crowded station.

## The owner on the rigid lab (2026-11-15, verbatim): stone

"Rigid lab looks good for steel reinforced concrete but the stone is too rubbery (it should probably have very little
elasticity)". A requirement on stone, brick and plain concrete, deforming and rigid. Diagnosed, not fixed (PE35):
deforming stone flexes up to its 4 % break strain before a bond snaps, rebounds 0.26 cells from a 24-cell drop and
gets a tenth of a contact's speed back; a rigid stone block landing flat sinks 0.001 cells and comes back 0.002, so
the flat landing is not it; edge landings and topples are not measured. The test's bounds are today's numbers.

## Hand-over: what is next

First: PE35, the owner's stone (brittle materials with no elastic give, restitution a material, the rigid row on an
edge), with a close stone drop in the station's capture to judge wobble.

The round trip is built end to end (expand, lattice, settle, break faces, lab). Open, in the order I would take
them: the grain function behind the break field (PE22); labels every tick so a face is drawn by its part while it
deforms and break faces appear with the crack (PE31); the expand rule over the whole approach (PE30); a station of
its own and the rock mesh's surface for stone (PE34); the root threads' loops (PE32); phys.wgsl's sums (PE33).

## Hand-over as it was written for letter D (kept for the record)


D is designed and its state machine is in place (`slots` in `engine_deform.wgsl`: LABEL0 → LABEL1 → PARTS → RELEASE,
gated by `Engine.settles`, false today, which parks a still body in S_STILL). To build, in `engine_settle.wgsl`:
1. `labelInit` / `labelStep` over the live pages while `dargs[4]` is set: a label a particle in `pw[3i+2].x`, the
   least label among bonded neighbours with pointer jumping; changes counted in the slot's sums word 2.
2. A thread a part's root: count, mass, centre, inertia, lattice box; under the crumb size mark `PV_CRUMBLE`
   (`deaths` deposits). Else take a row (`takeOne` on P_ROW_*, row = 2g + 1), samples and heap (`takeRun`), write a
   compact model (rest place = place − centre, rotation identity, bonds as they stand) and its row. A part that
   finds no room adds to sums word 4 and is tried again. Bindings must stay ≤ 8 a kernel: split into scan, samples,
   mesh, row.
3. Mesh bake: the part's share of the source triangles with the same drop test as `eskin`; a vertex's place is the
   skinned place minus the centre, its weights only the part's voxels. Then the break surface, by the owner's method.
4. Tests listed in the brief for D; the equality test pattern is `R.drawn()` before and after.
5. Then `Engine.settles = true`, wake a settled row as any row, and the lab station (E).
