// Fine collision between bodies (docs/design/PHYSICS_ENGINE.md stage 3, `finePairs`): candidate pairs in, at most
// four contact rows a pair out (contract.ts), on the GPU with nothing read back. Kernels: sdf-fine.wgsl.
//
// Where the state lives: the inputs are the engine's (pairs and their count from the coarse stage; pose, velocity and
// info rows from integration) and are only read. This owns `contacts` (four rows a slot, at slot * 4), `slotKeys` (a
// slot's pair, age and pair index, beside its rows), `hits` (a record a pair of this pass's list: how many samples
// touched, the largest energy, how many rows were written, the pair's slot) and `counts`, all written by its kernels
// and read by the solver, the event stage and the lattice hand-over; and the slots' stamps, the `work` buffer (the
// half pairs' records and the brick list, rebuilt every pass) and the indirect args.
// Transfers: one 48 B uniform a pass. The fine dispatch is sized on the GPU (indirect).
// Rooms: `maxPairs` (the coarse pass's pair room: collide.ts keeps them one), `maxBricks` (the sample groups' list)
// and `slots` (the pair slots' table). Groups past the room and pairs that find no slot are counted and both rows of
// their pair flagged in the engine-visible `missing` words (contract.ts MISS_GROUPS, MISS_SLOTS); `grow` makes any
// room bigger with no new pipeline.
//
// Stable pair slots (the scheme is in sdf-fine.wgsl's header): a pair keeps its slot, and so the place of its contact
// rows, for as long as it is in the pair list every pass; absent for one pass, it has lost it, and a pair that comes
// back starts in a zeroed slot with age 0. The solver keeps its impulses by slot and starts them from nothing when a
// slot's age is 0. A growth of the table moves every live pair (the next `encode` runs `rehash` first): `slotRemap`
// then says where each old slot went and `slotGeneration` has gone up by one, for the solver to move its own.
//
// Choices (the note was silent):
// - Both bodies of a pair give samples, each in the other's field. One way misses a corner of the field's body
//   resting in a flat face of the sampler until it is about a voxel deep. Cost: twice the threads.
// - Threads follow the overlap: a model's samples are sorted into bricks of 4 × 4 × 4 voxels at the bake, and only the
//   bricks whose box reaches the other body's box (grown by the margin) get threads, a workgroup 16 samples.
// - A model with more samples than `cap` has every stride-th sample tested a tick (stride = ceil(count / cap)), the
//   offset turning with the tick: every sample is tested once in `stride` ticks. Only the tick's samples get threads.
// - Four contact rows a pair at most: the deepest sample, and the farthest out along three directions 120° apart
//   across the line of centres. Three spread points carry a resting or toppling body's torque; the deepest is the
//   corner or edge that hit. A row's normal is the mean of the pair's sample normals that point its way (the same
//   dominant axis in the pair's own axes: the line of centres and two across it), its energy the largest of the pair's samples.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../../gpu/pipeline';
import modelWgsl from '../../shaders/engine/sdf-model.wgsl?raw';
import fineWgsl from '../../shaders/engine/sdf-fine.wgsl?raw';
import { CONTACT_BYTES, CONTACTS_PER_PAIR, COUNT_SLOT_EPOCH, COUNTS_BYTES, PAIR_HIT_BYTES, SLOT_KEY_BYTES } from './contract';
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
  /** groups of up to 16 samples (a brick of samples is one to four groups) a pass tests at most, all pairs together (default 64 a half pair, 4,096 at least); a group past it is counted as dropped and its pair's rows flagged in `missing`. It grows (collide.ts) */
  maxBricks?: number;
  /** entries of the pair slots' table, a power of two (default: the power of two at or above maxPairs, 64 at least: at most half full while the pair room is, as collide.ts keeps it). It grows at half full */
  slots?: number;
}

/** the engine's buffers the pass reads (contract.ts "the engine's rows") */
export interface FineInputs {
  /** (a, b) a pair; a GPUBufferBinding when the pairs sit past a header (the coarse pass's buffer) */
  pairs: GPUBuffer | GPUBufferBinding;
  /** word 0: how many pairs */
  pairCount: GPUBuffer | GPUBufferBinding;
  pose: GPUBuffer;
  vel: GPUBuffer;
  info: GPUBuffer;
  /** a u32 a body row: its model row in the store */
  model: GPUBuffer;
  /** a u32 a body row, contract.ts MISS_* (the coarse pass's `missing`): the pass sets a bit on both rows of a pair whose contacts it could not all make */
  missing: GPUBuffer;
}

