// Camera director (DECISIONS round 9): limits on pan/zoom, smooth camera
// shots, and a step-by-step script for the diegetic first-play intro.
// It only drives the camera and *simulates the player* through Powers and
// Globals events (scripted taps and strokes) — it never touches simulation
// internals. Any step can be skipped with Esc (`cancel`).

import type { Camera } from '../render/camera';

export interface CameraLimits {
  minZoom: number;
  maxZoom: number;
  /** allowed camera target box (world cells): x0, y0, x1, y1 */
  bounds: [number, number, number, number];
}

interface Shot {
  from: { x: number; y: number; zoom: number };
  to: { x: number; y: number; zoom: number };
  t: number;
  dur: number;
  done: () => void;
}

const ease = (t: number) => t * t * (3 - 2 * t);

export class Director {
  /** pan/zoom limits while the script (or a scene) wants them; undefined = free */
  limits?: CameraLimits;
  /** true while a shot is flying the camera (user pan/zoom is overridden) */
  get flying(): boolean {
    return !!this.shot;
  }
  private shot?: Shot;
  private waits: { pred: () => boolean; until: number; done: (ok: boolean) => void }[] = [];
  private clock = 0;
  cancelled = false;

  constructor(private camera: Camera) {}

  /** Per frame: fly the current shot, resolve waits, then apply the limits. */
  update(dt: number): void {
    this.clock += dt;
    const s = this.shot;
    const cam = this.camera;
    if (s) {
      s.t += dt;
      const k = ease(Math.min(1, s.t / s.dur));
      cam.target[0] = s.from.x + (s.to.x - s.from.x) * k;
      cam.target[1] = s.from.y + (s.to.y - s.from.y) * k;
      // zoom eases in log space so wide → close feels even
      cam.zoom = Math.exp(Math.log(s.from.zoom) + (Math.log(s.to.zoom) - Math.log(s.from.zoom)) * k);
      if (s.t >= s.dur) {
        this.shot = undefined;
        s.done();
      }
    }
    for (const w of [...this.waits]) {
      const ok = w.pred();
      if (ok || this.clock >= w.until || this.cancelled) {
        this.waits.splice(this.waits.indexOf(w), 1);
        w.done(ok);
      }
    }
    const l = this.limits;
    if (l && !this.shot) {
      cam.zoom = Math.max(l.minZoom, Math.min(l.maxZoom, cam.zoom));
      cam.target[0] = Math.max(l.bounds[0], Math.min(l.bounds[2], cam.target[0]));
      cam.target[1] = Math.max(l.bounds[1], Math.min(l.bounds[3], cam.target[1]));
    }
  }

  /**
   * Fly the camera to (x, y) at `zoom` over `seconds` (resolves on arrival,
   * or at once if cancelled). The flight owns the view: old limits are
   * dropped (they would snap the camera back on landing) — set new ones after.
   */
  fly(x: number, y: number, zoom: number, seconds: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    const cam = this.camera;
    this.limits = undefined;
    return new Promise((done) => {
      this.shot = { from: { x: cam.target[0], y: cam.target[1], zoom: cam.zoom }, to: { x, y, zoom }, t: 0, dur: seconds, done };
    });
  }

  /** Wait `seconds` of real time (or until cancelled). */
  hold(seconds: number): Promise<void> {
    return this.waitFor(() => false, seconds).then(() => undefined);
  }

  /** Wait until `pred()` holds (true) or `seconds` pass / the script is cancelled (false). */
  waitFor(pred: () => boolean, seconds: number): Promise<boolean> {
    if (this.cancelled) return Promise.resolve(false);
    return new Promise((done) => this.waits.push({ pred, until: this.clock + seconds, done }));
  }

  /** Lock the view where it is (no pan, no zoom). */
  lock(): void {
    const c = this.camera;
    this.limits = { minZoom: c.zoom, maxZoom: c.zoom, bounds: [c.target[0], c.target[1], c.target[0], c.target[1]] };
  }

  /** Let the player look around a box with a zoom range. */
  confine(cx: number, cy: number, halfBox: number, minZoom: number, maxZoom: number): void {
    this.limits = { minZoom, maxZoom, bounds: [cx - halfBox, cy - halfBox, cx + halfBox, cy + halfBox] };
  }

  free(): void {
    this.limits = undefined;
  }

  /** Stop the script: the camera is the player's again. */
  cancel(): void {
    this.cancelled = true;
    if (this.shot) {
      const s = this.shot;
      this.shot = undefined;
      s.done();
    }
    this.limits = undefined;
  }
}
