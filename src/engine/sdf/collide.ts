// Body ↔ body collision as the engine uses it (docs/design/PHYSICS_ENGINE.md "Hand-over"): the coarse pass and the
// fine pass with one set of rooms, and the rooms' growth.
//
// A tick: `encode` (in the engine's encoder), the engine's submit, then `poll`.
//
// Rooms that grow. Every room that can run out counts what was asked of it whole on the GPU, and keeps the most asked
// in a tick since the last read. `poll` reads those words now and then: 128 B, asynchronously, every `readEvery`
// ticks and never while a read is under way; no tick waits for it. When what was asked reaches half a room
// (rooms.ts), the next `encode` makes that room's buffers again, bigger: no pipeline is made, only buffers and bind
// groups. Until then the tick that ran out fails safe on the GPU: the rows that may lack a pair or a contact carry a
// bit in `missing` (contract.ts MISS_*), which the solver reads to hold them still.
// Transfers: the two passes' uniforms; the 128 B read above.

import { COUNT_BRICKS, COUNT_CULL, COUNT_HW_BRICKS, COUNT_HW_CULL, COUNT_HW_SLOTS, COUNT_REHASH_FAILS, COUNT_SLOT_FAILS_SINCE, COUNTS_BYTES } from './contract';
import { PAIR_ASKED, PAIR_HW_ITEMS, PAIR_HW_PAIRS, PAIR_ITEMS_ASKED, SdfCoarse, type CoarseInputs, type CoarseOptions } from './coarse';
import { SdfFine } from './fine';
import type { SdfModels } from './models';
import { planRooms, type Rooms } from './rooms';

export interface CollideOptions extends CoarseOptions {
  /** samples a half pair tests in one pass at most (fine.ts) */
  cap?: number;
  /** the sample groups' room given outright (default fine.ts's; it grows) */
  groupRoom?: number;
  /** the cull items' room given outright (default fine.ts's; it grows) */
  cullRoom?: number;
  /** the pair slots' table given outright, a power of two (default fine.ts's; it grows) */
  slotRoom?: number;
  /** ticks between reads of what was asked of the rooms (default 8; 0: `poll` never reads — the engine reads the words itself with its own event-chained read: `copyAsked`, `consider`) */
  readEvery?: number;
  /** one room made bigger a tick at most (the rows' apart), the others the tick after: the tick that made the two biggest buffers at once stalled (docs/design/PHYSICS_ENGINE.md "Round 6"). Default false */
  spread?: boolean;
}

/** a room made bigger */
export interface Growth {
  /** `poll`s so far when it was applied */
  tick: number;
  room: string;
  from: number;
  to: number;
  /** CPU ms making the buffers (all the rooms grown in that tick together) */
  ms: number;
}

const HEAD_BYTES = 64;

export class SdfCollide {
  readonly coarse: SdfCoarse;
  readonly fine: SdfFine;
  readEvery: number;
  spread: boolean;
  /** every growth so far */
  readonly growths: Growth[] = [];
  /** reads landed, and the last one's time from `poll` to its data, ms */
  reads = 0;
  lastReadMs = 0;
  /** pairs a growth of the slots could not place (they started again in a new slot, age 0), as the reads have seen */
  rehashFails = 0;

  private rd: GPUBuffer;
  private reading: Promise<void> | null = null;
  private want: Rooms | null = null;
  private polls = 0;
  private next: number;
  private dead = false;

