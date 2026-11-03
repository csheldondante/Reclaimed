// ---- play/lab/herolab.ts ----------------------------------------------------------------------------------------
// (round 121, herolab; BACKLOG HL1, CAM1) The hero lab: `?skipmenu=1&level=herolab` — play's hero (PlaySession, the
// same as the sandbox and a run) on the lab's test terrains. The user (round 120): "we need a variety of settings to
// try in different terrains to see what works."
//   lab        the kinds of station: camera (the six terrains), moves (the bike's handling on the canyon and the city:
//              PL30), traits (the Traits Lab's scenes with a hero: LW1); puzzles, enemies and the combat gym slot in
//   station    the stations of that kind (one tap: the hero dropped at its ride's start)
//   hero       the bike, the lich or the knight (round 128)
//   camera     the camera modes (multi: they combine; `?cam=`; the default cut + tilt, round 120)
//   handling   (moves) the bike's turning and steering-assist variants (multi; `?handling=`)
//   scenes     (traits) a crowd, smite, raise, sanctuary, fear, petrify, clear (levels/traitstation.ts TRAIT_SCENES)
//   tests      (round 128) the test menu: per hero, the things worth trying, each one tap (play/lab/tests.ts); the line
//              under the bar says what's on in plain words and the question to answer
//   enemy      (round 128) the knight's raiders (play/sandbox/station.ts: wave, dummies, clear, the readout) on the hills
//   tools      the autopilot (▶: rides the station's path; touch the stick to take over for a moment), back to the start
//   on screen  the way ahead: ✓ where it goes on round a turn, ✕ where it ends (an arrow at the edge off the screen);
//              the camera's and the handling's numbers behind their buttons on the right
// Address: ?station=<id> ?cam=cutaway+tilt ?hero=hoverbike|lich|knight ?handling=grip+corridor ?auto=0 ?camtune=
// ?handtune= ?test=<id> (a test from the menu); no ?station= and no ?test=: the test menu first

import type { CamModeId, V2 } from '../../api/contracts/camera';
import type { Units } from '../../api/contracts/units';
import type { Sim } from '../../api/world';
import { runTraitScene, TRAIT_SCENES, type TraitStationDriver } from '../../levels/traitstation';
import type { Camera } from '../../render/camera';
import type { Renderer } from '../../render/renderer';
import { TunePanel } from '../../ui/tunepanel';
import { PointsSource } from '../camera/interests';
import { CAM_TUNING } from '../camera/params';
import { CamMetrics, type MetricsSummary } from '../camera/metrics';
import { CAM_MODES, camString, DEFAULT_CAM, parseCam } from '../camera/rig';
import { isPlayHero, type PlayHeroId } from '../heroes/make';
import { Station, type StationHost } from '../sandbox/station';
import { el, PlaySession, type SessionDeps } from '../session';
import { Autopilot, lookFor, riderClimb, type AutoPath } from './autopilot';
import { applyTurn, assistOn, HANDLING, HANDLING_VARIANTS, parseHandling, steerParams, useHandling, type HandlingId } from './handling';
import { STATION_KINDS, Stations, urlParam, VariantPicker, type LabStation, type StationKind } from './lab';
import { HILL, HILL_RIDE, LAB_TERRAINS, TOUR, type LabTerrain } from './terrains';
import { ASSIST_CHOICES, ASSIST_LEVEL, DRIVE_CHOICES, parseAssist, parseDrive, type AssistChoice, type DriveChoice } from './drivechoice';
import { describe, findTest, LAB_TESTS, type LabTest } from './tests';
import '../sandbox/sandbox.css';
import './herolab.css';

export interface HeroLabDeps {
  ui: HTMLElement;
  api: Sim;
  units: Units;
  camera: Camera;
  renderer: Renderer;
  device: GPUDevice;
  bounds: [number, number];
  /** (merge123) the world's raise dead for play's lich (SessionDeps.raise) */
  raise?: SessionDeps['raise'];
  /** (round 120, LW1) the traits' scenes over this level's agents, round a point (levels/traitstation.ts TraitStation); absent: no traits station */
  traitScene?: (at: V2) => TraitStationDriver;
}

/** what a station is given */
export interface LabContext {
  lab: HeroLab;
  session: PlaySession;
}

/** seconds the autopilot yields after the player touches the stick */
const TAKE_OVER = 2;

