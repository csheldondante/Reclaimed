// (round 128o, DA-B19) `scene.mapHeightAt` is the map as generated — not the ground as it is (nothing dug or built is
// in it). Only the two that ask every frame and need the lie of the land may use it: the far land's focus
// (scenes/level/stream-setup.ts) and the free camera's floor (scenes/level/camera-moves.ts). Anything that acts on
// the ground — a tap, a turn, a placement, the fortress — asks `scene.heightAt`, which says "not read yet" (null)
// rather than answer with a stand-in.
import { describe, expect, it } from 'vitest';
import { readSrc, srcFiles } from '../support/source-scan';

const ALLOWED = new Set(['scenes/level/stream-setup.ts', 'scenes/level/camera-moves.ts']);

describe('mapHeightAt (the map as generated)', () => {
  it('is used only by the far land\'s focus and the flyer\'s floor', () => {
    const users: string[] = [];
    for (const f of srcFiles()) {
      if (f === 'scenes/level.ts') continue;
      const n = (readSrc(f).match(/\bmapHeightAt\b/g) ?? []).length;
      if (n) users.push(`${f} ×${n}`);
    }
    expect(users.filter((u) => !ALLOWED.has(u.split(' ')[0]))).toEqual([]);
    expect(users.map((u) => u.split(' ')[0]).sort()).toEqual([...ALLOWED].sort());
    for (const f of ALLOWED) expect((readSrc(f).match(/\bmapHeightAt\b/g) ?? []).length, f).toBe(1);
  });
});
