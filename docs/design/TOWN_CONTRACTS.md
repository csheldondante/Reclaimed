# TOWN CONTRACTS — the side map and the named places, on the GPU, for Track B's unit minds (U2/U3)

Track A's side of what Track B's units need from a town: which side of a town's wall a column is on, and where a town's
named places are. Both are resolved on the GPU from citygen's contract buffers (`api/contracts/citygen.ts`: CityLots,
CityRoutes) and the world's columns; nothing is read back. Code: `src/towncontracts/` (`contracts.ts` TownContracts,
`sidemap.wgsl`, `places.wgsl`), the read snippet `src/shaders/townplace.wgsl`, the contract
`src/api/contracts/townplaces.ts`. Made by the level with the field towns (`scenes/level/stream-setup.ts`; `?contracts=0`
off: the toggle diff).

The user's rule: "The CPU paths are supposed to be GPU resident … we should not need CPU readback." Orders carry
intent by index only — a town's index, a place's name, a district id and a rank — and the GPU resolves them where the
order runs.

## 1. The side map

**Where it goes:** Track B's own `agentSides` (agents/notice.ts `UnitNotice.sides`, read by notice.wgsl `sideOf`): a
u32 a window column, window order (y · W + x). 0 is open; a town's side is its index + 1 (`SIDE_OF`). Track B turns
the rules on with `notice.hasSides = true` (no upload: the map is already there).

**What a side is:** a column is on town t's side when it lies in t's region — inside its ring's polygon, or on the
wall's band (2.5 units of the ring's line: the wall-walk's outer half) — and its walkable component reaches no walkable
column outside every region.
- Walkable: a column's top read from its own slots (`layers`: what the chunk versions follow — the surface pass's copy
  lags a tick, so a solve woken by a claim could read the old top), the water no deeper than the agents' DEEP (0.9), not
  a barrier.
- Joined: hex neighbours whose tops are within the agents' STEP (1.1).
- **The wall itself:** a wall piece's own columns (within citygen's wallCols half width of a piece's line) standing 2 or
  more over the piece's foot (its corners' ground, WALL words WB_Z) are the wall: not walkable, their town's side.
  Below that (not risen yet, or dug down: a breach) they're ground and a way through. First tried as plain tops: at
  Muru the wall-walk joined the outside where the hillside outside the ring rises near the wall's top, and the whole
  town read open.
- Barriers drawn from the ring's words (WALL): a **gate** when the gate rule is `closed` (the default; `open` lets an
  open gate join inside and outside — `TownContracts.gates`, `?sidegates=open`), and **always** a segment the ring
  leaves open over water or a cliff (kind 2). Chosen because gates are a thing of their own later (opened and closed by
  orders, breached): until then the town's inside is what the wall encloses. The water gaps are citygen's own: the
  ring leaves them to the water, but the banks under a gap are dry ground — at Muru the river's banks let a walker
  round the last tower (found here; BACKLOG UC-3).
- citygen fix found by it: a wall piece left its columns unclaimed wherever an arterial's corridor came near (meant for
  a gate's corners) — a road running along the ring left an ungated hole. Now only the pieces beside a gate leave the
  corridor open (streets.wgsl `wallClaim` / `wallCols(…, openArt)`).
- Labels: every walkable column outside the regions 0, the others index + 1, hooked to the least label round them and
  pointer-jumped until a round changes nothing (fortreach.wgsl's flood). A component holding a 0 is open.
- Several towns: each its own region and number. Two rings overlapping (never made) would mix.

**When it's solved — woken on the GPU:** `sideWatch` (a thread a chunk over each ring's box) keeps the newest **shape
version** (chunkver.wgsl: a slot's ends, its material — a piece risen, a breach, a building) and the newest **water
class version**; `sideWake` (one thread) starts a solve when the shape moved, a ring's words' hash moved, the window
slid (`G.org`, `G.ring`), or the CPU's input epoch moved (a town made or let go, the gate rule) — and, at most every
120 frames, when the water's class moved (it flickers every tick where a river runs: measured at Muru, the columns' and
class words move every tick over the ring's box; the shape words every few seconds). A change during a solve waits for
the next one. A solve is indirect dispatches: clear, raster (a town), prep, then up to 8 rounds of hook + jump a frame,
final, done — 0-workgroup dispatches once settled. Muru: ~5 rounds.

## 2. The named-place table

**One read-only buffer, every town slot** (`TownContractsApi.places`, `PLACE_BINDING` 57), read only through
`townplace.wgsl`:

| function | what |
|---|---|
| `place(town, name)`, `placeApproach(town, name)` | the place in the window (x, y, z on the walkable ground: a building's door just out from its face, open land's middle, a gate on its arterial's road — a deck at its height —, a spawn point on the road past the limit) and the point to come to it from (a door's street, a gate's inside, a spawn's way in) |
| `placeStatus`, `placeValid` | `PLACE_OK` (valid), `PLACE_NONE` (it doesn't exist: no card built, no ring, no lot), `PLACE_RISING` (begun, not finished; a gate whose wall isn't up), `PLACE_WATER` (a gate over water; a spawn point with no dry, walkable ground on its road in the window — UC-13), `PLACE_NO_TOWN` |
| `placeAux` | a lot's seed, a gate's ring segment, a spawn's arterial |
| `gatePlace(k)`, `spawnPlace(k)` | the names of gate slot k — routeread.wgsl `gateRoute(k)`'s indexing (the arterial's index, filler gates after, the same rule from the same words) — and of arterial k's spawn point |
| `districtPurpose(town, d)` | a district's purpose (citygen P_*) |
| `lotCount(town, d, kind)`, `lotAt(town, d, kind, rank)`, `houseAt(town, d, rank)`, `lotPlace`, `lotApproach`, `lotStatus`, `lotValid`, `lotSeedOf` | the plural things: district d's lots of a kind ranked by (growth key, seed) — the order the district fills in. Never the record's index: it follows the GPU's thread order |
| `townLive`, `townKey`, `townGeneration` | a slot with a town, its site id's hash, a count that moves when the slot gets another town (an order holding a town index compares it) |

