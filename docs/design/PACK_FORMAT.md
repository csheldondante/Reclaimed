# Opportunity pack format (draft 11, 2026-11-17: goods, buildings with clicks, what a thing eats)

**Changed since draft 10 (the phone board, step 2; docs/design/FACTORY.md).** Every draft-10 pack loads unchanged:
nothing existing changes meaning; everything below is new and optional.
(1) **Goods.** Besides Materials, Magic and Intel, every pack may name the factory's goods: `wood`, `stone`, `ore`,
`grain`, `planks`, `iron`, `bread`, `tools`, `weapons` — in a card's `cost`, a use's `cost` and `gives`, a slot's
`each_season`, `upkeep`, `{ "pool": "<good>", "add": n }`, `{ "income": "<good>", "add": n }`, a rule's `{ "pool":
"<good>", "n": n }` and `need`, a condition's `{ "pool": "<good>", "gte": n }`, a law's income, a leader's pools and
income. A pack may declare goods of its own: top-level `"goods": [{ "id": "silk", "name": "Silk", "icon": "🧵",
"made": true }]`. An unknown name is an error ("Unknown pool or good"). Materials stays a good of its own (old packs
pay in it; the factory makes it at the builder's yard).
(2) **Clicks**: a thing's `"clicks_per_crew": 1` — each crew posted on it gives so many clicks a season, shared by its
uses (its recipes): every use of the thing then needs a click, and a use there with no `times` is capped only by the
clicks. It needs a slot for crews.
(3) **Eating**: a thing's `"eats": { "bread": 1 }`, `"eats_per": 3` (for every 3 crews of the town, rounded up;
absent: once), `"if_hungry": { "unrest": 1 }` — taken from the stock as each season ends; short, what there is is
eaten and `if_hungry` applies once; the news says "The houses went hungry: 1 of 2 Bread."
(4) **`stock`**: top-level `{ "wood": 4, "labor": 1 }` — goods and pieces given when a run begins.
(5) **`used:<use id>`** is accepted as a rule's event (draft 10 said so; the validator now agrees).
(6) A thing with only `eats` (no slots, no uses) is a work too (the houses). Example: `src/season/factory.ts`.

## Draft 10 (2026-11-17: crews and soldiers as pieces, slots, uses)

**Changed since draft 9 (card table, docs/design/TURN_PUZZLE.md).** Every draft-9 pack loads unchanged: nothing
existing changes meaning; everything below is new and optional.
(1) **Pieces.** Labor is counted in crews and Might in soldiers, one piece each. A card's `"labor": 2` ties up 2 crews
until it is built (as before); `{ "pool": "labor", "add": 1 }` is a new crew, `-1` takes one away (free ones first).
(2) **Slots** on a thing: `"slots": [{ "takes": "crew" | "soldier", "n": 1..6, "each_season": { "materials": 1 } }]`
— room for `n` pieces of that kind; the player posts free pieces there and calls them back (each piece moves at most
once a season). A posted piece is not free for cards. `each_season` is what EACH piece there gives when a season ends
(goods or Unrest; a rule like upkeep, shown in the Rules list). A thing with a crew posted on it carries the tag
`crewed`, with a soldier `manned`; pieces on a ruined thing come back. Posted soldiers still fight a raid at home.
(3) **Uses** on a thing: `"uses": [{ "id": "<pack>-…", "name", "cost": { … }, "gives": { … }, "times": 1, "per":
"crew" | "soldier", "needs": "crew" | "soldier", "text" }]` — the player makes a use at once (INSTANT): its cost is
taken and what it gives is added now, at most `times` a season (default 1). `cost`: goods, or `labor` / `might` (free
pieces given up for good). `gives`: any pool, over 0 (Unrest may go down). `per`: what it gives is for each piece of
that kind posted on the thing now. `needs`: it can be made only while a piece of that kind is posted there. A use that
would give nothing cannot be made. Each use is a fact event `used:<id>`, so a rule may wait for it (`"on": { "event":
"used:<id>" }`).
(4) **Rules count pieces**: `"per": { "posted": "crew" }` — `n` for each crew posted on the first things matched.
(5) **`start`**: a top-level list of the pack's thing ids in play when a run begins in a town that has none of them yet.
Example: the base game's works, `src/season/works.ts` (mine, shrine, market stalls, foundry, muster ground, granary,
watchtower, wall walk; crews hired out, ore from the hills, recruits trained; three needs with deadlines). At the card
table they are on by default (the board then takes 5 opportunities and 2 needs at once).

## Draft 9 (2026-11-17: points of interest, free towns, the shield's energy)

**Changed since draft 8 (loop round 14, 2026-11-17).** Every draft-8 pack loads unchanged.
(1) **Points of interest** (see "Points of interest"): places on the map that are not towns — `camp`, `lair`,
`tower`, `crash`, `battlefield`, `vault`, `temple`, `bridge`, `dungeon`, `giant`. A new effect puts one on the map,
`{ "poi": "<kind>", "id": "<pack>-…", "name": "…", "near": "town" | "$var" | "poi:<id>", "holder": "<faction>" }`;
a new effect changes one, `{ "poi_state": "cleared" | "gone" | "standing", "where": "$var" | "poi:<id>" }`; a new
variable binds one, `{ "poi": { "kind": [...], "state": ["standing" | "cleared"], "tags": [...], "not": [...],
"holder": "<faction>" } }`. The raiders' camp is one: `poi:raiders-camp` (kind `camp`, holder `raiders`); cleared
or gone, the raiders have no camp (no "Raiders on the road" unless they hold a town). The rules read a POI as a thing:
`poi`, its kind, `standing` or `cleared`, its holder's id, the pack tags set on it. (2) **`far:free:<n>`**: the `n`
nearest standing towns nobody holds (not yours, no faction's) — in `far`, `mutate`, `sign`, `trade`. (3) **A
shield's energy**: an ability's `in_event` with `shield` may say `"energy"` (its store, over 0) and `"regen"` (what
it gets back a second, 0 or more); a shield also stops fire and units now, and gives way when what presses on it
drains its store (lava at its rim, fire there, foes there). Without them: energy 100, regen 2. (4) **Berserk** (an
ability's `in_event.berserk`) now takes anyone within its reach, your own people too (every unit has a blow). Examples:
`packs/frontier.json` (break the raiders' camp, a wolf lair and its clearing; `league-grows` now `far:free:1`),
`packs/ages.json` (a crash site, a temple; the Fire ward's energy; the lava front's vent 160 cells up the slope).

**Added in loop round 12 (2026-11-17), no change to anything existing:** an event's `hazard` may be a front, `lava` or
`flood`, with the amount `reached`; an ability's `in_event` may raise a `shield` (with `seconds`). See events and
abilities. Example: `packs/ages.json`.

**Added in loop round 13 (2026-11-17), no change to anything existing:** weathers (see "Weather"): three more signs,
`rain`, `storm` and `fog`, and a top-level `weather` list naming the weather of seasons of the run. Example:
`packs/ages.json`.

**Changed since draft 7.** (1) **The raid is a card** (see "The raiders and the end of a run"): no arc is timed when
a run begins. The raiders are the base game's faction (`"raiders"`); their standing threat "Raiders on the road" is
dealt while they are hostile and have somewhere to come from, counts down to the last season and, left to run out,
brings the raid. A world with no raiders has no raid. A pack brings its own final threat the same way: a `threat`
card with a long `offer_seasons` and an `end_run` or a ruin in `if_expires`. (2) **A run ends** when its last season
ends (16) or by `end_run`; reaching the end is the ending "The town stands". (3) **A leader can start in a far town**:
a leader's `home` (see "Leaders and ages"). (4) **Unlocks** (see "Unlocks"): `{ "unlock": "<id>" }` opens locked
content — a card, a leader, or the pack — for this run and every later run of the world; `"locked": true` and
`"hint"` on cards, leaders and the `pack` block; the condition `{ "met": ... }`. (5) **Between runs** (see "Between
runs"): a top-level `between_runs` list — what moves in the world while nobody plays — and its effect `law_ends`.
(6) A sign can be set `"for_good": true`; every other sign fades between runs. (7) The base event `farm-burned` is gone;
`raiders-march` is new. (8) A forced live card (a raid, refugees) begins whatever card stands at its place.

**Write templates about kinds of places, not places.** The owner: "The dealer can always generate cards from
parameterized templates to fit the actual world." A card may name variables in `bind` instead of fixed places: "a far
town that stands and is not yours", "a found place", "a faction you have a truce with", "a site with a workshop". The
dealer offers one card for each binding it finds worth offering, in the world as it is: on another map, or in a world
changed by earlier runs, the same pack deals different cards. A fixed place is still allowed (it is a binding with one
candidate) and every draft-6 pack loads unchanged. Full example: `packs/frontier.json`.

**Changed since draft 6.** (1) **Templates** (see "Templates"): a card's `bind` declares variables (`site`, `far`,
`faction`), used as `"$town"` in places and `by`, and as `{town}` in the title, pitch and `say`; the presenter may sit
at a bound site (`"at": "$place"`); `"set_off": true` binds a variable to what the rule that offered the card matched;
`once` is once for each binding (`"once": "run"`: once a run whatever it binds). (2) **Factions** (see "Factions"): a
top-level `factions` list; a faction can take, swear, destroy and found towns (`by`), hold them, have a stance with
you and with other factions (`{ "stance": ..., "to": "truce" }`), and be read by conditions (`faction_holds`,
`faction_stance`) and rules (its id is the tag of what it holds). (3) **Found places**: `{ "far": "revealed", "id",
"name", "resource" }` marks a place on the map that nobody has settled; `{ "far": "founded", "where": "$find" }`
settles it; the camp carries the resource tag. (4) **Far towns are things of the rules**: `far-town`, its state,
`standing`/`ruined`, `yours` or the faction's id, its resource, `founded`, `colony` — so a colony's income is a rule
and stops when the colony is lost. The home town carries `<faction>:<stance>`. (5) The record names what a card was
bound to: `{ "resolved": "card", "about": "$town" }`. (6) The table's "Far places" reads as news: who holds what,
who stands with whom, what changed and which card did it. (7) **Leaders and ages** (see "Leaders and ages"): a pack's
`leaders`, offered while the world fits (the record, far places, factions), with their own start (pools, things,
laws, cards out of the deck); `replaces` hides the base leaders; `laws_after_if` on a card; the table's "The world
now" at a run's start. Example: `packs/ages.json`.

**Changed since draft 5.** (1) **Laws** (see "laws"; design: `docs/design/LAWS.md`): a new top-level block `laws`,
each one thing that changes the rules of the game for the rest of the run — tags, rules, card costs, spells and
events, the run, other laws. (2) A law comes into force from a new effect `{ "law": "id" }` (rest of the run) or
`{ "law": "id", "seasons": 2 }` in any effect list (cards, results, an ability's effect), from a thing's new
`"laws": [...]` (while it is in play and not ruined), or from a rule's new act `{ "law": "id" }`. (3) A rule may say
`"fires": 2`: it pays twice each time it fires. (4) **Settle it now**: the player may end a live event at once with
the casts made so far; its result and what it sets off happen at once, so a chain's next step can come the same
season (see "Chains"). (5) `packs/arena.json`'s open bout gets harder with each win, by a law. Example of every law
kind: `packs/laws.json`. (6) **Endings and the world's record** (see "Endings and the record"): an effect or a rule
act `end_run` ends the run at once (won, fell, or an ending of your own); `far_all` changes every far town at once;
the record of every card resolved or run out is kept from run to run, and `resolved` can ask it for a result, a place
and an earlier run; a ruined thing keeps what it was as `remains-of-<tag>`; a card's `laws_after` stand in every later
run. Example: `packs/glitter.json`. (7) **The whole world map** (see "Places"): far place selectors (`far:all`,
`far:nearest:<n>`, `far:where:<state>`, `far:<id>` of a place the pack founds, `world`) in `mutate`, `far`, `sign`
and `trade`; signs anywhere; trade routes by an effect or a policy thing.

**Changed since draft 4.** Rules can chain (see "Chains"): (1) a rule can wait for a live event's RESULT,
`"on": { "live": "raid", "tier": ["success"] }`; (2) a rule's effect can be an act: `offer` a card, `start` a live
card, `tag` or `untag` the thing it matched; (3) what an act causes sets off other rules. Example: `packs/arena.json`.
(4) **Engines are not limited** (the owner's ruling): a rule fires every time its trigger occurs — `perSeason` no
longer defaults to 1 — and `cap` is no longer required. Loops are allowed; each turn of one costs the player an
action or a season (see "Cascades"). (5) The base raid is 18 raiders and the tribute 15 Materials.

**Changed since draft 3.** (1) Several packs load together; `packcheck` gives a TOGETHER report; shared custom tags
take `"shared": true` (see "Several packs together"). (2) The event names a rule can wait for are a fixed, tested
list; any other name is refused. (3) New words: a thing's `upkeep`, a card's `weight`, an ability's `in_event`.
(4) A rule on another pack's event kind is a LOOK in its own file and checked in the TOGETHER report.
(5) Still not built: `arrive` with a count or of anything but refugees; far places other than the neighbour;
`units`; `offer`; a pack tag that ruins; choices with more than take or leave.

**Changed since draft 2.** (1) Rules fire. (2) Events play, and a card with `live` is dealt like any other.
(3) An event has no `where`: it plays at the place of the card that starts it. (4) A `live` card needs an `if_tier`
entry for every result its event can give; `if_taken` is not allowed on it. (5) `crowd` needs a group tagged
`crowd`. (6) An event may list only `fire`, `heat-ray`, `rain`, and what each does to an event is fixed (below).
(7) An effect may set `festival` and `growth-active` but no longer `sheltered`. (8) New base cards whose ids are
taken: `raid`, `gate-parade`, `refugees-arrive`, `resettle-refugees`, `market-fire`. (9) Event kind `refugees` exists.

A pack is one JSON file: a themed set of opportunity cards, the things they put in play, the synergy rules between
those things, live events, and abilities. It is written for an outside author (a person or a model) who has not seen
the code. The loader (`src/packs/load.ts`) turns a pack into the engine's own types; the validator
(`src/packs/check.ts`) rejects what the engine cannot do and says why in plain words.

**Check a pack:** `node scripts/packcheck.mjs your-pack.json`. Fix every line marked FIX. Lines marked LOOK are
warnings. **Try a pack:** open `table.html`, open "Packs" at the bottom, pick the file (or `table.html?pack=<url>`).
A new run starts with the pack's cards mixed into the base cards.

**What is played today** (at the card table; the 3D game does not load packs yet):

| Block | Today |
|---|---|
| `cards` | Played: dealt with the base cards, cost paid, effects applied, expiry applied. |
| `things`, `tags` | Played: shown in play with their tags; a thing on a ruined site shows `ruined` instead. |
| `abilities` | Played: unlocked by a card, cast on a thing in play for Magic. |
| `rules` | Played: they fire with the base game's rules, and the Rules list says what each lacks. |
| `events`, cards with `live` | Played without real time: the event card shows who is in it, the rules that apply and the result it would have now; the player casts spells into it; it resolves when the season ends, or at once when the player settles it. |
| `laws` | Played: in force while their source stands, in their own list; every number shown follows them. |

Anything a pack needs that is not in the vocabularies below goes in the pack's `wants` list, in plain words, instead
of being invented inline. The validator rejects invented fields.

## The game in five lines (for the author)

- A run is 16 seasons in one town (a leader may start in a far town). It ends when the last season ends, or at once by
  an ending. The raiders, while they threaten, are a card counting down to an attack in the last season. Each season
  the player sees 3 to 6 opportunities, each presented by a named person at a place in the town, and takes a few.
- Six pools: `magic`, `might`, `labor`, `materials`, `intel`, `unrest`. Unrest is bad: each point keeps one free
  worker away. Labor and Might are people: a cost LOCKS them while the card is built, then they come back. Materials,
  Magic and Intel are goods: a cost SPENDS them. Each Might is 3 soldiers.
- Taking a card costs pools and puts THINGS in play: buildings, garrisons, policies, effects. Things carry TAGS.
- RULES read tags and pay off: "a worked field with an active growth rune yields double". Finding and stacking rules
  is the fun. Rules must be thematically obvious so a player can guess them.
- THREATS are cards that count down to a bad outcome unless answered. LIVE EVENTS (a raid, a parade, a fire) play in
  the city; the player casts ABILITIES into them; they resolve by themselves at season end. Outcomes change the real
  world: land floods or burns, towns fall, refugees arrive. Nothing is rolled: the same choices give the same result.

## File shape

```json
{
  "pack": { "id": "volcano", "name": "The Mountain Wakes", "version": 1,
            "summary": "One or two plain sentences.",
            "appears_when": [ { "town_has": ["home"] } ],
            "themes": ["fire", "ash", "refugees"] },
  "tags":      [ ... ],
  "things":    [ ... ],
  "cards":     [ ... ],
  "rules":     [ ... ],
  "events":    [ ... ],
  "abilities": [ ... ],
  "laws":      [ ... ],
  "factions":  [ ... ],
  "leaders":   [ ... ],
  "between_runs": [ ... ],
  "wants":     [ "plain-word requests for effects, tags or looks the vocabularies lack" ]
}
```

## Templates (draft 7)

A card's `bind` names its variables. Each is one of:

```json
"bind": {
  "place": { "site": { "tags": ["workshop"], "not": ["ruined"] } },
  "town":  { "far": { "state": ["standing"], "tags": ["trade-partner"], "not": ["yours"], "holder": "frontier-reavers" } },
  "find":  { "far": { "state": ["found"] } },
  "foe":   { "faction": { "stance": ["hostile"] } },
  "cove":  { "far": { "tags": ["frontier-reavers"] }, "set_off": true }
}
```

- `site`: a site of the home town whose thing carries every tag in `tags` and none in `not` (the same words a rule
  reads, lent tags included).
- `far`: a far town (or, with the state `found`, a place found and not settled) in one of the `state`s (`standing`,
  `destroyed`, `abandoned`, `occupied`, `vassal`, `founded`, `found`), carrying every tag and none of the `not` tags,
  held by `holder` (`"player"` or a faction, or a faction variable `"$foe"`). Far towns carry the tags in "Far towns
  as things".
- `faction`: a faction of a loaded pack, at one of these stances with the player (or with `with`).
- `"set_off": true`: for a card a rule offers or starts: one of the things the rule's `a` matched.
- Use a variable as `"$town"` wherever a place goes (`where`, `on`, `at`, `trade` is not yet), as `by` (`"$foe"`), and
  in `faction_holds`, `faction_stance` and `resolved` … `about`. Write `{town}` in the title, the pitch and `say`: the
  player reads the real name. The words written from the effects name it too.
- The presenter may sit at a bound site: `"presenter": { "role": "smith", "at": "$place" }`.
- **One card per binding.** The dealer scores each binding like any card; a site holds one card at a time, so a
  template at a fixed site offers its bindings one after another. `once` (default true) is once for each binding: the
  card about Millbrook done, the same card about Vellford can still come. `"once": "run"`: once a run, whatever it
  binds. `false`: it comes back.
- The record keeps what a card was bound to: `{ "resolved": "frontier-relief", "about": "$town" }` holds when that
  card was done about this town (in any run).
- The validator refuses a variable used but not bound and a `{name}` that is not a variable; a variable nothing in the
  pack can feed (a holder that never holds a town, a `found` place nothing reveals) is a LOOK: another pack or an
  earlier run may feed it.
- Name a variable one lowercase word other than `other` (`{other}` is the neighbour).

## Factions (draft 7)

```json
"factions": [ { "id": "frontier-reavers", "name": "the Gull Reavers", "kind": "pirates", "text": "Sea raiders …" } ]
```

- A faction is a thing of the world, made once and kept run after run. `kind` is a note (pirates, rival towns, a
  guild). Its id is prefixed with the pack's.
- **What it does** (always by a card: a faction acts when the player takes a card or lets one run out — write what it
  does when the player does nothing in `if_expires`): `by` in `far` (`captured`, `vassal`, `destroyed`, `abandoned`,
  `founded`) and `far_all`.
- **What it holds**: a town it occupies, a town sworn to it, a camp it founded. That town carries the faction's id as
  a tag (`"a": { "tags": ["far-town", "frontier-reavers"] }`); a town you hold carries `yours`.
- **Stance**: `{ "stance": "frontier-reavers", "to": "truce" }` (`hostile`, `truce`, `allied`, or `none` to end it);
  `"with": "frontier-league"` for a stance between two factions. The home town carries `frontier-reavers:truce`.
- **Conditions**: `{ "faction_holds": "frontier-reavers", "gte": 2 }` (towns it holds that stand; `"player"`: towns
  you hold), `{ "faction_stance": "frontier-reavers", "is": ["truce", "allied"] }` (`"with"` optional; `none`: no
  stance).
- **A live event's foes**: tag a group with the faction's id (`"tags": ["frontier-reavers", "boat-crew"]`).
- A deal is a card that sets a stance and usually puts a policy thing in play with an upkeep (tribute paid) or a rule
  that pays (a cut of their takings); breaking it is another card, or the card that runs out.
- The world's own factions (the Millbrook Council …) cannot be named by a pack yet.

## Leaders and ages (draft 7)

Who the player is in the next run depends on the world. A pack may declare `leaders`:

```json
"leaders": [ { "id": "ages-ash-chief", "name": "Chief Cinder", "line": "Chief of the ash tribe. Few hands, little to build with.",
               "appears_when": [ { "resolved": "ages-fire-mountain", "tier": ["lapsed"] } ], "replaces": true,
               "pools": { "magic": 0, "might": 1, "labor": 3, "materials": 2, "intel": 1, "unrest": 0 }, "income": { "materials": 1 },
               "things": ["ages-ash-camp"], "laws": [], "deck_out": { "themes": ["build"], "ids": ["ages-peace"] } } ]
