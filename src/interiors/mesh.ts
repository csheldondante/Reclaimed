// An interior as one triangle list (CPU, once a building; interior.wgsl draws it): every storey's floors, walls with
// their openings, stairs and rails, and the furniture — the CC props' voxels greedy-meshed into faces of one colour each.
// In the window's frame (the plan's + the host's offset). Per vertex two vec4<u32> (interior.wgsl IVert):
//   position xyz (f32 bits), colour word (0xMMRRGGBB: M the surface's material, interior.wgsl M_*)
//   normal xyz (f32 bits), info word: storey bits 0-3, kind 4-7, the wall's outward angle 8-15 (256 steps), bit 16 the
//   wall may be cut for the view (a wall between the eye and the room), bit 17 a partition (cut from either side), bits
//   18-31 the object's id (its assembly order)
import type { InteriorPlan, InteriorStair, InteriorWall, PropPlacement, V2, V3 } from '../api/contracts/interiors';
import { PROP_PALETTE } from './palette';
import { prop, VOX } from './props';
import { across, sideAxes, sidePoint, type Quad } from './frame';
import { stairBand } from './plan';

export const M = { plaster: 0, planks: 1, flags: 2, timber: 3, voxel: 4, cloth: 5, flame: 6, dark: 7 } as const;
export const KIND = { floor: 0, wall: 1, prop: 2, stair: 3, trim: 4, rail: 5 } as const;

export interface InteriorMesh {
  /** 8 u32 a vertex */
  data: Uint32Array;
  vertices: number;
  /** per storey its first vertex and count (the draw can skip what isn't shown) */
  storeys: { first: number; count: number }[];
  /** the props' voxel faces' share (stats) */
  stats: { tris: number; propTris: number; ms: number };
}

const f32 = new Float32Array(1);
const u32v = new Uint32Array(f32.buffer);
const bits = (x: number) => ((f32[0] = x), u32v[0]);

class Builder {
  private buf = new Uint32Array(8 * 3 * 4096);
  n = 0;
  propTris = 0;
  private grow(need: number) {
    if ((this.n + need) * 8 <= this.buf.length) return;
    const b = new Uint32Array(Math.max(this.buf.length * 2, (this.n + need) * 8));
    b.set(this.buf);
    this.buf = b;
  }
  vert(p: V3, n: V3, col: number, info: number) {
    const o = this.n * 8;
    this.buf[o] = bits(p[0]);
    this.buf[o + 1] = bits(p[1]);
    this.buf[o + 2] = bits(p[2]);
    this.buf[o + 3] = col >>> 0;
    this.buf[o + 4] = bits(n[0]);
    this.buf[o + 5] = bits(n[1]);
    this.buf[o + 6] = bits(n[2]);
    this.buf[o + 7] = info >>> 0;
    this.n++;
  }
  /** a quad a b c d (counter-clockwise seen from its front), two triangles */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, col: number, info: number) {
    this.grow(6);
    this.vert(a, n, col, info);
    this.vert(b, n, col, info);
    this.vert(c, n, col, info);
    this.vert(a, n, col, info);
    this.vert(c, n, col, info);
    this.vert(d, n, col, info);
  }
  /** a box from 8 corners (bottom 0-3, top 4-7, both counter-clockwise from above); faces' normals from their corners */
  box(c: V3[], col: number, info: number, bottom = false) {
    const face = (a: number, b: number, cc: number, d: number) => {
      const p = [c[a], c[b], c[cc], c[d]];
      const u = sub(p[1], p[0]), v = sub(p[3], p[0]);
      let n = norm(cross(u, v));
      // (outward: away from the box's middle)
      const mid = c.reduce((s, q) => [s[0] + q[0] / 8, s[1] + q[1] / 8, s[2] + q[2] / 8] as V3, [0, 0, 0] as V3);
      const fc: V3 = [(p[0][0] + p[2][0]) / 2, (p[0][1] + p[2][1]) / 2, (p[0][2] + p[2][2]) / 2];
      if (dot(n, sub(fc, mid)) < 0) n = [-n[0], -n[1], -n[2]];
      this.quad(p[0], p[1], p[2], p[3], n, col, info);
    };
    face(4, 5, 6, 7);
    if (bottom) face(0, 3, 2, 1);
    face(0, 1, 5, 4);
    face(1, 2, 6, 5);
    face(2, 3, 7, 6);
    face(3, 0, 4, 7);
  }
  done(): Uint32Array {
    return this.buf.slice(0, this.n * 8);
  }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const colour = (mat: number, rgb: V3) => ((mat & 0xff) << 24) | (Math.round(Math.min(1, rgb[0]) * 255) << 16) | (Math.round(Math.min(1, rgb[1]) * 255) << 8) | Math.round(Math.min(1, rgb[2]) * 255);
