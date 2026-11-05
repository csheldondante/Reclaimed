// (round 128m, townlab) The window keeps the fortress's box (scenes/streamer/keep.ts): the box placed wholly in the
// window at the start, no slide that leaves it, and a loud error when it can't fit.
import { describe, expect, it } from 'vitest';
import { boxInWindow, keepAllows, keepHeld } from '../../src/scenes/streamer/keep';
import { FORTRESS_BOX, FORTRESS_WINDOW, KEEP_MARGIN } from '../../src/fortress/host';

describe('the window keeps the fortress', () => {
  // the user's start town (?town=1&fortress=1&q=low): window origin 14400,4416, 320 a side; the box wanted at 14432,4472
  const origin: [number, number] = [14400, 4416];

  it("puts the user's box wholly in the window (it ran 14 rows past the bottom edge)", () => {
    const want: [number, number] = [14432, 4472];
    expect(want[1] + FORTRESS_BOX.h).toBeGreaterThan(origin[1] + 320);
    const [x, y] = boxInWindow(want, FORTRESS_BOX, KEEP_MARGIN, origin, 320, 320);
    expect(x).toBe(14432);
    expect(y % 2).toBe(0);
    expect(y + FORTRESS_BOX.h + KEEP_MARGIN).toBeLessThanOrEqual(origin[1] + 320);
    expect(y - KEEP_MARGIN).toBeGreaterThanOrEqual(origin[1]);
    expect(keepHeld(origin, 320, 320, { x0: x - KEEP_MARGIN, y0: y - KEEP_MARGIN, x1: x + FORTRESS_BOX.w + KEEP_MARGIN, y1: y + FORTRESS_BOX.h + KEEP_MARGIN })).toBe(true);
  });

  it('keeps an even row going up when the lowest row is odd', () => {
    const [, y] = boxInWindow([0, 41], { w: 10, h: 10 }, 1, [0, 1], 64, 52);
    expect(y).toBe(40);
    const [, y2] = boxInWindow([0, 0], { w: 10, h: 10 }, 0, [1, 1], 64, 64);
    expect(y2).toBe(2);
  });

  it('is a loud error when the box and its margin are bigger than the window', () => {
    expect(() => boxInWindow([0, 0], FORTRESS_BOX, KEEP_MARGIN, [0, 0], 256, 256)).toThrow(/doesn't fit in the window \(256 x 256\): the window must be at least 320/);
    expect(FORTRESS_WINDOW).toBe(320);
  });

  it('allows the slides that keep the rect in the window and no others', () => {
    // (a 288-row rect in a 320-row window: no slide along y keeps it; along x, the one the slack allows)
    const k = { x0: 14428, y0: 4418, x1: 14676, y1: 4706 };
    expect(keepAllows(origin, 320, 320, k, 0, 64)).toBe(false);
    expect(keepAllows(origin, 320, 320, k, 0, -64)).toBe(false);
    expect(keepAllows(origin, 320, 320, k, 64, 0)).toBe(false);
    expect(keepAllows(origin, 320, 320, k, -64, 0)).toBe(false);
    const small = { x0: 14500, y0: 4500, x1: 14600, y1: 4600 };
    expect(keepAllows(origin, 320, 320, small, 64, 0)).toBe(true);
    expect(keepAllows(origin, 320, 320, small, 192, 0)).toBe(false);
    expect(keepAllows(origin, 320, 320, null, 640, 0)).toBe(true);
  });
});
