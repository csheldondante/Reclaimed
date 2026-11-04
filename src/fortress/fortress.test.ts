// Fortress slice 1, milestone 1 (Node, no GPU): the plan's cost and capacity, painting next to the same type adds to
// that structure, the wall tiles (joins, corners, gates) and the panel's writing.
import { describe, expect, it } from 'vitest';
import { lint } from '../../test/support/writing';
import { STRUCTURE_TYPES } from '../api/contracts/fortress';
import { Town } from '../build/town';
import { TownGrid } from '../build/towngrid';
import { library } from '../structures/modules';
import { DEFS } from './defs';
import { cityPlanOf, fortressPieces } from './pieces';
import { noWays } from './ways';
import { FortressPlan, wallTileOf } from './plan';
import { cutWarnLine, goodsText, planLines, structureLines, typeLines, variantLine } from './words';

const grid = new TownGrid(80, 92, { seed: 7 });
const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];
/** a cell well inside the grid: all four neighbours, theirs too */
const inner = (() => {
  for (let c = 0; c < grid.count; c++) {
    const ok = [0, 1, 2, 3].every((e) => nbr(c, e) >= 0 && [0, 1, 2, 3].every((f) => nbr(nbr(c, e), f) >= 0));
    const [x, y] = grid.centre(c);
    if (ok && x > 30 && y > 30) return c;
  }
  throw new Error('no inner cell');
})();

describe('the plan: cost and capacity', () => {
  it('a structure costs and gives blocks × its type\'s per-block numbers', () => {
    const p = new FortressPlan(grid);
    expect(p.paint(inner, 0, 'house')).toBe(true);
    expect(p.paint(inner, 1, 'house')).toBe(true);
    expect(p.paint(nbr(inner, 0), 0, 'house')).toBe(true);
    const s = p.structureAt(inner)!;
    expect(p.blocks(s)).toBe(3);
    expect(p.cost(s)).toEqual({ log: 12, stone: 6 });
    expect(p.gives(s)).toEqual({ beds: 12 });
    const t = p.totals({ log: 10, stone: 50 });
    expect(t.blocks).toBe(3);
    expect(t.short).toEqual({ log: 2 });
  });

  it('a yard lies flat; a type stacks no higher than its limit; another type can\'t share a cell', () => {
    const p = new FortressPlan(grid);
    expect(p.paint(inner, 0, 'farm')).toBe(true);
    expect(p.paint(inner, 1, 'farm')).toBe(false);
    expect(p.paint(inner, 1, 'house')).toBe(false);
    const c = nbr(inner, 2);
    // (round 128d: block types have no cap — the old ones were the 8 levels'; a capped type still stops at its cap)
    expect(DEFS.house.maxLevels).toBe(Infinity);
    for (let l = 0; l < 30; l++) expect(p.paint(c, l, 'house')).toBe(true);
    const capped = { ...DEFS, house: { ...DEFS.house, maxLevels: 3 } };
    const q = new FortressPlan(grid, capped);
    for (let l = 0; l < 3; l++) expect(q.paint(c, l, 'house')).toBe(true);
    expect(q.paint(c, 3, 'house')).toBe(false);
  });
});

describe('the plan: painting next to the same type adds to it', () => {
  it('joins a neighbour of the same type, starts a new one beside another type, merges two it bridges', () => {
    const p = new FortressPlan(grid);
    const a = inner;
    const b = nbr(a, 0);
    const c = nbr(b, 0);
    p.paint(a, 0, 'house');
    p.paint(b, 0, 'house');
    expect(p.owner[b]).toBe(p.owner[a]);
    // (beside a house, a warehouse is its own building)
    const w = nbr(a, 1);
    p.paint(w, 0, 'warehouse');
    expect(p.owner[w]).not.toBe(p.owner[a]);
    // two houses apart, then the cell between them: one house
    const p2 = new FortressPlan(grid);
    p2.paint(a, 0, 'house');
    p2.paint(c, 0, 'house');
    expect(p2.owner[a]).not.toBe(p2.owner[c]);
    expect(p2.structures().length).toBe(2);
    p2.paint(b, 0, 'house');
    expect(p2.structures().length).toBe(1);
    expect(p2.owner[a]).toBe(p2.owner[c]);
    expect(p2.blocks(p2.structureAt(a)!)).toBe(3);
    // erasing the last block of a cell frees it
    p2.erase(c, 0);
    expect(p2.owner[c]).toBe(-1);
    expect(p2.blocks(p2.structureAt(a)!)).toBe(2);
  });
});

