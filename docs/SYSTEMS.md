# SYSTEMS — master sheet of what is built (stock-take 2026-11-16, branch `loop-skeleton` at 611a6c3b; live events and rules added in round 6)

Read this before building anything. Every row was read from the code, not from the design docs. Nothing was run for
this sheet (no game, no tests, no browser): "wired" means the call path exists in the source.

**Start here:** `docs/VISION.md` — why these systems exist, and the three ways a card's effect is shown.

**The game:** `?skipmenu=1&level=atlas&town=1&loop=1&fresh=1` (`&q=low` on the phone, `&runlen=N`). Wiring:
`src/scenes/level/stream-setup.ts` (towns, living towns, town contracts, mutators) → `src/scenes/level/loop.ts
startRunLoop` → `src/scenes/level/season.ts startSeasonLoop`. Script handles: `window.rungame`, `season`, `war`,
`citygen`, `living`, `mutators`, `mutateEngine`, `reclaimed`.

**Status codes**
- **W** — built and wired into the `?loop=1` game.
- **L** — built, but only in a lab, a test, a script or another mode (the flag is named).
- **D** — designed only: a doc or a contract type, no implementation.
- **S** — stub or stand-in.

**Two crowds exist. Know which one you want.**
- *Units* (`src/agents`, `src/units`): up to 8192 GPU agents with physics, fields, fighting, orders, events. Soldiers,
  raiders, the dead. Few (tens) in the game today.
- *Riders* (`src/citylife`): up to 4096 kinematic townspeople, carts, wagons and ships on cached street routes, with a
  fixed job state machine. Hundreds in the game. They cannot be ordered, hit, counted by `Units.query`, or sent to an
  event.

## 1. People and units

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Units contract | Spawn, order, hit, hold, query units; events died / hurt / noticed / arrived / orderFailed / left | W | `src/api/contracts/units.ts: Units`; `src/units/agent-units.ts: AgentUnits` (`scene.units`) | `units.spawn(kind, [x,y], faction, opts)`; `units.order(id, job)` | Positions are null unless `units.observe(ids)` or a `query` answer |
| Unit kinds | worker, soldier, guard, character, raider, shambler, cart (voxel models for raider and cart) | W | `agent-units.ts: AgentUnits` constructor (`agents.defineKind`) | kind string = role; hostile if `raider`, `shambler` or contains `dead` | 8 kinds at most (`agents.ts: MAX_KINDS`) |
| Single-unit jobs | idle, guard, go, patrol, attack, follow, flee, work | W (go, guard, attack used) | `units.ts: UnitJob`; `AgentUnits.order` | `units.order(id, { kind: 'flee', from })` | 3 shared goal fields (`GOALS = 3`); a 4th distinct goal waits standing |
| Place orders | A group spawned at / sent to a town place by index, resolved on the GPU | W | `AgentUnits.spawnAt`, `orderGroup`; `src/shaders/orders.wgsl: orderApply, orderResolve, groupCount, groupEmit` | `g = units.spawnAt('soldier', f, { town, place: PLACE.barracks, else: {…} }, n)`; `units.orderGroup(g, { kind: 'guard', at })` | `else` chain 3 deep; order groups limited (`Agents.orderGroups`, at least 8) → `'pool-full'` |
| Formations | column (≤3 abreast), line (≤10), loose; rows squeeze where the way narrows; `discipline` 0..1. Round 7: an anchor and its trail move with the window when it slides (`MAIL_SLID`, LS-72) | W (line, column, loose) | `units.ts: Formation, Drill`; `orders.wgsl: formAnchor, formSlots` | add `formation: 'column', discipline: 0.6` to a go / guard / attack order | Pace fixed at `FORM_SPEED` 2.0 cells/s; `'no-room'` if not one file fits; a `go` in a column from a road's spawn point splits for its first half minute (LS-76): live events walk `loose` |
| Drill | An anchor loops round a yard, soldiers hold slots | W | `SquadOrder` `drill`; `season/war.ts: SeasonWar.drill` | `orderGroup(g, { kind: 'drill', at, formation: 'column' })` | Stands formed if the loop does not fit |
| March | Column along gate slot k's route out of the town; `leave` drops them past the window and fires `left(g)` | W (the patrol) | `SquadOrder` `march`; `orders.wgsl` (`OK_MARCH`); `routeread.wgsl: gateRoute` | `orderGroup(g, { kind: 'march', town, gate })`; round 8: `inward: true` | Outward along a gate route, or (round 8) in along it to the gate (section 3c); on to a place is a second order (the runner's). No arbitrary route id; gate routes exist only with a wall (LS-89). One town's routes bound at a time (`'busy'`) |
| Man the walls | Posts along each wall-walk run, single file up the stairs | L (`?man=1`, `scripts/lab/townwalls.mjs`) | `SquadOrder` `man`; `orders.wgsl: manSeed`; `war.ts: SeasonWar.man` | `orderGroup(g, { kind: 'man', town, side })` | Off by default; up to 8 run fields |
| Town forces adapter | The season's one door to Units: groups, reports (alive, fallen), events by group | W | `src/season/forces.ts: TownForces` (`scene.townForces`) | `forces.spawnAt('soldier'|'raider'|'worker'|'cart', f, ref, n)`; `forces.report(g)` | `ForceKind`: soldier, raider, worker, cart (round 6) |
| Squads | Might → squads of 3; drill, gate guard, patrol | W | `src/season/war.ts: SeasonWar` (`window.war`) | `war.season(ledger)`; `war.squadGroups`; `war.settled()` | In the loop the raid is a live event (section 3b); `war.call` / `war.resolve` raid the default town game (`?loop` absent) only |
| Fighting | GPU picks targets, strikes, applies damage; fight rules by wall side and height | W | `src/agents/notice.ts`; `AgentUnits.fightRules`, `fightFlags` | `units.fightRules({ open: false })` | Line of sight and ranged units: D (`UNIT_MINDS_U2.md` §9f) |
| Area blow, hold, throw | Damage + shove over a disc; hold a unit in the air; throw it | W (strike) / L (hold, release: `src/play/heroes/lich.ts`) | `AgentUnits.strike`, `hold`, `release` | `units.strike({ at, radius, damage, push }, 'spell')` | `maxHeld` 8 |
| Unit query | Units within a radius, asked of the GPU (two small reads, async) | W | `Units.query`; `agents/reads.ts: UnitReads.near` | `await units.query([x,y], r, { hostile })` | On demand only; sees units, not riders |
| Arrival events | "Unit came within r of field's seeds", told once by the GPU | W | `agents/agents.ts: Agents.arrivals` | `agents.arrivals(field, radius, leave)` | No "left" event |
| Road riding for units | Units leave the flow field for a road graph, ride to a goal. Round 8: not used — the march in plus road-weighted fields (section 3c) were less work: the graph needs the town's street graph on the CPU, which only the GPU has | L (no caller left after fortress mode was deleted) | `Agents.setRoads`, `setRoadGraph`, `ride`; `agents/roadgraph.ts`, `agents/ride.ts` | `agents.setRoadGraph(g)`; `agents.ride(group, goals)` | Not fed by citygen's streets today |
| Followers (hero orders) | follow / hold / go / release for recruited units | L (`?run=sit`, `?run=opps` hero modes) | `api/contracts/orders.ts: Followers`; `runsit/followers.ts: UnitFollowers` | `followers.recruit(units)`; `followers.order({ kind: 'follow' })` | Needs a leader actor (the hero) |
| Carry, pick up, throw items | A unit carries material, puts it down, throws it | L | `Agents.carry`, `pickUp`, `putDown`, `throwItem`, `toss` | `agents.carry(id, 'Stone', 0.35)` | — |
| Traits and effects | undead / living / fire_immune…; heal, raise, damage, status effects over a disc; GPU rule modules | W (installed; shamblers are undead) | `api/contracts/traits.ts: TraitsApi`; `src/traits/system.ts`; `game/traits/modules.ts: registerSlice` (`scene.traits`) | `traits.apply({ op: 'raise', at, radius, group })` | 8 statuses; no caller in the loop's own code |
| Townspeople (riders) | Commuters, farmers, quarrymen, woodcutters, builders walking streets on cached routes | W | `src/citylife/living.ts: LivingTown`; `citylife/routes.wgsl`; `citylife/towns.ts: LivingTowns` (`scene.livingTowns`) | Counts only: `LIVING_TUNING.set('people.commuters', n)` (`citylife/params.ts`) | Jobs fixed in WGSL (`J_*`, 8 hubs `H_*`); no "go there now"; no lanes or queueing; cannot be hit |
| Workers and construction | Builders go stores → a rising lot → work → back; quarry dug bench by bench; clearing felled to stumps; stockpiles | W | `citylife/works.ts: Works`; `works.wgsl`; `season/life.ts: townLife` | `SeasonHost.life` sets counts from the ledger each season | Builders carry no stone; pit lost when streamed land regenerates |
| Carts, wagons, ships | Stone and log carts; trade wagons in by a gate to a shop and out; ships to the harbour's quays | W (wagons, ships via cards `trade`, `harbour`) | `routes.wgsl` `J_STONE, J_LOGS, J_WAGON, J_SHIP`; `life.ts: LIFE` | `LIVING_TUNING.set('people.wagons', n)`; `'people.ships'` | One number per town; not tied to a far place or a named gate |
| Arrivals from the world | Refugees = +40 commuters per fallen town, +10 wagons that season; a camp's 14 ore wagons; the trade route's wagons and ships by the share of its far towns still standing (round 6) | W | `season/realm.ts: Realm.life, partners`; hook `scenes/level/loop.ts: startRunLoop` (`life:`) | Driven by `migration` events, the camp's facts, `partners()` | The column walking in is the live event `refugees-arrive` (section 3b); round 7: the camp's tents on the ground are the mutators' `camp` sign (section 5) |
| Agent work crews | Units that dig, haul and build a planned town block by block | L (sandbox town tool, `api/world.ts`) | `agents/crew.ts: Crew`; `agents/buildcrew.ts: BuildCrew`; `build/town.ts: Town` | `scenes/level/town-tools.ts: sendBuilders` | Older town system, not citygen's |
| Creatures with bodies | Rigged animals round the camera | L (`?life=1|dragon|town|viewer`) | `src/inhabitants/install.ts: installInhabitants` | — | Not in the loop |
| CPU units | A few dozen CPU-steered units | L (`story/hero-run.ts`) | `src/units/simple.ts: SimpleUnits` | — | Superseded by AgentUnits |

