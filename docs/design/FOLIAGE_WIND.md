# Wind-Responsive Foliage — GPU Experiment Handoff

## Motivation

The game already has a largely **GPU-resident, reactive world**: wind, terrain deformation, flowing material, structural collapse, and growing flora. Its current visual style is intentionally **lo-fi and pixelated**, viewed from a **rotatable isometric camera**. Vegetation is comparatively static. The desired improvement is modest but evocative: **gusts sweeping visibly across tall grass, ripples moving through tree canopies, leaves fluttering and occasionally blowing away, and foliage rustling in response to the same wind that drives the rest of the world**.

This is **optional visual polish**, not a new simulation system. The goal is to find the *simplest sufficiently attractive* implementation that runs comfortably on a phone alongside the existing GPU workloads. **Do not build every technique.** Begin with the most promising options, view them at real gameplay scale, benchmark them on-device, and move down the list **only when a simpler option fails on appearance or performance**.

### Design constraints

- **GPU-only runtime animation.** Prefer instanced draws, vertex and fragment shaders, and the existing GPU wind field. Use a compute pass only when it earns its cost. No CPU-side per-plant animation, no per-frame GPU readback of foliage/wind state, and no CPU fallback. CPU setup/asset generation and rendering commands are fine.
- **Reuse the world-space wind signal** so gusts pass coherently from meadow to forest. Test a deterministic traveling gust, a strong steady wind, and a direction reversal. Allow a procedural test signal if the lab cannot easily sample the engine's wind texture.
- **Optimize for projected appearance**, including a rotating camera and real gameplay zoom. Individual leaves or grass blades may be only a few pixels or subpixels; apparent motion matters more than microscopic fidelity.
- **Avoid premature infrastructure.** Reuse existing materials, plant instances, and geometry whenever possible. Retain the ability to lower density/quality or turn foliage animation off entirely.
- Beware **overdraw, texture bandwidth, and pixel coverage** as well as arithmetic cost. Very cheap per-instance animation can still lead to an expensive forest if it draws overlapping transparent quads.

## Prioritized experimental matrix

*GPU risk and effort are hypotheses, not measured rankings. “Grass” and “Trees” specify the useful trial, not separate rendering engines.*

| Order | Technique / GPU mechanism | Grass experiment | Tree experiment | Why try it / main risk | Decision |
|---|---|---|---|---|---|
| **0 — required** | **Static baseline:** identical representation with wind disabled | Current grass tufts/cards | Current tree representation | Establish base cost and visual reference | Always build |
| **1A — first** | **Wind-shading ripple** *(fragment shader)* | Traveling shifts in brightness, normals, color or perceived density across meadow | Subtle canopy highlight/shadow flutter | Very small implementation; visually effective at low resolution; does **not** move silhouette | Keep if compelling; supplement with 1B/1C if not |
| **1B — first** | **Instanced vertex bending** *(vertex shader)* | Root-anchored, subdivided tuft cards or minimal blade meshes; bend tips along wind | Bend whole canopy masses/low-poly foliage clumps | Readable geometry motion for few operations; rigid cards if too few vertices | Primary grass candidate |
| **1C — first** | **Coarse 3D deformation lattice** *(vertex shader, analytic field)* | Optional test on tufts | Low-poly 3D canopy/branch mesh deformed by a few spatial control points, with trunk base anchored | Wind ripples through canopy while preserving camera-rotation parallax; may look rubbery or require more vertices | Primary tree candidate |
| **2A — only if needed** | **Sprite/texture warp** *(fragment UV displacement or subdivided card vertices)* | Warp tuft sprite or grass patch | Warp existing canopy sprite | Quick reuse of current assets; UV-only warp cannot create true silhouette motion or 3D parallax; fragment work can be fill-bound | Try if 1B/1C require too much geometry or asset work |
| **2B — only if needed** | **Animated sprite sheets** *(GPU-instanced flipbooks)* | Baked animated tufts | Wind-loop tree sprites, possibly at several view angles | Reliable authored appearance, trivial playback; texture-memory cost, loops, wind-direction mismatch, rotating-camera limitations | Try as a simpler/art-directed alternative |
| **2C — only if needed** | **Density-sampled leaf clusters** *(3D instancing + vertex motion)* | Optional tuft/seed clusters | Sample persistent leaf-cluster instances from a 3D canopy density distribution; simple trunk/branches terminate near foliage; wind moves clusters, revealing gaps | Real 3D volume/parallax and detachable leaf effect; likely more overdraw, geometry, and authoring complexity | Try **only if** 1C looks too solid or insufficiently leafy |
| **3 — stretch** | **Hierarchical pivot animation** *(vertex shader; Crysis / Pivot Painter style)* | Usually unnecessary | Trunk → branches → twigs/leaf clusters with distinct stiffness/phase | Convincing branch behavior; additional data and generation pipeline | Only if simpler tree motion looks unnatural |
| **4 — defer** | **GPU-procedural grass blades** *(compute/generation + rendering)* | Dynamic blades per patch | Not applicable | Potentially rich close-up grass; much more engineering and device variability | Only if future close zoom demands it |
| **5 — avoid by default** | **Volumetric density raymarching** *(fragment shader)* | Not needed | Render a continuous canopy density field | Attractive in principle, but per-pixel traversal is a poor initial fit for mobile | Not part of initial lab |

