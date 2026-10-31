// ---- play/session.ts --------------------------------------------------------------------------------------------
// (runplay, round 119) A hero in play: the hero, its controls, its voxels, the chase camera and the health bar — what
// the play sandbox and a played run share. Taken out of play/sandbox/sandbox.ts (round 117-118) unchanged in what it
// does, so the controls the user tunes in the sandbox are the controls a run plays with: "I also want to be able to
// iterate on player controls which is probably the most important thing for fun." The sandbox adds its tools (heroes,
// tune panel, raiders, rivals) round a session; a run (src/runplay) adds its stages.

import type { Hero } from '../api/contracts/hero';
import type { Params } from '../api/contracts/play';
import type { Actor, Units } from '../api/contracts/units';
import type { Sim } from '../api/world';
import type { Camera } from '../render/camera';
import type { Renderer } from '../render/renderer';
import type { Pt } from './core/gestures';
import { Chase, DEFAULT_CHASE, type ChaseView } from './core/chase';
import { VoxelDraw } from './draw/voxels';
import type { Part } from './draw/shapes';
import { makeHero, type PlayHeroId } from './heroes/make';
import type { PlayHero } from './heroes/base';
import { Controls } from './input/controls';
import { readInput } from './input/read';
import { library } from './library';
import { makePlayWorld, type PlayWorld } from './world';
import './sandbox/sandbox.css';

export interface SessionDeps {
  ui: HTMLElement;
  api: Sim;
  units: Units;
  camera: Camera;
  renderer: Renderer;
  device: GPUDevice;
  /** the window's extent (x cells, y world units) */
  bounds: [number, number];
  /** a hero down is back up after this many seconds (the sandbox); null: it stays down (a run: its stage is lost) */
  respawnAfter: number | null;
}

/** how hard the hero's jolts knock the view about (cells at shake 1); the rest of the framing is the hero's (HeroCamera.chase) */
const SHAKE = 0.35;
/** (round 120, PL20) px of the screen's edges the framing keeps clear (the banner at the top, the stick at the bottom) */
const HUD_MARGIN = 56;
const STORE = 'reclaimed.play.params.';

export class PlaySession {
  hero!: PlayHero;
  controls!: Controls;
  readonly world: PlayWorld;
  private draw: VoxelDraw;
  private info: HTMLElement;
  private status: HTMLElement;
  private hp: HTMLElement;
  private deadT = 0;
  /** (round 120, PL20) the chase camera's framing: the lead ahead of the hero and the zoom (play/core/chase.ts) */
  readonly chase = new Chase(DEFAULT_CHASE, 30);
  /** where the hero was last frame (its velocity for the framing: any hero, whatever moves it) */
  private last: [number, number] | null = null;
  private keepFresh: (() => void) | null = null;
  /** what else to draw with the hero each frame (the sandbox's rivals, a run's gates and riders) */
  extraParts: () => Part[] = () => [];
  /** a line for the status under the health bar instead of the hero's own (a stage's), null: the hero's */
  statusLine: (() => string | null) | null = null;
  /** each frame after the hero's step and before the draw (the sandbox's rivals ride here, as they did in the sandbox) */
  afterHero: ((dt: number) => void) | null = null;
  /** paused: the hero isn't stepped or drawn and the camera is left alone (a run's travel on the map) */
  paused = false;
  /** the main thread's cost of the play layer each frame (ms: its input, hero, draw writes; scripts/perf/play.mjs) */
  readonly stats = { frames: 0, ms: 0, max: 0 };

