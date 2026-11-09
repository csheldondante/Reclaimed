# Next season — design note (Track A, round 128r; awaiting main's answer)

1. **Data flow.** CPU strategic state only: a `SeasonLedger` (pools Magic, Might, Labor, Resources, Intel, Unrest;
   projects; the season count) in `src/season/`. `nextSeason(ledger, plan, scenario)` is pure. It returns the next
   ledger and an ordered event list, and writes nothing. A `Playback` applies the events to the world through owner APIs:
   Fortress `markStarted`/`markBuilt` and Town `remove`, `plants.grow`, and a new water flood op. The GPU world derives
   from those writes as it does today.
2. **Event list.** `{ at: 0..1, kind: 'stage' | 'block' | 'unblock' | 'grow' | 'flood', structure?, cell?, level?, x?, y?,
   radius?, level_z? }[]`. It is sorted by `at`, then by structure id and cell. Every write is idempotent and
   order-free (set a block, set a stage, max for water, a capped sum for plants), so one call with the same ledger and
   plan gives the same list.
3. **Stage field.** Build stages are derived, never stored. `planned` means no block is begun or standing. `building`
   means some blocks are begun or standing (the fortress's `begun` set plus Town blocks, so BuildBook progress = blocks
   standing / blocks planned). `built` means every planned block stands. Decay is stored, because nothing else holds it:
   `Structure.decay?: 'damaged' | 'ruined' | 'overgrown'`, next to `wear`, so it persists with the plan.
   `stageOf(s)` combines the two for Track B. A season builds a landmark by standing its next storey's blocks directly;
   the season pays in pools, not hauled goods (round 128q).
4. **Instant flood.** None exists. `water.flood` adds depth per tick through `edit.wgsl`, and it runs off.
   `terrain/flood.ts` floods the atlas (macro lakes), not the live window. I propose a small `floodlevel.wgsl` kernel,
   dispatched once over the event's rect. Inside a disc, where the ground top is below level L, it sets
   `water = max(water, L - top)` and `waterSource = -(L - top)`. That is the existing "held depth" in `water_depth.wgsl`,
   so the level holds for the season. Releasing it (`waterSource = 0`) lets the flood recede in the next season. It
   needs its own kernel because `edit.wgsl` already has 8 storage buffers.
5. **Readbacks.** None per frame or per season. The CPU knows the plan, so the ledger needs no reads. Tests use one probe
   after playback (about 1 KB).
6. **Phone cost.** Resolving and playback are CPU microseconds, plus at most 4 world events a tick. The risk is a flood
   that keeps moving (see the derisk). The cost will be measured by the toggle diff `scripts/lab/seasonderisk.mjs`, and
   then by a phone-bench link with the flood on and off.
7. **Rejected: write the world at resolve, with the time-lapse as a render-side reveal** (per-structure reveal times, a
   water draw clamp). It gives skip-identity by construction, but it needs a second copy of the world's state in the
   renderer, which is Track B's. Instead, playback writes the events in order, and skip writes the rest in the same
   tick. The test compares the ledger, the plan and Town blocks exactly, plus GPU probes after both paths.
   Hook for fast agents and cranes: `Playback.onEvent(e, t)`. It is presentation only and can't change the outcome.

## Derisk (2026-11-09, lab `town`, 412x915, q=low, desktop iGPU shared with other agents)

**(a) Flood toggle diff.** `scripts/lab/seasonderisk.mjs`. The low quarter is the lowest fifth of the town's cells,
ground 12.6-15.6 m, the east harbour. The heap is at 23.6 m. The flood is OP.WATER with 2.5 m at the centre, radius 16,
in one tick. The frame interval is 10 ms in every phase (no frames lost).

| phase | water passes | field mesh rebuild passes | profiler GPU p50 |
|---|---|---|---|
| dry 1x | 0.13 ms | 0.13 ms | 5.8 ms |
| flooded 1x (9-17 s after) | 0.16 ms | 1.44 ms | 10.7 ms |
| dry 4x | 0.42 ms | — | 9.4 ms |
| flooded 4x | 0.35 ms | 0.77 ms, plus sediment 0.70 ms | 13.6 ms |

The water kernel isn't the risk: it already runs on the live chunks. The cost is the field mesh rebuilding while water
moves, and at speed, sediment moved by the flow. The harbour quarter opens onto the sea, so the added water ran off
within seconds and barely shows in the shot. A plain add doesn't make a standing flood there. A held level (point 4)
pouring into the sea would keep those chunks rebuilding. **So the flood must be a basin that stands still**, or the
user accepts a pouring edge at about +1.3 ms a frame on the iGPU, more on the phone.

**(b) Scaffolding at play zoom** (`.testcache/seasonderisk/stages-*.png`). Scaffolding reads as construction: dark timber
frames, with the storeys countable up close. At play zoom (6) the frames are thin and dark on dark ground, so they read
weakly. The plot outline is a faint grey slab. A storey standing inside the frame isn't distinct. Asking Track B for
stronger stage visuals.