const infoOf = (storey: number, kind: number, angle = 0, cuttable = false, obj = 0, partition = false) =>
  (storey & 15) | ((kind & 15) << 4) | ((Math.round(((angle / (2 * Math.PI)) % 1 + 1) * 256) & 255) << 8) | (cuttable ? 1 << 16 : 0) | (partition ? 1 << 17 : 0) | ((obj & 0x3fff) << 18);

/** the palette's look per material (sRGB; the shader adds the pattern) */
const LOOK = {
  plaster: [0.62, 0.57, 0.5] as V3,
  plasterLow: [0.46, 0.4, 0.34] as V3,
  planks: [0.42, 0.29, 0.18] as V3,
  flags: [0.42, 0.4, 0.37] as V3,
  timber: [0.3, 0.2, 0.12] as V3,
  stair: [0.52, 0.37, 0.22] as V3,
};

// ---- the props' voxels as faces (greedy, per colour), cached by prop

interface PropFaces {
  /** quads in voxel units: 4 corners and the normal, the palette index */
  quads: { p: V3[]; n: V3; c: number }[];
}
const facesCache = new Map<string, PropFaces>();

function propFaces(id: string): PropFaces {
  const hit = facesCache.get(id);
  if (hit) return hit;
  const pv = prop(id);
  const [nx, ny, nz] = pv.dims;
  const grid = new Int16Array(nx * ny * nz).fill(-1);
  const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? -1 : grid[(z * ny + y) * nx + x]);
  for (let i = 0; i < pv.vox.length; i += 4) grid[(pv.vox[i + 2] * ny + pv.vox[i + 1]) * nx + pv.vox[i]] = pv.vox[i + 3];
  const quads: PropFaces['quads'] = [];
  // for each axis and side: slices across it, a mask of exposed faces' colours, merged into rectangles
  const dims = [nx, ny, nz];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    for (const s of [-1, 1]) {
      const mask = new Int16Array(dims[u] * dims[v]);
      for (let k = 0; k < dims[d]; k++) {
        mask.fill(-1);
        for (let j = 0; j < dims[v]; j++)
          for (let i = 0; i < dims[u]; i++) {
            const q = [0, 0, 0];
            q[d] = k;
            q[u] = i;
            q[v] = j;
            const c = at(q[0], q[1], q[2]);
            if (c < 0) continue;
            q[d] += s;
            if (at(q[0], q[1], q[2]) >= 0) continue;
            mask[j * dims[u] + i] = c;
          }
        for (let j = 0; j < dims[v]; j++)
          for (let i = 0; i < dims[u]; ) {
            const c = mask[j * dims[u] + i];
            if (c < 0) {
              i++;
              continue;
            }
            let w = 1;
            while (i + w < dims[u] && mask[j * dims[u] + i + w] === c) w++;
            let h = 1;
            outer: while (j + h < dims[v]) {
              for (let x = 0; x < w; x++) if (mask[(j + h) * dims[u] + i + x] !== c) break outer;
              h++;
            }
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[(j + y) * dims[u] + i + x] = -1;
            const plane = s > 0 ? k + 1 : k;
            const corner = (a: number, b: number): V3 => {
              const q = [0, 0, 0];
              q[d] = plane;
              q[u] = a;
              q[v] = b;
              return [q[0], q[1], q[2]];
            };
            const n: V3 = [0, 0, 0];
            n[d] = s;
            const p = [corner(i, j), corner(i + w, j), corner(i + w, j + h), corner(i, j + h)];
            quads.push({ p: s > 0 ? p : [p[0], p[3], p[2], p[1]], n, c });
            i += w;
          }
      }
    }
  }
  const out = { quads };
  facesCache.set(id, out);
  return out;
}

// ---- the build

export interface MeshFrame {
  /** plan frame → window: add (dx, dy), take oz from z */
  dx: number;
  dy: number;
  oz: number;
}

