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
- Zero-thickness intervals are kept, so neighbouring columns keep matching structures after a dig (BACKLOG NS-6).

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

## Column correspondence (round 2; the Storage section's rules extended)

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

## The baked draw (round 3; the owner's ruling "deforming vertices and baking the seam mesh nothing per frame")

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

**Build order** (each step shown; the manifold and screen checks run at every step): F1 the oracle (e in the columns,
enhance, restrict, residual; unit tests). F2 the GPU store's fourth word and readers; self-test parity. F3 the ball
brushes write e and ghosts; oracle parity. F4 the bake and draw cut on e; the manifold check to 0, then into ?selftest=1.
F5 the rim morph of e. F6 the before/after stills (mound outside, tunnel inside at depth 2, tunnel mouth, rim crossing,
arch, blob on a stalk, a zoom-out/zoom-in pair on a mixed block for NS-28).

## Open questions

- Scale factor per level: 8, or smaller (4) for gentler steps?
- Which lab: the terrain branch's sandbox, or a new bare page with only terrain?
- How large is a child, in parent cells, on the phone and on the PC?
- Camera: the free eye with collision (provisional), or an orbit camera round a target (with the same collision)?
- Enhance (provisional, round 3): the limited PPM of the top surface (above). Is a mesa-like edge at a step (no
  overshoot, but a cliff that stays a cliff) the look wanted? Not done yet: tunnel floors and ceilings reconstructed
  from their own neighbours (they still hang from the top surface through bilinear thicknesses and gaps: NS-43).
