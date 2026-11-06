// (DA-A6, round 128o) One crowd on events (townlife.ts): a person's phase moves only on what happens to it — scripted
// event streams here, no units, no positions read. A builder's cycle, a farmer's, a miner's and a woodcutter's; people
// without work go home; a job change mid-leg gives the load back; a leg sent to where it already is counts as there;
// a lost event throws.
import { describe, expect, it } from 'vitest';
import type { Goods } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/units';
import type { Block } from '../build/town';
import type { JobSlot } from './economy';
import { TownLife, WORK_S, type LifeEvent, type Order, type TownWork } from './townlife';
import type { Load } from './work';

/** a scripted town: its slots, stores and sites as plain data; every call the routine makes logged */
function town(slots: JobSlot[]) {
  const log: string[] = [];
  const stores: Goods = { stone: 10, log: 10 };
  const sites: Block[] = [{ cell: 7, level: 0 }];
  const work: TownWork = {
    slots: () => slots,
    nextLoad: () => {
      const block = sites[0];
      if (!block || (stores.stone ?? 0) < 3) return null;
      stores.stone! -= 3;
      log.push(`load ${block.cell}`);
      return { block, load: { good: 'stone', amount: 3 } };
    },
    siteAt: (_at: V2, _load: Load, meant: Block) => (sites.includes(meant) ? meant : null),
    workIn: (b: Block) => void log.push(`workIn ${b.cell}`),
    giveBack: (b: Block, load: Load) => {
      stores[load.good] = (stores[load.good] ?? 0) + load.amount;
      log.push(`giveBack ${b.cell}`);
    },
    deliver: (goods: Goods) => {
      for (const [g, v] of Object.entries(goods)) stores[g as keyof Goods] = (stores[g as keyof Goods] ?? 0) + (v ?? 0);
      log.push(`deliver ${JSON.stringify(goods)}`);
    },
    workSpot: (_k, _s, at) => [at[0] + 1, at[1]],
    reap: () => ({ goods: { grain: 2 }, seconds: 4 }),
    dugGoods: (n) => ({ stone: n * 0.8, ore: n * 0.2 }),
  };
  return { work, log, stores, sites };
}

const goes = (orders: Order[], unit: number) => orders.filter((o): o is { unit: number; go: never } => 'go' in o && o.unit === unit).map((o) => o.go);
const arrived = (unit: number, leg: LifeEvent extends infer E ? (E extends { type: 'arrived'; leg: infer L } ? L : never) : never, at: V2 = [0, 0]): LifeEvent => ({ type: 'arrived', unit, leg, at });

