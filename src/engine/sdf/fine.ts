// Fine collision between bodies (docs/design/PHYSICS_ENGINE.md stage 3, `finePairs`): candidate pairs in, contact
// rows out (contract.ts), on the GPU with nothing read back. Kernels: sdf-fine.wgsl.
//
// Where the state lives: the inputs are the engine's (pairs and their count from the coarse stage; pose, velocity and
// info rows from integration) and are only read. This owns `contacts` and `counts` (written by the fine kernel,
// read by the solver and the event stage), the `work` buffer (the half pairs' records and the chunk list, rebuilt
// every pass) and the indirect args.
// Transfers: one 32 B uniform a pass. The fine dispatch is sized on the GPU (indirect).
//
// Choices (the note was silent):
// - Both bodies of a pair give samples, each in the other's field. One way misses a corner of the field's body
//   resting in a flat face of the sampler until it is about a voxel deep. Cost: twice the threads.
// - A half pair tests at most `cap` samples, spread evenly over the model's list, the offset turning with the tick, so
//   a big body's cost is bounded and every sample is tested once in ceil(count / cap) ticks.
// - Threads are packed: a workgroup is one chunk of 64 samples of one half pair, so a small model next to a big one
//   wastes at most 63 threads, and a pair whose bound spheres miss costs one thread.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../../gpu/pipeline';
import modelWgsl from '../../shaders/engine/sdf-model.wgsl?raw';
import fineWgsl from '../../shaders/engine/sdf-fine.wgsl?raw';
import { CONTACT_BYTES, COUNTS_BYTES } from './contract';
import { sdfFormatWgsl, type SdfModels } from './models';

/** words a half pair in the work buffer (sdf-fine.wgsl HP_WORDS) */
const HP_WORDS = 24;
const CHUNK = 64;

export interface FineOptions {
  /** candidate pairs a pass at most (the work buffer's size; pairs past it are not tested: size it to the coarse stage's buffer) */
  maxPairs: number;
  /** contact rows; a contact past them is counted as dropped */
  maxContacts: number;
  /** samples a half pair tests in one pass at most */
  cap?: number;
  /** contacts are written for gaps up to this, cells */
  margin?: number;
}

/** the engine's buffers the pass reads (contract.ts for each row) */
export interface FineInputs {
  pairs: GPUBuffer;
  /** word 0: how many pairs */
  pairCount: GPUBuffer;
  pose: GPUBuffer;
  vel: GPUBuffer;
  info: GPUBuffer;
}

export const FINE_DEFAULT_CAP = 2048;
export const FINE_DEFAULT_MARGIN = 0.25;

export class SdfFine {
  /** contract.ts "A contact row" */
  readonly contacts: GPUBuffer;
  /** contract.ts COUNT_* */
  readonly counts: GPUBuffer;
  readonly maxPairs: number;
  readonly maxContacts: number;
  readonly maxChunks: number;
  cap: number;
  margin: number;

  private params: GPUBuffer;
  private work: GPUBuffer;
  private args: GPUBuffer;
  private kExpand: ComputeKernel;
  private kArgs: ComputeKernel;
  private kFine: ComputeKernel;
  private bound: { inputs: FineInputs; version: number; expand: GPUBindGroup; args: GPUBindGroup; fine: GPUBindGroup } | null = null;