```

- A leader is offered at a run's start while the world fits its `appears_when`, read on the world before the run:
  `resolved` (the record, any earlier run), `far_town_is`, `faction_stance`, `faction_holds`. Nothing else.
- `replaces`: while this leader can be chosen, the base game's three leaders cannot (the world has moved past them).
- The start: `pools` (what the run starts with), `income`, `things` of the pack put in play, `laws` of the pack in force
  for the run, `deck_out` (cards out of this run's deck, by id or theme; the base building cards have the theme
  `build`; the raid stays).
- The table's "The world now" says, at a run's start: which run and who leads; how each earlier run ended and by what;
  the far places and the town now (gone, yours, ruins, signs); the laws earlier runs left.
- **An ending for good**: an `if_expires` (or result) that burns the town's sites, puts `ashfall` on `"world"`,
  `far_all` destroys every far town and `end_run` ends the run; its `laws_after` stand in every later run.
  `"laws_after_if": ["lapsed"]` (results or `lapsed`): only when the card ended so — the world burns only if nobody
  stopped it. Put the ash on the world `"for_good": true`, or it fades before the next run. Example: `packs/ages.json`.
- **(draft 8) A home of their own**: `"home": { "far": { "state": [...], "tags": ["yours"], "not": [...], "holder":
  "player" } }` (the words of a card's far variable). The run is played FROM the nearest far town that fits; the leader
  is offered only while one does. That town is home: its own 20 sites (the same names as any town's), its own things
  and ruins. The old home becomes a far town (yours, if nobody else holds it); what a town built is kept on it for a
  run that comes back. Examples: frontier's Steward Hal Brook (`"tags": ["yours"]`), Captain Merrow (the Reavers'
  haven), ages' Speaker Oru (the Star City).
- **(draft 8)** `"locked": true` and `"hint"`: offered only once unlocked (see "Unlocks"). A leader's `appears_when`
  may use `met`.

## The raiders and the end of a run (draft 8)

The owner: "We should not have a separate raid mechanism it should be a card." The raiders are the base game's
faction: a pack names them `"raiders"` in `by`, `far_all` and `met`. They start hostile, with a camp on the road.
While they are hostile and their camp stands (or they hold a far town), the base card "Raiders on the road" is dealt
from a fifth of the run on, over the whole town (it keeps no site busy). Its countdown runs to the end of the season
before the last; paid (15 Materials) the raiders keep a truce for the run; left, they march, and the raid (the live
event) begins in the last season. The run then goes on to its end. Between runs the truce lapses, and raiders leave a
world with no far town standing. The header shows the standing threat's own countdown: the threat on the board with
the most seasons left.

**A pack's own final threat**: a `"threat": true` card with a long `offer_seasons` whose `if_expires` ends the run or
ruins the town (it waits its turn in the one-threat slot like any threat). Nothing else ends a run early: factions act
only through cards (taken or left to run out).

## Unlocks (draft 8)

The owner: "a meta progression from encountering or exploring to unlock new content for the next run." No store of its
own: an unlock is a line in the world's record.

- `{ "unlock": "<id>" }` in any effect list: an ability of the pack (this run only, as before), or locked content of
  the pack — a card's id, a leader's id, or `"pack:<pack id>"` — open from now on in this world, this run included.
  The card that did it is kept with the line.
- `"locked": true` on a card, a leader or the `pack` block: never dealt or offered until unlocked. `"hint"`: one plain
  line the player reads in "Not yet found" ("Find out where the black sails come from."). The validator says to LOOK
  at locked content nothing unlocks, and at locked content with no hint.
- `{ "met": "frontier-reavers" }` (a faction named in the record, `"raiders"` too), `{ "met": "place:frontier-redscar" }`
  (a place found or founded), `{ "met": "ending:won" }` (a run of this world ended so: `won`, `fell`, `stood`, or a
  pack's own word, or the start of an ending's name). In cards' and leaders' `appears_when`.
- Shown: at a run's end, "New for later runs" (what, and from which card); at a run's start, "The world now": "Earlier
  runs opened: …" and "Not yet found: <hints>" (and how many have no hint).
- Examples: frontier (meeting the Reavers opens Captain Merrow and the Reaver pilot; scouting opens the old survey
  maps), ages (each age's ending opens the next age's leader and cards), glitter (the glass ending opens the salvage).

## Between runs (draft 8)

The owner: "At least during the run it being gamified is good. Between runs is another lever for balance." During a
run only cards change the world. When a new run of a world begins, years have passed: one step applies the base
game's entries (the raiders' truce lapses; raiders leave a world with no far town; signs not set `for_good` fade;
ruined far towns grow over), then each pack's:

```json
"between_runs": [
  { "id": "league-grows", "when": [ { "faction_holds": "frontier-league", "gte": 2 } ],
    "do": [ { "far": "vassal", "where": "far:nearest:1", "by": "frontier-league" } ],
    "say": "The Tollmark League bought the nearest free town. It swears to the League now." } ]
