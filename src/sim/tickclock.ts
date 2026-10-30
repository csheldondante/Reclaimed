// Round 114 (framepace, FP4): how many sim ticks a rendered frame runs. The Pixel 9a's parked frames that missed a
// vsync were the ones running two ticks (1.5-2 on average against 0.8; with the sim off, or frames in flight 3, none
// missed): a fixed-step accumulator against a display at the tick's own rate drifts in phase, frame to frame jitter
// puts it either side of a tick boundary, and it runs 0, 1 or 2 ticks a frame (the phone: 20% of frames 0, 2% 2).
//
// 'locked' (the default): when the display's measured rate is the tick rate (the median rAF interval of the last
// frames within 12% of TICK_DT) a frame runs exactly one tick — rendering first. Only the display's drift is paid
// back: what's owed (or run ahead) by intervals off the tick is kept in `acc`, and past a band (two ticks owed, one
// ahead) a tick is added or skipped, never two within FIX_EVERY frames. (v2, round 114, the phone's v7 run: time the
// rendering took is a pause, not a debt — the user puts rendering before simulation — and paying it back made 2-tick
// frames, the slow ones: a missed vsync's extra interval, a tick the planner cut (`maxTicks` 0) and a frame the sim
// was held (`pause`: the streamer busy) are dropped and counted, `stats.missedS`, `cutS`, `pausedS`.)
// At any other display rate (90/120 Hz, 30 Hz) or speed it's the accumulator, as before.
// ?tick=accum: the accumulator always, to compare.

import { TICK_HZ } from './flow';

const TICK_DT = 1 / TICK_HZ;

export type TickMode = 'locked' | 'accum';

const N = 31;
const TOL = 0.12;
const FIX_EVERY = 20;
const MAX_OWED = 0.5;

export class TickClock {
  mode: TickMode;
  /** sim time owed (s): positive, ticks not yet run */
  acc = 0;
  /** this frame ran locked */
  locked = false;
  readonly stats = { frames: 0, lockedFrames: 0, ticks: 0, extra: 0, skipped: 0, droppedS: 0, missedS: 0, cutS: 0, pausedS: 0, pausedFrames: 0 };
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

  /** a frame the sim doesn't run at all (the streamer busy, ?skip=sim): its time dropped, its interval still the display's */
  pause(simDt: number, speed: number): void {
    if (speed > 0) {
      this.dts.push(simDt / speed);
      if (this.dts.length > N) this.dts.shift();
    }
    this.stats.pausedFrames++;
    this.stats.pausedS += simDt;
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
    const d = this.displayDt();
    this.locked = this.mode === 'locked' && speed === 1 && Math.abs(d - TICK_DT) <= TOL * TICK_DT;
    let n = 0;
    if (this.locked) {
      this.stats.lockedFrames++;
      this.sinceFix++;
      // (a missed vsync — the interval past 1.5 ticks — is a pause: one tick's time kept, the rest dropped)
      let dt = simDt;
      if (dt > 1.5 * TICK_DT) {
        this.stats.missedS += dt - TICK_DT;
        dt = TICK_DT;
      }
      this.acc += dt;
      n = 1;
      // (acc after one tick: what's owed; the band [-TICK_DT, 2 TICK_DT] — one tick of either way is jitter)
      const owed = this.acc - TICK_DT;
      if (this.sinceFix >= FIX_EVERY) {
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
      // (ticks the planner cut: dropped as run — a pause, not a debt)
      if (n > maxTicks) this.stats.cutS += (n - maxTicks) * TICK_DT;
      this.acc -= n * TICK_DT;
      n = Math.min(n, maxTicks);
      if (this.acc > MAX_OWED) {
        this.stats.droppedS += this.acc - MAX_OWED;
        this.acc = MAX_OWED;
      }
    } else {
      this.acc += simDt;
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
