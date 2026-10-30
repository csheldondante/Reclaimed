# Run planning, consequences and travel (round 117, branch `runplan`)

The run manager: a branching run planned on the region graph and fitted to the hero, travelled on the atlas map,
and what its outcomes do to the world for the next run. Code: `src/runplan/`; contract: `src/api/contracts/run.ts`
(the "Planned runs" half) plus small additions to `world.ts` / `world-state.ts`. Viewer: `?runplan=view&seed=1&hero=bike`.

## What the user asked for (verbatim, DECISIONS round 117)

- Runs: "TBD but I was thinking 15-50 minutes with branching. Decisions should impact the world for the next run.
  They should impact characters and their history, relationships and motivations. Potentially impact their gear or
  persistent statuses. They should impact factions and their relationships and power. They should impact the terrain
  and the cities and as mentioned change statuses at the regional or global level. Make it eternal night or flood a
  region and make a new shallow sea or bury a ruin under sand etc. the GM can determine some of what happens in
  different failure conditions like death or capture or just failure to meet a timeline. Maybe the lich takes over the
  map and the world is filled with undead. That's the fun of this game."
- The graph: "Both. Terrain makes the barriers initially but the run manager should be able to get. The graph and
  request obstacles or otherwise request a certain number of exits."
- Fitted to the hero: "parameterize it so we can reason about it during generation and make not only obstacles but fun
  ones. A fast bike need races and chases. A combat soldier needs fun fights. A force of nature needs spectacle and
  power fantasy." / "The lich is a floating wrecking ball power fantasy, the hoverbike we want races and tricks and
  mounted fights, the knight delving and quests etc."
- Travel (round 115): "have the player use the atlas map to travel from location to location. We can precache the
  locations they go to and animate travel on that map while we load in the background. One fun thing we might do is
  have events enroute and generate new poi along their path or fade between pretty views along the road and the map."
  Sections (B-RC1): "we can coral the player into sections of the map and load the tiles for those sections ahead of
  time so that they remain on the GPU."
- The flood fill (round 117): "I think instead of a global sea level a GPU flood fill based on height would let us
  easily flood areas and would be a nice tool. We can flood with water, sand, magma etc."

## Built on (not redesigned)

