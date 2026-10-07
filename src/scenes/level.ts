// The playable valley: world + diegetic powers + HUD + level goal.

import type { Ambience } from '../audio/ambience';
import { Nature, worldHealth } from '../game/nature';
import { Powers } from '../game/powers';
import { LEVEL_GOAL, saveProgress } from '../game/progress';
import { Controls } from '../input/controls';
import { PK } from '../sim/particles';
import { Hud } from '../ui/hud';
import type { PerfOverlay } from '../ui/perf-overlay';
import { generateMap } from '../world/mapgen';
import { WorldCore, type Host, type Scene } from './world-core';

const WARMUP_TICKS = 1800; // ~30 s of sim: rivers reach equilibrium before the player looks

export class LevelScene implements Scene {
  readonly core: WorldCore;
  private nature = new Nature();
  private powers!: Powers;
  private hud!: Hud;
  private controls!: Controls;
  private abort = new AbortController();
  private keys = new Set<string>();
  private lensOn = false;
  private lensK = 0;
  private hoverWorld: [number, number] | null = null;
  private surfaceCache: Uint32Array;
  private surfaceRefresh = 0;
  private renderW = 1;
  private renderH = 1;
  private initialContam = 0;
  private lastCollapsed = -1;
  private nextGroan = 20;
  private life = 0;
  private reclaimed = 0;
  private completed = false;
  private saveTimer = 0;
  private speed: number;
  private fps = 60;
  private ticksAvg = 1;

  private constructor(
    private host: Host,
    private audio: Ambience,
    private perf: PerfOverlay,
    private onExit: () => void,
  ) {
    const dims = { w: 256, h: 256, zMax: 64 };
    this.core = new WorldCore(host, generateMap(dims, 1), host.quality.particles);
    this.speed = Math.max(1, Number(host.params.get('speed') ?? 1));
    const p = host.params;
    if (p.get('day')) this.core.dayNight.dayLength = Math.max(10, Number(p.get('day')));
    if (p.get('tod')) this.core.dayNight.timeOfDay = Number(p.get('tod')) % 1;
    this.core.camera.target = [dims.w * 0.55, dims.h * 0.5, 14];
    this.surfaceCache = new Uint32Array(dims.w * dims.h);
    for (let i = 0; i < this.surfaceCache.length; i++) this.surfaceCache[i] = Math.round(this.core.map.surface[i]);
  }

  /** Builds the level and settles it (rivers, slopes) before returning. */
  static async create(host: Host, audio: Ambience, perf: PerfOverlay, onExit: () => void): Promise<LevelScene> {
    const s = new LevelScene(host, audio, perf, onExit);
    // ecology excluded so nothing grows during settling
    await s.core.warmup(WARMUP_TICKS, (sys) => sys.name !== 'ecology');
    s.attach();
    return s;
  }

