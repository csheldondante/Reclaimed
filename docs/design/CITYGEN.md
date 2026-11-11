# CITYGEN — towns from fields, on the GPU, in the game

The in-game migration of the street lab's town generator (`src/citygen/`). Design authority:
`.claude/docs/design/DESIGN.md` §11–13, §17, §24. Phases M4a–M4e (M4a done here).

The user (2026-11-10):
- "If we are switching to this layout then I think players just choose opportunities and we place and build for
  them. The only painting would be future work to make buildings customizable."
- "we still may want the irregular grids for vertical surfaces but you can retire the player painting and migrate
  to this system."
- "Do add bridges though across the water that's needed. I would do that with the main roads coming into the city."
- Buildings stay plain extruded lot shapes here. Facades, dressing, superstructures and the construction animation
  are two other sessions' work, from the lot records below.
- "Physics integration is a must but can be a separate step as well. It may make sense to do as part of the improved
  building generators."

## One pipeline

`src/citygen/gpu.ts` (`CityGen`) + `streets.wgsl` + `height.wgsl`: field → φ → cross streets → blocks → lots → lot
records → mesh. The street lab (`?level=streetlab`, `src/streetlab/control.ts`) mounts it with a panel. The game
(`src/citygen/town.ts`, `FieldTown`) mounts it with the town's inputs. The parameters are one table
(`src/citygen/params.ts`).

## Inputs (uploads only)

| Input | Where | Size |
|---|---|---|
| the town's box in the window (first column, row; columns, rows) | `height.wgsl` uniform | 16 B, once |
| centre, radius, seed, parameters | the passes' uniforms | 256 B a pass |
| the site's atlas roads as stamped (`Settlements.approachWays`: way points every 4 units, centre outward) and the core radius | `ART` | ≤ 8 × 128 points, once |
| the mesh's place in the window | `Renderer.addMesh` transform | 16 B on a slide |

The one read back is the run's timestamps and two counts, once, after the town is made (an event, never a frame).

## GPU buffers (owned by `CityGen`)

- `H`, `M`: the grid's ground height and wet mask, read from the world's `layers` and `water` (height.wgsl).
- The fields (`HS`, `BLK`, `FD`, `FDB`, flood ping-pongs), seeds, blocks, lots, landmarks, supercells: as the lab.
- `ART`: the arterials: a count, then per arterial its direction (CPU), its length and up to 4 bridge spans (start,
  end, deck z; the GPU's `artSpan`).
- The contract buffers below, and the mesh (`verts`, `args`).

## Arterials and bridges

Each arterial is one of the site's atlas roads as it is stamped in the land (its way points, uploaded once, from the
centre outward); the lab's are straight test spokes. On the GPU:
- `artSpan` (a thread an arterial) marches it a segment at a time over the wet mask. Each wet run, closed by 2 units
  of dry ground, becomes a span with a deck at the higher bank's height + `deckClear`. A crossing longer than
  `maxSpan` (120), or water that runs on to the grid's edge, ends it at its shore.
- `artRast` + a jump flood make the arterials' distance field `AD`. Lots read it (`lots` drops a lot whose middle or
  edge comes within the corridor) and so does growth (`growCost` × 0.6 within half a contour spacing).
- `artEnd` (after the supercells) ends each arterial where it leaves the town's limit, never short of the core.
- `artMesh` draws a ribbon tapering over its last 12 units to the atlas road's width, and over a span a deck piece and
  pillars every 6 units.

**One road, not two.** Within the core (0.5 radii) of a field town's centre the atlas's own stamps are dropped before
the land is made (`Settlements.byFields` → `atlas/ways.ts waysWithout`): the site's plaza disc and the roads' graded
fill. Past the core the stamped road carries on; the arterial is drawn at least to the core, so they meet. At Muru the
plaza and the north road's fill had dammed the river at the centre. With them gone, the north road comes in on a deck
along the lake shore. Tried first and dropped: the arterials as seeds of the distance flood.
φ collapsed into a star where they met at the centre, and the river site lost half its lots.

## The window and streaming (the derisk)

- The window is a ring of whole regions (64 columns). Every per-column buffer is addressed by window column through
  `colSlots`/`colIdx`, so a box of the window reads like the lab's whole window. The box's first row is even, so its
  rows' hex offsets are the window's (`cellPos` parity).
