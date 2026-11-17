# The phone board, step 2: a factory economy (card table, 2026-11-17)

The owner: "I want the locations that I build to work as a factory economy where buildings produce, consume and
transform resources. However, I want to click the buildings to perform the conversions each season. Then I want to
have the cards have specific requirements for pawns or resources that they need so that I have to build engines to
produce the resources required by those cards." Data: `src/season/factory.ts` (the pack), goods: `season/goods.ts`,
the planner: `season/stock.ts`, clicks and eating: `Realm.clicks/uses/use/eat`, the board: `src/board/*`. Every
number is a first guess, tuned with the bots (`node scripts/tablebots.mjs --factory [--cpc 1]`).

## 1. Goods

| Raw | Made | Kept as they are |
|---|---|---|
| 🪵 wood · 🪨 stone · ⛏ ore · 🌾 grain | 🪚 planks · 🔩 iron · 🍞 bread · 🔨 tools · 🗡 weapons | ✦ Magic · 👁 Intel · ✊ Unrest · ▣ Materials |

One pile per good: the town's stock (`holdings.goods`, any id). **Old pools**: Magic, Intel and Unrest are unchanged.
**Materials** stays a good of its own ("building stock"), so every old pack and base card still loads and can still
be paid: the builder's yard makes it (1 planks + 1 stone → 3 Materials). In the factory game the leader starts with no
Materials and no Materials income (the economy makes it); Magic income stays (spells).

## 2. Buildings are machines

A building with crews posted gets **one click a season for each crew** (`clicks_per_crew`: the lever if turns
explode; `?cpc=` on the page, `--cpc` for the bots). Each click performs one recipe of that building at once; the
clicks are shared by its recipes (a choice per click). Recipes are the existing `uses` (cost → gives) in any goods.

| Building (where; how it comes) | Crews | Recipes (one click each) |
|---|---|---|
| Woodcutters (woods; start) | 2 | Fell: → 3 wood |
| Fields (start) | 2 | Harvest: → 3 grain · With tools: 1 tools → 5 grain |
| Bakery (mill street; start) | 1 | Bake: 2 grain → 4 bread |
| Houses (weavers' street; start) | — | eat 1 bread for every 3 crews each season (short: Unrest +1) · Feast: 4 bread → Unrest −1 · Calm: 2 Magic → Unrest −1 (no clicks, once a season each) |
| Quarry | 2 | Cut: → 2 stone |
| Sawmill (river crossing) | 1 | Saw: 2 wood → 3 planks |
| Mine (ore yard) | 2 | Dig: → 1 ore · With tools: 1 tools → 3 ore |
| Smelter (wagon yard) | 1 | Smelt: 2 ore + 1 wood → 1 iron |
| Smithy (forge) | 1 | Tools: 1 iron → 2 tools · Weapons: 1 iron + 1 planks → 1 weapons |
| Muster ground (keep) | — | Arm a recruit: 1 free crew + 1 weapons → 1 soldier (twice a season, no clicks) |
| Builder's yard (waterside) | 1 | 1 planks + 1 stone → 3 Materials |
| Market stalls | 1 | Buy iron: 4 wood → 1 iron · Buy stone: 3 bread → 2 stone |
| Shrine | 1 | Pray: 2 bread → 1 Magic |
| Watchtower / Town wall | soldiers | the wall stops 4 raiders, a soldier on its walk 1 more; a soldier on the watchtower 3 |

Engines: the deep mine (3 crews, digs of 2 and 4), the big bakery (2 crews, 6 bread a bake), the apprentice (a rule:
the first tools forged each season give the iron back), cottages (+1 crew; the houses then eat more), Tools for the
miners (+2 ore every season). No caps.

## 3. Click to convert

Tap a building (or its chip) → its sheet: crews here (Post / Recall), the clicks this season as pips (● left, ○ used),
each recipe as a button "2 🌾 → 4 🍞", red where short, with why it cannot be made now ("post a crew here first",
"no clicks left this season", "short 1 🔨"). One tap = one conversion now: the inputs fly from the stock bar to the
building, then the product flies back. The place picked stands in the open space between the bar and the sheet.

## 4. Cards state exact needs and deadlines

Each card's sheet lists every item with have / need ("Planks 0 / 2" in red), how long the crews are busy, and when
short the shortest chain of clicks that would meet it this season — "You can make it this season: Fell trees → Post a
crew at The sawmill → Saw planks" — or "You cannot make it this season with what you have." The raiders' chip: "18
raiders · 9 seasons · you 9" (soldiers × 3; the wall and the watchtower stop more). The factory's cards are dealt
whether or not the stock meets them now (the base dealer deals only what can be paid).

| Card (where) | Needs | Gives | If left |
|---|---|---|---|
| Open the quarry | 2 🪵, 1 crew · 1 season | the quarry | — |
| Build a sawmill | 3 🪵, 1 crew · 1 | the sawmill | — |
| Sink a mine | 2 🪚 2 🪵, 1 crew · 1 | the mine | — |
| Build a smelter | 4 🪨, 1 crew · 1 | the smelter | — |
| Build a smithy | 3 🪨 2 🪚, 1 crew · 2 | the smithy | — |
| Clear a muster ground | 2 🪚, 1 crew · 1 | the muster ground | — |
| Set up a builder's yard | 2 🪚, 1 crew · 1 | the yard | — |
| Put up market stalls | 3 🪚, 1 crew · 1 | the stalls | — |
| Raise a watchtower (S3+) | 3 🪚 2 🪨, 1 crew · 1 | the watchtower | — |
| Raise the town wall (S4+) | 8 🪨 3 🪚, 2 crews · 2 | the wall | — |
| Build a shrine (S3+) | 2 🪨 2 🍞, 1 crew · 1 | the shrine | — |
| Sink a second shaft (mine) | 4 🪚 2 🔩, 1 crew · 1 | the deep mine | — |
| Build bread ovens (S3+) | 3 🪨 1 🔩, 1 crew · 1 | the big bakery | — |
| Take on an apprentice (smithy) | 2 🔨 2 🍞 | the first tools free each season | — |
| Build cottages (S2+, again) | 3 🪚 2 🍞, 1 crew · 1 | +1 crew | — |
| Hire out a crew (again) | 1 crew · 2 | +2 🔩 | — |
| Tools for the miners (S5+) | 4 🔨 | +2 ⛏ every season | — |
| Send bread to the next valley (S2+) | 4 🍞, 1 crew · 2; 3 seasons | Unrest −1, +2 👁 | Unrest +2 |
| Lay in winter stores (S4+, again) | 6 🍞 2 🪵; 2 seasons | — | Unrest +2 |
| Arm the watch (S4+) | 3 🗡, 2 soldiers · 1; 3 seasons | Unrest −1, +2 👁 | Unrest +1, −3 🍞 |
| Mend the old dam (S5+) | 4 🪨 2 🪚, 2 crews · 1; 3 seasons | the dam holds | the mill street floods (the bakery is lost) |
| The road wardens (S7+, again) | 4 ▣; 2 seasons | — | Unrest +1, −2 🔩 |

Plus the base game's world cards that stay (the raiders' tribute in Materials, the raid, refugees, the dead, the
parade, the market fire, sellswords, the tower lens). Out of the factory's deck by theme: the catalog's buildings, the
base hazards and the mining camp (`FACTORY_OUT`). Six offers and three needs at once; one card a place.

