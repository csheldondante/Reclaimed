// Main menu (design doc §4): a small live diorama — a skull in barren soil —
// whose state reflects persistent progress. Same engine and the same hands as
// the level (DECISIONS round 9): tap to grow (it withers in the dust), drag to
// make wind (it strips litter and lifts grime). It opens by showing a flower
// trying to grow out of the dust and withering. Not a full simulation:
// ecology, water and structure don't run here.

import type { Ambience } from '../audio/ambience';
import { Nature } from '../game/nature';
import { Powers } from '../game/powers';
import { loadProgress, resetProgress } from '../game/progress';
import { ignoreTeardown } from '../gpu/pipeline';
import { Controls } from '../input/controls';
import { PK } from '../sim/particles';
import { generateMenuMap, MENU_SCALE } from '../world/menumap';
import { WorldCore, type Host, type Scene } from './world-core';

const LINES: [number, string][] = [
  [0.95, 'A tree, where the thinking used to be.'],
  [0.7, 'Grass through the debris. The insects have come back.'],
  [0.45, 'Moss on old bone. Something is listening.'],
  [0.15, 'The wind has carried some of it away. The soil remembers.'],
  [0, 'Dust, wind, and what was left behind.'],
];

// only these systems run on the diorama: enough for the player's hands (wind,
// litter stripping, grow/wither) — no ecology, water or structure
const MENU_SYSTEMS = new Set(['windfield', 'material', 'surface', 'particles', 'wilt', 'sway', 'renderfields', 'stats']);

export class MenuScene implements Scene {
  readonly core: WorldCore;
  private el: HTMLElement;
  private progress: number;
  private abort = new AbortController();
  private nextBirds = 3;
  private powers!: Powers;
  private controls!: Controls;
  private showT = 1.2;
  private shown = 0;
  private starting = false;

