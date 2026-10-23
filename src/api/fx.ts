// world.fx (docs/WORLD_API.md): particle bursts by name. The kinds, their
// buffer layout and the per-tick burst cap stay inside (a tick spawns 64
// bursts; the rest go on the next ticks).
//
// They're the world's own particles: dust and ash settle as loose ground,
// embers light what they land on, splashes and smoke ride the wind.

import type { WorldCore } from '../scenes/world-core';
import { PK } from '../sim/particles';
import { materialId, type MaterialName } from './common';

export type FxName =
  | 'dust'
  | 'litter'
  | 'leaves'
  | 'ash'
  | 'chips'
  | 'cloud'
  | 'splash'
  | 'smoke'
  | 'embers'
  | 'flame'
  | 'haze'
  | 'seeds'
  | 'sparks'
  | 'petals'
  | 'grains';

/** each name's kind and defaults: count, speed (cells/s), spread (cells) */
const FX: Record<FxName, { kind: PK; count: number; speed: number; spread: number }> = {
  dust: { kind: PK.Dust, count: 40, speed: 4, spread: 1 },
  litter: { kind: PK.Litter, count: 12, speed: 4, spread: 1 },
  leaves: { kind: PK.Leaf, count: 20, speed: 2, spread: 1.5 },
  ash: { kind: PK.Ash, count: 40, speed: 3, spread: 1 },
  chips: { kind: PK.Chip, count: 12, speed: 5, spread: 0.6 },
  cloud: { kind: PK.Cloud, count: 6, speed: 1, spread: 3 },
  splash: { kind: PK.Splash, count: 30, speed: 5, spread: 0.8 },
  smoke: { kind: PK.Smoke, count: 20, speed: 1.5, spread: 1 },
  embers: { kind: PK.Ember, count: 16, speed: 6, spread: 0.5 },
  flame: { kind: PK.Flame, count: 16, speed: 2, spread: 0.6 },
  haze: { kind: PK.Haze, count: 120, speed: 6, spread: 2 },
  seeds: { kind: PK.Seed, count: 12, speed: 3, spread: 1 },
  sparks: { kind: PK.Spark, count: 20, speed: 8, spread: 0.3 },
  petals: { kind: PK.Petal, count: 20, speed: 2, spread: 1 },
  grains: { kind: PK.Grain, count: 30, speed: 3, spread: 0.6 },
};

export interface FxOpts {
  count?: number;
  /** cells/s */
  speed?: number;
  /** cells */
  spread?: number;
  /** 'haze': the material it's a cloud of (default drift); otherwise ignored */
  material?: MaterialName;
}

export class Fx {
  constructor(private core: WorldCore) {}

  /** The names `burst` knows. */
  get names(): FxName[] {
    return Object.keys(FX) as FxName[];
  }

  /** A burst of `name` at world (x, y, z), spawned on the next tick. */
  burst(name: FxName, x: number, y: number, z: number, opts: FxOpts = {}): void {
    const f = FX[name];
    if (!f) throw new Error(`world.fx: no burst "${name}" (one of ${this.names.join(', ')})`);
    const payload = name === 'haze' ? materialId(opts.material ?? 'drift') : 0;
    this.core.sim.particles.burst({ kind: f.kind, x, y, z, count: opts.count ?? f.count, speed: opts.speed ?? f.speed, spread: opts.spread ?? f.spread, payload });
  }
}
