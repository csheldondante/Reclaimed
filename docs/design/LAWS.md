# Laws: things that change the rules of the game (card-table, 2026-11-16)

The owner: "Since it is a roguelite with runs that end we can break things. Look at games like innovation and allow
mechanics that mutate mechanics in potentially major world changing ways." Engines are tags and synergies as data;
loops are fine when each turn costs a player action or a season; no safety limits on power.

## The mechanism

One ordered list of **laws in force**, kept by the `Realm`, layered over the base definitions. Nothing base is
edited: every reader asks the Realm for the law-applied view (`things()`, `rules.rules`, `terms(offer)`,
`liveOf(offer)`, `spellMech()`, `runNumbers()`), so the 3D game gets the same numbers by merge.

A law is in force while its **source** stands:
- a thing in play that carries it (`"laws": [...]` on a pack thing) and is not ruined: it leaves with the thing;
- a timed grant (`{ "law": "id", "seasons": 2 }` in any effect list, rule act or ability effect);
- the rest of the run (`{ "law": "id" }`). A thing that stands into the next run brings its law back, because the
  thing is physical;
- the record (added on the owner's ruling that endings may change the world for good): a card's `laws_after` stand
  in every later run of the world once the card is in the record of resolved cards.

**Order.** Laws apply in the order they came into force (a thing's law: when the Realm first sees the thing
standing, after each player action and at the season's end). Two laws on one number apply in that order: `set`
then `times` is not `times` then `set`. Meta laws are the exception: they act on every law, whenever it came.

**Save.** The list is part of `RunState` (`laws`), with each entry's source, its words of origin and its order.

## The data words (a pack's `laws` block; one `does` each)

```json
{ "id": "rites-holy-furrows", "name": "Holy furrows", "does": { "count_as": { "tag": "field", "as": "temple" } } }
```

1. **Tags.** `count_as` {tag, as}: whatever carries `tag` also carries `as`. `grant` tag `to` a query: every thing
   that matches carries it. `spare` a ruin word: it stops ruining (a burned field keeps its working tags and shows
   `burned` too).
2. **Rules.** `{ "rule": id, ... }` with `set` (n, cap, each, perSeason; null removes), `times` (n and cap
   multiplied), `on` / `a` / `b` (replaced), `off`, `fires` (it fires so many times on one trigger). `add_rule`: a
   whole rule that exists only while the law is in force: a thing carrying rules is a thing carrying this law.
3. **Cards.** `cost` {pool: add} on the cards matched by `cards` ({themes} or {ids}; absent: every card), never
   below 0; `pay` {labor: "magic"}: that part of the cost is paid from another pool; `build` (seasons, at least 1);
   `stay` (seasons a card dealt from now stays); `pool_as` {unrest: "might"}: counts as soldiers in fights.
4. **Spells and events.** `spell` + `kills` / `douses` (what one cast does in an event); `spell` + `also_tag` +
   `on` query (a cast also tags every match for the season: Rain grows the fields); `event` kind + `allow` spells,
   `shift` (results move up or down a step), `foes` (more foes in each foe group), `counts_as` {live, tier} (a result
   also sets off the rules waiting for another kind's result).
5. **The run.** `board` (cards on offer at once), `income` {pool: n} each season, `raiders` {add | times}, `win`
   {count, tags}: an achievement, the run is won when that many things carry the tags.
6. **Meta.** `multipliers` n: every multiplier (a rule's `mul`, a law's `times`) is multiplied by n. `next_law`
   "run": the next law to come into force lasts the rest of the run whatever its source.

Not built, with why: the run's length and the raid's timing (the arc is timed when the run begins: changing it
means rebuilding the arc); threats at once (an engine option fixed at construction); a law outliving the run (owner).

## What the player reads

Every generated line is written from the law-applied view, so nothing is edited by hand: a rule's words, a card's
cost, a spell's line, an event's groups and predicted result. The table adds:
- **Laws in force**: each law's words (written from `does`), who or what made it, and until when;
- a card's preview: the laws it brings and every line that would change ("Rune-fed fields: +2 Materials would
  become +4"), found by reading the view with and without those laws;
- the Rules list marks a rule a law changed, with the law's name.

## Riskiest part first

The rule book over a derived list (cache by the laws in force, validated when it changes) and the order of laws
under save/load. Then tags, then cards, then the rest. "Resolve now" on a live event comes after laws 1 to 3.
