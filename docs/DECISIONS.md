# Design decisions (from review conversations)

Authoritative answers from the user. Newest first. The DEVLOG records how
each was implemented.

## 2026-10-11 — round 23 (session 4) — items Q1–Q3 in BACKLOG.md

- Water: the scrolling noise "looks good on deep water but looks weird for
  shallow water" — fade it out for shallow water (little puddles left).
- Strata branch: fractional heights make sense; the loose ground in the
  layers is "good but it's hard to see the difference"; the user wants to
  test the spill-out more themselves — "if we have a concrete basin full of
  sand and we blow down a wall does the sand spill out? That's a good test."
  They like the direction but aren't yet convinced it's better overall:
  don't merge yet, keep running with it.
- Destruction: "when we destroy blocks they should either turn into a new
  material (stone to gravel) or turn into particles (gravel into sand
  particles)."

## 2026-10-11 — round 22 (session 4) — items P1–P4 in BACKLOG.md

User: still better but pieces sometimes push back up, which looks bad;
don't burn many more cycles on physics now, but iterate later — a
structure as a rigid body supported from its base that tilts and falls,
with every impact destroying the intersecting blocks into material
particles (gravel/sand for stone, dust for brick). It needn't go straight
down; the rule is no block goes back up (only particles from destroyed
blocks). The sound is improved. A dying cyclone's dust should lose power
and fall but spread out, not drop where the column stood. Consolidation:
the intervals system in place of the loose-material system and the
separate interval systems — interval sediment, particles and fluids as
the three systems; don't start yet, and do it on a separate branch to
merge.

## 2026-10-10 — round 21 (session 4) — items O1–O2 in BACKLOG.md

- Body speed after M1 is much better, but bodies should crumble much more
  easily and break up more; impacts should make dust and chips; damp the
  collision response further (it can still move them too fast); a max
  speed, about 50 % faster than they topple now.
- Then: better by a good bit; add see-through dust clouds and particles to
  hide what is still a little janky; the switch from static to rigid body
  sometimes jumps rather than moving smoothly.
- Bug report: during storms, huge columns of material build up into the sky.
- Then (checked, pushed): broken building chunks should only fall — downward
  motion only — to look like collapsing structures; rigid-body collision
  response is too bouncy and breaks the illusion of scale. A deeper bass
  crumbling sound. A small cooldown (a second or two) on spawning cyclones
  so one swirl doesn't make several, reset when you release and press again.

## 2026-10-10 — round 20 (session 3) — items M1–M7, N1–N8 in BACKLOG.md

- Rigid bodies: fall more slowly, much more inertia (feel bigger); turn the
  collision response down — better to sink into each other slightly than
  spring back; the crumbling threshold can be lower; maybe deformation
  later (like World of Goo).
- Sound: owls and crickets at night instead of birds; frogs near greened
  water; tapping metal drums sounds by their size — almost musical.
- Every click makes a little ripple of wind pushing out from the cursor
  (you are the wind).
- Lightning: smaller radius around the click, but biased toward metal
  things within ~40 m, so mostly it listens closely and sometimes goes
  elsewhere; it chains from the top thing it hits to near the cursor (looks
  cool, sets fires).
- Gameplay redesign (to talk through before building): taps only grow from
  existing green, or fertile ground with a seed on it; green spreads outward
  from a start seed — grow, then blow seeds onto cleared, moist soil. Puzzle
  mode opening with the camera constraint (start at the origin: wind exposes
  a tiny green patch that grows; a blown seed followed to where it sprouts).
  Barriers to growth (things to burn or knock down with water) introduce the
  other mechanics. Wind strength, cyclones and storms unlock as green
  spreads. Ancient seeds buried on the map to uncover, plant or send down
  the river to the next level (every level has a river).
- Story through the environment: the first level becomes a biological
  research base (an obvious biohazard sign, a lab) — the same valley
  re-themed; the highway shows barricades (a failed quarantine); the city
  shows tents (a plague).
- Architecture: revisit for consolidation and simplification before the
  next big push (one model: solid intervals; a loose stack for everything
  soft; liquids that carry the loose stack; wind particles that settle into
  it).
- Order (user): the cheap, low-risk batch now (body feel, crumb threshold,
  click ripple, lightning tuning, night sounds, frogs, musical drums), then a
  handoff for the rest.

## 2026-10-10 — round 19 (session 3)

- K1b/K2 OK (pushed). Minor tweak: lightning should destroy even stone and
  whatever it strikes (L1).

