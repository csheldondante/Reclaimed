// ---- hero/sandbox.ts ------------------------------------------------------------
// (round 112, herosandbox; BACKLOG HS1) The hero sandbox. The user: "we need a hero sandbox where I can just drop
// into the map as different heros and play generated gauntlets or maps I edit. Maybe like the airplane mode? A way
// to spawn enemies would be good though or to instantly fill up a vessel with a sand or liquid" — "You have to bring
// in the other heros via what contract" — "I need to test the actual interfaces and tweak them" — "Or at least
// provide feedback".
// In any sandbox level (the atlas, the playground, the editor's sandbox …):
// - 🧍 (or H) drops you in as the chosen hero at the ground under the screen's middle (a loaded map's 📍 start when
//   it has one), and back out to the editor — the free camera's ✈ pattern (LevelScene.toggleFly). The hero comes
//   only through the Hero contract (contracts/hero.ts), from the registry (hero/registry.ts): the Walker built in,
//   another game's heroes from a module loaded at runtime (`?heroes=<url>` or the panel's field).
// - The inspector (top left): the HeroIntent each frame, the abilities' cooldowns, health, the camera's zoom /
//   behind / firm, speed, heading, position; every call across the boundary (hero/trace.ts); the hero's tuning
//   panel (its camera and Hero.tunables as sliders: hero/tunables.ts); 💬 the contract feedback note (a picture,
//   the log, the intents, the values: docs/HEROES.md "Contract feedback").
// - Tools (a tap on the world each; they take the tap before the hero's controller does): 👹 spawn a unit of a kind
//   (hostile or friendly) through the Units contract; 🪣 fill the vessel tapped up to its rim with water, oil or
//   sand (hero/fill.ts, through the world API); 🏁 lay a generated course at the hero (hero/gauntlet.ts) and start
//   there; 📍 the map's hero start (saved with the map: the editor's save / load is how an edited map is played).
// It owns its units (SimpleUnits, drawn here as figures) unless the hero's module brings its own.

import { HERO_CONTRACT, type Hero, type HeroHost, type HeroIntent, type HeroWorld, type RunController } from '../api/contracts/hero';
import type { SpawnOpts, Units, UnitView, V2 } from '../api/contracts/units';
import type { Sim } from '../api/world';
import { Orbit } from '../api/cutaway';
import type { WorldCore } from '../scenes/world-core';
import { SimpleUnits } from '../units/simple';
import { Figures, unitPose, type FigurePose } from '../units/figures';
import { BugReport, stamp } from '../ui/bugreport';
import { TunePanel } from '../ui/tunepanel';
import { cellAt, cellPos } from '../world/lattice';
import { BoundaryLog } from './trace';
import { heroEntry, heroList, heroModules, loadHeroModule, onHeroes, type Registered } from './registry';
import { heroTuning, FOLLOW, type HeroTuning } from './tunables';
import { TouchPad } from './touchpad';
import { Walker } from './walker';
import { walkerPose } from './walker-pose';
import { findBasin, pour, type Basin, type FillWith } from './fill';
import { COURSES, type Course } from './gauntlet';
import './sandbox.css';

/** the factions the sandbox's units stand for */
const FOES = 'f-sandbox-foes';
const PLAYER = 'player';

/** the kinds the 👹 tool spawns (SpawnOpts through the Units contract) */
export const UNIT_KINDS: Record<string, { name: string; icon: string; friendly: boolean; opts: SpawnOpts }> = {
  raider: { name: 'raider', icon: '👹', friendly: false, opts: { hostile: true, health: 3, speed: 3.5, damage: 1, sight: 14 } },
  brute: { name: 'brute (slow, hits hard)', icon: '🦍', friendly: false, opts: { hostile: true, health: 10, speed: 2.2, damage: 3, sight: 10 } },
  runner: { name: 'runner (fast, weak)', icon: '🐺', friendly: false, opts: { hostile: true, health: 1, speed: 6.5, damage: 1, sight: 18 } },
  ally: { name: 'ally (follows you, fights)', icon: '🛡', friendly: true, opts: { hostile: true, health: 6, speed: 4, damage: 1, sight: 12 } },
  villager: { name: 'villager (peaceful)', icon: '🧑‍🌾', friendly: true, opts: { hostile: false, health: 3, speed: 2.5 } },
};

