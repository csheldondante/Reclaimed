// (tilekit step 3, TILEKIT.md §24) The union of strip roofs where strips meet. Each roof stands for a solid: under its
// top surface over the strip's own cells, the whole house down to the ground; under its overhang ring (and a gable end
// run on into a crossing roof), a slab as thick as the roof. Every roof's surfaces (top, ring, soffit, fascia) lose
// what lies inside another roof's solid; what is left is the boundary of the union: valleys where a slope meets a slope,
// a ridge running into a crossing roof cut where it enters, no hip or pyramid poking through, an eave running on where
// the neighbour's roof is lower. Where two surfaces coincide (a shared plane), the roof listed first keeps its part (a
// stable tie). Pure geometry on world vertex arrays (kit.ts's 12 floats a vertex).
//
// Each other roof's solid is a union of convex pieces (one a lid triangle t: inside t's plan, under t's plane, above
// t's plane less its depth), so a convex polygon minus a piece is ≤ 5 convex polygons (Sutherland–Hodgman on the
// piece's 5 half-spaces).

export type V3 = [number, number, number];

/** world vertex layout (kit.ts VF, block.ts wv): x y z anchor, nx ny nz ao, r g b mat */
const VF = 12;

/** a lid triangle and the solid under it: down from its plane by `depth` (Infinity: to the ground) */
export interface Lid {
  t: [V3, V3, V3];
  depth: number;
}

export interface RoofSolidIn {
  /** the roof's own surfaces to clip (top, ring, soffit, fascia): world vertices, three a triangle */
  verts: number[];
  /** its solid, as lid triangles */
  lids: Lid[];
}

const GROUND = -100;

interface Piece {
  /** pts of a convex planar polygon */
  pts: V3[];
  /** the source triangle's attributes (its first vertex, without the position) */
  attr: number[];
}

const EPS = 1e-4;

/** clip a convex polygon to f(p) ≥ 0 (f affine) */
function clip(pts: V3[], f: (p: V3) => number): V3[] {
  const out: V3[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** a polygon's area (3D) */
function area(pts: V3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[0];
    const b = pts[i];
    const c = pts[i + 1];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    x += u[1] * v[2] - u[2] * v[1];
    y += u[2] * v[0] - u[0] * v[2];
    z += u[0] * v[1] - u[1] * v[0];
  }
  return Math.hypot(x, y, z) / 2;
}

/** a lid triangle as the half-spaces of its prism piece; `tieWin` true: points on its plane are outside (kept) */
interface Prism {
  fs: ((p: V3) => number)[];
  lo: [number, number];
  hi: [number, number];
  zmin: number;
  zmax: number;
}
function prismOf(lid: Lid, tieWin: boolean): Prism | null {
  let [a, b, c] = lid.t;
  // plan orientation CCW
  const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(cr) < 1e-6) return null;
  if (cr < 0) [b, c] = [c, b];
  // the plane z = px·x + py·y + p0
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const px = -nx / nz;
  const py = -ny / nz;
  const p0 = a[2] - px * a[0] - py * a[1];
  const d = tieWin ? EPS : -EPS;
  const edge = (p: V3, q: V3) => {
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const l = Math.hypot(ex, ey);
    return (r: V3) => (ex * (r[1] - p[1]) - ey * (r[0] - p[0])) / l;
  };
  const top = (r: V3) => px * r[0] + py * r[1] + p0 - d - r[2];
  const floor = Number.isFinite(lid.depth) ? (r: V3) => r[2] - (px * r[0] + py * r[1] + p0 - lid.depth - EPS) : (r: V3) => r[2] - GROUND;
  return {
    fs: [edge(a, b), edge(b, c), edge(c, a), top, floor],
    lo: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1])],
    hi: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1])],
    zmin: Number.isFinite(lid.depth) ? Math.min(a[2], b[2], c[2]) - lid.depth : GROUND,
    zmax: Math.max(a[2], b[2], c[2]),
  };
}