export const FINE_DEFAULT_CAP = 2048;
export const FINE_DEFAULT_MARGIN = 0.25;

type Kernel = 'pairArgs' | 'slots' | 'rehash' | 'expand' | 'cull' | 'fineArgs' | 'fine' | 'reduce';

export class SdfFine {
  /** contract.ts "A contact row": CONTACTS_PER_PAIR rows a slot, slot s's at s * CONTACTS_PER_PAIR; a pair's record names its slot and says how many are written. Replaced by `grow` */
  contacts!: GPUBuffer;
  /** contract.ts "A slot's key record": 16 B a slot, beside its rows. Replaced by `grow` */
  slotKeys!: GPUBuffer;
  /** after a growth of the slots: a u32 an old slot, its new slot or NO_SLOT (valid once the next `encode`'s commands have run, until the growth after) */
  slotRemap: GPUBuffer | null = null;
  /** goes up by one when the slots' table grows: every live pair's slot changed (`slotRemap`) */
  slotGeneration = 0;
  /** contract.ts "A pair's record": one a pair of this pass's list. Replaced by `grow` */
  hits!: GPUBuffer;
  /** contract.ts COUNT_* */
  readonly counts: GPUBuffer;
  /** the rooms (`grow` changes them) */
  maxPairs = 0;
  maxBricks = 0;
  slots = 0;
  cap: number;
  margin: number;
  /** for the bench's isolation only: encode pairArgs and slots alone (0), or everything (1) */
  upTo = 1;

  private params: GPUBuffer;
  private work!: GPUBuffer;
  private stamps!: GPUBuffer;
  private args: GPUBuffer;
  /** a growth of the slots waiting for the next `encode`: the table being left */
  private leaving: { stamps: GPUBuffer; keys: GPUBuffer; contacts: GPUBuffer; slots: number } | null = null;
  /** buffers replaced by `grow`, destroyed by `release` */
  private retired: GPUBuffer[] = [];
  private k: Record<Kernel, ComputeKernel>;
  private bound: { inputs: FineInputs; version: number; g: Record<Exclude<Kernel, 'rehash'>, GPUBindGroup> } | null = null;

