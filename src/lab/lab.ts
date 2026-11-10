// (switchover, 2026-11-10) The town lab: the default town game — the atlas level at the start town, the GPU town
// (citygen/towns.ts), its living town (citylife/towns.ts) and the season loop (season/loop.ts) — driven by a script
// (scripts/lab.mjs; docs/TOOLING.md). ?lab=1 on the atlas level installs it once the start town is made. What a
// scenario drives, in the page as `reclaimed.lab`:
//   run(seconds, speed, {renderEvery})  the sim advanced `seconds` of sim time as fast as the GPU goes: the display's
//                                       frames wait, the lab steps the scene itself, drawing every Nth frame
//   look(x, y, zoom) / shot(name)       the camera (window world units); a screenshot (the runner saves it)
//   project(x, y, z) / viewport()       a window point on the screen (CSS px); the screen's size
//   towns / living / season / town      the game's own objects: the field towns, the living towns, the season loop, and
//                                       the start town's id
//   riders(id)                          (debug read) a living town's riders' rows and where its grid is in the window
// (Was the behaviour lab of round 128l: the fortress on recipes of small land, deleted with fortress mode. Its runner,
// scripts/lab.mjs, now opens this page.)
import type { LevelScene } from '../scenes/level';
import type { FieldTowns } from '../citygen/towns';
import type { LivingTowns } from '../citylife/towns';
import type { SeasonLoop } from '../season/loop';
import { TICK_DT } from '../sim/flow';
import { Renderer } from '../render/renderer';
import { ROW_H } from '../world/lattice';

const DT = 1 / 60;

export class TownLab {
  /** the lab steps the scene (lab.run): the display's frames wait */
  driving = false;
  /** the start town is made (and its season dealt, its people given, when those are on) */
  ready = false;
  private simT = 0;

  constructor(private scene: LevelScene) {}

  private get towns(): FieldTowns {
    const t = this.scene.fieldTowns;
    if (!t) throw new Error('town lab: no field towns');
    return t;
  }

  /** the start town's id (?town=) */
  get town(): string {
    const id = this.scene.opts.atlas?.startTown;
    if (!id) throw new Error('town lab: no start town (?town=1)');
    return id;
  }

  private get season(): SeasonLoop | null {
    return (globalThis as { season?: SeasonLoop }).season ?? null;
  }

  /** whether the start town is ready to drive: made, its people given (living), its first hand dealt (season) */
  private isReady(): boolean {
    const t = this.towns.live.get(this.town);
    if (!t?.times) return false;
    if (this.scene.livingTowns && !this.scene.livingTowns.live.has(this.town)) return false;
    const s = this.season;
    return !s || (s.town !== null && s.hand.length > 0);
  }

  /** watched every frame until ready */
  poll(): void {
    if (this.ready) return;
    if (this.isReady()) {
      this.ready = true;
      console.log(`[lab] ready: ${this.town}`);
    } else requestAnimationFrame(() => this.poll());
  }

  /**
   * The sim advanced `seconds` of the world's ticks at `speed`, frames as fast as the GPU goes, drawing every
   * `renderEvery`th. Time stops after (speed 0) unless `keep`. The towns' clock runs with the frames' dt (FieldTowns
   * update): a season's stages are best set at once (season.skip()).
   */
  async run(seconds: number, speed = 16, o: { renderEvery?: number; keep?: boolean; dt?: number } = {}): Promise<{ simSeconds: number; frames: number; wallMs: number; xRealtime: number }> {
    if (this.driving) throw new Error('lab.run: already running');
    if (!(speed > 0 && speed <= 64)) throw new Error('lab.run: speed must be in (0, 64]');
    const every = Math.max(1, Math.round(o.renderEvery ?? 8));
    const dt = o.dt ?? DT;
    if (!(dt > 0 && dt <= 0.1)) throw new Error('lab.run: dt must be in (0, 0.1] (main.ts caps a frame at 0.1 s)');
    const { core } = this.scene;
    const device = this.scene.host.gpu.device;
    const skipped = Renderer.skip.has('render');
    const t0 = performance.now();
    const tick0 = core.ticksRun;
    let sim = 0;
    let frames = 0;
    let idle = 0;
    this.driving = true;
    const before = this.scene.speed;
    this.scene.speed = speed;
    try {
      while (sim < seconds - 1e-6) {
        if (!skipped) {
          if (frames % every === 0) Renderer.skip.delete('render');
          else Renderer.skip.add('render');
        }
        const t = core.ticksRun;
        this.scene.frame(performance.now(), dt, true);
        sim = (core.ticksRun - tick0) * TICK_DT;
        frames++;
        idle = core.ticksRun === t ? idle + 1 : 0;
        if (idle > 600) throw new Error('lab.run: the world ran no tick in 600 frames (held: the streamer busy, or the planner)');
        await device.queue.onSubmittedWorkDone();
        if (document.querySelector('.fatal')) throw new Error('lab.run: the fatal overlay came up');
      }
    } finally {
      if (!skipped) Renderer.skip.delete('render');
      this.scene.speed = o.keep ? before : 0;
      this.driving = false;
    }
    this.simT += sim;
    const wallMs = performance.now() - t0;
    return { simSeconds: +sim.toFixed(2), frames, wallMs: Math.round(wallMs), xRealtime: +(sim / (wallMs / 1000)).toFixed(1) };
  }

