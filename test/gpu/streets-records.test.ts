// (loop-streets, LS-102 option a) A town's road records and its raster, made by citygen on the GPU (streets.wgsl
// gradeSq, gradeRecs, gradeRast) over a synthetic raw ground — the town's half of docs/design/CITYGEN.md "Streets as
// terrain", checked without the game:
//   - record 0 the square: a disc at the plaza's z, at least plazaR wide; the arterials' records start at the centre,
//     their profile the atlas heights pinned to the square within the atlas's grade, cut where a river crosses;
//   - the raster's GRADED columns are exactly those a record holds (the lay's own test, read back on the CPU);
//   - ownership: the claim grid has no road paving on a graded column (claimRoads leaves them to the grader).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { townLayout, type FieldTownSite } from '../../src/citygen/town';
import { GRADE_RECS } from '../../src/citygen/gpu';
import { unpackRoads, type RoadRecord } from '../../src/api/contracts/roadpath';
import { ROW_H, cellPos } from '../../src/world/lattice';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

/** the raw ground at world (x, y): a plane rising east, a river (1 deep) running north–south at world x 330–336 */
const top = (x: number, y: number) => 20 + 0.04 * x + 0.01 * y;
const wet = (x: number) => x >= 330 && x < 336;

const GRADED_BIT = 0x20000000;
const DECK_BIT = 0x80000000;
const WALL_MARK = 0x40000000;

/** the first record whose half width holds frame point p, its profile there (roadpath.wgsl roadHit's rule) */
function onRoad(recs: RoadRecord[], p: [number, number]): number | null {
  for (const r of recs) {
    if (r.points.length < 2) continue;
    let best = Infinity;
    let z = 0;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-12)));
      const d = Math.hypot(p[0] - a.x - dx * t, p[1] - a.y - dy * t);
      if (d <= a.hw + (b.hw - a.hw) * t && d < best) {
        best = d;
        z = a.z + (b.z - a.z) * t;
      }
    }
    if (best < Infinity) return z;
  }
  return null;
}

