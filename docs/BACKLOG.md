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

## Round 22 (2026-10-11, session 4)

| id | item | size | status |
|---|---|---|---|
| P1 | Falling pieces still sometimes push back up: no block ever moves up (only the particles a destroyed block emits) | S | done (this commit) |
| P2 | A dying cyclone drops its dust where the column stood: it should lose power and fall while spreading out | S | done (this commit) |
| P3 | Destruction, the fun version (iterate later, not now): a broken structure is a rigid body supported from its base that tilts and falls; every impact destroys the blocks that intersect and turns them into material particles (stone → gravel/sand, brick → dust); nothing but particles goes up | M–L | later (user: "eventually") |
| P4 | Consolidate to three systems: interval sediment (the interval layers replace the loose-ground stack and the separate interval systems), particles, fluids — refines N1; on its own branch, merged when ready | L | talk first; don't start yet |

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
| N3 | Growth redesign: taps grow only from green or seeded fertile ground; seeds spread it; fertility = clean + moist + uncovered | M–L | talk first |
| N4 | Puzzle-mode opening on the camera director; barriers to growth as level gates; wind/cyclone/storm unlocks by green | M–L | after N3 |
| N5 | Ancient seeds buried, uncovered, planted or sent down the river to the next level; every level has a river | M | after N3 |
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
| B1 | **Phone testing**: pick hosting (GitHub Pages / local HTTPS / tunnel); Android Chrome; touch controls are in, but untested on a device | round 6 | S | deferred (user: later) |
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
