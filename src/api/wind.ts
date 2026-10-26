// world.wind (docs/WORLD_API.md): blows and strokes a game manages as lists,
// with no cap a game sees; the wind field read back.
//
// Everything here paints the painted wind: the wind field's player part
// (windfield.wgsl), which carries itself along, spreads, and relaxes away
// over ~7 s. Everything that feels the wind (dust, plants, fire, particles,
// storms) feels it.
// - A blow holds the painted wind at its strength under it while it lasts:
//   along a direction, outward (a blast), inward, or swirling. Blows never
//   stack past their strength; when one ends, what it raised dies down.
// - A stroke paints a segment the way the player's drag does: one pass adds
//   PASS (a breeze; two a gust, three a gale), spread over the segment's
//   length so a pass adds the same however fast it's drawn, and never past
//   the stroke's cap along it.
// - A wake is a stroke a mover paints each tick over the ground it just
//   covered, along its motion, capped at WAKE_CAP (0.7) × its speed: it
//   trails behind it, and the field's own carrying and relaxing do the rest.
//   Any number of movers paint at once, alongside the player's drag.
//
// The wind field takes MAX_BLOWS entries a tick. Past that the list sent is
// merged, never dropped: the two nearest entries of the same kind are
// combined (centre weighted by strength, a radius covering both, the stronger
// strength, the mean direction) until it fits. The game's own entries stay
// as they were.

import type { WorldCore } from '../scenes/world-core';
import { TICK_DT } from '../sim/simulation';
import { WIND_K } from '../sim/flow';
import type { SimSystem } from '../sim/system';
import { MAX_BLOWS } from '../sim/world-gpu';
import { MATERIALS } from '../world/materials';
import type { Mirror } from './mirror';

/** one pass of a stroke (game/powers.ts: the player's drag) */
const PASS = 4.5;
/** a wake's painted wind, as a share of the mover's speed */
const WAKE_CAP = 0.7;
/** a mover not heard from for this long is gone (its painted wind lives on and relaxes) */
const WAKE_GONE_S = 0.25;
/** the painted wind saturates here (windfield.wgsl MAX_W) */
const MAX_WIND = 24;
/** vec4s an entry (windfield.wgsl blows) */
const ENTRY = 3;

export type BlowMode = 'along' | 'out' | 'in' | 'swirl';
type Mode = BlowMode | 'stroke';
const MODE: Record<Mode, number> = { along: 0, out: 1, in: 2, swirl: 3, stroke: 4 };

export interface BlowSpec {
  x: number;
  y: number;
  /** cells */
  radius: number;
  /** the wind held under it, cells/s (the painted wind saturates at 24) */
  strength: number;
  /** 'along' (default): along dir; 'out' a blast; 'in' a suck; 'swirl' */
  mode?: BlowMode;
  /** for 'along': the direction (normalised here) */
  dir?: [number, number];
  /** for 'swirl': false turns it clockwise */
  counterClockwise?: boolean;
  /** seconds of sim time it lasts (Infinity: until stopped) */
  time?: number;
}

export interface StrokeSpec {
  from: [number, number];
  to: [number, number];
  /** cells (default 4) */
  radius?: number;
  /** passes it paints (default 1: a breeze; 2 a gust, 3 a gale) */
  passes?: number;
  /** the most it paints along its direction, cells/s (default 24) */
  cap?: number;
}

export interface WakeSpec {
  /** where the mover is now (world) */
  at: [number, number];
  /** its velocity, cells/s (only its direction and speed matter: the segment painted is the ground it covered) */
  vel: [number, number];
  /** the wake's width, cells (default 3) */
  width?: number;
  /** passes a tick's segment paints (default 2: a gust; 1 a breeze, 3 a gale) */
  passes?: number;
  /** the wake's cap as a share of the mover's speed (default 0.7) */
  cap?: number;
}

interface Entry {
  x: number;
  y: number;
  radius: number;
  /** a blow's held wind, a stroke's cap */
  strength: number;
  mode: Mode;
  dir: [number, number];
  /** a stroke's length */
  len: number;
  /** a stroke's paint per pass sum */
  pass: number;
  ccw: boolean;
}

interface Blow extends Entry {
  left: number;
}

interface Mover {
  /** the point painted up to */
  x: number;
  y: number;
  /** the latest call */
  at: [number, number];
  speed: number;
  width: number;
  passes: number;
  cap: number;
  heard: number;
}

