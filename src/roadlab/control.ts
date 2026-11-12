// (road lab, RD1) The road lab's driver: the grade ladder's records (roadlab/ladder.ts) uploaded once, each road laid
// on the GPU at its reveal start (roadgrade.wgsl roadLay: dirt) and, if it ends cobble, paved at its reveal end
// (roadPave) — the lab's stand-in for archgen's live grow-in. The structures are one static mesh (Renderer.addMesh);
// the labels are DOM, placed by the camera each frame. `globalThis.roadlab` for scripts: view(row, zoom), bench(n),
// log, stats.
//
// URL: ?row=N opens on grade row N (0 flat … 8 cliff) close up, else the whole ladder; ?zoom= its zoom; ?pitch= deg
// (default 60); ?roadnow=1 lays and paves everything at once.

import { buildLadder, GRADES, laneY, Z0, type Ladder } from './ladder';
import { boxMesh } from './ladder';
import { RoadGrader, type GradeStats } from './grader';
import { RoadSurface } from '../api/contracts/roadpath';
import { cellPos } from '../world/lattice';
import type { Camera } from '../render/camera';
import type { WorldGpu } from '../sim/world-gpu';

const EDITOR_OFF = 'roadlab-noeditor';

export interface RoadLabIo {
  camera: Camera;
  addMesh(verts: GPUBuffer, args: GPUBuffer): void;
  removeMesh(args: GPUBuffer): void;
  /** the columns changed in this world box: remesh them now, wake their sims */
  changed(x0: number, y0: number, x1: number, y1: number): void;
}

/** one grader run's numbers (the lab's log) */
export interface RoadRun {
  ids: number[];
  mode: 'lay' | 'pave';
  gpuMs: number | null;
  wallMs: number;
  stats: GradeStats;
}

export class RoadLabControl {
  readonly ladder: Ladder;
  readonly grader: RoadGrader;
  readonly log: RoadRun[] = [];
  private readonly verts: GPUBuffer;
  private readonly args: GPUBuffer;
  private readonly hud: HTMLDivElement;
  private readonly tags: { el: HTMLDivElement; x: number; y: number; z: number; row: boolean }[] = [];
  private readonly ui: HTMLElement;
  /** the view asked for, held over the level's first frames (it sets its own zoom on its first resize) */
  private want: { row: number | null; zoom?: number; frames: number };
  private readonly t0 = performance.now();
  private readonly laid = new Set<number>();
  private readonly paved = new Set<number>();
  private chain: Promise<unknown> = Promise.resolve();
  private raf = 0;
  private gone = false;
  /** the most intervals a road column holds, and the most K, over every lay */
  readonly stats = { maxIntervals: 0, maxK: 0, folded: 0, left: 0, roadCols: 0, layGpuMs: 0, layWallMs: 0 };

