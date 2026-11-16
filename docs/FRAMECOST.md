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
| FC2 | water as a surface, not a prism per wet column | structural | up to ~4 ms a frame over sea at 512, ~1.7 at 320 / zoom 14. **Done (`watersurf`, round 107):** over open sea the water's draw 5.3 → 3.4 ms (+0.26 for its list); its shading is now the cost (FC9) |
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
bounds what a tick carries. FC10 (a front per field) is the next step.

# The idle frame's census (2026-11-15, branch `phone-idle`)

The user on the Pixel 9a, about the atlas level with a town: "very very slow. Unplayable really". This part counts what
the frame asks of the GPU, per system, and prices it with the phone's measured cost of a call. The phone bench
(`?idlebench=1`, below) is the judge; the user runs it.

## The phone's cost model (the user's Pixel 9a, 2026-11-15)

GPU-done time over an empty frame:

| what | measured | a call |
|---|---|---|
| 1 empty compute pass | ~0.4 ms (noise ±0.5) | |
| 65 direct dispatches in one pass | 0.5 ms | ~0.008 ms |
| 65 direct dispatches, a pass each | 1.5 ms | a pass ~0.015–0.02 ms |
| **65 indirect dispatches, 1 workgroup or 0** | **6.4–6.6 ms** | **~0.1 ms** (Chrome validates each one's arguments on the GPU) |
| small clears and uploads | within noise | |
| a CPU read of 1–3 MB (earlier runs) | 20–35 ms, worst 217 | ~13 ms a MB |

Not measured, so priced at nothing or guessed, and each has a probe in the bench: a render pass (priced as a compute
pass), a draw, an indirect draw, a small read, a direct dispatch of many workgroups that return at once.
`src/gpu/census.ts` `PHONE_MODEL` holds the numbers; `estimateMs` applies them.

## The tools

- **`?census=1`** (`src/gpu/census.ts`, `src/perf/census.ts`): the WebGPU prototypes wrapped in one place. Per frame and
  per system it counts render and compute passes, direct and indirect dispatches, draws and indirect draws, clears and
  copies (bytes), queue uploads (bytes), `mapAsync` reads (bytes), pipelines, bind groups, buffers and textures made,
  submits, and the sim's ticks. A call belongs to the scope open when it is made (the sim's systems by name, the level
  frame's steps, the renderer's parts, the frame-compute hooks), else to its pass's or buffer's label. A table in the
  console every 10 s (`?censusevery=`), `window.__census.take()` / `.table()` / `.download()` (JSON). Off by default:
  nothing is wrapped. `test/unit/census.test.ts`.
- **`node scripts/census.mjs`**: the user's level (`?skipmenu=1&level=atlas&town=1&fresh=1`, 412x915) headless in four
  states, the table per state, the reports as JSON (`perf-reports/census.json`), and the idle gates (below).
  `--labels` lists the passes under each system; `node scripts/censuslabels.mjs file.json idle living` reads them back.
- **`?idlebench=1`** (`src/perf/idlebench.ts`; headless `node scripts/idlebench.mjs`): the phone bench.

## The quality tier

`q` is `low` unless the URL says otherwise (`src/main.ts`: `params.get('q') ?? 'low'`; no detection of the device), and
`src/flags.ts` adds the phone's flag set on the low tier whether `q=low` is written or not. So the user's first link
(no `q`) and the second (`q=low`) run the same page: render scale 0.5 at dpr 1 (206x457 pixels drawn for a 412x915
screen), 2 ticks a frame at most, 16,384 particles, 2 agent sweeps, 1 mesh rebuild a frame, and `tufts=0
shadowcache=4 prepevery=2 bandh=2 shadowsize=512 hybrid=1 settle=0 sleepmore=1`. A phone gets the low tier because
everything does; `q=medium|high` is for a desktop. Checked:
`scripts/census.mjs --noq` ran with the same quality, the same flags and the same counts a tick.

