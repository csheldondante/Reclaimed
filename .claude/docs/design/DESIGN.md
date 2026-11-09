# Reclaimed — design

The design authority, agreed system by system with the user on 2026-11-05. The user's verbatim answers are in `docs/DECISIONS.md` (round 128o). The long research draft (design of record) is https://claude.ai/artifact/B6JhsBFZrWGQtfn78TkJ7T; this document wins where they differ.

## How to read this

The concise design for Reclaimed. It's written system by system with the user, and each section records the intent in the user's words, the design, the rules every implementation must keep, and what's still open. The long "design of record" (https://claude.ai/artifact/B6JhsBFZrWGQtfn78TkJ7T) is the research draft. Other agents compare it to this, section by section, to find gaps and discrepancies.

**Status per section:** *agreed* (talked through with the user), *drafting* (in discussion), *not yet discussed*.

**Order:**
1. World representation
2. Pages and streaming
3. Grids and External intervals
4. Terrain generation
5. Rendering and 3D tile streaming
6. Wind and weather
7. Fluids
8. Loose material and sediment
9. Structural integrity and collapse
10. Physics engine
11. Agents and flow fields
12. Routes and roads
13. Reach
14. Traits and effects
15. Flora
16. Fauna
17. Towns: one plan
18. The fortress loop and economy
19. Raids and combat
20. Heroes and play modes
21. Runs, opportunities, the GM and the living world
22. UX and presentation
23. Persistence
24. Performance and platform
25. Process

## 1. World representation (agreed)

**Intent.** The world is columns of intervals: compact in memory and on disc. Structural analysis and the angle of repose of soft material are done in column space, never in voxels.

**Design.**
- A hex lattice of columns. Each column is an ordered list of intervals `[z0, z1)`, with free f32 heights, a material, and aux data.
- Air is the gap between intervals, so empty space costs nothing.
- Caves, overhangs and arches are just intervals with gaps between them.
- The material table gives each material its behaviour: density, strength, how much it bears, its angle of repose, tensile bond, growth cap, fallback, and so on.

**Rules.**
- One canonical representation for the world. Other representations (meshes, fields, surfaces) are derived views, converted at clean boundaries.
- Systems talk only through contract buffers.

## 2. Pages and streaming (agreed)

**Intent** (the user): "A true page system seems like a better fit here if we want to control the shape of what we load in around the player and if implemented properly with a standard interface or implementation can be done once and reused throughout the product." Also: "each page still has intervals and can represent an arbitrary height … check the pages above and below and normally they will be empty but if we exceed 16 layers then they will not."

**Design.**
- **Pages are 3D, keyed by (cx, cy, cz).** In xy a page is 16 × 16 columns. Each column holds up to K = 16 intervals of any height. Residency is grouped in 64 × 64 regions.
- All sizes are tunable build-time constants.
- **z is interval overflow, not height bands.** Page cz + 1 continues a column's intervals above page cz. It exists only where a column overflows K. cz 0 is the default and almost always the only page.
- **Open-ended intervals.** The top interval is open upward (air) and the bottom interval open downward (stone), until a resident continuation page closes them.
- **One sparse table** in its own binding (never in Globals). It distinguishes three states: a page here, no page here, and a page that exists but isn't loaded.
- **A residency planner decides the shape:** around the player, a corridor, depth for a pit, off-screen patches for generation flows. The 2D ring sliding with the player is one shape it makes. A slide changes only table entries.
- **Present or simulating.** A page can be resident and only *present* (drawn, queried), or also *simulating*. The wake API and the awake list say which.
- **One implementation, reused** by the sims, tile streaming, map sections, physics queries, agents and the disc format.

**Rules.**
- Loading never copies resident data.
- At a missing neighbour, every system extrapolates the open interval.
- The collapse judge, the surface pass and agents' surfaces follow a run across stacked pages until they reach air. This is rare; usually a run stays in one page.

**Open.** K and the page pool size on the phone; eviction priorities; migrating off today's ring; where the cross-page gather lives (the judge or the page helpers).

## 3. Grids and External intervals (agreed)

**Intent** (the user): "One of the main goals of the terrain errosion and simulation is to be able to physically bury ruins and artifacts so that they are visible in future runs and can be excavated or seen half buried. The purpose of external intervals is to provide a way for something like a rigidbody mesh to project into the terrain grid and have the material around it render and interact properly. Imagine a toppled statue. What we are essentially doing when we bury it is casting rays through it within each material interval and marking the height interval the statue occupies. That way when you use physics to pull a statue out of sand the sand falls in to fill the air gap left behind and the sand ontop of the statue falls off of it."

And on grids: "we want different grids for things like buildings than we do for the terrain. We want our buildings to be able to be rotated relative to the terrain (at least in the z axis)."

**Design.**
- **Many grids, one owner per bit of matter.**
  - The terrain's hex column grid owns everything loose: ground, sediment, water, plants on the ground.
  - Buildings, districts and fortresses each have their own grid (a tile system) with their own cells, levels and orientation, turned about the vertical axis.
  - Bodies and toppled things have their own frames with full rotation.
  - Where grids overlap, the others see the owner's matter only as a read-only projection. Nothing is simulated twice.
  - Each grid has a rigid transform in a GPU grid table. Static geometry is drawn as instances in its grid's frame, so moving a grid rewrites one row.
- **External is a material, in the terrain's own intervals.**
  - An object's projection is ordinary intervals of material External (naming the owner grid, with face normals) in the column's normal K slots. There is no separate span list or span limit.
  - A column that needs more intervals continues into a stacked page, like any other column. The user: "Why can't it just be a material type and be one of the 16 layers already supported by terrain and we can add more pages if needed?"
- **Projecting an object: whatever its representation makes cheapest.**
  - Each column under the object gets the height spans the object occupies.
  - How they're found depends on how the object is represented. Meshes will likely get a baked voxel version of their material anyway, because physics deformation needs it, and that can be stepped through. A depth raster with depth peeling over the object can give the material intervals directly.
  - Pick whichever measures faster. The user: "I'm not dogmatic."
- **Burying is the erosion sim's job, not sinking.**
  - Things get buried by wind, water and sediment, either live in the player's view or between runs (the generative sims).
  - A heavy object landing on soft ground makes only a **small indent**, and the displaced material **blows out as dust**. It does not sink into the sand.
- **Projection only where it's needed.**
  - A body is projected into the terrain only while it intersects the terrain, and most never do.
  - Collision response may displace some soft material.
  - Per-frame re-projection is needed only while the player actively moves a buried object: rare, and usually one at a time.
  - A resting object is projected once.
- **A buried building is its own tile system.**
  - A ruined hall, with whatever stands inside it such as a statue, is a grid of its own. In the terrain, the hall's whole extent is External intervals owned by that grid.
  - Inside, the tile system runs **its own material tick**, so sand, water and other soft material can collect, drift and slump inside the hall in the hall's frame.
  - A statue in the hall is part of the hall's tile system, not a separate rigid body, until physics frees it.
- **Following the ordinary terrain rules.**
  - Sand piles on an object and slides off along its face normals at the angle of repose. Water goes round it. Moss grows on top.
  - Lift a buried statue out with physics: its intervals become air, the sand on it falls, and the sand around slumps into the hole.
  - Unburying never launches a thing. It topples, slides or stays, depending on support.
- **Drawing.**
  - The terrain mesher treats External as air and draws the sand's faces against the object.
  - The owner draws the object's real mesh. A half-buried statue shows above the sand line, with sand closing round it below.
- **Persistence.** A buried artifact persists into later runs. Its grid record (model or tiles, transform, state, and its interior material) is saved, and so are the External intervals naming its grid. A claimed interval with no owner is an error.

**Rules.**
- Only an owner writes its External intervals, or a real cut (the player's tools, a blow, the judge).
- The terrain sims treat External as solid that never changes by itself.
- External keeps its absolute heights. Ground eroded from under it becomes air, which goes to the judge and then physics.

- **Exchange between a tile system and the terrain.** A tile system's open faces (a doorway, a broken roof) are neighbours of the terrain columns beside them. Material crossing a face moves between grids: it is removed from one owner and added to the other, so mass is conserved. Sand pours in through the roof, water floods in, and sand blows back out.

**Deferred** (decided direction, built much later):
- **The tile system's own material tick.** It's undecided between its own column system and a voxel system. The user leans to voxels inside structures, because a structure can be rotated relative to z: "my guess is that voxel based will make more sense inside a structure which could be rotated relative to z."
- **When it ticks.** Only while the player is looking at it, or in a quick pass that makes it look flooded or filled (for example when a run starts or a ruin is uncovered). Never constantly for every building.

## 4. Terrain generation (agreed)

**Intent** (the user):
- "The greatest strength of what we have built so far is how interactive it feels and how varied and cool the terrain is compared with other games" (round 110).
- "we want our terrain to be striking to look at and interesting to explore … Let's make this world hauntingly beautiful" (round 117).
- Terrain steers play: "An impassible mountain can have a cave through it. A ravine can require the player to build a bridge. A desert with dust storms may require a vehicle."

**Design** (drafted from the earlier rounds, for review).
- **Two scales.**
  - **The atlas** is a finite world that wraps (a torus), built once on the GPU. It has continents, a Voronoi partition into regions split by faults, provinces that choose region kinds, and JFA distances to borders and coasts.
  - **Regions** add the detail. "The actual heightmap can be informed by but not determined by the underlying noise" (round 78).
  - **Heights are blended with SDF/JFA:** stark walls where heights change, smooth ramps where a cliff breaks. Busy noise marks impassable land; walkable land is calmer.
- **One ground function at every scale.**
  - `ground(p)` takes the regions on either side of the nearest border and blends them through that border's profile: smooth, cliff, ravine, wall or terraces, and on a coast, beach or sea cliff.
  - Profiles are odd in distance, so there are no seams.
  - The viewer, far tiles and window columns all evaluate the same function.
- **Features.**
  - Cliffs, mesas and gorges.
  - **Cave networks with obvious entrances** in cliffs, not just overhangs.
  - Rivers carved by SDF, with waterfalls, rapids and rivers that sink and re-emerge.
  - **Lakes found by a GPU basin flood fill, not a global sea level.**
  - Craters, crystal giants, geysers and oddities on their own grids.
  - A pattern bank of tiling textures (wallpaper groups, cellular automata, reaction–diffusion) mixed into heights.
- **Sites and roads.**
  - Settlement sites are chosen by setting: cliffside, port, river town, crater rim.
  - Roads link them over the land by A*, with crossings classed as tunnel, ramp, switchbacks, lift or bridge.
- **Buried props.** What lies buried where is a pure function of the seed and world tile. It is projected as External (section 3) and buried by the sims.
- **The region graph.**
  - Features are what a walker reaches without crossing a barrier. Rooms are open spaces 1–3 screens big. Borders carry a barrier kind and measures.
  - Crossing cost is reckoned per controller (bike, soldier, force of nature), so a new controller needs no new generation.
  - The run manager can request exits or obstacles, which become terrain edits.
- **Generated on the GPU straight into pages.** A region's columns are finished on the GPU into its page slot, with no CPU in the path.
- **Generators make a steady state.** Land arrives settled, and nothing simulates until something touches it. Bad-looking placement is fixed in the generator, not by simulating. Streamed land never contains floating pieces.
- **Changes between runs and scripted events** use static generators and the GPU flood fill (see Decided).

**Rules.**
- Everything generated is a pure function of the seed and world coordinates, never of slots or the window. Across devices, small float differences are accepted.
- Generation reads nothing back to the CPU.

**Decided 2026-11-05.**
- **Per-device worlds are acceptable.** The same seed may give somewhat different worlds on different GPUs. Making generation bit-exact everywhere would be a huge effort to redo. If shared worlds are needed, **serialize the generated world**.
  - Consequence for testing: a desktop run doesn't reproduce the phone's land. Tests of the phone's land use a fixture captured on the phone (the bench's "Download the town").
