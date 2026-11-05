// (round 128m, townlab) What the window keeps (Streamer.keep; the fortress's box, docs/ARCHITECTURE.md "The window
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
 * The fortress's box in a window: where its first column and row go so the box and `margin` round it lie in the window
 * (the window's origin, size), as near `want` as they can; its row even (the lattice's odd rows shift the same in the
 * box and the window). Throws when the box and its margin are bigger than the window: a loud error at setup, never a
 * box half out of it.
 */
export function boxInWindow(want: readonly [number, number], box: { w: number; h: number }, margin: number, origin: readonly [number, number], W: number, H: number): [number, number] {
  if (box.w + 2 * margin > W || box.h + 2 * margin > H)
    throw new Error(`the fortress's land (${box.w} x ${box.h} and ${margin} round it) doesn't fit in the window (${W} x ${H}): the window must be at least ${Math.ceil((Math.max(box.w, box.h) + 2 * margin) / 64) * 64} a side (?win=)`);
  const lo = (o: number) => o + margin;
  const x = Math.max(lo(origin[0]), Math.min(origin[0] + W - margin - box.w, want[0]));
  const yLo = lo(origin[1]);
  const yHi = origin[1] + H - margin - box.h;
  let y = Math.max(yLo, Math.min(yHi, want[1]));
  // (even: down, else up, within the range)
  if (y % 2) y = y - 1 >= yLo ? y - 1 : y + 1;
  if (y > yHi) throw new Error(`the fortress's land can't lie on an even row in the window (rows ${yLo}..${yHi})`);
  return [x, y];
}
