// The tile systems (the user, round 117: "Irregular tiles like towscraper, voronoi tilings of isolines to make city
// streets and plot lots, radial tiles like bulwark"; round 37: "some cities look more rectangular"). Techniques, not
// looks: each cuts a disc of ground into quads (builder.ts) and says which are lots, streets, a plaza, the wall.
//   irregular        Townscaper: a triangle lattice, pairs merged into quads at random, every face cut into quads,
//                    relaxed toward squares; lanes wander out from a plaza.
//   contour-voronoi  plots: Voronoi cells of seeds snapped onto the ground's contours (terraces that follow the hill),
//                    streets the bands between plots, each plot cut into quads.
//   radial           Bulwark: rings and spokes about a keep, sectors doubling outward; a ring road, the spokes, a wall.
//   orthogonal       a lattice turned to the land, a street every few tiles.
import type { CitySpec, GroundFn, TileMesh, V2 } from '../../api/contracts/structures';
import { TileBuilder, quadCentre } from './builder';
import { rng, fbm } from '../rng';

export interface TileOpts {
  spec: CitySpec;
  ground: GroundFn;
}

export function tileSystem(o: TileOpts): TileMesh {
  switch (o.spec.system) {
    case 'irregular':
      return irregular(o);
    case 'contour-voronoi':
      return contourVoronoi(o);
    case 'radial':
      return radial(o);
    case 'orthogonal':
      return orthogonal(o);
  }
}

const tileOf = (s: CitySpec) => s.tile ?? 4;

// ------------------------------------------------------------------ irregular (Townscaper)

