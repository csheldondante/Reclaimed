# LIVING TOWN — many people hauling and working in a citygen town, on the GPU

The user (2026-11-10): "I would like to see agents (many of them) traveling between locations, hauling and doing
stuff. I would like a parameterized quarry that digs deep and forest clearing that leaves stumps."

Design authority: `.claude/docs/design/DESIGN.md` §1/§3 (intervals), §8 (loose material, the one `deposit` inbox),
§11 (agents, flow fields only for open ground and changing things), §12 (routes: kinematic trips, cached routes "like
conveyor belts"), §13 (reach), §15 (flora is a field; nothing stored per plant), §24 (GPU-resident, no per-frame
readback). Builds on citygen (`docs/design/CITYGEN.md`, `src/citygen/`, contract `src/api/contracts/citygen.ts`).
Code: `src/citylife/`. URL: `?citygen=fields&living=1` (`living=0` off: the toggle diff).

## The rule that shapes everything

Everything runs on the GPU. The CPU passes inputs only: the town's buffers once, a parameter uniform (counts, rates,
the quarry's and clearing's numbers, toggles), the grid's place in the window (16 bytes on a slide), and it encodes
dispatches. No job logic, no route search, no per-rider state on the CPU. The only read back is the debug panel's
counters: 64 words, async, every 0.5 s, and only while the panel is open (`?living=1`); the game reads nothing.

## 1. The route graph from citygen (the derisk)

**Input: citygen's road raster, not its segment lists.** citygen draws every road it makes — contour streets, cross
streets, gap roads, grown streets, arterials and bridge decks — into one per-column buffer as it meshes them (`ROADS`,
streets.wgsl `markRoad`: 1 a road, `DECK_BIT | z·256` a deck). That raster is what its claims and the reach already
read. The graph is that raster's hex adjacency: a node is a walkable column of the town's box, an edge joins two
walkable neighbours. Junctions come for free (where two rasterised streets touch), which segment lists (five formats,
endpoints that rarely coincide) would have to find. Decks are nodes at their deck height (CG15 doesn't matter: riders
never stand on the world's columns there, they ride the route's z).

The graph's walkable mask `WALK` (a word a column, `walkInit`) is the union of:
- **roads and decks** (`ROADS ≠ 0`);
- **door segments**: per building lot, from its footprint's frontage midpoint out across the setback to its street
  (the parcel's frontage edge plus a cell): a short rasterised segment, so every building joins the network at its
  front door;
- **connector roads** to the works outside town (the quarry's rim, the lumber camp's yard): traced on the GPU down an
  open-ground field (§11: flow fields for open ground) from the site to the nearest road, then rasterised into `WALK`
  (and drawn as a dirt track);
- **site pads**: the stockpile yard by the stores, the camp yard.

**DA-A22 (trackA-legible) is ported, not merged.** Its GPU half is the right shape — distance fields relaxed over the
graph's edges, routes traced down them, decks at a fixed height — but its graph is the old town grid's cell edges with
walls, structures and gates from the CPU `TownPlan`, and it sits on top of DA-A13 (14 k changed lines on that branch).
Merging it would bring a second, unused town model with it ("no duplicate systems"). What carries over: the relax
kernel's rule (each node takes the least of its neighbours' + the edge's cost; monotone, so in-place updates are safe),
the trace (follow the steepest descent, a point a step, decks at their fixed z), and the test's shape (a rider crossing
the river rides the deck). The CPU graph build (`routeGraphOf`, `routePlanOf`) does not carry over: here the graph is
made on the GPU.

### Reach is an invariant (fix round, 2026-11-10; DESIGN §13)

