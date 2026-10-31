// A body's nodes from its cells (the physics design: "nodes come from the voxels by clustering"). Pure: no GPU, unit
// tested (test/unit/solver-build.test.ts).
//
// The cells are grouped into blocks of g × g × g lattice cells (storage column, row, cell z), g the least that gives at
// most NN nodes (64: one workgroup a body); a node stands at its block's centre of mass with its mass. Two nodes are
// bonded when a cell of one touches a cell of the other (the six hex neighbours, above and below): the shape's own
// connections — an arch's legs are joined through its span, not through the air between them. Contact points: up to
// NN corners of the cells' exposed faces (hex prism corners), spread by farthest-point sampling from the lowest, each
// riding the node nearest it.

import { cellPos, nbr } from '../world/lattice';
import type { SolverCell, V3 } from '../api/contracts/solver';
import { solverMat } from './materials';

/** nodes (and contact points) a body at most: solver.wgsl NN */
export const NN = 64;

export interface BuiltNode {
  /** rest position (world cells, the spawn frame) */
  rest: V3;
  mass: number;
  /** its main material */
  mat: number;
  /** cells in it */
  cells: number;
  pinned: boolean;
  /**
   * which faces of its block are the body's surface (bits: 0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z — a cell in it with
   * nothing beside it that way): another body is pushed out only through these (the blocks tile the body: through an
   * inner face it would be pushed sideways into the next block)
   */
  exposed: number;
}

export interface Built {
  nodes: BuiltNode[];
  /** bonds as bit masks: node i's [low 32, high 32] */
  bonds: [number, number][];
  points: { rest: V3; node: number }[];
  /** block size (cells) */
  g: number;
  com: V3;
  mass: number;
  cells: number;
  /** about the centre of mass, cells */
  radius: number;
  /** the body's main material (by mass) */
  mat: number;
  /** each cell's node, and whether it's on the surface (something beside it is empty): what's drawn of it */
  cellNode: Int32Array;
  surface: boolean[];
}

