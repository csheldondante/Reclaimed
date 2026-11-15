// Fine collision between bodies (docs/design/PHYSICS_ENGINE.md stage 3, `finePairs`): candidate pairs in, at most
// four contact rows a pair out (contract.ts), on the GPU with nothing read back. Kernels: sdf-fine.wgsl.
//
// Where the state lives: the inputs are the engine's (pairs and their count from the coarse stage; pose, velocity and
// info rows from integration) and are only read. This owns `contacts` (four rows a pair, at pair * 4), `hits` (a
// record a pair: how many samples touched, the largest energy, how many rows were written) and `counts`, all written
// by its kernels and read by the solver, the event stage and the lattice hand-over; and the `work` buffer (the half
// pairs' records and the brick list, rebuilt every pass) and the indirect args.
// Transfers: one 32 B uniform a pass. The fine dispatch is sized on the GPU (indirect).
//
// Choices (the note was silent):
// - Both bodies of a pair give samples, each in the other's field. One way misses a corner of the field's body
//   resting in a flat face of the sampler until it is about a voxel deep. Cost: twice the threads.
// - Threads follow the overlap: a model's samples are sorted into bricks of 4 × 4 × 4 voxels at the bake, and only the
//   bricks whose box reaches the other body's box (grown by the margin) get threads, a workgroup 16 samples.
// - A model with more samples than `cap` has every stride-th sample tested a tick (stride = ceil(count / cap)), the
//   offset turning with the tick: every sample is tested once in `stride` ticks.
// - Four contact rows a pair at most: the deepest sample, and the farthest out along three directions 120° apart
//   across the line of centres. Three spread points carry a resting or toppling body's torque; the deepest is the
//   corner or edge that hit. A row's normal is the mean of the pair's sample normals that point its way (the same
//   dominant axis in the pair's own axes: the line of centres and two across it), its energy the largest of the pair's samples.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../../gpu/pipeline';
import modelWgsl from '../../shaders/engine/sdf-model.wgsl?raw';
import fineWgsl from '../../shaders/engine/sdf-fine.wgsl?raw';
import { CONTACT_BYTES, CONTACTS_PER_PAIR, COUNTS_BYTES, PAIR_HIT_BYTES } from './contract';
import { sdfFormatWgsl, type SdfModels } from './models';

/** words a half pair in the work buffer (sdf-fine.wgsl HP_WORDS) */
const HP_WORDS = 28;

export interface FineOptions {
  /** candidate pairs a pass at most (pairs past it are not tested, and counted: size it to the coarse stage's buffer) */
  maxPairs: number;
  /** samples a half pair tests in one pass at most (a tuning parameter: `cap` can be set between passes) */
  cap?: number;
  /** contacts are written for gaps up to this, cells (a tuning parameter: `margin` can be set between passes) */
  margin?: number;
  /** groups of up to 16 samples (a brick of samples is one to four groups) a pass tests at most, all pairs together (default 64 a half pair, 4,096 at least); a group past it is counted as dropped */
  maxBricks?: number;
  /** the normal read again at the contact's point on the field's surface (a measured variant, off by default) */
  normalAtSurface?: boolean;
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
  /** contract.ts "A contact row": CONTACTS_PER_PAIR rows a pair, pair p's at p * CONTACTS_PER_PAIR; `hits` says how many are written */
  readonly contacts: GPUBuffer;
  /** contract.ts "A pair's record" */
  readonly hits: GPUBuffer;
  /** contract.ts COUNT_* */
  readonly counts: GPUBuffer;
  readonly maxPairs: number;
  readonly maxBricks: number;
  cap: number;
  margin: number;
  normalAtSurface: boolean;

  private params: GPUBuffer;
  private work: GPUBuffer;
  private args: GPUBuffer;
  private kExpand: ComputeKernel;
  private kCull: ComputeKernel;
  private kArgs: ComputeKernel;
  private kFine: ComputeKernel;
  private kReduce: ComputeKernel;
  private bound: { inputs: FineInputs; version: number; expand: GPUBindGroup; cull: GPUBindGroup; args: GPUBindGroup; fine: GPUBindGroup; reduce: GPUBindGroup } | null = null;

