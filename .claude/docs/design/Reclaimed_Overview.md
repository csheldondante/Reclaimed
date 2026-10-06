# Reclaimed — Prototype Handoff

## Purpose of this document

Build a small, highly polished browser game/prototype called **Reclaimed**.

This document describes the intended experience, visual identity, gameplay philosophy, and a suggested technical direction. The technical sections are **hypotheses to test, not dogma**. Prefer the simplest implementation that produces the intended experience, but structure the code as modular systems with clear data contracts so individual implementations can be replaced later if profiling or visual quality justifies it.

The goal is not to build a general-purpose engine. The goal is to get to a compelling playable loop quickly, learn from it, and improve only where the prototype demonstrates value.

\---

# 1\. Game thesis

The game is an atmospheric, systemic physics sandbox in which **the player effectively plays as nature reclaiming the ruins of human civilization**.

The world begins polluted, damaged, artificial, and quiet. The player's tools are not construction tools or weapons but natural processes (processes work via shared systems when possible so they do not need to recreate complex systems per process):

* **Storms and rain** — wash pollution and movable debris away.
* **Lightning** — can be called down under passing storms.
* **Wind** — moves dust, leaves, light debris, smoke, and contaminants.
* **Cyclones** — break down large structures; the player can influence their general direction, but they wander according to terrain and weather.
* **Flooding and waves** — break structures, move debris, redistribute sediment, and carry contaminants away.
* **Fire** — consumes appropriate materials and can trigger industrial cascades, but is not universally effective.
* **Earthquakes** — the player chooses an epicenter/intensity and the world determines what actually fails.
* **Erosion and mudslides** — move soil and debris downhill, often feeding material into rivers or floods and breaking things in their path.
* **Vegetation and ecological succession** — once an area becomes sufficiently healthy, life returns and begins reclaiming the remains.

These forces are deliberately **semi-controllable**. The player initiates or influences natural processes rather than precisely manipulating individual objects.  They get fun visual feedback and ambiance.

The emotional arc is:

**desolation → destruction → cleansing → recolonization → abundance**

The prototype should optimize for becoming **beautiful, tactile, technically interesting, and immediately understandable** as quickly as possible.

A visitor should ideally understand the fantasy within seconds and want to interact with it.

### Why this theme

The spectacular actions may initially resemble a destruction sandbox, but destruction is not the goal. Destruction is useful only when it removes barriers to ecological recovery.

That creates an unusual emotional inversion:

* Breaking a dam can be constructive.
* Collapsing a factory can expose contaminated soil to rain and erosion.
* A flood can be destructive in the short term but allow a valley to recover.
* Ruins do not need to disappear; they can become habitat.

The desired feeling is not "destroy civilization." It is **watching natural systems solve the remains of a broken machine**.

\---

# 2\. Theme and visual direction

The setting is the abandoned remains of industrial civilization.

Potential environments include:

* Ruined cities
* Factories and refineries
* Dams and reservoirs
* Power infrastructure
* Seawalls and coastal developments
* Contaminated waterways
* Abandoned industrial sites
* Concrete megastructures
* Landfills and debris fields
* Overgrown transportation infrastructure

The world should initially feel **quiet and lonely**, not overtly horrific. Avoid making the presentation primarily about death, gore, or apocalypse spectacle.

The central visual contrast is:

**rigid / artificial / dead** vs. **organic / dynamic / alive**

At the beginning of a level, human geometry should dominate: concrete, steel, asphalt, industrial waste, polluted water, exposed machinery, and hard rectilinear forms.

As the level improves, those forms should fracture, soften, become stained by water and sediment, and eventually become obscured by moss, grasses, shrubs, roots, trees, and animal life.

Buildings should start already somewhat ruined to represent the passage of time.

## Visual style

Use a **top-down/isometric voxel/pixel world**, not conventional 3D realism.

A world cell should occupy roughly **1–10 screen pixels depending on resolution**. The result should read as detailed pixel/voxel art while still supporting:

* Lighting and shadows
* Emissive materials
* Transparency
* Water
* Smoke/dust/rain
* Material destruction
* Large-scale environmental simulation

The isometric perspective and dynamic material behavior should give the game an immediately recognizable visual identity.

