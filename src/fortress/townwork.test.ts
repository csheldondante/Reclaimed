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

function world(pileAt: (s: number) => V2 | null = () => null) {
  const stores: Goods = { log: 40, stone: 40, grain: 0 };
  const f = fortressOn({ origin: [0, 0], w: W, h: H }, { windowOrigin: () => [0, 0], dims: { w: W, h: H, zMax: 99 }, ground: () => 5, stores: () => stores, townHeap: () => [20, 20] });
  f.ready = true;
  const work = new FortressWork({ fort: f, stores: () => stores, take: (g, n) => void (stores[g] = (stores[g] ?? 0) - n), trees: () => [], stores_at: () => [20, 20], pileAt });
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

  it('a smith forges a weapon out of the stores ore and wood; the smiths only while there is ore', () => {
    const { f, stores, life } = world();
    const cell = f.cellAt(40, 60);
    expect(f.paint(cell, 0, 'blacksmith')).toBe(true);
    f.markBuilt(cell, 0);
    const smithy = f.plan.owner[cell];
    // (no ore: no smith's job)
    life.add(1);
    life.tick(0.1);
    expect(life.jobOf(1)).toBeNull();
    stores.ore = 2;
    life.tick(0.1);
    expect(life.jobOf(1)).toBe(`s${smithy}`);
    life.on({ type: 'arrived', unit: 1, leg: 'stores', at: [20, 20] });
    expect(life.phaseOf(1)).toBe('toBatch');
    expect(stores.ore).toBe(0);
    expect(stores.log).toBe(39);
    // (the batch on its way keeps the smith its job, ore or none)
    life.tick(0.1);
    expect(life.jobOf(1)).toBe(`s${smithy}`);
    life.on({ type: 'arrived', unit: 1, leg: 'smithy', at: f.centre(cell) });
    life.tick(1e3);
    life.on({ type: 'arrived', unit: 1, leg: 'stores', at: [20, 20] });
    expect(stores.weapons).toBe(1);
  });

  it("a recruit drills into a soldier while there's a bed in the barracks", () => {
    const { f, stores, life } = world();
    const cell = f.cellAt(40, 60);
    expect(f.paint(cell, 0, 'barracks')).toBe(true);
    f.markBuilt(cell, 0);
    stores.weapons = 1;
    life.add(1);
    life.tick(0.1);
    life.on({ type: 'arrived', unit: 1, leg: 'stores', at: [20, 20] });
    expect(stores.weapons).toBe(0);
    life.on({ type: 'arrived', unit: 1, leg: 'barracks', at: f.centre(cell) });
    const o = life.tick(1e3);
    expect(o).toContainEqual({ unit: 1, become: 'soldier' });
    expect(life.soldiers()).toEqual([1]);
  });

  it('a long haul goes on the pile when a cart and a road serve it; the pile event, a cart loads it', () => {
    const far = (s: number) => (s >= 0 ? ([80, 100] as V2) : null);
    const { f, work, life } = world(far);
    const cell = f.cellAt(80, 100);
    expect(f.paint(cell, 0, 'quarry')).toBe(true);
    f.markBuilt(cell, 0);
    const q = f.plan.owner[cell];
    expect(f.doorOf(q)).not.toBeNull();
    // (no cart: walked)
    expect(work.pile(q, { stone: 2 }, { people: 1, soldiers: 0, carts: 0 })).toBe(false);
    work.drain();
    const crowd = { people: 1, soldiers: 0, carts: 1 };
    expect(work.pile(q, { stone: 2 }, crowd)).toBe(true);
    // (not a ride's worth yet: no event; then it is)
    expect(work.drain()).toEqual([]);
    expect(work.pileFor(70)).toBeNull();
    expect(work.pile(q, { stone: 2 }, crowd)).toBe(true);
    expect(work.drain()).toEqual([{ type: 'pile' }]);
    life.addCart(70);
    expect(life.phaseOf(70)).toBe('out');
    life.on({ type: 'arrived', unit: 70, leg: 'pile', at: [80, 100], to: q });
    expect(life.phaseOf(70)).toBe('back');
    expect(work.piles.get(q)).toEqual({ stone: 0 });
  });

  it("the wall-walk's points: the built wall cells, the next a walk along from the last", () => {
    const { f, work } = world();
    const cells = [f.cellAt(30, 90), f.cellAt(50, 90), f.cellAt(70, 90)];
    for (const c of cells) {
      expect(f.paint(c, 0, 'wall')).toBe(true);
      f.markBuilt(c, 0);
    }
    const pts = work.wallPoints();
    expect(pts.length).toBeGreaterThanOrEqual(3);
    const first = work.wallPoint([28, 90], null)!;
    expect(Math.hypot(first[0] - 28, first[1] - 90)).toBeLessThan(10);
    const next = work.wallPoint(first, first)!;
    expect(Math.hypot(next[0] - first[0], next[1] - first[1])).toBeGreaterThan(8);
  });

  it('a newcomer may come while there are beds and grain; grain in says so', () => {
    const { stores, work } = world();
    expect(work.mayArrive({ people: 0, soldiers: 0, carts: 0 })).toBe(false);
    work.drain();
    work.deliver({ grain: 3 }, null);
    expect(work.drain()).toContainEqual({ type: 'room' });
    expect(stores.grain).toBe(3);
    expect(work.mayArrive({ people: 0, soldiers: 0, carts: 0 })).toBe(true);
  });
});
