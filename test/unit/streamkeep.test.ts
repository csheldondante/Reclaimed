// (round 128m, townlab C; onetown: re-based on the town's site box) The window keeps the town's box
// (scenes/streamer/keep.ts): the window opened wholly round the box at the start, no slide that leaves it, and a loud
// error when it can't fit.
import { describe, expect, it } from 'vitest';
import { keepAllows, keepHeld, windowHolding } from '../../src/scenes/streamer/keep';

describe('the window keeps the town', () => {
  // the user's start town (?town=1&fortress=1&q=low): its site box 14400,4480, 256 a side (data/lab/town.rclt)
  const box = { x0: 14400, y0: 4480, x1: 14656, y1: 4736 };

  it("opens round the user's box: as near the wanted origin as holds it", () => {
    // (the window the town's middle wanted, 320 a side, ran past the box's bottom edge: moved down to hold it)
    const o = windowHolding(box, 320, 320, [14400, 4352]);
    expect(o).toEqual([14400, 4416]);
    expect(keepHeld(o, 320, 320, box)).toBe(true);
    // (a wanted origin that already holds it is kept)
    expect(windowHolding(box, 384, 384, [14336, 4416])).toEqual([14336, 4416]);
    // (a window just the box's size: the box's origin)
    expect(windowHolding(box, 256, 256, [14272, 4224])).toEqual([14400, 4480]);
  });

  it('is a loud error when the box is bigger than the window', () => {
    expect(() => windowHolding(box, 192, 320, [14400, 4416])).toThrow(/doesn't fit in the window \(192 x 320\)/);
  });

  it('allows the slides that keep the rect in the window and no others', () => {
    const origin: [number, number] = [14400, 4416];
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