### Rationale

The stylization serves both aesthetics and engineering:

* Small geometric errors are less visually damaging than in realistic 3D.
* Grid-aligned simulation can look intentional rather than approximate.
* Low-resolution material behavior can still be visually expressive.
* A fixed or constrained camera simplifies rendering, culling, visibility, and simulation representation.
* It should allow a technically ambitious world to run across a wider range of devices than a photorealistic approach would.

\---

# 3\. Atmosphere and sound

Atmosphere is a core part of the game, not decoration.

Avoid filling the experience with UI, narration, or constant music. Environmental sound should carry much of the emotional state.

Possible sounds:

* Wind
* Distant thunder
* Rain
* Flowing water
* Crumbling concrete
* Structural groaning
* Rocks and debris falling
* Arcing electricity
* Machinery winding down
* Fire
* Insects
* Birds
* Leaves and branches
* Water moving through increasingly healthy environments

A dead level might contain little more than wind and rattling debris. Harsher sounds such as machinery or electrical arcing should be used sparingly to draw attention to important map features.

As ecosystems return, the soundscape should become continuously richer. Prefer ecological ambience that responds to world state over abrupt "level complete" audio transitions.

A restored level should sound alive.

\---

# 4\. Menu and persistent progression visualization

Use the main menu itself to communicate the game's progression.

Begin with a small scene showing **a skull or bones lying in barren soil and debris**. The bones should read as matter-of-fact remnants of the old world rather than horror imagery.

At the beginning:

* Trash and dust dominate.
* Wind blows scraps across the scene.
* The air is dirty and dry.
* Little or nothing is alive.

As levels are completed, the same scene gradually changes.

### Beginning

Skull/bones, trash, dust, dirty air, wind.

### Early progress

Some garbage has blown away or decomposed. Soil becomes exposed. Worms and small invertebrates appear.

### Further progress

The air becomes clearer. Lichens and moss begin colonizing hard surfaces.

### Later

Grass appears. Small plants grow through debris. Insects become more common.

### Completion

A tree grows from or through the reclaimed site and dominates the composition. The bones and remnants may still be present, but they are now part of a living environment.

### Rationale

This should not feel like a conventional progress bar. It should be a miniature ecological narrative that continually reinforces that the game is about **recovery rather than destruction**.

It also creates a satisfying persistent transformation without requiring a complicated metagame.

\---

# 5\. Background narrative

Levels should gradually imply what happened to humanity through environmental details rather than exposition dumps.

A possible background arc is that much of humanity gradually moved into machines or artificial forms of existence, leaving the physical world increasingly empty. Some people chose to remain embodied and live finite natural lives.

This does not need to be explained explicitly in the prototype. Treat it as environmental-storytelling material that can emerge through ruins, interfaces, abandoned infrastructure, monuments, recordings, or visual clues if the project develops further.

The prototype does **not** need a narrative system.

\---

# 6\. Core gameplay philosophy

The player should not feel like a god using a terrain editor.

They should feel like they are **nudging natural systems**.

Do not let the player simply paint water, delete structures, or directly place vegetation wherever they want during normal level play.

Examples:

> A player summons a storm but it moves across the terrain according to terrain conditions and map settings. The player can influence what happens and this needs to feel responsive without feeling unconstrainted.  Underneath the storm, players can periodically call down lightning or strong winds to blow in a direction or flooding rains.

> The player specifies an earthquake epicenter and perhaps intensity, but does not specify exactly which structures fail.

> The player can influence a cyclone's general direction by dragging it to change prevailing winds, but the terrain and simulation determine its exact path and consequences.

This controlled unpredictability is important. The world should feel like a collection of interacting systems rather than a set of animations responding directly to clicks.

A separate sandbox mode can expose more direct control later.

\---

# 7\. Level structure and nature resource

Normal levels should be light puzzle/systems challenges while remaining calm and exploratory.

The player gains a **Nature resource** from reclaimed/healthy areas. For an early prototype, use the simplest readable rule:

* Healthy/reclaimed cells contribute to a slowly regenerating Nature resource.
* Large interventions such as storms, earthquakes, or cyclones cost Nature.
* Environmental chain reactions cost nothing after they have been triggered.
* Efficient play comes from identifying leverage already present in the environment.

