// (round 128d) Painted shapes make landmarks by local rules (shapes.ts; the user: "Yes please add those rules and the
// courtyards since those add a lot of charm"): a lone tall cell a tower, four round a corner a dome, a keep cell above
// the keep a turret, an enclosed empty cell a courtyard. Node, no GPU.
import { describe, expect, it } from 'vitest';
import type { StructureType } from '../api/contracts/fortress';
import { Town } from '../build/town';
import { TownGrid } from '../build/towngrid';
import { library } from '../structures/modules';
import { townPieces } from '../build/view';
import { noWays } from './ways';
import { TownPlan } from '../build/plan';
import { COURT_MAX, shapesOf } from './shapes';

const grid = new TownGrid(80, 92, { seed: 7 });
const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];
/** a cell whose neighbours' neighbours' neighbours all exist, in the middle */
const deep = (c: number, d: number): boolean => d === 0 || [0, 1, 2, 3].every((e) => nbr(c, e) >= 0 && deep(nbr(c, e), d - 1));
const inner = (() => {
  for (let c = 0; c < grid.count; c++) {
    const [x, y] = grid.centre(c);
    if (x > 30 && y > 30 && deep(c, 3)) return c;
  }
  throw new Error('no inner cell');
})();
const GROUND = 5;

function setup() {
  const town = new Town(80, 92, { ground: () => GROUND, stamp: null, zMax: Infinity }, { grid });
  const plan = new TownPlan(grid);
  const paint = (c: number, l: number, t: StructureType) => {
    expect(plan.paint(c, l, t)).toBe(true);
    town.plan(c, l, true);
  };
  const shapes = () => shapesOf(plan, grid, (c) => town.base[c]);
  const names = () => {
    // (the shapes' own rules: no ways — roads and stairs are ways.test.ts's)
    const p = townPieces({ plan, town, grid, seed: 7, order: [], placed: new Map() }, { ground: () => GROUND, ways: noWays(grid.count) });
    const lib = library();
    const n = new Map<string, number>();
    for (let i = 0; i < p.count; i++) n.set(lib.modules[p.module[i]].name, (n.get(lib.modules[p.module[i]].name) ?? 0) + 1);
    return n;
  };
  return { town, plan, paint, shapes, names };
}

describe('a lone cell stacked three levels or more is a round tower with a spire', () => {
  it('three levels alone: a tower; two: a house', () => {
    const s = setup();
    s.paint(inner, 0, 'house');
    s.paint(inner, 1, 'house');
    expect(s.shapes().towers.size).toBe(0);
    s.paint(inner, 2, 'house');
    expect([...s.shapes().towers]).toEqual([inner]);
    const n = s.names();
    expect(n.get('tower')).toBe(1);
    expect(n.get('spire')).toBe(1);
    // (no rooms' walls of its own)
    expect([...n.keys()].some((k) => k.includes(':window') || k.includes(':door'))).toBe(false);
  });

  it('with a block beside it: not lone, a house', () => {
    const s = setup();
    for (const l of [0, 1, 2]) s.paint(inner, l, 'house');
    s.paint(nbr(inner, 0), 0, 'warehouse');
    expect(s.shapes().towers.size).toBe(0);
  });
});

describe('four cells round a corner, all one height, are a dome', () => {
  // a corner of the inner cell with exactly four cells round it
  const four = (() => {
    for (let k = 0; k < 4; k++) {
      const v = grid.quads[inner * 4 + k];
      const cells: number[] = [];
      for (let c = 0; c < grid.count; c++) for (let j = 0; j < 4; j++) if (grid.quads[c * 4 + j] === v) cells.push(c);
      if (cells.length === 4) return cells;
    }
    throw new Error('no four-cell corner');
  })();

  it('one storey or two, the same everywhere: a drum, a dome and a lantern', () => {
    const s = setup();
    for (const c of four) s.paint(c, 0, 'house');
    expect(s.shapes().domes.length).toBe(1);
    for (const c of four) s.paint(c, 1, 'house');
    expect(s.shapes().domes.length).toBe(1);
    const n = s.names();
    expect(n.get('drum')).toBe(1);
    expect(n.get('dome')).toBe(1);
    expect(n.get('lantern')).toBe(1);
  });

  it('one cell taller, or a fifth cell: a house', () => {
    const s = setup();
    for (const c of four) s.paint(c, 0, 'house');
    s.paint(four[0], 1, 'house');
    expect(s.shapes().domes.length).toBe(0);
    const t = setup();
    for (const c of four) t.paint(c, 0, 'house');
    const fifth = [0, 1, 2, 3].map((e) => nbr(four[0], e)).find((c) => c >= 0 && !four.includes(c))!;
    t.paint(fifth, 0, 'house');
    expect(t.shapes().domes.length).toBe(0);
  });
});

describe('a keep cell standing above the keep is a round turret', () => {
  it('above every keep cell beside it: a turret; as tall as one: none', () => {
    const s = setup();
    s.paint(inner, 0, 'fortress');
    s.paint(nbr(inner, 0), 0, 'fortress');
    expect(s.shapes().turrets.size).toBe(0);
    s.paint(inner, 1, 'fortress');
    expect([...s.shapes().turrets]).toEqual([inner]);
    expect(s.names().get('spire')).toBe(1);
    s.paint(nbr(inner, 0), 1, 'fortress');
    expect(s.shapes().turrets.size).toBe(0);
  });
});

describe('an empty cell shut in by blocks is a courtyard', () => {
  it('one cell: paved, a tree, an arch in each face round it', () => {
    const s = setup();
    for (let e = 0; e < 4; e++) s.paint(nbr(inner, e), 0, 'house');
    const ct = s.shapes().courtyards;
    expect(ct.length).toBe(1);
    expect(ct[0].cells).toEqual([inner]);
    expect(ct[0].faces.length).toBe(4);
    const n = s.names();
    expect(n.get('pave')).toBe(1);
    expect(n.get('fruittree')).toBe(1);
    expect(n.get('gatearch')).toBe(4);
  });

  it('walls and the keep shut one in too; two cells get a fountain', () => {
    const s = setup();
    const two = [inner, nbr(inner, 0)];
    const ring = new Set<number>();
    for (const c of two) for (let e = 0; e < 4; e++) if (!two.includes(nbr(c, e))) ring.add(nbr(c, e));
    let i = 0;
    for (const c of ring) s.paint(c, 0, i++ % 2 ? 'wall' : 'house');
    const ct = s.shapes().courtyards;
    expect(ct.length).toBe(1);
    expect(ct[0].cells.sort()).toEqual(two.sort());
    expect(s.names().get('fountain')).toBe(1);
  });

  it('a side open (or a farm beside), or more than COURT_MAX cells: no courtyard', () => {
    const s = setup();
    for (let e = 0; e < 3; e++) s.paint(nbr(inner, e), 0, 'house');
    expect(s.shapes().courtyards.length).toBe(0);
    s.paint(nbr(inner, 3), 0, 'farm');
    expect(s.shapes().courtyards.length).toBe(0);
    expect(COURT_MAX).toBeLessThan(grid.count);
  });
});
