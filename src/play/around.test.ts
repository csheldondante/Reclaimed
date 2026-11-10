// (round 128p, U1) The play layer's units round the hero (play/world.ts UnitsAround): what a query found is observed
// while it's round the hero and released when it isn't; a unit whose place isn't read yet isn't seen; one ask at a time.
import { describe, expect, it } from 'vitest';
import { UnitsAround, AROUND } from './world';
import type { SeenUnit, UnitId, UnitView, Units, V2, V3 } from '../api/contracts/units';

function fakeUnits() {
  const places = new Map<UnitId, V3>();
  const observed = new Map<UnitId, number>();
  const asks: { at: V2; r: number; answer: (found: SeenUnit[]) => void }[] = [];
  const view = (id: UnitId): UnitView => ({ id, kind: 'raider', role: 'raider', faction: null, at: (observed.get(id) ?? 0) > 0 ? (places.get(id) ?? null) : null, heading: 0, health: 3, maxHealth: 3, hostile: true, alive: true, job: { kind: 'idle' }, state: 'idle', colour: '#fff' });
  const units: Pick<Units, 'get' | 'query' | 'observe'> = {
    get: (id) => (places.has(id) ? view(id) : null),
    query: (at, r) => new Promise((res) => asks.push({ at, r, answer: res })),
    observe: (ids) => {
      const list = typeof ids === 'number' ? [ids] : [...ids];
      for (const id of list) observed.set(id, (observed.get(id) ?? 0) + 1);
      return () => {
        for (const id of list) observed.set(id, (observed.get(id) ?? 0) - 1);
      };
    },
  };
  /** the answer a GPU query would give round `at`: every unit within r, with its place */
  const answer = (k: number) => {
    const a = asks[k];
    const found: SeenUnit[] = [];
    for (const [id, p] of places) if (Math.hypot(p[0] - a.at[0], p[1] - a.at[1]) <= a.r) found.push({ ...view(id), at: p });
    a.answer(found);
  };
  return { units, places, observed, asks, answer };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('UnitsAround (play/world.ts)', () => {
  it('observes what a query found round the hero, sees it once its place is read, and releases it when it leaves', async () => {
    const F = fakeUnits();
    F.places.set(1, [10, 10, 0]);
    F.places.set(2, [12, 10, 0]);
    F.places.set(3, [200, 200, 0]);
    // (only get/query/observe are used: the rest of the contract isn't reached)
    const A = new UnitsAround(F.units as Units);
    A.centre = () => [10, 10];
    A.tick();
    A.tick();
    // one ask out at a time
    expect(F.asks.length).toBe(1);
    expect(F.asks[0].r).toBe(AROUND);
    expect(A.near(10, 10, 5)).toEqual([]);
    F.answer(0);
    await flush();
    expect([...F.observed].filter(([, n]) => n > 0).map(([id]) => id)).toEqual([1, 2]);
    expect(A.near(10, 10, 5).map((u) => u.id)).toEqual([1, 2]);
    expect(A.near(12, 10, 1).map((u) => u.id)).toEqual([2]);
    // unit 2 walks off: the next answer drops it, released
    F.places.set(2, [150, 150, 0]);
    A.tick();
    expect(F.asks.length).toBe(2);
    F.answer(1);
    await flush();
    expect(F.observed.get(2)).toBe(0);
    expect(A.near(10, 10, 5).map((u) => u.id)).toEqual([1]);
    A.dispose();
    expect(F.observed.get(1)).toBe(0);
  });

  it('asks nothing with no hero in play, and refuses a reach past AROUND', () => {
    const F = fakeUnits();
    const A = new UnitsAround(F.units as Units);
    A.tick();
    expect(F.asks.length).toBe(0);
    expect(() => A.near(0, 0, AROUND + 1)).toThrow(/AROUND/);
  });
});
