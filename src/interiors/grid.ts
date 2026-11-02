// A storey's walkable floor as a fine grid (0.25 m cells, plan frame): the tiles' floors less the walls' thickness, the
// stairs' bands and the props' footprints. The furnishing checks it (a prop goes where it's free and leaves a way
// round), the people path on it (A* over 8 neighbours, then pulled straight where the line is clear).
import type { V2 } from '../api/contracts/interiors';

export const GRID_CELL = 0.125;

export class WalkGrid {
  readonly w: number;
  readonly h: number;
  /** 0 blocked, 1 free */
  readonly free: Uint8Array;

  constructor(readonly x0: number, readonly y0: number, x1: number, y1: number, readonly cell = GRID_CELL) {
    this.w = Math.max(1, Math.ceil((x1 - x0) / cell));
    this.h = Math.max(1, Math.ceil((y1 - y0) / cell));
    this.free = new Uint8Array(this.w * this.h);
  }

  centreOf(i: number, j: number): V2 {
    return [this.x0 + (i + 0.5) * this.cell, this.y0 + (j + 0.5) * this.cell];
  }

  cellOf(p: V2): [number, number] {
    return [Math.floor((p[0] - this.x0) / this.cell), Math.floor((p[1] - this.y0) / this.cell)];
  }

  isFree(p: V2): boolean {
    const [i, j] = this.cellOf(p);
    return i >= 0 && j >= 0 && i < this.w && j < this.h && this.free[j * this.w + i] === 1;
  }

  /** set every cell whose middle `inside` holds (in a bounding box) to `val` */
  paint(lo: V2, hi: V2, inside: (p: V2) => boolean, val: 0 | 1): void {
    const [i0, j0] = this.cellOf(lo);
    const [i1, j1] = this.cellOf(hi);
    for (let j = Math.max(0, j0); j <= Math.min(this.h - 1, j1); j++)
      for (let i = Math.max(0, i0); i <= Math.min(this.w - 1, i1); i++) if (inside(this.centreOf(i, j))) this.free[j * this.w + i] = val;
  }

  /** an oriented rectangle (centre, half sizes along `ax` and its normal) */
  paintRect(c: V2, ax: V2, hx: number, hy: number, val: 0 | 1): void {
    const r = Math.hypot(hx, hy);
    const ny: V2 = [-ax[1], ax[0]];
    this.paint([c[0] - r, c[1] - r], [c[0] + r, c[1] + r], (p) => {
      const dx = p[0] - c[0], dy = p[1] - c[1];
      return Math.abs(dx * ax[0] + dy * ax[1]) <= hx && Math.abs(dx * ny[0] + dy * ny[1]) <= hy;
    }, val);
  }

  /** Is the oriented rectangle wholly free? */
  rectFree(c: V2, ax: V2, hx: number, hy: number): boolean {
    const ny: V2 = [-ax[1], ax[0]];
    const step = this.cell * 0.7;
    for (let a = -hx; a <= hx + 1e-6; a += step)
      for (let b = -hy; b <= hy + 1e-6; b += step) {
        const p: V2 = [c[0] + ax[0] * a + ny[0] * b, c[1] + ax[1] * a + ny[1] * b];
        if (!this.isFree(p)) return false;
      }
    return true;
  }

  /** a copy with every cell next to a blocked one blocked too: room for a body (the floor less a margin round
   *  walls and furniture) */
  eroded(r = 1): WalkGrid {
    const g = new WalkGrid(this.x0, this.y0, this.x0 + this.w * this.cell, this.y0 + this.h * this.cell, this.cell);
    for (let j = 0; j < this.h; j++)
      for (let i = 0; i < this.w; i++) {
        let ok = this.free[j * this.w + i] === 1;
        for (let dj = -r; dj <= r && ok; dj++)
          for (let di = -r; di <= r && ok; di++) {
            if (di * di + dj * dj > r * r + r) continue;
            const x = i + di, y = j + dj;
            if (x < 0 || y < 0 || x >= this.w || y >= this.h || !this.free[y * this.w + x]) ok = false;
          }
        g.free[j * this.w + i] = ok ? 1 : 0;
      }
    return g;
  }

