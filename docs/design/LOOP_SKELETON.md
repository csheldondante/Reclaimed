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

**The link:** `?skipmenu=1&level=atlas&town=1&loop=1&fresh=1` (add `&q=low` on the phone). Without `&fresh=1` the saved
world is kept. Walk-through: `node scripts/loopwalk.mjs --out <dir>` (412x915, a still a moment).

## Fixed rules it keeps (DECISIONS, DESIGN §18/§21 draft)

One opportunity = one card = a cost (locked for some seasons, or spent), an effect if played, an effect if it expires
unplayed; a named presenter; the step is a season; six small pools; work finishes in visible stages replayed as a
time-lapse; the world carries over between runs; a threat is a card among the others; `&fresh=1` on links.

## The eight moments as screens, and what each reuses

| # | Moment | Screen | Reuses | New |
|---|---|---|---|---|
| 1 | Pick a leader | full screen, three leaders (portrait box says "Portrait to come") | — | `LEADERS` (pools, income, suit) |
| 2 | See their city | the town, top bar: leader, season, run, pools | the atlas level's GPU town, living town, `season.ts` framing | top bar |
| 3 | Characters ask | names over the map; tap → the story camera frames the spot, the card shows | `story/camera.ts` `frame`/`release` (plain zoom: no cutaway in this level) | petitions, markers |
| 4 | Allocate | Agree / Not now; pools and hand update | `season/ledger.ts` `commit` (the one opportunity contract), `lose` | `run.ts` `play` |
| 5 | Next season | time-lapse of the project's district; cards age and expire | `SeasonLoop.next` (showcase, districts, walls, living town counts) | `run.ts` `endSeason` |
| 6 | A threat to prepare for | the threat card from season 1: countdown, what helps, what it brings | — | threat petition; `WarHost.raid` (the raid is the card's expiry, not the schedule: SF-5) |
| 7 | The attack plays | camera follows the raiders; a line; a spell bar; a result | `SeasonWar` + `TownForces` + GPU units; `units.strike`, `powers.scriptStrike` | fight watch, result, spell bar |
| 8 | The world mutates, persists | a change applies at once when a card is agreed or expires (near: short reveal; far: news), tags on the map, the end-of-run list, a new run in the same world | region store (`loop:world`), the mutators' contract | world record, stand-in mutators |

## State

- **Pools, projects, what's built:** the season ledger (`season/ledger.ts`), unchanged — the only place pools live.
  The run's rules return a new ledger; the scene hands it to `SeasonLoop.setLedger`.
- **Run record** (`season/run.ts`, pure): leader, season, hand (card + seasons left), deck, played, expired, spells
  unlocked, the raid due, the fight's result, world changes made, changes due. Not saved yet (a reload starts at the
  leader screen; assumption 9).
