// (round 120, JB6: "no CPU readback on the hot path") The CPU's copy of the GPU's columns (WorldGpu.layers), as the
// integrity system reads it — one concern taken out of Integrity: where a column's intervals come from on the CPU, and
// how they're written back.
//
// Two ways to hold it:
//   kept    the window's whole copy, read before each of the judge's passes (the chunks round what it looks at; all of
//           it after a slide) — for the CPU consumers that walk the columns every frame or every pass: judge A (runs,
//           fracture.ts analyseRock), the CPU rigid rock's ground (rockbodies.ts columnsGround), the pieces falling in
//           the columns (colbodies.ts)
//   sparse  nothing held between uses: a reader that needs some columns fetches them (`fetch`: those chunks, or those
//           columns, read back) and reads them in the continuation, the same task — a column not fetched since the last
//           frame throws (never a stale read)
// Writes go to the GPU (queue.writeBuffer) and into the copy where it holds the column.
import { columnSlots, packColumn, readColumn, SLOT_WORDS, CHUNK, type Interval, type PackedWorld } from '../world/layout';
import { WorldVox } from './fracture';
import { fitColumn } from './colapply';
import { ignoreTeardown } from '../gpu/pipeline';

export type CopyMode = 'kept' | 'sparse';

export interface CopyHost {
  device: GPUDevice;
  packed: PackedWorld;
  layers: () => GPUBuffer;
  /** the window's epoch (bumped by every slide: what was read before is of another window) */
  epoch: () => number;
  /** the whole layers buffer read back (WorldCore.readBuffer('layers')) */
  readWhole: () => Promise<Float32Array>;
  /** a column written by the CPU: its chunk's sims woken (Sleep.wake) */
  woke?: (x: number, y: number) => void;
}

export class ColumnCopy {
  /** the copy's slots (the window's layout: packed.chunkTable); empty when nothing is held */
  readonly vox: WorldVox;
  /** bytes read back so far (the battery and the tests read it) */
  readBytes = 0;
  /** (kept) the window's epoch the copy is of (-1: none: the next read is whole) */
  private readEpoch = -1;
  /** (kept) the chunks read for this pass (null: all of it) */
  fresh: Set<number> | null = null;
  /** (sparse) the chunks fetched this frame (chunk → its epoch) */
  private held = new Map<number, number>();
  /** each read in flight: the columns written meanwhile, put back into the copy it brings (it predates them) */
  private inflight = new Set<Map<number, Interval[]>>();

  constructor(
    private host: CopyHost,
    public mode: CopyMode,
  ) {
    this.vox = new WorldVox(host.packed, new Uint32Array(0));
  }

  get packed(): PackedWorld {
    return this.host.packed;
  }

  /** whether the copy has any columns (kept: read at least once since it was dropped) */
  get any(): boolean {
    return this.vox.slots.length > 0;
  }

  /** (kept) whether the whole window's copy is there to walk (the CPU judges and bodies read it) */
  get whole(): boolean {
    return this.mode === 'kept' && this.any;
  }

  /** the chunk (index in the chunk table) a column is in */
  chunkOf(x: number, y: number): number {
    return Math.floor(y / CHUNK) * this.host.packed.chunksX + Math.floor(x / CHUNK);
  }

  /** Can column (x, y) be read now? (kept: once anything was read; sparse: fetched this frame, this window) */
  has(x: number, y: number): boolean {
    if (!this.any) return false;
    if (this.mode === 'kept') return true;
    return this.held.get(this.chunkOf(x, y)) === this.host.epoch();
  }

  /** Column (x, y)'s intervals as the copy holds them. Throws for one it can't read now (sparse: not fetched). */
  read(x: number, y: number): Interval[] {
    if (!this.has(x, y)) throw new Error(`ColumnCopy: column ${x},${y} isn't held (${this.mode}${this.mode === 'sparse' ? ': fetch it first' : ': nothing read yet'})`);
    return readColumn(this.host.packed, this.vox.slots, x, y);
  }

  /**
   * A column written: to the GPU's layers (`gpu`), into the copy where it holds it (`cpu`) — a column over its K slots
   * fitted (fitColumn: its bottom K − 1, the rest's height as rubble on top).
   */
  write(x: number, y: number, col: Interval[], cpu = true, gpu = true): void {
    const { base, k } = columnSlots(this.host.packed, x, y);
    col = fitColumn(col, k, this.host.packed.dims.zMax);
    const data = packColumn(col, k);
    if (cpu) {
      if (this.has(x, y)) this.vox.slots.set(data, base * SLOT_WORDS);
      // (a read in flight brings the column as it was: this goes back over it)
      for (const m of this.inflight) m.set(y * 65536 + x, col);
    }
    if (!gpu) return;
    this.host.device.queue.writeBuffer(this.host.layers(), base * SLOT_WORDS * 4, data);
    if (cpu) this.host.woke?.(x, y);
  }

  /** Mirror a change the GPU made into the copy where it holds the column (the copy stays the GPU's). */
  mirror(x: number, y: number, col: Interval[]): void {
    this.write(x, y, col, true, false);
  }