  private constructor(readonly d: SessionDeps) {
    this.world = makePlayWorld(d.api, d.units, d.camera, d.bounds);
    // (one actor for the units to chase, whichever hero it is now)
    const actor: Actor = {
      id: 'hero',
      faction: null,
      position: () => (this.hero?.alive && !this.paused ? this.hero.position() : null),
      alive: () => !!this.hero?.alive,
      hurt: (damage, by) => this.hero?.actor.hurt(damage, by),
    };
    d.units.watch(actor);
    this.draw = new VoxelDraw(d.device, d.renderer);
    this.info = el('div', 'play-info', d.ui);
    this.info.style.pointerEvents = 'none';
    this.hp = el('div', 'play-hp', this.info);
    this.status = el('div', 'play-status', this.info);
  }

  /** Waits for the ground under the camera to read back, then makes the session (no hero yet: `choose`). */
  static async start(d: SessionDeps): Promise<PlaySession> {
    const t = d.api.terrain;
    if (!t) throw new Error('play: needs the world API terrain module');
    for (let k = 0; ; k++) {
      await t.refresh();
      const c = d.camera.target;
      if (d.api.fresh && t.heightAt(c[0], c[1]) !== null) break;
      if (k > 80) throw new Error('play: the ground under the camera never read back');
      await new Promise((res) => setTimeout(res, 250));
    }
    const s = new PlaySession(d);
    s.keepFresh = t.keepFresh(() => (s.paused ? null : s.hero?.position() ?? null));
    return s;
  }

  /** A dry spot near (x, y) (a hero dropped in a lake starts badly), or (x, y). */
  dryNear(at: Pt): Pt {
    for (let r = 0; r < 40; r += 2)
      for (let k = 0; k < Math.max(1, r * 2); k++) {
        const a = (k / Math.max(1, r * 2)) * Math.PI * 2;
        const p: Pt = [at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r];
        if (this.world.depth(p[0], p[1]) < 0.05) return p;
      }
    return at;
  }

  /** The hero to play: dropped in where the last one was (or `at`), its parameters as last tuned in this browser. */
  choose(id: PlayHeroId, at?: Pt): PlayHero {
    const prev = this.hero;
    const p = prev?.position();
    const where: Pt = at ?? (p ? [p[0], p[1]] : [this.d.camera.target[0], this.d.camera.target[1]]);
    if (prev && 'dropAll' in prev) (prev as unknown as { dropAll(): void }).dropAll();
    this.controls?.dispose();
    this.hero = makeHero(id, this.world, where, tunedParams(id));
    this.controls = new Controls(this.d.ui, this.hero.pad);
    this.chase.reset(this.hero.camera.chase ?? DEFAULT_CHASE, this.hero.camera.zoom);
    this.last = null;
    this.deadT = 0;
    return this.hero;
  }

  /** whole and on its feet where it is (or at `at`) */
  respawn(at?: Pt): void {
    const [x, y] = this.hero.position();
    this.hero.place(at ?? [x, y]);
    this.hero.heal();
    this.deadT = 0;
  }

  /** the window slid (WorldCore.onShift's step, negated: what's kept in window coordinates moves by it) */
  shift(dx: number, dy: number, dz: number): void {
    this.hero.shift(dx, dy, dz);
    if (this.last) this.last = [this.last[0] + dx, this.last[1] + dy];
  }

  /** the atlas map's warp: dropped where the camera is */
  warped(at: Pt): void {
    this.hero.place(at);
    this.last = null;
  }

  /** Each frame, before the camera's update and the draw. */
  update(dt: number): void {
    const t0 = performance.now();
    this.step(dt);
    const ms = performance.now() - t0;
    this.stats.frames++;
    this.stats.ms += ms;
    this.stats.max = Math.max(this.stats.max, ms);
  }

