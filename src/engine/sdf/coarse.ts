// Coarse collision between bodies (docs/design/PHYSICS_ENGINE.md stage 2): the engine's rows in, candidate pairs out
// in the layout the fine pass reads, on the GPU with nothing read back. Kernels: sdf-coarse.wgsl (the scheme is in its
// header). The owner: "Just make bounding boxes … I do like spatial hashes but not for fully voxelated things": the
// hash is over body bounds, never voxels.
//
// Where the state lives: the rows, the awake list and the sleep epoch are the engine's and are only read. This owns
// the two tables (`awake`, `sleepers`: a counting sort by cell each), `items` (stage A's work items, rebuilt every
// tick), `pairBuf` (a 256 B header, then the pairs) and `ctl` (the epoch the sleeper table was built for, and every
// dispatch's indirect arguments).
// Transfers: two 48 B uniforms a pass.
// Work: every dispatch but two one-thread ones is sized on the GPU by what exists: the awake table's by the awake
// rows (nothing awake: no workgroups), the sleeper table's only in a tick whose sleep epoch changed, stage A by the
// awake rows, stage B by the work items. Each tick the awake table's counters (8 B a bucket) are cleared by a GPU clear.
//
// Room: `rows` is the capacity the buffers are made for; the pair buffer has `pairsARow` pairs a row and the items (64 a row)
// (grown with the rows: make a bigger SdfCoarse, as the engine makes its row buffers again). Pairs and items
// past the room are counted in the pair buffer's header and the fine pass reports the pairs (COUNT_PAIRS_DROPPED).

import { makeBindGroup, makeCompute, type ComputeKernel } from '../../gpu/pipeline';
import modelWgsl from '../../shaders/engine/sdf-model.wgsl?raw';
import coarseWgsl from '../../shaders/engine/sdf-coarse.wgsl?raw';
import { sdfFormatWgsl, type SdfModels } from './models';

export interface CoarseOptions {
  /** body rows the buffers are made for */
  rows: number;
  /** the top level's cell, cells: about the biggest common body's bound diameter. A bigger body goes in the oversize list (exact, tested against every awake row; at most 256 awake and 256 asleep) */
  cellTop: number;
  /** levels, each half the one above (default 3: cellTop / 4 the finest) */
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
/** oversize bodies past their lists' room (256 awake, 256 asleep): these may miss pairs */
export const PAIR_OVERSIZE_DROPPED = 1;
/** stage A's work items past their room: candidates not tested */
export const PAIR_ITEMS_DROPPED = 2;
/** `ctl` words: workgroups of the sleeper table's build this tick (0 unless the epoch changed), of stage A, of stage B */
export const CTL_SLEEPER_GROUPS = 8;
export const CTL_STAGE_A = 36;
export const CTL_STAGE_B = 40;

const OVER = 256;
type Kernel = 'gate' | 'clearTab' | 'countCells' | 'blockSum' | 'superSum' | 'startCells' | 'fillCells' | 'stageA' | 'argsB' | 'stageB';
const BUILD = ['clearTab', 'countCells', 'blockSum', 'superSum', 'startCells', 'fillCells'] as const;

export class SdfCoarse {
  /** [PAIR_ASKED] pairs asked for, [PAIR_OVERSIZE_DROPPED], [PAIR_ITEMS_DROPPED], then (a, b) a pair from word PAIR_HEADER_WORDS */
  readonly pairBuf: GPUBuffer;
  readonly ctl: GPUBuffer;
  /** the tables proper (sdf-coarse.wgsl's header); their counters are private */
  readonly awake: GPUBuffer;
  readonly sleepers: GPUBuffer;
  readonly rows: number;
  readonly pairRoom: number;
  readonly itemRoom: number;
  readonly levels: number;
  readonly heads: number;
  readonly cellTop: number;
  margin: number;
  /** for the bench's isolation only: encode up to the sleeper table (0), the awake table (1), stage A (2), everything (3) */
  upTo = 3;

  private params: [GPUBuffer, GPUBuffer];
  private counters: [GPUBuffer, GPUBuffer];
  private items: GPUBuffer;
  private itemCtl: GPUBuffer;
  private k: Record<Kernel, ComputeKernel>;
  private bound: { inputs: CoarseInputs; version: number; one: Record<'gate' | 'stageA' | 'argsB' | 'stageB', GPUBindGroup>; build: [Record<(typeof BUILD)[number], GPUBindGroup>, Record<(typeof BUILD)[number], GPUBindGroup>] } | null = null;