```

- `when`: conditions on the world and the record (no season, pool or leader: there is no run). `do`: the world's
  words only — `far`, `far_all`, `mutate`, `sign`, `stance`, `trade`, `unlock`, and `{ "law_ends": "<law id>" }` (a law
  a card's `laws_after` left stops standing). `say`: the line the next run reads, "While you were gone: …".
- It runs once, in order (the base game's first), the same way every time. Each entry that applies is a line in the
  record. Use it for balance: a faction that ended strong takes a town; a colony with no support is abandoned; a
  runaway law ends.

## Far towns as things (draft 7)

Every far town is a thing the rules read: `town`, `far-town`, its state (`standing`, `destroyed`, `abandoned`,
`occupied`, `vassal`, `founded`), `standing` or `ruined` (taken by someone else is `ruined` for you), `yours` or the
holding faction's id, its resource tag, `founded` if it was founded, `colony` if it was founded, is yours and stands,
`trade-partner` if it trades with you, and the pack tags set on it (`{ "tag": "frontier-burned-out", "on": "$town" }`).
A found place not settled is a thing with `found` and its resource.

- **Discover, then settle**: `{ "far": "revealed", "id": "frontier-redscar", "name": "Redscar", "resource": "ore" }`
  marks it; a card bound to `{ "far": { "state": ["found"] } }` settles it with `{ "far": "founded", "where": "$find" }`
  (who: `by`, default you; `purpose` optional). Income while it stands is a rule:
  `"a": { "tags": ["colony", "ore", "standing"] }, "effect": { "pool": "materials", "n": 2 }, "per": "a"`.
- A resource is any tag: an existing one (`ore`) or the pack's (declare `timber` with `"on": "far-town"`, shared if
  other packs read it).

Ids are lowercase words joined by hyphens, unique in the whole pack (a card and a thing may not share one), and
prefixed with the pack id (`volcano-ash-sweepers`). A card id may not be one of the base game's. The pack's
`appears_when` is added to every card's. Target size: 12 to 20 cards, 6 to 10 rules, 1 or 2 threats, 1 to 3 live
events, 2 to 4 abilities. A full example that passes the validator: `packs/sample.json`.

## Points of interest (draft 9)

The owner: "make any interesting poi like this. Bandit camps, monster lairs, wizard towers, giants bound to the land,
crash sites of star ships, ancient battlefields, bridges, dungeons, vaults, temples to channel magical nodes etc."

A point of interest (POI) is a place on the world map that is not a town. Only a card makes, changes or removes one;
nothing happens to it on a timer.

```json
{ "poi": "lair", "id": "frontier-greyden", "name": "the Grey Den", "near": "$town" }
{ "poi_state": "cleared", "where": "$lair" }
"bind": { "lair": { "poi": { "kind": ["lair"], "state": ["standing"] } } }
```

- **Kinds**: `camp`, `lair`, `tower`, `crash`, `battlefield`, `vault`, `temple`, `bridge`, `dungeon`, `giant`. The
  kind sets how far from `near` it goes and its colour on the map; it does not yet change what is built there (a
  plain marker: a thread of smoke and a column of sparks, until each kind has its own look).
- **Where it goes**: near `near` — `"town"` (the default: the home town), a far or POI variable, or `"poi:<id>"` —
  at the kind's distance (a camp 90-160 cells, a crash site 120-240), on the side farthest from every town and every
  other POI. The same card in the same world puts it in the same place. You do not give coordinates.
- **States**: `standing` (the default), `cleared` (taken out: a lair emptied, a camp broken), `gone` (off the map;
  the record keeps it). `{ "poi_state": "standing" }` puts a cleared one back.
- **Holder**: `"holder": "<faction>"` (or `"raiders"`): who keeps it. A holder's POI is no town it holds
  (`faction_holds` counts towns only).
- **The rules read it as a thing**: `poi`, its kind, `standing` or `cleared`, its holder's id, and the pack tags set on
  it (`{ "tag": "frontier-haunted", "on": "$lair" }`).
- **The raiders' camp** is a POI from the start of every world: `poi:raiders-camp`, kind `camp`, holder `raiders`.
  Clearing it (`{ "poi_state": "cleared", "where": "poi:raiders-camp" }` or a `camp` variable) leaves the raiders
  nowhere to ride out from: "Raiders on the road" is no longer dealt (unless they hold a far town). Allying with them
  is a `stance`, as before. In 3D a raid comes down the road that points nearest their camp.
- A card that names `poi:<id>` comes up only while that POI is on the map. A POI variable binds a POI that is on the
  map (not `gone`).
- Shown: a pin on the atlas map in the kind's colour (a cleared one says so); in 3D, when the window holds it, the
  plain marker. The card table lists POIs with the far places.

## Places

A place is the home town, one of its sites, or places on the whole world map. Nothing else is accepted.

- `"town"`: the home town.
- `"site:<name>"`: one of the town's 20 named sites. The names, with what each is (its tags):
  `keep` (keep), `forge` (workshop), `quarter` (homes), `fields` (field), `market` (market), `gate` (gate),
  `tower` (tower), `dam` (water, dam), `shrine` (temple), `mill` (workshop, mill), `wall` (rampart),
  `watch` (gate, watch), `harbour` (water, quay), `quarry` (quarry), `woods` (woods), `river` (water, river),
  `road` (road), `pit` (workshop, ore), `wagons` (yard), `graves` (graves).
  A site is named by its NAME, not by a tag: `site:fields`, not `site:field`.
- `"far:neighbour"`: the nearest standing town. A card that names it appears only while such a town stands.
- **Far place selectors** (draft 6), in `mutate`, `far` (not `founded`), `sign` (`"where"`), `trade`, a thing's
  `trade`. Each names every town it matches, nearest the home town first:
  - `"far:all"`: every far town, whatever its state.
  - `"far:nearest:2"`: the 2 nearest standing towns.
  - (draft 9) `"far:free:1"`: the nearest standing town nobody holds — not yours, not sworn, taken or founded by
    anyone.
  - `"far:where:<state>"`: every far town that is `standing`, `destroyed`, `abandoned`, `occupied`, `vassal`,
    `founded`, `trade-partner`, or `founded-by-player`.
  - `"far:<id>"`: a place this pack founds (`{ "far": "founded", "id": "copper-ford", ... }`), once it exists.
  - `"world"`: every town, the home town too (`mutate` and `sign` only).
  A card whose effects name a selector appears only while it names at least one town. The words are written for you:
  "Darkness falls over every far town for 3 seasons.", "Each of the 2 nearest standing towns is abandoned."
- **Signs anywhere**: `{ "sign": "darkness", "where": "far:all", "seasons": 3 }` (`where` absent or `"town"`: the
  home town, as before).
- **Trade routes**: `{ "trade": "far:nearest:2" }` makes those towns trade partners for good; `"end": true` ends
  it. A thing's `"trade": "far:all"` makes them partners while the thing stands (a policy, a caravan charter). A
  partner carries `trade-partner` (and `standing` or `ruined`), so rules read it; the trade road's wagons and ships
  scale with the partners still standing.
- Not built: `arrive` from a selector (refugees come only from the neighbour); a selector in a condition (use
  `far_town_is`).

## tags

New tags the pack introduces. Existing tags (below) need no entry and must not be declared again.

```json
{ "id": "ash-covered", "on": "site", "meaning": "Ash lies on it; fields under ash do not yield.", "timed": false }
```

- `on`: `site`, `town`, `far-town`, `unit`, `effect`. A note for the reader; the engine does not use it.
- `timed`: true if it lasts only to the end of the season it is set in.
- A pack tag cannot ruin a thing. Only the existing ruin tags remove working tags; they are set with `mutate`.

**Existing tags.** What a site is: `keep`, `workshop`, `mill`, `ore`, `homes`, `field`, `market`, `gate`, `watch`,
`tower`, `water`, `dam`, `river`, `quay`, `temple`, `rampart`, `quarry`, `woods`, `road`, `yard`, `graves`, `camp`.
State: `standing`, `worked` (people work there), `growth-active` (timed), `festival` (timed), `sheltered`.
Ruin (these remove working tags): `burned`, `flooded`, `buried`, `melted`, `abandoned`, `destroyed`, `occupied`,
`lost`, shown together as `ruined`. The home town: `town`, `home`, `wall`, `garrison`, `unrest`. Far towns:
`trade-partner`, `standing`.

The game sets the existing tags itself. An effect may set only the pack's own tags and `festival`,
`growth-active` (both timed).

## things

What a card puts in play. Shown to the player as a small card with its tags.

```json
{ "id": "volcano-ash-sweepers", "name": "Ash sweepers", "kind": "policy",
  "at": "town", "tags": ["ash-crew"],
  "text": "Crews clear ash from roofs and fields each season.",
  "art": "A line of townsfolk with brooms and carts on a grey street, warm lantern light, painterly." }
