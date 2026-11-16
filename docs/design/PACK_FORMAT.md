# Opportunity pack format (draft 1, 2026-11-16)

A pack is one JSON file: a themed set of opportunity cards, the things they put in play, the synergy rules between
those things, live events, and abilities. It is written for an outside author (a person or a model) who has not seen
the code. A loader turns a pack into the engine's own types (`TemplateDef` in `src/living/engine.ts`, `RuleDef` in
`src/living/rules.ts`, `LiveDef` in `src/living/live.ts`); a validator rejects what the engine cannot do.

**Status: the loader and validator are not built yet (BACKLOG CT rows on branch `card-table`).** The `rules` block is
the engine's real `RuleDef`, unchanged. The `cards`, `things`, `events` and `abilities` blocks are a simpler authoring
layer; their fields may shift a little when the loader is written. Anything a pack needs that is not in the
vocabularies below goes in the pack's `wants` list, in plain words, instead of being invented inline.

## The game in five lines (for the author)

- A run is about 16 seasons in one town. Each season the player sees 3 to 5 opportunities, each presented by a named
  person at a place in the town, and takes a few of them. Few decisions per season, however large the realm.
- Six pools: `magic`, `might`, `labor`, `materials`, `intel`, `unrest` (unrest is bad; high unrest weakens the rest).
- Taking a card costs pools and puts THINGS in play: buildings, garrisons, policies, effects. Things carry TAGS.
- RULES read tags and pay off: "a worked field with an active growth rune yields double". Finding and stacking rules
  is the fun. Rules must be thematically obvious so a player can guess them.
- THREATS are cards that count down to a bad outcome unless answered. LIVE EVENTS (a raid, a parade, a fire, a riot)
  play in the city in real time; the player casts ABILITIES into them; they resolve by themselves at season end.
  Outcomes change the real world: land floods or burns, towns fall, refugees arrive. Nothing is rolled: the same
  choices always give the same result.

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

Ids are lowercase with hyphens, unique in the pack, and prefixed with the pack id when they could clash
(`volcano-ash-sweepers`). Target size: 12 to 20 cards, 6 to 10 rules, 1 or 2 threats, 1 to 3 live events, 2 to 4
abilities.

## tags

New tags the pack introduces. Existing tags (below) need no entry.

```json
{ "id": "ash-covered", "on": "site", "meaning": "Ash lies on it; fields under ash do not yield.",
  "timed": false, "ruins": false }
```

- `on`: `site` (a place in the town), `town` (the home town), `far-town`, `unit`, `effect`.
- `timed`: true if it lasts only to the end of the season it is set in.
- `ruins`: true if a thing carrying it loses its working tags (as `burned` does).

**Existing tags.** What a site is: `keep`, `workshop`, `mill`, `ore`, `homes`, `field`, `market`, `gate`, `watch`,
`tower`, `water`, `dam`, `river`, `quay`, `temple`, `rampart`, `quarry`, `woods`, `road`, `yard`, `graves`, `camp`.
State: `standing`, `worked` (people work there), `growth-active` (timed), `festival` (timed), `sheltered`.
Ruin (these remove working tags): `burned`, `flooded`, `buried`, `melted`, `abandoned`, `destroyed`, `occupied`,
`lost`, shown together as `ruined`. The home town: `town`, `home`, `wall`, `garrison`, `unrest`. Far towns:
`trade-partner`, `standing`.

## things

What a card puts in play. Shown to the player as a small card with its tags.

```json
{ "id": "volcano-ash-sweepers", "name": "Ash sweepers", "kind": "policy",
  "at": "town", "tags": ["ash-crew"], "upkeep": { "labor": 1 },
  "text": "Crews clear ash from roofs and fields each season.",
  "art": "A line of townsfolk with brooms and carts on a grey street, warm lantern light, painterly." }
```