const FILLS: { id: FillWith; name: string }[] = [
  { id: 'water', name: 'water' },
  { id: 'oil', name: 'oil' },
  { id: 'sand', name: 'sand' },
  { id: 'soil', name: 'soil' },
  { id: 'snow', name: 'snow' },
  { id: 'rubble', name: 'rubble' },
];

/** a basin's cells at most before "not enclosed" */
const FILL_LIMIT = 4000;
/** seconds of the boundary log a feedback note carries */
const FEEDBACK_S = 60;

export interface HeroSandboxDeps {
  ui: HTMLElement;
  core: WorldCore;
  api: Sim;
  device: GPUDevice;
  level: string;
  /** the world's top at (x, y): what a screen point picks */
  heightAt: (x: number, y: number) => number;
  say: (text: string, seconds?: number) => void;
  /** the level's editor shown or hidden (in: hidden) */
  editor: (visible: boolean) => void;
  /** the free camera off, if it's on (the hero has the camera) */
  land: () => void;
  /** wake the world round (x, y) (a streamed world's sleep) */
  wake: (x: number, y: number, r: number) => void;
  params: URLSearchParams;
}

type Tool = { kind: 'spawn'; unit: string } | { kind: 'fill'; what: FillWith } | { kind: 'start' };

export class HeroSandbox {
  readonly log = new BoundaryLog();
  /** the sandbox's own units (the spawn tool's, unless the hero's module brings its own) */
  readonly units: SimpleUnits;
  hero: Hero | null = null;
  entry: Registered | null = null;
  /** the role to drop in as */
  role = 'wanderer';
  /** the last fill (scripts read it): the basin, or why not */
  lastFill: { basin?: Basin; error?: string; commands?: number; volume?: number; with?: FillWith } | null = null;
  /** the last course laid */
  course: Course | null = null;
  /** an error the panel shows (a module that didn't load) */
  error: string | null = null;
  private pad: RunController | null = null;
  private tuning: HeroTuning | null = null;
  private tunePanel: TunePanel | null = null;
  private orbit: Orbit;
  private figures: Figures;
  private freshOff: (() => void) | null = null;
  private heroUnits: Units | null = null;
  private tool: Tool | null = null;
  private overlay: HTMLDivElement | null = null;
  private feedback: BugReport;
  private el: HTMLDivElement;
  private info: HTMLPreElement;
  private logEl: HTMLPreElement;
  private heroSel: HTMLSelectElement;
  private toggleBtn: HTMLButtonElement;
  private toolBtns: HTMLButtonElement[] = [];
  private refresh = 0;
  private lastIntent: HeroIntent = { move: [0, 0] };
  private t = 0;
  private abort = new AbortController();
  private seed = 1;
  private entering = false;