## The four states (desktop headless, D3D11, 412x915, per-frame averages)

Before any cut (`phone-idle` 8b558d73 = `fortress` 555bdca3 with the census):

| state | indirect | direct | compute passes | render passes | draws + indirect draws | reads (KB a frame) | ticks | model, ms a frame |
|---|---|---|---|---|---|---|---|---|
| settling (first 8 s, 6 fps here) | 29.7 | 51.9 | 43.5 | 4.5 | 113 + 109 | 1.5 (75.7) | 1.07 | 5.3 |
| **idle, 20 s, camera still** | **75.6** | 74.5 | 60.6 | 3.3 | 27 + 191 | 1.26 (34.7) | 0.86 | **9.9** |
| panning 30 cells/s | 74.8 | 75.9 | 59.7 | 3.5 | 58 + 151 | 1.40 (383) | 0.80 | 14.2 |
| Next season time-lapse | 75.7 | 80.4 | 64.2 | 3.6 | 41 + 180 | 1.30 (185) | 0.86 | 11.9 |

The model puts the idle frame at ~10 ms of GPU-done time on the phone before a pixel is priced, against a 16.6 ms
budget; 7.6 ms of it is 76 indirect dispatches, nearly all of 0 workgroups.

Before the level's first frames: headless here the first two frames hold the GPU 25–30 s (past main.ts's 20 s
watchdog, whose overlay comes up; the frames then run). Not a frame's cost; BACKLOG PI-9.

## Idle, by system (the ranking)

Per frame, before the cuts; `model` is the estimate on the phone.

| # | system | indirect | direct | passes | reads | model ms | what it is |
|---|---|---|---|---|---|---|---|
| 1 | living town (`living-graph`) | 30 | 18.4 | 4 | – | 3.23 | the graph's build, relax, check and trace kernels, each indirect, sized by the GPU's phase word: settled, 0 workgroups |
| 2 | town contracts | 28 | 15 | 1 | – | 2.94 | the side map (20: clear, raster, prep, 8 rounds of hook and jump, final) and the place table (8 a town), woken by GPU watches |
| 3 | terrain mesh (`fieldmesh`) | 5 | 6 | 10 | – | 0.75 | sample, count, verts, qcount, quads over the GPU's list of changed chunks |
| 4 | liquid, water | 5.1 (6 a tick) | 1.7 | 6.8 | – | 0.66 | flux, jets, depth, two publishes, prep over GPU tile lists |
| 5 | liquid, lava | 4.3 (5 a tick) | 1.7 | 6.0 | – | 0.56 | the same model's second liquid, with no lava in view |
| 6 | valley reads | – | – | – | 0.11 (33.7 KB) | 0.43 | the sandbox's timed reads: wind field 4 Hz, plants and water 1 Hz, ~400 KB each |
| 7 | wind field | 1.7 (2 a tick) | 1.7 | 3.4 | – | 0.25 | the painted wind's box on the GPU, its update and copy |
| 8 | particles | – | 7.7 | 7.7 | – | 0.21 | emit, fire, petals, plants (twice each), update: a pass each |
| 9 | lava (the older system) | – | 4.3 | 4.3 | – | 0.12 | |
| 10 | sway | 0.76 | 0.76 | 1.5 | – | 0.11 | |
| 11 | coarse world | 0.75 | 0.25 | 1 | – | 0.10 | three frames of four |
| | oil, structure, contamination, moisture, fire, surface, wilt, sediment, renderfields, climate, cover, ecology | – | ~13 | ~13 | – | 0.37 | direct, over the CPU's awake-chunk lists |
| | draw, shadow, renderprep, tiles | – | 4 | 5.3 (3.3 render) | – | 0.14 | 27 draws and 191 indirect draws: not priced by the model |
| | agents | – | – | – | 0.95 (0.7 KB) | 0.01 | the units' sync: a small read a frame (DA-B2b); a small read's cost isn't in the model |

