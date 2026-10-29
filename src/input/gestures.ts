// Pointer streams → intents, with no DOM (round 112; controls.ts feeds it the canvas's pointer events, the
// unit test scripts/gestureunit.mjs feeds it synthetic ones). The mapping (DECISIONS 2026-10-07, round 112):
//   LMB / one finger tap  → tap (two taps close together: also doubleTap)
//   LMB / one finger drag → the tool's gesture (dragStart says if it is one); on touch, falls back to pan
//   the pan tool (panTool() true) → a primary-button / one-finger drag pans, 1:1 under the finger
//   RMB drag → pan        MMB drag → zoom        wheel → zoom
//   two fingers → a pan, or a pinch once the spread has clearly changed more than the fingers have moved
//     together (TwoFinger); the gesture stays what it was decided as until a finger lifts. A finger that took
//     part in one only pans until it lifts (no tap, no gust from where it first landed)
//   a touch pan let go while moving coasts on (a flick), slowing down; any new press stops it
//   hover (mouse, nothing pressed) → hover
// Pans are screen deltas (CSS px, the content follows the finger): the level turns them into world motion
// (camera.panScreen), which keeps the ground point under the finger exactly.

export interface ControlHandlers {
  tap(sx: number, sy: number): void;
  /** a second tap close to the first, soon after it (the tap itself was reported too) */
  doubleTap?(sx: number, sy: number): void;
  /** Return true if a drag starting here is a gesture; false lets it pan (touch) or be ignored. */
  dragStart(sx: number, sy: number): boolean;
  dragMove(sx: number, sy: number): void;
  dragEnd(sx: number, sy: number): void;
  hover(sx: number, sy: number): void;
  pan(dx: number, dy: number): void;
  zoomAt(sx: number, sy: number, factor: number): void;
  /** the pan tool is selected: a primary drag pans instead of being the tool's gesture */
  panTool?(): boolean;
}

export const TAP_SLOP = 6;
/** a double tap: the second within this long (ms) and this near (px) of the first */
export const DOUBLE_MS = 320;
export const DOUBLE_PX = 40;
/** two fingers: a pinch once the spread changed this much (px) and more than the centre moved */
export const PINCH_MIN = 20;
/** two fingers: a pan once the centre moved this much (px) and more than the spread changed */
export const PAN_MIN = 10;
/** a flick: the speed (px/ms) over the last FLICK_WINDOW ms of the pan; below FLICK_MIN no coast */
export const FLICK_WINDOW = 100;
export const FLICK_MIN = 0.25;
export const FLICK_MAX = 5;
/** a finger held still this long (ms) before it lifts: no coast */
export const FLICK_STILL = 60;
/** the coast's speed falls by e every FLICK_TAU ms; it stops below FLICK_STOP px/ms */
export const FLICK_TAU = 325;
export const FLICK_STOP = 0.02;

export type TwoMode = 'undecided' | 'pan' | 'pinch';

/**
 * Two fingers: decides once per gesture whether it is a pan or a pinch, then reports per move how far the
 * centre moved (always: a pinch keeps the ground under its centre as well) and the zoom factor (pinch only).
 * The hero's touch pad uses it too (zoom only).
 */
export class TwoFinger {
  mode: TwoMode = 'undecided';
  private c0: [number, number];
  private d0: number;
  private c: [number, number];
  private d: number;

  constructor(a: [number, number], b: [number, number]) {
    this.c0 = this.c = mid(a, b);
    this.d0 = this.d = spread(a, b);
  }

  /** the fingers moved: the centre's move (px) and the zoom factor about the centre (1 unless a pinch) */
  move(a: [number, number], b: [number, number]): { centre: [number, number]; dx: number; dy: number; zoom: number } {
    const c = mid(a, b);
    const d = spread(a, b);
    const dx = c[0] - this.c[0];
    const dy = c[1] - this.c[1];
    let zoom = 1;
    if (this.mode === 'undecided') {
      const ds = Math.abs(d - this.d0);
      const dc = Math.hypot(c[0] - this.c0[0], c[1] - this.c0[1]);
      if (ds >= PINCH_MIN && ds > dc) {
        this.mode = 'pinch';
        // (the spread's change so far, at once: the pinch stays anchored to where it began)
        zoom = d / this.d0;
      } else if (dc >= PAN_MIN && dc >= ds) this.mode = 'pan';
    } else if (this.mode === 'pinch') zoom = d / this.d;
    this.c = c;
    this.d = d;
    return { centre: c, dx, dy, zoom };
  }
}

