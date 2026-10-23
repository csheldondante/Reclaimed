// world.water (docs/WORLD_API.md): depth and flow from a CPU mirror, flood
// and drain as commands.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import { TICK_HZ } from '../sim/simulation';
import { DIRV } from '../world/lattice';
import { sfZ } from '../world/layout';
import { columnAt } from './common';
import type { Mirror } from './mirror';

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
    const w = this.mirror.get('water');
    const i = this.col(x, y);
    if (!w || i < 0) return null;
    return new Float32Array(w)[i];
  }

  /** The water's surface height at (x, y) (the bed it lies on plus its depth). */
  levelAt(x: number, y: number): number | null {
    const w = this.mirror.get('water');
    const s = this.mirror.get('surface');
    const d = this.mirror.get('drift');
    const i = this.col(x, y);
    if (!w || !s || !d || i < 0) return null;
    return sfZ(new Uint32Array(s)[i]) + new Float32Array(d)[i * 4] + new Float32Array(w)[i];
  }

  /**
   * The water's flow at (x, y), cells/s in the world plane (approximate: the
   * column's outflow through its six pipes over its depth); [0, 0] where dry.
   */
  flowAt(x: number, y: number): [number, number] | null {
    const w = this.mirror.get('water');
    const f = this.mirror.get('flux');
    const i = this.col(x, y);
    if (!w || !f || i < 0) return null;
    const depth = new Float32Array(w)[i];
    if (depth < 0.01) return [0, 0];
    const q = new Float32Array(f);
    let vx = 0;
    let vy = 0;
    for (let d = 0; d < 6; d++) {
      vx += DIRV[d][0] * q[i * 6 + d];
      vy += DIRV[d][1] * q[i * 6 + d];
    }
    return [(vx / depth) * TICK_HZ, (vy / depth) * TICK_HZ];
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