- **World record** (`season/run.ts`, saved under `loop:world` in the region store, cleared by `&fresh=1`): runs begun,
  changes (each once: kind, sentence, where — near: town + place in the town's frame + radius; far: the place id), and
  the world's places (owner, status, tribute). Tribute is paid into the pools at each season's end; a place's status
  deals cards (`Petition.when`).
- **The town as built** persists as before: the season save and the town's edit log (`season:<x,y>`, `town:<x,y>`).
  A new run keeps `ledger.built` and takes the new leader's pools.
- **Data flow / readbacks:** nothing new on the GPU and no new readback. The raid camera observes the raiders' units
  (`Units.observe`, the existing few-units path) only while the attack screen is up. Markers are DOM, placed by
  `camera.project` each frame. Phone cost: DOM only; not measured this round (the phone-idle track owns frame cost).

## Mutations (the mutators' contract)

The user, 2026-11-15: "More focus on mutations … I want melted, flooded, buried, burned etc", then "Try making instant
mutators instead since a lot of opportunities will happen in other area of the world". The mutators are the `mutators`
branch's (`src/mutate/index.ts`). The loop codes against a local copy of the announced contract
(`season/mutation.ts`: `list`, `apply({ kind, place, area, strength, seed })` instant with an optional `play` reveal,
`record`, `restore`) with a stand-in behind it (`scenes/level/loop-standin.ts`): flooded = the world's water edit
event, burned = the ignite event (both as a 3 s reveal only), everything else recorded and tagged, nothing drawn. At the
merge: import the real interface, delete the stand-in, read places from the mutators' places record instead of
`WorldRecord.places`.

Cards name their mutation: the dam neglected → the lower town floods; the fire mage refused → the market burns; the
shrine unfed → the quarry road melts; the hill not shored → the mill street is buried; the raid breaking through → the
east district is burned; the prospector agreed → Copper Hollow founded (pays 1 Materials a season); Harrowgate not
helped → captured (it then sends a toll card), helped → a vassal paying tribute (it then asks for grain; refused →
abandoned).

**Far changes come home** (the user: "You let a city fall and you get refugees. You lose a mining colony and ship
volume decreases … It makes the choices feel real"). Rule: every far card's consequence is seen in your city.
`run.ts` `comesHome(world)` gives what the places send; the scene adds it to the living town's counts
(`SeasonOpts.life`): a captured town → 40 more people in the streets, Unrest +1, and a named refugee's card (house
them, or they camp outside the gate); a founded camp → 14 wagons and +1 Materials a season; lost → both stop. The
season's notes and the end screen say the link in plain words, and the end screen pairs each choice with what it caused.
Stand-in: refugees are more people in the streets, not a column on the road.

**Signs** (the user: "Darkness and ash raining down are a great way to indicate a distant eruption … undead rise in
the city or crime are all indicators"). The mutators' `sign` / `signs(place)` will draw them; here they are flags
(`run.ts` `signsNow`: a card's warning while it is in the hand, what an expiry leaves for some seasons, crime at
Unrest 2 or more) shown as chips in the top bar, labelled stand-in. The shrine card's words point at the ash already
falling; unfed, the mountain breaks: the quarry road melted, ash and darkness for three seasons.

## Assumptions for the owner (each is the simplest thing; say which to change)

1. Leaders differ by starting pools, income and which suit of card comes up first (×3). Nothing else yet.
2. A run ends when its threat is resolved (the attack fought, or the tribute paid). About four seasons.
3. A new run keeps the town's buildings and the world's changes and places; pools restart from the new leader.
4. Agreeing is final (no undo), as "committed is committed".
5. Characters stand at fixed spots in the town's core, not at their own building (houses don't know who lives there).
6. Near changes pick their spot by rule (lowest ground for a flood, east/north/west/centre otherwise), not by a real
   district or lot.
7. Spells: Heat ray costs 1 Magic a cast, unlocked by the tower-lens card, cast by tapping the ground in the attack. It
   uses the existing area blow on units and the existing lightning strike as its look. Runes are a later round;
   telekinesis arrives with the physics merge.
8. Far places are a list (name, owner, status, tribute), not yet on the atlas map; their positions are not set.
9. A reload mid-run restarts at the leader screen in the same world (the run record is not saved).
10. The raid's size is fixed at 6; the fight is "held" only if every raider dies.
11. Petition numbers (costs, seasons) are the catalog's work with small overrides; a barracks is the keep district.
12. Paying the raiders' tribute ends the run at the next season with no attack.

## Build order (riskiest first)

1. Rules + tests (`run.ts`, `test/unit/run.test.ts`). 2. The raid as a card through `SeasonWar` (does a raid spawn on
demand and can the camera follow it?). 3. Screens and markers. 4. World record + stand-in mutators + the end screen and
the new run. 5. Walk-through at 412x915, stills looked at.

## Failure modes named (tests where pure)

A card played twice or not in hand (throws); cost short (throws, says what); an expiry applied once; the raid due only
in its season and not after the fight; a change recorded once (replay); a near change with no place (throws); a world
record of an unknown version (throws); raiders with no road (the result says so, nobody got in); no soldiers (raiders
sack the town after 5 s there); the attack capped at 150 s of wall time (a cap — BACKLOG LS-5).

## Round 1 result (2026-11-15)

Real: 1 leader pick, 2 the town, 3 petitions and the camera, 4 commit, 5 the season's time-lapse with ageing and
expiry, 6 the threat card. Wired, seen once: 7 — the raid is the card's expiry; in one walk of four the
raiders spawned, marched in with the camera on them and sacked a town with no soldiers; in three they found no spawn
point (BACKLOG LS-16). A fight with soldiers and a spell cast are unseen.
Stand-in: 8's look (the mutators), far places on the map, signs, refugees as a column. Persisting: the world record,
the town as built. Next: LS-16, then merge `mutators`.

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
