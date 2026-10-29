// (round 112, testspeed) The player's warmed world, kept in the browser (IndexedDB): the second visit to the same
// place on the same build starts from the world the first one's warmup left, skipping the warmup's ticks. The same
// snapshot as the test runner's (sim/snapshot.ts: one format, one capture, one restore), another store.
//
// Keyed by the build (__BUILD_HASH__, vite.config.ts: a hash of every file in src/ and data/ — any change to what the
// game is made of, a new key, so nothing stale runs) and the page's settings (every URL parameter but the ones that
// don't make the world). The dev server's modules change under it: no cache there. Only the newest KEEP are kept.
//
// On by default (`?warmcache=0` off): a snapshot is ~130 MB (the atlas window at q=low), read back and held in memory
// once while it's written or restored. Measured (desktop, round 112): the second visit 30 s to the level, the first 39.

import { decodeSnapshot, encodeSnapshot, type WorldSnapshot } from './snapshot';

const DB = 'reclaimed-warm';
const STORE = 'snapshots';
const KEEP = 2;
/** URL parameters that don't change the world a warmup makes */
const NOT_WORLD = new Set(['perf', 'hitch', 'hitchhud', 'warmcache', 'warmsnap', 'tutorial', 'audio']);

/** this page's key, or null where there's no build to key by (the dev server) */
export function warmKey(params: URLSearchParams): string | null {
  if (import.meta.env.DEV) return null;
  const q = [...params].filter(([k]) => !NOT_WORLD.has(k)).map(([k, v]) => `${k}=${v}`).sort().join('&');
  return `${__BUILD_HASH__}?${q}`;
}
declare const __BUILD_HASH__: string;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

/** the snapshot kept under `key`, or null */
export async function loadWarm(key: string): Promise<WorldSnapshot | null> {
  const db = await open();
  try {
    const rec = (await req(db.transaction(STORE).objectStore(STORE).get(key))) as { blob: Blob } | undefined;
    return rec ? decodeSnapshot(await rec.blob.arrayBuffer()) : null;
  } finally {
    db.close();
  }
}

/** keeps a capture under `key`, the oldest beyond KEEP dropped (a failure is the page's console.error: a cache, not the game) */
export async function saveWarm(key: string, snap: Promise<WorldSnapshot>): Promise<void> {
  try {
    const blob = encodeSnapshot(await snap);
    const db = await open();
    try {
      const st = db.transaction(STORE, 'readwrite').objectStore(STORE);
      await req(st.put({ blob, at: Date.now() }, key));
      const keys = (await req(st.getAllKeys())) as string[];
      const recs = (await req(st.getAll())) as { at: number }[];
      const old = keys.map((k, i) => ({ k, at: recs[i].at })).sort((a, b) => b.at - a.at).slice(KEEP);
      for (const o of old) await req(st.delete(o.k));
    } finally {
      db.close();
    }
  } catch (e) {
    console.error(`the warmed world wasn't kept: ${(e as Error)?.message ?? e}`);
  }
}