**The names** (`PLACE` in the contract, `PLACE_*` in the snippet):

| name | from |
|---|---|
| muster | **the walls card designates it:** once the ring is made, the begun open lot (plaza, park, an open landmark) inside the ring nearest its first gate |
| stores | the begun building nearest the centre in a market district, else nearest the centre (the living town's STORES rule, mirrored from the records) |
| market | the begun open lot (else building) of a market district nearest the centre |
| keep | **the keep card:** the tallest begun building of a keep district |
| barracks | **the keep card:** the keep district's biggest begun building other than the keep (no barracks card yet: BACKLOG UC-4) |
| gate0 … gate9 | gate slots (arterials 0–7, filler gates 8–9) |
| spawn0 … spawn7 | arterial k's road 16 units past the town's limit, its approach 8 back — **on dry, walkable ground** (UC-13, below) |

**A spawn point stands on dry, walkable ground (UC-13).** Muru's spawn point 0 had its approach in the river (2.4 deep,
21 of 24 samples round it past DEEP), and raiders placed round it drowned on arrival. `plHead` now takes the first of 33
candidates along the arterial — the nominal one (16 past the limit), then a unit farther out each, short of the road's
end — where the spawn point, its approach and the crowd round the approach all stand:
- standing: the window holds the column; its top (from its own slots, as the side map reads it) is within STEP 1.1 of
  the table's z (citygen's height, or the deck's); its water is no deeper than DEEP 0.9 (waterclass.wgsl);
- the crowd: orders.wgsl stands rank k 0.9·√k round the approach on any surface within 1.2 of its z, so every such
  surface on two rings of six (1.5 and 3 units) round it must be dry too.

None of the 33 → `PLACE_WATER`, so a season's chain (war.ts raidPlaces) goes on to its next spawn point. The search
runs outward only (never inside the nominal point, which would put the approach at or inside the limit, or inside the
ring). A column the window doesn't hold doesn't count as ground: a unit can't stand there. At Muru, in the lab's window,
arterials 0 and 1 cross the river at the limit and leave the window just past it, so spawn points 0 and 1 read WATER;
spawn point 2's road is valid when the window holds it (it slides with the camera: a slide re-solves).