## 2. Towns

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Town generator | Arterials, bridges, streets, blocks, lots and mesh on the GPU from the live ground. Round 9: the game's streets are lanes (`town.ts GAME_STREETS`: main 6, minor 3.6, arterial 7 cells, one light paving, a central square `plazaR` 14) | W | `src/citygen/gpu.ts: CityGen`; `citygen/town.ts: FieldTown`; `citygen/towns.ts: FieldTowns` (`scene.fieldTowns`, `window.citygen`) | `towns.live.get(id)`; `towns.addSite(site)`; `?city=majorWidth:6,…` (any `citygen/params.ts` key, trials) | 4 towns live at once (`sim/static-claims.ts: OWN_SLOTS`); (loop-streets) the arterials and the central square are graded into the columns as light paving (`terrainRoads`, on for the game's towns; `?city=terrainRoads:0` the old ribbons); (loop round 11) the main streets graded too as they show (`terrainMain`, a record a 48-unit tile of the major lines' pieces as segments, `ROAD_SEGS`; `?city=terrainMain:0` drawn) — minor lanes are still ribbon meshes on the claimed paving |
| Building generator (archgen) | Parts per lot on the GPU (bodies, roofs, windows, keeps, markets with stalls on plazas, gardens), instanced and textured, its own light and ground textures; merged from `archgen-ground` in round 9 | L (`?arch=1`) | `src/archgen/townbuildings.ts: TownBuildings` (`globalThis.archTowns`); `archgen/archgen.ts: ArchGen`; docs/design/ARCHGEN.md | `?arch=1`; `archTowns.counts()` (a debugging read) | Not the default: roofs above the claims (AG13/CG24), phone vertices (AG14), lot conditions not read — mutators do not show on its houses (LS-100) |
| Districts and stages | Claim a district by purpose (housing, market, harbour, workshops, farms, keep); raise it a share at a time | W | `api/contracts/citygen.ts: CityDistricts` | `await towns.claimDistrict('market')`; `towns.stageDistrict(town, id, stage)` | 6 purposes |
| Lots | Lot records, progress 0..1, condition word, all GPU buffers | W | `citygen.ts: CityLots`, `LOT_KIND` (building, park, plaza, landmark, field) | Read on the GPU only (`townplace.wgsl: lotAt, lotPlace`) | The CPU does not know lots |
| Lot conditions | drowned, burned, destroyed, buried, abandoned, occupied, overgrown, looted — tint, roof gone, height cut | W | `src/mutate/index.ts: LOT_CONDITION`; `mutate/gpu.ts: MutateGpu` | Via mutators (section 5) | Written by mutators only |
| Walls and gates | A ring with gates rising piece by piece; wall-walk and stairs | W (card `walls`) | `FieldTowns.wallStart`, `wallStage`; `citygen/wallshape.ts` (debug) | `towns.wallStart(town)`; `towns.wallStage(town, from, to)` | Walk passes through corner towers |
| Named places | muster, stores, barracks, market, keep, gate0..9, spawn0..7 per town, with status. Round 9: the market is a market district's open lot, else the central square (an open lot within 20 cells of the centre), else a market building | W | `api/contracts/townplaces.ts: PLACE, PlaceRef`; `src/towncontracts/contracts.ts: TownContracts` (`scene.townContracts`) | `{ town: tc.townIndex(id), place: PLACE.market }` or `{ town, district, kind, rank }` | **No temple or square by name**: use a lot ref (kind 3 plaza, 4 landmark) |
| Side map | Which side of a wall each column is on (for fight rules) | W | `towncontracts/sidemap.wgsl`; `TownContractsApi.gates` | `?sidegates=open` | — |
| Street routes | Route graph from the road raster, hub distance fields, cached routes with width per point | W | `citylife/routes.wgsl`; `api/contracts/routes.ts: CityRouteRead`; `shaders/routeread.wgsl: routeAt, routeWidth, gateRoute, wallWalkRoute` | `livingTowns.routeRead(siteId).buffer` bound at `ROUTE_BINDING` 56 | Routes exist per (start column, hub); only gate and wall routes are named for units |
| Sites of the home town | 17 named sites placed on real ground (gate, waterside, tower, market…) | W | `season/sites.ts: placeSites`; `season/realm-templates.ts: SITES, siteId` | `siteId(home, 'gate')` | FIXED-CITY: one town; a site is a point, not a lot |
| Founded places | A `founded` mutation becomes a new generated town site | W (`mining-outpost`) | `scenes/level/mutators.ts: syncFounded`; `mutate/list.ts: FOUNDED_RADIUS` | `mutators.apply({ kind: 'founded', place, name, size: 'camp' })` | A camp is built as the smallest village grid; no tents |
| Town edit log | Claims, stages, wall, works saved by world position and replayed | W | `citygen/townlog.ts: TownLogs` | `towns.logs.save(at)` | — |
| Town lab | Scripted gates over a fixture town | L (`?lab=1`) | `src/lab/lab.ts: TownLab` | — | — |
| Older town builder | Planned town on a quad grid, built by agent crews | L (sandbox `town` tool) | `src/build/town.ts: Town` | — | Not the game's towns |
| Settlement records | Atlas settlements, purposes, approach roads | W | `src/settle/settlements.ts: Settlements` (`scene.settlements`) | `st.settlement(id)`; `st.approachWays(id)`; `st.near(at, r)` | — |
| Town moods (curfew, checkpoints, parade, banners) | — | D | `docs/design/SEASON_LOOP.md` "Town moods" | — | Nothing built |

## 3. Opportunity engine

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Opportunity contract | Holdings, requirements, commit (lock people, spend goods), resolve by tier | W | `src/api/contracts/opportunity.ts: commit, resolve, affords, relics, fired` | `commit(h, opp, at)`; `resolve(h, c, at)` | — |
| Template engine | Templates as data: bind, eligible, setup, requires, turns, outcome, onExpire, presenter, reward, threat | W | `src/living/engine.ts: LivingEngine, TemplateDef, ArcDef` | `engine.deal()`; `engine.commit(offerId)`; `engine.advance()`; `engine.resolve(id, tier)` | `play.area` + a `Challenge` (a hero's play) is the horde run's; `play.event` (a live event in the city) is the loop's: section 3b |
| Template language | Predicates and effects over the fact world; `forEach`, `when`, named helpers | W | `src/living/dsl.ts: Pred, Effect, HELPERS, holds` | `{ tag: ['$site','condition','burned'] }`; `{ helper: 'pool', args: ['unrest', 1] }` | No distance predicate; no trigger on events |
| The game's templates | 11 town projects, mining outpost, tower lens, relieve neighbour, house refugees, guard camp, the dead, pay raiders (the raiders' standing threat: a card, no arc — loop round 10 merged card-table round 5), 4 hazards | W | `src/season/realm-templates.ts: WORLD_TEMPLATES, projectTemplate` | Add a `TemplateDef` to `WORLD_TEMPLATES` | Threats come on a fixed share of the run (`after`), not from world state |
| Realm helpers | isHome, siteIs, canBuild, hasSpell, after, pool, income, spell, raid, avert, mutateAt, found; round 6: raidDue, live (vars), raidOver, mark, burnPoints, camp; `pool` and `mutateAt` take a live event's numbers and place | W | `src/season/realm.ts: Realm` (its `Stage` helpers) | `{ helper: 'mutateAt', args: ['burned', '$site', 30, 1] }` | Defined in a closure in `Realm`, not a shared registry |
| Dealer | Filters, tiers, scores (13 parts incl. synergy, stakes, urgency), deals within limits, explains every choice | W | `src/opps/dealer.ts: deal, DealReport` | via `LivingEngine.deal`; tuning `opps/tune.ts: OPP_TUNE`; round 7: the engine's `boardMax` caps what stands after a deal (the realm: 5), threats never left out (LS-73) | `synergy` is a number a template supplies; nothing computes it in the game |
| Fact layer | Entities (13 kinds), scoped tags, intensities, relations, claims, event history, invariants | W | `api/contracts/facts.ts: FactStore`; `facts-store.ts: MemoryFacts`; `src/living/world.ts: FactWorld` | `w.facts.setTag(id, 'condition', 'burned', true, cause)`; `w.facts.record({ kind, by, to, note })`; `w.facts.events({ kind })` | No subscription to recorded events |
| World state | Regions, factions, settlements (stores, people, condition), characters, holdings | W | `api/contracts/world-state.ts: MemoryWorldState` | `ws.snapshot()`; `MemoryWorldState.restore(s)` | — |
| Instant outcome helpers | River inflow, place a structure, stores, power, condition, migrate, control | W | `src/living/mutations.ts: setRiverInflow, migrate, setControl, setCondition` | `migrate(w, from, to, share, cause, note)` | — |
| Relations and diplomacy | Agreements, opinions from event history | L (inspector, horde run) | `api/contracts/diplomacy-memory.ts: MemoryDiplomacy` | `{ agree: {…} }` effect | Not used by the realm's templates |
| Presenters and cast | Named people with rolled quirks, traits and voices present each card; answers remembered | W | `src/living/people.ts: pickPresenter, makePresenter, answer`; `living/cast.ts: rollPersona` | `presenter: { of: '$town', role: 'scholar', line }` on a template | — |
| Petition dialog | An offer as a dialog: greeting, ask, Needs / Takes / You get / If you refuse | W | `src/living/present.ts: petitionOf`; `src/dialog/petition.ts: petitionTree, actOf`; `dialog/dialog.ts: DialogBox`; `dialog/portrait.ts: portraitUrl` | `petitionOf(engine, offerId)` → `new DialogBox(...)` | Portraits are pixel stand-ins |
| Player stakes | What the player built or allied with scores higher | W | `src/living/attachment.ts: stakes, hops, attachment` | via the dealer's `stakes` part | — |
| Bonuses (relics) | Triggered effects held by the realm, an agent or a building: gain, discount, shorten, negate… | W in the engine (`engine.ts` `advance`: `'turn'` gain) / none authored in the game | `opportunity.ts: Bonus, Trigger, relics` | `reward: { bonuses: [{ why, on: 'turn', effect: { kind: 'gain', goods } }] }` | 7 fixed triggers; no place or tag query |
| Validator | Checks every deal and template | W (tests, inspector) | `src/gm/oppcheck.ts: checkLiving, checkTemplates` | — | — |
| Other template sets | Briar Hollow library; the horde slice | L (`inspector`, `?run=opps`) | `living/library.ts: TEMPLATES`; `living/horde.ts: HORDE_TEMPLATES, HordeStage` | — | — |
| Card lab | Deck-builder playground, kingdoms of stacks, bot policies | L (`cardlab.html`) | `src/opps/deck.ts: DeckRun`; `opps/kingdom.ts: generateKingdom` | — | Own card format (`CardDef`), not `TemplateDef` |

## 3b. Live events and synergy rules (round 6)

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Live event as data | Who takes part (groups: kind, side, count, tags, where from, order with formation), a hazard, seconds, spells allowed, when it ends, how its result is read (counts by tag, lots burned, casts), worked out (`derive`) and mapped to a tier. Round 7: groups `from: 'lining'` (stood along the entering road), `camera.pitch`, `finale` (camera kept on the end place with bursts), `after` (people walk off loose to a place, let go later), marks with a ring for people who take no part in a fight | W | `src/living/live.ts: LiveDef, LiveState, idleState, liveRead, liveDerive, liveTier, liveEnded, checkLive` | A template's `play: { area, forced?, event: LiveDef }`, `vars: 'live'`, tiered `outcomes` | Pure. Places: named places of the town, a road's spawn point or gate, a site. No route by street (LS-77) |
| The run's live events | The raid, the dead in the burial ground, a parade, refugees walking in, a fire at the market (round 7: dealt again — it burns in the town; `?livefire=0` deals the old instant hazard instead) | W | `src/season/realm-events.ts: LIVE_TEMPLATES` | Add a `TemplateDef` with `play.event` | Numbers are first guesses (LS-66) |
| Resolving one | From the state it is in: numbers read → rules applied → derived → tier → the template's outcome through the engine; at the season's end by itself; in Node from the state nobody played | W | `season/realm.ts: Realm.finishLive, tellLive, liveRunning, forcedLive, playForced, runNumbers` | `realm.finishLive(offerId, told?)` | Who decides a fight: the live counts, then one line of arithmetic (LS-56, open) |
| The runner | Plays any `LiveDef` in the city: groups made by place, by site or in by a road (the camera down each road in turn); the hazard lit; story camera; sim speed on the march; counts from the units' own events; goes on while the player is elsewhere | W | `src/scenes/level/live-runner.ts: LiveRunner` (`rungame.liveDebug()`); lab: `scripts/lab/liveshot.mjs --event <template> [--mail]` (stills of one event, the order groups' GPU words) | `runner.start(offer, def, site)`; `runner.told(run)`; `runner.close(run)` | One entering column a run; round 7: the time of day held while any event runs, one begun at night played from morning (LS-78); arrival is the units' own `arrived` (the stand-still timer is gone, LS-72); a reload restarts only the raid (LS-65) |
| Hazard: fire | The real fire system lit at N spots (canvas put down at twice as many; the first N whose surface took it, with no water, are lit — one read of their pages); a spot alight 12 s is a burned lot; the points move with the window (`LiveRunner.shift`) | W (round 7; most stalls go out by themselves in ~18 s: LS-80) | `live-runner.ts` (`hazard`); `realm.ts` helper `burnPoints` | `hazard: { kind: 'fire', at, points, spread, radius, intensity }` | Reads the fire mirror's pages (a few KB) every 2 s while a fire event runs. Generated buildings do not burn in the fire system (LS-63) |
| Hazard: front (loop round 12) | Lava or flood water poured `far` cells uphill of the event's place (the highest of 16 points on that ring, read once from the terrain pages), `rate` cells³/s for `pour` s, running down the ground as it lies — the flow model's real liquid (lava sets to basalt in the columns). The chunks from source to target kept awake and touched (the hybrid lets only touched chunks wake). Its points in the town and 10 along its way read every 2 s through the mirror (`Fire.flowLavaAt`, `Water.depthAt`); the camera on its head. At its end every reached point takes the land change (`melted` / `flooded`, lots destroyed / drowned) whatever the tier (`Realm.frontLand`) | W | `live-runner.ts startFront, front, frontAt`; `living/live.ts LiveFront`; `realm.ts frontLand`; docs/design/FRONTS.md | `hazard: { kind: 'front', liquid: 'lava', at, far, rate, pour, points, spread, mutate: 'melted' }`; pack `hazard: { kind: 'lava' }`; lab `scripts/lab/frontshots.mjs` | Lava has a yield (0.12 a cell): on Muru's flat valley it piles near the vent (a cone); reach comes from volume (LS-122). The source is a CPU pick (LS-121) |
| Tags | Each site's tags from what it is and its state; the home town's (wall, garrison, unrest); trade partners | W | `season/realm-rules.ts: SITE_TAGS, RUIN, TIMED`; `realm.ts: Realm.things, partners, mark` | `realm.things()` | Derived on demand from the fact layer and the ledger; sites only (lots are GPU-side) |
| Synergy rules | Trigger (season end, a fact event's kind, a live event's read) + tag queries with a relation of place (near the first thing, near the event, on its route, same town) + an effect on a pool or on one of the event's numbers (add, multiply) + capacity + firings a season; each firing recorded (`rule-fired`) and told in one line | W | `src/living/rules.ts: RuleDef, RuleBook`; the run's ten: `season/realm-rules.ts: RULES` | Add a `RuleDef` to `RULES` | A route is the straight way from start to end; no rule may write a fact another reads |
| Spells | Heat ray (a blow on units), Fire (a blow + the fire system lit), Rain (a storm over the tap), Growth rune (plants grown, the field `growth-active` for the season) | W | `scenes/level/loop.ts: Game.castAt`; `realm.ts: Realm.cast, SPELL_COST, BASIC_SPELLS` | `realm.cast('growth', 'fields')` | Aimed by a tap; a cast is a fact event (`spell-cast`) |

