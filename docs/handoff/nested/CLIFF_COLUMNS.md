# Thread: stylized cliff columns (rounds 31-32) — ACTIVE

## The idea, in the owner's words
- "generally we get flatter traversable sheets that give way to steep jagged stylized stone that we can zoom
  into cleanly."
- "It's a voxel renderer that works in a compressed column space for very steep surfaces and a normal
  heightmap elsewhere so we can take lessons from both."
- Why they like it: "we can use clean textures for most ground, the mesh visualization stays closed and looks
  like the fine detail at a distance and the stylized cliffs seem visually nice and create natural areas of
  high frequency noise against the smoother terrain that units will move along."
- Mandate: "your job now is to orchestrate and derisk early and see if we can get this look."

## Rules the owner set (several were corrections of what the orchestrator built)
- Column TOPS are smooth and touch the neighbouring sheet seamlessly. No random height per column.
- Noise is HORIZONTAL: which fine columns stand out is ragged in plan.
- Fine detail comes in and out along a cliff with slow noise.
- Drawn edge lines must be tiny relative to a column (a 1 px line on 3 px columns caused dark stripes).
- Vertical columns alone already look good; texture the faces with horizontal noise as strata.
- Notches: "The little notches really don't add much at all though and are not worth it." Coarse notches
  (8 m, 4 m levels) "will make the more dramatic overhangs"; heights should be 0.1-0.9 of the drop. Notches
  are "an experiment and we can proceed even if they fail".
- Optional: small drops-only height variation on the 0-2 fine columns at an edge (erosion). Built on the CPU
  only, not judged yet.
- Walls may cost more: "Walls and ledges are expensive because they have the most geometric detail that's
  unavoidable." The march may walk to pixel resolution or maximum depth.
- "it's fine if course edits obliterate fine authored detail on the same cells. I expect it to."
- Hand-over: "Can't we use the same hash plus the parent data to construct the geometry for the same apparent
  columns?" Yes: that is step C below.
- The steepness threshold will need tuning; per material is "a cool extension but only once we can get
  something we are happy with here".

## What exists
Round 31 (shader fakes on a plane fitted per pixel; superseded, kept behind switches):
`?cliff=1` painted blocks, `?cliff=2` single-level marched columns (+`cliffSmooth`), `?cliff=3` nested levels
(compiled in only when on). Lessons are in "As built (round 31 …)".

Round 32, the real thing:
- **Step A, the rule on the CPU**: `src/nested/exp/cliffrule.ts` is THE definition (integer maths, heights in
  1/64 m, integer hashes). `src/nested/exp/cliffview.ts` renders it on the CPU; `test/unit/nested-cliffrule.test.ts`
  (pictures with `RA_PICS=1`, into `local/nested/rA*.png`). Rule: a 16 m cell is steep when the height range
  over itself and its 4 neighbours exceeds T cell widths; a steep cell strictly between its lowest and highest
  neighbour is SPLIT: every fine column in it is either up at H or down at L (H/L = the hi/lo neighbour's
  height if that neighbour is a sheet, else the midpoint with it); the share up is (h-L)/(H-L) so the mean is
  kept; which columns are up = a score across the cell plus nested hashed offsets (8/4/2 m about a cell each,
  finer ones small and masked), zero-sum between siblings; an O(1) conservative bound for the march; a stored
  per-cell correction `dTheta` makes the mean exact. Port notes for WGSL are in the As built section.
- **Step B1**: `src/nested/gpu/cliffrule.wgsl`, `?cliff=4` paints the rule on real terrain. The WGSL equals the
  TypeScript on 10.7 million fine columns of a real window (0 mismatches; `test/gpu/nested-cliffrule-wgsl.test.ts`).
- **Step B2**: `?cliff=5`. `cliffbuild.wgsl` builds a per-cell table and a box list on the GPU when the 16 m
  window changes; `cliff5.wgsl` draws one box per SPLIT cell and marches the cell's quadtree in the fragment
  shader; sheets discard SPLIT cells; `src/nested/cliffbox.ts`. Holes 0 in three views (3 px in one). Strata
  (`?cliffStrata=`), face fill, `?cliffT=`, `?cliffPx=`, `?cliffAmp=`. At most 8 storage buffers per stage.