export class HeroLab {
  readonly stations: Stations<LabContext>;
  private bar: HTMLElement;
  private pickers: VariantPicker<string>[] = [];
  private byName = new Map<string, VariantPicker<string>>();
  private metrics: CamMetrics | null = null;
  private panel: TunePanel;
  private handPanel: TunePanel;
  /** the station row (rebuilt for the kind picked) and the kind's own row (handling chips, a station's actions) */
  private stationRow: HTMLElement;
  private kindRow: HTMLElement;
  private stationPicker: VariantPicker<string> | null = null;
  private handPicker: VariantPicker<HandlingId>;
  private drivePicker: VariantPicker<DriveChoice>;
  private assistPicker: VariantPicker<AssistChoice>;
  kind: StationKind;
  /** the autopilot round the station's path; null: the player rides */
  pilot: Autopilot | null = null;
  auto: boolean;
  private yieldT = 0;
  private resize: ResizeObserver;
  private traits: TraitStationDriver | null = null;
  /** (round 128) the enemy station's tools while it's the one */
  private enemy: Station | null = null;
  /** (round 128) what's on, in plain words, and the test's question */
  private now: HTMLElement;
  private menu: HTMLElement;
  /** the test picked from the menu (null: chips picked by hand) */
  test: LabTest | null = null;
  /** the camera metrics live (the perf overlay's line, and scripts/herolab.mjs) */
  readonly live = { frames: 0, cam: '' };

