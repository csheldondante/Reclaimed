import { describe, expect, it } from 'vitest';
import { finish, type GridMesh } from './grid';
import { planRoof, roofGrid, slopeIntoWall, type RoofParams, type SideClass, type StripSides } from './roof';
import { patch } from './strips';

function squares(n: number, mm = n, s = 1): GridMesh {
  const xy: number[] = [];
  for (let j = 0; j <= mm; j++) for (let i = 0; i <= n; i++) xy.push(i * s, j * s);
  const cells: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < mm; j++) for (let i = 0; i < n; i++) cells.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return finish(new Float64Array(xy), new Int32Array(cells));
}

const R: RoofParams = { pitch: 0.6, towerPitch: 1.2, overhang: 0.4, thickness: 0.15, hip: true, clearance: 0.35 };

/** a 4 × 2 strip of 2.7 m cells with the given class on each side (bottom, right, top, left) */
function strip(cls: SideClass[]) {
  const m = squares(4, 2, 2.7);
  const s = patch(m, { c: 0, k: 0 }, 4, 2)!;
  const n = [4, 2, 4, 2];
  const sides: StripSides = {
    cls: cls.map((c, i) => Array(n[i]).fill(c)),
    off: cls.map((c, i) => Array(n[i]).fill(c === 'eave' ? 0.35 : c === 'abut' ? -0.35 : 0)),
    headroom: cls.map((c) => (c === 'abut' ? 3 : Infinity)),
    extend: [0, 0, 0, 0],
  };
  return { m, s, sides };
}

describe('strip roofs: a slope never runs into a wall', () => {
  it('free all round: a hip along the long direction, its ridge on the middle line', () => {
    const { m, s, sides } = strip(['eave', 'eave', 'eave', 'eave']);
    const p = planRoof(m, s, sides, R, false);
    expect(p.kind).toBe('hip');
    expect(p.alongA).toBe(true);
    const g = roofGrid(m, s, sides, p, R);
    // the ridge row (j = J/2) holds the highest points
    const mid = g.J / 2;
    const top = Math.max(...g.h);
    expect(Math.max(...g.h.slice(mid * (g.I + 1), (mid + 1) * (g.I + 1)))).toBeCloseTo(top, 9);
  });
  it('a long side against a taller wall: a lean-to rising to it, under the taller eave', () => {
    const { m, s, sides } = strip(['eave', 'eave', 'abut', 'eave']);
    const p = planRoof(m, s, sides, R, false);
    expect(p.kind).toBe('shed');
    expect(p.high).toBe(2);
    const g = roofGrid(m, s, sides, p, R);
    expect(slopeIntoWall(g, sides)).toBeLessThanOrEqual(0);
    expect(Math.max(...g.h)).toBeLessThanOrEqual(3 - R.clearance + 1e-9);
  });
  it('an end against a taller wall: a gable end there (no hip), level going in', () => {
    const { m, s, sides } = strip(['eave', 'abut', 'eave', 'eave']);
    const p = planRoof(m, s, sides, R, false);
    expect(p.hips[1]).toBe(false);
    expect(p.hips[3]).toBe(true);
    expect(slopeIntoWall(roofGrid(m, s, sides, p, R), sides)).toBeCloseTo(0, 9);
  });
  it('both long sides against taller walls: a flat terrace on a long strip, the ridge turned on a squarish one', () => {
    const { m, s, sides } = strip(['abut', 'eave', 'abut', 'eave']);
    const p = planRoof(m, s, sides, R, false);
    expect(p.kind).toBe('flat');
    expect(slopeIntoWall(roofGrid(m, s, sides, p, R), sides)).toBeLessThanOrEqual(1e-9);
    // a 2 × 2 (squarish) strip between two taller walls: a gable whose ridge runs from one wall to the other
    const m2 = squares(2, 2, 2.7);
    const s2 = patch(m2, { c: 0, k: 0 }, 2, 2)!;
    const sides2: StripSides = { cls: [['abut', 'abut'], ['eave', 'eave'], ['abut', 'abut'], ['eave', 'eave']], off: [[-0.35, -0.35], [0.35, 0.35], [-0.35, -0.35], [0.35, 0.35]], headroom: [3, Infinity, 3, Infinity], extend: [0, 0, 0, 0] };
    const p2 = planRoof(m2, s2, sides2, R, false);
    expect(p2.kind).toBe('gable');
    expect(p2.alongA).toBe(false);
    expect(slopeIntoWall(roofGrid(m2, s2, sides2, p2, R), sides2)).toBeLessThanOrEqual(1e-9);
  });
  it('the check catches a gable whose slope runs down into a taller wall', () => {
    const { m, s, sides } = strip(['eave', 'eave', 'abut', 'eave']);
    const wrong = { kind: 'gable' as const, alongA: true, high: -1, hips: [false, false, false, false], pitch: R.pitch };
    expect(slopeIntoWall(roofGrid(m, s, sides, wrong, R), sides)).toBeGreaterThan(0.3);
  });
});
