// (loop-skeleton, BACKLOG LS-29) A save as what differs from a base that can be made again. The world's snapshot is
// 2.3 MB of JSON, nearly all of it the atlas's own regions, settlements and factions, which the atlas makes again from
// its seed; a run changes a few entities, appends events and moves the holdings. `delta(base, cur)` keeps only that;
// `applyDelta(base, d)` gives `cur` back, equal as JSON. Plain JSON data only (what a snapshot is).
//
// How it compares:
// - an object: key by key — the keys whose values differ (each as a delta of its own), and the keys gone;
// - an array whose items all carry an `id` (entities, events, settlements): by id — the items new or changed, whole,
//   and the order as "the base's, less these, then these at the end" when that describes it (an append-only history
//   costs its new events), else the full list of ids;
// - anything else (a number, a string, an array of plain values): whole, when its JSON differs.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** a delta: `{ $v }` the value whole; `{ $o }` an object's changed keys (and `$d` its keys gone); `{ $a }` an array by
 *  id — `set` the items new or changed, and its order: `rm` + `app` on the base's order, or `ids` in full */
export type Delta = { $v: Json } | { $o: { [k: string]: Delta }; $d?: string[] } | { $a: { set: Obj[]; rm?: (string | number)[]; app?: (string | number)[]; ids?: (string | number)[] } };

const isObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: Json): string | number | null => (isObj(v) && (typeof v.id === 'string' || typeof v.id === 'number') ? v.id : null);
/** an array of objects each with its own id (no two alike): compared by id */
function byId(a: Json[]): boolean {
  const seen = new Set<string | number>();
  for (const v of a) {
    const id = idOf(v);
    if (id === null || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** what `cur` differs from `base` by; null: nothing */
export function delta(base: Json | undefined, cur: Json): Delta | null {
  if (Array.isArray(base) && Array.isArray(cur) && cur.length > 0 && byId(base) && byId(cur)) {
    const was = new Map(base.map((v) => [idOf(v)!, JSON.stringify(v)]));
    const now = new Set(cur.map((v) => idOf(v)!));
    const set = cur.filter((v) => was.get(idOf(v)!) !== JSON.stringify(v)) as Obj[];
    const rm = base.map((v) => idOf(v)!).filter((id) => !now.has(id));
    const kept = base.map((v) => idOf(v)!).filter((id) => now.has(id));
    const ids = cur.map((v) => idOf(v)!);
    // (the base's order less what is gone, then the new ones at the end: the usual case)
    const tail = ids.slice(kept.length);
    const simple = kept.every((id, i) => ids[i] === id) && tail.every((id) => !was.has(id));
    if (!set.length && !rm.length && simple && !tail.length) return null;
    return { $a: simple ? { set, ...(rm.length ? { rm } : {}), ...(tail.length ? { app: tail } : {}) } : { set, ids } };
  }
  if (isObj(base) && isObj(cur)) {
    const $o: { [k: string]: Delta } = {};
    for (const k of Object.keys(cur)) {
      const d = delta(base[k], cur[k]);
      if (d) $o[k] = d;
    }
    const $d = Object.keys(base).filter((k) => !(k in cur));
    if (!Object.keys($o).length && !$d.length) return null;
    return { $o, ...($d.length ? { $d } : {}) };
  }
  return base !== undefined && JSON.stringify(base) === JSON.stringify(cur) ? null : { $v: cur };
}

/** `base` with a delta applied (a new value; `base` is not changed) */
export function applyDelta(base: Json | undefined, d: Delta | null): Json {
  if (d === null) return structuredClone(base ?? null);
  if ('$v' in d) return structuredClone(d.$v);
  if ('$o' in d) {
    const out: Obj = {};
    const b = isObj(base) ? base : {};
    const gone = new Set(d.$d ?? []);
    // (the base's keys in their order, then the new ones)
    for (const k of Object.keys(b)) if (!gone.has(k)) out[k] = k in d.$o ? applyDelta(b[k], d.$o[k]) : structuredClone(b[k]);
    for (const k of Object.keys(d.$o)) if (!(k in b)) out[k] = applyDelta(undefined, d.$o[k]);
    return out;
  }
  const b = Array.isArray(base) ? base : [];
  const items = new Map<string | number, Json>(b.map((v) => [idOf(v)!, v]));
  for (const v of d.$a.set) items.set(idOf(v)!, v);
  const gone = new Set(d.$a.rm ?? []);
  const ids = d.$a.ids ?? [...b.map((v) => idOf(v)!).filter((id) => !gone.has(id)), ...(d.$a.app ?? [])];
  return ids.map((id) => structuredClone(items.get(id)!));
}
