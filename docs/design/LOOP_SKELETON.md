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
  (`living/seed.ts seedLocus`). Saved whole at each season's end and at the fight (`realm:world` in the world store,
  cleared by `&fresh=1`); the next run and a reload start from it.
- The run's own small state (its length, spells unlocked, the raid due, the fight) is `Realm`'s, in memory. A reload
  mid-run starts at the leader screen in the saved world (not resumed: BACKLOG LS-8).
- Physical changes an outcome names (flooded, burned, melted, buried, founded, captured, vassal) are a list of named
  stubs (`Realm.physical`, each with the event that caused it) until `origin/mutators` is merged. Nothing is drawn yet;
  the end screen says so.
- No GPU readback is added. The fact snapshot is JSON written at a season's end (its size is in the DEVLOG).

**The templates** (`season/realm-templates.ts`): one a season catalog card (11, with the catalog's own chain: houses,
then workshops, then the keep; walls need nothing); the world's: a mining outpost (the user's INF-01), the tower lens
(a spell), a neighbour relieved or left to fall, four hazards whose expiry names a physical change; the raiders as
the arc. All deterministic. Each stands at a site of the home town (`SITES`: 17 named places).

**Decisions a season.** The dealer's own limit (4 resource cards, counted over what is already offered, plus its one
guarantee): 4 or 5. Unit-tested with pools four times larger; the walk logs the count each season.

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
