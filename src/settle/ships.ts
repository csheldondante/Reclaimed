// Ships between the ports (round 120, `cities`; BACKLOG STR32). The user, verbatim (DECISIONS round 120): "I think both
// anchored at harbor and sailing. It will make the world feel very alive. I'm not sure about sinking them or wind but both
// would be very cool." Moored ships are the ports' own (structures purpose.ts berths); these are the sailing ones: a few
// ships on simple routes over the water between ports — a path on the water, not physics (sinking and sailing by the
// wind are maybes for later: BACKLOG STR37).
//
// Two concerns, two halves: `shipRoutes` charts the routes once (atlas scale: a shortest path over the sea's texels
// between each port and its nearest reachable ports, kept off the coasts, string-pulled straight where the water allows);
// `Fleet` says where each ship is at a time (a pure function of the time: every ship plies its route out and back,
// resting in port at each end) — so the GM, a save and every client agree where the ships are without simulating them.
import type { Berth } from '../api/contracts/structures';

/** The sea as the atlas knows it: its macro ground per texel (n × n over the wrapping world) and the sea's level. */
export interface SeaChart {
  n: number;
  worldW: number;
  worldH: number;
  /** per texel: its ground (world z) */
  ground: Float32Array;
  sea: number;
}

export interface ShipRoute {
  /** the ports it joins (settlement ids) */
  a: string;
  b: string;
  /** world points (x, y pairs), unwrapped along the route (a point may lie past the world's edge: wrap to use it) */
  path: Float32Array;
  length: number;
}

/** texels of the chart a cell of the search (the macro map is fine; ports a few hundred units apart need no finer) */
const COARSE = 4;
/** the water must be this deep (world z under the sea) for a ship */
export const SEA_DEPTH = 1.5;

/** A min-heap of (cost, cell). */
class Heap {
  private c: number[] = [];
  private k: number[] = [];
  get size(): number {
    return this.c.length;
  }
  push(cost: number, key: number): void {
    const c = this.c;
    const k = this.k;
    c.push(cost);
    k.push(key);
    let i = c.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= c[i]) break;
      [c[p], c[i]] = [c[i], c[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const c = this.c;
    const k = this.k;
    const top: [number, number] = [c[0], k[0]];
    const lc = c.pop()!;
    const lk = k.pop()!;
    if (c.length) {
      c[0] = lc;
      k[0] = lk;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < c.length && c[l] < c[m]) m = l;
        if (r < c.length && c[r] < c[m]) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The routes: from each port, a shortest path over deep water (8-connected; a step beside land costs more, so ships
 * keep off the coasts) to the nearest `perPort` other ports it can reach within `reach` world units of sailing; each
 * pair once. Ports with no sea near (a lake's, a river's far upstream) have none.
 */
export function shipRoutes(ports: { id: string; at: [number, number] }[], chart: SeaChart, opts: { reach?: number; perPort?: number } = {}): ShipRoute[] {
  const reach = opts.reach ?? 3200;
  const perPort = opts.perPort ?? 2;
  const m = Math.floor(chart.n / COARSE);
  const cw = chart.worldW / m;
  const ch = chart.worldH / m;
  const M = m * m;
  // a coarse cell is water when every one of its texels is deep enough; beside land when a neighbour isn't
  const wet = new Uint8Array(M);
  for (let y = 0; y < m; y++)
    for (let x = 0; x < m; x++) {
      let ok = 1;
      for (let k = 0; k < COARSE * COARSE && ok; k++) if (chart.ground[(y * COARSE + Math.floor(k / COARSE)) * chart.n + x * COARSE + (k % COARSE)] >= chart.sea - SEA_DEPTH) ok = 0;
      wet[y * m + x] = ok;
    }
  const wrap = (x: number, y: number) => ((((y % m) + m) % m) * m + (((x % m) + m) % m)) | 0;
  const coast = new Uint8Array(M);
  for (let y = 0; y < m; y++)
    for (let x = 0; x < m; x++) {
      if (!wet[y * m + x]) continue;
      for (let d = 0; d < 8 && !coast[y * m + x]; d++) if (!wet[wrap(x + DX[d], y + DY[d])]) coast[y * m + x] = 1;
    }
  // each port's water: the nearest wet cell within 8 cells of it
  const start = ports.map((p) => {
    const px = Math.floor(p.at[0] / cw);
    const py = Math.floor(p.at[1] / ch);
    let best = -1;
    let bd = Infinity;
    for (let dy = -8; dy <= 8; dy++)
      for (let dx = -8; dx <= 8; dx++) {
        const c = wrap(px + dx, py + dy);
        const d = dx * dx + dy * dy;
        if (wet[c] && d <= 64 && d < bd) {
          bd = d;
          best = c;
        }
      }
    return best;
  });
  const portAt = new Map<number, number[]>();
  start.forEach((c, i) => c >= 0 && (portAt.get(c) ?? portAt.set(c, []).get(c)!).push(i));
  const routes: ShipRoute[] = [];
  const done = new Set<string>();
  const dist = new Float64Array(M);
  const from = new Int32Array(M);
  const maxCost = reach / Math.min(cw, ch);
  for (let i = 0; i < ports.length; i++) {
    const s0 = start[i];
    if (s0 < 0) continue;
    dist.fill(Infinity);
    from.fill(-1);
    dist[s0] = 0;
    const h = new Heap();
    h.push(0, s0);
    const found: number[] = [];
    while (h.size && found.length < perPort) {
      const [d, c] = h.pop();
      if (d > dist[c] || d > maxCost) continue;
      for (const j of portAt.get(c) ?? []) if (j !== i && !found.includes(j)) found.push(j);
      const x = c % m;
      const y = (c / m) | 0;
      for (let k = 0; k < 8; k++) {
        const n = wrap(x + DX[k], y + DY[k]);
        if (!wet[n]) continue;
        const nd = d + (k < 4 ? 1 : Math.SQRT2) * (coast[n] ? 2.5 : 1);
        if (nd < dist[n]) {
          dist[n] = nd;
          from[n] = c;
          h.push(nd, n);
        }
      }
    }
    for (const j of found) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      if (done.has(key)) continue;
      done.add(key);
      // back from j's water to i's: cells, unwrapped as it goes
      const cells: [number, number][] = [];
      let c = start[j];
      let ux = c % m;
      let uy = (c / m) | 0;
      cells.push([ux, uy]);
      while (c !== s0) {
        const p = from[c];
        let dx = (p % m) - (c % m);
        let dy = ((p / m) | 0) - ((c / m) | 0);
        dx -= Math.round(dx / m) * m;
        dy -= Math.round(dy / m) * m;
        ux += dx;
        uy += dy;
        cells.push([ux, uy]);
        c = p;
      }
      cells.reverse();
      const pts = pull(cells, (x, y) => wet[wrap(x, y)] === 1);
      const path = new Float32Array(pts.length * 2);
      let length = 0;
      pts.forEach(([x, y], k) => {
        path[k * 2] = (x + 0.5) * cw;
        path[k * 2 + 1] = (y + 0.5) * ch;
        if (k) length += Math.hypot(path[k * 2] - path[k * 2 - 2], path[k * 2 + 1] - path[k * 2 - 1]);
      });
      routes.push({ a: ports[i].id, b: ports[j].id, path, length });
    }
  }
  return routes;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** string-pulling: from each kept cell, on to the farthest later cell it sees in a straight line over water */
function pull(cells: [number, number][], ok: (x: number, y: number) => boolean): [number, number][] {
  const out: [number, number][] = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    for (; j > i + 1; j--) if (clear(cells[i], cells[j], ok)) break;
    out.push(cells[j]);
    i = j;
  }
  return out;
}

function clear(a: [number, number], b: [number, number], ok: (x: number, y: number) => boolean): boolean {
  // (four looks a cell: a straight run doesn't clip a corner of land)
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 4);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    // (the cells the point's neighbourhood touches: half a cell either way)
    for (const [dx, dy] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) if (!ok(Math.round(x + dx), Math.round(y + dy))) return false;
  }
  return true;
}

