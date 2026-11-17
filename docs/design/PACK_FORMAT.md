# Opportunity pack format (draft 5, 2026-11-16: rules that chain)

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
| `events`, cards with `live` | Played without real time: the event card shows who is in it, the rules that apply and the result it would have now; the player casts spells into it; it resolves when the season ends. |

Anything a pack needs that is not in the vocabularies below goes in the pack's `wants` list, in plain words, instead
of being invented inline. The validator rejects invented fields.

## The game in five lines (for the author)

- A run is 16 seasons in one town. The attack comes in the last, so there are 15 seasons of choices. Each season the
  player sees 3 to 5 opportunities, each presented by a named person at a place in the town, and takes a few.
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
  "wants":     [ "plain-word requests for effects, tags or looks the vocabularies lack" ]
}
```

Ids are lowercase words joined by hyphens, unique in the whole pack (a card and a thing may not share one), and
prefixed with the pack id (`volcano-ash-sweepers`). A card id may not be one of the base game's. The pack's
`appears_when` is added to every card's. Target size: 12 to 20 cards, 6 to 10 rules, 1 or 2 threats, 1 to 3 live
events, 2 to 4 abilities. A full example that passes the validator: `packs/sample.json`.

## Places

A place is written one of three ways. Nothing else is accepted.

- `"town"`: the home town.
- `"site:<name>"`: one of the town's 20 named sites. The names, with what each is (its tags):
  `keep` (keep), `forge` (workshop), `quarter` (homes), `fields` (field), `market` (market), `gate` (gate),
  `tower` (tower), `dam` (water, dam), `shrine` (temple), `mill` (workshop, mill), `wall` (rampart),
  `watch` (gate, watch), `harbour` (water, quay), `quarry` (quarry), `woods` (woods), `river` (water, river),
  `road` (road), `pit` (workshop, ore), `wagons` (yard), `graves` (graves).
  A site is named by its NAME, not by a tag: `site:fields`, not `site:field`.
- `"far:neighbour"`: the nearest standing town. It is the only far place a card can name. A card that names it
  appears only while such a town stands.

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
- `{ "has_thing": "id" }` · `{ "no_thing": "id" }`: a thing of this pack is, or is not, in play.
- `{ "town_has": ["tag", ...] }`: the home town carries all of them.
- `{ "site_has": ["tag", ...] }`: some one site, or thing on a site, carries all of them.
- `{ "far_town_is": ["destroyed"] }`: some far town is in one of these states: `standing`, `destroyed`,
  `abandoned`, `occupied`, `vassal`, `founded`.
- `{ "resolved": "card-id" }`: that card of this pack was taken and is done.
- `{ "leader": "ysolt" }`: the run's leader. Ids: `ysolt` (soldier), `dunstan` (builder), `ilveth` (tower keeper).
- Not supported yet: `{ "sign": ... }`. Use `resolved` of the card that set the sign.

**Effects** (`if_taken`, `if_expires`, `if_tier`; in order):
- `{ "pool": "magic", "add": 2 }`: now. A whole number, not 0. `{ "pool": "might", "add": 1 }` adds 3 soldiers.
- `{ "income": "materials", "add": 1 }`: every season from now. Goods only (`materials`, `magic`, `intel`).
- `{ "put": "thing-id", "at": "site:fields" }` (`at` optional: the thing's own) · `{ "remove": "thing-id" }`.
- `{ "tag": "ash-covered", "on": "site:fields" }` · `{ "untag": "ash-covered", "on": "site:fields" }`. `on`: a
  site or `"town"`. Only the pack's own tags and `festival`, `growth-active`.
- `{ "mutate": "flooded", "where": "site:dam" }`: a real change to the land. Kinds: `flooded`, `burned`, `melted`,
  `buried`, `dried`, `withered`, `greened`. `where`: a site, `"town"` or `"far:neighbour"`. The first four ruin a
  site: it shows `ruined` and things on it lose their tags.
- `{ "far": "captured", "where": "far:neighbour", "by": "raiders" }`: kinds `captured`, `vassal`, `destroyed`,
  `abandoned`. `by`: `raiders` or `player`. A vassal's `"tribute": n` is recorded on the map only; add an `income`
  effect for what it pays. `{ "far": "founded", "id": "copper-ford", "name": "Copper Ford", "purpose": "mining" }`
  founds a new camp in the hills (`purpose` optional).
- `{ "sign": "ashfall", "seasons": 3, "strength": 0.7 }`: seen in the home town. Kinds: `ashfall`, `darkness`,
  `deadrise`, `crime`. Strength 0 to 1.
- `{ "arrive": "refugees", "count": 40, "from": "far:neighbour" }`: people walk in by road. Only refugees, only
  from the neighbour, always 40.
- `{ "unlock": "ability-id" }`: an ability of this pack, or `heat-ray`.
- `{ "say": "One plain sentence the player reads." }`: at least one per branch.
- Not supported yet (the validator says what to write instead): `units` (use `pool` `might`), `offer` (use
  `resolved` on the later card), `arrive` of wagons or soldiers, far places other than the neighbour.

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
  - the base game's events: `built`, `made-safe`, `scouts-seen`, `farm-burned`, `tribute-paid`, `raid-held`,
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

**A card that a rule offers or starts comes up ONLY that way.** Its own `appears_when` is not used (the validator
says to remove it). It is not counted against the board's three cards, so it is there the season it is asked for,
unless another card stands at its site. `once` still holds: a `once` card that is done never comes back.

**How a chain runs, and why it ends.**
- When an event's result is picked: the result rules fire in order (a tag one sets is seen by the next), then the
  rules that wait for the card's `pack-done`. So "the win makes the pit `pit-champion`" can be followed, in the same
  moment, by "a done bout at a `pit-champion` pit starts the next bout".
- A started or offered card is dealt at the next deal. Results are picked at a season's end, so **each step of a
  chain takes one season**: bout 1 in season 5, bout 2 in season 6, bout 3 in season 7.
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
   the player casts Fire once (1 Magic) to win; the win tags the pit `pit-champion` for the season, pays 2 Materials
   and, by `arena-purse`, 1 Magic. Lose once (no cast) and the pit is no champion's: nothing starts the next bout.
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
- `abilities`: which of `fire`, `heat-ray`, `rain` may be cast into it. Nothing else can be cast into an event yet.
- An event needs at least one group or a hazard. A group needs a whole-number `count` and at least one tag.
- `groups`: `who` is `soldier`, `raider`, `worker`, `cart`, `dead`; `order` is `go`, `guard`, `attack`;
  `formation` is `column`, `line`, `loose`; `from` and `to` are sites, `"gate"`, `"road"` (off the map edge) or
  `"event"`.
- `hazard`: only `fire`.
- `amounts`: numbers the event ends with, which rules can change and tiers read: `crowd` (the people of groups
  tagged `crowd` who arrived; give such a group the order `go`), `stopped` (starts at 0; only rules add to it),
  `burned` (lots burned; needs a fire hazard), `alive:<group tag>`, `dead:<group tag>` for a tag one of the
  event's groups has. A rule may only change an amount the event lists. The base game's rules change `burned` in
  every `fire` event, `stopped` in every `raid` and `crowd` in every `parade`, so an event of one of those kinds
  must list that amount. A pack rule on a base kind may name only that kind's numbers: raid `raiders`, `alive`,
  `soldiers`, `fallen`, `stopped`; parade `crowd`, `marching`, `out`; fire `lots`, `burned`, `alight`; rising `up`.
- `tiers`: the first row whose `when` holds is the result. Each test is `{ "amount": ..., "lte" | "gte": n }`. The
  last row has no `when`. The validator refuses a row that can never be reached.
- `seconds` optional; with none it runs until it ends by itself or the season does.

## abilities

What the player casts on a thing in play. (Into an event only the three existing spells can be cast: see events.)

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
- A pack ability must be unlocked by a card (`{ "unlock": "id" }`). It is the player's for that run; it is written
  in the run's history, so a saved run keeps it.
- Existing abilities, which must not be declared again: `growth-rune` (on a field: it is `growth-active` this
  season), `fire`, `rain` (every leader has these three), `heat-ray` (unlocked by a card). Each costs 1 Magic.
  Not built: `gust`, `telekinesis`. Say what should be seen in `look`.

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