For example, spending a large amount of Nature directly eroding an industrial district should be worse than spending a small amount to break a dam and allowing the resulting flood to do the work.

The exact economy should remain easy to tune. It is primarily intended to:

* Give the player strategic choices.
* Reward understanding the environment.
* Encourage cascades instead of repetitive clicking.
* Make increasing ecological health mechanically useful as well as aesthetically satisfying.

Avoid hard fail states in the first prototype unless they prove necessary. If the player spends poorly, slow recovery is preferable to becoming permanently stuck.

\---

# 8\. Interactive environmental opportunities

Levels should contain structures and conditions that create cascading interactions.

Examples:

* Dams that can fail
* Seawalls that can breach
* Contaminated reservoirs
* Volatile industrial chemicals that can react or explode
* Unstable slopes that can become mudslides
* Calderas or geothermal systems that can rupture
* Abandoned structures that can collapse into waterways
* Pollution that rain can gradually wash away
* Terrain where erosion redirects water
* Electrical systems that can arc or ignite material
* Debris piles that block drainage

These should produce chains of consequences rather than isolated canned events.

Example:

> lightning → industrial fire → tank rupture → structural collapse → rain extinguishes fire → runoff carries contamination downhill → floodwater removes/dilutes contamination → clean sediment remains → moss colonizes the rubble

We do not need enormous numbers of interactions initially. **A few systems that genuinely compose are more valuable than dozens of scripted effects.**

\---

# 9\. Engineering philosophy: simplest implementation, replaceable systems

This is important.

## Start simple

Implement the simplest version of each system that can test whether the experience is fun and visually convincing.

Do **not** implement a sophisticated optimization because it seems theoretically elegant. Measure first.

Examples:

* If a full-grid compute pass is already fast enough, use it before building sparse GPU work queues.
* If grid-aligned falling rubble looks good, use it before implementing arbitrary rigid-body rotation.
* If column-volume water looks convincing, do not build a particle fluid solver.
* If a fixed rendering representation works at all relevant zoom levels, do not build multiple LOD paths.

## Be Smart

We care about the experience more so than specifics.  So if it is expensive to render clouds with transparency rolling across the map, render the shadows of the clouds and a rain effect under them.  Do what is easy and effective first.



## But keep systems replaceable

Simple does **not** mean monolithic.

The world should be organized as modules with explicit inputs/outputs so individual implementations can be replaced without restructuring the game.

Examples of separable systems:

* Rendering
* Material simulation
* Water transport
* Structural stability
* Rigid-body/chunk physics
* Weather
* Contamination transport
* Fire
* Vegetation/ecology
* Audio state
* Gameplay resource/progression

A later water implementation should be able to replace the initial water tick without changing level logic, rendering semantics, or vegetation code.

Similarly, rigid-body fracture should be addable later without rewriting the underlying material/world representation.

## Benchmark before escalating complexity

Keep lightweight performance instrumentation available from the beginning:

* GPU frame time
* CPU frame time
* Simulation time by system
* Active cell count
* Visible cell/face count
* Draw/dispatch count
* Buffer/texture memory estimates

Use those measurements to decide when an optimization is warranted.

### Rationale

This preserves rapid prototype velocity while avoiding a dead-end architecture. The prototype should be easy to improve, not pre-optimized for hypothetical problems.

\---

# 10\. Platform target and device compatibility

The primary target is a **browser experience using TypeScript + WebGPU**.

The project should work on as many reasonably modern devices as practical, including integrated GPUs and mobile devices where WebGPU support and resources are sufficient.

Do not sacrifice the core simulation to support extremely old hardware, but avoid unnecessary assumptions about high-end desktop GPUs.

## Compatibility principles

* Use WebGPU feature/capability detection.
* Prefer core WebGPU features and conservative formats/limits unless a measured benefit justifies something more specialized.
* Avoid unnecessary CPU↔GPU readback in the frame loop.
* Avoid algorithms whose minimum buffer or workgroup requirements exclude common integrated/mobile GPUs without a compelling reason.
* Make simulation resolution, map size, particle budgets, shadow quality, effect density, and render scale tunable.
* Prefer a few broad quality tiers rather than dozens of graphics settings.
* Keep simulation logic deterministic enough that reducing visual quality does not fundamentally alter gameplay where possible.
* Handle resize, device pixel ratio, orientation, and reduced viewport sizes cleanly.
* Provide a clear unsupported-device message rather than failing silently.

