// ---- runplay/riders.ts ------------------------------------------------------------------------------------------
// (round 119, `runplay`) The riders a stage puts against the hero: rivals racing the course's gates and a quarry
// fleeing a chase — play's own bike drive (play/core/bike.ts, the hero's; the sandbox's Rival rides it too) under an
// autopilot. Why the same drive: a rival takes the same crests and slides the same way the player does, and tuning
// the bike in the sandbox tunes them with it. They can't boost: a clean ride beats them. They're vehicles in play
// (PlayWorld.vehicles), so the hero's hook pulls up alongside them. Pure (no DOM, no GPU): Node tests ride them.

import { makeBike, speedOf, stepBike, type Bike, type BikeTuning } from '../play/core/bike';
import { attitude, buildBike, type Part } from '../play/draw/shapes';
import type { Vehicle } from '../play/world';
import { MAT } from '../world/materials';
import type { P2 } from './course';

/** a gate's reach (cells): within this of its middle, it's passed */
export const GATE_R = 6;

type Height = (x: number, y: number) => number;

/** the velocity it wants as the stick pushed at the difference — as a rider steers (the drive keeps momentum) */
function steer(b: Bike, want: P2): [number, number] {
  const err = [want[0] - b.vx, want[1] - b.vy];
  const e = Math.hypot(err[0], err[1]);
  const m = Math.min(1, e / 4);
  return e > 1e-3 ? [(err[0] / e) * m, (err[1] / e) * m] : [0, 0];
}

const tint = (mat: number) => buildBike().map((v) => ({ ...v, mat: v.mat === MAT.Canvas ? mat : v.mat }));
const LOOKS = [tint(MAT.Brick), tint(MAT.Crystal), tint(MAT.Leaves), tint(MAT.Rust)];

abstract class Rider {
  readonly b: Bike;
  protected t: BikeTuning;
  private look: Part['voxels'];

  constructor(
    readonly id: string,
    at: P2,
    tuning: BikeTuning,
    pace: number,
    protected top: Height,
    protected bounds: [number, number],
    look: number,
  ) {
    this.t = { ...tuning, max: tuning.max * pace, boost: 0 };
    this.b = makeBike(at[0], at[1], top, this.t);
    this.look = LOOKS[look % LOOKS.length];
  }

  get at(): P2 {
    return [this.b.x, this.b.y];
  }

  shift(dx: number, dy: number, dz: number): void {
    this.b.x += dx;
    this.b.y += dy;
    this.b.z += dz;
  }

  vehicle(): Vehicle {
    const b = this.b;
    return { id: this.id, at: [b.x, b.y, b.z], vel: [b.vx, b.vy, b.vz], heading: speedOf(b) > 1 ? Math.atan2(b.vy, b.vx) : b.heading };
  }

  part(): Part {
    const b = this.b;
    return { voxels: this.look, at: [b.x, b.y, b.z], q: attitude(b.heading, b.pitch, b.bank) };
  }
}

/** A rival on the course: rides gate to gate at its pace; done when it's through the last. */
export class Racer extends Rider {
  passed = 0;
  constructor(id: string, at: P2, tuning: BikeTuning, pace: number, top: Height, bounds: [number, number], look: number, private gates: P2[]) {
    super(id, at, tuning, pace, top, bounds, look);
  }
  get done(): boolean {
    return this.passed >= this.gates.length;
  }
  step(dt: number): void {
    const b = this.b;
    if (this.done) {
      // (over the line: it eases off)
      stepBike(b, [0, 0], dt, this.top, this.bounds, this.t, false);
      return;
    }
    const g = this.gates[this.passed];
    const dx = g[0] - b.x;
    const dy = g[1] - b.y;
    const d = Math.hypot(dx, dy);
    if (d < GATE_R) {
      this.passed++;
      return this.step(dt);
    }
    // (aims a little past the gate toward the next, so it doesn't brake for each)
    const n = this.gates[this.passed + 1];
    let ax = dx / d;
    let ay = dy / d;
    if (n && d < 18) {
      const nx = n[0] - g[0];
      const ny = n[1] - g[1];
      const nl = Math.hypot(nx, ny) || 1;
      const k = 1 - d / 18;
      ax = ax * (1 - k * 0.4) + (nx / nl) * k * 0.4;
      ay = ay * (1 - k * 0.4) + (ny / nl) * k * 0.4;
      const al = Math.hypot(ax, ay) || 1;
      ax /= al;
      ay /= al;
    }
    stepBike(b, steer(b, [ax * this.t.max, ay * this.t.max]), dt, this.top, this.bounds, this.t, false);
  }
}

/** The quarry of a chase: runs from the hero, swerving, turned back in from the window's edges. */
export class Quarry extends Rider {
  private wander = 0;
  private time = 0;
  constructor(id: string, at: P2, tuning: BikeTuning, pace: number, top: Height, bounds: [number, number], private margin = 30) {
    super(id, at, tuning, pace, top, bounds, 0);
  }
  step(dt: number, hero: P2): void {
    const b = this.b;
    this.time += dt;
    this.wander = Math.sin(this.time * 0.7) * 0.9 + Math.sin(this.time * 1.9) * 0.4;
    let ax = b.x - hero[0];
    let ay = b.y - hero[1];
    const l = Math.hypot(ax, ay) || 1;
    ax /= l;
    ay /= l;
    // (a swerve across its way)
    const c = Math.cos(this.wander);
    const s = Math.sin(this.wander);
    [ax, ay] = [ax * c - ay * s, ax * s + ay * c];
    // (the window's edges push it back in: it runs round, not off the land that's made)
    const m = this.margin;
    const [W, H] = this.bounds;
    const push = (d: number) => Math.max(0, 1 - d / m) * 2;
    ax += push(b.x) - push(W - b.x);
    ay += push(b.y) - push(H - b.y);
    const al = Math.hypot(ax, ay) || 1;
    stepBike(b, steer(b, [(ax / al) * this.t.max, (ay / al) * this.t.max]), dt, this.top, this.bounds, this.t, false);
  }
}
