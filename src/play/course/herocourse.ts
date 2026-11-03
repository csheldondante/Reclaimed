// ---- play/course/herocourse.ts ----------------------------------------------------------------------------------
// (round 128b, `playmodes`; docs/design/PLAY_MODES.md) The hero course: `?skipmenu=1&level=herocourse`. Play's hero
// (PlaySession) on one loop through the world's kinds of place (course.ts), the game picking a play mode from where
// the hero is (modes.ts), a brief auto on the way into a mode that hands back the moment the player touches the
// screen. The user (round 128b): "I'm not claiming those are winners but I'm claiming that is exactly the sort of
// experiment we should set up for the player to try in the sandboxes."
//
// On screen: the heroes one tap away; ⚙ the settings drawer — try (the five experiments), go to (an area), mode, the
// camera, the controls, the assists — each a row of chips kept in the address, so a link reproduces a setup; ▶ the
// autopilot round the loop; ⟲ back to the area's start.
// Address: ?hero= ?try= ?area= ?mode=auto|open|canyon|woods|climb|under ?forest=under|woods ?zoom= ?lead= ?under=
// ?ctl=mode|free ?run=on|off ?pace= ?auto=1

import type { V2 } from '../../api/contracts/camera';
import type { PlayMode } from '../../api/contracts/playmode';
import type { Units } from '../../api/contracts/units';
import type { Sim } from '../../api/world';
import type { Camera } from '../../render/camera';
import type { Renderer } from '../../render/renderer';
import { UnderstoryDriver } from '../../forest/driver';
import { isPlayHero, makeHero, type PlayHeroId } from '../heroes/make';
import type { PlayHero } from '../heroes/base';
import { NO_INPUT } from '../input/types';
import { Autopilot, lookFor, riderClimb } from '../lab/autopilot';
import { urlParam, VariantPicker, type Choice } from '../lab/lab';
import { el, PlaySession, type SessionDeps } from '../session';
import { ModeCamera } from '../modes/blend';
import { facingAzimuth, isModeId, MODES, ModeSwitcher, modeStick, type ModeId } from '../modes/modes';
import { CANYON, canyonState, canyonStick } from '../modes/canyon';
import { AREAS, areaStart, BOULDERS, ROUTE, type AreaId } from './course';
import '../sandbox/sandbox.css';
import '../lab/herolab.css';
import './course.css';

export interface CourseDeps {
  ui: HTMLElement;
  api: Sim;
  units: Units;
  camera: Camera;
  renderer: Renderer;
  device: GPUDevice;
  bounds: [number, number];
  raise?: SessionDeps['raise'];
  /** the season now (the understory's leaf colour) */
  season: () => number;
}

/** The five experiments: where, which hero, and what the forest is played as. */
interface Experiment {
  id: string;
  icon: string;
  label: string;
  area: AreaId;
  /** how far into the area's stretch to start (0..1; absent: its start) */
  at?: number;
  hero: PlayHeroId;
  forest?: 'under' | 'woods';
  /** the question for the user, plain */
  ask: string;
}

const EXPERIMENTS: Experiment[] = [
  { id: 'chase', icon: '🏍', label: 'open ride', area: 'hills', hero: 'hoverbike', ask: 'The camera pulls out as you speed up and looks ahead of you. Is it far enough?' },
  { id: 'canyon', icon: '🏜', label: 'canyon run', area: 'canyon', hero: 'hoverbike', ask: 'The canyon steers you round. Push left or right to ride up a wall. Watch for rocks and riders. Is it fun?' },
  { id: 'woods', icon: '🏃', label: 'woods run', area: 'forest', at: 0.5, hero: 'knight', forest: 'woods', ask: 'Side-on through the woods. Push along the path to run, the other way to go back. Does it feel good?' },
  { id: 'climb', icon: '🧗', label: 'cliff', area: 'cliff', hero: 'lich', ask: 'Side-on to the cliff. Can you read how high you are and where the cave is?' },
  { id: 'under', icon: '🌳', label: 'under trees', area: 'forest', at: 0, hero: 'knight', forest: 'under', ask: 'The camera drops under the trees and cuts the trunks in front. Better than the woods run?' },
];

