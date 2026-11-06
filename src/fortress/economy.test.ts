// Fortress slice 1, milestone 3 (Node, no GPU): the JobBoard (priority, keeping jobs, people short), the yields (a
// worker's load and its time, the quarry's ore, grain grown and eaten), the beds, the warehouses' room, newcomers, Erase's
// refund, a lumber camp's reach, and the new lines' writing.
import { describe, expect, it } from 'vitest';
import { lint } from '../../test/support/writing';
import { TownGrid } from '../build/towngrid';
import { DEFS, ECON } from './defs';
import { bedsOf, cartsOf, eaten, haulBy, fits, grown, JobBoard, jobSlots, mayArrive, perWorker, putIn, quarryLoad, reachOf, refundOf, roomOf, storedOf, workSeconds, type JobSlot } from './economy';
import { FortressPlan } from './plan';
import { BuildBook } from './work';
import { BEDS_LINE, FULL_LINE, HUNGRY_LINE, jobsLine, peopleLine, storesLine } from './words';

const grid = new TownGrid(80, 92, { seed: 7 });
const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];
/** cells far enough apart that their structures don't touch */
const spread = (() => {
  const out: number[] = [];
  for (let c = 0; c < grid.count && out.length < 8; c++) {
    const [x, y] = grid.centre(c);
    if (x < 10 || y < 10 || x > 70 || y > 70) continue;
    if (out.every((o) => Math.hypot(grid.centre(o)[0] - x, grid.centre(o)[1] - y) > 16)) out.push(c);
  }
  return out;
})();
const all = () => true;

describe('the JobBoard', () => {
  const slots: JobSlot[] = [
    { key: 's1', kind: 'farm', structure: 1, count: 2 },
    { key: 'build', kind: 'build', structure: null, count: 3 },
    { key: 's2', kind: 'quarry', structure: 2, count: 4 },
  ];

  it('fills jobs in priority order while people last', () => {
    const b = new JobBoard();
    b.assign([1, 2, 3, 4, 5, 6], slots);
    expect(b.count('s1')).toBe(2);
    expect(b.count('build')).toBe(3);
    expect(b.count('s2')).toBe(1);
    // more people than jobs: the rest have none
    b.assign([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], slots);
    expect(b.count('s2')).toBe(4);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((p) => b.jobOf(p) === null)).toHaveLength(2);
  });

  it('keeps a job while its slot still wants them, and moves people up when the first jobs open', () => {
    const b = new JobBoard();
    b.assign([1, 2, 3, 4], [slots[2]]);
    const was = [1, 2, 3, 4].map((p) => b.jobOf(p));
    expect(was.every((k) => k === 's2')).toBe(true);
    // the same slots again: nobody moves
    expect(b.assign([1, 2, 3, 4], [slots[2]])).toEqual([]);
    // a farm opens first in the order: two of the miners go to it, the other two stay
    const changed = b.assign([1, 2, 3, 4], [slots[0], slots[2]]);
    expect(changed).toHaveLength(2);
    expect(b.count('s1')).toBe(2);
    expect(b.count('s2')).toBe(2);
    // a person gone: their slot is filled from those with less pressing work
    b.assign([2, 3, 4], [slots[0], slots[2]]);
    expect(b.count('s1')).toBe(2);
    expect(b.count('s2')).toBe(1);
  });

  it('builds the slots from the plan: jobs per built block, builders while there is building, in JOB_ORDER', () => {
    const plan = new FortressPlan(grid);
    const [a, b, c] = spread;
    plan.paint(a, 0, 'quarry');
    plan.paint(nbr(a, 0), 0, 'quarry');
    plan.paint(b, 0, 'farm');
    plan.paint(c, 0, 'lumber');
    plan.paint(c, 1, 'lumber');
    // only level 0 stands: the lumber camp's upper block isn't worked yet
    const s = jobSlots(plan, (_c, l) => l === 0, true);
    expect(s.map((x) => x.kind)).toEqual(['farm', 'build', 'quarry', 'lumber']);
    expect(s.find((x) => x.kind === 'quarry')!.count).toBe(2 * DEFS.quarry.perBlock.jobs!);
    expect(s.find((x) => x.kind === 'lumber')!.count).toBe(DEFS.lumber.perBlock.jobs!);
    expect(s.find((x) => x.kind === 'build')!.count).toBe(ECON.builders);
    // nothing to build: no builders; nothing built: no jobs
    expect(jobSlots(plan, all, false).some((x) => x.kind === 'build')).toBe(false);
    expect(jobSlots(plan, () => false, false)).toEqual([]);
    // a house: no jobs; (round 128l, milestone 4) the blacksmith's smiths, as many as the cap lets (ore and wood in the
    // stores: FortressLife)
    const p2 = new FortressPlan(grid);
    p2.paint(a, 0, 'house');
    p2.paint(b, 0, 'blacksmith');
    expect(jobSlots(p2, all, false).map((x) => [x.kind, x.count])).toEqual([['blacksmith', DEFS.blacksmith.perBlock.jobs!]]);
    expect(jobSlots(p2, all, false, DEFS, ECON, () => 0)).toEqual([]);
  });
});

