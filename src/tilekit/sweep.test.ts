import { describe, expect, it } from 'vitest';
import { finish, walls, type GridMesh } from './grid';
import { A } from './kit';
import { packInstance, sweepPoint, IF } from './sweep';

/** a skewed quad grid (an irregular-ish one: every vertex jittered) */
function skewed(n: number): GridMesh {
  const xy: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) xy.push(i * 2.7 + Math.sin(i * 3.1 + j * 1.7) * 0.5, j * 2.7 + Math.cos(i * 1.3 + j * 2.9) * 0.5);
  const cells: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cells.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return finish(new Float64Array(xy), new Int32Array(cells));
}

describe('panel sweep (TILEKIT.md §5)', () => {
  const m = skewed(5);
  const tops = new Uint8Array(m.nc);
  // an L of cells: convex and concave joints at odd angles
  for (const c of [6, 7, 8, 13, 18]) tops[c] = 1;
  const w = walls(m, tops);
  const inst: number[] = [];
  for (const p of w.panels) packInstance(inst, m, p, 0, false, [1, 1, 1], 0);

  it('neighbouring panels meet exactly at every depth (the mitre closes any angle)', () => {
    w.panels.forEach((p, i) => {
      for (const wd of [-0.25, 0, 0.1, 0.3]) {
        for (const z of [0, 1.5]) {
          const a = sweepPoint(inst, i * IF, 0, A.end, wd, z);
          const b = sweepPoint(inst, p.next * IF, 0, A.start, wd, z);
          for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], 9);
        }
      }
    });
  });
  it('relief depth is metric: a point at depth w lies w from the edge line', () => {
    w.panels.forEach((p, i) => {
      for (const wd of [-0.26, 0.05, 0.3]) {
        const q = sweepPoint(inst, i * IF, 0.3, A.mid, wd, 0);
        const ax = m.xy[p.a * 2];
        const ay = m.xy[p.a * 2 + 1];
        const d = (q[0] - ax) * p.nx + (q[1] - ay) * p.ny;
        expect(d).toBeCloseTo(wd, 9);
      }
    });
  });
  it('a mid-anchored width is kept along the edge whatever the length', () => {
    const p = w.panels[0];
    const a = sweepPoint(inst, 0, -0.41, A.mid, 0, 0);
    const b = sweepPoint(inst, 0, 0.41, A.mid, 0, 0);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(0.82, 9);
    expect(p.len).toBeGreaterThan(1);
  });
  it('a mirrored instance puts an end-anchored point at the start', () => {
    const mir: number[] = [];
    packInstance(mir, m, w.panels[0], 0, true, [1, 1, 1], 0);
    const a = sweepPoint(mir, 0, 0, A.end, 0, 0);
    expect(a[0]).toBeCloseTo(m.xy[w.panels[0].a * 2], 9);
    expect(a[1]).toBeCloseTo(m.xy[w.panels[0].a * 2 + 1], 9);
  });
});
