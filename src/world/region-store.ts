// The region store (round 100, `regionstore`; docs/ARCHITECTURE.md "Region storage"): the disk tier under the
// streamer's GPU pool. Whole regions, as the user leans (DECISIONS round 100), one record a region
// (world/region-record.ts), keyed by world id + region, compressed and kept in IndexedDB by a worker
// (region-store.worker.ts). Nothing here is waited on by a frame: every call is async; the index (which regions
// have a record, and the session that wrote each) is read once at open, so `has` answers at once.
//
//   const store = await RegionStore.open('atlas:1')      // ?worldsave=0: RegionStore.memory(...) — the session's only
//   store.has('12,7') → meta | undefined
//   await store.put('12,7', bytes, { session, hash })     // compressed off the thread; bytes are transferred
//   await store.get('12,7') → bytes                        // decompressed off the thread
//   await store.clear()                                    // ?world=new: this world's records gone

import type { StoreAsk, StoreMeta, StoreReply } from './region-store.worker';

export type { StoreMeta };

type Ask = StoreAsk extends infer A ? (A extends { id: number } ? Omit<A, 'id' | 'world' | 'mem'> : never) : never;

export class RegionStore {
  private worker: Worker;
  private next = 1;
  private waiting = new Map<number, { res: (r: StoreReply) => void }>();
  private index = new Map<string, StoreMeta>();
  /** what's been put this session and not finished (a get of it waits for it) */
  private putting = new Map<string, Promise<void>>();
  readonly stats = { puts: 0, gets: 0, failed: 0, rawBytes: 0, packedBytes: 0, putMs: 0, getMs: 0, deleted: 0 };

  private constructor(
    readonly world: string,
    /** ?worldsave=0: kept in the worker's memory for this session (evicted from the pool, never written) */
    readonly mem: boolean,
  ) {
    this.worker = new Worker(new URL('./region-store.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<StoreReply>) => {
      const w = this.waiting.get(e.data.id);
      this.waiting.delete(e.data.id);
      w?.res(e.data);
    };
    this.worker.onerror = (e) => console.error(`[worldsave] the store's worker failed: ${e.message}`);
  }

  /** The store of a world (its index read). Fails — a clear error — when IndexedDB can't be opened. */
  static async open(world: string, mem = false): Promise<RegionStore> {
    const s = new RegionStore(world, mem);
    const r = await s.ask({ op: 'index' });
    if (!r.ok) throw new Error(`world save: the store can't be opened (${r.error})`);
    for (const m of r.metas ?? []) s.index.set(m.key, m);
    return s;
  }

  private ask(a: Ask): Promise<StoreReply> {
    const id = this.next++;
    const m = { ...a, id, world: this.world, mem: this.mem } as StoreAsk;
    return new Promise((res) => {
      this.waiting.set(id, { res });
      this.worker.postMessage(m, m.op === 'put' ? [m.raw] : []);
    });
  }

  has(key: string): StoreMeta | undefined {
    return this.index.get(key);
  }

  get size(): number {
    return this.index.size;
  }

  /** the records' sizes (bytes: raw, compressed) */
  totals(): { regions: number; raw: number; packed: number } {
    let raw = 0;
    let packed = 0;
    for (const m of this.index.values()) {
      raw += m.raw;
      packed += m.packed;
    }
    return { regions: this.index.size, raw, packed };
  }

  /** Put a region's record (its bytes are transferred to the worker: the caller's copy is gone). */
  put(key: string, bytes: Uint8Array, meta: { session: string; hash: number }): Promise<void> {
    const raw = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
    const n = raw.byteLength;
    const m = { key, world: this.world, session: meta.session, savedAt: Date.now(), hash: meta.hash };
    // (the index says it's there at once: a load before the write lands waits for it)
    this.index.set(key, { ...m, raw: n, packed: this.index.get(key)?.packed ?? 0 });
    const was = this.putting.get(key) ?? Promise.resolve();
    const p = was.then(async () => {
      const r = await this.ask({ op: 'put', key, raw, meta: m });
      if (!r.ok) {
        this.stats.failed++;
        this.index.delete(key);
        console.error(`[worldsave] writing region ${key} of ${this.world} failed: ${r.error}`);
        return;
      }
      this.stats.puts++;
      this.stats.rawBytes += n;
      this.stats.packedBytes += r.packed ?? 0;
      this.stats.putMs += r.ms ?? 0;
      const cur = this.index.get(key);
      if (cur && cur.savedAt === m.savedAt) cur.packed = r.packed ?? 0;
    });
    this.putting.set(key, p);
    void p.then(() => this.putting.get(key) === p && this.putting.delete(key));
    return p;
  }

  /** A region's record; throws (a clear error) when it can't be read. */
  async get(key: string): Promise<Uint8Array> {
    await this.putting.get(key);
    const r = await this.ask({ op: 'get', key });
    if (!r.ok || !r.raw) {
      this.stats.failed++;
      throw new Error(`world save: region ${key} of ${this.world} can't be read (${r.ok ? 'empty' : r.error})`);
    }
    this.stats.gets++;
    this.stats.getMs += r.ms ?? 0;
    return new Uint8Array(r.raw);
  }

  async delete(key: string): Promise<void> {
    if (!this.index.delete(key)) return;
    await this.putting.get(key);
    this.stats.deleted++;
    const r = await this.ask({ op: 'delete', key });
    if (!r.ok) console.error(`[worldsave] deleting region ${key} of ${this.world} failed: ${r.error}`);
  }

  /** Every record of this world gone (a new world). */
  async clear(): Promise<void> {
    await Promise.all(this.putting.values());
    const n = this.index.size;
    this.index.clear();
    const r = await this.ask({ op: 'clear' });
    if (!r.ok) throw new Error(`world save: clearing ${this.world} failed (${r.error})`);
    console.log(`[worldsave] a new world: ${n} saved regions of ${this.world} cleared`);
  }

  /** every write asked for so far landed */
  async flush(): Promise<void> {
    await Promise.all(this.putting.values());
  }

  dispose(): void {
    this.worker.terminate();
  }
}
