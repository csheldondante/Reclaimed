// The forest station's ride (round 125, `forest`): a loop that runs in under a wood's canopy and out into the open,
// and the stick that rides a hero round it (pure pursuit: toward the point `look` cells further along the loop than
// the nearest). Pure, so the lab's route and pace are tested in Node.

import { TREE_SCALE } from '../flora/spacing';

export type V2 = [number, number];

export interface Stand {
  /** the stand's middle (window x cells, y world units) */
  at: V2;
  /** the way out of it to open ground (unit) */
  out: V2;
  /** the trees counted round its middle */
  trees: number;
  elders: number;
  /** (the parked shots) where the hero stands to be framed: a few cells in front of a trunk, toward the eye */
  park?: V2;
}

/**
 * Where to park the hero in a stand for the composed shot (main's review: "compose the station so 2-3 massive trunks
 * stand in view near the hero"): in front of the trunk with the most trunks round it (within `reach`), `ahead` cells
 * toward the eye (`eye`: the ground way toward the eye, unit) — so its trunk rises behind the hero and its neighbours
 * frame it.
 */
export function parkSpot(trunks: V2[], eye: V2, ahead = 4, reach = 16 * TREE_SCALE): V2 | null {
  let best: V2 | null = null;
  let most = -1;
  for (const t of trunks) {
    const n = trunks.filter((u) => Math.hypot(u[0] - t[0], u[1] - t[1]) < reach).length;
    if (n > most) {
      most = n;
      best = t;
    }
  }
  return best ? [best[0] + eye[0] * ahead, best[1] + eye[1] * ahead] : null;
}

/** A loop of `n` points: its middle `shift` cells from the stand's toward the open, `radius` round, so about half of it is in the wood. */
export function standLoop(s: Stand, radius = 17, shift = 15, n = 36): V2[] {
  const c: V2 = [s.at[0] + s.out[0] * shift, s.at[1] + s.out[1] * shift];
  const out: V2[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push([c[0] + Math.cos(a) * radius, c[1] + Math.sin(a) * radius]);
  }
  return out;
}

/** The way from (x, y) toward the open: of `dirs` ways, the one whose point `dist` out has the fewest trees within `r` (`count`). */
export function openWay(x: number, y: number, count: (x: number, y: number, r: number) => number, dist = 30, r = 9, dirs = 8): V2 {
  let best: V2 = [1, 0];
  let fewest = Infinity;
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    const d: V2 = [Math.cos(a), Math.sin(a)];
    const n = count(x + d[0] * dist, y + d[1] * dist, r);
    if (n < fewest) {
      fewest = n;
      best = d;
    }
  }
  return best;
}

/** Rides round a closed loop: `stick(at)` the direction to push (unit × throttle), keeping its own progress. */
export class LoopRider {
  private i = 0;
  constructor(
    readonly path: V2[],
    public look = 5,
    public throttle = 0.8,
  ) {
    if (path.length < 3) throw new Error('forest ride: a loop needs three points or more');
  }

  /** the index nearest `at`, searched a little ahead of the last (so the loop isn't short-cut) */
  private nearest(at: V2): number {
    const n = this.path.length;
    let best = this.i;
    let bd = Infinity;
    for (let k = 0; k < Math.ceil(n / 3); k++) {
      const j = (this.i + k) % n;
      const p = this.path[j];
      const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    this.i = best;
    return best;
  }

  stick(at: V2): V2 {
    const n = this.path.length;
    const i = this.nearest(at);
    // (the point `look` cells further along)
    let j = i;
    let left = this.look;
    while (left > 0) {
      const a = this.path[j];
      const b = this.path[(j + 1) % n];
      left -= Math.hypot(b[0] - a[0], b[1] - a[1]);
      j = (j + 1) % n;
    }
    const t = this.path[j];
    const dx = t[0] - at[0];
    const dy = t[1] - at[1];
    const l = Math.hypot(dx, dy) || 1;
    return [(dx / l) * this.throttle, (dy / l) * this.throttle];
  }

  /** where the loop starts, and the index to start from */
  start(k = 0): V2 {
    this.i = k % this.path.length;
    const p = this.path[this.i];
    return [p[0], p[1]];
  }
}
