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

### Hand-over: joining body ↔ body into the engine

Everything here is on `physics10-fine` (not merged anywhere). Code: `src/engine/sdf/` (`contract.ts` layouts,
`models.ts` the model store, `coarse.ts`, `fine.ts`, `shapes.ts` test scenes), kernels `src/shaders/engine/sdf-*.wgsl`.
Each kernel file's header states its scheme. The engine's row layout is the one in `physics10`'s `engine.wgsl` at
c6f1bab7; if the breaking branch changed it, `contract.ts` "the engine's rows" and the three `poseOf` / `velOf` /
`centre` helpers in the kernels are the only places that know it.

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

**A tick, in order** (all in the engine's encoder, nothing read back):
1. `coarse.setParams(rowsInUse)`; `fine.setParams(coarse.pairRoom, tick)` (two small uniform uploads).
2. `coarse.encode(enc, { list, pose, vel, info, model, sleepEpoch })` after integration and `compact`. Dispatches:
   gate; the sleeper table (clear, count, block sums, super sums, starts, fill: zero workgroups unless the epoch
   changed); the awake table (the same five); stage A; argsB; stage B.
3. `fine.encode(enc, { ...coarse.finePairs, pose, vel, info, model }, coarse.pairRoom)`. Dispatches: pairArgs,
   expand, cull, args, fine, reduce.
4. The solve, then events.

**What the solver reads, a pair.** The pair list: `coarse.pairBuf`, word 0 the pairs asked for, pairs (a, b) from word
64; take min(asked, `coarse.pairRoom`). Pair p's contact rows: `fine.contacts` rows `4p` to `4p + rows - 1`, 48 B each
(`contract.ts` "A contact row": a, b, energy, materials, point, depth, normal from b to a, closing speed). Pair p's
record: `fine.hits` at `p * 128` B: word 4 the sample contacts (what the lattice hand-over wants: how much of the
surface touched), word 5 the largest sample energy (f32 bits; also on every row), word 6 the rows written (0 to 4).
There is no key beside the rows yet and a pair's index p changes from tick to tick: see "stable pair slots" below.

**Tuning parameters.** `fine.margin` (cells; also `CoarseOptions.margin`: keep them equal; the engine's
`EU.f.x`), `fine.cap` (samples a half pair a tick, default 2,048), `CoarseOptions.cellTop` (about the biggest common
body's bound diameter), `levels` (3), `pairsARow` (8). Field format: `grad8`.

**To build at the join, specified here.**
- *Rooms that grow, and a safe tick (PF24).* Three rooms can run out: oversize lists (256 awake, 256 asleep), work
  items (64 a row), pairs (8 a row). Each already counts what it dropped (`pairBuf` words 1 and 2; pairs asked for
  against the room). Wanted: a 16 B asynchronous read of `pairBuf`'s header every few ticks; at half full, make a
  bigger `SdfCoarse` (and `SdfFine`, whose buffers follow `pairRoom`) and swap it in: the kernels' layouts do not
  depend on the sizes, so the pipelines can be shared if the constructors are split from the buffer making. For the
  tick in which a room runs out before the growth lands, "safe" should mean: a row whose candidates were dropped is
  treated as blocked for that tick (no integration past its last pose) and is tested first next tick. That needs
  stage A and stage B to mark the row (a bit a row in a small buffer) where they drop, which they do not do yet.
- *Stable pair slots (PF25).* A persistent open-addressing table keyed by (a, b): a pass after stage B, a thread a
  pair, one probe; a pair found keeps its slot and is stamped with the tick, a new pair takes a free slot; a sweep
  frees slots not stamped this tick. The fine pass then writes a pair's rows at `slot * 4` instead of `p * 4`, with the
  key stored in the pair's record, and the solver keeps its impulses by slot. Tests wanted: a resting stack keeps its
  slots for 100 ticks; a pair that parts and returns gets a clean slot; growth keeps keys.

**Open hacks and limits, by id** (docs/BACKLOG.md): PF3 normals near edges (rows take the mean; 9.5° over a corner,
46° on one row of an edge in a face); PF5 cap and margin defaults are not from the phone; PF7 the field holds ±7.9
voxels; PF8 one-voxel plates' rims; PF9 a 3D-texture field unmeasured; PF10 the store's arena has no compaction;
PF11 and PF20 the phone runs asked of the owner; PF15 at most 65,536 samples a model, four rows a pair whatever its
size; PF17 the join itself; PF21 pair order, oversize rooms, a sleeper moved without an epoch bump is not found; PF23
the fine pass's cull rows; PF24 rooms that can miss; PF25 stable slots.

**Tests a joiner should run first** (Node, real GPU, about a minute):
`npx vitest run --project gpu sdf-bake sdf-fine.test sdf-coarse.test` (15 + 36 + 8 pass at this commit), then
`npm run typecheck` and `npx vitest run --project unit` (one failure on the base: `roadlab/control.ts` in the writing
lint). `test/gpu/sdf-coarse.test.ts` "coarse into fine" is the smallest example of both passes in one encoder with
hand-made engine rows; `test/gpu/sdf-harness.ts` reads pairs, records and rows back. Benches: `SDF_BENCH=1 npx vitest
run --project gpu sdf-coarse-bench` (coarse and the whole path), `sdf-fine-bench` (the fine pass alone),
`SDF_PROBE=1 … sdf-probe` (the coarse pass by part); the phone page is `sdfbench.html`.

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

Each step: a Node gpu test, a lab station, a before/after GIF against today's default, a phone toggle diff.

1. **Rows on terrain** (stages 1, 3 terrain, 5, GPU sleep). Risk: rigid bodies on stepped columns must look heavy and
   topple. Deletes the CPU rigid rock.
2. **Round trip for one body** (stage 4 without budget): row → particles → rows, with a split. The riskiest new
   part, and it carries the look the owner liked. Deletes the lattice's CPU sleep and both reads.
3. **Body ↔ body** (stage 2, the fine benchmark, then the winner). Deletes the voxel hash for rigid bodies.
4. **Budget and priority,** paged particles, the phone run that sets the budget. Deletes `PV_CAP` and the 8-bit id.
5. **Events and rest:** GPU consumers; rest writes External (owner + normal) from the model on the GPU. Deletes
   `touches`, `Integrity.restRigid`'s CPU claims, `project.wgsl`'s `physCols` path.
6. **Retire the rest:** the node solver, `variant.ts`. The CPU judge, sections judge and `structure.wgsl` rule go with
   the §9 trigger (DA-E3), which is not in this note; the engine only accepts what it frees.
7. **Kinematic rows, buildings waking** (DA-E6, DA-E8).

## Departures from DESIGN.md, and additions

1. Sleepers are met through their own model, not their projection (§10 is silent). Cost: a second, event-built hash.
2. Fine collision by signed distance field, the owner's choice of 2026-11-15, instead of the first baseline, tree ↔ tree.
3. Owner + normal packed in the interval's spare word: at most 65,535 owners in a window.
4. Paged particles with a GPU free stack; models shared until deformed (copy on deform). Additions.
5. The budget's unit is voxels deforming at once. §10 says "a fixed budget per frame"; this is my reading.
6. Settling makes several rows from one body, and parts under the crumb size become loose ground. Addition.
7. Kinematic rows use a capsule, not a voxel model. §10 says "one baked voxel model per object"; agents have none.

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