describe('a town\'s streets as road records (loop-streets)', () => {
  it('the square and the arterials as records; the raster marks exactly their columns; no paving claimed there', async () => {
    const dev = g.device;
    const at: [number, number] = [200, 200];
    // (three roads out of the centre, a point every 2 units, their atlas z the ground's smoothed — here the plane's)
    const dirs: [number, number][] = [[1, 0], [-0.6, 0.8], [-0.3, -0.95]];
    const roads = dirs.map(([dx, dy]) => Array.from({ length: 120 }, (_, i): [number, number] => [at[0] + dx * 2 * i, at[1] + dy * 2 * i]));
    const plaza = top(at[0], at[1]);
    const heights = { z: roads.map((l) => l.map(([x, y]) => top(x, y) + 0.3)), plaza };
    const site: FieldTownSite = { id: 'test', name: 'Test', at, size: 'town', roads, heights, seed: 7 };
    const L = townLayout(dev, site, { cols: 4096, rows: 4096 }, 0, { built: 'all' });
    expect(L.params.terrainRoads).toBe(1);
    // (the raw ground over the box: 64 × 64 tiles, row-major, 4 words a column — top, water, material, plants)
    const { w, h, x0, y0 } = L.box;
    const raw = new ArrayBuffer(w * h * 16);
    const f = new Float32Array(raw);
    const tilesX = w / 64;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [wx, wy] = cellPos(x0 + x, y0 + y);
        const k = Math.floor(y / 64) * tilesX + Math.floor(x / 64);
        const o = (k * 64 * 64 + (y % 64) * 64 + (x % 64)) * 4;
        f[o] = top(wx, wy);
        f[o + 1] = wet(wx) ? 1 : 0;
      }
    dev.queue.writeBuffer(L.raw, 0, raw);
    const t = await L.gen.run(L.params, 'field');
    expect(g.takeErrors()).toEqual([]);
    expect(t.lots).toBeGreaterThan(50);
    // (the records: the roadpath layout)
    const recs = unpackRoads(await g.read(L.gen.gradeRoads, L.gen.gradeRoads.size));
    expect(recs.length).toBe(GRADE_RECS);
    const sq = recs[0];
    expect(sq.points.length).toBe(2);
    expect(sq.points[0].hw).toBeGreaterThanOrEqual(L.params.plazaR);
    expect(sq.points[0].z).toBeCloseTo(plaza, 4);
    expect(sq.graded && sq.paved && sq.dry).toBe(true);
    const art = (k: number) => recs.slice(1 + k * 16, 1 + (k + 1) * 16).filter((r) => r.points.length >= 2);
    for (let k = 0; k < 3; k++) {
      const rs = art(k);
      expect(rs.length, `arterial ${k}`).toBeGreaterThan(0);
      // (it starts at the centre, at the square's z)
      expect(Math.hypot(rs[0].points[0].x - L.centre[0], rs[0].points[0].y - L.centre[1]), `arterial ${k} start`).toBeLessThan(0.01);
      expect(rs[0].points[0].z).toBeCloseTo(plaza, 3);
      // (each point within the grade of the square: the pin, 0.22 a unit past its radius)
      for (const r of rs)
        for (const p of r.points) {
          const s = Math.hypot(p.x - L.centre[0], p.y - L.centre[1]);
          expect(Math.abs(p.z - plaza), `arterial ${k} at ${s.toFixed(1)}`).toBeLessThanOrEqual(0.22 * Math.max(s - sq.points[0].hw, 0) + 1e-3);
        }
    }
    // (the east arterial crosses the river at world x 330–336: no record point on the water — the frame's x is the
    // world's less the box's first column)
    const ox = L.local([0, 0])[0];
    for (const r of art(0)) for (const p of r.points.slice(1, -1)) expect(wet(p.x - ox), `a point in the river at ${p.x - ox}`).toBe(false);
    expect(art(0).some((r) => r.points.some((p) => p.x - ox > 340)), 'the east arterial goes on past the river').toBe(true);
    // (held over the river beside it: a point within its half width and shoulder of the water stands 0.4 over the
    // water's surface — the river's top is the ground + 1 there)
    let byRiver = 0;
    for (const r of art(0))
      for (const p of r.points) {
        const wx = p.x - ox;
        const d = Math.max(330 - wx, wx - 336, 0);
        if (d > p.hw + 4 - 1) continue;
        byRiver++;
        expect(p.z, `a point by the river at ${wx.toFixed(1)}`).toBeGreaterThanOrEqual(top(Math.min(Math.max(wx, 330), 335.5), p.y - L.local([0, 0])[1]) + 1 + 0.4 - 0.2);
      }
    expect(byRiver).toBeGreaterThan(0);
    // (the raster: GRADED exactly where a record holds the column)
    const roadsRaster = new Uint32Array(await g.read(L.gen.B.ROADS, w * h * 4));
    const claims = new Uint32Array(await g.read(L.gen.claimGrid as GPUBuffer, w * h * 8 * 4));
    const N = w * h;
    let graded = 0;
    let mismatch = 0;
    let paved = 0;
    let lotOnGraded = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const m = roadsRaster[i];
        const z = onRoad(recs, cellPos(x, y));
        const isG = (m & (DECK_BIT | WALL_MARK | GRADED_BIT)) === GRADED_BIT;
        if ((m & (DECK_BIT | WALL_MARK)) !== 0) continue;
        if (isG !== (z !== null)) mismatch++;
        if (!isG) continue;
        graded++;
        expect(Math.abs((m & 0x1fffffff) / 256 - z!), `raster z at ${x},${y}`).toBeLessThan(1 / 128);
        // (the claim grid: nothing of the roads' (key 0) on it; a lot's claim counted)
        if (claims[i * 4 + 3] !== 0) {
          if (claims[N * 4 + i * 4 + 3] === 0) paved++;
          else lotOnGraded++;
        }
      }
    console.log(`[streets-records] graded columns ${graded}, raster/record mismatches ${mismatch}, road paving on graded ${paved}, lot claims on graded ${lotOnGraded}; square radius ${sq.points[0].hw.toFixed(1)}; arterial records ${[0, 1, 2].map((k) => art(k).length).join('/')}; ${(ROW_H * h).toFixed(0)} rows deep`);
    expect(graded).toBeGreaterThan(1000);
    expect(mismatch).toBe(0);
    expect(paved).toBe(0);
    expect(g.takeErrors()).toEqual([]);
    L.gen.dispose();
    L.raw.destroy();
  }, 180_000);
});
