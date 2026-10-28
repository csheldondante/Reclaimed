// ---- atlas/ways.ts --------------------------------------------------------
// The roads and their crossings built into the columns (round 79, BACKLOG V2's first part: "vertical
// cities, ramps and roads, lifts, switchbacks, or tunnels intentionally stamped at the region level").
// sites.ts finds the roads on a coarse grid (32 world units a step) and where each crosses something;
// here each road becomes a way — its path smoothed (Chaikin) and sampled every STEP, its height graded
// over the ground (no steeper than GRADE: cuts and fills), and what each stretch is:
//   road        cut or filled to the grade, a shoulder of 1:1 back to the ground either side
//   tunnel      where the grade runs TUNNEL under the ground: a bore, the rock kept over it
//   bridge      where it runs BRIDGE over it: a deck, pillars to the ground every PILLAR
//   switchbacks the atlas's crossing: the stretch a zig-zag of legs across the fall line (each column
//               between them takes its nearest leg's shoulder: terraces)
//   lift        the atlas's crossing: a tower from the foot to the top, the way a deck from it at the top
// and each site a plaza: a flat disc at its ground. Stamped into a region's columns as they're made
// (Atlas.regionLand): every column takes its nearest way's point within reach.

import { CROSS, type Settlement } from './sites';
import { addTop, lowerTop, type Interval } from '../world/layout';

export const WAY = { road: 0, tunnel: 1, bridge: 2, switchbacks: 3, lift: 4, plaza: 5 } as const;
export const WAY_NAMES = ['road', 'tunnel', 'bridge', 'switchbacks', 'lift', 'plaza'];

/** world units between a way's points */
const STEP = 2;
/** steepest grade (rise per run) */
const GRADE = 0.22;
/** half a way's width */
const HALF = 2.2;
/** how far the graded height may run under / over the ground before it's a tunnel / a bridge */
const TUNNEL = 7;
const BRIDGE = 4;
/** a tunnel's height; a deck's thickness; pillars every this many points */
const BORE = 5;
const DECK = 1.2;
const PILLAR = 7;
/** a switchback leg's length across the fall line */
const LEG = 26;
/** how far a column looks for a way (the shoulders reach this far) */
const REACH = 26;
/** the bins the points are found by (world units) */
const BIN = 64;

const MAT_PAVE = 11;
const MAT_FILL = 2;
const MAT_BUILT = 5;

export interface WayPoint {
  x: number;
  y: number;
  z: number;
  kind: number;
  /** the way it's on and its index along it (pillars) */
  way: number;
  i: number;
}

export interface Lift {
  x: number;
  y: number;
  z0: number;
  z1: number;
}

export interface Ways {
  points: WayPoint[];
  lifts: Lift[];
  /** per bin key, the points in it */
  bins: Map<number, number[]>;
  /** per kind, points of it */
  counts: number[];
  ms: number;
}

export interface WayInput {
  settlement: Settlement;
  /** the ground at a world point (the atlas's macro heights, bilinear, wrapping) */
  ground: (x: number, y: number) => number;
  worldW: number;
  worldH: number;
  sea: number;
}

/** a world delta wrapped to the nearest turn of the torus */
const wrapD = (d: number, P: number) => d - Math.round(d / P) * P;

