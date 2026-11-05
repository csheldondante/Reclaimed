// (round 128f) The check at placement (round 128l, m4: the GPU's components, reachgpu.ts — here its CPU reference,
// reach.ts CpuReach, with the same answers; a tap commits at once, the answer judges it after). The user: "My expectation is that we should always be
// able to reach blocks where we can place and say why we can't reach a block not yet placed. Blocks that lie adjacent to
// other blocks or planned blocks should always be reachable."
import { describe, expect, it } from 'vitest';
import { cellPos } from '../world/lattice';
import { Fortress } from './fortress';
import { CpuReach, surfacesOf, type ReachColumns } from './reach';
import { PIECE_WARN, rampPieces, warnPieces } from './pieces';
import { RAMPS_ID, solidSpans } from './solid';
import { PIECE_FLOATS } from '../structures/pieces';

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

function fortress(cols: ReachColumns, heap: [number, number] = [20, 20], ground: (x: number, y: number) => number = () => GROUND) {
  const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground,
    stores: () => ({}),
    changed: () => {},
    reach: new CpuReach(cols, W, H, () => [0, 0]),
    townHeap: () => heap,
  });
  f.ready = true;
  return f;
}

/** whether the stores reach a cell now (asked again, answered) */
async function reached(f: Fortress, cell: number): Promise<boolean> {
  f.requestReach();
  await f.settled();
  return f.reachedNow(cell);
}

describe('reach: the agents rules (the CPU reference of fortreach.wgsl)', () => {
  it('peels surfaces with room over them, joins within a step both ways, and keeps walkers out of deep water', async () => {
    expect(surfacesOf([[0, 5], [5, 6]]).map((s) => s.z)).toEqual([6]);
    // (an arch: a lintel 2 m over the ground leaves the ground a surface, 1 m over it doesn't)
    expect(surfacesOf([[0, 5], [7, 8]]).map((s) => s.z)).toEqual([8, 5]);
    expect(surfacesOf([[0, 5], [6, 8]]).map((s) => s.z)).toEqual([8]);
    const f = fortress(columns((x) => x > 60 && x < 70));
    const near = f.cellAt(40, 40);
    const far = f.cellAt(100, 40);
    f.paint(near, 0, 'house');
    f.paint(far, 0, 'house');
    await f.settled();
    expect(f.reachedNow(near)).toBe(true);
    expect(f.reachedNow(far)).toBe(false);
    expect(f.whyNot(far)).toBe('deep');
    // a 2 m drop: a way down, no way back up — both ways or it isn't reached
    const ledge: ReachColumns = { w: W, h: H, runs: (x) => (x > 100 ? [[0, GROUND - 2]] : [[0, GROUND]]), water: () => 0 };
    const g = fortress(ledge);
    const low = g.cellAt(125, 40);
    const high = g.cellAt(85, 40);
    g.plan.paint(low, 0, 'farm');
    g.plan.paint(high, 0, 'farm');
    expect(await reached(g, high)).toBe(true);
    expect(g.reachedNow(low)).toBe(false);
  });
});