## 5. On the board

The stock bar under the season (icon, number, name; what you hold first; scrolls sideways at 412 px). Each building
has a chip at its foot: the icon of what it makes and a pip for each click, ringed in cyan when a recipe can be made
now. Card titles only zoomed in (≥ 1.0) or on the place picked; place names from 1.15. Skip sits above the bottom
bar. Speech bubbles are 12 px, at most four lines, one at a time. The time-lapse: the houses eat (bread flies from the
bar to the houses, "The houses eat 2 bread" or "The houses go hungry"), then what the season brought flies in.

## 6. Defaults taken for open questions (easy to flip)

1. Each posted crew is one click a season (`clicks_per_crew: 1`, the least there is).
2. Posted and free soldiers always fight a raid; the wall and the watchtower stop more (`RealmOptions.soldiersAlways`,
   on in the factory game only).
3. More early cards build (sawmill, quarry and mine are on offer in season 1).
4. Materials is a made good (the yard), not a pool the leader starts with in the factory game.
5. Shortfalls are red, as asked, though BOARD.md kept red for foes (BD-22).

## 7. What the bots say (`tablebots --factory --seeds 2 --seasons 12`, 24 runs; DEVLOG 2026-11-17)

| Measure | Result | Target |
|---|---|---|
| Runs held / fell (idle, solver, greedy, planner) | 0/6, 0/6, 0/6, **4/2** | can be lost and won: yes |
| Distinct legal turns a season | median 9,440 (quartiles 1.6k to 35k) | hundreds to low thousands: **over** |
| Distinct outcomes a season (stock, Unrest, pieces' numbers, cards taken) | median 436 (144 to 1,245) | in range |
| Every ask satisfiable together | 0% of seasons now, 0% after a chain | < 5% |
| Asks satisfiable now / after the season's best chain | 22% / 32% of 7.5 asks | — |
| Cards taken that needed 0 / 1 / ≥ 2 clicks first | 166 / 34 / 4 (2%) of 226 | chains should matter more |
| Conversions a season | median 3 | — |
| Solver beats greedy | 67% of seasons, by 2.6 points (38% of greedy's gain) | — |
| Best turn depends on order / placement | 62% / 53% | — |
| Simulation against the game | no difference in any turn | — |

The lever chosen: clicks per crew stays at 1 (the least); the count is high because of where crews stand and the order
of clicks, not because of more clicks. Next levers (owner's call, BD-17): standing orders for posted crews.