  constructor(
    private device: GPUDevice,
    models: SdfModels,
    opts: CollideOptions,
  ) {
    this.coarse = new SdfCoarse(device, models, opts);
    this.fine = new SdfFine(device, models, { maxPairs: this.coarse.pairRoom, cap: opts.cap, margin: opts.margin, maxBricks: opts.groupRoom, maxCull: opts.cullRoom, slots: opts.slotRoom });
    this.readEvery = opts.readEvery ?? 8;
    this.spread = opts.spread ?? false;
    this.next = this.readEvery;
    this.rd = device.createBuffer({ label: 'sdf rooms read', size: HEAD_BYTES + COUNTS_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  /** a u32 a body row, contract.ts MISS_*: nonzero when the row may lack a pair or a contact this tick. Read it on the GPU after `encode`'s passes */
  get missing(): GPUBuffer {
    return this.coarse.missing;
  }

  /** the rooms as they are */
  get rooms(): Rooms {
    return { rows: this.coarse.rows, pairs: this.coarse.pairRoom, items: this.coarse.itemRoom, cull: this.fine.maxCull, groups: this.fine.maxBricks, slots: this.fine.slots };
  }

  /** bytes both passes hold on the GPU */
  get bytes(): number {
    return this.coarse.bytes + this.fine.bytes;
  }

  /**
   * The tick's passes encoded: the coarse pass, then the fine pass on its pairs. `rows` the engine's rows in use
   * (past the room made for: the room doubles here, at once), `tick` turns the fine pass's sample offset. A growth
   * that a read asked for is applied first.
   */
  encode(enc: GPUCommandEncoder, inputs: CoarseInputs, rows: number, tick: number, timestamps?: { coarse?: GPUComputePassTimestampWrites; fine?: GPUComputePassTimestampWrites }): void {
    this.prepare(enc, rows, tick);
    this.coarse.encode(enc, inputs, timestamps?.coarse);
    this.fine.encode(enc, { ...this.coarse.finePairs, pose: inputs.pose, vel: inputs.vel, info: inputs.info, model: inputs.model }, this.coarse.pairRoom, timestamps?.fine);
  }

  /**
   * The engine's form of `encode`, in two halves so its whole tick is one compute pass: `prepare` before the pass
   * begins (a growth a read asked for, the uniforms, the coarse pass's two GPU clears), then `encodeInto` inside it.
   */
  prepare(enc: GPUCommandEncoder, rows: number, tick: number, clears = true): { clears: number; uploads: number; uploadBytes: number } {
    const want: Rooms = { ...this.want };
    this.want = null;
    if (this.spread) {
      // (the first room asked for now, the others kept for the next tick)
      const later = Object.keys(want).slice(1);
      if (later.length) this.want = Object.fromEntries(later.map((k) => [k, want[k]]));
      for (const k of later) delete want[k];
    }
    if (rows > this.coarse.rows) want.rows = Math.max(rows, this.coarse.rows * 2);
    if (Object.keys(want).length) this.grow(want);
    this.coarse.setParams(rows);
    this.fine.setParams(Math.min(this.coarse.pairRoom, this.coarse.pairBudget), tick);
    // (`clears` false: a bench leaving the coarse pass out of a held scene — its tables stay as they were)
    if (clears) this.coarse.clears(enc);
    return { clears: clears ? (rows ? 2 : 1) : 0, uploads: 3, uploadBytes: 144 };
  }

  /** `on`: (benches) a pass left out of a held scene; what it wrote the tick before stays. Returns the dispatches encoded */
  encodeInto(pass: GPUComputePassEncoder, inputs: CoarseInputs, on: { coarse: boolean; fine: boolean; direct?: boolean } = { coarse: true, fine: true }): { direct: number; indirect: number } {
    const n = { direct: 0, indirect: 0 };
    // (the pass's own calls counted as they are made)
    const counted = {
      setPipeline: (p: GPUComputePipeline) => pass.setPipeline(p),
      setBindGroup: (i: number, g: GPUBindGroup) => pass.setBindGroup(i, g),
      dispatchWorkgroups: (x: number, y?: number) => {
        n.direct++;
        pass.dispatchWorkgroups(x, y);
      },
      dispatchWorkgroupsIndirect: (b: GPUBuffer, o: number) => {
        n.indirect++;
        pass.dispatchWorkgroupsIndirect(b, o);
      },
    } as unknown as GPUComputePassEncoder;
    if (on.coarse) this.coarse.encodeInto(counted, inputs, on.direct ?? false);
    if (on.fine) this.fine.encodeInto(counted, { ...this.coarse.finePairs, pose: inputs.pose, vel: inputs.vel, info: inputs.info, model: inputs.model });
    return n;
  }

  /** a growth is waiting for the next `prepare` */
  get growing(): boolean {
    return this.want !== null;
  }

  /** bytes `copyAsked` copies */
  static readonly ASKED_BYTES = HEAD_BYTES + COUNTS_BYTES;

  /** what was asked of the rooms copied into `dst` (ASKED_BYTES from `offset`), and the high-water words started again: for a read of the caller's own (the engine's event-chained one) */
  copyAsked(enc: GPUCommandEncoder, dst: GPUBuffer, offset: number): void {
    enc.copyBufferToBuffer(this.coarse.pairBuf, 0, dst, offset, HEAD_BYTES);
    enc.copyBufferToBuffer(this.fine.counts, 0, dst, offset + HEAD_BYTES, COUNTS_BYTES);
    enc.clearBuffer(this.coarse.pairBuf, PAIR_HW_PAIRS * 4, 8);
    enc.clearBuffer(this.fine.counts, COUNT_HW_BRICKS * 4, COUNTS_BYTES - COUNT_HW_BRICKS * 4);
  }

  /** `copyAsked`'s words, read: a room found half full is made bigger by the next `prepare`. `room`: the rooms when the copy was made. True if a growth was planned */
  consider(w: Uint32Array, room: Rooms): boolean {
    const c = w.subarray(HEAD_BYTES / 4);
    this.rehashFails += c[COUNT_REHASH_FAILS];
    // (a pair that found no slot although the table was under half full: the table doubles all the same)
    const slots = c[COUNT_SLOT_FAILS_SINCE] ? Math.max(c[COUNT_HW_SLOTS], room.slots / 2) : c[COUNT_HW_SLOTS];
    const asked: Rooms = { pairs: Math.max(w[PAIR_ASKED], w[PAIR_HW_PAIRS]), items: Math.max(w[PAIR_ITEMS_ASKED], w[PAIR_HW_ITEMS]), cull: Math.max(c[COUNT_CULL], c[COUNT_HW_CULL]), groups: Math.max(c[COUNT_BRICKS], c[COUNT_HW_BRICKS]), slots };
    const plan = planRooms({ pairs: room.pairs, items: room.items, cull: room.cull, groups: room.groups, slots: room.slots }, asked);
    if (!Object.keys(plan).length) return false;
    this.want = { ...this.want, ...plan };
    return true;
  }

  /** the buffers a growth replaced, destroyed: when every encoder made before the growth has been submitted (`poll` does it too) */
  release(): void {
    this.coarse.release();
    this.fine.release();
  }

  private grow(want: Rooms): void {
    const before = this.rooms;
    const t0 = performance.now();
    this.coarse.grow({ rows: want.rows, pairRoom: want.pairs, itemRoom: want.items });
    this.fine.grow({ maxPairs: this.coarse.pairRoom, maxBricks: want.groups, maxCull: want.cull, slots: want.slots });
    const ms = performance.now() - t0;
    const after = this.rooms;
    for (const room of Object.keys(after)) if (after[room] !== before[room]) this.growths.push({ tick: this.polls, room, from: before[room], to: after[room], ms });
  }

  /**
   * After the engine's submit, every tick. Destroys the buffers a growth replaced; and every `readEvery` ticks, unless
   * a read is under way, copies what was asked of the rooms (128 B) and maps it. The read's answer comes between
   * ticks, some frames later; a room it finds half full is made bigger by the next `encode`. Never waits.
   */
  poll(): void {
    this.coarse.release();
    this.fine.release();
    this.polls++;
    if (!this.readEvery || this.reading || this.polls < this.next) return;
    this.next = this.polls + this.readEvery;
    const dev = this.device;
    const t0 = performance.now();
    const enc = dev.createCommandEncoder({ label: 'sdf rooms read' });
    // (the high-water words start again from here)
    this.copyAsked(enc, this.rd, 0);
    dev.queue.submit([enc.finish()]);
    const room = this.rooms;
    this.reading = this.rd.mapAsync(GPUMapMode.READ).then(
      () => {
        const w = new Uint32Array(this.rd.getMappedRange().slice(0));
        this.rd.unmap();
        this.reading = null;
        this.reads++;
        this.lastReadMs = performance.now() - t0;
        // (a room that ran out hid some of what the next would be asked: look again as soon as it has grown)
        if (this.consider(w, room)) this.next = this.polls + 1;
      },
      (e: unknown) => {
        // (the pass destroyed while a read was under way)
        this.reading = null;
        if (!this.dead) throw e;
      },
    );
  }

  /** the read under way, if any, landed (tests and benches: the engine never waits) */
  async settled(): Promise<void> {
    while (this.reading) await this.reading;
  }

  destroy(): void {
    this.dead = true;
    this.coarse.destroy();
    this.fine.destroy();
    this.rd.destroy();
  }
}