/** A live blow: move it, change it, stop it. */
export class BlowHandle {
  constructor(
    private wind: Wind,
    private b: Blow,
  ) {}
  /** Change any of its fields (moving it each frame is fine). */
  set(spec: Partial<BlowSpec>): this {
    if (spec.x !== undefined) this.b.x = spec.x;
    if (spec.y !== undefined) this.b.y = spec.y;
    if (spec.radius !== undefined) this.b.radius = spec.radius;
    if (spec.strength !== undefined) this.b.strength = spec.strength;
    if (spec.mode) this.b.mode = spec.mode;
    if (spec.dir) this.b.dir = norm(spec.dir);
    if (spec.time !== undefined) this.b.left = spec.time;
    if (spec.counterClockwise !== undefined) this.b.ccw = spec.counterClockwise;
    return this;
  }
  get alive(): boolean {
    return this.b.left > 0 && this.wind.has(this.b);
  }
  stop(): void {
    this.b.left = 0;
  }
}

function norm(d: [number, number]): [number, number] {
  const l = Math.hypot(d[0], d[1]);
  return l > 1e-6 ? [d[0] / l, d[1] / l] : [1, 0];
}

function strokeEntry(from: [number, number], to: [number, number], radius: number, passes: number, cap: number): Entry | null {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (len < 1e-3) return null;
  return { x: to[0], y: to[1], radius, strength: Math.min(cap, MAX_WIND), mode: 'stroke', dir: [(to[0] - from[0]) / len, (to[1] - from[1]) / len], len, pass: PASS * passes, ccw: true };
}

export class Wind implements SimSystem {
  readonly name = 'wind-blows';
  // (perfopt, ?windhz=: with the wind field, its time the ticks between — sim/flow.ts)
  readonly period = WIND_K;
  private blows: Blow[] = [];
  private strokes: Entry[] = [];
  private movers = new Map<string | number, Mover>();
  private data = new Float32Array((1 + MAX_BLOWS * ENTRY) * 4);
  private sent = 0;
  private clock = 0;
  /** entries sent last tick after merging (≤ MAX_BLOWS), and how many there were */
  lastSent = 0;
  lastListed = 0;

  constructor(
    private core: WorldCore,
    private mirror: Mirror,
  ) {
    mirror.addTexture('wind', core.world.windField);
    // (before the wind field: this tick's entries reach it)
    const sys = core.sim.systems;
    sys.splice(sys.indexOf(core.sim.wind), 0, this);
  }

  get readAt(): number {
    return this.mirror.readAt;
  }

  refresh(): Promise<void> {
    return this.mirror.refresh();
  }

  has(b: Blow): boolean {
    return this.blows.includes(b);
  }

  /** A blow; returns its handle. */
  blow(spec: BlowSpec): BlowHandle {
    const b: Blow = {
      x: spec.x,
      y: spec.y,
      radius: spec.radius,
      strength: spec.strength,
      mode: spec.mode ?? 'along',
      dir: norm(spec.dir ?? [1, 0]),
      len: 0,
      pass: 0,
      ccw: spec.counterClockwise ?? true,
      left: spec.time ?? Infinity,
    };
    this.blows.push(b);
    return new BlowHandle(this, b);
  }

  /** A short gust along dir (0.3 s unless `time`). */
  gust(x: number, y: number, radius: number, strength: number, dir: [number, number], time = 0.3): BlowHandle {
    return this.blow({ x, y, radius, strength, dir, time });
  }

  /** A blast outward from (x, y) (0.25 s unless `time`). */
  blast(x: number, y: number, radius: number, strength: number, time = 0.25): BlowHandle {
    return this.blow({ x, y, radius, strength, mode: 'out', time });
  }

  /** Paint a stroke once, on the next tick (the player's drag, from code). */
  stroke(spec: StrokeSpec): void {
    const e = strokeEntry(spec.from, spec.to, spec.radius ?? 4, spec.passes ?? 1, spec.cap ?? MAX_WIND);
    if (e) this.strokes.push(e);
  }

  /**
   * Mover `id` is at `at` going `vel`: each tick it paints the ground it
   * covered since the last, along its motion (call it every frame while it
   * moves; stop calling and the painted wind relaxes away).
   */
  wake(id: string | number, spec: WakeSpec): void {
    const m = this.movers.get(id);
    const speed = Math.hypot(spec.vel[0], spec.vel[1]);
    const next: Mover = { x: m?.x ?? spec.at[0], y: m?.y ?? spec.at[1], at: [spec.at[0], spec.at[1]], speed, width: spec.width ?? 3, passes: spec.passes ?? 2, cap: spec.cap ?? WAKE_CAP, heard: this.clock };
    this.movers.set(id, next);
  }