/** a ship on a route: when it set out, how fast, what it is */
interface Sailing {
  route: number;
  phase: number;
  speed: number;
  kind: Berth['kind'];
  length: number;
  seed: number;
}

/** a ship's rest in port at each end of its route (s) */
export const DWELL = 40;

/**
 * Where the sailing ships are: each route sailed by one ship (two on a long one), out and back with a rest in port at
 * each end; a pure function of the time.
 */
export class Fleet {
  private ships: Sailing[] = [];

  constructor(readonly routes: ShipRoute[], seed: number) {
    routes.forEach((r, i) => {
      const n = r.length > 1800 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const h = hash(seed, i, k);
        this.ships.push({ route: i, phase: h, speed: 4 + 2 * hash(seed, i, k + 7), kind: h < 0.6 ? 'cog' : 'sloop', length: 10 + 5 * hash(seed, i, k + 3), seed: hash(seed, i, k + 11) });
      }
    });
  }

  get count(): number {
    return this.ships.length;
  }

  /** every ship at time t (s): its middle (world x, y; z the sea's level), heading, length */
  at(t: number, sea: number): Berth[] {
    return this.ships.map((s) => {
      const r = this.routes[s.route];
      const leg = r.length / s.speed;
      const cycle = 2 * (leg + DWELL);
      const u = (((t / cycle + s.phase) % 1) + 1) % 1 * cycle;
      // out (0..leg), in port at b, back (leg+DWELL..2 leg+DWELL), in port at a
      let d: number;
      let back = false;
      if (u < leg) d = u * s.speed;
      else if (u < leg + DWELL) d = r.length;
      else if (u < 2 * leg + DWELL) {
        d = r.length - (u - leg - DWELL) * s.speed;
        back = true;
      } else d = 0;
      const [x, y, tx, ty] = along(r, d);
      const heading = Math.atan2(back ? -ty : ty, back ? -tx : tx);
      return { at: [x, y, sea], heading, length: s.length, kind: s.kind, seed: s.seed };
    });
  }
}

/** a point a distance along a route, and its tangent */
export function along(r: ShipRoute, d: number): [number, number, number, number] {
  const p = r.path;
  let s = 0;
  for (let k = 2; k < p.length; k += 2) {
    const L = Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    if (s + L >= d || k === p.length - 2) {
      const f = L > 0 ? Math.max(0, Math.min(1, (d - s) / L)) : 0;
      return [p[k - 2] + (p[k] - p[k - 2]) * f, p[k - 1] + (p[k + 1] - p[k - 1]) * f, (p[k] - p[k - 2]) / (L || 1), (p[k + 1] - p[k - 1]) / (L || 1)];
    }
    s += L;
  }
  return [p[0], p[1], 1, 0];
}

function hash(...k: number[]): number {
  let h = 2166136261;
  for (const v of k) h = Math.imul(h ^ (Math.floor(v * 1000) | 0), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
