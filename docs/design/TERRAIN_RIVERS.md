# Terrain: rivers first (TR) — steps 1 and 2

Step 2 (§9) replaces §4's per-cell candidate lookup and fade with a two-scale field; §1–§3 and §5 stand.

Branch `terrain-rivers` (from `loop-skeleton`). Sandbox track behind the atlas parameter **`a.rivers2=1`** (default
0: the default world is unchanged, byte for byte). The owner wants to keep iterating on the terrain function himself,
so every rule below is a formula with its constants named, and the constants sit at the top of the file that uses them
(`src/terrain/walks.ts` for the CPU walk and levels, `src/terrain/valley.wgsl` for the height).

## The owner's direction (2026-11-17, verbatim in docs/DECISIONS.md)

- Rivers more noticeably in the bottom of a watershed; more large features like volcanoes.
- Raise the terrain by an SDF away from rivers: more height variety, *as long as mountains and cliffs are still
  dramatic and rise up and some areas still look flat*.
- No erosion simulation: "walking to the coast with jitter and using SDF to raise terrain … more control over paths
  … dramatic water falls … for water and magma rivers".
- Height from drainage "with just SDF"; the terrain function stays the owner's to iterate.
- More flow for hot lava; larger flows.

## What the default world does today (verified in the code)

Height = continents (`lift` by the coast SDF) + Voronoi regions with base levels + ridged massifs + detail noise +
border forms (mesa cliffs, ravines, walls) + stamps (craters, oddities) — `compose.wgsl regionHeight/ground`. Rivers
are *found afterwards* (`atlas/rivers.ts`): a CPU priority flood over the macro ground fills every hollow, flow
accumulates down the fill tree, texels draining 160+ become nodes, levels are the filled ground (so a river crosses a
hollow at the hollow's spill height), then `rivershape.ts` incises and staircases. The carve (`river.wgsl riverCut`)
is a channel plus a steep bank within ~4 half-widths; nothing beyond, so a river is a slot in whatever ground it
crossed. Where the ground is under its level a levee up to 12 cells is built (`columns.wgsl colHeight`, table mode).
Seed 1: 53 975 nodes (46 372 water, 7 603 lava), 3 979 nodes whose next node is *higher* (rivers climbing out of
hollows), 817 lakes. No volcano exists in generated terrain.

## The idea in one line

Turn it round: **the rivers come first and the land is shaped around them.** Paths are walks to the sea; levels are
designed along each path (monotone by construction); the ground is the lower of the landforms (raised away from the
rivers) and a valley surface hung from the river levels. A river is then the local minimum of its cross-section by
construction, and needs no levee and no pit.

## 1. Paths by walks (`src/terrain/walks.ts`, CPU, once per atlas, off the frame path)

Inputs, per macro texel (n = 2048, ~8 cells a texel): `G` the macro ground of the first pass (everything but rivers),
`c` the signed coast distance (JFA, + on land), water mask, dryness by latitude.

**Guide field.** Two unit vectors at the walker's position (bilinear, wrapped on the torus):
- `a = −∇c / |∇c|` — straight to the nearest coast (the SDF's gradient);
- `b = −∇Gs / |∇Gs|` — downhill on `Gs`, `G` box-blurred over `GUIDE_BLUR` texels;

`g = a + ALPHA · clamp(|∇Gs| / SLOPE_FULL, 0, 1) · b` (if |g| < 0.25 — the two cancel — `g = a`; if there is no guide
at all, the last direction), turned by θ = TURN · `noise1(walk, s / JITTER_PER)` (a smooth value noise in [−1, 1]
along the arc length s, seeded per walk: meanders, not random steps):
`dir = normalize(MOMENTUM · dir_prev + (1 − MOMENTUM) · rotate(g/|g|, θ))`; step one texel.
Constants: ALPHA 1.4, SLOPE_FULL 0.25 (cells per cell), TURN 1.1 rad, JITTER_PER 24 texels, MOMENTUM 0.55,
GUIDE_BLUR 3. (The first build *added* the jitter as a vector; where the coast and downhill terms cancelled it won and
walks curled into loops — visible in the first stills. Turning the guide bounds every step within ~63° of it.)
So on flat land a river heads for the coast and wanders; on a cone or a massif's flank it runs downhill (radial
drainage off a volcano for free); it does **not** route round high ground — a walk that meets a ridge on its way to
the sea cuts through it (§3 turns that into a gorge). That is the "control over paths" the owner asked for; a pure
steepest descent would bring back the priority flood's behaviour.

**Sources.** A jittered grid of `SOURCE_SPACING` (36 texels, ~290 cells); in each cell, `SOURCE_TRIES` (6) random
land texels at least `SOURCE_COAST` (120 cells) from the coast; the highest `G` wins (springs on massif flanks and
plateau rims), kept with probability `1 − 0.85 · dryness(latitude)`. Plus each volcano's flank (§5). Walks run in
order of decreasing coast distance, so long trunk rivers are laid first and later walks join them.

**Merging (a tree).** Each texel remembers which water node owns it. A step that lands within one texel (8-neighbour)
of another walk's node joins it: `next = that node`, the walk ends. Earlier walks are complete trees ending in the
sea, so the result is a forest rooted in the sea — no cycles by construction. A walk that revisits its own texels is
allowed to cross itself; one that has not reached the sea in `MAX_STEPS` (4n) steps ends on land (counted:
`stranded`; it should be ~0).

**Mouths.** A step onto a water texel adds a mouth node there (level `sea − 0.4`, `still`), as rivers.ts does.

**Lakes (not in step 1).** The walk has no lakes: rivers2 worlds have none (`lakes = []`). Designed lakes are an open
question (Q3 below).

**Torus.** Positions are kept in texel units, wrapped mod n; neighbour differences use the short way round.

## 2. Accumulation, catchments, widths

**Catchments = the river nodes' Voronoi on land** (a BFS, 8-neighbour, from every water node's texel): each land
texel drains to its nearest node. Since §3 makes the ground rise away from the rivers, this *is* the drainage, by
construction (not an estimate). Each node's own runoff = its texels × `(1 − 0.85 · dryness)`; `acc` = own + all
upstream (upstream-first order, `rivershape.upstreamFirst`). Width `w = min(12, 2 + 0.3 √acc)` and the depth/speed
rating (`world/rivertable.ts`) are unchanged.

