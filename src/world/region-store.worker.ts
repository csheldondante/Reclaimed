// The region store's worker (round 100, `regionstore`): records compressed and put into IndexedDB, read and
// decompressed, off the main thread (world/region-store.ts says what it's asked). The codec: the record's bytes
// byte-shuffled (each 4-byte word's bytes in four planes: the floats' exponents together, the layers' empty slots
// runs of zeros) and then deflated (CompressionStream).

const DB = 'reclaimed-world';
const DB_VERSION = 1;

/** what a record's meta row holds (the index read at start: no record is read for it) */
export interface StoreMeta {
  key: string;
  world: string;
  session: string;
  savedAt: number;
  raw: number;
  packed: number;
  hash: number;
  /** (round 114) the land generator that made it (GEN_VERSION); round 100–113's records have none */
  gen?: string;
}

/** `mem`: the session's own tier (?worldsave=0): kept in the worker's memory, compressed the same, never on disk */
export type StoreAsk = { mem?: boolean } & (
  | { op: 'index'; id: number; world: string }
  | { op: 'put'; id: number; world: string; key: string; raw: ArrayBuffer; meta: Omit<StoreMeta, 'raw' | 'packed'> }
  | { op: 'get'; id: number; world: string; key: string }
  | { op: 'delete'; id: number; world: string; key: string }
  | { op: 'clear'; id: number; world: string }
  | { op: 'prune'; id: number; world: string; gen: string; endedRuns?: string }
);

/** (prune) per world: records dropped for being another generator's, for being an ended run's */
export type Dropped = Record<string, { gen: number; run: number }>;

export type StoreReply = { id: number; ok: true; metas?: StoreMeta[]; raw?: ArrayBuffer; packed?: number; ms?: number; dropped?: Dropped } | { id: number; ok: false; error: string };

/**
 * (round 114) Whether a record goes as a store opens: this world's made by another land generator (unusable here:
 * its region is made again from the seed; and any world's from before generators were named), or any of an ended run's (`endedRuns`: the prefix of this seed's runs'
 * worlds; this world excepted). Other worlds' records stay — another seed, another branch's build may still use them.
 */
function pruned(m: StoreMeta, a: { world: string; gen: string; endedRuns?: string }): 'gen' | 'run' | null {
  // (round 100–113's records, of any world, say no generator: none is this build's or any later one's)
  if (m.gen === undefined) return 'gen';
  if (m.world === a.world) return m.gen === a.gen ? null : 'gen';
  return a.endedRuns && m.world.startsWith(a.endedRuns) ? 'run' : null;
}

let dbP: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbP ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('regions')) d.createObjectStore('regions');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('indexedDB.open failed'));
    r.onblocked = () => rej(new Error('indexedDB.open blocked (another tab holds an older version)'));
  }));
}

const done = (t: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error ?? new Error('transaction failed'));
    t.onabort = () => rej(t.error ?? new Error('transaction aborted'));
  });
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('request failed'));
  });

const id = (world: string, key: string) => `${world}|${key}`;
const range = (world: string) => IDBKeyRange.bound(`${world}|`, `${world}|￿`);

function shuffle(a: Uint8Array): Uint8Array {
  const n = a.length >> 2;
  const out = new Uint8Array(a.length);
  for (let i = 0; i < n; i++) {
    out[i] = a[i * 4];
    out[n + i] = a[i * 4 + 1];
    out[2 * n + i] = a[i * 4 + 2];
    out[3 * n + i] = a[i * 4 + 3];
  }
  out.set(a.subarray(n * 4), n * 4);
  return out;
}

function unshuffle(a: Uint8Array): Uint8Array {
  const n = a.length >> 2;
  const out = new Uint8Array(a.length);
  for (let i = 0; i < n; i++) {
    out[i * 4] = a[i];
    out[i * 4 + 1] = a[n + i];
    out[i * 4 + 2] = a[2 * n + i];
    out[i * 4 + 3] = a[3 * n + i];
  }
  out.set(a.subarray(n * 4), n * 4);
  return out;
}

