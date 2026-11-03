// ---- play/core/swordplay.ts -------------------------------------------------------------------------------------
// (knight, round 128) The knight's right thumb, read as it's drawn (ported from GameplayGM runtimes/iso-adventure
// src/app/gestures.ts Blade, Slingshot and Fling, @ runtime/iso-adventure; thresholds unchanged — they're in screen px
// and seconds, tuned for thumbs there and the same thumbs here). Pure: screen samples in, events out, so it's tested
// by feeding it strokes (swordplay.test.ts).
//   sword   a swipe strikes the moment it's 30 px long, that way (no need to lift: the slash comes under the thumb);
//           one strike a touch (lift to strike again), so a circle drawn isn't a string of swings; a circle drawn
//           (300° one way over 90 px) is the spin. Two strikes close in time and direction are a double: the lunge.
//   bow     drag back from where the thumb landed to draw: the shot goes the OPPOSITE way to the drag, the draw is
//           capped by how far it's pulled (full at 120 px); let go to loose. Drawn and let go at once a long way
//           (under 0.18 s, 50 px) isn't a shot but a flick: a dodge roll that way.
//   fling   (spinning) drag and let go: the spinning top is flicked that way, as hard as the drag was long.
// Directions are on the screen (x right, y down); the hero turns them onto the ground (PlayInput.basis).

import type { Pt } from './gestures';

const deg = (d: number) => (d * Math.PI) / 180;

/** Thresholds in CSS px and seconds (iso-adventure gestures.ts TOUCH, the ones these gestures use). */
export const THUMB = {
  tapMove: 14,
  tapTime: 0.3,
  /** a swipe this long (px) strikes */
  swipe: 30,
  /** the bow: drawn past this (px), full at this */
  slingDead: 20,
  slingFull: 120,
  /** a fling this long (px) is a full-power one */
  flingFull: 170,
  /** a stroke turning this far one way over at least this long is a circle */
  circleTurn: deg(300),
  circleLength: 90,
  /** a bow drag let go this soon (s) and this far (px) is a flick: a roll */
  rollTime: 0.18,
  rollMove: 50,
};

/** Two strikes this close together (s), within this angle, make the second a lunge (iso-adventure weapons.ts LUNGE). */
export const DOUBLE = { window: 0.3, maxTurn: deg(40) };

export type ThumbMode = 'sword' | 'bow' | 'fling';

export interface Sample {
  at: Pt;
  /** seconds */
  t: number;
}

export type ThumbEvent =
  /** a slash that way (screen, unit) */
  | { kind: 'strike'; dir: Pt; t: number }
  /** a circle drawn: the spin */
  | { kind: 'spin' }
  /** the bow let go: the shot's way (screen, unit) and how far it was drawn (0..1) */
  | { kind: 'loose'; dir: Pt; draw: number }
  /** a quick flick on the bow: a dodge roll that way (screen, unit) */
  | { kind: 'roll'; dir: Pt }
  /** spinning: flicked that way (screen, unit), 0..1 */
  | { kind: 'fling'; dir: Pt; power: number }
  | { kind: 'tap'; at: Pt };

/**
 * How far a stroke has turned, one way: segments at least `step` px long are compared and their signed turns add up.
 * A circle turns ±2π; a zigzag cancels out. (iso-adventure gestures.ts Winding)
 */
export class Winding {
  turn = 0;
  length = 0;
  private from: Pt;
  private dir: Pt | null = null;
  constructor(
    start: Pt,
    private step = 8,
  ) {
    this.from = [start[0], start[1]];
  }
  add(p: Pt): void {
    const dx = p[0] - this.from[0];
    const dy = p[1] - this.from[1];
    const d = Math.hypot(dx, dy);
    if (d < this.step) return;
    const dir: Pt = [dx / d, dy / d];
    if (this.dir) this.turn += Math.atan2(this.dir[0] * dir[1] - this.dir[1] * dir[0], this.dir[0] * dir[0] + this.dir[1] * dir[1]);
    this.dir = dir;
    this.length += d;
    this.from = [p[0], p[1]];
  }
  get circle(): boolean {
    return Math.abs(this.turn) >= THUMB.circleTurn && this.length >= THUMB.circleLength;
  }
}

/** One touch of the right thumb, read for the knight's weapon in hand when it went down. */
export class ThumbReader {
  readonly events: ThumbEvent[] = [];
  /** the bow while drawn: the shot's way (screen, unit) and the draw's cap 0..1; null: not drawn */
  drawing: { dir: Pt; draw: number } | null = null;
  private moved = 0;
  private struck = false;
  private spun = false;
  private drawn = false;
  private winding: Winding;
  private last: Sample;

