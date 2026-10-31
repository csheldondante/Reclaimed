// ---- runsit/finale.ts -------------------------------------------------------------------------------------------
// (round 120, `runsit`; BACKLOG RS20) The finale's rules: when the town catches fire, when it has fallen, when it's
// saved, when its people are safe. Pure (unit-tested); area.ts plays them live — the horde really marches (Units), the
// fires are really set (the world API's fire.ignite on the town's timber and fields; the fire system spreads them and
// its heat brings the houses down), so a town that falls is burned in the map, not in a line of text.
// The user (round 120): "Have an objective to protect a city form zombies and have zombies assail the city. Let it burn
// down if the player fails."

import type { SituationEnd } from '../api/contracts/situation';
import type { FinaleSetup, V2 } from './state';

/** horde-seconds inside the town for each fire it sets (three of the dead inside for 4 s set one) */
export const FIRE_EVERY = 12;
/** fires set when the town has fallen (and the rest of it is fired) */
export const FALL_AT = 6;
/** seconds after the horde comes that the town is judged to have held (the dead broken off, the night over) */
export const HOLD_S = 300;
/** of the people the hero set out with, the share that must reach the refuge */
export const SAFE_SHARE = 0.5;
/** cells from the town's middle that count as inside it (its built radius is the settlement's) */
export const INSIDE = 0.75;

export interface FinaleObs {
  /** seconds since the finale began */
  t: number;
  heroAlive: boolean;
  /** the horde has come (spawned) */
  hordeCame: boolean;
  /** of it, still standing; inside the town */
  hordeLeft: number;
  hordeInside: number;
  /** evacuation: the people led out (their count when the order was given), and how many stand at the refuge */
  refugees?: { led: number; safe: number };
}

export type FinaleStatus = { state: 'playing' } | { state: 'ended'; end: SituationEnd; why: string };

export class FinaleRules {
  fires: number;
  private breach = 0;
  fallen = false;
  status: FinaleStatus = { state: 'playing' };

  constructor(readonly setup: FinaleSetup) {
    this.fires = setup.burning;
  }

  /** a step: how many new fires the horde sets now (keeps going after the end: a town left to the dead still burns) */
  step(dt: number, o: FinaleObs): number {
    let ignite = 0;
    this.breach += dt * o.hordeInside;
    while (this.breach >= FIRE_EVERY) {
      this.breach -= FIRE_EVERY;
      ignite++;
    }
    this.fires += ignite;
    if (!this.fallen && this.fires >= FALL_AT) this.fallen = true;
    if (this.status.state === 'playing') this.status = this.judge(o);
    return ignite;
  }

  /** a fire that couldn't be set (the ward, nothing left to burn): it doesn't count */
  unset(n = 1): void {
    this.fires = Math.max(this.setup.burning, this.fires - n);
  }

  private judge(o: FinaleObs): FinaleStatus {
    if (!o.heroAlive) return { state: 'ended', end: 'fell', why: 'the hero fell' };
    const safe = o.refugees && o.refugees.led > 0 && o.refugees.safe >= Math.ceil(o.refugees.led * SAFE_SHARE);
    if (this.setup.mode === 'evacuate' && safe) return { state: 'ended', end: 'evacuated', why: `${o.refugees!.safe} of ${o.refugees!.led} reached the refuge` };
    if (this.fallen) return { state: 'ended', end: 'burned', why: `${this.fires} fires: the town fell` };
    if (o.hordeCame && o.hordeLeft === 0) return { state: 'ended', end: 'saved', why: 'the horde is broken' };
    const came = Math.max(0, this.setup.hordeIn);
    if (o.hordeCame && o.t > came + HOLD_S) return { state: 'ended', end: 'saved', why: 'the town held till they broke off' };
    return { state: 'playing' };
  }
}

/**
 * Where the horde sets its next fire: the house nearest one of the dead inside the town, not burning yet, and not
 * within the hero's ward. null: nowhere it can (the ward covers what's near them, or every house burns).
 */
export function fireSite(houses: V2[], burning: Set<number>, dead: V2[], hero: V2 | null, ward: number): number | null {
  let best: number | null = null;
  let bd = Infinity;
  houses.forEach((h, i) => {
    if (burning.has(i)) return;
    if (hero && ward > 0 && Math.hypot(h[0] - hero[0], h[1] - hero[1]) < ward) return;
    for (const d of dead) {
      const dd = Math.hypot(h[0] - d[0], h[1] - d[1]);
      if (dd < bd) (bd = dd), (best = i);
    }
  });
  return best;
}
