# The card table (branch `card-table`, 2026-11-16)

The owner: "Would it make sense to make a parallel track for a card game version of the same thing? Copied world
model but no graphics. Hands of opportunities with their effects readable. In play cards created by opportunities
with tags. A way to target them from an ability wheel or hand cards. Then we could just rapidly test engine
synergies and if the decisions are fun."

One model, two front ends. `table.html` plays the same run as the 3D loop: the same `Realm` (`src/season/realm.ts`)
on the same `LivingEngine`, templates, dealer, fact layer, ledger, rules and live events. No world, no GPU, no
canvas. Nothing of the model is copied; the old card lab's `CardDef` deck (`src/opps/deck.ts`) is not used.

## Parts

| File | What it is |
|---|---|
| `src/table/game.ts` | `Table`: the run's driver with no DOM. It does what `scenes/level/loop.ts` does without a scene: makes the `Realm`, takes and passes offers, ends a season (`Realm.endSeason` → `ledger.nextSeason` → `Realm.afterSeason`), resolves what the scene would have played, starts the next run on the saved world. It returns plain view records (cards, things in play, abilities, the log). The page and the bots both use it. |
| `src/table/words.ts` | Every line the page shows that is not the model's own. |
| `src/table/main.ts` + `table.html` | The page: DOM only. Renders the view, sends taps to `Table`. |
| `src/table/check.ts` | The authoring check over templates and rules. |
| `src/table/bots.ts` | Policies and the runner; `test/unit/table-bots.test.ts` and `scripts/tablebots.mjs` print the table. |

## What the Realm gives today (origin/loop-skeleton 975ac52b)

- Offers with presenter, line, cost, reward text, expiry text, seasons left: `offers()`, `left()`, `short()`,
  `commit()`, `refuse()`; templates through `engine.template()`.
- Pools and income: `ledger` (`pools`, `total`, `income`), projects under way and what is built.
- The threat: `threatIn()`, `averted`, `raid`, `fight`, `over`.
- The season: `endSeason()` (news in the cards' words), `afterSeason()`.
- The record: `history()`, `snapshot()`, `runState()`.

## What is missing, and who adds it

Round 6 (branch `loop-skeleton`, not pushed when this was written) is adding, in the model:
- tags and things: `Realm.things()` (each persistent thing with its tags; a ruined thing loses its working tags);
- synergy rules as data: `living/rules.ts` (`RuleDef`, `RuleBook`, `RuleHit`), `season/realm-rules.ts` (`RULES`);
- spells with a Magic cost and a target: `Realm.cast(spell, site)`;
- live events as data resolved by a pure reading: `living/live.ts`, `Realm.finishLive`, `Realm.playForced`.

The table builds on those once merged. Until then steps (a) and (b) run on the model as it is.

Pure functions this track adds to the model (each with a unit test), for both front ends:
1. `living/rules.ts: whyNot(rule, things, pools)` — for one rule, what is missing: the tag no thing carries, the
   second thing not near, the pool level. The table's "why not"; the 3D game can show the same line.
2. `living/live.ts: mechState(def, run, casts)` — a live event's state when nobody plays it in real time but the
   player made strategic choices: the logged spell casts applied to the groups. `Realm.finishLive` reads it as any
   other state. Only if round 6's `idleState` does not already cover logged casts.
3. Until round 6 lands: the raid's result at the table comes from a small stand-in in `table/game.ts`
   (soldiers against raiders, `war.ts: settle`), removed at the merge. Tagged `CT-TEMP`.

## Determinism

Same seed, same leader, same taps: the same run. The page has no randomness and no clock. The Realm's dealer is
deterministic (`rng: () => 0`); the seed picks the named people. `Table.moves` is the list of taps; a test replays it.

## FIXED-CITY

The table groups things by place and assumes one home town (the Realm's own assumption, LS-40). Marked in code.

## Order

(a) this plan; (b) a whole run by taps: offers, pools, threat, end season, run end, next run; (c) things in play with
tags, abilities with targets; (d) rules log and "why not"; (e) bots and the authoring check; (f) live events resolved
from the model.