**Input: the world's columns and water, read in the solve.** Chosen over waking on the water class's chunk versions
(the side map's way): the solve needs the depth at a few hundred points anyway, and a hash of exactly those points'
standing wakes it only when one of them flips — not when the river moves anywhere else in a chunk. `plHead` has its own
layout (the ring, the arterials, the heights, the table, the chunk table, `layers`, `water`: 7 storage buffers) since it
reads no records.

A lot's purpose is its district's **claimed** purpose when a card claimed it (the CPU's input: `CityDistricts.
claimDistrict(kind)` records the kind's purpose by district id in the town's edit log, `TownLog.purposes`, uploaded as a
byte a district in the town's place uniform), else the population field's at its middle — citygen's `clkClaim` takes the
best district for a kind but doesn't make it that kind, so at Muru the keep card's district is homes on the field. Ties
are broken by the lot's seed. **A solve** (a few thousand threads a kernel, eight dispatches a town): the district
index rebuilt (count, scan, scatter, rank), the picks (an atomic min of a key, then of the seed), the header, gates and
spawn points. A place's status follows its lot's construction progress as it changes.

**When it's solved — woken on the GPU (UC-8):** `plWatch` (a thread a record, and the ring's and arterials' words)
sums a hash of everything a solve reads that can move: each record's 24 words and its progress's **class** (not begun,
rising, built — the status's only input from the progress), the lot counts, the ring's words (WALL, through WB_S: made,
first gate, the stage and its start, corners, kinds, arterials), the arterials' words. `plWake` (one thread) starts a
solve when that sum moved, the place uniform's **version** moved, or the towns' clock passed the **wake clock**; the
eight kernels are indirect dispatches (`PCTL`, `PARGS`: 0 workgroups when nothing woke one).
- The place uniform (the grid's place: a slide; the claimed purposes; a new town; the lot count) is built on the CPU each
  frame, compared with the last one written, and written only when it differs — with a new version (one counter over
  every town, so a town in a reused slot always solves).
- The clock: a gate's status (rising until its piece is up) is the one status that follows the clock rather than a
  buffer. Each solve's `plHead` works out the first clock any gate's status flips at — a piece's rise is monotone in the
  clock inside the wall stage's span, so it bisects there — and keeps it in the slot's private words; the clock passing
  it wakes the next solve. Chosen over making the status a pure function in the accessor: townplace.wgsl would have to
  bind the ring's words and the clock (binding 57 and the accessors stay as Track B reads them).
- The spawn candidates (UC-13): `plWet` (a thread a candidate, 8 × 33) hashes each one's standing — the only thing a
  solve reads of the world's columns — into the slot's words; `plWake` starts a solve when it moved, at most every
  WET_GAP (120) frames: the water flickers across DEEP every tick where a river laps a bank (the side map's WATER_GAP
  for the same reason). Any solve reads it, so a solve for another reason marks it seen.
- Not watched: the world's columns other than the spawn candidates' (the table's z is citygen's height grid) and
  citygen's height and population grids (made with the lots — the 'field' run — which moves the records' hash too).

At rest at Muru (headless D3D11, the whole `towncontracts` pass): 0.47 ms before, 0.19 ms after; the pass without the
places 0.125 ms — the place table's share 0.35 → 0.06 ms (the watch's hash dispatch). A wall rising wakes one solve a
gate; a district rising one solve a lot (each lot's begun and built).

**Track B's `orderFailed`:** an order whose place isn't `placeValid` fails on the GPU, where the order resolves it.

## 3. The `gputown` lab recipe

For Track B's benches and gates: `node scripts/lab.mjs run <scenario> --recipe gputown` (or `export const recipe =
'gputown'` in the scenario). The page: Muru's GPU town and living town, no season loop (`opps=0`), no living panel; the
walls card risen at once (`CityDistricts.wallStart`, `wallStage(0, 1, Skip)`); `--flags "&labkeep=1"` raises a keep
district too (the keep and barracks valid). Ready once the side map has been solved over the risen wall (the inside
holding 40 % of the ring's columns, still over three looks) and the muster yard is valid; `lab.recipeError` says why
not. In the scenario (`lab` = `window.reclaimed.lab`):
- `lab.townIndex(lab.town)` — Muru's index: what an order carries; `lab.contracts.places` the buffer to bind at 57;
  the side map is the agents' own `agentSides`.
- Debug reads (never an order's): `lab.sides()`, `lab.sideCounts(id)`, `lab.places(id)` (decoded: window positions,
  statuses), `lab.contracts.debugRead('pctl')` (a town slot's watch words: `PC.solves` the place solves),
  `lab.markContracts(id, { step, labels })` (an overlay for shots: inside teal, open red; `labels` the
  solve's own words), `lab.gpuMs('towncontracts')` with `--flags "&perf=1"`.
- The gate: `scripts/lab/gputown.mjs` (the side map and places at Muru, two shots).

GPU-ish tests without the page: `test/gpu/towncontracts.test.ts` builds a `ContractTown` over hand-made buffers in
citygen's shapes (`fakeTown`, `ringWords`, `artWords`) on a tinyWorld — the pattern for a Track B test that needs a town.

## What runs on the CPU (inputs only)

| what | when | size |
|---|---|---|
| a town's slot (index) as it's made or let go, its header's live word cleared | a town made / let go | 4 B |
| the input epoch, the gate rule | the same, a rule change | 48 B |
| a town's grid place in the window | made, a slide | 48 B |
| a town's place uniform (its place, centre, the lot kernels' workgroups, the claimed districts' purposes, a version) | when its contents change (a slide, a claim, a new town) — built and compared on the CPU each frame | 336 B |
| the towns' clock (the gates' rise: compared on the GPU with the wake clock) | each frame the clock moves | 16 B |
| encoding a fixed list of dispatches | each frame | — |

Nothing is read back but the debug reads above (tests, the lab).
