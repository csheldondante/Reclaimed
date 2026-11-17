import { describe, expect, it } from 'vitest';
import { finish, walls, type GridMesh } from './grid';
import { bays, chamfer, interiorAt, loopsOf, offsetCorner, offsetLoop, straighten, type LoopPt, type V2 } from './facade';
import { muru } from './fixtures/muru';

/** an n × m square grid, unit cells scaled by s */
function squares(n: number, mm = n, s = 1): GridMesh {
  const xy: number[] = [];
  for (let j = 0; j <= mm; j++) for (let i = 0; i <= n; i++) xy.push(i * s, j * s);
  const cells: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < mm; j++) for (let i = 0; i < n; i++) cells.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return finish(new Float64Array(xy), new Int32Array(cells));
}

const lineDist = (p: V2, a: V2, b: V2) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy);
};

describe('setback', () => {
  it('a corner closes on both offset lines, at any angle and any two offsets', () => {
    for (const deg of [60, 72, 90, 120, 200, 270]) {
      const th = (deg * Math.PI) / 180;
      const v: V2 = [1, 2];
      // face 1 along +x ending at v (outward normal −y), face 2 leaving v at the turn
      const n1: V2 = [0, -1];
      const dir: V2 = [Math.cos(Math.PI - th), Math.sin(Math.PI - th)];
      const n2: V2 = [dir[1], -dir[0]];
      for (const [d1, d2] of [[0.3, 0.3], [0.4, 0.1], [-0.2, 0.35]]) {
        const p = offsetCorner(v, n1, d1, n2, d2);
        expect((v[0] - p[0]) * n1[0] + (v[1] - p[1]) * n1[1]).toBeCloseTo(d1, 9);
        expect((v[0] - p[0]) * n2[0] + (v[1] - p[1]) * n2[1]).toBeCloseTo(d2, 9);
      }
    }
  });
  it('an L-shaped storey offset by d: every wall line parallel to its cell edge, d inside, the loop closed', () => {
    const m = squares(6, 6, 2.7);
    const tops = new Uint8Array(m.nc);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) tops[j * 6 + i] = 1;
    for (let i = 0; i < 2; i++) for (let j = 2; j < 5; j++) tops[j * 6 + i] = 1;
    const w = walls(m, tops);
    const loops = loopsOf(w.panels);
    expect(loops.length).toBe(1);
    const d = 0.35;
    const pts = offsetLoop(m, w.panels, loops[0], () => d, () => 0);
    const n = pts.length;
    for (let t = 0; t < n; t++) {
      const p = w.panels[pts[t].seg];
      const a: V2 = [m.xy[p.a * 2], m.xy[p.a * 2 + 1]];
      const b: V2 = [m.xy[p.b * 2], m.xy[p.b * 2 + 1]];
      // the segment from this point to the next lies on the panel's line moved in by d (left of a → b is inside)
      expect(lineDist(pts[t].p, a, b)).toBeCloseTo(-d, 9);
      expect(lineDist(pts[(t + 1) % n].p, a, b)).toBeCloseTo(-d, 9);
    }
    // 6 corners (5 convex, 1 concave) break runs; nothing else
    expect(pts.filter((q) => q.brk).length).toBe(6);
  });
  it('a jog where the offset changes along a straight wall: a return as long as the difference', () => {
    const m = squares(4, 1, 2.7);
    const tops = new Uint8Array([1, 1, 1, 1]);
    const w = walls(m, tops);
    const loop = loopsOf(w.panels)[0];
    // the bottom wall's two right panels stepped out by 0.3 (a jetty)
    const d = (i: number) => (w.panels[i].ny < -0.5 && w.panels[i].cell >= 2 ? 0.05 : 0.35);
    const pts = offsetLoop(m, w.panels, loop, d, () => 0);
    let found = false;
    for (let t = 0; t < pts.length; t++) {
      const a = pts[t].p;
      const b = pts[(t + 1) % pts.length].p;
      if (pts[t].brk && pts[(t + 1) % pts.length].brk && Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.3) < 1e-9) found = true;
    }
    expect(found).toBe(true);
  });
});

