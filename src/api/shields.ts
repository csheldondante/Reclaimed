// world.shields (loop round 12, docs/design/FRONTS.md): a shield is a disc on the ground the liquids cannot flow into —
// a lava front or a flood parts round it. Raised for some seconds; given to both liquids each update (their uniform's
// discs: liquid.wgsl `shielded`); shown through the effects system (the particles' glows, particles.wgsl K_GLOW):
//   - (loop round 13) a wall of light round the rim, standing on the ground (state 2: one request a ring, the points
//     placed on the GPU) and a faint haze over the dome (state 3);
//   - the cast: a ring of light spreading from the middle out to the rim in CAST_S, and streaks thrown up off the rim
//     as it closes (state 5);
//   - the end: the wall flickers its last END_S, then the rim throws its streaks out and up, and it is gone;
//   - where hot lava presses on it, white-hot flashes and sparks (state 4, made by the lava itself: liquid.wgsl
//     publishLava — the CPU does not know where the lava is).
// The window coordinates move with the window's slides (`shift`).
//
//   const s = sim.shields.raise(x, y, { radius: 20, seconds: 60, z });
// attachSim calls `update` each sim tick (expiry in sim seconds, the liquids' discs, the dome drawn) and `shift` on a
// slide.
//
// Units are not stopped by it (a shield is a wall to the liquids only).
import type { FlowKit } from '../flow/install';
import { MAX_SHIELDS } from '../flow/liquid';
import { PK, type Burst } from '../sim/particles';

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
  /** seconds since it was raised */
  age: number;
}

/** (particles.wgsl K_GLOW states) */
const GLOW_RIM = 2;
const GLOW_DOME = 3;
const GLOW_STREAK = 5;
/** seconds between the wall's rings (each bead lasts ~1 s: about four rings stand at once) */
const DRAW_EVERY = 0.25;
/** beads a cell of the rim's length, a ring */
const RIM_PER_CELL = 1.5;
/** the wall's height over the ground (cells) */
const WALL_UP = 3;
/** the dome's haze: points a draw */
const DOME_POINTS = 90;
/** the cast: seconds for the ring to spread out to the rim, and between its rings meanwhile */
const CAST_S = 0.8;
const CAST_EVERY = 0.1;
/** the last seconds: the wall flickers (drawn every other turn) */
const END_S = 3;

export class Shields {
  readonly list: Shield[] = [];
  private next = 1;
  private draw = 0;
  private turn = 0;

  constructor(
    private flow: FlowKit,
    /** the particles' own burst: a shield's light is the glows' states 2-5, which Fx has no names for */
    private burst: (b: Burst) => void,
  ) {}

  /** a shield raised over (x, y): `MAX_SHIELDS` at once (the oldest goes) */
  raise(x: number, y: number, opts: { radius: number; seconds: number; z: number }): Shield {
    if (!(opts.radius > 0) || !(opts.seconds > 0)) throw new Error(`shields: a shield needs a radius and seconds (${opts.radius}, ${opts.seconds})`);
    if (this.list.length >= MAX_SHIELDS) this.list.shift();
    const s: Shield = { id: this.next++, x, y, z: opts.z, radius: opts.radius, left: opts.seconds, age: 0 };
    this.list.push(s);
    this.give();
    // (the cast: a flash in the middle at once; the spreading ring is drawn by update)
    this.ring(s, 1.5);
    this.dome(s, DOME_POINTS);
    return s;
  }

  /** a shield taken down before its time */
  drop(id: number): void {
    const k = this.list.findIndex((s) => s.id === id);
    if (k < 0) return;
    this.ended(this.list[k]);
    this.list.splice(k, 1);
    this.give();
  }

  /** each frame (seconds of game time): shields run out, the liquids are given the discs, the dome is drawn */
  update(dt: number): void {
    const was = this.list.length;
    for (const s of this.list) {
      const a0 = s.age;
      s.left -= dt;
      s.age += dt;
      // (the cast: the ring spreading out from the middle, then streaks thrown up as it closes on the rim)
      if (a0 < CAST_S) {
        if (Math.floor(s.age / CAST_EVERY) !== Math.floor(a0 / CAST_EVERY)) this.ring(s, s.radius * Math.min(1, s.age / CAST_S));
        if (s.age >= CAST_S) this.streaks(s, 4, 9);
      }
    }
    for (let k = this.list.length - 1; k >= 0; k--) {
      const s = this.list[k];
      if (s.left > 0) continue;
      this.ended(s);
      this.list.splice(k, 1);
    }
    if (this.list.length !== was) this.give();
    if ((this.draw += dt) < DRAW_EVERY) return;
    this.draw = 0;
    this.turn++;
    for (const s of this.list) {
      if (s.age < CAST_S) continue;
      // (its last seconds: the wall drawn every other turn — it flickers)
      if (s.left < END_S && this.turn % 2) continue;
      this.ring(s, s.radius);
      this.dome(s, DOME_POINTS);
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

  /** a ring of the wall of light at radius r round the shield's middle (each bead on the ground where it stands) */
  private ring(s: Shield, r: number): void {
    const count = Math.max(8, Math.round(2 * Math.PI * r * RIM_PER_CELL));
    this.burst({ kind: PK.Glow, x: s.x, y: s.y, z: s.z, count, speed: WALL_UP, payload: GLOW_RIM, spread: r });
  }

  /** the dome's haze: `count` points over a hemisphere half as high as it is wide, from the wall's top */
  private dome(s: Shield, count: number): void {
    this.burst({ kind: PK.Glow, x: s.x, y: s.y, z: s.z, count, speed: WALL_UP, payload: GLOW_DOME, spread: s.radius });
  }

  /** streaks of light off the rim: out at `out` and up at `up` cells/s */
  private streaks(s: Shield, out: number, up: number): void {
    const count = Math.max(8, Math.round(2 * Math.PI * s.radius * 0.8));
    this.burst({ kind: PK.Glow, x: s.x, y: s.y, z: s.z, count, speed: WALL_UP, payload: GLOW_STREAK, spread: s.radius, vel: [out, 0, up] });
  }

  /** a shield gone: the wall throws its light out and up, a last ring at the rim */
  private ended(s: Shield): void {
    this.ring(s, s.radius);
    this.streaks(s, 7, 5);
  }
}
