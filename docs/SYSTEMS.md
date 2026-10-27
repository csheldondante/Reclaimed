# Systems — the legacy-game engine, each behind its API (round 83)

The user (DECISIONS round 83):
- "I would rather orchestrate and plan these systems in parallel and abstract them behind an API so we can
  iterate and improve them all across multiple sessions."
- "Fixing the performance and quality of the fluid simulation or destruction shouldn't fundamentally matter to
  dialogue or the atlas updates. It should only improve the believability and performance."

**What it's for.** An engine for legacy games: roguelike runs where death is always possible, and where the
player's choices leave lasting, visible marks on the world. "All that matters is the illusion of a living
world": take every shortcut that keeps it fast and more compelling.

This doc is the map. Each system has:
- **an owner:** one session or branch at a time;
- **an API:** what other systems may call;
- **events:** what it publishes;
- **contract data:** what it reads and writes.

Anything not on its API is private: a system may rewrite its insides freely, as long as the API holds. The
world API's rules (docs/WORLD_API.md) apply to every system here:
- installed on its own;
- queries answered from a mirror;
- commands queued inside;
- events out;
- private insides.

## Three time scales

Every change to the world happens at one of these. A system says which it works at.

| Scale | When | Cost budget | Examples |
|---|---|---|---|
| **Atlas** | between runs; when a story event fires | seconds, offline or behind a loading beat | a region sinks into the sea; a volcano buries a city in ash; a forest overgrows ruins; freezing; an ever-storm; eternal shadow; the dead rise; a faction turns hostile |
| **Arrival** | land streams in | a few ms a region, spread over frames | the region's state realised in its columns, already settled (rivers flowing at their dryness, ash in layers, ice on the lake) |
| **Play** | near the player, as things happen | the frame budget (phone: 16 ms) | collapse, floods, fire, dust in the wind, agents digging; simulated only while out of steady state, then frozen as an animation |

Rule: work happens at the slowest scale that still looks right. Erosion, regrowth and weather over time are
atlas-scale (computed once, per event or between runs); play-scale simulation is only what the player is
there to see react.

## The systems

Each entry: status (✓ built, ◐ partly, ○ not started), owner branch, API sketch, events, contract data.

### 1. World state (atlas scale) ◐ — branch `places`
The persistent world between runs: the atlas, its regions, and each region's state.
- **Has:** the atlas (generation, rivers, sites, roads, the coarse world: craters, ash, set lava). Region
  state isn't a first-class record yet.
- **API:**
  - `world.region(id) → RegionState`
  - `world.apply(event: AtlasEvent)`
  - `world.history(region?) → AtlasEvent[]`
  - `world.save() / load()`
- **RegionState** (the contract every generator reads):
  - `sunk` (0..1, under the sea);
  - `ash` (cells);
  - `overgrowth` (0..1);
  - `frozen` (0..1);
  - `storm` (kind, strength);
  - `shadow` (0..1);
  - `undead` (0..1);
  - `factions` (id → attitude);
  - `ruin` (0..1);
  - `flooded` (level);
  - `wetness` (dryness for rivers);
  - `era` / `style`;
  - `marks` (named things the story left: a statue, a grave, a crater named for someone).
- **AtlasEvent:**
  - `{ kind, regions | area, magnitude, at (run/time), cause (story id | player | world) }`
  - Kinds: sink, raise, bury(ash/sand), overgrow, freeze, thaw, storm, shadow, raise-dead, faction-attitude,
    flood, drain, burn, ruin, rebuild, mark.
  - Applying one changes RegionState (and the coarse world where it has a shape: a crater, a lava field).
- **Events out:** `region-changed(id, before, after)`, which the overmap and generators listen to.

### 2. Overmap ◐ — branch `places`
The fantasy map: travel between places; shows the world's history.
- **Has:** atlas-map.ts (the map), warping.
- **API:**
  - `overmap.show(state)`
  - `overmap.travel(from, to) → Journey` (time passes; encounters roll)
  - `overmap.poi(regionId) → Place[]`
- **Reads:** RegionState (styles the map: sunk is sea, ash is grey, overgrowth is green, frozen is white,
  storm is a swirl, shadow is dark, factions as banners).

### 3. Region generation (arrival scale) ◐ — branch `places` (generators: `atlas`, `rivers`)
Turns a region's ground plus its state plus a brief into columns, settled.
- **Has:**
  - the atlas column generator (forms, caves, ways);
  - places plans (docs/PLACES.md: voronoi, bands, boxes, rooms);
  - LOD rings;
  - the shore field.
- **Not yet:**
  - region briefs: rooms, paths, key/door layouts;
  - state realisation: ash, ice, overgrowth, ruin and flood applied from RegionState;
  - steady-state rivers. Branch `rivers`: the atlas's watersheds, discharge as a function of dryness, flow
    render-only.
