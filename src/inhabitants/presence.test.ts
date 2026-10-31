import { describe, expect, it } from 'vitest';
import { presence } from './presence';

describe('presence', () => {
  it('a group inside one region counts there, threat by its species', () => {
    const p = presence([{ x: 15, y: 15, count: 3, threat: 0.8, spread: 2 }], { x0: 0, y0: 0, x1: 40, y1: 40 }, 10);
    expect(p.nx).toBe(4);
    expect(p.ny).toBe(4);
    expect(p.density[1 * 4 + 1]).toBeCloseTo(3, 5);
    expect(p.threat[1 * 4 + 1]).toBeCloseTo(2.4, 5);
    expect(p.density.reduce((a, b) => a + b, 0)).toBeCloseTo(3, 5);
  });
  it('a group across a border is split by overlap; outside the rect it is dropped', () => {
    const p = presence([{ x: 10, y: 5, count: 4, threat: 0, spread: 2 }], { x0: 0, y0: 0, x1: 20, y1: 10 }, 10);
    expect(p.density[0]).toBeCloseTo(2, 5);
    expect(p.density[1]).toBeCloseTo(2, 5);
    const q = presence([{ x: 100, y: 100, count: 4, threat: 1, spread: 2 }], { x0: 0, y0: 0, x1: 20, y1: 10 }, 10);
    expect(q.density.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('a bad cell is loud', () => {
    expect(() => presence([], { x0: 0, y0: 0, x1: 1, y1: 1 }, 0)).toThrow();
  });
});
