# Design decisions (from review conversations)

Authoritative answers from the user. Newest first. The DEVLOG records how
each was implemented.

## 2026-10-07 — feedback round 5 (session 2)

- Motion: springier but slower to bounce back; everything a bit slower and
  more relaxed. Trees bend and *stay* bent in wind, then spring back.
- A drag makes wind that lasts a second or two after it — longer and
  stronger the faster the drag.
- Storm cloud shadow darker. No cloud puffs: rain fades in from a height.
- More negative consequences: spilled oil drains Nature; burning it makes a
  smoke cloud that raises Nature once wind disperses it. Oil on water burns.
  Forests can catch fire and burn. Drowning plants drains Nature.
- Some things only yield to fire (or need burning before they can easily be
  removed) — e.g. trash heaps.
- Audio direction (round 4 follow-up): ambience quieter and distance-based;
  clicks always loud (they're under the cursor, the player's focus).

## 2026-10-07 — feedback round 4 (session 2)

- Audio: everything quieter when zoomed out; some sounds are positional and
  louder near their source (water at the dam, rain under storms, birds near
  birds).
- Lightning flashes light over the whole scene.
- Sun shadows should visibly move across the terrain; smoother day/night
  transition.
- Particles (leaves, pollution, trash, dust) rest on the ground and are
  stirred up by wind — they don't spawn in mid-air.
- Storm clouds: **higher and thinner**; rain starts at the cloud *base* so the
  land under a storm is seen mostly through rain.
- Dust clouds roll across the map early in the level and act as weather when
  wind picks up.
- **One drag gesture**: any drag makes wind (strength from drag speed/length)
  that ripples water, grass and leaves; dragging under/near a storm also
  pushes its heading. No storm arrow — players discover steering.
- Birds perch in trees and fly in from off the map; only trees with perched
  birds flush birds.
- Nature goal: a level should take **~5 minutes** of reasonable play (lower
  goal and faster growth; measure).
- Wind ripple must be smooth and wave-like, not jittery.
- Starting pollution: **oil slicks, toxic sludge (new non-flammable liquid,
  washes away / slowly broken down by plants) and trash heaps** (wind
  scatters them).
- Menu: a clearer skull, a ribcage, and a reddish-grey dust mound.

## 2026-10-07 — feedback round 2

**Accepted direction**
- Remove camera rotation (fixed view; stylise shading for that one angle).
- Water ripple/glint must read from the fixed view.
- Pollution is *matter*: liquids (oil, sludge — flow, float/sink by density,
  burn) and wind-blown particles (dust, ash, litter). Soil stain remains as a
  residue, and **any water over it washes it** (not only rain). Sinks: off
  the map edges, burned, or decayed by plants.
- Density ordering between materials (stone sinks in water and oil; oil
  floats on water).
- GPU particle system: dust/litter/ash/leaves/clouds; particles make wind
  visible.
- Day/night cycle; weather particles (storm clouds, dust).
- More colour variation in stone/dirt.
- Sub-voxel leaves with gaps (fixed view makes an impostor-like approach
  viable); leaves and grass rustle in the wind (with leaf sounds); small block
  details: grass tufts, wildflowers, vines.
- Hover/click reactivity: vegetation sways as if wind follows the cursor;
  clicking trees releases birds/leaves; tanks make a hollow metal sound;
  buildings chip with a decaying-tile sound (**cosmetic**, decay feel; may
  hasten failure slightly but not required).
- Controls: diegetic, no tool buttons (may return for touch later).
  - Storms are large and roll across the map with the wind (wind visible via
    debris). A storm can still be *summoned* — keybound, recharges.
  - Click in a storm's shadow → lightning (lightning takes precedence when
    under a storm). If lightning isn't recharged: trees sway hard / metal
    strains (feedback instead of an error message).
  - Drag under a storm → a big gust in that direction.
  - **LMB = interact / gestures, RMB drag = pan, MMB = zoom** (wheel too).
  - UI only shows recharge.
- Small player nudges to particles (cursor wind) are fine — ambient game.
- Animals are for theme and liveliness, not core play; small systemic
  touches (birds spreading seeds) are welcome.
- Future disasters (quakes, tornado by dragging more) — later.
- River: constant inflow from the map edge, at equilibrium with the dam at
  start; the dam has an outflow (spillway) so it doesn't overtop.
- Order: quick wins → particles + oil → storms/controls/wind/day-night →
  fire → life & look.

## 2026-10-07 — feedback round 3

- Dust should drift down, settle, and get swept up again by new breezes.
- Build the menu screen (skull diorama, §4).
- Clouds higher; storms larger and less uniformly shaped.
- A bar for how much nature is on the map; the level ends above a threshold.
- White birds that flap (low fidelity is fine); deer or small brown animals
  that roam and scatter when you click.
- Taps on structures should visibly crack them with a stone-falling sound.
- Audio softer overall; rain sound only under storms; otherwise wind and
  distant rumbling thunder (the constant "not-quite-rain" noise must go).
- Biomes: trees on flatter, wetter ground; open fields; fireflies only in fields.
- More tree variety and height variety.
- Tank tap: deeper, more hollow. Tanks closed so oil only shows when they break.
- Clicking water should splash (with sound).
