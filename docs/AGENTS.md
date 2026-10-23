# Agents — units that walk, dig, carry and build (round 52)

The user's plan (DECISIONS round 52): simulation layers for agents that
build and mine.
- Peel the intervals into pathable surfaces.
- Use an irregular grid like Townscaper for digging and building.
- Run units as state-driven groups sharing flow fields, so most behaviour
  is following a gradient.
- Units carry material, flee, attack, fell trees and build.
- Procedural characters come later.

Many editors and games are meant to use this layer, as the hover-bike action
game uses the world. The user said "don't be dogmatic"; the design below is
theirs with the changes I proposed:
- The surfaces come straight from the intervals, with no render peel.
- The irregular grid is for building; digging works on the columns.
- Fields are per goal and shared by the groups that follow them.
- Units live on the GPU, like particles.
- Jobs are fields too.

Branch `agents`, cut from `grids` (C:/Projects/Reclaimed-agents, port 5185).

## Order of work

1. ✓ **Walkable surfaces** from the intervals, linked to their six hex
   neighbours (this commit).
2. ✓ **Fields**, and GPU units following them: 4,000 units at 0.47 ms a
   tick (this commit).
3. **Digging and carrying**: material taken out of the columns and put back
   elsewhere, the totals checked.
4. **Groups and states**: work, carry, flee, attack and build, with job
   fields (dig sites, trees, build sites, stockpiles); a small CPU brain per
   group, reading back every few ticks.
5. **Building on the irregular grid**: Townscaper's relaxed quads over the
   hex lattice. Pieces are stamped into the columns, so water, fire,
   physics and paths see them, and drawn as models.
6. **Felling, fleeing, attacking**: fleeing on a negative multiple of the
   threat field, smoothed again (the Brogue trick), so units head for open
   space rather than corners.
7. **Places**: surfaces carry their place id, so a horde can be kept to its
   room (PLACES.md W4).
8. **Characters**: procedural bodies and animation; legs placed on the
   ground by IK.

## How it works (agents.wgsl, src/agents/)

**Surfaces.** Each column's solid and loose intervals are merged where they
touch, and a surface is the top of a run with at least `AGENT_H` (1.5
cells) of air above it.
- Up to `NAV_K` (4) per column, highest first.
- Strata stacked on each other make one surface; slivers too thin to stand
  under (a jagged cliff's) drop out.
- The top surface is wet where the water there is deeper than `WADE` (0.6).
- Each surface links to one surface in each of the six neighbours: the
  nearest in height within a step up (`STEP` 1.1) or a drop (`DROP` 2.6),
  with `AGENT_H` of headroom over both.
- Re-peeled every 8 ticks, so dug or built terrain shows up within a
  fraction of a second.

**Fields.** Each field holds a distance to its seeds on every surface.
- `NFIELDS` (4) fields, shared by every group following the same one.
- Sweeps a tick, in place: the quality's `agentSweeps` (low 2, medium 4,
  high 8; `agents.sweeps` at run time). The fields' fixed cost is the map's
  size × the sweeps (about 0.2 ms a sweep on a 256 map on a desktop GPU), so
  phones take 2 (round 58). A change spreads that many cells a tick: 2 is
  120 cells/s, enough to follow anything that moves; only a first fill
  across the map is slower (~2 s rather than ~0.5).
- A field with no seeds is skipped (nowhere is near it), and a column's
  sweep stops at its last surface.
- A step costs 1, plus 1.5 per cell climbed, 0.3 per cell dropped, and 3
  into water.
- A surface's value is recomputed from its neighbours every sweep, never
  kept as a running minimum. So a field follows changing terrain: a wall
  raised across a path raises the distances behind it.
- Values past (w + h) × 6 are unreachable; without that cap, a pocket cut
  off from its seeds would count up forever.

**Units.** One GPU thread per unit, two vec4 each: position and group, then
velocity and stride phase.
- **Steering.** A unit follows its group's field down the gradient (the six
  neighbours' drops, each toward its centre), or takes the best step when
  the gradient is flat.
