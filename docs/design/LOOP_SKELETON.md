# LOOP_SKELETON — the main game loop, walking skeleton (branch `loop-skeleton`, 2026-11-15)

**The test for every choice here** (the user, 2026-11-15, verbatim): "the design is well thought out. It's a 4x but
with fast rounds, that use legacy to let scope grow and change and the world build without creep in actions per turn".
And the rhythm: "the gameplay with opportunities between action and spells in the live city is sort of a mashup of a
deck builder (Dominion inspired) and master of magic with armies and a wizard". And the length: "I think you need way
more than four seasons for the strategy to play at all. It's a deck builder under the hood and you need long enough to
actually build an engine and prepare for the threat." **Round 1 was built without reading the opportunity design; see
"Conformance" below before changing anything here.**

The user's requirement (DECISIONS 2026-11-15, verbatim there): game starts, pick a leader, see their city, zoom in on
characters who ask for resources for projects, allocate, see buildings go up and workers work, prepare for the negative
opportunities, play an actual attack with the soldiers you built, then see the mutations from all your choices. "Strategy
loop is just preparing for the opportunity and mutating the world." Crude but complete: every moment exists, in order,
behind one link.

**The link:** `?skipmenu=1&level=atlas&town=1&loop=1&fresh=1` (add `&q=low` on the phone; `&runlen=N` sets the run's
length in seasons, default 16). Without `&fresh=1` the saved world is kept. Walk-through:
`node scripts/loopwalk.mjs --out <dir>` (412x915, a still a moment; `--runlen 5` by default so a walk is minutes).

## How it works now (round 2: on the existing engine)

Round 1's own cards, deck, hand, effects and world record are deleted (`season/run.ts`, `season/mutation.ts`,
`scenes/level/loop-standin.ts`, the `Petition` type). The run is `season/realm.ts`: the living engine joined to the
season ledger.

| Moment | What the player sees | What does it |
|---|---|---|
| Pick a leader | three leaders, their starting pools; what the world remembers from earlier runs | `run-words.ts LEADERS`; the fact layer's history |
| The town | names over their places, each with a countdown; the raiders' countdown on the top bar and over the road | `LivingEngine.deal` through `opps/dealer.ts`; `Realm.siteOf`; the arc |
| Go to one | the camera frames the place; the presenter's dialog: who they are, the ask, Needs / Takes / You get / If you refuse | `dialog/petition.ts petitionTree`, `living/present.ts petitionOf`, the cast's personas |
| Agree | the pools drop; the card is "under way" | `LivingEngine.commit` (the one contract) on the ledger's own holdings; a project adopted by the ledger |
| Next season | the season's news; the time-lapse of what is being built | `LivingEngine.advance` (resolve, expire, the arc), then `SeasonLoop.next` |
| The threat | scouts, a farm burned, then the attack in the last season; in the last 3 seasons it can be paid off | `raidArc` (the engine's `ArcDef`); the `pay-raiders` template |
| The attack | the camera down the road, the march, the fight, the spell bar, the result | `SeasonWar.call`, `TownForces`; kept from round 1 and round 2's raid fix |
| The end, the next run | what happened this run and in earlier ones, from the history; a new run in the same world | `Realm.history`; the world's snapshot saved under `realm:world` |

**State, and who owns it.**
- The pools: the season ledger's holdings, which are the fact world's holdings (one `Holdings` record, passed between
  the ledger's pure functions and the engine; `Realm.ledger`).
- What the world is: the fact layer in the `WorldState` (entities, tags, relations, claims, the event history, the
  named people), seeded from the atlas's own world (`settlements.wiki.snapshot`) and at the home town
  (`living/seed.ts seedLocus`). Saved as what differs from the atlas's own world (`api/snapshot-delta.ts`: about
  0.1 MB, against 2.3 MB whole) under `realm:world` in the world store, cleared by `&fresh=1`; the next run and a
  reload start from it.
- The run's own small state (its length, spells unlocked, the raid due, the fight) is `Realm`'s; with the engine's
  own state (`LivingEngine.state`) it is saved beside the world at the run's start, each answer, each season's end and
  after the fight. A reload mid-run goes straight back to the same season (round 4).
- Physical changes an outcome names are the mutators' entries (round 3, below), each carrying its fact event's id.
- No GPU readback is added. The fact snapshot is JSON written at a season's end (its size is in the DEVLOG).

**The templates** (`season/realm-templates.ts`): one a season catalog card (11, with the catalog's own chain: houses,
then workshops, then the keep; walls need nothing); the world's: a mining outpost (the user's INF-01), the tower lens
(a spell), a neighbour relieved or left to fall, four hazards whose expiry names a physical change; the raiders as
the arc. All deterministic. Each stands at a site of the home town (`SITES`: 17 named places).

