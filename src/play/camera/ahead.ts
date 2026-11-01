// ---- play/camera/ahead.ts ---------------------------------------------------------------------------------------
// (round 121, herolab) The way ahead: from the hero along its heading, does the ground it can ride go on, or does it
// end? The user (round 120): "riding the hoverbike near the foot of cliffs is cool and cinematic but when you turn
// around a cliff sometimes it's a cool new direction to go and sometimes it's a dead end that kills momentum."
//
// A beam walked a step at a time over the sky floor: straight on while the rise is one the hero rides, else the
// smallest swing either way (fan steps, out to a right angle) that is; the swings add up, and past `maxTurn` it's
// turned back on itself — a dead end, as is a step with no way at all. It gets `dist` (the hero's speed × seconds,
// within limits) from where it started, as the crow flies, within twice that walked: the way goes on (walking along a
// box canyon's back wall isn't a way on). Pure (a height function in).

import type { V2, V3 } from '../../api/contracts/camera';

export interface AheadOpts {
  /** cells to look along */
  dist: number;
  /** cells a step */
  step: number;
  /** the rise over run the hero rides (steeper is a wall) */
  climb: number;
  /** radians a swing is tried in */
  fan: number;
  /** radians of swing, all told, past which the way has turned back: a dead end */
  maxTurn: number;
  /** the world's extent (x cells, y world units) and a margin inside it */
  bounds: V2;
  margin?: number;
}

export interface Ahead {
  /** it got `dist` away */
  open: boolean;
  /** cells it walked */
  reach: number;
  /** where it got to (on the ground) */
  end: V3;
  /** the points it went through (each step) */
  path: V3[];
  /** radians it swung, signed (+ to the left, counter-clockwise) */
  turned: number;
}

export function wayAhead(top: (x: number, y: number) => number, from: V2, heading: number, o: AheadOpts): Ahead {
  const m = o.margin ?? 1;
  const inside = (x: number, y: number) => x >= m && y >= m && x <= o.bounds[0] - m && y <= o.bounds[1] - m;
  let x = from[0];
  let y = from[1];
  let z = top(x, y);
  let dir = heading;
  let turned = 0;
  const path: V3[] = [[x, y, z]];
  const rise = o.climb * o.step;
  let reach = 0;
  const swings = Math.max(1, Math.round(Math.PI / 2 / o.fan));
  let away = 0;
  while (away < o.dist && reach < o.dist * 2) {
    let took = false;
    for (let k = 0; k <= swings && !took; k++) {
      // (the smaller swing first; on a tie, the way it has been swinging)
      const order = k === 0 ? [0] : turned >= 0 ? [k, -k] : [-k, k];
      for (const s of order) {
        const a = dir + s * o.fan;
        const nx = x + Math.cos(a) * o.step;
        const ny = y + Math.sin(a) * o.step;
        if (!inside(nx, ny)) continue;
        const nz = top(nx, ny);
        if (nz - z > rise) continue;
        // (swung past the most it may: turned back on itself)
        if (Math.abs(turned + s * o.fan) > o.maxTurn) continue;
        turned += s * o.fan;
        // (the beam drifts back toward the heading once it's round: a turn is followed, not kept)
        dir = a;
        x = nx;
        y = ny;
        z = nz;
        took = true;
        break;
      }
    }
    if (!took) break;
    reach += o.step;
    away = Math.hypot(x - from[0], y - from[1]);
    path.push([x, y, z]);
  }
  return { open: away >= o.dist - 1e-6, reach, end: [x, y, z], path, turned };
}
