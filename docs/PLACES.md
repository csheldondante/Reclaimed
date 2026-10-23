# Places — regions, rooms and the API over them (design, round 51)

The user's direction (DECISIONS round 51): generation is hierarchical, with
regions and rooms within them. The API abstracts both as named **places**,
so a runtime (a game, an LLM game master) can:
- mutate a place: storms, time of day, fog, burying it in sand, flooding it;
- query adjacent rooms, and specify connections between them;
- change what is in a room: enemies, puzzles, items, obstacles.

Spawning things in a place, and its terrain, go through Reclaimed's API. The
game may own the rest of a room's contents.

Status: design. Nothing here is built yet; it supersedes BACKLOG W2's flat
region ids and gives W1 (generation), W3 (freezing) and W4 (navigation)
their frame. The API sketch below is for the units session and the user to
mark up.

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
place.light({ timeOfDay, tint, ambient })   // a per-place light: one sun, tint/ambient per place
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

1. Places from a plan:
   - the `places` buffer, the table and the queries (`get`, `at`,
     `children`, `adjacent`);
   - a plan format: regions and rooms as SDFs, with the partition options
     from round 50 (Poisson-Voronoi islands, noise bands, boxes and halls);
   - the existing storm, bury and flood ops masked to a place.
2. Generation (W1):
   - bedrock shaped by the plan;
   - per-material layers;
   - connections carved where the plan says they are.
3. Per-place light, fog and climate; `place.state()` readback.
4. Contents: `spawn`, `spawnPoints`, obstacles on connections.
5. Freeze (W3), then navigation (W4).
