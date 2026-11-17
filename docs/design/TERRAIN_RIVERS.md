# Terrain: rivers first (TR) — step 1 design

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