const HEROES: Choice<PlayHeroId>[] = [
  { id: 'hoverbike', icon: '🏍', label: 'bike' },
  { id: 'knight', icon: '🗡️', label: 'knight' },
  { id: 'horse', icon: '🐎', label: 'horse' },
  { id: 'lich', icon: '💀', label: 'lich' },
];

/** the camera's zoom times this (a mode's own close view) */
const ZOOMS: Record<string, number> = { near: 1.35, mid: 1, far: 0.7 };
/** the lead ahead added to the mode's (seconds) */
const LEADS: Record<string, number> = { none: -1, some: 0, lots: 0.3 };
/** under the trees: the view drawn in to this share of the chase's */
const UNDER_ZOOM: Record<string, number> = { little: 0.75, more: 0.55, most: 0.4 };
/** (the canyon run) the bike this share of the screen's height below the middle: the way ahead fills the screen */
const CANYON_LOW = 0.18;
/** the route's throttle */
const PACES: Record<string, number> = { slow: 0.4, mid: 0.55, fast: 0.8 };

/** the throttle the autopilot rides each area at */
const AREA_PACE: Record<AreaId, number> = { hills: 0.9, forest: 0.5, canyon: 0.55, cliff: 0.5, river: 0.6, ruins: 0.5, town: 0.45 };

export class HeroCourse {
  readonly switcher: ModeSwitcher;
  readonly cam = new ModeCamera();
  private pilot: Autopilot;
  /** ▶: the autopilot round the loop (the player's touch takes over for a moment) */
  auto: boolean;
  private yieldT = 0;
  /** the player touched the screen since the last frame */
  private touched = false;
  private hint = -1;
  private bar: HTMLElement;
  private drawer: HTMLElement;
  private now: HTMLElement;
  private pickers = new Map<string, VariantPicker<string>>();
  private under: UnderstoryDriver | null = null;
  private exp: Experiment | null = null;
  private riders: { id: number; t: number }[] = [];
  private riderT = 0;
  private lastMode: ModeId | null = null;
  private paintedArea: AreaId | '' = '';
  private onTouch = () => (this.touched = true);
  /** (the canyon run) its line's state, the frame's step, and the bike's drive as it was before the run put it on the
   *  physical drive with wall riding (restored when the run ends) */
  private canyon = canyonState();
  private dt = 1 / 60;
  private bikeWas: { params: Record<string, number>; drive: number; wallRide: number; wallMin: number } | null = null;
  /** (the bike's canyon run) the riders: bikes of the same make on the same run, coming up from behind faster, each in
   *  its own lane; one that touches the hero knocks it (the raiders on foot, 3 cells/s, never caught a bike) */
  private rivals: { hero: PlayHero; st: ReturnType<typeof canyonState>; lane: number; t: number; hitT: number }[] = [];
  private rivalT = 1.5;
  /** live numbers for the shot scripts */
  readonly live = { mode: '' as ModeId | '', auto: false, area: '' as AreaId | '', overRoad: 0, off: 0, push: 0, line: 0 };

  private constructor(
    readonly d: CourseDeps,
    readonly session: PlaySession,
  ) {
    this.auto = urlParam.get('auto') === '1';
    this.pilot = this.makePilot();
    const at = session.hero.position();
    this.switcher = new ModeSwitcher((p) => this.pick(p), [at[0], at[1]]);
    session.rig.setPresent(this.cam);
    session.steer = (p, stick) => this.steer(p, stick);
    session.extraParts = () => this.rivals.flatMap((r) => r.hero.parts());
    window.addEventListener('pointerdown', this.onTouch);
    window.addEventListener('keydown', this.onTouch);
    this.bar = el('div', 'course-bar', d.ui);
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.bar.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const top = el('div', 'course-top', this.bar);
    this.picker(top, 'hero', HEROES, urlParam.get('hero') ?? 'hoverbike', (v) => {
      session.choose(v as PlayHeroId);
      this.pilot = this.makePilot();
      this.go(this.areaHere());
    });
    const tools = el('div', 'course-tools', top);
    const set = this.button(tools, '⚙', 'settings', () => this.open(this.drawer.classList.contains('collapsed')));
    set.classList.add('course-set');
    const autoB = this.button(tools, '▶', 'auto', () => {
      this.auto = !this.auto;
      autoB.classList.toggle('on', this.auto);
      urlParam.set('auto', this.auto ? '1' : null);
    });
    autoB.classList.toggle('on', this.auto);
    this.button(tools, '⟲', 'restart', () => this.go(this.areaHere()));
    this.now = el('div', 'course-now', this.bar);
    this.drawer = el('div', 'course-drawer', this.bar);
    this.buildDrawer();
    this.open(urlParam.get('bar') === 'open');
    d.ui.classList.add('lab-on');
    document.body.classList.add('herolab-on');
  }

