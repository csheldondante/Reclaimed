// ---- play/sandbox/sandbox.ts ------------------------------------------------------------------------------------
// The play sandbox (round 117): where the user iterates on fun. "Viewer/sandbox page: pick a hero, drop in on real
// terrain, play, tweak the controller's parameters live, spawn enemies." On the atlas level, every system in play
// (the streamer follows the camera, which follows the hero): ?skipmenu=1&level=atlas&play=hoverbike (or =lich).
//   top left   the heroes (tap to switch, dropped in where you are), health, what it's doing
//   top right  ⚙ tune: a slider per parameter (controllers/*.ts), grouped, live; the profile they give the
//              generators shown above them; reset, copy (JSON to paste back to the session), kept per hero in this
//              browser · 👹 spawn raiders ahead · ⟲ back on its feet, whole
// The camera follows the hero at a fixed angle and pulls back with speed (D-r80: "fixed but zooms out with speed which
// looks great"), leading a little along its way so what's ahead is seen.

import type { Hero } from '../../api/contracts/hero';
import { fun } from '../../api/contracts/play';
import type { Actor, Units } from '../../api/contracts/units';
import type { Sim } from '../../api/world';
import type { Camera } from '../../render/camera';
import type { Renderer } from '../../render/renderer';
import type { Pt } from '../core/gestures';
import { VoxelDraw } from '../draw/voxels';
import { heroes, makeHero, type PlayHeroId } from '../heroes/make';
import type { PlayHero } from '../heroes/base';
import { Controls } from '../input/controls';
import { readInput } from '../input/read';
import { library } from '../library';
import { makePlayWorld, type PlayWorld } from '../world';
import './sandbox.css';

export interface SandboxDeps {
  ui: HTMLElement;
  api: Sim;
  units: Units;
  camera: Camera;
  renderer: Renderer;
  device: GPUDevice;
  /** the window's extent (x cells, y world units) */
  bounds: [number, number];
  /** which hero first */
  hero: PlayHeroId;
  /** open the tune panel at once */
  tune?: boolean;
}

/** how far the camera pulls back at full speed (a share of the hero's zoom), how far it leads (s of travel), how quickly it follows (1/s) */
const CAM = { back: 0.45, lead: 0.35, follow: 6, zoomEase: 2 };
/** raiders spawned at a time, how far ahead (cells) */
const SPAWN = { count: 4, ahead: 18, spread: 4 };
const STORE = 'reclaimed.play.params.';

export class PlaySandbox {
  hero!: PlayHero;
  controls!: Controls;
  readonly world: PlayWorld;
  private draw: VoxelDraw;
  private bar: HTMLElement;
  private status: HTMLElement;
  private hp: HTMLElement;
  private panel: HTMLDivElement | null = null;
  private chips: HTMLButtonElement[] = [];
  private deadT = 0;
  private zoom = 0;
  private spawned: number[] = [];
  private keepFresh: (() => void) | null = null;
  /** the main thread's cost of the play layer each frame (ms: its input, hero, draw writes; scripts/perf/play.mjs) */
  readonly stats = { frames: 0, ms: 0, max: 0 };

