// The phone's performance flags (perfopt, round 83; docs/DEVLOG.md — the user: "About 16ms for p95"), one copy
// for every page. They're read from the URL as the modules load, so a page applies them before it imports
// anything that reads the URL: main.ts imports './phone-flags-boot' first.
//
// The set: on the low tier (no `q`, or `q=low` — the default, for phones), each flag only where the URL doesn't
// give it (so any one can be turned back, e.g. &settle=1 or &tufts=1), all of them off with ?phone=0. ?lite=1 adds
// the render's half on any tier.

/** the render's half (?lite=1 on any tier) */
export const LITE_SET: Readonly<Record<string, string>> = { tufts: '0', shadowcache: '4', prepevery: '2', bandh: '2', shadowsize: '512' };
/** the simulation's half (the low tier) */
export const SIM_SET: Readonly<Record<string, string>> = { settle: '0', inplace: '1', sleepmore: '1' };

/** Is this URL's tier the phone's? (low: no `q` or `q=low`, and not ?phone=0) */
export function isPhoneTier(q: URLSearchParams): boolean {
  return (q.get('q') ?? 'low') === 'low' && q.get('phone') !== '0';
}

/**
 * The flags added to `q` (in place) for its tier: the whole set where `phone(q)`, the render's half where ?lite=1.
 * Returns whether anything was added.
 */
export function expandPhoneFlags(q: URLSearchParams, phone: (q: URLSearchParams) => boolean = isPhoneTier): boolean {
  const low = phone(q);
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

/** Expand the page's own URL (history.replaceState): call before importing anything that reads the URL. */
export function applyPhoneFlags(phone: (q: URLSearchParams) => boolean = isPhoneTier): void {
  if (typeof location === 'undefined') return;
  const q = new URLSearchParams(location.search);
  if (expandPhoneFlags(q, phone)) history.replaceState(null, '', `${location.pathname}?${q.toString()}${location.hash}`);
}