- `kind`: `building`, `garrison`, `policy`, `effect`, `relic`, `people`.
- `at`: `town`, or a site by tag (`"site:field"`, `"site:temple"`), or `"far:<role>"` for a far place bound by a card.
- `upkeep`: pools taken each season while it stands (optional). `capacity`: a number rules may read (optional).

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
                  { "say": "Tents go up by the gate. Forty people have a roof." } ],
  "if_expires": [ { "pool": "unrest", "add": 2 },
                  { "say": "They sleep in the road. The town mutters." } ],
  "live": null,
  "leads_to": ["volcano-put-them-to-work"],
  "art": "Image prompt, one sentence." }
```

- `presenter.at` is where the card sits on the map. One card per place at a time.
- `threat: true`: it is on the board whatever the player holds and its `if_expires` is the bad outcome;
  `offer_seasons` is the countdown. A threat should be visible several seasons early.
- `live`: an event id from `events`; taking (or, for a threat, failing to answer) the card starts that event, and the
  event's tier picks which of `if_tier` applies instead of `if_taken`:
  `"if_tier": { "triumph": [...], "success": [...], "cost": [...], "failure": [...], "disaster": [...] }`
  (any subset; nearest lower tier is used when one is missing).
- `leads_to`: cards that can only appear after this one resolves. Prefer state (`appears_when`) over fixed chains.

**Conditions** (`appears_when`, each object is one test, all must hold):
`{ "pool": "unrest", "gte": 3 }` · `{ "season_gte": 4 }` · `{ "has_thing": "id" }` · `{ "no_thing": "id" }` ·
`{ "town_has": ["tag", ...] }` · `{ "site_has": ["field", "worked"] }` · `{ "far_town_is": ["destroyed"] }` ·
`{ "sign": "ashfall" }` · `{ "resolved": "card-id" }` · `{ "leader": "id" }`.

**Effects** (`if_taken`, `if_expires`, `if_tier`, in order):
- `{ "pool": "magic", "add": 2 }` — now. `{ "income": "materials", "add": 1 }` — every season from now.
- `{ "put": "thing-id", "at": "site:field" }` · `{ "remove": "thing-id" }`.
- `{ "tag": "sheltered", "on": "site:camp" }` · `{ "untag": "worked", "on": "site:field" }`.
- `{ "mutate": "flooded", "where": "site:dam" }` — a real change to the land. Kinds: `flooded`, `burned`, `buried`,
  `melted`, `dried`, `withered`, `overgrown`, `abandoned`, `destroyed`. `where`: a site, `"town"`, or `"far:<role>"`.
- `{ "far": "captured", "where": "far:neighbour", "by": "raiders" }` — kinds: `captured`, `vassal` (with `"tribute": n`),
  `destroyed`, `abandoned`, `founded` (with `"purpose": "mining"` optional).
- `{ "sign": "ashfall", "seasons": 3, "strength": 0.7 }` — seen in the home town. Kinds: `ashfall`, `darkness`,
  `deadrise`, `crime`.
- `{ "arrive": "refugees", "count": 40, "from": "far:neighbour" }` — people walk in by road. Kinds: `refugees`,
  `wagons`, `soldiers`.
- `{ "units": "soldier", "add": 4 }` — the garrison. `{ "unlock": "ability-id" }` · `{ "offer": "card-id", "in": 2 }`.
- `{ "say": "One plain sentence the player reads." }` — at least one per branch.

## rules

The engine's own format. A rule fires once per season (unless `perSeason` says more) when its trigger happens and its
things exist; the player is told `why`.

```json
{ "id": "blessed-fields", "name": "Rune-fed fields",
  "on": "turn",
  "a": { "tags": ["field", "worked", "growth-active"] },
  "effect": { "pool": "materials", "n": 2 },
  "cap": 2,
  "why": "the growth rune doubled the crop on {a}: +{n} Materials" }