- **Crowds.** Units are pushed away from busier neighbouring columns. The
  occupancy count is double-buffered, so each tick reads the last tick's.
- **Links.** A unit never crosses into a column it has no link to; it
  slides instead.
- **Height.** It rides its surface's height, eased.
- **Drawing.** Each unit writes three voxels in the body format (legs,
  torso in its group's colour, head), drawn through `renderer.addVoxels`:
  lit and shadowed like everything else.

## Enemies (round 52: a game's horde on the agents)

The user's direction, relayed by the units session: Reclaimed is the engine,
and a game's enemies are its agents. The first slice covers what that
game's CPU enemies did: kinds, behaviour, swings, hits and readback.

- **Kinds** (8). Each kind has a height, mass, hp and speed, plus a reach,
  damage, swing period and notice distance. The defaults are 0 worker, 1
  raider (height 1.2, mass 1, hp 10, fast) and 2 ogre (height 2, mass 3,
  hp 22, slow).
  - A kind can bring its own voxel model: [x, y, z, material] in voxel units
    round its feet, `voxel` cells each.
  - Without one it is drawn as the default figure (legs, torso, head),
    scaled to its height.
- **Behaviour** (units.wgsl). A worker (notice 0) always follows its field.
  A hostile kind:
  - wanders until its field says a target is within notice;
  - then closes in down the field;
  - swings when a target is within reach: a `windup` event as it begins
    (the target, and `lands`: 0.3 s until the blow), then the blow 0.3 s
    into a 0.6 s swing, as a `swing` event naming the target and damage (if
    the target is still in reach); a cooldown of its swing period follows.
- **Targets**: `setTargets` (up to 8, each frame) for the reach checks; it
  also seeds field 3 on them.
- **Hits from the game**: a circle or a cone, carrying damage, a push (along
  a direction or outward, divided by mass) and optionally fire. Up to 32 a
  tick; more wait for the next tick. Each returns an id, and `hurt` and
  `death` events name it.
- **Fire and water**:
  - A unit catches fire from a fire hit or the fire field where it stands,
    then burns at 2 hp/s for 6 s, running about faster.
  - Wading slows it by depth. Over its head, it drowns after 3 s.
  - Water half its height deep puts the fire out.
  - Death events say `by: hitId | 'fire' | 'water'`.
- **Ids**: generation × 8192 + slot, so an id stays unique when its slot is
  reused. Deaths free their slots in `sync()`.
- **Reading back**: `sync()` does one readback a frame for units and events,
  resolving a frame or two later. It returns the live units (`id`, position,
  `heading`, velocity `vx, vy, vz`, `state` wander/chase/swing/tumble/held,
  `alight`, `hp`, `kind`, `group`)
  and the events since the last sync: `swing`, `hurt`, `death` and
  `alight`. Events past 2,048 a sync are counted and warned about, never
  silently lost.
- **Thrown, held, knocked over** (slice 2):
  - **Tumbling.** A push past 5 cells/s (after mass), a launch, a let-go, or
    walking off an edge higher than a drop sets a unit tumbling. It flies
    and falls (gravity 20 cells/s²) free of the links. It bounces off the
    ground (35% of the falling speed) and skids, losing 40% at each landing
    and gripping at 3/s while on the ground. It slams back off walls.
  - **Damage.** A landing or slam faster than 10 cells/s hurts 1 hp per
    cell/s past that (`hurt` / `death` by `'impact'`).
  - **Getting up.** Once settled for 0.6 s, it gets up; stunned, that much
    longer.
  - **Mass and stun** (round 56: knockback is plain physics data). Every
    force on a unit divides by its kind's `mass`: a hit's `push` and `lift`
    (cells/s), and the momentum of units tumbling into it (shared with its
    own mass). So a heavy kind shrugs off every knock the same way. A
    launch is a velocity, not a force: the thrower decides it, and a lob
    must land where aimed.
    - `lift` (a hit's upward speed) throws it: it tumbles with the push
      along the ground and the lift up. Without one, a push past 5 cells/s
      hops it up by a third of the push.
    - `stun` (seconds, on a hit, a launch or a lob, up to 20) keeps it down
      that much longer once settled. A stunning hit that doesn't throw it
      holds it where it stands, upright.
  - **Wind** (round 57). Units feel the world's wind (`windAt`: the map's
    wind, storms, gusts, the world API's blows and blasts, wakes,
    cyclones), sampled at their middle.
    - Under 8 cells/s it does nothing. Past that, a force of 0.5 × the
      excess² ÷ mass (cells/s²) along it.
    - On the ground, the feet hold up to 18 of it: below that it drifts
      the unit, which walks back to its goal. Past that, it's thrown,
      hopping by 0.35 of the excess.
    - In the air (or lying on the ground, less the grip) the force carries
      it, never past the wind's own speed.
    - So a worker is thrown past 14 cells/s, an ogre (3) past ~18.4.
    - Under a roof (any surface but a column's top) it's sheltered.
    - A blast through the wind API is felt weaker than its strength: the
      field smooths it (22 is felt as ~16 four cells off its centre), and
      at its very centre the outward winds cancel. For a sure throw, use a
      `hit`.
  - **Knock-overs.** A tumbling unit faster than 2.5 cells/s carries its
    momentum through each column it crosses (per-column shoves). A walking
    unit there is knocked over when that momentum, shared with its own mass,
    would move it faster than 2.5 cells/s.
  - **Holding.** `hold(id, x, y, z)` each frame puts a unit where the game
    holds it (a lich, a gorilla), up to 8 at once.
    - `release(id, vel?)` lets go: it tumbles, with `vel` or as it was
      moving.
    - `launch(id, vel, { stun? })` throws any unit.
    - `lob(id, from, to, time?, { stun? })` works out the launch that lands
      it at `to` and returns that launch velocity.
  - **Fire.** Units also catch fire:
    - from lava (over 750 °C), which burns 8 hp/s besides (`by: 'lava'`);
    - from hot ground (over 300 °C);
    - from an ember landing on them (the sparks texture);
    - by touch: each burning unit in their column or the next gives 1.5 a
      second of catching (half for the next column).
- **Drawing**: unitDraw appends each unit's voxels (up to 65,536 in all).
  While tumbling, a unit is rolled along its throw, about the axis across
  it.
  - Alight, it flickers with the physics voxel's heat glow; hit, it flashes
    white for 0.15 s.
  - The game stops drawing its own models for them.

## API (`window.reclaimed.agents`; `installAgents(core)` for games)

```ts
const agents = installAgents(core);      // the system after the particles, units drawn as voxels
agents.defineKind(i, { name, height, mass, hp, speed, reach, damage, swingPeriod, notice, colours?, model? })
agents.spawn(n, x, y, { group, kind, spread })  // → ids; they land on the top surface
agents.remove(ids)                        // out at once, no death event
agents.setTargets([{ x, y, z, radius }])  // what hostile kinds go for; seeds field 3 (follow(group, 3) to chase)
agents.hit({ x, y, z?, radius, damage, push, lift?, stun?, dir?, outward?, cone?, axis?, fire? })  // → hit id; a cone round `axis` (default `dir`); push and lift ÷ mass
agents.hold(id, x, y, z)                  // each frame while held; false when it's gone
agents.release(id, vel?) / agents.launch(id, vel, { stun? }) / agents.lob(id, from, to, time?, { stun? })
const { units, events } = await agents.sync()  // each frame: live units, and swing/hurt/death/alight events
agents.goTo(group, x, y, z?)              // the group's own field (group % 4) seeded there
agents.seed(field, [{ x, y, z? }])        // a field's seeds: a goal, a stockpile, a threat
agents.follow(group, field)               // a group follows a field (-1: stands)
agents.confine(field, { id, kind } | null) // keep a field (and those following it) to a place: a room or region
const r = agents.reader(field).start(300) // a CPU copy for walkers the game moves itself (fieldreader.ts)
r.sample(x, y, z?)                        // → { dist, dir: [dx, dy], z, room, region } on the surface below z
await agents.read()                       // [x, y, z, group] per unit
await agents.readRaw('nav' | 'dist')      // tests
```

Limits: 8,192 units, 16 groups, 4 fields, 32 seeds; each throws past its
limit.

## Measured (scripts/agentstest.mjs, the 256 × 256 sandbox)

| Test | Result |
|---|---|
| Surfaces | 65,484 columns with one surface and 52 with two (the bridge); 390,551 links |
| 300 units, 66 cells to the goal | Mean distance 62 → 20 in 21 s (≈2 cells/s); they march in files along the hex lattice |
| A stone wall 4 high, 40 long, across the way | They split and go round both ends |
| 4,000 units | They flow round the pond (water costs more); agents 0.47 ms a tick against sediment's 0.52 |
| FieldReader (scripts/agentfieldtest.mjs), field seeded at the map centre | 24 of 24 samples, 20-60 cells out, point within 45° of the goal; dist 20.3 at 20 cells; a refresh reads 5 MB back in 10-80 ms |
| A horde (scripts/hordetest.mjs): 60 raiders, 10 ogres, 4 brutes with their own model, round a standing target | All chase within a second; in 10 s 69 of 74 are within 3 cells of it, 15 swinging, 121 swing events. A blast (radius 3, 30 damage, outward push) kills 71, each death naming the blast. A fire hit sets the last 3 alight: they glow and burn; the ogres outlast the 12 hp the burn does. |
| Thrown, held, burning (scripts/throwtest.mjs, a crowd of 40 standing workers) | An ogre thrown into the crowd at 18 cells/s bowls over 7-10, and they get up; a blast (push 22, outward) throws 37-38, a few hurt landing hard, all up within 4 s. One held and carried up 6 cells, then lobbed at a point 15 cells off: it lands there and skids 5 cells. One set alight in a fresh crowd of 30: 27 alight within 5 s by touch |
| Mass and stun (scripts/knocktest.mjs) | The same hit (push 6 along dir, lift 8): a worker flies 1.5 high and is carried 5.7; an ogre (mass 3) 0.2 high and 0.46. A stun-only hit of 2 s holds a worker where it stands for 2.6 s (2 + getting up). A stun of 1.5 on a throw or a launch keeps it down 1.35-1.5 s longer |
| Wind (scripts/windtest.mjs, crowds of 12 standing) | The map's own wind moves nobody (0.2 cells in 3 s). A blow of 12 cells/s drifts workers 2.2 cells downwind in 3 s, none thrown. A blast of 22 beside a crowd throws 10 of 12 workers and no ogres. All up within 4 s |
| 400 units confined to a voronoi room, their goal in another room | 398 of 400 still in their room after 16 s (they stand: no seed in the room); let go, all 400 leave for the goal |

**Places.** The peel reads the `places` buffer: the top surface takes the
column's open-air room, those under it the enclosed level's, and each its
room's region. A field confined to a place (`confine`) keeps distances only
on its surfaces, and a unit never steps off its field's place, so a crowd
can't push it out either. A confined field with no seed inside its place
leaves the group standing.

## Not yet

- A death left lying (they vanish now).
- Tumbling units are points against the terrain: a voxel body (the physics
  solver) would roll and stack properly. Their knock-overs are per column,
  not per pair.


- Structure grids (tilted structures) aren't surfaces yet; units walk
  through them. Their projection (bodyProj) has the tops, for the next pass.
- The fields are hex-metric, so the rings show and paths bias to the six
  directions; an any-angle smoothing pass, or a string-pulled path for
  units near their goal, can come later.
- The units' look is placeholder.
