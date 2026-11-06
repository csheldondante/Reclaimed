// (DA-A6, round 128o) TownLife on a fortress's own work (townwork.ts FortressWork): scripted arrivals — no units, no
// positions read — put up a planned house load by load, and bring a farm's ripe grain into the stores.
import { describe, expect, it } from 'vitest';
import type { Goods } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/units';
import { fortressOn } from './testing';
import { TownLife, WORK_S } from '../town/life';
import { FortressWork } from './townwork';

const W = 120;
const H = 140;

function world() {
  const stores: Goods = { log: 40, stone: 40, grain: 0 };
  const f = fortressOn({ origin: [0, 0], w: W, h: H }, { windowOrigin: () => [0, 0], dims: { w: W, h: H, zMax: 99 }, ground: () => 5, stores: () => stores, townHeap: () => [20, 20] });
  f.ready = true;
  const work = new FortressWork({ fort: f, stores: () => stores, take: (g, n) => void (stores[g] = (stores[g] ?? 0) - n), trees: () => [], stores_at: () => [20, 20] });
  return { f, stores, work, life: new TownLife(work) };
}

describe('TownLife on a fortress', () => {
  it('a builder puts up a planned house load by load, told only of its arrivals', () => {
    const { f, stores, life } = world();
    const house = f.cellAt(40, 40);
    expect(f.paint(house, 0, 'house')).toBe(true);
    life.add(1);
    const stand: V2 = f.standsOf(house)[0];
    for (let trip = 0; trip < 10 && !f.town.has(house, 0); trip++) {
      life.tick(0.1);
      life.on({ type: 'arrived', unit: 1, leg: 'stores', at: [20, 20] });
      life.tick(0.1);
      expect(life.phaseOf(1)).toBe('toSite');
      life.on({ type: 'arrived', unit: 1, leg: 'site', at: stand });
      life.tick(WORK_S + 0.01);
    }
    expect(f.town.has(house, 0)).toBe(true);
    // (its cost out of the stores: a house's logs and stone)
    expect(stores.log).toBe(36);
    expect(stores.stone).toBe(38);
  });

  it("a farmer brings in its farm's ripe grain", () => {
    const { f, stores, work, life } = world();
    const cell = f.cellAt(60, 30);
    f.paint(cell, 0, 'farm');
    f.markBuilt(cell, 0);
    life.add(2);
    life.tick(0.1);
    expect(life.jobOf(2)).not.toBeNull();
    // (nothing ripe yet: it waits at the farm)
    life.on({ type: 'arrived', unit: 2, leg: 'farm', at: f.centre(cell) });
    expect(life.phaseOf(2)).toBe('waitSpot');
    // (the grain grows: the farm says so, once)
    work.drain();
    work.grow(200);
    const evs = work.drain();
    expect(evs).toEqual([{ type: 'spot', structure: f.plan.owner[cell] }]);
    for (const e of evs) life.on(e);
    expect(life.phaseOf(2)).toBe('gather');
    life.tick(1e4);
    life.on({ type: 'arrived', unit: 2, leg: 'stores', at: [20, 20] });
    expect(stores.grain).toBeGreaterThan(0);
    // (goods in: the stores say so)
    expect(work.drain()).toContainEqual({ type: 'stores' });
  });
});
