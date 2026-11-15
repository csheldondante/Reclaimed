// A model's mesh for the physics engine (engine_draw.wgsl): the body mesh of its cells (render/bodymeshbuild.ts: the
// cells' surface as the world draws what's built), each vertex weighted to up to four of the model's voxels
// (physics/mesh.ts bindSkinTo, as the lattice's bodies are bound). One mesh in every state: placed by the row's pose
// while it is rigid, by the weighted voxels while it deforms. Pure.
import { bindSkinTo } from '../physics/mesh';
import { BM_VERT, buildBodyMesh } from '../render/bodymeshbuild';
import { cellPos } from '../world/lattice';
import { MESH_V, type EngineCell, type V3 } from './engine';

/** for Engine.addModel: the mesh's vertices as the heap keeps them, MESH_V vec4 each — [its voxels (lattice cell k;
 *  0xffffffff none)] [their weights] [its place about the centre of mass, its material word] */
export function modelMesh(cells: readonly EngineCell[]): (m: { com: V3; lo: V3; dims: V3 }) => Float32Array {
  return ({ com, lo, dims }) => {
    const verts = buildBodyMesh(cells);
    const skin = bindSkinTo(
      verts,
      BM_VERT,
      cells.map((c) => {
        const [px, py] = cellPos(c.x, c.y);
        return { i: c.x - lo[0] + dims[0] * (c.y - lo[1] + dims[1] * (c.z - lo[2])), c: [px, py, c.z + 0.5] as [number, number, number] };
      }),
    );
    const n = verts.length / BM_VERT;
    const out = new Float32Array(n * MESH_V * 4);
    for (let v = 0; v < n; v++) {
      // (bindSkinTo's record: indices, weights, place + material, then offsets — the engine derives those)
      out.set(skin.data.subarray(v * 28, v * 28 + 8), v * 12);
      out.set([verts[v * BM_VERT] - com[0], verts[v * BM_VERT + 1] - com[1], verts[v * BM_VERT + 2] - com[2], verts[v * BM_VERT + 3]], v * 12 + 8);
    }
    return out;
  };
}