**Decisions a season.** The dealer's own limit (4 resource cards, counted over what is already offered, plus its one
guarantee): 4 or 5. Unit-tested with pools four times larger; the walk logs the count each season.

## Round 3 (2026-11-15, night): the mutators, the fight, the long run

**The land changes.** `origin/mutators` (caf512de) and `origin/phone-idle` (66f51279) are merged. An outcome names the
mutators: `mutate` and `sign` (theirs) for a whole place, and two helpers the realm registers, `mutateAt` (the land
round a site of the home town, or round a spot out of it) and `found` (a new camp). The fact layer stays the world's
state; each entry of the mutators' list is what the land shows of one fact event and carries its id. The realm binds
its world to the mutators at a run's start (`useWorld`); the loop lays the saved list over the window with the saved
world bound first, so nothing is recorded twice. The mutators' season is the history's turn, which runs on across runs.

| Outcome | What is written |
|---|---|
| The dam left to break | `flooded` round the dam (radius 34), the bank nearest the town's heart |
| The fire mage's wards refused | `burned` round the market (22) |
| The shrine left unfed | `melted` on the mountain, the highest ground 420 to 640 cells off; the mutators cast ash fall and darkness on the town for three seasons. Thin ash falls while the card stands |
| The hill left to slide | `buried` round the mill street (24) |
| The raid breaks in | `burned` where the raiders stood (30), the crime sign for three seasons |
| A neighbour left to fall | `captured` by the raiders; its people migrate to you |
| A neighbour relieved | `vassal` of the player, 1 a season |
| The mining camp | `founded` in the hills (a settlement record); lost to raiders: `destroyed` |
| The dead left alone, refugees turned away | the `deadrise` and `crime` signs |

Still waiting on a mutator: a district abandoned (theirs is a whole place), a reveal of the change (MU-3), flood water
that stays (MU-28: it drains in seconds, so the flood shows as silt on the bank and drowned lots, not standing water),
a founded camp that is built (MU-6).

**The fight.** A ring round every raider and soldier, each side's name and count, the camera at zoom 22 and a 40 degree
pitch; when it ends the camera pulls back over the district.

**Threats.** Threatening cards (OPPORTUNITY_CATALOG: "count down to a negative outcome if not intercepted") are the
dealer's events: outside its resource limit, at most one standing, each with its place in the run (BACKLOG LS-35). The
board is 3 (`realm.ts BOARD`), plus the dealer's one guarantee, plus one threat: a season asks at most 5 things.
Equal scores are drawn by template, place and turn; projects score by what they give.

**Consequences come home.** `Realm.life()` reads the fact layer: 40 more people in the streets for each town whose
refugees came, 10 carts the season they arrive, 14 ore wagons while the mining camp stands. A named refugee asks for
huts. A threat card can lose the camp.

