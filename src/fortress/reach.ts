// Whether the stores can reach a place, on the CPU, by the rules the agents' fields use (round 128f; the user: "It might
// be worthwhile to do the check at placement. My expectation is that we should always be able to reach blocks where we
// can place and say why we can't reach a block not yet placed. Blocks that lie adjacent to other blocks or planned
// blocks should always be reachable").
//
// The same rules as agents.wgsl (keep them in step: the constants below are its):
//  - surfaces: each column's solid runs (solid or granular matter, touching runs merged), a surface on top of each with
//    AGENT_H of room over it, the highest NAV_K of them;
//  - links: to each of the six neighbours, the neighbour's surface with the least rise within STEP up or DROP down and
//    AGENT_H of room over the step;
//  - deep water: water over DEEP on a column's top surface; the field reaches a deep surface from a dry one but never a
//    dry one from a deep one (a walker is never led in);
//  - the covered area: the fortress's box (the agents' scope keeps every block still to build in it: Agents.keepInScope).
// A breadth-first search from the stores' surface over the surfaces; a place is reached if its column's top surface is
// (the field reader's sample: the surface nearest under 1e4). Pure: tested without a GPU (reach.test.ts).
import { nbr } from '../world/lattice';

/** agents.wgsl's */
export const AGENT_H = 1.5;
export const STEP = 1.1;
export const DROP = 2.6;
export const DEEP = 0.9;
export const NAV_K = 4;

export interface ReachColumns {
  /** the window's columns */
  readonly w: number;
  readonly h: number;
  /** column (x, y)'s solid runs, bottom up (window z; touching ones may come apart: merged here) */
  runs(x: number, y: number): readonly (readonly [number, number])[];
  /** the water over column (x, y)'s top */
  water(x: number, y: number): number;
}

export interface ReachOpts {
  /** the columns searched: [x0, y0, x1, y1) window columns */
  box: readonly [number, number, number, number];
  /** solid added over the columns (window column index y * w + x → runs): the fortress's blocks */
  extra?: ReadonlyMap<number, readonly (readonly [number, number])[]>;
  /** the deep-water rule (false: water is no bar — to tell why a place isn't reached) */
  deep?: boolean;
}

interface Surf {
  z: number;
  /** the room over it */
  head: number;
}

/** a column's surfaces, highest first (agents.wgsl surfaces) */
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

/**
 * The surfaces a walker from `from` (window column x, y: the stores) gets to and gets back from: a breadth-first search
 * each way (the agents' fields are one-way — a field seeded at a block leads to it, one at the stores leads back).
 */
export class ReachMap {
  /** per column a bit per surface: a walker from the stores gets there; and from there gets back to the stores */
  private readonly there: Uint8Array;
  private readonly back: Uint8Array;
  private readonly surfs: (Surf[] | undefined)[];
  private readonly deepTop: Uint8Array;
  readonly box: readonly [number, number, number, number];

  constructor(
    private cols: ReachColumns,
    from: readonly [number, number],
    opts: ReachOpts,
  ) {
    const { w } = cols;
    this.box = opts.box;
    const [x0, y0, x1, y1] = opts.box;
    const n = cols.w * cols.h;
    this.there = new Uint8Array(n);
    this.back = new Uint8Array(n);
    this.surfs = new Array(n);
    this.deepTop = new Uint8Array(n);
    const inBox = (x: number, y: number) => x >= x0 && y >= y0 && x < x1 && y < y1;
    const surfAt = (x: number, y: number): Surf[] => {
      const i = y * w + x;
      let s = this.surfs[i];
      if (!s) {
        const add = opts.extra?.get(i);
        s = surfacesOf(add ? [...cols.runs(x, y), ...add] : cols.runs(x, y));
        this.surfs[i] = s;
        // (the water sheet lies on the top surface only)
        this.deepTop[i] = opts.deep !== false && s.length > 0 && cols.water(x, y) > DEEP ? 1 : 0;
      }
      return s;
    };
    const deep = (i: number, k: number) => k === 0 && this.deepTop[i] === 1;
    const [fx, fy] = from;
    if (!inBox(fx, fy) || !surfAt(fx, fy).length) return;
    // both ways: a builder walks out from the stores to a block (the block's field reaches the stores) and back again
    // (the stores' field reaches the block) — a drop of 2 m is a way down but no way up
    for (const out of [true, false]) {
      const bits = out ? this.there : this.back;
      // (the stores' surface: the top one, as the field's seed on the ground)
      const queue: number[] = [(fy * w + fx) * NAV_K];
      bits[fy * w + fx] |= 1;
      while (queue.length) {
        const node = queue.pop()!;
        const i = Math.floor(node / NAV_K);
        const k = node % NAV_K;
        const x = i % w;
        const y = (i - x) / w;
        const here = surfAt(x, y);
        for (let d = 0; d < 6; d++) {
          const [qx, qy] = nbr(x, y, d);
          if (!inBox(qx, qy)) continue;
          const j = qy * w + qx;
          const qs = surfAt(qx, qy);
          if (out) {
            // a walker on s steps to the surface s links to — but never from dry ground into deep water
            const tk = bestLink(here[k], qs);
            if (tk < 0 || bits[j] & (1 << tk)) continue;
            if (!deep(i, k) && deep(j, tk)) continue;
            bits[j] |= 1 << tk;
            queue.push(j * NAV_K + tk);
            continue;
          }
          // the field flows from s to each surface t of the neighbour that links to s (t's best surface in s's column)
          for (let tk = 0; tk < qs.length; tk++) {
            if (bits[j] & (1 << tk)) continue;
            if (bestLink(qs[tk], here) !== k) continue;
            // (a dry surface doesn't read a deep one: the field never leads a walker in)
            if (deep(i, k) && !deep(j, tk)) continue;
            bits[j] |= 1 << tk;
            queue.push(j * NAV_K + tk);
          }
        }
      }
    }
  }

  /**
   * (round 128h) whether column (x, y)'s top surface is reached from the stores but no way leads back (a drop walked
   * down, not up: the ramps' search starts at its foot)
   */
  oneWay(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.cols.w || y >= this.cols.h) return false;
    const i = y * this.cols.w + x;
    return (this.there[i] & 1) !== 0 && (this.back[i] & 1) === 0;
  }

  /** (round 128h) column (x, y)'s top surface's height as searched (NaN: none, or not searched) */
  topZ(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.cols.w || y >= this.cols.h) return NaN;
    return this.surfs[y * this.cols.w + x]?.[0]?.z ?? NaN;
  }

  /** whether column (x, y)'s top surface (what the field reader samples) is reached from the stores and back */
  reached(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.cols.w || y >= this.cols.h) return false;
    const i = y * this.cols.w + x;
    return (this.there[i] & this.back[i] & 1) !== 0;
  }
}

/** the surface of a neighbour's column a surface links to (agents.wgsl links): -1 none */
function bestLink(s: Surf, qs: readonly Surf[]): number {
  let best = -1;
  let bd = Infinity;
  for (let j = 0; j < qs.length; j++) {
    const q = qs[j];
    const dz = q.z - s.z;
    if (dz > STEP || dz < -DROP) continue;
    if (Math.min(s.z + s.head, q.z + q.head) - Math.max(s.z, q.z) < AGENT_H) continue;
    if (Math.abs(dz) < bd) {
      bd = Math.abs(dz);
      best = j;
    }
  }
  return best;
}