  constructor(
    private device: GPUDevice,
    private models: SdfModels,
    opts: CoarseOptions,
  ) {
    this.rows = opts.rows;
    this.levels = opts.levels ?? 3;
    if (this.levels < 1 || this.levels > 8) throw new Error(`SdfCoarse: ${this.levels} levels (1 to 8)`);
    if (this.rows > 1 << 24) throw new Error(`SdfCoarse: ${this.rows} rows (at most ${1 << 24})`);
    this.cellTop = opts.cellTop;
    this.margin = opts.margin ?? 0.25;
    this.pairRoom = Math.max(1024, Math.ceil(this.rows * (opts.pairsARow ?? 8)));
    this.itemRoom = Math.max(16384, this.rows * 64);
    // (two buckets a row at least: short runs; 4,096 at least: the sums' blocks of 1,024)
    let heads = 1 << 12;
    while (heads < this.rows * 2) heads *= 2;
    this.heads = heads;
    const parts = [sdfFormatWgsl(models.format), modelWgsl, coarseWgsl];
    const mk = (name: Kernel, spec: Record<number, 'uniform' | 'read' | 'rw'>) => makeCompute(device, `sdf coarse ${name}`, parts, { 0: 'uniform', ...spec }, name);
    const src = { 1: 'read', 2: 'read', 3: 'read', 4: 'read', 7: 'rw', 16: 'rw' } as const;
    this.k = {
      gate: mk('gate', { 1: 'read', 9: 'rw', 10: 'read' }),
      clearTab: mk('clearTab', { 7: 'rw' }),
      countCells: mk('countCells', src),
      blockSum: mk('blockSum', { 15: 'read', 16: 'rw' }),
      superSum: mk('superSum', { 16: 'rw' }),
      startCells: mk('startCells', { 15: 'read', 16: 'rw' }),
      fillCells: mk('fillCells', src),
      stageA: mk('stageA', { 1: 'read', 2: 'read', 3: 'read', 11: 'read', 12: 'read', 13: 'rw', 14: 'rw' }),
      argsB: mk('argsB', { 8: 'rw', 9: 'rw', 11: 'read', 12: 'read', 13: 'rw', 14: 'rw' }),
      stageB: mk('stageB', { 2: 'read', 3: 'read', 5: 'read', 6: 'read', 8: 'rw', 11: 'read', 12: 'read', 13: 'rw' }),
    };
    const S = GPUBufferUsage.STORAGE;
    const table = (label: string, runs: number) => device.createBuffer({ label, size: (2 * heads + 4 + heads / 32 + heads / 1024 + OVER + runs) * 4, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.awake = table('sdf coarse awake table', this.rows);
    this.sleepers = table('sdf coarse sleeper table', this.rows * this.levels);
    this.counters = [0, 1].map((mode) => device.createBuffer({ label: `sdf coarse counters ${mode}`, size: (2 * heads + 4) * 4, usage: S | GPUBufferUsage.COPY_DST })) as [GPUBuffer, GPUBuffer];
    this.params = [0, 1].map((mode) => device.createBuffer({ label: `sdf coarse params ${mode}`, size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })) as [GPUBuffer, GPUBuffer];
    this.pairBuf = device.createBuffer({ label: 'sdf pairs', size: (PAIR_HEADER_WORDS + this.pairRoom * 2) * 4, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.items = device.createBuffer({ label: 'sdf coarse items', size: (4 + this.itemRoom * 4) * 4, usage: S });
    this.itemCtl = device.createBuffer({ label: 'sdf coarse item counts', size: 16, usage: S | GPUBufferUsage.COPY_DST });
    // (the epoch built for starts as one no engine uses, so the first tick builds the sleeper table)
    this.ctl = device.createBuffer({ label: 'sdf coarse ctl', size: 256, usage: S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    new Uint32Array(this.ctl.getMappedRange())[0] = 0xffffffff;
    this.ctl.unmap();
  }

  /** bytes this pass holds on the GPU */
  get bytes(): number {
    return this.awake.size + this.sleepers.size + this.pairBuf.size + this.items.size + this.ctl.size + 112;
  }

  /** the pair list as the fine pass's inputs */
  get finePairs(): { pairs: GPUBufferBinding; pairCount: GPUBufferBinding } {
    return { pairs: { buffer: this.pairBuf, offset: PAIR_HEADER_WORDS * 4 }, pairCount: { buffer: this.pairBuf, offset: 0, size: 16 } };
  }

  /** The pass's parameters for the passes encoded from now until the next submit: `rows` the engine's rows in use. */
  setParams(rows: number): void {
    if (rows > this.rows) throw new Error(`SdfCoarse: ${rows} rows, made for ${this.rows}: make a bigger one`);
    for (const mode of [0, 1]) {
      const p = new ArrayBuffer(48);
      new Uint32Array(p).set([rows, this.heads, this.levels, this.pairRoom, 0, 0, mode, this.itemRoom, mode ? this.rows * this.levels : this.rows]);
      new Float32Array(p).set([this.cellTop, this.margin], 4);
      this.device.queue.writeBuffer(this.params[mode], 0, p);
    }
  }

  /** The pass encoded: gate, the sleeper table if the epoch changed, the awake table, stage A, stage B. Call setParams first. */
  encode(enc: GPUCommandEncoder, inputs: CoarseInputs, timestampWrites?: GPUComputePassTimestampWrites): void {
    const b = this.bind(inputs);
    // (the awake table's counts, cursors and oversize count; the pair and item counts)
    enc.clearBuffer(this.counters[0]);
    enc.clearBuffer(this.pairBuf, 0, 16);
    enc.clearBuffer(this.itemCtl);
    const pass = enc.beginComputePass({ label: 'sdf coarse', timestampWrites });
    const at = (name: Kernel, group: GPUBindGroup, buf: GPUBuffer | null, word = 0) => {
      pass.setPipeline(this.k[name].pipeline);
      pass.setBindGroup(0, group);
      if (buf) pass.dispatchWorkgroupsIndirect(buf, word * 4);
      else pass.dispatchWorkgroups(1);
    };
    at('gate', b.one.gate, null);
    const sl = b.build[1];
    at('clearTab', sl.clearTab, this.ctl, 4);
    at('countCells', sl.countCells, this.ctl, CTL_SLEEPER_GROUPS);
    at('blockSum', sl.blockSum, this.ctl, 12);
    at('superSum', sl.superSum, this.ctl, 16);
    at('startCells', sl.startCells, this.ctl, 20);
    at('fillCells', sl.fillCells, this.ctl, CTL_SLEEPER_GROUPS);
    const aw = b.build[0];
    if (this.upTo >= 1) {
    at('countCells', aw.countCells, inputs.list, 0);
    at('blockSum', aw.blockSum, this.ctl, 24);
    at('superSum', aw.superSum, this.ctl, 28);
    at('startCells', aw.startCells, this.ctl, 32);
    at('fillCells', aw.fillCells, inputs.list, 0);
    }
    if (this.upTo >= 2) {
      at('stageA', b.one.stageA, this.ctl, CTL_STAGE_A);
      at('argsB', b.one.argsB, null);
    }
    if (this.upTo >= 3) at('stageB', b.one.stageB, this.ctl, CTL_STAGE_B);
    pass.end();
  }

  private bind(inputs: CoarseInputs): NonNullable<SdfCoarse['bound']> {
    const b = this.bound;
    if (b && b.version === this.models.version && (Object.keys(inputs) as (keyof CoarseInputs)[]).every((k) => b.inputs[k] === inputs[k])) return b;
    const dev = this.device;
    const g = (name: Kernel, mode: number, res: Record<number, GPUBuffer>) => makeBindGroup(dev, `sdf coarse ${name}`, this.k[name].layout, { 0: this.params[mode], ...res });
    const build = (mode: number) => {
      const tab = mode ? this.sleepers : this.awake;
      const cnt = this.counters[mode];
      const src = { 1: inputs.list, 2: inputs.pose, 3: inputs.vel, 4: inputs.info, 7: cnt, 16: tab };
      return { clearTab: g('clearTab', mode, { 7: cnt }), countCells: g('countCells', mode, src), blockSum: g('blockSum', mode, { 15: cnt, 16: tab }), superSum: g('superSum', mode, { 16: tab }), startCells: g('startCells', mode, { 15: cnt, 16: tab }), fillCells: g('fillCells', mode, src) };
    };
    const tabs = { 11: this.awake, 12: this.sleepers };
    return (this.bound = {
      inputs: { ...inputs },
      version: this.models.version,
      build: [build(0), build(1)],
      one: {
        gate: g('gate', 0, { 1: inputs.list, 9: this.ctl, 10: inputs.sleepEpoch }),
        stageA: g('stageA', 0, { 1: inputs.list, 2: inputs.pose, 3: inputs.vel, ...tabs, 13: this.items, 14: this.itemCtl }),
        argsB: g('argsB', 0, { 8: this.pairBuf, 9: this.ctl, ...tabs, 13: this.items, 14: this.itemCtl }),
        stageB: g('stageB', 0, { 2: inputs.pose, 3: inputs.vel, 5: inputs.model, 6: this.models.models, 8: this.pairBuf, ...tabs, 13: this.items }),
      },
    });
  }

  destroy(): void {
    for (const b of [...this.params, ...this.counters, this.awake, this.sleepers, this.pairBuf, this.items, this.itemCtl, this.ctl]) b.destroy();
  }
}