  constructor(
    private device: GPUDevice,
    private models: SdfModels,
    opts: FineOptions,
  ) {
    this.maxPairs = opts.maxPairs;
    this.maxContacts = opts.maxContacts;
    this.cap = opts.cap ?? FINE_DEFAULT_CAP;
    this.margin = opts.margin ?? FINE_DEFAULT_MARGIN;
    // (20 bits of half pair and 12 of chunk in a chunk word)
    if (this.maxPairs * 2 > 1 << 20) throw new Error(`SdfFine: ${this.maxPairs} pairs (at most ${1 << 19})`);
    if (this.cap > 4096 * CHUNK) throw new Error(`SdfFine: a cap of ${this.cap} samples (at most ${4096 * CHUNK})`);
    // (every half pair at its cap: the chunk list can't run out)
    this.maxChunks = this.maxPairs * 2 * Math.ceil(this.cap / CHUNK);
    const parts = [sdfFormatWgsl(models.format), modelWgsl, fineWgsl];
    this.kExpand = makeCompute(device, 'sdf expand', parts, { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'rw' }, 'expand');
    this.kArgs = makeCompute(device, 'sdf fine args', parts, { 0: 'uniform', 7: 'rw', 11: 'rw' }, 'fineArgs');
    this.kFine = makeCompute(device, 'sdf fine', parts, { 0: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'rw', 8: 'rw', 9: 'read', 10: 'rw' }, 'fine');
    const S = GPUBufferUsage.STORAGE;
    this.params = device.createBuffer({ label: 'sdf fine params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.contacts = device.createBuffer({ label: 'sdf contacts', size: this.maxContacts * CONTACT_BYTES, usage: S | GPUBufferUsage.COPY_SRC });
    this.counts = device.createBuffer({ label: 'sdf fine counts', size: COUNTS_BYTES, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.work = device.createBuffer({ label: 'sdf fine work', size: (this.maxPairs * 2 * HP_WORDS + this.maxChunks) * 4, usage: S });
    this.args = device.createBuffer({ label: 'sdf fine args', size: 16, usage: S | GPUBufferUsage.INDIRECT });
  }

  /** bytes this pass holds on the GPU */
  get bytes(): number {
    return this.params.size + this.contacts.size + this.counts.size + this.work.size + this.args.size;
  }

  private bind(inputs: FineInputs): NonNullable<SdfFine['bound']> {
    const b = this.bound;
    if (b && b.version === this.models.version && b.inputs.pairs === inputs.pairs && b.inputs.pairCount === inputs.pairCount && b.inputs.pose === inputs.pose && b.inputs.vel === inputs.vel && b.inputs.info === inputs.info) return b;
    const dev = this.device;
    const m = this.models;
    return (this.bound = {
      inputs: { ...inputs },
      version: m.version,
      expand: makeBindGroup(dev, 'sdf expand', this.kExpand.layout, { 0: this.params, 1: inputs.pairs, 2: inputs.pairCount, 3: inputs.pose, 4: inputs.vel, 5: inputs.info, 6: m.models, 7: this.counts, 8: this.work }),
      args: makeBindGroup(dev, 'sdf fine args', this.kArgs.layout, { 0: this.params, 7: this.counts, 11: this.args }),
      fine: makeBindGroup(dev, 'sdf fine', this.kFine.layout, { 0: this.params, 3: inputs.pose, 4: inputs.vel, 5: inputs.info, 6: m.models, 7: this.counts, 8: this.work, 9: m.data, 10: this.contacts }),
    });
  }

  /**
   * The pass's parameters for the passes encoded from now until the next submit: `pairUpper` the most pairs the
   * coarse stage can have written (what the expand dispatch covers; the true count is read on the GPU), `tick` turns
   * the sample offset of capped half pairs.
   */
  setParams(pairUpper: number, tick: number): void {
    const p = new ArrayBuffer(32);
    new Float32Array(p)[0] = this.margin;
    new Uint32Array(p).set([this.cap, tick >>> 0, this.maxContacts, this.maxChunks, this.maxPairs, Math.min(pairUpper, this.maxPairs), 0], 1);
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  /** The pass encoded: counts cleared, then expand, args and the indirect fine dispatch. Call setParams first. */
  encode(enc: GPUCommandEncoder, inputs: FineInputs, pairUpper: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const b = this.bind(inputs);
    enc.clearBuffer(this.counts);
    const pass = enc.beginComputePass({ label: 'sdf fine', timestampWrites });
    pass.setPipeline(this.kExpand.pipeline);
    pass.setBindGroup(0, b.expand);
    pass.dispatchWorkgroups(Math.max(1, Math.ceil((Math.min(pairUpper, this.maxPairs) * 2) / 64)));
    pass.setPipeline(this.kArgs.pipeline);
    pass.setBindGroup(0, b.args);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.kFine.pipeline);
    pass.setBindGroup(0, b.fine);
    pass.dispatchWorkgroupsIndirect(this.args, 0);
    pass.end();
  }

  destroy(): void {
    for (const b of [this.params, this.contacts, this.counts, this.work, this.args]) b.destroy();
  }
}