- **Map design (rooms, key/door barriers, region briefs) is lower priority.** The focus is city building and opportunities, not the character-driven controllers. "All that's relevant for now is cool interesting maps to build in." The region graph stays, but designing it further is deferred.
- **Between-run and scripted changes use the GPU flood fill.** A scripted event (a volcano burying a region in ash, a dam breaking and flooding a valley) is applied by flood fill over the affected area. A static generator should give the eroded, settled look. Simulating the affected pages is the fallback, used only if a static generator can't do it convincingly. The coarse whole-world simulation is not the mechanism for this.
- **The finite, wrapping world (torus) stays** for now.

## 5. Rendering and 3D tile streaming (agreed)

**Intent** (the user):
- "The most basic thing is that all the tiles visible on screen load visually and our framerate doesn't dip below our thresholds" (round 112).
- "Fast cheap standings to cover the minimal area needed replaced as fast as we can with the fuller data" (round 113).
- "The intervals are storage … not a constraint on how it's drawn" (round 38).
- "There should be multiple grids with their own coordinate system on the GPU and everything should be instanced without CPU readback" (round 128g).

**Design** (drafted from the earlier rounds, for review).
- **Every pixel is always drawn by something,** and the best detail replaces it as fast as the hardware allows. Layers, each its own representation:
  - **Stand-in:** coarse height and colour from the atlas, always there.
  - **Tile:** a region baked once into a render-only isometric G-buffer impostor (colour, normal, depth, water, snow), relit every frame and drawn as a quad. Same generation as the full land, no simulation, nothing read back.
  - **Full land:** the field mesh over loaded pages.
  - A region draws the highest layer that is ready. Swaps happen at frame boundaries.
