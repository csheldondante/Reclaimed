// The rivers' wetness (round 84, ?rivers=table — the user: "precompute the flow of those as a function of dryness"):
// the atlas's rivers carry their table's discharge times this (sim/world-gpu.ts riverFlow; Globals ocean.w). 1 is the
// reference — the land as it was made. Wetter in spring (the thaw), drier at the end of summer, and up while storms
// rain on the land; it follows slowly (a watershed is slow), so the rivers rise and fall smoothly.
//   ?riverwet=x holds it at x.
// (round 109) On the atlas level this is the climate's share alone (the season): the storms go per watershed —
// weather/catchwet.ts, the riverWet field — and riverheld.wgsl riverWetAt adds the two.

import { RIVER_WET } from '../sim/world-gpu';

/** seconds it takes to follow most of the way to a change */
const LAG_S = 20;
/** how much the season swings it, and a storm at full strength adds */
const SEASON = 0.3;
const STORM = 0.35;

/** the season's share (0..1 from midsummer, Globals rules.w): 1 at midsummer, the thaw's high in spring */
const seasonal = (s: number) => 1 + SEASON * (Math.cos(2 * Math.PI * (s - 0.85)) - Math.cos(2 * Math.PI * 0.85));

export class RiverWet {
  value = RIVER_WET >= 0 ? RIVER_WET : 1;

  update(dt: number, season: number, storms: readonly { intensity: number }[]): number {
    if (RIVER_WET >= 0) return (this.value = RIVER_WET);
    let rain = 0;
    for (const s of storms) rain += s.intensity;
    const target = Math.min(2, seasonal(season) + STORM * rain);
    this.value += (target - this.value) * Math.min(1, dt / LAG_S);
    return this.value;
  }
}
