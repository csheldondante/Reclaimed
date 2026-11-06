// (round 128p, DA-A13) The check at placement: the town's roads' reach (build/townroads.ts relayRoads — a union-find
// over the paths on the grid's edges, each structure a node open on every side), answered as the block goes in. The
// user: "in general we should not have blocks that agents can't reach" — what nothing reaches is fixed if a gate can (a
// wall shut round it), else refused and the panel says why in plain words.
import { fortressOn } from './testing';
import { describe, expect, it } from 'vitest';
import { Fortress } from './fortress';
import { PIECE_WARN, warnPieces } from '../build/view';
import { PIECE_FLOATS } from '../structures/pieces';

const W = 160;
const H = 184;
const GROUND = 5;

function fortress(o: { water?: (x: number, y: number) => number; ground?: (x: number, y: number) => number; heap?: [number, number] } = {}): Fortress {
  const f = fortressOn({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground: o.ground ?? (() => GROUND),
    water: o.water,
    stores: () => ({}),
    townHeap: () => o.heap ?? [20, 20],
  });
  f.ready = true;
  return f;
}

const river = (x: number) => (x > 60 && x < 70 ? 2 : 0);

describe('the check at placement (the roads’ reach)', () => {
  it('a block across a river gets a road grown to it, bridged; a block in the river is refused, and the panel says why', () => {
    const f = fortress({ water: river });
    const far = f.cellAt(100, 40);
    expect(f.paint(far, 0, 'house')).toBe(true);
    expect(f.reachedNow(far)).toBe(true);
    expect(f.plan.layout.roads!.curves.some((c) => c.kind === 'far')).toBe(true);
    expect(f.plan.layout.linear.some((l) => l.of === 'mainroad' && l.kind === 'bridge')).toBe(true);
    const wet = f.cellAt(65, 90);
    expect(f.paint(wet, 0, 'house')).toBe(false);
    expect(f.refusal).toBe("Builders can't reach that spot from the stores. Deep water is in the way.");
    const near = f.cellAt(40, 40);
    expect(f.paint(near, 0, 'house')).toBe(true);
    const beside = [0, 1, 2, 3].map((e) => f.grid.nbr[near * 4 + e]).find((c) => c >= 0 && !f.plan.has(c, 0))!;
    expect(f.paint(beside, 0, 'house')).toBe(true);
    expect(f.paint(near, 1, 'house')).toBe(true);
    expect(f.reachedNow(beside)).toBe(true);
    expect(f.cutCells().size).toBe(0);
  });

  it('a drag across a river: the blocks in the water refused, the panel says how many', () => {
    const f = fortress({ water: river });
    const cells: number[] = [];
    for (let x = 40; x <= 100; x += 1) {
      const c = f.cellAt(x, 40);
      if (c >= 0 && !cells.includes(c)) cells.push(c);
    }
    f.paintMany(cells, 0, 'house');
    const refused = cells.filter((c) => !f.plan.has(c, 0));
    expect(refused.length).toBeGreaterThan(0);
    for (const c of refused) expect(Math.abs(f.centre(c)[0] - 65)).toBeLessThan(8);
    expect(f.refusal).toBe(`${refused.length} of those ${cells.length} blocks were not planned. Builders can't reach them from the stores. Deep water is in the way.`);
    expect(f.todoCells().every((c) => f.reachedNow(c))).toBe(true);
  });

  it('a house shut in on every side by other houses is reached through them (a structure is one place)', () => {
    const f = fortress();
    const mid = f.cellAt(90, 90);
    const ring = [0, 1, 2, 3].map((e) => f.grid.nbr[mid * 4 + e]).filter((c) => c >= 0);
    for (const c of ring) expect(f.paint(c, 0, 'warehouse')).toBe(true);
    expect(f.paint(mid, 0, 'house')).toBe(true);
    expect(f.reachedNow(mid)).toBe(true);
    expect(f.refusal).toBe(null);
  });

  it('a house inside a ring of wall gets a gate, the panel says so; shutting it again is refused', () => {
    const f = fortress();
    const ring = f.ringCells(90, 80, 12);
    expect(f.paintMany(ring, 0, 'wall')).toBe(ring.length);
    const inside = f.cellAt(90, 80);
    expect(f.paint(inside, 0, 'house')).toBe(true);
    expect(f.reachedNow(inside)).toBe(true);
    const gates = ring.filter((c) => f.plan.gate[c]);
    expect(gates.length).toBe(1);
    expect(f.variant).not.toBe(null);
    // the gate shut: the house would be cut off — it opens again, and the panel says what it would cut off
    expect(f.setGate(gates[0], false)).toBe(true);
    expect(f.plan.gate[gates[0]]).toBe(1);
    expect(f.refusal).toMatch(/shut the house off/);
  });

  it('a spot on a ledge a cliff walls off all round is refused: a cliff', () => {
    // (a plateau 9 m up, its sides sheer: no edge of the grid climbs it at a stair's pitch)
    const plateau = (x: number, y: number) => (Math.hypot(x - 110, y - 110) < 14 ? GROUND + 9 : GROUND);
    const f = fortress({ ground: plateau });
    expect(f.paint(f.cellAt(110, 110), 0, 'house')).toBe(false);
    expect(f.refusal).toMatch(/cliff/i);
  });
});

describe('the red outline (pieces.ts warnPieces)', () => {
  it('draws a rail a side, flagged for the red tint', () => {
    const f = fortress();
    const c = f.cellAt(80, 80);
    f.plan.paint(c, 0, 'house');
    const warn = warnPieces(f.site, { ground: () => GROUND }, [c]);
    expect(warn.count).toBe(4);
    for (let i = 0; i < warn.count; i++) expect((warn.data[i * PIECE_FLOATS + 15] | 0) & PIECE_WARN).toBe(PIECE_WARN);
  });
});
