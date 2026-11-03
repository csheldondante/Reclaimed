// ---- play/lab/autopilot.ts --------------------------------------------------------------------------------------
// (round 121, herolab) Rides a hero round a station's closed path for the metrics and the GIFs: pure pursuit — the
// stick toward the point `look` cells further along the path from the nearest, its length the path's speed share
// there. It keeps its own progress (the nearest point searched a little ahead of the last), so a loop that passes
// near itself (a detour into a dead end and out) isn't short-cut. Pure.

import type { V2 } from '../../api/contracts/camera';

export interface AutoPath {
  at: V2;
  speed: number;
}

/**
 * (round 128) cells ahead the stick points, by hero: a walker (the knight, the lich) looks 3 — at 7 it cut the
 * canyon's corners into its boulders and stood there; the bike 7
 */
export const lookFor = (hero: string): number => (hero === 'hoverbike' ? 7 : 3);

export class Autopilot {
  /** the path's index the hero is nearest (fractional: along the segment) */
  private i = 0;
  private cum: number[] = [];
  private total = 0;
  constructor(
    readonly path: AutoPath[],
    /** cells ahead the stick points */
    public look = 7,
    /** the stick's length at a speed share of 1 */
    public throttle = 1,
  ) {
    if (path.length < 3) throw new Error('autopilot: a path needs three points or more');
    let s = 0;
    for (let k = 0; k < path.length; k++) {
      this.cum.push(s);
      const a = path[k].at;
      const b = path[(k + 1) % path.length].at;
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    this.total = s;
  }

  /** cells round the loop */
  get length(): number {
    return this.total;
  }

  /** where the path starts (or the point `k` along it), and the way it heads there */
  start(k = 0): { at: V2; heading: number } {
    const n = this.path.length;
    const a = this.path[k % n].at;
    const b = this.path[(k + 1) % n].at;
    this.i = k % n;
    return { at: [a[0], a[1]], heading: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }

  /** the distance along the loop of a fractional index */
  private along(fi: number): number {
    const n = this.path.length;
    const k = Math.floor(fi) % n;
    const f = fi - Math.floor(fi);
    const a = this.path[k].at;
    const b = this.path[(k + 1) % n].at;
    return this.cum[k] + f * Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  /** the point (and speed share) at a distance along the loop */
  pointAt(d: number): AutoPath {
    const n = this.path.length;
    const s = ((d % this.total) + this.total) % this.total;
    let k = 0;
    while (k + 1 < n && this.cum[k + 1] <= s) k++;
    const a = this.path[k];
    const b = this.path[(k + 1) % n];
    const len = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]) || 1;
    const f = (s - this.cum[k]) / len;
    return { at: [a.at[0] + (b.at[0] - a.at[0]) * f, a.at[1] + (b.at[1] - a.at[1]) * f], speed: a.speed + (b.speed - a.speed) * f };
  }

  /** the stick (world xy, 0..1) for a hero at `p` */
  steer(p: V2): V2 {
    const n = this.path.length;
    // (the nearest segment within the next few, from where it was)
    let best = this.i;
    let bestD = Infinity;
    for (let s = 0; s < Math.min(n, 8); s++) {
      const k = (Math.floor(this.i) + s) % n;
      const a = this.path[k].at;
      const b = this.path[(k + 1) % n].at;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
      const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
      if (d < bestD - 1e-9) {
        bestD = d;
        best = Math.floor(this.i) + s + t;
      }
    }
    this.i = best % n;
    const target = this.pointAt(this.along(this.i) + this.look);
    const dx = target.at[0] - p[0];
    const dy = target.at[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    const m = Math.max(0, Math.min(1, target.speed * this.throttle));
    return [(dx / l) * m, (dy / l) * m];
  }

  /** laps so far (progress / length), for the metrics */
  get progress(): number {
    return this.along(this.i) / this.total;
  }
}
