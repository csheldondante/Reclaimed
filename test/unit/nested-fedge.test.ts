// Nested scales lab, round 29 (docs/design/NESTED_SCALES.md "Round 29 plan"): does the field reading the stored edge
// line (fieldsel.ts fedge) make a carved rim follow the brush's true outline instead of the grid? A reference surface-nets
// mesh (the vertex as field.wgsl fCell: the mean of the cell's edge crossings; a quad round every crossed sample edge),
// cut by a horizontal plane just under the rim; the cut's horizontal distance to the true outline at that height, max and
// RMS, in columns, with fedge off and on. Scenes: a ball carved in flat ground (radius 5.3 and 20.7 columns), a trench
// (a stroke) at 27 degrees, two overlapping bowls. Also: with no edge sample anywhere the field is bit-identical.
import { describe, expect, it } from 'vitest';
import { crossed, fieldAt, runsOf, solidInside, candidates, type FieldLevel, type FieldSpec, type PCol, type Runs } from '../../src/nested/fieldsel';
import { EDGE_PAD, MAT, OPEN_BOTTOM, applyBall, ballEdge, ballSample, toPart, type Col } from '../../src/nested/oracle';
import { edgeEnc } from '../../src/nested/edge';
import { cutAt, fmt, meshOf, stats } from '../support/nested-fieldref';

/** the flat ground: stone under 0.25 of soil, its top at H (a fraction off the cell lattice) */
const H = 10.1;
const flat = (): Col => ({ mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, H - 0.25], z1: [H - 0.25, H], edge: [0, 0] });

/** a level of n x n columns from Cols */
function levelOf(cols: Col[], n: number): FieldLevel {
  const cache = new Map<number, Runs>();
  return {
    gx: 0,
    gy: 0,
    n,
    runs(X, Y) {
      const key = Y * n + X;
      let r = cache.get(key);
      if (!r) {
        const p = toPart(cols[key]);
        const pc: PCol = { top: p.top, mat: p.mat, edge: p.edge };
        cache.set(key, (r = runsOf(pc, solidInside)));
      }
      return r;
    },
  };
}
/** balls carved one after another, as the oracle's edit (Nest.edit's ball branch: the ball, then its edge sample at the
 *  column's top before it; box grown by EDGE_PAD) */
function carveBalls(n: number, balls: [number, number, number, number][]): Col[] {
  const cols = Array.from({ length: n * n }, flat);
  for (const [cx, cy, cz, r] of balls)
    for (let y = Math.max(0, Math.floor(cy - r) - EDGE_PAD); y < Math.min(n, Math.ceil(cy + r) + 1 + EDGE_PAD); y++)
      for (let x = Math.max(0, Math.floor(cx - r) - EDGE_PAD); x < Math.min(n, Math.ceil(cx + r) + 1 + EDGE_PAD); x++) {
        const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const c0 = cols[y * n + x];
        const h = Math.sqrt(Math.max(0, r * r - dd * dd));
        const c = dd < r ? applyBall(c0, 'carve', cz - h, cz + h) : c0;
        cols[y * n + x] = ballEdge(c, ballSample(x + 0.5 - cx, y + 0.5 - cy, c0.z1[c0.z1.length - 1] - cz, r));
      }
  return cols;
}
/** a stroke (a capsule from a to b, centre height cz, radius r) carved at once, its edge sample the capsule's line at the
 *  column's top (nest.wgsl ballEdgeAt over the stroke's balls: the largest R - rho, i.e. the nearest point of the axis) */
function carveStroke(n: number, a: [number, number], b: [number, number], cz: number, r: number): Col[] {
  const cols = Array.from({ length: n * n }, flat);
  const ab = [b[0] - a[0], b[1] - a[1]];
  const L2 = ab[0] * ab[0] + ab[1] * ab[1];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = Math.max(0, Math.min(1, ((px - a[0]) * ab[0] + (py - a[1]) * ab[1]) / L2));
      const qx = a[0] + t * ab[0];
      const qy = a[1] + t * ab[1];
      const rho = Math.hypot(px - qx, py - qy);
      if (rho > r + EDGE_PAD) continue;
      const c0 = cols[y * n + x];
      const h = Math.sqrt(Math.max(0, r * r - rho * rho));
      const c = rho < r ? applyBall(c0, 'carve', cz - h, cz + h) : c0;
      const dz = c0.z1[c0.z1.length - 1] - cz;
      const R = Math.sqrt(r * r - dz * dz);
      const e = rho > 0 ? edgeEnc((px - qx) / rho, (py - qy) / rho, R - rho) : edgeEnc(1, 0, R);
      cols[y * n + x] = ballEdge(c, e);
    }
  return cols;
}