  static async start(d: CourseDeps): Promise<HeroCourse> {
    const session = await PlaySession.start({ ...d, respawnAfter: 2, cam: 'chase' });
    const hero = (urlParam.get('hero') ?? 'hoverbike') as PlayHeroId;
    if (!isPlayHero(hero)) throw new Error(`?hero=${hero}: the course has the bike, the knight, the horse and the lich`);
    const area = (urlParam.get('area') ?? 'hills') as AreaId;
    if (!AREAS.some((a) => a.id === area)) throw new Error(`?area=${area}: ${AREAS.map((a) => a.id).join(', ')}`);
    session.choose(hero, areaStart(area).at);
    const c = new HeroCourse(d, session);
    const t = urlParam.get('try');
    if (t) c.tryOut(t);
    else c.go(area);
    return c;
  }

  // ---- the drawer ---------------------------------------------------------------------------------------------------

  private buildDrawer(): void {
    const D = this.drawer;
    this.picker(D, 'try', EXPERIMENTS.map((e) => ({ id: e.id, icon: e.icon, label: e.label, hint: e.ask })), urlParam.get('try') ?? '', (v) => this.tryOut(v), { noParamUntilPicked: true });
    this.picker(D, 'go to', AREAS.map((a) => ({ id: a.id, icon: a.icon, label: a.name.toLowerCase(), hint: a.hint })), urlParam.get('area') ?? 'hills', (v) => {
      this.exp = null;
      urlParam.set('try', null);
      this.pickers.get('try')?.set([]);
      this.go(v as AreaId);
    }, { param: 'area' });
    const modes: Choice<string>[] = [{ id: 'auto', icon: '🎬', label: 'game picks', hint: 'the game picks the mode from where you are' }, ...Object.values(MODES).map((m) => ({ id: m.id, icon: m.icon, label: m.name.toLowerCase() }))];
    this.picker(D, 'mode', modes, urlParam.get('mode') ?? 'auto', (v) => {
      this.switcher.forced = v === 'auto' || !isModeId(v) ? null : v;
    });
    this.picker(D, 'forest', [{ id: 'under', icon: '🌳', label: 'under trees' }, { id: 'woods', icon: '🏃', label: 'woods run' }], urlParam.get('forest') ?? 'under', () => {});
    this.picker(D, 'zoom', [{ id: 'near', icon: '🔍', label: 'near' }, { id: 'mid', icon: '·', label: 'middle' }, { id: 'far', icon: '🔭', label: 'far' }], urlParam.get('zoom') ?? 'mid', () => this.applyMode(true));
    this.picker(D, 'lead', [{ id: 'none', icon: '⊙', label: 'centred' }, { id: 'some', icon: '→', label: 'ahead' }, { id: 'lots', icon: '⇒', label: 'far ahead' }], urlParam.get('lead') ?? 'some', () => this.applyMode(true));
    this.picker(D, 'under', [{ id: 'little', icon: '🌳', label: 'a little' }, { id: 'more', icon: '🌲', label: 'closer' }, { id: 'most', icon: '🍄', label: 'closest' }], urlParam.get('under') ?? 'more', () => {
      if (this.under && this.switcher.mode === 'under') this.under.zoomUnder = UNDER_ZOOM[this.val('under')];
    });
    this.picker(D, 'controls', [{ id: 'mode', icon: '🎮', label: "the mode's" }, { id: 'free', icon: '🕹', label: 'free stick' }], urlParam.get('ctl') ?? 'mode', () => {}, { param: 'ctl' });
    this.picker(D, 'auto-run', [{ id: 'on', icon: '⏩', label: 'runs on' }, { id: 'off', icon: '⏸', label: 'stick only' }], urlParam.get('run') ?? 'on', () => {}, { param: 'run' });
    this.picker(D, 'pace', [{ id: 'slow', icon: '🐢', label: 'slow' }, { id: 'mid', icon: '·', label: 'middle' }, { id: 'fast', icon: '🐇', label: 'fast' }], urlParam.get('pace') ?? 'mid', () => {});
    el('div', 'course-foot', D).textContent = 'The address keeps what you picked. Send it with what you thought.';
  }