export function buildWays(inp: WayInput): Ways {
  const t0 = performance.now();
  const { settlement: st, ground, worldW: W, worldH: H, sea } = inp;
  const points: WayPoint[] = [];
  const lifts: Lift[] = [];
  // (round 102: heights to 1/256 of a cell, as the columns' runs are — the CPU's stamp and the GPU's (finish.wgsl)
  // then work in the same whole numbers)
  const add = (p: Omit<WayPoint, 'way' | 'i'>, way: number, i: number) => points.push({ ...p, z: qz(p.z), way, i });

  st.roads.forEach((road, wi) => {
    // the path unwrapped (consecutive points nearest each other on the torus), smoothed, resampled
    const raw: [number, number][] = [];
    for (let k = 0; k < road.path.length; k += 2) {
      const x = road.path[k];
      const y = road.path[k + 1];
      if (!raw.length) raw.push([x, y]);
      else {
        const [px, py] = raw[raw.length - 1];
        raw.push([px + wrapD(x - px, W), py + wrapD(y - py, H)]);
      }
    }
    if (raw.length < 2) return;
    let sm = raw;
    for (let it = 0; it < 3; it++) {
      const o: [number, number][] = [sm[0]];
      for (let k = 0; k + 1 < sm.length; k++) {
        const [ax, ay] = sm[k];
        const [bx, by] = sm[k + 1];
        o.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      }
      o.push(sm[sm.length - 1]);
      sm = o;
    }
    const P = resample(sm, STEP);
    const n = P.length;
    // the ground under it, smoothed along it (a way doesn't follow every bump)
    const g = P.map(([x, y]) => ground(x, y));
    const z = g.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) {
        s += g[k];
        c++;
      }
      return s / c;
    });
    // the atlas's lifts and switchbacks: their stretches (between the points nearest their ends) are free
    // of the grade — the drop is the structure's
    const kind = new Uint8Array(n);
    const free = new Uint8Array(n);
    const near = (x: number, y: number) => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(wrapD(P[i][0] - x, W), wrapD(P[i][1] - y, H));
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const spans: { a: number; b: number; kind: number }[] = [];
    for (const c of road.crossings) {
      if (c.kind !== CROSS.lift && c.kind !== CROSS.switchbacks) continue;
      let a = near(c.x0, c.y0);
      let b = near(c.x1, c.y1);
      if (a > b) [a, b] = [b, a];
      if (b - a < 2) continue;
      spans.push({ a, b, kind: c.kind === CROSS.lift ? WAY.lift : WAY.switchbacks });
      for (let i = a; i <= b; i++) free[i] = 1;
      // (each end at its ground)
      z[a] = g[a];
      z[b] = g[b];
    }
    // the grade: forward and back, the free stretches skipped
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 1; k < n; k++) {
        const i = pass === 0 ? k : n - 1 - k;
        const j = pass === 0 ? i - 1 : i + 1;
        if (free[i] && free[j]) continue;
        z[i] = Math.min(Math.max(z[i], z[j] - GRADE * STEP), z[j] + GRADE * STEP);
      }
    }
    for (let i = 0; i < n; i++) z[i] = Math.max(z[i], sea + 1);
    for (let i = 0; i < n; i++) kind[i] = z[i] < g[i] - TUNNEL ? WAY.tunnel : z[i] > g[i] + BRIDGE ? WAY.bridge : WAY.road;
    // (no flicker: a stretch shorter than four points takes its neighbours' kind)
    let s0 = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && kind[i] === kind[s0]) continue;
      if (i - s0 < 4 && s0 > 0) for (let k = s0; k < i; k++) kind[k] = kind[s0 - 1];
      s0 = i;
    }
    // the free stretches
    for (const sp of spans) {
      const za = z[sp.a];
      const zb = z[sp.b];
      if (sp.kind === WAY.lift) {
        // the tower at the cliff's foot (the lowest ground along the stretch), the way level with the
        // top from it to the high end, on the ground from the low end to it
        const hi = za < zb ? sp.b : sp.a;
        let lo = sp.a;
        for (let i = sp.a; i <= sp.b; i++) if (g[i] < g[lo]) lo = i;
        const ztop = z[hi];
        lifts.push({ x: P[lo][0], y: P[lo][1], z0: g[lo], z1: ztop });
        for (let i = sp.a; i <= sp.b; i++) {
          const up = hi > lo ? i >= lo : i <= lo;
          z[i] = up ? ztop : Math.max(g[i], sea + 1);
          kind[i] = up && z[i] > g[i] + BRIDGE ? WAY.bridge : WAY.lift;
        }
        continue;
      }
      // switchbacks: legs across the fall line, hairpins at their ends, climbing evenly
      const [ax, ay] = P[sp.a];
      const [bx, by] = P[sp.b];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const d = [dx / len, dy / len];
      const e = [-d[1], d[0]];
      const legs = Math.max(2, Math.ceil(Math.abs(zb - za) / (GRADE * LEG)));
      const adv = Math.max(len / legs, 5);
      const verts: [number, number][] = [[ax, ay]];
      for (let k = 0; k <= legs; k++) {
        const side = k % 2 === 0 ? -LEG / 2 : LEG / 2;
        verts.push([ax + d[0] * adv * k + e[0] * side, ay + d[1] * adv * k + e[1] * side]);
      }
      verts.push([ax + d[0] * adv * legs, ay + d[1] * adv * legs]);
      const Z = resample(verts, STEP);
      Z.forEach(([x, y], k) => add({ x, y, z: za + ((zb - za) * k) / Math.max(Z.length - 1, 1), kind: WAY.switchbacks }, wi, k));
    }
    for (let i = 0; i < n; i++) {
      if (free[i] && kind[i] !== WAY.lift && kind[i] !== WAY.bridge) continue;
      add({ x: P[i][0], y: P[i][1], z: z[i], kind: kind[i] }, wi, i);
    }
  });

  // the plazas: a disc of points at each site's ground
  st.sites.forEach((s, si) => {
    const r = 5 + 3 * s.size;
    const z = Math.max(ground(s.x, s.y), sea + 1);
    for (let yy = -r; yy <= r; yy += STEP)
      for (let xx = -r; xx <= r; xx += STEP) if (xx * xx + yy * yy <= r * r) add({ x: s.x + xx, y: s.y + yy, z, kind: WAY.plaza }, -1 - si, 0);
  });

  // wrapped into the world, binned
  const bins = new Map<number, number[]>();
  const counts = [0, 0, 0, 0, 0, 0];
  points.forEach((p, k) => {
    p.x = ((p.x % W) + W) % W;
    p.y = ((p.y % H) + H) % H;
    const key = binKey(Math.floor(p.x / BIN), Math.floor(p.y / BIN));
    let b = bins.get(key);
    if (!b) bins.set(key, (b = []));
    b.push(k);
    counts[p.kind]++;
  });
  for (const l of lifts) {
    l.x = ((l.x % W) + W) % W;
    l.y = ((l.y % H) + H) % H;
    l.z0 = qz(l.z0);
    l.z1 = qz(l.z1);
  }
  return { points, lifts, bins, counts, ms: +(performance.now() - t0).toFixed(1) };
}

