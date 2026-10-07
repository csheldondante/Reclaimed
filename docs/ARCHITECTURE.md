# Architecture

Current state of the system boundaries. Update when a contract changes.

## Frame

```
CPU: controls → powers → weather + day/night → Nature (reads last stats)
GPU per sim tick (60 Hz fixed, ≤ N ticks/frame by quality tier):
   structure → material → surface → water(flux, depth) → oil(flux, depth)
   → contamination → moisture → fire → ecology (every 15)
   → particles (emit, fireEmit, bursts, update) → renderfields (every 2)
   → stats (every 20, async readback)
GPU per frame: renderprep (terrain + liquids) + vegprep (plants) → draw
   (opaque boxes incl. sub-voxel canopies, liquids, particles, rain)
```

Globals (`common.wgsl` / `src/sim/globals.ts`, 464 bytes) carry storms,
one-tick events, gusts (player + cursor breeze), day/night light and the life
lens. The shared wind field `windAt()` is analytic from these.

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
| surface | u32 (z, mat, count) | surface | most systems |
| water / waterPrev / flux | f32 depth / f32 / vec4 volume per tick | water | oil, contamination, moisture, ecology, fire, structure, material, renderfields, stats, draw |
| waterSource | f32 per tick | map | water |
| oil / oilFlux | f32 depth / vec4 | oil | water (weight), ecology, fire, renderprep, stats |
| contam | vec2 (soil, dissolved) | contamination | ecology, particles, draw, stats |
| contamDelta | atomic i32 ×1e5 | particles (pick-up/drop), oil (soak) | contamination (folds in, zeroes) |
| moisture | f32 0..1 | moisture | material, ecology, fire, particles, renderfields |
| fire | f32 0..1 | fire | oil (burns), ecology (burns), structure (heat, waste), particles (flames), renderfields (glow), stats |
| veg | f32 stage 0..5 | ecology (+ particles may plant 0 → 0.3: bird seeds) | most systems |
| particles / particleCounters | 48-byte ring + atomic head | particles | draw |
| renderFields | vec4 (shadow z, moisture, fire glow, flow) | renderfields | draw |
| stats | u32 sums | stats, structure (collapsed), material (overflow) | CPU (async) |

The water system can be replaced by anything that publishes `water`,
`waterPrev` and `flux` with the same meaning; oil likewise with `oil`/`oilFlux`.
Draw shaders read the packed `renderFields` instead of individual fields, so
they stay within 8 storage buffers.

## Rendering

Single path: every interval is a box instance; vertex pulling from a storage
buffer; only the three camera-facing faces are emitted (18 verts/instance).
Water is a second instance list drawn translucent; inner water side-faces are
culled in the vertex shader. Rain is stateless hashed streaks. Shadows come
from a heightfield sun-march compute pass. Cloud shadows/rain field are
analytic functions of the storm uniforms. An `rg32uint` pick target (column +
material, height, flags) gives exact picking via a 1-pixel async readback.

## Derived helpers

- `flow.wgsl::netFlow(p)` — net volume/tick through a column from `flux`.
  Anything reacting to *moving* water (erosion, flood damage, scouring, foam)
  must use it; gross flux is large even in still water.

## Instance flags (render-prep → draw)

`w = material | flags << 8`; flags: 1 top-of-column, 2 vegetation,
4/8/16/32 side face toward +x/−x/+y/−y hidden, 64 top face hidden.
Fully hidden intervals are not emitted. Flag 128 = detail instance (x/y/size in
quarter cells: trunks, grass tufts, flowers). Leaf boxes with the vegetation flag
are shaded by a sub-voxel ray march inside the box (discard = gap).

## Events

`Globals.events` (≤4, one tick): x, y, radius, strength + kind
(`EV_LIGHTNING`). The CPU queues them; `Simulation.step` clears them after
the tick that consumes them.
