// ---- present/stand.ts -------------------------------------------------------------------------------------------
// (round 124, `presentation`; PRE1) Scene A's place: the densest birch stand near a point (the plants' trees as the
// draw stands them: api/plants.ts treesNear, the CPU's port of vegplan.wgsl), and a repeatable ride through it — a
// loop whose near side runs through the stand, so each lap rides in from the open, under the birches and out again.
// Pure but for the trees given.

import type { V2 } from '../api/contracts/camera';
import type { AutoPath } from '../play/lab/autopilot';

export interface TreeLike {
  x: number;
  y: number;
  species: string;
}

/** fewer birches than this within the stand's radius: no stand (an error, not a quiet stand-in) */
export const MIN_BIRCHES = 12;
/** the stand's radius (cells) its birches are counted in */
export const STAND_R = 12;

/** the densest birch stand among `trees`: its centre and how many birches are within STAND_R of it */
export function densestStand(trees: readonly TreeLike[]): { at: V2; birches: number } | null {
  const b = trees.filter((t) => t.species === 'birch');
  if (!b.length) return null;
  let best: { at: V2; birches: number } | null = null;
  // (candidates: the birches themselves; a stand's centre is near one)
  for (const c of b) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const t of b)
      if (Math.hypot(t.x - c.x, t.y - c.y) <= STAND_R) {
        n++;
        sx += t.x;
        sy += t.y;
      }
    if (!best || n > best.birches) best = { at: [sx / n, sy / n], birches: n };
  }
  return best;
}

/** the densest stand within `radius` of `at`; throws when there is none (the scene needs its birches) */
export function birchStand(plants: { treesNear(x: number, y: number, r: number): TreeLike[] }, at: V2, radius: number): { at: V2; birches: number } {
  const s = densestStand(plants.treesNear(at[0], at[1], radius));
  if (!s || s.birches < MIN_BIRCHES) throw new Error(`present=forest: no birch stand within ${radius} cells (best ${s?.birches ?? 0} birches; need ${MIN_BIRCHES}). Start nearer one: &at=13728,4768 is the flora showcase`);
  return s;
}

/**
 * A closed ride through the stand: a loop of radius `r` round a centre `off` cells from the stand, so its near side
 * passes through the stand's middle. The side is the one whose loop has the most rideable points (`ok`). Slower under
 * the trees (a speed share of 0.55; the walker's pace, the scene's default hero), full in the open.
 */
export function standRoute(stand: V2, ok: (x: number, y: number) => boolean, r = 20, off = 17, n = 48): AutoPath[] {
  let best: { pts: AutoPath[]; good: number } | null = null;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const c: V2 = [stand[0] + Math.cos(a) * off, stand[1] + Math.sin(a) * off];
    // (starting on the far side from the stand: the first thing the ride does is come in)
    const a0 = a;
    const pts: AutoPath[] = [];
    let good = 0;
    for (let i = 0; i < n; i++) {
      const t = a0 + (i / n) * Math.PI * 2;
      const p: V2 = [c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r];
      const inStand = Math.hypot(p[0] - stand[0], p[1] - stand[1]) < 18;
      if (ok(p[0], p[1])) good++;
      pts.push({ at: p, speed: inStand ? 0.55 : 1 });
    }
    if (!best || good > best.good) best = { pts, good };
  }
  return best!.pts;
}

/** the route's point to start a ride from: `before` cells (straight-line) out from the stand, on the way in */
export function rideStart(route: readonly AutoPath[], stand: V2, before: number): number {
  const d = route.map((p) => Math.hypot(p.at[0] - stand[0], p.at[1] - stand[1]));
  const n = route.length;
  let m = 0;
  for (let i = 1; i < n; i++) if (d[i] < d[m]) m = i;
  // (walked back from the nearest point until it's `before` out)
  for (let k = 1; k < n; k++) {
    const i = (m - k + n) % n;
    if (d[i] >= before) return i;
  }
  return 0;
}