  private constructor(private d: SandboxDeps) {
    this.world = makePlayWorld(d.api, d.units, d.camera, d.bounds);
    // (one actor for the units to chase, whichever hero it is now)
    const actor: Actor = {
      id: 'hero',
      faction: null,
      position: () => (this.hero?.alive ? this.hero.position() : null),
      alive: () => !!this.hero?.alive,
      hurt: (damage, by) => this.hero?.actor.hurt(damage, by),
    };
    d.units.watch(actor);
    this.draw = new VoxelDraw(d.device, d.renderer);
    this.bar = el('div', 'play-bar', d.ui);
    const who = el('div', 'play-who', this.bar);
    for (const info of heroes()) {
      const b = el('button', 'play-chip', who) as HTMLButtonElement;
      b.textContent = info.icon;
      b.title = info.name;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => this.choose(info.id as PlayHeroId));
      b.dataset.id = info.id;
      this.chips.push(b);
    }
    const tools = el('div', 'play-tools', this.bar);
    const tool = (icon: string, title: string, f: () => void) => {
      const b = el('button', 'play-chip', tools) as HTMLButtonElement;
      b.textContent = icon;
      b.title = title;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', f);
    };
    tool('⚙️', 'tune the controller', () => this.togglePanel());
    tool('👹', 'spawn raiders ahead', () => this.spawn());
    tool('⟲', 'back on its feet', () => this.respawn());
    const info = el('div', 'play-info', d.ui);
    this.hp = el('div', 'play-hp', info);
    this.status = el('div', 'play-status', info);
  }

  /** Waits for the ground under the camera to read back, then drops the hero there. */
  static async start(d: SandboxDeps): Promise<PlaySandbox> {
    const t = d.api.terrain;
    if (!t) throw new Error('play sandbox: needs the world API terrain module');
    for (let k = 0; ; k++) {
      await t.refresh();
      const c = d.camera.target;
      if (d.api.fresh && t.heightAt(c[0], c[1]) !== null) break;
      if (k > 80) throw new Error('play sandbox: the ground under the camera never read back');
      await new Promise((res) => setTimeout(res, 250));
    }
    const s = new PlaySandbox(d);
    s.keepFresh = t.keepFresh(() => s.hero?.position() ?? null);
    s.choose(d.hero, s.dryNear([d.camera.target[0], d.camera.target[1]]));
    if (d.tune) s.togglePanel();
    return s;
  }

  /** A dry spot near (x, y) (a hero dropped in a lake starts badly), or (x, y). */
  private dryNear(at: Pt): Pt {
    for (let r = 0; r < 40; r += 2)
      for (let k = 0; k < Math.max(1, r * 2); k++) {
        const a = (k / Math.max(1, r * 2)) * Math.PI * 2;
        const p: Pt = [at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r];
        if (this.world.depth(p[0], p[1]) < 0.05) return p;
      }
    return at;
  }

  /** Switch hero: dropped in where the last one was (or `at`), its parameters as last tuned in this browser. */
  choose(id: PlayHeroId, at?: Pt): void {
    const prev = this.hero;
    const p = prev?.position();
    const where: Pt = at ?? (p ? [p[0], p[1]] : [this.d.camera.target[0], this.d.camera.target[1]]);
    if (prev && 'dropAll' in prev) (prev as unknown as { dropAll(): void }).dropAll();
    this.controls?.dispose();
    const info = library.get(id)!;
    const params = { ...info.defaults, ...load(id) };
    this.hero = makeHero(id, this.world, where, params);
    this.controls = new Controls(this.d.ui, this.hero.pad);
    this.zoom = this.hero.camera.zoom;
    for (const c of this.chips) c.classList.toggle('on', c.dataset.id === id);
    this.toast(this.hero.pad.hint);
    if (this.panel) {
      this.togglePanel();
      this.togglePanel();
    }
  }

  /** raiders, hostile, ahead of the hero (or round it, still) */
  spawn(): void {
    const h = this.hero;
    const [x, y] = h.position();
    const sp = h.speed();
    const a = sp > 1 ? h.heading() : Math.random() * Math.PI * 2;
    const ahead = sp > 1 ? SPAWN.ahead + sp * 0.8 : 8;
    for (let i = 0; i < SPAWN.count; i++) {
      const at: Pt = [x + Math.cos(a) * ahead + (Math.random() - 0.5) * SPAWN.spread * 2, y + Math.sin(a) * ahead + (Math.random() - 0.5) * SPAWN.spread * 2];
      this.spawned.push(this.d.units.spawn('raider', at, 'f-raiders', { hostile: true, health: 3, sight: 24, speed: 3.5, role: 'raider' }));
    }
  }

  respawn(): void {
    const [x, y] = this.hero.position();
    this.hero.place([x, y]);
    this.hero.heal();
    this.deadT = 0;
  }

  /** the window slid (WorldCore.onShift's step, negated: what's kept in window coordinates moves by it) */
  shift(dx: number, dy: number, dz: number): void {
    this.hero.shift(dx, dy, dz);
  }

  /** the atlas map's warp: dropped where the camera is */
  warped(at: Pt): void {
    this.hero.place(at);
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
    this.controls.show(h.looks());
    this.draw.draw(h.parts());
    // the camera: after the hero, a little ahead of it, pulled back with speed
    const p = h.position();
    const v = (h as unknown as { b?: { vx: number; vy: number } }).b;
    const lead: Pt = v ? [v.vx * CAM.lead, v.vy * CAM.lead] : [0, 0];
    const k = 1 - Math.exp(-CAM.follow * dt);
    const want: [number, number, number] = [p[0] + lead[0], p[1] + lead[1], p[2]];
    for (let i = 0; i < 3; i++) cam.target[i] += (want[i] - cam.target[i]) * k;
    const z = h.camera.zoom * (1 - CAM.back * h.fast());
    this.zoom += (z - this.zoom) * (1 - Math.exp(-CAM.zoomEase * dt));
    cam.zoom = this.zoom;
    // the HUD
    this.hp.style.setProperty('--hp', String(h.health / h.maxHealth));
    const s = h.alive ? h.status() : 'DOWN — back up in a moment';
    if (this.status.textContent !== s) this.status.textContent = s;
    if (!h.alive) {
      this.deadT += dt;
      if (this.deadT > 2) this.respawn();
    }
  }

  /** The tune panel: a slider per parameter, live; the profile they give above. */
  private togglePanel(): void {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
      return;
    }
    const h = this.hero;
    const info = library.get(h.role === 'lich' ? 'lich' : 'hoverbike')!;
    const panel = (this.panel = el('div', 'play-panel', this.d.ui) as HTMLDivElement);
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart']) panel.addEventListener(ev, (e) => e.stopPropagation());
    const head = el('div', 'play-panel-head', panel);
    head.innerHTML = `<b>${info.icon} ${info.name}</b>`;
    const btn = (label: string, f: () => void) => {
      const b = el('button', 'play-small', head) as HTMLButtonElement;
      b.textContent = label;
      b.addEventListener('click', f);
    };
    btn('reset', () => {
      Object.assign(h.params, info.defaults);
      save(info.id, {});
      this.togglePanel();
      this.togglePanel();
    });
    btn('copy', () => {
      const changed = Object.fromEntries(Object.entries(h.params).filter(([k, v]) => info.defaults[k] !== v));
      void navigator.clipboard?.writeText(JSON.stringify({ controller: info.id, params: changed }, null, 1));
    });
    btn('✕', () => this.togglePanel());
    const prof = el('div', 'play-profile', panel);
    const showProfile = () => {
      const p = info.profile(h.params);
      const f = fun(p)
        .slice(0, 4)
        .map((x) => x.kind)
        .join(', ');
      const n = (v: number) => (v === Infinity ? '∞' : v.toFixed(v < 10 ? 1 : 0));
      prof.textContent = `cruise ${n(p.speed.cruise)} · top ${n(p.speed.top)} c/s · turn r ${n(p.turnRadius)} · climb ${n(p.climb.slope)}/${n(p.climb.step)} · jump ${n(p.jump.height)}h ${n(p.jump.gap)}gap${p.jump.ramp ? ' (ramp)' : ''} · fly ${n(p.fly.ceiling)} · fun: ${f}`;
    };
    showProfile();
    let group = '';
    for (const spec of info.params) {
      if (spec.group && spec.group !== group) {
        group = spec.group;
        el('div', 'play-group', panel).textContent = group;
      }
      const row = el('label', 'play-row', panel);
      const name = el('span', 'play-name', row);
      name.textContent = spec.label;
      if (spec.help) row.title = spec.help;
      const input = el('input', '', row) as HTMLInputElement;
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(h.params[spec.id]);
      const val = el('span', 'play-val', row);
      val.textContent = fmt(h.params[spec.id]);
      if (h.params[spec.id] !== info.defaults[spec.id]) row.classList.add('changed');
      input.addEventListener('input', () => {
        const v = Number(input.value);
        h.params[spec.id] = v;
        val.textContent = fmt(v);
        row.classList.toggle('changed', v !== info.defaults[spec.id]);
        const changed = Object.fromEntries(Object.entries(h.params).filter(([k, x]) => info.defaults[k] !== x));
        save(info.id, changed);
        showProfile();
      });
    }
  }

  private toast(text: string): void {
    const t = el('div', 'play-toast', this.d.ui);
    t.textContent = text;
    setTimeout(() => t.classList.add('fade'), 5000);
    setTimeout(() => t.remove(), 6500);
  }

  /** the hero as the run contract sees it */
  get asHero(): Hero {
    return this.hero;
  }

  dispose(): void {
    this.keepFresh?.();
    this.controls.dispose();
    this.draw.dispose();
    this.bar.remove();
    this.status.parentElement?.remove();
    this.panel?.remove();
    for (const id of this.spawned) this.d.units.remove(id);
  }
}

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent.append(e);
  return e;
}
const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, ''));

function load(id: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORE + id) ?? '{}');
  } catch {
    return {};
  }
}
function save(id: string, p: Record<string, number>): void {
  try {
    localStorage.setItem(STORE + id, JSON.stringify(p));
  } catch {
    // (no storage: the tuning lasts the page)
  }
}
