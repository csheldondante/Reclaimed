// (tilekit, TILEKIT.md §4–§6) A block on the grid: occupancy → panels → module instances (walls, bands, corners), the
// roofs (one height-field surface a top region, sampled on each cell's subdivision, eave overhangs swept from the
// top storey's panels), the ground's cells, and the control grid (wonk and sag). CPU, once a change; the GPU only
// draws (instanced modules + one world-space mesh).

import { buildings, centroid, P, walls, type GridMesh, type Panel, type Walls } from './grid';
import { A, MAT, VF } from './kit';
import { packInstance, IF } from './sweep';
import type { RGB, Theme } from './theme';

export const storeyZ = (t: Theme, s: number): number => (s === 0 ? 0 : t.groundH + (s - 1) * t.storeyH);
export const storeyH = (t: Theme, s: number): number => (s === 0 ? t.groundH : t.storeyH);

const hash = (x: number): number => {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

export interface ControlGrid {
  origin: [number, number, number];
  step: [number, number, number];
  dims: [number, number, number];
  /** vec4 a point (dx dy dz 0) */
  data: Float32Array;
}

export interface Block {
  /** module name → its instances (IF floats each) */
  inst: Map<string, number[]>;
  /** world-space vertices (VF floats, anchor world): roofs, ground */
  world: number[];
  walls: Walls;
  ctl: ControlGrid;
  stats: { cells: number; buildings: number; panels: number; doors: number; windows: number; blanks: number; corners: number; roofTris: number };
  /** the ground storey's convex corners (the supports sag measures from) */
  supports: [number, number][];
  centre: [number, number];
  height: number;
}

export interface BlockOpts {
  /** towards the street: a building's door goes on its ground panel facing most this way */
  street: [number, number];
  sag: number;
  wonk: number;
  /** ground cells drawn within this radius of the block's centre */
  groundR: number;
  /** (grid.ts cellOwners) a colour a massing rectangle; else a colour a building */
  owners?: Int8Array;
}

export function buildBlock(m: GridMesh, tops: Uint8Array, t: Theme, o: BlockOpts): Block {
  const w = walls(m, tops);
  const bid = buildings(m, tops);
  const inst = new Map<string, number[]>();
  const put = (name: string) => {
    let a = inst.get(name);
    if (!a) inst.set(name, (a = []));
    return a;
  };
  const tintOf = (c: number): RGB => t.wall.palette[Math.floor(hash((o.owners ? o.owners[c] + 100 : bid[c]) * 7 + 3) * t.wall.palette.length)];
  /** a hash of where an edge is (cell and vertex ids follow the GPU's write order, which varies run to run) */
  const edgeHash = (p: Panel) => {
    const [ax, ay] = P(m, p.a);
    const [bx, by] = P(m, p.b);
    return hash(Math.round((ax + bx) * 20) * 7919 + Math.round((ay + by) * 20) * 104729 + p.s * 31);
  };
  // a door a building: its ground panel facing the street most, long enough
  const door = new Map<number, number>();
  const minDoor = t.door.w + 2 * t.door.frame + 0.5;
  w.panels.forEach((p, i) => {
    if (p.s !== 0 || p.len < minDoor) return;
    const b = bid[p.cell];
    const d = p.nx * o.street[0] + p.ny * o.street[1];
    const cur = door.get(b);
    if (cur === undefined) door.set(b, i);
    else {
      const q = w.panels[cur];
      if (d > q.nx * o.street[0] + q.ny * o.street[1]) door.set(b, i);
    }
  });
  const doors = new Set(door.values());
  const st = { cells: 0, buildings: 0, panels: w.panels.length, doors: 0, windows: 0, blanks: 0, corners: 0, roofTris: 0 };
  for (let c = 0; c < m.nc; c++) if (tops[c]) st.cells++;
  st.buildings = new Set([...bid].filter((b) => b >= 0)).size;
  // corner stacks: quoins at convex joints; half timber posts at every joint (not on a stone ground storey)
  const cornerAt = (kind: number, g: boolean) => (t.quoins ? kind === 0 : t.timber !== null && (!g || t.timber.groundToo));
  w.panels.forEach((p, i) => {
    const g = p.s === 0;
    const tag = g ? 'ground' : 'upper';
    const z0 = storeyZ(t, p.s);
    const tint = tintOf(p.cell);
    const seed = edgeHash(p);
    let kind: string;
    if (doors.has(i)) {
      kind = 'wall-door';
      st.doors++;
    } else if (p.len >= t.minWindowPanel && seed >= t.blankOdds) {
      kind = `wall-window-${tag}`;
      st.windows++;
    } else {
      kind = `wall-blank-${tag}`;
      st.blanks++;
    }
    packInstance(put(kind), m, p, z0, false, tint, seed);
    if (g) packInstance(put('plinth'), m, p, 0, false, tint, seed);
    const top = z0 + storeyH(t, p.s);
    if (p.top) packInstance(put('cornice'), m, p, top, false, tint, seed);
    else if (t.band) packInstance(put('band'), m, p, top, false, tint, seed);
    if (cornerAt(p.end.kind, g)) {
      packInstance(put(`corner-${tag}`), m, p, z0, false, tint, seed);
      st.corners++;
    }
    if (cornerAt(p.start.kind, g)) {
      packInstance(put(`corner-${tag}-alt`), m, p, z0, true, tint, seed);
      st.corners++;
    }
  });
  const world: number[] = [];
  const before = world.length;
  roofs(m, tops, w.panels, t, bid, world);
  st.roofTris = (world.length - before) / VF / 3;
  // the block's centre and height, the sag's supports
  let cx = 0;
  let cy = 0;
  let maxTop = 0;
  for (let c = 0; c < m.nc; c++) {
    if (!tops[c]) continue;
    const [x, y] = centroid(m, c);
    cx += x;
    cy += y;
    maxTop = Math.max(maxTop, tops[c]);
  }
  cx /= st.cells;
  cy /= st.cells;
  ground(m, tops, t, [cx, cy], o.groundR, world);
  // (the sag's supports: the corners of the footprint's convex hull — the building's main corners; every small jog of
  // the cell outline as a support left no span long enough to sag, DEVLOG)
  const supports = hull(w.panels.filter((p) => p.s === 0).map((p) => P(m, p.a)));
  const height = storeyZ(t, maxTop) + t.roof.cap + 1;
  const ctl = controlGrid(m, tops, [cx, cy], height, t, o, supports);
  return { inst, world, walls: w, ctl, stats: st, supports, centre: [cx, cy], height };
}

/** the convex hull of points (Andrew's monotone chain), counter-clockwise */
export function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
    up.push(p[i]);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** a world-space vertex */
export function wv(out: number[], p: [number, number, number], n: [number, number, number], col: RGB, mat: number) {
  out.push(p[0], p[1], p[2], A.world, n[0], n[1], n[2], 1, col[0], col[1], col[2], mat);
}
export function wtri(out: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number], col: RGB, mat: number, up: boolean) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / l, n[1] / l, n[2] / l];
  if (up && n[2] < 0) n = [-n[0], -n[1], -n[2]];
  wv(out, a, n, col, mat);
  wv(out, b, n, col, mat);
  wv(out, c, n, col, mat);
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** the roofs: a surface a top region (cells whose top storey is k, joined by edges), h = eave + thickness +
 *  min(cap, pitch · distance to the region's eave panels); sampled on each cell's 4 sub-quads, each split on the
 *  diagonal that fits h better; an overhang swept out of each eave panel with its mitres (top, fascia, soffit) */
export function roofs(m: GridMesh, tops: Uint8Array, panels: Panel[], t: Theme, bid: Int32Array, out: number[]) {
  const R = t.roof;
  let maxTop = 0;
  for (let c = 0; c < m.nc; c++) maxTop = Math.max(maxTop, tops[c]);
  for (let k = 0; k < maxTop; k++) {
    const reg = buildings(m, tops, (a, b) => tops[a] === k + 1 && tops[b] === k + 1);
    const comps = new Map<number, number[]>();
    for (let c = 0; c < m.nc; c++) if (tops[c] === k + 1) comps.set(reg[c], [...(comps.get(reg[c]) ?? []), c]);
    const eaveZ = storeyZ(t, k) + storeyH(t, k);
    for (const [r, cells] of comps) {
      const inReg = new Set(cells);
      const eaves = panels.filter((p) => p.s === k && p.top && inReg.has(p.cell));
      const col = R.palette[Math.floor(hash(bid[cells[0]] * 13 + 5) * R.palette.length)];
      const h = (x: number, y: number): number => {
        let d = Infinity;
        for (const p of eaves) {
          const [ax, ay] = P(m, p.a);
          const [bx, by] = P(m, p.b);
          d = Math.min(d, segDist(x, y, ax, ay, bx, by));
        }
        if (!eaves.length) d = 0;
        return eaveZ + R.thickness + Math.min(R.cap, R.pitch * d);
      };
      for (const c of cells) {
        const v = [0, 1, 2, 3].map((i) => P(m, m.cells[c * 4 + i]));
        const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
        const cen = centroid(m, c);
        for (let i = 0; i < 4; i++) {
          const q: [number, number][] = [v[i], mid(v[i], v[(i + 1) % 4]), cen, mid(v[(i + 3) % 4], v[i])];
          const p3 = q.map(([x, y]) => [x, y, h(x, y)] as [number, number, number]);
          const m02 = mid(q[0], q[2]);
          const m13 = mid(q[1], q[3]);
          const e02 = Math.abs(h(m02[0], m02[1]) - (p3[0][2] + p3[2][2]) / 2);
          const e13 = Math.abs(h(m13[0], m13[1]) - (p3[1][2] + p3[3][2]) / 2);
          if (e02 <= e13) {
            wtri(out, p3[0], p3[1], p3[2], col, MAT.roof, true);
            wtri(out, p3[0], p3[2], p3[3], col, MAT.roof, true);
          } else {
            wtri(out, p3[1], p3[2], p3[3], col, MAT.roof, true);
            wtri(out, p3[1], p3[3], p3[0], col, MAT.roof, true);
          }
        }
      }
      // the overhangs
      const o = R.overhang;
      const zi = eaveZ + R.thickness;
      const zo = zi - R.pitch * o;
      const soff: RGB = [R.fascia[0] * 0.8, R.fascia[1] * 0.8, R.fascia[2] * 0.8];
      for (const p of eaves) {
        const [ax, ay] = P(m, p.a);
        const [bx, by] = P(m, p.b);
        const ia: [number, number, number] = [ax, ay, zi];
        const ib: [number, number, number] = [bx, by, zi];
        const oa: [number, number, number] = [ax + p.start.mx * o, ay + p.start.my * o, zo];
        const ob: [number, number, number] = [bx + p.end.mx * o, by + p.end.my * o, zo];
        wtri(out, ia, ib, ob, col, MAT.roof, true);
        wtri(out, ia, ob, oa, col, MAT.roof, true);
        const oa2: [number, number, number] = [oa[0], oa[1], zo - R.thickness];
        const ob2: [number, number, number] = [ob[0], ob[1], zo - R.thickness];
        const fn: [number, number, number] = [p.nx, p.ny, 0];
        for (const q of [oa, ob, ob2, oa, ob2, oa2]) wv(out, q, fn, R.fascia, MAT.trim);
        const sa: [number, number, number] = [ax, ay, zo - R.thickness];
        const sb: [number, number, number] = [bx, by, zo - R.thickness];
        for (const q of [sa, sb, ob2, sa, ob2, oa2]) wv(out, q, [0, 0, -1], soff, MAT.trim);
      }
      void r;
    }
  }
}

/** the ground: every cell near the block a flat slab (inset, so the grid's lines show), a darker base under */
function ground(m: GridMesh, tops: Uint8Array, t: Theme, c: [number, number], R: number, out: number[]) {
  const up: [number, number, number] = [0, 0, 1];
  for (let i = 0; i < m.nc; i++) {
    const [x, y] = centroid(m, i);
    if (Math.hypot(x - c[0], y - c[1]) > R) continue;
    const q = [0, 1, 2, 3].map((k) => {
      const [px, py] = P(m, m.cells[i * 4 + k]);
      return [px + (x - px) * 0.035, py + (y - py) * 0.035, 0] as [number, number, number];
    });
    const j = 0.94 + hash(i * 3 + 1) * 0.1;
    const col: RGB = tops[i] ? t.ground.paving : [t.ground.col[0] * j, t.ground.col[1] * j, t.ground.col[2] * j];
    for (const p of [q[0], q[1], q[2], q[0], q[2], q[3]]) wv(out, p, up, col, MAT.ground);
  }
  const z = -0.025;
  const b = [
    [c[0] - R - 6, c[1] - R - 6, z],
    [c[0] + R + 6, c[1] - R - 6, z],
    [c[0] + R + 6, c[1] + R + 6, z],
    [c[0] - R - 6, c[1] + R + 6, z],
  ] as [number, number, number][];
  for (const p of [b[0], b[1], b[2], b[0], b[2], b[3]]) wv(out, p, up, t.ground.paving, MAT.ground);
}

/** the control grid over the block: wonk (a hashed lean and twist, growing with height) and sag (z falling with
 *  height and with distance from the ground storey's convex corners) */
export function controlGrid(m: GridMesh, tops: Uint8Array, c: [number, number], height: number, t: Theme, o: BlockOpts, supports: [number, number][]): ControlGrid {
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (let i = 0; i < m.nc; i++) {
    if (!tops[i]) continue;
    for (let k = 0; k < 4; k++) {
      const [x, y] = P(m, m.cells[i * 4 + k]);
      lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
      hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
    }
  }
  const pad = 3;
  const step: [number, number, number] = [2.7, 2.7, t.storeyH];
  const origin: [number, number, number] = [lo[0] - pad, lo[1] - pad, 0];
  const dims: [number, number, number] = [Math.ceil((hi[0] - lo[0] + 2 * pad) / step[0]) + 1, Math.ceil((hi[1] - lo[1] + 2 * pad) / step[1]) + 1, Math.ceil(height / step[2]) + 1];
  const data = new Float32Array(dims[0] * dims[1] * dims[2] * 4);
  for (let k = 0; k < dims[2]; k++) {
    const z = k * step[2];
    const hz = Math.min(1, z / height);
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        const x = origin[0] + i * step[0];
        const y = origin[1] + j * step[1];
        const n = ((k * dims[1] + j) * dims[0] + i) * 4;
        const hs = hash(i * 73856093 + j * 19349663 + k * 83492791);
        const ha = hash(i * 19349663 + j * 83492791 + 17);
        // wonk: a lean (the same direction through a column, varying across), more with height
        const lean = o.wonk * hz;
        data[n] = (hs - 0.5) * 2 * lean;
        data[n + 1] = (ha - 0.5) * 2 * lean;
        data[n + 2] = (hash(i * 31 + j * 57 + k * 101) - 0.5) * o.wonk * 0.5;
        // sag: supports at the corners, mid-spans drop
        let d = Infinity;
        for (const [sx, sy] of supports) d = Math.min(d, Math.hypot(x - sx, y - sy));
        const span = Math.min(1, d / 6);
        data[n + 2] -= o.sag * hz * span * span * (3 - 2 * span);
      }
    }
  }
  void c;
  return { origin, step, dims, data };
}

export { IF };