`MemoryWorldState` (regions, factions, history, runs, settlements; `restore`), `AtlasEvent`s, `RunRecord`, the GM's
`SessionStory` `Outcome` (a stage's effects are the same type a GM story writes), the cached atlas facts and wiki
(`data/atlas/seed1.json`, `data/wiki/seed1.json`, or `atlasFacts(atlas)` + `buildWiki` for any seed),
`Streamer.precache` (via `precacheWarp`), the atlas map's painter (now exported as `paintAtlasImage`).

## The pieces, and why each is the way it is

| piece | file | what | why |
|---|---|---|---|
| region graph | `graph.ts` | `RegionGraph` from atlas facts: neighbours, a barrier per border guessed from the kinds and ground (range → mountain, rift → ravine, lava field → lava, a 40 z step → cliff, land/sea → water, both sides river-rich → river), road crossings (road, bridge) | STAND-IN for terrain's graph. The planner only needs "can this hero get from A to B, how hard, is it fun"; terrain's real graph replaces the function behind the same interface and the planner's tests (tiny hand-made graphs) don't change. |
| hero capabilities | `heroes.ts` | per role: speed, a cost multiplier per barrier (0 can't), likes per encounter kind, fun crossings ("a ramp to jump the gap") | STAND-IN for play's controller contract; the user asked for parameters the generator can reason with. An unknown role throws (no silent default). |
| affordances | `affords.ts` | what play a region affords (race, chase, fight, horde, spectacle, destruction, delve, talk, explore, rescue) from its kind, relief, towns, **and its RegionState** | the world as the last run left it steers the next: the dead walking → a horde; ruins → breaking; a captive held → a rescue. |
| routes | `route.ts` | Dijkstra by the hero's effort (world units × border cost) | the bike goes round the mountain the knight walks through by its cave; the lich floats over the sea. |
| planner | `plan.ts` | start → 1-4 layers of two stages → one finale; legs between them; terrain requests; failure rules; minutes fitted to 15-50 | layers of two make every choice a real fork (two places, ideally two kinds of play), every path reaches the finale (the run can't strand the player), and the length is bounded. Stage minutes are budgets the region generator sizes to; they're scaled if a path would leave 15-50. |
| terrain requests | `plan.ts` | `obstacle` (a border, a barrier kind, the passage the hero is meant to use) and `exits` (a stage region's passable borders toward its legs, the rest closed) | the user's "request obstacles or … a certain number of exits"; data terrain reads on arrival, not calls into terrain. Exits close a stage into a section (RC1) whose ways out are the run's choices. |
| consequences | `consequences.ts` | per encounter, 2-4 outcomes as `Outcome` + `CharacterChange[]`; failure rules (lost, captured, late); `finishRun` applies a played path; `realise` converts RegionState for each generator | one representation for GM-written and planned outcomes, applied one way. `realise` is the boundary conversion: sunk, buried and flooded all become **one** height flood-fill request (`FloodRequest`: seed, level, material) because that is the user's one tool for "a new shallow sea" and "a ruin under sand". |
| the GM's failure rules | `consequences.ts` `failureRules` | death where the dead hold sway (the Hollow Court is the threat, or undead > 0.15 near) → "the lich took the map": raise-dead and shadow over every region within 3 borders of the run, the Court's presence and power up; else the threat takes the finale. Capture → `captive:<faction>` at its seat (a later run of another hero gets a rescue there; the captive's own next run starts there, a chase out). Late → the finale's threat wins without the hero. | stand-in rules until the GM writes them per story; deterministic so tests pin them. |
| characters | `world-state.ts` | `CharacterRecord` (history, relationships, motivation, gear, statuses, alive, region) and `CharacterChange`, kept in the snapshot | the user: characters' "history, relationships and motivations … gear or persistent statuses". A dead hero can't be planned for (an error, not a silent new hero). |
| factions | `world.ts` | `Faction.power`, events `faction-power`, `faction-relation` | "factions and their relationships and power". |
| travel | `travel.ts` | `enRoute` (vista, poi, ambush, weather, traveller; ≤ 1 a 1200 world units, ≤ 3 a leg) and `Journey` (asks the destination's land at once through a `Precacher`, moves along the leg, holds at each event until answered, arrives only when the animation is done *and* the land is ready) | the travel is the loading screen. Pure (no DOM/GPU) so the viewer, the game and a Node test drive the same code. |
| viewer | `viewer.ts` | seed + hero in; the plan drawn on the atlas map (same painter as the game's map); play a stage, choose a leg, watch the travel with its events, end the run (or fail it), see the consequences (events, regions as each generator will realise them, characters, factions); next run from the world as left | DECISIONS round 117 part 4: a viewer page per generator. |

## Contract additions (contracts/run.ts unless noted)

`BarrierKind`, `EncounterKind`, `HeroCapabilities` (stand-in), `RegionNode` / `RegionEdge` / `RegionGraph` (stand-in),
`TerrainRequest`, `RunStage`, `StageOutcome`, `EnRouteEvent`, `TravelLeg`, `FailureRule`, `RunPlan`, `RunPlanner`,
`CharacterRecord`, `CharacterChange`, `FloodRequest`, `RegionRealisation`; `RunRecord.end` gains `captured` and `late`,
`RunRecord.plan` / `path`. world.ts: `Faction.power`, `WorldSnapshot.characters`, events `faction-power`,
`faction-relation`. world-state.ts: `character()`, `characters()`, `applyCharacter()`, characters in `snapshot` /
`restore`. All additive; old saves (no `characters`) restore.

## Tests

`npx vitest run src/runplan` — 21 tests, ~2 s, no browser: border rules, crossings, routes per hero on a tiny graph,
seed 1's graph symmetric, affordances, a plan per hero (branching, every path to the finale, 15-50 min, routes only
over borders the hero can cross, obstacles only crossable ones, deterministic), the plan fits the hero, a played run
changes the world and the next plan reads it, save round trip, a sunk region → a water fill, the lich takes the map,
capture → rescue/escape, faction power and relations, the Journey's precache and waiting.

## Open (for the user and the other tracks)

- Terrain's graph (barriers it actually made) replaces `factsGraph`; terrain reads `TerrainRequest` and `FloodRequest`.
- Play's controller contract replaces `HEROES`.
- Structures / inhabitants / flora / sky read `RegionRealisation`.
- The stand-in GM rules are tables; a GM-written story's outcomes can replace a stage's outcomes as-is.
- RC1 pinning (sections kept resident on the GPU) needs the tile atlas's pinned set; the plan already says which
  sections (`RunStage.section`).
