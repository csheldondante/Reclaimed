// (ported from GameplayGM runtimes/hoverbike/src/aim.ts @ experiment/slice 515fcd9, round 117: the play layer moved into Reclaimed)
// Aim assist: of the targets ahead, the one an aim most likely means. Pure.

import type { Pt } from "./gestures";

export interface Assisted {
  /** the way to it (unit) and how far */
  dir: Pt;
  d: number;
  /** the target's index in the list */
  i: number;
}

/**
 * The target within `cone` radians either side of `dir` from `from`, and within `range`,
 * nearest the line (angle off counts most; distance a little, so the near one of two in
 * line wins). Null if none.
 */
export function assist(from: Pt, dir: Pt, targets: Pt[], cone: number, range: number): Assisted | null {
  let best: Assisted | null = null;
  let bestScore = Infinity;
  const l = Math.hypot(dir[0], dir[1]) || 1;
  const [ux, uy] = [dir[0] / l, dir[1] / l];
  targets.forEach((p, i) => {
    const dx = p[0] - from[0];
    const dy = p[1] - from[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-3 || d > range) return;
    const off = Math.acos(Math.max(-1, Math.min(1, (dx * ux + dy * uy) / d)));
    if (off > cone) return;
    const score = off / cone + (d / range) * 0.3;
    if (score < bestScore) {
      bestScore = score;
      best = { dir: [dx / d, dy / d], d, i };
    }
  });
  return best;
}

/**
 * (knight, round 128) A swipe's way, leaned slightly toward the enemy it most likely means: the target `assist` picks
 * within `cone` and `range`, turned toward by `k` of the angle off (the user: "lunged in the direction you swipe for
 * slashes and aimed slightly towards enemies"). Nothing in the cone: the swipe's way as it was. Unit `dir` in and out.
 */
export function leanAim(from: Pt, dir: Pt, targets: Pt[], cone: number, range: number, k: number): { dir: Pt; i: number | null } {
  const a = assist(from, dir, targets, cone, range);
  if (!a) {
    const l = Math.hypot(dir[0], dir[1]) || 1;
    return { dir: [dir[0] / l, dir[1] / l], i: null };
  }
  return { dir: lean(dir, a.dir, k), i: a.i };
}

/** Turn `dir` toward `to` by at most `k` (0..1) of the angle between them. */
export function lean(dir: Pt, to: Pt, k: number): Pt {
  const a = Math.atan2(dir[1], dir[0]);
  const b = Math.atan2(to[1], to[0]);
  const c = a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
  return [Math.cos(c), Math.sin(c)];
}
