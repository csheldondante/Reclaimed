// ---- hero/path.ts ---------------------------------------------------------------
// A way round walls (round 88): A* over a 1-cell square grid of the ground's column tops, a step up of more
// than `step` cells impassable (a wall, a cliff), a drop of more than `drop` too. The path is then pulled
// straight wherever the ground between two of its points is walkable, so a walk across open ground is one
// leg. Bounded: it searches a box round the two ends (`pad` cells), at most `maxNodes` cells, and gives up
// (null) past that — the caller walks straight, or says there's no way.

type V2 = [number, number];

export interface PathGround {
  heightAt(x: number, y: number): number | null;
}

export interface PathOpts {
  step: number;
  drop?: number;
  pad?: number;
  maxNodes?: number;
}

/** can one walk straight from a to b, a body's width (WIDTH either side) clear (sampled every half cell) */
export function clearLine(g: PathGround, a: V2, b: V2, step: number, drop = 6): boolean {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(d / 0.5));
  const px = d > 0 ? (-(b[1] - a[1]) / d) * WIDTH : 0;
  const py = d > 0 ? ((b[0] - a[0]) / d) * WIDTH : 0;
  for (const s of [0, 1, -1]) {
    const ax = a[0] + px * s;
    const ay = a[1] + py * s;
    let prev = g.heightAt(s ? ax : a[0], s ? ay : a[1]);
    if (prev === null) return false;
    for (let k = 1; k <= n; k++) {
      const z = g.heightAt(ax + ((b[0] - a[0]) * k) / n, ay + ((b[1] - a[1]) * k) / n);
      if (z === null || z - prev > step || prev - z > drop) return false;
      prev = z;
    }
  }
  return true;
}

/** half a body's width (cells): a straight leg keeps this clear of walls either side */
const WIDTH = 0.6;

/** waypoints from `from` to `to` (not including `from`), or null when there's no way within the bounds */
export function findPath(g: PathGround, from: V2, to: V2, o: PathOpts): V2[] | null {
  const step = o.step;
  const drop = o.drop ?? 6;
  if (clearLine(g, from, to, step, drop)) return [to];
  const pad = o.pad ?? 48;
  const x0 = Math.floor(Math.min(from[0], to[0]) - pad);
  const y0 = Math.floor(Math.min(from[1], to[1]) - pad);
  const w = Math.ceil(Math.abs(to[0] - from[0]) + 2 * pad) + 1;
  const h = Math.ceil(Math.abs(to[1] - from[1]) + 2 * pad) + 1;
  const maxNodes = o.maxNodes ?? 80000;
  if (w * h > maxNodes * 4) return null;
  const N = w * h;
  const zs = new Float32Array(N).fill(NaN);
  const zAt = (i: number) => {
    let z = zs[i];
    if (Number.isNaN(z)) {
      const v = g.heightAt(x0 + (i % w) + 0.5, y0 + Math.floor(i / w) + 0.5);
      z = zs[i] = v === null ? -1e9 : v;
    }
    return z;
  };
  const idx = (x: number, y: number) => Math.floor(y - y0) * w + Math.floor(x - x0);
  const start = idx(from[0], from[1]);
  const goal = idx(to[0], to[1]);
  if (start < 0 || start >= N || goal < 0 || goal >= N) return null;
  const gs = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  // (a binary heap of [f, i])
  const heap: number[] = [];
  const push = (f: number, i: number) => {
    heap.push(f, i);
    let c = heap.length / 2 - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p * 2] <= heap[c * 2]) break;
      for (let k = 0; k < 2; k++) [heap[p * 2 + k], heap[c * 2 + k]] = [heap[c * 2 + k], heap[p * 2 + k]];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[1];
    const lf = heap[heap.length - 2];
    const li = heap[heap.length - 1];
    heap.length -= 2;
    if (heap.length) {
      // (the last pair moved to the top, sifted down)
      heap[0] = lf;
      heap[1] = li;
      let c = 0;
      const n = heap.length / 2;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < n && heap[l * 2] < heap[m * 2]) m = l;
        if (r < n && heap[r * 2] < heap[m * 2]) m = r;
        if (m === c) break;
        for (let k = 0; k < 2; k++) [heap[m * 2 + k], heap[c * 2 + k]] = [heap[c * 2 + k], heap[m * 2 + k]];
        c = m;
      }
    }
    return top;
  };
  const gx = goal % w;
  const gy = Math.floor(goal / w);
  const hcost = (i: number) => Math.hypot((i % w) - gx, Math.floor(i / w) - gy);
  gs[start] = 0;
  push(hcost(start), start);
  let seen = 0;
  let found = false;
  let end = goal;
  const D = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  while (heap.length) {
    const i = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    // (the goal, or right beside it when it stands on something: a post, a pillar, a person)
    if (i === goal || (hcost(i) <= 3 && zAt(goal) - zAt(i) > step)) {
      end = i;
      found = true;
      break;
    }
    if (++seen > maxNodes) break;
    const x = i % w;
    const y = Math.floor(i / w);
    const z = zAt(i);
    for (const [dx, dy, c] of D) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (closed[j]) continue;
      const nz = zAt(j);
      if (nz < -1e8 || nz - z > step || z - nz > drop) continue;
      // (a diagonal only where both sides are open: no cutting a wall's corner)
      if (dx && dy) {
        const a = zAt(y * w + nx);
        const b = zAt(ny * w + x);
        if (a < -1e8 || b < -1e8 || a - z > step || b - z > step) continue;
      }
      // (a cell beside a wall costs more: the way keeps to the middle of a doorway)
      let near = 0;
      for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const qx = nx + ex;
        const qy = ny + ey;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const qz = zAt(qy * w + qx);
        if (qz < -1e8 || qz - nz > step) near = 1;
      }
      const ng = gs[i] + c + near * 2;
      if (ng < gs[j]) {
        gs[j] = ng;
        came[j] = i;
        push(ng + hcost(j), j);
      }
    }
  }
  if (!found) return null;
  const cells: V2[] = [];
  for (let i = end; i !== start && i >= 0; i = came[i]) cells.push([x0 + (i % w) + 0.5, y0 + Math.floor(i / w) + 0.5]);
  cells.reverse();
  if (end === goal && cells.length) cells[cells.length - 1] = to;
  if (!cells.length) return [];
  // pulled straight: from each point, the furthest one still in a clear line
  const out: V2[] = [];
  let at: V2 = from;
  let k = 0;
  while (k < cells.length) {
    let far = k;
    for (let m = cells.length - 1; m > k; m--)
      if (clearLine(g, at, cells[m], step, drop)) {
        far = m;
        break;
      }
    out.push(cells[far]);
    at = cells[far];
    k = far + 1;
  }
  return out;
}
