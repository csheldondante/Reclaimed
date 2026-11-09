# Track B audit — renderer, units, assets (fortress fdaa3f34, 2026-11-09)

Read-only audit for the instanced-3D benchmark (Experiment 1). File:line references as of fdaa3f34.

## Working: reuse as-is

**Instanced meshes: `src/render/meshinst.ts`**
- Vertices are 16 B and indices u32. Each instance is 64 B: 3 affine rows plus a params vec4.
- One `drawIndexedIndirect` per kind.
- The GPU writes the instances (vegprep.wgsl, floraput.wgsl) and culls each one against the view. It picks a LOD by
  projected px: full ≥150, coarse ≥55, far below. The CPU uploads only an args reset.

**Structures: `src/structures/gpu.ts`**
- Pieces are 64 B. There is one CPU `drawIndexed` per module range.
- A slab is uploaded only when it changes.

**Lighting**
- The world pass is forward-lit. `?defer` covers terrain only.
- The sun's shadow map is depth32 at 1024 on `q=low`. meshinst, structures, voxels and meshes all cast into it.
  A static/live shadow cache is behind `?shadowcache`.
- Wind is `plantLean` (common.wgsl:695).

**Perf tooling**
- `speedbench.ts` has the panel, report download/share, keepAwake and `deviceFacts`.
- `Renderer.skip` toggles draws at runtime; drawbench.mjs uses it.
- VRAM tracking: `GpuMemTrack` with `?hitch=1`.
- The lab's `town` recipe.

## Partial

**GPU agents: voxel figures**
- `unitDraw` appends 3 or more 32 B voxel instances per unit. They are drawn as one indirect cube draw.
- Animation is rigid bob/bend. There is no view cull.
- The units box is read back every 8 ticks.

**Inhabitants: procedural rigs**
- The GPU animates them.
- The GPU rewrites every creature's triangles every frame (32 B a vertex, cap 2.5M = 80 MB). This is an expensive
  representation (AGENT_RULES §1c); an instanced mesh posed by bone instances could replace it.
- The cull is a focus radius only.

**`src/units/figures.ts`**
- The CPU uploads up to 24 KB a frame. Only hero-run uses it.

## Missing

- An instanced-mesh set for units:
  - `MI_ARGS_WORD`=24 is hard-coded, so the renderer holds one set.
  - There is no colour/variant/pose word per instance.
- A procedural humanoid mesh with 3 LODs.
- GPU placement of N bench units.
- A bench that toggles draws, not sim systems: speedbench pauses sim systems only.
- Impostors, sprites or billboards of any kind.
- Asset loading of any kind: no glTF, binary pack, manifest or OPFS. Every mesh is made in code.
- No indirect-first-instance or multi-draw.

## Camera and pixel sizes

- Fixed ortho dimetric at 30°. A vertical extent H projects to about 0.866·H·zoom CSS px.
- On `q=low`, render px = 0.5 × CSS px (renderScale 0.5, maxDpr 1). The bench therefore states both.
- User zoom is clamped (0.8–24). The bench varies the instance scale at a fixed play zoom, so terrain cost stays
  constant.