  private heightAt = (x: number, y: number): number => {
    const { w, h } = this.core.dims;
    const ix = Math.max(0, Math.min(w - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(h - 1, Math.floor(y)));
    return this.surfaceCache[iy * w + ix] & 0xff;
  };

  private attach(): void {
    const { core, host, audio } = this;
    const { camera, sim, weather, globals, map, dims } = core;
    const readSurface = async () => new Uint32Array((await core.readBuffer('surface')).buffer);

    this.hud = new Hud(host.ui, () => this.powers.summonStorm());
    this.powers = new Powers({
      weather,
      nature: this.nature,
      audio,
      hud: this.hud,
      particles: sim.particles,
      globals,
      camera,
      dims,
      readSurface,
    });

    // a few animals already live in the one healthy corner when the level opens
    const [hx, hy] = map.poi.healthy;
    const hz = map.surface[hy * dims.w + hx];
    sim.particles.burst({ kind: PK.Rabbit, x: hx, y: hy, z: hz + 0.3, count: 4, speed: 1, spread: 4 });
    sim.particles.burst({ kind: PK.Deer, x: hx + 2, y: hy - 2, z: hz + 0.4, count: 2, speed: 1, spread: 3 });
    sim.particles.burst({ kind: PK.Bird, x: hx, y: hy, z: hz + 6, count: 3, speed: 3, spread: 2 });

    const zoomAt = (sx: number, sy: number, factor: number) => {
      const before = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
      camera.zoom = Math.max(0.8, Math.min(24, camera.zoom * factor));
      const after = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
      camera.target[0] += before[0] - after[0];
      camera.target[1] += before[1] - after[1];
    };
    const toRender = (x: number, y: number): [number, number] => [
      (x / camera.viewportW) * this.renderW,
      (y / camera.viewportH) * this.renderH,
    ];
    this.controls = new Controls(host.canvas, {
      tap: (sx, sy) => {
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        const [rx, ry] = toRender(sx, sy);
        core.renderer.pick(rx, ry).then((hit) => this.powers.tap(hit, wx, wy, sx, sy));
      },
      dragStart: (sx, sy) => {
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        return this.powers.gustStart(wx, wy);
      },
      dragMove: (sx, sy) => {
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        this.powers.gustMove(wx, wy);
      },
      dragEnd: () => this.powers.gustEnd(),
      hover: (sx, sy) => {
        this.hoverWorld = camera.groundAt(sx, sy, this.heightAt).slice(0, 2) as [number, number];
      },
      pan: (dx, dy) => {
        const [wx, wy] = camera.screenDeltaToWorld(dx, dy);
        camera.target[0] -= wx;
        camera.target[1] -= wy;
      },
      zoomAt,
    });

    const signal = this.abort.signal;
    window.addEventListener(
      'keydown',
      (e) => {
        this.keys.add(e.key.toLowerCase());
        if (e.key.toLowerCase() === 'r') this.powers.summonStorm();
        if (e.key === ' ') {
          e.preventDefault();
          if (!this.lensOn) this.hud.say('Life lens — green: growing · magenta: toxic · grey: sealed · amber: too dry · blue: ready for life', 4);
          this.lensOn = true;
        }
      },
      { signal },
    );
    window.addEventListener(
      'keyup',
      (e) => {
        this.keys.delete(e.key.toLowerCase());
        if (e.key === ' ') this.lensOn = false;
      },
      { signal },
    );

    setTimeout(() => this.hud.say('The valley is quiet. Touch things. Call a storm with ☁ or R. Right-drag to look around.', 8), 800);
    (window as unknown as { reclaimed: unknown }).reclaimed = {
      core,
      sim,
      world: core.world,
      weather,
      camera,
      renderer: core.renderer,
      map,
      packed: core.packed,
      globals,
      nature: this.nature,
      powers: this.powers,
      readBuffer: (n: Parameters<WorldCore['readBuffer']>[0]) => core.readBuffer(n),
      probe: (...a: Parameters<WorldCore['probe']>) => core.probe(...a),
      scene: this,
    };
  }

  resize(renderW: number, renderH: number, cssW: number, cssH: number): void {
    this.renderW = renderW;
    this.renderH = renderH;
    const first = this.core.camera.viewportW <= 1;
    this.core.resize(renderW, renderH, cssW, cssH);
    if (first) this.core.camera.zoom = Math.max(1.5, Math.min(cssW, cssH * 1.6) / 300);
  }

  frame(now: number, dt: number): void {
    const cpu0 = performance.now();
    const { core, audio, powers, hud } = this;
    const { camera, weather, globals, sim, map, dims } = core;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    this.host.profiler.beginFrame();

    // keyboard pan
    const panSpeed = 500 / camera.zoom;
    let kx = 0;
    let ky = 0;
    const k = this.keys;
    if (k.has('a') || k.has('arrowleft')) kx -= 1;
    if (k.has('d') || k.has('arrowright')) kx += 1;
    if (k.has('w') || k.has('arrowup')) ky -= 1;
    if (k.has('s') || k.has('arrowdown')) ky += 1;
    if (kx || ky) {
      const [wx, wy] = camera.screenDeltaToWorld(kx * panSpeed * dt, ky * panSpeed * dt);
      camera.target[0] += wx;
      camera.target[1] += wy;
    }
    camera.target[0] = Math.max(0, Math.min(dims.w, camera.target[0]));
    camera.target[1] = Math.max(0, Math.min(dims.h, camera.target[1]));

    const simDt = dt * this.speed;
    if (this.hoverWorld) powers.hover(this.hoverWorld[0], this.hoverWorld[1], dt);
    powers.update(dt);
    this.surfaceRefresh -= dt;
    if (this.surfaceRefresh <= 0) {
      this.surfaceRefresh = 1;
      void core.readBuffer('surface').then((f) => (this.surfaceCache = new Uint32Array(f.buffer)));
    }

    const stats = sim.stats.latest;
    if (stats && this.initialContam === 0) this.initialContam = stats.soilContam;
    if (stats) {
      if (this.lastCollapsed >= 0 && stats.collapsed > this.lastCollapsed) audio.crumble(stats.collapsed - this.lastCollapsed);
      this.lastCollapsed = stats.collapsed;
      // how much of the land (not under water) is alive
      this.reclaimed = stats.vegCells / Math.max(1, stats.cells - stats.wetCells);
    }
    const health = worldHealth(stats, this.initialContam);
    core.pollution += (health.pollution - core.pollution) * Math.min(1, dt * 0.5);
    this.life += (health.life - this.life) * Math.min(1, dt * 0.5);
    this.nature.update(simDt, stats);

    this.lensK += ((this.lensOn ? 1 : 0) - this.lensK) * Math.min(1, dt * 8);
    const lc = this.hoverWorld ?? [camera.target[0], camera.target[1]];
    globals.lens = [lc[0], lc[1], 24, this.lensK < 0.01 ? 0 : this.lensK];

    const ticks = core.advance(now, simDt, this.speed);
    this.ticksAvg = this.ticksAvg * 0.95 + ticks * 0.05;
    core.render();

    hud.update(this.nature.value, this.nature.max, powers.stormReady());
    hud.setReclaim(this.reclaimed, LEVEL_GOAL);
    const arrow = powers.gustArrow();
    if (arrow) {
      const [x0, y0] = camera.project(arrow.x0, arrow.y0, this.heightAt(arrow.x0, arrow.y0));
      const [x1, y1] = camera.project(arrow.x1, arrow.y1, this.heightAt(arrow.x0, arrow.y0));
      hud.drawGust({ x0, y0, x1, y1 });
    } else hud.drawGust();

    // progress feeds the menu scene; the level ends at the goal
    this.saveTimer -= dt;
    if (this.saveTimer <= 0) {
      this.saveTimer = 5;
      saveProgress((this.reclaimed / LEVEL_GOAL) * 0.95);
    }
    if (!this.completed && this.reclaimed >= LEVEL_GOAL) {
      this.completed = true;
      saveProgress(1);
      this.showComplete();
    }

    if (globals.time > this.nextGroan) {
      this.nextGroan = globals.time + 14 + Math.random() * 16;
      const [dx, dy] = map.poi.dam;
      const near = 1 - Math.min(1, Math.hypot(camera.target[0] - dx, camera.target[1] - dy) / 120);
      const holding = stats ? Math.min(1, stats.waterVolume / 20000) : 1;
      audio.groan(near * holding);
    }
    const light = core.light;
    audio.update({
      pollution: core.pollution,
      life: this.life,
      rain: weather.rainAt(camera.target[0], camera.target[1]),
      flow: stats ? Math.min(1, stats.flow / 40) : 0,
      night: light.night,
      fire: stats ? Math.min(1, stats.fireCells / 120) : 0,
      wind: Math.min(1, Math.hypot(weather.windX, weather.windY) / 6 + weather.storms.reduce((a, s) => a + s.intensity * 0.3, 0)),
    });
    this.perf.update(
      {
        fps: this.fps,
        cpuFrameMs: performance.now() - cpu0,
        ticksPerFrame: this.ticksAvg,
        instancesOpaque: core.renderer.instanceCounts.opaque,
        instancesWater: core.renderer.instanceCounts.water,
        renderW: this.renderW,
        renderH: this.renderH,
        stats,
        adapter: this.host.gpu.adapterInfo,
        quality: this.host.qualityName,
      },
      this.host.profiler,
      sim,
    );
  }

  private showComplete(): void {
    const el = document.createElement('div');
    el.className = 'complete';
    el.innerHTML = `<div class="card">
      <h2>THE VALLEY BREATHES</h2>
      <p>Life has taken back the land. The ruins are still here — they are part of it now.</p>
      <button data-a="stay">Keep watching</button><button data-a="menu">Return</button>
    </div>`;
    this.host.ui.appendChild(el);
    this.audio.flutter();
    el.querySelector('[data-a="stay"]')!.addEventListener('click', () => el.remove());
    el.querySelector('[data-a="menu"]')!.addEventListener('click', () => {
      el.remove();
      this.onExit();
    });
  }

  dispose(): void {
    this.abort.abort();
    this.controls.dispose();
    this.hud.dispose();
    this.core.destroy();
    for (const el of this.host.ui.querySelectorAll('.complete')) el.remove();
  }
}
