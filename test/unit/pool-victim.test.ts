// (merge122) The region pool's eviction: a travel's pinned destination is never evicted. The run's journey hung on
// "waiting" for ever when a full pool (POOL_CAP 32) evicted the destination it had precached (the merge122 gate).
import { describe, expect, it } from 'vitest';
import { poolVictim } from '../../src/scenes/pool-victim';

const q = (keep: string[] = []) => ({ keep: (k: string) => keep.includes(k), centre: [0, 0] as [number, number], near: [3, 3] as [number, number] });

describe('poolVictim', () => {
  it('the oldest region outside where the window is heading goes first', () => {
    expect(poolVictim(['1,1', '9,0', '0,9'], q())).toBe('9,0');
  });
  it('else the farthest', () => {
    expect(poolVictim(['1,1', '2,2', '0,1'], q())).toBe('2,2');
  });
  it("never one a job is on or a travel pinned: the far destination stays while the journey waits for it", () => {
    // the travel's destination 20 regions off, the oldest in the pool and outside: kept; the old window's left-behind goes
    const dest = ['20,20', '21,20', '20,21', '21,21'];
    expect(poolVictim([...dest, '5,0', '1,0'], q(dest))).toBe('5,0');
    // only pinned and near regions left: the farthest near one, never the pinned
    expect(poolVictim([...dest, '1,0', '2,1'], q(dest))).toBe('2,1');
    expect(poolVictim(dest, q(dest))).toBeNull();
  });
  it('the distance the short way round a wrapping world', () => {
    // (63 is 1 off 0 the short way round 64: near; 10 is outside)
    expect(poolVictim(['63,0', '10,0'], { ...q(), wrap: [64, 64] })).toBe('10,0');
  });
});
