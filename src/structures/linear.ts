// Linear features (the user, round 117: "linear tile features we can use for bridges, roads, railroads and extrude along
// splines"): a profile module warped segment by segment along a Catmull-Rom spline — the same warped-module pieces as the
// buildings (a segment's frame: its right and left edges at either end), so roads, rails, walls and viaducts need no
// renderer of their own. Routes (routes()): roads out of a town that cross valleys and water on arched bridges, a town
// wall round a town that asks for one, towers on it, gates where the roads go through.
import type { CitySpec, GroundFn, LinearFeature, LinearKind, V2, V3 } from '../api/contracts/structures';
import { fbm, rng } from './rng';

export interface Sample {
  p: V3;
  /** unit tangent (x, y) */
  t: V2;
  /** the ground under it */
  g: number;
  /** distance along (m) */
  s: number;
}

/** Catmull-Rom through the points, resampled every `step` m (by arc length); z and the ground interpolated alike. */
export function resample(f: LinearFeature, step: number): Sample[] {
  const P = f.points;
  const G = f.ground;
  const n = P.length;
  if (n < 2) return [];
  const at = (i: number) => (f.closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i)));
  // dense points first
  const dense: { p: V3; g: number }[] = [];
  const segs = f.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P[at(i - 1)];
    const p1 = P[at(i)];
    const p2 = P[at(i + 1)];
    const p3 = P[at(i + 2)];
    const g1 = G[at(i)];
    const g2 = G[at(i + 1)];
    const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(2, Math.ceil(L / 0.5));
    for (let k = 0; k < m; k++) {
      const t = k / m;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      // (a fence or a hedge runs straight between its posts: a field's outline has corners, not curves)
      const straight = f.kind === 'fence' || f.kind === 'hedge';
      const x = straight ? p1[0] + (p2[0] - p1[0]) * t : cr(p0[0], p1[0], p2[0], p3[0]);
      const y = straight ? p1[1] + (p2[1] - p1[1]) * t : cr(p0[1], p1[1], p2[1], p3[1]);
      dense.push({ p: [x, y, p1[2] + (p2[2] - p1[2]) * t], g: g1 + (g2 - g1) * t });
    }
  }
  if (!f.closed) dense.push({ p: P[n - 1], g: G[n - 1] });
  else dense.push(dense[0]);
  // then every `step` m along them
  const out: Sample[] = [];
  let s = 0;
  let next = 0;
  for (let i = 0; i + 1 < dense.length; i++) {
    const a = dense[i];
    const b = dense[i + 1];
    const L = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
    while (next <= s + L + 1e-9) {
      const t = L > 0 ? (next - s) / L : 0;
      const tx = L > 0 ? (b.p[0] - a.p[0]) / L : 1;
      const ty = L > 0 ? (b.p[1] - a.p[1]) / L : 0;
      out.push({ p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t], t: [tx, ty], g: a.g + (b.g - a.g) * t, s: next });
      next += step;
    }
    s += L;
  }
  // (the last bit of an open line: its end exactly)
  const last = dense[dense.length - 1];
  if (!f.closed && out.length && s - out[out.length - 1].s > step * 0.3) out.push({ p: last.p, t: out[out.length - 1].t, g: last.g, s });
  return out;
}

/** a segment's frame between two samples: right then left edges, counter-clockwise */
export function segFrame(a: Sample, b: Sample, w: number): [V2, V2, V2, V2] {
  // (each end's across direction is its own tangent's normal: consecutive segments share their ends' edges, no gaps)
  const n = (q: Sample): V2 => [-q.t[1] * (w / 2), q.t[0] * (w / 2)];
  const na = n(a);
  const nb = n(b);
  return [
    [a.p[0] - na[0], a.p[1] - na[1]],
    [b.p[0] - nb[0], b.p[1] - nb[1]],
    [b.p[0] + nb[0], b.p[1] + nb[1]],
    [a.p[0] + na[0], a.p[1] + na[1]],
  ];
}

/** how high over the ground a deck must be before the road becomes a bridge (m) */
export const BRIDGE_AT = 2.6;
/** a road's steepest grade */
export const GRADE = 0.14;
/** a town wall's walk over its ground (m) */
export const WALL_WALK = 8;

/**
 * A road's profile over the ground: never steeper than GRADE — filled over valleys and water (forward and backward
 * passes that only raise). Where it stands more than BRIDGE_AT over the ground (or over water) it's a bridge.
 */
