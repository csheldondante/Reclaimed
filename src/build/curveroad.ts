// Main roads as curves the grid adapts to, and the radial relax (round 128p, DA-A13 step 2; DECISIONS round 128p: "a
// hybrid with roads that can intersect our irregular grid and the procedural tiles adapt to those intersections";
// "grow an organic road to them from the nearest major road … without weird turns that are not justified"). Pure.
//  - growRoad: a road grown over the land from the network to a place — a least-cost walk over a 2 m raster (16
//    directions; a step costs its length × (1 + (grade / ROAD_GRADE)² + 20 × its excess over the grade²), steeper than stairs (SLOPE) barred, water a
//    bridge's price, a building's cell OCCUPIED_COST times), then pulled straight wherever a straight stretch keeps to a road's grade on dry land (bends only
//    where the land or the water asks), then rounded (Chaikin).
//  - adaptToCurve: the grid's vertices near the road snapped onto its edges (half its width from its line, on their
//    side; a move held to MAX_SNAP of a cell's side, and undone where it would turn a cell over); the cells whose middle
//    lies on the road become road cells (paved; a structure loses them — a clipped one keeps what's left).
//  - radialRelax: Townscaper's relax toward squares, each cell's square turned to face the town's middle (its sides
//    radial and round), fading out to the town's edge: the grid rings the centre.
import { ROAD_GRADE } from './grade';
import { SLOPE } from './ways';

type V2 = [number, number];

export interface LandIO {
  ground(x: number, y: number): number;
  wet(x: number, y: number): boolean;
  /** the domain (box-local metres) */
  W: number;
  H: number;
  /** a building stands there (a road goes round, through a gap, or pays to take it: OCCUPIED_COST) */
  occupied?(x: number, y: number): boolean;
}

/** the walk's moves: 16 directions (a knight's too, so a climb can run at a grade the 8 compass ones miss) */
const MOVES: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
  [1, 2],
  [1, -2],
  [-1, 2],
  [-1, -2],
];

/** (water: a bridge's price a metre, against the land's 1; a building's: what taking it costs) */
const BRIDGE_COST = 12;
const OCCUPIED_COST = 8;

/** A road grown from the nearest of `from` to `to` over the land: the curve (from its start on the network to `to`). */
export function growRoad(io: LandIO, from: V2[], to: V2, S = 2): V2[] | null {
  const nx = Math.floor(io.W / S) + 1;
  const ny = Math.floor(io.H / S) + 1;
  const id = (i: number, j: number) => j * nx + i;
  const at = (n: number): V2 => [(n % nx) * S, Math.floor(n / nx) * S];
  const g = new Float32Array(nx * ny);
  const wet = new Uint8Array(nx * ny);
  const occ = new Uint8Array(nx * ny);
  for (let n = 0; n < nx * ny; n++) {
    const [x, y] = at(n);
    g[n] = io.ground(x, y);
    wet[n] = io.wet(x, y) ? 1 : 0;
    occ[n] = io.occupied?.(x, y) ? 1 : 0;
  }
  const near = (p: V2) =>
    id(Math.max(0, Math.min(nx - 1, Math.round(p[0] / S))), Math.max(0, Math.min(ny - 1, Math.round(p[1] / S))));
  const goal = near(to);
  const src = new Set(from.map(near));
  // Dijkstra from the place to the network (the first network node reached is the nearest by the land's cost)
  const dist = new Float64Array(nx * ny).fill(Infinity);
  const prev = new Int32Array(nx * ny).fill(-1);
  const heap: [number, number][] = [];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  dist[goal] = 0;
  push(0, goal);
  let hit = -1;
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    if (src.has(v)) {
      hit = v;
      break;
    }
    const i = v % nx;
    const j = (v - i) / nx;
    for (const [di, dj] of MOVES) {
      {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const w = id(ii, jj);
        const L = S * Math.hypot(di, dj);
        const grade = Math.abs(g[w] - g[v]) / L;
        if (grade > SLOPE) continue;
        // (past a road's grade the price climbs steeply: the walk winds — switchbacks — where it can)
        const over = Math.max(0, grade - ROAD_GRADE) / ROAD_GRADE;
        const c =
          L * (wet[w] ? BRIDGE_COST : 1 + (grade / ROAD_GRADE) ** 2 + 20 * over * over) * (occ[w] ? OCCUPIED_COST : 1);
        if (d + c < dist[w]) ((dist[w] = d + c), (prev[w] = v), push(d + c, w));
      }
    }
  }
  if (hit < 0) return null;
  // the walk, from the network to the place
  const walk: V2[] = [];
  for (let v = hit; v >= 0; v = prev[v]) walk.push(at(v));
  walk[walk.length - 1] = [to[0], to[1]];
  // pulled straight where a straight stretch keeps to a road's grade on dry land (or crosses no more water than the walk)
  const fine = (a: V2, b: V2) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / (S / 2)));
    let z0 = io.ground(a[0], a[1]);
    for (let k = 1; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n;
      const y = a[1] + ((b[1] - a[1]) * k) / n;
      if (io.wet(x, y) || io.occupied?.(x, y)) return false;
      const z = io.ground(x, y);
      if (Math.abs(z - z0) / (L / n) > ROAD_GRADE) return false;
      z0 = z;
    }
    return true;
  };
  const pulled: V2[] = [walk[0]];
  let i = 0;
  while (i < walk.length - 1) {
    let j = i + 1;
    while (j + 1 < walk.length && fine(walk[i], walk[j + 1])) j++;
    pulled.push(walk[j]);
    i = j;
  }
  return chaikin(pulled, 2);
}

