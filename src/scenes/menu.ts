// Main menu (design doc §4): a small live diorama — a skull in barren soil —
// whose state reflects persistent progress. Same engine and the same hands as
// the level (DECISIONS round 9): tap to grow (it withers in the dust), drag to
// make wind (it strips litter and lifts grime). It opens by showing a flower
// trying to grow out of the dust and withering. Not a full simulation:
// ecology, water and structure don't run here.

import type { Ambience } from '../audio/ambience';
import { Powers } from '../game/powers';
import { MENU_LEVELS as LEVELS, levelById, type LevelDef } from '../game/levels';
import { levelUncovered, loadDifficulty, loadLevelProgress, loadProgress, previousLevel, resetProgress, saveDifficulty, saveUncovered, type Difficulty } from '../game/progress';
import { PK } from '../sim/particles';
import { ignoreTeardown } from '../gpu/pipeline';
import { Controls } from '../input/controls';
import { generateMenuMap, MENU_SCALE } from '../world/menumap';
import { WorldCore, type Host, type Scene } from './world-core';
import { cellPos, poiWorld, ROW_H } from '../world/lattice';

const LINES: [number, string][] = [
  [0.95, 'A tree, where the thinking used to be.'],
  [0.7, 'Grass through the debris. The insects have come back.'],
  [0.45, 'Moss on old bone. Something is listening.'],
  [0.15, 'The wind has carried some of it away. The soil remembers.'],
  [0, 'Dust, wind, and what was left behind.'],
];

// only these systems run on the diorama: enough for the player's hands (wind,
// litter stripping, grow/wither, blowing the dust off buried models) — no
// ecology, water or structure
const MENU_SYSTEMS = new Set(['windfield', 'surface', 'sediment', 'particles', 'wilt', 'sway', 'renderfields', 'stats']);

export class MenuScene implements Scene {
  readonly core: WorldCore;
  private el: HTMLElement;
  private progress: number;
  private abort = new AbortController();
  private powers!: Powers;
  private controls!: Controls;
  private showT = 1.2;
  private shown = 0;
  private starting = false;
  /** the level Begin/Continue will open (picked by clicking its model) */
  private selected: LevelDef = LEVELS[0];
  /** levels whose model is still under the dust (round 13 F11) */
  private buried = new Set<string>();
  private dustCheckT = 1;
  /** seconds to the next ambient gust (round 15: grass waves, dust blows) */
  private gustT = 3;
  private dustChecking = false;

