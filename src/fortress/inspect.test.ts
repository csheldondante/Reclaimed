// (round 128d) Inspect's card (inspect.ts; the user: "an inspect to highlight a continuous section of structure and see
// its output input workers and stockpiles if applicable"): its numbers from the type's data, the built blocks and the
// ledger, and its writing (docs/WRITING.md lint).
import { describe, expect, it } from 'vitest';
import { lint } from '../../test/support/writing';
import { TownGrid } from '../build/towngrid';
import { DEFS, ECON, POWER_RISE } from './defs';
import { inspectCard, inspectFacts } from './inspect';
import { TownPlan } from '../build/plan';

const grid = new TownGrid(80, 92, { seed: 7 });
const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];
const inner = (() => {
  for (let c = 0; c < grid.count; c++) {
    const ok = [0, 1, 2, 3].every((e) => nbr(c, e) >= 0 && [0, 1, 2, 3].every((f) => nbr(nbr(c, e), f) >= 0));
    const [x, y] = grid.centre(c);
    if (ok && x > 30 && y > 30) return c;
  }
  throw new Error('no inner cell');
})();
const STORES = { log: 120, stone: 80, grain: 150, soldiers: 3, power: 42 };

/** a structure of `type` on inner and its neighbour 0, two levels on inner; `built` the blocks standing */
function make(type: keyof typeof DEFS, built: (c: number, l: number) => boolean) {
  const plan = new TownPlan(grid);
  plan.paint(inner, 0, type);
  if (DEFS[type].form !== 'yard') plan.paint(inner, 1, type);
  plan.paint(nbr(inner, 0), 0, type);
  const s = plan.structureAt(inner)!;
  return { plan, s, f: inspectFacts(plan, s, built, STORES) };
}

describe('Inspect: the card', () => {
  it('size, build progress, out a day from what stands, workers of its slots', () => {
    // a lumber camp: 3 blocks, 2 levels; 2 built (inner's ground floor and the neighbour)
    const { f } = make('lumber', (c, l) => l === 0);
    expect(f.blocks).toBe(3);
    expect(f.built).toBe(2);
    expect(f.levels).toBe(2);
    expect(f.makes).toEqual({ log: 2 * DEFS.lumber.perBlock.makes!.log! });
    expect(f.slots).toBe(2 * DEFS.lumber.perBlock.jobs!);
    expect(f.workers).toBe(0);
    const card = inspectCard(f);
    expect(card.title).toBe('Lumber camp: 3 blocks, 2 levels high');
    expect(card.lines).toContain('2 of 3 blocks built.');
    expect(card.lines).toContain('In: nothing. Out: up to 6 wood a day.');
    expect(card.lines).toContain('Workers: 0 of 4. Nobody works here yet.');
  });

  it('(milestone 3) the live numbers: its workers, what they brought, a farm\'s ripe grain', () => {
    const { plan, s } = make('quarry', () => true);
    const f = inspectFacts(plan, s, () => true, STORES, undefined, { workers: 3, brought: { stone: 12.4, ore: 3.1 } });
    const card = inspectCard(f);
    expect(card.lines).toContain('Workers: 3 of 4.');
    expect(card.lines).toContain('Some of the stone is ore.');
    expect(card.lines).toContain('Brought to the stores so far: 12 stone and 3 ore.');
    const farm = make('farm', () => true);
    const ff = inspectCard(inspectFacts(farm.plan, farm.s, () => true, STORES, undefined, { workers: 1, ripe: 4.7 }));
    expect(ff.lines).toContain('Ripe grain in the fields: 4.');
    for (const l of [...card.lines, ...ff.lines]) expect(lint(l), l).toEqual([]);
  });

  it('a warehouse shows what the stores hold and its room; barracks their soldiers; the keep its power', () => {
    const all = () => true;
    const w = inspectCard(make('warehouse', all).f);
    // (round 128d: the stores are the town's — held and room both of the town, then this warehouse's part)
    // (milestone 3: the stores' room is the town's own and the warehouses')
    const room = 3 * DEFS.warehouse.perBlock.storage!;
    expect(w.lines).toContain("The town's stores hold 350 goods: 120 wood, 80 stone and 150 grain.");
    expect(w.lines).toContain(`The stores have room for ${ECON.townRoom + room} goods. This one gives ${room} of it.`);
    expect(w.lines.some((l) => l.includes('more than that'))).toBe(false);
    expect(w.lines.some((l) => l.includes('blocks built'))).toBe(false);
    const b = inspectCard(make('barracks', all).f);
    expect(b.lines).toContain('Soldiers: 3.');
    expect(b.lines).toContain(`Beds: ${3 * DEFS.barracks.perBlock.beds!}.`);
    const k = make('fortress', all);
    // each block power x (1 + POWER_RISE x its level): two on the ground, one on level 1
    expect(k.f.power).toBeCloseTo(2 + (1 + POWER_RISE), 5);
    expect(inspectCard(k.f).lines).toContain(`Power: +${Math.round(2 + 1 + POWER_RISE)} a day. 42 stored.`);
    // nothing built: no power yet
    expect(make('fortress', () => false).f.power).toBe(0);
  });

  it('a farm is counted in cells; a wall its archers; not built yet says so', () => {
    const farm = inspectCard(make('farm', () => false).f);
    expect(farm.title).toBe('Farm: 2 cells');
    expect(farm.lines[0]).toBe('Not built yet.');
    expect(farm.lines).toContain('In: nothing. Out: nothing yet.');
    // (round 128l, milestone 4) the recipes' In: the smiths' ore and wood, the barracks' weapons and recruits
    const smith = inspectCard(make('blacksmith', () => true).f);
    expect(smith.lines).toContain('In: up to 18 wood and 36 ore a day. Out: up to 18 weapons a day.');
    const bar = inspectCard(make('barracks', () => true).f);
    expect(bar.lines).toContain('In: up to 6 weapons and 6 people a day. Out: up to 6 soldiers a day.');
    const wall = inspectCard(make('wall', () => true).f);
    expect(wall.lines).toContain(`Archers: 0 of ${3 * DEFS.wall.perBlock.posts!} posts.`);
  });

  it('every line of every type reads plainly', () => {
    for (const t of Object.keys(DEFS) as (keyof typeof DEFS)[])
      for (const built of [() => true, () => false, (_c: number, l: number) => l === 0]) {
        const c = inspectCard(make(t, built).f);
        for (const l of [c.title, ...c.lines]) expect(lint(l), l).toEqual([]);
      }
  });
});
