// ---- play/core/steer.ts -----------------------------------------------------------------------------------------
// (round 120, the user on the hero lab: "the bike is so fast and bad at turning it just doesn't work well with places
// that require precise turning like the canyon. I wonder if there is some way to use steering assist and flow fields to
// make the bike better to control in such areas or just bump it's turning acceleration. I believe a variant of it at
// some point used minor steering assist to hit enemies and avoid small obstacles that will arrest momentum.")
//
// Steering assist for a fast vehicle, three helpers over the stick, the player first:
// - the corridor: the open way read off the ground ahead (a fan of rays, each walked until the rise is a wall: the
//   distance to the walls round the way it's going — a flow field sampled where it's needed, not stored); in a narrow
//   place the stick is bent toward the longest clear run;
// - avoidance: something small dead ahead that would stop it (a rock, a post: the centre ray blocked near, rays a
//   little either side clear well past it) — the stick nudged to the clear side;
// - magnetism: a target in a cone ahead (core/aim.ts assist, the weapons' own) — the stick leaned toward it.
// The rule (the coordinator, the user's intent): the player's intent overrides. The assist only fills in when the
// input is light — the stick roughly along the way it's going; a stick hauled off that line by `strong` degrees or
// more turns the assist off on that frame, at once. Pure: a height function in.

import type { Pt } from './gestures';
import { assist as aimAt, lean } from './aim';

export interface SteerParams {
  /** 0..1: how far toward the open way the stick is bent in a narrow place (0: off) */
  corridor: number;
  /** seconds of speed the corridor is read ahead (at least 6 cells) */
  look: number;
  /** degrees either side the corridor's rays fan */
  fan: number;
  /** 0..1: how far round a small obstacle the stick is nudged (0: off) */
  avoid: number;
  /** seconds of speed ahead an obstacle is looked for */
  avoidLook: number;
  /** cells: an obstacle no wider than this either side is small (it's gone round, not followed) */
  small: number;
  /** 0..1: how far toward a target the stick leans (0: off) */
  magnet: number;
  /** degrees either side a target is looked for, and how far (cells) */
  magnetCone: number;
  magnetRange: number;
  /** degrees: a stick this far off the way it's going is a strong steer — the assist lets go at once */
  strong: number;
  /** degrees the assist bends the stick at most */
  maxBend: number;
}

export const STEER_OFF: SteerParams = { corridor: 0, look: 0.6, fan: 50, avoid: 0, avoidLook: 0.35, small: 2.5, magnet: 0, magnetCone: 25, magnetRange: 14, strong: 35, maxBend: 40 };

const DEG = Math.PI / 180;
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** cells along `a` from (x, y) before the ground rises more than `climb` a cell (a wall), out to `max` */
export function freeRun(top: (x: number, y: number) => number, x: number, y: number, a: number, max: number, climb: number, step = 0.5): number {
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  let z = top(x, y);
  for (let t = step; t <= max; t += step) {
    const nz = top(x + ux * t, y + uy * t);
    if (nz - z > climb * step) return t - step;
    z = nz;
  }
  return max;
}

export interface Corridor {
  /** the open way (radians) and how narrow it is here, 0 (open) .. 1 (walls close either side) */
  way: number;
  narrow: number;
  /** each ray's angle and clear run */
  rays: { a: number; free: number }[];
}

