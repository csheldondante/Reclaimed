// The fortress's reach: what a check asks and answers (the GPU's — reachgpu.ts, shaders/fortreach.wgsl — in the game),
// and the CPU reference of the same solve, for unit tests only (round 128l, m4: it stands in for the GPU where there's
// none, with the same answers).
//
// The rules (keep them in step with fortreach.wgsl, and its constants with agents.wgsl):
//  - surfaces: each column's solid runs (and the plan's spans as if built) merged where they touch, a surface on top of
//    each with AGENT_H of room over it, the highest NAV_K of them; the top one deep under water over DEEP;
//  - two surfaces of neighbouring columns join when a walker steps either way between them: a rise within STEP, AGENT_H
//    of room over the step, both deep or both dry;
//  - a place is reached when a stand's top surface is in the stores' component. Why not: the solve again with deep
//    water no bar (reached then: deep water), then with the plan's solid left out (reached then: walled in by the plan);
//    neither, a cliff.
import { nbr } from '../world/lattice';

/** agents.wgsl's */
export const AGENT_H = 1.5;
export const STEP = 1.1;
export const DROP = 2.6;
export const DEEP = 0.9;
export const NAV_K = 4;
/** fortress.ts LANE_WATER */
const LANE_WATER = 0.8;

/** fortreach.wgsl RAMP_CAP: the ramp spots an answer holds */
export const RAMP_CAP = 64;

/** a query's answer bits: reached; reached with deep water no bar; reached with the plan's solid left out; no stand */
export const REACH_BITS = { reached: 1, dry: 2, unplanned: 8, none: 16 } as const;

/** what a check asks (box-local columns: x + y * box w) */
export interface ReachAsk {
  /** the stores' box column (x, y); null: none in the box */
  stores: [number, number] | null;
  /** per query up to four box columns (its stands); -1 none */
  queries: Int32Array;
  /** the wet columns too (the lanes) */
  wet: boolean;
  /** why the queries not reached aren't (the solve again with each rule lifted: an edit to judge) */
  why?: boolean;
}

export interface ReachReply {
  /** per query REACH_BITS (dry and unplanned only when asked why) */
  bits: Uint32Array;
  /** box columns under a drop up to the stores' ground (a ramp there joins them), and the direction up */
  ramps: { col: number; dir: number }[];
  /** a bit a box column: water over the lanes' limit (null: not asked) */
  wet: Uint32Array | null;
  /** submits it took */
  rounds: number;
}

/** what answers the fortress's reach: the GPU's (reachgpu.ts) in the game, the CPU reference (CpuReach) in tests */
export interface ReachEngine {
  /** the plan's solid as if built: two spans a box column (packSpan; 0 none) */
  setSpans(spans: Uint32Array): void;
  check(ask: ReachAsk): Promise<ReachReply>;
}

/** a span packed as fortreach.wgsl reads it (eighths of a metre; z clamped at 0) */
export function packSpan(z0: number, z1: number): number {
  const a = Math.max(0, Math.min(0xffff, Math.floor(z0 * 8)));
  const b = Math.max(0, Math.min(0xffff, Math.ceil(z1 * 8)));
  return (a | (b << 16)) >>> 0;
}

export interface ReachColumns {
  /** the window's columns */
  readonly w: number;
  readonly h: number;
  /** column (x, y)'s solid runs, bottom up (window z) */
  runs(x: number, y: number): readonly (readonly [number, number])[];
  /** the water over column (x, y)'s top */
  water(x: number, y: number): number;
}

interface Surf {
  z: number;
  /** the room over it */
  head: number;
}

