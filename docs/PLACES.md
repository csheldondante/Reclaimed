# Places — regions, rooms and the API over them (design, round 51)

The user's direction (DECISIONS round 51): generation is hierarchical, with
regions and rooms within them. The API abstracts both as named **places**,
so a runtime (a game, an LLM game master) can:
- mutate a place: storms, time of day, fog, burying it in sand, flooding it;
- query adjacent rooms, and specify connections between them;
- change what is in a room: enemies, puzzles, items, obstacles.

Spawning things in a place, and its terrain, go through Reclaimed's API. The
game may own the rest of a room's contents.

Status: step 1 built (see "Built in step 1" below); the rest is design. It
supersedes BACKLOG W2's flat region ids and gives W1 (generation), W3
(freezing) and W4 (navigation) their frame.

## Built in step 1

- `src/world/places.ts`: the model (`Place`, `Connection`), the plan
  format and its rasterization onto the hex lattice, adjacency from the
  raster, suggested connections. `src/game/places.ts`: `core.places`
  (`Places`, `PlaceRef`), also `window.reclaimed.places`.
- Plans: `{ partition: 'voronoi', spacing, group?: [1, 3], regions?, shape? }`
  (Poisson-disc seeds, cells grouped 1–3 into rooms, rooms into `regions`
  by the nearest of farthest-point seeds, default a fifth as many);
  `{ partition: 'bands', freq, tunnel, island?, regions?, shape? }` (halls
  where |noise − island| < tunnel, tagged `hall`, rooms the components
  between; slivers under 30 columns join a neighbour);
  `{ partition: 'boxes', rooms: [{ name, rect, region? }], halls?, regions? }`;
  `{ rooms: [{ name, region?, sdf }], halls?, regions? }` (hand-made; a
  room without a region goes in `world`). Every plan takes `amp` (default
  3) and `scale` (10): the borders' wander, a domain warp of the sample
  point. A hall is a band between two rooms' centres over the columns no
  room took.
- `shape`: `chain` (a walk to the neighbour with the fewest free
  neighbours, branching only where stuck), `tree` (a random spanning
  tree) or `any` (every adjacency), over rooms sharing at least 3 cell
  sides: `places.suggested()`. They are suggestions: W1 carves them.
- Queries: `get(name | id)` → a live `PlaceRef` (`id, name, kind, parent,
  children, tags, cells, centre, radius`; `rename`, `tag`), `list(kind?)`,
  `at(x, y, z?)` (world coordinates), `children(region)`,
  `adjacent(place)` (a room's rooms, a region's regions: `{ room, border,
  length, mid }`), `connections(place)`, `connect(a, b, { kind, width, at })`
  and `disconnect(a, b, { with })`. Connections are **records only** in step
  1: nothing is carved or built in the terrain until step 2 (W1).
- Mutations: `place.bury(material, depth, { noise, scale, over })` (through
  `deposit`, sediment folds it in), `place.flood(depth, { over })` (water
  added on every column; with no walls yet it runs out of the room the way
  water does), `place.drain()`, `place.storm({ intensity, duration })` (a
  storm at the centre, sized to the radius, held there by `Storm.hold`
  for `duration` seconds, then it fades). A region's op covers all its rooms.
- Not yet: the enclosed level (the high half is 0 everywhere until W1 makes
  caves; `at` with a z already reads it), `place.light`, `fog`, `climate`,
  `raise`, `freeze`, contents, `state()`, the GM's sun, and `generate(dims,
  plan)` (step 1 lays places over an existing map: `places.load(plan, seed)`).
- Test: `?plan=voronoi|tree|bands` (`?planseed=`) and
  `scripts/placestest.mjs`.

## The model

- **Place**: `{ id, name, kind: 'region' | 'room', parent, children, tags }`.
  - A region holds rooms; a room belongs to one region. Halls are rooms
    tagged `hall`.
  - Its footprint is a set of columns, painted from the plan's SDFs with
    noisy borders.
  - Its extent is its floor and ceiling heights where it is enclosed: a cave
    room under a hill, a room under an overhang.
- **Connection**: `{ a, b, kind, at, width, state }` between two adjacent
  rooms.
  - `kind`: open, door, gate, or one of the obstacle kinds (rubble plug,
    boulder, ice wall, vines, water, sand).
  - `state`: open or closed.
  - `at`: where on the border they meet.
- **Contents**: what Reclaimed spawned in a place. Each item carries a handle
  and a kind: a model, a physics body, a material deposit, an obstacle, or a
  spawn point.
  - Enemies and puzzle logic are the game's.
  - Reclaimed places them and keeps the terrain they stand on consistent.

Where a place is depends on height as well as column (units session
markup a): a cave under a room is its own place, for weather, freezing and
what the AI sees. So on the GPU there is one new contract buffer, `places`:
a u32 per column holding two u16 room ids.
- The low half is the room of the open air on top of the column.
- The high half is the room of the first enclosed level under it, the air
  under an overhang or inside a cave; 0 means the same room as the top.
- A room's region comes from the place table, not the buffer.

Lookups take a height: `at(x, y, z)` picks the level z falls in from the
column's intervals. Two levels a column is enough for now; more can come if
plans need them. Navigation surfaces carry their own place id (W4).

There is also a small uniform table, one entry per place, holding what
systems read per place: its region, fog, a light tint and ambient, a
temperature offset, wind, and freeze bits.

## API sketch

```ts
const places = core.places;                 // after generate(dims, plan)
// the plan, either way (units session markup 1): generated from parameters, or drawn by hand
//   { partition: 'voronoi', spacing, group: [1, 3], shape?: 'chain' | 'tree' | 'any' }
//   { partition: 'bands', freq, tunnel: t, island: off }   (near 0: tunnels; a bit off 0: islands)
//   { partition: 'boxes', rooms: [{ name, rect }], halls: [{ a, b, width }] }
//   { rooms: [{ name, region, sdf }], halls: [{ a, b, width }] }   (a hand-made plan)
// shape biases the room graph toward a corridor of rooms (chain) or one with branches (tree),
// for lock-and-key layouts; the generator knows no keys: a game reads the graph and
// connect()s rooms with the obstacle a unit's ability opens (melt, levitate, smash, swim)
places.get('north-cavern')                  // by name or id → Place
places.at(x, y, z?)                         // the room at a point (z: under an overhang or on top; default the top)
places.children('ashlands')                 // a region's rooms
places.adjacent('north-cavern')             // [{ room, border: cells, length, mid }]
places.connections('north-cavern')          // [{ to, kind, at, width, state }]
places.connect(a, b, { kind: 'open' | 'door' | ..., width, at? })  // carves or builds it in the terrain
places.disconnect(a, b, { with: 'wall' | 'rubble' | 'water' | 'sand' | ... })

