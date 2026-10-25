# Backlog — every open suggestion, so nothing is lost between sessions

The running list of the user's suggestions and deferred work. Each item has an
id, the round it came from (DECISIONS.md has the user's words), a size
(S ≈ hours, M ≈ half a day, L ≈ a day+) and a status. When an item ships,
move it to **Done** with the commit; when the user changes their mind, note
it here. Agents: read this before starting work and keep it current in the
same commit as the change.

Order agreed (round 10): A1–A5, A8, A12, A13 → A10, A14, A11 → A9 → A7 → A15 render slopes → A6 + A15 sediment layer. Answers: A15 render first then sediment; A7 the player taps the lightning; A9 on the title screen, default Medium.

Status: `won't do` (user declined) · `open` · `next` (agreed, queued) · `wip` · `asked` (waiting on the
user) · `deferred` (agreed for later).

## Round 10 (2026-10-08) — new batch

| id | item | size | status |
|---|---|---|---|
| A1 | Title screen: howling desolate wind + periodic gusts while it is barren (softening as it greens) | S | done `a8d51c0` |
| A2 | Level: barren map → more desolate wind sound (and gentler as it greens) | S | done `a8d51c0` |
| A3 | Drag audio: whoosh starts when the drag starts; no snap/rustle at mouse-up — wind only | S | done `a8d51c0` |
| A4 | Player gusts sound deeper than the desolate ambient wind | S | done `a8d51c0` |
| A5 | No birds on the title screen (they make the skull look giant) | S | done `a8d51c0` |
| A6 | Blown dust piles up against things (drifts, lee of walls) | M–L | done `5995426` |
| A7 | Tutorial builds skills: (1) growth and death of flowers, (2) wind blowing, (3) free play to demonstrate it, (4) something new: a pile of pollution the wind can't move, (5) a storm forms and lightning destroys it | M | done `6e03680` |
| A8 | Wind is more powerful under storms | S | done `a8d51c0` |
| A9 | Difficulty setting: easy (green never re-pollutes), medium (green resists), hard (green easily killed by blown trash, strong wind, too much water) | M | done `5866665` |
| A10 | Seeds that land greenify their spot and clean a little pollution (makes birds and wind over plants matter) | S–M | done `e8b2efe` |
| A11 | Wind over flowering plants sheds the flowers (petals blow off); they take time to regrow | M | done `e8b2efe` |
| A12 | Map wind: a steady prevailing flow one way across the map; only minor noise, also mixed into the player field | S | done `a8d51c0` |
| A13 | Storm shadows swirl erratically — make their shape steadier | S | done `a8d51c0` |
| A14 | Light (not dark) fair-weather clouds/shadows drift over to show the wind | S–M | done `e8b2efe` |
| A15 | Smooth tops for soft surfaces (dirt, dust, sand, water) vs hard steps for stone; sub-cell height; "over a gap = sheer drop, under = smooth" as a surface property | M (render) / L (data) | done (render `a015f55`, sediment `5995426`) |

## Round 23 (2026-10-11, session 4)

| id | item | size | status |
|---|---|---|---|
| Q1 | The scrolling ripple noise looks right on deep water but odd on shallow water (the little puddles left behind): fade it out where the water is shallow | S | done (this commit) |
| Q2 | Test on `strata`: a concrete basin full of sand — blow down a wall, does the sand spill out? | S | done on `strata` (this commit): a 12×12 concrete basin of sand by the physics garden; a 4-wide gap lets ~25 cells of sand out in ~3 s, a fan at repose |
| Q3 | Destroyed blocks either become a new material in place (stone → gravel) or become particles (gravel → sand grains) — refines P3; same volume (user) | M | step 1 done on `strata` (this commit): Break/lightning turn solids to rubble in place where the hole is open above, crushed cross-sections squeeze out as rubble beside them; step 2 (grains that carry it — and the volume Break still removes under what's left above) open |
| Q4 | Visual artifacts: sand/dust in storms looks like a wall interpolating from the top of a tall structure to its base, popping in and out; blocky dark patches in water running under rain (the bright rain/foam patches are the user's favourite water effect — keep them) | S | done (this commit): sheets aren't shared where a covered column's solid top (or wet bed) stands > 3 over another's surface; water boxes hide side walls the sheet joins (they showed through the neighbour's water as dark blocks) |
| Q5 | Physics goals: a believable, responsive collapse is the juice; some solids persist (skewed, buried finds); strong cyclones lift light pieces; pieces break each other and the world; they fall and only crumble on impact. Plan: Rapier (WASM) for the motion on its own branch off `strata`, zero bounce, impacts destroy the overlapping voxels into rubble + dust (Q3) instead of pushing apart; cyclone drag on bodies | L | dropped (round 25): the user tried `rapier` — decent but jerks too much at times; not worth it even for cyclones throwing pieces. Keep the collapse mechanics with strict grid alignment (strata's straight-down falls); `rapier` stays unmerged as a reference. Ported to `strata`: loose ground banked against a structure doesn't hold it (fracture.ts `holds`). Arbitrary orientations / multiple grids = a future project |
| Q6 | Borders between ground materials (dirt / sand / rubble / grass) look artificial: square, on the cell grid. User suggested an SDF; other techniques welcome | M | done on `strata` (this commit, round 26): bilinear vote over the four nearest columns + world-space noise + per-material relief, plant cover smoothed the same way; only ground at about the same height (cliffs, concrete keep crisp edges); for the user's visual pass. Not done: column side walls under an edge, stains and wetness still per cell |
| Q7 | Lightning sometimes strikes far off horizontally then arcs to the click — feels off. Clicks should pick the actual 3D voxel; strike the highest point (biased to metal, away from stone, but always something rather than air) within a radius-6 sphere whose lowest point is the voxel clicked (a column above the hemisphere); still arc from a tall thing nearby | S | done (this commit): powers.ts `lightning()` — bowl of STRIKE_R 6 on the picked voxel, open upward; score = top + STRIKE_DRAW (steel 5, rust 4, water 1, stone −2, concrete/brick −0.5) − 0.25·distance; the 40-cell metal pull is gone |
| Q8 | Lightning shouldn't cost Nature (the mechanic is bad): a short cooldown of ~1 s | S | done (this commit): STRIKE_COOLDOWN 1 s, no cost |
| Q9 | Sandbox Break tool: the cursor highlight is a ring projected from above, but Break is centred on the picked voxel | S | done (this commit): a sphere outline (+ dashed equator) round the voxel under the cursor, picked as Break aims |
| Q10 | Instead of a summon button, swirling (the tornado gesture) mostly over water summons the lightning storm — no buttons or Nature meter to worry about | S | done (this commit): a swirl with ≥ half its points over water > 0.3 deep raises a storm at its centre instead of a cyclone; the ☁ button, the R key and the Nature meter (+N pops) are gone. `Nature` still computes underneath but nothing reads it — remove or repurpose later |
| Q11 | Stone should be smooth too, with ragged vertical rises only above a threshold (1–3 blocks) | S | done (this commit): stone `smooth: 2` — rises of up to 2 are drawn as slopes, taller stay sheer (knob: materials.ts) |
| Q12 | Could stone use a hex grid instead of square (more natural features)? Not if it means un-unifying the model; unsure how it meets concrete | L | discussed round 28: a real hex grid for stone would split the model (every system works on square columns) — not doing that. A render-only version is possible (heightfield ray-march over hex/Voronoi cells in stone columns' boxes, sim unchanged); deferred — first see if Q14's facets are enough |
| Q13 | Fire sparks (embers) should be able to set flammable things alight where they land | S | done (this commit): embers get vertical drag (they used to climb forever), rise a few cells, cool and drift down on the wind; a landing marks `sparkTex` (tick + 1), and fire.wgsl lights dry fuel there (EMBER_CATCH 0.35 × fuel, less when damp or raining) |
| Q14 | Trash particles smaller; dirt / dark-brown particles a bit smaller. Render-only: can rock look more jagged and natural — Voronoi bumps on the surface, blending to the adjacent material's height outside the Voronoi? | M | particles done (this commit): litter 0.28 → 0.18, grime clumps 0.22–0.32 → 0.14–0.21, dust 0.20–0.32 → 0.15–0.24. Rock, step 1 done (this commit): Voronoi facets (~0.8 cell) on stone faces — each its own tilt for the light, dark cracks, facet tone; shading only. Step 2 (bumps that change the silhouette / blend into neighbours' heights) needs a per-pixel height march — open |
| Q15 | In profile the rocks look totally straight: vary them for rendering so they cut a jagged silhouette (the river gorge is an example) | M | done (this commit, round 29): stone is carved — a per-pixel march into its box to a surface up to 0.45 inside its exposed faces (3D value noise), discarding rays that miss, so cliff edges and walls are jagged; faces against neighbours aren't carved (no gaps). Only when zoomed in past 10 px per cell |
| Q16 | Sediment spikes again: columns get super high during rain storms (seen on mobile) | S | done (this commit): planted columns took in mud and never slumped — rain lays alternating thin layers (mud, dust from the air), so the top interval stayed ~1 deep and held() never let go; roots now hold a slope at most 1 cell steeper than the repose (HOLD_STEEP). Reproduced on desktop too |
| Q17 | Some tiles don't render: you see straight through to the background (rock sections; on desktop too) | M | done (this commit): two causes. (1) Dust/sand sheets had no sides, assuming they always taper; where one ends at a step (or beside ground drawn lower) the strip under its edge was empty — sheets now show that side (sheetGap). (2) Carved rock: a ray leaving a side below the neighbour's ground, where that neighbour's facing side isn't drawn, now counts as a hit, and rises the smoothing draws as slopes aren't carved. Background pixels in 4 zoomed views: 4127 / 4311 / 6386 / 7957 → 210 / 58 / 461 / 235 (the rest is mostly sky past the map edge) |
| Q18 | Frame rate is low on the phone | M | done: low is the default tier everywhere (round 54); `?q=medium|high` for more; the agents' fields sweep 2 a tick on low (round 58: 1.18 → 0.51 ms with 12 units) |
| Q20 | Sediment lighter on phones (round 58, the units session): at half rate on low, or only where the ground is disturbed. Half rate isn't cleanly stable: its wind carry scales with the time step while its slumping, smoothing and piping are per pass, so per-pass transport would double against the same smoothing, and doubling the smoothing overshoots (six neighbours each taking 0.2). Options: half rate with slumps at half speed (rescale only the time-step terms, measure the see-saw); an active-region mask (only columns near something that moved, wind past lifting, water, rain); or leave it | M | open: the user's call (round 60: "Those all seem like reasonable performance improvements") |
| Q19 | Loose ground lying higher than the rock beside it should erode/collapse down to the rock's top or below (Q17's sheet sides are a fine stopgap) | M | open |

## Round 22 (2026-10-11, session 4)

| id | item | size | status |
|---|---|---|---|
| P1 | Falling pieces still sometimes push back up: no block ever moves up (only the particles a destroyed block emits) | S | done `5ca2c24` |
| P2 | A dying cyclone drops its dust where the column stood: it should lose power and fall while spreading out | S | done `5ca2c24` |
| P3 | Destruction, the fun version (iterate later, not now): a broken structure is a rigid body supported from its base that tilts and falls; every impact destroys the blocks that intersect and turns them into material particles (stone → gravel/sand, brick → dust); nothing but particles goes up | M–L | later (user: "eventually") |
| P4 | Consolidate: one material-interval model (fractional heights; loose and solid in the same layers), intervals and particles the only carriers, fluids move material between them — refines N1; on its own branch, merged when ready | L | wip on branch `strata`: stages 1–3 done (`a4accd5` fractional intervals, `abfcfef`/`ee23953` loose ground in the layers, `8a67864` spill from exposed faces); waiting for the user to test |

Agent notes from P4 (judgement calls for the user, not yet asked):

| id | item | size | status |
|---|---|---|---|
| P5 | Valley soil now slumps at the sandbox's repose (soil 1.4, rubble 1.7, ash 0.9 — the old whole-cell rules had 3, 4, 2); the valley still looks close but may need N2's reshaping | S | asked |
| P6 | Thick ash counts as a blown film: the title diorama's ash mound is drawn plain and plants on it would be dormant | S | asked |
| P7 | Layer slots are 4× larger (16 B): undo ring (8 copies of the layers) ~100 MB on the sandbox; structure/surface passes ~0.2 ms slower — a 2-word slot (f16 or 12.4 fixed heights + pending accumulator) would win it back | S–M | open |
| P8 | The loose sheet has no side faces: a deep loose run at a cliff edge shows a gap under its edge (seen before only in the sandbox) | S | open |

## Round 21 (2026-10-10, session 4)

| id | item | size | status |
|---|---|---|---|
| O1 | Bodies crumble much more easily on impact and break up into pieces; impacts make dust and chips | S–M | done `1011af2` |
| O2 | Speed limit on bodies (~1.5× the topple speed), collision response damped further | S | done `1011af2` |
| O3 | Bug: in storms, columns of loose ground rise into the sky | S | done `5cad379` |
| O4 | See-through dust clouds and debris particles where bodies break and land (hide the remaining jank) | S | done `b337f3e` |
| O5 | The switch from static structure to rigid body sometimes jumps instead of moving smoothly | S–M | done `b337f3e` |
| O6 | Broken chunks only fall straight down (no rigid-body tumbling/bounce: it breaks the illusion of scale) | S | done `aa774ed` |
| O7 | A deeper bass crumbling sound | S | done `aa774ed` (unheard; user: improved) |
| O8 | Cyclone spawn cooldown of a second or two within one drag; a fresh press resets it | S | done `aa774ed` |

## Round 20 (2026-10-10, session 3)

The batch now (M), then the larger work (N) after an architecture review.

| id | item | size | status |
|---|---|---|---|
| M1 | Rigid bodies feel bigger: slower fall (lower gravity, air drag), more rotational inertia, soft contacts (no bounce, sink in slightly, gentle push-out); crumbs up to ~12 voxels become loose ground | S | done `d81ad6e` |
| M2 | Every click: a little ring of wind pushing out from the cursor | S–M | done `6c1b7d8` |
| M3 | Lightning: small radius around the click (rolling sphere), biased to metal within ~40 cells; a branching chain from what it hits to near the cursor, setting fires | S–M | done `533c384` |
| M4 | Night sounds: crickets and owls instead of birdsong | S | done `a783c51` |
| M5 | Frogs near water with green around it | S | done `a783c51` |
| M6 | Metal drums ring by their size (connected metal voxels), snapped to a pentatonic scale | M | done `3ab876b` |
| M7 | Handoff + memory for the remaining work | S | done |
| N1 | Architecture review: consolidate (solid intervals; one loose stack for everything soft — rubble, litter, the valley's soil; liquids carry it; wind-borne particles settle into it) | M | next; see P4 (user's three-system version, own branch) |
| N2 | The valley onto the loose ground (reshaped rock, river erosion matched to the old rates) | M–L | after N1 |
| N3 | Growth redesign: taps grow only from green or seeded fertile ground; seeds spread it; fertility = clean + moist + uncovered | M–L | step 1 done (this commit, branch `story`): story rules — seeds only; green sheds seeds into the breeze (slow creep), a tap on green lets go a puff of seeds; reach (R1) |
| N4 | Puzzle-mode opening on the camera director; barriers to growth as level gates; wind/cyclone/storm unlocks by green | M–L | after N3 |
| N5 | Ancient seeds buried, uncovered, planted or sent down the river to the next level; every level has a river | M | after N3 |
| R1 | Reach: the camera is confined to the land around the green, by the green's size (~1.5× the width across it); touch and wind only work there; fog beyond | M | done (this commit, branch `story`): game/reach.ts — per patch max(8, ¼ width) past its edge, following its outline; only green touching the reach counts (wild patches are found); never shrinks |
| R2 | Story levels keep a Free play mode (old rules); the built levels are in the sandbox's load list | S | done (this commit, branch `story`) |
| R3 | A level teaches its skills through gates, then the goal: reach the lab / make the lab itself green | M | open (with N4) |
| R4 | Buried bonus seeds to find: uncovered, washed downstream, carried to the next level's river to seed new green (N5) | M | open |
| R6 | Gate library + validator: a level is a DAG of regions and gates (barrier prefab + key); headless tests per gate — which abilities open it (any that physically clear it are fine), and that ambient weather alone doesn't; abilities are never locked, obstacles that only one ability clears teach it | M | open (with R3/N4) |
| X1 | Spin-off: disasters-only city game (meteors, floods, volcanoes, wind, fire, aliens), a full city reacting to disasters — the arcade/mayhem version, now the `mayhem` branch (round 33, docs/BRANCHES.md); working title "FEMA Mayhem" | L+ | branch `mayhem` |
| X2 | Variant: Townscaper-style builder — a free-form terrain and weather tool for setting up little towns; people behave like the animals (clear trees, build houses where the land suits); houses by WFC on an irregular grid, stacking where dense, so the land grades city → village → farmland → forest (docs/LEVELS.md) | L+ | idea (user, round 31) |
| X4 | Sandbox world editor: place and modify prefab structures, raise mountains, shape the land with wind, rain, meteor impacts, volcanic eruptions; save/load worlds (docs/BRANCHES.md) | L | branch `sandbox` |
| X5 | The map engine generalised (round 34): intersecting grids — e.g. a hex nature grid of material intervals, a rectangular voxel grid for structures, an irregular grid for Townscaper-style WFC buildings — with precomputed overlaps so each reads and writes the others' fields; mixes terrain and non-terrain features and looks better (docs/BRANCHES.md; X2 grows from it; revisits Q12) | L+ | branch `grids`: hex nature grid running (sim + prisms, DEVLOG 2026-10-16); rotated structure grids (14301ef); air inside them — projected intervals and the open air between them (multi-span); a tilt slider on the sandbox's Place tool. Next: sliding by the face normal, the wind field seeing structures, displacement when a structure is placed into or lands on the ground (the user: drop what it pushes out back onto it, or up through its holes), water inside structures, a column's plants are one value (the ground's plants show on sand that lands on a floor over it) |
| G13 | Rendering (round 37): (a) tops alone — an interval or drift sheet whose six sides are all hidden is drawn as its 12-vertex top (done, this commit: draw 7.0 → 5.2 ms); (b) the terrain as a continuous heightmap surface, prisms only where sides show; (c) level of detail by zoom; (d) a display heightmap finer than the hex grid; (e) culling to the view; (f) cached screen tiles (G-buffer, relit each frame) only if needed; (g) smooth-lit soft tops and sheets (done, ?smooth=0 compares); (h) the field mesh (option C, rounds 38–39): the terrain as one surface meshed from a field evaluated from the intervals (and the structures' voxels, for the fillets) — the whole map in 32-cell chunks, rebuilt only when their hash changes (done, this commit: ?mesh=1; draw 6.1 → 3.0 ms); structures stay cubes and built materials prisms (sharp); a detail layer roughens rock, rubble and trash; water a smooth sheet on it, cliffs warped by noise, only chunks near the view rebuilt (done, round 40); a shadow pass from the sun in place of the march (done, round 40); thin water a film on the ground, shores (swash, swell, wet sand) and waves across the wind (done, round 41); next: a compact vertex, no empty rebuild dispatches, built things on square grids and round tanks (with G14), the mesh on by default once tried on a phone; later perhaps a cached top-down albedo and normal, relit when the light changes | L | (a), (g) done, (h) in progress; draw is fragment-bound now (DEVLOG 2026-10-22), branch `grids` |
| G14 | Structures on regular and irregular grids, built by Townscaper-style WFC (some cities rectangular, some organic), on top of the multiple grids, burying and slopes (round 37) | L+ | after X5's grids work together |
| G15 | SDF-based flow fields; people as particles who build and clear vegetation on their own (round 37) | L+ | much later (after G14) |
| G12 | Momentum for loose ground (round 36): a persistent slide velocity for the top run (like water's pipes, six values) — strictly one per open level (an underground river, sand on a room's floor: the user), one per column for now, on per material by an inertia value — dry sand little, wet soil a lot — so slides run out past their repose: mudslides, avalanches off a tilted roof, debris flows. Water stays its own model; mud = saturated soil coupled to it. Only if cheap (estimate ~0.1–0.2 ms, 24 bytes per column) | M | open — after sliding by the face normal (it shares the slide), branch `grids` |
| G16 | Cached terrain tiles (round 60, the user: "Even rendering to orthographic tiles could speed up things right? A few layers like terrain and units and you would have cheap renders no?"). The camera is a fixed-angle orthographic one, so a terrain tile's image holds under panning. Plan: cache per tile a G-buffer (depth, normal, albedo/material), not finished colour, so day/night, shadows and weather light it each frame in one cheap pass; re-render only tiles whose columns changed (a dirty bit per chunk, set by every system that writes the layers); draw units, water, particles, sway and anything animated live over it, depth-tested against the cached depth; re-render all on a zoom change (or keep a zoom ladder). Measure first: what share of `draw` is the terrain, and how many chunks a tick dirties in wind and rain | M-L | open: measured on `perf` (round 61): at a phone's low-tier frame (206×457 px) the desktop GPU's terrain draw doesn't scale with what's drawn (fixed costs), so caching shows nothing there; to judge on a phone |
| X3 | Variant ideas to try: Zen mode (no goal, weather on autopilot, photo mode); River relay (the story levels joined by one river: what you send downstream arrives in the next level) | M | idea |
| R7 | Level tools: kit (world/kit.ts), CPU map preview (scripts/mapview.mjs), gate validator (game/trial.ts + scripts/gates.mjs), the Trial Grounds test level (levels/trials.ts, hidden; ?skipmenu=1&level=trials) | M | done (this commit, branch `story`) |
| R10 | Poison and oil wash out under one passing storm (any water film dissolves 0.16%/tick, independent of depth), so they can't be gates; proposal: a solubility cap (water holds so much poison per depth: rain films saturate, heavy deposits need a flood's volume). Changes the whole game's cleanup pace. User (round 34): decide it in the `puzzle` branch; lean — oil hard to get rid of without burning it (that makes it fun), and water dissolves only so much per amount of water | M | open (`puzzle`) |
| R8 | Puzzle catalogue + easter eggs to build from (docs/LEVELS.md): dust sea, ember relay, lightning rod, flood flush, retaining-wall slump, quarantine line, plateau, oil lake, drought, wind tunnel, firebreak, cascade, windbreak, bird bridge, the lab shell; seed caches, buried spring, hidden meadow | L | open |
| R9 | Seed caches found: when the reach reaches an uncovered cache, it wakes (flowers, a message, a count) — kit `cache()` places them | S | open |
| R5 | Story arc: valley = the lab that made the virus (biohazard signs on the tanks, ruined military vehicles as a quarantine barrier, signs of flight); then the escape from quarantine (highway); then the city wiped out by plague (N6, C7, C9) | L | open |
| R11 | The reach's fence readable (round 42): on a phone the camera seemed locked — nothing shows the edge or says the green's spread opens it; a soft edge at the boundary and a hint (on `ambient`, where the story lives) | S | open |
| N6 | Story through environment: the valley re-themed as a biological research base (biohazard sign, lab); highway barricades (quarantine); city tents (plague) | M | with C7/C9 |
| N7 | Red sludge: a third liquid (dense, toxic) | M | open |
| N8 | Body deformation (spring-linked voxel clusters, World of Goo-like) | L+ | later |
| F7c | Bodies step 3: impacts split bodies (done by O1); structures resting on fallen bodies are held by them | M | open (holding part) |

## Round 19 (2026-10-10, session 3)

| id | item | size | status |
|---|---|---|---|
| L1 | Lightning blasts a crater in whatever it strikes — stone too, loose ground, fallen bodies | S | done `78deeb6` |

## Round 17 (2026-10-09, session 3)

| id | item | size | status |
|---|---|---|---|
| J1 | Loose layers checkerboard (neighbouring columns see-saw), worst in wind: stabilise the transport and the top-material switching | S–M | done `c208a2d` |
| K1 | Bodies step 1: sleeping bodies keep their frame (no re-voxelising); projection of sleeping bodies into a per-column body-top texture; cap ~64 bodies / 16k voxels (oldest small ones crumble to loose ground) | M–L | done `a6d40a5` |
| K1b | Break works on bodies too: the Break tool removes voxels in a body's own frame; what's left splits into its connected pieces (they wake and fall); crumbs become loose ground | M | done `3273598` |
| K2 | Bodies step 2: loose ground, water and integrity read the projection (pile on, slide off, bury); bodies wake when disturbed | M | done `b60e6fe` |
| K3 | Bodies step 3: impacts and damage split bodies along their own grid; small pieces become loose ground by material | M | after K2 |

## Round 16 (2026-10-09, session 3)

Order: I2 → I1 → I3, then talk I4 through with the user.

| id | item | size | status |
|---|---|---|---|
| I1 | Soft ground is all loose and smooth: no packing of loose layers into cells; up to four stacked loose layers per column (strata); soft cells (soil, sand, ash, silt) become loose layers when a map loads; only solids are stepped. The surface's material is the top loose layer's | L | done `4b35dc6` in the sandbox (valley needs reshaped rock) |
| I2 | Dust grains that land put their dust down and fade within a second or two (no long-lying grains) | S | done `a85dd7d` |
| I3 | Water carries soft material: what lies at the water's edge or under flowing water (rain runoff too) washes in, travels with the flow, settles where it slows, or leaves the map | M | done `4b35dc6` |
| I4 | Rigid bodies in their own frame: sleeping bodies stay skewed, rasterised into a per-column occupied range so layers bury them; impacts/damage split them; small pieces become aligned voxels or loose material | L | talk first |

## Round 15 (2026-10-09, session 3)

Proposed order: H5, H6, H1 (quick) → H8 → H2 → H4 → H3 → H7 (with F12); F7's remaining polish after.

| id | item | size | status |
|---|---|---|---|
| H1 | Title screen: random low gusts now and then (grass waves, dust blows) | S | done `dd81319` |
| H2 | Airborne dust settles back into drifts downwind (mass kept) instead of vanishing | S–M | done `f500cb6` |
| H3 | Loose surfaces (dirt, ash, sand) behave like dust: fractional loose layer, steeper repose, higher wind to lift (dirt maybe never); stone stays stepped | L | done in the sandbox (a `2101762`, b+c strata); valley later |
| H4 | Water loosens and carries loose material (dirt, packed trash); asphalt/concrete need lightning or cyclones to crack and break down first | M | done `dc50fc3` |
| H5 | Oil keeps burning in rain (trees still go out) | S | done `6c6ffc6` |
| H6 | Storm outlines steadier (shape changes too fast) | S | done `59ca6ed` |
| H7 | Larger models to place: tall buildings (ties to F12) | M | done `e5e420c` |
| H8 | Green over loose material binds it: dust under established plants can't be swept out and slowly becomes soil | S–M | done `bd89f13` |
| F7b | Break tool for anything + physics garden in the sandbox | S | done `d062a54` |

## Round 14 (2026-10-09, session 3)

Order: G1–G4 (quick) → G5 with F7 (destruction prototyped in the sandbox) → F12 → C7, C9, C8.

| id | item | size | status |
|---|---|---|---|
| G1 | Fireflies sparser, in small patches | S | done `efb6b3e` |
| G2 | Sandbox reachable from the start, plainly (a real button, not a footnote link) | S | done `e7a961b` |
| G3 | No cap on summoning cyclones (no cooldown); several at once is a follow-up (one cyclone slot in Globals today) | S (cooldown) / M (several) | done `66025c2` |
| G4 | Title screen: repeated taps grow a diorama-scale sapling, not the level's tree | S | done `6768d10` |
| G5 | The sandbox as the physics playground: test and play with physics, placing things and every mechanic (F7 lands there first) | ongoing | open |

## Round 13 (2026-10-09, session 3)

Proposed order: F1, F8, F9 (quick fixes) → F2, F4, F3 (brushes) → F6 (save/load, E8) → F5 (model atlas) → F11, F10 (title) → F7 (toppling) → C7, C9, C8 (which reuse F5's models).

| id | item | size | status |
|---|---|---|---|
| F1 | Dust drifts sink under water and oil: liquids lie on top of the dust (water/oil see drift as ground), so dust is never drawn over a pond | S–M | done `f7c2acb` |
| F2 | Layer brushes: one press = one layer with a soft edge (fractional per column, so repeat clicks build a smooth mound); dragging over the same place in one press adds nothing more. Calmer sandbox base map (lower-frequency patches) | S–M | done `3baa5fc` |
| F3 | Deposit brushes drop material from above (falling grains you can see) that lands and settles by angle of repose: dirt, sand, gravel, dust — real strata | M | done `3baa5fc` |
| F4 | Bedrock brush: stone rises from below, lifting the layers above it | S | done `3baa5fc` |
| F5 | Model atlas: layered voxel models (ruined cars, tankers, ruins, tents, …) stamped into the world as real matter (buryable, breakable); editor palette with thumbnails. Feeds C7/C9/C8 | M–L | done `977b043` |
| F6 | Map building: save/load sandbox maps, undo, brush cursor ring (absorbs E8) | M | done `98f7f58` |
| F7 | Destruction: Noita-style rigid-body chunks + crumble particles; breaks where moment (carried mass × lever, relaxed along support paths) exceeds strength × thickness² (thickness from a JFA distance field); islands cut from the ground fall; bodies re-voxelize at rest by inverse sampling; terrain keeps a column rule (absorbs E4) | L+ | wip (A smash `3a52069`, B fracture + bodies done) |
| F8 | Dust particles softer: more transparent, rounded | S | done `de35b4c` |
| F13 | Physics voxels (round 43, branch `physics`, docs/PHYSICS.md): one GPU solver for every material (lattice shape matching; steel bends and stays bent, stone cracks into rigid pieces; contacts never push out, deep overlaps and hard impacts crumble to loose ground); drop and heat-beam tools (done `56a07d5`); the map's structures wake into bodies when touched, softer metal, the beam drawn, aimed above the finger and hot enough to cut (done, round 44); the nature grid sees the bodies (done, round 46; the air in them stays air, landings shove the air and raise dust, round 47); the beam melts the ground into lava, volcano vents pour it, it flows, boils water, lights fires and sets into basalt (done, round 47); concrete crumbles more and rings less (damping, cracks on impact; done, round 48); foundations let go when their ground goes, digging wakes ruins (done, round 48); the meteor (smoky from the sky, a crater blown out to dust, wind out every way), a volcano cone that rises 30 cells then pours lava down its gullies, smooth lava (done, round 48); a game model on the renderer: `addVoxels` documented as the public API, a voxel size per instance (n/16 of a cell) for the GameplayGM hover bike (done, round 49); next: lava bombs, a rigid pass for big stiff bodies, sleeping | L+ | wip |
| F14 | Mixed resolution (round 49): the simulation stays coarse (whole-cell lattice voxels) and refines only where needed. A body's lattice spacing is its own (1, 1/2, 1/4 of a cell), so small things like the bike have a fine lattice. A voxel that cracks or crumbles splits into eight children half its size (velocity, heat and material inherited), which break further before going to dust and particles. At rest, fragments go back to loose ground (no explicit coarsening at first). Done (round 49): a voxel size per body, fragments (docs/PHYSICS.md "Mixed resolution"). | L | done |
| F15 | Deformable meshes (round 49): a lo-fi mesh drawn over a physics body, its vertices bound to the nearest lattice voxels (weights at bind time) and moved in the vertex shader by each voxel's position and rotation, so it dents, bends and twists with the body. Triangles stretched across a crack are dropped (it tears), as are those on crumbled voxels; heat glows per control voxel, lit and shadowed like the world. The lattice is what the simulation sees (heat, lava, wind, sand); the mesh is only how it looks. For the hover bike: a mesh on a half-cell lattice, the game driving it, damage read back. Done (round 49): `spawnMesh`, skinning, tearing, voxels in the tears (docs/PHYSICS.md "Meshes over bodies"); the game API (round 49): installPhysics, wake (ruins, or a chunk), drive, impulse, push fields, state readback (docs/PHYSICS.md "For games"). | L | done |
| F16 | Loose ground animates when it moves (round 50): grains stream off slumps, out of faces and down where loose ground lost its support, run down the slope and settle | S | done (this commit): running grains (particles.wgsl K_RUN) from the flow sediment.wgsl writes into the air texture; real momentum is G12 |
| F17 | Snow and leaf litter (round 50): snow a loose material that drifts in light wind, falls in cold storms and melts near heat; leaf litter loose and light, blowing as leaves | M | done (this commit): materials 25 and 26, the climate (Globals climate, sim ClimateSystem), flakes in cold storms, snow and leaves blowing as particles; next perhaps: snow on the peaks by default in the valley, autumn |
| F18 | Crystal and ice (round 50): faceted transparent solids; water freezes and ice melts with temperature | M | done (this commit): materials 27 and 28 drawn blended and faceted (render.wgsl shadeGlass), water freezing from its bed up under a frosted skin, ice melting; next perhaps: real refraction, shadows through them, ice floating |
| F19 | Seasons (round 51): broadleaf crowns turn autumn colours (birch gold, the rest red, orange, amber; conifers stay green), shed leaf particles in their colours, thin to bare in winter and green again in spring; grass turns gold and straw, dull brown in winter; leaf litter falls mostly in autumn, mottled in autumn colours | M | done (this commit): Globals season, ?season= / ?year=, WorldCore.yearLength |
| F20 | Cover on props (round 52): snow, and dust, on the faces of structures that look up — snow while it snows there, melting in the warmth, swept off by a gale; dust under a dust storm or wind-lifted grit, washed off by rain. Sand cover (buried) was already there. Physics bodies and CPU models don't take it yet | M | done (this commit; scripts/covertest.mjs) |
| A1 | Agents that build and mine (round 52, DECISIONS): walkable surfaces from the intervals, fields per goal shared by state-driven groups, GPU units, digging and carrying (conserved), building on a Townscaper-style irregular grid, felling, fleeing, attacking; procedural characters later. Branch `agents` off grids (the user, round 52). Steps 1-2 done (surfaces, fields, GPU units; docs/AGENTS.md); fields a game reads and per-place confinement; the units session's enemies as agents, first slice (kinds and models, wander/chase/swing, swing events, batched hits, fire, water, sync readback). Slice 2 done: tumbling (thrown, launched, let go, off a cliff; bounces, slams, hard landings hurt, gets up), knock-overs by mass, hold/release/launch/lob, fire from lava, hot ground, embers and touch. Next: digging and carrying; deaths left lying | XL | in progress; mass and stun (round 56): hits push and lift ÷ mass, `stun` on hits, launches and lobs (scripts/knocktest.mjs); the world's wind and blasts, ÷ mass, past a calm (round 57, scripts/windtest.mjs); real reach and line of sight instead of a height band (round 59, scripts/reachtest.mjs); round 63: carrying and throwing (loads are ground, taken and put exactly: carrytest). Then crews dig, fell (logs), fire bricks and pile (crewtest). Next: building (API6) |
| API2 | Layer pulls (round 52; the world editor's first ask, DECISIONS): `terrain.pull(material, { mode, roughness, lean })` → a stroke, `to(x, y, { radius, height })` each frame, `end()`; `terrain.pullLayer` one-shot. Modes lift and through; overlapping calls compose (per-stroke memory per column, 8 strokes at once); the loose ground it lifts is shaken off (rounds 53 and 55: `shake`, default 1; for 4 s it slips at a lower angle, faster, roots letting go). Not yet: `conserve` (take the volume from a ring), sideways shoving, `expose` (strip the cover down to a material) | M | done (this commit; scripts/pulltest.mjs) |
| API1 | The world API (round 52, DECISIONS; docs/WORLD_API.md): Reclaimed as an engine, the world the game's — `createSim(host, worldDef)`, modules installed on their own, CPU-mirror queries in world coordinates, commands queued inside, events out, insides private. Steps 1–3 done (84c1236): terrain / water / fire reads and ground ops, wind (blows, strokes, wakes; no cap), fx by name. Then (this commit): smooth sampling as the field mesh draws, typed views cached per read, warmup with debris (WorldDef.warmup, attachSim, sim.warmup). Next: agents (on `agents`), physics, plants, weather (storms, the sun, per-place light), places, models, events out; content as data (plant species, materials: what it'd take is in WORLD_API.md); persistence later | XL | in progress |
| API3 | Watersheds and locks (round 52): lasting sources (`water.source(at, rate)`, rain-fed catchments), and a per-place lock mask (a contract buffer the sediment, material, lava and edit passes honour): `erosion` (no carving or deposit, water still flows), `terrain` (nothing changes the ground), `all`. Rules: locks stop natural change; the game's own edits pass unless `hard`; blasts and melting obey the lock. Sediment carried in: held at the border, or (round 53, the user's experiment) simply vanishing as it enters, so there are no artifacts at the border The base of W3 (freeze) | M | proposed |
| API4 | Simulation windows (round 52): `sim.run(seconds, { region?, speed })` — fast-forward, with everything outside the region locked (API3), keep the result | S | proposed, after API3 |
| API5 | Settlements on agents (round 52; AGENTS step 4): homes spawn residents, workplaces make jobs (job fields seeded at the sites); woodmill (fell a tree: the veg goes, logs carried), quarry (dig real stone through the layer ops: a pit; carried, conserved), farm (clear growth, plant); job and state changes on the CPU, movement on the GPU fields | L | proposed, after API2 |
| API6 | Building on an irregular grid (round 52; AGENTS step 5): Townscaper's relaxed quads over the hex lattice, cell and corner adjacency queries, occupancy, and a stamp of a piece's voxels into a structure grid; the editor owns the style rules | L | round 65 (builder): step 1 done — the town (build/town.ts, towngrid.ts, townstamp.wgsl): blocks on the relaxed quads, walls/floors/doors/windows/hip roofs/arches from the neighbours, stamped into the columns as plaster and tile (real matter, not a structure grid); `api.town()`, the editor's 🏠 tool (towntest). Plan mode done (round 65: `town.plan`, `delta`, `api.buildCrew` — workers carry bricks or logs from a pile, a block stands once it's had its cost; buildtest). Next: stairs, the look of the walls (each hex column a fluted prism), colours |
| API7 | Generation for controllers' affordances (ramps, ledges sized to a controller) | M | later, with W1 |
| API8 | Groups that fight each other (round 63, the hoverbike's lich: its raised dead vs the horde, the horde swinging back): a group's hostility to other groups; each column notes which groups stand on it (the occupancy word's high bits), fields seeded by a group's units, swings at the nearest unit of a hostile group in reach and sight (swing and death events as for targets). Today hostile kinds swing only at setTargets' targets (8) | M–L | open (the units session has a game-side stand-in) |
| Q25 | `terrain.heightAt` counts a physics body over a column (a boulder a gorilla holds overhead) as its top: walkers climb it into the sky. The hoverbike stands its walkers on `floorAt(x, y, feet + step)` when the top is higher (round 63, FYI from the units session). Maybe a `groundOnly` sample, or say so in WORLD_API | S | open |
| Q27 | Heights past 256 (round 65, the user's question): the intervals are f32 (no limit); the cap is the surface word's 16-bit 8.8 top (`sfZ`/`sfPack`, ~50 kernel uses) and `zMax` sizing the field mesh's 3D grid, the shadow box and the sky ceiling. A 32-bit surface top (+1 MB at 256²) lifts it; the mesh grid costs grow with zMax | M | open |
| Q28 | An endless world streamed around the camera (round 65, the user's question): not GPU memory (a 1024² window ≈ 130 MB) but foundations — toroidal addressing in every kernel (colIdx, inMap), simulating a window (far chunks frozen, read back, written back; water at the window's edge), generation split into a coarse deterministic plan + chunks on demand (landforms.ts is whole-map today), saving touched chunks. ~1–2 weeks on its own branch; a fixed 512² map first to measure the sim. **Round 66, branch `stream`: step 1 done** — the window slides a region (64) at a time instead of toroidal addressing (no kernel changes: uniform K makes the chunk table a page table; every other per-column buffer and texture is shifted by copies); frozen regions thawed exactly; land generated per region (`world/streamgen.ts`); hashes and noise of position take the window's origin (Globals.org). Next: Q31–Q35 | XL | step 1 done |
| Q29 | A first-person or low perspective camera (round 65, the user's question): the camera is a fixed-angle orthographic iso (render/camera.ts); perspective needs a projection and a frustum for the chunk culling and the shadow fit (both assume the iso box), a sky and horizon, distance LOD, and close-up detail (textures, the hex columns' facets) | L | open |
| Q31 | Streaming, step 2 — frozen regions tick: deferred (on thaw, run the time it was away at a coarse rate: growth, settling water, a town's crews' progress) or coarse (a low-res sim of the regions out of the window). The user's idea: bigger regions where towns and nature grow out of sight (round 66) | L | open |
| Q32 | Streaming: the town, the workers, the physics bodies and the places are in window coordinates and don't move with a slide yet (the town's grid is laid over the window; units and bodies would be left behind) — a world-anchored town grid (tiled per region), units and bodies shifted by a kernel. Particles in the air are dropped at a slide (round 66) | M | open |
| Q33 | Streaming: the coarse plan the generator needs to see past a region — rivers, caves, landforms by region (landforms.ts is whole-map); `streamgen.ts` is noise only (round 66). **Round 67, branch `atlas`: the plan is the atlas** (regions, faults, coast, caves, patterns; `?level=atlas`); rivers are Q36 | L | partly done |
| Q34 | Streaming: frozen regions are held in memory (~1.4 MB each; the layers dominate, all K slots kept) — compact the layers to the used slots, compress, keep them in IndexedDB with the save; a saved streamed world (round 66) | M | open |
| Q35 | Streaming: a slide is one 35–45 ms frame (a hitch while panning). Spread it (the copies over frames, or spare pages so a region comes in before it's needed), and a far view of the frozen land around the window (coarse heights) so the edge isn't a cliff (round 66). **Round 67: land is asked for ahead** (Streamer.prefetch when the camera is 0.4 regions off the middle): a prefetched slide 9 ms; the far view could draw the atlas (Q43) | M | partly done |
| Q36 | (round 69: rivers and lava rivers from the drainage, falls where they drop; left: lakes in the hollows, rivers that meander below the texel, deltas) Atlas: rivers and lakes above the sea — macro hydrology (fill the depressions with a priority flood, accumulate flow, carve the channels into the ground compose.wgsl draws; lakes where the fill stands). The atlas has no rivers yet (round 67) | L | open |
| Q37 | Atlas: the sim's own sediment and erosion run over the whole world's ground (coarse passes over the macro heightmap, cached), and perhaps over each streamed region as it's made, cached so a slide stays interactive — the user's suggestion (round 67) | L | open |
| Q52 | The free camera (round 69): the tools aim through it (groundAt flies a ray) but the hover and the town's picks were made for the fixed view — check each; a sky and haze toward the horizon (beyond the window there's nothing: Q50) | M | open |
| Q53 | Falls: spray and mist at a fall's foot (particles where water lands from high), the white water on the field mesh's water stronger, a roar (round 69) | S | open |
| Q58 | Rivers from the water sim, not baked (round 72: "It seems like a waste to have the good water simulation and of use it to bake rivers in as flow from snow melt and just replenish the snow with storms to keep it steady state"): the channels stay (carved by the drainage), the springs along them go; water comes from snow on the heights melting (storms lay it again: a steady state), and — since most rivers rise outside the window — from the coarse world's water running into the window at its edges (the coarse world's rain, snow and melt on) | M | open |
| Q59 | Lava that keeps its heat by flowing (round 72: "vents could just keep pushing more out and make rivers that flow but I'm not sure how to make them keep their heat other than flow and replenish from below"): vents that keep pouring (the springs along the channels go); heat lost at the lava's open surface, so a flow that crusts over keeps its heat and runs on as a lava tube under its own roof (lava under an interval: lava.wgsl keeps it on the surface now) | M | open |
| Q57 | The coarse world's life (round 72): settlements spreading at the coarse scale (growth, roads, what they take from the land) and shown at the fine scale as the town's structures going up when the window reaches them; agents as populations moving, consuming, carrying, transforming land; then rain and erosion tuned and on, the window's changes restricted back into the coarse cells as it leaves (now: snapshots, so nothing is counted twice, but the coarse sim doesn't see the window's edits) | L | open |
| Q55 | (round 72: the coarse world built — terrain, water, loose ground, lava, meteors, eruptions, regions coming back changed) Scales (round 71): a pyramid of columns — atlas-scale coarse columns (a texel's few intervals and its fields) under the fine window; what leaves the window is restricted into its coarse columns (edits, a town, water kept as their sums), what comes in is refined from them (the atlas's detail where nothing changed, the stored difference where it did); coarse sim passes (erosion, water, growth) over the whole world between; the same for characters — agents in the window, populations and flows outside it, converted at the edge | L | open |
| Q56 | Representations (round 71: "representations should be fluid and have conversions"): one owner a thing at a time, the others projections — columns (fluids, powders: the world's), voxels (fracture, deformation: integrity, structure grids), rigid bodies (bodies.ts; meshes with control points to bend them), meshes (drawing); conversions each way (column ↔ voxel and voxel ↔ body exist; mesh ↔ voxel to build: raster a mesh into intervals, surface nets back) and the rule for when a thing changes owner (it breaks, settles, bends, touches water) | L | open |
| Q54 | Recursive column resolution (round 69: "thoughts on recursive enhancement of column resolution?"): a pyramid of coarser columns (2×2, 4×4… merged: fewer, wider intervals) to draw far land and the tiers out of the window (Q50) and to tick frozen regions cheaply (Q31); finer detail below a cell drawn only (the atlas's forms and patterns sampled finer where the camera is close), the sim staying at one cell | L | open |
| Q50 | (round 73: the land beyond the window drawn from the atlas and the coarse world, far.ts; left: what's above and below the window in it, the far land's detail) Tiers out of the window drawn still: the window holds 248 of a taller world (round 69); above and below it the land is kept but not drawn, so a cliff taller than the window shows cut at the window's floor and ceiling — draw what's outside as still meshes (from `Streamer.outside` and the frozen regions) | M | open |
| Q51 | A slide in z reads back and re-cuts the whole window on the CPU (120–300 ms, a hitch); prefetch it as the sideways slides are, or cut on the GPU (round 69) | S | open |
| Q38 | Taller worlds (round 69: the window slides in z — 248 a window over a world 480 tall, Q50 to draw the rest): columns are already sparse in z (a few intervals each, air costs nothing), so height is capped only by packings at 256: layout.ts's zMax check (8 bits), the surface's u16 at 1/256 (sfZ), physCols' 256-cell bitmask, the field mesh's box (nz). Lift those (or a vertical origin) for land above 255; paged chunks in z only matter when a column needs more than K intervals (stacked caves, floors). The user: "a sparse vertical hash for the chunks" (round 67) | M | open |
| Q39 | Atlas: rooms — the region graph (atlas.adjacency: regions and the edges they share) as rooms, with logical rules (keys and doors: which borders are passable, a cliff or ravine or wall where one shouldn't be; checked with the gate validator). The user: "We can adjust later with logical requests for key door mechanics" (round 67) | L | open |
| Q40 | Atlas: the sim's climate is the level's, not the atlas's latitude and height — snow laid on tundra melts into sheets of water within a minute. A per-column temperature (or the region's) the sim reads; the spawn keeps to temperate land meanwhile (round 67). **Round 68: the window's climate is the atlas's** (Atlas.climateAt at the window's centre, before it settles and at each slide; the atlas's temperature lost its noise and its lapse is the sim's, 0.12 °C a cell), so the snow it lays is the snow the sim keeps; left: the latitude across one window is one value | M | partly done |
| Q41 | Atlas: (round 69: flesh is its own material, and coral; vessels are forms.wgsl's walled networks) the flesh style's materials are stand-ins (tile's red for flesh, bone for what shows through): flesh, vessel and bone of their own, and a true vasculature (space colonisation or DLA, so the vessels branch as a tree, and can become tunnels or rivers) (round 67) | M | open |
| Q42 | Atlas: start-up — compiling its kernels ~7 s cold on D3D (the browser caches them after), building ~1.6 s at 2048²; a slide not asked for ahead ~120–240 ms (the readback waits on the frame's GPU work). Saved maps don't carry the atlas (seed and parameters); patterns and hash3 aren't periodic across the torus's seam (round 67) | M | open |
| Q43 | Atlas viewer: shading from screen derivatives is blocky up close; colour by material (what the game will show), the region graph drawn over it, click a region for its parameters, edit a region's kind and see it (round 67) | S | open |
| Q45 | Atlas forms: a form lab — the user plays with the noise and the form parameters live (the viewer, or a small 3D preview of one region's columns), saving kinds (round 69: "It would be fun for me at some point to play with noise for generating these") | M | open |
| Q46 | Atlas forms: an extruded, twisted, morphing cross-section turned into columns — a library of 2D sections (polygon, star, superellipse, the pattern bank's tiles) that morph from one to another along a bending path as they twist (round 69: "something like an extruded and twisted morphing cross section that we could convert into columns"); the spire form is the first case of it | M | open |
| Q47 | Rooms: volumes blocked out with traversable layers — the semantic room logic (Q39) marks volumes of the atlas as rooms with floors to walk at several heights (round 69: "when we add the semantic room logic we may want to make some volumes blocked out with traversable layers") | L | open |
| Q48 | Atlas forms: the field mesh's room is fixed a chunk (meshRoom 4 for the atlas level, ~87 MB of mesh; 2.5 left six chunks of an escarpment's alcoves out of room, drawn as holes) — room handed out as chunks need it (round 69) | M | open |
| Q49 | Atlas forms: what the flesh style looks like — its vessels show less than its maze ground; giant flora (trunks, caps, canopies) from the same forms, grown by the nature sim later (round 69) | M | open |
| Q44 | Streaming: what comes in hasn't lived — strips that arrive have the atlas's plants, the ground that's been in the window has grown (more trees) — part of Q31's deferred ticks: age a region on its way in (round 68) | M | open |
| Q30 | The sandbox's undo (↶) rewinds the layers but not the town's blocks and plan (build/town.ts), so after an undo the town restamps what it thinks stands; the town's state should go into the snapshot (round 65) | S | open |
| Q26 | Chunks of ground look like cubes but the terrain is hex: woken bodies (Waker) and carried or thrown loads (agents.carry / toss) should draw as faceted rock shapes (3D Voronoi), or at least hex-prism voxels, so nothing switches look when it becomes active (round 64, the hoverbike user's playtest, relayed; the hoverbike draws its own jittered-icosahedron rocks for now) | M | open |
| W0 | Places (round 51, DECISIONS): regions and rooms within them as named places — the runtime mutates a place (storms, time of day, fog, burying in sand, flooding…), queries adjacent rooms, specifies connections, changes what is in a room (enemies, puzzles, items, obstacles); spawning in a place and its terrain go through Reclaimed's API, the rest of the contents the game may own. Supersedes W2's flat region ids | L | step 1 done (this commit: plans, raster, queries, bury/flood/drain/storm masked to a place; connections as records); steps 2–5 open (docs/PLACES.md) |
| W1 | Generation from a room plan (round 50, docs/DECISIONS.md): partition primitives (Poisson-Voronoi islands, noise bands, boxes and halls, noisy SDF borders), bedrock shaped by the plan with tunnels and underground rivers, per-material layers with their own noise blended by SDF, a raisable field per layer and an editor op that pulls a layer along its noise | L | waits for the game-side design (API sketched to the units session); round 64 (builder): step 1 done — the wilds (world/landforms.ts): a Voronoi room plan, its regions as landforms (ranges, mesas with banded cliffs, basins, woods, hills), rivers by priority flood with springs, lakes, cave systems, lava tubes, passages between rooms; the plan loaded as the level's places |
| W2 | Region ids (a contract buffer per column) and per-region weather and lighting for a game master | M | waits (W1) |
| W3 | Freezing a region (a per-region mask the systems honour; bodies sleep) | M | waits (W1) |
| W4 | Layered navigation: walkable surfaces stacked per column, linked where heights meet; JFA distance/vector fields from game-given seeds; scent trails | L | waits |
| Q16b | Rain still leaves narrow spires of sediment, unreasonably high (round 49; the user suspects plants holding the angle of repose plus layering with silt; Q16 helped but didn't fully fix it). Not reproduced yet (`scripts/spiretest.mjs`): 4–6 storms for 60–120 s at speed 4 over the valley, the sandbox, its planted ground and a fully planted map raise no loose-topped column over 5 of its 6 neighbours by more than the repose; towers 6 cells high on planted columns (soil under thin silt and dust) slump back to 1.1–1.5 in rain or dry. Waiting on a screenshot and where (level, mesh or prisms, how long it rained). | S | open |
| F9 | Day/night: longer transitions; redder/golden dawn and dusk | S | done `f8b019d` |
| F10 | Title screen: plants and tree at a scale that makes sense with the bones | S–M | done `46898aa` |
| F11 | Title screen: level models buried in dust, one unburied at the start; the rest unburied as the title progresses | M | done `46898aa` |
| F12 | Model import pipeline: download Creative Commons (prefer CC0) meshes — skulls, vehicles, ruins — and voxelize them by ray casting (inside/outside), map colours to materials, clean up (hollow tanks/hulls, fill with oil/water via oilStored), output into the F5 atlas; credits file | M–L | open |

## Round 12 (2026-10-08)

Order: D4, D5, D6 → D7 → D2 → D3 → D1 → then back to C6, C7, C9, C8.

| id | item | size | status |
|---|---|---|---|
| D1 | Title screen plants at diorama scale: flowers with petals and leaves, grass blades, moss, roots of the tree growing out of the skull | M | done `cb91f31` |
| D2 | Wind blows decaying (browned) plants away as dust/flakes | S | done `38514ee` |
| D3 | Cyclones from a tight circular drag: carry dust, cross the map destructively (free, cooldown; ruins/junk, spare grown plants) — supersedes C10 | M–L | done `fc954d8` |
| D4 | The squeaks under rain/storms (raindrop ticks / birdsong in rain) — remove | S | done `b4df5f8` |
| D5 | Grow sound: something unfurling, not a charging sound | S | done `b4df5f8` |
| D6 | Drag wind 2–3× louder relative to other sounds | S | done `b4df5f8` |
| D7 | Rounder edges on drifts / water / smoothed surfaces (cheap SDF-style edges) | S–M | done `fc2c534` |

## Round 11 (2026-10-08)

Order decided: C4, C3, C5 → C2 → C1 (with A6/A15 sediment) → C6 → C7 → C9 → C8.

| id | item | size | status |
|---|---|---|---|
| C1 | Dust drifts (fractional sediment layer) that bury things — uncover them with wind (objects, seed beds); supersedes A6 | L | done `5995426` |
| C2 | Smooth water surfaces (keep the rain rings / storm glints) | M | done `0c20e47` |
| C3 | Grow sound: a wet sprouting "opening", then the current shimmer | S | done `031b78c` |
| C4 | Audio debug: see and mute each sound (find the high whine under storms / on Nature gains) | S | done `031b78c` |
| C5 | A little light where growth and wind happen | S | done `031b78c` |
| C6 | Multiple levels; title screen shows clickable objects for each level | M–L | done `fd5b5a3` (valley + sandbox; highway/city/port are 'coming') |
| C7 | Level: highway covered in ruined cars | M | next |
| C8 | Level: port with tankers washed ashore and a seawall; ocean waves and sea swell | L | next |
| C10 | Swirling the mouse while dragging paints a vortex; a sustained swirl summons a cyclone (with B6 tornado) | M | done `fc954d8` (D3) |
| C9 | Level: ruined city with a blast crater and hospital tents (an outbreak) | M–L | next |

## Loose ends noticed in session 2 (not yet asked for, but worth doing)

| id | item | size | status |
|---|---|---|---|
| E1 | Sandbox still shows the reclamation bar (no goal there) — hide it or repurpose | S | open |
| E2 | Dust particles are unlit while the ground is lit/shaded: colour match drifts at dusk / under storms — apply sun/sky light to dust colour | S | open |
| E3 | Resting particles sit at whole-cell height; on smoothed slopes and drifts they float/sink — use the drawn surface height (groundZAt / drift corners) | S | open |
| E4 | Rubble falls instantly (no fall animation) — the remaining half of B8 | M | folded into F7 |
| E5 | Draw cost rose to ~4.6 ms at 1400×800 with drifts on screen (Xe-LPG); check the low tier / phones before adding level content | S | open |
| E6 | The tutorial doesn't teach drifts/buried gardens, cyclones or petals/seeds; consider short optional "firsts" (ties to B5) | M | open |
| E7 | STATUS.md (user-facing stock-take) is stale since session 1 — refresh | S | open |
| E8 | Editor: no undo, no save/load of a sandbox map; brush shows no cursor ring | M | folded into F6 |

## Carried over (deferred earlier — still wanted)

| id | item | from | size | status |
|---|---|---|---|---|
| B1 | **Phone testing**: pick hosting (GitHub Pages / local HTTPS / tunnel); Android Chrome; touch controls are in, but untested on a device | round 6 | S | hosting done (this commit): GitHub Pages via Actions at csheldondante.github.io/Reclaimed; phone test open |
| B2 | Sandbox / level-edit mode (deposit/remove-layer brushes, place water/oil/trash/plants, spawn storms, time controls) | round 6 | M–L | done `fd5b5a3` |
| B3 | Water life: fish in clean water, reeds/lilies in shallows | round 6 | S–M | deferred |
| B4 | Wind waves on water (shaded cheap; true height harder) | round 6 | S / M–L | deferred |
| B5 | Event camera beyond the intro: pan/zoom to firsts (animals arrive, a seed sprouts and dies, wind clears trash and a plant takes) | round 6 | M | deferred |
| B6 | Earthquake; drag-to-tornado | rounds 2–3 | M | tornado done as the cyclone (D3); earthquake **won't do** (user, 2026-10-09: "you essentially play as the wind") |
| B7 | Second level / data-driven map format | session 1 | M–L | registry done (C6); a data-driven map format still open |
| B8 | Water on slopes renders stair-stepped; rubble falls instantly (no fall animation) | session 1 | M | water part done `0c20e47`; rubble animation open |
| B9 | Audio has never been heard by an agent — every sound needs the user's ear | ongoing | — | open |
| B10 | Open judgement calls in STATUS.md §5 (economy, day length, night darkness, fire residue, lens UX, forest look) — several are stale; re-ask when relevant | session 1 | — | open |

## Done (recent; DEVLOG has details)

- Round 9: camera director + diegetic first-play intro; title screen with the
  level's hands, opening wither demo, reset progress; tap tiers (grass /
  flowers-shrub / tree; withering on hostile ground); one wind field storms
  ride; storms form at the upwind edge with distant thunder — `8b20abf`,
  `cfff42d`, `ef57291`, `38d0e95`.
- Round 8: stacking strokes (breeze/gust/gale), storms steered by the field,
  score = clean land + life, Nature pays for deeds — `f7f2740`.
- Round 7: persistent wind field, free taps, grime + washing, instant
  plant feedback — `dac7f5a`.
- Round 6: withering, seeds, grow-tap, litter, phone-ready layout — `4a1ba43`,
  `22256af`.
- Rounds 4–5: see DEVLOG.
# Backlog — every open suggestion, so nothing is lost between sessions

The running list of the user's suggestions and deferred work. Each item has an
id, the round it came from (DECISIONS.md has the user's words), a size
(S ≈ hours, M ≈ half a day, L ≈ a day+) and a status. When an item ships,
move it to **Done** with the commit; when the user changes their mind, note
it here. Agents: read this before starting work and keep it current in the
same commit as the change.

Order agreed (round 10): A1–A5, A8, A12, A13 → A10, A14, A11 → A9 → A7 → A15 render slopes → A6 + A15 sediment layer. Answers: A15 render first then sediment; A7 the player taps the lightning; A9 on the title screen, default Medium.

Status: `won't do` (user declined) · `open` · `next` (agreed, queued) · `wip` · `asked` (waiting on the
user) · `deferred` (agreed for later).

## Round 10 (2026-10-08) — new batch

| id | item | size | status |
|---|---|---|---|
| A1 | Title screen: howling desolate wind + periodic gusts while it is barren (softening as it greens) | S | done `a8d51c0` |
| A2 | Level: barren map → more desolate wind sound (and gentler as it greens) | S | done `a8d51c0` |
| A3 | Drag audio: whoosh starts when the drag starts; no snap/rustle at mouse-up — wind only | S | done `a8d51c0` |
| A4 | Player gusts sound deeper than the desolate ambient wind | S | done `a8d51c0` |
| A5 | No birds on the title screen (they make the skull look giant) | S | done `a8d51c0` |
| A6 | Blown dust piles up against things (drifts, lee of walls) | M–L | done `5995426` |
| A7 | Tutorial builds skills: (1) growth and death of flowers, (2) wind blowing, (3) free play to demonstrate it, (4) something new: a pile of pollution the wind can't move, (5) a storm forms and lightning destroys it | M | done `6e03680` |
| A8 | Wind is more powerful under storms | S | done `a8d51c0` |
| A9 | Difficulty setting: easy (green never re-pollutes), medium (green resists), hard (green easily killed by blown trash, strong wind, too much water) | M | done `5866665` |
| A10 | Seeds that land greenify their spot and clean a little pollution (makes birds and wind over plants matter) | S–M | done `e8b2efe` |
| A11 | Wind over flowering plants sheds the flowers (petals blow off); they take time to regrow | M | done `e8b2efe` |
| A12 | Map wind: a steady prevailing flow one way across the map; only minor noise, also mixed into the player field | S | done `a8d51c0` |
| A13 | Storm shadows swirl erratically — make their shape steadier | S | done `a8d51c0` |
| A14 | Light (not dark) fair-weather clouds/shadows drift over to show the wind | S–M | done `e8b2efe` |
| A15 | Smooth tops for soft surfaces (dirt, dust, sand, water) vs hard steps for stone; sub-cell height; "over a gap = sheer drop, under = smooth" as a surface property | M (render) / L (data) | done (render `a015f55`, sediment `5995426`) |

## Round 23 (2026-10-11, session 4)

| id | item | size | status |
|---|---|---|---|
| Q1 | The scrolling ripple noise looks right on deep water but odd on shallow water (the little puddles left behind): fade it out where the water is shallow | S | done (this commit) |
| Q2 | Test on `strata`: a concrete basin full of sand — blow down a wall, does the sand spill out? | S | done on `strata` (this commit): a 12×12 concrete basin of sand by the physics garden; a 4-wide gap lets ~25 cells of sand out in ~3 s, a fan at repose |
| Q3 | Destroyed blocks either become a new material in place (stone → gravel) or become particles (gravel → sand grains) — refines P3; same volume (user) | M | step 1 done on `strata` (this commit): Break/lightning turn solids to rubble in place where the hole is open above, crushed cross-sections squeeze out as rubble beside them; step 2 (grains that carry it — and the volume Break still removes under what's left above) open |
| Q4 | Visual artifacts: sand/dust in storms looks like a wall interpolating from the top of a tall structure to its base, popping in and out; blocky dark patches in water running under rain (the bright rain/foam patches are the user's favourite water effect — keep them) | S | done (this commit): sheets aren't shared where a covered column's solid top (or wet bed) stands > 3 over another's surface; water boxes hide side walls the sheet joins (they showed through the neighbour's water as dark blocks) |
| Q5 | Physics goals: a believable, responsive collapse is the juice; some solids persist (skewed, buried finds); strong cyclones lift light pieces; pieces break each other and the world; they fall and only crumble on impact. Plan: Rapier (WASM) for the motion on its own branch off `strata`, zero bounce, impacts destroy the overlapping voxels into rubble + dust (Q3) instead of pushing apart; cyclone drag on bodies | L | dropped (round 25): the user tried `rapier` — decent but jerks too much at times; not worth it even for cyclones throwing pieces. Keep the collapse mechanics with strict grid alignment (strata's straight-down falls); `rapier` stays unmerged as a reference. Ported to `strata`: loose ground banked against a structure doesn't hold it (fracture.ts `holds`). Arbitrary orientations / multiple grids = a future project |
| Q6 | Borders between ground materials (dirt / sand / rubble / grass) look artificial: square, on the cell grid. User suggested an SDF; other techniques welcome | M | done on `strata` (this commit, round 26): bilinear vote over the four nearest columns + world-space noise + per-material relief, plant cover smoothed the same way; only ground at about the same height (cliffs, concrete keep crisp edges); for the user's visual pass. Not done: column side walls under an edge, stains and wetness still per cell |
| Q7 | Lightning sometimes strikes far off horizontally then arcs to the click — feels off. Clicks should pick the actual 3D voxel; strike the highest point (biased to metal, away from stone, but always something rather than air) within a radius-6 sphere whose lowest point is the voxel clicked (a column above the hemisphere); still arc from a tall thing nearby | S | done (this commit): powers.ts `lightning()` — bowl of STRIKE_R 6 on the picked voxel, open upward; score = top + STRIKE_DRAW (steel 5, rust 4, water 1, stone −2, concrete/brick −0.5) − 0.25·distance; the 40-cell metal pull is gone |
| Q8 | Lightning shouldn't cost Nature (the mechanic is bad): a short cooldown of ~1 s | S | done (this commit): STRIKE_COOLDOWN 1 s, no cost |
| Q9 | Sandbox Break tool: the cursor highlight is a ring projected from above, but Break is centred on the picked voxel | S | done (this commit): a sphere outline (+ dashed equator) round the voxel under the cursor, picked as Break aims |
| Q10 | Instead of a summon button, swirling (the tornado gesture) mostly over water summons the lightning storm — no buttons or Nature meter to worry about | S | done (this commit): a swirl with ≥ half its points over water > 0.3 deep raises a storm at its centre instead of a cyclone; the ☁ button, the R key and the Nature meter (+N pops) are gone. `Nature` still computes underneath but nothing reads it — remove or repurpose later |
| Q11 | Stone should be smooth too, with ragged vertical rises only above a threshold (1–3 blocks) | S | done (this commit): stone `smooth: 2` — rises of up to 2 are drawn as slopes, taller stay sheer (knob: materials.ts) |
| Q12 | Could stone use a hex grid instead of square (more natural features)? Not if it means un-unifying the model; unsure how it meets concrete | L | discussed round 28: a real hex grid for stone would split the model (every system works on square columns) — not doing that. A render-only version is possible (heightfield ray-march over hex/Voronoi cells in stone columns' boxes, sim unchanged); deferred — first see if Q14's facets are enough |
| Q13 | Fire sparks (embers) should be able to set flammable things alight where they land | S | done (this commit): embers get vertical drag (they used to climb forever), rise a few cells, cool and drift down on the wind; a landing marks `sparkTex` (tick + 1), and fire.wgsl lights dry fuel there (EMBER_CATCH 0.35 × fuel, less when damp or raining) |
| Q14 | Trash particles smaller; dirt / dark-brown particles a bit smaller. Render-only: can rock look more jagged and natural — Voronoi bumps on the surface, blending to the adjacent material's height outside the Voronoi? | M | particles done (this commit): litter 0.28 → 0.18, grime clumps 0.22–0.32 → 0.14–0.21, dust 0.20–0.32 → 0.15–0.24. Rock, step 1 done (this commit): Voronoi facets (~0.8 cell) on stone faces — each its own tilt for the light, dark cracks, facet tone; shading only. Step 2 (bumps that change the silhouette / blend into neighbours' heights) needs a per-pixel height march — open |
| Q15 | In profile the rocks look totally straight: vary them for rendering so they cut a jagged silhouette (the river gorge is an example) | M | done (this commit, round 29): stone is carved — a per-pixel march into its box to a surface up to 0.45 inside its exposed faces (3D value noise), discarding rays that miss, so cliff edges and walls are jagged; faces against neighbours aren't carved (no gaps). Only when zoomed in past 10 px per cell |
| Q16 | Sediment spikes again: columns get super high during rain storms (seen on mobile) | S | done (this commit): planted columns took in mud and never slumped — rain lays alternating thin layers (mud, dust from the air), so the top interval stayed ~1 deep and held() never let go; roots now hold a slope at most 1 cell steeper than the repose (HOLD_STEEP). Reproduced on desktop too |
| Q17 | Some tiles don't render: you see straight through to the background (rock sections; on desktop too) | M | done (this commit): two causes. (1) Dust/sand sheets had no sides, assuming they always taper; where one ends at a step (or beside ground drawn lower) the strip under its edge was empty — sheets now show that side (sheetGap). (2) Carved rock: a ray leaving a side below the neighbour's ground, where that neighbour's facing side isn't drawn, now counts as a hit, and rises the smoothing draws as slopes aren't carved. Background pixels in 4 zoomed views: 4127 / 4311 / 6386 / 7957 → 210 / 58 / 461 / 235 (the rest is mostly sky past the map edge) |
| Q18 | Frame rate is low on the phone | M | open: phones get the `high` tier like desktop; compare `?q=low` on the device and the perf overlay, then pick a default tier for phones |
| Q19 | Loose ground lying higher than the rock beside it should erode/collapse down to the rock's top or below (Q17's sheet sides are a fine stopgap) | M | open |
| Q21 | A column's intervals are capped at its chunk's slot count (4, or the chunk's busiest column at load + 2; the sandbox 14; at most 16; never grown at runtime). A full column can't open another gap: the beam's bore skips it, a meteor's crater drops the overhang over its bowl (`edit.wgsl`'s upper piece), others extend the top interval. Raise it per world with `WorldDef.slots`. Later: repack chunks that fill up (grow K), or merge the lowest gap | M | open (round 62, from the hoverbike session) |
| Q22 | Weird column artifacts after storms or explosions (round 62; the user's phone screenshot, round 63: tall narrow pillars of loose ground against a ravine wall) | M | partly done (round 63): reproduced in the sandbox after craters and round the arch after rain (not on the valley): loose ground beside air under a roof (a crater's undercut rim, an arch, an overhang) stood as a wall, since slumpOut sees a neighbour's top (its roof) and the face spill skipped the run on top. Now the run on top spills into air under a neighbour's roof too (sediment.wgsl spillOut), and freed slots are cleared after a spill (stale copies made columns like `stone 8.49–9.00 ×12`). pillartest, sandbox, 8 craters, 40 s: 61 'hidden' columns, 208 cells over repose → 0; with storms, 100 s: 100–118 → ≤ 3, worst 6.1 → 1.8. If the phone's pillars persist, they're something else: a screenshot with ?mesh=0 and where |
| Q23 | Overlapping intervals after craters (~60 columns in the sandbox and the valley, e.g. `stone 0–2, stone 1.30–9.00`): something moves the solid over a crater's bowl down into its floor, probably the integrity or bodies write-back (round 63, pillartest) | M | open |
| Q24 | A crater's rim cut leaves solid lids 0.01 cells thick holding soil over a cave: drop or crumble solids thinner than a minimum in OP_CRATER (round 63) | S | open |

## Round 22 (2026-10-11, session 4)

| id | item | size | status |
|---|---|---|---|
| P1 | Falling pieces still sometimes push back up: no block ever moves up (only the particles a destroyed block emits) | S | done `5ca2c24` |
| P2 | A dying cyclone drops its dust where the column stood: it should lose power and fall while spreading out | S | done `5ca2c24` |
| P3 | Destruction, the fun version (iterate later, not now): a broken structure is a rigid body supported from its base that tilts and falls; every impact destroys the blocks that intersect and turns them into material particles (stone → gravel/sand, brick → dust); nothing but particles goes up | M–L | later (user: "eventually") |
| P4 | Consolidate: one material-interval model (fractional heights; loose and solid in the same layers), intervals and particles the only carriers, fluids move material between them — refines N1; on its own branch, merged when ready | L | wip on branch `strata`: stages 1–3 done (`a4accd5` fractional intervals, `abfcfef`/`ee23953` loose ground in the layers, `8a67864` spill from exposed faces); waiting for the user to test |

Agent notes from P4 (judgement calls for the user, not yet asked):

| id | item | size | status |
|---|---|---|---|
| P5 | Valley soil now slumps at the sandbox's repose (soil 1.4, rubble 1.7, ash 0.9 — the old whole-cell rules had 3, 4, 2); the valley still looks close but may need N2's reshaping | S | asked |
| P6 | Thick ash counts as a blown film: the title diorama's ash mound is drawn plain and plants on it would be dormant | S | asked |
| P7 | Layer slots are 4× larger (16 B): undo ring (8 copies of the layers) ~100 MB on the sandbox; structure/surface passes ~0.2 ms slower — a 2-word slot (f16 or 12.4 fixed heights + pending accumulator) would win it back | S–M | open |
| P8 | The loose sheet has no side faces: a deep loose run at a cliff edge shows a gap under its edge (seen before only in the sandbox) | S | open |

## Round 21 (2026-10-10, session 4)

| id | item | size | status |
|---|---|---|---|
| O1 | Bodies crumble much more easily on impact and break up into pieces; impacts make dust and chips | S–M | done `1011af2` |
| O2 | Speed limit on bodies (~1.5× the topple speed), collision response damped further | S | done `1011af2` |
| O3 | Bug: in storms, columns of loose ground rise into the sky | S | done `5cad379` |
| O4 | See-through dust clouds and debris particles where bodies break and land (hide the remaining jank) | S | done `b337f3e` |
| O5 | The switch from static structure to rigid body sometimes jumps instead of moving smoothly | S–M | done `b337f3e` |
| O6 | Broken chunks only fall straight down (no rigid-body tumbling/bounce: it breaks the illusion of scale) | S | done `aa774ed` |
| O7 | A deeper bass crumbling sound | S | done `aa774ed` (unheard; user: improved) |
| O8 | Cyclone spawn cooldown of a second or two within one drag; a fresh press resets it | S | done `aa774ed` |

## Round 20 (2026-10-10, session 3)

The batch now (M), then the larger work (N) after an architecture review.

| id | item | size | status |
|---|---|---|---|
| M1 | Rigid bodies feel bigger: slower fall (lower gravity, air drag), more rotational inertia, soft contacts (no bounce, sink in slightly, gentle push-out); crumbs up to ~12 voxels become loose ground | S | done `d81ad6e` |
| M2 | Every click: a little ring of wind pushing out from the cursor | S–M | done `6c1b7d8` |
| M3 | Lightning: small radius around the click (rolling sphere), biased to metal within ~40 cells; a branching chain from what it hits to near the cursor, setting fires | S–M | done `533c384` |
| M4 | Night sounds: crickets and owls instead of birdsong | S | done `a783c51` |
| M5 | Frogs near water with green around it | S | done `a783c51` |
| M6 | Metal drums ring by their size (connected metal voxels), snapped to a pentatonic scale | M | done `3ab876b` |
| M7 | Handoff + memory for the remaining work | S | done |
| N1 | Architecture review: consolidate (solid intervals; one loose stack for everything soft — rubble, litter, the valley's soil; liquids carry it; wind-borne particles settle into it) | M | next; see P4 (user's three-system version, own branch) |
| N2 | The valley onto the loose ground (reshaped rock, river erosion matched to the old rates) | M–L | after N1 |
| N3 | Growth redesign: taps grow only from green or seeded fertile ground; seeds spread it; fertility = clean + moist + uncovered | M–L | step 1 done (this commit, branch `story`): story rules — seeds only; green sheds seeds into the breeze (slow creep), a tap on green lets go a puff of seeds; reach (R1) |
| N4 | Puzzle-mode opening on the camera director; barriers to growth as level gates; wind/cyclone/storm unlocks by green | M–L | after N3 |
| N5 | Ancient seeds buried, uncovered, planted or sent down the river to the next level; every level has a river | M | after N3 |
| R1 | Reach: the camera is confined to the land around the green, by the green's size (~1.5× the width across it); touch and wind only work there; fog beyond | M | done (this commit, branch `story`): game/reach.ts — per patch max(8, ¼ width) past its edge, following its outline; only green touching the reach counts (wild patches are found); never shrinks |
| R2 | Story levels keep a Free play mode (old rules); the built levels are in the sandbox's load list | S | done (this commit, branch `story`) |
| R3 | A level teaches its skills through gates, then the goal: reach the lab / make the lab itself green | M | open (with N4) |
| R4 | Buried bonus seeds to find: uncovered, washed downstream, carried to the next level's river to seed new green (N5) | M | open |
| R6 | Gate library + validator: a level is a DAG of regions and gates (barrier prefab + key); headless tests per gate — which abilities open it (any that physically clear it are fine), and that ambient weather alone doesn't; abilities are never locked, obstacles that only one ability clears teach it | M | open (with R3/N4) |
| X1 | Spin-off: disasters-only city game (meteors, floods, volcanoes, wind, fire, aliens), a full city reacting to disasters — the arcade/mayhem version, now the `mayhem` branch (round 33, docs/BRANCHES.md); working title "FEMA Mayhem" | L+ | branch `mayhem` |
| X2 | Variant: Townscaper-style builder — a free-form terrain and weather tool for setting up little towns; people behave like the animals (clear trees, build houses where the land suits); houses by WFC on an irregular grid, stacking where dense, so the land grades city → village → farmland → forest (docs/LEVELS.md) | L+ | idea (user, round 31) |
| X4 | Sandbox world editor: place and modify prefab structures, raise mountains, shape the land with wind, rain, meteor impacts, volcanic eruptions; save/load worlds (docs/BRANCHES.md) | L | branch `sandbox` |
| X5 | The map engine generalised (round 34): intersecting grids — e.g. a hex nature grid of material intervals, a rectangular voxel grid for structures, an irregular grid for Townscaper-style WFC buildings — with precomputed overlaps so each reads and writes the others' fields; mixes terrain and non-terrain features and looks better (docs/BRANCHES.md; X2 grows from it; revisits Q12) | L+ | branch `grids`: hex nature grid running (sim + prisms, DEVLOG 2026-10-16); rotated structure grids (14301ef); air inside them — projected intervals and the open air between them (multi-span); a tilt slider on the sandbox's Place tool. Next: sliding by the face normal, the wind field seeing structures, displacement when a structure is placed into or lands on the ground (the user: drop what it pushes out back onto it, or up through its holes), water inside structures, a column's plants are one value (the ground's plants show on sand that lands on a floor over it) |
| G13 | Rendering (round 37): (a) tops alone — an interval or drift sheet whose six sides are all hidden is drawn as its 12-vertex top (done, this commit: draw 7.0 → 5.2 ms); (b) the terrain as a continuous heightmap surface, prisms only where sides show; (c) level of detail by zoom; (d) a display heightmap finer than the hex grid; (e) culling to the view; (f) cached screen tiles (G-buffer, relit each frame) only if needed; (g) smooth-lit soft tops and sheets (done, ?smooth=0 compares); (h) the field mesh (option C, rounds 38–39): the terrain as one surface meshed from a field evaluated from the intervals (and the structures' voxels, for the fillets) — the whole map in 32-cell chunks, rebuilt only when their hash changes (done, this commit: ?mesh=1; draw 6.1 → 3.0 ms); structures stay cubes and built materials prisms (sharp); a detail layer roughens rock, rubble and trash; water a smooth sheet on it, cliffs warped by noise, only chunks near the view rebuilt (done, round 40); a shadow pass from the sun in place of the march (done, round 40); thin water a film on the ground, shores (swash, swell, wet sand) and waves across the wind (done, round 41); next: a compact vertex, no empty rebuild dispatches, built things on square grids and round tanks (with G14), the mesh on by default once tried on a phone; later perhaps a cached top-down albedo and normal, relit when the light changes | L | (a), (g) done, (h) in progress; draw is fragment-bound now (DEVLOG 2026-10-22), branch `grids` |
| G14 | Structures on regular and irregular grids, built by Townscaper-style WFC (some cities rectangular, some organic), on top of the multiple grids, burying and slopes (round 37) | L+ | after X5's grids work together |
| G15 | SDF-based flow fields; people as particles who build and clear vegetation on their own (round 37) | L+ | much later (after G14) |
| G12 | Momentum for loose ground (round 36): a persistent slide velocity for the top run (like water's pipes, six values) — strictly one per open level (an underground river, sand on a room's floor: the user), one per column for now, on per material by an inertia value — dry sand little, wet soil a lot — so slides run out past their repose: mudslides, avalanches off a tilted roof, debris flows. Water stays its own model; mud = saturated soil coupled to it. Only if cheap (estimate ~0.1–0.2 ms, 24 bytes per column) | M | open — after sliding by the face normal (it shares the slide), branch `grids` |
| X3 | Variant ideas to try: Zen mode (no goal, weather on autopilot, photo mode); River relay (the story levels joined by one river: what you send downstream arrives in the next level) | M | idea |
| R7 | Level tools: kit (world/kit.ts), CPU map preview (scripts/mapview.mjs), gate validator (game/trial.ts + scripts/gates.mjs), the Trial Grounds test level (levels/trials.ts, hidden; ?skipmenu=1&level=trials) | M | done (this commit, branch `story`) |
| R10 | Poison and oil wash out under one passing storm (any water film dissolves 0.16%/tick, independent of depth), so they can't be gates; proposal: a solubility cap (water holds so much poison per depth: rain films saturate, heavy deposits need a flood's volume). Changes the whole game's cleanup pace. User (round 34): decide it in the `puzzle` branch; lean — oil hard to get rid of without burning it (that makes it fun), and water dissolves only so much per amount of water | M | open (`puzzle`) |
| R8 | Puzzle catalogue + easter eggs to build from (docs/LEVELS.md): dust sea, ember relay, lightning rod, flood flush, retaining-wall slump, quarantine line, plateau, oil lake, drought, wind tunnel, firebreak, cascade, windbreak, bird bridge, the lab shell; seed caches, buried spring, hidden meadow | L | open |
| R9 | Seed caches found: when the reach reaches an uncovered cache, it wakes (flowers, a message, a count) — kit `cache()` places them | S | open |
| R5 | Story arc: valley = the lab that made the virus (biohazard signs on the tanks, ruined military vehicles as a quarantine barrier, signs of flight); then the escape from quarantine (highway); then the city wiped out by plague (N6, C7, C9) | L | open |
| R11 | The reach's fence readable (round 42): on a phone the camera seemed locked — nothing shows the edge or says the green's spread opens it; a soft edge at the boundary and a hint (on `ambient`, where the story lives) | S | open |
| N6 | Story through environment: the valley re-themed as a biological research base (biohazard sign, lab); highway barricades (quarantine); city tents (plague) | M | with C7/C9 |
| N7 | Red sludge: a third liquid (dense, toxic) | M | open |
| N8 | Body deformation (spring-linked voxel clusters, World of Goo-like) | L+ | later |
| F7c | Bodies step 3: impacts split bodies (done by O1); structures resting on fallen bodies are held by them | M | open (holding part) |

## Round 19 (2026-10-10, session 3)

| id | item | size | status |
|---|---|---|---|
| L1 | Lightning blasts a crater in whatever it strikes — stone too, loose ground, fallen bodies | S | done `78deeb6` |

## Round 17 (2026-10-09, session 3)

| id | item | size | status |
|---|---|---|---|
| J1 | Loose layers checkerboard (neighbouring columns see-saw), worst in wind: stabilise the transport and the top-material switching | S–M | done `c208a2d` |
| K1 | Bodies step 1: sleeping bodies keep their frame (no re-voxelising); projection of sleeping bodies into a per-column body-top texture; cap ~64 bodies / 16k voxels (oldest small ones crumble to loose ground) | M–L | done `a6d40a5` |
| K1b | Break works on bodies too: the Break tool removes voxels in a body's own frame; what's left splits into its connected pieces (they wake and fall); crumbs become loose ground | M | done `3273598` |
| K2 | Bodies step 2: loose ground, water and integrity read the projection (pile on, slide off, bury); bodies wake when disturbed | M | done `b60e6fe` |
| K3 | Bodies step 3: impacts and damage split bodies along their own grid; small pieces become loose ground by material | M | after K2 |

## Round 16 (2026-10-09, session 3)

Order: I2 → I1 → I3, then talk I4 through with the user.

| id | item | size | status |
|---|---|---|---|
| I1 | Soft ground is all loose and smooth: no packing of loose layers into cells; up to four stacked loose layers per column (strata); soft cells (soil, sand, ash, silt) become loose layers when a map loads; only solids are stepped. The surface's material is the top loose layer's | L | done `4b35dc6` in the sandbox (valley needs reshaped rock) |
| I2 | Dust grains that land put their dust down and fade within a second or two (no long-lying grains) | S | done `a85dd7d` |
| I3 | Water carries soft material: what lies at the water's edge or under flowing water (rain runoff too) washes in, travels with the flow, settles where it slows, or leaves the map | M | done `4b35dc6` |
| I4 | Rigid bodies in their own frame: sleeping bodies stay skewed, rasterised into a per-column occupied range so layers bury them; impacts/damage split them; small pieces become aligned voxels or loose material | L | talk first |

## Round 15 (2026-10-09, session 3)

Proposed order: H5, H6, H1 (quick) → H8 → H2 → H4 → H3 → H7 (with F12); F7's remaining polish after.

| id | item | size | status |
|---|---|---|---|
| H1 | Title screen: random low gusts now and then (grass waves, dust blows) | S | done `dd81319` |
| H2 | Airborne dust settles back into drifts downwind (mass kept) instead of vanishing | S–M | done `f500cb6` |
| H3 | Loose surfaces (dirt, ash, sand) behave like dust: fractional loose layer, steeper repose, higher wind to lift (dirt maybe never); stone stays stepped | L | done in the sandbox (a `2101762`, b+c strata); valley later |
| H4 | Water loosens and carries loose material (dirt, packed trash); asphalt/concrete need lightning or cyclones to crack and break down first | M | done `dc50fc3` |
| H5 | Oil keeps burning in rain (trees still go out) | S | done `6c6ffc6` |
| H6 | Storm outlines steadier (shape changes too fast) | S | done `59ca6ed` |
| H7 | Larger models to place: tall buildings (ties to F12) | M | done `e5e420c` |
| H8 | Green over loose material binds it: dust under established plants can't be swept out and slowly becomes soil | S–M | done `bd89f13` |
| F7b | Break tool for anything + physics garden in the sandbox | S | done `d062a54` |

## Round 14 (2026-10-09, session 3)

Order: G1–G4 (quick) → G5 with F7 (destruction prototyped in the sandbox) → F12 → C7, C9, C8.

| id | item | size | status |
|---|---|---|---|
| G1 | Fireflies sparser, in small patches | S | done `efb6b3e` |
| G2 | Sandbox reachable from the start, plainly (a real button, not a footnote link) | S | done `e7a961b` |
| G3 | No cap on summoning cyclones (no cooldown); several at once is a follow-up (one cyclone slot in Globals today) | S (cooldown) / M (several) | done `66025c2` |
| G4 | Title screen: repeated taps grow a diorama-scale sapling, not the level's tree | S | done `6768d10` |
| G5 | The sandbox as the physics playground: test and play with physics, placing things and every mechanic (F7 lands there first) | ongoing | open |

## Round 13 (2026-10-09, session 3)

Proposed order: F1, F8, F9 (quick fixes) → F2, F4, F3 (brushes) → F6 (save/load, E8) → F5 (model atlas) → F11, F10 (title) → F7 (toppling) → C7, C9, C8 (which reuse F5's models).

| id | item | size | status |
|---|---|---|---|
| F1 | Dust drifts sink under water and oil: liquids lie on top of the dust (water/oil see drift as ground), so dust is never drawn over a pond | S–M | done `f7c2acb` |
| F2 | Layer brushes: one press = one layer with a soft edge (fractional per column, so repeat clicks build a smooth mound); dragging over the same place in one press adds nothing more. Calmer sandbox base map (lower-frequency patches) | S–M | done `3baa5fc` |
| F3 | Deposit brushes drop material from above (falling grains you can see) that lands and settles by angle of repose: dirt, sand, gravel, dust — real strata | M | done `3baa5fc` |
| F4 | Bedrock brush: stone rises from below, lifting the layers above it | S | done `3baa5fc` |
| F5 | Model atlas: layered voxel models (ruined cars, tankers, ruins, tents, …) stamped into the world as real matter (buryable, breakable); editor palette with thumbnails. Feeds C7/C9/C8 | M–L | done `977b043` |
| F6 | Map building: save/load sandbox maps, undo, brush cursor ring (absorbs E8) | M | done `98f7f58` |
| F7 | Destruction: Noita-style rigid-body chunks + crumble particles; breaks where moment (carried mass × lever, relaxed along support paths) exceeds strength × thickness² (thickness from a JFA distance field); islands cut from the ground fall; bodies re-voxelize at rest by inverse sampling; terrain keeps a column rule (absorbs E4) | L+ | wip (A smash `3a52069`, B fracture + bodies done) |
| F8 | Dust particles softer: more transparent, rounded | S | done `de35b4c` |
| F13 | Physics voxels (round 43, branch `physics`, docs/PHYSICS.md): one GPU solver for every material (lattice shape matching; steel bends and stays bent, stone cracks into rigid pieces; contacts never push out, deep overlaps and hard impacts crumble to loose ground); drop and heat-beam tools (done `56a07d5`); the map's structures wake into bodies when touched, softer metal, the beam drawn, aimed above the finger and hot enough to cut (done, round 44); the nature grid sees the bodies (done, round 46; the air in them stays air, landings shove the air and raise dust, round 47); the beam melts the ground into lava, volcano vents pour it, it flows, boils water, lights fires and sets into basalt (done, round 47); concrete crumbles more and rings less (damping, cracks on impact; done, round 48); foundations let go when their ground goes, digging wakes ruins (done, round 48); the meteor (smoky from the sky, a crater blown out to dust, wind out every way), a volcano cone that rises 30 cells then pours lava down its gullies, smooth lava (done, round 48); a game model on the renderer: `addVoxels` documented as the public API, a voxel size per instance (n/16 of a cell) for the GameplayGM hover bike (done, round 49); next: lava bombs, a rigid pass for big stiff bodies, sleeping | L+ | wip |
| F14 | Mixed resolution (round 49): the simulation stays coarse (whole-cell lattice voxels) and refines only where needed. A body's lattice spacing is its own (1, 1/2, 1/4 of a cell), so small things like the bike have a fine lattice. A voxel that cracks or crumbles splits into eight children half its size (velocity, heat and material inherited), which break further before going to dust and particles. At rest, fragments go back to loose ground (no explicit coarsening at first). Done (round 49): a voxel size per body, fragments (docs/PHYSICS.md "Mixed resolution"). | L | done |
| F15 | Deformable meshes (round 49): a lo-fi mesh drawn over a physics body, its vertices bound to the nearest lattice voxels (weights at bind time) and moved in the vertex shader by each voxel's position and rotation, so it dents, bends and twists with the body. Triangles stretched across a crack are dropped (it tears), as are those on crumbled voxels; heat glows per control voxel, lit and shadowed like the world. The lattice is what the simulation sees (heat, lava, wind, sand); the mesh is only how it looks. For the hover bike: a mesh on a half-cell lattice, the game driving it, damage read back. Done (round 49): `spawnMesh`, skinning, tearing, voxels in the tears (docs/PHYSICS.md "Meshes over bodies"); the game API (round 49): installPhysics, wake (ruins, or a chunk), drive, impulse, push fields, state readback (docs/PHYSICS.md "For games"). | L | done |
| F16 | Loose ground animates when it moves (round 50): grains stream off slumps, out of faces and down where loose ground lost its support, run down the slope and settle | S | done (this commit): running grains (particles.wgsl K_RUN) from the flow sediment.wgsl writes into the air texture; real momentum is G12 |
| F17 | Snow and leaf litter (round 50): snow a loose material that drifts in light wind, falls in cold storms and melts near heat; leaf litter loose and light, blowing as leaves | M | done (this commit): materials 25 and 26, the climate (Globals climate, sim ClimateSystem), flakes in cold storms, snow and leaves blowing as particles; next perhaps: snow on the peaks by default in the valley, autumn |
| F18 | Crystal and ice (round 50): faceted transparent solids; water freezes and ice melts with temperature | M | done (this commit): materials 27 and 28 drawn blended and faceted (render.wgsl shadeGlass), water freezing from its bed up under a frosted skin, ice melting; next perhaps: real refraction, shadows through them, ice floating |
| F19 | Seasons (round 51): broadleaf crowns turn autumn colours (birch gold, the rest red, orange, amber; conifers stay green), shed leaf particles in their colours, thin to bare in winter and green again in spring; grass turns gold and straw, dull brown in winter; leaf litter falls mostly in autumn, mottled in autumn colours | M | done (this commit): Globals season, ?season= / ?year=, WorldCore.yearLength |
| F20 | Cover on props (round 52): snow, and dust, on the faces of structures that look up — snow while it snows there, melting in the warmth, swept off by a gale; dust under a dust storm or wind-lifted grit, washed off by rain. Sand cover (buried) was already there. Physics bodies and CPU models don't take it yet | M | done (this commit; scripts/covertest.mjs) |
| A1 | Agents that build and mine (round 52, DECISIONS): walkable surfaces from the intervals, fields per goal shared by state-driven groups, GPU units, digging and carrying (conserved), building on a Townscaper-style irregular grid, felling, fleeing, attacking; procedural characters later. Awaiting: which branch, whether it replaces the units session's pathing, scale | XL | proposed |
| API2 | Layer pulls (round 52; the world editor's first ask, DECISIONS): `terrain.pull(material, { mode, roughness, lean })` → a stroke, `to(x, y, { radius, height })` each frame, `end()`; `terrain.pullLayer` one-shot. Modes lift and through; overlapping calls compose (per-stroke memory per column, 8 strokes at once); the loose ground it lifts is shaken off (rounds 53 and 55: `shake`, default 1; for 4 s it slips at a lower angle, faster, roots letting go). Not yet: `conserve` (take the volume from a ring), sideways shoving, `expose` (strip the cover down to a material) | M | done (this commit; scripts/pulltest.mjs) |
| API1 | The world API (round 52, DECISIONS; docs/WORLD_API.md): Reclaimed as an engine, the world the game's — `createSim(host, worldDef)`, modules installed on their own, CPU-mirror queries in world coordinates, commands queued inside, events out, insides private. Steps 1–3 done (84c1236): terrain / water / fire reads and ground ops, wind (blows, strokes, wakes; no cap), fx by name. Then (this commit): smooth sampling as the field mesh draws, typed views cached per read, warmup with debris (WorldDef.warmup, attachSim, sim.warmup). Next: agents (on `agents`), physics, plants, weather (storms, the sun, per-place light), places, models, events out; content as data (plant species, materials: what it'd take is in WORLD_API.md); persistence later | XL | in progress |
| W0 | Places (round 51, DECISIONS): regions and rooms within them as named places — the runtime mutates a place (storms, time of day, fog, burying in sand, flooding…), queries adjacent rooms, specifies connections, changes what is in a room (enemies, puzzles, items, obstacles); spawning in a place and its terrain go through Reclaimed's API, the rest of the contents the game may own. Supersedes W2's flat region ids | L | step 1 done (this commit: plans, raster, queries, bury/flood/drain/storm masked to a place; connections as records); steps 2–5 open (docs/PLACES.md) |
| W1 | Generation from a room plan (round 50, docs/DECISIONS.md): partition primitives (Poisson-Voronoi islands, noise bands, boxes and halls, noisy SDF borders), bedrock shaped by the plan with tunnels and underground rivers, per-material layers with their own noise blended by SDF, a raisable field per layer and an editor op that pulls a layer along its noise | L | waits for the game-side design (API sketched to the units session) |
| W2 | Region ids (a contract buffer per column) and per-region weather and lighting for a game master | M | waits (W1) |
| W3 | Freezing a region (a per-region mask the systems honour; bodies sleep) | M | waits (W1) |
| W4 | Layered navigation: walkable surfaces stacked per column, linked where heights meet; JFA distance/vector fields from game-given seeds; scent trails | L | waits |
| Q16b | Rain still leaves narrow spires of sediment, unreasonably high (round 49; the user suspects plants holding the angle of repose plus layering with silt; Q16 helped but didn't fully fix it). Not reproduced yet (`scripts/spiretest.mjs`): 4–6 storms for 60–120 s at speed 4 over the valley, the sandbox, its planted ground and a fully planted map raise no loose-topped column over 5 of its 6 neighbours by more than the repose; towers 6 cells high on planted columns (soil under thin silt and dust) slump back to 1.1–1.5 in rain or dry. Waiting on a screenshot and where (level, mesh or prisms, how long it rained). | S | open |
| F9 | Day/night: longer transitions; redder/golden dawn and dusk | S | done `f8b019d` |
| F10 | Title screen: plants and tree at a scale that makes sense with the bones | S–M | done `46898aa` |
| F11 | Title screen: level models buried in dust, one unburied at the start; the rest unburied as the title progresses | M | done `46898aa` |
| F12 | Model import pipeline: download Creative Commons (prefer CC0) meshes — skulls, vehicles, ruins — and voxelize them by ray casting (inside/outside), map colours to materials, clean up (hollow tanks/hulls, fill with oil/water via oilStored), output into the F5 atlas; credits file | M–L | open |

## Round 12 (2026-10-08)

Order: D4, D5, D6 → D7 → D2 → D3 → D1 → then back to C6, C7, C9, C8.

| id | item | size | status |
|---|---|---|---|
| D1 | Title screen plants at diorama scale: flowers with petals and leaves, grass blades, moss, roots of the tree growing out of the skull | M | done `cb91f31` |
| D2 | Wind blows decaying (browned) plants away as dust/flakes | S | done `38514ee` |
| D3 | Cyclones from a tight circular drag: carry dust, cross the map destructively (free, cooldown; ruins/junk, spare grown plants) — supersedes C10 | M–L | done `fc954d8` |
| D4 | The squeaks under rain/storms (raindrop ticks / birdsong in rain) — remove | S | done `b4df5f8` |
| D5 | Grow sound: something unfurling, not a charging sound | S | done `b4df5f8` |
| D6 | Drag wind 2–3× louder relative to other sounds | S | done `b4df5f8` |
| D7 | Rounder edges on drifts / water / smoothed surfaces (cheap SDF-style edges) | S–M | done `fc2c534` |

## Round 11 (2026-10-08)

Order decided: C4, C3, C5 → C2 → C1 (with A6/A15 sediment) → C6 → C7 → C9 → C8.

| id | item | size | status |
|---|---|---|---|
| C1 | Dust drifts (fractional sediment layer) that bury things — uncover them with wind (objects, seed beds); supersedes A6 | L | done `5995426` |
| C2 | Smooth water surfaces (keep the rain rings / storm glints) | M | done `0c20e47` |
| C3 | Grow sound: a wet sprouting "opening", then the current shimmer | S | done `031b78c` |
| C4 | Audio debug: see and mute each sound (find the high whine under storms / on Nature gains) | S | done `031b78c` |
| C5 | A little light where growth and wind happen | S | done `031b78c` |
| C6 | Multiple levels; title screen shows clickable objects for each level | M–L | done `fd5b5a3` (valley + sandbox; highway/city/port are 'coming') |
| C7 | Level: highway covered in ruined cars | M | next |
| C8 | Level: port with tankers washed ashore and a seawall; ocean waves and sea swell | L | next |
| C10 | Swirling the mouse while dragging paints a vortex; a sustained swirl summons a cyclone (with B6 tornado) | M | done `fc954d8` (D3) |
| C9 | Level: ruined city with a blast crater and hospital tents (an outbreak) | M–L | next |

## Loose ends noticed in session 2 (not yet asked for, but worth doing)

| id | item | size | status |
|---|---|---|---|
| E1 | Sandbox still shows the reclamation bar (no goal there) — hide it or repurpose | S | open |
| E2 | Dust particles are unlit while the ground is lit/shaded: colour match drifts at dusk / under storms — apply sun/sky light to dust colour | S | open |
| E3 | Resting particles sit at whole-cell height; on smoothed slopes and drifts they float/sink — use the drawn surface height (groundZAt / drift corners) | S | open |
| E4 | Rubble falls instantly (no fall animation) — the remaining half of B8 | M | folded into F7 |
| E5 | Draw cost rose to ~4.6 ms at 1400×800 with drifts on screen (Xe-LPG); check the low tier / phones before adding level content | S | open |
| E6 | The tutorial doesn't teach drifts/buried gardens, cyclones or petals/seeds; consider short optional "firsts" (ties to B5) | M | open |
| E7 | STATUS.md (user-facing stock-take) is stale since session 1 — refresh | S | open |
| E8 | Editor: no undo, no save/load of a sandbox map; brush shows no cursor ring | M | folded into F6 |

## Carried over (deferred earlier — still wanted)

| id | item | from | size | status |
|---|---|---|---|---|
| B1 | **Phone testing**: pick hosting (GitHub Pages / local HTTPS / tunnel); Android Chrome; touch controls are in, but untested on a device | round 6 | S | hosting done (this commit): GitHub Pages via Actions at csheldondante.github.io/Reclaimed; phone test open |
| B2 | Sandbox / level-edit mode (deposit/remove-layer brushes, place water/oil/trash/plants, spawn storms, time controls) | round 6 | M–L | done `fd5b5a3` |
| B3 | Water life: fish in clean water, reeds/lilies in shallows | round 6 | S–M | deferred |
| B4 | Wind waves on water (shaded cheap; true height harder) | round 6 | S / M–L | deferred |
| B5 | Event camera beyond the intro: pan/zoom to firsts (animals arrive, a seed sprouts and dies, wind clears trash and a plant takes) | round 6 | M | deferred |
| B6 | Earthquake; drag-to-tornado | rounds 2–3 | M | tornado done as the cyclone (D3); earthquake **won't do** (user, 2026-10-09: "you essentially play as the wind") |
| B7 | Second level / data-driven map format | session 1 | M–L | registry done (C6); a data-driven map format still open |
| B8 | Water on slopes renders stair-stepped; rubble falls instantly (no fall animation) | session 1 | M | water part done `0c20e47`; rubble animation open |
| B9 | Audio has never been heard by an agent — every sound needs the user's ear | ongoing | — | open |
| B10 | Open judgement calls in STATUS.md §5 (economy, day length, night darkness, fire residue, lens UX, forest look) — several are stale; re-ask when relevant | session 1 | — | open |

## Done (recent; DEVLOG has details)

- Round 9: camera director + diegetic first-play intro; title screen with the
  level's hands, opening wither demo, reset progress; tap tiers (grass /
  flowers-shrub / tree; withering on hostile ground); one wind field storms
  ride; storms form at the upwind edge with distant thunder — `8b20abf`,
  `cfff42d`, `ef57291`, `38d0e95`.
- Round 8: stacking strokes (breeze/gust/gale), storms steered by the field,
  score = clean land + life, Nature pays for deeds — `f7f2740`.
- Round 7: persistent wind field, free taps, grime + washing, instant
  plant feedback — `dac7f5a`.
- Round 6: withering, seeds, grow-tap, litter, phone-ready layout — `4a1ba43`,
  `22256af`.
- Rounds 4–5: see DEVLOG.