```

- `kind`: `building`, `garrison`, `policy`, `effect`, `relic`, `people`.
- `at`: `"town"` or `"site:<name>"`. A thing on a site that is ruined shows `ruined` and loses its tags.
- A thing's tags are also carried by the place it stands at: a granary on `site:fields` makes the east fields a
  `granary` too, and a policy `at: "town"` gives the home town its tags. So a rule can ask for one thing with
  `["field", "granary"]`, or `["home", "night-watch"]`.
- At least one tag. `capacity`: a number, kept for later (nothing reads it yet).
- `"upkeep": { "materials": 2 }`: goods taken each season while it is in play (`materials`, `magic`, `intel`; not
  people). It shows in the Rules list as "Upkeep: <name>" and in the log each season. If the pool is empty nothing
  is taken and nothing else happens: an unpaid thing still stands. A number in the thing's `text` must be a number
  of its upkeep or capacity.
- `"laws": ["law-id", ...]`: laws of this pack in force while the thing is in play and its place is not ruined.
  They leave with it, and come back if it stands again.
- (Draft 10) `"slots"` and `"uses"`: room for crews and soldiers, and instant uses. See the change list at the top.
  A number in the thing's `text` may be a slot's `n`; a number in a use's `text` must be one of its cost, gives or times.

## cards

```json
{ "id": "volcano-shelter-the-valley", "title": "Shelter the valley folk",
  "presenter": { "name": "Maud Fenner", "role": "miller", "at": "site:mill" },
  "pitch": "What the presenter says, one or two plain sentences, first person.",
  "appears_when": [ { "far_town_is": ["destroyed"] }, { "season_gte": 3 } ],
  "threat": false, "once": true,
  "offer_seasons": 3,
  "cost": { "materials": 3, "labor": 2 },
  "build_seasons": 1,
  "if_taken":   [ { "put": "volcano-refugee-camp", "at": "site:gate" },
                  { "pool": "unrest", "add": -1 },
                  { "say": "Tents go up by the gate." } ],
  "if_expires": [ { "pool": "unrest", "add": 2 },
                  { "say": "They sleep in the road. The town mutters." } ],
  "live": null,
  "leads_to": ["volcano-put-them-to-work"],
  "art": "Image prompt, one sentence." }
