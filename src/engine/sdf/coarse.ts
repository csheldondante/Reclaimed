// Coarse collision between bodies (docs/design/PHYSICS_ENGINE.md stage 2): the engine's rows in, candidate pairs out
// in the layout the fine pass reads, on the GPU with nothing read back. Kernels: sdf-coarse.wgsl (the scheme is in its
// header). The owner: "Just make bounding boxes … I do like spatial hashes but not for fully voxelated things": the
// hash is over body bounds, never voxels.
//
// Where the state lives: the rows, the awake list and the sleep epoch are the engine's and are only read. This owns
// `tables` (the awake table, then the sleepers': a counting sort by cell each), `items` (stage A's work items, rebuilt
// every tick), `pairBuf` (a 256 B header, then the pairs), `missing` (a word a row: contract.ts MISS_*) and `ctl` (the
// epoch the sleeper table was built for, and every dispatch's indirect arguments).
// Transfers: two 48 B uniforms a pass.
// Work: every dispatch but two one-thread ones is sized on the GPU by what exists: the awake table's by the awake
// rows (nothing awake: no workgroups), the sleeper table's only in a tick whose sleep epoch changed, stage A by the
// awake rows, stage B by the work items. Each tick the awake table's counters (8 B a bucket) and the rows' `missing`
// words (4 B a row in use) are cleared by a GPU clear.
//
// Rooms (docs/design/PHYSICS_ENGINE.md "Round 6"): `rows` (the engine's row room), `itemRoom` and `pairRoom`. Oversize
// bodies and the tables' runs have exactly the room they need. Items and pairs past their room are counted whole in
// the pair buffer's header (and the most since the last read kept beside them), and the tick fails safe: the rows that
// may lack a pair are flagged in `missing`. `grow` makes any room bigger without making a pipeline: the kernels'
// layouts do not depend on the sizes, so only the buffers and the bind groups are made again. collide.ts reads the
// header now and then and calls it.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../../gpu/pipeline';
import modelWgsl from '../../shaders/engine/sdf-model.wgsl?raw';
import coarseWgsl from '../../shaders/engine/sdf-coarse.wgsl?raw';
import { sdfFormatWgsl, type SdfModels } from './models';

export interface CoarseOptions {
  /** body rows the buffers are made for */
  rows: number;
  /** the top level's cell, cells: about the biggest common body's bound diameter. A bigger body is an oversize one: in a run of its own, tested against every awake row (exact, as many as there are) */
  cellTop: number;
  /** levels, each half the one above (default 3: cellTop / 4 the finest) */
  levels?: number;
  /** the fine pass's margin, cells */
  margin?: number;
  /** pairs the buffer has room for, a row (default 8; 1,024 pairs at least) */
  pairsARow?: number;
  /** the pairs' room given outright (it grows: collide.ts) */
  pairRoom?: number;
  /** the work items' room given outright (default 64 a row, 16,384 at least; it grows) */
  itemRoom?: number;
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
/** stage A's work items asked for this tick */
export const PAIR_ITEMS_ASKED = 1;
/** stage A's work items past their room: their rows are flagged in `missing` */
export const PAIR_ITEMS_DROPPED = 2;
/** the most pairs asked for in a tick up to the last one, and the most items up to this one, since the CPU last cleared them (collide.ts) */
export const PAIR_HW_PAIRS = 8;
export const PAIR_HW_ITEMS = 9;
/** `ctl` words: workgroups of the sleeper table's build this tick (0 unless the epoch changed), of stage A, of stage B */
export const CTL_SLEEPER_GROUPS = 8;
export const CTL_STAGE_A = 36;
export const CTL_STAGE_B = 40;

type Kernel = 'gate' | 'clearTab' | 'countCells' | 'blockSum' | 'superSum' | 'startCells' | 'fillCells' | 'stageA' | 'argsB' | 'stageB';
const BUILD = ['clearTab', 'countCells', 'blockSum', 'superSum', 'startCells', 'fillCells'] as const;

export class SdfCoarse {
  /** [PAIR_ASKED] pairs asked for, [PAIR_ITEMS_ASKED], [PAIR_ITEMS_DROPPED], [PAIR_HW_*], then (a, b) a pair from word PAIR_HEADER_WORDS. Replaced by `grow` */
  pairBuf!: GPUBuffer;
  readonly ctl: GPUBuffer;
  /** the tables proper (sdf-coarse.wgsl's header): the awake one, then the sleepers'; their counters are private. Replaced by `grow` */
  tables!: GPUBuffer;
  /** a word a row, contract.ts MISS_* bits: the row may lack a pair or a contact this tick (a room ran out before it grew). Cleared by `encode`, written by stage A, stage B and the fine pass; the solver holds a flagged row still. Replaced by `grow` */
  missing!: GPUBuffer;
  /** the rooms: rows the buffers are made for, pairs, work items (`grow` changes them) */
  rows = 0;
  pairRoom = 0;
  itemRoom = 0;
  heads = 0;
  readonly levels: number;
  readonly cellTop: number;
  margin: number;
  /** for the bench's isolation only: encode up to the sleeper table (0), the awake table (1), stage A (2), everything (3) */
  upTo = 3;

