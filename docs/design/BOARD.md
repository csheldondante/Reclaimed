# The phone board, step 1 (card table, 2026-11-17)

`board.html` (`src/board/*`): the season loop played on a small isometric sprite town, on the SAME model as the card
table (`table/game.ts` → `season/realm.ts`). Canvas 2D only, no GPU, no engine imports. Portrait phone first, touch
first; the mouse works too. A prototype of the PLAY, not of the art. The orchestrator's assumption, flagged to the
owner: this board is a separate light front end; the 3D engine can later bake tiles and sprites into its slots.

## What is on screen

- **Top bar**: the season, Magic / Materials / Intel / Unrest with their income, and the needs as chips (the raiders
  with their numbers, needs with their countdown, a live event under way). A chip opens its card.
- **The town** (most of the screen): a 26×26 tile map laid out by hand round the model's 20 sites (`layout.ts`): river,
  mountain, woods, fields, roads (A* between sites, a bridge at the river crossing). Pinch, drag, tap.
- **Bottom bar**: the crews and soldiers as counts (tap one to hold it; the places with room light up; tap one to post),
  Region, Next season.
- **The sheet** (slides up for what is tapped): a place (its things, slots with Post / Recall, uses with "once more this
  season"), a card (who asks, cost, the preview: pools before → after, pieces busy until season N, what it gives, what
  happens if left), a live event (how it stands, spells, Defend / Settle it now), a far place (its line and since when).

## Colour rule

Muted ground and buildings. Bright figures: crews yellow, soldiers white with blue, both on a dark disc; townspeople in
soft colours. **Red is only for foes** (raiders, the dead). **Cyan is only for what you can act on** (cards, slots,
uses, buttons). Your banner on the region is gold; a faction's colour is a hue from its id (never red or cyan).

## How the model's words look

| Model | Look |
|---|---|
| Site with nothing built | its plain look (keep yard, forge shed, carts, gate posts, hut, jetty, ore heap, trees…) |
| Catalog card built at its site (`ledger.built`, SITE_TAGS) | the built look (keep, forge, houses, market, gatehouse, quay, quarry, lumber camp, waystation, barn) |
| Pack / works thing in play at a site | its sprite (mine, stalls, shrine, foundry, muster, granary, watchtower, wall walk; `hall` for any other building, a flag for a policy) |
| Project under way at a site | a ghost of what it raises, the built part solid from the ground up, scaffold poles; crews working there |
| Done this season | rises from the ground in the time-lapse |
| `burned` | ash tiles round the site, burned rubble |
| `flooded` | water over the low ground near the site first, then the site |
| `melted` | a tongue of lava rock creeping tile by tile from the mountain's side onto the site |
| `buried` / `greened` / `withered`, `dried` | mud / lush green / dry ground round the site |
| `abandoned`, `destroyed`, `occupied`, `lost` | grey ruin ground and rubble |
| Signs on the town: `ashfall`, `darkness`, `rain`, `storm`, `fog` | grey wash with falling ash / dark wash / rain streaks (+ flashes) / haze |
| `deadrise`, `crime` | the dead (red, pale heads) out of the burial ground; hooded thieves in the market streets |
| Live fire / lava front | flames on the site / glowing lava tiles reaching toward it as the model's `burned` grows |
| Walls built | a stone ring round the core |
| Houses built, market, partners | more houses on the plots, more people on the roads (34 to 180) |
| **Any other tag** | **a label with its plain words at the site (or at the keep for the town)** |
| Far place (region) | its kind (town, camp, lair, tower, crash, POI), status ground (ash, water, lava, green, rubble, faded), a banner (yours gold, a faction's hue, raiders red), "new", unknown tags as words, a flash when it changed this season |
| Trade partners, what is yours | roads to them with carts going back and forth; dashed when fallen |

## The turn on the board

Instant moves (post, recall, a use, a cast) resolve at once; the numbers fly between the place and the bar, the piece
walks there. Commit takes the card (its cost leaves at once; crews walk to the site and work until it is done). No undo.
**Next season** plays the time-lapse (2–9 s, Skip or tap to cut it): the season banner, the pools flying in, finished
buildings rising, new scars arriving, pieces walking home, then up to three pieces of news brought by a messenger (on
foot; a rider when it names a far place or the raiders; a cart for goods; a ship on the river for the sea), each with a
speech bubble. Far places that changed flash on the region and are told in a toast.

**The raid** (live event `raid`): Defend (or Next season while it stands) plays it on the board for about 24 s. Raiders in
red file in down the east road; they stop and fight where your soldiers stand (posted on the watchtower or the wall
walk, the free ones at the gate once there is a keep or walls); spells from the run (`Table.abilities` aimed at the
event) land where they are thickest. How many fall is the model's predicted count, recomputed after each cast; the end
is `Table.resolveNow`, and its lines are the result sheet. The board decides nothing.

## Defaults assumed for open questions (owner to confirm)

1. A use needs a posted piece of that thing where the data says `needs`, and is once a season (the works' data).
2. A recalled piece is free at once (the model's rule today).
3. The raiders' need states numbers: "18 raiders · 9 seasons · you 0" (you = soldiers that would fight × 3 a soldier;
   0 until a keep or walls).
4. Cards and needs are markers only, with a short title over each at normal zoom; the full card is one tap.

## Stubbed, faked or missing (BACKLOG BD-…)

Hand-laid town, the same for every town (BD-1). Placeholder procedural art (BD-2). Raid motion is illustrative (BD-3).
Several scars share a look; camp sign has none (BD-4). The lava front's reach on the board is a reading of the event's
numbers, not a flow (BD-5). The messenger's mount is picked from words in the news (BD-6). No save: a reload starts a
new run (BD-7). No log, rules, laws or record views on the board yet: the card table has them (BD-10).