const binKey = (bx: number, by: number) => by * 65536 + bx;

/** a polyline resampled every `step` along it */
function resample(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [pts[0]];
  let carry = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const L = Math.hypot(bx - ax, by - ay);
    let s = step - carry;
    while (s <= L) {
      out.push([ax + ((bx - ax) * s) / L, ay + ((by - ay) * s) / L]);
      s += step;
    }
    carry = L - (s - step);
  }
  const last = pts[pts.length - 1];
  const o = out[out.length - 1];
  if (Math.hypot(last[0] - o[0], last[1] - o[1]) > step * 0.3) out.push(last);
  return out;
}

/** the solid of a column between a and b taken out */
function carve(col: Interval[], a: number, b: number): void {
  const out: Interval[] = [];
  for (const iv of col) {
    if (iv.z1 <= a || iv.z0 >= b) out.push(iv);
    else {
      if (iv.z0 < a) out.push({ ...iv, z1: a });
      if (iv.z1 > b) out.push({ ...iv, z0: b });
    }
  }
  col.length = 0;
  col.push(...out);
}

const topOf = (col: Interval[]) => (col.length ? col[col.length - 1].z1 : 0);

/** (round 102) heights in whole 1/256ths of a cell — the columns' runs' (forms.wgsl zq) */
export const ZQ = 256;
export const qz = (z: number) => Math.round(z * ZQ) / ZQ;

/** (round 102) the stamp's lengths in 1/256ths (finish.wgsl's own: the same whole numbers) */
export const WQ = {
  reach: REACH * ZQ,
  half: Math.round(HALF * ZQ),
  tunnelReach: Math.round((HALF + 0.8) * ZQ),
  bare: Math.round((HALF + 0.5) * ZQ),
  pillar: Math.round(1.3 * ZQ),
  lift: Math.round(3.5 * ZQ),
  bore: BORE * ZQ,
  deck: Math.round(DECK * ZQ),
  pave: Math.round(0.4 * ZQ),
  still: Math.round(0.05 * ZQ),
} as const;

/** the floor of a whole number's square root (exact: n < 2^52) */
export const isqrt = (n: number) => Math.floor(Math.sqrt(n));

/**
 * (round 102) What a region's columns need of the ways, in the region's frame (from world(x0, y0)) in whole 1/256ths of
 * a world unit: the points near it (x, y, z, kind | pillar << 8: a pillar every PILLAR points), binned REACH apart
 * (nb × mb bins, row-major; each bin's points in order: binStart, binItems), the lifts in reach (x, y, z1, 0), and
 * each row's centre (x of its first column, y). The CPU's stamp (stampWays) and the GPU's (atlas/finish.wgsl) read the
 * same numbers in the same order, so they make the same columns. Null: no way near.
 */
export interface RegionWays {
  pts: Int32Array;
  nb: number;
  mb: number;
  binStart: Uint32Array;
  binItems: Uint32Array;
  lifts: Int32Array;
  /** per row: its first column's centre x, its centre y */
  rows: Int32Array;
}

