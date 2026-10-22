// Pointer/keyboard input → intent (DECISIONS 2026-10-07):
//   LMB tap   → interact with whatever is under the cursor
//   LMB drag  → gesture (gust beneath a storm); on touch, falls back to pan
//   RMB drag  → pan        MMB drag → zoom        wheel / pinch → zoom
//   two fingers → pan and pinch; a finger that took part in one only pans
//   until it lifts (no tap, no gust from where it first landed)
//   hover     → cursor breeze
// This module knows nothing about the game; it only classifies gestures.

export interface ControlHandlers {
  tap(sx: number, sy: number): void;
  /** Return true if a drag starting here is a gesture; false lets it pan (touch) or be ignored. */
  dragStart(sx: number, sy: number): boolean;
  dragMove(sx: number, sy: number): void;
  dragEnd(sx: number, sy: number): void;
  hover(sx: number, sy: number): void;
  pan(dx: number, dy: number): void;
  zoomAt(sx: number, sy: number, factor: number): void;
}

const TAP_SLOP = 6;

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

export class Controls {
  private presses = new Map<number, Press>();
  private pinch = 0;
  private abort = new AbortController();

  dispose(): void {
    this.abort.abort();
  }

  constructor(el: HTMLElement, h: ControlHandlers) {
    const signal = this.abort.signal;
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      const p: Press = {
        id: e.pointerId,
        button: e.button,
        touch: e.pointerType === 'touch',
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        moved: false,
        gesture: false,
        panning: false,
        multi: false,
      };
      this.presses.set(e.pointerId, p);
      if (this.touches().length >= 2) {
        this.resetPinch();
        // a second finger cancels any one-finger gesture; the fingers now pan
        // and pinch, and keep panning one at a time until they lift
        for (const t of this.touches()) if (t.gesture) h.dragEnd(t.x, t.y);
        for (const t of this.touches()) {
          t.gesture = false;
          t.multi = t.panning = t.moved = true;
        }
      }
    }, { signal });
    el.addEventListener('pointermove', (e) => {
      const p = this.presses.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') h.hover(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (e.pointerType === 'mouse') h.hover(p.x, p.y);
      const touches = this.touches();
      if (touches.length >= 2) {
        const [a, b] = touches;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch > 0) h.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.pinch);
        this.pinch = d;
        h.pan(dx / 2, dy / 2);
        return;
      }
      if (!p.moved && Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_SLOP) {
        p.moved = true;
        if (p.button === 0) {
          p.gesture = h.dragStart(p.x0, p.y0);
          p.panning = !p.gesture && p.touch;
        }
      }
      if (!p.moved) return;
      if (p.button === 2 || p.panning) h.pan(dx, dy);
      else if (p.button === 1) h.zoomAt(p.x0, p.y0, Math.exp(-dy * 0.01));
      else if (p.gesture) h.dragMove(p.x, p.y);
    }, { signal });
    const end = (e: PointerEvent) => {
      const p = this.presses.get(e.pointerId);
      if (!p) return;
      this.presses.delete(e.pointerId);
      // (the pinch's span measured afresh from the fingers still down)
      this.resetPinch();
      if (e.type === 'pointercancel') {
        if (p.gesture) h.dragEnd(p.x, p.y);
        return;
      }
      if (p.button !== 0 || p.multi) return;
      if (!p.moved) h.tap(p.x, p.y);
      else if (p.gesture) h.dragEnd(p.x, p.y);
    };
    el.addEventListener('pointerup', end, { signal });
    el.addEventListener('pointercancel', end, { signal });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        h.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false, signal },
    );
  }

  private resetPinch(): void {
    const t = this.touches();
    this.pinch = t.length >= 2 ? Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y) : 0;
  }

  private touches(): Press[] {
    return [...this.presses.values()].filter((p) => p.touch);
  }
}
