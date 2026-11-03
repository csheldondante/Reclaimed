// ---- play/core/foot.ts ------------------------------------------------------------------------------------------
// (knight, round 128) On foot: the knight's drive. Ported from GameplayGM runtimes/iso-adventure src/sim/combat.ts
// steer() and src/sim/lab/momentum.ts slideMove() (the spin's slide), on Reclaimed's ground (a height lookup, not a
// tile grid). Pure: a body, a wanted velocity and the ground in, the body moved; Node-tested (foot.test.ts).
//   walk    snappy: it accelerates hard (accel) to the stick's velocity; what's over its speed (a lunge, a dodge, a
//           knock) bleeds off by friction, so a lunge carries a little way and stops — iso-adventure's feel
//   ground  it stands on the floor under it; steps up what's no more than `step` cells over where it is; steeper
//           than `slope` (rise over run) is a wall — walking, it slides along it; sliding, it bounces off; uphill
//           slows it, downhill a little faster; off a drop it falls (gravity) and lands
//   slide   (the spin) drag and deceleration, no steering by default, walls and bodies bounced off (the hero
//           caroms off the units itself: it knows them)

import type { Pt } from './gestures';

export type HeightAt = (x: number, y: number) => number;

export interface FootTuning {
  /** cells/s: its run at full stick */
  speed: number;
  /** cells/s²: how hard it comes to the stick's velocity */
  accel: number;
  /** 1/s: excess speed bled per second (× speed): iso-adventure's FRICTION × 0.6 */
  friction: number;
  /** cells: the tallest step it takes in its stride */
  step: number;
  /** rise over run: the steepest it walks up */
  slope: number;
  /** cells/s²: falling */
  gravity: number;
  /** water deeper than this (cells) it won't wade into; wading slows it to `wadeMul` */
  wade: number;
  wadeMul: number;
}

/** The knight's own numbers are controllers/knight.ts KNIGHT_DEFAULTS; these are the core's for tests. */
export const FOOT: FootTuning = { speed: 9, accel: 70, friction: 8.4, step: 0.9, slope: 1.2, gravity: 30, wade: 1.2, wadeMul: 0.6 };

/** A slide's profile (iso-adventure momentum.ts SlideProfile, the parts the spin uses). */
export interface SlideTuning {
  /** 1/s exponential drag, cells/s² linear deceleration */
  drag: number;
  decel: number;
  /** speed kept off a wall or a body */
  restitution: number;
  /** stick push (cells/s²) and the speed it can push to */
  steer: number;
  max: number;
}

export interface Foot {
  x: number;
  y: number;
  /** its feet's height (cells) */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** the way it faces (radians) */
  heading: number;
  /** seconds off the ground (0: on it) */
  air: number;
  /** this step: it ran into a wall (the face's outward normal), and how hard it landed (cells/s down) */
  wall: Pt | null;
  landed: number;
}

export function makeFoot(x: number, y: number, floor: HeightAt): Foot {
  return { x, y, z: floor(x, y), vx: 0, vy: 0, vz: 0, heading: Math.PI / 2, air: 0, wall: null, landed: 0 };
}

export const speedOf = (f: Foot): number => Math.hypot(f.vx, f.vy);

/** cells ahead a slope is measured over */
const PROBE = 1.5;

/** What it can stand on at (x, y) from its feet at z: the floor there, or null (a wall: too high a step, or deep water). */
function footing(f: Foot, x: number, y: number, floor: HeightAt, depth: HeightAt | null, t: FootTuning): number | null {
  const g = floor(x, y);
  if (depth && depth(x, y) > t.wade) return null;
  // (a sheer step taller than its stride takes)
  if (g - f.z > t.step) return null;
  // (a face steeper than it walks and taller than a step, measured over PROBE cells ahead: a kerb is stepped up, a
  // hillside too steep is a wall — but only once it starts up it)
  const run = Math.hypot(x - f.x, y - f.y);
  if (run > 1e-6 && g > f.z + 0.02) {
    const far = floor(f.x + ((x - f.x) / run) * PROBE, f.y + ((y - f.y) / run) * PROBE) - floor(f.x, f.y);
    if (far > t.step && far / PROBE > t.slope) return null;
  }
  return g;
}

/**
 * One step on foot. `want`: the velocity it's after (the stick × its speed × what its action allows); `slide`: the
 * spin's profile instead of walking (then `want` is only the stick, steering it by slide.steer). `depth`: water
 * standing (null: none).
 */
