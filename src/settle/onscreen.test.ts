// (round 128g) The screen decides what's drawn (onscreen.ts): a box's gap off the screen, and the plan with hysteresis.
import { describe, expect, test } from 'vitest';
import { BUILD, DROP, HIDE, planScreen, screenGap, SHOW, type ScreenEntry } from './onscreen';

/** an orthographic view of x, y in [-s, s] (z ignored), column-major */
function ortho(s: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1 / s;
  m[5] = 1 / s;
  m[10] = 0.001;
  m[15] = 1;
  return m;
}

describe('screenGap', () => {
  const vp = ortho(100);
  test('0 on screen, also when only a corner is', () => {
    expect(screenGap(vp, { x0: -10, y0: -10, x1: 10, y1: 10, z0: 0, z1: 5 })).toBe(0);
    expect(screenGap(vp, { x0: 90, y0: 90, x1: 300, y1: 300, z0: 0, z1: 5 })).toBe(0);
  });
  test('off screen: how far, in screens (the larger axis)', () => {
    // (its near edge at x 300: clip 3, two clip units — one screen — past the right edge)
    expect(screenGap(vp, { x0: 300, y0: 0, x1: 320, y1: 10, z0: 0, z1: 5 })).toBeCloseTo(1);
    expect(screenGap(vp, { x0: -10, y0: -150, x1: 10, y1: -120, z0: 0, z1: 5 })).toBeCloseTo(0.1);
  });
});

describe('planScreen', () => {
  const e = (id: string, gap: number, cached: boolean, shown: boolean): ScreenEntry => ({ id, gap, cached, shown });
  test('on screen is always shown, its pieces made at once whatever the budget', () => {
    const p = planScreen([e('a', 0, false, false), e('b', 0, false, false)], 0);
    expect([...p.show].sort()).toEqual(['a', 'b']);
    expect(p.build).toEqual(['a', 'b']);
  });
  test('hysteresis: shown from SHOW in, kept until past HIDE', () => {
    const mid = (SHOW + HIDE) / 2;
    expect(planScreen([e('a', mid, true, false)]).show.has('a')).toBe(false);
    expect(planScreen([e('a', mid, true, true)]).show.has('a')).toBe(true);
    expect(planScreen([e('a', HIDE + 0.01, true, true)]).show.has('a')).toBe(false);
    expect(planScreen([e('a', SHOW, true, false)]).show.has('a')).toBe(true);
  });
  test('ahead of the screen: the nearest made first, `budget` a frame', () => {
    const p = planScreen([e('far', BUILD - 0.01, false, false), e('near', HIDE + 0.05, false, false), e('out', BUILD + 0.5, false, false)], 1);
    expect(p.build).toEqual(['near']);
    expect(p.show.size).toBe(0);
  });
  test('let go only well off screen; a stale slab too', () => {
    expect(planScreen([e('a', DROP + 0.1, true, false)]).drop).toEqual(['a']);
    expect(planScreen([e('a', (BUILD + DROP) / 2, true, false)]).drop).toEqual([]);
    expect(planScreen([{ ...e('a', DROP + 0.1, false, false), held: true }]).drop).toEqual(['a']);
  });
  test('a pan back and forth over the threshold never flips what is shown', () => {
    let shown = false;
    let flips = 0;
    for (let t = 0; t < 200; t++) {
      const gap = SHOW + 0.05 * Math.sin(t / 3);
      const now = planScreen([e('a', gap, true, shown)]).show.has('a');
      if (now !== shown && t > 0) flips++;
      shown = now;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });
});
