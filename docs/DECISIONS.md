# Design decisions (from review conversations)

Authoritative answers from the user. Newest first. The DEVLOG records how
each was implemented.

## 2026-10-28 — round 104 (session 5, `simscale`) — the simulation scales with what's active

- The user, verbatim: "My understanding is also that we can limit the sleep check to regions the player is acting on
  and essentially have the simulation scale with only the things we want active which is typically very little. I
  would like to try to get a steady 60fps on the phone with no hiccups and no pop in if possible. … If it's a
  fundamental limit of phone hardware then let's arrive at that though benchmarking and exploring why."
- On wind and climate, verbatim: "Why does wind and climate need to run everywhere and at what frequency? Most wind
  effects I've seen are gusts near the player and maybe a global Atlas level tick that can be very infrequent."
- On the agents, verbatim: "For the agents we already discussed that we should compute paths instead of flow fields
  for towns then just move agents along the paths between destinations. Flow fields can be generated as needed and I
  suspect only during large combats or storms. That means storm framerate may drop to <30 fps but that's reasonable
  for a very action and simulation heavy scene".
- → Branch `simscale`: every pass that only matters where something's awake dispatched over the live chunks; the wind
  field only round what painted it; the agents' fields kept round what the agents do and frozen once settled — the
  GPU equivalent of the user's paths (a field made once and walked down), not a CPU path graph; ST15 (explicit paths)
  stays open (BACKLOG SC1–SC6).

## 2026-10-28 — round 102 (session 5, `gpugen`) — region generation stays on the GPU, by the phone's numbers

- The user (round 101–102), verbatim: "Aren't all of the methods used to generate land very GPU efficient? … I sort of
  expected this was done GPU side". From round 101: "If we had adaptive tile generation, precached larger areas when
  traveling via the atlas map we might be able to improve framerate in that mode rather than guessing."
- The phone's bench (data/bench/pixel9a-2026-10-28.json) decided it: ~2 ms of GPU a region against 149 ms wall p50
  (the readback 44, the upload 22, the CPU's cut 9.6, a settlement's plan up to 290 on the main thread).
- → Branch `gpugen` (from places c223350): a region's columns finished on the GPU straight into a pool slot (no
  readback of the columns, no CPU cut, no upload); settlement plans in the plan worker on the exact raw ground made on
  the GPU; the stamps (settlements, a run's stage) as operations both paths run; the tile pacer by a GPU budget a
  frame, more when the camera moves fast; the ring round a warp's window precached; `?gpugen=0` the CPU's path,
  identical columns (BACKLOG GG1–GG11).

## 2026-10-28 — round 102 (session 5, `places`) — settlements as fields, grids and spans (design, for later)

- The user: "I think that ids and what building goes where might make sense to do on the CPU. I'm not entirely convinced
  though. I was imagining that the density field is essentially the height of buildings in each cell of the irregular
  grid so I was assuming that for rendering it didn't really need to know anything about what a building is but only the
  field value and how to produce the grid on the GPU. … In terms of layout I think there are two pieces: 1 the identity
  of each span of structure on the grid 2. The grid layout itself. Would it make sense potentially to have each grid be
  store intervals like the terrain but for building types?"
- On main's questions: "1. I agree" (spans authoritative) "2. I think derived is ok but we may need to drive agent
  behaviors then and path generation by type 3. … Can this just be a course representation? I think edits can flow back
  if the field is just a count of people or structures or something. 4. I think two so we can have overgrown buildings
  but I'm not certain." → BACKLOG ST17 (design only; come back to it).

## 2026-10-28 — round 104 (session 5, `bench2`) — the pan benchmark

- The user, verbatim: "Let's build a test of just panning in a straight line as fast as we can at zooms that always
  keep all regions on screen drawn. I want to try both generating and intelligently streaming from disc to memory to
  the GPU. I want to know on each device and at each zoom what is a max speed that is smooth, hitch free and never
  lags behind the camera."
- → `?bench=pan` on `bench2` (BACKLOG BN27).

## 2026-10-28 — round 102 (session 5, `bench2`) — the benchmark after the first phone run

- The user, verbatim: "we should also run once the GPU work is done and see if getting rid of the CPU readback fixes
  things even more and let's us crank up pan speed and view distance".
- On the phone's v2 attempt, verbatim: "No the issue is that because the report finished once it shows the download
  option mid test whenever it goes to the grey loading screen so it wasn't possible for me to tell when it was done".
- On the desktop baseline, verbatim: "I don't think we need a new baseline for v3 just the bug fix".
- → bench v3 on `bench2`: pans to 320, windows to 512, the fastest pan each window sustains; no download offered
  mid-run, the previous run labelled; no new desktop baseline (BACKLOG BN17–BN21).

## 2026-10-28 — round 101 (session 5, `bench`) — a calibration benchmark on the phone

- The user, verbatim: "Can you build a calibration test that we can run on the phone to directly give you benchmark
  numbers? It really isn't efficient for me to tell you by feel when we could run something and give you numbers on
  how long different things take in practice so you can compute throughput and then target the actual bottlenecks. I
  can say the atlas mode plays better after last nights work but the hero runs still have framerate drop and they
  show much less of the map generally speaking. If we had adaptive tile generation, precached larger areas when
  traveling via the atlas map we might be able to improve framerate in that mode rather than guessing. That said my
  intuition is that controllers should be parameterized and live in the engine on the GPU and just target better
  framerate to deal with latency or dispatch the input based update before rendering."
- Agreed the same round: generation stays fully on the GPU (GPU stamps for ways and settlements, packing on the GPU,
  straight into the region pool), a GPU-time budget a frame for generation, hero locomotion as engine kits, and one
  small near-hero CPU cache read only where pages changed. The benchmark is what sizes those.
- On getting the result off the phone, verbatim: "Will this generate a file or something on screen to copy? A
  download report button is probably better because screen space is limited and copying may be a pain." Then: "A
  copy button is also fine I just don't want to manually select and copy".
- → Branch `bench`: `?bench=1`, one tap, ~5 minutes; a big "Download report" button (the JSON as a file), "Copy" (the
  whole JSON on the clipboard in one tap) and a small "Share…"; the hitch recorder's HUD has "download" too (BACKLOG
  BN1–BN8).

## 2026-10-27 — round 100 (session 5, `regionstore`) — the world serializes; streaming never waits on a region

- The user, verbatim: "I want to try to fix the performance issues and I want the world to serialize so we can
  recover the visited cells that change. I'm ok with delta only or storing the whole region but lean towards the
  whole region until we know we need the other. We can stream and cache regions ahead of time even further out
  ahead of the camera so we never wait for them and read from an atlas."
- Earlier: "If the regions are not too expensive we can store and stream them too … the column format should keep
  them fairly lightweight" and "We will need mesh transforms though once we add the other meshes and grids." And:
  "If they are rare or small or async and not latency sensitive it's not an issue."
- → Branch `regionstore` (from places 8bff120): frozen regions stay on the GPU in a pool (copied GPU to GPU, LRU);
  every region frozen and the window's in turn are read back off the frame, and those changed are written whole to
  IndexedDB (compressed in a worker); the window's changed regions are restored on reload; land is asked for two
  strips ahead of the camera's motion and uploaded into the pool before the slide (BACKLOG RG1–RG10).
## 2026-10-27 — round 100 (overnight, `zmesh`) — no vertical slide; mesh by content

- The user, verbatim: "Why does moving the loaded are vertically cost anything? … Are readbacks needed or can we do
  it on GPU? If they are rare or small or async and not latency sensitive it's not an issue. Can we do something
  cheap like a standard mesh around the camera that we set to and texture with the heightmap? Why do we do
  remeshing everytime if it's expensive? Can we limit it to cliffs or something? I already have it at low
  resolution and enjoy the lowfi look". And: "I want to try to fix the performance issues".
- → Branch `zmesh`: the window holds the atlas's whole height (zMax 504, oz 0), so it never moves vertically — no
  readback, no CPU re-cut, no band; the hybrid's voxel chunks are chosen by what they hold (open gaps — overhangs, caves,
  arches, rooms — edits, columns over 12 cells off a neighbour; a form alone no longer), not by the camera's distance — the rest is the grid (the "standard mesh
  … with the heightmap", round 86), which isn't remeshed at all; land just come in is the grid's after 3 sim ticks,
  not 0.4 s.

## 2026-10-27 — round 100 (session 5, `hitchrec`) — instrumentation for the phone; the judge and arriving land

- The user, verbatim: "I want to try to fix the performance issues"; "GC is worth looking into"; "It woudl be good to
  check longterm performance and for leaks at some point. I don't think we are anywhere near memory limits so this
  seems premature. Don't be dumb with it but don't spend effort when it isn't warranted."
- → Branch `hitchrec`: the hitch recorder (`?hitch=1`) with a report the phone sends, a GC audit with the heap
  sampler, one light soak (BACKLOG HR1–HR9).
- **Main's call, under the user's design (not asked of the user):** land that comes in with a slide is no longer
  judged by the integrity judge. The user's words it rests on (rounds 83 and 92): "on editing a column (anything
  editing) I would wake it up … only needs to be done when the structure changes" and "you don't need to check all
  of them just the ones that we woke up". Generated land (stamped towns, ways, bridges) stands by construction; edits
  seed the judge. A judge pass caps its structure boxes at 8 ms and never blocks the main thread for seconds.