The user: "How is it possible not to find a route even every lot has a street adjacent to it?" At Muru 78 of ~280
keys missed: 45 started in citygen's own street pieces cut off from the network (the built core's streets whose joins
run through districts not begun — citygen draws a street only between shown blocks and a district's roads only once it
starts), 30 in door segments whose street isn't drawn yet, 3 in door columns the raster missed. None came from decks,
hubs or relaxing. Not citygen segment lists: its main streets are drawn a column at a time from φ's level sets (no
segment list exists), and its drawn network is itself disconnected in a part-built town, so a vector graph of it would
be too. The fix changes the world, as §13 says:
- **The check** (after the hubs settle, all GPU): every walkable column the stores' field didn't reach is cut off;
  components are labelled (least column); an open-ground distance from the network (dry, no building, dearer by the
  climb) gives each component its cheapest **passage**, laid as a track (W_PASS, kept across rebuilds); the graph is
  made again, at most 4 rounds. Reported in the state words: passages, rounds, cut-off columns left, built doors cut
  off. test/gpu/living.test.ts fails on any miss, cut-off column or cut-off door.
- **Doors** for lots begun (progress > 0), their own column always walkable; plazas, parks and landmark circles are
  walkable pads.
- **The works' internal routes:** the quarry's rim yard and the camp's yard and clearing are pads, joined to the roads
  by the check's passages — an access road that follows the ground and goes round water and buildings. The quarry's
  ramp route runs rim → each bench's ramp → landings → the working bench's walkway to the face's line. Woodcutters
  ride routes traced over the clearing (CAMP's field) to each tree and back.
- **The works keep off the town:** sited only on ground no lot (built or not) covers (W_LOTGROUND), so no district
  grows over them. (Not citygen's claim grid: the quarry's pit is dug in the world's columns, and keeping off every
  lot's ground is what stops districts.)
- `?livingdebug=1` draws the graph: quartz reached, lava cut off, flesh doors, sand passages, steel decks, flowers pads.

## 2. Hubs, fields and cached routes

**Hubs** are the places people go. Each is a distance field over `WALK`, seeded on the GPU (`hubSeed`) from the lot
records and the population field's purpose (streets.wgsl `P_*`):

| hub | seeds |
|---|---|
| STORES | the door of the building lot nearest the town's centre in the market district (else nearest the centre) |
| GRANARY | the door of the farm-district building nearest the centre (else the stores') |
| MARKET, WORKSHOPS, FARMS | every building door in that district (a rider ends at the nearest one: its workplace) |
| GATES | each arterial's end (ART `lim`): where the atlas roads leave town |
| QUARRY | the quarry's rim, where its ramp starts |
| CAMP | the lumber camp's yard |

**Relaxing without a readback.** A field is relaxed in place over the compacted list of walkable columns (`walkList`,
built once). Each sweep sets a "changed" word; a one-thread kernel turns it into the next sweep's indirect dispatch
size (0 when nothing changed). The CPU encodes a fixed number of sweeps a frame (`SWEEPS`); once the fields settle they
cost a few empty dispatches. All hubs relax together (a thread a column loops the hubs). Fields are relaxed when the
town is made and when a hub moves (a new quarry rim, a new camp). The quarry face moving does not relax anything: the
pit has its own route (section 4).

**Cached routes, like belts** (§12 "Cached routes"). A route is keyed by (start column, hub). It is traced once, down
the hub's field from the start, into a points pool (`PTS`: x, y, z, distance along; a point every column, decks at
their deck z, the ground's height elsewhere), and shared by every rider with the same key. The reverse trip is the same
route ridden backwards (the stores → a home is a home's route to STORES). Requests come from the riders on the GPU: a
small open-addressed hash (key → route id) with atomic insert; a new key goes on a trace list, traced by an indirect
dispatch once its hub has settled. The pool is fixed (`PTS_ROOM`); when it fills, the cache is cleared and routes are
traced again (in-flight riders keep their old points: the pool is reset only at a point where no rider holds a route
past the new head — see Hacks). This replaces the next-hop tables' 64 destinations × 1,024 nodes as the limit.

## 3. Riders and trips

A rider is a GPU row (`RIDERS`, 64 bytes): position, heading, its job, its home lot, its current leg, a load. One
thread a rider a frame (`riders`):
- **A leg** is either a ROUTE leg (a route id, a direction, the distance along it, a speed by the rider's kind: walk
  1.4 m/s, cart 2.2 m/s) — the kinematic trip: position interpolated along the route's points, no steering — or an OPEN
  leg (a straight walk to a point over open ground, z from the live surface: into a wood, to the quarry face).
- **Jobs** are a small state machine on the GPU (`JOB_*`): commuter (home → MARKET/WORKSHOPS → home), farmer
  (home → FARMS, work, carry produce → GRANARY), quarryman (home → QUARRY rim → ramp → face, dig while there), stone
  hauler (STORES → rim → ramp → face, load from the face's pile, back to the STORES stockpile), woodcutter (home → CAMP
  → a tree: fell it, carry its logs back to the camp), log hauler (CAMP → STORES), builder (STORES → a building site,
  work: the site's progress rises). Jobs are dealt by hashing the rider's index against the counts in the parameters.
- **Waiting** at a stop is a timer in the row. Nobody is ever "lost": a route that isn't traced yet is waited for.
- **Lanes and queueing** (§12) are not in this pass (they need a bucket sort by segment and direction every tick; the
  user called traffic "for looks for now"). Riders get a small lateral offset by their index, so riders on one route
  don't stand on each other's spot (DA-A12). Listed as follow-up LT-F1.
- **Drawn** as voxel figures in the units' format (`Renderer.addVoxels`, the body format units.wgsl writes): legs,
  torso in the job's colour, head, a load box when carrying; haulers push a cart. A kernel writes them each frame
  (`figures`), culled to the window.

**Fits Track B's GPU unit AI plan** (`origin/trackB:docs/handoff/GPU_UNIT_AI_PLAN.md`; U0 isn't written yet, so the
haul states are defined here to fit it). Nothing of the CPU crews is used: not `agents/crew.ts`, `buildcrew.ts`,
`town/life.ts`, not `agents.sync()`, not the inhabitants.
- **Behaviour is a state on the GPU row.** RID word 1: `job | state << 8 | leg << 16`. States (routes.wgsl `S_*`):
  INIT, REST (a timer at home or base), GO (riding out), WORK (a timer at the job; a quarryman adds dig budget, a
  builder works a rising lot), BACK, RAMP, FACE / UPFACE (the open legs in the pit), UPRAMP, HAUL (riding a load in),
  LOAD (waiting at a source for a whole load), TREE (walking to a claimed tree), FELL (the fell asked, waiting for its
  answer), YARD (carrying logs to the yard), DROP, IDLE.
- **Transitions come from GPU signals:** a leg's end (arrived: the trip's distance reaches its route's length, or the
  open leg its point), a timer, a load taken (an atomic on a counter), a fell's answer (fellApply writes the logs into
  the row), a route traced (its hash slot leaves PENDING), a site's progress (citygen's buffer).
- **The haul cycle** is go to source → work (dig / fell) → carry → deposit → repeat, entirely in that state machine.
- **Goals are routes and fields seeded on the GPU:** the hubs' fields from the lot records and the population field,
  routes traced down them; the quarry's ramp route from the pit's shape; the face and the trees from the works' state.
- **Job sites are GPU buffers:** the quarry's bench, progress and face (LT `L_Q`), the clearing's tree list and claims
  (LT `L_TREES`, WALK bit 16), the building sites (LT `L_SITES`, lots whose progress is between 0 and 1).
- **World operations are issued from the GPU:** the unit step writes the dig budget (a counter), the stores' inbox (a
  counter) and the fell queue (`L_FELL`, rider ids); the works' kernels apply them to the columns and the flora field
  (`dig`, `pile`, `fellApply`), following edit.wgsl's take and put rules and its fell's stump. Not yet one snippet with
  edit.wgsl's OP_TAKE/OP_PUT (they apply CPU events, a tick's four): see Hacks.
