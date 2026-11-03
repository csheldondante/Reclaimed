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
import type { Chase } from './core/chase';
import type { CamModeId, V2 } from '../api/contracts/camera';
import { applyFrame, liveSight } from './camera/apply';
import { SignalHud } from './camera/hud';
import { CameraRig, parseCam } from './camera/rig';
import { steerAssist, type SteerParams, type SteerState } from './core/steer';
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
  /**
   * (round 121, herolab) the camera modes (`?cam=`, play/camera/rig.ts parseCam: rotate, tilt, dither, cutaway, edge over
   * the chase); absent: today's chase alone, and no way-ahead signal on screen
   */
  cam?: string | null;
  /** (merge123, LW1-1) the world's raise dead (PlayWorld.raise; scenes/level.ts puts it together from the trait system
   *  and the units); absent: none */
  raise?: PlayWorld['raise'];
}

/** how hard the hero's jolts knock the view about (cells at shake 1); the rest of the framing is the hero's (HeroCamera.chase) */
const SHAKE = 0.35;
/** (round 120, PL20) px of the screen's edges the framing keeps clear (the banner at the top, the stick at the bottom) */
const HUD_MARGIN = 56;
const STORE = 'reclaimed.play.params.';

export class PlaySession {
  hero!: PlayHero;
  /** (knight) the controller id of the hero in play (its library entry) */
  heroId!: PlayHeroId;
  controls!: Controls;
  readonly world: PlayWorld;
  private draw: VoxelDraw;
  private info: HTMLElement;
  private status: HTMLElement;
  private hp: HTMLElement;
  private deadT = 0;
  /**
   * (round 121, herolab; CAM1) the camera rig: the chase (round 120, PL20: the lead ahead of the hero and the zoom) and
   * the modes over it (play/camera/modes.ts), what the hero cares about (the way ahead), applied to the camera each frame
   */
  readonly rig: CameraRig;
  private sight: ReturnType<typeof liveSight>;
  /** the camera's sight of the live world (the lab's metrics read it) */
  get camSight(): ReturnType<typeof liveSight> {
    return this.sight;
  }
  private signals: SignalHud | null = null;
  /** the modes the camera had last frame (one turned off gives back its part once) */
  private camWas: CamModeId[] = [];
  /** (round 121, herolab) the stick taken over (the lab's autopilot): the direction over the ground for the hero at p, given the player's stick */
  steer: ((p: V2, stick: V2) => V2) | null = null;
  /**
   * (round 120, PL30) the vehicle's steering assist (core/steer.ts: corridor, avoidance, magnetism; the player's strong
   * steer overrides it at once); null: none. Not the lich's (it doesn't steer a vehicle).
   */
  assist: SteerParams | null = null;
  /** frames the assist ran, bent the stick, and was held off by a strong steer it disagreed with */
  readonly assistStats = { frames: 0, bent: 0, fought: 0 };
  /** what the carve remembers (core/steer.ts) */
  private steerState: SteerState = { carve: null };
  /** the hero's velocity last frame (cells/s, differenced) */
  private vel: V2 = [0, 0];
  /** (knight pass 2) the view's offset toward what the hero keeps framed (a locked enemy), eased */
  private frameOff: [number, number] = [0, 0];
  /** where the hero was last frame (its velocity for the framing: any hero, whatever moves it) */
  private last: [number, number] | null = null;
  private keepFresh: (() => void) | null = null;
  /** what else to draw with the hero each frame (the sandbox's rivals, a run's gates and riders) */
  extraParts: () => Part[] = () => [];
  /** a line for the status under the health bar instead of the hero's own (a stage's), null: the hero's */
  statusLine: (() => string | null) | null = null;
  /** each frame after the hero's step and before the draw (the sandbox's rivals ride here, as they did in the sandbox) */
  afterHero: ((dt: number) => void) | null = null;
  /** (round 120, runsit) the share of a unit's blow the hero takes (a run's helmet or mail: items.ts 'guard'; 1 none) */
  damageTaken = 1;
  /** paused: the hero isn't stepped or drawn and the camera is left alone (a run's travel on the map) */
  paused = false;
  /** the main thread's cost of the play layer each frame (ms: its input, hero, draw writes; scripts/perf/play.mjs) */
  readonly stats = { frames: 0, ms: 0, max: 0 };

  private constructor(readonly d: SessionDeps) {
    this.world = makePlayWorld(d.api, d.units, d.camera, d.bounds, d.raise);
    // (one actor for the units to chase, whichever hero it is now)
    const actor: Actor = {
      id: 'hero',
      faction: null,
      position: () => (this.hero?.alive && !this.paused ? this.hero.position() : null),
      alive: () => !!this.hero?.alive,
      hurt: (damage, by) => this.hero?.actor.hurt(damage * this.damageTaken, by),
    };
    d.units.watch(actor);
    this.draw = new VoxelDraw(d.device, d.renderer);
    this.info = el('div', 'play-info', d.ui);
    this.info.style.pointerEvents = 'none';
    this.hp = el('div', 'play-hp', this.info);
    this.status = el('div', 'play-status', this.info);
    this.rig = new CameraRig(parseCam(d.cam));
    this.rig.restAz = d.camera.azimuth;
    if (d.cam) this.signals = new SignalHud(d.ui);
    const t = d.api.terrain;
    if (!t) throw new Error('play: needs the world API terrain module');
    this.sight = liveSight(t, d.api.plants, d.bounds, 256);
  }

