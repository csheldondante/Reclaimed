// Round 125 (forest): the understory model — cover, the canopy's height, the eased weight (src/forest/understory.ts).
import { describe, expect, test } from 'vitest';
import { canopyAt, canopyOver, Understory, type PlanTree } from './understory';

const elder = (x: number, y: number): PlanTree => ({ x, y, species: 'giant', trunk: 11, crown: 15 });
const birch = (x: number, y: number): PlanTree => ({ x, y, species: 'birch', trunk: 13, crown: 7 });

describe('understory', () => {
  test('open ground has no cover; under an elder there is, and its underside is its trunk', () => {
    expect(canopyAt([], 0, 0).cover).toBe(0);
    expect(canopyAt([elder(40, 0)], 0, 0).cover).toBe(0);
    const c = canopyAt([elder(3, 0)], 0, 0);
    expect(c.cover).toBeGreaterThan(0.7);
    expect(c.under).toBe(11);
  });

  test('crowns add up; the lowest underside wins', () => {
    const one = canopyAt([birch(4, 0)], 0, 0).cover;
    const two = canopyAt([birch(4, 0), birch(-4, 0)], 0, 0);
    expect(two.cover).toBeGreaterThan(one);
    expect(two.cover).toBeLessThanOrEqual(1);
    expect(canopyAt([elder(3, 0), birch(-2, 0)], 0, 0).under).toBe(11);
  });

  test('the disc average does not flicker next to a trunk', () => {
    const trees = [elder(0, 0), elder(14, 0), elder(7, 12)];
    const a = canopyOver(trees, 6.9, 4).cover;
    const b = canopyOver(trees, 7.1, 4).cover;
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  test('the weight eases in over about a second and out again', () => {
    const u = new Understory();
    const trees = [elder(0, 0), elder(14, 0), elder(7, 12), elder(-7, 12), elder(7, -12)];
    let w = 0;
    for (let i = 0; i < 6; i++) w = u.step(1 / 60, [5, 3, 10], trees).weight;
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(0.5);
    for (let i = 0; i < 120; i++) w = u.step(1 / 60, [5, 3, 10], trees).weight;
    expect(w).toBeGreaterThan(0.95);
    const look = u.step(1 / 60, [5, 3, 10], trees);
    expect(look.canopyZ).toBeGreaterThan(18);
    for (let i = 0; i < 180; i++) w = u.step(1 / 60, [80, 80, 10], trees).weight;
    expect(w).toBeLessThan(0.02);
  });

  test('force holds the weight (the lab)', () => {
    const u = new Understory();
    let w = 0;
    for (let i = 0; i < 200; i++) w = u.step(1 / 60, [0, 0, 0], [], 1).weight;
    expect(w).toBe(1);
  });
});
