# Testing — the pyramid

The user (DECISIONS round 117): "TDD make some unit tests so you can stop hogging my browser so much. Do complete
integration tests after unit tests work and do quick smoke tests to find failures early." And why it pays: modular code
with clean abstractions "minimizes test surface area … we can have the same coverage with fewer faster unit tests".

Run the tiers in this order. Each one is for failures the one below can't see. Stop at the first tier that fails.

| tier | command | where | wall time (desktop, round 117) | what it's for |
|---|---|---|---|---|
| 1. unit | `npm run test:unit` | Node, no GPU, files in parallel | ~2 s, 79 tests | pure TS: contracts, the tick clock, records and hashes, the registry, the rock judge and the rigid rock on CPU columns |
| 2. gpu | `npm run test:gpu` | Node + real Dawn (npm `webgpu`, D3D12), no browser | ~15 s (one ~10 s pipeline compile, shared) | real WGSL kernels through the game's own pipeline and bind-group code; a real `WorldCore` on a 32 × 32 world |
| (1 + 2) | `npm test` | both, unit first | ~16 s | before every commit; many agents can run it at once |
| 3. smoke | `npm run smoke` | the runner's headless Chrome (GPU lease) | ~40 s for one level, after the lease | boots the built game: the atlas loads, no fatal or console error, its sim runs |
| 4. integration | `scripts/*.mjs` on the runner | headless Chrome, every system in play | minutes each | behaviour at full scale, looks (tilegate), frame time (driveprofile), the phone |

Tiers 1 and 2 never touch the shared browser. Tier 2 uses the GPU through Dawn in its own process. It doesn't need the
runner's lease, and running it alongside a browser check is fine.

## Writing a unit test

Put it in `test/unit/<area>.test.ts`, or beside its code as `src/**/<name>.test.ts` (tilecal's convention, round 115).
Both run in the unit project. Import the production module and assert on what its contract promises. Write the test
first, from the doc comment or the user's words, then run it.

```ts
import { expect, test } from 'vitest';
import { TickClock } from '../../src/sim/tickclock';

test('a 120 Hz display runs a tick every other frame', () => {
  const c = new TickClock();
  let n = 0;
  for (let i = 0; i < 240; i++) n += c.take(1 / 120, 1, 4, 1 / 60);
  expect(n).toBeGreaterThanOrEqual(119); // (the accumulator's float time: 119 or 120)
  expect(n).toBeLessThanOrEqual(120);
});
```

- **No browser globals.** A module that reads `location` at load must guard it, as `typeof location === 'undefined'`
  (most do already). The gpu tier's setup defines `location` and the viewport for the modules a `WorldCore` pulls in.
- **`?raw` WGSL and `__GEN_HASH__`** work as they do in the build: vitest.config.ts extends vite.config.ts.
- **Test helpers** live in `test/support/`. `tinyMap(w, h, zMax, col)` makes a map with every per-column array a level
  carries. `RockWorld` gives packed columns with the rock judge, the External registry and the rigid rock over them.
  It mirrors only Integrity's glue, and each mirror names the method it follows.
- **A known finding** stays visible as `test.fails(...)` with a comment naming its BACKLOG row. The suite stays green
  while the row is open and goes red once it's fixed. Then drop `.fails`.
- **Numbers for the DEVLOG:** a test may print them behind an env var (`BURIED_LOG=1 npx vitest run buried
  --reporter=verbose`).

## A GPU kernel test on a tiny world

Put it in `test/gpu/<area>.test.ts`. The tests of a file share one Dawn device (`testGpu()`), and Dawn keeps what it
compiled for that device. A file's first `WorldCore` pays for its ~100 pipelines (~10 s with DXC here). Every later one
in that file takes ~0.1 s. So make a world per scenario freely. A GPU validation error fails the test: check
`g.takeErrors()`.

Each gpu file runs in a fresh worker (vitest.config.ts `isolate: true`, round 117, terrain; BACKLOG TK12). With one
worker shared by every file, Dawn's process died ("Worker exited unexpectedly") when a second file made a WorldCore,
reproducibly in one worktree and never in a fresh one at the same commit, and after a file had built a whole atlas.
Isolated, a file pays its own compile (the tier ~16 s instead of ~13) and can't take another down. Build an atlas once
per file (test/gpu/terrain-atlas.test.ts shares one small atlas between its tests).

One kernel, made the engine's way (common.wgsl prepended, explicit layouts):

```ts
const g = await testGpu();
const k = makeCompute(g.device, 'probe', [commonWgsl, probeWgsl], { 3: 'rw' });
// … dispatch, then g.read(buf, bytes) and assert
```

A system or all of them, through the contract buffers (the contract tier's way, now in Node):

```ts
const map = tinyMap(32, 32, 32, (x, y) => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
map.water[16 * 32 + 16] = 2;
const w = await tinyWorld(g, map, ['surface', 'water']); // or 'all': every system the level steps
await w.step(600);
const water = await w.read('water'); // window order, y * w + x
```

`test/gpu/water.test.ts` (a pool conserved) and `test/gpu/external.test.ts` (External cells kept, water round them,
every system stepping) are worked examples.

Dawn backends on this machine: D3D12 (the default) works. D3D11 (`DAWN_FLAGS=backend=d3d11`) compiles with FXC and the
tiny world's pipelines took over 4 minutes. Vulkan has no `vulkan-1.dll` here. Dawn options go through
`DAWN_FLAGS="a b"`, read by test/gpu/setup.ts.

## When to use the browser

Use it only for what Node can't show: the page's boot (the build, the menu, the streamer, IndexedDB), drawing and
looks, frame time on a real compositor, input, the phone. Start with the smoke script (`npm run smoke`, ~40 s), then
the integration scripts the change needs. The shared-browser rules hold for those (runner lease; ask main where the
agent rules say so). If a check can be written against a contract buffer or a pure module, write it in tier 1 or 2.

## What isn't covered yet

- Integrity's glue (game/integrity.ts: takeExternal, wakeResting, restRigid, the judge's passes) lives in a
  2000-line class that also owns the GPU readbacks, so only its mirror in test/support/rockworld.ts runs in Node. Pull
  it into a pure module behind the class and the mirror goes (BACKLOG TK5).
- `WorldCore` always makes a Renderer (~half its pipelines and its viewport globals). A sim-only core would halve the
  gpu tier's one compile (BACKLOG TK6).
- The contract tier's tests (src/test/contract.ts: breach, river, pool) can move to test/gpu. `pool` already has
  (test/gpu/water.test.ts).
