// (tilekit step 2, docs/design/TILEKIT.md §14) Facades: the cell-edge wall panels of a storey (grid.ts walls) become
// closed outline loops; each loop is offset inwards by a metric setback (a wall runs parallel to the grid's line, set
// back from it; a storey may step out — a jetty — so offsets may differ edge to edge); straight joints are merged into
// runs that break only at real corners, jogs, and where the house or the eave changes; each run is laid out in bays of
// the theme's width (fewer, larger openings); every bay end gets its mitre. Pure geometry: no theme, no GPU.

import { P, type GridMesh, type Panel } from './grid';

export type V2 = [number, number];

/** a joint's kind by its interior angle (the inside of the wall): convex < 160°, straight, concave > 200° */
export const STRAIGHT_TURN = 20;
export const jointOf = (interior: number): 0 | 1 | 2 => (interior < 180 - STRAIGHT_TURN ? 0 : interior > 180 + STRAIGHT_TURN ? 2 : 1);

/** the mitre's length cap (a cornice at a joint sharper than ~47° stops short; step 1's TILEKIT Q4) */
export const MITRE_MAX = 2.5;

/** the mitre vector of a joint between faces with outward normals n1, n2: m·n1 = m·n2 = 1 */
export function mitreOf(n1: V2, n2: V2): V2 {
  const d = 1 + n1[0] * n2[0] + n1[1] * n2[1];
  let mx = (n1[0] + n2[0]) / Math.max(d, 1e-6);
  let my = (n1[1] + n2[1]) / Math.max(d, 1e-6);
  const l = Math.hypot(mx, my);
  if (l > MITRE_MAX) {
    mx *= MITRE_MAX / l;
    my *= MITRE_MAX / l;
  }
  return [mx, my];
}

/** the outward normal (right of a → b) */
export function normalOf(a: V2, b: V2): V2 {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
}

/** interior angle (degrees) at q of the CCW polygon … p → q → r … (the inside on the left) */
export function interiorAt(p: V2, q: V2, r: V2): number {
  const ax = q[0] - p[0];
  const ay = q[1] - p[1];
  const bx = r[0] - q[0];
  const by = r[1] - q[1];
  const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  return 180 - (turn * 180) / Math.PI;
}

/** a corner point of two offset lines: the line of face 1 (through v, normal n1) moved in by d1, the line of face 2
 *  moved in by d2; their intersection. With d1 = d2 it is v − d·mitre. */
export function offsetCorner(v: V2, n1: V2, d1: number, n2: V2, d2: number): V2 {
  // x·n1 = v·n1 − d1, x·n2 = v·n2 − d2
  const det = n1[0] * n2[1] - n1[1] * n2[0];
  const c1 = v[0] * n1[0] + v[1] * n1[1] - d1;
  const c2 = v[0] * n2[0] + v[1] * n2[1] - d2;
  if (Math.abs(det) < 1e-9) return [v[0] - n1[0] * d1, v[1] - n1[1] * d1];
  return [(c1 * n2[1] - c2 * n1[1]) / det, (n1[0] * c2 - n2[0] * c1) / det];
}

/** a point of an offset loop; the segment from it to the next point carries `seg` (the panel it came from) */
export interface LoopPt {
  p: V2;
  /** the panel whose face runs from this point to the next */
  seg: number;
  /** a run breaks here (a corner, a jog, a change of house or eave) */
  brk: boolean;
}

/** the closed loops of a storey's panels (following `next`), each a list of panel indices in order (CCW) */
export function loopsOf(panels: Panel[]): number[][] {
  const seen = new Uint8Array(panels.length);
  const out: number[][] = [];
  for (let i = 0; i < panels.length; i++) {
    if (seen[i]) continue;
    const loop: number[] = [];
    let j = i;
    while (!seen[j]) {
      seen[j] = 1;
      loop.push(j);
      j = panels[j].next;
      if (j < 0) throw new Error('tilekit: an open wall loop');
    }
    out.push(loop);
  }
  return out;
}

