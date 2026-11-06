// The road generator's CPU reference (round 128p, DA-A13 step 0): the same rounds as the GPU's (gpu.ts,
// shaders/roadgen.wgsl), for the unit tests and as the spec. Roads are evenly spaced streamlines (Jobard & Lefer),
// a family at a time (majors, then minors), in rounds:
//  - trace: every seed of the round, against the lines committed before the round (on the GPU: a thread a seed). Both
//    ways from the seed (RK2, `step` m) along the family's direction; it stops off the town (the domain, its edge), on
//    water, where the field has no direction, within half its family's spacing of a committed line of its family (ending
//    on that line if it lies straight ahead within half the spacing: a T-junction; a line alongside isn't joined), or
//    closing on its own seed (a ring). A seed itself that near a
//    line, off the town or wet, traces nothing;
//  - commit: the round's lines in seed order (on the GPU: one thread) — each against the lines committed before it this
//    round, ended where it comes within half the spacing of one (joined to it as a trace is); a line shorter than the spacing is
//    no street, dropped;
//  - seeds: from each line committed this round, every spacing along it, a spacing to either side; of those in the
//    town and clear of the family's lines, one a seed bucket (half a spacing square; the least key wins: line, point,
//    side), in bucket order.
// The first round's seeds: majors the centre and the constraints' points every spacing (the constraints are committed
// majors, fixed); minors the major roads' points every minor spacing (minors cross majors).
// An edit (`edit`): the lines through its rectangle dropped, the field there made again, the rounds run again from
// their seeds and the new constraints', against the lines kept.
import { dirAt, fieldAt, fieldOf, groundAt, inside, latticeSize, maxRounds, maxSteps, ROAD_GRADE, spacing, wetAt, type Polyline, type Road, type RoadGenInput, type RoadGenParams, type V2 } from './roadgen';

interface Entry {
  x: number;
  y: number;
  round: number;
}

/** a family's committed points, bucketed half a spacing square (a 3 x 3 look holds any point within half a spacing) */
class SepGrid {
  private cells = new Map<number, Entry[]>();
  private bw: number;
  private b: number;
  constructor(
    p: RoadGenParams,
    readonly d: number,
  ) {
    this.b = d / 2;
    this.bw = Math.ceil(p.W / this.b) + 1;
  }
  private key(bx: number, by: number): number {
    return by * this.bw + bx;
  }
  add(x: number, y: number, round: number): void {
    const k = this.key(Math.floor(x / this.b), Math.floor(y / this.b));
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push({ x, y, round });
  }
  /** the nearest entry within r (of round `only` if given) — least distance, then first added */
  nearest(x: number, y: number, r: number, only?: number): Entry | null {
    const bx = Math.floor(x / this.b);
    const by = Math.floor(y / this.b);
    let best: Entry | null = null;
    let bd = r * r;
    for (let j = by - 1; j <= by + 1; j++)
      for (let i = bx - 1; i <= bx + 1; i++) {
        if (i < 0 || j < 0) continue;
        for (const e of this.cells.get(this.key(i, j)) ?? []) {
          if (only !== undefined && e.round !== only) continue;
          const dd = (e.x - x) ** 2 + (e.y - y) ** 2;
          if (dd < bd) ((bd = dd), (best = e));
        }
      }
    return best;
  }
}

interface Trace {
  pts: V2[];
  seedIdx: number;
  seed: V2;
}

export class RoadGenCpu {
  readonly roads: Road[] = [];
  field: Float32Array;
  private grids: [SepGrid, SepGrid];

  constructor(readonly inp: RoadGenInput) {
    this.field = fieldOf(inp);
    this.grids = [new SepGrid(inp.params, inp.params.major), new SepGrid(inp.params, inp.params.minor)];
  }

  /** the whole town's roads */
  run(): Road[] {
    for (const c of this.inp.constraints) this.addFixed(c);
    this.family(0, this.firstMajorSeeds(this.inp.constraints));
    this.family(1, this.minorSeeds(null));
    return this.roads;
  }