describe('the wall tiles fit together', () => {
  it('names the tile by which sides join', () => {
    expect(wallTileOf([false, false, false, false])).toBe('post');
    expect(wallTileOf([true, false, false, false])).toBe('end');
    expect(wallTileOf([true, false, true, false])).toBe('straight');
    expect(wallTileOf([false, true, false, true])).toBe('straight');
    expect(wallTileOf([true, true, false, false])).toBe('corner');
    expect(wallTileOf([false, false, true, true])).toBe('corner');
    expect(wallTileOf([true, true, true, false])).toBe('tee');
    expect(wallTileOf([true, true, true, true])).toBe('cross');
  });

  it('a run of wall cells joins: straight in the middle, ends, a corner where it turns, a gate only in a straight run', () => {
    const p = new FortressPlan(grid);
    const m = inner;
    const a = nbr(m, 0);
    const b = nbr(m, 2);
    p.paint(m, 0, 'wall');
    expect(p.wallTile(m, 0)).toBe('post');
    p.paint(a, 0, 'wall');
    expect(p.wallTile(m, 0)).toBe('end');
    p.paint(b, 0, 'wall');
    expect(p.wallTile(m, 0)).toBe('straight');
    expect(p.wallTile(a, 0)).toBe('end');
    expect(p.setGate(m, true)).toBe(true);
    expect(p.setGate(a, true)).toBe(false);
    // a turn at a: its other side
    const side = [1, 2, 3].map((k) => nbr(a, k)).find((n) => n >= 0 && n !== m && !grid.nbr.slice(n * 4, n * 4 + 4).includes(m))!;
    p.paint(side, 0, 'wall');
    expect(['corner', 'straight']).toContain(p.wallTile(a, 0));
    // (one more beside the middle makes it a junction: its gate goes)
    p.paint(nbr(m, 1), 0, 'wall');
    expect(p.wallTile(m, 0)).toBe('tee');
    // a house beside a wall doesn't join it
    const h = nbr(m, 3);
    p.paint(h, 0, 'house');
    expect(p.wallJoins(m, 0)[3]).toBe(false);
  });

});

