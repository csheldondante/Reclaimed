// A model's mesh for the physics engine (engine_draw.wgsl), chosen by material, never by solver (DESIGN §10). The
// faces are the body mesh's (render/bodymeshbuild.ts: a face where the cell beside it isn't the body's, each triangle
// one cell's), each vertex weighted to the model's voxels round it. One mesh in every state: placed by the row's pose
// while it is rigid, by the weighted voxels while it deforms, baked into a part's own mesh when it settles
// (engine_settle.wgsl). Pure.
//
// A vertex stands on a lattice corner: three columns by two layers meet there. Its voxels are the body's cells among
// those six (at most four kept), equally weighted, the cell whose face the vertex is on first:
//  - every face meeting at a corner is carried by the same voxels, so a bent body's faces stay joined;
//  - the six are each other's lattice neighbours, so "the voxels this face's cell is still bonded to" is one bond bit a
//    voxel (engine_deform.wgsl `carries`): a face follows its own side of a crack, and settle gives it to that cell's
//    part — a part's outer faces are exactly its own cells', and the break faces close it with no gap.
//
// The shape by material (`roundOf`: the panel's `roundRock` and `roundBuilt`). Rock is rounded and smooth-shaded: a
// corner goes to the mean of the middles of the cut edges round it (surface nets over the model's occupancy on the
// hex-prism lattice: the hex zigzag of a straight side comes out flat, an edge is bevelled, a corner blunted), and its
// normal is the mean of the faces meeting there. Brick and plain concrete (a negative number from `roundOf`) are drawn
// in their layer's plane only: a corner goes to the mean of the middles of the edges the surface cuts in its own
// layers and keeps its height, so a wall's sides are flat (no hex outline), its top and its edges sharp, its faces
// flat-shaded. Steel, wood and the rest keep the cells' own corners. The place depends only on the corner's six
// cells, so the break faces (engine_settle.wgsl `cornerAt`: the same rule on the GPU) meet the outer surface exactly
// where it is.
// A vertex also keeps which corner of its face's cell it stands on (its normal's fourth number: bit 0 smooth-shaded,
// the rest 2 x (1 + corner + 6 x upper plane)): settle places a vertex on a corner a break runs through by that
// corner's rule, so an outer face ends on the break face.
import { BM_VERT, buildBodyMesh } from '../render/bodymeshbuild';
import { cellAt, cellPos, nbr, NDIR } from '../world/lattice';
import { Engine, MESH_V, type EngineCell, type V3 } from './engine';

/** a cell centre this near a vertex (in the plane) is one of the three columns round its corner (0.577 away; the next 1.15) */
const CORNER_REACH = 0.8;

/** for Engine.addModel: the mesh's vertices as the heap keeps them, MESH_V vec4 each — [its voxels (lattice cell k;
 *  0xffffffff none), the cell whose face it is on first] [its normal in the rest frame, then bit 0: smooth-shaded (else
 *  the triangle's own normal is drawn), the rest its corner's code] [its place about the centre of mass, its material
 *  word] */