describe('one crowd, on events', () => {
  it("a builder's cycle: the stores, a load, the site, worked in — and again", () => {
    const t = town([{ key: 'build', kind: 'build', structure: null, count: 4 }]);
    const life = new TownLife(t.work);
    life.add(1);
    expect(goes(life.tick(0.1), 1)).toEqual(['stores']);
    // (no arrival, no change: nothing polled)
    life.tick(5);
    expect(life.phaseOf(1)).toBe('toStores');
    life.on(arrived(1, 'stores'));
    let o = life.tick(0.1);
    expect(o).toContainEqual({ unit: 1, carry: 'stone' });
    expect(goes(o, 1)).toEqual(['site']);
    life.on(arrived(1, 'site', [5, 5]));
    expect(life.phaseOf(1)).toBe('working');
    life.tick(WORK_S + 0.01);
    expect(t.log).toEqual(['load 7', 'workIn 7']);
    expect(life.phaseOf(1)).toBe('toStores');
  });

  it('nothing to bring: the builder waits at the stores, and takes a load as soon as there is one', () => {
    const t = town([{ key: 'build', kind: 'build', structure: null, count: 4 }]);
    t.stores.stone = 0;
    const life = new TownLife(t.work);
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'stores'));
    life.tick(1);
    expect(life.phaseOf(1)).toBe('waitLoad');
    t.stores.stone = 5;
    const o = life.tick(1);
    expect(life.phaseOf(1)).toBe('toSite');
    expect(goes(o, 1)).toEqual(['site']);
  });

  it("a farmer's cycle: the farm, a reap's time, home to the stores with the grain", () => {
    const t = town([{ key: 's3', kind: 'farm', structure: 3, count: 2 }]);
    const life = new TownLife(t.work);
    life.add(2);
    expect(goes(life.tick(0.1), 2)).toEqual(['farm']);
    life.on(arrived(2, 'farm', [10, 10]));
    expect(life.phaseOf(2)).toBe('gather');
    life.tick(3);
    expect(life.phaseOf(2)).toBe('gather');
    const o = life.tick(1.1);
    expect(o).toContainEqual({ unit: 2, carry: 'grain' });
    expect(goes(o, 2)).toEqual(['stores']);
    life.on(arrived(2, 'stores'));
    expect(t.stores.grain).toBe(2);
    // (back out with the next tick: the board's turn first)
    expect(goes(life.tick(0.1), 2)).toEqual(['farm']);
    expect(life.phaseOf(2)).toBe('toWork');
  });

  it("a miner's and a woodcutter's: the world's answers move them on", () => {
    const t = town([
      { key: 's4', kind: 'quarry', structure: 4, count: 1 },
      { key: 's5', kind: 'lumber', structure: 5, count: 1 },
    ]);
    const life = new TownLife(t.work);
    life.add(3);
    life.add(4);
    const o = life.tick(0.1);
    expect([...goes(o, 3), ...goes(o, 4)].sort()).toEqual(['fell', 'quarry']);
    const miner = life.jobOf(3) === 's4' ? 3 : 4;
    const cutter = miner === 3 ? 4 : 3;
    life.on(arrived(miner, 'quarry', [1, 2]));
    life.on(arrived(cutter, 'fell', [8, 9]));
    const o2 = life.tick(0.1);
    expect(o2).toContainEqual({ unit: miner, dig: [2, 2] });
    expect(o2).toContainEqual({ unit: cutter, fell: [9, 9] });
    life.on({ type: 'dug', unit: miner, amount: 2 });
    life.on({ type: 'felled', unit: cutter, logs: 0 });
    // (the tree was gone: off to the next)
    expect(life.phaseOf(cutter)).toBe('toWork');
    expect(life.phaseOf(miner)).toBe('carry');
    life.on(arrived(miner, 'stores'));
    expect(t.stores.ore).toBeCloseTo(0.4);
  });

  it('people without work go home and stand there; a job sends them out', () => {
    const slots: JobSlot[] = [];
    const t = town(slots);
    const life = new TownLife(t.work);
    life.add(5);
    expect(goes(life.tick(0.1), 5)).toEqual(['home']);
    life.on(arrived(5, 'home'));
    // (there: it stands)
    expect(goes(life.tick(1), 5)).toEqual([null]);
    expect(goes(life.tick(1), 5)).toEqual([]);
    slots.push({ key: 'build', kind: 'build', structure: null, count: 1 });
    expect(goes(life.tick(1), 5)).toEqual(['stores']);
  });

  it('a job changed under a builder on its way gives its load back', () => {
    const slots: JobSlot[] = [{ key: 'build', kind: 'build', structure: null, count: 1 }];
    const t = town(slots);
    const life = new TownLife(t.work);
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'stores'));
    expect(t.stores.stone).toBe(7);
    slots.splice(0, 1, { key: 's3', kind: 'farm', structure: 3, count: 1 });
    expect(goes(life.tick(0.1), 1).at(-1)).toBe('farm');
    expect(t.stores.stone).toBe(10);
    expect(t.log).toContain('giveBack 7');
  });

  it('a person sent where it already is counts as there (the agents tell an arrival once)', () => {
    // (a farmer turned builder at the stores, just delivered: its next leg is the stores — no new event comes)
    const slots: JobSlot[] = [{ key: 's3', kind: 'farm', structure: 3, count: 1 }];
    const t = town(slots);
    const life = new TownLife(t.work);
    life.add(2);
    life.tick(0.1);
    life.on(arrived(2, 'farm'));
    life.tick(5);
    slots.splice(0, 1, { key: 'build', kind: 'build', structure: null, count: 1 });
    life.on(arrived(2, 'stores'));
    // (the delivery restarts it as what the board says now — the board's turn comes in the tick)
    const o = life.tick(0.1);
    expect(life.phaseOf(2)).toBe('toSite');
    expect(goes(o, 2)).toContain('site');
  });

  it('a lost event throws: a person may wait for an arrival it never hears of', () => {
    const life = new TownLife(town([]).work);
    expect(() => life.on({ type: 'lost', count: 3 })).toThrow(/3 agent events lost/);
  });

  it('a death takes the person out', () => {
    const life = new TownLife(town([]).work);
    life.add(9);
    life.on({ type: 'death', unit: 9 });
    expect(life.units()).toEqual([]);
  });
});