  constructor(
    private host: Host,
    private audio: Ambience,
    private onPlay: (levelId: string, free?: boolean) => Promise<void>,
  ) {
    this.progress = Number(host.params.get('progress') ?? NaN);
    if (!Number.isFinite(this.progress)) this.progress = loadProgress();
    const p = this.progress;
    const all = host.params.get('unlock') === 'all';
    for (const l of LEVELS) if (!all && !levelUncovered(l.id)) this.buried.add(l.id);
    this.core = new WorldCore(host, generateMenuMap(p, LEVELS.map((l) => ({ id: l.id, model: l.model, buried: this.buried.has(l.id) }))), 8192);
    const { weather, dayNight, camera, globals } = this.core;
    // a dead place is windy (scraps blow across); a living one is calm
    // (kept under the haze threshold so the figure stays visible)
    const wind = 4.4 - p * 3;
    weather.params.baseWindX = wind * 0.85;
    weather.params.baseWindY = wind * 0.5;
    weather.params.naturalEvery = [1e9, 1e9];
    dayNight.dayLength = 1e9;
    dayNight.timeOfDay = 0.64;
    camera.target = [24 * MENU_SCALE, 24 * MENU_SCALE * ROW_H, 14 * MENU_SCALE];
    this.core.pollution = 1 - p;
    globals.collapseEnabled = false;
    // plants at this scale get petals, leaves and blades (round 12)
    globals.fineVeg = true;

    this.el = document.createElement('div');
    this.el.className = 'menu';
    const line = LINES.find(([t]) => p >= t)![1];
    this.el.innerHTML = `<div><h1>RECLAIMED</h1><p class="line">${line}</p></div>
      <div class="actions"><span class="level-name"></span>
      <span class="play-row"><button data-a="play"></button><button data-a="free" title="The old rules: green grows wherever you touch, the whole valley open">Free play</button><button data-a="sandbox" title="Build, pour, place and break things; summon weather — the physics playground">Sandbox</button><button data-a="playground" title="The physics and water playground: stations to collapse and flood, every physics number live (round 108)">Playground</button></span>
      <span class="small level-info"></span>
      <span class="small">pick a place: click its model · some lie under the dust · sound on</span>
      <span class="small hands">touch the ground · drag to make wind</span>
      <span class="difficulty" title="Easy: green ground never fails. Medium: green resists pollution. Hard: blown waste, gales and floods kill green easily.">${(['easy', 'medium', 'hard'] as const).map((d) => `<button data-d="${d}">${d}</button>`).join('')}</span>
      ${p > 0 ? '<button class="reset" data-a="reset">reset progress</button>' : ''}</div>`;
    host.ui.appendChild(this.el);
    const btn = this.el.querySelector('[data-a="play"]') as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      if (this.starting || !this.selected.generate) return;
      this.starting = true;
      audio.start();
      btn.textContent = 'gathering…';
      btn.disabled = true;
      await this.onPlay(this.selected.id);
    });
    const free = this.el.querySelector('[data-a="free"]') as HTMLButtonElement;
    free.addEventListener('click', async () => {
      if (this.starting || !this.selected.generate || !this.selected.story) return;
      this.starting = true;
      audio.start();
      free.textContent = 'gathering…';
      free.disabled = true;
      await this.onPlay(this.selected.id, true);
    });
    this.el.querySelector('[data-a="sandbox"]')!.addEventListener('click', async () => {
      if (this.starting) return;
      this.starting = true;
      audio.start();
      await this.onPlay('sandbox');
    });
    // (round 108, AR8) the physics and water playground (levels/playground.ts)
    this.el.querySelector('[data-a="playground"]')!.addEventListener('click', async () => {
      if (this.starting) return;
      this.starting = true;
      audio.start();
      await this.onPlay('playground');
    });
    this.select(levelById(host.params.get('level')));
    const pick = (d: Difficulty) => {
      saveDifficulty(d);
      for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-d]')) b.classList.toggle('on', b.dataset.d === d);
    };
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-d]')) b.addEventListener('click', () => pick(b.dataset.d as Difficulty));
    pick(loadDifficulty());
    this.el.querySelector('[data-a="reset"]')?.addEventListener('click', () => {
      resetProgress();
      // back to the dusty start (drop a ?progress= preview too)
      const u = new URL(location.href);
      u.searchParams.delete('progress');
      location.href = u.toString();
    });
    this.attachHands();
    // scripted tests reach the title screen through this (like window.reclaimed in a level)
    (window as unknown as { reclaimedMenu: MenuScene }).reclaimedMenu = this;
  }

  /** The level's hands on the diorama: taps grow (or wither), drags paint wind. */
  private attachHands(): void {
    const core = this.core;
    const { camera } = core;
    const ground = () => 7 * MENU_SCALE;
    this.powers = new Powers({
      weather: core.weather,
      audio: this.audio,
      particles: core.sim.particles,
      globals: core.globals,
      camera,
      dims: core.dims,
      heightAt: () => 7 * MENU_SCALE,
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
          .then((hit) => {
            // a level's model? select it
            if (hit) {
              const [hx, hy] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
              const lv = LEVELS.find((l) => {
                const at = core.map.poi[`level:${l.id}`];
                return at && Math.hypot(at[0] - hx, at[1] - hy) < 4.2 * MENU_SCALE;
              });
              if (lv) {
                this.select(lv);
                return;
              }
            }
            this.powers.tap(hit, wx, wy, sx, sy);
          }, ignoreTeardown);
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

  /** Select a level: its name, progress and Begin/Continue (or "coming"), and a glow on its model. */
  private select(lv: LevelDef): void {
    this.selected = lv;
    const prog = loadLevelProgress(lv.id);
    const btn = this.el.querySelector('[data-a="play"]') as HTMLButtonElement;
    (this.el.querySelector('[data-a="free"]') as HTMLElement).style.display = lv.story && lv.generate && !this.buried.has(lv.id) && new URLSearchParams(location.search).get('mode') === 'story' ? '' : 'none';
    if (this.buried.has(lv.id)) {
      const prev = levelById(previousLevel(lv.id));
      (this.el.querySelector('.level-name') as HTMLElement).textContent = 'Under the dust';
      btn.textContent = 'buried';
      btn.disabled = true;
      (this.el.querySelector('.level-info') as HTMLElement).textContent = `Something lies buried here. Blow the dust away — or reclaim ${prev.name}.`;
      return;
    }
    (this.el.querySelector('.level-name') as HTMLElement).textContent = lv.name;
    btn.textContent = !lv.generate ? 'coming' : lv.sandbox ? 'Play' : prog > 0 ? 'Continue' : 'Begin';
    btn.disabled = !lv.generate;
    (this.el.querySelector('.level-info') as HTMLElement).textContent =
      lv.blurb + (lv.generate && !lv.sandbox && prog > 0 ? ` — ${Math.round(prog * 100)}% reclaimed` : '');
    const at = this.core.map.poi[`level:${lv.id}`];
    if (at) this.core.sim.particles.burst({ kind: PK.Glow, x: at[0], y: at[1], z: 9 * MENU_SCALE, count: 1, speed: 0, payload: 0, spread: 0 });
  }
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
      const [sx, sy] = poiWorld(core.map.poi.skull);
      const spot: [number, number] = this.shown === 0 ? [sx + 9 * MENU_SCALE, sy - 4 * MENU_SCALE] : [sx + 6 * MENU_SCALE, sy + 9 * MENU_SCALE];
      const taps = this.shown === 0 ? 3 : 2;
      for (let k = 0; k < taps; k++) setTimeout(() => this.powers.scriptTap(spot[0], spot[1]), k * 350);
      this.shown++;
      this.showT = 7;
    }
    // (no birds here: next to them the skull would read as a giant's — round 10)
    this.watchDust(dt);
    this.ambientGust(dt);
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
      barren: 1 - p,
      wind: Math.min(1, Math.hypot(core.weather.windX, core.weather.windY) / 6),
    });
  }

  /**
   * Now and then a low gust crosses the diorama, roughly with the prevailing
   * wind (round 15): the grass waves and a little dust lifts. A slow stroke
   * painted into the wind field, so it is the same wind the player makes —
   * only gentler (it must not blow the buried models clear by itself).
   */
  private ambientGust(dt: number): void {
    this.gustT -= dt;
    if (this.gustT > 0) return;
    this.gustT = 7 + Math.random() * 6;
    if (this.powers.dragWind()) return; // the player is making their own
    const { dims, weather } = this.core;
    const base = Math.atan2(weather.params.baseWindY, weather.params.baseWindX);
    const a = base + (Math.random() - 0.5) * 0.9;
    const cx = dims.w * (0.3 + Math.random() * 0.4);
    const cy = dims.h * ROW_H * (0.3 + Math.random() * 0.4);
    const L = dims.w * 0.45;
    const pts: [number, number][] = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4 - 0.5;
      // a slight curve, so it reads as a gust and not a ruler line
      pts.push([cx + Math.cos(a) * L * t - Math.sin(a) * 4 * Math.sin(t * Math.PI), cy + Math.sin(a) * L * t + Math.cos(a) * 4 * Math.sin(t * Math.PI)]);
    }
    void this.powers.scriptStroke(pts, 4.5);
  }

  /**
   * About once a second, look at the dust over each buried model: once the
   * wind has blown it mostly clear, the model is uncovered for good (saved)
   * and its level selected.
   */
  private watchDust(dt: number): void {
    this.dustCheckT -= dt;
    if (!this.buried.size || this.dustChecking || this.dustCheckT > 0) return;
    this.dustCheckT = 1;
    this.dustChecking = true;
    const { core } = this;
    core.readTexture(core.world.drift).then(({ data, w }) => {
      this.dustChecking = false;
      for (const id of [...this.buried]) {
        const a = core.map.poi[`levelMin:${id}`];
        const b = core.map.poi[`levelMax:${id}`];
        if (!a || !b) continue;
        let sum = 0;
        let n = 0;
        for (let y = a[1]; y < b[1]; y++) for (let x = a[0]; x < b[0]; x++, n++) sum += data[(y * w + x) * 4];
        if (sum / n > 0.35) continue;
        this.buried.delete(id);
        saveUncovered(id);
        this.select(levelById(id));
      }
    }, ignoreTeardown);
  }

  dispose(): void {
    this.abort.abort();
    this.controls.dispose();
    this.el.remove();
    this.core.destroy();
  }
}
