// Meshes over physics bodies (round 49, F15; docs/PHYSICS.md "Meshes"): a
// lo-fi triangle mesh is the look, a lattice of voxels under it is what the
// world feels (contacts, heat, lava, wind, sand). Each vertex is bound to the
// nearest few voxels; phys.wgsl `skin` moves it with them every tick, so the
// mesh dents, bends and twists with the body and tears where it breaks.

import type { VoxelModel } from '../world/models';

/** A triangle mesh in its own frame (cells): xyz per vertex, three vertex indices per triangle, a material per triangle. */
export interface SkinMesh {
  id: string;
  pos: Float32Array;
  tris: Uint32Array;
  mat: Uint8Array;
}

/** What a mesh binds to: its lattice (as a model, `voxel` its spacing) and where the mesh sits in the lattice's frame. */
export interface SkinLattice {
  model: VoxelModel;
  /** add to a mesh position to get the lattice frame (the lattice's origin at its low corner) */
  shift: [number, number, number];
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function vert(m: SkinMesh, i: number): V {
  return [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
}

/** Distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function triDist(p: V, a: V, b: V, c: V): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const at = (q: V) => Math.hypot(...sub(p, q));
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** Does the ray from p along +x cross triangle abc (Möller–Trumbore)? */
function rayX(p: V, a: V, b: V, c: V): boolean {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const d: V = [1, 0.000137, 0.000071];
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det;
  const s = sub(p, a);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross(s, e1);
  const v = f * dot(d, q);
  if (v < 0 || u + v > 1) return false;
  return f * dot(e2, q) > 0;
}

/**
 * The lattice under a mesh at voxel spacing s: a voxel wherever its centre is
 * inside the mesh (closed meshes: ray parity) or within half a voxel of its
 * surface (thin parts get one too), of the nearest triangle's material.
 */
export function latticeFor(m: SkinMesh, s: number): SkinLattice {
  const n = m.pos.length / 3;
  const lo: V = [Infinity, Infinity, Infinity];
  const hi: V = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.pos[i * 3 + k]);
      hi[k] = Math.max(hi[k], m.pos[i * 3 + k]);
    }
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k] - lo[k]) / s - 1e-6))) as V;
  // the lattice centred on the mesh's bounds
  const shift = [0, 1, 2].map((k) => (dims[k] * s - (hi[k] - lo[k])) / 2 - lo[k]) as V;
  const [w, d, h] = dims;
  const vox = new Uint8Array(w * d * h);
  const T = m.tris.length / 3;
  const tv = (t: number, c: number) => {
    const p = vert(m, m.tris[t * 3 + c]);
    return [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]] as V;
  };
  for (let z = 0; z < h; z++)
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++) {
        const p: V = [(x + 0.5) * s, (y + 0.5) * s, (z + 0.5) * s];
        let best = Infinity;
        let mat = 0;
        let hits = 0;
        for (let t = 0; t < T; t++) {
          const a = tv(t, 0);
          const b = tv(t, 1);
          const c = tv(t, 2);
          const dd = triDist(p, a, b, c);
          if (dd < best) {
            best = dd;
            mat = m.mat[t];
          }
          if (rayX(p, a, b, c)) hits++;
        }
        if (hits % 2 === 1 || best < s * 0.5) vox[x + w * (y + d * z)] = mat;
      }
  return { model: { id: `mesh:${m.id}`, name: m.id, size: dims, vox, sink: 0, voxel: s }, shift };
}

/**
 * The skin records phys.wgsl `skin` reads, three vertices a triangle (7 vec4
 * each): the up-to-four nearest voxels (body-relative lattice indices here;
 * the caller adds the body's offset), their weights, the rest position and
 * the triangle's material, the offsets from each voxel's centre.
 */
