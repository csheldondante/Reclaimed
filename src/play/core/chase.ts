// ---- play/core/chase.ts -----------------------------------------------------------------------------------------
// (round 120, PL20) The chase camera's framing at speed: where the screen's centre sits relative to the hero (a lead
// along its velocity) and how far out it zooms, from the hero's ChaseFraming (contracts/hero.ts). The user: "The bike
// was not really playable because of how zoomed in we are and how little notice for the gates."
//
// Why these choices (DEVLOG round 120):
// - The view is fitted in TIME, not cells: `ahead` seconds of travel kept on screen in front of the hero, so a faster
//   hero is framed wider just as much as it needs (and a desktop's big screen barely zooms out at all).
// - It's fitted against the screen's SHORTEST reach (min(W/2, H/2 ÷ the view's squash), less the HUD's margin), not the
//   way the hero is heading: on a loop course the heading turns all the time, and a zoom that followed it would pump.
//   Only speed moves the zoom, smoothed, and it eases out quicker than it comes back in.
// - The lead is an OFFSET from the hero, eased toward speed × lead (capped by a share of the reach so the hero stays
//   on screen), not a target the camera chases: a chased target lags v/follow behind (7-8 cells at the bike's top
//   speed), which ate most of the old look-ahead.
// Pure: Node tests (chase.test.ts) and the session share it.

import type { ChaseFraming } from '../../api/contracts/hero';

/** The framing every hero had before round 120 (session.ts CAM): a short lead, pulled back by `fast()`. */
export const DEFAULT_CHASE: ChaseFraming = { lead: 0.5, leadMax: 12, leadShare: 10, ahead: 0, minZoom: 4, back: 0.5, follow: 6, zoomOut: 2, zoomIn: 2, speedEase: 6 };

/** The screen as the framing sees it. */
export interface ChaseView {
  /** CSS px */
  w: number;
  h: number;
  /** what a cell along the ground looks like vertically on the screen, as a share of horizontally (sin of the view's elevation) */
  squash: number;
  /** px kept clear at each edge (the HUD: the banner, the stick) */
  margin: number;
  /** a ground step (cells) as it moves on the screen at zoom 1 (px); absent: the lead is capped by the worst direction's reach */
  screenOf?: (dx: number, dy: number) => [number, number];
}

/** px from the screen's centre to its nearest edge for a move along the ground in the worst direction, per px a cell (the zoom's unit) */
export function reach(v: ChaseView): number {
  return Math.max(1, Math.min(v.w / 2 - v.margin, (v.h / 2 - v.margin) / Math.max(v.squash, 1e-3)));
}

/** px from the centre to the nearest edge (less the margin) going along the ground direction (ux, uy), per px a cell */
export function reachAlong(v: ChaseView, ux: number, uy: number): number {
  if (!v.screenOf) return reach(v);
  const [sx, sy] = v.screenOf(ux, uy);
  const rx = Math.abs(sx) > 1e-6 ? (v.w / 2 - v.margin) / Math.abs(sx) : Infinity;
  const ry = Math.abs(sy) > 1e-6 ? (v.h / 2 - v.margin) / Math.abs(sy) : Infinity;
  return Math.max(1, Math.min(rx, ry));
}

/**
 * The zoom (px a cell) that keeps `f.ahead` seconds at `speed` on screen in front of the hero, given its lead (which
 * puts the hero behind the centre): the most zoomed-in z with lead(z) + R/z ≥ speed·ahead, where lead(z) =
 * min(speed·lead, leadMax, leadShare·R/z). Never wider than `base` (the hero's own zoom) nor wider than `minZoom`.
 */
export function fitZoom(f: ChaseFraming, base: number, speed: number, v: ChaseView): number {
  if (f.ahead <= 0 || speed <= 0) return base;
  const R = reach(v);
  const need = speed * f.ahead;
  const own = Math.min(speed * f.lead, f.leadMax);
  const a = need > own ? R / (need - own) : Infinity;
  const b = ((1 + f.leadShare) * R) / need;
  return Math.max(Math.min(f.minZoom, base), Math.min(base, a, b));
}

/**
 * The lead (cells, x y) for a velocity at this zoom: speed × lead along it, at most leadMax and leadShare of the reach
 * that way (a portrait phone leads further up the screen than across it).
 */
export function leadFor(f: ChaseFraming, vx: number, vy: number, zoom: number, v: ChaseView): [number, number] {
  const sp = Math.hypot(vx, vy);
  if (sp < 1e-6) return [0, 0];
  const l = Math.min(sp * f.lead, f.leadMax, (f.leadShare * reachAlong(v, vx / sp, vy / sp)) / zoom);
  return [(vx / sp) * l, (vy / sp) * l];
}

/** One hero's chase camera state: step it each frame with the hero's velocity; read `lead` and `zoom`. */
export class Chase {
  lead: [number, number] = [0, 0];
  zoom: number;
  /** the smoothed speed the zoom is fitted to (cells/s) */
  speed = 0;

  constructor(
    public f: ChaseFraming,
    public base: number,
  ) {
    this.zoom = base;
  }

  /** a new hero or a teleport: framed at once, at rest */
  reset(f: ChaseFraming, base: number): void {
    this.f = f;
    this.base = base;
    this.zoom = base;
    this.speed = 0;
    this.lead = [0, 0];
  }

  /** `fast`: the hero's 0..1 share of its top speed (the `back` pull) */
  step(dt: number, vx: number, vy: number, fast: number, v: ChaseView): void {
    const f = this.f;
    const sp = Math.hypot(vx, vy);
    this.speed += (sp - this.speed) * (1 - Math.exp(-f.speedEase * dt));
    const want = Math.min(this.base * (1 - f.back * fast), fitZoom(f, this.base, this.speed, v));
    const rate = want < this.zoom ? f.zoomOut : f.zoomIn;
    this.zoom += (want - this.zoom) * (1 - Math.exp(-rate * dt));
    const [lx, ly] = leadFor(f, vx, vy, this.zoom, v);
    const k = 1 - Math.exp(-f.follow * dt);
    this.lead[0] += (lx - this.lead[0]) * k;
    this.lead[1] += (ly - this.lead[1]) * k;
  }
}
