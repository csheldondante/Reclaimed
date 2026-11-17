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
// (Loop round 14, "The shield as an energy barrier") It is a wall to fire (fire.wgsl) and to units of every side
// (units.wgsl) too: its discs are in the Globals (`shields`). It has a store of energy and a recharge; what presses on
// it — lava standing at its rim, fire burning there, hostile units there — drains it, measured on the GPU
// (shields.wgsl `press`) and read back small every PRESS_EVERY seconds while one stands. Empty, it collapses at once,
// with a burst bigger than a time-out's end; below a quarter it flickers. Either end is told (`onEnd`).
// The window coordinates move with the window's slides (`shift`).
//
//   const s = sim.shields.raise(x, y, { radius: 20, seconds: 60, z, energy: 200, regen: 4 });
// attachSim calls `update` each sim tick (expiry in sim seconds, the press read, the liquids' discs, the dome drawn)
// and `shift` on a slide.
import type { FlowKit } from '../flow/install';
import { MAX_SHIELDS } from '../flow/liquid';
import { PK, type Burst } from '../sim/particles';
import { ignoreTeardown, makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import shieldsWgsl from '../shaders/shields.wgsl?raw';

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
  /** (loop round 14) its store of energy now, its most, and its recharge a second */
  energy: number;
  max: number;
  regen: number;
  /** what pressed on it at the last read: lava (depth-cells), fire (burning columns), hostile units; its drain a second */
  press: { lava: number; fire: number; units: number; drain: number };
}

/** how a shield ended: its energy gone (it gave way) or its time */
export type ShieldEnd = 'drained' | 'time' | 'dropped';

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
/** (loop round 14) below this share of its store the wall flickers too */
const LOW = 0.25;
/** (loop round 14) seconds between the press reads while a shield stands */
const PRESS_EVERY = 0.25;
/** (loop round 14) the band outside the rim the press is measured over (cells) */
const PRESS_BAND = 2;
/**
 * (loop round 14) energy drained a second: per depth-cell of liquid lava standing in the band; per burning column there
 * (fire 0..1 summed); per hostile unit standing at the rim (its blows)
 */
export const LAVA_DRAIN = 0.05;
export const FIRE_DRAIN = 0.5;
export const BLOW_DRAIN = 1;
/** (loop round 14) a shield's store and recharge when the caster gives none */
export const DEFAULT_ENERGY = 100;
export const DEFAULT_REGEN = 2;

/** (loop round 14) the GPU half: the press kernel, its counters and the small read */
export interface PressGpu {
  device: GPUDevice;
  globals: GPUBuffer;
  fire: GPUBuffer;
  lava: GPUBuffer;
  /** the units' records and combat words (null: no agents) */
  units: GPUBuffer | null;
  combat: GPUBuffer | null;
}

class ShieldPress {
  private k: ComputeKernel;
  private counts: GPUBuffer;
  private params: GPUBuffer;
  private group: GPUBindGroup;
  private nUnits: number;
  busy = false;
  /** reads asked (the cost report) */
  reads = 0;