const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const spread = (a: [number, number], b: [number, number]) => Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));

export interface PointerIn {
  id: number;
  /** 0 primary, 1 middle, 2 right */
  button: number;
  touch: boolean;
  x: number;
  y: number;
  /** ms (event.timeStamp) */
  t: number;
}

interface Press {
  id: number;
  button: number;
  touch: boolean;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
  gesture: boolean;
  panning: boolean;
  /** was part of a two-finger pan/pinch: never a tap or a gesture */
  multi: boolean;
}

export class Gestures {
  private presses = new Map<number, Press>();
  private two: { a: number; b: number; g: TwoFinger } | null = null;
  /** this touch pan's cumulative screen motion over time (for the flick) */
  private trail: { t: number; x: number; y: number }[] = [];
  private panned: [number, number] = [0, 0];
  /** this touch sequence zoomed (no flick after it) */
  private pinched = false;
  private lastTap: { x: number; y: number; t: number } | null = null;
  /** the coast after a flick (px/ms), and when it last moved */
  private fling: { vx: number; vy: number; t: number } | null = null;

  private h: ControlHandlers;

  constructor(h: ControlHandlers) {
    this.h = h;
  }

  /** a flick is coasting: the caller should call tick() each frame */
  get coasting(): boolean {
    return this.fling !== null;
  }

  /** the two-finger gesture's mode (tests, the HUD) */
  get twoMode(): TwoMode | null {
    return this.two?.g.mode ?? null;
  }

  down(e: PointerIn): void {
    const h = this.h;
    this.fling = null;
    const p: Press = { id: e.id, button: e.button, touch: e.touch, x0: e.x, y0: e.y, x: e.x, y: e.y, moved: false, gesture: false, panning: false, multi: false };
    this.presses.set(e.id, p);
    const touches = this.touches();
    if (touches.length === 1 && p.touch) this.startTrail(e.t);
    if (touches.length >= 2) {
      this.resetTwo();
      // a second finger cancels any one-finger gesture; the fingers now pan or pinch, and keep panning one at
      // a time until they lift
      for (const t of touches) if (t.gesture) h.dragEnd(t.x, t.y);
      for (const t of touches) {
        t.gesture = false;
        t.multi = t.panning = t.moved = true;
      }
    }
  }

  move(id: number, x: number, y: number, t: number, mouse = false): void {
    const h = this.h;
    const p = this.presses.get(id);
    if (!p) {
      if (mouse) h.hover(x, y);
      return;
    }
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    if (mouse) h.hover(x, y);
    const two = this.two;
    if (two && (id === two.a || id === two.b)) {
      const a = this.presses.get(two.a)!;
      const b = this.presses.get(two.b)!;
      const m = two.g.move([a.x, a.y], [b.x, b.y]);
      this.pan(m.dx, m.dy, t);
      if (two.g.mode === 'pinch') this.pinched = true;
      if (m.zoom !== 1) h.zoomAt(m.centre[0], m.centre[1], m.zoom);
      return;
    }
    // (a third finger: ignored)
    if (this.two) return;
    if (!p.moved && Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_SLOP) {
      p.moved = true;
      if (p.button === 0) {
        if (this.h.panTool?.()) p.panning = true;
        else {
          p.gesture = h.dragStart(p.x0, p.y0);
          p.panning = !p.gesture && p.touch;
        }
      }
      // (a pan starts with the motion since the press: what was under the finger stays under it)
      if (p.button === 2 || p.panning) return this.pan(p.x - p.x0, p.y - p.y0, t, p.touch);
    }
    if (!p.moved) return;
    if (p.button === 2 || p.panning) this.pan(dx, dy, t, p.touch);
    else if (p.button === 1) h.zoomAt(p.x0, p.y0, Math.exp(-dy * 0.01));
    else if (p.gesture) h.dragMove(p.x, p.y);
  }