  constructor(
    private device: GPUDevice,
    private models: SdfModels,
    opts: FineOptions,
  ) {
    this.cap = opts.cap ?? FINE_DEFAULT_CAP;
    this.margin = opts.margin ?? FINE_DEFAULT_MARGIN;
    const parts = [sdfFormatWgsl(models.format), modelWgsl, fineWgsl];
    const mk = (name: Kernel, spec: Record<number, 'read' | 'rw'>) => makeCompute(device, `sdf ${name}`, parts, { 0: 'uniform', ...spec }, name);
    this.k = {
      pairArgs: mk('pairArgs', { 2: 'read', 7: 'rw', 11: 'rw' }),
      slots: mk('slots', { 1: 'read', 2: 'read', 7: 'rw', 10: 'rw', 12: 'rw', 15: 'rw', 16: 'rw', 17: 'rw' }),
      rehash: mk('rehash', { 7: 'rw', 10: 'rw', 16: 'rw', 17: 'rw', 19: 'read', 20: 'read', 21: 'read', 22: 'rw' }),
      expand: mk('expand', { 1: 'read', 2: 'read', 3: 'read', 4: 'read', 6: 'read', 8: 'rw', 13: 'read' }),
      cull: mk('cull', { 7: 'rw', 8: 'rw', 9: 'read', 15: 'rw' }),
      fineArgs: mk('fineArgs', { 2: 'read', 7: 'rw', 11: 'rw' }),
      fine: mk('fine', { 3: 'read', 4: 'read', 5: 'read', 8: 'rw', 9: 'read', 12: 'rw', 14: 'read' }),
      reduce: mk('reduce', { 3: 'read', 4: 'read', 5: 'read', 7: 'rw', 8: 'rw', 9: 'read', 10: 'rw', 12: 'rw' }),
    };
    const S = GPUBufferUsage.STORAGE;
    this.params = device.createBuffer({ label: 'sdf fine params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // (the slots' epoch starts at 1: a stamp of 0 is an entry never used)
    this.counts = device.createBuffer({ label: 'sdf fine counts', size: COUNTS_BYTES, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    new Uint32Array(this.counts.getMappedRange())[COUNT_SLOT_EPOCH] = 1;
    this.counts.unmap();
    this.args = device.createBuffer({ label: 'sdf fine args', size: 64, usage: S | GPUBufferUsage.INDIRECT });
    let slots = 64;
    while (slots < opts.maxPairs) slots *= 2;
    this.grow({ maxPairs: opts.maxPairs, maxBricks: opts.maxBricks ?? Math.max(4096, opts.maxPairs * 2 * 64), slots: opts.slots ?? slots });
  }

  /**
   * A room made bigger (never smaller): the buffers that depend on it are made again, and the bind groups at the next
   * `encode`; no pipeline. The pairs' and groups' buffers are rebuilt by the pass each tick, so nothing of theirs is
   * copied. The slots' table is kept: the next `encode` first moves every live slot (key, age, rows) into the new
   * table on the GPU. The old buffers are kept until `release` (an encoder not yet submitted may still use them).
   */
  grow(to: { maxPairs?: number; maxBricks?: number; slots?: number }): void {
    const dev = this.device;
    const S = GPUBufferUsage.STORAGE;
    const pairs = Math.max(to.maxPairs ?? 0, this.maxPairs);
    const bricks = Math.max(to.maxBricks ?? 0, this.maxBricks);
    const slots = Math.max(to.slots ?? 0, this.slots);
    // (27 bits of half pair in a group's word)
    if (pairs * 2 > 1 << 27) throw new Error(`SdfFine: ${pairs} pairs (at most ${1 << 26})`);
    if (slots & (slots - 1)) throw new Error(`SdfFine: ${slots} slots (a power of two)`);
    if (pairs > this.maxPairs) {
      if (this.hits) this.retired.push(this.hits);
      this.hits = dev.createBuffer({ label: 'sdf pair hits', size: pairs * PAIR_HIT_BYTES, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    }
    if (pairs > this.maxPairs || bricks > this.maxBricks) {
      if (this.work) this.retired.push(this.work);
      this.work = dev.createBuffer({ label: 'sdf fine work', size: (pairs * 2 * HP_WORDS + bricks * 2) * 4, usage: S });
    }
    if (slots > this.slots) {
      if (this.contacts) {
        // (a growth still waiting for its `encode`: the table it was leaving is still the one to move from, and the
        // table it made was never used)
        if (this.leaving) this.retired.push(this.contacts, this.slotKeys, this.stamps);
        else this.leaving = { stamps: this.stamps, keys: this.slotKeys, contacts: this.contacts, slots: this.slots };
        if (this.slotRemap) this.retired.push(this.slotRemap);
        this.slotRemap = dev.createBuffer({ label: 'sdf slot remap', size: this.leaving.slots * 4, usage: S | GPUBufferUsage.COPY_SRC });
      }
      this.contacts = dev.createBuffer({ label: 'sdf contacts', size: slots * CONTACTS_PER_PAIR * CONTACT_BYTES, usage: S | GPUBufferUsage.COPY_SRC });
      this.slotKeys = dev.createBuffer({ label: 'sdf slot keys', size: slots * SLOT_KEY_BYTES, usage: S | GPUBufferUsage.COPY_SRC });
      this.stamps = dev.createBuffer({ label: 'sdf slot stamps', size: slots * 4, usage: S | GPUBufferUsage.COPY_SRC });
    }
    this.maxPairs = pairs;
    this.maxBricks = bricks;
    this.slots = slots;
    this.bound = null;
  }

  /** the buffers `grow` replaced, destroyed: call when every encoder made before the growth has been submitted */
  release(): void {
    for (const b of this.retired.splice(0)) b.destroy();
  }

  /** bytes this pass holds on the GPU */
  get bytes(): number {
    return this.params.size + this.contacts.size + this.slotKeys.size + this.stamps.size + this.hits.size + this.counts.size + this.work.size + this.args.size;
  }

  private bind(inputs: FineInputs): NonNullable<SdfFine['bound']> {
    const b = this.bound;
    if (b && b.version === this.models.version && (Object.keys(inputs) as (keyof FineInputs)[]).every((k) => b.inputs[k] === inputs[k])) return b;
    const m = this.models;
    const rows = { 3: inputs.pose, 4: inputs.vel, 5: inputs.info };
    const g = (name: Kernel, res: Record<number, GPUBuffer | GPUBufferBinding>) => makeBindGroup(this.device, `sdf ${name}`, this.k[name].layout, { 0: this.params, ...res });
    return (this.bound = {
      inputs: { ...inputs },
      version: m.version,
      g: {
        pairArgs: g('pairArgs', { 2: inputs.pairCount, 7: this.counts, 11: this.args }),
        slots: g('slots', { 1: inputs.pairs, 2: inputs.pairCount, 7: this.counts, 10: this.contacts, 12: this.hits, 15: inputs.missing, 16: this.stamps, 17: this.slotKeys }),
        expand: g('expand', { 1: inputs.pairs, 2: inputs.pairCount, 3: inputs.pose, 4: inputs.vel, 6: m.models, 8: this.work, 13: inputs.model }),
        cull: g('cull', { 7: this.counts, 8: this.work, 9: m.data, 15: inputs.missing }),
        fineArgs: g('fineArgs', { 2: inputs.pairCount, 7: this.counts, 11: this.args }),
        fine: g('fine', { ...rows, 8: this.work, 9: m.data, 12: this.hits, 14: this.args }),
        reduce: g('reduce', { ...rows, 7: this.counts, 8: this.work, 9: m.data, 10: this.contacts, 12: this.hits }),
      },
    });
  }

  /**
   * The pass's parameters for the passes encoded from now until the next submit (and after any `grow`): `pairUpper`
   * the most pairs the coarse stage can have written (what the dispatches cover; the true count is read on the GPU),
   * `tick` turns the sample offset of models past the cap.
   */
  setParams(pairUpper: number, tick: number): void {
    const p = new ArrayBuffer(48);
    new Float32Array(p)[0] = this.margin;
    new Uint32Array(p).set([Math.max(1, this.cap), tick >>> 0, this.leaving?.slots ?? 0, this.maxBricks, this.maxPairs, Math.min(pairUpper, this.maxPairs), this.models.maxBricksSide, this.slots], 1);
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  /**
   * The pass encoded: after a growth of the slots, rehash; then pairArgs (which zeroes this pass's counts), slots
   * (which clears the pairs' records), expand, cull, fineArgs, fine, reduce, all but the two one-thread ones sized on
   * the GPU. Call setParams first.
   */
  encode(enc: GPUCommandEncoder, inputs: FineInputs, pairUpper: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const b = this.bind(inputs).g;
    void pairUpper;
    const pass = enc.beginComputePass({ label: 'sdf fine', timestampWrites });
    const old = this.leaving;
    if (old) {
      // (the one dispatch sized on the CPU: a thread an entry of the table being left, once a growth)
      pass.setPipeline(this.k.rehash.pipeline);
      pass.setBindGroup(0, makeBindGroup(this.device, 'sdf rehash', this.k.rehash.layout, { 0: this.params, 7: this.counts, 10: this.contacts, 16: this.stamps, 17: this.slotKeys, 19: old.stamps, 20: old.keys, 21: old.contacts, 22: this.slotRemap! }));
      pass.dispatchWorkgroups(Math.ceil(old.slots / 64));
      this.retired.push(old.stamps, old.keys, old.contacts);
      this.leaving = null;
      this.slotGeneration++;
    }
    const at = (name: Exclude<Kernel, 'rehash'>, word: number | null) => {
      pass.setPipeline(this.k[name].pipeline);
      pass.setBindGroup(0, b[name]);
      if (word === null) pass.dispatchWorkgroups(1);
      else pass.dispatchWorkgroupsIndirect(this.args, word * 4);
    };
    // (every dispatch after this one is sized on the GPU: by the pair count, then by the surviving groups)
    at('pairArgs', null);
    at('slots', 12);
    if (this.upTo < 1) {
      pass.end();
      return;
    }
    at('expand', 4);
    // (a thread a half pair and a row of bricks: the store's longest model side in bricks, squared, rows a half pair)
    at('cull', 8);
    at('fineArgs', null);
    at('fine', 0);
    at('reduce', 12);
    pass.end();
  }

  destroy(): void {
    this.release();
    if (this.leaving) for (const b of [this.leaving.stamps, this.leaving.keys, this.leaving.contacts]) b.destroy();
    for (const b of [this.params, this.contacts, this.slotKeys, this.stamps, this.hits, this.counts, this.work, this.args]) b.destroy();
    this.slotRemap?.destroy();
  }
}