export function profile(g: number[], ds: number, wet: boolean[]): { z: number[]; bridge: boolean[] } {
  const n = g.length;
  const z = g.map((v, i) => v + (wet[i] ? 3 : 0) + 0.15);
  for (let i = 1; i < n; i++) z[i] = Math.max(z[i], z[i - 1] - GRADE * ds);
  for (let i = n - 2; i >= 0; i--) z[i] = Math.max(z[i], z[i + 1] - GRADE * ds);
  const bridge = z.map((v, i) => v - g[i] > BRIDGE_AT || wet[i]);
  // (a bridge's ends reach the bank: one sample either side)
  const b2 = bridge.slice();
  for (let i = 0; i < n; i++) if (bridge[i]) for (const j of [i - 1, i + 1]) if (j >= 0 && j < n) b2[j] = true;
  return { z, bridge: b2 };
}

/** Roads out of the town (and their bridges), a town wall if asked: the plan's linear features. */
export function routes(spec: CitySpec, ground: GroundFn, water: GroundFn | undefined, wallLoop: boolean): LinearFeature[] {
  const out: LinearFeature[] = [];
  const r = rng(spec.seed * 41 + 9);
  const [cx, cy] = spec.at;
  const R = spec.radius;
  const nRoads = spec.roads ?? 0;
  const turn = r() * Math.PI * 2;
  const wet = (x: number, y: number) => (water ? water(x, y) > 0.3 : false);
  const gates: V2[] = [];
  for (let k = 0; k < nRoads; k++) {
    let a = turn + (k / nRoads) * Math.PI * 2 + (r() - 0.5) * 0.5;
    const ds = 2;
    const pts: { x: number; y: number }[] = [];
    for (let d = R * 0.85; d <= R * 0.85 + Math.max(R * 1.6, 110); d += ds) {
      a += (fbm(d * 0.02, k * 3.1, spec.seed + 13) - 0.5) * 0.05;
      pts.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d });
    }
    const g = pts.map((p) => ground(p.x, p.y));
    const w = pts.map((p) => wet(p.x, p.y));
    const { z, bridge } = profile(g, ds, w);
    gates.push([pts[Math.round((R * 0.17) / ds)]?.x ?? pts[0].x, pts[Math.round((R * 0.17) / ds)]?.y ?? pts[0].y]);
    // split into runs: road on the ground, bridge over the dips (control points every 6 m)
    let i = 0;
    while (i < pts.length) {
      const kind: LinearKind = bridge[i] ? 'bridge' : 'road';
      let j = i;
      while (j + 1 < pts.length && bridge[j + 1] === bridge[i]) j++;
      // (runs share their end point: the road meets the bridge's end)
      const end = Math.min(pts.length - 1, j + 1);
      const idx: number[] = [];
      for (let m = i; m < end; m += 3) idx.push(m);
      idx.push(end);
      if (idx.length >= 2)
        out.push({
          kind,
          points: idx.map((m) => [pts[m].x, pts[m].y, kind === 'road' ? g[m] + 0.15 : z[m]] as V3),
          ground: idx.map((m) => g[m]),
          width: kind === 'road' ? 4 : 4.6,
        });
      i = j + 1;
    }
  }
  if (wallLoop) {
    // the wall round the town: just outside its rim, following the ground; gaps where the roads go out
    const n = Math.max(24, Math.round((Math.PI * 2 * R * 1.08) / 6));
    const ring: { x: number; y: number }[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = R * (1.06 + (fbm(Math.cos(a) * 1.5, Math.sin(a) * 1.5, spec.seed + 17) - 0.5) * 0.08);
      ring.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
    const gate = (p: { x: number; y: number }) => gates.some((q) => Math.hypot(q[0] - p.x, q[1] - p.y) < 7);
    const keep = ring.map((p) => !gate(p) && !wet(p.x, p.y));
    // (runs of kept points round the loop: each a wall, open at the gates)
    const start = keep.indexOf(false);
    if (start < 0) {
      out.push({ kind: 'wall', points: ring.map((p) => [p.x, p.y, ground(p.x, p.y) + WALL_WALK] as V3), ground: ring.map((p) => ground(p.x, p.y)), width: 3.2, closed: true });
    } else {
      let run: { x: number; y: number }[] = [];
      for (let k = 1; k <= n; k++) {
        const i = (start + k) % n;
        if (keep[i]) run.push(ring[i]);
        if ((!keep[i] || k === n) && run.length >= 2) {
          out.push({ kind: 'wall', points: run.map((p) => [p.x, p.y, ground(p.x, p.y) + WALL_WALK] as V3), ground: run.map((p) => ground(p.x, p.y)), width: 3.2 });
          run = [];
        } else if (!keep[i]) run = [];
      }
    }
  }
  return out;
}