## 3c. Packs, laws, endings and the record in the 3D game (round 8)

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Packs in the 3D game | The card table's loader (`packs/load.ts`) and Realm options; packs/ by name are part of the build; a pack with errors is left out with its report (a page from the town sheet) and the base game plays | W | `season/run-packs.ts: fetchPacks, loadRunPacks, realmExtra`; `loop.ts load, packOptions` | `&packs=laws,glitter,arena`, `&pack=<url>` | View code copies Table's (LS-84) |
| Laws, rules, record pages | "Laws", "Rules", "Remembered" on the town sheet: laws in force (who made them, how long), every rule with what it lacks / that it is ready / what it paid, every card done or run out in this world by place | W | `run-packs.ts: lawLines, ruleLines, recordByPlace`; `loop.ts lawsPanel, rulesPanel, recordPanel`; `run-ui.ts Panel` | — | The record is a list, not drawn on the atlas map |
| Law-applied play | Card costs through `Realm.terms` (the petition shows "By law. Printed: …"), the laws a card brings in "You get", live events through `Realm.liveOf`, a `kills` law widens Fire / Heat ray's blow (√ of the factor, LS-87) | W | `loop.ts petition, castAt` | — | — |
| Chains and "settle it now" | Rule firings worded as the table words a chain in the season's news; "Settle it now" on an event's sheet resolves it with what happened so far (`Realm.resolveNow`); an event a rule starts begins at once. Round 10: each press settles the event its button was drawn for (`settle(id)`) — chains run without limit, a press each | W | `loop.ts settle, chained`; `live-runner.ts canSettle` | `rungame.settle(rungame.liveNow.id)` | The raid cannot be settled |
| Spells on units (round 10, LS-94) | A pack ability's `in_event` may name `berserk` (the foes within N cells of the tap take on anyone near, one another too) or `hides` (your people within N cells: no foe takes them on, not drawn). The general pieces: a spell word a unit slot after its combat words, written by one GPU dispatch over the slots in an area (setSide, berserk, hidden, a least sight); targeting and the draw read it. (loop round 11) Seen: berserk units drawn in a red mist (three glowing motes), `faint: true` hidden units drawn faint (dithered, two glints: the player's own; foes' hidden stay undrawn), a ring of sparks at the reach as it is cast; a pack event's camera follows its foes with your side in frame (`LiveDef.camera.with`), zoom 24, 34 once blows land | W | `src/shaders/unitspell.wgsl`; `notice.wgsl SP_*, wordOf, mayFight`; `units.wgsl unitDraw`; `agents/notice.ts spellArea, SP, BERSERK_SIDE`; `Units.spell` (`agent-units.ts`); `loop.ts castAt`; example `packs/arena.json` Red mist, Veil | `units.spell({ at, radius, who: 'foes', berserk: true })`; `units.spell({ at, radius, who: 'friends', hidden: true, faint: true })`; GPU test `test/gpu/unitspell.test.ts` | LS-108: hidden lasts the unit's life; berserk needs a kind that can strike (workers cannot); the CPU's faction for a unit is unchanged; laws do not change the reach |
| Pack things on the map | A green marker at the thing's site (its card: text, tags, picture, pack abilities to cast on it); "remains of …" once ruined (this run or an earlier one); "Done: <card>" at its site for a season (the floor) | W | `run-packs.ts thingMarks`; `loop.ts markers, thingPanel, markDone` | — | A marker, not a building (LS-86) |
| Endings | `end_run` ends the run: the end screen's title says what ended it and by what; world-wide effects (`far_all`) are mutators on every far town (map badges); the run-start screen says what the world is now | W | `loop.ts endTitle, worldNow`; `run-packs.ts worldNow` | — | — |
| Portrait slot | A card's presenter and a thing's card show `local/art/<id>.png` if the server has it, or the pack entry's `image` URL, else the pixel face | W | `loop.ts artFor` | put a PNG in `local/art/` | No image generation |
| Streets in the units' fields | The town's arterials stamped as road bands (`Agents.setRoads`) and, round 9, every street from the town's road raster on the GPU (`Agents.setRoadRaster`, `roadstamp.wgsl roadRasterStamp`; LS-88): every field prefers them (ROAD_COST 0.5) | W | `loop.ts feedRoads` | `?roads=0` off; `?streets=0` the arterials alone | FIXED-CITY: one town's raster |
| March in | A `march` with `inward: true` walks gate slot k's route backward, from its outer end to the gate, in formation; the runner marches every entering column in by its road's route and gives its own order at the end. Round 9 (LS-89): without a wall gate slot k is the arterial's road route, from the central square out (`routes.wgsl` wallWork's road mode) | W | `orders.wgsl MARCH_IN`; `agents.ts` word FORM_AT+1 = 2; `live-runner.ts make, onward` | `orderGroup(g, { kind: 'march', town, gate, inward: true })`; `?marchin=0` off | A column `go` from cluttered ground can still stand forming while its ranks walk off (LS-98); GPU test `formations.test.ts` "a march in" (walled) |
| Side colours | Place groups drawn by side: foes red, soldiers steel, folk yellow (LS-95) | W | `agent-units.ts sideColour`; `Agents.colourGroup` | — | No outline; raiders and carts keep their models |

**Every effect a pack card can have, and how the 3D game shows it** (one table, not per-card code):

| Effect (`PACK_FORMAT.md`) | Class | How it shows |
|---|---|---|
| `pool`, `income` | (i) instant | the top bar's numbers; the card's line in the season's news |
| `mutate` on a site | (i) instant | the mutators' land change round the site (burned, flooded, buried …) |
| `mutate` / `far` on a selector, `far_all`, `trade` | (i) instant | mutators on far towns (map badges), trade wagons and ships by partners standing |
| `sign` in the town | (i) instant | the sign (ash, darkness, the dead, crime) |
| `put` | (ii) at the season turn | a marker at its site, dust there and "Built: …" in the news as the season passes, the camera on it |
| `remove` | (i) instant | its marker goes |
| a card's `live` event (pack events), abilities with `in_event`, "settle it now" | (iii) live | the runner plays it at the card's site; the ability is a button on the event's sheet |
| `arrive` | (iii) live | the base refugees' event (people and carts in by a road, tents) |
| an event's `hazard` `lava` / `flood`, an ability's `in_event.shield` (loop round 12) | (iii) live | the front poured uphill and running down to the town, the camera framing its head and the town (round 13: the shield and the head once one is up); the shield's wall of light, its cast and its end, the liquid parting round it and flaring white where it presses; what it reached changed for good (`melted` / `flooded`) |
| a sign `rain` / `storm` / `fog` (and `ashfall`, `darkness`), a pack's `weather` list (loop round 13) | (i) instant | the weather over the town: wind, a storm held over it, how often storms pass, the sky dimmed, ash, fog (`weather/presets.ts`, §6) |
| `law` | (iv) floor | the Laws page, "a new law" in the history, numbers that change (costs, rules) |
| `tag`, `untag`, `stance`, `unlock`, `sign` on far places, `say` | (iv) floor | its line in the season's news and a "Done" marker at the card's site for a season; tags on the thing's card |
| `end_run` | — | the end screen, titled by the ending |

## 4. Season and run loop

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Pools | Magic, Might, Labor, Materials, Intel, Unrest as holdings; people locked, goods spent | W | `src/season/ledger.ts: POOLS, pools, grant, lose, commit, nextSeason` | `lose(ledger, { magic: 1 })`; `pools(ledger).unrest` | Unrest keeps that many workers away |
| Card catalog | The town's building cards and their chain | W | `src/season/catalog.ts: CATALOG, card` | — | Fixed list |
| Season loop | Start / undo cards, find land, Next season, stages played as a showcase | W | `src/season/loop.ts: SeasonLoop` (`window.season`) | `season.next()`; `season.setLedger(l)` | One town (FIXED-CITY) |
| Time-lapse | Steps applied at fractions of a timed showcase; districts rise on the towns' clock | W | `api/contracts/simtiers.ts: SimTiers.showcase`; `src/sim/tiers.ts: Tiers`; `FieldTowns.timelapse` | `tiers.showcase(steps, { seconds })` | — |
| The realm (a run) | Joins the engine to the ledger: offers, commit, end of season, spells, history. Round 10 (card-table round 5 merged): no arc — the raid is the raiders' standing card run out and the forced `raid` card in the last season; the run ends when its last season ends ("The town stands") or by an ending | W | `src/season/realm.ts: Realm` (`rungame.realm`) | `realm.offers()`; `realm.commit(id)`; `realm.endSeason()`; `realm.standingThreat()` | 16 seasons (`RUN_SEASONS`) |
| Run screens | Leader pick, top bar (the standing threat's own countdown), markers over places, season news, attack, result, end; round 10: "The world now" over the town as a run begins | W | `src/season/run-ui.ts: mountRunUi, RunGame`; `season/run-words.ts` | — | Crude on purpose |
| Leaders | Three leaders, different starting pools; round 10 (LS-93): the packs' leaders on the 3D screen too (one who plays from a far town says "Rules from <town>"; locked ones show their hint and cannot be picked) | W | `run-words.ts: LEADERS`; `run-packs.ts leaderChoices` (the table's `Table.leaders` calls it); `loop.ts leaders, pick, begin` | `&packs=frontier` | — |
| A run from another town (round 10, LS-93) | A pack leader whose `home` is a far town: the page opens again on that town (`?town=<id>`, the level builds any settlement's town) and the run begins there; the old home is a far town (`realm-home.ts moveHome`, the table's one path); a run under way, or a new run, is played from the world's last home — the page goes there | W | `loop.ts load, openOn, pick, begin` (`realm:start` in the store); `season.ts restore` (the start town's season only); `season/realm-home.ts` | `node scripts/lab/farhome.mjs` | Only towns the town generator builds (village and up); FIXED-CITY: one town a page (LS-106) |
| Save and resume | World as a delta from the atlas's own (~0.1 MB) plus the run's state and its home, under `realm:world`; round 10: at a run's end what the town built is written on it (`built:<card>`, `realm-home.ts keepBuilt`, as the table) | W | `scenes/level/loop.ts` (`WORLD_KEY`, `SavedRun`); `src/api/snapshot-delta.ts: delta, applyDelta` | Saved at start, each answer, each season end, after the fight | A reload mid time-lapse or mid attack returns to just before it |
| Earlier season UI | Card sheet with a dealt hand, fixed raid schedule | L (`?loop` absent: the default town game) | `season/ui.ts: mountSeasonUi`; `season/deal.ts: dealHand` | — | Replaced in the loop by the realm |
| Hero run modes | Story runs, situation runs, opportunity runs with a hero on the atlas | L (`?run=<story>`, `?run=sit`, `?run=opps`) | `scenes/level/runs.ts`; `src/runsit/level-sit.ts: LevelSit`; `src/opps/level-opps.ts: LevelOpps`; `src/story/play.ts: StoryPlay` | — | Not the loop |
| Run planner | Region-graph run plans, viewer | L (`?runplan=view`) | `src/runplan/plan.ts`; `runplan/viewer.ts` | — | — |
| Fight decided by a rule, not by playback | Half: what is still standing when a live event is read is settled by its `derive` arithmetic; in Node the whole raid is | S | `season/realm-events.ts` (`RAID_EVENT.derive`); `docs/design/LOOP_SKELETON.md` "who decides the fight" | — | While it plays, the units' counts decide (LS-56) |

