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

The owner's steer (2026-11-15): "Just make bounding boxes or build trees and do tree tree collisions for intersecting
RBs unless you think there is a faster GPU option? I do like spatial hashes but not for fully voxelated things". So:
bounds in a hash for the coarse pass; never a voxel hash for rigid bodies; tree ↔ tree is the baseline to beat. All
three options come from the one baked voxel model, shared by instances until a body deforms. Example: a 16³ model,
about 1,350 surface voxels.

| | memory a model | work per intersecting pair | contact data | after fracture or deformation |
|---|---|---|---|---|
| **a. tree ↔ tree** (the owner's baseline; octree over the voxels) | ~5 KB (≤ 585 nodes × 8 B) | one thread a pair with a stack of node pairs (4 levels, ~64 entries), sphere tests per node pair; or level by level, a dispatch and an append buffer a level, no stack | leaf overlaps give the point; normal from the leaf's open faces; depth from the overlap along it | rebuild the tree per piece |
| **b. occupancy mip pyramid** (an implicit octree, no pointers) | ~0.6 KB (512 B of bits + mips) | one thread a surface voxel of A inside B's bounds: 1–3 bit reads coarse to fine, most end at the first; no stack | point is the sample; normal from 6 neighbour bits; depth by ≤ 3 steps | re-splat bits, reduce mips: two small dispatches; the erode rule clears a bit in place |
| **c. signed distance field** (distance + gradient, 4 B a voxel) | 16 KB | one thread a surface voxel of A: 8 reads, no branch | depth and a smooth normal in one sample | re-splat, then a jump flood (4 passes at 16³); eroding needs a rebake |

Impact energy is the same for all: ½ · effective mass · (closing speed along the normal)², summed per pair.

On a Mali tiler the stack traversal in (a) is the weak spot: threads of a workgroup diverge and the group waits for
its slowest. (b) prunes like a tree with none of that. (c) costs the most memory but gives the smooth normals that
"deflect and topple" wants. **Recommendation, to be settled by measurement: (b) for the test, and (c) only if (b)'s
face-quantised normals look wrong in the lab.** This is my proposal, not the owner's method.

**The benchmark:** `test/gpu/fine-collide-bench.test.ts`. 64, 256 and 1,024 intersecting pairs of 8³ and 16³ models
at random poses; each option fills the same contact buffer; contacts checked against a CPU brute-force reference; ms
per option printed (`FINE_LOG=1`). Then the same three on the phone bench as toggled windows: the phone is the final
word. If tree ↔ tree wins or is within noise, it is the choice.

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
2. Fine collision by mip pyramid (or SDF) instead of the owner's tree ↔ tree, only if the benchmark says so.
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

- Contacts are one per surface sample; big bodies need a sample cap, found on the phone.
- Jacobi accumulation with fixed-point atomics: stacks settle slower than a coloured solve. §10 leaves the choice to
  measurement.
- Mip-pyramid normals are quantised to voxel faces. Re-splatting a bent body loses shape below one voxel.
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

## Stone and masonry as built (PE35; the look branch, 2026-11-15)

- **The engine's own material numbers.** `Engine.lattice()` is `PHYS_MATS` with the panel's numbers over it for rock
  (every brittle material not named), concrete, brick, steel and wood: bounce, give, ring damping, and for the brittle
  ones crush and crack speed. The lattice route reads `PHYS_MATS` as before.
- **Brittle = no bounce, give 1 %, ring damping 1.** No bond is kept past 1 % strain, so nothing visibly flexes.
- **Shock.** `ps[3i].w` holds the shock that reached a voxel: its own hit, or the largest among its bonded neighbours
  last substep times `shockReach`. `relax` snaps bonds by it, as it did by the hit of the struck voxels alone.
- **Grain** (`engine_grain.wgsl`). A function of material and place in the body's rest lattice giving a grain cell and
  the distance to its side: bricks in courses (length, depth, course, offset), bedded stone (bed, block, irregularity),
  lumps (concrete). `fill` stores a voxel's grain cell beside its material. A bond between two grain cells of one
  material is a flaw: it snaps at `flaw` x the give and, for certain, at `flaw` x the crack speed. A part keeps its
  parent's grain (the model's header carries the grain's origin and seed), so a brick stays that brick.
- **For the collision branch (one line):** the rigid solve's bounce a material is `bounceAt(material)` in
  `engine.wgsl` (uploaded, never above the panel's `restitution`); `engine_step.wgsl` still reads `EU.a.z`.

## The look, as built so far (the look branch, 2026-11-15)

**Item 2 of the look brief, a departure awaiting a ruling (PE38).** Structures already drew with the old route's
mesher (`buildBodyMesh`). Rock did not, and the old route's rock mesh cannot be reused without breaking letter D
(its triangles are not one cell's, its vertices not on lattice corners: a break face cannot be sealed to it without
clipping it; and the host lists its draws, while parts are rows the host never learns of). Options:
1. **Built:** the engine's own mesh, rounded for rock by surface nets over the model's occupancy (the break faces'
   extractor), a normal a corner. Same triangles and owners: expand, settle and the seam unchanged (tests pass).
   Trade-off: the shape is a bevelled block, and the look is `fsBody`'s plain albedo, not `fsRock`'s rock texture.
2. The rock mesh for whole bodies only, the engine's mesh once a body has broken. A visible swap at the first break
   (to be hidden in dust), two looks for one material, and a slot of the rock mesh's copy a body.
3. The rock mesh clipped on the GPU against the parts' field at settle. No jump, but it is re-meshing the body, and
   a new GPU clipper with its own allocation.
4. Option 1 plus the rock look in `fsBody` for a flagged word (the rest place carried to the fragment so the pattern
   does not swim): the cheapest way to the old route's look. Not built.

**The ruling on PE38 (the orchestrator, 2026-11-15; pending the owner's eye in the lab): option 4.** The engine's own
mesh stays (rounded for rock by surface nets over the model's voxels), and the rock look goes into the body's fragment
shader, so engine stone matches the terrain's and the old route's rock. One mesh through rigid, expanded and settled
states; no swap. As built: "Look round 3" below.

### How each state is drawn now

| state | rock (stone, basalt, sandstone …) | what is built (brick, concrete, steel, wood) |
|---|---|---|
| rigid | its model's mesh, corners rounded, smooth-shaded, by the row's pose | the body mesh (cells' corners, flat faces), by the row's pose |
| expanded | the same triangles by the voxels that carry each vertex; normals turned with them | the same |
| cracked, mid-break | each face follows its side of the crack; **the gap is still an open hole until settle** (item 3c, not built) | the same |
| settled part | its cells' share of that mesh baked, and break faces sealed to it (rim placed by the rounding rule); break faces are flat-shaded cell-face polygons with letter D's smoothing (**item 3a/3b not built: no grain in the faces yet**) | the same, rim at the cells' corners |
| crumb | loose ground, a chip and dust (now only single voxels) | the same |

### What the stills show (looked at; 412 x 915, `look-2-*-engine*` against `look-p2-*-lattice*` in the scratchpad)

See the report of the look branch and DEVLOG. In short: engine stone now reads as smooth rounded blocks, no hex
prisms and no zigzag sides; it is plainer than the lattice route's speckled rock and than the terrain. Break faces
are still cell-face polygons: a tilted part shows steps on its broken side. Brick shows clumps, but no courses or
bricks in its faces. Steel is unchanged.

## Look round 3 (2026-11-15)

**Item 1: `burst` is gone.** The owner: "Lose energy, never gain it." A snapped bond changes no velocity; each side
keeps its voxels' momentum; contacts between the sides stop them closing and never push; what the bond lets go is drawn
as dust and chips. `test/gpu/engine-energy.test.ts` holds it over a whole drop (DEVLOG has the numbers).

**Items 2 and 3 (the look in the grain's frame, the grain in the faces).**
- **The draw.** `eskin` writes each vertex's place in the grain's frame (the lattice of the body it first was) beside
  its place in the world; `fsEBody` draws the look there. Stone: the rock mesh's own response (`rockAlbedo`,
  `rockDetail`, shared with `fsRock`). Brick: courses and mortar from the grain's numbers. A break face: the same
  pattern, fresher. Normals interpolated (the dark bases of the last stills were flat normals on the bottom bevel).
- **`cornerAt`**: the one rule for a lattice corner of a settling body. A break's crossing of an edge is where the
  grain's joint crosses it; the corner is the mean of the crossings (brick: by axis); on the outer surface it moves
  along the surface, and the outer faces' vertices on that corner go with it. Closed is tested for stone and brick.
- **Brick and plain concrete** are drawn in their layer's plane (flat sides, sharp edges): a departure, PE40.4.
- **A break's line** on the outer surface is drawn dark (the edge beyond which the cell is another part's).
- **Not built:** break faces while deforming (the inside of the skin is drawn as dark interior instead: PE40.2);
  a second break's seal is by construction, not tested.

### How each state is drawn (look round 3)

| state | rock | brick, plain concrete | steel, wood, the rest |
|---|---|---|---|
| rigid | rounded mesh, normals interpolated, the rock look in the grain's frame | sides flat, edges sharp, flat-shaded; brick in courses | cells' corners, flat-shaded, a third-cell variation |
| expanded | the same triangles by their voxels; the same look (the grain place does not change) | the same | the same |
| cracked, mid-break | faces follow their side; through the gap the skin's inside is drawn dark; dust from the snapped bonds | the same | the same |
| settled part | its faces baked; corners on a break moved to the grain's joint; break faces on the joints, paler; the break's line dark | break faces on the bricks' joints: whole bricks | break faces by plain surface nets |
| crumb | loose ground, a chip and dust | the same | the same |

## Hand-over: what is next

(Look round 3, 2026-11-15; stopped at the owner's word to wrap up.) **Done:** `burst` removed and the energy rule
tested (item 1); the rock look on engine stone, in the grain's frame (item 2, the ruling's option 4); break faces
shaped by the grain, brick in courses of whole bricks, tilted breaks as planes (3a, 3b); the dark inside as cover for
an open crack (3c's stand-in); crumb size a material's, clump size on the panel, the station on land of its own;
`look-3-*` stills of the four tests on both routes.
**Next, in the order I would take them:**
1. PE42 (PE30): the solve's expand rule judged by the whole approach speed: two lines, the collision branch's file.
   Then drop the `.fails` in `engine-energy.test.ts` and look at the three heights again (the highest should break
   up more).
2. PE31 / PE40.1-2: labels every tick, `cornerAt` run live, break faces while deforming: no hop at settle, no gap.
3. PE43.2: a test of a second break sealing to an old break face, once bodies meet bodies.
4. PE40.5: a QEF in `cornerAt` for sharp brick edges; PE41: fold the field mesh's copy of the rock response.
5. The owner's eye in the lab on PE38 (option 4) and on the departure PE40.4 (brick's flat sides).
For the collision branch: `bounceAt(material)` (above); PE42's patch; `Renderer.addMesh` has a fourth argument;
`StationKit.drop` a third; the lattice table's word 14 is a material's crumb size; a mesh vertex's normal word now
carries its corner (ARCHITECTURE.md, "The physics engine's draw").

Before that it was: PE35, the owner's stone (brittle materials with no elastic give, restitution a material, the rigid
row on an edge), with a close stone drop in the station's capture to judge wobble.

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
