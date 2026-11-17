# The phone board, step 2: a factory economy (card table, 2026-11-17)

The owner: "I want the locations that I build to work as a factory economy where buildings produce, consume and
transform resources. However, I want to click the buildings to perform the conversions each season. Then I want to
have the cards have specific requirements for pawns or resources that they need so that I have to build engines to
produce the resources required by those cards." Data: `src/season/factory.ts` (the pack), logic:
`src/season/stock.ts` (planner), `Realm.uses/use` (clicks), the board (`src/board/*`). Every number is a first
guess, tuned with the bots (`node scripts/tablebots.mjs --factory --measure`).

## 1. Goods

| Raw | Made | Kept as they are |
|---|---|---|
| 🪵 wood · 🪨 stone · ⛏ ore · 🌾 grain | 🪚 planks · 🔩 iron · 🍞 bread · 🔨 tools · 🗡 weapons | ✦ Magic · 👁 Intel · ✊ Unrest · ▣ Materials |

One pile per good: the town's stock (`holdings.goods`, any id). **Old pools**: Magic, Intel and Unrest are unchanged.
**Materials** stays a good of its own ("building stock"), so every old pack and base card still loads and can still
be paid: the builder's yard makes it (1 planks + 1 stone → 3 Materials). In the factory game the leader starts with
no Materials and no Materials income (the economy has to make it); Magic income stays (spells).

## 2. Buildings are machines

A building with crews posted gets **one click a season for each crew** (`clicks_per_crew`: the lever if turns
explode). Each click performs one recipe of that building, at once, and the clicks are shared by its recipes (a
choice per click). Recipes are the existing `uses` (cost → gives), now in any goods.

| Building (how it comes) | Crews | Recipes (one click each) |
|---|---|---|
| Woodcutters (start, the woods) | 2 | Fell: → 2 wood |
| Fields (start) | 2 | Harvest: → 2 grain · With tools: 1 tools → 5 grain |
| Bakery (start, the mill) | 1 | Bake: 2 grain → 3 bread |
| Houses (start, the quarter) | — | eat 1 bread for every 2 crews each season; short: Unrest +1 |
| Quarry | 2 | Cut: → 2 stone |
| Sawmill (the river) | 1 | Saw: 2 wood → 3 planks |
| Mine (the pit) | 2 | Dig: → 1 ore · With tools: 1 tools → 3 ore |
| Smelter (the dam) | 1 | Smelt: 2 ore + 1 wood → 1 iron |
| Smithy (the forge) | 1 | Tools: 1 iron → 2 tools · Weapons: 1 iron + 1 planks → 1 weapons |
| Muster ground (the keep) | — | Arm a recruit: 1 free crew + 1 weapons → 1 soldier (twice a season) |
| Builder's yard (the wagons) | 1 | Bundle: 1 planks + 1 stone → 3 Materials |
| Market stalls | 1 | Buy iron: 4 wood → 1 iron · Buy stone: 3 bread → 2 stone |
| Shrine | 1 | Pray: 2 bread → 1 Magic |
| Watchtower / Town wall | soldiers | stop raiders (rules) |

Upgrades (engines): Second shaft (the mine with 3 crews and richer digs), Ovens (bakery with 2 crews, 4 bread a
bake), the smith's apprentice (a rule: the first forging each season gives 1 iron back), cottages (+1 crew; the
houses eat more). No caps: a snowballing engine is welcome.

## 3. Click to convert

Tap a building → its sheet: crews here (post / recall), click pips (●●○ = 2 left this season), each recipe as a
button "2 ⛏ + 1 🪵 → 1 🔩" with what you have, red where short. One tap = one conversion now: the inputs fly from
the stock bar to the building, the product flies back. Chains are several taps across buildings, so order matters
(dig before you smelt, smelt before you forge, forge tools before you dig with tools).

## 4. Cards state exact needs and deadlines

