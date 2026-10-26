// world.water (docs/WORLD_API.md): depth and flow from a CPU mirror, flood
// and drain as commands.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
// (the flux is a 60 Hz tick's volume whatever the tick rate: perfopt, simhz)
const FLUX_HZ = 60;
import { DIRV } from '../world/lattice';
import { sfZ } from '../world/layout';
import { columnAt } from './common';
import type { Mirror } from './mirror';
import { blendedTop } from './smooth';
import type { SampleOpts } from './terrain';

const OP_WATER = 3;
const OP_DRAIN = 9;
/** edit.wgsl: water added per tick of an OP_WATER event, per unit strength (at the centre) */
const WATER_PER_STRENGTH = 0.02;
const DRAIN_PER_STRENGTH = 0.03;

/** Queries answer from the mirror (every `mirror.every` ms, 250 by default); null before the first read. */
export class Water {
  constructor(
    private core: WorldCore,
    private mirror: Mirror,
  ) {
    const w = core.world;
    mirror.addBuffer('water', w.water);
    mirror.addBuffer('flux', w.flux);
    mirror.addBuffer('surface', w.surface);
    mirror.addTexture('drift', w.drift);
  }

  get readAt(): number {
    return this.mirror.readAt;
  }

  refresh(): Promise<void> {
    return this.mirror.refresh();
  }

  private col(x: number, y: number): number {
    return columnAt(this.core.dims.w, this.core.dims.h, x, y);
  }

  /** Water depth (cells) on the ground at (x, y). */
  depthAt(x: number, y: number): number | null {
    const w = this.mirror.f32('water');
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
    const w = this.mirror.f32('water');
    const s = this.mirror.u32('surface');
    const d = this.mirror.f32('drift');
    const i = this.col(x, y);
    if (!w || !s || !d || i < 0) return null;
    const { w: mw, h: mh } = this.core.dims;
    const at = (j: number) => sfZ(s[j]) + d[j * 4] + w[j];
    if (opts?.smooth) return blendedTop(x, y, (cx, cy) => (cx < 0 || cy < 0 || cx >= mw || cy >= mh ? null : at(cy * mw + cx)), false);
    return at(i);
  }

  /**
   * The water's flow at (x, y), cells/s in the world plane (approximate: the
   * column's outflow through its six pipes over its depth); [0, 0] where dry.
   */
  flowAt(x: number, y: number): [number, number] | null {
    const w = this.mirror.f32('water');
    const q = this.mirror.f32('flux');
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
