// The fortress's reach: what a check asks and answers (the GPU's — reachgpu.ts, shaders/fortreach.wgsl — in the game),
// and the CPU reference of the same solve, for unit tests only (round 128l, m4: it stands in for the GPU where there's
// none, with the same answers).
//
// The rules (keep them in step with fortreach.wgsl, and its constants with agents.wgsl):
//  - surfaces: each column's solid runs (and the plan's spans as if built) merged where they touch, a surface on top of
//    each with AGENT_H of room over it, the highest NAV_K of them; the top one deep under water over DEEP;
//  - two surfaces of neighbouring columns join when a walker steps either way between them: a rise within STEP, AGENT_H
//    of room over the step, both deep or both dry;
//  - a place is reached when a stand's surface nearest its floor is in the stores' component (round 128o: was the top
//    surface — under a passage's arch the top is the roof, so a stand there never counted); Why not: the solve again with deep
//    water no bar (reached then: deep water), then with the plan's solid left out (reached then: walled in by the plan);
//    neither, a cliff.
import { nbr } from '../world/lattice';

import { AGENT_H, DEEP, DROP, NAV_K, STEP } from '../agents/rules';
export { AGENT_H, DEEP, DROP, NAV_K, STEP };
/** fortress.ts LANE_WATER */
const LANE_WATER = 0.8;

/** fortreach.wgsl RAMP_CAP: the ramp spots an answer holds */
export const RAMP_CAP = 64;

/** a query's answer bits: reached; reached with deep water no bar; reached with the plan's solid left out; no stand;
 *  (B) fixable — the fix field reached it: its fixes are in the answer */
export const REACH_BITS = { reached: 1, dry: 2, unplanned: 8, none: 16, fixable: 32 } as const;

/**
 * (round 128o, B: the passage chosen on the GPU) The fix field's costs: a step 1; entering a column whose plan solid can
 * be cut (a block's ground floor: a passage; a wall cell: a gate) CUT more; taking a drop a ramp would join (a rise of
 * STEP to DROP, either way) RAMP more. So a place is joined by the fewest cuts and ramps, then the shortest way.
 */
export const FIX_COST = { step: 1, cut: 4, ramp: 20 } as const;
/** fortreach.wgsl FIX_CAP: the fixes an answer holds (all places together) */
export const FIX_CAP = 512;
/** one fix on the way to a place not reached: a column to cut (its plan solid), or a ramp up from a column in a direction */
export interface ReachFix {
  query: number;
  col: number;
  kind: 'cut' | 'ramp';
  /** (a ramp) the direction from `col` up the drop */
  dir: number;
}

/** what a check asks (box-local columns: x + y * box w) */
export interface ReachAsk {
  /** the stores' box column (x, y); null: none in the box */
  stores: [number, number] | null;
  /** per query up to four box columns (its stands); -1 none */
  queries: Int32Array;
  /** (round 128o) per stand its floor (window z): it's reached by its column's surface nearest this */
  floors: Float32Array;
  /** the stores' floor (window z): the stores stand on their column's surface nearest it */
  storesZ: number;
  /** the wet columns too (the lanes) */
  wet: boolean;
  /** why the queries not reached aren't (the solve again with each rule lifted: an edit to judge) */
  why?: boolean;
  /** (B) the fixes for the queries not reached: the fix field and its walk back (an edit or a generated town to judge) */
  fix?: boolean;
  /** (B) per query: 1 — its stands are ones a fix would open (a structure with no side open): not reached until opened
   *  (a neighbour's roof a walker gets onto isn't its way in) */
  open?: Uint8Array;
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
  /** (B, asked for) the fixes on the way from each query not reached to the stores (FIX_CAP at most) */
  fixes: ReachFix[];
}

/** what answers the fortress's reach: the GPU's (reachgpu.ts) in the game, the CPU reference (CpuReach) in tests */
export interface ReachEngine {
  /** the plan's solid as if built: two spans a box column (packSpan; 0 none) */
  setSpans(spans: Uint32Array): void;
  check(ask: ReachAsk): Promise<ReachReply>;
}

/** a span packed as fortreach.wgsl reads it (eighths of a metre; z clamped at 0); `cut`: the plan may cut it (a block's
 *  ground floor, a wall cell a gate could go in) — bit 31, its top then at most 4095 m */