## 2026-10-09 — round 18 (session 3)

- J1 and K1 look good (pushed). Also wanted: still be able to break the
  voxels of a body in its skewed frame; otherwise continue (K2).

## 2026-10-09 — round 17 (session 3)

- The loose ground rework looks better (validated; pushed).
- New: loose layers "fight" and end up in a checkered pattern, especially
  during wind — make it more stable (J1).
- Rigid bodies in their own rotated, shifted frames so things can be buried:
  talk it through and check in before starting — it's risky. Plan agreed:
  bodies keep their own frame and sleep at rest; a sleeping body is
  rasterised into a per-column "body top" the loose ground uses as its floor
  (it piles on, slides off, buries it); impacts/damage split bodies along
  their own grid. Answers: **a cap** (~64 bodies / 16k voxels) — over budget
  the oldest small bodies crumble into loose ground; a body **wakes when
  disturbed** (hit, undermined or washed out, a cyclone, a smash); the
  smallest pieces become **loose ground** (concrete/brick → gravel, metal →
  gravel/scrap, wood → ash); order: **checkerboard first, then bodies**,
  checking in after each of the three body steps.

## 2026-10-09 — round 16 (session 3) — items I1–I4 in BACKLOG.md

- The settling dust doesn't look like it should. Eight layers of dust with
  the tool made a bunch of dirt-like ground underneath with only a thin
  dust layer on top (the packing into "silt" cells).
- Landed particles settle and persist; they should fade as the dust layer
  beneath forms or grows.
- Soft materials (dirt, dust, ash) should be smooth, with no step drops;
  only stone, concrete and other solids have steps.
- Soft dust and dirt should wash into water, travel in it, and deposit under
  it or be carried off the map.
