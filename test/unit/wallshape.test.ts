// (season life) The town wall's shape on the CPU from its saved words (citygen/wallshape.ts): posts on risen pieces,
// gates and the arterials through them, the rise round the ring from the first gate.
import { describe, expect, it } from 'vitest';
import { NB, segmentRise, WALL_H, wallGates, wallPosts } from '../../src/citygen/wallshape';

const bits = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];

/** a ring of radius 50 round (100, 100), ground at z 10; gates at 4 and 40 (arterials 0 and 2), segment 20 over water */
function words(): number[] {
  const w = new Array<number>(8 + 8 * NB).fill(0);
  w[0] = 1;
  w[1] = 2;
  w[2] = 4;
  for (let b = 0; b < NB; b++) {
    const a = ((b + 0.5) / NB) * Math.PI * 2 - Math.PI;
    w[80 + 2 * b] = bits(100 + 50 * Math.cos(a));
    w[81 + 2 * b] = bits(100 + 50 * Math.sin(a));
    w[296 + b] = bits(10);
    w[368 + b] = 0;
  }
  w[368 + 4] = 1;
  w[368 + 40] = 1;
  w[368 + 20] = 2;
  w[440 + 4] = 1;
  w[512 + 4] = bits(37.5);
  w[440 + 40] = 3;
  w[512 + 40] = bits(42);
  return w;
}

describe('the wall from its words', () => {
  it('a post on each fully risen wall piece, on the walk, none on gates or over water', () => {
    const w = words();
    const all = wallPosts(w, 1);
    expect(all.length).toBe(NB - 3);
    expect(all.some((p) => p.seg === 4 || p.seg === 40 || p.seg === 20)).toBe(false);
    for (const p of all) expect(p.at[2]).toBeCloseTo(10 - 0.4 + WALL_H, 5);
    const mid = all.find((p) => p.seg === 30)!;
    expect(Math.hypot(mid.at[0] - 100, mid.at[1] - 100)).toBeGreaterThan(49);
  });

  it('rises round the ring from the first gate: half the stage, about half the pieces up', () => {
    const w = words();
    expect(segmentRise(w, 4, 0)).toBe(0);
    expect(segmentRise(w, 4, 0.05)).toBeGreaterThan(0);
    expect(segmentRise(w, 5, 0.2)).toBe(1);
    expect(segmentRise(w, 3, 0.5)).toBe(0);
    const half = wallPosts(w, 0.5).length;
    expect(half).toBeGreaterThan(25);
    expect(half).toBeLessThan(40);
    expect(wallPosts(w, 0)).toEqual([]);
  });

  it('the gates, with the arterial through each and where along it', () => {
    const g = wallGates(words());
    expect(g.map((x) => [x.seg, x.art, x.along])).toEqual([
      [4, 0, 37.5],
      [40, 2, 42],
    ]);
  });

  it('nothing before the ring is made', () => {
    const w = words();
    w[0] = 0;
    expect(wallPosts(w, 1)).toEqual([]);
    expect(wallGates(w)).toEqual([]);
  });
});