export function packSpan(z0: number, z1: number, cut = false): number {
  const a = Math.max(0, Math.min(0xffff, Math.floor(z0 * 8)));
  const b = Math.max(0, Math.min(0x7fff, Math.ceil(z1 * 8)));
  return (a | (b << 16) | (cut ? 0x80000000 : 0)) >>> 0;
}
/** a packed span's floor and top (window z) and whether it may be cut */
export function unpackSpan(word: number): { z0: number; z1: number; cut: boolean } {
  return { z0: (word & 0xffff) / 8, z1: ((word >>> 16) & 0x7fff) / 8, cut: (word & 0x80000000) !== 0 };
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

/** the surface of a column's (highest first) nearest a floor z (-1: none) — fortreach.wgsl nearSurf */
export function nearestSurf(surfs: readonly { z: number }[], z: number): number {
  let best = -1;
  for (let k = 0; k < surfs.length; k++) if (best < 0 || Math.abs(surfs[k].z - z) < Math.abs(surfs[best].z - z)) best = k;
  return best;
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
    const fixes: ReachFix[] = [];
    const cut = new Uint8Array(n);
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
            const { z0, z1, cut: c } = unpackSpan(word);
            // (the fix field: the cuttable solid left out, its column marked)
            if (c && lift & 4) {
              cut[b] = 1;
              continue;
            }
            if (z1 > z0) runs.push([z0, z1]);
          }
        surfs[b] = surfacesOf(runs);
        deep[b] = surfs[b].length && this.cols.water(x, y) > DEEP ? 1 : 0;
      }
      if (lift & 4) return fixField(surfs, deep);
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
      const sr = sb >= 0 && surfs[sb]?.length ? find(sb * NAV_K + nearestSurf(surfs[sb], ask.storesZ)) : -1;
      for (let q = 0; q < nq; q++) {
        let any = false;
        for (let t = 0; t < 4; t++) {
          const b = ask.queries[q * 4 + t];
          if (b < 0) continue;
          any = true;
          // (round 128o, B: a stand is its floor's surface — a roof over it, DROP or more up, isn't where a builder stands)
          const k = surfs[b].length ? nearestSurf(surfs[b], ask.floors[q * 4 + t]) : -1;
          if (k >= 0 && sr >= 0 && !ask.open?.[q] && Math.abs(surfs[b][k].z - ask.floors[q * 4 + t]) <= DROP && find(b * NAV_K + k) === sr) bits[q] |= bit;
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
    /**
     * (B) The fix field over the fix peel (the cuttable solid left out): the cost from the stores' surface (FIX_COST),
     * relaxed to the end; then from each query not reached, its stand's surface walked back to the stores, the cut
     * columns entered and the ramps taken on the way written down (fortreach.wgsl fixRelax, fixTrace).
     */
    const fixField = (surfs: Surf[][], deep: Uint8Array) => {
      const FAR = 0xffffffff;
      const dist = new Float64Array(n * NAV_K).fill(FAR);
      const sb = ask.stores ? ask.stores[1] * w + ask.stores[0] : -1;
      if (sb < 0 || !surfs[sb]?.length) return;
      dist[sb * NAV_K + nearestSurf(surfs[sb], ask.storesZ)] = 0;
      const isDeep = (b: number, k: number) => k === 0 && deep[b] === 1;
      /** the cost of the move t -> s (t in column tb, slot j; s in column b, slot k), or -1: no move */
      const move = (tb: number, j: number, b: number, k: number): number => {
        const a = surfs[tb][j];
        const c = surfs[b][k];
        const rise = Math.abs(c.z - a.z);
        if (Math.min(a.z + a.head, c.z + c.head) - Math.max(a.z, c.z) < AGENT_H) return -1;
        if (isDeep(tb, j) !== isDeep(b, k)) return -1;
        if (rise > DROP) return -1;
        return FIX_COST.step + (cut[b] ? FIX_COST.cut : 0) + (rise > STEP ? FIX_COST.ramp : 0);
      };
      // (the shortest costs — the GPU relaxes Bellman-Ford sweeps to the same: Dijkstra here, a binary heap)
      const heap: number[] = [];
      const push = (v: number) => {
        heap.push(v);
        for (let i = heap.length - 1; i > 0; ) {
          const p = (i - 1) >> 1;
          if (dist[heap[p]] <= dist[heap[i]]) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      };
      const pop = (): number => {
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          for (let i = 0; ; ) {
            const l = 2 * i + 1;
            const r = l + 1;
            let m = i;
            if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l;
            if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r;
            if (m === i) break;
            [heap[m], heap[i]] = [heap[i], heap[m]];
            i = m;
          }
        }
        return top;
      };
      const done = new Uint8Array(n * NAV_K);
      push(sb * NAV_K + nearestSurf(surfs[sb], ask.storesZ));
      while (heap.length) {
        const t = pop();
        if (done[t]) continue;
        done[t] = 1;
        const tb = Math.floor(t / NAV_K);
        const j = t % NAV_K;
        const [x, y] = xy(tb);
        for (let d = 0; d < 6; d++) {
          const b = boxOf(...nbr(x, y, d));
          if (b < 0) continue;
          for (let k = 0; k < surfs[b].length; k++) {
            const s = b * NAV_K + k;
            if (done[s]) continue;
            const c = move(tb, j, b, k);
            if (c >= 0 && dist[t] + c < dist[s]) {
              dist[s] = dist[t] + c;
              push(s);
            }
          }
        }
      }
      for (let q = 0; q < nq; q++) {
        if (bits[q] & REACH_BITS.reached) continue;
        // (its stand nearest the stores by the field)
        let s = -1;
        for (let t = 0; t < 4; t++) {
          const b = ask.queries[q * 4 + t];
          if (b < 0 || !surfs[b].length) continue;
          const c = b * NAV_K + nearestSurf(surfs[b], ask.floors[q * 4 + t]);
          if (dist[c] !== FAR && (s < 0 || dist[c] < dist[s])) s = c;
        }
        if (s < 0) continue;
        bits[q] |= REACH_BITS.fixable;
        for (let guard = 0; dist[s] > 0 && guard < 4096; guard++) {
          const b = Math.floor(s / NAV_K);
          const k = s % NAV_K;
          const [x, y] = xy(b);
          let prev = -1;
          let ramp = false;
          for (let d = 0; d < 6 && prev < 0; d++) {
            const qb = boxOf(...nbr(x, y, d));
            if (qb < 0) continue;
            for (let j = 0; j < surfs[qb].length; j++) {
              const t = qb * NAV_K + j;
              const c = move(qb, j, b, k);
              if (dist[t] === FAR || c < 0 || dist[t] + c !== dist[s]) continue;
              prev = t;
              ramp = Math.abs(surfs[b][k].z - surfs[qb][j].z) > STEP;
              if (ramp && fixes.length < FIX_CAP) {
                // (the ramp from the lower column up the drop)
                const lower = surfs[b][k].z < surfs[qb][j].z ? b : qb;
                const upper = lower === b ? qb : b;
                const [lx, ly] = xy(lower);
                const dir = [0, 1, 2, 3, 4, 5].find((e) => boxOf(...nbr(lx, ly, e)) === upper)!;
                fixes.push({ query: q, col: lower, kind: 'ramp', dir });
              }
              break;
            }
          }
          if (cut[b] && fixes.length < FIX_CAP) fixes.push({ query: q, col: b, kind: 'cut', dir: 0 });
          if (prev < 0) throw new Error('reach: the fix field has no way back (a bug)');
          s = prev;
        }
      }
    };
    solve(0, REACH_BITS.reached);
    if (ask.why && bits.some((b) => !(b & 1))) {
      solve(1, REACH_BITS.dry);
      if (bits.some((b) => !(b & 1) && !(b & REACH_BITS.dry))) solve(2, REACH_BITS.unplanned);
    }
    if (ask.fix && bits.some((b) => !(b & 1))) solve(4, 0);
    let wet: Uint32Array | null = null;
    if (ask.wet) {
      wet = new Uint32Array(Math.ceil(n / 32));
      for (let b = 0; b < n; b++) {
        const [x, y] = xy(b);
        if (x >= 0 && y >= 0 && x < this.cols.w && y < this.cols.h && this.cols.water(x, y) > LANE_WATER) wet[b >> 5] |= 1 << (b & 31);
      }
    }
    return { bits, ramps, wet, rounds: 1, fixes };
  }
}
