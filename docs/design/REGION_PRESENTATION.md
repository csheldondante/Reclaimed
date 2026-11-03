# Coding Agent Handoff — Region-Dependent Camera & Presentation Prototypes

## Goal

Prototype ways to make the **existing persistent 3D world** feel intimate, cinematic, and readable at character scale without sacrificing its impressive overworld presentation. The game already generates GPU-driven 3D terrain, trees/forest canopy, cities, buildings, and simulation; **reuse that geometry and world state by default**. The objective is **perceptual continuity**, **not** triangle-for-triangle or even scene-for-scene continuity. A close-up view can reinterpret what is shown, and an interior may be a separate scene, provided the player recognizes the place and nothing salient contradicts the world.

**Deliver runnable, interactive examples for visual review**, not just a design document or a generalized framework. Preserve the existing overworld rendering and behavior; use isolated experiments and toggles. Prefer GPU-local work; avoid GPU→CPU readbacks or CPU simulation of purely visual effects.

## Guiding Principles

1. **Start with what exists.** First zoom into the current scene with no enhancement; the terrain, objects, and positions may already be adequate. Do not assume a separate detailed representation is cheaper.
2. **Visibility is at least as important as fidelity.** Reuse the game's existing occlusion dithering/cutaway infrastructure where possible. Rendering a canopy or wall as absent/transparent must *not* remove it from the world simulation, wind, collision, or shadow logic by default.
3. **Keep isometric framing by default.** Both overworld and close-up may be isometric. Changing camera angle is an *optional, gameplay-driven* treatment (canyons, cliffs), not a prerequisite for zoom.
4. **Compose by region and activity.** A forest, canyon, cliff, and interior can each have different camera, visibility, lighting, and transition rules. A high-speed ride may need a different camera than walking in the same region.
5. **Fake continuity freely, but maintain recognizable anchors.** Preserve salient locations, landmarks, route entrances/exits, important buildings/characters, and changes to interactive world state. Microdetail and even interior geometry may differ.
6. **Prototype before generalizing.** Use manually configured region presentation profiles first; do not build a full procedural camera director or asset pipeline until the examples prove valuable.

## Build These Four Reviewable Scenes

### A. Birch forest — canopy to understory (first / highest priority)

Use an **existing generated forest with a controllable rider/character**, recognizable path and individual tree positions. Begin in ordinary overworld isometric view; move/zoom closer as the rider enters a stand of birches; show a close isometric view *beneath* the canopy; reverse the transition smoothly.

- Keep tree locations and terrain unchanged. At close range, trunks rise around the rider, with a visibly navigable forest floor.
- **Visibility variants** (switchable): current occlusion behavior (baseline); rider-centered canopy dithering; height-based cutaway for foreground trees; faint/stippled translucent upper canopy; combinations. Favor stable screen- or world-space dither and transitions without flicker.
- **Fidelity variants** (switchable): current materials/geometry; richer local trunk/terrain shading and understory lighting; GPU-instanced leaf litter, grass, roots/ferns/rocks, falling leaves; pregenerated higher-detail tree meshes or sprite→mesh substitution if baseline silhouettes are weak. Use existing wind animation to motivate moving light/shadows if feasible.
- **Transition variants:** pure continuous zoom; zoom + dithered representation change; zoom + crossfade. Keep camera tilt constant for the baseline.
- **Review question:** Can approaching the birches feel like *entering the same living forest*, with dramatic understory light and readable motion, without obviously rebuilding the scene?

### B. Hoverbike canyon — speed, scale, and navigation

Use generated terrain with **towering canyon walls** and a rideable route. Compare the normal isometric overworld camera with a **steeper / route-facing camera** as the rider accelerates into the canyon.

- Camera should reveal the path ahead and avoid walls blocking steering cues. Test speed-dependent zoom/look-ahead versus fixed framing.
- Try foreground wall cutaways/dithering where necessary, but preserve the impression of immense cliffs.
- Check steering and screen-direction controls during camera reorientation: no sudden flips or unintuitive inputs.
- **Review question:** Which framing preserves both canyon grandeur and readable navigation at speed? Does a regional angle change actually help?

### C. Cliffside climb — platforming, height, and danger

Use an existing steep cliff/slope with a character capable of vertical movement or a simple test proxy. Compare normal isometric framing with a **near-profile view** that exposes footholds and a **downward-emphasizing view** that communicates the drop.

- Adjust target/framing as the character climbs, descends, or nears an edge. Keep the character and next reachable surfaces visible.
- Explore cutting away obstructing foreground rock while retaining a clear sense of cliff geometry.
- **Review question:** Which view makes vertical navigation intuitive while conveying height and danger? Are camera transitions disorienting?

