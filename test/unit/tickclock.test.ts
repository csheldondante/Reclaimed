// The tick clock (sim/tickclock.ts, round 114 framepace FP4): how many sim ticks a rendered frame runs. Written from
// its contract: at the tick's own display rate a frame runs exactly one tick whatever the jitter (the Pixel 9a's
// two-tick frames were the ones that missed a vsync); only the display's drift is paid back, a tick at a time, never
// two fixes within FIX_EVERY (20) frames; a missed vsync, a tick the planner cut and a paused frame are dropped, not
// owed. At any other rate or speed: the accumulator.
import { describe, expect, test } from 'vitest';
import { TickClock, tickModeFrom } from '../../src/sim/tickclock';
import { TICK_HZ } from '../../src/sim/flow';

const DT = 1 / TICK_HZ;

/** a seeded jitter in [-a, a] */
function jitter(seed: number, a: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296 - 0.5) * 2 * a;
  };
}

/** run `frames` frames of `interval()` seconds each; ticks per frame */
function run(c: TickClock, frames: number, interval: () => number, speed = 1, maxTicks = 4, keep = DT): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) out.push(c.take(interval() * speed, speed, maxTicks, keep));
  return out;
}

describe('locked (the default)', () => {
  test('locks once ten frames show the display at the tick rate', () => {
    const c = new TickClock();
    run(c, 9, () => DT);
    expect(Number.isNaN(c.displayDt())).toBe(true);
    expect(c.locked).toBe(false);
    run(c, 1, () => DT);
    expect(c.locked).toBe(true);
  });

  test('a jittery 60 Hz display runs exactly one tick a frame', () => {
    const c = new TickClock();
    run(c, 10, () => DT);
    // (the jitter is the frame's timestamp's, ±2 ms: an interval is the difference of two — a late frame's long
    // interval is followed by a short one)
    const j = jitter(1, 0.002);
    let prev = 0;
    const ticks = run(c, 600, () => {
      const e = j();
      const dt = DT + e - prev;
      prev = e;
      return dt;
    });
    expect(c.stats.lockedFrames).toBeGreaterThanOrEqual(600);
    expect(ticks.filter((n) => n !== 1)).toEqual([]);
  });

  test("a display a little slow is paid back a tick at a time, never two fixes within 20 frames", () => {
    const c = new TickClock();
    // (59.4 Hz: within the 12 % that locks; the sim owes 1 % a frame)
    const dt = 1 / 59.4;
    const ticks = run(c, 1200, () => dt);
    const fixes = ticks.map((n, i) => (n !== 1 ? i : -1)).filter((i) => i >= 10);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(2);
    for (let k = 1; k < fixes.length; k++) expect(fixes[k] - fixes[k - 1]).toBeGreaterThanOrEqual(20);
    // (the display runs slow: every fix is an extra tick, none skipped — and the sim keeps up with its time)
    expect(c.stats.skipped).toBe(0);
    const simTime = 1200 * dt;
    expect(Math.abs(c.stats.ticks * DT + c.acc - simTime)).toBeLessThan(1e-6 + c.stats.droppedS + c.stats.missedS);
    expect(c.acc).toBeLessThanOrEqual(3 * DT + 1e-9);
  });

  test('a display a little fast skips a tick now and then', () => {
    const c = new TickClock();
    run(c, 1200, () => 1 / 60.6);
    expect(c.stats.skipped).toBeGreaterThan(0);
    expect(c.stats.extra).toBe(0);
  });

  test('a missed vsync is a pause: one tick, the extra interval dropped and counted', () => {
    const c = new TickClock();
    run(c, 30, () => DT);
    const before = c.acc;
    // (a median of 60 Hz intervals: still locked for the long one)
    const n = c.take(2 * DT, 1, 4, DT);
    expect(c.locked).toBe(true);
    expect(n).toBe(1);
    expect(c.stats.missedS).toBeCloseTo(DT, 9);
    expect(c.acc).toBeCloseTo(before, 9);
  });

  test("a tick the planner cut (maxTicks 0) isn't owed", () => {
    const c = new TickClock();
    run(c, 30, () => DT);
    const n = c.take(DT, 1, 0, DT);
    expect(n).toBe(0);
    expect(c.stats.cutS).toBeCloseTo(DT, 9);
    // (the next frames: one tick each, not two to catch up)
    expect(run(c, 5, () => DT)).toEqual([1, 1, 1, 1, 1]);
  });

  test('a paused frame keeps the display measured and owes nothing', () => {
    const c = new TickClock();
    run(c, 30, () => DT);
    for (let i = 0; i < 10; i++) c.pause(DT, 1);
    expect(c.stats.pausedFrames).toBe(10);
    expect(c.stats.pausedS).toBeCloseTo(10 * DT, 9);
    expect(run(c, 3, () => DT)).toEqual([1, 1, 1]);
    expect(c.locked).toBe(true);
  });

  test('what is owed is capped at half a second', () => {
    const c = new TickClock();
    // (locked on 60 Hz, then frames just under the missed-vsync line: each owes almost half a tick)
    run(c, 31, () => DT);
    for (let i = 0; i < 2000; i++) {
      c.take(1.45 * DT, 1, 1, DT);
      expect(c.acc).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
});

describe('the accumulator (other rates, other speeds, ?tick=accum)', () => {
  test('a 120 Hz display runs a tick every other frame', () => {
    const c = new TickClock();
    const ticks = run(c, 240, () => 1 / 120);
    expect(c.stats.lockedFrames).toBe(0);
    expect(ticks.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(119);
    expect(ticks.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120);
    expect(Math.max(...ticks)).toBe(1);
  });

  test('at speed 2 it is never locked and runs two ticks a 60 Hz frame', () => {
    const c = new TickClock();
    const ticks = run(c, 120, () => DT, 2);
    expect(c.stats.lockedFrames).toBe(0);
    expect(ticks.slice(10).every((n) => n === 2)).toBe(true);
  });

  test("a long frame runs at most maxTicks and keeps only `keep` of what's left", () => {
    const c = new TickClock('accum');
    const n = c.take(1, 1, 3, 0.5);
    expect(n).toBe(3);
    expect(c.acc).toBeCloseTo(0.5, 9);
    expect(c.stats.droppedS).toBeCloseTo(1 - 3 * DT - 0.5, 9);
  });

  test('accum mode never locks, even at 60 Hz', () => {
    const c = new TickClock('accum');
    run(c, 100, () => DT);
    expect(c.stats.lockedFrames).toBe(0);
  });
});

test('tickModeFrom: locked by default, accum on ask, anything else an error', () => {
  expect(tickModeFrom(new URLSearchParams())).toBe('locked');
  expect(tickModeFrom(new URLSearchParams('tick=accum'))).toBe('accum');
  expect(() => tickModeFrom(new URLSearchParams('tick=fast'))).toThrow(/locked or accum/);
});
