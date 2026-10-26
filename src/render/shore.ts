// The shore field (round 83, shore.wgsl): the nearest shore point to every column, by jump flooding over the
// water's depth — for the water's swell (render.wgsl fsWater: lines parallel to the shore, running in). Made
// again every MAKE_S (the water moves slowly) and when the renderer's asked to (a slide: the columns moved).

import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { WorldGpu } from '../sim/world-gpu';
import commonWgsl from '../shaders/common.wgsl?raw';
import shoreWgsl from '../shaders/shore.wgsl?raw';

/** seconds between makings */
const MAKE_S = 1;

export class ShoreField {
  private tex: [GPUTexture, GPUTexture];
  private views: [GPUTextureView, GPUTextureView];
  private seed: ComputeKernel;
  private jump: ComputeKernel;
  private params: GPUBuffer[];
  private groups: { seed: GPUBindGroup; jump: GPUBindGroup[] };
  /** jumps a making: k = 2^(n−1) … 1, then 1 again */
  private ks: number[];
  /** which texture the last making ended in */
  private out = 0;
  private due = 0;

  constructor(
    device: GPUDevice,
    world: WorldGpu,
    private w: number,
    private h: number,
  ) {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const mk = (n: number) => device.createTexture({ label: `shore ${n}`, size: [w, h], format: 'rgba32float', usage });
    this.tex = [mk(0), mk(1)];
    this.views = [this.tex[0].createView(), this.tex[1].createView()];
    const parts = [commonWgsl, shoreWgsl];
    const spec = { 0: 'uniform', 3: 'read', 4: 'tex', 5: 'stex', 6: 'uniform' } as const;
    this.seed = makeCompute(device, 'shore-seed', parts, spec, 'shoreSeed');
    this.jump = makeCompute(device, 'shore-jump', parts, spec, 'shoreJump');
    this.ks = [];
    for (let k = 1 << Math.ceil(Math.log2(Math.max(w, h) / 2)); k >= 1; k >>= 1) this.ks.push(k);
    this.ks.push(1);
    // (the draws are bound to the texture the making ends in: the same one each time)
    this.out = this.ks.length % 2;
    this.params = this.ks.map((k) => {
      const b = device.createBuffer({ label: 'shore k', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Uint32Array([k, 0, 0, 0]));
      return b;
    });
    // (ping-pong: the seed pass writes 0; jump i reads (i % 2 == 0 ? 0 : 1) and writes the other)
    const g = (k: ComputeKernel, from: number, to: number, p: GPUBuffer) =>
      makeBindGroup(device, 'shore', k.layout, { 0: world.globals, 3: world.water, 4: this.views[from], 5: this.views[to], 6: p });
    this.groups = { seed: g(this.seed, 1, 0, this.params[0]), jump: this.ks.map((_, i) => g(this.jump, i % 2, 1 - (i % 2), this.params[i])) };
  }

  /** the field as last made (render.wgsl shoreTex) */
  get view(): GPUTextureView {
    return this.views[this.out];
  }

  /** make it again at the next frame */
  dirty(): void {
    this.due = 0;
  }

  /** Each frame: make it when it's due (into the frame's encoder, before the draws read it). */
  encode(enc: GPUCommandEncoder, now: number): void {
    if (now < this.due) return;
    this.due = now + MAKE_S * 1000;
    const wg = [Math.ceil(this.w / 8), Math.ceil(this.h / 8)] as const;
    const cp = enc.beginComputePass({ label: 'shore' });
    cp.setPipeline(this.seed.pipeline);
    cp.setBindGroup(0, this.groups.seed);
    cp.dispatchWorkgroups(...wg);
    cp.setPipeline(this.jump.pipeline);
    this.groups.jump.forEach((gj) => {
      cp.setBindGroup(0, gj);
      cp.dispatchWorkgroups(...wg);
    });
    cp.end();
  }

  dispose(): void {
    for (const t of this.tex) t.destroy();
    for (const b of this.params) b.destroy();
  }
}
