// (tilekit, docs/design/TILEKIT.md §1–§4) The irregular grid's cells welded into a quad mesh on the CPU (the lab reads
// the GPU grid lab's cells back once: shared corners are bit-identical, so the weld is exact), occupancy on cells from
// rectangle booleans, and the wall panels (an edge between an occupied and an empty cell, a storey) with their joints
// (the run of occupied cells round each panel end: its interior angle, the joint kind, the mitre).

import { jointKind } from './cases';

export interface GridMesh {
  /** vertex positions, x y */
  xy: Float64Array;
  /** 4 vertex ids a cell, counter-clockwise */
  cells: Int32Array;
  /** 4 a cell: the cell across edge k (corner k → k + 1), -1 none */
  across: Int32Array;
  nv: number;
  nc: number;
}

/** cells from the GPU grid lab's buffer (float view; `stride` words a cell, corners x y in the first 8) welded */
export function weldCells(raw: Float32Array, count: number, stride = 10): GridMesh {
  const bits = new Uint32Array(raw.buffer, raw.byteOffset, raw.length);
  const ids = new Map<string, number>();
  const xy: number[] = [];
  const cells = new Int32Array(count * 4);
  for (let c = 0; c < count; c++) {
    const q: number[] = [];
    for (let j = 0; j < 4; j++) {
      const o = c * stride + j * 2;
      const key = bits[o] + ',' + bits[o + 1];
      let id = ids.get(key);
      if (id === undefined) {
        id = xy.length / 2;
        ids.set(key, id);
        xy.push(raw[o], raw[o + 1]);
      }
      q.push(id);
    }
    // (counter-clockwise: the grid writes them so; checked, not assumed)
    let area = 0;
    for (let j = 0; j < 4; j++) {
      const a = q[j];
      const b = q[(j + 1) % 4];
      area += xy[a * 2] * xy[b * 2 + 1] - xy[b * 2] * xy[a * 2 + 1];
    }
    if (area < 0) q.reverse();
    cells.set(q, c * 4);
  }
  return finish(new Float64Array(xy), cells);
}

/** a mesh from positions and CCW quads (tests build small ones by hand) */
export function finish(xy: Float64Array, cells: Int32Array): GridMesh {
  const nc = cells.length / 4;
  const across = new Int32Array(nc * 4).fill(-1);
  const half = new Map<string, number>();
  for (let c = 0; c < nc; c++) for (let k = 0; k < 4; k++) half.set(cells[c * 4 + k] + '>' + cells[c * 4 + ((k + 1) % 4)], c);
  for (let c = 0; c < nc; c++) {
    for (let k = 0; k < 4; k++) {
      const o = half.get(cells[c * 4 + ((k + 1) % 4)] + '>' + cells[c * 4 + k]);
      if (o !== undefined) across[c * 4 + k] = o;
    }
  }
  return { xy, cells, across, nv: xy.length / 2, nc };
}

export const P = (m: GridMesh, v: number): [number, number] => [m.xy[v * 2], m.xy[v * 2 + 1]];

export function centroid(m: GridMesh, c: number): [number, number] {
  let x = 0;
  let y = 0;
  for (let k = 0; k < 4; k++) {
    x += m.xy[m.cells[c * 4 + k] * 2];
    y += m.xy[m.cells[c * 4 + k] * 2 + 1];
  }
  return [x / 4, y / 4];
}

/** the interior angle (degrees) of cell c at its corner k */
export function cornerAngle(m: GridMesh, c: number, k: number): number {
  const [vx, vy] = P(m, m.cells[c * 4 + k]);
  const [nx, ny] = P(m, m.cells[c * 4 + ((k + 1) % 4)]);
  const [px, py] = P(m, m.cells[c * 4 + ((k + 3) % 4)]);
  const ax = nx - vx;
  const ay = ny - vy;
  const bx = px - vx;
  const by = py - vy;
  let a = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  if (a < 0) a += Math.PI * 2;
  return (a * 180) / Math.PI;
}