  private step(dt: number): void {
    const h = this.hero;
    this.controls.hidden = this.paused;
    this.info.style.display = this.paused ? 'none' : '';
    if (this.paused) {
      this.draw.draw([]);
      return;
    }
    const cam = this.d.camera;
    const input = readInput(this.controls, {
      project: (x, y, z) => cam.project(x, y, z),
      screenDeltaToWorld: (dx, dy) => cam.screenDeltaToWorld(dx, dy),
      groundAt: (s) => this.world.groundAt(s),
      hero: () => {
        const p = h.position();
        return { at: p, height: 2.4, ground: this.world.floor(p[0], p[1]) };
      },
      zoom: () => cam.zoom,
    });
    h.update(dt, { move: input.dir, input });
    this.afterHero?.(dt);
    this.controls.show(h.looks());
    this.draw.draw([...h.parts(), ...this.extraParts()]);
    // the camera: on the hero plus a lead along its velocity, zoomed out to keep what's ahead on screen (chase.ts)
    const p = h.position();
    let vx = 0;
    let vy = 0;
    if (this.last && dt > 0) {
      vx = (p[0] - this.last[0]) / dt;
      vy = (p[1] - this.last[1]) / dt;
      // (a jump of the hero's own — a respawn, a warp — isn't a velocity)
      if (Math.hypot(vx, vy) > 400) vx = vy = 0;
    }
    this.last = [p[0], p[1]];
    this.chase.step(dt, vx, vy, h.fast(), this.view());
    const k = 1 - Math.exp(-this.chase.f.follow * dt);
    cam.target[0] = p[0] + this.chase.lead[0];
    cam.target[1] = p[1] + this.chase.lead[1];
    cam.target[2] += (p[2] - cam.target[2]) * k;
    // (a jolt: the view knocked about by the hero's shake, a few cells at most, gone in a quarter second)
    if (h.shake > 0) {
      const j = h.shake * h.shake * SHAKE;
      cam.target[0] += (Math.random() - 0.5) * 2 * j;
      cam.target[1] += (Math.random() - 0.5) * 2 * j;
    }
    cam.zoom = this.chase.zoom;
    // the HUD
    this.hp.style.setProperty('--hp', String(h.health / h.maxHealth));
    const s = h.alive ? (this.statusLine?.() ?? h.status()) : this.d.respawnAfter !== null ? 'DOWN — back up in a moment' : 'DOWN';
    if (this.status.textContent !== s) this.status.textContent = s;
    if (!h.alive && this.d.respawnAfter !== null) {
      this.deadT += dt;
      if (this.deadT > this.d.respawnAfter) this.respawn();
    }
  }

  /** the screen as the chase framing sees it: its size, the view's squash, a ground step's move on it at zoom 1 */
  private view(): ChaseView {
    const cam = this.d.camera;
    const z = cam.zoom;
    const t = cam.target;
    const o = cam.project(t[0], t[1], t[2]);
    const screenOf = (dx: number, dy: number): [number, number] => {
      const q = cam.project(t[0] + dx, t[1] + dy, t[2]);
      return [(q[0] - o[0]) / z, (q[1] - o[1]) / z];
    };
    // (a ground step straight up the screen: its length there is the squash)
    const up = cam.screenDeltaToWorld(0, -1);
    const squash = 1 / (z * Math.hypot(up[0], up[1]));
    return { w: cam.viewportW, h: cam.viewportH, squash, margin: HUD_MARGIN, screenOf };
  }

  /** the hero as the run contract sees it */
  get asHero(): Hero {
    return this.hero;
  }

  dispose(): void {
    this.keepFresh?.();
    this.controls.dispose();
    this.draw.dispose();
    this.info.remove();
  }
}

export function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent.append(e);
  return e;
}

/** a controller's parameters as last tuned in this browser (the sandbox's sliders), over its defaults */
export function tunedParams(id: string): Params {
  const info = library.get(id);
  if (!info) throw new Error(`play: no controller "${id}"`);
  return { ...info.defaults, ...loadTuned(id) };
}

export function loadTuned(id: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORE + id) ?? '{}');
  } catch {
    return {};
  }
}

export function saveTuned(id: string, p: Record<string, number>): void {
  try {
    localStorage.setItem(STORE + id, JSON.stringify(p));
  } catch {
    // (no storage: the tuning lasts the page)
  }
}
