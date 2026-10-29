// Pointer/keyboard input → intent: the canvas's DOM events fed to the gesture classifier (gestures.ts, which
// has the mapping and knows nothing of the DOM), and a frame loop while a flick coasts.
// This module knows nothing about the game; it only classifies gestures.

import { Gestures, type ControlHandlers } from './gestures';

export type { ControlHandlers } from './gestures';

export class Controls {
  private g: Gestures;
  private abort = new AbortController();
  private raf = 0;

  dispose(): void {
    this.abort.abort();
    cancelAnimationFrame(this.raf);
  }

  /** stop a coasting flick (the scene took the camera) */
  stop(): void {
    this.g.stop();
  }

  constructor(el: HTMLElement, h: ControlHandlers) {
    const g = (this.g = new Gestures(h));
    const signal = this.abort.signal;
    const coast = () => {
      cancelAnimationFrame(this.raf);
      if (!g.coasting) return;
      const frame = (t: number) => {
        g.tick(t);
        if (g.coasting && !signal.aborted) this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    };
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      g.down({ id: e.pointerId, button: e.button, touch: e.pointerType === 'touch', x: e.clientX, y: e.clientY, t: e.timeStamp });
    }, { signal });
    el.addEventListener('pointermove', (e) => g.move(e.pointerId, e.clientX, e.clientY, e.timeStamp, e.pointerType === 'mouse'), { signal });
    const end = (e: PointerEvent) => {
      g.up(e.pointerId, e.clientX, e.clientY, e.timeStamp, e.type === 'pointercancel');
      coast();
    };
    el.addEventListener('pointerup', end, { signal });
    el.addEventListener('pointercancel', end, { signal });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        g.wheel(e.clientX, e.clientY, e.deltaY);
      },
      { passive: false, signal },
    );
  }
}
