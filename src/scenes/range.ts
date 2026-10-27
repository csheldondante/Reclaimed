// (round 90, the user on the phone: "can we increase the range of tiles that load" … "have a setting for how far
// out it will build?") How far out the atlas level builds the land in detail: the streamed window's side (cells,
// whole regions). ?win= wins; else the viewer's own choice (kept in this browser), else the tier's default.
// The window's buffers are made with the level, so a new range is a reload (the range button does it).

import { isPhoneTier } from '../phone-flags';
import { REGION } from './streamer';

/** the choices the range button steps through (cells a side) */
export const RANGES = [256, 320, 384] as const;
/** the phone tier's default (measured: docs/DEVLOG.md round 90, phonecam) */
export const PHONE_RANGE = 320;
/** every other tier's */
export const DESKTOP_RANGE = 256;
const KEY = 'reclaimed.atlasRange';

function stored(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v >= 256 && v % REGION === 0 ? v : null;
  } catch {
    return null;
  }
}

/** the window's side for this page */
export function atlasRange(q: URLSearchParams): number {
  const w = q.get('win');
  const W = w !== null ? Number(w) : (stored() ?? (isPhoneTier(q) ? PHONE_RANGE : DESKTOP_RANGE));
  if (!(W >= 256 && W % REGION === 0)) throw new Error(`?win= must be 256 or more, whole regions of ${REGION}`);
  return W;
}

/** the next choice after `w` (round the list) */
export function nextRange(w: number): number {
  const i = RANGES.findIndex((r) => r > w);
  return i < 0 ? RANGES[0] : RANGES[i];
}

/** Keep `w` as this viewer's choice and reload the level with it (the URL's ?win= set to it too). */
export function chooseRange(w: number): void {
  try {
    localStorage.setItem(KEY, String(w));
  } catch {
    // (private window, blocked storage: the URL carries it this time)
  }
  const q = new URLSearchParams(location.search);
  q.set('win', String(w));
  location.search = q.toString();
}
