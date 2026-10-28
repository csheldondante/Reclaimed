// Structure grids (docs/GRIDS.md): rigid voxel grids over the nature grid,
// each in its own frame with full rotation — a toppled tower is one. The GPU
// owns everything grid-shaped (grids.wgsl, project.wgsl, structtick.wgsl,
// structprep.wgsl); this side only places structures: it uploads a model's
// voxels once into the pool and writes each frame (position, rotation, dims,
// bounds) as a uniform-like record.

import type { VoxelModel } from '../world/models';
import type { WorldGpu } from '../sim/world-gpu';

export const MAX_STRUCTS = 8;
/** bytes per frame (grids.wgsl Frame) */
export const FRAME_BYTES = 64;
/** voxels in the pool, all structures together (4 bytes each) */
export const POOL_VOXELS = 1 << 18;
/** projected intervals per nature column (common.wgsl PROJ_K) */
export const PROJ_K = 3;

export type V3 = [number, number, number];
/** quaternion x, y, z, w (local → world) */
export type Q = [number, number, number, number];

export interface Structure {
  slot: number;
  model: VoxelModel;
  pos: V3;
  q: Q;
  /** first voxel in the pool */
  offset: number;
}

export function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qAxis(ax: V3, angle: number): Q {
  const s = Math.sin(angle / 2);
  const l = Math.hypot(...ax) || 1;
  return [(ax[0] / l) * s, (ax[1] / l) * s, (ax[2] / l) * s, Math.cos(angle / 2)];
}

/** yaw about world up, then pitch about the structure's x, then roll about its y (radians) */
export function qYawPitchRoll(yaw: number, pitch: number, roll: number): Q {
  return qMul(qMul(qAxis([0, 0, 1], yaw), qAxis([1, 0, 0], pitch)), qAxis([0, 1, 0], roll));
}

export function qRotate(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const t: V3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

export class Structures {
  readonly list: (Structure | null)[] = new Array(MAX_STRUCTS).fill(null);
  private used = 0;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
  ) {}

  /**
   * Place a model at world point (x, y), rotated by q, resting on the ground
   * there (its lowest corner `sink` cells into it). heightAt: the ground's
   * height at a world point. Returns the structure, or null with no room.
   */
  place(m: VoxelModel, x: number, y: number, q: Q, heightAt: (x: number, y: number) => number, sink = 0): Structure | null {
    const [w, d, h] = m.size;
    const corners = this.corners([w, d, h], q);
    const lo = corners.reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])] as V3, [Infinity, Infinity, Infinity] as V3);
    const hi = corners.reduce((a, c) => [Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])] as V3, [-Infinity, -Infinity, -Infinity] as V3);
    // centre its footprint on (x, y); rest its lowest corner on the ground under its footprint
    let ground = 0;
    for (let k = 0; k <= 8; k++)
      for (let j = 0; j <= 8; j++) {
        const gx = x + (lo[0] - (lo[0] + hi[0]) / 2) + ((hi[0] - lo[0]) * j) / 8;
        const gy = y + (lo[1] - (lo[1] + hi[1]) / 2) + ((hi[1] - lo[1]) * k) / 8;
        ground += heightAt(gx, gy) / 81;
      }
    const pos: V3 = [x - (lo[0] + hi[0]) / 2, y - (lo[1] + hi[1]) / 2, ground - sink - lo[2]];
    return this.add(m, pos, q);
  }

  /** Add a model with its local origin at world `pos`, rotated by q. */
  add(m: VoxelModel, pos: V3, q: Q): Structure | null {
    const slot = this.list.indexOf(null);
    const n = m.size[0] * m.size[1] * m.size[2];
    if (slot < 0 || this.used + n > POOL_VOXELS) return null;
    const s: Structure = { slot, model: m, pos, q, offset: this.used };
    this.used += n;
    this.world.strVoxels = this.used;
    this.list[slot] = s;
    // the voxels: material only (moss and sand cover start bare)
    const v = new Uint32Array(n);
    for (let k = 0; k < n; k++) v[k] = m.vox[k];
    this.device.queue.writeBuffer(this.world.strVox, s.offset * 4, v);
    this.writeFrame(s);
    return s;
  }

  /** Move a structure (a pose from the physics, or a test). */
  setPose(s: Structure, pos: V3, q: Q): void {
    s.pos = pos;
    s.q = q;
    this.writeFrame(s);
  }

  /** Voxels in use in the pool (the per-voxel kernels' dispatch size). */
  get voxels(): number {
    return this.used;
  }

  private corners(dims: V3, q: Q): V3[] {
    const out: V3[] = [];
    for (let k = 0; k < 8; k++) out.push(qRotate(q, [k & 1 ? dims[0] : 0, k & 2 ? dims[1] : 0, k & 4 ? dims[2] : 0]));
    return out;
  }

  private writeFrame(s: Structure): void {
    const [w, d, h] = s.model.size;
    const c = this.corners([w, d, h], s.q).map((p) => [p[0] + s.pos[0], p[1] + s.pos[1]]);
    const f = new ArrayBuffer(FRAME_BYTES);
    const fv = new Float32Array(f);
    const uv = new Uint32Array(f);
    fv.set([...s.pos, 0], 0);
    fv.set(s.q, 4);
    uv.set([w, d, h, s.offset], 8);
    // world xy bounds, a cell of margin
    const b: [number, number, number, number] = [Math.min(...c.map((p) => p[0])) - 1, Math.min(...c.map((p) => p[1])) - 1, Math.max(...c.map((p) => p[0])) + 1, Math.max(...c.map((p) => p[1])) + 1];
    fv.set(b, 12);
    // (round 104, simscale: the projection runs over the chunks under the structures — grids/systems.ts)
    this.world.strBounds.set(s.slot, b);
    this.device.queue.writeBuffer(this.world.strFrames, s.slot * FRAME_BYTES, f);
  }
}
