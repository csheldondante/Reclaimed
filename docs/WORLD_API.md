# The world API — Reclaimed as an engine (round 52)

The user's direction (DECISIONS round 52, relayed by the units session):
- **Modules.** Each Reclaimed system is a module the game layer uses. The
  game builds its controls and abilities on them, and they interact through
  the shared world: the bike's air blows dust because it uses the wind.
- **Engine and world.** Reclaimed is the engine; the world is the game's.
  A game hands in a definition of its world, as data, and gets a sim of it.
  Reclaimed's own game (Nature, the reclamation score, the story rules,
  powers, levels) is one client, not part of the API.

Code: `src/api/`. Test: `scripts/worldapitest.mjs` (every query against the
raw buffers, every command for its effect).

## The rules every module keeps

**(a) Installed on its own.** A module is present only if asked for:
`createSim(host, { …, modules: { terrain: true, wind: true } })` has
`sim.terrain` and `sim.wind`, and `sim.water` is undefined.

**(b) Queries from a CPU mirror.**
- Positions are in world coordinates, and formats are decoded on the engine's
  side (the surface's 8.8 bits, the drift texture, lava's vec4).
- One mirror serves all of a sim's modules: one staging buffer, one copy of
  everything they registered, one map.
- It refreshes every 250 ms by default (`refreshMs`; 0 for only on request).
  A read takes 22 ms median on the 256 × 256 sandbox, for about 7 MB.
- `sim.readAt` says when it was read. `await sim.refresh()` resolves with
  data read after the call.
- Until the first read, queries return null.
- Typed views of each read are made once and shared by every query, so a
  few hundred queries a frame cost nothing to speak of: a smooth height
  sample takes about 2 µs.

**(c) Commands queue inside.** Caps are handled inside, by queueing or
merging, never thrown at the game or silently dropped:
- Events (edits, ignite) wait for the next tick past a tick's four.
- Particle bursts spawn over the next ticks past a tick's 64.
- Wind entries are merged past the wind field's 256 a tick.

Bad arguments, such as an unknown material or fx name, do throw. That's a
bug in the call, not a cap.

**(d) Events out.** Planned per module: fire catching and spreading,
physics impacts, agents' swings, deaths and burns. None of steps 1–3 sends
events yet.

**(e) Private insides.** Buffers, Globals fields, PK ids and packed formats
stay behind the API, so the engine can change them freely.

## Built (steps 1–3)

```ts
const sim = createSim(host, worldDef)   // a world from its definition (below)
const sim = attachSim(core, modules?, warmup?)   // the modules over a WorldCore a scene already runs (the level: reclaimed.api)
await sim.ready                         // the warmup asked for at creation (WorldDef.warmup or attachSim's), if any
await sim.warmup({ ticks, debris, skip })        // settle the world: ticks of sim at once, debris (dust, litter, leaves)
                                        // gathering `debris`× faster (the levels use 10), plants left out (skip ['ecology'])

// plants (round 63)
sim.plants.vegAt(x, y)              // the succession field: ~1.2 grass, 2.6 shrubs, 3.6+ woods
sim.plants.treeAt(x, y) / treesNear(x, y, radius)   // { cx, cy, x, y, species, trunk, crown, logs }, nearest first
await sim.plants.fell(x, y)         // that column cut back to grass: → the tree as it stood (its logs), or null
sim.plants.grow(x, y, { radius, strength })   // the plants rise (60: a wood at once)
// work crews (round 63; docs/AGENTS.md "Crews"): dig or fell, carry to a pile
const crew = sim.crew({ units, groups: [3 free], fields: [2 free], job: { kind: 'dig' | 'fell', … }, pile, make? })
crew.update(units)                  // each frame, after agents.sync()

// terrain
sim.terrain.heightAt(x, y, { smooth? })  // the open sky's floor: ground, loose ground on it, or a structure's top
sim.terrain.groundAt(x, y, { smooth? })  // the nature grid's own ground (structures ignored)
sim.terrain.floorAt(x, y, z)        // the highest floor of open air at or below z (+0.5): under an overhang, in a cave
                                    // or bore (round 62), inside a structure. From the mirror (250 ms), a few µs a call
sim.terrain.materialAt(x, y, z?)    // 'sand' | 'stone' | … | 'air' at height z; the top layer's without z
sim.terrain.layersAt(x, y)          // [{ z0, z1, material, state: 'solid' | 'loose' | 'liquid' | 'plant' }] bottom up
sim.terrain.crater(x, y, { radius, z? })
sim.terrain.dig(x, y, { radius, layers })
sim.terrain.deposit(x, y, 'sand', { radius, layers })   // loose only: it falls, lands, slumps
sim.terrain.build(x, y, 'stone', { radius, layers })    // solids only
await sim.terrain.take(x, y, amount)  // exactly, off the top interval of that column: → { material, amount } (round 63)
await sim.terrain.put(x, y, 'brick', amount)  // exactly, on top of that column (a solid or loose material): → amount put
                                    // (0: the column has no free interval for a new material, BACKLOG Q21). 64 in flight

// water
sim.water.depthAt(x, y); sim.water.levelAt(x, y, { smooth? })
sim.water.flowAt(x, y)              // [vx, vy] cells/s (approximate: outflow over depth)
sim.water.flood(x, y, { radius, depth }); sim.water.drain(x, y, { radius, depth })

// fire
sim.fire.fireAt(x, y)               // 0..1
sim.fire.lavaAt(x, y)               // { depth, temperature °C, level } | null
sim.fire.heatAt(x, y)               // °C: ground heat, lava, a fire as 600 × intensity
sim.fire.ignite(x, y, { radius, intensity })   // fuel catches (grass, trees, oil, trash); bare ground doesn't

// wind
sim.wind.blow({ x, y, radius, strength, mode: 'along' | 'out' | 'in' | 'swirl', dir, time }) // → handle: set(), stop(), alive
sim.wind.gust(x, y, radius, strength, dir, time = 0.3); sim.wind.blast(x, y, radius, strength, time = 0.25)
sim.wind.stroke({ from, to, radius, passes, cap })     // paint a segment once, as the player's drag does
sim.wind.wake(id, { at, vel, width, passes, cap })     // each frame, per mover
sim.wind.fieldAt(x, y)              // [wx, wy] cells/s: the map's wind + painted (storm swirls not included)
sim.wind.liftThreshold('drift')     // the wind a loose material lifts above

// fx
sim.fx.burst('dust' | 'litter' | 'leaves' | 'ash' | 'chips' | 'cloud' | 'splash' | 'smoke' | 'embers'
           | 'flame' | 'haze' | 'seeds' | 'sparks' | 'petals' | 'grains', x, y, z, { count, speed, spread, vel, material })
// vel: cells/s added to each particle's own random velocity, so a mover's dust trails behind it (round 58; not birds)
```

