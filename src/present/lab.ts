// ---- present/lab.ts ---------------------------------------------------------------------------------------------
// (round 124, `presentation`; BACKLOG PRE1, docs/design/REGION_PRESENTATION.md) The region presentation prototypes in
// the running game: a scene's presentation profile on play's hero (a PlaySession), its region, a repeatable route
// (the hero lab's autopilot) and the review overlay — the prototype, the treatment, the zoom and the pitch, the
// visibility mode, the light, the transition and its replay, FPS and frame time.
//
//   ?level=atlas&play=hoverbike&present=forest     A: a birch wood on the atlas (found near the start: the densest stand)
//   ?level=herolab&station=canyon&present=canyon   B: the hero lab's canyon
//   ?level=herolab&station=cliff&present=cliff     C: the hero lab's cliff foot (a proxy: no hero climbs)
//   ?present=menu                                  the review menu (present/menu.ts)
// Each variant is in the address (?pvis= ?plight= ?ptrans= ?pzoom= ?pel= ?pcam= ?pspeed=), so a view is a link.
//
// Off by default: nothing here runs without ?present=, and outside its region the profile's weight is 0 — the
// overworld's camera and draw as they were (CamFrame.present null, the renderer's present look all 0).

import type { V2 } from '../api/contracts/camera';
import type { PresentRegion } from '../api/contracts/presentation';
import type { Plants } from '../api/plants';
import type { Camera } from '../render/camera';
import { DEFAULT_CAM } from '../play/camera/rig';
import { Autopilot, type AutoPath } from '../play/lab/autopilot';
import { urlParam, VariantPicker } from '../play/lab/lab';
import { el, type PlaySession } from '../play/session';
import { PresentMode, type PresentHold } from './mode';
import {
  CANYON_CAMS,
  CANYON_DEFAULT,
  canyonProfile,
  CLIFF_CAMS,
  cliffProfile,
  FOREST_DEFAULT,
  FOREST_VIS,
  forestProfile,
  SCENES,
  TRANSITIONS,
  type CanyonCam,
  type CliffCam,
  type ForestPick,
  type ForestVis,
  type SceneId,
} from './profiles';
import { birchStand, rideStart, standRoute } from './stand';
import '../play/lab/herolab.css';
import './present.css';

export interface PresentDeps {
  ui: HTMLElement;
  session: PlaySession;
  camera: Camera;
  scene: SceneId;
  /** (A) where to look for the birch stand (the window's middle: the level's `at`, the same every load); absent: the hero */
  near?: V2;
  /** the plants (A: the birch stand is found from them) */
  plants?: Plants;
  /** (B, C: the hero lab) its station and camera chips, as the lab's own picker sets them; absent: the session's */
  lab?: { pick(o: { station?: string; cam?: string }): void };
}

/** seconds the route yields after the player touches the stick */
const TAKE_OVER = 2;

export class PresentLab {
  readonly mode: PresentMode;
  private panel: HTMLElement;
  private read: HTMLElement;
  private pickers: VariantPicker<string>[] = [];
  private pilot: Autopilot | null = null;
  auto: boolean;
  private yieldT = 0;
  private raf = 0;
  private dts: number[] = [];
  private last = 0;
  /** A/B: flipping between the pick and the baseline every `abSecs` (0: off) */
  private ab = { on: false, t: 0, showingB: false };
  private tag: HTMLElement;
  forest: ForestPick = { ...FOREST_DEFAULT, vis: [...FOREST_DEFAULT.vis] };
  canyon = { ...CANYON_DEFAULT };
  cliff: CliffCam = 'overworld';
  /** (A) the stand found and the route round it */
  region: PresentRegion | null = null;
  route: AutoPath[] = [];

