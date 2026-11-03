// ---- play/core/slip.ts ------------------------------------------------------------------------------------------
// (knight pass 2, round 128) A slash's lunge through a crowd. The user (round 128): "the sword is ok but I think we want
// the default lunge to be further. In a crowd we want to be able to use the lunge to move our way through the crowd."
//
// How a lunge gets through (DEVLOG round 128, knight pass 2): every slash is a DASH of a set distance (not an impulse
// that friction eats in a few frames), and three things keep the knight from stopping on the first body:
//   1. the knight's body never collides with the units (it never did: units steer round each other on the GPU, the
//      hero is a target, not an obstacle) — so nothing physical stops it;
//   2. the blade knocks what it hits ASIDE, out of the dash's line (`aside`), not straight ahead along it — a body
//      knocked ahead would be met again and pushed like a plough;
//   3. the dash slips: it turns a little toward the side of its line with more room (`slip`), and if it would end
//      inside a body it carries on past it (up to `extend` cells), so the knight comes out between bodies, not in one.
// Pure, Node-tested (slip.test.ts).

import type { Pt } from './gestures';

export interface SlipTuning {
  /** the knight's body radius plus a unit's (cells): what counts as in the way */
  touch: number;
  /** the most the dash turns to slip between bodies (radians) */
  maxTurn: number;
  /** how far past a body it may carry on to not end inside it (cells) */
  extend: number;
}

export const SLIP: SlipTuning = { touch: 0.85, maxTurn: (14 * Math.PI) / 180, extend: 1.2 };

/** the side of the line from `from` along unit `d` a point is on (+1 left, -1 right) and how far off it, how far along */
function across(from: Pt, d: Pt, p: Pt): { along: number; off: number } {
  const dx = p[0] - from[0];
  const dy = p[1] - from[1];
  return { along: dx * d[0] + dy * d[1], off: -dx * d[1] + dy * d[0] };
}

/**
 * The dash's way and length through the bodies at `bodies`: from `from` along unit `dir` for `dist` cells. Turns by up
 * to `maxTurn` toward the side of the line the bodies in the way leave more room on (each body in the corridor pushes
 * the dash away from its side, nearer ones more); then, if the end lands within `touch` of a body, it's carried on past
 * it (at most `extend`). Nothing in the way: the dash as given.
 */
export function slip(from: Pt, dir: Pt, dist: number, bodies: readonly Pt[], t: SlipTuning = SLIP): { dir: Pt; dist: number } {
  let push = 0;
  for (const b of bodies) {
    const { along, off } = across(from, dir, b);
    if (along < -0.2 || along > dist + t.touch || Math.abs(off) >= t.touch * 1.6) continue;
    // (a body on the left pushes the dash right; dead ahead it counts on whichever side it leans, by how near the line)
    const side = off >= 0 ? 1 : -1;
    push -= side * (1 - Math.abs(off) / (t.touch * 1.6)) * (1 - Math.max(0, along) / (dist + t.touch + 1e-3) * 0.5);
  }
  let d = dir;
  if (push !== 0) {
    const turn = Math.max(-t.maxTurn, Math.min(t.maxTurn, push * t.maxTurn));
    const a = Math.atan2(dir[1], dir[0]) + turn;
    d = [Math.cos(a), Math.sin(a)];
  }
  // (ending inside a body: carried on past it, the furthest one it would end in, as far as `extend` allows)
  let len = dist;
  for (let k = 0; k < 4; k++) {
    const end: Pt = [from[0] + d[0] * len, from[1] + d[1] * len];
    let need = 0;
    for (const b of bodies) {
      const g = Math.hypot(b[0] - end[0], b[1] - end[1]);
      if (g >= t.touch) continue;
      const { along, off } = across(from, d, b);
      // (past it along the line: where the line leaves the body's touch circle)
      const out = along + Math.sqrt(Math.max(0, t.touch * t.touch - off * off));
      need = Math.max(need, out - len);
    }
    if (need <= 0) break;
    len = Math.min(dist + t.extend, len + need + 0.05);
    if (len >= dist + t.extend) break;
  }
  return { dir: d, dist: len };
}

/**
 * The way a blow knocks a body at unit offset `n` (from the knight to it) when the knight dashes along unit `d`: mostly
 * aside, out of the dash's line, with some of it forward — so the knight's way opens instead of the body being driven
 * on ahead of it. `forward` is the share kept along the dash.
 */
export function aside(n: Pt, d: Pt, forward = 0.45): Pt {
  const along = n[0] * d[0] + n[1] * d[1];
  let sx = n[0] - along * d[0];
  let sy = n[1] - along * d[1];
  let l = Math.hypot(sx, sy);
  if (l < 0.15) {
    // (dead ahead: knocked to its left, a fixed side, so a string of them doesn't scatter both ways into the path)
    sx = -d[1];
    sy = d[0];
    l = 1;
  }
  const x = sx / l + d[0] * forward;
  const y = sy / l + d[1] * forward;
  const m = Math.hypot(x, y);
  return [x / m, y / m];
}