- **Step B3** (commits bc5b0deb, 0a6e69f1; scripts `nested-rB3-bench.mjs`, `nested-rB3-brush.mjs`):
  - Overdraw cut, both on by default: back faces collapsed in the vertex stage; the box list sorted front to
    back at table build (two orders, picked per frame from the camera's forward vector, no CPU work). Box pass
    GPU ms before -> after at T=2: far 3.27 -> 1.87, near 5.81 -> 3.56, above 3.47 -> 3.11, foot 3.92 -> 2.77;
    at T=4: 2.05 -> 1.44, 3.44 -> 2.68, 1.56 -> 1.29, 4.39 -> 4.26. Look pixel-identical. Whether hidden
    fragments are rejected before shading depends on the hardware (discard + depth write); true on this
    desktop, UNVERIFIED ON PHONES (NS-296). Drawing the solid part under each box first gained nothing
    (`exp/nested-b3-low`).
  - Sphere carve and add with the lab's brush under `?cliff=5` (stills `local/nested/rB3b-*`): inside SPLIT
    cells the brush's finer shape is NOT drawn; rule columns from the 16 m means replace it (this is the gap
    step C closes). At T=2 an 80 m bowl's walls and an 80 m dome's flanks become columns, floors and caps stay
    sheets; at T=4 none of the four balls split. HOLES appear around the balls (73-199 px, NS-302) and at
    side2 with T=4 (31 px, NS-300): not looked into.
  - `?cliffT=0`, the rule everywhere (stills `rB3z*`): 83 % of cells SPLIT; the rule works, closure fails in
    two views (146 and 114 hole px); box pass 3.2-4.2 ms. A look experiment the owner asked for ("an infinite
    zoom voxel terrain which could also look cool"); not judged by them yet.
  - Gates (self-test etc.) NOT run yet.

## Numbers worth remembering
- Threshold: T=2 means slopes over 45° along an axis (55° on a diagonal), T=4 = 63° (what "neighbours differ
  by more than 2 widths" was meant to be), T=8 = 76°, T=16 = 83°. SPLIT cells in a real window: 4,629 / 1,641 /
  132 / 0. The generated world has long steep slopes, not cliffs, so whole mountainsides are SPLIT at T=2.
- Desktop GPU ms off/on before the overdraw work: far 3.2/5.8, near 5.3/9.6 (page frame missed: 10.8 vs 9.9),
  above 5.7/6.0, foot of wall 4.9/6.0. March 4-9 nodes per pixel mean, 32 max.
- Stored correction on the CPU: up to ~50 fine columns (12 m) at full 8 m amplitude, ~34 at half. It is 0 in
  the shader, so shader means are off.

## Open decisions for the owner
1. Threshold default: 2 or 4.
2. Notches: port coarse ones to the shader, or drop (orchestrator's view from the CPU pictures: drop for now).
3. 8 m column noise: full or half cell (shader default is half).
4. Whether to try the quota idea (see INTEGER_HEIGHTS_AND_MEANS.md) to remove the stored correction.
5. Whether long 45-63° slopes should be columns at all, or only real drops.

## Next steps, in the order planned
- **B3**: finish overdraw cost, then gates (see GATES_PHONE_PROCESS.md), then move the phone link.
- **D, phone bench**: a page the owner runs for a minute, look on/off at the foot of a wall. "Fast on the
  phone" is unproven for all of this.
- **C, the hand-over**: the real 2 m and 0.25 m levels build the same columns from the same rule (the rule
  replaces the generator's fine detail on steep cells; flagged to the owner as a design change, accepted as
  direction). Test: fly at a cliff, compare the frame before and after the level loads. Until C exists, real
  fine data inside a SPLIT cell (including fine brush edits) is not drawn: rule columns replace it.
- Then: dTheta or quotas, the up surface following a sloped neighbour (it is flat at H; misses a sloping
  sheet by up to 4.5 m), depth of the hit not the box (NS-288), the table lagging during edits (NS-290),
  coarse level other than 16 m (cliffs that exist only at 128 m or only at 2 m are not covered), the view
  from above (a mosaic on long slopes), threshold per material.

## Known faults and limits
BACKLOG NS-241..NS-295 and later. The ones that matter most: box overdraw (NS-292); closure is measured,
not guaranteed (NS-289); depth is the box's (NS-288); table lags edits (NS-290); dTheta = 0 in the shader;
heights are floats rounded per build; only the default textured sheet draw is covered (not the field mesh,
not `?tex=0/2`); one unexplained multi-second frame at page load with the variant.