## 5. Mutators and signs

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Mutators | Instant, persistent changes to land and places: flooded, burned, melted, buried, dried, withered, greened; founded, destroyed, abandoned, captured, vassal | W | `src/mutate/index.ts: Mutators, MutationSpec` (`mutators`); `mutate/engine.ts: MutateEngine`; `shaders/mutate/land.wgsl` | `mutators.apply({ kind: 'burned', place, radius, strength, cause })` | Instant; `MutateEngine.play` (animated) is an empty stub |
| As template outcomes | `mutate`, `sign` helpers; the realm's `mutateAt`, `found` | W | `mutate/outcomes.ts: registerMutatorOutcomes` | `{ helper: 'mutate', args: ['flooded', '$town'] }` | — |
| Far land | Same entries written into arriving land and far tiles | W | `MutateEngine.landWritten`, `tileWritten`, `townMade` | hooks set in `scenes/level/mutators.ts: attachMutators` | — |
| Place states | standing / founded / destroyed / abandoned / occupied / vassal, owner, tribute, conditions — from the fact layer | W | `src/mutate/facts.ts: recordMutation, placeState, placeStates` | `mutators.places()`; `mutators.place(id)` | — |
| Signs | ashfall (flakes + grey dusting), darkness (sky dim), deadrise (burial ground + shamblers), crime (looted lots), camp (round 7: tents of canvas on trodden ground at its cell, `land.wgsl MUT_TENTS`; cast by the realm's `camp` helper); (loop round 13) rain, storm, fog. ashfall, darkness, rain, storm and fog are weathers (§6 Weather presets); each ends at a season or when switched off | W | `MutateEngine.sign, signs, season`; shown in `mutators.ts: showSigns` | `mutators.sign({ kind: 'crime', place, strength, until })`; `{ kind: 'camp', place, at: [x, row] }`; strength 0 ends it | 8 kinds; shows only on a live generated town (FIXED-CITY, MU-27) |
| Rivers run dry | A `dried` entry cuts the river field downstream | W | `mutators.ts: syncCuts`; `src/weather/catchwet.ts: RiverCut`; `weather/inflow.ts: carryInflow` | `mutators.apply({ kind: 'dried', place })` | — |
| Map badges | A badge per condition on the atlas map | W | `src/mutate/mapmarks.ts: drawBadges, badgesOf` | — | — |
| Mutator lab | A button per mutator and sign | L (`?mutlab=1`) | `mutate/lab.ts: mountMutLab` | — | — |

## 6. Weather, water, fire, lava, wind, ecology

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Storms, dust storms, cyclones | CPU entities that give rain, shade and wind fields | W (runs under the loop) | `src/weather/weather.ts: Weather` (`reclaimed.weather`) | `weather.spawn(x, y)`; `weather.spawnDust(x, y)`; `weather.spawnCyclone(x, y, spin)` | The loop's Rain spell calls `spawn` |
| Day, night, seasons | Sun, moon, season of the year | W | `weather/daynight.ts: DayNight`; `globals.season` | `?tod=`, `?day=`, `?season=`; round 7: `dayNight.held = true` stops the clock (live events) | — |
| Weather presets (loop round 13) | Named weathers — fair (the default, as before), clear, rain, storm, ashfall, fog, dark — each a bundle of the prevailing wind, a storm held over the town, how often natural storms come, the sky dimmed, ash falling, fog. The season's weather (a pack's `weather` list) with the town's weather signs laid over it (the stronger number wins) | W | `src/weather/presets.ts: WEATHERS, weatherNow, seasonWeather`; `scenes/level/weather-set.ts: WeatherSet` (`scene.weatherSet`); `core.skyDim`, `core.ashFall`, `core.fog` (the fog: `light.wgsl haze`, Globals.ring.z); `Weather.holdOver`, `setNatural` | a sign (`mutators.sign({ kind: 'storm', place })`, a pack's `{ "sign": "storm" }`); a pack's `weather` list; `weatherSet.setSeason('fog')`. Stills: `scripts/lab/weathershots.mjs`; unit test `test/unit/weather-presets.test.ts` | The rain reads as a darker, wetter town at 412 px: its streaks are faint from above. One held storm, over the home town (FIXED-CITY). The card table shows weather signs as signs; the season's weather only in 3D |
| Water | Depth and flow per column; flood and drain | W | `src/api/water.ts: Water` (`scene.worldApi.water`); `src/flow/liquid.ts: LiquidSystem` (`?flow=1`) | `water.flood(x, y, { radius, depth })`; `water.drain(…)` | Mirror reads are cached, not per frame |
| Rivers | Held rivers by table, per-watershed wetness, cuts | W | `weather/catchwet.ts: CatchmentWet`; `weather/riverwet.ts: RiverWet` | via mutators `dried` | — |
| Fire | Fuel catches, spreads, heats, brings timber down | W (round 7: lit in the loop's town it burns — woods and fields 0.9-1.0, canvas stalls; bare grass and paving have no fuel. `scripts/lab/fireprobe.mjs`) | `src/api/fire.ts: Fire.ignite, fireAt`; `shaders/fire.wgsl`; event `EV_IGNITE` | `worldApi.fire.ignite(x, y, { radius, intensity })` | Fuel is plants, oil, timber, canvas, trash on top of a column (`fire.wgsl: fuelAt`). Citygen's buildings are meshes: they do not burn in it (LS-63) |
| Lightning, chip, scare, grow, ripple, mend | One-tick world events | W | `src/sim/globals.ts: EventKind`; `shaders/common.wgsl: EV_*` | `globals.events.push({ kind, x, y, radius, strength })` | Seen only by period-1 systems; more than 4 a tick wait |
| Lava | Vents, flow, cooling, steam | W (loop round 12: the flow model's lava, `LiquidSystem` LAVA, is installed in every world — the town level too; a front pours it) / L (the sandbox's `src/sim/lava.ts LavaSystem`: beam, volcanoes) | `flow/liquid.ts: LAVA` (`core.flow.lava`); `src/sim/lava.ts: LavaSystem` | `core.flow.lava.addSpring(x, y, z, rate)`; `scenes/level/impacts.ts: ventAtPick` | A spring in a sleeping chunk pours nothing: the chunk must be woken, and on the atlas level touched for the hybrid to let it wake (FRONTS.md) |
| Wind | Blows, gusts, blasts, strokes, wakes painted into the wind field | W | `src/api/wind.ts: Wind` | `wind.gust(x, y, r, strength, dir)`; `wind.blast(x, y, r, strength)` | Painted wind lives ~45 s (`sim/windrect.ts`) |
| Plants and trees | Succession field, trees, fell, grow, clear | W | `src/api/plants.ts: Plants`; `api/treequery.ts: TreeQuery` | `plants.grow(x, y, { radius })`; `plants.clear(x, y, r)`; `plants.treesNear(x, y, r)` | — |
| Erosion, sediment, contamination, moisture | Column passes with sleep and tiers | W | `src/sim/systems.ts`; `sim/sleep.ts: Sleep`; `sim/tiers.ts: Tiers` | `sleep.wake(x, y, r, secs, now)` | Sleeping chunks do not tick |
| Snow and wet cover past the window | Atlas-scale cover field | W | `weather/cover.ts: WeatherCoverSystem` | — | — |
| L-system flora | Generated plant meshes | L (`flora.html`, `?florabench=1`) | `src/flora/index.ts: FloraWorld` | — | Not in the game's draw |

## 7. Spells and powers

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Heat ray (loop) | Area blow on units, 1 Magic, shown as a lightning strike | S (look is a stand-in) | `scenes/level/loop.ts: Game.castAt`, `HEATRAY` | `units.strike({ at, radius: 5, damage: 2 }, 'spell')` + `powers.scriptStrike(x, y, z)` | Cast at a live event that allows it (`spells: ['known']`: the raid); unlocked by template `tower-lens` |
| Fire (loop) | A blow (damage 12) and the fire system lit where it lands | W | `loop.ts` `FIRE`, `castAt` | `units.strike(…)` + `fire.ignite(x, y, { radius: 3 })` + `fx.burst('flame')` | Cast at a live event that allows it (the dead) |
| Rain (loop) | A storm over the tap: it rains there and puts fire out | W | `loop.ts castAt` | `core.weather.spawn(x, y)` | Cast at a live event that allows it (the fire) |
| Growth rune (loop) | Every season, in the town: plants grown round the tap on the east fields; the field is `growth-active` until the season ends (rule `blessed-fields`) | W | `loop.ts castAt`, `GROWTH`; `Realm.cast` | `plants.grow(x, y, { radius: 11, strength: 45 })` | One field (the site `fields`); a tap, not a drawn rune |
| Spell bar and arming | Buttons, tap to aim | W | `season/run-ui.ts`; `Game.arm`, `Game.cast`, `Game.allowed` | — | Four spells (`realm.ts: SpellId`) |
| Telekinesis | Text only in the loop | D in the loop / L elsewhere | `run-words.ts: SPELL_LATER`; real ones: `Units.hold/release`, `game/integrity.ts` (`Grab`), `play/core/levitate.ts` | — | — |
| Rune drawing | — | D | `docs/design/FORTRESS_MODE.md` "Spells" | — | Swirl detection exists (`powers.ts: checkSwirl`) |
| Gestures (sandbox hands) | Tap = grow / lightning under a storm; drag = wind gust; swirl = cyclone or storm | L (off in the loop: a tap does nothing, a drag pans) | `src/game/powers.ts: Powers` (`reclaimed.powers`) | `powers.scriptTap(x, y)`; `powers.scriptStroke(pts, secs)`; `powers.gustStart/Move/End` | — |
| Heat beam | Melts ground to lava along a beam | L (sandbox tool `beam`) | `scenes/level/impacts.ts: aimBeam, beamAim` | — | Sandbox physics levels |
| Meteor, volcano, drop, smash, drag | Impacts with craters, vents, dropped bodies, break tool, grab | L (sandbox tools) | `impacts.ts: meteorAtPick, ventAtPick, dropAtPick`; `sandbox-tools.ts: smashAt` | — | — |
| Brushes | build, dig, pour, water, drain, oil, pollute, clean, plant, storm, duststorm, cyclone | L (sandbox editor) | `src/ui/editor.ts: EditTool, EDIT_OP` | — | — |
| Shield (loop round 12) | A disc the liquids cannot flow into: lava and flood water part round it (the liquid's uniform, `liquid.wgsl shielded`: a wall to flux and to falling streams). Up to 4, timed in sim seconds, moved with slides; shown through the particles' glows (round 13: a wall of bright beads round the rim standing on the ground and a haze over the dome, each one burst request placed on the GPU; the cast a ring spreading from the middle to the rim, streaks thrown up as it closes; its last 3 s flickering, then streaks thrown off; where hot lava presses on it, white flashes made by the lava kernel itself, `liquid.wgsl publishLava`). A pack ability raises one: `in_event.shield` (+ `seconds`) | W | `src/api/shields.ts: Shields` (`worldApi.shields`); `flow/liquid.ts LiquidSystem.shields`; `loop.ts castAt` | `shields.raise(x, y, { radius, seconds, z })`; example `packs/ages.json` Fire ward; GPU test `test/gpu/shield.test.ts` | Not a wall to units or fire; drawn with particles, not a mesh dome (LS-123) |
| Unit effects | heal, raise, damage by type, status over a disc | W (installed) | `TraitsApi.apply` (`scene.traits`) | `traits.apply({ op: 'damage', type: 'fire', at, radius, amount })` | Not used by the loop's spells yet |

## 8. Camera, story camera, cutaway

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Camera | Pan, zoom, pitch, turn, project, ray to ground | W | `src/render/camera.ts: Camera` (`core.camera`) | `camera.project(x, y, z)`; `camera.groundAt(sx, sy, heightAt)` | — |
| Story camera | Queued shots: frame, look, reveal, follow a moving point, release | W | `src/story/camera.ts: StoryCamera` | `cam.look(at, { zoom, ease, place })`; `cam.follow(() => mid)`; `cam.release()` | A shot waits behind a held frame |
| Raid and build shots | Down the road, on the march, on the fight, on a district being built | W | `loop.ts` (`ROAD_ZOOM`, `MARCH_ZOOM`, `FIGHT_ZOOM`, `BUILD_ZOOM`) | — | Camera kept within 650 cells of home |
| Intro director | Scripted camera and simulated gestures | L (valley intro) | `src/game/director.ts: Director` | — | — |
| Cutaway | Slice under a roof, orbit round a cliff, dither what hides a point | L (`?cutaway=1`) | `src/api/cutaway.ts: Slice, Orbit, Dither`; `api/puck.ts: Puck` | `dither.see(id, x, y, z)` | Not on in the loop |
| Turn, fly, drive | View turning, free fly, scripted pan | W (turn) / L | `scenes/level/camera-moves.ts` | `?pan=`, `?drive=` | — |

## 9. Map and atlas

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Atlas | GPU world map: landforms, rivers, regions, sites, roads | W | `src/atlas/atlas.ts` | `atlas.macroAt(x, y)` | — |
| Streaming window | Paged ring window with a region store; far tiles | W | `src/scenes/streamer.ts`; `src/sim/pages.ts: Pages`; `render/tileworld.ts` | `S.onWritten`, `S.onSlide` hooks | — |
| Atlas map screen | The map with labels, marks, badges | W (the Map button) | `src/api/atlas-map.ts: AtlasMap` | `map.open()`; `map.centreOn(x, y)` | — |
| World wiki and names | Facts and names from the atlas | W | `src/gm/wiki.ts: buildWiki`; `gm/map-names.ts: wikiLabels` | — | — |
| Atlas viewer | Whole-atlas view | L (`?atlas=view`) | `scenes/atlas-view.ts: AtlasView` | — | — |

## 10. Effects and particles

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Particle bursts | dust, litter, leaves, ash, chips, cloud, splash, smoke, embers, flame, haze, seeds, sparks, petals, grains; (loop round 13) a glow burst may be a whole ring or dome placed on the GPU (`PK.Glow` states 2 rim, 3 dome, 5 streaks; 4 the lava's flash on a shield) | W | `src/api/fx.ts: Fx.burst`; `src/sim/particles.ts: ParticleSystem, PK` | `worldApi.fx.burst('petals', x, y, z, { count })` | 64 bursts a tick, the rest queue |
| Animals as particles | Birds, deer, rabbits, fireflies | W | `PK.Bird, Deer, Rabbit, Firefly` | `particles.burst({ kind: PK.Bird, … })` | — |
| Voxel figures and meshes | Draw hooks other systems add to | W | `core.renderer.addVoxels`, `addMesh`, `frameCompute` | — | — |
| Foliage sway, water surface, shore | Render passes | W | `shaders/sway.wgsl`, `watersurf.wgsl`, `shore.wgsl` | — | — |

## 11. Audio

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Ambience | Synthesised soundscape from aggregate state | W, but starved in the loop | `src/audio/ambience.ts: Ambience.update(AudioState)` | — | The loop sets `scene.valleyReads = null`, so plants and water round the view are not heard (PI-3) |
| One-shots | thunder, clang, chip, splash, grow, flutter, rustle, strain, groan, collapse, crumble | W | `Ambience.thunder(near, vol, at)` etc. | — | No crowd, march, cheer or bell sound exists |
| Audio debug | Voice levels and mutes | L (`?audio=1`) | `src/ui/audio-debug.ts` | — | — |

## 12. Saving

| What | Where | Entry point |
|---|---|---|
| Land regions (edits) | World store (IndexedDB, worker) | `src/world/region-store.ts`; `scenes/streamer/store.ts` |
| A town's edit log (claims, stages, wall, works) | Store key `town:x,y` | `citygen/townlog.ts: TownLogs.save, load` |
| The season's ledger (default town game) | Store key `season:x,y` | `scenes/level/season.ts` (`persist`, `restore`) |
| The world's facts and the run (loop) | Store key `realm:world` | `scenes/level/loop.ts`; `api/snapshot-delta.ts` |
| The mutation list and signs | Store, via `changed` | `scenes/level/mutators.ts`; `MutateEngine.record, restore` |
| Warmed world snapshot | IndexedDB | `src/sim/warm-cache.ts`; `sim/snapshot.ts` |
| Clear everything | `&fresh=1` | `src/fresh-start.ts` |

## 13. Card table, bots and packs (branch `card-table`; docs/design/CARD_TABLE.md, docs/design/PACK_FORMAT.md)

The same run as the 3D loop with no world, no GPU and no canvas: one model (`Realm`), two front ends.

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Table driver | Plays a run on the `Realm` with no scene: offers, take, pass, cast, end season, next run; live events told to the Realm as they would end with nobody playing (`mechState`) and resolved by `Realm.finishLive`; save and resume; records the moves | W | `src/table/game.ts: Table, replay, TableSave` | `new Table({ seed, leader, seasons, packs, raiders, resume })`; `t.cards()`; `t.take(id)`; `t.liveEvents()`; `t.abilities()`; `t.cast(id, target)`; `t.rules()`; `t.things()`; `t.endSeason()`; `t.save()` | Briar Hollow test world; sites on an invented ring (CT-17); invented cast numbers (CT-16) |
| Table page | Header with six pools and the threat; live events as cards (who is in it, casts, the rules that apply, the predicted result, what a result will set off); offers as readable cards; ability row (Fire, Rain, Growth rune, Heat ray, pack abilities) with targets; the Rules list (paid with its why, ready, or the one thing missing; tags in play); things in play by place; the log, with chains read as chains; packs drawer (several, add and take out); Laws in force (what, who made it, how long); a card's laws and what they would change, its printed cost struck beside the cost in force; rules changed by a law marked; "Settle it now" on each event | W | `table.html`, `src/table/main.ts`, words in `src/table/words.ts` | `npm run dev` then `/table.html?seed=7&leader=ysolt&seasons=16&pack=/packs/arena.json,/packs/sample.json&open=rules`; console `table()` | No save button on the page (`Table.save` exists) |
| Bots | Twelve policies (a loop hunter and a law hunter settle events they win and play the next step in the same season) play whole runs; the biggest firing, laws made and runs won by a law, loops' cost turn by turn; ends, pool curves, what is left unspent, Magic cast, idle workers, rules fired and never fired, live events by result, cards never taken, threats that ran out; with packs, each pack card's runs on a board and taken and the distinct cards its template made (one per binding), the endings named, the far places at the end | W | `src/table/bots.ts: POLICIES, playRun, runBots`; `test/unit/table-bots.test.ts` | `node scripts/tablebots.mjs [--seeds n] [--seasons n] [--pack a.json,b.json] [--raiders n]` | About 2 s a 16-season run; seeds do not vary the deal (CT-3) |
| Pack validator | Each pack checked against the engine's words, then the set TOGETHER; problems in plain words for an outside author; chains that come back to themselves | W | `src/packs/check.ts: checkPack, checkTogether, chainCycles, eventTrigger, reportText` (no run-time imports) | `node scripts/packcheck.mjs a.json b.json` | Numbers written as words are not checked |
| Rules that chain | A rule may act: offer a card, start a live card, tag the thing it matched, make a law; a rule may wait for a live event's result (`tier`); a rule may fire several times on one trigger (`fires`); engines unbounded, a cascade per player action or season, a defect detector at 10,000 firings | W | `src/living/rules.ts: RuleAct, CASCADE_LIMIT, RuleBook.preview / check`; `src/season/realm.ts: act, asked, predictLive` | a rule `{ on: { live: 'bout', tier: ['success'] }, effect: { start: 'card-id' } }`; example `packs/arena.json` | Only a pack's card can be offered or started (CT-27) |
| Settle it now | The player ends a live event at once with the casts made so far (one move): its result, its rules and the card a rule starts come at once, so a chain's steps can all be in one season | W | `src/season/realm.ts: Realm.resolveNow`; `src/table/game.ts: Table.resolveNow` (move `resolve <template>`) | `t.resolveNow(eventId)` | No action budget at the table: a settle is a move whose cost is the casts it needed |
| Places on the world map | Far place selectors for pack effects (every far town, the n nearest standing, by state, a place the pack founded, the world), nearest first; signs anywhere; trade routes by effect or by a policy thing (on top of the trade road's 3 nearest, LS-68); a card whose selector names nothing does not appear | W | `src/season/realm.ts: selectTowns`, helpers `eachTown`, `townsExist`, `trade`, `RealmOptions.extra.tradeThings`; `src/packs/load.ts: isSelector, tradeThings` | `{ "sign": "darkness", "where": "far:all", "seasons": 3 }`; `test/unit/places.test.ts` | The table shows a far town's state and partner tag in "Far places"; the darkness over a far town, abandoned towns and new trade lines are drawn only on the 3D map. `arrive` from a selector not built |
| Endings and the record | An effect or rule act `end_run` ends the run at once (won, fell, or named); `far_all` changes every far town; the record of resolved and lapsed cards (one fact event a card: `card-done:<tier>` / `card-lapsed`, `about.thing` the template, `to` its place) persists with the world and is read by later runs (`resolved` with tier / at / run, `remains-of-<tag>` on ruined things, a card's `laws_after`); the table lists it by place and run and says why a card is there | W | `src/season/realm.ts: recordOf, Realm.record, remember, endRun, ended, runNumber`; helpers `endRun`, `farAll`, `recordHas`; `src/table/game.ts: Table.record, because` | `packs/glitter.json`; `test/unit/record.test.ts` | The 3D loop must call nothing new: the record is written by the Realm. Leaders do not depend on the record yet |
| Laws | One ordered list of laws in force over the base definitions: tags (count as, grant, spare a ruin), rules (set, times, on/a/b, off, fires, a rule only while the law stands), cards (cost, pay from another pool, build, stay, a pool as Might), spells and events (kills/douses, also tag, allow, shift, foes, counts as), the run (board, income, raiders, a way to win), meta (multipliers, next law for the run). Sources: a thing (follows it), timed, the run. Saved with the run; every number shown follows them | W | `src/living/laws.ts` (pure); `src/season/realm.ts: enact, lawsInForce, laws, ruleView, terms, spellMech, won, refreshLaws, withLaws`; words `src/season/law-words.ts`; design `docs/design/LAWS.md` | a pack's `laws` block (PACK_FORMAT "laws"); `realm.enact('id', 'who')`; example `packs/laws.json` | The run's length cannot change by law yet (it is fixed when the Realm is made; no arc any more — CT-51); a law outlives the run only through a card's `laws_after` (ended between runs by `law_ends`); the 3D game does not draw the list yet |
| Pack loader | Cards to `TemplateDef` on the existing helpers plus eight `pack*` helpers; things, tags, abilities; rules carried as `RuleDef` | W (every block is played at the table) | `src/packs/load.ts: loadPack, linkPacks, liveDef, packHelpers, withPackThings, packMech, castAbility, effectsText` | `new Realm({ …, extra: { templates, helpers: packHelpers(packs, host), rules, things } })` | The 3D game does not load packs; CT-23 |
| Factions and templates (draft 7) | A pack's factions are fact entities; stances are the fact layer's war / truce / alliance relations; a faction holds towns by the mutators' occupies / vassal_of / controls; places can be revealed (found, unsettled) and settled; a card's variables bind to every site, far place or faction that fits, the dealer picking; far towns and found places are things of the rules (`far-town`, state, `yours` or the faction, resource, `colony`); the record names what a card was bound to; the table's "Far places" reads as news | W | `src/packs/load.ts: varBinds, farThings, farHolder, stanceOf, seedFactions` and helpers `packFarIs`, `packFactionIs`, `packStance`, `packReveal`, `packFoundAt`, `packNotDone`; `src/season/realm.ts: askedOn`, `found` (by), `extra.seed`; `src/table/game.ts: Table.farNews` | `"bind": { "town": { "far": { "state": ["standing"] } } }` then `"where": "$town"`, `{town}`; `test/unit/factions.test.ts` | CT-45; the 3D map does not draw factions, havens or found places |
| Leaders and ages | A pack's leaders offered at a run's start while the world fits (the record, far places, factions), each with a start (pools, income, things, laws, cards out of the deck); a fitting leader that `replaces` hides the base three; `laws_after_if` (laws for later runs only when the card ended so); "The world now" lines at the run's start | W | `src/packs/load.ts: leaderFits, startThings`; `src/table/game.ts: Table.leaders, worldNow`; `src/season/realm.ts: extra.deckOut`, `recordLaws.results` | `Table.leaders(world, packs)`; `packs/ages.json`; `test/unit/ages.test.ts` | CT-50; round 10: the 3D game offers them too (`run-packs.ts leaderChoices`, `startLines` — one copy for both) |
| The raid as a card (draft 8) | No arc: the raiders are base data seeded once a world (entity, camp, hostile); their standing threat `pay-raiders` is a template dealt while they threaten (`raidersThreaten`), counting down to the season before the last; left to run out it makes the `raid` card forced in the last season (the live event unchanged); a run ends at its last season (`RUN_SEASONS`) or by `end_run` (`stood`: "The town stands"); the header is the standing threat's countdown | W | `src/season/realm-templates.ts: pay-raiders, RAIDERS_DEALT, RAIDERS_CAMP`; `src/season/realm.ts: raidersThreaten, standingThreat, over, helpers raidersThreaten / raidersStance / doneThisRun / beforeLastSeason / raid` | `realm.standingThreat()`; `realm.raidersThreaten()` | CT-52 |
| A run's home (draft 8) | A pack leader's `home` picks a far town (nearest that fits); the run is played from it with its own sites and things; the old home becomes a far town (yours); a town's buildings are kept on it (`built:<card>`) | W (table) | `src/packs/load.ts: homeOf, packThings(…, home)`; `src/table/game.ts: Table.home, movedFrom, BUILT, next`; `Realm.home` (a parameter already) | `"home": { "far": { "tags": ["yours"] } }`; `test/unit/home.test.ts` | CT-56 (FIXED-CITY list); round 10: the 3D loop opens the page on the run's home (section 4); `built:<card>`, `moveHome` in `season/realm-home.ts` |
| Between runs (draft 8) | One deterministic step as a new run of a world begins: base entries (truce lapses, raiders leave a dead world, signs fade unless `for_good`, ruins grow over) then the packs' `between_runs`; each a `between-runs` record line, "While you were gone" at the run's start; `law_ends` | W | `src/season/realm-between.ts: BASE_BETWEEN, BETWEEN, LAW_ENDED`; `src/season/realm.ts: betweenRuns` (private, from the constructor) | a pack's `between_runs`; `test/unit/between.test.ts` | Not run on resume (by design); CT-54 |
| Unlocks and met (draft 8) | `unlock` writes an `unlocked` record line; `locked` content (cards, leaders, `pack:<id>`) is dealt or offered only once unlocked in the world; `met` reads the record (faction, `place:`, `ending:`); "New for later runs" at the end, "Earlier runs opened" and "Not yet found" at the start | W | `src/packs/load.ts: OPENED, isOpen, openedIn, notYetFound, hasMet, contentName`, helpers `packOpen`, `packOpenFor`, `packMet`; `src/table/game.ts: opened, newForLater, worldNow` | `"locked": true, "hint": "…"`, `{ "unlock": "id" }`, `{ "met": "frontier-reavers" }`; `test/unit/unlocks.test.ts` | CT-58 |
| Realm: extra content | More templates, helpers, rules and things than the base game's; `onRules`, `raiders` | W | `src/season/realm.ts: RealmOptions.extra` | see above | A thing's tags lent to its place live in the loader, not the Realm (LS-75) |

## Recipes

Sizes: **S** under 3 h, **M** 3–8 h, **L** more. Builder hours, with unit tests and one phone check.

### 1. A parade — **M** (a first version), **L** (along a named street with townspeople gathering)

**Round 6: the first version is built** — `season/realm-events.ts` `PARADE_EVENT` (a column in by a road to the
market, watchers as a loose unit group, petals, the story camera). The gaps below stand (BACKLOG LS-64).
**Round 7:** the marchers walk loose (LS-76) with a gold ring each; watchers also stand along the entering road; a 6 s
finale at the end place; everyone walks off to the muster after; the day held. Still the shortest way, not a street (LS-77).

`march` and `formation` are implemented on the GPU (`orders.wgsl: formAnchor, formSlots`), tested
(`test/gpu/formations.test.ts`) and used in the game (drill, gate lines, the patrol).

Existing calls:
- Marchers: `g = units.spawnAt('soldier', faction, { town, place: PLACE.barracks, else: { town, place: PLACE.muster } }, n)`.
- The walk: `units.orderGroup(g, { kind: 'go', at: { town, place: PLACE.market }, formation: 'column', discipline: 1 })`.
  A temple or square: `{ town, district, kind: 4 /* landmark */ or 3 /* plaza */, rank: 0 }`.
- The end: `units.arrived.push((g) => …)`. Failure: `units.orderFailed`.
- Camera: `units.observe(units.members(g))`, then `cam.look(at, { zoom })` and `cam.follow(mid)` — copy
  `loop.ts` `playDead`'s `mid`.
- Petals or dust: `worldApi.fx.burst('petals', x, y, z)`.

Gaps:
- A `go` in formation walks the group's own field: the shortest walkable way, not a chosen arterial. `march` follows
  a street route but only outward through a gate. A parade *in* along an arterial, or along a chosen street to a
  place, needs a route argument or a reverse flag in `orders.wgsl` (`pathAt`, `formAnchor`) and in `SquadOrder`.
- Townspeople cannot gather: riders have fixed jobs and 8 fixed hubs. Cheap stand-in: a few loose groups of
  `'worker'` units sent with `go` to plaza or park lots along the way (each costs an order group and a field).
  Proper: a ninth hub (an event point in the parameters) that a share of commuters ride to and wait at — WGSL in
  `citylife/routes.wgsl`.
- No temple as a named place; no crowd or music sound.
- `TownForces` knows soldier and raider only; call `scene.units` directly or widen `ForceKind`.

### 2. Refugees walking in and camping by the gate — **M** (column and a camp mark), **L** (tents people live in)

**Round 6: the column is built** — `REFUGEE_EVENT` (people and carts in by a road, forced when a far town falls);
the camp is a thing of the fact world (`camp:<home>`), with no tents on the ground yet (BACKLOG LS-67).

Existing calls:
- The fact: `{ helper: 'refugeeCohort', args: ['$town', '$town'] }` and the `migrate` effect; `Realm.life()` already
  turns each `migration` event into +40 commuters and +10 wagons that season.
- A visible column on the raid's own path: `units.spawnAt('worker', f, { town, place: PLACE.spawn0 + k, also: {
  town, place: PLACE.gate0 + k } }, n)` then `orderGroup(g, { kind: 'go', at: { town, place: PLACE.gate0 + k },
  formation: 'column', discipline: 0.3 })`. `'cart'` is a unit kind with a model.
- Which road: arterial k is the k-th of `settlements.approachWays(homeId)`; `realm.ts: roadLook` frames it.
- Camera: as the raid's (`ROAD_ZOOM`, then follow).

Gaps:
- Nothing maps "the far place X" to arterial k (compare each way's end with X's position: small).
- No tents. `founded` with `size: 'camp'` makes a small generated village at its own site, not tents by the gate.
  Smallest honest version: a land mark like the burial ground (`mutate/list.ts: LandMark, GPU_GRAVES`,
  `land.wgsl` `MUT_GRAVES`) — a new op that writes tent-shaped voxels on open ground, derived from a fact and
  removed with it. Tents as lots with residents is new town work.
- The walkers do not become residents: remove the group on `arrived` and raise `people.commuters` (already done by
  `Realm.life`).

### 3. Fewer wagons and boats because a far place was destroyed — **S**

**Round 6: built** — `Realm.partners()` and `Realm.life().trade`; the season's news says when a partner is gone.

Existing calls: the whole chain exists for one case. `guard-camp` expiring runs `mutate destroyed copper-hollow`;
`Realm.life()` then drops the camp's 14 wagons; `startRunLoop`'s `life:` hook feeds
`LIVING_TUNING.set('people.wagons', n)` each season (`scenes/level/season.ts`). Ships: `people.ships`.

To generalise: in `Realm.life()` count trade partners that still stand (`mutators.place(id).status`, or the fact
tags) and scale `wagons` and `ships`. Add the line to the season's news.

Gaps: one number per town — a wagon is not "from" a place and does not pick that place's gate. A reason the player
can see needs that news line or a marker.

### 4. A fire or riot as a real-time crisis that ends by itself at season end — **M** each, on the existing event shell

**Round 6: the fire is written but does not burn in the town and is not dealt (BACKLOG LS-63)** — `FIRE_EVENT` on
the runner; a riot is data to write (a hostile loose group at the
market, squads as `from: 'squads'`).

Existing calls:
- The card with a deadline and an automatic result: `TemplateDef` with `threat: true`, `offerTurns`, `onExpire`,
  `expireText`. `LivingEngine.advance()` fires it at season end. This is how every hazard ends today.
- The live part: `loop.ts: Game.playDead` (spawn, observe, camera, spell armed, timer, `endEvent(won)` → the
  template's outcome). It is hard-wired to template id `DEAD_RISE` (`loop.ts` ~line 670).
- Fire: `worldApi.fire.ignite(x, y, { radius, intensity })` starts the real fire system; the committed result is
  `{ helper: 'mutateAt', args: ['burned', '$site', r, 1] }` (lot condition burned). Rain to fight it:
  `weather.spawn(x, y)`; `water.flood`.
- Riot: a hostile loose group — `spawnAt('raider'…)` or workers given `{ kind: 'attack', at }` — at the market;
  squads `guard` there in a line; the result into `pool unrest`, `sign crime`.

Gaps:
- `playDead` must be made general (see recipe 6) before a second event is added; otherwise it is copied a third time.
- Whether the fire system burns citygen's buildings (meshes claimed as external intervals) is not verified. If it
  does not, the live fire is particles (`fx.burst('flame' | 'smoke')`) plus the instant `burned` at the end.
- Fire the spell does not ignite or douse; no rain spell in the loop's spell bar (`SpellId` has two).
- A riot crowd of *townspeople* is not possible with riders; it is a unit group.

### 5. A crowd / "Awe" count without a per-frame readback — **S** for units, **M** including townspeople

Existing calls:
- Units of a group at a place: the GPU already counts them (`orders.wgsl: groupCount`) and tells `arrived(g)` once.
- Units near a point: `agents.arrivals(field, radius, leave)` makes the GPU emit one `arrived` event per unit that
  comes within the radius; the events ride the sync the units already do. Count them on the CPU. No new read.
- One-off: `await units.query([x, y], r)` — two small async reads, on demand (use at the event's end, not per frame).

Gaps:
- Riders (the townspeople) are invisible to all of the above. They have atomic counters on the GPU (`living.ts: C`,
  `routes.wgsl: bump`) read 640 bytes at a time by `LivingTown.counters()` when asked. Add a counter "riders within
  r of the event point" (point and radius in the parameter block), read once when the event ends. WGSL + one test.
- There is no "left the radius" event, so the unit count is visits, not people present now.

### 6. One live-event system for raids, parades, riots and fires — **L** to unify fully; **M** for the runner with the raid left as it is

**Round 6: built, the raid on it** — section 3b. What follows is how it was before (kept for the reasoning).

How the raid runs today (all raid-only code):
1. The arc's last stage runs the `raid` helper (`realm-templates.ts: raidArc` → `Realm.raid = n`).
2. `SeasonWar.season()` sends squads to posts (`war.ts`: `Post` kinds yard, heart, gate, man, patrol).
3. `loop.ts` points the camera down a road, waits `PLACE_SETTLE_FRAMES`, calls `war.call(n, road, direct)`:
   `forces.spawnAt('raider', …, spawn point also gate)` and `orderGroup(g, { kind: 'attack', at })`.
4. `loop.ts watchFight` ends it on: no raider alive, no soldier for `SACK_SECONDS`, or `ATTACK_SECONDS`.
5. `loop.ts endAttack` → `SeasonWar.resolve` (`war.ts: settle`: Might, Materials, Unrest) → `Realm.fought`: a fact
   event `raid-held` or `raid-broke`, the gate district `burned`, a `crime` sign.
6. Spells: `Game.castAt` → `units.strike` + a lightning look. The live units' counts decide the result.

The other live thing, the dead: `Game.playDead` — its own spawn, camera, timer and ending, tied to one template id.

Event-like things elsewhere:
- **The template engine already has most of the shape.** `TemplateDef`: a place (`at`), who is needed (`requires`),
  a deadline (`offerTurns`), an automatic result (`onExpire`), a committed result (`outcome` / tiered `outcomes`),
  `threat`. It also has `play: { area, forced, climax }` and the contract has `Challenge { encounter, system, play,
  area, minutes }` (`opportunity.ts`): "what is played when the player is committed". Only the horde run uses them.
- `ArcDef`: effects at fixed turns. A schedule, not an event.
- `runsit` (`api/contracts/situation.ts: Situation`; `runsit/state.ts`, `area.ts`, `finale.ts`): a clock, a route,
  areas played live, pure rules (`FinaleRules`) with a live half, endings applied to the world. The right split
  (pure rules + live playback + committed ending) but built round a hero walking between areas; not reusable as is.
- `living/horde.ts: HordeStage`: the horde run's conflict as template helpers. Hero mode only.
- Town moods, festivals, riots: nothing built. `src/gm`: validators and a story file server; no runtime events.

The smallest common shape — extend `TemplateDef.play`, do not add a system:
```
play: {
  groups: [{ id, kind, faction, n, from: PlaceRef, order: SquadOrder, tags?: string[] }],
  hazard?: { kind: 'fire', at: Ref, radius },
  camera: 'groups' | Ref,
  seconds: number,                                  // wall time; at season end it resolves by itself
  spells?: SpellId[],
  ends: [{ when: 'dead' | 'arrived' | 'timeout', group?, tier: Tier }]
}
```
and one runner in `scenes/level` made from `playDead` + `watchFight`: spawn the groups through `TownForces`, observe
them, `StoryCamera.look` / `follow`, arm the listed spells, wait for `arrived` / `died` / the timer, then resolve
the commitment at the tier the `ends` row names — so every result is the template's own `outcomes`.

| Piece | Fits already | Raid-only today |
|---|---|---|
| Definition, deadline, automatic result | `TemplateDef` (`threat`, `offerTurns`, `onExpire`, `outcomes`) | The raid is an arc stage + `Realm.raid`, not a template |
| Participants and orders | `Units.spawnAt` / `orderGroup`, `PlaceRef`, `SquadOrder` — plain data | `TownForces` `ForceKind`; `SeasonWar` posts, patrol, wave |
| Live playback | — (two hand-written copies) | `watchFight`, `endAttack`, `war.call` one road at a time |
| Camera | `StoryCamera` | the zoom constants in `loop.ts` |
| Player actions | `Game.arm` / `castAt` | spell allowed by phase name (`attack`, `event`) |
| Result | `LivingEngine` resolve by tier; effects | `war.ts: settle`; `Realm.fought` (burn the gate district, crime sign) |

Also open: LOOP_SKELETON.md asks that the result be a pure rule and the playback only show it. A shared runner is
the place to do that once.

### 7. Tags and synergies as data — **M** for a rule table on the fact layer

**Round 6: built** — section 3b (`living/rules.ts`, `season/realm-rules.ts`).

What exists:
- Fact layer: scoped tags on any entity (`facts.ts: TagScope` — biology, custom, economy, government, law, culture,
  capability, condition), intensities (support, unrest, enforcement, prosperity, piety, fear), quantities,
  relations, events. Entity kinds include `building`, `site`, `unit`, `army`, `relic`.
- Template language: `Pred` (tag, intensity, qty, rel, event within N turns, trait, any / all / not) and `Effect`
  (`forEach { kind, where } do`, `when … do … else`, helpers such as `pool`).
- Bonuses: `opportunity.ts: Bonus { on: Trigger, themes, effect, holder | building, charges, cooldown }`. Triggers:
  dealt, expiring, commit, resolve, turn, threat, agent-lost. `LivingEngine.advance` fires `'turn'` + `gain`.
- Dealer: a `synergy` score part, a number a template supplies. `opps/deck.ts: DeckRun.synergy` computes one from
  themes against held tags — card lab only. Kingdom stacks (`opps/kingdom.ts`) — card lab only.
- Unit traits on the GPU: `traits.ts: INTRINSIC, STATUSES, EffectSpec, TraitModule`; opportunity-scale trait rules
  `living/traits.ts: TRAIT_RULES, crewTurns`.
- Towns: `LOT_KIND`, district purposes, the lot condition word — GPU side, not tags.
- `api/contracts/recipe.ts` + `compose.ts` (Tag, TagQuery, Kind, Recipe, CapabilityRule, `derive`, `plan`): pure
  functions with no importer. Designed, unused.

Can "when X with tag A happens near/in Y with tag B, give N of R up to C" be written as data today? **No.** Close:
- "Each season, for each entity with tag A in town Y, +N of R": yes — an `ArcDef` stage's `each` with
  `{ forEach: { as, kind, where: [{ tag }, { rel }] }, do: [{ helper: 'pool', args: [R, N] }] }`.
- "Each season +N while the building is held, at most once every k seasons": yes — a `Bonus` (`on: 'turn'`,
  `effect: gain`, `cooldown`).

Missing: a trigger on a fact event (nothing subscribes to `facts.record`); "near" (no distance predicate, only
relations and `FactLocation`); a capacity on the amount; a per-season cap separate from cooldown; amounts from the
live sim (a crowd count).

Smallest addition (pure TS, Node unit tests):
```
RuleDef { id, on: <FactEvent.kind> | 'turn',
          where: Pred[],                      // over $event.by / $event.to and their tags
          count?: { kind, where: Pred[] },     // how many things match (tags, place)
          gain: { pool, per, cap },
          limit?: { perSeason } }
```
evaluated in one place: after `facts.record` and in `LivingEngine.advance`. Reuse `dsl.ts: holds`, `enumerate`,
the `pool` helper and `Bonus`'s charges / cooldown bookkeeping. Add one predicate `{ near: [Ref, Ref, cells] }` from
`FactLocation.at`. A live event (recipe 6) reports its crowd count as a number on the fact event it records.

## Docs the code contradicts

- `api/contracts/units.ts` header: "Implementations: `SimpleUnits` … for now; the GPU agents to implement it next."
  `AgentUnits` is the implementation in the game.
- `api/contracts/orders.ts` (`Order`) has follow / hold / go / release only. `march`, `drill`, `man` and formations
  are `SquadOrder` in `units.ts`.
- `LOOP_SKELETON.md` assumption 5 says the 17 sites sit on "a stand-in ring". `season/sites.ts: placeSites` places
  them on real ground (gate on its road, waterside on a bank).
- `orders.wgsl` header lists order kinds 0–4 and formations "0 none, 1 column, 2 line"; the code has kinds to 7
  (drill, man, march) and formation 3 (loose).
- `SEASON_LOOP.md` "Town moods" lists a parade as waiting on "Track B's march". The march exists.
- `docs/STATUS.md` is dated 2026-10-07 (round 3) and describes the valley game only.
- `CLAUDE.md` layout lists the original valley modules; it does not mention citygen, citylife, living, season,
  mutate or towncontracts.
- This file's older part (below) describes round 83's system map; its unit and settlement rows predate all of the
  above.

## Not verified

- Nothing was run: no game, no test, no browser. "Wired" is read from call paths.
- (round 6: the fire system does not burn citygen's buildings — its fuel is what lies on top of a column. Whether
  anything at all burns in the loop's town is NOT verified: a probe read no fire and no laid material, LS-63.)
- How wagons and ships choose a gate or quay; what they look like at play zoom.
- That `spawnAt` with `'worker'` or `'cart'` behaves well under formation orders (the mapping exists in
  `AgentUnits.kindOf`; only soldiers and raiders are exercised by the game and the tests read).
- The number of order groups on the phone (`Agents.orderGroups` is computed from a byte budget; at least 8).
- Whether the traits slice (`registerSlice`) changes anything visible in the loop.
- `?flow=1` and lava on the atlas town level.
- Render, atlas, physics, solver, structures and terrain internals were listed, not read.
- Line numbers in `scenes/level/loop.ts` are approximate: another builder was editing it during this stock-take.
- `docs/DEVLOG.md`, `DECISIONS.md`, `BACKLOG.md`, and several design docs (RUN_LOOP, CITYGEN, FACTIONS_WORLD_STATE,
  OPPORTUNITY_CATALOG, STRATEGIC_MAP, PLAY_MODES) were skimmed by headings or not read; the sheet rests on code.

---

# Earlier map (kept): Systems — the legacy-game engine, each behind its API (round 83)

The user (DECISIONS round 83):
- "I would rather orchestrate and plan these systems in parallel and abstract them behind an API so we can
  iterate and improve them all across multiple sessions."
- "Fixing the performance and quality of the fluid simulation or destruction shouldn't fundamentally matter to
  dialogue or the atlas updates. It should only improve the believability and performance."

**What it's for.** An engine for legacy games: roguelike runs where death is always possible, and where the
player's choices leave lasting, visible marks on the world. "All that matters is the illusion of a living
world": take every shortcut that keeps it fast and more compelling.

This doc is the map. Each system has:
- **an owner:** one session or branch at a time;
- **an API:** what other systems may call;
- **events:** what it publishes;
- **contract data:** what it reads and writes.

Anything not on its API is private: a system may rewrite its insides freely, as long as the API holds. The
world API's rules (docs/WORLD_API.md) apply to every system here:
- installed on its own;
- queries answered from a mirror;
- commands queued inside;
- events out;
- private insides.

## What the simulation is for (round 110)

The user, verbatim (DECISIONS round 110):
  "The destruction and erosion and flooding and wind and particles are all there to make the world react on screen
  to the player and make it feel more alive. For that matter the agents doing work are similar. These are visible to
  the player and they make interaction fun so they are important to get right and they have the highest latency
  concerns."
  "The weather, growth, erosion etc. are useful layers for generating cool locations and for mutating the map between
  runs or in response to major gameplay events. They typically should operate at the alas level unless a player
  interacts directly (summoning plants or winds or a storm). The API should expose this so we can do things like show
  the player the town they planned get built but agents and overgrown with green. Generally though we want systems
  sleeping otherwise."
  "The greatest strength of what we have built so far is how interactive it feels and how varied and cool the
  terrain is compared with other games (and I have many ideas to improve it further)"

**The strengths to protect:** how interactive the world feels, and how varied and striking the terrain is. Work is
weighed by what it does for those two.

**Two jobs, two budgets.**

| | Reactive | Generative |
|---|---|---|
| What | destruction, collapse, flooding, wind gusts, particles (dust, spray, debris), agents working | weather and climate, growth and overgrowth, rain and wind erosion, settlement growth |
| Why | the world visibly reacts to the player; interaction is fun | cool locations; the map changes between runs or on major events (legacy) |
| Scale | play, near the player | atlas (between runs, story events); arrival realises the result |
| Priority | latency first: wake at once, finish within frames, the frame budget's first claim | throughput; behind a loading beat or offline |
| Live when | the player or an event touches it; then settles and freezes as an animation | only where the player invokes it directly (summoned plants, winds, a storm) or the game asks through the API |

**Everything else sleeps.** Steady states are frozen and drawn as animation (held rivers, frozen flow); visuals
(rain falling, dust blowing, water moving) stay alive over a map that isn't changing.

**The showcase.** The API can play a generative change on screen, sped up, as an event: the town the player
planned, built by agents and then overgrown. The same bake that runs between runs, shown over a short sequence,
reactive visuals (dust, building, growth) included.

**Towns grow slowly, as stored progress** (the user, round 110: "towns should visibly grow but slowly"). A town's
growth field picks planned tiles; each tile keeps its build progress. Watched, agents haul to it and build it bit
by bit (reactive). Unwatched, the progress advances by rate × elapsed time with no agent simulated, and arrival
realises what was completed meanwhile (BACKLOG ST18).

**Today** (contracts): `SimTiers` (src/api/contracts/simtiers.ts) holds rain erosion, wind erosion and growth baked
in play, `live(processes, rect)` for a player's direct invocation, `bake(rect|'all', …)` over the window only.
Missing: the atlas-scale bake per region (SM4), the showcase (a bake shown over time), latency priority for the
reactive systems' wake (the frame budget's first claim).

## Three time scales

Every change to the world happens at one of these. A system says which it works at.

| Scale | When | Cost budget | Examples |
|---|---|---|---|
| **Atlas** | between runs; when a story event fires | seconds, offline or behind a loading beat | a region sinks into the sea; a volcano buries a city in ash; a forest overgrows ruins; freezing; an ever-storm; eternal shadow; the dead rise; a faction turns hostile |
| **Arrival** | land streams in | a few ms a region, spread over frames | the region's state realised in its columns, already settled (rivers flowing at their dryness, ash in layers, ice on the lake) |
| **Play** | near the player, as things happen | the frame budget (phone: 16 ms) | collapse, floods, fire, dust in the wind, agents digging; simulated only while out of steady state, then frozen as an animation |

Rule: work happens at the slowest scale that still looks right. Erosion, regrowth and weather over time are
atlas-scale (computed once, per event or between runs); play-scale simulation is only what the player is
there to see react.

## The systems

Each entry: status (✓ built, ◐ partly, ○ not started), owner branch, API sketch, events, contract data.

### 1. World state (atlas scale) ◐ — branch `places`
The persistent world between runs: the atlas, its regions, and each region's state.
- **Has:** the atlas (generation, rivers, lakes — round 90, `Atlas.lakes`, contracts/world.ts `Lake`: a filled
  hollow at its spill height, like a flood with a level, `lakeFlood` — sites, roads, the coarse world: craters,
  ash, set lava). Region
  state isn't a first-class record yet.
- **API:**
  - `world.region(id) → RegionState`
  - `world.apply(event: AtlasEvent)`
  - `world.history(region?) → AtlasEvent[]`
  - `world.save() / load()`
- **RegionState** (the contract every generator reads):
  - `sunk` (0..1, under the sea);
  - `ash` (cells);
  - `overgrowth` (0..1);
  - `frozen` (0..1);
  - `storm` (kind, strength);
  - `shadow` (0..1);
  - `undead` (0..1);
  - `factions` (id → attitude);
  - `ruin` (0..1);
  - `flooded` (level);
  - `wetness` (dryness for rivers);
  - `era` / `style`;
  - `marks` (named things the story left: a statue, a grave, a crater named for someone).
- **AtlasEvent:**
  - `{ kind, regions | area, magnitude, at (run/time), cause (story id | player | world) }`
  - Kinds: sink, raise, bury(ash/sand), overgrow, freeze, thaw, storm, shadow, raise-dead, faction-attitude,
    flood, drain, burn, ruin, rebuild, mark.
  - Applying one changes RegionState (and the coarse world where it has a shape: a crater, a lava field).
- **Events out:** `region-changed(id, before, after)`, which the overmap and generators listen to.

### 2. Overmap ◐ — branch `places`
The fantasy map: travel between places; shows the world's history.
- **Has:** atlas-map.ts (the map), warping.
- **API:**
  - `overmap.show(state)`
  - `overmap.travel(from, to) → Journey` (time passes; encounters roll)
  - `overmap.poi(regionId) → Place[]`
- **Reads:** RegionState (styles the map: sunk is sea, ash is grey, overgrowth is green, frozen is white,
  storm is a swirl, shadow is dark, factions as banners).

### 3. Region generation (arrival scale) ◐ — branch `places` (generators: `atlas`, `rivers`)
Turns a region's ground plus its state plus a brief into columns, settled.
- **Has:**
  - the atlas column generator (forms, caves, ways);
  - places plans (docs/PLACES.md: voronoi, bands, boxes, rooms);
  - LOD rings;
  - the shore field.
- **Not yet:**
  - region briefs: rooms, paths, key/door layouts;
  - state realisation: ash, ice, overgrowth, ruin and flood applied from RegionState;
  - steady-state rivers. Branch `rivers`: the atlas's watersheds, discharge as a function of dryness, flow
    render-only.
- **API:**
  - `generator.brief(regionId, RegionState, storyHooks) → RegionBrief`
    - `RegionBrief`: rooms, connections, locks and keys, landmarks, spawns (unit kinds and counts by room),
      items, hazards.
  - `generator.columns(rect, brief) → columns` (settled: steady state within tolerance)
  - `generator.places(brief) → Place[]` (docs/PLACES.md)
- **Contract:** the window's layers (world/layout.ts), `core.places`, spawn lists for 6 and 7.

### 4. Simulation (play scale) ◐ — branches `places`, `flow`, `perfopt`
Everything that makes the local world react. Its quality and cost are its own business.
- **Has:**
  - terrain edits (the world API);
  - solids: integrity bodies, rock by columns;
  - water, oil and lava pipes;
  - loose ground (sediment);
  - fire;
  - wind;
  - weather and day/night;
  - sleep;
  - the shore field.
- **In progress:** branch `flow`, one interval flow for liquids and loose ground: Noita-simple rules in column
  space with velocity, arcing falls, near-steady state frozen as animation, frozen flux rescaled as supply
  changes.
- **API:** the world API (docs/WORLD_API.md), plus:
  - `sim.perturb(x, y, r)` (wake: something happened here)
  - `sim.settled(rect) → boolean` (near steady state: frozen)
  - `sim.freezeTolerance` (tuning)
  - `sim.queries`: height, floor, material, water depth, flow at
- **Events out:**
  - `collapsed(where, mass)`
  - `flooded(where)`
  - `burned(where)`
  - `settled(where)`

  The story and agents listen; they don't read buffers.
- **Rule:** nothing outside reads its buffers or depends on how it computes. The fluid and destruction work
  improves believability and performance only.

### 5. Rendering and camera ◐ — branches `places`, `perfopt`, `ceiling`
- **Has:**
  - the deferred terrain, LOD rings and far land;
  - the shore swell;
  - gems;
  - the phone tier;
  - the camera: fixed view, puck, slice, orbit (with `prefer`), dither, fly.
- **API:**
  - `camera.mode(...)`
  - `cut.slice / orbit / dither` (api/cutaway.ts)
  - `renderer.quality`
  - `renderer.windowMoved`
- **Reads:** sim fields through contract buffers only.

### 6. Units and agents ◐ — branch `agents` (and the hoverbike session's heroes)
Units that walk, work, build, shape terrain, fight and flee.
- **Has:** docs/AGENTS.md (walkable surfaces from intervals, flow-field groups, jobs as fields; on `agents`).
- **Contract (round 88, `runstory`):** src/api/contracts/units.ts `Units` (spawn, query, order, hit, setHostile, watch actors; died / hurt / noticed); src/units/simple.ts `SimpleUnits` the CPU stand-in until the GPU agents implement it.
- **Has (round 88, `settlements`):** the `Units` contract (api/contracts/units.ts, runstory's) on the GPU agents
  (src/units/agent-units.ts); settlements' people on their rounds (quarry, fell, haul, build, farm, guard) and raids
  (src/settle/life.ts). Settlements themselves (system 12's data, realised at arrival by system 3's hook):
  `settlements.near(at, r)`, `settlement(id)`, `all()`, `live()`, `plan(id)`, `raid(id?)`; events `built`, `died`,
  `raided` (src/settle/settlements.ts; ARCHITECTURE.md "Settlements and units in play").
- **Not yet:** a unit generator (archetypes by role, faction and era); attitudes tied to factions; work that
  visibly shapes terrain in play (it goes through the world API's edits like any other).
- **API:**
  - `units.spawn(kind, at, faction)`
  - `units.order(group, job)` (job: dig, build, haul, fell, patrol, attack, flee)
  - `units.query(near)`
  - `unitgen.make(role, faction, era, seed) → UnitKind` (stats, model, abilities, voice for dialog)
- **Events out:**
  - `died(unit, cause)`
  - `built(what, where)`
  - `dug(where)`
  - `noticed(player)`
  - `attitude-changed`

### 7. Things: items, units, vehicles, buildings as compositions ◐ — `places` (round 85)
- **Has (contracts):** src/api/contracts/recipe.ts — kinds and tags, slots, recipes (assemble, craft, train,
  adapt, salvage), instances with parts, material, condition, owner, place and history; capability rules;
  civilization profiles (what a people uses, repairs, makes, understands); compose.ts `derive` and `plan`.
  One model for units, items, vehicles and buildings (DECISIONS round 85).
- **Diplomacy (contracts):** src/api/contracts/diplomacy.ts — interactions between factions and people,
  fading, for dialog; agreements beyond war and peace (trade, land and mineral rights, passage, tribute);
  opinions derived; MemoryDiplomacy.

### 7b. Items (generators) ○
- **API:**
  - `itemgen.make(kind, era, rarity, seed) → ItemKind`
  - `items.spawn(item, at)`
  - `inventory(owner)`
- **Keys:** keys are items bound to a brief's locks (system 3).
- **Events out:** `picked(item, by)`, `used(item, on)`.

### 8. Heroes and controllers ◐ — the hoverbike session (the contract and an on-foot hero: `runstory`)
- **Contract (round 88):** src/api/contracts/hero.ts `Hero`, `HeroController`; src/hero/walker.ts on foot, src/hero/touchpad.ts; how a hoverbike hero plugs in: docs/HEROES.md.
- **Has:** hero prototypes:
  - a flying lich;
  - a hoverbike knight;
  - a tank;
  - a mech;
  - a hookshot knight.
- **Also has:** touch controllers; the chase camera with `Orbit.prefer`.
- **API:**
  - `hero.role → { controller, abilities, camera preference }`
  - Abilities act on the world only through the world API, units and items.

### 9. Narrative / game master ◐ — branch `gm` (docs/GM.md); the storyteller work (separate project) behind an adapter
The GM writes objectives with triggers and outcomes from a persistent world wiki.
- **Has (round 84):**
  - the world wiki (src/gm/wiki.ts; `scripts/worldwiki.mjs`, the atlas cached in data/atlas/);
  - the GM's context (docs/GM.md);
  - the validator (src/gm/storycheck.ts, `scripts/storycheck.mjs`);
  - `GameMaster.brief(snapshot, player) → SessionStory` with `FileGM` serving data/stories/;
  - the first story (data/stories/the-bell-under-kaudru.json).
- **API (the adapter):**
  - `gm.brief(world snapshot, player record) → Objective[]`
    - Objective: text, trigger conditions on events from 4, 6 and 7, and outcomes:
      AtlasEvents for system 1, faction changes, items granted, units spawned.
  - `gm.react(event) → Beat?`
  - `gm.dialog(unit, context) → DialogNode`
- **Reads:**
  - the world wiki: RegionState, history, factions, marks;
  - the run log.
- **Writes:** only AtlasEvents and spawns, through their APIs.

### 10. Dialog ◐ — branch `dialog`
- **API:** `dialog.open(node)`, with choices, `onChoice → effects` (effects are the same outcomes as
  system 9: attitude, items, events). The UI is for phones first.
- **Has (round 83):** src/dialog/dialog.ts `DialogBox` (contracts/dialog.ts `Dialog`, plus `onNode`);
  story cameras in src/story/camera.ts (frame a speaker, reveal, follow); src/story/play.ts plays a
  SessionStory on a level over the world API (`?story=demo`). ARCHITECTURE.md "Dialog, the run and story
  cameras".

### 11. Run lifecycle ◐ — branch `dialog`
- **Has (round 83):** src/run/run.ts `StoryRun` (contracts/run.ts `Run`): objectives, conditions,
  outcomes (AtlasEvents applied to the WorldState), `end → RunRecord`; src/run/validate.ts checks a story;
  src/run/hud.ts the objective list. Not yet: `start(hero, at)`, `between(runs)`.
- **API:**
  - `run.start(hero, at)`
  - `run.end(cause)`: death, escape or objective done
  - `between(runs)`: apply queued AtlasEvents; advance the world (regrowth, erosion, weather, faction drift)
    at atlas scale, precomputed rather than simulated
  - `run.log`: what happened, for the GM and the overmap

### 12. Build mode (places editor) ◐ — sandbox editor, `builder`
- **Has:** the sandbox editor; the town grid (builder).
- **API:** `build.place(model | brief fragment, at)`, `build.save(place)`; the same data as system 3's
  briefs, so hand-made and generated places are one format.

## How the systems connect: events, not calls into insides

```
story (9) ──AtlasEvent──▶ world state (1) ──region-changed──▶ overmap (2), generation (3)
generation (3) ──columns, places, spawns──▶ sim (4), units (6), items (7)
sim (4) ──collapsed/flooded/burned──▶ story (9), units (6)
units (6) ──died/built/noticed──▶ story (9), run log (11)
run end (11) ──queued AtlasEvents──▶ world state (1)
```

## Working across sessions

- Each system has one owner at a time (a session or agent on a branch). It may change its insides freely;
  changing its API is a DECISIONS item, with every user of it listed.
- APIs land as TypeScript interfaces in `src/api/` before the implementation: callers code against the
  interface; a stub implementation lets them run before the real one exists.
- Each system ships a test that drives it through its API only, like scripts/worldapitest.mjs and
  atlasworldtest.mjs.
- `places` is the integration branch. Experiments go on their own branches (`flow`, `rivers`, `ceiling`,
  `perfopt`) behind URL flags, and merge back when they win.
- The headless browser and the GPU are shared: agents ask "main" for them.

## Order (the user, round 83)

The user: "get dialogue in and basic cameras so we have a way to communicate what is going on"; "a GM (for now
a subagent with GM context and tools) take the world state wiki and offline create a session story as data
that we can use to create the locations, dialogues, objectives and world effects"; "dialogue and settlements
first … agents that are workers or hostile … the settlements at least use the same data structure we plan
to expose to the city management game"; items, units and diplomacy are the user's ideas to talk through
first — "it will feel more cohesive if we have at least the first pass at the data structure for that in play
before creating heroes or their stories".

1. ✓ The contracts as types (`src/api/contracts/`): world.ts (RegionState, AtlasEvent, Faction,
   WorldSnapshot, WorldState), story.ts (SessionStory: locations, cast, dialogs, objectives, conditions,
   outcomes), dialog.ts, run.ts, settlement.ts (a DRAFT, for the user's ideas), and a reference
   MemoryWorldState (world-state.ts).
2. Dialog: the system that plays a DialogTree (phone-first UI, choices, effects through Outcome) and basic
   cameras to frame a talk and show what's happening (a cut to a speaker, a reveal of a world effect).
3. ◐ (round 84, `gm`) The GM: a subagent with the GM's context and tools reads a WorldSnapshot and writes a SessionStory (JSON),
   offline; a validator checks it against story.ts (every reference resolves).
4. ◐ (round 85) The data for items, units and diplomacy: recipe.ts, compose.ts, diplomacy.ts; settlements on
   overlay grids with buildings as things.
4. Settlements and agents: the settlement data (with the city game's needs), placed by the region generator,
   worked by agents (workers) and raided by hostile ones; items, units and diplomacy after the user's ideas.
5. Then heroes and their stories on top.
