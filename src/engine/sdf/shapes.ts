// Shapes and scenes for the fine pass's tests and benches (test/gpu/sdf-*.test.ts, src/perf/sdfbench.ts): voxel
// models in the store's input form, a model's mass properties, and the bench's scene of intersecting pairs. Pure.

import type { BodyRow } from './contract';
import type { SdfModelSpec } from './models';

type V3 = [number, number, number];

export function shape(size: V3, voxel: number, solid: (x: number, y: number, z: number) => boolean): SdfModelSpec {
  const [w, d, h] = size;
  const vox = new Uint8Array(w * d * h);
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) if (solid(x, y, z)) vox[x + w * (y + d * z)] = 1;
  return { size, vox, voxel };
}

export const boxShape = (w: number, d: number, h: number, voxel = 1): SdfModelSpec => shape([w, d, h], voxel, () => true);

/** a ball of diameter n voxels (a voxel is matter when its centre is inside) */
export const ballShape = (n: number, voxel = 1): SdfModelSpec => shape([n, n, n], voxel, (x, y, z) => (x + 0.5 - n / 2) ** 2 + (y + 0.5 - n / 2) ** 2 + (z + 0.5 - n / 2) ** 2 <= (n / 2) ** 2);

/** an L: an n-cube less the quarter with x and z both in the upper half (a foot along x, a leg up z) */
export const lShape = (n: number, voxel = 1): SdfModelSpec => shape([n, n, n], voxel, (x, _y, z) => !(x >= n / 2 && z >= n / 2));

/** a block with a slot `slot` voxels wide and `deep` voxels deep cut along y in the middle of its top */
export const notchShape = (w: number, d: number, h: number, slot: number, deep: number, voxel = 1): SdfModelSpec =>
  shape([w, d, h], voxel, (x, _y, z) => !(z >= h - deep && x >= (w - slot) / 2 && x < (w + slot) / 2));

/** mass (density 1 a cell³), centre of mass (own voxel coordinates), inertia about it (diagonal, body axes) and the bound radius about it (cells) */
export function massProps(spec: SdfModelSpec): { mass: number; com: V3; inertia: V3; radius: number } {
  const [w, d, h] = spec.size;
  const v = spec.voxel;
  let n = 0;
  const c = [0, 0, 0];
  for (let z = 0; z < h; z++)
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++)
        if (spec.vox[x + w * (y + d * z)]) {
          n++;
          c[0] += x + 0.5;
          c[1] += y + 0.5;
          c[2] += z + 0.5;
        }
  if (!n) return { mass: 0, com: [w / 2, d / 2, h / 2], inertia: [0, 0, 0], radius: 0 };
  const com: V3 = [c[0] / n, c[1] / n, c[2] / n];
  const m = v * v * v;
  const inertia: V3 = [0, 0, 0];
  let r2 = 0;
  for (let z = 0; z < h; z++)
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++)
        if (spec.vox[x + w * (y + d * z)]) {
          const p = [(x + 0.5 - com[0]) * v, (y + 0.5 - com[1]) * v, (z + 0.5 - com[2]) * v];
          // (a voxel's own inertia: m v² / 6)
          inertia[0] += m * (p[1] * p[1] + p[2] * p[2] + (v * v) / 6);
          inertia[1] += m * (p[0] * p[0] + p[2] * p[2] + (v * v) / 6);
          inertia[2] += m * (p[0] * p[0] + p[1] * p[1] + (v * v) / 6);
          r2 = Math.max(r2, (Math.abs(p[0]) + v / 2) ** 2 + (Math.abs(p[1]) + v / 2) ** 2 + (Math.abs(p[2]) + v / 2) ** 2);
        }
  return { mass: n * m, com, inertia, radius: Math.sqrt(r2) };
}

/** a body row of `spec` (model row `model`) at a pose, with the model's mass properties */
export function bodyOf(spec: SdfModelSpec, model: number, pos: V3, quat: [number, number, number, number] = [0, 0, 0, 1], more: Partial<BodyRow> = {}): BodyRow {
  const mp = massProps(spec);
  return { pos, quat, invMass: mp.mass ? 1 / mp.mass : 0, radius: mp.radius, invInertia: mp.inertia.map((i) => (i ? 1 / i : 0)) as V3, model, ...more };
}

