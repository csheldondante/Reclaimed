// (round 90, the user on the phone: "add a button or bar to rotate the camera") The player's turn of the view
// round the target: steps of a sixth of a turn (the hex lattice looks the same from every one of them — the
// fixed view's look at its own angle), eased on a critically damped spring, or turned on continuously while a
// button is held. It owns Camera.azimuth while it's turning; at rest it leaves it (the cutaway's Orbit may turn
// it then — scenes/level.ts hands a step to the Orbit instead when the cutaway is on).

import type { Camera } from './camera';

/** a step: a sixth of a turn (the lattice's symmetry) */
export const TURN_STEP = Math.PI / 3;

export class Turn {
  /** the azimuth it's easing to (unwrapped: four quick steps turn four steps, not the short way round) */
  goal: number;
  /** the spring (1/s; critically damped) */
  rate = 9;
  /** radians a second while a button's held (continuous) */
  holdSpeed = 1.6;
  /** -1, 0, 1: turning on while held */
  held = 0;
  private speed = 0;
  private az: number;

  constructor(private camera: Camera) {
    this.az = this.goal = camera.azimuth;
  }

  /** a step either way (1: the eye goes round counter-clockwise — the land turns clockwise on screen) */
  step(dir: number): void {
    this.sync();
    // (from where a step is going: steps add up while it eases)
    this.goal = this.snapped(this.goal) + dir * TURN_STEP;
  }

  /** (round 91, the compass's tap) ease to face azimuth `a`, the short way round */
  face(a: number): void {
    this.sync();
    this.held = 0;
    this.goal = this.az + Math.atan2(Math.sin(a - this.az), Math.cos(a - this.az));
  }

  /** is it turning (or held)? */
  get busy(): boolean {
    return this.held !== 0 || Math.abs(this.goal - this.az) > 1e-3 || Math.abs(this.speed) > 1e-3;
  }

  /** Each frame. */
  update(dt: number): void {
    this.sync();
    if (this.held) {
      this.az += this.held * this.holdSpeed * dt;
      this.goal = this.az;
      this.speed = 0;
    } else {
      // (sub-steps: a slow frame doesn't overshoot)
      let left = Math.min(dt, 0.25);
      const w = this.rate;
      while (left > 0) {
        const h = Math.min(left, 1 / 120);
        const d = this.goal - this.az;
        this.speed += (w * w * d - 2 * w * this.speed) * h;
        this.az += this.speed * h;
        left -= h;
      }
      if (Math.abs(this.goal - this.az) < 1e-4 && Math.abs(this.speed) < 1e-3) {
        this.az = this.goal;
        this.speed = 0;
      }
    }
    this.camera.azimuth = this.az;
  }

  /** the nearest step's angle to `a` (the steps are the fixed view's angle π/4 plus whole sixths) */
  snapped(a: number): number {
    return Math.PI / 4 + Math.round((a - Math.PI / 4) / TURN_STEP) * TURN_STEP;
  }

  /** (something else turned the camera — the cutaway's Orbit, a story shot: take it from there) */
  private sync(): void {
    const d = Math.atan2(Math.sin(this.camera.azimuth - this.az), Math.cos(this.camera.azimuth - this.az));
    if (Math.abs(d) > 1e-5) {
      this.az += d;
      this.goal += d;
      this.speed = 0;
    }
  }
}