```

- `presenter.at` must be a `site:<name>`. It is where the card sits. One card per site at a time, so spread a pack's
  cards over several sites. `presenter.role` is a trade ("miller"). `presenter.name` is a note only: the game names
  the person who holds that trade in the town and keeps that name all run.
- `cost`: whole numbers. `labor` and `might` are locked for `build_seasons` (1 to 4, default 1) and come back.
  `materials`, `magic`, `intel` are spent. Unrest cannot be a cost.
- `if_taken` applies when the build is done, `build_seasons` after the card is taken.
- `threat: true`: it is on the board whatever the player holds and its `if_expires` is the bad outcome;
  `offer_seasons` (default 3) is the countdown. Only one threat stands at a time, so a threat may wait its turn.
- `once`: default true. `false` lets the card come back after a rest of 3 seasons.
- `"weight": 1` to `5` (optional): how soon the card comes up among the cards whose conditions hold and whose site
  is free. 5 comes up as soon as it can; 3 is a middling base card; 1 comes up when little else fits. It is not a
  chance: nothing is random. For a threat it orders the threats that are waiting.
- `if_expires` is required for a threat and expected for every card: passing should cost or risk something.
- `leads_to`: cards that can only appear after this one is done. Prefer state (`appears_when`) over fixed chains.
- `live`: an event id from `events`; then `if_tier` replaces `if_taken`:
  `"if_tier": { "triumph": [...], "success": [...], "cost": [...], "failure": [...], "disaster": [...] }`
  There must be one entry for every result the event's `tiers` can give, each with a `say`. A `live` card has no
  `if_taken`. Taking the card starts the event; the season's end resolves it. If the card is not taken,
  `if_expires` applies as for any card. Its "if you take it" line is the event's `how`.

**What the player reads.** The card's "if you take it" and "if you leave it" lines are written by the loader from the
effects, so the numbers are always the real ones: your `say` sentences first, then one short sentence per effect
("+1 Materials each season.", "Unrest +1.", "The mill street burns."). Do not repeat the numbers in `say` unless you
want them said twice. Any number you do write in `say` or `pitch` must be a number in the card's cost or effects.

**Conditions** (`appears_when`; each object is one test; all must hold):
- `{ "pool": "unrest", "gte": 3 }` or `"lte"`: a pool's free amount now.
- `{ "season_gte": 4 }`: 1 to 15.
- `{ "has_thing": "id" }` · `{ "no_thing": "id" }`: a thing of this pack is, or is not, in play — a ruined thing
  is still in play, as remains. For a thing that still stands, ask for its own tag: `{ "site_has": ["glitter-tech"] }`
  (a ruin carries `remains-of-glitter-tech` instead).
- `{ "town_has": ["tag", ...] }`: the home town carries all of them.
- `{ "site_has": ["tag", ...] }`: some one site, or thing on a site, carries all of them.
- `{ "far_town_is": ["destroyed"] }`: some far town is in one of these states: `standing`, `destroyed`,
  `abandoned`, `occupied`, `vassal`, `founded`.
- `{ "resolved": "card-id" }`: that card of this pack was taken and is done.
- `{ "leader": "ysolt" }`: the run's leader. Ids: `ysolt` (soldier), `dunstan` (builder), `ilveth` (tower keeper).
- (draft 7) `{ "faction_holds": "frontier-reavers", "gte": 1 }`, `{ "faction_stance": "frontier-reavers", "is":
  ["truce"] }`, and `"about": "$town"` on `resolved` (see "Templates" and "Factions").
- (draft 8) `{ "met": "frontier-reavers" }`, `"place:<id>"`, `"ending:<word>"` (see "Unlocks").
- Not supported yet: `{ "sign": ... }`. Use `resolved` of the card that set the sign.

**Effects** (`if_taken`, `if_expires`, `if_tier`; in order):
- `{ "pool": "magic", "add": 2 }`: now. A whole number, not 0. `{ "pool": "might", "add": 1 }` adds 3 soldiers.
- `{ "income": "materials", "add": 1 }`: every season from now. Goods only (`materials`, `magic`, `intel`).
- `{ "put": "thing-id", "at": "site:fields" }` (`at` optional: the thing's own) · `{ "remove": "thing-id" }`.
- `{ "tag": "ash-covered", "on": "site:fields" }` · `{ "untag": "ash-covered", "on": "site:fields" }`. `on`: a
  site or `"town"`. Only the pack's own tags and `festival`, `growth-active`.
- `{ "mutate": "flooded", "where": "site:dam" }`: a real change to the land. Kinds: `flooded`, `burned`, `melted`,
  `buried`, `dried`, `withered`, `greened`. `where`: a site, `"town"`, `"far:neighbour"`, a far place selector or
  `"world"` (see "Places"). The first four ruin a site: it shows `ruined` and things on it lose their tags.
- `{ "far": "captured", "where": "far:neighbour", "by": "raiders" }`: kinds `captured`, `vassal`, `destroyed`,
  `abandoned`. `where`: the neighbour, a far place selector or a far variable (`"$town"`). `by`: `raiders`, `player`,
  `dead`, a faction of the pack or a faction variable. A vassal's `"tribute": n` is recorded on the map only; add a
  rule on `["vassal", "yours"]` for what it pays. `{ "far": "founded", "id": "copper-ford", "name": "Copper Ford",
  "purpose": "mining" }` founds a new camp in the hills (`purpose`, `by`, `resource` optional); `{ "far": "founded",
  "where": "$find" }` settles a found place; `{ "far": "revealed", "id", "name", "resource" }` marks one (draft 7).
- `{ "stance": "frontier-reavers", "to": "truce", "with": "player" }` (draft 7; see "Factions").
- `{ "sign": "ashfall", "seasons": 3, "strength": 0.7, "where": "far:all" }`: kinds `ashfall`, `darkness`,
  `deadrise`, `crime`, and (loop round 13) the weathers `rain`, `storm`, `fog` (see "Weather"). Strength 0 to 1.
  `where`: absent or `"town"` (the home town), a far place selector, `"world"`.
- `{ "trade": "far:nearest:2" }` (`"end": true` to end it): those towns trade with the home town.
- `{ "arrive": "refugees", "count": 40, "from": "far:neighbour" }`: people walk in by road. Only refugees, only
  from the neighbour, always 40.
- `{ "unlock": "ability-id" }`: an ability of this pack, or `heat-ray`. (Draft 8) Or locked content: see "Unlocks".
- (Draft 8) `"for_good": true` on a `sign` (no `seasons`): it does not fade between runs.
- `{ "law": "law-id" }`: a law of this pack comes into force for the rest of the run; `"seasons": 2`: for the rest
  of this season and 2 more. See "laws".
- `{ "say": "One plain sentence the player reads." }`: at least one per branch.
- Not supported yet (the validator says what to write instead): `units` (use `pool` `might`), `offer` (use
  `resolved` on the later card), `arrive` of wagons or soldiers, `arrive` from anywhere but the neighbour.

## Weather (loop round 13)

A weather is a named bundle of what the world already does: the prevailing wind, a storm held over the town (rain on
the ground, puddles, fires put out), how often storms pass, the sky dimmed, ash falling, fog. The weathers:

| Weather | What the player sees |
|---|---|
| `fair` | The weather as it always was: a light wind, a storm passing now and then. The default. |
| `clear` | No storms; a light wind. |
| `rain` | A rain cloud over the town; more wind; storms pass more often; the sky a little dim. |
| `storm` | A storm over the town: hard rain, strong wind, a dark sky; more storms come. |
| `ashfall` | Grey ash falling and settling; the sky dim and brown; little wind. |
| `fog` | A pale fog over the land; the wind drops. |
| `dark` | The sky goes dark and brown, as under smoke. |

**By a card:** a sign on the town. `{ "sign": "storm", "seasons": 1, "strength": 0.7 }`; the signs `rain`, `storm`,
`fog`, `ashfall` and `darkness` (the weather `dark`) are weathers. Strength scales the weather (0.5: half the storm).

**By season:** a top-level `weather` list. Each entry names seasons of the run and their weather:
`{ "season": 3, "weather": "fog" }` (season 3), `{ "from": 10, "weather": "ashfall" }` (season 10 on),
`{ "from": 4, "to": 6, "weather": "rain" }`. The last entry that covers a season wins; seasons no entry covers are
`fair`. With several packs, their lists are read in the packs' order.

**Together:** a card's weather sign is laid over the season's weather. Where both set the same thing, the stronger
wins: the darker sky, the more ash, the stronger storm.

Example (`packs/ages.json`): the eruption's card brings a storm on the town when the lava took streets
(`{ "sign": "storm", "seasons": 1, "strength": 0.7 }` in `cost`, strength 1 in `failure`), and the pack's list rains in
seasons 8 and 9 and lays ash from season 14:

```json
"weather": [ { "from": 8, "to": 9, "weather": "rain" }, { "from": 14, "weather": "ashfall" } ]
```

At the card table a weather sign shows as a sign on the town; the season's weather shows only in the 3D game.

## rules

The engine's own format (`RuleDef`), unchanged. A rule fires every time its trigger happens and its things exist;
the player is told `why`.

```json
{ "id": "volcano-blessed-fields", "name": "Rune-fed fields",
  "on": "turn",
  "a": { "tags": ["field", "worked", "growth-active"] },
  "effect": { "pool": "materials", "n": 2 },
  "cap": 2,
  "why": "the growth rune doubled the crop on {a}: +{n} Materials" }
