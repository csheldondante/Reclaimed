// ---- story/camera.ts -----------------------------------------------------------
// Story cameras (round 83, docs/SYSTEMS.md system 5): a small director over the fixed camera, to show what's
// going on — frame a speaker for a talk, reveal a place or a world effect, follow the player.
// - `frame(at)`: ease the target and zoom to a point (placed on screen where `place` says: above a dialog
//   panel by default), hold until `release()`, then ease back to where the player had the view.
// - `reveal(at)`: ease there, hold a few seconds, ease back. Queued behind a held frame: a reveal a dialog
//   choice set off runs once the talk ends, from the speaker, without going home in between.
// - `follow(get)`: while no shot is running, the target slides after a moving point (a spring, not a lock).
// Every move starts from where the camera is, so a new shot or `skip()` mid-ease is continuous; zoom eases in
// log space (wide to close feels even). Phone-friendly: short eases (under a second), no input needed.
// The cutaway: while a shot holds a point it's kept seen — Dither.see (what's in front dithered round it) and,
// given a Slice, the slice cut over it when it's under a roof; afterwards the slice is let back up.
//
//   const cam = new StoryCamera(core.camera, { dither, slice })
//   await cam.frame([x, y, z]); …; await cam.release()
//   await cam.reveal([x, y, z], { hold: 3 })
//   each frame: cam.update(dt)     // `busy`: a shot owns the view (the game holds its pan and zoom)

import type { Camera } from '../render/camera';
import type { Dither, Slice } from '../api/cutaway';

export type V3 = [number, number, number];

export interface ShotOpts {
  /** screen px a world unit at the shot (default: 14 framing, 9 a reveal) */
  zoom?: number;
  /** seconds to get there (default 0.9 framing, 1.2 a reveal) */
  ease?: number;
  /** where on the screen the point sits, as fractions of its width and height (default the middle; framing: [0.5, 0.32], over a dialog panel) */
  place?: [number, number];
}

interface Move {
  from: { t: V3; zoom: number };
  to: { t: V3; zoom: number };
  t: number;
  dur: number;
  done: () => void;
}