### Layer pulls (BACKLOG API2)

```ts
const s = sim.terrain.pull('stone', { mode: 'lift' | 'through', roughness?, lean?: { dir, amount } })
s.to(x, y, { radius, height })   // each frame of a drag: a moving centre, a growing height
s.end()
sim.terrain.pullLayer('stone', x, y, { radius, height, mode? })  // one call
```

Grab a material's layer and pull it: its run in each column under the
brush grows toward `height` × the brush there (a dome, (1 − r²)²), or sinks
with a negative height. What lies over it moves with it.

- **Roughness.** The brush is roughened by the material's own noise:
  0.6 for solids (stone comes up with a broken outline), 0.15 for loose
  ground. Pass `roughness` to change it.
- **Lean.** A pull can lean (`lean`): higher toward `dir`.
- **Modes**, for what lies on the pulled run:
  - `lift`: everything above rides up with it. Loose cover then slumps off
    the steepened sides by itself (the sediment pass), so its volume is
    conserved.
  - `through`: the solids just over it crack to their rubble (the same
    volume) and ride up too, then slump and part.
- **Volume.** The pulled material comes from nowhere: an authoring tool,
  like the sandbox's bedrock brush. Pulled down, what's over it sinks with
  it.
- **Shaken off** (`shake`, 0..1, default 1; rounds 53 and 55). Where a
  pull lifts loose ground, for 4 s (fading) that ground slips at an angle
  up to 80% shallower (× shake), slides up to 1.5× as fast, and roots let
  go of it. So it runs off the new slope rather than riding up on it, as
  off a rising volcano: still the sediment pass moving it, so still
  conserved. Measured: 3 s after a 6-cell pull, 93% of the sand stays on
  the dome's top unshaken, 63% shaken (1).
- **A column without the material** grows a new run of it under its loose
  ground, if the column has a free slot.
- **Drags compose.** Each column remembers how much the stroke has given it
  (8 strokes at once; a ninth takes over the oldest). A call only moves a
  column toward the most the stroke has asked of it, so repeated or
  overlapping calls never stack.