/** a cell's centre (world) */
export function cellCentre(c: { x: number; y: number; z: number }): V3 {
  const [x, y] = cellPos(c.x, c.y);
  return [x, y, c.z + 0.5];
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** the cells' centre of mass where they stand, by the solver's densities (what buildBody's `com` comes to) */
export function restComOf(cells: readonly SolverCell[]): V3 {
  let m = 0;
  const c: V3 = [0, 0, 0];
  for (const k of cells) {
    const d = solverMat(k.mat).density;
    const p = cellCentre(k);
    for (let a = 0; a < 3; a++) c[a] += p[a] * d;
    m += d;
  }
  return [c[0] / m, c[1] / m, c[2] / m];
}

/** `minBlock`: the least block size (a deformable's nodes span its members' sections: the loads through a bond are over
 *  the section a node stands for, and a node a cell wide would take a girder's whole bend through one cell) */
export function buildBody(cells: readonly SolverCell[], pinned?: (c: SolverCell) => boolean, minBlock = 1): Built | null {
  if (!cells.length) return null;
  const at = new Map<string, number>();
  cells.forEach((c, i) => at.set(key(c.x, c.y, c.z), i));
  // the block size: the least giving <= NN blocks
  let g = Math.max(1, minBlock);
  let blockOf: (c: SolverCell) => string = () => '';
  for (; ; g++) {
    const gg = g;
    blockOf = (c) => key(Math.floor(c.x / gg), Math.floor(c.y / gg), Math.floor(c.z / gg));
    const set = new Set(cells.map(blockOf));
    if (set.size <= NN) break;
  }
  const blockIdx = new Map<string, number>();
  const nodeOfCell = new Int32Array(cells.length);
  const acc: { p: V3; m: number; cells: number; mats: Map<number, number>; pinned: boolean; exposed: number }[] = [];
  cells.forEach((c, i) => {
    const k = blockOf(c);
    let n = blockIdx.get(k);
    if (n === undefined) {
      n = acc.length;
      blockIdx.set(k, n);
      acc.push({ p: [0, 0, 0], m: 0, cells: 0, mats: new Map(), pinned: false, exposed: 0 });
    }
    nodeOfCell[i] = n;
    const a = acc[n];
    const m = solverMat(c.mat).density;
    const p = cellCentre(c);
    for (let d = 0; d < 3; d++) a.p[d] += p[d] * m;
    a.m += m;
    a.cells++;
    a.mats.set(c.mat, (a.mats.get(c.mat) ?? 0) + m);
    if (pinned?.(c)) a.pinned = true;
    const empty = (x: number, y: number, z: number) => !at.has(key(x, y, z));
    const nb = (k: number) => nbr(c.x, c.y, k);
    if (empty(...nb(0), c.z)) a.exposed |= 1;
    if (empty(...nb(1), c.z)) a.exposed |= 2;
    if (empty(...nb(2), c.z) || empty(...nb(4), c.z)) a.exposed |= 4;
    if (empty(...nb(3), c.z) || empty(...nb(5), c.z)) a.exposed |= 8;
    if (empty(c.x, c.y, c.z + 1)) a.exposed |= 16;
    if (empty(c.x, c.y, c.z - 1)) a.exposed |= 32;
  });
  const main = (mats: Map<number, number>) => [...mats].sort((x, y) => y[1] - x[1])[0][0];
  const nodes: BuiltNode[] = acc.map((a) => ({ rest: [a.p[0] / a.m, a.p[1] / a.m, a.p[2] / a.m], mass: a.m, mat: main(a.mats), cells: a.cells, pinned: a.pinned, exposed: a.exposed }));
  // bonds: cells touching across blocks
  const bonds: [number, number][] = nodes.map(() => [0, 0]);
  const bond = (i: number, j: number) => {
    if (i === j) return;
    bonds[i][j >> 5] = (bonds[i][j >> 5] | (1 << (j & 31))) >>> 0;
    bonds[j][i >> 5] = (bonds[j][i >> 5] | (1 << (i & 31))) >>> 0;
  };
  cells.forEach((c, i) => {
    const ni = nodeOfCell[i];
    const near: [number, number, number][] = [[c.x, c.y, c.z + 1], [c.x, c.y, c.z - 1]];
    for (let k = 0; k < 6; k++) {
      const [x, y] = nbr(c.x, c.y, k);
      near.push([x, y, c.z]);
    }
    for (const [x, y, z] of near) {
      const j = at.get(key(x, y, z));
      if (j !== undefined) bond(ni, nodeOfCell[j]);
    }
  });
  // the whole: centre of mass, radius
  let mass = 0;
  const com: V3 = [0, 0, 0];
  for (const n of nodes) {
    mass += n.mass;
    for (let d = 0; d < 3; d++) com[d] += n.rest[d] * n.mass;
  }
  for (let d = 0; d < 3; d++) com[d] /= mass;
  const mats = new Map<number, number>();
  for (const n of nodes) mats.set(n.mat, (mats.get(n.mat) ?? 0) + n.mass);
  // contact points: the exposed faces' corners
  const cand = new Map<string, V3>();
  // (a little inside the hexagon: a corner exactly where three cells meet lies on the edge of every block round it)
  const R = 0.85 / Math.sqrt(3);
  let radius = 0;
  cells.forEach((c) => {
    const [px, py] = cellPos(c.x, c.y);
    const open = (x: number, y: number, z: number) => !at.has(key(x, y, z));
    const sides: boolean[] = [];
    for (let k = 0; k < 6; k++) {
      const [x, y] = nbr(c.x, c.y, k);
      sides.push(open(x, y, c.z));
    }
    const up = open(c.x, c.y, c.z + 1);
    const down = open(c.x, c.y, c.z - 1);
    if (!up && !down && !sides.some(Boolean)) return;
    for (const [zz, faceOpen] of [[c.z, down], [c.z + 1, up]] as [number, boolean][]) {
      for (let k = 0; k < 6; k++) {
        // a corner is exposed when its cap is open or a side it touches is
        if (!faceOpen && !sides.some(Boolean)) continue;
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        const p: V3 = [px + Math.cos(a) * R, py + Math.sin(a) * R, zz];
        cand.set(`${p[0].toFixed(3)},${p[1].toFixed(3)},${zz}`, p);
      }
    }
    const d = Math.hypot(px - com[0], py - com[1], c.z + 0.5 - com[2]) + 0.8;
    radius = Math.max(radius, d);
  });
  const list = [...cand.values()];
  const points: { rest: V3; node: number }[] = [];
  if (list.length) {
    // farthest-point sampling from the lowest corner
    let first = 0;
    for (let i = 1; i < list.length; i++) if (list[i][2] < list[first][2]) first = i;
    const dist = new Float64Array(list.length).fill(Infinity);
    let next = first;
    for (let s = 0; s < Math.min(NN, list.length); s++) {
      const p = list[next];
      let best = 0;
      let bd = Infinity;
      nodes.forEach((n, i) => {
        const d = Math.hypot(n.rest[0] - p[0], n.rest[1] - p[1], n.rest[2] - p[2]);
        if (d < bd) [bd, best] = [d, i];
      });
      points.push({ rest: p, node: best });
      dist[next] = -1;
      let far = -1;
      for (let i = 0; i < list.length; i++) {
        if (dist[i] < 0) continue;
        const q = list[i];
        dist[i] = Math.min(dist[i], Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
        if (far < 0 || dist[i] > dist[far]) far = i;
      }
      if (far < 0) break;
      next = far;
    }
  }
  const surface = cells.map((c) => {
    if (!at.has(key(c.x, c.y, c.z + 1)) || !at.has(key(c.x, c.y, c.z - 1))) return true;
    for (let k = 0; k < 6; k++) {
      const [x, y] = nbr(c.x, c.y, k);
      if (!at.has(key(x, y, c.z))) return true;
    }
    return false;
  });
  return { nodes, bonds, points, g, com, mass, cells: cells.length, radius, mat: main(mats), cellNode: nodeOfCell, surface };
}