- **Main's call:** the world API's mirror reads the layers by pages round the camera (and the points callers keep
  fresh: the hero's) between whole reads, by default (`?mirror=full` the old). The user: readbacks are fine if they're
  async and not latency sensitive — this one starved the latency-sensitive ones. A caller that needs far columns as
  they are asks for a whole read (`refresh(true)`) rather than getting a stale answer.

## 2026-10-27 — round 99 (session 5, `runstream`) — the world streams during a run

- The user, after playing the GameplayGM slice, verbatim: "The controls are integrated but why is the streaming
  disabled?"
- → Branch `runstream`: the run no longer holds the window still (Streamer.auto stays on). The stage is kept in
  world cells and stamped into the land as it arrives (like the settlements); warps and long rides keep the places,
  the doors opened and the cast (BACKLOG RS9, RS16).

## 2026-10-27 — round 97 (session 5, `heroapi`) — the vertical slice: pick a hero, a run, its legacy

- The user, verbatim: "I like boundaries and API contracts so keep it there but please update and spin up a build
  with the story run structure" and "So yes go with those steps".
- Earlier: "without the outer loop of character selection it isn't really a vertical slice and the current
  implementation isn't fun because it does a lot of telling and not showing and it doesn't use the fun mechanics I
  worked on in the hoverbike branch (does it use the controlls abstraction of mapping gesture to intent to toleranced
  assisted action?) … concerning that basic dialog choices don't show. I would expect it to be trigger/predicate
  driven and tied to events like deaths and have dialogs just be such an event."
- And: "Keep warp on for now because the character is way too slow".
- → Branch `heroapi`: additive contract changes so the hoverbike game (GameplayGM, experiment/slice) runs the story
  with its own heroes, controls and enemies (startAtlasRun, makeController, units, ownCamera, Hero.claims,
  HeroIntent.talk); dialog as an event (Outcome.say / talk, Condition.saw, happenings as the triggers); the dialog's
  missing answers fixed; the Bell story shows more (the dead on the road, barks); MemoryWorldState.restore for the
  world between runs. Hero select, the heroes and saving are GameplayGM's.
## 2026-10-27 — round 99 (session 5, `meshinst`) — meshes and instancing mixed into the columns

- The user, verbatim: "One question I have is can we more seamlessly mix normal meshes or sprites (instanced maybe)
  into the existing terrain system so that we let a skewed mesh be buried instead of turning back into an ordinary
  layer. It does mean that the layer needs to be skipped and marked as being in an external system so that it can
  properly support columns over it and interact. I think we want to replace the characters and the buildings and
  trees with meshes and instancing. We want this to be faster on phone and I think that will be better. The terrain
  itself is awesome though so let's see if we can make streaming even more performant on mobile."
- On the rock bodies, verbatim: "The physics simuilation is an ok attempt. I think it's a slight improvement or
  lateral over the original RB based rocks."
- → Branch `meshinst` (from places), `?meshinst=1`, default off until measured: External intervals (an owner's
  cells, solid to every sim, skipped by the terrain's draws), an instanced mesh renderer, trees as instanced meshes,
  a resting rock body staying its mesh with External intervals under it (buried, holding what's put on it);
  buildings and characters outlined (BACKLOG MI7, MI8). Streaming on mobile is `streamspeed`'s.

## 2026-10-27 — round 96 (session 5, `rockbody`) — weightier rock, metal on the physics voxels, on in the atlas

- The user, after playing round 95, verbatim: "Ok the rigidbody version is much better. The pieces still feel a bit
  floaty and I think it is because they have a little too much collision response and I think the primary reaction
  to collisions is to crumble and shatter with stone at scale. It would be interesting to have a different material
  like metal (does it use the deformation physics the buildings do?)"
- Then, verbatim: "No you want slow falls to convey scale not more acceleration. But otherwise yes this is good. GPU
  solver is great if we can get it to work the way we want. As long as rendering still uses the mesh that's the
  best of both worlds." → gravity stays 1.
- Then, verbatim: "Rock physics looks mostly right with the CPU version so don't sweat it too much. Just slightly
  weightier it was better the second time I tried it" → rock stays on the CPU bodies, a little less bounce and spin,
  a little more crumbling; metal on the GPU solver (physics.ts, as the buildings and the drop tool).
- And: "And then I think push to atlas" → rock bodies on by default in the atlas and the rock lab (`?rockbody=0` off).
- Testing collapse round 96, verbatim: "The pieces at those links don't seem to be tipping anymore. I still want them
  to lean and fall if you destroy one side" → a leg cut on one side leans the piece over and it falls (RB15). On
  merging collapse into rockbody: "Oh I see merging them. Ok that's fine".

## 2026-10-27 — round 95 (session 5, `rockbody`) — rock as a rigid body while it falls

- The user, verbatim: "It could be fun to spin up a new rock agent to make the disjoint chunk a rigidbody during
  falling but I know the rigidbody sim needs tuning (still probably worth making an experiment for me to play
  with and give feedback on)" → branch `rockbody`, `?rockbody=1` (default off), its knobs on a panel in the rock lab.
- Then, verbatim: "Ok so the rigidbody sim should definitely render the mesh not cubes. It can use cubes to
  simulate the motion but just anchor the vertices to the cubes" → the piece's own field mesh, made once when it
  breaks free and moved with its body; the cubes hidden (`rbcubes=1` shows them), casting the shadow.
- Earlier (round 86), still the brief: "I strongly recommend we simulate as voxels but split the mesh and have the
  rock column fall and just weight vertices to voxels (although rock I don't expect to flex only crumble)" and "it
  should also probably make a big cloud of dust … and maybe sparks".
## 2026-10-27 — round 98 (session 5, `streamspeed`) — streaming ahead of the camera

- The user: "I think our next goal should be to see if we can get streaming to stay ahead of the camera and how fast
  we can get the camera moving without losing fidelity"
- → `streamspeed`: measured the streamer's pipeline end to end at the phone tier (scripts/speedsweep.mjs); a slide
  now waits for its land and is written in a frame or two, not held `busy` while it's made; the tiles of the
  region build paced by the frame's time; the arrived chunks' meshes made urgent (DEVLOG round 98).

## 2026-10-27 — round 94 (session 5, `runstory`) — where to go, and the hero too slow

- The user, on the phone: "The story doesn't actually have the map improvements so I don't know which direction
  to walk... You could also add an indicator of where to go."
- And: "Keep warp on for now because the character is way too slow".
- → `runstory` has phonecam's map (the wiki's names, the compass, the turn buttons, the range setting). The
  current objective's target (a person, a place or a door, from the story's own conditions) is shown as a marker
  over it or an arrow at the screen's edge with the distance, as a pin on the map with the hero's dot and
  facing, and as a line under the objective ("→ Reeve Hesk Marr · north-east · 140 m"). The map's warp stays
  on in a run and takes the hero with it. The walk is faster (8 cells/s, was 5.5), with a run toggle (×1.7).

## 2026-10-27 — round 88 (session 5, `runstory`) — a hero in a run story

- The user, verbatim: "I would like to try spawning as a character like in hoverbike and talking to people or going
  places or fighting things for a run story."
- → Branch `runstory`: an on-foot hero behind a `Hero` contract (the hoverbike game's heroes plug in instead), the
  Bell story staged on the atlas level near the spawn, its cast as units (a `Units` contract the settlements' GPU
  agents will implement), talks, objectives, happenings, fights, death ends the run; `?run=bell`.
## 2026-10-27 — round 96 (session 5, `collapse`) — the rock's knobs, thin legs, basalt

- The user, testing round 92 on the phone's atlas, verbatim: "Collapse works but I think meteors sometimes make
  basalt that resupports it. Also, it seems like small supports still support it in atlas is that a setting?"
- → Yes, they're settings: fracture.ts ROCK's constants (BEND, SHEAR, CRUSH, NECK_R, TIP_GIVE, and new BUCKLE,
  TENSILE) and each material's bear, set from the page's address (?crush=, ?buckle=, ?tensile=, ?bear=sand:0.1 …)
  or the rock lab's panel; logged as `[rock] …`. A thin leg now fails as a column does — buckling over its free
  height, pulled apart by an off-centre weight — not only by crushing (round 92's CRUSH 300 a column let two
  columns hold 600 cells). Basalt: the meteor's rim no longer melts the tops of what stands over the bowl (C19),
  what the rim's watch judges is weighed, basalt films a hundredth over what's under them touch it.
## 2026-10-27 — round 95 (session 5, `rockbody`) — rock as a rigid body while it falls

- The user, verbatim: "It could be fun to spin up a new rock agent to make the disjoint chunk a rigidbody during
  falling but I know the rigidbody sim needs tuning (still probably worth making an experiment for me to play
  with and give feedback on)" → branch `rockbody`, `?rockbody=1` (default off), its knobs on a panel in the rock lab.
- Then, verbatim: "Ok so the rigidbody sim should definitely render the mesh not cubes. It can use cubes to
  simulate the motion but just anchor the vertices to the cubes" → the piece's own field mesh, made once when it
  breaks free and moved with its body; the cubes hidden (`rbcubes=1` shows them), casting the shadow.
- Earlier (round 86), still the brief: "I strongly recommend we simulate as voxels but split the mesh and have the
  rock column fall and just weight vertices to voxels (although rock I don't expect to flex only crumble)" and "it
  should also probably make a big cloud of dust … and maybe sparks".

## 2026-10-27 — round 94 (session 5, `farbake`) — the land past the window baked into a texture

- The user: "The draw distance is ok but I don't understand why towns and grass aren't baked into a texture we can
  stream so that distant tiles draw correctly further out"
- → The land past the window is baked once into a streamed texture (a clipmap: a level a ring and one for the far
  land) from the window's rules, the settlements within reach planned off the main thread on the atlas's own ground
  and their tops baked in; the rings and the far land draw it, lit a frame. `?fb=0` round 93's look. See DEVLOG
  round 94 (and why the towns weren't there: their plans needed the window's raw columns).

## 2026-10-27 — round 93 (session 5, `fardetail`) — detail past the window, cheap

- The user, on main's option 5 (plants, roads and grass colour on the far land, baked once as 2D maps): "I'm also
  curious about number 5 and it seems like that could be fairly cheap and fast and resolve much of the visual pop in
  on its own. Maybe have another agent explore that in parallel?"
- Earlier (round 91): "I notice that I easily hit the edge of the loaded ground"
- → The LOD rings past the window bake, once per texel as they already do, the plants the window's columns start
  with and the distance to the atlas's ways, and draw them the window's way (its ground colour, grass, paved ways,
  painted trees, its light); the near side no longer pressed flat. `?fd=0` the old look. See DEVLOG round 93.
## 2026-10-27 — round 92 (session 5, `collapse`) — what holds rock up; the meteor-made floaters

- The user, on the collapse judge (a hanging piece joined to any standing run was held whatever it weighed; a
  huge pillar top stayed up on a two-column leg after a meteor at its foot), verbatim: "The way I would do it is
  on editing a column (anything editing) I would wake it up. The simulation I would probably do is connected
  components of solid intervals then look at total solid support under an interval and see if it is sufficient
  for the volume of the connected section and if not collapse it. This can all be done pretty cheaply in column
  space as connected components should be in 2d column space and only needs to be done when the structure
  changes. You can also treat non solid material as support but I would weight it lower. If you want to make it
  even better you could compute distance to the nearest lateral support for each column via JFA and flood fill in
  from the edges by distance so that you sum column mass and support from neighbors. If the mass ever exceeds the
  support then drop the column. ... Remember supports can be vertical or horizontal and we can get both pretty
  cheaply with columns"
- Answers to the agent's questions: "1 where it breaks 2 now and we can add rotation later 3 I'm not sure what
  simulation changes break stone currently but maybe we defer this unless doing so is more effort". And: "note
  that in one of my screenshots the column is actually floating with zero visible support so I think there is
  still a bug in when we trigger the logic to run the check and wakeup the columns".
- "Please have the rock agent make a playground like the one used for waterfalls as it is convenient for me to
  test with too. (Although may miss the cause of bugs in atlas)" → `level=rocklab`.
- On the agent's first finding (the atlas's generator leaving rock floating): "No it was meteor made floaters";
  "The generator does not in my experience create floaters"; "I'm my experience there were never floating rock
  chunks visible but I can't rule out that the overhang code the agent wrote didn't introduce any. Nothing I
  designed does by construction." → islands are not dropped at generation (reverted); most of those "floaters"
  were the judge's join rule (thin strata touching by 0.47 < 0.5), fixed in the judge.
- The user's hypothesis: "It's probably something stupid like the meteor creates magma that seems to for some
  reason drop from the top of the column and it probably treats that as support and goes back to sleep"; and
  "I'm guessing it just never really tested with all the systems in play and it's an oversight". → The latter: the
  tests all turned the streamer off (`stream.auto = false`); a slide (xy or z) while a meteor-freed piece fell
  left it in the air, forgotten. Fixed; the tests now run with the streamer on.
- → Support (round 92): breaks where it breaks (the most overloaded cross-section), tipping now (straight down;
  rotation later, BACKLOG C4), only what an edit weakened is weighed; loose ground bears less (the table's `bear`).
## 2026-10-27 — round 93 (session 5, `winmem`) — what the streamed window spends its memory on

- The user: "I think a loaded area shaped like the view could work but what about the current layout takes so much
  memory? We can also do better visual detail further out but it would help to know what is expensive in terms of
  memory and what to prioritize."
- Then: "Yes just have it work in another branch and set up experiments for anything risky."
- → Branch `winmem` (from `phonecam`). Measured buffer by buffer (DEVLOG round 93): at the phone's 320 window the GPU
  held 465 MB, ~4.5 KB a column against the world's own ~0.5 KB — most of it the field mesh's room for every chunk's
  worst case (meshVerts 103 MB, meshIndices 77) and instance lists sized for every interval of every column (56 MB).
  The mesh now takes pages from a pool for what's built and draws through one shared quad index buffer; the
  instance lists start small and grow. **Both on in this branch** (our call: measured the same frame times and look,
  half the memory; `?meshpool=0`, `?instgrow=0` give the old layout to compare on the phone). The view-shaped window
  is an experiment (`?winh=`: rows other than the side, fixed at load) — it only pays when the view looks along the
  long axis, so the real one has to turn with the view (BACKLOG WM5).

## 2026-10-27 — round 91 (session 5, `phonecam`) — names on the map, a compass, the edge of the land

- The user, on the phone at the atlas level: "I think the map needs to show you names of place and a directional
  compas for the way your are facing. I notice that I easily hit the edge of the loaded ground"
- → The atlas map names places with the world wiki's own names (the GM's: continents, regions, seas and lakes,
  settlements), fewer as it zooms out; the player's dot has a wedge the way the view faces and the view's footprint.
  A compass on the game view (over the turn buttons) points the map's north; **a tap on it faces north** (our call:
  the map-app habit; a turn step after it goes back onto the sixths). **North is the map's up, world −y, and the map
  is now drawn as the world is seen from above** (our call: it was the world's mirror image — world +x to the right
  of north — which a compass would have made plain: a town on the screen's right was on the map's left).
  The edge: see DEVLOG round 91 (measured, then the slide made to follow the camera's motion).

## 2026-10-27 — round 90 (session 5, `phonecam`) — more of the atlas on the phone, and turning the view

- The user, on the phone at the atlas level in sandbox mode: "For the atlas in sandbox mode on the phone the can we
  increase the range of tiles that load and add a button or bar to rotate the camera?"
- And: "Maybe We can prioritize tiles close to the center of the screen but load others late? And have a setting for
  how far out it will build?"
- → The streamed window's side is a range setting (bottom-left button: 256 / 320 / 384 cells; kept per viewer, `?win=`
  wins), the phone tier's default wider by measurement (DEVLOG round 90); a slide's regions are made and written
  nearest the camera first (the far ends of the strip a tile a frame after). The view turns again on the atlas
  level — ↺ ↻ (a tap a sixth of a turn, eased; held, it turns on), Q / E — reversing the 2026-10-07 removal there
  at the user's ask (the cutaway's large-obstacle turn, round 82, was the first exception).

## 2026-10-27 — round 91 (session 5, `places`) — lakes and settlements merged; paths, people with ids

- "Lakes look good!" → `lakes` merged into `places`.
- "Settlements look decent but I think we should add paths between buildings and resources we could even run
  agents to find heavily trafficked paths if needed but I think that's all good for the Todo. Updating them when
  on paths and just moving between known locations should be even cheaper. I would probably give them an id and
  some sort of serialization so we can let players talk to anyone and introduce characters that way."
  → `settlements` merged; ST14-ST16.
- The falling rock (round 88's collapse work) is the one the user is "most concerned about" — to test next.

## 2026-10-27 — round 90 (session 5, `lakes`) — the atlas owns its lakes

- The user, on BACKLOG W2 (a table river held over a hollow, its water standing with no banks), verbatim: "For the
  rivers why does the river height lie above the dip? Is it because the river exits going higher? If so can we
  compute that the region is flooded at the atlas level?"
- → Yes: rivers.ts's priority flood fills every hollow to the height it spills out at, and a river's level is
  that filled level; only the river's own columns had it, so its water stood over the rest of the hollow. Now the
  atlas keeps each filled hollow deep and wet enough as a lake (its level the spill height, its outlet, the rivers
  in and out), named in the wiki, drawn on the map and in the far rings, and the region generator realises it on
  arrival: the basin filled to the level and held still, its shore a bank over the level (DEVLOG round 90).

## 2026-10-27 — round 88 (session 5, `collapse`) — no floating rock

- The user, testing on the phone, verbatim: "The collapse code render looks much better! It still fails to make
  some unsupported structures wake up and fall though. So worth testing on a wider column and seeing if only parts
  of it fall."
- And: "I also, think we can do even more with the collapse code but first step is fixing the floating rocks. We
  can work on making them more physics enabled as future work".
- → After any edit, every run with no support path to the ground falls, in full: a column's runs are its touching
  intervals of every material (not the rock's alone), a hanging piece is followed to its end, structures (concrete
  and the rest) cut by the break tool, a dig or a meteor fall the same way as rock (not woken into physics bodies);
  the ground truth (a flood from the ground) is what the tests count. Toppling and more physics: later (BACKLOG
  C4, C5, C7).

## 2026-10-27 — round 88 (session 5, `seawall`) — a wall of water by the sea

- The user, on the phone at the atlas level (the phone's defaults: hybrid, rivers=table, simcull): "I did find what
  looks like a bug with sea level where I saw a steep wall of water." → found and fixed (DEVLOG round 88, seawall):
  the sea's columns cut off under a raised window floor came in dry and drained whatever ran in; they now hold the
  sea from the floor up to its level. A second wall (a table river held over a macro hollow) is a judgement call,
  BACKLOG W2.
## 2026-10-27 — round 89 (session 5, `settlements`) — the first jobs; settlements as a field; quarries

- The user, verbatim: "We have the flow field based agents right? I'm curious to see how they navigate a settlement
  and look when working. I think quarry and felling trees, hauling and building make sense as the first jobs (maybe
  farming and houses to spawn more agents?) I think vegetation and settlements should work similarly actually. Both
  are fields with intensity and maybe some material (different biomes or settlement styles) and sensitive to
  conditions on the map grow and spread. Settlements along rivers and near resources make sense and hopefully
  quarries and mines can be built into the ground/hills in ways that look cool."
- → First jobs: quarrying (the ground taken exactly and heaped), felling real trees (logs heaped), hauling from the
  heaps and building a house block by block; farming feeds growth; a finished house brings more people. A work pose
  (bent to a tool) so working reads. A settlement is a growth field (intensity + style, suitability from the land,
  water and resources; the ecology pass's shape, src/settle/field.ts) realised on its grids where it's strong, and
  growing in play as it's fed. Quarries: terraced pits with a ramp and a crane, or adits timbered into hillsides,
  with spoil heaps.

## 2026-10-27 — round 88 (session 5, `settlements`) — settlements with agents working round them

- The user, verbatim: "I would like to see settlements with agents working around them".
- (Round 83: settlements first, agents that are workers or hostile, "the settlements at least use the same data
  structure we plan to expose to the city management game"; round 85: overlay grids — "irregular grids like
  townscaper or build voronoi on height contours for modern or use radial sets like the game bulwark".)
- → Branch `settlements`: every atlas site a Settlement record (settlement.ts) with a civ profile, districts on the
  four grid styles, buildings as recipe Instances realised as voxels when the land arrives; workers and guards as
  units (the `Units` contract, runstory's, implemented on the GPU agents) walking their rounds near the player;
  raiders' camps whose raids the guards meet.

## 2026-10-26 — round 87 (session 5, `collapse`) — the collapse on a real tower

- The user, testing `collapse` on the phone: "Waterfalls and the meteor look fantastic! However, the collapse
  didn't work for me on mobile at all. I was able to completely destroy the base of a tower and it stayed
  standing (it might have been taller than one cell though)".
- And: "Why do cells matter here? Shouldn't we care only about columns?" → the rock's limits count runs and
  columns, not cells (fracture.ts MAX_PIECE / MAX_FLOOD in runs; a piece too small to fall crumbles rather than
  staying); a piece is never held for being big or for going on above the window.


## 2026-10-26 — round 86 (session 5, `collapse`) — rock collapse and meteors, tested on the phone

- The user, verbatim: "The rock collapsing seems very broken. There is a large lag from a meteor to when the
  material is destroyed (maybe intentional and it is melting?) but I would expect it to be like a delete with a
  shockwave that makes the nearby material melt as magma and glow. The actual collum has a long delay and then
  converts to voxels before collapsing. I strongly recommend we simulate as voxels but split the mesh and have
  the rock column fall and just weight vertices to voxels (although rock I don't expect to flex only crumble).
  But performance is now very very good! Totally fixed on mobile"
- And: "Oh it should also probably make a big cloud of dust for the deleted material and maybe sparks that fly
  with the shockwave."
- → A meteor is a delete: the bowl gone the next tick, its chunks meshed that frame, with a flash, a shockwave
  ring of dust and embers, a dust cloud sized to what was taken, and the rim melted to lava that glows and cools
  to basalt. What it undercut is judged at once. Pieces fall in the columns' own format (the user's round-83
  question, "is there a reason we don't use the column format for all the voxel based free bodies"): meshed as
  the ground is, split from it; rigid while whole, crumbling at the foot where they land. Kept from round 83:
  columns, not cells; supported from below stands; flood only for laterally supported runs; only the woken
  columns; islands fall; the boundary anchored; stronger materials don't break. Still open: toppling spires,
  the weight idea (a hanging piece's mass against its contact area × strength).


## 2026-10-26 — round 87 (session 5, `places`) — the second phone test

- "Waterfalls and the meteor look fantastic! However, the collapse didn't work for me on mobile at all. I was able to
  completely destroy the base of a tower and it stayed standing (it might have been taller than one cell though)".
  The flow model is merged into places (still behind `?flow=1`). The meteor stays on `collapse` until the tower bug
  is fixed there.
- The hybrid's storms (heightfield chunks drawn with the voxels' look, storms across the window): "Riding is smooth
  enough. It does get worse under the storm but I think acceptably for now. I would not pursue it further yet."
  Merged; its storm cost is left as it is.

## 2026-10-26 — round 86 (session 5, `places`) — the phone test: rivers, falls, collapse

- **Performance:** "performance is now very very good! Totally fixed on mobile" (the hybrid by default on the phone tier).
- **Rivers:** "the rivers look good!" Merged; `rivers=table` is the atlas level's default.
- **Storms on the hybrid** (branch `hybrid`): "the surface flow was also visually really nice and I would like to verify
  that still looks good" — with the hybrid, a storm's wetting and sheet flow stopped at the voxel island round the
  focus (the heightfield chunks flat olive beyond it, a square patch, ponds ending at its edge). The phone's speed is to
  be kept ("performance is now very very good!").
- **Falls** (branch `flow`): "The waterfalls move way way too fast at 1x and visually it doesn't look as good as the old
  approach or the sand particles which look fantastic."
- **Rock collapse:** "The rock collapsing seems very broken. There is a large lag from a meteor to when the material is
  destroyed (maybe intentional and it is melting?) but I would expect it to be like a delete with a shockwave that
  makes the nearby material melt as magma and glow. The actual collum has a long delay and then converts to voxels
  before collapsing. I strongly recommend we simulate as voxels but split the mesh and have the rock column fall and
  just weight vertices to voxels (although rock I don't expect to flex only crumble)." Then: "it should also probably
  make a big cloud of dust for the deleted material and maybe sparks that fly with the shockwave." (branch `collapse`)

## 2026-10-26 — round 86 (`flow`, on the phone) — falls at their own pace, a sheet not columns

- "The waterfalls move way way too fast at 1x and visually it doesn't look as good as the old approach or the
  sand particles which look fantastic."
- "The waterfall trajectory looks decent by the way it's just that the columns have gaps and the rendering
  isn't great." (Keep the arc; a continuous sheet along it, no holes between cells.)
- (On the `rivers` branch: "the rivers look good!")

## 2026-10-26 — round 84 (session 5, `flow`) — one model of material flow, steady state frozen

- "I thought the water and loose materials had essentially the same simulation but with 0 angle of repose
  for water? It doesn't have to work that way but a unified model of material flow would be great for
  waterfalls emerging from underground streams or lava flows." "It would also ideally let us compute a
  water fall that actually arcs out (steady flow from column to column so that it makes an arc)."
- "The unified system should also support a steady state. Let's make it so we can freeze the actual
  simulation and just show the animation of sand endlessly spilling out of a basin. Think flux. As long as
  our section has material going in matching material out it is in steady state and we only need to find
  that again when we perturb it."
- "The idea is that solids can use columns to cheaply compute collapse and fracture in the vertical
  direction. Then sleep like any other physics system. The water and loose materials can sit in intervals on
  top of that and then simulate flow but we treat steady state flow as sleeping."
- "Water and loose materials may appear along multiple intervals in a column but the update rules should be
  fairly simple. Think noita physics which just checks for adjacent emptiness and moves pixels over. We are
  just doing this in a compressed column space and adding in velocity. The goal is plausibility and
  spectacle not realism."
- "We can have a tolerance and decide when we are close enough to steady state to freeze and treat it as an
  animation only. The goal here is to have the generator make things start in steady state and the
  simulation can then take over until it finds another near steady state then freeze things."
- "Do we use the flux to just adjust steady state for a region? Like we could keep the flow proportional and
  then zero out when they get too low."
## 2026-10-26 — round 86 (session 5, `places`) — the phone test: rivers, falls, collapse

- **Performance:** "performance is now very very good! Totally fixed on mobile" (the hybrid by default on the phone tier).
- **Rivers:** "the rivers look good!" Merged; `rivers=table` is the atlas level's default.
- **Falls** (branch `flow`): "The waterfalls move way way too fast at 1x and visually it doesn't look as good as the old
  approach or the sand particles which look fantastic."
- **Rock collapse:** "The rock collapsing seems very broken. There is a large lag from a meteor to when the material is
  destroyed (maybe intentional and it is melting?) but I would expect it to be like a delete with a shockwave that
  makes the nearby material melt as magma and glow. The actual collum has a long delay and then converts to voxels
  before collapsing. I strongly recommend we simulate as voxels but split the mesh and have the rock column fall and
  just weight vertices to voxels (although rock I don't expect to flex only crumble)." Then: "it should also probably
  make a big cloud of dust for the deleted material and maybe sparks that fly with the shockwave." (branch `collapse`)

## 2026-10-26 — round 85 (session 5, `places`) — recipes, civilizations, legacy; diplomacy; grids

- **Recipe-driven civilizations and legacy.** "Units, items, vehicles, buildings, and even civilizations are
  compositions of reusable ingredients, defined through a shared, data-driven recipe system." A knight is a
  person + training + armour + a mount, and the mount can be a horse or a hoverbike ("a medieval hover knight");
  a mech can take a bow with compatible controls; a furnace, a reactor or a magic stone can satisfy a power
  requirement "with different capabilities and consequences"; buildings (housing, hospitals, universities,
  factories, communes) come from combinations of structures, facilities, resources and functions; adaptive
  reuse ("a primitive civilization might convert an ancient ruined megastructure into apartments").
- Resources and artifacts exist physically; units mine, excavate, salvage, manufacture, trade and combine them.
  "Possessing technology and knowing how to reproduce it are distinct." Destroyed buildings, abandoned
  equipment, fallen civilizations and past runs all feed the future economy: Explore → Extract → Combine →
  Deploy → Leave behind → Rediscover.
- Materials keep physical and visual properties (copper's patina, red steel, local stone and wood shape
  equipment and architecture). Civilizations have parameterised technology, cultural preferences,
  architectural styles and production choices; their look follows geography, resources, history and
  technology, "rather than an arbitrary faction skin".
- **For now the data model only**, not editors or animation: (1) recipes, (2) instances (composition, condition,
  ownership, provenance), (3) derived capabilities as separate rules, (4) civilization profiles, (5)
  presentation later from the same data. "Minimal, extensible, and shared across entity types. Avoid
  hardcoding every possible combination." → src/api/contracts/recipe.ts, compose.ts.
- **Grids.** "Overlay grids for our cities": irregular grids like Townscaper, Voronoi on height contours for
  modern, radial sets like Bulwark — "interesting looking and varied." → settlement.ts `SettlementGrid`.
- **Diplomacy** "should work by holding the history of factions and individual interactions like rimworld so
  they can come up in dialog. It should also have more than peace or war it should have land and mineral
  rights and trade agreements." → src/api/contracts/diplomacy.ts.
- **The simulation's dispatches:** "only simulate things that need it and the whole point of the laminar flows
  (steady state) and scalar drop is it limits how long we need to simulate and lets us cache simulation
  results" — cutting the dispatches over asleep land approved (branch `simcull`).
- **Hybrid:** "Hybrid is awesome and definitely should be merged!"

## 2026-10-26 — round 83 (session 5, `places`) — the why: an engine for legacy games

- Reclaimed began as an atmospheric sandbox (wind helping nature regrow; satisfying floods and wind that
  reacts to the landscape). Since the atlas it has been "an engine for legacy games": roguelike runs where
  failure and death are always possible and choices leave a lasting, visible impact.
- Built or prototyped: a detailed terrain generator, touch controllers, streaming, physics and destruction,
  a streaming build fast enough on mobile. Missing: camera polish, dialogs, unit and item generators, a full
  build mode for places, a story framework for the GM, room-based key/door generation.
- Erosion, weather, water and fracture make the world feel alive, but only some need run in play; the rest
  can be generated in response to story events or between runs. Agents that work, build and shape terrain
  are to be brought out. "All that matters is the illusion of a living world. We can and should take
  shortcuts that keep things fast and make them more compelling."
- Atlas-changing events to support: a region sinking into the sea, a volcano burying a city in ash, a forest
  overgrowing ruins, freezing over, an ever-storm, eternal shadow, the dead rising, factions turning
  friendly or hostile.
- "I would rather orchestrate and plan these systems in parallel and abstract them behind an API so we can
  iterate and improve them all across multiple sessions. Fixing the performance and quality of the fluid
  simulation or destruction shouldn't fundamentally matter to dialogue or the atlas updates." → docs/SYSTEMS.md.
- The order: the contracts first ("Yes"); then dialogue and basic cameras "so we have a way to communicate
  what is going on"; a GM — for now a subagent with GM context and tools — takes the world state wiki and
  offline writes a session story as data (locations, dialogues, objectives, world effects); dialogue and
  settlements first, agents as workers or hostile, settlements in the data structure the city management
  game will use; the user's ideas for items, units and diplomacy to be talked through first, a first pass of
  their data in play before heroes or their stories.
- The perf ceiling (branch `ceiling`, the heightfield alone) on the phone: "The performance was solid and very
  usable." A hybrid to build: "Yes I think a hybrid approach makes sense to build" — the heightfield for most
  of the view, voxels only near the player and where the ground needs them (overhangs, caves, forms, edits);
  rock on steep faces (branch `hybrid`).

## 2026-10-26 — round 83 (session 5, `places`) — the puck, separate cuts, LOD

- "I think this camera is buggier than it is worth": the puck again, tracked
  differently: "surface constrained and slightly springy … track velocity in
  3d so it doesn't suddenly snap up a cliff … slide over surfaces at some
  elastic rate. For the god eye I would just make it slide along to the point
  on the surface the center of the camera is aimed at and the pick of where
  that is would depend on what is visible … the puck should slide toward the
  vertical axis the camera pick makes and that way it will go into caves
  naturally if they are there."
- The slice, the orbit and the dithering are independent mechanisms: "There
  should be an API to set certain surfaces or 3d points as ditherable and we
  should not have the puck be one."
- "Camera orbit actually works well but it feels weird that it is not
  continuous. I want it to move more smoothly."
- LOD: "I want some sort of LOD so that I can zoom out and still see more of
  the map loaded … things pop in a lot right now". Heightfield rings
  (a clipmap) chosen over mipmapped voxel columns; on `places`.
- The cameras, from the hoverbike's playtest (relayed by its session): the
  chase view and over-the-shoulder (the perspective camera) both beat the
  Puck; the cutaway's dither and turning work well ("they love the
  cliffs"); over the shoulder the far land's LOD looks bad. The chase view
  settles within 30° of behind the bike (springy past 30°, firmer past
  45°) so a bend doesn't hide a dead end: `Orbit.prefer`.
- The giant crystals should look faceted, drawn as meshes like the rest of
  the terrain rather than see-through boxes column by column (the user's
  suggestion, via the hoverbike).
- The perf branch on the phone: "crushing it. About 16ms for p95!"
  (deferred, lite=1, settle=0, inplace=1, sleepmore=1).
- Rock falls (the hoverbike's playtest: undercut rock left floating): "Islands
  + weak overhangs", what breaks free falls as a body. "If things are breaking
  just make a material that is stronger so they don't break" (bedrock). "Make
  sure to get the boundary correct and assume it is firmly anchored there."
  "Can rock still tip and fall? … I want to topple spires of stone."
- Performance is "sufficient for now"; the perf agent goes on in the
  background (lazy caves); the focus is usability and features.
- Nothing is simulated on arrival: "all generators make a steady state so when
  we arrive nothing is simulated until the player interacts with it or the
  session otherwise requests it to unfreeze". The water: "use SDF for the
  water to make waves from large bodies come into the shore"; "rivers should
  flow downstream and water in the ocean should be waves coming into the
  shore".
- The world's physics, layered (the user): "solids can use columns to cheaply
  compute collapse and fracture in the vertical direction. Then sleep like
  any other physics system. The water and loose materials can sit in
  intervals on top of that and then simulate flow but we treat steady state
  flow as sleeping." A unified flow for water, loose ground and lava ("a
  unified model of material flow would be great for waterfalls emerging from
  underground streams or lava flows"; "a water fall that actually arcs out");
  steady flow frozen: "show the animation of sand endlessly spilling out of a
  basin. Think flux. As long as our section has material going in matching
  material out it is in steady state and we only need to find that again
  when we perturb it." The rules simple: "Water and loose materials may
  appear along multiple intervals in a column but the update rules should be
  fairly simple. Think noita physics which just checks for adjacent
  emptiness and moves pixels over. We are just doing this in a compressed
  column space and adding in velocity. The goal is plausibility and
  spectacle not realism." Near enough is steady: "we can have a tolerance and
  decide when we are close enough to steady state to freeze and treat it as
  an animation only. The goal here is to have the generator make things start
  in steady state and the simulation can then take over until it finds
  another near steady state then freeze things." Rivers: the atlas's watersheds and their flow as a
  function of dryness precomputed; the unperturbed basin a steady state, its
  flow "strictly a render artifact computed at the atlas level".
- What the sim must do (P11): water's steady state is cached, so no tick is
  needed most of the time: "run simulation on demand and cache when it has
  run for a bit and localize real simulation to player actions."
  Water still looks like it runs: "Water should still appear to run and not
  sleep … Freeze the current flow and just stop updating the depths so it
  looks like it is flowing but is just a rendering trick."
  The storm too: "It can update less frequently but render flow. This will
  make it look like it's at a steady state."
- "We don't need to simulate a map cell we stream." Generated land comes in
  settled; "sediment that looks unrealistic or bad placement should be
  fixed in the cheap generator."
- The wind field stays simulated: "one of the most satisfying things to see
  your movement cause things go away in reaction … you may not need high
  fidelity simulation but the way wind moves is the coolest thing in the
  simulation."
- "Simulation can absolutely be 30 Hz or even 15 probably." Gradual fields
  (moisture, contamination, wilt, climate, ecology) "far less frequent.
  Every second or more apart."
## 2026-10-26 — round 83 (session 5, `perfopt`) — cutting the simulation's cost

The user, on what the simulation must cost (each to be tried behind a URL
flag on `perfopt` and A/B'd on the phone):

- **Tick rate:** "Simulation can absolutely be 30 Hz or even 15 probably."
  Systems that use per-tick constants rather than dt must still run at the
  same speed in world time (water, fire, ecology, …).
- **Streamed land arrives settled:** "Generated land should come in
  settled"; "We don't need to simulate a map cell we stream." A slide's new
  chunks don't wake. Where streamed land looks wrong unsettled (sediment,
  placement, water not at rest), "sediment that looks unrealistic or bad
  placement should be fixed in the cheap generator" — not by simulating.
- **Water steady state:** "steady state for water flow being something you
  can cache so no tick is necessary most of the time. We can then run
  simulation on demand and cache when it has run for a bit and localize
  real simulation to player actions." Water and flux simulate only where
  something disturbed them (an edit, an event, rain or a storm), then
  settle and sleep; generated rivers and seas arrive at rest.
- **Gradual fields** (moisture, contamination, wilt, climate, ecology and
  the like) "can be far less frequent. Every second or more apart."
- **Wind** stays simulated: "one of the most satisfying things to see your
  movement cause things go away in reaction … the way wind moves is the
  coolest thing in the simulation." Lower fidelity is fine (a coarser grid,
  a lower rate) but it must still react visibly to the player's movement —
  not replaced with noise.
- **Water, corrected:** "Water should still appear to run and not sleep. What
  I'm saying is we don't need to keep simulating it. Freeze the current flow
  and just stop updating the depths so it looks like it is flowing but is
  just a rendering trick." Real water simulation resumes only where something
  disturbs it (an edit, an event, rain, the player). "You can use this trick
  in the storm too. It can update less frequently but render flow." The wind
  field likewise where it isn't reacting to the player.
- **Every animated flow:** "Can we generalize the flows to water magma and
  sediment? Any animated flow can decrease the ticks and cache the flow state
  and show animated flow hopefully and we can tune the actual update
  frequency based on what looks convincing and good." One mechanism, each
  flow's rate its own flag, full rate only where disturbed.
- **Floating sections:** "The terrain has floating sections that don't
  settle" (with the settle flags): streamed columns and forms must not
  contain floating pieces — the generator's job, not a wake.
- **The phone:** "Deferred shading helped a lot on my phone." It stays the
  default.
- **The phone, later:** "The current iteration of perf branch is crushing
  it. About 16ms for p95!" — /perfopt/ with `lite=1&settle=0&inplace=1&
  sleepmore=1` (the deferred terrain the default). Plan: these become the
  phone tier's defaults when perfopt is merged.

## 2026-10-26 — round 82 (session 5, `places`) — where the phone's frame goes

- The phone: leaving out the terrain mesh and the shadows is 20–40 % off the
  p95 frames; with `?skip=render` p95 falls to 16 ms, the same as p50 — the
  stutter is the graphics, not streaming or generation.
- Play happens mostly at points of interest; travel between them is shown on
  the overworld map, which gives time to load them. Streaming stays (the
  world should feel open), but its cost can be hidden that way.
- Direction: render the terrain to isometric tiles (depth, normal,
  material) and draw the characters and particles over them (V22).
- The sim isn't to be skipped; if it costs too much, wake even less of it.
- Performance is tabled on `places` for the camera; it goes on a branch of
  its own (cut from `places`), a long profiling session trying things for the
  user to test on the phone — baked isometric tiles, cached chunks, a cheaper
  pixel shader — merged back where it wins.
- The character always seen (V21): "Imagine the camera as puck following
  gravity and sliding along a surface. When that surface goes below other
  surfaces I think we want to dither and show the surface". "If you are
  inside a cave that opens onto a beach I expect to see the beach and cave
  interior not the cliffs above." "Dithering or an outline make sense for
  small obstacles but very large obstacles probably should rotate the
  camera to an angle that isn't occluded and being in a lower layer should
  probably just skip rendering the layers above." So: under a roof, a slice
  (nothing over the layer drawn); a small obstacle in front, a dithered
  hole; a large one, the view turns to the nearest clear angle. The view's
  rotation (removed 2026-10-07) comes back for that case only — the user
  knows it looks worse isometric and invalidates a baked tile.

## 2026-10-25 — round 81 (session 5, `places`) — columns as intervals, not a walk

- "Do we need to walk every cell of the column? The whole point of the interval storage is that in theory we
  know every interesting boundary without a 3d texture or voxels. The only complication I see is the 3d
  noise for the caves. Can we do it cheaper? Can we do 2d noise with two thresholds then for every point
  within our threshold then vary the height of those caves with noise and optionally have layers for more
  3D caves? It seems like our meshing could also do this." — agreed (the caves' look changes).
- "Anything with a field we could treat more like an asset we can compute async then add or subtract as
  intervals … if they want truly 3D caves we can compute intervals for a 3D cave async and then interval
  subtract … we can subtract structures which is great for things like digging quarries" (P8).
- Later passes: "cool stalagtites and stalagmites and other cave features … along with our skylights,
  waterfalls, corpuscular rays and crystals" (V19).
- Loose layers merged when a column runs out of slots: "I'm not that concerned about losing the loose
  layers … Usually the player sees the top two or three when surfaces are cut."

## 2026-10-25 — round 80 (session 5, `places`) — the hoverbike on the atlas; a phone's frame

- Before rooms and paths: "make the hoverbike character controller session able to use the new terrain,
  atlas and streaming but I'm concerned about the performance on my phone". Freezing, as rigid bodies go to
  rest: "unfreezing selectively based on player interactions. We can hopefully still do the wind and
  particles. Water and magma I figure we can freeze into a flow steady state that doesn't actually add or
  subtract material so a basin can indefinitely spill water or magma unless we unfreeze it. Then rendering
  can hopefully be sped up as just lightning, particles, unit layers and anything rotating relative to the
  camera. I just want to see if we can get a solid frame rate on my phone while running around and
  streaming the map ahead of the character." Agreed, in order: profile on the phone → slides spread over
  frames, look-ahead by speed → sleep/wake with frozen water and lava → instances and shadows cached for
  what sleeps → the hoverbike on the atlas (BACKLOG P1–P5).
- The hoverbike gets it through the World API (its session keeps its controller): "API for their session".
- "I would like the other agent to make a playable branch that starts on the atlas map with streaming so I
  can test it. I suspect we need to further improve performance but let me fly it live (I also think the
  camera will be zoomed in more)."
- Its camera: a fixed angle that follows — "Right now it is fixed but zooms out with speed which looks great"
  (baked tiles, V14, possible later).

## 2026-10-25 — round 79 (session 5, `places`) — cliffs: ravines, steps, talus; facet fields

- "Why are cliffs limited to one cell? Can't we go vertical? I mean we may want to limit for draw but
  worth considering." (The streamed window is 248 high, an 8-bit z: a mesa taller than that is cut at
  the window's top or bottom and the window slides a tier — BACKLOG V17.)
- "The boundary should probably use ridge noise to cut ravines into the border so it's not so flat and
  there are places from the ground to run between the cliffs. Plus let's make the cliffs more
  interesting with butes that stick out and intermediary ledges and overhangs." "I would have the shape
  at the border carve in with ridge noise so there are ravines at the cliff wall."
- "I would also pile up sand or dirt along the base and then have rocks in it too … cliffs erode and
  debris collects and slopes at the base. You can use SDF and noise."
- "The height at the top and bottom should have noise and fade up to the full height and it should have
  more step variety in height on the cliffs."
- "Then let's also think about dynamic region features like flash floods in ravines or dust storms in
  deserts" (V16).
- "For the crystals I was imagining more like large voronoi facets raised slightly deeper in rather than
  a single large crystal but both should be possible."
- Occlusion and seeing the cliff's back from the fixed view stay V5 (high priority).
- On the window's height: "Why not stream vertical identical to lateral in the streaming? … A window is a
  3d coordinate and you are intersecting the interval and generating the mesh to render right? Why not
  also do what with the 3d cell above the current cell? It will just render different intervals of the
  same columns right?" — agreed: the band outside the window, drawn, frozen (V17). Then the region
  generator (V2): "Yes a then b".
- "For some images it would be cool to stream in a few more blocks out to see more of the terrain at a
  time (top down won't need that the same way but it's nice for debugging even if too slow for mobile)"
  (V18, `?win=`).
- "Multiple tiers as a function of distance with some noise. So that it's more stepped but with variation in
  the height of those steps … an SDF based shelf with voronoi cells offset I think would look even better."
  "Those look fantastic!"
- Caves: "I think their frequency is a bit higher than I imagined. I would try a 2-8x reduction in noise
  frequency to get bigger caves" (4×: caveScale 40 → 160, their height with it).
- Coasts: "They should drop off more so the water is deeper." Then (the sea had drained out of the window):
  "Ah that may have been the whole issue! I'm not even sure if the deeper dropoff at the coast was needed"
  — "I think slightly gentler maybe? But low priority."
- Cross sections: "the layers in the cross section look more blotchy (the surface looks great). I would expect
  it to be biased heavily in the x,y plane so it looks more sheet like strata rather than blotches."
- Caves: "The caves look so cool! I would bias to having skylights with gravel and sand at the bottom or
  springs that make underground waterfalls." "Underground caves are going to need special lighting tweaks
  … skylights and corpuscular rays and waterfalls and magma and make plants grow in light and maybe add
  glowing crystals … it will look cool to have cities underground and above eventually" (V19).
- Paving brick, bridges and lifts concrete for now (readable: built, drawn sharp) — the materials by
  era and style are the user's to choose (V8's styles).
- Then: "I would maybe use voronoi and then make some along the border drop with noise so the cliff has
  an irregular top with sediment at different points … I do think more varied height smaller voronoi
  cells along the cliff will make it look more like a cliff." And "we can optionally make a slope if we
  want it to be traversable of sand or dirt or gravel and sdf from flat to mesa height and we can have
  some voronoi cells in that transition be stone up to the full height … like a messa that has eroded to
  make a ramp." "The screens here look decent though!"

## 2026-10-25 — rounds 76–78 (session 5, `places`) — the game's direction

- Round 76 (step back): "I love the way the simulation makes the world feel responsive. I think the lo fi
  graphics are fun but I find I want a bit more readability and for better animations and possibly
  fidelity on characters and fauna and flora." Biggest frustrations: "tiny chunks of rock sticking up out
  of the ground can frustratingly block your character movement and dust or the fixed perspective can
  occlude the character." Mobile: "squeeze blood from stone and try to get high frame rates on mobile"
  with static composition for what's at rest. "I suspect in gameplay we want an overmap and then places
  the character can go rather than make them traverse the world." The game: a roguelite; heroes from a
  library of roles; story and objectives LLM-generated from a persistent world wiki; mixed mechanics per
  role; the world shows the history of play.
- Round 77: target the user's Pixel 9. Readability first, "and that includes level generation that
  actually makes regions of low and high detail and creates regions that are fun for the various
  characters to traverse." The atlas as "a readable fantasy map (or maybe have multiple styles depending
  on the state of the world)". The heightmaps "are noisy and not well suited to a top down perspective
  but I think they could be." Bulwark's cliffside cities (radial grids tied to iso lines, long straight
  supported bridges, lifts, ramps). A mix of vertical and horizontal areas; busy and calm places; rooms
  calmer or with sparse impassable footprints. Layers for history: toppled monuments, buried cities,
  repurposed megastructures. Diplomacy and procedural units and structures ideas to come.
- Round 78 (the two scales, agreed): "The fractal noise is great for shapes in 2d and blocking out maps"
  — shorelines, ridges, mesas bigger than regions; other grids for superstructures; "I would use SDF to
  blend the actual heights we want. The actual heightmap can be informed by but not determined by the
  underlying noise. Think of borders here as a good candidate for the initial seeded boundaries."
  "We should be intentional and make vertical cities, ramps and roads, lifts, switchbacks, or tunnels
  intentionally stamped at the region level." Layers at the atlas scale too (a massive cave under
  mountains, tunnels). "Low frequency defined by the atlas and then the regions are higher frequency but
  with intentional rooms and paths that are low detail and traversable within the constraints of the
  macro features." Paths by dungeon layouts, slime-mold or weighted random walks. Order agreed: atlas
  macro height → region briefs and a generator → traversal check and camera; the readability items high
  priority next (BACKLOG V1–V14).
- Round 78, optimization: "a way to still have particles and wind but freeze deposits. Then we can freeze
  and cache the terrain without losing the ability to show dust and debris and we can unfreeze for player
  interactions or simulation during generation. Likewise we can freeze the flow of rivers this way"
  (V12, V13).

## 2026-10-24 — round 75 (session 5, `atlas`) — geysers, giant crystals; the far land and top-down

- "I think lava areas should have geysers that shoot out water and steam."
- "is there anyway we could add more macroscopic shapes and materials? Like
  could we have faceted crystals the size of mountains or columns of crystal
  extending into the sky at angles?"
- "what would we need to do to make the distant course detail look like it
  is more detailed so that it is less visually jarring. I expect top down
  view so it's not important but I'm curious about the limitations in terms
  of performance of this approach vs more conventional approaches." —
  answered (BACKLOG Q60), not built.
- "My plan is to focus on top down and the streaming is good for that
  (although the camera will need work)" (BACKLOG Q61).

## 2026-10-24 — round 74 (session 5, `atlas`) — tried on a phone: tighten it up

- "It looks very trippy though and I only see the local chunks (not the
  distant coarse ones) and the rendering loads weirdly (am I seeing it load
  in incrementally so I briefly see the layers underground?) either way this
  is pretty rad just very glitchy at the moment compared to the main branch
  which is fairly tight."
- Done: the land beyond the window drawn; what's built moving with a slide
  instead of being built again; fresh chunks built first.

## 2026-10-24 — round 73 (session 5, `atlas`) — trying it; rivers and lava

- "Do rivers flow from high to low? It seems like a waste to have the good
  water simulation and of use it to bake rivers in as flow from snow melt and
  just replenish the snow with storms to keep it steady state." (Q58)
- "For magma, I imagine vents could just keep pushing more out and make
  rivers that flow but I'm not sure how to make them keep their heat other
  than flow and replenish from below." (Q59)
- "I think populations is a good next step but I still have to fly all of
  this" — the user tries the atlas branch on a phone first.

## 2026-10-24 — round 72 (session 5, `atlas`) — the coarse world

- "I think the coarse columns make sense. It solves our simulation at scale
  too potentially and lets us simulate erosion, fluids, physics (maybe) at a
  large scale so we can have huge eruptions bury forests in ash or meteors
  that make craters that are many chunks. We can even extend it to agents
  and simulate stacks of agents moving and consuming, transporting resources
  or transforming land. For example, we could simulate settlements spreading
  at the coarse scale then show the settlements with individual structures
  going up at the fine scale. I think it would make the world feel alive and
  massive and less like a toy."
- Built first: the coarse world (terrain, water, loose ground, lava) with
  meteors and eruptions; settlements and agents at the coarse scale next, on
  the same pattern (BACKLOG Q57).

## 2026-10-24 — round 71 (session 5, `atlas`) — scales and representations (discussion)

- "Could we use coarse columns at the atlas scale and then refine them with
  fine columns? Could we repeat this for things on the map like characters?"
- "I suppose columns make most sense on things that need fluid simulation and
  we render with meshes anyway (which looks nice). I think representations
  should be fluid and have conversions so we can do a structure as voxels for
  deformations and fracture, rigidbody meshes with control points to bend
  them or columns for interaction with fluids and powders"
- Proposed (not yet built): a pyramid of columns (restriction when land
  leaves the fine window, refinement when it comes in); the same pattern for
  characters (agents ↔ populations); one owner representation per object at
  a time with conversions and projections (BACKLOG Q55, Q56).

## 2026-10-24 — round 70 (session 5, `atlas`) — a free camera, rivers and falls

- "Is there any way to add a free fly camera to explore in 3D? That seems
  easy but probably should switch to perspective." → F toggles a free
  perspective camera (the fixed isometric view stays the default).
- "Also, how did this impact perf?" → measured against round 68 (see the
  DEVLOG).
- "it would be cool to add waterfalls or lava waterfalls" / "And rivers
  (water or lava)" → rivers from the atlas's drainage; where they drop off a
  cliff, a fall; lava rivers from the volcanic regions.
- "Oh also, thoughts on recursive enhancement of column resolution?" —
  answered, not built (BACKLOG Q54).

## 2026-10-24 — round 69 (session 5, `atlas`) — forms: terrain that plays with vertical and horizontal space

- "This is cool and I wonder if we can have even more variety? Ground with
  holes to subterranean rivers or lava flows, columns of stone, nearly
  vertical cliffs with caves carved into the walls, eventually giant flora,
  hollow tubes that extend like vasculature, rotationally symmetric curving
  spires etc. can we parameterize and generate types of terrain that are
  visually interesting and play with vertical and horizontal space
  differently?"
- Families: all four (tubes and skylights; pillars and arches; cave walls
  and spires; vascular tubes) and "a more general generator of interesting
  features. Crystal spires, spiraling spires, angled mesas etc" — one
  parameterised solid (profile, lobes or polygon, twist, lean, hollow, cap)
  covers those.
- Height: "I was suggesting that map cells themselves could stack
  vertically … the columns are used in the simulation and memory efficient"
  / "If we can stack cells vertically we can have multiple to make really
  tall cliffs" → the window slides in z as it does sideways (one live 256-
  tall-at-most window; what's above and below it kept, as frozen regions
  are). "All tiers live" was the bigger alternative, not chosen.
- "Wouldn't a really vertical one basically have all air on one side and a
  wall with intervals that maybe have caves in them?" — yes: that is how the
  columns hold it (a tall column beside a low one; alcoves are air intervals
  in the wall's columns by its face).
- Physics: full — "Just have different materials if you want it to stand
  make a stronger material". Forms are judged when they arrive like anything
  built (what can't stand falls); what must stand is made of a material of
  strength 1 (terrain: stone, basalt, obsidian), what may fall of a weaker
  one (sandstone, crystal, ice, coral, flesh).

## 2026-10-24 — round 68 (session 5, `atlas`) — screens, and seams

- "Ok this looks awesome please proceed to restart and then show me some
  screens. I love the variety here and I'm curious to see it in action.
  Some screens don't look super seamless though"

## 2026-10-24 — round 67 (session 5, `atlas`) — a world map to stream from

The user's idea (in their words, shortened): a coarse map made first —
Voronoi and fractal noise as the base, ridge noise for mountains, a bank of
tiling scalar textures (wallpaper groups, fractals, cellular automata, …)
mixed into the heightmaps; SDF and JFA for blending; land and water from
thresholded fractal noise, SDF blends for drops, mountains, craters,
ravines; faults from two thresholds on one noise with mountains blended in
by SDF; GPU flood fill to partition into regions, borders as cliffs or
ravines; sand and plants tied to the region and to continent and
latitude; a deep cave layer from dual-threshold noise; weird maps (flesh
with vasculature); partitions at the macro scale may become rooms. Then
the chunks are streamed from it with the region's parameters and its
boundary conditions. Asked, and answered:
- Finite or endless: "Finite although you could blend with SDF to do
  infinite it seems unnecessary". Defaults taken: finite and wrapped (a
  torus), 16k cells across, a macro texel to 8.
- Height: "If we load chunks vertically too (most will be empty air) we can
  just go arbitrarily high right? I'm ok bumping but I don't think we need
  to. Just use a sparse vertical hash for the chunks". (Columns are already
  sparse in z — a few intervals each — so air costs nothing; what caps
  height is a handful of 8- and 16-bit packings at 256: BACKLOG Q38. The
  atlas level uses 160.)
- Where: "an atlas branch off is stream although once I validate this all
  we may merge I hope you are keeping track of our threads between town
  building and streaming and world map" (BRANCHES: the stacked threads).
- Rooms: "I would just use course rules for now. Land regions can be CC to
  find continents and islands. Then islands can be partitioned and the
  faults (that was in fact what I was suggesting we do with dual
  thresholds) and voronoi regions can make the borders. We can adjust later
  with logical requests for key door mechanics etc. Don't forget that we
  also have a simulation layer already built if we want sediment and
  erosion etc. that is fine to do passes of over the overall terrain and we
  will see about using it for streaming (ideally we can cache and keep
  latency interactive)" (Q37, Q39).
- "So yes happy with your defaults please go ahead and build!"

## 2026-10-24 — round 66 (session 5, `stream`) — a streamed world

- "Do workers actually build or just a plan mode? Do we need to add
  workers?" Answered: they build (👷 sends six from the nearest pile of
  bricks or logs; the plan is what they build).
- "I think it would be cool to prototype the map streaming as I have an
  idea that involves building bigger regions (simulated at coarser detail
  or frozen)." Asked, and answered:
  - first: a live window that follows the camera, regions out of it frozen
    exactly (not simulated coarsely yet);
  - a new branch `stream` off `builder` (the town and workers come along);
  - the idea: "Towns and nature can grow but we may want to freeze them and
    then have deferred ticks or coarse ticks later. I would start frozen
    for now."

## 2026-10-24 — round 65 (session 5, `builder`) — questions; the town

- "Why is 256 a height limit with the intervals? Shouldn't they be able to
  store much higher total height?" Answered: the intervals are f32; the cap
  is the surface word's 16-bit top and zMax sizing the mesh (BACKLOG Q27).
- "How hard would it be to stream in chunks of terrain around the camera in
  3d so that the map is effectively infinite? Is it a GPU memory issue or
  just something we haven't done?" Answered: not memory, foundations
  (BACKLOG Q28).
- "Is there anything to stop a first person camera flying down and looking
  at everything up close? Acknowledging the current textures would likely
  not look very good." Answered (BACKLOG Q29).
- "Once we answer those let's proceed with townscaper."

## 2026-10-24 — round 64 (session 5, `builder`) — terrain generation, brushes, Townscaper building

- "I think it's time to improve the initial terrain generation. Then I
  think let's add the building mode." A new branch, `builder`, off agents.
- Generation, first: natural landforms (mountain ranges with ridges, mesas
  and buttes with layered strata and cliffs, canyons, hills, valleys);
  underground caves, tubes and rivers (like the crater accident: overhangs
  and cave mouths that overgrow); rivers and lakes carved into the land so
  the water settles from the start.
- "I don't actually love the sandbox tools right now. I think I want to be
  able to paint mountain ranges and mesas and have them rise from the
  ground relatively quickly under the brush." Feel: drag a line and the
  range rises along it over 1-2 s (noisy peaks and spurs); the mesa brush:
  paint an area, it rises flat-topped with cliff sides and strata; loose
  ground slides off as it rises. Painting should be more intuitive, "and
  that's one reason I want a townscraper inspired grid and building
  system". It has to play nice with terrain and dust.
- Building: you place, it appears (click cells on the irregular grid; the
  walls, roofs, stairs and arches pick themselves from the neighbours;
  pieces are real matter: dust drifts on them, they bury and crumble).
- And a plan mode: "it takes the delta of the finished thing you build and
  the current state then workers build it and use resources" — the crews
  carry bricks and logs from the piles and build the difference.

## 2026-10-24 — round 63 (session 5, `agents`) — what the agents do next: carry and throw, then dig and fell

- "I think digging and chopping trees and maybe making them into logs or
  bricks and having piles of things is a good next step. Then we can work
  on building."
- "Units can maybe carry things? That's a good first place too. Since we
  want carry and throw." So: carrying and throwing first (done, this
  round), then digging, felling (logs), making bricks and piles, then
  building (API5, API6).
- The rain spires: the user's screenshot (a phone, the hoverbike's map):
  tall narrow pillars of loose ground against a ravine wall; they think the
  sediment is "getting turned solid before it can collapse" (Q16b / Q22).

## 2026-10-23 — round 62 (session 5) — caves and overhangs: keep them

- The user, on the overhangs: "the overhangs look so cool". They made a
  deep crater with caves by accident, "like the procedural map I suggested
  with subterranean rivers or magma tubes", and overgrown "it looks
  amazing… like an artist made it". Caves, overhangs and tubes are a look
  to keep and build on (W1's tunnels and underground rivers).
- It'll be better still with the Townscaper-style settlements and ruins;
  overgrown ruins look cool (G14, API5, API6).
- Column artifacts after storms or explosions: they kind of like them, but
  they're a bug to find (BACKLOG Q22).
- The perf branch (round 61) looked good on the phone: merged into grids
  (5e24d24).

## 2026-10-23 — round 61 (session 5, `perf`) — a perf branch; the mesh by default; culling

- "Well make a branch and profile and experiment then merge in clear wins.
  I can test on mobile and validate the feel."
- "Wait I thought we were using the mesh drawing? That one looks good."
  "Can you make the default mesh": the field mesh is the default in every
  level and the world API (`?mesh=0` for prisms). The title screen's
  diorama keeps its voxels.
- "Definitely do culling it is cheap and most play is zoomed in
  significantly."

## 2026-10-23 — round 60 (session 5) — cached tiles

- "Even rendering to orthographic tiles could speed up things right? A few
  layers like terrain and units and you would have cheap renders no?"
  (BACKLOG G16.) On the sediment options (Q20): "Those all seem like
  reasonable performance improvements."

## 2026-10-23 — round 59 (session 5, `agents`; the units session, the user approving) — real reach and sight

- The height band (a target counted only within the unit's height + 2 of
  it) was bad: it let blows through a thin floor, hid a target just above
  the band, and made the lich out of reach by accident. Instead:
  - targets are chosen ignoring height;
  - a blow lands only with real reach (capsule to capsule) and line of
    sight (nothing solid between);
  - a target out of reach overhead is chased and waited for underneath;
  - targets gain a height.

## 2026-10-23 — round 58 (session 5, `agents`; the units session) — lighter on phones; bursts carried

- The hoverbike is choppy on the user's phone. Asked for a cheaper sim path
  for phones, keyed off low quality or a host option: agents' fixed cost,
  sediment at half rate or only where disturbed, climate less often.
  - Done: the agents' field sweeps follow quality (low 2, high 8).
  - Sediment at half rate is not done: it would change how it behaves (see
    the DEVLOG) and is the user's call. Climate runs every 4th tick already.
- `fx.burst` takes `vel`, so a walker's or a tank's dust trails behind it.

## 2026-10-23 — round 57 (session 5, `agents`; the units session, same principle) — units feel the wind

- Units feel the world's wind and blasts directly, ÷ mass, with a calm
  before anything moves them and a threshold before they're thrown, so
  ordinary breezes don't jostle everyone. Storms, the bike's wake, a
  jetpack's downwash and gusts push light units; the lich's storm can be
  plain wind instead of holds.

## 2026-10-23 — round 56 (session 5, `agents`; relayed by the GameplayGM units session) — physics first; mass and stun

- "Use physics wherever the sim stays stable and fast, and add a specific
  system only when a general one fails, because each specific system
  multiplies the interactions to worry about."
- So knockback is plain physics data: mass on the kind divides every force
  on a unit, hits take a `lift`, and hits, launches and lobs take a `stun`.
  The game drops its own knock and mass scaling.

## 2026-10-23 — round 55 (session 5, `physics`) — pulls shed more

- "I also think we want lose layers to shake off even more the way they do
  for the volcano": a pull's shake is now stronger and on by default.

## 2026-10-23 — round 54 (session 5, `grids`) — low quality by default; agents merged

- "Can you make the default settings the low settings so it runs better on
  mobile": the low tier is the default; `?q=medium` or `?q=high` for more.
- "And please merge agents!": `agents` is merged into `grids` (so it's on
  the `grids` Pages build).

## 2026-10-23 — round 53 (session 5, `physics`) — pulls shake; locks swallow sediment

- Pulls: "pull adds material and I think it displaces things above it
  using the natural simulation and angle of repose but we may want to
  shake them off a bit too." (A pull now shakes the loose ground it lifts:
  it slips at a lower angle for a while.)
- Locked regions (API3): "We may also experiment with sediment just
  disappearing when it enters a locked region so we don't get artifacts at
  the border."

## 2026-10-23 — round 52 (session 5, `physics`) — cover on props; agents

- A snow-covered variant of things; the same can work for sand and dust on
  props, which is desirable.
- A bigger plan (proposed, not yet started): simulation layers for agents
  that build and mine. Peel the intervals into pathable surfaces (cull tiny
  overlapping layers such as on a jagged cliff, or peel perpendicular for
  such surfaces); an irregular grid like Townscaper for units to dig out
  land or build structures; units as state-driven groups sharing flow fields
  or paths recomputed as needed, so most behaviour is following a gradient;
  units carry material, flee, attack, fell trees and build. Procedural
  character editors and animations later; simple for now. Many editors and
  games are meant to use this layer (like the action game with the hover
  bike). "Don't be dogmatic about following my design." My reply (the
  surfaces straight from the intervals, the irregular grid for building and
  the columns for digging, fields per goal shared by groups, units on the
  GPU like particles, jobs as fields) awaits their answers on branch, the
  units session's pathing, and scale: BACKLOG A1.
- The user's go-ahead (relayed by the units session) for places step 1.
- On the agents layer: "Yes please make agents off of grids and let's do
  it! I'm excited for this layer." (branch `agents`, docs/AGENTS.md)
- Controllers and world authoring (the user's design notes, relayed by the
  units session).
  - The world editor is its own module: a runtime for interacting with the
    simulation and data layers Reclaimed owns. It is in neither Reclaimed
    nor the hoverbike; it lives in GameplayGM on the world API and uses
    abstractions, never internals. Reclaimed's sandbox editor stays as our
    own client, so what Reclaimed owes is editing operations in the world
    API, not an editor.
  - The asks, in the user's order (BACKLOG API2-API7):
    1. Layer pulls: grab a material layer and pull it (bedrock up through
       sand and soil, pushing through or displacing them), growing by that
       material's own noise, directional or dragged too; the same
       vocabulary for dig, pile, berm and exposing strata. Open: how
       displacement conserves mass across intervals and loose debris.
    2. Watersheds: lasting or replenishing sources (springs, rain-fed
       catchments), so rivers, tributaries and waterfalls keep flowing; a
       per-region freeze of erosion and terrain change apart from water,
       which keeps flowing over approved terrain without re-carving it (for
       authoring and for speed). Open: how locks meet flowing sediment,
       melting, explosions and edits.
    3. Simulation windows: start an event (meteor, volcano, storm, fire,
       flood, freeze, overgrowth), run it N seconds (optionally in a
       region only), keep the result.
    4. Settlements on agents: homes spawn residents, workplaces make jobs;
       a woodmill's workers fell and carry trees; a quarry's dig real stone,
       leaving a pit; a farm's clear wild growth and plant crops. The payoff
       is visible, lasting change in the world.
    5. Building: Townscaper-like placement on the structure grids, adjacency
       picking walls, roofs, doors and corners from a style set (stone,
       brick, wood, metal, glass); the editor owns the rules, Reclaimed the
       build ops and adjacency queries.
    6. A swing-start (windup) event, for the knight's parry. (Done.)
  - Later: map generation aimed at controllers' traversal and combat
    affordances (ramps for the bike, ledges for the gorilla).
- The boundary between Reclaimed and games (relayed by the units session):
  each system is a module the game layer uses; the game builds controls and
  abilities on them, and the abilities interact through the shared world
  (the bike's air blows dust because it uses the wind). Each module installs
  on its own and is absent if not installed; answers queries from a CPU
  mirror at a stated rate, in world coordinates, formats decoded on our
  side; takes commands batched per tick with caps handled inside (queue or
  merge, never thrown or silently dropped); sends events out; keeps its
  buffers and Globals private. Order: a read API for terrain, water and
  fire; wind without the cap; fx; agents; the rest as they're touched
  (docs/WORLD_API.md).
- The split: Reclaimed is the engine, the world is the game's (GameplayGM).
  The facade is a sim of a world definition the game supplies; content
  comes in as data (map plans and generation recipes, places with names and
  tags, agent kinds, plant species and biomes, climate, maybe materials),
  our defaults only where it doesn't. Reclaimed's own game (Nature, the
  reclamation score, the story rules, powers, levels) is one client, kept
  out of the core API. Persistence (snapshot and restore per place) later;
  keep it in mind for formats.
- A wind wake for things that move (the tank's dust should come only from
  its wake, lifted by our sediment and particles): built on the painted
  wind field as the swipe strokes are, since the user likes how they paint,
  carry, spread and relax — each frame the segment the mover covered,
  along its motion, capped below its speed (0.6–0.8×), in the usual breeze,
  gust and gale steps; many movers painting at once with the player's drag.
- Reclaimed is the engine for the units session's game too: its enemies
  become our agents, using our fire, wind and physics through an API we
  expose (agents work on `agents`).

## 2026-10-23 — round 51 (session 5, `physics`) — seasons; places

- Leaves should change to fall colours, with leaf particles too; grass
  should change colour in the fall as well.
- Generation is hierarchical: regions, and rooms within them. The API
  abstracts both as named places, so the runtime can mutate them — make
  storms, change the time of day, add fog, bury a place in sand, flood it,
  and so on. It can query adjacent rooms and specify connections between
  adjacent rooms, and change what is in a room: enemies, puzzles, items,
  obstacles. Some of that can be owned by the consumer (the game), but
  spawning things in a place, and its terrain, should be exposed through
  Reclaimed's API.

## 2026-10-23 — round 50 (session 5, `physics`) — map generation and new materials

The user's plan, relayed by the GameplayGM units session (its words,
summarised; the split between Reclaimed and the game is that session's
guess, agreed here):

- Generation in order: shape first — the map partitioned into rooms and
  halls (Poisson-disc Voronoi cells grouped into islands of 1–3, fractal
  noise thresholds — a band near 0 makes tunnels, a value a bit off 0
  islands — or boxes and halls drawn directly), borders made noisy by an
  SDF; the partition names logical regions, read by an API so an LLM game
  master can set weather and lighting per region and freeze simulation
  where appropriate. Then bedrock, its ridges and troughs shaped by the
  room blocking, noise tunnels, underground rivers of magma and water. Then
  layers of dirt, sand and dust, snow where appropriate, vegetation, then
  structures and ruins — each material its own noise or heightmap,
  blended by SDF, each a field that can be raised; editors that grab a
  layer and pull it into shape, guided by its noise. Then weathering:
  meteors, wind, storms.
- New materials: sand and dirt that animate like water when they spill and
  fall off surfaces such as collapsing buildings; a faceted transparent
  crystal (crystals and ice); snow and leaves, with particles.
- Navigation as stacked layers, linked where heights touch; flow fields and
  AI per layer; JFA vectors to what units care about; scent trails.
- Reclaimed owns the materials, granular flow, the generation pipeline and
  its editor ops, weathering, region ids and freezing, layered nav and JFA;
  the game owns room/key-door blocking and agent behaviour. Generation,
  regions, freezing and nav wait for the game-side design (after the
  current playtest); the materials start now.

## 2026-10-22 — round 49 (session 5, `physics`) — mixed resolution, meshes

- Uniformly smaller voxels are not the answer. Resolution should vary:
  most simulation at the coarse scale, refined only where and when it is
  needed (a crack, a crumble, a small fine model).
- Meshes are welcome alongside voxels: a mesh deformed in its vertex
  shader by control points its vertices bend toward. Keep it lo-fi and
  stylized; voxels look cool, but mixed is better here. Meshes must still
  interact with the material systems and the simulation.
- Wanted: blocks that crumble and then turn to particles; things like the
  bike that break up and take damage.
- The hover bike should be about half its current size.

## 2026-10-22 — round 48 (session 5, `physics`) — after trying lava on the phone

- "OK but not great." Concrete should crumble more when it falls and be
  less elastic.
- Physics sometimes leaves material floating after a delete.
- Meteor: a smoky projectile from the sky; on impact a massive deletion
  (everything there turns to dust) and wind out in every direction.
- Volcano: far too short. It should rise out of the ground to a large
  height, then spew lava down its sides.
- Lava should be smooth like the other natural materials, not hex prisms.
  Basalt columns are fine if intended; the magma must be smooth.
- Next experiment: Reclaimed's terrain and world sim inside the phone
  action-controller project (GameplayGM iso-adventure) as a submodule (pin
  `grids`; a hover bike pushing air out and leaving a dust wake).

## 2026-10-22 — round 47 (session 5, `physics`) — air inside bodies; dust; next

- Keep the air inside a body (gaps under a table) if the cost is fine.
- Falls should kick up dust: wind when things land, and dust when they
  crumble.
- Next: the beam hitting the ground, then volcanoes — both on the same
  molten-material physics.

## 2026-10-22 — round 46 (session 5, `physics`) — proceed

- "Please proceed, this is looking really cool": next is the nature grid
  seeing the bodies (sand and water treat them as solid).

## 2026-10-22 — round 45 (session 5, `physics`) — mesh in the sandbox; merge

- The sandbox shows the field mesh (by default there; `?mesh=0` for the
  prisms). Elsewhere it stays opt-in.
- Metal a little easier to deform still; otherwise it looks great.
- Merge `physics` into `grids`.

## 2026-10-22 — round 44 (session 5, `physics`) — first try on a phone

- The brick looks great. What's already on the map didn't collapse.
- Metal is too springy and strong: it should deform and break more easily.
- The heat beam is hard to use (it's under the finger) and doesn't get
  things hot enough.
- The map's structures become physics bodies when something interacts with
  them, not all at once; past some size not everything needs to be a body.
  Keep it working well with the terrain.

## 2026-10-22 — round 43 (session 5, `physics`) — a physics playground

- The valley works better than the sandbox right now: fix the sandbox and
  iterate on it. A new branch, `physics`, cut from `grids` (it's more
  experimental). It is a playground to test destruction, and terrain for
  other games.
- Materials with properties: metal deforms like World of Goo, both
  elastically and inelastically; stone fractures into bigger pieces that
  then simulate as rigid bodies.
- Energy: be conservative on the side of losing it, never gaining it. How
  it looks matters more than not interpenetrating; an overlap crumbles to
  the non-solid version of the material (dust, gravel, sand) rather than
  being pushed out. Big things tend to crumble and collapse and rarely
  bounce; bias them down, which conveys scale. Small debris can still be
  thrown up.
- One GPU solver for every material (chosen over extending the CPU bodies).
- Destruction to play with: a heat beam that cuts (first), then meteor
  impacts and volcanoes.

## 2026-10-22 — round 42 (session 5, `grids`) — free play by default; low on phones

- On a phone the camera seemed to lock: the reach's fence is invisible and
  nothing says the green opens it; zooms and actions don't release it.
  `grids` (the rendering branch) opens in free play; `?mode=story` for the
  story's rules. A fence you can read (R11) is for `ambient`.
- Low quality looks perfectly good on mobile.

## 2026-10-22 — round 41 (session 5, `grids`) — the water's film, shores and wind

- The thin film of water should show on the mesh, even if only as a
  material on the ground: water flowing was one of the most beautiful parts
  of the original.
- Shores should behave and look more like shores, and the water's noise
  should follow the wind.

## 2026-10-22 — round 40 (session 5, `grids`) — no hexes in water; built things on their own grids; shadows

- Water shouldn't keep its hexes on the mesh.
- Built material as prisms is fine for now, but built things belong on
  their own grids — square ones — and tanks would be good actually round.
- The voxel/pixel look from the start is liked too: that's what the other
  branches keep (the mesh stays `grids`' and opt-in).
- Vertical terrain faces should have some noise and look less blocky.
- Shadows: a normal shadow pass instead of the sun march, if cheaper.

## 2026-10-22 — round 39 (session 5, `grids`) — sharp buildings, rough rock; mobile

- The meshed terrain looks good; the building didn't (surface nets bevelled
  it): structures stay sharp.
- A detail layer: trash piles and rock jagged in the shading, sand and dirt
  smooth.
- The goal: run well on a phone (the demo is fun there but slightly
  choppy). Keep going on look and performance.

## 2026-10-22 — round 38 (session 5, `grids`) — the field mesh

- The intervals are storage — a fast, memory-efficient way to hold the
  world — not a constraint on how it's drawn. The density field I'd
  described is evaluated from them on the fly, never stored.
- Prototype C: the terrain and the structure grids meshed from that field
  (the user's own pick too). Later perhaps cache the top-down albedo and
  normals and only relight when the light changes — but one optimisation at
  a time.

## 2026-10-22 — round 37 (session 5, `grids`) — rendering; phone builds; the long road

- Rendering next, before more simulation: the terrain as a continuous
  heightmap surface (prisms only for cliffs, overhangs and the air under
  things), level of detail chosen by zoom (orthographic: one level fits the
  whole view), a display heightmap finer than the hex grid it is filled
  from, culling to the view; caching unchanged screen tiles only if those
  aren't enough. Then the irregular grid on top of it.
- Every branch can be tried on a phone: Pages publishes each pushed branch
  under /<branch>/. Keep building, benchmarking and pushing on `grids`;
  ask only when a question is interesting.
- The long road (in this order): burying, slopes, multiple grids and
  Townscaper-style structures working together first. Structures on both
  regular and irregular grids (some cities look more rectangular), built by
  WFC like Townscaper's. Much later: SDF-based flow fields and people as
  particles who build and clear vegetation on their own.

## 2026-10-16 — round 36 (session 5, `grids`) — what the engine is for; momentum

- The aim: build cool maps and simulate wind, water and plant growth, and
  eventually construction and collapse — because it's fun and makes
  interesting maps. What there is now looks fantastic: don't overdo it where
  the performance cost is large.
- Momentum for loose materials (the user: water, sand and dirt aren't so
  different; mudslides later): worth having as an option per material, on
  the top run only, if it's cheap. Water keeps its own model (pipes with
  momentum); mud is wet soil coupled to it. BACKLOG G12.
- Order agreed: sliding by the face normal, then the wind field seeing
  structures, displacement, then water inside structures.

## 2026-10-16 — round 35 (session 5, `grids`) — how the grids work

- All grid math and conversions run on the GPU; only uniforms (frames,
  rotations) live on the CPU. Where something seems hard on the GPU,
  find out why and find a GPU way rather than falling back to the CPU.
- Hex lattice first (a neighbour-function change plus rendering), then
  grid frames.
- Full rotation (yaw, pitch and roll) from the start: a toppled
  structure is the interesting case.
- The hex grid owns loose sediment, but it samples a structure's
  projected intervals *and normals* to decide whether sand slides, so
  intervals gain normals (perhaps only in cells that intersect another
  grid). The user is curious what normals do to the interval math.
- Rendering: the triangle-lattice ground plus SDF blending where grids
  meet is a fine first pass. For overhangs (air between intervals),
  perhaps tetrahedral dual contouring. Start near today's look, but move
  towards more general, smoother rendering.
- No WFC yet. First a voxel structure like today's on its own grid,
  rotated, with sand, soil, water and wind interacting with it correctly.
  Other grids should have simulation ticks of their own: vegetation
  should grow over toppled structures as well as bury them.
- Columns stay roughly today's size for now.
- Who owns vegetation on structures was left to Claude. Chosen: it
  belongs to what it's rooted in. Plants in loose sediment (including
  soil that has buried part of a structure) belong to the hex grid;
  growth on structure faces (moss, vines, roof grass, undersides of
  tilted walls) belongs to the structure grid, with its own tick and
  the same shared growth rules.

## 2026-10-16 — round 34 (session 5) — worktrees; grids, not hexes

- Each branch gets its own worktree, so work can go on in parallel.
- Push a branch only once it has meaningful work of its own.
- `hex` is renamed `grids`: the real intent is a more general map that
  looks better and mixes terrain with non-terrain features. It supports
  intersecting grids and their interactions, e.g. a hex nature grid of
  material intervals, a rectangular grid for building voxel structures,
  and an irregular grid for WFC buildings as in Townscaper.
- Poison and oil (R10) are decided in the `puzzle` branch. The user's
  lean: oil should be hard to get rid of without burning it (that makes
  it fun), and limiting how much can dissolve in an amount of water
  makes sense.

## 2026-10-15 — round 33 (session 5) — one engine, five branches

- Separate branches for each game: `ambient` (the chill game as it is
  now), `puzzle` (the gate-DAG puzzle mode), `mayhem` (a SimCity-like
  city that runs itself, disaster response automated; the player only
  breaks things with weather), `sandbox` (a world editor: place and
  modify prefab structures, raise mountains, shape the land with wind,
  rain, meteor impacts, volcanic eruptions), and `hex` (an experimental
  terrain engine: sediment and wind on a hex grid, and interlocking grids
  that use each other's data both ways, so WFC can build structures on
  irregular grids). Branches, not separate repos (supersedes X1's "a fork
  in its own repo"). docs/BRANCHES.md has each charter.

## 2026-10-14 — round 32 (session 5) — gates only slow

- The weather can keep slowly wearing gates down (storm runoff eroding
  trash heaps is fine): a gate doesn't need to be hard, just something that
  slows the player on the way to an objective. It mustn't open by itself
  in the time a player spends getting there.

## 2026-10-13 — round 31 (session 5) — gates and a spin-off

- Levels are a DAG of gates: regions separated by barriers green can't
  cross until a key clears them (dust → wind; packed trash / polluted soil
  → water erodes and carries it off; a retaining wall → crack it to bury
  the heap in soil). Keys are abilities or environmental features.
- Abilities are never locked: every one works from the start, the player
  just doesn't know them all yet. It should feel like a toolkit of fun
  abilities, with obstacles that teach the mechanics.
- Not "only the intended key": a gate opens to anything that physically
  clears it (a flood washes away what wind blows away). Abilities are
  taught by obstacles only one of them can clear. Gates still mustn't open
  by themselves (ambient weather alone).
- Obstacles should be hard to break and hard to get past. But overgrown
  concrete looks fantastic — keep concrete as something green covers,
  not something the player has to destroy.
- No thickets: they're nature, so a bad obstacle (obstacles are always
  the ruin, never life). The fire obstacle is the compacted trash we already have
  (holds against water until burned, leaves ash).
- Spin-off idea: a disasters-only city game (meteors, floods, volcanoes,
  wind, fire, maybe killer aliens) with a full city that responds to
  disasters — a fork of this project, not part of Reclaimed. It's the
  arcade version: fun mayhem; Reclaimed stays chill and relaxing.
  Working title: "FEMA Mayhem".

## 2026-10-13 — round 30 (session 5) — story rules

- Creep: slow, through the same seed system — light wind carries seeds onto
  nearby fertile land; seeds improve the ground a little, so green spreads
  by itself. (Agreed: reach min 8 cells past the edge, follows the patch's
  outline, never shrinks.)
- A level teaches its skills, then the goal: reach the lab / make the lab
  green. Buried seeds to find as a bonus: they can be washed downstream and
  used in the next level's river to seed new green.
- Keep Free play for the valley; add the built levels to the sandbox's
  selector. Build on a new `story` branch for now.

## 2026-10-13 — round 30 (session 5) — hosting and license

- Host on GitHub Pages; the repo goes public (a portfolio / showcase of
  fast game development).
- License: noncommercial only — PolyForm Noncommercial 1.0.0. The user may
  sell it later (cheap, or free with ads on phones) if it turns out fun.
- Sediment spikes in rain storms again (seen on mobile): fix.
- Tiles that don't render (see-through to the background; screenshot of a rock
  outcrop on desktop): fix. Frame rate low on the phone (may be the hardware).
- Plants raise the angle of repose — a planted hill whose plants die can
  slide (the user liked this consequence of Q16).
- Story arc for the puzzle game, three levels: (1) the valley as a lab that
  made a virus — biohazard signs on the tanks, ruined military vehicles
  forming a quarantine barrier, evidence of flight/escape; (2) the virus
  escaping quarantine; (3) the city wiped out by plague.
- Proposed reach rule (user): influence extends around the green by a
  range based on its size (~1.5× the dimension across it); growth only on
  fertile soil and only by spreading seeds.
- Next serious goals: a puzzle variant (camera limited to the
  neighbourhood of green; green spreads only by seeds blown onto fertile
  ground), a skill for building puzzles (gates that need a skill, plus the
  features that make it possible, e.g. wind-blown embers to burn what
  wind can't move), then hosting and phone testing. Plan discussed;
  open questions in HANDOFF.

## 2026-10-12 — round 29 (session 4) — Q15

- Faceted rock "looks great", but in profile it's totally straight: vary it
  for rendering so it cuts a jagged silhouette (an example in the river).
  The carved result: "This looks good please push".

## 2026-10-12 — round 28 (session 4) — Q11–Q14

- Stone smooth too; only rises above a threshold (1–3 blocks) ragged.
- Hex grid for stone: only if it doesn't un-unify the model (for this
  project) — so render-only or not at all.
- Embers should light flammable things where they land.
- Trash particles smaller; dirt / dark-brown particles a bit smaller.
- Render-only rock: more jagged and natural, e.g. Voronoi bumps that blend
  to the neighbouring material's height outside them — "aesthetically it
  could look cool", worth a test.

## 2026-10-12 — round 27 (session 4) — Q7–Q10

- Strata validated: "looks decent, feel free to merge… good enough for
  now" — merged into main.
- Lightning: no Nature cost ("that mechanic is bad"), a short cooldown of a
  second or so. Clicks pick the actual 3D voxel; it strikes within a few
  voxels of it — the highest point in a radius-6 sphere whose lowest point is
  the clicked block (a column above the hemisphere); drawn more to metal,
  less to stone, but still preferring them to air. It still hits tall things
  near the click and arcs.
- Break tool: highlight centred on the mouse pick, not a ring from above.
- Storms: no button — swirling (the tornado action) mostly over water
  summons the lightning storm. No buttons or Nature meter to worry about.

## 2026-10-12 — round 26 (session 4) — Q6

- Push main, strata and rapier (done). Strata will be merged into main once
  the user has tested and validated it ("it seems like an improvement").
- Soft material borders (Q6): build it on strata for the user to test; the
  user takes a pass at the visuals after this. Their SDF idea was
  speculative — the bilinear vote was chosen (no precompute, follows the
  live sim).

## 2026-10-11 — round 25 (session 4) — Q4, Q5

- Rapier physics: decent, but things jerk too much at times. For this
  project: just the collapse mechanics and strict grid alignment — not worth
  having rigid-body physics even for cyclones throwing pieces. (A general
  map with multiple grids and arbitrarily aligned models is a separate
  follow-up project.)
- Visual bugs: sediment deposits on and around things in storms; jitter
  makes sand look like it interpolates from the top of a tall structure to
  its base, a wall of sand appearing and disappearing (deposits on slopes
  would be fine without that). Water under rain: the bright patches from
  rain/foam are the user's favourite water effect (good at showing flow) —
  keep them; what's wrong is weird blocky dark patches.

## 2026-10-11 — round 24 (session 4) — items Q3–Q5 in BACKLOG.md

- Destroyed blocks keep the same volume as rubble; step 1 (a new material
  in place) approved.
- "The current wind and erosion are quite fun." Visual artifacts (water
  flowing under rain): note them, "let me know before you decide to fix it".
- Physics goals (asked: is the rigid body a library or custom? — custom):
  1. "seeing something topple in a way that feels responsive and plausible
     feels fun. It's fantastic juice" — not the aftermath or the falling
     animation, "just that there is a good believable collapse". Finding
     buried things that are skewed feels cool.
  2. Some solids persist; "very cool if some could be lifted by strong
     tornado winds".
  3. Pieces break each other and the world.
  4. Falling looks better; crumbling only on impact.
- "Nothing goes up" means no fake push-outs or bounces, not no upward motion
  (tumbling and cyclone lift are fine). A physics dependency (Rapier) is
  fine; try it on a branch and roll it back out if it looks bad.

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

## 2026-10-11 — round 22, consolidation talk (P4)

User, on the architecture: redo the intervals to always allow fractional
heights; stacked layers in an n×m×d table where d can vary ("don't follow my
design dogmatically if buffers are better or easier" — agent: a buffer with
per-chunk depth, which the layout already had); no separate system for loose
vs solid — just material intervals; the goal is simpler and less buggy.
Sand under rock: it tumbles out and leaves a hill of sand with pockets of
air under the rock — agreed, with experiments to validate before sweeping
changes to the product ("which is pretty good now"). Don't prototype on the
CPU: make a consolidated strata branch and do it on the GPU so the user can
test. "Material intervals and particles are the two things that carry
material"; solid-body physics may get its own system later.

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
