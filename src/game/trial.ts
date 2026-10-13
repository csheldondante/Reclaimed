// Gate trials (docs/LEVELS.md, "The tools"): the page side of the gate
// validator (scripts/gates.mjs). `reclaimed.trial.run(ability, seconds)`
// applies one ability to every gate of the level at once — the way a player
// would, through Powers and Weather — lets the world run, and reports how
// much of each gate was cleared and how much of it green could now take.
//
// "Closed" per gate kind (what the gate is made of still there):
//   dust    blown dust deeper than DUST_DEEP on top (drift material 0 or Drift)
//   litter  litter on top (loose: the drift texture) or trash
//   trash   trash or litter on top
//   poison  poison > 0.2, in the soil or dissolved in water standing on it
//           (standing water takes it up, and drops it again as it dries)
//   oil     oil on the ground, or the stain it leaves (oil on bare ground
//           soaks in as soil poison: that isn't clearing it)
//   wall    solid top more than a cell above the ground beside it
//   dry     moisture < 0.04
// "Fertile": what a seed landing there needs (particles.wgsl's grow test:
// no poison, no trash or litter, not parched, not under water, oil or dust).

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import type { Ability, GateSpec, P } from '../world/kit';
import { sfMat, sfZ } from '../world/layout';
import { MAT } from '../world/materials';
import type { Powers } from './powers';

const DUST_DEEP = 0.4;

export interface GateResult {
  id: string;
  kind: string;
  /** a lesson the weather may clear (not flagged as leaking) */
  soft?: boolean;
  /** share of the gate closed at the start / at the end (0..1) */
  closed0: number;
  closed1: number;
  /** share of the gate fertile at the start / at the end */
  fertile0: number;
  fertile1: number;
  /** how much of what the gate is made of is there, at the start / at the end (dust depth, poison, oil, wall height, junk cells) */
  amount0: number;
  amount1: number;
}

interface Snapshot {
  surface: Uint32Array;
  contam: Float32Array;
  oil: Float32Array;
  moisture: Float32Array;
  water: Float32Array;
  drift: Float32Array;
}

export class Trial {
  constructor(
    private core: WorldCore,
    private powers: Powers,
    readonly gates: GateSpec[],
    /** where the level's green starts (wind blows outward from it) */
    private hub: P,
  ) {}

  private async snap(): Promise<Snapshot> {
    const c = this.core;
    const [surface, contam, oil, moisture, water, drift] = await Promise.all([
      c.readBuffer('surface'),
      c.readBuffer('contam'),
      c.readBuffer('oil'),
      c.readBuffer('moisture'),
      c.readBuffer('water'),
      c.readTexture(c.world.drift),
    ]);
    return { surface: new Uint32Array(surface.buffer), contam, oil, moisture, water, drift: drift.data };
  }

  private closed(g: GateSpec, s: Snapshot, i: number): boolean {
    switch (g.kind) {
      case 'dust':
        return this.dusty(s, i);
      case 'litter':
      case 'trash':
        return this.junk(s, i);
      case 'poison':
        return s.contam[i * 2] + s.contam[i * 2 + 1] > 0.2;
      case 'oil':
        return s.oil[i] > 0.004 || s.contam[i * 2] > 0.2;
      case 'wall':
        // (a broken wall is rubble: loose, so the surface drops to its foot)
        return sfZ(s.surface[i]) > (g.base ?? 0) + 1.5;
      case 'dry':
        return s.moisture[i] < 0.04;
    }
  }

  /** how much of the gate's stuff is on a column (dust depth, poison, oil, wall height above the ground, junk) */
  private amount(g: GateSpec, s: Snapshot, i: number): number {
    switch (g.kind) {
      case 'dust': {
        const m = Math.round(s.drift[i * 4 + 2]);
        return m === 0 || m === MAT.Drift ? s.drift[i * 4 + 1] : 0;
      }
      case 'litter':
      case 'trash':
        return this.junk(s, i) ? 1 : 0;
      case 'poison':
        return s.contam[i * 2] + s.contam[i * 2 + 1];
      case 'oil':
        return s.oil[i] + Math.max(0, s.contam[i * 2] - 0.2);
      case 'wall':
        return Math.max(0, sfZ(s.surface[i]) - (g.base ?? 0) - 1);
      case 'dry':
        return Math.max(0, 0.04 - s.moisture[i]);
    }
  }

  /** blown dust on top (the loose run's top interval) */
  private dusty(s: Snapshot, i: number): boolean {
    const m = Math.round(s.drift[i * 4 + 2]);
    return (m === 0 || m === MAT.Drift) && s.drift[i * 4 + 1] > DUST_DEEP;
  }

  /** trash (solid) or litter (loose) on top */
  private junk(s: Snapshot, i: number): boolean {
    const m = sfMat(s.surface[i]);
    const loose = s.drift[i * 4] > 0.05 ? Math.round(s.drift[i * 4 + 2]) : -1;
    return loose === MAT.Litter || (loose < 0 && (m === MAT.Trash || m === MAT.Litter));
  }

  private fertile(s: Snapshot, i: number): boolean {
    return s.contam[i * 2] + s.contam[i * 2 + 1] <= 0.2 && !this.junk(s, i) && s.moisture[i] >= 0.04 && s.water[i] < 0.3 && s.oil[i] <= 0.004 && !this.dusty(s, i);
  }

  /** Each gate's share closed and fertile now. */
  async measure(): Promise<{ id: string; closed: number; fertile: number; amount: number }[]> {
    const s = await this.snap();
    return this.gates.map((g) => ({
      id: g.id,
      amount: g.cells.reduce((a, i) => a + this.amount(g, s, i), 0),
      closed: g.cells.filter((i) => this.closed(g, s, i)).length / g.cells.length,
      fertile: g.cells.filter((i) => this.fertile(s, i)).length / g.cells.length,
    }));
  }

