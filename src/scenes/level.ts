// The playable valley: world + diegetic powers + HUD + level goal.

import type { Ambience } from '../audio/ambience';
import { Nature, reclamation, worldHealth } from '../game/nature';
import { Powers } from '../game/powers';
import { LEVEL_GOAL, saveProgress } from '../game/progress';
import { Controls } from '../input/controls';
import { ignoreTeardown } from '../gpu/pipeline';
import { PK } from '../sim/particles';
import type { WorldStats } from '../sim/systems';
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
  /** slow readbacks of veg and water for positional audio (refreshed ~1 Hz) */
  private vegCache?: Float32Array;
  private waterCache?: Float32Array;
  private audioRefresh = 0;
  private nextFlock = 12;
  private smokeSeen = -1;
  private fieldRefresh = 0;
  private washedSeen = -1;
  private smokeRefresh = 0;

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
    // ecology excluded so nothing grows during settling; ground debris (dust,
    // litter, fallen leaves) accumulates fast so the level opens with it lying about
    s.core.globals.debrisBoost = 10;
    await s.core.warmup(WARMUP_TICKS, (sys) => sys.name !== 'ecology');
    s.core.globals.debrisBoost = 1;
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

    this.hud = new Hud(
      host.ui,
      () => this.powers.summonStorm(),
      (on) => (this.lensOn = on),
    );
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
      birdsFlushed: async () => new Uint32Array((await core.readBuffer('particleCounters')).buffer)[1],
    });

    // a few animals already live in the one healthy corner when the level opens
    const [hx, hy] = map.poi.healthy;
    const hz = map.surface[hy * dims.w + hx];
    sim.particles.burst({ kind: PK.Rabbit, x: hx, y: hy, z: hz + 0.3, count: 4, speed: 1, spread: 4 });
    sim.particles.burst({ kind: PK.Deer, x: hx + 2, y: hy - 2, z: hz + 0.4, count: 2, speed: 1, spread: 3 });
    // birds already perch in its trees (they look for crowns as they arrive)
    sim.particles.burst({ kind: PK.Bird, x: hx, y: hy, z: hz + 8, count: 5, speed: 3, spread: 3 });
    // dust storms roll across the dead valley as the level opens
    weather.spawnDust(dims.w * 0.5, dims.h * 0.45);
    weather.spawnDust(dims.w * 0.4, dims.h * 0.6, 70);

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

    // touch screens: one finger is wind (drag) or touch (tap); two fingers move the view
    const touch = matchMedia('(pointer: coarse)').matches;
    const look = touch ? 'Two fingers to look around.' : 'Right-drag to look around.';
    setTimeout(() => this.hud.say(`The valley is quiet. Touch things; drag to make wind. Call a storm with ☁${touch ? '' : ' or R'}. ${look}`, 8), 800);
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
    // open framed on the valley; portrait phones get closer than the width
    // alone would allow (the map is a diamond, its middle is what matters)
    if (first) this.core.camera.zoom = Math.max(1.5, Math.min(cssW * 1.9, cssH * 1.6) / 300);
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
      // clean land + life weighted by stage (round 8)
      this.reclaimed = reclamation(stats);
    }
    const health = worldHealth(stats, this.initialContam);
    core.pollution += (health.pollution - core.pollution) * Math.min(1, dt * 0.5);
    this.life += (health.life - this.life) * Math.min(1, dt * 0.5);
    this.nature.update(simDt, stats);
    // oil smoke the wind has torn apart pays Nature back (GPU counter, ~2 Hz)
    // storms feel the painted wind (CPU copy of the field, ~4 Hz)
    this.fieldRefresh -= dt;
    if (this.fieldRefresh <= 0) {
      this.fieldRefresh = 0.25;
      void core.readWindField().then((f) => (core.weather.windField = f), ignoreTeardown);
    }
    this.smokeRefresh -= dt;
    if (this.smokeRefresh <= 0) {
      this.smokeRefresh = 0.5;
      void core.readBuffer('particleCounters').then((f) => {
        const u = new Uint32Array(f.buffer);
        const n = u[2];
        if (this.smokeSeen >= 0 && n > this.smokeSeen) this.nature.smokeDispersed(n - this.smokeSeen);
        this.smokeSeen = n;
        // grime blown into water washes away: plinks and a little Nature
        if (this.washedSeen >= 0 && u[3] > this.washedSeen) {
          this.nature.grimeWashed(u[3] - this.washedSeen);
          this.audio.wash(u[3] - this.washedSeen);
        }
        this.washedSeen = u[3];
      }, ignoreTeardown);
    }

    this.lensK += ((this.lensOn ? 1 : 0) - this.lensK) * Math.min(1, dt * 8);
    const lc = this.hoverWorld ?? [camera.target[0], camera.target[1]];
    globals.lens = [lc[0], lc[1], 24, this.lensK < 0.01 ? 0 : this.lensK];

    const ticks = core.advance(now, simDt, this.speed);
    this.ticksAvg = this.ticksAvg * 0.95 + ticks * 0.05;
    core.render();

    hud.update(this.nature.value, this.nature.max, powers.stormReady(), this.nature.rate);
    if (this.nature.gained >= 0.5) {
      hud.gain(this.nature.gained);
      this.nature.gained = 0;
    }
    hud.setWind(powers.windTier());
    hud.setReclaim(this.reclaimed, LEVEL_GOAL);
    weather.dustiness = core.pollution;
    this.birdArrivals(dt, stats);

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
    this.audioRefresh -= dt;
    if (this.audioRefresh <= 0) {
      this.audioRefresh = 1;
      void core.readBuffer('veg').then((f) => (this.vegCache = f));
      void core.readBuffer('water').then((f) => (this.waterCache = f));
    }
    const drag = powers.dragWind();
    audio.dragWind(drag ? Math.min(1, drag.strength / 15) : 0, drag ? camera.project(drag.x, drag.y, 0)[0] / camera.viewportW : 0.5);
    const heard = this.heard();
    audio.update({
      pollution: core.pollution,
      life: this.life,
      ...heard,
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

  /**
   * What the ambient bed hears from the view centre (DECISIONS round 4): rain
   * from storms in or near view, moving water nearby (the river, the dam's
   * spillway), and living land for birdsong/insects — each fading with
   * distance, within a hearing radius that grows as the camera zooms out.
   */
  private heard(): { rain: number; rainPan: number; flow: number; lifeNear: number; zoom: number } {
    const { camera, weather, dims, map } = this.core;
    const [cx, cy] = camera.target;
    const R = Math.max(18, Math.min(160, camera.viewportW / camera.zoom / 2));
    const zoom = Math.max(0, Math.min(1, Math.log(camera.zoom / 1.2) / Math.log(10)));
    let rain = weather.rainAt(cx, cy);
    let rainPan = 0;
    for (const st of weather.storms) {
      const d = Math.max(0, Math.hypot(st.x - cx, st.y - cy) - st.radius * 0.8);
      const r = st.intensity * (1 + st.downpour) * Math.max(0, 1 - d / R);
      if (r > rain * 0.5) rainPan = Math.max(-1, Math.min(1, (camera.project(st.x, st.y, 0)[0] / camera.viewportW) * 2 - 1));
      rain = Math.max(rain, r * 0.8);
    }
    let water = 0;
    let life = 0;
    let n = 0;
    const veg = this.vegCache;
    const wat = this.waterCache;
    for (let j = -4; j <= 4; j++)
      for (let i = -4; i <= 4; i++) {
        const x = Math.floor(cx + (i / 4) * R);
        const y = Math.floor(cy + (j / 4) * R);
        if (x < 0 || y < 0 || x >= dims.w || y >= dims.h) continue;
        const fall = Math.max(0, 1 - Math.hypot(i, j) / 5.2);
        const k = y * dims.w + x;
        if (veg) life += fall * Math.min(1, Math.max(0, (veg[k] - 1.2) / 2.3));
        if (wat) water += fall * Math.min(1, wat[k] / 0.6);
        n += fall;
      }
    const [dx, dy] = map.poi.dam;
    const dam = Math.max(0, 1 - Math.hypot(dx - cx, dy - cy) / (R * 1.2));
    return {
      rain,
      rainPan,
      flow: Math.min(1, (n ? (water / n) * 2.2 : 0) + dam * 0.6),
      lifeNear: n ? Math.min(1, (life / n) * 1.6) : 0,
      zoom,
    };
  }

  /** Flocks fly in from the map edge by day once there are woods to settle in. */
  private birdArrivals(dt: number, stats: WorldStats | undefined): void {
    const { dims, sim } = this.core;
    if (!stats || this.core.light.night > 0.4) return;
    this.nextFlock -= dt * this.speed;
    if (this.nextFlock > 0) return;
    const woods = stats.matureCells / stats.cells;
    this.nextFlock = woods > 0.002 ? Math.max(12, 40 - woods * 400) * (0.6 + Math.random() * 0.8) : 20;
    if (woods <= 0.002) return;
    const side = Math.floor(Math.random() * 4);
    const t = 10 + Math.random() * (dims.w - 20);
    const x = side === 0 ? 1.5 : side === 1 ? dims.w - 1.5 : t;
    const y = side === 2 ? 1.5 : side === 3 ? dims.h - 1.5 : side < 2 ? t : 0;
    sim.particles.burst({ kind: PK.Bird, x, y, z: this.heightAt(x, y) + 11, count: 2 + Math.floor(Math.random() * 4), speed: 5, spread: 1.5 });
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