- Then talk through rigid bodies (don't build yet). The user's ideas: the
  rigid-body → voxels → back transition is too finicky. Objects could keep
  their own object-aligned grids, so a toppled item stays toppled and just
  intersects the dust and dirt layer — buried, broken up until it turns back
  into layers that add to the ground. A fallen skewed grid could still
  project into the map cells (imperfectly) so the terrain marks them
  occupied and new layers form on top (once at rest). Rigid bodies may
  crumble more, breaking on impact into aligned voxels over a threshold.
  Terrain is the default; things built into it are terrain-aligned; rigid
  bodies live in their own frame and can end up skewed and buried.
  (Agent: yes — sketch in the reply: sleeping bodies keep their grid, are
  rasterised into a per-column occupied range the GPU systems read; impacts
  and damage split them; small pieces become aligned voxels or loose
  material.)

## 2026-10-09 — round 15 (session 3) — items H1–H8 in BACKLOG.md

- Sandbox: a simple break tool to punch holes and make things collapse;
  structures with an overhang to break off, or a tall one with a base to
  destroy (done: 💥 Break + the physics garden).
- Title screen: random low gusts now and then so the grass waves and dust
  blows.
- Asked whether dust particles settle back and pile up like the other loose
  materials (answer: no — the airborne share is lost; to fix).
- Smooth gradients vs steps: steps make sense for stone; loose surfaces
  (dirt, ash, sand) should behave like dust — with a steeper angle of
  repose and needing higher winds to be picked up (if at all).
- Water loosens and carries loose materials: wash away packed trash heaps
  or dirt; blow away dust; asphalt and concrete need lightning or tornadoes
  to crack and break them down first. (Changes round 5's "trash only yields
  to fire": water now washes trash too.)
- Oil burns even in the rain (trees still go out).
- Storm outlines still change erratically (too quickly): steadier in shadow.
- Larger structures to place, like tall buildings.
- Green growing over loose things like dust should turn them into soil, or
  at least stop them being swept out from under the green.
- H3 answered: a loose **top layer** per column (dust, sand, ash, dirt —
  fractional depth, carried by wind and water, own angle of repose); the
  ground below stays whole cells. The dust drifts become this layer.

## 2026-10-09 — round 14 (session 3) — items G1–G5 in BACKLOG.md

- Fireflies less dense, only popping up in small patches.
- Sandbox visible from the start: the user wants to test the updated
  physics. The sandbox should be **a place to test and play with physics,
  placing things and the other mechanics**.
- Remove the cap on summoning tornadoes (cyclones) — very fun to do.
- Title screen: tapping several times still grows the normal (level-scale)
  tree, which looks silly next to the skull.

## 2026-10-09 — round 13 (session 3) — items F1–F11 in BACKLOG.md

- Dust sitting on top of water is wrong: water and oil lie above the other
  layers (those sink), except air or things built over the water.
- Sandbox drawing is too noisy and makes weird landscapes. Treat drawing as
  layers with a falloff at the brush edge: a press raises the land by one
  unit, each click raises the centre by as much, and drawing over the same
  place doesn't raise it again until you release and click again.
- Brushes should drop material onto the surface from above and let it
  settle by the rules, so you can make layers of stone, dust and dirt.
  Another brush raises bedrock from below; dirt and dust deposited on top
  with an angle of repose would be best.
- Asked whether there is an atlas of layered models that can be instanced
  (answer: no — every model is authored procedurally into the column grid).
  Wants thumbnails of ruins, tankers and ruined cars to place.
- Wants time to just build cool maps and play with the physics ("the basic
  particles and other things look great"); a chance to prototype more
  physics-based destruction with chunks or things that topple.
- Dust particles: more transparent or rounded.
- Day/night transition still jarring: interpolate for longer. Dawn and dusk
  redder / more golden.
- The tree and plants on the title screen still don't make sense with the
  size of the bones.
- The level objects on the title screen are not recognisable: bury them in
  dust with only one unburied at the start, and unbury the rest as part of
  the title-screen progression.
- Answers: the skull reads as a **human skull** — shrink the life to match
  (moss, lichen, fine grass, tiny flowers; the tree becomes a sapling
  rooted in the skull). Concretely: grass blades are sub-voxel and reach
  about **half way up the skull**; flowers are sub-voxel and about **the
  size of the eye sockets**. A buried level model is uncovered **either by
  finishing the previous level or by the player blowing the dust off it
  with the wind** (to encourage exploring). The sandbox stays reachable
  from a small link.
- Order: agent's proposal in BACKLOG (quick fixes → brushes → save/load →
  model atlas → title → toppling → C7, C9, C8).
- Later in round 13: download Creative Commons assets (skulls etc.) and
  voxelize them by tracing rays through them — a clean pipeline for adding
  models; clean them up (tanks hollow, then filled with liquid) (F12).
- F7 destruction (answered): **rigid-body chunks like Noita** — once a piece
  breaks free it becomes a rigid body, plus particles where it crumbles.
  Open question raised by the user: how to return a body to voxels when it
  is no longer grid-aligned (agent's answer: inverse-sample the world cells
  in its bounds when it comes to rest, after a gentle nudge toward a stable
  face-down pose; occupied cells → rubble on top; leftovers → dust).
- Breaking (answered): for models, something like **JFA / a medial axis** to
  get thickness; a cheap but passable **torque** estimate so large overhangs
  snap where the strain is too great — "more physicsy will make things feel
  better". For terrain, the current support rule or a variant (how much
  column material is connected).

## 2026-10-09 — end of session 2

- No earthquakes (won't do): the controls make sense as they are — the
  player essentially plays as the wind.

## 2026-10-08 — round 12 (session 2) — items D1–D7 in BACKLOG.md

- Title screen plants detailed for its scale (petals, leaves, grass, moss,
  roots of the tree out of the skull). Wind blows decaying plants away as
  dust. Cyclones from spinning the wind in a tight circle: they pick up and
  hold dust and cross the map destructively — **free with a cooldown**,
  **damage ruins and junk but spare grown plants**. No squeaks with rain.
  Grow sound like something unfurling. Drag wind 2–3× louder. Rounder edges
  on smoothed surfaces.

## 2026-10-08 — round 11 (session 2) — items C1–C10 in BACKLOG.md

- Dust drifts that bury things you uncover with wind. Smooth water (keep the
  storm specular jitter). Grow sound: wet sprouting, then the shimmer. A way
  to debug and see sounds (a high-pitched sound under storms / on Nature
  gains). A little light where growth and wind happen.
- The desolate wind should sound like a howl.
- Wind follows the mouse so swirling paints a vortex; a swirl could summon a
  cyclone.
- Overall map wind low outside storms; it dies down when no storm and no
  player wind. The field biases direction; magnitude is raised/lowered.
- Multiple levels; the title screen shows clickable objects per level. Maps:
  the dam/industrial valley; a highway covered in ruined cars; a port with
  tankers ashore, a seawall, ocean waves and swell; a ruined city with a
  blast crater and hospital tents (an outbreak).
- Order (agent's call): C4, C3, C5 → C2 → C1 → C6 → C7 → C9 → C8.

## 2026-10-08 — round 10 (session 2) — items A1–A15 in BACKLOG.md

- Sound: howling desolate wind with periodic gusts on the title screen while
  barren, and in the level the more barren the more desolate; drag sound is
  wind only (starts with the drag, no snap at mouse-up), deeper than the
  desolate wind.
- No birds on the title screen (they make the skull look giant).
- Blown dust piles up on things. Wind is stronger under storms. Map wind is a
  steady prevailing flow with minor noise (also in the player field). Storm
  shadows steadier. Light fair-weather clouds pass to show the wind.
- Seeds that land greenify their spot and clean a little pollution. Wind over
  flowering plants sheds the flowers; they regrow slowly.
- Difficulty (chosen on the title screen, default Medium): easy — green
  never re-pollutes; medium — green resists; hard — blown trash, strong wind
  and too much water kill green easily.
- Tutorial builds skills: growth/death → wind → free play demonstrating it →
  a pollution pile wind can't move → a storm forms and the **player taps**
  to strike it with lightning.
- Smooth soft surfaces: **render slopes first** (per-material: under a gap
  smooth, over it a sheer drop), **then a fractional sediment layer** for
  dust drifts.
- The user wants a running list of suggestions so nothing is lost:
  docs/BACKLOG.md. Phone testing: later (B1).

## 2026-10-08 — round 9: intro, title screen, tap tiers (session 2)

- Tutorial/camera: a system that can limit pan and zoom. Intro: show the
  map, zoom in on a flower trying to grow out of dust and wilting; wind
  blows the dirt away and a tiny patch of green forms and persists (green
  ground slightly resistant to pollution drifting in); the player clicks to
  make flowers, clicks a polluted area to see them wither; zoom out.
- The title screen has the same mechanics, shows withering first, and has a
  reset button (to see it dusty again).
- Taps tier up: one click grass (withers on bad ground), two flowers or
  shrubs, three a tree (which on bad ground grows, darkens and withers).
- The wind field is what storms ride; painted wind modifies it. Storms must
  reliably appear: the storm button gives distant thunder at once, then the
  storm forms and rolls in from the edge soon after.

## 2026-10-08 — round 8 (session 2)

- Storms always form upwind (at the map edge) and drift across the map.
- The wind field is what strokes modify; it blends back slowly to the
  map's own wind. Storms are moved by the field (indirect steering).
- Strokes over the same place stack: one pass a breeze, two a gust, three
  a gale.
- The nature score should be clearly tied to clearing pollution and growing
  forests.
- (round 7) Taps never cost Nature; fun of the basic mechanics over pacing.

## 2026-10-07 — round 6: clearer objective, diegetic clues (session 2)

The player mostly *is* the wind; wind should do meaningful things, and the
world should show what needs clearing and how.
- Plants wither as well as grow: a seed sprouts on trash, chemicals or
  oil, grows, turns brown and dies — a diegetic clue to what blocks life.
- Trees release seeds; wind carries them further. Flushed birds drop seeds
  as they fly (showing where plants will and won't take).
- Tapping living ground gives a small, free growth boost (on bad ground it
  shows a wilt instead).
- Wind scatters loose trash; land cleared enough lets plants keep growing.
- Fire turns hard-to-clear things (oil, dumps) into clouds/ash the wind
  takes away (round 5).
- Later (with the user): camera that pans/zooms to firsts (animals arrive,
  seed sprouts and dies, wind clears trash and a plant takes), a built-in
  diegetic tutorial, sandbox/level-edit mode, water life, true wind waves.
- Phone testing: Android Chrome. Hosting (Pages / local HTTPS / tunnel) to
  be decided together.

## 2026-10-07 — feedback round 5 (session 2)

- Motion: springier but slower to bounce back; everything a bit slower and
  more relaxed. Trees bend and *stay* bent in wind, then spring back.
- A drag makes wind that lasts a second or two after it — longer and
  stronger the faster the drag.
- Storm cloud shadow darker. No cloud puffs: rain fades in from a height.
- More negative consequences: spilled oil drains Nature; burning it makes a
  smoke cloud that raises Nature once wind disperses it. Oil on water burns.
  Forests can catch fire and burn. Drowning plants drains Nature.
- Some things only yield to fire (or need burning before they can easily be
  removed) — e.g. trash heaps.
- Audio direction (round 4 follow-up): ambience quieter and distance-based;
  clicks always loud (they're under the cursor, the player's focus).

## 2026-10-07 — feedback round 4 (session 2)

- Audio: everything quieter when zoomed out; some sounds are positional and
  louder near their source (water at the dam, rain under storms, birds near
  birds).
- Lightning flashes light over the whole scene.
- Sun shadows should visibly move across the terrain; smoother day/night
  transition.
- Particles (leaves, pollution, trash, dust) rest on the ground and are
  stirred up by wind — they don't spawn in mid-air.
- Storm clouds: **higher and thinner**; rain starts at the cloud *base* so the
  land under a storm is seen mostly through rain.
- Dust clouds roll across the map early in the level and act as weather when
  wind picks up.
- **One drag gesture**: any drag makes wind (strength from drag speed/length)
  that ripples water, grass and leaves; dragging under/near a storm also
  pushes its heading. No storm arrow — players discover steering.
- Birds perch in trees and fly in from off the map; only trees with perched
  birds flush birds.
- Nature goal: a level should take **~5 minutes** of reasonable play (lower
  goal and faster growth; measure).
- Wind ripple must be smooth and wave-like, not jittery.
- Starting pollution: **oil slicks, toxic sludge (new non-flammable liquid,
  washes away / slowly broken down by plants) and trash heaps** (wind
  scatters them).
- Menu: a clearer skull, a ribcage, and a reddish-grey dust mound.

## 2026-10-07 — feedback round 2

**Accepted direction**
- Remove camera rotation (fixed view; stylise shading for that one angle).
- Water ripple/glint must read from the fixed view.
- Pollution is *matter*: liquids (oil, sludge — flow, float/sink by density,
  burn) and wind-blown particles (dust, ash, litter). Soil stain remains as a
  residue, and **any water over it washes it** (not only rain). Sinks: off
  the map edges, burned, or decayed by plants.
- Density ordering between materials (stone sinks in water and oil; oil
  floats on water).
- GPU particle system: dust/litter/ash/leaves/clouds; particles make wind
  visible.
- Day/night cycle; weather particles (storm clouds, dust).
- More colour variation in stone/dirt.
- Sub-voxel leaves with gaps (fixed view makes an impostor-like approach
  viable); leaves and grass rustle in the wind (with leaf sounds); small block
  details: grass tufts, wildflowers, vines.
- Hover/click reactivity: vegetation sways as if wind follows the cursor;
  clicking trees releases birds/leaves; tanks make a hollow metal sound;
  buildings chip with a decaying-tile sound (**cosmetic**, decay feel; may
  hasten failure slightly but not required).
- Controls: diegetic, no tool buttons (may return for touch later).
  - Storms are large and roll across the map with the wind (wind visible via
    debris). A storm can still be *summoned* — keybound, recharges.
  - Click in a storm's shadow → lightning (lightning takes precedence when
    under a storm). If lightning isn't recharged: trees sway hard / metal
    strains (feedback instead of an error message).
  - Drag under a storm → a big gust in that direction.
  - **LMB = interact / gestures, RMB drag = pan, MMB = zoom** (wheel too).
  - UI only shows recharge.
- Small player nudges to particles (cursor wind) are fine — ambient game.
- Animals are for theme and liveliness, not core play; small systemic
  touches (birds spreading seeds) are welcome.
- Future disasters (quakes, tornado by dragging more) — later.
- River: constant inflow from the map edge, at equilibrium with the dam at
  start; the dam has an outflow (spillway) so it doesn't overtop.
- Order: quick wins → particles + oil → storms/controls/wind/day-night →
  fire → life & look.

## 2026-10-07 — feedback round 3

- Dust should drift down, settle, and get swept up again by new breezes.
- Build the menu screen (skull diorama, §4).
- Clouds higher; storms larger and less uniformly shaped.
- A bar for how much nature is on the map; the level ends above a threshold.
- White birds that flap (low fidelity is fine); deer or small brown animals
  that roam and scatter when you click.
- Taps on structures should visibly crack them with a stone-falling sound.
- Audio softer overall; rain sound only under storms; otherwise wind and
  distant rumbling thunder (the constant "not-quite-rain" noise must go).
- Biomes: trees on flatter, wetter ground; open fields; fireflies only in fields.
- More tree variety and height variety.
- Tank tap: deeper, more hollow. Tanks closed so oil only shows when they break.
- Clicking water should splash (with sound).
