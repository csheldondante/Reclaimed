// (round 128l, m4: the attack wave, part B) The defence's rules (defence.ts): how the soldiers split between the gate
// and the wall, an arrow's flight (the chip drawn lands where the arrow does), and when it hits.
import { describe, expect, it } from 'vitest';
import { ARROW, arrowFlight, arrowHits, swordsOf } from './defence';

describe('the posts', () => {
  it('a third of the soldiers hold the gate, at least one of two or more; one soldier shoots', () => {
    expect([0, 1, 2, 3, 5, 6, 9].map(swordsOf)).toEqual([0, 0, 1, 1, 1, 2, 3]);
  });
});

describe('arrows', () => {
  it('fly at ARROW.speed, and the chip thrown on their lob lands on the mark', () => {
    const from: [number, number, number] = [10, 10, 16];
    const to: [number, number, number] = [30, 4, 11];
    const { t, vel } = arrowFlight(from, to);
    expect(t).toBeCloseTo(Math.hypot(20, -6, -5) / ARROW.speed);
    const land = [from[0] + vel[0] * t, from[1] + vel[1] * t, from[2] + vel[2] * t - 0.5 * ARROW.gravity * t * t];
    for (let k = 0; k < 3; k++) expect(land[k]).toBeCloseTo(to[k]);
  });

  it('hit a mark still near where they were aimed, not one that ran on', () => {
    expect(arrowHits([5, 5, 10], [5.5, 5.4, 10.1])).toBe(true);
    expect(arrowHits([5, 5, 10], [5 + ARROW.hitR + 0.3, 5, 10])).toBe(false);
    // (on the wall-walk over it: not the same mark)
    expect(arrowHits([5, 5, 10], [5, 5, 14])).toBe(false);
  });
});
