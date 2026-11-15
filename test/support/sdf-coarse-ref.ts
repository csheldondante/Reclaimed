// The coarse pass's CPU reference (test/gpu/sdf-coarse.test.ts): every pair of rows by brute force. A pair counts
// when both rows are alive, at least one is awake, their bound spheres (plus the margin) overlap and their models'
// oriented boxes (each grown by half the margin) overlap: sdf-coarse.wgsl `offer`, in doubles. Each pair comes with
// how far it is from the edge of counting (cells), so a test can leave the GPU's floats room at the edge.
import type { BodyRow } from '../../src/engine/sdf/contract';
import type { SdfModelSpec } from '../../src/engine/sdf/models';
import { massProps } from '../../src/engine/sdf/shapes';
import { rot } from './sdf-reference';

type V3 = [number, number, number];

interface Box {
  c: V3;
  half: V3;
  /** the body's axes in the world */
  ax: V3[];
}

export function boxOf(b: BodyRow, spec: SdfModelSpec, margin: number): Box {
  const com = spec.com ?? massProps(spec).com;
  const off = rot(b.quat, [(spec.size[0] / 2 - com[0]) * spec.voxel, (spec.size[1] / 2 - com[1]) * spec.voxel, (spec.size[2] / 2 - com[2]) * spec.voxel]);
  return { c: [b.pos[0] + off[0], b.pos[1] + off[1], b.pos[2] + off[2]], half: spec.size.map((v) => (v / 2) * spec.voxel + margin / 2) as V3, ax: [rot(b.quat, [1, 0, 0]), rot(b.quat, [0, 1, 0]), rot(b.quat, [0, 0, 1])] };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** the largest gap between two boxes over the 15 axes (below zero: they overlap by that much on every axis) */
export function boxGap(a: Box, b: Box): number {
  const t: V3 = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
  const axes: V3[] = [...a.ax, ...b.ax];
  for (const u of a.ax)
    for (const v of b.ax) {
      const c = cross(u, v);
      const l = Math.hypot(...c);
      // (near-parallel edges: the face axes already cover it)
      if (l > 1e-4) axes.push([c[0] / l, c[1] / l, c[2] / l]);
    }
  let gap = -Infinity;
  for (const n of axes) {
    const ra = a.half[0] * Math.abs(dot(a.ax[0], n)) + a.half[1] * Math.abs(dot(a.ax[1], n)) + a.half[2] * Math.abs(dot(a.ax[2], n));
    const rb = b.half[0] * Math.abs(dot(b.ax[0], n)) + b.half[1] * Math.abs(dot(b.ax[1], n)) + b.half[2] * Math.abs(dot(b.ax[2], n));
    gap = Math.max(gap, Math.abs(dot(t, n)) - ra - rb);
  }
  return gap;
}

export interface RefPair {
  a: number;
  b: number;
  /** above zero: a pair, by this much (cells); below: not one */
  slack: number;
}

/** every pair with an awake row whose spheres come within `near` of counting: the pairs (slack > 0) and the near misses */
export function brutePairs(bodies: BodyRow[], specs: SdfModelSpec[], modelOf: (row: BodyRow) => number, margin: number, near = 0.01): RefPair[] {
  const out: RefPair[] = [];
  const boxes = bodies.map((b) => boxOf(b, specs[modelOf(b)], margin));
  const awake = bodies.map((b, i) => i).filter((i) => !bodies[i].asleep && !bodies[i].dead);
  for (const a of awake)
    for (let b = 0; b < bodies.length; b++) {
      if (b === a || bodies[b].dead || (!bodies[b].asleep && b < a)) continue;
      const pa = bodies[a].pos;
      const pb = bodies[b].pos;
      const sphere = bodies[a].radius + bodies[b].radius + margin - Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      if (sphere < -near) continue;
      const slack = Math.min(sphere, -boxGap(boxes[a], boxes[b]));
      if (slack > -near) out.push({ a: Math.min(a, b), b: Math.max(a, b), slack });
    }
  return out;
}
