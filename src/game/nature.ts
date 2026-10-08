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
  /** per clump of grime blown into water */
  washReward: 0.04,
  /** per unit of soil contamination removed (rain, floods, wind, plants) */
  cleanReward: 0.015,
  /** per cell of litter stripped away */
  litterReward: 0.04,
  /** per cell that grows into mature woodland */
  forestReward: 0.06,
} as const;

export class Nature {
  value = 45;
  readonly max = 100;
  /** Net change per second (exposed for the HUD); negative while the land suffers. */
  rate = 0;
  /** Nature gained from deeds since the HUD last looked (cleared pollution, forests, …) */
  gained = 0;
  private prev?: WorldStats;

  update(dt: number, stats: WorldStats | undefined): void {
    const base = 0.35; // never permanently stuck (no hard fail states)
    let living = 0;
    let harm = 0;
    if (stats) {
      // vegetated area counts; mature growth counts extra
      // forests count most
      living = (stats.vegCells + stats.matureCells * 3) / stats.cells;
      // deeds pay out as they happen (DECISIONS round 8): pollution gone,
      // litter stripped, woodland grown
      const prev = this.prev;
      if (prev && prev !== stats) {
        const reward =
          Math.max(0, prev.soilContam - stats.soilContam) * HARM.cleanReward +
          Math.max(0, prev.litterCells - stats.litterCells) * HARM.litterReward +
          Math.max(0, stats.matureCells - prev.matureCells) * HARM.forestReward;
        this.add(reward);
      }
      this.prev = stats;
      // consequences (DECISIONS round 5): spilled oil lying about and plants
      // drowning under floods drain Nature
      harm = stats.oilVolume * HARM.oil + stats.drowningCells * HARM.drowning;
    }
    this.rate = base + living * 25 - harm;
    this.value = Math.max(0, Math.min(this.max, this.value + this.rate * dt));
  }

  private add(n: number): void {
    if (n <= 0) return;
    this.value = Math.min(this.max, this.value + n);
    this.gained += n;
  }

  /** Grime blown into water (count of clumps) gives a little Nature back. */
  grimeWashed(clumps: number): void {
    this.add(clumps * HARM.washReward);
  }

  /** Oil smoke dispersed by wind (count of puffs) gives Nature back. */
  smokeDispersed(puffs: number): void {
    this.add(puffs * HARM.smokeReward);
  }

  trySpend(cost: number): boolean {
    if (this.value < cost) return false;
    this.value -= cost;
    return true;
  }
}

/**
 * How reclaimed the valley is, 0..1 (the HUD bar and the level goal): half
 * clean land (no poison, oil, trash or litter), half life weighted by stage
 * so moss counts a little and woodland fully (DECISIONS round 8).
 */
export function reclamation(stats: WorldStats): number {
  const clean = stats.cleanLand / stats.cells;
  const life = Math.min(1, stats.vegMean / 4.2);
  return 0.5 * clean + 0.5 * life;
}

/** 0 (dead, polluted) .. 1 (thriving): drives haze, audio and HUD mood. */
export function worldHealth(stats: WorldStats | undefined, initialContam: number): { pollution: number; life: number } {
  if (!stats) return { pollution: 1, life: 0 };
  const pollution = Math.min(1, Math.max(0, stats.soilContam / Math.max(1, initialContam)));
  const life = Math.min(1, stats.vegCells / (stats.cells * 0.45));
  return { pollution, life };
}