  constructor(private g: PressGpu) {
    const d = g.device;
    this.k = makeCompute(d, 'shields-press', [commonWgsl, shieldsWgsl], { 0: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'uniform' }, 'press');
    this.counts = d.createBuffer({ label: 'shields press', size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.params = d.createBuffer({ label: 'shields press params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const units = g.units ?? d.createBuffer({ label: 'shields no units', size: 96, usage: GPUBufferUsage.STORAGE });
    const combat = g.combat ?? d.createBuffer({ label: 'shields no combat', size: 16, usage: GPUBufferUsage.STORAGE });
    this.nUnits = g.units ? Math.min(Math.floor(g.units.size / 96), Math.floor(combat.size / 16)) : 0;
    this.group = makeBindGroup(d, 'shields-press', this.k.layout, { 0: g.globals, 3: g.fire, 4: g.lava, 5: units, 6: combat, 7: this.counts, 8: this.params });
  }

  /** what presses on the Globals' four shields now: [lava, fire, units] each (null: torn down) */
  async read(): Promise<[number, number, number][] | null> {
    const d = this.g.device;
    this.busy = true;
    this.reads++;
    const p = new ArrayBuffer(16);
    new Uint32Array(p, 0, 1)[0] = this.nUnits;
    new Float32Array(p, 4, 1)[0] = PRESS_BAND;
    d.queue.writeBuffer(this.params, 0, p);
    const enc = d.createCommandEncoder({ label: 'shields press' });
    enc.clearBuffer(this.counts);
    const pass = enc.beginComputePass({ label: 'shields-press' });
    pass.setPipeline(this.k.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(MAX_SHIELDS);
    pass.end();
    const tmp = d.createBuffer({ label: 'shields press read', size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(this.counts, 0, tmp, 0, 64);
    d.queue.submit([enc.finish()]);
    let out: [number, number, number][] | null = null;
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(tmp.getMappedRange());
      out = [0, 1, 2, 3].map((k) => [u[k * 4] / 1000, u[k * 4 + 1] / 1000, u[k * 4 + 2]] as [number, number, number]);
      tmp.unmap();
    }, ignoreTeardown);
    tmp.destroy();
    this.busy = false;
    return out;
  }
}

export class Shields {
  readonly list: Shield[] = [];
  /** (loop round 14) told when a shield ends, and how (the live event's line says it) */
  readonly onEnd: ((s: Shield, how: ShieldEnd) => void)[] = [];
  private next = 1;
  private draw = 0;
  private turn = 0;
  private pressT = 0;
  private press: ShieldPress | null;
  /** sim seconds since the last press read began (its drain stands for them) */
  private since = 0;

  constructor(
    private flow: FlowKit,
    /** the particles' own burst: a shield's light is the glows' states 2-5, which Fx has no names for */
    private burst: (b: Burst) => void,
    /** (loop round 14) the Globals' shields (common.wgsl Globals.shields) */
    private globals: { shields?: [number, number, number][] },
    gpu: PressGpu | null,
  ) {
    this.press = gpu ? new ShieldPress(gpu) : null;
  }

  /** a shield raised over (x, y): `MAX_SHIELDS` at once (the oldest goes) */
  raise(x: number, y: number, opts: { radius: number; seconds: number; z: number; energy?: number; regen?: number }): Shield {
    if (!(opts.radius > 0) || !(opts.seconds > 0)) throw new Error(`shields: a shield needs a radius and seconds (${opts.radius}, ${opts.seconds})`);
    const energy = opts.energy ?? DEFAULT_ENERGY;
    const regen = opts.regen ?? DEFAULT_REGEN;
    if (!(energy > 0) || !(regen >= 0)) throw new Error(`shields: a shield needs energy and a recharge of 0 or more (${energy}, ${regen})`);
    if (this.list.length >= MAX_SHIELDS) this.list.shift();
    const s: Shield = { id: this.next++, x, y, z: opts.z, radius: opts.radius, left: opts.seconds, age: 0, energy, max: energy, regen, press: { lava: 0, fire: 0, units: 0, drain: 0 } };
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
    const s = this.list[k];
    this.list.splice(k, 1);
    this.ended(s, 'dropped');
    this.give();
  }

  /** each frame (seconds of game time): shields run out, the press read, the liquids are given the discs, the dome drawn */
  update(dt: number): void {
    const was = this.list.length;
    for (const s of this.list) {
      const a0 = s.age;
      s.left -= dt;
      s.age += dt;
      s.energy = Math.min(s.max, s.energy + s.regen * dt);
      // (the cast: the ring spreading out from the middle, then streaks thrown up as it closes on the rim)
      if (a0 < CAST_S) {
        if (Math.floor(s.age / CAST_EVERY) !== Math.floor(a0 / CAST_EVERY)) this.ring(s, s.radius * Math.min(1, s.age / CAST_S));
        if (s.age >= CAST_S) this.streaks(s, 4, 9);
      }
    }
    this.since += dt;
    if (this.press && this.list.length && !this.press.busy && (this.pressT += dt) >= PRESS_EVERY) {
      this.pressT = 0;
      // (the discs the Globals hold now, by slot: the read answers for them)
      const ids = this.list.slice(0, MAX_SHIELDS).map((s) => s.id);
      const span = this.since;
      this.since = 0;
      void this.press.read().then((c) => c && this.pressed(ids, c, span));
    }
    for (let k = this.list.length - 1; k >= 0; k--) {
      const s = this.list[k];
      if (s.left > 0) continue;
      this.list.splice(k, 1);
      this.ended(s, 'time');
    }
    if (this.list.length !== was) this.give();
    if ((this.draw += dt) < DRAW_EVERY) return;
    this.draw = 0;
    this.turn++;
    for (const s of this.list) {
      if (s.age < CAST_S) continue;
      // (its last seconds, or its store low: the wall drawn every other turn — it flickers)
      if ((s.left < END_S || s.energy < s.max * LOW) && this.turn % 2) continue;
      this.ring(s, s.radius);
      this.dome(s, DOME_POINTS);
    }
  }

  /** (loop round 14) a press read in: each shield's drain over the seconds it stands for; an empty store collapses it */
  private pressed(ids: number[], c: [number, number, number][], span: number): void {
    ids.forEach((id, slot) => {
      const s = this.list.find((x) => x.id === id);
      if (!s) return;
      const [lava, fire, units] = c[slot];
      const drain = lava * LAVA_DRAIN + fire * FIRE_DRAIN + units * BLOW_DRAIN;
      s.press = { lava, fire, units, drain };
      s.energy -= drain * span;
      if (s.energy > 0) return;
      s.energy = 0;
      this.list.splice(this.list.indexOf(s), 1);
      this.ended(s, 'drained');
      this.give();
    });
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

  /** the discs: both liquids' (lava and water part round a shield alike), and the Globals' (fire, units, the press) */
  private give(): void {
    const discs = this.list.slice(0, MAX_SHIELDS).map((s) => ({ x: s.x, y: s.y, r: s.radius }));
    this.flow.lava.shields = discs;
    this.flow.water.shields = discs;
    this.globals.shields = discs.map((d) => [d.x, d.y, d.r]);
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
  private streaks(s: Shield, out: number, up: number, share = 0.8): void {
    const count = Math.max(8, Math.round(2 * Math.PI * s.radius * share));
    this.burst({ kind: PK.Glow, x: s.x, y: s.y, z: s.z, count, speed: WALL_UP, payload: GLOW_STREAK, spread: s.radius, vel: [out, 0, up] });
  }

  /**
   * a shield gone. Its time out: the wall throws its light out and up, a last ring at the rim. (Loop round 14) Given way
   * (its energy gone): a burst — the rim's streaks thrown out hard, twice as many, a second ring and the dome's haze
   * flashed at once, and a flash at its middle.
   */
  private ended(s: Shield, how: ShieldEnd): void {
    this.ring(s, s.radius);
    if (how === 'drained') {
      this.streaks(s, 14, 8, 1.6);
      this.streaks(s, 6, 14, 0.8);
      this.ring(s, s.radius * 0.6);
      this.dome(s, DOME_POINTS * 3);
      this.ring(s, 1.5);
    } else this.streaks(s, 7, 5);
    for (const f of this.onEnd) f(s, how);
  }
}