- **API:**
  - `generator.brief(regionId, RegionState, storyHooks) → RegionBrief`
    - `RegionBrief`: rooms, connections, locks and keys, landmarks, spawns (unit kinds and counts by room),
      items, hazards.
  - `generator.columns(rect, brief) → columns` (settled: steady state within tolerance)
  - `generator.places(brief) → Place[]` (docs/PLACES.md)
- **Contract:** the window's layers (world/layout.ts), `core.places`, spawn lists for 6 and 7.

### 4. Simulation (play scale) ◐ — branches `places`, `flow`, `perfopt`
Everything that makes the local world react. Its quality and cost are its own business.
- **Has:**
  - terrain edits (the world API);
  - solids: integrity bodies, rock by columns;
  - water, oil and lava pipes;
  - loose ground (sediment);
  - fire;
  - wind;
  - weather and day/night;
  - sleep;
  - the shore field.
- **In progress:** branch `flow`, one interval flow for liquids and loose ground: Noita-simple rules in column
  space with velocity, arcing falls, near-steady state frozen as animation, frozen flux rescaled as supply
  changes.
- **API:** the world API (docs/WORLD_API.md), plus:
  - `sim.perturb(x, y, r)` (wake: something happened here)
  - `sim.settled(rect) → boolean` (near steady state: frozen)
  - `sim.freezeTolerance` (tuning)
  - `sim.queries`: height, floor, material, water depth, flow at
- **Events out:**
  - `collapsed(where, mass)`
  - `flooded(where)`
  - `burned(where)`
  - `settled(where)`

  The story and agents listen; they don't read buffers.
- **Rule:** nothing outside reads its buffers or depends on how it computes. The fluid and destruction work
  improves believability and performance only.

### 5. Rendering and camera ◐ — branches `places`, `perfopt`, `ceiling`
- **Has:**
  - the deferred terrain, LOD rings and far land;
  - the shore swell;
  - gems;
  - the phone tier;
  - the camera: fixed view, puck, slice, orbit (with `prefer`), dither, fly.
- **API:**
  - `camera.mode(...)`
  - `cut.slice / orbit / dither` (api/cutaway.ts)
  - `renderer.quality`
  - `renderer.windowMoved`
- **Reads:** sim fields through contract buffers only.