describe('the pieces: each type reads distinctly, walls fit together', () => {
  const lib = library();
  const names = (p: { module: Uint16Array; count: number }) => {
    const out = new Map<string, number>();
    for (let i = 0; i < p.count; i++) {
      const n = lib.modules[p.module[i]].name;
      out.set(n, (out.get(n) ?? 0) + 1);
    }
    return out;
  };
  const make = () => {
    const town = new Town(80, 92, { ground: () => 5, stamp: () => { throw new Error('no stamps'); }, zMax: 200 }, { grid });
    const plan = new FortressPlan(grid);
    const paint = (c: number, l: number, t: Parameters<FortressPlan['paint']>[2]) => {
      expect(plan.paint(c, l, t)).toBe(true);
      town.plan(c, l, true);
    };
    // (bare: the shapes' own rules, no ways — roads and stairs are ways.test.ts's)
    const pieces = (bare = false) => fortressPieces({ plan, town, grid, ground: () => 5, zOff: 0, ways: bare ? noWays(grid.count) : undefined });
    return { town, plan, paint, pieces };
  };

  it('a wall run (round 128d: thinner than its cells): a band a joined side, merlons on both faces, towers at its ends, a gate arch', () => {
    const f = make();
    const m = inner;
    const run = [nbr(m, 0), m, nbr(m, 2)];
    for (const c of run) f.paint(c, 0, 'wall');
    const p = f.pieces(true);
    let n = names(p);
    // a middle square a cell, a band from it to each side that meets the run: the ends one each, the middle two
    expect(n.get('rampart')).toBe(3 + 4);
    // (thin: every rampart's frame narrower than half a cell)
    const rampart = lib.id('rampart');
    for (let i = 0; i < p.count; i++) {
      if (p.module[i] !== rampart) continue;
      const d = p.data.subarray(i * 16, i * 16 + 8);
      const side = (a: number, b: number) => Math.hypot(d[b * 2] - d[a * 2], d[b * 2 + 1] - d[a * 2 + 1]);
      expect(Math.min(side(0, 1), side(1, 2))).toBeLessThan(2.5);
    }
    // (two ends: a tower each; the middle carries the run on)
    expect(n.get('tower')).toBe(2);
    // merlons: both faces of each band
    expect(n.get('merlons')).toBe(4 * 2);
    expect(f.plan.setGate(m, true)).toBe(true);
    n = names(f.pieces(true));
    // the gate: an arch in both faces of the middle's two bands
    expect(n.get('gatearch')).toBe(4);
    // a tower where the player put one
    expect(f.plan.setTower(m, true)).toBe(true);
    expect(names(f.pieces(true)).get('tower')).toBe(3);
    expect(f.plan.setTower(m, false)).toBe(true);
    // a corner: a cell beside an end, off the run's line, makes that end a corner (a tower still)
    const end = run[0];
    const toMid = [0, 1, 2, 3].find((e) => nbr(end, e) === m)!;
    const side = nbr(end, (toMid + 1) % 4);
    f.paint(side, 0, 'wall');
    expect(f.plan.wallTile(end, 0)).toBe('corner');
    // (the run's other end and the new end; the corner too where it turns sharply)
    const towers = names(f.pieces(true)).get('tower')!;
    expect(towers === 2 || towers === 3).toBe(true);
  });

  it('houses are plaster walls and tile roofs; barracks dressed stone; farms crops; a quarry its spoil and crane', () => {
    const f = make();
    f.paint(inner, 0, 'house');
    f.paint(inner, 1, 'house');
    const n = names(f.pieces());
    expect([...n.keys()].some((k) => k.startsWith('plaster0:door'))).toBe(true);
    expect([...n.keys()].some((k) => k.startsWith('plaster:'))).toBe(true);
    expect([...n.keys()].some((k) => k.startsWith('roof'))).toBe(true);
    const g = make();
    g.paint(inner, 0, 'barracks');
    g.paint(nbr(nbr(inner, 0), 0), 0, 'farm');
    g.paint(nbr(nbr(inner, 2), 2), 0, 'quarry');
    const k = [...names(g.pieces()).keys()];
    expect(k.some((x) => x.startsWith('stone:'))).toBe(true);
    expect(k).toContain('crop');
    expect(k).toContain('prop:spoil');
    expect(k).toContain('prop:crane');
    expect(k).toContain('prop:banner');
  });

  it('a type that joins is one building; one that does not stands as a unit a cell (row homes)', () => {
    const f = make();
    const b = nbr(inner, 0);
    f.paint(inner, 0, 'house');
    f.paint(b, 0, 'house');
    const one = cityPlanOf({ plan: f.plan, town: f.town, grid, ground: () => 5, zOff: 0 }, 'hearth');
    expect(one.plan.buildings.length).toBe(1);
    const was = DEFS.house.joins;
    DEFS.house.joins = false;
    try {
      const apart = cityPlanOf({ plan: f.plan, town: f.town, grid, ground: () => 5, zOff: 0 }, 'hearth');
      expect(apart.plan.buildings.length).toBe(2);
      // (each its own walls on the side they share)
      expect(apart.plan.facades.length).toBeGreaterThan(one.plan.facades.length);
    } finally {
      DEFS.house.joins = was;
    }
  });
});

describe('the planning panel reads plainly (docs/WRITING.md)', () => {
  it('every line passes the lint', () => {
    const p = new FortressPlan(grid);
    p.paint(inner, 0, 'house');
    p.paint(inner, 1, 'house');
    const lines: string[] = [];
    for (const t of STRUCTURE_TYPES) {
      lines.push(...typeLines(DEFS[t]));
      lines.push(...structureLines(DEFS[t], 3, { log: 6, stone: 3 }, { beds: 4, jobs: 2, posts: 2, storage: 50, makes: { grain: 2 } }));
      // (round 128h) the ways kept open, and what a placement cut off
      for (const k of ['gate', 'passage', 'ramp'] as const) lines.push(variantLine(k, t));
    }
    lines.push(cutWarnLine(['house']), cutWarnLine(['house', 'farm', 'fortress']));
    lines.push(...planLines(p.totals({ log: 2 }), { log: 2 }));
    lines.push(...planLines(p.totals({ log: 99, stone: 99 }), { log: 99, stone: 99 }));
    for (const l of lines) expect(lint(l), l).toEqual([]);
    expect(goodsText({ log: 24, stone: 12 })).toBe('24 wood and 12 stone');
    expect(planLines(p.totals({ log: 2 }), { log: 2 })[2]).toBe('You need 6 wood and 4 stone more.');
  });
});