### D. Interior / throne room — scene substitution with believable entry

Create a **small, attractive isometric throne room** (standalone representation is explicitly acceptable). It may use sprites/2.5D or enhanced 3D, separately generated props, lighting, and composition. Give it one recognizable doorway or facade/entrance anchor from the overworld; a fully mapped interior is **not** required.

- Compare direct zoom into existing building geometry, if practical, against **zoom + dither/dissolve** into the distinct interior; optionally compare a short occlusion/loading transition as fallback.
- Add a simple diegetic opportunity demonstration: several petitioners representing world factions/issues, a petition opening the existing atlas/opportunity UI (or a clearly labeled stub), and returning to the room. Do not invent a parallel opportunity system or implement a large dialogue engine.
- **Review question:** Does a visually richer, separately composed interior feel like part of the same world? Does the audience-room framing make opportunity selection more engaging?

## Experiment Matrix (Toggle Independently Where Practical)

| Dimension | Baseline / first trial | Further variants, only if useful | Key tradeoff |
|---|---|---|---|
| Camera | Existing isometric angle; continuous zoom | Activity/region-based pitch, near-profile, look-ahead | Readability vs disorientation |
| Visibility | Existing occlusion dithering | Canopy/wall region mask, height cutaway, translucent/stippled remnant | Character clarity vs environmental scale |
| Surfaces/lighting | Existing shading | Zoom-dependent texture detail, richer directional/ambient light, filtered canopy shadows | Quality vs GPU cost |
| Small details | None | GPU-instanced debris/leaf litter/grass/particles | Atmosphere vs overdraw and pop-in |
| Major-object geometry | Existing tree/building meshes/sprites | **Pregenerated LOD assets**, mesh/sprite substitution, crossfade | Silhouette quality vs assets/memory |
| Geometric refinement | None | Local dynamic/procedural refinement **only if needed** | Fidelity vs implementation/runtime complexity |
| Representation transition | No substitution | Dither, dissolve/crossfade, occlusion-assisted swap | Perceptual continuity vs visual artifacts |
| Separate scene | Not required outdoors | Distinct 2.5D/3D interior; transition/loading screen fallback | Composition freedom vs mapping/asset work |

**Prioritize:** (1) unchanged geometry/camera baseline → (2) forest visibility treatments → (3) lighting and local detail → (4) canyon/cliff camera composition → (5) interior substitution → (6) pregenerated LOD comparison where visual limitations justify it → (7) costly dynamic refinement only if the previous approaches fail. A quick standalone dither-to-separate-scene test may run in parallel; don't assume it's the winner.

## Minimum Implementation Contract

- Create a lightweight **presentation profile** for each prototype: preferred camera target/pitch/zoom/look-ahead, visibility/cutaway settings, local detail and lighting settings, and transition style. Hardcoded authored examples are fine; don't prematurely proceduralize selection.
- Reuse the existing world representation for outdoors. Region entry/exit can switch/blend presentation settings. No requirement for a second authoritative geometry or simulation model.
- For an independent interior, map **only** essential anchors: entry/exit, salient exterior identity, important occupants/items, and state mutations. Exact geometric correspondence is unnecessary.
- Avoid disrupting the existing atlas, normal gameplay cameras, simulation, or mobile performance. Keep each feature disabled by default outside its prototype/test region until reviewed.
- Expose an easy **review/debug overlay**: prototype selector, current treatment, zoom and camera-angle controls, visibility mode, detail/lighting toggles, transition replay, FPS/frame time, and if available GPU time, draw calls, memory, and transition spikes.
- Include a reset-to-overworld action and a simple route/script to replay each example consistently. Don't rely solely on screenshots.

## Deliverable / Review Checklist

1. A way to launch each of the four prototype scenes from the running game or a clearly named review menu.
2. Side-by-side *repeatable* A/B modes for the high-value variants, especially forest canopy handling and canyon camera angle.
3. The existing overworld remains functional and unchanged when experiments are off.
4. Short notes for each prototype: what was reused, what was faked/replaced, visual wins/failures, measured desktop/mobile performance if test devices are available, and recommended next iteration.
5. Prioritize an appealing **visual experience**, not architectural completeness. If a case is blocked by absent character mechanics or assets, use a small labeled proxy and report the limitation rather than building unrelated systems.

**Success criterion:** From the atlas, enter a birch forest or canyon and feel that the environment has become a compelling, readable, more intimate view of the *same place*. For an interior, feel that a scene transition represents entry into that place even if the scene is technically separate. Stop adding complexity when the illusion and gameplay readability are good enough.