/** Chaikin's corner cutting, `n` times (the ends kept) */
export function chaikin(p: V2[], n: number): V2[] {
  let cur = p;
  for (let k = 0; k < n; k++) {
    if (cur.length < 3) return cur;
    const out: V2[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      out.push(
        [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
        [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]],
      );
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

interface Mesh {
  count: number;
  verts: ArrayLike<number>;
  quads: ArrayLike<number>;
}

/** the nearest point of a polyline to q: its distance, signed by side (+ left of the way it runs), and its normal */
function nearestOn(curve: V2[], q: V2): { d: number; n: V2 } {
  let best = { d: Infinity, n: [0, 0] as V2, s: 1 };
  for (let k = 1; k < curve.length; k++) {
    const a = curve[k - 1];
    const b = curve[k];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const L2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / L2));
    const px = a[0] + ex * t;
    const py = a[1] + ey * t;
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d < best.d) {
      const L = Math.sqrt(L2);
      const n: V2 = [-ey / L, ex / L];
      const s = (q[0] - px) * n[0] + (q[1] - py) * n[1] >= 0 ? 1 : -1;
      best = { d, n, s };
    }
  }
  return { d: best.d * best.s, n: best.n };
}

/** how far a snap may move a vertex, of the mean side's length */
export const MAX_SNAP = 0.6;

function area(v: ArrayLike<number>, q: ArrayLike<number>, c: number): number {
  let a = 0;
  for (let k = 0; k < 4; k++) {
    const i = q[c * 4 + k];
    const j = q[c * 4 + ((k + 1) & 3)];
    a += v[i * 2] * v[j * 2 + 1] - v[j * 2] * v[i * 2 + 1];
  }
  return a / 2;
}

/**
 * The flattest corner a snap may leave a cell (the sine of its inner angle: 150 degrees). A house's walls meet at its
 * corners mitred and its roof hips over them (structures/pieces.ts); a corner flatter than this reads as a side with a
 * kink, a triangle, where the roof's eave misses the wall's top (structures.test "no wall pokes up through a roof").
 */
export const FLATTEST = 0.5;

/** a cell's flattest corner: the least sine of its four inner angles (negative: turned over or not convex there) */
function sharpness(v: ArrayLike<number>, q: ArrayLike<number>, c: number): number {
  let m = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = q[c * 4 + ((k + 3) & 3)];
    const b = q[c * 4 + k];
    const d = q[c * 4 + ((k + 1) & 3)];
    const ux = v[b * 2] - v[a * 2];
    const uy = v[b * 2 + 1] - v[a * 2 + 1];
    const wx = v[d * 2] - v[b * 2];
    const wy = v[d * 2 + 1] - v[b * 2 + 1];
    const l = Math.hypot(ux, uy) * Math.hypot(wx, wy);
    m = Math.min(m, l > 0 ? (ux * wy - uy * wx) / l : -1);
  }
  return m;
}

/**
 * The grid adapted to a road of `width` along `curve`: the vertices snapped onto its edges, the cells on it. Returns the
 * moved vertices (for QuadGrid.moveVerts) and the road's cells.
 */