- A town's size comes from its settlement size: radius camp 30, hamlet 48, village 72, town 120, city 150. A town
  matches the lab's Muru the user approved. The box is fixed in the world: 4/3 radii each way, as many rows as columns
  (the lab's 320 × 320 sites), the first row even (`fieldTownBox`). It does not depend on the device's window size, so
  the town is the same on every device.
- **Trade-off (to decide):** a town's 320 box needs the window to cover its regions, 384 × 384 at Muru. That is 2.25×
  the desktop default (256) and 1.44× the phone's (320). The level opens the window that size, so streaming and the
  sims cover more columns everywhere, not only near the town. Not measured on the phone yet. Shrinking the town
  instead was ruled out (the coordinator).
- The town is made once, from the live land, when its box is in the window. The level opens the window round the box
  (the fortress's `windowHolding`; the window grows to the box when smaller). After that the window may slide
  anywhere. The layout and mesh stay in the box's frame on the GPU. A slide or a warp writes the 16-byte transform
  (window x, y of the box's first column; z by the change in `oz`). Nothing is remade or read.
- Not needed for M4a: a town made before its land is resident. If that comes (other towns, M4d), feed `H`/`M` from
  the far land's GPU rough ground (`bake.wgsl roughGround`) or gather the box region by region as it arrives. Never
  from the CPU.

## The old generator, switched off per settlement

`Settlements.byFields(id)` (before the first window): that settlement gets no plan, no stamps on its land, no far
plan, no view and no life. Its record stays (name, roads, people). The irregular tile-grid code
(`structures/tiles/*`) stays, for vertical and cliff cities later.

## Contract: lot records and construction progress

`src/api/contracts/citygen.ts` (`CityLots`, `LOT_KIND`, `LOT_RECORD_WORDS`): what the building style generator and
the construction shader read. `FieldTown.lots` hands them over.

- **Records** (24 u32 a lot, f32 by bitcast): parcel quad, footprint quad (the parcel inset by its streets and the
  setback), frontage edge (the widest street's; 255 none), kind (none, building, park, plaza, landmark site),
  district (supercell id), storeys, height (base to roof), base z, growth key, seed (the lot's identity). Lot slot
  `i` is record `i`; landmark site `k` is record `counts[3] + k`. Positions are in the grid's frame: add `place`.
- **Counts** (4 u32): lots, landmark sites, words a record, the first landmark record.
- **Progress** (f32 a record, 0–1): set to 1 when the lots are made. The construction owner writes it on the GPU. The
  town's mesh scales each building's height by it on its next mesh run (`CityGen.run(p, 'mesh')`).
- An index is stable until the lots are made again. The seed is the identity across that.
- The height-to-plot rule: a building is no taller than `hRatio` (0.7) × its footprint's shortest side, at least
  a storey and at most the storeys' most × 1.3, so the street behind it stays in sight at 60°.

## M4b as built (2026-11-10, approved: "Yes make it gpu owned and driven by the population density map …")

- **Claims, GPU-owned.**
  - citygen builds its claim grid each mesh run: dense over the box, claimGrid's layout, a span a column. Buildings
    are footprint × base to height × progress (owner word = lot record + 1). Roads are a quarter cell of paving on the
    ground (owner 0); a building's or plaza's parcel round its footprint is marked bare only (BARE_ONLY, no span).
  - `StaticClaims.gpuGrid` claims it with the existing `claimGrid` kernel over the written window and per arriving
    region.
  - The orphan pass holds its spans on the GPU (colapply `orphans` binds the owned grid: `ownedJob`). The CPU orphan
    paths skip its box (`StaticSet.gpuOwns`).
  - After an edit, colapply `gridDamage` checks its spans in the dirty boxes. The damaged owners come back (≤ 64
    words, once); the town logs them and keeps them (`FieldTown.damaged`).
  - The old towns' CPU-span grids are unchanged until M4e, behind the same StaticSet. One GPU-owned grid at a time
    (the orphan pass binds one).
- **Decks are not claimed in the world's columns.** A column's top is its water's floor (surface.wgsl,
  water_flux.wgsl), so a deck there lifted the river onto it. That showed: decks vanished under water in the first
  try. The reach walks decks as plan solid instead (`CityGen.deckSpans` → `FortressReachGpu.planSpans`). Units' own
  surfaces won't have decks until the water model allows a gap under a top (BACKLOG).
- **Plants:** `bare.wgsl` sets the plants' field (veg and the next tick's) to none on claimed and bare-only columns as
  they're claimed: the old towns' BARE stamp, for a town made after its land. External tops cap growth at moss.
- **Reach:** `FortressReachGpu.markFrom` runs one solve over the window from the town's road (its point at the core's
  distance) and writes a mark per column (fortreach.wgsl `reachMark`). citygen `lotReach` samples six points on each
  building's street. A building none of whose points is joined (and one is ground) is outlined red on its roof.
  It runs after the claims and again after each slide.
- **Population field** (`popField`), **road tones and widths**, **raw ground** (`Atlas.rawGroundGpu`, `rawheight.wgsl`),
  **sloped decks** and the **town bridge** (`townBridge`): DEVLOG 2026-11-10, citygen M4b steps 1–2.

## Streaming (M4b step 4)

The user: "I assumed we would stream in the grid generation as needed so when we pan to a new population center it
appears but we can ignore it where there is no population or low enough not to necessitate a grid."

- **Which settlements get a grid:** those with a peak density of 0.6 or more (village, town, city: `hasGrid`) — 140
  in this world. Below it, no grid: the old planner's hamlets and farms until M4e. At level start
  `Settlements.byFields` takes them all in one pass: their roads kept, the atlas's stamps cleared in their cores.
- **`FieldTowns`** (citygen/towns.ts) streams them.
  - Every 0.25 s it compares each town's box with the window.
  - Within 128 columns, the nearest such town is made (one at a time, from the raw ground, paced by the atlas's tile
    gate).
  - Beyond 448 columns, a town is let go: its buffers freed, its claim slot back.
  - On return it is made again the same way (a pure function of seed, ground and population field).
  - Muru has no special case; it is the first made because the level opens on it.
- **The pool:** the static claims' arena has 4 slots of a city's box (448² columns × 32 B = 6.4 MB each, 25.7 MB) and
  a table of grids at its head that colapply's orphan and damage passes read. When every slot is taken, the farthest
  town not wanted gives its slot up.
- **Memory per town:** 29.8 MB of generator buffers plus its 6.4 MB claim slot. The fields are 4 bytes a column ×
  ~26; the records 3.1 MB; the mesh room 160 000 vertices = 5.1 MB; the raw ground 1.6 MB.
- **Saving (later, if needed):** a per-town edit log keyed by world position, laid over the regenerated town.

## Time-lapse and the opportunity hook (M4d's start)

- **A clock per district:** SCT word 8, a supercell's start on the town's clock (−1e30 built, 1e30 not begun). It is
  set on the GPU:
  - `clkInit`, after the supercells: all built (the lab, the bench), or only the core (growth key < 0.35: a game town);
  - `clkTimelapse`: every district not begun starts at T0 + its growth key × the spread, the centre first;
  - `clkClaim`: an opportunity's district.
- **A lot's progress** (`tlProgress`) is clamp((now − its district's start − its own delay, up to 3 s) / 4 s), into the
  progress buffer of the contract.