Panning adds the old physics' judge: `Integrity` reads the whole layers buffer back after every slide (`ColumnCopy`,
"read layers": **27–29 MB a read**, 7–10 reads in a 10 s pan; by the model 350+ ms each). The time-lapse does the same
on its edits (5 reads of 27 MB in 10 s). BACKLOG PI-5.

## What was cut

| cut | before → after (idle, a frame) | model |
|---|---|---|
| The sandbox valley's timed reads off in the town game (`scenes/level/season.ts`). DA-B5 turned them off in fortress play; the switchover deleted fortress mode and the town game ran them again | reads 1.26 → 0.99; read back 34.7 KB → 0.91 KB (2.4 MB a second → 63 KB a second at 69 fps); copies 36.7 KB → 19.6 KB; the 4 Hz 400 KB wind read and the two 1 Hz 400 KB reads gone | −0.43 ms a frame as an average; as hitches, ~6 reads a second of ~5 ms each |

After: idle 75.7 indirect, 74.9 direct, 61.1 compute and 3.3 render passes, 0.99 reads (0.91 KB), model 9.5 ms.
`scripts/census.mjs` gates it: no valley reads at idle, under 4 KB read back a frame, nothing made in a frame.

### Round 2 (the orchestrator's rulings, 2026-11-15)

| cut | before → after (a frame) | model |
|---|---|---|
| A slide alone reads nothing back: `Integrity`'s orphan check after a slide runs on the GPU instead of through a judge pass whose kept copy is read whole (`game/integrity/tick.ts` `orphansAfterSlide`) | pan: 383 KB → 6.8 KB read back, 7–10 reads of 27–29 MB → none; time-lapse: 185 KB → 1.1 KB | pan 14.2 → 9.7 ms; time-lapse 11.9 → 10.1 ms; as hitches, 350+ ms each gone |

## The decision the rest needs

Every remaining indirect dispatch is indirect on purpose. Round 128o and the town tracks moved "is there work" onto
the GPU (a phase word, a hash watch, a changed-chunk list) so that nothing is read back, and sized the kernels with
indirect arguments: with no work they dispatch 0 workgroups (UC-8, RT2-4, LT-F6, DA-B26; AGENT_RULES §1b names the
pattern). LT-F6 left it open: "a CPU signal only if the phone bench shows empty dispatches cost". The phone's number
says they do: ~0.1 ms each, 76 a frame. The CPU can't skip them from what it knows: the wakes are GPU-only (a
chunk's shape version moved by a sim kernel, water crossing a depth, riders asking for routes, a worldop's edit).
Three ways out, each a design change, so none was built:

| | pattern | what it costs | what the bench's probe tells |
|---|---|---|---|
| A | **A settled signal read after events.** Each GPU-gated system keeps a "has work" word; the CPU reads it (64 bytes, async) after a CPU-known event (an edit, a worldop, a slide, a card) until it reads settled, then encodes nothing. GPU-only wakes need the watch kernels kept (direct, ~0.03 ms a system) and one small read a frame or a few a second to hear them | a small read (DESIGN §24 allows "small, async, only after edits or events"; a per-frame one it forbids) and up to a few frames' delay before a solve starts | `probe: 64-byte read a frame` |
| B | **Direct dispatch, gated in the kernel.** The same kernels dispatched direct at their full size; every thread reads the phase word and returns. Same results, no read, no delay | 2–3 million idle threads a frame for the living graph and the side map; the place table's bindings are full (8 storage buffers), so its gate word needs a home | `probe: 16 direct × 1024 gated` against `probe: 64 indirect × 0` |
| C | **Fewer encoded.** The side map's 8 rounds a frame down to 2, the watches every 4th frame, the living graph's check and build kernels behind one gate | latency: a solve takes more frames (behaviour) | – |

Recommended: read the bench first. If the gated direct dispatch is cheap (B), it is the smallest change and keeps the
no-read rule; if not, A with the read the bench priced.

