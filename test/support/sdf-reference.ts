// The fine pass's CPU references (test/gpu/sdf-*.test.ts):
// - the exact signed distance of a voxel model by brute force (every surface voxel tried), at the voxel centres
//   (what the GPU's jump flood must give) and at any point with its normal (what a contact's depth and normal are
//   judged against);
// - the contacts of a pair list computed the way sdf-fine.wgsl does (same samples, same trilinear field), in doubles.
// Mirrors: src/engine/sdf/contract.ts for the layouts and the sample rule, sdf-fine.wgsl `fine` for the contact.

import { packSample, samplePoint, SDF_PAD, SDF_SNORM_SCALE, type BodyRow, type Contact, type SdfFormat } from '../../src/engine/sdf/contract';
import type { SdfModelSpec } from '../../src/engine/sdf/models';

type V3 = [number, number, number];
type Q = [number, number, number, number];

export interface RefModel {
  spec: SdfModelSpec;
  /** padded sides */
  dims: V3;
  voxel: number;
  /** padded voxel coordinates */
  com: V3;
  /** padded occupancy */
  occ: (x: number, y: number, z: number) => boolean;
  /** exact distance at the padded voxel centres, voxels (as the format keeps it) */
  field: Float32Array;
  /** the same, before the format's rounding */
  exact: Float32Array;
  /** grad8: the unit gradient kept a voxel (x, y, z; as its snorm8 bytes decode) */
  grad: Float32Array | null;
  /** the surface samples (contract.ts packSample) in the bake's order: brick by brick (4 × 4 × 4 padded voxels, x
   *  fastest), voxel by voxel (x fastest) inside a brick */
  samples: number[];
  /** the brick table: samples before each brick, then all of them */
  bricks: number[];
  /** occupied voxels with an open face, and empty voxels with an occupied face neighbour (padded coordinates) */
  surfOcc: V3[];
  surfEmpty: V3[];
}

const boxDist = (p: V3, c: V3): number => Math.hypot(Math.max(Math.abs(p[0] - c[0] - 0.5) - 0.5, 0), Math.max(Math.abs(p[1] - c[1] - 0.5) - 0.5, 0), Math.max(Math.abs(p[2] - c[2] - 0.5) - 0.5, 0));

export function refModel(spec: SdfModelSpec, format: SdfFormat): RefModel {
  const [w, d, h] = spec.size;
  const dims: V3 = [w + 2 * SDF_PAD, d + 2 * SDF_PAD, h + 2 * SDF_PAD];
  const occ = (x: number, y: number, z: number) => {
    const a = x - SDF_PAD;
    const b = y - SDF_PAD;
    const c = z - SDF_PAD;
    return a >= 0 && b >= 0 && c >= 0 && a < w && b < d && c < h && spec.vox[a + w * (b + d * c)] !== 0;
  };
  const F: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const surfOcc: V3[] = [];
  const surfEmpty: V3[] = [];
  const samples: number[] = [];
  let n = 0;
  const c = [0, 0, 0];
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const o = occ(x, y, z);
        let open = 0;
        F.forEach((f, k) => {
          if (occ(x + f[0], y + f[1], z + f[2]) !== o) open |= 1 << k;
        });
        if (o) {
          n++;
          c[0] += x + 0.5;
          c[1] += y + 0.5;
          c[2] += z + 0.5;
        }
        if (!open) continue;
        if (o) surfOcc.push([x, y, z]);
        else surfEmpty.push([x, y, z]);
      }
  const bd = dims.map((v) => Math.ceil(v / 4));
  const bricks: number[] = [];
  for (let b = 0; b < bd[0] * bd[1] * bd[2]; b++) {
    bricks.push(samples.length);
    const o = [(b % bd[0]) * 4, (Math.floor(b / bd[0]) % bd[1]) * 4, Math.floor(b / (bd[0] * bd[1])) * 4];
    for (let k = 0; k < 64; k++) {
      const [x, y, z] = [o[0] + (k & 3), o[1] + ((k >> 2) & 3), o[2] + (k >> 4)];
      if (!occ(x, y, z)) continue;
      let open = 0;
      F.forEach((f, i) => {
        if (!occ(x + f[0], y + f[1], z + f[2])) open |= 1 << i;
      });
      if (open) samples.push(packSample(x, y, z, open));
    }
  }
  bricks.push(samples.length);
  const field = new Float32Array(dims[0] * dims[1] * dims[2]);
  const exact = new Float32Array(field.length);
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const p: V3 = [x + 0.5, y + 0.5, z + 0.5];
        const o = occ(x, y, z);
        let best = 1000;
        for (const s of o ? surfEmpty : surfOcc) best = Math.min(best, boxDist(p, s));
        // (the GPU's distances are floats)
        const v = Math.fround(o ? -best : best);
        exact[x + dims[0] * (y + dims[1] * z)] = v;
        field[x + dims[0] * (y + dims[1] * z)] = format === 'f32' ? v : Math.max(-127, Math.min(127, Math.round(v * SDF_SNORM_SCALE))) / SDF_SNORM_SCALE;
      }
  let grad: Float32Array | null = null;
  if (format === 'grad8') {
    // (sdf-bake.wgsl finalize: central differences of the exact distances, one-sided at the grid's edge, as snorm8)
    grad = new Float32Array(field.length * 3);
    const step = [1, dims[0], dims[0] * dims[1]];
    for (let i = 0; i < field.length; i++) {
      const p = [i % dims[0], Math.floor(i / dims[0]) % dims[1], Math.floor(i / (dims[0] * dims[1]))];
      const gv = [0, 1, 2].map((k) => (p[k] + 1 < dims[k] ? exact[i + step[k]] : exact[i]) - (p[k] > 0 ? exact[i - step[k]] : exact[i]));
      const gl = Math.hypot(...gv);
      for (let k = 0; k < 3; k++) grad[i * 3 + k] = Math.floor(0.5 + (127 * (gl > 0 ? gv[k] / gl : 0))) / 127;
    }
  }
  const com: V3 = spec.com ? [spec.com[0] + SDF_PAD, spec.com[1] + SDF_PAD, spec.com[2] + SDF_PAD] : n ? [c[0] / n, c[1] / n, c[2] / n] : [dims[0] / 2, dims[1] / 2, dims[2] / 2];
  return { spec, dims, voxel: spec.voxel, com, occ, field, exact, grad, samples, bricks, surfOcc, surfEmpty };
}