describe('carts and walkers (round 128l, m4)', () => {
  it('a long haul goes by cart while there are carts, a road and room on the pile; a short one is walked', () => {
    const far = ECON.cartDist + 10;
    expect(haulBy(far, { carts: 2, pile: 0, road: true })).toBe('cart');
    expect(haulBy(ECON.cartDist - 5, { carts: 2, pile: 0, road: true })).toBe('walk');
    expect(haulBy(far, { carts: 0, pile: 0, road: true })).toBe('walk');
    expect(haulBy(far, { carts: 2, pile: 0, road: false })).toBe('walk');
    expect(haulBy(far, { carts: 2, pile: ECON.pileMax, road: true })).toBe('walk');
  });

  it('the town has its carts, and a warehouse block adds one, up to the most', () => {
    expect(cartsOf(0)).toBe(ECON.carts);
    expect(cartsOf(1)).toBe(Math.min(ECON.cartsMax, ECON.carts + 1));
    expect(cartsOf(50)).toBe(ECON.cartsMax);
    expect(ECON.cartLoad).toBeGreaterThan(ECON.haul);
  });
});

describe('the yields', () => {
  it("a worker's load and its time follow the type's numbers", () => {
    // a quarry makes 3 stone a block a day with 2 workers: 1.5 a worker a day
    expect(perWorker(DEFS.quarry)).toEqual({ stone: DEFS.quarry.perBlock.makes!.stone! / DEFS.quarry.perBlock.jobs! });
    expect(workSeconds(DEFS.quarry)).toBeCloseTo((ECON.haul / 1.5) * ECON.daySec, 6);
    expect(workSeconds(DEFS.lumber)).toBeCloseTo((ECON.haul / 1.5) * ECON.daySec, 6);
    expect(() => workSeconds(DEFS.house)).toThrow();
  });

  it("ore is a share of the quarry's stone", () => {
    const l = quarryLoad(10);
    expect(l.ore).toBeCloseTo(10 * ECON.oreShare, 6);
    expect((l.stone ?? 0) + (l.ore ?? 0)).toBeCloseTo(10, 6);
  });

  it('grain grows a block a day on a farm, and each person eats ECON.eat a day', () => {
    expect(grown(3, ECON.daySec)).toBeCloseTo(3 * DEFS.farm.perBlock.makes!.grain!, 6);
    expect(grown(1, ECON.daySec / 2)).toBeCloseTo(DEFS.farm.perBlock.makes!.grain! / 2, 6);
    expect(eaten(10, ECON.daySec)).toBeCloseTo(10 * ECON.eat, 6);
    expect(eaten(0, 1000)).toBe(0);
  });

  it("a lumber camp's reach grows with its size", () => {
    expect(reachOf(1)).toBe(ECON.reach0 + ECON.reachPerBlock);
    expect(reachOf(5)).toBeGreaterThan(reachOf(1));
  });
});