/** a loop's points offset inwards: panel i's face moved in by d[i]. Where two consecutive faces are nearly in line
 *  (a straight joint) but their offsets differ, the corner is a jog: two points, a short return between (a jetty's
 *  end, a setback's step). `key(i)` breaks runs where it changes (house, eave). */
export function offsetLoop(m: GridMesh, panels: Panel[], loop: number[], d: (i: number) => number, key: (i: number) => number): LoopPt[] {
  const out: LoopPt[] = [];
  const n = loop.length;
  for (let t = 0; t < n; t++) {
    const i = loop[(t + n - 1) % n];
    const j = loop[t];
    const pi = panels[i];
    const pj = panels[j];
    const v = P(m, pj.a);
    const ni: V2 = [pi.nx, pi.ny];
    const nj: V2 = [pj.nx, pj.ny];
    const interior = pi.end.angle;
    const di = d(i);
    const dj = d(j);
    const straight = jointOf(interior) === 1;
    if (straight && Math.abs(di - dj) > 1e-4) {
      // a jog: the end of face i's line, the start of face j's line, both level with v
      out.push({ p: [v[0] - ni[0] * di, v[1] - ni[1] * di], seg: -1, brk: true });
      out.push({ p: [v[0] - nj[0] * dj, v[1] - nj[1] * dj], seg: j, brk: true });
      continue;
    }
    out.push({ p: offsetCorner(v, ni, di, nj, dj), seg: j, brk: !straight || key(i) !== key(j) });
  }
  // a jog's return segment carries the face after it (its storey, house)
  for (let t = 0; t < out.length; t++) if (out[t].seg < 0) out[t].seg = out[(t + 1) % out.length].seg;
  return out;
}

/** cut a sharp convex corner (interior angle below `below`) by a chamfer: the corner point replaced by two, `c` metres
 *  back along each face; both break the run, so the chamfer is a run of its own (one blank bay) */
export function chamfer(pts: LoopPt[], below: number, c: number, only?: (p: V2) => boolean): LoopPt[] {
  const n = pts.length;
  const out: LoopPt[] = [];
  for (let t = 0; t < n; t++) {
    const a = pts[(t + n - 1) % n];
    const q = pts[t];
    const b = pts[(t + 1) % n];
    const ang = interiorAt(a.p, q.p, b.p);
    const la = Math.hypot(q.p[0] - a.p[0], q.p[1] - a.p[1]);
    const lb = Math.hypot(b.p[0] - q.p[0], b.p[1] - q.p[1]);
    if (!q.brk || ang >= below || (only && !only(q.p)) || la < 2.2 * c || lb < 2.2 * c) {
      out.push(q);
      continue;
    }
    const ua: V2 = [(a.p[0] - q.p[0]) / la, (a.p[1] - q.p[1]) / la];
    const ub: V2 = [(b.p[0] - q.p[0]) / lb, (b.p[1] - q.p[1]) / lb];
    out.push({ p: [q.p[0] + ua[0] * c, q.p[1] + ua[1] * c], seg: q.seg, brk: true });
    out.push({ p: [q.p[0] + ub[0] * c, q.p[1] + ub[1] * c], seg: q.seg, brk: true });
  }
  return out;
}

/** move each run's inner points towards the straight line between its ends by `f` (0 follows the grid's line, 1 a
 *  straight wall from corner to corner) */
export function straighten(pts: LoopPt[], f: number): LoopPt[] {
  if (f <= 0) return pts;
  const n = pts.length;
  const out = pts.map((q) => ({ ...q, p: [q.p[0], q.p[1]] as V2 }));
  const starts = pts.map((q, i) => (q.brk ? i : -1)).filter((i) => i >= 0);
  for (let r = 0; r < starts.length; r++) {
    const s = starts[r];
    const e = starts[(r + 1) % starts.length];
    const A = pts[s].p;
    const B = pts[e].p;
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) continue;
    for (let t = (s + 1) % n; t !== e; t = (t + 1) % n) {
      const q = pts[t].p;
      const u = ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2;
      const on: V2 = [A[0] + dx * u, A[1] + dy * u];
      out[t].p = [q[0] + (on[0] - q[0]) * f, q[1] + (on[1] - q[1]) * f];
    }
  }
  return out;
}

