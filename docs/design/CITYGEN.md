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

## Later phases (scope)

- **M4b, claims, surfaces, reach** (this body of work). The town claims its buildings' columns as External intervals
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
