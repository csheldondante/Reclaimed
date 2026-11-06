// The road generator's rules on the CPU (round 128p, DA-A13 step 0: src/roadgen/). The GPU's are checked against
// these in test/gpu/roadgen.test.ts.
import { describe, expect, it } from 'vitest';
import { dirAt, fieldOf, latticeSize, ROADGEN_STYLE, type RoadGenInput, type RoadGenParams, type V2 } from '../../src/roadgen/roadgen';
import { RoadGenCpu } from '../../src/roadgen/cpu';
import { blocksOf, claimsCpu, isRoad, LATTICE_CELL, latticeCellAt, latticeN, latticePoint, MAX_OFFSET, offsetsCpu } from '../../src/roadgen/lattice';

function input(o: { W?: number; H?: number; ground?: (x: number, y: number) => number; wet?: (x: number, y: number) => boolean; params?: Partial<RoadGenParams> } = {}): RoadGenInput {
  const W = o.W ?? 160;
  const H = o.H ?? 160;
  const params: RoadGenParams = { ...ROADGEN_STYLE, W, H, centre: [W / 2, H / 2], radius: Math.min(W, H) / 2 - 2, theta: 0, seed: 1, ...o.params };
  // (no radial basis unless asked: a tiny reach)
  if (!o.params?.sigmaR) params.sigmaR = 0.01;
  const { nx, ny } = latticeSize(params);
  const ground = new Float32Array(nx * ny);
  const wet = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      ground[j * nx + i] = o.ground?.(i * params.S, j * params.S) ?? 0;
      wet[j * nx + i] = o.wet?.(i * params.S, j * params.S) ? 1 : 0;
    }
  return { params, ground, wet, constraints: [] };
}

const angleOf = (d: V2) => Math.atan2(d[1], d[0]);
/** the angle between two undirected directions (0..π/2) */
const between = (a: number, b: number) => {
  const d = Math.abs((((a - b) % Math.PI) + Math.PI) % Math.PI);
  return Math.min(d, Math.PI - d);
};

describe('the field', () => {
  it('on flat land follows the grid', () => {
    const inp = input({ params: { theta: 0.3 } });
    const f = fieldOf(inp);
    const d = dirAt(inp.params, f, 0, 50, 70)!;
    expect(between(angleOf(d), 0.3)).toBeLessThan(1e-4);
    expect(between(angleOf(dirAt(inp.params, f, 1, 50, 70)!), 0.3 + Math.PI / 2)).toBeLessThan(1e-4);
  });

  it('on land steeper than a road may climb follows the contours; on gentler land the grid', () => {
    const steep = input({ ground: (x) => 0.5 * x });
    expect(between(angleOf(dirAt(steep.params, fieldOf(steep), 0, 80, 80)!), Math.PI / 2)).toBeLessThan(1e-4);
    const gentle = input({ ground: (x) => 0.2 * x });
    expect(between(angleOf(dirAt(gentle.params, fieldOf(gentle), 0, 80, 80)!), 0)).toBeLessThan(1e-4);
  });

  it('near a constraint follows it', () => {
    const inp = input();
    inp.constraints.push([
      [20, 20],
      [140, 140],
    ]);
    const d = dirAt(inp.params, fieldOf(inp), 0, 80, 82)!;
    expect(between(angleOf(d), Math.PI / 4)).toBeLessThan(0.05);
  });
});

/** the least distance from a point to another road's points */
function gapTo(q: V2, others: V2[][]): number {
  let best = Infinity;
  for (const o of others) for (const p of o) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
  return best;
}

