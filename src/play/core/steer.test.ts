import { describe, expect, it } from 'vitest';
import { aroundSmall, corridor, freeRun, STEER_OFF, steerAssist, type SteerParams } from './steer';

/** flat at 0 with boxes [x0, y0, x1, y1, h] */
const boxes = (bs: [number, number, number, number, number][]) => (x: number, y: number) => {
  let h = 0;
  for (const [x0, y0, x1, y1, bh] of bs) if (x >= x0 && x < x1 && y >= y0 && y < y1) h = Math.max(h, bh);
  return h;
};
const ON: SteerParams = { ...STEER_OFF, corridor: 1, avoid: 1, magnet: 1 };
const deg = (r: number) => (r * 180) / Math.PI;

/** a channel 8 wide along +x that turns left (to +y) at x 40 */
const channel = boxes([
  [0, 52, 48, 60, 20], // the south wall, on past the turn
  [0, 68, 40, 140, 20], // the north wall, to the turn
  [48, 52, 60, 140, 20], // the far wall past the turn
]);

describe('the corridor', () => {
  it('a ray stops at the wall', () => {
    expect(freeRun(channel, 10, 64, 0, 60, 1)).toBeCloseTo(37.5, 0);
    expect(freeRun(channel, 10, 64, Math.PI / 2, 60, 1)).toBeLessThan(5);
  });

  it('near the turn, the open way is round it; narrow there', () => {
    const c = corridor(channel, [36, 64], 0, 20, (50 * Math.PI) / 180, 1);
    expect(deg(c.way)).toBeGreaterThan(20);
    expect(c.narrow).toBeGreaterThan(0.4);
  });

  it('open land: straight on, not narrow', () => {
    const c = corridor(boxes([]), [36, 64], 0, 20, (50 * Math.PI) / 180, 1);
    expect(c.way).toBeCloseTo(0, 6);
    expect(c.narrow).toBe(0);
  });
});

describe('avoidance', () => {
  const post = boxes([[30, 63, 31, 65, 3]]);
  it('a post dead ahead: round it; a wall: not', () => {
    const a = aroundSmall(post, [24, 64], 0, 10, 2.5, 1);
    expect(a).not.toBeNull();
    expect(Math.abs(deg(a!))).toBeGreaterThan(10);
    expect(aroundSmall(boxes([[30, 0, 32, 140, 9]]), [24, 64], 0, 10, 2.5, 1)).toBeNull();
    expect(aroundSmall(boxes([]), [24, 64], 0, 10, 2.5, 1)).toBeNull();
  });
});

describe('the assist blend: the player first', () => {
  it('a light stick (along the way) is bent toward the open way round the turn', () => {
    const o = steerAssist([1, 0], [41, 64], [20, 0], channel, [], 1, ON);
    expect(o.by).toBe('corridor');
    expect(deg(o.bend)).toBeGreaterThan(5);
    expect(Math.hypot(...o.dir)).toBeCloseTo(1, 6);
  });

  it('a strong stick wins at once: no bend, and it counts as fighting', () => {
    // (hauled right, 60° off its way, while the assist wants left)
    const o = steerAssist([Math.cos(-1.05), Math.sin(-1.05)], [36, 64], [20, 0], channel, [], 1, ON);
    expect(o.bend).toBe(0);
    expect(o.fought).toBe(true);
  });

  it('nothing to help with: the stick as it was', () => {
    const o = steerAssist([0.8, 0.1], [36, 64], [20, 0], boxes([]), [], 1, ON);
    expect(o.dir).toEqual([0.8, 0.1]);
    expect(o.by).toBeNull();
  });

  it('round a post, and toward a target in the cone', () => {
    const post = boxes([[30, 63, 31, 65, 3]]);
    const a = steerAssist([1, 0], [24, 64], [20, 0], post, [], 1, ON);
    expect(a.by).toBe('avoid');
    const m = steerAssist([1, 0], [24, 64], [20, 0], boxes([]), [[34, 67]], 1, ON);
    expect(m.by).toBe('magnet');
    expect(m.bend).toBeGreaterThan(0);
  });

  it('off (the defaults): never bends', () => {
    const o = steerAssist([1, 0], [36, 64], [20, 0], channel, [[40, 66]], 1, STEER_OFF);
    expect(o.bend).toBe(0);
  });
});