`Catchments` (`own`, `ref`, `order`, `of` sampled every 2 texels) is filled from the same BFS, so the held rivers'
per-watershed wetness (`weather/catchwet.ts`, `CatchmentWet`, RWS1) keeps working unchanged: same struct, new tree.
The node record (`NODE_WORDS` 8: x, y, level, width, next, flags, depth, speed) is unchanged, so `riverAt`,
`riverCut`, the held river table and the riverFlow contract all read the new rivers as they read the old.

## 3. The profile along each river (levels)

Per node, `Gmin` = the least `G` over its 3×3 texels (the ground beside the line, not just under it).

    L_k = min( Gmin_k − inc(w_k),  min over upstream u of L_u )          (upstream-first order)

`inc(w)` = `rivershape.incisionFor` (1.2–4.5 cells). Monotone non-increasing downstream **by construction**, and
never above the ground beside it. **Where the falls go:** wherever `Gmin` drops faster than the river — a mesa's or
cliff's edge, a region's step, a cone's rim — the running minimum drops at once: a waterfall at the cliff, by
construction, without searching for cliffs. Where the walk climbs (it crosses a ridge on its way to the sea) the level
stays down and the ground is cut to it (§4): a gorge through the ridge, a canyon through a plateau.

**Rapids / staircases.** On reaches steeper than `CASCADE_SLOPE` (0.6 a node) the level is floored to whole
`CASCADE_STEP`s (3.5) — the existing rule — which keeps it monotone and under the ground.

