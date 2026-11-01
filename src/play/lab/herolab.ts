// ---- play/lab/herolab.ts ----------------------------------------------------------------------------------------
// (round 121, herolab; BACKLOG HL1, CAM1) The hero lab: `?skipmenu=1&level=herolab` — play's hero (PlaySession, the
// same as the sandbox and a run) on the lab's test terrains, with every camera mode a chip. The user (round 120): "we
// need a variety of settings to try in different terrains to see what works."
//   top        the stations (one tap: the hero dropped at its ride's start), the kinds of station (camera now;
//              abilities, puzzles, enemies, the combat gym slot in), the hero
//   under it   the camera modes (multi: they combine; `?cam=`), the autopilot (▶: rides the station's path; touch the
//              stick to take over for a moment), the camera's tuning (every mode's numbers, sliders)
//   on screen  the way ahead: a green ✓ where it goes on round a turn, a red ✕ where it ends (an arrow at the edge
//              when it's off the screen)
// Address: ?station=cliff|canyon|forest|city|cave|hills  ?cam=rotate+dither  ?hero=hoverbike|lich  ?auto=0  ?camtune=

import type { CamModeId, V2 } from '../../api/contracts/camera';
import type { Units } from '../../api/contracts/units';
import type { Sim } from '../../api/world';
import type { Camera } from '../../render/camera';
import type { Renderer } from '../../render/renderer';
import { TunePanel } from '../../ui/tunepanel';
import { PointsSource } from '../camera/interests';
import { CAM_TUNING } from '../camera/params';
import { CamMetrics, type MetricsSummary } from '../camera/metrics';
import { CAM_MODES, camString, parseCam } from '../camera/rig';
import type { PlayHeroId } from '../heroes/make';
import { el, PlaySession } from '../session';
import { Autopilot } from './autopilot';
import { STATION_KINDS, Stations, urlParam, VariantPicker, type LabStation, type StationKind } from './lab';
import { LAB_TERRAINS, type LabTerrain } from './terrains';
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
  private hint: HTMLElement;
  /** the autopilot round the station's path; null: the player rides */
  pilot: Autopilot | null = null;
  auto: boolean;
  private yieldT = 0;
  private resize: ResizeObserver;
  /** the camera metrics live (the perf overlay's line, and scripts/herolab.mjs) */
  readonly live = { frames: 0, cam: '' };

  private constructor(
    readonly d: HeroLabDeps,
    readonly session: PlaySession,
  ) {
    this.auto = urlParam.get('auto') !== '0';
    const ctx: LabContext = { lab: this, session };
    this.stations = new Stations(LAB_TERRAINS.map((t) => this.terrainStation(t)), ctx);
    // (the autopilot holds the stick until the player pushes it)
    session.steer = (p: V2, stick: V2) => {
      if (Math.hypot(stick[0], stick[1]) > 0.2) this.yieldT = TAKE_OVER;
      if (!this.auto || !this.pilot || this.yieldT > 0) return stick;
      return this.pilot.steer(p);
    };
    this.bar = el('div', 'lab-bar', d.ui);
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.bar.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const initialStation = urlParam.get('station') ?? 'cliff';
    if (!LAB_TERRAINS.some((t) => t.id === initialStation)) throw new Error(`?station=${initialStation}: no such station (${LAB_TERRAINS.map((t) => t.id).join(', ')})`);
    const kinds = new VariantPicker<StationKind>(this.bar, 'lab', STATION_KINDS.map((k) => ({ id: k.kind, icon: k.icon, label: k.kind, hint: k.name })), {
      initial: ['camera'],
      onChange: (v) => {
        if (!this.stations.ofKind(v[0]).length) {
          this.toast(`${STATION_KINDS.find((k) => k.kind === v[0])!.name}: no stations yet — the framework is ready for them (BACKLOG HL1)`);
          kinds.set(['camera']);
        }
      },
    });
    this.pickers.push(kinds as unknown as VariantPicker<string>);
    this.pickers.push(
      new VariantPicker(this.bar, 'terrain', LAB_TERRAINS.map((t) => ({ id: t.id, icon: ICONS[t.id] ?? '·', label: t.id, hint: `${t.name}: ${t.hint}` })), {
        param: 'station',
        initial: [initialStation],
        onChange: (v) => this.go(v[0]),
      }),
    );
    const hero = (urlParam.get('hero') ?? 'hoverbike') as PlayHeroId;
    this.pickers.push(
      new VariantPicker<PlayHeroId>(this.bar, 'hero', [
        { id: 'hoverbike', icon: '🏍', label: 'bike' },
        { id: 'lich', icon: '💀', label: 'lich' },
      ], {
        param: 'hero',
        initial: [hero],
        onChange: (v) => {
          session.choose(v[0]);
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
        },
      }) as unknown as VariantPicker<string>,
    );
    this.live.cam = camString(cam);
    for (const p of this.pickers) this.byName.set(p.title, p);
    const tools = el('div', 'lab-row', this.bar);
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
    this.hint = el('div', 'lab-hint', this.bar);
    // (what's under the bar sits under it, however it wraps)
    d.ui.classList.add('lab-on');
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
    session.setCam(cam);
  }

  static async start(d: HeroLabDeps): Promise<HeroLab> {
    const session = await PlaySession.start({ ...d, respawnAfter: 2, cam: urlParam.get('cam') ?? 'chase' });
    const hero = (urlParam.get('hero') ?? 'hoverbike') as PlayHeroId;
    if (hero !== 'hoverbike' && hero !== 'lich') throw new Error(`?hero=${hero}: the lab has the hoverbike and the lich (the walker isn't a play hero yet)`);
    const first = LAB_TERRAINS.find((t) => t.id === (urlParam.get('station') ?? 'cliff')) ?? LAB_TERRAINS[0];
    session.choose(hero, first.path[0].at);
    const lab = new HeroLab(d, session);
    lab.go(first.id);
    return lab;
  }

  /** a terrain to ride as a station: the hero at its ride's start, the autopilot on its path, its points of interest */
  private terrainStation(t: LabTerrain): LabStation<LabContext> {
    return {
      id: t.id,
      kind: 'camera',
      name: t.name,
      icon: ICONS[t.id],
      hint: t.hint,
      enter: ({ session }) => {
        this.pilot = new Autopilot(t.path);
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
        this.hint.textContent = `${t.name}: ${t.hint}`;
      },
    };
  }

  go(id: string): void {
    this.stations.go(id);
  }

  /** (scripts/herolab.mjs) a station, the camera modes (`?cam=` form) and a hero, as the chips would pick them */
  pick(o: { station?: string; cam?: string; hero?: PlayHeroId }): void {
    if (o.hero) this.byName.get('hero')!.set([o.hero]);
    if (o.cam) this.byName.get('camera')!.set(parseCam(o.cam));
    if (o.station) this.byName.get('terrain')!.set([o.station]);
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
    for (const p of this.pickers) p.dispose();
    this.bar.remove();
    this.panel.dispose();
    this.session.dispose();
  }
}

const ICONS: Record<string, string> = { cliff: '🧗', canyon: '🏜', forest: '🌲', city: '🏙', cave: '🕳', hills: '⛰' };
