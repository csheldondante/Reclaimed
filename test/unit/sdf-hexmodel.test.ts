// A body's hex-prism cells as the store's cubes (src/engine/sdf/hexmodel.ts), and a model's content key
// (src/engine/engine.ts modelKey): pure.
import { describe, expect, it } from 'vitest';
import type { EngineCell } from '../../src/engine/engine';
import { hexSdfSpec } from '../../src/engine/sdf/hexmodel';
import { ROW_H } from '../../src/world/lattice';

// (the engine's module names WebGPU's usage flags as it loads: none are used by the pure functions tested here)
(globalThis as Record<string, unknown>).GPUBufferUsage ??= new Proxy({}, { get: () => 0 });
(globalThis as Record<string, unknown>).GPUShaderStage ??= new Proxy({}, { get: () => 0 });
const { bakeBody, modelKey } = await import('../../src/engine/engine');

const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat = 1): EngineCell[] => {
  const out: EngineCell[] = [];
  for (let z = z0; z < z0 + h; z++) for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, z, mat });
  return out;
};

describe('hexSdfSpec', () => {
  it('a block of cells is a box of half-cell cubes, less the corners the odd rows leave: its height exact, its sides within a quarter cell', () => {
    for (const [w, d, h] of [[2, 2, 2], [3, 3, 2], [4, 4, 4], [12, 2, 1]]) {
      const cells = box(10, 12, 5, w, d, h);
      const s = hexSdfSpec(cells, bakeBody(cells).com);
      expect(s.voxel).toBe(0.5);
      expect(s.size[2]).toBe(2 * h);
      // (rows of the other parity sit half a cell along: the cubes past a row's own end are empty, every layer alike)
      const filled = Array.from(s.vox).filter((v) => v).length;
      expect(filled / s.vox.length, `${w}x${d}x${h} filled`).toBeGreaterThan(d > 1 ? 0.75 : 0.99);
      const layer = s.size[0] * s.size[1];
      expect(Array.from(s.vox).slice(0, layer)).toEqual(Array.from(s.vox).slice(s.vox.length - layer));
      // (the true extents: w + half a cell where both row parities are in it, d rows of ROW_H)
      expect(Math.abs(s.size[0] * 0.5 - (w + (d > 1 ? 0.25 : 0)))).toBeLessThanOrEqual(0.25);
      expect(Math.abs(s.size[1] * 0.5 - d * ROW_H)).toBeLessThanOrEqual(0.25);
    }
  });

  it('the centre of mass sits inside the grid, at its middle for a box', () => {
    const cells = box(10, 12, 5, 4, 4, 4);
    const s = hexSdfSpec(cells, bakeBody(cells).com);
    s.com!.forEach((c, k) => expect(Math.abs(c - s.size[k] / 2)).toBeLessThan(0.51));
  });

  it('a one-cell hole and an L keep their shape', () => {
    const cells = box(0, 0, 0, 4, 4, 1).filter((c) => !(c.x >= 2 && c.y >= 2));
    const s = hexSdfSpec(cells, bakeBody(cells).com);
    const filled = Array.from(s.vox).filter((v) => v).length;
    // (twelve of sixteen cells: about three quarters of the grid)
    expect(filled / s.vox.length).toBeGreaterThan(0.55);
    expect(filled / s.vox.length).toBeLessThan(0.85);
  });
});

describe('modelKey', () => {
  it('is the same for the same cells moved by whole cells and two rows, whatever their order', () => {
    const a = box(3, 4, 5, 3, 2, 2);
    const b = box(13, 8, 9, 3, 2, 2).reverse();
    expect(modelKey(b).key).toBe(modelKey(a).key);
  });
  it('differs by a row of the other parity, by material and by shape', () => {
    const a = modelKey(box(3, 4, 5, 3, 2, 2)).key;
    expect(modelKey(box(3, 5, 5, 3, 2, 2)).key).not.toBe(a);
    expect(modelKey(box(3, 4, 5, 3, 2, 2, 2)).key).not.toBe(a);
    expect(modelKey(box(3, 4, 5, 2, 3, 2)).key).not.toBe(a);
  });
});
