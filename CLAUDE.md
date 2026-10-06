# Reclaimed — agent guide

Browser prototype (TypeScript + WebGPU): an isometric voxel sandbox where the
player nudges natural processes (storms, rain, …) to clean a ruined industrial
valley so life can return. Design authority: `.claude/docs/design/Reclaimed_Overview.md`.

## Working rules

- **Notes travel with code.** Every commit that changes behaviour or
  architecture appends an entry to `docs/DEVLOG.md` explaining *why* (the
  benchmark, visual, or design reason), in the same commit. `docs/ARCHITECTURE.md`
  is kept current when contracts/system boundaries change.
- Commit at each working milestone (local only, no remote).
- **Simplest implementation first, behind a clean interface.** Measure (perf
  overlay) before optimising. Record the measurement in the DEVLOG when an
  optimisation is made or deliberately deferred.
- **No fallbacks / heuristics.** Missing WebGPU or a needed limit → clear
  unsupported message (`UnsupportedError`). GPU validation errors surface as a
  fatal overlay. Fix root causes; don't paper over them.
- Systems communicate only through WorldGpu contract buffers (`src/sim/world-gpu.ts`).
  Never make one system depend on another's internals.

## Commands

- `npm run dev` — Vite dev server on http://localhost:5173
  - `?perf=1` perf overlay (or press `` ` ``), `?q=low|medium|high` quality tier,
    `?speed=N` debug fast-forward of the simulation
- `npm run typecheck` / `npm run build`
- `node scripts/shot.mjs --out x.png [--url ...] [--wait ms] [--eval js] [--then ms] [--eval2 js --out2 y.png --then2 ms]`
  — headless Chrome (real GPU via D3D11) screenshot + console capture. Exits
  non-zero on page errors / fatal overlay. `window.reclaimed` exposes
  `{sim, world, weather, camera, nature, renderer, map, readBuffer, probe}` for scripted checks.

## Layout

- `src/world/` — map generation, CPU authoring grid, chunked column packing, material table
- `src/sim/` — GPU world buffers (contracts), system wrappers, fixed-step scheduler, globals uniform
- `src/shaders/` — WGSL; `common.wgsl` (+`layers.wgsl`, `materials.wgsl`) are concatenated in front of each kernel
- `src/render/` — camera, render-prep + draw
- `src/weather/`, `src/game/`, `src/audio/`, `src/ui/`
- `scripts/` — dev tooling (headless verification)

## Conventions

- WGSL binding 0 = Globals, 1 = chunk table, 2 = materials; 3+ per kernel.
  Explicit bind group layouts (`src/gpu/pipeline.ts`) so shared snippets can declare unused bindings.
- Keep ≤ 8 storage buffers per shader stage (WebGPU default limit).
- Struct layouts mirrored in TS must be kept in sync (comments point at both sides).
