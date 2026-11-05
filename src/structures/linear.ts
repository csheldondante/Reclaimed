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

/** the land gates a town wall gets at the least, by the town's radius (a village 1, a town 2, a city 3) */
export const landGatesFor = (R: number): number => (R < 25 ? 1 : R < 40 ? 2 : 3);
/** how far out (m) a land gate's ground must be dry and walkable */
export const GATE_REACH = 16;
/** water deeper than this (m) is no way for a land gate (people wade to about 0.8 m) */
const GATE_WET = 0.3;
/** the steepest rise between two metre samples on a gate's way (m): steeper is a cliff */
const GATE_STEP = 0.9;

/**
 * Is (x, y) on a wall ring round (cx, cy) a way out by land? Dry and walkable from a little inside the ring (the town's
 * side) out to GATE_REACH past it, no cliff on the way. Returns how far out (m) the land goes, up to `far` (0: not a
 * land gate).
 */
export function landWay(cx: number, cy: number, x: number, y: number, ground: GroundFn, water: GroundFn | undefined, far = GATE_REACH): number {
  const dx = x - cx;
  const dy = y - cy;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  const wet = (px: number, py: number) => (water ? water(px, py) > GATE_WET : false);
  let prev = ground(x - ux * 6, y - uy * 6);
  for (let d = -5; d <= far; d += 1) {
    const px = x + ux * d;
    const py = y + uy * d;
    const g = ground(px, py);
    if (wet(px, py) || Math.abs(g - prev) > GATE_STEP) return d <= GATE_REACH ? 0 : d;
    prev = g;
  }
  return far;
}

/**
 * The wall's land gates (round 128l): one toward each road in (spec.approaches) where the ring there is a way out by
 * land, then the ring's points facing the most land, spread round it, until the town has landGatesFor(R) land gates
 * (counting the roads' gates `have` that are on land). An island town gets none: its only ways out are by water.
 */
function landGates(spec: CitySpec, ring: { x: number; y: number }[], ground: GroundFn, water: GroundFn | undefined, have: V2[]): V2[] {
  const [cx, cy] = spec.at;
  const n = ring.length;
  const far = spec.radius * 2;
  const way = ring.map((p) => landWay(cx, cy, p.x, p.y, ground, water, far));
  const ang = (x: number, y: number) => Math.atan2(y - cy, x - cx);
  const apart = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const out: V2[] = [];
  const onLand = (g: V2) => landWay(cx, cy, g[0], g[1], ground, water) > 0;
  const taken = () => [...have, ...out].filter(onLand).map((g) => ang(g[0], g[1]));
  // toward the roads in: the ring's land point nearest each road's direction (within 50°)
  for (const a of spec.approaches ?? []) {
    const aa = Math.atan2(a[1], a[0]);
    let best = -1;
    let bestOff = 0.87;
    for (let k = 0; k < n; k++) {
      const off = apart(ang(ring[k].x, ring[k].y), aa);
      if (way[k] > 0 && off < bestOff) {
        best = k;
        bestOff = off;
      }
    }
    if (best >= 0 && taken().every((t) => apart(t, ang(ring[best].x, ring[best].y)) > 0.6)) out.push([ring[best].x, ring[best].y]);
  }
  // then facing the most land, a quarter turn from the others where it can be (else a sixth)
  const want = landGatesFor(spec.radius);
  const order = Array.from({ length: n }, (_, k) => k)
    .filter((k) => way[k] > 0)
    .sort((a, b) => way[b] - way[a] || a - b);
  for (const gap of [Math.PI / 2, Math.PI / 3])
    for (const k of order) {
      if (taken().length >= want) return out;
      const a = ang(ring[k].x, ring[k].y);
      if (taken().every((t) => apart(t, a) > gap)) out.push([ring[k].x, ring[k].y]);
    }
  return out;
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
    // (round 128l, the user: "I mean towns should always have gates") land gates where the atlas's roads leave
    // (spec.approaches) and at least landGatesFor(R) facing the land: a town whose only gaps were in its river or the sea
    // had no way out by land (a port started in with roads: 0 — the fortress's builders could reach nothing outside)
    for (const g of landGates(spec, ring, ground, water, gates)) gates.push(g);
    const gate = (p: { x: number; y: number }) => gates.some((q) => Math.hypot(q[0] - p.x, q[1] - p.y) < 7);
    // (no wall in a river: a point is left out if it, or the wall either side of it, has any water under it — sampled every
    // metre, even shallow — so the runs end in towers either side of the water: a water gate, not a wall across it)
    const damp = (x: number, y: number) => (water ? water(x, y) > 0.05 : false);
    const segWet = ring.map((p, i) => {
      const q = ring[(i + 1) % n];
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      for (let d = 0; d <= L; d += 1) if (damp(p.x + ((q.x - p.x) * d) / L, p.y + ((q.y - p.y) * d) / L)) return true;
      return false;
    });
    const keep = ring.map((p, i) => !gate(p) && !wet(p.x, p.y) && !segWet[i] && !segWet[(i - 1 + n) % n]);
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