  private picker(parent: HTMLElement, title: string, choices: Choice<string>[], initial: string, onChange: (v: string) => void, o: { param?: string; noParamUntilPicked?: boolean } = {}): void {
    const param = o.param ?? (title === 'go to' ? 'area' : title);
    const p = new VariantPicker<string>(parent, title, choices, {
      param: o.noParamUntilPicked && !initial ? undefined : param,
      initial: initial ? [initial] : [],
      onChange: (v) => {
        if (o.noParamUntilPicked) urlParam.set(param, v[0] ?? null);
        if (v[0] !== undefined) onChange(v[0]);
      },
    });
    this.pickers.set(title, p);
  }

  private val(title: string): string {
    const p = this.pickers.get(title);
    if (!p) throw new Error(`course: no picker ${title}`);
    return p.value[0];
  }

  private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', 'play-chip lab-chip', parent) as HTMLButtonElement;
    b.innerHTML = `<span>${icon}</span><small>${label}</small>`;
    b.addEventListener('click', onClick);
    return b;
  }

  private open(on: boolean): void {
    this.drawer.classList.toggle('collapsed', !on);
    this.bar.querySelector('.course-set')?.classList.toggle('on', on);
    urlParam.set('bar', on ? 'open' : null);
  }

  // ---- where, and which mode ----------------------------------------------------------------------------------------

  /** the mode the game picks for a point: the area's */
  private pick(p: V2): ModeId {
    switch (ROUTE.nearest(p).area) {
      case 'forest':
        return this.pickers.get('forest') ? (this.val('forest') as ModeId) : 'under';
      case 'canyon':
        return 'canyon';
      case 'cliff':
        return 'climb';
      default:
        return 'open';
    }
  }

  private areaHere(): AreaId {
    const p = this.session.hero.position();
    return ROUTE.nearest([p[0], p[1]]).area;
  }

  /** an experiment from the drawer: its hero, its area and the forest's mode */
  tryOut(id: string): void {
    const e = EXPERIMENTS.find((x) => x.id === id);
    if (!e) throw new Error(`?try=${id}: ${EXPERIMENTS.map((x) => x.id).join(', ')}`);
    this.exp = e;
    if (e.forest) this.pickers.get('forest')!.set([e.forest]);
    if (this.session.heroId !== e.hero) this.pickers.get('hero')!.set([e.hero]);
    this.go(e.area, e.at);
    this.paint();
  }

  /** a teleport: the hero on the road a little into the area, the mode there at once (no brief auto) */
  go(area: AreaId, share = 0): void {
    const st = areaStart(area, share);
    this.session.respawn(st.at);
    this.session.hero.heal();
    this.hint = ROUTE.nearest(st.at).index;
    this.pilot.start(this.hint);
    this.switcher.reset(st.at);
    this.clearRiders();
    this.clearRivals();
    this.applyMode(false, true);
    this.paint();
  }

  /** the mode's view handed to the camera (with the zoom and lead chips over it), the understory on or off */
  private applyMode(keep = false, instant = false): void {
    const m = this.modeNow();
    const v = structuredClone(m.view);
    const z = ZOOMS[this.val('zoom')];
    if (v.camera.zoom !== null) v.camera.zoom *= z;
    const lead = LEADS[this.val('lead')];
    v.camera.lookAhead = lead < 0 ? 0 : v.camera.lookAhead + lead;
    // (every mode without a facing keeps the overworld's turn: the stick stays screen-relative)
    if (m.facing === null) v.camera.azimuth = (this.session.rig.restAz * 180) / Math.PI;
    if (keep && this.cam.profile) {
      // (a chip changed: the view as it is now, no ease)
      Object.assign(this.cam.profile.camera, { zoom: v.camera.zoom, lookAhead: v.camera.lookAhead });
    } else this.cam.set(v, instant);
    this.cam.cut = m.cut;
    // (the chase's own zoom for the free modes, times the chip)
    this.session.zoomScale = m.view.camera.zoom === null ? z : 1;
    // (the understory's dither on the trees in the way: under the trees, and the woods run's side view)
    const wantUnder = m.id === 'under' || m.id === 'woods';
    if (wantUnder && !this.under) {
      const plants = this.d.api.plants;
      if (!plants) throw new Error('the course needs the world API plants (the understory)');
      this.under = new UnderstoryDriver(plants, this.d.camera, this.session, this.d.season);
    }
    if (this.under) this.under.zoomUnder = m.id === 'under' ? UNDER_ZOOM[this.val('under')] : 1;
    if (!wantUnder && this.under) {
      this.under.dispose();
      this.under = null;
      this.session.zoomScale = m.view.camera.zoom === null ? z : 1;
    }
    if (m.id !== 'canyon') this.clearRiders();
    this.bikeRun(m.id === 'canyon');
    // (the side views: the hero a tenth low, the land behind it filling the rest; the canyon run: low, the way ahead)
    this.cam.low = m.id === 'canyon' ? CANYON_LOW : m.cut !== null ? 0.1 : 0;
    this.cam.anchor = m.id === 'canyon';
    this.lastMode = m.id as ModeId;
  }

  /** (the canyon run) the bike on the physical drive with wall riding while it's on (herolab's PL43), else as it was */
  private bikeRun(on: boolean): void {
    const params = this.session.hero.params as Record<string, number>;
    if (this.bikeWas && (!on || this.bikeWas.params !== params)) {
      const w = this.bikeWas;
      Object.assign(w.params, { drive: w.drive, wallRide: w.wallRide, wallMin: w.wallMin });
      this.bikeWas = null;
    }
    if (on && !this.bikeWas && this.session.heroId === 'hoverbike') {
      this.bikeWas = { params, drive: params.drive, wallRide: params.wallRide, wallMin: params.wallMin };
      Object.assign(params, { drive: 1, wallRide: 1, wallMin: CANYON.wallMin });
      this.canyon = canyonState();
    }
  }

  private modeNow(): PlayMode {
    return MODES[this.switcher.mode];
  }

  // ---- each frame -------------------------------------------------------------------------------------------------

  private makePilot(): Autopilot {
    const p = new Autopilot(ROUTE.pts.map((q) => ({ at: q.at, speed: AREA_PACE[q.area] })), lookFor(this.session?.heroId ?? 'hoverbike'));
    return p;
  }

  /** the stick: the autopilot's or the player's, through the mode's controls */
  private steer(p: V2, stick: V2): V2 {
    const player = Math.hypot(stick[0], stick[1]) > 0.2;
    if (player) {
      this.touched = true;
      this.yieldT = 2;
    }
    const here = ROUTE.nearest(p, this.hint, 8);
    this.hint = here.index;
    this.live.area = here.area;
    let s = stick;
    if (this.auto && this.yieldT <= 0) {
      this.pilot.eyes ??= { top: (x, y) => this.session.world.top(x, y), climb: riderClimb(this.session.hero.profileClimb()) };
      s = this.pilot.steer(p);
    }
    const m = this.modeNow();
    const auto = this.switcher.autoLeft > 0;
    if (this.val('controls') === 'free') return auto ? this.pilot.steer(p) : s;
    // (the bike's canyon run: the route carries it round, the stick across rides it up a wall; the game riding — the
    // brief auto, ▶ — goes round the boulders)
    if (m.id === 'canyon' && this.bikeWas) {
      const gameRides = auto || (this.auto && this.yieldT <= 0);
      const pace = PACES[this.val('pace')] / PACES.mid;
      const fwd = Math.max(0, stick[0] * here.tan[0] + stick[1] * here.tan[1]);
      const cruise = Math.min(CANYON.vMax, CANYON.cruise * pace) * (this.val('auto-run') === 'off' && !gameRides ? fwd : 1);
      this.live.push = stick[0] * here.nrm[0] + stick[1] * here.nrm[1];
      const out = canyonStick(ROUTE, p, this.session.velocity, stick, this.canyon, this.dt, { ...CANYON, cruise }, !gameRides, BOULDERS);
      this.live.line = this.canyon.off;
      return out;
    }
    const mode: PlayMode = { ...m, assists: { ...m.assists, speed: PACES[this.val('pace')] * (m.assists.speed / 0.55), autoRun: m.assists.autoRun || this.val('auto-run') === 'on' } };
    if (m.controls === 'lane' && this.val('auto-run') === 'off') mode.assists.speed = 0;
    // (slower into a bend: the switchbacks' hairpins at the canyon's speed threw the bike into the wall)
    if (m.controls !== 'free') {
      const ahead = ROUTE.pointAt(here.s + 8).tan;
      const bend = here.tan[0] * ahead[0] + here.tan[1] * ahead[1];
      mode.assists.speed *= Math.max(0.35, bend);
    }
    // (the brief auto in a free mode: the autopilot takes the road)
    if (auto && m.controls === 'free') return this.pilot.steer(p);
    return modeStick(mode, s, here, auto);
  }

  update(dt: number): void {
    this.dt = dt;
    this.yieldT -= dt;
    const p = this.session.hero.position();
    const st = this.switcher.step(dt, [p[0], p[1]], this.touched);
    this.touched = false;
    if (st.changed || this.switcher.mode !== this.lastMode) {
      this.applyMode();
      this.paint();
    }
    if (this.live.area !== this.paintedArea) {
      this.paintedArea = this.live.area;
      this.paint();
    }
    if (st.auto !== this.live.auto) {
      this.live.auto = st.auto;
      this.paint();
    }
    this.live.mode = st.mode;
    // (the facing modes: the eye kept behind or side-on from the road's way ahead — a few cells on, smoothed)
    const m = this.modeNow();
    const prof = this.cam.profile;
    if (m.facing && prof) {
      const here = ROUTE.nearest([p[0], p[1]], this.hint, 8);
      const a = ROUTE.pointAt(here.s + 4).tan;
      const b = ROUTE.pointAt(here.s + 10).tan;
      const tan: V2 = [a[0] + b[0], a[1] + b[1]];
      const goal = (facingAzimuth(m.facing, tan) * 180) / Math.PI;
      const cur = prof.camera.azimuth ?? goal;
      const d = ((((goal - cur) % 360) + 540) % 360) - 180;
      prof.camera.azimuth = cur + d * Math.min(1, dt * 2.5);
    }
    if (m.id === 'canyon' && this.bikeWas) this.canyonRivals(dt);
    else if (m.id === 'canyon') this.canyonRiders(dt);
    if (m.id !== 'canyon' || !this.bikeWas) this.clearRivals();
    // (for the shot scripts: how high over the road's own ground the hero is — up a wall — and how far off the road)
    {
      const h = ROUTE.nearest([p[0], p[1]], this.hint, 8);
      this.live.overRoad = p[2] - this.session.world.top(h.at[0], h.at[1]);
      this.live.off = h.off;
    }
    this.session.update(dt);
  }

  /** (the canyon run) riders coming up the screen from behind every few seconds, and gone once well past */
  private canyonRiders(dt: number): void {
    this.riderT -= dt;
    const p = this.session.hero.position();
    const here = ROUTE.nearest([p[0], p[1]], this.hint, 8);
    if (this.riderT <= 0 && this.riders.length < 4) {
      this.riderT = 3;
      // (round 128b: just below the screen's bottom edge at the run's zoom — the bike sits low, ~8 cells of floor behind
      // it — and faster than the bike's cruise, so they come up the screen; from 14 cells back at 16 cells/s they never
      // caught a bike that ran on)
      const back = ROUTE.pointAt(here.s - 10);
      const side = (Math.random() - 0.5) * 4;
      const at: V2 = [back.at[0] - back.tan[1] * side, back.at[1] + back.tan[0] * side];
      const id = this.d.units.spawn('raider', at, 'f-raiders', { hostile: true, health: 2, sight: 40, speed: 24, role: 'raider' });
      this.riders.push({ id, t: 0 });
    }
    for (const r of this.riders) r.t += dt;
    const keep: typeof this.riders = [];
    for (const r of this.riders) {
      const u = this.d.units.get(r.id);
      // (a unit shows up a tick or two after its spawn: not there yet isn't gone)
      if ((!u && r.t > 2) || r.t > 14 || (u && Math.hypot(u.at[0] - p[0], u.at[1] - p[1]) > 45)) this.d.units.remove(r.id);
      else keep.push(r);
    }
    this.riders = keep;
  }

  /** (the bike's canyon run) a rider every few seconds just below the screen's bottom edge, a little faster than the
   *  hero; each rides the run's line in its lane, passes, and is gone once well ahead or left behind */
  private canyonRivals(dt: number): void {
    const p = this.session.hero.position();
    const here = ROUTE.nearest([p[0], p[1]], this.hint, 8);
    this.rivalT -= dt;
    if (this.rivalT <= 0 && this.rivals.length < 2) {
      this.rivalT = 4;
      const back = ROUTE.pointAt(here.s - 9);
      const lane = Math.random() < 0.5 ? -0.4 : 0.4;
      const n: V2 = [-back.tan[1], back.tan[0]];
      const at: V2 = [back.at[0] + n[0] * lane * 6, back.at[1] + n[1] * lane * 6];
      // (on the bike's own drive — its top 32 — so they come past a hero on the run's physical drive, top 22)
      const hero = makeHero('hoverbike', this.session.world, at, { drive: 0 });
      const v = this.session.velocity;
      const sp = Math.hypot(v[0], v[1]) + 5;
      const b = (hero as unknown as { b: { vx: number; vy: number; heading: number } }).b;
      b.vx = back.tan[0] * sp;
      b.vy = back.tan[1] * sp;
      b.heading = Math.atan2(back.tan[1], back.tan[0]);
      this.rivals.push({ hero, st: canyonState(), lane, t: 0, hitT: 0 });
    }
    const keep: typeof this.rivals = [];
    for (const r of this.rivals) {
      r.t += dt;
      r.hitT -= dt;
      const q = r.hero.position();
      const h = ROUTE.nearest([q[0], q[1]], r.st.hint, 8);
      const push: V2 = [h.nrm[0] * r.lane, h.nrm[1] * r.lane];
      const vel: V2 = [Math.cos(r.hero.heading()) * r.hero.speed(), Math.sin(r.hero.heading()) * r.hero.speed()];
      const dir = canyonStick(ROUTE, [q[0], q[1]], vel, push, r.st, dt, { ...CANYON, cruise: CANYON.vMax }, true, BOULDERS);
      r.hero.update(dt, { move: dir, input: { ...NO_INPUT, dir } });
      // (a rider's touch knocks the hero)
      if (r.hitT <= 0 && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1.3 && Math.abs(q[2] - p[2]) < 1.5) {
        r.hitT = 1;
        this.session.hero.take(1, [q[0], q[1]]);
      }
      const ahead = h.s - here.s;
      if (r.t < 14 && ahead < 30 && ahead > -20 && h.area === 'canyon') keep.push(r);
    }
    this.rivals = keep;
  }

  private clearRivals(): void {
    this.rivals = [];
  }

  private clearRiders(): void {
    for (const r of this.riders) this.d.units.remove(r.id);
    this.riders = [];
  }

  /** the line under the bar: the mode, and the experiment's question; "Touch to take over" in the brief auto */
  private paint(): void {
    const m = this.modeNow();
    const area = AREAS.find((a) => a.id === this.areaHere());
    const lines = [`${m.icon} ${m.name}${area ? ` · ${area.name}` : ''}${this.switcher.autoLeft > 0 ? ' · touch to take over' : ''}`];
    // (the experiment's question while the hero is in its area)
    if (this.exp && area?.id === this.exp.area) lines.push(this.exp.ask);
    this.now.textContent = lines.join('\n');
  }

  shift(dx: number, dy: number, dz: number): void {
    this.session.shift(dx, dy, dz);
    for (const r of this.rivals) r.hero.shift(dx, dy, dz);
  }

  get stats() {
    return this.session.stats;
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onTouch);
    window.removeEventListener('keydown', this.onTouch);
    this.clearRiders();
    this.clearRivals();
    this.bikeRun(false);
    this.under?.dispose();
    this.session.rig.setPresent(null);
    for (const p of this.pickers.values()) p.dispose();
    this.bar.remove();
    this.d.ui.classList.remove('lab-on');
    document.body.classList.remove('herolab-on');
    this.session.dispose();
  }
}
