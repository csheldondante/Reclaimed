// Main menu (design doc §4): a small live diorama — a skull in barren soil —
// whose state reflects persistent progress. Same engine as the level: wind,
// dust and litter particles, light, sway; no simulation of change.

import type { Ambience } from '../audio/ambience';
import { loadProgress } from '../game/progress';
import { PK } from '../sim/particles';
import { generateMenuMap } from '../world/menumap';
import { WorldCore, type Host, type Scene } from './world-core';

const LINES: [number, string][] = [
  [0.95, 'A tree, where the thinking used to be.'],
  [0.7, 'Grass through the debris. The insects have come back.'],
  [0.45, 'Moss on old bone. Something is listening.'],
  [0.15, 'The wind has carried some of it away. The soil remembers.'],
  [0, 'Dust, wind, and what was left behind.'],
];

// only these systems run on the diorama: it is a tableau, not a simulation
const MENU_SYSTEMS = new Set(['surface', 'particles', 'renderfields', 'stats']);

export class MenuScene implements Scene {
  readonly core: WorldCore;
  private el: HTMLElement;
  private progress: number;
  private abort = new AbortController();
  private cursor: [number, number] | null = null;
  private lastCursor: [number, number] | null = null;
  private nextBirds = 3;
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
    const wind = 6.2 - p * 4;
    weather.params.baseWindX = wind * 0.85;
    weather.params.baseWindY = wind * 0.5;
    weather.params.naturalEvery = [1e9, 1e9];
    dayNight.dayLength = 1e9;
    dayNight.timeOfDay = 0.64;
    camera.target = [24, 24, 12];
    this.core.pollution = 1 - p;
    globals.collapseEnabled = false;

    this.el = document.createElement('div');
    this.el.className = 'menu';
    const line = LINES.find(([t]) => p >= t)![1];
    const label = p > 0 ? 'Continue' : 'Begin';
    this.el.innerHTML = `<div><h1>RECLAIMED</h1><p class="line">${line}</p></div>
      <div class="actions"><button data-a="play">${label}</button>
      <span class="small">${p > 0 ? `the valley: ${Math.round(Math.min(1, p) * 100)}% reclaimed` : 'sound on'}</span></div>`;
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
    host.canvas.addEventListener(
      'pointermove',
      (e) => {
        this.cursor = this.core.camera.groundAt(e.clientX, e.clientY, () => 7).slice(0, 2) as [number, number];
      },
      { signal: this.abort.signal },
    );
  }

  async init(): Promise<void> {
    await this.core.warmup(30, (s) => MENU_SYSTEMS.has(s.name));
  }

  resize(renderW: number, renderH: number, cssW: number, cssH: number): void {
    this.core.resize(renderW, renderH, cssW, cssH);
    this.core.camera.zoom = (0.85 * Math.min(cssW, cssH * 1.7)) / 68;
  }

  frame(now: number, dt: number): void {
    const { core, progress: p } = this;
    this.host.profiler.beginFrame();
    // the cursor stirs a breeze over the diorama
    const g = core.globals;
    if (this.cursor && this.lastCursor) {
      const vx = (this.cursor[0] - this.lastCursor[0]) / Math.max(dt, 1e-3);
      const vy = (this.cursor[1] - this.lastCursor[1]) / Math.max(dt, 1e-3);
      const sp = Math.hypot(vx, vy);
      g.gusts = sp > 0.5 ? [{ x: this.cursor[0], y: this.cursor[1], radius: 6, strength: Math.min(sp * 0.1, 5), dx: vx / sp, dy: vy / sp }] : [];
    }
    this.lastCursor = this.cursor;
    // birds visit once life has returned
    this.nextBirds -= dt;
    if (p >= 0.6 && this.nextBirds <= 0) {
      this.nextBirds = 6 + Math.random() * 8;
      core.sim.particles.burst({ kind: PK.Bird, x: 4, y: 4 + Math.random() * 40, z: 20, count: 2 + Math.floor(Math.random() * 3), speed: 4, spread: 2 });
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
    this.el.remove();
    this.core.destroy();
  }
}
