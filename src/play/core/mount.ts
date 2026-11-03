// ---- play/core/mount.ts -----------------------------------------------------------------------------------------
// (round 128, the user) The horse's assist: "A horseback option instead of the hover bike that auto steers around
// obstacles for you and will slow down stop in the canyon or turn around the bend for you if you angle that way."
// Strong assist is the point, over the shared drive (core/drive.ts):
//   bend     the stick within `cone` of the open way (core/steer.ts corridor: the longest clear run in a fan round the
//            stick) is taken as that way: it follows the bend for you
//   round    something small dead ahead (a rock, a post) is gone round (core/steer.ts aroundSmall)
//   stop     the speed it asks for is no more than it can still brake from before the wall ahead along its way:
//            v ≤ √(2 · brake · (free − margin)) — it slows into a dead end and stops short of a wall
//   intent   a stick more than `strong` off the way it's going is the rider's own: no bend (the stop still holds,
//            so a hard steer at a wall doesn't run it in)
// Pure: a height function in, the stick out.

import type { DriveProfile } from './drive';
import type { Pt } from './gestures';
import { aroundSmall, corridor, freeRun } from './steer';

export interface MountAssist {
  /** 0..1: how hard it helps (0: the stick as it is) */
  assist: number;
  /** seconds of speed it looks ahead (at least `minLook` cells) */
  look: number;
  minLook: number;
  /** degrees: a stick this near the open way takes it */
  cone: number;
  /** degrees: a stick this far off the way it's going is the rider's own */
  strong: number;
  /** cells it stops short of a wall */
  margin: number;
  /** cells: an obstacle no wider than this either side is gone round */
  small: number;
}

export const MOUNT: MountAssist = { assist: 1, look: 1.1, minLook: 8, cone: 60, strong: 75, margin: 1.5, small: 2 };

export interface MountOut {
  dir: Pt;
  /** radians it bent the stick; the stick's length it capped to (1: no cap) */
  bend: number;
  cap: number;
}

const DEG = Math.PI / 180;
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function mountSteer(stick: Pt, at: Pt, vel: Pt, top: (x: number, y: number) => number, climb: number, drive: DriveProfile, p: MountAssist = MOUNT): MountOut {
  const m = Math.min(1, Math.hypot(stick[0], stick[1]));
  if (m < 0.05 || p.assist <= 0) return { dir: stick, bend: 0, cap: 1 };
  const sp = Math.hypot(vel[0], vel[1]);
  const want = Math.atan2(stick[1], stick[0]);
  const going = sp > 1 ? Math.atan2(vel[1], vel[0]) : want;
  const dist = Math.max(p.minLook, sp * p.look);
  let a = want;
  // (the rider's own: hauled well off the way it's going)
  const own = sp > 1 && Math.abs(angleTo(going, want)) > p.strong * DEG;
  if (!own) {
    const c = corridor(top, at, want, dist, p.cone * DEG, climb, 11);
    // (bend only where the stick's own line is blocked sooner than the open way)
    const straight = freeRun(top, at[0], at[1], want, dist, climb);
    const best = c.rays.reduce((b, r) => (r.free > b.free ? r : b), c.rays[0]);
    if (straight < dist * 0.95 && best.free > straight + 1) a = want + angleTo(want, c.way) * p.assist;
    const round = aroundSmall(top, at, a, Math.max(4, sp * 0.4), p.small, climb);
    if (round !== null) a = a + angleTo(a, round) * p.assist;
  }
  // (no faster than it can stop from before the wall along its way)
  const free = freeRun(top, at[0], at[1], a, dist + p.margin, climb);
  const vStop = Math.sqrt(2 * drive.brake * Math.max(0, free - p.margin));
  const cap = Math.min(1, vStop / Math.max(drive.vMax, 1e-3));
  const len = m * (1 - p.assist) + Math.min(m, cap) * p.assist;
  return { dir: [Math.cos(a) * len, Math.sin(a) * len], bend: angleTo(want, a), cap: len / m };
}
