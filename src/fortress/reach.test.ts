// (round 128f) The check at placement (reach.ts, Fortress.placeWhy). The user: "My expectation is that we should always be
// able to reach blocks where we can place and say why we can't reach a block not yet placed. Blocks that lie adjacent to
// other blocks or planned blocks should always be reachable."
import { describe, expect, it } from 'vitest';
import { cellPos } from '../world/lattice';
import { Fortress } from './fortress';
import { ReachMap, surfacesOf, type ReachColumns } from './reach';

const W = 160;
const H = 184;
const GROUND = 5;

/** flat ground with deep water where `wet` says, and walls of rock where `rock` says */
function columns(wet: (x: number, y: number) => boolean = () => false, rock: (x: number, y: number) => boolean = () => false): ReachColumns {
  return {
    w: W,
    h: H,
    runs: (x, y) => (rock(...cellPos(x, y)) ? [[0, GROUND + 8]] : [[0, GROUND]]),
    water: (x, y) => (wet(...cellPos(x, y)) ? 2 : 0),
  };
}

function fortress(cols: ReachColumns, heap: [number, number] = [20, 20]) {
  const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground: () => GROUND,
    stores: () => ({}),
    changed: () => {},
    columns: () => cols,
    townHeap: () => heap,
  });
  f.ready = true;
  return f;
}

describe('reach: the agents rules on the CPU', () => {
  it('peels surfaces with room over them, links within a step, and keeps walkers out of deep water', () => {
    expect(surfacesOf([[0, 5], [5, 6]]).map((s) => s.z)).toEqual([6]);
    // (an arch: a lintel 2 m over the ground leaves the ground a surface, 1 m over it doesn't)
    expect(surfacesOf([[0, 5], [7, 8]]).map((s) => s.z)).toEqual([8, 5]);
    expect(surfacesOf([[0, 5], [6, 8]]).map((s) => s.z)).toEqual([8]);
    const river = columns((x) => x > 60 && x < 70);
    const m = new ReachMap(river, [10, 10], { box: [0, 0, W, H] });
    expect(m.reached(30, 30)).toBe(true);
    expect(m.reached(100, 30)).toBe(false);
    const wade = new ReachMap(river, [10, 10], { box: [0, 0, W, H], deep: false });
    expect(wade.reached(100, 30)).toBe(true);
    // a 2 m drop: a way down, no way back up (the stores' field reaches the low ground; a block's field never reaches
    // the stores) — both ways or it isn't reached
    const ledge: ReachColumns = { w: W, h: H, runs: (x) => (x > 100 ? [[0, GROUND - 2]] : [[0, GROUND]]), water: () => 0 };
    expect(new ReachMap(ledge, [10, 10], { box: [0, 0, W, H] }).reached(120, 30)).toBe(false);
    expect(new ReachMap(ledge, [10, 10], { box: [0, 0, W, H] }).reached(90, 30)).toBe(true);
  });
});

describe('the check at placement', () => {
  it("a block across deep water isn't planned, and the panel says why", () => {
    const f = fortress(columns((x) => x > 60 && x < 70));
    const far = f.cellAt(100, 40);
    expect(f.paint(far, 0, 'house')).toBe(false);
    expect(f.refusal).toContain('Deep water');
    const near = f.cellAt(40, 40);
    expect(f.paint(near, 0, 'house')).toBe(true);
    expect(f.refusal).toBe(null);
    // beside a planned block, and on it: reachable
    const beside = [0, 1, 2, 3].map((e) => f.grid.nbr[near * 4 + e]).find((c) => c >= 0)!;
    expect(f.paint(beside, 0, 'house')).toBe(true);
    expect(f.paint(near, 1, 'house')).toBe(true);
  });

  it('a block that would shut a planned block in is refused, and says which', () => {
    const f = fortress(columns(), [20, 20]);
    const house = f.cellAt(80, 80);
    expect(f.paint(house, 0, 'house')).toBe(true);
    const round = [0, 1, 2, 3].map((e) => f.grid.nbr[house * 4 + e]);
    // three sides walled: the fourth still open to the stores
    for (const c of round.slice(0, 3)) expect(f.paint(c, 0, 'wall')).toBe(true);
    expect(f.paint(round[3], 0, 'warehouse')).toBe(false);
    expect(f.refusal).toContain('shut the house off');
    expect(f.plan.has(round[3], 0)).toBe(false);
    // a farm (open ground) beside it doesn't shut it in
    expect(f.paint(round[3], 0, 'farm')).toBe(true);
    expect(f.reachedIn(f.reachMap()!, house)).toBe(true);
  });

  it('a spot rock walls off is said to be out of reach', () => {
    // (a cliff round a hollow)
    const f = fortress(columns(undefined, (x, y) => Math.abs(Math.hypot(x - 100, y - 100) - 14) < 2));
    expect(f.paint(f.cellAt(100, 100), 0, 'house')).toBe(false);
    expect(f.refusal).toContain('A cliff or a building');
  });
});