  /**
   * An edit: `constraints` added (drawn roads) — the field made again in their reach, the lines through `rect` [x0, y0,
   * x1, y1] dropped and traced again from their seeds and the constraints', against the lines kept.
   */
  edit(add: Polyline[], rect: [number, number, number, number]): Road[] {
    const p = this.inp.params;
    this.inp.constraints.push(...add);
    const { nx, ny } = latticeSize(p);
    const [x0, y0, x1, y1] = rect;
    for (let j = Math.max(0, Math.floor(y0 / p.S)); j <= Math.min(ny - 1, Math.ceil(y1 / p.S)); j++)
      for (let i = Math.max(0, Math.floor(x0 / p.S)); i <= Math.min(nx - 1, Math.ceil(x1 / p.S)); i++) fieldAt(this.inp, i, j, this.field);
    const inRect = (q: V2) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
    const kept = this.roads.filter((r) => r.fixed || !r.pts.some(inRect));
    const dropped = this.roads.filter((r) => !kept.includes(r));
    this.roads.length = 0;
    this.grids = [new SepGrid(p, p.major), new SepGrid(p, p.minor)];
    for (const r of kept) {
      this.roads.push(r);
      for (const q of r.pts) this.grids[r.family].add(q[0], q[1], -1);
    }
    for (const c of add) this.addFixed(c);
    const seeds0 = [...this.firstMajorSeeds(add), ...dropped.filter((r) => r.family === 0).map((r) => r.seed)];
    this.family(0, seeds0);
    this.family(1, [...this.minorSeeds(inRect), ...dropped.filter((r) => r.family === 1).map((r) => r.seed)]);
    return this.roads;
  }

  private addFixed(c: Polyline): void {
    const pts = resample(c, this.inp.params.step);
    this.roads.push({ family: 0, pts, steep: this.steepOf(pts), seed: pts[0], fixed: true });
    for (const q of pts) this.grids[0].add(q[0], q[1], -1);
  }

  private firstMajorSeeds(cons: Polyline[]): V2[] {
    const p = this.inp.params;
    const out: V2[] = [[p.centre[0], p.centre[1]]];
    for (const c of cons) out.push(...everyAlong(resample(c, p.step), Math.round(p.major / p.step)).map(({ at }) => at));
    return out;
  }

  /** points on the major roads every minor spacing (only those `near` asks for, given) */
  private minorSeeds(near: ((q: V2) => boolean) | null): V2[] {
    const p = this.inp.params;
    const out: V2[] = [];
    for (const r of this.roads) if (r.family === 0) for (const { at } of everyAlong(r.pts, Math.round(p.minor / p.step))) if (!near || near(at)) out.push(at);
    return out;
  }

  private family(f: 0 | 1, first: V2[]): void {
    const p = this.inp.params;
    const clear = (c: { at: V2 }) => !this.grids[f].nearest(c.at[0], c.at[1], spacing(p, f) / 2);
    let seeds = dedup(p, spacing(p, f), first.map((s, k) => ({ at: s, key: k })).filter(clear));
    const R = maxRounds(p, f);
    for (let round = 0; round < R && seeds.length; round++) {
      const traces = seeds.map((s) => this.trace(s, f));
      const made: Road[] = [];
      for (const t of traces) {
        if (!t) continue;
        const r = this.commit(t, f, round);
        if (r) made.push(r);
      }
      const cand: { at: V2; key: number }[] = [];
      const d = spacing(p, f);
      const every = Math.round(d / p.step);
      made.forEach((r, li) => {
        for (const { at, k, t } of everyAlong(r.pts, every)) {
          const n: V2 = [-t[1], t[0]];
          for (let side = 0; side < 2; side++) {
            const sg = side ? -1 : 1;
            cand.push({ at: [at[0] + n[0] * d * sg, at[1] + n[1] * d * sg], key: (li * 65536 + k) * 2 + side });
          }
        }
      });
      seeds = dedup(p, d, cand.filter(clear));
    }
  }

  private trace(seed: V2, f: number): Trace | null {
    const p = this.inp.params;
    const d = spacing(p, f);
    const dt = d / 2;
    const g = this.grids[f];
    if (!inside(p, seed[0], seed[1]) || wetAt(p, this.inp.wet, seed[0], seed[1])) return null;
    if (g.nearest(seed[0], seed[1], dt)) return null;
    const d0 = dirAt(p, this.field, f, seed[0], seed[1]);
    if (!d0) return null;
    const N = maxSteps(p);
    const half = (sign: number): V2[] => {
      const out: V2[] = [];
      let cur: V2 = seed;
      let prev: V2 = [d0[0] * sign, d0[1] * sign];
      for (let n = 0; n < N; n++) {
        const d1 = align(dirAt(p, this.field, f, cur[0], cur[1]), prev);
        if (!d1) break;
        const mid: V2 = [cur[0] + (d1[0] * p.step) / 2, cur[1] + (d1[1] * p.step) / 2];
        const d2 = align(dirAt(p, this.field, f, mid[0], mid[1]), d1);
        if (!d2) break;
        const nxt: V2 = [cur[0] + d2[0] * p.step, cur[1] + d2[1] * p.step];
        if (!inside(p, nxt[0], nxt[1]) || wetAt(p, this.inp.wet, nxt[0], nxt[1])) break;
        if (g.nearest(nxt[0], nxt[1], dt)) {
          const j = this.ahead(g, cur, d2, dt);
          if (j) out.push(j);
          break;
        }
        if ((n + 1) * p.step > 2 * d && Math.hypot(nxt[0] - seed[0], nxt[1] - seed[1]) < dt) {
          out.push([seed[0], seed[1]]);
          break;
        }
        out.push(nxt);
        prev = d2;
        cur = nxt;
      }
      return out;
    };
    const fwd = half(1);
    const back = half(-1);
    return { pts: [...back.reverse(), seed, ...fwd], seedIdx: back.length, seed };
  }