describe('the check at placement', () => {
  it('a block across deep water is placed at once, then outlined, and the panel says why', async () => {
    const f = fortress(columns((x) => x > 60 && x < 70));
    const far = f.cellAt(100, 40);
    expect(f.paint(far, 0, 'house')).toBe(true);
    await f.settled();
    expect(f.warnCells).toEqual([far]);
    expect(f.warning).toContain('Deep water');
    expect(f.warning).toContain('outlined in red');
    const near = f.cellAt(40, 40);
    expect(f.paint(near, 0, 'house')).toBe(true);
    await f.settled();
    expect(f.warning).toBe(null);
    // beside a planned block, and on it: reachable
    const beside = [0, 1, 2, 3].map((e) => f.grid.nbr[near * 4 + e]).find((c) => c >= 0)!;
    expect(f.paint(beside, 0, 'house')).toBe(true);
    expect(f.paint(near, 1, 'house')).toBe(true);
    await f.settled();
    expect(f.reachedNow(beside)).toBe(true);
  });

  it('a block that shuts a planned block in, with no variant to keep the way, is placed with a warning naming it', async () => {
    const f = fortress(columns(), [20, 20]);
    const house = f.cellAt(80, 80);
    expect(f.paint(house, 0, 'house')).toBe(true);
    const round = [0, 1, 2, 3].map((e) => f.grid.nbr[house * 4 + e]);
    // three sides walled: the fourth still open to the stores
    for (const c of round.slice(0, 3)) expect(f.paint(c, 0, 'wall')).toBe(true);
    await f.settled();
    // (a builder works a block from beside it: a passage through the warehouse leaves the house no side to stand at)
    expect(f.paint(round[3], 0, 'warehouse')).toBe(true);
    await f.settled();
    expect(f.plan.has(round[3], 0)).toBe(true);
    expect(f.plan.passage[round[3]]).toBe(0);
    expect(f.warnCells).toEqual([house]);
    expect(f.warning).toBe("That shuts the house off from the stores. Builders can't get there. It is outlined in red.");
    expect(f.refusal).toBe(null);
    // outlined in red: a rail a side, flagged for the red tint
    const warn = warnPieces({ plan: f.plan, town: f.town, grid: f.grid, ground: () => GROUND, zOff: 0 }, f.warnCells);
    expect(warn.count).toBe(4);
    for (let i = 0; i < warn.count; i++) expect((warn.data[i * PIECE_FLOATS + 15] | 0) & PIECE_WARN).toBe(PIECE_WARN);
    // the next press clears it; a farm (open ground) beside it doesn't shut it in
    expect(f.erase(round[3], 0)).toBe(true);
    expect(f.warnCells).toEqual([]);
    expect(f.paint(round[3], 0, 'farm')).toBe(true);
    await f.settled();
    expect(f.warning).toBe(null);
    expect(await reached(f, house)).toBe(true);
  });

  it('a wall closing a ring round a planned block gets a gate, at the straight wall cell nearest the stores', async () => {
    const f = fortress(columns(), [20, 20]);
    const [cx, cy] = [90, 80];
    const house = f.cellAt(cx, cy);
    expect(f.paint(house, 0, 'house')).toBe(true);
    const ring = f.ringCells(cx, cy, 16);
    // (a tap at a time, each answered: the last closes the ring)
    for (const c of ring) {
      expect(f.paint(c, 0, 'wall')).toBe(true);
      await f.settled();
    }
    // the last wall closed the ring: a gate went in, and the builders get to the house
    const gates = ring.filter((c) => f.plan.gate[c]);
    expect(gates.length).toBe(1);
    expect(f.variant).toBe('A gate goes in the wall, so builders can get in.');
    expect(f.variantAt).toBe(gates[0]);
    expect(f.warnCells).toEqual([]);
    expect(await reached(f, house)).toBe(true);
    // (the nearest the stores of the straight wall cells)
    const d = (c: number) => Math.hypot(f.centre(c)[0] - 20, f.centre(c)[1] - 20);
    for (const c of ring) if (f.plan.wallTile(c, 0) === 'straight') expect(d(gates[0])).toBeLessThanOrEqual(d(c) + 1e-9);
    // without the gate the house is cut off: the GPU's columns (solid.ts) would shut it in as the check did
    f.plan.gate[gates[0]] = 0;
    expect(await reached(f, house)).toBe(false);
  }, 20000);

  it('a house placed across the only way to another gets a passage through its ground floor', async () => {
    // (a thin cliff round a hollow, open where one cell on its +x side crosses it)
    let gap = -1;
    let f: Fortress | null = null;
    const ring = (x: number, y: number) => Math.abs(Math.hypot(x - 100, y - 100) - 14) < 1.2;
    f = fortress(columns(undefined, (x, y) => ring(x, y) && f!.cellAt(x, y) !== gap));
    gap = f.cellAt(114, 100);
    const inside = f.cellAt(100, 100);
    expect(f.paint(inside, 0, 'house')).toBe(true);
    expect(await reached(f, inside)).toBe(true);
    expect(f.paint(gap, 0, 'house')).toBe(true);
    await f.settled();
    expect(f.plan.passage[gap]).toBe(1);
    expect(f.variant).toBe('The house gets an arch through its ground floor, so builders can walk through.');
    expect(await reached(f, inside)).toBe(true);
    // its solid: only a lintel over the ground floor (the GPU's columns the same: solid.ts)
    f.plan.passage[gap] = 0;
    expect(await reached(f, inside)).toBe(false);
  });

  it('a spot below a drop builders walk down but not up gets a ramp', async () => {
    const ledge: ReachColumns = { w: W, h: H, runs: (x) => (x > 100 ? [[0, GROUND - 2]] : [[0, GROUND]]), water: () => 0 };
    // (the ground the fortress reads is the columns': a ramp's heights are taken from it)
    const f = fortress(ledge, [20, 20], (x) => (x > 100 ? GROUND - 2 : GROUND));
    const low = f.cellAt(125, 40);
    expect(f.paint(low, 0, 'house')).toBe(true);
    await f.settled();
    expect(f.variant).toBe('A ramp goes up the drop, so builders can climb back to the stores.');
    const ramps = f.plan.ramps();
    expect(ramps.length).toBe(1);
    expect(await reached(f, low)).toBe(true);
    // drawn as steps; its solid (what the GPU's columns are claimed with: claims.ts) its own key, there while only planned
    const inp = { plan: f.plan, town: f.town, grid: f.grid, ground: (x: number, y: number) => (x > 100 ? GROUND - 2 : GROUND), zOff: 0 };
    expect(rampPieces(inp).count).toBeGreaterThan(3);
    const sp = solidSpans({ plan: f.plan, town: f.town, grid: f.grid, ground: (col) => f.groundAt(col) }).get(RAMPS_ID)!;
    expect(sp.length).toBeGreaterThan(5);
    for (const q of sp) expect(q.z1).toBeLessThanOrEqual(GROUND + 1e-6);
    // without it, no way back up
    f.plan.ramp[ramps[0]] = -1;
    expect(await reached(f, low)).toBe(false);
  });

  it('a spot rock walls off is said to be out of reach', async () => {
    // (a cliff round a hollow)
    const f = fortress(columns(undefined, (x, y) => Math.abs(Math.hypot(x - 100, y - 100) - 14) < 2));
    expect(f.paint(f.cellAt(100, 100), 0, 'house')).toBe(true);
    await f.settled();
    expect(f.warnCells).toEqual([f.cellAt(100, 100)]);
    expect(f.warning).toContain('Builders can');
  });
});
