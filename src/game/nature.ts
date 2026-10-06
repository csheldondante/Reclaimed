// Gameplay resource (design doc §7). Observes aggregate world stats only —
// never reaches into system internals.

import type { WorldStats } from '../sim/systems';

export const COSTS = {
  storm: 30,
  lightning: 10,
  downpour: 8,
} as const;

export class Nature {
  value = 45;
  readonly max = 100;
  /** Regeneration per second from living cells (exposed for the HUD). */
  rate = 0;

  update(dt: number, stats: WorldStats | undefined): void {
    const base = 0.35; // never permanently stuck (no hard fail states)
    let living = 0;
    if (stats) {
      // vegetated area counts; mature growth counts extra
      living = (stats.vegCells + stats.matureCells * 2) / stats.cells;
    }
    this.rate = base + living * 25;
    this.value = Math.min(this.max, this.value + this.rate * dt);
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
