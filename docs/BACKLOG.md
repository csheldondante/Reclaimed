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
| A6 | Blown dust piles up against things (drifts, lee of walls) | M–L | next |
| A7 | Tutorial builds skills: (1) growth and death of flowers, (2) wind blowing, (3) free play to demonstrate it, (4) something new: a pile of pollution the wind can't move, (5) a storm forms and lightning destroys it | M | next |
| A8 | Wind is more powerful under storms | S | done `a8d51c0` |
| A9 | Difficulty setting: easy (green never re-pollutes), medium (green resists), hard (green easily killed by blown trash, strong wind, too much water) | M | done `5866665` |
| A10 | Seeds that land greenify their spot and clean a little pollution (makes birds and wind over plants matter) | S–M | done `e8b2efe` |
| A11 | Wind over flowering plants sheds the flowers (petals blow off); they take time to regrow | M | done `e8b2efe` |
| A12 | Map wind: a steady prevailing flow one way across the map; only minor noise, also mixed into the player field | S | done `a8d51c0` |
| A13 | Storm shadows swirl erratically — make their shape steadier | S | done `a8d51c0` |
| A14 | Light (not dark) fair-weather clouds/shadows drift over to show the wind | S–M | done `e8b2efe` |
| A15 | Smooth tops for soft surfaces (dirt, dust, sand, water) vs hard steps for stone; sub-cell height; "over a gap = sheer drop, under = smooth" as a surface property | M (render) / L (data) | next |

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
| B8 | Water on slopes renders stair-stepped; rubble falls instantly (no fall animation) | session 1 | M | deferred (A15 may cover the first) |
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