- **The mesh is made full height,** each vertex tagged (VTAG: its kind and record or district, its z as made).
  `tlRise` moves the tagged vertices each frame:
  - a building's tops to base + height × progress (its bases and outline sunk out of sight until it begins);
  - a park or a plaza hidden until it begins; a road sunk until its growth begins (CG25, below).
  - This is a compute pass, not the vertex shader: the draw stage already binds its 8 storage buffers, and the
    progress buffer (33k floats) is past a uniform's size.
- **Roads grow in with their lots (CG25):** each lot's start (the clock time its progress first passes 0, `LSTART`)
  is stamped along its parcel's edges (±3 cells) into a front field (an ordered-f32 min a column, the road raster's
  tail). A minor street shows from the earliest start along it; a main road (`skelReach` 3, the default) once lots
  front it or it links two districts begun (both sides begun, or two begun round an empty district it crosses, within
  `skelMargin`). Each grows in over 0.4 of a build, done as its first lot starts rising — a minor street from the end
  whose road shows first, a main road outward from the centre — with its first 1.2 s laid as dirt. Each road vertex
  carries the time the growth reaches it (word 7 bits 8–31; bits 0–7 the surface); the draw clips against the town's
  clock in the mesh's place (`MESH_XF.w`): no remeshing a frame. Claims mark a road once its growth begins.
- **The claims follow:** while districts build, every 2 s of the town's clock and once at the end, the town runs its
  mesh stage again (the claim grid from the progress) and `StaticClaims.reclaim` claims it over the window.
