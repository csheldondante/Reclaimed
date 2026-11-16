// The shot's launch velocity (src/game/ballistic.ts; PQ9 the cannonball, PQ3 the engine's meteor): of the stated
// speed exactly, through the target under gravity, the flatter arc; out of range is refused, never given more speed.
import { expect, test } from 'vitest';
import { ballCells, launch, type V3 } from '../../src/game/ballistic';

const G = 9.8;
/** where a point launched at v from p is when it has gone the horizontal distance to q */
function arrive(p: V3, q: V3, v: V3): V3 {
  const t = Math.hypot(q[0] - p[0], q[1] - p[1]) / Math.hypot(v[0], v[1]);
  return [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + v[2] * t - 0.5 * G * t * t];
}

test('the shot has the stated speed and passes through the target', () => {
  for (const [from, to, speed] of [
    [[0, 0, 10], [40, 0, 4], 45],
    [[5, -3, 2], [-20, 30, 12], 30],
    [[0, 0, 100], [30, -22, 0], 60],
  ] as [V3, V3, number][]) {
    const v = launch(from, to, speed, G)!;
    expect(v).not.toBeNull();
    expect(Math.hypot(...v)).toBeCloseTo(speed, 6);
    const at = arrive(from, to, v);
    for (let a = 0; a < 3; a++) expect(at[a]).toBeCloseTo(to[a], 5);
  }
});

test('it is the flatter arc: on level ground the launch angle is under 45 degrees', () => {
  const v = launch([0, 0, 0], [50, 0, 0], 30, G)!;
  expect(v[2]).toBeGreaterThan(0);
  expect(v[2]).toBeLessThan(Math.hypot(v[0], v[1]));
});

test('out of range at the stated speed is refused', () => {
  // (the farthest a speed of 10 reaches on the level is v² / g = 10.2)
  expect(launch([0, 0, 0], [11, 0, 0], 10, G)).toBeNull();
  expect(launch([0, 0, 0], [10, 0, 0], 10, G)).not.toBeNull();
  expect(launch([0, 0, 0], [0, 0, 6], 10, G)).toBeNull();
  expect(launch([0, 0, 0], [0, 0, -6], 10, G)).toEqual([0, 0, -10]);
});

test('a ball of radius 2 is 57 cells, all of its material', () => {
  const c = ballCells(10, 10, 20, 2, 7);
  expect(c.length).toBe(57);
  expect(c.every((x) => x.mat === 7)).toBe(true);
});
