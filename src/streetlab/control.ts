// (street lab, milestones 1–2) The street lab in a level: its panel (the tuning editor shell on the lab's own registry —
// the noise lab's pattern), its GPU runs (gpu.ts) and the mesh in the game's renderer. A change reruns from the stage
// it touches (a width: the mesh only; a lot slider: the lots; the block length: the traces; the major lines: all), and
// the panel shows that run's GPU ms. The camera's pitch is the camera's own (Camera.elevation), the town fitted to the
// view at each pitch. `globalThis.streetlab` for scripts.
import { Registry, type ParamSpec } from '../tune/registry';
import { TunePanel } from '../ui/tunepanel';
import { whenPipelinesReady } from '../gpu/pipeline';
import { MAJORS, MIN_BLOCK, STAGES, StreetLabGpu, type Stage, type StreetParams, type StreetTimes, type StreetWorld } from './gpu';

type Spec = ParamSpec & { stage: Stage | 'camera' };
const P: Record<string, Spec> = {
  majors: { label: 'major lines', units: '', min: 0, max: MAJORS.length - 1, step: 1, def: 2, choices: [...MAJORS], stage: 'field' },
  majorSpacing: { label: 'contour spacing', units: 'cells', min: 12, max: 120, step: 1, def: 44, help: 'between the distance contours (major lines)', stage: 'field' },
  ringSpacing: { label: 'ring spacing', units: 'cells', min: 12, max: 120, step: 1, def: 38, help: 'between the rings (and so the spokes)', stage: 'field' },
  townR: { label: 'town radius', units: 'cells', min: 32, max: 200, step: 1, def: 120, stage: 'field' },
  cliff: { label: 'cliff slope', units: 'rise/run', min: 0.3, max: 4, step: 0.05, def: 1.2, help: 'smoothed ground steeper than this is a cliff: a barrier, like the water', stage: 'field' },
  blockLen: { label: 'block length', units: 'cells', min: MIN_BLOCK, max: 64, step: 1, def: 18, help: 'cross streets this far apart along a strip', stage: 'trace' },
  maxLot: { label: 'max lot area', units: 'cells²', min: 16, max: 600, step: 4, def: 90, stage: 'lots' },
  minLot: { label: 'merge (min lot area)', units: 'cells²', min: 4, max: 300, step: 2, def: 30, help: 'a split that would leave a lot under this is not made', stage: 'lots' },
  majorWidth: { label: 'major street width', units: 'cells', min: 1, max: 12, step: 0.5, def: 4, stage: 'mesh' },
  minorWidth: { label: 'minor street width', units: 'cells', min: 1, max: 8, step: 0.5, def: 2.5, stage: 'mesh' },
  setback: { label: 'setback', units: 'cells', min: 0, max: 6, step: 0.25, def: 0.75, stage: 'mesh' },
  height: { label: 'height', units: 'storeys', min: 0.5, max: 12, step: 0.5, def: 2, help: 'three cells a storey, each lot a little more or less', stage: 'mesh' },
  stairs: { label: 'stairs slope', units: 'rise/run', min: 0.05, max: 1.5, step: 0.05, def: 0.35, help: 'a street rising more than this along itself is orange', stage: 'mesh' },
  cut: { label: 'cut above', units: 'cells', min: 0, max: 120, step: 1, def: 30, help: 'nothing drawn higher than this over the town ground (the camera slice; 0 none): tall land out of the way', stage: 'camera' },
  pitch: { label: 'camera pitch', units: '°', min: 15, max: 85, step: 1, def: 30, help: 'the camera above the ground plane (the game: 30°)', stage: 'camera' },
};
export const STREET_TUNING = new Registry({ streets: { title: 'Streets', owner: 'streetlab/streets.wgsl', params: P } });
const values = () => STREET_TUNING.values.streets as unknown as StreetParams & { pitch: number; cut: number };

export interface StreetLabHooks {
  /** the mesh into the renderer (Renderer.addMesh) */
  addMesh(verts: GPUBuffer, args: GPUBuffer): void;
  removeMesh(args: GPUBuffer): void;
  /** the camera's pitch (radians), the town (its radius) fitted to the view, the slice over the town's ground (0 none) */
  camera(pitch: number, townR: number, cut: number): void;
}

export class StreetLabControl {
  readonly gpu: StreetLabGpu;
  readonly panel: TunePanel;
  readonly registry = STREET_TUNING;
  readonly majors = MAJORS;
  private line = document.createElement('div');
  private off: () => void;
  private dead = false;
  /** the last run's GPU ms and counts (and the heights' from the first) */
  last?: StreetTimes;
  heightMs: number | null = null;
  runs = 0;
  /** resolves when the run asked for last is done */
  settled: Promise<void> = Promise.resolve();

  constructor(
    device: GPUDevice,
    parent: HTMLElement,
    world: StreetWorld,
    private hooks: StreetLabHooks,
    params: URLSearchParams,
  ) {
    this.gpu = new StreetLabGpu(device, world);
    hooks.addMesh(this.gpu.verts, this.gpu.args);
    // (?majors=0..2 &pitch= &height= … any parameter by its key)
    for (const key of Object.keys(P)) {
      const v = params.get(key);
      if (v !== null) STREET_TUNING.set(`streets.${key}`, Number(v));
    }
    const top = document.createElement('div');
    this.line.className = 'tune-note';
    top.append(this.line);
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
    // (the heights' kernel is made with the level's pipelines: the first run once they're ready)
    this.off = () => undefined;
    whenPipelinesReady(() => {
      if (this.dead) return;
      this.off = STREET_TUNING.onChange((id) => {
        const key = id?.split('.')[1];
        const st = key ? P[key]?.stage : 'field';
        if (st === 'camera') this.fit();
        else this.request(st ?? 'field');
      });
      this.fit();
      this.request('field');
    });
  }

  /** the camera at the pitch, the town fitted */
  fit(): void {
    const v = values();
    this.hooks.camera((v.pitch * Math.PI) / 180, v.townR, v.cut);
  }

  /** rerun from a stage (the first stage asked for among runs queued wins: they run in order anyway) */
  request(from: Stage = 'field'): void {
    if (from === 'field') this.fit();
    this.settled = this.gpu.run({ ...values() }, from).then(
      (t) => this.got(t),
      (e) => {
        if (!this.dead) throw e;
      },
    );
  }

  private got(t: StreetTimes): void {
    if (this.dead) return;
    this.runs++;
    this.last = t;
    // (the level frames its first view when the screen's size is first known — after the lab mounts: fitted again)
    if (this.runs === 1) this.fit();
    if (t.height !== null) this.heightMs = t.height;
    const f = (x: number | null) => (x === null ? '–' : x.toFixed(2));
    this.line.textContent =
      t.total === null
        ? `GPU ms: n/a (no timestamp-query) · ${t.lots} lots`
        : `GPU ms (from ${t.from}): ${STAGES.map((s) => `${s} ${f(t.stage[s])}`).join(' · ')} · total ${f(t.total)} · ${t.lots} lots · ${(t.verts / 3) | 0} tris${this.heightMs !== null ? ` · heights at load ${f(this.heightMs)}` : ''}`;
  }

  dispose(): void {
    this.dead = true;
    this.off();
    this.hooks.removeMesh(this.gpu.args);
    this.panel.dispose();
    this.gpu.dispose();
  }
}
