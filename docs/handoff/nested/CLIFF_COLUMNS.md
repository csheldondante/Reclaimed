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

## Corrections from the owner after the first version of this document (2026-11-20, late)
- **The owner judges looks, not the orchestrator.** "I really want you to show me and ask me to judge the look
  because I don't always agree with your judgement". Show every variant asked for, in the real view, side by
  side; describe faults; ask. Never drop, defer or alter a look on the orchestrator's taste.
- **Notches are wanted.** On the CPU pictures `rA4-trench-middle`, `rA4-trench-coarse50` and
  `rA2-near-dramatic30`: "The notches look great in two of the three pictures and with better lighting are
  likely fine in the third". The orchestrator had recommended dropping them: wrong. They had never been built
  in the shader; a builder was porting them (`?cliffGap=1` in the `?cliff=5` march; four versions: none,
  coarse middle, coarse many, every level) when this was written. The earlier "little notches are not worth
  it" was said about test pictures; "every level" is being shown once more in the real view.
- **Fine columns are wanted.** "Why do the columns look wider again and not pixel width? I thought it looked
  so much cooler with smaller columns." Cause: step A round 2 cut the 1 / 0.5 / 0.25 m amplitudes to 3-10 % of
  a cell and decides up/down per 2 m block (the orchestrator's fix for pin-stripes, never shown to the owner as
  a before/after). Queued: fine levels back to a full cell of noise, three settings side by side, the block
  size down to 0.5 m in one, with frame time.
- **A brushed sphere at T=4 is fine.** "the sphere looks fine … The lighting and shape look fine to me". No
  stone columns are needed there. The ring of teeth at its foot is the MATERIAL boundary, not geometry (step
  B5, script `scripts/nested-rB5-skirt.mjs`, stills `local/nested/rB5-*`): the material is one per column and
  flat per triangle (`nest.wgsl` sheet bake ~3560, `draw.wgsl` `sheetVert` ~331, `@interpolate(flat)`), so on a
  vertical wall sand-coloured triangles climb the dome. Proposed fix, not built: on steep pixels choose the
  material per pixel by the pixel's height against the neighbouring columns' solids, with a narrow blend
  (2-4 column reads per steep pixel; estimated under 0.5 ms). This is probably the cause of most of the rim
  complaints in the owner's phone screenshots of round 27. The "rule at the 2 m level" round was started and
  stopped before any edit; it may still be wanted for real cliffs that exist only at 2 m.

- **The owner's stated taste (2026-11-20, last message before handoff):** "So far my preferences have been the
  finer columns and more notches which make the surface noisy and read as stone to me. I actually loved the
  look where it was boxels everywhere but I do think that varying it by material could help. Sand and dirt have
  angle of repose and can't really get the crease artifact that motivated this all and the more recent sphere
  pictures don't have the artifact that motivated this whole exploration". Coarse notches on the trench "looks
  good"; notches at every level did not read in the old CPU picture because "the columns look very flat and
  like they are not notched at fine detail".
  Direction this implies (orchestrator's reading, to confirm with the owner): draw style by MATERIAL. Stone is
  drawn as boxel columns (possibly at every slope, i.e. the T=0 look for stone), fine and heavily notched.
  Loose materials (sand, dirt) stay smooth sheets and get their shape from the simulation's angle of repose, so
  they never hold the vertical wall that makes creases; this ties the look to the first simulation slice
  (slumping). The brushed dirt sphere standing vertical is then a simulation matter, and its remaining visual
  fault is only the material-boundary teeth. Not designed yet: which material decides a column's style where
  cover lies over stone, and how a sheet of cover meets boxel stone.

- **The owner's answers to that reading (2026-11-20, final):**
  (These three answer the orchestrator's questions "is the reading right: stone as boxels, loose materials as
  sheets shaped by slumping?", "boxels at every slope or only above some slope?" and "where dirt lies over
  stone, which decides?". They are NOT a verdict on the `rB6fine-*` / `rB7-*` shader stills, which the owner
  had not judged when this was written: ask.)
  1. Stone as boxels, loose materials as sheets shaped by slumping: "I think so". Further idea, not asked for
     yet: "hexels or even varying column shape to be voronoi at various columns scales when
     you zoom in could work. What I do like is the stepped look over some threshold and the pixel walking in to
     pixel scale noise to show detail at a distance".
  2. Slope: "Keep it above some slope I do think slightly less noise on flatter surfaces is at least a knob we
     want". The owner then corrected the orchestrator's reading: "my point is there will visually be less noise
     on flatter surfaces that aren't stepped not a new setting." So: a threshold stays (the knob IS the
     threshold); ground below it is plain smooth sheet and is calmer for that reason. Do NOT build a separate
     noise-by-slope setting.
  3. Materials need NO special rule: "it is based on the heights of the top of the column. If the dirt is thick
     enough it will settle on the angle of repose if the drop is high enough it will repose down to the edge
     and then have exposed rock on the vertical until the height where dirt settles on the next step. It should
     just work". I.e. the rule runs on column top heights; loose layers are ordinary intervals that the
     simulation settles on the steps; vertical faces show whatever solid is there. So no separate "which
     material decides" rule is needed. This makes slumping (the first simulation
     slice) the thing that produces dirt on ledges and bare rock on faces.

