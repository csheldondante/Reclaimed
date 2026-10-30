// (round 111, BACKLOG TG1) The noise lab in a level: its panel (the tuning editor shell on the lab's registry, with
// the overhead preview on top), its GPU runs, and the world rewritten from each — through `LabWorld`, the level's
// narrow hook (it alone knows the world). A change runs the recipe at once (the preview follows every run); the
// world follows when a slider is let go, a list or a number changes, or — `world follows: live` — every run.

import { TunePanel } from '../ui/tunepanel';
import type { ChunkLayout, LabColumns } from './columns';
import { drawPreview, labColumns, recordStats } from './columns';
import { NoiseLabGpu, type LabResult } from './lab';
import { LAB_TUNING, TARGET, labValues, labVisible } from './params';
import { PRESETS } from './presets';
import { LayerStack } from './stack';

/** what the lab needs of the level */
export interface LabWorld {
  w: number;
  h: number;
  zMax: number;
  layout: ChunkLayout;
  /** the columns into the world (layers, water, surface) and the sea's level; returns the time it took (ms) */
  write(cols: LabColumns, sea: number): number;
}

export interface LabStats {
  runs: number;
  writes: number;
  /** the last run: GPU passes and its submit-to-read time; the columns' packing; the world's write */
  passes: number;
  gpuMs: number;
  packMs: number;
  writeMs: number;
  min: number;
  max: number;
  caves: number;
  maxRuns: number;
  /** (round 112) the last write: columns with gaps, opened by a carve, whose extra gaps joined */
  gapCols: number;
  cutCols: number;
  joinedCols: number;
}

const STORE = 'reclaimed.noiselab.presets';
/** the recipe the lab opens with (?labpreset=<name> another; ?lab=<string> a copied one) */
export const START_PRESET = 'TG2: mesas, ramps, ravines';

export class NoiseLabControl {
  readonly gpu: NoiseLabGpu;
  readonly panel: TunePanel;
  private canvas = document.createElement('canvas');
  private line = document.createElement('div');
  private off: () => void;
  private last?: LabResult;
  private worldDue = false;
  private idleTimer = 0;
  private dead = false;
  readonly stats: LabStats = { runs: 0, writes: 0, passes: 0, gpuMs: 0, packMs: 0, writeMs: 0, min: 0, max: 0, caves: 0, maxRuns: 0, gapCols: 0, cutCols: 0, joinedCols: 0 };
  /** (round 112) the layer stack's list (rows, selection, solo, up to here) */
  readonly stack = new LayerStack();
  /** resolves when the run in flight (and the world's write it owes) is done */
  settled: Promise<void> = Promise.resolve();

  constructor(
    device: GPUDevice,
    parent: HTMLElement,
    private world: LabWorld,
    params: URLSearchParams,
  ) {
    this.gpu = new NoiseLabGpu(device, world.w, world.h, world.zMax);
    const top = document.createElement('div');
    top.className = 'lab-top';
    this.canvas.width = world.w;
    this.canvas.height = world.h;
    this.canvas.className = 'lab-preview';
    this.canvas.title = 'the recipe from above (x right, rows down; the camera looks from the bottom right)';
    this.line.className = 'tune-note';
    // (round 112) the preview folds away (a phone's panel keeps room for the stack); the stack under it
    const fold = document.createElement('button');
    fold.className = 'lab-fold';
    const phone = matchMedia('(pointer: coarse)').matches;
    const showPreview = (on: boolean) => {
      this.canvas.hidden = !on;
      fold.textContent = on ? 'map ▾' : 'map ▸';
    };
    showPreview(!phone);
    fold.addEventListener('click', () => showPreview(this.canvas.hidden === true));
    const head = document.createElement('div');
    head.className = 'lab-head';
    const title = document.createElement('span');
    title.textContent = 'layers (top runs first) — tap a row for its parameters';
    head.append(fold, title);
    top.append(head, this.canvas, this.line, this.stack.el);
    // the recipe: a copied one, a built-in by name, or the one the lab opens with
    const s = params.get('lab');
    const named = params.get('labpreset');
    if (s) {
      const unknown = LAB_TUNING.apply(LAB_TUNING.decode(s));
      if (unknown.length) console.warn(`[noiselab] ?lab= has parameters this build doesn't know: ${unknown.join(', ')}`);
    } else {
      const p = PRESETS[named ?? START_PRESET];
      if (!p) throw new Error(`?labpreset=${named}: no such recipe (${Object.keys(PRESETS).join(' | ')})`);
      LAB_TUNING.apply(p);
    }
    this.panel = new TunePanel(parent, {
      registry: LAB_TUNING,
      store: STORE,
      urlParam: 'lab',
      label: 'noise',
      cls: 'lab',
      builtins: PRESETS,
      top,
      open: ['L1'],
      shown: !phone,
      // (round 112) the selected layer's parameters alone
      visible: (d) => (d.group === 'lab' || d.group === `L${this.stack.selected + 1}`) && labVisible(d.group, d.key),
    });
    this.stack.onView = () => {
      this.panel.refresh();
      this.panel.openGroup(`L${this.stack.selected + 1}`);
      this.request(true);
    };
    this.panel.onRelease = () => this.worldNow();
    if (!s) this.panel.showBuiltin(named ?? START_PRESET);
    this.stack.render();
    this.panel.refresh();
    this.panel.openGroup(`L${this.stack.selected + 1}`);
    this.off = LAB_TUNING.onChange((id) => {
      this.stack.render();
      // (a slider moving: the preview now, the world when it's let go or settles; anything else: both)
      const slider = !!id && this.panel.dragging;
      this.request(!slider || labValues().lab.live === 1);
    });
    this.request(true);
  }