describe('people: beds, food, newcomers', () => {
  it('beds come from the town and the house blocks built (not the barracks)', () => {
    const plan = new FortressPlan(grid);
    const [a, b] = spread;
    plan.paint(a, 0, 'house');
    plan.paint(a, 1, 'house');
    plan.paint(b, 0, 'barracks');
    expect(bedsOf(plan, () => false)).toBe(ECON.startBeds);
    expect(bedsOf(plan, all)).toBe(ECON.startBeds + 2 * DEFS.house.perBlock.beds!);
    expect(bedsOf(plan, (_c, l) => l === 0)).toBe(ECON.startBeds + DEFS.house.perBlock.beds!);
  });

  it('a newcomer comes while a bed is free and there is grain, up to the most people', () => {
    expect(mayArrive(8, 12, 50)).toBe(true);
    expect(mayArrive(12, 12, 50)).toBe(false);
    // no grain, nobody new (the user: "require grain or food per person")
    expect(mayArrive(8, 12, 0)).toBe(false);
    expect(mayArrive(ECON.maxPeople, ECON.maxPeople + 10, 50)).toBe(false);
  });
});

describe("the warehouses' room", () => {
  it('is the town\'s own and every built warehouse block\'s', () => {
    const plan = new FortressPlan(grid);
    const [a] = spread;
    plan.paint(a, 0, 'warehouse');
    plan.paint(a, 1, 'warehouse');
    expect(roomOf(plan, () => false)).toBe(ECON.townRoom);
    expect(roomOf(plan, all)).toBe(ECON.townRoom + 2 * DEFS.warehouse.perBlock.storage!);
  });

  it('counts goods, not soldiers or power, and takes in only what fits', () => {
    const st = { log: 100, stone: 50, grain: 40, soldiers: 9, power: 70 };
    expect(storedOf(st)).toBe(190);
    expect(fits(st, 200, 10)).toBe(true);
    expect(fits(st, 200, 11)).toBe(false);
    const went = putIn(st, 200, { stone: 8, ore: 4 });
    expect(went).toEqual({ stone: 8, ore: 2 });
    expect(st.stone).toBe(58);
    expect(storedOf(st)).toBe(200);
    // full: nothing more goes in
    expect(putIn(st, 200, { log: 3 })).toEqual({});
  });
});

describe("Erase's refund", () => {
  it('gives back half a built block\'s cost, rounded down', () => {
    expect(refundOf(DEFS.house.cost)).toEqual({ log: 2, stone: 1 });
    expect(refundOf(DEFS.fortress.cost)).toEqual({ stone: 4 });
    expect(refundOf({ log: 1 })).toEqual({});
  });

  it('gives back all that was brought to a block not yet built', () => {
    const book = new BuildBook(() => ({ log: 4, stone: 2 }));
    const b = { cell: 5, level: 0 };
    const stores = { log: 10, stone: 10 };
    const l = book.fetch(b, stores, 3)!;
    book.pay(b, l);
    expect(book.forget(b)).toEqual({ log: 3 });
    expect(book.paidOf(b)).toEqual({});
  });
});

describe('the lines read plainly', () => {
  it('every new line passes the lint', () => {
    const lines = [
      storesLine({ log: 120, stone: 80, ore: 3, grain: 150 }),
      peopleLine(12, 16, { power: 40 }, 3),
      jobsLine({ build: 4, farm: 2, quarry: 1, lumber: 1, idle: 2 }),
      jobsLine({ quarry: 1, idle: 1 }),
      jobsLine({}),
      FULL_LINE,
      HUNGRY_LINE,
      BEDS_LINE,
    ];
    expect(lines[2]).toBe('4 builders, 2 farmers, 1 miner and 1 woodcutter at work. 2 people have no work.');
    for (const l of lines) expect(lint(l), l).toEqual([]);
  });
});
