// (round 128m, townlab; onetown: the town's site box) What the window keeps (Streamer.keep; the town's box, docs/ARCHITECTURE.md "The window
// keeps the town"): a rectangle of world columns that every slide leaves inside the window. Found on the user's link: the
// fortress's box ran 14 rows past the window's bottom edge at the start, and a pan of ~150 m slid the window off part
// of it — the reach (fortreach.wgsl) sees no ground outside the window, so whole sides of the town read "A cliff or a
// building is in the way", every placement once the stores left it. The reach, the builders and the claims all live in
// the window; what they need must stay in it. Pure.

/** world columns x0 ≤ x < x1, rows y0 ≤ y < y1 */
export interface KeepRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** whether a window at `origin` (world columns, rows), W x H, holds the rect */
export function keepHeld(origin: readonly [number, number], W: number, H: number, k: KeepRect): boolean {
  return k.x0 >= origin[0] && k.y0 >= origin[1] && k.x1 <= origin[0] + W && k.y1 <= origin[1] + H;
}

/** whether a slide of (dx, dy) keeps it (no rect: any) */
export function keepAllows(origin: readonly [number, number], W: number, H: number, k: KeepRect | null, dx: number, dy: number): boolean {
  return !k || keepHeld([origin[0] + dx, origin[1] + dy], W, H, k);
}

/**
 * (onetown) Where a W x H window opens so it holds the rect: as near `want` (its origin) as it can. The rect is a town's
 * site box (whole regions: settle/records.ts), so with a region-aligned `want` the origin stays whole regions. Throws when
 * the rect is bigger than the window: the window is opened at least the box's size (scenes/level.ts), never half over it.
 */
export function windowHolding(k: KeepRect, W: number, H: number, want: readonly [number, number]): [number, number] {
  if (k.x1 - k.x0 > W || k.y1 - k.y0 > H) throw new Error(`the town's box (${k.x1 - k.x0} x ${k.y1 - k.y0}) doesn't fit in the window (${W} x ${H})`);
  return [Math.max(k.x1 - W, Math.min(k.x0, want[0])), Math.max(k.y1 - H, Math.min(k.y0, want[1]))];
}
