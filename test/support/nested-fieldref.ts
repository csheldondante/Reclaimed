// Nested scales lab, round 29: a reference surface-nets mesh of the field (src/nested/fieldsel.ts fieldAt), as the GPU's
// fieldBake places it (gpu/field.wgsl fCell: a vertex a crossed cell, the mean of its edge crossings, clamped to the
// cell; a quad round every crossed sample edge, the 4 cells sharing it), and its cut by a horizontal plane. Shared by
// test/unit/nested-fedge.test.ts and test/gpu/nested-fedge.test.ts.
import { fieldAt, type FieldSpec } from '../../src/nested/fieldsel';

export type V3 = [number, number, number];
/** the mesh over sample edges whose first sample is in [x0, x1] x [y0, y1] x [k0, k1]. exact: (a measurement only, not
 *  built) each crossing found by bisecting the field along the cell edge instead of the linear interpolation of its two
 *  samples */
export function meshOf(s: FieldSpec, x0: number, y0: number, x1: number, y1: number, k0: number, k1: number, exact = false) {
  const smp = new Map<string, number>();
  const S = (X: number, Y: number, Z: number) => {
    const key = `${X},${Y},${Z}`;
    let v = smp.get(key);
    if (v === undefined) smp.set(key, (v = fieldAt(s, X + 0.5, Y + 0.5, Z)));
    return v;
  };
  const verts = new Map<string, V3 | null>();
  const E: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const vert = (X: number, Y: number, K: number): V3 | null => {
    const key = `${X},${Y},${K}`;
    if (verts.has(key)) return verts.get(key)!;
    const v: number[] = [];
    for (let c = 0; c < 8; c++) v.push(S(X + (c & 1), Y + ((c >> 1) & 1), K + (c >> 2)));
    let out: V3 | null = null;
    const m = v.filter((a) => a < 0).length;
    if (m > 0 && m < 8) {
      const acc = [0, 0, 0];
      let ne = 0;
      for (const [a, b] of E) {
        if (v[a] < 0 === v[b] < 0) continue;
        let t = v[a] / (v[a] - v[b]);
        if (exact) {
          const P = (c: number): V3 => [X + 0.5 + (c & 1), Y + 0.5 + ((c >> 1) & 1), K + (c >> 2)];
          const pa = P(a);
          const pb = P(b);
          let lo = 0;
          let hi = 1;
          const ina = v[a] < 0;
          for (let it = 0; it < 24; it++) {
            const mm = (lo + hi) / 2;
            const f = fieldAt(s, pa[0] + (pb[0] - pa[0]) * mm, pa[1] + (pb[1] - pa[1]) * mm, pa[2] + (pb[2] - pa[2]) * mm);
            if (f < 0 === ina) lo = mm;
            else hi = mm;
          }
          t = (lo + hi) / 2;
        }
        for (let ax = 0; ax < 3; ax++) {
          const ca = (a >> ax) & 1;
          const cb = (b >> ax) & 1;
          acc[ax] += ca + (cb - ca) * t;
        }
        ne++;
      }
      const t = acc.map((q) => Math.min(1, Math.max(0, q / ne)));
      out = [X + 0.5 + t[0], Y + 0.5 + t[1], K + t[2]];
    }
    verts.set(key, out);
    return out;
  };
  const quads: V3[][] = [];
  let holes = 0;
  for (let K = k0; K <= k1; K++)
    for (let Y = y0; Y <= y1; Y++)
      for (let X = x0; X <= x1; X++)
        for (let ax = 0; ax < 3; ax++) {
          const a = S(X, Y, K);
          const b = S(X + (ax === 0 ? 1 : 0), Y + (ax === 1 ? 1 : 0), K + (ax === 2 ? 1 : 0));
          if (a < 0 === b < 0) continue;
          const ring: [number, number, number][] =
            ax === 0
              ? [[X, Y - 1, K - 1], [X, Y, K - 1], [X, Y, K], [X, Y - 1, K]]
              : ax === 1
                ? [[X - 1, Y, K - 1], [X, Y, K - 1], [X, Y, K], [X - 1, Y, K]]
                : [[X - 1, Y - 1, K], [X, Y - 1, K], [X, Y, K], [X - 1, Y, K]];
          const q = ring.map(([cx, cy, ck]) => vert(cx, cy, ck));
          if (q.some((p) => !p)) {
            holes++;
            continue;
          }
          quads.push(q as V3[]);
        }
  return { quads, holes, verts };
}
/** the points where the mesh crosses height zc (each triangle's segment: both ends and the middle) */
export function cutAt(quads: V3[][], zc: number): [number, number][] {
  const out: [number, number][] = [];
  for (const q of quads)
    for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      const pts: [number, number][] = [];
      for (let i = 0; i < 3; i++) {
        const a = tri[i];
        const b = tri[(i + 1) % 3];
        if (a[2] < zc === b[2] < zc) continue;
        const t = (zc - a[2]) / (b[2] - a[2]);
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
      if (pts.length === 2) out.push(pts[0], pts[1], [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2]);
    }
  return out;
}
export const stats = (dev: number[]) => ({ n: dev.length, max: Math.max(...dev.map(Math.abs)), rms: Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / dev.length) });
export const fmt = (st: { n: number; max: number; rms: number }) => `max ${st.max.toFixed(3)}, RMS ${st.rms.toFixed(3)} columns (${st.n} points)`;
