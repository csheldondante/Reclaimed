// world.shields (loop round 12, docs/design/FRONTS.md): a shield is a disc on the ground the liquids cannot flow into —
// a lava front or a flood parts round it. Raised for some seconds; given to both liquids each update (their uniform's
// discs: liquid.wgsl `shielded`); shown through the effects system as a dome of sparks over the disc and a ring at its
// rim. The window coordinates move with the window's slides (`shift`).
//
//   const s = sim.shields.raise(x, y, { radius: 20, seconds: 60, z });
// attachSim calls `update` each sim tick (expiry in sim seconds, the liquids' discs, the dome drawn) and `shift` on a
// slide.
//
// Units are not stopped by it (a shield is a wall to the liquids only).
import type { FlowKit } from '../flow/install';
import { MAX_SHIELDS } from '../flow/liquid';
import { PK, type Burst } from '../sim/particles';
import type { Fx } from './fx';

export interface Shield {
  id: number;
  /** window world units */
  x: number;
  y: number;
  /** the ground's height at its middle (the dome stands on it) */
  z: number;
  radius: number;
  /** seconds left */
  left: number;
}

/** seconds between the dome's sparks */
const DRAW_EVERY = 0.2;
/** points round the rim, and over the dome, a draw */
const RIM_POINTS = 32;
const CAP_POINTS = 12;
/** the rim's glows over the ground (cells) */
const RIM_UP = 3;

export class Shields {
  readonly list: Shield[] = [];
  private next = 1;
  private draw = 0;
  private turn = 0;

  constructor(
    private flow: FlowKit,
    private fx: Fx,
    /** the particles' own burst: the dome is drawn in soft blue glows (PK.Glow, payload 1), which Fx has no name for */
    private burst: (b: Burst) => void,
  ) {}

  /** a shield raised over (x, y): `MAX_SHIELDS` at once (the oldest goes) */
  raise(x: number, y: number, opts: { radius: number; seconds: number; z: number }): Shield {
    if (!(opts.radius > 0) || !(opts.seconds > 0)) throw new Error(`shields: a shield needs a radius and seconds (${opts.radius}, ${opts.seconds})`);
    if (this.list.length >= MAX_SHIELDS) this.list.shift();
    const s: Shield = { id: this.next++, x, y, z: opts.z, radius: opts.radius, left: opts.seconds };
    this.list.push(s);
    this.give();
    // (raised: a flash round the rim at once)
    this.drawRim(s, 3, 2.5);
    return s;
  }

  /** a shield taken down before its time */
  drop(id: number): void {
    const k = this.list.findIndex((s) => s.id === id);
    if (k >= 0) this.list.splice(k, 1);
    this.give();
  }

  /** each frame (seconds of game time): shields run out, the liquids are given the discs, the dome is drawn */
  update(dt: number): void {
    const was = this.list.length;
    for (const s of this.list) s.left -= dt;
    for (let k = this.list.length - 1; k >= 0; k--) if (this.list[k].left <= 0) this.list.splice(k, 1);
    if (this.list.length !== was) this.give();
    if ((this.draw += dt) < DRAW_EVERY) return;
    this.draw = 0;
    this.turn++;
    for (const s of this.list) {
      this.drawRim(s, 2, 0.6);
      this.drawCap(s);
    }
  }

  /** (WorldCore.onShift: −d, the land's move) the window slid: the discs go with the land */
  shift(dx: number, dy: number, dz: number): void {
    for (const s of this.list) {
      s.x -= dx;
      s.y -= dy;
      s.z -= dz;
    }
    this.give();
  }

  /** the liquids' discs (both: lava and water part round a shield alike) */
  private give(): void {
    const discs = this.list.map((s) => ({ x: s.x, y: s.y, r: s.radius }));
    this.flow.lava.shields = discs;
    this.flow.water.shields = discs;
  }

  /** the rim: a soft blue glow at each of its points (each lasts ~1.4 s, swelling: a band of light round the disc) and
   *  sparks rising off it (the ring turns half a step each draw) */
  private drawRim(s: Shield, count: number, rise: number): void {
    for (let k = 0; k < RIM_POINTS; k++) {
      const a = ((k + (this.turn % 2) * 0.5) / RIM_POINTS) * Math.PI * 2;
      const [x, y] = [s.x + Math.cos(a) * s.radius, s.y + Math.sin(a) * s.radius];
      // (3 cells up: over the liquid piled against the rim, which would hide a glow on the ground)
      this.burst({ kind: PK.Glow, x, y, z: s.z + RIM_UP, count: 1, speed: 0, payload: 1, spread: 0 });
      // (sparks off every third point: the particles take 64 bursts a tick)
      if (k % 3 === this.turn % 3) this.fx.burst('sparks', x, y, s.z + 0.8, { count, speed: 0.4, spread: 0.3, vel: [0, 0, rise] });
    }
  }

  /** glows on the dome's surface (a hemisphere half as high as it is wide), a few each draw */
  private drawCap(s: Shield): void {
    for (let k = 0; k < CAP_POINTS; k++) {
      // (golden-angle points over the dome, walked round a step each draw: the whole surface over a few draws)
      const i = (this.turn * CAP_POINTS + k) % 64;
      const h = (i + 0.5) / 64;
      const a = i * 2.39996;
      const ring = Math.sqrt(1 - h * h) * s.radius;
      this.burst({ kind: PK.Glow, x: s.x + Math.cos(a) * ring, y: s.y + Math.sin(a) * ring, z: s.z + RIM_UP + h * s.radius * 0.5, count: 1, speed: 0, payload: 1, spread: 0 });
    }
  }
}