  /** the camera on window point (x, y), at `zoom`; `aimY` the share of the screen's height from the top the point sits
   *  at (default 0.32: above the season's card sheet, as the season loop frames its districts) */
  look(x: number, y: number, zoom?: number, aimY = 0.32): void {
    const cam = this.scene.core.camera;
    if (zoom) cam.zoom = zoom;
    const z = this.scene.heightAt(x, y);
    const dy = ((0.5 - aimY) * innerHeight) / cam.zoom / Math.sin(cam.elevation);
    cam.target = [x, y + dy, z ?? cam.target[2]];
  }

  /** a screenshot (the runner's `__labShot`: scripts/lab.mjs saves it as <name>.png), after two drawn frames */
  async shot(name: string): Promise<string | null> {
    if (this.driving) throw new Error('lab.shot: not while running');
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frames();
    await this.scene.host.gpu.device.queue.onSubmittedWorkDone();
    const hook = (window as unknown as { __labShot?: (n: string) => Promise<string> }).__labShot;
    return hook ? hook(name) : null;
  }

  /**
   * (debug read: the follow gate's) A living town's riders' rows (citylife/routes.wgsl Rider, 16 words each: pos xyz,
   * heading, job | st << 8 | leg << 16, route, cursor, home, s, timer, load, phase, goal xy, aux, col) and where its
   * grid is in the window (window = grid + [dx, dy·ROW_H, dz]) and the window in the world (world = window + origin: a
   * slide moves the window, not the riders). Null: no living town there.
   */
  async riders(id: string): Promise<{ n: number; rows: Float32Array; words: Uint32Array; place: [number, number, number]; origin: [number, number] } | null> {
    const l = this.scene.livingTowns?.live.get(id);
    if (!l) return null;
    const n = l.life.riders;
    const buf = await l.life.debugRead(l.life.rid, Math.max(16, n * 64));
    const p = l.town.gridPlace();
    const o = this.scene.stream?.origin ?? [0, 0];
    return { n, rows: new Float32Array(buf), words: new Uint32Array(buf), place: [p.dx, p.dy * ROW_H, p.dz], origin: [o[0], o[1] * ROW_H] };
  }

  readonly api = (() => {
    const lab = this;
    return {
      get ready() {
        return lab.ready;
      },
      get town() {
        return lab.town;
      },
      get towns() {
        return lab.towns;
      },
      get living(): LivingTowns | null {
        return lab.scene.livingTowns ?? null;
      },
      get season() {
        return lab.season;
      },
      /** sim seconds the lab has run since the page opened */
      get simT() {
        return lab.simT;
      },
      get dims() {
        return { w: lab.scene.core.dims.w, h: lab.scene.core.dims.h };
      },
      run: (seconds: number, speed?: number, o?: { renderEvery?: number; keep?: boolean; dt?: number }) => this.run(seconds, speed, o),
      look: (x: number, y: number, zoom?: number, aimY?: number) => this.look(x, y, zoom, aimY),
      shot: (name: string) => this.shot(name),
      project: (x: number, y: number, z: number) => this.scene.core.camera.project(x, y, z),
      viewport: () => [this.scene.core.camera.viewportW, this.scene.core.camera.viewportH],
      ground: (x: number, y: number) => this.scene.heightAt(x, y),
      riders: (id: string) => this.riders(id),
      /** (the page can't be put back: scripts/lab.mjs loads it again for each scenario) */
      resettable: false,
    };
  })();
}

/** ?lab=1 on the atlas level: the town lab on the scene, as `reclaimed.lab` (ready once the start town is) */
export function startTownLab(scene: LevelScene): TownLab {
  const lab = new TownLab(scene);
  scene.lab = lab;
  const R = (window as unknown as { reclaimed?: Record<string, unknown> }).reclaimed;
  if (!R) throw new Error("town lab: no window.reclaimed (the level's test API) yet");
  R.lab = lab.api;
  lab.poll();
  return lab;
}