  private params: [GPUBuffer, GPUBuffer];
  private counters!: [GPUBuffer, GPUBuffer];
  private items!: GPUBuffer;
  private itemCtl: GPUBuffer;
  /** the sleepers' table's first word in `tables` */
  private slBase = 0;
  private used = 0;
  /** buffers replaced by `grow`, destroyed by `release` once the last encoder that used them is submitted */
  private retired: GPUBuffer[] = [];
  private k: Record<Kernel, ComputeKernel>;
  private bound: { inputs: CoarseInputs; version: number; one: Record<'gate' | 'stageA' | 'argsB' | 'stageB', GPUBindGroup>; build: [Record<(typeof BUILD)[number], GPUBindGroup>, Record<(typeof BUILD)[number], GPUBindGroup>] } | null = null;

  constructor(
    private device: GPUDevice,
    private models: SdfModels,
    opts: CoarseOptions,
  ) {
    this.levels = opts.levels ?? 3;
    if (this.levels < 1 || this.levels > 8) throw new Error(`SdfCoarse: ${this.levels} levels (1 to 8)`);
    this.cellTop = opts.cellTop;
    this.margin = opts.margin ?? 0.25;
    const parts = [sdfFormatWgsl(models.format), modelWgsl, coarseWgsl];
    const mk = (name: Kernel, spec: Record<number, 'uniform' | 'read' | 'rw'>) => makeCompute(device, `sdf coarse ${name}`, parts, { 0: 'uniform', ...spec }, name);
    const src = { 1: 'read', 2: 'read', 3: 'read', 4: 'read', 7: 'rw', 16: 'rw' } as const;
    this.k = {
      gate: mk('gate', { 1: 'read', 8: 'rw', 9: 'rw', 10: 'read', 14: 'rw' }),
      clearTab: mk('clearTab', { 7: 'rw' }),
      countCells: mk('countCells', src),
      blockSum: mk('blockSum', { 15: 'read', 16: 'rw' }),
      superSum: mk('superSum', { 16: 'rw' }),
      startCells: mk('startCells', { 15: 'read', 16: 'rw' }),
      fillCells: mk('fillCells', src),
      stageA: mk('stageA', { 1: 'read', 2: 'read', 3: 'read', 11: 'read', 13: 'rw', 14: 'rw', 17: 'rw' }),
      argsB: mk('argsB', { 8: 'rw', 9: 'rw', 13: 'rw', 14: 'rw' }),
      stageB: mk('stageB', { 2: 'read', 3: 'read', 5: 'read', 6: 'read', 8: 'rw', 11: 'read', 13: 'rw', 17: 'rw' }),
    };
    const S = GPUBufferUsage.STORAGE;
    this.params = [0, 1].map((mode) => device.createBuffer({ label: `sdf coarse params ${mode}`, size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })) as [GPUBuffer, GPUBuffer];
    this.itemCtl = device.createBuffer({ label: 'sdf coarse item counts', size: 16, usage: S | GPUBufferUsage.COPY_DST });
    this.ctl = device.createBuffer({ label: 'sdf coarse ctl', size: 256, usage: S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.grow({ rows: opts.rows, pairRoom: opts.pairRoom ?? Math.max(1024, Math.ceil(opts.rows * (opts.pairsARow ?? 8))), itemRoom: opts.itemRoom ?? Math.max(16384, opts.rows * 64) });
  }

  /**
   * A room made bigger (never smaller): only the buffers that depend on it are made again, and the bind groups at the
   * next `encode`; no pipeline. Nothing is copied: every one of these buffers is rebuilt by the pass each tick, but
   * for the sleepers' table, which a change of `rows` has built again at the next tick. The old buffers are kept until
   * `release` (an encoder not yet submitted may still use them).
   */
  grow(to: { rows?: number; pairRoom?: number; itemRoom?: number }): void {
    const dev = this.device;
    const S = GPUBufferUsage.STORAGE;
    if (to.rows !== undefined && to.rows > this.rows) {
      // (24 bits of row in a work item, 28 in a sleeper's entry)
      if (to.rows > 1 << 24) throw new Error(`SdfCoarse: ${to.rows} rows (at most ${1 << 24})`);
      this.rows = to.rows;
      // (two buckets a row at least: short runs; 4,096 at least: the sums' blocks of 1,024)
      let heads = 1 << 12;
      while (heads < this.rows * 2) heads *= 2;
      this.heads = heads;
      const words = (runs: number) => 2 * heads + 4 + heads / 32 + heads / 1024 + runs;
      // (the sleepers' table starts on a 256 B boundary: its build binds it as a range)
      this.slBase = Math.ceil(words(this.rows) / 64) * 64;
      if (this.tables) this.retired.push(this.tables, this.missing, ...this.counters);
      this.tables = dev.createBuffer({ label: 'sdf coarse tables', size: (this.slBase + Math.ceil(words(this.rows * this.levels) / 64) * 64) * 4, usage: S | GPUBufferUsage.COPY_SRC });
      this.counters = [0, 1].map((mode) => dev.createBuffer({ label: `sdf coarse counters ${mode}`, size: (2 * heads + 4) * 4, usage: S | GPUBufferUsage.COPY_DST })) as [GPUBuffer, GPUBuffer];
      this.missing = dev.createBuffer({ label: 'sdf rows missing pairs', size: Math.max(this.rows, 4) * 4, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      // (the epoch built for becomes one no engine uses, so the next tick builds the sleeper table)
      dev.queue.writeBuffer(this.ctl, 0, new Uint32Array([0xffffffff]));
    }
    if (to.pairRoom !== undefined && to.pairRoom > this.pairRoom) {
      this.pairRoom = to.pairRoom;
      if (this.pairBuf) this.retired.push(this.pairBuf);
      this.pairBuf = dev.createBuffer({ label: 'sdf pairs', size: (PAIR_HEADER_WORDS + this.pairRoom * 2) * 4, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    }
    if (to.itemRoom !== undefined && to.itemRoom > this.itemRoom) {
      this.itemRoom = to.itemRoom;
      if (this.items) this.retired.push(this.items);
      this.items = dev.createBuffer({ label: 'sdf coarse items', size: (4 + this.itemRoom * 4) * 4, usage: S });
    }
    this.bound = null;
  }

  /** the buffers `grow` replaced, destroyed: call when every encoder made before the growth has been submitted */
  release(): void {
    for (const b of this.retired.splice(0)) b.destroy();
  }

  /** bytes this pass holds on the GPU */
  get bytes(): number {
    return this.tables.size + this.pairBuf.size + this.items.size + this.missing.size + this.ctl.size + 112;
  }

  /** the pair list and the rows' `missing` words as the fine pass's inputs */
  get finePairs(): { pairs: GPUBufferBinding; pairCount: GPUBufferBinding; missing: GPUBuffer } {
    return { pairs: { buffer: this.pairBuf, offset: PAIR_HEADER_WORDS * 4 }, pairCount: { buffer: this.pairBuf, offset: 0, size: 16 }, missing: this.missing };
  }

  /** The pass's parameters for the passes encoded from now until the next submit: `rows` the engine's rows in use. */
  setParams(rows: number): void {
    if (rows > this.rows) throw new Error(`SdfCoarse: ${rows} rows, made for ${this.rows}: grow({ rows }) first`);
    this.used = rows;
    for (const mode of [0, 1]) {
      const p = new ArrayBuffer(48);
      new Uint32Array(p).set([rows, this.heads, this.levels, this.pairRoom, 0, 0, mode, this.itemRoom, mode ? this.rows * this.levels : this.rows, this.slBase]);
      new Float32Array(p).set([this.cellTop, this.margin], 4);
      this.device.queue.writeBuffer(this.params[mode], 0, p);
    }
  }

  /** The pass encoded: gate, the sleeper table if the epoch changed, the awake table, stage A, stage B. Call setParams first. */
  encode(enc: GPUCommandEncoder, inputs: CoarseInputs, timestampWrites?: GPUComputePassTimestampWrites): void {
    const b = this.bind(inputs);
    // (the awake table's counts, cursors and oversize count; the rows' missing words. The gate zeroes the pair and item counts)
    enc.clearBuffer(this.counters[0]);
    if (this.used) enc.clearBuffer(this.missing, 0, this.used * 4);
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
    const g = (name: Kernel, mode: number, res: Record<number, GPUBuffer | GPUBufferBinding>) => makeBindGroup(dev, `sdf coarse ${name}`, this.k[name].layout, { 0: this.params[mode], ...res });
    const build = (mode: number) => {
      // (a table's own part of the tables' buffer)
      const tab: GPUBufferBinding = mode ? { buffer: this.tables, offset: this.slBase * 4 } : { buffer: this.tables, offset: 0, size: this.slBase * 4 };
      const cnt = this.counters[mode];
      const src = { 1: inputs.list, 2: inputs.pose, 3: inputs.vel, 4: inputs.info, 7: cnt, 16: tab };
      return { clearTab: g('clearTab', mode, { 7: cnt }), countCells: g('countCells', mode, src), blockSum: g('blockSum', mode, { 15: cnt, 16: tab }), superSum: g('superSum', mode, { 16: tab }), startCells: g('startCells', mode, { 15: cnt, 16: tab }), fillCells: g('fillCells', mode, src) };
    };
    const tabs = { 11: this.tables };
    return (this.bound = {
      inputs: { ...inputs },
      version: this.models.version,
      build: [build(0), build(1)],
      one: {
        gate: g('gate', 0, { 1: inputs.list, 8: this.pairBuf, 9: this.ctl, 10: inputs.sleepEpoch, 14: this.itemCtl }),
        stageA: g('stageA', 0, { 1: inputs.list, 2: inputs.pose, 3: inputs.vel, ...tabs, 13: this.items, 14: this.itemCtl, 17: this.missing }),
        argsB: g('argsB', 0, { 8: this.pairBuf, 9: this.ctl, 13: this.items, 14: this.itemCtl }),
        stageB: g('stageB', 0, { 2: inputs.pose, 3: inputs.vel, 5: inputs.model, 6: this.models.models, 8: this.pairBuf, ...tabs, 13: this.items, 17: this.missing }),
      },
    });
  }

  destroy(): void {
    this.release();
    for (const b of [...this.params, ...this.counters, this.tables, this.missing, this.pairBuf, this.items, this.itemCtl, this.ctl]) b.destroy();
  }
}
