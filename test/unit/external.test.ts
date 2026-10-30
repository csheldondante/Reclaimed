// External intervals (sim/external.ts, round 99/110): the registry of things that own cells in the columns. Written
// from its contract: claim only what's free (a thing buried in ground isn't claimed there); release to the fallback
// or to air; verify tells an owner whose cells were dug; orphans become their fallback; loose tells the owner; an
// owner that doesn't decide is released for it; a slide moves the instances with the land.
import { describe, expect, test } from 'vitest';
import { cutOut, ExternalRegistry, OWNER_ROCK, type ExternalInstance } from '../../src/sim/external';
import type { Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';

/** columns in a map: x, y → intervals */
function columns(init: (x: number, y: number) => Interval[] = () => [{ z0: 0, z1: 10, mat: MAT.Stone }]) {
  const m = new Map<number, Interval[]>();
  const k = (x: number, y: number) => y * 65536 + x;
  return {
    read: (x: number, y: number) => (m.get(k(x, y)) ?? init(x, y)).map((iv) => ({ ...iv })),
    write: (x: number, y: number, col: Interval[]) => void m.set(k(x, y), col.map((iv) => ({ ...iv }))),
  };
}

const strip = (c: Interval[]) => c.map(({ z0, z1, mat }) => ({ z0, z1, mat }));

describe('cutOut', () => {
  test('takes a span out, cutting the intervals at its ends', () => {
    const col = [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 12, mat: MAT.Soil }];
    expect(cutOut(col, 8, 11)).toEqual([{ z0: 0, z1: 8, mat: MAT.Stone }, { z0: 11, z1: 12, mat: MAT.Soil }]);
    expect(cutOut(col, 20, 30)).toEqual(col);
  });
});

