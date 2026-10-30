// ---- play/draw/voxels.ts ----------------------------------------------------------------------------------------
// The heroes' voxels on the GPU (round 117): an instance list of rotated cubes the renderer draws like a body's voxels
// (Renderer.addVoxels: lit, shadowed, the hurt flash through the body glow bits — the form units/figures.ts and the
// GPU agents' units.wgsl write), rewritten from the CPU each frame. A few hundred voxels a frame: 32 bytes each.

import type { Renderer } from '../../render/renderer';
import { modelToWorld, VOXEL, type Part } from './shapes';

/** units.wgsl's: a body voxel that glows (the hurt flash), its heat in bits 16-23 */
const PHYS_BIT = 0x40000000;
const SIZE_CODE = Math.round(VOXEL * 16);

export class VoxelDraw {
  private inst: GPUBuffer;
  private indirect: GPUBuffer;
  private data: ArrayBuffer;
  private f: Float32Array;
  private u: Uint32Array;
  private count = -1;

  constructor(
    private device: GPUDevice,
    renderer: Renderer,
    private max = 2048,
  ) {
    this.data = new ArrayBuffer(max * 32);
    this.f = new Float32Array(this.data);
    this.u = new Uint32Array(this.data);
    this.inst = device.createBuffer({ label: 'playVoxels', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.indirect = device.createBuffer({ label: 'playVoxelsIndirect', size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([36, 0, 0, 0]));
    renderer.addVoxels(this.inst, this.indirect);
  }

  /** Each frame: these parts. */
  draw(parts: Part[]): void {
    let n = 0;
    for (const { voxels, at, q, flash } of parts) {
      const glow = flash && flash > 0 ? PHYS_BIT | (Math.round(Math.min(1, flash) * 255) << 16) : 0;
      for (const v of voxels) {
        if (n >= this.max) break;
        const c = modelToWorld(at, q, v.at);
        const o = n * 8;
        this.f[o] = c[0];
        this.f[o + 1] = c[1];
        this.f[o + 2] = c[2];
        this.u[o + 3] = v.mat | (SIZE_CODE << 24) | glow;
        this.f[o + 4] = q[0];
        this.f[o + 5] = q[1];
        this.f[o + 6] = q[2];
        this.f[o + 7] = q[3];
        n++;
      }
    }
    if (n > 0) this.device.queue.writeBuffer(this.inst, 0, this.data, 0, n * 32);
    if (n !== this.count) {
      this.count = n;
      this.device.queue.writeBuffer(this.indirect, 4, new Uint32Array([n]));
    }
  }

  dispose(): void {
    // (the renderer keeps drawing its sources: what's left is nothing)
    this.device.queue.writeBuffer(this.indirect, 4, new Uint32Array([0]));
    this.count = 0;
  }
}