export function adaptToCurve(mesh: Mesh, curve: V2[], width: number): { verts: Float32Array; road: number[] } {
  const v = Float32Array.from(mesh.verts);
  const nv = v.length / 2;
  let side = 0;
  for (let c = 0; c < mesh.count; c++)
    for (let k = 0; k < 4; k++) {
      const a = mesh.quads[c * 4 + k];
      const b = mesh.quads[c * 4 + ((k + 1) & 3)];
      side += Math.hypot(v[b * 2] - v[a * 2], v[b * 2 + 1] - v[a * 2 + 1]);
    }
  side /= mesh.count * 4;
  const half = width / 2;
  const reach = half + 0.5 * side;
  const was = Float32Array.from(v);
  for (let i = 0; i < nv; i++) {
    const { d, n } = nearestOn(curve, [v[i * 2], v[i * 2 + 1]]);
    const ad = Math.abs(d);
    if (ad > reach || ad < half / 2) continue;
    const to = Math.sign(d || 1) * half;
    let m = to - d;
    if (Math.abs(m) > MAX_SNAP * side) m = Math.sign(m) * MAX_SNAP * side;
    v[i * 2] += n[0] * m;
    v[i * 2 + 1] += n[1] * m;
  }
  // a cell the snaps left flatter at a corner than FLATTEST, or than the flattest corner the tile system made if that's
  // flatter still (turned over, or a corner pushed onto the line between its neighbours: a triangle the walls and roofs
  // can't mitre) — its vertices put back, again until none is (each pass puts some back: it ends)
  let floor = FLATTEST;
  for (let c = 0; c < mesh.count; c++) {
    const q = sharpness(was, mesh.quads, c);
    if (q > 0) floor = Math.min(floor, q);
  }
  for (let again = true; again; ) {
    again = false;
    for (let c = 0; c < mesh.count; c++) {
      if (sharpness(v, mesh.quads, c) >= Math.min(floor, sharpness(was, mesh.quads, c))) continue;
      for (let k = 0; k < 4; k++) {
        const i = mesh.quads[c * 4 + k];
        if (v[i * 2] === was[i * 2] && v[i * 2 + 1] === was[i * 2 + 1]) continue;
        v[i * 2] = was[i * 2];
        v[i * 2 + 1] = was[i * 2 + 1];
        again = true;
      }
    }
  }
  const road: number[] = [];
  for (let c = 0; c < mesh.count; c++) {
    let x = 0;
    let y = 0;
    for (let k = 0; k < 4; k++) {
      const i = mesh.quads[c * 4 + k];
      x += v[i * 2] / 4;
      y += v[i * 2 + 1] / 4;
    }
    if (Math.abs(nearestOn(curve, [x, y]).d) < half) road.push(c);
  }
  return { verts: v, road };
}

/**
 * The radial relax: `iters` passes, each cell's corners pulled toward a square of its own area turned to face `centre`
 * (best of its four turns), by `strength` × a weight fading from 1 at the centre to 0 at `radius`. Returns the moved
 * vertices.
 */
export function radialRelax(mesh: Mesh, centre: V2, radius: number, strength = 0.35, iters = 6): Float32Array {
  const v = Float32Array.from(mesh.verts);
  const nv = v.length / 2;
  for (let it = 0; it < iters; it++) {
    const acc = new Float64Array(nv * 2);
    const cnt = new Float64Array(nv);
    for (let c = 0; c < mesh.count; c++) {
      const ids = [0, 1, 2, 3].map((k) => mesh.quads[c * 4 + k]);
      const cx = ids.reduce((s, i) => s + v[i * 2], 0) / 4;
      const cy = ids.reduce((s, i) => s + v[i * 2 + 1], 0) / 4;
      const r = Math.hypot(cx - centre[0], cy - centre[1]);
      const w = Math.max(0, 1 - r / radius);
      if (w <= 0) continue;
      const a = Math.abs(area(v, mesh.quads, c));
      const h = Math.sqrt(a) / 2;
      const ang = Math.atan2(cy - centre[1], cx - centre[0]);
      const u: V2 = [Math.cos(ang) * h, Math.sin(ang) * h];
      const t: V2 = [-u[1], u[0]];
      // the square's corners, counter-clockwise; the turn that fits the cell's corners best
      const sq: V2[] = [
        [cx - u[0] - t[0], cy - u[1] - t[1]],
        [cx + u[0] - t[0], cy + u[1] - t[1]],
        [cx + u[0] + t[0], cy + u[1] + t[1]],
        [cx - u[0] + t[0], cy - u[1] + t[1]],
      ];
      let bk = 0;
      let bd = Infinity;
      for (let k = 0; k < 4; k++) {
        let d = 0;
        for (let m = 0; m < 4; m++)
          d += (sq[(m + k) & 3][0] - v[ids[m] * 2]) ** 2 + (sq[(m + k) & 3][1] - v[ids[m] * 2 + 1]) ** 2;
        if (d < bd) ((bd = d), (bk = k));
      }
      for (let m = 0; m < 4; m++) {
        const p = sq[(m + bk) & 3];
        acc[ids[m] * 2] += (p[0] - v[ids[m] * 2]) * w;
        acc[ids[m] * 2 + 1] += (p[1] - v[ids[m] * 2 + 1]) * w;
        cnt[ids[m]] += 1;
      }
    }
    const was = Float32Array.from(v);
    for (let i = 0; i < nv; i++) {
      if (!cnt[i]) continue;
      v[i * 2] += (strength * acc[i * 2]) / cnt[i];
      v[i * 2 + 1] += (strength * acc[i * 2 + 1]) / cnt[i];
    }
    for (let c = 0; c < mesh.count; c++)
      if (area(v, mesh.quads, c) <= 0)
        for (let k = 0; k < 4; k++) {
          const i = mesh.quads[c * 4 + k];
          v[i * 2] = was[i * 2];
          v[i * 2 + 1] = was[i * 2 + 1];
        }
  }
  return v;
}
