// The page's URL flags, resolved once (DA-B17): the URL's own, plus the phone's performance set on the low tier. Every
// module reads its flags here (`urlFlags()`), never `location.search`: this module is a dependency of each reader,
// so ES modules evaluate it — and the phone set is in — before any reader runs, whatever order a bundle puts the
// readers' chunks in. (Until DA-B17 the set was written into the URL by main.ts's first import, phone-flags-boot.
// The vite dev server ran that first; the production build — GitHub Pages, the lab, the scripts — ran the chunk
// holding the renderer and the systems before main's own code, so the module-level reads saw the URL without the
// set: the phone ran without the shadow cache, prepEvery, in-place columns, settle=0 and sleepmore since
// 2026-10-26, e5ba962. test/unit/flags.test.ts keeps every read here; scripts/flagcheck.mjs checks a built page.)
//
// The phone's set (perfopt, round 83; the user: "About 16ms for p95"): on the low tier (no `q`, or `q=low` — the
// default, for phones), each flag only where the URL doesn't give it (so any one can be turned back, e.g. &settle=1
// or &tufts=1), all of them off with ?phone=0. ?lite=1 adds the render's half on any tier.
//
// A worker has its own `location` (the worker script's URL, no query): what it reads here is the defaults, as before.

/** the render's half (?lite=1 on any tier); round 85 the hybrid (heightfield chunks, voxels where the ground needs
 *  them; the atlas level only) — the user: "Hybrid is awesome and definitely should be merged!" */
export const LITE_SET: Readonly<Record<string, string>> = { tufts: '0', shadowcache: '4', prepevery: '2', bandh: '2', shadowsize: '512', hybrid: '1' };
/** the simulation's half (the low tier) */
export const SIM_SET: Readonly<Record<string, string>> = { settle: '0', inplace: '1', sleepmore: '1' };

/** Is this URL's tier the phone's? (low: no `q` or `q=low`, and not ?phone=0) */
export function isPhoneTier(q: URLSearchParams): boolean {
  return (q.get('q') ?? 'low') === 'low' && q.get('phone') !== '0';
}

/**
 * The flags added to `q` (in place) for its tier: the whole set on the phone's tier, the render's half where ?lite=1.
 * Returns whether anything was added.
 */
export function expandPhoneFlags(q: URLSearchParams): boolean {
  const low = isPhoneTier(q);
  if (q.get('lite') !== '1' && !low) return false;
  const set: Record<string, string> = { ...LITE_SET, ...(low ? SIM_SET : {}) };
  let changed = false;
  for (const [k, v] of Object.entries(set))
    if (!q.has(k)) {
      q.set(k, v);
      changed = true;
    }
  return changed;
}

/** A URL's flags resolved: its own and its tier's set (pure: tests give it a query string). */
export function resolveFlags(search: string): URLSearchParams {
  const q = new URLSearchParams(search);
  expandPhoneFlags(q);
  return q;
}

const PAGE = typeof location === 'undefined' ? '' : location.search;
const RESOLVED = resolveFlags(PAGE);
// (the address bar shows what the page runs with: a link copied from it opens the same — the reads above don't
// depend on it)
if (typeof history !== 'undefined' && typeof document !== 'undefined' && RESOLVED.toString() !== new URLSearchParams(PAGE).toString())
  history.replaceState(null, '', `${location.pathname}?${RESOLVED.toString()}${location.hash}`);

/** The page's flags, resolved (a fresh copy each call: a caller may change it to build a link). */
export function urlFlags(): URLSearchParams {
  return new URLSearchParams(RESOLVED);
}