## Do not build fallbacks

Prefer simplicity to robustness and just give clear not supported messages.

Do not add fallbacks or heuristics.  Fail loudly and try to diagnose and fix failures or surface them as limitations to the user.

Start with WebGPU and broad WebGPU compatibility. If unsupported-device traffic later proves important, treat a fallback renderer as a separate product decision.

### Suggested quality scaling

A lower-performance device should first reduce:

1. Render resolution / supersampling
2. Shadow and lighting quality
3. Particle and debris visual budgets
4. Environmental-field resolution
5. Maximum active simulation work per frame
6. Level/map size if necessary

Preserve the systemic interactions as long as possible.

\---

# 11\. High-level technical architecture

Treat this as a direction to test, not a requirement to implement all at once.

Prefer:

**TypeScript + WebGPU**

Keep the hot world/simulation state GPU-resident wherever practical.

Use CPU/TypeScript primarily for:

* Input
* Menus and UI
* Level orchestration
* Audio coordination
* Loading/assets
* High-level game rules
* Debugging and profiling
* Small aggregate state readbacks when needed

### Rationale

The game consists largely of spatial fields and local rules, which map naturally to GPU compute.

It is also intended as a browser-accessible technical showcase: a visitor should be able to click a link and immediately play it.

\---

# 12\. Canonical world representation

Do **not** begin by building a fully general dense XYZ voxel engine.

Represent most world geometry as an **XY grid whose columns contain a small number of ordered vertical material intervals**.

For example:

```text
Column(x, y)

interval 0: \[zMin, zMax] material A
interval 1: \[zMin, zMax] material B
...
```

These intervals may be separated by empty space. They are not simply eight adjacent voxels.

A column could represent:

```text
grass
soil
rock
```

or:

```text
roof
air
floor
air
ground
```

I would recommend storing instancable objects as a buffer with stride that defines num layers, x, y footprint then I would instance into a chunked world representation that uses the same stride to define the shape of each cell in a shared buffer.  I expect many cells to have a only a few layers<8 and only a few places such as cities to have more layers (due to ruins with material/air gaps) in a small footprint.  For generating the assets you can do it in code for now (noise for terrain or heightmap data, basic shapes for buildings or we can voxelize purchased or generated meshes.  I recommend vegetation we grow)


### Material table

Material IDs should point to a shared material table rather than duplicating material properties per cell.

Possible material properties:

```text
Material {
    albedo
    emissive
    roughness/specular
    opacity

    density
    state/type       // solid, granular, liquid, gas, vegetation, etc.

    burnability
    contamination behavior
    erosion behavior
    growth compatibility
    simulation parameters
}
```

Pack storage where useful, but do not make packing complexity an early blocker.

### Rationale

Most scenes do not require arbitrary dense 3D occupancy.

A conventional XYZ voxel grid spends memory and computation representing empty space. A layered representation preserves useful vertical structure while remaining compact.

\---

# 13\. Terrain, objects, and ownership rules

Keep the ownership model simple and explicit.

## World-space terrain

Terrain and settled material are represented in the canonical world-space column grid.

## Local-space objects

Complex objects can retain their own local voxel/material representation and transform until they need to merge into or meaningfully interact with the world representation.

Examples:

* Large buildings
* Bridges
* Trees
* Machinery
* Dams
* Complex ruins

An object can be stored in an atlas or asset library and instanced into the level.

## Environmental fields

Fields such as contamination, moisture, rainfall, and vegetation potential live in world space and should not care whether visible geometry originated as terrain or an object.

### Rationale

The 1–8 interval column representation should optimize the common case rather than forcing every complex object into the same storage format.

\---

# 14\. Orthographic/isometric rendering

Initially use a fixed or tightly constrained orthographic/isometric camera.

A conceptual projection is sufficient:

```text
screenX = (x - y) \* scale
screenY = (x + y) \* scaleY - z \* scaleZ
```

Use normal GPU depth testing for overlap.

