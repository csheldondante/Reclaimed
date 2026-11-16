# SYSTEMS — master sheet of what is built (stock-take 2026-11-16, branch `loop-skeleton` at 611a6c3b; live events and rules added in round 6)

Read this before building anything. Every row was read from the code, not from the design docs. Nothing was run for
this sheet (no game, no tests, no browser): "wired" means the call path exists in the source.

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
| Formations | column (≤3 abreast), line (≤10), loose; rows squeeze where the way narrows; `discipline` 0..1 | W (line, column) | `units.ts: Formation, Drill`; `orders.wgsl: formAnchor, formSlots` | add `formation: 'column', discipline: 0.6` to a go / guard / attack order | Pace fixed at `FORM_SPEED` 2.0 cells/s; `'no-room'` if not one file fits |
| Drill | An anchor loops round a yard, soldiers hold slots | W | `SquadOrder` `drill`; `season/war.ts: SeasonWar.drill` | `orderGroup(g, { kind: 'drill', at, formation: 'column' })` | Stands formed if the loop does not fit |
| March | Column along gate slot k's route out of the town; `leave` drops them past the window and fires `left(g)` | W (the patrol) | `SquadOrder` `march`; `orders.wgsl` (`OK_MARCH`); `routeread.wgsl: gateRoute` | `orderGroup(g, { kind: 'march', town, gate })` | **Outward along a gate route only.** No march in, no march to a place, no arbitrary route id. One town's routes bound at a time (`'busy'`) |
| Man the walls | Posts along each wall-walk run, single file up the stairs | L (`?man=1`, `scripts/lab/townwalls.mjs`) | `SquadOrder` `man`; `orders.wgsl: manSeed`; `war.ts: SeasonWar.man` | `orderGroup(g, { kind: 'man', town, side })` | Off by default; up to 8 run fields |
| Town forces adapter | The season's one door to Units: groups, reports (alive, fallen), events by group | W | `src/season/forces.ts: TownForces` (`scene.townForces`) | `forces.spawnAt('soldier'|'raider'|'worker'|'cart', f, ref, n)`; `forces.report(g)` | `ForceKind`: soldier, raider, worker, cart (round 6) |
| Squads | Might → squads of 3; drill, gate guard, patrol | W | `src/season/war.ts: SeasonWar` (`window.war`) | `war.season(ledger)`; `war.squadGroups`; `war.settled()` | In the loop the raid is a live event (section 3b); `war.call` / `war.resolve` raid the default town game (`?loop` absent) only |
| Fighting | GPU picks targets, strikes, applies damage; fight rules by wall side and height | W | `src/agents/notice.ts`; `AgentUnits.fightRules`, `fightFlags` | `units.fightRules({ open: false })` | Line of sight and ranged units: D (`UNIT_MINDS_U2.md` §9f) |
| Area blow, hold, throw | Damage + shove over a disc; hold a unit in the air; throw it | W (strike) / L (hold, release: `src/play/heroes/lich.ts`) | `AgentUnits.strike`, `hold`, `release` | `units.strike({ at, radius, damage, push }, 'spell')` | `maxHeld` 8 |
| Unit query | Units within a radius, asked of the GPU (two small reads, async) | W | `Units.query`; `agents/reads.ts: UnitReads.near` | `await units.query([x,y], r, { hostile })` | On demand only; sees units, not riders |
| Arrival events | "Unit came within r of field's seeds", told once by the GPU | W | `agents/agents.ts: Agents.arrivals` | `agents.arrivals(field, radius, leave)` | No "left" event |
| Road riding for units | Units leave the flow field for a road graph, ride to a goal | L (no caller left after fortress mode was deleted) | `Agents.setRoads`, `setRoadGraph`, `ride`; `agents/roadgraph.ts`, `agents/ride.ts` | `agents.setRoadGraph(g)`; `agents.ride(group, goals)` | Not fed by citygen's streets today |
| Followers (hero orders) | follow / hold / go / release for recruited units | L (`?run=sit`, `?run=opps` hero modes) | `api/contracts/orders.ts: Followers`; `runsit/followers.ts: UnitFollowers` | `followers.recruit(units)`; `followers.order({ kind: 'follow' })` | Needs a leader actor (the hero) |
| Carry, pick up, throw items | A unit carries material, puts it down, throws it | L | `Agents.carry`, `pickUp`, `putDown`, `throwItem`, `toss` | `agents.carry(id, 'Stone', 0.35)` | — |
| Traits and effects | undead / living / fire_immune…; heal, raise, damage, status effects over a disc; GPU rule modules | W (installed; shamblers are undead) | `api/contracts/traits.ts: TraitsApi`; `src/traits/system.ts`; `game/traits/modules.ts: registerSlice` (`scene.traits`) | `traits.apply({ op: 'raise', at, radius, group })` | 8 statuses; no caller in the loop's own code |
| Townspeople (riders) | Commuters, farmers, quarrymen, woodcutters, builders walking streets on cached routes | W | `src/citylife/living.ts: LivingTown`; `citylife/routes.wgsl`; `citylife/towns.ts: LivingTowns` (`scene.livingTowns`) | Counts only: `LIVING_TUNING.set('people.commuters', n)` (`citylife/params.ts`) | Jobs fixed in WGSL (`J_*`, 8 hubs `H_*`); no "go there now"; no lanes or queueing; cannot be hit |
| Workers and construction | Builders go stores → a rising lot → work → back; quarry dug bench by bench; clearing felled to stumps; stockpiles | W | `citylife/works.ts: Works`; `works.wgsl`; `season/life.ts: townLife` | `SeasonHost.life` sets counts from the ledger each season | Builders carry no stone; pit lost when streamed land regenerates |
| Carts, wagons, ships | Stone and log carts; trade wagons in by a gate to a shop and out; ships to the harbour's quays | W (wagons, ships via cards `trade`, `harbour`) | `routes.wgsl` `J_STONE, J_LOGS, J_WAGON, J_SHIP`; `life.ts: LIFE` | `LIVING_TUNING.set('people.wagons', n)`; `'people.ships'` | One number per town; not tied to a far place or a named gate |
| Arrivals from the world | Refugees = +40 commuters per fallen town, +10 wagons that season; a camp's 14 ore wagons; the trade route's wagons and ships by the share of its far towns still standing (round 6) | W | `season/realm.ts: Realm.life, partners`; hook `scenes/level/loop.ts: startRunLoop` (`life:`) | Driven by `migration` events, the camp's facts, `partners()` | The column walking in is the live event `refugees-arrive` (section 3b); no tents on the ground |
| Agent work crews | Units that dig, haul and build a planned town block by block | L (sandbox town tool, `api/world.ts`) | `agents/crew.ts: Crew`; `agents/buildcrew.ts: BuildCrew`; `build/town.ts: Town` | `scenes/level/town-tools.ts: sendBuilders` | Older town system, not citygen's |
| Creatures with bodies | Rigged animals round the camera | L (`?life=1|dragon|town|viewer`) | `src/inhabitants/install.ts: installInhabitants` | — | Not in the loop |
| CPU units | A few dozen CPU-steered units | L (`story/hero-run.ts`) | `src/units/simple.ts: SimpleUnits` | — | Superseded by AgentUnits |