- **CPU → GPU is orders only** (the parameters' uniform: counts, rates, the works' numbers; the grid's place; a
  rebuild word when citygen draws its roads again). **GPU → CPU is nothing in play**; the debug panel's counters only.
- **The scope** isn't needed: every rider is a trip record stepped by one thread, a few reads each.

**One crowd (§11): this is a third crowd for now.** The Agents' units (CPU-brained crews, a per-frame sync) and the
inhabitants (src/inhabitants) are the other two. These riders are not rows of the Agents' unit buffer yet. Agents steps every unit on surfaces and
fields, with ids and groups held on the CPU (the old towns' TownLife drives them by events read back); at 500–2,000
riders that is both the CPU work this task forbids and a step the riders don't need. The riders here are the §12 trip
records. Merging them into the one crowd (a unit is a rider while on a route; knocked off by wind or a blast it becomes
a stepped unit and rejoins at the nearest node) is open question 1 for the user, and the next step after this. Until
then RoadRide (agents/ride.ts: the old towns' next-hop tables) and this are two ride systems; RoadRide goes with the
old towns at M4e.

## 4. The quarry: a pit dug deep, bench by bench

**Where** (`quarryPick`, GPU): over the town's box, columns outside the town's limit (past 1.05 radii, inside the box
less the footprint), on dry ground, scored by the rock under them (stone within the top few metres, read from the
window's columns where resident, else the raw ground's slope as a stand-in for exposed rock), nearness to the town and
flatness of the footprint. An atomic max over (score, column) picks one.

**Parameters** (panel and URL `lt.q*`): footprint (side, metres), bench height, depth, wall slope (the bench face's
steepness), dig rate (m³ a worker-second). The pit is a set of nested rectangular rings, one per bench. A column at
inset d from the footprint's edge has a target depth: bench k = ⌊d / s⌋, where s = ledge + bench height / tan(slope),
going down the face over its first bench-height / tan(slope) and flat on its ledge.

**The ramp** spirals down: bench k's face along side k mod 4 is replaced by a ramp from bench k's ledge to bench k+1's,
with a landing at the corner. It is a route (in the same points pool): rim → ramp 0 → landing → ramp 1 → … → the
working bench's floor. It is made again (a one-thread kernel) when the working bench changes. Carts and quarrymen ride
it like any route; the last stretch to the face is an OPEN leg.

**Digging is a world operation** (`dig`, a thread a column of the footprint, in the window): a column whose turn has
come (its place along the working bench's sweep is behind the bench's progress) has the top of its column taken down
to its target — an interval take, never into External, never below z 2 — and the volume taken goes into the face's
pile (an atomic counter, millimetres³). Progress moves by the dig budget: each quarryman at the face adds the dig rate
a second. When a bench is done, the next starts. The kernel writes the columns in place and bumps their chunks'
versions (chunkver.wgsl `bumpColumn`), so the mesh, the reach and the agents' surfaces see the pit.

## 5. Hauling: real material moves

- **Stone:** taken from the quarry's columns into the face pile (a counter) → a hauler takes a load (atomic subtract,
  only if a whole load is there) → carried (the row's load) → put at the stores: added to the stockpile's inbox
  counter → `pile` (a thread a column of the yard: the open lot, park or plaza, nearest the stores) puts it on the
  columns as rubble — an exact put, edit.wgsl OP_PUT's rule: onto the top interval if it's rubble, else a new one —
  shaped as a cone at rubble's angle of repose (a column takes its share up to the cone's height there). Totals hold:
  dug = face pile + in carts + inbox + piled, all GPU counters the panel shows. Why a put rather than the `deposit`
  inbox: sediment folds `deposit` in only on awake chunks, so a pile in a sleeping chunk would not show while its
  material was already counted; the put shows at once and the loose ground's passes slump it once the chunk wakes.
- **Logs:** trees are a field, not material (§15). A felled tree gives logs (its trunk's size, vegplan.wgsl's numbers)
  into the camp's log pile (a counter) → log haulers carry them to the stores' log pile. Both piles are drawn as log
  stacks sized by their counters.
- **Produce:** farmers' loads into the granary (a counter); drawn as sacks by the granary door.
- Builders take nothing yet (see Hacks).

## 6. Forest clearing that leaves stumps

**Where** (`campPick`, GPU): outside the town's limit, the column with the most trees around it (vegPlan's trees over
a disc), its yard at the wood's edge nearest the town.