  constructor(
    private device: GPUDevice,
    private models: SdfModels,
    opts: FineOptions,
  ) {
    this.maxPairs = opts.maxPairs;
    this.cap = opts.cap ?? FINE_DEFAULT_CAP;
    this.margin = opts.margin ?? FINE_DEFAULT_MARGIN;
    this.normalAtSurface = opts.normalAtSurface ?? false;
    // (20 bits of half pair in a brick's word)
    if (this.maxPairs * 2 > 1 << 20) throw new Error(`SdfFine: ${this.maxPairs} pairs (at most ${1 << 19})`);
    this.maxBricks = opts.maxBricks ?? Math.max(4096, this.maxPairs * 2 * 64);
    const parts = [sdfFormatWgsl(models.format), modelWgsl, fineWgsl];
    this.kExpand = makeCompute(device, 'sdf expand', parts, { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 8: 'rw' }, 'expand');
    this.kCull = makeCompute(device, 'sdf cull', parts, { 0: 'uniform', 7: 'rw', 8: 'rw', 9: 'read' }, 'cull');
    this.kArgs = makeCompute(device, 'sdf fine args', parts, { 0: 'uniform', 2: 'read', 7: 'rw', 11: 'rw' }, 'fineArgs');
    this.kFine = makeCompute(device, 'sdf fine', parts, { 0: 'uniform', 3: 'read', 4: 'read', 5: 'read', 7: 'rw', 8: 'rw', 9: 'read', 12: 'rw' }, 'fine');
    this.kReduce = makeCompute(device, 'sdf reduce', parts, { 0: 'uniform', 3: 'read', 4: 'read', 5: 'read', 7: 'rw', 8: 'rw', 9: 'read', 10: 'rw', 12: 'rw' }, 'reduce');
    const S = GPUBufferUsage.STORAGE;
    this.params = device.createBuffer({ label: 'sdf fine params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.contacts = device.createBuffer({ label: 'sdf contacts', size: this.maxPairs * CONTACTS_PER_PAIR * CONTACT_BYTES, usage: S | GPUBufferUsage.COPY_SRC });
    this.hits = device.createBuffer({ label: 'sdf pair hits', size: this.maxPairs * PAIR_HIT_BYTES, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.counts = device.createBuffer({ label: 'sdf fine counts', size: COUNTS_BYTES, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.work = device.createBuffer({ label: 'sdf fine work', size: (this.maxPairs * 2 * HP_WORDS + this.maxBricks * 2) * 4, usage: S });
    this.args = device.createBuffer({ label: 'sdf fine args', size: 16, usage: S | GPUBufferUsage.INDIRECT });
  }

  /** bytes this pass holds on the GPU */
  get bytes(): number {
    return this.params.size + this.contacts.size + this.hits.size + this.counts.size + this.work.size + this.args.size;
  }

  private bind(inputs: FineInputs): NonNullable<SdfFine['bound']> {
    const b = this.bound;
    if (b && b.version === this.models.version && b.inputs.pairs === inputs.pairs && b.inputs.pairCount === inputs.pairCount && b.inputs.pose === inputs.pose && b.inputs.vel === inputs.vel && b.inputs.info === inputs.info) return b;
    const dev = this.device;
    const m = this.models;
    const rows = { 3: inputs.pose, 4: inputs.vel, 5: inputs.info };
    return (this.bound = {
      inputs: { ...inputs },
      version: m.version,
      expand: makeBindGroup(dev, 'sdf expand', this.kExpand.layout, { 0: this.params, 1: inputs.pairs, 2: inputs.pairCount, ...rows, 6: m.models, 8: this.work }),
      cull: makeBindGroup(dev, 'sdf cull', this.kCull.layout, { 0: this.params, 7: this.counts, 8: this.work, 9: m.data }),
      args: makeBindGroup(dev, 'sdf fine args', this.kArgs.layout, { 0: this.params, 2: inputs.pairCount, 7: this.counts, 11: this.args }),
      fine: makeBindGroup(dev, 'sdf fine', this.kFine.layout, { 0: this.params, ...rows, 7: this.counts, 8: this.work, 9: m.data, 12: this.hits }),
      reduce: makeBindGroup(dev, 'sdf reduce', this.kReduce.layout, { 0: this.params, ...rows, 7: this.counts, 8: this.work, 9: m.data, 10: this.contacts, 12: this.hits }),
    });
  }

  /**
   * The pass's parameters for the passes encoded from now until the next submit: `pairUpper` the most pairs the
   * coarse stage can have written (what the dispatches cover; the true count is read on the GPU), `tick` turns the
   * sample offset of models past the cap.
   */
  setParams(pairUpper: number, tick: number): void {
    const p = new ArrayBuffer(32);
    new Float32Array(p)[0] = this.margin;
    new Uint32Array(p).set([Math.max(1, this.cap), tick >>> 0, this.normalAtSurface ? 1 : 0, this.maxBricks, this.maxPairs, Math.min(pairUpper, this.maxPairs), 0], 1);
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  /** The pass encoded: counts and pair records cleared, then expand, cull, args, the indirect fine dispatch, reduce. Call setParams first. */
  encode(enc: GPUCommandEncoder, inputs: FineInputs, pairUpper: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const b = this.bind(inputs);
    const n = Math.max(1, Math.min(pairUpper, this.maxPairs));
    enc.clearBuffer(this.counts);
    enc.clearBuffer(this.hits, 0, n * PAIR_HIT_BYTES);
    const pass = enc.beginComputePass({ label: 'sdf fine', timestampWrites });
    const halves = Math.ceil((n * 2) / 64);
    pass.setPipeline(this.kExpand.pipeline);
    pass.setBindGroup(0, b.expand);
    pass.dispatchWorkgroups(halves);
    pass.setPipeline(this.kCull.pipeline);
    pass.setBindGroup(0, b.cull);
    // (a thread a half pair and a row of bricks: the store's longest model side in bricks, squared, rows a half pair)
    pass.dispatchWorkgroups(halves, this.models.maxBricksSide, this.models.maxBricksSide);
    pass.setPipeline(this.kArgs.pipeline);
    pass.setBindGroup(0, b.args);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.kFine.pipeline);
    pass.setBindGroup(0, b.fine);
    pass.dispatchWorkgroupsIndirect(this.args, 0);
    pass.setPipeline(this.kReduce.pipeline);
    pass.setBindGroup(0, b.reduce);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
  }

  destroy(): void {
    for (const b of [this.params, this.contacts, this.hits, this.counts, this.work, this.args]) b.destroy();
  }
}
