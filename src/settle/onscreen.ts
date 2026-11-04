// (round 128g, cityrender) Which settlements are drawn as pieces, and which are made ready — by the screen, not by a
// distance from the camera's point. The user: "This should only happen off screen we should prioritize and keep cached
// the city tiles". Pure (unit-tested: onscreen.test.ts).
//
// A settlement's box (window x, y and its z range) is projected with the camera's matrix; its `gap` is how far its
// projection lies off the screen, in screens (0: some of it is on screen). Then, with hysteresis so nothing flips back
// and forth at a threshold:
//   shown   drawn: gap <= SHOW, and kept drawn until gap > HIDE. A settlement on screen is always drawn (SHOW >= 0).
//   build   its pieces made (and uploaded) ahead of time: gap <= BUILD, the nearest first, a few a frame — those on
//           screen at once, whatever the budget.
//   drop    its pieces let go (GPU room given back) only well off screen: gap > DROP.

/** drawn from this many screens off (and on screen, always) */
export const SHOW = 0.35;
/** kept drawn until this many screens off */
export const HIDE = 0.75;
/** pieces made ahead from this many screens off */
export const BUILD = 1;
/** pieces let go past this many screens off */
export const DROP = 2;

/** A box in the window (x, y world units; z) */
export interface Box3 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
}

/**
 * How far the box's projection lies off the screen, in screens (the larger of the two axes' gaps; 0: on screen).
 * `viewProj` column-major, clip x, y in [-1, 1] on screen. A corner behind a perspective eye counts the box on screen.
 */
export function screenGap(viewProj: ArrayLike<number>, b: Box3): number {
  const m = viewProj;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? b.x1 : b.x0;
    const y = k & 2 ? b.y1 : b.y0;
    const z = k & 4 ? b.z1 : b.z0;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 1e-4)) return 0;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    x0 = Math.min(x0, cx);
    x1 = Math.max(x1, cx);
    y0 = Math.min(y0, cy);
    y1 = Math.max(y1, cy);
  }
  // (clip spans 2 a screen)
  const gx = Math.max(0, x0 - 1, -1 - x1) / 2;
  const gy = Math.max(0, y0 - 1, -1 - y1) / 2;
  return Math.max(gx, gy);
}

export interface ScreenEntry {
  id: string;
  gap: number;
  /** its pieces made and on the GPU */
  cached: boolean;
  /** drawn last frame */
  shown: boolean;
  /** its pieces on the GPU, fresh or not (absent: as `cached`) — what's let go */
  held?: boolean;
}

export interface ScreenPlan {
  /** to draw this frame (made first, if not cached: `build` holds them) */
  show: Set<string>;
  /** pieces to make this frame, in order (on screen first, then the nearest), at most `budget` beyond those needed now */
  build: string[];
  /** pieces to let go */
  drop: string[];
}

/** This frame's drawing: what's shown, what's made, what's let go (with hysteresis; see the header). */
export function planScreen(entries: ScreenEntry[], budget = 1): ScreenPlan {
  const show = new Set<string>();
  const need: string[] = [];
  const ahead: ScreenEntry[] = [];
  const drop: string[] = [];
  for (const e of entries) {
    const drawn = e.shown ? e.gap <= HIDE : e.gap <= SHOW;
    if (drawn) {
      show.add(e.id);
      if (!e.cached) need.push(e.id);
    } else if (!e.cached && e.gap <= BUILD) ahead.push(e);
    else if ((e.held ?? e.cached) && e.gap > DROP) drop.push(e.id);
  }
  ahead.sort((a, b) => a.gap - b.gap);
  return { show, build: [...need, ...ahead.slice(0, budget).map((e) => e.id)], drop };
}
