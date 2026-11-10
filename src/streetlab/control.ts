// (street lab, milestones 1–3) The street lab in a level: its panel (the tuning editor shell on the lab's own registry —
// the noise lab's pattern) over the town generator (citygen/: the game's towns run the same pipeline, M4a), its GPU
// runs and the mesh in the game's renderer. A change reruns from the stage
// it touches (a width: the mesh only; a lot slider: the lots; the block length: the cross streets; the points' sliders:
// φ; the cliffs: all), and the panel shows that run's GPU ms. A tap places, moves, selects or removes a point (m3a):
// φ is rerun over that point's radius only. The camera's pitch is the camera's own (Camera.elevation), the town fitted
// to the view at each pitch. `globalThis.streetlab` for scripts.
import { Registry, type ParamSpec } from '../tune/registry';
import { TunePanel } from '../ui/tunepanel';
import { whenPipelinesReady } from '../gpu/pipeline';
import { ROW_H } from '../world/lattice';
import { AUTO, MAJORS, NPTS, STAGES, CityGen, type Box, type Stage, type StreetParams, type StreetTimes, type StreetWorld } from '../citygen/gpu';
import { CITY_PARAMS, scaled } from '../citygen/params';

/** the sites (game/levels.ts streetSite), as the panel names them: the mesa is the cliff site */
export const SITES = ['muru', 'river', 'mesa', 'mountain', 'coast'] as const;
const SITE_NAMES = ['Muru', 'river', 'cliff (mesa)', 'mountain', 'coast'];
const TAP = ['place / move / select', 'remove'];

type Spec = ParamSpec & { stage: Stage | 'camera' | 'point' | 'site' | 'arterials' | 'none' };
/** the lab's own controls (the site, taps, the camera, test arterials) and every town parameter (citygen/params.ts) */
const P: Record<string, Spec> = {
  site: { label: 'site', units: '', min: 0, max: SITES.length - 1, step: 1, def: 0, choices: SITE_NAMES, help: 'reloads the page on that site, the other keys kept', stage: 'site' },
  intensity: { label: 'selected point intensity', units: '×', min: 0.1, max: 2, step: 0.05, def: 1, help: 'tap a point to select it (gold); this scales its radius and strength only', stage: 'point' },
  tap: { label: 'a tap', units: '', min: 0, max: 1, step: 1, def: 0, choices: TAP, help: 'a tap near a point selects it, a tap away moves the selected one there (or places a new one)', stage: 'none' },
  cut: { label: 'cut above', units: 'cells', min: 0, max: 120, step: 1, def: 30, help: 'nothing drawn higher than this over the town ground (the camera slice; 0 none): tall land out of the way', stage: 'camera' },
  pitch: { label: 'camera pitch', units: '°', min: 15, max: 85, step: 1, def: 60, help: 'the camera above the ground plane (the game: 30°)', stage: 'camera' },
  artN: { label: 'test arterials', units: '', min: 0, max: 6, step: 1, def: 0, help: 'approach roads evenly round the centre (the game: the site’s atlas roads)', stage: 'arterials' },
  artAngle: { label: 'arterials’ turn', units: '°', min: 0, max: 360, step: 5, def: 20, stage: 'arterials' },
  ...CITY_PARAMS,
};
export const STREET_TUNING = new Registry({ streets: { title: 'Streets', owner: 'citygen/streets.wgsl', params: P } });
const values = () => STREET_TUNING.values.streets as unknown as StreetParams & { pitch: number; cut: number; intensity: number; tap: number; site: number; scale: number; artN: number; artAngle: number };

export interface StreetLabHooks {
  /** the mesh into the renderer (Renderer.addMesh) */
  addMesh(verts: GPUBuffer, args: GPUBuffer): void;
  removeMesh(args: GPUBuffer): void;
  /** the camera's pitch (radians), the town (its radius) fitted to the view, the slice over the town's ground (0 none) */
  camera(pitch: number, townR: number, cut: number): void;
}

/** the game's own HUD hidden (the town unobstructed): every child of the UI layer but the lab's panel and button */
const NOHUD = 'streetlab-nohud';
const KEEP = 'streetlab-keep';

export class StreetLabControl {
  readonly gpu: CityGen;
  readonly panel: TunePanel;
  readonly registry = STREET_TUNING;
  readonly majors = MAJORS;
  private line = document.createElement('div');
  private hudBtn = document.createElement('button');
  private off: () => void;
  private dead = false;
  private quiet = false;
  /** the selected point's slot (-1 none) */
  selected = -1;
  /** the last run's GPU ms and counts (and the heights' from the first) */
  last?: StreetTimes;
  heightMs: number | null = null;
  runs = 0;
  /** resolves when the run asked for last is done */
  settled: Promise<void> = Promise.resolve();

