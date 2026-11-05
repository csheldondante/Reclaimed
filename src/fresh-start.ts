// (round 128n, phonefix; the user: "Can you just add a debug flag to clear cache at startup for now and use that unless
// we are testing persistence?") `?fresh=1`: before anything opens storage (main.ts awaits this first), every store of
// the world is deleted — the region store, the map files, the warm cache — and the world's progress kept in
// localStorage. The benches' stores (perf/bench/state.ts, perf/pagebench.ts, the flora and physics benches) and the
// player's settings (difficulty, tuning, the atlas range) are kept: a phone's bench reports survive a fresh start.
// The flag doesn't replace the stores' own versions (GEN_VERSION, the build hash): a saved world still needs them.
// API: FRESH_DBS, FRESH_KEYS, freshStart.

/** the IndexedDB databases of the world: world/region-store.worker.ts, world/mapfile.ts, sim/warm-cache.ts */
export const FRESH_DBS = ['reclaimed-world', 'reclaimed', 'reclaimed-warm'] as const;
/** localStorage keys (prefixes) of the world's state: game/progress.ts (each level's progress, what's uncovered) */
export const FRESH_KEYS = ['reclaimed.progress.v1', 'reclaimed.uncovered.v1'] as const;

function deleteDb(idb: Pick<IDBFactory, 'deleteDatabase'>, name: string): Promise<void> {
  return new Promise((res, rej) => {
    const r = idb.deleteDatabase(name);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error ?? new Error(`deleting ${name} failed`));
    // (another tab of this site holds it open: the delete would wait for it to close, so say so instead of hanging)
    r.onblocked = () => rej(new Error(`?fresh=1: the saved world "${name}" is open in another tab of this site — close it and reload`));
  });
}

/** with `?fresh=1`, the world's stores deleted (awaited); else nothing. Returns what was cleared, for the console. */
export async function freshStart(params: URLSearchParams, storage: Storage = globalThis.localStorage, idb: Pick<IDBFactory, 'deleteDatabase'> = globalThis.indexedDB): Promise<string[] | null> {
  if (params.get('fresh') !== '1') return null;
  await Promise.all(FRESH_DBS.map((n) => deleteDb(idb, n)));
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && FRESH_KEYS.some((p) => k === p || k.startsWith(`${p}.`))) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
  const done = [...FRESH_DBS, ...keys];
  console.log(`[fresh] cleared ${done.join(', ')}`);
  return done;
}