  private constructor(
    readonly d: HeroLabDeps,
    readonly session: PlaySession,
    first: string,
  ) {
    this.auto = urlParam.get('auto') !== '0';
    const ctx: LabContext = { lab: this, session };
    this.stations = new Stations(this.allStations(), ctx);
    // (the autopilot holds the stick until the player pushes it)
    session.steer = (p: V2, stick: V2) => {
      if (Math.hypot(stick[0], stick[1]) > 0.2) this.yieldT = TAKE_OVER;
      if (!this.auto || !this.pilot || this.yieldT > 0) return stick;
      return this.pilot.steer(p);
    };
    this.bar = el('div', 'lab-bar', d.ui);
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.bar.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const firstStation = this.stations.list.find((s) => s.id === first);
    if (!firstStation) throw new Error(`?station=${first}: no such station (${this.stations.list.map((s) => s.id).join(', ')})`);
    this.kind = firstStation.kind;
    const kinds = new VariantPicker<StationKind>(this.bar, 'lab', STATION_KINDS.map((k) => ({ id: k.kind, icon: k.icon, label: k.kind, hint: k.name })), {
      initial: [this.kind],
      onChange: (v) => {
        const list = this.stations.ofKind(v[0]);
        if (!list.length) {
          this.toast(`${STATION_KINDS.find((k) => k.kind === v[0])!.name}: no stations yet — the framework is ready for them (BACKLOG HL3)`);
          kinds.set([this.kind]);
          return;
        }
        this.kind = v[0];
        this.showStations(list[0].id);
      },
    });
    this.pickers.push(kinds as unknown as VariantPicker<string>);
    this.stationRow = el('div', 'lab-slot', this.bar);
    const hero = (urlParam.get('hero') ?? 'hoverbike') as PlayHeroId;
    this.pickers.push(
      new VariantPicker<PlayHeroId>(this.bar, 'hero', [
        { id: 'hoverbike', icon: '🏍', label: 'bike' },
        { id: 'lich', icon: '💀', label: 'lich' },
        { id: 'knight', icon: '🗡️', label: 'knight' },
        { id: 'horse', icon: '🐎', label: 'horse' },
      ], {
        param: 'hero',
        initial: [hero],
        onChange: (v) => {
          session.choose(v[0]);
          this.applyHandling();
          this.applyDrive();
          this.go(this.stations.current?.id ?? 'cliff');
        },
      }) as unknown as VariantPicker<string>,
    );
    const cam = parseCam(urlParam.get('cam'));
    this.pickers.push(
      new VariantPicker<CamModeId>(this.bar, 'camera', CAM_MODES.map((m) => ({ id: m.id, icon: m.icon, label: m.label, hint: m.hint })), {
        multi: true,
        fixed: ['chase'],
        param: 'cam',
        initial: cam,
        format: (v) => camString(v),
        onChange: (v) => {
          session.setCam(v);
          this.live.cam = camString(v);
          this.paintNow();
        },
      }) as unknown as VariantPicker<string>,
    );
    this.live.cam = camString(cam);
    // (round 128, the user: "velocity based controllers for the root motion ... I would be curious to use that here for
    // the knight and to know it generalizes to the hoverbike") the root motion: the hero's own, the physical drive
    // (core/drive.ts), or the brute's profile on the knight
    this.drivePicker = new VariantPicker<DriveChoice>(this.bar, 'drive', DRIVE_CHOICES, {
      param: 'drive',
      initial: [parseDrive(urlParam.get('drive'))],
      format: (v) => (v[0] === 'own' ? '' : v[0]),
      onChange: () => {
        this.applyDrive();
        this.paintNow();
      },
    });
    this.byName.set('drive', this.drivePicker as unknown as VariantPicker<string>);
    // (round 128, the horse) how hard the horse helps: strong (the point), light, off
    this.assistPicker = new VariantPicker<AssistChoice>(this.bar, 'assist', ASSIST_CHOICES, {
      param: 'assist',
      initial: [parseAssist(urlParam.get('assist'))],
      format: (v) => (v[0] === 'strong' ? '' : v[0]),
      onChange: () => {
        this.applyDrive();
        this.paintNow();
      },
    });
    this.byName.set('assist', this.assistPicker as unknown as VariantPicker<string>);
    this.kindRow = el('div', 'lab-slot', this.bar);
    // (the bike's handling variants: the moves stations show them)
    const hs = urlParam.get('handtune');
    useHandling(HANDLING, parseHandling(urlParam.get('handling')));
    if (hs) HANDLING.apply(HANDLING.decode(hs));
    this.handPicker = new VariantPicker<HandlingId>(this.kindRow, 'handling', HANDLING_VARIANTS.map((v) => ({ id: v.id, icon: v.icon, label: v.label, hint: v.hint })), {
      multi: true,
      fixed: ['stock'],
      param: 'handling',
      initial: parseHandling(urlParam.get('handling')),
      format: (v) => v.filter((x) => x !== 'stock').join('+') || 'stock',
      onChange: (v) => {
        useHandling(HANDLING, v.filter((x) => x !== 'stock'));
        this.applyHandling();
        this.paintNow();
      },
    });
    HANDLING.onChange(() => this.applyHandling());
    for (const p of this.pickers) this.byName.set(p.title, p);
    this.byName.set('handling', this.handPicker as unknown as VariantPicker<string>);
    const tools = el('div', 'lab-row lab-keep', this.bar);
    const testsBtn = el('button', 'play-chip lab-chip', tools) as HTMLButtonElement;
    testsBtn.innerHTML = '<span>☰</span><small>tests</small>';
    testsBtn.title = 'the test menu';
    testsBtn.addEventListener('click', () => this.showMenu(true));
    // (main's review, round 128: the bar took the top third of the phone, over what's being tested — one row by default,
    // the chip rows behind ⚙; ?bar=open keeps them open)
    const setBtn = el('button', 'play-chip lab-chip', tools) as HTMLButtonElement;
    setBtn.innerHTML = '<span>⚙</span><small>settings</small>';
    setBtn.title = 'the lab, station, hero, camera and handling chips';
    const open = (on: boolean) => {
      this.bar.classList.toggle('collapsed', !on);
      setBtn.classList.toggle('on', on);
      urlParam.set('bar', on ? 'open' : null);
    };
    setBtn.addEventListener('click', () => open(this.bar.classList.contains('collapsed')));
    open(urlParam.get('bar') === 'open');
    const autoBtn = el('button', 'play-chip lab-chip', tools) as HTMLButtonElement;
    autoBtn.innerHTML = '<span>▶</span><small>auto</small>';
    autoBtn.title = 'the autopilot rides the station\'s path (touch the stick to take over for a moment)';
    autoBtn.classList.toggle('on', this.auto);
    autoBtn.addEventListener('click', () => {
      this.auto = !this.auto;
      autoBtn.classList.toggle('on', this.auto);
      urlParam.set('auto', this.auto ? null : '0');
    });
    const back = el('button', 'play-chip lab-chip', tools) as HTMLButtonElement;
    back.innerHTML = '<span>⟲</span><small>start</small>';
    back.title = 'back to the start of the ride';
    back.addEventListener('click', () => this.go(this.stations.current?.id ?? 'cliff'));
    this.now = el('div', 'lab-now', this.bar);
    this.menu = this.buildMenu();
    // (what's under the bar sits under it, however it wraps)
    d.ui.classList.add('lab-on');
    // (the level's own goal meter, "65%", isn't the lab's: it sat under the bar)
    document.body.classList.add('herolab-on');
    this.resize = new ResizeObserver(() => d.ui.style.setProperty('--lab-h', `${this.bar.getBoundingClientRect().bottom}px`));
    this.resize.observe(this.bar);
    // (the camera's numbers: ?camtune= a copied link's)
    const s = urlParam.get('camtune');
    if (s) {
      const unknown = CAM_TUNING.apply(CAM_TUNING.decode(s));
      if (unknown.length) console.warn(`[herolab] ?camtune= has parameters this build doesn't know: ${unknown.join(', ')}`);
    }
    this.panel = new TunePanel(d.ui, {
      registry: CAM_TUNING,
      store: 'reclaimed.herolab.cam',
      urlParam: 'camtune',
      label: '🎥 camera',
      cls: 'herolab',
      open: ['ahead'],
      visible: (def) => def.group === 'chase' || def.group === 'ahead' || session.rig.ids.includes(def.group as CamModeId),
    });
    this.handPanel = new TunePanel(d.ui, {
      registry: HANDLING,
      store: 'reclaimed.herolab.handling',
      urlParam: 'handtune',
      label: '🏍 handling',
      cls: 'herolab-hand',
      open: ['turn', 'assist'],
    });
    session.setCam(cam);
    this.applyHandling();
    this.applyDrive();
    this.showStations(first);
    const t = urlParam.get('test');
    if (t) this.runTest(findTest(t));
    else this.showMenu(urlParam.get('station') === null);
  }