const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export class StoryCamera {
  /** the dither point's id (Dither.see) */
  static SEEN = 'story';
  private move: Move | null = null;
  /** where the player had the view before the first shot (eased back to when they're all done) */
  private home: { t: V3; zoom: number } | null = null;
  /** the point a shot holds (kept seen) */
  private focus: V3 | null = null;
  private held = false;
  /** shots waiting (a reveal behind a held frame, a frame behind a look), first in first out. `frame`: a frame's
   *  entry, with what settles its promise if it is taken out before it begins (`release`) */
  private queue: { start: () => void; frame?: () => void }[] = [];
  /** the hold being waited out (skip() ends it) */
  private holding: { left: number; done: () => void } | null = null;
  private following: (() => V3 | null) | null = null;
  /** the follow spring's rate (1/s) */
  followRate = 4;
  /** the slice is being let back up after a shot */
  private lifting = false;

  constructor(
    private camera: Camera,
    private cut: { dither?: Dither; slice?: Slice } = {},
  ) {}

  /** A shot owns the view: the game holds its own pan and zoom. */
  get busy(): boolean {
    return this.move !== null || this.engaged;
  }

  /** a shot is under way, not counting the ease home (a new shot cuts that short rather than waiting) */
  private get engaged(): boolean {
    return this.taken || (this.move !== null && !this.returning) || this.held || this.holding !== null || this.queue.length > 0;
  }
  private returning = false;
  /** a look or a reveal has been given the view and has not begun its move yet (it begins a step later: the view is
   *  taken meanwhile, or a second shot sent in the same step would begin with it and the two would fight; LS-54) */
  private taken = false;

  /**
   * Ease to `at` and hold there until `release()`. Resolves on arrival, or when it is released while still waiting
   * behind another shot (it then never takes the view). The hold begins in the same step as the frame does, so a
   * release can never fall between the two.
   */
  frame(at: V3, opts: ShotOpts = {}): Promise<void> {
    return new Promise((arrived) => {
      const begin = () => {
        this.saveHome();
        this.held = true;
        void this.go(at, { zoom: 14, ease: 0.9, place: [0.5, 0.32], ...opts }).then(arrived);
      };
      if (!this.engaged) begin();
      else this.queue.push({ start: begin, frame: arrived });
    });
  }

  /**
   * Let go of a frame. One that holds the view: back to the player's view (or straight on to the shot waiting). One
   * still waiting in the queue (BACKLOG LS-54: a dialog answered before the camera got to it): taken out of the queue,
   * the shots behind it move up. No frame held or waiting: nothing.
   */
  release(seconds = 0.8): Promise<void> {
    if (this.held) {
      this.held = false;
      return this.next(seconds);
    }
    const k = this.queue.findIndex((q) => q.frame);
    if (k >= 0) this.queue.splice(k, 1)[0].frame!();
    return Promise.resolve();
  }

  /** Ease to `at`, hold `hold` seconds (skip() cuts it short), ease back. Resolves when the view is back. */
  async reveal(at: V3, opts: ShotOpts & { hold?: number } = {}): Promise<void> {
    await this.take();
    await this.go(at, { zoom: 9, ease: 1.2, ...opts });
    await new Promise<void>((done) => (this.holding = { left: opts.hold ?? 2.5, done }));
    this.holding = null;
    await this.next(opts.ease ?? 1.2);
  }

  /** Ease to `at` and leave the view there, the player's again (an opening shot; nothing to go back to). */
  async look(at: V3, opts: ShotOpts = {}): Promise<void> {
    await this.take();
    await this.go(at, { zoom: 8, ease: 1.5, ...opts });
    this.focus = null;
    // (the shot waiting behind it starts from here, and here is the view it goes back to; before LS-54 a look never
    // started the next one: a second look, or a frame, sent while one was under way waited for good)
    const n = this.queue.shift();
    if (n) {
      this.home = null;
      n.start();
    } else if (!this.engaged) this.home = null;
  }

  /** Cut a reveal's hold short (a tap): the camera goes on at once. */
  skip(): void {
    this.holding?.done();
  }

  /** While no shot runs, slide after this point (null: stop following). */
  follow(get: (() => V3 | null) | null): void {
    this.following = get;
  }

  /** Resolves once no shot has the view (now, if none does). */
  idle(): Promise<void> {
    return this.busy ? new Promise((done) => this.idlers.push(done)) : Promise.resolve();
  }
  private idlers: (() => void)[] = [];

  /**
   * (loop-skeleton) The streamed window slid: everything a shot keeps in window coordinates moves by (−dx, −dy, −dz), as
   * the camera's own target does (Camera.shift; WorldCore.onShift). Without it a move under way kept easing to where
   * its target used to be, which slid the window again: the view ran away from the town.
   */
  shift(dx: number, dy: number, dz: number): void {
    const mv = (p: V3 | null | undefined) => {
      if (!p) return;
      p[0] -= dx;
      p[1] -= dy;
      p[2] -= dz;
    };
    mv(this.move?.from.t);
    mv(this.move?.to.t);
    mv(this.home?.t);
    mv(this.focus);
  }

  /** Each frame, before drawing. */
  update(dt: number): void {
    const cam = this.camera;
    const m = this.move;
    if (m) {
      m.t += dt;
      const k = ease(Math.min(1, m.t / m.dur));
      for (let i = 0; i < 3; i++) cam.target[i] = m.from.t[i] + (m.to.t[i] - m.from.t[i]) * k;
      cam.zoom = Math.exp(Math.log(m.from.zoom) + (Math.log(m.to.zoom) - Math.log(m.from.zoom)) * k);
      if (m.t >= m.dur) {
        this.move = null;
        m.done();
      }
    } else if (this.holding) {
      this.holding.left -= dt;
      if (this.holding.left <= 0) this.holding.done();
    } else if (!this.busy && this.following) {
      const p = this.following();
      if (p) {
        const k = 1 - Math.exp(-this.followRate * dt);
        for (let i = 0; i < 3; i++) cam.target[i] += (p[i] - cam.target[i]) * k;
      }
    }
    if (!this.busy && this.idlers.length) for (const f of this.idlers.splice(0)) f();
    const { dither, slice } = this.cut;
    // (loop round 17, LS-152: a point followed — the messenger walking in — is kept seen as a held one is)
    const f = this.focus ?? (!this.busy && this.following ? this.following() : null);
    if (f) {
      // (a followed point's slice is let back up once the follow ends)
      if (!this.focus) this.lifting = !!slice;
      dither?.see(StoryCamera.SEEN, f[0], f[1], f[2]);
      slice?.update(f[0], f[1], f[2], dt);
    } else {
      dither?.forget(StoryCamera.SEEN);
      if (slice && this.lifting) {
        // (lifted over where the camera now is, until it's gone)
        slice.update(cam.target[0], cam.target[1], cam.target[2], dt);
        if (slice.z === null) this.lifting = false;
      }
    }
  }

  /** wait for the shots before this one; the first one saves the player's view */
  private take(): Promise<void> {
    const begin = () => {
      this.saveHome();
      this.taken = true;
    };
    if (!this.engaged) {
      begin();
      return Promise.resolve();
    }
    return new Promise((go) => this.queue.push({ start: () => (begin(), go()) }));
  }

  private saveHome(): void {
    if (!this.home) this.home = { t: [...this.camera.target] as V3, zoom: this.camera.zoom };
  }

  /** a shot ends: the next one waiting starts from here, or the view goes home */
  private next(seconds: number): Promise<void> {
    const n = this.queue.shift();
    if (n) {
      n.start();
      return Promise.resolve();
    }
    // (round 97: a shot whose ease home was already taken by another (a reveal over a reveal, both skipped) has no
    // home left to go back to: the view stays where the last one put it)
    const h = this.home;
    if (!h) {
      this.focus = null;
      return Promise.resolve();
    }
    this.focus = null;
    this.lifting = !!this.cut.slice;
    this.returning = true;
    return this.ease(h.t, h.zoom, seconds).then(() => {
      // (a shot may have started while it eased home: it saved nothing, home is still this one)
      if (!this.engaged) this.home = null;
    });
  }

  private go(at: V3, o: Required<Pick<ShotOpts, 'zoom' | 'ease'>> & ShotOpts): Promise<void> {
    this.focus = [...at] as V3;
    this.returning = false;
    this.taken = false;
    // (the point sits at `place` on the screen: the target is that far from it across the ground, at the shot's zoom)
    const [px, py] = o.place ?? [0.5, 0.5];
    const cam = this.camera;
    const [wx, wy] = cam.screenDeltaToWorld((0.5 - px) * cam.viewportW, (0.5 - py) * cam.viewportH);
    const s = cam.zoom / o.zoom;
    return this.ease([at[0] + wx * s, at[1] + wy * s, at[2]], o.zoom, o.ease);
  }

  private ease(t: V3, zoom: number, seconds: number): Promise<void> {
    // (a move under way is replaced: the new one starts where the camera is now)
    const old = this.move;
    return new Promise((done) => {
      this.move = { from: { t: [...this.camera.target] as V3, zoom: this.camera.zoom }, to: { t, zoom }, t: 0, dur: Math.max(1e-3, seconds), done };
      old?.done();
    });
  }
}