/** a bay: one straight piece of wall between two points of a run, a module instance's frame */
export interface Bay {
  a: V2;
  b: V2;
  /** mitres at a and b */
  ma: V2;
  mb: V2;
  /** the joint kinds at a and b (0 convex, 1 straight, 2 concave) and their interior angles */
  ka: number;
  kb: number;
  angA: number;
  angB: number;
  /** the panel under the bay's middle (storey, cell, eave) */
  seg: number;
  /** its run in the loop, its place in the run, the run's bay count and length */
  run: number;
  i: number;
  n: number;
  runLen: number;
  len: number;
}

/** lay a loop's runs out in bays: a run of length L gets max(1, round(L / bayW)) equal bays (arc length along the
 *  run's polyline; a bay's ends are points on it, the bay the chord between) */
export function bays(pts: LoopPt[], bayW: number): Bay[] {
  const n = pts.length;
  let starts = pts.map((q, i) => (q.brk ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) starts = [0];
  // the bay points round the loop: [point, seg of the bay after it, run, i, n, runLen]
  const bp: { p: V2; seg: number; run: number; i: number; n: number; runLen: number; corner: boolean }[] = [];
  for (let r = 0; r < starts.length; r++) {
    const s = starts[r];
    const e = starts.length === 1 ? s : starts[(r + 1) % starts.length];
    // the run's polyline s → … → e
    const poly: { p: V2; seg: number }[] = [];
    let t = s;
    do {
      poly.push({ p: pts[t].p, seg: pts[t].seg });
      t = (t + 1) % n;
    } while (t !== e);
    poly.push({ p: pts[e].p, seg: -1 });
    const cum = [0];
    for (let k = 1; k < poly.length; k++) cum.push(cum[k - 1] + Math.hypot(poly[k].p[0] - poly[k - 1].p[0], poly[k].p[1] - poly[k - 1].p[1]));
    const L = cum[cum.length - 1];
    const nb = Math.max(1, Math.round(L / bayW));
    const at = (x: number): V2 => {
      let k = 1;
      while (k < poly.length - 1 && cum[k] < x) k++;
      const f = (x - cum[k - 1]) / Math.max(cum[k] - cum[k - 1], 1e-9);
      return [poly[k - 1].p[0] + (poly[k].p[0] - poly[k - 1].p[0]) * f, poly[k - 1].p[1] + (poly[k].p[1] - poly[k - 1].p[1]) * f];
    };
    const segAt = (x: number): number => {
      let k = 1;
      while (k < poly.length - 1 && cum[k] < x) k++;
      return poly[k - 1].seg;
    };
    for (let i = 0; i < nb; i++) {
      const x0 = (L * i) / nb;
      bp.push({ p: i === 0 ? pts[s].p : at(x0), seg: segAt((L * (i + 0.5)) / nb), run: r, i, n: nb, runLen: L, corner: i === 0 });
    }
  }
  const m = bp.length;
  const out: Bay[] = [];
  const nrm = (k: number) => normalOf(bp[k].p, bp[(k + 1) % m].p);
  for (let k = 0; k < m; k++) {
    const a = bp[k];
    const b = bp[(k + 1) % m];
    const prev = bp[(k + m - 1) % m];
    const next = bp[(k + 2) % m];
    const angA = interiorAt(prev.p, a.p, b.p);
    const angB = interiorAt(a.p, b.p, next.p);
    out.push({
      a: a.p,
      b: b.p,
      ma: mitreOf(nrm((k + m - 1) % m), nrm(k)),
      mb: mitreOf(nrm(k), nrm((k + 1) % m)),
      ka: a.corner ? jointOf(angA) : 1,
      kb: b.corner ? jointOf(angB) : 1,
      angA,
      angB,
      seg: a.seg,
      run: a.run,
      i: a.i,
      n: a.n,
      runLen: a.runLen,
      len: Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]),
    });
  }
  return out;
}
