// ---- play/camera/metrics.ts -------------------------------------------------------------------------------------
// (round 121, herolab) How well a camera mode does along a ride: the share of frames the hero is hidden (the cut left
// out, as the renderer draws it), the share the way ahead is unseen (hidden or off the screen), and how much the
// view turns a second (comfort: the angle between successive eye directions — the turn and the tilt together). Pure.

import type { CamFrame, Interest, SightWorld } from '../../api/contracts/camera';
import { lookAt } from './modes';
import { eyeDir, hiddenBy, onScreen } from './sight';

export interface MetricsSummary {
  frames: number;
  /** share of frames the hero is hidden */
  hero: number;
  /** share of frames the way ahead's end is hidden or off the screen (unseen) */
  ahead: number;
  /** ...of which off the screen (the framing's share, not occlusion's) */
  aheadOff: number;
  /** share of frames the way ahead's middle is unseen (hidden or off the screen) */
  aheadMid: number;
  /** degrees a second the eye turns: the mean, the 95th percentile */
  turn: number;
  turn95: number;
  /** share of frames a dead end was signalled */
  dead: number;
}

export class CamMetrics {
  private frames = 0;
  private hero = 0;
  private ahead = 0;
  private aheadOff = 0;
  private aheadMid = 0;
  private dead = 0;
  private turns: number[] = [];
  private lastEye: [number, number, number] | null = null;

  add(dt: number, frame: CamFrame, interests: Interest[], world: SightWorld): void {
    const v = frame.view;
    const e = eyeDir(v.azimuth, v.elevation);
    this.frames++;
    const hero = interests.find((i) => i.kind === 'hero');
    if (hero && hiddenBy(world, lookAt(hero), e, frame.cut)) this.hero++;
    const unseen = (id: string) => {
      const i = interests.find((x) => x.id === id);
      if (!i) return null;
      const p = lookAt(i);
      return !onScreen(v, p, 0) ? 'off' : hiddenBy(world, p, e, frame.cut) ? 'hidden' : null;
    };
    const a = unseen('ahead');
    if (a) this.ahead++;
    if (a === 'off') this.aheadOff++;
    if (unseen('ahead-mid')) this.aheadMid++;
    if (frame.signals.some((s) => s.kind === 'dead')) this.dead++;
    if (this.lastEye && dt > 0) {
      const d = Math.min(1, Math.max(-1, e[0] * this.lastEye[0] + e[1] * this.lastEye[1] + e[2] * this.lastEye[2]));
      this.turns.push((Math.acos(d) * 180) / Math.PI / dt);
    }
    this.lastEye = e;
  }

  summary(): MetricsSummary {
    const n = Math.max(1, this.frames);
    const t = [...this.turns].sort((a, b) => a - b);
    const mean = t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0;
    return { frames: this.frames, hero: this.hero / n, ahead: this.ahead / n, aheadOff: this.aheadOff / n, aheadMid: this.aheadMid / n, turn: mean, turn95: t.length ? t[Math.min(t.length - 1, Math.floor(t.length * 0.95))] : 0, dead: this.dead / n };
  }
}