## 2. Towns

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Town generator | Arterials, bridges, streets, blocks, lots and mesh on the GPU from the live ground | W | `src/citygen/gpu.ts: CityGen`; `citygen/town.ts: FieldTown`; `citygen/towns.ts: FieldTowns` (`scene.fieldTowns`, `window.citygen`) | `towns.live.get(id)`; `towns.addSite(site)` | 4 towns live at once (`sim/static-claims.ts: OWN_SLOTS`) |
| Districts and stages | Claim a district by purpose (housing, market, harbour, workshops, farms, keep); raise it a share at a time | W | `api/contracts/citygen.ts: CityDistricts` | `await towns.claimDistrict('market')`; `towns.stageDistrict(town, id, stage)` | 6 purposes |
| Lots | Lot records, progress 0..1, condition word, all GPU buffers | W | `citygen.ts: CityLots`, `LOT_KIND` (building, park, plaza, landmark, field) | Read on the GPU only (`townplace.wgsl: lotAt, lotPlace`) | The CPU does not know lots |
| Lot conditions | drowned, burned, destroyed, buried, abandoned, occupied, overgrown, looted — tint, roof gone, height cut | W | `src/mutate/index.ts: LOT_CONDITION`; `mutate/gpu.ts: MutateGpu` | Via mutators (section 5) | Written by mutators only |
| Walls and gates | A ring with gates rising piece by piece; wall-walk and stairs | W (card `walls`) | `FieldTowns.wallStart`, `wallStage`; `citygen/wallshape.ts` (debug) | `towns.wallStart(town)`; `towns.wallStage(town, from, to)` | Walk passes through corner towers |
| Named places | muster, stores, barracks, market, keep, gate0..9, spawn0..7 per town, with status | W | `api/contracts/townplaces.ts: PLACE, PlaceRef`; `src/towncontracts/contracts.ts: TownContracts` (`scene.townContracts`) | `{ town: tc.townIndex(id), place: PLACE.market }` or `{ town, district, kind, rank }` | **No temple or square by name**: use a lot ref (kind 3 plaza, 4 landmark) |
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
| The game's templates | 11 town projects, mining outpost, tower lens, relieve neighbour, house refugees, guard camp, the dead, pay raiders, 4 hazards; the raid arc | W | `src/season/realm-templates.ts: WORLD_TEMPLATES, projectTemplate, raidArc` | Add a `TemplateDef` to `WORLD_TEMPLATES` | Threats come on a fixed share of the run (`after`), not from world state |
| Realm helpers | isHome, siteIs, canBuild, hasSpell, after, pool, income, spell, raid, avert, mutateAt, found; round 6: raidDue, live (vars), raidOver, mark, burnPoints, camp; `pool` and `mutateAt` take a live event's numbers and place | W | `src/season/realm.ts: Realm` (its `Stage` helpers) | `{ helper: 'mutateAt', args: ['burned', '$site', 30, 1] }` | Defined in a closure in `Realm`, not a shared registry |
| Dealer | Filters, tiers, scores (13 parts incl. synergy, stakes, urgency), deals within limits, explains every choice | W | `src/opps/dealer.ts: deal, DealReport` | via `LivingEngine.deal`; tuning `opps/tune.ts: OPP_TUNE` | `synergy` is a number a template supplies; nothing computes it in the game |
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
| Live event as data | Who takes part (groups: kind, side, count, tags, where from, order with formation), a hazard, seconds, spells allowed, when it ends, how its result is read (counts by tag, lots burned, casts), worked out (`derive`) and mapped to a tier | W | `src/living/live.ts: LiveDef, LiveState, idleState, liveRead, liveDerive, liveTier, liveEnded, checkLive` | A template's `play: { area, forced?, event: LiveDef }`, `vars: 'live'`, tiered `outcomes` | Pure. Places: named places of the town, a road's spawn point or gate, a site. No route by street |
| The run's live events | The raid, the dead in the burial ground, a parade, refugees walking in (W); a fire at the market (S: written and unit-tested, not dealt — nothing catches in the town, LS-63) | W / S | `src/season/realm-events.ts: LIVE_TEMPLATES` | Add a `TemplateDef` with `play.event` | Numbers are first guesses (LS-66) |
| Resolving one | From the state it is in: numbers read → rules applied → derived → tier → the template's outcome through the engine; at the season's end by itself; in Node from the state nobody played | W | `season/realm.ts: Realm.finishLive, tellLive, liveRunning, forcedLive, playForced, runNumbers` | `realm.finishLive(offerId, told?)` | Who decides a fight: the live counts, then one line of arithmetic (LS-56, open) |
| The runner | Plays any `LiveDef` in the city: groups made by place, by site or in by a road (the camera down each road in turn); the hazard lit; story camera; sim speed on the march; counts from the units' own events; goes on while the player is elsewhere | W | `src/scenes/level/live-runner.ts: LiveRunner` (`rungame.liveDebug()`) | `runner.start(offer, def, site)`; `runner.told(run)`; `runner.close(run)` | One entering column a run; people vanish when it ends; a reload restarts only the raid (LS-65) |
| Hazard: fire | The real fire system lit at N spots (canvas put down at each); a spot alight 12 s is a burned lot; lots burned get the `burned` condition where they stand | S (not dealt: in the town the canvas is not laid and nothing reads alight — LS-63) | `live-runner.ts` (`hazard`); `realm.ts` helper `burnPoints` | `hazard: { kind: 'fire', at, points, spread, radius, intensity }` | Reads the fire mirror's pages (a few KB) every 2 s while a fire event runs. Generated buildings do not burn in the fire system (LS-63) |
| Tags | Each site's tags from what it is and its state; the home town's (wall, garrison, unrest); trade partners | W | `season/realm-rules.ts: SITE_TAGS, RUIN, TIMED`; `realm.ts: Realm.things, partners, mark` | `realm.things()` | Derived on demand from the fact layer and the ledger; sites only (lots are GPU-side) |
| Synergy rules | Trigger (season end, a fact event's kind, a live event's read) + tag queries with a relation of place (near the first thing, near the event, on its route, same town) + an effect on a pool or on one of the event's numbers (add, multiply) + capacity + firings a season; each firing recorded (`rule-fired`) and told in one line | W | `src/living/rules.ts: RuleDef, RuleBook`; the run's ten: `season/realm-rules.ts: RULES` | Add a `RuleDef` to `RULES` | A route is the straight way from start to end; no rule may write a fact another reads |
| Spells | Heat ray (a blow on units), Fire (a blow + the fire system lit), Rain (a storm over the tap), Growth rune (plants grown, the field `growth-active` for the season) | W | `scenes/level/loop.ts: Game.castAt`; `realm.ts: Realm.cast, SPELL_COST, BASIC_SPELLS` | `realm.cast('growth', 'fields')` | Aimed by a tap; a cast is a fact event (`spell-cast`) |

