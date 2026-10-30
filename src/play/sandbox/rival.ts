// ---- play/sandbox/rival.ts --------------------------------------------------------------------------------------
// A rival rider for the sandbox (round 118): something to hook onto and pull up alongside ("to pull up along other
// vehicles"), and the seed of race rivals (PL7). The same drive as the player's bike (core/bike.ts) under an
// autopilot that laps a circle round where it was put, a little slower than the player's cruise. Not a unit: it's a
// vehicle in play (PlayWorld.vehicles), so hooks see it; enemies don't.

import { makeBike, speedOf, stepBike, type Bike, type BikeTuning } from '../core/bike';
import { attitude, buildBike, type Part } from '../draw/shapes';
import type { Vehicle } from '../world';
import { MAT } from '../../world/materials';

/** its laps: radius (cells), its share of the bike's cruise */
export const LAP = { radius: 40, pace: 0.6 };

/** the rival's look: the bike with its rider in brick red */
const VOXELS = buildBike().map((v) => ({ ...v, mat: v.mat === MAT.Canvas ? MAT.Brick : v.mat }));

export class Rival {
  readonly b: Bike;
  private t: BikeTuning;

  constructor(
    readonly id: string,
    private centre: [number, number],
    tuning: BikeTuning,
    private top: (x: number, y: number) => number,
    private bounds: [number, number],
    /** where round its circle it starts (radians; default anywhere) */
    start = Math.random() * Math.PI * 2,
  ) {
    this.t = { ...tuning, max: tuning.max * LAP.pace, boost: 0 };
    const a = start;
    this.b = makeBike(centre[0] + Math.cos(a) * LAP.radius, centre[1] + Math.sin(a) * LAP.radius, top, this.t);
  }

  step(dt: number): void {
    const b = this.b;
    // (counter-clockwise round the centre: a velocity it wants — along the circle at its pace, back toward the circle
    // when off it — and the stick pushed at the difference, as a rider steers: the drive keeps momentum, so steering
    // at a point ahead drifted it out of its lap)
    const rx = b.x - this.centre[0];
    const ry = b.y - this.centre[1];
    const r = Math.hypot(rx, ry) || 1;
    const [ux, uy] = [rx / r, ry / r];
    const v = this.t.max;
    const want = [-uy * v - ux * (r - LAP.radius) * 1.5, ux * v - uy * (r - LAP.radius) * 1.5];
    const err = [want[0] - b.vx, want[1] - b.vy];
    const e = Math.hypot(err[0], err[1]);
    const m = Math.min(1, e / 4);
    const stick: [number, number] = e > 1e-3 ? [(err[0] / e) * m, (err[1] / e) * m] : [0, 0];
    stepBike(b, stick, dt, this.top, this.bounds, this.t, false);
  }

  shift(dx: number, dy: number, dz: number): void {
    this.b.x += dx;
    this.b.y += dy;
    this.b.z += dz;
    this.centre = [this.centre[0] + dx, this.centre[1] + dy];
  }

  vehicle(): Vehicle {
    const b = this.b;
    return { id: this.id, at: [b.x, b.y, b.z], vel: [b.vx, b.vy, b.vz], heading: speedOf(b) > 1 ? Math.atan2(b.vy, b.vx) : b.heading };
  }

  part(): Part {
    const b = this.b;
    return { voxels: VOXELS, at: [b.x, b.y, b.z], q: attitude(b.heading, b.pitch, b.bank) };
  }
}
