# Backlog — every open suggestion, so nothing is lost between sessions

The running list of the user's suggestions and deferred work. Each item has an
id, the round it came from (DECISIONS.md has the user's words), a size
(S ≈ hours, M ≈ half a day, L ≈ a day+) and a status. When an item ships,
move it to **Done** with the commit; when the user changes their mind, note
it here. Agents: read this before starting work and keep it current in the
same commit as the change.

Order agreed (round 10): A1–A5, A8, A12, A13 → A10, A14, A11 → A9 → A7 → A15 render slopes → A6 + A15 sediment layer. Answers: A15 render first then sediment; A7 the player taps the lightning; A9 on the title screen, default Medium.

Status: `open` · `next` (agreed, queued) · `wip` · `asked` (waiting on the
user) · `deferred` (agreed for later).

## Round 10 (2026-10-08) — new batch

| id | item | size | status |
|---|---|---|---|
| A1 | Title screen: howling desolate wind + periodic gusts while it is barren (softening as it greens) | S | done `a8d51c0` |
| A2 | Level: barren map → more desolate wind sound (and gentler as it greens) | S | done `a8d51c0` |
| A3 | Drag audio: whoosh starts when the drag starts; no snap/rustle at mouse-up — wind only | S | done `a8d51c0` |
| A4 | Player gusts sound deeper than the desolate ambient wind | S | done `a8d51c0` |
| A5 | No birds on the title screen (they make the skull look giant) | S | done `a8d51c0` |
| A6 | Blown dust piles up against things (drifts, lee of walls) | M–L | done `5995426` |
| A7 | Tutorial builds skills: (1) growth and death of flowers, (2) wind blowing, (3) free play to demonstrate it, (4) something new: a pile of pollution the wind can't move, (5) a storm forms and lightning destroys it | M | done `6e03680` |
| A8 | Wind is more powerful under storms | S | done `a8d51c0` |
| A9 | Difficulty setting: easy (green never re-pollutes), medium (green resists), hard (green easily killed by blown trash, strong wind, too much water) | M | done `5866665` |
| A10 | Seeds that land greenify their spot and clean a little pollution (makes birds and wind over plants matter) | S–M | done `e8b2efe` |
| A11 | Wind over flowering plants sheds the flowers (petals blow off); they take time to regrow | M | done `e8b2efe` |
| A12 | Map wind: a steady prevailing flow one way across the map; only minor noise, also mixed into the player field | S | done `a8d51c0` |
| A13 | Storm shadows swirl erratically — make their shape steadier | S | done `a8d51c0` |
| A14 | Light (not dark) fair-weather clouds/shadows drift over to show the wind | S–M | done `e8b2efe` |
| A15 | Smooth tops for soft surfaces (dirt, dust, sand, water) vs hard steps for stone; sub-cell height; "over a gap = sheer drop, under = smooth" as a surface property | M (render) / L (data) | done (render `a015f55`, sediment `5995426`) |

## Round 12 (2026-10-08)

Order: D4, D5, D6 → D7 → D2 → D3 → D1 → then back to C6, C7, C9, C8.

| id | item | size | status |
|---|---|---|---|
| D1 | Title screen plants at diorama scale: flowers with petals and leaves, grass blades, moss, roots of the tree growing out of the skull | M | next |
| D2 | Wind blows decaying (browned) plants away as dust/flakes | S | next |
| D3 | Cyclones from a tight circular drag: carry dust, cross the map destructively (free, cooldown; ruins/junk, spare grown plants) — supersedes C10 | M–L | next |
| D4 | The squeaks under rain/storms (raindrop ticks / birdsong in rain) — remove | S | done `b4df5f8` |
| D5 | Grow sound: something unfurling, not a charging sound | S | done `b4df5f8` |
| D6 | Drag wind 2–3× louder relative to other sounds | S | done `b4df5f8` |
| D7 | Rounder edges on drifts / water / smoothed surfaces (cheap SDF-style edges) | S–M | done `fc2c534` |

## Round 11 (2026-10-08)

Order decided: C4, C3, C5 → C2 → C1 (with A6/A15 sediment) → C6 → C7 → C9 → C8.

| id | item | size | status |
|---|---|---|---|
| C1 | Dust drifts (fractional sediment layer) that bury things — uncover them with wind (objects, seed beds); supersedes A6 | L | done `5995426` |
| C2 | Smooth water surfaces (keep the rain rings / storm glints) | M | done `0c20e47` |
| C3 | Grow sound: a wet sprouting "opening", then the current shimmer | S | done `031b78c` |
| C4 | Audio debug: see and mute each sound (find the high whine under storms / on Nature gains) | S | done `031b78c` |
| C5 | A little light where growth and wind happen | S | done `031b78c` |
| C6 | Multiple levels; title screen shows clickable objects for each level | M–L | next |
| C7 | Level: highway covered in ruined cars | M | next |
| C8 | Level: port with tankers washed ashore and a seawall; ocean waves and sea swell | L | next |
| C10 | Swirling the mouse while dragging paints a vortex; a sustained swirl summons a cyclone (with B6 tornado) | M | → D3 |
| C9 | Level: ruined city with a blast crater and hospital tents (an outbreak) | M–L | next |

## Carried over (deferred earlier — still wanted)

| id | item | from | size | status |
|---|---|---|---|---|
| B1 | **Phone testing**: pick hosting (GitHub Pages / local HTTPS / tunnel); Android Chrome; touch controls are in, but untested on a device | round 6 | S | deferred (user: later) |
| B2 | Sandbox / level-edit mode (deposit/remove-layer brushes, place water/oil/trash/plants, spawn storms, time controls) | round 6 | M–L | deferred |
| B3 | Water life: fish in clean water, reeds/lilies in shallows | round 6 | S–M | deferred |
| B4 | Wind waves on water (shaded cheap; true height harder) | round 6 | S / M–L | deferred |
| B5 | Event camera beyond the intro: pan/zoom to firsts (animals arrive, a seed sprouts and dies, wind clears trash and a plant takes) | round 6 | M | deferred |
| B6 | Earthquake; drag-to-tornado | rounds 2–3 | M | deferred |
| B7 | Second level / data-driven map format | session 1 | M–L | deferred |
| B8 | Water on slopes renders stair-stepped; rubble falls instantly (no fall animation) | session 1 | M | water part done `0c20e47`; rubble animation open |
| B9 | Audio has never been heard by an agent — every sound needs the user's ear | ongoing | — | open |
| B10 | Open judgement calls in STATUS.md §5 (economy, day length, night darkness, fire residue, lens UX, forest look) — several are stale; re-ask when relevant | session 1 | — | open |

## Done (recent; DEVLOG has details)

- Round 9: camera director + diegetic first-play intro; title screen with the
  level's hands, opening wither demo, reset progress; tap tiers (grass /
  flowers-shrub / tree; withering on hostile ground); one wind field storms
  ride; storms form at the upwind edge with distant thunder — `8b20abf`,
  `cfff42d`, `ef57291`, `38d0e95`.
- Round 8: stacking strokes (breeze/gust/gale), storms steered by the field,
  score = clean land + life, Nature pays for deeds — `f7f2740`.
- Round 7: persistent wind field, free taps, grime + washing, instant
  plant feedback — `dac7f5a`.
- Round 6: withering, seeds, grow-tap, litter, phone-ready layout — `4a1ba43`,
  `22256af`.
- Rounds 4–5: see DEVLOG.