  constructor(
    readonly mode: ThumbMode,
    readonly start: Sample,
  ) {
    this.winding = new Winding(start.at);
    this.last = start;
  }

  move(s: Sample): void {
    this.last = s;
    const dx = s.at[0] - this.start.at[0];
    const dy = s.at[1] - this.start.at[1];
    const d = Math.hypot(dx, dy);
    this.moved = Math.max(this.moved, d);
    if (this.mode === 'sword') {
      this.winding.add(s.at);
      if (!this.spun && this.winding.circle) {
        this.spun = true;
        this.events.push({ kind: 'spin' });
      }
      if (this.struck || d < THUMB.swipe) return;
      this.struck = true;
      this.events.push({ kind: 'strike', dir: [dx / d, dy / d], t: s.t });
    } else if (this.mode === 'bow') {
      if (!this.drawn && d < THUMB.slingDead) return;
      this.drawn = true;
      // (back inside the dead zone: the aim held, the draw eased off to nothing — a release then fizzles)
      const dir = d >= THUMB.slingDead ? ([-dx / d, -dy / d] as Pt) : (this.drawing?.dir ?? ([0, -1] as Pt));
      this.drawing = { dir, draw: d < THUMB.slingDead ? 0 : Math.min(1, d / THUMB.slingFull) };
    }
  }

  end(s: Sample): void {
    this.move(s);
    const dx = s.at[0] - this.start.at[0];
    const dy = s.at[1] - this.start.at[1];
    const d = Math.hypot(dx, dy);
    const dt = s.t - this.start.t;
    const tap = this.moved < THUMB.tapMove && dt < THUMB.tapTime;
    if (this.mode === 'sword') {
      if (!this.struck && tap) this.events.push({ kind: 'tap', at: s.at });
    } else if (this.mode === 'bow') {
      if (!this.drawn && tap) this.events.push({ kind: 'tap', at: s.at });
      else if (this.drawn && dt < THUMB.rollTime && d >= THUMB.rollMove) this.events.push({ kind: 'roll', dir: [dx / d, dy / d] });
      else if (this.drawn && this.drawing) this.events.push({ kind: 'loose', dir: this.drawing.dir, draw: this.drawing.draw });
      this.drawing = null;
    } else {
      if (d >= THUMB.tapMove) this.events.push({ kind: 'fling', dir: [dx / d, dy / d], power: Math.min(1, d / THUMB.flingFull) });
      else if (tap) this.events.push({ kind: 'tap', at: s.at });
    }
  }

  /** the last sample it saw */
  get at(): Sample {
    return this.last;
  }

  /** take the events so far */
  drain(): ThumbEvent[] {
    return this.events.splice(0);
  }
}

/** Is `next` (a strike) the second of a double with `prev` — close in time and direction: the lunge. */
export function isDouble(prev: { dir: Pt; t: number } | null, next: { dir: Pt; t: number }): boolean {
  if (!prev || next.t - prev.t > DOUBLE.window || next.t < prev.t) return false;
  const dot = prev.dir[0] * next.dir[0] + prev.dir[1] * next.dir[1];
  return Math.acos(Math.max(-1, Math.min(1, dot))) <= DOUBLE.maxTurn;
}

/**
 * Sticky aim for the bow (iso-adventure aimassist.ts StickyAim): while the aim sweeps across a target it turns slower
 * than the thumb, so a target is easy to hold; it never lags the thumb by more than `maxLag` and catches up off target.
 * Angles in radians, on the ground.
 */
export const STICKY = { cone: deg(8), friction: 0.3, catchUp: 0.35, maxLag: deg(14), range: 16 };

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class StickyAim {
  private aim: number | null = null;
  private raw = 0;
  reset(): void {
    this.aim = null;
  }
  /** the thumb's aim angle and the angles toward targets in; the aim to use out */
  update(raw: number, targets: readonly number[]): number {
    if (this.aim === null) {
      this.aim = this.raw = raw;
      return raw;
    }
    const turn = wrap(raw - this.raw);
    this.raw = raw;
    const aim = this.aim;
    const onTarget = targets.some((t) => Math.abs(wrap(t - aim)) < STICKY.cone);
    let next = aim + turn * (onTarget ? STICKY.friction : 1);
    if (!onTarget) next += wrap(raw - next) * STICKY.catchUp;
    const lag = wrap(raw - next);
    if (Math.abs(lag) > STICKY.maxLag) next = raw - Math.sign(lag) * STICKY.maxLag;
    this.aim = wrap(next);
    return this.aim;
  }
}