## The phone bench: `?idlebench=1`

`/?skipmenu=1&level=atlas&town=1&fresh=1&idlebench=1` (no server is started for it; with a dev or LAN server,
`http://<host>:<port>/?skipmenu=1&level=atlas&town=1&fresh=1&idlebench=1`). Under three minutes after the level is up,
the wake lock held; don't touch the screen. It waits for the start town, lets the world settle 12 s, then:

1. the idle frame for 6 s: its interval, its GPU-done time (the frame's last submit to `onSubmittedWorkDone`), and its
   census with the model's estimate;
2. each system off and on in two windows each way (1 s each): all sim, living town, town contracts, town draw, fluids,
   weather, sediment, nature fields, flora, particles, old physics, agents, terrain mesh, render prep, tiles, shadows,
   coarse world, UI, all render;
3. the probes, added to the frame: 64 indirect dispatches of 0, 64 direct, 16 direct of 1024 gated workgroups, a
   64-byte read a frame, 128 indirect draws of 0 instances.

A table on the page, and Download / Copy / Share for the JSON (`window.idleBenchReport`). No timestamps are taken
(their readback is a read a frame). `node scripts/idlebench.mjs` checks headless that it completes and writes
`perf-reports/idlebench.json`; on the desktop it ran 24 toggles in 194 s at the first defaults (20 s settle, 1.2 s
windows, the 26 s first-frame stall included), now 12 s and 1 s. The desktop's differences are noise at these sizes
(an iGPU with no vsync, ±3 ms between windows): only the phone's run means anything.

## What is left, in rank order

| id | item | model at idle |
|---|---|---|
| PI-4 | The GPU-gated indirect dispatches: living 30, town contracts 28, terrain mesh 5, water 6 a tick, lava 5 a tick, wind 2 a tick, sway 1, coarse 0.75 — the decision above | 7.6 ms |
| PI-6 | 61 compute passes a frame: the sim's systems begin a pass a dispatch; runs of dispatches with no copy between could share one | ~0.9 ms |
| PI-5 | The judge's whole-window read after a slide or an edit (27–29 MB) | pan and time-lapse: 350+ ms a read |
| PI-10 | 191 indirect draws a frame (the mesh chunks and the towns, world and shadow passes): unpriced until the bench's probe | ? |
| PI-7 | The units' sync reads ~1 time a frame (0.7 KB): DA-B2b's watched sync | ? (the read probe) |
| PI-9 | The first frames hold the GPU 25–30 s headless on the desktop; unknown on the phone | boot |
| PI-3 | The ambience (birdsong, insects, water, frogs) without a read: a GPU reduction round the view, a few bytes | – |

## Round 2: the result (2026-11-15, the orchestrator's rulings applied)

The rulings: the judge's whole read lazy; solves that change only on events gated on the CPU by a wake plus a small
event-chained read (`src/gpu/settled.ts`, DESIGN §24's "small, async, only after edits or events"); what must run every
frame dispatched direct with an early-out in the kernel; a sim with nothing changing encodes nothing.

### The four states, before → after (per frame; desktop headless 412x915; ms by the phone's cost model)

| state | indirect | direct | compute passes | read back (KB) | model ms |
|---|---|---|---|---|---|
| just loaded (first 8 s) | 29.7 → 1.3 | 51.9 → 57.9 | 43.5 → 36.9 | 75.7 → 42.1 | 5.3 → 2.0 |
| **idle, camera still** | **75.6 → 1.4** | 74.5 → 84.3 | 60.6 → 48.7 | 34.7 → 0.9 | **9.9 → 1.9** |
| panning 30 cells/s | 74.8 → 1.1 | 75.9 → 78.6 | 59.7 → 40.3 | 383 → 7.9 | 14.2 → 1.7 |
| Next season time-lapse | 75.7 → 8.5 | 80.4 → 110 | 64.2 → 53.7 | 185 → 1.4 | 11.9 → 2.9 |

The after run happened to run 1.39 ticks a frame at idle (the before run 0.86: this desktop's frame rate), so its
per-tick systems count higher than they would at one tick a frame; the bench's idle frame on the same build, at 0.69
ticks, counted 0.7 indirect and 26 compute passes, model 1.1 ms. Render passes (3.3), draws (27) and indirect draws
(191) are unchanged.

### Idle, by system, after

| system | before: indirect / direct / passes | after | how |
|---|---|---|---|
| living town | 30 / 18.4 / 4 | 0 / 18.4 / 1 | the graph (build, relax, check, wall work) sleeps on a settled read; riders, trace, works and figures one direct pass |
| town contracts | 28 / 15 / 1 | 0 / 0 / 0 | asleep at rest: nothing encoded; two settled reads; awake, 43 direct gated in the kernel |
| terrain mesh | 5 / 6 / 10 | 0 / 10 / 1 | one pass, the build kernels direct over the slot's room (405 workgroups a frame), gated; full sleep built, off (PI-15) |
| liquid, water | 6 / 2 / 8 a tick | 1 / 7 / 2 a tick | direct from the CPU's awake list with an in-kernel check; `prep` stays indirect (PI-16) |
| liquid, lava | 5 / 2 / 7 a tick | 0 / 0 / 0 | asleep with no lava: nothing; woken by a spring or land come in |
| wind field | 2 / 2 / 3.4 a tick | 0 / 1 / 1 a tick | the map-wind band only; painted: 4 direct |
| sway | 1 / 1 / 2 | 0 / 0 / 0 at rest | awake while the CPU knows of wind, a storm, the cursor's breeze |
| coarse world | 0.75 / 0.25 / 1 | 0 / 0 / 0 at rest | woken by an event, a vent, the climate's terms changing |
| valley reads | 0.11 reads, 34 KB | gone | round 1 |
| particles, lava (older), oil, structure, contamination, moisture, fire, surface, wilt, sediment … | direct, a pass each | unchanged | now the top of the idle list: ~35 passes a frame (PI-6) |

Where an indirect dispatch remains: the water's `prep` (its count runs from 0 to every wet chunk of the window); and,
only while they are awake, the living graph's solve (28), sway's and the coarse world's lists.

### The 191 indirect draws

One `drawIndexedIndirect` per terrain mesh chunk in view in the world pass and again in the shadow pass (the chunk's
index count is the GPU's), plus the trees' kinds, the instance lists, and the towns' meshes and figures. Left as they
are. The bench has both rungs: 128 indirect draws of 0 instances and the same 128 direct.

### Checked on the combined state

`scripts/census.mjs` (all gates pass), `scripts/idlebench.mjs` (25 toggles, 178 s after the level is up, the 26 s
first-frame stall included: inside three minutes, barely, on this desktop), `npm run typecheck`, the unit project (631
passed; the one failure is PI-12, the base's), `npm run smoke`, and `scripts/towngif.mjs` at idle and in a time-lapse:
the town, the river and the bridge draw as before, the houses of the season's card are built, and the figures on the
roads are in different places between the first and last frames (by eye; the script's pixel count is mostly water).

### The owner's note (2026-11-15), verbatim

"One minor point but build things using the systems we developed like pages. The first runs we want to build are
centered on a city but the opportunity system and simulation layers are intentionally built more generally. The plan
is to eventually have runs that follow migrant groups such as refugees, armies, settlers or adventurers. Don't spend
time designing around it but note that it is the plan so any shortcuts should record places where they bake the fixed
city assumption per run."

Tagged `FIXED-CITY` tonight (BACKLOG PI-20, a comment at each site): the valley reads' cut is keyed to the season loop
starting on the start town (scenes/level/season.ts); the idle bench, the census and the town GIF wait for that start
town. The other gates are keyed to general events (a slide, a chunk's wake, an edit near a town, a town's own
changes) and hold for any number of towns or none.
