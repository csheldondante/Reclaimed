// (round 128p, DA-B22 (c)(2)) A tap's unit found on the GPU (shaders/unitpick.wgsl): the candidates the game names, each
// live one's figure projected as the camera projects it, the nearest within a radius of the tap. One u32 read back a
// tap — not every unit's position read every frame to pick among them on the CPU.

import { makeBindGroup, makeCompute, ignoreTeardown, type ComputeKernel } from '../gpu/pipeline';
import pickWgsl from '../shaders/unitpick.wgsl?raw';

const MAX_CAND = 8192;
const NONE = 0xffffffff;
/** the key's index bits (unitpick.wgsl) */
const IDX = 13;

export interface PickAsk {
  /** the camera's view-projection (column-major, as Camera.viewProj) and its viewport (CSS px) */
  viewProj: Float32Array;
  viewport: readonly [number, number];
  /** the tap (CSS px) */
  at: readonly [number, number];
  /** how far from the tap a figure may be (px) */
  radius: number;
  /** the figure's middle over its feet (cells) */
  lift: number;
}

export class UnitPick {
  private k: ComputeKernel;
  private cand: GPUBuffer;
  private best: GPUBuffer;
  private params: GPUBuffer;
  private read: GPUBuffer;
  private group: GPUBindGroup;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private device: GPUDevice,
    units: GPUBuffer,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.cand = device.createBuffer({ label: 'unitPick cand', size: MAX_CAND * 4, usage: S });
    this.best = device.createBuffer({ label: 'unitPick best', size: 16, usage: S | GPUBufferUsage.COPY_SRC });
    this.params = device.createBuffer({ label: 'unitPick params', size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.read = device.createBuffer({ label: 'unitPick read', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.k = makeCompute(device, 'agents-pick', [pickWgsl], { 1: 'read', 2: 'rw', 3: 'uniform', 7: 'read' }, 'pick');
    this.group = makeBindGroup(device, 'agents-pick', this.k.layout, { 1: this.cand, 2: this.best, 3: this.params, 7: units });
  }

  /**
   * The candidate (its index in `slots`) whose figure is nearest the tap within the radius, or null. Asks are taken in
   * turn (one read buffer).
   */
  pick(slots: readonly number[], ask: PickAsk): Promise<number | null> {
    const run = this.busy.then(() => this.run(slots, ask));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async run(slots: readonly number[], ask: PickAsk): Promise<number | null> {
    const n = Math.min(slots.length, MAX_CAND);
    if (!n) return null;
    this.device.queue.writeBuffer(this.cand, 0, new Uint32Array(slots.slice(0, n)));
    this.device.queue.writeBuffer(this.best, 0, new Uint32Array([NONE, 0, 0, 0]));
    const p = new Float32Array(24);
    p.set(ask.viewProj, 0);
    p.set([ask.viewport[0], ask.viewport[1], ask.at[0], ask.at[1]], 16);
    p.set([ask.radius, ask.lift, n, 0], 20);
    this.device.queue.writeBuffer(this.params, 0, p);
    const enc = this.device.createCommandEncoder({ label: 'agents pick' });
    const pass = enc.beginComputePass({ label: 'agents-pick' });
    pass.setPipeline(this.k.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(this.best, 0, this.read, 0, 4);
    this.device.queue.submit([enc.finish()]);
    let key = NONE;
    await this.read.mapAsync(GPUMapMode.READ, 0, 4).then(() => {
      key = new Uint32Array(this.read.getMappedRange(0, 4))[0];
      this.read.unmap();
    }, ignoreTeardown);
    return key === NONE ? null : key & ((1 << IDX) - 1);
  }
}
