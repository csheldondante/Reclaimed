// ---- api/puck.ts --------------------------------------------------------------
// The camera's puck (round 83, the user): "I would have the puck surface constrained and slightly springy. I
// would track velocity in 3d so it doesn't suddenly snap up a cliff. I would instead have it slide over
// surfaces at some elastic rate. For the god eye I would just make it slide along to the point on the surface
// the center of the camera is aimed at and the pick of where that is would depend on what is visible ... In
// general the puck should slide toward the vertical axis the camera pick makes and that way it will go into
// caves naturally if they are there."
//
// The puck is the camera's target. What moves the target (a pan, a zoom about the pointer, a director's shot,
// the window sliding) moves the puck with it at once, and it looks again: the screen's middle picked — the
// first surface along the eye's line there that's drawn (over the camera's slice isn't) — and of the floors on
// that point's vertical line, the one nearest the puck's own height is where it goes. Along the eye's line a
// move can't be seen (the view is orthographic): that part is taken at once, so the puck's depth is always
// right; the rest — across the screen — on a spring with its own velocity, so a step up a cliff is a slide.
//
//   const puck = new Puck(sim.terrain, core.camera)
//   each frame, after the camera's input and before drawing:  puck.update(dt)

import type { Camera } from '../render/camera';
import type { Terrain } from './terrain';

type V3 = [number, number, number];

export class Puck {
  /** where it is (world); null until the ground is read */
  pos: V3 | null = null;
  /** where it slides to: a floor on the picked point's vertical line */
  goal: V3 | null = null;
  /** the spring across the screen (1/s: its natural rate; critically damped) */
  rate = 5;
  /** world units a second across the screen, at most */
  maxSpeed = 60;
  private vel: V3 = [0, 0, 0];
  /** the target as the puck last wrote it */
  private wrote: V3 | null = null;

  constructor(
    private terrain: Terrain,
    private camera: Camera,
  ) {}

  /** Each frame, after the camera's input: slide, and put the camera's target on the puck. */
  update(dt: number): void {
    const cam = this.camera;
    if (cam.fly) {
      this.pos = this.wrote = null;
      return;
    }
    const t = cam.target;
    if (!this.pos || !this.wrote) {
      const g = this.pick(t, t[2]);
      if (!g) return;
      this.pos = [...g];
      this.goal = [...g];
      this.vel = [0, 0, 0];
      this.put();
      return;
    }
    const w = this.wrote;
    const d: V3 = [t[0] - w[0], t[1] - w[1], t[2] - w[2]];
    if (d[0] || d[1] || d[2]) {
      for (let i = 0; i < 3; i++) {
        this.pos[i] += d[i];
        if (this.goal) this.goal[i] += d[i];
      }
      this.goal = this.pick(this.pos, this.pos[2]) ?? this.goal;
    } else if (this.goal) {
      // (the ground changes under it: the same floor, as it is now)
      const f = this.floorNear(this.goal[0], this.goal[1], this.goal[2]);
      if (f !== null) this.goal[2] = f;
    }
    if (this.goal) this.slide(this.goal, dt);
    this.put();
  }

  /** Jump to (x, y)'s floor nearest z, at rest (a level's start, a teleport). */
  place(x: number, y: number, z: number): void {
    const f = this.floorNear(x, y, z) ?? z;
    this.pos = [x, y, f];
    this.goal = [x, y, f];
    this.vel = [0, 0, 0];
    this.put();
  }

  private put(): void {
    const p = this.pos!;
    this.camera.target = [p[0], p[1], p[2]];
    this.wrote = [p[0], p[1], p[2]];
  }

  /** toward the goal: along the eye's line at once (unseen), across the screen on the spring */
  private slide(goal: V3, dt: number): void {
    const p = this.pos!;
    const e = this.camera.eye;
    const d: V3 = [goal[0] - p[0], goal[1] - p[1], goal[2] - p[2]];
    const along = d[0] * e[0] + d[1] * e[1] + d[2] * e[2];
    for (let i = 0; i < 3; i++) {
      p[i] += along * e[i];
      d[i] -= along * e[i];
    }
    // (the velocity across the screen only: what's along the line was taken)
    const v = this.vel;
    const va = v[0] * e[0] + v[1] * e[1] + v[2] * e[2];
    for (let i = 0; i < 3; i++) v[i] -= va * e[i];
    const r = this.rate;
    // (in steps no longer than 1/60 s: the spring stays stable through a long frame)
    const n = Math.max(1, Math.ceil(dt * 60));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < 3; i++) v[i] += (r * r * d[i] - 2 * r * v[i]) * h;
      const sp = Math.hypot(v[0], v[1], v[2]);
      if (sp > this.maxSpeed) for (let i = 0; i < 3; i++) v[i] *= this.maxSpeed / sp;
      for (let i = 0; i < 3; i++) {
        p[i] += v[i] * h;
        d[i] -= v[i] * h;
      }
    }
  }

  /**
   * The screen's middle through `at`: the first surface drawn along the eye's line (what's over the camera's
   * slice isn't), and the floor on its vertical line nearest `z`. null: nothing read there.
   */
  private pick(at: readonly number[], z: number): V3 | null {
    const e = this.camera.eye;
    const cut = this.camera.cut.slice ?? Infinity;
    for (let t = 120; t > -400; t -= 0.5) {
      const x = at[0] + e[0] * t;
      const y = at[1] + e[1] * t;
      const pz = at[2] + e[2] * t;
      if (pz > cut) continue;
      const ls = this.terrain.layersAt(x, y);
      if (!ls) continue;
      if (pz > 0 && !ls.some((v) => stands(v.state) && pz >= v.z0 && pz < v.z1)) continue;
      const f = this.floorNear(x, y, z);
      return f === null ? null : [x, y, f];
    }
    return null;
  }

  /** The floor (a surface with room over it) in the column at (x, y) nearest z; null: nothing read there. */
  floorNear(x: number, y: number, z: number): number | null {
    const ls = this.terrain.layersAt(x, y)?.filter((v) => stands(v.state));
    if (!ls) return null;
    let best: number | null = null;
    for (let k = 0; k < ls.length; k++) {
      const top = ls[k].z1;
      // (room to stand: what's next starts a cell and a half up, or nothing)
      if (k + 1 < ls.length && ls[k + 1].z0 - top < 1.5) continue;
      if (best === null || Math.abs(top - z) < Math.abs(best - z)) best = top;
    }
    return best ?? 0;
  }
}

/** what the puck stands on: the ground, loose or solid, and water's surface */
const stands = (s: string) => s === 'solid' || s === 'loose' || s === 'liquid';