export function modelMesh(cells: readonly EngineCell[], roundOf: (mat: number) => number = Engine.roundOf()): (m: { com: V3; lo: V3; dims: V3 }) => Float32Array {
  return ({ com, lo, dims }) => {
    const verts = buildBodyMesh(cells);
    const n = verts.length / BM_VERT;
    const out = new Float32Array(n * MESH_V * 4);
    const ou = new Uint32Array(out.buffer);
    const at = new Map<string, number>();
    for (const c of cells) at.set(`${c.x},${c.y},${c.z}`, c.mat);
    const index = (x: number, y: number, z: number) => x - lo[0] + dims[0] * (y - lo[1] + dims[1] * (z - lo[2]));
    /** a corner's place by its six cells (its key: the place it has on the lattice), and whether it is smooth */
    const placed = new Map<string, { p: V3; smooth: boolean; n: V3 }>();
    const keyOf = (p: number[]) => `${Math.round(p[0] * 8)},${Math.round(p[1] * 8)},${Math.round(p[2])}`;
    const place = (p: number[], cols: [number, number][]) => {
      const k = keyOf(p);
      const had = placed.get(k);
      if (had) return had;
      const zp = Math.round(p[2]);
      const three = cols.filter(([cx, cy]) => {
        const [wx, wy] = cellPos(cx, cy);
        return Math.hypot(p[0] - wx, p[1] - wy) < CORNER_REACH;
      });
      if (three.length !== 3) throw new Error('modelMesh: a vertex off the lattice corners');
      // the six cells: three columns in the layer under the corner's plane, then in the one over it
      const six = [zp - 1, zp].flatMap((z) => three.map(([cx, cy]) => ({ c: [...cellPos(cx, cy), z + 0.5] as V3, mat: at.get(`${cx},${cy},${z}`) ?? 0 })));
      // (the least rounding among its cells; in the layer's plane only if any of them is drawn so)
      let round = 1;
      let planar = false;
      for (const s of six)
        if (s.mat) {
          const r = roundOf(s.mat);
          round = Math.min(round, Math.abs(r));
          planar ||= r < 0;
        }
      const cut: V3 = [0, 0, 0];
      let nc = 0;
      const edge = (a: number, b: number) => {
        if (!six[a].mat === !six[b].mat) return;
        for (let q = 0; q < 3; q++) cut[q] += 0.5 * (six[a].c[q] + six[b].c[q]);
        nc++;
      };
      for (let a = 0; a < 6; a++) {
        edge(a, Math.floor(a / 3) * 3 + ((a + 1) % 3));
        if (a < 3 && !planar) edge(a, a + 3);
      }
      const to = nc ? [cut[0] / nc, cut[1] / nc, planar ? p[2] : cut[2] / nc] : p;
      const r = { p: [0, 1, 2].map((q) => p[q] + (to[q] - p[q]) * round) as V3, smooth: round > 0 && !planar, n: [0, 0, 0] as V3 };
      placed.set(k, r);
      return r;
    };
    const corner: { p: V3; smooth: boolean; n: V3 }[] = new Array(n);
    const code = new Float32Array(n);
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
            if (Math.hypot(p[0] - wx, p[1] - wy) < CORNER_REACH && Math.abs(p[2] - (cz + 0.5)) < 0.75) round.push(index(cx, cy, cz));
          }
        // (more than three others only at a concave corner of the surface: the lowest indices are kept)
        const use = [index(ox, oy, oz), ...round.sort((a, b) => a - b).slice(0, 3)];
        const o = v * 12;
        for (let k = 0; k < 4; k++) ou[o + k] = k < use.length ? use[k] : 0xffffffff;
        corner[v] = place(p, cols);
        // (which corner of its face's cell: corner j stands at 30 + 60 j degrees from the cell's middle, on its lower or
        // upper plane — engine_settle.wgsl cornerAt)
        const [wx, wy] = cellPos(ox, oy);
        const j = ((Math.round(((Math.atan2(p[1] - wy, p[0] - wx) * 180) / Math.PI - 30) / 60) % 6) + 6) % 6;
        code[v] = 2 * (1 + j + (p[2] > oz + 0.5 ? 6 : 0));
        out[o + 11] = verts[v * BM_VERT + 3];
      }
      // the triangle's normal where its corners now stand, by its area, onto each smooth corner it meets
      const [a, b, c] = [corner[t].p, corner[t + 1].p, corner[t + 2].p];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const fn: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      for (let v = t; v < t + 3; v++) for (let q = 0; q < 3; q++) corner[v].n[q] += fn[q];
    }
    for (let v = 0; v < n; v++) {
      const o = v * 12;
      const k = corner[v];
      const l = Math.hypot(k.n[0], k.n[1], k.n[2]);
      // (a face folded flat by the rounding has no normal of its own: up)
      out.set(l > 1e-9 ? [k.n[0] / l, k.n[1] / l, k.n[2] / l, code[v] + (k.smooth ? 1 : 0)] : [0, 0, 1, code[v] + (k.smooth ? 1 : 0)], o + 4);
      out.set([k.p[0] - com[0], k.p[1] - com[1], k.p[2] - com[2]], o + 8);
    }
    return out;
  };
}