/** the exact signed distance (voxels) and outward normal at a point in padded voxel coordinates, by brute force */
export function exactAt(m: RefModel, p: V3): { d: number; n: V3 } {
  const inside = m.occ(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]));
  let best = Infinity;
  let at: V3 = [0, 0, 0];
  for (const s of inside ? m.surfEmpty : m.surfOcc) {
    const d = boxDist(p, s);
    if (d < best) {
      best = d;
      at = s;
    }
  }
  // (the nearest point of that voxel's box)
  const c: V3 = [Math.min(Math.max(p[0], at[0]), at[0] + 1), Math.min(Math.max(p[1], at[1]), at[1] + 1), Math.min(Math.max(p[2], at[2]), at[2] + 1)];
  const sgn = inside ? -1 : 1;
  const n: V3 = best > 1e-9 ? [(sgn * (p[0] - c[0])) / best, (sgn * (p[1] - c[1])) / best, (sgn * (p[2] - c[2])) / best] : [0, 0, 0];
  return { d: sgn * best, n };
}

export const rot = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0];
  const cy = z * v[0] - x * v[2] + w * v[1];
  const cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
};
export const unrot = (q: Q, v: V3): V3 => rot([-q[0], -q[1], -q[2], q[3]], v);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** a body-local sample point of model m (padded voxel coordinates) in the world */
export const toWorld = (b: BodyRow, m: RefModel, p: V3): V3 => add(b.pos, rot(b.quat, mul(sub(p, m.com), m.voxel)));
/** a world point in model m's padded voxel coordinates */
export const toModel = (b: BodyRow, m: RefModel, p: V3): V3 => add(mul(unrot(b.quat, sub(p, b.pos)), 1 / m.voxel), m.com);

export interface RefContact extends Contact {
  /** which way: 0 a's sample in b's field, 1 b's in a's */
  way: number;
  /** the sample's word */
  sample: number;
  /** the gap in the field model's voxels (-depth / voxel) */
  gapVox: number;
  /** the sample's point in the field model's padded voxel coordinates, and its ball there */
  q: V3;
  ball: number;
  /** a's velocity less b's at the point */
  vrel: V3;
}

/**
 * The contacts sdf-fine.wgsl gives for `pairs`, every sample tested (no cap). `models[i]` is model row i. A gap
 * within `edge` of the margin is left out when `edge` is given (the GPU's floats may fall either side).
 */
