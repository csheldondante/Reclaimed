// A model's mesh for the physics engine (engine_draw.wgsl): the body mesh of its cells (render/bodymeshbuild.ts: the
// cells' surface as the world draws what's built — hex prisms, a face where the cell beside it isn't the body's), each
// vertex weighted to the model's voxels round it. One mesh in every state: placed by the row's pose while it is rigid,
// by the weighted voxels while it deforms, baked into a part's own mesh when it settles (engine_settle.wgsl). Pure.
//
// A vertex stands on a lattice corner: three columns by two layers meet there. Its voxels are the body's cells among
// those six (at most four kept), equally weighted, the cell whose face the vertex is on first:
//  - every face meeting at a corner is carried by the same voxels, so a bent body's faces stay joined;
//  - the six are each other's lattice neighbours, so "the voxels this face's cell is still bonded to" is one bond bit a
//    voxel (engine_deform.wgsl `carries`): a face follows its own side of a crack, and settle gives it to that cell's
//    part — a part's outer faces are exactly its own cells', and the break faces close it with no gap.
import { BM_VERT, buildBodyMesh } from '../render/bodymeshbuild';
import { cellAt, cellPos, nbr, NDIR } from '../world/lattice';
import { MESH_V, type EngineCell, type V3 } from './engine';

/** a cell centre this near a vertex is one of the six round its corner (they are 0.764 cells away; the next 1.26) */
const CORNER_REACH = 0.9;

/** for Engine.addModel: the mesh's vertices as the heap keeps them, MESH_V vec4 each — [its voxels (lattice cell k;
 *  0xffffffff none), the cell whose face it is on first] [their weights] [its place about the centre of mass, its material word] */
export function modelMesh(cells: readonly EngineCell[]): (m: { com: V3; lo: V3; dims: V3 }) => Float32Array {
  return ({ com, lo, dims }) => {
    const verts = buildBodyMesh(cells);
    const n = verts.length / BM_VERT;
    const out = new Float32Array(n * MESH_V * 4);
    const ou = new Uint32Array(out.buffer);
    const at = new Set<string>();
    for (const c of cells) at.add(`${c.x},${c.y},${c.z}`);
    const index = (x: number, y: number, z: number) => x - lo[0] + dims[0] * (y - lo[1] + dims[1] * (z - lo[2]));
    for (let t = 0; t < n; t += 3) {
      // the cell whose face this triangle is on: just inside the face from its middle
      const mid = [0, 1, 2].map((a) => (verts[t * BM_VERT + a] + verts[(t + 1) * BM_VERT + a] + verts[(t + 2) * BM_VERT + a]) / 3 - 0.25 * verts[t * BM_VERT + 4 + a]);
      const [ox, oy] = cellAt(mid[0], mid[1]);
      const oz = Math.floor(mid[2]);
      if (!at.has(`${ox},${oy},${oz}`)) throw new Error('modelMesh: a face with no cell behind it');
      const cols: [number, number][] = [[ox, oy]];
      for (let k = 0; k < NDIR; k++) cols.push(nbr(ox, oy, k));
      for (let v = t; v < t + 3; v++) {
        const p = [verts[v * BM_VERT], verts[v * BM_VERT + 1], verts[v * BM_VERT + 2]];
        const round: number[] = [];
        for (const [cx, cy] of cols)
          for (let cz = oz - 1; cz <= oz + 1; cz++) {
            if ((cx === ox && cy === oy && cz === oz) || !at.has(`${cx},${cy},${cz}`)) continue;
            const [wx, wy] = cellPos(cx, cy);
            if (Math.hypot(p[0] - wx, p[1] - wy, p[2] - (cz + 0.5)) < CORNER_REACH) round.push(index(cx, cy, cz));
          }
        // (more than three others only at a concave corner of the surface: the lowest indices are kept)
        const use = [index(ox, oy, oz), ...round.sort((a, b) => a - b).slice(0, 3)];
        const o = v * 12;
        for (let k = 0; k < 4; k++) {
          ou[o + k] = k < use.length ? use[k] : 0xffffffff;
          out[o + 4 + k] = k < use.length ? 1 / use.length : 0;
        }
        out.set([p[0] - com[0], p[1] - com[1], p[2] - com[2], verts[v * BM_VERT + 3]], o + 8);
      }
    }
    return out;
  };
}