/** the index of vertex v among cell c's corners (-1 none) */
export const cornerOf = (m: GridMesh, c: number, v: number): number => {
  for (let k = 0; k < 4; k++) if (m.cells[c * 4 + k] === v) return k;
  return -1;
};

/** valence of every vertex whose ring of cells is closed (interior), as a histogram valence → count */
export function valences(m: GridMesh): Map<number, number> {
  const n = new Int32Array(m.nv);
  const open = new Uint8Array(m.nv);
  for (let c = 0; c < m.nc; c++) {
    for (let k = 0; k < 4; k++) {
      n[m.cells[c * 4 + k]]++;
      if (m.across[c * 4 + k] < 0) {
        open[m.cells[c * 4 + k]] = 1;
        open[m.cells[c * 4 + ((k + 1) % 4)]] = 1;
      }
    }
  }
  const h = new Map<number, number>();
  for (let v = 0; v < m.nv; v++) if (!open[v]) h.set(n[v], (h.get(n[v]) ?? 0) + 1);
  return h;
}

// ---- occupancy: rectangle booleans → storeys a cell ----

/** a rectangle of the massing in world metres: centre, size (w along its axis, d across), turn (radians), storeys;
 *  `sub` cuts instead of adding */
export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
  rot: number;
  storeys: number;
  sub?: boolean;
}

export function inRect(r: Rect, x: number, y: number): boolean {
  const c = Math.cos(r.rot);
  const s = Math.sin(r.rot);
  const dx = x - r.x;
  const dy = y - r.y;
  const u = dx * c + dy * s;
  const v = -dx * s + dy * c;
  return Math.abs(u) <= r.w / 2 && Math.abs(v) <= r.d / 2;
}

/** storeys a cell (0 empty): its centroid in the union of the adding rectangles (the most storeys of those holding
 *  it), cleared by a cutting one. Stacks are monotone by construction (a storey's cells ⊆ the one below). */
export function cellTops(m: GridMesh, rects: Rect[]): Uint8Array {
  const t = new Uint8Array(m.nc);
  for (let c = 0; c < m.nc; c++) {
    const [x, y] = centroid(m, c);
    let n = 0;
    for (const r of rects) if (!r.sub && inRect(r, x, y)) n = Math.max(n, r.storeys);
    for (const r of rects) if (r.sub && inRect(r, x, y)) n = 0;
    t[c] = n;
  }
  return t;
}

/** the rectangle each occupied cell takes its storeys from (the first adding one with the most storeys), -1 none: a
 *  house colour a rectangle, so the massing reads */
export function cellOwners(m: GridMesh, rects: Rect[], tops: Uint8Array): Int8Array {
  const o = new Int8Array(m.nc).fill(-1);
  for (let c = 0; c < m.nc; c++) {
    if (!tops[c]) continue;
    const [x, y] = centroid(m, c);
    rects.forEach((r, i) => {
      if (o[c] < 0 && !r.sub && r.storeys === tops[c] && inRect(r, x, y)) o[c] = i;
    });
  }
  return o;
}

/** connected components of cells with tops > 0 (through shared edges): a building id a cell, -1 empty */
export function buildings(m: GridMesh, tops: Uint8Array, same?: (a: number, b: number) => boolean): Int32Array {
  const id = new Int32Array(m.nc).fill(-1);
  let n = 0;
  for (let c0 = 0; c0 < m.nc; c0++) {
    if (!tops[c0] || id[c0] >= 0) continue;
    const st = [c0];
    id[c0] = n;
    while (st.length) {
      const c = st.pop()!;
      for (let k = 0; k < 4; k++) {
        const o = m.across[c * 4 + k];
        if (o < 0 || !tops[o] || id[o] >= 0 || (same && !same(c, o))) continue;
        id[o] = n;
        st.push(o);
      }
    }
    n++;
  }
  return id;
}

// ---- wall panels and joints ----

export interface Joint {
  /** cases.ts JOINT: 0 convex, 1 straight, 2 concave */
  kind: number;
  /** the run's interior angle, degrees */
  angle: number;
  /** the mitre vector: (n1 + n2) / (1 + n1·n2), length clamped */
  mx: number;
  my: number;
}

