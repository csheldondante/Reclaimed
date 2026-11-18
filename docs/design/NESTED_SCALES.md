# Nested scales: zoom in and sculpt inside a larger live scene

Status: DRAFT for the user to mark up (2026-11-18). Nothing is built. No builder runs until this is agreed.
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
- A page is 16 × 16 columns × K = 16 intervals. An interval is three words: z0 (f32), z1 (f32), material | aux << 16.
  A page also holds each column's interval count in that page. Page size 256 + 256·16·3 words = 49 KB.
- Pages are keyed (level, cx, cy, cz) in global chunk coordinates of that level's depth. cz is interval overflow:
  intervals 0-15 of a column are in cz 0, 16-31 in cz 1, and so on. A cz + 1 page exists only where some column of
  the chunk has more than 16 · (cz + 1) intervals. There is no cap on intervals a column.
- Open-ended intervals: a column's first interval is open downward (z0 = the OPEN_BOTTOM sentinel, stone); above
  the last interval is air, open upward. Air between intervals is a gap and costs nothing.
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
- **Pool full.** The CPU grows the pool before an operation when its free pages (a tiny counter read back
  asynchronously, never awaited on the interactive path) plus the operation's worst case would not fit: a bigger
  buffer, the old one copied in on the GPU, and the bind groups made again. If a kernel still runs out it counts a
  refusal; the page shows the count as an error. Data is never dropped silently.
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
  intervals (count and materials). S: bicubic Hermite with central-difference gradients per parent sample
  (Catmull-Rom), plus seeded detail (value noise in global child columns, wavelengths 2..k child columns,
  amplitude 0.06 x wavelength), then a bump correction sin²·sin² so the block mean equals the parent exactly. Gaps
  and thicknesses: bilinear from the 2 × 2 nearest parent samples that have the same intervals (else the block's
  own value), then scaled per block so their mean equals the parent's (non-negative, mean exact).
- Restrict: the parent column's S is the mean of its block's S, its gaps and thicknesses the block means (in parent
  units). Per-material volume is conserved by construction. A block whose children disagree on intervals (count or
  materials) is counted as a mismatch and left alone; no edit in the lab makes one (BACKLOG NS-5: matching columns
  of different structure).
- Zero-thickness intervals are kept, so neighbouring columns keep matching structures after a dig (BACKLOG NS-6).

## Built so far (branch `nested-scales`, page nested.html)

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

## Open questions

- Scale factor per level: 8, or smaller (4) for gentler steps?
- Which lab: the terrain branch's sandbox, or a new bare page with only terrain?
- How large is a child, in parent cells, on the phone and on the PC?