/** a polygon minus a prism: the convex pieces outside it (the polygon itself if they don't meet) */
function subtract(pts: V3[], P: Prism): V3[][] {
  // (quick outs: plan boxes apart, or the polygon wholly above the prism's top or below its floor)
  let lx = Infinity;
  let ly = Infinity;
  let hx = -Infinity;
  let hy = -Infinity;
  let lz = Infinity;
  let hz = -Infinity;
  for (const p of pts) {
    lx = Math.min(lx, p[0]);
    ly = Math.min(ly, p[1]);
    hx = Math.max(hx, p[0]);
    hy = Math.max(hy, p[1]);
    lz = Math.min(lz, p[2]);
    hz = Math.max(hz, p[2]);
  }
  if (hx < P.lo[0] - EPS || lx > P.hi[0] + EPS || hy < P.lo[1] - EPS || ly > P.hi[1] + EPS || lz > P.zmax + EPS || hz < P.zmin - EPS) return [pts];
  let inside = pts;
  for (const f of P.fs) {
    inside = clip(inside, f);
    if (inside.length < 3) return [pts];
  }
  if (area(inside) < 1e-7) return [pts];
  const out: V3[][] = [];
  let rest = pts;
  for (const f of P.fs) {
    const outside = clip(rest, (p) => -f(p));
    if (outside.length >= 3 && area(outside) > 1e-7) out.push(outside);
    rest = clip(rest, f);
    if (rest.length < 3) break;
  }
  return out;
}

/** a coarse plan hash of prisms */
class Bins {
  private m = new Map<number, Prism[]>();
  constructor(private s = 1.5) {}
  private key(i: number, j: number) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  add(P: Prism) {
    for (let i = Math.floor(P.lo[0] / this.s); i <= Math.floor(P.hi[0] / this.s); i++) {
      for (let j = Math.floor(P.lo[1] / this.s); j <= Math.floor(P.hi[1] / this.s); j++) {
        const k = this.key(i, j);
        let a = this.m.get(k);
        if (!a) this.m.set(k, (a = []));
        a.push(P);
      }
    }
  }
  near(pts: V3[]): Prism[] {
    let lx = Infinity;
    let ly = Infinity;
    let hx = -Infinity;
    let hy = -Infinity;
    for (const p of pts) {
      lx = Math.min(lx, p[0]);
      ly = Math.min(ly, p[1]);
      hx = Math.max(hx, p[0]);
      hy = Math.max(hy, p[1]);
    }
    const seen = new Set<Prism>();
    for (let i = Math.floor(lx / this.s); i <= Math.floor(hx / this.s); i++) for (let j = Math.floor(ly / this.s); j <= Math.floor(hy / this.s); j++) for (const P of this.m.get(this.key(i, j)) ?? []) seen.add(P);
    return [...seen];
  }
}

/** the triangles of a vertex array with material `mat` facing up (a roof's top surface) */
export function upTris(verts: number[], mat: number): [V3, V3, V3][] {
  const out: [V3, V3, V3][] = [];
  for (let i = 0; i + 3 * VF <= verts.length; i += 3 * VF) {
    if (verts[i + 11] !== mat || verts[i + 6] <= 0.05) continue;
    out.push([0, 1, 2].map((k) => [verts[i + k * VF], verts[i + k * VF + 1], verts[i + k * VF + 2]]) as [V3, V3, V3]);
  }
  return out;
}

export interface UnionStats {
  /** triangles in, triangles out, roofs that lost anything */
  trisIn: number;
  trisOut: number;
  clipped: number;
  /** each roof's output, [first float, end float) in `out` */
  ranges: [number, number][];
  /** where a roof lost something to another: the middle of the first piece removed (x y z), one a cut roof */
  cuts: V3[];
}

/** how deep the worst point of a kept roof surface lies inside another roof's solid (≤ ~0 when the union is right),
 *  sampled at each output triangle's centroid and its corners pulled 10% in */
export function worstInside(roofs: RoofSolidIn[], out: number[], ranges: [number, number][]): number {
  let worst = -Infinity;
  const box = roofs.map((r) => {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { t } of r.lids) for (const p of t) {
      b[0] = Math.min(b[0], p[0]);
      b[1] = Math.min(b[1], p[1]);
      b[2] = Math.max(b[2], p[0]);
      b[3] = Math.max(b[3], p[1]);
    }
    return b;
  });
  ranges.forEach(([s, e], i) => {
    for (let v = s; v + 3 * VF <= e; v += 3 * VF) {
      const P = [0, 1, 2].map((k) => [out[v + k * VF], out[v + k * VF + 1], out[v + k * VF + 2]] as V3);
      const c: V3 = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3, (P[0][2] + P[1][2] + P[2][2]) / 3];
      const samples = [c, ...P.map((p) => [p[0] * 0.9 + c[0] * 0.1, p[1] * 0.9 + c[1] * 0.1, p[2] * 0.9 + c[2] * 0.1] as V3)];
      roofs.forEach((r, j) => {
        if (j === i) return;
        const b = box[j];
        if (c[0] < b[0] - 3 || c[0] > b[2] + 3 || c[1] < b[1] - 3 || c[1] > b[3] + 3) return;
        for (const { t: [a, b, cc], depth } of r.lids) {
          for (const p of samples) {
            const z = lidZ(a, b, cc, p[0], p[1]);
            if (z === null) continue;
            // inside by this much (the smaller of: under the lid, above its floor)
            worst = Math.max(worst, Math.min(z - p[2], p[2] - (z - depth)));
          }
        }
      });
    }
  });
  return worst === -Infinity ? 0 : worst;
}

