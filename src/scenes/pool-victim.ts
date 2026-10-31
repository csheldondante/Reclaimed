// (merge122) The region pool's eviction choice, out of the Streamer so it is tested on its own (test/unit/pool-victim.test.ts).
// Round 104's rule: the least recently used of the regions more than a region and a half outside where the window is
// heading (the window's middle a second of the camera's motion on), else the farthest; never one a job is working on.
// merge122: never one a travel pinned (its destination window, kept until the warp there) — a full pool had evicted
// the destination while the run's journey waited for it, and the journey waited for ever.

export interface VictimQuery {
  /** a job is working on it, or a travel pinned it: never evicted */
  keep: (key: string) => boolean;
  /** where the window is heading, in regions (the window's middle a second on, a region's corner at 0) */
  centre: [number, number];
  /** half the window in regions plus the margin: past it on either axis is "outside" */
  near: [number, number];
  /** a wrapping world's size in regions (the distance the short way round) */
  wrap?: [number, number];
}

/** The region to evict from `keys` (in LRU order, oldest first; "rx,ry"), or null if none may go. */
export function poolVictim(keys: Iterable<string>, q: VictimQuery): string | null {
  const d1 = (d: number, n?: number) => (n ? Math.min(Math.abs(d) % n, n - (Math.abs(d) % n)) : Math.abs(d));
  let victim: string | null = null;
  let far = -1;
  for (const k of keys) {
    if (q.keep(k)) continue;
    const [rx, ry] = k.split(',').map(Number);
    const ax = d1(rx - q.centre[0], q.wrap?.[0]);
    const ay = d1(ry - q.centre[1], q.wrap?.[1]);
    // (LRU order: the first one outside is the oldest)
    if (ax > q.near[0] || ay > q.near[1]) return k;
    const d = Math.hypot(ax, ay);
    if (d > far) {
      far = d;
      victim = k;
    }
  }
  return victim;
}
