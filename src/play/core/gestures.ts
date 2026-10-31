// (ported from GameplayGM runtimes/hoverbike/src/gestures.ts @ experiment/slice 515fcd9, round 117: the play layer moved into Reclaimed)
// Reading the right thumb, in screen pixels: a stroke from press to release. While it's held
// it's a drag (where it started, where it is); let go, it's read as one gesture:
//   tap     let go soon, hardly moved
//   flick   let go soon after a quick, straight move: its direction and how hard
//   circle  it turned all the way round (iso-adventure's gestures.ts: the signed turns add
//           up to ±2π for a circle, a zigzag cancels out)
//   drag    anything else (what it did while held was the point)
// Pure: samples in, a gesture out.

export type Pt = [number, number];

export const TOUCH = {
  /** a tap: let go within this (s), moved no further than this (px) */
  tapTime: 0.3,
  tapPx: 14,
  /** a flick: let go within this (s), at least this far (px) */
  flickTime: 0.35,
  flickPx: 35,
  /** a circle: turned at least this far one way (radians) over at least this long a path (px) */
  circleTurn: (300 * Math.PI) / 180,
  circlePx: 120,
};

export type Gesture =
  | { kind: "tap"; at: Pt }
  | { kind: "flick"; from: Pt; to: Pt; /** unit screen direction */ dir: Pt; /** px/s */ speed: number }
  | { kind: "circle"; centre: Pt; /** counter-clockwise on screen */ ccw: boolean; /** how many times round (one way) */ turns: number }
  | { kind: "drag"; from: Pt; to: Pt };

export class Stroke {
  readonly samples: { at: Pt; t: number }[] = [];
  /** signed turning so far (radians), and the path's length (px) */
  turn = 0;
  length = 0;

  constructor(at: Pt, t: number) {
    this.samples.push({ at, t });
  }
  get from(): Pt {
    return this.samples[0].at;
  }
  get at(): Pt {
    return this.samples[this.samples.length - 1].at;
  }
  move(at: Pt, t: number): void {
    const n = this.samples.length;
    const last = this.samples[n - 1].at;
    const step = Math.hypot(at[0] - last[0], at[1] - last[1]);
    if (step < 2) return;
    if (n >= 2) {
      const prev = this.samples[n - 2].at;
      const a0 = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
      const a1 = Math.atan2(at[1] - last[1], at[0] - last[0]);
      this.turn += Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
    }
    this.length += step;
    this.samples.push({ at, t });
  }
  /** What it was, let go at time `t`. */
  end(t: number): Gesture {
    const from = this.from;
    const to = this.at;
    const dt = t - this.samples[0].t;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const d = Math.hypot(dx, dy);
    if (Math.abs(this.turn) >= TOUCH.circleTurn && this.length >= TOUCH.circlePx) {
      let cx = 0;
      let cy = 0;
      for (const s of this.samples) {
        cx += s.at[0];
        cy += s.at[1];
      }
      // (screen y runs down, so a positive turn is clockwise on screen)
      return { kind: "circle", centre: [cx / this.samples.length, cy / this.samples.length], ccw: this.turn < 0, turns: Math.abs(this.turn) / (2 * Math.PI) };
    }
    if (dt <= TOUCH.tapTime && d <= TOUCH.tapPx) return { kind: "tap", at: from };
    if (dt <= TOUCH.flickTime && d >= TOUCH.flickPx && d >= this.length * 0.7) return { kind: "flick", from, to, dir: [dx / d, dy / d], speed: d / Math.max(dt, 1e-3) };
    return { kind: "drag", from, to };
  }
}
