// (round 128f) The check at placement (round 128l, m4: the GPU's components, reachgpu.ts — here its CPU reference,
// reach.ts CpuReach, with the same answers; a tap commits at once, the answer judges it after). The user: "My expectation is that we should always be
// able to reach blocks where we can place and say why we can't reach a block not yet placed. Blocks that lie adjacent to
// other blocks or planned blocks should always be reachable."
import { fortressOn } from './testing';
import { describe, expect, it } from 'vitest';
import { cellPos } from '../world/lattice';
import { Fortress } from './fortress';
import { CpuReach, surfacesOf, type ReachColumns } from './reach';
import { PIECE_WARN, rampPieces, warnPieces } from '../build/view';
import { RAMPS_ID, solidSpans } from '../build/solid';
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
  const f = fortressOn({ origin: [0, 0], w: W, h: H }, {
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
    // (the plan's own paint: the fortress's would refuse the far one)
    f.plan.paint(near, 0, 'house');
    f.plan.paint(far, 0, 'house');
    expect(await reached(f, near)).toBe(true);
    expect(f.reachedNow(far)).toBe(false);
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
  it('a block across deep water is pending as a ghost, then refused, and the panel says why', async () => {
    const f = fortress(columns((x) => x > 60 && x < 70));
    const far = f.cellAt(100, 40);
    expect(f.paint(far, 0, 'house')).toBe(true);
    // (in at once, drawn as the plan's ghost and no site for the builders until the answer)
    expect(f.plan.has(far, 0)).toBe(true);
    expect(f.isPending(far)).toBe(true);
    expect(f.ghost()?.(far, 0)).toBe(true);
    expect(f.cutCells().has(far)).toBe(true);
    await f.settled();
    expect(f.plan.has(far, 0)).toBe(false);
    expect(f.isPending(far)).toBe(false);
    expect(f.ghost()).toBe(undefined);
    expect(f.refusal).toBe("Builders can't reach that spot from the stores. Deep water is in the way.");
    const near = f.cellAt(40, 40);
    expect(f.paint(near, 0, 'house')).toBe(true);
    await f.settled();
    expect(f.refusal).toBe(null);
    expect(f.plan.has(near, 0)).toBe(true);
    expect(f.isPending(near)).toBe(false);
    // beside a planned block, and on it: reachable
    const beside = [0, 1, 2, 3].map((e) => f.grid.nbr[near * 4 + e]).find((c) => c >= 0)!;
    expect(f.paint(beside, 0, 'house')).toBe(true);
    expect(f.paint(near, 1, 'house')).toBe(true);
    await f.settled();
    expect(f.plan.has(beside, 0) && f.plan.has(near, 1)).toBe(true);
    expect(f.reachedNow(beside)).toBe(true);
  });

  it('a drag across deep water refuses only the blocks out of reach, and says how many', async () => {
    const f = fortress(columns((x) => x > 60 && x < 70));
    // (a line of wall from x 40 to 100: the cells in the water and past it are out of reach)
    const cells: number[] = [];
    for (let x = 40; x <= 100; x += 1) {
      const c = f.cellAt(x, 40);
      if (c >= 0 && !cells.includes(c)) cells.push(c);
    }
    expect(f.paintMany(cells, 0, 'wall')).toBe(cells.length);
    await f.settled();
    const kept = cells.filter((c) => f.plan.has(c, 0));
    const refused = cells.length - kept.length;
    expect(kept.length).toBeGreaterThan(3);
    expect(refused).toBeGreaterThan(3);
    for (const c of kept) expect(f.centre(c)[0]).toBeLessThan(66);
    expect(f.refusal).toBe(`${refused} of those ${cells.length} blocks were not planned. Builders can't reach them from the stores. Deep water is in the way.`);
    // every block planned is reached: nothing unreachable stays
    f.requestReach();
    await f.settled();
    expect(f.todoCells().every((c) => f.reachedNow(c))).toBe(true);
  });

  it('taps while a check is in flight are judged together', async () => {
    const f = fortress(columns((x) => x > 60 && x < 70));
    const near = f.cellAt(40, 60);
    const far = f.cellAt(100, 60);
    expect(f.paint(near, 0, 'farm')).toBe(true);
    expect(f.paint(far, 0, 'farm')).toBe(true);
    await f.settled();
    expect(f.plan.has(near, 0)).toBe(true);
    expect(f.plan.has(far, 0)).toBe(false);
    expect(f.refusal).toBe("1 of those 2 blocks was not planned. Builders can't reach it from the stores. Deep water is in the way.");
  });

  it('a ring of wall round nothing gets a gate (cells a builder can only stand inside of); inside a shut ring a block is refused: walled in', async () => {
    const f = fortress(columns(), [20, 20]);
    const ring = f.ringCells(90, 80, 12);
    expect(f.paintMany(ring, 0, 'wall')).toBe(ring.length);
    await f.settled();
    expect(ring.every((c) => f.plan.has(c, 0))).toBe(true);
    const gates = ring.filter((c) => f.plan.gate[c]);
    expect(gates.length).toBe(1);
    expect(f.variant).toBe('A gate goes in the wall, so builders can get in.');
    expect(f.refusal).toBe(null);
    // (the gate shut behind the check's back, and asked again: a closed ring, the wall cells inside it cut off already)
    f.plan.gate[gates[0]] = 0;
    f.requestReach();
    await f.settled();
    const inside = f.cellAt(90, 80);
    expect(f.paint(inside, 0, 'house')).toBe(true);
    await f.settled();
    expect(f.plan.has(inside, 0)).toBe(false);
    expect(f.refusal).toBe("Builders can't reach that spot from the stores. It is walled in. Put a gate in the wall first.");
  });

  it('a block that shuts a planned block in, with no variant to keep the way, is refused and the panel names it', async () => {
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
    expect(f.plan.has(round[3], 0)).toBe(false);
    expect(f.plan.passage[round[3]]).toBe(0);
    expect(f.refusal).toBe('That would shut the house off from the stores. Leave a way through.');
    expect(await reached(f, house)).toBe(true);
    // a farm (open ground) beside it doesn't shut it in
    expect(f.paint(round[3], 0, 'farm')).toBe(true);
    await f.settled();
    expect(f.refusal).toBe(null);
    expect(f.plan.has(round[3], 0)).toBe(true);
    expect(await reached(f, house)).toBe(true);
  });

  it('a wall closing a ring round a planned block gets a gate, at the straight wall cell nearest the stores; shutting it is refused', async () => {
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
    expect(f.refusal).toBe(null);
    expect(ring.every((c) => f.plan.has(c, 0))).toBe(true);
    expect(await reached(f, house)).toBe(true);
    // (the nearest the stores of the straight wall cells)
    const d = (c: number) => Math.hypot(f.centre(c)[0] - 20, f.centre(c)[1] - 20);
    for (const c of ring) if (f.plan.wallTile(c, 0) === 'straight') expect(d(gates[0])).toBeLessThanOrEqual(d(c) + 1e-9);
    // the gate shut: it opens again, and the panel says why
    expect(f.setGate(gates[0], false)).toBe(true);
    await f.settled();
    expect(f.plan.gate[gates[0]]).toBe(1);
    // (the house, and the wall cells a builder can only stand inside of)
    expect(f.refusal).toMatch(/^That would shut the house (and the wall )?off from the stores\. Leave a way through\.$/);
    // without the gate the house is cut off: the GPU's columns (solid.ts) would shut it in as the check did
    f.plan.gate[gates[0]] = 0;
    expect(await reached(f, house)).toBe(false);
  }, 20000);

  it('a ring of wall placed at once round a planned block gets a gate too', async () => {
    const f = fortress(columns(), [20, 20]);
    const house = f.cellAt(90, 80);
    expect(f.paint(house, 0, 'house')).toBe(true);
    await f.settled();
    const ring = f.ringCells(90, 80, 16);
    f.paintMany(ring, 0, 'wall');
    await f.settled();
    expect(ring.every((c) => f.plan.has(c, 0))).toBe(true);
    expect(ring.filter((c) => f.plan.gate[c]).length).toBe(1);
    expect(f.variant).toBe('A gate goes in the wall, so builders can get in.');
    expect(await reached(f, house)).toBe(true);
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
    expect(rampPieces(f.site, { ground: (x: number, y: number) => (x > 100 ? GROUND - 2 : GROUND) }).count).toBeGreaterThan(3);
    const sp = solidSpans({ plan: f.plan, town: f.town, grid: f.grid, ground: (col) => f.groundAt(col) }).get(RAMPS_ID)!;
    expect(sp.length).toBeGreaterThan(5);
    for (const q of sp) expect(q.z1).toBeLessThanOrEqual(GROUND + 1e-6);
    // without it, no way back up
    f.plan.ramp[ramps[0]] = -1;
    expect(await reached(f, low)).toBe(false);
  });

  it('a spot rock walls off is refused: a cliff', async () => {
    // (a cliff round a hollow)
    const f = fortress(columns(undefined, (x, y) => Math.abs(Math.hypot(x - 100, y - 100) - 14) < 2));
    expect(f.paint(f.cellAt(100, 100), 0, 'house')).toBe(true);
    await f.settled();
    expect(f.plan.has(f.cellAt(100, 100), 0)).toBe(false);
    expect(f.refusal).toBe("Builders can't reach that spot from the stores. A cliff or a building is in the way.");
  });
});

describe('the red outline (pieces.ts warnPieces)', () => {
  it('draws a rail a side, flagged for the red tint', () => {
    const f = fortress(columns());
    const c = f.cellAt(80, 80);
    f.plan.paint(c, 0, 'house');
    const warn = warnPieces(f.site, { ground: () => GROUND }, [c]);
    expect(warn.count).toBe(4);
    for (let i = 0; i < warn.count; i++) expect((warn.data[i * PIECE_FLOATS + 15] | 0) & PIECE_WARN).toBe(PIECE_WARN);
  });
});
