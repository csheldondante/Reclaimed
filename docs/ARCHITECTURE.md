# Architecture

Current state of the system boundaries. Update when a contract changes.

## Frame

```
CPU: input → weather.update (storms) → nature.update (reads last stats)
GPU per sim tick (60 Hz fixed, ≤ N ticks/frame by quality tier):
   structure → material → surface → water(flux, depth) → contamination → moisture
   → ecology (every 15) → shadow (every 6) → stats (every 20, async readback)
GPU per frame: renderprep (world → box instances, indirect args) → draw
   (opaque boxes, translucent water, rain streaks)
```

Globals (`common.wgsl` / `src/sim/globals.ts`) are uploaded per tick, and once
more per frame for rendering (time, storms).

## World representation

- **Columns** on an XY grid, each with up to K ordered intervals `[z0, z1) material`
  packed in a u32 (see `src/world/layout.ts`). Chunked storage: 16×16-column
  chunks each with their own K (min 4, max 16, need + 2 headroom). A chunk
  table maps chunk → (slot offset, K). Overflow when material piles up beyond
  K is counted (`stats[15]`) and shown in the perf overlay, never silent.
- **Material table**: uniform array of 32 materials × 3 vec4 (render, sim, eco).

## Contract buffers (src/sim/world-gpu.ts)

| buffer | type | written by | read by |
|---|---|---|---|
| layers | u32 slots (aux = support·16 + damage) | structure, material | structure, surface, renderprep |
| surface | u32 (z, mat, count) | surface | water, material, ecology, shadow, render |
| water / waterPrev | f32 depth | water | contamination, moisture, ecology, render, stats |
| flux | vec4 volume/tick to ±x ±y | water | contamination, render, stats |
| waterSource | f32 per tick | map | water |
| contam | vec2 (soil, dissolved) | contamination | ecology, render, stats |
| moisture | f32 0..1 | moisture | material (repose), ecology, render |
| veg | f32 stage 0..5 | ecology | contamination, moisture, renderprep, render, stats |
| shadow | f32 lit-from z | shadow | render |
| stats | u32 sums | stats, material(overflow) | CPU (async) |

The water system can be replaced by anything that publishes `water`,
`waterPrev` and `flux` with the same meaning.

## Rendering

Single path: every interval is a box instance; vertex pulling from a storage
buffer; only the three camera-facing faces are emitted (18 verts/instance).
Water is a second instance list drawn translucent; inner water side-faces are
culled in the vertex shader. Rain is stateless hashed streaks. Shadows come
from a heightfield sun-march compute pass. Cloud shadows/rain field are
analytic functions of the storm uniforms. A `r32uint` pick target gives exact
column picking via a 1-pixel async readback.

## Derived helpers

- `flow.wgsl::netFlow(p)` — net volume/tick through a column from `flux`.
  Anything reacting to *moving* water (erosion, flood damage, scouring, foam)
  must use it; gross flux is large even in still water.

## Instance flags (render-prep → draw)

`w = material | flags << 8`; flags: 1 top-of-column, 2 vegetation,
4/8/16/32 side face toward +x/−x/+y/−y hidden, 64 top face hidden.
Fully hidden intervals are not emitted.

## Events

`Globals.events` (≤4, one tick): x, y, radius, strength + kind
(`EV_LIGHTNING`). The CPU queues them; `Simulation.step` clears them after
the tick that consumes them.
