# World mutators

Branch `mutators` (from `fortress` 555bdca3). Code: `src/mutate/`, `src/shaders/mutate/`, `src/scenes/level/mutators.ts`.
Test: `test/gpu/mutators.test.ts`. Lab: `/?skipmenu=1&level=atlas&town=1&mutlab=1&fresh=1`.

## What changed in the contract (round 2, 2026-11-15 night) — for the loop branch

1. **Place state lives in the fact layer.** `mutators.places()` / `place(id)` are reads of the bound `FactWorld`
   (`src/mutate/facts.ts placeState`): owner from `occupies` / `vassal_of` / the settlement record's holder, status from
   the record's condition and those relations, tribute from `pays_tribute_to` (`meta.perSeason`). The list keeps no
   owner or status. `PlaceState.history` is now fact event ids (was list entry ids). `owner` is an entity id (a
   faction's, `'player'`); show it with `mutators.world.name(id)`.
2. **`mutators.useWorld(factWorld)` / `mutators.world`.** The level binds the atlas's own world when the mutators
   attach (`MemoryWorldState.restore(settlements.wiki.snapshot)`). A run or the season loop with its own world must
   bind that one; entries whose fact event the new world lacks are recorded in it (a saved list replays onto a new
   run's world). With no world bound a state kind throws.
3. **State kinds are fact mutations** (`recordMutation`): `destroyed` → settlement-condition `ruined`; `abandoned` →
   `abandoned`; `captured` → `occupies` + tag `condition.occupied` + settlement-owner when the holder is a faction;
   `vassal` → `vassal_of` + `pays_tribute_to`; `founded` → a new AtlasEvent kind `settlement-founded` (the record) + the
   entity + a `founding` event. **`by` must be an entity of the fact world** (a faction id, a polity, `'player'`): a
   free-text holder ('Iron League') now throws.
4. **Land kinds record too:** one fact event of the kind's name, a tag `condition.<kind>` on each settlement the area
   covers; `dried` also lowers the region's river inflow through `setRiverInflow` (the recorded way).
5. **Every entry carries `fact`** (the FactEvent id) beside `cause` (the opportunity's id, written to
   `FactEvent.about.opp`). `MutationSpec.fact` given: `apply` writes the physical side only.
6. **Outcome kinds for templates** (`src/mutate/outcomes.ts`, registered into `living/dsl.ts HELPERS`):
   `{ helper: 'mutate', args: [kind, '$where', strength?, seed?, '$by'?, tribute?] }` and
   `{ helper: 'sign', args: [kind, '$where', strength, seasons?] }`. Facts go to the template's own world with the
   opportunity as cause (so a dry run's diff shows them); a real resolution then calls `mutators.apply` / `.sign`.
7. **Signs** are also a tag `condition.<sign>` on the place while on, and one event when they start.
8. Unchanged: `list()`, `apply()`'s spec and result, `record()` / `restore()` (version 2; entries gain `fact`),
   `sign()` / `signs()` / `season()`, `LOT_CONDITION`.

## The fixed-city assumption (the owner, 2026-11-15)

"The first runs we want to build are centered on a city but the opportunity system and simulation layers are
intentionally built more generally. The plan is to eventually have runs that follow migrant groups such as refugees,
armies, settlers or adventurers. Don't spend time designing around it but note that it is the plan so any shortcuts
should record places where they bake the fixed city assumption per run."

General already: land entries are keyed by world cells and written by `Streamer.onWritten` (the streaming system's own
hook, a region at a time; no town involved), and the list is saved in the world store. Town-specific by nature: lot
conditions (`FieldTowns.onMade`). Baked-in, marked `FIXED-CITY` in the code (BACKLOG MU-26, MU-27): the run's home is
the start town (`MutateHost.home`), a far eruption's signs land on it, a sign with no place is recorded on it; a
sign's place must be a settlement and shows only on a live FieldTown; the dead rise in the first live FieldTown; the
outcome helpers resolve to a settlement.

## The user's words (2026-11-15)

- "More focus on mutations since we have so much built in that area for a reason. I want melted, flooded, buried, burned etc"
- "…then see the mutations from all your choices. Abandoned cities. Magma burned land. Floods. Buried things. Zombies.
  Undead cities. Totalitarian lockdowns etc. Strategy loop is just preparing for the opportunity and mutating the world."
- The mechanism: "Try making instant mutators instead since a lot of opportunities will happen in other area of the world
  like new mining settlements or other cities being captured or destroyed or occupied or made into vassala that have to
  pay tribute or invoke negative opportunities".
- The principle: "the local simulation and playable battle make the instant mutations read as fully simulated and the
  whole point is it feels like the whole world changes in reaction to your choices".

## The design note (AGENT_RULES §1)

- **Data flow.** The truth is the **world modifier list** (`mutate/list.ts`, CPU, JSON): one entry a mutation, with
  every number its op needs fixed when it is applied (from the atlas's macro ground, never from the window). The land's
  state lives where it always has: the columns (`WorldGpu.layers`), `water`, `veg`, the lava contract's ground heat. A
  lot's state lives in one new GPU buffer, the **condition word** (below). Nothing is copied to the CPU.
- **The ops** (`shaders/mutate/`): one dispatch an entry over a box of the window (`mutLand`, a thread a column) and one
  a town (`mutLots`, a thread a lot record). Each is a pure function of the column (or record) and the entry: masks at
  the world position, noise hashed from world lattice points, every write idempotent. So land written whole, a region
  at a time as it streams in, or twice, ends the same.
- **Readbacks.** None. The lab and the test read a write's two timestamps (16 B) when timing is asked for.
- **When it runs.** `apply` writes what is in the window at once. `Streamer.onWritten` (after the static claims) writes
  every entry that reaches an arriving region. `FieldTowns.onMade` writes a new town's lot conditions. Zero work when
  the list is empty. No sim is woken; the liquid only forgets its records of the chunks written, as it does for
  arriving land.
- **Cost.** Desktop (Dawn, D3D12), radius 20 on a 64 × 64 world, land + lots: flooded 0.07 ms, burned 0.20 ms, melted
  0.13 ms, buried about the same. The phone is not measured yet (BACKLOG MU-9).
- **Rejected.** A staged time-lapse that queues the sims' own events and keeps them awake (the first plan): it cannot
  reach land that is not loaded, costs seconds of live sim, and its result depends on what was awake.
- **Persistence.** The list is saved in the world store (key `mutators:list`), and that is all. Mutated regions are
  not marked as touched by play: they are derived (generator + list) and written again on arrival. A region that play
  did change is saved with the mutations in it; the ops are idempotent, so taking them again changes nothing.

## The contract (`src/mutate/index.ts`)

```ts
mutators.list()                                   // kinds: { kind, group: 'land' | 'state', name, description }
mutators.apply({ kind, place?, at?, radius?, strength?, seed?, by?, tribute?, name?, size?, purpose? })  // → Applied (purpose: 'mining', founded only — round 5)
//   place: an atlas settlement id; at: world cells [x, row]. Applied: the entry + resident (written now?) + fresh
mutators.play(entry)                              // presentation; not built (resolves at once): MU-3
mutators.places() / mutators.place(id)            // PlaceState: owner, status, tribute, population, conditions, restless
mutators.record() / mutators.restore(record)      // the list as JSON
```

The same modifier applied twice is one entry (its id: kind, place or cell, radius, strength, seed, by, tribute).

## The mutators

| kind | what is written | lots |
|---|---|---|
| flooded | `water` up to a level over each column's top (never lowered), clean (the column's dissolved contamination cleared), over a thin layer of silt; plants under it gone. The level is taken on the GPU from the place's real ground the first time its whole area is in the window (`floodscan.wgsl`: over 22-70% of the dry ground by strength, 1.5 to 6.5 cells over the standing water it rises from) and kept on the entry (`params` [level, 1, the rim's low level]); flat inside 62% of the radius, then falling smoothly to a quarter cell under the lowest ground or water of the outer ring, so the flood meets what is round it with no step. The liquid holds it: the core's columns a held stage (up only), the rim's an edge stage (kept at, both ways) — Round 3 rulings, BACKLOG MU-36, MU-38 | drowned where the level is half a cell or more over the lot's base |
| burned | plants removed; soil's top 0.3 becomes char (MAT 42, near black: MU-45; the fire sim's ash is reddish); ragged edge, patches spared under strength 1 | burned (walls black, roof gone, height × 0.6) |
| melted | a basalt cap (the lava sim's set rock), with a glassy obsidian skin where it lies thick (MU-41), in a pool round a vent and a lobed tongue downhill (the direction from the macro ground), 0.4–3 cells thick, never over ground higher than the vent; water removed; cracks set to 1150° ground heat, which the render fields already draw as glow | destroyed (slumped to 20-50% of its height, black; the claim released) |
| buried | a sand interval on the top: dunes across a seeded wind, thinning to nothing at the rim; up to 2 + 5 × strength cells | buried where the sand is a fifth of the building's height or 1.2 cells |
| dried | `water` lowered by 1 + 3 × strength cells (deeper water stays as pools), the columns' `waterSource` shut, bank plants browned (`wilt`); the region's river inflow lowered in the fact layer; and the river through the place cut — its nodes in the disc and every reach above them (`weather/inflow.ts reachAbove`), carried on below until tributaries make it up — with the window's river columns settled to the cut at once (`riverset.wgsl`; past the window's edge the tiles do not show it: MU-47) | none |
| withered | the plants' own dying state, blighted: `wilt` brownness 0.52-0.92 by a world noise (straw with brown patches) and the blight mark (`common.wgsl WILT_BLIGHT`), which the wilt system and the ecology leave as written; the tree draw bares and greys every plant on a browned column (`floralook.wgsl`, MU-17) | none |
| greened | the plants' field raised to shrubs and woods on soil, healthy | none |
| destroyed | — | every lot of the place burned; population 0 |
| abandoned | — | standing lots abandoned (faded, sagging) |
| captured | — | standing lots occupied (the roof in the holder's colour) |
| vassal | — | none; owner and tribute in `places()`; `restless` true |
| founded | with `purpose: 'mining'`: a pit cut in benches and a spoil heap just past the town's edge, under broken rock (`MUT_MINE`) | its own town: the entry is a site of the field towns (`FieldTowns.addSite`), built by the town generator when the window nears it — streets, houses, people (MU-6, MU-50) |

A column whose top is a building's External span (a cell or more thick) is left alone; a road's paving is ground.

## Signs

"Weather effects too. Darkness and ash raining down are a great way to indicate a distant eruption. Having random
undead rise in the city or crime are all indicators." (the user, 2026-11-15)

`mutators.sign({ kind, place?, strength, until? })` (strength 0: off), `mutators.signs(place?)`, `mutators.season(n)`
(the loop's season number; a sign past its `until` ends). Saved in the record with the list. A `melted` entry applied
away from the home town casts `ashfall` and `darkness` on it for three seasons, strength by distance (0.3 at 4000
world units or more).

| sign | what shows (all existing systems) | cost while on |
|---|---|---|
| ashfall | the weather's rain draw makes pale flakes and dark cinders over the view (`rain.wgsl`), and what faces up is dusted grey (`render/light.wgsl ashDust`); one Globals number | one draw of up to 2 200 instances; no CPU work |
| darkness | the sun and sky scaled and browned in the Globals (`WorldCore.skyDim`) | none |
| deadrise | a burial ground broken open at the town's edge (black ground, pale stones, 30 cells across: `MUT_GRAVES`, one dispatch) and 4–12 green-bodied `shambler` units on it; the ground stays when the sign ends (MU-43: partial) | the units' own |
| crime | 6–22% of standing buildings `looted` (condition 10: dark walls, a dark red roof); `unrest` on the sign | none (one dispatch on, one off) |

## The map

"the whole point is to make the map a living visual representation of your choices". `AtlasMap.overlay` draws every
land entry's area in its kind's colour (a tongue along the flow for `melted`, a bar for a dry reach), and at every
changed place — read from `places()` — a row of badges, one a condition, each with its own picture and plain word:
drowned, burned, under lava, buried, river dry, withered, overgrown, occupied (the holder's colour), vassal, founded,
abandoned, destroyed (`src/mutate/mapmarks.ts`). The mutators add no pins. The map's own image (ground, rivers) is not
redrawn (MU-16).

## The lot condition word

`CityGen.condition` / `CityLots.condition`: one u32 a lot record, beside the progress buffer. Low byte:
`LOT_CONDITION` (0 standing, 1 drowned, 2 burned, 3 destroyed, 4 buried, 5 abandoned, 6 occupied, 10 looted; 7–9
reserved for overgrown, undead, lockdown). Next byte: how far (0–255; for occupied, the holder's hue). Bits 16–23 are free for
BACKLOG TM6's disrepair. `streets.wgsl tlRise` reads it (binding 5): `condColour` tints, `condHeight` cuts.
`claimLots` reads it (binding 3): a destroyed lot keeps no claim. `FieldTown.conditionsChanged(reclaim)` draws again.

## Conformance with the opportunity system's design (2026-11-15, late)

The orchestrator pointed at the recorded decision (docs/design/FACTIONS_WORLD_STATE.md, DECISIONS rounds 120-128r):
"Outcomes are near-instant mutations of authoritative state. A river falls when its steady-flow inflow is lowered. A
structure is placed directly, with no agents building it. Full simulation runs only where the player is looking."
The code from those sessions: the fact layer (`src/api/contracts/facts*.ts`: entities, scoped tags, typed relations,
claims, events) and the template engine's outcomes (`src/living/mutations.ts`: `river-inflow`, a building placed,
stores, faction power, `setCondition`, migration, `setControl`), each of which applies an AtlasEvent and records a
fact event with its cause.

**Aligned.** The land mutators are the physical half of that decision: instant writes of authoritative state, no sim
run. Every entry and sign can carry `cause` (a fact event's or an opportunity's id), kept in the record.

**Done in round 2 (MU-21).** The fact layer on this base is whole: `api/contracts/facts*.ts` (entities, scoped tags,
typed relations, claims, events), `world-state.ts` (settlement records, AtlasEvents, regions' river inflow),
`living/` (FactWorld, the template engine and its DSL, `mutations.ts`), `opps/` (the dealer on that engine), the
inspector. What the switchover deleted is the old towns' *realisers* of settlement events (a fallen town charred,
peopled: BACKLOG SW-G5) — the lots' condition word here is their replacement. The parallel list is deleted; see "What
changed in the contract" above. Not done: `dried`'s land op is still an area write as well as the inflow change
(MU-16); the AtlasEvents `flood`, `burn`, `bury`, `overgrow`, `shadow`, `raise-dead`, `storm` (region-wide dials no
system on this base realises) are not emitted — a land mutator is an area, and a region dial set from it would say
more than happened (MU-22).

**The catalog against the mutators** (docs/design/OPPORTUNITY_CATALOG.md, every physical change its entries call for).
Covered here: a new town or outpost (founded); a town burned or raided (burned, destroyed, the crime sign); evacuated
or abandoned (abandoned, with the engine's `migrate`); conquered or occupied (captured); tribute or vassal (vassal);
unending night (darkness — look only); overgrowth (greened); lava and ash (melted, ash fall); drought (dried,
withered, with `inflow`); flood (flooded). Covered by the engine's own effects: buildings placed in a settlement,
stores, control, laws, alliances, claims. **Missing** (BACKLOG MU-23): structures outside a settlement (a pass fort, a
beacon chain, a remote mine, a ritual site); a structure changing state (lit, staged, dilapidated); roads, bridges,
tunnels, rail, gates between settlements; a bridge or dam broken and repaired; power lines and lights; a deserted
town resettled and any dispel (no inverse ops but `greened`); a district's distinct look, riots, curfew, checkpoints
(lockdown is reserved, unbuilt); festival dress; busy or empty markets; caravans, ships, armies, refugee columns as
moving things; an undead army (the sign is a few walkers); creatures; revealed sites; a lifted or walking city; a new
volcano cone; a river's course changed; storm fronts; snow and ice; plague, quarantine, pollution; battlefield dead.

**Contradiction for the owner.** Tonight's words ask for instant mutators on places that are not loaded, written into
the land when it arrives. The recorded design routes a river through its steady-flow inflow (the atlas's tables) and a
settlement's state through AtlasEvents the generators read. Both are "instant state"; they differ in where the change
is projected: this module writes columns after generation, the recorded design changes the generator's inputs. For
water and rivers the generator's inputs are the better home (MU-1, MU-16); for burn, burial, lava and lot conditions
there is no generator input today, and the post-generation write is what exists.

## Assumptions for the owner

1. A flood's level comes from the atlas's coarse ground, so it is the same for loaded and unloaded land. It is not a
   true basin fill: on open sloping ground the water stands where the sim would let it run off.
2. Buildings are not written into; their lot's condition shows what happened. Sand and rock do not pile on roofs.
3. Mutated land is derived from the list, not saved as changed regions.
4. `captured` shows as a roof colour from the holder's name. `vassal` changes no lot.
5. The far place's pin on the map is the map's own pin, with the place's name and what happened, not a tint.

## Round 3 rulings (the orchestrator's, on this branch; owner questions, not decided design)

1. **Standing flood water: a held flood stage** (BACKLOG MU-28). A flood holds a level over its area as a boundary
   condition inside the liquid's own contract: the column's source word (`waterSource` <= -1 is -(1024 + level)),
   which `liquid.wgsl publishWater` holds the open water up to. No refill from the mutator. Question for the owner:
   is a held stage the right model, or should a flood be the river table's stage / the recorded `flood` AtlasEvent
   realised by the generator? Cost at rest is not measured (MU-33). Receding is not built (MU-35).
2. **Instant everywhere.** The owner's later words win: mutators are instant everywhere; round 128r's staged
   time-lapse stays for the player's own city where the sim is live.
3. The region dials nothing realises (MU-22): left, logged.

Round 3 did item A only (flooded reads: flood-held-b.png at play zoom, flood-held-wide-b.png wide). B-F not started.

## Hand-over (round 2, 2026-11-15 night)

Done: item 1 (the fact layer, above). Partial: item 2 — the flood's level, colour and rim are right and tested, and
the cause it does not read is found and is not the mutator's to fix: **the flow model drains it** (BACKLOG MU-28; the
measurements are in the DEVLOG). Read MU-28 before touching the flood again; the next step is a held flood stage in
the liquid / river table, or the recorded `flood` AtlasEvent realised by the generator — the owner's call. Item 3:
ash fall made denser and still does not read (MU-31); darkness reads. Not started: the map as the record (MU-5), the
browser persistence proof (the list and the level's facts are replayed on load — untested in a browser), dried on a
real reach (`dried` now lowers the region's river inflow through the fact layer, which the river field realises —
not looked at in a still), withered, the dead rise and crime in a browser, `play()` (MU-3), founded places built
(MU-6: the fact layer now has the settlement record through `settlement-founded`; `settle/settlements.ts` and
`FieldTowns` still do not know it).

Stills: headless runs need `&pace=0` and a 50 s wait while other agents share the GPU (MU-32).

## Hand-over (round 4, 2026-11-15 late)

Done: the flood's edge (MU-36); the reload proof (`node scripts/mutators-reload.mjs --dir <folder>`: passes, nothing
needed fixing); ash fall (MU-31); the map's badges (MU-5). Partial: a dried river (the inflow cut is carried downstream, but the
still shows the river running: MU-42); melted
(obsidian skin, slumped lots; no glint, MU-41); the dead rise and crime (stills taken, neither reads: MU-43, MU-44);
withered (the grass browns, the trees stay green: MU-17). Not started: founded places built when streamed in (MU-6);
`play()` (MU-3). Stills: `node scripts/mutators-stills.mjs --dir <folder> [--only ash,dark,dead,crime,withered,dried,map,melted]`.
The lab's script hooks: `mutlab.go(id)`, `mutlab.live()`, `mutlab.conditions(id)`.


## Hand-over (round 5, 2026-11-15 later)

Done: a dry river bed (MU-42: a cut of the river's nodes at the place and above, the window's columns settled;
`node scripts/mutators-river.mjs` prints the river draw's inputs); withered woods (MU-17: per-instance death in the
tree draw, the blight mark in the wilt contract); founded places built by the town generator, a mine's pit and heap
(MU-6); crime (MU-44); char (MU-45). Partial: the dead rise (MU-43: the ground mark shows, it does not say what it
is). **The finding of the round (MU-49, MU-47):** land past the window's edge — the top and bottom of the phone's
view at the default zoom — is drawn by the tile cache from its own generation, which no mutator writes and where
rivers are drawn at the climate's wetness; every land mutator ends in a straight line there until the land streams
in. Contract additions: `purpose: 'mining'` on a founded spec and entry. Outside `src/mutate`: weather (inflow,
catchwet, wetfield), the wilt contract (common, wilt, ecology), the flora draw (floraput, floralook, meshinst,
vegprep, florafield, the viewer), `FieldTowns.addSite`, the looted colour (streets.wgsl), the shambler's colours
(agent-units), the material table (`char`), the transfer list, the level's frame and scene fields.
