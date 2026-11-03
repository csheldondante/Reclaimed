// (knight, round 128) The slash's aim lean: a swipe turns a little toward the enemy it most likely means.
import { describe, expect, it } from 'vitest';
import type { Pt } from './gestures';
import { leanAim } from './aim';

const deg = (d: number) => (d * Math.PI) / 180;
const at = (a: number, r: number): Pt => [Math.cos(deg(a)) * r, Math.sin(deg(a)) * r];
const angle = (d: Pt) => (Math.atan2(d[1], d[0]) * 180) / Math.PI;

describe('the aim lean', () => {
  const cone = deg(35);
  it('leans a swipe slightly toward an enemy 20° off it (a third of the way)', () => {
    const l = leanAim([0, 0], [1, 0], [at(20, 3)], cone, 4.5, 0.35);
    expect(l.i).toBe(0);
    expect(angle(l.dir)).toBeCloseTo(7, 5);
  });

  it('leaves a swipe alone with no enemy in its cone or reach', () => {
    for (const t of [at(60, 3), at(180, 2), at(10, 9)]) {
      const l = leanAim([0, 0], [1, 0], [t], cone, 4.5, 0.35);
      expect(l.i).toBeNull();
      expect(angle(l.dir)).toBeCloseTo(0, 5);
    }
  });

  it('of two, it leans to the one nearer the swipe\'s line', () => {
    const l = leanAim([0, 0], [0, 1], [at(60, 2), at(100, 4)], cone, 4.5, 0.5);
    expect(l.i).toBe(1);
    expect(angle(l.dir)).toBeCloseTo(95, 5);
  });
});