```

- `on`: `"turn"` (each season) · `{ "live": "parade" }` (when that kind of live event is read) · `{ "event": "name" }`
  (when that is written in the world's history; each firing still counts against `perSeason`). The names a rule can
  wait for, each tested:
  - `"pack-done:<card-id>"`: a card of a loaded pack was taken and is done. `"pack-lapsed:<card-id>"`: it ran out.
  - a land change to a SITE by any card, base or pack: `burned`, `flooded`, `melted`, `buried`, `dried`, `withered`,
    `greened`.
  - the base game's events: `built`, `made-safe`, `scouts-seen`, `raiders-march`, `tribute-paid`, `raid-held`,
    `raid-broke`, `raid-missed`, `lens-lit`, `camp-opened`, `camp-held`, `camp-lost`, `relieved`, `fell`,
    `refugees-arrived`, `refugees-housed`, `refugees-resettled`, `refugees-turned-away`, `dead-burned`, `dead-loose`,
    `parade-held`, `parade-thin`, `fire-fought`, `sellswords-hired`, `spell-cast`, `ability-cast`.
  Any other name is refused.
- `a` and optional `b`: `{ "tags": [...], "not": [...], "near": { "of": "a" | "event" | "route", "cells": 90 } }`.
  All tags must be on one thing. `near` is optional; 70 cells is "passes by", 90 "next to", 110 "close".
  `near` goes on `b` when it is `"of": "a"`. `"event"` and `"route"` exist only for a rule `on` a live event.
- `need`: `{ "pool": "unrest", "lte": 2 }` (optional).
- `effect`: a pool (`{ "pool": "magic", "n": 1 }`), or one of a live event's numbers
  (`{ "amount": "crowd", "op": "add" | "mul", "n": 0.5 }`; only for a rule `on` a live event).
- `per`: `"a"`, `"b"` (n for each thing matched) or `{ "amount": "crowd", "each": 6 }` (n per 6 of the crowd).
- `cap` (optional): the most one firing may add ("the temple holds so many"). Leave it out for a rule that pays
  whatever it counts; the validator only says LOOK when a rule with `per` has none.
- `perSeason` (optional): the most firings a season. Leave it out and the rule fires every time its trigger occurs.
  (The base game's 14 rules each say `perSeason: 1`: they were balanced that way.)
- `fires` (optional, default 1): it pays so many times each time it fires; each time is a firing of its own.
- `why`: plain words; `{a}` `{b}` the things' names, `{n}` how much, `{count}` how many matched. Write the amount as
  `{n}`, never as a digit.

Write rules so they cross packs: read general tags (`field`, `temple`, `water`, `garrison`, `festival`), not only the
pack's own.

## Chains

A thing in play can make one event lead to the next: win a fight, and a harder challenger comes. Full example:
`packs/arena.json` (a fighting pit; three bouts, each started by the win before; each win pays and draws a crowd).

**Wait for a result.** `"on": { "live": "bout", "tier": ["success", "triumph"] }` fires AFTER the event's result
is picked, when it is one of those. (`{ "live": "bout" }` with no `tier` still fires BEFORE, and is the only kind
that can change an amount.) A result rule can change a pool or act; it cannot change an amount.
Waiting for a card: `{ "event": "pack-done:<card-id>" }`, `{ "event": "pack-lapsed:<card-id>" }`.

**Acts**, in place of a pool or an amount in `effect`:
- `{ "offer": "card-id" }`: that card is asked of the player from the next deal. The player may take it or leave it.
- `{ "start": "card-id" }`: for a card with `live`: its event begins by itself, as the raid does. The card must have
  no `cost`. The player casts into it that season and it resolves at the season's end.
- `{ "tag": "tag-id", "on": "a" }` · `{ "untag": "tag-id", "on": "a" }`: on every thing the rule's `a` matched. The
  pack's own tags, `festival` or `growth-active`. A tag declared `timed` lasts to the end of the season.
- `{ "law": "law-id" }` (optional `"seasons": n`): a law of this pack comes into force. Laws stack: a rule that
  makes the same law each time it fires puts it in force once more each time.

**A card that a rule offers or starts comes up ONLY that way.** Its own `appears_when` is not used (the validator
says to remove it). It is not counted against the board's three cards, so it is there the season it is asked for,
unless another card stands at its site. `once` still holds: a `once` card that is done never comes back.

**How a chain runs, and why it ends.**
- When an event's result is picked: the result rules fire in order (a tag one sets is seen by the next), then the
  rules that wait for the card's `pack-done`. So "the win makes the pit `pit-champion`" can be followed, in the same
  moment, by "a done bout at a `pit-champion` pit starts the next bout".
- A started or offered card is dealt at the next deal. Results are picked at a season's end, so left alone **each
  step of a chain takes one season**: bout 1 in season 5, bout 2 in season 6, bout 3 in season 7.
- **Settle it now.** The player may end a live event at once with the casts made so far (one move). Its result,
  the rules it sets off and the card a rule starts or offers come at once: win, settle, the next challenger, win
  again, all in one season, each step a move and its casts. An event not settled by hand ends at the season's end.
- An act that changes nothing is no firing: the card is on the table or asked for already, a `once` card is done,
  the tag is there already.

**Cascades: loops cost an action or a season.** Engines are not limited. A rule fires every time its trigger
occurs; multipliers stack (a doubling on a doubling is four times); nothing clamps a number except that a pool does
not go below 0. `perSeason` and `cap` are the author's own words for flavour ("the temple holds so many"): nothing
asks for them. What stops a loop from running by itself is how the game is built:
- A CASCADE is everything set off by ONE player action (a card taken, a spell cast, the season ended) or one
  season's turn. In a cascade a rule fires once on each occurrence of its trigger, and rules set off rules.
- An act never takes effect inside the cascade that caused it. An offered card waits to be taken. A started event
  waits for the player to cast into it and for the season to end. So the next turn of a loop always costs the
  player an action or a season. A loop can go on for the whole run; it cannot go on by itself.
- A chain that comes back to itself is allowed and is the fun: win → challenger → win → challenger, for as long as
  the player keeps winning and paying. The validator says to LOOK at it, so you check what one turn pays against
  what it costs.
- The only stop in the engine is a defect detector: 10,000 firings in one cascade is reported as an engine error
  naming the chain. It is not a rule of the game, and no pack can reach it by design.

**Two engines, both in `packs/arena.json`.**
1. *The loop.* After the Red Wolf is beaten, `arena-open-pit` starts an open bout. `arena-keeps-coming` waits for
   `pack-done:arena-open-bout` at a `pit-champion` pit and starts the same card again (`"once": false`). One turn:
   the player casts Fire (1 Magic a hopeful past the first) to win; the win tags the pit `pit-champion` for the
   season, pays 2 Materials and, by `arena-purse`, 1 Magic. Each win also makes the law `arena-rising-hopefuls`
   (rule `arena-word-spreads`): one more hopeful in every bout, so turn 1 costs 1 cast, turn 2 costs 2, turn 3 costs
   3. Lose once (no cast) and the pit is no champion's: nothing starts the next bout.
2. *The multiplier stack.* A parade's `crowd` is 13 with nothing else. With a champion's pit: `arena-crowd` adds 3
   (16), `arena-drums` doubles it (32), then the result rule `arena-collection` pays 1 Materials for every 5 of the
   crowd with no cap (6). Add another pack's doubling of `crowd` and it pays 12. Order matters for amounts: rules
   run base first, then packs in load order, in file order; an `add` before a `mul` is doubled with it.

**What the player sees.** The log reads a chain as a chain: "A name to beat → Two caravan guards call you out: good
result → Rule: The Red Wolf hears. …". An event's card lists what each result will set off. The Rules list says
what an acting rule will do in words ("Then this begins at once: "Two caravan guards call you out".").

A `why` of an acting rule has no amount: do not write `{n}` in it.

## events

```json
{ "id": "volcano-ember-rain", "tag": "fire",
  "title": "Embers on the thatch", "how": "Call rain on the flames.",
  "groups": [ { "who": "worker", "count": 6, "tags": ["bucket-line"], "from": "site:river", "order": "go",
                "formation": "line", "to": "event" } ],
  "hazard": { "kind": "fire", "points": 5, "spread": 30 },
  "seconds": 90,
  "abilities": ["rain"],
  "amounts": ["burned"],
  "tiers": [ { "tier": "triumph", "when": [ { "amount": "burned", "lte": 0 } ] },
             { "tier": "cost",    "when": [ { "amount": "burned", "lte": 2 } ] },
             { "tier": "disaster" } ] }