**Felling is a world operation on the flora field.** Trees are vegPlan's: a column with succession ≥ 3.6 and its hash
under 0.045 stands a tree. A woodcutter claims a tree (an atomic flag word over the clearing's columns), walks to it
(OPEN leg), works for the cut time (the tree leans and falls: drawn as a falling trunk by the figure kernel, a simple
animation, no physics — DA-E7 stays open), then the fell is queued as an op. `fellApply` (one thread an op) sets that
column's succession (both `veg` and `vegNext`, as citygen's bare.wgsl does) to **STUMP** (2.30).

**The stump is a flora-field state.** vegplan.wgsl gets a band: succession in [2.25, 2.45) on a column whose tree hash
says a tree stood there is a stump (`pl.stump`); vegprep places it as a short trunk-only plant. Nothing per plant is
stored. A cleared area reads as stumps. Grass grows round them (the band is grass).

**Parameters:** clearing radius, cut rate (seconds a tree), replant (on: a felled column's stump is reseeded later —
the field set back to young woods, 3.0, after a delay; off: stumps stay).

## 7. Building sites take builders

A building site is a lot whose construction progress (`CityLots.progress`) is between 0 and 1, read on the GPU (`sites`
lists them every 30 frames). citygen's time-lapse owns the progress (it computes it on the GPU each frame from its
districts' start times; `claimDistrict` starts one). Builders ride STORES → the site's door and work there while it
rises. The panel's button claims a housing district (citygen's own hook). When citygen draws its roads again (a mesh
run: a district's roads appear), the living town's graph is made again (a 4-byte write).

## 8. What runs on the CPU (inputs only)

| what | when | size |
|---|---|---|
| the parameters uniform (counts, rates, quarry, clearing, toggles) | at start, on a panel change | 256 B |
| the grid's place in the window | a slide | 16 B |
| encoding the frame's dispatches (fixed: relax sweeps, trace, riders, dig, pile, fell, figures) | a frame | — |
| the graph made again when citygen draws its roads again (a district started) | a mesh run of citygen's | 4 B |
| (season life) the towns' clock, so the wall's pieces rise on the GPU as citygen draws them (the wall's table) | a frame, in the parameters | 8 B |
| the panel's counters (debug only, `?living=1` with the panel open) | every 0.5 s | 256 B read |

No route search, job logic, rider state, site pick or material count is on the CPU.

## 9. GPU cost targets (desktop proxy; the phone bench is the measure)

| system | target | notes |
|---|---|---|
| riders (2,000) | ≤ 0.15 ms a frame | a thread a rider, a few reads of the points pool |
| figures (2,000 × 5 voxels) | ≤ 0.2 ms a frame + the voxels' draw | culled to the window |
| dig + pile + fell | ≤ 0.05 ms a frame | footprint and yard only |
| relax | ≤ 1.5 ms a frame while settling, ~0 settled | at town creation (about a second), hub moves |
| trace | ≤ 0.3 ms in a burst | new route keys only |

Measured: DEVLOG (living town).

## For Track B: the haul module to absorb

The user (2026-11-10): Track B owns moving agents and plants fully onto the GPU; routine hauling should need no
readback. Everything the haul cycle is, in one place:
- **States, legs and jobs:** routes.wgsl, the block under `// ---- riders ----` (`J_*`, `S_*`, `LEG_*`, the `Rider`
  row, `riders`). One kernel, one thread a rider; nothing else steps them.
- **Orders (CPU → GPU):** only the parameters' uniform `P` (counts by job, speeds, work time, the works' numbers,
  flags) and the rebuild word (LT word 0 = 0). The jobs are dealt on the GPU from the counts.
- **Signals the states move on (GPU only):** a leg's end, a timer, an atomic load taken from a counter, a fell's
  answer in the row, a route's hash slot leaving PENDING, a lot's progress.
- **World operations the step issues:** the dig budget (C_DIGBUDGET), the stores' inbox (C_INBOX), the fell queue
  (L_FELL); applied by works.wgsl's `dig`, `pile`, `fellApply`.
- **Events (GPU → CPU):** none. The counters (LT `L_C`) are what a game layer would read, async and small, if it ever
  needs them (the debug panel does).
- **To absorb into the one crowd:** the row's word 1 (`job | state << 8 | leg << 16`) becomes the unit's behaviour
  word, the route legs become the unit's ride mode, the open legs its walk on a field; the counters and queues stay as
  they are.

### Agreed with Track B (2026-11-10, via the coordinator)

Track B owns the one crowd, combat, flee priority, the inhabitants merge and the CPU flora mirror; Track A keeps the
haul job states. Track B builds the one crowd around this rider row.
1. **The behaviour word is RID word 1, for every unit:** byte 0 job (the behaviour bundle), byte 1 state, byte 2
   leg/mode (route trip, open walk; Track B adds surface field steering); byte 3 reserved and unused.
2. **Overrides are Track B's** (docs/design/UNIT_MINDS.md on trackB: in the unit row's state bits, info 12–14;
   DOWNED > FLEE > FIGHT > job). The job kernel calls `overridden(…)` and returns at once for such a rider, never
   touching its state, so the job resumes by itself. Until Track B's `unitstate.wgsl` exists and the riders are unit
   rows (U5), routes.wgsl has a stub, marked for replacement, that a test forces for one rider
   (test/gpu/living.test.ts: "not advanced by the job kernel").