describe('runs and bays', () => {
  it('straight joints merge: a 6 × 2 block has 4 runs, bays by the theme width', () => {
    const m = squares(6, 2, 2.7);
    const tops = new Uint8Array(12).fill(1);
    const w = walls(m, tops);
    const pts = offsetLoop(m, w.panels, loopsOf(w.panels)[0], () => 0.35, () => 0);
    const bs = bays(pts, 2.7);
    expect(new Set(bs.map((b) => b.run)).size).toBe(4);
    // long sides 16.2 − 0.7 = 15.5 m → 6 bays; short 5.4 − 0.7 = 4.7 m → 2 bays
    const perRun = [...new Set(bs.map((b) => b.run))].map((r) => bs.filter((b) => b.run === r).length).sort();
    expect(perRun).toEqual([2, 2, 6, 6]);
    // bays of a run are equal; corners are convex joints with mitres m·n = 1 on both faces
    for (const b of bs) {
      const run = bs.filter((x) => x.run === b.run);
      expect(b.len).toBeCloseTo(run[0].len, 9);
      if (b.i === 0) {
        expect(b.ka).toBe(0);
        const nx = (b.b[1] - b.a[1]) / b.len;
        const ny = -(b.b[0] - b.a[0]) / b.len;
        expect(b.ma[0] * nx + b.ma[1] * ny).toBeCloseTo(1, 9);
      } else expect(b.ka).toBe(1);
    }
  });
  it('a run breaks where the house changes along a straight wall', () => {
    const m = squares(4, 1, 2.7);
    const w = walls(m, new Uint8Array([1, 1, 1, 1]));
    const pts = offsetLoop(m, w.panels, loopsOf(w.panels)[0], () => 0.3, (i) => (w.panels[i].cell < 2 ? 0 : 1));
    // 4 corners + where the bottom and the top walls pass from house 0 to house 1
    expect(pts.filter((q) => q.brk).length).toBe(6);
  });
  it('a chamfer cuts a sharp corner into two breaks c back along each face', () => {
    const sq: LoopPt[] = [
      { p: [0, 0], seg: 0, brk: true },
      { p: [4, 0], seg: 1, brk: true },
      { p: [4, 4], seg: 2, brk: true },
      { p: [0, 4], seg: 3, brk: true },
    ];
    const c = chamfer(sq, 100, 0.5);
    expect(c.length).toBe(8);
    expect(Math.hypot(c[1].p[0] - c[0].p[0], c[1].p[1] - c[0].p[1])).toBeCloseTo(0.5 * Math.SQRT2, 9);
    expect(interiorAt(c[7].p, c[0].p, c[1].p)).toBeCloseTo(135, 9);
    // above the threshold nothing is cut
    expect(chamfer(sq, 80, 0.5).length).toBe(4);
  });
  it('straighten pulls a run onto the line between its corners', () => {
    const pts: LoopPt[] = [
      { p: [0, 0], seg: 0, brk: true },
      { p: [2, 0.4], seg: 0, brk: false },
      { p: [4, -0.3], seg: 0, brk: false },
      { p: [6, 0], seg: 0, brk: true },
      { p: [6, 3], seg: 0, brk: true },
      { p: [0, 3], seg: 0, brk: true },
    ];
    const s = straighten(pts, 1);
    expect(s[1].p[1]).toBeCloseTo(0, 9);
    expect(s[2].p[1]).toBeCloseTo(0, 9);
    expect(straighten(pts, 0.5)[1].p[1]).toBeCloseTo(0.2, 9);
  });
  it('the real grid: every lot\'s ground loops offset by 0.35 m never fold (each offset segment keeps its direction)', () => {
    const m = muru();
    const tops = new Uint8Array(m.nc);
    for (let c = 0; c < m.nc; c++) if (m.cls![c] === 1) tops[c] = 1;
    const w = walls(m, tops);
    let folded = 0;
    let segs = 0;
    for (const loop of loopsOf(w.panels)) {
      const pts = offsetLoop(m, w.panels, loop, () => 0.35, () => 0);
      for (let t = 0; t < pts.length; t++) {
        const p = w.panels[pts[t].seg];
        const a = pts[t].p;
        const b = pts[(t + 1) % pts.length].p;
        const dot = (b[0] - a[0]) * (m.xy[p.b * 2] - m.xy[p.a * 2]) + (b[1] - a[1]) * (m.xy[p.b * 2 + 1] - m.xy[p.a * 2 + 1]);
        segs++;
        if (dot <= 0) folded++;
      }
    }
    // (a fold would need a panel shorter than ~2 × 0.35 / tan(corner / 2) between two convex corners; the grid's edges
    // are ≥ 1.5 m, so none: 1254 segments, 0 folded)
    expect(segs).toBeGreaterThan(1000);
    expect(folded).toBe(0);
  });
});
