# Nested scales: zoom in and sculpt inside a larger live scene

Status: a lab on branch `nested-scales` (round 7: size slider, cruise, the streaming policy, the pool shrinks; round 6:
boxes and the partition record; "Built so far" has the current truth, "Streaming" the policy).
Lower priority than the board gameplay loop.

## What this is for

A sandbox where you sculpt, melt and scatter trees on the terrain, zoom in, and keep sculpting finer detail while
the larger scene keeps running around you. Possibly with a free camera.

## The user's rules (quoted; these are the design)

- Nested scenes: "each scene was a 3d scene with instanced meshes normalized to be within 1000 units of the camera.
  Then when the camera moved closer to a surface than a threshold (it was speed limited by interpolated distance so
  it could never go through a surface) I would promote nearby geometry into a rescaled new scene around the camera.
  The old scene would continue to run and render around the camera and the new scene would stream in at magnified
  scale and enhanced fidelity."
- Precision: "When I promote a parent geometry I scale locally into my normalized child scene and if you zoomed in
  again it would do the same with that child's geometry. Each scene everything is in a good range .01-1000 units.
  And nothing ever skips an enhancement and residual mutation so we always have precise surfaces."
- Composition: "used the depth buffer to compose them and do automated occlusion culling of ancestor scenes."
- Edges: "store normal like bits to allow preservation of edges and curves at enhanced lod".
- Flow: "use the parent scene flow and then add or subtract to the flux at boundaries", building on steady-state
  flow that sleeps and is drawn as animation.
- Grids: child grids stay upright, "and probably wouldn't change that for terrain". Rotated frames come back only
  for buildings or instanced meshes that interact with the intervals, through the External interval mechanism.
- Patterns: "some materials define interval patterns or functions like strata or a structure with floors that
  alternate material and air at regular spacing."
- Terrain fields (from TERRAIN_RIVERS.md): "I would keep heightfields and borders distinct and use SDF with masks
  for the latter. Heightfields can be independent, additive, subtractive or multiplicative but generally we want
  details to be signed additive for lower frequencies and independent and lerped by SDF for higher frequency."

## What already exists to build on

- Interval columns. A boolean (carve, fill, melt) is a per-column interval edit, so the mesh-boolean problem of the
  earlier system does not arise.
- The terrain draw is a surface-nets mesh of a field evaluated from the intervals (ARCHITECTURE "The field mesh").
  It is a real 3D mesh, so a free camera is not blocked by the draw. Not checked: the tile cache and far tiles,
  which are built for the fixed view.
- Steady-state flow (`src/flow/steady.ts`, `src/sim/sleep.ts`): a chunk at steady state sleeps, its last flux is
  kept and drawn. A sleeping column beside an awake chunk already sums its edge inflow and outflow and wakes past a
  tolerance. The nested flow rule below is the same check, between scales.
- External intervals (`src/sim/external.ts`, `MAT.External`): an interval owned by another system, which the sims
  treat as rock and the terrain draw skips. The later route for buildings and meshes.

## The design (my mapping of the rules onto columns; to be agreed)

1. **A level is an upright column grid in its own local units.** A child covers a patch of its parent at a whole
   scale factor (proposed 8) and a whole-cell offset, so the mapping between them is exact.
2. **Promote.** child = enhance(parent) + residual. `enhance` is upsampling by height and gradient, borders by SDF,
   plus the deterministic detail function (seeded noise, expanded pattern materials). The residual starts at zero.
3. **Edit.** An edit changes the child. Then residual = child − enhance(restrict(child)), and restrict(child) is
   written to the parent, conserving volume per material. The same step repeats up every ancestor; no level is
   skipped.
4. **Parent changes.** When the parent changes under a child (a flow arrives, a slide), the child is re-derived as
   enhance(parent) + residual.
5. **Demote.** The residual is kept only where it is non-zero (where you edited). The rest regenerates.
6. **Draw.** Each level is its own scene. Finest first, composed by depth. The parent is drawn only where no child
   wrote (stencil), so a coarse surface cannot poke through. A morph band at the child's rim makes the two surfaces
   agree there.
7. **Edges.** Height carries a gradient per sample (the "normal like bits"); a cliff is two smooth heights stepped
   by an SDF, so it stays sharp at every level.
8. **Flow.** An idle child shows the parent's steady flow, enhanced, as animation. An edit wakes the child only.
   At each rim face the parent's stored flux is the inflow; the child's flux minus the parent's stored flux is
   added to the parent's rim cells (relaxed, to stop ringing). Past the wake tolerance the parent wakes. While a
   child is awake the parent cells under it take the child's restricted values and do not simulate.
9. **Pattern materials.** One interval whose material is a function of height (strata first). Coarse levels treat
   it as one material with averaged properties; `enhance` expands it. A cut keeps the pattern's phase. Damage
   rewrites the column as explicit intervals. Patterns with air (floors) come later.

## Lab steps (each small, each shown before the next)

1. One parent, one child at 8×, fixed view: promote, sculpt in the child, restrict to the parent, demote and
   promote again and get the same surface back. Unit tests for exactness (residual round trip, volume conserved).
2. Depth compose with the stencil rule and the rim morph; move the child with the camera.
3. A second level (child of the child): the "nothing skips" chain.
4. Free camera.
5. Strata as the first pattern material.
6. Flow across the rim.
7. Scatter trees; melt.

## Storage (the lab, 2026-11-18; written before the code, per the owner's rulings that night)

Rulings that night: the real path runs on the GPU (enhance, restrict, residual, promote, slide, brushes are compute
passes; the draw pulls vertices from the columns; no CPU readback on the interactive path); storage follows
DESIGN.md §1-2 with pages and no caps; f32 heights in each level's local units; a square lattice is allowed.

**Departure from DESIGN.md §1: a square lattice.** The owner allowed it ("rendering can be decoupled from storage").
Reason: a child at factor k then covers exactly k × k child columns per parent column, so restrict is a plain mean
and enhance its exact inverse on the block, with no area weights for fine cells that straddle coarse borders.
BACKLOG NS-2: hex storage, or hex-style rendering over square storage, later.

**Pages (DESIGN.md §2, followed).**
- **The record (round 6, the owner's: "get rid of the representation that allows unpaired bounds").** A column is a FULL
  PARTITION of height: an ordered list (bottom up) of intervals of any material, AIR INCLUDED, with SHARED boundaries.
  A record is two words: the interval's absolute top (f32, the level's local units) and its material. Its bottom is the
  top of the record below; the first record is open downward; above the last record is air (a trailing air record is
  never stored). Adjacent records never share a material (merged), no record is empty. There is no stored gap, no
  stored bottom, no bound that belongs to only one interval. Whether a material is drawn solid is a row of the material
  table (store.wgsl matSolid: air is not), so water or lava are new materials, not new cases.
- A column page is 16 × 16 columns × KR = 24 records (2 words each) after 256 count words (records | non-air records
  << 16): 256 + 256·24·2 = 12,544 words = 49 KB, the same size as before. Residual pages and a pass's scratch (TMP, level
  id 40 + depth) keep the solid-view record of three words (z0, z1, material), K = 16 a page, in the same page size.
- Pages are keyed (level, cx, cy, cz) in global chunk coordinates of that level's depth. cz is record overflow: records
  0-23 of a column are in cz 0, 24-47 in cz 1, and so on. A cz + 1 page exists only where some column of the chunk
  needs it. There is no cap on records a column.
- **The solid view and the pass boundary.** The maths (enhance, restrict, residuals, the brushes) reads a column's solid
  view: its non-air records, interval i from the top of the record below it (store.wgsl ivlAt), and inside enhance and
  restrict the layer form built from it. A pass writes its result as solid views into TMP pages; `pack` (nest.wgsl)
  converts each written column into the partition (air where an interval starts above the last top, empty intervals
  dropped, equal neighbours merged) and lets the TMP pages go, at the end of the pass.
- One sparse table in its own binding: an open-addressed hash of entries (key0 = cx | cy << 16, key1 = level |
  cz << 8, page, birth). Three states: page here (the page id), exists but not loaded (NOT_LOADED), no page (absent).
  Nothing in the lab evicts to a store yet, so NOT_LOADED is defined and handled by lookups (treated like a missing
  neighbour: the open interval is extrapolated) but never written. Table capacity is a build-time constant;
  inserting into a full table counts a refusal shown on the page (BACKLOG NS-3: grow the table like the pool).
- One pool of pages in one storage buffer. Pages are handed out on the GPU (a free stack, then a bump end) by the
  kernels that discover they need one (an overflowing column, a non-zero residual). Frees go to a pending list,
  merged into the free stack by the next operation (no push and pop race in one pass).

**Levels on pages.**
- A level is a set of chunks in the one pool, reached through table entries with its level id. Its residency shape
  is a chunk-aligned rectangle (the planner of the lab: centred on the focus). The level table (CPU-written uniform)
  gives each level its depth, scale k, window, z origin and parent.
- A level's window moves by whole chunks. A chunk is 16 child columns, which is 16 / k whole parent cells for
  k <= 16, so "a whole-cell offset" holds.
- **Promote** allocates the child's cz 0 pages and fills them by the enhance pass (enhance(parent) + residual); the
  pass allocates any cz + 1 pages its columns overflow into.
- **Slide** (re-centre) changes only table entries: chunks staying keep their pages untouched (keys are global), the
  leaving chunks' pages are freed, the entering chunks are allocated and derived. Loading never copies resident data.
- **Demote** frees every page of the level and keeps its residual pages.
- **Residual pages.** Level id 8 + depth. Same page shape; a column's record i holds the residual of interval i in
  layer form (record 0: the top surface; record i >= 1: the gap below interval i and its thickness). A chunk with an
  all-zero residual has no residual page, so a level with no edits keeps nothing when demoted. Residual pages live
  on the GPU in the same pool (no readback at demotion).