/** the lid's height at (x, y) if the point is inside the triangle's plan (barycentric margin `e`: > 0 strictly inside,
 *  < 0 a little outside counts), else null */
export function lidZ(a: V3, b: V3, c: V3, x: number, y: number, e = 1e-3): number | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
  const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < e || l2 < e || l3 < e) return null;
  return l1 * a[2] + l2 * b[2] + l3 * c[2];
}

/** the union: each roof's surfaces minus every other roof's solid, written to `out` (fanned convex pieces) */
export function unionRoofs(roofs: RoofSolidIn[], out: number[]): UnionStats {
  // every roof's prisms, twice: as seen by a roof listed before it (it loses ties) and after (it wins them)
  const st: UnionStats = { trisIn: 0, trisOut: 0, clipped: 0, ranges: [], cuts: [] };
  const binsWin = roofs.map(() => new Bins());
  const binsLose = roofs.map(() => new Bins());
  roofs.forEach((r, i) => {
    for (const lid of r.lids) {
      const w = prismOf(lid, true);
      const l = prismOf(lid, false);
      if (w) binsWin[i].add(w);
      if (l) binsLose[i].add(l);
    }
  });
  // plan boxes a roof, to skip pairs that don't meet
  const box = roofs.map((r) => {
    let lx = Infinity;
    let ly = Infinity;
    let hx = -Infinity;
    let hy = -Infinity;
    for (let i = 0; i < r.verts.length; i += VF) {
      lx = Math.min(lx, r.verts[i]);
      ly = Math.min(ly, r.verts[i + 1]);
      hx = Math.max(hx, r.verts[i]);
      hy = Math.max(hy, r.verts[i + 1]);
    }
    return [lx, ly, hx, hy];
  });
  roofs.forEach((r, i) => {
    let pieces: Piece[] = [];
    for (let v = 0; v + 3 * VF <= r.verts.length; v += 3 * VF) {
      pieces.push({ pts: [0, 1, 2].map((k) => [r.verts[v + k * VF], r.verts[v + k * VF + 1], r.verts[v + k * VF + 2]]) as V3[], attr: r.verts.slice(v + 3, v + VF) });
    }
    st.trisIn += pieces.length;
    let lost = false;
    roofs.forEach((_, j) => {
      if (j === i) return;
      const [ax, ay, bx, by] = box[i];
      const [cx, cy, dx, dy] = box[j];
      if (bx < cx || dx < ax || by < cy || dy < ay) return;
      // (the roof listed first keeps a shared plane: clipping i by a later j, points on j's lid stay outside j's prism
      // (prismOf tieWin); by an earlier j, they count as inside and go)
      const bins = j > i ? binsWin[j] : binsLose[j];
      const next: Piece[] = [];
      for (const pc of pieces) {
        let parts = [pc.pts];
        for (const P of bins.near(pc.pts)) {
          const nx: V3[][] = [];
          for (const q of parts) {
            const r = subtract(q, P);
            if (r.length !== 1 || r[0] !== q) {
              if (!lost) {
                const c = q.reduce((s, p) => [s[0] + p[0] / q.length, s[1] + p[1] / q.length, s[2] + p[2] / q.length], [0, 0, 0] as V3);
                st.cuts.push(c);
              }
              lost = true;
            }
            nx.push(...r);
          }
          parts = nx;
          if (!parts.length) break;
        }
        for (const q of parts) next.push({ pts: q, attr: pc.attr });
      }
      pieces = next;
    });
    if (lost) st.clipped++;
    const first = out.length;
    for (const pc of pieces) {
      for (let k = 1; k + 1 < pc.pts.length; k++) {
        for (const p of [pc.pts[0], pc.pts[k], pc.pts[k + 1]]) out.push(p[0], p[1], p[2], ...pc.attr);
        st.trisOut++;
      }
    }
    st.ranges.push([first, out.length]);
  });
  return st;
}
