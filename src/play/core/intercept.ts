// (ported from GameplayGM runtimes/hoverbike/src/intercept.ts @ experiment/slice 515fcd9, round 117: the play layer moved into Reclaimed)
// Intent → plan, for a pass-by strike (the bike's slash; later the knight's lunge): the player
// says only which side, and this works out whether, when and how a blow can land as the
// rider passes something, within an assistance budget. It predicts the rider (ballistic in
// the air) and each target over a short window, finds when each passes alongside, and asks
// what it would take to reach it then: a little steering sideways, a little lift or drop in
// the air, a longer reach, the blade angled down. The most satisfying plan within the budget
// wins; nothing within it means a miss (and why, for the debug overlay). The plan only aims
// the swing: whether it connects is the blade's real geometry, checked as it happens.
// Pure: positions and velocities in, a plan out.

import type { Planner } from "./intent";

type V3 = [number, number, number];

export interface Rider {
  /** where it is (its base), its velocity (cells/s), its forward way when slow */
  at: V3;
  vel: V3;
  heading: number;
  /** the hand's height over its base (cells) */
  hand: number;
  /** in the air, it falls at this (cells/s²); 0 on the ground */
  gravity: number;
}

export interface PassTarget {
  id: number;
  /** its feet, its velocity, how tall and wide (cells) */
  at: V3;
  vel: V3;
  height: number;
  radius: number;
}

/** What the planner may do, per setting (strict, moderate, forgiving). */
export interface PassBudget {
  /** how far ahead it may wait for the pass (s) */
  window: number;
  /** the blade's reach from the hand, and how far it may stretch (cells) */
  reach: number;
  reachMax: number;
  /** how far before or after the pass the blow still lands (cells along the way) */
  along: number;
  /** the sideways speed it may add to bring the rider alongside (cells/s), and up/down in the air */
  steer: number;
  lift: number;
  /** how far below the hand and above it the blade can angle to (cells) */
  below: number;
  above: number;
}

export const ASSIST: Record<"strict" | "moderate" | "forgiving", PassBudget> = {
  strict: { window: 0.35, reach: 2.2, reachMax: 2.4, along: 0.6, steer: 0.8, lift: 0, below: 1.2, above: 0.4 },
  moderate: { window: 0.6, reach: 2.2, reachMax: 2.9, along: 0.9, steer: 2.5, lift: 1.5, below: 2.2, above: 0.6 },
  forgiving: { window: 0.9, reach: 2.4, reachMax: 3.4, along: 1.3, steer: 4.5, lift: 3, below: 3.2, above: 1 },
};

export interface PassPlan {
  id: number;
  /** seconds until the blow */
  t: number;
  /** where the blow lands (the target's middle then) */
  at: V3;
  /** the sideways velocity to add (world xy, spread until the blow), and vertical (in the air) */
  steer: [number, number];
  lift: number;
  /** the blade's way (world radians), angle below level (radians), and reach (cells) */
  yaw: number;
  pitch: number;
  reach: number;
  /** how much of the budget it took (0: none, 1: all of it) */
  assist: number;
}

/** Why there's no plan (the nearest miss), for the debug overlay. */
export type PassMiss = "nothing that side" | "not passing in time" | "too far" | "too high" | "too low";

