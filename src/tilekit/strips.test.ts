import { describe, expect, it } from 'vitest';
import { finish, type GridMesh } from './grid';
import { muru } from './fixtures/muru';
import { decompose, lineStats, patch, rings, sideBend, stripCells, stripOutline, traceLine } from './strips';

/** an n × m square grid, unit cells */
function squares(n: number, mm = n): GridMesh {
  const xy: number[] = [];
  for (let j = 0; j <= mm; j++) for (let i = 0; i <= n; i++) xy.push(i, j);
  const cells: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < mm; j++) for (let i = 0; i < n; i++) cells.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return finish(new Float64Array(xy), new Int32Array(cells));
}

describe('strips', () => {
  it('a patch on a square grid is the rectangle of cells, its outline the rectangle', () => {
    const m = squares(5, 4);
    // cell (1, 1) = index 6, bottom edge k = 0
    const s = patch(m, { c: 6, k: 0 }, 3, 2)!;
    expect(s).not.toBeNull();
    expect(stripCells(s).sort((a, b) => a - b)).toEqual([6, 7, 8, 11, 12, 13]);
    expect(stripOutline(m, s).length).toBe(2 * (3 + 2));
    expect(sideBend(m, s)).toBeCloseTo(0);
    // turned frame (bottom edge 1: right is up the grid, up is to the left), from the bottom-right cell
    const t = patch(m, { c: 8, k: 1 }, 2, 3)!;
    expect(stripCells(t).sort((a, b) => a - b)).toEqual([6, 7, 8, 11, 12, 13]);
    // off the grid: none
    expect(patch(m, { c: 6, k: 0 }, 5, 1)).toBeNull();
  });
  it('a patch across a 3-valent vertex is refused', () => {
    // a triangle cut into 3 quads: the centre is 3-valent, no 2 × 2 patch round it
    const A = [0, 0];
    const B = [2, 0];
    const C = [1, Math.sqrt(3)];
    const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const cen = [1, Math.sqrt(3) / 3];
    const m = finish(new Float64Array([A, B, C, mid(A, B), mid(B, C), mid(C, A), cen].flat()), new Int32Array([0, 3, 6, 5, 1, 4, 6, 3, 2, 5, 6, 4]));
    for (let c = 0; c < 3; c++) for (let k = 0; k < 4; k++) expect(patch(m, { c, k }, 2, 2)).toBeNull();
  });
  it('decompose covers every cell exactly once, each strip a patch', () => {
    const m = squares(6, 6);
    const set = new Set<number>();
    // an L: a 6 × 2 range and a 2 × 3 wing
    for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) set.add(j * 6 + i);
    for (let i = 0; i < 2; i++) for (let j = 2; j < 5; j++) set.add(j * 6 + i);
    const ss = decompose(m, set);
    const all = ss.flatMap(stripCells).sort((a, b) => a - b);
    expect(all).toEqual([...set].sort((a, b) => a - b));
    expect(ss[0].a * ss[0].b).toBe(12);
    expect(ss.length).toBe(2);
  });
  it('lines run straight on through 4-valent vertices', () => {
    const m = squares(4, 4);
    const r = rings(m);
    // bottom edge of cell 5 (row 1): from vertex (1,1) to (2,1), on through (3,1), stops at the boundary (4,1)
    const l = traceLine(m, r, 5, 0);
    expect(l.verts.length).toBe(4);
  });
  it('the real grid: decomposing a lot gives patches covering it', () => {
    const m = muru();
    const lots = new Map<number, number[]>();
    for (let c = 0; c < m.nc; c++) if (m.cls![c] === 1) lots.set(m.lot![c], [...(lots.get(m.lot![c]) ?? []), c]);
    const big = [...lots.values()].sort((a, b) => b.length - a.length)[0];
    const ss = decompose(m, big);
    expect(ss.flatMap(stripCells).sort((a, b) => a - b)).toEqual([...big].sort((a, b) => a - b));
    for (const s of ss) expect(patch(m, s.at[0][0], s.a, s.b)).not.toBeNull();
    const sizes = ss.map((s) => `${s.a}x${s.b}`);
    console.log('largest lot', big.length, 'cells →', ss.length, 'strips', sizes.join(' '));
    console.log('grid lines on the real grid', JSON.stringify(lineStats(m)));
  });
});