  constructor(
    device: GPUDevice,
    ui: HTMLElement,
    world: Pick<WorldGpu, 'globals' | 'chunks' | 'materials' | 'layers' | 'veg' | 'vegNext'>,
    private readonly dims: { w: number; h: number },
    private readonly io: RoadLabIo,
    params: URLSearchParams,
  ) {
    this.ui = ui;
    this.ladder = buildLadder();
    // (the sandbox's editor panel hidden: the lab has no tools, and the panel covers the ladder on a phone)
    if (!document.getElementById(EDITOR_OFF)) {
      const st = document.createElement('style');
      st.id = EDITOR_OFF;
      st.textContent = `.${EDITOR_OFF} .editor { display: none !important; }`;
      document.head.append(st);
    }
    ui.classList.add(EDITOR_OFF);
    this.grader = new RoadGrader(device, world, dims.w, dims.h);
    this.grader.upload(this.ladder.roads.map((r) => r.record));
    // the structures: one mesh, made once
    const mesh = boxMesh(this.ladder.boxes);
    this.verts = device.createBuffer({ label: 'roadlab-structures', size: Math.max(32, mesh.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.verts, 0, mesh);
    this.args = device.createBuffer({ label: 'roadlab-structures-args', size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.args, 0, new Uint32Array([mesh.length / 8, 1, 0, 0]));
    io.addMesh(this.verts, this.args);
    // the labels and the panel
    this.hud = document.createElement('div');
    this.hud.style.cssText = 'position:absolute;left:8px;top:8px;z-index:20;padding:4px 8px;background:rgba(0,0,0,0.55);color:#fff;font:12px/1.35 system-ui,sans-serif;border-radius:4px;pointer-events:none;white-space:pre';
    ui.appendChild(this.hud);
    for (const l of this.ladder.labels) {
      const el = document.createElement('div');
      const row = l.row >= 0;
      el.textContent = l.text;
      el.style.cssText = `position:absolute;left:0;top:0;z-index:19;pointer-events:none;white-space:nowrap;font:${row ? 'bold 12px' : '10px'}/1.2 system-ui,sans-serif;color:#fff;background:${row ? 'rgba(20,40,90,0.8)' : 'rgba(0,0,0,0.6)'};padding:1px 4px;border-radius:3px;transform:translate(-50%,-50%)`;
      ui.appendChild(el);
      this.tags.push({ el, x: l.x, y: l.y, z: l.z, row });
    }
    // the view
    const cam = io.camera;
    cam.elevation = ((Number(params.get('pitch') ?? 60) || 60) * Math.PI) / 180;
    // (looking west: the plain's east half and the east step face the eye, west up the screen, rows left to right)
    cam.azimuth = 0;
    const row = params.get('row');
    const zoom = params.get('zoom');
    this.want = { row: row === null ? null : Number(row), zoom: zoom === null ? undefined : Number(zoom), frames: 30 };
    this.view(this.want.row, this.want.zoom);
    if (params.get('roadnow') === '1') {
      const all = this.ladder.roads.map((_, i) => i);
      all.forEach((i) => this.laid.add(i));
      this.queue(all, 'lay');
      const cob = all.filter((i) => this.ladder.roads[i].record.surface === RoadSurface.Cobble);
      cob.forEach((i) => this.paved.add(i));
      this.queue(cob, 'pave');
    }
    const tick = () => {
      if (this.gone) return;
      this.frame();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** the camera on grade row `row` (null: the whole ladder) */
  view(row: number | null, zoom?: number): void {
    const cam = this.io.camera;
    if (row === null) {
      const [ww, wh] = cellPos(this.dims.w, this.dims.h);
      cam.target = [ww / 2, wh / 2, Z0 + 2];
      // (the ladder's rows across the screen, its 256 of x up it at the pitch's foreshortening)
      cam.zoom = zoom ?? Math.min(innerWidth / (wh * 1.02), innerHeight / (ww * Math.sin(cam.elevation) + 30));
      return;
    }
    if (!(row >= 0 && row < GRADES.length)) throw new Error(`road lab: no grade row ${row} (0..${GRADES.length - 1})`);
    cam.target = [128, (laneY(2 * row) + laneY(2 * row + 1)) / 2, Z0 + 3];
    cam.zoom = zoom ?? 6;
  }

  /** every road laid again `n` times (the lay is idempotent: the second finds the ground at the profile) — GPU ms a run */
  async bench(n = 10): Promise<{ runs: number; gpuMs: number[]; meanGpuMs: number | null; perRoadGpuMs: number | null }> {
    const ids = this.ladder.roads.map((_, i) => i);
    const ms: number[] = [];
    for (let k = 0; k < n; k++) {
      const r = (await this.queue(ids, 'lay', true)) as RoadRun;
      if (r.gpuMs !== null) ms.push(r.gpuMs);
    }
    const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
    return { runs: n, gpuMs: ms, meanGpuMs: mean, perRoadGpuMs: mean === null ? null : mean / ids.length };
  }

  private queue(ids: number[], mode: 'lay' | 'pave', bench = false): Promise<unknown> {
    if (!ids.length) return this.chain;
    this.chain = this.chain.then(async () => {
      if (this.gone) return null;
      const r = await this.grader.run(ids, mode);
      const run: RoadRun = { ids, mode, ...r };
      this.log.push(run);
      if (mode === 'lay' && !bench) {
        const s = this.stats;
        s.maxIntervals = Math.max(s.maxIntervals, r.stats.maxIntervals);
        s.maxK = Math.max(s.maxK, r.stats.maxK);
        s.folded += r.stats.folded;
        s.left += r.stats.left;
        s.roadCols += r.stats.roadCols;
        s.layGpuMs += r.gpuMs ?? 0;
        s.layWallMs += r.wallMs;
      }
      for (const i of ids) {
        const [x0, y0, x1, y1] = this.grader.box(i);
        const [wx0, wy0] = cellPos(x0, y0);
        const [wx1, wy1] = cellPos(x1, y1);
        this.io.changed(wx0 - 1, wy0 - 1, wx1 + 1, wy1 + 1);
      }
      return run;
    });
    return this.chain;
  }

  private frame(): void {
    if (this.want.frames > 0) {
      this.want.frames--;
      this.view(this.want.row, this.want.zoom);
    }
    const t = (performance.now() - this.t0) / 1000;
    const lay: number[] = [];
    const pave: number[] = [];
    this.ladder.roads.forEach((r, i) => {
      if (!this.laid.has(i) && t >= r.record.revealStart) {
        this.laid.add(i);
        lay.push(i);
      }
      if (r.record.surface === RoadSurface.Cobble && this.laid.has(i) && !this.paved.has(i) && t >= r.record.revealEnd) {
        this.paved.add(i);
        pave.push(i);
      }
    });
    this.queue(lay, 'lay');
    this.queue(pave, 'pave');
    const cam = this.io.camera;
    for (const g of this.tags) {
      const [sx, sy] = cam.project(g.x, g.y, g.z);
      // (a variant's label only close enough to read it; a row's always)
      const on = (g.row || cam.zoom >= 3.5) && sx > -60 && sy > -20 && sx < innerWidth + 60 && sy < innerHeight + 20;
      g.el.style.display = on ? '' : 'none';
      if (on) g.el.style.left = `${sx}px`;
      if (on) g.el.style.top = `${sy}px`;
    }
    const s = this.stats;
    const n = this.ladder.roads.length;
    this.hud.textContent =
      `road lab · ${this.laid.size}/${n} laid · ${this.paved.size} paved\n` +
      `cut+fill GPU ${s.layGpuMs.toFixed(3)} ms (all lays) · road cols ${s.roadCols}\n` +
      `intervals ≤ ${s.maxIntervals} of K ${s.maxK} · folded ${s.folded} · left ${s.left}`;
  }

  dispose(): void {
    this.gone = true;
    cancelAnimationFrame(this.raf);
    this.io.removeMesh(this.args);
    this.hud.remove();
    this.ui.classList.remove(EDITOR_OFF);
    for (const g of this.tags) g.el.remove();
    void this.chain.then(() => {
      this.grader.dispose();
      this.verts.destroy();
      this.args.destroy();
    });
  }
}