  /**
   * The wind (cells/s, after shelter) a loose material lifts above: dust
   * ('drift') 9, ash 10, sand 14, snow 6, leaf litter 5; Infinity for those
   * the wind never lifts (soil, gravel…). Sediment and the particles use it.
   */
  liftThreshold(material: string): number {
    const key = material.toLowerCase().replace(/ /g, '');
    const m = MATERIALS.find((d) => d.name.replace(/ /g, '') === key);
    if (!m) throw new Error(`world.wind.liftThreshold: no material "${material}"`);
    return m.windLift >= 1e3 || m.state !== 2 ? Infinity : m.windLift;
  }

  /**
   * The wind at world (x, y) from the mirror, cells/s: the map's own wind
   * plus what's been painted and blown (storms' and cyclones' swirls aren't
   * in it). Null before the first read.
   */
  fieldAt(x: number, y: number): [number, number] | null {
    const f = this.mirror.f32('wind');
    if (!f) return null;
    const tex = this.core.world.windField;
    const tx = Math.min(tex.width - 1, Math.max(0, Math.floor(x / 2)));
    const ty = Math.min(tex.height - 1, Math.max(0, Math.floor(y / 2)));
    const o = (ty * tex.width + tx) * 4;
    return [f[o + 2], f[o + 3]];
  }

  encode(): void {
    this.clock += TICK_DT * WIND_K;
    // (ended blows go; the rest age by a tick)
    this.blows = this.blows.filter((b) => b.left > 0);
    for (const b of this.blows) b.left -= TICK_DT * WIND_K;
    const list: Entry[] = this.blows.map((b) => ({ ...b, dir: [...b.dir] as [number, number] }));
    list.push(...this.strokes);
    this.strokes = [];
    // each mover paints what it covered since the last tick
    for (const [id, m] of this.movers) {
      if (this.clock - m.heard > WAKE_GONE_S) {
        this.movers.delete(id);
        continue;
      }
      const e = strokeEntry([m.x, m.y], m.at, m.width / 2, m.passes, m.speed * m.cap);
      if (e) list.push(e);
      m.x = m.at[0];
      m.y = m.at[1];
    }
    this.lastListed = list.length;
    while (list.length > MAX_BLOWS) mergeNearest(list);
    const d = this.data;
    d[0] = list.length;
    list.forEach((b, k) => {
      const o = 4 + k * ENTRY * 4;
      d.set([b.x, b.y, b.radius, b.strength], o);
      const sx = b.mode === 'swirl' ? (b.ccw ? 1 : -1) : b.dir[0];
      d.set([sx, b.mode === 'swirl' ? 0 : b.dir[1], MODE[b.mode], b.len], o + 4);
      d.set([b.pass, 0, 0, 0], o + 8);
    });
    this.lastSent = list.length;
    // (the count and the entries in use, or a zero count)
    if (list.length || this.sent) this.core.host.gpu.device.queue.writeBuffer(this.core.world.windBlows, 0, d, 0, 4 + list.length * ENTRY * 4);
    this.sent = list.length;
  }
}

/** Combine the two nearest entries of the same mode (the list is over the GPU's cap). */
function mergeNearest(list: Entry[]): void {
  let bi = -1;
  let bj = -1;
  let bd = Infinity;
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      if (list[i].mode !== list[j].mode) continue;
      const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
      if (d < bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  // (five modes, MAX_BLOWS ≥ 5: there's always a pair)
  if (bi < 0) throw new Error('world.wind: could not merge entries');
  const a = list[bi];
  const b = list[bj];
  const wa = a.strength + 1e-6;
  const wb = b.strength + 1e-6;
  const x = (a.x * wa + b.x * wb) / (wa + wb);
  const y = (a.y * wa + b.y * wb) / (wa + wb);
  const r = Math.max(Math.hypot(a.x - x, a.y - y) + a.radius, Math.hypot(b.x - x, b.y - y) + b.radius);
  a.x = x;
  a.y = y;
  a.radius = r;
  a.strength = Math.max(a.strength, b.strength);
  a.dir = norm([a.dir[0] * wa + b.dir[0] * wb, a.dir[1] * wa + b.dir[1] * wb]);
  // (strokes: the longer length, and the paint of both)
  a.len = Math.max(a.len, b.len);
  a.pass = Math.max(a.pass, b.pass);
  list.splice(bj, 1);
}
