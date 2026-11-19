// Nested scales lab, round 18 (docs/design/NESTED_SCALES.md "As built (round 18)"): the owner's snap to the grid. Every
// stored bound is a multiple of 1/8 of its level's column unit (round half up); a brush's centre sits on a column corner,
// its radius is a whole number of columns and its centre height a multiple of 1/8, so a ball's span on a column depends
// only on the column's offset from the centre.
import { describe, expect, it } from 'vitest';
import { applyBall, ballHalf, Level, Nest, OPEN_BOTTOM, snapBrush, snapZ, toPart, type Col } from '../../src/nested/oracle';
import { fixMean } from '../../src/nested/boxmesh';

const onGrid = (z: number) => Number.isInteger(z * 8);

describe('nested scales: snap to the grid (round 18)', () => {
  it('snapZ rounds half up to 1/8, idempotent, OPEN_BOTTOM kept', () => {
    expect(snapZ(0.0625)).toBe(0.125);
    expect(snapZ(-0.0625)).toBe(0);
    expect(snapZ(0.06)).toBe(0);
    expect(snapZ(-0.19)).toBe(-0.25);
    for (const z of [3.3, -7.77, 100.0625, 0]) expect(snapZ(snapZ(z))).toBe(snapZ(z));
    expect(snapZ(OPEN_BOTTOM)).toBe(OPEN_BOTTOM);
  });

  it('a snapped ball: spans symmetric and identical wherever its centre lands on the grid', () => {
    for (let r = 1; r <= 12; r++) {
      const table = new Map<string, number>();
      for (let dy = -r - 1; dy <= r; dy++)
        for (let dx = -r - 1; dx <= r; dx++) {
          const h = ballHalf(dx + 0.5, dy + 0.5, r);
          table.set(`${dx},${dy}`, h);
          if (h >= 0) expect(onGrid(h), `r ${r} offset ${dx},${dy}`).toBe(true);
          // mirror images of the column round the corner: (dx, dy) -> (-1 - dx, dy), (dx, -1 - dy), (dy, dx)
          expect(ballHalf(-1 - dx + 0.5, dy + 0.5, r)).toBe(h);
          expect(ballHalf(dx + 0.5, -1 - dy + 0.5, r)).toBe(h);
          expect(ballHalf(dy + 0.5, dx + 0.5, r)).toBe(h);
        }
      // the same spans at random grid centres (the column's offset is all that matters)
      for (let t = 0; t < 20; t++) {
        const b = snapBrush(Math.random() * 500 - 250, Math.random() * 500 - 250, r + Math.random() * 0.98 - 0.49, Math.random() * 60 - 30);
        expect(b.r).toBe(r);
        expect(Number.isInteger(b.cx) && Number.isInteger(b.cy) && onGrid(b.cz)).toBe(true);
        for (let dy = -r - 1; dy <= r; dy++)
          for (let dx = -r - 1; dx <= r; dx++) {
            const X = b.cx + dx;
            const Y = b.cy + dy;
            expect(ballHalf(X + 0.5 - b.cx, Y + 0.5 - b.cy, b.r)).toBe(table.get(`${dx},${dy}`));
          }
      }
    }
  });

  it('a carve and an add on snapped bounds leave snapped bounds; a record snapped to zero thickness is gone', () => {
    const c: Col = { mat: [1, 2], z0: [OPEN_BOTTOM, 4], z1: [4, 9.5] };
    const h = ballHalf(1.5, 0.5, 3);
    const carved = applyBall(c, 'carve', 6.25 - h, 6.25 + h);
    for (let i = 0; i < carved.mat.length; i++) {
      expect(onGrid(carved.z1[i])).toBe(true);
      if (i) expect(onGrid(carved.z0[i])).toBe(true);
    }
    const added = applyBall(c, 'add', 10 - h, 10 + h);
    for (let i = 0; i < added.mat.length; i++) expect(onGrid(added.z1[i])).toBe(true);
    // (a 0.05 thick skin snaps to nothing: the stored partition has no record for it)
    const p = toPart({ mat: [1, 2, 1], z0: [OPEN_BOTTOM, 5, 5.04], z1: [4, 5.04, 9] });
    expect(p.top.every(onGrid)).toBe(true);
    expect(p.mat).not.toContain(2);
  });

  it('the oracle stores only snapped bounds at every level after edits (terrain, brushes, enhance, restrict)', () => {
    const k = 8;
    const root = new Level({ depth: 0, gx: 0, gy: 0, n: 16, z0: 0 });
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) root.set(x, y, { mat: [1, 2], z0: [OPEN_BOTTOM, 3 + 0.3 * Math.sin(x)], z1: [3 + 0.3 * Math.sin(x), 5 + 0.7 * Math.cos(y / 3)] });
    const o = new Nest(root, k, 7);
    o.promote({ depth: 1, gx: 32, gy: 32, n: 48, z0: 4 });
    o.edit(1, 'carve', 50.3, 55.6, 3.4, 0, 6.03);
    o.edit(1, 'raise', 60, 60, 4, 2);
    o.edit(1, 'add', 45, 70, 2.6, 0, 12.2);
    for (const lv of o.levels)
      for (const p of lv.parts) {
        expect(p.top.every(onGrid), `depth ${lv.f.depth}: ${p.top.join(', ')}`).toBe(true);
      }
  });

  it('the sheet mean: exact integer arithmetic in 1/8 units, floor to 1/256', () => {
    // (heights in 1/8 units: [1, 2, 4] / 8 -> mean 7/24 = 0.2916..., floor to 1/256 -> 74/256)
    expect(fixMean(7, 3)).toBe(74 / 256);
    expect(fixMean(-7, 3)).toBe(-75 / 256);
    expect(fixMean(16, 2)).toBe(1);
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(Math.random() * 40);
      const s = Math.floor(Math.random() * 2e6) - 1e6;
      const z = fixMean(s, n);
      expect(Number.isInteger(z * 256)).toBe(true);
      expect(z).toBeLessThanOrEqual(s / n / 8);
      expect(s / n / 8 - z).toBeLessThan(1 / 256);
    }
  });
});