  /** (round 120, PL20) the chase camera's framing: the lead ahead of the hero and the zoom (play/core/chase.ts) */
  get chase(): Chase {
    return this.rig.chase.chase;
  }

  /** (round 124, PRE1: a presentation toggle) the hero drawn at this size round its feet; its body, reach and framing as they are */
  set drawScale(s: number) {
    this.draw.scale = s;
  }

  /** (round 121) the camera modes now (the chase always) */
  setCam(ids: readonly CamModeId[]): void {
    this.rig.use(ids);
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
    this.heroId = id;
    this.controls = new Controls(this.d.ui, this.hero.pad);
    this.rig.setHero(this.hero.camera.chase, this.hero.camera.zoom);
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
    if (at) {
      this.rig.jump();
      this.last = null;
    }
  }

  /** the window slid (WorldCore.onShift's step, negated: what's kept in window coordinates moves by it) */
  shift(dx: number, dy: number, dz: number): void {
    this.hero.shift(dx, dy, dz);
    this.rig.shift(dx, dy, dz);
    if (this.last) this.last = [this.last[0] + dx, this.last[1] + dy];
  }

  /** the atlas map's warp: dropped where the camera is */
  warped(at: Pt): void {
    this.hero.place(at);
    this.last = null;
    this.rig.jump();
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
    // (the lab's autopilot holds the stick: the rest of the controls stay the player's)
    if (this.steer) {
      const q = h.position();
      input.dir = this.steer([q[0], q[1]], [input.dir[0], input.dir[1]]);
    }
    if (this.assist && h.role !== 'lich') {
      const q = h.position();
      // (last frame's velocity: this frame's isn't made yet)
      const vel = this.vel;
      const foes = this.assist.magnet > 0 ? this.world.units.near(q[0], q[1], this.assist.magnetRange).filter((u) => u.hostile).map((u): V2 => [u.at[0], u.at[1]]) : [];
      const o = steerAssist([input.dir[0], input.dir[1]], [q[0], q[1]], vel, this.world.top, foes, h.profileClimb(), this.assist, { dt, boost: !!input.buttons[0], state: this.steerState });
      input.dir = o.dir;
      this.assistStats.frames++;
      if (o.by && o.bend !== 0) this.assistStats.bent++;
      if (o.fought) this.assistStats.fought++;
    }
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
    this.vel = [vx, vy];
    // (round 121: the camera rig — the chase as before, and the modes picked over it: play/camera)
    this.sight.frame();
    const frame = this.rig.step(dt, { at: [p[0], p[1], p[2]], floor: this.world.top(p[0], p[1]), heading: h.heading(), vel: [vx, vy], fast: h.fast() }, { move: input.dir }, this.sight, { w: cam.viewportW, h: cam.viewportH, margin: HUD_MARGIN });
    // (knight pass 2, on the rig since the herolab merge) a point the hero keeps framed (a locked enemy): the view eased
    // toward between them — a third of the way, at most 4 cells, so both stay on screen at the knight's zoom
    const fr = h.framing();
    if (fr) {
      const fx = fr[0] - p[0];
      const fy = fr[1] - p[1];
      const fl = Math.hypot(fx, fy);
      const k3 = fl > 0 ? Math.min(fl / 3, 4) / fl : 0;
      this.frameOff[0] += (fx * k3 - this.frameOff[0]) * Math.min(1, dt * 4);
      this.frameOff[1] += (fy * k3 - this.frameOff[1]) * Math.min(1, dt * 4);
    } else {
      this.frameOff[0] *= Math.max(0, 1 - dt * 4);
      this.frameOff[1] *= Math.max(0, 1 - dt * 4);
    }
    frame.view.target[0] += this.frameOff[0];
    frame.view.target[1] += this.frameOff[1];
    const ids = this.rig.ids;
    const had = (m: CamModeId) => ids.includes(m) || this.camWas.includes(m);
    // (round 124, PRE1: the presentation mode may turn and tilt the view)
    applyFrame(cam, frame, { turn: had('rotate') || had('present'), tilt: had('tilt') || had('auto') || had('autocity') || had('present'), cut: had('cutaway') || had('cutfade') || had('edge') || had('dither') });
    this.camWas = ids;
    this.signals?.update(frame.signals, cam, HUD_MARGIN);
    // (a jolt: the view knocked about by the hero's shake, a few cells at most, gone in a quarter second)
    if (h.shake > 0) {
      const j = h.shake * h.shake * SHAKE;
      cam.target[0] += (Math.random() - 0.5) * 2 * j;
      cam.target[1] += (Math.random() - 0.5) * 2 * j;
    }
    // the HUD
    this.hp.style.setProperty('--hp', String(h.health / h.maxHealth));
    const s = h.alive ? (this.statusLine?.() ?? h.status()) : this.d.respawnAfter !== null ? 'DOWN — back up in a moment' : 'DOWN';
    if (this.status.textContent !== s) this.status.textContent = s;
    if (!h.alive && this.d.respawnAfter !== null) {
      this.deadT += dt;
      if (this.deadT > this.d.respawnAfter) this.respawn();
    }
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
    this.signals?.dispose();
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
