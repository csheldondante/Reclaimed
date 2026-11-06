// The units' stride at fast-forward (agents/stepplan.ts, round 128o DA-B22): in a frame of n ticks the steps cover
// every tick once, none spans more than the stride, the frame's last tick always steps, and a frame of one tick is the
// tick as before.
import { describe, expect, it } from 'vitest';
import { stepPlan } from '../../src/agents/stepplan';

function plan(n: number, stride: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = stepPlan(n, i, stride);
    if (p.step) out.push(p.ticks);
    else expect(p.ticks).toBe(0);
  }
  return out;
}

describe('stepPlan', () => {
  it('a frame of one tick steps once over it', () => {
    for (const s of [1, 4, 9]) expect(plan(1, s)).toEqual([1]);
  });
  it('a stride of one steps every tick', () => {
    expect(plan(16, 1)).toEqual(new Array(16).fill(1));
  });
  it('strides, then the remainder on the last tick', () => {
    expect(plan(16, 5)).toEqual([5, 5, 5, 1]);
    expect(plan(16, 9)).toEqual([9, 7]);
    expect(plan(16, 4)).toEqual([4, 4, 4, 4]);
    expect(plan(3, 9)).toEqual([3]);
  });
  it('covers every tick once, none past the stride, the last always stepping', () => {
    for (let n = 1; n <= 40; n++)
      for (let s = 1; s <= 12; s++) {
        const p = plan(n, s);
        expect(p.reduce((a, b) => a + b, 0)).toBe(n);
        expect(Math.max(...p)).toBeLessThanOrEqual(Math.min(s, n));
        expect(stepPlan(n, n - 1, s).step).toBe(true);
      }
  });
});