  constructor(
    device: GPUDevice,
    private parent: HTMLElement,
    world: StreetWorld,
    private hooks: StreetLabHooks,
    params: URLSearchParams,
  ) {
    this.gpu = new CityGen(device, world);
    hooks.addMesh(this.gpu.verts, this.gpu.args);
    // (?majors=0..3 &pitch= &height= … any parameter by its key; ?site= by its name)
    for (const key of Object.keys(P)) {
      const v = params.get(key);
      if (key === 'site') {
        if (v !== null) STREET_TUNING.set('streets.site', Math.max(0, SITES.indexOf(v as (typeof SITES)[number])));
      } else if (v !== null) STREET_TUNING.set(`streets.${key}`, Number(v));
    }
    const top = document.createElement('div');
    this.line.className = 'tune-note';
    // (the game's HUD: hidden or shown — ?hud=0 hides it at the start)
    this.hudBtn.onclick = () => this.hud(parent.classList.contains(NOHUD));
    const reset = document.createElement('button');
    reset.textContent = 'reset points';
    reset.title = 'every point back to the GPU’s placing; the ones you placed removed';
    reset.onclick = () => {
      this.gpu.resetPoints();
      this.choose(-1);
      this.request('phi');
    };
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;margin:4px 0';
    btns.append(this.hudBtn, reset);
    top.append(btns, this.line);
    this.panel = new TunePanel(parent, {
      registry: STREET_TUNING,
      store: 'reclaimed.streetlab.presets',
      urlParam: 'streets',
      label: 'streets',
      cls: 'lab',
      top,
      open: ['streets'],
      shown: !matchMedia('(pointer: coarse)').matches,
    });
    this.panel.el.classList.add(KEEP);
    this.panel.button.classList.add(KEEP);
    if (!document.getElementById(NOHUD)) {
      const st = document.createElement('style');
      st.id = NOHUD;
      st.textContent = `.${NOHUD} > :not(.${KEEP}) { display: none !important; }`;
      document.head.append(st);
    }
    this.hud(params.get('hud') !== '0');
    // (the heights' kernel is made with the level's pipelines: the first run once they're ready)
    this.off = () => undefined;
    whenPipelinesReady(() => {
      if (this.dead) return;
      this.off = STREET_TUNING.onChange((id) => {
        if (this.quiet) return;
        const key = id?.split('.')[1];
        const st = key ? P[key]?.stage : 'field';
        if (st === 'camera') this.fit();
        else if (st === 'site') this.goSite();
        else if (st === 'point') this.setIntensity(values().intensity);
        else if (st === 'arterials') {
          this.arterials();
          this.request('field');
        }
        else if (st !== 'none') this.request(st ?? 'field');
      });
      this.fit();
      this.arterials();
      this.request('field');
    });
  }

  /** (M4a) the test arterials: artN directions evenly round the centre from artAngle (the game's: its atlas roads') */
  private arterials(): void {
    const v = values();
    const a0 = (v.artAngle * Math.PI) / 180;
    this.gpu.setArterials(Array.from({ length: v.artN }, (_, k) => [Math.cos(a0 + (k * 2 * Math.PI) / v.artN), Math.sin(a0 + (k * 2 * Math.PI) / v.artN)] as const));
  }

  /** the game's HUD shown or hidden */
  hud(show: boolean): void {
    this.parent.classList.toggle(NOHUD, !show);
    this.hudBtn.textContent = show ? 'hide game HUD' : 'show game HUD';
  }

  /** (the site radio) the page again on that site, every changed panel key kept in the URL */
  private goSite(): void {
    const q = new URLSearchParams(location.search);
    const v = values() as unknown as Record<string, number>;
    for (const key of Object.keys(P)) {
      if (key === 'site') q.set('site', SITES[v.site]);
      else if (v[key] !== P[key].def) q.set(key, String(v[key]));
    }
    q.set('hud', this.parent.classList.contains(NOHUD) ? '0' : '1');
    location.search = q.toString();
  }

  /** the camera at the pitch, the town fitted */
  fit(): void {
    const v = values();
    this.hooks.camera((v.pitch * Math.PI) / 180, v.townR, v.cut);
  }

  /** rerun from a stage (the first stage asked for among runs queued wins: they run in order anyway); φ over `box` only */
  request(from: Stage = 'field', box?: Box): void {
    if (from === 'field') this.fit();
    // (the city's scale: the spacings × it, the lot areas × its square)
    this.settled = this.gpu.run(scaled({ ...values() }), from, box).then(
      (t) => this.got(t),
      (e) => {
        if (!this.dead) throw e;
      },
    );
  }