export function buildInteriorMesh(plan: InteriorPlan, frame: MeshFrame): InteriorMesh {
  const t0 = performance.now();
  const B = new Builder();
  const W = (p: V2, z: number): V3 => [p[0] + frame.dx, p[1] + frame.dy, z - frame.oz];
  const H = plan.storeyH;
  const storeys: InteriorMesh['storeys'] = [];
  let obj = 1;
  for (const st of plan.storeys) {
    const first = B.n;
    const l = st.level;
    // the floors: each tile's in a grid of sub-quads, less the holes over the flights from below
    const below = l > 0 ? plan.storeys[l - 1].stairs : [];
    for (const q of st.tiles) {
      const c = plan.corners.get(q)!;
      const holes = below.filter((s) => s.tile === q).map((s) => stairBand(c, s));
      const N = 8;
      const mat = l === 0 ? M.flags : M.planks;
      const col = colour(mat, l === 0 ? LOOK.flags : LOOK.planks);
      const info = infoOf(l, KIND.floor, 0, false, obj++);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const uv = (a: number, b: number) => bil(c, (i + a) / N, (j + b) / N);
          const mid = uv(0.5, 0.5);
          if (holes.some((h) => h.insideHole(mid))) continue;
          B.quad(W(uv(0, 0), st.z), W(uv(1, 0), st.z), W(uv(1, 1), st.z), W(uv(0, 1), st.z), [0, 0, 1], col, info);
        }
    }
    // the walls
    for (const w of st.walls) wall(B, plan, w, st.z, H, l, W, obj++);
    // the flights up from here, and the rail round each hole on the storey above
    for (const s of st.stairs) stair(B, plan.corners.get(s.tile)!, s, l, W, obj++);
    for (const s of below) rail(B, plan.corners.get(s.tile)!, s, l, st.z, W, obj++);
    // the furniture
    for (const p of st.props) {
      placeProp(B, p, l, W, obj++);
    }
    storeys.push({ first, count: B.n - first });
  }
  const data = B.done();
  return { data, vertices: B.n, storeys, stats: { tris: B.n / 3, propTris: B.propTris, ms: +(performance.now() - t0).toFixed(1) } };
}

