// (ported from GameplayGM runtimes/hoverbike/src/levitate.ts @ experiment/slice 515fcd9, round 117: the play layer moved into Reclaimed)
// Levitation (the lich's): no cushion and no momentum to speak of. It holds a height over the
// land, looking a little ahead so it rises before a ledge reaches it, and eases there
// critically damped: no bounce, no overshoot. Slopes, walls and blows don't move it; only the
// stick does (user 2026-10-25: "part of what makes it feel powerful is how much it is immune
// to the forces of the world"). It shares the bike's body (bike.ts `Bike`) so the rest of the
// hover units' code (air, camera, model) reads it the same.

import { speedOf, type Bike, type HeightAt } from "./bike";

export interface LevitateTuning {
  /** height over the land (cells) */
  hover: number;
  /** top speed (cells/s), and how quickly it comes to the stick's speed (1/s) */
  max: number;
  accel: number;
  /** how quickly it eases to its height going up, and down (rad/s: a critically damped spring's) */
  rise: number;
  sink: number;
  /** how far round it looks for the land's highest (cells), and ahead along its way (s of travel) */
  foot: number;
  ahead: number;
  /** never nearer the ground than this (cells) */
  clear: number;
  /** what's no more than `step` cells over the land under it, it rises to as it comes; higher (a
   *  cliff), it stops at the foot and climbs at `climb` cells/s × the stick pushed at it, and only
   *  while it's pushed */
  step: number;
  climb: number;
}

export const LEVITATE: LevitateTuning = { hover: 1.6, max: 7, accel: 4, rise: 5, sink: 2.5, foot: 0.6, ahead: 0.45, clear: 0.3, step: 1.5, climb: 4 };

/** The land's highest under it, round it and a little ahead of where it's going (no more than `step` over the land right under it: a cliff's climbed, not floated up to). */
function landUnder(b: Bike, heightAt: HeightAt, t: LevitateTuning): number {
  const under = heightAt(b.x, b.y);
  let g = under;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g = Math.max(g, heightAt(b.x + Math.cos(a) * t.foot, b.y + Math.sin(a) * t.foot));
  }
  for (const k of [0.5, 1]) g = Math.max(g, heightAt(b.x + b.vx * t.ahead * k, b.y + b.vy * t.ahead * k));
  return Math.min(g, under + t.step);
}

export function stepLevitate(b: Bike, stick: [number, number], dt: number, heightAt: HeightAt, bounds: [number, number], t: LevitateTuning = LEVITATE): void {
  b.hit = 0;
  b.landed = 0;
  b.crash = 0;
  b.air = 0;
  const pvx = b.vx;
  const pvy = b.vy;
  // to the stick's velocity, smoothly
  const k = 1 - Math.exp(-t.accel * dt);
  b.vx += (stick[0] * t.max - b.vx) * k;
  b.vy += (stick[1] * t.max - b.vy) * k;
  if (Math.hypot(b.vx, b.vy) < 1e-3 && stick[0] === 0 && stick[1] === 0) b.vx = b.vy = 0;
  // up first, then over (user 2026-10-25: "at a steady pace set by the player trying to go that
  // direction"): it moves on only where the land is below it (along each axis, so it slides
  // along a cliff's foot); held back, it climbs steadily while the stick pushes on
  const below = (x: number, y: number) => heightAt(x, y) + t.clear <= b.z;
  const nx = Math.max(0.5, Math.min(bounds[0] - 0.5, b.x + b.vx * dt));
  const ny = Math.max(0.5, Math.min(bounds[1] - 0.5, b.y + b.vy * dt));
  const push = Math.min(1, Math.hypot(stick[0], stick[1]));
  const held = !below(nx, ny);
  if (!held) [b.x, b.y] = [nx, ny];
  else if (below(nx, b.y)) b.x = nx;
  else if (below(b.x, ny)) b.y = ny;
  const want = landUnder(b, heightAt, t) + t.hover;
  if (held && push > 0.1 && b.z >= want - 0.05) {
    // (climbing the cliff: steady, as hard as it's pushed)
    b.vz = t.climb * push;
    b.z += b.vz * dt;
  } else {
    // to its height, critically damped
    const w = want > b.z ? t.rise : t.sink;
    b.vz += (w * w * (want - b.z) - 2 * w * b.vz) * dt;
    b.z += b.vz * dt;
  }
  const floor = heightAt(b.x, b.y) + t.clear;
  if (b.z < floor) {
    b.z = floor;
    b.vz = Math.max(0, b.vz);
  }
  // it faces the way it drifts, leaning a little into a turn
  b.pitch = 0;
  if (speedOf(b) > 0.5) {
    const d = Math.atan2(b.vy, b.vx) - b.heading;
    b.heading += Math.atan2(Math.sin(d), Math.cos(d)) * Math.min(1, dt * 6);
  }
  const ax = (b.vx - pvx) / Math.max(dt, 1e-4);
  const ay = (b.vy - pvy) / Math.max(dt, 1e-4);
  const lateral = -ax * Math.sin(b.heading) + ay * Math.cos(b.heading);
  b.bank += (Math.max(-0.3, Math.min(0.3, lateral * 0.02)) - b.bank) * Math.min(1, dt * 6);
}