  constructor(private d: HeroSandboxDeps) {
    const t = d.api.terrain;
    if (!t) throw new Error('hero sandbox: needs the world API terrain module');
    this.units = new SimpleUnits(t);
    this.orbit = new Orbit(t, d.core.camera);
    this.figures = new Figures(d.device, d.core.renderer);
    this.el = document.createElement('div');
    this.el.className = 'hero-sb';
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'wheel', 'keydown', 'keyup', 'click']) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const bar = document.createElement('div');
    bar.className = 'hero-sb-bar';
    const btn = (label: string, title: string, f: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', f);
      bar.appendChild(b);
      return b;
    };
    this.toggleBtn = btn('🧍', 'drop in as the hero here, and back out (H)', () => void this.toggle());
    this.heroSel = document.createElement('select');
    this.heroSel.title = 'the hero to drop in as';
    this.heroSel.addEventListener('change', () => void this.choose(this.heroSel.value));
    bar.appendChild(this.heroSel);
    const fold = btn('▾', 'show or hide the inspector', () => {
      const on = this.el.classList.toggle('folded');
      fold.textContent = on ? '▸' : '▾';
    });
    // (tools: a unit to spawn, a vessel to fill, a course, the start)
    const tools = document.createElement('div');
    tools.className = 'hero-sb-tools';
    const unitSel = document.createElement('select');
    unitSel.title = 'the unit 👹 spawns';
    unitSel.innerHTML = Object.entries(UNIT_KINDS).map(([k, u]) => `<option value="${k}">${u.icon} ${u.name}</option>`).join('');
    const fillSel = document.createElement('select');
    fillSel.title = 'what 🪣 fills with';
    fillSel.innerHTML = FILLS.map((f) => `<option value="${f.id}">${f.name}</option>`).join('');
    const tbtn = (label: string, title: string, tool: () => Tool) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => this.arm(this.tool && b.classList.contains('on') ? null : tool(), b));
      this.toolBtns.push(b);
      return b;
    };
    tools.append(
      tbtn('👹', 'spawn: tap the world to spawn the unit chosen beside (tap 👹 again to stop)', () => ({ kind: 'spawn', unit: unitSel.value })),
      unitSel,
      tbtn('🪣', 'fill: tap inside an enclosed vessel to fill it to its rim with what is chosen beside', () => ({ kind: 'fill', what: fillSel.value as FillWith })),
      fillSel,
      tbtn('📍', "the map's hero start: tap where the hero starts (saved with the map)", () => ({ kind: 'start' })),
    );
    const course = document.createElement('button');
    course.textContent = '🏁';
    course.title = 'a generated obstacle course from the hero (or the screen’s middle), the hero put at its start';
    course.addEventListener('click', () => void this.gauntlet());
    const clear = document.createElement('button');
    clear.textContent = '🧹';
    clear.title = "remove the sandbox's units";
    clear.addEventListener('click', () => this.clearUnits());
    tools.append(course, clear);
    // (the inspector)
    this.info = document.createElement('pre');
    this.info.className = 'hero-sb-info';
    this.logEl = document.createElement('pre');
    this.logEl.className = 'hero-sb-log';
    const mods = document.createElement('div');
    mods.className = 'hero-sb-mods';
    const url = document.createElement('input');
    url.type = 'url';
    url.placeholder = 'hero module URL (…/heroes.js)';
    const load = document.createElement('button');
    load.textContent = 'load';
    load.title = 'load a hero module (it exports heroContract and mount(host): docs/HEROES.md)';
    load.addEventListener('click', () => void this.loadModule(url.value.trim()));
    const fbRow = document.createElement('div');
    fbRow.className = 'hero-sb-fb';
    mods.append(url, load, fbRow);
    this.el.append(bar, tools, this.info, this.logEl, mods);
    d.ui.appendChild(this.el);
    this.feedback = new BugReport(d.ui, {
      level: d.level,
      world: () => ({ level: d.level, seed: d.core.globals.seed, dims: d.core.dims, params: Object.fromEntries(d.params) }),
      camera: () => ({ target: [...d.core.camera.target], zoom: d.core.camera.zoom, azimuth: d.core.camera.azimuth }),
      time: () => ({ tick: d.core.globals.tick, simTime: d.core.globals.time }),
      state: () => ({ units: this.units.all().filter((u) => u.alive).length }),
      as: {
        kind: 'reclaimed-hero-feedback',
        title: 'Contract feedback',
        prompt: 'What about the hero interface? (what you did, what felt wrong, what you would change)',
        label: '💬 feedback',
        tip: "a note on the hero contract: the picture, the boundary log, the intents and the tunables' values go with it",
        key: null,
        name: () => `${stamp()}-${(this.hero?.role ?? this.role).replace(/[^\w-]+/g, '_')}`,
        sink: 'herofeedback',
        meta: () => `${this.hero?.role ?? this.role} · contract ${HERO_CONTRACT} · ${this.log.since(FEEDBACK_S).length} calls, ${this.log.intents.length} intents kept`,
        extra: () => this.feedbackPayload(),
        buttonParent: fbRow,
      },
    });
    this.fillHeroes();
    const offHeroes = onHeroes(() => this.fillHeroes());
    this.abort.signal.addEventListener('abort', offHeroes);
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        if (e.key.toLowerCase() === 'h') void this.toggle();
      },
      { signal: this.abort.signal },
    );
    // (coarse pointers: folded until opened, the world first)
    if (matchMedia('(pointer: coarse)').matches) {
      this.el.classList.add('folded');
      fold.textContent = '▸';
    }
    this.draw();
    const urls = d.params.get('heroes');
    if (urls) for (const u of urls.split(',')) void this.loadModule(u.trim());
  }

  get active(): boolean {
    return !!this.hero;
  }

  /** In or out. */
  async toggle(): Promise<void> {
    if (this.hero) this.exit();
    else await this.enter();
  }

  /** Choose the hero (dropped in again where it stands when in). */
  async choose(role: string): Promise<void> {
    heroEntry(role);
    this.role = role;
    this.heroSel.value = role;
    if (this.hero) {
      const p = this.hero.position();
      this.exit();
      await this.enter([p[0], p[1]]);
    }
  }

  /** Drop in at `at` (window x, y; default the map's start, else the ground under the screen's middle). */
  async enter(at?: V2): Promise<void> {
    if (this.hero || this.entering) return;
    this.entering = true;
    try {
      const { core, api } = this.d;
      const cam = core.camera;
      const t = api.terrain!;
      this.d.land();
      const start = core.map.poi.heroStart;
      const p: V2 = at ?? (start ? cellPos(start[0], start[1]) : ((g) => [g[0], g[1]] as V2)(cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, this.d.heightAt)));
      // (the ground read back first: the hero is put down on what the world API reports)
      for (let k = 0; ; k++) {
        await t.refresh();
        if (api.fresh && t.heightAt(p[0], p[1], { smooth: true }) !== null) break;
        if (k > 40) throw new Error(`hero sandbox: the ground at (${p.map((v) => v.toFixed(1))}) never read back`);
        await new Promise((res) => setTimeout(res, 100));
      }
      const e = heroEntry(this.role);
      this.entry = e;
      const units = e.units ?? this.units;
      this.heroUnits = units;
      const world = this.heroWorld(units);
      this.log.add('host→hero', 'makeHero', e.role, p);
      const hero = e.makeHero(world, p);
      this.hero = hero;
      units.watch(this.log.actor(hero.actor));
      hero.hurt.push((dmg, by) => this.log.add('hero→host', 'hurt', dmg, by));
      hero.died.push(() => {
        this.log.add('hero→host', 'died');
        this.d.say(`${hero.role} fell — 🧍 twice to drop in again`, 4);
      });
      this.log.add('host→hero', e.makeController ? 'makeController' : 'TouchPad (the host’s)');
      const pad = e.makeController?.(hero) ?? new TouchPad(this.d.ui, cam);
      this.pad = pad;
      pad.onTap = (sx, sy) => this.tap(sx, sy);
      pad.onAction = () => this.log.add('host→hero', 'onAction');
      this.freshOff = t.keepFresh(() => this.hero?.position() ?? null);
      this.tuning = heroTuning(hero);
      this.tunePanel = new TunePanel(this.d.ui, { registry: this.tuning.registry, store: `reclaimed.hero.presets.${hero.role}`, urlParam: 'herotune', label: '🎚 hero', cls: 'hero', open: ['camera', 'hero'] });
      this.tuning.registry.onChange((id) => {
        if (id === 'camera.zoom' || id === null) cam.zoom = hero.camera.zoom;
      });
      if (!hero.ownCamera) {
        cam.zoom = hero.camera.zoom;
        cam.target = [...hero.position()] as [number, number, number];
      }
      this.d.editor(false);
      this.toggleBtn.classList.add('on');
      this.d.say(`${e.name}: drag to walk, ⚔ to swing (WASD, Space) — 🧍 or H back to the editor`, 4);
      this.draw();
    } finally {
      this.entering = false;
    }
  }

  /** Back out to the editor (the units stay). */
  exit(): void {
    const hero = this.hero;
    if (!hero) return;
    this.log.add('host→hero', 'dispose (controller)');
    this.pad?.dispose();
    this.pad = null;
    this.tunePanel?.dispose();
    this.tunePanel = null;
    this.tuning?.dispose();
    this.tuning = null;
    this.freshOff?.();
    this.freshOff = null;
    this.orbit.prefer = null;
    if (hero.dispose) {
      this.log.add('host→hero', 'dispose');
      hero.dispose();
    }
    this.hero = null;
    this.d.editor(true);
    this.toggleBtn.classList.remove('on');
    this.d.say('Editor', 2);
    this.draw();
  }

  /** each frame */
  update(dt: number): void {
    this.t += dt;
    const hero = this.hero;
    const pad = this.pad;
    if (hero && pad) {
      const it = pad.intent();
      // (a tap on the ground: walk there, unless the stick has it)
      const g = this.pendingGoTo;
      if (g && Math.hypot(it.move[0], it.move[1]) < 0.05) it.goTo = g;
      this.lastIntent = it;
      this.log.intent(it);
      hero.update(dt, it);
      pad.setHealth?.(hero.health, hero.maxHealth);
      if (!hero.ownCamera) {
        const cam = this.d.core.camera;
        const p = hero.position();
        const k = 1 - Math.exp(-FOLLOW.rate * dt);
        for (let i = 0; i < 3; i++) cam.target[i] += (p[i] - cam.target[i]) * k;
        this.orbit.prefer = hero.speed() > 0.5 ? { az: hero.heading() + Math.PI, dead: hero.camera.behind, firm: hero.camera.firm } : null;
        this.orbit.update(p[0], p[1], p[2], dt);
      }
    }
    this.units.update(dt);
    this.drawFigures();
    this.refresh -= dt;
    if (this.refresh <= 0) {
      this.refresh = 0.1;
      this.draw();
    }
  }

  /** The window slid by (dx, dy, dz) (a streamed world): the hero and the units move back by it (as story/atlas-run.ts). */
  slid(dx: number, dy: number, dz: number): void {
    if (this.hero) {
      this.log.add('host→hero', 'shift', -dx, -dy, -dz);
      this.hero.shift(-dx, -dy, -dz);
    }
    this.units.shift(-dx, -dy, -dz);
  }

  /** The window jumped (the atlas map's warp): out to the editor, the units gone. */
  warped(): void {
    this.exit();
    this.clearUnits();
  }

  /** Spawn a unit of `kind` at (x, y) through the Units contract (the hero's units). */
  spawn(kind: string, at: V2): number {
    const k = UNIT_KINDS[kind];
    if (!k) throw new Error(`hero sandbox: no unit kind "${kind}" (${Object.keys(UNIT_KINDS).join(', ')})`);
    const units = this.heroUnits ?? this.units;
    const id = units.spawn(kind, at, k.friendly ? PLAYER : FOES, { ...k.opts, job: kind === 'ally' ? { kind: 'follow', target: this.hero?.id ?? 'hero', distance: 3 } : undefined });
    this.log.add('host→hero', `units.spawn`, kind, at);
    return id;
  }

  /** Fill the vessel at (x, y) (window) with `what`: the basin found, then poured (hero/fill.ts). */
  fill(at: V2, what: FillWith): HeroSandbox['lastFill'] {
    const t = this.d.api.terrain!;
    const w = this.d.api.water;
    if (!w) throw new Error('hero sandbox: the fill needs the world API water module');
    const b = findBasin((cx, cy) => t.heightAt(...cellPos(cx, cy)), cellAt(at[0], at[1]), { limit: FILL_LIMIT });
    if ('error' in b) {
      this.lastFill = { error: b.error, with: what };
      this.d.say(`Can't fill: ${b.error}`, 4);
      return this.lastFill;
    }
    const r = pour({ water: w, terrain: t as unknown as Parameters<typeof pour>[0]['terrain'] }, b, what);
    this.lastFill = { basin: b, commands: r.commands, volume: r.volume, with: what };
    this.d.say(`Filling ${b.cells.length} columns with ${what} to ${b.fillTo.toFixed(1)} (its rim ${b.level.toFixed(1)}): ${r.volume.toFixed(0)} cells³ in ${r.commands} pours, ${Math.ceil(r.commands / 4)} ticks`, 4);
    const c = b.cells[0];
    this.d.wake(...cellPos(c[0], c[1]), Math.sqrt(b.cells.length) + 8);
    return this.lastFill;
  }

  /** A generated course from the hero (or the screen's middle), the hero put at its start. */
  async gauntlet(gen = COURSES[0]): Promise<Course> {
    const cam = this.d.core.camera;
    const h = this.hero?.position();
    const g = h ?? cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, this.d.heightAt);
    // (up the screen: away from the eye)
    const heading = Math.atan2(-Math.sin(cam.azimuth), -Math.cos(cam.azimuth));
    const c = gen.make([g[0], g[1]], heading, this.seed++);
    const t = this.d.api.terrain!;
    const w = this.d.api.water;
    for (const p of c.pieces) {
      if (p.kind === 'build') t.build(p.at[0], p.at[1], p.material, { radius: p.radius, layers: p.layers });
      else if (p.kind === 'dig') t.dig(p.at[0], p.at[1], { radius: p.radius, layers: p.layers });
      else w?.flood(p.at[0], p.at[1], { radius: p.radius, depth: p.depth });
    }
    this.d.wake(c.start[0], c.start[1], 140);
    // (the units once the ground under them is in: the edits land four a tick)
    const queued = () => this.d.core.globals.events.length;
    for (let k = 0; queued() > 0 && k < 300; k++) await new Promise((res) => setTimeout(res, 50));
    await t.refresh();
    for (const f of c.foes) this.spawn(f.kind, f.at);
    this.course = c;
    if (this.hero) {
      this.log.add('host→hero', 'place', c.start);
      this.hero.place(c.start);
    } else await this.enter(c.start);
    this.d.say(`${c.name}: ${c.pieces.length} pieces, ${c.foes.length} foes — to the crystal`, 4);
    return c;
  }

  clearUnits(): void {
    for (const u of this.units.all()) this.units.remove(u.id);
  }

  /** Load a hero module from `url` (contracts/hero.ts HeroModule) and register its heroes. */
  async loadModule(url: string): Promise<string[]> {
    if (!url) return [];
    try {
      const roles = await loadHeroModule(new URL(url, location.href).href, this.host());
      this.error = null;
      this.d.say(`Loaded ${roles.join(', ')} from ${url}`, 3);
      this.draw();
      return roles;
    } catch (e) {
      // (shown, not swallowed: the panel's error line and the console)
      this.error = (e as Error).message;
      console.error('[hero]', e);
      this.d.say(this.error, 8);
      this.draw();
      return [];
    }
  }

  dispose(): void {
    this.exit();
    this.arm(null);
    this.abort.abort();
    this.feedback.dispose();
    this.figures.dispose();
    this.el.remove();
  }

  // ---- the boundary ----------------------------------------------------------------------------------------

  /** what a hero is made with: the world API's ground and water, the units (logged), the 1.1 additions */
  private heroWorld(units: Units): HeroWorld {
    const t = this.d.api.terrain!;
    return {
      ground: t,
      units: this.log.units(units),
      water: this.d.api.water,
      solidAt: (x, y, z) => {
        const m = t.materialAt(x, y, z);
        return m !== null && m !== 'air';
      },
      floorUnder: (x, y, z) => t.floorAt(x, y, z),
    };
  }

  /** what a hero module's mount gets (contracts/hero.ts HeroHost) */
  host(): HeroHost {
    const { core, api, device, ui } = this.d;
    const cam = core.camera;
    return {
      contract: HERO_CONTRACT,
      world: this.heroWorld(this.units),
      ui,
      project: (x, y, z) => cam.project(x, y, z) as [number, number],
      groundAt: (sx, sy) => cam.groundAt(sx, sy, this.d.heightAt) as [number, number, number],
      zMax: core.dims.zMax,
      wake: (x, y, r) => this.d.wake(x, y, r),
      log: (line) => this.log.add('hero→host', 'host.log', line),
      raw: { sim: api, core, camera: cam, renderer: core.renderer, device },
    };
  }

  private tap(sx: number, sy: number): void {
    const hero = this.hero;
    if (!hero?.alive) return;
    if (hero.claims) {
      const c = hero.claims(sx, sy);
      this.log.add('host→hero', 'claims', sx, sy, `→ ${c}`);
      if (c) return;
    }
    if (hero.goesTo === false) return;
    const g = this.d.core.camera.groundAt(sx, sy, this.d.heightAt);
    // (a foe under the finger: walk at it, the swing does the rest)
    this.goTo = [g[0], g[1]];
  }

  private goTo: V2 | null = null;

  /** the TouchPad's intent with a tap's goTo in it (once) */
  private get pendingGoTo(): V2 | null {
    const g = this.goTo;
    this.goTo = null;
    return g;
  }

  // ---- tools -----------------------------------------------------------------------------------------------

  /** Arm a tool (null: none): the next taps on the world are its, over the hero's controller. */
  private arm(tool: Tool | null, b?: HTMLButtonElement): void {
    this.tool = tool;
    for (const x of this.toolBtns) x.classList.toggle('on', !!tool && x === b);
    this.overlay?.remove();
    this.overlay = null;
    if (!tool) return;
    const o = (this.overlay = document.createElement('div'));
    o.className = 'hero-sb-overlay';
    const tip = document.createElement('div');
    tip.className = 'hero-sb-tip';
    tip.textContent = tool.kind === 'spawn' ? `tap to spawn a ${tool.unit} — tap 👹 again to stop` : tool.kind === 'fill' ? `tap inside a vessel to fill it with ${tool.what}` : "tap where the hero starts on this map";
    o.appendChild(tip);
    let down: [number, number, number] | null = null;
    o.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      down = [e.clientX, e.clientY, performance.now()];
    });
    o.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 12) return;
      this.useTool(e.clientX, e.clientY);
    });
    this.d.ui.appendChild(o);
  }

  /** a tap of the armed tool at a screen point (CSS px) */
  useTool(sx: number, sy: number): void {
    const tool = this.tool;
    if (!tool) return;
    const g = this.d.core.camera.groundAt(sx, sy, this.d.heightAt);
    const at: V2 = [g[0], g[1]];
    if (tool.kind === 'spawn') this.spawn(tool.unit, at);
    else if (tool.kind === 'fill') {
      this.fill(at, tool.what);
      this.arm(null);
    } else {
      const c = cellAt(at[0], at[1]);
      this.d.core.map.poi.heroStart = c;
      this.d.say(`The hero starts here on this map (cell ${c}): saved with it by the editor's save`, 4);
      this.arm(null);
    }
  }

  // ---- drawing ---------------------------------------------------------------------------------------------

  private drawFigures(): void {
    const poses: FigurePose[] = [];
    // (a Walker is drawn here; any other hero draws itself)
    if (this.hero instanceof Walker) poses.push(walkerPose(this.hero));
    if (!this.entry?.units) for (const u of this.units.all()) poses.push(unitPose(u, this.t));
    this.figures.draw(poses);
  }

  private fillHeroes(): void {
    const list = heroList();
    this.heroSel.innerHTML = list.map((e) => `<option value="${e.role}">${e.icon ?? '🧍'} ${e.name}${e.source === 'built-in' ? '' : ' ⇣'}</option>`).join('');
    this.heroSel.value = this.role;
  }

  /** the inspector's text */
  private draw(): void {
    const hero = this.hero;
    const f = (v: number, n = 1) => v.toFixed(n);
    const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}°`;
    const lines: string[] = [];
    if (this.error) lines.push(`⚠ ${this.error}`);
    const e = this.entry;
    if (!hero) {
      lines.push(`editor · hero: ${this.role} · contract ${HERO_CONTRACT}${heroModules().length ? ` · modules: ${heroModules().length}` : ''}`);
      lines.push('🧍 or H: drop in at the screen’s middle');
    } else {
      const p = hero.position();
      const c = hero.camera;
      const it = this.lastIntent;
      lines.push(`${hero.role} (${e?.source === 'built-in' ? 'built-in' : 'module'}) · contract ${HERO_CONTRACT}`);
      lines.push(`pos ${f(p[0])}, ${f(p[1])}, ${f(p[2])} · heading ${deg(hero.heading())} · speed ${f(hero.speed())}`);
      lines.push(`health ${f(hero.health, 0)}/${f(hero.maxHealth, 0)}${hero.alive ? '' : ' · DEAD'}`);
      lines.push(`camera zoom ${f(c.zoom)} · behind ${deg(c.behind)} · firm ${c.firm === undefined ? '–' : deg(c.firm)}${hero.ownCamera ? ' · ownCamera' : ''}`);
      const flags = [it.attack ? 'attack' : '', it.sprint ? 'sprint' : '', it.talk ? 'talk' : ''].filter(Boolean).join(' ');
      lines.push(`intent move [${f(it.move[0], 2)}, ${f(it.move[1], 2)}] goTo ${it.goTo ? `[${f(it.goTo[0])}, ${f(it.goTo[1])}]` : '–'} ${flags || '·'} use [${(it.use ?? []).join(', ')}]${it.input !== undefined ? ` input {${it.input && typeof it.input === 'object' ? Object.keys(it.input).join(', ') : typeof it.input}}` : ''}`);
      for (const a of hero.abilities) {
        const cd = a.cooldown();
        const dur = a.duration;
        const bar = dur ? '█'.repeat(Math.round((1 - Math.min(1, cd / dur)) * 8)).padEnd(8, '░') : '';
        lines.push(`  ${a.name} (${a.id}) ${cd > 0 ? `${f(cd, 2)} s` : 'ready'}${dur ? ` / ${f(dur, 2)} ${bar}` : ''}`);
      }
      const flagsR = `claims ${hero.claims ? 'yes' : 'no'} · goesTo ${hero.goesTo === false ? 'no' : 'yes'} · tunables ${Object.keys(hero.tunables ?? {}).length}`;
      lines.push(flagsR);
    }
    const all = this.units.all().filter((u: UnitView) => u.alive);
    const reads = Object.entries(this.log.reads).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push(`units ${all.filter((u) => u.faction === FOES).length} hostile, ${all.filter((u) => u.faction === PLAYER).length} friendly${reads ? ` · hero reads/s: ${reads}` : ''}`);
    if (this.lastFill) lines.push(this.lastFill.error ? `fill: ${this.lastFill.error}` : `fill: ${this.lastFill.with} ${this.lastFill.basin!.cells.length} cols to ${f(this.lastFill.basin!.fillTo)} · ${f(this.lastFill.volume!, 0)} cells³`);
    this.info.textContent = lines.join('\n');
    this.logEl.textContent = this.log.calls
      .slice(-8)
      .map((c) => `${f(c.t)} ${c.dir} ${c.call}(${c.args})`)
      .join('\n');
  }

  /** what a feedback note carries past the bug report's own (docs/HEROES.md "Contract feedback") */
  private feedbackPayload(): Record<string, unknown> {
    const hero = this.hero;
    return {
      hero: {
        role: hero?.role ?? this.role,
        source: this.entry?.source ?? heroEntry(this.role).source,
        contract: HERO_CONTRACT,
        modules: heroModules(),
        in: !!hero,
        state: hero
          ? { position: hero.position(), heading: hero.heading(), speed: hero.speed(), health: hero.health, maxHealth: hero.maxHealth, alive: hero.alive, camera: { ...hero.camera }, ownCamera: !!hero.ownCamera, goesTo: hero.goesTo !== false, claims: !!hero.claims, abilities: hero.abilities.map((a) => ({ id: a.id, name: a.name, cooldown: a.cooldown(), duration: a.duration ?? null })) }
          : null,
      },
      boundary: { seconds: FEEDBACK_S, calls: this.log.since(FEEDBACK_S), reads: this.log.reads },
      intents: this.log.intents,
      tunables: this.tuning ? { all: this.tuning.registry.all(), changed: this.tuning.registry.changed(), string: this.tuning.registry.encode() } : null,
      sandbox: { units: this.units.all().map((u) => ({ id: u.id, kind: u.kind, faction: u.faction, at: u.at, health: u.health, alive: u.alive, state: u.state })), lastFill: this.lastFill && { ...this.lastFill, basin: this.lastFill.basin && { level: this.lastFill.basin.level, fillTo: this.lastFill.basin.fillTo, cells: this.lastFill.basin.cells.length, volume: this.lastFill.basin.volume } }, course: this.course && { name: this.course.name, start: this.course.start, goal: this.course.goal } },
    };
  }
}