```

- An event plays at the place of the card that starts it (`presenter.at`). It has no place of its own.
- `tag` is what rules trigger on. Existing kinds: `raid`, `parade`, `fire`, `rising` (the dead), `refugees`. A new
  kind is allowed if it can be told with the fields here; otherwise put it in `wants`.
- How it ends when nobody plays it in real time (the card table, and the season's end in the 3D game): every group
  with the order `go` arrives; foes (`raider`, `dead`) stay up; every lot of a fire burns. Each cast then changes
  that: `fire` puts down 1 foe, `heat-ray` 2 foes, `rain` puts out 2 burning lots. Each cast costs 1 Magic. Then the
  rules `on: { "live": tag }` change the amounts, and the first `tiers` row that holds is the result.
- `abilities`: which of `fire`, `heat-ray`, `rain` may be cast into it, and this pack's abilities with `in_event`
  (see abilities).
- An event needs at least one group or a hazard. A group needs a whole-number `count` and at least one tag.
- `groups`: `who` is `soldier`, `raider`, `worker`, `cart`, `dead`; `order` is `go`, `guard`, `attack`;
  `formation` is `column`, `line`, `loose`; `from` and `to` are sites, `"gate"`, `"road"` (off the map edge) or
  `"event"`.
- `hazard`: `fire` (stalls at the event's place set alight), or (loop round 12) a **front**: `lava` or `flood`. A
  front is poured `far` paces uphill of the event's place — the highest ground on a ring that far out — at `rate`
  for `pour` seconds, and runs down the ground as it lies. Its `points` are spots within `spread` paces of the
  event's place; its result is how many it reached. What it reached is changed for good, whatever the result: lava
  leaves black rock (the houses there are destroyed), a flood drowns them; the land it crossed on its way too.
  Defaults: `far` 36, `rate` 220, `pour` 45. `far` must be more than `spread`. Lava is thick: on flat land it piles
  round its vent and goes only some 25-40 paces however long it pours, so keep `far` near the town (on a slope it
  goes farther). If the land falls away from the place on every side, nothing reaches it: that is the land's truth.

  ```json
  "hazard": { "kind": "lava", "points": 8, "spread": 26, "far": 36, "rate": 220, "pour": 45 }
  ```
- `amounts`: numbers the event ends with, which rules can change and tiers read: `crowd` (the people of groups
  tagged `crowd` who arrived; give such a group the order `go`), `stopped` (starts at 0; only rules add to it),
  `burned` (lots burned; needs a fire hazard), `reached` (a front's points it reached; needs a `lava` or `flood`
  hazard. Nobody there: all of them; a shield cast: none, at the card table), `alive:<group tag>`, `dead:<group tag>` for a tag one of the
  event's groups has. A rule may only change an amount the event lists. The base game's rules change `burned` in
  every `fire` event, `stopped` in every `raid` and `crowd` in every `parade`, so an event of one of those kinds
  must list that amount. A pack rule on a base kind may name only that kind's numbers: raid `raiders`, `alive`,
  `soldiers`, `fallen`, `stopped`; parade `crowd`, `marching`, `out`; fire `lots`, `burned`, `alight`; rising `up`.
- `tiers`: the first row whose `when` holds is the result. Each test is `{ "amount": ..., "lte" | "gte": n }`. The
  last row has no `when`. The validator refuses a row that can never be reached.
- `seconds` optional; with none it runs until it ends by itself or the season does.

## abilities

What the player casts on a thing in play, or into a live event (`in_event`, below).

```json
{ "id": "volcano-ash-ward", "name": "Ash ward", "cost": { "magic": 1 },
  "target": { "tags": ["field"] }, "effect": [ { "tag": "warded", "on": "target" } ],
  "text": "Cast it on a field. Ash does not settle there this season.",
  "look": "a pale dome shimmers over the furrows" }
