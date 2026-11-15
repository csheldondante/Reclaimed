// The model store's word arena (src/engine/sdf/arena.ts): ranges never overlap, freed room is used again and merges.
import { expect, test } from 'vitest';
import { Arena } from '../../src/engine/sdf/arena';

test('ranges come from the end, then from holes that fit; freed neighbours merge; the end comes back', () => {
  const a = new Arena();
  const x = a.alloc(10);
  const y = a.alloc(20);
  const z = a.alloc(5);
  expect([x, y, z, a.end]).toEqual([0, 10, 30, 35]);
  a.free(y, 20);
  expect(a.holeWords).toBe(20);
  // a smaller range takes the hole's start; a bigger one goes to the end
  expect(a.alloc(8)).toBe(10);
  expect(a.alloc(13)).toBe(35);
  expect(a.alloc(12)).toBe(18);
  expect(a.holeWords).toBe(0);
  // neighbours merge into one hole a bigger range fits
  a.free(10, 8);
  a.free(18, 12);
  expect(a.alloc(20)).toBe(10);
  // the last ranges freed give the end back
  a.free(35, 13);
  expect(a.end).toBe(35);
  a.free(30, 5);
  expect(a.end).toBe(30);
});

test('freeing what is not in use throws', () => {
  const a = new Arena();
  a.alloc(10);
  a.free(2, 4);
  expect(() => a.free(4, 4)).toThrow();
  expect(() => a.free(8, 8)).toThrow();
});

test('random use: no two live ranges overlap', () => {
  const a = new Arena();
  const live: { at: number; n: number }[] = [];
  let s = 7;
  const r = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let k = 0; k < 2000; k++) {
    if (live.length && r() < 0.45) {
      const [x] = live.splice(Math.floor(r() * live.length), 1);
      a.free(x.at, x.n);
    } else {
      const n = 1 + Math.floor(r() * 50);
      live.push({ at: a.alloc(n), n });
    }
    const sorted = [...live].sort((p, q) => p.at - q.at);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1].at + sorted[i - 1].n).toBeLessThanOrEqual(sorted[i].at);
    expect(sorted.length ? sorted[sorted.length - 1].at + sorted[sorted.length - 1].n : 0).toBeLessThanOrEqual(a.end);
  }
});