  /** the recipe's registry (scripts: noiselab.registry.set('L1.amp', 30)) */
  readonly registry = LAB_TUNING;
  readonly presets = Object.keys(PRESETS);

  /** a built-in recipe (its runs follow, the world's write too) */
  load(name: string): void {
    const p = PRESETS[name];
    if (!p) throw new Error(`noise lab: no recipe "${name}" (${this.presets.join(' | ')})`);
    this.stack.solo = this.stack.upTo = -1;
    this.stack.selected = 0;
    LAB_TUNING.apply(p);
    this.panel.showBuiltin(name);
    this.panel.refresh();
    this.panel.openGroup('L1');
  }

  /** run the recipe; `world`: rewrite the world from it too */
  request(world: boolean): void {
    if (this.dead) return;
    this.worldDue ||= world;
    clearTimeout(this.idleTimer);
    // (a drag that stops without a release — a phone's — still reaches the world)
    if (!this.worldDue) this.idleTimer = window.setTimeout(() => this.worldNow(), 600);
    this.settled = this.gpu.run(this.stack.effective(labValues())).then(
      (r) => this.got(r),
      (e) => {
        if (!this.dead) throw e;
      },
    );
  }

  private worldNow(): void {
    this.worldDue = true;
    if (this.last) this.request(true);
  }

  private got(r: LabResult): void {
    if (this.dead) return;
    this.last = r;
    const s = this.stats;
    s.runs++;
    s.passes = r.passes;
    s.gpuMs = r.ms;
    const ctx = this.canvas.getContext('2d');
    this.stack.drawThumbs(r);
    if (ctx) {
      drawPreview(r, ctx);
      // (a soloed mask or carve: the preview is its output, the world its effect)
      const so = this.stack.solo;
      if (so >= 0 && labValues()[`L${so + 1}`].target !== TARGET.h) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.stack.thumbOf(so), 0, 0, this.canvas.width, this.canvas.height);
      }
    }
    Object.assign(s, recordStats(r));
    if (this.worldDue) {
      this.worldDue = false;
      const t0 = performance.now();
      const cols = labColumns(r, this.world.layout);
      s.packMs = performance.now() - t0;
      s.maxRuns = cols.maxRuns;
      s.gapCols = cols.gapCols;
      s.cutCols = cols.cutCols;
      s.joinedCols = cols.joinedCols;
      s.writeMs = this.world.write(cols, labValues().lab.sea);
      s.writes++;
    }
    this.line.textContent = `heights ${s.min.toFixed(0)}–${s.max.toFixed(0)} · gaps ${s.caves} cols${s.joinedCols ? ` (${s.joinedCols} joined)` : ''} · run ${s.gpuMs.toFixed(1)} ms (${s.passes} passes) · columns ${s.packMs.toFixed(1)} ms · world ${s.writeMs.toFixed(1)} ms`;
  }

  dispose(): void {
    this.dead = true;
    clearTimeout(this.idleTimer);
    this.off();
    this.panel.dispose();
    this.gpu.dispose();
  }
}
