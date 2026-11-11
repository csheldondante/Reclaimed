# SEASON_LOOP — opportunity-based city building, a season at a time

The playable test of the city loop on a field town (`?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&opps=1`).
Authority: DECISIONS 2026-11-10 "season loop" (the user's answers), round 128r (seasons, pools, stages), CITYGEN.md
(districts, the per-lot progress buffer), the opportunity contract (`src/api/contracts/opportunity.ts`, RUN_LOOP.md,
STRATEGIC_MAP.md), the draft DESIGN §18/§21 (`docs/handoff/DESIGN_18_21_DRAFT.md`).

**The card model in one sentence:** starting a card ties up its people (Labor, Might) and spends its goods (Materials,
Magic, Intel) at once, nothing more is paid while it runs its N seasons, its district part shows a stage each season,
and when it finishes its people come back and its building is whole — the opportunity contract's `commit` and
`resolve` ("Opportunities can take resources for a duration").

## The user's rules

- The sim runs in real time while the player picks cards. Nothing waits on a timer.
- **Next season** is a button. Every card in progress advances one season, all at once.
- A building takes 1–4 seasons and shows each in-between step (the shader for now).
- Six pools: Magic, Might, Labor, Materials (the decision's "Resources", shown as Materials), Intel, Unrest. The card
  lab's labor/influence/power set is not used here.
- The player picks cards; the town places and builds them. No painting. No raids in this test.
- Partial claims: a card's district covers part of a district (a share of its lots), so the town lasts.

## Data flow

```
catalog (data) ──proposals──▶ dealer.deal (opps/dealer.ts, the one dealer) ──▶ the hand (N cards, a reason each)
      ▲                         (over the ledger's own holdings)                │ Start / Undo
      │ what's built, unrest, land                                              ▼
 ledger (season/ledger.ts, pure) ◀── contract commit (people locked, goods spent) / undo ── the season's picks
      │ Next season: nextSeason → contract resolve for cards at their end (people back) + ordered stage changes
      ▼
 SeasonLoop (season/loop.ts) ── a new district card: its land (allocate) — a share of an open district of its kind,
      │                         or a new district: CityDistricts.claimDistrict(kind) (GPU argmax, 4 words back)
      │                       └ every card's change: CityDistricts.stageDistrict(id, {slot, a, b, from, to, end})
      ▼
 SimTiers.showcase (sim/tiers.ts): the changes over a few seconds, the camera on each; Skip lands the end at once
      ▼
 citygen (GPU): lots ranked in growth order a district → each lot's progress from its card's share → risen, tinted
```

- **Pools and the contract.** Labor and Might are people: one agent a unit (`workers`, `army`), required by a card
  and locked (`Agent.committed`) until it resolves. Materials, Magic and Intel are goods, spent at commit. Unrest is
  the town's state: that many free workers are on strike (not with you, so not available — the contract's own rule).
  The mapping is a table (`POOL_ROLE`); each card's `locks` and `costs` are data.
- **The dealer** gets one proposal a catalog card: its people as requirements, its goods as costs, `sense` filters
  (what it needs built, land for it, a one-off not started) and score parts. It deals at most `HAND` cards that can
  be started and one that can't yet.
- **The ledger** is the season's truth: holdings, goods income, cards in progress (their commitments), what is built.
  Pure, the same input giving the same output.

## Land: districts in shares

- A district is 6 parts. A card covers some (houses 2, farms 2, market 3, workshops 3, harbour 3, keep 6).
- `allocate` (season/deal.ts) is the one rule the loop builds by and the dealer offers by: a card goes on in an open
  district of its kind that has the room and a free slot (two cards build in one district at once); else a new
  district is claimed on the GPU.
- The GPU ranks each district's lots by distance from its centre (`stgRank`, a mesh run: n² over a few hundred lots);
  a lot's key is its rank over the district's count, so a share [a, b] is that share of the lots, centre outward.

## Stages, seasons and progress

- A card of `n` seasons in share [a, b] has stage `a + (b − a) × worked / n`. Each Next season moves it one step.
- citygen keeps a **stage table**: 16 f32 a district — on, end (the parts given out so far), and two slots of a, b,
  from, to, when. `tlProgress` gives a lot in a slot's share the progress `f × 1.5 − 0.5 × w` (f how far the stage is
  through the share, eased over the build span; w the lot's place in the share), so its lots rise together, a little
  staggered, and are all up exactly when the card finishes. Other lots stand before `end` and aren't begun after it.
- Skip writes every changed slot with `when` far in the past: the end at once, the same progress as played.
- **The look ("the shader for now"):** `tlRise` tints a rising building's tops plank, its roof a scaffold deck and its
  foot dark stone while its progress is under 1, and puts its colours back at 1. The full construction shader reads
  the same progress buffer (contract unchanged).

## UI (phone first, `season/ui.ts`, words in `season/words.ts`)

- Top: the pools as chips — people free of all (`Labor 2/4`), goods and what each season brings (`Materials 4 +2`).
- Bottom sheet: the hand as a two-column grid (title, a reason line, "Takes 2 Labor for 2 seasons. Uses 2
  Materials.", what it gives, what's missing in its own line), **Start** / **Undo**. What's building: name, seasons
  left, "2 Labor back in season 3." **Next season** (and **Skip** while it plays). A summary of the last season.
- Plain words (docs/WRITING.md); no "commit", "stage" or "tier" on screen.

## CPU and GPU

- **CPU (bookkeeping only):** the catalog, the dealer, the ledger, the hand, land shares, the UI, the showcase's
  timing. Inputs to the GPU: which purpose to claim (a word), a card's stage (28 bytes), the town's clock.
- **GPU:** which district a new card gets (argmax), each district's lot order, each lot's progress, the buildings
  risen and tinted, roads shown, claims. Read back: the claim's 4 words once per new district — an event.

## Season life (trackA-seasonlife): the town shows the choices

The user: "I do want to see agents moving around and more things to reflect choices like soldiers amassing and
defenses going up or marching out to other areas of the map as well as ships and wagons coming in as external routes
get established." Everything here runs on the GPU; the CPU sends the season's choices (counts, a stage, an on bit).

**1. The living town in the loop.** `?opps=1` turns on `?living=1` (LIVING_TOWN.md). What's built sets the living
town's job counts, its one input (the parameters' uniform): commuters from the houses built, farmers from the farms,
builders while cards are building. The quarry and lumber camp cards are real: starting one turns the living town's
quarry (or clearing) on — its pit is picked and dug, its camp picked and the trees felled — with its quarrymen and
stone carts (woodcutters and log carts). They were pools-only stubs.

**2. The walls card: a ring that rises.** On citygen's GPU (streets.wgsl, the town's own mesh):
- **The ring** is made when the card starts: the built lots' furthest reach in each of 72 directions round the centre
  (an atomic max), smoothed, plus a margin — the town's limit as it stands.