/** The plan for a blow on `side` (+1 left, −1 right of the way it's going), or why there's none. */
export function planPass(r: Rider, side: 1 | -1, targets: PassTarget[], b: PassBudget): { plan: PassPlan | null; miss: PassMiss | null } {
  const sp = Math.hypot(r.vel[0], r.vel[1]);
  const f: [number, number] = sp > 1 ? [r.vel[0] / sp, r.vel[1] / sp] : [Math.cos(r.heading), Math.sin(r.heading)];
  // (left of the way it's going: +side)
  const s: [number, number] = [-f[1] * side, f[0] * side];
  const STEPS = 30;
  let best: PassPlan | null = null;
  let miss: PassMiss = "nothing that side";
  const rank: Record<PassMiss, number> = { "nothing that side": 0, "not passing in time": 1, "too far": 2, "too high": 3, "too low": 3 };
  const note = (m: PassMiss) => {
    if (rank[m] >= rank[miss]) miss = m;
  };
  for (const tg of targets) {
    // when it passes alongside: the time in the window it's least far ahead or behind
    let tBest = 0;
    let aBest = Infinity;
    for (let i = 0; i <= STEPS; i++) {
      const t = (b.window * i) / STEPS;
      const rel = relAt(r, tg, t);
      const along = Math.abs(rel[0] * f[0] + rel[1] * f[1]);
      if (along < aBest) [aBest, tBest] = [along, t];
    }
    const rel = relAt(r, tg, tBest);
    const lateral = rel[0] * s[0] + rel[1] * s[1];
    if (lateral < -tg.radius) continue;
    if (aBest > b.along + tg.radius) {
      note("not passing in time");
      continue;
    }
    // sideways: within reach, or steered toward it within the budget by then
    const flat = Math.max(0, lateral - tg.radius);
    const short = Math.max(0, flat - b.reach);
    const steer = tBest > 0 ? short / tBest : short > 0 ? Infinity : 0;
    if (steer > b.steer && flat > b.reachMax) {
      note("too far");
      continue;
    }
    const sideways = Math.min(steer, b.steer);
    const flatThen = Math.max(0.3, flat - sideways * tBest);
    // up and down: the blade angles to it; in the air the rider may sink or rise a little
    let dz = rel[2];
    const lift = tBest > 0 ? Math.max(-b.lift, Math.min(b.lift, (dz + (dz < 0 ? b.below * 0.5 : 0)) / tBest)) * (r.gravity > 0 ? 1 : 0) : 0;
    dz -= lift * tBest;
    if (dz < -b.below) {
      note("too low");
      continue;
    }
    if (dz > b.above) {
      note("too high");
      continue;
    }
    const reach = Math.hypot(flatThen, dz);
    if (reach > b.reachMax) {
      note("too far");
      continue;
    }
    const assist = Math.max(sideways / Math.max(b.steer, 1e-6), Math.abs(lift) / Math.max(b.lift, 1e-6), Math.max(0, reach - b.reach) / Math.max(b.reachMax - b.reach, 1e-6));
    const at: V3 = [tg.at[0] + tg.vel[0] * tBest, tg.at[1] + tg.vel[1] * tBest, tg.at[2] + tg.vel[2] * tBest + tg.height * 0.5];
    const plan: PassPlan = {
      id: tg.id,
      t: tBest,
      at,
      steer: [s[0] * sideways, s[1] * sideways],
      lift,
      yaw: Math.atan2(s[1], s[0]),
      pitch: Math.atan2(-dz, flatThen),
      reach: Math.max(b.reach, reach),
      assist,
    };
    // the least help, then the soonest
    if (!best || plan.assist < best.assist - 0.05 || (Math.abs(plan.assist - best.assist) <= 0.05 && plan.t < best.t)) best = plan;
  }
  return best ? { plan: best, miss: null } : { plan: null, miss };
}

/** Where the target's middle is from the rider's hand at time t (rider ballistic if in the air). */
function relAt(r: Rider, tg: PassTarget, t: number): V3 {
  const rz = r.at[2] + r.hand + r.vel[2] * t - 0.5 * r.gravity * t * t;
  return [tg.at[0] + tg.vel[0] * t - (r.at[0] + r.vel[0] * t), tg.at[1] + tg.vel[1] * t - (r.at[1] + r.vel[1] * t), tg.at[2] + tg.vel[2] * t + tg.height * 0.5 - rz];
}

/** The nearest distance from point p to the segment a–b. */
export function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
  return Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]);
}

/** The slash on the generic intent layer (intent.ts): "strike on this side" → planPass. */
export type PassIntent = { kind: "strike-side"; side: 1 | -1 };
export interface PassScene {
  rider: Rider;
  targets: PassTarget[];
}
export const passPlanner: Planner<PassIntent, PassScene, PassBudget, PassPlan, PassMiss> = {
  name: "pass",
  plan(intent, s, b) {
    const r = planPass(s.rider, intent.side, s.targets, b);
    return r.plan ? { plan: r.plan, assist: r.plan.assist, miss: null } : { plan: null, assist: 0, miss: r.miss! };
  },
};