  up(id: number, x: number, y: number, t: number, cancel = false): void {
    const h = this.h;
    const p = this.presses.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    this.presses.delete(id);
    // (a two-finger gesture ends with either finger; another pair is measured afresh)
    if (this.two && (id === this.two.a || id === this.two.b)) this.resetTwo();
    // the last finger of a touch pan lifts while moving: a flick (not after a pinch)
    if (p.touch && this.touches().length === 0 && (p.panning || p.multi) && !this.pinched && !cancel) this.flick(t);
    if (cancel) {
      if (p.gesture) h.dragEnd(p.x, p.y);
      return;
    }
    if (p.button !== 0 || p.multi) return;
    if (!p.moved) {
      h.tap(p.x, p.y);
      const l = this.lastTap;
      if (l && t - l.t <= DOUBLE_MS && Math.hypot(p.x - l.x, p.y - l.y) <= DOUBLE_PX) {
        this.lastTap = null;
        h.doubleTap?.(p.x, p.y);
      } else this.lastTap = { x: p.x, y: p.y, t };
    } else if (p.gesture) h.dragEnd(p.x, p.y);
  }

  wheel(x: number, y: number, deltaY: number): void {
    this.fling = null;
    this.h.zoomAt(x, y, Math.exp(-deltaY * 0.0015));
  }

  /** a frame (ms): a coasting flick moves on */
  tick(t: number): void {
    const f = this.fling;
    if (!f) return;
    const dt = Math.min(64, t - f.t);
    if (dt <= 0) return;
    this.h.pan(f.vx * dt, f.vy * dt);
    const k = Math.exp(-dt / FLICK_TAU);
    f.vx *= k;
    f.vy *= k;
    f.t = t;
    if (Math.hypot(f.vx, f.vy) < FLICK_STOP) this.fling = null;
  }

  /** stop any coast (the scene took the camera) */
  stop(): void {
    this.fling = null;
  }

  private pan(dx: number, dy: number, t: number, touch = true): void {
    if (dx === 0 && dy === 0) return;
    this.h.pan(dx, dy);
    if (!touch) return;
    this.panned = [this.panned[0] + dx, this.panned[1] + dy];
    this.trail.push({ t, x: this.panned[0], y: this.panned[1] });
    while (this.trail.length > 2 && this.trail[1].t < t - FLICK_WINDOW) this.trail.shift();
  }

  private startTrail(t: number): void {
    this.panned = [0, 0];
    this.pinched = false;
    this.trail = [{ t, x: 0, y: 0 }];
  }

  private flick(t: number): void {
    const tr = this.trail;
    if (tr.length < 2) return;
    const last = tr[tr.length - 1];
    if (t - last.t > FLICK_STILL) return;
    // (the oldest sample inside the window, or the one just before it)
    let i = 0;
    while (i < tr.length - 2 && tr[i + 1].t <= t - FLICK_WINDOW) i++;
    const first = tr[i];
    const span = Math.max(8, last.t - first.t);
    let vx = (last.x - first.x) / span;
    let vy = (last.y - first.y) / span;
    const v = Math.hypot(vx, vy);
    if (v < FLICK_MIN) return;
    if (v > FLICK_MAX) [vx, vy] = [(vx * FLICK_MAX) / v, (vy * FLICK_MAX) / v];
    this.fling = { vx, vy, t };
  }

  private resetTwo(): void {
    const t = this.touches();
    if (t.length >= 2) this.two = { a: t[0].id, b: t[1].id, g: new TwoFinger([t[0].x, t[0].y], [t[1].x, t[1].y]) };
    else this.two = null;
  }

  private touches(): Press[] {
    return [...this.presses.values()].filter((p) => p.touch);
  }
}