Experiment with rendering directly from the canonical representation rather than requiring a conventional scene graph for every cell.

A possible future zoom-dependent representation is:

* **Far:** projected height/material representation
* **Medium:** top surfaces plus exposed vertical interfaces
* **Near:** explicit visible voxel faces

However, do **not** implement multiple rendering paths until profiling or visual quality requires them. One straightforward path that works across the intended zoom range is preferable for the first prototype.

### Rationale

The constrained camera is part of the visual identity and removes a large amount of complexity associated with arbitrary 3D viewpoints.

\---

# 15\. Static vs. active matter

Do not continuously run expensive physics over matter that is not changing.

Conceptually distinguish between:

## Static solids

Terrain/buildings that are stable do not need per-cell dynamic physics.

For the earliest prototype, simply leaving them represented in the grid may already be fast enough. Only add baking/meshing optimizations if measurement shows they help.

## Active granular/material cells

Only material currently moving or changing needs active simulation behavior.

Examples:

* Soil
* Sand
* Rubble
* Mud
* Ash
* Water interfaces

## Dynamic solid chunks

Eventually, disconnected structural pieces may become rigid chunks.

A rigid chunk would simulate something like:

```text
position
orientation
linear velocity
angular velocity
```

rather than independently simulating every constituent cell.

### First implementation

Do **not** make arbitrary rigid-body rotation a prerequisite for the destruction prototype.

Start with grid-aligned structural failure / falling chunks if that looks acceptable. This avoids early complexity around collision, rotated voxel rendering, and rasterizing settled chunks back into the world.

If the result looks insufficient or profiling shows that chunk-level rigid bodies are the correct optimization, add a rigid-body implementation behind the same structural-physics interface.

### Rationale

Representation should follow behavior. Most of the world is static most of the time.

\---

# 16\. Material simulation and active work

The simulation layer is likely the most important part of making the game fun.

Start with simple local material rules similar to classic falling-sand / cellular physics systems:

* Gravity
* Density ordering
* Flow to available lower neighbors
* Angle of repose for granular material
* Basic liquid spreading
* Local material interactions

## Start with the simplest dispatch strategy

A full-grid or chunk-grid compute pass may be entirely adequate for early levels and can be much easier to reason about.

Do that first if practical.

## Upgrade path: active-cell/chunk work queues

If profiling shows full-grid simulation is wasteful, replace the implementation with GPU-managed active sets/work queues.

Conceptually:

```text
active cells/chunks
      ↓
material update
      ↓
changed neighbors
      ↓
new active work
      ↓
repeat on later ticks
```

Once a region reaches equilibrium, it stops consuming simulation work.

### Rationale

We want an architecture capable of making cost proportional to changing regions, but we should not pay the engineering cost until it is useful.

\---

# 17\. Water simulation

Water is likely the most continuously dynamic material, but it still does not require full fluid dynamics.

## First implementation

Start with **column-volume/local hydraulic equalization**.

A cell/column tracks available water volume or water intervals. Each simulation tick exchanges water with neighboring cells based on local height/hydraulic differences and capacity.

This only needs to look and behave plausibly enough to support:

* Rain runoff
* Flooding
* Reservoir release
* Dam/seawall breaches
* Contaminant transport
* Erosion triggers

Do not attempt globally high-resolution Navier-Stokes simulation.

## Possible upgrades if warranted

The water system should expose a stable interface so its internal tick can later become more sophisticated without changing gameplay logic.

Potential upgrades:

* Active-interface-only simulation
* Coarser representation for stable bulk water
* Finer simulation near boundaries
* Particles for splashes, waterfalls, spray, or violent breaches
* More sophisticated shallow-water methods

Conceptually:

```text
stable bulk water
      ↓
coarse column representation

moving interface
      ↓
active local simulation

splash / waterfall / breach
      ↓
optional fine cells or particles
```

### Rationale

The interior of a large stable body of water contains relatively little useful visual information. Interesting behavior is concentrated at surfaces, boundaries, and rapidly changing regions.

But start with the simple version and only increase resolution where the game benefits from it.

\---

# 18\. Structural destruction

Structural destruction should initially favor **readability and satisfying cascades** over engineering realism.

A simple first model might use:

* Connectivity to supporting material
* Local support thresholds
* Material strength
* Damage/fire/erosion modifiers
* Gravity when support is lost

Potential behaviors:

* Unsupported cells fall.
* Connected regions can be treated as chunks.
* Large components can break into cached/precomputed variants if that is visually sufficient.
* A later rigid-body system can replace the simple falling-chunk behavior.

Do not build a general finite-element structural solver.

### Rationale

The player needs structures to fail in ways that look systemic and create new environmental opportunities. Exact structural engineering is not the product.

\---

# 19\. Environmental fields

Several systems should be represented as relatively cheap world-space textures/fields rather than geometry.

Possible fields:

* Contamination
* Moisture
* Temperature
* Wind
* Rainfall
* Storm influence
* Fire intensity
* Nutrients / ecological suitability if useful

These can use different resolutions according to their needs.

For example, contamination can be a scalar field transported or diffused by water and wind rather than a separate set of physical particles.

### Rationale

This creates inexpensive emergent behavior and clean interfaces between systems.

\---

# 20\. Weather and storms

Storms should primarily be **fields that cause effects**, not atmospheric fluid simulations.

A comparatively low-resolution moving storm field can affect:

* Rainfall
* Wind
* Cloud/shadow appearance
* Lightning availability/probability
* Wave intensity

Cloud visuals can use procedural noise, particles, or simply cloud shadows/rain walls if that produces the desired atmosphere cheaply.

Lightning can be available only within the storm/rain region.

### Rationale

Spend computational effort on the consequences the player can interact with rather than simulating atmospheric dynamics for their own sake.

\---

# 21\. Contamination and ecology

Pollution should generally be a **harder ecological blocker** than ruins themselves.

A building does not need to be completely removed for an area to count as reclaimed. In fact, forests and moss growing over recognizable human ruins are central to the visual identity.

Certain contaminants, however, may need to be removed, diluted, buried, neutralized, burned, or carried away before plants can thrive.

This avoids turning the game into "clean every voxel."

\---

# 22\. Ecological succession

Vegetation is well suited to a cellular/systemic approach.

A conceptual progression might be:

```text
bare healthy substrate
        ↓
lichen / moss
        ↓
grass
        ↓
shrubs
        ↓
young trees
        ↓
mature vegetation
```

Growth should depend on local conditions rather than merely playing an animation.

Possible inputs:

* Contamination
* Moisture
* Temperature
* Material/substrate
* Nearby vegetation
* Light/shade if useful

Growth can spread probabilistically.

Large plants can eventually become lightweight objects if needed, but do not require that for the first ecological prototype.

### Rationale

This is computationally cheap, visually expressive, and central to the fantasy. The player should be able to watch life visibly propagate through the ruins after creating suitable conditions.

\---

# 23\. Suggested system boundaries

Keep these conceptual boundaries even if the first versions are very simple:

```text
World/Material Storage
    ↓
Weather System
    ↓
Material Physics System
    ↓
Structural System
    ↓
Water Transport System
    ↓
Contamination System
    ↓
Ecology System
    ↓
Visibility/Render Preparation
    ↓
Renderer
```

Gameplay/resource logic observes aggregate state rather than reaching into individual system internals.

For example, it may read values such as:

```text
pollutionRemaining
vegetationCoverage
healthyArea
cleanWaterFraction
natureResource
```

The exact GPU pass ordering can evolve as implementations change.

### Important design rule

Systems should communicate through world state or explicit buffers/textures, not through hidden assumptions about another system's implementation.

This is what allows us to replace a simple water tick with a better one later.

\---

# 24\. Simulation timing

Prefer a fixed or semi-fixed simulation timestep decoupled from visual rendering.

The renderer should be able to run at the display rate while expensive ecological or field simulations run less frequently if appropriate.

Examples:

* Material/gravity tick: relatively frequent
* Water tick: frequent enough to look responsive
* Weather field: lower frequency
* Contamination diffusion: lower frequency
* Vegetation growth: much lower frequency

Interpolate visual state where helpful rather than forcing every system to run every rendered frame.

### Rationale

Different systems have very different temporal requirements. This is an easy way to preserve gameplay on lower-power devices without compromising the conceptual simulation.

\---