  static async start(d: HeroLabDeps): Promise<HeroLab> {
    const session = await PlaySession.start({ ...d, respawnAfter: 2, cam: camString(parseCam(urlParam.get('cam'))) });
    const hero = (urlParam.get('hero') ?? 'hoverbike') as PlayHeroId;
    if (!isPlayHero(hero)) throw new Error(`?hero=${hero}: the lab has the hoverbike, the lich and the knight (the walker isn't a play hero yet)`);
    const first = urlParam.get('station') ?? 'cliff';
    session.choose(hero, LAB_TERRAINS[0].path[0].at);
    return new HeroLab(d, session, first);
  }

  // ---- the stations ---------------------------------------------------------------------------------------------

  private allStations(): LabStation<LabContext>[] {
    const out = LAB_TERRAINS.map((t) => this.rideStation(t, 'camera', t.id, t.name, t.hint, t.path));
    // (round 128, the user's camera intent) the tour: field, shrubs, low trees, tall woods, a cliff, a town in one loop
    out.push(this.rideStation(TOUR, 'camera', TOUR.id, TOUR.name, TOUR.hint, TOUR.path));
    // (round 120, PL30) the bike's handling where precision matters: the canyon and the city, with the handling chips
    for (const id of ['canyon', 'city']) {
      const t = LAB_TERRAINS.find((x) => x.id === id)!;
      out.push(this.rideStation(t, 'moves', `moves-${id}`, `Handling: ${t.name}`, 'the bike\'s turning and steering assist (the chips under the camera\'s); the player\'s strong steer always wins', t.path));
    }
    // (round 120, LW1) the traits' scenes on the hills, ridden through: a figure of eight through the middle
    if (this.d.traitScene) {
      const t = LAB_TERRAINS.find((x) => x.id === 'hills')!;
      const mid: V2 = [(t.rect[0] + t.rect[2]) / 2, (t.rect[1] + t.rect[3]) / 2];
      const st = this.rideStation(t, 'traits', 'traits', 'Traits', 'the living and the walking dead: smite them, raise the fallen with the lich (💀 raise), ride the bike through the sanctuary that heals the living and burns the undead', figureEight(mid, 13, 16));
      st.actions = TRAIT_SCENES.map((sc) => ({ label: sc.label, icon: sc.icon, run: () => runTraitScene(this.traitDriver(mid), sc.id) }));
      out.push(st);
    }
    // (round 128, the physical drive) the hill: a run-up, then a ramp steeper than the knight climbs from standing
    {
      const t: LabTerrain = { id: 'hill', name: 'Hill', hint: 'a run-up, then a slope too steep to walk up from standing', rect: [HILL.x0, HILL.y0, HILL.x1, HILL.y1], path: HILL_RIDE, pois: [] };
      const st = this.rideStation(t, 'moves', 'hill', t.name, t.hint, HILL_RIDE);
      st.icon = '⛰';
      st.actions = [
        { label: 'Run-up', icon: '🏃', run: ({ session }) => session.respawn(HILL_RIDE[0].at) },
        { label: 'Standing start', icon: '🧍', run: ({ session }) => session.respawn([HILL.foot - 0.2, HILL_RIDE[0].at[1]]) },
      ];
      out.push(st);
    }
    // (round 128) the knight's raiders (play/sandbox/station.ts) on the hills, for every hero; no autopilot
    {
      const t = LAB_TERRAINS.find((x) => x.id === 'hills')!;
      const at: V2 = [(t.rect[0] + t.rect[2]) / 2 - 10, (t.rect[1] + t.rect[3]) / 2];
      out.push({
        id: 'enemy',
        kind: 'enemy',
        name: 'Raiders',
        icon: '👹',
        hint: 'Wave sends raiders at you, one more each time. Dummies stand still and take hits.',
        enter: ({ session }) => {
          this.pilot = null;
          session.respawn(at);
          this.d.camera.azimuth = session.rig.frame.view.azimuth = session.rig.restAz;
          session.rig.sources.length = 0;
          const host: StationHost = {
            d: this.d,
            world: session.world,
            get hero() {
              return session.hero;
            },
          };
          this.enemy = new Station(host, { place: false });
          this.showKindRow();
        },
        update: () => this.enemy?.update(0),
        leave: () => {
          this.enemy?.dispose();
          this.enemy = null;
        },
      });
    }
    return out;
  }