  constructor(
    private host: Host,
    private audio: Ambience,
    private onPlay: () => Promise<void>,
  ) {
    this.progress = Number(host.params.get('progress') ?? NaN);
    if (!Number.isFinite(this.progress)) this.progress = loadProgress();
    const p = this.progress;
    this.core = new WorldCore(host, generateMenuMap(p), 8192);
    const { weather, dayNight, camera, globals } = this.core;
    // a dead place is windy (scraps blow across); a living one is calm
    // (kept under the haze threshold so the figure stays visible)
    const wind = 4.4 - p * 3;
    weather.params.baseWindX = wind * 0.85;
    weather.params.baseWindY = wind * 0.5;
    weather.params.naturalEvery = [1e9, 1e9];
    dayNight.dayLength = 1e9;
    dayNight.timeOfDay = 0.64;
    camera.target = [24 * MENU_SCALE, 24 * MENU_SCALE, 14 * MENU_SCALE];
    this.core.pollution = 1 - p;
    globals.collapseEnabled = false;

    this.el = document.createElement('div');
    this.el.className = 'menu';
    const line = LINES.find(([t]) => p >= t)![1];
    const label = p > 0 ? 'Continue' : 'Begin';
    this.el.innerHTML = `<div><h1>RECLAIMED</h1><p class="line">${line}</p></div>
      <div class="actions"><button data-a="play">${label}</button>
      <span class="small">${p > 0 ? `the valley: ${Math.round(Math.min(1, p) * 100)}% reclaimed` : 'sound on'}</span>
      <span class="small hands">touch the ground · drag to make wind</span>
      ${p > 0 ? '<button class="reset" data-a="reset">reset progress</button>' : ''}</div>`;
    host.ui.appendChild(this.el);
    const btn = this.el.querySelector('[data-a="play"]') as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      if (this.starting) return;
      this.starting = true;
      audio.start();
      btn.textContent = 'gathering…';
      btn.disabled = true;
      await this.onPlay();
    });
    this.el.querySelector('[data-a="reset"]')?.addEventListener('click', () => {
      resetProgress();
      // back to the dusty start (drop a ?progress= preview too)
      const u = new URL(location.href);
      u.searchParams.delete('progress');
      location.href = u.toString();
    });
    this.attachHands();
  }

  /** The level's hands on the diorama: taps grow (or wither), drags paint wind. */
  private attachHands(): void {
    const core = this.core;
    const { camera } = core;
    const ground = () => 7 * MENU_SCALE;
    this.powers = new Powers({
      weather: core.weather,
      nature: new Nature(),
      audio: this.audio,
      particles: core.sim.particles,
      globals: core.globals,
      camera,
      dims: core.dims,
      readSurface: async () => new Uint32Array((await core.readBuffer('surface')).buffer),
      birdsFlushed: async () => new Uint32Array((await core.readBuffer('particleCounters')).buffer)[1],
    });
    let renderW = 1;
    let renderH = 1;
    this.renderSize = (w, h) => {
      renderW = w;
      renderH = h;
    };
    const wake = () => this.audio.start();
    this.controls = new Controls(this.host.canvas, {
      tap: (sx, sy) => {
        wake();
        const [wx, wy] = camera.groundAt(sx, sy, ground);
        core.renderer
          .pick((sx / camera.viewportW) * renderW, (sy / camera.viewportH) * renderH)
          .then((hit) => this.powers.tap(hit, wx, wy, sx, sy), ignoreTeardown);
      },
      dragStart: (sx, sy) => {
        wake();
        const [wx, wy] = camera.groundAt(sx, sy, ground);
        return this.powers.gustStart(wx, wy);
      },
      dragMove: (sx, sy) => {
        const [wx, wy] = camera.groundAt(sx, sy, ground);
        this.powers.gustMove(wx, wy);
      },
      dragEnd: () => this.powers.gustEnd(),
      hover: (sx, sy) => {
        const [wx, wy] = camera.groundAt(sx, sy, ground);
        this.hoverAt = [wx, wy];
      },
      // the diorama's view is fixed
      pan: () => undefined,
      zoomAt: () => undefined,
    });
  }

  private renderSize: (w: number, h: number) => void = () => undefined;
  private hoverAt?: [number, number];

  async init(): Promise<void> {
    await this.core.warmup(30, (s) => MENU_SYSTEMS.has(s.name));
  }

  resize(renderW: number, renderH: number, cssW: number, cssH: number): void {
    this.core.resize(renderW, renderH, cssW, cssH);
    this.renderSize(renderW, renderH);
    this.core.camera.zoom = (0.85 * Math.min(cssW, cssH * 1.7)) / (68 * MENU_SCALE);
  }

  frame(now: number, dt: number): void {
    const { core, progress: p } = this;
    this.host.profiler.beginFrame();
    // the cursor stirs a breeze; drags paint wind; taps grow
    if (this.hoverAt) this.powers.hover(this.hoverAt[0], this.hoverAt[1], dt);
    this.powers.update(dt);
    // first, show what the dust does: a tree tries to grow beside the skull
    // and withers; then flowers a little further off
    this.showT -= dt;
    if (this.shown < 2 && this.showT <= 0 && p < 0.5) {
      const [sx, sy] = core.map.poi.skull;
      const spot: [number, number] = this.shown === 0 ? [sx + 9 * MENU_SCALE, sy - 4 * MENU_SCALE] : [sx + 6 * MENU_SCALE, sy + 9 * MENU_SCALE];
      const taps = this.shown === 0 ? 3 : 2;
      for (let k = 0; k < taps; k++) setTimeout(() => this.powers.scriptTap(spot[0], spot[1]), k * 350);
      this.shown++;
      this.showT = 7;
    }
    // birds visit once life has returned
    this.nextBirds -= dt;
    if (p >= 0.6 && this.nextBirds <= 0) {
      this.nextBirds = 6 + Math.random() * 8;
      core.sim.particles.burst({ kind: PK.Bird, x: 4, y: (4 + Math.random() * 40) * MENU_SCALE, z: 20 * MENU_SCALE, count: 2 + Math.floor(Math.random() * 3), speed: 4, spread: 2 });
    }
    core.advance(now, dt, 1, (s) => MENU_SYSTEMS.has(s.name));
    core.render();
    this.audio.update({
      pollution: 1 - p,
      life: p,
      rain: 0,
      rainPan: 0,
      flow: 0,
      lifeNear: p,
      zoom: 0.8,
      night: 0,
      fire: 0,
      wind: Math.min(1, Math.hypot(core.weather.windX, core.weather.windY) / 6),
    });
  }

  dispose(): void {
    this.abort.abort();
    this.controls.dispose();
    this.el.remove();
    this.core.destroy();
  }
}
