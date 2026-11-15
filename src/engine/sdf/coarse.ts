// Coarse collision between bodies (docs/design/PHYSICS_ENGINE.md stage 2): the engine's rows in, candidate pairs out
// in the layout the fine pass reads, on the GPU with nothing read back. Kernels: sdf-coarse.wgsl (the scheme is in its
// header). The owner: "Just make bounding boxes … I do like spatial hashes but not for fully voxelated things": the
// hash is over body bounds, never voxels.
//
// Where the state lives: the rows, the awake list and the sleep epoch are the engine's and are only read. This owns
// `table` (both hashes), `pairBuf` (a 256 B header: pairs asked for, awake rows too big for the top level; then the
// pairs) and `state` (the epoch the sleeper hash was built for, and indirect arguments).
// Transfers: one 32 B uniform a pass.
// Work: the awake hash is cleared (a GPU clear of its heads) and rebuilt every tick by the awake rows; the pairs pass
// is a thread an awake row and a level; the sleeper hash is rebuilt only in a tick whose sleep epoch differs from the
// one it was built for (its two dispatches have zero workgroups otherwise).
//
// Room: `rows` is the capacity the buffers are made for; the pair buffer has `pairsARow` pairs a row (grown with the
// rows: make a bigger SdfCoarse, as the engine makes its row buffers again). Pairs past the room are not written and
// `pairBuf[0]` still counts them: the fine pass reports the difference (COUNT_PAIRS_DROPPED), never silently.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../../gpu/pipeline';
import modelWgsl from '../../shaders/engine/sdf-model.wgsl?raw';
import coarseWgsl from '../../shaders/engine/sdf-coarse.wgsl?raw';
import { sdfFormatWgsl, type SdfModels } from './models';

export interface CoarseOptions {
  /** body rows the buffers are made for */
  rows: number;
  /** the top level's cell, cells: at least the biggest body's bound diameter plus the margin (a bigger body is counted, and may miss pairs) */
  cellTop: number;
  /** levels, each half the one above (default 5: cellTop / 16 the finest) */
  levels?: number;
  /** the fine pass's margin, cells */
  margin?: number;
  /** pairs the buffer has room for, a row (default 8) */
  pairsARow?: number;
}

/** the engine's buffers the pass reads (contract.ts "the engine's rows") */
export interface CoarseInputs {
  /** the engine's awake list: [0..2] indirect arguments (workgroups of 64 awake rows, 1, 1), [3] rows awake, the rows from word 8 */
  list: GPUBuffer;
  pose: GPUBuffer;
  vel: GPUBuffer;
  info: GPUBuffer;
  /** a u32 a body row: its model row in the store */
  model: GPUBuffer;
  /** word 0 changes whenever a row falls asleep, wakes, is made or freed asleep, or a sleeper is moved */
  sleepEpoch: GPUBuffer;
}

/** words before the pairs in `pairBuf`: 256 B, the alignment a storage binding that starts at the pairs needs */
export const PAIR_HEADER_WORDS = 64;
export const PAIR_ASKED = 0;
export const PAIR_OVERSIZE = 1;

export class SdfCoarse {
  /** [PAIR_ASKED] pairs asked for, [PAIR_OVERSIZE] awake rows too big for the top level, then (a, b) a pair from word PAIR_HEADER_WORDS */
  readonly pairBuf: GPUBuffer;
  readonly state: GPUBuffer;
  readonly table: GPUBuffer;
  readonly rows: number;
  readonly pairRoom: number;
  readonly levels: number;
  readonly heads: number;
  readonly cellTop: number;
  margin: number;

  private params: GPUBuffer;
  private k: Record<'gate' | 'clearSleep' | 'insertSleep' | 'insertAwake' | 'pairs', ComputeKernel>;
  private bound: { inputs: CoarseInputs; version: number; groups: Record<keyof SdfCoarse['k'], GPUBindGroup> } | null = null;