Every card says which goods and which pieces, how many, for how long, and how long it stays: "Send bread to the
next valley: 4 🍞, 1 crew for 2 seasons · 3 seasons left". The preview lists have/need per item (red where short)
and, when short, the shortest chain of clicks that would cover it this season ("You could make it now: Dig, Dig,
Smelt, Weapons"), or "not this season". The raiders' card: "18 raiders in 9 seasons; you meet them with soldiers ×3
+ the wall and the watchtower". Soldiers always fight (posted or free); walls and the watchtower stop more (default
taken; the old rule needed a keep or walls).

| Card | Needs | Gives | If left |
|---|---|---|---|
| Open the quarry | 2 🪵, 1 crew · 1 season | the quarry | — |
| Build a sawmill | 3 🪵, 1 crew · 1 | the sawmill | — |
| Sink a mine | 2 🪚 2 🪵, 1 crew · 1 | the mine | — |
| Build a smelter | 4 🪨, 1 crew · 1 | the smelter | — |
| Build a smithy | 3 🪨 2 🪚, 1 crew · 2 | the smithy | — |
| Clear a muster ground | 2 🪚, 1 crew · 1 | the muster ground | — |
| Set up a builder's yard | 2 🪚, 1 crew · 1 | the yard | — |
| Put up market stalls | 3 🪚, 1 crew · 1 | the stalls | — |
| Raise a watchtower | 3 🪚 2 🪨, 1 crew · 1 | the watchtower | — |
| Raise the town wall | 8 🪨 3 🪚, 2 crews · 2 | the wall | — |
| Build a shrine | 2 🪨 2 🍞, 1 crew · 1 | the shrine | — |
| Sink a second shaft | 4 🪚 2 🔩, 1 crew · 1 | the deep mine | — |
| Build bread ovens | 3 🪨 1 🔩, 1 crew · 1 | the big bakery | — |
| Take on an apprentice | 2 🔨 2 🍞 | first forging free each season | — |
| Build cottages (again) | 3 🪚 2 🍞, 1 crew · 1 | +1 crew | — |
| Hire out a crew (again) | 1 crew · 2 | +2 🔩 | — |
| Tools for the miners | 4 🔨 | +2 ⛏ every season | — |
| Send bread to the next valley | 4 🍞, 1 crew · 2 | Unrest −1, +2 👁 | Unrest +2 |
| Lay in winter stores (again) | 6 🍞 2 🪵 | — | Unrest +2 |
| Arm the watch | 3 🗡, 2 soldiers · 1 | Unrest −1, +2 👁 | Unrest +1, −3 🍞 |
| Mend the old dam | 4 🪨 2 🪚, 2 crews · 1 | the dam holds | the mill floods (bakery lost) |
| The road wardens (again) | 4 ▣ | — | Unrest +1, −2 🔩 |

Plus the base game's world cards (the raiders' tribute in Materials, refugees, the parade, the live fire, the raid);
the catalog's own buildings are out of the deck in the factory game (the factory cards build the town). Six offers
and three needs at once. Several needs with deadlines stand at once from season 2.

## 5. On the board

Stock bar on top (icon + number for every good, scrolls sideways at 412 px), the needs as chips under it. Each
building shows the icon of what it makes and its click pips; a building that can convert now has a cyan "ready"
mark (cyan is only for what you can act on). The time-lapse shows the houses eating bread and deliveries flying in.
Labels: card titles only when zoomed in or on the selected marker; Skip sits above the bottom bar; speech bubbles
are smaller, one at a time.

## 6. Defaults taken for open questions (easy to flip)

1. Each posted crew is one click a season (`clicks_per_crew: 1`; `?cpc=` on the page, `--cpc` for the bots).
2. Posted soldiers always count in a raid; walls and the watchtower are bonuses (`Realm` runNumbers).
3. More early cards build (the quarry, the sawmill, the mine are on offer in season 1).
4. Materials is a made good (the yard), not a pool the leader starts with in the factory game.