### 6. Units and agents ◐ — branch `agents` (and the hoverbike session's heroes)
Units that walk, work, build, shape terrain, fight and flee.
- **Has:** docs/AGENTS.md (walkable surfaces from intervals, flow-field groups, jobs as fields; on `agents`).
- **Not yet:** a unit generator (archetypes by role, faction and era); attitudes tied to factions; work that
  visibly shapes terrain in play (it goes through the world API's edits like any other).
- **API:**
  - `units.spawn(kind, at, faction)`
  - `units.order(group, job)` (job: dig, build, haul, fell, patrol, attack, flee)
  - `units.query(near)`
  - `unitgen.make(role, faction, era, seed) → UnitKind` (stats, model, abilities, voice for dialog)
- **Events out:**
  - `died(unit, cause)`
  - `built(what, where)`
  - `dug(where)`
  - `noticed(player)`
  - `attitude-changed`

### 7. Things: items, units, vehicles, buildings as compositions ◐ — `places` (round 85)
- **Has (contracts):** src/api/contracts/recipe.ts — kinds and tags, slots, recipes (assemble, craft, train,
  adapt, salvage), instances with parts, material, condition, owner, place and history; capability rules;
  civilization profiles (what a people uses, repairs, makes, understands); compose.ts `derive` and `plan`.
  One model for units, items, vehicles and buildings (DECISIONS round 85).
- **Diplomacy (contracts):** src/api/contracts/diplomacy.ts — interactions between factions and people,
  fading, for dialog; agreements beyond war and peace (trade, land and mineral rights, passage, tribute);
  opinions derived; MemoryDiplomacy.

### 7b. Items (generators) ○
- **API:**
  - `itemgen.make(kind, era, rarity, seed) → ItemKind`
  - `items.spawn(item, at)`
  - `inventory(owner)`
- **Keys:** keys are items bound to a brief's locks (system 3).
- **Events out:** `picked(item, by)`, `used(item, on)`.

### 8. Heroes and controllers ◐ — the hoverbike session
- **Has:** hero prototypes:
  - a flying lich;
  - a hoverbike knight;
  - a tank;
  - a mech;
  - a hookshot knight.
- **Also has:** touch controllers; the chase camera with `Orbit.prefer`.
- **API:**
  - `hero.role → { controller, abilities, camera preference }`
  - Abilities act on the world only through the world API, units and items.

### 9. Narrative / game master ◐ — branch `gm` (docs/GM.md); the storyteller work (separate project) behind an adapter
The GM writes objectives with triggers and outcomes from a persistent world wiki.
- **Has (round 84):**
  - the world wiki (src/gm/wiki.ts; `scripts/worldwiki.mjs`, the atlas cached in data/atlas/);
  - the GM's context (docs/GM.md);
  - the validator (src/gm/storycheck.ts, `scripts/storycheck.mjs`);
  - `GameMaster.brief(snapshot, player) → SessionStory` with `FileGM` serving data/stories/;
  - the first story (data/stories/the-bell-under-kaudru.json).
- **API (the adapter):**
  - `gm.brief(world snapshot, player record) → Objective[]`
    - Objective: text, trigger conditions on events from 4, 6 and 7, and outcomes:
      AtlasEvents for system 1, faction changes, items granted, units spawned.
  - `gm.react(event) → Beat?`
  - `gm.dialog(unit, context) → DialogNode`
- **Reads:**
  - the world wiki: RegionState, history, factions, marks;
  - the run log.
- **Writes:** only AtlasEvents and spawns, through their APIs.

### 10. Dialog ◐ — branch `dialog`
- **API:** `dialog.open(node)`, with choices, `onChoice → effects` (effects are the same outcomes as
  system 9: attitude, items, events). The UI is for phones first.
- **Has (round 83):** src/dialog/dialog.ts `DialogBox` (contracts/dialog.ts `Dialog`, plus `onNode`);
  story cameras in src/story/camera.ts (frame a speaker, reveal, follow); src/story/play.ts plays a
  SessionStory on a level over the world API (`?story=demo`). ARCHITECTURE.md "Dialog, the run and story
  cameras".

### 11. Run lifecycle ◐ — branch `dialog`
- **Has (round 83):** src/run/run.ts `StoryRun` (contracts/run.ts `Run`): objectives, conditions,
  outcomes (AtlasEvents applied to the WorldState), `end → RunRecord`; src/run/validate.ts checks a story;
  src/run/hud.ts the objective list. Not yet: `start(hero, at)`, `between(runs)`.
- **API:**
  - `run.start(hero, at)`
  - `run.end(cause)`: death, escape or objective done
  - `between(runs)`: apply queued AtlasEvents; advance the world (regrowth, erosion, weather, faction drift)
    at atlas scale, precomputed rather than simulated
  - `run.log`: what happened, for the GM and the overmap

### 12. Build mode (places editor) ◐ — sandbox editor, `builder`
- **Has:** the sandbox editor; the town grid (builder).
- **API:** `build.place(model | brief fragment, at)`, `build.save(place)`; the same data as system 3's
  briefs, so hand-made and generated places are one format.

## How the systems connect: events, not calls into insides

```
story (9) ──AtlasEvent──▶ world state (1) ──region-changed──▶ overmap (2), generation (3)
generation (3) ──columns, places, spawns──▶ sim (4), units (6), items (7)
sim (4) ──collapsed/flooded/burned──▶ story (9), units (6)
units (6) ──died/built/noticed──▶ story (9), run log (11)
run end (11) ──queued AtlasEvents──▶ world state (1)
```

## Working across sessions

- Each system has one owner at a time (a session or agent on a branch). It may change its insides freely;
  changing its API is a DECISIONS item, with every user of it listed.
- APIs land as TypeScript interfaces in `src/api/` before the implementation: callers code against the
  interface; a stub implementation lets them run before the real one exists.
- Each system ships a test that drives it through its API only, like scripts/worldapitest.mjs and
  atlasworldtest.mjs.
- `places` is the integration branch. Experiments go on their own branches (`flow`, `rivers`, `ceiling`,
  `perfopt`) behind URL flags, and merge back when they win.
- The headless browser and the GPU are shared: agents ask "main" for them.

## Order (the user, round 83)

The user: "get dialogue in and basic cameras so we have a way to communicate what is going on"; "a GM (for now
a subagent with GM context and tools) take the world state wiki and offline create a session story as data
that we can use to create the locations, dialogues, objectives and world effects"; "dialogue and settlements
first … agents that are workers or hostile … the settlements at least use the same data structure we plan
to expose to the city management game"; items, units and diplomacy are the user's ideas to talk through
first — "it will feel more cohesive if we have at least the first pass at the data structure for that in play
before creating heroes or their stories".

1. ✓ The contracts as types (`src/api/contracts/`): world.ts (RegionState, AtlasEvent, Faction,
   WorldSnapshot, WorldState), story.ts (SessionStory: locations, cast, dialogs, objectives, conditions,
   outcomes), dialog.ts, run.ts, settlement.ts (a DRAFT, for the user's ideas), and a reference
   MemoryWorldState (world-state.ts).
2. Dialog: the system that plays a DialogTree (phone-first UI, choices, effects through Outcome) and basic
   cameras to frame a talk and show what's happening (a cut to a speaker, a reveal of a world effect).
3. ◐ (round 84, `gm`) The GM: a subagent with the GM's context and tools reads a WorldSnapshot and writes a SessionStory (JSON),
   offline; a validator checks it against story.ts (every reference resolves).
4. ◐ (round 85) The data for items, units and diplomacy: recipe.ts, compose.ts, diplomacy.ts; settlements on
   overlay grids with buildings as things.
4. Settlements and agents: the settlement data (with the city game's needs), placed by the region generator,
   worked by agents (workers) and raided by hostile ones; items, units and diplomacy after the user's ideas.
5. Then heroes and their stories on top.