- **Pool full** (round 4). The pool is up to four segment buffers (as many as the device's storage-buffer limit allows:
  limit − 6), each at most the device's largest buffer; page p lives in segment p / segP (WGSL pgLoad / pgStore switch on
  it). Segments fill in order; only the last one in use grows, by a copy; a full one never moves. Ops run one at a time
  (the sandbox starts an op only after the pool's header came back from the last one), so an op's reserve is exact
  pages in use plus its own worst case. When it does not fit, the op is refused whole (it changed nothing; a held brush
  retries next frame) and a grow to what is needed is made ahead: the buffers are created in an out-of-memory error
  scope and applied (copied, rebound, the draw's page list rebuilt) at the next op once the device said yes. After each
  op the pool also grows ahead when one more op like it would not fit. Past the segments, or when the device refuses
  memory, the page says so in a sentence and such changes are not made. If a kernel still runs out it counts a refusal
  shown on the page. Data is never dropped silently. Before round 4: one buffer grown by doubling a summed worst case
  (12,288 pages reserved for 585 used); on a device whose largest buffer is 256 MB the grow threw inside the frame and
  the sandbox froze.
- **No workgroup-memory atomics (round 9, NS-86).** A workgroup's shared values (a chunk's longest column, whether a
  page exists, the face bake's triangle offsets, the camera's nearest solid) are reductions or scans over a plain
  workgroup array with one writer per word and barriers (nest.wgsl wgMax, wgMin, wgOr, wgScan), or a plain word written
  by one thread and read with workgroupUniformLoad. On the desktop's Intel Arc (D3D12) the atomic forms gave stale values
  to a share of the threads after some GPU work, and a wave that read a chunk's page count as 0 wrote nothing: root
  columns with no records, drawn by no level. Atomics on storage (the pool's counters, the table) are unchanged; the
  pool's books (Snapshot.audit) and the store stress check them. The self-test probes both forms (src/nested/hazard.ts).
- **An op's too-big refusal is the op's alone (round 9, NS-88).** Past the device's limit an op is refused and said in
  words; later grows still happen (only the device refusing memory stops them), and the line clears at the next op
  that fits. A slide reserves and bakes the parent round its old and its new footprint, each clipped to the parent's
  window. The pool's header is read after an op's last submit only (the camera's submits read nothing).
- Departures from PAGES.md (DESIGN.md wins where they differ): no 64² regions or toroidal 1024 window (a level's
  window is its own rectangle of chunks, keyed globally, so a slide needs no ring); pages are handed out on the GPU
  as in the shared pagepool, not by a CPU free list; growing the pool copies the pool buffer once (a reallocation, not
  a load: BACKLOG NS-4 for segmented pools with no copy, which is also needed past maxStorageBufferBindingSize).

**Exactness with f32 (owner's ruling).** The stored truth of a promoted level is parent + residual; the live child is
always the output of the same derive pass, so demote then promote is bit-identical on one device. After an edit,
residual = child - enhance(restrict(child)) and the child is derived again; it may differ from the edited columns by
rounding (stated tolerance: 1e-4 local units). Repeated demote and promote cycles cannot drift (100 run in the
self-test).

**The column maths (square lattice, k × k blocks).**
- A column is read in layer form: S (top surface) and, for each interval i >= 1, gap_i = z0_i - z1_(i-1) and
  thick_i = z1_i - z0_i. Interval 0 is open below. The column is rebuilt from the top down.
- Enhance, per child block (the k × k child columns of one parent column): the block takes its parent column's
  intervals (count and materials). S (round 3, PROVISIONAL, replaces the Catmull-Rom-plus-bump enhance): parent values
  are cell averages; S is a limited PPM reconstruction, dimension by dimension (along x on the five parent rows round
  the block, then along y), each child the average of the parabola over its sub-cell: mean-preserving per block by
  construction, no overshoot past the neighbouring cells at a step (Colella-Woodward edges and limiter), smooth
  hilltops kept (Colella-Sekora extremum rule, 1.25 x the neighbours' curvature). Why: the old bump restored each
  block's mean with a sin²·sin² hump of 4 x the block's deficit at its peak; at a step the deficit is large, so every
  block along a step grew a spire (NS-34). Then seeded detail (value noise in global child columns, wavelengths
  2..k/2, amplitude 0.08 x wavelength); the sin²·sin² bump now carries only the detail's block mean and rounding
  (small: the faint egg-crate of NS-16). Gaps
  and thicknesses: bilinear from the 2 × 2 nearest parent samples that have the same intervals (else the block's
  own value), then scaled per block so their mean equals the parent's (non-negative, mean exact).
- Restrict: the parent column's S is the mean of its block's S, its gaps and thicknesses the block means (in parent
  units). Per-material volume is conserved by construction. A block whose children disagree on intervals (count or
  materials) is counted as a mismatch and left alone; no edit in the lab makes one (BACKLOG NS-5: matching columns
  of different structure).
- Zero-thickness intervals are dropped (round 6: the partition has no empty record); a dig that empties an interval
  changes the column's structure, and the correspondence rules below (template restrict, whole-column residuals) carry
  it. (Before round 6 they were kept so neighbouring columns kept matching structures: NS-6, now moot.)

## Decisions with the owner (2026-11-18, round 2)

- The lab must not behave like a heightmap: carve tunnels, add overhangs and blobs, see and sculpt them.
- **Draw = layered sheets, not surface nets.** Owner: "I think surface nets kill some of the cheapness of columns."
  Each solid layer has a top and a bottom sheet; owner: "I think sheets will not usually touch and we will need to
  mesh the boundary of solid against air but I think that's fairly easy." So the solid/air boundary is closed with
  vertical strips where a layer ends between columns. All on the GPU.
- Stretching on steep faces and strips: owner: "triplanar mapping may resolve those". Not this round: SDF
  footprint masks for crisp layer edges (BACKLOG NS-18), surface nets, strata, flow, hex.
- Mixed blocks (the parent copies the most-structured child): owner: "I think this is fine for now but we will have
  to reconsider based on visual quality when zooming in and out." (BACKLOG NS-28: judge it in zoom in/out stills.)
- A layer ending in a straight wall half-way between columns is fine until SDF footprints: owner: "let's wait for SDF
  and then we can have nicer material boundaries at zoom."
- **Camera, provisional (the coordinator's choice, a question for the owner): a free eye with collision.** Drag, keys
  and pinch move the eye itself; Turn looks round it; there is no orbit target. The eye is never inside solid on any
  level; it can enter a tunnel or go under an overhang; its speed is limited by the distance to the nearest solid in
  any direction, and promotion and demotion use that distance.

## Decisions with the owner (2026-11-18, round 3)

- **The draw is baked, nothing per frame.** Owner: "it should be deforming vertices and baking the seam mesh nothing
  per frame". The solid/air faces (B) and the top sheet's split are baked on the GPU when columns change, per changed
  chunk; a frame with no change only draws. Sheets stay vertex-pulled grids deformed by the stored heights; the rim
  morph and fade are per-vertex deformations driven by a uniform (time), never a re-bake. See "The baked draw".
- **Streaming ahead.** Owner: "it seems like it can happen ahead of time with hysteresis so that we never have to
  wait. If we stream detail ahead of what is currently in view it doesn't need to interpolate while off screen and can
  pop in."
- **Page shape 32 x 32 x 4** (columns x columns x intervals a page, stacked pages where the intervals justify it) is the
  agreed direction (owner: "I think that's fine"; BACKLOG NS-37), not built yet.
- **Verticality later, not now.** For places with much verticality and many stacked intervals the owner expects one of
  two later routes: "a. Have materials with function driven internal boundaries b. Introduce an orthogonal column grid
  for the vertical surface (like the baked seam joiners)". "Neither makes sense to do prematurely and both could slot in
  I believe." Nothing here may block either: (a) is the pattern materials of design point 9; (b) a second, sideways
  column grid owning a cliff face, in the spirit of DESIGN.md section 3's many grids.

## Decisions with the owner (2026-11-18, round 4)

- Holes seen on the phone (Pixel 9a): "I also saw holes on the phone so verify water tight. It did carve and add fast
  so that might have been the issue if it ran out some buffer." Watertightness is checked standing (manifold check of the
  baked mesh, screen check from many poses, a stress run at a phone-like buffer limit).
- Brushes: "I might have carve only carve from the surface at touch and then slowly grow in size as you hold it." And:
  "I would sweep the carve along a trajectory of the original uncarved surface so you carve one layer at a time." During
  one stroke the ball's centre rides the surface as it was when the stroke began, so a drag removes (or, for Add, lays)
  one even layer; going over the same spot again in the stroke changes nothing more; a new stroke starts from the new
  surface.
- Order: SDF footprints, then streaming. Borders: "I would keep heightfields and borders distinct and use SDF with
  masks for the latter."

## Decisions with the owner (round 6)

After five rounds failed to make matched sheets and SDF footprints watertight (8,215 open edges, 5,920 hole pixels,
curtains joining wrong layers, carve 124-138 ms, draw 28.9 ms, 455-553 MB reserved), the owner, verbatim:
- "I would rather use blocky voxel columns than waste time on this visual artifact."
- "Why not just do the same but with voxels of varying sizes so there is never any meshing ambiguity at all?"
- "Definitely don't give me something with crappy performance that still has holes."
- "Stop I already said get rid of the representation that allows unpaired bounds." (Earlier: "Air is meant to be the
  default but also an interval." / "I was confused why there was a gap since they should use the same z value in my
  head canon.")
- "Fast and water tight and verify we can zoom in and enhance detail. Then we can have unit tests and do the smooth
  meshing as an optional next step."
- Not to block: "I hope you know my plan is to have this with the full fluid simulation so I can zoom in on steady flows
  and have water falls and magma." And: "I also ideally want to be able to keep the multi grid representation so I can
  make islands in their own reference frame floating by. The enhancement only need to happen for nearby objects so we can
  do this for whatever the active reference frame(s) grids are only."
- PARKED, for the record (what he had imagined for smooth meshing; not built): "a sheet with one vertex per cell and one
  sheet per layer adjacent to an air interval. Then for any solid interval adjacent to air laterally we mesh between the
  top and bottom vertex in the interval and connect to neighbors. This may need a marching squares type approach to
  handle edge cases like things touching at a single point although I would prefer something with a signed distance and
  contour."

So:
- **Every level draws its columns as boxes** ("The box draw" below): a face exists exactly where a solid interval
  touches an air interval, vertically at their shared bound (a cap) or laterally where a solid interval of one column
  overlaps in height an air interval of the neighbouring column (a wall over the overlap). No pairing or matching of
  bounds between columns anywhere in the draw. Finer levels are smaller boxes. Watertight because it is the boundary of a
  union of boxes.
- **The column record is the full partition** ("Storage"), built now rather than with the 32 x 32 x 4 pages.
- Brushes are material writes over a z-span: Carve writes air over the ball's span in each column, Add soil; equal
  neighbours merge, so repeated adds cannot pile up intervals (NS-63). Raise, Dig, Melt move tops.
- Fluids are not built and not blocked: water and lava are materials in the record; the draw asks only the material
  table whether a material is drawn solid. The flow point of "The design" (8) stands.
- More grids are not built and not blocked. Where a second grid plugs in: the level table (nest.ts wins, the WGSL
  u.lv) would gain a grid id and each root grid a rigid transform; the draw already takes a model matrix per draw call
  (draw.wgsl DrawU.model, identity today) between a level's local units and the frame the camera's per-level
  view-projection expects. Still missing for that: page keys carry no grid id (key1 = level | cz << 8 would take one;
  level ids would be per grid), the camera pass and the pick assume one chain of levels over one root at the origin, and
  promotion is per depth, not per (grid, depth).

## A write clears what finer levels kept under it (round 10)

The owner (phone, round 9 build): "I am seeing some artifact like floating columns at higher resolutions when I zoom in
which I would not expect since I expect boolean deletion to delete parents and all children in those sub cells".

- **The rule.** A carve or add at level d rewrites the columns its ball covers; every finer level's residual under those
  columns, live or dropped, is let go (nest.wgsl resClear, the oracle's edit), so there each finer level is enhance(its
  parent) again. A finer edit's blob, roof or layer cannot come back over the new parent, at the derive that follows the
  edit (live levels) or at a later promote (dropped ones). The model stands: child = enhance(parent) + residual; the
  residual is cleared, not re-applied. Raise, Dig and Melt (moves, not material writes) keep the residuals riding.
- **Enhance's top between same-structure cells only.** Derive's top surface (the limited PPM) takes a neighbour of
  another structure at the block's own top, as the gaps and thicknesses always did ("Column correspondence": enhance
  interpolates between same-structure neighbours only). Before, a thin cave roof beside the column where the ball broke
  through followed the top down to the cave's floor, each child a step lower than its neighbour by more than the roof was
  thick: a staircase of floating pieces. Trade-off: a step of one parent cell, flat per block, at a structure boundary
  (BACKLOG NS-93).
- Checked by `?selftest=1` (src/nested/carves.ts): no finer record wholly in its parent's air, no solid in a carved ball
  at any finer level, no new floater on a finer level; a skin held by less than the enhance's detail reach is reported
  apart (NS-92).

## Decisions with the owner (round 7)

After round 6 on the phone (16.7 ms frames, dig fast, promotes at most a frame), verbatim:
- "a dig tool size slider that is relative to the current camera distance from the nearest surface so click is instant
  and so I can dig deeper by clicking repeatedly". Built: hold-to-grow is gone; Size (2 % to 100 % of dNear, log) sets
  the radius, shown in metres; a tap is the whole ball at once on the surface under the finger; the radius is fixed at
  the stroke's start; a drag still sweeps the pre-stroke snapshot; Raise, Dig, Melt take the same radius; under one
  column of the finest live level the page says so.
- Move along the aim: Fwd and Back hold buttons (R and V), speed by the nearest distance, collided as any move.
- Cruise: flies the heading over the ground at the height it had when switched on (on the GPU, no readback); speed in
  finest-live-window widths a second (0.05 to 4), held in world units through promotes and demotes; drag turns; a readout
  for the phone (slides, promotes, demotes a second; ops waiting; pool used / reserved; worst frame in 2 s).
- "the enhancement does not seem to quite get histerisis right so I wonder if it either doesn't have a band or if it is
  built against one level of detail then transitions to the other when it loads?" Measured (DEVLOG round 7): the zoom
  band was sound (0 flips); sideways there was none (a window snapped to a focus led only along the view, so each
  slide's strip popped inside the central view); a child is derived from its parent's current content, but clamped
  inside a lagging parent. The agreed policy: windows lead the travel with hysteresis, new strips built off screen where
  possible and may pop in (no fade), ops spread over frames, the zoom band kept or widened if it flips.

## Streaming (round 7, as built)

- **Levels belong to a grid.** A level's window is a rectangle of whole chunks of its grid (one root grid today); the
  policy works per level of a grid's chain on the eye in that grid's frame, so a second grid's chain would run it too.
- **Lead.** Level m's window centres on the eye plus a lead: toward what the view looks at (up to 0.2 W) plus the eye's
  velocity over the ground x 0.6 s, at most 0.4 W in all (the eye 0.1 W inside the rear edge). W: the window's width.
- **Slide band.** A window slides when its target is 32 columns away along the travel, or 64 against it or with no
  travel; a slide goes all the way to the target (whole chunks). A jittering focus (low pitch, the centre ray's hit
  jumping) makes no back-and-forth.
- **Zoom band.** Promote under 0.45 W at once; demote over 0.6 W held for 0.5 s (a fast cruise over a drop flipped a
  level otherwise).
- **One level op a frame**, and only once the pool's header came back from the last op (as before). A child's window is
  clamped inside its parent's; the parent leads by the same rule at 8 x the scale, so it does not hold the child back.
- **Pop-in, no fade.** Strips enter at the window's front rim, 0.6-0.9 W ahead of the eye; a forward view sees them
  there (NS-74). Coarse (a parent drawn nearer the eye than its child's promote distance, in the central half of the view)
  stayed 0 in cruises up to 4 w/s.
- **The pool gives pages back** (NS-67): when it holds over 256 pages more than a shrink would leave (1.25 x used, room for
  one more op like the last, 64 rounded), pages in use above a lower cap move under it on the GPU, 256 a step, 4 steps a
  second between ops; then the buffers are made again at the cap's size.

## Column correspondence (round 2; the Storage section's rules extended)

PARKED for the draw (round 6): the draw no longer matches anything between columns; the rules below are kept only for
the data across levels (restrict's template, whole-column residuals), which promote and demote exactness still need. The
last bullet ("For the draw") is obsolete.

- **Structure** = a column's interval count and material sequence. Gaps (air between intervals) are not part of it:
  a tunnel cut inside one layer, or a dig, keeps the structure, so per-bound residuals and the bound-mean restrict
  handle it.
- **Same structure** (neighbours, or a block's children): intervals correspond by index. Enhance interpolates
  between same-structure neighbours only; restrict averages each bound.
- **A block of mixed structures** (a carve split an interval, an add made a new one): restrict takes the TEMPLATE,
  the child with the most intervals (the first on a tie), and scales its thicknesses per material and its gaps so
  the parent holds the block's mean surface, mean volume of every material and mean enclosed air. A material the
  template lacks has nowhere to go (NS-20). This replaces NS-5's "mismatch, left alone".
- **A child whose structure differs from its enhanced parent** carries a WHOLE-COLUMN residual: its own intervals
  and materials, each bound as two floats relative to the enhanced top surface. It rides on parent changes under
  it, but its layers do not follow the parent's thickness changes. A per-bound residual whose length no longer fits
  the enhanced structure no longer applies (NS-19).
- **Tunnels merging or splitting a layer** need no special rule in storage: they change some columns' structures;
  those columns carry whole residuals and their blocks restrict by the template rule.
- **For the draw** a column is its air regions (gaps) from the top: the sky above the top, then the air between
  solid runs. Two neighbours' gaps correspond when each is the other's nearest-floor gap among those overlapping it
  in z (mutual nearest). The ground outside an overhang meets the floor under it, not its roof; a tunnel's air meets
  no air in a solid neighbour.

## Built so far (branch `nested-scales`, page nested.html)

Round 7 (2026-11-19): the controls and streaming in "Decisions with the owner (round 7)" and "Streaming"; checks added:
scripts/nested-brush.mjs (taps), nested-controls.mjs (phone size), nested-stream.mjs with src/nested/stream.ts (cruises
and zooms: coarse, pops, flips, slides), a cruise pass in the screen check, a cruise loop in nested-stress.mjs.

The current truth (round 6, 2026-11-18):
- **Storage:** paged columns on the GPU, the full-partition record ("Storage"); the oracle (src/nested/oracle.ts) stores
  the same partition (Level.parts) and reads the solid view from it. One pool of up to four segment buffers, grown ahead
  of the ops; one op in flight; each op's reserve is what it can take (its chunks' extra column, residual and face pages,
  a stroke's snapshot, and the largest pass's scratch, merged back between passes), and a grow is sized only once the ops
  in flight have read back. The table's tombstones are cleared at the end of every op.
- **Levels:** root 256 x 256 at k = 8 per level, up to three child levels of 256 x 256 columns; promote = enhance
  (limited PPM top, bilinear gaps and thicknesses, seeded detail) + residual; restrict by bound means or the template
  rule; residuals per bound as two floats or whole columns; demote then promote bit-identical.
- **Brushes:** Carve and Add are a ball's (or a stroke's capsule's) z-span per column, written in the solid view and
  packed: Carve leaves air, Add soil, equal neighbours merge. Hold to grow, the sweep along the pre-stroke surface (the
  stroke's snapshot), one op in flight. Raise, Dig, Melt as before. The pick and the free eye read the solid view; the
  eye's distance is to the column's own boxes (no dilation).
- **Draw:** the box draw ("The box draw"), baked per changed chunk, one indirect draw a level, finest first.
- **Checks:** unit tests (oracle, 13), `?selftest=1` (25 GPU-against-oracle checks, then the watertight suite on the
  sandbox scene: the manifold check at 8 eyes and the screen check over 40 poses; src/nested/suite.ts),
  scripts/nested-watertight.mjs (the suite alone), nested-stress.mjs (?maxbuf=128), nested-perf.mjs (the gate's timings).

History (rounds 1-4; superseded where the above differs):

- Step 1 (2026-11-18): the oracle (src/nested/oracle.ts, 8 Node tests) and the GPU store and passes
  (src/nested/gpu/: store.wgsl readers, nest.wgsl root, derive, residual, restrict, plan, raise, dig, melt, release,
  merge; nest.ts the driver). `nested.html?selftest=1` runs 20 checks on the GPU against the oracle: all pass
  (DEVLOG 2026-11-18). The z origin of a level is picked where it is promoted somewhere new and kept otherwise.
- Steps 2-3 (2026-11-18): the sandbox (src/nested/app.ts, render.ts, gpu/draw.wgsl). A camera pass on the GPU makes
  each level's view-projection in its own units (target x, y as hi + lo floats from the CPU; the ground under the
  target and the eye found on the finest level holding it; the eye kept above the ground). Each level is one grid
  whose vertex shader pulls its columns from the pages. Finest first, reverse-Z depth; a parent discards fragments
  inside its child's footprint inset by 0.75 child columns; a child's rim band (one parent cell) and its fade-in
  (0.4 s from the page's birth, kept in the table entry) blend toward the parent's own triangles and normals. A
  pick pass marches the pointer's ray over each level, finest first; the plan pass takes it from there. Levels open
  by distance (promote under 0.45 of the child window's width, close over 0.6) and follow the focus by whole
  chunks with a chunk of slack. Depth 2 and 3 are the same code (0.63 cm columns at depth 3, k = 8).
- Detail: wavelengths 2..k/2 child columns, amplitude 0.08 x wavelength. With wavelength k the block-mean
  correction showed as regular pits (it peaks at 4x a block's mean).
- Step 4 (2026-11-18): free camera (Turn mode or right drag orbits, pitch 0.12-1.5; WASD flies, Q/E down and up;
  speed and zoom limited by the distance to the ground; the eye kept above the ground on the GPU). `?fly=1` runs
  an op benchmark and the fly-through (DEVLOG). Two design-level fixes came out of it:
  - **Residuals are per bound and two floats.** A residual is (hi, lo) for each z0 and z1, with (e + hi) + lo ==
    live exactly, so deriving a level reproduces its live columns bit for bit. One float cannot (when live's ulp is
    finer than e's). Per-bound residuals also keep a dug-out layer at zero thickness when its parent rises (NS-8
    eased).
  - **At and above the edited level, live columns stay; only residuals are recomputed** (design point 3, as
    written). Below, live columns follow their parent over the enhance support. Re-deriving the levels above too
    made the next level's region its whole window (an edit at depth 2: 104 ms; now 6.8 ms).
- Round 2 (2026-11-18): Carve and Add (a ball at the pointer's 3D hit, on any level; nest.wgsl `ball`), the mixed
  restrict and whole-column residuals (oracle and GPU, "Column correspondence" above), and the draw of the
  solid/air boundary:
  - A: the top sheet, a quad of six pulled vertices, dropped where the corners' skies do not mutually correspond.
  - B: for quads a GPU scan lists (a corner with more than one gap), an indirect draw: per anchor corner and gap,
    floors and ceilings where the triangle's corners share the gap, cut half way to a corner that lacks it
    (marching triangles), and a wall along the cut (an enclosed gap: floor to ceiling, facing the air; the sky:
    down the solid run, facing out). Flat-shaded faces; colour by material.
  - The pick is the first solid along the ray (every interval). The camera's target follows the floor nearest it
    (into a tunnel's floor); the eye stops short of the first solid between target and eye.
  - Not yet: the rim morph and fade for B's faces (only the top sheet morphs: NS-21); triplanar texture (colours
    are flat per material, so nothing stretches, but nothing shows texture either).
- Round 2b step 1 (2026-11-18): the free eye (nest.wgsl `camera`). The eye lives on the GPU (hi + lo floats). Each
  frame the pass measures the nearest solid on every level holding the eye (24 columns each way; a column's intervals
  as boxes dilated to the 2 x 2 columns between neighbouring centres, which contain the drawn sheets where a layer's
  parts in neighbouring columns overlap in z: NS-24); the finest level that finds solid gives the distance, finer
  ones bound it from below. The wished move is limited to (nearest - margin) a frame and 4 x nearest a second; a
  placement or edit that leaves the eye in solid lifts it to the air above (counted). Near plane: half the nearest
  distance. A 128-byte report (eye, nearest, the centre ray's hit) is read back asynchronously, never awaited; the
  CPU's windows follow the reported eye and open or close levels by the nearest distance.
- Round 2b step 2 (2026-11-18): the top sheet is an indexed grid (one vertex a column; a per-quad triangle mask from
  the scan, discarded in the fragment stage). B's floors, ceilings and wall ends morph in z toward the parent's
  matching bound in the rim band and fade in (the wall's place does not morph: a thin lip ring at a rim crossing).
  A triplanar pattern in world units on every face. Gaps under a quarter column are drawn as solid (a finer tunnel's
  mean air). Each window centres ahead of the eye along the view by up to a quarter window. Open: spires from the
  block-mean bump (NS-34), slow frames beside carved blobs at depth 2 (NS-32), repeated lifts at one mouth (NS-36).

- Round 3 step 1 (2026-11-18): the baked draw (below). The three blob views went from 270-335 ms of uncapped draw to
  6-7.5 ms (vsync everywhere); a frame with no change runs no compute for the draw.
- Round 3 step 3 (2026-11-18): the top surface's enhance is a limited, mean-preserving PPM (provisional; "The column
  maths"). The regular spires on the depth-2 tunnel floor and under a root-scale add are gone.
- Round 4 step 1 (2026-11-18): the segmented pool that grows by need ahead of the ops ("Storage", Pool full), one op
  in flight, `?maxbuf=<MB>` to clamp the device's buffers, the device's limits and the pool on the page; the near plane
  no longer follows the measured nearest solid; the watertight checks (scripts/nested-watertight.mjs; NS-46) and the
  stress run (scripts/nested-stress.mjs).
- Round 4 step 2 (2026-11-18): strokes for Carve and Add. Press: a ball of 6 px radius at the touched surface point;
  held still it grows 40 px a second, up to 0.15 of the distance to the surface in the screen's centre (a ring round the
  finger and the radius in the info line); a drag sweeps it at its size. A stroke's edits sweep a capsule from the last
  centre to this one (nest.wgsl ballSpan; a fast drag leaves no gaps) and their pick reads a snapshot of the surface as it
  was when the stroke began: the first time an edit of the stroke is about to change a chunk (the brushed, restricted
  and derived regions, every level), its column pages are copied to level id 32 + depth (nest.wgsl snap: copy on write,
  from the one pool, no cap); the pick (solidDist) reads the copy where it exists; the stroke's end lets the copies go.
  So a drag removes or lays one even layer and going over it again changes nothing; the next stroke starts from the new
  surface. Levels hold still during a stroke (no promote, slide or demote: a new level would have no snapshot). At most
  one op in flight (step 1); an edit only when the ball grew or moved. A stroke that crosses a level rim: the pick takes
  the finest level whose interior it lands in, each level against its own snapshot; when the hit moves to another level
  the last centre is carried into that level's units and the capsule is swept there (at that level's resolution; the
  coarser level's part of the stroke is a coarser layer). Raise, Dig and Melt keep their per-frame edits, now one op in
  flight.
- Round 4 step 3, F1-F3 (2026-11-18): footprints in the columns ("Footprints"): eS / eG per interval in the oracle and
  in the GPU record's fourth word (two f16; pages 65 KB), through enhance, restrict and the residual; ghosts; every
  reader ghost-aware; the ball brushes write the analytic distances and a ring of ghosts, one structural decision a
  brush. The draw still cuts half way (F4 next).
- Round 4 step 3, F4 (2026-11-18): the slab draw (above, "Changes made while building (F4)"): open edges 17,170 -> 8,215,
  hole pixels 7,372 -> 5,920 over the watertight scenes; not zero (NS-46, NS-55..57). `?cut=old` for comparison. F5 (the
  rim morph of e) not built.

## The box draw (round 6)

- **Faces.** For each drawn column and each record boundary where one side is solid and the other air: a cap (two
  triangles over the column's square). For each of the four sides: each solid record's height range less the
  neighbouring column's solid records (an interval set difference local to that edge), each remaining piece a wall. A
  column outside its level's window, or under a live child's footprint, is air to its neighbours, so a level walls its
  own window edge and the footprint, and parent and child boxes meet on whole parent cells (k x k children per parent
  column, whole-cell offsets): no morph, no cut. A parent bakes nothing under its child.
- **No T-junctions.** Each wall is a strip between its two vertical edges; each vertical edge is split at every record
  top (and bottom) of the four columns round that corner line, the same set for every face touching the line, so every
  edge of the face set is shared by an even number of triangles (a box union can share an edge among four).
- **The world's bottom (rounds 6-7; SUPERSEDED in round 8, next bullet).** A column's first record is open below; the draw ends it at the level's open bottom (root -8,
  a child -2 x its window width, local units) or 1 under its top where that is lower (then with a down cap). No cap is
  drawn on the bottom plane; its edges are the one boundary a level has.
- **Round 8: no world bottom; each column's own depth (replaces the bullet above).** The bug (owner, round 7 build,
  digging with the size slider): "when I looked back out I saw only the sky and not the lower detail terrain ... I did see
  this when digging down and I would expect to never see open sky that direction." The rule: the world is stone below
  and open-ended, so no ray from air may reach clear colour through the ground. A face exists only where solid touches
  air, and below the lowest air a column's neighbours can show it, all four sides are solid, so nothing there needs
  drawing. A drawn column's box therefore ends at its own depth, `zb = min(its first record's top, the depth of each
  of its four neighbours as seen from it) - 1`, closed by a down cap there (no fixed plane, no exempt edges: the
  manifold check counts every edge). A neighbour's depth is its first record's top; across a level's rim it comes from
  the level that draws there: outside a child's window, the parent's column ((top - z origin) x k); under a child's
  footprint, the k child columns along the shared side (the lowest, / k + z origin). So at a rim the two levels' walls
  reach as deep as the air on either side, at any dig depth. Since a column's bottom depends on its neighbours (and the
  corner lines' splits on the bottoms round them), a bake covers the changed columns grown by two, and a rim's bake
  reads the other level's columns. The bottom is put on a lattice of 8 units (floor((min - 1) / 8) x 8) so that
  neighbouring columns mostly share it: no walls between them under the ground, two triangles a column for the down cap.
  Cause, measured (round 8, scripts/nested-pit.mjs): a shaft carved at level 1 down to -24 world across level 1's rim
  showed 494,068 sky pixels looking down (37,135 after it settled) through the slot under the root's neighbouring columns,
  which ended at -8; one inside level 1's window, under level 2 (whose bottom was -8 world under its z origin), 994. Pits
  dug by taps and followed with Fwd to -1 world never got under a bottom and showed none. It predates round 7: the
  bottoms are round 6's; round 7's size slider only made digging that deep easy. The owner's hint ("it filled in when I
  got close") fits: closer, a finer level opens or slides over the spot, and its bottom was deeper in world units (a
  child's -2 x 256 of its own columns).
- **Round 9 (NS-83): fewer down caps.** A down cap is never seen (under it the ground is solid on every side); it only
  closes the box. Where a whole chunk, or a 4 x 4 block of it, has every column drawn with a solid first record and one
  bottom, its first column bakes one fan for it (face kind 6: one z, three points in chunk units): a centre and every
  column corner along the rim, so each rim edge is one column long as the walls and neighbouring caps there have it (no
  T-junction; the manifold check holds with nothing exempt): 64 triangles a chunk instead of 512, 16 a block instead of
  32. Other columns keep their own two triangles. The bottom lattice went from 8 to 32 units so that most chunks share one
  bottom (walls under the ground between different bottoms cost the same triangles at any depth). The flags are the
  chunk's own (bFill), and a bake is whole chunks, so no other chunk depends on them.
- **Baked, nothing per frame** (the owner's round 3 ruling stands). An op bakes the columns it changed grown by one
  column, as whole chunks (nest.wgsl faceBake via dilate): edit, restrict and derive regions; promote the child's window
  and, in the same submit, the parent round the footprint; demote the parent round the old footprint; slide the entering
  chunks, then the new window's edge ring and the parent round the old and new footprints. A frame only draws.
- **Face pages** (level id 16 + depth, stacked by cz as needed, from the one pool; no cap): a triangle is 4 words (the
  column in the chunk, face kind, material, each vertex's corner; its three z), 3,135 a page. The bake counts each
  column's triangles, sizes the chunk's pages (ensurePages), then writes; the workgroup copies the 18 x 18 columns' counts,
  bottoms and first four records into workgroup memory first. The draw is one indirect draw a level over its face page
  list (an instance a page, 3 x 3,135 vertices; slots past the page's count dropped).
- **Shading.** Flat face normals; colour by material (soil tops green, soil walls brown), the triplanar pattern in world
  units, the level tint toggle. No smoothed normals (the optional toggle was not built).
- **Round 11 (NS-97): rim lines, one vertex arithmetic for both levels.** The owner: "Water tight is the more important
  requirement." The one hole pixel of rounds 9-10 was a pixel centre on a vertical line of a level rim where a wall
  crossed the rim (a shaft's wall, coplanar on both sides: the parent's part ending at the footprint, the child's part
  ending at its window edge). Each level was closed by itself, but along that line the two levels' edges had different
  end points (each level split the line at its own breakpoints) and were placed by different arithmetic (each level's
  local units through its own view-projection), so a centre exactly on the line could fall outside both: a crack between
  levels, invisible to the per-level manifold check. Measured with watertight.ts rayDiag (a float64 cast of the pixel's
  ray against every level's captured triangles): the hit sat 0.0015 px outside the parent's edge and 0.0015 px inside the
  child's. **The rule now:** a rim line is a parent corner line on the boundary of its live child's footprint (the child
  draws it too). On a rim line every face of both levels has a vertex at every breakpoint of both levels' columns round
  the line (nest.wgsl nextBpRim: the child's record tops and bottoms and the parent's, converted), every height there is
  in the CHILD's units (toKid: (z - z origin) x k, the one conversion both bakes use), and the draw places those vertices
  through the child's view-projection by the same expression the child uses for its own (draw.wgsl placeCorner; the
  parent's face word flags them, bits 25-27), then scales the clip position by 1 / k (exact for k a power of two, so its
  point on screen is bit-identical and its w the parent's). So along a rim line both levels' edges are the same segments
  with bit-identical end points, as inside one level. The parent's down-cap fans skip blocks that touch a rim line (their
  one z cannot hold per-vertex units). Each level is still closed by itself (it walls its own window edge and its child's
  footprint). Checked by watertight.ts rimJunctions (no vertex of one level inside a vertical edge of the other on a rim
  line, no parent vertex there in its own units) in the suite's manifold eyes and the shaft poses.
- **Round 12 (NS-103): rim chunks pay for the rim rule, others do not.** The bake is two pipelines of one entry point
  (nest.wgsl override BAKE_RIM): a chunk any of whose corner lines is a rim line (chunkRim) is baked with the rule, every
  other chunk by the same code with the rim code compiled out. Both run over every bake slot and skip the other's chunks.
  An edit's regions on one level (edit, derive, restrict into it) are baked as one union of chunks (dilate takes up to
  three slots).
- **Not covered by the rule (BACKLOG NS-98):** horizontal edges along the rim (a parent cap's edge spans k child columns;
  the child's caps meet it per column) and the child's corner lines on its window edge between parent lines. These can
  only crack where the two levels' heights there are exactly equal (collinear edges of different spans); not seen.

## The smooth draw (agreed 2026-11-19)

The owner: "we want some sdf based or normal based smoothing though so we can have rims and carves not look stepped but
also preserve sharp edges." Thin features softening is accepted.

- **Principle.** The smooth mesh is the box mesh with its vertices moved. Topology comes from the box rule (a face only
  where solid touches air); moving vertices never opens a mesh, so it is closed by construction. No pairing of bounds
  between columns, no marching cases.
- **Vertex identity.** Every box vertex sits on a corner line (shared by four columns) at a record bound. A placement maps
  each vertex identity to a 3D position; faces that share an identity get the identical position. Identities of one corner
  line that a placement puts at the same point become one vertex, and the triangles left with a repeated vertex are
  dropped (zero-area triangles from collapsing vertices). This is a simplicial map, which carries a closed surface (every
  edge used an even number of times, every directed edge cancelled) to a closed surface: no special case can open it.
  With vertical moves only, a triangle has zero area exactly when two of its vertices merged (caps have three corner
  lines, wall strips two parallel lines), so "drop zero-area" and "drop repeated vertex" are the same rule.
- **The identity, as built (round 11, src/nested/boxmesh.ts):** (level, corner line in that level's global columns,
  bound) where the bound is the exact height value on that line. Not (column, record): two columns round a line with an
  equal top must give one vertex, or the faces of the line would not share it. The corner line's split rule (every face
  touching the line has a vertex at every record top and bottom of the four columns round it) makes every face at that
  height use that one identity.
- **At a level rim (round 11's answer).** On a rim line (a parent corner line on the child's footprint boundary) the
  identity is the CHILD's: (child level, child corner line, height in the child's units), for the parent's faces too (the
  rule of "The box draw", round 11). So the parent's and the child's faces share vertices there, and one placement moves
  them for both: the two levels' smooth surfaces meet exactly on rim lines. Each level is still closed by itself (it walls
  its own window edge and its child's footprint), so its smooth mesh is closed by itself. Between rim lines (the child's
  corner lines on its window edge that are not parent lines, the parent's cap edges spanning k child columns) the two
  levels do not share vertices: there the smooth rim shows a step (accepted for step 1; each level's rim walls close it).
- **Placements of step 1** (src/nested/boxmesh.ts): identity (the boxes); collapse (vertices on a corner line joined by
  vertical edges shorter than T, default 2 columns, merge to their mean height); random (a seeded displacement inside the
  cell neighbourhood, only to prove the principle). Later steps, not now: placement by a dual-contouring plane fit from one
  stored word a record (16-bit normal + 16-bit signed distance, written by the terrain function and brushes, interpolated
  by enhance), the vertex clamped to its cell neighbourhood, crease-angle shading; the GPU bake behind a switch; Phong
  enhancement.
- **Round 12 (reference only; the GPU bake is deferred while its design is revised with the owner).**
  - *Collapse from the columns.* A vertex's cluster needs no mesh: its corner line's columns (its level's four; on a rim
    line also the parent's four, heights through toKid) give the breakpoints (every record top and bottom), and the
    segment above a breakpoint is an edge exactly when one level's four columns are not all solid or all air just above
    it (below a column's bottom and where it is not drawn: air). A cluster is the chain of such segments shorter than T;
    its height the f32 mean of its breakpoints summed bottom up (boxmesh.ts mesh.cluster, collapseCols; equal to the
    mesh-based collapse on every unit-test scene).
  - *Coincident cap pairs are dropped.* A thin layer that collapses flat leaves its top and bottom cap triangles on the
    same three vertices facing opposite ways (z-fighting). Only caps of one column can coincide (walls of a half-edge
    never do: a wall triangle's two same-line vertices lie in one strip piece). Per column and cap triangle, the caps on
    the same three vertices are a run of consecutive caps, alternating up and down; they are dropped in pairs from the
    bottom, the top one kept where the run is odd. Per cap: kept iff no cap of its run is above it and an even number
    are below (the run is the caps within the cluster bounds of its three corners). Each dropped pair's edges cancel, so
    the mesh stays exactly closed. A column whose down cap the GPU bakes as a fan (NS-83) keeps its down cap out of the
    runs. (boxmesh.ts dropCapPairs; NS-102, NS-104.)

## The smooth draw: template, cache, exceptions (round 13; written before the GPU code)

The owner's rulings this is built on: "Water tight is the more important requirement." / "Definitely don't give me
something with crappy performance that still has holes." (round 6). Round 3: "it should be deforming vertices and baking
the seam mesh nothing per frame". 2026-11-19, on why a carve costs milliseconds: "Do we really build the mesh or just take
an already present mesh with masked triangle bits and then set their heights to the grid? Those both seem very cheap"
(the lab rebuilt face lists per chunk on every edit, which drifted from his rule; this section corrects that for the
smooth draw). And: "we want some sdf based or normal based smoothing though so we can have rims and carves not look
stepped but also preserve sharp edges" (the stored plane word and the plane fit are the next round; nothing here bakes a
height into topology: a vertex's position is a vec3 read from a per-vertex cache).

The principle of "The smooth draw" is unchanged: the smooth mesh is the box mesh with its vertices moved by the collapse
(collapseCols), triangles with a repeated vertex not drawn, coincident cap pairs dropped (dropCapPairs). New: how it
reaches the screen. The surface splits into a FIXED TEMPLATE (the same for every chunk of every level, never rebuilt)
whose vertices read a VERTEX CACHE, plus EXCEPTIONS baked as face lists by the box rule.

**Rules (decided by the reference, src/nested/boxmesh.ts smoothCache, templateMask, templateTris, smoothSplit).**
- *Simple column:* drawn by its level, every record solid (no air record: its only solid/air boundary is its top). Any
  materials, fluids included (a material is drawn solid by the material table).
- *Vertex cache:* per corner line (CX, CY) of a level, four slots, slot q = column (CX - 1 + (q & 1), CY - 1 + (q >> 1))
  (boxmesh.ts slotOf). A slot holds that column's last record top (`raw`, the vertex identity's height; NONE = -3e38 where
  the level does not draw the column), its placed position (this round (CX, CY, cluster z); a vec3 so the next round's
  plane fit can move x and y) and the bottom of its cluster. The placement is the general collapseCols rule (the line's
  four columns, on a child's rim line also the parent's four), so slots next to complex columns and on rim lines are right
  too. One slot a column because a cliff taller than T keeps separate vertices; slots with equal raw heights are one
  identity and get bit-identical positions (same function of the same inputs).
- *Template mask (one word a column):* `cap` iff the column is simple, none of its four corner lines is a rim line (rimP
  or rimC), and on every corner its top's cluster stays above its own bottom zb (else its up and down caps may coincide
  and the pair rule decides: exception). `w[dir]` for the edges +x (dir 0) and +y (dir 1) iff both columns are simple,
  neither corner line of the edge is a rim line, and on both lines every breakpoint strictly between the two tops is the
  last top of one of the line's four columns (no other record boundary, no bottom zb in that range). Plus the column's top
  material. Owner of an edge: the column on its low side.
- *Template, per column 14 triangles (TEMPLATE_TRIS), most degenerate:* part 0 the top cap (corners (c0, c1, c3) and (c0,
  c3, c2) at the column's slot on each corner line, up); parts 1-6 the wall fan of edge +x, 7-12 of edge +y. A wall: P is
  the edge's corner line with the lower coordinate along it, Q the other (edgeOf). lo, hi = the two columns' tops (raw, the
  same on P and Q); on each line the two other slots clamp to [lo, hi] and sort (min, max), giving lists [lo, a, b, hi]: a
  clamped slot IS the identity (line, lo) or (line, hi), so its position is that of the lower or higher column's slot. The
  strip zips the two lists from the bottom in 6 steps: advance P while its next height <= Q's next (ties to P), else Q
  (exactly the box mesher's wall rule); step s emits (P_i, Q_j, next). A step onto an equal height is a repeated vertex: no
  pixels. The face looks toward the lower column (kind 0-3 by which column is higher), its material the higher column's
  top material; winding by the out direction (orientIds).
- *Exceptions:* every box face the template does not draw, baked by the box rule (faceBake), placed by the same collapse,
  then repeated-vertex triangles and coincident cap pairs dropped: every face of a non-simple column (caves, overhangs,
  tunnels, thin stacks), caps and walls touching a rim line, walls whose range holds a record boundary or a bottom, the
  wall pieces under the ground (skirts between different bottoms), walls facing a column the level does not draw (window
  edge, child footprint), and down caps (bottoms, the GPU's fans of NS-83).
- *Proof (unit tests, 15 scenes x T = 2 and 0.5):* template (expanded from the cache and mask alone) + exceptions = the
  collapse mesh after dropCapPairs, triangle for triangle by vertex identity (multiset, orientation kept), 0 missing, 0
  extra, 0 template identities the box mesh lacks; the union's closure per level 0 odd, 0 unbalanced, 0 repeated, 0
  coincident; rim junctions 0. No counter-example and no special case was needed.
- *Counts (unit scenes, 20 x 20 windows):* gentle 2.00 visible template triangles a column (all caps), exceptions only on
  the window's edge ring (76 of 400 cells: their walls face air outside the window; 1.6 % of a 256 window) plus 2 bottom
  triangles a column (the GPU's fans make that ~0.25). Exception cells: slope, cliff, fluids, pillars 19 % (the edge ring
  only); tunnel 41.5 %, one-column tunnels 36.5 % (T = 2), overhang 46 %, random 73 % (T = 2) / 88 % (T = 0.5), deep thin
  stacks 100 %; soil over stone hills 19 % at T = 2 but 61.8 % at T = 0.5 (stone tops inside wall ranges: walls that
  survive the collapse cross a record boundary; BACKLOG NS-108).

**The GPU design (written before the code; what was built, and the one change, under "As built (round 14)" below).**
- *Cache page (level id 48 + depth, one a chunk, from the one pool, keyed like the column pages; no cap):* the chunk's 17
  x 17 corner lines (its border lines are written in both chunks by the same arithmetic, so the copies are bit-identical)
  x 20 words: raw vec4 (the four slots' tops), then per slot (x, y, z, normal as an octahedral 2 x 16 bit word), then 256
  mask words (bits 0 cap, 1 w+x, 2 w+y, 8-15 top material). 6,036 words, inside a 12,544-word page. Room for next round's
  x, y moves without a layout change.
- *Cache pass (compute, one workgroup a chunk, one thread a line):* for the chunks an op bakes today (the same dilated
  unions), each line's four slots: raw, cluster (the WGSL twin of mesh.cluster: bpPrev / bpNext / joinedAbove over the
  line's columns, on a rimC line the parent's too through toKid; f32 sums bottom up, then / n), written once (one writer a
  word). Then the classify step (barrier; one thread a column) writes the mask from the columns and the cache's cluster
  bottoms. The cluster function is ONE WGSL function used by this pass and by the exception bake, so positions are
  bit-identical (no multiply-add in it: sums and one division; risk: a driver reordering the sums; the capture test
  checks bit equality).
- *Template draw (one instanced draw a level):* an instance a chunk (the level's cache page list), 256 x 14 x 3 vertices.
  The vertex stage decodes column, part, corner; reads the mask word; a cap vertex reads its slot (1 read); a wall vertex
  reads the raw vec4 of P and of Q and its slot (3 reads). Unset bits and repeated vertices give a degenerate triangle
  (all three vertices at one point, no pixels). The vertex stage never reads column pages.
- *Exception bake:* faceBake with the template's parts masked off per column (emitCol skips the up cap where `cap`, and
  the wall piece [lo, hi] of an edge where its bit is set), each vertex's z replaced by its placed z (the shared cluster
  function), triangles with two corners in one cluster skipped, coincident cap pairs dropped per column (the rule of
  dropCapPairs: a cap is kept iff no cap of its run is above it and an even number below). Rim chunks keep the round 11
  rim rule (exception vertices on rim lines are the child's, placed through the child's view-projection).
- *What an edit re-bakes:* the cache pass over the op's chunks (cheap: 289 lines a chunk, a few breakpoints each). The
  exception bake of a chunk only when its exception output changes: the count phase hashes the chunk's exception face
  words (placed z included) and compares with the hash kept in the face page's header; equal: no ensurePages, no write.
  So a carve on open ground costs the cache pass plus a count walk of the exceptions (bottoms, the edge ring); the bottom
  fans are not rewritten unless the chunk's bottom changed. Target under 1 ms on open ground (gate 1.5 ms).
- *Shading (step C):* the cache pass writes per slot a normal: the normalised sum of the area normals of the template caps
  of the columns whose slot on this line has the same placed position (the same sheet; walls excluded), placed corners
  read from the cache (a second pass after positions, reading neighbour chunks' pages for border lines). The fragment
  stage takes the interpolated vertex normal and the face normal (derivatives); where they differ by more than the crease
  angle (default 50 degrees, `?crease=`) it shades flat: cliffs and kept walls stay sharp. Exceptions are flat this round.
- *Switch:* `?smooth=1` and a "Smooth" toggle; boxes stay the default. With smooth off nothing above runs.
- *Cost risk:* 14 triangles = 42 vertex invocations a column for ~2 visible triangles on gentle ground (the box draw:
  ~4 + walls). If the vertex stage measures as the draw's bottleneck (step D's tiny-viewport split), the fallback is a
  per-chunk list of the edges whose wall bit is set and whose tops differ (one word an edge, written by the classify
  step's scan), drawn as a second instanced draw of 6 triangles an edge; the caps stay a fixed template.

**As built (round 14, step B; one change of plan, the cluster tables).** nest.wgsl cacheBake / walkLine / clusterAt /
wallTmpl / emitColS / faceBake (SMOOTH), draw.wgsl tCorner / vsT / vsS / fsS / captureT, render.ts, nest.ts setSmooth.
- *Change from the plan: one cluster walk a line, kept in a table.* The plan called one WGSL cluster function from every
  vertex site of the cache pass and of the exception bake. The D3D compiler inlines every call: with a cluster walk at
  each cap corner, wall step and fan check, the smooth bake did not finish in four minutes (compile or run; not split).
  So the cache pass walks each corner line of its chunk ONCE, bottom up (walkLine: breakpoints by bpNextC, consecutive
  ones closer than T and joined above (joinedAboveC) chain into a cluster, its height the f32 sum bottom up / n, the
  reference's arithmetic) and stores the clusters of more than one breakpoint as (bot, top, placed) intervals in the
  chunk's cache page (CLOFF: a word a line, first | count << 20; intervals from CIV in page 0, then whole pages cz 1, 2,
  ... sized by a scan: paged, no cap). Every placement after that is a lookup (clusterAt: the interval holding z, or z
  itself): the cache's slots, the exceptions, the fans' check. A vertex the template and an exception share therefore
  reads the same stored bits, not two evaluations that ought to agree; a chunk's border lines are walked by both chunks'
  cache passes (same pipeline, same function, same inputs). On a parent's rim line the table holds the child's line
  (both levels' columns, the child's units), which is what the parent's exceptions place there.
- *The cache page* (level id 48 + depth, one or more a chunk): words 0-2 header, 3 the exceptions' second hash; 289
  lines x 20 words (raw x 4, per slot dx, dy, z, normal); mask words from 5784 (bits 0 cap, 1 wall +x, 2 wall +y, 8-15
  top material, 16-23 / 24-31 the +x / +y wall's material: the higher column's top, so a template wall never reads the
  neighbour chunk); the cluster table from 6040.
- *Order in a bake:* every GpuNest.bake (dilate, then per slot) runs cacheBake, faceBakeS, faceBakeRimS over the same
  slot in one compute pass (a dispatch is a usage scope: the exceptions see the cache). The wall template bit is
  computed by one function (wallTmpl) in both the mask and the exception bake.
- *Fans:* a 4 x 4 block (or chunk) bakes its down caps as one fan only where every corner line on its rim leaves the
  bottom where it is (clusterAt(zb) == zb); elsewhere each column keeps its own placed down cap, which takes part in the
  pair rule. (Stricter than the reference's fan rule; the reference test excludes the bottom lattice's down caps.)
- *The skip (changed while building: inputs, not outputs).* The plan hashed the exception words in the count pass; that
  pass still did all the exception work, so it saved little. Built instead: the cache pass hashes the chunk's inputs
  (its 18 x 18 columns as the bake reads them: drawn or not, every record, the bottoms; two independent 32-bit sums),
  compares with the hash in its cache page (words 0-1) and, when equal and the chunk touches no rim line, returns at once
  and sets word 2, on which the exception bake returns too. A fresh page's header is zero and the hash never is.
  A collision would leave the chunk stale (2^-64 a chunk bake; NS-111). The exception bake reads the -x / -y walls'
  template bits from the mask words of their owners (the chunk before), not recomputed.
- *Cost work while building (all measured with the shaft carves of the pit suite, which lost the device):* the line walk
  reads its columns once (on a rim line the other level's from the pages, bottoms by zbG: once a walk, not once a
  breakpoint), keeps a cursor per column (each record read once a walk), the table lookup is a binary search, and the
  pair rule scans outward from the cap only within its cluster. Sizes: a line's table place is bounded by half its
  breakpoints (one walk, no counting walk).
- *Which ops run the cache pass, and why none is missed:* every op that changes a level's drawn columns already bakes
  them through GpuNest.bake (root; promote: the child's window and the parent round the footprint; demote: the parent
  round the old footprint; slide: the entering chunks, the edge ring, the parent round both footprints; edit, for
  raise / dig / melt / carve / add and strokes: per level the union of the edit, derive and restrict regions, grown two
  columns; setSmooth: whole windows). bake() runs the cache pass first whenever the smooth draw is on, over the same
  chunks, so the cache follows the faces everywhere the box draw's faces follow the columns (the round 8 dilation: a
  column's bottom depends on its neighbours, a line's clusters on its columns' bottoms, the mask on the lines round a
  column: all within the two-column grow). Pages: release lets the cache pages go with the level's other pages (slide,
  demote; mode 8 lets only them go when the smooth draw is switched off); the pool's shrink moves pages with their
  contents and rebuilds the draw's lists; a grow copies them. Nothing else writes columns of a live level.
- *The draw:* per level the template (dirBuild lists the cache pages: dir[8 + L], entries from 16 + ((8 + L) cap + i) x 2;
  dirFinish the indirect arguments at (8 + L) x 16: 256 x 14 x 3 vertices an instance) and the exceptions (the face
  pages, the box draw's corner decode, z already placed). The fragment stage takes the face normal from the screen
  derivatives of the level-local position, turned toward the eye.
- *Status at the end of round 14:* `?smooth=1` only (no page toggle): watertight on every check that ran to the end
  (closure, rim lines, coverage, 0 hole pixels over the 40 poses, cruise and 162 pit poses, GPU = reference), but in the
  full selftest's dug world a smooth bake still overruns the driver's timeout (NS-116), and the draw is vertex-bound at
  2.5x the boxes (NS-117: the edge-list fallback is next). Whole-window smooth bakes (the switch, a promote) go a chunk
  row a submit. Where to pick up: NS-116, then NS-117, then the 3-run gate, the stills (scripts/nested-r14-stills.mjs).
- *Shading (step C, as built):* the cluster table covers the chunk's lines and the ring round them (19 x 19, CLOFF 361
  words) so that the cache pass can place the four corners of every column round the chunk (-1..16) and take its top
  quad's area normal (the diagonals' cross product; zero where a corner is a rim line). A slot's normal is the
  normalised sum over the line's columns whose slot is the same placed vertex (octahedral, slot word 3); a border line's
  normals are the same in both chunks. The template passes it per vertex; fsS uses the interpolated normal where it lies
  within the crease angle of the face's (renderer.crease, default 50 degrees, `?crease=`), else the face's: a template
  wall's vertices carry their caps' normals, so walls (and cliffs taller than T) stay flat and sharp. Exceptions are flat
  (no normal; not attempted this round). The input hash covers 20 x 20 columns (the normals' reach).
- *Proof on the GPU (tests only; `?selftest=1` smooth section, `?selftest=1&smooth=only`):* a small chain (root 64, level
  1 64 wide, level 2 32 wide; a carve across level 2's rim, a cave at level 2, an add at level 1): every drawn triangle
  (capture: template + exceptions) equals the reference's collapse mesh after dropCapPairs per level as a multiset of
  placed triangles (x, y exact, z within 1e-5 relative: the GPU's f32 division is not correctly rounded on D3D; the
  bottom lattice's down caps left out on both sides: fans), closed (0 odd edges, 0 degenerate, 0 coincident), rim lines
  0 junctions. Then the sandbox with the smooth draw on through the watertight suite and the pit, cave and shaft poses.

**As built (round 15; kept current while building, so a successor can continue from here).**
- *Step 1 (NS-117): the draw no longer runs vertices for nothing.* Three draws a level, all indirect, arguments written
  by dirFinish, nothing read back:
  - *Caps:* a fixed template of 2 triangles a column (vsTC: an instance a cache page, 256 x 2 x 3 vertices), the same
    vertex code as before (tCorner part 0 / 1: the mask's cap bit, the slot positions and normals from the cache).
  - *Walls:* the cache pass's classify step marks a template wall *with pixels* (mask bits 3 / 4 for +x / +y): its wall
    bit is set and on P or on Q the lowest and highest identity are placed apart (clusters are intervals, so the
    entries between are apart too, and a triangle with two vertices on one line and one on the other is never flat;
    otherwise every step is a repeated vertex). The walls with pixels are compacted into the chunk's wall list (cache
    page words CWALL = 6401.., a word a wall, column | dir << 8) by the workgroup scan (wgScan: one writer a word, no
    workgroup atomics), their count in header word 3. dirBuild (storage atomics, the pool's kind) lists each chunk's
    walls in blocks of 32 (wallDir: per level a count and up to 16 x cap entries, list index << 4 | block); vsTW
    draws an instance a block, 32 x 6 x 3 vertices, a vertex past the chunk's count degenerate. Same tCorner wall
    code, so the same cluster tables and bit-identical shared vertices.
  - *Exceptions:* the face pages in blocks of 128 triangles (exDir: per level a count and up to 25 x cap entries, face
    list index << 5 | block); vsSB an instance a block. Departure, not in the written design: the design kept the
    exceptions "drawn as the boxes are", and the box draw instances a whole face page (3 x 3,135 vertices whatever its
    count). With caps and walls compacted, that tail was the rest of the smooth draw's vertex work: worst view 7.8 ms
    against boxes' 7.0 (tunnel; 4 x 4 canvas 8.3 of 9.1 ms). With blocks: 2.8 ms. The box draw is unchanged.
  - The cache page's cluster intervals moved up to make room for the wall list: CIV 6913, CIV0 1877 (was 6401, 2047);
    the directory grew by 8 + 16 x 8 x cap + 8 + 25 x 8 x cap words (sized with the pool, rebuilt by every op).
  - The capture (tests) reads what is drawn: the caps' slots, the wall blocks (captureT) and the exception blocks
    (captureSB). smoothref: every drawn triangle equals the reference, 0 extra, 0 missing (L0 11,038, L1 12,856, L2
    4,936: the same as round 14).
- *Step 2 (NS-116): where the time went, and the bound.* Measured in the selftest's dug world (scripts/nested-dug.mjs:
  the pit suite's shafts with boxes, then whole-window rebakes timed a chunk a submit, GpuNest.rowTimes / chunkTimes,
  measurement only). The cost was NOT the smooth draw's own passes: the cache pass took ~9 ms on the worst chunks, and
  the box bake cost the same as the smooth exception bake (257-353 ms a chunk) on chunks whose columns hold 46-60
  records. Both run the box rule's wall walk, which was O(records^2) twice over, with a hash-table page lookup for every
  record past a page's 24: (1) nextBp / nextBpRim scanned each column's records from the bottom at every strip step
  (now a binary search: a column's tops rise with the record index); (2) each wall side restarted the neighbour's scan at
  record 0 for each record of the column (now a cursor that only moves up, starting at the neighbour's first record
  above the record's bottom: the records under it were skipped by the scan anyway, so the output is the same). And the
  cluster table's pages past page 0 were looked up in the hash table at every probe of the binary search (now looked up
  once a workgroup, civPages). Worst chunk after: smooth 112 ms, boxes ~40 ms (L0 near a child's footprint, 64 records).
  These change the box bake's code but not its output (both are exact reorderings of the same reads).
- *The bound:* every smooth bake goes one chunk row of its slot a submit (GpuNest.bake: u.e.z = row + 1, the cache pass
  and the exception bake return at once for other rows; a CPU rect's rows are known, a GPU region uses its level's window
  rows). All of an op's submits go before the frame's draw, so no frame shows a half-baked level (the old mesh is never
  drawn half-replaced: the draw simply comes after). The box bake is not banded (unchanged path).
- *The owner's spec for the smooth draw (2026-11-19, during round 15; relayed by the orchestrator, his words):* "Each
  layer should be nxn for loaded chunk and should make a simple quad lattice except where there is an air gap next to
  or below a column. If the intervals do not overlap." / "Each vertex averages its adjacent neighbors. Air gaps mean it
  is not adjacent and they instead average the bottom of the column. We make the surface from instanced nxn sheets with
  a vertex shader that does the heights and we only instance more for overhangs and we compute in integer order to make
  them seamless by construction." / "Games already use heightmaps with no overhangs and texture and noise can make it
  look fine. We literally have a mechanism for layers and the intervals with an air gap is the obvious rule."
  The orchestrator's reading of "adjacent", to be built: not a new interval-overlap test (taken literally a cave floor
  would average with the mountain top behind its back wall, and it is not transitive round a corner: a crack); two
  surfaces on a corner line are in one group when an exposed wall joins them, which is what the round 13/14 cluster
  tables already encode, with every wall collapsed (threshold unlimited), one value per cluster for every quad that
  touches it. Then the owner's clarification: "the vertex height averaging the bottom of the column in that case would
  make the sheets meet by construction": EVERY wall on a corner line collapses, lips and cave back walls included; all
  surfaces joined by exposed walls form one cluster and get ONE vertex at the mean of the cluster's heights (tops and
  bottoms alike); a lip closes as a wedge, a cave's floor and ceiling meet at its back wall. No side faces. Cells with
  inner air get more sheet instances; baked geometry only for rim strips, the window edge ring and the bottom skirts.
  Known and accepted: lips and cave mouths taper to a knife edge over one column; a feature one column wide collapses to
  zero thickness (a 1-wide tunnel closes); a 2-wide tunnel gets a diamond section.
- *Built so far: the reference only.* T = Infinity in the reference's proofs (test/unit/nested-boxmesh.test.ts, 18
  scenes with the new ones: a tall cliff by a cave mouth, a cave under a much higher surface, a slab fused to a cliff
  crossing x = 16, a spiral step round one corner line, a step across a rim): closure 0 odd, 0 unbalanced, 0 rim
  junctions on every scene, template + exceptions = the collapse mesh; the cave floor stays under its ceiling (never
  rises toward the surface 24 above). Found: 4 coincident cap pairs a level on every scene at T unlimited (z-fighting,
  not holes): the walls facing OUTSIDE the window collapse too, so the edge ring's sheet folds down onto its bottom and
  at the window corners a top cap lands on a fan's down cap (the fan stays out of the pair rule); gentle terrain's
  visible template triangles drop from 2.00 to 1.62 a column for the same reason. The spiral step leaves 4 at T = 2 too
  (a pinch, accepted by the orchestrator). So the GPU stays at T = 2 this round: the owner's later ruling (no down caps
  or skirts in the sheet draw, no outer ring at the coarsest window: the sheet just ends there) removes exactly what
  folds and must come first (NS-122).
- *Step 3 (stills, desktop only: local/nested/r15-*-box.png / -smooth.png; the phone set and the GIF were not made).*
  Fault (a), the slivers along the rim top, is geometry but not a hole: on a child's window edge every k-th corner
  line is a rim line placed by the joint (child + parent) cluster, the lines between by the child's own walk, whose wall
  faces the undrawn outside; alternate lines land at different heights, so the edge ring's walls zig-zag into teeth
  (r15-hillside-l1-smooth, r15-cliff-smooth). The fix is the level-edge form of Step 4 below (the child's edge vertices
  take the parent's surface), not a patch. (b) and (c) not changed this round (budget; NS-123). The toggle stays URL
  only: the 3-run gate was not run and the 40-pose check in the dug world fails for boxes and smooth alike (NS-120).
- *Step 4 (design, no code): level edges without the rim strip (the owner's question).* A child vertex on its
  footprint boundary takes the parent's value for the matched surface, interpolated linearly along the parent's edge
  between the parent's two corner vertices: at child line i of k along a parent edge from P to Q, z = zP + (zQ - zP) *
  i / k in child units, computed by one expression (integer i and k, the parent's two stored values) on both levels, so
  the shared vertices are bit-identical by construction and the parent needs no vertex between P and Q (no T-junction:
  the parent's edge is one straight segment and the child's vertices lie on it exactly only if the arithmetic is exact;
  with i / k a power-of-two fraction and the values f32, zP + (zQ - zP) * (i / k) is exact when the difference is
  representable, otherwise the child's points lie within an ulp of the parent's line: a sub-pixel crack the screen check
  would see as 0 holes but the closure check would flag; the strict form needs the parent to split its edge at the
  child's k - 1 points, which the parent's rim faces already do today). Matched surface: the child's cluster on the
  boundary line pairs with the parent's cluster on the parent edge whose height range contains it (both from their
  tables). A child surface with no parent match pinches (its vertices take its own bottom's cluster: the wedge closes on
  itself). A parent surface at the edge the child lacks (a parent overhang the child's enhance removed, or a thin layer
  the child collapsed): the parent's sheet ends at the footprint with no child sheet to meet: an open edge, so the
  parent must pinch it too (its two clusters on the boundary line merge), or the rim strip stays for that case only.
  Closure on the rim scenes: holds for matched surfaces with the strict (split) form; unproven for the pinch cases; a
  reference test ('child in parent', 'step across a rim', 'three random levels') is the next step before any code.
- *The planned first form on the GPU (not switched on):* the collapse threshold unlimited (SMOOTH_T = 3e38 in the cache
  pass; no dial, the earlier `?collapse=` idea dropped as the spec says). Then every wall whose
  two tops are joined on a corner line collapses, and the template draws only the cap lattice on solid terrain (the
  wall list comes out empty there; kept, it costs nothing when empty). Closure, the pair rule and the rim rule are the
  proven round 13/14 ones (a simplicial map of the closed box mesh); a cluster is placed at the f32 mean of its
  breakpoints, summed bottom up in one fixed order with one division (the spec asks for an integer sum: open, NS-121;
  the f32 sum is already bit-identical on both sides because both read the same stored table). Not yet as the spec
  draws it: the inner-air cells are still the baked exceptions, not extra sheet instances (NS-121). Cliffs become
  one-column ramps (vertices move only vertically this round); the stored plane word sharpens them next round.

**As built (round 16; kept current while building).** The owner's spec, his words: "Each layer should be nxn for loaded
chunk and should make a simple quad lattice except where there is an air gap next to or below a column." "Each vertex
averages its adjacent neighbors. Air gaps mean it is not adjacent and they instead average the bottom of the column. We
make the surface from instanced nxn sheets with a vertex shader that does the heights and we only instance more for
overhangs and we compute in integer order to make them seamless by construction." "If the intervals do not overlap then
the vert averages the top and bottom of that interval so it pinches them together like an empanada." "You don't need to
mesh anything. You just need a surface pointing down with the same rule for the bottom of the interval and another for
the solid below the next air gap down." "Why make those [skirts, outer ring] if the camera will never see them?"
- *Step 0 (NS-119, boxes):* one run; the rim faults are transient (each pose shows them in only one of its two checks)
  and come from a stale bake, not the arithmetic; not proved (the rebake eyes missed them) and not fixed. BACKLOG NS-119.
- *Step 1, the reference (boxmesh.ts sheetMesh / sheetClosure; test "the sheet form is closed ...").*
  - *Surfaces.* A column's surfaces are its solid/air changes, bottom up; sheet j of a column is its j-th surface (up or
    down). A column continues downward as its first record (its bottom is no surface: nothing under the ground is drawn);
    a drawn column with no records is air all the way (present, not absent).
  - *Vertices.* A corner line's four quadrants are owned by the column drawn there: its level's, or outside a child's
    window the parent's (heights through toKid), or nobody (outside the root window: absent). Breakpoints: the owners'
    surface heights (distinct). Two consecutive breakpoints are joined when the present owners are not all solid or all
    air between them (an exposed wall stands on the line there); a cluster is a maximal joined chain; a cluster is
    bottomless when the owners already differ below the lowest breakpoint. A surface's corner is the cluster holding its
    height on that line. Vertex identity = (level, line, cluster). No threshold.
  - *Why it is closed.* It is the box mesh of the columns extended downward, with the walls facing outside the root
    window left out, under the collapse map with every wall collapsed: a wall piece's two vertices on one line are always
    in one cluster (the wall itself joins them), so every wall triangle has a repeated vertex and drops; a simplicial map
    of a closed surface is closed. So the only open edges are on the root window's edge (no faces outside it) and the
    ceilings of columns that are air all the way down (bottomless clusters: nothing under them is ever drawn). A sheet
    triangle's three vertices lie on three different lines, so no sheet triangle is ever degenerate; the only faces that
    can coincide are consecutive surfaces of one column on the same three clusters (a layer pinched to nothing): the pair
    rule of round 12, per triangle slot (a run of consecutive surfaces on the same three vertices keeps its top one when
    the run is odd, none when even).
  - *Level edges (the rule chosen; closed in the reference).* A parent's corner line on its child's footprint boundary is
    the child's line (canon). A child's window-edge lines, all of them (not only every k-th), see the parent's column
    outside as the owner of their outside quadrants. A parent column along the footprint splits that edge at the child's
    k - 1 lines between its two rim corners: its quad becomes a fan of k + 1 triangles from the far corner (a fixed
    shape; the split points' vertices are the child's). So both levels use one vertex for every point of the edge: no
    T-junction, and the union is closed by the same argument (the parent's cap is a polygon with its edge split; the
    walls between the parent's column and the child's columns collapse like any wall). A surface one level has and the
    other lacks at the edge (a parent overhang the child filled, a child cave the parent lacks) stands on a wall at the
    edge, which joins it with the surfaces round it there: it pinches shut at the edge (no special case). Placement (it
    never decides closure): a cluster on a child's edge line between two rim lines that holds parent surfaces is placed on
    the parent's edge, per parent surface zP + (zQ - zP) * i / k from the clusters holding it on the two rim lines
    (fixed point, integer i of k), averaged; other clusters at their own mean. Departure from the round 15 text, said
    plainly: the parent DOES get vertices between P and Q (the fan), because the text's own analysis showed the
    unsplit form leaves T-junctions (sub-pixel cracks); a parent surface the child lacks pinches through the wall rule,
    not through a separate merge.
  - *Placement.* A cluster's height = sum of floor(z * 256) over its breakpoints (integers, order free), one division
    by n * 256 (SHEET_FIX).
  - *Proof (25 scenes: round 15's 18 with their variants, plus a lip across x = 16, a parent tunnel the child lacks, a
    child cave across the edge, a parent lip over the edge with a child slope):* 0 open edges inside, 0 level-edge
    faults, 0 coincident, 0 repeated; open edges only on the root window's edge (gentle: 80 = the 4 x 20 rim) and at
    bottomless ceilings (only the random scenes, whose columns can start with air: 266-478). Gentle terrain: exactly 2
    triangles a column, the edge ring included. Layers pinched to nothing (information): one-column tunnels 40, spiral
    step 3, random 103, deep thin stacks 2,523, three random levels 36 / 69 / 54, parent lip over the edge 2, all others 0.
    Fan triangles: 80-120 a parent (k = 4).
  - *The split edge, re-cut (still step 1, before the GPU):* a parent column's polygon with its split edge is cut into
    its plain quad (the four corners, the same two triangles as every column) plus a ZIPPER (A, s_t, s_t+1), t = 1 ..
    k - 1, from the edge's first corner A: the same polygon, so the same closure; every zipper vertex lies on the
    child's edge lines, so the CHILD draws it (its own cache holds all of them) and the parent draws plain quads only.
    Zipper triangles are nearly flat (they fill the sliver between the parent's straight edge and the child's vertices,
    which the interpolation puts on it). The pair rule runs on zipper slots too (consecutive parent surfaces).
- *Step 2, the GPU (nest.wgsl sheetBake, draw.wgsl vsSheet / captureSheet; the old cache pass, template, wall list and
  smooth exception bake are no longer called; their code stays until the gate passes).*
  - *sheetBake (a workgroup a chunk, a chunk row a submit as before):* the input hash skip of round 14 (rim chunks always
    bake); sizes first (each corner line's bound = its owners' records, a scan; the sheet count S = the deepest column's
    surfaces, on a child's window edge also the parent columns' outside), then every page at once (cache page 0, cluster
    spill pages cz 1..A, sheet pages from cz 1 + A, SPP = 15 sheets a page); a missing page (pool full) leaves S = 0.
    1. each of the chunk's 19 x 19 corner lines walked once (sWalk: canonical line, four quadrant owners, surface heights
    only, joined = owners not all solid or all air; integer sum, one division); 2. on a child, window-edge lines between
    rim lines re-placed on the parent's edge (integer interpolation); 3. each cluster's normal = the normalised sum of
    the area normals of this level's quads on it (a merge walk; rim lines none: flat); 4. per column and surface the four
    corners' cluster indices and the pair rule's kept bits (one thread a column); 5. per zipper slot (side, segment) per
    parent surface: its height in the child's units and kept bits.
  - *The draw:* one indirect draw a level; an instance a sheet of a chunk (dirBuild lists every sheet page's sheets,
    2 words an entry: sheet page | sheet << 24, page 0); 544 triangles an instance: 2 a column, then 32 zipper slots
    (2 sides x up to 8 segments x k - 1 triangles, < 32 for any k). A vertex reads its sheet word and one cluster (a
    zipper vertex finds its cluster by a binary search on its height). Normals from the cache, the 50 degree crease rule
    unchanged (fsS).
  - *Sizes:* the sheet directory per level is 24 x cap entries (EX_PB 48 words): a chunk's sheets are at most its
    deepest column's records, at most 24 a column page of that chunk, so the sum over a level is at most 24 x its column
    pages: not a cap. Exception: a child edge chunk's zipper sheets follow the parent column outside (BACKLOG NS-125).
  - *Ops:* a slide of level L also re-bakes its live child's edge ring (the child's edge lines see L's columns outside
    it, and L's entering chunks were just derived): the selftest's cruise left 12 open edges on one zipper run without it.
    An edit (round 16, NS-126) also bakes each level where its parent's and its child's edit and derive regions were
    (dilate with u.e.z 1 / 2 carries a level's region into its child's or parent's chunks): the full selftest found 10
    open edges at L1 line 480,944..984 after the stroke across the rim, the same line where the box draw's NS-119 faults
    sit, so NS-119 is most likely the same miss (the box draw is not changed: its rim faces would need the same grow).
  - *Tests:* the 40-pose screen check of the smooth section runs on a fresh sandbox only (`?smooth=only`); in the full
    run the section switches on in the dug world and runs closure, rim and coverage at the 8 eyes without the screen
    check, then the pit, cave and shaft poses (NS-120 as decided). The rim-line check has nothing to count in the sheet
    draw (no rim walls); the closure check is the union over all levels (watertight.ts unionClosure), reported as level
    0's odd edges.
- *Status at the end of round 16:* the sheet draw is the smooth path (`?smooth=1`, URL only; no page toggle: the gate
  was not met). Passed: reference 25 scenes closed; GPU = reference; `?selftest=1&smooth=only` 11 of 11. Open: the full
  selftest's dug world (NS-127 pit holes, NS-128 transient), the edit fix of NS-126 not yet re-run, carve cost 3x boxes
  (NS-129), stills poses. The old smooth code (cacheBake, template caps and walls, wall list, smooth exception bake and
  their draw entry points) is no longer called but not yet deleted (delete once the gate passes). Where to pick up:
  re-run the full gate; NS-127 with per-pose diagnosis; NS-129.

**As built (round 17; kept current while building).**
- *The bake region rule (one rule, one function: GpuNest.bakeChanged; both draws).* An op says which COLUMNS of a level
  M changed (their records, or whether they are drawn). A bake of level L's chunk reads: L's columns within two of it
  (lines, their owners, normals over the quads round a line); on a rim line of L (its child's footprint boundary) the
  child's columns round the child's line; on a window-edge line of L (L > 0) the parent's columns outside the window (and
  for boxes the parent's depths there). Nothing else (no bake reads another bake's output). So for changed columns B of
  level M:
  1. M's chunks over B grown by two columns;
  2. M's live child: its chunks over B grown by two, times k, grown by two, that hold a rim line (chunkRim);
  3. M's parent: its chunks over B grown by two, divided by k rounded out, grown by two, that hold a rim line.
  Which columns each op changes: an edit, per level m, its edit box, its derive box and the restrict into it from m + 1
  (the plan's slots m*4+3, m*4+2, (m+1)*4); a slide, the entering chunks, the window's edge ring (its edge lines now face
  another outside) and the parent's columns round the old and the new footprint (drawn or not); a promote, the child's
  whole window and the parent's columns round the footprint; a demote, the parent's columns round the footprint; root,
  everything; setSmooth and the test's rebakeAll bake every live window whole (the partner sets lie inside). Shrink moves
  pages only (no column changes); resClear changes residuals, which reach live columns only through the derive boxes.
  Hash: in an edit, part 1 skips a chunk whose own columns hash the same (the sheet pass; the hash holds only own
  columns, and a change of the other level's reaches the chunk through 2 or 3, which are forced); window ops force
  every chunk (they change what the hash does not hold: rims, owners outside, z origins). Round 16 instead carried chunk
  rects grown by a whole chunk (x k: four child chunks each way), for the sheet draw only, without the restrict box, and
  let every rim chunk bake whatever the hash said; the slide's special child-ring re-bake is gone (part 2 covers it).
  Partner bakes go in one submit band (rim chunks only: at most a window's ring).
- *Bands (step 2, NS-129).* An edit's own bake on a level takes floor(window rows / side) region rows a submit, side =
  sqrt(the CPU's brush bound) + 2, ceil(side / that) bands, the last band taking every row after it (sheetBake: u.e.y =
  rows a band | bands << 16). Window ops keep a row a submit. Carve at level 1: sheets 11.9 ms, boxes 22.6, the sheet
  pass 6.8 (36 submits).
- *Step 4, the look (stills local/nested/r17-*.png, scripts/nested-r17-stills.mjs; round 16's poses read level-local
  heights as world heights, so the cameras sat in solid: now every feature is made at level 1 from world positions and
  its world height read back; no pose was lifted).* (a) The sawtooth where grass meets a crater wall, from the columns:
  13 level-1 cells round the bowl's rim (radius 0.97 of 1) hold NO air gap (all solid records); their tops alternate
  along the circle between carved (9.46-9.69, stone on top) and uncarved (10.11-10.64, soil on top). So the owner's
  reading (cells alternating next to an overhang and not) does not hold for this bowl: the circle's staircase of cells
  does it: each corner line between a carved and an uncarved cell collapses its step into one vertex at the mean, so
  the rim is a row of triangles whose apexes alternate high and low (teeth), and the top material alternates per cell
  (grass on soil, grey or dirt on stone). (b) the thin vertical slivers in tall walls are the same collapse on the wall
  below: neighbouring cells with different numbers of surfaces join different clusters. Geometry unchanged (the
  owner's ruling). (c) the thin brown stripes on open slopes at a level edge are the zipper triangles: near-vertical
  slivers (the step between the parent's straight edge and the child's vertices), whose face normal is more than the
  crease angle from the vertex normals, so they shade flat with nz near 0 and soil reads as dirt. Not changed (the
  colour follows the lighting normal, as the owner wants). (d) walls nearly black away from the sun: the lighting
  floor (0.35 ambient, 0.12 less for a face turned down: 0.23 on undersides, x 0.47 stone): now a sky / ground ambient
  (0.40 down to 0.52 up) + 0.55 sun (fsS only; the box draw unchanged). Shading: the 50 degree crease stays the default
  (the owner likes a hard crease at a rim); the teeth at rims show FLAT facets beside creases (r17-bowl-rim,
  r17-tunnel-inside), so by the owner's rule the next step is per-corner normals by smoothing group (each quad corner
  averages the quads round the vertex within 50 degrees of its own, computed in the bake): NOT built this round.
- *Status at the end of round 17:* the gate is NOT met, so the old smooth path stays and there is no page toggle (step 5
  not done). Met: closure everywhere (fresh and dug, both draws), NS-119 / NS-126 / NS-128, sheet carve under the box
  carve, draw at or under boxes in every view, 36 of 36 smooth off, stress, unit tests. Not met: the 1-frame pit pose
  (NS-127, geometry or the camera's lift; no missed bake), nested-shaft (NS-135), the sheet pass 6.8 ms (target 3),
  per-corner normals (NS-133), the level-edge still (NS-134). Pick up: NS-135 with the held-still diagnosis; decide the
  1-frame teleport check with the owner; NS-133; per-line bakes for NS-129.
- *A child never sits outside its parent (NS-128).* The app runs one level op a frame, so a slide of L that left L + 1
  outside it (a teleport: the selftest's setView to a shaft) left the child orphaned for a frame or more: its window-edge
  lines saw no parent columns (its whole edge open: the 1,024 open edges of NS-128) and its zippers kept the parent's old
  surfaces (64 chunks the forced bake changed). A slide now demotes a child its new window would not hold (checkWin's
  margin), in the same op, before the slide; the parent draws there until the app promotes again.
- *NS-127, the dug world's hole pixels, diagnosed (suite.ts pitAndCave `rebake`: the levels held still, the holes counted
  after 3 frames with nothing baked, then after a forced bake of every window, and the chunks whose drawn triangles that
  bake changed).* Full selftest run 1 with the rule: 168 hole pixels over 162 poses (round 16: 192,048), all at the
  1-frame check of one pose (the shaft across the rim, 84 then 0). sheetdug runs: (a) GEOMETRY, the counter-example: the
  eye at world (52.8, 120.5, -20) at the bottom of the 2.2-radius shaft (root columns 50..55, top about 11, floor -25.6),
  in the frames before the finer levels arrive, so level 0 alone draws there: the shaft is 4-5 root columns wide and 36
  deep; every corner line on its edge has the top and the floor joined by the exposed wall in one cluster, placed at
  their mean (about -7), so the sheet is a funnel whose rim is 13 above the eye and the eye, in air by the data, is under
  the sheet: 82,668 hole pixels at 1 frame, the same after 3 still frames and after a forced bake of every window (0
  chunks changed). This is the accepted collapse (a narrow deep feature at a coarse level pinches), shown only until the
  level that resolves the shaft is promoted (0 at the settled check). Not changed, no skirt. (b) The orphaned child above.
  (c) one 1-frame case in two runs before the levels were held still in the diagnosis (403,094 / 409,920 pixels, L2 at
  the eye, gone after the forced bake but with level ops between: undecided; not seen again in the held-still runs).

**As built (round 18; current state).**
- *One smooth path.* The sheets (round 16) are the smooth draw; the round 13-15 path is deleted (nest.wgsl cacheBake,
  emitColS, the template, wall list and exception bake; draw.wgsl vsS / vsSB / vsTC / vsTW / captureT / captureSB;
  boxmesh.ts collapse / collapseCols / dropCapPairs / smoothCache / templateMask / templateTris / smoothSplit and their
  tests; GpuNest skip 'cache', chunkTimes). Git keeps them. nest.wgsl 4,113 -> 3,319 lines, draw.wgsl 738 -> 481. The
  draw directory is the box face lists (16 + 16 cap words) then the sheet lists (sheetDir); draw args 0-7 boxes, 8-15
  sheets.
- *The switch (the "Smooth" button, default off, `?smooth=1` on).* An op spread over frames (GpuNest.stepSmooth, the app
  a step a frame between ops): (1) both pipelines made asynchronously (createComputePipelineAsync / createRender-
  PipelineAsync; the page says "compiling ... ms so far"); (2) every live window's chunk rows baked for the wanted draw,
  2 rows a frame, each frame reserving its own worst case ("waiting for memory (need N, pool M, device D)" when it does
  not fit; "cannot switch on this device" and no more retries when it never can); levels, edits and shrinks hold still
  meanwhile; (3) the flip: the drawn draw changes only when every row is baked, then the old draw's pages are let go
  (switching on: the face pages, release mode 9; off: the sheet pages, mode 8). So no frame draws a half-baked draw and
  only one draw's pages are kept. The bake bound asks for the draw being baked only (round 16-17 asked face pages on top
  of sheet pages). Tests and the reference still switch at once (setSmooth).
- *Unused shaders do not compile.* A pipeline compiles only its entry point's call tree; with smooth on the page makes
  only sheetBake, vsSheet / fsS beyond the boot pipelines. What the owner waited for on the phone is the sheet pass's
  own compile (the numbers are in DEVLOG round 18).
- *Screen checks, orchestrator decision awaiting the owner (NS-127 / NS-135).* The pit, cave and shaft poses count hole
  pixels on the SETTLED view: the level ops the pose triggered finished (no promote, slide, demote or refused op for 10
  frames, none in flight), then 3 still frames. The count 1 frame after the teleport is reported as information, not a
  failure: with only a coarse level open, a narrow deep shaft is pinched shut by the owner's accepted collapse rule, and
  a teleported eye sits under that sheet until the finer level opens. If the owner wants the 1-frame view hole-free,
  the answer is in the promote timing, not in the sheets.
- *Snap to the grid (REVERTED in round 19 by the owner's ruling; see "As built (round 19)"; kept here as the record of
  what was tried) (the owner: "Just snap them to the grid ... .25 or .125 for height maybe but brushes should snap to
  grid too").* Rounding everywhere: round half up, floor(x * 8 + 0.5) / 8 (store.wgsl / oracle.ts snapZ).
  - *Heights.* Every stored bound at every level is a multiple of 1/8 of that level's column unit; with k = 8 one parent
    step is one whole child unit. One place does it: pack (nest.wgsl packCol; oracle.ts toPart), the store's only entry
    for every writer (terrain, raise, dig, melt, carve, add, enhance with its residual, restrict, whole-column residuals).
    resClear writes no bounds (it decides with the same snapped ball). A record that snaps to zero thickness is dropped
    like any empty one.
  - *Brushes.* The centre snaps to the edited level's column CORNERS (so column centres sit at half offsets and a ball is
    symmetric about its centre), the radius to a whole number of that level's columns (at least 1), the centre height to
    1/8 (nest.wgsl plan; oracle.ts snapBrush). A carve or add on a column is the span cz -/+ h with h =
    snapZ(sqrt(r^2 - dx^2 - dy^2)) from the column's offset alone (ballHalf); no other sphere test. sqrt of a multiple of
    1/4 never lands on a rounding midpoint, so f32 and f64 snap alike. A stroke's in-between centres snap the same way.
    Raise, dig and melt use the snapped centre and radius; their results snap in pack.
  - *The sheet mean.* A cluster's height = the mean of its heights in 1/8 units as exact integers: q = floor(s / n), then
    the remainder's 32nds (floor), so the height is floored to 1/256 (nest.wgsl sMean, boxmesh.ts fixMean). The level
    edge's interpolation sums (zP k + (zQ - zP) i) in 1/256 units and floor-divides by m k (integer, both levels and the
    reference the same expression). Limit: heights under 65,536 units and sums in i32.
  - *Exactness.* Demote then promote is still bit-identical (unit tests and selftest). GPU = oracle now EXACTLY (max
    difference 0 in every comparison; it was ~1e-5 from f32 against f64). Inexact where it was exact: restrict's
    conservation (each parent bound is the block's mean snapped: within half a parent step, a thickness or gap within one
    step plus one child step) and melt's mass (conserved in reals, then snapped: at most 1/16 a changed column).

**As built (round 19; current state).**
- *The snap is reverted* (the owner: "Snapping doesn't seem worth it then. I only suggested the vertical snap to
  simplify things."). Heights, brush centres and radii are free f32 again; the sheet mean is round 16/17's fixed-order
  form (sum of floor(z * 256), one division); GPU against the oracle back to round 17's tolerance; restrict and melt
  exact as before. What the snap measured, so nobody retries it blind: hair-held pieces in carve scene (i) 64 -> 0,
  floating 194 -> 68 (NS-92 reopens); the sheet pass inside a level-1 carve 6.8 -> 5.0 ms; bowl walls read as stairs of
  whole child units (NS-140); restrict's conservation inexact (worst block 0.115 parent units); the stroke check failed
  at r 3 (NS-139, dropped with it). Commit 79e6768a holds it.
- *The sheet pass compiles small (NS-136).* The rule is unchanged (the walk was already the direct one: the owners'
  surface heights merged in order, joined while the owners are not all solid or all air between; the old box-wall
  clusters are long gone), so the reference stays the judge (GPU = reference, 0 extra, 0 missing). The code is shaped
  for FXC, which inlines every call: each line's owners are read in one pass run twice (ps 0 the bound, ps 1 the
  walk); the walk reads each record once from one call site (sAdvance: per quadrant the next surface; the four
  quadrants merged by their next heights, a pending mask advancing one quadrant a turn); one record reader for any
  level's pages (oRec) and one through the workgroup copy (sRec); a parent column's surfaces in turn (oNext); cluster
  lookups and sheet addresses from one site each (loops over the rim lines and the zipper chain; the previous slot's
  address carried); the sheet pass fills only the records, not the box draw's bottoms (bFillRecs). No pipeline split.
- *Compile gate (quick loop).* test/gpu/nested-compile.test.ts times every pipeline the page makes on Dawn and fails
  one over its budget (test/gpu/nested-compile-budgets.ts: about 1.5 x the round 19 time, floor 400 ms; the total
  too). Every builder runs it with the unit tests, before any browser check.
- *Boot in stages (NS-141; the owner: "behind something that loads faster so the page doesn't appear frozen").* The
  page writes a loading line before any GPU work. GpuNest in the page (`asyncPipes`) makes no pipeline in its
  constructor: App.boot makes the first frame's twelve (App.BOOT: rootGen, pack, dilate, faceBake, faceBakeRim, tabOut,
  tabIn, dirClear, dirBuild, dirFinish, merge, camera; from GpuNest.firstUse) and the box draw asynchronously, the
  line counting them; then the world starts and draws. After the first frame every other pipeline is made
  asynchronously; until then the HUD says "Preparing: n of N GPU programs made; levels and brushes wait for them" and
  level ops, edits and shrinks wait (`free`); the smooth switch may start compiling then (Chrome makes asynchronous
  pipelines in parallel). A pipeline used before it was made throws in words (a boot-order fault, never a hang). Made
  on first use, never in normal play: faceBakeOne (the measurement's one bake, synchronous), the captures (tests), the
  hazard checks (selftest); the sheet pipelines by the smooth switch. Tests construct GpuNest as before (every pipeline
  at once). `?bootall=1` makes them all before the first frame (measurement).
- *Boot gate (end gate, not the quick loop).* `scripts/nested-smoothboot.mjs` (fresh Chrome, `?smooth=1`, cold then
  reloads) checks the first frame, every boot pipeline made and the first sheet frame against BOOT_BUDGET (11, 19,
  16 s; about 1.5 x round 19's cold run). `--boot 1` reports when the GPU finished the first frame; `--split 1` the two
  sheet pipelines alone.
- *Pipelines (Dawn ms from the compile gate; first frame = made before it).* First frame: faceBakeRim 4,750, faceBake
  2,392, camera 1,038, pack 438, rootGen 186, the box draw 73, tabIn 85, dilate 87, dirClear 75, dirBuild 66,
  dirFinish 51, tabOut 47, merge 48. After it, first used by: derive 1,821 and zPick 118 (promote), restrictK 912,
  plan 141, edit 382, ball 887, snap 140, resClear 177, release 56 (edits, strokes, slides), meltSnap 325 / meltApply
  422 (melt), pick 441 (the pointer), shrinkFree / Move / Copy 48-65 (the pool's shrink). On use: sheetBake 646 and
  the sheet draw 91 (smooth), faceBakeOne 4,674 (measurement), capture 37 / captureSheet 182 (tests). Chrome is
  measured in aggregate (pipelines compile in parallel): cold first frame 6.8-7.2 s, every boot pipeline 12.8-14.3 s
  (round 18: the 28 synchronous pipelines, GPU done with the first frame at 22.3 s).

**As built (round 20; current state, with round 21's canopy and haze below): the textured draw** (the owner: "Please use high quality textures and lighting
for the next pass. Then let's keep a toggle so we can go back to fix the artifacts."; "when you add normal maps and
lighting the fine detail needs to match them when it loads in").
- *The toggle.* The "Textured" button and `?tex=0|1`, default on. Off is the round 6-19 shading exactly: `fs` and `fsS`
  are untouched (the box fragment body moved into `flatOut`, the same expressions); the vertex stages only gained
  outputs the flat fragments ignore. Checked pixel for pixel against a pipeline built from 3c1ccc33's draw.wgsl in the
  same page (scripts/nested-r20-flatcheck.mjs: boxes and sheets, three views each, 0 channels differ; the textured
  control differs). The textured draw is its own entry points (`fsT` boxes, `fsST` sheets, `vsSky` / `fsSky`) and
  pipelines, made asynchronously after the first frame (the flat draw and a status line until then; 450-470 ms in
  headless Chrome); the boot pipelines are unchanged.
- *One detail height, in world units (src/nested/gpu/detail.wgsl, its own snippet so nest.wgsl can include it).*
  `detailH(p, mat, band)` / `detailHG` (with its gradient): band b is 3D gradient noise of wavelength 2^(1-b) world
  units (16 bands, 2 down to 1/16384), amplitude proportional to the wavelength (every band the same slope, by
  material: stone 0.7, soil 0.45, sand 0.25, clay 0.5, x 1/2 pi). No derivatives, no texture sampling: callable from any
  stage. The point is a DPt: a level's integer window origin, s = L log2 k, its z origin and a level-local point; each
  band's lattice is periodic (4,096 cells) so the integer part is shifted into the lattice exactly and only the local
  fraction goes through floats. So the same world point gets the same lattice coordinate from any level, and the
  finest bands stay exact far from the world origin (an f32 world point holds 1/16 of the finest band's wavelength at
  x = 128).
- *The shading normal* (shade.wgsl texShade, shared by both draws through draw.wgsl texOut) = the geometric normal the
  crease rule picked (fsST keeps fsS's rule: the interpolated vertex normal within the crease angle, flat beyond),
  bent by the bands' surface gradient. Which bands: from the pixel footprint (the level-local point's screen
  derivatives, the shorter axis but at least a quarter of the longer) a band fades out as its wavelength goes from 4 to 2
  pixels; at most 6 bands are used, the coarsest fading out as a finer one fades in. `?bands=all` (default) uses every
  band; `?bands=split` only bands finer than 2 columns of the drawn level (fade from 2 to 1 column), the cut-off the
  next round needs once the bands between two levels' column sizes are in the finer level's geometry. The window
  depends on the world point and the footprint only, never the level: test/gpu/nested-detail.test.ts shades 512 points
  from adjacent levels (each given as that level would: its own window origin, local point and z origin) and finds the
  colour the same to 2.6e-5 under bands=all; under bands=split they differ (0.14).
- *Materials.* Colour detail from the same bands (and one broad noise, 8 world units, that the window never drops):
  stone with strata in world z (two spacings beating, bent by the noise, as tone and small ledges on steep faces) and
  thin sparse cracks on steep faces (a second noise's zero line, at least a pixel wide); soil as grass where the
  geometric normal is up (smoothstep 0.55-0.78 on nz, moved by the bands and the broad noise: grass keeps the hollows),
  dirt on slopes; sand with wind ripples (0.04 world units) on up-facing sand; clay with the band variation. No
  triplanar projection: the noise is 3D in world space, so nothing stretches on cliffs and ramps (a departure from the
  brief's "triplanar", same intent). Roughness per material.
- *Light* (linear): sun diffuse (the geometric normal gates it, so bumps on a face turned away stay unlit) + a Blinn
  specular by roughness with Schlick Fresnel; a sky / ground hemisphere ambient; occlusion from the band value
  (hollows darker, cracks darker); haze toward the sky colour along the view by world distance (exp(-0.0018 d)); the sky
  (horizon to zenith, a glow and a disc at the sun) drawn behind the levels as a full-screen triangle where the depth is
  still the clear value (its info target untouched); ACES fitted tone map and sRGB encoding (the canvas is unorm). The
  textured sun is lower than the flat draw's (about 38 degrees, NS-151). No shadows, no sky occlusion (NS-147).
- *Cost.* At most 9 3D gradient noises (8 hashes each) a pixel: 7 band noises (window 6 + 1 fading), the broad one,
  and on steep stone the crack noise. Desktop 960 x 640 (nested-perf --texab 1, same page): sheets 1.1-3.0 ms flat ->
  2.3-6.4 textured, boxes 2.3-9.7 -> 6.5-19.2 (box overdraw). `?texbands=N` sets the window (4: 0.5-1.7 ms less).
  Compile (Dawn): textured boxes 136-214 ms, sheets 176-244, sky 24-34 (under the 400 ms floor).
- *Diagnostics.* The level tint mixes over the textured colour as over the flat one; diag 1 and 2 draw the flat
  diagnostics in the textured pipeline; diag 3 shows the bands (NS-153).

**As built (round 21; current state): forest canopy from afar** (the owner: "I think we want the hills at the furthest
zoom to read as trees not grass but from miles away"). Shading only (shade.wgsl texShade, one block after the
materials); geometry, nest.wgsl, derive and the flat path untouched (flat check: 0 channels differ, boxes and sheets).
- *A stand-in.* Trees do not exist as objects yet, so on soil seen from far the ground is shaded as a closed canopy of
  rounded crowns, and on approach the forest fades to the round 20 grass (NS-154).
- *By the world-space footprint alone* (`pxW`, world units a pixel, the one the band window uses): canopy weight =
  smoothstep(-1, 1, log2(pxW / canopy)), so full canopy at footprints over twice `canopy`, grass under half of it.
  `canopy` = `?canopyfade=` (default 0.1 world units a pixel: the crown cell, 2 world units, is 20 pixels at half way,
  10-40 pixels across the crossover); `?canopy=0` off (uniform want.y = 0). Never the level or the distance: the same
  point looks the same from any level (test/gpu/nested-detail.test.ts, far footprints 0.02-2 world units a pixel:
  colour across levels the same to 7.4e-6; canopy on vs off differs by 0.17).
- *Where (a world-space field):* soil only (stone, sand, clay stay bare); the geometric normal's z 0.62-0.82 fades it
  out on slopes steeper than about 40 degrees; density = smoothstep(-0.2, 0.15) of a 32 world unit noise plus 0.3 of
  the broad 8 unit one: woods and clearings that stay put. Not lowered near carved edges (the fragment does not know
  them; NS-155). The understorey in the gaps darkens toward (0.06, 0.10, 0.05) with the density.
- *Crowns:* a jittered grid of 2-world-unit cells (6.4 m; the root column is 3.2 m) in world x, y (the DPt split, so
  exact from any level), one crown a cell, radius 0.5-0.8 cells with a lobed outline (6.4-10 m across: neighbours
  overlap into a closed canopy), kept where the cell's hash is under 1.2 x density (the forest thins to scattered trees
  at its edge), the taller (larger) crown on top where two overlap. Each a rounded cap whose gradient (capped near the
  rim at about 2.7) bends the shading normal through the same light; band bumps doubled on crowns; occlusion lower in
  gaps and at crown rims. At grazing views (|view . n| 0.2-0.7) the crowns grow up to 1.3 x, so the gaps behind front
  crowns close. Colour per crown (dark blue-green to yellow-green, by the crown's hash and the broad noise: stands) and
  brightness per crown. Crowns under about 4 pixels (pxW over 0.35-0.7) fade to their area mean (no shimmer).
- *Haze:* round 20's haze toward the sky colour made far hills milky. Now the in-scattered light is the sky along the
  view times (0.56, 0.66, 0.82) (dimmer, bluer: aerial perspective darker than the sky behind) and the rate 0.0011 a
  world unit (was 0.0018): far wooded hills read blue-green and dark. This changes the textured look everywhere, also
  with `?canopy=0`.
- *Cost:* no extra noise where the canopy weight is 0 (footprint under canopy / 2, not soil, or steep: a branch;
  texShade takes no derivatives, so it is safe in non-uniform control flow); else the density noise (one 3D gradient
  noise, 8 hashes) and where the density is above 0 the crown cells (9 hashes, 9 atan2): 2 noise-equivalents a pixel.
  Draw ms, desktop 960 x 640, sheets, same page (nested-perf --smooth 1 --canopyab 1, medians of 3): hillside 8.25 off
  -> 7.88 on, the map 5.43 -> 6.78, far overview 8.19 -> 8.61 (the run's noise is about 1 ms; another agent may share
  the GPU). Compile: textured boxes 198 ms, sheets 183 (budgets 400, unchanged).
- *Stills* (local/nested/r21-<pose>-canopy|grass.png, scripts/nested-r21-stills.mjs): far (332 m up), low (across
  hills to the horizon), hillside (round 20's overview), mid (the crossover on a slope), closeup (round 20's).

**As built (round 22; current state): round edges, the sheets' slide** (the owner: "If you can fix the rim artifacts
first as they are distracting. I really want the look of something like dual contouring but without the cost"; "I
thought we were going to displace vertices horizontally within their cell too to make rims read as round?"; "I like a
hard crease at a rim"). The rim teeth came from the sheet vertices sitting on lattice corners: a carved circle is a
staircase of cells, each corner between a carved and an uncarved cell collapsing its step to one vertex at the mean.
- *The edge sample (src/nested/edge.ts; store.wgsl EDGE_MASK).* A record's material word has spare bits (materials use
  bits 0-7). Bits 8-29 hold its top's edge sample: bit 8 on, bits 9-17 the angle of the edge line's horizontal unit
  normal n (512 steps a turn), bits 18-29 the signed distance d from the column's centre to the line along n (4096 steps
  over [-2, 2) columns of that level). n points out of the brush, so d > 0 inside the brush's outline. 0 is "none", the
  default everywhere: no record, page, memory or generator change. Bit 30 is RES_EDGE in a residual record, bit 31 the
  residual's WHOLE flag. Every material comparison masks 0xff (matSolid, sameMats, sameAcross, pack's merge, melt's
  structure hash); the draw already used `& 255`. Per record, any material (air records never carry one: pack writes
  air as MAT_AIR). Only UP surfaces carry samples (an interval's top in the solid view): a down surface's record is air.
  The CPU keeps the field in parallel arrays (Part.edge, Col.edge); Snapshot.records / column split the word.
- *Brushes write it (nest.wgsl ball, ballEdgeAt; oracle.ts edit, ballSample, ballEdge).* A carve or add grows its box by
  EDGE_PAD = 3 columns (plan; the CPU's reserve bound too). For every column of the box with records: the reference
  height is its ORIGINAL top (before the brush), the circle is where the sphere cuts that height (for a carve's rim the
  circle where the sphere cuts the original surface; a stroke takes the largest R_b - rho_b over its sampled balls and
  that ball's normal), the sample its tangent line; written to the column's topmost interval when |d| <= 2, whether
  or not the ball touched the column (the uncarved side of a rim gets it on its existing top, height unchanged). A top
  the ball made (a carve's floor, an add's soil) has none unless that sample is written; a top it left keeps its own.
  Raise, dig and melt clear the sample of every top they move (they make no sharp edge). The generator writes none.
- *Enhance and restrict (nest.wgsl edgeEnh / matWord in derive, restrictEdge; oracle.ts enhanceBlock, restrictCell).*
  An edge is a straight line. Child from parent: d_child = (d_parent - dot(n, childCentre - parentCentre)) * k, same n,
  none past the range. Parent from children: of the children with the template's interval count that keep one (row
  order), the mean normal (normalised) and the mean of their line points (centre + d n, parent units) projected on it
  (not a least-squares line); none where the normals spread so far that their mean is under half their count (a feature
  smaller than the parent's cell has no single line). The residual: derive mode 1 stores, in word 2 of a top's residual record (2i + 1), RES_EDGE
  | the live edge where the live edge differs from enhance(parent)'s (so a column whose only difference is its edge gets
  a residual and a page); mode 0 takes it where the residual applies (gResOk), else the enhanced edge; a whole-column
  residual keeps the material word with its edge (word 2 & 0x3fffffff). So the edited level's own samples are exact
  after an edit and demote/promote (bit-identical in the self-test), and resClear's rule is unchanged (a finer level
  under a ball is enhance(parent) again, its edges included). The sheet hash includes the edges (an edge-only change
  re-bakes).
- *The slide (nest.wgsl sWalk; boxmesh.ts sheetMesh; edge.ts slideOf).* On a line whose four quadrants are the walked
  level's own drawn columns, each cluster's members (the owners' surfaces it holds, in the walk's order: height, then
  quadrant, i.e. absolute column position) bring their samples. Where some member's centre is inside the edge (d > 0)
  and some outside (the edge crosses the corner's cell), the vertex moves to p minimising sum (dot(n_i, p - (c_i + d_i
  n_i)))^2 + 0.05 |p|^2 (c_i the member's centre from the corner), clamped to a disc of 0.35 columns; else 0. The same
  inputs in the same order on every chunk that walks the line, so a shared corner gets the same bits everywhere. Stored
  in the cluster's word 1 (its `top`, read by no one after the bake's normal step: the walk keeps the slide in word 3,
  step 3 moves it to word 1 and writes the normal to word 3), pack2x16snorm(p / 0.5). The draw (vsSheet / sheetVert)
  adds it to the vertex's x, y when misc2.y is on and the vertex is not a rim vertex. Topology and identities are
  unchanged, so closure is unchanged by construction; the box draw is untouched.
- *Departure: the disc is 0.35, not 0.45.* A sheet triangle is half a unit square; its smallest altitude is 1/sqrt(2);
  each vertex moving at most rho moves a vertex's signed distance to its opposite side by at most 2 rho, so rho < 0.354
  never folds a triangle. At 0.45 the random carve test folded 8 triangles in its first run (diagonal edges, two
  corners' lines in conflict). Cost: a corner more than 0.35 from the edge stops short (on a radius 7.2 carve the
  farthest rim vertex is 0.35 columns off the circle, 0.70 unslid).
- *Level edges.* A line with a quadrant owned by the parent (a child's window edge, so every rim line and every zipper
  vertex) or by nobody (the root window's edge) slides nothing. The kink this leaves where a rounded rim crosses a level
  edge is a limit (NS-161).
- *Height at an edge corner, `?rimtop=0|1`.* 0 (default): the cluster's usual mean (a chamfer one column wide each side
  of the round rim line). 1: where the edge crosses the corner's cell, the mean of the members outside the edge (d <=
  0: the uncarved side of a carve; the ground round an add's foot), so the ground runs flat to a crisp round rim and the
  wall drops inside it (the owner's hard crease). A bake option (GpuNest.rimTop, set before the first bake; e.w bit 1).
- *Toggle.* `?slide=0|1` (default 1) and the "Round edges" button: draw only (the bake always stores the slide), so the
  switch is instant; with it off the sheets are drawn exactly as before (the offset is +0.0). Picking, the camera's
  ground distance and the brushes still use columns.
- *The look (stills local/nested/r22-* and r22rt-* (rimtop 1), scripts/nested-r22-stills.mjs; every pose slide on / off,
  textured / flat, in one page).* Plainly: rims do NOT read round yet. The slide alone changes little on screen: the
  teeth the eye reads are mostly (a) the HEIGHT alternation along a rim (a corner joining the floor and the top sits at
  their mean, its neighbour at the top: the slide moves corners sideways, not up), (b) the material per triangle (a
  stone column's triangles grey, a soil one's brown: the shards on a crater's wall, NS-150), and (c) at a finer level
  than the brush's, the parent's staircase of cells inherited through enhance's heights (8 child columns a stair; a
  slide of 0.35 child columns cannot touch it). `?rimtop=1` removes (a) at the brush's own level (the far rim of
  r22rt-crater-low and -closeup: the ground runs flat to the rim, no brown teeth) but at a derived level it raises a
  corner where the inherited samples are one-sided round it: spikes up the wall (r22rt-closeup, right). Next, in order:
  edge-aware enhance (a child takes the side of its parent's line it lies on, so finer levels round the rim instead of
  the parent's staircase), the material at a rim from the edge line (NS-150), then rimtop on by default.

**As built (round 23; behind `?rimsnap=1`, default off until the owner has seen the stills): the snap.** The owner:
"is it not sufficient to just snap them to stay within some epsilon of the column in the x,y plane? Then to shift them
to a surface intersection within that cell and to give them the normal of the surfaces at either side of the cut?"
- *Reach: the corner's own box.* A crossed corner (its members' samples on both sides of the edge: the edge line crosses
  the square its four columns' centres span) goes to the least-squares point of its members' lines (edge.ts slideOf,
  regulariser unchanged), clamped per component to +-SNAP_BOX = 0.49 columns (0.5 less SNAP_EPS 0.01) instead of round
  22's disc of 0.35. One straight line's point is always inside the box, so the rim vertex reaches the line (on a
  circle it lies outside by the cell's sagitta: 0.075 columns at R 7.2, NS-172). Corners the line does not cross do not
  move and keep their heights.
- *Height: where the brush's surface meets the original one.* A crossed corner takes the mean height of its members
  outside the edge (d <= 0: the uncarved ground at a carve's rim, the ground round an add's foot), as `?rimtop=1` did:
  the ground runs flat to a carve's rim, the mound rises from the ground at its foot. (The mean, not the original
  surface evaluated at the slid point: NS-171.) So the "low" side of a mound is the ground outside its foot, the high
  side of a crater the ground outside its rim; in both the steep triangles are the brush's own columns'.
- *Folds: the diagonal per quad.* With every corner in its own box a lattice quad stays a simple polygon but may be
  non-convex, and the fixed diagonal (corners 0-3) then folds one triangle. Measured over 26 scenes (6 random carve / add
  sequences on two levels, 12 of tight circles R 1.5-3, 8 of crossing rims; test/unit/nested-snap.test.ts): fixed
  diagonal folds 230 triangles at box 0.49, 188 at 0.45, 125 at 0.40, 73 at 0.35; the diagonal chosen per surface (the
  fixed one unless one of its triangles folds and the other diagonal's (1-2) do not) 0 at every box; per column 0 too.
  Built: per surface, box 0.49 (sheetBake step 4 writes the choice as sheet flag bit 3; the draw's corner table follows
  it; the reference does the same). The choice is from the quad's own four corners, all in the column's chunk, so every
  bake of it agrees. Zippers (the 16 fan slots along a level edge) are not affected: their vertices are on level-edge
  lines, which never slide.
- *Normals per side.* A slid vertex shades with its own quad's normal (from the quad's slid corners; packed in the sheet
  flags' spare bits 16-30 as an 8 + 7-bit octahedral normal, bit 4 on): a ground triangle at the rim is lit as ground, a
  wall triangle as wall, a hard crease at the rim by construction, smooth elsewhere. Cost: no word more in the baked
  vertex or cluster; one more read of the flags word a vertex is already read. Flat per quad rather than smooth per side
  (NS-173). A collapsed (zero-area) quad gets no normal (bit 4 off: the cluster's), so no NaN.
- *Closure* is by vertex identity and unchanged; where a thin pocket's two surfaces choose different diagonals, the pair
  rule cancels other triangles (2-4 more in 4 of 26 scenes; NS-174).

**As built (round 24; behind `?edgeenh=1`, on with `?rimsnap=1` unless `?edgeenh=0`, default off): edge-aware
enhance.** The owner: "the data should really all be in the columns and as long as we fix popin I don't really care if
it's perfect as long as it looks good." A finer level should follow its parent's edge line, not the parent's staircase
of cells (NS-170). Reference: oracle.ts enhanceTops / homeTop / enhancedCol (Nest.edgeEnh); GPU: nest.wgsl derive
(wPEdge, edgeFill, the home reductions, gSe) and restrictK (the same per-child loop gathers the top's line and sides).
- *Which blocks.* Only a block whose parent's TOP interval carries an edge sample; every other block is bit-identical to
  before (and with the flag off, everything is).
- *Sides.* A parent cell of the 5 x 5 stencil is on the side its own top sample says (d > 0 inside), else on the side
  the block parent's line puts its centre. A child is on the side its own enhanced sample says (edgeToChild, the bits
  stored), else the parent's line at its centre.
- *A child's top.* The limited PPM of the 5 x 5 tops with every cell on the other side replaced by the child's side's
  surface carried on to it: from the nearest same-side cells (least squared distance, all ties averaged), linearly
  where the next cell back is on that side too, clamped between that cell's top and the cell's own top (the rim is a
  crease: the two surfaces meet, they do not cross). A constant fill was tried first: the inside of a steep bowl came
  out one parent column of slope too deep (height error mean 0.62 against 0.25 plain at level 2).
- *Parent = mean of its HOME children (the change to "parent = mean of its children").* Home: the side most of the
  block's children lie on (which is the parent centre's side: the children are point-symmetric round it), a tie by the
  sign of the sum of the children's samples. Enhance corrects only the home children to the parent's mean (the sin^2
  bump over them); the others keep their side's surface. Restrict, where the restricted parent's top keeps a line,
  takes the top as the mean of the home children's tops (sides from the children's own samples, which enhance wrote,
  so both pick the same home), and every other bound as before. So restrict(enhance(P)) == P; block volume is not kept
  where a line crosses (NS-181).
- *Only the top moves.* The edge-aware top replaces the top interval's z1 alone, never under its z0; the gaps and
  thicknesses below and a whole residual column's surface stay the plain ones. A top pulled under its z0 empties the
  interval (pack drops it; NS-182).
- *Drift (test/unit/nested-edgeenh.test.ts).* Carve at level 1, zoom in to 3, out, in again: 0 (every column bit-equal;
  enhance is a function of the parent). A restrict over all of level 3 (an edit that changes nothing): level 2 moves
  2.7e-15 level-1 units, level 1 1.8e-15.
- *The reference.* A circle (r 10, centre 2 over the ground) carved at level 1: columns carved on the wrong side of the
  true circle 215 at level 2 and 627 at level 3 with plain enhance; 32 and 46 edge-aware (2 and 28 more than a column
  off); the snapped rim corners within 0.105 (level 2) and 0.253 (level 3) columns of the circle either way.
- *The spikes on derived levels (r23a-crater-low, -closeup), cause.* Reproduced in the reference on a k 8 hillside
  (spikes test): a slid corner whose members' samples are one-sided (two members carry samples from one parent block's
  line, the other two none, from a block the samples do not reach) takes the "outside" member's height, which sits on
  another stair of the inherited staircase. Edge-aware enhance removes it in that scene (0 spikes over 0.5 against 1).
- *The look: NOT right yet (local/nested/r24a-edgeenh0-* against r24a-edgeenh1-*, rimsnap=1 both).* In the game the near
  rim gains a row of small brown spikes, the far wall keeps its staircase and the tall dark spikes stay (NS-179). The
  oracle self-test with the flag fails 3 of 27: GPU and oracle already write a few edge samples differently, and the
  home rule turns a flipped sample into a height difference (NS-180). Default off; the owner cut the round's scope.
- *Cost.* Compile: derive 2,316 / 2,328 ms against 1,985 before (budget 2,700), restrictK about 820 against 661 (1,400);
  a first version with a second PPM copy measured 3,852 / 1,438 on a loaded machine, so the PPM runs in one loop over
  two passes and restrictK gathers sides in the loop it already had. Carve and sheet pass not measured (NS-178).

## The baked draw (round 3; the owner's ruling "deforming vertices and baking the seam mesh nothing per frame")

SUPERSEDED by "The box draw" (round 6); kept for the history.

- **What is baked, when.** Every op that changes a level's live columns (root, promote, slide, edit: the edited,
  restricted and derived regions) bakes that region grown by one chunk (a column's normals and its quads reach its
  neighbours), parents before children, then rebuilds the draw's page list. Nothing is baked per frame; the camera and
  the draw only read.
- **The gap table** (GAP pages, level id 16 + depth, same keys and page shape as the columns): for each column its air
  regions (gaps) as three records each: floor, ceiling, materials; the solid run's bottom and the floor and ceiling
  normals; the links (the corresponding gap of the neighbour at +x, +y, +x+y, -x, -y, -x-y, mutual nearest floor, 16
  bits each). Allocated only for chunks where some column, or a neighbour of one, has more than one gap; elsewhere a
  column's one gap is read from its intervals. Normals are central differences of the linked neighbours' floors
  (ceilings), so floors and ceilings shade smoothly across quads (NS-33), and the top sheet beside an overhang takes
  the floor its neighbours' matching gaps continue, not the step up to the overhang's top.
- **The mesh items** (MESH pages, level id 24 + depth, only for chunks that have items; 432 items of 29 words a page,
  stacked pages as needed): for each triangle of a quad with a corner of more than one gap, one item per region (the
  air connected across the triangle's corners by the links, each region seeded at its first corner, so every corner's
  gap is in exactly one region). An item holds, per corner, the gap's bounds, normals and materials, and the parent's
  matching bounds and presence there (the rim morph's targets). A triangle is the top sheet's when its three corners
  have one gap each, else B's: the two never overlap or leave a gap between them.
- **The draw.** A: the indexed grid, vertices deformed by the stored heights (unchanged), its triangles beside B's
  discarded by a per-vertex flag. B: one indirect draw a level over the page list (an instance per item slot; empty
  slots cost one read). The vertex stage cuts each item (marching triangles on a presence field) and walls the cut
  (an enclosed region from floor to ceiling, the sky down its solid run). The rim morph and the fade are per-vertex
  blends driven by the uniform's time: heights toward the parent's baked targets, and for enclosed regions the presence
  itself (child's own 0/1 toward the parent's interpolated presence), meant to slide a tunnel's wall to where the
  parent's wall stands at the rim. Not enough yet: the lip ring still shows where a tunnel crosses the level-2 rim
  (NS-21 open).
- **Sizes and overflow.** Gap and mesh pages come from the one pool like column pages (reserved with the op, the pool
  grows; a kernel that cannot get a page counts a refusal, shown on the page). The page list is sized to the pool
  (rebuilt by every op, so a grow needs no copy). Nothing is capped or dropped.
- **Cost.** Tunnel scene at depth 2: a carve's bake adds ~2-6 ms of GPU time to the edit (7-12 ms without it); the
  bakes read their chunk's and the parent's pages through a per-workgroup cache of the 3 x 3 chunks' page ids.
  Pages: the tunnel scene with three levels holds ~1370-1420 pages (was ~800): the tables round the tunnels at depth 2.

## Footprints (round 4 step 3: the design, written before any code; F1-F3 built, see the changes below)

PARKED (round 6): removed from the code. Five rounds of matched sheets and footprint cuts did not close (8,215 open edges
at F4); the owner chose blocky boxes ("never any meshing ambiguity") and the partition record. Smooth meshing returns
later as an optional step, from the owner's sheet-and-contour idea in "Decisions with the owner (round 6)".

The owner: "I would keep heightfields and borders distinct and use SDF with masks for the latter", and for layer edges
"let's wait for SDF and then we can have nicer material boundaries at zoom". Today the draw knows only whether an air
region is present at a column centre (0 or 1) and cuts half way to a column that lacks it: the staircase round a mound,
the teeth on tunnel walls, the lip ring at a rim, and (round 4 step 1) the cracks the manifold check finds where a cut
ceiling, a cut floor and a wall each choose their own cut.

**The quantity.** Every interval i carries two signed distances in plan, in its level's column units, positive inside:
`eS` to the edge of the interval's own footprint (where the solid run exists: a blob, an overhang's lip) and `eG` to the
edge of the gap below it (where the air between interval i - 1 and i exists: a tunnel, a cave). One word, two f16, as a
fourth word of the interval record (page 256 + 256 x 16 x 4 words = 65 KB, +33 %; with NS-37's 32 x 32 x 4 pages the same
+33 %). Change from the coordinator's proposal (one value an interval): a tunnel's footprint is the gap's, a blob's the
solid's, and in layer form these are different boundaries of the same interval; one value cannot place both. Packing
both into the material word's spare 16 bits (8 bits each, 1/64 column) was considered: too coarse to scale by k = 8
through enhance and keep the residual exact. (Decision 2026-11-18, docs/DECISIONS.md: air is a material and the default;
at the next record-layout rework, NS-37, air becomes an explicit interval with one edge distance an interval, replacing
the eS / eG pair: BACKLOG NS-51.)

**Ghosts (the coordinator's, kept): the structure stays constant across the edge.** The ring of columns just outside a
footprint keeps the interval (or the gap) with a negative distance and ghost bounds: where its top and bottom (floor and
ceiling) would be there. A ghost is not solid (not air) for every consumer: restrict's volumes, the camera, the pick,
the brushes, melt count its thickness as zero (one helper, `present(e) = e > 0`). Why ghosts and not extrapolation from
the inside column alone: with values on both sides of every edge, enhance is a plain interpolation that creates the
children's structure correctly (a child inside the parent's contour gets the interval from a ghost parent, with bounds
interpolated toward the ghost bounds), and the draw's cut is an interpolation between two stored values. Ghost bounds:
for a ball the top and bottom meet at the equator height (the shell pinches closed at the contour); for a cut cliff
they stay apart (a wall stands at the contour). Ring width: one column (marching needs only the neighbour across each
edge); a brush writes ghosts within its radius + 1 column. A ghost with no present neighbour and e < -1.5 is dropped
(when the column is next rewritten).

**Cost of the ring.** A ring column gains one interval (a blob's ghost) or one zero-thickness split (a tunnel's ghost
gap): +1 or +2 records, pages only where a column crosses K (16 today; 4 with NS-37's pages, where tunnelled terrain of
3-4 intervals would stack a second page along the ring: to be measured). NS-6's zero-thickness intervals become the same
thing as ghosts (a dug-out layer: thickness 0, e > 0, drawn as nothing).

**The draw: one cut per edge, shared.** The bake's items keep their shape (marching triangles per air region per
triangle); the presence field becomes the distance: a corner's s is the region's e (the gap's eG for an enclosed region,
-eS of the run below for the sky over a blob), and the cut point on edge A-X is at t = eA / (eA - eX), its floor and
ceiling the bounds of A and of X's ghost interpolated by the same t. Every face that meets the edge (floor, ceiling, wall,
the neighbouring triangle's) computes that point from the same two corner records, so they share it bit for bit:
watertight by construction, and the manifold check (step 1) must show 0 open edges before anything else. A wall joins
floor and ceiling at the contour only where they are apart (cliff); where they meet (ball) there is no wall. Normals from
e's gradient on the wall.

**Brushes.** Analytic distances combined with what is there: a ball of radius r at the column: eBall = r_slice - d_plan
(r_slice the ball's radius at the interval's height, so a ball's gap pinches at its equator); carve: eG = max(eG,
eBall) for the gap it opens, eS = min(eS, -eBall) for runs it cuts away; add: eS = max(eS, eBall). Raise, dig and melt
move bounds and keep e.

**Nesting.** e is a channel like a bound: enhance interpolates it (times k: child columns are k times finer) with the same
bilinear stencil as gaps and thicknesses, restrict averages it (divided by k) over the block's template, the residual
keeps it exact (a third residual record per interval, or the spare halves of the existing ones). Demote then promote stays
bit-identical; oracle and self-test cases: a ball's footprint through promote, demote, promote; a contour across a block.

**Rims.** In a child's rim band its e morphs toward the parent's e interpolated at the child's corners (times k), as heights
do now; the contour then slides continuously onto the parent's, which should remove the lip ring (NS-21). Checked in the
rim-crossing still, tint on and off.

**Changes made while building (F1-F3, 2026-11-18).**
- *The brush's one structural decision (the site), made once a brush from the column under its centre, in the plan
  pass.* Carve: if a gap a brush made (a ghost, or one with some thickness or a footprint nearer than E_FAR; not the
  zero-thickness boundary between two materials) lies within the ball's radius of its centre in z, no new structure: that
  gap is reused (grown to the span where the span misses it, as a swept capsule would); else the highest solid interval
  starting at or below the centre is split (at a tunnel's mouth the top interval splits and its upper piece is a
  zero-thickness ghost, so the mouth keeps the hill's structure). Columns of the centre column's interval count split at
  the site's index; others decide the same way locally. Add: the ghost interval holding the centre is revived; else an
  interval within the ball's reach makes no new structure (the ball is laid on it; a span floating in air above it is
  filled from the solid below); else a new interval is inserted into the air holding the centre. Why: the design's "eG =
  max(eG, eBall) for the gap it opens" did not say which gap; splitting at every ball made a stroke's columns differ in
  count every few columns, which the draw cannot match by index.
- *Nothing is removed.* An interval a ball covers keeps its bounds as a ghost (eS = min(eS, dd - r_slice) at its bounds:
  negative), so the structure stays constant; a ghost's thickness is air for every consumer (restrict counts it as
  enclosed air, a ghost gap's thickness as solid of the interval above it).
- *Restrict's footprints:* the mean of the children's clamped to +-E_SAT k (E_SAT = 2) over the children of the
  template's count, divided by k; a block saturated everywhere gives back E_FAR (so restricting an unedited block is the
  identity on e). The GPU compares the sums, not the quotient (its f32 division is not exact).
- *Ghosts are never dropped* (the design's "e < -1.5 is dropped when next rewritten"): dropping one changes a column's
  count beside its neighbours. They accumulate (NS-52).

**Changes made while building (F4, 2026-11-18).**
- *The draw is per slab, not per region.* A triangle of corners of one interval count draws, for each slab s that has a
  face or a wall there, one item: the face at H_s where slab s and s + 1 differ (solid below and air above: up; the other
  way: down), and slab s's wall along its own zero line. The design's "a corner's s is the region's e" became one air
  field per slab (an interval's -eS, a gap's eG), so floors, ceilings, overhang undersides and the blob's sky all come
  from the same rule. Cut points on an edge from the edge's two corners in one order; crossings of two slabs' lines inside
  a triangle from one function: walls split there, faces have a vertex there.
- *Thin slabs are neutral.* A slab thinner than GAP_MIN (zero-thickness ghosts, dug-out layers) takes the occupancy of
  the nearest thick slab below it (else zero-thickness air between two solids drew two faces back to back).
- *Triangles whose corners differ in count* keep the old region items (half-way cuts); where they meet slab items an
  edge can still open (NS-55). The brush rules are what keep such triangles rare: carve reuses a gap a brush made within
  reach, or in the air run holding its centre (thin slabs do not break a run); add revives a ghost interval in that air
  run, else reuses an interval a brush made within reach, else inserts into the air holding the centre (or just above the
  solid holding it). (The F3 add rule that laid a ball on the ground by filling from below is gone: it made the stalk's
  blob a pillar.)
- *The top sheet's ownership is per vertex* (a flag: more than one air run, or a cut edge); B draws every triangle with a
  flagged corner. A ring of 3 columns was tried so those triangles' corners all share the structure: no fewer open edges,
  more ghosts; RING stays 1.5.

**Build order** (each step shown; the manifold and screen checks run at every step): F1 the oracle (e in the columns,
enhance, restrict, residual; unit tests). F2 the GPU store's fourth word and readers; self-test parity. F3 the ball
brushes write e and ghosts; oracle parity. F4 the bake and draw cut on e; the manifold check to 0, then into ?selftest=1.
F5 the rim morph of e. F6 the before/after stills (mound outside, tunnel inside at depth 2, tunnel mouth, rim crossing,
arch, blob on a stalk, a zoom-out/zoom-in pair on a mixed block for NS-28).

## Recorded ideas (the owner's, 2026-11-19; not designed, not built)

- **Watertight checks are tests, not runtime.** "I would probably run the watertight check only in unit tests unless it
  is very cheap. It should be watertight by construction. Unit tests make sure that doesn't break. Runtime remains
  optimized."
- **Flow.** "the only difference between materials with flow and those without is a separate flow buffer linked to the
  interval (somehow). That way exposed fluids or things like sand can animate flow." Fluids and loose material use flow
  and an angle of repose in the tick; solids use the column-mediated support computation for collapse, which hands over
  to the physics engine's destruction and deformation (DESIGN.md sections 7-10). Planned route here: flow on parallel
  pages addressed by the same page and slot as the interval, allocated only where a page holds a flowing material; a
  child's flow starts from the parent's steady flux and only the difference at its boundary goes back up.
- **Smooth meshing (parked; optional step after boxes).** "a sheet with one vertex per cell and one sheet per layer
  adjacent to an air interval. Then for any solid interval adjacent to air laterally we mesh between the top and bottom
  vertex in the interval and connect to neighbors." Edge cases as in marching squares, simplified by triangulating the
  plan grid (marching tetrahedra); preferably a signed distance and contour for the edge. Built only on the partition
  record (no representation with unpaired bounds).
- **Deep stacks.** Later routes, neither built early: materials with function-driven internal boundaries; an orthogonal
  column grid for a vertical surface. Related: an interval as a thickness swept out from a baseline surface.
- **Medial axis of interval volumes.** "you can compute this fairly cheaply in 2D by taking the midpoint along Z and
  then doing JFA only in a bent 2d surface in that sheet." Assessment (coordinator): sound for slab-like volumes
  (bridges, arches, roofs, tunnels as air volumes): per column, half-thickness and the JFA's lateral distance; the
  smaller is the local radius, the ridge of the lateral distance is the spine. Caveats: tall thin shapes (use the plan
  skeleton plus the interval's own height range); stacked intervals make the sheet multi-valued, so JFA runs over
  interval adjacency by height overlap and long jumps can leak across breaks; plan distance, not distance along the
  bend. Uses: necks for breaking (section 9's support x distance), edge distances for smooth meshing derived instead of
  stored, the mid-sheet as the baseline to sweep from, tunnel centrelines for flow and routes.
- **Many grids.** "keep the multi grid representation so I can make islands in their own reference frame floating by.
  The enhancement only need to happen for nearby objects so we can do this for whatever the active reference frame(s)
  grids are only."
- **(round 8) Roadmap order.** Streaming, smooth rendering and terrain functions; then simulation and fluids; then
  multiple grids with animated floating islands in their own reference frames; then animated creatures you can carve
  cities into.
- **(round 8) A phone bench with dials** such as columns per level (next round).
- **(round 8) A level's base as a variable surface** instead of a constant, and columns defined relative to bones with
  normal skinning at joints.
- **(round 8) Fine edits seen from afar.** "splat the edit into a bump map on the parent zoom or if it is big enough
  promote it into actual geometry"; partial raises as "a small instanced mesh or bump of the residual"; tunnels "shade
  them completely dark and then fade in as we load geometry".

## Open questions

- Scale factor per level: 8, or smaller (4) for gentler steps?
- Which lab: the terrain branch's sandbox, or a new bare page with only terrain?
- How large is a child, in parent cells, on the phone and on the PC?
- Camera: the free eye with collision (provisional), or an orbit camera round a target (with the same collision)?
- Enhance (provisional, round 3): the limited PPM of the top surface (above). Is a mesa-like edge at a step (no
  overshoot, but a cliff that stays a cliff) the look wanted? Not done yet: tunnel floors and ceilings reconstructed
  from their own neighbours (they still hang from the top surface through bilinear thicknesses and gaps: NS-43).