- **Queue.** Up to 16 calls go each tick; the rest wait for the next.
- **Not yet:**
  - `conserve: true` (the same volume taken from the material's run in a
    ring round the brush);
  - shoving sideways (moving what's inside a column to its neighbours);
  - `expose` (strip the covering layers down to a material).

### Smooth sampling

`{ smooth: true }` samples the ground the way the field mesh draws it, so a
rider glides instead of stepping hex to hex. It's a CPU port of
fieldmesh.wgsl, hash for hash:
- Each column's top is blended over the three nearest cell centres, with
  barycentric weights on the triangle lattice of centres. (The field mesh
  does this, not a (1 − d)² falloff.)
- The blend is taken at the point meshregion.wgsl's warp moves (x, y) to.
  The warp depends on height, so the height is found in two steps from the
  unwarped blend.
- Only the materials the mesh draws are blended. Ruins drawn as prisms and
  structures' cubes stay sharp: over one, its own top.

For water, `levelAt` blends the columns' water levels over the same three
centres, unwarped, as the sheet is drawn.

Measured on the sandbox against the mesh's own up-facing vertices:

| Vertices | Smooth (median) | Stepped (median) |
|---|---|---|
| All 4,000 | 0.011 | 0.034 |
| The 545 where the hexes step (slopes, banks) | 0.024 | 0.141 |

### Wind

Everything paints the **painted wind**: the wind field's player part
(windfield.wgsl). It carries itself along, spreads, and relaxes away over
about 7 s. Dust, plants, fire, particles and storms all feel it.

- **Blow.** Holds the painted wind at its strength under it while it lasts:
  along a direction, outward, inward, or swirling. It never stacks past its
  strength. When it ends, what it raised dies down.
- **Stroke.** Paints a segment as the player's drag does. One pass adds 4.5
  cells/s (a breeze; two passes a gust, three a gale), spread over the
  segment's length so a pass adds the same however fast it's drawn. It never
  paints past its cap along its direction.
- **Wake.** A mover calls `wake(id, …)` each frame. Each tick it paints the
  segment it covered since the last tick, along its motion:
  - capped at 0.7 × its speed (`cap`);
  - two passes by default (a gust);
  - the field's carrying and relaxing do the rest.

  Any number of movers paint at once, alongside the player's own drag. A
  mover not heard from for 0.25 s is dropped, and its painted wind relaxes
  away.
- **Merging past the cap.** The wind field takes 256 entries a tick. Past
  that, the list sent is merged: the two nearest entries of the same kind
  are combined (centre weighted by strength, a radius covering both, the
  stronger strength, the mean direction) until it fits. The game's own
  entries stay as they were.

**Lift thresholds.** Sediment and the particles lift loose ground only where
the wind beats its material's threshold, after shelter. Behind taller ground
upwind, the wind counts for less.

| Material | Lifts above (cells/s) |
|---|---|
| leaf litter | 5 |
| snow | 6 |
| dust (`drift`) | 9 |
| ash | 10 |
| sand | 14 |
| soil, gravel, rubble and the rest | never |

So a wake lifts dust only where its painted wind plus the map's own wind
passes 9:
- **The cap.** At 0.7 × speed, the cap alone reaches 9 cells/s above about
  13 cells/s of speed.
- **The passes.** Each tick's segment adds 4.5 cells/s per pass, so three
  passes (a gale) reach a high cap sooner.

Measured: a mover at 8 cells/s with two passes left +3.6 cells/s behind it
over the wind ahead; one pass left +1.8.

### The town (round 65, branch `builder`)

`api.town(opts?)` — the one town of a sim (build/town.ts; its grid,
Townscaper's relaxed quads, from `opts`: seed, spacing, relax).
`town.add(cell, level)` / `remove` / `set(blocks, on)`: what stands, at
once (stamped into the columns next tick: plaster walls and floors, tile
roofs, a stone foundation — real matter). `town.plan(cell, level, on)`:
the plan only; `town.delta()` the difference, which `api.buildCrew(…)`
builds (docs/AGENTS.md). `town.grid`: `cellAtWorld(x, y)`, `centre(c)`,
`corner(c, k)`, `nbr` (four a cell), `columns[c]`. `town.pickBlock(col,
z, remove, plan?)`: the block a press on (col, z) means, Townscaper's way.

## The world as data: what a game can pass in

| Content | Today | What it would take |
|---|---|---|
| Terrain | **Passed**: `WorldDef.map` (a column grid with layers, water, plants, contamination: world/mapgen.ts `MapData`) | Generation recipes as data come with W1 (bedrock from the plan, per-material layers) |
| Places | **Passed**: `WorldDef.places` (a plan and seed), names and tags (`rename`, `tag`) | — |
| Climate | **Passed**: `WorldDef.climate`, `season`, `yearLength` | Per-place climate: PLACES.md step 3 |
| Agent kinds | **Passed** (branch `agents`): `WorldDef.agents.kinds` (index = kind id; height, mass, hp, speed, reach, damage, swing period, notice, colours, a voxel model), or `sim.agents.defineKind` at runtime | — |
| Plant species, biomes | **Compiled in**: vegplan.wgsl species, ecology.wgsl rates, the biome table | A species table in a uniform (as materials are), read by vegplan, ecology and the draw |
| Materials | **Compiled in**: world/materials.ts, uploaded to the GPU as a table every kernel reads (`MATS`) | See below |
| Weather (storms, dust storms, cyclones) | Runtime commands (weather.spawn…); no module yet | world.weather |

**Materials.** The table is data on the GPU already. Most behaviour comes
from its fields: state (solid, loose, liquid), repose angles, wind lift,
airborne share, wash, porosity, albedo, glass.

But kernels name some ids directly for their roles: dust 19, ash 17, trash
12, snow 25, ice 27, rubble 4, basalt 23, bedrock = stone 1. The TS side
uses the `MAT` const enum throughout.

To let a game pass materials:
- Keep the built-in ids as reserved roles.
- Let a definition append materials into the free ids (29–31 of
  `MAX_MATERIALS` 32, or more with a wider table) and override the
  properties of existing ones (colours, lift, repose, strength). Those work
  through the table with no shader change.
- Moving a role to another material would need a small role → id table in
  Globals, read where the kernels use literals now.

## Not yet (next as they're touched)

- **Physics:** `installPhysics` already returns a kit close to an API.
- **Agents:** `sim.agents` (branch `agents`; docs/AGENTS.md): kinds, spawn, fields (seed, follow, confine, reader), targets, hits, hold/release/launch/lob, `sync()` for the units and their events. It keeps to these rules except the mirror: `sync()` is its own readback, a frame or two behind.
- **Not started:** plants, weather (storms, the sun, per-place light and
  fog), places (exists: `core.places`), models (drawing a game's voxel
  models; `renderer.addVoxels` today), and events out of each module.
- **The frame loop** (advance, render, resize, camera) still goes through
  `sim.core`.
- **Persistence**, later: snapshot and restore of terrain, water, fire,
  plants, bodies and agents, ideally per place. The mirror's decoded views
  are a start; the formats should stay per-column and per-place
  sliceable.
- **Retiring the old paths.** `Globals.gusts` slots 1–3 (the player's drag)
  and the analytic breeze in slot 0 are still how powers.ts paints. A game
  should no longer write `core.globals.gusts` or `events`.

## An atlas world (round 80, branch `places`)

A game can start on the atlas — the world map (landforms, mesas with their
tiers and ravines, rivers, the sea, sites joined by graded roads with
tunnels, bridges, switchbacks and lifts) — and stream it: the window slides
a region (64 cells) as its target nears an edge, and in z (32) as the
ground nears the window's top or bottom.

```ts
import { createAtlasWorld } from 'src/api/atlas-world';
const aw = await createAtlasWorld(host, { at: [12304, 5457], particles: quality.particles })
// options: at (a world cell; the atlas's spawn if left out), win (256; whole regions), zMax (248),
//          params (the atlas's: seed, style …, or the page's URLSearchParams for a.* keys),
//          sleep / band / far (all on by default)
aw.core.resize(w, h, cssW, cssH)            // as any WorldCore: its render targets come with its size
const sim = attachSim(aw.core, modules)     // the world API over it, unchanged
aw.onSlide.push((dx, dy, dz) => …)          // the window moved: shift the game's own window-coord state
                                            // (units, the camera's target, trails) by −dx cells, −dy rows (× ROW_H), −dz
// each frame:
const busy = aw.frame([px, py], 40)         // the player (window x, y in world units) keeps its ring awake;
if (!busy) aw.core.advance(now, dt, 1)      // the streamer slides; while one runs, the sim waits
aw.core.render()
aw.toWorld(x, y) / aw.fromWorld(cx, cy)     // window ↔ the atlas's world cells
aw.atlas.settlement / aw.atlas.ways         // the sites and roads (world coordinates)
```

- The streamer follows `core.camera.target` — set it to the player.
- Asleep (sim/sleep.ts): chunks away from the player and from the world's
  events don't change (water and lava keep flowing, drawn); the game's own
  agents and bodies aren't part of it. A column the game writes wakes its
  chunk through the API's commands (they're world events); anything the
  game writes into the layers itself should call `aw.sleep?.wake(x, y, r,
  secs, performance.now() / 1000)`.
- Not in it (the atlas level's own, scenes/level.ts): the coarse world's
  meteors and eruptions, the integrity system, the HUD and its buttons.
- On a phone: `q=low`; the perf overlay (?perf=1) shows the frame's
  times, the streaming's worst steps and the awake chunks.
- Test: scripts/atlasworldtest.mjs (built, ridden 200 cells east, slides,
  the sea, sleep, the terrain under the target).