/** The corridor ahead: a fan of rays round the heading, the longest clear one (a little favouring straight on). */
export function corridor(top: (x: number, y: number) => number, at: Pt, heading: number, dist: number, fan: number, climb: number, n = 9): Corridor {
  const rays: { a: number; free: number }[] = [];
  let best = heading;
  let bestScore = -Infinity;
  for (let k = 0; k < n; k++) {
    const a = heading + (k / (n - 1) - 0.5) * 2 * fan;
    const free = freeRun(top, at[0], at[1], a, dist, climb);
    rays.push({ a, free });
    const score = free / dist - 0.15 * Math.abs(angleTo(heading, a)) / Math.max(fan, 1e-6);
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  // (narrow: how close the walls stand off either side of the way it's going, against the reach)
  const side = (s: number) => freeRun(top, at[0], at[1], heading + (s * Math.PI) / 2, dist, climb);
  const narrow = 1 - Math.min(1, Math.min(side(1), side(-1)) / (dist * 0.5));
  return { way: best, narrow, rays };
}

/** A small obstacle dead ahead (the centre blocked within `near`, rays either side clear past it): the way round, or null. */
export function aroundSmall(top: (x: number, y: number) => number, at: Pt, heading: number, near: number, small: number, climb: number): number | null {
  const ahead = freeRun(top, at[0], at[1], heading, near, climb);
  if (ahead >= near) return null;
  // (the angle that clears `small` cells of half-width at the obstacle's distance)
  const off = Math.atan2(small, Math.max(ahead, 0.5));
  const past = Math.min(near * 2, ahead + small * 2);
  const l = freeRun(top, at[0], at[1], heading + off, past + 1, climb);
  const r = freeRun(top, at[0], at[1], heading - off, past + 1, climb);
  // (both sides blocked too: a wall, not a rock — the corridor's business)
  if (l < past && r < past) return null;
  return l >= r ? heading + off : heading - off;
}

export interface SteerOut {
  /** the stick after the assist */
  dir: Pt;
  /** radians it was bent (signed) */
  bend: number;
  /** which helper bent it */
  by: 'corridor' | 'avoid' | 'magnet' | null;
  /** the assist wanted to bend it (> 10°) but the player's strong steer held it off */
  fought: boolean;
}

/**
 * The stick with the assist filled in. `vel` the vehicle's velocity (cells/s); `targets` foes' feet (for magnetism);
 * `climb` the rise over run it rides.
 */
export function steerAssist(stick: Pt, at: Pt, vel: Pt, top: (x: number, y: number) => number, targets: Pt[], climb: number, p: SteerParams): SteerOut {
  const m = Math.hypot(stick[0], stick[1]);
  const sp = Math.hypot(vel[0], vel[1]);
  const none: SteerOut = { dir: stick, bend: 0, by: null, fought: false };
  if (m < 0.15 || sp < 2) return none;
  const heading = Math.atan2(vel[1], vel[0]);
  const sa = Math.atan2(stick[1], stick[0]);
  // (how hard the player steers: the stick's angle off the way it's going)
  const off = Math.abs(angleTo(heading, sa));
  const gate = 1 - sstep(p.strong * 0.6 * DEG, p.strong * DEG, off);
  // the helpers, most urgent first
  let want: number | null = null;
  let k = 0;
  let by: SteerOut['by'] = null;
  if (p.avoid > 0) {
    const a = aroundSmall(top, at, heading, Math.max(2, sp * p.avoidLook), p.small, climb);
    if (a !== null) {
      want = a;
      k = p.avoid;
      by = 'avoid';
    }
  }
  if (want === null && p.magnet > 0 && targets.length) {
    const t = aimAt(at, [Math.cos(sa), Math.sin(sa)], targets, p.magnetCone * DEG, p.magnetRange);
    if (t) {
      want = Math.atan2(t.dir[1], t.dir[0]);
      k = p.magnet;
      by = 'magnet';
    }
  }
  if (want === null && p.corridor > 0) {
    const c = corridor(top, at, heading, Math.max(6, sp * p.look), p.fan * DEG, climb);
    if (c.narrow > 0.2) {
      want = c.way;
      k = p.corridor * sstep(0.2, 0.7, c.narrow);
      by = 'corridor';
    }
  }
  if (want === null) return none;
  const d = angleTo(sa, want);
  const max = p.maxBend * DEG;
  const bend = Math.max(-max, Math.min(max, d * k)) * gate;
  const fought = Math.abs(d * k) > 10 * DEG && gate < 0.5;
  if (Math.abs(bend) < 1e-6) return { ...none, fought, by: fought ? by : null };
  const [dx, dy] = lean([Math.cos(sa), Math.sin(sa)], [Math.cos(sa + bend), Math.sin(sa + bend)], 1);
  return { dir: [dx * m, dy * m], bend, by, fought };
}
