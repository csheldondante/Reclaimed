// (knight pass 2, round 128) The lunge through a crowd: the dash slips between bodies and doesn't end inside one; the
// blade knocks what it hits aside, out of the dash's line.
import { describe, expect, it } from 'vitest';
import { aside, slip, SLIP } from './slip';
import type { Pt } from './gestures';

describe('slip', () => {
  it('nothing in the way: the dash as given', () => {
    const s = slip([0, 0], [1, 0], 1.6, [[0, 5], [-3, 0]]);
    expect(s.dir[0]).toBeCloseTo(1, 6);
    expect(s.dist).toBeCloseTo(1.6, 6);
  });

  it('a body just left of the line turns the dash right (a little), toward the room', () => {
    const s = slip([0, 0], [1, 0], 1.6, [[1, 0.3]]);
    expect(s.dir[1]).toBeLessThan(0);
    expect(Math.abs(Math.atan2(s.dir[1], s.dir[0]))).toBeLessThanOrEqual(SLIP.maxTurn + 1e-9);
  });

  it('a dash that would end inside a body carries on past it, no further than `extend`', () => {
    const s = slip([0, 0], [1, 0], 1.6, [[1.6, 0.05]]);
    const end: Pt = [s.dir[0] * s.dist, s.dir[1] * s.dist];
    expect(Math.hypot(end[0] - 1.6, end[1] - 0.05)).toBeGreaterThanOrEqual(SLIP.touch - 1e-6);
    expect(s.dist).toBeLessThanOrEqual(1.6 + SLIP.extend + 1e-9);
  });

  it('bodies on both sides of a gap: it goes through the gap', () => {
    const s = slip([0, 0], [1, 0], 2, [[1.2, 0.75], [1.2, -0.75]]);
    expect(Math.abs(s.dir[1])).toBeLessThan(0.05);
  });
});

describe('aside', () => {
  it('a body off to the left of the dash is knocked left and a little ahead', () => {
    const k = aside([Math.SQRT1_2, Math.SQRT1_2], [1, 0]);
    expect(k[1]).toBeGreaterThan(0.8);
    expect(k[0]).toBeGreaterThan(0.2);
  });
  it('dead ahead: knocked to one side, not straight on along the line', () => {
    const k = aside([1, 0], [1, 0]);
    expect(Math.abs(k[1])).toBeGreaterThan(0.85);
  });
});
