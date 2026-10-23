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
- 8 sweeps a tick, in place.
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

## API (`window.reclaimed.agents`; `installAgents(core)` for games)

```ts
const agents = installAgents(core);      // the system after the particles, units drawn as voxels
agents.spawn(n, x, y, { group, spread })  // → the first unit's index; they land on the top surface
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
| 400 units confined to a voronoi room, their goal in another room | 398 of 400 still in their room after 16 s (they stand: no seed in the room); let go, all 400 leave for the goal |

**Places.** The peel reads the `places` buffer: the top surface takes the
column's open-air room, those under it the enclosed level's, and each its
room's region. A field confined to a place (`confine`) keeps distances only
on its surfaces, and a unit never steps off its field's place, so a crowd
can't push it out either. A confined field with no seed inside its place
leaves the group standing.

## Not yet

- Structure grids (tilted structures) aren't surfaces yet; units walk
  through them. Their projection (bodyProj) has the tops, for the next pass.
- The fields are hex-metric, so the rings show and paths bias to the six
  directions; an any-angle smoothing pass, or a string-pulled path for
  units near their goal, can come later.
- The units' look is placeholder.
