// (board) The camera and the touch: one finger drags, two pinch, a short touch with little movement is a tap; the mouse
// drags and its wheel zooms. Screen pixels are CSS pixels; the canvas is scaled by the device pixel ratio when drawn.
import { HH, HW } from './sprites';

export interface Camera {
  /** the world point at the screen's centre (world pixels) */
  x: number;
  y: number;
  zoom: number;
}

/** a tile's centre in world pixels */
export const tileXY = (x: number, y: number): [number, number] => [(x - y) * HW, (x + y) * HH];
/** world pixels → the tile under them (fractional) */
export const xyTile = (wx: number, wy: number): [number, number] => [(wx / HW + wy / HH) / 2, (wy / HH - wx / HW) / 2];

export function toScreen(c: Camera, w: number, h: number, wx: number, wy: number): [number, number] {
  return [(wx - c.x) * c.zoom + w / 2, (wy - c.y) * c.zoom + h / 2];
}
export function toWorld(c: Camera, w: number, h: number, sx: number, sy: number): [number, number] {
  return [(sx - w / 2) / c.zoom + c.x, (sy - h / 2) / c.zoom + c.y];
}

export interface Gestures {
  onTap(sx: number, sy: number): void;
  /** the camera moved by the player (pan or zoom); `pinchOut`: a pinch below the town's least zoom */
  onMove(pinchOut: boolean): void;
}

/** pointer handling on an element; `cam` is changed in place, kept within `limits` */
export function attachGestures(el: HTMLElement, cam: Camera, limits: () => { min: number; max: number; bounds: [number, number, number, number] }, g: Gestures): void {
  const pts = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  let pinch: { d: number; zoom: number; cx: number; cy: number } | null = null;
  let moved = false;
  const clamp = (): void => {
    const l = limits();
    cam.zoom = Math.max(l.min * 0.8, Math.min(l.max, cam.zoom));
    cam.x = Math.max(l.bounds[0], Math.min(l.bounds[2], cam.x));
    cam.y = Math.max(l.bounds[1], Math.min(l.bounds[3], cam.y));
  };
  const zoomAt = (sx: number, sy: number, z: number): void => {
    const r = el.getBoundingClientRect();
    const [wx, wy] = toWorld(cam, r.width, r.height, sx, sy);
    cam.zoom = z;
    const [wx2, wy2] = toWorld(cam, r.width, r.height, sx, sy);
    cam.x += wx - wx2;
    cam.y += wy - wy2;
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    pts.set(e.pointerId, { x, y, x0: x, y0: y, t0: performance.now() });
    if (pts.size === 1) moved = false;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      moved = true;
    }
  });
  el.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (pts.size === 1) {
      if (Math.hypot(x - p.x0, y - p.y0) > 8) moved = true;
      if (moved) {
        cam.x -= (x - p.x) / cam.zoom;
        cam.y -= (y - p.y) / cam.zoom;
        clamp();
        g.onMove(false);
      }
    }
    p.x = x;
    p.y = y;
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      zoomAt(pinch.cx, pinch.cy, pinch.zoom * (d / Math.max(1, pinch.d)));
      cam.x -= (cx - pinch.cx) / cam.zoom;
      cam.y -= (cy - pinch.cy) / cam.zoom;
      pinch.cx = cx;
      pinch.cy = cy;
      const out = cam.zoom < limits().min * 0.85;
      clamp();
      g.onMove(out);
    }
  });
  const up = (e: PointerEvent): void => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (p && !moved && pts.size === 0 && performance.now() - p.t0 < 600) g.onTap(p.x, p.y);
    if (pts.size === 0 && cam.zoom < limits().min) {
      cam.zoom = limits().min;
      g.onMove(false);
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const z = cam.zoom * Math.exp(-e.deltaY * 0.0015);
      const out = z < limits().min * 0.85 && e.deltaY > 0 && cam.zoom <= limits().min * 1.001;
      zoomAt(e.clientX - r.left, e.clientY - r.top, z);
      clamp();
      if (cam.zoom < limits().min) cam.zoom = limits().min;
      g.onMove(out);
    },
    { passive: false },
  );
}