**Do not interpret the table as a mandate to implement all rows.** The intended first deliverable is **1A + 1B for grass**, **1A + 1C for trees**, and the static baselines. These can share a single wind shader utility. If these meet the quality and performance goals, stop. A few sparse **falling leaf particles** and **wind-scaled rustling audio** can be layered on later; neither requires a full leaf-particle canopy.

## Minimum visual lab

Create a small test scene with a **meadow**, a **grove**, and a **mixed meadow-to-forest transition**, retaining the existing terrain and lighting. Provide a camera that rotates and zooms exactly as in the game, including the current pixelated gameplay zoom. All variants should run with a **seeded, deterministic gust front traveling across the entire scene**; support calm, gust, steady wind, and reversal.

Useful controls: foliage technique, density, wind intensity/speed/direction, stiffness, camera rotation/zoom, and a freeze-at-time slider for comparisons. Show one technique at a time for timings; a visual side-by-side mode is optional and **must not** be used for benchmark numbers.

Start by reusing existing tree and grass assets; add only the geometry/subdivision essential to demonstrate the candidate. Prefer **alpha cutout or small opaque clusters** over large alpha-blended quads where visually acceptable. For canopy deformation, evaluate control-point displacement **in the vertex shader**, rather than running a separate compute pass just to animate a handful of lattice points.

## Phone benchmark and stop/go rule

For each candidate, compare the **same representation** in static and animated mode; then compare the full foliage-enabled scene with foliage disabled. Do not confuse the cost of drawing foliage with the extra cost of making it move.

| Record | Purpose |
|---|---|
| Frame time median / p95 / p99, at actual phone render scale | Does the entire game remain smooth? |
| GPU pass time if supported, collected **asynchronously** | Distinguish shader/rendering cost without stalling for GPU readback; otherwise report frame timings as a proxy, not GPU timings |
| `animated − static` for matched assets | Incremental animation cost |
| `foliage scene − no-foliage scene` | Overall foliage cost, including overdraw |
| Triangles, instance count, draw calls, texture memory, and estimated overdraw | Explain scaling behavior |
| Light / normal / dense foliage at normal and closer zoom | Find practical limits |
| Sustained 5–10 minute run, rerunning static baselines | Catch thermal throttling and baseline drift |

Score visual quality **at gameplay zoom** for: coherent traveling gusts, legible bend/ripple, canopy volume and gaps, camera-rotation appearance, and lack of swimming, stretching, aliasing, or obvious loops. Record short, matched-time clips/screenshots and device/frame-time results in a small comparison table.

**Progression rule:**
1. Implement **0 and 1A–1C** only. Assess quality and sustained on-phone cost.
2. If grass motion is visually adequate and cheap, **keep 1A + 1B** and stop grass experiments. If tree deformation is adequate, **keep 1A + 1C** and stop tree experiments.
3. If not, name the failure before choosing the next row: *geometry too expensive* → try **2A/2B**; *canopy lacks depth and breakup* → try **2C**; *branch motion rubbery* → consider **3**. Do not advance for novelty alone.
4. Preserve quality knobs: fewer foliage instances, fewer lattice vertices, reduced distant animation, simplified shading, or **animation off**. Do not move per-instance work to CPU.

## Background techniques worth consulting