  private commit(t: Trace, f: 0 | 1, round: number): Road | null {
    const p = this.inp.params;
    const d = spacing(p, f);
    const g = this.grids[f];
    const s = t.pts[t.seedIdx];
    if (g.nearest(s[0], s[1], d / 2, round)) return null;
    // (where it comes too near, it ends: on the line it meets if that lies straight ahead within half a spacing)
    const ending = (k: number, back: number): boolean => {
      if (!g.nearest(t.pts[k][0], t.pts[k][1], d / 2, round)) return false;
      const a = t.pts[k - back];
      const b = t.pts[k - 2 * back] ?? t.pts[k - back];
      const L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const j = this.ahead(g, a, [(a[0] - b[0]) / L, (a[1] - b[1]) / L], d / 2, round);
      if (j) t.pts[k] = j;
      return true;
    };
    let hi = t.pts.length;
    for (let k = t.seedIdx + 1; k < t.pts.length; k++)
      if (ending(k, 1)) {
        hi = this.lastJoined ? k + 1 : k;
        break;
      }
    let lo = 0;
    for (let k = t.seedIdx - 1; k >= 0; k--)
      if (ending(k, -1)) {
        lo = this.lastJoined ? k : k + 1;
        break;
      }
    const pts = t.pts.slice(lo, hi);
    let arc = 0;
    for (let k = 1; k < pts.length; k++) arc += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (arc < d) return null;
    for (const q of pts) g.add(q[0], q[1], round);
    const r: Road = { family: f, pts, steep: this.steepOf(pts), seed: t.seed };
    this.roads.push(r);
    return r;
  }

  /** whether the last `ahead` joined a line */
  private lastJoined = false;

  /**
   * Where a line ending near another meets it: straight on from `from` along `dir`, a step at a time up to `r`, the first
   * committed point (of round `only`, given) within a step — a T-junction; null (it just ends) if none: a line running
   * alongside another doesn't cross to it.
   */
  private ahead(g: SepGrid, from: V2, dir: V2, r: number, only?: number): V2 | null {
    const p = this.inp.params;
    this.lastJoined = false;
    for (let t = p.step; t <= r + 1e-9; t += p.step) {
      const h = g.nearest(from[0] + dir[0] * t, from[1] + dir[1] * t, p.step, only);
      if (h) {
        this.lastJoined = true;
        return [h.x, h.y];
      }
    }
    return null;
  }

  private steepOf(pts: V2[]): boolean[] {
    const p = this.inp.params;
    return pts.map((q, k) => {
      if (k === 0) return false;
      const L = Math.hypot(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1]);
      return L > 0 && Math.abs(groundAt(p, this.inp.ground, q[0], q[1]) - groundAt(p, this.inp.ground, pts[k - 1][0], pts[k - 1][1])) / L > ROAD_GRADE;
    });
  }
}

/** the direction (or its reverse) that goes on from `prev` */
function align(d: V2 | null, prev: V2): V2 | null {
  if (!d) return null;
  return d[0] * prev[0] + d[1] * prev[1] < 0 ? [-d[0], -d[1]] : d;
}

/** one seed a bucket (half a spacing square), the least key; in bucket order */
function dedup(p: RoadGenParams, d: number, cand: { at: V2; key: number }[]): V2[] {
  const b = d / 2;
  const bw = Math.ceil(p.W / b) + 1;
  const win = new Map<number, { at: V2; key: number }>();
  for (const c of cand) {
    if (!inside(p, c.at[0], c.at[1])) continue;
    const k = Math.floor(c.at[1] / b) * bw + Math.floor(c.at[0] / b);
    const w = win.get(k);
    if (!w || c.key < w.key) win.set(k, c);
  }
  return [...win.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c.at);
}

/** a polyline's points every `every` points, with the tangent there */
export function everyAlong(pts: V2[], every: number): { at: V2; k: number; t: V2 }[] {
  const out: { at: V2; k: number; t: V2 }[] = [];
  for (let k = 0; k < pts.length; k += Math.max(1, every)) {
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(pts.length - 1, k + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.push({ at: pts[k], k, t: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] });
  }
  return out;
}

/** a polyline's points every `step` m along it */
export function resample(line: Polyline, step: number): V2[] {
  const out: V2[] = [[line[0][0], line[0][1]]];
  let carry = 0;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= L) {
      out.push([a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L]);
      t += step;
    }
    carry = L - (t - step);
  }
  return out;
}