  constructor(
    private device: GPUDevice,
    private models: SdfModels,
    opts: CoarseOptions,
  ) {
    this.rows = opts.rows;
    this.levels = opts.levels ?? 5;
    this.cellTop = opts.cellTop;
    this.margin = opts.margin ?? 0.25;
    this.pairRoom = Math.max(1024, this.rows * (opts.pairsARow ?? 8));
    // (two buckets a row at least: short chains)
    let heads = 1 << 12;
    while (heads < this.rows * 2) heads *= 2;
    this.heads = heads;
    const parts = [sdfFormatWgsl(models.format), modelWgsl, coarseWgsl];
    this.k = {
      gate: makeCompute(device, 'sdf coarse gate', parts, { 0: 'uniform', 1: 'read', 9: 'rw', 10: 'read' }, 'gate'),
      clearSleep: makeCompute(device, 'sdf coarse clear sleepers', parts, { 0: 'uniform', 7: 'rw' }, 'clearSleep'),
      insertSleep: makeCompute(device, 'sdf coarse insert sleepers', parts, { 0: 'uniform', 2: 'read', 3: 'read', 4: 'read', 7: 'rw' }, 'insertSleep'),
      insertAwake: makeCompute(device, 'sdf coarse insert awake', parts, { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 7: 'rw', 8: 'rw' }, 'insertAwake'),
      pairs: makeCompute(device, 'sdf coarse pairs', parts, { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 5: 'read', 6: 'read', 8: 'rw', 11: 'read' }, 'pairs'),
    };
    const S = GPUBufferUsage.STORAGE;
    this.params = device.createBuffer({ label: 'sdf coarse params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.table = device.createBuffer({ label: 'sdf coarse table', size: (2 * heads + this.rows + this.rows * this.levels + 1) * 4, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.pairBuf = device.createBuffer({ label: 'sdf pairs', size: (PAIR_HEADER_WORDS + this.pairRoom * 2) * 4, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    // (the epoch built for starts as one no engine uses, so the first tick builds the sleeper hash)
    this.state = device.createBuffer({ label: 'sdf coarse state', size: 64, usage: S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    new Uint32Array(this.state.getMappedRange())[0] = 0xffffffff;
    this.state.unmap();
  }

  /** bytes this pass holds on the GPU */
  get bytes(): number {
    return this.params.size + this.table.size + this.pairBuf.size + this.state.size;
  }

  /** the pair list as the fine pass's inputs */
  get finePairs(): { pairs: GPUBufferBinding; pairCount: GPUBufferBinding } {
    return { pairs: { buffer: this.pairBuf, offset: PAIR_HEADER_WORDS * 4 }, pairCount: { buffer: this.pairBuf, offset: 0, size: 16 } };
  }

  /** The pass's parameters for the passes encoded from now until the next submit: `rows` the engine's rows in use. */
  setParams(rows: number): void {
    if (rows > this.rows) throw new Error(`SdfCoarse: ${rows} rows, made for ${this.rows}: make a bigger one`);
    const p = new ArrayBuffer(32);
    new Uint32Array(p).set([rows, this.heads, this.levels, this.pairRoom]);
    new Float32Array(p).set([this.cellTop, this.margin], 4);
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  /** The pass encoded: the awake heads and the pair count cleared, then gate, the sleeper hash if the epoch changed, the awake hash, the pairs. Call setParams first. */
  encode(enc: GPUCommandEncoder, inputs: CoarseInputs, timestampWrites?: GPUComputePassTimestampWrites): void {
    const b = this.bind(inputs);
    enc.clearBuffer(this.table, 0, this.heads * 4);
    enc.clearBuffer(this.pairBuf, 0, 16);
    const pass = enc.beginComputePass({ label: 'sdf coarse', timestampWrites });
    const run = (name: keyof SdfCoarse['k']) => {
      pass.setPipeline(this.k[name].pipeline);
      pass.setBindGroup(0, b.groups[name]);
    };
    run('gate');
    pass.dispatchWorkgroups(1);
    run('clearSleep');
    pass.dispatchWorkgroupsIndirect(this.state, 16);
    run('insertSleep');
    pass.dispatchWorkgroupsIndirect(this.state, 32);
    run('insertAwake');
    pass.dispatchWorkgroupsIndirect(inputs.list, 0);
    run('pairs');
    pass.dispatchWorkgroupsIndirect(this.state, 48);
    pass.end();
  }

  private bind(inputs: CoarseInputs): NonNullable<SdfCoarse['bound']> {
    const b = this.bound;
    if (b && b.version === this.models.version && (Object.keys(inputs) as (keyof CoarseInputs)[]).every((k) => b.inputs[k] === inputs[k])) return b;
    const dev = this.device;
    const g = (name: keyof SdfCoarse['k'], res: Record<number, GPUBuffer>) => makeBindGroup(dev, `sdf coarse ${name}`, this.k[name].layout, { 0: this.params, ...res });
    return (this.bound = {
      inputs: { ...inputs },
      version: this.models.version,
      groups: {
        gate: g('gate', { 1: inputs.list, 9: this.state, 10: inputs.sleepEpoch }),
        clearSleep: g('clearSleep', { 7: this.table }),
        insertSleep: g('insertSleep', { 2: inputs.pose, 3: inputs.vel, 4: inputs.info, 7: this.table }),
        insertAwake: g('insertAwake', { 1: inputs.list, 2: inputs.pose, 3: inputs.vel, 7: this.table, 8: this.pairBuf }),
        pairs: g('pairs', { 1: inputs.list, 2: inputs.pose, 3: inputs.vel, 5: inputs.model, 6: this.models.models, 8: this.pairBuf, 11: this.table }),
      },
    });
  }

  destroy(): void {
    for (const b of [this.params, this.table, this.pairBuf, this.state]) b.destroy();
  }
}