export function bindSkin(m: SkinMesh, lat: SkinLattice): { data: Float32Array; tris: number } {
  const { model, shift } = lat;
  const s = model.voxel ?? 1;
  const [w, d, h] = model.size;
  const T = m.tris.length / 3;
  const data = new Float32Array(T * 3 * 28);
  const U = new Uint32Array(data.buffer);
  for (let t = 0; t < T; t++)
    for (let c = 0; c < 3; c++) {
      const v = vert(m, m.tris[t * 3 + c]);
      const p: V = [v[0] + shift[0], v[1] + shift[1], v[2] + shift[2]];
      // the solid voxels near it, nearest first (searching out until there are some)
      const near: { i: number; c: V; d: number }[] = [];
      for (let r = 2; near.length < 1 && r <= Math.max(w, d, h) + 2; r *= 2) {
        const g = p.map((q) => Math.floor(q / s)) as V;
        for (let z = Math.max(0, g[2] - r); z <= Math.min(h - 1, g[2] + r); z++)
          for (let y = Math.max(0, g[1] - r); y <= Math.min(d - 1, g[1] + r); y++)
            for (let x = Math.max(0, g[0] - r); x <= Math.min(w - 1, g[0] + r); x++) {
              const i = x + w * (y + d * z);
              if (!model.vox[i]) continue;
              const vc: V = [(x + 0.5) * s, (y + 0.5) * s, (z + 0.5) * s];
              near.push({ i, c: vc, d: Math.hypot(...sub(p, vc)) });
            }
      }
      if (!near.length) throw new Error(`mesh ${m.id}: no voxel under vertex ${m.tris[t * 3 + c]}`);
      near.sort((a, b) => a.d - b.d);
      // the nearest four within reach of the nearest (a smooth falloff), so a
      // vertex follows what it sits on and blends across bends
      const reach = near[0].d + 1.25 * s;
      const use = near.filter((q) => q.d <= reach).slice(0, 4);
      const wts = use.map((q) => (1 - q.d / (reach + 1e-6)) ** 2 + 1e-4);
      const sum = wts.reduce((a, b) => a + b, 0);
      const o = (t * 3 + c) * 28;
      for (let k = 0; k < 4; k++) {
        U[o + k] = k < use.length ? use[k].i : 0xffffffff;
        data[o + 4 + k] = k < use.length ? wts[k] / sum : 0;
        if (k < use.length) data.set(sub(p, use[k].c), o + 12 + k * 4);
      }
      data.set(p, o + 8);
      U[o + 11] = m.mat[t];
    }
  return { data, tris: T };
}

// ---- test meshes ------------------------------------------------------------------

/** A box w × d × h (cells), each face cut into a grid of about `step` cells, one material. */
export function boxMesh(mat: number, w: number, d: number, h: number, step = 0.5, id = `box-${mat}-${w}x${d}x${h}`): SkinMesh {
  const pos: number[] = [];
  const tris: number[] = [];
  // a face from corner o along u and v (outward by u × v)
  const face = (o: V, u: V, v: V, lu: number, lv: number) => {
    const nu = Math.max(1, Math.round(lu / step));
    const nv = Math.max(1, Math.round(lv / step));
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) pos.push(...[0, 1, 2].map((k) => o[k] + (u[k] * lu * i) / nu + (v[k] * lv * j) / nv));
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        tris.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
      }
  };
  face([0, 0, 0], [0, 1, 0], [1, 0, 0], d, w); // bottom
  face([0, 0, h], [1, 0, 0], [0, 1, 0], w, d); // top
  face([0, 0, 0], [1, 0, 0], [0, 0, 1], w, h); // front (y = 0)
  face([0, d, 0], [0, 0, 1], [1, 0, 0], h, w); // back
  face([0, 0, 0], [0, 0, 1], [0, 1, 0], h, d); // left (x = 0)
  face([w, 0, 0], [0, 1, 0], [0, 0, 1], d, h); // right
  return { id, pos: new Float32Array(pos), tris: new Uint32Array(tris), mat: new Uint8Array(tris.length / 3).fill(mat) };
}

/** A lumpy low-poly rock: an icosphere (`sub` subdivisions) of radius r, its vertices pushed in and out by a hash. */
export function rockMesh(mat: number, r: number, sub = 1, seed = 1): SkinMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let k = 0; k < sub; k++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let i = mid.get(key);
      if (i === undefined) {
        i = verts.length;
        verts.push([0, 1, 2].map((q) => (verts[a][q] + verts[b][q]) / 2) as V);
        mid.set(key, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = m(a, b);
      const bc = m(b, c);
      const ca = m(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  verts = verts.map((v, i) => {
    const l = Math.hypot(...v);
    const hsh = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    const k = r * (0.8 + 0.35 * (hsh - Math.floor(hsh)));
    return [(v[0] / l) * k, (v[1] / l) * k, (v[2] / l) * k * 0.85];
  });
  return { id: `rock-${mat}-${r}`, pos: new Float32Array(verts.flat()), tris: new Uint32Array(faces.flat()), mat: new Uint8Array(faces.length).fill(mat) };
}
