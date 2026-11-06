// world.water (docs/WORLD_API.md): depth and flow from a CPU mirror, flood
// and drain as commands.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
// (the flux is a 60 Hz tick's volume whatever the tick rate: perfopt, simhz)
const FLUX_HZ = 60;
import { DIRV, cellAt } from '../world/lattice';
import { sfZ } from '../world/layout';
import { columnAt } from './common';
import type { Mirror } from './mirror';
import { COLUMN_BUFS } from '../sim/pages';
import { blendedTop } from './smooth';
import type { SampleOpts } from './terrain';

import { OP } from '../sim/edit-ops';

const OP_WATER = OP.WATER;
const OP_DRAIN = OP.DRAIN;
/** edit.wgsl: water added per tick of an OP_WATER event, per unit strength (at the centre) */
const WATER_PER_STRENGTH = 0.02;
const DRAIN_PER_STRENGTH = 0.03;

/** Queries answer from the mirror (every `mirror.every` ms, 250 by default); null before the first read. */
export class Water {
  constructor(
    private core: WorldCore,
    private mirror: Mirror,
  ) {
    const w = () => core.world;
    mirror.addColumns('water', () => w().water, COLUMN_BUFS.water[0]);
    mirror.addColumns('flux', () => w().flux, COLUMN_BUFS.flux[0]);
    mirror.addColumns('surface', () => w().surface, COLUMN_BUFS.surface[0]);
    mirror.addTexture('drift', () => w().drift);
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

  /** Water depth (cells) on the ground at (x, y). */
  depthAt(x: number, y: number): number | null {
    const [cx, cy] = cellAt(x, y);
    const w = this.mirror.f32('water', cx, cy);
    const i = this.col(x, y);
    if (!w || i < 0) return null;
    return w[i];
  }

  /**
   * The water's surface height at (x, y) (the bed it lies on plus its
   * depth); `smooth`: blended over the three nearest cell centres, as the
   * water sheet is drawn, so a rider on it doesn't step.
   */
  levelAt(x: number, y: number, opts?: SampleOpts): number | null {
    const ring = this.core.ring;
    // (round 112: the buffers — water, surface — at the column's index, the drift texture at its texel; the smooth
    // read had taken cy * w + cx for all three, the window's order, which neither is since round 107. Round 128o: each
    // column's pages read, else null)
    // (null: off the window; undefined: its pages not read yet)
    const { w: mw, h: mh } = this.core.dims;
    const at = (cx: number, cy: number): number | null | undefined => {
      if (cx < 0 || cy < 0 || cx >= mw || cy >= mh) return null;
      const w = this.mirror.f32('water', cx, cy);
      const s = this.mirror.u32('surface', cx, cy);
      const d = this.mirror.f32('drift', cx, cy);
      if (!w || !s || !d) return undefined;
      const j = ring.i(cx, cy);
      return sfZ(s[j]) + d[ring.t(cx, cy) * 4] + w[j];
    };
    if (opts?.smooth) return this.col(x, y) < 0 ? null : blendedTop(x, y, at, false);
    const [cx, cy] = cellAt(x, y);
    return at(cx, cy) ?? null;
  }

  /**
   * The water's flow at (x, y), cells/s in the world plane (approximate: the
   * column's outflow through its six pipes over its depth); [0, 0] where dry.
   */
  flowAt(x: number, y: number): [number, number] | null {
    const [cx, cy] = cellAt(x, y);
    const w = this.mirror.f32('water', cx, cy);
    const q = this.mirror.f32('flux', cx, cy);
    const i = this.col(x, y);
    if (!w || !q || i < 0) return null;
    const depth = w[i];
    if (depth < 0.01) return [0, 0];
    let vx = 0;
    let vy = 0;
    for (let d = 0; d < 6; d++) {
      vx += DIRV[d][0] * q[i * 6 + d];
      vy += DIRV[d][1] * q[i * 6 + d];
    }
    return [(vx / depth) * FLUX_HZ, (vy / depth) * FLUX_HZ];
  }

  /**
   * Add about `depth` cells of water over `radius` round (x, y) (most at the
   * centre, fading to the rim); it runs off as the ground lets it.
   */
  flood(x: number, y: number, opts: { radius?: number; depth?: number } = {}): void {
    const depth = opts.depth ?? 1;
    this.core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP_WATER * 32, radius: opts.radius ?? 4, strength: depth / WATER_PER_STRENGTH });
  }

  /** Take up to `depth` cells of water (and oil) off within `radius`. */
  drain(x: number, y: number, opts: { radius?: number; depth?: number } = {}): void {
    const depth = opts.depth ?? 1;
    this.core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP_DRAIN * 32, radius: opts.radius ?? 4, strength: depth / DRAIN_PER_STRENGTH });
  }
}
