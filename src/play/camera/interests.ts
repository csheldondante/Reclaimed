// ---- play/camera/interests.ts -----------------------------------------------------------------------------------
// (round 121, herolab) What the hero cares about, as points the camera keeps readable. Sources are separate and
// pluggable (InterestSource, contracts/camera.ts): the way ahead first; enemies from whatever lists them; objectives
// and pickups later, each its own source. Pure.

import type { CamPose, Interest, InterestSource, SightWorld, V3 } from '../../api/contracts/camera';
import { wayAhead, type Ahead } from './ahead';
import type { CamParams } from './params';

/** The way ahead along the hero's heading: its end and its middle, and whether it goes on (ahead.ts). */
export class WayAheadSource implements InterestSource {
  readonly id = 'ahead';
  /** the last walk (the signal and the debug draw read it) */
  last: Ahead | null = null;
  constructor(private p: CamParams) {}

  interests(pose: CamPose, world: SightWorld): Interest[] {
    const a = this.p.ahead;
    const speed = Math.hypot(pose.vel[0], pose.vel[1]);
    const dist = Math.min(a.maxDist, Math.max(a.minDist, speed * a.secs));
    // (moving: the way it's going; at rest: the way it faces)
    const heading = speed > 1 ? Math.atan2(pose.vel[1], pose.vel[0]) : pose.heading;
    const w = wayAhead((x, y) => world.top(x, y), [pose.at[0], pose.at[1]], heading, {
      dist,
      step: 1,
      climb: a.climb,
      fan: (a.fan * Math.PI) / 180,
      maxTurn: (a.maxTurn * Math.PI) / 180,
      bounds: world.bounds,
      margin: 2,
    });
    this.last = w;
    const mid = w.path[Math.floor(w.path.length / 2)];
    const out: Interest[] = [{ id: 'ahead', kind: 'ahead', at: w.end, weight: 1, open: w.open }];
    if (w.path.length > 6) out.push({ id: 'ahead-mid', kind: 'ahead', at: mid, weight: 0.6, open: w.open });
    return out;
  }

  /** a turn this sharp or more (degrees) */
  turned(deg: number): boolean {
    return !!this.last && Math.abs(this.last.turned) >= (deg * Math.PI) / 180;
  }
}

/** Enemies (or anything listed) near the hero, nearest first: `list` gives their feet. */
export class PointsSource implements InterestSource {
  constructor(
    readonly id: string,
    private kind: Interest['kind'],
    private list: (at: V3) => V3[],
    private weight = 0.5,
    private most = 2,
  ) {}

  interests(pose: CamPose): Interest[] {
    return this.list(pose.at)
      .map((p) => ({ p, d: Math.hypot(p[0] - pose.at[0], p[1] - pose.at[1]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.most)
      .map(({ p }, i) => ({ id: `${this.id}${i}`, kind: this.kind, at: p, weight: this.weight }));
  }
}

/** the hero itself, always first */
export function heroInterest(pose: CamPose): Interest {
  return { id: 'hero', kind: 'hero', at: pose.at, weight: 1 };
}
