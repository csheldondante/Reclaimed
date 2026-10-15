# Reclaimed — agent guide

Browser prototype (TypeScript + WebGPU): an isometric voxel sandbox where the
player nudges natural processes (storms, lightning, gusts, fire, floods) to
clean a ruined industrial valley so life can return. Design authority:
`.claude/docs/design/Reclaimed_Overview.md`.

## Start here

`docs/BACKLOG.md` (every open suggestion) → `docs/HANDOFF.md` (current state, known issues, next steps) →
`docs/DECISIONS.md` (the user's answers — check before changing controls,
economy or look) → `docs/ARCHITECTURE.md` (contracts) → `docs/DEVLOG.md` (why
each change was made, with measurements). `docs/BRANCHES.md` says which game each branch is (check which branch you're on). `docs/STATUS.md` is the user-facing
stock-take.

## Working rules

- **Nothing gets lost.** `docs/BACKLOG.md` is the running list of every open
  suggestion and deferred item. Read it first; add new feedback to it before
  working; mark items done (with the commit) in the same commit as the change.
- **Notes travel with code.** Every commit that changes behaviour or
  architecture appends an entry to `docs/DEVLOG.md` explaining *why* (the
  benchmark, visual, or design reason), in the same commit. Keep
  `docs/ARCHITECTURE.md` current when contracts or system boundaries change;
  record new user answers in `docs/DECISIONS.md`.
- Commit at each working milestone and push to `origin`
  (github.com/csheldondante/Reclaimed — the user shares it).
- **Simplest implementation first, behind a clean interface.** Measure (perf
  overlay, probes) before optimising; record the measurement in the DEVLOG.
- **No fallbacks / heuristics.** Missing WebGPU or a needed limit → clear
  unsupported message (`UnsupportedError`). GPU validation errors surface as a
  fatal overlay. Fix root causes; don't paper over them.
- Systems communicate only through WorldGpu contract buffers
  (`src/sim/world-gpu.ts`). Never make one system depend on another's internals.
- The user is often away while you work: keep going, verify headlessly, send
  screenshots/GIFs, and collect judgement calls for them instead of blocking.

## Commands

- `npm run dev` — Vite dev server on http://localhost:5173
  - `?skipmenu=1` straight into the level (use for scripted tests)
  - `?progress=0..1` preview a menu-diorama stage
  - `?perf=1` perf overlay (or press `` ` ``), `?q=low|medium|high` quality tier
  - `?speed=N` fast-forward simulation, `?day=<s>` day length, `?tod=0..1` time of day
- `npm run typecheck` / `npm run build`
- `node scripts/shot.mjs` — headless Chrome on the real GPU (D3D11): screenshot,
  console capture, scripted input, GIF capture. Exits non-zero on page errors or
  the fatal overlay.
  `--url --size WxH --wait ms --eval js --clicks "x,y;wait:ms;x,y" --drag x0,y0,x1,y1
  --then ms --out a.png --eval2 js --out2 b.png --then2 ms --gif g.gif --frames N --every ms`
  Order: eval → clicks → drag → then → out → eval2 → gif → out2.
- In the level, `window.reclaimed` exposes `{core, sim, world, weather, camera,
  renderer, map, packed, globals, nature, powers, scene, readBuffer, probe}`.
  E.g. `reclaimed.probe('contam', x, y, r, 2, 0)`, `reclaimed.weather.spawn(x, y)`,
  `reclaimed.globals.events.push({kind: 1, x, y, radius: 5, strength: 20})`.

## Layout

- `src/main.ts` — boot WebGPU, quality tier, switch scenes
- `src/scenes/` — `world-core.ts` (one live world), `level.ts`, `menu.ts`
- `src/world/` — map generation (`mapgen.ts` valley, `menumap.ts` diorama),
  CPU authoring grid + chunked column packing (`layout.ts`), material table
- `src/sim/` — GPU world buffers (contracts), system wrappers, fixed-step
  scheduler, Globals mirror, particles
- `src/shaders/` — WGSL. `common.wgsl` (+ `layers.wgsl`, `materials.wgsl`) is
  prepended to every kernel; `flow.wgsl` / `slope.wgsl` are appended to kernels
  that declare their inputs
- `src/render/` — camera, renderer (render-prep → draw)
- `src/game/` — powers (what gestures do), Nature, progress
- `src/input/`, `src/weather/` (storms, day/night), `src/audio/`, `src/ui/`
- `scripts/` — headless verification tooling

## Conventions

- WGSL binding 0 = Globals, 1 = chunk table (only kernels that read layers),
  2 = materials; 3+ per kernel. Explicit bind-group layouts
  (`src/gpu/pipeline.ts`) so shared snippets can declare unused bindings.
- ≤ 8 storage buffers per shader stage (WebGPU default). Draw shaders read the
  packed `renderFields` buffer for that reason.
- Struct layouts mirrored in TS must stay in sync (comments point at both sides):
  Globals (`common.wgsl` ↔ `sim/globals.ts`), materials, instance packing.
- Readbacks of world-owned buffers: `.then(ok, ignoreTeardown)`.
- One-tick events (lightning, chips) are only seen by systems with period 1.
- Rare probabilistic spawns need full 32-bit randoms (`rare()` in particles.wgsl);
  16-bit draws bottom out at 1/65536.
- WGSL gotchas hit so far: derivatives (`fwidth`) must run before any `discard`
  or early return; `patch` and `target` are reserved words; module-scope `let` is invalid.

## Gotchas for agents editing here

- Windows + Git Bash: heredocs and `node -e` scripts containing backticks or
  `${…}` get mangled by the shell. Use the Edit/Write tools for TS/WGSL/Markdown
  with template literals or code spans.
- Visual verification is headless unless Claude in Chrome is connected. Audio
  can't be verified by an agent — list sound changes for the user to check.
