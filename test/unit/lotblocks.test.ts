// (PA11) A lot's building as blocks for the physics engine (citygen/lotblocks.ts): the blocks hold exactly the cells
// of the footprint's columns × its layers — the volume in is the volume out — no cell twice, and a house big enough comes apart into several.
import { describe, expect, it } from 'vitest';
import { lotBlocks, lotColumns, lotLayers, type LotBox } from '../../src/citygen/lotblocks';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';

// (a house turned about z: 10 by 7, its base at 100.4, 3.8 high)
const turn = (x: number, y: number, a: number): [number, number] => [40 + x * Math.cos(a) - y * Math.sin(a), 30 + x * Math.sin(a) + y * Math.cos(a)];
const house = (a: number, flip = false): LotBox => {
  const q = [turn(-5, -3.5, a), turn(5, -3.5, a), turn(5, 3.5, a), turn(-5, 3.5, a)];
  return { quad: flip ? q.reverse() : q, base: 100.4, height: 3.8, hash: 7 };
};

describe('a lot as blocks', () => {
  it('takes the columns whose centres are inside the footprint, whichever way it winds', () => {
    for (const a of [0, 0.4, 1.1]) {
      const cols = lotColumns(house(a).quad);
      expect(lotColumns(house(a, true).quad)).toEqual(cols);
      // (about its area in columns: a column is 0.866 of a unit square)
      expect(cols.length).toBeGreaterThan((70 / 0.866) * 0.85);
      expect(cols.length).toBeLessThan((70 / 0.866) * 1.15);
      for (const [x, y] of cols) {
        const [px, py] = cellPos(x, y);
        expect(Math.hypot(px - 40, py - 30)).toBeLessThan(Math.hypot(5, 3.5) + 0.01);
      }
    }
  });

  it('holds every cell of the footprint × its layers once: volume in is volume out (the mass: test/gpu/engine-house.test.ts)', () => {
    for (const a of [0, 0.4, 1.1]) {
      const lot = house(a);
      const cols = lotColumns(lot.quad);
      const { z0, n } = lotLayers(lot.base, lot.height);
      expect([z0, n]).toEqual([101, 3]);
      const blocks = lotBlocks(lot, MAT.Concrete);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(blocks.length).toBeLessThanOrEqual(8);
      const seen = new Set<string>();
      for (const b of blocks) for (const c of b) {
        expect(c.mat).toBe(MAT.Concrete);
        expect(c.z).toBeGreaterThanOrEqual(z0);
        expect(c.z).toBeLessThan(z0 + n);
        seen.add(`${c.x},${c.y},${c.z}`);
      }
      const cells = blocks.reduce((s, b) => s + b.length, 0);
      expect(cells).toBe(cols.length * n);
      expect(seen.size).toBe(cells);
    }
  });

  it('a hut stays one block, a tall house is cut in two layers', () => {
    const hut: LotBox = { quad: [[10, 10], [14, 10], [14, 13], [10, 13]], base: 50, height: 3, hash: 1 };
    expect(lotBlocks(hut, MAT.Brick)).toHaveLength(1);
    const tower: LotBox = { ...hut, height: 8 };
    expect(lotBlocks(tower, MAT.Brick)).toHaveLength(2);
    expect(lotBlocks({ ...hut, quad: [[0, 0], [0, 0], [0, 0], [0, 0]] }, MAT.Brick)).toHaveLength(0);
  });
});
