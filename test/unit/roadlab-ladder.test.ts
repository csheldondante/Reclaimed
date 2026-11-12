// (road lab, RD1) The road path records' layout round-trips, and the grade ladder is what it says: each graded road's
// steepest segment is its row's grade, every road starts and ends on the ground, and every structure's road leaves the
// ground only where a structure stands.
import { describe, expect, it } from 'vitest';
import { packRoads, unpackRoads, ROAD_REC_BASE, ROAD_REC_VEC4, roadColumnBox } from '../../src/api/contracts/roadpath';
import { boxMesh, buildLadder, GRADES, landZ, MAX_DZ } from '../../src/roadlab/ladder';

describe('road path records (api/contracts/roadpath.ts)', () => {
  const { roads } = buildLadder();
  const recs = roads.map((r) => r.record);
  it('pack → unpack is the same roads (f32)', () => {
    const buf = packRoads(recs);
    const u = new Uint32Array(buf);
    expect(u[0]).toBe(recs.length);
    expect(u[2]).toBe(ROAD_REC_BASE);
    expect(u[3]).toBe(ROAD_REC_BASE + ROAD_REC_VEC4 * recs.length);
    expect(buf.byteLength).toBe((u[3] + u[1]) * 16);
    const back = unpackRoads(buf);
    expect(back.length).toBe(recs.length);
    back.forEach((b, i) => {
      expect(b.graded).toBe(recs[i].graded);
      expect(b.surface).toBe(recs[i].surface);
      expect(b.points.length).toBe(recs[i].points.length);
      b.points.forEach((p, k) => expect(p.z).toBeCloseTo(recs[i].points[k].z, 5));
    });
  });
  it('a road box lies in the window', () => {
    for (const r of recs) {
      const [x0, y0, x1, y1] = roadColumnBox(r, 256, 256);
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y1).toBeLessThanOrEqual(256);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
    }
  });
});

describe('the grade ladder (roadlab/ladder.ts)', () => {
  const lad = buildLadder();
  it('graded roads climb at their row\'s grade', () => {
    for (const r of lad.roads.filter((x) => x.variant === 'graded' || x.variant === 'switchback')) {
      const k = GRADES[r.row].k;
      let steep = 0;
      const p = r.record.points;
      for (let i = 1; i < p.length; i++) {
        const run = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
        if (run > 1e-6) steep = Math.max(steep, Math.abs(p[i].z - p[i - 1].z) / run);
      }
      expect(steep).toBeCloseTo(1 / k, 5);
    }
  });
  it('every road starts and ends on the ground (within the relief)', () => {
    for (const r of lad.roads) {
      const p = r.record.points;
      for (const q of [p[0], p[p.length - 1]]) expect(Math.abs(q.z - landZ(q.x, q.y))).toBeLessThanOrEqual(MAX_DZ);
    }
  });
  it('the roads fit the address space and a structure each where one is needed', () => {
    expect(lad.roads.length).toBeLessThanOrEqual(255);
    expect(lad.boxes.length).toBeGreaterThan(0);
    expect(boxMesh(lad.boxes).length).toBe(lad.boxes.length * 36 * 8);
    // (a structure road's profile leaves the ground somewhere: else it wouldn't need the structure)
    for (const r of lad.roads.filter((x) => x.variant === 'ramp' || x.variant === 'stairs' || x.variant === 'tower')) {
      const p = r.record.points;
      let off = 0;
      for (let i = 1; i < p.length; i++)
        for (let t = 0; t <= 1; t += 0.05) {
          const x = p[i - 1].x + (p[i].x - p[i - 1].x) * t;
          const y = p[i - 1].y + (p[i].y - p[i - 1].y) * t;
          off = Math.max(off, p[i - 1].z + (p[i].z - p[i - 1].z) * t - landZ(x, y));
        }
      expect(off).toBeGreaterThan(MAX_DZ);
    }
  });
});