- NVIDIA, [*GPU Gems* — Rendering Countless Blades of Waving Grass](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-7-rendering-countless-blades-waving-grass) — instanced/clustered grass animation.
- NVIDIA, [*GPU Gems 3* — Vegetation Procedural Animation and Shading in Crysis](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis) — broad bending plus fine leaf response.
- Epic, [Pivot Painter 2.0](https://dev.epicgames.com/documentation/en-us/unreal-engine/pivot-painter-tool-2.0-in-unreal-engine) — hierarchical shader-based tree motion.
- GDC, [*Procedural Grass in Ghost of Tsushima*](https://gdcvault.com/play/1027214/Advanced-Graphics-Summit-Procedural-Grass) — higher-complexity procedural grass, for later comparison, **not** an initial mobile implementation target.

**Deliverable:** a running, GPU-only, switchable visual lab; brief per-technique mobile benchmark results; and a recommendation identifying the *first* technique that clears the visual bar within the available GPU budget.

## Swaying open land, step 1 (flora-sway, 2026-11-17)

The owner: "another important terrain pass is large instanced forests and varied flora fields. I would love to see the
wind effects or a cheaper baked stand in so swaying trees and grass cover the open land between settlements." Judged in
the game at play zoom on the phone tier, not in a lab or viewer (the treegen lesson, DESIGN §15). This step runs in the
game itself instead of the lab above: the lab is still the place for 1B/1C comparisons.

**What the game draws today at the loop's zoom** (2.5 css px a cell; the phone's low tier renders half that): the
meadow is the ground's grass texture (meshdraw.wgsl meshSurf) — the grass meshes only appear from 5 render px a cell
(vegprep.wgsl `fine`) — so no grass moves. Trees are the far level (20-30 triangles) and do lean, but each vertex
recomputes the plant's wind (`plantLean`: ~20 hashes of noise plus the bend read) though every input is the plant's root.

**Design, in order of risk.**
1. *Grass that sways without geometry (row 1A).* One function, `gustWave(p)` (common.wgsl): gust fronts travelling
   downwind in the frame that already moves with the integrated wind (`windDrift`), wavy across, grouped into gusts —
   a few sines, no hashes, cheap enough a fragment. The ground's grass share (`Surf.grass`, the cover's on tops) takes
   it as a lighter, yellower sheen on the crests (blades bowed, their pale sides up), a little shade in the troughs, and
   its normal tipped downwind. The player's own painted wind (wind field rg) adds a fast ripple in its direction, so a
   gust power is visible in the grass. Not baked: the tiles keep the grass share in two bits of their normal word
   (13 bits a side is plenty) and apply the same function as they are drawn, so the waves cross the window's edge.
   The far rings (far.wgsl: no time or wind in their uniforms) are left still in this step.
2. *Per-instance sway (trees and plants).* A small compute pass a frame (`floralean.wgsl`) over the library's
   instances: the plant's lean (the map's breeze `mapWind` + the sway spring's `bend`) and the same gust wave, written
   once into the instance's spare words (row 3 yz; w its flutter phase). The vertex stage reads them: the noise leaves
   the vertex stage. Its own pass, not `floraPut`, because vegprep has no storage slot left for `bend` and the lean must
   move every frame even when the lists are kept (`?prepevery=N`). Matched pair: `?florasway=0` (lean zeroed, static).
3. *More trees on open land.* Groves (noise-thresholded patches), tree lines along water and scattered single trees on
   plains, from the seeded `veg` field and the ecology gate — not a second placement; citygen still clears settlements.
4. *Sparse tall-grass clumps at play zoom* only if 1-3 are done and cheap.

**Cost rule.** Each change measured as a toggle diff of frame time at idle at the loop's zoom and a closer one (desktop
proxy; the phone bench is the owner's).

**Options for later (design only, for the owner to choose).**
- *Varied flora fields by region kind.* A GPU species table (a small uniform: region kind × wetness band × height band →
  up to four species with weights) read by vegplan.wgsl instead of hash + one birch noise. Region kind from the atlas
  (forms.wgsl), wetness from moisture, latitude from the world's y, height from the surface. Kinds: reeds in wet
  lowland, crops near towns (already a band of veg), heath and scrub on dry uplands, conifers on slopes and high ground,
  broadleaf in valleys, jungle (dense, tall, vines) in hot wet regions. Cost: one uniform read and a few compares per
  column at placement (vegprep), nothing per frame; work: a table and its CPU mirror (flora/species.ts already has the
  niche data), the far painters (tiles/far/bake) taught the same table so a region reads the same from afar. ~M.
- *Large-forest far LOD.* (a) A canopy layer: the woods' crowns as one displaced, noise-lumped sheet per region,
  meshed at tile resolution and swayed by `gustWave` — cheap, reads as a "sea of leaves", no single trees.
  (b) Impostors: each species rendered to a few view angles once, drawn as camera-facing cards beyond the window,
  swayed by a UV shear — reads as trees, costs atlas memory and overdraw; the rotating camera needs 4-8 angles.
  (c) Today's painted crowns, sized to the window's trees and swaying in the tile draw by the wave (cheapest, flat).
  Recommendation: (c) now for the seam, (a) as the forest track's canopy (it pairs with the forest branch's
  canopy-fade), (b) only if (a) fails the play-zoom look.