function irregular({ spec }: TileOpts): TileMesh {
  const r = rng(spec.seed * 7 + 1);
  const L = tileOf(spec) * 2;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const B = new TileBuilder();
  // the triangle lattice over the disc: rows L·√3/2 apart, odd rows shifted half
  const H = (L * Math.sqrt(3)) / 2;
  const n = Math.ceil(R / L) + 2;
  const pt = (i: number, j: number): V2 => [cx + (i + (j & 1) * 0.5) * L, cy + j * H];
  const tris: [V2, V2, V2][] = [];
  for (let j = -n; j < n; j++)
    for (let i = -n; i < n; i++) {
      const a = pt(i, j);
      const b = pt(i + 1, j);
      // (the row above: shifted right on odd rows)
      const o = j & 1;
      const c = pt(i + o, j + 1);
      const d = pt(i + o - 1, j + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  const inside = tris.filter((t) => Math.hypot((t[0][0] + t[1][0] + t[2][0]) / 3 - cx, (t[0][1] + t[1][1] + t[2][1]) / 3 - cy) < R);
  const ids = inside.map((t) => t.map((p) => B.vert(p[0], p[1])));
  // pair triangles across shared edges at random into quads
  const edgeTris = new Map<string, number[]>();
  ids.forEach((t, k) => {
    for (let s = 0; s < 3; s++) {
      const a = t[s];
      const b = t[(s + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      (edgeTris.get(key) ?? edgeTris.set(key, []).get(key)!).push(k);
    }
  });
  const order = ids.map((_, k) => k);
  const used = new Uint8Array(ids.length);
  for (let k = order.length - 1; k > 0; k--) {
    const m = Math.floor(r() * (k + 1));
    [order[k], order[m]] = [order[m], order[k]];
  }
  for (const k of order) {
    if (used[k]) continue;
    const t = ids[k];
    const start = Math.floor(r() * 3);
    let merged = false;
    if (r() < 0.82)
      for (let q = 0; q < 3 && !merged; q++) {
        const s = (start + q) % 3;
        const a = t[s];
        const b = t[(s + 1) % 3];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const other = edgeTris.get(key)!.find((o) => o !== k && !used[o]);
        if (other === undefined) continue;
        const u = ids[other];
        const opp = u.find((v) => v !== a && v !== b)!;
        const c = t[(s + 2) % 3];
        // the quad a, opp, b, c (the shared edge a–b removed)
        B.poly([a, opp, b, c], 'lot', -1, true);
        used[k] = used[other] = 1;
        merged = true;
      }
    if (!merged) {
      B.poly(t, 'lot', -1, true);
      used[k] = 1;
    }
  }
  B.pinBoundary();
  B.relax(30);
  const t = B.build();
  lanes(t, spec, r);
  return t;
}

/** Lanes wandering out from a plaza (irregular towns): quads the noisy rays and a ring pass through are streets. */
function lanes(t: TileMesh, spec: CitySpec, r: () => number): void {
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const tile = tileOf(spec);
  const n = t.use.length;
  const centres = Array.from({ length: n }, (_, q) => quadCentre(t, q));
  const k = 3 + Math.floor(r() * 3);
  const turn = r() * Math.PI * 2;
  const near = (x: number, y: number, w: number) => {
    for (let q = 0; q < n; q++) if (Math.hypot(centres[q][0] - x, centres[q][1] - y) < w) t.use[q] = 'street';
  };
  for (let i = 0; i < k; i++) {
    let a = turn + (i / k) * Math.PI * 2 + (r() - 0.5) * 0.6;
    for (let d = tile * 1.5; d < R; d += tile * 0.4) {
      a += (fbm(d * 0.05, i * 7.3, spec.seed) - 0.5) * 0.12;
      // (the main lanes two tiles wide near the middle, narrowing outward: the plan reads from afar)
      near(cx + Math.cos(a) * d, cy + Math.sin(a) * d, tile * (d < R * 0.6 ? 0.95 : 0.6));
    }
  }
  const ring = R * (0.5 + r() * 0.15);
  if (R > tile * 8)
    for (let a = 0; a < Math.PI * 2; a += (tile * 0.4) / ring) {
      const rr = ring * (1 + (fbm(Math.cos(a) * 2, Math.sin(a) * 2, spec.seed + 5) - 0.5) * 0.2);
      near(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, tile * 0.55);
    }
  for (let q = 0; q < n; q++) if (Math.hypot(centres[q][0] - cx, centres[q][1] - cy) < tile * (R > tile * 10 ? 2.8 : 1.8)) t.use[q] = 'plaza';
}

// ------------------------------------------------------------------ contour Voronoi

/** Sutherland–Hodgman: keep the part of `p` where (q − m)·n ≤ 0 */
export function clipHalf(p: V2[], m: V2, nrm: V2): V2[] {
  const out: V2[] = [];
  const side = (q: V2) => (q[0] - m[0]) * nrm[0] + (q[1] - m[1]) * nrm[1];
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa <= 0 !== sb <= 0) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** a convex polygon moved in by `w` on every side (or by `w(i)` on side i; empty if it vanishes) */
export function inset(p: V2[], w: number | ((i: number) => number)): V2[] {
  let q = p.slice();
  for (let i = 0; i < p.length && q.length >= 3; i++) {
    const wi = typeof w === 'number' ? w : w(i);
    if (wi <= 0) continue;
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    // counter-clockwise: the inside is on the left; the outward normal is (dy, −dx)
    const nx = dy / L;
    const ny = -dx / L;
    q = clipHalf(q, [a[0] - nx * wi, a[1] - ny * wi], [nx, ny]);
  }
  return q.length >= 3 ? q : [];
}

function ccw(p: V2[]): V2[] {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return a < 0 ? p.slice().reverse() : p;
}

/** drop vertices closer than `eps` to the one before (clipping makes slivers) */
function clean(p: V2[], eps: number): V2[] {
  const out: V2[] = [];
  for (const q of p) if (!out.length || Math.hypot(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) > eps) out.push(q);
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

/** seeds for the plots: a jittered lattice, each pulled onto the nearest contour of the ground */
export function contourSeeds(spec: CitySpec, ground: GroundFn, plot: number): V2[] {
  const r = rng(spec.seed * 13 + 3);
  const step = spec.contour ?? 3;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const out: V2[] = [];
  const h = plot * 0.92;
  for (let y = cy - R; y <= cy + R; y += h * 0.87)
    for (let x = cx - R + ((Math.round((y - cy) / (h * 0.87)) & 1) * h) / 2; x <= cx + R; x += h) {
      let px = x + (r() - 0.5) * h * 0.5;
      let py = y + (r() - 0.5) * h * 0.5;
      if (Math.hypot(px - cx, py - cy) > R - plot * 0.3) continue;
      // Newton toward the contour z = k·step along the gradient (flat ground: stays where it is)
      for (let it = 0; it < 3; it++) {
        const e = 0.5;
        const z = ground(px, py);
        const gx = (ground(px + e, py) - ground(px - e, py)) / (2 * e);
        const gy = (ground(px, py + e) - ground(px, py - e)) / (2 * e);
        const g2 = gx * gx + gy * gy;
        if (g2 < 0.004) break;
        const target = Math.round(z / step) * step;
        let mx = ((target - z) * gx) / g2;
        let my = ((target - z) * gy) / g2;
        const m = Math.hypot(mx, my);
        if (m > plot * 0.45) {
          mx *= (plot * 0.45) / m;
          my *= (plot * 0.45) / m;
        }
        px += mx;
        py += my;
      }
      out.push([px, py]);
    }
  // (seeds pulled onto one contour may crowd: thin them to half a plot apart)
  const kept: V2[] = [];
  for (const s of out) if (kept.every((k) => Math.hypot(k[0] - s[0], k[1] - s[1]) > plot * 0.5)) kept.push(s);
  return kept;
}

function contourVoronoi({ spec, ground }: TileOpts): TileMesh {
  const tile = tileOf(spec);
  const plot = tile * 4.2;
  const street = tile * 0.5;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const seeds = contourSeeds(spec, ground, plot);
  const rim: V2[] = [];
  for (let k = 0; k < 40; k++) rim.push([cx + Math.cos((k / 40) * Math.PI * 2) * R, cy + Math.sin((k / 40) * Math.PI * 2) * R]);
  const B = new TileBuilder();
  const plazaSeed = seeds.reduce((best, s, i) => (Math.hypot(s[0] - cx, s[1] - cy) < Math.hypot(seeds[best][0] - cx, seeds[best][1] - cy) ? i : best), 0);
  seeds.forEach((s, i) => {
    let p: V2[] = rim;
    for (let j = 0; j < seeds.length && p.length >= 3; j++) {
      if (j === i) continue;
      const t = seeds[j];
      const dx = t[0] - s[0];
      const dy = t[1] - s[1];
      if (Math.abs(dx) > plot * 3 || Math.abs(dy) > plot * 3) continue;
      p = clipHalf(p, [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2], [dx, dy]);
    }
    p = clean(ccw(p), 0.3);
    if (p.length < 3) return;
    // (no street along the town's rim: an edge whose ends both lie on the rim circle is the town's edge)
    const onRim = (v: V2) => Math.abs(Math.hypot(v[0] - cx, v[1] - cy) - R) < 0.05 * R;
    const rimEdge = (k: number) => onRim(p[k]) && onRim(p[(k + 1) % p.length]);
    const q = clean(inset(p, (k) => (rimEdge(k) ? 0 : street)), 0.3);
    const isPlaza = i === plazaSeed;
    if (q.length < 3 || isPlaza) {
      // too small for a plot (or the middle one): a square
      B.poly(p.map((v) => B.vert(v[0], v[1])), 'plaza', i, true);
      return;
    }
    // the band between the plot's edge and its inset: streets, two quads a side (meeting the plot's edge midpoints);
    // the inset matched to the outline by nearest direction from the seed
    const outerIds = p.map((v) => B.vert(v[0], v[1]));
    const qa = q.map((v) => Math.atan2(v[1] - s[1], v[0] - s[0]));
    const innerOf = p.map((v) => {
      const a = Math.atan2(v[1] - s[1], v[0] - s[0]);
      let best = 0;
      let bd = Infinity;
      qa.forEach((b, k) => {
        const d = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      return best;
    });
    const innerIds = q.map((v) => B.vert(v[0], v[1]));
    // the plot itself (lots), Townscaper's cut
    B.poly(innerIds, 'lot', i, true);
    for (let k = 0; k < p.length; k++) {
      const k1 = (k + 1) % p.length;
      const a = outerIds[k];
      const b = outerIds[k1];
      let ia = innerOf[k];
      const ib = innerOf[k1];
      // inset edges between ia and ib (usually one): a band quad each, its outer edge cut to match
      const run: number[] = [ia];
      while (ia !== ib && run.length < q.length + 1) {
        ia = (ia + 1) % q.length;
        run.push(ia);
      }
      // (an inset that lost edges can map an outline vertex past its next: treat that edge as a corner of street)
      if (run.length > 3) run.splice(1);
      if (run.length === 1) {
        // the inset lost this edge: a triangle of street
        B.poly([a, b, innerIds[run[0]]], 'street', i, true);
        continue;
      }
      if (rimEdge(k)) continue;
      const m = run.length - 1;
      const pa = B.at(a);
      const pb = B.at(b);
      for (let e = 0; e < m; e++) {
        const o0 = e === 0 ? a : B.vert(pa[0] + ((pb[0] - pa[0]) * e) / m, pa[1] + ((pb[1] - pa[1]) * e) / m);
        const o1 = e === m - 1 ? b : B.vert(pa[0] + ((pb[0] - pa[0]) * (e + 1)) / m, pa[1] + ((pb[1] - pa[1]) * (e + 1)) / m);
        const i0 = innerIds[run[e]];
        const i1 = innerIds[run[e + 1]];
        const mo = B.mid(o0, o1);
        const mi = B.mid(i0, i1);
        B.quad(o0, mo, mi, i0, 'street', i);
        B.quad(mo, o1, i1, mi, 'street', i);
      }
    }
  });
  B.subdivide();
  return B.build();
}

// ------------------------------------------------------------------ radial (Bulwark)

function radial({ spec }: TileOpts): TileMesh {
  const r = rng(spec.seed * 17 + 5);
  const tile = tileOf(spec);
  const spokes = spec.spokes ?? 6;
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const walls = spec.walls ?? true;
  const B = new TileBuilder();
  const r0 = tile * 2.6;
  const rings: number[] = [r0];
  while (rings[rings.length - 1] < R) rings.push(rings[rings.length - 1] + tile * (0.95 + 0.15 * r()));
  const turn = r() * Math.PI * 2;
  const nOf = (k: number) => {
    const mid = (rings[k] + rings[k + 1]) / 2;
    let n = spokes;
    while ((mid * Math.PI * 2) / (n * 2) > tile * 1.05) n *= 2;
    return n;
  };
  const ns = rings.slice(0, -1).map((_, k) => nOf(k));
  for (let k = 1; k < ns.length; k++) ns[k] = Math.max(ns[k], ns[k - 1]);
  const K = ns.length;
  const wallRing = walls ? K - 1 : -1;
  const ringRoads = new Set<number>([K >= 6 ? Math.round(K * 0.45) : -1, walls ? K - 2 : -1]);
  const at = (rad: number, a: number) => B.vert(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  // the keep's ground: the innermost disc, a polygon on the first ring's divisions
  const inner: number[] = [];
  for (let j = 0; j < ns[0]; j++) inner.push(at(rings[0], turn + (j / ns[0]) * Math.PI * 2));
  B.poly(inner, 'plaza', 0, true);
  for (let k = 0; k < K; k++) {
    const n = ns[k];
    const nOut = k + 1 < K ? ns[k + 1] : n;
    const m = Math.max(1, nOut / n);
    for (let j = 0; j < n; j++) {
      const a0 = turn + (j / n) * Math.PI * 2;
      const a1 = turn + ((j + 1) / n) * Math.PI * 2;
      const spoke = n >= spokes * 2 && j % (n / spokes) === 0;
      const use = k === wallRing ? (spoke ? 'gate' : 'wall') : ringRoads.has(k) || spoke ? 'street' : 'lot';
      // block: the band between ring roads, the sector between spokes
      let band = 0;
      for (const rr of ringRoads) if (rr >= 0 && k > rr) band++;
      const sector = Math.floor((j * spokes) / n);
      const block = 1 + band * 64 + sector;
      // (the inner edge at this ring's divisions, the outer at the next's: m quads a sector where the next ring doubles)
      for (let s = 0; s < m; s++) {
        const b0 = a0 + ((a1 - a0) * s) / m;
        const b1 = a0 + ((a1 - a0) * (s + 1)) / m;
        B.quad(at(rings[k], b0), at(rings[k + 1], b0), at(rings[k + 1], b1), at(rings[k], b1), use, block);
      }
    }
  }
  return B.build();
}

// ------------------------------------------------------------------ orthogonal

function orthogonal({ spec }: TileOpts): TileMesh {
  const r = rng(spec.seed * 19 + 7);
  const tile = tileOf(spec);
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const ang = r() * Math.PI;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const B = new TileBuilder();
  const n = Math.ceil(R / tile) + 1;
  const every = 4 + Math.floor(r() * 2);
  const P = (i: number, j: number) => {
    const x = i * tile;
    const y = j * tile;
    return B.vert(cx + x * ca - y * sa, cy + x * sa + y * ca);
  };
  for (let j = -n; j < n; j++)
    for (let i = -n; i < n; i++) {
      const mx = (i + 0.5) * tile;
      const my = (j + 0.5) * tile;
      if (Math.hypot(mx, my) > R) continue;
      const si = ((i % every) + every) % every === 0;
      const sj = ((j % every) + every) % every === 0;
      const plaza = Math.abs(mx) < tile * 1.6 && Math.abs(my) < tile * 1.6;
      const block = Math.floor(i / every) * 1000 + Math.floor(j / every);
      B.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), plaza ? 'plaza' : si || sj ? 'street' : 'lot', block);
    }
  return B.build();
}