// mutations: weather and light are per place; terrain ops are masked to the footprint
place.storm({ intensity, duration })        // a storm over it (weather.spawn, sized to it)
place.light({ tint, ambient })              // per-place colour coding: a tint and ambient for each place

// the sun (the user, via the units session): one directional light casts the shadows;
// it follows the time of day until the GM takes it, and goes back to the clock on release
core.sun.take({ dir, colour, intensity })   // dir: a unit vector (or { azimuth, elevation }); any field optional
core.sun.set({ dir?, colour?, intensity? }) // while taken; blends over `blend` seconds if given
core.sun.release({ blend? })                // back to the time of day, eased over `blend` seconds
core.sun.state()                            // { dir, colour, intensity, taken }
place.fog(density, colour?)
place.climate({ temp })                     // an offset on the world's temperature
place.bury(material, depth, { noise? })     // pour over it (sand, snow, ash…), drift-shaped
place.flood(depth) / place.drain()
place.raise(layer, amount, { noise })       // the per-layer editor op of W1, inside the place
place.freeze(systems = 'all') / place.thaw()

// contents
place.spawn('model' | 'body' | 'obstacle' | 'deposit', spec, { at? })   // → handle
place.spawnPoints(n, { clearance, onFloor })  // places a game can put its enemies or items
place.contents() / place.remove(handle)

// reading back (a readback every few ticks, per place)
place.state()  // { water, loose depth, snow, fire, contamination, green, bodies, frozen }
```

## How the pieces map onto what exists

- **Footprints**: the level kit's SDF shapes (world/kit.ts) are already the
  way levels are drawn. A plan's room is an SDF, plus noise for its border.
- **Storms**: `weather.spawn` at the place's centre, sized to it.
- **Burying and flooding**: the editor's deposit and water ops, masked by
  the `places` buffer.
- **Fog, tint and temperature**: read from the per-place table by the
  render and climate passes.
- **Obstacles**: woken bodies (physics/wake.ts), stamped models, or loose
  plugs, all through the same terrain writes the kit uses.
- **Freezing**: each system's kernel checks the place's freeze bits at the
  top. This stops change, but the dispatches still run, so it saves little
  compute. Saving compute is half the point, so the plan is to dispatch
  only over active chunks later (markup c).
- **Navigation (W4)**: walkable surfaces stacked per column, each carrying
  its place id, linked to the six neighbours of Reclaimed's hex grid where
  heights meet.
  - `nav.field(seeds, {archetype})`: one field per target kind (the player,
    resources, cover), with a distance and a direction on each surface.
  - `nav.scent`: deposit and decay.
  - `nav.surfaces(place)`: the surfaces of one place, so a horde can be
    kept to its room on the GPU rather than by a CPU callback.

## Order of work (proposed)

1. ✓ Places from a plan:
   - the `places` buffer, the table and the queries (`get`, `at`,
     `children`, `adjacent`);
   - a plan format: regions and rooms as SDFs, with the partition options
     from round 50 (Poisson-Voronoi islands, noise bands, boxes and halls);
   - the existing storm, bury and flood ops masked to a place.
2. Generation (W1):
   - bedrock shaped by the plan;
   - per-material layers;
   - connections carved where the plan says they are.
3. Per-place light (tint, ambient), fog and climate; the GM's sun
   (take / set / release); `place.state()` readback.
4. Contents: `spawn`, `spawnPoints`, obstacles on connections.
5. Freeze (W3), then navigation (W4).