## 4. Season and run loop

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Pools | Magic, Might, Labor, Materials, Intel, Unrest as holdings; people locked, goods spent | W | `src/season/ledger.ts: POOLS, pools, grant, lose, commit, nextSeason` | `lose(ledger, { magic: 1 })`; `pools(ledger).unrest` | Unrest keeps that many workers away |
| Card catalog | The town's building cards and their chain | W | `src/season/catalog.ts: CATALOG, card` | — | Fixed list |
| Season loop | Start / undo cards, find land, Next season, stages played as a showcase | W | `src/season/loop.ts: SeasonLoop` (`window.season`) | `season.next()`; `season.setLedger(l)` | One town (FIXED-CITY) |
| Time-lapse | Steps applied at fractions of a timed showcase; districts rise on the towns' clock | W | `api/contracts/simtiers.ts: SimTiers.showcase`; `src/sim/tiers.ts: Tiers`; `FieldTowns.timelapse` | `tiers.showcase(steps, { seconds })` | — |
| The realm (a run) | Joins the engine to the ledger: offers, commit, end of season, raid due, spells, history | W | `src/season/realm.ts: Realm` (`rungame.realm`) | `realm.offers()`; `realm.commit(id)`; `realm.endSeason()`; `realm.fought(f, at)` | 16 seasons; one arc |
| Run screens | Leader pick, top bar, markers over places, season news, attack, result, end | W | `src/season/run-ui.ts: mountRunUi, RunGame`; `season/run-words.ts` | — | Crude on purpose |
| Leaders | Three leaders, different starting pools | W | `run-words.ts: LEADERS` | — | Pools only |
| Save and resume | World as a delta from the atlas's own (~0.1 MB) plus the run's state, under `realm:world` | W | `scenes/level/loop.ts` (`WORLD_KEY`, `SavedRun`); `src/api/snapshot-delta.ts: delta, applyDelta` | Saved at start, each answer, each season end, after the fight | A reload mid time-lapse or mid attack returns to just before it |
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
| Signs | ashfall (flakes + grey dusting), darkness (sky dim), deadrise (burial ground + shamblers), crime (looted lots); each ends at a season | W | `MutateEngine.sign, signs, season`; shown in `mutators.ts: showSigns` | `mutators.sign({ kind: 'crime', place, strength, until })`; strength 0 ends it | 4 kinds; shows only on a live generated town (FIXED-CITY, MU-27) |
| Rivers run dry | A `dried` entry cuts the river field downstream | W | `mutators.ts: syncCuts`; `src/weather/catchwet.ts: RiverCut`; `weather/inflow.ts: carryInflow` | `mutators.apply({ kind: 'dried', place })` | — |
| Map badges | A badge per condition on the atlas map | W | `src/mutate/mapmarks.ts: drawBadges, badgesOf` | — | — |
| Mutator lab | A button per mutator and sign | L (`?mutlab=1`) | `mutate/lab.ts: mountMutLab` | — | — |