/** a column's surfaces, highest first (fortreach.wgsl reachPeel) */
export function surfacesOf(runs: readonly (readonly [number, number])[]): Surf[] {
  const rs = runs
    .filter((r) => r[1] > r[0])
    .map((r) => [r[0], r[1]] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const m: [number, number][] = [];
  for (const r of rs) {
    const last = m[m.length - 1];
    if (last && r[0] - last[1] < 1e-3) last[1] = Math.max(last[1], r[1]);
    else m.push(r);
  }
  const out: Surf[] = [];
  for (let r = m.length - 1; r >= 0 && out.length < NAV_K; r--) {
    const head = r + 1 < m.length ? m[r + 1][0] - m[r][1] : 31;
    if (head >= AGENT_H) out.push({ z: m[r][1], head: Math.min(head, 31) });
  }
  return out;
}

/** The CPU reference of FortressReachGpu: the same calls, the same answers. */
export class CpuReach implements ReachEngine {
  private spans: Uint32Array;
  readonly stats = { checks: 0 };

  constructor(
    private cols: ReachColumns,
    readonly w: number,
    readonly h: number,
    /** the box's first window column */
    private origin: () => [number, number],
  ) {
    this.spans = new Uint32Array(w * h * 2);
  }

  setSpans(spans: Uint32Array): void {
    this.spans = spans.slice();
  }

  async check(ask: ReachAsk): Promise<ReachReply> {
    await Promise.resolve();
    this.stats.checks++;
    const { w, h } = this;
    const [ox, oy] = this.origin();
    const n = w * h;
    const boxOf = (x: number, y: number) => {
      const bx = x - ox;
      const by = y - oy;
      return bx < 0 || by < 0 || bx >= w || by >= h ? -1 : by * w + bx;
    };
    const xy = (b: number): [number, number] => [(b % w) + ox, Math.floor(b / w) + oy];
    const nq = ask.queries.length / 4;
    const bits = new Uint32Array(nq);
    let ramps: { col: number; dir: number }[] = [];
    // (a solve with `lift` rules lifted: 1 deep water no bar, 2 the plan's solid left out — fortreach.wgsl RP.mode)
    const solve = (lift: number, bit: number) => {
      const surfs: Surf[][] = new Array(n);
      const deep = new Uint8Array(n);
      for (let b = 0; b < n; b++) {
        const [x, y] = xy(b);
        if (x < 0 || y < 0 || x >= this.cols.w || y >= this.cols.h) {
          surfs[b] = [];
          continue;
        }
        const runs: [number, number][] = this.cols.runs(x, y).map((r) => [r[0], r[1]]);
        if (!(lift & 2))
          for (const word of [this.spans[2 * b], this.spans[2 * b + 1]]) {
            if (!word) continue;
            const z0 = (word & 0xffff) / 8;
            const z1 = (word >>> 16) / 8;
            if (z1 > z0) runs.push([z0, z1]);
          }
        surfs[b] = surfacesOf(runs);
        deep[b] = surfs[b].length && this.cols.water(x, y) > DEEP ? 1 : 0;
      }
      const parent = new Int32Array(n * NAV_K).map((_, i) => i);
      const find = (i: number): number => {
        while (parent[i] !== i) i = parent[i] = parent[parent[i]];
        return i;
      };
      const isDeep = (b: number, k: number) => !(lift & 1) && k === 0 && deep[b] === 1;
      for (let b = 0; b < n; b++) {
        const [x, y] = xy(b);
        surfs[b].forEach((s, k) => {
          for (let d = 0; d < 6; d++) {
            const qb = boxOf(...nbr(x, y, d));
            if (qb < 0) continue;
            surfs[qb].forEach((t, j) => {
              if (Math.abs(t.z - s.z) > STEP) return;
              if (Math.min(s.z + s.head, t.z + t.head) - Math.max(s.z, t.z) < AGENT_H) return;
              if (isDeep(b, k) !== isDeep(qb, j)) return;
              const a = find(b * NAV_K + k);
              const c = find(qb * NAV_K + j);
              if (a !== c) parent[Math.max(a, c)] = Math.min(a, c);
            });
          }
        });
      }
      const sb = ask.stores ? ask.stores[1] * w + ask.stores[0] : -1;
      const sr = sb >= 0 && surfs[sb]?.length ? find(sb * NAV_K) : -1;
      for (let q = 0; q < nq; q++) {
        let any = false;
        for (let t = 0; t < 4; t++) {
          const b = ask.queries[q * 4 + t];
          if (b < 0) continue;
          any = true;
          if (surfs[b].length && sr >= 0 && find(b * NAV_K) === sr) bits[q] |= bit;
        }
        if (!any) bits[q] |= REACH_BITS.none;
      }
      if (lift || sr < 0) return;
      ramps = [];
      for (let b = 0; b < n && ramps.length < RAMP_CAP; b++) {
        if (!surfs[b].length || deep[b] || find(b * NAV_K) === sr) continue;
        const [x, y] = xy(b);
        for (let d = 0; d < 6; d++) {
          const qb = boxOf(...nbr(x, y, d));
          if (qb < 0 || !surfs[qb].length || find(qb * NAV_K) !== sr) continue;
          const rise = surfs[qb][0].z - surfs[b][0].z;
          if (rise > STEP && rise <= DROP && ramps.length < RAMP_CAP) ramps.push({ col: b, dir: d });
        }
      }
    };
    solve(0, REACH_BITS.reached);
    if (ask.why && bits.some((b) => !(b & 1))) {
      solve(1, REACH_BITS.dry);
      if (bits.some((b) => !(b & 1) && !(b & REACH_BITS.dry))) solve(2, REACH_BITS.unplanned);
    }
    let wet: Uint32Array | null = null;
    if (ask.wet) {
      wet = new Uint32Array(Math.ceil(n / 32));
      for (let b = 0; b < n; b++) {
        const [x, y] = xy(b);
        if (x >= 0 && y >= 0 && x < this.cols.w && y < this.cols.h && this.cols.water(x, y) > LANE_WATER) wet[b >> 5] |= 1 << (b & 31);
      }
    }
    return { bits, ramps, wet, rounds: 1 };
  }
}
