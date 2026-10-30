// Round 114 (framepace, FP4): how many sim ticks a rendered frame runs. The Pixel 9a's parked frames that missed a
// vsync were the ones running two ticks (1.5-2 on average against 0.8; with the sim off, or frames in flight 3, none
// missed): a fixed-step accumulator against a display at the tick's own rate drifts in phase, frame to frame jitter
// puts it either side of a tick boundary, and it runs 0, 1 or 2 ticks a frame (the phone: 20% of frames 0, 2% 2).
//
// 'locked' (the default): when the display's measured rate is the tick rate (the median rAF interval of the last
// frames within 12% of TICK_DT) a frame runs exactly one tick — rendering first. Sim time stays true over the long
// run: the time owed (or run ahead) is kept in `acc` like the accumulator's, and once it's past a band (two ticks
// owed, one ahead) it's paid back one tick at a time, never on consecutive frames (every FIX_EVERY frames; every
// FIX_FAST once it's past 100 ms, a planner's cut). Past 0.5 s owed it's dropped, as the accumulator drops time
// rather than spiral. At any other display rate (90/120 Hz, 30 Hz) or speed it's the accumulator, as before.
// ?tick=accum: the accumulator always, to compare.

import { TICK_HZ } from './flow';

const TICK_DT = 1 / TICK_HZ;

export type TickMode = 'locked' | 'accum';

const N = 31;
const TOL = 0.12;
const FIX_EVERY = 20;
const FIX_FAST = 4;
const MAX_OWED = 0.5;

export class TickClock {
  mode: TickMode;
  /** sim time owed (s): positive, ticks not yet run */
  acc = 0;
  /** this frame ran locked */
  locked = false;
  readonly stats = { frames: 0, lockedFrames: 0, ticks: 0, extra: 0, skipped: 0, droppedS: 0 };
  private dts: number[] = [];
  private sinceFix = 0;

  constructor(mode: TickMode = 'locked') {
    this.mode = mode;
  }

  /** the display's frame interval (s), the median of the last frames; NaN till there are enough */
  displayDt(): number {
    if (this.dts.length < 10) return NaN;
    const a = [...this.dts].sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  /**
   * The ticks this frame runs, for `simDt` of sim time at `speed`; at most `maxTicks`. `keep`: the accumulator's time
   * kept when it hits `maxTicks` (TICK_DT, or the planner's 0.5 s).
   */
  take(simDt: number, speed: number, maxTicks: number, keep: number): number {
    if (speed > 0) {
      this.dts.push(simDt / speed);
      if (this.dts.length > N) this.dts.shift();
    }
    this.stats.frames++;
    this.acc += simDt;
    const d = this.displayDt();
    this.locked = this.mode === 'locked' && speed === 1 && Math.abs(d - TICK_DT) <= TOL * TICK_DT;
    let n = 0;
    if (this.locked) {
      this.stats.lockedFrames++;
      this.sinceFix++;
      n = 1;
      // (acc after one tick: what's owed; the band [-TICK_DT, 2 TICK_DT] — one tick of either way is jitter)
      const owed = this.acc - TICK_DT;
      const every = owed > 0.1 ? FIX_FAST : FIX_EVERY;
      if (this.sinceFix >= every) {
        if (owed > 2 * TICK_DT) {
          n = 2;
          this.sinceFix = 0;
          this.stats.extra++;
        } else if (owed < -TICK_DT) {
          n = 0;
          this.sinceFix = 0;
          this.stats.skipped++;
        }
      }
      n = Math.min(n, maxTicks);
      this.acc -= n * TICK_DT;
      if (this.acc > MAX_OWED) {
        this.stats.droppedS += this.acc - MAX_OWED;
        this.acc = MAX_OWED;
      }
    } else {
      while (this.acc >= TICK_DT && n < maxTicks) {
        this.acc -= TICK_DT;
        n++;
      }
      // drop time instead of spiralling (round 113: cut by the planner, up to half a second kept — caught up after)
      if (n === maxTicks && this.acc > keep) {
        this.stats.droppedS += this.acc - keep;
        this.acc = keep;
      }
    }
    this.stats.ticks += n;
    return n;
  }
}

/** ?tick=accum or locked (the default) */
export function tickModeFrom(params: URLSearchParams): TickMode {
  const v = params.get('tick') ?? 'locked';
  if (v !== 'locked' && v !== 'accum') throw new Error(`?tick=${v}: locked or accum`);
  return v;
}
