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
import type { Units } from '../../api/contracts/units';
import type { Sim } from '../../api/world';
import type { Camera } from '../../render/camera';
import type { Renderer } from '../../render/renderer';
import type { Pt } from '../core/gestures';
import { heroes, type PlayHeroId } from '../heroes/make';
import type { PlayHero } from '../heroes/base';
import type { Controls } from '../input/controls';
import { library } from '../library';
import type { PlayWorld } from '../world';
import { el, PlaySession, saveTuned } from '../session';
import { findHills } from './hills';
import { LAP, Rival } from './rival';
import { BIKE_DEFAULTS } from '../controllers/hoverbike';
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

/** raiders spawned at a time, how far ahead (cells) */
const SPAWN = { count: 4, ahead: 18, spread: 4 };

// (runplay, round 119: the hero, its controls, voxels, chase camera and health bar are play/session.ts's PlaySession —
// shared with a played run — and the sandbox is its tools round one)
export class PlaySandbox {
  private bar: HTMLElement;
  private panel: HTMLDivElement | null = null;
  private chips: HTMLButtonElement[] = [];
  private spawned: number[] = [];
  /** (round 118) rival riders lapping near where they were called: something to hook onto and ride alongside */
  readonly rivals: Rival[] = [];

  private constructor(
    readonly d: SandboxDeps,
    readonly session: PlaySession,
  ) {
    this.world.vehicles = () => this.rivals.map((r) => r.vehicle());
    session.extraParts = () => this.rivals.map((r) => r.part());
    session.afterHero = (dt) => {
      for (const r of this.rivals) r.step(dt);
    };
    this.bar = el('div', 'play-bar', d.ui);
    this.bar.style.pointerEvents = 'none';
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
    tool('⛰️', 'go to hills', () => this.toHills());
    tool('👹', 'spawn raiders ahead', () => this.spawn());
    tool('🏁', 'a rival rider (tap it to hook on and pull up alongside)', () => this.rival());
    tool('⟲', 'back on its feet', () => this.respawn());
  }

  /** Waits for the ground under the camera to read back, then drops the hero there. */
  static async start(d: SandboxDeps): Promise<PlaySandbox> {
    const session = await PlaySession.start({ ...d, respawnAfter: 2 });
    const s = new PlaySandbox(d, session);
    const c: Pt = [d.camera.target[0], d.camera.target[1]];
    // (round 118: the bike starts where there are hills to ride, if any are near — found for the hero's own climb)
    s.session.choose(d.hero, c);
    s.choose(d.hero, (d.hero === 'hoverbike' ? s.hills(c, null)?.at : null) ?? session.dryNear(c));
    if (d.tune) s.togglePanel();
    return s;
  }

  get hero(): PlayHero {
    return this.session.hero;
  }
  get controls(): Controls {
    return this.session.controls;
  }
  get world(): PlayWorld {
    return this.session.world;
  }
  get stats() {
    return this.session.stats;
  }

  /** Switch hero: dropped in where the last one was (or `at`), its parameters as last tuned in this browser. */
  choose(id: PlayHeroId, at?: Pt): void {
    this.session.choose(id, at);
    for (const c of this.chips) c.classList.toggle('on', c.dataset.id === id);
    this.toast(this.hero.pad.hint);
    if (this.panel) {
      this.togglePanel();
      this.togglePanel();
    }
  }

  /** The hilliest rideable spot near `at` (play/sandbox/hills.ts), at least 30 cells from `away`. */
  hills(at: Pt, away: Pt | null) {
    const t = this.d.api.terrain!;
    const b = this.d.bounds;
    return findHills((x, y) => t.heightAt(x, y), at, {
      radius: Math.min(b[0], b[1]) * 0.45,
      step: 8,
      climb: this.hero ? this.hero.profileClimb() : 1.5,
      least: 0.25,
      bounds: b,
      margin: 24,
      dry: (x, y) => this.world.depth(x, y) < 0.05 && (!away || Math.hypot(x - away[0], y - away[1]) > 30),
    });
  }

  /** ⛰: off to the hilliest spot in reach (another one each press) */
  toHills(): void {
    const [x, y] = this.hero.position();
    const s = this.hills([x, y], [x, y]);
    if (!s) return this.toast('No hills in reach here — ride somewhere else and try again');
    this.hero.place(s.at);
    this.d.camera.target[0] = s.at[0];
    this.d.camera.target[1] = s.at[1];
    this.toast(`Hills: ${s.slopes} slopes, ${s.relief.toFixed(0)} cells of rise and fall`);
  }

  /** a rival rider lapping round the hero's spot (at most 3: the oldest goes) */
  rival(): void {
    const [x, y] = this.hero.position();
    if (this.rivals.length >= 3) this.rivals.shift();
    // (its lap passes by the hero: the circle's centre a radius off, the rival starting ~10 cells along it from the hero)
    const a = Math.random() * Math.PI * 2;
    const centre: Pt = [x - Math.cos(a) * LAP.radius, y - Math.sin(a) * LAP.radius];
    this.rivals.push(new Rival(`rival${Date.now() % 100000}`, centre, { ...BIKE_DEFAULTS }, this.world.top, this.d.bounds, a - 0.25));
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
    this.session.respawn();
  }

  /** the window slid (WorldCore.onShift's step, negated: what's kept in window coordinates moves by it) */
  shift(dx: number, dy: number, dz: number): void {
    this.session.shift(dx, dy, dz);
    for (const r of this.rivals) r.shift(dx, dy, dz);
  }

  /** the atlas map's warp: dropped where the camera is */
  warped(at: Pt): void {
    this.session.warped(at);
  }

  /** Each frame, before the camera's update and the draw. */
  update(dt: number): void {
    this.session.update(dt);
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
      saveTuned(info.id, {});
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
        saveTuned(info.id, changed);
        showProfile();
      });
    }
  }

  private toast(text: string): void {
    const t = el('div', 'play-toast', this.d.ui);
    // (inline: the UI layer's own rules give its children pointer events, and a toast over the middle ate the lich's taps)
    t.style.pointerEvents = 'none';
    t.textContent = text;
    setTimeout(() => t.classList.add('fade'), 5000);
    setTimeout(() => t.remove(), 6500);
  }

  /** the hero as the run contract sees it */
  get asHero(): Hero {
    return this.hero;
  }

  dispose(): void {
    this.session.dispose();
    this.bar.remove();
    this.panel?.remove();
    for (const id of this.spawned) this.d.units.remove(id);
  }
}

const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, ''));
