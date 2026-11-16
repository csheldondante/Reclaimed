# World mutators

Branch `mutators` (from `fortress` 555bdca3). Code: `src/mutate/`, `src/shaders/mutate/`, `src/scenes/level/mutators.ts`.
Test: `test/gpu/mutators.test.ts`. Lab: `/?skipmenu=1&level=atlas&town=1&mutlab=1&fresh=1`.

## The user's words (2026-11-15)

- "More focus on mutations since we have so much built in that area for a reason. I want melted, flooded, buried, burned etc"
- "…then see the mutations from all your choices. Abandoned cities. Magma burned land. Floods. Buried things. Zombies.
  Undead cities. Totalitarian lockdowns etc. Strategy loop is just preparing for the opportunity and mutating the world."
- The mechanism: "Try making instant mutators instead since a lot of opportunities will happen in other area of the world
  like new mining settlements or other cities being captured or destroyed or occupied or made into vassala that have to
  pay tribute or invoke negative opportunities".
- The principle: "the local simulation and playable battle make the instant mutations read as fully simulated and the
  whole point is it feels like the whole world changes in reaction to your choices".

## The design note (AGENT_RULES §1)

- **Data flow.** The truth is the **world modifier list** (`mutate/list.ts`, CPU, JSON): one entry a mutation, with
  every number its op needs fixed when it is applied (from the atlas's macro ground, never from the window). The land's
  state lives where it always has: the columns (`WorldGpu.layers`), `water`, `veg`, the lava contract's ground heat. A
  lot's state lives in one new GPU buffer, the **condition word** (below). Nothing is copied to the CPU.
- **The ops** (`shaders/mutate/`): one dispatch an entry over a box of the window (`mutLand`, a thread a column) and one
  a town (`mutLots`, a thread a lot record). Each is a pure function of the column (or record) and the entry: masks at
  the world position, noise hashed from world lattice points, every write idempotent. So land written whole, a region
  at a time as it streams in, or twice, ends the same.
- **Readbacks.** None. The lab and the test read a write's two timestamps (16 B) when timing is asked for.
- **When it runs.** `apply` writes what is in the window at once. `Streamer.onWritten` (after the static claims) writes
  every entry that reaches an arriving region. `FieldTowns.onMade` writes a new town's lot conditions. Zero work when
  the list is empty. No sim is woken; the liquid only forgets its records of the chunks written, as it does for
  arriving land.
- **Cost.** Desktop (Dawn, D3D12), radius 20 on a 64 × 64 world, land + lots: flooded 0.07 ms, burned 0.20 ms, melted
  0.13 ms, buried about the same. The phone is not measured yet (BACKLOG MU-9).
- **Rejected.** A staged time-lapse that queues the sims' own events and keeps them awake (the first plan): it cannot
  reach land that is not loaded, costs seconds of live sim, and its result depends on what was awake.
- **Persistence.** The list is saved in the world store (key `mutators:list`), and that is all. Mutated regions are
  not marked as touched by play: they are derived (generator + list) and written again on arrival. A region that play
  did change is saved with the mutations in it; the ops are idempotent, so taking them again changes nothing.

## The contract (`src/mutate/index.ts`)

```ts
mutators.list()                                   // kinds: { kind, group: 'land' | 'state', name, description }
mutators.apply({ kind, place?, at?, radius?, strength?, seed?, by?, tribute?, name?, size? })  // → Applied
//   place: an atlas settlement id; at: world cells [x, row]. Applied: the entry + resident (written now?) + fresh
mutators.play(entry)                              // presentation; not built (resolves at once): MU-3
mutators.places() / mutators.place(id)            // PlaceState: owner, status, tribute, population, conditions, restless
mutators.record() / mutators.restore(record)      // the list as JSON
```

The same modifier applied twice is one entry (its id: kind, place or cell, radius, strength, seed, by, tribute).

## The mutators

| kind | what is written | lots |
|---|---|---|
| flooded | `water` up to a level over each column's top (never lowered). The level: the lowest macro ground of the area plus a share of its rise (not under the sea); it falls away over the last 18% of the radius | drowned where the level is half a cell or more over the lot's base |
| burned | plants removed; soil's top 0.3 becomes ash (the fire sim's own material); ragged edge, patches spared under strength 1 | burned (walls black, roof gone, height × 0.6) |
| melted | a basalt cap (the lava sim's set rock) in a pool round a vent and a lobed tongue downhill (the direction from the macro ground), 0.4–3 cells thick, never over ground higher than the vent; water removed; cracks set to 1150° ground heat, which the render fields already draw as glow | destroyed (a dark stump; the claim released) |
| buried | a sand interval on the top: dunes across a seeded wind, thinning to nothing at the rim; up to 2 + 5 × strength cells | buried where the sand is a fifth of the building's height or 1.2 cells |
| dried | `water` lowered by 1 + 3 × strength cells (deeper water stays as pools), the columns' `waterSource` shut, bank plants browned (`wilt`) | none |
| withered | the plants' own dead state: `wilt` fully brown and the ground hostile, so woken plants stay dead | none |
| greened | the plants' field raised to shrubs and woods on soil, healthy | none |
| destroyed | — | every lot of the place burned; population 0 |
| abandoned | — | standing lots abandoned (faded, sagging) |
| captured | — | standing lots occupied (the roof in the holder's colour) |
| vassal | — | none; owner and tribute in `places()`; `restless` true |
| founded | — | a record and a pin; the town generator does not build it yet (MU-6) |

A column whose top is a building's External span (a cell or more thick) is left alone; a road's paving is ground.

## Signs

"Weather effects too. Darkness and ash raining down are a great way to indicate a distant eruption. Having random
undead rise in the city or crime are all indicators." (the user, 2026-11-15)

`mutators.sign({ kind, place?, strength, until? })` (strength 0: off), `mutators.signs(place?)`, `mutators.season(n)`
(the loop's season number; a sign past its `until` ends). Saved in the record with the list. A `melted` entry applied
away from the home town casts `ashfall` and `darkness` on it for three seasons, strength by distance (0.3 at 4000
world units or more).

| sign | what shows (all existing systems) | cost while on |
|---|---|---|
| ashfall | the particles' ash kind, a few bursts a frame over the view | up to 4 burst requests a frame |
| darkness | the sun and sky scaled and browned in the Globals (`WorldCore.skyDim`) | none |
| deadrise | 4–12 `shambler` units (undead by the traits) in the town's streets | the units' own |
| crime | 6–22% of standing buildings `looted` (condition 10); `unrest` on the sign | none (one dispatch on, one off) |

## The map

"the whole point is to make the map a living visual representation of your choices". `AtlasMap.overlay` draws every
entry at its place: a land entry's area in its kind's colour (a tongue along the flow for `melted`, a bar for a dry
reach), a cross for a destroyed or abandoned place, a house for a founded one, a flag for a holder; `AtlasMap.marks`
adds a pin with the place's name and what happened. The map's own image (ground, rivers) is not redrawn (MU-5, MU-16).

## The lot condition word

`CityGen.condition` / `CityLots.condition`: one u32 a lot record, beside the progress buffer. Low byte:
`LOT_CONDITION` (0 standing, 1 drowned, 2 burned, 3 destroyed, 4 buried, 5 abandoned, 6 occupied, 10 looted; 7–9
reserved for overgrown, undead, lockdown). Next byte: how far (0–255; for occupied, the holder's hue). Bits 16–23 are free for
BACKLOG TM6's disrepair. `streets.wgsl tlRise` reads it (binding 5): `condColour` tints, `condHeight` cuts.
`claimLots` reads it (binding 3): a destroyed lot keeps no claim. `FieldTown.conditionsChanged(reclaim)` draws again.

## Assumptions for the owner

1. A flood's level comes from the atlas's coarse ground, so it is the same for loaded and unloaded land. It is not a
   true basin fill: on open sloping ground the water stands where the sim would let it run off.
2. Buildings are not written into; their lot's condition shows what happened. Sand and rock do not pile on roofs.
3. Mutated land is derived from the list, not saved as changed regions.
4. `captured` shows as a roof colour from the holder's name. `vassal` changes no lot.
5. The far place's pin on the map is the map's own pin, with the place's name and what happened, not a tint.

## Hand-over: what is next

See BACKLOG `MU-*`. In order: the reveal (MU-3); a true basin level from `terrain/flood.ts` for region-scale floods
(MU-1); sediment against walls and in the lee (MU-2); founded places built by the town generator (MU-6); abandoned and
overgrown, undead, lockdown through the reserved condition values and the traits system; the phone bench (MU-9).
