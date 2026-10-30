# Inhabitants — creatures and people with bodies (round 117, branch `inhabitants`)

The user's design (DECISIONS round 117, verbatim):

> "lively animated agents inhabiting our world" (round 116)
>
> "For units I want rain world style procedural animation with secondary features like capes or fur. I want hunanoid
> an non. It doesn't have to be high fidelity it does have to be readable and look cool."
>
> "Fill the wilderness with boids of various animals. Herds, predators that stalk. This is a playground for us both."
>
> "We also want transient soft barriers like hostile agents, severe storms or weather …"
>
> "Let's bake paths into the tiles we generate so agents can interact with them. Taking elevators, stairs, walking on
> ramparts."
>
> (round 116, design/inhabitants.md) "A dragon can already have fire breath that melts stone and generating wind with
> wings will already kick up dust and knock over agents."

Try it: `?skipmenu=1&level=atlas&life=1` (a wilderness round the camera: deer, goats, a wolf pack, crows, a wanderer
in a cape, beetles, a serpent), `&life=dragon` (and a dragon), `&life=town` (townsfolk on stand-in paths). The viewer:
`?skipmenu=1&level=bestiary&life=viewer` (pick a body plan, tweak it, idle/walk/run/fly; a herd and a predator; a
flock). Phone: https://csheldondante.github.io/Reclaimed/inhabitants/?skipmenu=1&level=bestiary&life=viewer once
places' next push builds the branch.

## What it is

| piece | file | what |
|---|---|---|
| contract | `src/api/contracts/inhabitants.ts` | species as data (body plan, proportions, palette, secondary, gear slots, abilities, behaviour), `spawnGroup` / `drive` (roam, go, flee, paths, pace), `WalkPaths` (what structures give), `AbilityHost` (what the level gives), `presence` (density and threat a region) |
| body generator | `src/inhabitants/rig.ts` | plan + parameters → a rig: points with roles, segments to draw. Pure, deterministic from the seed |
| presets | `src/inhabitants/species.ts` | deer, wolf, goat, bear, crow, gull, serpent, beetle, wanderer (cape, hood, sword), townsfolk (pack), dragon |
| GPU system | `src/inhabitants/system.ts`, `src/shaders/inhabitants.wgsl` | bins → behave → animate → mesh, one thread a creature, every tick |
| presence | `src/inhabitants/presence.ts` | density/threat over any rectangle from the groups' read-back centres |
| paths | `src/inhabitants/paths.ts` | `WalkPaths` packed for the GPU; `standInPaths` until structures bake theirs |
| level glue | `src/inhabitants/install.ts`, `?life=` in scenes/level.ts | install, the wilderness scene, the camera's focus and readability scale, the ability hooks |
| viewer | `src/inhabitants/viewer.ts`, `src/levels/bestiary.ts` | the viewer page's panel and its ground |

## Choices and why