  private traitDriver(at: V2): TraitStationDriver {
    if (!this.d.traitScene) throw new Error('the hero lab has no trait system here');
    return (this.traits ??= this.d.traitScene(at));
  }

  /** a station ridden on a terrain: the hero at its ride's start, the autopilot on its path, its points of interest */
  private rideStation(t: LabTerrain, kind: StationKind, id: string, name: string, hint: string, path: AutoPath[]): LabStation<LabContext> {
    return {
      id,
      kind,
      name,
      icon: kind === 'traits' ? '✨' : ICONS[t.id],
      hint,
      enter: ({ session }) => {
        this.pilot = new Autopilot(path, lookFor(session.heroId));
        // (round 128: the rider model steers round what's in its line, as a thumb would)
        this.pilot.eyes = { top: (x, y) => session.world.top(x, y), climb: riderClimb(session.hero.profileClimb()) };
        const st = this.pilot.start();
        session.respawn(st.at);
        const rig = session.rig;
        rig.frame.view.azimuth = rig.restAz;
        rig.frame.view.elevation = (30 * Math.PI) / 180;
        this.d.camera.azimuth = rig.restAz;
        this.d.camera.elevation = (30 * Math.PI) / 180;
        rig.sources.length = 0;
        const top = (p: V2) => session.world.top(p[0], p[1]);
        if (t.pois.length) rig.sources.push(new PointsSource('poi', 'objective', () => t.pois.map((p): [number, number, number] => [p[0], p[1], top(p)]), 0.6, 2));
        this.showKindRow();
      },
    };
  }

  /** the station chips for the kind now */
  private showStations(id: string): void {
    this.stationPicker?.dispose();
    const list = this.stations.ofKind(this.kind);
    this.stationPicker = new VariantPicker<string>(this.stationRow, 'station', list.map((s) => ({ id: s.id, icon: s.icon ?? '·', label: s.id.replace('moves-', ''), hint: `${s.name}: ${s.hint}` })), {
      param: 'station',
      initial: [list.some((s) => s.id === id) ? id : list[0].id],
      onChange: (v) => this.go(v[0]),
    });
    this.byName.set('station', this.stationPicker);
    this.go(this.stationPicker.value[0]);
  }