async function pipe(a: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const s = new Blob([a as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const memRegions = new Map<string, ArrayBuffer>();
const memMeta = new Map<string, StoreMeta>();

async function handleMem(m: StoreAsk): Promise<StoreReply> {
  const t0 = performance.now();
  if (m.op === 'prune') {
    const dropped: Dropped = {};
    for (const [k, x] of [...memMeta]) {
      const why = pruned(x, m);
      if (!why) continue;
      (dropped[x.world] ??= { gen: 0, run: 0 })[why]++;
      memMeta.delete(k);
      memRegions.delete(k);
    }
    return { id: m.id, ok: true, dropped };
  }
  if (m.op === 'index') return { id: m.id, ok: true, metas: [...memMeta.values()].filter((x) => x.world === m.world) };
  if (m.op === 'put') {
    const packed = await pipe(shuffle(new Uint8Array(m.raw)), new CompressionStream('deflate'));
    memRegions.set(id(m.world, m.key), packed.buffer as ArrayBuffer);
    memMeta.set(id(m.world, m.key), { ...m.meta, raw: m.raw.byteLength, packed: packed.byteLength });
    return { id: m.id, ok: true, packed: packed.byteLength, ms: performance.now() - t0 };
  }
  if (m.op === 'get') {
    const got = memRegions.get(id(m.world, m.key));
    if (!got) return { id: m.id, ok: false, error: `no record ${m.world}|${m.key} (memory)` };
    const raw = unshuffle(await pipe(new Uint8Array(got), new DecompressionStream('deflate')));
    return { id: m.id, ok: true, raw: raw.buffer as ArrayBuffer, ms: performance.now() - t0 };
  }
  if (m.op === 'delete') {
    memRegions.delete(id(m.world, m.key));
    memMeta.delete(id(m.world, m.key));
    return { id: m.id, ok: true };
  }
  for (const k of [...memMeta.keys()])
    if (k.startsWith(`${m.world}|`)) {
      memMeta.delete(k);
      memRegions.delete(k);
    }
  return { id: m.id, ok: true };
}

async function handle(m: StoreAsk): Promise<StoreReply> {
  if (m.mem) return handleMem(m);
  const d = await db();
  if (m.op === 'index') {
    const t = d.transaction('meta', 'readonly');
    const metas = (await req(t.objectStore('meta').getAll(range(m.world)))) as StoreMeta[];
    return { id: m.id, ok: true, metas };
  }
  if (m.op === 'prune') {
    // (the meta rows only — small — every world's, one transaction)
    const t = d.transaction(['regions', 'meta'], 'readwrite');
    const meta = t.objectStore('meta');
    const [keys, metas] = await Promise.all([req(meta.getAllKeys()), req(meta.getAll())]);
    const dropped: Dropped = {};
    (metas as StoreMeta[]).forEach((x, i) => {
      const why = pruned(x, m);
      if (!why) return;
      (dropped[x.world] ??= { gen: 0, run: 0 })[why]++;
      meta.delete(keys[i]);
      t.objectStore('regions').delete(keys[i]);
    });
    await done(t);
    return { id: m.id, ok: true, dropped };
  }
  if (m.op === 'put') {
    const t0 = performance.now();
    const packed = await pipe(shuffle(new Uint8Array(m.raw)), new CompressionStream('deflate'));
    const t = d.transaction(['regions', 'meta'], 'readwrite');
    t.objectStore('regions').put(packed.buffer, id(m.world, m.key));
    const meta: StoreMeta = { ...m.meta, raw: m.raw.byteLength, packed: packed.byteLength };
    t.objectStore('meta').put(meta, id(m.world, m.key));
    await done(t);
    return { id: m.id, ok: true, packed: packed.byteLength, ms: performance.now() - t0 };
  }
  if (m.op === 'get') {
    const t0 = performance.now();
    const t = d.transaction('regions', 'readonly');
    const got = (await req(t.objectStore('regions').get(id(m.world, m.key)))) as ArrayBuffer | undefined;
    if (!got) return { id: m.id, ok: false, error: `no record ${m.world}|${m.key}` };
    const raw = unshuffle(await pipe(new Uint8Array(got), new DecompressionStream('deflate')));
    return { id: m.id, ok: true, raw: raw.buffer as ArrayBuffer, ms: performance.now() - t0 };
  }
  if (m.op === 'delete') {
    const t = d.transaction(['regions', 'meta'], 'readwrite');
    t.objectStore('regions').delete(id(m.world, m.key));
    t.objectStore('meta').delete(id(m.world, m.key));
    await done(t);
    return { id: m.id, ok: true };
  }
  const t = d.transaction(['regions', 'meta'], 'readwrite');
  t.objectStore('regions').delete(range(m.world));
  t.objectStore('meta').delete(range(m.world));
  await done(t);
  return { id: m.id, ok: true };
}

// (one at a time, in the order asked: a put then a get of the same key reads what was put)
let chain: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent<StoreAsk>) => {
  const m = e.data;
  chain = chain.then(async () => {
    let r: StoreReply;
    try {
      r = await handle(m);
    } catch (err) {
      r = { id: m.id, ok: false, error: String((err as Error)?.message ?? err) };
    }
    const tr = r.ok && r.raw ? [r.raw] : [];
    (self as unknown as Worker).postMessage(r, tr);
  });
};