- **Gates** where an arterial crosses the ring (DESIGN §13: at least two; the two longest gaps get one if fewer).
- **Towers** at every sixth corner and both sides of each gate. A tower inside a run of wall (both its pieces wall) is
  a bastion: its top is the walk's deck, so the wall-walk crosses it; only the towers beside a gap (a gate, water)
  stand full height, squared to their wall piece (U2-WALLSTAIR).
- **Stairs and the walk** (U2-WALLSTAIR): the walk's deck runs straight between the ring's corners at the wall's height
  over each corner's ground — drawn and claimed alike. A stair at each run's ends climbs along the run (on the ring's
  corners) from the ground at its foot, beside its first step on the town's side, to the deck where it meets the walk,
  in equal rises (≤ the agents' STEP for a climb up to 7.7 m). The wall-walk route's points sit on those surfaces.
- **Rising in stages:** each wall piece rises as the card's stage passes it (going round from the first gate), so
  each season shows more of the ring up; whole when the card finishes.
- **Claimed** in the world like a building (the town's claim grid), and the road raster cut where the wall stands
  (not at the gates), so the living town's routes go out through the gates.

**3. Wagons and ships on external routes.** A trade route card (needs a market; a harbour for ships):
- **Wagons:** haul riders in the living town's format (job/state/leg): from a gate (the GATES hub) along the roads to
  the stores, unload, back out the gate, and away off the map for a while before the next trip.
- **Ships:** riders on a water path — a distance field over the window's open water from the harbour's shore, relaxed
  on the GPU; a ship comes in from where that field is largest at the window's edge, follows it down to the quay,
  moors, and leaves the way it came. Drawn as voxel hulls with a mast and sail.

**Soldiers wait for U2** (since trackA-forces the season side runs through an adapter: "Soldiers and waves" below) (the user: soldiers wait until the agents are on the GPU; Track B: soldiers are unit rows
from the start, ordered through the Units contract). The calls the season loop needs after U2 (`api/contracts/units.ts`):
- `units.spawnGroup(kind: 'soldier', n: number, at: V2, faction, opts) → GroupId` — a squad a point of Might.
- `units.orderGroup(g, { kind: 'drill', yard: V2, radius: number, formation: 'column' | 'line' })` — march in
  formation loops on the drill yard (amassing).
- `units.orderGroup(g, { kind: 'man', posts: V3[] })` — one soldier a post on the wall's walk (posts at wall height;
  today's `guard` has no z).
- `units.orderGroup(g, { kind: 'march', route: V2[], to: V2, leave: true })` — a column along a route (the arterial,
  then the atlas road) to a place; `leave`: off the window, resolved by clock (DESIGN §12), with an `arrived` / `left`
  event; and back the same way when the card finishes.
- Events: `arrived(g)`, `left(g)` (off the window). Until then, the walls get no soldiers and the patrol card waits.

## Soldiers and waves (trackA-forces; BACKLOG SL12, SF-1…SF-13)

The user approved it on 2026-11-10 ("do what you can now"); it lifts "No raids in this test" above for one simple rule.
Code: `season/forces.ts` (TownForces, the adapter), `season/war.ts` (the rules), lines in `season/words.ts`.

**One adapter.** Every Units call the season makes is in `TownForces`, and since trackA-forces2 (SF-1) it runs on
Track B's GPU place orders: `units.spawnAt(kind, faction, at: PlaceRef, n) → GroupId`, `units.orderGroup(g, { kind:
'guard' | 'go' | 'attack', at: PlaceRef })`, `units.members(g)`, events `arrived(g)` (once an order) and
`orderFailed(g, why)` (why: `'none' | 'rising' | 'water' | 'no-town' | 'pool-full'`); `died` (with `by`) and `hurt`
as before. Wired once where the town contracts are made (`units.usePlaces(tc.places, tc.townArea)`, stream-setup.ts).
`PlaceRef` and `GroupId` are in the townplaces contract: `{ town, place }` or `{ town, district, kind, rank }` (`kind`
the lot kind lotAt takes: 1 a building … 5 a field), plus `else` (the next place to try: "a gate, else the keep"; **a
chain holds at most 3 choices**, deeper throws at call time — `PLACE_CHAIN`, `chainLength`; the choice taken is sticky
until it turns invalid; `orderFailed` only when the whole chain fails) and `also` (one partner place that must be valid
too: a raid's spawn point only where its arterial's gate stands). Townplaces' `also` is a place number; the adapter
turns it into the Units contract's ref (`unitsRef`).
- **Nothing read back.** The places are resolved on the GPU where the orders run; the adapter keeps no frame count,
  makes no read of the place table and doesn't watch the units' states. What it keeps on the CPU is bookkeeping: its
  group ids, each group's kind, a unit → group map filled at the spawn (members(g) is known at once), the dead counted
  from `died`. A group's `size` is its living members plus its dead (0 when its spawn failed: none made).
- **Melee is the GPU's** (DA-B32). Line of sight and seen-only targets are the default: units hunt an unseen target only
  when ordered, so a raid's `attack` order is what sends raiders at the town.
- **Round 6 orders (trackA-forces3):** `orderGroup(g, { kind: 'drill', at, formation })`, `{ kind: 'man', town, side? }`,
  `{ kind: 'march', town, gate, leave? }` (an invalid gate fails with its status; `leave` tells `left(g)` once), and an
  optional `formation` ('column' | 'line') on go / guard / attack. TownForces' `ForceOrder` carries them (townplaces
  PlaceRefs turned into the Units contract's at the call). Each kind's spawn opts are TownForces' `FORCE_OPTS`: soldiers
  sight 22, pace 3.2, health 3; raiders sight 24, pace 3.4, health 3.
- **Room:** Track B has 8 order groups and 7 order fields (a field a distinct place chain). A spawn with no group free
  or an order with no field free is told as `orderFailed(g, 'pool-full')` by Track B itself (no units made; the
  failure sticks: the group's later orders fail the same) and shown on the sheet ("Too many groups are on the move at
  once …"); the next season posts again. Never a silent drop. A squad whose spawn failed for any reason is let go at once
  and raised again the next season.
- **Not a fallback:** an invalid place is never replaced by a position the CPU makes up; the chain is authored and an
  order with no valid choice fails and is shown.

**The rules (`season/war.ts`):**
- **Might becomes soldiers:** a squad of 3 (`SQUAD`) a **free** point of Might (SEASON_LOOP's own "a squad a point of
  Might"; Might tied up in a card is busy, so its squad isn't standing), raised at the barracks, else the muster yard,
  else the market (trackA-forces3: a town with no walls and no keep gathers its soldiers in the market square — SF-13,
  the user's call). None of them there: the sheet says so ("Your soldiers have nowhere to gather …"). Squads are
  matched to the free Might when each season begins (its stages landed): the weakest sent home, new ones raised.
  **At most 6 squads** (`MAX_SQUADS`: Track B has 8 order groups — a raid, 6 squads, a spare); Might past 6 raises no
  more soldiers. Track B's round 7 removes the caps: MAX_SQUADS goes then (SF-10).
- **Drill:** squads not at the gates `drill` in a column round the muster yard, else the barracks, else the market
  ("6 soldiers are drilling.").
- **Guards:** once the walls are built, squad j guards the first standing gate from slot j on in a `line` (the squads
  spread over the gates there are); before, they drill. With chains of 3, the search goes a window at a time:
  gates j, j+1, j+2; on `orderFailed` the next three; past all ten slots, where it was raised. The sheet counts soldiers
  at the gates and in the yard apart.
- **Man (`?man=1`, off by default):** after the walls, squad j mans wall run j (`man { town, side: j }`); a man order
  that fails guards the gates instead. Off until trackA-wallstair's baked wall routes and Track B's route riding land
  (U2-WALLSTAIR, SF-12); with the flag off the gates stay guarded.
- **The patrol — the rule:** in a season with the walls built and no raid (none due, none on), the last squad (the
  weakest) marches out through the first standing gate from its own slot (`march`, leave false) along that gate's route
  to the window's edge; on `arrived` (the route's end) it is sent back to guard its gate. One squad, once a season (each
  season begun posts again). A gate that can't be marched (`none`, `rising`, `water`, `failed`) moves it to the next
  slot; `busy`, `no-town` or `pool-full` send it back to its gate at once. The sheet: "3 soldiers march out on patrol."
- **Raids — a fixed schedule** (the simplest fit: the dealer has no threat cards yet; a Threat card is SF-5): from
  season 4 (`FIRST_WAVE`: a walls card started in season 1 is up by then) every 3 seasons, 4, 6, 8 … raiders, warned a
  season ahead on the sheet. `?wave=N` the first raid's season (1: right away; 0: none) — the test flag.
- **Where from and to, no walls** (trackA-forces3; before, a season-1 raid "found no road": its spawn's `also` needs a
  gate): with no ring, raid k from the first standing spawn point of arterials k, k+1, k+2 (no `also`), the next window
  on the spawn's `orderFailed`, all eight tried once — attacking the keep, else the stores, else the market. The squads
  stand in a line there while it's on ("3 soldiers wait for the raiders in the town centre.").
- **Where from and to, with walls:** raid k along the first arterial from k on whose spawn point (outside the wall) and gate both
  stand — from that spawn point, attacking that gate (closed gates count as wall in the side map, so the fight is at the
  gate). A window of three arterials a call (spawn and gate chains paired by `also`); on the spawn's `orderFailed` the
  group is let go and the next window tried; past all eight, from arterial k's spawn point (else the first) to the keep,
  else the stores, else the market.
- **Outcome, at Next season** (before the ledger moves on): Might −1 for each 3 soldiers fallen (rounded up: free ones
  lost first, then ones tied up in a card); raiders still alive got in — Unrest +1 and a Material each (what's there),
  and they leave. The summary line says it ("You beat the raiders. 1 soldier died. You lost 1 Might.").
- **On screen** (folded sheet too): "6 soldiers wait in the muster yard." / "12 soldiers guard the gates." / "Raiders are
  coming next season. Scouts count 4." / "Raiders attack! 4 of 4 are on their way." → "Raiders are fighting your
  soldiers! 3 of 4 are left." (a blow on either side) / "All 4 raiders are dead."

**Known limits:** the drill stands still in Muru's small yard (SF-11, Track B); `man` is untested in game (SF-12); the
patrol is once a season, not on a clock; 'no-town' (the town's slot gone with the window) leaves a squad's post as it
is until the next season.

**The check** (`scripts/lab/townforces.mjs`, Muru, 412 × 915, 60°): season 2, six soldiers at the yard; season 4, the
walls built, 12 soldiers at gate 2 (Muru's only standing gate: gate 0 is over water), four raiders from spawn point 2
along its road to the gate, the fight there, settled at Next season; season 5, the patrol out of gate 2 and back.
`scripts/lab/townraid.mjs` (`--flags "&wave=1"`): season 1, no walls — the raid from spawn point 0 at the stores, the
squad raised in the market meeting it.

## Town moods (the user, 2026-11-10 — not built; BACKLOG TM1–TM10)

What the season's opportunities should do to the town's look and life, the user's words in BACKLOG "TM — town moods":
checkpoints (guard groups at junctions and gates, through TownForces' PlaceRefs), a curfew (the living town's riders
home), a parade (Track B's march), plague dead-collection, undead labour, disrepair (a per-lot condition word the
building generator and construction shader read), banners and lighting by mood, storms and fog, and the unit graphics
push. Each row names what it waits on.

## Saving (DESIGN §23)

The town is a pure function of its seed, ground and population field, so it isn't saved: it's made again, and what
play changed is laid over it — the user's rule, town changes saved like terrain changes, a per-town edit log keyed by
world position.
- **The season** (`SeasonLoop.snapshot`): the ledger (pools and holdings: the people and their commitments, the cards
  in progress and their seasons), the land (districts left, the open shares), the districts and each card's share,
  what was dealt. Key `season:<x>,<y>` (the town's place). About 5 KB.
- **The town's edit log** (`citygen/townlog.ts`, key `town:<x>,<y>`): the districts claimed (ids, in order), each
  share's stage as reached, the wall's words (its ring and gates — read back once, after it's made) and stage, and the
  living town's works (the quarry's site, bench and progress, the clearing's camp: its state words' head, read back at
  each season's end). About 2.5 KB.
- **Where:** the world store (the region store, IndexedDB; `?fresh=1` clears it). Written at each season's end.
- **Restore:** at boot the season is read before the first hand; when a town is made (at boot, or again after it was
  let go) its log is laid over it — each claimed district started (its roads shown), each share set at its stage at
  once, the wall's words written back — then a mesh run draws and claims it. The living town's works are written into
  its state words before its first frame, so the quarry isn't picked anew (its ramp's route is traced again). The pit
  itself is the world's columns: the region store's.
- Crops are derived (the fields' progress): nothing saved for them.

**Soldiers (Track B accepted the four calls for U2, with notes):** a group is a set of units, not a field;
`posts.length` must equal the group's size, spare soldiers stand at the nearest gate; the march back is a second
`march` order with the route reversed; `arrived(g)` and `left(g)` are per group. Two conditions on this side: the
walls card makes the wall-walk walkable (reached by stairs or a gate tower; a post with no path fails visibly, naming
the post), and `march` takes a route id from the living town's route graph — stable ids for gate → the arterial's map
edge (out, and back reversed).