- **The CPU passes only the clock and which start:** the town's clock (s, `FieldTowns.townTime` × `speed`), a
  time-lapse's T0 and spread, a claim's kind. A claim reads back one word (the district's id).
- **API** (`src/api/contracts/citygen.ts` CityDistricts; `window.citygen` in the game):
  - `claimDistrict(kind) → Promise<districtId>`, with kinds housing, market, harbour, workshops, farms, keep → the
    purposes;
  - `timelapse(span)`;
  - `townTime`, `speed`.
  - Debug panel: `?citypanel=1`; `?timelapse=1` starts one (`&tlspan=30&tlspeed=1`).

## M4b: stopped at the claim registry (superseded: built as above)

The brief: claim each lot's building, the roads and the decks as External intervals through the existing claim path;
clear flora under them; run the GPU reach over the result. Stopped before building, because the existing path holds
ownership on the CPU:
- `sim/static-claims.ts` (StaticClaims) takes each thing as CPU column spans (`StaticThing.cols`), indexes them by
  column on the CPU and uploads a grid buffer. colapply.wgsl `claimGrid` writes them as each region arrives.
- `sim/external.ts` (ExternalRegistry) is "the truth of who owns what". Its orphan rule runs after every whole read
  and every slide (game/integrity/tick.ts → `gpuEdit.orphans(cols, ext.claimedSpans())`): any External interval the
  CPU doesn't list becomes its fallback material. Claims written only by a GPU kernel would be wiped at the first
  slide. `verify`/`cut` (a building dug into) also work from CPU spans against the integrity's CPU copy.
- Old towns cleared plants with atlas stamps (`BARE` in atlas/stamps.ts) while their land was made. The field town is
  made after its land, and External tops have growthCap 1.2, so a claim alone doesn't stop growth either.

Feeding the existing path means reading back every lot record (~45 KB at Muru) and rasterising tens of thousands of
column spans on the CPU, every regeneration. That breaks the GPU rule, so it wasn't built.

**Proposed: GPU-owned static grids** (each step a GPU pass; the CPU passes ids, boxes and a few words after an edit):
1. citygen rasterises its claim grid on the GPU in claimGrid's layout: a column list over the box (x, y, first span,
   count) and spans (z0, z1, fallback). Buildings are the footprint × [base, base + height × progress]; decks are
   [deck − 0.8, deck]; roads are a paving span. Each span also carries an owner word, (town grid id, record index):
   the contract's per-record keying.
2. `StaticClaims.gpuGrid(name, owner, place, buf, cols)`: claimed per arriving region by the same `claimGrid` kernel;
   the CPU never sees its spans.
3. The orphan pass reads the GPU grids' buffers as "claimed" on the GPU (colapply `orphans` gets the grid buffers
   bound). The CPU-copy orphan path skips columns a GPU grid covers (its box, known on the CPU).
4. Verify/cut on the GPU: after an edit, a pass compares a grid's spans with the columns and writes the cut records'
   ids (a few words back). The owner is told; a later physics step takes the record over (release by record, then its
   own claim).
5. Flora: a per-column "built" mask on the GPU (the claim grid's coverage), read by the plant passes (vegprep,
   florafield, the growth kernel) as a cap of 0: a new WorldGpu contract buffer. vegprep already uses all eight storage
   bindings, so the mask has to be packed into an existing one (e.g. renderFields) or vegprep split.
6. Reach: `build/reachgpu.ts` FortressReachGpu over the window once the claims are in. Its seeds are the town's
   centre (an input); the cut-off components show in its red outline.

The user's call: this changes the External contract (static ownership no longer all on the CPU) and adds a WorldGpu
contract buffer (the built mask). Both are architecture changes, so they wait for sign-off.

## Later phases (scope)

- **M4b, claims, surfaces, reach** (this body of work; built, above). The town claims its buildings' columns as External intervals
  naming the town's grid, per record (the record's index and seed in the owner word). A later physics step or the
  building generator can then take over one building's intervals by its record: release the town's claim, write its
  own, nothing else touched.
- **M4c, routes** (this body of work): merge the legible route graph (`trackA-legible`, DA-A22) and feed it the new
  road segments and the arterials' decks; cached routes; riders.
- **M4d**: the plan buffer; opportunities claim districts and sites, which fill in growth order with construction
  progress per lot.
- **M4e**: delete the old CPU generator, painting and its consumers.
- **Not citygen**: physics integration of buildings (structural integrity, collapse, rigid bodies: DESIGN §9, §10), a
  separate step, maybe with the improved building generators. The building style generator and the construction
  animation shader belong to their own sessions.

## Determinism

The layout is a pure function of the seed and the ground. 9 reruns give the same lots (473) and the same vertex count.
Three atomic orders used to decide it:
- a grown street's landing slot (`gplace`: a workgroup scan by source id, not an atomic counter);
- a gap block's key (its region node, not its slot);
- ties among the landmark sites (by position, not list order).

Lot record indices still follow the lots' atomic order. The seed is the lot's identity.

## Measurements (M4a polish, headless D3D11, Muru radius 120)

- The whole town from the field stage: median 3.74 ms GPU over 9 runs (3.27–4.15). Field 0.83, φ 0.13, trace 1.34,
  lots 0.87, mesh 0.55; heights 0.26 ms once. 473 lots, 3 approach roads; box 320 × 320, window 384.

## Measurements (M4a, headless D3D11, Muru radius 60, superseded)

- The whole town from the field stage: median 1.87–1.96 ms GPU over 9 runs (1.51–2.35); heights 0.20 ms once.
  Field 0.39–0.43, φ 0.07, trace 0.71–0.78, lots 0.35–0.39, mesh 0.20–0.44.
- The first run in a page: 6.2–7.1 ms (the first use of each pipeline).
- 123 lots and 3 approach roads; a 256 × 256 box.