  private constructor(readonly d: PresentDeps) {
    this.auto = urlParam.get('auto') !== '0';
    this.readUrl();
    this.mode = new PresentMode(this.profile(), null);
    this.panel = el('div', 'pre-panel', d.ui);
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const head = el('div', 'pre-head', this.panel);
    const sc = SCENES.find((s) => s.id === d.scene)!;
    head.innerHTML = `<span>🎬 ${sc.name}</span><span>▾</span>`;
    head.title = sc.hint;
    head.addEventListener('click', () => this.panel.classList.toggle('folded'));
    if (urlParam.get('pfold') === '1') this.panel.classList.add('folded');
    this.read = el('div', 'pre-read', this.panel);
    this.tag = el('div', 'pre-tag', d.ui);
    this.tag.style.display = 'none';
  }

  static async start(d: PresentDeps): Promise<PresentLab> {
    const lab = new PresentLab(d);
    if (d.scene === 'forest') lab.setupForest();
    else if (d.scene === 'canyon') lab.setupCanyon();
    else if (d.scene === 'cliff') lab.setupCliff();
    else throw new Error(`?present=${d.scene}: an outdoor scene is forest, canyon or cliff (the throne room is its own scene)`);
    d.session.rig.setPresent(lab.mode);
    lab.loop();
    return lab;
  }

