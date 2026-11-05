// The bench's state between page loads: BenchState and its pages, kept in localStorage and IndexedDB (the full
// results). API: load, loadFull, save (going to the next page, `go`, stays in bench.ts with the flags it sets).
import { BENCH_VERSION, STATE, LAST } from './defs';

// ---------- the suite's state ----------

export interface PageSpec {
  name: string;
  params: Record<string, string>;
}

export interface BenchState {
  /** (round 104) which suite: the full one (?bench=1) or the pan benchmark (?bench=pan) */
  suite?: 'full' | 'pan';
  version: number;
  id: string;
  startedAt: string;
  step: number;
  pages: PageSpec[];
  base: string;
  /** world ids the level pages saved into (cleared at the end: the viewer's own world is never touched) */
  worlds: string[];
  results: Record<string, unknown>;
  errors: string[];
  done?: boolean;
}

// (v4) The pages' results live in IndexedDB; localStorage keeps only the chain (pages, step, errors: a few KB). The
// origin's localStorage is shared by every branch's build — on the Pixel 9a v3's main page couldn't keep its results
// there and the chain stopped; a headless run with it filled to the brim lost every page's numbers to the fallback.
export const IDB = 'reclaimed-bench';
export let idbP: Promise<IDBDatabase | null> | null = null;
export function idb(): Promise<IDBDatabase | null> {
  return (idbP ??= new Promise((res) => {
    try {
      const r = indexedDB.open(IDB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch {
      res(null);
    }
  }));
}
export async function idbPut(key: string, value: unknown): Promise<boolean> {
  const db = await idb();
  if (!db) return false;
  return new Promise((res) => {
    try {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(value, key);
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
      t.onabort = () => res(false);
    } catch {
      res(false);
    }
  });
}
export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((res) => {
    try {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result as T | undefined);
      r.onerror = () => res(undefined);
    } catch {
      res(undefined);
    }
  });
}
/** states whose results were loaded (or made) whole: only those write their results (a skeleton would blank them) */
export const whole = new WeakSet<BenchState>();
/** the last results write, waited for before the page goes */
export let pending: Promise<unknown> = Promise.resolve();
/** IndexedDB refused: the results go in localStorage as before (v4's compacting save) */
export let idbFailed = false;

export function load(): BenchState | null {
  try {
    const s = JSON.parse(localStorage.getItem(STATE) ?? 'null') as BenchState | null;
    if (!s || s.version !== BENCH_VERSION) return null;
    s.results ??= {};
    // (results kept in localStorage — IndexedDB refused — make it whole)
    if (Object.keys(s.results).length) whole.add(s);
    return s;
  } catch {
    return null;
  }
}

/** the state with its results (IndexedDB's over any localStorage held) */
export async function loadFull(): Promise<BenchState | null> {
  const s = load();
  if (!s) return null;
  const r = await idbGet<Record<string, unknown>>(`results:${s.id}`);
  if (r) s.results = { ...r, ...s.results };
  whole.add(s);
  return s;
}

export function save(s: BenchState): void {
  if (whole.has(s) && !idbFailed) {
    const results = s.results;
    const id = s.id;
    // (a copy: the results go on changing while the write is under way)
    const copy = JSON.parse(JSON.stringify(results));
    pending = pending.then(() =>
      idbPut(`results:${id}`, copy).then((ok) => {
        if (!ok) idbFailed = true;
      }),
    );
    const skeleton = { ...s, results: {} };
    try {
      localStorage.setItem(STATE, JSON.stringify(skeleton));
      return;
    } catch {
      // (even the skeleton didn't fit: the fallback below)
    }
  }
  const body = JSON.stringify(s);
  try {
    localStorage.setItem(STATE, body);
    return;
  } catch {
    // (v4: full — the origin is shared by every branch's build; room made below)
  }
  // the previous run's stored report first, then the pages' details (the summary-worthy numbers stay)
  try {
    localStorage.removeItem(LAST);
    localStorage.setItem(STATE, body);
    s.errors.push('localStorage was full: the previous run\'s stored report was dropped to make room');
    localStorage.setItem(STATE, JSON.stringify(s));
    return;
  } catch {
    // (still full)
  }
  const slim = JSON.parse(body) as BenchState;
  for (const r of Object.values(slim.results) as Record<string, unknown>[])
    if (r && typeof r === 'object')
      for (const c of Object.values(r) as Record<string, unknown>[])
        if (c && typeof c === 'object') {
          delete c.gpuPasses;
          delete c.cpuSteps;
          delete c.hitch;
          delete c.stream;
        }
  slim.errors.push('localStorage was full: per-capture details (passes, CPU steps, hitches) dropped');
  try {
    localStorage.setItem(STATE, JSON.stringify(slim));
    return;
  } catch {
    // (still full: the pages' numbers go, the chain goes on — the report says what was lost)
  }
  for (const k of Object.keys(slim.results)) {
    const r = slim.results[k] as Record<string, unknown> | undefined;
    const keep: Record<string, unknown> = { dropped: 'localStorage full' };
    if (r && typeof r === 'object') for (const f of ['page', 'error', 'readyAtMs', 'pageMs']) if (f in r) keep[f] = r[f];
    if (!['device', 'timestampModes', 'thermalStart'].includes(k)) slim.results[k] = keep;
  }
  slim.errors.push('localStorage was full even slimmed: the numbers of the pages dropped (free space on this site: other builds saves)');
  try {
    localStorage.setItem(STATE, JSON.stringify(slim));
  } catch (e) {
    throw new Error(`bench: localStorage refused even the suite's bare state (${(e as Error).message}) — the benchmark needs it between pages`);
  }
}