  /** the kind's own row: the handling chips (moves), the station's actions (traits) */
  private showKindRow(): void {
    const s = this.stations.current;
    this.handPicker.el.style.display = s?.kind === 'moves' && this.session.heroId === 'hoverbike' ? '' : 'none';
    this.kindRow.querySelector('.lab-actions')?.remove();
    if (s?.actions?.length) {
      const row = el('div', 'lab-row lab-actions lab-keep', this.kindRow);
      const t = el('span', 'lab-row-title', row);
      t.textContent = 'scenes';
      for (const a of s.actions) {
        const b = el('button', 'play-chip lab-chip', row) as HTMLButtonElement;
        b.innerHTML = `<span>${a.icon ?? '·'}</span><small>${a.label}</small>`;
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', () => a.run({ lab: this, session: this.session }));
      }
    }
  }

  /** (round 128) the drive picked into the hero's params (0 its own, 1 physical, 2 the brute's — the knight's only) */
  private applyDrive(): void {
    if (!this.drivePicker) return;
    const v = this.drivePicker.value[0];
    const params = this.session.hero.params as Record<string, number>;
    const horse = this.session.heroId === 'horse';
    // (the horse has only the physical drive; its assist from the chips)
    params.drive = horse || v !== 'own' ? (v === 'brute' && this.session.heroId === 'knight' ? 2 : 1) : 0;
    // (round 128, the user's wall riding: the bike on the physical drive rides walls)
    if (this.session.heroId === 'hoverbike') params.wallRide = params.drive ? 1 : 0;
    if (this.assistPicker) {
      this.assistPicker.el.style.display = horse ? '' : 'none';
      if (horse) params.assist = ASSIST_LEVEL[this.assistPicker.value[0]];
    }
  }

  /** the handling's numbers into the bike: its turning onto its params, the assist onto the session */
  private applyHandling(): void {
    const h = this.session.hero;
    const bike = this.session.heroId === 'hoverbike';
    // (the handling's button is the bike's only)
    if (this.handPanel) {
      this.handPanel.button.classList.toggle('lab-off', !bike);
      if (!bike) this.handPanel.toggle(false);
    }
    if (!bike) {
      this.session.assist = null;
      return;
    }
    applyTurn(HANDLING.values, h.params);
    const a = steerParams(HANDLING.values);
    this.session.assist = assistOn(a) ? a : null;
  }

  go(id: string): void {
    this.stations.go(id);
    this.paintNow();
  }

  // ---- the test menu (round 128) ----------------------------------------------------------------------------------

