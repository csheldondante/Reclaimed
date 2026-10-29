// ---- hero/traversal.ts ----------------------------------------------------------
// (round 112, herosandbox) The traversal-field contract (contracts/traversal.ts) on the CPU: a Dijkstra from the
// goal's cell outward over the window's hex cells within `radius`, from the world API's heights (Terrain.heightAt:
// the open sky's floor) and water (Water.depthAt). An edge from a cell to its neighbour nearer the goal is taken
// when the body's Mobility allows the move: a climb of at most `step` (or `step + jump`, at `jumpCost`), a drop of at
// most `drop`, no water deeper than `deep` (out of deep water is always allowed: a body that ends up in a river
// wades out). Each cell keeps the neighbour it reaches the goal through, so `dir` is that cell's direction.
// Simplest first: the GPU agents' fields (agents.wgsl navCost, many surfaces a column) are the next implementation
// behind the same contract (BACKLOG HS10); this one reads the top surface only (no caves, no bridges' undersides).

import type { Mobility, Traversal, TraversalField } from '../api/contracts/traversal';
import type { V2 } from '../api/contracts/units';
import { cellAt, cellPos, nbr, NDIR, ROW_H } from '../world/lattice';

export interface TraversalGround {
  heightAt(x: number, y: number): number | null;
}

export interface TraversalWater {
  depthAt(x: number, y: number): number | null;
}