/** the cut's depth under the ground (a fraction of a column: under the rim's rounded corner) */
const DEPTH = 0.75;
const ZC = H - DEPTH;
/** the mesh of a scene over the whole window, and the brute check that the selection holds every crossed cell */
function run(cols: Col[], n: number, warp: number, fedge: boolean, region: [number, number, number, number]) {
  const s: FieldSpec = { own: levelOf(cols, n), warp, fade: 4, fedge };
  const [x0, y0, x1, y1] = region;
  const m = meshOf(s, x0, y0, x1, y1, Math.floor(H) - 8, Math.floor(H) + 2);
  // (the selection: every crossed cell in the region selected)
  let missing = 0;
  let sel = 0;
  let cr = 0;
  for (let Y = y0; Y < y1; Y++)
    for (let X = x0; X < x1; X++) {
      const c = candidates(s, X, Y, 0);
      for (const [a, b] of c) sel += b - a + 1;
      for (let K = Math.floor(H) - 25; K <= Math.floor(H) + 4; K++)
        if (crossed(s, X, Y, K)) {
          cr++;
          if (!c.some(([a, b]) => K >= a && K <= b)) missing++;
        }
    }
  return { m, missing, sel, cr, cols: (x1 - x0) * (y1 - y0) };
}

describe('nested field mesh reading the edge line (round 29)', () => {
  it('no edge sample anywhere: fedge 1 is bit-identical to fedge 0', () => {
    const n = 24;
    const cols = carveBalls(n, [[11.3, 12.7, H, 5.3]]).map((c) => ({ ...c, edge: c.mat.map(() => 0) }));
    for (const warp of [0, 0.45]) {
      const a: FieldSpec = { own: levelOf(cols, n), warp, fade: 4 };
      const b: FieldSpec = { ...a, fedge: true };
      for (let i = 0; i < 4000; i++) {
        const x = 2 + ((i * 0.6180339) % 1) * 20;
        const y = 2 + ((i * 0.4142135) % 1) * 20;
        const z = H - 7 + ((i * 0.7320508) % 1) * 9;
        expect(fieldAt(b, x, y, z)).toBe(fieldAt(a, x, y, z));
      }
    }
  });

  for (const r of [5.3, 20.7])
    it(`a ball of radius ${r} carved in flat ground: the rim against the true circle`, () => {
      const n = r < 10 ? 24 : 56;
      const cx = n / 2 + 0.37;
      const cy = n / 2 - 0.19;
      const cols = carveBalls(n, [[cx, cy, H, r]]);
      for (const warp of [0, 0.45])
        for (const fedge of [false, true]) {
          const o = run(cols, n, warp, fedge, [1, 1, n - 3, n - 3]);
          // (also a deeper cut, 1.75 under the top: below the rim's corner cell)
          for (const depth of [DEPTH, 1.75]) {
            const R = Math.sqrt(r * r - depth * depth);
            const pts = cutAt(o.m.quads, H - depth);
            const st = stats(pts.map(([x, y]) => Math.hypot(x - cx, y - cy) - R));
            // (and against the stored line itself: the circle of radius r where the ball cut the top)
            const sl = stats(pts.map(([x, y]) => Math.hypot(x - cx, y - cy) - r));
            console.log(`[fedge] ball r ${r}, warp ${warp}, fedge ${fedge ? 1 : 0}: rim at ${depth} under the top: ${fmt(st)}; against the stored rim circle: max ${sl.max.toFixed(3)}, RMS ${sl.rms.toFixed(3)}; holes ${o.m.holes}; cells selected ${(o.sel / o.cols).toFixed(2)} a column, crossed ${(o.cr / o.cols).toFixed(2)}, missing ${o.missing}`);
            expect(st.n).toBeGreaterThan(20);
          }
          expect(o.missing).toBe(0);
          expect(o.m.holes).toBe(0);
          if (warp === 0) {
            // (measurement: the same field, each crossing bisected along its cell edge)
            const mx = meshOf({ own: levelOf(cols, n), warp, fade: 4, fedge }, 1, 1, n - 3, n - 3, Math.floor(H) - 8, Math.floor(H) + 2, true);
            const R = Math.sqrt(r * r - DEPTH * DEPTH);
            const pts = cutAt(mx.quads, H - DEPTH);
            const st = stats(pts.map(([x, y]) => Math.hypot(x - cx, y - cy) - R));
            const sl = stats(pts.map(([x, y]) => Math.hypot(x - cx, y - cy) - r));
            console.log(`[fedge] ball r ${r}, fedge ${fedge ? 1 : 0}, crossings bisected (measurement): rim at ${DEPTH} under the top: ${fmt(st)}; against the stored rim circle: max ${sl.max.toFixed(3)}, RMS ${sl.rms.toFixed(3)}`);
          }
        }
    });

  it('a trench (a stroke) at 27 degrees to the grid: its walls against the true lines', () => {
    const n = 64;
    const ang = (27 * Math.PI) / 180;
    const c: [number, number] = [32.21, 31.63];
    const half = 24;
    const a: [number, number] = [c[0] - half * Math.cos(ang), c[1] - half * Math.sin(ang)];
    const b: [number, number] = [c[0] + half * Math.cos(ang), c[1] + half * Math.sin(ang)];
    const r = 4;
    const cols = carveStroke(n, a, b, H, r);
    const R = Math.sqrt(r * r - DEPTH * DEPTH);
    for (const warp of [0, 0.45])
      for (const fedge of [false, true]) {
        const o = run(cols, n, warp, fedge, [4, 12, 60, 52]);
        const dev: number[] = [];
        for (const [x, y] of cutAt(o.m.quads, ZC)) {
          const along = (x - c[0]) * Math.cos(ang) + (y - c[1]) * Math.sin(ang);
          if (Math.abs(along) > half - r - 2) continue;
          const across = -(x - c[0]) * Math.sin(ang) + (y - c[1]) * Math.cos(ang);
          dev.push(Math.abs(across) - R);
        }
        const st = stats(dev);
        console.log(`[fedge] trench at 27 deg, r ${r}, warp ${warp}, fedge ${fedge ? 1 : 0}: walls at ${DEPTH} under the top: ${fmt(st)}; holes ${o.m.holes}; cells selected ${(o.sel / o.cols).toFixed(2)} a column, missing ${o.missing}`);
        expect(o.missing).toBe(0);
        expect(o.m.holes).toBe(0);
        expect(st.n).toBeGreaterThan(20);
      }
  });

  it('two overlapping bowls: the crossing described (one line a record cannot hold both rims)', () => {
    const n = 32;
    const r = 5.3;
    const A: [number, number] = [13.4, 15.8];
    const B: [number, number] = [19.9, 17.1];
    const cols = carveBalls(n, [[A[0], A[1], H, r], [B[0], B[1], H, r]]);
    const R = Math.sqrt(r * r - DEPTH * DEPTH);
    // (the true outline at the cut: the union of the two circles' discs; a point's deviation is its distance to that
    // outline, signed outward; near the two crossing points it is reported apart)
    const X1 = (() => {
      // the circles' crossing points
      const dx = B[0] - A[0];
      const dy = B[1] - A[1];
      const d = Math.hypot(dx, dy);
      const a = d / 2;
      const h = Math.sqrt(R * R - a * a);
      const mx = A[0] + (dx * a) / d;
      const my = A[1] + (dy * a) / d;
      return [[mx - (dy * h) / d, my + (dx * h) / d], [mx + (dy * h) / d, my - (dx * h) / d]];
    })();
    for (const fedge of [false, true]) {
      const o = run(cols, n, 0, fedge, [1, 1, n - 3, n - 3]);
      const near: number[] = [];
      const far: number[] = [];
      for (const [x, y] of cutAt(o.m.quads, ZC)) {
        const da = Math.hypot(x - A[0], y - A[1]) - R;
        const db = Math.hypot(x - B[0], y - B[1]) - R;
        const dv = Math.min(da, db);
        const dx = Math.min(...X1.map(([px, py]) => Math.hypot(x - px, y - py)));
        (dx < 2 ? near : far).push(dv);
      }
      console.log(`[fedge] two bowls r ${r}, centres ${Math.hypot(B[0] - A[0], B[1] - A[1]).toFixed(2)} apart, fedge ${fedge ? 1 : 0}: within 2 columns of the crossings ${fmt(stats(near))}; elsewhere ${fmt(stats(far))}; holes ${o.m.holes}; missing ${o.missing}`);
      expect(o.missing).toBe(0);
    }
  });
});