  private buildMenu(): HTMLElement {
    const m = el('div', 'lab-menu', this.d.ui);
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) m.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const head = el('div', 'lab-menu-head', m);
    el('div', 'lab-menu-title', head).textContent = 'Hero lab: what to try';
    const close = el('button', 'play-small', head) as HTMLButtonElement;
    close.textContent = 'Close';
    close.addEventListener('click', () => this.showMenu(false));
    for (const g of LAB_TESTS) {
      el('div', 'lab-menu-hero', m).textContent = g.title;
      const row = el('div', 'lab-menu-row', m);
      for (const t of g.tests) {
        if (!this.stations.list.some((s) => s.id === t.station)) throw new Error(`lab test ${t.id}: no station "${t.station}"`);
        const b = el('button', 'lab-menu-test', row) as HTMLButtonElement;
        b.textContent = t.label;
        b.dataset.test = t.id;
        b.addEventListener('click', () => this.runTest(t));
      }
    }
    el('div', 'lab-menu-foot', m).textContent = 'The address keeps what you picked. Send it with what you thought.';
    return m;
  }

  showMenu(on: boolean): void {
    this.menu.classList.toggle('on', on);
  }

  /** a test from the menu: its hero, station, handling and camera, as the chips would pick them */
  runTest(t: LabTest): void {
    this.showMenu(false);
    this.pick({ hero: t.hero, station: t.station, cam: t.cam ?? camString(DEFAULT_CAM), handling: t.handling ?? 'stock', drive: t.drive ?? 'own' });
    this.test = t;
    urlParam.set('test', t.id);
    this.paintNow();
    // (knight pass 2) the station's own buttons the test starts with (a wave, guards, the course, a parry chip)
    for (const label of t.press ?? []) {
      const b = [...this.d.ui.querySelectorAll<HTMLButtonElement>('.play-station button')].find((x) => x.textContent === label);
      if (!b) throw new Error(`lab test ${t.id}: the station has no "${label}" button`);
      b.click();
    }
  }

  /** the line under the bar: what's on in plain words, and the test's question */
  private paintNow(): void {
    const cur = this.stations.current;
    if (!this.now || !cur) return;
    const hero = this.session.heroId;
    // (a hero or a station picked by hand after a test: its question no longer applies)
    const t = this.test;
    if (t && (t.hero !== hero || t.station !== cur.id)) {
      this.test = null;
      urlParam.set('test', null);
    }
    const text = describe({ hero, station: cur.id, handling: this.handPicker.value, cam: this.session.rig.ids, drive: this.drivePicker?.value[0] });
    const ask = this.test?.ask ?? (cur.kind === 'enemy' ? cur.hint : '');
    this.now.textContent = ask ? `${text}\n${ask}` : text;
  }

  /** (scripts/herolab.mjs) a station, the camera modes (`?cam=` form), a hero and handling, as the chips would pick them */
  pick(o: { station?: string; cam?: string; hero?: PlayHeroId; handling?: string; drive?: string }): void {
    // (a station picked: the menu's done with)
    if (o.station) this.showMenu(false);
    if (o.hero) this.byName.get('hero')!.set([o.hero]);
    if (o.cam) this.byName.get('camera')!.set(parseCam(o.cam));
    if (o.handling) this.handPicker.set(['stock', ...parseHandling(o.handling).filter((x) => x !== 'stock')]);
    if (o.drive) this.drivePicker.set([parseDrive(o.drive)]);
    if (o.station) {
      const s = this.stations.list.find((x) => x.id === o.station);
      if (!s) throw new Error(`pick: no station ${o.station}`);
      if (s.kind !== this.kind) {
        this.kind = s.kind;
        this.byName.get('lab')!.set([s.kind]);
      }
      this.showStations(o.station);
    }
  }

  /** (scripts/herolab.mjs) a station's action by its label (the traits' scenes) */
  act(label: string): void {
    const a = this.stations.current?.actions?.find((x) => x.label === label);
    if (!a) throw new Error(`act: the station has no "${label}"`);
    a.run({ lab: this, session: this.session });
  }

  /** (scripts/herolab.mjs) the traits on the scene's agents (null: no scene yet) */
  async census(): Promise<Record<string, number> | null> {
    return this.traits ? this.traits.census() : null;
  }

  /** (scripts/herolab.mjs) the camera metrics over the next `secs` of play, on the live world (play/camera/metrics.ts) */
  async measure(secs: number): Promise<MetricsSummary> {
    const m = (this.metrics = new CamMetrics());
    await new Promise((r) => setTimeout(r, secs * 1000));
    this.metrics = null;
    return m.summary();
  }

  update(dt: number): void {
    this.yieldT -= dt;
    this.stations.update(dt);
    this.session.update(dt);
    this.live.frames++;
    if (this.metrics) this.metrics.add(dt, this.session.rig.frame, this.session.rig.interests, this.session.camSight);
  }

  /** (a lab level isn't streamed; kept for the level's hooks) */
  shift(dx: number, dy: number, dz: number): void {
    this.session.shift(dx, dy, dz);
  }

  get stats() {
    return this.session.stats;
  }

  private toast(text: string): void {
    const t = el('div', 'play-toast', this.d.ui);
    t.style.pointerEvents = 'none';
    t.textContent = text;
    setTimeout(() => t.classList.add('fade'), 4000);
    setTimeout(() => t.remove(), 5500);
  }

  dispose(): void {
    this.resize.disconnect();
    this.d.ui.classList.remove('lab-on');
    document.body.classList.remove('herolab-on');
    for (const p of this.pickers) p.dispose();
    this.stationPicker?.dispose();
    this.handPicker.dispose();
    this.traits?.clear();
    this.enemy?.dispose();
    this.menu.remove();
    this.bar.remove();
    this.panel.dispose();
    this.handPanel.dispose();
    this.session.dispose();
  }
}

/** a figure of eight round `mid` (half-width w, half-height h), crossing itself at the middle */
function figureEight(mid: V2, w: number, h: number): AutoPath[] {
  const out: AutoPath[] = [];
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    out.push({ at: [mid[0] + Math.sin(2 * a) * w, mid[1] + Math.sin(a) * h], speed: 0.55 });
  }
  return out;
}

const ICONS: Record<string, string> = { cliff: '🧗', canyon: '🏜', forest: '🌲', city: '🏙', cave: '🕳', hills: '⛰', tour: '🧭' };