- **Step B6/B7 (commits 5b932888, a8664ec1): notches and fine columns in the real shader.** `?cliffGap=1`,
  `?cliffNotch=middle|many|every`, `?cliffNotchP=`/`?cliffNotchD=`; fine columns = `&cliffAmp=0,256,256,256,256,256,256&cliffWLv=5&cliffPx=2`.
  Stills `local/nested/rB6*`, `rB7*`. Holes 0 at T=2. COST IS THE OPEN PROBLEM (desktop, box pass GPU ms):
  near view default 3.6 -> fine 4.2 -> fine + notches 11.2 (page frame 14.0 ms); foot of wall 2.5 -> 3.3 ->
  19.3 (frame 23 ms, 38 % of box pixels hit the 96-step cap). Fine columns alone are cheap; the notches are
  not: the march walks a notch's air node by node at 0.25 m. Proposed fix, not built (NS-307): cross a notch's
  air in steps of the notch's own level. Also: notches decided per march node may alias with distance
  (NS-305); no exactness test for notches (NS-306); thin bright vertical lines are sunlit one-column side faces
  (NS-308, unconfirmed). T=0 with these settings: 133 hole px in the far view.
- **Where the orchestrator stopped (no builder running):** next small steps in order: (1) NS-307 notch cost,
  re-measure; (2) the material-boundary fix for brush skirts (NS-304); (3) settle the threshold default with the owner (no separate noise setting);
  (4) gates (self-test, never completed since round 28) and a phone bench before any phone link;
  (5) first simulation slice: slumping on stepped stone, which the look now depends on.

- **The owner's verdict on the shader stills `rB6fine-*` / `rB7-*` (2026-11-20, last):** "I like the finer
  vertical walk (thinner columns) with or without notches but I do think notches make it look better. I also
  don't think the notches look as uniform as I would make them. I would give everything a noisy texture at the
  highest level of detail that shows. I would not expect any blocks like those in the 3rd screen that look
  boxy until we are at the closest possible zoom."
  So: fine columns are the default look; notches stay in. Orchestrator's reading of the rest, to confirm:
  (a) notches should be spread more evenly (today the slow mask removes them from about a third of a wall and
  they are decided per march node); (b) every face should carry noise at the finest level that is visible, so
  no large flat faces anywhere; (c) the "3rd screen" is the foot-of-wall still, where 38 % of pixels hit the
  march step cap and fell back to plain coarse blocks, and where 0.25 m is the finest level so close columns
  are many pixels wide. Fixes implied: NS-307 (notch cost, so the cap is not hit), a fallback that never shows
  a bare coarse block, and letting the march subdivide BELOW 0.25 m down to pixel size (detail that exists only
  in the picture) so nothing looks boxy until the closest zoom.

- **The owner's model, stated last and overriding the orchestrator's readings above:** "My expectation was
  that it's a fractal of column subtraction so that there are no smooth stone surfaces at all." I.e. at every
  level, finer columns and notches are subtracted again from every stone face (including the faces and walls
  left by coarser subtraction), recursively down to pixel size, with no mask that leaves a face plain and no
  level at which a face is declared finished. Smooth surfaces are the non-stone sheets (tops, ground) only.
  What in the current build breaks this: fine-level amplitudes were cut and masked (restored only by URL
  settings); the slow mask zeroes fine detail on about a third of a wall; the march stops at 0.25 m; a node
  that is "all up" stops descending unless notches are on; the step-cap fallback draws a bare coarse block.
  The builder's next brief should be written from this sentence, not from the settings accumulated so far.

- **On cost (the owner, last):** "doing the fine march with just columns is fine if notches are too expensive."
  and "I would not expect them to be much more expensive since every pixel can walk in column space I would
  assume it walks bigger column subtraction first and so is logarithmic in steps * const for number of steps
  per level which I think we kept small like <5". The owner's expectation is the right design and the current
  notch march does NOT do it: it descends to the distance-chosen finest level first and then crosses a notch's
  air node by node at that level (hence 50+ steps and the cap). NS-307 should be done as: test notches
  coarse-first inside the hierarchy. A node at level l whose ray segment lies, in z, wholly inside a level-l (or
  coarser) notch that covers the node is EMPTY and is crossed in one step, like a node with nothing up; only a
  node the notch covers partly (in plan or in z) is descended. Steps then stay about (levels) x (a few), as for
  plain columns (measured 4-11 mean). Fallback if it still costs too much: fine columns without notches, which
  the owner accepts.

- **The depth rule the owner agreed to try (2026-11-20, last):** their model: "columns are volumetric and
  fractal subtraction of less than .5 depth along surfaces should always leave contiguous material. So any gaps
  are I assume rendering only." Current settings break it (columns move up to a full cell per level; notches
  cut up to 4 cells deep, which can cut a thin column through and leave its top hanging). Agreed next step
  after the notch cost fix: at every level, subtraction from a stone surface is less than half a cell of that
  level deep. The owner had assumed 8x8 levels ("so 4 was exactly half") and prefers "4 distinct depths per
  level (0,1,2,3)" over two (0,1), "but let's see what it looks like". Orchestrator's proposal: define the
  rule on the REAL 8x levels (16 m -> 2 m -> 0.25 m -> finer), with a hashed depth of 0..3 child cells per
  level from every stone face, for columns (plan) and notches (height) alike; the march may still traverse a
  binary tree for skipping. This also makes step C simpler (one rule step per real level). Show side by side:
  8x levels with depths 0..3, binary levels with depths 0..1, and today's deeper notches.
- Also the owner: "if the march uses the fractal it will be fast enough" and, below 0.25 m, "I'm ok seeing
  flat walls but I do think it would look better to just keep rendering deeper columns so that things look
  rough. And like they have basically infinite voxel detail." So: keep subdividing below 0.25 m to pixel size.

- **When the march is too slow (the owner, last):** "I would rather just lower resolution and keep the look
  than bail because of depth for the walks." So the answer to cost is a lower render resolution (the lab
  already has a "Draw 100 / 75 / 50 %" control; a reduced-resolution cliff pass or an automatic scale is the
  natural form), NOT cutting the walk short, capping detail by distance, or a fallback picture. The step cap
  stays only as a guard against a stalled frame and should essentially never be hit.

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