export function mirrorContacts(models: RefModel[], bodies: BodyRow[], pairs: ArrayLike<number>, margin: number): RefContact[] {
  const out: RefContact[] = [];
  for (let pi = 0; pi * 2 < pairs.length; pi++)
    for (let way = 0; way < 2; way++) {
      const a = pairs[pi * 2];
      const b = pairs[pi * 2 + 1];
      const s = way ? b : a;
      const f = way ? a : b;
      const bs = bodies[s];
      const bf = bodies[f];
      const ms = models[bs.model];
      const mf = models[bf.model];
      const reach = bs.radius + bf.radius + margin;
      const dp = sub(bs.pos, bf.pos);
      if (dot(dp, dp) > reach * reach) continue;
      const scale = ms.voxel / mf.voxel;
      const mv = margin / mf.voxel;
      const dims = mf.dims;
      for (const word of ms.samples) {
        const sp = samplePoint(word);
        const ball = sp.r * scale;
        const q = sub(toModel(bf, mf, toWorld(bs, ms, sp.p)), [0.5, 0.5, 0.5]);
        const slack = mv + ball;
        if (q.some((v, k) => v < -slack || v > dims[k] - 1 + slack)) continue;
        const qc = q.map((v, k) => Math.min(Math.max(v, 0), dims[k] - 1)) as V3;
        const i0 = qc.map((v, k) => Math.min(Math.floor(v), dims[k] - 2)) as V3;
        const fr = sub(qc, i0);
        const at = (dx: number, dy: number, dz: number) => mf.field[i0[0] + dx + dims[0] * (i0[1] + dy + dims[1] * (i0[2] + dz))];
        const x00 = mix(at(0, 0, 0), at(1, 0, 0), fr[0]);
        const x10 = mix(at(0, 1, 0), at(1, 1, 0), fr[0]);
        const x01 = mix(at(0, 0, 1), at(1, 0, 1), fr[0]);
        const x11 = mix(at(0, 1, 1), at(1, 1, 1), fr[0]);
        const y0 = mix(x00, x10, fr[1]);
        const y1 = mix(x01, x11, fr[1]);
        let d = mix(y0, y1, fr[2]);
        let g: V3 = [mix(mix(at(1, 0, 0) - at(0, 0, 0), at(1, 1, 0) - at(0, 1, 0), fr[1]), mix(at(1, 0, 1) - at(0, 0, 1), at(1, 1, 1) - at(0, 1, 1), fr[1]), fr[2]), mix(x10 - x00, x11 - x01, fr[2]), y1 - y0];
        if (mf.grad) {
          const gr = mf.grad;
          const ga = (k: number, dx: number, dy: number, dz: number) => gr[(i0[0] + dx + dims[0] * (i0[1] + dy + dims[1] * (i0[2] + dz))) * 3 + k];
          g = [0, 1, 2].map((k) => mix(mix(mix(ga(k, 0, 0, 0), ga(k, 1, 0, 0), fr[0]), mix(ga(k, 0, 1, 0), ga(k, 1, 1, 0), fr[0]), fr[1]), mix(mix(ga(k, 0, 0, 1), ga(k, 1, 0, 1), fr[0]), mix(ga(k, 0, 1, 1), ga(k, 1, 1, 1), fr[0]), fr[1]), fr[2])) as V3;
        }
        const gl = Math.hypot(...g);
        let n: V3;
        if (gl > 1e-4) n = mul(g, 1 / gl);
        else {
          const away = sub(qc, sub(mf.com, [0.5, 0.5, 0.5]));
          const al = Math.hypot(...away);
          n = al > 1e-4 ? mul(away, 1 / al) : [0, 0, 1];
        }
        const past = sub(q, qc);
        if (dot(past, past) > 0) {
          const v = add(past, mul(n, Math.max(d, 0)));
          d = Math.hypot(...v);
          n = mul(v, 1 / d);
        }
        const gap = d - ball;
        if (gap > mv) continue;
        const mid = sub(q, mul(n, 0.5 * (d + ball)));
        const point = toWorld(bf, mf, add(mid, [0.5, 0.5, 0.5]));
        const nw = mul(rot(bf.quat, n), way ? -1 : 1);
        const ba = bodies[a];
        const bb = bodies[b];
        const ra = sub(point, ba.pos);
        const rb = sub(point, bb.pos);
        const va = add(ba.lin ?? [0, 0, 0], cross(ba.ang ?? [0, 0, 0], ra));
        const vb = add(bb.lin ?? [0, 0, 0], cross(bb.ang ?? [0, 0, 0], rb));
        const closing = -dot(sub(va, vb), nw);
        const ua = unrot(ba.quat, cross(ra, nw));
        const ub = unrot(bb.quat, cross(rb, nw));
        const ia = ba.invInertia ?? [0, 0, 0];
        const ib = bb.invInertia ?? [0, 0, 0];
        const oa = ba.invInertiaOff ?? [0, 0, 0];
        const ob = bb.invInertiaOff ?? [0, 0, 0];
        const w = Math.max(ba.invMass, 0) + Math.max(bb.invMass, 0) + ua[0] * ua[0] * ia[0] + ua[1] * ua[1] * ia[1] + ua[2] * ua[2] * ia[2] + ub[0] * ub[0] * ib[0] + ub[1] * ub[1] * ib[1] + ub[2] * ub[2] * ib[2] + 2 * (oa[0] * ua[0] * ua[1] + oa[1] * ua[0] * ua[2] + oa[2] * ua[1] * ua[2]) + 2 * (ob[0] * ub[0] * ub[1] + ob[1] * ub[0] * ub[2] + ob[2] * ub[1] * ub[2]);
        const ap = Math.max(closing, 0);
        out.push({ a, b, energy: w > 0 ? (0.5 * ap * ap) / w : 0, matA: ba.material ?? 0, matB: bb.material ?? 0, point, depth: -gap * mf.voxel, normal: nw, closing, way, sample: word, gapVox: gap, q, ball, vrel: sub(va, vb) });
      }
    }
  return out;
}

/** degrees between two unit vectors */
export const angleDeg = (a: readonly number[], b: readonly number[]): number => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