## 6. Weather, water, fire, lava, wind, ecology

| System | What it does | Status | Entry point | How to call | Known limits |
|---|---|---|---|---|---|
| Storms, dust storms, cyclones | CPU entities that give rain, shade and wind fields | W (runs under the loop) | `src/weather/weather.ts: Weather` (`reclaimed.weather`) | `weather.spawn(x, y)`; `weather.spawnDust(x, y)`; `weather.spawnCyclone(x, y, spin)` | The loop's Rain spell calls `spawn` |
| Day, night, seasons | Sun, moon, season of the year | W | `weather/daynight.ts: DayNight`; `globals.season` | `?tod=`, `?day=`, `?season=` | — |
| Sky dim, ash fall | Two numbers the signs set | W | `core.skyDim`, `core.ashFall` (`scenes/world-core.ts`) | set by `showSigns` | — |
| Water | Depth and flow per column; flood and drain | W | `src/api/water.ts: Water` (`scene.worldApi.water`); `src/flow/liquid.ts: LiquidSystem` (`?flow=1`) | `water.flood(x, y, { radius, depth })`; `water.drain(…)` | Mirror reads are cached, not per frame |
| Rivers | Held rivers by table, per-watershed wetness, cuts | W | `weather/catchwet.ts: CatchmentWet`; `weather/riverwet.ts: RiverWet` | via mutators `dried` | — |
| Fire | Fuel catches, spreads, heats, brings timber down | W (the Fire spell calls `ignite`; nothing was seen to catch in the loop's town: LS-63) | `src/api/fire.ts: Fire.ignite, fireAt`; `shaders/fire.wgsl`; event `EV_IGNITE` | `worldApi.fire.ignite(x, y, { radius, intensity })` | Fuel is plants, oil, timber, canvas, trash on top of a column (`fire.wgsl: fuelAt`). Citygen's buildings are meshes: they do not burn in it (LS-63) |
| Lightning, chip, scare, grow, ripple, mend | One-tick world events | W | `src/sim/globals.ts: EventKind`; `shaders/common.wgsl: EV_*` | `globals.events.push({ kind, x, y, radius, strength })` | Seen only by period-1 systems; more than 4 a tick wait |
| Lava | Vents, flow, cooling, steam | L (sandbox levels; `?flow=1`) | `src/sim/lava.ts: LavaSystem`; `flow/liquid.ts: LAVA` | `scenes/level/impacts.ts: ventAtPick` | Not in the atlas town level unless flow is on |
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
| Particle bursts | dust, litter, leaves, ash, chips, cloud, splash, smoke, embers, flame, haze, seeds, sparks, petals, grains | W | `src/api/fx.ts: Fx.burst`; `src/sim/particles.ts: ParticleSystem, PK` | `worldApi.fx.burst('petals', x, y, z, { count })` | 64 bursts a tick, the rest queue |
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
| Table driver | Plays a run on the `Realm` with no scene: offers as view records, take, pass, cast, end season, the raid, next run; records the moves | W | `src/table/game.ts: Table, replay` | `new Table({ seed, leader, seasons, packs })`; `t.cards()`; `t.take(id)`; `t.endSeason()`; `t.things()`; `t.abilities()`; `t.cast(id, target)` | Briar Hollow test world; the raid's result and `things()` are stand-ins until round 6's live events and `Realm.things()` merge (CT-1, CT-6) |
| Table page | Header with six pools and the threat, offers as readable cards, abilities with targets, things in play with tags by place, the log, packs drawer, seed / leader / length | W | `table.html`, `src/table/main.ts`, words in `src/table/words.ts` | `npm run dev` then `/table.html?seed=7&leader=ysolt&seasons=16&pack=/packs/sample.json`; console `table()` | No rules log, no "why not", no live event card yet (CT-14) |
| Bots | Nine policies play whole runs; a table of ends, pool curves, decisions a season, rules fired, cards never taken, threats that ran out | W | `src/table/bots.ts: POLICIES, playRun, runBots`; `test/unit/table-bots.test.ts` | `node scripts/tablebots.mjs [--seeds n] [--seasons n] [--pack file.json]` | About 1.3 s a 16-season run; seeds do not vary the deal (CT-3) |
| Pack validator | One pack's JSON checked against the engine's words; problems in plain words for an outside author | W | `src/packs/check.ts: checkPack, reportText` (no run-time imports) | `node scripts/packcheck.mjs packs/sample.json` | Numbers written as words are not checked |
| Pack loader | Cards to `TemplateDef` on the existing helpers plus eight `pack*` helpers; things, tags, abilities; rules carried as `RuleDef` | W (cards, things, tags, abilities); D (rules fire, live events) | `src/packs/load.ts: loadPack, packHelpers, packThings, packTagsOn, castAbility, effectsText` | `new Realm({ …, extra: { templates, helpers: packHelpers(packs, host) } })` | CT-10 to CT-13 |
| Realm: extra content | More templates and helpers than the base game's | W | `src/season/realm.ts: RealmOptions.extra` | see above | Rules not yet (CT-13) |

## Recipes

Sizes: **S** under 3 h, **M** 3–8 h, **L** more. Builder hours, with unit tests and one phone check.

### 1. A parade — **M** (a first version), **L** (along a named street with townspeople gathering)

**Round 6: the first version is built** — `season/realm-events.ts` `PARADE_EVENT` (a column in by a road to the
market, watchers as a loose unit group, petals, the story camera). The gaps below stand (BACKLOG LS-64).

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