describe('the roads', () => {
  it('on flat land: majors along the grid a spacing apart, minors across them', () => {
    const inp = input();
    const roads = new RoadGenCpu(inp).run();
    const maj = roads.filter((r) => r.family === 0);
    const min = roads.filter((r) => r.family === 1);
    expect(maj.length).toBeGreaterThan(3);
    expect(min.length).toBeGreaterThan(5);
    for (const r of maj) for (const q of r.pts.slice(1, -1)) expect(Math.abs(q[1] - r.pts[1][1])).toBeLessThan(1e-6);
    for (const r of min) for (const q of r.pts.slice(1, -1)) expect(Math.abs(q[0] - r.pts[1][0])).toBeLessThan(1e-6);
    // parallel majors: their y a major spacing apart
    const ys = [...new Set(maj.map((r) => Math.round(r.pts[1][1] * 1000) / 1000))].sort((a, b) => a - b);
    for (let k = 1; k < ys.length; k++) expect(ys[k] - ys[k - 1]).toBeCloseTo(inp.params.major, 3);
  });

  it('a family keeps half its spacing apart (but where a line snaps on at its ends)', () => {
    const inp = input({ ground: (x, y) => 6 * Math.sin(x / 30) + 4 * Math.cos(y / 23) + 0.25 * x, params: { sigmaR: 50, theta: 0.4 } });
    const roads = new RoadGenCpu(inp).run();
    expect(roads.length).toBeGreaterThan(8);
    for (const f of [0, 1]) {
      const fam = roads.filter((r) => r.family === f);
      const d = f === 0 ? inp.params.major : inp.params.minor;
      fam.forEach((r, i) => {
        const others = fam.filter((_, j) => j !== i).map((o) => o.pts.slice(1, -1));
        for (const q of r.pts.slice(1, -1)) expect(gapTo(q, others)).toBeGreaterThanOrEqual(d / 2 - 1e-6);
      });
    }
  });

  it('stays off water and in the town', () => {
    const inp = input({ wet: (x) => x > 70 && x < 90 });
    const roads = new RoadGenCpu(inp).run();
    for (const r of roads)
      for (const q of r.pts) {
        expect(q[0] > 69 && q[0] < 91).toBe(false);
        expect(Math.hypot(q[0] - 80, q[1] - 80)).toBeLessThanOrEqual(inp.params.radius + 1e-6);
      }
  });

  it('an edit: a drawn road is kept, roads round it follow it, roads away from it are untouched', () => {
    const inp = input();
    const gen = new RoadGenCpu(inp);
    const before = gen.run().map((r) => ({ ...r, pts: r.pts.map((q) => [...q] as V2) }));
    const drawn: V2[] = [
      [40, 100],
      [100, 130],
    ];
    const rect: [number, number, number, number] = [10, 70, 130, 160];
    const after = gen.edit([drawn], rect);
    expect(after.some((r) => r.fixed && r.pts[0][0] === 40)).toBe(true);
    const inRect = (q: V2) => q[0] >= rect[0] && q[0] <= rect[2] && q[1] >= rect[1] && q[1] <= rect[3];
    const away = before.filter((r) => !r.pts.some(inRect));
    expect(away.length).toBeGreaterThan(0);
    for (const r of away) expect(after.some((a) => a.pts.length === r.pts.length && a.pts.every((q, k) => q[0] === r.pts[k][0] && q[1] === r.pts[k][1]))).toBe(true);
    // a major road traced near the drawn one runs along it (within 25°)
    const along = after.filter((r) => !r.fixed && r.family === 0 && r.pts.some((q) => Math.hypot(q[0] - 70, q[1] - 115) < 20));
    for (const r of along) {
      const k = r.pts.findIndex((q) => Math.hypot(q[0] - 70, q[1] - 115) < 20);
      const a = r.pts[Math.max(0, k - 2)];
      const b = r.pts[Math.min(r.pts.length - 1, k + 2)];
      expect(between(Math.atan2(b[1] - a[1], b[0] - a[0]), Math.atan2(30, 60))).toBeLessThan((25 * Math.PI) / 180);
    }
  });
});

describe('the base lattice', () => {
  it('finds a point’s cell by a math expression', () => {
    const inp = input({ params: { theta: 0.37 } });
    const p = inp.params;
    const n = latticeN(p);
    for (const [i, j] of [
      [3, 5],
      [20, 7],
      [11, 30],
    ]) {
      const c = latticePoint(p, n, i + 0.5, j + 0.5);
      expect(latticeCellAt(p, n, c[0], c[1])).toEqual([i, j]);
    }
  });

  it('roads claim the cells their lines pass within half a cell of; blocks are what lies between; vertices bend onto the road edges', () => {
    const inp = input({ params: { jitter: 0 } });
    const p = inp.params;
    const roads = new RoadGenCpu(inp).run();
    const n = latticeN(p);
    const claims = claimsCpu(p, roads, n);
    const { count, sizes } = blocksOf(claims, n);
    expect(claims.some(isRoad)).toBe(true);
    expect(count).toBeGreaterThan(4);
    expect(Math.max(...sizes)).toBeLessThan(((p.major / LATTICE_CELL) * p.minor) / LATTICE_CELL * 4);
    const off = offsetsCpu(p, roads, n, claims);
    for (let v = 0; v < off.length / 2; v++) expect(Math.hypot(off[v * 2], off[v * 2 + 1])).toBeLessThanOrEqual(MAX_OFFSET * LATTICE_CELL + 1e-5);
    // on flat land with no jitter, a moved vertex lies on a road's edge: half a cell from the line it moved to (or as
    // near as the bound lets it)
    expect(off.some((x) => x !== 0)).toBe(true);
  });
});
