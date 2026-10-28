// world.fire (docs/WORLD_API.md): fire, lava and the ground's heat from a
// CPU mirror; setting things alight as a command.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import { columnAt } from './common';
import type { Mirror } from './mirror';

export interface LavaAt {
  /** cells of molten rock */
  depth: number;
  /** its temperature (°C; it sets to basalt below ~750, ground melts above ~1300) */
  temperature: number;
  /** the height of its surface */
  level: number;
}

/** Queries answer from the mirror (every `mirror.every` ms, 250 by default); null before the first read. */
export class Fire {
  constructor(
    private core: WorldCore,
    private mirror: Mirror,
  ) {
    mirror.addBuffer('fire', core.world.fire);
    mirror.addBuffer('lava', core.world.lava);
  }

  get readAt(): number {
    return this.mirror.readAt;
  }

  refresh(): Promise<void> {
    return this.mirror.refresh();
  }

  private col(x: number, y: number): number {
    return columnAt(this.core.dims.w, this.core.dims.h, x, y, this.core.ring);
  }

  /** How hard (x, y) is burning, 0..1 (0: not alight). */
  fireAt(x: number, y: number): number | null {
    const f = this.mirror.f32('fire');
    const i = this.col(x, y);
    if (!f || i < 0) return null;
    return f[i];
  }

  /** Lava at (x, y), or null where there's none (or before the first read). */
  lavaAt(x: number, y: number): LavaAt | null {
    const l = this.mirror.f32('lava');
    const i = this.col(x, y);
    if (!l || i < 0) return null;
    if (l[i * 4] <= 0.001) return null;
    return { depth: l[i * 4], temperature: l[i * 4 + 1], level: l[i * 4 + 3] };
  }

  /**
   * The heat at (x, y) in °C over the air's: the hotter of the ground's own
   * heat at its top (a beam's or lava's) and the lava's; a fire counts as
   * 600 × its intensity.
   */
  heatAt(x: number, y: number): number | null {
    const l = this.mirror.f32('lava');
    const f = this.mirror.f32('fire');
    const i = this.col(x, y);
    if (!l || !f || i < 0) return null;
    return Math.max(l[i * 4 + 2], l[i * 4] > 0.001 ? l[i * 4 + 1] : 0, f[i] * 600);
  }

  /**
   * Set fuel within `radius` of (x, y) alight at `intensity` (0..1): grass,
   * trees, oil, trash. Bare ground has nothing to burn and doesn't catch.
   */
  ignite(x: number, y: number, opts: { radius?: number; intensity?: number } = {}): void {
    this.core.globals.events.push({ kind: EventKind.Ignite, x, y, radius: opts.radius ?? 2, strength: opts.intensity ?? 0.9 });
  }
}
