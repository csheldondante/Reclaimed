# Design decisions (from review conversations)

Authoritative answers from the user. Newest first. The DEVLOG records how
each was implemented.

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
