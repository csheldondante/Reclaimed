// A settlement's districts as overlay grids (round 88, BACKLOG R6; settlement.ts GridStyle). Each generator
// makes lots — polygons laid over the land — in its own way:
//  - radial: Bulwark's rings and spokes about a centre (the plaza), sectors doubling outward so they stay
//    about a lot across; the main spokes and one ring road left open;
//  - contour-voronoi: Voronoi cells seeded along the ground's height contours first (terraces that follow
//    the land), then filling what's left;
//  - irregular: Townscaper's triangles merged at random into quads and triangles;
//  - orthogonal: a square lattice turned to the land (a camp, a planned quarter).
// Every lot is cut the same way into quads the town (build/town.ts) builds on: a ring of yard quads round
// its edge (alleys between buildings, room to build later) and its inner polygon cut centre-to-midpoints
// (the building's footprint). So every style is a CellGrid: four neighbours a cell, over the hex columns.
// All in a box's local coordinates (x cells, y world units, as the window's), the box's origin row even.
import { cellAt, cellPos } from '../world/lattice';
import type { CellGrid } from '../build/towngrid';
import type { GridStyle } from '../api/contracts/settlement';

export type Pt = [number, number];

export function rand(seed: number): () => number {
  let s = (seed >>> 0) * 2654435761 + 1013904223;
  s = (s >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A lot: a polygon of the district, its yard quads and its building quads. */
export interface Lot {
  id: number;
  poly: Pt[];
  centre: Pt;
  /** how far its centre is from the district's (world units) */
  r: number;
  /** cells round its edge (open: yards, alleys) */
  yard: number[];
  /** cells inside (what a building stands on) */
  inner: number[];
  /** a street the generator left open (a spoke, a ring road) */
  street: boolean;
}

/** The polygons a style makes, each flagged if it's a street. */
interface Polys {
  polys: Pt[][];
  street: boolean[];
}

/** Bulwark's: rings and spokes. */
export function radialPolys(cx: number, cy: number, R: number, spacing: number, spokes: number, seed: number): Polys {
  const r = rand(seed);
  const r0 = spacing * 1.25;
  const rings: number[] = [r0];
  while (rings[rings.length - 1] < R) rings.push(rings[rings.length - 1] + spacing * (0.95 + 0.2 * r()));
  const turn = r() * Math.PI * 2;
  // sectors in ring k: spokes × 2^m, so the arc stays about a lot (and every finer ring splits the coarser's)
  const nOf = (k: number) => {
    const mid = (rings[k] + rings[k + 1]) / 2;
    let n = spokes;
    while ((mid * Math.PI * 2) / (n * 2) > spacing * 1.05) n *= 2;
    return n;
  };
  const ns = rings.slice(0, -1).map((_, k) => nOf(k));
  for (let k = 1; k < ns.length; k++) ns[k] = Math.max(ns[k], ns[k - 1]);
  // (a ring road about halfway out, when there are rings enough; the main spokes once a ring has more sectors)
  const ringRoad = ns.length >= 4 ? Math.round(ns.length * 0.5) : -1;
  const at = (rad: number, a: number): Pt => [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad];
  const polys: Pt[][] = [];
  const street: boolean[] = [];
  for (let k = 0; k < ns.length; k++) {
    const n = ns[k];
    const nOut = k + 1 < ns.length ? ns[k + 1] : n;
    const m = nOut / n;
    for (let j = 0; j < n; j++) {
      const a0 = turn + (j / n) * Math.PI * 2;
      const a1 = turn + ((j + 1) / n) * Math.PI * 2;
      const p: Pt[] = [at(rings[k], a0)];
      // (the outer arc at the next ring's divisions: shared corners)
      for (let q = 0; q <= m; q++) p.push(at(rings[k + 1], a0 + ((a1 - a0) * q) / m));
      p.push(at(rings[k], a1));
      // (counter-clockwise in x, y: inner a0, outer a0 … a1, inner a1 runs the other way — reversed below if needed)
      polys.push(p);
      street.push(k === ringRoad || (n >= spokes * 2 && j % (n / spokes) === 0));
    }
  }
  return { polys, street };
}

/** Sutherland–Hodgman: keep the part of `p` where (q − m)·n ≤ 0. */
function clip(p: Pt[], m: Pt, n: Pt): Pt[] {
  const out: Pt[] = [];
  const side = (q: Pt) => (q[0] - m[0]) * n[0] + (q[1] - m[1]) * n[1];
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa <= 0) !== (sb <= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Voronoi cells of `seeds` (inside a disc of R about the centre; open cells at the rim dropped). */
function voronoi(seeds: Pt[], cx: number, cy: number, R: number, spacing: number): Pt[][] {
  const out: Pt[][] = [];
  const reach = spacing * 3.2;
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    if (Math.hypot(s[0] - cx, s[1] - cy) > R) continue;
    const B = spacing * 2.2;
    let p: Pt[] = [
      [s[0] - B, s[1] - B],
      [s[0] + B, s[1] - B],
      [s[0] + B, s[1] + B],
      [s[0] - B, s[1] + B],
    ];
    for (let j = 0; j < seeds.length && p.length; j++) {
      if (j === i) continue;
      const t = seeds[j];
      const dx = t[0] - s[0];
      const dy = t[1] - s[1];
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      p = clip(p, [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2], [dx, dy]);
    }
    if (p.length < 3) continue;
    // (a cell still touching its bounding square is open: past the district's rim)
    if (p.some((q) => Math.abs(q[0] - s[0]) > B - 1e-3 || Math.abs(q[1] - s[1]) > B - 1e-3)) continue;
    out.push(p);
  }
  return out;
}

/** Voronoi seeded on the height contours, then the gaps filled. */
export function contourPolys(cx: number, cy: number, R: number, spacing: number, step: number, ground: (x: number, y: number) => number, seed: number): Polys {
  const r = rand(seed);
  const seeds: Pt[] = [];
  const far = (q: Pt, d: number) => seeds.every((s) => (s[0] - q[0]) ** 2 + (s[1] - q[1]) ** 2 >= d * d);
  // contour crossings on a lattice half a lot apart, the levels between contours (the terraces' middles)
  const h = spacing / 2;
  const R2 = R + spacing;
  const cands: Pt[] = [];
  for (let y = cy - R2; y <= cy + R2; y += h)
    for (let x = cx - R2; x <= cx + R2; x += h) {
      if (Math.hypot(x - cx, y - cy) > R2) continue;
      const z = ground(x, y);
      for (const [dx, dy] of [[h, 0], [0, h]]) {
        const z2 = ground(x + dx, y + dy);
        const l0 = Math.floor(z / step + 0.5);
        const l1 = Math.floor(z2 / step + 0.5);
        if (l0 !== l1) {
          // (where the half level lies between them)
          const lv = (Math.max(l0, l1) - 0.5) * step;
          const t = Math.min(1, Math.max(0, (lv - z) / (z2 - z || 1e-6)));
          cands.push([x + dx * t, y + dy * t]);
        }
      }
    }
  // (shuffled, then spaced along the contours a lot apart)
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  for (const q of cands) if (far(q, spacing * 0.92)) seeds.push(q);
  // the flats between: darts thrown a lot apart
  for (let t = 0; t < 4000; t++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * R2;
    const q: Pt = [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
    if (far(q, spacing)) seeds.push(q);
  }
  // (a plaza at the middle: no seed within a lot of it, one at it)
  const keep = seeds.filter((s) => Math.hypot(s[0] - cx, s[1] - cy) > spacing * 0.9);
  keep.push([cx, cy]);
  const polys = voronoi(keep, cx, cy, R, spacing);
  return { polys, street: polys.map(() => r() < 0.12) };
}

/** Townscaper's: triangles of edge L merged at random. */
export function irregularPolys(cx: number, cy: number, R: number, L: number, seed: number): Polys {
  const r = rand(seed);
  const N = Math.ceil(R / L / (Math.sqrt(3) / 2)) + 1;
  const P = (q: number, s: number): Pt => [cx + L * (q + s / 2), cy + L * s * (Math.sqrt(3) / 2)];
  const tris: [number, number][][] = [];
  for (let q = -N * 2; q <= N * 2; q++)
    for (let s = -N; s <= N; s++) {
      tris.push([[q, s], [q + 1, s], [q, s + 1]]);
      tris.push([[q + 1, s], [q + 1, s + 1], [q, s + 1]]);
    }
  const inside = (t: [number, number][]) => t.every(([q, s]) => Math.hypot(P(q, s)[0] - cx, P(q, s)[1] - cy) <= R);
  const live = tris.filter(inside);
  const key = (a: [number, number], b: [number, number]) => {
    const ka = `${a[0]},${a[1]}`;
    const kb = `${b[0]},${b[1]}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const byEdge = new Map<string, number[]>();
  live.forEach((t, i) => {
    for (let e = 0; e < 3; e++) {
      const k = key(t[e], t[(e + 1) % 3]);
      if (!byEdge.has(k)) byEdge.set(k, []);
      byEdge.get(k)!.push(i);
    }
  });
  const order = live.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const used = new Uint8Array(live.length);
  const polys: Pt[][] = [];
  for (const i of order) {
    if (used[i]) continue;
    used[i] = 1;
    const t = live[i];
    const opts: [number, number][] = [];
    for (let e = 0; e < 3; e++) {
      const o = byEdge.get(key(t[e], t[(e + 1) % 3]))!.find((j) => j !== i && !used[j]);
      if (o !== undefined) opts.push([e, o]);
    }
    if (!opts.length || r() < 0.25) {
      polys.push(t.map(([q, s]) => P(q, s)));
      continue;
    }
    const [e, j] = opts[Math.floor(r() * opts.length)];
    used[j] = 1;
    const a = t[e];
    const b = t[(e + 1) % 3];
    const c = t[(e + 2) % 3];
    const d = live[j].find((v) => !(v[0] === a[0] && v[1] === a[1]) && !(v[0] === b[0] && v[1] === b[1]))!;
    polys.push([a, d, b, c].map(([q, s]) => P(q, s)));
  }
  return { polys, street: polys.map(() => r() < 0.1) };
}

/** A square lattice turned by `angle`. */
export function orthoPolys(cx: number, cy: number, R: number, L: number, angle: number, seed: number): Polys {
  const r = rand(seed);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const P = (i: number, j: number): Pt => [cx + (i * c - j * s) * L, cy + (i * s + j * c) * L];
  const n = Math.ceil(R / L) + 1;
  const polys: Pt[][] = [];
  const street: boolean[] = [];
  const road = 1 + Math.floor(r() * 2);
  for (let j = -n; j < n; j++)
    for (let i = -n; i < n; i++) {
      const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
      if (q.some((p) => Math.hypot(p[0] - cx, p[1] - cy) > R)) continue;
      polys.push(q);
      // (two streets through the middle, a cross; the rest lots)
      street.push(((i % (road + 3)) + road + 3) % (road + 3) === 0 || j === 0);
    }
  return { polys, street };
}

export function stylePolys(style: GridStyle, at: Pt, R: number, spacing: number, opts: { seed: number; spokes?: number; contour?: number; angle?: number; ground: (x: number, y: number) => number }): Polys {
  switch (style) {
    case 'radial':
      return radialPolys(at[0], at[1], R, spacing, opts.spokes ?? 6, opts.seed);
    case 'contour-voronoi':
      return contourPolys(at[0], at[1], R, spacing, opts.contour ?? 3, opts.ground, opts.seed);
    case 'irregular':
      return irregularPolys(at[0], at[1], R, spacing, opts.seed);
    case 'orthogonal':
      return orthoPolys(at[0], at[1], R, spacing, opts.angle ?? 0, opts.seed);
  }
}

/** Lots and their quads over a w × h box of hex columns: a CellGrid the town builds on. */
export class LotGrid implements CellGrid {
  readonly verts: number[] = [];
  readonly quads: number[] = [];
  readonly count: number;
  readonly nbr: Int32Array;
  readonly cellOf: Int32Array;
  readonly columns: number[][];
  readonly lots: Lot[] = [];
  /** per cell its lot */
  readonly lotOf: number[] = [];
  private snap = new Map<string, number[]>();

  /**
   * `taken` (optional): a column already belonging to an earlier district — a lot whose centre falls on one is
   * left out (a cell belongs to the grid listed first).
   */
  constructor(readonly w: number, readonly h: number, P: Polys, inset = 0.6, taken?: (x: number, y: number) => boolean) {
    // the polygons' corners snapped together (Voronoi's corners come out of different clips a hair apart;
    // corners nearer than SNAP are one: no sliver edges)
    const SNAP = 0.9;
    const polys: { p: number[]; street: boolean }[] = [];
    P.polys.forEach((poly, i) => {
      const ids: number[] = [];
      for (const q of poly) {
        const v = this.vertex(q[0], q[1], SNAP);
        if (ids[ids.length - 1] !== v) ids.push(v);
      }
      if (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
      if (ids.length >= 3) polys.push({ p: ids, street: P.street[i] });
    });
    const quads: number[][] = [];
    const qlot: number[] = [];
    const vx = (v: number) => this.verts[v * 2];
    const vy = (v: number) => this.verts[v * 2 + 1];
    for (const { p: poly, street } of polys) {
      // (counter-clockwise in x, y)
      let a = 0;
      for (let k = 0; k < poly.length; k++) a += vx(poly[k]) * vy(poly[(k + 1) % poly.length]) - vx(poly[(k + 1) % poly.length]) * vy(poly[k]);
      const p = a < 0 ? poly.slice().reverse() : poly;
      const n = p.length;
      const cx = p.reduce((s, v) => s + vx(v), 0) / n;
      const cy = p.reduce((s, v) => s + vy(v), 0) / n;
      const [ox, oy] = [cx, cy];
      // (inside the box with a cell's margin; not on an earlier district)
      const [bx, by] = cellPos(w - 1.5, h - 1.5);
      if (p.some((v) => vx(v) < 1 || vy(v) < 1 || vx(v) > bx || vy(v) > by)) continue;
      if (taken?.(ox, oy)) continue;
      const lot: Lot = { id: this.lots.length, poly: p.map((v) => [vx(v), vy(v)]), centre: [cx, cy], r: 0, yard: [], inner: [], street };
      // the inner polygon (own corners), its midpoints, its centre
      const inner = p.map((v) => this.addVert(cx + (vx(v) - cx) * inset, cy + (vy(v) - cy) * inset));
      const mids = inner.map((v, k) => {
        const u = inner[(k + 1) % n];
        return this.addVert((vx(v) + vx(u)) / 2, (vy(v) + vy(u)) / 2);
      });
      const c = this.addVert(cx, cy);
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        // the yard: outer edge, then the inner edge back (counter-clockwise: outer k → outer k1 → inner k1 → inner k)
        quads.push([p[k], p[k1], inner[k1], inner[k]]);
        qlot.push(lot.id);
        lot.yard.push(quads.length - 1);
      }
      for (let k = 0; k < n; k++) {
        quads.push([inner[k], mids[k], c, mids[(k + n - 1) % n]]);
        qlot.push(lot.id);
        lot.inner.push(quads.length - 1);
      }
      this.lots.push(lot);
    }
    this.count = quads.length;
    for (const q of quads) this.quads.push(...q);
    this.lotOf.push(...qlot);
    // neighbours: quads sharing an edge (both corners)
    this.nbr = new Int32Array(this.count * 4).fill(-1);
    const owner = new Map<string, [number, number]>();
    quads.forEach((q, ci) => {
      for (let e = 0; e < 4; e++) {
        const a = q[e];
        const b = q[(e + 1) % 4];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        const o = owner.get(k);
        if (o) {
          this.nbr[ci * 4 + e] = o[0];
          this.nbr[o[0] * 4 + o[1]] = ci;
        } else owner.set(k, [ci, e]);
      }
    });
    // the hex columns in each quad (centres inside it)
    this.cellOf = new Int32Array(w * h).fill(-1);
    this.columns = quads.map(() => []);
    quads.forEach((q, ci) => {
      let lx = Infinity;
      let ly = Infinity;
      let hx = -Infinity;
      let hy = -Infinity;
      for (const v of q) {
        lx = Math.min(lx, vx(v));
        hx = Math.max(hx, vx(v));
        ly = Math.min(ly, vy(v));
        hy = Math.max(hy, vy(v));
      }
      const [, r0] = cellAt(lx, ly);
      const [, r1] = cellAt(hx, hy);
      for (let rr = Math.max(0, r0 - 1); rr <= Math.min(h - 1, r1 + 1); rr++) {
        const [c0] = cellAt(lx, cellPos(0, rr)[1]);
        const [c1] = cellAt(hx, cellPos(0, rr)[1]);
        for (let k = Math.max(0, c0 - 1); k <= Math.min(w - 1, c1 + 1); k++) {
          const [x, y] = cellPos(k, rr);
          if (this.cellOf[rr * w + k] < 0 && this.contains(ci, x, y)) {
            this.cellOf[rr * w + k] = ci;
            this.columns[ci].push(rr * w + k);
          }
        }
      }
    });
  }

  private addVert(x: number, y: number): number {
    this.verts.push(x, y);
    return this.verts.length / 2 - 1;
  }

  /** a shared corner: the one within `tol` already made, or a new one */
  private vertex(x: number, y: number, tol: number): number {
    const gx = Math.floor(x / tol);
    const gy = Math.floor(y / tol);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const v of this.snap.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(this.verts[v * 2] - x, this.verts[v * 2 + 1] - y) < tol) return v;
    const v = this.addVert(x, y);
    const k = `${gx},${gy}`;
    if (!this.snap.has(k)) this.snap.set(k, []);
    this.snap.get(k)!.push(v);
    return v;
  }

  corner(c: number, k: number): [number, number] {
    const v = this.quads[c * 4 + (k & 3)];
    return [this.verts[v * 2], this.verts[v * 2 + 1]];
  }

  contains(c: number, x: number, y: number): boolean {
    for (let e = 0; e < 4; e++) {
      const [ax, ay] = this.corner(c, e);
      const [bx, by] = this.corner(c, e + 1);
      if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
    }
    return true;
  }

  cellAtWorld(x: number, y: number): number {
    const [cx, cy] = cellAt(x, y);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return -1;
    return this.cellOf[cy * this.w + cx];
  }

  edgeDist(c: number, e: number, x: number, y: number): [number, number] {
    const [ax, ay] = this.corner(c, e);
    const [bx, by] = this.corner(c, e + 1);
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    return [Math.hypot(x - ax - dx * t, y - ay - dy * t), t];
  }

  centre(c: number): [number, number] {
    let x = 0;
    let y = 0;
    for (let k = 0; k < 4; k++) {
      const [a, b] = this.corner(c, k);
      x += a / 4;
      y += b / 4;
    }
    return [x, y];
  }
}
