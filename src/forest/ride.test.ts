// Round 125 (forest): the station's loop and its rider (src/forest/ride.ts).
import { expect, test } from 'vitest';
import { LoopRider, openWay, standLoop, type V2 } from './ride';

test('the loop is half in the stand, half out in the open', () => {
  const loop = standLoop({ at: [100, 100], out: [1, 0], trees: 10, elders: 5 });
  const inside = loop.filter((p) => Math.hypot(p[0] - 100, p[1] - 100) < 12).length;
  expect(inside).toBeGreaterThan(3);
  expect(loop.some((p) => p[0] > 128)).toBe(true);
});

test('the open way is the side with fewest trees', () => {
  // trees everywhere but to the south (y < 0)
  const w = openWay(0, 0, (x, y) => (y < -10 ? 0 : 5));
  expect(w[1]).toBeLessThan(-0.6);
});

test('the rider goes round the loop and does not cut across', () => {
  const loop = standLoop({ at: [0, 0], out: [1, 0], trees: 0, elders: 0 }, 17, 15, 36);
  const r = new LoopRider(loop, 5, 1);
  let at: V2 = r.start(0);
  let angle = 0;
  let prev = Math.atan2(at[1], at[0] - 15);
  for (let s = 0; s < 4000; s++) {
    const st = r.stick(at);
    at = [at[0] + st[0] * 0.05, at[1] + st[1] * 0.05];
    const a = Math.atan2(at[1], at[0] - 15);
    let d = a - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    angle += d;
    prev = a;
    // (it stays near the ring)
    expect(Math.abs(Math.hypot(at[0] - 15, at[1]) - 17)).toBeLessThan(3);
  }
  // 200 cells ridden on a ~107-cell loop: about two laps the same way round
  expect(angle).toBeGreaterThan(2 * Math.PI * 1.5);
});

test('the park spot stands in front of the trunk with most neighbours, toward the eye', async () => {
  const { parkSpot } = await import('./ride');
  const trunks: [number, number][] = [[0, 0], [10, 0], [0, 10], [60, 60]];
  const p = parkSpot(trunks, [Math.SQRT1_2, Math.SQRT1_2], 4)!;
  expect(Math.hypot(p[0] - 4 * Math.SQRT1_2, p[1] - 4 * Math.SQRT1_2)).toBeLessThan(1e-6);
  expect(parkSpot([], [1, 0])).toBeNull();
});
