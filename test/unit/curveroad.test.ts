// Main roads as curves the grid adapts to; the radial relax (round 128p, DA-A13 step 2: build/curveroad.ts).
import { describe, expect, it } from 'vitest';
import { adaptToCurve, chaikin, growRoad, MAX_SNAP, radialRelax } from '../../src/build/curveroad';
import { ROAD_GRADE } from '../../src/build/grade';

type V2 = [number, number];
const flat = { ground: () => 0, wet: () => false, W: 200, H: 200 };

function squares(n: number, S = 4) {
  const verts: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i * S, j * S);
  const quads: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) quads.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return { count: n * n, verts, quads };
}
const area = (v: ArrayLike<number>, q: ArrayLike<number>, c: number) => {
  let a = 0;
  for (let k = 0; k < 4; k++) {
    const i = q[c * 4 + k];
    const j = q[c * 4 + ((k + 1) & 3)];
    a += v[i * 2] * v[j * 2 + 1] - v[j * 2] * v[i * 2 + 1];
  }
  return a / 2;
};

describe('growRoad', () => {
  it('on flat land runs straight: no turn the land does not ask for', () => {
    const p = growRoad(flat, [[20, 20]], [160, 100])!;
    for (const q of p) {
      // distance from the straight line
      const d = Math.abs((160 - 20) * (q[1] - 20) - (100 - 20) * (q[0] - 20)) / Math.hypot(140, 80);
      expect(d).toBeLessThan(1.5);
    }
  });

  it('up a slope steeper than a road may climb it winds (switchbacks): its mean grade near a road grade, far under the slope', () => {
    const io = { ...flat, ground: (_x: number, y: number) => 0.6 * y };
    const p = growRoad(io, [[100, 10]], [100, 120])!;
    let len = 0;
    for (let k = 1; k < p.length; k++) len += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    // 66 m of rise: at 1 in 3 that's 198 m of road; the straight climb is 110 m at 0.6
    expect(66 / len).toBeLessThan(ROAD_GRADE * 1.25);
  });

  it('goes round a building rather than through it when it can', () => {
    const io = {
      ...flat,
      occupied: (x: number, y: number) => x > 80 && x < 120 && y > 60 && y < 140,
    };
    const p = growRoad(io, [[20, 100]], [180, 100])!;
    // (its corners rounded: within a metre or two of the building's)
    expect(p.some((q) => q[0] > 82 && q[0] < 118 && q[1] > 62 && q[1] < 138)).toBe(false);
  });

  it('chaikin keeps the ends', () => {
    const c = chaikin(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      2,
    );
    expect(c[0]).toEqual([0, 0]);
    expect(c[c.length - 1]).toEqual([10, 10]);
  });
});

describe('adaptToCurve', () => {
  it('snaps vertices near the road onto its edges, makes the cells on it road cells, turns no cell over', () => {
    const m = squares(20);
    const curve: V2[] = [
      [0, 41],
      [80, 41],
    ];
    const { verts, road } = adaptToCurve(m, curve, 4);
    // the row of vertices at y 40 is inside (|d| 1 < half/2? no: 1 >= 1) → snapped to 39 or 43; rows 36/44 snap to 39/43
    const ys = new Set<number>();
    for (let i = 0; i < verts.length / 2; i++)
      if (Math.abs(verts[i * 2 + 1] - 41) <= 2.01) ys.add(Math.round(verts[i * 2 + 1] * 100) / 100);
    for (const y of ys) expect([39, 43]).toContain(y);
    expect(road.length).toBeGreaterThan(10);
    for (let c = 0; c < m.count; c++) expect(area(verts, m.quads, c)).toBeGreaterThan(0);
    for (let i = 0; i < verts.length; i++)
      expect(Math.abs(verts[i] - m.verts[i])).toBeLessThanOrEqual(MAX_SNAP * 4 + 1e-5);
  });
});

describe('radialRelax', () => {
  it('turns cells toward facing the middle (on a jittered grid) and turns none over', () => {
    const m = squares(20);
    let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647), s / 2147483647 - 0.5);
    for (let i = 0; i < m.verts.length; i++) m.verts[i] += r() * 1.2;
    const misfit = (v: ArrayLike<number>) => {
      let t = 0;
      for (let c = 0; c < m.count; c++) {
        const i = m.quads[c * 4];
        const j = m.quads[c * 4 + 1];
        const cx = (v[i * 2] + v[j * 2]) / 2 - 40;
        const cy = (v[i * 2 + 1] + v[j * 2 + 1]) / 2 - 40;
        if (Math.hypot(cx, cy) > 30) continue;
        const ang = Math.atan2(v[j * 2 + 1] - v[i * 2 + 1], v[j * 2] - v[i * 2]) - Math.atan2(cy, cx);
        const d = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
        t += Math.min(d, Math.PI / 2 - d);
      }
      return t;
    };
    const v = radialRelax(m, [40, 40], 40, 0.5, 20);
    for (let c = 0; c < m.count; c++) expect(area(v, m.quads, c)).toBeGreaterThan(0);
    expect(misfit(v)).toBeLessThan(misfit(m.verts) * 0.85);
  });
});

void ROAD_GRADE;
