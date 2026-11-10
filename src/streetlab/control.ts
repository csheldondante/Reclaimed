// (street lab, milestone 1) The street lab in a level: its panel (the tuning editor shell on the lab's own registry —
// the noise lab's pattern), its GPU runs (gpu.ts) and the display mesh in the game's renderer. A change runs the
// technique again at once; the camera's pitch is the camera's own (Camera.elevation). `globalThis.streetlab` for scripts.
import { Registry, type ParamSpec } from '../tune/registry';
import { TunePanel } from '../ui/tunepanel';
import { whenPipelinesReady } from '../gpu/pipeline';
import { StreetLabGpu, TECHNIQUES, type StreetParams, type StreetTimes, type StreetWorld } from './gpu';

const P: Record<string, ParamSpec> = {
  technique: { label: 'technique', units: '', min: 0, max: TECHNIQUES.length - 1, step: 1, def: 1, choices: [...TECHNIQUES] },
  majorSpacing: { label: 'major spacing', units: 'cells', min: 8, max: 96, step: 1, def: 32, help: 'between major streets (L1: see contour step)' },
  minorSpacing: { label: 'minor spacing', units: 'cells', min: 6, max: 64, step: 1, def: 17, help: 'between minor streets (rings and spokes, L4 minor lines)' },
  majorWidth: { label: 'major street width', units: 'cells', min: 1, max: 12, step: 0.5, def: 4 },
  minorWidth: { label: 'minor street width', units: 'cells', min: 1, max: 8, step: 0.5, def: 2.5 },
  contourStep: { label: 'contour step (L1)', units: 'cells high', min: 1, max: 24, step: 0.5, def: 4, help: 'height between L1 contour streets' },
  stairs: { label: 'stairs slope', units: 'rise/run', min: 0.05, max: 1.5, step: 0.05, def: 0.35, help: 'a street rising more than this along itself is marked orange (needs stairs)' },
  cliff: { label: 'cliff slope', units: 'rise/run', min: 0.3, max: 4, step: 0.05, def: 1.2, help: 'smoothed ground steeper than this is a cliff: streets keep off and follow it (with the water)' },
  townR: { label: 'town radius', units: 'cells', min: 32, max: 200, step: 1, def: 120 },
  pitch: { label: 'camera pitch', units: '°', min: 10, max: 89, step: 1, def: 30, help: 'the camera above the ground plane (the game: 30°)' },
};
export const STREET_TUNING = new Registry({ streets: { title: 'Streets', owner: 'streetlab/streets.wgsl', params: P } });
const values = () => STREET_TUNING.values.streets as unknown as StreetParams & { pitch: number };

export interface StreetLabHooks {
  /** the display mesh into the renderer (Renderer.addMesh) */
  addMesh(verts: GPUBuffer, args: GPUBuffer): void;
  removeMesh(args: GPUBuffer): void;
  /** the camera's pitch (radians) */
  setPitch(rad: number): void;
}

export class StreetLabControl {
  readonly gpu: StreetLabGpu;
  readonly panel: TunePanel;
  readonly registry = STREET_TUNING;
  readonly techniques = TECHNIQUES;
  private line = document.createElement('div');
  private off: () => void;
  /** the last run's GPU ms (and the heights' from the first) */
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
    const t = params.get('tech');
    if (t !== null) STREET_TUNING.set('streets.technique', Number(t));
    const pitch = params.get('pitch');
    if (pitch !== null) STREET_TUNING.set('streets.pitch', Number(pitch));
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
      this.off = STREET_TUNING.onChange(() => this.request());
      this.request();
    });
  }

  /** run the current technique again (and the camera's pitch) */
  request(): void {
    const v = values();
    this.hooks.setPitch((v.pitch * Math.PI) / 180);
    this.settled = this.gpu.run({ ...v }).then(
      (t) => this.got(t),
      (e) => {
        if (!this.dead) throw e;
      },
    );
  }

  private dead = false;

  private got(t: StreetTimes): void {
    if (this.dead) return;
    this.runs++;
    this.last = t;
    if (t.height !== null) this.heightMs = t.height;
    const f = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3));
    this.line.textContent =
      t.total === null
        ? 'GPU ms: n/a (no timestamp-query on this device)'
        : `GPU ms — fields ${f(t.field)} · lines ${f(t.lines)} · mesh ${f(t.mesh)} · total ${f(t.total)}${this.heightMs !== null ? ` (heights at load ${f(this.heightMs)})` : ''} · ${this.gpu.dispatches} dispatches`;
  }

  dispose(): void {
    this.dead = true;
    this.off();
    this.hooks.removeMesh(this.gpu.args);
    this.panel.dispose();
    this.gpu.dispose();
  }
}
