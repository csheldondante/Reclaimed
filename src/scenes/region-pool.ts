// The GPU region pool (round 100, `regionstore`; docs/ARCHITECTURE.md "Region storage"). Regions out of the window
// stay on the GPU: a slot is one region's bytes in the layout of world/region-record.ts (its chunk pages, every
// per-column buffer and texture the streamer keeps), copied GPU to GPU from the window when it leaves and back when
// it comes in — a slide never waits on a readback. Slots are handed out of pages (buffers of PER_PAGE slots, made
// as they're first needed) up to `cap`; the streamer keeps them in LRU order and evicts the oldest to its store.

export interface PoolSlot {
  buf: GPUBuffer;
  off: number;
  id: number;
}

export class RegionPool {
  private pages: GPUBuffer[] = [];
  private free: PoolSlot[] = [];
  private made = 0;
  static readonly PER_PAGE = 8;

  constructor(
    private make: (label: string, size: number) => GPUBuffer,
    /** one region's bytes (a multiple of 256) */
    readonly bytes: number,
    /** slots at most */
    readonly cap: number,
  ) {
    if (bytes % 256) throw new Error('a pool slot must be a multiple of 256 bytes');
  }

  /** slots handed out */
  get used(): number {
    return this.made - this.free.length;
  }

  /** the pool's GPU memory (bytes, pages made) */
  get gpuBytes(): number {
    return this.pages.reduce((n, p) => n + p.size, 0);
  }

  /** A free slot; null when all `cap` are out (the caller evicts one). */
  alloc(): PoolSlot | null {
    const f = this.free.pop();
    if (f) return f;
    if (this.made >= this.cap) return null;
    const per = RegionPool.PER_PAGE;
    const page = Math.floor(this.made / per);
    if (page >= this.pages.length) this.pages.push(this.make(`regionPool${page}`, this.bytes * Math.min(per, this.cap - page * per)));
    const s: PoolSlot = { buf: this.pages[page], off: (this.made % per) * this.bytes, id: this.made };
    this.made++;
    return s;
  }

  /** A slot back. (What was copied out of it before is in the queue ahead of whatever is copied in next.) A slot of
   *  its own (temp) is let go. */
  release(s: PoolSlot): void {
    if (s.id < 0) s.buf.destroy();
    else this.free.push(s);
  }

  /** (round 102) a slot outside the pool (every slot wanted: a region made on the GPU still needs one), let go by release */
  temp(): PoolSlot {
    this.temps++;
    return { buf: this.make('regionTemp', this.bytes), off: 0, id: -1 };
  }
  /** slots made outside the pool so far */
  temps = 0;
}
