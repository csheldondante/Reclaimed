// (ported from GameplayGM runtimes/hoverbike/src/fling.ts @ experiment/slice 515fcd9, round 117)
// Intent → plan for a fling (the lich's telekinesis, the gorilla's hurl: "throw this that way"),
// on the generic layer (intent.ts). The gesture gives the thing and a 2D way, never the launch's
// height. The planner (the spec's "Telekinetic fling: intent vs physical trajectory"):
//   - a target along the way, inside the budget's cone and range, bends the throw onto it (a lob
//     that comes down on it; for an enemy thrown, Reclaimed works out the lob itself);
//   - with none, the throw keeps the player's way, and rises enough to clear the ground ahead
//     where it climbs (an uphill throw tumbles on up the slope instead of into the hillside);
//   - it releases the thing into the physics either way: whether it meets anything is the sim's.
// A plain throw (no target) is a plan too, not a miss: the player meant that way.

import type { Candidate, Planned, Planner, V2, V3 } from "./intent";

export interface FlingBudget {
  /** share of the throw's own cone and range (ThrowSpec) the assist may use */
  cone: number;
  range: number;
}

export const FLING_ASSIST: Record<"strict" | "moderate" | "forgiving", FlingBudget> = {
  strict: { cone: 0.6, range: 0.8 },
  moderate: { cone: 1, range: 1 },
  forgiving: { cone: 1.4, range: 1.25 },
};

export interface FlingScene {
  /** where the thing is now */
  from: V3;
  /** the throw's speed (cells/s), its cone either side (radians) and range (cells), the rise when aimed at nothing (cells/s) */
  speed: number;
  cone: number;
  range: number;
  up: number;
  /** what it's thrown at falls at this (cells/s²) */
  gravity: number;
  targets: Candidate[];
  /** the ground's height (for the clearance of a plain throw) */
  heightAt: (x: number, y: number) => number;
}

export interface FlingPlan {
  /** the target it's bent onto (null: a plain throw that way) */
  target: number | null;
  /** where it's meant to come down (the target's middle; for a plain throw, `range` along the way) */
  to: V3;
  /** the velocity it's let go at */
  vel: V3;
}

export type FlingIntent = { kind: "fling"; thing: number; dir: V2; power: number };

export const flingPlanner: Planner<FlingIntent, FlingScene, FlingBudget, FlingPlan, never> = {
  name: "fling",
  plan(intent, s, b): Planned<FlingPlan, never> {
    const l = Math.hypot(intent.dir[0], intent.dir[1]) || 1;
    const f: V2 = [intent.dir[0] / l, intent.dir[1] / l];
    const cone = s.cone * b.cone;
    const range = s.range * b.range;
    // the target nearest the line (angle counts most, distance a little: aim.ts's rule)
    let best: { c: Candidate; d: number; off: number; score: number } | null = null;
    for (const c of s.targets) {
      const dx = c.at[0] - s.from[0];
      const dy = c.at[1] - s.from[1];
      const d = Math.hypot(dx, dy);
      if (d < 1e-3 || d > range) continue;
      const off = Math.acos(Math.max(-1, Math.min(1, (dx * f[0] + dy * f[1]) / d)));
      if (off > cone) continue;
      const score = off / Math.max(cone, 1e-6) + (d / range) * 0.3;
      if (!best || score < best.score) best = { c, d, off, score };
    }
    if (best) {
      const { c, d, off } = best;
      const to: V3 = [c.at[0], c.at[1], c.at[2] + c.height * 0.5];
      const time = d / s.speed;
      const vz = Math.max(-4, Math.min(12, (s.gravity * time) / 2 - (s.from[2] - to[2]) / Math.max(time, 0.05)));
      const w: V2 = [(to[0] - s.from[0]) / d, (to[1] - s.from[1]) / d];
      return { plan: { target: c.id, to, vel: [w[0] * s.speed, w[1] * s.speed, vz] }, assist: off / Math.max(cone, 1e-6), miss: null };
    }
    // no target: the player's way, lifted over the ground where it climbs within the first part of the flight
    let vz = s.up;
    const base = s.heightAt(s.from[0], s.from[1]);
    for (let k = 1; k <= 8; k++) {
      const dist = (range * 0.6 * k) / 8;
      const t = dist / s.speed;
      const rise = s.heightAt(s.from[0] + f[0] * dist, s.from[1] + f[1] * dist);
      // (only where the ground climbs: over flat or falling ground a throw comes down as thrown)
      if (rise <= base + 0.5) continue;
      const ground = rise + 0.6;
      // (the rise that has it over that ground then: z0 + vz t − g t²/2 ≥ ground)
      vz = Math.max(vz, (ground - s.from[2] + 0.5 * s.gravity * t * t) / t);
    }
    vz = Math.min(vz, 18);
    const to: V3 = [s.from[0] + f[0] * range, s.from[1] + f[1] * range, s.heightAt(s.from[0] + f[0] * range, s.from[1] + f[1] * range)];
    return { plan: { target: null, to, vel: [f[0] * s.speed, f[1] * s.speed, vz] }, assist: 0, miss: null };
  },
};