  /** the small 4-connected free regions let go (pockets behind furniture, under `minArea` m²): a separate wing (joined
   *  only by a storey under it) keeps its floor */
  dropPockets(minArea = 1.2): void {
    const comp = new Int32Array(this.w * this.h).fill(-1);
    const sizes: number[] = [];
    let id = 0;
    for (let s = 0; s < comp.length; s++) {
      if (!this.free[s] || comp[s] >= 0) continue;
      let n = 0;
      const st = [s];
      comp[s] = id;
      while (st.length) {
        const k = st.pop()!;
        n++;
        const x = k % this.w, y = (k / this.w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue;
          const m = Y * this.w + X;
          if (!this.free[m] || comp[m] >= 0) continue;
          comp[m] = id;
          st.push(m);
        }
      }
      sizes.push(n);
      id++;
    }
    const min = minArea / (this.cell * this.cell);
    for (let s = 0; s < comp.length; s++) if (comp[s] >= 0 && sizes[comp[s]] < min) this.free[s] = 0;
  }

  /** cells reachable from p (4-connected) */
  reach(p: V2): Uint8Array {
    const seen = new Uint8Array(this.w * this.h);
    const [i, j] = this.nearestFree(p, 16) ?? [-1, -1];
    if (i < 0) return seen;
    const st = [j * this.w + i];
    seen[st[0]] = 1;
    while (st.length) {
      const k = st.pop()!;
      const x = k % this.w, y = (k / this.w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue;
        const n = Y * this.w + X;
        if (seen[n] || !this.free[n]) continue;
        seen[n] = 1;
        st.push(n);
      }
    }
    return seen;
  }

  nearestFree(p: V2, maxR = 8): [number, number] | null {
    const [ci, cj] = this.cellOf(p);
    for (let r = 0; r <= maxR; r++)
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di, j = cj + dj;
          if (i >= 0 && j >= 0 && i < this.w && j < this.h && this.free[j * this.w + i]) return [i, j];
        }
    return null;
  }

  /** a clear straight line between two points (sampled at a third of a cell) */
  clear(a: V2, b: V2): boolean {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / (this.cell / 3)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (!this.isFree([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
    return true;
  }

  /** A* from a to b (both snapped to the nearest free cell), pulled straight; null: no way */
  path(a: V2, b: V2): V2[] | null {
    const s = this.nearestFree(a);
    const g = this.nearestFree(b);
    if (!s || !g) return null;
    const W = this.w;
    const start = s[1] * W + s[0];
    const goal = g[1] * W + g[0];
    const cost = new Float32Array(this.w * this.h).fill(Infinity);
    const from = new Int32Array(this.w * this.h).fill(-1);
    const f = new Float32Array(this.w * this.h).fill(Infinity);
    cost[start] = 0;
    const hfun = (k: number) => Math.hypot((k % W) - g[0], ((k / W) | 0) - g[1]);
    f[start] = hfun(start);
    const closed = new Uint8Array(this.w * this.h);
    // (a binary heap on f)
    const heap: number[] = [start];
    const pushH = (k: number) => {
      heap.push(k);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (f[heap[p]] <= f[heap[i]]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const popH = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
          if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const cur = popH();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const x = cur % W, y = (cur / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue;
          const n = Y * W + X;
          if (!this.free[n] || closed[n]) continue;
          // (no cutting a blocked corner)
          if (dx && dy && (!this.free[y * W + X] || !this.free[Y * W + x])) continue;
          const c = cost[cur] + (dx && dy ? Math.SQRT2 : 1);
          if (c < cost[n]) {
            cost[n] = c;
            from[n] = cur;
            f[n] = c + hfun(n);
            pushH(n);
          }
        }
    }
    if (from[goal] < 0 && goal !== start) return null;
    const cells: V2[] = [];
    for (let k = goal; k >= 0; k = k === start ? -1 : from[k]) cells.push(this.centreOf(k % W, (k / W) | 0));
    cells.reverse();
    cells[0] = this.isFree(a) ? a : cells[0];
    if (this.isFree(b)) cells[cells.length - 1] = b;
    // string pulling: skip ahead while the line stays clear
    const out: V2[] = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = cells.length - 1;
      while (j > i + 1 && !this.clear(cells[i], cells[j])) j--;
      out.push(cells[j]);
      i = j;
    }
    return out;
  }
}