  /** wait `seconds` of simulated time, calling `each` every frame */
  private wait(seconds: number, each?: (t: number) => void): Promise<void> {
    const g = this.core.globals;
    const t0 = g.time;
    return new Promise((done) => {
      const step = () => {
        const t = g.time - t0;
        if (t >= seconds) return done();
        each?.(t);
        requestAnimationFrame(step);
      };
      step();
    });
  }

  /** outward from the hub through the gate: unit direction */
  private out(g: GateSpec): P {
    const dx = g.at[0] - this.hub[0];
    const dy = g.at[1] - this.hub[1];
    const L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  }

  private radius(g: GateSpec): number {
    return Math.sqrt(g.cells.length / Math.PI);
  }

  /**
   * Apply `ability` to every gate for `seconds` of sim time, then let the
   * world run `settle` more; natural weather is held off ('ambient' sends
   * one natural storm and one dust storm across instead). `only`: apply it to
   * these gates alone (a player does wind and cyclones one place at a time).
   * Returns before/after per gate.
   */
  async run(ability: Ability | 'ambient', seconds = 40, settle = 20, only?: string[]): Promise<GateResult[]> {
    const { weather, globals } = this.core;
    weather.holdNatural(seconds + settle + 600);
    const before = await this.measure();
    const surf = (await this.snap()).surface;
    const topOf = (i: number) => sfZ(surf[i]);
    const w = this.core.dims.w;
    // (the ability goes only to these gates; all are measured)
    const gates = only ? this.gates.filter((g) => only.includes(g.id)) : this.gates;
    let next = 0;
    let done = false;
    const storms = new Map<string, { x: number; y: number }>();
    if (ability === 'ambient') {
      // the weather alone: a natural storm and a dust storm cross the map (a
      // few minutes' worth of what the level's weather brings unasked)
      const [cx, cy] = [this.core.dims.w / 2, this.core.dims.h / 2];
      weather.spawnToward(cx, cy);
      weather.spawnDust(cx, cy);
    }
    if (ability === 'wind' || ability === 'gale') {
      // strokes outward across each gate, one after another as a player
      // draws them: one per gate per pass (a breeze to a gust), or three
      // stacked (a gale); each takes 0.4 s
      const strokes = ability === 'gale' ? 3 : 1;
      void (async () => {
        while (!done)
          for (const g of gates) {
            const [ux, uy] = this.out(g);
            const R = this.radius(g) + 4;
            for (let k = 0; k < strokes && !done; k++) {
              const off = (k - (strokes - 1) / 2) * 3;
              const a: P = [g.at[0] - ux * R - uy * off, g.at[1] - uy * R + ux * off];
              const b: P = [g.at[0] + ux * R - uy * off, g.at[1] + uy * R + ux * off];
              await this.powers.scriptStroke([a, b], 0.4);
            }
          }
      })();
    }
    await this.wait(seconds, (t) => {
      if (t < next) return;
      switch (ability) {
        case 'cyclone':
          // one at a time per gate (four at most at once): a fresh one every 5 s, round the gates
          {
            const g = gates[Math.floor(t / 5) % gates.length];
            weather.spawnCyclone(g.at[0], g.at[1], 1);
            next = t + 5;
          }
          break;
        case 'rain':
          // a storm parked over each gate (four at once at most: round the gates)
          for (const g of gates) {
            if (storms.has(g.id) || !weather.canSpawn()) continue;
            const st = weather.spawn(g.at[0], g.at[1]);
            if (st) storms.set(g.id, st);
          }
          for (const [id, st] of storms) {
            const g = gates.find((q) => q.id === id)!;
            st.x = g.at[0];
            st.y = g.at[1];
          }
          break;
        case 'lightning':
          // a strike on a random column of each gate every 2 s
          for (const g of gates) {
            const i = g.cells[Math.floor(Math.random() * g.cells.length)];
            this.powers.scriptStrike(i % w, Math.floor(i / w), topOf(i));
          }
          next = t + 2;
          break;
        case 'flood': {
          // water poured onto each gate's highest ground for the first 40%,
          // as a flood from upstream would arrive
          for (const g of gates) {
            if (t > seconds * 0.4) break;
            let hi = g.cells[0];
            for (const i of g.cells) if (topOf(i) > topOf(hi)) hi = i;
            globals.events.push({ kind: EventKind.Edit, x: (hi % w) + 0.5, y: Math.floor(hi / w) + 0.5, z: 3 * 32, radius: 4, strength: 1 });
          }
          break;
        }
        case 'chip':
          // taps four a second, hammering one spot as a player breaching a
          // wall would: the tallest column and the few nearest it
          for (const g of gates) {
            const top = g.cells.reduce((a, b) => (topOf(b) > topOf(a) ? b : a));
            const d = (i: number) => Math.hypot((i % w) - (top % w), Math.floor(i / w) - Math.floor(top / w));
            const spot = [...g.cells].sort((a, b) => d(a) - d(b)).slice(0, 6);
            const i = spot[Math.floor(Math.random() * spot.length)];
            globals.events.push({ kind: EventKind.Chip, x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5, z: Math.floor(topOf(i) - 0.5), radius: 1.8, strength: 1 });
          }
          next = t + 0.25;
          break;
      }
    });
    done = true;
    await this.wait(settle);
    const after = await this.measure();
    return this.gates.map((g, k) => ({ id: g.id, kind: g.kind, soft: g.soft, closed0: before[k].closed, closed1: after[k].closed, fertile0: before[k].fertile, fertile1: after[k].fertile, amount0: before[k].amount, amount1: after[k].amount }));
  }
}