```

- `cost`: Magic only, a whole number.
- `target.tags`: a thing in play must carry all of them to be a legal target. Ruined things are never targets. The
  thing's OWN tags count, not tags lent to it: `["field"]` aims at the east fields, `["granary"]` at the granary
  itself and not at the fields it stands on.
- `effect`: `tag` or `untag` with `"on": "target"`, or `pool`. Nothing else yet.
- **Into a live event** (in place of, or beside, `target` + `effect`):
  `"in_event": { "kinds": ["raid"], "kills": 3 }` or `{ "kinds": ["fire"], "douses": 3 }`. Each cast puts down that
  many foes, or puts out that many burning lots, in any live event of one of those kinds, the base game's too.
  Exactly one of `kills` and `douses`. Fire does 1, Heat ray 2, Rain 2: above 3 the validator says to look.
  (Loop round 10, the owner's toy spells.) Or `{ "kinds": ["bout"], "berserk": 8 }`: (draft 9) everyone within 8
  cells of the tap — foes and your own people alike, a crowd of townsfolk too: every unit has a blow — turns on anyone
  near them, one another too, and anyone takes them on — or `{ "kinds": ["bout"], "hides": 6 }`:
  your people within 6 cells are hidden: no foe goes for them, and they are not drawn. Exactly one of the five. In
  the 3D game these act on the units themselves (the card table has no units: there they do nothing yet). Example:
  `packs/arena.json` Red mist and Veil.
  (Loop round 12.) Or `{ "kinds": ["eruption"], "shield": 26, "seconds": 75 }`: a shield 26 paces round the tap
  for 75 seconds (60 if `seconds` is left out). Lava and flood water cannot flow into it and part round it; what is
  inside stays as it was. It is drawn as a dome of sparks. (Draft 9) Fire does not burn or spread inside it, and no
  one walks through its edge, in or out — your people and foes alike. It has a store of energy: `"energy": 300`
  (over 0; 100 if left out) and `"regen": 12` (what it gets back a second, 0 or more; 2 if left out). As a guide
  (loop round 14): lava piled all round a 26-pace shield drains about 19 a second; one foe at its edge 1. Lava standing at
  its edge, fire burning there and foes pressing on it drain the store; when the store is empty it gives way at once
  (a burst of light) and the player is told. It ends with its energy or its time. At the card table a shield cast
  into a front means the front reaches none of its points (the table has no energy yet). `seconds`, `energy` and
  `regen` go with `shield` only. Rain does nothing to a front. Example: `packs/ages.json` the Fire ward, its card "Learn the court's fire ward", and the eruption "The
  mountain spits fire" that the wizards' first working starts.
- A pack ability must be unlocked by a card (`{ "unlock": "id" }`). It is the player's for that run; it is written
  in the run's history, so a saved run keeps it.
- Existing abilities, which must not be declared again: `growth-rune` (on a field: it is `growth-active` this
  season), `fire`, `rain` (every leader has these three), `heat-ray` (unlocked by a card). Each costs 1 Magic.
  Not built: `gust`, `telekinesis`. Say what should be seen in `look`.

## laws

A law changes the rules of the game for the rest of the run: what a tag means, what a rule gives, what a card
costs, what a spell does, how the run is won. The player reads every law in force in the "Laws in force" list, with
who or what made it and how long it stands; a card that brings a law says so, and says every line that would change
("Rune-fed fields. Now: Gives +2 Materials, at most 2. With it: Gives +4 Materials, at most 4."). There are no limits
on power: broken combinations are wanted. Full example of every kind: `packs/laws.json`.

```json
{ "id": "volcano-ash-feeds", "name": "Ash feeds the soil", "does": { "spare": "burned" } }
```

- `name`: what the player reads in the list. The words of what it does are written by the game from `does`.
- `does`: exactly one of the words below.
- **How it comes into force** (nothing else does it): an effect `{ "law": "id" }` or `{ "law": "id", "seasons": 2 }`
  in `if_taken`, `if_expires`, `if_tier` or an ability's `effect`; a thing's `"laws": [...]`; a rule's act
  `{ "law": "id" }`. A law nothing brings is a LOOK. A law names only laws of its own pack.
- **How long.** From a thing: while it is in play and its place is not ruined. With `seasons`: the rest of this
  season and so many more. Otherwise: the rest of the run. No law outlives the run; a thing that stands into the next
  run brings its law back.
- **Order.** Laws apply in the order they came into force; two laws on one number give a different number in the
  other order. Laws stack: the same law twice is in force twice.

**Tags.**
- `{ "count_as": { "tag": "field", "as": "temple" } }`: whatever carries the first tag also carries the second.
- `{ "grant": "temple", "to": { "tags": ["worked"], "not": [] } }`: every thing that matches carries the tag
  (`"tags": []`: every thing in play). A ruined thing is given nothing.
- `{ "spare": "burned" }`: that ruin word no longer ruins: the place keeps its working tags and carries the word.

**Rules** (a base rule's id, or a rule of a loaded pack):
- `{ "rule": "blessed-fields", "set": { "n": 4, "cap": null, "each": 3, "perSeason": 2 } }`: numbers set; `null`
  removes `cap` or `perSeason`.
- `{ "rule": "blessed-fields", "times": 2 }`: `n` and `cap` multiplied.
- `{ "rule": "...", "on": ... }`, `"a": { ... }`, `"b": { ... }`: its trigger or its queries replaced.
- `{ "rule": "...", "off": true }`: it is off; the Rules list shows it struck through.
- `{ "rule": "...", "fires": 2 }`: it pays twice each time it fires.
- `{ "add_rule": { a whole rule, as in "rules" } }`: a rule that exists only while the law stands. A thing that
  carries rules is a thing that carries this law.

**Cards** (`"cards": { "themes": ["build"] }` or `{ "ids": [...] }` picks the cards; leave it out for every card.
The base game's building cards have the theme `build`):
- `{ "cost": { "materials": -1 }, "cards": ... }`: so much more or less of each pool; no cost below 0.
- `{ "pay": { "labor": "magic" }, "cards": ... }`: that part of the cost is paid from the other pool.
- `{ "build": -1, "cards": ... }`: seasons to build; 1 at least.
- `{ "stay": 1, "cards": ... }`: seasons a card dealt from now stays on offer.
- `{ "pool_as": { "unrest": "might" } }`: in a fight each point of the pool counts as 1 Might (3 soldiers).

**Spells and events** (spells: `fire`, `heat-ray`, `rain`, `growth-rune`):
- `{ "spell": "fire", "kills": 3 }` / `"douses": 3`: what one cast does in a live event.
- `{ "spell": "fire", "also_tag": "growth-active", "on": { "tags": ["field"] } }`: each cast also gives every
  match the tag for the season (the pack's own tags, `festival`, `growth-active`).
- `{ "event": "parade", "allow": ["fire"] }`: spells that may be cast into that kind of event.
- `{ "event": "bout", "shift": 1 }`: its results move one step better (`-1`: worse), among the results it can give.
- `{ "event": "bout", "foes": 1 }`: one more foe in each group of foes.
- `{ "event": "parade", "tier": ["failure"], "counts_as": { "live": "raid", "tier": ["failure"] } }`: that result
  also sets off the rules that wait for the other kind's result.

**The run:**
- `{ "board": 1 }`: cards on offer at once. `{ "income": { "materials": 2 } }`: goods each season.
- `{ "raiders": { "add": -4 } }` or `{ "raiders": { "times": 0.5 } }`: the raid's size.
- `{ "win": { "count": 6, "tags": ["temple"] } }`: a new way to win: the run ends won when that many things carry
  the tags.

**Laws about laws:**
- `{ "multipliers": 2 }`: every multiplier is twice as big — a rule's `mul`, a law's `times` — whenever it came.
- `{ "next_law": "run" }`: the next law to come into force lasts the rest of the run, whatever its source; then
  this law is used up.

**Not built yet** (put them in `wants`): a law that changes the run's length (fixed when the run begins); the number
of threats at once. A law outlives the run only through a card's `laws_after`, and `law_ends` between runs ends it.

## Endings and the record

The owner: "cards and engines can get crazy … Since we allow perspective to shift and civilizations to fall between
runs we can allow broken mechanics." and "Just keep the history of resolved cards." Full example:
`packs/glitter.json` (a spire raised in one run burns the valley to glass; the next run salvages its ruins).

- **End the run.** `{ "end_run": "won", "name": "The dead rule the valley, and you rule the dead" }` in any effect
  list (a card taken or left, an event's result), or as a rule's act. `"won"`, `"fell"`, or a word of your own. The
  run ends at once; the end screen says what ended it and who.
- **Change every far town.** `{ "far_all": "abandoned", "by": "dead" }`: `captured`, `destroyed` or `abandoned`;
  `by` is `raiders`, `player` or `dead`. It stays changed in every later run, like any change to the world.
- **The record.** Every card resolved (with its result) or left to run out is kept with its place, its run and its
  leader, run after run; the table lists it by place ("Run 1, Sister Ilveth: Raise the glitter spire. Done.").
  What a card put in play stays in the world: standing, or, if its place was ruined, as remains that carry what it
  was: a ruined spire tagged `glitter-tech` carries `ruined` and `remains-of-glitter-tech`. A burned field carries
  `remains-of-field`.
- **Ask the record.** `{ "resolved": "card-id", "tier": ["success"], "at": "site:tower", "run": "earlier" }`:
  `tier` (results, or `"lapsed"`), `at` (a place) and `run` (`"earlier"`: a run before this one; `"any"`) are all
  optional. Ask for remains with `site_has` / `town_has`: `{ "site_has": ["ruined", "remains-of-glitter-tech"] }`.
  A card that is on the table because of earlier runs says so in one line.
- **Laws that outlive the run.** A card's `"laws_after": ["law-id"]`: once the card is in the record (done or run
  out), these laws stand from the first season of every later run of that world. This is how an ending changes the
  world for good: the undead dominion, the glass sky.

**Units as recipes** (designed, not built: docs/DECISIONS.md round 85, "Recipe-driven civilizations"). Today a pack
writes a unit's parts as things with plain shared tags — `mount`, `armour`, `training`, `power` — and a rule that
combines them with `garrison`: hoverbikes (`mount`, `power`) and a garrison make "knights on glass saddles". Declare
these tags `"shared": true` so packs combine. When the recipe system comes, it reads the same tags as ingredients: a
live event's groups are made from the composed unit (a knight is a person, training, armour and a mount; the mount a
horse or a hoverbike), and the unit's numbers come from its ingredients instead of a rule. Packs written today keep
working.

## Several packs together

Packs are made to be loaded together. Check a set with one command; after each file's own report comes a TOGETHER
report: `node scripts/packcheck.mjs a.json b.json c.json d.json`. Play a set: pick several files in the page's
"Packs" drawer (each has a "Take out" button), or `table.html?pack=a.json,b.json`. Bots:
`node scripts/tablebots.mjs --pack a.json,b.json`. The example pair is `packs/cross-a.json` + `packs/cross-b.json`.

- **Ids** of cards, things, rules, events and abilities must differ across packs: start each with the pack's id. A
  rule may not use a base rule's id (`blessed-fields`, `temple-procession`, `garrisoned-walls`, `gate-market`,
  `water-by-fire`, `sullen-festival`, `harvest-home`, `tower-watch`, `forge-by-keep`, `camp-hands`, `garrison-pay`,
  `roofs-to-mend`, `idle-hands`, `bread-for-all`).
- **A pack cannot name another pack's thing, card or ability** (`has_thing`, `no_thing`, `resolved`, `leads_to`,
  `put`, `remove`, `unlock` take this pack's ids). Packs read each other through TAGS.
- **Existing tags** are always shared: a rule on `["field", "worked"]` sees every pack's and the base game's fields.
- **A shared custom tag**: every pack that produces or reads it declares it in its own `tags` list with the same
  `id`, `on` and `timed`, and `"shared": true`. The id is not prefixed with a pack id. `"shared": true` stops the
  "nothing produces / nothing reads" warnings for the one file; the TOGETHER check then looks over the whole set and
  refuses a tag declared with a different `timed` or `on` in two packs.
- A thing lends its tags to its place, so two packs' things on one site combine: pack A's seed store on
  `site:fields` makes the east fields `seed-stored`, and pack B's rule on `["field", "seed-stored"]` pays.
- **A rule about another pack's card or event kind** (`{ "event": "pack-done:<their card>" }`, `{ "live": "<their
  kind>" }`) gets a LOOK when its file is checked alone and is checked for real in the TOGETHER report. A rule that
  changes an amount of another pack's event kind must name an amount that event lists.
- One card stands at a site at a time, over all packs and the base game: the TOGETHER report says to look when more
  than 3 cards of the set stand at one site. One threat stands at a time: it says to look above 4 threats.
- Rules run in this order: the base game's, then each pack's in the order the packs were loaded, in file order.

## Rules for the writing

- Player text is plain and concrete: who, what, how much. No lore paragraphs, no invented jargon, no exclamation.
- Every number in text must match the data beside it. The validator checks digits in `say`, `pitch`, an ability's
  `text` and a rule's `why`. It cannot check numbers written as words ("forty"), so write digits.
- Each card has a cost, an effect if taken and an effect if it expires. Passing must cost something or risk something.
- Named presenters are townspeople with a trade and a place; reuse 6 to 8 trades across the pack so they become known.
- A pack should contain its own small engine (two or three rules that feed each other), at least one rule that pays
  off with another pack's tags, one choice between two good things that cannot both be had, and one threat whose
  answer depends on what the player built earlier.
- Art prompts: one sentence each, same style line for the whole pack, no text in the image.