describe('ExternalRegistry', () => {
  test('claims only the free part: a thing half in the ground is External above it only', () => {
    const cols = columns();
    const ext = new ExternalRegistry(cols);
    const inst = ext.claim(OWNER_ROCK, [{ x: 1, y: 1, z0: 8, z1: 14 }])!;
    expect(inst.cols).toEqual([{ x: 1, y: 1, z0: 10, z1: 14 }]);
    expect(strip(cols.read(1, 1))).toEqual([{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 14, mat: MAT.External }]);
    expect(cols.read(1, 1)[1].aux).toBe(MAT.Stone);
    expect(ext.claim(OWNER_ROCK, [{ x: 2, y: 2, z0: 2, z1: 9 }])).toBeNull();
  });

  test('release: its cells become its fallback in place, or air', () => {
    const cols = columns();
    const ext = new ExternalRegistry(cols);
    const a = ext.claim(OWNER_ROCK, [{ x: 1, y: 1, z0: 10, z1: 12 }], MAT.Sand)!;
    const b = ext.claim(OWNER_ROCK, [{ x: 2, y: 1, z0: 10, z1: 12 }])!;
    ext.release(a.id);
    ext.release(b.id, true);
    expect(strip(cols.read(1, 1))).toEqual([{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 12, mat: MAT.Sand }]);
    expect(strip(cols.read(2, 1))).toEqual([{ z0: 0, z1: 10, mat: MAT.Stone }]);
    expect(ext.size).toBe(0);
  });

  test('verify: an instance that lost a cell is cut — its owner told — and one held whole is left', () => {
    const cols = columns();
    const ext = new ExternalRegistry(cols);
    const told: [number, string][] = [];
    ext.owner(OWNER_ROCK, { name: 'rock', onLost: (i, why) => (told.push([i.id, why]), ext.release(i.id, true)) });
    const a = ext.claim(OWNER_ROCK, [{ x: 1, y: 1, z0: 10, z1: 14 }])!;
    const b = ext.claim(OWNER_ROCK, [{ x: 5, y: 5, z0: 10, z1: 14 }])!;
    // (dug: the top of a's cells gone)
    cols.write(1, 1, [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 12, mat: MAT.External }]);
    ext.verify();
    expect(told).toEqual([[a.id, 'cut']]);
    expect(ext.get(b.id)).toBeDefined();
  });

  test("an owner that doesn't decide is released for it (to its fallback)", () => {
    const cols = columns();
    const ext = new ExternalRegistry(cols);
    ext.owner(OWNER_ROCK, { name: 'rock', onLost: () => undefined });
    const a = ext.claim(OWNER_ROCK, [{ x: 1, y: 1, z0: 10, z1: 14 }])!;
    ext.loose([{ x: 1, y: 1, z0: 10, z1: 14 }]);
    expect(ext.get(a.id)).toBeUndefined();
    expect(strip(cols.read(1, 1))).toEqual([{ z0: 0, z1: 14, mat: MAT.Stone }]);
  });

  test('loose: each instance with an interval there is told once', () => {
    const cols = columns();
    const ext = new ExternalRegistry(cols);
    const told: ExternalInstance[] = [];
    ext.owner(OWNER_ROCK, { name: 'rock', onLost: (i) => (told.push(i), ext.release(i.id, true)) });
    const a = ext.claim(OWNER_ROCK, [{ x: 1, y: 1, z0: 10, z1: 14 }, { x: 2, y: 1, z0: 10, z1: 14 }])!;
    ext.loose([{ x: 1, y: 1, z0: 11, z1: 12 }, { x: 2, y: 1, z0: 10, z1: 14 }, { x: 9, y: 9, z0: 0, z1: 1 }]);
    expect(told.map((i) => i.id)).toEqual([a.id]);
  });

  test('orphans: External no instance claims becomes its aux material; what an instance holds stays', () => {
    const cols = columns();
    const ext = new ExternalRegistry(cols);
    const a = ext.claim(OWNER_ROCK, [{ x: 1, y: 1, z0: 10, z1: 12 }])!;
    // (a slide's thaw left more External above it, of sand)
    cols.write(1, 1, [...cols.read(1, 1), { z0: 12, z1: 13, mat: MAT.External, aux: MAT.Sand }]);
    ext.orphans([1 * 65536 + 1]);
    const c = strip(cols.read(1, 1));
    expect(c).toContainEqual({ z0: 12, z1: 13, mat: MAT.Sand });
    expect(c.filter((iv) => iv.mat === MAT.External).reduce((s, iv) => s + iv.z1 - iv.z0, 0)).toBeCloseTo(2);
    expect(ext.get(a.id)).toBeDefined();
  });

  test('adopt registers cells already External without touching the columns', () => {
    const cols = columns(() => [{ z0: 0, z1: 6, mat: MAT.Stone }, { z0: 6, z1: 12, mat: MAT.External, aux: MAT.Stone }]);
    const ext = new ExternalRegistry(cols);
    const before = cols.read(3, 3);
    const a = ext.adopt(OWNER_ROCK, [{ x: 3, y: 3, z0: 6, z1: 12 }], MAT.Stone);
    expect(cols.read(3, 3)).toEqual(before);
    expect(ext.at(3, 3, 7, 8)).toEqual([a]);
    expect(ext.at(3, 3, 0, 5)).toEqual([]);
  });

  test('a slide moves its instances with the land', () => {
    const cols = columns();
    const ext = new ExternalRegistry(cols);
    const a = ext.claim(OWNER_ROCK, [{ x: 10, y: 10, z0: 10, z1: 12 }])!;
    ext.shift(4, -2);
    expect(a.cols[0]).toMatchObject({ x: 6, y: 12 });
    expect(ext.at(6, 12)).toEqual([a]);
    expect(ext.at(10, 10)).toEqual([]);
  });

  test('stats: what lives and its cells', () => {
    const ext = new ExternalRegistry(columns());
    ext.claim(OWNER_ROCK, [{ x: 1, y: 1, z0: 10, z1: 13 }, { x: 2, y: 1, z0: 10, z1: 12 }]);
    expect(ext.stats).toMatchObject({ claimed: 1, live: 1, cells: 5 });
  });
});