- **Streaming is about latency and ordering, not throughput.**
  - Holes in view come first, then look-ahead in the direction of motion. Look-ahead grows with speed (speed × each layer's measured latency).
  - The budget is per frame. Rendering comes before simulation.
- **Terrain meshing.**
  - A surface-nets mesh of a field evaluated on the fly from the intervals, never stored.
  - Mesh chunks are rebuilt only when their columns change, within a per-frame budget, from a page pool of vertex memory.
  - The **hybrid**: plain heightfield chunks are a fixed grid that is never remeshed. Only chunks with real 3D shape (overhangs, cave mouths, bridges) are meshed.
  - Built materials stay sharp. Cliff faces get noise so they aren't blocky. The per-cell low-fi look stays for now.
- **Static geometry on the GPU, moved by transforms.**
  - A grid table holds rigid transforms. Each owner's pieces are uploaded once in its grid's frame and drawn instanced. Moving or sliding rewrites grid rows only.
  - Trees and props are instanced meshes. Bodies and rocks are meshed once at the break and skinned to their transforms.
  - LOD and representation swaps happen only off screen, with hysteresis.
- **Shading.** Deferred shading for terrain ("Deferred shading helped a lot on my phone"). One cached shadow map near the view. Clouds and storms shade analytically.
- **Water** is one surface over wet columns. Steady water keeps its flow look without simulating.
- **Camera.**
  - Orthographic dimetric at 30°, zoomed in pixels per cell, turnable in sixths.
  - What blocks the view is handled by independent mechanisms: dither, slice under a roof, and orbit to a clear angle. The occlusion rule is still to be designed.
- **Retired paths are deleted.** The old LOD rings, farbake and fardetail go: "a fallback path not shipped shouldn't stay".

**Rules.**
- Nothing drawn depends on CPU readback. Claims and sim state never change what is drawn.
- Every world draw path gets a pan test and a phone bench case.
- Visuals are judged in the game at play zoom.

**Decided 2026-11-05.**
- **Play centres on a fixed point (the city), so load around it.** Tiles load around the city, and a large area is kept resident in memory if the phone allows, so play mostly doesn't stream.
  - Streaming stays: it does whatever is fastest to get convincing visuals up ahead of the simulation, with no draw gaps.
  - The **simulation window is separate and lazy**: it skips sleeping cells to save as much compute as possible. What is drawn never depends on what is simulating.
  - **Keep the existing streaming approach.** The user: "I think the current code does a lot to render tiles as cheaply as possible via streaming and that's good. We want low latency planning with as much visual continuity as possible." The code's quality is still to be checked against this design, but the approach stays.
- **Camera: minimal for now.**
  - Clicking a structure should be easy.
  - Later: a cinematic angle on a structure, or zooming in and cutting away rooms. For example, an opportunity given by someone in your workshop zooms into a tower and cuts away to show their lab during the dialog.
  - Following a worker should cut away or dither what blocks them (less important).
- **The look.** The lo-fi look stays, and the terrain is its best execution so far.
  - An experiment with high-resolution textures is welcome, to see how it looks. The user likes the aesthetics of Dota 2 and wonders whether that can be hit on mobile.
  - Keep the renderer open to textured terrain without committing to it.

## 6. Wind and weather (agreed)

**Intent** (the user):
- "one of the most satisfying things to see your movement cause things go away in reaction … the way wind moves is the coolest thing in the simulation" (round 83).
- "Storms should primarily be fields that cause effects" (overview).
- "Why does wind and climate need to run everywhere and at what frequency? Most wind effects I've seen are gusts near the player and maybe a global Atlas level tick that can be very infrequent" (round 104).

**Design** (drafted from the earlier rounds, for review).
- **One wind field everything feels.** A half-resolution GPU texture holds the painted wind (strokes, blows, wakes, landings shoving air out) on top of the analytic map wind (prevailing wind in advected gust patches, eddies, dust storms).
  - The painted part advects, spreads and relaxes back to the map wind within seconds. Strokes over the same place stack: breeze, then gust, then gale.
  - Every reader samples the same field: sediment lift (per material: leaves 5, snow 6, dust 9, ash 10, sand 14 cells/s, with shelter behind higher ground), particles, fire spread, foliage sway, units (by mass), riders knocked off routes, audio.
- **Storms, cyclones and dust storms are fields, not atmosphere simulations.** A few CPU entities write uniforms, and the GPU evaluates their fields analytically: wind, rain, cloud shade, lightning.
  - Storms ride the wind field, so painted wind steers them indirectly.
  - Lightning strikes the highest point near the target, is drawn to metal, and sets fires.
  - Cyclones strip loose material and lift dust.
- **Rain and snow.** Rain feeds the water sim. Snow is laid as a deposit where the air is below freezing.
  - Climate gives air temperature by height, so a peak snows while its valley rains.
  - Seasons drive leaf colour and fall, and grass colour.
  - Day and night move the sun and shadows.
- **Foliage.** Plants bend and stay bent in the wind, then spring back (a damped spring per column). All of it on the GPU from the same wind field, with no CPU work per plant.
- **The update model.**
  - The wind field simulates only where something painted it, plus a margin. Everywhere else it is the analytic map wind.
  - Climate ticks rarely, and only on live chunks.
  - At atlas scale, weather and climate are an infrequent world tick, not a simulation everywhere.
  - Weather beyond the loaded area (snow, wetness) is a coarse field the tiles read when drawn.

**Rules.**
- Wind is a field that everything reads. No system keeps its own wind.
- Strokes and gusts are never dropped: past the per-tick limit they are merged.
- Weather beyond the player stays analytic and cheap.

**Decided 2026-11-05.**
- **Weather is both spells and atmosphere.** Wind, storms, lightning and cyclones "were very fun and I think will make great spells". Wind and rain add a lot of atmosphere.
  - Add **fog**, **snow**, and **ash with embers** (from fires and eruptions) to the atmosphere set.
- **Weather drives the economy through a rain level, not erosion.**
  - Water uses the existing baked flows that depend on an overall rain quantity. There is no full erosion simulation in play.
  - Flows are **steady states driven by the level**, regenerated periodically when the rain level changes.
  - Rain matters to the city: **drought hurts crops**. That makes the weather spells more interesting and gives them synergy with the economy, for example summoning rain in a drought.
- **Foliage wind is polish, lower priority.** Keep the build order (static baseline, ripple shading, grass bending, tree lattice bending, phone benchmark, stop at the first technique that's good enough). Use it to make player clicks more fun: a tap's ripple of wind visibly moves the grass and trees.

## 7. Fluids (agreed)

**Intent** (the user):
- "water flowing was one of the most beautiful parts of the original" (round 41).
- "Think flux. As long as our section has material going in matching material out it is in steady state … freeze and treat it as an animation only" (round 84).
- "instead of a global sea level a GPU flood fill based on height would let us easily flood areas … We can flood with water, sand, magma etc." (round 117).
- 2026-11-05: "level driven steady flows we periodically regenerate".

**Design** (drafted from the earlier rounds, for review).
- **Steady state is the default.**
  - Rivers and lakes come from the atlas at their steady state: river tables give each river's level and flow at a given wetness, and lakes fill each hollow to its spill height.
  - Held water isn't simulated. It's drawn flowing from its frozen flux ("a rendering trick"), and it feeds any awake water downstream.
- **Wetness drives levels.**
  - Each watershed's wetness (seasonal, plus storm rain on its catchment lagged downstream) sets its rivers' levels and speeds.
  - A region's inflow factor can dry a river up as an instant state change, not a simulation.
  - Flows are regenerated periodically as the rain level changes.
- **Reactive water only where woken.**
  - A dam break, a breach or the player's spell wakes the water there. It is simulated (the pipes model: head differences push flux between neighbouring columns), then settles back to sleep when steady again.
  - Arriving land comes in already settled.
- **Liquids and the columns.**
  - Water fills pits.
  - It wets loose ground, which then holds a lower slope, so rain brings slumps and mudslides.
  - Water over loose ground washes it downstream.
  - Water held back by loose ground pipes through it, so embankments breach.
  - It cracks damaged solids under a head of water (the generic dam breach).
  - It goes round External intervals.
  - It freezes and melts with the climate.
- **The basin flood fill** fills a basin to a level with water, sand, ash or magma. It serves scripted events (a valley flooded, a region buried in ash) and generation (lakes, the sea).
- **Lava** is a slow, hot liquid. It flows only while hot, sets into basalt intervals, boils water and spits embers. Volcano cones rise from the ground.
- **The shore and waves.** A distance field to the nearest shore drives swell lines coming in.

**Rules.**
- Liquids talk to the rest of the world only through their contract (depth, level and flux per column gap, published by the liquid model). The model behind it can be replaced.
- Nothing simulates water that is in steady state.

**Decided 2026-11-05.**
- **The steady state is at page detail, not just atlas rivers.**
  - When it rains, water runs down things and pools, depending on the amount.
  - The bake works at the page's own resolution: given a rain quantity, it finds where runoff goes and where it pools.
  - River levels are computed at the atlas level, and rivers dry up.
- **The bake includes overflow where it's affordable.** For example a river breaking its banks onto its flood plain in a wet season. Include it only if the cost makes sense.
- **Water is part of the column model.** The user: water "should be represented as a column in the terrain so we can have it go under or through things".
  - Liquid lies in a column's gaps (on top, in a cave, in a tunnel, under an overhang), not only as one layer on the top.
  - Storing it as intervals in the layers or as runs in a parallel buffer is an implementation choice, weighed against the slot limit.
- **Migrate to the flow model**, and it must bake.
  - The flow model of round 84 becomes the one liquid model: runs in any gap, momentum, arcing falls, water and lava as two kinds of one kernel.
  - Its steady state is what gets baked.
  - The pipes model is retired once the flow model bakes and holds the phone budget.
- **Sea level per basin.** Each basin has its own level. A global level is used only to flood-fill the oceans at generation, after which each ocean is a basin like any other.
- **Oil: keep unless the material limits force a choice.**
  - The user: "I prefer to understand the limits and if they are necessary."
  - Action: document the real limits. Materials are packed in 8 bits next to aux in an interval word, and there may be other per-material tables and bit fields. Say whether any limit is close.
- **Water is a city resource.** Wells, irrigation, reservoirs, mills on rivers, and flood risk for building by a river. Try it, and remove it if it isn't fun (details in the economy section).

## 8. Loose material and sediment (agreed)

**Intent** (the user):
- "We use column space because it is compact in memory and on disc and we can do structural analysis and soft material angle of repose in column space without ever needing voxels" (2026-11-05).
- "Dust drifts that bury things you uncover with wind" (round 11).
- "Sand under rock: it tumbles out and leaves a hill of sand with pockets of air under the rock" (round 22).

**Design** (drafted from the earlier rounds, for review).
- **One representation.** Loose ground (soil, sand, gravel, rubble, ash, silt, dust, snow, leaf litter) is material intervals with fractional heights, the same as everything else. The loose run on top of a column is what wind, water and slumping work on.
  - The material table gives each material its wind threshold, airborne share, wash readiness, and dry and wet repose.
- **The angle of repose in column space.** A neighbour lower by more than the material's repose slope receives a slump (a bounded share of the excess, so neighbours don't fight). No voxels and no march: it compares neighbouring interval tops.
  - Wet ground has a lower repose. Rooted plants raise it, so a planted hill whose plants die can slide. Shaken ground slips at a lower angle.
- **Falling and spilling.** Loose intervals with air under them fall onto their support. Buried loose ground beside air spills sideways into it until its face stands at repose. So sand under a cap rock runs out, leaving an air pocket, and the structure pass sees the cap lose support.
- **Wind transport.** Above the threshold (after shelter), the top moves downwind, banks against walls and piles in the lee. The airborne share becomes dust particles that settle where they land.
- **Water transport.** Moving water carries the top downstream and drops it where the flow slows. Water held behind loose ground pipes through it.
- **Strata.** Arriving material joins the top interval if it's the same material, and otherwise starts a new one, so pours and drifts make visible layers.
- **One inbox.** Every system that adds loose material uses one `deposit` per column: crumbled bodies, snow, leaves, ejecta, brushes, a place's burial.
- **Debris is ground.** Collapse turns intervals into rubble of the same volume, which the sediment pass then lets fall, pile and slide. There is no separate debris simulation.
- **Burial.** Drifts bury External objects (section 3). Under deep dust or ash, plants go dormant.
- **The update model.**
  - Every other tick, only on awake chunks.
  - In play, wind and rain erosion are baked on the atlas and go live only around player interaction. Slumps, spills, falls and piping are always live where awake.
  - Even when erosion is baked, the dust that would blow is still emitted as particles: "we want to see falling and blowing dust even if the underlying map isn't changing" (round 108).
  - Streamed land arrives settled, and bad-looking sediment is fixed in the generator.

**Rules.**
- No voxels for loose material. Angle of repose and slumping are column comparisons.
- Mass is conserved: rubble keeps volume, and slot overflow merges loose layers and is counted, never silent.

**Decided 2026-11-05.**
- **Loose material joins the one flow model.** Mudslides, avalanches and sand pouring off a ledge flow with momentum and arc.
  - The model is **normalised for gravity and scale**: one gravity, a cell is a metre, so liquids, slides and bodies agree.
  - It should stay cheap: it essentially adds a velocity per interval for flowing materials.
  - That velocity lives in its own buffer, or flowing intervals are marked as owned elsewhere (as External is), so the layers stay compact.
- **Live burial only on demand.** Storms, dust storms and mudslides simulate and edit columns only in response to player actions or spells.
  - Otherwise particles make it look as if material blows, without editing columns.
  - The switch between looking and editing exists today (the sims' tiers), and should be kept.
- **Normals on External intervals: adopted.** External intervals carry entry and exit face normals, so loose material slides off a tilted object along its face. The user had suggested this before ("I think it was lost").

## 9. Structural integrity and collapse (agreed)

**Intent** (the user):
- "solids can use columns to cheaply compute collapse and fracture in the vertical direction. Then sleep like any other physics system" (round 83).
- "connected components of solid intervals then look at total solid support under an interval … can all be done pretty cheaply in column space … supports can be vertical or horizontal" (round 92).
- "seeing something topple in a way that feels responsive and plausible feels fun. It's fantastic juice" (round 25).
- "I want to topple spires of stone" (round 83).

**Design** (agreed 2026-11-05: "Yeah I like that design").
- **One destruction system: the physics engine's, triggered cheaply from column space.**
- **Column space decides whether, and where.** This runs cheaply on the GPU after a cut and copes with structures of any size.
  - **Connected to the ground:** a GPU connected-components flood from the ground over solid runs, the same technique as reach. Anything not connected falls whole.
  - **Support × distance per cell:** each cell's support (what holds it, by material) and the vector distance to that support, from a JFA. Cells whose support over distance is too low are marked to go. The threshold is set per material and tuned on the panel.
  - **Support comes only from below,** or from the side within a solid material (stone holding stone). Loose ground above never holds anything up.
  - External intervals are support that never gives by itself. When a piece containing them goes, their owner is told.
- **The physics engine decides how it breaks** (section 10). The marked region, or a roof near an impact or a wake event, becomes voxel bodies that deform and fracture within the engine's budget.
  - Necks snap, legs buckle, things topple on their hinge and arches fall, all by the engine's rules, with no hand-written check for each failure.
  - Undermined buildings and walls go this way too: they deform and break their mesh.
  - When the budget is full, or a piece is huge or off screen, the column result stands alone. The piece falls as a rigid body, or turns to rubble behind dust.
- **Event-driven, and asleep otherwise.**
  - Only what an edit cut is checked: a dig, a blow, a meteor, a spell, a raid, or a wake event.
  - Generated and streamed land stands by construction.
- **What it writes.** Cuts, rubble, freed bodies handed to the engine, and `loose` or `cut` sent to owners. All of it as GPU stamps, with nothing read back.

**Rules.**
- Nothing floats. Generators never make floaters, and the judge drops anything unsupported.
- One destruction system. The CPU runs judge, the GPU sections judge and the older per-interval support rule in `structure.wgsl` are retired.
- Game damage (raids bashing walls, spells) goes through the destruction trigger and the physics engine. **Removing material on contact is part of the engine, not game code.** It is how big impacts are softened (see section 10).

## 10. Physics engine (agreed)

**Intent** (the user, 2026-11-05): "rewriting this properly as a data oriented engine with rigidbody simulation via an integration buffer, course collision pass, fine collision pass, budgeted and intelligently prioritized voxel deformation and fracture sim and constraint solver on the GPU with a collision buffer for optional async CPU readback".

Also: "Looking heavy and moving at a consistent speed matter more than preventing penetration" (round 106), and "Big impacts lose most of their energy into particles".

**Design** (from round 120 and today, for review).
- **Data-oriented, on the GPU.** Bodies are rows in structure-of-arrays buffers. Each stage of a fixed step is one or a few dispatches. The CPU only adds bodies, applies impulses and wakes bodies.
  1. **Integration buffer:** pose, velocity, inverse mass and inertia, material, flags (asleep, kinematic, deformable), and priority. Integrate gravity (9.8 cells/s², a cell is a metre) and impulses into predicted poses. Asleep rows cost nothing. Heroes, agents and vehicles are kinematic rows.
  2. **Coarse collision:** a GPU spatial grid or hash of body bounds gives candidate pairs. Bodies are tested against the **columns** directly, so terrain needs no collision mesh.
  3. **Fine collision:** contacts, normals, depth and **impact energy** go into a contact buffer.
  4. **Budgeted, prioritised voxel deformation and fracture:** only for bodies in a true collision (energy past a material threshold), in priority order (what the player handles, size, on screen, energy), within a fixed budget per frame. Rock shatters. Metal and wood bend, dent and snap. Soft material flows. Masonry has no tension. A body returns to rigid once settled.
  5. **Constraint solver:** a parallel contact solve with the agreed rules:
     - separation adds no speed;
     - overlap up to a mass-scaled slop is allowed and drawn as surface deformation;
     - **erode, don't push.** Where bodies overlap, the softer one (or the smaller) loses material instead of being pushed out. This is deliberate softening for big things: large objects penetrate a little as material collapses and energy is lost, as dust and rubble. The user: "the rules that delete blocks were I believe intended to help make collisions softer which we want for big things … it's still likely something we want to tune just in the physics engine now." How much is removed, by energy, size and material, is a tuning parameter on the panel;
     - sleepers stay put unless an impulse wakes them or their support goes;
     - deflect and topple, don't bounce.
  6. **Collision buffer:** events (bodies, point, normal, energy, materials).
     - GPU systems consume them directly: dust and particles by energy, wind puffs, the destruction trigger at ground strikes, a small dent in soft ground with the material blown out as dust.
     - The CPU reads them back **optionally and asynchronously**, only for sound, damage or gameplay.
- **Rendering skins meshes** to body or voxel transforms by vertex weights, interpolated between fixed steps. Meshing is chosen by material, never by solver, and swaps are hidden behind dust.
- **At rest** a body stays an object. It claims its space as External intervals (section 3), is buried and overgrown by the sims, and wakes in place when dug out or struck. It is baked into terrain only between runs, or when the body buffer needs room.
- **Agents** are kinematic rows: pushed, knocked down or buried through reaction profiles, while heroes keep control.
- **The tuning panel and the labs.** Every constant is a slider. Results are shown in the physics lab (rocks, buildings, metal; deformation, breaking, burial) before they ship.

**Rules.**
- No per-tick CPU readback of bodies. The collision buffer is the only read path, and it's optional.
- One engine replaces all four of today's movers (old, nodes, lattice, hybrid).

**Decided 2026-11-05.**
- **One baked voxel model per object,** at a resolution chosen per object (a cell, or a half or a quarter of one). The same model serves deformation and fracture, and projection into the terrain (section 3).
- **Many rigid bodies; deformation capped by measurement.** The engine should handle lots of rigid bodies. The number deforming or fracturing at once is capped at whatever performs well on the phone under load, found by the phone bench, not set in advance.
- **Solver and broadphase details** (grid or hash, Jacobi or graph-coloured, iteration counts, buffer sizes) are chosen by measurements on the phone, not guesses.

## 11. Agents and flow fields (agreed)

**Intent** (the user):
- "Peel the intervals into pathable surfaces … Run units as state-driven groups sharing flow fields, so most behaviour is following a gradient" (round 52).
- "compute paths instead of flow fields for towns … Flow fields can be generated as needed and I suspect only during large combats or storms" (round 104).
- "The agent simulation is extremely cool" (round 128b).
- Round 128m: flow fields only "for open areas or things that change like depleting resources".

**Design** (drafted from the earlier rounds, for review).
- **Surfaces come straight from the intervals.** Each column's walkable surfaces are the tops of solid or loose runs with headroom over them (up to 4 per column, so bridges, caves and floors stack). Each surface links to a surface in each neighbouring column within a step up or a drop.
  - Wet and deep water are marked, so units wade and never path into deep water.
  - There are no voxels and no render geometry involved.
- **Units are GPU rows, one thread each.** Position, velocity, kind (height, mass, health, speed, reach, damage, notice distance) and state.
  - They walk surfaces, steering down their group's field, or follow a route (section 12).
- **Flow fields, shared by goal, only for open ground and things that change:**
  - the blocks to build, trees, a quarry face, a raid's target, fleeing, combat and storms.
  - A field is a distance over the surfaces from its seeds. It is relaxed only where something changed (the scope and the dirty front), so settled fields cost nothing.
  - Fleeing follows a smoothed negative field toward open space.
- **Units are physical.** Forces divide by mass. Hard pushes, launches and drops make a unit tumble, and wind past a threshold knocks units over.
  - Units catch fire, wade and drown.
  - What they carry is real ground: material is taken off a column and put back exactly, so totals hold.
- **Fighting.** Notice, close in, then a swing with a wind-up, a hit and a cooldown. Reach is between capsules, and sight is tested through the surfaces.
- **Units change the world only through world operations:** terrain take and put, felling trees, fire. They never reach into another system's buffers.

**Rules.**
- No per-frame CPU copy of all units. Game logic reacts to the GPU's event stream (swing, hurt, death, arrived) and reads individual units only when it watches them (the follow card, a selected unit). The review measured today's full copy as a frame-rate cost.
- Fields are relaxed only where something changed.

**Decided 2026-11-05.**
- **Surfaces are baked from the columns** into their own buffer, using the same page approach: a column's surfaces live in its page, and stacked pages hold the rare extra layers.
- **Flow fields also lead units back to the roads.** A unit off the network follows a shared field to the nearest route, then rides it (section 12).
- **Physical when necessary, cheap when possible.** Units really move material by taking it from columns and depositing it. How that shows (a load on the back, a cart, a dust puff) is whatever visuals fit.
- **One crowd.** The agents and the inhabitants merge, with body plan, behaviour and species as per-unit attributes. Expect more behaviours to come, such as flocking and formations.
- **Bodies come from the inhabitants' procedural rigs** for people, soldiers and creatures alike. The art push will raise their quality and fidelity, possibly with external assets.
- **Mass combat: hundreds to thousands of units.** Early benchmarks show this is feasible on mobile.
  - Units move and fight by flow fields.
  - **Impacts and death turn them into rigid bodies** in the physics engine, thrown around by blows, blasts and wind.
  - A unit that isn't dead gets back up and returns to its field (the town agents already do this after a wind knockdown).

## 12. Routes and roads (agreed)

**Intent** (the user, round 128m):
- "A huge part of the design is trade looking real and the city seaming alive. That means we want people following roads to where they go. Roads and pathing through building should build piecwise splines that we can interpolate units along and have them procedural animate rolling or walking. That way we can add thing along the route like stairs or elevators and even logic to animate cranks and things … Then we only need flow fields for open areas or things that change like depleting resources."
- "if agents are on paths can't we essentially just interpolate their position from end to end at their travel speed?"
- "add logic to pass on the road if their position will pass one on the array of road positions … have them wait and queue for an empty lane to pass".
- "Make sure other systems can still take units off roads. Fleeing, getting knocked off my wind etc".
- "Blocking a road should create detours rather than actually block the road so that units path around the obstruction but the cost is paid once".
- On geometry: "They look fine for now don't ever smooth them yet".

**Design** (from round 128m, for review).
- **A route network of segments.** Today's road geometry (a tree on the town grid's cell borders, from the gates to every door), piecewise linear, plus door segments into buildings. Each segment has a kind, so stairs, ladders, elevators, cranes and scaffolds can be added later as kinds with their own motion and animation.
- **Kinematic trips.** A unit on a route is a trip record: its route, start time and speed. Its position is interpolated along the segments, with no steering, shoving or "lost" logic. Height is looked up only to draw it. Walking and rolling are animated by distance travelled.
- **Lanes, queueing and passing.** Every tick the GPU buckets riders by (segment, direction, position) with a count, prefix sum and scatter.
  - Each rider follows the one ahead, with its speed capped by the gap.
  - A faster rider that is blocked overtakes when the opposite lane has a free window, and queues otherwise.
- **Everyone rides** where the network goes: workers, carts, settlers, soldiers marching, raiders arriving. Open ground uses flow fields (section 11), including the way back to the road.
- **A route is a mode, not a cage.** Wind, blasts, hits and physics knock riders off. Fleeing, fighting and raids call them off. They walk back to the nearest node and rejoin.
- **Detours are paid once.** A blocked stretch (a block placed on the road, rubble, a fallen tree) is replaced once by detour segments around the obstruction, found on the GPU. The route tables are rebuilt, and riders keep riding. The original stretch comes back when the obstruction is cleared.
- **Roads become bridges over water** (section 13).
- **Trips without ticks off screen.** A trip resolves at its arrival time. On screen, riders are placed from the clock. Decided by measuring fast-forward first.

**Rules.**
- No unit on a route is steered by a field or pushed by its neighbours.
- Road geometry is not smoothed for now.

**Decided 2026-11-05.**
- **Roads come from the tile placement rules.**
  - Building tiles declare the paths they connect. Placing tiles joins those paths into the network.
  - A rule that looks decent: **roads run between adjacent tiles of different types**.
  - A **dense block of homes gets passages through its tiles** instead of roads around every house.
  - **Large roads can be laid across the map.** The grid's own roads adjust to connect to them. Building roads is something the player can do.
- **Caravans between towns travel the atlas roads unrendered.**
  - They use the same tricks as local trips: a queue of arrival times per road, and the points where caravans pass each other.
  - A caravan is rendered only when the camera shows it.
- **Cached routes, like conveyor belts.**
  - A buffer lets agent groups cache routes between their destinations (the quarry and the warehouse, a farm and the granary). Different agents can follow different roads.
  - A route is stored compactly, as its points along roads or surfaces, like Factorio's belts, so the limit can be large.
  - This replaces the fixed next-hop tables (64 destinations, 1,024 nodes) as the limit.
- **Building roads costs materials and shapes the terrain.** Builders build a road like any structure. It conforms to the land where that makes sense, and otherwise changes it: grading, cuts and fills, bridges, ramps, switchbacks and tunnels.
- **Traffic is for looks for now.** Roads have enough capacity, and congestion isn't a mechanic. Later, congestion could be fun and make the world feel alive (widening roads, a second gate).
- **Tiles declare all their paths,** including internal and vertical ones: stairs between floors, wall-walks, ramps into a quarry, elevators in a tower, so "you can get anywhere". Stairs, cranes and elevators are segment kinds that the tiles provide.
- **Stale routes are rebuilt lazily, and only those.** When roads change, only the cached routes that a change made stale are regenerated, the next time a group needs them. Detours cover blocked stretches meanwhile.

## 13. Reach (agreed)

**Intent** (the user, round 128m):
- "if they keep getting stuck in walls an obvious fix is to modify things along their path to be passable. Add a gate or a bridge. The expectation is that they can get anywhere in or around the city."
- "in general we should not have blocks that agents can't reach."
- "I would probably do connected components of reachable things on the GPU myself but only because I find CPU round trips are stupidly expensive on mobile."
- "towns should always have gates" (round 128l).

**Design** (from rounds 128f–128m, for review).
- **Reach is an invariant, not a check.** Every open place in and around the city is reachable from the stores. Generation and every edit keep that true by changing the world: a gate in a closing wall, a passage through a ground floor, a ramp or stairs down a drop, a bridge over water. A unit that can't get somewhere is a bug in the world.
- **Computed as connected components on the GPU** over the walkable surfaces (label propagation with pointer jumping), with the plan's blocks included as if built. Joins are two-way steps only, so "reachable" means a walker can get there and back with a load.
- **After every edit,** the cut-off components are found, and the cheapest passage is added to the plan for the builders to build.
- **Refuse what nothing can fix.** A placement that no gate, passage, ramp or bridge can make reachable is refused at placement, with the reason in plain words: deep water, a cliff, walled in.
- **Tiles provide the paths** (section 12), so a building's own stairs, wall-walks and doors are part of the walkable surfaces.
- **Walled towns always have land gates:** at least 1 for a village, 2 for a town, 3 for a city. Island towns are exempt.
- **What's read back:** only a few words, asynchronously, after an edit. The red outline and the plan's ghost are drawn straight from the GPU labels.

**Rules.**
- Never leave a planned block unreachable. Fix the world, or refuse the block.
- No timers, retries or give-ups for units that can't reach something.

**Decided 2026-11-05.**
- **The game picks the passage:** the cheapest fix, shown to the player as it's planned.
- **Reach extends as far as possible, growing with the city.** The invariant covers the city and the land around it, and the area expands as the city grows. Farther places are reached through opportunities and atlas-scale roads.
- **Passages cost like anything else.** Materials and builder time. Something cut off waits until its passage is built.

## 14. Traits and effects (agreed)

**Intent** (the user):
- "Traits are great. Super cool." "Modular architecture here is key."
- "GPU bound and cheap so we can use it on our agents" (round 120).
- Spells based on traits: "dominions and master of magic … the gold standard" (round 128c).
- Statuses are verbs on the simulation. Healing harms the undead. Necromancy raises corpses in their roles (LIVING_WORLD_v3).

**Design** (from round 120, for review).
- **Traits: one ID space for everything.** The same IDs apply to units, bodies, structures and materials.
  - **Intrinsic traits:** living, undead, flying, construct, fire-immune, regenerating, invisible, incorporeal.
  - **Statuses**, each with an expiry: burning, frightened, healing, raised, petrified, corpse, harmed, blessed.
  - A unit's traits are seeded from its kind's tags. Materials carry traits too.
- **Effects are operations put into the world:** heal, raise, damage (typed: fire, life, necrotic, physical) or apply a status, at a place and radius, as a burst or a field that lasts.
  - They reach units through modules.
  - They reach plants and structures only through those systems' own channels: the grow event for vegetation, the mend event for structures.
- **Modules are the game's rules.** Each module is its own small GPU kernel, one thread per unit, writing only that unit's slot. A module sees a prelude (units, events, traits, the tick's effects, its own table) and no other module.
  - Adding a rule compiles one kernel and touches nothing else.
- **An engine boundary.** Modules never edit the agents' step. They derive two words per unit:
  - **CAPS:** the abilities the engine reads, such as can't burn, can't drown, rooted, flees.
  - **LOOK:** materials, halo, sparks, lying as a corpse.

  "Traits are the game's data; caps and look are the engine's."
- **Corpses persist** until they're raised or decay, so necromancy can use them.
- **One vocabulary with the living world.** A pawn's or a place's traits are the same IDs the GPU uses. Traits modify opportunities ("undead work tirelessly") and drive behaviour where the player looks.

**Rules.**
- Modules never reach into another module or into the engine's internals.
- Everything stays GPU-side and cheap enough for thousands of units.

**Decided 2026-11-05.**
- **Spells are effects with a cost,** cast through the same operations: rain, lightning, fertility, raising the dead, a wall of stone.
- **Mana is the fortress's power,** possibly with mana stores built into the fortress as buildings.
- **City spells are traits on places, or fields that apply a trait to the units inside them.** Fertility, yield, ore, trade and construction speed can be a trait on a building, district or region, or a field that lasts for a duration and applies the trait to whatever is in it.
- **More traits make the fantasy richer and deeper.** There's no fixed first set: grow the vocabulary, tied to the economy and to spells as they come.

## 15. Flora (agreed)

**Intent** (the user):
- "For plants, L systems are great for branches and then cellular autonoma for roots. I am ok with stylized or low fidelity but I just want it to be readable and pretty and look integrated with the world. Plants growing on fields and being instances that way into other geometry is key" (round 117).
- "I want forests to be impressive like the cliffs. They should be seas of leaves or branches and when we pass under their canopy it should be like entering another world" (round 124).
- "we should target dota 2 style flora I think (or a lo fi variant)" (round 128b).
- The lesson of round 128b: trees approved from viewer renders were "a massive regression" in the game, so flora is judged in the game at play zoom.

**Design** (2026-11-05, replacing the earlier flora design, which the user called out of date).
- **Flora is a field that places plants,** the same way the population field places city tiles. The user: "I would treat the flora as a field for placing plants in the same way we use the population field for placing city tiles."
  - A per-column field gives the kind and density of vegetation: bare, grass, shrub, woods, crops, overgrowth.
  - A placement pass turns the field into plant instances: species, variant, size and position, from stable hashes.
  - Nothing about individual plants is stored. Growth, fire, burial and harvest change the field, and the placement follows.
  - Every consumer reads the same placement: drawing, felling, passability, towns planned against woods.
- **Flora's role in the city game:**
  - **a visual indicator of nature;**
  - **making things look overgrown and old:** ruins, walls and abandoned districts taken back by green;
  - **crops and farms.**
- **Ground interactions stay.** Roots raise the angle of repose (bounded), so a hill whose plants die can slide. Fire burns the field. Deep dust or ash makes plants dormant. Drought hurts crops (section 6).
- **Trees as objects when they matter.**
  - A tree that is felled or knocked down becomes a **physics body**.
  - A burning tree **turns to ash**.
  - A harvested tree **turns into logs when a worker grabs it**.
- **The look is to be redone.** The user doesn't love the current trees. The direction is **sprites**, and the pretty low-poly style of Dota 2 or the asset packs. To be judged in the game at play zoom.
- **Deferred:** the under-the-canopy forest effect ("very cool but not important for this game yet").
- **The update model.** Wild growth is generative: baked between runs and on story events, live only where the player grows or burns plants. Streamed land arrives with its plants settled.

**Rules.**
- One field and one placement, read by everyone. No second copy of where plants are.
- Visuals are judged in the game at play zoom, with an early check-in with the user.
- Animation is GPU only: no per-plant CPU work and no readback.

**Decided 2026-11-05.** Flora isn't simulated in play: "I think we don't need to simulate except spells and between runs and maybe replenishing forests."
- The field changes only through spells (grow, blight, fire), between runs, and possibly a slow regrowth of felled forests.
- Crops don't grow as a simulation. Farms produce, and the field's crop stage shows it.

## 16. Fauna (agreed)

**Intent** (the user):
- "Lively animated agents inhabiting our world" and "a playground for us both" (round 116).
- "rain world style procedural animation with secondary features like capes or fur … readable and look cool"; "Fill the wilderness with boids of various animals. Herds, predators that stalk" (round 117).
- "A dragon can already have fire breath that melts stone and generating wind with wings will already kick up dust and knock over agents."

**Design** (drafted from the earlier rounds; the crowd is one with the agents, per section 11).
- **Species as data.** A species is a body plan, proportions, palette, secondary parts (tails, capes, fur, wings), gear slots, abilities and a behaviour. Presets include deer, wolf, goat, bear, crow, gull, serpent, beetle and dragon.
- **Bodies are about 20 points with roles,** not skinned meshes. Spine points follow their parent, feet plant and step, knees use two-bone IK, and chains (tails, capes, fur) are verlet driven by the world's own wind. A new body plan is a function, and secondary motion is free.
- **Behaviours.**
  - Boids for herds and flocks.
  - Herds graze, and bolt from a predator they see or from a bolting neighbour.
  - Stalkers rest, stalk low, burst and knock prey down.
  - Everything avoids cliffs, deep water and fire. Wind knocks creatures over by the same rule as units.
- **Abilities go through the world's systems:** fire through the fire sim, heat through lava, a wing beat through the wind field. There's no special-case effect code.
- **Drawn as low-poly shapes on the GPU,** at true size, one thread per creature, with LOD.

**Rules.**
- Creatures read the world through contracts and act only through the world's systems.
- One crowd with the agents (section 11): species, body plan and behaviour are per-unit attributes.

**Decided 2026-11-05.**
- **Fauna is a resource and immersion first;** threats can be fun too. That means hunting and herding, livestock, and wildlife bringing the land to life, with predators and monsters as occasional threats.
- **Mounts and beasts of burden: all of them.** Horses for carts and riders, oxen, and giant creatures as siege units. They pay off the unit recipes: a recipe can turn animals and people into mounted or beast-drawn units.
- **Composable creatures are the unit builder** to iterate on with the economy: traits, abilities, stats, gear and mount linked per unit.

## 17. Towns: one plan (agreed)

**Intent** (the user, round 128m): "Why is the fortress not just another building type?"; "It should just be intervals on the map that indicate another grid owns it"; "Consolidate them"; "Generation needs to use the same system as the built town … It can do things to add plazas and roads but it should not be a different system." Also: "I would treat the flora as a field for placing plants in the same way we use the population field for placing city tiles."

**Design** (agreed in round 128m, for review here).
- **One plan per town.** A town is one grid, with its own orientation turned about the vertical axis. Each cell holds a structure, its levels (4 m each), gates and pits.
  - The generator fills the plan from the seed **through the same plan API the player uses** (paint a type, set levels, add gates). Its only extra passes are layout ones: plazas and roads.
  - The player edits the same plan.
  - There's one table of building types for generated and player buildings alike, so the same claims, reach, jobs, damage, fire, repair and raids apply to all.
- **Fields drive generation.** A population (settlement) field says how dense and what kind of town grows where, as the flora field does for plants. The tile placement rules turn it into buildings.
- **Tiles carry their rules.** Each building tile declares the paths it connects (doors, stairs, wall-walks, elevators). Roads run between neighbouring tiles of different types. Dense housing gets passages through its tiles. Large roads can be laid across the map, and the grid's roads join them.
- **The town claims its space** as External intervals naming the town's grid. Inside, a building's own material tick (section 3) happens only when needed.
- **Saving** keeps only the player's edits to the plan, keyed by world position. The generated town is re-derived from the seed. A claimed interval with no owner is an error.
- **Building in the game.** The player picks a type and paints cells. Blocks are built by builders with materials. Unreachable placements get a passage or are refused (section 13).

**Rules.**
- One building system. No second plan, grid or claim path for any kind of building.
- The generator never does anything the player's plan API can't express, except layout (plazas, roads).

**Decided 2026-11-05.**
- **The population field is a GPU field,** coarse at atlas scale and fine around a town, giving density, wealth and purpose by district. **The player's city changes it as it grows,** and generation reads it.
- **Painting stays as it is** for most buildings: pick a type, paint cells, and the tiles are chosen. The fortress may get several types of its own (keep, walls, towers and so on).
- **One home town per run (session).** Within a run, the rest of the world is reached through opportunities. Other places can be played as the home town in other runs. The user: "One town per run/session not per season". (Runs are covered in section 21.)

## 18. The fortress loop and economy (agreed)

> **2026-11-09 (round 128q):** for the strategic layer this section is superseded by the user's decision: turns plus abstract resources (Magic, Might, Labor, Resources, Intel; Unrest), resolved instantly; physical goods and carrying become presentation, with physical goods a possible later experiment. Track A rewrites this section with the user (docs/handoff/ORCHESTRATOR_A_HANDOFF.md).

**Intent** (the user):
- "shaping your city (and the world through opportunities) then making cool effects that shape the world alongside exciting battles" (round 128e).
- "People act as resources" (round 128c).
- "I want the player fortress to be something that can grow huge and impressive with spires and bridges and fountains and crystals and floating stones etc. we can adorn it with claimed prizes from opportunities" (round 128d).
- "building your fortress should add to your magic power so that players are incentivised to build ever bigger and elaborate fortresses".
- "We will want to iterate on the economic complexity and unit builder" (round 128m).
- "Let's first get this version working. I want eventually to have tons of variety and units. Fantastic creatures and armor and trade ships and flying ships and dragon riders etc. enchantments on units so we can have flying ships and bind creatures and spirits to the world."

**Design** (from round 128c onward, for review).
- **Build by painting a type.** Pick a structure type and paint cells. Neighbouring cells of a type join one structure, whose capacity, cost and output are blocks × the type's per-block numbers ("the larger the painted area, the faster it produces"). Stack levels with no height cap. Planning pauses time.
- **Shape rules make landmarks from the plan:** a lone stack becomes a tower with a spire, 2 × 2 becomes a domed drum, enclosed cells become a courtyard. Walls are tiles that fit together, with towers at the bends.
- **Power rewards height.** A fortress block gives power per day, scaled by its level. Power is mana (section 14). Mana stores may be buildings.
- **People are a resource.** Houses give beds, which fill with newcomers arriving by road, gated by food (grain per person per day), plus births in homes. Idle people take jobs on the job board in priority order.
- **Named characters come from contact.** Newcomers are anonymous; the game can make up a character on the road. A person becomes *named and tracked* once the player actually interacts with them, so they can return in later runs (continuity, section 21).
- **Every good is physical.** Each good is a visible thing that units carry, store on the ground or in stores, and that can be burnt, buried, stolen or knocked over. Builders take materials from the stores to blocks. Workers carry goods to the stores, or leave them on piles for carts on long hauls. (Today only stone and logs are physical; grain, ore and weapons are counts — to migrate.)
- **Recipes turn goods into goods, and people into units.** The smith makes ore and wood into weapons. The barracks makes a weapon and a person into a soldier. Animals become mounts and beasts of burden (section 16). Composable units come from the unit builder.
  - **Research by building:** building a recipe's requirements unlocks the next (furnaces, then steam engines, then factories).
- **Quarries grow by tiers.** Paint the footprint, and miners dig down tier by tier, with ramps spiralling round the sides. Depth is capped by how many ramps fit. Elevators come later, as tech.
- **Water and crops.** Wells, irrigation, reservoirs and mills (section 7). Drought hurts farms.
- **Time.** 1×, 4× and 16× speeds, plus skip-to-done. Planning is paused.

**Rules.**
- The economy is pure, testable logic. It touches the world only through the world's channels: claims, units, terrain take and put, reach.
- Every building type's numbers live in one data table.

- Goods chains and unit kinds are data (recipes), so variety grows without new code paths.

**Decided 2026-11-05.**
- **Get the current economy working first** (grain, stone, logs, ore, weapons, soldiers), then grow it. The long-term target is huge variety: fantastic creatures, armour, trade ships, flying ships, dragon riders.
- **Enchantments are traits on units and objects** (section 14): they make ships fly and bind creatures and spirits to the world.
- **Every good is physical.**
- **Population:** newcomers by road (gated by food) plus births. Named characters are the ones the player interacted with, tracked for continuity.

## 19. Raids and combat (agreed)

**Intent** (the user):
- "I want these raids to be the action in our run structure" (round 128c). Battle is the first threat of many (see Decided).
- "By default your agents form armies and line up inside walls (if you have them). Then you can send them out to meet enemies. Archers and ranged units should garison walls and those should fire automatically … or just let them autobattle while you cast spells" (round 128c).
- "Single click to pan and double tap to order sounds good or having a little on screen joystick to pan" (round 128c).
- Combat spells: meteors, volcanoes, summons, raised walls, heat rays, arrow bombardments; scry the army and cast storms, lightning, loosened rocks on it (round 128c).
- "the goal is to make agents satisfying during building or combat" (round 128e).
- "For now just make raids button based only" (round 128m).
- 2026-11-05: "An opportunity but for now a button is fine." "I think spells only is good for now. Dragging units to order them or exiting your wiard tower as a character are also reasonable to try." "You defend for now and conquering is opportunit mediated. Assign an army to conquer." "Definitely add them early but we can test basics first."

**Design** (from rounds 128c and 128l, for review).
- **A raid is an army coming for the city.** A rider warns ahead ("Raiders from the east, tomorrow at dusk"). The army walks in on the roads (section 12) and leaves them to attack.
- **You defend by what you built.** Archers garrison wall-walks and fire on their own; melee units form up inside the walls and meet raiders at the gate. The player can send them out and otherwise lets them autobattle while casting spells (section 14).
- **Raiders want goods and people.** Targets: the stores, then the houses. They bash the gate or the weakest wall. Losses are physical goods (section 18), buildings and people caught outside.
- **Destruction is real.** Hits go into the physics engine (section 10): walls deform and break to rubble, torched houses burn and collapse through the structure trigger (section 9). The dead and the struck become rigid bodies (section 11). A broken block becomes a planned block again; repair costs builders and goods.
- **Units are one crowd** (section 11) on flow fields to their targets, with formations later.
- **Readable at play zoom on a phone** (412×915).

**Rules.**
- No combat-only rules for damage: no hit-point walls, no `breakBlock` deleting levels. Damage goes through physics and structure.
- Projectiles are physics bodies on the GPU, not a CPU simulation.
- Combat reads unit and world state through the same channels as everything else; no CPU readback per frame.

**Today** (from the long doc): raids are button-only (`RAID.timed: false`); archers and swordsmen are one soldier kind split by post; arrows are CPU-simulated; gate and wall health are hit points; `breakBlock` removes a block and every level above it; no order UI.

**Decided 2026-11-05.**
- **Raids come through opportunities** (an approaching army is a card with stakes, section 21). For now a button starts one.
- **Battle is only the first kind of threat.** Opportunities also bring freezes, floods, droughts, migrant influxes, conspiracies, coups and revolts (section 21). The user: "Keep in mind opportunities can also add freezes, floods, droughts, migrant influxes, conspiracies, coups, revolts etc. battle is just the first." Raids must be built as one opportunity type among many, not a special loop.
- **Control is spells only** for now; units autobattle. Experiments to try later: dragging units to order them, and leaving your wizard tower as a character (section 20).
- **You defend.** Conquest is opportunity-mediated: you assign an army to an opportunity to conquer, and it resolves away from the town. Leading armies out in person is a later variant.
- **Siege engines and fantastic units early**, right after the basics (one army, walls, archers, one spell) are tested.

## 20. Heroes and play modes (agreed)

**Intent** (the user):
- "I don't think we should focus on heroes right now … Let's make a command mode and rts defense mode … a stronghold under attack or caravan/traveling group version … command and building and resource focused with epic spells" (round 128b).
- "This is not a separate game this is reprioritizing what we are implementing for run structure within this game" (round 128c).
- "Finite named characters that you can promote and then send out to take opportunities and these will be your pawns … they will be away while they carry out the job" (round 128c).
- "The game should decide and take over controls only long enough to transition with some brief auto that exits as soon as the player touches things" (round 128b).
- "Dragging units to order them or exiting your wiard tower as a character are also reasonable to try" (2026-11-05).
- 2026-11-05: "No body needed but we can use the lich if we want to play with adding one." "Only the home town for now but with plans to experiment with having your hero go out later." "Park then for now" "We will have things become pawns: armies, characters up to some reasonable number. This will take balancing and we can do it later. I would say opportunities specify what they need and if you have it and it isn't busy you can play them."

**Design** (from rounds 120–128c, for review).
- **The player is the wizard in the tower.** The default mode is command: build, cast, watch. The wizard needs no body; the lich is available if we experiment with one. Heroes return as characters in your world, not as a separate game.
- **A play mode is a camera profile + a control mapping + assists + entry and exit rules.** Command (the fortress) is one mode. Stepping out of the tower as a character is another. Modes switch inside one world; nothing reloads.
- **One physical drive for every character** (round 127): the stick is desired velocity, the drive applies the most acceleration the body allows, and gravity acts along the slope.
- **Pawns are whatever opportunities can use:** armies, named characters (section 18) and later other things, up to a reasonable number set by balancing. An opportunity states what it needs; if you have it and it isn't busy, you can play it. Committed pawns are away until it resolves.
- **Heroes from the library** (lich, hoverbike knight, knight, horse) are content for later modes and for opportunities played in person.
- **Ordering units by drag** (round 128b): drag friendly units to your character to follow, to enemies to attack, to resources to pillage; double tap selects all of a type on screen.

**Rules.**
- A character is a unit in the one crowd (section 11) with a controller attached; no separate hero physics.
- Modes go through the camera contract (composable, Node-testable camera modes), not ad-hoc camera code per mode.

**Today:** the camera contract, play modes and the physical drive are on the unmerged `herolab` and `playmodes` branches. The fortress uses the level camera with a pit-view dither.

**Decided 2026-11-05.**
- **No wizard body** for now. The lich is the body if we try one.
- **Opportunities are played from the home town only.** Sending your hero out is a later experiment.
- **herolab and playmodes stay parked.**
- **Pawns:** armies and characters, capped at a reasonable number (balance later). Opportunities declare their needs; any available, unbusy pawn that meets them can play.

## 21. Runs, opportunities, the GM and the living world (agreed)

**Intent** (the user):
- "Roguelike runs where failure and death are always possible and choices leave a lasting, visible impact" (round 83).
- "The missions should not be disjoint levels they should be objectives and situations spawned into the active map with real consequences … Like actually break a dam and flood a valley don't just say it happened" (round 120).
- "It's essentially a set of opportunities the player is presented with that resolve via encounters that can help or hinder you and that always progress you towards some climactic ending" (round 120).
- "Each opportunity is a card. It has a cost, an effect if played and an effect if not dealt with before it expires. That's the format of every card" (round 127).
- "A town the player built or a diplomatic relationship they created being threatened is far more compelling then a random named settlement" (round 125).
- "Keep in mind opportunities can also add freezes, floods, droughts, migrant influxes, conspiracies, coups, revolts etc. battle is just the first" (2026-11-05).
- "One town per run/session not per season" (2026-11-05).
- 2026-11-05: "When you lose and are destroyed or fail to or successfully deal with the big bad opportunity for the run" "The world state plus some mods based on the opportunity like the fall of your city or it is vassalized it spends in the consequence of the big bad opportunity" "Yes offline for now" "Raid only to start but we can add floods or droughts"

**Design** (from rounds 83–128, for review).
- **A run is one home town in one persistent world** (section 17), building toward one climax. Failure and death are possible. What happens leaves marks the next run inherits: terrain, towns, factions, named characters.
- **Opportunities are the one mechanism** for everything beyond moment-to-moment play: threats (raids, freezes, floods, droughts, migrant influxes, conspiracies, coups, revolts), discoveries, trade, diplomacy, conquest, research.
  - **Card format:** a cost, an effect if played, an effect if it expires. A cost is pawns locked for a while, goods spent, or (later) the player going in person.
  - **Needs, not dispatch:** a card declares what it needs; any available pawn that meets it can play (section 20). Cards run concurrently.
  - **Shown in the world, not as a hand:** a rider, a petitioner, smoke on the horizon, a frozen river.
  - **Real consequences:** outcomes are world mutations through the systems that own them (weather, fluids, population, traits, structures), visible the next time the player looks. A flood is water; a revolt is people.
- **The dealer** deals what makes sense and what you can afford, scaling with what you have (more armies → bigger cards), with stakes in what the player built and the people they know. A why-overlay explains each deal.
- **Arcs:** one primary arc per run (an army, a drought, a coup …) advancing visibly, with time to prepare. Averting the climax is a legitimate ending.
- **The living world** is a light fact layer over world state: entities (polities, factions, people, settlements, armies …), scoped tags, typed relations, claims (never control) and an append-only history. Templates are data and find "fertile situations" in it.
- **The GM** writes a run's arc from the world wiki, offline, as data (a kit), within the world's canon, checked by validators. A deterministic template fills the same contract when there is no GM file.
- **Presenters:** every card is delivered by a named person; your answer changes their relationship to you and is remembered across runs.

**Rules.**
- One opportunity contract and one dealer for every run style; raids are a card type, not a separate loop.
- Outcomes write world state through owner systems' APIs; the opportunity system never edits terrain, goods or units itself.
- One clock: the run's day counter drives cards, the economy and day/night.

**Today:** the opportunity engine and living world exist on the run path (`src/living`, `src/opps`) but nothing in `src/fortress` uses them. Three day lengths coexist (60 s economy, 480 s day/night, 600 s settlements). Raids are a separate timer/button.

**Decided 2026-11-05.**
- **A run ends** when your town is destroyed, or when the run's big-bad opportunity resolves, whether you deal with it or fail to.
- **What carries over** is the world state, plus changes set by how the big bad resolved: your city falls, is vassalised, and so on. The big-bad card's outcomes define these.
- **The GM stays offline** for now: kits written ahead, templates as the fallback.
- **First fortress cards:** the raid only. Floods and droughts come next.
- (The run length target, 15–50 minutes, wasn't revisited.)

## 22. UX and presentation (agreed)

**Intent** (the user):
- "I might have named character portraits or advisors pop up when agents come to your fortress and then tell you about things that you can assign resources to on the map and view as cards in whatever pretty and non cluttered way is possible maybe with an image generated from that area of the map" (round 128e).
- "It also can be a rider from a village under attack or a random character … thematically it fits to get petitioner's and news from agents of all kinds" (round 128e).
- "an inspect to highlight a continuous section of structure and see its output input workers and stockpiles" (round 128d).
- "Clicking workers like roller coaster tycoon to see what they are thinking about via some persistent id" (round 128e).
- The writing must be plain: "The writing is incomprehensible … fix whatever in the prompt produced that monstrosity" (round 125).
- "We should make a ux playground like we have for other views and mechanics" (round 127).
- 2026-11-05: "Have an atlas button to see the map and icons on the map that you can tap to see the card." "a wheel now with runes as an experiment" "I would keep it" (the atlas) "Let's wait for audio"

**Design** (from rounds 125–128l, for review).
- **News arrives in person.** Each opportunity is brought by a real unit through the gate (a rider, a petitioner, an advisor, your university). It shows as a clean card with a picture rendered from that place and only the resources that card needs. The raid's warning rider is the first.
- **The bar** (phone, bottom): planning (type buttons, erase, gate and tower), a one-line summary of the picked type (cost, makes, holds, workers), the plan against the stores, Build. Stores and mana at the top. Planning pauses time and is unmistakable (banner, amber frame); unbuilt blocks show as plot outlines or scaffolding.
- **Time:** 1×, 4×, 16×, skip to done (stops early with the reason).
- **Inspect:** tap a structure; it's drawn gold, with a card of type, size, progress, in and out per day, workers, stock and mana. Works on every building, generated or built.
- **Follow a person:** a card with name, doing, carrying, today, and a made-up thought from id and state; Follow puts the camera on them.
- **Spells** (section 14): runes drawn or a wheel, to compare.
- **Writing:** plain words, under 20 per sentence, concrete costs and rewards, no code words; linted in tests.
- **Close-up presentation later:** cut-away rooms and cinematic views (section 5), forest-floor and interiors as a zoom LOD rather than separate scenes.

**Rules.**
- UI reads game state through the same contracts as everything else; no UI-only state about the world.
- Every player-facing string passes the writing lint.
- UX is tried in a playground scene before it goes into the game.

**Today:** the bar, planning, time controls, Inspect and Follow exist (`src/fortress/ui.ts`, `follow.ts`); no spell or order UI; no opportunity cards in the fortress; the person card has no traits.

**Decided 2026-11-05.**
- **Cards live on the atlas.** An atlas button opens the map; each open opportunity is an icon there, and tapping it shows the card. The messenger still brings the news in person.
- **Spells:** a radial wheel now; drawn runes as an experiment.
- **The atlas stays** as the strategic screen during a home-town run (threats approaching, where pawns are).
- **Audio waits** (later, with the art push).

## 23. Persistence (agreed)

**Intent** (the user):
- "I want the world to serialize so we can recover the visited cells that change … lean towards the whole region until we know we need the other. We can stream and cache regions ahead of time even further out ahead of the camera so we never wait for them" (round 100).
- "places regenerated from the atlas data the first time you visit each run (as long as it can be deterministic from seed)" (round 114).
- "Roguelike runs where failure and death are always possible and choices leave a lasting, visible impact" (round 83).
- "I am ok with this varying per device. I understand it would be a huge effort to redo later. If we need shared worlds we can serialize the generated world for now" (section 4, 2026-11-05).
- 2026-11-05: "Yes the main point of the game is the legacy mechanic. So it definitely needs to start in the same world." "Yes ideally" (resume mid-run) "One for now is fine but slots is probably useful I believe there was a save already for the first sandbox mode that was built" "Yes this would be ideal for sharing. As mentioned until generation has floating point determinism though the saves will not be cross device compatible as diffs for now"

**Design** (from rounds 100–128m, for review).
- **Save only what play changed; derive the rest from the seed.** Derived: the atlas, every unchanged page, generated towns (plans re-made from seed), steady rivers. Saved: changed pages, grid records (section 3) with the player's edits keyed by grid id, the External intervals naming them, and the living world's state (facts, characters, holdings, history).
- **Changed means touched by play**, not the sims' own drift. A changed page is hashed and written whole when the hash differs; an unchanged page is dropped and regenerated.
- **Storage:** IndexedDB, compressed in a worker, never blocking a frame. Records carry a generator version; a record from another version, format or layout is dropped and regenerated.
- **Between runs:** the world persists. A run's end applies the big-bad card's outcome (section 21) to the saved world, and the next run starts from it.
- **Debug:** `&fresh=1` clears saved worlds at boot (play links carry it unless persistence is being tested).

**Rules.**
- Anything derived from code (plans, generated buildings, baked fields) is never saved; it carries a version and is remade. Saving derived data is how the fortress came back as stone lumps (PF-2).
- Every saved thing has one owner and one record format; no system writes another's record.
- Saving never reads back from the GPU during play beyond small async copies of changed pages.

**Today:** regions (not the new pages) are saved whole by `region-store.ts`. "A run is its own world, made fresh each run; the seed's earlier runs are pruned" — which contradicts a world persisting between runs. Agents, bodies and per-place snapshots aren't saved. PF-2 (versions on everything derived) is wip.

**Decided 2026-11-05.**
- **The world carries over between runs; this is the point of the game** (the legacy mechanic). Run 2 starts in run 1's world. Today's fresh-world-per-run behaviour must change.
- **Resume mid-run exactly** where the player left off, ideally (units, raids in progress, bodies).
- **One world for now; slots later.** Check the first sandbox mode's save before building slots.
- **Export and import for sharing.** Until generation is floating-point deterministic across devices, a save made of diffs against the seed is device-bound. A shared save must carry the generated world itself (section 4), not only diffs.

## 24. Performance and platform (agreed)

**Intent** (the user):
- Steady 60 fps on the phone with no pop-in; sims scale with activity; iso tile LOD beyond a small sim area (round 104).
- "Limit the sleep check to regions the player is acting on and essentially have the simulation scale with only the things we want active" (round 104). Storms and big battles may drop below 30 fps: "that's reasonable for a very action and simulation heavy scene."
- Readbacks are very costly on mobile; world queries run as GPU passes, with tiny async reads only after edits (2026-11-04).
- "I'm also pretty confident that if you get rid of the CPU readback, properly engineer the GPU simulation to be intelligent and parallel and follow the design performance will be fine. All the past slowdowns have been implementation issues not design." (2026-11-05)
- Every perf test is a phone bench the user runs (screen awake, downloadable report); the desktop is only a proxy (round 128).
- Tiler GPUs make per-system timestamps unreliable: diff the frame time with the system toggled (2026-11-05).
- "performance on mobile was abysmal and could not be played" (2026-11-05).
- 2026-11-05: "Floor" (the Pixel 9a) "Chrome only is fine for now. We may eventually package it as an executable or something (if that's feasible)" "Sure that's fine. It makes sense for a mobile game." (30 fps while building or paused) "I would target good performance out of the gate then use benchmarks to find what falls short. Anything that goes above we can flag and decide what to do. You'll notice a lot of the systems already try to minimize work and have a sleep state most of the time. We had close to 60fps with the streaming and system sleep behavior before the recent city and agents work so my guess is that will be the main target of work (although revisiting physics will open that back up there)"

**Design** (for review).
- **Target and floor:** the Pixel 9a (Mali Valhall) is the floor: 60 fps in normal play; heavy spectacle may dip, never below 30.
- **Build for good performance from the start, then bench.** Benchmarks (toggle diffs on the phone bench) find what falls short; anything over is flagged to the user to decide. No fixed per-system budget table up front.
- **GPU-resident world.** Queries are GPU passes. CPU reads are small, async, and only after edits or events; nothing reads back per frame.
- **Work scales with activity:** sleeping pages don't tick, the sim window is lazy, unrendered things are computed by clock (routes, caravans), quality tiers trade detail for fps.
- **Static geometry stays on the GPU,** moved by transforms; no per-slide repacks; LOD swaps only off screen.
- **Platform:** browser, WebGPU only (a clear unsupported message otherwise); phone first, desktop as a proxy and dev box.

**Rules.**
- Every change that touches a frame path ships with a phone-bench toggle diff and a play-zoom shot.
- No per-frame GPU→CPU readback in play.
- Limits (storage buffers per stage, K, material ids) are documented with what they cost us.

**Today:** the phone was unplayable after Build; suspected readbacks (the world API mirror at 139 MB/s, the field reader at 16 MB/s, unit sync, valley reads). The `phonefix` branch cut reads to 4.3 MB/s, untested on the phone.

**Decided 2026-11-05.**
- **The Pixel 9a is the floor.**
- **Chrome only** for now. Packaging as an executable may come later, if feasible.
- **Cap at 30 fps while building or paused** to save battery.
- **No budget table up front:** build well, bench, flag what's over. Streaming plus sleeping systems ran near 60 fps before the city and agents work, so the city and agents are the main target; physics will reopen it when revisited.

## 25. Process (agreed)

**Intent** (the user):
- "A pattern I'm seeing emerge is agents are building systems poorly then wasting cycles debugging bad design and hacky patches. It also seems like they are not desrisking things like visuals, performance or edge cases during development" (2026-11-05).
- "Are you still doing the thing where you build thoughtfully and correctly and explicitly document or call out anything hacky or non modular to me?" "That should be in your context always" (2026-11-05).
- "Pause development and let's talk through fixing it and getting the code into good shape" (2026-11-05).
- "The intent was documentation stores why and caches expensive to rederive things like summaries of complex systems and architecture and then code documents all implementation" (2026-11-05, on metacognition).
- 2026-11-05: "Stick with the convention I believe initially it was .Claude folder but I'm not certain" "Probably have agents compare this doc against the code and architecture and then write up work to do. Prioritize functionality and fixing the performance of towns and making them actually work the way I described first" "As long as you review and it is trying to hit this design it only needs to raise to me and pause mid session for significant changes or hacks. Otherwise surface small changes at the end with justification for why they were necessary and alternatives considered." "I think yes they should resume but as I said use the doc to audit and then decide what makes the most sense"

**Design** (the working rules, from AGENT_RULES and memory, for review).
- **This document is the design authority.** Code that disagrees with it is a discrepancy to list and fix, or a design question for the user. Changes to it are agreed with the user.
- **Design before code.** A new feature track starts with an interactive design session with the user; agents start only after. Each change starts with a short design note (what, where in this doc, which contracts, the riskiest part).
- **Riskiest part first:** a perf toggle diff on the phone bench, a play-zoom shot judged in game, edge cases as unit tests, before the rest is built.
- **No patches.** Fix root causes; flag structural problems early. No thresholds, nudges or special cases to hide a bug.
- **Hacks and limits** end every report, mine and agents', even when empty.
- **When to stop and ask the user:** work that I (the main session) review and that aims at this design goes ahead. Significant changes or hacks are raised to the user mid-session, and work pauses for an answer. Small changes are surfaced at the end with why they were needed and the alternatives considered.
- **Small finished slices** that meet the vision when a link goes out. Tests first in Node, lab scenes over full-game runs, real-town fixtures for gates.
- **Docs travel with code:** DEVLOG (why), DECISIONS (the user's words), ARCHITECTURE (contracts), BACKLOG (everything open). Metacognition indexes docs and code by line; agents search it first.
- **Branches:** one integration branch; a worktree and port per branch; merges gated by tile coverage, frame time and a looked-at shot; ask before pushing main.
- **Links:** play links carry `&fresh=1` unless persistence is being tested.
- **Security:** Unity Asset Store packs never enter the public repo or the Pages build.

**Rules.**
- No agent work without a design note tied to a section here.
- Agent messages are never user approval.

**Decided 2026-11-05.**
- **This document lives at `.claude/docs/design/DESIGN.md`** (the original design-authority folder) and is the design authority. `Reclaimed_Overview.md` there is the original sandbox handoff, kept for history.
- **Restart:** agents audit this doc against the code and architecture and write up the work to do. First priority: towns working the way this doc describes, and their performance.
- **Review:** the main session reviews; agents raise only significant changes or hacks to the user mid-session; small changes are listed at the end with justification and alternatives.
- **Paused branches resume** where the audit says that makes sense (phonefix, townlab, onetown, builders); the audit decides per branch.
