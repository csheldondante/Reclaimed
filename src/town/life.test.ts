// (DA-A6, round 128o) One crowd on events (townlife.ts): a person's phase moves only on what happens to it — scripted
// event streams here, no units, no positions read. A builder's cycle, a farmer's, a miner's and a woodcutter's; people
// without work go home; a job change mid-leg gives the load back; a leg sent to where it already is counts as there;
// a lost event throws.
import { type JobSlot, type Load } from './jobs';
import { describe, expect, it } from 'vitest';
import type { Goods } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/units';
import type { Block } from '../build/town';
import { TownLife, WORK_S, type LifeEvent, type Order, type TownWork } from './life';

/** a scripted town: its slots, stores and sites as plain data; every call the routine makes logged */
function town(slots: JobSlot[], daySec = 1e9) {
  const log: string[] = [];
  const stores: Goods = { stone: 10, log: 10 };
  const sites: Block[] = [{ cell: 7, level: 0 }];
  /** the scripted town's other parts: beds, the barracks' beds, the piles (and which a cart claimed), the wall */
  const more = { beds: 0, barracksBeds: 0, cartHaul: false, piles: new Map<number, Goods>(), claims: new Map<number, number>(), wall: [] as V2[] };
  const batches = new Map<number, string>();
  const work: TownWork = {
    daySec,
    drillSec: 3,
    patrolPoints: 2,
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
    startBatch: (unit, kind, _s, crowd) => {
      const need: Goods = kind === 'blacksmith' ? { ore: 2, log: 1 } : { weapons: 1 };
      if (kind === 'barracks' && crowd.soldiers >= more.barracksBeds) return null;
      if (Object.entries(need).some(([g, v]) => (stores[g as keyof Goods] ?? 0) < (v ?? 0))) return null;
      for (const [g, v] of Object.entries(need)) stores[g as keyof Goods] = (stores[g as keyof Goods] ?? 0) - (v ?? 0);
      log.push(`batch ${unit} ${kind}`);
      batches.set(unit, kind);
      return { goods: need, seconds: 5 };
    },
    finishBatch: (unit) => {
      const kind = batches.get(unit);
      batches.delete(unit);
      log.push(`finish ${unit}`);
      return kind === 'barracks' ? 'soldier' : { weapons: 1 };
    },
    dropBatch: (unit) => {
      batches.delete(unit);
      log.push(`drop ${unit}`);
    },
    pile: (structure, goods) => {
      if (!more.cartHaul) return false;
      const p = more.piles.get(structure) ?? {};
      for (const [g, v] of Object.entries(goods)) p[g as keyof Goods] = (p[g as keyof Goods] ?? 0) + (v ?? 0);
      more.piles.set(structure, p);
      log.push(`pile ${structure}`);
      return true;
    },
    pileFor: (cart) => {
      const taken = new Set(more.claims.values());
      for (const [s, g] of more.piles) {
        if (taken.has(s) || !Object.values(g).some((v) => (v ?? 0) > 0)) continue;
        more.claims.set(cart, s);
        return s;
      }
      return null;
    },
    loadPile: (cart, structure) => {
      more.claims.delete(cart);
      const g = more.piles.get(structure) ?? {};
      more.piles.set(structure, {});
      return g;
    },
    unclaim: (cart) => void more.claims.delete(cart),
    wallPoint: (at, from) => {
      const rest = more.wall.filter((p) => !from || p[0] !== from[0] || p[1] !== from[1]);
      return rest.sort((a, b) => Math.hypot(a[0] - at[0], a[1] - at[1]) - Math.hypot(b[0] - at[0], b[1] - at[1]))[0] ?? null;
    },
    mayArrive: (crowd) => crowd.people < more.beds && (stores.grain ?? 0) >= 1,
  };
  return { work, log, stores, sites, more };
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
    // (nothing polled: ticks alone don't wake it — the stores' event does)
    life.tick(1);
    expect(life.phaseOf(1)).toBe('waitLoad');
    life.on({ type: 'stores' });
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

  it("a farmer with nothing ripe waits at its farm until the farm says it has (a 'spot' event)", () => {
    const t = town([{ key: 's3', kind: 'farm', structure: 3, count: 1 }]);
    let ripe = false;
    t.work.workSpot = (_k, _s, at) => (ripe ? [at[0] + 1, at[1]] : null);
    const life = new TownLife(t.work);
    life.add(2);
    life.tick(0.1);
    life.on(arrived(2, 'farm', [4, 4]));
    expect(life.phaseOf(2)).toBe('waitSpot');
    life.tick(30);
    expect(life.phaseOf(2)).toBe('waitSpot');
    ripe = true;
    // (another structure's: not its)
    life.on({ type: 'spot', structure: 9 });
    expect(life.phaseOf(2)).toBe('waitSpot');
    life.on({ type: 'spot', structure: 3 });
    expect(life.phaseOf(2)).toBe('gather');
  });

  it('a builder waiting for a load wakes when the sites change (a block planned)', () => {
    const t = town([{ key: 'build', kind: 'build', structure: null, count: 1 }]);
    const life = new TownLife(t.work);
    const block = t.sites.splice(0, 1)[0];
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'stores'));
    expect(life.phaseOf(1)).toBe('waitLoad');
    t.sites.push(block);
    life.on({ type: 'sites' });
    expect(life.phaseOf(1)).toBe('toSite');
  });

  it("a person's day: a meal at the stores at midday, home to rest at its end, back to work the next", () => {
    const t = town([{ key: 's3', kind: 'farm', structure: 3, count: 1 }], 100);
    const life = new TownLife(t.work);
    life.add(2);
    life.tick(1);
    // (the morning: work)
    expect(life.phaseOf(2)).toBe('toWork');
    life.on(arrived(2, 'farm'));
    life.tick(46);
    // (reaped by midday: home to the stores with its load first, then the meal)
    life.on(arrived(2, 'stores'));
    expect(goes(life.tick(0.1), 2)).toContain('stores');
    // (a meal where it stands: the stores, already there)
    expect(life.phaseOf(2)).toBe('eating');
    life.tick(2.1);
    expect(life.phaseOf(2)).toBe('toWork');
    // (the day's end: home to rest, and out again the next morning)
    life.tick(45);
    life.on(arrived(2, 'farm'));
    life.tick(5);
    life.on(arrived(2, 'stores'));
    life.tick(0.1);
    expect(life.phaseOf(2)).toBe('rest');
    life.tick(10);
    expect(life.phaseOf(2)).toBe('toWork');
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

  it("a smith's cycle: a batch out of the stores, to the smithy, worked, the weapon home — waiting for ore without polling", () => {
    const t = town([{ key: 's3', kind: 'blacksmith', structure: 3, count: 1 }]);
    const life = new TownLife(t.work);
    life.add(1);
    expect(goes(life.tick(0.1), 1)).toEqual(['stores']);
    life.on(arrived(1, 'stores'));
    // (no ore: it waits by the stores; ticks don't wake it, the stores' event does)
    expect(life.phaseOf(1)).toBe('waitBatch');
    life.tick(10);
    expect(life.phaseOf(1)).toBe('waitBatch');
    t.stores.ore = 2;
    life.on({ type: 'stores' });
    let o = life.tick(0.1);
    expect(o).toContainEqual({ unit: 1, carry: 'ore' });
    expect(goes(o, 1)).toEqual(['smithy']);
    life.on(arrived(1, 'smithy'));
    expect(life.phaseOf(1)).toBe('batching');
    o = life.tick(5.01);
    expect(o).toContainEqual({ unit: 1, carry: 'weapons' });
    expect(goes(o, 1).at(-1)).toBe('stores');
    life.on(arrived(1, 'stores'));
    expect(t.log).toEqual(['batch 1 blacksmith', 'finish 1', 'deliver {"weapons":1}']);
  });

  it('a job changed under a smith with a batch gives the batch back', () => {
    const slots: JobSlot[] = [{ key: 's3', kind: 'blacksmith', structure: 3, count: 1 }];
    const t = town(slots);
    t.stores.ore = 2;
    const life = new TownLife(t.work);
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'stores'));
    expect(life.phaseOf(1)).toBe('toBatch');
    slots.length = 0;
    const o = life.tick(0.1);
    expect(t.log).toEqual(['batch 1 blacksmith', 'drop 1']);
    expect(o).toContainEqual({ unit: 1, carry: null });
    expect(goes(o, 1).at(-1)).toBe('home');
  });

  it('the job stays with the one holding a batch when the slot shrinks', () => {
    const slots: JobSlot[] = [{ key: 's3', kind: 'blacksmith', structure: 3, count: 2 }];
    const t = town(slots);
    t.stores.ore = 2;
    const life = new TownLife(t.work);
    life.add(1);
    life.add(2);
    life.tick(0.1);
    // (2 gets the one batch; 1 waits for ore)
    life.on(arrived(2, 'stores'));
    life.on(arrived(1, 'stores'));
    expect(life.phaseOf(2)).toBe('toBatch');
    expect(life.phaseOf(1)).toBe('waitBatch');
    slots[0] = { ...slots[0], count: 1 };
    life.tick(0.1);
    expect(life.jobOf(2)).toBe('s3');
    expect(life.jobOf(1)).toBeNull();
    expect(t.log).toEqual(['batch 2 blacksmith']);
  });

  it("a recruit drills into a soldier: the soldier's round — muster, drill, march, the wall, muster again", () => {
    const t = town([{ key: 's4', kind: 'barracks', structure: 4, count: 1 }]);
    t.stores.weapons = 1;
    t.more.barracksBeds = 1;
    t.more.wall = [[10, 0], [20, 0], [30, 0]];
    const life = new TownLife(t.work);
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'stores'));
    expect(goes(life.tick(0.1), 1)).toEqual(['barracks']);
    life.on(arrived(1, 'barracks'));
    // (done: a soldier now, at the barracks — it drills there straight away)
    let o = life.tick(5.01);
    expect(o).toContainEqual({ unit: 1, become: 'soldier' });
    expect(life.units()).toEqual([]);
    expect(life.soldiers()).toEqual([1]);
    expect(life.phaseOf(1)).toBe('drill');
    o = life.tick(3.01);
    expect(goes(o, 1)).toEqual(['post']);
    life.on(arrived(1, 'post', [9, 0]));
    o = life.tick(0.1);
    expect(o).toContainEqual({ unit: 1, go: 'wall', to: [10, 0] });
    // (an arrival at another point than its own isn't its)
    life.on({ type: 'arrived', unit: 1, leg: 'wall', at: [30, 0], to: [30, 0] });
    expect(life.phaseOf(1)).toBe('patrol');
    life.on({ type: 'arrived', unit: 1, leg: 'wall', at: [10, 0], to: [10, 0] });
    o = life.tick(0.1);
    expect(o).toContainEqual({ unit: 1, go: 'wall', to: [20, 0] });
    life.on({ type: 'arrived', unit: 1, leg: 'wall', at: [20, 0], to: [20, 0] });
    // (its points walked: back to muster)
    expect(goes(life.tick(0.1), 1)).toEqual(['barracks']);
  });

  it("no bed in the barracks: the recruit waits until a soldier's death frees one", () => {
    const t = town([{ key: 's4', kind: 'barracks', structure: 4, count: 1 }]);
    t.stores.weapons = 1;
    t.more.barracksBeds = 1;
    const life = new TownLife(t.work);
    life.addSoldier(50);
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'stores'));
    expect(life.phaseOf(1)).toBe('waitBatch');
    life.on({ type: 'death', unit: 50 });
    expect(life.phaseOf(1)).toBe('toBatch');
  });

  it('soldiers muster again each morning, wherever they are', () => {
    const t = town([], 100);
    t.more.wall = [[10, 0], [20, 0]];
    const life = new TownLife(t.work);
    life.addSoldier(5);
    life.tick(0.1);
    life.on(arrived(5, 'barracks'));
    life.tick(3.01);
    life.on(arrived(5, 'post'));
    expect(life.phaseOf(5)).toBe('patrol');
    life.tick(50);
    expect(life.phaseOf(5)).toBe('patrol');
    expect(goes(life.tick(50), 5)).toEqual(['barracks']);
  });

  it('a long haul is left on the pile; a parked cart rides out for it on the pile event, and back to the stores', () => {
    const t = town([{ key: 's2', kind: 'quarry', structure: 2, count: 1 }]);
    t.more.cartHaul = true;
    const life = new TownLife(t.work);
    life.addCart(70);
    expect(goes(life.tick(0.1), 70)).toEqual([null]);
    expect(life.phaseOf(70)).toBe('park');
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'quarry'));
    life.on({ type: 'dug', unit: 1, amount: 2 });
    // (left on the pile: the miner goes back to its face, carrying nothing)
    let o = life.tick(0.1);
    expect(o).toContainEqual({ unit: 1, carry: null });
    expect(goes(o, 1)).toContain('quarry');
    expect(life.phaseOf(70)).toBe('park');
    life.on({ type: 'pile' });
    o = life.tick(0.1);
    expect(o).toContainEqual({ unit: 70, go: 'pile', to: 2 });
    life.on({ type: 'arrived', unit: 70, leg: 'pile', at: [0, 0], to: 2 });
    o = life.tick(0.1);
    expect(o).toContainEqual({ unit: 70, carry: 'stone' });
    expect(goes(o, 70)).toEqual(['stores']);
    life.on(arrived(70, 'stores'));
    expect(life.phaseOf(70)).toBe('park');
    expect(t.log).toEqual(['pile 2', 'deliver {"stone":1.6,"ore":0.4}']);
  });

  it('a cart gone on its way out lets go of its pile', () => {
    const t = town([]);
    t.more.piles.set(2, { log: 4 });
    const life = new TownLife(t.work);
    life.addCart(70);
    expect(life.phaseOf(70)).toBe('out');
    expect(t.more.claims.get(70)).toBe(2);
    life.on({ type: 'death', unit: 70 });
    expect(t.more.claims.size).toBe(0);
    expect(t.more.piles.get(2)).toEqual({ log: 4 });
  });

  it('a newcomer comes when there is room (one at a time), walks to a house, then takes work', () => {
    const t = town([{ key: 'build', kind: 'build', structure: null, count: 4 }]);
    t.more.beds = 3;
    t.stores.grain = 5;
    const life = new TownLife(t.work);
    life.add(1);
    life.on({ type: 'room' });
    life.on({ type: 'room' });
    let o = life.tick(0.1);
    expect(o.filter((x) => 'newcomer' in x)).toHaveLength(1);
    life.arrive(2);
    o = life.tick(0.1);
    expect(goes(o, 2)).toEqual(['home']);
    expect(life.jobOf(2)).toBeNull();
    // (in at the house: work from the next tick; the next newcomer may come)
    life.on(arrived(2, 'home'));
    o = life.tick(0.1);
    expect(o.filter((x) => 'newcomer' in x)).toHaveLength(1);
    expect(goes(o, 2)).toEqual(['stores']);
    life.arrive(3);
    life.on(arrived(3, 'home'));
    // (three people, three beds: no more)
    expect(life.tick(0.1).filter((x) => 'newcomer' in x)).toHaveLength(0);
    expect(() => life.arrive(4)).toThrow(/no one asked for/);
  });

  it('raiders about: the people go home and in (a load given back), nobody new comes; gone: back to their day', () => {
    const t = town([{ key: 'build', kind: 'build', structure: null, count: 4 }]);
    t.more.beds = 5;
    t.stores.grain = 5;
    const life = new TownLife(t.work);
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'stores'));
    expect(life.phaseOf(1)).toBe('toSite');
    life.on({ type: 'shelter', on: true });
    let o = life.tick(0.1);
    expect(t.log).toEqual(['load 7', 'giveBack 7']);
    expect(o).toContainEqual({ unit: 1, carry: null });
    expect(goes(o, 1).at(-1)).toBe('home');
    // (no newcomer while raiders are about)
    life.on({ type: 'room' });
    life.on(arrived(1, 'home'));
    expect(life.inside()).toEqual([1]);
    o = life.tick(5);
    expect(o.filter((x) => 'newcomer' in x)).toHaveLength(0);
    expect(life.phaseOf(1)).toBe('inside');
    life.on({ type: 'shelter', on: false });
    expect(goes(life.tick(0.1), 1).at(-1)).toBe('stores');
  });

  it("a unit taken out of its round is left be until it's given back: a soldier musters again", () => {
    const t = town([]);
    const life = new TownLife(t.work);
    life.addSoldier(5);
    life.tick(0.1);
    life.away(5);
    // (its arrivals aren't the routine's while it's away)
    life.on(arrived(5, 'barracks'));
    expect(life.phaseOf(5)).toBe('idle');
    expect(goes(life.tick(10), 5)).toEqual([]);
    life.back(5);
    expect(goes(life.tick(0.1), 5)).toEqual(['barracks']);
  });

  it('a dig with nothing left where it stood: to the next spot; a newcomer turned away lets the next room event ask again', () => {
    const t = town([{ key: 's2', kind: 'quarry', structure: 2, count: 1 }]);
    t.more.beds = 5;
    t.stores.grain = 5;
    const life = new TownLife(t.work);
    life.add(1);
    life.tick(0.1);
    life.on(arrived(1, 'quarry'));
    life.on({ type: 'dug', unit: 1, amount: 0 });
    expect(life.phaseOf(1)).toBe('toWork');
    life.on({ type: 'room' });
    expect(life.tick(0.1).filter((x) => 'newcomer' in x)).toHaveLength(1);
    life.turnedAway();
    life.on({ type: 'room' });
    expect(life.tick(0.1).filter((x) => 'newcomer' in x)).toHaveLength(1);
  });

  it("a person with a trade of its own keeps it (the job board doesn't move it); its slot opening sends it out", () => {
    const slots: JobSlot[] = [{ key: 'farmer', kind: 'farm', structure: 1, count: 1 }];
    const t = town(slots);
    const life = new TownLife(t.work);
    life.add(1, 'builder');
    life.add(2, 'farmer');
    life.add(3);
    life.tick(0.1);
    // (no builders' slot yet: the builder stays home; the farmer farms; the one without a trade gets nothing — the
    // farmer's one place is the farmer's)
    expect(life.jobOf(1)).toBe('builder');
    expect(life.phaseOf(1)).toBe('home');
    expect(life.phaseOf(2)).toBe('toWork');
    expect(life.jobOf(3)).toBeNull();
    slots.unshift({ key: 'builder', kind: 'build', structure: null, count: 1 });
    expect(goes(life.tick(0.1), 1)).toEqual(['stores']);
    expect(life.jobOf(2)).toBe('farmer');
  });
});