function bil(c: Quad, u: number, v: number): V2 {
  const a = (1 - u) * (1 - v), b = u * (1 - v), d = u * v, e = (1 - u) * v;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

function wall(B: Builder, plan: InteriorPlan, w: InteriorWall, z: number, H: number, l: number, W: (p: V2, z: number) => V3, obj: number): void {
  const c = plan.corners.get(w.tile)!;
  const { dir, inward } = sideAxes(c, w.side);
  const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  // (an outer wall from the side inward; a partition either side of it)
  const v0 = w.outer ? 0 : -w.thick / 2;
  const v1 = w.outer ? w.thick : w.thick / 2;
  const out = Math.atan2(-inward[1], -inward[0]);
  const info = infoOf(l, KIND.wall, out, true, obj, !w.outer);
  const trim = infoOf(l, KIND.trim, out, true, obj, !w.outer);
  const pt = (u: number, v: number): V2 => [w.a[0] + dir[0] * u + inward[0] * v, w.a[1] + dir[1] * u + inward[1] * v];
  const boxUZ = (u0: number, u1: number, za: number, zb: number, col: number, inf: number, vv0 = v0, vv1 = v1) => {
    if (u1 - u0 < 1e-3 || zb - za < 1e-3) return;
    const b0 = [pt(u0, vv0), pt(u1, vv0), pt(u1, vv1), pt(u0, vv1)];
    B.box([...b0.map((p) => W(p, z + za)), ...b0.map((p) => W(p, z + zb))], col, inf);
  };
  const plaster = colour(M.plaster, LOOK.plaster);
  const timber = colour(M.timber, LOOK.timber);
  const ops = w.openings.slice().sort((a, b) => a.u0 - b.u0);
  let u = 0;
  for (const o of ops) {
    const a = o.u0 * L, b = o.u1 * L;
    boxUZ(u, a, 0, H, plaster, info);
    boxUZ(a, b, 0, o.z0, plaster, info);
    boxUZ(a, b, o.z1, H, plaster, info);
    // a window's frame: a sill, a lintel, a mullion and a transom (their shadows cross the patch of sun on the floor)
    if (o.kind === 'window' || o.kind === 'shop') {
      const vm0 = v0 + (v1 - v0) * 0.35, vm1 = v0 + (v1 - v0) * 0.55;
      boxUZ(a - 0.05, b + 0.05, o.z0 - 0.06, o.z0, timber, trim, v0, v1 + 0.06);
      boxUZ(a - 0.04, b + 0.04, o.z1, o.z1 + 0.07, timber, trim, v0, v1 + 0.02);
      const m = (a + b) / 2;
      if (o.kind === 'window') boxUZ(m - 0.03, m + 0.03, o.z0, o.z1, timber, trim, vm0, vm1);
      const zt = o.z0 + (o.z1 - o.z0) * 0.62;
      boxUZ(a, b, zt - 0.025, zt + 0.025, timber, trim, vm0, vm1);
    }
    // a doorway's posts and lintel, timber
    if (o.kind === 'door' || o.kind === 'arch' || o.kind === 'balcony') {
      boxUZ(a - 0.08, a, 0, o.z1, timber, trim, v0 - 0.02, v1 + 0.02);
      boxUZ(b, b + 0.08, 0, o.z1, timber, trim, v0 - 0.02, v1 + 0.02);
      boxUZ(a - 0.08, b + 0.08, o.z1, o.z1 + 0.1, timber, trim, v0 - 0.02, v1 + 0.02);
    }
    u = b;
  }
  boxUZ(u, L, 0, H, plaster, info);
  // a skirting of dark timber along the inside, a beam along the top
  const vi = w.outer ? v1 : v1;
  boxUZ(0, L, 0, 0.12, timber, trim, vi - 0.01, vi + 0.03);
  if (!w.outer) boxUZ(0, L, 0, 0.12, timber, trim, v0 - 0.03, v0 + 0.01);
  void across;
}

function stair(B: Builder, c: Quad, s: InteriorStair, l: number, W: (p: V2, z: number) => V3, obj: number): void {
  const rise = s.z1 - s.z0;
  const n = Math.max(8, Math.round(rise / 0.19));
  const col = colour(M.timber, LOOK.stair);
  const info = infoOf(l, KIND.stair, 0, false, obj);
  for (let k = 0; k < n; k++) {
    const ta = s.t0 + ((s.t1 - s.t0) * k) / n, tb = s.t0 + ((s.t1 - s.t0) * (k + 1)) / n;
    const zt = s.z0 + (rise * (k + 1)) / n;
    // (each step a block down to the one below: a solid flight, open under its upper half)
    const zb = Math.max(s.z0, zt - 0.6);
    const d0 = 0.35 / Math.max(1, s.depth * 10) * 0 + 0.0, d1 = s.depth;
    const ps = [sidePoint(c, s.side, ta, d0 + 0.02), sidePoint(c, s.side, tb, d0 + 0.02), sidePoint(c, s.side, tb, d1), sidePoint(c, s.side, ta, d1)];
    B.box([...ps.map((p) => W(p, zb)), ...ps.map((p) => W(p, zt))], col, info, true);
  }
}

function rail(B: Builder, c: Quad, s: InteriorStair, l: number, z: number, W: (p: V2, z: number) => V3, obj: number): void {
  // a rail along the hole's open side on the storey above, posts at its ends and middle
  const col = colour(M.timber, LOOK.timber);
  const info = infoOf(l, KIND.rail, 0, false, obj);
  const d = s.depth + 0.05;
  const ta = s.t0, tb = s.t1 - 0.02;
  const post = (t: number) => {
    const p = sidePoint(c, s.side, t, d);
    const r = 0.04;
    const q = [[p[0] - r, p[1] - r], [p[0] + r, p[1] - r], [p[0] + r, p[1] + r], [p[0] - r, p[1] + r]] as V2[];
    B.box([...q.map((x) => W(x, z)), ...q.map((x) => W(x, z + 0.95))], col, info);
  };
  for (const t of [ta, (ta + tb) / 2, tb]) post(t);
  const a0 = sidePoint(c, s.side, ta, d - 0.03), a1 = sidePoint(c, s.side, tb, d - 0.03), b1 = sidePoint(c, s.side, tb, d + 0.03), b0 = sidePoint(c, s.side, ta, d + 0.03);
  B.box([W(a0, z + 0.9), W(a1, z + 0.9), W(b1, z + 0.9), W(b0, z + 0.9), W(a0, z + 0.97), W(a1, z + 0.97), W(b1, z + 0.97), W(b0, z + 0.97)], col, info);
}

function placeProp(B: Builder, p: PropPlacement, l: number, W: (q: V2, z: number) => V3, obj: number): void {
  const pv = prop(p.prop);
  const f = propFaces(p.prop);
  const k = (p.scale ?? 1) / VOX;
  const [nx, ny] = pv.dims;
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const tf = (q: V3): V3 => {
    const x = (q[0] - nx / 2) * k, y = (q[1] - ny / 2) * k;
    return W([p.at[0] + x * cy - y * sy, p.at[1] + x * sy + y * cy], p.at[2] + q[2] * k);
  };
  const info = infoOf(l, KIND.prop, 0, false, obj);
  for (const q of f.quads) {
    const n: V3 = [q.n[0] * cy - q.n[1] * sy, q.n[0] * sy + q.n[1] * cy, q.n[2]];
    const pal = PROP_PALETTE[q.c];
    const mat = pal.name === 'flame' ? M.flame : pal.name.startsWith('cloth') || pal.name === 'linen' ? M.cloth : M.voxel;
    B.quad(tf(q.p[0]), tf(q.p[1]), tf(q.p[2]), tf(q.p[3]), n, colour(mat, pal.rgb as V3), info);
    B.propTris += 2;
  }
}
