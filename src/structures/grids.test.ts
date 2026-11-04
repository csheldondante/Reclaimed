// (round 128g) The structures' grid table and slab room (structures/gpu.ts): pure parts.
import { describe, expect, test } from 'vitest';
import { gridApply, gridRow, RangeAlloc } from './gpu';

describe('grid rows', () => {
  test('a still, unturned grid is an offset (the window slide: only the row changes)', () => {
    expect(gridApply(gridRow({ pos: [10, 20, -30] }), [1, 2, 3])).toEqual([11, 22, -27]);
  });
  test('turned 30° about z, scaled: a point turns about the grid\'s origin, then moves', () => {
    const a = Math.PI / 6;
    const row = gridRow({ pos: [5, 0, 0], quat: [0, 0, Math.sin(a / 2), Math.cos(a / 2)], scale: 2 });
    const [x, y, z] = gridApply(row, [1, 0, 1]);
    expect(x).toBeCloseTo(5 + 2 * Math.cos(a));
    expect(y).toBeCloseTo(2 * Math.sin(a));
    expect(z).toBeCloseTo(2);
  });
  test('a quaternion is normalised; a zero one is an error', () => {
    const r = gridRow({ pos: [0, 0, 0], quat: [0, 0, 0, 3] });
    expect(Array.from(r.subarray(4))).toEqual([0, 0, 0, 1]);
    expect(() => gridRow({ pos: [0, 0, 0], quat: [0, 0, 0, 0] })).toThrow();
  });
});

describe('RangeAlloc (slab room)', () => {
  test('first fit; given back merges with its neighbours; grows at the end', () => {
    const a = new RangeAlloc(100);
    const x = a.take(30);
    const y = a.take(30);
    const z = a.take(30);
    expect([x, y, z]).toEqual([0, 30, 60]);
    expect(a.take(20)).toBe(-1);
    a.give(y, 30);
    expect(a.take(40)).toBe(-1);
    a.give(x, 30);
    expect(a.free).toEqual([[0, 60], [90, 10]]);
    expect(a.take(50)).toBe(0);
    a.grow(200);
    expect(a.free).toEqual([[50, 10], [90, 110]]);
    a.give(0, 50);
    a.give(60, 30);
    expect(a.free).toEqual([[0, 200]]);
  });
});
