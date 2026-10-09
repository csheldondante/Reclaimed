// The playable valley: world + diegetic powers + HUD + level goal.

import type { Ambience } from '../audio/ambience';
import { Nature, reclamation, worldHealth } from '../game/nature';
import { Powers } from '../game/powers';
import { Director } from '../game/director';
import { levelById, type LevelDef } from '../game/levels';
import { DIFFICULTY_LEVEL, loadDifficulty, loadLevelProgress, saveProgress, type Difficulty } from '../game/progress';
import { EventKind } from '../sim/globals';
import { EDIT_OP, Editor, LAYER_TOOLS } from '../ui/editor';
import { Controls } from '../input/controls';
import { ignoreTeardown } from '../gpu/pipeline';
import { PK } from '../sim/particles';
import type { WorldStats } from '../sim/systems';
import { Hud } from '../ui/hud';
import type { PerfOverlay } from '../ui/perf-overlay';
import { WorldCore, type Host, type Scene } from './world-core';
import type { MapData } from '../world/mapgen';

export interface LevelOptions {
  /** play this map instead of generating the level's (a loaded sandbox map) */
  map?: MapData;
  /** sandbox: restart with a loaded map, or a fresh one (undefined) */
  onLoadMap?: (map: MapData | undefined) => void;
}

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
  private director!: Director;
  /** the first-play intro is running (camera directed, weather held back) */
  private intro = false;
  private smokeSeen = -1;
  private fieldRefresh = 0;
  private washedSeen = -1;
  private smokeRefresh = 0;

  /** sandbox only */
  private editor?: Editor;
  /** brush currently being dragged (sandbox) */
  private brushAt?: [number, number];
  /** the next brush event starts a new press (layer tools: a fresh layer) */
  private strokeStart = false;
  /** sandbox: the brush's footprint drawn on the ground under the cursor */
  private ring?: SVGPolylineElement;

  private constructor(
    private host: Host,
    private audio: Ambience,
    private perf: PerfOverlay,
    readonly level: LevelDef,
    private onExit: () => void,
    private opts: LevelOptions,
  ) {
    const dims = { w: 256, h: 256, zMax: 64 };
    if (!level.generate) throw new Error(`level "${level.id}" is not built yet`);
    this.core = new WorldCore(host, opts.map ?? level.generate(dims), host.quality.particles);
    this.speed = Math.max(1, Number(host.params.get('speed') ?? 1));
    const dq = host.params.get('difficulty');
    const diff: Difficulty = dq === 'easy' || dq === 'medium' || dq === 'hard' ? dq : loadDifficulty();
    this.core.globals.difficulty = DIFFICULTY_LEVEL[diff];
    const p = host.params;
    if (p.get('day')) this.core.dayNight.dayLength = Math.max(10, Number(p.get('day')));
    if (p.get('tod')) this.core.dayNight.timeOfDay = Number(p.get('tod')) % 1;
    this.core.camera.target = [dims.w * 0.55, dims.h * 0.5, 14];
    this.surfaceCache = new Uint32Array(dims.w * dims.h);
    for (let i = 0; i < this.surfaceCache.length; i++) this.surfaceCache[i] = Math.round(this.core.map.surface[i]);
  }

  /** Builds the level and settles it (rivers, slopes) before returning. */
  static async create(host: Host, audio: Ambience, perf: PerfOverlay, levelId: string, onExit: () => void, opts: LevelOptions = {}): Promise<LevelScene> {
    const s = new LevelScene(host, audio, perf, levelById(levelId), onExit, opts);
    // ecology excluded so nothing grows during settling; ground debris (dust,
    // litter, fallen leaves) accumulates fast so the level opens with it lying about.
    // A saved map was settled when it was saved: a short prime only.
    s.core.globals.debrisBoost = opts.map ? 1 : 10;
    await s.core.warmup(opts.map ? 30 : WARMUP_TICKS, (sys) => sys.name !== 'ecology');
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
      heightAt: this.heightAt,
      birdsFlushed: async () => new Uint32Array((await core.readBuffer('particleCounters')).buffer)[1],
    });

    // a few animals already live in the one healthy corner when the level opens
    const [hx, hy] = map.poi.healthy;
    const hz = map.surface[hy * dims.w + hx];
    sim.particles.burst({ kind: PK.Rabbit, x: hx, y: hy, z: hz + 0.3, count: 4, speed: 1, spread: 4 });
    sim.particles.burst({ kind: PK.Deer, x: hx + 2, y: hy - 2, z: hz + 0.4, count: 2, speed: 1, spread: 3 });
    // birds already perch in its trees (they look for crowns as they arrive)
    sim.particles.burst({ kind: PK.Bird, x: hx, y: hy, z: hz + 8, count: 5, speed: 3, spread: 3 });
    this.director = new Director(camera);
    const p = host.params;
    this.intro = !!this.level.intro && (p.get('tutorial') === '1' || (p.get('tutorial') !== '0' && p.get('skipmenu') !== '1' && loadLevelProgress(this.level.id) === 0));
    if (this.level.sandbox) {
      this.editor = new Editor(host.ui, (sp) => (this.speed = sp), {
        undo: () => this.undo(),
        capture: () => this.core.captureMap(),
        load: (map) => this.opts.onLoadMap?.(map),
        fresh: () => this.opts.onLoadMap?.(undefined),
        say: (t) => this.hud.say(t, 3),
      });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'brush-ring');
      this.ring = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      svg.appendChild(this.ring);
      host.ui.appendChild(svg);
      // pours keep landing after the press: the edit pass runs every tick
      core.sim.edit.always = true;
      weather.holdNatural(1e9);
    }

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
        if (this.editTool(wx, wy, true)) return;
        const [rx, ry] = toRender(sx, sy);
        core.renderer.pick(rx, ry).then((hit) => this.powers.tap(hit, wx, wy, sx, sy));
      },
      dragStart: (sx, sy) => {
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        if (this.editTool(wx, wy, false)) return true;
        return this.powers.gustStart(wx, wy);
      },
      dragMove: (sx, sy) => {
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        if (this.brushAt) this.brushAt = [wx, wy];
        else this.powers.gustMove(wx, wy);
      },
      dragEnd: () => {
        if (this.brushAt) this.brushAt = undefined;
        else this.powers.gustEnd();
      },
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
        if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && this.editor) {
          e.preventDefault();
          this.undo();
          return;
        }
        if (e.key.toLowerCase() === 'r') this.powers.summonStorm();
        if (e.key === 'Escape' && this.intro) this.director.cancel();
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

    if (this.intro) {
      weather.holdNatural(600);
      void this.runIntro();
    } else this.openValley();
  }

  /** The valley without the intro (or after it): dust storms roll in, the usual hint. */
  private openValley(): void {
    const { weather, dims } = this.core;
    if (this.level.sandbox) {
      setTimeout(() => this.hud.say('Sandbox: pick a tool on the right — build, pour, plant, spill, place weather. ✋ is the normal hands.', 9), 800);
      return;
    }
    // dust storms roll across the dead valley as the level opens
    weather.spawnDust(dims.w * 0.5, dims.h * 0.45);
    weather.spawnDust(dims.w * 0.4, dims.h * 0.6, 70);
    weather.holdNatural(70);
    const touch = matchMedia('(pointer: coarse)').matches;
    const look = touch ? 'Two fingers to look around.' : 'Right-drag to look around.';
    setTimeout(() => this.hud.say(`The valley is quiet. Touch things; drag to make wind. Call a storm with ☁${touch ? '' : ' or R'}. ${look}`, 8), 800);
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
    this.director.update(dt);

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
    const goal = this.level.goal ?? 1;
    hud.setReclaim(this.reclaimed, goal);
    // the brush paints every frame while held
    if (this.brushAt && this.editor) this.brush(this.brushAt[0], this.brushAt[1]);
    this.drawRing();
    weather.dustiness = core.pollution;
    this.birdArrivals(dt, stats);

    // progress feeds the menu scene; the level ends at the goal
    this.saveTimer -= dt;
    if (this.saveTimer <= 0 && this.level.goal) {
      this.saveTimer = 5;
      saveProgress(this.level.id, (this.reclaimed / this.level.goal) * 0.95);
    }
    if (!this.completed && this.level.goal && this.reclaimed >= this.level.goal) {
      this.completed = true;
      saveProgress(this.level.id, 1);
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
    const cy = weather.cyclone;
    if (cy) {
      const near = Math.max(0, 1 - Math.hypot(cy.x - camera.target[0], cy.y - camera.target[1]) / (camera.viewportW / camera.zoom));
      audio.cyclone(cy.strength * (0.3 + 0.7 * near), camera.project(cy.x, cy.y, 0)[0] / camera.viewportW);
    } else audio.cyclone(0, 0.5);
    const heard = this.heard();
    audio.update({
      pollution: core.pollution,
      life: this.life,
      ...heard,
      // barren land howls; living land in view quiets it
      barren: Math.min(1, (1 - heard.lifeNear) * 0.7 + core.pollution * 0.3),
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

  /**
   * The diegetic first-play intro (DECISIONS round 9): the whole valley;
   * closer, where something tries to grow out of the dust and withers; the
   * wind clears the dust and a patch of green takes and holds; the player
   * tries it (grow on the green, wither on the dust, a drag); then the valley
   * is theirs. Esc skips.
   */
  private async runIntro(): Promise<void> {
    const { camera, dims, map } = this.core;
    const d = this.director;
    const hud = this.hud;
    const powers = this.powers;
    const [tx, ty] = map.poi.tutorial;
    // (the scene is attached before its first resize)
    await d.waitFor(() => camera.viewportW > 1, 5);
    const wide = Math.max(1.5, Math.min(camera.viewportW * 1.9, camera.viewportH * 1.6) / 300);
    camera.target = [dims.w * 0.5, dims.h * 0.5, 14];
    camera.zoom = wide;
    d.lock();
    hud.say('A valley, dead a long time.', 4);
    await d.hold(3);
    await d.fly(tx, ty, 14, 3);
    d.lock();
    // something tries to grow out of the dust…
    powers.scriptTap(tx, ty);
    await d.hold(0.4);
    powers.scriptTap(tx, ty);
    hud.say('Life keeps trying — but the dust and waste smother it.', 6);
    await d.hold(6.5);
    // …the wind clears it…
    hud.say('Wind can carry the dust away.', 5);
    for (let k = 0; k < 3; k++) {
      await powers.scriptStroke([[tx - 9, ty - 2 + k], [tx + 9, ty + 2 - k]], 0.9);
    }
    await d.hold(2.5);
    // …and on clear ground, green takes and holds
    powers.scriptTap(tx, ty);
    await d.hold(0.6);
    powers.scriptTap(tx, ty);
    hud.say('Where the ground is clear, life holds.', 5);
    await d.hold(4);
    // the player's turn
    d.confine(tx, ty, 16, 9, 20);
    const grows: [number, number][] = [];
    powers.onGrowTap = (x, y) => grows.push([x, y]);
    hud.say('Your turn. Touch the green — again, and again.', 30);
    await d.waitFor(() => grows.length >= 2, 25);
    await d.hold(1.5);
    hud.say('Now touch the dust.', 30);
    const before = grows.length;
    await d.waitFor(() => grows.length > before && this.hostileAt(grows[grows.length - 1]), 25);
    await d.hold(2);
    let stroked = false;
    powers.onStroke = () => (stroked = true);
    hud.say('Drag across the dust to blow it away. Drag again for a gust, again for a gale.', 30);
    await d.waitFor(() => stroked, 25);
    await d.hold(2.5);
    // show you've got it: clear the litter around the green and grow there
    const litterNear = () => this.countSurface(tx, ty, 13, 18);
    const litter0 = Math.max(1, litterNear());
    hud.say('Clear the scraps from around the green, then grow something where they were.', 60);
    await d.waitFor(() => litterNear() <= litter0 * 0.45, 60);
    const grown0 = grows.length;
    await d.waitFor(() => grows.length > grown0 && !this.hostileAt(grows[grows.length - 1]) && Math.hypot(grows[grows.length - 1][0] - tx, grows[grows.length - 1][1] - ty) > 3, 30);
    hud.say('The valley will remember that.', 3);
    await d.hold(3);
    // something new: waste the wind can't move
    const [hx, hy] = map.poi.heap;
    await d.fly(hx, hy, 13, 2);
    d.confine(hx, hy, 14, 9, 18);
    hud.say('Some waste is packed too hard for wind. Try it.', 20);
    stroked = false;
    await d.waitFor(() => stroked, 12);
    await d.hold(2.5);
    // …but fire can take it: a storm comes (the player brings the lightning)
    const storm = this.core.weather.spawnToward(hx, hy);
    if (storm) {
      const at = camera.project(storm.x, storm.y, 0)[0] / Math.max(1, camera.viewportW);
      this.audio.thunder(0.1, 0.8, Math.max(0, Math.min(1, at)));
    }
    this.nature.value = Math.max(this.nature.value, 40);
    hud.say('Thunder. A storm is coming — wait for it, or lean on it with the wind.', 40);
    d.confine(hx, hy, 40, 3, 18);
    await d.fly(hx, hy, 5, 2.5);
    await d.waitFor(() => this.core.weather.coverAt(hx, hy) > 0.3, 70);
    await d.fly(hx, hy, 11, 1.5);
    d.confine(hx, hy, 12, 9, 16);
    hud.say('Tap beneath the storm: lightning will find the heap.', 40);
    await d.waitFor(() => this.countSurface(hx, hy, 4, 12) === 0, 45);
    hud.say('Fire leaves ash — and ash rides the wind. Blow it away.', 40);
    const ash0 = Math.max(1, this.countSurface(hx, hy, 6, 17));
    await d.waitFor(() => this.countSurface(hx, hy, 6, 17) <= ash0 * 0.5, 40);
    powers.onGrowTap = undefined;
    powers.onStroke = undefined;
    // the valley is theirs
    d.lock();
    await d.fly(dims.w * 0.5, dims.h * 0.5, wide, 3);
    d.free();
    this.intro = false;
    this.openValley();
  }

  /**
   * Sandbox: if an editor tool is active, handle the press — a brush starts
   * painting (or paints once for a tap), a spawn tool places its weather.
   * Returns false for the normal hands.
   */
  private editTool(wx: number, wy: number, tap: boolean): boolean {
    const ed = this.editor;
    if (!ed || ed.tool === 'wind') return false;
    const w = this.core.weather;
    if (ed.tool === 'storm') {
      const s = w.spawn(wx, wy);
      if (s) s.age = 5;
      return true;
    }
    if (ed.tool === 'duststorm') {
      w.placeDust(wx, wy);
      return true;
    }
    if (ed.tool === 'cyclone') {
      w.cyclone = undefined;
      w.spawnCyclone(wx, wy, 1);
      return true;
    }
    // each press can be undone
    if (EDIT_OP[ed.tool]) this.core.snapshot();
    this.strokeStart = true;
    if (tap) this.brush(wx, wy);
    else this.brushAt = [wx, wy];
    return true;
  }

  /** Sandbox: outline the brush on the ground (follows the terrain). */
  private drawRing(): void {
    const ed = this.editor;
    const ring = this.ring;
    if (!ed || !ring) return;
    const at = this.brushAt ?? this.hoverWorld;
    const on = !!at && !!EDIT_OP[ed.tool];
    ring.parentElement!.style.display = on ? '' : 'none';
    if (!on) return;
    const { camera } = this.core;
    const pts: string[] = [];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const x = at[0] + Math.cos(a) * ed.radius;
      const y = at[1] + Math.sin(a) * ed.radius;
      const [sx, sy] = camera.project(x, y, this.heightAt(x, y) + 0.1);
      pts.push(`${sx.toFixed(1)},${sy.toFixed(1)}`);
    }
    ring.setAttribute('points', pts.join(' '));
  }

  /** Sandbox: put the world back as it was before the last brush press. */
  private undo(): void {
    this.brushAt = undefined;
    if (!this.core.undo()) this.hud.say('Nothing to undo.', 2);
  }

  /** One frame of the brush: an EV_EDIT event for edit.wgsl. */
  private brush(x: number, y: number): void {
    const ed = this.editor!;
    const op = EDIT_OP[ed.tool];
    if (!op) return;
    const layered = LAYER_TOOLS.has(ed.tool);
    const z = op * 32 + ed.material + (this.strokeStart ? 512 : 0);
    this.strokeStart = false;
    this.core.globals.events.push({ kind: EventKind.Edit, x, y, z, radius: ed.radius, strength: layered ? ed.layers : ed.strength });
  }

  /** How many columns within r of (x, y) have this top material (surface cache, ~1 s old). */
  private countSurface(x: number, y: number, r: number, mat: number): number {
    const { dims } = this.core;
    let n = 0;
    for (let yy = Math.floor(y - r); yy <= y + r; yy++)
      for (let xx = Math.floor(x - r); xx <= x + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= dims.w || yy >= dims.h || Math.hypot(xx - x, yy - y) > r) continue;
        if (((this.surfaceCache[yy * dims.w + xx] >> 8) & 0xff) === mat) n++;
      }
    return n;
  }

  /** CPU guess at whether a tapped spot is hostile ground (polluted or littered/trashed). */
  private hostileAt([x, y]: [number, number]): boolean {
    const { dims, map } = this.core;
    const i = Math.floor(y) * dims.w + Math.floor(x);
    const top = this.surfaceCache[i] >> 8 & 0xff;
    return top === 12 || top === 18 || map.contam[i * 2] > 0.2;
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
    this.editor?.dispose();
    this.ring?.parentElement?.remove();
    this.hud.dispose();
    this.core.destroy();
    for (const el of this.host.ui.querySelectorAll('.complete')) el.remove();
  }
}