export function regionWays(ways: Ways, x0: number, y0: number, w: number, h: number, world: (cx: number, cy: number) => [number, number], W: number, H: number): RegionWays | null {
  // the points near the region
  const [ax, ay] = world(x0, y0);
  const [bx, by] = world(x0 + w, y0 + h);
  const cand: number[] = [];
  const b0x = Math.floor((ax - REACH) / BIN);
  const b1x = Math.floor((bx + REACH) / BIN);
  const b0y = Math.floor((ay - REACH) / BIN);
  const b1y = Math.floor((by + REACH) / BIN);
  const nbx = Math.ceil(W / BIN);
  const nby = Math.ceil(H / BIN);
  for (let j = b0y; j <= b1y; j++)
    for (let i = b0x; i <= b1x; i++) {
      const b = ways.bins.get(binKey(((i % nbx) + nbx) % nbx, ((j % nby) + nby) % nby));
      if (b) cand.push(...b);
    }
  if (!cand.length) return null;
  // (round 80: the candidates binned REACH apart in the region's own frame — a column looks at the nine
  // bins round it, not every point near the region: 18 ms a region was a phone's hitch several times over)
  const RQ = WQ.reach;
  const nb = Math.ceil((bx - ax + 2 * REACH) / REACH) + 1;
  const mb = Math.ceil((by - ay + 2 * REACH) / REACH) + 1;
  const bins: number[][] = Array.from({ length: nb * mb }, () => []);
  const pts = new Int32Array(cand.length * 4);
  let n = 0;
  for (const k of cand) {
    const p = ways.points[k];
    const lx = Math.round(wrapD(p.x - ax, W) * ZQ);
    const ly = Math.round(wrapD(p.y - ay, H) * ZQ);
    const i = Math.floor((lx + RQ) / RQ);
    const m = Math.floor((ly + RQ) / RQ);
    if (i < 0 || m < 0 || i >= nb || m >= mb) continue;
    pts.set([lx, ly, Math.round(p.z * ZQ), p.kind | (p.i % PILLAR === 0 ? 256 : 0)], n * 4);
    bins[m * nb + i].push(n);
    n++;
  }
  const binStart = new Uint32Array(nb * mb + 1);
  const binItems = new Uint32Array(Math.max(n, 1));
  let o = 0;
  bins.forEach((b, k) => {
    binStart[k] = o;
    for (const j of b) binItems[o++] = j;
  });
  binStart[nb * mb] = o;
  // (the lifts within reach of the region, in its frame)
  const lf: number[] = [];
  for (const l of ways.lifts) {
    const x = wrapD(l.x - ax, W);
    const y = wrapD(l.y - ay, H);
    if (x > -4 && x < bx - ax + 4 && y > -4 && y < by - ay + 4) lf.push(Math.round(x * ZQ), Math.round(y * ZQ), Math.round(l.z1 * ZQ), 0);
  }
  const rows = new Int32Array(h * 2);
  for (let y = 0; y < h; y++) {
    const [cx, cy] = world(x0, y0 + y);
    rows[y * 2] = Math.round((cx - ax) * ZQ);
    rows[y * 2 + 1] = Math.round((cy - ay) * ZQ);
  }
  return { pts: pts.slice(0, n * 4), nb, mb, binStart, binItems, lifts: new Int32Array(lf), rows };
}

/** (round 102) column (x, y)'s nearest way point (an index into rw.pts, -1: none within REACH) and its distance² (1/256ths) */
export function nearestWay(rw: RegionWays, x: number, y: number): [number, number] {
  const RQ = WQ.reach;
  const cx = rw.rows[y * 2] + x * ZQ;
  const cy = rw.rows[y * 2 + 1];
  let best = -1;
  let bd = RQ * RQ;
  const bi = Math.floor((cx + RQ) / RQ);
  const bm = Math.floor((cy + RQ) / RQ);
  const { pts, nb, mb, binStart, binItems } = rw;
  for (let m = Math.max(0, bm - 1); m <= Math.min(mb - 1, bm + 1); m++)
    for (let i = Math.max(0, bi - 1); i <= Math.min(nb - 1, bi + 1); i++) {
      const b = m * nb + i;
      for (let q = binStart[b]; q < binStart[b + 1]; q++) {
        const j = binItems[q];
        const dx = pts[j * 4] - cx;
        const dy = pts[j * 4 + 1] - cy;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
    }
  return [best, bd];
}

/**
 * The ways into a region's columns (world cell x0, y0; w × h): each column takes its nearest way point
 * within REACH. `world(cx, cy)` is a cell's world centre. Returns the columns changed. (Round 102: in whole 1/256ths,
 * as atlas/finish.wgsl stamps them on the GPU — regionWays, nearestWay, wayColumn.)
 */
export function stampWays(
  ways: Ways,
  land: { cols: Interval[][]; surface: Float32Array; vegetation: Float32Array; ground?: Float32Array; water: Float32Array },
  x0: number,
  y0: number,
  w: number,
  h: number,
  world: (cx: number, cy: number) => [number, number],
  W: number,
  H: number,
  rw = regionWays(ways, x0, y0, w, h, world, W, H),
): number {
  if (!rw) return 0;
  let changed = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const col = land.cols[i];
      const [best, bd] = nearestWay(rw, x, y);
      if (!wayColumn(rw, col, x, y, best, bd)) continue;
      changed++;
      land.surface[i] = topOf(col);
      if (land.ground) land.ground[i] = topOf(col);
      if (bd <= WQ.bare * WQ.bare) land.vegetation[i] = 0;
    }
  return changed;
}