export function stepFoot(f: Foot, want: Pt, dt: number, floor: HeightAt, depth: HeightAt | null, bounds: [number, number], t: FootTuning = FOOT, slide: SlideTuning | null = null): void {
  f.wall = null;
  f.landed = 0;
  const wading = depth ? depth(f.x, f.y) > 0.4 : false;
  if (slide) {
    let sp = speedOf(f);
    const k = Math.exp(-slide.drag * dt);
    const after = Math.max(0, sp * k - slide.decel * dt);
    if (sp > 0) {
      f.vx *= after / sp;
      f.vy *= after / sp;
    }
    sp = after;
    const sl = Math.hypot(want[0], want[1]);
    if (slide.steer > 0 && sl > 0.1) {
      f.vx += (want[0] / Math.max(1, sl)) * slide.steer * dt;
      f.vy += (want[1] / Math.max(1, sl)) * slide.steer * dt;
      const now = speedOf(f);
      const cap = Math.max(sp, slide.max);
      if (now > cap) {
        f.vx *= cap / now;
        f.vy *= cap / now;
      }
    }
  } else if (f.air === 0) {
    // (snappy: hard toward the wanted velocity; over its speed — a lunge, a dodge, a knock — bleeds off by friction)
    const mul = wading ? t.wadeMul : 1;
    const tx = want[0] * mul;
    const ty = want[1] * mul;
    const dvx = tx - f.vx;
    const dvy = ty - f.vy;
    const dv = Math.hypot(dvx, dvy);
    const maxDv = (speedOf(f) > t.speed * 1.05 ? t.friction * Math.max(t.speed, 1) : t.accel) * dt;
    if (dv <= maxDv) {
      f.vx = tx;
      f.vy = ty;
    } else {
      f.vx += (dvx / dv) * maxDv;
      f.vy += (dvy / dv) * maxDv;
    }
  }
  // over the ground, in short steps (a fast slide mustn't pass through a wall), each axis on its own so it slides along
  const sp = speedOf(f);
  const steps = Math.max(1, Math.ceil((sp * dt) / 0.25));
  for (let s = 0; s < steps; s++) {
    // uphill slows the walk, downhill a little faster (a slide keeps its speed: it's a top, not a walker)
    let k = 1;
    if (!slide && f.air === 0 && sp > 0.1) {
      const ahead = floor(f.x + (f.vx / sp) * 0.5, f.y + (f.vy / sp) * 0.5) - f.z;
      k = Math.max(0.45, Math.min(1.15, 1 - ahead * 0.6));
    }
    const nx = Math.max(0.5, Math.min(bounds[0] - 0.5, f.x + (f.vx * k * dt) / steps));
    const ny = Math.max(0.5, Math.min(bounds[1] - 0.5, f.y + (f.vy * k * dt) / steps));
    const up = (x: number, y: number) => (f.air > 0 ? (floor(x, y) <= f.z + t.step ? floor(x, y) : null) : footing(f, x, y, floor, depth, t));
    if (up(nx, f.y) !== null) f.x = nx;
    else bump(f, 'x', slide);
    if (up(f.x, ny) !== null) f.y = ny;
    else bump(f, 'y', slide);
  }
  // on the ground, or falling to it
  const g = floor(f.x, f.y);
  if (f.air === 0 && g < f.z - Math.max(0.35, t.step * 0.5) && f.vz <= 0) f.air = 1e-3;
  if (f.air > 0) {
    f.air += dt;
    f.vz -= t.gravity * dt;
    f.z += f.vz * dt;
    if (f.z <= g) {
      f.landed = -f.vz;
      f.z = g;
      f.vz = 0;
      f.air = 0;
    }
  } else {
    // (stepping up and down: eased, not snapped — a kerb is a step, not a teleport)
    f.z += (g - f.z) * Math.min(1, dt * 20);
    if (Math.abs(g - f.z) < 0.02) f.z = g;
    f.vz = 0;
  }
}

/** a wall along an axis: walking, it stops on that axis (slides along); sliding, it bounces off */
function bump(f: Foot, axis: 'x' | 'y', slide: SlideTuning | null): void {
  const v = axis === 'x' ? f.vx : f.vy;
  f.wall = axis === 'x' ? [-Math.sign(v) || 0, f.wall?.[1] ?? 0] : [f.wall?.[0] ?? 0, -Math.sign(v) || 0];
  const kept = slide ? -v * slide.restitution : 0;
  if (axis === 'x') f.vx = kept;
  else f.vy = kept;
}

/**
 * A body met while sliding: carom off it (iso-adventure momentum.ts contacts, 'bounce'): closing on it, the velocity
 * along the line of centres is reflected with `restitution` and it's set back to touching. True if it bounced.
 */
export function carom(f: Foot, at: Pt, touch: number, restitution: number): boolean {
  const dx = f.x - at[0];
  const dy = f.y - at[1];
  const d = Math.hypot(dx, dy);
  if (d >= touch) return false;
  const nx = d > 1e-6 ? dx / d : -Math.cos(f.heading);
  const ny = d > 1e-6 ? dy / d : -Math.sin(f.heading);
  const vn = f.vx * nx + f.vy * ny;
  if (vn >= 0) return false;
  f.vx -= (1 + restitution) * vn * nx;
  f.vy -= (1 + restitution) * vn * ny;
  f.x = at[0] + nx * touch;
  f.y = at[1] + ny * touch;
  return true;
}
