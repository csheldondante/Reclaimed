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

**Built on `physics10-fine`, not wired into the game.** `src/engine/sdf/` (`contract.ts` the layouts, `models.ts` the
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

**The finding to weigh before building on it.** 256 pairs of 16³ cost 0.6 to 0.7 ms here by timestamps, and 0.8 to
1.3 ms in headless Chrome by the bench page's toggle: at the 1 ms line set for this pass. The cost follows the
threads (about 1.1 ns each) and hardly the contacts: a touching pair spends over 99% of its threads on samples
nowhere near the other body. The fix is to cull before threads are made: samples sorted into bricks at the bake, and
`expand` making chunks only for bricks inside the other body's bounds (PF2). I estimate a tenth of the threads for
touching pairs; not measured.

**For the phone:** `sdfbench.html` (dev server: `http://<this PC>:5173/sdfbench.html`), about 5 minutes for every
format, size and pair count; `?formats=grad8&sides=16&pairs=256,1024` for a short run. It toggles the pass on and off
in windows and offers the report to download. The numbers to read are each row's `toggleDoneMs` and `toggleFrameMs`.

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
  the phone); a deep overlap gives hundreds of contacts a pair and nothing reduces them yet (PF4).
- The distance field rounds edges: within a voxel of an edge (two for `grad8`) a contact's normal leans towards the
  next face, up to 54° at single samples. A box over another's corner gets a mean normal 9° off the face (PF3).
- The fine pass costs about 1.1 ns a thread whether or not the sample is near the other body (PF2).
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