# 25\. Suggested early development sequence

The most important instruction is: **get an end-to-end playable transformation loop running before investing heavily in any individual subsystem.**

## Milestone 0 — Put the world on screen

Goal: validate the basic technical stack.

Implement:

* WebGPU initialization and capability checks
* Fixed isometric camera
* Small sloped test map
* Basic material table: air, soil, stone, water
* Direct world rendering
* Camera pan/zoom
* Simple performance overlay

Use procedural placeholder content.

Do not build an asset pipeline yet unless necessary.

## Milestone 1 — Make matter react

Implement the simplest useful versions of:

* Gravity/material movement
* Water moving downhill
* Rain adding water
* One contamination field
* Contamination moving with water

Allow the user to spawn a storm/rain region for testing.

## Milestone 2 — Complete the recovery loop

Add:

* Vegetation suitability
* Moss/grass spreading into clean suitable areas
* Basic ecological ambience response
* A minimal Nature resource derived from healthy area

At this point, it should already be possible to go from polluted/barren terrain to visibly recovering terrain.

## Milestone 3 — Add one satisfying destruction interaction

Add:

* One simple concrete/industrial structure
* Lightning interaction
* Basic damage/support failure
* Falling/grid-aligned rubble

Target loop:

> rain falls → water moves downhill → contamination moves/dilutes → player calls lightning → structure fails → rubble settles → rain cleans newly exposed terrain → moss/grass spreads → soundscape becomes more alive

If this feels good, the core prototype is working.

## Milestone 4 — Add leverage

Add one map-scale cascading opportunity:

* Dam failure, or
* Seawall breach

This should demonstrate that spending Nature to trigger the correct environmental chain is more effective than brute force.

## Milestone 5 — Profile before expanding

Before adding more phenomena, measure:

* GPU/CPU frame time
* Simulation passes
* Memory use
* Scaling with map size
* Behavior on integrated/mobile hardware

Then decide whether any simple implementation needs replacement.

Potential next systems only after this point:

* Earthquake
* Fire
* Cyclone
* Mudslide/erosion improvements
* Rigid-body chunks
* Better water
* Larger maps

\---

# 26\. First prototype map

Build one small test landscape containing:

* Sloped terrain
* Water
* One polluted region
* One concrete/industrial structure
* Some destructible material
* One patch capable of supporting vegetation
* One environmental feature with potential leverage if feasible

The map should be designed to expose the systems, not to prove content production.

Procedural blocks and intentionally simple voxel art are acceptable early.

\---

# 27\. Prototype priority

Prioritize in roughly this order:

**visual readability → satisfying interaction → complete transformation loop → emergent interaction → performance → content breadth**

Do not prematurely build:

* A full level editor
* Huge imported cities
* Elaborate progression
* Many natural disasters
* Sophisticated UI
* General-purpose physics
* Arbitrary 3D camera support
* High-fidelity fluid simulation
* Arbitrary rigid-body voxel rotation
* A WebGL compatibility renderer
* Large asset pipelines

\---

# 28\. Success criteria

The prototype should answer two questions.

## Technical question

> \*\*Can a browser render a beautiful isometric ruined landscape in which physical and ecological systems visibly transform the world at interactive frame rates on a reasonable range of modern devices?\*\*

## Game-design question

> \*\*Does causing targeted destruction and environmental cascades in order to make room for nature feel satisfying, peaceful, and meaningfully different from an ordinary destruction sandbox?\*\*

If those answers are yes, expand from there.

The north star remains:

> \*\*Watching nature solve a ruined machine.\*\*

\---

# 29\. Guidance for the coding agent

When choosing between approaches:

1. Prefer the smallest implementation that tests the game hypothesis.
2. Keep system boundaries clean enough that an implementation can be replaced later.
3. Profile before optimizing.
4. Preserve broad device compatibility unless a more demanding approach produces a clearly visible gameplay benefit.
5. Prefer systemic interactions to scripted sequences.
6. Prefer a complete rough loop to one highly polished isolated subsystem.
7. Keep the project runnable throughout development.
8. Record significant architecture choices and the benchmark/visual reason for making them.

If an architectural decision becomes uncertain, implement the cheaper option first behind a clean interface and test it in the actual game.