  /** a point's radius's columns (a world disc round x, y) — all φ's change there can touch */
  private discBox(x: number, y: number, intensity: number): Box {
    const r = values().pointR * intensity + 2;
    return [x - r - 1, (y - r) / ROW_H - 1, x + r + 2, (y + r) / ROW_H + 2];
  }
  private union(a: Box, b: Box): Box {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  }
  private choose(slot: number): void {
    this.selected = slot;
    this.gpu.select(slot);
    const p = this.gpu.points[slot];
    if (p?.alive) {
      this.quiet = true;
      STREET_TUNING.set('streets.intensity', p.intensity);
      this.quiet = false;
    }
  }

  /**
   * (m3a) a tap on the ground (world x, y): near a point (within its marker's reach) selects it — in remove mode,
   * removes it; away from every point, the selected point moves there, or with none selected a new point is placed.
   * Each reruns φ over the box it changed (the old disc and the new). The points' positions are the last run's read.
   */
  tapAt(x: number, y: number): Promise<void> {
    const v = values();
    if (v.majors === 0 || v.majors === 3) return this.settled;
    const live = this.gpu.points.filter((p) => p.alive);
    let near = -1;
    let nd = Math.max(6, v.pointR * 0.25);
    for (const p of live) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < nd) {
        nd = d;
        near = p.slot;
      }
    }
    if (near >= 0) {
      const p = this.gpu.points[near];
      if (v.tap === 1) {
        this.gpu.setPoint(near, p.x, p.y, p.intensity, near < AUTO ? 2 : 0);
        this.choose(-1);
        this.request('phi', this.discBox(p.x, p.y, p.intensity));
      } else {
        this.choose(near);
        this.request('mesh');
      }
      return this.settled;
    }
    if (v.tap === 1) return this.settled;
    const sel = this.gpu.points[this.selected];
    if (sel?.alive) {
      this.gpu.setPoint(sel.slot, x, y, sel.intensity, 1);
      this.request('phi', this.union(this.discBox(sel.x, sel.y, sel.intensity), this.discBox(x, y, sel.intensity)));
      return this.settled;
    }
    // (a new point in a free slot: the user's first, then a removed or unused auto slot)
    const used = new Set(live.map((p) => p.slot));
    let slot = -1;
    for (let s = AUTO; s < NPTS && slot < 0; s++) if (!used.has(s)) slot = s;
    for (let s = 0; s < AUTO && slot < 0; s++) if (!used.has(s)) slot = s;
    if (slot < 0) return this.settled;
    this.gpu.setPoint(slot, x, y, 0.7, 1);
    this.selected = slot;
    this.gpu.select(slot);
    this.request('phi', this.discBox(x, y, 0.7));
    return this.settled;
  }

  /** (m3a) the selected point's intensity: pinned where it is, φ rerun over the larger of its two discs */
  setIntensity(i: number): void {
    const p = this.gpu.points[this.selected];
    if (!p?.alive) return;
    const was = p.intensity;
    this.gpu.setPoint(p.slot, p.x, p.y, i, 1);
    p.intensity = i;
    this.request('phi', this.discBox(p.x, p.y, Math.max(i, was)));
  }

  private got(t: StreetTimes): void {
    if (this.dead) return;
    this.runs++;
    this.last = t;
    // (the level frames its first view when the screen's size is first known — after the lab mounts: fitted again)
    if (this.runs === 1) this.fit();
    if (t.height !== null) this.heightMs = t.height;
    const f = (x: number | null) => (x === null ? '–' : x.toFixed(2));
    const box = t.box ? ` (φ over ${t.box[2] - t.box[0]}×${t.box[3] - t.box[1]} columns)` : '';
    this.line.textContent =
      t.total === null
        ? `GPU ms: n/a (no timestamp-query) · ${t.lots} lots`
        : `GPU ms (from ${t.from}${box}): ${STAGES.map((s) => `${s} ${f(t.stage[s])}`).join(' · ')} · total ${f(t.total)} · ${t.lots} lots · ${(t.verts / 3) | 0} tris${this.heightMs !== null ? ` · heights at load ${f(this.heightMs)}` : ''}`;
  }

  dispose(): void {
    this.dead = true;
    this.off();
    this.parent.classList.remove(NOHUD);
    this.hooks.removeMesh(this.gpu.args);
    this.panel.dispose();
    this.gpu.dispose();
  }
}