**The long run.** 16 seasons (`RUN_SEASONS`, a tunable; the orchestrator's number). The major threat shows from the
first season (its countdown on the top bar and over the road; scouts at season 4, a farm burned at 8). Smaller threats
come one at a time on the way. One live event sits mid-run: at season 6 the dead get up in the old burial ground, the
player goes there and casts Fire on them (1 Magic a cast), then goes back to choosing. In the scripted walk a season
takes 9 s with its petitions (the time-lapse skipped after 1.5 s; it can be skipped at once).

*The lab.* The card lab's bots (`opps/deck.ts`: ev, bigmoney, engine, random) play the lab's own deck over three
resources (labor, influence, power) toward a climax card; the season's cards are a different deck over six pools
(Labor and Might locked, Materials, Magic and Intel spent, Unrest a state). They were not mapped onto each other.
The nearest mapping would be labor = Labor, power = Might, influence = Materials + Intel, with Magic and Unrest having
no lab pool; it loses what makes the season's cards differ, so the check was run on the realm itself instead:
`test/unit/realm-bots.test.ts`, six fixed-preference bots over 16 seasons. "Holds" is a proxy (tribute paid, or walls
or a keep and 4 Might) because the fight does not run in Node.

| Bot | Result at 16 seasons | Built |
|---|---|---|
| idle | falls (nowhere for soldiers to gather) | nothing; every threat lapsed |
| walls first | holds (walls, Might 4) | quarry, walls, lumber, houses |
| keep engine | falls: the keep's chain never completes | quarry, lumber, houses x3, farms x3 |
| trade and tribute | holds (tribute paid) | quarry, lumber, houses x3, farms, market; income 8 |
| answer every threat | holds (walls, Might 4) | quarry, walls |
| everything | holds (tribute paid) | 14 cards, the keep at the end; income 14 |

Two ways hold (walls and Might; an economy that pays the tribute). Decisions a season: 0 to 5 for every bot, no
higher late than early. At 4 seasons only the tribute holds, which is the owner's point about length; it also says the
tribute (6 Materials, last 3 seasons) is cheap.

**Placement.** `season/sites.ts placeSites`: each site at a place of its kind (beside its road, on a bank, on high
ground, round the heart), on dry land by the atlas, off the approach roads, within 0.62 of the town's reach so all fit
the screen; `declutter` keeps names apart and on the screen. Limits: BACKLOG LS-36.

**FIXED-CITY.** BACKLOG LS-40 lists every place the loop bakes one home town a run; each has a comment at the site.

## Round 4 (2026-11-15, late): playable by a finger

**Found and fixed** (each with its measurement in the DEVLOG):
- *The soldiers who never fought (LS-45).* A unit the window slid away from was left under the ground for good; the
  long walk looks at far land changes, the short one does not. Fixed in the units' step.
- *No spell was ever cast in a fight (LS-46).* The loop's marks layer took every press on the map. Fixed; a spell
  aims at the level the figures stand at. Heat ray's damage is 2 of a raider's 3 health (assumption 17).
- *The tap that closes a dialog pressed the screen beneath* (cards agreed that nobody chose, on a phone). Fixed in
  the dialog.
- *The home town let go under the run* (the camera 900 cells off): the fatal overlay. Fixed; the loop's camera stays
  within 650 cells of the home town (FIXED-CITY).
- A reload mid-run resumes it (LS-8); the save is about 0.1 MB (LS-29).

**The walk by a finger.** `node scripts/loopwalk.mjs --touch` drives the whole loop with touch events and checks that
every control is on the screen, not covered and at least 40 px tall, that nothing on the loop's screens moves the
map, that a drag on the map pans it, that the dead and the raiders are in view between the top bar and the sheet.
`--reload N` closes the tab in season N and opens it again.

**The moments.** A Map button on the sheet opens the world's map with a badge for each changed place. While a
season passes with something under way the camera closes in on the district being built (the season loop already
turned it there; at the town's zoom it was a few pixels). It was switched off for a dead end in the story camera's
queue (BACKLOG LS-54) and is on again since round 5, with the live event's camera on the dead as the event starts
(LS-47); the last camera change still wants its walks (LS-58), and the close-up's framing is poor (LS-59). In the fight the raiders' name stands above their figures
and the soldiers' below theirs.

**Open defect (BACKLOG LS-50):** soldiers who are already standing at their post when the raiders come may die
without a swing (1 walk of 5 this round; LS-23's family). Not found.

**Not done:** the cutaway on a petition and the camera on the presenter at their own building (LS-9, LS-36: the
card's site is a place of its kind, not the presenter's lot); refugees walking in as a column (LS-37: needs an
arrivals job in the living town); white boxes for buildings at fight zoom on `q=low`; raiders and soldiers as
visibly different figures (a ring's colour tells them apart); far places visited; the brawl and fire-and-rain events;
threat pacing from the world's state (Conformance, round 4).

## Round 6 (2026-11-16): one live-event system, tags and synergy rules

The owner's direction (verbatim): "I do think this may be a mistake to differentiate combat from other events like
parades or riots or fires. I would strongly consider using the same system for all of them." "Let's make these
realtime for now and they can resolve automatically when the season ends with a different outcome based on your
strategic interactions including casting spells." "Those engines should all be defined in terms of tags and
synnergies designed like a card game not hard coded." "I would have abilities like double output from the field of
growth effect is active."

**One system for every live event.** A template says what is played with `play.event` (`living/live.ts LiveDef`):
groups (kind, side, count, tags, where they start, their order and formation), an optional hazard, optional seconds,
the spells allowed, when it ends, and how its result is read. One runner (`scenes/level/live-runner.ts`) plays any of
them in the city. The loop's two hand-written copies (`playDead`; `beginAttack`, `nextRoad`, `watchFight`,
`endAttack`) and `Realm.fought` are deleted. Five events are data on it (`season/realm-events.ts`):

| Event | How it starts | What is played | Its result |
|---|---|---|---|
| The raid | forced, in the run's last season | raiders in by a road to its gate (no walls: the town's heart); the squads at their posts; spells the run has unlocked; 150 s | raiders left after each soldier standing holds one, and the rules stop more |
| The dead | the gravedigger's card, agreed | 5 dead at the burial ground; Fire | how many are still up |
| A parade | the piper's card, 1 Materials | a column in by a road to the market, watchers, petals | the crowd at the market |
| A fire at the market (**not dealt**: nothing catches in the town, BACKLOG LS-63; the instant `fire-wards` hazard stands) | the fire mage's card | the fire system lit at 6 stalls; Rain; 80 s | stalls burned down |
| Refugees | forced, when a far town falls | people and carts in by a road to the stores | a camp by the watch post |

**The season goes on round it.** Agreeing takes the player to the event. Unless it is the raid, "Back to the town"
leaves it running: its name stands over the map where it is, a tap goes back. An event ends by itself (its `ends`,
its seconds), or "Next season" resolves every one still running from the state it is in.

**How a result is read** (the same four steps live, at the season's end, and in Node where nothing ran):
numbers counted from the event (`result`: units alive by tag, stalls burned, casts) → the synergy rules change a
named number, each with its reason → numbers worked out (`derive`) → the first tier row that fits. That tier's outcome
runs through the engine like any card's, with the numbers as its vars. Nothing is read back from the units: counts
come from their own died / hurt / arrived events. A fire's spots are read through the fire mirror's pages (a few KB)
every 2 s while a fire event runs.

**Tags and rules.** Each thing's tags come from what it is and its state (`season/realm-rules.ts SITE_TAGS`; the
realm's `things()`): a field is `field`, `standing`, `worked` once farms are built, `growth-active` for the season a
rune was drawn on it; burned, it is only `ruined`, `burned` and every rule about it stops. A rule
(`living/rules.ts RuleDef`) is a trigger, tag queries with a relation of place, an effect on a pool or on one of an
event's numbers, a capacity and a limit a season. The first ten:

| Rule | When | Needs | Does |
|---|---|---|---|
| Rune-fed fields | season end | a worked field with a growth rune | +2 Materials |
| Procession past the shrine | a parade read | the shrine within 70 cells of its way | +1 Magic for each 6 of the crowd, at most 2 |
| Garrisoned walls | the raid read | walls and soldiers gathered | 2 raiders stopped |
| Market by the gate | season end | a market built; trade partners standing | +1 Materials a partner, at most 3 |
| Water close by | a fire read | water within 110 cells | half the burning stalls saved |
| A sullen town | a parade read | Unrest above 0 | half the crowd |
| Harvest home | a parade read | a worked field with a growth rune | 4 more in the crowd |
| Watch from the tower | scouts seen | the tower standing; soldiers gathered | +1 Intel |
| Forge by the keep | the raid read | workshops and a keep within 90 cells | 1 raider stopped |
| Hands from the camp | season end | the refugees' camp sheltered; a worked field | +1 Materials |

Each firing is a line on the season's news or the event's result ("The growth rune doubled the crop on the east
fields: +2 Materials.") and a `rule-fired` event in the history.

**A spell every season.** The growth rune is on the town's sheet each season: press it, tap the east fields; the
plants there grow (the ecology's own call), 1 Magic, the field `growth-active`. Fire now lights the fire system where
it lands (and still burns units); Rain is a storm over the tap.

## Round 7 (2026-11-16): live events that read

Goal: on the phone a player understands an event without the sheet's text. Everything is data on the one runner.
- **Seen, not told.** The camera closer (zoom 15-16) and steeper (55°) on people; a gold ring round each marcher,
  refugee and cart, their name over them; the time of day held while an event runs, and one begun at night is played
  from morning (BACKLOG LS-78).
- **A parade.** Marchers walk in by a road as a loose crowd under petals; as many people as the town sends stand
  along that road ("Watching"); at the end place a 6 s finale (petals, the watchers come to it); then everyone walks
  off to the muster. The way is still the shortest walkable one, not the street (LS-77).
- **Refugees** walk in with their carts to the stores and put up tents by the east fields — the tents stay on the
  ground (the mutators' `camp` sign).
- **The fire at the market burns** in the town and is dealt again; its outcome is whether Rain was brought (LS-80).
- **Arrival is the units' own word** (`arrived`): a column's formation anchor now moves with the window (LS-72).
- **Five asks at most** a season, whatever the dealer's guarantee adds (LS-73).

## Round 8 (2026-11-16): the 3D game plays the card world; columns in by the road

The owner: "the world builds general systems for showing and later playing in the world generated and mutated by
the cards." The 3D game now loads the card table's packs (`&packs=laws,glitter,arena`, `&pack=<url>`) through the
same loader and Realm options. One table maps every pack effect to a showing (docs/SYSTEMS.md 3c): instant (the
mutators, signs, pools), at the season turn (a pack thing's marker with dust and the camera on it), live (pack events
through the round 6/7 runner, pack abilities on the event's sheet, "Settle it now"), and the floor (the card's line in
the news and a "Done" marker at its site for a season) — nothing a card does is unseen. The town sheet has Laws,
Rules and Remembered pages; costs are the law-applied terms with the printed cost beside them; an ending names
itself on the end screen and the next run's start screen says what the world is now.

Columns: a `march` can now come in (`inward: true`: the gate route walked backward to the gate), and an entering
column in a walled town marches in along its road and is given its own order at the gate; the town's arterials are
road-weighted in every field; LS-76's split was a field march's anchor waiting where its field had not reached — fixed,
and the parade and the refugees walk in a column again. Open: no gate routes without a wall (LS-89), streets inside
the town are not weighted (LS-88).

Where the loop depends on the Realm's built-in raid arc (the card table is replacing it by cards): the top bar's
countdown (`run-ui.ts threatText(run.threatIn)`), the raiders' marker over the road (`loop.ts markers`, `threatIn`),
`startRunLoop`'s `raid: () => realm.raid`, `flow()`'s "the raid is due and its card was not dealt" check, the
`result` phase on `r.fight`, and `Realm.over` on the fight. The live raid event itself is data (`RAID_EVENT`).

## Assumptions for the owner (each is the simplest thing; say which to change)

1. Run length: 16 seasons to the raid by default (`RUN_SEASONS`; the orchestrator's number, not the owner's).
2. A run ends when the raid is fought, or in its last season if the raiders were paid off.
3. A new run keeps the town's buildings and the whole fact layer; pools restart from the new leader.
4. Agreeing is final. Saying no is remembered by the presenter (the engine's own rule).
5. Named buildings and districts of the home town count as locations for "one opportunity a place". The 17 sites are
   a fixed list; where each sits on the map is a stand-in ring, not the town's own lot of that kind (LS-3).
6. Leaders differ by starting pools and income only.
7. The neighbour a card is about is the standing settlement nearest the home town in the atlas.
8. The raiders can be paid off (6 Materials) only in the last 3 seasons.
9. Heat ray costs 1 Magic a cast; runes and telekinesis are later.
10. The catalog's chain is kept as the engine to build: soldiers by the keep take 9 seasons, by the walls 3.
11. A small list of who is asking stays on the sheet for reach on a phone (the map's names are the main way). Say
    if it should go.
12. (round 3) Smaller threats come on a fixed schedule, one at a time (BACKLOG LS-35). The design asks for pacing from
    the world's state.
13. (round 3) Fire is a spell every leader has, cast only in the live event; Heat ray is built (the tower's lens).
14. (round 3) A raid that breaks in burns the district where the raiders stood; nothing else of the town is lost.
15. (round 3) Refugees add people to the streets and 1 Unrest; housed, 2 of them become Labor.
16. (round 3) The board is 3 projects, with one guaranteed card against the threat and one threat card: 5 a season.
17. (round 4) Heat ray: 1 Magic a cast, every raider within 5 cells loses 2 of 3 health. At 3 one cast killed the
    whole raid on the march. Fire (the live event) is unchanged.
18. (round 4) In the loop a tap on the map does nothing and a drag pans; the map's own tools (rain, gusts) are off.
19. (round 4) The camera stays within 650 cells of the home town; far places are seen on the map, not visited.
20. (round 4) A run is saved at its start, at each answer and at each season's end. Closing the tab during a
    season's time-lapse or the attack comes back to just before it.
21. (round 6) When a live event is read, each soldier still standing holds one raider and the rest get in; walls with
    a garrison stop 2 more. Unfought (the bots, a season's end), the same sum decides it.
22. (round 6) A parade's crowd is 9 marchers and 4 to 10 watchers (2 more a housing card); 8 calm the town by 1, 14 by 2.
23. (round 6) A stall alight 12 s has burned down; up to 2 of 6 lost is still a fire fought; water within 110 cells
    saves half.
24. (round 6) Every leader has Fire, Rain and the growth rune; each cast costs 1 Magic. The rune pays 2 Materials on
    worked fields (the farms' own yield again), once a season.
25. (round 6) An event left running is resolved at the season's end as it stands. After a reload, an event that was
    running is resolved as nobody played it (the raid starts again).
26. (round 6) Trade partners are the 3 towns nearest the home town once the trade route is built, and the mining camp.

## Conformance (round 2, 2026-11-15): the skeleton against the opportunity design

Read: STRATEGIC_MAP.md, FACTIONS_WORLD_STATE.md, OPPORTUNITY_CATALOG.md, LIVING_WORLD_v3.md, SEASON_LOOP.md, DESIGN §21
to §23, DECISIONS round 120 on (the hand, relics, Dominion). RUN_LOOP.md and NEXT_SEASON.md were only skimmed. The
code: the fact layer (`api/contracts/facts.ts`, `facts-store.ts`, `facts-rules.ts`, `living/world.ts`,
`living/mutations.ts`), the template engine (`living/engine.ts` `TemplateDef`, `LivingEngine`; `living/dsl.ts`), the
one contract (`api/contracts/opportunity.ts` commit, resolve, relics), the one dealer (`opps/dealer.ts`, tuning in
`opps/tune.ts`, the why lines), kingdoms and bots (`opps/kingdom.ts`, `opps/deck.ts`: ev, bigmoney, engine, random;
`cardlab.html?deck=1`), petitions as dialogs (`dialog/petition.ts`, `living/present.ts`), cards pinned on the atlas
map (`opps/level-opps.ts`).

**Where the engine runs today.** The living engine, the fact layer, map pins and petition dialogs are wired only for
`?level=atlas&run=opps` (the horde slice). The town level (`&town=1`) runs the season loop, which uses the contract
and the dealer over its own `SeasonCard` catalog and shows a hand, with no facts. So the season loop is half way, and
the skeleton went further from the design, not nearer.

| Round 1 built | Uses the engine? | What replaces it |
|---|---|---|
| Pools, commit, projects (`season/ledger.ts`) | Yes: the opportunity contract | kept |
| `Petition` and the 20 cards in `run-words.ts` | No: a third card type | `TemplateDef` entries (the catalog's own where they fit: INF-01 the mining outpost, INF-02 the workshop, INF-14 a settlement) with bindings to real places and people |
| The deck, `fill`, `HAND_SIZE`, `Leader.opens`, `defence` (`run.ts`); the season dealer switched off | No: a second dealer | `LivingEngine.deal` through `opps/dealer.ts`; a leader is tags and holdings the dealer reads |
| Effects (`Effect`, `Mutation`, `due`, `mutate`) | No | DSL effects (`living/dsl.ts apply`) into the fact store and, for land, the mutators |
| `WorldRecord` (changes, places) under `loop:world` | No: a second world state | `MemoryWorldState.facts` (entities, relations, claims, the event history), saved with the world. It is not saved to disk today: that is new work |
| Far places list (Harrowgate, Copper Hollow are invented) | No | the fact layer's settlements and polities seeded from the atlas (`living/seed.ts`); the mutators branch is being told the same |
| The threat card and its countdown | Partly (a card with an expiry is right) | the run's one arc (`ArcDef`), with stages seen on the map |
| The hand list on the sheet (`run-ui.ts`) | No: the design says never a hand | opportunities over their places with a timer; the petition is the dialog (`petitionTree`) when you go there. Kept already: names over the map. A small list may stay for reach on a phone if the user allows it |
| Presenters (a name and a role, fixed spots) | No | `living/people.ts` and `cast.ts`: named people who remember across runs |
| Signs chips; end-of-run causes | No | signs from the mutators; causes read from the event history |
| The attack (`SeasonWar`, `TownForces`), the camera, the spell bar | n/a (live action) | kept; the raid becomes a template whose cost includes playing it |

**What the engine already did that the skeleton re-invented:** a card with a cost, a played effect and an expiry;
dealing few, the most expensive you can afford, one a place, with reasons; presenters; outcomes as world changes;
relics; a world that carries over.

**Decisions a round.** Today the skeleton offers at most 3 cards and the threat: 4, fixed by `HAND_SIZE`, so flat by
a cap and not by the dealer's rule. The season loop's dealer also deals 4 (`deal.ts HAND`). The long scripted run
does not exist yet, so its late-season number cannot be stated; the gate for it is: decisions in season 14 no more
than in season 2.

**Where the documents and tonight's words differ (tonight's win where explicit; listed for the user):**
1. Length. DESIGN §21 leaves "15 to 50 minutes" unrevisited and the card lab counts turns (default 40); tonight: way
   more than four seasons. 16 is the coordinator's figure.
2. "No rolls" (the coordinator's summary) against `TemplateDef.odds` and tiers in the engine, and the catalog's
   "outcomes can be uncertain". Which holds?
3. Instant mutators against FACTIONS §7 "mutate the authoritative simulation": the mutators' list and the fact
   store are two records of the same change unless one derives from the other. Proposed: facts are the truth for who
   holds what; the mutators' list is the truth for land; a far place's status is read from facts.
4. Pools. The season's six (round 128q/r) against the card lab's three: the bots check balance in the lab's pools, so
   a 16-season check in the lab needs the six pools there, or a mapping.
5. "One town per run" and "one displayed opportunity per location": a home-town run puts most cards in one place.
   The skeleton reads "location" as the presenter's lot in the town.
6. Petitions in a hand list were an experiment the user named in round 126, then corrected; the map and the dialog
   are the rule.

**Order of the rework (not started):** (a) templates, dealer and facts under the skeleton; (b) cards over places and
the petition dialog, the hand gone; (c) far places from facts, with the mutators; (d) the kingdom and a 16-season
check with the bots; (e) one small live event mid-run with spells; then the round 2 list (LS-23 first: soldiers lose
9 to 2, so preparing cannot matter until that is found).

## Conformance, round 4: threat pacing (not conformed; the gap)

**What the design says.** OPPORTUNITY_CATALOG: "Arc pacing is world-state driven, not necessarily a fixed five-step
plot. An advancing pawn/front/track makes the approach legible... consequences accumulate before the terminal
encounter. Averted threats should produce legitimate alternative conclusions." FACTIONS_WORLD_STATE §6: an arc is "a
sequence of stages/advancing world events rather than a short timer to a final fight", its progress "legible in the
actual map simulation"; "individual threat cards and opportunities appear as situations develop"; "time for
engine-building investments to pay off before pressure mounts".

**What the loop does.** The raid arc's stages land on fixed seasons (`raidArc`: scouts at a quarter of the run, a
farm burned at a half, the attack in the last season). Each smaller threat becomes eligible after a fixed share of
the run (`TemplateDef.threat.after`: neighbour 0.12, dam 0.25, the dead 0.35, market fire 0.45, the camp 0.5, the
mountain 0.6, the hill 0.78), one standing at a time (`threatMax`). Nothing the player does or that the world holds
moves any of it, except that paying the tribute ends the arc.

**The gap, item by item.**
1. *Stages by a clock, not by the world.* The raiders have no place: no camp on the map, no pawn on the road. The
   design wants the arc's stage read from something that advances and can be seen and acted on (the raiders' camp,
   their march from a town they took).
2. *Threats by a clock, not by what led to them.* Each hazard should become possible because of a fact: the dam
   cracks after a flood season or when its keeper was refused; the dead rise where people died unburied (a fallen
   neighbour's refugees, a lost fight); the market fire needs the fire mage's shop; the camp is raided because it
   exists and the raiders hold the neighbour. Today only the camp's card reads a fact (the camp stands).
3. *Pressure does not answer the player.* The design's "enough time for investments to mature" is a share of the run
   here. A dealer that reads the world would hold a threat back while the board is full of unanswered ones and bring
   one when the town is rich and idle.
4. *Averted is one case.* Only the tribute is an alternative conclusion; breaking the raiders' camp, or relieving
   the neighbour so the raid never forms, are not.

**Why it was not done this round.** Each of 1 to 4 is a design choice about what causes what (which fact opens which
threat, what the raiders' pawn is, what the dealer weighs), and the owner's threat list is still pending. The engine
needs nothing new for 2: a threat's `when` clause can read facts today; the schedule would become a floor. Building
it without those choices would be a variant passed off as the design.

## Conformance: who decides the fight (2026-11-16; not conformed, nothing built)

**The invariant** (the owner's handoff, as relayed): strategic resolution is deterministic and independent of
playback; the visual simulation renders the outcome and is never its authority; live interventions (spells) enter as
explicit, logged, bounded results.

**Where the outcome is decided today.** In the live simulation, in three steps:
1. `scenes/level/loop.ts watchFight`: the attack ends when the units say so — `f.alive === 0` (every raider dead), or
   no soldier left for `SACK_SECONDS`, or `ATTACK_SECONDS` of wall time. `f` is `SeasonWar.fight`: counts read from
   the units (`TownForces.report`: living members, the dead counted from the units' `died` events).
2. `loop.ts endAttack`: `fight = { raiders: f.n, left: f.alive, fallen: f.fallen }` — the units' counts — goes to
   `SeasonWar.resolve` (`season/war.ts settle`: a point of Might for each 3 soldiers fallen, a Material for each
   raider left, Unrest +1 if any) and to `Realm.fought`.
3. `season/realm.ts fought`: `held = raiders > 0 && left === 0` writes `raid-held` or `raid-broke` to the history,
   and on a break the burned district and the crime sign.
A spell is `units.strike` on the live units (`loop.ts castAt`); its result is whatever the units' step makes of it.
Nothing is logged but the Magic spent. So frame rate, pathing and where a squad happened to stand decide a run
(LS-23, LS-45, LS-50 are all this).

**The smallest change.**
- A pure function in `season/realm.ts`, unit-tested: `resolveRaid({ raiders, might, walls, keep, casts })` →
  `{ left, fallen, held }`. Its inputs are facts the realm already has (the ledger's Might and `built`, the raid's
  size from the arc, the casts so far). `test/unit/realm-bots.test.ts` already holds a first rule as its proxy
  ("walls or a keep, and Might of 4, holds 6"); the owner sets the real one.
- `Realm.fought` calls it instead of taking counts; `loop.ts endAttack` passes no counts from the units, and
  `SeasonWar.resolve` settles the ledger from the resolver's `left` and `fallen`.
- A cast becomes a record: `Realm.cast(spell)` spends the Magic, appends a fact event (`spell-cast`, the spell, the
  season) and counts toward `casts`, each worth a fixed, capped number of raiders in the resolver. The strike on the
  live units stays as its picture.
- The fight renders the result: resolved when the attack begins (or when the last cast is allowed), then the units
  are made to match — raiders beyond `left` and soldiers beyond `fallen` are struck down by the scene as the lines
  meet, and the attack screen ends on a timer once it has shown that. `watchFight`'s three endings go.
- What changes for the player: the result no longer depends on the playback; a spell's worth is stated on its button.

**Open for the owner:** the rule itself (how Might, walls, the keep and the raid's size weigh); whether the result is
shown before the fight plays; how many casts count and for how much; whether casting stays aimed (a tap on the map)
when where it lands no longer matters.

## Conformance, round 6 (2026-11-16): live events and rules against the design

**Who decides a fight: still open.** The owner: "resolve with whatever's is easiest for now. Simulation or mechanical
strategically determined outcome. We can iterate and try different things later." What is built: while an event
plays, the units' counts decide (as before); when it is read, what is still standing is settled by one line of
arithmetic in the event's data (`derive`), and the rules add to it. So the invariant of the section above
("resolution deterministic and independent of playback") is met only for an event nobody played (Node, a season's
end after a reload). The path is now one: making the raid's result a pure rule means changing `RAID_EVENT.result`
to read the run's numbers instead of the units', and having the runner show it. To try: (a) the resolver decides at
the start and the units are made to match; (b) casts counted as fixed worth (`{ read: 'casts' }` exists);
(c) as now.

**Departures from the design docs, with their trade-offs.**
1. *No `Challenge` of the opportunity contract.* A live event's card is committed and resolved through the contract
   (`commit`, `resolve` at a tier), but makes no `Challenge`: that asks for a player pawn among the holdings, and a
   town's pools have none. Cost: the contract's own check "a played card requires the player" does not cover these.
2. *The raid is a card, forced, not only an arc stage.* The arc's last stage still says the raid is due; a forced
   template then puts it on the board and the loop begins it. `OPPORTUNITY_CATALOG` has threats count down to an
   outcome; here the outcome is played.
3. *Opportunities "over places": a running event is shown over where it is* ("The parade · under way"), a tap goes
   back. No hand, as the design asks.
4. *A parade's crowd is unit groups, not the townspeople.* The riders cannot gather (SYSTEMS.md recipe 1). The crowd
   count is the groups' own "arrived" (the GPU's group count), not `agents.arrivals`: the units' adapter does not
   give out a field to ask it of.
5. *No live fire yet.* The fire system's fuel is what lies on a column; citygen's buildings are meshes it does not
   know, and what the event put down for it to burn was not laid and never read alight in the town (BACKLOG LS-63).
   The event is written and unit-tested; its card is not dealt, and the market still burns the old way (an instant
   mutator when the wards are refused).
6. *Rules read sites, not lots.* A thing is a site of the home town, the town, a far town, the camp. "Same district"
   is "within N cells" of a site's point; a route is the straight way between a column's first and last place.
7. *Few decisions a round holds*: the parade is one more project card within the board's 3; forced events are not
   choices. The growth rune adds one tap a season.

**To try (game rules picked as the easiest working version; all tunable, BACKLOG LS-66):** the rule numbers above;
a parade along a named street; rules on lots and districts once the CPU knows them; a riot as data; the raid decided
by a pure rule; rune drawing instead of a tap; rule cards the player earns (today all ten are always on).
