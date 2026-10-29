# Phase 2: sparse chunk pages, active-chunk sims, a wake API (design, round 105)

Status: P2.0-P2.3 implemented and measured on branch `pages` (round 107; docs/DEVLOG.md). §1's GPU layout was
changed by what was measured (below); P2.4 onward is still the design. Parent doc: "Reclaimed engine architecture: fixing the foundations"
(https://claude.ai/artifact/81VwyNZvndJQTWmKY5uUD2). BACKLOG AR1 (pages), AR2 (wake API). Phase 1 is `ringwin`'s
page-shaped helpers.

## 0. Four separate concerns, one representation each

| Concern | Representation | Owner | Converted at |
|---|---|---|---|
| Coordinates | World cells for the API, wake requests and records. Virtual window cells (1024²) for kernels and CPU sim code. | `api/atlas-world.ts` toWorld / fromWorld | the API boundary only |
| Storage | Slot and offset in the page | `sim/pages.ts` (replaces `ring.ts`), `common.wgsl` colIdx… | `colIdx`/`texCol*`, and `Pages.idx`/`toWindow` on the CPU |
| Residency | A set of regions (64², 16 slots each) | `sim/residency.ts` ResidencyPlanner (pure); the Streamer carries it out | region keys |
| Activity | Per-slot awake and drowsy bits, per-system chunk lists | `Sleep` (per slot), `WakeSet`, `cull.ts` ChunkLists | slot lists |
| Detail render | Resident and in view; the tiles (TC1/TC2) draw the rest | the render | the DETAIL list |

Invariant: no result may depend on a slot number, only on world or window coordinates. This keeps the bit-exact
tests meaningful.

## 1. The page table

**Pages and regions**
- A page is 16×16 columns: already COLS_PAGE, CHUNK, the layers' chunk, Sleep's chunk and simcull's tile.
- Residency is decided per region of 64² (4×4 pages), allocated as a block of 16 consecutive slots:
  slot = 16·block + 4·j + i. A region is then one contiguous 4096-column run in every buffer, so the region copier
  does one rectangle a buffer.

**The virtual window**
- 1024² cells: 64×64 chunks, or 16×16 regions. It is toroidal: the table is indexed by
  `(chunk + Globals.pageOrigin) mod 64`.
- Re-centring rotates the table and sends `onSlide`. No GPU data moves, and it happens about every 384 cells
  instead of every 64.
- `G.mapW/mapH` becomes 1024; `G.chunksX` becomes 64.

**GPU layout** (revised round 107, measured)
- **The sparse table (P2.4) gets a binding of its own — a uniform or a storage buffer, never inside Globals.** The
  first design put it in Globals (`Globals.pages`, 8 KB, no new binding). Measured on the desktop's D3D11 iGPU with
  scripts/kernelab.mjs (every sim kernel's dispatches replayed alone, per workgroup, alternated 3-4 times against
  places): a table in Globals, dynamically indexed, made every kernel ~45-60 % slower per workgroup — every read of
  Globals, not only the lookups, the own-page fast path or not (48 % with the table sized to the window, 2.9 KB);
  an 18 KB Globals cost ~55 % even with the ring computed and no table read; Globals at its old size with the ring
  computed: -4.5 % (noise). Which binding — a uniform of its own or a read-only storage buffer (the 33 kernels
  already at 8 storage buffers can't take one: a uniform, then, or freeing a slot) — is M1's question on the phone.
- Entries are the page's place in the atlas, px | py << 8 (the slot is py * nx + px): neither a buffer's index nor a
  texel needs a division (a slot's % and / by the chunks across cost the texture-heavy passes 30-130 %).
- 0xFFFF means not resident. The CPU is authoritative and rewrites the table when residency changes, which is rare.
- Dense (P2.1-P2.3, today): the slots are the ring's places, computed (`?pages=ring`, the only mode the game uses);
  `?pages=table` (the table in Globals, sized to the window) is a test path only, for `?pageperm=` (shuffled slots,
  the identity test) — nothing in the game branches on it.
- A column's page is found once (common.wgsl colPlace's own-page cache; a cull list's entry carries its page's place),
  and a neighbour goes through the table only when it's in another page.

**Helpers** (`common.wgsl`; only these change)
- `slotOf(c)`: a table load. `resident(q)`: inside the window and `slotOf != NONE`.
- `colIdx(x, y) = slotOf(c)*256 + (y%16)*16 + x%16`.
- `texPage(slot) = vec2(slot % SX, slot / SX) * 16`, with an atlas SX = 32 pages across (576 slots give 512×288
  texels). `texCol2` uses 8×8 texels a page; `texColK` stays K wide.
- `colXY` inverts through a per-slot `slotChunk` array: a CPU mirror, with a GPU copy only where it's needed.
- `inMap(q)` becomes `resident(q)`. `asleep`/`drowsy`/`hfield` index by slot (64 words still cover 2048 slots).

**Pool size**
- N slots for every per-column buffer: `cells` becomes `poolCells = slots·256` in `world-gpu.ts` (34 sites) and the
  11 `mapW*mapH` shader sites.
- Start at 36 blocks: 576 slots, 147k columns. At SH10's ~1.1 KB a column that is about 160 MB, under the 448×320
  and 512² windows the phone already ran.
- Largest bindings: the layers at K16 (256 B a column) are 38 MB, agentDist (192 B) 28 MB. Both are under 128 MB
  (R5). The cold region pool stays at 32 slots, about 52 MB.

**Free list and layers**
- A `Uint16Array` stack of free blocks; alloc and free are O(1).
- A freed block's Sleep state is reset. Land coming in is drowsy for DROWSE_TICKS, as now.
- The streamed world has uniform K, so `colSlots` becomes `slotOf(c)*pageSlots + …`. Sandbox maps with varying K
  keep their `chunkTable` in the dense layout.

**Edge policy for a missing neighbour**

The planner keeps a one-chunk halo resident round every awake or drowsy chunk (simscale's NEAR dilation applied to
residency). A missing page is then only met at the asleep border, and the list below is a fallback. A debug atomic,
`edgeMiss`, counts awake columns that read a missing neighbour; the target is 0.

- Water, oil, lava (`liquid.wgsl`, `*_flux`): today's window edge, `C_DRAIN`. A resident asleep neighbour keeps its
  frozen head.
- Wind: the analytic `mapWind(world p)`. Painted wind past the border is dropped; `windrect`'s box is clipped to
  resident chunks.
- Agents: no way (FAR), as at the scope's edge. Units over a missing page freeze, as if asleep.
- Sediment, fire, plants, contamination: no exchange (today's `inMap` false branch).
- Render: clamp to the nearest resident column for normals, shore and AO, and draw nothing past it. Tiles cover
  non-resident regions in view (TC2; TC9 keeps a region's tile after it leaves).
- Particles and physics: off the map. Particles are dropped and bodies sleep.

## 2. Residency policy

`ResidencyPlanner.plan(input) -> { want: RegionKey[] by priority, evict: RegionKey[] }` is pure and tested in
Node. It runs every 100 ms. The Streamer carries out the plan with what it already has: `bring` (pool, store or
gpugen), `freezeInto`/`copyIn` (now block to block), and `TilePacer`.

Inputs: the camera target and velocity (world), the view heading, `weather.storms`, `WakeSet.active()`,
`AgentScope.box`, and the budget.

Priorities:
1. **Core**: the regions overlapping a 256² square centred at target + v·0.5 s. Always resident, never denied.
   This is the "dense window"; its size is set from M2 and M5.
2. **Heading corridor**: a strip 3 regions (192 cells) wide, from the core's front edge out to `v·T_ahead + 64`
   cells. T_ahead = 3 s (`?ahead=`). At an assumed 40 cells/s that is 3 regions; M4 replaces the speed. The
   corridor turns with the heading (WM5/N5).
3. **Wake requests**, by reason priority (§4).
4. **Storms** with intensity over 0.2 within 512 cells: the footprint moved ahead by (vx, vy)·2 s, clipped to 384
   cells from the camera.
5. **The agent scope** box, and the halo round awake chunks.

**Budget**: the hot pool's slots, plus an awake budget (start at 192 awake chunks, set from M5). The planner fills
blocks greedily by priority, then by time to reach along the heading. Requests that don't fit are `pending`, or
`denied` past 768 cells.

**Hysteresis and pacing**: a region leaves only after being unwanted for 2 s; the victim is the least recently used
region behind the heading. At most 2 regions in and 2 out a frame, within the 2 MB-a-frame upload cap.

**Eviction**: a hot block goes to a cold pool slot (the copier gathers from page-major order). Changed regions go to
IndexedDB through the existing sweep and hash; unchanged regions are dropped and made again. Records keep the
row-major format, so `RECORD_FORMAT` doesn't change.

## 3. Active-chunk dispatch

`cull.ts` AwakeTiles becomes **ChunkLists**, keyed by slot. An entry is `u32 = cx(6) | cy(6) << 6 | slot(10) << 12`.
`cullSource`'s wrapper derives q from cx/cy and passes the slot on, so a workgroup's own page needs no table load.

The lists stay CPU-built uniforms with direct dispatch, as simscale chose. Their size is set by the pool, not the
window: 576 entries, 144 vec4s.
- LIVE: awake or drowsy.
- NEAR+n, AWAY+n: as now, dilated through a per-slot neighbour table rebuilt when residency changes.
- CUSTOM: agents, and windrect clipped to resident chunks.
- **RESIDENT** (new): every pass that used to cover the whole window (surface, the wind refresh band, renderfields
  when not culled).
- **DETAIL** (new): resident and in view (renderprep, sway, SC5).

Indirect dispatch stays only where the GPU builds the list: the agents' `frontBuild` (walking the scope's chunks
through `slotOf`, with entries packed the same way) and the field mesh.

`Sleep.until`, `drowseTick` and `filter` are indexed by slot. `Sleep.shift` and `AgentScope.shift` reduce to
re-centring a key.

Cost: about 576 × 6 lists, roughly 4k iterations a tick (well under 0.05 ms), and at most 6 writeBuffers of 2.3 KB.
That is less than today's per-window-chunk loops at 448 or 512.

## 4. The wake API (engine boundary)

```ts
// src/api/contracts/wake.ts — on AtlasWorld as aw.wake; WorldCore.wake for createSim worlds (activity only)
export type WakeReason = 'player' | 'combat' | 'storm' | 'objective' | 'route' | 'script';
export interface WakeSpec {
  box: { x0: number; y0: number; x1: number; y1: number }; // world cells (x columns, y rows), half-open
  reason: WakeReason;
  ttl: number;          // sim seconds (stops when the sim is paused or a slide is busy); Infinity until release()
  sim?: boolean;        // default true: its chunks awake (the sims run). false: resident only (drawn, frozen), e.g. a route ahead
  agents?: boolean;     // the agents' scope covers it (fields made there)
  priority?: number;    // default by reason: player 100, combat 80, storm 60, objective 50, route 30, script 40
}
export interface WakeHandle {
  readonly id: number;
  readonly state: 'pending' | 'resident' | 'awake' | 'expired' | 'denied';
  renew(ttl?: number): void; move(box: WakeSpec['box']): void; release(): void;
}
export interface Wake {
  request(s: WakeSpec): WakeHandle;
  active(): readonly WakeInfo[];
  budget(): { slots: number; used: number; awake: number; awakeMax: number };
}
```

**Lifetime**
- A request lives until its time to live runs out or it is released. Its chunks then go drowsy and fall asleep by
  Sleep's existing rule, and its residency lingers for the 2 s hysteresis.
- Requests are in world cells, so they survive re-centring and warps. After a warp they are re-judged, and those far
  from the window are `denied`.

**Composition**: a pure `WakeSet` in `src/sim/wake.ts` is the only place activity comes from.
- The player's interaction (`Simulation.eventTaps`: edits, powers, lightning, chips, the bike's splashes) becomes
  internal `player` requests (the event circle plus CHUNK, ttl EVENT_S = 8).
- `frame(target, reach)` becomes a `player` request that follows the hero, renewed each frame and on only with
  WAKE_NEAR (round 83's decision).
- Storms become `storm` requests. `flow/steady.ts` `wakeChunk` keeps a chunk awake while it is unsteady.
- Merging: a chunk's awake-until is the latest end time over its requests, and its residency need is the highest
  priority. `Sleep.update` and `ResidencyPlanner` read the same set.
- Not called `wake()` on `sim`, to avoid clashing with `sim.wind.wake` (a mover's painted wind).

## 5. Migration (each step small and tested bit for bit)

`scripts/pagetest.mjs` extends `ringtest.mjs`: two loads, hand-stepped ticks and slides, every per-column buffer and
texture read back in window order (`core.readBuffer`) and hashed by world coordinates.

| Step | What | Bit-exact test |
|---|---|---|
| P2.0 | Measurements M1–M6 (§6) | – |
| P2.1 | `Globals.pages` filled with the ring's values; `colPage` becomes a lookup; `Ring` becomes `Pages` (dense layout) | `?pages=table` against ring, with ringbias 128,64 |
| P2.2 | Page-major storage (`slot*256 + local`), texture page atlases, the copier's page gather, `Pages.toWindow` for readbacks and the CPU's `outside`, ground and relief | `?pageperm=<seed>` (shuffled free list) against identity, still dense |
| P2.3a | `slowTick` stagger and chunk-index hashes keyed by world chunk: a deliberate baseline change, in its own commit | new baseline; culltest |
| P2.3b | Sleep, drowse, hfield and ChunkLists keyed by slot, with packed entries | pageperm against identity; culltest |
| P2.4 | Virtual window 1024; `poolCells` separate from `mapW×mapH`; whole-window passes go to RESIDENT; `inMap` becomes `resident`; resident set = a 256² square | `?virt=1024` against a dense 256 window, by world coordinates |
| P2.5 | ResidencyPlanner (Node unit tests) plus region-block residency in the Streamer; slides become re-centring | `?resplan=slide` (the planner wanting exactly the old window) against the old streamer across 2 slides; pan bench p99 |
| P2.6 | WakeSet, the API, and Sleep reading it | Node tests (merging, ttl, deny); level identity with no requests |
| P2.7 | Corridor and storm shapes on; the `edgeMiss` counter; the phone bench riding through a storm | edgeMiss = 0; no p99 frame over 16.6 ms |
| P2.8 | (WM4) per-system scoped storage: agentDist on the scope's own small table, sedOut only where awake | agentfieldtest |

## 6. What to measure first, and the risks

- **M1, the table lookup on Mali (Pixel 9a)** — caveat (round 107): the bench's "table" page put the table in
  Globals (8 KB, dynamically indexed), which the desktop showed slows every Globals read, so its numbers carry that
  penalty and say "in Globals", not "a uniform table". A rerun is to measure a table in its own binding: in-pass timestamps (bench v4) for `liquid`, `sediment` and
  `water_flux` at 256 dense. Compare the computed ring, a table in Globals (uniform) and a table in a storage buffer.
  Target: no more than 5% more GPU time a pass. If over, two fallbacks: a fast path that skips the lookup inside the
  own page (about 77% of columns don't touch a page edge), or the 3×3 neighbour slots kept in workgroup memory.
- **M2**: `memprobe.mjs` at 256 for real bytes a column, buffer by buffer. This sets the slot budget against the
  650 MB tab limit.
- **M3**: region arrival latency on the phone from the pool, the store and gpugen (p50/p95). This sets T_ahead.
- **M4**: the hoverbike's speed (p95 cells/s) and the camera's ground reach in portrait. This sets the corridor's
  length and width.
- **M5**: SC6 riding through a storm at 256. GPU per awake chunk per system gives the awake budget.
- **M6**: the cost of RESIDENT passes at 576 slots, against making them dirty lists.

Risks:
- Breaking the halo invariant would drain water. The counter detects it, and the planner reserves the halo first.
- Residency churn could cause hitches. Pacing (2 regions in, 2 out a frame) mitigates it.
- Seams at an irregular border: tiles must cover every non-resident region in view (TC2/TC9). Check against TC3.
- The Streamer refactor is large (2390 lines). Its CPU per-column arrays already go with pool slots as per-region
  parts; move them to blocks.
- The field mesh and instance lists are keyed by window chunk and must be rekeyed by slot.
- Results that depend on order (atomicAdd lists, particle emission) must be sorted, or left out of the hashed fields.
- Uniform dynamic indexing on Mali: decided by M1.

Critical files: `src/shaders/common.wgsl`, `src/sim/ring.ts` (becomes `sim/pages.ts`), `src/sim/cull.ts`,
`src/sim/sleep.ts`, `src/scenes/streamer.ts`, `src/sim/world-gpu.ts`, `src/api/atlas-world.ts` (the wake API's
home), `scripts/ringtest.mjs` (the base for `pagetest.mjs`).
