# Frame cost: the long base frames and a slide's CPU (round 106, branch `frameprobe`)

The user (verbatim): "I thought Ringwin removed the need for the slide work so do we need to address the CPU slide
at all? Shouldn't it be lower? It would be good to understand that long render time." Then: "please fix those so I
can test", and: "Does the post slide catchup ever load cells that are no longer needed?"

Measured on the desktop iGPU (D3D11, headless Chrome) with the GPU to ourselves. Every run used the atlas level at
q=low, 412x915 at dpr 2.6 (the phone proxy) with every system on, at 1x, and the phone flags the low tier adds.
Tools (new):
- `scripts/framecost.mjs` logs every frame: its interval, its callback's CPU, the rAFs held for the GPU, and the
  profiler's per-pass GPU ms, span, and the gap since the previous frame. It reports percentiles, per-pass mean, p95
  and max, the long frames with their passes, each slide's sync CPU by part, the 20 frames after each slide, and
  (`--skips`) the renderer's `?skip=` pieces left out one set at a time. Each set runs between two baselines,
  because the iGPU's clock drifts.
- `scripts/cpugridcheck.mjs` checks the CPU's per-column arrays against the GPU's after slides out and back.
- `Profiler.lastStartNs` / `lastEndNs` / `lastPasses` give per-frame data to a script.

## A. The long base frames

### What they are

The "gpu-held 30–60 ms" frames are the frame's own GPU work sitting at the budget. Nothing stalls.
- **The GPU frame is ~9–11 ms p50, p95 15–22, max 35–60** at both windows, against a ~10 ms vsync (this panel runs
  at ~100 Hz headless).
- main.ts paces two frames in flight. So any frame over the budget holds the next rAF, and intervals come out as
  20, 30 or 40 ms. The hitch recorder calls that `gpu-held`.
- The long frames have under 2 ms of CPU. Their GPU spans are 15–70 ms with the passes accounting for nearly all of
  it. Readbacks waiting (mapAsync) don't line up with them.

Two harness effects made it look worse than it is:
- **The GPU shared with other runs.** With the GPU to ourselves, the pan bench's smoke at zoom 14 / window 320 runs
  at ~100 fps with p99 10–19 ms. Its fastest smooth pan is 480 cells/s from the pool and 240 from disk. The 40–60 ms
  frames "even at 10 cells/s" from the earlier smokes are gone.
- **Where the camera is.** The smoke's zoom 5 / window 512 still has a parked p99 of 98 ms. The bench's disk fill
  leaves the camera over open sea, where the water's draw doubles (below).
- **The iGPU's clock drifts about 2x between runs at the same spot.** One parked run had a 4.7 ms span, later ones
  10–11 ms, on the same build; places from before the tilecache merge measured the same 10 ms. Per-pass numbers
  are only good as an A/B within one page.

### Breakdown (GPU ms a frame, parked: mean / p95 / max)

| pass | window 512, zoom 5 (the start, a coast) | window 320, zoom 14 |
|---|---|---|
| draw (the world pass) | 3.4–4.4 / 7–8.5 / 21–27 | 3.4–3.7 / 6.1–6.4 / 21–30 |
| agents | 0.8–1.5 / 4.5 / 9–14 | 1.3–1.9 / 2.7–4.4 / 5.6 |
| fieldmesh (hash, count, sample, verts, quads) | ~1.9 | ~1.0 |
| gbuffer | 0.5–0.6 | 0.45–0.5 |
| renderprep (the whole window, every second frame) | 0.5–0.6 / 1.4–1.7 | 0.3 / 0.9 |
| shadow + shadow-static | 0.45 | 0.4 |
| every sim together (structure, sediment, particles, water, lava, sway, wind, …) | ~1.5 | ~1.5 |
| **frame span p50 / p95** | **9.6–10.9 / 17.7–22** | **8.9–9.4 / 15.8–16.9** |

Inside draw: each `?skip=` set left out, judged against the runs either side of it.

| left out | saves at 512, zoom 5 | saves at 320, zoom 14 |
|---|---|---|
| `far` (the LOD rings and the far land) | 4.0 | 3.7 |
| `water` (the water instances) | 4.2 | 1.75 |
| `prep` (every instance: water, plants, prisms, opaque) | 4.8 | 2.0 |
| plants, trees, prisms, opaque | 0.7 | 0.4 |
| `mesh` (the voxel mesh and the grid) | 0.4 | 1.9 |
| `band` | ~0 | 0.35 |