export interface Panel {
  /** the occupied cell and its edge k (corner k → k + 1) */
  cell: number;
  k: number;
  a: number;
  b: number;
  /** storey */
  s: number;
  /** the occupied cell's top storey (a cornice, an eave) */
  top: boolean;
  len: number;
  /** outward normal (to the right of a → b) */
  nx: number;
  ny: number;
  start: Joint;
  end: Joint;
  /** the next panel along the outline (from b) */
  next: number;
  prev: number;
}

/** the mitre's length cap: a sharp convex corner (~60°) needs ×2; past 2.5 its cornice would shoot out (TILEKIT Q4) */
export const MITRE_MAX = 2.5;

export function mitre(n1x: number, n1y: number, n2x: number, n2y: number): [number, number] {
  const d = 1 + n1x * n2x + n1y * n2y;
  let mx = (n1x + n2x) / Math.max(d, 1e-6);
  let my = (n1y + n2y) / Math.max(d, 1e-6);
  const l = Math.hypot(mx, my);
  if (l > MITRE_MAX) {
    mx *= MITRE_MAX / l;
    my *= MITRE_MAX / l;
  }
  return [mx, my];
}

export interface Walls {
  panels: Panel[];
  /** (storey, vertex) pairs where two or more occupied runs touch (TILEKIT Q5) */
  pinches: number;
  /** joints by kind [convex, straight, concave] */
  joints: [number, number, number];
}

/** the wall panels of every storey and their joints */
export function walls(m: GridMesh, tops: Uint8Array): Walls {
  const panels: Panel[] = [];
  const at = new Map<string, number>();
  let maxTop = 0;
  for (let c = 0; c < m.nc; c++) maxTop = Math.max(maxTop, tops[c]);
  const occ = (c: number, s: number) => c >= 0 && tops[c] > s;
  for (let s = 0; s < maxTop; s++) {
    for (let c = 0; c < m.nc; c++) {
      if (!occ(c, s)) continue;
      for (let k = 0; k < 4; k++) {
        if (occ(m.across[c * 4 + k], s)) continue;
        const a = m.cells[c * 4 + k];
        const b = m.cells[c * 4 + ((k + 1) % 4)];
        const [ax, ay] = P(m, a);
        const [bx, by] = P(m, b);
        const len = Math.hypot(bx - ax, by - ay);
        const z: Joint = { kind: 1, angle: 180, mx: 0, my: 0 };
        at.set(`${s}:${c}:${k}`, panels.length);
        panels.push({ cell: c, k, a, b, s, top: tops[c] === s + 1, len, nx: (by - ay) / len, ny: -(bx - ax) / len, start: z, end: z, next: -1, prev: -1 });
      }
    }
  }
  // each panel's end: walk round b through the occupied cells (clockwise from its own cell) to the next wall edge
  const joints: [number, number, number] = [0, 0, 0];
  const startsAt = new Map<string, number>();
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    let cur = p.cell;
    let ib = (p.k + 1) % 4;
    let angle = cornerAngle(m, cur, ib);
    let found = -1;
    for (let guard = 0; guard < 12; guard++) {
      const o = m.across[cur * 4 + ib];
      if (!occ(o, p.s)) {
        found = at.get(`${p.s}:${cur}:${ib}`)!;
        break;
      }
      cur = o;
      ib = cornerOf(m, cur, p.b);
      angle += cornerAngle(m, cur, ib);
    }
    if (found < 0) throw new Error(`tilekit: no next wall round vertex ${p.b} (storey ${p.s})`);
    const q = panels[found];
    const [mx, my] = mitre(p.nx, p.ny, q.nx, q.ny);
    const j: Joint = { kind: jointKind(angle), angle, mx, my };
    joints[j.kind]++;
    p.end = j;
    p.next = found;
    q.start = j;
    q.prev = i;
    const key = `${p.s}:${p.b}`;
    startsAt.set(key, (startsAt.get(key) ?? 0) + 1);
  }
  let pinches = 0;
  for (const n of startsAt.values()) if (n > 1) pinches++;
  return { panels, pinches, joints };
}