  /** Drop what's held: kept, the next read is whole; sparse, nothing is readable till fetched. */
  drop(): void {
    this.readEpoch = -1;
    this.fresh = null;
    this.held.clear();
    if (this.mode === 'sparse') this.vox.slots = new Uint32Array(0);
  }

  /** (sparse) a new frame: what was fetched before isn't readable any more */
  frame(): void {
    if (this.mode === 'sparse') this.held.clear();
  }

  /**
   * (kept) The pass's read: the whole window when the copy is of another (or none), else these chunks (empty: nothing
   * read). 'slid': the window slid while it was read (nothing to judge on; read again next time).
   */
  async readFor(want: Set<number> | 'all'): Promise<'slid' | 'whole' | 'near' | 'none'> {
    const e = this.host.epoch();
    const written = new Map<number, Interval[]>();
    this.inflight.add(written);
    try {
      if (want === 'all' || !this.any || this.readEpoch !== e) {
        const f = await this.host.readWhole();
        if (this.host.epoch() !== e) return 'slid';
        this.readBytes += f.byteLength;
        this.vox.slots = new Uint32Array(f.buffer);
        this.readEpoch = e;
        this.fresh = null;
        this.replay(written);
        return 'whole';
      }
      this.fresh = want;
      if (!want.size) return 'none';
      const ok = await this.readChunks(want, e);
      if (!ok) {
        this.readEpoch = -1;
        return 'slid';
      }
      this.replay(written);
      return 'near';
    } finally {
      this.inflight.delete(written);
    }
  }

  /**
   * (sparse) These chunks and the chunks holding these columns read back now, readable in the continuation (this
   * task). False: the window slid meanwhile (nothing held: try again).
   */
  async fetch(chunks: Iterable<number>, cols: Iterable<[number, number]> = []): Promise<boolean> {
    if (this.mode !== 'sparse') throw new Error('ColumnCopy.fetch: the kept copy is read by the pass (readFor)');
    const want = new Set(chunks);
    for (const [x, y] of cols) want.add(this.chunkOf(x, y));
    const e = this.host.epoch();
    if (!want.size) return true;
    // (the copy's array: the window's size, made once — only what's fetched is meaningful)
    const words = this.host.packed.slots.length;
    if (this.vox.slots.length !== words) this.vox.slots = new Uint32Array(words);
    const written = new Map<number, Interval[]>();
    this.inflight.add(written);
    try {
      if (!(await this.readChunks(want, e))) return false;
      this.replay(written);
      for (const c of want) this.held.set(c, e);
      return true;
    } finally {
      this.inflight.delete(written);
    }
  }

  /** chunks of a box of window columns [x0, x1] × [y0, y1] (clamped) */
  chunksIn(x0: number, y0: number, x1: number, y1: number): Set<number> {
    const p = this.host.packed;
    const out = new Set<number>();
    const cx0 = Math.max(0, Math.floor(x0 / CHUNK));
    const cx1 = Math.min(p.chunksX - 1, Math.floor(x1 / CHUNK));
    const cy0 = Math.max(0, Math.floor(y0 / CHUNK));
    const cy1 = Math.min(p.chunksY - 1, Math.floor(y1 / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) out.add(cy * p.chunksX + cx);
    return out;
  }

  /** the chunks read back into the copy; false: the window slid meanwhile */
  private async readChunks(want: Set<number>, e: number): Promise<boolean> {
    const p = this.host.packed;
    const dev = this.host.device;
    const ranges: [number, number][] = [];
    let bytes = 0;
    for (const ci of want) {
      const at = p.chunkTable[ci * 2] * SLOT_WORDS * 4;
      const n = CHUNK * CHUNK * p.chunkTable[ci * 2 + 1] * SLOT_WORDS * 4;
      ranges.push([at, n]);
      bytes += n;
    }
    const tmp = dev.createBuffer({ label: 'column copy', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    let o = 0;
    for (const [at, n] of ranges) {
      enc.copyBufferToBuffer(this.host.layers(), at, tmp, o, n);
      o += n;
    }
    dev.queue.submit([enc.finish()]);
    try {
      await tmp.mapAsync(GPUMapMode.READ);
    } catch (err) {
      tmp.destroy();
      ignoreTeardown(err);
      return false;
    }
    if (this.host.epoch() !== e) {
      tmp.destroy();
      return false;
    }
    const all = new Uint32Array(tmp.getMappedRange());
    o = 0;
    for (const [at, n] of ranges) {
      this.vox.slots.set(all.subarray(o / 4, (o + n) / 4), at / 4);
      o += n;
    }
    tmp.destroy();
    this.readBytes += bytes;
    return true;
  }

  /** what was written while the read was in flight, put back over what it brought */
  private replay(written: Map<number, Interval[]>): void {
    for (const [k, col] of written) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      const { base, k: kk } = columnSlots(this.host.packed, x, y);
      this.vox.slots.set(packColumn(col, kk), base * SLOT_WORDS);
    }
  }
}