**Lateral consistency (accordant junctions).** A river may not stand above the ground another river's valley leaves
at its node (§4's h, with this node's least ground `Gmin_i` for G — a lower bound of the GPU's, since h grows with G):

    L_i ≤ Gmin_i − fade(e) · max(0, Gmin_i − (L_j(s) + V_tier(i)(e)))
          for every segment j of node i's landform within CLAMP_RADIUS (36 texels) whose projection of i is inside it

Violations lower `L_i`; the monotone pass runs again; repeat (only nodes near a node that moved) until nothing drops
by more than CLAMP_TOL (0.05 cells — under the levee's 0.2). Both steps only lower, so it converges. A tributary near
the main river comes down to it (a junction at grade; a fall where it was hanging). Only rivers of one landform are
compared, as only they shape each other's ground (§4).

## 4. The height (`src/terrain/valley.wgsl`, per cell on the GPU, inside `compose.wgsl ground()`)

**Distance field.** A second, *cost-weighted* JFA over the nodes (`cost = L_node + VJ · dist`, VJ 0.15) gives each
texel the node whose valley is lowest there, unbounded in distance (the existing JFA keeps the nearest node within 6
texels for `riverAt`). At a cell, the candidates are the nodes of the 4 texels round it in both tables, each with its
two segments (main upstream → node, node → next). Per segment: projection `s`, lateral distance `d`, edge distance
`e = max(d − w(s), 0)`, level `L(s)` (the river's own `segLevel`). A segment's upstream end has no round cap (a
point behind it belongs to the segment above; without this a fall's lower reach would cut a cone back into the
lip), except at a source.

**Valley profile** (per region tier; blended across a border by the ground's `w`):

    V(e)  = BANK · (1 − exp(−e / 1.5)) + FLOOD_SLOPE · e
          + σ · [ τ · ln(1 + exp((e − F) / τ)) − τ · ln(1 + exp(−F / τ)) ]           τ = 4,  F = FP_K · w
    Hv_c  = L_c(s) + V(e_c) + (1 − share of c's landform in the ground here) · LF_PEN     per candidate segment c

a low bank (BANK 0.5), a floodplain gently rising (FLOOD_SLOPE 0.015) out to `F`, then a valley wall of slope σ (a
softplus: no crease). **A river shapes only its own landform's ground**: a segment's valley counts by its landform's
share of the ground here (A's weight `w` if it is A's landform, `1 − w` if B's), the rest a penalty LF_PEN (400) —
so a lowland river at a mesa's foot leaves the cliff alone, and a plateau river carves only the plateau.

**Raise away from the rivers** (the owner's "raise the terrain based on SDF away from rivers"), `d` the least
distance to any river segment:

    R(d) = RAISE · (1 − exp(−d / REACH)) · smoothstep(0, 300, coast)

**Combine rule (precise):**

    G'   = G + R(d)
    fade = 1 − smoothstep(VW / 2, VW, e_c)
    h    = min over candidates c of  G' − fade(e_c) · max(0, G' − Hv_c)          (h = G' where no valley reaches)

`G` is everything the default world computes up to and including the craters, oddities and volcanoes (landforms,
massifs, mesa edges, region detail, stamps); the coarse world's changes, lakes, the river's channel cut (`riverCut`),
gorges and talus follow as before. Within a valley's reach VW the ground comes down to the valley's profile; beyond
it the landforms stand as they were, raised.

| tier (Region.tier) | FP_K (floodplain, × w) | σ (wall slope) | VW (reach, cells) | RAISE (cells) | REACH (cells) |
|---|---|---|---|---|---|
| 0 lowland | 5 | 0.12 | 260 | 6 | 250 |
| 1 upland | 2.5 | 0.35 | 180 | 28 | 350 |
| 2 plateau | 0.6 | 1.8 | 70 | 0 | 1 |
| 3 massif | 1 | 0.7 | 150 | 45 | 450 |

Why faded and not the plain `min(G + R, Hv)` the first build used: with a plain minimum every valley's wall extends
forever, so a valley wall of slope 0.7 from rivers ~290 cells apart caps every massif at ~100 over its rivers and a
volcano's cone is cut away by the valleys of the rivers at its foot — and the clamp (§3) then had to drop plateau
and flank rivers by up to 215 cells and did not settle. The fade bounds each valley: peaks between valleys keep their
height, and where a valley crosses high ground its walls steepen as the fade closes (a gorge).

What this gives, and why it meets the owner's three conditions:
- **Rivers at the bottom.** On the river line `e = 0`, fade 1, `Hv = L ≤ G − inc`, so `h = L`: the river is the
  local minimum of its cross-section, and the land rises away on both sides (V, then the landforms and R). No levee,
  no pit (§3 keeps the levels consistent between rivers).
- **Mountains and cliffs keep their drama.** Beyond VW `h = G + R ≥ G`: massifs, mesas, cliffs and stamps are
  untouched or raised; they are cut only where a river runs through them — a gorge, and a fall where the river
  leaves the high ground.
- **Flats stay flat.** On lowland RAISE is 6 and the floodplain is 5 half-widths wide with a 1.5 % rise.

The cost table is selection only: the minimum is over the candidates found, so it is continuous where the candidate
sets agree; where a candidate drops out of the 4-texel neighbourhood the field can step (a known limit, §8).

## 5. Volcanoes (stamp kind 4 + walks)

Placed by the build when the flag is on: in volcanic regions (lavafield, basalt, rift) by size, else on fault strips
(Region.flags 2) — up to `VOLCANOES` (4), each its own stamp (`STAMP.volcano`, compose.wgsl `oddityAt` kind 4):

    t = r / R (r warped by a slow noise: lobed, not a circle);  cone = H · (1 − t)^1.6 · (1 − 0.07 · gullies(angle))
    crater (t < C = 0.16): rim at H · (1 − C)^1.6, bowl down by 0.45 H at the middle

R 380–620 cells, H 140–230. A stamp adds to the ground (it rises *above* the landform). Lava walks start at the rim
(four directions), water walks on the flanks at 0.55 R (five directions); the walk's downhill term makes them radial.
Lava walks run until the sea, a water river, or `LAVA_RUN2` (160) steps — four times the old 40: "more flow for hot
lava". Lava levels follow the same profile (inc = 1.4): magma falls exist where the cone or a cliff drops. Lava walks
never join water rivers and water walks ignore lava nodes.

## 6. What breaks with the flag on (a different world)

The flag changes the macro ground, so everything keyed to the atlas moves: sites and towns (`sites.ts` places on the
new ground and rivers), roads, Muru and other authored places looked up by world point, the coarse world, saved
worlds (a world saved with rivers2 off is a different world; nothing stops loading one under the other — TR7). Step 1
only lists what breaks in the streamed level; it does not fix town placement.

Seen in step 1's run of the loop level (`level=atlas&town=1&loop=1&a.rivers2=1`): the level boots, no page or console
error; the town's site moves (the window's origin 14400,4416 → 13120,5888: sites are chosen on the new ground and
rivers), so Muru is not where its authored data and the loop's pinned places expect it; the lakes are gone (anything
keyed to a lake — lake towns, the flood tool's basins found from them — has none); the old lava rivers' 40-texel
tongues are now 160-step walks, so lava reaches places it never did. In 25 s neither world had finished "Building the
town", so whether the town builds and plays on its new site is not yet seen.

## 7. Costs

CPU at build (off the frame path): the walk is O(nodes); the BFS O(N); the clamp O(nodes × neighbours in
CLAMP_RADIUS). GPU at build: one more JFA (12 passes) and the valley in both macro passes. Per streamed column: up to
16 segment tests in `ground()` (the river lookup already does 8). Measured (seed 1, n = 2048, a machine shared with
two other builders): rivers on the CPU 3.6–6.8 s against the default's 0.8–1.5 s (walks 0.3–0.4 s; levels and the
clamp 1.8–3.7 s; the rest the BFS and the table — TR4), the cost JFA 0.18 s, the second macro pass +0.03 s. The
per-column cost on the streaming path is not measured yet (a phone bench item before the flag could be a default).

## 8. Open questions for the owner

1. **The combine rule.** `min(G + R, Hv)` cuts rivers into everything they cross (gorges through ridges and
   plateaus). Alternatives: a smooth min (softer valley shoulders), or `max` by tier (a massif's own ground wins over
   the valley above some height: rivers route round instead of through). Which reads better at play zoom?
2. **The guide field.** Coast SDF + downhill + jitter. Do you want a third term — attraction to region borders /
   faults (rivers along fault lines), or a hand-painted guide?
3. **Lakes.** The walk has none. Options: a lake where a walk's level stalls under a rim (designed basins), lakes at
   volcano craters and plateau tops, or the old priority-flood lakes kept as a separate pass.
4. **Raise shape.** `R(d)` is a plain saturating ramp — ridges between rivers are smooth. Ridged noise on R, or R
   tied to the catchment's order (bigger interfluves between bigger rivers)?
5. **Volcano placement**: volcanic provinces only, or also hotspots in the sea (islands)?
6. **Cliff tiers at falls.** Where a river leaves a mesa, the lower river's valley carves the cliff's lower tiers away
   (one 171-cell drop where there were steps). Keep (a gorge cut back into the cliff), or protect a cliff's tiers
   within some distance of the fall (VW smaller at landform borders)?
7. **Lava's reach.** 412 lava walks of up to 160 steps (from every volcanic region's top, as before, and the vents):
   lava now crosses whole regions. Fewer, longer flows from the volcanoes only?
8. **Muru.** With the flag the town site moves. Pin the authored towns' sites (the walk avoids them, or a river is
   routed past them), or let towns follow the new land?

## 9. Step 2: the valley as a two-scale field (replaces §4's lookup and fade)

**The owner (2026-11-17, DECISIONS):** "Could you do an atlas scale JFA for the river distance then interpolate that
and add a finer JFA to the actual detailed river?"

**Why §4 stepped.** §4 takes, per cell, the minimum over the segments of the nodes held by the 4 texels round it in two
tables. That minimum is continuous only while the candidate set is the same; crossing a texel line swaps a texel's
nodes, and if the segment that gave the minimum leaves, h jumps — the 5-cell flats-and-jumps in the plain's
cross-section and the contour-like bands on valley sides (TR3/TR11). The fade made it worse: `G' − fade·(G' − Hv)` is
not a minimum of G-independent surfaces, so nothing can be interpolated between cells without knowing G.

### 9.1 Everything in warped space

Let `ω(p)` be riverAt's warp (|∇ω| ≪ 1) and `q = p + ω(p)`. In q-space the river *is* the node polyline riverAt
tests, so every field below is built and sampled in q-space: the valley follows the meandering channel exactly
(§4 also warped; step 2 keeps it), and a continuous field of q is a continuous field of p.

### 9.2 One G-independent surface per river, and their envelope

For a segment c (nodes a → b; `s*` the projection, `w(s)` the width, `L(s)` riverAt's `segLevel`) at a point x:

    e_c(x) = max(|x − P_c(s*)| − w(s*), 0)                                   edge distance
    S_c(x) = L_c(s*) + V_τ(e_c; w) + Φ_τ(e_c)                                  the river's valley surface
    Φ_τ(e) = PHI_SLOPE · m + PHI_CURV · m²,   m = max(0, e − VW_τ/2)          its bound (PHI_SLOPE 1, PHI_CURV 0.01)
    E(x)   = min_c S_c(x)                                                    the valley envelope

`V_τ` is §4's profile (bank, floodplain, softplus wall) for the tier τ of the ground at x. `Φ` replaces §4's fade:
inside VW/2 the valley is its profile; beyond, its surface climbs ever more steeply, so a valley still ends — peaks
between valleys and cliffs well beyond VW are untouched — but as a *surface*, not as a blend with G. (The first build
used `600·((e − VW/2)/(VW/2))²`: 9–34 cells a cell at the rim, more than a texel's samples can hold — the interpolated
field crossed the land in single-cell steps, which the continuity probe found. Φ's slope is now ≤ 7 to 300 cells out.)
How far a valley cuts into high ground now depends on how high: it meets ground H over its floor at
`m ≈ (−1 + √(1 + 0.04 H))/0.02` — 0 at H 0, 82 cells for H 150, 130 for H 300. Because each S_c is continuous and G-independent, **E is continuous and
G-independent**: a minimum of continuous functions. That is what makes it interpolable.

**At the medial axis between two rivers at different levels** nothing jumps: the level is never carried. E switches
from one river's surface to the other's where they are *equal* — a crease (a ridge between two valleys, each wall at
its own river's level + V), not a step. Sampling E on the texel lattice and interpolating bilinearly rounds that ridge
down by at most `K·Δ/4` (K the walls' slope, Δ the texel, ~8 cells): ~0.25 cells on a lowland plain (σ 0.12), ~1.4 on
a massif (σ 0.7), ~3.6 at a plateau gorge's rim (σ 1.8) — never a jump, and only on the ridge, where the ground
(min below) is usually lower anyway. Carrying the level and blending it, or a smooth-min of the two nearest, were the
alternatives; both still need a G-dependent combine and a per-cell candidate set — the thing that stepped.

**A river shapes mostly its own landform** (§4's rule, made continuous). §4 added LF_PEN by the cell's share of the
river's landform; where compose's border weight w is a hard step, or two landforms meet at one height, that put a
25-cell wall into flat ground (the probe's largest seams after the switch to the envelope). Now the penalty is a ramp
by the landforms' own JFA distance `dl` (compose's `Ground.dl`, the distance into the cell's landform from its border —
the owner's "JFA to find distance to the borders"):

    pen(x) = min(LF_PEN, LF_SLOPE · dl(x))                                          LF_SLOPE 4 cells a cell
    Ê(q)   = Σ_t β_t(q) · ( E_t + [ℓ_t ≠ ℓ(x)] · pen(x) )        β: quadratic B-spline weights over 3 × 3 texels

(β was bilinear in the first build: continuous, but its gradient kinks at every texel line, and the map's hillshade
showed them as straight streaks; the quadratic B-spline is C1 and smooths the field by a fraction of a texel. The
same applies to D̂. The bounds on rounding below are for bilinear; the B-spline's are of the same order.)

Each texel stores the landform `ℓ_t` of the river that gave its E (chosen with the same ramp at the texel, stored
without it). dl is 0 at the border on both sides and continuous, so Ê is continuous where the cell's landform ℓ(x)
switches. A foreign valley rises out of a landform at 4 cells a cell: a mesa's cliff (steeper) stands, its foot is
rounded at most; at a border between two landforms at one height the valley ends in a 76° bank, not a step.

### 9.3 Coarse: the atlas-scale field (build, GPU)

On the n × n texel lattice of q-space (n = 2048, Δ ≈ 8 cells):

1. **A two-slot JFA over the nodes** (`valleyjfa.wgsl`, seeded by each node's texel, 12 passes + 1): each texel keeps
   two node ids — the *nearest* (by the exact distance to the node's two segments, not to the node) and the *lowest*
   (by S at the texel centre, with the texel's landform penalty). A pass reads its 3 × 3 at the step's offset, two ids
   each, and keeps the best of each kind.
2. **The field** (`valleyField`): per texel, the union of the 3 × 3 neighbourhood's slots (≤ 18 nodes, each its two
   segments, a source its head segment §9.5) evaluated exactly at the texel centre:
   `E_t = min S_c`, `ℓ_t` the winner's landform, `D_t = min |x − segment|` (for the raise).
3. Stored in the valley block (replacing step 1's lowest-cost node table): two words a texel — E_t (f32) and
   `pack2x16float(D_t, ℓ_t)` — 32 MB at n = 2048 (step 1's table was 16 MB; the JFA's ping-pong buffers are the
   build's own and freed after).

The JFA is approximate for S (as any JFA for a non-distance cost); a texel that misses its true lowest river gets an E
too high there — a bump, continuous, not a seam. The 3 × 3 union at the end catches most misses; measured by the
continuity probe (§9.7).

### 9.4 Fine: at the detailed river (per cell, streaming path, GPU)

The coarse field is smooth over Δ; at a narrow channel the bilinear floor sits up to `K·Δ/4` over the river line.
Within a band of the actual channel the exact profile takes over:

    h_f(p) = L_rv + V_τ(e_f; w_rv) + FINE_K · max(0, e_f − FINE_E)² + [ℓ_rv ≠ ℓ(x)] · pen(x)
    e_f    = max(x_rv · w_rv − w_rv, 0)                       (riverAt(p): the nearest segment, exact distance)
    E_cell = min(Ê(q), h_f(p))

FINE_E 6 cells, FINE_K 1: h_f follows the exact segment for ~6 cells past the bank and climbs out of reach within ~10
more, so the coarse field rules everywhere else. riverAt *is* the fine JFA: its table is a JFA of the nodes (nearest
within 6 texels) and its test the exact distance to the nearest node's two segments, at the cell — no new pass, and
ground() already calls it (moved before the valley). A finer lattice was considered — atlas-wide at 1–2 cells a texel
is 8192² × 8 B = 512 MB; in river bands only needs a sparse tile map; per streamed batch costs 12+ passes a batch and
needs margins ≥ the band to agree between batches — and none gives more than riverAt's exact distance does. h_f can
step only where riverAt changes river between two rivers both within ~16 cells — at junctions, where the clamp keeps
the levels accordant.

### 9.5 The combine, and why the river stays the bottom

    G'  = G + R(D̂),   R(d) = RAISE (1 − exp(−d/REACH)) smoothstep(0, 300, coast) · room       (§4, D̂ bilinear D_t)
    h   = smin(G', E_cell; SMIN_K),   smin(a, b; k) = min(a, b) − (k/4) · max(0, 1 − |a − b|/k)²            k = 4

smin rounds the crease where a valley's wall meets the land (the valley's shoulder) over ~k cells; it never exceeds
min. On the river line e = 0: `h ≤ E_cell ≤ h_f = L + V(0) = L ≤ Gmin − inc` — the river is the bottom; riverCut cuts
the channel under it as before. Beyond the reach, `S ≥ L + PHI > G'`: h = G' (the landforms, raised).

The lateral clamp (§3) uses the same surface: `L_i ≤ min(Gmin_i, L_j(s) + V_τ(e) + Φ_τ(e))` — a plain min: with
smin two rivers at one level lowered each other by k/4 a round and the clamp never settled (41 rounds, measured).

**Heads (springs, not blades).** Step 1's heads: the width grew linearly from 2 over 16 nodes and the valley ended in
the source's round cap — a long straight-sided taper to a point, in a valley that just stopped. The owner: "for a real
river typically there are mountains with either cloud runoff or glacial melt that sends many little creaks down to feed
the head of the river then it does the walk". Now:
- *Creeks* (walks.ts `CREEK`, built): after the main walks, each water walk's head standing MIN_H (40) or more over the
  sea — high ground, where cloud and melt water come from — gets up to PER (4) creeks. A creek starts at the highest of
  TRIES (8) points in a disc of R (10) texels round the head that stands RISE (6) over it, steps toward the head plus
  downhill on the blurred ground (DOWN 1), turned by half the walk's jitter, momentum 0.5, for at most MAX (30) steps,
  and is kept only if it meets a river (the head's first nodes or a neighbour's) — a fan of short steep tributaries
  converging on the head. They are ordinary water nodes: widths grow from 1.2, levels come from the same running
  minimum, each creek's source gets the valley head and spring below, and the head of the walk stops being a source.
  ```
        ·  ·   ·           creek sources (highest of 8 tries, ≥ 6 over the head)
         \  \ /  /
          \  V  /          creeks: toward the head + downhill, joined where they meet
           \ | /
            \|/
             o  the walk's head ──── the walk to the coast
  ```
- *A valley head*: each source s (next node b) gets a virtual head segment from s to `H = s + u · HEAD_LEN`,
  `u = (s − b)/|s − b|` (straight on, up the valley), HEAD_LEN 56 cells, in the coarse field only (no water):

      L_h(t) = L_s + (G_H − L_s) · t^HEAD_POW,  w_h(t) = w_s (1 − t),  t ∈ [0, 1] from s to H
      G_H    = max(the first macro ground at H, L_s + HEAD_MIN)                      HEAD_POW 2.5, HEAD_MIN 4

  The floor stays near the spring's level for half the length and then climbs to the land at H, narrowing as it
  goes: a hollow with a steep back wall (an amphitheatre — a rock face where the land behind rises fast, by the
  ground's own slope materials), and past H the valley is gone.
- *The channel*: width `w = min(12, 1.2 + (0.8 + 0.3√acc) · √min(1, hops/16))` — a 1.2-wide spring that widens fast
  and then slowly (concave, not a straight taper).
- *A spring pool* (riverCut, flag on only): within SPRING_R (1.3, inside riverCut's 1.35 channel reach) half-widths of a source node the channel is
  SPRING_D (1.2) deeper — water rises in a pool, not out of a blade's tip.

### 9.6 Costs

| | step 1 | step 2 |
|---|---|---|
| build, GPU | cost JFA 12 passes (1 node a texel) | two-slot JFA 13 passes + the field pass (18 nodes × 2 segments a texel) |
| build, memory kept | n² words (16 MB) | 2 n² words (32 MB) + a word a node (head level) |
| per streamed column | 4 texels × 2 tables × 2 segments = 16 segment tests | 4 texels × 2 words (bilinear), riverAt already done, h_f: one profile |

Measured (the build's timings, a toggle diff of the columns' pass) in the DEVLOG entry.

### 9.7 How it is checked

- The same cross-sections as step 1 (`plot-cross-*`), from the same spots.
- **Continuity**: `scripts/terrain/continuity.mjs` — windows of 128 × 64 cells round sampled river nodes, every
  neighbour pair along rows and columns, the channel ±3 cells and standing water left out: max |Δh|, p99, p99.9, and
  *isolated steps* (|Δ| ≥ 1 between two flats that change ≤ 0.3: a seam's signature, not a slope or a cliff). Off,
  step 1 and step 2.
- Unit tests (Node): the envelope's continuity across a medial axis and across texel lines on a synthetic two-river
  field, the head segment's profile, the smin.

### 9.8 For the owner's pending choices (design only, not built)

**Lakes** (Q3). Two constructions, both compatible with the envelope (a lake is a flat surface S = level inside its
shore, so it joins E as one more surface):

    (a) a walk pools                          (b) lakes placed first
        ~~~ source                                 lake L (level, shore SDF) placed in a basin of G
         \                                          walks: sources may start at a lake's outlet; a walk that
          \___ level stalls under a rim             enters a lake's shore joins it (the lake is a node)
          [====pool====]  rim = least G round       outlet = the shore point nearest the coast (or the
                 \ spill at the rim's lowest point     lowest rim), the river leaves there
                  \__ to the coast

  The owner's direction (2026-11-17): the river "does the walk and joins other tributaries and creates lakes at flat
  areas" — that is (a), lakes found by the walk where the ground goes flat, so (a) leads; (b) stays for authored lakes
  (crater lakes, the caldera, a lake town).

  **(a) as a construction — a walk pools at flat ground and spills at the rim.** While walking, track the macro
  ground's slope under the walk (`|∇Gs|`, as the guide does). Where it stays under FLAT_SLOPE (≈ 0.02) for FLAT_RUN
  (≈ 6) steps, or where the walk's next step would climb (the ground rises ahead by more than `inc` — a basin), the walk
  *pools*:
  1. Flood from the walk's position on the macro ground (a priority flood over texels, bounded to POOL_R ≈ 40 texels,
     CPU at build — or the GPU flood of `terrain/flood.ts`, which already fills a basin to its spill): the lake is
     every texel connected to the start under the *spill level* `Ls` = the lowest rim texel's ground (the first texel
     the flood reaches that has a lower neighbour outside).
  2. If the basin is too small (area < A_MIN) or too deep for a "flat area" (Ls − G_min > D_MAX), don't pool: walk on
     (the clamp and the valley carve through, as now).
  3. The lake becomes a node (still, level Ls − 0.2, `lakeAt` texels — the default world's lakes' table format, so
     `lakeAt`, the held water and the flood tool read it unchanged); the walk ends in it; a new walk starts at the
     spill point (the outlet), with the lake's level as its upstream level so the running minimum continues from it.
     Other walks entering the lake's texels join it.
  4. In the valley field the lake is one more surface: `S_lake(x) = Ls − depth(x)` inside the shore (depth from the
     distance to the shore, a JFA of the lake's texels — its bed), `Ls + V(e_shore)` outside (a flat shore rising like a
     floodplain). It joins E's minimum like any river; the walk's own valley carries the outlet's level on downstream.
  ```
     walk ───→ ground flattens (|∇G| < 0.02 for 6 steps) or rises ahead
                 │ flood the basin to its spill level Ls
            ┌────┴──────────────┐
            │   lake (level Ls) │ ◄── other walks entering join here
            └───────────┬───────┘
                        ● outlet = the rim's lowest point → a new walk from here, level ≤ Ls
  ```
  Expect lakes on plains and plateau tops (flat), behind ridges a walk would otherwise gorge through (rising ahead),
  and in craters and the caldera; few in steep country. The counts are a knob (FLAT_SLOPE, A_MIN, D_MAX).

**Cascades that keep a cliff's tiers.** Today the lower river's valley (its S_c) cuts back into the cliff, and the
fall is one drop. Keep the tiers by giving a fall a *stepped* level and a narrow profile near it:

        upper reach ──────┐                    upper reach ───┐
                          │  one drop                          └─┐ tier 1 (the mesa's MESA_TIERS)
                          │                                        └─┐ tier 2
                          └────── lower                               └──── lower

  - level along the fall segment = the cliff's own tier heights (mesaEdge knows them at the border: sample G along the
    segment in the macro pass and take the levels of its flats, monotone);
  - near a fall node (within ~2 VW_lower of it) the lower river's profile uses the *plateau* row (narrow, σ 1.8) on the
    cliff's side, so its valley does not eat the tiers — a slot gorge cut back into the cliff, each tier a fall.

**Volcano silhouette.** Today a cone `H(1 − t)^1.6` with gullies reads as a dark disc top-down and two rims in
section. To read as a volcano at play zoom: (1) a steeper upper cone and a broad apron, `H·[0.65(1 − t)^2.4 + 0.35(1 −
t)^0.9]` — concave flanks; (2) the crater rim higher on one side (a breached crater, the lava walks leaving through the
breach); (3) lava and water walks' valleys on the flanks are radial gullies the envelope already cuts (keep VW small on
the cone: a cone tier, VW 40, σ 0.9); (4) material by slope and age: fresh black basalt in the lava channels, weathered
red-brown on the cone, green on the apron — the dark disc is one material over the whole stamp.

### 9.9 The combine rule (Q1): the owner's masked blend as the leading candidate

The owner (2026-11-17): "multiple height fields tied to regions that are shaped by noise or other functions then I
like to use thresholds to define discrete regions, JFA to find distance to the borders, then blend the heightmaps. A
mix of discrete masks that change how layers are blended often looks better than any single straight blend."

As a rule for the whole ground:

    layers      H_k(x)          height fields: each region kind's own function (noise, ridges, mesa, cone …)
    masks       M_j(x) ∈ {0,1}  thresholds of fields (region id, a noise above a level, tier, "near a river")
    distances   d_j(x)          JFA distance to each mask's border (signed)
    blend       h = B_{M(x)}(H_1 … H_k; d)   the *mask pattern* at x picks the blend operator: a smoothstep mix over
                                            d, a min, a max, a step with ledges, a smooth min …

What compose.wgsl already does this way: regions are discrete masks (Voronoi cells × land/fault thresholds); `distR`
is the JFA distance to their borders (`m.s`, signed toward A) and to the coast (`m.coast`) and the landform's border
(`m.dl`); each region has its own height function (`regionHeight`); and the **EDGE_* kinds are exactly
mask-chosen blend operators** — EDGE_SMOOTH a smoothstep over s, EDGE_CLIFF / SEACLIFF a hard step with caves,
EDGE_TERRACE stepped, EDGE_MESA (`mesaEdge`) tiers with ledges, jointed blocks, ravines and ramps, chosen per pair of
regions. Stamps (craters, oddities, volcanoes) are added layers with their own masks (inside R).

Where the rivers fit: the valley field is one more layer (E, G-independent) with its own masks and distances —
`D` (the JFA distance to the river), the tier (which profile), the landform mask (§9.2's ramp by `dl`). The combine
`h = smin(G', E)` is one fixed operator. In the owner's scheme it becomes mask-chosen:
- *lowland and upland, no landform border near*: smin(G', E) — a valley in soft ground;
- *a cliff or mesa border within VW* (`dl` small and the border kind EDGE_CLIFF/MESA): `max(E, G'_tiers)` on the cliff
  side within MESA_REACH — the valley may not cut the tiers (the cascade question, §9.8) — and smin elsewhere;
- *massif* (tier 3) *above a height threshold* (H > Hcut): `G'` wins (rivers route round peaks: §8 Q1's "max by tier");
- *plateau*: a hard step at the gorge's rim (`min` with a slot profile) — a canyon, not a valley.
Implementation: the operator is a small switch on a mask word computed per cell from what compose already has
(EDGE kind of the nearest border, tier, dl, a noise threshold for variety) — the same switch shape as `mesaEdge`'s.
This is the leading answer to Q1; to be tried after the owner sees step 2's stills.

### 9.10 Erosion passes between runs (later, recorded)

The owner: "we could easily run some actual erosion passes between runs to keep things looking plausible." Where it
would plug in: the atlas is built once per world; between runs (the generative simulation's slot — "sim generative
between runs", project notes) a few GPU passes of hydraulic/thermal erosion on the **macro ground** (the atlas's n × n
`hmac`, or the coarse world's cells, `coarse.wgsl`, which already holds per-cell changes that persist) — e.g. a stream
power step `∂h = −K A^m S^n` with the drainage A from the river tree's catchments (we have them: `Catchments`), plus a
thermal slope limit — written as a *delta layer* (like the coarse world's `dr`), so the designed field stays the source
and erosion is a reversible, persisted layer on top. The valley field (E) is unaffected; the rivers' levels stay
designed (erosion lowers banks and fills hollows, never raises a river over its banks — the delta is clamped at the
river line). Cost: tens of 2048² passes, well under a second on the GPU, off the frame path. Not in step 2.

## 10. Plains with character, and the restructure to the owner's method

The owner (2026-11-17): "build it right and if it makes sense to restructure do so. I was pretty happy with how cliffs
looked already but rivers planes felt a little boring … land is just more interesting when there are hills and
visually distinct regions." And: "For plains a cool truck is voronoi cells that are tilted with a gradient height
towards one or more edges …" (DECISIONS, verbatim).

### 10.1 The plains layer (built: `src/terrain/plains.wgsl`, `AtlasP.terrain2`, flag on only)

One more height field in `ground()`, after the region borders and before the stamps and the valley (so the walks run
round its hills and the valleys cut through them):

    mask      sub-regions: a warped Voronoi of PL_CELL (520) cells; each cell's kind by its hash
    kinds     0 flat 18 % (truly flat: nothing added) · 1 rolling hills 20 % (fbm, 0..14·amp, rises only)
              2 low ridges 10 % (ridged fbm, 0..11) · 3 terraces 10 % (a slow rise cut into 3.5-cell treads, short risers)
              4 hummocks 10 % (Worley mounds 2.5–6 high, 30 cells apart) · 5 wet flats 7 % (−1.5, flat)
              6 tilted cells 25 % (the owner's, §10.2)
    blend     edge = smoothstep(0, PL_EDGE, (f2 − f1)/2): each kind faded to 0 at its sub-region's border by the
              Voronoi's own border distance (the cellular field's exact JFA) — neighbours meet at the base
    weight    tier (lowland 1, upland 0.6, plateau / massif 0: cliffs and mesas untouched)
              × smoothstep(60, 250, coast) × smoothstep(20, 120, dl) (dl: the landforms' JFA distance — nothing at a
              landform border, so mesa edges and cliffs keep their character)
    relief    = weight · edge · H_kind(x) · amp (0.7–1.3 a sub-region)

### 10.2 Tilted cells (the owner's trick)

A Voronoi of TL_CELL (150) cells inside a tilted sub-region; each cell c a plane rising across it:

    h_c(x) = H_c · clamp(0.5 + (x − c)·d_c / TL_RUN, 0, 1)            H_c 3–9 cells, TL_RUN 150 (≤ 0.06 a cell)
    at the border with the nearest other cell b, δ the exact distance to their bisector (positive inside c):
    h(x)   = mix(min(h_c, h_b), h_c, smoothstep(0, w_δ, δ))
    w_δ    = TL_SCARP (1.5 cells) on most of the border — the raised edge drops to its neighbour in a small cliff;
             in a GAP (a slow noise along the border over a threshold, ~1/4 of the length, period TL_GAP 70) the drop is
             a ramp, w_δ = |h_c − h_b| / 0.3
    tilt   d_c near a river (coarse D < 420): along ∇D — 65 % rise toward the river (a bluff over the floodplain: the
           valley cuts into their raised edge — "river coasts more dramatic"), 35 % away; elsewhere a hash direction

Continuity: on the bisector both sides evaluate to min(h_c, h_b) — continuous; the lower side is never changed. At a
Voronoi vertex the second-nearest switches between two cells within the scarp's 1.5 cells — a small seam at vertices
(a known limit).

**Traversability, the rule.** (1) Inside a cell every point reaches the cell's low side down a slope ≤ H/TL_RUN
(≤ 0.06). (2) A border is crossed at grade wherever the two planes agree, and up or down a ≤ 0.3 ramp in its gaps;
scarps are the rest. (3) Every border longer than ~2 gap periods (~140 cells) has a gap almost surely, so the cell
graph through passable borders is the Voronoi adjacency — connected. Not guaranteed: a short border may have no gap
(its two cells still meet round it through their other neighbours) — a GPU connected-components check over the cells
(the existing cc kernels) would make it a guarantee; not built.

**A town on tilted cells** (not changed — towns are generated as before): a town-sized area (~600 cells) holds ~16
cells; its streets would read the ground as terraces of 3–9-cell scarps, crossing them only in the gaps (ramps) or
along the low sides — the street field's slope cost already sees a 1.5-cell scarp as unwalkable, so roads would
meander through the gaps, as the owner described. Shown: local/terrain2 (the town-area still).

### 10.3 The restructure: fields, masks and blends (the plan; 10.1–10.2 and §9 are its first two layers)

`ground()` with the flag on is now a stack of height fields, each with its own masks and border distances, combined
by mask-chosen operators — the owner's method. What exists and what is planned:

| layer | field | masks (discrete) | distance (JFA / exact) | blend operator | status |
|---|---|---|---|---|---|
| continents | lift by the coast | land / sea | coast SDF | add | existing |
| regions | regionHeight per region kind | region id (Voronoi × land × fault thresholds) | border distance s | EDGE_* kind per pair: smooth, cliff, terrace, mesa (tiers, ledges, ravines), wall | existing (untouched) |
| massifs, detail | ridged massif, region detail | region kind | — | add | existing |
| plains | §10.1 kinds incl. tilted cells | tier, sub-region kind | Voronoi border, landform dl, coast | add, faded by distance | **built (flag)** |
| stamps | craters, oddities, volcanoes | inside R | radial | add | existing (+ volcano, step 1) |
| valley | envelope E (§9) | river reach, landform | D (two-scale), dl | smin(G', E) | **built (flag)** |
| raise | R(D) | tier | D | add | step 1 |
| combine by mask | — | EDGE kind near, tier, height | dl, D | smin / max on a cliff's side / G wins above Hcut | planned (§9.9) |

Next (not in this step): (a) the valley's combine as a mask switch (§9.9), so a mesa's tiers stand at a fall; (b) the
per-tier constant table (`VALLEY`) replaced by per-region-kind profiles — each region kind its own valley profile and
plains mix, as the region's other height functions already are; (c) lakes as one more surface (§9.8).

**Later: rooms and passages as masks.** The owner's game-design-aware generation (BACKLOG TR-L5) plugs in as one more
mask source: an authored SDF of rooms, passages and doors (from the level kit) with its JFA border distance. Inside a
room the plains kind is forced to flat / wet flat and the valley combine to smin; on barrier cells the kind switches to
tilted cells with scarps only (no gaps), ridges, or a dense-growth flag for flora — the same switch, a new input.

## Later (recorded, not built in this step)

The owner (2026-11-17): tilted large Voronoi regions to make cliffs; the blended rules (SDF + Voronoi + fractal ridge)
for spires, stepped drops, ravines with sediment sloping toward their top; masks (ridged or dual-threshold simplex)
carving deeper into mesa regions for **narrow channels between mesas** (bridges, cliffside cities in ravines; needs
camera work); underground rivers and lakes with the cave layer; cities underground, on waterfalls, in jungles, on
cliffs, on floating islands (intervals).

How this step's machinery would serve deep channels between mesas: the distance field and the valley profile are
generic — a *channel walk* (a walk along a mask's zero line rather than to the coast) with a narrow, deep profile
(F ≈ 0, σ ≫ 1, its floor below the mesa's base) would cut a slot between mesas using exactly §4's `min`; a mask alone
(no walk) can't give a monotone floor, which matters only if water runs in it. What `mesaEdge` already does: tiered
walls with ledges (MESA_TIERS by a noise along the edge), jointed Voronoi blocks, columns off the foot, buttes, eroded
ramps with pillars, and ravines cut back into the edge by a noise's zero lines with rising floors (`rav`, `rise`) —
the spires/steps/ravines vocabulary exists, but only within MESA_REACH of a landform border, never as channels
through a mesa's interior.
