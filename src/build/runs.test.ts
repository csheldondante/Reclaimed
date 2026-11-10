// (round 128d) Occupancy as runs per cell (runs.ts) and the Town on it (town.ts): runs merge and split, no level cap,
// gaps, the plan's delta; the fortress plan's height and its rule for a block over an empty level.
import { describe, expect, it } from 'vitest';
import { CellRuns } from './runs';
import { LEVEL_H, Town } from './town';
import { TownGrid } from './towngrid';

const spans = (r: CellRuns, c: number) => r.runsOf(c).map((x) => [x.lo, x.hi, x.owner, x.type]);

describe('runs per cell', () => {
  it('touching levels of one owner and type merge into one run', () => {
    const r = new CellRuns(4);
    expect(r.set(1, 0, 7, 2)).toBe(true);
    expect(r.set(1, 2, 7, 2)).toBe(true);
    expect(spans(r, 1)).toEqual([[0, 1, 7, 2], [2, 3, 7, 2]]);
    expect(r.set(1, 1, 7, 2)).toBe(true);
    expect(spans(r, 1)).toEqual([[0, 3, 7, 2]]);
    expect(r.set(1, 1, 7, 2)).toBe(false);
    expect(r.levels(1)).toBe(3);
    expect(r.top(1)).toBe(2);
  });

  it('a different owner or type starts a run of its own', () => {
    const r = new CellRuns(2);
    r.set(0, 0, 1, 0);
    r.set(0, 1, 2, 0);
    r.set(0, 2, 2, 5);
    expect(spans(r, 0)).toEqual([[0, 1, 1, 0], [1, 2, 2, 0], [2, 3, 2, 5]]);
    // (folded: owner 1 becomes 2 — the first two touch and merge)
    r.reown(0, 1, 2);
    expect(spans(r, 0)).toEqual([[0, 2, 2, 0], [2, 3, 2, 5]]);
    r.ownAll(0, 3, 5);
    expect(spans(r, 0)).toEqual([[0, 3, 3, 5]]);
  });

  it('taking a level out of the middle splits the run; its ends shrink it; the last empties the cell', () => {
    const r = new CellRuns(1);
    for (let L = 0; L < 6; L++) r.set(0, L);
    expect(r.clear(0, 3)).toBe(true);
    expect(spans(r, 0)).toEqual([[0, 3, 0, 0], [4, 6, 0, 0]]);
    expect(r.has(0, 3)).toBe(false);
    expect(r.clear(0, 3)).toBe(false);
    r.clear(0, 0);
    r.clear(0, 5);
    expect(spans(r, 0)).toEqual([[1, 3, 0, 0], [4, 5, 0, 0]]);
    for (const L of [1, 2, 4]) r.clear(0, L);
    expect(r.any(0)).toBe(false);
    expect(r.top(0)).toBe(-1);
  });

  it('holds hundreds of levels as one run', () => {
    const r = new CellRuns(1);
    for (let L = 0; L < 300; L++) r.set(0, L);
    expect(r.runsOf(0).length).toBe(1);
    expect(r.top(0)).toBe(299);
    expect([...r.each(0)].length).toBe(300);
  });

  it('compares two cells by their levels (owners aside)', () => {
    const r = new CellRuns(2);
    r.set(0, 0, 1);
    r.set(0, 1, 2);
    r.set(1, 0, 3);
    r.set(1, 1, 3);
    expect(r.sameLevels(0, 1)).toBe(true);
    r.set(1, 3, 3);
    expect(r.sameLevels(0, 1)).toBe(false);
  });
});

const grid = new TownGrid(80, 92, { seed: 7 });
const GROUND = 5;
const newTown = () => new Town(80, 92, { ground: () => GROUND, stamp: null, zMax: Infinity }, { grid });
// a cell with four neighbours, well inside
let inner = -1;
for (let c = 0; c < grid.count && inner < 0; c++) {
  let ok = true;
  for (let e = 0; e < 4; e++) {
    const n = grid.nbr[c * 4 + e];
    if (n < 0) ok = false;
    else for (let f = 0; f < 4; f++) if (grid.nbr[n * 4 + f] < 0) ok = false;
  }
  if (ok && grid.centre(c)[0] > 30 && grid.centre(c)[1] > 30) inner = c;
}
const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];

describe('the Town on runs', () => {
  it('stacks 24 levels (no cap) and each floor is LEVEL_H over the last', () => {
    const t = newTown();
    for (let L = 0; L < 24; L++) expect(t.add(inner, L)).toBe(true);
    expect(t.top(inner)).toBe(23);
    expect(t.blocks().length).toBe(24);
    expect(t.floorZ(inner, 23) - t.floorZ(inner, 0)).toBe(23 * LEVEL_H);
    expect(t.built.runsOf(inner).length).toBe(1);
  });

  it('a stamped town still stops under its window ceiling', () => {
    const t = new Town(80, 92, { ground: () => GROUND, stamp: null, zMax: 64 }, { grid });
    let L = 0;
    while (t.add(inner, L)) L++;
    // (its roof must clear zMax - 2: 64 - 2 - 4.1 over a floor at ~5.5)
    expect(L).toBe(Math.floor((64 - 2 - 0.6 - 3.5 - t.base[inner]) / LEVEL_H));
  });

  it('a gap: a block over an empty level stands on pillars, its own floor at its level', () => {
    const t = newTown();
    t.add(inner, 0);
    t.add(inner, 2);
    expect(t.built.runsOf(inner).length).toBe(2);
    const col = grid.columns[inner][0];
    const ivs = t.design(inner, col);
    // nothing between the first level's roof and the third's floor but a pillar or an arch (wall material)
    expect(ivs.some((iv) => iv.z0 >= t.floorZ(inner, 2) - 0.01)).toBe(true);
    expect(t.top(inner)).toBe(2);
  });

  it('the delta: what the plan adds and takes down, bottom up, gaps and all', () => {
    const t = newTown();
    for (const L of [0, 1, 2]) t.add(inner, L);
    t.plan(inner, 1, false);
    t.plan(inner, 5, true);
    t.plan(inner, 20, true);
    t.plan(nbr(inner, 0), 0, true);
    const d = t.delta().filter((b) => b.cell === inner);
    expect(d).toEqual([
      { cell: inner, level: 1, add: false },
      { cell: inner, level: 5, add: true },
      { cell: inner, level: 20, add: true },
    ]);
    expect(t.delta().some((b) => b.cell === nbr(inner, 0) && b.level === 0 && b.add)).toBe(true);
    t.add(inner, 5);
    t.remove(inner, 1);
    expect(t.delta().filter((b) => b.cell === inner)).toEqual([{ cell: inner, level: 20, add: true }]);
  });

  it('runs carry the caller\'s owner and type', () => {
    const t = newTown();
    t.plan(inner, 0, true, 4, 6);
    t.add(inner, 1, 4, 6);
    expect(t.plans.runsOf(inner).map((r) => [r.lo, r.hi, r.owner, r.type])).toEqual([[0, 2, 4, 6]]);
    expect(t.built.runsOf(inner).map((r) => [r.lo, r.hi, r.owner, r.type])).toEqual([[1, 2, 4, 6]]);
  });
});