/** a quaternion for a turn of `angle` about `axis` */
export function axisAngle(axis: V3, angle: number): [number, number, number, number] {
  const l = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** a small seeded generator (mulberry32): the bench's scene is the same every run */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the bench's three models of side n: a full box, a ball, an L */
export const benchShapes = (n: number): SdfModelSpec[] => [boxShape(n, n, n), ballShape(n), lShape(n)];

export type BenchKind = 'deep' | 'touch';

/**
 * The bench's scene: `pairs` pairs of two bodies each, every pair intersecting at random poses (random turns, random
 * speeds). `deep`: centres 0.7 of the models' side apart, a third of each body inside the other. `touch`: the second
 * body moved along a random direction until the two overlap by 0.75 voxels there (what a resting or colliding pair
 * looks like). `modelIds` are the store's rows for benchShapes(n).
 */
export function benchScene(pairs: number, n: number, modelIds: number[], seed = 1, kind: BenchKind = 'deep'): { bodies: BodyRow[]; pairs: Uint32Array } {
  const R = rng(seed);
  const specs = benchShapes(n);
  // (touch: each model's voxel corners about its centre of mass, to find how far a turned body reaches along a direction)
  const hull = specs.map((s) => {
    const c = massProps(s).com;
    const pts: number[] = [];
    const [w, d, h] = s.size;
    const at = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < w && y < d && z < h && s.vox[x + w * (y + d * z)] !== 0;
    for (let z = 0; z <= h; z++)
      for (let y = 0; y <= d; y++)
        for (let x = 0; x <= w; x++) {
          // a corner of the grid that touches matter and air both
          let m = 0;
          for (let k = 0; k < 8; k++) if (at(x - (k & 1), y - ((k >> 1) & 1), z - (k >> 2))) m++;
          if (m > 0 && m < 8) pts.push(x - c[0], y - c[1], z - c[2]);
        }
    return pts;
  });
  const reachOf = (s: number, q: [number, number, number, number], dir: V3): number => {
    // dir in the body's frame (the turn undone)
    const [x, y, z, w] = [-q[0], -q[1], -q[2], q[3]];
    const cx = y * dir[2] - z * dir[1] + w * dir[0];
    const cy = z * dir[0] - x * dir[2] + w * dir[1];
    const cz = x * dir[1] - y * dir[0] + w * dir[2];
    const l = [dir[0] + 2 * (y * cz - z * cy), dir[1] + 2 * (z * cx - x * cz), dir[2] + 2 * (x * cy - y * cx)];
    const p = hull[s];
    let best = -Infinity;
    for (let i = 0; i < p.length; i += 3) best = Math.max(best, p[i] * l[0] + p[i + 1] * l[1] + p[i + 2] * l[2]);
    return best * specs[s].voxel;
  };
  const unit = (): V3 => {
    for (;;) {
      const v: V3 = [R() * 2 - 1, R() * 2 - 1, R() * 2 - 1];
      const l = Math.hypot(...v);
      if (l > 0.1 && l <= 1) return [v[0] / l, v[1] / l, v[2] / l];
    }
  };
  const bodies: BodyRow[] = [];
  const list = new Uint32Array(pairs * 2);
  const side = Math.ceil(Math.sqrt(pairs));
  for (let p = 0; p < pairs; p++) {
    const at: V3 = [(p % side) * n * 4, Math.floor(p / side) * n * 4, n * 2];
    const dir = unit();
    let gap = n * 0.7;
    for (let k = 0; k < 2; k++) {
      const s = Math.floor(R() * specs.length);
      const q = axisAngle(unit(), R() * Math.PI * 2);
      if (kind === 'touch') gap = k ? gap + reachOf(s, q, [-dir[0], -dir[1], -dir[2]]) - 0.75 : reachOf(s, q, dir);
      const pos: V3 = k ? [at[0] + dir[0] * gap, at[1] + dir[1] * gap, at[2] + dir[2] * gap] : at;
      bodies.push(bodyOf(specs[s], modelIds[s], pos, q, { lin: unit(), ang: unit().map((x) => x * 0.2) as V3, material: 1 + s }));
    }
    list[p * 2] = p * 2;
    list[p * 2 + 1] = p * 2 + 1;
  }
  return { bodies, pairs: list };
}