/** a binary heap of cell indices by cost */
class Heap {
  private c: number[] = [];
  private k: number[] = [];
  get size(): number {
    return this.c.length;
  }
  push(cost: number, key: number): void {
    const { c, k } = this;
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
    const { c, k } = this;
    const top: [number, number] = [c[0], k[0]];
    const lc = c.pop()!;
    const lk = k.pop()!;
    if (c.length) {
      c[0] = lc;
      k[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
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

class CpuField implements TraversalField {
  constructor(
    readonly goal: V2,
    readonly mobility: Mobility,
    readonly radius: number,
    readonly ms: number,
    private x0: number,
    private y0: number,
    private w: number,
    private h: number,
    private costs: Float32Array,
    private next: Int32Array,
  ) {}

  private idx(at: V2): number {
    const [cx, cy] = cellAt(at[0], at[1]);
    const x = cx - this.x0;
    const y = cy - this.y0;
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? -1 : y * this.w + x;
  }

  cost(at: V2): number | null {
    const i = this.idx(at);
    return i < 0 || !Number.isFinite(this.costs[i]) ? null : this.costs[i];
  }

  reachable(at: V2): boolean {
    return this.cost(at) !== null;
  }

  dir(at: V2): V2 | null {
    let i = this.idx(at);
    if (i < 0) return null;
    // (off the field's cells — on a wall's soft rim, a cell's edge: the best neighbour's way)
    if (!Number.isFinite(this.costs[i])) {
      const [cx, cy] = [(i % this.w) + this.x0, Math.floor(i / this.w) + this.y0];
      let best = -1;
      for (let d = 0; d < NDIR; d++) {
        const [nx, ny] = nbr(cx, cy, d);
        const j = this.at(nx, ny);
        if (j >= 0 && Number.isFinite(this.costs[j]) && (best < 0 || this.costs[j] < this.costs[best])) best = j;
      }
      if (best < 0) return null;
      i = best;
      return unit(this.pos(i), at);
    }
    const n = this.next[i];
    // (the goal's cell: to the goal point itself)
    if (n < 0) return unit(this.goal, at);
    // (to the next cell's centre: never across a corner the field goes round)
    return unit(this.pos(n), at);
  }

  route(at: V2, max = 4096): V2[] | null {
    let i = this.idx(at);
    if (i < 0 || !Number.isFinite(this.costs[i])) return null;
    const out: V2[] = [];
    for (let k = 0; k < max && i >= 0; k++) {
      out.push(this.pos(i));
      i = this.next[i];
    }
    out.push(this.goal);
    return out;
  }

  private at(cx: number, cy: number): number {
    const x = cx - this.x0;
    const y = cy - this.y0;
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? -1 : y * this.w + x;
  }

  private pos(i: number): V2 {
    return cellPos((i % this.w) + this.x0, Math.floor(i / this.w) + this.y0);
  }
}

function unit(to: V2, from: V2): V2 | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const l = Math.hypot(dx, dy);
  return l < 1e-6 ? [0, 0] : [dx / l, dy / l];
}

export class CpuTraversal implements Traversal {
  constructor(
    private ground: TraversalGround,
    private water?: TraversalWater,
  ) {}

  field(goal: V2, m: Mobility, opts: { radius?: number } = {}): TraversalField {
    const t0 = performance.now();
    const R = opts.radius ?? 96;
    const [gx, gy] = cellAt(goal[0], goal[1]);
    const ry = Math.ceil(R / ROW_H);
    const x0 = gx - R - 1;
    const y0 = gy - ry - 1;
    const w = 2 * R + 3;
    const h = 2 * ry + 3;
    const n = w * h;
    const top = new Float32Array(n).fill(NaN);
    const wet = new Float32Array(n);
    const costs = new Float32Array(n).fill(Infinity);
    const next = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const step = m.step;
    const drop = m.drop ?? Infinity;
    const deep = m.deep ?? Infinity;
    const jump = m.jump ?? 0;
    const jumpCost = m.jumpCost ?? 4;
    const climbCost = m.climbCost ?? 0.5;
    const wadeCost = m.wadeCost ?? 1;
    const hug = m.hugCost ?? 3;
    const fromLow = !!m.fromLow;
    /** (fromLow) the lowest ground within a cell of each cell, no more than a drop below it */
    const lowAt = new Float32Array(n).fill(NaN);
    const low = (i: number): number => {
      if (!Number.isNaN(lowAt[i])) return lowAt[i];
      const cx = (i % w) + x0;
      const cy = Math.floor(i / w) + y0;
      let lo = top[i];
      for (let d = 0; d < NDIR; d++) {
        const [nx, ny] = nbr(cx, cy, d);
        const lx = nx - x0;
        const ly = ny - y0;
        if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
        const j = ly * w + lx;
        if (read(j) && top[j] < lo && top[i] - top[j] <= Math.min(step, drop)) lo = top[j];
      }
      lowAt[i] = lo;
      return lo;
    };
    /** 1: a cell beside a face it can't climb (a wall's foot): kept off, a body has width; 0 not; 2 not yet looked at */
    const walled = new Uint8Array(n).fill(2);
    const besideWall = (i: number): boolean => {
      if (walled[i] !== 2) return walled[i] === 1;
      const cx = (i % w) + x0;
      const cy = Math.floor(i / w) + y0;
      let on = 0;
      for (let d = 0; d < NDIR && !on; d++) {
        const [nx, ny] = nbr(cx, cy, d);
        const lx = nx - x0;
        const ly = ny - y0;
        if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
        const j = ly * w + lx;
        if (read(j) && top[j] - top[i] > step + jump) on = 1;
      }
      walled[i] = on;
      return on === 1;
    };
    const read = (i: number): boolean => {
      if (!Number.isNaN(top[i])) return top[i] !== -Infinity;
      const cx = (i % w) + x0;
      const cy = Math.floor(i / w) + y0;
      const [x, y] = cellPos(cx, cy);
      const z = Math.hypot(cx - gx, (cy - gy) * ROW_H) > R ? null : this.ground.heightAt(x, y);
      if (z === null) {
        top[i] = -Infinity;
        return false;
      }
      top[i] = z;
      wet[i] = this.water?.depthAt(x, y) ?? 0;
      return true;
    };
    const g0 = (gy - y0) * w + (gx - x0);
    const heap = new Heap();
    if (read(g0)) {
      costs[g0] = 0;
      heap.push(0, g0);
    }
    while (heap.size) {
      const [c, b] = heap.pop();
      if (done[b]) continue;
      done[b] = 1;
      const bx = (b % w) + x0;
      const by = Math.floor(b / w) + y0;
      for (let d = 0; d < NDIR; d++) {
        const [ax, ay] = nbr(bx, by, d);
        const lx = ax - x0;
        const ly = ay - y0;
        if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
        const a = ly * w + lx;
        if (done[a] || !read(a)) continue;
        // the move a → b (toward the goal): up at most step (or a jump), down at most drop, not into deep water
        const up = top[b] - top[a];
        const climb = fromLow ? top[b] - low(a) : up;
        let e = 1;
        if (climb > step) {
          if (climb > step + jump) continue;
          e += jumpCost;
        }
        if (-up > drop) continue;
        if (wet[b] > deep && wet[b] > wet[a] + 0.1) continue;
        e += climbCost * Math.max(0, up) + wadeCost * wet[b] + (hug && besideWall(a) ? hug : 0);
        const nc = c + e;
        if (nc < costs[a]) {
          costs[a] = nc;
          next[a] = b;
          heap.push(nc, a);
        }
      }
    }
    next[g0] = -1;
    return new CpuField(goal, m, R, performance.now() - t0, x0, y0, w, h, costs, next);
  }
}
