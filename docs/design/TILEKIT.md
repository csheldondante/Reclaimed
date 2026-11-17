# TILEKIT — a tile kit for the irregular grid (design note, steps 1 and 2)

(Step 2 — the owner's answers to §12 and what follows from them — is §13–§19 at the end; DECISIONS 2026-11-17.)

Branch `tilekit` (from `archgen-ground`). A sandbox track: nothing here is wired into the game; the owner judges
sandbox renders (`tilekit.html`). Read with ARCHGEN.md (the parts generator this would sit beside) and BACKLOG
AG16/AG23/AG26/AG29–AG31 (the irregular-grid work so far).

The owner's direction (2026-11-17, verbatim in BACKLOG TKIT0): procedural designs that take an architectural
**theme as data**; good shapes and lighting over resolution (Tiny Glade shapes, Dota 2 stylisation, LOD for close
zoom); tiles for the existing irregular "Townscaper" grid so districts fill with dense irregular structures along
alleys and quays; rectangle booleans for massing; warping by a control grid (wonk now, sag later); SSAO kept.

## 1. The grid as it exists (arch.wgsl, `pieceAt` / `cellsOf` / `tgRelax` / `tgEmit`)

- A world-fixed triangle lattice, spacing `GRID_S` = 5.4 m (`latP(a, b)`). Each triangle picks a neighbour by an edge
  hash; mutual picks merge into a rhombus (two rounds of picking, so fewer lone triangles). A **piece** is a merged
  pair (4 corners) or a lone triangle (3 corners). Corners are nudged by a position hash.
- Each piece is cut into quads: per corner, the quad (corner, its next edge's midpoint, the piece centre, its previous
  edge's midpoint). So **every cell is a quad**; a rhombus gives 4 cells, a triangle 3.
- Relaxed (Townscaper's squaring: each cell pulls its corners toward the square that fits it) in 8 × 8-lattice chunks
  (~43 m), one workgroup a chunk, every vertex owned by exactly one chunk: no seams.
- Cells are written flat (2D) to `gridCells` (10 words: 4 corners, lot, class). Corners are read from their owner
  chunk, so a shared vertex has bit-identical coordinates in every cell that uses it: the CPU can weld exactly.

**Valences** (derived; measured in the lab, §11):
| vertex | valence |
|---|---|
| lattice point | 6 − (merges across edges at it): **3, 4, 5 or 6** |
| midpoint of an unmerged lattice edge | 4 |
| centre of a merged rhombus (the merged edge's midpoint) | 4 |
| centre of a lone triangle | **3** |

Cell sizes: the lattice-edge halves are 2.7 m; a rhombus's centre-to-side-midpoint is also 2.7 m (half the side);
a triangle's centroid-to-midpoint is 1.56 m. Relaxation evens these out somewhat. So cell edges run **~1.6–2.7 m**,
most near 2.7 m.

**Stacking in z** does not exist yet: cells are 2D; the old generator stands one body per cell or lattice point. The
kit stacks storeys: a voxel is (cell, storey), storey height from the theme. Ground is flat in step 1 (§8).

## 2. Where occupancy lives — cells, not vertices (a departure from Townscaper; owner to weigh in)

Townscaper puts the player's blocks on the **vertices** of the render grid and fills each **quad** with a module
chosen from its 4 corners × 2 levels (an 8-bit marching-cubes case, 256 → ~50 by symmetry), because a module warped
into a quad must tile that quad. On this grid that would make every house footprint a **rosette of quarter-cells
round a vertex** (n-gons for n = 3…6) — the very rosettes AG31 step 1 found lumpy.

I propose occupancy on **cells** (a voxel = one quad cell × one storey), which is also what the orchestrator's
proposal and the existing lot code assume (lots claim cells, a cell touching a road is dropped):

- footprints are unions of the quads the owner already sees in the grid lab;
- walls run along **cell edges** (straight segments, 1.6–2.7 m), so a window can sit centred on a straight panel; in
  Townscaper's dual arrangement every wall bends at every edge midpoint, so a centred window always straddles a bend;
- the price: the module domain at a **vertex** is n-valent, so a per-vertex case table (as proposed) is not uniform:
  2ⁿ patterns per level for n = 3…6. §4 shows why that stops mattering once walls are swept rather than warped.

**Rectangle booleans** → cells: the grid has no global (i, j) coordinates (it is aperiodic), so the rectangles live in
the lot's own frame (world metres, any rotation) and a cell is in a storey when its **centroid** is inside the union
of that storey's rectangles (adds minus subtracts). The outline is therefore a staircase of cell edges approximating
the rectangle; how jagged that reads is one of the things the stills must show (§11, Q1).

## 3. The kit's decomposition: cells hold volume, edges hold walls, vertices hold joints

A cell complex has three kinds of element, and each gets its own kind of content:

| element | content | placement |
|---|---|---|
| **edge** (between an occupied and an empty cell, a storey) | wall panel: wall face, opening with reveals, frame, sill, bands, quoins | **swept** along the edge with mitred ends (§5) |
| **vertex** (where walls meet) | the joint: convex / straight / concave, its mitre; later corner posts, towers | derived from the cells round it (§4) |
| **cell** (occupied top, or ground) | roof surface, floor, paving, courtyard | sampled over the cell's own subdivision (§6) |

## 4. The case set and its symmetry reduction

**Edge cases.** An edge at storey s carries a wall iff exactly one of its two cells is occupied at s (a cell outside the
grid counts as empty). Outward = towards the empty cell. With the edge directed as in its occupied cell (CCW), the
outside is always on the right, so every panel has the same handedness: **no mirrored modules**.

**Vertex cases.** Round a vertex of valence n the occupied cells form a cyclic binary word. Counted (necklaces under
rotation; bracelets under rotation + reflection), per storey:

| n | patterns 2ⁿ | rotation classes | + reflection |
|---|---|---|---|
| 3 | 8 | 4 | 4 |
| 4 | 16 | 6 | 6 |
| 5 | 32 | 8 | 8 |
| 6 | 64 | 14 | 13 |
| all | 120 | **32** | **31** |

(`cases.ts` enumerates these; `cases.test.ts` checks the counts against Burnside.) But the kit does **not** need a
module per class. Each maximal run of occupied cells round the vertex is bounded by two wall edges, and those two walls
meet in one **joint** whose only parameter is the interior angle of the run (the sum of the run's cell corners at the
vertex). Classified by angle: **convex** (< 160°), **straight** (160–200°), **concave** (> 200°). A pattern with two or
more occupied runs is a **pinch** (two corners touching at a point, e.g. the n = 4 checkerboard): each run gets its
own joint; the lab counts pinches. So the 31 classes collapse to **3 joint kinds × (1 run or a pinch)**; valence
changes the angle, not the module. This is the main reason sweeping beats warping here.

**Vertical cases** (step 1 assumes monotone stacks: a storey's cells ⊆ the one below): a panel is `ground` (s = 0),
`upper`; `top` when the cell above its occupied cell is empty (cornice + eave), else a band between storeys.

**Modules a theme generates** (step 1): wall panels × {window, door, blank} × {ground, upper} → 5 (no upper door);
bands: plinth, storey band, cornice → 3; quoin stack (one end, mirrored by a flag for the other) → 1. **9 modules**,
all instanced on the same panel frame; a panel draws 2–4 of them. Opening choice per panel: door on the building's
street-most ground panel; window if the panel is at least the theme's `minWindowPanel` long; else blank; a theme weight
for blank panels. Variant weights are theme data.

## 5. The warp: panels swept along edges, then the control grid

**Rejected for walls: trilinear warp of a unit-cube module into the cell prism.** It scales relief depth with the cell
(a 25 cm recess becomes 15–25 cm), shears window reveals off the wall normal, and a module that tiles a quad must be
cut on the quad's diagonals at corners. It stays the right warp for **cell content** (roof, floor), which fills a cell.

**Panel sweep.** A module vertex is authored as (x along the panel, w out of the wall, z up), in metres, with an
**anchor** on x: from the start, from the end, from the middle, or proportional (a 9-slice in one dimension). For an
edge a → b of length L, outward normal n (to the right), and mitre vectors mₐ, m_b at its ends:

    along = anchored(x, L);   s = along / L
    P = a + (b − a)·s + w·lerp(mₐ, m_b, s) + up·(z₀ + z)

with m = (n₁ + n₂) / (1 + n₁·n₂) at a joint of two panels with outward normals n₁, n₂ (so m·n₁ = m·n₂ = 1). Then:

- the surface at depth w is the straight line parallel to the edge at distance exactly w — **relief depth is metric**;
- at the ends the cross-section lies in the mitre plane, so two panels meeting at a joint of **any angle** close
  without a gap or overlap; a quoin or cornice authored straight wraps the corner by itself (convex or concave);
- the window keeps its metric width (anchored at the middle); only the plain wall between anchors stretches;
- normals: rotated by the panel's frame (t, n, up) — exact except within |w| of the mitre, where the true surface is
  sheared; small for |w| ≤ 0.35 m;
- bevels survive because they are geometry (chamfers authored in the module, 3–4 cm) and the sweep preserves metric
  cross-sections; the trilinear warp would squash them unevenly.

**3- and 5-valent vertices** are not special: the joint angle at a 3-valent vertex (e.g. a lone triangle's centre,
corners ~120° each) is wide, giving obtuse convex corners; a 5- or 6-valent lattice point gives sharper ones (~60–72°).
Sharp convex joints stretch the mitre (1/cos(θ/2): ×2 at 60°) — the cornice's outer corner shoots out. Clamp at
~×2.5 (§12).

**Control grid.** After the sweep, every vertex (walls and roofs alike) is displaced by a smooth field D(p): a coarse
lattice over the block (spacing ~2.7 m in xy, a storey in z), trilinearly interpolated in the vertex shader. Its
values are data: `wonk` (a hashed lean and twist growing with height) and `sag` (the dial: z dropping with height
and with distance from the building's convex corners, its supports — ridges and eaves dip mid-span, corners stay).
Normals: n' = normalize(n − (∇D)ᵀn) from finite differences of D (first order in the displacement; fine for the
centimetres-to-decimetres the dials use). Later, simulation ("simulation ware") writes the same lattice: damage,
settling, burning beams.

## 6. Roofs — the decision

Alternatives:
1. **Roof modules per cell from corner cases** (Townscaper). Needs a quad-corner table and a rule for where ridges go;
   on cell-occupancy the ridge question is per vertex again, and wide blocks get corrugated or ambiguous ridges. AG30
   showed per-cell roof facets read as patchy.
2. **Max of each rectangle's own gable/hip** (the proposal). Exact and planar for the rectangles, but the rectangles'
   eaves are straight while the walls are the cell staircase: the eave and the wall top disagree by up to half a
   cell. Would need the walls clipped to the roof's footprint or the roof to the walls'.
3. **Straight skeleton of the cell outline** (Kelly–Wonka). Right in principle; robust implementations are heavy and
   the staircase outline gives a skeleton full of tiny events.
4. **A height field from the walls' own outline, sampled on the grid's subdivision** — chosen for step 1.

Chosen (4): each **top region** (the cells whose top storey is k) gets one roof surface. Its eave lines are exactly
the top storey's wall panels (so the roof always meets the walls); edges bordering a taller neighbour are not eaves
(the roof rises against that wall: a lean-to falls out). Height h(p) = eave + pitch · d(p), d the distance to the
eave segments, capped (a flat top beyond: a terrace or a later flat-roof module). Sampled at each cell's subdivision
(corners, edge midpoints, centre: 4 sub-quads a cell), each sub-quad split on the diagonal that better fits h at its
middle. Because the outline runs on cell edges, the medial axis of a strip one or two cells wide falls on sample
lines (cell centres and midpoints for one, shared edges for two), so **ridges land on vertices**, hips cross
sub-quads diagonally. Overhang: a strip swept out from each eave panel with the panel's own mitres, a fascia and a
soffit. Ridge cap and roof tiles: later (tiles painted by course in the shader for now).

Limits, stated: Euclidean distance rounds valleys at reflex corners (cones) between samples; hips only — **gables**
(the owner's "a single ridge line") need gable-end panels excluded from d and a gable wall panel up to the roof
(weighted distance, per-edge weight 0) — step 2; the roof is a per-building CPU mesh, not an instanced module (it
is small: a few hundred vertices a building).

## 7. Theme schema (`theme.ts`)

A theme is plain data; two themes ship (`plaster`: Mediterranean-ish render, stone quoins, cornice, shutters-free
deep windows; `timber`: half-timber over a stone ground floor, jettied band, steeper roof, smaller windows):

| group | fields |
|---|---|
| proportions | `storeyH`, `groundH`, `minWindowPanel` |
| wall | colour, per-building colour jitter, a palette of house colours |
| openings | window w × h, sill height, recess depth, frame width/depth, sill box, door w × h, door recess, glass/door colours |
| profiles | plinth, storey band, cornice: polylines in (w, z), colours (the extrusion's cross-sections) |
| corners | quoins: block sizes, alternation, protrusion, colour; or posts |
| timber | posts, rails, braces (on/off and sizes), colour — the timber theme's frame |
| roof | pitch, overhang, thickness, cap, colour palette |
| weights | blank-panel odds, door rule |
| warp | `wonk` amount (the control grid's lean/twist), default `sag` |
| bevel | chamfer size for every box |

No code path checks a theme's name; the two differ only in these values.

## 8. Quays, ground and slopes with the same kit

- **Quays**: a quay edge is a wall panel whose empty side is water: the same sweep with a `quay` module (rusticated
  face, coping profile, bollards anchored by the middle, steps as a variant) from storey −1 (water level) to the
  ground. The vertex joints and mitres are unchanged; Townscaper's quays are exactly this.
- **Ground and slopes**: the ground under a building is a per-building plinth level (quantised ground height). Panels
  at storey −k (below the plinth level, where the cell's terrain is lower) are `skirt` panels: plinth/retaining-wall
  modules whose bottom vertices are tagged and pushed down to the terrain in the vertex shader (no per-lot mesh).
  Stairs: a panel variant on an open edge where the walkable levels on its two cells differ (a flight swept along the
  edge, its steps metric-anchored). Paths between buildings are cells with no occupancy: paved cell content (§3) whose
  corners take the terrain height; the CG-H2 rule (towns absorb < 2 storeys of relief) becomes: open cells get stairs
  and ramps as cell content when their corner heights differ by more than a riser.
- Not built in step 1.

## 9. LOD

- Modules are generated per theme at three detail levels from the same data (bevels and frames dropped, openings
  flattened to an inset quad, bands to a single step) — the instance data is identical, only the module mesh swaps,
  so a LOD change is a draw-range change, not a regeneration.
- Far: one box-ish mesh a building (its walls without openings + the roof), or the baked tiles of AG24 on the phone.
- The roof's sampling can drop from 4 sub-quads a cell to 1.

## 10. Lighting

Kept: `ssao.wgsl` unchanged (the same orthographic depth convention as archlab). Added: **baked per-vertex occlusion**
in every module (rays cast against the module and its mirror across the panel middle, so a half-recess sees its other
half; 0.8 m reach) — reveals, sills and band undersides darken without screen space; the Townscaper light of archlab
(peach key, teal sky shade, warm bounce) and a sun shadow map; chamfered boxes so edges catch the key.

## 11. Measured (step 1, see DEVLOG 2026-11-17 "tile kit step 1")

`node scripts/tilekit-shots.mjs --server <dev server>` (stills in `local/tilekit1/`, numbers printed). Desktop, this PC.

- Grid round Muru's centre (3 × 3 chunks, 2501 cells, 2621 vertices). Interior vertex valences: **3: 230, 4: 1963,
  5: 169, 6: 21** (81% four-valent; the 3s are lone-triangle centres and 3-merge lattice points).
- The block (4 rectangles: main range 3 storeys, back wing 2, corner tower 4, annex 1): 18 cells, 68 panels over all
  storeys; joints **35 convex, 16 straight, 17 concave**, 0 pinches. Half the joints are convex: the rectangles'
  cell staircase crinkles every facade (Q2).
- Modules: plaster **12** (window, blank × ground/upper; corner stacks × ground/upper × 2 phases; door, plinth, band,
  cornice), timber **9** (no band, no ground corners). Vertices a module (plaster): window 594, door 492, blank 6,
  quoin stack 720 / 810, plinth 24, band 18, cornice 48; timber: window 594 / 1134 (studs, rails), blank 6 / 246
  (braces), post 90.
- Instances: plaster 232 → **93,492** instanced vertices (quoins ~45% of them); timber 209 → **60,048**. Roofs + ground
  3,150 world vertices (roofs 990). 13 draws.
- Kit generation (CPU, with the occlusion bake): plaster 50 ms, timber 19 ms, once a theme.
- GPU frame (shadow map 2048², scene MSAA 4×, SSAO, compose; 960 × 540): **1.22 ms** median (p90 3–4 ms under the
  other builders' load), both themes.

## 12. Unsure / open

- **Q1 (owner)**: cells or vertices for occupancy (§2)? Cells gives straight panels and matches lots; vertices is
  Townscaper's and gives a finer (half-cell) outline that bends at every midpoint.
- **Q2 (owner)**: rectangles rasterised by cell centroid give staircase outlines; do you want walls to follow the grid
  (organic, Townscaper) or the rectangles (Tiny Glade, straight walls, the grid then only a guide)? A hybrid: snap the
  rectangle edges to the nearest chain of cell edges and relax those vertices onto the line (a local grid edit, like
  the relaxation).
- **Q3 (owner)**: roofs — the half-grid height field (hips, lean-tos for free, ridges on vertices) vs gables per
  rectangle (§6, option 2) vs a weighted skeleton later. The owner's "a single ridge line" wants gables: is a gable
  end chosen per rectangle (its short sides) or per region (its longest axis)?
- **Q4**: sharp convex joints (5/6-valent points, ~60°) stretch mitred cornices ×2 — clamp, or forbid such corners by
  the occupancy rule (a cell may only be added where the resulting outline angle ≥ 75°)?
- **Q5**: pinches (two runs touching at a vertex) — allowed (two corners kissing; medieval towns have these), or
  forbidden in the massing step?
- **Q6**: windows straddle nothing now (centred on straight panels), but short panels (1.6 m, the triangle cells')
  go blank; is a rhythm of one window per cell edge right for the look, or should the theme's bay width decide (two
  windows on a long panel)?
- Unsure: how the per-panel normal frame looks under strong sag (first-order normals); AO bake per module ignores
  neighbouring modules (SSAO covers); the roof's Euclidean valleys.

---

# Step 2 — grid-following massing, runs and bays, strip roofs, corner features, LOD

The owner's answers (DECISIONS 2026-11-17): walls parallel to the grid's lines, possibly set back; plots claimed from
merged lots; roofs by best guess (Tiny Glade: a gable or hip per rectangle, a slope never into a wall) with the height
field kept as a variant; windows by the theme's bay width over merged walls; corner features and a little arch at sharp
corners. (Written with the build, not strictly before it: the first measurement, §13.1, changed the plan.)

## 13. What the grid allows: lines, strips, and where they bend

### 13.1 Measured first (strips.ts `lineStats`, on the real grid round Muru's centre, unit-test fixture)

A **grid line** is a chain of cell edges that runs straight on through a 4-valent vertex (the edge two cells round
continues it) and stops at an irregular one (no "opposite" edge there). On this grid:

| | median | p90 | max |
|---|---|---|---|
| line length (edges) | 4 | 10 | 47 |
| line length (m) | 9.9 | 24.7 | 117 |
| turn at a 4-valent pass | 5.6° | 18.9° | 40.7° |
| bend carrying a wall straight on through a 3-valent vertex | 60° | 71° | |
| … a 5-valent vertex | 37° | 46° | |
| … a 6-valent vertex | 60° | 65° | |

So a wall can follow the grid smoothly for ~10 m typically (a gentle 5° wobble a cell, a 19° kink one time in ten);
at an irregular vertex — most lattice points (valences 3/5/6 are ~64% of them, one every ~5.4 m along a line) — a
wall carried straight on bends by 37–60°. **This is structural** (Gauss–Bonnet for quad meshes: in a disc of cells
bounded by four straight sides with four one-cell corners, the interior's Σ(4 − valence) must be 0; one irregular
vertex inside forces a fifth corner or a bend on the outline). It cannot be smoothed away by a cleverer decomposition.

### 13.2 Strips — the grid's own rectangles

A **strip** is an a × b patch of cells reached by stepping "right" (across a cell's edge k + 1) a times and "up"
(across k + 2) b times from a framed seed cell, where every step agrees (the cell above the right neighbour is the
right neighbour of the cell above) — i.e. every interior vertex is 4-valent (`strips.ts patch`). A 1 × n strip is a
chord of the quad mesh and always exists; wider strips stop at irregular vertices. Irregular vertices are therefore
always on strip **boundaries**: at a strip's corner (where the outline turns anyway — the awkward vertices that get
corner features, §17) or along a side, where the side bends by §13.1's angles.

**Decomposition** (`decompose`): a greedy exact cover of the plot's cells — repeatedly take, over every remaining
cell and frame, the maximal strip (up to 7 × 2) with the best score `cells − 0.08 · (worst side bend in degrees)`,
remove it. The bend cost trades length for straight walls: a 40° bend costs ~3 cells (0.12 fragmented the district
into many 1 × 1 strips, 0.05 kept worm-like 1-wide strips that snake round irregular vertices — DEVLOG). Unit tests:
every strip is a patch, the cover is exact and disjoint, on squares and on the real grid.

### 13.3 Plots and roles (district.ts `planDistrict`)

- **Plot**: lots whose cells (class 1 or 2: centre in the lot, not touching a street) lie within the district radius,
  merged in a hashed order with adjacent lots until ≥ 18 cells (the lots here are 5–20 cells, so 1–3 lots a plot).
- **Alleys**: between some adjacent plots (odds 0.45), the bigger plot's cells along the other become an alley one cell
  wide (if the plot keeps ≥ 6).
- **Roles**: the plot's first (biggest) strip is the **main range** (storeys from the theme's range; a 1–2-cell main
  is a 2-storey cottage); strips ≥ 3 cells are **wings** (one or two storeys lower, sometimes as tall); one ≤ 2-cell
  strip in a plot of ≥ 20 cells may be a **tower** (1–2 storeys above the main); the remaining small strips are mostly
  **yards** (open, green) and sometimes one-storey **annexes**.
- Answer-1 alternative: "follow better plans' lots and fill those" is the same code with plots = lots (plotCells 0).

**Challenge to "the crinkle disappears where the outline follows a grid line"**: true for a strip's side between
irregular vertices; but a side of a 2-wide strip almost always passes one irregular vertex within 5–10 m, and most
massing corners sit on irregular vertices with 60–120° angles. The step-2 stills show it: much straighter than step 1,
not Tiny Glade straight. Options for the owner (§19 Q7).

## 14. Facades: setback, runs, bays (facade.ts)

1. **Loops**: a storey's cell-edge panels (step 1's `walls`, occupancy now lo ≤ s < tops so a bridge room can start at
   storey 1) are followed into closed CCW loops.
2. **Setback**: each panel's face is moved in by d (theme `facade.setback`: plaster 0.35 m, timber 0.45 m) — the wall
   line is parallel to its cell edge at exactly d. A **jetty** steps a storey with facade below it out by `jetty`
   (timber 0.28 m a storey, up to 2). Corners close at the intersection of the two moved lines
   (`offsetCorner`: x·n₁ = v·n₁ − d₁, x·n₂ = v·n₂ − d₂), which for d₁ = d₂ is v − d·mitre; where two faces nearly in
   line (|turn| < 20°) have different offsets, the corner is a **jog**: two points and a return |d₁ − d₂| long (a
   jetty's end). Unit tests: both offset lines hold at every angle 60–270° and any two offsets; an L-shape's every
   segment lies d inside its edge; on every lot of the real grid offset 0.35 m, 0 of 1254 segments fold (a fold needs a
   panel shorter than ~2d / tan(θ/2) between convex corners; the grid's edges are ≥ 1.5 m).
3. **Runs**: a loop breaks only at real corners (|turn| > 20°), at jogs, and where the house or the eave changes along
   a straight wall; everything between is one **run**, a polyline that follows the grid's line. A dial `straighten`
   (0..1) pulls a run's inner points onto the line between its corners (0 = follow the grid, 1 = straight walls).
4. **Bays**: a run of length L gets n = max(1, round(L / bayW)) equal bays (plaster 2.7 m, timber 2.2 m) by arc length;
   a bay is the chord between two points on the run (sagitta of a 5° pass over 2.7 m: ~6 cm, hidden by the setback).
   Each bay is one module instance with mitres from its neighbours' normals at both ends. Openings: a door a plot (its
   ground bay facing a street most, on the main range, the middle bay); else a window if the bay is long enough, not an
   end bay of a 3+ bay run blanked at the theme's odds (`endBlank`), and not a blank by `blankOdds`. Windows are larger
   (plaster 0.95 × 1.5 m, timber 0.78 × 1.15 m). Unit tests: a 6 × 2 block has 4 runs with 6/6/2/2 equal bays and
   corner mitres m·n = 1; runs break where the house changes.
5. **Corners**: quoins only at convex corners under 125° (a chamfer's two 135° joints and the grid's obtuse bends stay
   plain); timber posts frame every bay.

## 15. Roofs: one roof a strip (roof.ts), and the height field as a variant

Each strip with a top gets one roof, sampled on its own half-cell grid (corners, edge midpoints, centres: the ridge of
any strip lands on its middle sample line, which follows the grid's middle line and bends with it). Each side's cell
edges are classed **eave** (nothing as tall beyond: a wall, an overhang), **join** (a neighbour as tall, no wall: the
roofs meet), **abut** (a taller neighbour's wall rises there). The boundary samples move to the wall lines (eave: the
setback in; abut: the taller wall's setback out, so the roof runs on under it; join: the cell edge).

Choice (`planRoof`), ridge along the strip's longer direction:
- no abutting long side → **gable**, hipped on free ends if the theme says (plaster hips, timber gables); an abutting
  or joined end is always a gable end;
- one long side abuts → **lean-to** rising to that wall, pitch ≤ 0.6 × the theme's and its top ≤ 0.35 m under the
  taller eave and ≤ 2.4 m of rise;
- both long sides abut → on a squarish strip a gable whose ridge runs from wall to wall; on a long one a **flat**
  terrace (a ridge across a long strip climbed to half its length — seen in the first look);
- a tower → a **pyramid** at the tower pitch.

Heights: the across profile is a function of the across index alone (the arc length averaged over the columns), a
hip's of the along index alone — so along an end the roof is exactly level going inwards.

**The rule "a slope never runs into a wall"** is guaranteed by the choice (a slope's low side is only ever an eave or a
join) and checked on every roof (`slopeIntoWall`): along every abutting side, the roof must not rise going inwards.
It holds exactly in the strip's own coordinates (the district test asserts ≤ 1e-9 on every strip of both themes; a
deliberately wrong gable against a wall is caught at > 0.3). In world space a bent strip's gable end meets its wall
along slightly sloped lines (the grid's bend), which is not water into the wall.

Meshing: the sampled surface, an overhang ring (eave sides: the overhang, extrapolating the slope; a joined gable end
that meets a crossing roof runs on into it by rise / its pitch — the union of the two makes the valley), fascia and
soffit under the ring, and the wall filled up to the roof on free sides (gable ends, a lean-to's ends). Roofs of
joined strips overlap as a union (no CSG): crossing gables make true valleys, but a pyramid or hip that meets another
roof can poke through it (§19 Q9).

**Variant**: step 1's height field over the same occupancy (`?roof=field`): one surface a top region, eave at the cell
edges, hips only.

**Judgement from the stills (local/tilekit2/*_d_*, *_e_*, *_h_* vs *_a_*, *_b_*, *_f_*)**: per-strip is better. Timber
shows it most: clear gable ends with filled triangles, single ridges, lean-tos against towers — the height field gives
every region a hip cone with notches where the outline jogs. In plaster (hipped by theme) the two are closer: the
height field reads as one calmer surface per region, while strip roofs show where strips meet (overlapping hips, a
pyramid poking through a neighbour) — the union artefacts of Q9. Strip roofs cost more world vertices (22k vs 14k for
the district; negligible next to the walls).

## 16. Corner features (district.ts)

- **Turret**: on each plot's main range, at its sharpest convex ground corner under 72° (5/6-valent vertices): an
  n-gon tower (plaster 12 sides, r 1.25 m, from the ground; timber an octagonal **oriel** from the first floor on a
  corbel), bands at floors, slit windows towards the outside, a cone roof. Quoins and chamfers are suppressed there.
- **Chamfer** (plaster): other convex corners under 80° are cut 0.45 m back along each face (one blank bay).
- **Arch**: an alley cell between two houses ≥ 2 storeys on opposite edges gets a **bridge room** on its first floor
  (occupancy lo = 1, its own 1 × 1 strip and roof) and an arch under it from one house's wall to the other's
  (semicircular, or segmental when the ground storey is low), up to two a district.
- Not built: a setback notch at awkward corners (the setback already opens every corner by d; a notch is a second,
  larger local setback — cheap with the offset machinery, §19 Q8).

## 17. LOD (kit.ts `buildKit(theme, bake, lod)`) — the same instances, three module sets

| level | what changes | plaster district (145 cells) | timber |
|---|---|---|---|
| 0 near | chamfered boxes, shutters, crosses, planks, full quoins | 408,570 instanced vertices | 327,468 |
| 1 mid | no chamfers; quoins as two faces a block | 115,614 | 116,658 |
| 2 far | wall one sheet, openings painted proud, no quoins, profiles to their bounding step, timber flat | 16,998 | 24,846 |

Plus roofs and ground as world geometry: 21,990 (strip roofs) / 14,412 (height field). The instance buffer is the
same at every level (a level swap is a draw-range change). Suggested: 0 under ~20 m view height, 1 to ~70 m, 2 beyond;
the far level is also the candidate for one merged mesh a building (not built). Near was 589,290 before quoins were
restricted to corners under 125°; after it quoin stacks are still 224k of the 408k (55%) and windows 155k (38%); in
timber the windows (studs and rails) are 232k of 327k. The near level is for close-ups only.

## 18. Measured (step 2; DEVLOG 2026-11-17 "tile kit step 2")

- District round the same anchor (radius 24 m): 15 plots, 112 strips, 145 built cells, 474 wall panels (plaster) →
  356 runs, 482 bays; 261 windows, 14–15 doors; 2 arches, 4 turrets, 51 chamfers (plaster); roofs: plaster hip 26,
  shed 12, gable 4, pyramid 3, flat 1; timber gable 30, shed 11, pyramid 3, flat 2; slope-into-wall 0 on all.
- Build (CPU, whole district incl. decomposition): 17–50 ms; kit 0.2–5 ms a level.
- GPU frame (shadow 2048² + scene MSAA 4 + SSAO + compose, 960 × 540, desktop, shared GPU): 1.6–1.7 ms at LOD 0,
  1.4–1.7 at LOD 1, 1.3–1.4 at LOD 2 (median of 40; p90 2–9 ms from the other builder's load).

## 19. Open (owner)

- **Q7 (the structural one)**: grid lines kink 37–60° at every irregular vertex, most lattice points are irregular, so
  walls are straight for ~10 m at best. Options: (a) accept it (organic, Townscaper) and hide kinks with corner
  features; (b) `straighten` runs (built, dial): walls straight corner to corner, the wall then leaves its cell edge by
  up to the sagitta — fine while ≤ the setback, not where a bend is 40°; (c) a **district grain**: in built lots, merge
  all lattice triangles across the same edge family, so the rhombi tile regularly and every lattice point inside is
  4-valent (irregular vertices only on lot borders) — a change to arch.wgsl's pairing, cheap, and the relaxation then
  squares a regular patch; (d) re-mesh a claimed plot as a structured i × j grid (Coons patch of its four sides), the
  irregular grid only in streets and plazas; (e) follow better plans' lots with rectangles (the owner's other option).
  I lean to (c) as the next experiment: it keeps one grid and gives long straight strips exactly where buildings go.
- **Q8**: corner features by angle (turret < 72° on the main range, chamfer < 80°): more, fewer, a notch instead?
- **Q9**: strip roofs overlap as a union; a hip or pyramid meeting a neighbour pokes through it. Clip each roof to its
  strip plus its extension (a 2D clip against the neighbours' cells), or proper CSG of the roof solids?
- **Q10**: a lean-to's pitch is capped to stay under the taller eave; a flat terrace where a long strip lies between
  two taller walls — or prefer a different decomposition there?