```

- `on`: `"turn"` (each season) · `{ "live": "parade" }` (during that kind of live event) · `{ "event": "fact-name" }`.
- `a` and optional `b`: `{ "tags": [...], "near": { "of": "a" | "event" | "route", "cells": 90 } }`. All tags must be
  on one thing. `near` is optional; 70 cells is "passes by", 90 "next to", 110 "close".
- `need`: `{ "pool": "unrest", "lte": 2 }` (optional).
- `effect`: a pool (`{ "pool": "magic", "n": 1 }`), or one of a live event's numbers
  (`{ "amount": "crowd", "op": "add" | "mul", "n": 0.5 }`).
- `per`: `"a"`, `"b"` (n for each thing matched) or `{ "amount": "crowd", "each": 6 }` (n per 6 of the crowd).
- `cap`: the most one firing may add (a temple holds so many). Every rule that adds to a pool needs a `cap`.
- `why`: plain words; `{a}` `{b}` the things' names, `{n}` how much, `{count}` how many matched.

Write rules so they cross packs: read general tags (`field`, `temple`, `water`, `garrison`, `festival`), not only the
pack's own.

## events

```json
{ "id": "volcano-ember-rain", "tag": "fire",
  "title": "Embers on the thatch", "how": "Call rain or blow the fire away from the houses.",
  "where": "site:homes",
  "groups": [ { "who": "worker", "count": 6, "tags": ["bucket-line"], "from": "site:river", "order": "go",
                "formation": "line", "to": "event" } ],
  "hazard": { "kind": "fire", "points": 5, "spread": 30 },
  "seconds": 90,
  "abilities": ["rain", "gust"],
  "amounts": ["burned"],
  "tiers": [ { "tier": "triumph", "when": [ { "amount": "burned", "lte": 0 } ] },
             { "tier": "cost",    "when": [ { "amount": "burned", "lte": 2 } ] },
             { "tier": "disaster" } ] }
```

- `tag` is what rules trigger on. Existing kinds: `raid`, `parade`, `fire`, `rising` (the dead). A new kind (`riot`,
  `flood`, `plague-carts`) is allowed if it can be told with the fields here; otherwise put it in `wants`.
- `groups`: `who` is `soldier`, `raider`, `worker`, `cart`, `dead`, `townsfolk`; `order` is `go`, `guard`, `attack`,
  `drill`, `man` (walls), `march`; `formation` is `column`, `line`, `loose`; `from` and `to` are sites, `"gate"`,
  `"road"` (off the map edge) or `"event"`.
- `hazard`: only `fire` exists today.
- `amounts`: numbers the event ends with, which rules can change and tiers read. Existing: `crowd` (who came to
  watch), `stopped` (attackers stopped), `burned` (lots burned), `alive:<group tag>`, `dead:<group tag>`.
- `seconds` optional; with none it runs until it ends by itself or the season does. The first tier whose `when` holds
  is the result; the last has no `when`.

## abilities

What the player casts in the live city or on an in-play card.

```json
{ "id": "growth-rune", "name": "Growth rune", "cost": { "magic": 1 },
  "target": { "tags": ["field"] }, "effect": [ { "tag": "growth-active", "on": "target" } ],
  "text": "Draw it on a field: the crop springs up. The field counts as blessed this season.",
  "look": "green shoots rise in a ring where it is drawn" }
```

Existing: `growth-rune` (fields), `fire` (burns units and lots), `heat-ray` (a line of burn), `rain` (puts fire out,
fills water), `gust` (pushes fire, smoke and light things), `telekinesis` (lifts and throws a body). New abilities
should reuse these effects where they can; say what should be seen in `look`.

## Rules for the writing

- Player text is plain and concrete: who, what, how much. No lore paragraphs, no invented jargon, no exclamation.
- Every number in text must match the data beside it.
- Each card has a cost, an effect if taken and an effect if it expires. Passing must cost something or risk something.
- Named presenters are townspeople with a trade and a place; reuse 6 to 8 names across the pack so they become known.
- A pack should contain its own small engine (two or three rules that feed each other), at least one rule that pays
  off with another pack's tags, one choice between two good things that cannot both be had, and one threat whose
  answer depends on what the player built earlier.
- Art prompts: one sentence each, same style line for the whole pack, no text in the image.