Over open sea (after the bench's fill, 512 / zoom 5), draw is 6.9–8 mean, p95 14–17, max 35–57; the water alone
is 4.9. The water instances counted: 8.9k at 512 on the coast, 14k at 256 by the sea, 58–65k at 512 over the sea.

### Panning: the catch-up after a slide

At 60 cells/s what changes is the sims' burst after each slide:
- structure: p95 4–8, max 10–15 (512)
- edit: max 5–10
- renderfields and surface: p95 1–3
- the field mesh's rebuild passes: max 4–7 ms in a frame

The cause was sim/sleep.ts. With `sleepmore` (a phone flag), every chunk in the window was marked drowsy for
0.25 s after any slide, "its derived textures moved". For ~15 ticks after every slide:
- structure and edit copied every sleeping chunk's layers through;
- surface and renderfields ran over the whole window;
- the field mesh hashed every chunk in view.

Since ringwin nothing moves on a slide. The strip that comes in already gets its own drowse (`drowseTick`), so the
slide-wide drowse was work for nothing. **Fixed (FC1):**

| after a slide, 60 cells/s | base (places 8c93cc1) | frameprobe |
|---|---|---|
| structure, 512 (mean / p95 / max) | 0.89 / 8.1 / 15.3 | 0.17 / 0.85 / 1.6 |
| surface, 512 | 0.23 / 2.0 / 3.6 | 0.08 / 0.42 / 0.63 |
| renderfields, 512 | 0.30 / 2.8 / 5.7 | 0.08 / 0.42 / 1.5 |
| water-flux + copyback, 512 | 0.35 / 2.6 / 4.1 | 0.16 / 0.51 / 1.05 |
| structure, 256 | 0.26 / 1.4 / 2.65 | 0.07 / 0.31 / 1.4 |
| renderfields, 256 | 0.10 / 0.79 / 1.4 | 0.03 / 0.23 / 1.0 |

What a slide still asks of the GPU:
- **The strip that comes in.** It is drowsy for its first ticks: structure and edit carry its layers through, and
  surface and renderfields make its fields.
- **The field mesh.** It builds the arriving chunks in view. The arriving strip is a region past the screen, so
  those are mostly not in view and aren't built until they are. The ones marked urgent for 8 frames
  (`ARRIVE_URGENT`) are looked at, but built only if visible.
- **The projection.** It runs over the whole window for one tick (`projectAll` on onShift): the bodies and units
  were translated on the GPU.
- **The bake.** It bakes the arriving land into the far rings (the `bake` and `lod` passes, ~1–3 ms in the frames
  that run them).

The user's question, whether the catch-up loads cells that are no longer needed: after FC1, what runs is the
arriving strip's own. That strip is a region past the screen edge, so it isn't needed this frame. It is needed
within about a second at 60 cells/s, because the camera keeps coming. Deferring it until it nears the screen is
FC5 (below).

### Why each big pass exists, and what it scales with

| work | why it exists | scales with | proposal |
|---|---|---|---|
| water instances (~4 ms over sea) | a prism per wet column, so every water surface is an instance | the window's wet columns, not the screen | **FC2, structural**: draw water as a surface (the heightfield grid's lattice, or tiles) instead of a prism a column |
| far rings + far land (~4 ms) | the land past the window, as rings of falling detail | the screen and the zoom (fixed rings) | AR3 (tiles replacing the rings) removes it: **structural, already planned** |
| renderprep (0.5, p95 1.7) | instance lists rebuilt from the whole window every second frame | the window | **FC3, optimisation**: prep only the chunks in view (the grid's view cull already has them) |
| agents (spikes 9–14 ms parked) | the front and scope relax (simscale); some ticks spike | activity, but spiky | **FC4, investigate**: which tick spikes (the surfaces' peel every 8 ticks?) |
| post-slide strip catch-up | what came in, made ready | the motion | **FC5, optimisation**: run the arriving strip's drowse (and its mesh) in slices over ticks, nearest the screen first, or not until it nears the screen |
| projectAll after a slide | units and bodies translated in window coordinates | the window, once a slide | **FC6, structural**: units, bodies and particles in world coordinates; then nothing is translated and only the arriving strip needs projecting (with FC7) |

## B. A slide's CPU (RW6, RW7)

The slide's synchronous part, from `slide()` to the end of its callbacks. Window 256, zoom 14, 60 cells/s:

| | base: mean / max | frameprobe: mean / max |
|---|---|---|
| **unthrottled** | 1.85 / 2.8 | **0.29 / 0.5** |
| **CPU throttle 4x** | 9.8 / 17.4 | **1.7 / 2.7** |
| window 512, zoom 5, unthrottled | 4.2 / 5.2 | 0.39 / 0.8 |
| window 512, zoom 5, 4x | — | 2.25 / 4.1 |

### Each piece: what it did, why, and what was done

At 4x throttle, window 256 (mean / max, ms):

| piece | base | now | what it is | the root | done |
|---|---|---|---|---|---|
| saveItem | 2.1 / 6.1 | 0.09 / 0.3 (+ fill 0.3, spread over the write frames) | copies the leaving region's CPU parts (outside, map.surface, ground, relief) for the store and the pool | real work, but it ran in the slide's frame only because the next line shifted the arrays. `regionOutside` also called `ring.idx` per cell (two arrays allocated a column) | **structural**: the arrays live on the ring (below), so what left stays where it lay until the region coming in is written there. The copy (`fill`) runs just before that write, from the region's place, with no per-cell allocation. Every other writer of those arrays fills first (editLive, slideZ, warp, takeAbove/putAbove), and so does a thaw or a store check that reaches the item first |
| copyOut + slotFor | 1.0 / 1.9 | 0.45 (in the write frames) | the leaving region's GPU data copied into a pool slot (and the stage for the store), the band cleared | real work, done in the slide's frame | **structural**: the chunk table now rotates with the ring (a chunk coming in takes the pages of the one that left from the same place), so a place's pages and columns stay untouched until its region is written. Each region is frozen (`freezeAt`) just before the region coming in is written there, its band cleared then. The slide's frame only plans it |
| snapshot | 0.75 / 1.1 | 0.06 / 0.2 | the coarse world round each leaving region, kept to compute what changed while it's away | real work, but a buffer, an encoder, a submit and a map a region | **optimisation**: Coarse.snapshot batches a task's requests into one buffer, submit and map (a microtask), flushed before any step or event |
| CPU grids shiftGrid | 0.44 / 0.9 | 0 | map.surface, the streamer's ground / relief / gapTop / colTop shifted by copyWithin | **window coordinates**: the same conflation the ring fixed | **structural**: on the ring (core.ring.i(x, y)); readers changed (level, hybrid, weather, atlas-world, the streamer) |
| level surfaceCache shift | 0.14 | 0 | the level's 1 Hz surface readback, shifted | window coordinates | **structural**: read back in the ring's order (`readBuffer(…, true)`), indexed through the ring; the veg and water caches too (no rotation a read) |
| integrity.slid | 3.3 / 4.4 | 0.07 / 0.3 | re-projects the sleeping bodies: 4 MB filled at 512, `ring.toRing`'d (4 MB more) and uploaded, though the slide had just emptied the body list | the projection kept in window order; an empty one rewritten | **structural**: the projection kept on the ring (written as it is), and nothing written when it held no body and holds none (the texture is already "none": WorldGpu fills it so, a slide's strip comes in so) |
| agents + bodies translated (onShift) | 0.65 / 1.3 | 0.22 / 0.5 | units, flyers and physics particles moved by −d on the GPU | **window coordinates** (GPU positions) | optimisation: Translator keeps a uniform and bind group per buffer and puts a task's moves in one submit. **FC6, structural, proposal**: world coordinates for units, bodies and particles |
| windowMoved (field mesh, band) | 0.16 / 0.2 | 0.2 / 0.4 | the mesh chunk records shifted by a kernel, `wanted`/`tops` shifted | per-chunk state window-relative by design (RW7) | FC7, structural, proposal: mesh chunk state on the ring's chunk places, so nothing shifts |
| chunk table, the rest | ~0.5 | ~0.4 | the table, ring, origin, camera, events, weather, sleep, hybrid, callbacks | coordinate frame | left |

### What is left in window coordinates (RW7 updated)

- **Per-chunk CPU grids.** sleep and drowse, the hybrid's per-chunk arrays, and the field mesh's chunk records:
  cheap (under 0.1 ms each unthrottled), shifted per chunk. FC7 would put them on the ring's chunk places.
- **GPU positions.** Units, flyers, physics particles, and particles in the air (cleared on a slide): FC6.
- **Integrity's seed maps and watches.** Re-keyed per entry, cheap with few entries.
- **The camera, events and weather.** They are window coordinates by contract. The frame they're in stays a
  separate concern: `origin` and `Ring` convert.

### Behaviour kept

- What a region carries is the same. A leaving region's CPU parts are read from the same cells, just later, and
  nothing writes those cells before that.
- Its GPU parts are copied from the same pages and places before anything writes there. The sim doesn't tick while
  a slide is under way.
- Two things differ by design, neither visible on screen:
  - Until the region coming in is written, its strip (a region past the screen) shows the leaving region's
    non-kept fields. Before, they were zeroed at the slide.
  - The pool's slots are taken in a different order, so the pool's eviction order can differ by a region.
- Checks run: cpugridcheck (the hybrid's per-chunk choice made again from the ring's relief matches what it holds,
  after a pan out and back with 12 thawed; the level's surface cache agrees with the GPU on every column, while a
  column a region off agrees on 0.01%). ringtest: valley and the atlas, 37 of 37 fields identical at ring offset
  128,64, through two slides by hand (it caught Integrity.topAt reading the ring off the window's edge: fixed).
  worldsavetest (`?rsverify=1`: every region written from the pool or the store is hashed against its freeze): 0
  bad; its one FAIL is places' own (SH11). floatsweep, towertest and settlementtest: all passed.

## Proposals (for the user and main to decide)

| id | proposal | kind | expected |
|---|---|---|---|
| FC2 | water as a surface, not a prism per wet column | structural | up to ~4 ms a frame over sea at 512, ~1.7 at 320 / zoom 14 |
| AR3 | tiles replace the far rings (already planned) | structural | ~4 ms a frame at both zooms |
| FC3 | renderprep over the chunks in view only | optimisation | 0.3–0.6 ms a frame, p95 1–1.7 |
| FC4 | the agents' spike ticks (9–14 ms parked) | investigate | the p95 / max frames |
| FC5 | the arriving strip's catch-up in slices, nearest the screen first, or not until it nears the screen | optimisation | the phone's 6–17 frames over budget a slide at 384 / 512 |
| FC6 | units, bodies and particles in world coordinates | structural | no translation a slide; projection of the arriving strip only |
| FC7 | per-chunk state (sleep, hybrid, field mesh records) on the ring's chunk places | structural | windowMoved and the per-chunk shifts gone (~0.3 ms at 4x) |

## C. FC4: the agents' spikes (round 107, branch `agentspike`)

Round 104's front never emptied in the atlas:
- a sweep relaxed 90–100% of the scope on nearly every tick;
- any chunk that came into the scope re-peeled all of it (riding: an 11 ms peel in a 19 ms agents frame).

The causes and the fix are in the DEVLOG (round 107). In short:
- the fields reckon costs by their own heights and wet, with hysteresis (navCost);
- a distance is written only when it moves more than 0.05;
- fields start over instead of counting up;
- the peel covers an eighth of the scope a tick;
- a sweep relaxes at most 32 chunks.

| agents' GPU a frame, ms (mean / p95 / max) | places ab286d9 | agentspike |
|---|---|---|
| parked, window 512 / zoom 5 | 1.41 / 4.14 / 6.31 | 1.06 / 3.07 / 9.45 |
| parked, window 320 / zoom 14 | 1.43 / 4.04 / 20.1 | 1.06 / 2.31 / 6.11 |
| riding (drive 18, window 512) | 0.89 / 4.16 / 22.15 | 0.47 / 1.96 / 9.38 |

What is left: real change (the shores, the window's edge) keeps ~80% of the scope asking to be relaxed, and the cap
bounds what a tick carries. FC8 (a front per field) is the next step.
