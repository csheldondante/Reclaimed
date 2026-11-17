// world.fire (docs/WORLD_API.md): fire, lava and the ground's heat from a
// CPU mirror; setting things alight as a command.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import { columnAt } from './common';
import type { Mirror } from './mirror';
import { COLUMN_BUFS } from '../sim/pages';
import { cellAt } from '../world/lattice';

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
    mirror.addColumns('fire', () => core.world.fire, COLUMN_BUFS.fire[0]);
    mirror.addColumns('lava', () => core.world.lava, COLUMN_BUFS.lava[0]);
    // (loop round 12) the flow model's lava (flow/liquid.ts): its open runs' depth, a f32 a column laid out as the water
    mirror.addColumns('flowLava', () => core.flow.lava.open, COLUMN_BUFS.water[0]);
  }

  /** (loop round 12) the flow model's lava standing open at (x, y): its depth (cells; 0 none), null before it is read
   *  (the page is asked for now and read a frame or two later) */
  /**
   * (loop round 14) Read the flow model's lava at these points (world units) now, in one read: resolves once their
   * pages are in. The mirror counts a page stale only once its chunk ran a tick, and lava flows on through sleeping chunks
   * (their flux carried on): a front's reads of its points (live-runner) saw 0 under lava that had come — so it reads
   * them fresh.
   */
  loadFlowLava(points: readonly (readonly [number, number])[]): Promise<void> {
    return this.mirror.refreshCells(points.map(([x, y]) => cellAt(x, y)), ['flowLava']);
  }

  /** (loop round 17, sim/quiet.ts) the fire field read fresh round these points (their chunks' pages only) */
  loadFire(points: readonly (readonly [number, number])[]): Promise<void> {
    return this.mirror.refreshCells(points.map(([x, y]) => cellAt(x, y)), ['fire']);
  }

  flowLavaAt(x: number, y: number): number | null {
    const [cx, cy] = cellAt(x, y);
    const l = this.mirror.f32('flowLava', cx, cy);
    const i = this.col(x, y);
    if (!l || i < 0) return null;
    return l[i];
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
    const [cx, cy] = cellAt(x, y);
    const f = this.mirror.f32('fire', cx, cy);
    const i = this.col(x, y);
    if (!f || i < 0) return null;
    return f[i];
  }

  /** Lava at (x, y), or null where there's none (or before the first read). */
  lavaAt(x: number, y: number): LavaAt | null {
    const [cx, cy] = cellAt(x, y);
    const l = this.mirror.f32('lava', cx, cy);
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
    const [cx, cy] = cellAt(x, y);
    const l = this.mirror.f32('lava', cx, cy);
    const f = this.mirror.f32('fire', cx, cy);
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