**Bodies are points with roles, not skinned meshes.** The Rain World recipe is a handful of physical rules on a few
points; a rig is ~20 points a creature. Roles: `Root` (where behaviour put it), `Spine` (follows its parent at a fixed
distance: a turn bends the body, a serpent's head drags its whole length), `Foot` (planted; steps when it falls more
than half a stride behind its ideal spot, only while the other gait group is down: trot pairs, a tripod for insects),
`Knee` (two-bone IK toward a pole), `Chain` (verlet: momentum, gravity, the world's wind, pulled to rest by a
stiffness — tails, capes, fur, antennae, a dragon's neck), `Wing` (flaps about the body's axis flying, folds on the
ground), `Swing` (arms against the legs), `Head` (dips to graze, low to stalk, looks about). Why: one code path for every
plan; no authored animation, so a new body plan is a function in rig.ts; secondary motion comes free from the same
verlet that the world's wind already drives. When this would be wrong: hand-made characters with faces and fingers —
then a skinned mesh path (D-r105's vertex weights) would sit beside it, fed by the same points.

**Drawn as flat-shaded low-poly spindles, written on the GPU into Renderer.addMesh.** Each bone is a square spindle
(two rings, two tips that overlap the next bone at the joints), each cloth or wing panel a triangle; colours are the
species' palette, varied ±12% a creature. Why: the user allowed "voxel, low poly, toon"; voxels at a deer's size are
2-3 blocks and lose the gait; spindles keep legs, necks and wings readable and cost 48 vertices a bone (24 at the far
LOD). `addMesh` gets them lit and shadowed like physics skins with no renderer of their own (one 2-line tweak, below).

**Readable at the phone's zooms: drawn bigger than life when the view is wide.** `drawScale` = 24 / zoom, 1 to 4
(install.ts): a creature keeps ~24 px a cell of body however far out. Only the mesh scales, about the feet; behaviour,
presence and hits keep the true size. A dark footprint under each creature (two triangles) gives contrast on grass and
puts a flying bird on the map. Wolves are charcoal with pale bellies and gold eyes for the same reason.
`?lifescale=` / `?lifelod=` override.

**GPU, one thread a creature.** Behaviour, animation and the mesh are per frame and scale with the count (5 000 × ~25
points × 60 Hz): the "GPU first where data is large or per-frame" rule. The CPU keeps species, groups and orders, and
reads back 256 groups' sums (8 KB) every 10 ticks — for `presence`, group centres and abilities.

**Behaviour.** Boids (separation by body length, alignment, cohesion) over an 8-cell spatial hash. Herds graze, walk
to new spots near the herd, bolt from a predator they see (a stalker crouched is seen at half the distance) and from a
neighbour bolting; a bolted herd settles where it ran. Stalkers rest, stalk the nearest prey herd low and steady,
burst when close or when the herd bolts, knock the one they reach down, rest. Flocks fly 3D boids round home. Townsfolk
walk the path graph (stairs, ramparts, elevators: standing on the lift). Everyone turns away from cliffs, drops, deep
water and fire, and a wind past ~8 cells/s blows them down by 0.5 × excess² ÷ mass past 18 (the agents' rule, so a
dragon's wing beats and a storm read the same on both). Directors can `pace` a group (the viewer, a cutscene).

**Abilities through the world's systems.** A species' `abilities` call the level's `AbilityHost`: fire breath =
`ignite` (the fire system) + `heat` (the lava system's beam: melts stone), wing beats = `blow` (the wind API: dust,
knocked agents). Used only on the hunt (a prey herd within reach). The effects library is deferred; these calls are the
stand-in.

**Not the GPU agents (src/agents).** Those are units that fight and work for games and settlements (fields, swings,
carrying). These live in the wilderness. They meet through contracts (presence, orders) — never each other's buffers.
Their bodies could draw the agents' units later through the same rig + mesh, reading the units buffer as a source
(BACKLOG IN8).

## Measurements

`scripts/perf/inhabitants.mjs` on the desktop's Intel Xe-LPG iGPU, the atlas with every system, 412 × 915 dpr 2.6
q=low, zoom 6 (far LOD, drawScale 4), herds over the view (data/perf/inhabitants-intel-xe-lpg.json):

| creatures | bins | behave | animate | mesh | inhabitants total (GPU ms a frame) |
|---|---|---|---|---|---|
| 100 | 0.02 | 0.14 | 0.22 | 0.18 | 0.57 |
| 1 000 | 0.03 | 0.33 | 0.22 | 0.49 | 1.07 |
| 5 000 | 0.04 | 0.55 | 0.24 | 1.90 | 2.73 |

Full LOD (zoom ≥ 14): mesh 0.29 / 1.12 / 2.59 ms. The mesh is the cost: one thread writes a creature's ~500-950
vertices serially. 5 000 at full LOD passes the vertex room (2.5 M; the excess are skipped, not drawn wrong). The frame's
whole-GPU number from the profiler was noisy here (±1 ms between runs); the passes' own times are the solid ones.
Next if it matters on the phone: a thread a segment (IN6).

## Tests

- Unit (`src/inhabitants/*.test.ts`, 23): every plan builds a valid rig (parents first, knees after their feet,
  limits, finite), feet in even gait groups, determinism, size scaling, gear (cape cloth, weapon), fur, presets, loud bad
  colours; presence splits by overlap; the paths stand-in is connected with every kind and packs where the kernel reads;
  the species table's layout.
- GPU on Dawn (`test/gpu/inhabitants.test.ts`, 10): a walking deer's feet on the ground and lifting less than a step,
  its upper legs within 2% of their length, its body at its height; feet on a slope; a herd bolting from a wolf; a
  gale knocking a deer down and it getting up; townsfolk on their path segments and some up the tower; the mesh's
  vertex count per creature at both LODs and none out of focus; the window's slide; presence of a pack; a whole hunt
  (stalk, burst, one caught, the rest > 10 cells off); a dragon's breath and wing beats through the hooks.

## Shared-system tweaks (for main to consolidate)

1. `src/shaders/render.wgsl` vsSkin: `o.info = vec2(a.w, nb.w)` (was 0); fsBody: when `info.y == 1` the word's low 24
   bits are an RGB colour, not a material. Physics skins write nb.w = 0, so nothing else changes.
2. `src/scenes/level.ts`: `?life=` installs the system after the agents, `lifeFrame` each frame, and
   `window.reclaimed.inhabitants`.
3. `src/game/levels.ts`: the hidden `bestiary` level.

## Flagged conflations

- `WorldGpu.surface` is the solid top; the ground a creature stands on is that + the loose layer (`driftAt`) or a
  sleeping body's top — every kernel that wants "the ground" repeats `max(sfZ + driftAt, bodyTopAt)` (particles.wgsl,
  lava_flux, liquid, now inhabitants). One `groundAt` in common.wgsl would end the copies (first frames here drew every
  creature under a dust skin until this was found).
- Units (contracts/units.ts) mixes who a unit is (faction, character, role) with how it moves; inhabitants keep body,
  behaviour and identity apart. A merged "creature" contract later should take the split.