3. **Events:** routine hauling emits none. If haul ever needs one it takes a code above 32 in the agents' ring
   (units.wgsl EV_*: EV_ARRIVED 8, …). Totals (stone delivered, logs, produce) stay GPU counters, read async on demand.
4. **Orders:** the parameters' uniform for haul; per-unit orders through the agents' paths (Track B's U1).
5. **Flora:** all felling through `fellApply` and edit.wgsl's exact fell (the same stump band), never the CPU Plants
   API's mirror.
6. **One snippet:** Track B adds `src/shaders/unitstate.wgsl` (U0: the word layout, override and event codes); when
   haul merges with it, routes.wgsl's `J_*`, `S_*`, `LEG_*` move into it.
- **The row stays 64 B:** position and heading; the behaviour word, route, cursor, home; distance along, timer, load,
  walk phase; the open leg's end, a claimed tree or site, the job's column. Nothing more is needed for haul.

## Measured (headless D3D11, Muru, phone size 412 × 915, vsync off, settled)

GPU ms a frame (the profiler, smoothed): build 0.036 (empty indirect dispatches), relax 0.087 (32 empty indirect
sweeps once settled), trace 0.005, riders 0.033 (950 riders), works 0.079, figures 0.020: **0.26 ms in all**.
After the fix round (one graph pass, the check, `ltspeed=12`): graph 0.145, riders 0.031, works 0.087, figures 0.045:
**0.31 ms**. Frame interval with `?living=1` against `?living=0`: p50 1.90 / 1.90 ms, p90 17.8 / 17.7, p99 18.7 / 18.6 — no
difference the desktop can see. The phone bench is the measure (not run).

## Hacks and limits (kept current)

- A third crowd until Track B's one crowd (U5); no knock-off by wind (Track B's).
- The `overridden()` stub (Track B's unitstate.wgsl replaces it).
- No lanes or queueing (LT-F1); a fixed spread across the road.
- The relax is fixed sweeps a frame (four in place a dispatch over 8 × 8 tiles), gated by indirect counts: settled,
  they're 0-workgroup dispatches (31 of them), not skipped — no CPU signal unless the phone bench says they cost.
- Quarry rock is judged from the ground's slope; the pit digs only inside the window and is lost when streamed land is
  regenerated (no edit log for streamed land).
- Passages aren't drawn as roads yet (only walked; the overlay shows them).
- A falling tree is an animation (DA-E7). Builders use no stone.
