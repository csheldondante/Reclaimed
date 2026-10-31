// A body's own mesh (round 120, the user: "Rendering and simulation should not be coupled that way" — one mesh a body,
// skinned to its nodes in every state, never its cells drawn as voxels). Pure: no GPU (test/unit/bodymesh.test.ts).
//
// The surface of its cells as the world draws what's built: hex prisms, each face where the cell beside it (the six
// around, above, below) isn't the body's — so a girder's web one cell thick, a pylon's legs, a car's roof all keep their
// shape (the field mesh drops members that thin: RB12). Flat faces, a face's normal its own. Each vertex is bound to the
// node its cell is in and up to three more near it (by their rest places; weights by nearness), the way the rock mesh's
// skin binds (rockmesh.wgsl): bent, the faces follow the nodes smoothly; broken, the shader keeps only the nodes of the
// vertex's own part (bodymesh.wgsl), so the mesh splits along the cells' own faces.

import { cellPos, DIRV, nbr } from '../world/lattice';

type V3 = [number, number, number];

/** floats a vertex (bodymesh.wgsl: pos + word, normal + entry, weights, node indices) */
export const BM_VERT = 16;
/** a hexagon's corner radius (cells): its flat sides 0.5 from its centre */
const R = 0.5 / Math.cos(Math.PI / 6);

export interface MeshCell {
  x: number;
  y: number;
  z: number;
  mat: number;
}

/** what the vertices are bound to: the nodes' rest places (the spawn frame), each cell's node, the block size */
export interface MeshBind {
  nodeRest: readonly V3[];
  cellNode: ArrayLike<number>;
  g: number;
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const rot = (d: readonly [number, number], a: number): [number, number] => [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a)];

/** a cell's speckle (the body voxels' look: render.wgsl fsBody reads bits 8-15) */
function speckle(c: MeshCell): number {
  let h = (c.x * 73856093) ^ (c.y * 19349663) ^ (c.z * 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h >>> 0) & 255;
}

/**
 * The mesh of these cells (spawn frame: storage column x, row y, cell z) as triangles, BM_VERT floats a vertex, the
 * vertex positions in the spawn frame's world cells; bound to `bind`'s nodes, or (none) to nothing (a matrix moves it).
 */
export function buildBodyMesh(cells: readonly MeshCell[], bind?: MeshBind): Float32Array {
  const at = new Map<string, number>();
  cells.forEach((c, i) => at.set(key(c.x, c.y, c.z), i));
  const out: number[] = [];
  const u = new Uint32Array(1);
  const f = new Float32Array(u.buffer);
  const bits = (v: number) => {
    u[0] = v >>> 0;
    return f[0];
  };
  /** a vertex's nodes and weights: its cell's node first, up to three more near it */
  const weights = (p: V3, own: number): [number[], number[]] => {
    if (!bind) return [[0, 0, 0, 0], [1, 0, 0, 0]];
    const d = (k: number) => Math.hypot(p[0] - bind.nodeRest[k][0], p[1] - bind.nodeRest[k][1], p[2] - bind.nodeRest[k][2]);
    const d0 = d(own);
    const near: [number, number][] = [];
    for (let k = 0; k < bind.nodeRest.length; k++) if (k !== own) near.push([k, d(k)]);
    near.sort((a, b) => a[1] - b[1]);
    const idx = [own];
    const w = [1 / ((d0 + 0.25) * (d0 + 0.25))];
    for (const [k, dk] of near) {
      if (idx.length === 4 || dk > d0 + 1.5 * bind.g) break;
      idx.push(k);
      w.push(1 / ((dk + 0.25) * (dk + 0.25)));
    }
    const s = w.reduce((a, b) => a + b, 0);
    while (idx.length < 4) {
      idx.push(own);
      w.push(0);
    }
    return [idx, w.map((x) => x / s)];
  };
  const tri = (c: MeshCell, own: number, n: V3, ps: V3[]) => {
    const word = (c.mat & 0xff) | (speckle(c) << 8) | 0x40000000;
    for (const p of ps) {
      const [idx, w] = weights(p, own);
      out.push(p[0], p[1], p[2], bits(word), n[0], n[1], n[2], 0, w[0], w[1], w[2], w[3], bits(idx[0]), bits(idx[1]), bits(idx[2]), bits(idx[3]));
    }
  };
  cells.forEach((c, i) => {
    const own = bind ? bind.cellNode[i] : 0;
    const [cx, cy] = cellPos(c.x, c.y);
    const z0 = c.z;
    const z1 = c.z + 1;
    // the corners at 30°, 90°, … (between the neighbours' directions)
    const corner = (j: number): [number, number] => [cx + R * Math.cos(Math.PI / 6 + (j * Math.PI) / 3), cy + R * Math.sin(Math.PI / 6 + (j * Math.PI) / 3)];
    if (!at.has(key(c.x, c.y, c.z + 1))) {
      const k = [0, 1, 2, 3, 4, 5].map(corner);
      for (const [a, b, d] of [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]]) tri(c, own, [0, 0, 1], [[k[a][0], k[a][1], z1], [k[b][0], k[b][1], z1], [k[d][0], k[d][1], z1]]);
    }
    if (!at.has(key(c.x, c.y, c.z - 1))) {
      const k = [0, 1, 2, 3, 4, 5].map(corner);
      for (const [a, b, d] of [[0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 5, 4]]) tri(c, own, [0, 0, -1], [[k[a][0], k[a][1], z0], [k[b][0], k[b][1], z0], [k[d][0], k[d][1], z0]]);
    }
    for (let s = 0; s < 6; s++) {
      const [nx, ny] = nbr(c.x, c.y, s);
      if (at.has(key(nx, ny, c.z))) continue;
      const d = DIRV[s];
      const a = rot(d, -Math.PI / 6);
      const b = rot(d, Math.PI / 6);
      const pa: [number, number] = [cx + R * a[0], cy + R * a[1]];
      const pb: [number, number] = [cx + R * b[0], cy + R * b[1]];
      const n: V3 = [d[0], d[1], 0];
      tri(c, own, n, [[pa[0], pa[1], z0], [pb[0], pb[1], z0], [pb[0], pb[1], z1]]);
      tri(c, own, n, [[pa[0], pa[1], z0], [pb[0], pb[1], z1], [pa[0], pa[1], z1]]);
    }
  });
  return new Float32Array(out);
}
