// The flora library's meshes kept between loads (round 128, `treegen`; main: "cache the generated meshes by (species,
// variant, params hash) in IndexedDB ... Don't add load time on the phone"). The colonized crowns made the library's
// build ~0.8-1 s at start; a page loads them from the browser's store instead, and stores what it had to make.
//
// generate.ts asks `cached(key)` before making a woody plant and `remember(key, mesh)` after; the key is the species'
// whole definition (JSON), the seed, the level, the px, and MESH_VERSION — bump it when the generator's code changes
// what a definition makes. `preloadMeshes()` (main.ts, before the first scene) reads the store into memory; `flush()`
// writes the new ones back, after the world is up. The store can be missing (a private window, Node): then everything
// is made, as before — a cache, not a fallback for anything.

import type { FloraMesh } from './mesh';

/** bump when the generator's code (not a species' parameters) changes what a definition makes */
export const MESH_VERSION = 'r128-7';

const mem = new Map<string, FloraMesh>();
const fresh = new Map<string, FloraMesh>();
const DB = 'reclaimed-flora';
const STORE = 'meshes';

/** a stable short key for (definition, seed, level, px) */
export function meshKey(def: unknown, seed: number, lod: unknown, px: number | undefined): string {
  const s = `${MESH_VERSION}|${JSON.stringify(def)}|${seed}|${String(lod)}|${px ?? '-'}`;
  // FNV-1a 64 as two 32-bit halves: the key's length doesn't matter, its spread does
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}${s.length.toString(36)}`;
}

export function cached(key: string): FloraMesh | undefined {
  return mem.get(key);
}

export function remember(key: string, m: FloraMesh): void {
  // (the flora viewer's sliders make a new key a drag: held to a few hundred)
  if (mem.size > 400) {
    mem.clear();
    fresh.clear();
  }
  mem.set(key, m);
  if (typeof indexedDB !== 'undefined') fresh.set(key, m);
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((res) => {
    try {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}

/** Read every stored mesh of this MESH_VERSION into memory (older versions' are dropped). */
export async function preloadMeshes(): Promise<number> {
  const db = await open();
  if (!db) return 0;
  return new Promise((res) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const rq = st.openCursor();
    let n = 0;
    rq.onsuccess = () => {
      const c = rq.result;
      if (!c) return;
      const v = c.value as { v: string; m: FloraMesh };
      if (v?.v === MESH_VERSION) {
        mem.set(String(c.key), v.m);
        n++;
      } else c.delete();
      c.continue();
    };
    tx.oncomplete = () => res(n);
    tx.onerror = () => res(n);
  });
}

/** Store the meshes made since the last flush. */
export async function flushMeshes(): Promise<number> {
  if (!fresh.size) return 0;
  const db = await open();
  if (!db) return 0;
  const items = [...fresh];
  fresh.clear();
  return new Promise((res) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const [k, m] of items) st.put({ v: MESH_VERSION, m }, k);
    tx.oncomplete = () => res(items.length);
    tx.onerror = () => res(0);
  });
}
