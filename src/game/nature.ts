// Gameplay resource (design doc §7). Observes aggregate world stats only —
// never reaches into system internals.

import type { WorldStats } from '../sim/systems';

export const COSTS = {
  storm: 30,
  lightning: 10,
  downpour: 8,
} as const;

/** Tuning for Nature's consequences (see DEVLOG round 5 for the measurements). */
export const HARM = {
  /** per unit of free oil volume, per second */
  oil: 0.004,
  /** per drowning living cell, per second */
  drowning: 0.02,
  /** per oil-smoke puff the wind disperses */
  smokeReward: 0.012,
} as const;

export class Nature {
  value = 45;
  readonly max = 100;
  /** Net change per second (exposed for the HUD); negative while the land suffers. */
  rate = 0;

  update(dt: number, stats: WorldStats | undefined): void {
    const base = 0.35; // never permanently stuck (no hard fail states)
    let living = 0;
    let harm = 0;
    if (stats) {
      // vegetated area counts; mature growth counts extra
      living = (stats.vegCells + stats.matureCells * 2) / stats.cells;
      // consequences (DECISIONS round 5): spilled oil lying about and plants
      // drowning under floods drain Nature
      harm = stats.oilVolume * HARM.oil + stats.drowningCells * HARM.drowning;
    }
    this.rate = base + living * 25 - harm;
    this.value = Math.max(0, Math.min(this.max, this.value + this.rate * dt));
  }

  /** Oil smoke dispersed by wind (count of puffs) gives Nature back. */
  smokeDispersed(puffs: number): void {
    this.value = Math.min(this.max, this.value + puffs * HARM.smokeReward);
  }

  trySpend(cost: number): boolean {
    if (this.value < cost) return false;
    this.value -= cost;
    return true;
  }
}

/** 0 (dead, polluted) .. 1 (thriving): drives haze, audio and HUD mood. */
export function worldHealth(stats: WorldStats | undefined, initialContam: number): { pollution: number; life: number } {
  if (!stats) return { pollution: 1, life: 0 };
  const pollution = Math.min(1, Math.max(0, stats.soilContam / Math.max(1, initialContam)));
  const life = Math.min(1, stats.vegCells / (stats.cells * 0.45));
  return { pollution, life };
}