/** (round 102) a column's way (its nearest point `best`, distance² `bd`) and lifts stamped into it: whether it did */
export function wayColumn(rw: RegionWays, col: Interval[], x: number, y: number, best: number, bd: number): boolean {
  const Q = ZQ;
  const cx = rw.rows[y * 2] + x * Q;
  const cy = rw.rows[y * 2 + 1];
  let did = false;
  // a lift's tower
  const L = rw.lifts;
  for (let k = 0; k < L.length; k += 4) {
    const dx = L[k] - cx;
    const dy = L[k + 1] - cy;
    if (dx * dx + dy * dy > WQ.lift * WQ.lift) continue;
    const top = topOf(col);
    const z1 = L[k + 2] / Q;
    if (top < z1) addTop(col, z1 - top, MAT_BUILT);
    did = true;
  }
  if (best < 0 || did) return did;
  const P = rw.pts;
  const pz = P[best * 4 + 2] / Q;
  const kind = P[best * 4 + 3] & 255;
  const pillar = (P[best * 4 + 3] & 256) !== 0;
  const top = topOf(col);
  const in2 = (r: number) => bd <= r * r;
  if (kind === WAY.tunnel) {
    if (in2(WQ.tunnelReach) && top > pz + (WQ.bore + Q) / Q) {
      carve(col, pz, pz + WQ.bore / Q);
      did = true;
    }
  } else if (kind === WAY.bridge || (kind === WAY.lift && top < pz - (WQ.deck + Q) / Q)) {
    if (in2(WQ.half) && top < pz - (WQ.deck + Q / 2) / Q) {
      // the deck (a pillar under it every PILLAR points)
      if (pillar && in2(WQ.pillar)) addTop(col, pz - top, MAT_BUILT);
      else col.push({ z0: pz - WQ.deck / Q, z1: pz, mat: MAT_BUILT });
      did = true;
    } else if (in2(WQ.half) && top <= pz + 1) {
      // (where the ground comes up to the deck: a road)
      fillTo(col, pz, true);
      did = true;
    }
  } else {
    // a road, a plaza, switchbacks: the grade on it, a 1:1 shoulder back to the ground
    const on = in2(WQ.half);
    const off = Math.max(isqrt(bd) - WQ.half, 0) / Q;
    const T = on ? pz : pz + Math.max(-off, Math.min(off, top - pz));
    if (Math.abs(T - top) * Q >= WQ.still || on) {
      fillTo(col, T, on);
      did = true;
    }
  }
  return did;
}

/**
 * (round 94) The ways stampWays would look at for a box of world units (ax, ay)–(bx, by): its bins and their points
 * alone, renumbered (all the lifts) — small enough to hand to a worker (settle/plan-worker.ts).
 */
export function waysNear(ways: Ways, ax: number, ay: number, bx: number, by: number, W: number, H: number): Ways {
  const nbx = Math.ceil(W / BIN);
  const nby = Math.ceil(H / BIN);
  const points: WayPoint[] = [];
  const bins = new Map<number, number[]>();
  for (let j = Math.floor((ay - REACH) / BIN); j <= Math.floor((by + REACH) / BIN); j++)
    for (let i = Math.floor((ax - REACH) / BIN); i <= Math.floor((bx + REACH) / BIN); i++) {
      const key = binKey(((i % nbx) + nbx) % nbx, ((j % nby) + nby) % nby);
      const b = ways.bins.get(key);
      if (!b || bins.has(key)) continue;
      bins.set(key, b.map((k) => points.push(ways.points[k]) - 1));
    }
  return { points, lifts: ways.lifts, bins, counts: ways.counts, ms: 0 };
}

/** cut or fill a column's top to T (fill of soil); paved on top when `pave` */
function fillTo(col: Interval[], T: number, pave: boolean): void {
  const top = topOf(col);
  if (T < top) lowerTop(col, top - T);
  else if (T > top) addTop(col, T - top, MAT_FILL);
  if (pave) {
    lowerTop(col, WQ.pave / ZQ);
    addTop(col, WQ.pave / ZQ, MAT_PAVE);
  }
}