  /** the picks from the address (a copied link's view); an unknown value throws (no quiet default) */
  private readUrl(): void {
    const list = (k: string) => {
      const v = urlParam.get(k);
      return v === null ? null : v === 'none' ? [] : v.split('+');
    };
    const num = (k: string, d: number) => {
      const v = urlParam.get(k);
      if (v === null) return d;
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`?${k}=${v}: not a number`);
      return x;
    };
    const oneOf = <T extends string>(k: string, ok: readonly { id: T }[], d: T): T => {
      const v = urlParam.get(k);
      if (v === null) return d;
      if (!ok.some((o) => o.id === v)) throw new Error(`?${k}=${v}: one of ${ok.map((o) => o.id).join(', ')}`);
      return v as T;
    };
    const f = this.forest;
    const vis = list('pvis');
    if (vis) {
      for (const v of vis) if (!FOREST_VIS.some((o) => o.id === v)) throw new Error(`?pvis=${v}: one of ${FOREST_VIS.map((o) => o.id).join(', ')}`);
      f.vis = vis as ForestVis[];
    }
    f.light = (list('plight') ?? (f.light ? ['light'] : [])).includes('light');
    f.transition = oneOf('ptrans', TRANSITIONS, f.transition);
    f.zoom = num('pzoom', f.zoom);
    f.elevation = num('pel', this.d.scene === 'forest' ? f.elevation : this.canyon.elevation);
    f.seconds = num('psecs', f.seconds);
    if (this.d.scene === 'canyon') {
      this.canyon.cam = oneOf('pcam', CANYON_CAMS, this.canyon.cam);
      this.canyon.speed = (list('pspeed') ?? (this.canyon.speed ? ['speed'] : [])).includes('speed');
      this.canyon.elevation = num('pel', this.canyon.elevation);
    }
    if (this.d.scene === 'cliff') this.cliff = oneOf('pcam', CLIFF_CAMS, this.cliff);
  }

  // ---- the scenes -------------------------------------------------------------------------------------------------

  private setupForest(): void {
    const { session, plants } = this.d;
    if (!plants) throw new Error('present=forest: needs the plants (the atlas level)');
    const h = session.hero.position();
    const stand = birchStand(plants, this.d.near ?? [h[0], h[1]], 140);
    this.region = { id: 'birch', centre: stand.at, radius: 12, edge: 12 };
    this.mode.region = this.region;
    this.route = standRoute(stand.at, (x, y) => session.world.depth(x, y) < 0.05 && session.world.top(x, y) > -1e8);
    this.pilot = new Autopilot(this.route, 6);
    this.steer();
    this.restart();
    const f = this.forest;
    this.picker('visibility', FOREST_VIS, f.vis, 'pvis', true, (v) => {
      f.vis = v as ForestVis[];
      this.apply();
    });
    this.picker('light', [{ id: 'light', icon: '☀', label: 'dapple', hint: 'sun flecks under the canopy drifting with the wind, the understory a little deeper' }], f.light ? ['light'] : [], 'plight', true, (v) => {
      f.light = v.includes('light');
      this.apply();
    });
    this.picker('transition', TRANSITIONS, [f.transition], 'ptrans', false, (v) => {
      f.transition = v[0] as ForestPick['transition'];
      this.apply();
    });
    this.slider('zoom', 20, 90, 1, f.zoom, 'pzoom', (x) => ((f.zoom = x), this.apply()));
    this.slider('pitch', 15, 80, 1, f.elevation, 'pel', (x) => ((f.elevation = x), this.apply()));
    this.slider('in (s)', 0.3, 4, 0.1, f.seconds, 'psecs', (x) => ((f.seconds = x), this.apply()));
    this.tools();
    this.apply();
  }

  private setupCanyon(): void {
    this.d.lab?.pick({ station: 'canyon' });
    this.picker('camera', CANYON_CAMS, [this.canyon.cam], 'pcam', false, (v) => {
      this.canyon.cam = v[0] as CanyonCam;
      this.apply();
    });
    this.picker('framing', [{ id: 'speed', icon: '💨', label: 'speed', hint: 'zoom out and look ahead with speed (off: a fixed framing)' }], this.canyon.speed ? ['speed'] : [], 'pspeed', true, (v) => {
      this.canyon.speed = v.includes('speed');
      this.apply();
    });
    this.slider('pitch', 30, 85, 1, this.canyon.elevation, 'pel', (x) => ((this.canyon.elevation = x), this.apply()));
    this.tools();
    this.apply();
  }

  private setupCliff(): void {
    this.d.lab?.pick({ station: 'cliff' });
    this.picker('camera', CLIFF_CAMS, [this.cliff], 'pcam', false, (v) => {
      this.cliff = v[0] as CliffCam;
      this.apply();
    });
    this.tools();
    this.apply();
  }

  /** the profile for the scene's picks now */
  private profile() {
    switch (this.d.scene) {
      case 'forest':
        return forestProfile(this.forest);
      case 'canyon':
        return canyonProfile(this.canyon);
      case 'cliff':
        return cliffProfile(this.cliff);
      default:
        throw new Error(`present: no outdoor profile for ${this.d.scene}`);
    }
  }

  /** the picks into the mode and the rig's own modes */
  apply(): void {
    this.mode.profile = this.profile();
    const s = this.d.scene;
    // (the rig's modes: A's baseline is today's default camera (cut + tilt), its treatments the chase alone with the
    // canopy's; B and C: the overworld's default camera, or the chase + cut under a pitch of the profile's own)
    let cams: readonly string[];
    if (s === 'forest') cams = this.forest.vis.includes('rig') ? DEFAULT_CAM : ['chase'];
    else if (s === 'canyon') cams = this.canyon.cam === 'overworld' ? DEFAULT_CAM : ['chase', 'cutaway'];
    else cams = this.cliff === 'overworld' ? DEFAULT_CAM : ['chase', 'cutaway'];
    const cam = cams.filter((c) => c !== 'chase').join('+') || 'chase';
    if (this.d.lab) this.d.lab.pick({ cam });
    else this.d.session.setCam(cams as typeof DEFAULT_CAM);
    // (the rig's modes changed: the present mode stays given)
    this.d.session.rig.setPresent(this.mode);
  }

  /** (A) the route's stick: the autopilot unless the player touched the stick lately */
  private steer(): void {
    this.d.session.steer = (p: V2, stick: V2) => {
      if (Math.hypot(stick[0], stick[1]) > 0.2) this.yieldT = TAKE_OVER;
      if (!this.auto || !this.pilot || this.yieldT > 0) return stick;
      return this.pilot.steer(p);
    };
  }

  /** back to the route's start (outside the region): the ride in replays the transition */
  restart(): void {
    if (this.pilot) {
      const st = this.pilot.start(this.region ? rideStart(this.route, this.region.centre, this.region.radius + this.region.edge + 8) : 0);
      this.d.session.respawn(st.at);
    }
    this.mode.hold = 'auto';
    this.mode.replay();
  }

  // ---- the overlay ------------------------------------------------------------------------------------------------

  private picker(title: string, choices: readonly { id: string; icon: string; label: string; hint?: string }[], initial: string[], param: string, multi: boolean, onChange: (v: string[]) => void): void {
    const p = new VariantPicker<string>(this.panel, title, choices, { multi, param, initial, format: (v) => v.join('+') || 'none', onChange });
    this.pickers.push(p);
  }

  private slider(label: string, min: number, max: number, step: number, value: number, param: string, onInput: (x: number) => void): void {
    const row = el('label', 'pre-slider', this.panel);
    const t = el('span', '', row);
    t.textContent = label;
    const inp = el('input', '', row) as HTMLInputElement;
    Object.assign(inp, { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const num = el('span', '', row);
    num.textContent = String(value);
    inp.addEventListener('input', () => {
      const x = Number(inp.value);
      num.textContent = String(x);
      urlParam.set(param, String(x));
      onInput(x);
    });
  }

  private tools(): void {
    const row = el('div', 'lab-row', this.panel);
    const btn = (icon: string, label: string, hint: string, f: (b: HTMLButtonElement) => void, on = false) => {
      const b = el('button', 'play-chip lab-chip', row) as HTMLButtonElement;
      b.innerHTML = `<span>${icon}</span><small>${label}</small>`;
      b.title = hint;
      b.classList.toggle('on', on);
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => f(b));
    };
    btn('⟲', 'replay', 'replay the transition from the overworld framing', () => this.mode.replay());
    btn('⇱', 'out/in', 'hold the overworld framing (tap again: in; again: the region decides)', (b) => {
      const next: Record<PresentHold, PresentHold> = { auto: 'out', out: 'in', in: 'auto' };
      this.mode.hold = next[this.mode.hold];
      b.querySelector('small')!.textContent = this.mode.hold === 'auto' ? 'out/in' : this.mode.hold;
    });
    if (this.pilot || this.d.lab) {
      btn('▶', 'route', 'the route rides itself (touch the stick to take over for a moment)', (b) => {
        this.auto = !this.auto;
        b.classList.toggle('on', this.auto);
        urlParam.set('auto', this.auto ? null : '0');
      }, this.auto);
    }
    if (this.pilot) btn('⏮', 'start', 'back to the route\'s start, outside the region', () => this.restart());
    btn('⇄', 'A/B', 'flip between this pick and the baseline every 3 s', (b) => {
      this.ab.on = !this.ab.on;
      this.ab.t = 0;
      b.classList.toggle('on', this.ab.on);
      if (!this.ab.on) this.showB(false);
    });
    const menu = el('a', 'play-chip lab-chip', row) as HTMLAnchorElement;
    menu.innerHTML = '<span>☰</span><small>menu</small>';
    menu.href = '?present=menu';
    menu.title = 'the review menu: the four scenes';
  }

  /** A/B: the baseline shown (true) or the pick (false) */
  private showB(b: boolean): void {
    if (this.ab.showingB === b) return;
    this.ab.showingB = b;
    if (b) {
      const keep = { forest: { ...this.forest, vis: [...this.forest.vis] }, canyon: { ...this.canyon }, cliff: this.cliff };
      this.forest = { ...this.forest, vis: ['rig'], light: false };
      this.canyon = { ...this.canyon, cam: 'overworld' };
      this.cliff = 'overworld';
      this.apply();
      this.forest = keep.forest;
      this.canyon = keep.canyon;
      this.cliff = keep.cliff;
    } else this.apply();
    this.tag.style.display = this.ab.on ? '' : 'none';
    this.tag.textContent = b ? 'B · baseline' : 'A · ' + this.label();
  }

  /** the pick in words (the overlay's readout, the A/B tag, the scripts' captions) */
  label(): string {
    switch (this.d.scene) {
      case 'forest':
        return `${this.forest.vis.join('+') || 'none'}${this.forest.light ? ' +light' : ''} · ${this.forest.transition}`;
      case 'canyon':
        return `${this.canyon.cam}${this.canyon.speed ? ' · speed' : ' · fixed'}`;
      default:
        return this.cliff;
    }
  }

  /** the overlay's readout and the route's take-over, each frame */
  private loop(): void {
    const tick = (t: number) => {
      const dt = this.last ? (t - this.last) / 1000 : 0;
      this.last = t;
      if (dt > 0) {
        this.dts.push(dt * 1000);
        if (this.dts.length > 120) this.dts.shift();
        this.yieldT -= dt;
        if (this.ab.on) {
          this.ab.t += dt;
          if (this.ab.t > 3) {
            this.ab.t = 0;
            this.showB(!this.ab.showingB);
          }
        }
      }
      if (this.dts.length > 10 && Math.floor(t / 250) !== Math.floor((t - dt * 1000) / 250)) {
        const s = [...this.dts].sort((a, b) => a - b);
        const p50 = s[Math.floor(s.length / 2)];
        const p95 = s[Math.floor(s.length * 0.95)];
        this.read.textContent = `${(1000 / p50).toFixed(0)} fps · ${p50.toFixed(1)}/${p95.toFixed(1)} ms\nw ${this.mode.w.toFixed(2)} · zoom ${this.d.camera.zoom.toFixed(0)} · ${((this.d.camera.elevation * 180) / Math.PI).toFixed(0)}°\n${this.label()}`;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** the streamed window slid: what's kept in window coordinates (the region, the route) moves by (dx, dy) */
  shift(dx: number, dy: number): void {
    if (this.region) this.region.centre = [this.region.centre[0] + dx, this.region.centre[1] + dy];
    for (const p of this.route) p.at = [p.at[0] + dx, p.at[1] + dy];
  }

  // ---- for the scripts (scripts/present.mjs) ----------------------------------------------------------------------

  /** a pick as the chips would set it, by the picker's title: { visibility: 'dither+stipple', transition: 'crossfade' } */
  pick(o: Record<string, string>): void {
    for (const [k, v] of Object.entries(o)) {
      const p = this.pickers.find((x) => x.title === k);
      if (!p) throw new Error(`present.pick: no picker "${k}" (${this.pickers.map((x) => x.title).join(', ')})`);
      p.set(v === 'none' ? [] : v.split('+'));
    }
  }

  /** (scripts: a still) the hero parked at `at` (default: the region's middle), the route off, the weight held at `w` */
  park(w: number, at?: V2): void {
    this.auto = false;
    // (default: the route's point nearest the region's middle — on the ride, not in a trunk)
    const c = this.region?.centre;
    const near = c && this.route.length ? this.route.reduce((a, q) => (Math.hypot(q.at[0] - c[0], q.at[1] - c[1]) < Math.hypot(a.at[0] - c[0], a.at[1] - c[1]) ? q : a)).at : null;
    const p = at ?? near ?? c ?? null;
    if (p) this.d.session.respawn([p[0], p[1]]);
    this.mode.hold = w > 0.5 ? 'in' : 'out';
    this.mode.w = w;
  }

  /** (scripts: a ride) the route on from its start, the region deciding */
  ride(): void {
    this.auto = true;
    this.restart();
  }

  /** the numbers now (scripts) */
  state() {
    const h = this.d.session.hero.position();
    const cam = this.d.camera;
    return { screen: cam.project(h[0], h[1], h[2] + 1), w: this.mode.w, hold: this.mode.hold, zoom: this.d.camera.zoom, elevation: (this.d.camera.elevation * 180) / Math.PI, azimuth: (this.d.camera.azimuth * 180) / Math.PI, hero: h, region: this.region, label: this.label(), present: !!this.d.camera.present, frames: this.dts.slice() };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.d.session.rig.setPresent(null);
    if (this.pilot) this.d.session.steer = null;
    for (const p of this.pickers) p.dispose();
    this.panel.remove();
    this.tag.remove();
  }
}
